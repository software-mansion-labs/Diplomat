"""Bridge to the Diplomacy Network daemon + installer, for the gate every job passes
while the network is switched on, and for the Network screen.

The applet *drives* the Node installer (``diplomacy-network/src/install.js``) to start
and stop the daemon, *asks* the daemon's socket (``packages/diplomacy-network``'s
README, "Local socket"), and writes the settings the daemon re-reads from the shared
config. What to send and how to read the answers is :mod:`diplomat_runtime.network`.
"""

from __future__ import annotations

import json
import os
import shutil
import signal
import time
from collections.abc import Mapping
from pathlib import Path
from typing import Any

from diplomat_runtime import appconfig, network
from . import deviceallocator as da
from . import procscan


def package_dir() -> str:
    return da.sibling_package("diplomacy-network", "DIPLOMAT_DIPLOMACY_NETWORK_DIR")


def install_js() -> str:
    return os.path.join(package_dir(), "src", "install.js")


def package_available() -> bool:
    return os.path.exists(install_js())


def ready() -> bool:
    """Whether the installer can be run at all: the package and a node to run it."""
    return package_available() and da.resolve_node() is not None


def base_dir() -> Path:
    """The daemon's directory, relocated by ``DN_BASE_DIR`` as in ``src/paths.js``."""
    env = os.environ.get("DN_BASE_DIR")
    if env:
        return Path(env).expanduser()
    return Path.home() / ".diplomat" / "network"


def socket_path() -> Path:
    return base_dir() / "daemon.sock"


# MARK: settings

#: The config the switch was last read from, and what it said.
_switch_read: tuple[Path, bool] | None = None


def enabled() -> bool:
    """The switch, as the shared config has it. A config that is there and cannot be
    read says nothing of it - one read can fall in the middle of a rewrite - so the
    switch is as it was last read, and off when it never was."""
    global _switch_read
    where, config = appconfig.path(), appconfig.read_known()
    if config is None:
        return _switch_read is not None and _switch_read == (where, True)
    on = config.get(network.ENABLED_KEY) is True
    _switch_read = (where, on)
    return on


def set_enabled(on: bool) -> None:
    appconfig.set_bool(network.ENABLED_KEY, on)


def required_minimum_h() -> int:
    """The hours a task this machine offers asks an executor to hold it for."""
    return network.hours(appconfig.read().get(network.REQUIRED_MINIMUM_H_KEY))


def maximum_accepted_h() -> int:
    """The most hours a task may ask for and still be taken by this machine."""
    return network.hours(appconfig.read().get(network.MAXIMUM_ACCEPTED_H_KEY))


def set_hours(key: str, value: int) -> None:
    appconfig.set_int(key, network.hours(value))


def devices() -> bool:
    """Whether a job running on this machine may reach its adb server."""
    return appconfig.get_bool(network.DEVICES_KEY, False)


def set_devices(on: bool) -> None:
    appconfig.set_bool(network.DEVICES_KEY, on)


# MARK: installer

def start_daemon() -> dict | None:
    return da.run_installer(install_js(), "--start-daemon")


def restart_daemon() -> dict | None:
    return da.run_installer(install_js(), "--restart-daemon")


def stop_daemon() -> dict | None:
    return da.run_installer(install_js(), "--stop-daemon")


# MARK: the socket

#: Every route answers from memory; an offer also signs and stores a record.
SEND_TIMEOUT_SECS = 15
#: The snapshot is asked for on every agent tick, so a daemon that is slow to give it
#: is read as one that did not.
STATE_TIMEOUT_SECS = 3

_GETS = frozenset({network.ROUTE_HEALTH, network.ROUTE_STATE})

#: Why nothing can be said of a network run, as the sentences that take it start.
NOT_ANSWERING = "the Diplomacy Network daemon is not answering"
#: What a Stop says of a run the daemon no longer lists as going.
RUN_ENDED = "That job's run on this machine has already ended."
SWITCHED_OFF = "the Diplomacy Network is switched off"


def send(route: str, body: dict | None = None, *,
         timeout_secs: float = SEND_TIMEOUT_SECS) -> da.DaemonReply | str:
    """One request to the daemon (a ``network.ROUTE_*``): its reply, or
    ``da.UNREACHABLE`` / ``da.NO_REPLY``. Blocking, so off the GUI thread."""
    return da.exchange(route, body, timeout_secs=timeout_secs, sock=socket_path(),
                       method="GET" if route in _GETS else "POST")


def refusal(reply: da.DaemonReply | str) -> str | None:
    """Why a request did not go through, in words fit to show the operator; None when
    the daemon took it. A 4xx carries the daemon's own sentence."""
    if not isinstance(reply, da.DaemonReply):
        return NOT_ANSWERING
    if reply.ok:
        return None
    error = reply.get("error")
    return (error if isinstance(error, str) and error
            else f"the daemon answered HTTP {reply.status}")


def definite(reply: da.DaemonReply | str) -> bool:
    """Whether the daemon settled a request: it took it, or refused it (a 4xx). No
    reply, and a fault of the daemon's own (a 5xx), settle nothing: the daemon may or
    may not have acted."""
    return isinstance(reply, da.DaemonReply) and reply.status < 500


def state() -> network.Snapshot | None:
    """The daemon's snapshot, or None when it gave none."""
    reply = send(network.ROUTE_STATE, timeout_secs=STATE_TIMEOUT_SECS)
    if not isinstance(reply, da.DaemonReply) or not reply.ok:
        return None
    return network.Snapshot.parse(reply.raw)


