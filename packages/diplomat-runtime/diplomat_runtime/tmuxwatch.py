"""tmux terminal I/O for the Claude-API-error watcher — the Linux stand-in for the
iTerm/Terminal AppleScript in ApiErrorWatcher.swift.

macOS can read a terminal window's visible buffer and type into it through the
scriptable iTerm/Terminal apps. Linux has no such hook for arbitrary emulators
(gnome-terminal, konsole, …) — you can neither read what's rendered nor inject input.
tmux is the one portable mechanism that does both: ``capture-pane`` returns a pane's
visible screen, ``send-keys`` submits a line to it. So the watcher drives tmux panes;
an agent must be running inside tmux to be watched (the feature is simply inert
otherwise, exactly as the macOS watcher is when no terminal app it can read is
running).

macOS runs the same mechanism beside its two scripts rather than instead of them
(``TerminalFocus.paneScreens`` / ``sendLine``), because Ghostty is scriptable in every
way but this one: it will open a window on command and close one, but it reports
neither the text on a surface nor the tty it is on. So a Ghostty agent's screen has
exactly one reader, and it is this one.

Panes are keyed by their server and tmux ``pane_id`` (``%N``) — unique and never
recycled for the life of the server, unlike a ``/dev/pts`` tty which is reused as panes
close. Every session Diplomat opens is on a server of its own (:func:`_servers`), and
every server numbers its panes from ``%0``.
"""

from __future__ import annotations

import os
import shutil
import socket
import stat
import subprocess
import time
from dataclasses import dataclass

from .apiwatch import last_lines

# Listings are space-separated: no control byte survives tmux's output. 3.4 prints one
# as octal, and a client with no $TMUX and no UTF-8 locale (launchd, an autostart
# entry, CI) gets "_".


@dataclass(frozen=True)
class Pane:
    pane_id: str  # tmux "%N" — the stable key, with `server`
    tty: str  # "/dev/pts/N" — for the audit line only
    tail: str  # last SCANNED_TAIL_LINES non-empty visible rows
    server: str | None = None  # its server's `-L` label; None = the default server


def is_available() -> bool:
    """tmux is installed AND a server is running (there are panes to watch)."""
    if shutil.which("tmux") is None:
        return False
    return bool(_diplomat_servers()) or _server_running(None)


def _server_running(server: str | None) -> bool:
    try:
        r = subprocess.run(
            _argv(server, "has-session"),
            capture_output=True, timeout=5,
        )
    except (OSError, subprocess.SubprocessError):
        return False
    return r.returncode == 0


def _servers() -> list[str | None]:
    """Every server a pane may be on: the default one (None), which holds an agent the
    operator started in their own tmux and a session an older build opened, then the
    live server of each session Diplomat opened (:func:`review.terminal_argv`)."""
    return [None, *_diplomat_servers()]


#: A refused socket younger than this may be a server's that has bound it and not yet
#: listened on it; older, it is one a server left behind when it exited.
_STALE_SOCKET_SECS = 60


def _socket_dir() -> str:
    """Where tmux puts a ``-L`` server's socket, resolved the way tmux resolves it."""
    tmpdir = os.environ.get("TMUX_TMPDIR")
    try:
        base = os.path.realpath(tmpdir, strict=True) if tmpdir else None
    except OSError:
        base = None
    return os.path.join(base or os.path.realpath("/tmp"), f"tmux-{os.getuid()}")


def _diplomat_servers() -> list[str]:
    """The label of each live ``diplomat-`` server, by name so readings are stable."""
    sockets = _socket_dir()
    try:
        names = sorted(n for n in os.listdir(sockets) if n.startswith(SESSION_PREFIX))
    except OSError:
        return []
    return [n for n in names if _listening(os.path.join(sockets, n))]


def _listening(path: str) -> bool:
    """Whether a server answers on the socket at ``path``. Asked with a connect, not a
    tmux, since every server that exits leaves its socket behind; one nothing answers
    on is removed once older than :data:`_STALE_SOCKET_SECS`."""
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as probe:
            probe.settimeout(1)
            probe.connect(path)
        return True
    except ConnectionRefusedError:
        pass
    except OSError:
        return False
    try:
        st = os.lstat(path)
        if stat.S_ISSOCK(st.st_mode) and time.time() - st.st_mtime > _STALE_SOCKET_SECS:
            os.unlink(path)
    except OSError:
        pass
    return False


