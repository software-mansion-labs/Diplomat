"""The Network screen in each state a render seeds (in pools, starting, daemon not
answering, switched off), its actions as they reach the store and the daemon, and the
three other places the Diplomacy Network shows: the panel's header button and task rows,
the switch in Settings, and a wizard's start.
"""

from __future__ import annotations

import gc
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
    offer,
    snapshot,
)

pytest.importorskip("PySide6")

RICH, STARTING, DOWN, OFF = (
    "network-screen", "network-screen-starting", "network-screen-down", "network-screen-off")


@pytest.fixture
def app():
    from PySide6.QtWidgets import QApplication

    return QApplication.instance() or QApplication([])


@pytest.fixture
def seeded(monkeypatch):
    """A store as a render seeds it for one of the four modes. The fixture sets the
    switch on the module that reads it, which is put back afterwards."""
    from diplomat_app import render
    from diplomat_app.store import Store

    monkeypatch.setattr(dn, "enabled", dn.enabled)
    monkeypatch.setattr(dn, "ready", lambda: True)

    def seed(mode: str) -> Store:
        monkeypatch.setenv("DIPLOMAT_RENDER", mode)
        store = Store()
        render._network_screen_fixture(store, mode)
        return store

    return seed


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

    QApplication.processEvents()  # a row added by a rebuild is shown on the next turn
    shown = [lb for lb in widget.findChildren(QLabel) if lb.isVisible() and lb.text()]
    shown.sort(key=lambda lb: (lb.mapTo(widget, lb.rect().topLeft()).y(),
                               lb.mapTo(widget, lb.rect().topLeft()).x()))
    return [lb.text() for lb in shown]


# MARK: - the four states

def test_in_pools_it_draws_each_pool_with_its_members_tasks_and_actions(screen):
    view = screen(RICH)
    assert [p._pool for p in view.panels] == [
        "github.com/latekvo/diplomat", "github.com/latekvo/prompt-bench"]
    first, second = (texts(p) for p in view.panels)
    assert first[:3] == ["github.com/latekvo/diplomat", "as latekvo", "3 members"]
    for line in ("4be07d21", "this machine", "takes jobs up to 12 h", "seen 4 s ago",
                 "9f3c1a77", "takes jobs up to 24 h", "seen 40 s ago",
                 "c41d90ab", "unreachable", "seen 5 h ago", "TASKS · 5",
                 "Review-req · #412 (@marta)", "Conflicts · #398", "running on this machine"
                 " · lease until " + _clock_of(view, 5700),
                 "Review · #405", "in the pool", "Issues · #377 · deep", "done on 9f3c1a77",
                 "Review-req · #390 (@olek)", "withdrawn", "yours"):
        assert line in first, line
    assert first.count("yours") == 4, "the task another machine offered is not this one's"
    assert "1 member" in second and dn_note("NO_TASKS_NOTE") in second
    assert all(list(p.actions) == ["Copy invite", "Leave", "Leave pool", "Stay"]
               for p in view.panels)
    assert all(p.actions["Copy invite"].isVisible() and p.actions["Leave"].isVisible()
               and not p.actions["Leave pool"].isVisible() for p in view.panels)

    assert view._counts.text() == "2 pools · 5 tasks"
    assert view._light.text() == "daemon running"
    assert {k: v.text() for k, v in view._facts.items()} == {
        "Transport": "ready", "Docker": "ready", "Model": "ready",
        "This machine": "4be07d21", "Address": "dipl7x2kq5examplev3hostq4m.onion",
        "Tasks": "taking 2 more"}
    assert view._daemon_row.summary() == "pid 4471 · started 3 h ago"
    assert not view.start.isVisible() and view.restart.isVisible()
    assert view.restart.isEnabled() and view.join.isVisible()
    assert view.switch.isChecked()


def _clock_of(view, ahead: float) -> str:
    from diplomat_app import render
    from diplomat_app.machinesview import _clock

    return _clock(render.MACHINES_NOW + ahead)


def dn_note(name: str) -> str:
    from diplomat_app import networkview

    return getattr(networkview, name)


def test_starting_says_so_and_offers_no_pool_actions(screen):
    view = screen(STARTING)
    assert view.panels == []
    assert dn_note("STARTING_NOTE") in texts(view)
    assert view._light.text() == "starting"
    assert view._daemon_row.summary() == dn_note("STARTING_NOTE")
    assert view.start.isVisible() and view.restart.isVisible()
    assert not view._facts_host.isVisible() and not view.join.isVisible()


