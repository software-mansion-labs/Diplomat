"""The Network screen, twin of the macOS one (``NetworkScreen.swift``): the Diplomacy
Network daemon's status, the hours this machine asks for and takes, and one panel per
pool it is in.
"""

from __future__ import annotations

import os
import time
from collections.abc import Callable

from PySide6.QtCore import Qt, QTimer, Signal
from PySide6.QtGui import QGuiApplication, QPalette
from PySide6.QtWidgets import (
    QFrame,
    QGridLayout,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QPushButton,
    QSpinBox,
    QVBoxLayout,
    QWidget,
)

from diplomat_runtime import activity, agentstate, network
from diplomat_runtime.models import Fmt
from . import diplomacynetwork as dn
from . import glyphs
from . import remotemachines as rm
from .machinesview import _chip, _clear, _clock, _note, _plain
from .store import Store
from .widgets import (
    ActivityRow,
    ElidedLabel,
    GlyphLabel,
    Pill,
    SettingRow,
    SwitchToggle,
    muted,
    settings_card,
    tint_bg,
)

_TEAL = "#30B0C7"
_GREEN, _ORANGE, _RED, _GREY = rm.GREEN, rm.AMBER, rm.RED, rm.GREY

#: What one press of an hours stepper moves it by.
HOURS_STEP = 12

OFF_NOTE = "Off: every job runs in a terminal on this machine."
ASKING = "Asking the daemon…"
SILENT = "Not answering. Diplomat starts it again on its own, waiting longer after each try."
RESTART_HELP = ("Stop the running daemon and start this checkout's. Jobs running in "
                "containers here are stopped with it.")
REQUIRED_TITLE = "Hours a job of yours may take"
REQUIRED_SUMMARY = ("Counted from when a machine takes it. Only machines that take jobs "
                    "this long run yours.")
ACCEPTED_TITLE = "Longest job this machine takes"
ACCEPTED_SUMMARY = "A job that may take longer is left to the other machines of its pool."
NO_POOLS = ("No pools yet. Each repository in Settings gets one once Diplomat knows "
            "which account works on it.")
NO_MEMBERS = "No members listed yet."
NO_TASKS = "No tasks in this pool."
NO_EVENTS = "No network actions in the activity feed."
INVITE_PLACEHOLDER = "Paste an invite"
INVITE_COPIED = "Invite copied. Send it to the machine that should join."
STOP_RUN_HELP = "Stop this job's run on this machine. It goes back to the pool."
WITHDRAW_HELP = "Withdraw this job from the pool."
LEFT_NOTE = "left - this machine takes and offers nothing here"

_SECTION = "font-size: 11px; font-weight: 600;"


def leave_question(pool: str) -> str:
    return f"Leave {pool}? This machine stops taking its jobs and offering jobs to it."


def network_events(entries: list) -> list:
    return [e for e in entries if e.action.startswith("network-")][:6]


def admit_line(admit: network.AdmitState) -> str:
    """How many more tasks this machine takes, as the daemon was last told."""
    if admit.slots > 0:
        return f"taking {admit.slots} more"
    return f"taking nothing: {admit.reason or 'full'}"


def service_tint(state: str) -> str:
    if state == "ready":
        return _GREEN
    if state in ("failed", "missing", "down"):
        return _RED
    return _ORANGE if state else _GREY


def counts(snapshot: network.Snapshot) -> str:
    """The pools this machine is in and the tasks they hold; one it left is not counted."""
    joined = [p for p in snapshot.pools if not p.left]
    pools, tasks = len(joined), sum(len(p.tasks) for p in joined)
    return (f"{pools} pool{'' if pools == 1 else 's'} · "
            f"{tasks} task{'' if tasks == 1 else 's'}")


def task_state(state: str) -> str:
    """A pool task's state as the screen words it."""
    return {"available": "in the pool", "claimed": "running"}.get(state, state)