def _pane_rows(fmt: str) -> list[tuple[str | None, str, str]] | None:
    """``(server, first field, rest)`` for each pane ``list-panes -a -F fmt`` lists on
    each of :func:`_servers`. ``None`` when a server that is up would not list its panes;
    one that is not up has none."""
    rows: list[tuple[str | None, str, str]] = []
    for server in _servers():
        listing = _run(_argv(server, "list-panes", "-a", "-F", fmt))
        if listing is None:
            if _server_running(server):
                return None
            continue
        for line in listing.splitlines():
            if " " not in line:
                continue
            first, rest = (s.strip() for s in line.split(" ", 1))
            rows.append((server, first, rest))
    return rows


def dump_panes() -> list[Pane] | None:
    """Every tmux pane's last visible lines, keyed by server and pane_id.

    Returns ``None`` when tmux is present but a command FAILED unexpectedly — the
    caller treats that as "unknown" and skips the scan rather than clearing all
    backoff state (mirrors ApiErrorWatcher.dumpSessions returning nil). Returns an
    empty list — a *known* "no panes" — when tmux isn't installed or no server is
    running; those are ordinary inert states, not failures.
    """
    if shutil.which("tmux") is None:
        return []
    rows = _pane_rows("#{pane_id} #{pane_tty}")
    if rows is None:
        return None
    out: list[Pane] = []
    for server, pane_id, tty in rows:
        if not pane_id:
            continue
        captured = _run(_argv(server, "capture-pane", "-p", "-t", pane_id))
        if captured is None:  # pane vanished between list + capture — skip it
            continue
        out.append(Pane(pane_id=pane_id, tty=tty, tail=last_lines(captured),
                        server=server))
    return out


def pane_tails_for_ttys(ttys: set[str]) -> dict[str, str] | None:
    """The visible tail of each pane running on one of ``ttys``, keyed by that tty —
    the join column between a tmux pane and the ``claude`` process ``ps`` reports on
    that same tty, and unique across servers. ``None`` when tmux is not installed or a
    running server would not answer.

    Selective on purpose, unlike :func:`dump_panes`: this runs on the panel's
    8-second tick, and the callers want two panes out of however many the developer
    has open. One ``list-panes`` plus one ``capture-pane`` per *agent*, not per pane.

    Keys and lookups carry no ``/dev/`` prefix, because the two sources spell a tty
    differently: tmux gives ``/dev/pts/13``, ``ps`` gives ``pts/13``. Normalising here
    means the callers can pass and read a tty as ``ps`` spells it.

    The ``None`` matters, and used to be a ``{}`` shared with "no pane matched": those
    are "we could not look" and "we looked and this agent has no pane", and reading
    the first as the second is how an agent whose screen went unreadable was mistaken
    for one sitting idle at its prompt. :func:`probes.pane_tails` turns the
    distinction into an Observation and the resolver acts on it.

    ANY failure collapses to ``None``, not just the ones :func:`_run` knows to expect.
    The caller is a poll worker, which cannot afford an exception: it would silently
    die for the rest of the applet's life (the way the watcher itself once did - see
    :func:`_run`).
    """
    if shutil.which("tmux") is None:
        return None
    if not ttys:
        return {}
    try:
        rows = _pane_rows("#{pane_id} #{pane_tty}")
        if rows is None:
            return None
        out: dict[str, str] = {}
        for server, pane_id, tty in rows:
            tty = tty.removeprefix("/dev/")
            if not pane_id or tty not in ttys:
                continue
            captured = _run(_argv(server, "capture-pane", "-p", "-t", pane_id))
            if captured is not None:  # pane vanished between list + capture — skip it
                out[tty] = last_lines(captured)
        return out
    except Exception:  # noqa: BLE001 - see above; no tmux failure is worth either cost
        return None


def send_continue(pane: Pane, message: str) -> bool:
    """Type ``message`` into the pane and submit it (send the literal text, then
    Enter). Returns whether the pane accepted it — False when the pane no longer
    exists, so the caller doesn't count a nudge that never landed."""
    if _run(_argv(pane.server, "send-keys", "-t", pane.pane_id, "-l", message)) is None:
        return False
    return _run(_argv(pane.server, "send-keys", "-t", pane.pane_id, "Enter")) is not None


#: What every tmux session opened for a run is named for. Matched exactly on the way
#: out (see :func:`kill_session`), and distinctive enough that nothing an operator
#: would type by hand collides with it — the name is the whole permission to end a
#: session rather than detach from it. `TerminalFocus.sessionPrefix` is the macOS twin.
SESSION_PREFIX = "diplomat-"


def session_name(run_id: str) -> str:
    """The tmux session a run's window is opened as.

    Derived from the run id rather than recorded, so there is nothing to write at spawn
    and nothing to lose: the reaper computes the same name from the same record. The
    run id is ``<epoch>-<hex8>`` (:func:`agentregistry.new_run_id`), which carries none
    of the characters a tmux session name may not (``.`` and ``:``), nor the ``/`` its
    server's socket name may not.
    """
    return SESSION_PREFIX + run_id


