"""The Network screen in each state a render seeds (in pools, not asked yet, daemon not
answering, switched off), its actions as they reach the store and the daemon, and the
three other places the Diplomacy Network shows: the panel's header button and task rows,
the switch in Settings, and a wizard's start.
"""

from __future__ import annotations

import dataclasses
import gc
import re
import weakref

import pytest

from diplomat_runtime import activity, appconfig, network
from diplomat_runtime.prref import LocalRepo
from diplomat_app import deviceallocator as da
from diplomat_app import diplomacynetwork as dn
from test_autofix import fake_probes
from test_network_wiring import (  # noqa: F401 - fixtures
    ME,
    POOL,
    book_network_run,
    daemon,
    job,
    offer,
    snapshot,
)

pytest.importorskip("PySide6")

RICH, STARTING, DOWN, OFF = (
    "network-screen", "network-screen-starting", "network-screen-down", "network-screen-off")
FAILED = "network-screen-failed"
UNSAVED = "network-screen-unsaved"
DIPLOMAT, BENCH = "github.com/latekvo/diplomat", "github.com/latekvo/prompt-bench"


@pytest.fixture
def app():
    from PySide6.QtWidgets import QApplication

    return QApplication.instance() or QApplication([])


@pytest.fixture
def seeded(monkeypatch):
    """A store as a render seeds it for one of its modes. The fixture sets the switch,
    the hours and the daemon's answer on the module that reads them, which is put back
    afterwards."""
    from diplomat_app import render
    from diplomat_app.store import Store

    for name in ("enabled", "devices", "state", "required_minimum_h", "maximum_accepted_h"):
        monkeypatch.setattr(dn, name, getattr(dn, name))
    monkeypatch.setattr(dn, "ready", lambda: True)

    def seed(mode: str) -> Store:
        monkeypatch.setenv("DIPLOMAT_RENDER", mode)
        store = Store()
        render._network_screen_fixture(store, mode)
        return store

    return seed


@pytest.mark.parametrize("mode,line", [
    (RICH, ""), (STARTING, ""), (OFF, ""),
    (DOWN, "Diplomacy Network: the daemon is not answering"),
    (FAILED, "Diplomacy Network: transport failed (tor not found: no other machine is "
             "reached without it); docker missing (docker not found: every job runs in "
             "a container)"),
])
def test_each_render_seeds_what_the_panel_says_of_the_network(seeded, mode, line):
    store = seeded(mode)
    assert store.network_trouble == line


def test_the_screen_says_that_the_settings_cannot_be_read(screen):
    view = screen(RICH)
    assert view._unknown.isHidden()
    appconfig.path().write_text("{", encoding="utf-8")
    view.rebuild()
    assert not view._unknown.isHidden() and view._unknown.text() == (
        f"{appconfig.path()} cannot be read as settings: until it can be, this "
        "machine's pools stay as the daemon has them and nothing is offered")
    appconfig.path().unlink()
    view.rebuild()
    assert view._unknown.isHidden()

    off = screen(OFF)
    appconfig.path().write_text("{", encoding="utf-8")
    off.rebuild()
    assert off._unknown.isHidden(), "with the switch off there is nothing to hold"


def test_the_screen_says_that_the_daemon_runs_with_a_tests_settings(screen):
    view = screen(RICH)
    assert view._tested.isHidden(), "a daemon that belongs on the network lists none"
    view.store.network_state = dataclasses.replace(
        view.store.network_state, test_settings=("DN_LEASE_SECS=60", "DN_TRANSPORT=loop"))
    view.rebuild()
    assert not view._tested.isHidden() and view._tested.text() == (
        "The daemon runs with settings only a test gives it, and is not one for the "
        "network: DN_LEASE_SECS=60, DN_TRANSPORT=loop")
    assert screen(OFF)._tested.isHidden()


def test_the_unsaved_render_seeds_hours_that_say_so(screen):
    from diplomat_app import networkview as nv

    view = screen(UNSAVED)
    assert view.hours_note.text() == nv.hours_note(72, 48) != ""
    assert not view.hours_note.isHidden()


def test_hours_that_leave_this_machine_none_of_its_own_jobs_say_so(screen):
    from diplomat_app import networkview as nv

    view = screen(RICH)
    view.accepted_h.setValue(48)
    view.required_h.setValue(48)
    assert view.hours_note.isHidden() and nv.hours_note(48, 48) == ""
    view.required_h.setValue(72)
    assert not view.hours_note.isHidden()
    assert view.hours_note.text() == nv.hours_note(72, view.accepted_h.value()) == (
        "This machine takes none of its own jobs: one may take 72 h, and the longest "
        f"job it takes is {view.accepted_h.value()} h.")
    view.accepted_h.setValue(72)
    assert view.hours_note.isHidden()


@pytest.fixture
def screen(app, seeded):
    from diplomat_app import render
    from diplomat_app.networkview import NetworkView

    built = []

    def build(mode: str) -> NetworkView:
        view = NetworkView(seeded(mode))
        view.clock = lambda: render.MACHINES_NOW
        view.resize(1060, 1600)
        view.rebuild()
        view.show()
        app.processEvents()
        built.append(view)
        return view

    yield build
    for view in built:
        view.deleteLater()


def texts(widget) -> list[str]:
    """Every line the widget shows, top to bottom."""
    from PySide6.QtWidgets import QApplication, QLabel

    from diplomat_app.widgets import ElidedLabel

    def text(lb) -> str:
        return lb._full if isinstance(lb, ElidedLabel) else lb.text()

    QApplication.processEvents()  # a row added by a rebuild is shown on the next turn
    at = {lb: lb.mapTo(widget, lb.rect().topLeft())
          for lb in widget.findChildren(QLabel) if lb.isVisible() and text(lb)}
    # Labels of unlike heights centred on one row start a pixel or two apart.
    row, rows = None, {}
    for lb in sorted(at, key=lambda lb: at[lb].y()):
        if row is None or at[lb].y() - row > 3:
            row = at[lb].y()
        rows[lb] = row
    return [text(lb) for lb in sorted(at, key=lambda lb: (rows[lb], at[lb].x()))]


def _clock_of(ahead: float) -> str:
    from diplomat_app import render
    from diplomat_app.machinesview import _clock

    return _clock(render.MACHINES_NOW + ahead)


# MARK: - the four states

