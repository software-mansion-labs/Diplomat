"""Bridge to the ``diplomat-core`` Swift CLI — the single source of truth for prompt
assembly.

The Review/Issues/Conflicts/Audit prompts are built by ``DiplomatCore`` (the same code
the macOS app uses). The Linux applet shells out to the compiled ``diplomat-core``
binary instead of re-implementing that logic in Python, so the two front-ends can
never drift. Build the binary with ``packages/diplomat-platform/linux/install/build-core.sh``.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from collections.abc import Callable
from pathlib import Path

from . import core


class CoreBinaryMissing(RuntimeError):
    """Raised when the diplomat-core binary can't be located."""


def core_bin() -> str:
    """Locate the diplomat-core binary: ``$DIPLOMAT_CORE_BIN``, then ``PATH``, then the
    XDG install location (``~/.local/share/diplomat/diplomat-core``)."""
    override = os.environ.get("DIPLOMAT_CORE_BIN")
    if override and os.path.exists(override):
        return override
    found = shutil.which("diplomat-core")
    if found:
        return found
    data = Path(os.environ.get("XDG_DATA_HOME") or (Path.home() / ".local" / "share"))
    candidate = data / "diplomat" / "diplomat-core"
    if candidate.exists():
        return str(candidate)
    raise CoreBinaryMissing(
        "diplomat-core not found — run packages/diplomat-platform/linux/install/build-core.sh "
        "(or set DIPLOMAT_CORE_BIN)."
    )


def cli(args: list[str], *, stdin: object = None, timeout: float = 30,
        started: Callable[[subprocess.Popen], None] | None = None) -> str:
    """``diplomat-core <args>``'s stdout, with ``stdin`` handed over as JSON; or
    :class:`RuntimeError` saying why not (:class:`CoreBinaryMissing` when there is no
    binary). ``started`` is handed the process, which then leads a process group of
    its own, so the caller can stop it and whatever it runs."""
    env = dict(os.environ)
    env.setdefault("DIPLOMAT_CORE", str(core.assets_dir()))
    try:
        proc = subprocess.Popen(  # noqa: S603 — argv is a literal list
            [core_bin(), *args],
            stdin=subprocess.DEVNULL if stdin is None else subprocess.PIPE,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env,
            start_new_session=started is not None,
        )
    except OSError as exc:
        raise RuntimeError(f"diplomat-core could not be run: {exc}") from exc
    if started is not None:
        started(proc)
    try:
        out, err = proc.communicate(None if stdin is None else json.dumps(stdin),
                                    timeout=timeout)
    except subprocess.TimeoutExpired as exc:
        proc.kill()
        proc.wait()
        raise RuntimeError(f"diplomat-core {args[0]} did not answer within "
                           f"{int(timeout)}s") from exc
    if proc.returncode != 0:
        raise RuntimeError(f"diplomat-core {args[0]} failed: {err.strip()}")
    return out


def opencode_session_model() -> str:
    """The model an unpinned OpenCode 2.x spawn names in its session, or "" to leave
    the choice to the service (``AgentModel.openCodeSessionModel``). "" too when the
    core cannot answer: the run still starts, on the service's own pick."""
    try:
        proc = subprocess.run(  # noqa: S603 — argv is a literal list, not a shell string
            [core_bin(), "opencode-session-model"], stdin=subprocess.DEVNULL,
            capture_output=True, text=True, timeout=10, check=True)
    except (CoreBinaryMissing, OSError, subprocess.SubprocessError):
        return ""
    return proc.stdout.strip()


def build_prompt(config: dict) -> str:
    """Assemble a prompt by shelling out to diplomat-core. ``config`` is the JSON
    payload whose ``kind`` is ``review`` | ``conflicts`` | ``audit``."""
    binary = core_bin()
    env = dict(os.environ)
    env.setdefault("DIPLOMAT_CORE", str(core.assets_dir()))
    try:
        proc = subprocess.run(  # noqa: S603 — argv is a literal list, not a shell string
            [binary, "build-prompt"],
            input=json.dumps(config),
            capture_output=True,
            text=True,
            env=env,
            # Prompt assembly is local string work (milliseconds). A bound is mandatory:
            # this runs synchronously on the Qt UI thread (wizard "Spawn") and inside the
            # auto-fix poll worker while `_poll_lock` is held — an unbounded hang (a wedged
            # or misbuilt core binary) would freeze the UI forever or silently no-op
            # every future poll. Every other subprocess in the app is likewise timed.
            timeout=30,
        )
    except subprocess.TimeoutExpired as exc:
        # Surface as RuntimeError, which callers already catch (releasing the poll lock),
        # rather than letting TimeoutExpired escape a Qt slot / wedge the worker.
        raise RuntimeError("diplomat-core timed out assembling the prompt") from exc
    if proc.returncode != 0:
        raise RuntimeError(f"diplomat-core failed: {proc.stderr.strip()}")
    return proc.stdout