def ending(task: str, snapshot: network.Snapshot | None) -> str | None:
    """How the offer this machine made of ``task`` ended, in the words its run's row
    has, where the daemon gave a reason; None for any other task."""
    offers = network.tasks(snapshot)
    offer = offers.value.get(task) if offers.ok else None
    if (offer is None or not offer.reason
            or offer.state not in (agentstate.NET_FAILED, agentstate.NET_CANCELLED)):
        return None
    return agentstate.network_verdict(task, offers, 0)[1]


def place(task: network.PoolTask) -> str:
    """Where a pool's task is and until when: "on this machine · lease to 14:05"."""
    parts = []
    if task.offered_here:
        parts.append("offered here")
    if task.executor_here:
        parts.append("on this machine")
    elif task.executor:
        parts.append(f"on {dn.short_key(task.executor)}")
    if task.state == "claimed" and task.lease_until:
        parts.append(f"lease to {_clock(task.lease_until)}")
    return " · ".join(parts)


def _button(title: str, tint: str, tip: str = "") -> QPushButton:
    btn = QPushButton(title)
    btn.setToolTip(tip)
    btn.setStyleSheet(
        f"QPushButton {{ color: {tint}; background-color: {tint_bg(tint, 0.14)};"
        " border: none; border-radius: 5px; padding: 2px 9px; font-size: 9px;"
        " font-weight: 700; }"
        f"QPushButton:hover {{ background-color: {tint_bg(tint, 0.26)}; }}"
        f"QPushButton:disabled {{ color: {_GREY}; }}")
    return btn


# MARK: - joining a pool

class JoinRow(QWidget):
    """Paste an invite and join the pool it is to. ``card`` is the pool panel it sits
    in ("" for the one shown before any pool), which is where a refusal is shown; ``ui``
    is that panel's state, which outlives the row."""

    def __init__(self, store: Store, card: str, ui: dict, parent: QWidget) -> None:
        super().__init__(parent)
        self._store, self.card, self._ui = store, card, ui
        row = QHBoxLayout(self)
        row.setContentsMargins(0, 0, 0, 0)
        row.setSpacing(6)
        self.field = QLineEdit(self)
        self.field.setPlaceholderText(INVITE_PLACEHOLDER)
        self.field.setAccessibleName("Invite")
        self.field.setText(ui.get("invite", ""))
        self.field.textChanged.connect(self._typed)
        self.field.returnPressed.connect(self._join)
        row.addWidget(self.field, 1)
        self.button = _button("Join", _TEAL)
        self.button.clicked.connect(self._join)
        row.addWidget(self.button)
        self._sync()

    def _token(self) -> str:
        return self.field.text().strip()

    def _typed(self, text: str) -> None:
        self._ui["invite"] = text
        self._sync()

    def _sync(self) -> None:
        self.button.setEnabled(bool(self._token()) and not self._ui.get("sending"))

    def _join(self) -> None:
        if not self._token() or self._ui.get("sending"):
            return
        self._ui["sending"] = True
        self._sync()
        self._store.network_join_async(self._token(), self.card)


# MARK: - one pool