def test_in_pools_it_draws_each_pool_with_its_members_tasks_and_actions(screen):
    from diplomat_app import networkview as nv

    view = screen(RICH)
    assert [p._pool for p in view.panels] == [DIPLOMAT, BENCH]
    first, second = (texts(p) for p in view.panels)
    assert first[:3] == [DIPLOMAT, "3 members", "/src/diplomat · as @latekvo"]
    for line in ("Members", "4be07d21", "this machine", "takes up to 12 h",
                 "9f3c1a77", "takes up to 24 h", "seen 40 s ago",
                 "c41d90ab", "unreachable", "seen 5 h ago", "Tasks",
                 "Review-req · #412 (@marta)", "review", "running",
                 f"offered here · on 9f3c1a77 · lease to {_clock_of(6720)}",
                 "Conflicts · #398", "conflicts",
                 f"offered here · on this machine · lease to {_clock_of(5700)}",
                 "Review · #405", "review-own", "in the pool", "offered here",
                 "Issues · #377 · deep", "issues", "done", "on 9f3c1a77",
                 "Review-req · #390 (@olek)", "cancelled"):
        assert line in first, line
    assert first.count("this machine") == 1 and first.count("unreachable") == 1
    assert "never seen" not in first and "nobody has taken it" not in first
    assert second[:3] == [BENCH, "1 member", "/src/prompt-bench · as @latekvo"]
    assert nv.NO_TASKS in second and nv.NO_MEMBERS not in second
    for panel in view.panels:
        assert list(panel.actions) == ["Copy invite", "Join…", "Leave", "Leave pool", "Cancel"]
        assert [k for k, b in panel.actions.items() if b.isVisible()] == [
            "Copy invite", "Join…", "Leave"]
        assert not panel.join_row.isVisible()
    assert view.first_join is None

    assert view._counts.text() == "2 pools · 5 tasks"
    assert view._light.text() == "daemon running"
    assert view._daemon_pill.text() == "running"
    assert view._daemon_row.summary() == f"pid 4471 · started 3 h ago · {dn.socket_path()}"
    assert [chip.text() for chip in view._services.values()] == [
        "transport ready", "docker ready", "model ready", "devices ready"]
    assert view.devices.isChecked()
    assert {k: v.text() for k, v in view._facts.items()} == {
        "This machine": "4be07d21", "Onion address": "dipl7x2kq5examplev3hostq4m.onion",
        "Work from pools": "taking 2 more"}
    assert not view.start.isVisible() and view.restart.isVisible() and view.restart.isEnabled()
    assert view.switch.isChecked() and not view._off_card.isVisible()
    shown = texts(view)
    for line in ("Network", "DIPLOMACY NETWORK", "Daemon", "SETTINGS", "RECENT",
                 dn.SWITCH_TITLE, dn.EXPLANATION, nv.REQUIRED_TITLE, nv.REQUIRED_SUMMARY,
                 nv.ACCEPTED_TITLE, nv.ACCEPTED_SUMMARY, nv.DEVICES_TITLE,
                 nv.DEVICES_SUMMARY):
        assert line in shown, line


def test_a_task_nobody_holds_or_a_member_never_heard_from_says_so(screen):
    view = screen(RICH)
    pool = view.store.network_state.pools[0]
    stranger = network.Member(pk="aa11bb22cc33", reachable=True)
    loose = network.PoolTask(task_id="t9", kind="audit", item="audit", state="available")
    _with(view, pools=(dataclasses.replace(pool, members=(stranger,), tasks=(loose,)),))
    shown = texts(view.panels[0])
    assert "never seen" in shown and "nobody has taken it" in shown
    assert "audit" in shown, "a task with no title is named by its item"
    assert view.panels[0].stops == {}, "neither offered nor run here: not this machine's to stop"
    _with(view, pools=(dataclasses.replace(pool, members=(), tasks=()),))
    from diplomat_app import networkview as nv

    assert nv.NO_MEMBERS in texts(view.panels[0])
    assert "0 members" in texts(view.panels[0])


def test_before_the_daemon_is_asked_it_says_so_and_offers_nothing(screen):
    from diplomat_app import networkview as nv

    view = screen(STARTING)
    assert view.panels == [] and view.first_join is None
    assert view._light.text() == "checking" and view._daemon_pill.text() == "checking"
    assert view._daemon_row.summary() == nv.ASKING == "Asking the daemon…"
    assert not view.start.isVisible() and not view.restart.isVisible()
    assert not view._answered.isVisible() and view._counts.text() == ""


def test_a_daemon_that_does_not_answer_is_said_and_can_be_started(screen, monkeypatch):
    from diplomat_app import networkview as nv
    from diplomat_app.store import Store

    asked = []
    monkeypatch.setattr(Store, "start_network_daemon_async", lambda self: asked.append("start"))
    monkeypatch.setattr(Store, "restart_network_async", lambda self: asked.append("restart"))
    view = screen(DOWN)
    assert view.panels == [] and view.first_join is None
    assert view._light.text() == "daemon not answering"
    assert view._daemon_pill.text() == "not answering"
    assert view._daemon_row.summary() == nv.SILENT
    assert not view._answered.isVisible()
    assert view.start.isVisible() and view.start.isEnabled() and view.restart.isEnabled()
    assert (view.start.text(), view.restart.text()) == ("Start daemon", "Restart daemon")
    view.start.click()
    view.restart.click()
    assert asked == ["start", "restart"]
    assert view.restart.toolTip() == nv.RESTART_HELP == (
        "Stop the running daemon and start this checkout's. Jobs running in containers "
        "here keep running, and the daemon that starts takes them up.")


def test_switched_off_it_explains_and_offers_the_switch(screen):
    from diplomat_app import networkview as nv

    view = screen(OFF)
    shown = texts(view)
    assert shown.count(dn.SWITCH_TITLE) == 1 and dn.EXPLANATION in shown
    assert nv.OFF_NOTE in shown and "off" in shown
    assert view.panels == [] and view._light.text() == "off" and view._counts.text() == ""
    assert view.off_switch.isVisible() and not view.off_switch.isChecked()
    assert not view._on_host.isVisible()


