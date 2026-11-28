"""The workers the applet starts, and the wait that lets them land.

They signal back into Qt when they finish, so one still running while the process
tears its widgets down raises there — and an unhandled exception on a thread is a
traceback written to a ``sys.stderr`` the finaliser may already be closing. The
interpreter cannot take the buffer lock the worker holds and the process aborts
(SIGABRT) rather than exits, which in a log reads as "the applet crashed".

The race itself has no deterministic form that a bounded wait could still win, so
what is pinned here is structural — every worker is born where something can wait
for it, and the wait joins — plus one run that puts a worker mid-``stderr``-write
at the moment the process ends and asserts a clean exit anyway.
"""

from __future__ import annotations

import ast
import contextlib
import os
import signal
import subprocess
import sys
import time
from pathlib import Path

import pytest

from diplomat_app.store import Store
from test_pipeline_store import _all_dead

_LINUX_DIR = Path(__file__).resolve().parents[1]
_APP_DIR = _LINUX_DIR / "diplomat_app"


# ---- every worker is born joinable ----------------------------------------


def _is_thread_ctor(func: ast.expr) -> bool:
    if isinstance(func, ast.Attribute):
        return func.attr == "Thread"
    return isinstance(func, ast.Name) and func.id == "Thread"


def _seam_span() -> tuple[int, int]:
    """The line range of ``Store.start_background`` — the one place allowed to
    construct a worker."""
    tree = ast.parse((_APP_DIR / "store.py").read_text(encoding="utf-8"))
    for node in ast.walk(tree):
        if isinstance(node, ast.FunctionDef) and node.name == "start_background":
            return node.lineno, node.end_lineno or node.lineno
    raise AssertionError("Store.start_background is gone")


def test_no_worker_is_started_where_nothing_can_wait_for_it():
    """A bare ``threading.Thread(...).start()`` hands back no handle, so the quit
    path cannot know it is there. This is the check that keeps the next one from
    being added: the applet constructs a worker in exactly one place, and that
    place records it."""
    born = [
        (path.name, node.lineno)
        for path in sorted(_APP_DIR.rglob("*.py"))
        for node in ast.walk(ast.parse(path.read_text(encoding="utf-8")))
        if isinstance(node, ast.Call) and _is_thread_ctor(node.func)
    ]
    low, high = _seam_span()
    stray = [
        f"{name}:{line}"
        for name, line in born
        if not (name == "store.py" and low <= line <= high)
    ]
    assert stray == []
    assert len(born) == 1


# ---- the wait ---------------------------------------------------------------


def test_the_wait_joins_the_work_it_started():
    store = Store()
    landed = []

    def work() -> None:
        time.sleep(0.05)
        landed.append(True)

    store.start_background(work)
    assert store.wait_for_background(5) == []
    assert landed == [True]


def test_a_worker_that_will_not_stop_is_named_rather_than_waited_on_forever():
    """The wait is bounded on purpose: a wedged worker must not be able to hold
    the applet open at quit. What it owes the caller instead is to say which one
    it is leaving behind."""
    store = Store()
    stop = []

    def wedged() -> None:
        while not stop:
            time.sleep(0.01)

    store.start_background(wedged, "wedged")
    began = time.monotonic()
    try:
        assert store.wait_for_background(0.2) == ["wedged"]
        assert time.monotonic() - began < 2
    finally:
        stop.append(True)


def test_the_workers_do_not_pile_up():
    """The store lives as long as the applet and polls every few seconds, so the
    list has to shed what has finished rather than grow all day."""
    store = Store()
    for _ in range(20):
        store.start_background(lambda: None)
        store.wait_for_background(5)
    assert len(store._workers) <= 2


def test_a_second_interrupt_during_the_wait_does_not_restart_it(monkeypatch):
    """Ctrl-C reaches ``quit`` through a signal handler, and CPython runs one on the
    main thread even while ``Thread.join`` has it blocked (measured: the handler fires
    0.5s into a 3s join), so a second press lands *inside* the wait. Re-entering would
    give that call a budget of its own, so pressing Ctrl-C again would slow the
    exit."""
    from diplomat_app.app import DiplomatApp, SingleInstance

    app = DiplomatApp.__new__(DiplomatApp)
    budgets = []

    class _Store:
        def stop_pipeline_sync(self):
            pass

        def wait_for_background(self, timeout=5.0):
            budgets.append(timeout)
            if len(budgets) == 1:
                app.quit()  # the second Ctrl-C, delivered mid-join
            return []

    app.store = _Store()
    app.tray = type("_Tray", (), {"hide": lambda self: None})()
    app.panel = type("_Panel", (), {"hide": lambda self: None})()
    app.app = type("_Qt", (), {"quit": lambda self: None})()
    monkeypatch.setattr(SingleInstance, "release", staticmethod(lambda: None))

    app.quit()

    assert budgets == [5.0]