def test_a_daemon_that_does_not_answer_is_said_and_can_be_started(screen, monkeypatch):
    from diplomat_app.store import Store

    asked = []
    monkeypatch.setattr(Store, "start_network_daemon_async", lambda self: asked.append("start"))
    monkeypatch.setattr(Store, "restart_network_async", lambda self: asked.append("restart"))
    view = screen(DOWN)
    assert view.panels == []
    assert dn_note("DOWN_NOTE") in texts(view)
    assert view._light.text() == "daemon not answering"
    assert view._daemon_row.summary() == "The network daemon is not answering."
    assert view.start.isVisible() and view.start.isEnabled() and view.restart.isEnabled()
    view.start.click()
    view.restart.click()
    assert asked == ["start", "restart"]
    assert view.restart.toolTip() == dn_note("RESTART_HELP")


def test_switched_off_it_explains_and_offers_the_switch(screen):
    view = screen(OFF)
    shown = texts(view)
    assert dn_note("OFF_NOTE") in shown and dn.SWITCH_SUMMARY in shown
    assert view.panels == [] and view._light.text() == "off" and view._counts.text() == ""
    assert view.switch.isVisible() and not view.switch.isChecked()
    assert not view._on_host.isVisible()


def test_the_buttons_wait_for_node_and_for_an_installer_run(screen, monkeypatch):
    ready = [False]
    monkeypatch.setattr(dn, "ready", lambda: ready[0])
    view = screen(DOWN)
    assert not view.start.isEnabled() and not view.restart.isEnabled()
    assert view._unavailable.isVisible()
    assert view._unavailable.text().startswith("⚠ Package not found at ")
    ready[0] = True
    view.rebuild()
    assert view.start.isEnabled() and view.restart.isEnabled()
    view.store._network_gate.busy = True
    view.rebuild()
    assert not view.start.isEnabled() and view._light.text() == "starting"
    view.store._network_gate.busy = False


# MARK: - what the header says

def _with(view, **changes):
    from dataclasses import replace

    view.store.network_state = replace(view.store.network_state, **changes)
    view.store.network_changed.emit()


@pytest.mark.parametrize("admit, line", [
    (network.AdmitState(1), "taking 1 more"),
    (network.AdmitState(0, reason="disk"), "taking nothing: disk"),
    (network.AdmitState(0, reason="budget"), "taking nothing: budget"),
    (network.AdmitState(0, reason="paused"), "taking nothing: paused"),
    (network.AdmitState(0), "taking nothing: no free slot"),
])
def test_the_admit_line_says_how_many_or_why_none(screen, admit, line):
    view = screen(RICH)
    _with(view, admit=admit)
    assert view._facts["Tasks"].text() == line


def test_a_service_that_is_not_ready_says_why(screen):
    view = screen(RICH)
    _with(view, transport=network.Service("bootstrapping", "tor is at 40%"),
          docker=network.Docker("missing", "", "docker is not installed"),
          model=network.Service("missing", ""))
    assert [view._facts[k].text() for k in ("Transport", "Docker", "Model")] == [
        "bootstrapping: tor is at 40%", "missing: docker is not installed", "missing"]


def test_pools_held_back_and_no_pool_yet_are_written_out(screen):
    view = screen(RICH)
    view.store.network_pools_held = "the login on github.com is not known yet"
    view.store.network_error = "slots must be a whole number."
    _with(view, pools=())
    shown = texts(view)
    assert ("The daemon was not told which repositories to share: the login on "
            "github.com is not known yet.") in shown
    assert dn_note("NO_POOLS_NOTE") in shown
    assert "slots must be a whole number." in shown
    assert view._counts.text() == "0 pools · 0 tasks"


def test_what_the_daemon_reports_is_drawn_as_plain_text(screen):
    from PySide6.QtCore import Qt
    from PySide6.QtWidgets import QLabel

    view = screen(RICH)
    tag = "<b>x</b>"
    pool = view.store.network_state.pools[0]
    task = network.PoolTask(task_id="t", title=f"t{tag}", kind=f"k{tag}", state=f"s{tag}")
    hostile = network.Pool(id=f"p{tag}", identity=f"i{tag}", members=pool.members,
                           tasks=(task,))
    _with(view, pools=(hostile,), onion=f"o{tag}",
          transport=network.Service("failed", f"d{tag}"))
    labels = [lb for lb in view.findChildren(QLabel) if tag in lb.text()]
    assert len(labels) >= 7
    assert all(lb.textFormat() == Qt.TextFormat.PlainText for lb in labels)


def test_the_recent_card_lists_the_feeds_network_lines(screen):
    view = screen(RICH)
    assert "Made an invite to github.com/latekvo/diplomat" in texts(view)
    view.store.audit_entries = [e for e in view.store.audit_entries
                                if not e.action.startswith("network-")]
    view.store.activity_changed.emit()
    assert "No network events in the activity feed." in texts(view)