def test_the_buttons_wait_for_node_and_for_a_start_under_way(screen, monkeypatch):
    ready = [False]
    monkeypatch.setattr(dn, "ready", lambda: ready[0])
    view = screen(DOWN)
    assert not view.start.isEnabled() and not view.restart.isEnabled()
    assert view._problem.isVisible()
    assert view._problem.text().startswith("⚠ Package not found at ")
    ready[0] = True
    view.rebuild()
    assert view.start.isEnabled() and view.restart.isEnabled()
    with view.store._network_lifecycle:
        view.rebuild()
        assert not view.start.isEnabled() and not view.restart.isEnabled()
    view.rebuild()
    assert view.start.isEnabled()
    monkeypatch.setattr(dn, "settings_unknown", lambda: "/c/config.json cannot be read")
    view.rebuild()
    assert not view.start.isEnabled() and not view.restart.isEnabled(), (
        "a daemon started on settings it cannot read switches itself off")


def test_the_problem_line_is_for_a_daemon_that_does_not_answer(screen):
    assert not screen(RICH)._problem.isVisible()
    assert not screen(STARTING)._problem.isVisible()


# MARK: - what the header says

def _with(view, **changes):
    view.store.network_state = dataclasses.replace(view.store.network_state, **changes)
    view.store.network_changed.emit()


@pytest.mark.parametrize("admit, line", [
    (network.AdmitState(1), "taking 1 more"),
    (network.AdmitState(0, reason="disk"), "taking nothing: disk"),
    (network.AdmitState(0, reason="budget"), "taking nothing: budget"),
    (network.AdmitState(0, reason="paused"), "taking nothing: paused"),
    (network.AdmitState(0), "taking nothing: full"),
])
def test_the_admit_line_says_how_many_or_why_none(screen, admit, line):
    view = screen(RICH)
    _with(view, admit=admit)
    assert view._facts["Work from pools"].text() == line


def test_a_service_that_is_not_ready_says_why_and_a_missing_fact_says_so(screen):
    view = screen(RICH)
    _with(view, transport=network.Service("bootstrapping", "tor is at 40%"),
          docker=network.Docker("missing", "", "docker is not installed"),
          model=network.Service("missing", ""), pk="", onion="")
    assert [chip.text() for chip in view._services.values()] == [
        "transport bootstrapping", "docker missing", "model missing", "devices ready"]
    shown = texts(view)
    assert "transport: tor is at 40%" in shown and "docker: docker is not installed" in shown
    assert not any(line.startswith("model:") for line in shown)
    _with(view, devices=network.Service("none", "no adb server answers on this machine"))
    assert view._services["devices"].text() == "devices none"
    assert "devices: no adb server answers on this machine" in texts(view)
    _with(view, devices=network.Service("off", ""))
    assert view._services["devices"].text() == "devices off"
    assert not any(line.startswith("devices:") for line in texts(view))
    assert view._facts["This machine"].text() == "no key yet"
    assert view._facts["Onion address"].text() == "not published yet"
    _with(view, transport=network.Service("ready", "circuit built"))
    assert not any(line.startswith("transport:") for line in texts(view))


def test_in_no_pool_it_says_how_one_comes_and_takes_an_invite(screen, monkeypatch):
    from diplomat_app import networkview as nv
    from diplomat_app.store import Store

    asked = []
    monkeypatch.setattr(Store, "network_join_async",
                        lambda self, invite, card: asked.append((invite, card)))
    view = screen(RICH)
    view.store.network_refusals = {"": "That invite has expired.", DIPLOMAT: "elsewhere"}
    _with(view, pools=())
    shown = texts(view)
    assert "POOLS" in shown and nv.NO_POOLS in shown
    assert "That invite has expired." in shown and "elsewhere" not in shown
    assert view._counts.text() == "0 pools · 0 tasks" and view.panels == []
    join = view.first_join
    assert join.field.placeholderText() == "Paste an invite" and join.button.text() == "Join"
    assert not join.button.isEnabled(), "an empty field joins nothing"
    join.field.setText("  dn1-abc  ")
    join.button.click()
    assert asked == [("dn1-abc", "")]
    assert not join.button.isEnabled(), "one join at a time"


def test_what_the_daemon_reports_is_drawn_as_plain_text(screen):
    from PySide6.QtCore import Qt
    from PySide6.QtWidgets import QLabel

    from diplomat_app.widgets import ElidedLabel

    view = screen(RICH)
    tag = "<b>x</b>"
    pool = view.store.network_state.pools[0]
    task = network.PoolTask(task_id="t", title=f"t{tag}", kind=f"k{tag}", state=f"s{tag}")
    hostile = network.Pool(id=f"p{tag}", identity=f"i{tag}", path=f"/{tag}",
                           members=pool.members, tasks=(task,))
    view.store.network_refusals = {hostile.id: f"r{tag}"}
    _with(view, pools=(hostile,), onion=f"o{tag}",
          transport=network.Service("failed", f"d{tag}"))
    labels = [lb for lb in view.findChildren(QLabel) if tag in lb.text()]
    assert len(labels) == 7
    assert all(lb.textFormat() == Qt.TextFormat.PlainText for lb in labels)
    painted = sorted(lb._full for lb in view.findChildren(ElidedLabel) if tag in lb._full)
    assert painted == [f"p{tag}", f"t{tag}"], "a painter draws these two, and reads no HTML"


def test_the_recent_card_lists_the_feeds_last_six_network_lines(screen):
    from diplomat_app import networkview as nv
    from diplomat_app.widgets import ActivityRow

    view = screen(RICH)
    assert "Made an invite to github.com/latekvo/diplomat" in texts(view)
    view.store.audit_entries = [
        activity.AuditEntry("2026-11-09T12:00:00Z", "auto", "review", "Review · #1"),
        *(activity.AuditEntry(f"2026-11-09T11:5{n}:00Z", "auto", "network-offer",
                              f"Review · #{n} - offered to {POOL}") for n in range(8))]
    view.store.activity_changed.emit()
    shown = texts(view)
    assert [f"Review · #{n} - offered to {POOL}" in shown for n in range(8)] == (
        [True] * 6 + [False] * 2)
    assert "Review · #1" not in shown
    assert len([r for r in view.findChildren(ActivityRow) if r.isVisible()]) == 6
    view.store.audit_entries = view.store.audit_entries[:1]
    view.store.activity_changed.emit()
    assert nv.NO_EVENTS in texts(view)


# MARK: - the actions