def test_a_quit_stops_the_pipeline_sync_before_it_waits(monkeypatch):
    """The sync's core would otherwise outlive the app, and its wait the join's budget."""
    from diplomat_app.app import DiplomatApp, SingleInstance

    app = DiplomatApp.__new__(DiplomatApp)
    calls = []
    app.store = type("_Store", (), {
        "stop_pipeline_sync": lambda self: calls.append("stop"),
        "wait_for_background": lambda self, timeout=5.0: calls.append("wait") or []})()
    app.tray = type("_Tray", (), {"hide": lambda self: None})()
    app.panel = type("_Panel", (), {"hide": lambda self: None})()
    app.app = type("_Qt", (), {"quit": lambda self: calls.append("quit")})()
    monkeypatch.setattr(SingleInstance, "release", staticmethod(lambda: None))
    app.quit()
    assert calls == ["stop", "wait", "quit"]


_ENDED = '''\
import os
import signal
import sys

from PySide6.QtCore import QTimer
from PySide6.QtWidgets import QApplication

from diplomat_app import selfupdate
from diplomat_app.app import DiplomatApp, SingleInstance

signum = getattr(signal, sys.argv[1])
signal.signal(signum, signal.SIG_IGN if sys.argv[2] == "ignored" else signal.SIG_DFL)
app = DiplomatApp.__new__(DiplomatApp)
app.app = QApplication([])
app.store = type("_Store", (), {"stop_pipeline_sync": lambda self: print("stop", flush=True)})()
selfupdate.mark_operator_quit = lambda: print("marked", flush=True)
SingleInstance.release = staticmethod(lambda: print("released", flush=True))
QTimer.singleShot(0, lambda: os.kill(os.getpid(), signum))
QTimer.singleShot(1000, app.app.quit)
app.exec()
print("ran on", flush=True)
'''


@pytest.mark.parametrize("name, disposition, code, said", [
    ("SIGTERM", "default", -signal.SIGTERM, "stop\n"),
    ("SIGHUP", "default", -signal.SIGHUP, "stop\n"),
    ("SIGHUP", "ignored", 0, "ran on\n"),
])
def test_a_newer_instance_or_a_closed_terminal_stops_the_pipeline_sync(tmp_path, name,
                                                                      disposition, code, said):
    """A newer instance's SIGTERM, or a closed terminal's SIGHUP, would otherwise leave the
    sync's core running on in a session of its own. Neither is the operator's quit, and
    under ``nohup`` a SIGHUP stays ignored."""
    env = {**os.environ, "PYTHONPATH": str(_LINUX_DIR), "HOME": str(tmp_path),
           "QT_QPA_PLATFORM": "offscreen"}
    done = subprocess.run([sys.executable, "-c", _ENDED, name, disposition],
                          cwd=str(_LINUX_DIR), env=env, capture_output=True, text=True,
                          timeout=60)
    assert (done.returncode, done.stdout) == (code, said), done.stderr[-2000:]


_HELD = '''\
import signal
import subprocess
import sys

from PySide6.QtCore import QSettings, QTimer
from PySide6.QtWidgets import QApplication

from diplomat_app import selfupdate
from diplomat_app.app import DiplomatApp, SingleInstance
from diplomat_app.store import Store

QSettings.setDefaultFormat(QSettings.Format.IniFormat)
QSettings.setPath(QSettings.Format.IniFormat, QSettings.Scope.UserScope, sys.argv[3])
app = DiplomatApp.__new__(DiplomatApp)
app.app = QApplication([])
app.store = Store()
app.tray = app.panel = type("_Widget", (), {"hide": lambda self: None})()
selfupdate.mark_operator_quit = lambda: None
SingleInstance.release = staticmethod(lambda: None)
core = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"],
                        start_new_session=True, stdout=subprocess.DEVNULL,
                        stderr=subprocess.DEVNULL)
open(sys.argv[4], "w").write(str(core.pid))
app.store._pipeline_proc = core


def held():
    with getattr(app.store, sys.argv[2]):
        signal.raise_signal(getattr(signal, sys.argv[1]))


QTimer.singleShot(0, held)
app.exec()
print("ran on", flush=True)
'''