# MARK: a job's offer

#: The dispatch verdict for a job the network did not take.
VERDICT_REFUSED = "network_refused"

#: The runner a completion is recorded under when another machine ran the task: not a
#: runner of this machine's, so its tokens count against no limit read here.
RUNNER_ELSEWHERE = "network"


class Offered(str):
    """The dispatch verdict of a started job (``"spawned"``) for one the network took,
    carrying the task it is offered as."""

    task: str

    def __new__(cls, task: str) -> "Offered":
        self = super().__new__(cls, "spawned")
        self.task = task
        return self


#: The dispatch verdict for a job of the operator's whose offer the daemon was sent and
#: gave no definite answer to: kept, and settled on a later cycle.
VERDICT_OFFERING = "network_offering"


class Refused(str):
    """:data:`VERDICT_REFUSED`, carrying the words that say why. ``own`` says the
    refusal is of this one job - the daemon's definite answer to its offer, or an offer
    that could not be made of it - where a daemon that did not answer, or is stopping,
    takes no job at all."""

    sentence: str
    own: bool

    def __new__(cls, sentence: str, own: bool = False) -> "Refused":
        self = super().__new__(cls, VERDICT_REFUSED)
        self.sentence = sentence
        self.own = own
        return self


def terms(payload: Mapping[str, Any]) -> dict[str, bool]:
    """What a prompt payload (a config's ``prompt_payload()``) allows its job, as the
    fields of :class:`autofix.AgentJob` an offer's options are read from. A review's
    two follow the prompt builder's own gates: no verdict on the operator's own PR, and
    nothing marked ready on someone else's."""
    kind = payload.get("kind")
    if kind == "review":
        whose = payload.get("specificAuthor")
        return {"own_pr": whose == "mine",
                "verdict": payload.get("finalPass") is True and whose != "mine",
                "mark_ready": payload.get("markReady") is True and whose != "theirs"}
    if kind in ("issues", "audit"):
        return {"opens_prs": payload.get("openPRs") is True}
    return {}


# MARK: the retired mesh node

def _is_legacy_node(tokens: list[str]) -> bool:
    """``python -m szpontnet``: the two as whole, adjacent arguments. A path or a
    longer module name holding the word is some other program."""
    return any(flag == "-m" and module == "szpontnet"
               for flag, module in zip(tokens, tokens[1:]))


#: How long that node is given to quit before its directory is left for the next launch.
LEGACY_EXIT_SECS = 5.0


def legacy_dir() -> Path:
    """Where the mesh node an earlier Diplomat ran kept its state and its keys."""
    return Path.home() / ".diplomat" / "mesh"


def _legacy_node_running(pid: int) -> bool:
    return bool(procscan.scan_own_pids(
        lambda found: found == pid and _is_legacy_node(procscan.cmdline_tokens(found))))


def _terminate(pid: int) -> None:
    os.kill(pid, signal.SIGTERM)


def retire_legacy_node() -> tuple[int | None, Path | None]:
    """End the mesh node an earlier Diplomat ran and remove its directory, keys
    included. That node is the pid the directory's ``state.json`` names, while that
    pid is a ``python -m szpontnet`` of this user: a node kept anywhere else is its
    operator's own program. One still running after ``LEGACY_EXIT_SECS`` keeps the
    directory. Returns the pid asked to quit and the directory removed, each None when
    there was none. Blocking."""
    where = legacy_dir()
    if not where.is_dir():
        return None, None
    try:
        pid = json.loads((where / "state.json").read_text()).get("pid")
    except (OSError, ValueError, AttributeError):
        pid = None
    asked = None
    if type(pid) is int and _legacy_node_running(pid):
        try:
            _terminate(pid)
            asked = pid
        except OSError:
            pass
        deadline = time.monotonic() + LEGACY_EXIT_SECS
        while _legacy_node_running(pid):
            if time.monotonic() >= deadline:
                return asked, None
            time.sleep(0.1)
    shutil.rmtree(where, ignore_errors=True)
    return asked, None if where.exists() else where


def legacy_retired_line(asked: int | None, removed: Path | None, where: Path) -> str | None:
    """What the feed says of :func:`retire_legacy_node`; None when it found nothing."""
    if removed is not None:
        node = f"Ended the retired mesh node (pid {asked}) and removed" if asked else "Removed"
        return f"{node} {removed}, the retired mesh's state and keys"
    if asked is not None:
        return (f"Asked the retired mesh node (pid {asked}) to quit: {where} is removed "
                "once it has")
    return None


# MARK: display

#: The switch, and what it does, wherever it is drawn.
SWITCH_TITLE = "Offer every job to the Diplomacy Network"
EXPLANATION = ("Every job is offered to a shared pool per repository and runs in a "
               "docker container, possibly on another machine in the pool.")


def short_key(pk: str) -> str:
    """A member's key as the screens and the run rows name it."""
    return pk[:8]


def unavailable_summary() -> str | None:
    """Why the daemon cannot be run from here at all, or None when it can."""
    if not package_available():
        return (f"⚠ Package not found at {package_dir()}. Set "
                "DIPLOMAT_DIPLOMACY_NETWORK_DIR to point at it.")
    if da.resolve_node() is None:
        return "⚠ Node.js not found. Install Node (or set DIPLOMAT_NODE): the daemon needs it."
    return None