def test_a_join_being_sent_is_not_sent_again(screen, monkeypatch):
    from diplomat_app.store import Store

    asked = []
    monkeypatch.setattr(Store, "network_join_async", lambda self, *args: asked.append(args))
    view = screen(RICH)
    panel = view.panels[1]
    panel.actions["Join…"].click()
    join = panel.join_row
    join.field.setText("dn1-abc")
    join.field.returnPressed.emit()
    join.field.returnPressed.emit()
    assert asked == [("dn1-abc", BENCH)]
    assert not join.button.isEnabled()


def test_the_pool_actions_reach_the_store_with_their_pool(screen, monkeypatch):
    from diplomat_app import networkview as nv
    from diplomat_app.store import Store

    asked = []
    for name in ("network_invite_async", "network_leave_async", "network_join_async"):
        monkeypatch.setattr(Store, name, lambda self, *args, name=name: asked.append((name, *args)))
    view = screen(RICH)
    panel = view.panels[1]
    panel.actions["Copy invite"].click()
    panel.actions["Leave"].click()
    assert asked == [("network_invite_async", BENCH)]
    assert panel.actions["Leave pool"].isVisible(), "leaving is asked about first"
    assert (panel.actions["Leave pool"].text(), panel.actions["Cancel"].text()) == (
        "Leave", "Cancel")
    assert not panel.actions["Copy invite"].isVisible()
    assert nv.leave_question(BENCH) in texts(panel)
    assert nv.leave_question(BENCH) == (
        f"Leave {BENCH}? This machine stops taking its jobs and offering jobs to it.")
    panel.actions["Cancel"].click()
    assert not panel.actions["Leave pool"].isVisible() and len(asked) == 1
    panel.actions["Leave"].click()
    panel.actions["Leave pool"].click()
    assert asked[-1] == ("network_leave_async", BENCH)

    panel.actions["Join…"].click()
    join = panel.join_row
    assert join.isVisible() and not join.button.isEnabled()
    join.field.setText("  dn1-abc  ")
    join.button.click()
    assert asked[-1] == ("network_join_async", "dn1-abc", BENCH)
    assert not view.panels[0].join_row.isVisible(), "each panel opens its own"
    panel.actions["Join…"].click()
    assert not join.isVisible()


def test_stop_is_offered_for_this_machines_open_tasks_and_says_what_it_does(
        screen, monkeypatch):
    from diplomat_app import networkview as nv
    from diplomat_app.store import Store

    asked = []
    monkeypatch.setattr(Store, "stop_network_task_async",
                        lambda self, task, pool: asked.append((task.task_id, pool)))
    view = screen(RICH)
    stops = view.panels[0].stops
    assert {task: b.toolTip() for task, b in stops.items()} == {
        "t412": nv.WITHDRAW_HELP, "t398": nv.STOP_RUN_HELP, "t405": nv.WITHDRAW_HELP}
    assert nv.STOP_RUN_HELP == "Stop this job's run on this machine. It goes back to the pool."
    assert nv.WITHDRAW_HELP == "Withdraw this job from the pool."
    assert {task: b.text() for task, b in stops.items()} == {
        "t412": "Withdraw", "t398": "Stop", "t405": "Withdraw"}
    stops["t398"].click()
    stops["t405"].click()
    assert asked == [("t398", DIPLOMAT), ("t405", DIPLOMAT)]

    # Run here for another machine's offer: this machine's to stop all the same.
    pool = view.store.network_state.pools[0]
    theirs = dataclasses.replace(pool.tasks[1], task_id="t7", offered_here=False)
    _with(view, pools=(dataclasses.replace(pool, tasks=(theirs,)),))
    assert {t: (b.text(), b.toolTip()) for t, b in view.panels[0].stops.items()} == {
        "t7": ("Stop", nv.STOP_RUN_HELP)}


def _offer(task: str, state: str, reason: str = "") -> network.OfferState:
    return network.OfferState(task_id=task, state=state, reason=reason)


def test_an_offer_that_failed_or_was_withdrawn_says_why_under_its_task(screen):
    from diplomat_app import networkview as nv

    view = screen(RICH)
    spent, gone = "the container exited 137 on its third attempt", "merged"
    _with(view, offers=(_offer("t390", "failed", spent), _offer("t405", "cancelled", gone),
                        _offer("t412", "claimed", "second attempt"),
                        _offer("t398", "cancelled")))
    shown = texts(view.panels[0])
    after = {line: shown[shown.index(line) + 1:][:4] for line in (
        "Review-req · #390 (@olek)", "Review · #405")}
    assert f"refused by the network: {spent}" in after["Review-req · #390 (@olek)"]
    assert f"withdrawn from the network: {gone}" in after["Review · #405"]
    assert sum("the network" in line for line in shown) == 2, (
        "nothing under an offer still open, one with no reason or another machine's task")
    state = view.store.network_state
    assert nv.ending("t390", state) == f"refused by the network: {spent}"
    assert nv.ending("t412", state) is None and nv.ending("t398", state) is None
    assert nv.ending("t377", state) is None and nv.ending("t390", None) is None


def test_what_holds_this_machine_back_is_said_on_the_pools_card_and_the_jobs_row(screen):
    from diplomat_app import networkview as nv

    fetch = ("this machine could not start a job of this pool: its repository could not "
             "be fetched")
    card = f"This machine takes none of this pool's jobs: {fetch}"
    view = screen(RICH)
    first, second = (texts(p) for p in view.panels)
    assert second.index(card) == second.index("Members") - 1 and card not in first
    assert not [line for line in first + second if "not taking this job" in line], (
        "the plain render's own job is one this machine would take")

    short = "this machine takes jobs of at most 48 h and this one needs 72"
    row = f"This machine is not taking this job: {short}"
    view = screen(UNSAVED)
    first = texts(view.panels[0])
    assert first.count(row) == 1
    assert row in first[first.index("Review · #405") + 1:first.index("Issues · #377 · deep")]

    pool = view.store.network_state.pools[0]
    _with(view, pools=(dataclasses.replace(pool, not_taking=short),))
    first = texts(view.panels[0])
    assert f"This machine takes none of this pool's jobs: {short}" in first
    assert row not in first, "the card says it for every job of the pool"
    state = view.store.network_state
    assert nv.task_held("t405", pool, state) == row and nv.task_held("t398", pool, state) == ""
    assert nv.pool_held(pool) == "" and nv.task_held("t405", pool, None) == ""