# MARK: - the actions

def test_the_pool_actions_reach_the_store_with_their_pool(screen, monkeypatch):
    from diplomat_app.store import Store

    asked = []
    for name in ("network_invite_async", "network_leave_async", "network_join_async"):
        monkeypatch.setattr(Store, name, lambda self, arg, name=name: asked.append((name, arg)))
    view = screen(RICH)
    panel = view.panels[1]
    panel.actions["Copy invite"].click()
    panel.actions["Leave"].click()
    assert asked == [("network_invite_async", "github.com/latekvo/prompt-bench")]
    assert panel.actions["Leave pool"].isVisible(), "leaving is asked about first"
    assert dn_note("LEAVE_QUESTION") in texts(panel)
    panel.actions["Stay"].click()
    assert not panel.actions["Leave pool"].isVisible() and len(asked) == 1
    panel.actions["Leave"].click()
    panel.actions["Leave pool"].click()
    assert asked[-1] == ("network_leave_async", "github.com/latekvo/prompt-bench")

    view.join.click()
    assert len(asked) == 2, "an empty field joins nothing"
    view.join_field.setText("  dn1-abc  ")
    view.join.click()
    assert asked[-1] == ("network_join_async", "dn1-abc")
    assert view.join_field.placeholderText() == dn_note("JOIN_PLACEHOLDER")


def test_an_invite_lands_on_the_clipboard_and_a_join_names_its_pool(
        app, screen, daemon, monkeypatch):
    from PySide6.QtGui import QGuiApplication

    monkeypatch.setattr(dn, "enabled", lambda: True)
    view = screen(RICH)
    store = view.store
    state = store.network_state
    monkeypatch.setattr(store, "_network_cycle", lambda: None)  # keep the seeded pools
    d = daemon({"/invite": (200, {"invite": "dn1-secret"}), "/join": (200, {"pool": POOL}),
                "/leave": (409, {"error": "The last member cannot leave."})})
    pool = state.pools[0].id

    QGuiApplication.clipboard().setText("")
    view.panels[0].actions["Copy invite"].click()
    assert store.wait_for_background() == []
    app.processEvents()
    assert QGuiApplication.clipboard().text() == "dn1-secret"
    assert view.panels[0].status.text() == dn_note("INVITE_COPIED")
    assert view.panels[1].status.text() == ""
    QGuiApplication.clipboard().setText("something else")
    store.network_changed.emit()
    assert QGuiApplication.clipboard().text() == "something else", "copied once"

    view.join_field.setText("dn1-other")
    view.join.click()
    assert store.wait_for_background() == []
    app.processEvents()
    assert view._join_status.text() == f"Joined {POOL}." and view.join_field.text() == ""

    view.panels[0].actions["Leave"].click()
    view.panels[0].actions["Leave pool"].click()
    assert store.wait_for_background() == []
    app.processEvents()
    assert view.panels[0].status.text() == "The last member cannot leave."
    assert (d.sent("invite"), d.sent("join"), d.sent("leave")) == (
        [{"pool": pool}], [{"invite": "dn1-other"}], [{"pool": pool}])


def test_a_call_under_way_holds_every_pool_action(screen):
    from diplomat_app.store import NetworkCall

    view = screen(RICH)
    pool = view.store.network_state.pools[0].id
    view.store.network_call = NetworkCall("leave", pool, running=True)
    view.store.network_changed.emit()
    assert not any(b.isEnabled() for p in view.panels for b in p.actions.values())
    assert not view.join.isEnabled()
    assert [p.status.text() for p in view.panels] == ["Leaving…", ""]
    view.store.network_call = NetworkCall("invite", pool, running=True)
    view.store.network_changed.emit()
    assert view.panels[0].status.text() == "Making an invite…"
    view.store.network_call = NetworkCall("join", running=True)
    view.store.network_changed.emit()
    assert view._join_status.text() == "Joining…"