def kill_session(name: str) -> bool:
    """Close the tmux session called ``name``. Returns whether it was killed.

    The route a run has to its own window when it has no tty — which is every run whose
    pid was never adopted, and the case the run deadline is the first backstop able to
    reach. :func:`kill_window_for_tty` refuses an empty tty outright, so before this
    such a run was retired from the book with its window left open and its agent still
    in it.

    ``=`` prefixes the target because tmux's default matching is exact, then PREFIX,
    then fnmatch: a bare name would let one run's reap end a session whose name merely
    starts the same. Run ids are fixed-width, so no two can collide that way today, and
    that is not a property to leave a destructive call resting on.

    Asked of the session's own server (:func:`review.terminal_argv`), then of the
    default one, where an older build opened it.
    """
    if not name or shutil.which("tmux") is None:
        return False
    return any(_run(_argv(server, "kill-session", "-t", f"={name}")) is not None
               for server in (name, None))


def kill_window_for_tty(tty: str) -> bool:
    """Close the tmux window whose pane runs on ``tty``. Returns whether it was
    killed.

    The fallback route to a run's window, for the runs :func:`kill_session` cannot
    name: one spawned before sessions were named, and an agent this applet did not
    spawn.

    The window is closed for a run a BACKSTOP ended (:func:`agentstate.reapable`), and
    for an automatic run its own runner reported done
    (:func:`agentstate.close_on_retire`), whose work is on GitHub or in a report rather
    than on its screen. The quiescence backstop is twenty minutes of a screen that has
    not moved, so nothing is being read and nothing is being typed. The run deadline is
    the operator's own instruction to give up on a task at four hours — and there the
    agent may well be working, which is the point: they asked for the bay back anyway. A
    run the operator started from the panel that ends the ordinary way keeps its window:
    that is a session they may still want to read or type into.

    The WINDOW, not the session. A session this applet opened holds that one window
    (:func:`review.terminal_argv`), and tmux ends a session with its last window, so
    nothing of those is left behind; an agent the operator ran by hand inside their own
    session loses that window, every pane in it, and nothing else of theirs. Panes are
    matched on the tty rather than the pane id because the tty is what a run records -
    the two sources spell it differently, so the comparison is normalised the way
    :func:`pane_tails_for_ttys` normalises it.
    """
    if not tty or shutil.which("tmux") is None:
        return False
    want = tty.removeprefix("/dev/")
    found = _window_on(want)
    if found is None:
        return False
    server, window = found
    return _run(_argv(server, "kill-window", "-t", window)) is not None


def _window_on(tty: str) -> tuple[str | None, str] | None:
    """The server and id of the window whose pane runs on ``tty`` (the ``ps`` spelling,
    no ``/dev/``), or None - for a tty no pane is on, and for no server at all."""
    for server, pane_tty, window in _pane_rows("#{pane_tty} #{window_id}") or []:
        if pane_tty.removeprefix("/dev/") == tty and window:
            return server, window
    return None


def _argv(server: str | None, *args: str) -> list[str]:
    """A tmux command on ``server`` (a ``-L`` label; None = the default server)."""
    return ["tmux", *(["-L", server] if server else []), *args]


def _run(argv: list[str]) -> str | None:
    """Run a tmux command; ``None`` on ANY failure (missing binary, non-zero exit,
    timeout), stdout otherwise — so a broken/absent tmux is distinguishable from a
    clean empty result.

    Decode leniently (``errors="replace"``): ``capture-pane -p`` emits pane content
    VERBATIM, so a single non-UTF-8 byte in a watched pane (a Latin-1 filename, a raw
    high byte from a binary dump, a tmux server started under a C locale) would make a
    strict decode raise ``UnicodeDecodeError`` — a ``ValueError``, NOT an ``OSError``/
    ``SubprocessError``, so it escaped the guard, propagated out of ``dump_panes`` and
    the ``run_apiwatch_poll_async`` worker (which has no ``except``), and silently
    killed the whole API-error watcher every poll for as long as that pane existed.
    Replacement decoding keeps the crash out AND still scans the pane — a stalled agent
    showing ``API Error`` (a static pane, most likely to carry a stray byte) is exactly
    the one we must still be able to nudge."""
    try:
        r = subprocess.run(argv, capture_output=True, text=True,
                           errors="replace", timeout=10)
    except (OSError, subprocess.SubprocessError):
        return None
    if r.returncode != 0:
        return None
    return r.stdout