@pytest.mark.parametrize("name, lock, code, said", [
    ("SIGTERM", "_pipeline_lock", -signal.SIGTERM, ""),
    ("SIGTERM", "_rating_lock", -signal.SIGTERM, ""),
    ("SIGINT", "_pipeline_lock", 0, "ran on\n"),
    ("SIGINT", "_rating_lock", 0, "ran on\n"),
])
def test_a_signal_inside_a_block_holding_a_lock_its_handler_takes_still_stops_the_sync(
        tmp_path, name, lock, code, said):
    """A handler runs on the Qt thread between two of its bytecodes, which may be inside
    a block holding a lock the handler takes too."""
    env = {**os.environ, "PYTHONPATH": str(_LINUX_DIR), "HOME": str(tmp_path),
           "QT_QPA_PLATFORM": "offscreen"}
    pid_file = tmp_path / "core"
    try:
        done = subprocess.run([sys.executable, "-c", _HELD, name, lock, str(tmp_path),
                               str(pid_file)],
                              cwd=str(_LINUX_DIR), env=env, capture_output=True, text=True,
                              timeout=60)
        assert (done.returncode, done.stdout) == (code, said), done.stderr[-2000:]
        assert _all_dead(int(pid_file.read_text()))
    finally:
        with contextlib.suppress(OSError, ValueError):
            os.kill(int(pid_file.read_text()), signal.SIGKILL)


# ---- and the abort it exists to prevent ------------------------------------


_BURST = '''\
import sys
import threading

from diplomat_app.store import Store

store = Store()
writing = threading.Event()


def burst() -> None:
    writing.set()
    for _ in range(4000):
        sys.stderr.write("x" * 4096 + "\\n")


store.start_background(burst, "stderr-burst")
# Only now, with the process's own work finished, does the worker start writing:
# whatever comes next is racing the interpreter's teardown.
writing.wait()
store.wait_for_background(60)
'''


def test_a_worker_mid_stderr_write_does_not_abort_the_process(tmp_path):
    """The failure in the wild, made to happen on demand: a worker holding the
    ``stderr`` buffer lock exactly as the process ends. Without the wait the
    finaliser cannot take that lock and kills the process with SIGABRT (-6);
    with it the worker is done before teardown starts."""
    home = tmp_path / "home"
    home.mkdir()
    env = {
        **os.environ,
        "PYTHONPATH": str(_LINUX_DIR),
        "HOME": str(home),
        "XDG_CONFIG_HOME": str(home / ".config"),
        "QT_QPA_PLATFORM": "offscreen",
        "DIPLOMAT_SELF_REPO": "/nonexistent",
    }
    noise = tmp_path / "burst.txt"
    for attempt in range(8):
        with open(noise, "wb") as sink:
            done = subprocess.run(
                [sys.executable, "-c", _BURST],
                cwd=str(_LINUX_DIR), env=env, stdout=subprocess.PIPE,
                stderr=sink, timeout=180,
            )
        assert done.returncode == 0, (
            f"run {attempt} died ({done.returncode}):\n"
            + noise.read_text(encoding="utf-8", errors="replace")[-2000:]
        )


def test_a_render_leaves_no_worker_running(monkeypatch, tmp_path):
    """``DIPLOMAT_RENDER`` ends the process as soon as the PNG is written, so a worker
    still running then is the abort above (#187). A fixture render shells none of the
    host's checks, and waits out the workers it does start."""
    import threading

    from PySide6.QtWidgets import QApplication

    from diplomat_app import deviceallocator, probes, render, selfupdate
    from diplomat_runtime import appconfig

    QApplication.instance() or QApplication([])
    # The panel's fixture pins both for the rest of its process.
    monkeypatch.setattr(appconfig, "auto_task_limit", appconfig.auto_task_limit)
    monkeypatch.setattr(probes, "gather", probes.gather)
    hold = threading.Event()
    monkeypatch.setattr(selfupdate, "check", lambda: hold.wait() and {})
    monkeypatch.setattr(deviceallocator, "check", lambda: hold.wait() and None)
    count = Store.refresh_auto_task_count

    def slow_count(self) -> None:
        time.sleep(0.5)
        count(self)

    monkeypatch.setattr(Store, "refresh_auto_task_count", slow_count)
    started = []
    start = Store.start_background

    def record(self, work, name=None):
        started.append(start(self, work, name))
        return started[-1]

    monkeypatch.setattr(Store, "start_background", record)
    monkeypatch.setattr(render, "_agents_scratch_dir", None)
    try:
        assert render.run("panel", str(tmp_path / "panel.png")) == 0
        assert started
        assert [t.name for t in started if t.is_alive()] == []
    finally:
        hold.set()