class PoolPanel(QWidget):
    """One pool: who is in it, what it holds, and the invite, join and leave actions.
    A pool this machine left says so and offers only the way back in. ``ui`` is what
    the operator has open in it, kept by the screen across a redraw; ``ages`` takes
    the lines that say how long ago something was, for the screen to keep current."""

    def __init__(self, pool: network.Pool, *, store: Store, ui: dict, refusal: str,
                 ages: list) -> None:
        super().__init__()
        self._store, self._pool, self._ui = store, pool.id, ui
        self.actions: dict[str, QPushButton] = {}
        self.stops: dict[str, QPushButton] = {}
        self.join_row: JoinRow | None = None
        outer = QVBoxLayout(self)
        outer.setContentsMargins(0, 0, 0, 0)
        card, col, pill = settings_card(glyphs.G_NETWORK, pool.id, _TEAL,
                                        foreign_title=True)
        outer.addWidget(card)
        subtitle = " · ".join(x for x in (
            pool.path, f"as @{pool.identity}" if pool.identity else "") if x)
        if subtitle:
            col.addWidget(_plain(subtitle, muted(9, mono=True)))
        if pool.left:
            pill.set_state("left", _GREY)
            col.addWidget(_note(LEFT_NOTE))
            back = QHBoxLayout()
            self._add(back, "Rejoin", _TEAL, self._rejoin)
            back.addStretch(1)
            col.addLayout(back)
            if refusal:
                col.addWidget(_note(refusal, _RED))
            return
        n = len(pool.members)
        pill.set_state(f"{n} member{'' if n == 1 else 's'}", _TEAL)
        col.addWidget(_plain("Members", _SECTION))
        if not pool.members:
            col.addWidget(_note(NO_MEMBERS))
        for member in pool.members:
            col.addLayout(self._member(member, ages))
        col.addWidget(_plain("Tasks", _SECTION))
        if not pool.tasks:
            col.addWidget(_note(NO_TASKS))
        for task in pool.tasks:
            col.addWidget(self._task(task))

        self._buttons = QWidget(self)
        buttons = QHBoxLayout(self._buttons)
        buttons.setContentsMargins(0, 0, 0, 0)
        buttons.setSpacing(6)
        self._add(buttons, "Copy invite", _TEAL, self._invite)
        self._add(buttons, "Join…", _TEAL, self._toggle_join)
        self._add(buttons, "Leave", _TEAL, self._ask_leave)
        buttons.addStretch(1)
        col.addWidget(self._buttons)
        self.join_row = JoinRow(store, pool.id, ui, self)
        col.addWidget(self.join_row)
        self._copied = _note(INVITE_COPIED, _GREEN)
        col.addWidget(self._copied)

        self._confirm = QWidget(self)
        confirm = QVBoxLayout(self._confirm)
        confirm.setContentsMargins(0, 0, 0, 0)
        confirm.setSpacing(5)
        confirm.addWidget(_note(leave_question(pool.id)))
        answers = QHBoxLayout()
        answers.setSpacing(6)
        self._add(answers, "Leave pool", _RED, self._leave, title="Leave")
        self._add(answers, "Cancel", _GREY, self._cancel_leave)
        answers.addStretch(1)
        confirm.addLayout(answers)
        col.addWidget(self._confirm)
        if refusal:
            col.addWidget(_note(refusal, _RED))
        self._sync()

    def _sync(self) -> None:
        leaving = bool(self._ui.get("leaving"))
        self._buttons.setVisible(not leaving)
        self.join_row.setVisible(not leaving and bool(self._ui.get("joining")))
        self._copied.setVisible(not leaving and bool(self._ui.get("copied")))
        self._confirm.setVisible(leaving)

    def _add(self, layout: QHBoxLayout, key: str, tint: str, slot, *,
             title: str | None = None) -> None:
        btn = _button(title or key, tint)
        btn.clicked.connect(slot)
        layout.addWidget(btn)
        self.actions[key] = btn

    def _member(self, m: network.Member, ages: list) -> QHBoxLayout:
        row = QHBoxLayout()
        row.setSpacing(6)
        row.addWidget(_plain(dn.short_key(m.pk), "font-size: 10px; font-family: monospace;"))
        if m.is_self:
            row.addWidget(_chip("this machine", _TEAL))
        if not m.reachable:
            row.addWidget(_chip("unreachable", _ORANGE))
        row.addStretch(1)
        if m.max_accepted_h is not None:
            row.addWidget(_plain(f"takes up to {m.max_accepted_h} h", muted(9)))
        if not m.is_self:
            seen = _plain("never seen", muted(9))
            last = m.last_seen
            if last:
                ages.append((seen.setText, lambda now: f"seen {rm.ago(max(0, now - last))}"))
            row.addWidget(seen)
        return row

    def _task(self, t: network.PoolTask) -> QFrame:
        box = QFrame(self)
        box.setObjectName("poolTask")
        box.setStyleSheet("#poolTask { background-color: rgba(128,128,128,0.08);"
                          " border-radius: 6px; }")
        col = QVBoxLayout(box)
        col.setContentsMargins(5, 5, 5, 5)
        col.setSpacing(2)
        head = QHBoxLayout()
        head.setSpacing(6)
        # Another machine's words: drawn as they are, on one line.
        head.addWidget(ElidedLabel(
            t.title or t.item, 10,
            self.palette().color(QPalette.ColorRole.WindowText).name(),
            Qt.TextElideMode.ElideMiddle), 1)
        if t.kind:
            head.addWidget(_chip(t.kind, _GREY))
        head.addWidget(_chip(task_state(t.state), {"claimed": _GREEN,
                                                   "available": _ORANGE}.get(t.state, _GREY)))
        col.addLayout(head)
        foot = QHBoxLayout()
        foot.setSpacing(6)
        foot.addWidget(_plain(place(t) or "nobody has taken it", muted(9)), 1)
        if t.state in ("available", "claimed") and (t.offered_here or t.executor_here):
            stop = _button("Stop", _RED, STOP_RUN_HELP if t.executor_here else WITHDRAW_HELP)
            store, pool = self._store, self._pool
            stop.clicked.connect(lambda: store.stop_network_task_async(t, pool))
            foot.addWidget(stop)
            self.stops[t.task_id] = stop
        col.addLayout(foot)
        why = ending(t.task_id, self._store.network_state)
        if why:
            col.addWidget(_note(why, _ORANGE))
        return box

    def _invite(self) -> None:
        self._ui["copied"] = False
        self._sync()
        self._store.network_invite_async(self._pool)

    def _toggle_join(self) -> None:
        self._ui["joining"] = not self._ui.get("joining")
        self._sync()

    def _ask_leave(self) -> None:
        self._ui["leaving"] = True
        self._sync()

    def _cancel_leave(self) -> None:
        self._ui["leaving"] = False
        self._sync()

    def _leave(self) -> None:
        self._cancel_leave()
        self._store.network_leave_async(self._pool)

    def _rejoin(self) -> None:
        self._store.network_rejoin_async(self._pool)