def test_a_join_under_way_and_an_invite_that_came_to_nothing_are_said_on_the_pools_card(
        screen):
    from PySide6.QtWidgets import QLabel

    from diplomat_app import networkview as nv

    joining = "Joining: the machine that made the invite seats this one once it is reached"
    ran_out = ("The last invite came to nothing: the invite ran out before the machine that "
               "made it answered")
    first, second = (texts(p) for p in screen(RICH).panels)
    assert second.index(joining) == second.index("Members") - 2, "above what holds it back"
    assert joining not in first
    assert not [line for line in first + second if "came to nothing" in line]

    first, second = (texts(p) for p in screen(UNSAVED).panels)
    assert second.index(ran_out) == second.index("Members") - 2 and ran_out not in first
    assert not [line for line in first + second if line.startswith("Joining:")]

    view = screen(RICH)
    pool = view.store.network_state.pools[0]
    assert nv.pool_joining(pool) == "" and nv.pool_join_failed(pool) == ""
    _with(view, pools=(dataclasses.replace(pool, joining=True, join_failed="no-seat"),))
    refused = "The last invite came to nothing: no-seat"
    shown = texts(view.panels[0])
    assert shown[shown.index("Members") - 2:shown.index("Members")] == [joining, refused]
    tints = {lb.text(): lb.styleSheet() for lb in view.panels[0].findChildren(QLabel)}
    assert nv._ORANGE in tints[refused] and nv._ORANGE not in tints[joining], (
        "a quiet line while it waits, a warning once it failed")


def test_a_return_under_way_and_a_seat_refused_are_said_on_the_pools_card(screen):
    from PySide6.QtWidgets import QLabel

    from diplomat_app import networkview as nv

    returning = "Returning: waiting for a machine this one left to let it back in"
    unseated = ("No seat here: every machine this one asked refused it, and it needs an "
                "invite again")
    view = screen(RICH)
    pool = view.store.network_state.pools[0]
    assert nv.pool_returning(pool) == "" and nv.pool_unseated(pool) == ""
    assert not [line for p in view.panels for line in texts(p)
                if line in (returning, unseated)]

    _with(view, pools=(dataclasses.replace(pool, returning=True),))
    shown = texts(view.panels[0])
    assert shown[shown.index("Members") - 1] == returning and unseated not in shown

    _with(view, pools=(dataclasses.replace(pool, returning=True, unseated=True),))
    shown = texts(view.panels[0])
    assert shown[shown.index("Members") - 1] == unseated, "refused, it waits for nothing"
    assert returning not in shown
    tints = {lb.text(): lb.styleSheet() for lb in view.panels[0].findChildren(QLabel)}
    assert nv._ORANGE in tints[unseated]

    _with(view, pools=(dataclasses.replace(pool, unseated=True),))
    assert texts(view.panels[0])[texts(view.panels[0]).index("Members") - 1] == unseated

    _with(view, pools=(dataclasses.replace(pool, left=True, returning=True, unseated=True),))
    assert not [line for line in texts(view.panels[0]) if line in (returning, unseated)], (
        "a pool this machine left says only that")


def test_a_title_or_pool_id_from_elsewhere_is_drawn_as_it_is_and_takes_no_width(screen):
    from diplomat_app.widgets import ElidedLabel

    view = screen(RICH)
    room = view.minimumSizeHint().width()
    pool = view.store.network_state.pools[0]
    title = "<b>bold</b> <a href='https://example.com'>link</a> " + "x" * 4000
    name = "github.com/" + "y" * 4000 + "/<i>repo</i>"
    hostile = dataclasses.replace(pool.tasks[0], title=title)
    _with(view, pools=(dataclasses.replace(pool, id=name, tasks=(hostile,)),))
    shown = texts(view.panels[0])
    assert shown[0] == name and title in shown
    drawn = {lb._full: lb for lb in view.panels[0].findChildren(ElidedLabel)}
    assert drawn[title].text() == "" and drawn[name].text() == "", "painted, never parsed"
    for label, full in ((drawn[title], title), (drawn[name], name)):
        ends = label.elided().split("…")
        assert len(ends) == 2 and all(ends), "cut in the middle"
        assert full.startswith(ends[0]) and full.endswith(ends[1]) and len(ends[0]) < 200
    assert view.minimumSizeHint().width() == room, "however long, it asks for no width"


def _left(pool: network.Pool) -> network.Pool:
    """``pool`` as the snapshot lists it once this machine has left it."""
    return dataclasses.replace(pool, left=True)


def test_a_pool_this_machine_left_says_so_and_offers_only_the_way_back(screen, monkeypatch):
    from diplomat_app import networkview as nv
    from diplomat_app.store import Store

    asked = []
    monkeypatch.setattr(Store, "network_rejoin_async", lambda self, pool: asked.append(pool))
    view = screen(RICH)
    first, second = view.store.network_state.pools
    view.store.network_refusals = {DIPLOMAT: "This repository is not linked."}
    _with(view, pools=(_left(first), second))
    gone, kept = view.panels
    assert list(gone.actions) == ["Rejoin"] and gone.stops == {} and gone.join_row is None
    assert texts(gone) == [DIPLOMAT, "left", "/src/diplomat · as @latekvo", nv.LEFT_NOTE,
                           "This repository is not linked."]
    assert nv.LEFT_NOTE == "left - this machine takes and offers nothing here"
    assert list(kept.actions)[:3] == ["Copy invite", "Join…", "Leave"]
    assert view._counts.text() == "1 pool · 0 tasks", "the pools this machine is in"
    assert view.first_join is None
    gone.actions["Rejoin"].click()
    assert asked == [DIPLOMAT]

    # Out of every pool, an invite still has somewhere to be pasted.
    _with(view, pools=(_left(first), _left(second)))
    shown = texts(view)
    assert view.first_join is not None and "POOLS" in shown and nv.NO_POOLS not in shown
    assert view._counts.text() == "0 pools · 0 tasks"


def test_pools_held_back_say_why_above_whatever_the_daemon_still_lists(screen):
    from diplomat_app import networkview as nv

    view = screen(RICH)
    assert "POOLS" not in texts(view)
    held = "Pools are held back: /mnt/work/tool cannot be read"
    view.store.network_pools_held = held
    view.store.network_changed.emit()
    shown = texts(view)
    assert shown.index("POOLS") < shown.index(DIPLOMAT) and held in shown
    assert view.first_join is None and len(view.panels) == 2, "each panel has its own join"

    _with(view, pools=())
    shown = texts(view)
    assert held in shown and nv.NO_POOLS not in shown, "the reason, not the first-run note"
    assert view.first_join is not None

    view.store.network_pools_held = ""
    view.store.network_changed.emit()
    assert held not in texts(view) and nv.NO_POOLS in texts(view)


