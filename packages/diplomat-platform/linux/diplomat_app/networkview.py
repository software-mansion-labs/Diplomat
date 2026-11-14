"""The Network screen, twin of the macOS one: the Diplomacy Network's switch and
daemon, how many tasks this machine takes, and one section per pool it is in with the
pool's members, its tasks and the things done to it.
"""

from __future__ import annotations

import os
import time
from collections.abc import Callable

from PySide6.QtCore import QTimer, Signal
from PySide6.QtGui import QGuiApplication
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

from diplomat_runtime import activity, network
from diplomat_runtime.models import Fmt
from . import diplomacynetwork as dn
from . import glyphs
from . import remotemachines as rm
from .devicesview import Installer, restart_button, start_button
from .machinesview import _chip, _clear, _clock, _note, _plain
from .store import NetworkCall, Store
from .widgets import (
    ActivityRow,
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

#: The most hours a task may ask for (``packages/diplomacy-network`` PROTOCOL).
HOURS_MAX = 720

OFF_NOTE = "The network is off: every job starts on this machine."
STARTING_NOTE = "Starting the network daemon…"
DOWN_NOTE = ("The network daemon is not answering, so no job can be offered. Automatic "
             "work waits in the queue until it does.")
NO_POOLS_NOTE = ("This machine is in no pool yet. One is made for each repository in "
                 "Settings once the daemon knows whose account works on it.")
NO_TASKS_NOTE = "No tasks in this pool."
LEAVE_QUESTION = ("Leave this pool? This machine stops sharing this repository's jobs "
                  "with the other members.")
INVITE_COPIED = "Invite copied to the clipboard."
JOIN_PLACEHOLDER = "Paste an invite"
RESTART_HELP = "Stop the running daemon and start this checkout's."

#: What the daemon's reason for taking nothing reads as.
_ADMIT_REASONS = {network.ADMIT_DISK: "disk", network.ADMIT_BUDGET: "budget",
                  network.ADMIT_PAUSED: "paused"}

#: A pool task's state, as its row says it. ``{where}`` is the machine running it.
_TASK_STATES = {"available": "in the pool", "claimed": "running on {where}",
                "done": "done on {where}", "cancelled": "withdrawn"}


def network_events(entries: list) -> list:
    return [e for e in entries if e.action.startswith("network-")][:8]


def admit_line(snapshot: network.Snapshot) -> str:
    """How many more tasks this machine takes, as the daemon was last told."""
    admit = snapshot.admit
    if admit.slots > 0:
        return f"taking {admit.slots} more"
    reason = _ADMIT_REASONS.get(admit.reason, admit.reason)
    return f"taking nothing: {reason or 'no free slot'}"


def service_line(state: str, detail: str) -> tuple[str, str]:
    """One of the daemon's three services: its state, with why when it is not ready."""
    if state == "ready":
        return "ready", _GREEN
    return (f"{state or 'unknown'}: {detail}" if detail else state or "unknown"), _ORANGE


def counts(snapshot: network.Snapshot) -> str:
    pools = len(snapshot.pools)
    tasks = sum(len(p.tasks) for p in snapshot.pools)
    return (f"{pools} pool{'' if pools == 1 else 's'} · "
            f"{tasks} task{'' if tasks == 1 else 's'}")


def where(executor: str, here: bool) -> str:
    return "this machine" if here else dn.short_key(executor) or "another machine"


def network_installer(store: Store) -> Installer:
    """The daemon's start and restart, for the buttons Machines draws its own with.
    This daemon has no install of its own: bringing it up and down is the switch."""
    return Installer(
        ready=dn.ready, busy=lambda: store.network_busy,
        install=store.start_network_daemon_async, uninstall=store.stop_network_async,
        start=store.start_network_daemon_async, restart=store.restart_network_async,
        recheck=store.run_network_cycle_async, restart_help=RESTART_HELP)


def _button(title: str, tint: str, tip: str = "") -> QPushButton:
    btn = QPushButton(title)
    btn.setToolTip(tip)
    btn.setStyleSheet(
        f"QPushButton {{ color: {tint}; background-color: {tint_bg(tint, 0.14)};"
        " border: none; border-radius: 5px; padding: 2px 9px; font-size: 9px;"
        " font-weight: 700; }"
        f"QPushButton:hover {{ background-color: {tint_bg(tint, 0.26)}; }}")
    return btn


# MARK: - one pool

class PoolPanel(QFrame):
    """One pool: who is in it, what it holds, and its invite and leave. ``ages`` takes
    the lines that say how long ago something was, for the screen to keep current."""

    def __init__(self, pool: network.Pool, *, store: Store, call: NetworkCall,
                 ages: list) -> None:
        super().__init__()
        self._store = store
        self._pool = pool.id
        self.actions: dict[str, QPushButton] = {}
        self.setObjectName("poolPanel")
        self.setStyleSheet("#poolPanel { background-color: rgba(128,128,128,0.08);"
                           " border-radius: 8px; }")
        col = QVBoxLayout(self)
        col.setContentsMargins(9, 8, 9, 8)
        col.setSpacing(6)

        head = QHBoxLayout()
        head.setSpacing(6)
        head.addWidget(_plain(pool.id, "font-size: 11px; font-weight: 700;"))
        if pool.identity:
            head.addWidget(_plain(f"as {pool.identity}", muted(9)))
        head.addStretch(1)
        n = len(pool.members)
        head.addWidget(_chip(f"{n} member{'' if n == 1 else 's'}", _TEAL))
        col.addLayout(head)

        col.addWidget(_plain("MEMBERS", muted(9, bold=True) + " letter-spacing: 0.5px;"))
        for member in pool.members:
            col.addLayout(self._member(member, ages))
        col.addWidget(_plain(f"TASKS · {len(pool.tasks)}",
                             muted(9, bold=True) + " letter-spacing: 0.5px;"))
        if not pool.tasks:
            col.addWidget(_note(NO_TASKS_NOTE))
        for task in pool.tasks:
            col.addLayout(self._task(task))

        mine = call if call.pool == pool.id else NetworkCall()
        actions = QHBoxLayout()
        actions.setSpacing(4)
        self.status = _note("")
        actions.addWidget(self.status, 1)
        self._add(actions, "Copy invite", _TEAL, self._invite,
                  "Make an invite to this pool and put it on the clipboard. Whoever "
                  "pastes it into their own Diplomat joins the pool.")
        self._add(actions, "Leave", _RED, self._ask_leave,
                  "Take this machine out of the pool.")
        col.addLayout(actions)

        self._confirm = QWidget(self)
        confirm = QHBoxLayout(self._confirm)
        confirm.setContentsMargins(0, 0, 0, 0)
        confirm.setSpacing(4)
        confirm.addWidget(_note(LEAVE_QUESTION, _ORANGE), 1)
        self._add(confirm, "Leave pool", _RED, self._leave)
        self._add(confirm, "Stay", _GREY, self._cancel_leave)
        self._confirm.hide()
        col.addWidget(self._confirm)

        busy = call.running
        for btn in self.actions.values():
            btn.setEnabled(not busy)
        if mine.running:
            self._say("Leaving…" if mine.kind == "leave" else "Making an invite…")
        elif mine.error:
            self._say(mine.error, _RED)
        elif mine.invite:
            self._say(INVITE_COPIED, _GREEN)

    def _say(self, text: str, tint: str | None = None) -> None:
        self.status.setText(text)
        self.status.setStyleSheet(muted(10) if tint is None
                                  else f"color: {tint}; font-size: 10px;")

    def _add(self, layout: QHBoxLayout, title: str, tint: str, slot, tip: str = "") -> None:
        btn = _button(title, tint, tip)
        btn.clicked.connect(slot)
        layout.addWidget(btn)
        self.actions[title] = btn

    def _member(self, m: network.Member, ages: list) -> QHBoxLayout:
        row = QHBoxLayout()
        row.setSpacing(6)
        up = m.reachable or m.is_self
        row.addWidget(_plain("●", f"color: {_GREEN if up else _GREY}; font-size: 8px;"))
        row.addWidget(_plain(dn.short_key(m.pk), "font-size: 10px; font-family: monospace;"))
        if m.is_self:
            row.addWidget(_chip("this machine", _TEAL))
        elif not m.reachable:
            row.addWidget(_chip("unreachable", _ORANGE))
        if m.max_accepted_h is not None:
            row.addWidget(_plain(f"takes jobs up to {m.max_accepted_h} h", muted(9)))
        row.addStretch(1)
        seen = _plain("", muted(9))
        last = m.last_seen
        if last is None:
            seen.setText("" if m.is_self else "not seen yet")
        else:
            ages.append((seen.setText, lambda now: f"seen {rm.ago(now - last)}"))
        row.addWidget(seen)
        return row

    def _task(self, t: network.PoolTask) -> QHBoxLayout:
        row = QHBoxLayout()
        row.setSpacing(6)
        row.addWidget(_plain(t.title or f"{t.kind} {t.item}".strip() or t.task_id,
                             "font-size: 10px;"), 1)
        if t.kind:
            row.addWidget(_chip(t.kind, _GREY))
        if t.offered_here:
            row.addWidget(_chip("yours", _TEAL))
        state = (_TASK_STATES[t.state].format(where=where(t.executor, t.executor_here))
                 if t.state in _TASK_STATES else t.state)
        if t.state == "claimed" and t.lease_until is not None:
            state += f" · lease until {_clock(t.lease_until)}"
        tint = _GREEN if t.state == "claimed" else None
        row.addWidget(_plain(state, muted(9) if tint is None
                             else f"color: {tint}; font-size: 9px;"))
        return row

    def _invite(self) -> None:
        self._store.network_invite_async(self._pool)

    def _ask_leave(self) -> None:
        self._confirm.show()

    def _cancel_leave(self) -> None:
        self._confirm.hide()

    def _leave(self) -> None:
        self._confirm.hide()
        self._store.network_leave_async(self._pool)


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
        #: The call whose invite is already on the clipboard, and the join whose
        #: invite has been cleared from the field.
        self._copied: NetworkCall | None = None
        self._joined: NetworkCall | None = None
        self.panels: list[PoolPanel] = []

        root = QVBoxLayout(self)
        root.setContentsMargins(0, 0, 0, 0)
        root.setSpacing(12)
        root.addLayout(self._build_header())

        self._save_error = _note("", _RED)
        self._save_error.hide()
        root.addWidget(self._save_error)

        body = QHBoxLayout()
        body.setSpacing(12)
        left = QVBoxLayout()
        card, self._pools_col, self._pools_pill = settings_card(
            glyphs.G_NETWORK, "POOLS", _TEAL)
        self._pools_col.setSpacing(8)
        left.addWidget(card)
        left.addStretch(1)
        right = QVBoxLayout()
        right.setSpacing(10)
        right.addWidget(self._build_status_card())
        events_card, self._events_col, _ = settings_card(glyphs.G_RECENT, "RECENT", _GREY)
        right.addWidget(events_card)
        right.addStretch(1)
        body.addLayout(left, 3)
        body.addLayout(right, 2)
        root.addLayout(body)
        root.addStretch(1)

        self._age_timer = QTimer(self)
        self._age_timer.setInterval(2_000)
        self._age_timer.timeout.connect(self._refresh_ages)

        store.network_changed.connect(self.rebuild)
        store.activity_changed.connect(self._rebuild_events)
        self.rebuild()

    def opened(self) -> None:
        if self.live:
            self.store.run_network_cycle_async()
            self._age_timer.start()
        self.rebuild()

    def closed(self) -> None:
        self._age_timer.stop()

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
        self._copy_invite()
        self._refresh_status()
        self._rebuild_pools()
        self._rebuild_events()

    def _copy_invite(self) -> None:
        call = self.store.network_call
        if call.invite and call is not self._copied:
            self._copied = call
            QGuiApplication.clipboard().setText(call.invite)

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

    def _daemon_light(self) -> tuple[str, str]:
        """The daemon's standing, as the header and the status card both say it."""
        store = self.store
        if not store.network_enabled:
            return _GREY, "off"
        if store.network_state is not None:
            return _GREEN, "daemon running"
        if store.network_busy or not store.network_asked:
            return _GREY, "starting"
        return _RED, "daemon not answering"

    # MARK: pools

    def _rebuild_pools(self) -> None:
        _clear(self._pools_col)
        self._pool_ages = []
        self.panels = []
        store, state = self.store, self.store.network_state
        on = store.network_enabled
        self._pools_pill.set_state(
            f"{len(state.pools)} joined" if on and state else "",
            _GREEN if on and state and state.pools else _GREY)
        if not on:
            self._pools_col.addWidget(_note(OFF_NOTE))
            return
        if state is None:
            starting = store.network_busy or not store.network_asked
            self._pools_col.addWidget(
                _note(STARTING_NOTE) if starting else _note(DOWN_NOTE, _ORANGE))
            return
        if store.network_pools_held:
            self._pools_col.addWidget(_note(
                f"The daemon was not told which repositories to share: "
                f"{store.network_pools_held}.", _ORANGE))
        if not state.pools:
            self._pools_col.addWidget(_note(NO_POOLS_NOTE))
        for pool in state.pools:
            panel = PoolPanel(pool, store=store, call=store.network_call,
                              ages=self._pool_ages)
            self.panels.append(panel)
            self._pools_col.addWidget(panel)
        self._refresh_ages()

    def _rebuild_events(self) -> None:
        _clear(self._events_col)
        events = network_events(self.store.audit_entries)
        if not events:
            self._events_col.addWidget(_note("No network events in the activity feed."))
        for e in events:
            self._events_col.addWidget(ActivityRow(
                glyph=activity.glyph_for(e.action),
                glyph_color=activity.color_for(e.action),
                detail=e.detail, source=e.source,
                source_color=activity.source_color(e.source),
                clock=Fmt.clock(e.date)))

    # MARK: status

    def _hours_box(self, slot) -> QSpinBox:
        box = QSpinBox(self)
        box.setRange(network.HOURS_FLOOR, HOURS_MAX)
        box.setSuffix(" h")
        box.setKeyboardTracking(False)
        box.valueChanged.connect(slot)
        return box

    def _build_status_card(self) -> QWidget:
        card, body, self._state_pill = settings_card(
            glyphs.G_NETWORK, "DIPLOMACY NETWORK", _TEAL)
        self.switch = SwitchToggle(_TEAL)
        self.switch.setChecked(self.store.network_enabled)
        self.switch.toggled.connect(self._on_switch)
        body.addWidget(SettingRow("Diplomacy Network", self.switch,
                                  summary=dn.SWITCH_SUMMARY))
        self._unavailable = _note("", _ORANGE)
        body.addWidget(self._unavailable)

        self._on_host = QWidget(card)
        on = QVBoxLayout(self._on_host)
        on.setContentsMargins(0, 0, 0, 0)
        on.setSpacing(9)
        self._daemon_pill = Pill("")
        self._daemon_row = SettingRow("Daemon", self._daemon_pill)
        on.addWidget(self._daemon_row)
        installer = network_installer(self.store)
        self._ready, self._busy = installer.ready, installer.busy
        self.start = start_button(self.store, installer)
        self.restart = restart_button(self.store, installer)
        buttons = QHBoxLayout()
        buttons.addWidget(self.start)
        buttons.addWidget(self.restart)
        buttons.addStretch(1)
        on.addLayout(buttons)

        facts = QGridLayout()
        facts.setHorizontalSpacing(10)
        facts.setVerticalSpacing(3)
        self._facts: dict[str, QLabel] = {}
        for line, key in enumerate(("Transport", "Docker", "Model", "This machine",
                                    "Address", "Tasks")):
            facts.addWidget(_plain(key, muted(10)), line, 0)
            value = _plain("", "font-size: 10px;")
            value.setWordWrap(True)
            facts.addWidget(value, line, 1)
            self._facts[key] = value
        facts.setColumnStretch(1, 1)
        self._facts_host = QWidget(self._on_host)
        self._facts_host.setLayout(facts)
        facts.setContentsMargins(0, 0, 0, 0)
        on.addWidget(self._facts_host)
        self._error = _note("", _ORANGE)
        on.addWidget(self._error)

        self.required_h = self._hours_box(self._on_required_h)
        on.addWidget(SettingRow(
            "Hours a job of yours may take", self.required_h,
            summary="Asked of whichever machine takes a job this one offers."))
        self.accepted_h = self._hours_box(self._on_accepted_h)
        on.addWidget(SettingRow(
            "Longest job this machine takes", self.accepted_h,
            summary="A job that asks for more hours is left to the other machines."))

        self._join_row = QWidget(self._on_host)
        join = QVBoxLayout(self._join_row)
        join.setContentsMargins(0, 0, 0, 0)
        join.setSpacing(4)
        line = QHBoxLayout()
        self.join_field = QLineEdit(self._join_row)
        self.join_field.setPlaceholderText(JOIN_PLACEHOLDER)
        self.join_field.setAccessibleName("Invite")
        self.join_field.returnPressed.connect(self._join)
        line.addWidget(self.join_field, 1)
        self.join = QPushButton("Join…")
        self.join.setToolTip("Join the pool an invite from another machine names.")
        self.join.clicked.connect(self._join)
        line.addWidget(self.join)
        join.addLayout(line)
        self._join_status = _note("")
        join.addWidget(self._join_status)
        on.addWidget(self._join_row)
        body.addWidget(self._on_host)
        return card

    def _sync_hours(self) -> None:
        """The two hours as the shared config has them, without writing them back."""
        for box, value in ((self.required_h, dn.required_minimum_h()),
                           (self.accepted_h, dn.maximum_accepted_h())):
            if box.value() != value and not box.hasFocus():
                box.blockSignals(True)
                box.setValue(value)
                box.blockSignals(False)

    def _refresh_status(self) -> None:
        store, state = self.store, self.store.network_state
        on = store.network_enabled
        self.switch.setChecked(on)
        color, label = self._daemon_light()
        self._dot.setStyleSheet(f"color: {color}; font-size: 9px;")
        self._light.setText(label)
        self._state_pill.set_state("on" if on else "off", _GREEN if on else _GREY)
        self._counts.setText(counts(state) if on and state else "")
        unavailable = dn.unavailable_summary() if on else None
        self._unavailable.setText(unavailable or "")
        self._unavailable.setVisible(bool(unavailable))
        self._on_host.setVisible(on)
        if not on:
            return
        self._sync_hours()
        self._daemon_pill.set_state(label, color)
        self._ages = []
        usable = self._ready() and not self._busy()
        self.start.setVisible(state is None)
        self.start.setEnabled(usable)
        self.restart.setEnabled(usable)
        self._facts_host.setVisible(state is not None)
        self._join_row.setVisible(state is not None)
        if state is None:
            starting = store.network_busy or not store.network_asked
            self._daemon_row.set_summary(STARTING_NOTE if starting
                                         else "The network daemon is not answering.")
        else:
            pid = f"pid {state.pid}" if state.pid is not None else "running"
            started = state.started_at
            self._ages.append((self._daemon_row.set_summary, lambda now: (
                f"{pid} · started {rm.ago(now - started)}" if started is not None else pid)))
            for key, (text, tint) in (
                    ("Transport", service_line(state.transport.state, state.transport.detail)),
                    ("Docker", service_line(state.docker.state, state.docker.detail)),
                    ("Model", service_line(state.model.state, state.model.detail))):
                self._facts[key].setText(text)
                self._facts[key].setStyleSheet(f"color: {tint}; font-size: 10px;")
            self._facts["This machine"].setText(dn.short_key(state.pk) or "-")
            self._facts["Address"].setText(state.onion or "-")
            self._facts["Tasks"].setText(admit_line(state))
        self._error.setText(store.network_error)
        self._error.setVisible(bool(store.network_error))

        call = store.network_call
        joining = call.kind == "join"
        self.join.setEnabled(not call.running)
        self.join_field.setEnabled(not call.running)
        if joining and call.running:
            self._say_join("Joining…")
        elif joining and call.error:
            self._say_join(call.error, _RED)
        elif joining:
            if call is not self._joined:
                self._joined = call
                self.join_field.clear()
            self._say_join(f"Joined {call.pool}." if call.pool else "Joined.", _GREEN)
        else:
            self._say_join("")
        self._refresh_ages()

    def _say_join(self, text: str, tint: str | None = None) -> None:
        self._join_status.setText(text)
        self._join_status.setVisible(bool(text))
        self._join_status.setStyleSheet(muted(10) if tint is None
                                        else f"color: {tint}; font-size: 10px;")

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

    def _join(self) -> None:
        invite = self.join_field.text().strip()
        if invite:
            self.store.network_join_async(invite)