# MARK: - the screen

class NetworkView(QWidget):
    """``live`` asks the daemon while the screen is up; off in a render, whose seeded
    state a real read would overwrite. ``clock`` is what every age measures against; a
    render pins it."""

    done = Signal()

    def __init__(self, store: Store, *, live: bool | None = None) -> None:
        super().__init__()
        self.store = store
        self.live = "DIPLOMAT_RENDER" not in os.environ if live is None else live
        self.clock: Callable[[], float] = time.time
        self._ages: list[tuple[Callable[[str], None], Callable[[float], str]]] = []
        self._pool_ages: list[tuple[Callable[[str], None], Callable[[float], str]]] = []
        #: What the operator has open in each pool's panel, by pool id ("" for the
        #: panel shown before any pool).
        self._ui: dict[str, dict] = {}
        self.panels: list[PoolPanel] = []
        self.first_join: JoinRow | None = None

        root = QVBoxLayout(self)
        root.setContentsMargins(0, 0, 0, 0)
        root.setSpacing(12)
        root.addLayout(self._build_header())
        self._save_error = _note("", _RED)
        self._save_error.hide()
        root.addWidget(self._save_error)

        self._off_card, off, off_pill = settings_card(
            glyphs.G_NETWORK, "DIPLOMACY NETWORK", _TEAL)
        off_pill.set_state("off", _GREY)
        self.off_switch = self._switch_row(off)
        off.addWidget(_note(OFF_NOTE))
        root.addWidget(self._off_card)

        self._on_host = QWidget(self)
        on = QVBoxLayout(self._on_host)
        on.setContentsMargins(0, 0, 0, 0)
        on.setSpacing(12)
        cards = QHBoxLayout()
        cards.setSpacing(12)
        left = QVBoxLayout()
        left.addWidget(self._build_status_card())
        left.addStretch(1)
        right = QVBoxLayout()
        right.setSpacing(12)
        right.addWidget(self._build_settings_card())
        events_card, self._events_col, _ = settings_card(glyphs.G_RECENT, "RECENT", _GREY)
        right.addWidget(events_card)
        right.addStretch(1)
        cards.addLayout(left, 1)
        cards.addLayout(right, 1)
        on.addLayout(cards)
        self._pools = QGridLayout()
        self._pools.setSpacing(12)
        self._pools.setColumnStretch(0, 1)
        self._pools.setColumnStretch(1, 1)
        on.addLayout(self._pools)
        root.addWidget(self._on_host)
        root.addStretch(1)

        self._timer = QTimer(self)
        self._timer.setInterval(2_000)
        self._timer.timeout.connect(self._poll)

        store.network_changed.connect(self.rebuild)
        store.network_invited.connect(self._on_invited)
        store.network_joined.connect(self._on_joined)
        store.activity_changed.connect(self._rebuild_events)
        self.rebuild()

    def opened(self) -> None:
        if self.live:
            self.store.run_network_cycle_async()
            self._timer.start()
        self.rebuild()

    def closed(self) -> None:
        self._timer.stop()

    def _poll(self) -> None:
        self.store.run_network_cycle_async()
        self._refresh_ages()

    def _save(self, write) -> bool:
        try:
            write()
        except OSError as exc:
            self._save_error.setText(f"⚠ Couldn't save that change "
                                     f"({exc.strerror or exc}), so it has no effect "
                                     "until it is made again.")
            self._save_error.show()
            return False
        self._save_error.hide()
        return True

    def _refresh_ages(self) -> None:
        now = self.clock()
        for set_text, text in self._ages + self._pool_ages:
            set_text(text(now))

    def rebuild(self) -> None:
        self._refresh_status()
        self._rebuild_pools()
        self._rebuild_events()

    def _on_invited(self, pool: str, invite: str) -> None:
        QGuiApplication.clipboard().setText(invite)
        self._ui.setdefault(pool, {})["copied"] = True
        self._rebuild_pools()

    def _on_joined(self, card: str, ok: bool) -> None:
        ui = self._ui.setdefault(card, {})
        ui["sending"] = False
        if ok:
            ui["invite"] = ""
            ui["joining"] = False
        self._rebuild_pools()

    # MARK: header

    def _build_header(self) -> QHBoxLayout:
        row = QHBoxLayout()
        row.setContentsMargins(2, 0, 2, 0)
        row.setSpacing(6)
        row.addWidget(GlyphLabel(glyphs.G_NETWORK, 16, glyphs.MUTED, font_px=14))
        row.addWidget(_plain("Network", "font-weight: 700; font-size: 13px;"))
        self._counts = _plain("", muted(10, mono=True))
        row.addWidget(self._counts)
        row.addStretch(1)
        self._dot = _plain("●")
        row.addWidget(self._dot)
        self._light = _plain("", muted(9))
        row.addWidget(self._light)
        done = QPushButton("Done")
        done.setStyleSheet("font-weight: 700;")
        done.clicked.connect(self.done.emit)
        row.addWidget(done)
        return row

    def _daemon_light(self) -> tuple[str, str, str]:
        """The daemon's standing: its tint, the header's words and the pill's."""
        if not self.store.network_enabled:
            return _GREY, "off", "off"
        answered = self.store.network_answered
        if answered is None:
            return _GREY, "checking", "checking"
        if answered:
            return _GREEN, "daemon running", "running"
        return _ORANGE, "daemon not answering", "not answering"

    # MARK: the switch and the hours

    def _switch_row(self, body: QVBoxLayout) -> SwitchToggle:
        switch = SwitchToggle(_TEAL)
        switch.setChecked(self.store.network_enabled)
        switch.toggled.connect(self._on_switch)
        body.addWidget(SettingRow(dn.SWITCH_TITLE, switch, summary=dn.EXPLANATION))
        return switch

    def _hours_box(self, slot) -> QSpinBox:
        box = QSpinBox(self)
        box.setRange(network.HOURS_FLOOR, network.HOURS_CEILING)
        box.setSingleStep(HOURS_STEP)
        box.setSuffix(" h")
        box.setKeyboardTracking(False)
        box.valueChanged.connect(slot)
        return box

    def _build_settings_card(self) -> QWidget:
        card, body, _ = settings_card(glyphs.G_LIMITS, "SETTINGS", _GREY)
        self.switch = self._switch_row(body)
        self.required_h = self._hours_box(self._on_required_h)
        body.addWidget(SettingRow(REQUIRED_TITLE, self.required_h, summary=REQUIRED_SUMMARY))
        self.accepted_h = self._hours_box(self._on_accepted_h)
        body.addWidget(SettingRow(ACCEPTED_TITLE, self.accepted_h, summary=ACCEPTED_SUMMARY))
        return card

    def _sync_hours(self) -> None:
        """The two hours as the shared config has them, without writing them back."""
        for box, value in ((self.required_h, dn.required_minimum_h()),
                           (self.accepted_h, dn.maximum_accepted_h())):
            if box.value() != value and not box.hasFocus():
                box.blockSignals(True)
                box.setValue(value)
                box.blockSignals(False)

    def _on_switch(self, on: bool) -> None:
        # The switch following the setting is no change to make: its signal stays
        # connected because it is also what moves the knob.
        if on == self.store.network_enabled:
            return
        if not self._save(lambda: self.store.set_network_enabled(on)):
            self._refresh_status()

    def _on_required_h(self, value: int) -> None:
        self._save(lambda: dn.set_hours(network.REQUIRED_MINIMUM_H_KEY, value))

    def _on_accepted_h(self, value: int) -> None:
        self._save(lambda: dn.set_hours(network.MAXIMUM_ACCEPTED_H_KEY, value))

    # MARK: status

    def _build_status_card(self) -> QWidget:
        card, body, _ = settings_card(glyphs.G_NETWORK, "DIPLOMACY NETWORK", _TEAL)
        self._daemon_pill = Pill("")
        self._daemon_row = SettingRow("Daemon", self._daemon_pill)
        body.addWidget(self._daemon_row)
        self._problem = _note("", _ORANGE)
        body.addWidget(self._problem)

        self._buttons = QWidget(card)
        buttons = QHBoxLayout(self._buttons)
        buttons.setContentsMargins(0, 0, 0, 0)
        self.start = QPushButton("Start daemon")
        self.start.clicked.connect(self.store.start_network_daemon_async)
        buttons.addWidget(self.start)
        self.restart = QPushButton("Restart daemon")
        self.restart.setToolTip(RESTART_HELP)
        self.restart.clicked.connect(self.store.restart_network_async)
        buttons.addWidget(self.restart)
        buttons.addStretch(1)
        body.addWidget(self._buttons)

        self._answered = QWidget(card)
        answered = QVBoxLayout(self._answered)
        answered.setContentsMargins(0, 0, 0, 0)
        answered.setSpacing(4)
        chips = QHBoxLayout()
        chips.setSpacing(6)
        self._services: dict[str, QLabel] = {}
        for name in ("transport", "docker", "model"):
            self._services[name] = _chip("", _GREY)
            chips.addWidget(self._services[name])
        chips.addStretch(1)
        answered.addLayout(chips)
        self._service_notes = QVBoxLayout()
        self._service_notes.setSpacing(2)
        answered.addLayout(self._service_notes)
        facts = QGridLayout()
        facts.setHorizontalSpacing(10)
        facts.setVerticalSpacing(3)
        self._facts: dict[str, QLabel] = {}
        for line, key in enumerate(("This machine", "Onion address", "Work from pools")):
            facts.addWidget(_plain(key, muted(10)), line, 0)
            self._facts[key] = _plain("", "font-size: 10px; font-weight: 600;")
            facts.addWidget(self._facts[key], line, 1)
        facts.setColumnStretch(1, 1)
        answered.addLayout(facts)
        body.addWidget(self._answered)
        return card

    def _refresh_status(self) -> None:
        store, state = self.store, self.store.network_state
        on, answered = store.network_enabled, store.network_answered
        self.switch.setChecked(on)
        self.off_switch.setChecked(on)
        color, light, pill = self._daemon_light()
        self._dot.setStyleSheet(f"color: {color}; font-size: 9px;")
        self._light.setText(light)
        self._counts.setText(counts(state) if on and state else "")
        self._off_card.setVisible(not on)
        self._on_host.setVisible(on)
        if not on:
            return
        self._sync_hours()
        self._daemon_pill.set_state(pill, color)
        self._ages = []
        problem = dn.unavailable_summary() if answered is False else None
        self._problem.setText(problem or "")
        self._problem.setVisible(bool(problem))
        usable = dn.ready() and not store.network_busy
        self._buttons.setVisible(answered is not None)
        self.start.setVisible(answered is False)
        self.start.setEnabled(usable)
        self.restart.setEnabled(usable)
        self._answered.setVisible(state is not None)
        if answered is None:
            self._daemon_row.set_summary(ASKING)
        elif state is None:
            self._daemon_row.set_summary(SILENT)
        else:
            self._refresh_answered(state)
        self._refresh_ages()

    def _refresh_answered(self, state: network.Snapshot) -> None:
        pid = f"pid {state.pid} · " if state.pid is not None else ""
        started, socket = state.started_at, str(dn.socket_path())
        self._ages.append((self._daemon_row.set_summary, lambda now: pid + (
            f"started {rm.ago(max(0, now - started))} · " if started is not None else "")
            + socket))
        _clear(self._service_notes)
        for name, service in (("transport", state.transport), ("docker", state.docker),
                              ("model", state.model)):
            tint = service_tint(service.state)
            chip = self._services[name]
            chip.setText(f"{name} {service.state or 'unknown'}")
            chip.setStyleSheet(
                f"color: {tint}; background-color: {tint_bg(tint, 0.14)};"
                " border-radius: 7px; padding: 1px 6px; font-size: 9px; font-weight: 700;")
            if service.state != "ready" and service.detail:
                self._service_notes.addWidget(_note(f"{name}: {service.detail}", tint))
        self._facts["This machine"].setText(dn.short_key(state.pk) or "no key yet")
        self._facts["Onion address"].setText(state.onion or "not published yet")
        self._facts["Work from pools"].setText(admit_line(state.admit))

    # MARK: pools

    def _join_rows(self) -> list[JoinRow]:
        return [j for j in (*(p.join_row for p in self.panels), self.first_join)
                if j is not None]

    def _rebuild_pools(self) -> None:
        focused = next((j.card for j in self._join_rows() if j.field.hasFocus()), None)
        _clear(self._pools)
        self._pool_ages = []
        self.panels = []
        self.first_join = None
        store, state = self.store, self.store.network_state
        if not store.network_enabled or state is None:
            return
        refusals = store.network_refusals
        cards: list[QWidget] = []
        # In no pool, an invite has no pool's panel to be pasted into.
        if all(p.left for p in state.pools):
            card, col, _ = settings_card(glyphs.G_NETWORK, "POOLS", _TEAL)
            if not state.pools:
                col.addWidget(_note(NO_POOLS))
            self.first_join = JoinRow(store, "", self._ui.setdefault("", {}), card)
            col.addWidget(self.first_join)
            if refusals.get(""):
                col.addWidget(_note(refusals[""], _RED))
            cards.append(card)
        for pool in state.pools:
            panel = PoolPanel(pool, store=store, ui=self._ui.setdefault(pool.id, {}),
                              refusal=refusals.get(pool.id, ""), ages=self._pool_ages)
            self.panels.append(panel)
            cards.append(panel)
        for i, card in enumerate(cards):
            self._pools.addWidget(card, i // 2, i % 2, Qt.AlignmentFlag.AlignTop)
        for join in self._join_rows():
            if join.card == focused:
                join.field.setFocus()
        self._refresh_ages()

    def _rebuild_events(self) -> None:
        _clear(self._events_col)
        events = network_events(self.store.audit_entries)
        if not events:
            self._events_col.addWidget(_note(NO_EVENTS))
        for e in events:
            self._events_col.addWidget(ActivityRow(
                glyph=activity.glyph_for(e.action),
                glyph_color=activity.color_for(e.action),
                detail=e.detail, source=e.source,
                source_color=activity.source_color(e.source),
                clock=Fmt.clock(e.date)))