def test_an_invite_lands_on_the_clipboard_and_a_refusal_shows_in_its_panel(
        app, screen, daemon, monkeypatch):
    from PySide6.QtGui import QGuiApplication

    from diplomat_app import networkview as nv

    monkeypatch.setattr(dn, "enabled", lambda: True)
    view = screen(RICH)
    store = view.store
    monkeypatch.setattr(store, "_network_cycle", lambda: None)  # keep the seeded pools
    d = daemon({"/invite": (200, {"invite": "dn1-secret"}), "/join": (200, {"pool": POOL}),
                "/leave": (409, {"error": "The last member cannot leave."})})

    def settle():
        assert store.wait_for_background() == []
        app.processEvents()
        app.processEvents()  # a panel a redraw built is shown on the turn after

    QGuiApplication.clipboard().setText("")
    view.panels[0].actions["Copy invite"].click()
    settle()
    assert QGuiApplication.clipboard().text() == "dn1-secret"
    assert nv.INVITE_COPIED in texts(view.panels[0])
    assert nv.INVITE_COPIED not in texts(view.panels[1])
    QGuiApplication.clipboard().setText("something else")
    store.network_changed.emit()
    assert QGuiApplication.clipboard().text() == "something else", "copied once"
    assert nv.INVITE_COPIED in texts(view.panels[0]), "and still said after a redraw"

    view.panels[0].actions["Join…"].click()
    view.panels[0].join_row.field.setText("dn1-other")
    view.panels[0].join_row.button.click()
    settle()
    assert not view.panels[0].join_row.isVisible() and view.panels[0].join_row.field.text() == ""

    view.panels[0].actions["Leave"].click()
    view.panels[0].actions["Leave pool"].click()
    settle()
    assert "The last member cannot leave." in texts(view.panels[0])
    assert "The last member cannot leave." not in texts(view.panels[1])
    assert (d.sent("invite"), d.sent("join"), d.sent("leave")) == (
        [{"pool": DIPLOMAT}], [{"invite": "dn1-other"}], [{"pool": DIPLOMAT}])


def test_an_invite_the_daemon_refuses_stays_in_its_field(app, screen, daemon, monkeypatch):
    monkeypatch.setattr(dn, "enabled", lambda: True)
    view = screen(RICH)
    store = view.store
    monkeypatch.setattr(store, "_network_cycle", lambda: None)
    daemon({"/join": (400, {"error": "That invite has expired."})})
    view.panels[1].actions["Join…"].click()
    view.panels[1].join_row.field.setText("dn1-old")
    view.panels[1].join_row.button.click()
    assert store.wait_for_background() == []
    app.processEvents()
    app.processEvents()  # a panel a redraw built is shown on the turn after
    join = view.panels[1].join_row
    assert join.isVisible() and join.field.text() == "dn1-old" and join.button.isEnabled()
    assert "That invite has expired." in texts(view.panels[1])


def test_the_hours_open_on_twelve_and_write_the_two_config_keys(screen):
    view = screen(RICH)
    for box in (view.required_h, view.accepted_h):
        assert (box.value(), box.minimum(), box.maximum(), box.singleStep(), box.suffix()) == (
            12, 12, 720, 12, " h")
    view.required_h.setValue(36)
    view.accepted_h.setValue(5)
    assert view.accepted_h.value() == 12, "twelve is the floor"
    assert appconfig.read() == {network.REQUIRED_MINIMUM_H_KEY: 36}
    view.accepted_h.setValue(24)
    assert appconfig.read()[network.MAXIMUM_ACCEPTED_H_KEY] == 24
    assert (dn.required_minimum_h(), dn.maximum_accepted_h()) == (36, 24)
    dn.set_hours(network.MAXIMUM_ACCEPTED_H_KEY, 5)
    assert appconfig.read()[network.MAXIMUM_ACCEPTED_H_KEY] == 12
    dn.set_hours(network.MAXIMUM_ACCEPTED_H_KEY, 9999)
    assert appconfig.read()[network.MAXIMUM_ACCEPTED_H_KEY] == 720, "and 720 the ceiling"
    # A value set from elsewhere shows on the next rebuild, and is not written back.
    appconfig.set_int(network.MAXIMUM_ACCEPTED_H_KEY, 48)
    view.rebuild()
    assert view.accepted_h.value() == 48
    assert appconfig.read()[network.MAXIMUM_ACCEPTED_H_KEY] == 48


def test_the_tint_of_a_service_chip_follows_its_state():
    from diplomat_app import networkview as nv

    assert [nv.service_tint(s) for s in ("ready", "failed", "missing", "down")] == [
        nv._GREEN, nv._RED, nv._RED, nv._RED]
    assert [nv.service_tint(s) for s in ("", "off")] == [nv._GREY, nv._GREY], (
        "a setting left off is no trouble")
    assert [nv.service_tint(s) for s in ("none", "bootstrapping")] == [nv._ORANGE, nv._ORANGE]


def test_the_devices_switch_is_off_until_set_and_writes_its_config_key(
        screen, monkeypatch, tmp_path):
    from diplomat_app import networkview as nv

    assert nv.DEVICES_TITLE == "Let jobs use this machine's devices"
    assert nv.DEVICES_SUMMARY == (
        "Off: jobs see no device. On: a job running here can use the Android devices and "
        "emulators attached to this machine through adb - including a phone on USB - and "
        "an emulator can reach services on this machine. It is one switch for every pool "
        "this machine is in: switch it on only when you trust all their machines with "
        "that. Either way it applies to jobs started afterwards.")
    saved = dn.devices
    view = screen(STARTING)
    monkeypatch.setattr(dn, "devices", saved)  # the render's fixture answers for it
    assert not dn.devices() and not view.devices.isChecked()
    assert appconfig.read() == {}, "showing the setting writes nothing"
    view.devices.setChecked(True)
    assert appconfig.read() == {network.DEVICES_KEY: True} and dn.devices()
    # A value set from elsewhere shows on the next rebuild, and is not written back.
    appconfig.set_bool(network.DEVICES_KEY, False)
    view.rebuild()
    assert not view.devices.isChecked()
    assert appconfig.read()[network.DEVICES_KEY] is False

    def refuse(key, value):
        raise OSError(28, "No space left on device")

    monkeypatch.setattr(appconfig, "set_bool", refuse)
    view.devices.setChecked(True)
    assert view._save_error.isVisible() and "No space left on device" in view._save_error.text()
    assert not view.devices.isChecked(), "the switch shows what is in force"