def test_the_hours_open_on_twelve_and_write_the_two_config_keys(screen):
    view = screen(RICH)
    assert (view.required_h.value(), view.accepted_h.value()) == (12, 12)
    assert (view.required_h.minimum(), view.accepted_h.minimum()) == (12, 12)
    view.required_h.setValue(36)
    view.accepted_h.setValue(5)
    assert view.accepted_h.value() == 12, "twelve is the floor"
    assert appconfig.read() == {network.REQUIRED_MINIMUM_H_KEY: 36}
    view.accepted_h.setValue(24)
    assert appconfig.read()[network.MAXIMUM_ACCEPTED_H_KEY] == 24
    assert (dn.required_minimum_h(), dn.maximum_accepted_h()) == (36, 24)
    dn.set_hours(network.MAXIMUM_ACCEPTED_H_KEY, 5)
    assert appconfig.read()[network.MAXIMUM_ACCEPTED_H_KEY] == 12
    # A value set from elsewhere shows on the next rebuild, and is not written back.
    appconfig.set_int(network.MAXIMUM_ACCEPTED_H_KEY, 48)
    view.rebuild()
    assert view.accepted_h.value() == 48


def test_the_screens_switch_flips_the_setting_through_the_store(screen, monkeypatch):
    from diplomat_app.store import Store

    flipped = []
    monkeypatch.setattr(Store, "set_network_enabled", lambda self, on: flipped.append(on))
    view = screen(OFF)
    view.switch.setChecked(True)
    assert flipped == [True]

    def refuse(self, on):
        raise OSError(28, "No space left on device")

    monkeypatch.setattr(Store, "set_network_enabled", refuse)
    view.switch.setChecked(False)
    view.switch.setChecked(True)
    assert view._save_error.isVisible() and "No space left on device" in view._save_error.text()
    assert not view.switch.isChecked(), "the switch shows what is in force"


def test_the_screens_switch_follows_a_change_made_elsewhere(app, seeded, monkeypatch):
    from diplomat_app.networkview import NetworkView
    from diplomat_app.store import Store

    flipped = []
    monkeypatch.setattr(Store, "set_network_enabled", lambda self, on: flipped.append(on))
    view = NetworkView(seeded(OFF), live=False)
    monkeypatch.setattr(dn, "enabled", lambda: True)
    view.store.network_changed.emit()
    assert view.switch.isChecked() and view.switch.travel == 1.0, "knob and all"
    assert flipped == [], "following the setting writes nothing"
    view.deleteLater()


def test_a_dropped_network_screen_is_freed_without_the_cycle_collector(app, seeded):
    """PySide 6.12 segfaults collecting a live screen caught in a reference cycle."""
    from diplomat_app.networkview import NetworkView

    view = NetworkView(seeded(RICH), live=False)
    view.rebuild()
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
    assert view._age_timer.isActive() and len(cycles) == 1
    panel.network_btn.click()
    assert panel.body.currentIndex() == panel._screens["main"]
    assert not view._age_timer.isActive()
    panel.network_btn.click()
    view.done.emit()
    assert panel.body.currentIndex() == panel._screens["main"]


def test_a_network_run_is_a_row_that_opens_the_screen_and_can_be_stopped_or_forgotten(
        app, panel, monkeypatch):
    from PySide6.QtCore import QPoint, Qt
    from PySide6.QtTest import QTest

    from diplomat_app.store import Store
    from diplomat_app.widgets import NetworkTaskRow, RunningTaskRow

    appconfig.set_bool(network.ENABLED_KEY, True)
    asked = []
    monkeypatch.setattr(Store, "stop_network_run_async",
                        lambda self, run_id: asked.append(("stop", run_id)))
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
    assert "Network screen" in row.toolTip()

    row.stop.click()
    row.forget.click()
    assert asked == [("stop", run.run_id), ("forget", run.run_id)]
    assert panel.body.currentIndex() == panel._screens["main"]
    panel.show()
    app.processEvents()
    QTest.mouseClick(row, Qt.MouseButton.LeftButton, pos=QPoint(60, 8))
    assert panel.body.currentIndex() == panel._screens["network"]
    panel.hide()


# MARK: - Settings and the wizard

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
    assert row._control.accessibleName() == "Diplomacy Network"
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
    assert wizard.status.text() == widgets.OFFERING_TEXT and not wizard.spawn_btn.isEnabled()
    assert store.wait_for_background() == []
    app.processEvents()
    assert wizard.status.text() == dn.NOT_RUNNING and wizard.spawn_btn.isEnabled()

    d = daemon({"/offer": (200, {"taskId": "t1"})})
    wizard._spawn()
    assert store.wait_for_background() == []
    app.processEvents()
    assert wizard.status.text() == widgets.OFFERED_TEXT
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
    monkeypatch.setenv("DIPLOMAT_RENDER", mode)
    monkeypatch.setattr(render, "_agents_scratch_dir", None)
    out = tmp_path / f"{mode}.png"
    assert render.run(mode, str(out)) == 0
    assert out.stat().st_size > 10_000
    assert d.got == [] and ran == [], "a render asks no daemon and runs no installer"
    assert not appconfig.path().exists()