def test_the_screens_switch_flips_the_setting_through_the_store(screen, monkeypatch):
    from diplomat_app.store import Store

    flipped = []
    monkeypatch.setattr(Store, "set_network_enabled", lambda self, on: flipped.append(on))
    view = screen(OFF)
    view.off_switch.setChecked(True)
    assert flipped == [True]

    def refuse(self, on):
        raise OSError(28, "No space left on device")

    monkeypatch.setattr(Store, "set_network_enabled", refuse)
    view.off_switch.setChecked(False)
    view.off_switch.setChecked(True)
    assert view._save_error.isVisible() and "No space left on device" in view._save_error.text()
    assert not view.off_switch.isChecked(), "the switch shows what is in force"

    on = screen(RICH)
    monkeypatch.setattr(Store, "set_network_enabled", lambda self, on: flipped.append(on))
    on.switch.setChecked(False)
    assert flipped == [True, False]


def test_the_screens_switches_follow_a_change_made_elsewhere(app, seeded, monkeypatch):
    from diplomat_app.networkview import NetworkView
    from diplomat_app.store import Store

    flipped = []
    monkeypatch.setattr(Store, "set_network_enabled", lambda self, on: flipped.append(on))
    view = NetworkView(seeded(OFF), live=False)
    monkeypatch.setattr(dn, "enabled", lambda: True)
    view.store.network_changed.emit()
    for switch in (view.switch, view.off_switch):
        assert switch.isChecked() and switch.travel == 1.0, "knob and all"
    assert flipped == [], "following the setting writes nothing"
    view.deleteLater()


def test_while_open_it_asks_the_daemon_every_two_seconds_and_a_render_never(
        app, seeded, monkeypatch):
    from diplomat_app.networkview import NetworkView
    from diplomat_app.store import Store

    cycles = []
    monkeypatch.setattr(Store, "run_network_cycle_async", lambda self: cycles.append(1))
    view = NetworkView(seeded(RICH), live=True)
    view.opened()
    assert view._timer.isActive() and view._timer.interval() == 2_000 and len(cycles) == 1
    view._timer.timeout.emit()
    assert len(cycles) == 2
    view.closed()
    assert not view._timer.isActive()

    still = NetworkView(seeded(RICH))
    still.opened()
    assert not still.live and not still._timer.isActive() and len(cycles) == 2
    view.deleteLater()
    still.deleteLater()


def test_a_dropped_network_screen_is_freed_without_the_cycle_collector(app, seeded):
    """PySide 6.12 segfaults collecting a live screen caught in a reference cycle."""
    from diplomat_app.networkview import NetworkView

    store = seeded(RICH)
    first, second = store.network_state.pools
    store.network_state = dataclasses.replace(store.network_state,
                                              pools=(first, _left(second)))
    view = NetworkView(store, live=False)
    view.rebuild()
    view.panels[0].actions["Join…"].click()
    view.panels[0].actions["Leave"].click()
    gone = weakref.ref(view)
    gc.disable()
    try:
        del view
        assert gone() is None
    finally:
        gc.enable()


# MARK: - the panel

@pytest.fixture
def panel(app, monkeypatch):
    from diplomat_app.panel import Panel
    from diplomat_app.store import Store

    monkeypatch.setattr(Store, "refresh_allocator_install_async", lambda self: None)
    monkeypatch.setattr(Store, "refresh_update_status_async", lambda self: None)
    monkeypatch.setattr(Store, "refresh_machines_install_async", lambda self: None)
    fake_probes(monkeypatch)
    p = Panel(Store())
    yield p
    assert p.store.wait_for_background() == []
    p.deleteLater()


def test_the_header_button_opens_the_screen_and_asks_the_daemon_while_it_is_open(
        panel, monkeypatch):
    from diplomat_app.store import Store

    cycles = []
    monkeypatch.setattr(Store, "run_network_cycle_async", lambda self: cycles.append(self))
    view = panel.network_view
    assert view.live and panel.network_btn.toolTip() == "Network"
    panel.network_btn.click()
    assert panel.body.currentIndex() == panel._screens["network"]
    assert view._timer.isActive() and len(cycles) == 1
    panel.network_btn.click()
    assert panel.body.currentIndex() == panel._screens["main"]
    assert not view._timer.isActive()
    panel.network_btn.click()
    view.done.emit()
    assert panel.body.currentIndex() == panel._screens["main"]


def test_a_network_run_is_a_row_that_opens_the_screen_and_can_only_be_forgotten(
        app, panel, monkeypatch):
    from PySide6.QtCore import QPoint, Qt
    from PySide6.QtTest import QTest
    from PySide6.QtWidgets import QPushButton

    from diplomat_app.store import Store
    from diplomat_app.widgets import NetworkTaskRow, RunningTaskRow

    appconfig.set_bool(network.ENABLED_KEY, True)
    asked = []
    monkeypatch.setattr(Store, "forget_network_run_async",
                        lambda self, run_id: asked.append(("forget", run_id)))
    run = book_network_run(age=600)
    panel.store.network_state = network.Snapshot.from_json(
        snapshot(offers=[offer(state="claimed", executor=ME)]))
    panel._rebuild_agent_tasks()

    layout = panel.tasks_col
    drawn = [layout.itemAt(i).widget() for i in range(layout.count())]
    (row,) = [w for w in drawn if isinstance(w, NetworkTaskRow)]
    assert not any(isinstance(w, RunningTaskRow) for w in drawn)
    assert row.status.text() == "⬡ running on this machine · offered 10m ago"
    assert row.toolTip() == "Open the Network screen."
    assert [b.text() for b in row.findChildren(QPushButton)] == ["forget"]
    assert row.forget.toolTip() == (
        "Withdraw this job from the pool and remove it from the list.")

    row.forget.click()
    assert asked == [("forget", run.run_id)]
    assert panel.body.currentIndex() == panel._screens["main"]
    panel.show()
    app.processEvents()
    QTest.mouseClick(row, Qt.MouseButton.LeftButton, pos=QPoint(60, 8))
    assert panel.body.currentIndex() == panel._screens["network"]
    panel.hide()


# MARK: - Settings and the wizard

def test_an_offer_the_daemon_has_not_settled_is_a_row_that_says_so(app, panel):
    from types import SimpleNamespace

    from PySide6.QtWidgets import QLabel

    from diplomat_app.store import NetworkOffering
    from diplomat_app.widgets import SectionHeader, StartingTaskRow

    appconfig.set_bool(network.ENABLED_KEY, True)
    panel.store.network_offering = [NetworkOffering(
        job(), "panel", "Review · #9",
        SimpleNamespace(pool=POOL, kind="review", item="pr-9"))]
    panel._rebuild_agent_tasks()
    layout = panel.tasks_col
    drawn = [layout.itemAt(i).widget() for i in range(layout.count())]
    (row,) = [w for w in drawn if isinstance(w, StartingTaskRow)]
    assert row.status.text() == "Offering to the pool…"
    assert row.toolTip() == (
        "The daemon has not answered this job's offer. Diplomat asks it again until it does.")
    assert "Review · #9" in [getattr(lb, "_full", "") for lb in row.findChildren(QLabel)]
    (header,) = [w for w in drawn if isinstance(w, SectionHeader)]
    assert "1" in [lb.text() for lb in header.findChildren(QLabel)], "counted among the tasks"
    # A job that is starting on this machine reads as it did.
    assert StartingTaskRow(label="L", glyph="g", hex_color="#fff").status.text().endswith(
        "starting")


def test_the_settings_switch_flips_the_setting_and_follows_it(app, monkeypatch):
    from diplomat_app.settingsview import SettingsView
    from diplomat_app.store import Store

    monkeypatch.setattr(Store, "refresh_allocator_install_async", lambda self: None)
    monkeypatch.setattr(Store, "refresh_update_status_async", lambda self: None)
    ran = []
    monkeypatch.setattr(da, "run_installer", lambda script, arg: ran.append(arg) or {
        "daemonRunning": arg != "--stop-daemon"})
    store = Store()
    view = SettingsView(store)
    row = view._network_row
    assert row._control is view._sw_network and not view._sw_network.isChecked()
    assert row._control.accessibleName() == "Offer every job to the Diplomacy Network"
    assert row._detail.text().startswith(
        "Every job is offered to a shared pool per repository and runs in a docker "
        "container, possibly on another machine in the pool. ")
    assert row.summary() == ""
    assert view._network_pill.text() == "off"

    view._sw_network.setChecked(True)
    assert store.wait_for_background() == []
    assert appconfig.read()[network.ENABLED_KEY] is True and ran == ["--start-daemon"]
    assert view._network_pill.text() == "on"

    # Flipped from the Network screen: the Settings switch follows, and writes nothing.
    store.set_network_enabled(False)
    assert store.wait_for_background() == []
    assert not view._sw_network.isChecked() and ran == ["--start-daemon", "--stop-daemon"]
    assert view._sw_network.travel == 0.0, "the knob moved with it"
    assert [e.action for e in activity.read()
            if e.action.startswith("network-")] == ["network-stop", "network-start"]
    view.deleteLater()


def test_a_wizard_start_is_offered_off_the_gui_thread_and_spawns_nothing(
        app, daemon, monkeypatch):
    import threading

    from diplomat_runtime import review
    from diplomat_app import widgets
    from diplomat_app.auditwizardview import AuditWizardView
    from diplomat_app.store import Store

    monkeypatch.setattr("diplomat_runtime.promptcore.build_prompt", lambda cfg: "PROMPT")
    monkeypatch.setattr(review, "repo_roots", lambda: [LocalRepo("o", "r", "/src/r")])
    monkeypatch.setattr(review, "spawn", lambda *a, **k: pytest.fail("spawned an agent"))
    fake_probes(monkeypatch)
    appconfig.set_bool(network.ENABLED_KEY, True)
    threads = []
    real = dn.send
    monkeypatch.setattr(dn, "send", lambda *a, **k: (
        threads.append(threading.current_thread() is threading.main_thread()),
        real(*a, **k))[1])
    store = Store()
    store.me, store.has_loaded = "alice", True
    wizard = AuditWizardView(store)

    wizard._spawn()
    assert widgets.OFFERING_TEXT == "Offering to the pool…"
    assert wizard.status.text() == widgets.OFFERING_TEXT and not wizard.spawn_btn.isEnabled()
    assert store.wait_for_background() == []
    app.processEvents()
    assert wizard.status.text() == (
        "Not offered: the Diplomacy Network daemon is not answering")
    assert wizard.spawn_btn.isEnabled()

    d = daemon({"/offer": (200, {"taskId": "t1"})})
    wizard._spawn()
    assert store.wait_for_background() == []
    app.processEvents()
    assert re.fullmatch(r"Offered to the pool · \d\d:\d\d", wizard.status.text())
    (body,) = d.sent("offer")
    assert (body["kind"], body["pool"], body["now"], body["options"]) == (
        "audit", "github.com/o/r", True, {"readOnly": True})
    assert threads == [False, False]
    wizard.deleteLater()


# MARK: - the render modes

@pytest.mark.parametrize("mode", [RICH, STARTING, DOWN, OFF])
def test_each_mode_renders_through_the_real_entry_and_touches_no_real_state(
        app, monkeypatch, tmp_path, daemon, mode):
    from diplomat_app import render

    d = daemon()
    ran = []
    monkeypatch.setattr(da, "run_installer", lambda script, arg: ran.append(arg))
    monkeypatch.setattr(dn, "enabled", dn.enabled)
    monkeypatch.setattr(dn, "devices", dn.devices)
    monkeypatch.setattr(dn, "state", dn.state)
    monkeypatch.setenv("DIPLOMAT_RENDER", mode)
    monkeypatch.setattr(render, "_agents_scratch_dir", None)
    out = tmp_path / f"{mode}.png"
    assert render.run(mode, str(out)) == 0
    assert out.stat().st_size > 10_000
    assert d.got == [] and ran == [], "a render asks no daemon and runs no installer"
    assert not appconfig.path().exists()
