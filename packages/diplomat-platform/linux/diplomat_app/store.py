"""Application state, persisted settings, and the tool catalog.

A port of Store.swift. The tool catalog (titles, subtitles, colours, order) is
loaded from the shared ``assets/catalog.json``; the row-mapping in ``items_for``
is the same dense formatting the macOS panel renders. Settings persist via
``QSettings`` (the Linux analogue of macOS UserDefaults) - except the handful that
live in the shared ``~/.diplomat/config.json`` (see :mod:`appconfig`).
"""

from __future__ import annotations

import dataclasses
from dataclasses import dataclass
from datetime import datetime, timezone

from PySide6.QtCore import QObject, QSettings, Signal

import json
import os
import subprocess
import tempfile
import threading
import time
import urllib.parse
from collections.abc import Callable
from pathlib import Path

from diplomat_runtime import (
    activity,
    agentregistry,
    agentstate,
    apiwatch,
    appconfig,
    autobudget,
    autofix,
    comms,
    core,
    diskfloor,
    localrepos,
    network,
    opencodeapi,
    pipeline,
    promptcore,
    review,
    reviewaudit,
    runner,
    telemetry,
    tmuxwatch,
)
from diplomat_runtime.gh import GHError
from diplomat_runtime.models import API, Filters, Fmt, OpenIssue, OpenPR
from diplomat_runtime.prref import (LocalRepo, item_key, item_key_from_url, item_label,
                                    migrate_item_key, migrate_queue_key, repo_of_key,
                                    root_named, split_item_key)
from diplomat_runtime.prtarget import PRTarget
from . import (
    autofixmonitor,
    bans,
    conflicts,
    deviceallocator,
    diplomacynetwork,
    headless,
    issues,
    probes,
    remotemachines,
)

#: The review-request monitor's verb.
REVIEW_REQ_ACTION = "review-req"
#: The ``AgentJob.counter`` of the Pipeline's asks, which its master switch pauses.
PIPELINE_COUNTER = "pipeline"
#: The Pipeline's attempt records, by ``PipelineEffect.key``.
PIPELINE_ATTEMPTS = "pipelineAttempts"
#: The only review a PR gets before the pipeline may merge it. Twin of
#: ``Store.pipelineReviewDepth``.
PIPELINE_REVIEW_DEPTH = "max"
GITHUB_LOGIN_UNKNOWN = "GitHub login unknown — is `gh` installed and authenticated?"


def app_settings() -> QSettings:
    """This front-end's own preference store, the Linux analogue of UserDefaults.

    Built on the process-wide default format rather than with the two-arg
    ``QSettings(org, app)``, which is hardwired to NativeFormat - on macOS that ignores
    ``QSettings.setPath``, so the test suite could not redirect it and would read and
    write the real user settings.
    """
    return QSettings(QSettings.defaultFormat(), QSettings.Scope.UserScope,
                     "diplomat", "diplomat")


def _count(n: int, noun: str) -> str:
    """``3 files`` / ``1 file`` — the pluralisation two row builders share."""
    return f"{n} {noun}" if n == 1 else f"{n} {noun}s"


def _undecided_merge_request(snap, lab: set[str]) -> bool:
    """An undecided merge status on a root of ``lab`` (GitLab roots' keys). After a push to
    the target GitLab leaves it unchecked until asked, so it may still conflict, and a
    conflict fix queued for it stands."""
    return snap.mergeable == "UNKNOWN" and (snap.item or "").partition("#")[0] in lab


def _installer_files(pr: OpenPR) -> list[str]:
    """The installer-owned paths in a PR — counted in line2 and listed in line3,
    so they must be the same set in both."""
    return [f for f in pr.files if Filters.is_installer_file(f)]


def _run_prompt(run_id: str) -> str:
    """What a run was asked — the string :func:`usagescan.task_run` matches
    transcripts against. Empty when the run directory is gone, which prices the run
    as unattributed rather than as some other agent's transcript."""
    try:
        return agentregistry.prompt_path(run_id).read_text(encoding="utf-8")
    except OSError:
        return ""


# MARK: - Value types


@dataclass(frozen=True)
class DisplayItem:
    id: int
    badge: str  # "#337"
    title: str
    url: str
    line2: str  # primary metadata
    line3: str | None = None  # optional detail (skills / files / labels)


@dataclass(frozen=True)
class Tool:
    """One entry in the tool library, hydrated from assets/catalog.json."""

    id: str
    title: str
    subtitle: str
    emoji: str
    glyph: str
    color_hex: str


@dataclass(frozen=True)
class LookupResult:
    number: int
    on_lists: list[str]  # tool ids
    presence: str
    url: str | None

    @property
    def is_on_any_list(self) -> bool:
        return bool(self.on_lists)


def tools() -> list[Tool]:
    return [
        Tool(
            id=t["id"],
            title=t["title"],
            subtitle=t["subtitle"],
            emoji=t["emoji"],
            glyph=t.get("linuxGlyph", t["emoji"]),
            color_hex=t["colorHex"],
        )
        for t in core.catalog()
    ]


def tool_by_id(tool_id: str) -> Tool | None:
    return next((t for t in tools() if t.id == tool_id), None)


class _InstallerGate:
    """One Node installer's actions (install, uninstall, start, restart). One runs at
    a time, the screens offer no other meanwhile, and a ``--check`` that overlaps one
    is dropped: mid-restart no daemon answers, which would read as one to start."""

    def __init__(self) -> None:
        self.busy = False
        #: Counts the actions, so a ``--check`` can tell that one ran while it did.
        self.actions = 0
        self.lock = threading.Lock()


@dataclass(frozen=True)
class NetworkRun(autofix.RunningAgent):
    """A network run as the panel draws it, with the run its row acts on and the
    daemon's task id."""

    run_id: str = ""
    task: str = ""


@dataclass
class _NetworkCycle:
    """What the network cycle remembers between turns (macOS twin: ``NetworkCycle``)."""

    #: The daemon (pid and start time) the posts below went to; a new one heard none.
    daemon: str = ""
    pools: list[dict] | None = None
    #: The refused list, its sentence and when: re-said unchanged only as often as
    #: ``admit``.
    pools_refused: list[dict] | None = None
    pools_refusal: str = ""
    pools_refused_at: float = 0.0
    admit: network.Admit | None = None
    admit_at: float = 0.0
    #: When a silent daemon may next be started, and the backoff after that.
    start_after: float = 0.0
    start_delay: float = 0.0
    #: Whether the feed has said a start failed, for the current silence.
    start_failure_logged: bool = False


@dataclass(frozen=True)
class NetworkOffering:
    """An operator's job whose offer got no definite answer (macOS twin:
    ``Store.OfferingJob``)."""

    job: autofix.AgentJob
    source: str
    row_label: str
    offer: network.Offer

    @property
    def key(self) -> tuple[str, str, str]:
        """What the daemon names its task by."""
        return self.offer.pool, self.offer.kind, self.offer.item


@dataclass(frozen=True)
class RemoteCall:
    """A remote-pool call: idle, running, or its last ``reply`` and when (``at``,
    epoch seconds)."""

    running: bool = False
    reply: deviceallocator.RemoteReply | None = None
    at: float | None = None


# MARK: - Store


class Store(QObject):
    # Emitted (on the main thread) whenever the rendered data/settings change.
    changed = Signal()
    # Emitted with the loading flag when a refresh starts/ends.
    loading_changed = Signal(bool)
    # Emitted when the device-allocator pool snapshot changes (light, not a full
    # data refresh) and when its install status is re-checked.
    devices_changed = Signal()
    allocator_changed = Signal()
    # Emitted when one of the Devices screen's two remote-pool calls starts or answers.
    remote_changed = Signal()
    # Emitted by reload_device_config.
    device_config_reloaded = Signal()
    # The remote-machines snapshot or history changed; its install status changed, or
    # a scan started or ended.
    machines_changed = Signal()
    machines_install_changed = Signal()
    #: The network's switch, daemon or snapshot moved, or the daemon refused a screen
    #: action.
    network_changed = Signal()
    #: An invite the daemon made: the pool, and the invite for the clipboard.
    network_invited = Signal(str, str)
    #: A join the daemon answered: the panel the invite was pasted into, and whether
    #: it took it.
    network_joined = Signal(str, bool)
    # Emitted when the activity feed (audit.jsonl) or ban list snapshot changes.
    activity_changed = Signal()
    # Emitted when the self-update status/progress changes.
    update_changed = Signal()
    # Emitted after each PR auto-fix monitor poll (status pill, counts, poll error).
    autofix_changed = Signal()
    # Emitted as each monitor poll starts, whatever started it: the poll timer runs
    # from here, so a poll brought forward moves the next periodic one back.
    autofix_poll_started = Signal()
    # Emitted when the Agent-tasks list changes: the queue behind the automatic-task
    # cap, or how many slots of that cap are standing empty.
    tasks_changed = Signal()
    # Emitted after each Claude-API-error watcher scan (status pill + continue count).
    apiwatch_changed = Signal()
    # Emitted when a telemetry sample lands, so an open Telemetry screen refreshes
    # instead of waiting for the user to flip a range.
    telemetry_changed = Signal()
    # Emitted when anything the Comms screen draws changes.
    comms_changed = Signal()
    # New pings while `comms_notify` is on: (title, body) for app.py, which owns the tray.
    comms_pinged = Signal(str, str)
    # A ban that was not on the list at the last read: (title, body) for the tray.
    ban_noticed = Signal(str, str)
    # A tick's findings, handed to the Qt thread, where the queue is changed.
    _comms_ticked = Signal(object)
    pipeline_changed = Signal()
    # A Pipeline sync's answer, handed to the Qt thread, where the queue is changed.
    _pipeline_synced = Signal(object)
    # Emitted once the Qt thread has applied a sync's answer.
    pipeline_sync_applied = Signal()
    # Emitted when the repo roots or the other checkouts listed in Settings change, so
    # the wizards re-judge a link they are already holding and the header re-lists.
    local_repos_changed = Signal()
    selected_repo_changed = Signal()

    # How many agent screens must be read without once showing the CLI's interrupt
    # hint before that is worth reporting. High, because a quiet machine legitimately
    # produces the same reading: every agent really can be sitting at its prompt.
    _MARKER_SAMPLE = 40

    # How many quota probe rounds must come back empty before a blind budget gate is
    # worth reporting. Low, because unlike ``_MARKER_SAMPLE`` there is no innocent
    # machine that produces this reading: a probe that is switched off or logged out
    # never rounds at all, so every round counted here is one that asked and was
    # refused.
    _QUOTA_SAMPLE = 20

    def __init__(self) -> None:
        super().__init__()
        self.prs: list[OpenPR] = []
        self.issues: list[OpenIssue] = []
        self.is_loading = False
        self.error: str | None = None
        self.last_updated: datetime | None = None
        self.selected: str = tools()[0].id
        self.has_loaded = False
        self.me = ""
        # Per GitLab host: glab's login and the glab config entry it was read under
        # (:meth:`me_for`).
        self._gitlab_me: dict[str, tuple[str, str | None]] = {}

        # Live device-allocator state (pool + holders) and install status.
        self.device_state: dict | None = None
        self.allocator_install: dict | None = None
        self._allocator_gate = _InstallerGate()
        # The remote-machines daemon's snapshot and history, its install status, and
        # whether a scan the Machines screen asked for is under way.
        self.machines_state: remotemachines.Snapshot | None = None
        self.machines_history: remotemachines.History | None = None
        self._machines_history_stamp: float | None = None
        self.machines_install: dict | None = None
        self._machines_gate = _InstallerGate()
        self.machines_scanning = False
        # The Diplomacy Network daemon's last snapshot: None while it does not answer
        # or the switch is off. Replaced, never mutated.
        self.network_state: network.Snapshot | None = None
        # Whether the daemon answered when it was last asked; None until it has been.
        self.network_answered: bool | None = None
        # The daemon's refusal of the Network screen's last action, by pool panel ("" for
        # the one before any pool).
        self.network_refusals: dict[str, str] = {}
        # What of this machine's pools could not be confirmed (network.pools_listing),
        # and the daemon's refusal of the list, a line each; "" for neither.
        self.network_pools_held = ""
        # The operator's jobs whose offer the daemon was sent and did not settle
        # (_settle_offering). Replaced under its lock, never mutated.
        self.network_offering: list[NetworkOffering] = []
        self._network_offering_lock = threading.Lock()
        # Held for a start, restart or stop of the daemon: one at a time.
        self._network_lifecycle = threading.Lock()
        self._network_cycle_lock = threading.Lock()
        self._network_memo = _NetworkCycle()
        # When each GitLab host's login was last asked for and not learned.
        self._network_login_asked: dict[str, float] = {}
        # The offers whose claim the activity feed has named.
        self._network_claims_logged: set[str] = set()
        # The feed has said the network refuses automatic work, this spell.
        self._network_unavailable_logged = False
        # The feed has said the shared config cannot be read, this spell.
        self._config_unreadable_logged = False
        # The configs forgotten as gone the feed has said (:func:`appconfig.forgotten_configs`).
        self._config_gone_logged = appconfig.forgotten_configs()
        # The switch as the views last drew it.
        self._switch_drawn: bool | None = None
        # By job label: why the network refused a queued job for a reason of its own,
        # as its row and the feed say it.
        self.network_job_refusals: dict[str, str] = {}
        # The Devices screen's two remote-pool calls. Here, not on the screen: a
        # sign-in runs for up to ten minutes and must outlive the screen being closed.
        self.remote_sign_in = RemoteCall()
        self.remote_listing = RemoteCall()
        # The provider path a headless run was given, which it must not persist.
        self._remote_provider_unsaved: str | None = None

        # Live telemetry read from the shared ~/.diplomat files (activity feed + bans).
        self.audit_entries: list = []
        self.banned_authors: list = []
        # banned.json is present but unreadable, as the last read found it: the Pipeline
        # then acts on nothing, as its sync does (``PipelineTick.bannedLogins``).
        self.ban_list_unreadable = False
        # The (login, at) of every ban the last read held; None until the first read,
        # whose bans were there before this launch and are not news.
        self._bans_known: set[tuple[str, str]] | None = None
        # Logins whose bans are never news: see :meth:`_comms_report_ban`.
        self._bans_quiet: set[str] = set()
        self._bans_known_lock = threading.Lock()

        # Self-update progress for the Settings UPDATE section. None until the
        # first check; then {"phase": "checking"|"idle"|"updating"|"restarting"
        # |"error", ...} — "idle" carries the selfupdate.check() result,
        # "updating" a human-readable "step", "error" the failure reason.
        self.update_state: dict | None = None

        # PR auto-fix monitor: live-only runtime state (the toggles/counters persist
        # via QSettings below). Mirrors AutofixStatus.swift + the monitor's poll-error
        # + unaddressed-review signals.
        self.autofix_status: dict | None = None
        self.autofix_poll_error: str | None = None
        self.autofix_poll_error_at: float | None = None
        self.unaddressed_reviews = 0
        self._poll_error_this_cycle: str | None = None
        #: ``"<what>:<root key>"`` of each root read that failed last time
        #: (:meth:`_note_roots_read`).
        self._roots_unread: set[str] = set()
        #: Keys of the roots this cycle's read of my PRs or of review requests failed in.
        self._held_keys: frozenset[str] = frozenset()
        # The last resolved tick — what every agent question is answered from (the
        # dedup, the cap, the rows, the retirement). None until the first one.
        # Replaced, never mutated: the poll worker writes it while the GUI thread
        # draws from it. Its own short mutex guards the swap and the cache stamp.
        self._tick: agentstate.Tick | None = None
        self._tick_lock = threading.Lock()
        # What the last merged-status probe found. It costs a `gh` or `glab` call per PR, so it
        # rides the slow refresh rather than the 8-second tick, and the fast ticks
        # carry the answer forward (UNAVAILABLE until the first one runs).
        self._merged_prs = agentstate.Observation.unavailable(
            "have not been probed yet")
        # And the same for the token-budget reading, which rides the same slow refresh.
        self._tokens_left = agentstate.Observation.unavailable(
            "has not been probed yet")
        # Which probes have already been reported silent, so the feed gets one line
        # per episode rather than one per tick, and another when they come back.
        self._probe_warned: dict[str, bool] = {}
        self._marker_warned = False
        self._quota_warned = False
        # Why the run book stopped taking writes, for one line per episode; "" while
        # it takes them (see _write_book).
        self._book_error = ""
        # Whether the spawn terminal still has to reach the shared config.
        self._terminal_unpublished = False
        # Whether the "deferring auto work" note has been logged for the current
        # at-capacity episode (see _log_at_capacity), and for the current
        # out-of-budget one (see _log_unaffordable). Two flags, not one: a machine
        # can saturate and drain several times over inside a single spell of having
        # nothing left to spend, and each episode is worth one line of its own.
        # The low-disk one (see _log_low_disk) is a third for the same reason.
        self._capacity_logged = False
        self._budget_logged = False
        self._disk_logged = False
        # Automatic work nothing has started yet — held by the task cap, by the
        # free-disk floor, by the spending budget, or by its own monitor being
        # switched off — in the order
        # it will run. The panel's Agent-tasks list.
        #
        # Deliberately NOT persisted. A deferral writes no attempt record precisely so
        # that every poll re-offers everything GitHub still owes, which means the queue
        # is rebuilt from live evidence every 3 minutes; a stored copy would only ever
        # be a staler answer to a question already being re-asked, and would hand
        # "execute now" a prompt assembled against a PR that has since moved on. What
        # IS persisted is `queued_task_order` — the operator's arrangement — and
        # `requested_work`, the sweeps the operator asked for, both being things a
        # poll cannot reconstruct. Always REPLACED, never mutated in place: the poll
        # worker writes it while the GUI thread reads it to draw the rows.
        self.queued_tasks: list[autofix.QueuedTask] = []
        # Queued work whose dispatch is under way: it has left the queue and its spawn
        # has not answered yet.
        #
        # That span is seconds long - a `ps` scan, a terminal - and for all of it the
        # task is neither queued nor yet an agent this panel counts. It is held here so
        # that it stays a ROW throughout, saying what the click just did to it, rather
        # than a gap where the operator's task used to be. In memory only, like the
        # queue it comes from. Replaced, never mutated: the worker thread writes it
        # while the GUI thread draws from it.
        self.starting_tasks: list[autofix.QueuedTask] = []
        # This poll's deferrals, published as `queued_tasks` only once the whole cycle
        # has succeeded: a failed fetch means "we no longer know what is owed", which
        # is not the same as "nothing is owed", and must not empty the list.
        self._staged_queue: list[autofix.QueuedTask] = []
        # Memo of :meth:`_requested_task` by queue key: ((config, label, checkout), task).
        self._requested_tasks: dict[str, tuple[tuple, autofix.QueuedTask]] = {}
        # Asks already reported as un-assemblable, so the poll says it once rather
        # than every cycle for as long as the ask stands (:meth:`_note_unbuildable_ask`).
        self._unbuildable_logged: set[str] = set()
        # Serializes the read-modify-write of the stored asks. Three threads reach it:
        # the fan-out worker adding a sweep's, the poll worker dropping the one it
        # just dispatched, and the GUI thread cancelling a row. Unguarded, a sweep that
        # read the list before a dispatch removed an entry would write that entry back,
        # and the item would be worked twice.
        self._requested_lock = threading.RLock()
        # Guards the _dispatching_prs set (below). MUST stay distinct from the
        # poll-overlap guard: run_autofix_poll_async holds that one across the whole
        # worker, and the worker's dispatch_agent re-takes THIS one — sharing a single
        # non-reentrant lock across both self-deadlocks the worker (it would re-acquire
        # a lock it already holds).
        self._autofix_lock = threading.Lock()
        # Serializes autofix polls so two never overlap. Acquired in the caller
        # thread and released by the worker (see run_autofix_poll_async), so it must
        # be a plain Lock (cross-thread release), never nested with _autofix_lock.
        self._poll_lock = threading.Lock()
        # When the last poll started (time.monotonic()), whatever started it.
        self._autofix_poll_started: float | None = None
        # Whether a freed bay or a fresh ask brings the next poll forward
        # (:meth:`_bring_poll_forward`). Off unless the app's poll timer is running.
        self.polls_early = False
        # The least time from one poll's start to a poll brought forward. A poll is 17
        # GraphQL points (monitor-prs 12, issues 3, closed-prs 1, review-requests 1),
        # so one a minute is ~1000 of the 5000 an hour, beside the slow refresh's ~700.
        self.early_poll_floor = 60.0
        # The poll brought forward and not yet started, and its guard.
        self._early_poll: threading.Timer | None = None
        self._early_poll_lock = threading.Lock()
        # The bays held as of the last settle: a settle that finds fewer freed one.
        self._settled_load = 0
        # One settle at a time: the poll and the panel's refresh both retire, price
        # and audit what a tick found, and two at once did it twice.
        self._settle_lock = threading.Lock()
        # Item keys of PRs with a dispatch_agent call in flight - a click and an
        # overlapping poll can't race two spawns onto one PR. Guarded by its own
        # short mutex: _autofix_lock is the whole-poll overlap guard (held for the
        # entire poll by run_autofix_poll_async), and a poll reaches dispatch_agent
        # while holding it - reusing that non-reentrant lock here would self-deadlock.
        self._dispatching_prs: set[str] = set()
        self._dispatching_lock = threading.Lock()

        # Claude-API-error watcher: live-only runtime state (the toggle/count persist
        # via QSettings below). Mirrors the per-tty backoff + idle-confirmation maps in
        # Store.swift, keyed by tmux pane_id.
        self.apiwatch_status: dict | None = None
        self._apiwatch_backoff: dict[str, dict] = {}  # pane_id -> {nextAllowed, interval}
        self._apiwatch_seen_tail: dict[str, str] = {}  # pane_id -> last erroring tail
        self._apiwatch_lock = threading.Lock()
        self._telemetry_sample_lock = threading.Lock()

        # Comms. `comms_items` is `diplomat-core comms-feed`'s last answer, newest ping
        # first; replaced, never mutated, since the poll worker reads it.
        self.comms_items: list[dict] = []
        self.comms_error: str | None = None
        # Who Claude Code's Slack login is, as the last tick to know said; None before.
        self.comms_identity: dict | None = None
        self.comms_last_poll: datetime | None = None
        # Queue key -> ids of the pings awaiting that work's dispatch, which writes their
        # `started` lines. Replaced, never mutated: the drain reads it from the poll worker.
        self._comms_owned: dict[str, frozenset[str]] = {}
        # Held over each log read plus the assignment of its fold, and over an ask taking
        # its owner and writing its `action` line: a worker thread's read from before a
        # ping's line must not land after it and drop that ping's ownership.
        self._comms_feed_lock = threading.RLock()
        self._comms_lock = threading.Lock()
        # Ids of the pings a worker's plan carries until the Qt thread has applied it:
        # logged with no action meanwhile, they are not stranded. Under the feed lock.
        self._comms_in_flight: frozenset[str] = frozenset()
        # The monitor finds a ping took as its ask, by queue key
        # (:meth:`_comms_kept_adopted`).
        self._comms_adopted: dict[str, autofix.QueuedTask] = {}
        self._comms_ticked.connect(self._apply_comms_tick)

        # The Pipeline. `pipeline_result` is the last `PipelineTickResult` (a sync's, or
        # `pipeline-last`'s before the first); replaced, never mutated.
        self.pipeline_result: dict | None = None
        # Why the last sync could not run; None once one did.
        self.pipeline_error: str | None = None
        self.pipeline_syncing = False
        # Over the flags and the force sets below, never over a CLI call.
        self._pipeline_lock = threading.Lock()
        # Over a control.json write and the switches it reads: the Qt thread's switches and
        # a sync's worker both write it, so the last write has the latest.
        self._control_lock = threading.Lock()
        # A sync asked for while one runs (:meth:`run_pipeline_sync_async`).
        self._pipeline_again = False
        # Called once the syncs running end (:meth:`run_pipeline_sync_async`).
        self._pipeline_then: list = []
        # The running sync's core, and whether syncing has stopped for good
        # (:meth:`stop_pipeline_sync`).
        self._pipeline_proc: subprocess.Popen | None = None
        self._pipeline_stopped = False
        # The running Linear sign-in's core (:meth:`linear_login`).
        self._linear_login_proc: subprocess.Popen | None = None
        # Item ids the screen asked to rate or fracture ahead of every limit, until a
        # sync that was handed them answers.
        self._pipeline_force: dict[str, frozenset[str]] = {"rate": frozenset(),
                                                           "fracture": frozenset()}
        # Bumped as the master switch flips or Fix / Fast track goes off: a sync begun
        # before may have been switched off midway, emitting less than it owes, so its
        # result withdraws and prunes nothing (:meth:`_apply_pipeline_sync`).
        self._pipeline_epoch = 0
        # A sync begun since launch or the master switch went on was applied: until then
        # each pipeline ask queued is stale (:attr:`_pipeline_stale`).
        self._pipeline_judged = False
        # The keys of the pipeline asks queued before that sync, each until a sync begun
        # since judged its item (:func:`pipeline.judged`): till then it may be stale, so it
        # does not start (:meth:`is_held`). Filled once the stored asks can be read.
        self._pipeline_stale: set[str] = set()
        self._pipeline_synced.connect(self._apply_pipeline_sync)

        # Pruned on every start — a Store outlives thousands of polls.
        self._workers: list[threading.Thread] = []
        self._workers_lock = threading.Lock()

        self._settings = app_settings()
        self._pipeline_stale = {w.key for w in self.requested_work if w.pipeline}
        # The checkouts behind `other_repo_paths`, resolved on first read and again
        # whenever the list is set: each is a `git` call, and the wizards read this on
        # every keystroke.
        self._local_checkouts: list[localrepos.Checkout] | None = None
        # The panel's last fetch of each repo root, by its key, so switching the
        # header's picker shows that root's lists at once while they refresh.
        self._panel_data: dict[str, tuple[list[OpenPR], list[OpenIssue], datetime]] = {}
        # The root whose lists `prs`/`issues` hold; None before any was shown.
        self._shown_key: str | None = None
        # The roots as :meth:`_follow_roots` last saw them resolved.
        self._seen_roots: list[tuple[str, str]] | None = None
        review.follow_roots(self._follow_roots)

        # Re-point a hidden default selection.
        if self.selected in self.hidden_tools:
            vis = self.visible_tools
            if vis:
                self.selected = vis[0].id

    # MARK: background work

    def start_background(self, work, name: str | None = None) -> threading.Thread:
        """Run ``work`` off the GUI thread, on a worker the process can wait for.

        These workers signal back into Qt when they are done, so one still in flight
        while the process tears its widgets down raises ``RuntimeError: Signal source
        has been deleted`` there. An unhandled exception on a thread prints a
        traceback to ``sys.stderr``, and an interpreter already finalising cannot take
        the buffer lock the worker is holding to write it — so the process dies of
        SIGABRT rather than exiting. Hence the handle: :meth:`wait_for_background` is
        where a caller about to end the process lets them land first.

        Daemon, still: the wait is bounded and a wedged worker must never be able to
        hold the applet open past it.
        """
        thread = threading.Thread(target=work, daemon=True, name=name)
        with self._workers_lock:
            self._workers = [t for t in self._workers if t.is_alive()]
            self._workers.append(thread)
            thread.start()
        return thread

    def wait_for_background(self, timeout: float = 5.0) -> list[str]:
        """Wait out the workers :meth:`start_background` started, and name the ones
        still running when ``timeout`` is spent.

        Best effort by construction, so the return value is the caller's evidence of
        what it is leaving behind rather than a promise there is nothing.
        """
        deadline = time.monotonic() + timeout
        with self._workers_lock:
            pending = list(self._workers)
        for thread in pending:
            thread.join(max(0.0, deadline - time.monotonic()))
        return [t.name for t in pending if t.is_alive()]

    # MARK: persisted settings

    @property
    def username_override(self) -> str:
        return self._settings.value("usernameOverride", "", str)

    @username_override.setter
    def username_override(self, value: str) -> None:
        self._settings.setValue("usernameOverride", value)

    @property
    def hidden_tools(self) -> set[str]:
        # SKILL.md + Installer/CLI tools ship hidden (absent key => default); any
        # Settings toggle persists the explicit set from then on.
        if not self._settings.contains("hiddenTools"):
            return {"skillPRs", "installerPRs"}
        raw = self._settings.value("hiddenTools", [], list) or []
        return set(raw)

    @hidden_tools.setter
    def hidden_tools(self, value: set[str]) -> None:
        self._settings.setValue("hiddenTools", list(value))

    @property
    def color_overrides(self) -> dict[str, str]:
        raw = self._settings.value("colorOverrides", {}) or {}
        return dict(raw)

    @color_overrides.setter
    def color_overrides(self, value: dict[str, str]) -> None:
        self._settings.setValue("colorOverrides", value)

    @property
    def terminal_choice(self) -> str:
        return self._settings.value("terminalChoice", review.default_terminal().key, str)

    @terminal_choice.setter
    def terminal_choice(self, value: str) -> None:
        self._settings.setValue("terminalChoice", value)
        self.publish_spawn_terminal()

    def publish_spawn_terminal(self) -> None:
        """Hand the allocator daemon the terminal a spawn would open
        (:data:`appconfig.SPAWN_TERMINAL`). Resolved, because the daemon cannot tell
        an installed terminal from a stale choice. One the disk refused is published
        again by the next monitor poll."""
        try:
            appconfig.set_value(appconfig.SPAWN_TERMINAL,
                                review.resolved(self.terminal).key)
        except OSError:
            self._terminal_unpublished = True
        else:
            self._terminal_unpublished = False

    @property
    def repo_root_paths(self) -> list[str]:
        """The repo roots picked in Settings → REPO ROOTS, primary first: every
        automatic job runs across all of them. None => ``review.default_repo_path()``;
        ``DIPLOMAT_REPO`` outranks both. Stored raw (a typed ``~/…`` is expanded at
        use) so each row shows back exactly what was entered.

        Not in QSettings: the spawner reads it Qt-free (:mod:`appconfig`)."""
        return appconfig.repo_roots()

    @repo_root_paths.setter
    def repo_root_paths(self, value: list[str]) -> None:
        appconfig.set_repo_roots(list(value))
        self._seen_roots = None  # Settings redraws every path, resolved or not.
        self._follow_roots()

    def _follow_roots(self) -> None:
        """Follow a change in the resolved roots with the picker and the panel lists:
        an edit in Settings, or a re-read (:data:`review.ROOTS_TTL`) that finds a root
        path resolving differently (:func:`review.follow_roots`), as soon as either
        happens. Until then a sweep or a wizard would read one root's lists as another's."""
        seen = [(r.key, r.path) for r in review.repo_roots()]
        if seen == self._seen_roots:
            return
        self._seen_roots = seen
        self.local_repos_changed.emit()
        # The lists on screen were of a root no longer among them, or of the primary
        # standing in for the selected one.
        if self._shown_key not in (None, self.selected_repo.key):
            self._show_panel_data(self.selected_repo)
            self.selected_repo_changed.emit()
            self.changed.emit()

    @staticmethod
    def _primary() -> LocalRepo:
        return review.repo_roots()[0]

    @staticmethod
    def _root_named(item: str | None) -> LocalRepo | None:
        """The repo root an item key (or root key) is in, or ``None``. A monitor dispatch
        of an item in none is skipped: that number in the primary is another PR."""
        key = (item or "").partition("#")[0].lower()
        return next((r for r in review.repo_roots() if r.key == key), None)

    @staticmethod
    def _root_of(item: str | None) -> LocalRepo:
        return Store._root_named(item) or review.repo_roots()[0]

    @property
    def selected_repo(self) -> LocalRepo:
        """The repo root the panel's right column and the Pipeline screen work on (the
        header's picker): its lists, lookup, sweeps and wizards. The stored ``selectedRepo``
        root key, or the primary when that is no root any more."""
        want = str(self._settings.value("selectedRepo", "", str)).lower()
        roots = review.repo_roots()
        return next((r for r in roots if r.key == want), roots[0])

    def select_repo(self, key: str) -> None:
        """Point the right column at another root, showing its last fetch at once; the
        caller asks for the refresh (:meth:`refresh`)."""
        self._settings.setValue("selectedRepo", key.lower())
        self._show_panel_data(self.selected_repo)
        self.selected_repo_changed.emit()
        self.changed.emit()

    def _show_panel_data(self, root: LocalRepo) -> None:
        """The panel lists as last fetched for ``root``, or none yet."""
        self._shown_key = root.key
        prs, issues_, at = self._panel_data.get(self._shown_key, ([], [], None))
        self.prs, self.issues, self.last_updated = prs, issues_, at
        self.has_loaded = at is not None

    @property
    def other_repo_paths(self) -> list[str]:
        """The checkouts besides the repo root that a wizard accepts a pasted link to
        (Settings → OTHER REPOS), as picked.

        In QSettings rather than :mod:`appconfig`: only a wizard press reads it."""
        return [str(p) for p in (self._settings.value("otherRepoPaths", [], list) or [])]

    @other_repo_paths.setter
    def other_repo_paths(self, value: list[str]) -> None:
        self._settings.setValue("otherRepoPaths", list(value))
        self._local_checkouts = localrepos.resolve(list(value))
        self.local_repos_changed.emit()

    @property
    def local_checkouts(self) -> list[localrepos.Checkout]:
        """:attr:`other_repo_paths`, each with the GitHub and GitLab repos it answers for."""
        if self._local_checkouts is None:
            self._local_checkouts = localrepos.resolve(self.other_repo_paths)
        return self._local_checkouts

    @property
    def local_repos(self) -> tuple[LocalRepo, ...]:
        """The wizards' ``local_repos``: the repo roots, then every repo the listed
        checkouts answer for that is no root. Twin of ``Store.wizardRepos``."""
        roots = review.repo_roots()
        taken = {r.key for r in roots}
        return (*roots, *(r for r in localrepos.local_repos(self.local_checkouts)
                          if r.key not in taken))

    @staticmethod
    def wizard_item_label(target: LocalRepo, number: int) -> str:
        """A wizard's single item: :func:`item_label` in a repo root, else the whole
        ``owner/repo#N``. Comms knows a running fix recorded with no link by it."""
        roots = review.repo_roots()
        if target.key not in {r.key for r in roots}:
            return f"{target.slug}#{number}"
        return item_label(item_key(target.owner, target.repo, number, target.host), len(roots))

    def is_root(self, repo: LocalRepo | None) -> bool:
        """Whether ``repo`` is one of the repo roots: work there is deduped by item,
        unlike work in another listed checkout."""
        return repo is not None and repo.key in {r.key for r in review.repo_roots()}

    @property
    def agent_runner(self) -> str:
        """Which agent CLI a spawn runs (Settings → AGENT RUNNER). In
        :mod:`appconfig` rather than QSettings, as the repo root is: :mod:`runner`
        reads it Qt-free."""
        return runner.selected()

    @agent_runner.setter
    def agent_runner(self, value: str) -> None:
        appconfig.set_value(appconfig.AGENT_RUNNER, value)

    @property
    def agent_model(self) -> str:
        """The model the selected runner is pinned to; empty leaves the choice to that
        runner's own picker. A model id, never a credential — those live in the
        runner's provider store."""
        return appconfig.get(appconfig.AGENT_MODEL)

    @agent_model.setter
    def agent_model(self, value: str) -> None:
        appconfig.set_value(appconfig.AGENT_MODEL, value)

    @property
    def allocator_setup_done(self) -> bool:
        """True once the one-time automatic device-allocator install has been
        settled — either it succeeded, or the user made an explicit choice in
        Settings. Gates the auto-install so it never re-installs after an
        intentional uninstall."""
        return self._settings.value("allocatorSetupDone", False, bool)

    @allocator_setup_done.setter
    def allocator_setup_done(self, value: bool) -> None:
        self._settings.setValue("allocatorSetupDone", bool(value))

    @property
    def settings_explain(self) -> bool:
        """Whether Settings draws each row's long-form explanation (the header's
        *Explain* switch). Off by default: the paragraphs answer questions a first
        read raises and are noise on every read after it. Persisted, so the answer
        to "do I want these" is given once rather than on every visit."""
        return self._settings.value("settingsExplain", False, bool)

    @settings_explain.setter
    def settings_explain(self, value: bool) -> None:
        self._settings.setValue("settingsExplain", bool(value))

    # MARK: PR auto-fix monitor settings

    @property
    def pr_autofix_enabled(self) -> bool:
        """Watch my open PRs and auto-resolve conflicts + address review threads.
        On by default (matches macOS). Switched off, the poll keeps looking and
        queues what it finds for the panel (:meth:`is_paused`); what stops is the
        automatic start."""
        return self._settings.value("prAutofixEnabled", True, bool)

    @pr_autofix_enabled.setter
    def pr_autofix_enabled(self, value: bool) -> None:
        self._settings.setValue("prAutofixEnabled", bool(value))

    @property
    def review_requests_enabled(self) -> bool:
        """Review PRs that request my review (read-only, never touches their
        branch), retrying an unaddressed review until it lands. On by default;
        switched off it queues rather than starts, like the toggle above."""
        return self._settings.value("reviewRequestsEnabled", True, bool)

    @review_requests_enabled.setter
    def review_requests_enabled(self, value: bool) -> None:
        self._settings.setValue("reviewRequestsEnabled", bool(value))

    @property
    def community_issues_enabled(self) -> bool:
        """Queue a reproduce-and-fix of every issue the community files from here on.
        On by default (matches macOS). Off, nothing is queued and the mark is
        dropped, so switching it back on starts from that moment rather than
        queueing what was filed meanwhile (:meth:`_poll_community_issues`)."""
        return self._settings.value("communityIssuesEnabled", True, bool)

    @community_issues_enabled.setter
    def community_issues_enabled(self, value: bool) -> None:
        self._settings.setValue("communityIssuesEnabled", bool(value))
        if not value:
            self._settings.remove("communityIssuesSince")

    @property
    def review_allowlist_raw(self) -> str:
        """The logins the auto-review monitor is limited to, as the operator typed
        them. Blank ⇒ every author, which is what an applet that was never told
        otherwise does. Stored raw because this is a text field: parsing on the way in
        would rewrite the line under the cursor. :attr:`review_allowlist` is the
        parsed reader.

        In QSettings rather than :mod:`appconfig`: only this applet's review monitor
        reads it."""
        return str(self._settings.value("reviewAllowlistRaw", "", str) or "")

    @review_allowlist_raw.setter
    def review_allowlist_raw(self, value: str) -> None:
        self._settings.setValue("reviewAllowlistRaw", str(value))

    @property
    def review_allowlist(self) -> list[str]:
        """:attr:`review_allowlist_raw` as logins. Empty ⇒ no limit."""
        return autofix.parse_author_allowlist(self.review_allowlist_raw)

    @property
    def auto_task_limit(self) -> int:
        """How many automatic agents this machine runs at once — 2 by default.

        The monitors are level-triggered over everything GitHub currently owes,
        so without a cap one poll of a busy day dispatches every pending unit in
        a single pass: a terminal window and a ``claude`` session per conflicted
        PR and per owed review, all at once, on one machine. Work over the cap is
        not dropped — the poll that refuses it writes no attempt record, so the
        next tick offers it again as soon as an agent finishes, and it waits
        visibly in the panel's Agent-tasks list meanwhile.

        The second setting NOT in QSettings: the ``DIPLOMAT_AGENTS`` dump reads it
        Store-free (see :mod:`appconfig`)."""
        return appconfig.auto_task_limit()

    @auto_task_limit.setter
    def auto_task_limit(self, value: int) -> None:
        old = self.auto_task_limit
        appconfig.set_int(
            appconfig.AUTO_TASK_LIMIT, autofix.clamp_auto_task_limit(int(value))
        )
        if self.auto_task_limit > old:
            self._bring_poll_forward(self._settled_load)

    @property
    def device_idle_free_minutes(self) -> int:
        """:func:`appconfig.device_idle_free_minutes`. In the shared config, not
        QSettings, because the device-allocator daemon is what reads it."""
        return appconfig.device_idle_free_minutes()

    @device_idle_free_minutes.setter
    def device_idle_free_minutes(self, value: int) -> None:
        appconfig.set_int(
            appconfig.DEVICE_IDLE_FREE_MINUTES,
            appconfig.clamp_device_idle_minutes(
                int(value), appconfig.MAX_DEVICE_IDLE_FREE_MINUTES
            ),
        )

    @property
    def device_idle_leased_minutes(self) -> int:
        """:func:`appconfig.device_idle_leased_minutes`, shared for the same reason."""
        return appconfig.device_idle_leased_minutes()

    @device_idle_leased_minutes.setter
    def device_idle_leased_minutes(self, value: int) -> None:
        appconfig.set_int(
            appconfig.DEVICE_IDLE_LEASED_MINUTES,
            appconfig.clamp_device_idle_minutes(
                int(value), appconfig.MAX_DEVICE_IDLE_LEASED_MINUTES
            ),
        )

    @property
    def remote_machine_arm_bias(self) -> int:
        """:func:`appconfig.remote_machine_arm_bias`, in the shared config because the
        remote-machines daemon is what reads it."""
        return appconfig.remote_machine_arm_bias()

    @remote_machine_arm_bias.setter
    def remote_machine_arm_bias(self, value: int) -> None:
        appconfig.set_int(appconfig.REMOTE_MACHINE_ARM_BIAS,
                          appconfig.clamp_remote_machine_arm_bias(int(value)))

    def reload_device_config(self) -> None:
        """Have the views of config.json's device keys, which are also edited by hand,
        re-read them; the properties read the file on every access. Twin of
        ``Store.reloadDeviceConfig``."""
        self.device_config_reloaded.emit()

    @property
    def device_remote_provider(self) -> str:
        """The remote device pool's provider module (Devices → REMOTE POOL), in the
        shared config because the allocator daemon reads it; empty = no remote pool."""
        if self._remote_provider_unsaved is not None:
            return self._remote_provider_unsaved
        return appconfig.get(appconfig.DEVICE_REMOTE_PROVIDER)

    @device_remote_provider.setter
    def device_remote_provider(self, value: str) -> None:
        """Stored trimmed; empty removes the key, which turns the remote pool off. Kept
        in memory alone in a headless run, which must not persist anything."""
        value = value.strip()
        if headless.active(os.environ):
            self._remote_provider_unsaved = value
            return
        appconfig.set_value(appconfig.DEVICE_REMOTE_PROVIDER, value)

    @property
    def queued_task_order(self) -> list[str]:
        """The operator's drag order for the deferred-work queue, by queue key.

        In QSettings, unlike the cap above it: the arrangement is this front-end's view
        of its own list. Pruned to what is still offered on every commit, so it can't
        grow past the work it describes."""
        primary = self._primary().key
        return [migrate_queue_key(str(k), primary)
                for k in (self._settings.value("queuedTaskOrder", [], list) or [])]

    @queued_task_order.setter
    def queued_task_order(self, value: list[str]) -> None:
        self._settings.setValue("queuedTaskOrder", list(value))

    @property
    def queue_auto_run(self) -> bool:
        """Whether a free bay starts the next queued task by itself. On by default.

        Off, nothing automatic starts on this machine: the monitors keep finding
        work and every find queues, including the reviews a sweep asked for — which
        the monitor toggles do not speak for. Rows then move on "execute now" only."""
        return self._settings.value("queueAutoRun", True, bool)

    @queue_auto_run.setter
    def queue_auto_run(self, value: bool) -> None:
        self._settings.setValue("queueAutoRun", bool(value))

    @property
    def requested_work(self) -> list[autofix.RequestedWork]:
        """The work the operator has asked for by sweeping a scope and nothing has
        started yet, in the order their sweeps asked for it.

        Persisted, alone among the things the queue is built from, because it is the
        only one GitHub cannot answer for: a poll can always re-derive that a PR
        conflicts or that a thread is waiting on me, but nothing about a PR records
        that somebody swept it into a review, nor about an issue that somebody swept it
        into a fix. Losing this list on a restart would silently drop the rest of a
        fifty-item sweep, which is exactly the run long enough to be interrupted.

        Stored under the name this list has always had, so the asks a Review-PRs sweep
        left standing outlive the upgrade that widened it to issue fixes."""
        raw = self._settings.value("requestedReviews", "", str)
        try:
            rows = json.loads(raw) if raw else []
        except ValueError:
            return []
        if not isinstance(rows, list):
            return []
        parsed = [w for r in rows if isinstance(r, dict)
                  if (w := autofix.RequestedWork.from_json(r)) is not None]
        legacy = [not w.repo and w.action != autofix.QUEUE_INVESTIGATE_ACTION
                  for w in parsed]
        if not any(legacy):
            return parsed
        # A row a single-repo build stored names no repo: its link's, else the one repo
        # those builds knew. Written back, so it is migrated once.
        cfg = core.config()
        configured = f"{cfg['owner']}/{cfg['repo']}".lower()
        migrated = [dataclasses.replace(
                        w, repo=(item_key_from_url(w.url) or configured).partition("#")[0])
                    if old else w for w, old in zip(parsed, legacy)]
        self.requested_work = migrated
        return migrated

    @requested_work.setter
    def requested_work(self, value: list[autofix.RequestedWork]) -> None:
        self._settings.setValue(
            "requestedReviews", json.dumps([r.to_json() for r in value])
        )
        self._pipeline_stale &= {r.key for r in value}

    @property
    def auto_approve_enabled(self) -> bool:
        """Whether a clean auto-review may submit a verdict. Off by default: an
        auto-review never approves / requests-changes on my behalf until I opt in."""
        return self._settings.value("autoApproveEnabled", False, bool)

    @auto_approve_enabled.setter
    def auto_approve_enabled(self, value: bool) -> None:
        self._settings.setValue("autoApproveEnabled", bool(value))

    @property
    def soft_approve_enabled(self) -> bool:
        """Whether a clean comments-only auto-review submits a thank-you COMMENT review
        (no APPROVE action) instead of staying silent. On by default; moot on any PR
        that gets a real verdict."""
        return self._settings.value("softApproveEnabled", True, bool)

    @soft_approve_enabled.setter
    def soft_approve_enabled(self, value: bool) -> None:
        self._settings.setValue("softApproveEnabled", bool(value))

    @property
    def auto_review_default_depth(self) -> str:
        """The review depth id a review request's auto-review runs at, unless
        :attr:`auto_review_overrides` names its author."""
        return self._settings.value("autoReviewDefaultDepth",
                                    autofix.AUTO_REVIEW_DEFAULT_DEPTH, str)

    @auto_review_default_depth.setter
    def auto_review_default_depth(self, value: str) -> None:
        self._settings.setValue("autoReviewDefaultDepth", str(value))

    @property
    def auto_review_overrides(self) -> list[autofix.AutoReviewOverride]:
        """The per-author depth table: the seed until edited, and again whenever what is
        stored does not read back whole, as a macOS decode would."""
        raw = self._settings.value("autoReviewOverrides", "", str)
        try:
            stored = json.loads(raw)
        except ValueError:
            stored = None
        rows = ([autofix.AutoReviewOverride.from_json(r) for r in stored]
                if isinstance(stored, list) else [None])
        return list(autofix.AUTO_REVIEW_SEED) if None in rows else rows

    @auto_review_overrides.setter
    def auto_review_overrides(self, value: list[autofix.AutoReviewOverride]) -> None:
        self._settings.setValue("autoReviewOverrides",
                                json.dumps([r.to_json() for r in value]))

    def auto_review_depth(self, author: str, me: str) -> str:
        """The depth an auto-review of ``author``'s PR runs at, ``me`` being who I am in
        its repo."""
        return autofix.auto_review_depth(author, me, self.auto_review_overrides,
                                         self.auto_review_default_depth)

    @property
    def verdict_withhold_skill(self) -> bool:
        return self._settings.value("verdictWithholdSkill", True, bool)

    @verdict_withhold_skill.setter
    def verdict_withhold_skill(self, value: bool) -> None:
        self._settings.setValue("verdictWithholdSkill", bool(value))

    @property
    def verdict_withhold_installer(self) -> bool:
        return self._settings.value("verdictWithholdInstaller", True, bool)

    @verdict_withhold_installer.setter
    def verdict_withhold_installer(self, value: bool) -> None:
        self._settings.setValue("verdictWithholdInstaller", bool(value))

    @property
    def verdict_withhold_community(self) -> bool:
        return self._settings.value("verdictWithholdCommunity", True, bool)

    @verdict_withhold_community.setter
    def verdict_withhold_community(self, value: bool) -> None:
        self._settings.setValue("verdictWithholdCommunity", bool(value))

    @property
    def verdict_policy(self) -> autofix.VerdictPolicy:
        return autofix.VerdictPolicy(
            self.verdict_withhold_skill,
            self.verdict_withhold_installer,
            self.verdict_withhold_community,
        )

    # Monitor counters — persisted so the "fixed N" pills survive a restart.

    @property
    def autofix_conflicts_handled(self) -> int:
        return self._settings.value("autofixConflicts", 0, int)

    @autofix_conflicts_handled.setter
    def autofix_conflicts_handled(self, value: int) -> None:
        self._settings.setValue("autofixConflicts", int(value))

    @property
    def autofix_reviews_handled(self) -> int:
        return self._settings.value("autofixReviews", 0, int)

    @autofix_reviews_handled.setter
    def autofix_reviews_handled(self, value: int) -> None:
        self._settings.setValue("autofixReviews", int(value))

    @property
    def review_requests_handled(self) -> int:
        return self._settings.value("reviewRequestsHandled", 0, int)

    @review_requests_handled.setter
    def review_requests_handled(self, value: int) -> None:
        self._settings.setValue("reviewRequestsHandled", int(value))

    # Claude-API-error watcher (mirrors apiWatchEnabled / apiWatchContinues in
    # Store.swift). On by default, matching macOS.

    @property
    def api_watch_enabled(self) -> bool:
        """Whether the terminal watcher nudges any agent that stalls on a transient
        Claude API error to continue. On by default (matches macOS)."""
        return self._settings.value("apiWatchEnabled", True, bool)

    @api_watch_enabled.setter
    def api_watch_enabled(self, value: bool) -> None:
        self._settings.setValue("apiWatchEnabled", bool(value))

    @property
    def api_watch_continues(self) -> int:
        return self._settings.value("apiWatchContinues", 0, int)

    @api_watch_continues.setter
    def api_watch_continues(self, value: int) -> None:
        self._settings.setValue("apiWatchContinues", int(value))

    # Comms, the Slack watcher (the comms* keys of Store.swift, same strings).

    @property
    def comms_enabled(self) -> bool:
        """Off by default: it needs a token first, and it reads the operator's messages."""
        return self._settings.value("commsEnabled", False, bool)

    @comms_enabled.setter
    def comms_enabled(self, value: bool) -> None:
        self._settings.setValue("commsEnabled", bool(value))

    @property
    def comms_keywords_raw(self) -> str:
        """As typed; the core splits it (``CommsSettings.keywordList``)."""
        return str(self._settings.value("commsKeywordsRaw", "", str) or "")

    @comms_keywords_raw.setter
    def comms_keywords_raw(self, value: str) -> None:
        self._settings.setValue("commsKeywordsRaw", str(value))

    @property
    def comms_sender_allowlist_raw(self) -> str:
        """Slack user ids or handles, as typed; blank admits any workspace member."""
        return str(self._settings.value("commsSenderAllowlistRaw", "", str) or "")

    @comms_sender_allowlist_raw.setter
    def comms_sender_allowlist_raw(self, value: str) -> None:
        self._settings.setValue("commsSenderAllowlistRaw", str(value))

    @property
    def comms_act_requests(self) -> bool:
        """Whether a ping asking for a review or an issue fix queues one."""
        return self._settings.value("commsActRequests", True, bool)

    @comms_act_requests.setter
    def comms_act_requests(self, value: bool) -> None:
        self._settings.setValue("commsActRequests", bool(value))

    @property
    def comms_act_bumps(self) -> bool:
        """Whether a ping asking to hurry #N moves what is queued for it to the front."""
        return self._settings.value("commsActBumps", True, bool)

    @comms_act_bumps.setter
    def comms_act_bumps(self, value: bool) -> None:
        self._settings.setValue("commsActBumps", bool(value))

    @property
    def comms_act_investigations(self) -> bool:
        """Whether a reported problem queues an investigation agent."""
        return self._settings.value("commsActInvestigations", True, bool)

    @comms_act_investigations.setter
    def comms_act_investigations(self, value: bool) -> None:
        self._settings.setValue("commsActInvestigations", bool(value))

    @property
    def comms_batch_size(self) -> int:
        return self._settings.value("commsBatchSize", comms.batch_defaults()[0], int)

    @comms_batch_size.setter
    def comms_batch_size(self, value: int) -> None:
        self._settings.setValue("commsBatchSize", int(value))

    @property
    def comms_flush_after_secs(self) -> int:
        return self._settings.value("commsFlushAfterSecs", comms.batch_defaults()[2], int)

    @comms_flush_after_secs.setter
    def comms_flush_after_secs(self, value: int) -> None:
        self._settings.setValue("commsFlushAfterSecs", int(value))

    @property
    def comms_notify(self) -> bool:
        return self._settings.value("commsNotify", True, bool)

    @comms_notify.setter
    def comms_notify(self, value: bool) -> None:
        self._settings.setValue("commsNotify", bool(value))

    @property
    def comms_model(self) -> str:
        """The model the triage call runs on."""
        return str(self._settings.value("commsModel", "haiku", str) or "")

    @comms_model.setter
    def comms_model(self, value: str) -> None:
        self._settings.setValue("commsModel", str(value))

    @property
    def comms_seen_at(self) -> str:
        """ISO 8601, "" for never: every ping recorded after it is unread."""
        return str(self._settings.value("commsSeenAt", "", str) or "")

    @comms_seen_at.setter
    def comms_seen_at(self, value: str) -> None:
        self._settings.setValue("commsSeenAt", str(value))

    # The Pipeline (the pipeline* keys of Store.swift, same strings).

    @property
    def pipeline_enabled(self) -> bool:
        return self._settings.value("pipelineEnabled", False, bool)

    @pipeline_enabled.setter
    def pipeline_enabled(self, value: bool) -> None:
        if bool(value) != self.pipeline_enabled:
            self._pipeline_cut(master=True)
        self._settings.setValue("pipelineEnabled", bool(value))
        self._write_pipeline_control()

    @property
    def pipeline_rate(self) -> bool:
        """Rate unrated items, labelling the ones Diplomat may write."""
        return self._settings.value("pipelineRate", False, bool)

    @pipeline_rate.setter
    def pipeline_rate(self, value: bool) -> None:
        self._settings.setValue("pipelineRate", bool(value))
        self._write_pipeline_control()

    @property
    def pipeline_fix(self) -> bool:
        """Queue a fix PR for each low/low issue."""
        return self._settings.value("pipelineFix", False, bool)

    @pipeline_fix.setter
    def pipeline_fix(self, value: bool) -> None:
        if self.pipeline_fix and not value:
            self._pipeline_cut()
        self._settings.setValue("pipelineFix", bool(value))
        self._write_pipeline_control()
        if not value:
            self._withdraw_pipeline_asks(None)

    @property
    def pipeline_fast_track(self) -> bool:
        """Label my low/low PRs fast-track and queue their reviews until clean."""
        return self._settings.value("pipelineFastTrack", False, bool)

    @pipeline_fast_track.setter
    def pipeline_fast_track(self, value: bool) -> None:
        if self.pipeline_fast_track and not value:
            self._pipeline_cut()
        self._settings.setValue("pipelineFastTrack", bool(value))
        self._write_pipeline_control()
        if not value:
            self._withdraw_pipeline_asks(None)

    @property
    def pipeline_merge(self) -> bool:
        """Merge cleared PRs with admin rights, past the review requirement."""
        return self._settings.value("pipelineMerge", False, bool)

    @pipeline_merge.setter
    def pipeline_merge(self, value: bool) -> None:
        self._settings.setValue("pipelineMerge", bool(value))
        self._write_pipeline_control()

    @property
    def pipeline_fracture(self) -> bool:
        """Split writable medium/high-complexity issues into low-complexity children."""
        return self._settings.value("pipelineFracture", False, bool)

    @pipeline_fracture.setter
    def pipeline_fracture(self, value: bool) -> None:
        self._settings.setValue("pipelineFracture", bool(value))
        self._write_pipeline_control()

    def _pipeline_cut(self, *, master: bool = False) -> None:
        with self._pipeline_lock:
            self._pipeline_epoch += 1
            if master:
                self._pipeline_judged = False
                self._pipeline_stale = {w.key for w in self.requested_work if w.pipeline}

    def pipeline_control(self) -> dict:
        """``control.json``'s switches as they stand (:func:`pipeline.write_control`)."""
        return {"enabled": self.pipeline_enabled, "rate": self.pipeline_rate,
                "fix": self.pipeline_fix, "fastTrack": self.pipeline_fast_track,
                "merge": self.pipeline_merge, "fracture": self.pipeline_fracture}

    def _write_pipeline_control(self) -> None:
        """Headless only into a ``DIPLOMAT_PIPELINE_DIR``, so a render never steers the
        live app's sync. Twin of ``Store.writePipelineControl``."""
        if headless.active(os.environ) and not os.environ.get("DIPLOMAT_PIPELINE_DIR"):
            return
        with self._control_lock:
            pipeline.write_control(self.pipeline_control())

    @property
    def pipeline_linear_teams_raw(self) -> str:
        """The Linear teams tracked and the root each is fixed in, as typed:
        ``ENG=owner/repo, OPS=owner/other`` (:func:`pipeline.parse_linear_teams`)."""
        return str(self._settings.value("pipelineLinearTeams", "", str) or "")

    @pipeline_linear_teams_raw.setter
    def pipeline_linear_teams_raw(self, value: str) -> None:
        self._settings.setValue("pipelineLinearTeams", str(value))

    # MARK: derived settings

    @property
    def effective_me(self) -> str:
        o = self.username_override.strip()
        return o if o else self.me

    def me_for(self, root: LocalRepo) -> str:
        """Who "me" is in ``root``: :attr:`effective_me` on GitHub, glab's login on a
        GitLab host, kept while that host's entry in glab's config is unchanged
        (:meth:`known_me`). Raises while it is unknown, leaving the root unread like any
        failed read."""
        if not root.is_gitlab:
            if not self.effective_me:
                raise GHError(GITHUB_LOGIN_UNKNOWN)
            return self.effective_me
        entry = localrepos.glab_host_entry(root.host)
        login, read_for = self._gitlab_me.get(root.host, ("", None))
        if not login or read_for != entry:
            login = API.fetch_viewer_login(root.host)
            self._gitlab_me[root.host] = (login, entry)
        return login

    def known_me(self, root: LocalRepo) -> str:
        """:meth:`me_for` without asking glab: "" on a GitLab host not read since its
        entry in glab's config last changed (``glab auth login`` as another account
        rewrites it)."""
        if not root.is_gitlab:
            return self.effective_me
        login, entry = self._gitlab_me.get(root.host, ("", None))
        return login if entry == localrepos.glab_host_entry(root.host) else ""

    def tint(self, tool_id: str) -> str:
        """A tool's tint as #RRGGBB: the user's override if set, else its default."""
        override = self.color_overrides.get(tool_id)
        if override:
            return override
        t = tool_by_id(tool_id)
        return t.color_hex if t else "#888888"

    def set_tint(self, color_hex: str, tool_id: str) -> None:
        overrides = self.color_overrides
        overrides[tool_id] = color_hex
        self.color_overrides = overrides
        self.changed.emit()

    @property
    def terminal(self) -> review.SpawnTerminal:
        return review.terminal_by_key(self.terminal_choice) or review.default_terminal()

    @property
    def visible_tools(self) -> list[Tool]:
        hidden = self.hidden_tools
        return [t for t in tools() if t.id not in hidden]

    def set_tool(self, tool_id: str, visible: bool) -> None:
        hidden = self.hidden_tools
        if visible:
            hidden.discard(tool_id)
        else:
            hidden.add(tool_id)
            if self.selected == tool_id:
                vis = [t for t in tools() if t.id not in hidden]
                if vis:
                    self.selected = vis[0].id
        self.hidden_tools = hidden
        self.changed.emit()

    # MARK: data

    def fetch_me(self) -> None:
        """Cheap single-query fetch of the gh viewer login (the default identity)."""
        if self.me:
            return
        try:
            self.me = API.fetch_viewer_login()
            self.changed.emit()
        except Exception:  # noqa: BLE001 — best-effort identity resolution
            pass

    def refresh(self) -> None:
        """Synchronous full refresh. The GUI runs this on a worker thread."""
        self.is_loading = True
        self.error = None
        self.loading_changed.emit(True)
        try:
            # Again when the picker moved during the fetch: that one is cached, and
            # the root now selected is the one on screen.
            while True:
                root = self.selected_repo
                # Who the panel's "my PRs" lists compare against.
                if root.is_gitlab:
                    self.me_for(root)
                else:
                    self.me = API.fetch_viewer_login()
                prs = API.fetch_open_prs(root)
                found = API.fetch_open_issues(root)
                self._panel_data[root.key] = (
                    prs, found, datetime.now().astimezone())
                if self.selected_repo == root:
                    self._show_panel_data(root)
                    break
        except Exception as exc:  # noqa: BLE001
            self.error = str(exc)
        finally:
            self.is_loading = False
            self.loading_changed.emit(False)
            self.changed.emit()

    # MARK: PR auto-fix monitor
    #
    # The Linux port of Store.swift's autofix monitor. A background poll (driven by
    # a QTimer in app.py, independent of the panel) fetches my open PRs + the PRs
    # requesting my review, edge-triggers on new conflicts / review threads, and
    # spawns the same conflict-fix / review agents the panel wizards do — deduped by
    # an in-flight sentinel and rate-limited by ReviewReconcile backoff. The pure
    # decision logic lives in autofix.py; the GitHub and GitLab reads in autofixmonitor.py.

    def run_autofix_poll_async(self) -> None:
        """Kick one monitor poll on a worker thread (guarded against overlap). Safe to
        call from a QTimer whether or not the panel is open.

        It polls with the toggles off too: a switched-off monitor still finds what it
        would have done and queues it, because the panel is where the operator sees
        what their PRs owe and that question does not go away with the toggle that
        answers it automatically."""
        if not self._poll_lock.acquire(blocking=False):
            return  # a poll is already running
        self._autofix_poll_started = time.monotonic()
        self.autofix_poll_started.emit()

        def work() -> None:
            try:
                self._autofix_poll_once()
            finally:
                self._poll_lock.release()
                self.autofix_changed.emit()

        self.start_background(work)

    def _bring_poll_forward(self, load: int) -> None:
        """Start the next poll early, for a bay that freed or work that was asked for:
        the queue drains only at the top of a poll, so otherwise both wait out the rest
        of the interval with room on the machine and work in the list. A whole poll
        rather than the drain alone, because the drain reads the poll's fresh fetch.

        Only with something the drain may start and a bay to start it in, never sooner
        than :attr:`early_poll_floor` after the last poll started, and one waiting
        covers every call until it starts.

        The settle that finds a bay free runs on every panel tick while the window is
        on screen, and otherwise only at the top of a poll, which drains it there and
        then."""
        with self._early_poll_lock:
            if (not self.polls_early or self._early_poll is not None
                    or not self._drain_has_room(load)):
                return
            self._arm_early_poll(self._early_poll_wait())

    def _early_poll_wait(self) -> float:
        """Seconds until a poll brought forward may start: the floor after the last
        poll started, and a second at a time while one is still running, which a poll
        started then would bounce off."""
        started = self._autofix_poll_started
        wait = 0.0 if started is None else started + self.early_poll_floor - time.monotonic()
        return max(wait, 1.0) if self._poll_lock.locked() else wait

    def _arm_early_poll(self, wait: float) -> None:
        """Under ``_early_poll_lock``."""
        self._early_poll = threading.Timer(max(wait, 0.0), self._early_poll_due)
        self._early_poll.daemon = True
        self._early_poll.start()

    def _early_poll_due(self) -> None:
        with self._early_poll_lock:
            # Another poll may have started while this one waited.
            wait = self._early_poll_wait()
            if wait > 0:
                self._arm_early_poll(wait)
                return
            self._early_poll = None
        # That poll may have drained already.
        if self._drain_has_room(self._auto_tasks_running()):
            self.run_autofix_poll_async()

    def _drain_has_room(self, load: int) -> bool:
        # With the network on, the room is the pool's, not this device's cap.
        room = (self.network_answered is not False
                and not diplomacynetwork.settings_unknown()
                if diplomacynetwork.enabled() else load < self.auto_task_limit)
        return room and bool(self.drainable_tasks)

    def _autofix_poll_once(self) -> None:
        self._poll_error_this_cycle = None
        if self._terminal_unpublished:
            self.publish_spawn_terminal()
        # Both slow-refresh probes, ahead of the settle below — the pass that reads
        # them. The macOS twin takes the same two on ITS slow refresh, and a reading
        # only one front-end takes is two applets answering differently about one run
        # book on one machine.
        self.refresh_merged_statuses()
        self.refresh_token_budget()
        # Settle the agents before anything reads them. This is the one pass that runs
        # whatever the operator is looking at: the panel's own tick is gated on the
        # window being VISIBLE, and this is an app whose window is shut most of
        # the time — so with retirement only on that tick, a finished agent's record
        # was never dropped, its bay never came back, its PR stayed deduped and its
        # cost never reached the ledger, on exactly the machines that leave the app
        # alone. (Seen live: three runs, panel closed, nothing retiring.)
        with self._settle_lock:
            self._settle_and_signal()
        try:
            if not self.effective_me:
                self.fetch_me()
            if not self.effective_me and not any(r.is_gitlab for r in review.repo_roots()):
                # With a GitLab root only the GitHub roots fail (:meth:`me_for`).
                self._note_poll_failure(GITHUB_LOGIN_UNKNOWN)
            elif review.roots_guessed():
                # Its one root would be the configured repo at the first path, which
                # may check out another.
                self._note_poll_failure(
                    "no repo root in Settings resolves to a GitHub or GitLab checkout")
            else:
                # Every root's fetches concatenated: one drain, diff and commit see every
                # repo, and the telemetry ledger reconciles once per kind against the
                # union (a per-root `observe_owed` would clear the other roots' pending
                # work). Both prunes below go by this `complete`, not one read after the
                # slow fetches.
                roots, complete = review.repo_roots(), review.roots_complete()
                # One fetch of my PRs per cycle, taken before anything acts on it:
                # the drain re-checks the waiting queue against it and the
                # reconcilers below diff from the same list. Fetching it here rather
                # than inside the monitor is what lets the queue be checked at all —
                # the drain runs first, and the whole point of the check is that it
                # reads THIS cycle's evidence, not the one the queue was built from.
                # And which PRs left the open state, which that fetch cannot list; every
                # verb answers to it, the operator's own ask included
                # (:func:`autofix.still_owed`). A root either read fails in is left out
                # of everything below, like one that failed to resolve.
                snaps, closed, read = self._fetch_my_prs(roots)
                complete = complete and len(read) == len(roots)
                # The queue first, in the operator's order: a slot that freed since
                # the last cycle belongs to work already waiting for it, not to
                # whichever PR this poll's fetch happens to return first.
                #
                # Only on evidence a cycle actually confirmed. The queue survives a
                # failed cycle deliberately (see _staged_queue), but surviving is not
                # the same as being current: while `gh` is down the list freezes, and
                # a drain that kept firing from it would spawn agents at work
                # answered by hand hours ago. A fetch that failed just now is the
                # same blindness one cycle earlier, so it holds the drain too —
                # either of them, since a missing answer is not a pass.
                if (self.autofix_poll_error is None and snaps is not None
                        and closed is not None):
                    self._drain_queued_tasks(snaps, closed, read)
                # Start this cycle's staging empty — the one place it is reset, so a
                # cycle that failed part-way and never committed does not carry its
                # offers into this one. They are re-offered by the cycle that
                # succeeds, since the refusal that staged them wrote no attempt
                # record.
                self._staged_queue = []
                # Both PR monitors run whatever their toggles say; a switched-off one
                # queues what it finds instead of dispatching it (see is_paused).
                if snaps is not None:
                    self._poll_my_prs(snaps)
                self._poll_review_requests(read, complete)
                self._poll_community_issues(read, complete)
                # Last, so the monitors' finds keep the places they were found in:
                # the operator's own sweep bands behind them anyway, and a fifty-item
                # ask offered first would otherwise decide the arrangement of a queue
                # it is meant to wait in.
                self._offer_requested_work()
                # A cycle that failed part-way knows what it fetched, not what is
                # owed — committing then would drop every task the failing half would
                # have re-offered, and with it the operator's arrangement of them.
                if self._poll_error_this_cycle is None:
                    self.commit_queue()
        except Exception as exc:  # noqa: BLE001 — any poll failure surfaces, never kills the worker
            # The per-poll helpers guard only their fetch_* calls; a failure deeper in the
            # poll — notably a diplomat-core build-prompt subprocess error
            # (RuntimeError/CoreBinaryMissing) raised while EAGERLY building an
            # AgentJob(prompt=...) in a _dispatch_* helper — would otherwise escape here, past
            # _settle_poll_error, out of the try/finally-only work() wrapper, and KILL the daemon
            # poll worker thread (after which every poll silently no-ops and a stale error never
            # clears). Route it through the same poll-failure path as a fetch error instead.
            self._note_poll_failure(exc)
        self._settle_poll_error()

    def _fetch_my_prs(self, roots: list[LocalRepo]
                      ) -> tuple[list | None, set[str] | None, list[LocalRepo]]:
        """This cycle's read of my open PRs and of the PRs that left the open state, and
        the roots both were read in. A root whose read failed is left out and held
        (:attr:`_held_keys`): its queued tasks, fingerprints and attempt records stand
        untouched rather than be read as done. Only when every root's read failed is it
        a poll failure: both reads are ``None``, which stands their consumers down, and
        every root is returned, so the reads after this one fail on their own."""
        snaps: list = []
        closed: set[str] = set()
        read: list[LocalRepo] = []
        failed: list[tuple[LocalRepo, Exception]] = []
        for r in roots:
            try:
                found = autofixmonitor.fetch_snapshots(r, self.me_for(r))
                gone = autofixmonitor.fetch_closed_prs(r)
            except Exception as exc:  # noqa: BLE001 — any failure leaves the root unread
                failed.append((r, exc))
                continue
            snaps += found
            closed |= set(gone)
            read.append(r)
        self._held_keys = frozenset(r.key for r, _ in failed)
        if not read:
            self._note_poll_failure(failed[0][1])
            return None, None, roots
        self._note_roots_read("PRs", read, failed)
        return snaps, closed, read

    def _note_roots_read(self, what: str, read: list[LocalRepo],
                         failed: list[tuple[LocalRepo, Exception]]) -> None:
        """Log ``what`` of a root unreadable once per run of failed reads, and readable
        again once it reads. Not a poll failure: the other roots' work goes on."""
        configured = {r.key for r in review.repo_roots()}
        self._roots_unread = {k for k in self._roots_unread if k.partition(":")[2] in configured}
        for r, exc in failed:
            key = f"{what}:{r.key}"
            if key not in self._roots_unread:
                self._roots_unread.add(key)
                activity.log("auto", "root-read-failed",
                             f"{what} of {r.slug} unreadable, its work waits: {str(exc)[:120]}")
        for r in read:
            key = f"{what}:{r.key}"
            if key in self._roots_unread:
                self._roots_unread.discard(key)
                activity.log("auto", "root-read-recovered", f"{what} of {r.slug} readable again")

    @staticmethod
    def _root_gone(key: str) -> bool:
        """Whether root ``key`` was taken out of the roots: every root resolved, and none
        has that key."""
        return review.roots_complete() and key.lower() not in {
            r.key for r in review.repo_roots()}

    def _queued_root_gone(self, key: str) -> bool:
        """:meth:`_root_gone` for the task queued as ``key``: its item's repo, or for an
        investigation the repo it was asked in."""
        split = split_item_key(key.partition(":")[2])
        if split is not None:
            return self._root_gone(split[0])
        ask = next((w for w in self.requested_work if w.key == key), None)
        return ask is not None and bool(ask.repo) and self._root_gone(ask.repo)

    def _held(self, item: str) -> bool:
        return item.partition("#")[0] in self._held_keys

    def _poll_my_prs(self, snaps: list) -> None:
        now = time.time()
        prior = self._load_fingerprints()
        events, fps = autofix.compute_diff(prior, snaps)
        fps |= {k: f for k, f in prior.items() if self._held(k)}
        for kind, snap in events:
            if kind == "review":
                self._dispatch_my_review(snap, 1)
            # "conflict" events are intentionally a no-op here: the same poll's
            # _reconcile_my_conflicts sees the CONFLICTING state and handles it
            # (also covering conflicts that predate the baseline + failed spawns).
        self._save_fingerprints(fps)
        # Record what is owed BEFORE reconciling, so a unit of work is queued in
        # the ledger before the same poll can start it — otherwise the first
        # dispatch of every item would look like it came from nowhere and its
        # time-to-start would be unmeasurable.
        telemetry.observe_owed(autofix.WORK_REVIEW_REPLY, "review", {
            autofix.ledger_key(autofix.WORK_REVIEW_REPLY, s.url, s.head_sha): s.number
            for s in snaps if s.threads_i_owe > 0
        })
        telemetry.observe_owed(autofix.WORK_CONFLICTS, "conflicts", {
            autofix.ledger_key(autofix.WORK_CONFLICTS, s.url, s.head_sha): s.number
            for s in snaps if s.mergeable == "CONFLICTING"
        })
        self._reconcile_my_reviews(snaps, now)
        self._reconcile_my_conflicts(snaps, now)
        self.autofix_status = {
            "updatedAt": now,
            "watching": len(snaps),
            "conflictsHandled": self.autofix_conflicts_handled,
            "reviewsHandled": self.autofix_reviews_handled,
        }

    def _reconcile_my_reviews(self, snaps: list, now: float) -> None:
        """Level-triggered safety net: any PR of mine with unresolved threads I owe a
        reply on but no agent on it gets a (re)dispatch, deduped by in-flight + backoff."""
        key = "myReviewAttempts"
        attempts = self._load_attempts(key)
        owed = [s for s in snaps if s.threads_i_owe > 0]
        for s in owed:
            k = s.item
            action, val = autofix.decide(
                attempts.get(k),
                autofix.STAMP_UNRESOLVED_REVIEW,
                self._in_flight(s.url),
                False,
                now,
            )
            if action == "dispatch" and self._dispatch_my_review(s, int(val)):
                attempts[k] = autofix.ReviewAttempt(
                    autofix.STAMP_UNRESOLVED_REVIEW, now, int(val)
                )
        owed_keys = {s.item for s in owed}
        self._save_attempts(key, {k: v for k, v in attempts.items()
                                  if k in owed_keys or self._held(k)})

    def _reconcile_my_conflicts(self, snaps: list, now: float) -> None:
        """Level-triggered: any CONFLICTING PR of mine with no agent on it gets a
        (re)dispatch. Records are kept while the PR is CONFLICTING/UNKNOWN and pruned
        once it goes MERGEABLE."""
        key = "myConflictAttempts"
        attempts = self._load_attempts(key)
        conflicted = [s for s in snaps if s.mergeable == "CONFLICTING"]
        for s in conflicted:
            k = s.item
            action, val = autofix.decide(
                attempts.get(k),
                autofix.STAMP_CONFLICTING,
                self._in_flight(s.url),
                False,
                now,
            )
            if action == "dispatch" and self._dispatch_conflict_fix(
                s.number, s.url, int(val), "auto", head_sha=s.head_sha
            ):
                attempts[k] = autofix.ReviewAttempt(
                    autofix.STAMP_CONFLICTING, now, int(val)
                )
        keep = {s.item for s in snaps if s.mergeable != "MERGEABLE"}
        self._save_attempts(key, {k: v for k, v in attempts.items()
                                  if k in keep or self._held(k)})
        # Re-staged unchanged, so this cycle's commit keeps it; nothing new starts on an
        # undecided status.
        lab = {r.key for r in review.repo_roots() if r.is_gitlab}
        queued = {e.id: e for e in self.queued_tasks}
        self._staged_queue = self._staged_queue + [
            queued[k] for s in snaps if _undecided_merge_request(s, lab)
            and (k := autofix.queue_key(autofix.WORK_CONFLICTS, s.item)) in queued]

    def _community_marks(self) -> dict[str, str]:
        """The new-community-issue monitor's mark per root key, as stored. A single
        mark single-repo builds stored was the configured repo's."""
        raw = str(self._settings.value("communityIssuesSince", "", str) or "")
        try:
            marks = json.loads(raw)
        except ValueError:
            marks = None
        if isinstance(marks, dict):
            return {str(k): str(v) for k, v in marks.items()}
        cfg = core.config()
        return {f"{cfg['owner']}/{cfg['repo']}".lower(): raw} if raw else {}

    def _poll_community_issues(self, roots: list[LocalRepo], complete: bool = True) -> None:
        """Queue one fix for each issue the community filed in a root since its last
        scan.

        Queued as an ask, the same row a Fix-issues sweep of the community leaves,
        because nothing on GitHub would re-offer it: the mark moves past each issue
        once (:meth:`Filters.new_community_issues`). So it is offered until it is
        dispatched, can be cancelled, and re-reads its issue when its turn comes.

        Each root keeps its own mark, and one with none is baselined on its first read,
        so adding a root never queues its backlog. A removed root's mark is dropped, so
        re-adding it does not either. A root whose read failed keeps its mark (logged by
        :meth:`_note_roots_read`), as does every root while one fails to resolve
        (``complete``: :func:`review.roots_complete` of the reading ``roots`` came from)."""
        if not self.community_issues_enabled:
            return
        marks = self._community_marks()
        banned = bans.read()
        read: list[LocalRepo] = []
        failed: list[tuple[LocalRepo, Exception]] = []
        for root in roots:
            key = root.key
            try:
                found = autofixmonitor.fetch_open_issues(root)
                me = self.me_for(root)
            except Exception as exc:  # noqa: BLE001
                # Not a poll failure even in every root: nothing owed is read from it.
                failed.append((root, exc))
                continue
            read.append(root)
            try:
                since = datetime.fromisoformat(marks.get(key, ""))
            except ValueError:
                # Unset or unreadable: re-baseline rather than fail every poll from
                # here on.
                since = None
            fresh, mark = Filters.new_community_issues(
                found, since, datetime.now().astimezone())
            for issue in fresh:
                item = item_key(root.owner, root.repo, issue.number, root.host)
                who = f"Issue {item_label(item, len(review.repo_roots()))} by @{issue.author}"
                if bans.is_banned(issue.author, banned):
                    activity.log("auto", "ban-skip",
                                 f"{who} - author is banned, not queued")
                    continue
                cfg = issues.IssueConfig(target=issues.Target.CONTRIBUTORS,
                                         me=me, home=root)
                queued, _ = self._request([autofix.RequestedWork(
                    number=issue.number, url=issue.url, author=issue.author,
                    config=cfg.for_issue(issue.number).prompt_payload(), repo=key)])
                if queued:
                    activity.log("auto", "community-issue", f"{who} - fix queued")
            marks[key] = mark.isoformat()
        self._note_roots_read("Issues", read, failed)
        if complete:
            current = {r.key for r in roots}
            marks = {k: v for k, v in marks.items() if k in current}
        self._settings.setValue("communityIssuesSince", json.dumps(marks))

    def _poll_review_requests(self, roots: list[LocalRepo], complete: bool = True) -> None:
        """Dispatch the reviews requested of me in every root. A concluded record is
        kept only while the pass sees its request owed (:func:`autofix.retained`), so
        while a root fails to resolve or to be read (``complete``, as for
        :meth:`_poll_community_issues`) the records of repos no root read is a checkout
        of are all kept. A read that fails in every root is a poll failure."""
        reqs: list = []
        read: list[LocalRepo] = []
        failed: list[tuple[LocalRepo, Exception]] = []
        for root in roots:
            try:
                reqs += autofixmonitor.fetch_review_requests(
                    root, self.me_for(root), include_files=self.auto_approve_enabled)
            except Exception as exc:  # noqa: BLE001
                failed.append((root, exc))
                continue
            read.append(root)
        if failed and not read:
            self._note_poll_failure(failed[0][1])
            return
        self._note_roots_read("Review requests", read, failed)
        self._held_keys |= {r.key for r, _ in failed}
        complete = complete and not failed
        now = time.time()
        banned = bans.read()
        key = "reviewReqAttempts"
        prior = self._load_attempts(key)
        # An author outside the allowlist is dropped here rather than carried down as a
        # decision the way a ban is, because there is nothing further to say about them:
        # the ledger, the backoff ladder and the "owed" count all describe work this
        # machine intends to do, and it does not intend to do this. The dispatch gate
        # still answers for the same author, for the row a queue was already holding.
        allowlist = self.review_allowlist
        owed = [
            r for r in reqs
            if r.owe_review and autofix.author_allowed(r.author, allowlist)
        ]
        # Before dispatching, so the ledger has a queue instant to measure the
        # time-to-start against. A banned author's request is owed by GitHub's
        # reckoning but will never be dispatched, so it is left out — counting it
        # would show a review pending forever that nothing is meant to pick up.
        telemetry.observe_owed(autofix.WORK_REVIEW_REQ, "review", {
            autofix.ledger_key(autofix.WORK_REVIEW_REQ, r.url, r.head_sha): r.number
            for r in owed if not bans.is_banned(r.author, banned)
        })
        dispatched: dict[str, autofix.ReviewAttempt] = {}
        concluded: set[str] = set()
        for r in owed:
            k = r.item
            stamp = r.stamp
            action, val = autofix.decide(
                prior.get(k),
                stamp,
                self._in_flight(r.url),
                bans.is_banned(r.author, banned),
                now,
            )
            if action == "concluded":
                concluded.add(k)
            if action == "dispatch" and self._dispatch_review_request(r, int(val)):
                dispatched[k] = autofix.ReviewAttempt(stamp, now, int(val))
        # Onto the records as they stand now, not as this pass read them: the panel's tick
        # can conclude a request, or the queue record a dispatch, meanwhile. Aged-out
        # records are dropped so the store can't grow unbounded and a real future
        # re-request is fresh (:func:`autofix.retained`).
        records = {**self._load_attempts(key), **dispatched}
        kept = autofix.retained(records, {r.item: r.stamp for r in owed}, now)
        if not complete:
            polled = {r.key for r in read}
            kept |= {k: a for k, a in records.items() if k.partition("#")[0] not in polled}
        self._save_attempts(key, kept)
        self.unaddressed_reviews = sum(
            1
            for r in owed
            if not self._in_flight(r.url) and not bans.is_banned(r.author, banned)
            and r.item not in concluded
        )

    # MARK: monitor dispatch + tracking

    # MARK: - the one dispatch pipeline (buttons and monitors are triggers, not paths)

    @staticmethod
    def ban_refusal(job: autofix.AgentJob) -> str:
        """Who a dispatch refused for a ban is about, and what follows (macOS
        ``refusedWho`` and ``banRemedy``). A monitor's find comes back on its own once the
        ban lifts; an ask is retired (:meth:`_settle_requested`), and only a sweep re-asks
        for one, never for a Comms investigation."""
        if (job.author_login or "").startswith(bans.SLACK_PREFIX):
            return "the sender is banned (the ask is dropped)"
        remedy = ("the ask is dropped, sweep again to re-queue it"
                  if job.requested else "un-ban to review")
        return f"the PR's author is banned ({remedy})"

    def dispatch_agent(self, job: autofix.AgentJob, source: str, attempt: int = 1,
                       bypass_capacity: bool = False,
                       forced: bool = False) -> str:
        """Run one agent job through the shared gate (``autofix.dispatch_decide`` -
        the pure, tested decision both platforms mirror) and, on proceed, spawn and
        register it. Returns the verdict: ``"spawned"``, an ``autofix.VERDICT_*``
        refusal, or ``"failed"`` (spawn error). Twin of Store.dispatchAgent (macOS).

        With the Diplomacy Network on, proceeding is an offer to the job's pool
        (:meth:`_offer_tracked`), booked and counted as a spawn and answered with a
        :class:`diplomacynetwork.Offered` (``"spawned"``) or a
        :class:`diplomacynetwork.Refused`. Only a paused monitor or queue then holds it:
        the cap, the disk and the budget are the claiming machine's
        (:func:`network.admit`).

        In-flight evidence is the tracked list OR a live ``claude`` visible in
        ``ps`` - the ground-truth floor that also catches agents whose local
        bookkeeping was lost (applet restart). ``_dispatching_prs`` is held for the
        whole call so an overlapping poll and a click can't race two spawns onto one
        PR.

        An AUTO job is additionally capped at ``auto_task_limit`` concurrent
        agents on this device (``_auto_tasks_running``), held outright while its own
        monitor is switched off (:meth:`is_paused`) or the queue is
        (:attr:`queue_auto_run`), held when the disk agents write to is below its
        free-space floor (:mod:`diskfloor`), and held again when what is left of the
        limits it spends against will not cover it (:mod:`autobudget`); a panel click
        is subject to none of them. Every one of those refusals
        queues the job (:meth:`_stage_queued`), which is what the panel's
        Agent-tasks list shows as *queued*.

        ``bypass_capacity`` is for the two callers that have already answered the
        capacity question themselves: the queue drain (which counted the free slot
        it is filling, and skips paused work by construction) and "execute now"
        (where the operator is overriding both holds deliberately). It skips the
        measurement — not just its verdict — so neither pays for a second ``ps``
        scan, and so a forced run cannot re-queue itself.

        ``forced`` is only the second of those, and lifts the budget and the disk
        floor. The drain runs the machine's own automatic work, and work that could
        not be afforded when it was found cannot be afforded by having waited in a
        list, nor does a disk drain by being waited on; only the operator pressing
        "execute now" overrides those two, exactly as only they override the cap."""
        item = job.item
        if item is not None:
            with self._dispatching_lock:
                if item in self._dispatching_prs:
                    return autofix.VERDICT_IN_FLIGHT
                self._dispatching_prs.add(item)
        try:
            banned = bool(job.author_login) and bans.is_banned(
                job.author_login, bans.read()
            )
            # The allowlist speaks for the review monitor's work and nothing else, so
            # the counter - which is what makes a job that monitor's - is the whole
            # test. A sweep, a wizard press and both reconcilers over my own PRs carry
            # no counter or another one, and are never held here. Reached when a find
            # the queue was holding drains, or is run by hand, after the list stopped
            # covering its author.
            outside_allowlist = job.counter == "review_requests" and not (
                autofix.author_allowed(job.author_login or "", self.review_allowlist)
            )
            # Keyed on the item, as the claim on ``_dispatching_prs`` above is: a job
            # with a link and no number is a PR of another checkout, which the dedup
            # does not cover.
            agent_on_pr = item is not None and self._in_flight(job.pr_url or "")
            # Networked, the claiming machine answers for its own disk, cap and budget,
            # so neither disk nor budget is read here.
            networked = diplomacynetwork.enabled()
            # The disk first: it outranks every other hold on auto work. Measured on
            # the fullest of the volumes an agent fills: the repo roots (its
            # worktree) and ~/.diplomat (the tool caches).
            disk = None
            low_disk = False
            if (source == autofix.SOURCE_AUTO and not agent_on_pr and not forced
                    and not networked):
                disk = self._lowest_disk()
                low_disk = disk is not None and disk.low
                if not low_disk:
                    self._disk_logged = False
            # Measured only for an auto job that would otherwise run: the count
            # costs a `ps` scan, a panel click is never capped, and an in-flight
            # PR spawns nothing either way — so in both of those the answer would
            # be discarded. Finding room is also what re-arms the "deferring" note.
            at_capacity = False
            full = False
            paused = False
            if (source == autofix.SOURCE_AUTO and not agent_on_pr and not bypass_capacity
                    and not low_disk):
                full = self._auto_tasks_running() >= self.auto_task_limit
                if not full:
                    self._capacity_logged = False
                # A switched-off monitor has no room for its own work, whatever the
                # device's, and neither has a switched-off queue — for anything. Both
                # are modelled as capacity because the answer is the same one in every
                # respect that matters here — hold the job, write no attempt record,
                # re-offer it next poll. The gate still takes them apart from the
                # device's own cap, which holds nothing offered to the network.
                # The queue switch has to hold HERE and not only at the drain: a find
                # that meets a free bay never reaches the queue at all.
                paused = self.is_paused(job.counter) or not self.queue_auto_run
                at_capacity = full or paused
            # Measured after capacity and under the same conditions: a device with
            # no free bay has nothing to spend a budget on, so the probe and the
            # ledger fold are work that would be thrown away. The drain reaches here
            # with `bypass_capacity` set and this one clear — that is the whole
            # difference between deferring work and forcing it.
            budget = autofix.Budget(affordable=True)
            if (source == autofix.SOURCE_AUTO and not agent_on_pr
                    and not forced and not at_capacity and not low_disk
                    and not networked and autobudget.enabled()):
                budget = autobudget.decide()
                if budget.affordable:
                    self._budget_logged = False
            verdict = autofix.dispatch_decide(
                source, banned, agent_on_pr, full,
                not budget.affordable, outside_allowlist, low_disk,
                paused=paused, network=networked,
            )
            if verdict == autofix.VERDICT_LOW_DISK:
                self._log_low_disk(disk)
                self._stage_queued(job, attempt)
                return verdict
            if verdict == autofix.VERDICT_AT_CAPACITY:
                # A paused monitor is not a saturated device: it queues silently,
                # because the operator switched it off on purpose and the row says
                # the rest.
                if not paused:
                    self._log_at_capacity()
                self._stage_queued(job, attempt)
                return verdict
            if verdict == autofix.VERDICT_UNAFFORDABLE:
                self._log_unaffordable(budget)
                self._stage_queued(job, attempt)
                return verdict
            if verdict == autofix.VERDICT_BANNED:
                activity.log(source, "ban-skip", f"{job.label} - {self.ban_refusal(job)}")
                self.refresh_activity()
                return verdict
            if verdict == autofix.VERDICT_NOT_ALLOWED:
                who = job.author_login or "the author"
                activity.log(
                    source, "allowlist-skip",
                    f"{job.label} - {who} is not on the auto-review list "
                    f"(add them, or review it from the wizard)",
                )
                self.refresh_activity()
                return verdict
            if verdict == autofix.VERDICT_IN_FLIGHT:
                # A monitor tick hitting a busy PR is routine (stays silent); a
                # click deserves an answer for why nothing opened.
                if source == autofix.SOURCE_PANEL:
                    activity.log(
                        "panel", "in-flight", f"{job.label} - an agent is already on this PR"
                    )
                    self.refresh_activity()
                return verdict
            # What this dispatch is called wherever it is named: the activity line it
            # writes, and — while it runs — the row it wears in the Agent-tasks list.
            # One string, so a retry cannot read as a first attempt in one of them.
            row_label = autofix.dispatch_label(source, job.label, attempt,
                                               requested=job.requested)
            # Registered whether or not it is PR-scoped. A sweep or an audit has
            # nothing to dedup against, but it is still an agent this applet opened
            # a window on, and a run with no record is a row the panel cannot draw
            # and a directory nothing ever cleans up. What it costs depends on how
            # it was dispatched, not on having a PR: the cap counts automatic runs
            # and pricing follows the ledger key.
            started = "spawned"
            if networked:
                # Networked, nothing starts an agent on this machine, whatever the
                # daemon answers.
                started = self._offer_tracked(job, source, attempt, forced, row_label)
                if not isinstance(started, diplomacynetwork.Offered):
                    return started
            else:
                try:
                    self._spawn_tracked(job.prompt, job.pr_url, job.pr_number,
                                        source, job.ledger_key,
                                        label=row_label, kind=job.kind,
                                        checkout=job.checkout)
                except review.SpawnError as exc:
                    activity.log(source, "spawn-failed",
                                 f"{job.label} failed to spawn: {exc}")
                    self.refresh_activity()
                    self._note_comms_spawn_failed(row_label, str(exc))
                    return "failed"
                token = bool(review.token_export())
                activity.log(source, job.audit_action,
                             row_label + (review.TOKEN_AUDIT_NOTE if token else ""))
            # The telemetry ledger tracks the MONITORS, so only an auto dispatch is
            # recorded — a wizard click is the operator's own doing and has no queue
            # instant to be late against.
            if source == autofix.SOURCE_AUTO and job.ledger_key:
                telemetry.record_started(job.ledger_key, attempt=attempt)
            # Retries are re-dispatches, not new work handled - count once, and
            # only for the monitor (a manual run is the user's own action).
            if autofix.dispatch_bumps_counter(source, attempt):
                if job.counter == "review_requests":
                    self.review_requests_handled += 1
                elif job.counter == "my_reviews":
                    self.autofix_reviews_handled += 1
                elif job.counter == "conflicts":
                    self.autofix_conflicts_handled += 1
            if source == autofix.SOURCE_PANEL:
                self.refresh_activity()
            return started
        finally:
            if item is not None:
                with self._dispatching_lock:
                    self._dispatching_prs.discard(item)

    @staticmethod
    def _lowest_disk() -> diskfloor.Reading | None:
        """None with no floor set."""
        return diskfloor.lowest([*(r.path for r in review.repo_roots()),
                                 str(Path.home() / ".diplomat")])

    def _item_label(self, url: str, number: int) -> str:
        """``#N`` while one repo root is loaded, else ``repo#N`` (:func:`item_label`)."""
        item = item_key_from_url(url)
        return item_label(item, len(review.repo_roots())) if item else f"#{number}"

    def _dispatch_conflict_fix(
        self, number: int, url: str, attempt: int, source: str, head_sha: str = ""
    ) -> bool:
        root = self._root_named(item_key_from_url(url))
        if root is None:
            return False
        job = autofix.AgentJob(
            kind="conflicts",
            audit_action="conflicts",
            label=f"Resolve · {self._item_label(url, number)}",
            prompt=conflicts.ConflictConfig(
                target=PRTarget.SPECIFIC, me=self.known_me(root), specific_pr=str(number),
                home=root,
            ).build_prompt(),
            pr_url=url,
            pr_number=number,
            ledger_key=autofix.ledger_key(autofix.WORK_CONFLICTS, url, head_sha),
            counter="conflicts",
            attempt_stamp=autofix.STAMP_CONFLICTING,
            checkout=root.path,
        )
        return self.dispatch_agent(job, source, attempt) == "spawned"

    def _dispatch_my_review(self, s, attempt: int = 1) -> bool:
        root = self._root_named(s.item)
        if root is None:
            return False
        payload = review.ReviewConfig(
            depth="deep",
            target=PRTarget.SPECIFIC,
            me=self.known_me(root),
            mark_ready=False,
            leave_reviews=False,
            reply_to_reviews=True,
            specific_pr=str(s.number),
            specific_author=review.SpecificAuthor.MINE,
            home=root,
        ).prompt_payload()
        job = autofix.AgentJob(
            kind="review",
            audit_action="review-reply",
            label=f"Review · {self._item_label(s.url, s.number)}",
            prompt=promptcore.build_prompt(payload),
            pr_url=s.url,
            pr_number=s.number,
            ledger_key=autofix.ledger_key(autofix.WORK_REVIEW_REPLY, s.url, s.head_sha),
            counter="my_reviews",
            attempt_stamp=autofix.STAMP_UNRESOLVED_REVIEW,
            checkout=root.path,
            **diplomacynetwork.terms(payload),
        )
        return self.dispatch_agent(job, autofix.SOURCE_AUTO, attempt) == "spawned"

    def _dispatch_review_request(self, r, attempt: int = 1) -> bool:
        reasons = self.verdict_policy.withhold_reasons(r.files, r.author_association)
        verdict = self.auto_approve_enabled and not reasons
        # Without a real verdict, a clean review still soft-approves (thank-you COMMENT
        # review, no APPROVE) unless the user turned that off too. Moot when verdict is True.
        soft = self.soft_approve_enabled
        if verdict:
            tag = " +verdict"
        else:
            why = "auto-approvals off" if not self.auto_approve_enabled else ", ".join(reasons)
            tag = f" ~soft-approve ({why})" if soft else f" -verdict ({why})"
        root = self._root_named(r.item)
        if root is None:
            return False
        payload = self._review_request_config(
            r.number, author=r.author, verdict=verdict, home=root).prompt_payload()
        job = autofix.AgentJob(
            kind="review",
            audit_action=REVIEW_REQ_ACTION,
            label=f"Review-req · {self._item_label(r.url, r.number)} (@{r.author}){tag}",
            prompt=promptcore.build_prompt(payload),
            pr_url=r.url,
            pr_number=r.number,
            author_login=r.author,
            ledger_key=autofix.ledger_key(autofix.WORK_REVIEW_REQ, r.url, r.head_sha),
            counter="review_requests",
            attempt_stamp=r.stamp,
            checkout=root.path,
            **diplomacynetwork.terms(payload),
        )
        return self.dispatch_agent(job, autofix.SOURCE_AUTO, attempt) == "spawned"

    def _review_request_config(self, number: int, *, author: str, verdict: bool,
                               home: LocalRepo) -> review.ReviewConfig:
        """The review-request monitor's review of ``author``'s PR ``number`` in ``home``, at
        :meth:`auto_review_depth` and left on the PR; ``verdict`` lets a clean one
        approve, and without it a clean one soft-approves unless that is switched off."""
        me = self.known_me(home)
        return review.ReviewConfig(
            depth=self.auto_review_depth(author, me),
            target=PRTarget.SPECIFIC,
            me=me,
            mark_ready=False,
            leave_reviews=True,
            reply_to_reviews=False,
            specific_pr=str(number),
            automatic_verdict=verdict,
            soft_approve=self.soft_approve_enabled,
            specific_author=review.SpecificAuthor.THEIRS,
            home=home,
        )

    def _spawn_tracked(self, prompt: str, url: str | None, number: int | None,
                       source: str, ledger_key: str = "", label: str = "",
                       kind: str = "", checkout: str | None = None) -> None:
        """Register a run, then spawn its agent into it. Raises
        :class:`review.SpawnError` when the run can't be booked or no terminal
        launched; the run is forgotten unless the book refuses that write too.

        The record is written BEFORE the spawn, not after. A terminal takes seconds to
        open and the poll that dispatched it can ask about the same PR again inside
        that window; a run booked only on success is a PR that reads free while its
        agent is starting.

        The agent's shell writes its own pid into the run directory and then execs, so
        what identifies this run afterwards is that pid rather than the wording of its
        prompt (:func:`review.shell_command`). The hooks staged beside it are what let
        the run say when its turn is over (:mod:`diplomat_runtime.completion`), which
        is the only evidence that distinguishes a finished agent from a working one —
        both are the same live process at the same pid.

        A launch that returns is not a run that started: the terminal is a detached
        process, and one that opens a window and never runs the command in it looks
        exactly like one that did. Answering that is left to the tick, where a local
        record with no pid file past :data:`agentstate.SPAWN_GRACE` resolves FAILED,
        rather than waited for here — this is the GUI thread on a panel click.

        Which runner is spawned is written down here rather than re-read later: the
        setting is what the NEXT spawn will use, so a run started under one runner and
        asked about after the operator switched would be interrogated through the
        wrong store. An OpenCode 1.x run also gets a port reserved for its own server.
        A port that cannot be had is not a failure to spawn — the run goes ahead without
        one and is read off its screen, exactly as a Claude Code run is. An OpenCode 2.x
        run has no server of its own and gets no port: its session is minted and staged
        instead (:func:`review.stage_opencode_session`) and bound to the run before the
        spawn, so the probe asks the per-user service about it from the first tick.

        ``checkout`` is where the agent works when that is not the repo root
        (:attr:`autofix.AgentJob.checkout`).

        Refused while the Diplomacy Network is on: this is the one road to an agent on
        this machine.
        """
        if diplomacynetwork.enabled():
            raise review.SpawnError("the Diplomacy Network is on, so no agent starts "
                                    "on this machine")
        if checkout == review.repo_path():
            checkout = None
        now = time.time()
        try:
            record = agentregistry.create_run(
                agentstate.RunRecord(
                    run_id=agentregistry.new_run_id(now), dispatched_at=now,
                    pr_number=number, pr_url=url or "", kind=kind, label=label,
                    source=source, ledger_key=ledger_key),
                prompt)
        except OSError as exc:
            raise review.SpawnError(
                f"couldn't register the run: {exc.strerror or exc}") from exc
        chosen = agentregistry.stage_runner(record.run_id)
        if checkout:
            agentregistry.stage_directory(record.run_id, checkout)
        port = None
        staged = {"checkout": checkout} if checkout else {}
        try:
            if chosen == runner.OPENCODE:
                session_id = review.stage_opencode_session(
                    str(agentregistry.prompt_path(record.run_id)), checkout)
                if session_id:
                    agentregistry.bind_session(record.run_id, session_id)
                    staged["opencode_session"] = session_id
                else:
                    port = agentregistry.stage_port(record.run_id)
            review.spawn(prompt, self.terminal,
                         done_path=str(agentregistry.done_path(record.run_id)),
                         pid_path=str(agentregistry.pid_path(record.run_id)),
                         prompt_file=str(agentregistry.prompt_path(record.run_id)),
                         port=port,
                         settings_file=agentregistry.stage_hooks(record.run_id),
                         session=tmuxwatch.session_name(record.run_id), **staged)
        except review.SpawnError:
            # Unwritten, the record stays booked with no pid, and the tick retires it
            # as FAILED once the spawn grace runs out.
            self._write_book(lambda: agentregistry.forget({record.run_id}))
            raise

    def _offer_target(self, job: autofix.AgentJob) -> tuple[str, int | None]:
        """The job's repository (a :attr:`LocalRepo.key`, "" for none) and PR or issue:
        from its link, else the checkout it would be spawned into."""
        linked = split_item_key(item_key_from_url(job.pr_url or "") or "")
        if linked is not None:
            return linked[0], job.pr_number if job.pr_number is not None else linked[1]
        where = job.checkout or review.repo_path()
        return next((r.key for r in self.local_repos if r.path == where), ""), None

    def _offer_tracked(self, job: autofix.AgentJob, source: str, attempt: int,
                       forced: bool, row_label: str) -> str:
        """Offer a job to its repository's pool and book its run, with the daemon's task
        id (:attr:`agentstate.RunRecord.network`) where a spawn has a pid and a window;
        a :class:`diplomacynetwork.Offered` once booked.

        A job the network did not take never starts here instead: automatic work goes
        back to the queue, an operator's job answers why
        (:class:`diplomacynetwork.Refused`).

        An offer sent and not settled may be in the pool. Automatic work is offered
        again from the queue (the daemon answers with the task it holds); an operator's
        job is kept in :attr:`network_offering`
        (:data:`diplomacynetwork.VERDICT_OFFERING`).

        While the daemon is known silent (:attr:`network_answered`) automatic work is
        not offered, as each offer would wait out its timeout; the network cycle finds
        the daemon back. The operator's still asks.

        While :func:`diplomacynetwork.settings_unknown` nothing is offered: the job and
        its pool would come of default settings.
        """
        unknown = diplomacynetwork.settings_unknown()
        if unknown:
            return self._network_refused(job, source, attempt, unknown)
        repo_key, number = self._offer_target(job)
        offer = network.offer_for(
            job.audit_action, job.own_pr, number, repo_key, job.label, job.prompt,
            source, forced, verdict=job.verdict, mark_ready=job.mark_ready,
            no_prs=not job.opens_prs, read_only=not job.opens_prs)
        if isinstance(offer, str):
            return self._network_refused(job, source, attempt, offer, own=True)
        if source == autofix.SOURCE_AUTO and not forced and self.network_answered is False:
            return self._network_refused(job, source, attempt, diplomacynetwork.NOT_ANSWERING)
        reply = diplomacynetwork.send(network.ROUTE_OFFER, offer.body)
        if (source != autofix.SOURCE_AUTO and reply != deviceallocator.UNREACHABLE
                and not diplomacynetwork.definite(reply)):
            held = NetworkOffering(job, source, row_label, offer)
            with self._network_offering_lock:
                self.network_offering = [
                    h for h in self.network_offering if h.key != held.key] + [held]
            self.tasks_changed.emit()
            return diplomacynetwork.VERDICT_OFFERING
        task, why = self._offer_answer(reply)
        if task is None:
            return self._network_refused(
                job, source, attempt, why,
                own=diplomacynetwork.definite(reply) and not reply.ok)
        self._network_unavailable_logged = False
        self._forget_job_refusals(lambda label: label != job.label)
        # An offer still open is answered with its existing task: that run is this job's.
        if any(r.network == task for r in agentregistry.load()):
            if source == autofix.SOURCE_PANEL:
                activity.log(source, "in-flight",
                             f"{job.label} - already offered to {offer.pool}")
                self.refresh_activity()
            return autofix.VERDICT_IN_FLIGHT
        return self._book_offer(job, task, offer.pool, source, row_label)

    @staticmethod
    def _offer_answer(reply: deviceallocator.DaemonReply | str) -> tuple[str | None, str]:
        """The task an offer was taken as, or None and why it was not."""
        why = diplomacynetwork.refusal(reply)
        if why is not None:
            return None, why
        task = reply.get("taskId")
        if isinstance(task, str) and task:
            return task, ""
        return None, "the daemon named no task for the offer"

    def _book_offer(self, job: autofix.AgentJob, task: str, pool: str, source: str,
                    row_label: str) -> str:
        now = time.time()
        try:
            agentregistry.create_run(
                agentstate.RunRecord(
                    run_id=agentregistry.new_run_id(now), dispatched_at=now,
                    pr_number=job.pr_number, pr_url=job.pr_url or "", kind=job.kind,
                    label=row_label, source=source, ledger_key=job.ledger_key,
                    network=task),
                job.prompt)
        except OSError:
            # An offer nothing here tracks is work nobody waits for.
            diplomacynetwork.send(network.ROUTE_WITHDRAW, network.withdraw_body(
                task, network.WITHDRAW_NOT_BOOKED))
            activity.log(source, network.AUDIT_FAILED,
                         f"{job.label} - could not register the run, so its offer is "
                         "withdrawn")
            self.refresh_activity()
            return "failed"
        activity.log(source, network.AUDIT_OFFER, f"{row_label} - offered to {pool}")
        return diplomacynetwork.Offered(task)

    def _settle_offering(self, snapshot: network.Snapshot) -> None:
        """Settle each :attr:`network_offering` job against an answering daemon: book
        the task the snapshot holds for it, else offer again (answered with the task
        held, if the first offer reached it). A refusal drops the job; no definite
        answer keeps it for the next cycle."""
        for held in list(self.network_offering):
            task, why = network.open_task(*held.key, snapshot), ""
            if task is None:
                reply = diplomacynetwork.send(network.ROUTE_OFFER, held.offer.body)
                if not diplomacynetwork.definite(reply):
                    continue
                task, why = self._offer_answer(reply)
            with self._network_offering_lock:
                if held not in self.network_offering:
                    continue  # the switch moved across the wait, which empties the list
                self.network_offering = [h for h in self.network_offering if h is not held]
            if task is None:
                activity.log(held.source, network.AUDIT_UNAVAILABLE,
                             f"{held.job.label} was not offered: {why}")
            # A second press of the same job books the task ahead of this.
            elif not any(r.network == task for r in agentregistry.load()):
                self._book_offer(held.job, task, held.offer.pool, held.source,
                                 held.row_label)
            self.refresh_activity()
            self.tasks_changed.emit()

    def _withdraw_offering(self) -> None:
        """The switch went off over unsettled offers: withdraw each the daemon holds, say
        the rest were not offered, keep none."""
        with self._network_offering_lock:
            held, self.network_offering = self.network_offering, []
        if not held:
            return
        snapshot = diplomacynetwork.state()
        for h in held:
            task = network.open_task(*h.key, snapshot)
            if task is not None:
                self._withdraw(task, network.WITHDRAW_SWITCHED_OFF, h.row_label, h.source)
            else:
                activity.log(h.source, network.AUDIT_UNAVAILABLE,
                             f"{h.job.label} was not offered: {diplomacynetwork.SWITCHED_OFF}")
        self.refresh_activity()
        self.tasks_changed.emit()

    def _network_refused(self, job: autofix.AgentJob, source: str, attempt: int,
                         why: str, own: bool = False) -> diplomacynetwork.Refused:
        """Automatic work waits in the queue. An ``own`` refusal is said once per job, in
        the feed and on its row (:attr:`network_job_refusals`); one holding every job
        gets one feed line per spell: until an offer goes through, or the switch moves."""
        if source == autofix.SOURCE_AUTO:
            self._stage_queued(job, attempt)
            if own:
                if self.network_job_refusals.get(job.label) != why:
                    self.network_job_refusals = {**self.network_job_refusals, job.label: why}
                    activity.log(source, network.AUDIT_UNAVAILABLE,
                                 f"{job.label} was not offered: {why}")
                    self.refresh_activity()
                    self.tasks_changed.emit()
            elif not self._network_unavailable_logged:
                self._network_unavailable_logged = True
                activity.log(source, network.AUDIT_UNAVAILABLE,
                             "Holding auto work - the Diplomacy Network did not take "
                             f"{job.label}: {why}")
                self.refresh_activity()
        else:
            activity.log(source, network.AUDIT_UNAVAILABLE,
                         f"{job.label} was not offered: {why}")
            self.refresh_activity()
        return diplomacynetwork.Refused(why, own)

    def _forget_job_refusals(self, keep) -> None:
        self.network_job_refusals = {
            label: why for label, why in self.network_job_refusals.items() if keep(label)}

    def _auto_tasks_running(self) -> int:
        """How many bays of this device's cap are held right now — the number the cap
        is compared against."""
        return len(self._agent_tick().cap_load)

    def refresh_auto_task_count(self) -> None:
        """Re-resolve for the display alone, signalling only on a change.

        The panel calls it on its own tick, including the ticks where nothing is
        registered: an agent can be alive with no record behind it (one this applet
        never spawned), and that is exactly when a wrongly-drawn free bay would be
        most misleading.

        A change is a change of the resolved states, not of their number: one agent
        finishing as another starts leaves the count alone while both rows are now
        wrong, and an agent going quiet moves no count at all while the bay it hands
        back is drawn from that same measure."""
        if not self._settle_lock.acquire(blocking=False):
            return  # a settle is under way; the next tick asks again
        try:
            self._settle_and_signal()
        finally:
            self._settle_lock.release()

    def _settle_and_signal(self) -> None:
        """Settle, and tell the panel if the agent picture moved (`_state_signature`).

        The poll's settle says so too: what it retires stays drawn until the panel is
        told, and the panel's own refresh is up to a tick away."""
        before = self._state_signature()
        self._settle_agents()
        if self._state_signature() != before:
            self.tasks_changed.emit()
        with self._tick_lock:
            load = len(self._tick.cap_load) if self._tick is not None else 0
        if load < self._settled_load:
            self._bring_poll_forward(load)
        self._settled_load = load

    def _state_signature(self) -> frozenset:
        """What "the agent picture changed" means, for the redraw: every run and the
        state it is in. A count would miss two agents swapping PRs, and an agent
        going quiet."""
        t = self._tick
        if t is None:
            return frozenset()
        return frozenset((r.run_id, s.state) for r, s in t.rows)

    def refresh_auto_task_count_async(self) -> None:
        """Resolve off the UI thread — the probes shell out (see
        :mod:`diplomat_app.probes`)."""
        self.start_background(self.refresh_auto_task_count)

    @property
    def running_tasks(self) -> list[autofix.RunningAgent]:
        """Every agent run the panel draws, in reading order.

        Every one - both sources, tracked or not - as on macOS, so the rows and the cap
        answer one question about the machine.

        A record carries the label, kind and start time its dispatch logged. A run
        nobody dispatched has none of those and is drawn by its PR alone, which is
        still a great deal more than the blank the operator gets otherwise.

        Runs that are over are left out (:data:`agentstate.ENDED`), so the list starts
        at *awaiting input*.
        """
        return [
            (autofix.RunningAgent if r.network is None else NetworkRun)(
                pr_number=r.pr_number or 0,
                label=r.label,
                kind=r.kind,
                tracked=not r.untracked,
                started_at=0.0 if r.untracked else r.dispatched_at,
                state=s.state,
                reason=s.reason,
                item=item_key_from_url(r.pr_url),
                released=r.released,
                **({} if r.network is None
                   else {"run_id": r.run_id, "task": r.network}),
            )
            for r, s in self._agent_tick().rows
            if s.state not in agentstate.ENDED
        ]

    @property
    def auto_tasks_shown(self) -> int:
        """How many bays of this device's cap the drawn agents hold.

        Not every row: a session waiting at its prompt keeps its place in the list
        and gives its bay back, so the list is longer than the cap exactly as often
        as an agent waits on its operator."""
        return len(self._agent_tick().cap_load)

    @property
    def free_auto_slots(self) -> int:
        """Slots of this device's cap with nothing in them, as the panel draws them.

        Work that is starting holds one. Its spawn has not registered anywhere yet,
        but the bay is spoken for — and drawn as free it would put a row that is
        launching next to the empty slot it is launching into, which is one row more
        than the cap allows."""
        return autofix.free_slots(
            self.auto_task_limit, self.auto_tasks_shown + len(self.starting_tasks)
        )

    def _log_at_capacity(self) -> None:
        """Note that automatic work is being held back — once per episode, not once
        per PR per poll. Cleared the moment a dispatch finds room again, so the feed
        gets one line when the device saturates and another when it drains."""
        if self._capacity_logged:
            return
        self._capacity_logged = True
        limit = self.auto_task_limit
        activity.log(
            "auto", "at-capacity",
            f"Deferring auto work — this machine already runs its cap of "
            f"{limit} automatic {'task' if limit == 1 else 'tasks'}",
        )
        self.refresh_activity()

    def _log_unaffordable(self, budget: autofix.Budget) -> None:
        """Note that automatic work is being held for want of budget — once per
        episode, like :meth:`_log_at_capacity`, and cleared the moment a dispatch
        finds room again. Without that, a machine sitting under its floor would write
        one of these per owed PR per poll, for hours."""
        if self._budget_logged:
            return
        self._budget_logged = True
        activity.log("auto", "no-budget",
                     f"Deferring auto work — {autobudget.shortfall(budget)}")
        self.refresh_activity()

    def _log_low_disk(self, disk: diskfloor.Reading) -> None:
        """Note that automatic work is being held for want of disk — once per
        episode, like :meth:`_log_at_capacity`, and cleared the moment a dispatch
        finds the disk above its floor again."""
        if self._disk_logged:
            return
        self._disk_logged = True
        activity.log("auto", "low-disk",
                     f"Deferring auto work — {diskfloor.describe(disk)}")
        self.refresh_activity()

    # MARK: - the queue behind the cap
    #
    # A refusal writes no attempt record, so every poll re-offers whatever GitHub
    # still owes: that is where the queue's contents come from, and why nothing here
    # is a second copy of monitor state. What the queue adds is a list the panel can
    # show and the operator can arrange, drained in THEIR order at the top of a cycle,
    # before the monitors go looking for more.
    #
    # Two holds put work here. The device's cap holds work it has no slot for, and the
    # drain releases it as slots free. A switched-off monitor holds its own work
    # indefinitely: it is queued so the panel can show what the PRs owe, and only a
    # click ("execute now") or the toggle coming back on starts it.

    def _stage_queued(self, job: autofix.AgentJob, attempt: int) -> None:
        """Remember one at-capacity refusal as a queued task. Called from the single
        dispatch gate, so every deferral is queued however it was triggered — the two
        reconcilers, the review-request monitor, or the review edge-trigger. One poll
        can offer the same key twice; which of the two runs is decided in
        :meth:`commit_queue`."""
        # Only PR-scoped work with a monitor behind it is queued by a REFUSAL: a task
        # nothing can name is one the next poll cannot recognise as the same one, and a
        # task no monitor owns is one nothing would re-offer from here — so the refusal
        # would be the only record of it, and a poll that never happened would lose it.
        # (Every automatic job is both. A review the operator asked for is neither, and
        # is re-offered from the list that remembers the ask instead —
        # :meth:`_offer_requested_work`. A wizard click is uncapped and never
        # refused.)
        if job.item is None or job.counter is None:
            return
        entry = autofix.QueuedTask(
            id=autofix.queue_key(job.audit_action, job.item),
            job=job,
            attempt=attempt,
        )
        self._staged_queue = self._staged_queue + [entry]

    def commit_queue(self) -> None:
        """Publish this poll's deferrals as the queue, arranged by the operator's
        saved order. Called only after a fully successful cycle — see
        ``_staged_queue``.

        The LAST offer of a key wins, and its place in the queue is where it was
        first offered: within one poll the reconcilers run after the edge-trigger and
        carry the backoff-aware attempt number, so theirs is the job that should run,
        while the position is the same task's either way.

        Work already starting is left out of the published list. It is still offered —
        the attempt record that stops it being offered is written when its spawn
        answers — so a poll landing mid-dispatch would draw it a second time, back in
        the queue it just left. It keeps its place in the saved ARRANGEMENT, because a
        start that fails is re-offered, and dropping the key would send it to the
        back."""
        staged = self._staged_queue + self._comms_kept_adopted(self._staged_queue)
        # A root whose read failed offered nothing this cycle; its rows stand.
        offered = {e.id for e in staged}
        staged += [e for e in self.queued_tasks if e.id not in offered
                   and e.job.item is not None and self._held(e.job.item)]
        by_id = {e.id: e for e in staged}
        ordered = autofix.queue_order([e.id for e in staged], self.queued_task_order)
        self.queued_task_order = ordered
        starting = {e.id for e in self.starting_tasks}
        before = self.queued_tasks
        self.queued_tasks = [by_id[k] for k in ordered if k not in starting]
        waiting = {e.job.label for e in staged}
        self._forget_job_refusals(waiting.__contains__)
        if self.queued_tasks != before:
            self.tasks_changed.emit()

    # MARK: - the work the operator asks for
    #
    # A Review-PRs or Fix-issues sweep is expanded here into one queued task per PR /
    # per issue, rather than handed to a single agent as "review every draft PR of
    # mine" or "fix every open issue". On a repo with fifty of either that agent is
    # fifty jobs in one session: one context, one terminal, one machine, and no way to
    # see where it has got to or to stop it halfway. Split, each item is a row of the
    # Agent-tasks list, gets a bay of the task cap to itself, and runs when the cap has
    # room — behind the monitors' finds, ahead of the conflict fixes
    # (:func:`autofix.queue_band`).

    def request_review_sweep(self, cfg: review.ReviewConfig) -> tuple[int, int]:
        """Queue one review per PR ``cfg`` sweeps. Returns ``(queued, already)``.

        The PRs come from the panel's own last fetch rather than a fresh one: it is
        the list the operator was looking at when they pressed the button, which is
        the list they meant. One that merges or closes before its turn comes is
        dropped by the drain (:func:`autofix.still_owed`); one the sweep should not
        have caught in the first place is what **cancel** is for.

        Assembles a prompt per PR, so it runs OFF the UI thread (see
        :meth:`request_sweep_async`)."""
        targets = Filters.swept_prs(self.prs, cfg.sweep_author,
                                    cfg.include_drafts, cfg.include_ready)
        return self._request([
            autofix.RequestedWork(
                number=pr.number,
                url=pr.url,
                # The ban dimension, and only someone else's PR has one.
                author=pr.author if cfg.disposition == review.SpecificAuthor.THEIRS else "",
                config=cfg.for_pr(pr.number).prompt_payload(),
                repo=(cfg.home or self._primary()).key,
            )
            for pr in targets
        ])

    def request_issue_sweep(self, cfg: issues.IssueConfig) -> tuple[int, int]:
        """Queue one fix per issue ``cfg`` sweeps. Returns ``(queued, already)``.

        The issues come from the panel's own last fetch, for the same reason the PRs
        above do. What the drain cannot do for these is retire them: the monitor poll
        reads PRs, so nothing there notices an issue closing under a waiting ask. The
        swept prompt covers it instead — it re-reads the issue's state and stops if it
        has been dealt with since — and **cancel** is the way out of an ask the sweep
        should not have caught.

        Assembles a prompt per issue, so it runs OFF the UI thread (see
        :meth:`request_sweep_async`)."""
        targets = Filters.swept_issues(self.issues, cfg.target, cfg.sweep_author,
                                       cfg.unassigned_only)
        return self._request([
            autofix.RequestedWork(
                number=issue.number,
                url=issue.url,
                # The ban dimension. Only a scope that names one person has one,
                # matching the login the wizard would ban-check.
                author=issue.author if cfg.target == issues.Target.SOMEONE else "",
                config=cfg.for_issue(issue.number).prompt_payload(),
                repo=(cfg.home or self._primary()).key,
            )
            for issue in targets
        ])

    def _request(self, asks: list[autofix.RequestedWork]) -> tuple[int, int]:
        """Store and publish whichever of ``asks`` is not already queued, and say how
        many of each there were.

        An item already waiting keeps the ask it has instead of gaining a second: the
        queue is keyed by the ask, so two would be one row that dispatches twice (and
        the second dispatch would find the first agent still on it). That makes
        pressing SPAWN twice, or sweeping a scope that overlaps an earlier one,
        idempotent rather than a way to double up. Any other ask takes the place of a
        Pipeline ask nothing has started, which the Pipeline's switches would withdraw or
        pause."""
        def fresh_of(candidates: list[autofix.RequestedWork]) -> list[autofix.RequestedWork]:
            held = {r.key: r.pipeline for r in self.requested_work}
            starting = {e.id for e in self.starting_tasks}
            return [a for a in candidates if a.key not in held or (
                held[a.key] and not a.pipeline and a.key not in starting)]

        fresh = fresh_of(asks)
        if fresh:
            # Assembled BEFORE the asks are stored, so a core binary that cannot build
            # a prompt costs this press an error message rather than a list of asks
            # that fails the same way on every poll from here on.
            built = {a.key: self._requested_task(a) for a in fresh}
            with self._requested_lock:
                # Re-read under the lock and drop whatever arrived while the prompts
                # were being assembled. The set read above is stale by then: assembly
                # is a core subprocess per item, which is long enough for a second
                # sweep of an overlapping scope to have stored its own asks in the
                # meantime, and appending against the stale set would store those
                # items twice.
                fresh = fresh_of(fresh)
                if not self._pipeline_judged:
                    self._pipeline_stale |= {a.key for a in fresh if a.pipeline}
                taken = {a.key for a in fresh}
                self.requested_work = [r for r in self.requested_work
                                       if r.key not in taken] + fresh
                # Under the lock too: queued_tasks is read-modify-written, so a press
                # publishing outside it can write back a copy older than the other's.
                if fresh:
                    self._publish_requested([built[a.key] for a in fresh])
            self._bring_poll_forward(self._settled_load)
        return len(fresh), len(asks) - len(fresh)

    def request_sweep_async(self, cfg, done) -> None:
        """The sweep behind ``cfg`` on a worker thread, reporting
        ``(queued, already, error)`` through ``done``.

        On a thread because it assembles a prompt per item, and each of those is a
        ``diplomat-core`` subprocess: fifty of them on the UI thread is a frozen window
        for as long as it takes. ``done`` is called from the worker, so a Qt caller
        marshals it back itself (the wizards emit a signal)."""
        fan_out = (self.request_issue_sweep if isinstance(cfg, issues.IssueConfig)
                   else self.request_review_sweep)

        def work() -> None:
            try:
                queued, already = fan_out(cfg)
            except Exception as exc:  # noqa: BLE001 — a missing/wedged core binary
                done(0, 0, str(exc))
                return
            done(queued, already, "")

        self.start_background(work)

    def _requested_task(self, entry: autofix.RequestedWork) -> autofix.QueuedTask:
        """One ask as the queued task it stands for, memoised by ask and config.

        The memo is what keeps the prompt assembly to once per ask rather than once
        per poll: a task can wait in this list for hours, every poll re-offers it, and
        re-running the core binary fifty times each cycle to rebuild strings that
        cannot have changed is a subprocess storm for nothing.

        Keyed by the config as well as the ask, because the same item can be asked for
        twice with different answers — cancel a sweep, change the depth, sweep again —
        and a memo that matched on the key alone would hand the second ask the first
        one's prompt. And by its label and checkout, which follow the repo roots.

        Carries no ``ledger_key``: the telemetry ledger measures the monitors, not the
        asks. Nor a ``counter``, but for the Pipeline's asks
        (:attr:`autofix.RequestedWork.pipeline`), which its master switch pauses: no
        monitor owns any other, so no toggle pauses it and no auto-handled counter
        counts it."""
        roots = review.repo_roots()
        label = entry.label_among(len(roots))
        checkout = self._root_of(entry.repo).path if entry.repo else None
        stamp = (entry.config, label, checkout)
        cached = self._requested_tasks.get(entry.key)
        if cached is not None and cached[0] == stamp:
            return cached[1]
        # A fix carries its issue's link but no PR number: the dispatch dedup keys on a
        # PR number, which an issue's would collide with. The assignee claim, which
        # every machine sees, keeps two agents off one issue.
        is_pr = entry.action == autofix.QUEUE_REVIEW_ACTION
        # A Pipeline fix carries its effect's url, which its attempt record is found by.
        # Any other is built from the ask's root key, not its url (which may be empty), so
        # the run stays that root's even once the root is gone.
        link = entry.url if is_pr or entry.pipeline else (
            (self._root_named(entry.repo) or repo_of_key(entry.repo)).link(
                "issues", entry.number) if entry.item else None)
        where = (entry.config.get("home") or {}).get("path") or entry.config.get("checkout")
        task = autofix.QueuedTask(
            id=entry.key,
            job=autofix.AgentJob(
                kind=entry.action,
                audit_action=entry.action,
                label=label,
                prompt=promptcore.build_prompt(entry.config),
                pr_url=link,
                pr_number=entry.number if is_pr else None,
                author_login=entry.author or None,
                counter=PIPELINE_COUNTER if entry.pipeline else None,
                # A root's checkout is wherever that root is now, not where it was asked.
                checkout=checkout or where,
                **diplomacynetwork.terms(entry.config),
            ),
            attempt=1,
        )
        self._requested_tasks[entry.key] = (stamp, task)
        return task

    def _publish_requested(self, entries: list[autofix.QueuedTask]) -> None:
        """Put freshly asked-for reviews into the queue there and then.

        Without this they would appear on the next poll, up to a poll period after the
        press — and a press that leaves the panel exactly as it was reads as a press
        that did nothing. Re-arranged through the same :func:`autofix.queue_order` the
        commit uses, so the rows land in their band and in the operator's arrangement,
        not merely at the end."""
        tasks = self.queued_tasks + entries
        by_id = {t.id: t for t in tasks}
        ordered = autofix.queue_order([t.id for t in tasks], self.queued_task_order)
        self.queued_task_order = ordered
        self.queued_tasks = [by_id[k] for k in ordered]
        self.tasks_changed.emit()

    def _offer_requested_work(self) -> None:
        """Offer every ask nothing has started, alongside the monitors' own finds.

        This is the list's whole job in a poll. A monitor re-offers its work by finding
        it on GitHub again; nothing on GitHub says a PR or an issue was swept, so what
        re-offers these is the ask itself, until the dispatch that starts one takes it
        off (:meth:`_settle_requested`), the operator cancels it, or — for a review —
        the drain finds its PR closed (:meth:`_drain_queued_tasks`).

        An ask the Diplomacy Network carries (:attr:`autofix.RequestedWork.offered`) is
        left out while the book holds its offer's run. A run that left the book without
        running (withdrawn, unknown to the daemon, the switch off) leaves the ask to be
        offered again here; one the network gave up with its attempts used ends the
        ask, as a terminal run that came to nothing does.

        An ask whose prompt will not assemble is skipped rather than allowed to end
        the cycle. The press assembles every prompt before storing anything, but the
        memo that holds the results is process-local, so after a restart the core
        binary is met again here — once per standing ask, inside the poll. A raise
        from one of them would escape into the cycle's handler, which answers a
        failed poll by leaving the queue uncommitted: not one row short, but empty,
        the monitors' finds included, and with no row for the operator to cancel the
        offending ask by. Skipping keeps the ask for a later poll, which is what a
        core mid-self-update wants anyway.

        An ask in a repo that is no longer a root is dropped. While a root path fails to
        resolve (:func:`review.roots_complete`) its repo may be that one, so the ask is
        kept and skipped instead."""
        # Read together: the roots are re-read on a timer, and an ask is forgotten only
        # when the reading that left its repo out had every root path resolved.
        roots, complete = review.repo_roots(), review.roots_complete()
        keys = {r.key for r in roots}
        carried: set[str] | None = None
        for entry in self.requested_work:
            if entry.offered:
                if carried is None:
                    carried = {r.network for r in agentregistry.load() if r.network}
                if entry.offered in carried:
                    continue
                self._mark_offered(entry.key, "")
            if entry.repo and entry.repo.lower() not in keys:
                if complete:
                    self._forget_requested(entry.key)
                    activity.log("panel", "queue-drop",
                                 f"{entry.label_among(len(roots))} - {entry.repo} is no "
                                 f"longer a repo root, not run")
                continue
            try:
                task = self._requested_task(entry)
            except Exception as exc:  # noqa: BLE001 — a missing/wedged core binary
                self._note_unbuildable_ask(entry, exc)
                continue
            self._staged_queue = self._staged_queue + [task]

    def _note_unbuildable_ask(self, entry: autofix.RequestedWork, exc: Exception) -> None:
        """Say once, per ask, that its prompt would not assemble.

        Once because the poll meets the same ask every three minutes for as long as
        it stands, and a feed that repeats itself that often is one nobody reads."""
        if entry.key in self._unbuildable_logged:
            return
        self._unbuildable_logged.add(entry.key)
        activity.log("panel", "queue-skip",
                     f"{entry.label} — prompt would not assemble: {exc}")

    def _settle_requested(self, entry: autofix.QueuedTask, verdict: str) -> None:
        """Take an ask off the list once its dispatch has answered for it.

        Started is the obvious one. A BAN is the other: the agent would refuse to run
        for as long as the ban stands, and a row nothing will ever start is a row that
        lies about what this machine is going to do. Every other verdict leaves the ask
        alone - an in-flight PR, a window with no budget left and a terminal that failed
        to open are all reasons to try again next poll, which is exactly what staying in
        the list means. ``not_allowed`` is not among them because an ask can never draw
        it: the allowlist answers for the review monitor's own finds, and an ask is not
        one (``AgentJob.counter``).

        An offer to the Diplomacy Network is not a start: the ask stays, marked with its
        task, until that run finishes (:meth:`_retire_finished`) or the operator takes
        the offer back (:meth:`_forget_offered`); a run leaving the book any other way
        leaves the ask to be offered again (:meth:`_offer_requested_work`)."""
        if not entry.job.requested:
            return
        if isinstance(verdict, diplomacynetwork.Offered):
            self._mark_offered(entry.id, verdict.task)
        elif verdict in ("spawned", autofix.VERDICT_BANNED):
            self._forget_requested(entry.id)

    def _mark_offered(self, key: str, task: str) -> None:
        """Mark the ask ``key`` as carried by network ``task`` ("" for none)."""
        with self._requested_lock:
            self.requested_work = [
                dataclasses.replace(r, offered=task) if r.key == key else r
                for r in self.requested_work]

    def _forget_offered(self, task: str) -> None:
        for ask in self.requested_work:
            if task and ask.offered == task:
                self._forget_requested(ask.key)

    def _forget_requested(self, key: str) -> None:
        """Drop one ask by the queue key that is its identity, and with it the task
        built from it."""
        with self._requested_lock:
            self.requested_work = [r for r in self.requested_work if r.key != key]
        self._requested_tasks.pop(key, None)
        # A later sweep of the same item is a new ask, and is owed the same one report
        # if its prompt will not assemble either.
        self._unbuildable_logged.discard(key)

    def cancel_requested_work(self, task_id: str) -> None:
        """The queued row's "cancel": drop an ask the operator has changed their mind
        about, without starting it.

        A sweep is the one thing in this list that can be asked for by the fifty, and
        the only one GitHub does not answer for: a monitor's row leaves when the work
        is no longer owed, while an ask on a PR that is still open stands until it
        runs — and a fix stands whatever happens to its issue, the poll reading PRs
        alone. Without a way back out, a mis-aimed sweep is a day of agents nobody can
        call off. A pipeline ask's attempt record is concluded (:func:`pipeline.cancelled`),
        or its next sync would queue it again."""
        entry = next((e for e in self.queued_tasks if e.id == task_id), None)
        if entry is None or not entry.job.requested:
            return
        if entry.job.counter == PIPELINE_COUNTER:
            self._save_attempts(PIPELINE_ATTEMPTS, pipeline.cancelled(
                self._load_attempts(PIPELINE_ATTEMPTS), entry.job.kind, entry.job.pr_url or "",
                time.time()))
        self._forget_requested(entry.id)
        self._drop_queued_task(task_id)
        activity.log("panel", "queue-cancel", f"{entry.job.label} — cancelled, not run")
        self.refresh_activity()

    @staticmethod
    def pipeline_cancel_help(job: autofix.AgentJob) -> str | None:
        """What the queued row's cancel says of a pipeline ask; None for any other. Twin of
        ``Store.pipelineCancelHelp``."""
        if job.counter != PIPELINE_COUNTER:
            return None
        if job.kind == autofix.QUEUE_REVIEW_ACTION:
            return ("Drop this review from the queue without running it. The pipeline asks "
                    "for it again once the PR's head moves.")
        return ("Drop this fix from the queue without running it. The pipeline does not ask "
                "for it again; Start fix on the Pipeline screen does.")

    def _drain_queued_tasks(self, snaps: list, closed: set[int],
                            read: list[LocalRepo] | None = None) -> None:
        """Run the queue down into whatever room this device has, in the operator's
        order. This is what makes the drag order mean anything: it runs at the TOP of
        a poll, before the monitors offer their own finds, so a slot that freed since
        the last cycle goes to the work already waiting for it rather than to whatever
        this poll's fetch happens to list first.

        The list is re-checked against ``snaps`` — this cycle's read of my PRs — and
        against ``closed``, the PRs that have left the open state, before any of it is
        run: a queued task carries the verdict of the poll that staged it, which is as
        old as a whole poll period by the time a bay frees, and what filled that bay in
        the meantime was an agent working one of these same branches — or the author,
        landing the PR. Work the fetch no longer owes, and work on a PR that is no
        longer there to work on, leaves the list instead of spawning
        (:func:`autofix.still_owed`).

        That pass covers the whole queue, not the part the drain reaches: a row
        standing for work somebody already did is wrong on the panel exactly as it is
        wrong to start, and it is the rows of a machine with no room — which returns
        below on its first entry — that sit there longest.

        Capacity is re-counted per task because each spawn fills a slot. A spawn
        failure stops the drain: it means terminal automation is broken, not that this
        one task was unlucky, and each entry is taken off the list before it is tried —
        so walking the whole queue into the same failure would clear the panel of every
        queued row at once, for a reason none of them caused.

        A task in a repo outside ``read`` (the roots this cycle read, by default every
        root) is neither priced nor started: nothing this cycle speaks for it, and a root
        just taken out of Settings is no longer the operator's to work. Nor is a review
        request in a root whose last read of review requests failed. This cycle's commit
        keeps or drops its row (:meth:`commit_queue`)."""
        roots = review.repo_roots() if read is None else read
        polled = {r.key for r in roots}
        lab = {r.key for r in roots if r.is_gitlab}

        def outside(entry: autofix.QueuedTask) -> bool:
            action, _, item = entry.id.partition(":")
            split = split_item_key(item)
            if split is None:
                return self._queued_root_gone(entry.id)
            key = split[0].lower()
            return key not in polled or (
                action == REVIEW_REQ_ACTION and f"Review requests:{key}" in self._roots_unread)

        conflicting = {s.item for s in snaps if s.mergeable == "CONFLICTING"
                       or _undecided_merge_request(s, lab)}
        owing_reply = {s.item for s in snaps if s.threads_i_owe > 0}
        # Dropped here rather than left for this cycle's commit to omit: the commit is
        # the far side of two monitor runs, and a row already known to be answered
        # should not be sitting in the list underneath them, one "execute now" away
        # from spawning. Paused work is swept too — a switched-off monitor's row is
        # still a claim about what the PR owes.
        for entry in list(self.queued_tasks):
            # A task with no PR to ask about stands: that is a Fix-issues ask, numbered
            # in the issue space, and pricing issue #421 against the PRs closed this
            # cycle would retire it for something that happened to the PR of the same
            # number.
            if entry.job.item is None or outside(entry):
                continue
            if autofix.still_owed(entry.job.audit_action, entry.job.item,
                                  conflicting, owing_reply, closed):
                continue
            # An ask outlives its row by design — the row is rebuilt from it on every
            # poll — so it has to be forgotten as well as dropped, or this same cycle
            # offers it straight back. Logged because it is the one retirement neither
            # a dispatch nor the operator is behind: a row that vanished in silence
            # reads exactly like the review having run.
            if entry.job.requested:
                self._forget_requested(entry.id)
                activity.log("panel", "queue-drop",
                             f"{entry.job.label} — PR no longer open, not run")
            self._drop_queued_task(entry.id)
        for entry in self.drainable_tasks:
            # The list moves under this loop: it waits on a spawn per task, and an
            # "execute now" during one of those takes its row off the queue and starts
            # it there and then. Re-reading the queue is what keeps the drain from
            # dispatching that same task a second time when it reaches it.
            if not any(e.id == entry.id for e in self.queued_tasks):
                continue
            if outside(entry):
                continue
            # A task offered to the Diplomacy Network takes no bay of this machine's.
            if (not diplomacynetwork.enabled()
                    and self._auto_tasks_running() >= self.auto_task_limit):
                return
            # Finding room here is what re-arms the saturation notice. The gate's own
            # reset sits behind the capacity measurement this path skips, so without
            # this the feed would carry one `at-capacity` line for an unbounded run of
            # saturate-and-drain episodes instead of one apiece.
            self._capacity_logged = False
            verdict = self._run_queued_task(entry, forced=False)
            if verdict == "failed":
                return
            # Every remaining entry would be priced against the same windows and get
            # the same answer, and the dispatch has already re-staged this one for the
            # commit at the end of the cycle. Draining on would cost a round of
            # refusals to no end. The same holds for a disk below its floor.
            if verdict in (autofix.VERDICT_UNAFFORDABLE, autofix.VERDICT_LOW_DISK):
                return
            # A silent or stopping daemon takes none of the rest; a refusal of this
            # job's own leaves the next to be asked.
            if verdict == diplomacynetwork.VERDICT_REFUSED and not verdict.own:
                return

    def _drop_queued_task(self, task_id: str) -> None:
        """Take one task off the queue without starting it — the work it stands for
        is already done. Its place in the saved arrangement is left alone: that list
        drops keys nothing offers on the next commit (:func:`autofix.queue_order`),
        and a task that turns out to be owed after all should come back where the
        operator put it, not at the end."""
        remaining = [e for e in self.queued_tasks if e.id != task_id]
        if len(remaining) != len(self.queued_tasks):
            self.queued_tasks = remaining
            self.tasks_changed.emit()

    def is_paused(self, counter: str | None) -> bool:
        """Whether the monitor that owns this work is switched off.

        A switched-off monitor still finds its work and still queues it — what your
        PRs owe is worth seeing whether or not this machine is set to act on it — but
        nothing automatic starts it. It waits for "execute now", or for the toggle to
        come back on. That is the whole difference the two toggles make: they decide
        who starts the work, not whether it is known."""
        if counter == "review_requests":
            return not self.review_requests_enabled
        if counter in ("my_reviews", "conflicts"):
            return not self.pr_autofix_enabled
        if counter == PIPELINE_COUNTER:
            return not self.pipeline_enabled
        # A review the operator asked for: no monitor owns it, so neither toggle
        # speaks for it. Switching the monitors off says what this machine may go
        # looking for, not that it should stop doing what it was told — for an ask,
        # that is what :attr:`queue_auto_run` says.
        return False

    @property
    def drainable_tasks(self) -> list[autofix.QueuedTask]:
        """The queued tasks the drain may start, in the operator's order — everything
        whose monitor is still on, plus the reviews the operator asked for, which no
        monitor speaks for either way.

        Empty while :attr:`queue_auto_run` is off, including the asks: that switch is
        over the queue itself, not over what fills it."""
        if not self.queue_auto_run:
            return []
        owned = self._comms_owned
        return [e for e in self.queued_tasks if not self.is_held(e, owned)]

    def is_held(self, task: autofix.QueuedTask,
                owned: dict[str, frozenset[str]] | None = None) -> bool:
        """Paused, or a pipeline ask still stale (:attr:`_pipeline_stale`) or held by an
        unreadable ban list, unless a Slack ping took it as its ask: then it is
        asked-for work, which switching a monitor off never stops (:meth:`is_paused`)."""
        held = task.job.counter == PIPELINE_COUNTER and (
            self.ban_list_unreadable or task.id in self._pipeline_stale)
        return ((self.is_paused(task.job.counter) or held)
                and task.id not in (self._comms_owned if owned is None else owned))

    def _begin_starting(self, entry: autofix.QueuedTask) -> None:
        """Move one task out of the queue and into the starting band, where it stays
        for as long as its dispatch runs.

        Idempotent, and keyed by queue key like the queue itself: "execute now" marks
        the task on the GUI thread so the row answers the press, and the worker it
        starts goes through here again."""
        if any(e.id == entry.id for e in self.starting_tasks):
            return
        self.queued_tasks = [e for e in self.queued_tasks if e.id != entry.id]
        self.starting_tasks = self.starting_tasks + [entry]
        self.tasks_changed.emit()

    def _end_starting(self, task_id: str) -> None:
        """The spawn answered: the task is a running agent, or it is nothing. Either
        way the panel has its own row for what happened next."""
        remaining = [e for e in self.starting_tasks if e.id != task_id]
        if len(remaining) != len(self.starting_tasks):
            self.starting_tasks = remaining
            self.tasks_changed.emit()

    def _run_queued_task(self, entry: autofix.QueuedTask, *, forced: bool) -> str:
        """Dispatch one queued task past the capacity check its caller already made,
        and record the attempt its monitor would have recorded.

        ``forced`` is the operator's "execute now", and is the only thing that also
        overrides the spending budget and the disk floor. The drain does not: it is
        the machine starting its own automatic work, and a task that could not be
        afforded when it was found is not afforded by having waited in a list.

        Dispatched as ``SOURCE_AUTO`` whatever put it in the queue, including a review
        the operator asked for. That is not about who wanted the work but about what
        starting it costs: this dispatch spends a bay of the device's cap and its
        share of whatever pays for it, and the gate's panel branch is for the agent a
        click opens *now*, outside the cap entirely. What the operator's ask does
        change is the label — see :func:`autofix.dispatch_label`.

        That record is not bookkeeping polish: the whole retry ladder hangs off it. A
        queued dispatch that wrote none would look, to the very next poll after the
        agent exits, exactly like work never attempted — so an agent that finishes
        without clearing the conflict or leaving the review would be re-dispatched
        three minutes later, and again, with no backoff ever engaging.

        This is also the one place a task crosses from the queue into the starting
        band, whether the drain reached it or the operator clicked: it is a row on the
        panel the whole way across, never drawn twice and never missing."""
        self._begin_starting(entry)
        try:
            verdict = self.dispatch_agent(
                entry.job, autofix.SOURCE_AUTO, entry.attempt, bypass_capacity=True,
                forced=forced,
            )
        finally:
            # Paired with the line above whatever the dispatch does, because the band
            # is the one list a poll cannot rebuild: :meth:`commit_queue` leaves a
            # starting key out of the published queue deliberately. A raise that got
            # past here would leave a row that never resolves, over work nothing
            # re-offers — where the same raise costs only the poll it happened in.
            self._end_starting(entry.id)
        if verdict == "spawned":
            self._record_queued_attempt(entry)
            self._note_comms_started(entry)
        elif verdict == autofix.VERDICT_BANNED:
            self._note_comms_banned(entry)
        self._settle_requested(entry, verdict)
        return verdict

    def _record_queued_attempt(self, entry: autofix.QueuedTask) -> None:
        """Write the retry-backoff record for a task the queue dispatched, into the
        same per-monitor ledger that monitor writes itself: ``AgentJob.counter`` names
        the ledger, ``attempt_stamp`` is the stamp that monitor compares against. The
        Pipeline's records are its effects', written when asked for: the one this run
        is the attempt of is dated now (:func:`pipeline.spawned`)."""
        if entry.job.counter == PIPELINE_COUNTER:
            attempts = self._load_attempts(PIPELINE_ATTEMPTS)
            dated = pipeline.spawned(attempts, entry.job.kind, entry.job.pr_url or "",
                                     time.time())
            if dated != attempts:
                self._save_attempts(PIPELINE_ATTEMPTS, dated)
            return
        key = {
            "review_requests": "reviewReqAttempts",
            "my_reviews": "myReviewAttempts",
            "conflicts": "myConflictAttempts",
        }.get(entry.job.counter or "")
        if key is None or entry.job.item is None:
            return
        attempts = self._load_attempts(key)
        attempts[entry.job.item] = autofix.ReviewAttempt(
            entry.job.attempt_stamp, time.time(), entry.attempt
        )
        self._save_attempts(key, attempts)

    def execute_queued_task_async(self, task_id: str) -> None:
        """The queued row's "execute now": start this task immediately, past the
        holds that are the machine's own judgement.

        It stays AUTO work - same ``Auto · `` label, same auto-handled counter, and once
        running it occupies a slot like any other automatic agent, so the rest of the
        queue waits behind it. Of the five asymmetries the gate draws between a click
        and a monitor tick (capacity, disk, budget, counters, label) this borrows
        exactly three: the cap, the disk floor and the spending budget, which are the
        three the operator is overriding. All three are judgements of what this machine
        should do next, and the operator looking at the row knows something they do not.

        On a worker thread, like every other dispatch path: it assembles nothing but it
        does spawn a terminal. The row is moved into the starting band HERE, on the GUI
        thread, so it answers the press in the same repaint rather than a worker's
        round-trip later."""
        entry = next((e for e in self.queued_tasks if e.id == task_id), None)
        if entry is None:
            return
        self._begin_starting(entry)

        def work() -> None:
            self._execute_queued_task(entry)

        self.start_background(work)

    def _execute_queued_task(self, entry: autofix.QueuedTask) -> None:
        """One "execute now", start to finish.

        The feed line is written from the OUTCOME, never ahead of it: the PR can have
        gained an agent since the list was built, and the spawn can fail - announcing
        "started" before asking would report a launch that never happened in both."""
        verdict = self._run_queued_task(entry, forced=True)
        label = entry.job.label
        if verdict == "spawned":
            activity.log("panel", "queue-run",
                         f"{label} - offered for this machine to run at once"
                         if diplomacynetwork.enabled()
                         else f"{label} — started ahead of the task cap")
        # The rest are all logged by the step that decided them, but a feed line is
        # not an answer to a click: the row vanished and nothing opened, so say why in
        # the panel, as the wizards do for their own refusals.
        elif verdict == diplomacynetwork.VERDICT_REFUSED:
            self.error = f"{label} was not offered: {verdict.sentence}."
        elif verdict == "failed":
            self.error = f"{label} failed to spawn — see the activity log."
        elif verdict == autofix.VERDICT_IN_FLIGHT:
            self.error = f"{label}: an agent is already on this PR."
        elif verdict == autofix.VERDICT_BANNED:
            self.error = f"{label}: {self.ban_refusal(entry.job)}."
        elif verdict == autofix.VERDICT_NOT_ALLOWED:
            self.error = (f"{label}: the PR's author is not on the auto-review list "
                          "(add them, or review it from the wizard).")
        if verdict != "spawned":
            self.changed.emit()
        self.refresh_activity()

    def move_queued_task(self, task_id: str, onto: str) -> None:
        """Reorder the queue by drag: ``task_id`` lands where it was dropped relative
        to ``onto``. The arrangement is persisted, so it survives both the poll that
        rebuilds the list and the restart that empties it."""
        current = self.queued_tasks
        ordered = autofix.queue_reorder([e.id for e in current], task_id, onto)
        by_id = {e.id: e for e in current}
        self.queued_task_order = ordered
        self.queued_tasks = [by_id[k] for k in ordered]
        self.tasks_changed.emit()

    # MARK: - the one tick every agent question is a projection of

    def _agent_tick(self) -> agentstate.Tick:
        """Resolve every registered run against one pass of evidence. READ-ONLY.

        This is the single place the applet asks what its agents are doing. The dedup,
        the cap, the panel rows and the retirement are all projections of the result
        (:mod:`diplomat_runtime.agentstate`), so they cannot come to disagree — which is
        what four independent re-derivations of the same question did.

        Nothing here writes, retires or logs. The panel asks for the rows and the free
        slots on every repaint, so a read with consequences means a screenshot retires
        records and a redraw writes to the operator's activity feed — which is exactly
        what it did until this was split (found by rendering the panel headlessly and
        finding the warnings in the real feed afterwards). What the consequences are,
        and when they happen, is :meth:`_settle_agents`.

        Deliberately not cached either. The expensive part is the I/O, and that is
        already cached where it happens (:mod:`diplomat_app.probes`), so resolving
        again costs a file read and some set arithmetic. A cache here would instead buy
        a staleness window in which an agent that just finished still holds its bay —
        the exact class of wrong answer this whole mechanism exists to remove.
        """
        return self._tick_with(self._network_evidence(self.network_state))

    @staticmethod
    def _network_evidence(snapshot: network.Snapshot | None) -> agentstate.Observation:
        """With the switch off nothing asks the daemon, and the evidence says so."""
        if not diplomacynetwork.enabled():
            return agentstate.Observation.unavailable(diplomacynetwork.SWITCHED_OFF)
        return network.tasks(snapshot)

    def _tick_with(self, seen: agentstate.Observation,
                   records: list[agentstate.RunRecord] | None = None) -> agentstate.Tick:
        """:meth:`_agent_tick` against one daemon reading, for a caller that acts on that
        same reading. ``records``: the book as that caller read it before asking."""
        now = time.time()
        if records is None:
            records = agentregistry.adopt_pids(agentregistry.load())
        evidence = dataclasses.replace(
            probes.gather(records, now, merged=self._merged_prs, tokens=self._tokens_left),
            network=seen)
        t = agentstate.tick(records, evidence, now, self.auto_task_limit,
                            appconfig.run_deadline(), tuple(review.repo_roots()))
        with self._tick_lock:
            self._tick = t
        return t

    def _settle_agents(self) -> agentstate.Tick:
        """One tick, and the consequences of it: write back what was learned, retire
        what has ended, and report a probe that has gone quiet.

        Called from the poll and the display refresh — the two ticks that are meant to
        move the world on — and from nowhere that merely draws.
        """
        # The network daemon is asked in the settle itself, while the switch is on: one
        # reading for the verdicts and for what is done about them, so a run that reads
        # finished is priced from the snapshot that said so.
        networked = diplomacynetwork.enabled()
        if networked != self._switch_drawn:
            # Moved in the file, not here: Settings and the Network screen draw it again.
            self._switch_drawn = networked
            self.network_changed.emit()
        if not networked:
            # One the switch's own turn did not reach: booked as it went off, or left
            # by a Diplomat that quit first.
            self._drop_switched_off_runs()
        # The book is read first, so the snapshot is newer than every run judged by
        # it: a run booked in between would be ended by a row from before its offer.
        records = agentregistry.adopt_pids(agentregistry.load())
        snapshot = diplomacynetwork.state() if networked else None
        t = self._tick_with(self._network_evidence(snapshot), records)
        # A settle begun before the switch moved says nothing of the daemon as it is.
        if networked and diplomacynetwork.enabled():
            self._note_network_state(snapshot)
            self._note_network_claims(t)
        self._persist_run_changes(t)
        self._retire_finished(t, snapshot, self._withdraw_merged(t) if networked else set())
        self._note_unreadable_config()
        self._note_silent_probes()
        self._note_comms_runs({r.label: s.reason for r, s in t.rows
                               if s.state == agentstate.FAILED and not s.spent},
                              {r.label: s.reason for r, s in t.rows if s.spent})
        return t

    def _note_unreadable_config(self) -> None:
        """Say once per spell that the shared config exists and cannot be read (every
        setting reads as its default, the switch as last read), and redraw the panel and
        the Network screen as it turns. Say once that a config gone too long to be mid-save
        is forgotten."""
        unreadable = appconfig.read_known() is None and appconfig.path().exists()
        gone = appconfig.forgotten_configs()
        if gone != self._config_gone_logged:
            self._config_gone_logged = gone
            activity.log("auto", "warn", appconfig.gone_note())
            self.refresh_activity()
        if unreadable == self._config_unreadable_logged:
            return
        self._config_unreadable_logged = unreadable
        if unreadable:
            activity.log("auto", "warn", appconfig.unreadable_note())
            self.refresh_activity()
        self.network_changed.emit()

    def _note_silent_probes(self) -> None:
        """Say out loud when a probe has stopped answering.

        This is the failure with no symptom of its own. Every other bug here shows up
        as a wrong row; a probe going quiet shows up as rows that are merely *less
        certain*, which looks exactly like an applet working correctly. Left unsaid,
        the operator sees agents pile up holding bays and has no way to know that the
        reason is a tmux server that died an hour ago.

        Once per probe per episode, cleared when it answers again — the same shape as
        the at-capacity note, for the same reason.
        """
        for h in probes.health():
            was = self._probe_warned.get(h.name, False)
            if h.silent and not was:
                self._probe_warned[h.name] = True
                activity.log("auto", "probe-silent",
                             f"Agent {h.name} {h.reason or 'cannot be read'} — agent "
                             f"rows will read “unknown” and keep their slots until it "
                             f"answers again")
                self.refresh_activity()
            elif not h.silent and was:
                self._probe_warned[h.name] = False
                activity.log("auto", "probe-recovered", f"Agent {h.name} readable again")
                self.refresh_activity()
        self._note_stale_busy_marker()
        self._note_blind_budget_gate()

    def _note_blind_budget_gate(self) -> None:
        """Say out loud when the budget gate has nothing left to gate on.

        What is left of the rate-limit window comes from one probe, and
        ``budget_decide`` SKIPS a ceiling it cannot read — with the window unreadable
        every task is affordable. So a probe that stops answering does not fail the
        gate closed or loudly: it stops gating, while the toggle still reads on and
        nothing else looks wrong. A stale ``.credentials.json`` did exactly that here
        for four days, ending in a night of agents dispatched into an exhausted weekly
        window.

        Only what was measured is stated: rounds asked, none answered. Whether that is
        a dead credential, a revoked login or an endpoint outage is the operator's to
        find out, and the wording must not guess.
        """
        from diplomat_runtime import quota

        rounds, readings = quota.probe_stats()
        if (readings or rounds < self._QUOTA_SAMPLE or self._quota_warned
                or not autobudget.enabled()):
            return
        self._quota_warned = True
        activity.log("auto", "warn",
                     f"Asked what is left of the rate-limit window {rounds} times "
                     f"without one answer — the automatic budget is gating on nothing, "
                     f"and auto work will dispatch whatever the limits have left")
        self.refresh_activity()

    def _note_stale_busy_marker(self) -> None:
        """Say out loud when no CLI's interrupt hint has ever once matched.

        Telling a working agent from one waiting at its prompt rests on literal
        strings borrowed from someone else's UI (``apiwatch.BUSY_MARKERS``). If the
        runner in use rewords its status bar, every agent reads as idle at once: every
        bay of the cap frees, and the monitors dispatch a burst onto a machine that is
        already full. Nothing else on this screen would look wrong.

        So a machine that has read plenty of agent screens and never seen a hint on
        any of them is reported. It is not proof — every agent really can be idle —
        which is why the threshold is high and the wording says what was measured
        rather than what it means.
        """
        read, seen = probes.marker_stats()
        if seen or read < self._MARKER_SAMPLE or self._marker_warned:
            return
        self._marker_warned = True
        markers = " / ".join(f"“{m}”" for m in apiwatch.BUSY_MARKERS)
        activity.log("auto", "warn",
                     f"Read {read} agent screens without once seeing {markers} — if "
                     f"the CLI reworded it, every agent now reads as idle and the "
                     f"task cap will not hold")
        self.refresh_activity()

    def _persist_run_changes(self, t: agentstate.Tick) -> None:
        """Write back the three things a tick learns about a run: the pid its shell has
        since written, the tty its process turned out to be on, and how its screen
        compared to the one the last tick saw.

        The last of those is the only one measured ACROSS ticks rather than within one,
        so it is the only one that is worthless unless written down: unpersisted, every
        tick re-reads a screen it has no memory of, the stillness clock restarts at
        zero, and the twenty-minute backstop can never elapse however long a wedged
        agent sits there.

        Merged into whatever is on disk NOW rather than replacing the book with this
        tick's copy of it. A spawn that registered while this tick was resolving would
        otherwise be dropped — an agent nothing counts, which is a bay of the cap the
        machine can then spend twice.

        A synthesized row is APPENDED, having none on disk to merge into — that memory
        is the whole reason one is kept rather than re-derived from the process table
        every tick. Only a synthesized one: a tracked record missing from the book was
        retired while this tick resolved, and writing it back would raise the dead.
        """
        learned = {r.run_id: r for r in t.records}

        def merge(book: list[agentstate.RunRecord]) -> list[agentstate.RunRecord]:
            out = []
            for r in book:
                fresh = learned.get(r.run_id)
                if fresh is None:
                    out.append(r)
                    continue
                out.append(dataclasses.replace(
                    r,
                    pid=r.pid if r.pid is not None else fresh.pid,
                    # The fresher one wins here, unlike the pid: a synthesized run's
                    # tty follows whichever agent its PR's sighting currently names.
                    tty=fresh.tty or r.tty,
                    quiet_digest=fresh.quiet_digest,
                    quiet_since=fresh.quiet_since,
                ))
            booked = {r.run_id for r in book}
            out.extend(r for r in t.records if r.untracked and r.run_id not in booked)
            return out

        self._write_book(lambda: agentregistry.update(merge))

    def _write_book(self, write) -> bool:
        """Run one write to the run book and say whether it landed.

        A tick re-derives what it writes from the book on disk, so one that failed is
        simply written by a later tick: this only has to keep the feed to one line
        when the book stops taking writes, and one more when it takes them again.
        ``write`` returns False when it found nothing to write, which says nothing
        about the disk.
        """
        try:
            wrote = write()
        except OSError as exc:
            if not self._book_error:
                self._book_error = exc.strerror or str(exc)
                activity.log("auto", "warn",
                             f"Can't write the agent run book ({self._book_error}) "
                             f"— runs are not booked or retired until it saves")
            return False
        if self._book_error and wrote is not False:
            self._book_error = ""
            activity.log("auto", "poll-recovered", "Agent run book saving again")
        return True

    def _note_network_state(self, snapshot: network.Snapshot | None) -> None:
        answered = snapshot is not None
        back = self.network_answered is False and answered
        # updated_at moves on every write: no change to redraw for.
        same = answered == self.network_answered and (
            snapshot == self.network_state if snapshot is None or self.network_state is None
            else dataclasses.replace(snapshot, updated_at=None)
            == dataclasses.replace(self.network_state, updated_at=None))
        self.network_answered = answered
        if not same:
            self.network_state = snapshot
            self.network_changed.emit()
        if back:
            # Work held while the daemon was silent has somewhere to go again.
            self._bring_poll_forward(self._settled_load)

    def _note_network_claims(self, t: agentstate.Tick) -> None:
        logged = False
        for r, s in t.rows:
            if (r.network is None or s.state != agentstate.RUNNING
                    or r.network in self._network_claims_logged):
                continue
            self._network_claims_logged.add(r.network)
            activity.log(r.source, network.AUDIT_CLAIMED, f"{r.label or r.run_id} - {s.reason}")
            logged = True
        if logged:
            self.refresh_activity()

    def _withdraw_merged(self, t: agentstate.Tick) -> set[str]:
        """Withdraw each offer whose PR merged while the network carried it
        (:func:`agentstate.withdrawable`); return the runs whose withdrawal was not
        settled (:func:`diplomacynetwork.definite`). Those stay booked for a later tick
        to ask again: a task left in a pool is an agent started on work nobody wants."""
        unanswered: set[str] = set()
        for r in t.withdrawable:
            reply = diplomacynetwork.send(
                network.ROUTE_WITHDRAW,
                network.withdraw_body(r.network, network.WITHDRAW_MERGED))
            # Only a definite answer ends it. Asking again is safe: the daemon answers
            # a withdrawal of a task it no longer holds as done.
            if not diplomacynetwork.definite(reply):
                unanswered.add(r.run_id)
                continue
            why = diplomacynetwork.refusal(reply)
            who = r.label or r.run_id
            activity.log(r.source, network.AUDIT_WITHDRAW,
                         f"{who} - its PR merged, so its offer is withdrawn" if why is None
                         else f"{who} - its PR merged; the network kept its offer: {why}")
        return unanswered

    def _record_network_outcomes(self, gone: list[agentstate.RunRecord],
                                 snapshot: network.Snapshot | None, now: float) -> bool:
        """Record what each retired network run cost, from its offer's outcome; say
        whether any was. An offer with no outcome, or that spent nothing, leaves its
        ledger entry open, like a run whose agent never answered.

        Run elsewhere, the runner is :data:`diplomacynetwork.RUNNER_ELSEWHERE`: those
        tokens came out of another account's limits (:attr:`telemetry.Task.anthropic`)."""
        seen = network.tasks(snapshot)
        if not seen.ok:
            return False
        offers = {o.task_id: o for o in snapshot.offers}
        recorded = False
        for r in gone:
            offer = offers.get(r.network) if r.network and r.ledger_key else None
            spent = offer.outcome if offer is not None else None
            if spent is None or not ((spent.tokens or 0) > 0 or (spent.usd or 0) > 0):
                continue
            here = seen.value[offer.task_id].executor_here
            telemetry.record_done(
                r.ledger_key, offer.ended_at or now, spent.tokens,
                agent_runner=spent.runner if here else diplomacynetwork.RUNNER_ELSEWHERE,
                usd=spent.usd, model=spent.model)
            recorded = True
        return recorded

    def _retire_finished(self, t: agentstate.Tick,
                         snapshot: network.Snapshot | None = None,
                         unwithdrawn: frozenset[str] | set[str] = frozenset()) -> None:
        """Price what has ended and drop it from the book.

        Only on positive evidence that the agent ended, or on the one clock the operator
        switched on for the runs no evidence reaches (Settings → STALLED AGENTS).

        The prompt comes out of the run directory, so an applet that restarted mid-agent
        can still attribute the run to its transcript; the in-memory list could not,
        and every such run landed in the ledger unpriced.

        A synthesized run is dropped here too, and priced by nothing: it has no ledger
        key, and no dispatch time, prompt or transcript to be priced from. Dropping it
        is the whole of what it needs, and it does need it: a record kept so the
        stillness backstop has a memory must not outlive the agent it remembers.

        A run whose window would not close is kept instead. Every reapable run is one
        this very tick saw ALIVE — the stillness rung only classifies a process already
        known to be up, and the deadline overrules the verdict that says so — so a
        refused kill means the agent is still working in a window nothing here can
        reach. Retiring it writes a completion into the ledger against that agent and
        deletes the directory holding the prompt and the exit stamp that would have
        priced it properly.

        Keeping the record is also what re-arms the backstop. Retired, the run comes
        back as an UNTRACKED row — which :func:`agentstate.past_deadline` refuses by
        name — so the deadline fired once against a window it could not close and then
        never again, for the flagship case it was built for: a tmux that will not dump a
        pane will not kill its session either.

        The record does not linger: the reaper stamps the refusal, both backstops go
        quiet for one of their own periods (:func:`agentstate._reap_cooling`), and the
        run is a RUNNING one holding its bay again until the next attempt. When its
        agent finally leaves, no backstop stamps the verdict at all and it retires and
        prices on the ordinary road.

        An automatic run its own runner reported done has its window closed as it
        retires (:meth:`_close_finished_windows`), and retires whether or not it closed.

        A network run has no window, session or transcript here: it is priced from
        ``snapshot``, the reading its verdict came from (:meth:`_record_network_outcomes`).
        ``unwithdrawn``: merged runs whose offer could not be taken back
        (:meth:`_withdraw_merged`); they stay booked.
        """
        refused = self._reap_wedged_windows(t) | unwithdrawn
        gone = [r for r in t.retirable if r.run_id not in refused]
        if not gone:
            return
        closed = self._close_finished_windows(t)
        # A 2.x OpenCode turn outlives its TUI (:func:`opencodeapi.interrupt`). Stopped
        # before pricing, so the export is final, and only with no TUI attached to it;
        # the reaper and the closer have already stopped the ones whose window they shut.
        reaped = {r.run_id for r in t.reapable + t.close_on_retire}
        sessions = [probes.service_session(r) for r in gone
                    if r.run_id not in reaped and r.runs_here]
        attached = set(probes.live_service_sessions()) if any(sessions) else set()
        for session_id in sessions:
            if session_id and session_id not in attached:
                opencodeapi.interrupt(session_id)
        # Every pricing input comes out of the run directory, so all of them must be
        # read before `forget` deletes it. A run that left no sentinel is dated by
        # `record_completion` from its transcript; now() is only ever the instant
        # this poll looked.
        now = time.time()
        failed = {r.run_id for r in gone
                  if (v := t.states.get(r.run_id)) is not None
                  and v.state == agentstate.FAILED}
        # A run whose command never ran has nothing to price - no agent, no transcript,
        # no tokens - and a completion against its key would count it among the finished
        # ones. Its ledger entry stays open, which is what it is: still owed.
        retired = [
            (r, agentregistry.finished_at(r.run_id), _run_prompt(r.run_id),
             agentregistry.bound_session(r.run_id),
             agentregistry.run_runner(r.run_id))
            for r in gone if r.ledger_key and r.run_id not in failed and r.runs_here
        ]
        # Only a run whose agent is done: a merge retires one that may still be filling
        # its review. Decided here, while the sentinel `forget` deletes is still there.
        audited = [(r.label or r.run_id, r.source, r.pr_url, r.dispatched_at)
                   for r in gone
                   if reviewaudit.checked_on_retire(r)
                   and (getattr(t.states.get(r.run_id), "state", None) == agentstate.FINISHED
                        or agentregistry.finished_at(r.run_id) is not None)]
        # Before anything is said or priced, because a run the book still holds is
        # retired again next tick: nothing below may happen to one that stays, or it is
        # logged and priced twice.
        if not self._write_book(lambda: agentregistry.forget({r.run_id for r in gone})):
            return
        for r in gone:
            verdict = t.states.get(r.run_id)
            if r.network and verdict is not None and (
                    verdict.state == agentstate.FINISHED or verdict.spent):
                self._forget_offered(r.network)
        concluded = autofix.concluded(gone, t.states)
        if concluded:
            key = "reviewReqAttempts"
            self._save_attempts(key, autofix.conclude(self._load_attempts(key), concluded, now))
        # A run whose agent said its turn was over answered its Pipeline effect, whatever
        # it left; one that died or failed leaves that attempt on the retry ladder.
        reported = [r for r in gone if getattr(t.states.get(r.run_id), "reported", False)]
        if reported:
            attempts = self._load_attempts(PIPELINE_ATTEMPTS)
            answered = pipeline.concluded(attempts, reported, now)
            if answered != attempts:
                self._save_attempts(PIPELINE_ATTEMPTS, answered)
        # Logged with the evidence that ended it, because forgetting deletes every trace
        # a run leaves: the record, the directory and the prompt all go, and a retirement
        # that turns out to be wrong is then a row that was simply not there any more.
        # This is the one line that says which rung decided.
        for r in gone:
            verdict = t.states.get(r.run_id)
            action = "spawn-failed" if r.run_id in failed else "retire"
            if not r.runs_here and verdict is not None:
                action = {agentstate.FINISHED: network.AUDIT_DONE,
                          agentstate.FAILED: network.AUDIT_FAILED}.get(verdict.state, action)
            activity.log(r.source, action,
                         f"{r.label or r.run_id} — "
                         f"{verdict.reason if verdict else 'no verdict'}")
        for r, ok in closed:
            who = r.label or r.run_id
            activity.log("auto", "kill-device",
                         f"closed {who}'s window — "
                         f"{t.states[r.run_id].reason.split('; ')[-1]}"
                         if ok else f"could not close {who}'s window; it stays open")
        self.refresh_activity()
        if audited:
            me = self.me
            self.start_background(lambda: self._audit_reviews(audited, me))
        probes.forget_adopted({r.run_id for r in gone})
        for r, exited_at, prompt, session_id, agent_runner in retired:
            telemetry.record_completion(r.ledger_key, prompt, r.dispatched_at,
                                        exited_at, now, session_id=session_id,
                                        agent_runner=agent_runner)
        self._network_claims_logged -= {r.network for r in gone if r.network}
        if self._record_network_outcomes(gone, snapshot, now) or retired:
            self.telemetry_changed.emit()

    def _audit_reviews(self, runs: list[tuple[str, str, str, float]], me: str) -> None:
        """Warn about each retired review run whose review did not go through
        GitHub's lifecycle (:mod:`diplomat_runtime.reviewaudit`). ``me`` is the gh
        login, not the username override: a PENDING review is listed to its author
        alone, and the agent posts as the login. A run on a GitLab merge request has no
        review the audit reads (:func:`reviewaudit.audit`), so it needs no gh login."""
        logged = False
        for label, source, url, since in runs:
            try:
                if not me and reviewaudit.pr_coordinates(url):
                    raise ValueError("the gh login is not known yet")
                found = reviewaudit.audit(url, me, since)
            except Exception as exc:  # noqa: BLE001 — a check that could not run says so
                found = [f"could not check its review: {exc}"]
            for line in found:
                activity.log(source, "warn", f"{label} {line}")
                logged = True
        if logged:
            self.refresh_activity()

    def _close_finished_windows(
            self, t: agentstate.Tick) -> list[tuple[agentstate.RunRecord, bool]]:
        """Close each :func:`agentstate.close_on_retire` run's window by the reaper's
        two routes, before ``forget`` deletes the directory its 2.x session binding is
        read from. :meth:`_retire_finished` logs the result once the book lets the run
        go; a run it keeps is closed again next tick.
        """
        out = []
        for record in t.close_on_retire:
            session_id = probes.service_session(record)
            if session_id:
                opencodeapi.interrupt(session_id)
            out.append((record,
                        tmuxwatch.kill_session(tmuxwatch.session_name(record.run_id))
                        or tmuxwatch.kill_window_for_tty(record.tty)))
        return out

    def _reap_wedged_windows(self, t: agentstate.Tick) -> set[str]:
        """Close the terminal of every run a backstop ended — the quiescence clock, or
        the operator's run deadline.

        Only those, and the verdict is asked rather than reconstructed
        (:func:`agentstate.reapable`). One whose screen has not changed in twenty
        minutes is nobody's, and so is one that has been going for four hours with
        nothing able to say it ever stopped. A run its runner reported done is
        :meth:`_close_finished_windows`'s, which retires it either way; a panel run
        that finished keeps its window, being the operator's own session.

        "FINISHED, and its stillness clock is past the timeout" is a WIDER set than
        that, because the clock advances only on ticks that saw the screen and so
        keeps maturing while nobody can look. An evidence outage that outlasts
        `QUIET_TIMEOUT` with the agent exiting inside it produces exactly one tick
        where a run is FINISHED-because-its-pid-is-gone while carrying twenty-plus
        minutes of stillness — and `pts/<n>` is recycled freely, so the tty it left
        behind may already belong to somebody else's shell by then.

        Closing it is not decoration on either verdict: an agent left alive is found
        again by the prompt scan the moment its record is retired, and comes straight
        back as an untracked row holding the same bay and the same PR, stripped of its
        label and with a completion recorded against it. So the window closing is what
        licenses the retirement, and a kill that reached nothing withholds it.

        Returns the runs whose window would NOT close, and stamps the refusal on each
        so both backstops wait out a period before ending it again.
        :func:`_retire_finished` keeps those rather than pricing them; see there for
        why, and :func:`agentstate._reap_cooling` for what the stamp buys.

        A run nobody dispatched is reaped like any other: a wedged session is just as
        dead whether or not this applet opened it.

        Its window is reached the same two ways a macOS run's is. By NAME first, keyed
        on the run id and so needing no tty — which is what a run whose pid was never
        adopted has, and the run deadline is the first backstop that can end one of
        those: the stillness clock needs a pane tail to compare against, so before it
        every reapable run had a tty. Then the tty, for a session this applet did not
        name - one spawned before names, and an agent it did not spawn.
        """
        refused: set[str] = set()
        for record in t.reapable:
            # A 2.x OpenCode turn outlives its window (:func:`opencodeapi.interrupt`).
            session_id = probes.service_session(record)
            if session_id:
                opencodeapi.interrupt(session_id)
            if not (tmuxwatch.kill_session(tmuxwatch.session_name(record.run_id))
                    or tmuxwatch.kill_window_for_tty(record.tty)):
                refused.add(record.run_id)
                # Once per episode: the stamp is None only before the first refusal.
                # A window nothing can close is retried for the life of the applet, and
                # the operator needs its held bay explained once, not once per period.
                if record.reap_refused_at is None:
                    activity.log("auto", "kill-device",
                                 f"could not close {record.label or record.run_id}'s "
                                 f"window — keeping the run and trying again")
                continue
            reason = t.states[record.run_id].reason
            activity.log("auto", "kill-device",
                         f"closed {record.label or record.run_id}'s window — "
                         f"{reason.split('; ')[-1]}")
        if refused:
            self._write_book(lambda: agentregistry.update(lambda book: [
                dataclasses.replace(r, reap_refused_at=t.now)
                if r.run_id in refused else r
                for r in book]))
        return refused

    def _in_flight(self, url: str) -> bool:
        """Does this PR already have an agent? Every state that is not over counts,
        including one waiting at its prompt (that session holds the PR's context) and
        one nothing is known about (releasing a PR on missing evidence is how two
        agents end up on it). A released agent does not: its run ended."""
        item = item_key_from_url(url)
        return item is not None and self._agent_tick().in_flight(item)

    def refresh_merged_statuses(self) -> None:
        """Ask GitHub or GitLab which of the tracked PRs have landed — the one terminal outcome
        that outranks whatever a process is doing.

        On the slow refresh, not the 8-second tick: it costs a ``gh`` or ``glab`` call per PR. The
        answer is carried forward by the fast ticks in between.

        Only the runs this applet dispatched: the resolver ends no untracked run on a
        merge, since a landed PR does not make its agent leave. What ends one of those
        is the scan that made it.
        """
        items = {r.item for r in agentregistry.load()
                 if r.item is not None and not r.untracked}
        self._merged_prs = probes.merged_prs(items, review.repo_roots())

    def refresh_token_budget(self) -> None:
        """Ask whether the account still has room to spend — the precondition on the
        resolver's run deadline.

        On the slow poll rather than the 8-second tick: this dials an endpoint over
        HTTPS, and the tick runs on the panel's repaint as well as on the poll. The
        ticks in between carry the answer forward.

        With the deadline switched off the endpoint is left alone: it is one small
        per-account bucket shared by every Claude Code session on the box, and the
        telemetry sampler already loses readings to it, so spending a round of it on a
        value :func:`agentstate.past_deadline` cannot consult is pure contention.
        """
        if appconfig.run_deadline() is None:
            # Dropped rather than carried: nothing refreshes this while the switch is
            # off, and switching it back on reaches the deadline on the panel's 8-second
            # tick, a poll interval before this runs again. Kept across that gap, the
            # reading arms the backstop off a balance as old as the switch was off for.
            self._tokens_left = agentstate.Observation.unavailable(
                "not probed with the deadline switched off")
            return
        # Off the book on disk rather than off the last tick: this runs on the poll,
        # where a tick may be seconds old, and a spawn since then is a run whose
        # currency the reading would otherwise miss.
        self._tokens_left = probes.tokens_left(
            agentregistry.runners_of(agentregistry.load()))

    # MARK: monitor persistence + poll-error state

    def _note_poll_failure(self, err: object) -> None:
        if self._poll_error_this_cycle is None:  # first failure of the cycle wins
            self._poll_error_this_cycle = str(err)

    def _settle_poll_error(self) -> None:
        err = self._poll_error_this_cycle
        if err:
            if self.autofix_poll_error is None:
                activity.log("auto", "poll-failed", f"Monitor poll failing: {err[:120]}")
            self.autofix_poll_error = err
            self.autofix_poll_error_at = time.time()
        elif self.autofix_poll_error is not None:
            activity.log("auto", "poll-recovered", "Monitor polls succeeding again")
            self.autofix_poll_error = None
            self.autofix_poll_error_at = None

    def _load_fingerprints(self) -> dict:
        raw = self._settings.value("autofixFingerprints", "", str)
        try:
            obj = json.loads(raw) if raw else {}
        except ValueError:
            return {}
        primary = self._primary().key
        out: dict[str, autofix.PRFingerprint] = {}
        for k, v in (obj or {}).items():
            try:
                out[migrate_item_key(k, primary)] = autofix.PRFingerprint(
                    mergeable=v.get("mergeable", "UNKNOWN"),
                    review_decision=v.get("reviewDecision", ""),
                    threads_unresolved=int(v.get("threadsUnresolved", 0)),
                )
            except (ValueError, AttributeError):
                continue
        return out

    def _save_fingerprints(self, fps: dict) -> None:
        obj = {
            str(k): {
                "mergeable": f.mergeable,
                "reviewDecision": f.review_decision,
                "threadsUnresolved": f.threads_unresolved,
            }
            for k, f in fps.items()
        }
        self._settings.setValue("autofixFingerprints", json.dumps(obj))

    def _load_attempts(self, key: str) -> dict:
        raw = self._settings.value(key, "", str)
        try:
            obj = json.loads(raw) if raw else {}
        except ValueError:
            return {}
        primary = self._primary().key
        out: dict[str, autofix.ReviewAttempt] = {}
        for k, v in (obj or {}).items():
            try:
                concluded = v.get("concludedAt")
                out[migrate_item_key(k, primary)] = autofix.ReviewAttempt(
                    requested_at=v.get("requestedAt", ""),
                    last_dispatched_at=float(v.get("lastDispatchedAt", 0.0)),
                    attempts=int(v.get("attempts", 1)),
                    concluded_at=None if concluded is None else float(concluded),
                )
            except (ValueError, AttributeError):
                continue
        return out

    def _save_attempts(self, key: str, attempts: dict) -> None:
        obj = {
            k: {
                "requestedAt": a.requested_at,
                "lastDispatchedAt": a.last_dispatched_at,
                "attempts": a.attempts,
                **({} if a.concluded_at is None else {"concludedAt": a.concluded_at}),
            }
            for k, a in attempts.items()
        }
        self._settings.setValue(key, json.dumps(obj))

    # MARK: telemetry samples

    def run_telemetry_sample_async(self) -> None:
        """Take one quota/token reading for the telemetry ledger, off the UI thread.

        Driven by its own timer rather than off the back of the auto-fix poll,
        because the two answer to different switches: the share of this machine's
        tokens that goes on the monitored repo is worth knowing whether or not
        the monitors are enabled, and pricing the rate-limit window needs an
        unbroken sample series regardless. :func:`telemetry.sample_due` does the pacing, so calling
        this more often than the sample interval is free.

        The quota probe insists (:func:`quota.week_left`), so a worker can outlive
        the gap between turns — and until it writes, :func:`telemetry.sample_due` still
        says a sample is owed. The lock is what keeps that from becoming several.
        """
        if not telemetry.sample_due():
            return
        if not self._telemetry_sample_lock.acquire(blocking=False):
            return  # a sample is already being taken

        def work() -> None:
            from diplomat_runtime import quota, usagescan

            try:
                try:
                    week = quota.week_left(insist=True)
                    totals = usagescan.totals()
                except OSError:
                    return  # an unreadable ~/.claude costs this sample, nothing else
                telemetry.record_sample(week, totals.repo, totals.other)
            finally:
                # Held until the sample is on disk: released a moment earlier, the
                # next turn would find `sample_due` still true and take a second one.
                self._telemetry_sample_lock.release()
            self.telemetry_changed.emit()

        self.start_background(work)

    # MARK: Claude-API-error watcher

    # The Linux port of Store.swift's runApiErrorScanOnce. A background scan (driven
    # by a QTimer in app.py, independent of the panel) reads every tmux pane's last
    # visible lines and, for any pane an AGENT is in that shows a Claude API error which
    # has stopped changing (a confirmed stall), submits the "continue" nudge to that
    # exact pane — so an agent that stalled on a transient server error (e.g. overnight
    # 529 overload) resumes on its own. Read every pane, write into few: the nudge is
    # submitted as a line of input, so a pane running a shell would RUN it. The pure
    # detection/backoff logic lives in apiwatch.py; the tmux reads/writes in
    # tmuxwatch.py.

    def run_apiwatch_poll_async(self) -> None:
        """Kick one watcher scan on a worker thread (guarded against overlap). Safe to
        call from a QTimer whether or not the panel is open; no-ops when disabled."""
        if not self.api_watch_enabled:
            return
        if not self._apiwatch_lock.acquire(blocking=False):
            return  # a scan is already running

        def work() -> None:
            try:
                self._apiwatch_scan_once()
            finally:
                self._apiwatch_lock.release()
                self.apiwatch_changed.emit()

        self.start_background(work)

    def _apiwatch_scan_once(self) -> None:
        """One scan: read the panes an agent is running in and nudge any
        confirmed-stalled erroring one that's outside its backoff window."""
        if not self.api_watch_enabled:
            return
        # None = a tmux command failed unexpectedly — skip the whole scan rather than
        # treating it as "no panes", which would wrongly clear every backoff.
        panes = tmuxwatch.dump_panes()
        available = tmuxwatch.is_available()
        now = time.time()
        # The other half of "may this pane be written to". An unreadable process table
        # skips the scan for the same reason a failed pane dump does, and more: the
        # answer decides whether a line of text is typed into somebody's shell, so
        # not knowing has to mean not typing.
        on_an_agent = probes.ttys_running_an_agent(now)
        if panes is None or not on_an_agent.ok:
            self.apiwatch_status = {
                "updatedAt": now,
                "watching": 0,
                "continues": self.api_watch_continues,
                "tmux": available,
            }
            return
        # tmux spells a tty `/dev/pts/13` and `ps` spells it `pts/13`.
        watched = [p for p in panes
                   if p.tty.removeprefix("/dev/") in on_an_agent.value]
        erroring: set[str] = set()
        for p in watched:
            # Out-of-quota banners return False here: a quota-limited agent can't
            # progress until its window resets, so only transient errors are nudged.
            if not apiwatch.looks_like_api_error(p.tail):
                continue
            erroring.add(p.pane_id)
            # Idle-confirmation: only nudge a pane whose erroring tail is UNCHANGED
            # since the previous scan.
            stalled = apiwatch.is_confirmed_stall(
                self._apiwatch_seen_tail.get(p.pane_id), p.tail
            )
            self._apiwatch_seen_tail[p.pane_id] = p.tail
            if not stalled:
                continue
            b = self._apiwatch_backoff.get(p.pane_id)
            if b and now < b["nextAllowed"]:  # still inside this pane's backoff window
                continue
            if not tmuxwatch.send_continue(p.pane_id, apiwatch.CONTINUE_MESSAGE):
                continue  # pane vanished — don't count a nudge that never landed
            self.api_watch_continues += 1
            nxt = apiwatch.next_backoff(b["interval"] if b else None)
            self._apiwatch_backoff[p.pane_id] = {
                "nextAllowed": now + nxt,
                "interval": nxt,
            }
            activity.log(
                "auto", "nudge",
                f"Continued a stalled agent (API error) on {p.pane_id}; "
                f"next retry in ≥ {apiwatch.human_interval(nxt)}",
            )
        # Keep backoff + idle-confirmation state ONLY for currently-erroring panes: a
        # pane that stopped erroring has recovered (reset to base), and a closed pane's
        # entry must not linger. tmux never recycles a pane_id, but pruning keeps the
        # maps bounded and forces a fresh two-scan confirmation if it errors again.
        self._apiwatch_backoff = {
            k: v for k, v in self._apiwatch_backoff.items() if k in erroring
        }
        self._apiwatch_seen_tail = {
            k: v for k, v in self._apiwatch_seen_tail.items() if k in erroring
        }
        self.apiwatch_status = {
            "updatedAt": now,
            "watching": len(watched),
            "continues": self.api_watch_continues,
            "tmux": available,
        }

    # MARK: Comms, the Slack watcher
    #
    # The tick, the fold and each ping's plan are the core's (:mod:`comms`). Here the plan
    # is acted on through the queue every other ask goes through, so the ban list, the
    # task cap and the budget gate all still apply.

    #: Starts the outcome of a ping whose sender it got banned.
    COMMS_BANNED_OUTCOME_PREFIX = "banned "
    #: A ping from a sender banned before or during its apply.
    COMMS_SENDER_BANNED_OUTCOME = "the sender is banned for prompt injection, so nothing was done"
    COMMS_BAN_REFUSAL = "is banned for prompt injection"

    @classmethod
    def comms_stopped_by_ban(cls, item: dict) -> bool:
        """Its queued task left the queue because the dispatch gate found a ban
        (:meth:`_note_comms_banned`)."""
        return comms.left_queue(item) and str(item.get("outcome") or "").endswith(
            cls.COMMS_BAN_REFUSAL + ")")

    def comms_settings_payload(self) -> dict:
        """The ``CommsSettings`` JSON a tick and a plan are given."""
        roots = review.repo_roots()
        return {
            "keywordsRaw": self.comms_keywords_raw,
            "senderAllowlistRaw": self.comms_sender_allowlist_raw,
            "model": self.comms_model,
            "batchSize": self.comms_batch_size,
            "flushAfterSecs": self.comms_flush_after_secs,
            "repos": [r.key for r in roots],
            "gitlabHosts": {r.key: r.host for r in roots if r.is_gitlab},
            "login": self.effective_me,
            "bannedSenders": bans.slack_ids(bans.read()),
        }

    def comms_toggles(self) -> dict:
        return {"requests": self.comms_act_requests, "bumps": self.comms_act_bumps,
                "investigations": self.comms_act_investigations}

    @property
    def comms_unread(self) -> int:
        seen = comms.parse_iso(self.comms_seen_at)
        count = 0
        for item in self.comms_items:
            if comms.is_extra_target(item.get("message") or {}):
                continue
            at = comms.parse_iso(str(item.get("at", "")))
            if seen is None or (at is not None and at > seen):
                count += 1
        return count

    def mark_comms_seen(self) -> None:
        self.comms_seen_at = comms.iso()
        self.comms_changed.emit()

    def refresh_comms_feed(self) -> None:
        """A core that cannot answer leaves the rows as they were: an unreadable log is
        not an empty one. A queue key a single-repo build logged is read as the primary
        root's."""
        with self._comms_feed_lock:
            try:
                items = comms.feed()
            except (RuntimeError, promptcore.CoreBinaryMissing, ValueError):
                return
            primary = self._primary().key
            for i in items:
                if i.get("queueKey"):
                    i["queueKey"] = migrate_queue_key(str(i["queueKey"]), primary)
            self.comms_items = items
            owned: dict[str, set[str]] = {}
            for i in items:
                if i.get("queueKey") and comms.unstarted(i) and not comms.left_queue(i):
                    owned.setdefault(str(i["queueKey"]), set()).add(str(i["message"]["id"]))
            self._comms_owned = {k: frozenset(v) for k, v in owned.items()}

    def run_comms_poll_async(self) -> None:
        """The queue is changed back on the Qt thread (:meth:`_apply_comms_tick`)."""
        if not self.comms_enabled:
            return
        if not self._comms_lock.acquire(blocking=False):
            return

        def work() -> None:
            try:
                plan = self._comms_poll_once()
            except Exception as exc:  # noqa: BLE001 — a tick must never stop the timer
                plan = {"at": datetime.now().astimezone(), "error": str(exc),
                        "me": None, "pings": [], "items": []}
            finally:
                self._comms_lock.release()
            self._comms_ticked.emit(plan)

        self.start_background(work, name="comms-poll")

    def _comms_poll_once(self) -> dict:
        """The slow half of a tick, off the Qt thread. Changes nothing in the queue.
        Held while the first root path does not resolve: the core reads a bare ``#N``
        as the first root's, which would be another repo's."""
        at = datetime.now().astimezone()
        if not review.primary_resolved():
            return {"at": at, "me": None, "pings": [], "items": [],
                    "error": f"waiting for the first repo root, "
                             f"{review.repo_root_paths()[0]}, to resolve to a GitHub "
                             f"or GitLab checkout"}
        settings = self.comms_settings_payload()
        result = comms.tick(settings)
        toggles = self.comms_toggles()
        fresh = list(result.get("items") or [])
        items = []
        for it in self._comms_stranded(fresh) + fresh:
            message, decision = it.get("message") or {}, it.get("decision") or {}
            try:
                effect = comms.effect(decision, message, toggles, settings)
            except (RuntimeError, promptcore.CoreBinaryMissing, ValueError) as exc:
                effect = {"kind": "none", "error": str(exc)}
            entry = {"message": message, "decision": decision, "effect": effect}
            if effect.get("kind") in ("review", "fix_issue"):
                entry["root"] = root = self._comms_root(str(effect.get("repo") or ""))
                if root is not None:
                    entry["target"] = self._comms_lookup(
                        effect["kind"], int(effect.get("number") or 0), root)
                    entry["me"] = self._comms_me(root)
            elif effect.get("kind") == "ban":
                entry["reported"] = self._comms_report_ban(effect["ban"])
            items.append(entry)
        with self._comms_feed_lock:
            self._comms_in_flight |= {str(e["message"].get("id", "")) for e in items}
        return {"at": at, "error": result.get("error"), "me": result.get("me"),
                "pings": result["pings"], "items": items, "notices": result["notices"]}

    def _comms_stranded(self, fresh: list[dict]) -> list[dict]:
        """Twin of ``applyComms``' first pass: a logged ping with no action, oldest first.
        An earlier tick delivered it and its apply never ran (the applet quit or handed
        over during the lookups), and the watermark is past it."""
        skip = {str((it.get("message") or {}).get("id", "")) for it in fresh}
        with self._comms_feed_lock:
            skip |= self._comms_in_flight
        try:
            logged = comms.feed()
        except (RuntimeError, promptcore.CoreBinaryMissing, ValueError):
            return []
        return [{"message": i["message"], "decision": i["decision"]}
                for i in reversed(logged)
                if not i.get("outcome") and i.get("decision")
                and str(i["message"].get("id", "")) not in skip]

    @staticmethod
    def _comms_root(repo: str) -> LocalRepo | None:
        """The repo root an effect's ``repo`` names (:func:`prref.root_named`; "" for the
        primary), or ``None`` when Settings dropped it after the ping was triaged."""
        roots = review.repo_roots()
        return root_named(repo, roots) if repo else roots[0]

    @staticmethod
    def _comms_ref(root: LocalRepo, number: int) -> str:
        """``#N``, or ``repo#N`` beside another repo root (:func:`item_label`)."""
        return item_label(item_key(root.owner, root.repo, number, root.host),
                          len(review.repo_roots()))

    @staticmethod
    def _comms_repo_name(root: LocalRepo) -> str:
        return "this repo" if len(review.repo_roots()) == 1 else root.slug

    def _comms_me(self, root: LocalRepo) -> str:
        """:meth:`me_for`, or "" while it cannot be read: then nothing is mine."""
        try:
            return self.me_for(root)
        except Exception:  # noqa: BLE001 — any failed read leaves the login unknown
            return ""

    def _comms_lookup(self, kind: str, number: int, root: LocalRepo) -> dict | None:
        """``{number, url, author, state}`` of ``root``'s ``#number``, open or not;
        ``None`` when its host does not know it; ``{"error": why}`` when it could not
        be asked. The panel's last fetch holds only some open work, so ``gh`` (``glab``
        on GitLab) answers the rest. ``gh issue view`` answers a PR's number too, with
        its ``/pull/`` url; GitLab numbers merge requests apart from issues."""
        want = item_key(root.owner, root.repo, number, root.host)
        listed = self.prs if kind == "review" else self.issues
        hit = next((i for i in listed if item_key_from_url(i.url) == want), None)
        if hit is not None:
            return {"number": hit.number, "url": hit.url, "author": hit.author,
                    "state": "OPEN"}
        from diplomat_runtime import gh, gitlab, glab

        try:
            if root.is_gitlab:
                project = urllib.parse.quote(root.slug, safe="")
                kinds = "merge_requests" if kind == "review" else "issues"
                obj = gitlab.item_view(json.loads(glab.run(
                    ["api", "--hostname", root.host, f"projects/{project}/{kinds}/{number}"],
                    timeout=30)))
            else:
                obj = json.loads(gh.run(["pr" if kind == "review" else "issue", "view",
                                         str(number), "--repo", root.slug,
                                         "--json", "number,url,author,state"], timeout=30))
        except Exception as exc:  # noqa: BLE001 — gh's own failures are all GHError
            # Both views' "no such number"; "Could not resolve to a Repository" shares
            # only the prefix. GitLab's is "404 Not found", its missing project's
            # "404 Project Not Found".
            if ("Could not resolve to" in str(exc) and "with the number of" in str(exc)
                    or "404 Not found" in str(exc)):
                return None
            return {"error": self.comms_snippet(str(exc), 120)}
        if not isinstance(obj, dict):
            return {"error": "gh printed no PR or issue"}
        return {"number": number, "url": str(obj.get("url") or ""),
                "author": str((obj.get("author") or {}).get("login") or ""),
                "state": str(obj.get("state") or "")}

    def _apply_comms_tick(self, plan: dict) -> None:
        """The Qt-thread half of a tick: publish what it found, notify each new ping, and
        act on each triaged one.

        A ping is notified once, in the tick that takes it, once that tick's answers are
        acted on; its triage, in that tick or a later one, notifies nothing. A sender on
        the list now, or banned by an earlier ping of this apply, has nothing else acted
        on, and no ping of theirs is notified: the ban's own notification says it."""
        items = plan.get("items") or []
        try:
            self.comms_last_poll = plan.get("at")
            if plan.get("me"):
                self.comms_identity = plan["me"]
            self._settle_comms_error(plan.get("error"))
            notices = plan.get("notices") or []
            for notice in notices:
                activity.log("auto", "comms-notice", notice)
            banned_now = set(bans.slack_ids(bans.read()))
            for entry in items:
                entry["sender_banned"] = (
                    str(entry["message"].get("userID") or "") in banned_now)
                self.apply_comms_item(entry)
                reported = entry.get("reported") or {}
                if (entry.get("effect") or {}).get("kind") == "ban" and not reported.get("error"):
                    banned_now.add(str(entry["effect"]["ban"].get("userID") or ""))
            self.refresh_comms_feed()
            if items or notices:
                self.refresh_activity()
            if self.comms_notify and self.comms_enabled:
                for message in plan.get("pings") or []:
                    if str(message.get("userID") or "") not in banned_now:
                        self.comms_pinged.emit(*self._comms_notification(message))
        finally:
            with self._comms_feed_lock:
                self._comms_in_flight -= {str(e["message"].get("id", "")) for e in items}
        self.comms_changed.emit()

    def _settle_comms_error(self, error: str | None) -> None:
        """Audited only on the way into failing and back."""
        before = self.comms_error
        self.comms_error = error or None
        if self.comms_error and not before:
            activity.log("auto", "comms-error", self.comms_error)
        elif before and not self.comms_error:
            handle = (self.comms_identity or {}).get("handle", "")
            activity.log("auto", "comms-recovered",
                         "Slack watcher working again" + (f" as @{handle}" if handle else ""))

    @staticmethod
    def comms_snippet(text: str, limit: int = 80) -> str:
        flat = " ".join(str(text).split())
        return flat if len(flat) <= limit else flat[:limit - 1] + "…"

    @staticmethod
    def comms_place(message: dict) -> str:
        """Twin of ``CommsMessage.place``."""
        return "DM" if message.get("isDM") else f"#{message.get('channelName', '')}"

    @staticmethod
    def comms_sender(message: dict) -> str:
        """Twin of ``CommsMessage.sender``."""
        return str(message.get("userName") or message.get("userID") or "")

    def _comms_notification(self, message: dict) -> tuple[str, str]:
        """Worded as ``CommsNotifier.post`` words it."""
        return (f"Slack · {self.comms_place(message)} from {self.comms_sender(message)}",
                self.comms_snippet(message.get("text", ""), 160))

    def apply_comms_item(self, entry: dict) -> str:
        """Act on one triaged ping; returns the outcome its `action` line records.

        ``entry`` is ``{message, decision, effect}``, plus ``root`` (:meth:`_comms_root`)
        and ``target`` (:meth:`_comms_lookup`) for a review or a fix, and ``sender_banned``
        for a sender on the ban list (:meth:`_apply_comms_tick`). Every ping ends in
        exactly one `action` line, even from a tick landing after Comms was switched off:
        the core has already logged its pings."""
        message, effect = entry["message"], entry.get("effect") or {"kind": "none"}
        msg_id = str(message.get("id", ""))
        where, sender = self.comms_place(message), self.comms_sender(message)
        kind = effect.get("kind")
        refused = (self.comms_enabled and entry.get("sender_banned")
                   and kind not in ("none", "ban"))
        line = f"{where} from {sender}: {self.comms_snippet(message.get('text', ''))}"
        if not comms.is_extra_target(message):
            activity.log("auto", "comms-ping",
                         line + (f" ({self.COMMS_SENDER_BANNED_OUTCOME})" if refused else ""))
        if kind == "ban":
            # Reported in the tick's worker half, so it stands whatever the switch says.
            outcome = self._comms_ban_outcome(effect["ban"], entry["reported"])
            comms.append_event("action", msg_id, outcome=outcome)
            return outcome
        if not self.comms_enabled:
            outcome = "Comms was switched off, so ping only"
            comms.append_event("action", msg_id, outcome=outcome)
            return outcome
        if refused:
            comms.append_event("action", msg_id, outcome=self.COMMS_SENDER_BANNED_OUTCOME)
            return self.COMMS_SENDER_BANNED_OUTCOME
        number = int(effect.get("number") or 0)
        repo = str(effect.get("repo") or "")
        verb, work, front = None, None, True
        if kind == "review":
            verb = "comms-review"
            outcome, work = self._comms_review(number, repo, entry.get("root"),
                                               entry.get("target"), entry.get("me", ""))
        elif kind == "fix_issue":
            verb = "comms-fix"
            outcome, work = self._comms_fix(number, repo, entry.get("root"),
                                            entry.get("target"), entry.get("me", ""))
        elif kind == "investigate":
            verb, front = "comms-investigate", False
            outcome, work = self._comms_investigate(effect["config"])
        elif kind == "bump":
            verb = "comms-bump"
            outcome = self._comms_bump(number, repo)
        else:
            outcome = self._comms_none_outcome(entry)
        # The ask, its owner and its line under one lock: a drain's dispatch or a
        # worker's feed in between would find the ask with no ping owning it.
        with self._comms_feed_lock:
            key = label = running = None
            if work is not None:
                # Work already running, or waiting under a monitor's key, is not asked for
                # twice: the ping takes that work's key and label instead.
                suffix = ", at the front of its band" if front else ""
                running = self._comms_row_doing(work.key, self.running_tasks)
                twins = self._comms_twin_keys(work.key)
                # A paused monitor's find too: once a ping owns it, it drains like an ask
                # (:meth:`is_held`) and stays queued until it runs
                # (:meth:`_comms_kept_adopted`).
                twin = None if running else next(
                    (t for t in self.starting_tasks if t.id in twins),
                    next((t for t in self.queued_tasks if t.id in twins), None))
                if running is not None:
                    outcome, key, label = "already running", work.key, running.label
                elif twin is not None:
                    self._comms_adopted = {**self._comms_adopted, twin.id: twin}
                    if front:
                        self._move_to_band_front(twin.id)
                    outcome, key, label = "already queued" + suffix, twin.id, twin.job.label
                else:
                    # `outcome` is still the work's name ("review of #N").
                    try:
                        fresh = self.request_one(work, front=front)
                    except Exception as exc:  # noqa: BLE001 — a missing/wedged core binary
                        outcome = f"{outcome} could not be queued: {exc}"
                    else:
                        outcome += (" queued" if fresh else " was already queued") + suffix
                        key, label = work.key, work.label
            if key is not None and running is None:
                owners = self._comms_owned.get(key, frozenset()) | {msg_id}
                self._comms_owned = {**self._comms_owned, key: owners}
            comms.append_event("action", msg_id, outcome=outcome, queue_key=key, label=label)
            if running is not None:
                comms.append_event("started", msg_id, label=running.label,
                                   when=self._comms_dispatched(running))
        if verb is not None:
            activity.log("auto", verb, f"{label + ' — ' if label else ''}{outcome}; "
                                       f"asked by {sender} in {where}")
        return outcome

    def _comms_none_outcome(self, entry: dict) -> str:
        """Why a ping moved nothing."""
        if (entry.get("effect") or {}).get("error"):
            return f"not acted on: {entry['effect']['error']}"
        if comms.from_banned_sender(entry.get("decision")):
            return "not triaged: the sender is banned for prompt injection"
        action = (entry.get("decision") or {}).get("action", "none")
        switch = {"review": "requests", "fix_issue": "requests", "bump": "bumps",
                  "investigate": "investigations"}.get(action)
        if switch is None:
            return "no action"
        return f"{action} not acted on: acting on {switch} is switched off"

    def _comms_report_ban(self, ban: dict) -> dict:
        """Put a sender the triage caught on the ban list: ``{"daemon": bool, "error":
        why not | None}``, or ``{"already": True}`` for one already there (a stranded
        ping whose ban stands, or a second message in one tick).

        A daemon older than Slack bans lists the bare user id, which the report lifts
        again; no read of the list, during the report or after, announces that entry."""
        user_id = str(ban.get("userID") or "")
        if bans.is_banned(bans.slack_login(user_id), bans.read()):
            return {"already": True}
        bare = user_id.lower()
        with self._bans_known_lock:
            self._bans_quiet.add(bare)
        try:
            done = bans.report_comms_ban(ban)
        finally:
            left = {(b.login.lower(), b.at or "") for b in bans.read() if b.login.lower() == bare}
            with self._bans_known_lock:
                self._bans_quiet.discard(bare)
                if self._bans_known is not None:
                    self._bans_known |= left
        return {"daemon": done.by_daemon, "error": done.error}

    def _comms_ban_outcome(self, ban: dict, reported: dict) -> str:
        """A ban that happened has its feed line already (the daemon's, or
        :func:`bans.report_comms_ban`'s); one that did not gets one here."""
        who = f"@{ban.get('handle') or ban.get('userID') or '?'}"
        if reported.get("already"):
            return f"{who} is already banned for prompt injection"
        if reported.get("error"):
            why = f"could not ban {who} for prompt injection: {reported['error']}"
            activity.log("auto", "comms-ban", f"Comms {why} ({ban.get('permalink', '')})")
            return why
        return (f"{self.COMMS_BANNED_OUTCOME_PREFIX}{who} for prompt injection: "
                f"\"{self.comms_snippet(ban.get('evidence', ''), 120)}\"")

    def _comms_banned(self, login: str) -> bool:
        return bool(login) and bans.is_banned(login, bans.read())

    def _comms_review(self, number: int, repo: str, root: LocalRepo | None,
                      found: dict | None, me: str) -> tuple[str, autofix.RequestedWork | None]:
        """``("review of #N", the ask)`` (the Review wizard's single-PR default) or
        ``(why there is none, None)``. ``root`` is :meth:`_comms_root`'s answer for
        ``repo``, ``found`` :meth:`_comms_lookup`'s, ``me`` :meth:`_comms_me`'s."""
        if root is None:
            return f"{repo}#{number} is not in a repo root", None
        ref = self._comms_ref(root, number)
        if found is None:
            return f"{ref} is not a PR of {self._comms_repo_name(root)}", None
        if "error" in found:
            return (f"couldn't ask {'GitLab' if root.is_gitlab else 'GitHub'} about PR {ref} "
                    f"({found['error']})"), None
        state = str(found.get("state", ""))
        if state.upper() != "OPEN":
            return f"PR {ref} is {state.lower()}", None
        author = str(found.get("author", ""))
        if self._comms_banned(author):
            return f"PR {ref} is by @{author}, who is banned; not queued", None
        mine = bool(me) and author.lower() == me.lower()
        cfg = review.ReviewConfig(
            target=PRTarget.SPECIFIC, specific_pr=str(number), me=me,
            specific_author=(review.SpecificAuthor.MINE if mine
                             else review.SpecificAuthor.THEIRS), home=root)
        return f"review of {ref}", autofix.RequestedWork(
            number=number, url=str(found.get("url", "")), author="" if mine else author,
            config=cfg.prompt_payload(), repo=root.key)

    def _comms_fix(self, number: int, repo: str, root: LocalRepo | None,
                   found: dict | None, me: str) -> tuple[str, autofix.RequestedWork | None]:
        """``("fix of issue #N", the ask)`` (the Fix-issues wizard's) or ``(why there is
        none, None)``, as :meth:`_comms_review`. Unlike a wizard fix it carries the
        issue's author as the ban dimension: somebody on Slack named the issue, not the
        operator."""
        if root is None:
            return f"{repo}#{number} is not in a repo root", None
        ref = self._comms_ref(root, number)
        if found is None:
            return f"{ref} is not an issue of {self._comms_repo_name(root)}", None
        if "error" in found:
            return (f"couldn't ask {'GitLab' if root.is_gitlab else 'GitHub'} about issue {ref} "
                    f"({found['error']})"), None
        # GitLab numbers merge requests apart from issues, so its issue answer is one.
        if not root.is_gitlab and "/issues/" not in str(found.get("url", "")):
            return f"{ref} is a pull request, not an issue", None
        if str(found.get("state", "")).upper() != "OPEN":
            return f"issue {ref} is {str(found.get('state', '')).lower()}", None
        author = str(found.get("author", ""))
        if self._comms_banned(author):
            return f"issue {ref} is by @{author}, who is banned; not queued", None
        mine = bool(me) and author.lower() == me.lower()
        cfg = issues.IssueConfig(target=issues.Target.SPECIFIC,
                                 specific_issue=str(number), me=me, home=root)
        return f"fix of issue {ref}", autofix.RequestedWork(
            number=number, url=str(found.get("url", "")), author="" if mine else author,
            config=cfg.prompt_payload(), repo=root.key)

    def _comms_investigate(self, cfg: dict) -> tuple[str, autofix.RequestedWork | None]:
        """``("investigation", the ask)`` in the checkout of the repo root the message
        is about (``InvestigateConfig.owner``/``repo``), or ``(why there is none,
        None)``."""
        slug = f"{cfg.get('owner', '')}/{cfg.get('repo', '')}"
        root = self._comms_root(slug)
        if root is None:
            return f"investigation of {slug} not queued: it is not a repo root", None
        if root != self._primary():
            cfg = {**cfg, "checkout": root.path}
        # The sender is its ban dimension (``InvestigateConfig.banLogin``), so a ban
        # landing while the ask waits stops it at dispatch.
        sender_id = str(cfg.get("senderID") or "")
        return "investigation", autofix.RequestedWork(
            number=int(cfg["number"]), url=str(cfg.get("permalink", "")),
            author=bans.slack_login(sender_id) if sender_id else "", config=cfg,
            repo=root.key)

    def _comms_bump(self, number: int, repo: str) -> str:
        """Moves whatever is queued for that item ("" = the primary root's)."""
        root = self._comms_root(repo)
        item = f"{root.key if root else repo.lower()}#{number}"
        moved = [t.id for t in self.queued_tasks if autofix.item_of_key(t.id) == item]
        for key in moved:
            self._move_to_band_front(key)
        if not moved:
            return f"nothing queued for {item_label(item, len(review.repo_roots()))}"
        return f"moved {', '.join(moved)} to the front of its band"

    def request_one(self, work: autofix.RequestedWork, *, front: bool = False) -> bool:
        """Returns whether the ask is new: one already waiting keeps the ask it had
        (:meth:`_request`)."""
        queued, _already = self._request([work])
        if front:
            self._move_to_band_front(work.key)
        return queued == 1

    def _move_to_band_front(self, key: str) -> None:
        ids = [t.id for t in self.queued_tasks]
        if key not in ids:
            return
        band = autofix.queue_band(key)
        first = next(i for i in ids if autofix.queue_band(i) == band)
        if first != key:
            self.move_queued_task(key, first)

    @staticmethod
    def _comms_key_parts(key: str) -> tuple[str, int] | None:
        """``(verb, number)`` of a queue key: its item's number, or an investigation's
        ts."""
        verb, _, rest = key.partition(":")
        split = split_item_key(rest)
        if split is not None:
            return verb, split[1]
        return (verb, int(rest)) if rest.isdigit() else None

    @staticmethod
    def _comms_twin_keys(key: str) -> list[str]:
        """The keys a monitor queues the same work under: a review requested of me on
        GitHub is the review a Slack message asks for."""
        verb, _, _ = key.partition(":")
        item = autofix.item_of_key(key)
        if verb != autofix.QUEUE_REVIEW_ACTION or item is None:
            return []
        return [autofix.queue_key(REVIEW_REQ_ACTION, item)]

    @staticmethod
    def _comms_row_doing(key: str, rows: list[autofix.RunningAgent]
                         ) -> autofix.RunningAgent | None:
        """Twin of ``commsRow``: any review agent on that PR (the dispatch gate treats
        every agent on a PR as that PR's), or a fix of that issue: by its link, else (a
        run recorded with none) by its label (:meth:`autofix.RequestedWork.label_among`)."""
        item = autofix.item_of_key(key)
        if item is None:
            return None
        verb = key.partition(":")[0]
        if verb in (autofix.QUEUE_REVIEW_ACTION, REVIEW_REQ_ACTION):
            return next((a for a in rows if a.item == item
                         and a.kind == autofix.QUEUE_REVIEW_ACTION), None)
        if verb == autofix.QUEUE_ISSUES_ACTION:
            return Store._fix_of(rows, item, item_label(item, len(review.repo_roots())))
        return None

    @staticmethod
    def _fix_of(rows: list[autofix.RunningAgent], item: str | None,
                named: str) -> autofix.RunningAgent | None:
        """The one of ``rows`` fixing that issue: by its run's link, else (a run
        recorded with none, as a Linear issue's fix always is) by its label naming it
        ``named`` (:meth:`autofix.RequestedWork.label_among`)."""
        return next((a for a in rows if a.kind == autofix.QUEUE_ISSUES_ACTION
                     and (a.item == item if a.item else f"Issues · {named} · " in a.label)),
                    None)

    @staticmethod
    def _comms_dispatched(row: autofix.RunningAgent) -> datetime | None:
        return datetime.fromtimestamp(row.started_at).astimezone() if row.started_at else None

    def _note_comms_started(self, entry: autofix.QueuedTask) -> None:
        """A queued task was dispatched: every ping that owns it records `started`
        (``commsSettled``), under the label its row wears. A find its monitor dispatches
        itself is started by :meth:`_note_comms_runs`.

        Under the settle lock: a settle whose tick predates this run's registration
        would otherwise read these `started` lines, find the run in no row and write
        it `finished` at once."""
        # Asked under the feed lock, which an ask holds until its owner is in.
        with self._comms_feed_lock:
            if not self._comms_owned.get(entry.id):
                return
        label = autofix.dispatch_label(autofix.SOURCE_AUTO, entry.job.label, entry.attempt,
                                       requested=entry.job.requested)
        with self._settle_lock, self._comms_feed_lock:
            owned = self._comms_owned
            owners = owned.get(entry.id)
            if not owners:
                return
            self._comms_owned = {k: v for k, v in owned.items() if k != entry.id}
            by_id = {str(i["message"]["id"]): i for i in self.comms_items}
            for msg_id in sorted(owners):
                self._comms_start(by_id.get(msg_id, {}), msg_id, label)
            self.refresh_comms_feed()
        self.comms_changed.emit()

    def _note_comms_banned(self, entry: autofix.QueuedTask) -> None:
        """An ask the dispatch refused for a ban is retired with it
        (:meth:`_settle_requested`): each ping that owned it says so, and why."""
        who = ("the sender" if (entry.job.author_login or "").startswith(bans.SLACK_PREFIX)
               else "the PR's author")
        with self._comms_feed_lock:
            owners = self._comms_owned.get(entry.id)
            if not owners:
                return
            self._comms_owned = {k: v for k, v in self._comms_owned.items() if k != entry.id}
            for msg_id in sorted(owners):
                comms.append_event("action", msg_id, outcome=(
                    f"{comms.LEFT_QUEUE} ({who} {self.COMMS_BAN_REFUSAL})"))
            self.refresh_comms_feed()
        self.comms_changed.emit()

    @staticmethod
    def _comms_start(item: dict, msg_id: str, label: str,
                     when: datetime | None = None) -> None:
        """Twin of ``commsStart``: a retry's start also replaces the outcome that said
        the last attempt never ran."""
        if comms.never_started(item) or comms.left_queue(item):
            comms.append_event("action", msg_id, outcome=comms.RETRIED)
        comms.append_event("started", msg_id, label=label, when=when)

    def _note_comms_spawn_failed(self, label: str, why: str) -> None:
        """Twin of ``commsSpawnFailed``: a ping may already have taken this run's row,
        still starting, as its start; it says the run never ran, or the `finished` its
        vanished row would earn reads as work done."""
        outcome = f"{comms.NEVER_STARTED} ({self.comms_snippet(why, 120)})"
        with self._comms_feed_lock:
            hit = [str(i["message"]["id"]) for i in self.comms_items
                   if i.get("label") == label and i.get("startedAt")
                   and not i.get("finishedAt") and not comms.never_started(i)]
            for msg_id in hit:
                comms.append_event("action", msg_id, outcome=outcome)
            if hit:
                self.refresh_comms_feed()
        if hit:
            self.comms_changed.emit()

    def _comms_kept_adopted(self, offered: list[autofix.QueuedTask]
                            ) -> list[autofix.QueuedTask]:
        """Twin of ``commsKeptAdopted``: the monitor finds pings adopted that a commit's
        offers left out. Each stays queued until it runs, its monitor no longer offering
        it (a withdrawn request, a failed spawn it has not found again). One adopted
        before this launch has no task here to put back, so its ping says it left the
        queue rather than read "queued" forever."""
        rows = self.running_tasks
        present = {e.id for e in offered} | {e.id for e in self.starting_tasks}
        kept: dict[str, autofix.QueuedTask] = {}
        with self._comms_feed_lock:
            owned = self._comms_owned
            adopted = {k: v for k, v in self._comms_adopted.items() if k in owned}
            adopted.update({e.id: e for e in offered if e.id in adopted})
            self._comms_adopted = adopted
            left: list[tuple[str, str]] = []
            for item in self.comms_items:
                key = str(item.get("queueKey") or "")
                parts = self._comms_key_parts(key)
                if (not key or key in present or key in kept or parts is None
                        or parts[0] in autofix.QUEUE_REQUESTED_ACTIONS
                        or not comms.unstarted(item) or comms.left_queue(item)
                        or self._comms_row_doing(key, rows) is not None):
                    continue
                if key in adopted and not self._queued_root_gone(key):
                    kept[key] = adopted[key]
                else:
                    left.append((str(item["message"]["id"]), key))
            for msg_id, key in left:
                comms.append_event("action", msg_id, outcome=f"{comms.LEFT_QUEUE} ({key})")
            if left:
                self.refresh_comms_feed()
        if left:
            self.comms_changed.emit()
        return list(kept.values())

    def _note_comms_runs(self, never_ran: dict[str, str] | None = None,
                         spent: dict[str, str] | None = None) -> None:
        """Twin of ``noteCommsRuns``; runs on every settle, Comms on or off.

        A ping that took a monitor's queued work records `started` once an agent row is
        doing it: :meth:`_note_comms_started` never hears a monitor's own dispatch.

        A started run whose agent left the rows, and whose ask is not waiting again,
        records `finished` - or, when ``never_ran`` (label -> reason) says its command
        never ran, :data:`comms.NEVER_STARTED`. One of ``spent`` (label -> reason), which
        the network gave up with its attempts used, finishes saying so."""
        never_ran = never_ran or {}
        spent = spent or {}
        waiting = {t.id for t in self.queued_tasks} | {t.id for t in self.starting_tasks}

        def monitors_find_out_of_the_queue(key: str) -> bool:
            parts = self._comms_key_parts(key)
            return (key not in waiting and parts is not None
                    and parts[0] not in autofix.QUEUE_REQUESTED_ACTIONS)

        live = [i for i in self.comms_items if i.get("queueKey") and not i.get("finishedAt")]
        to_start = [i for i in live if comms.unstarted(i)
                    and monitors_find_out_of_the_queue(str(i["queueKey"]))]
        open_runs = [i for i in live if i.get("startedAt") and not comms.never_started(i)]
        if not to_start and not open_runs:
            return
        rows = self.running_tasks
        running = [a.label for a in rows]
        wrote = False
        for item in to_start:
            row = self._comms_row_doing(str(item["queueKey"]), rows)
            if row is not None:
                self._comms_start(item, str(item["message"]["id"]), row.label,
                                  self._comms_dispatched(row))
                wrote = True

        def wearing(label: str, labels) -> str | None:
            return next((r for r in labels if r == label or r.startswith(label + " · retry")),
                        None)

        for item in open_runs:
            label = str(item.get("label") or "")
            if item["queueKey"] in waiting:
                continue
            if (failed := wearing(label, never_ran)) is not None:
                comms.append_event("action", str(item["message"]["id"]),
                                   outcome=f"{comms.NEVER_STARTED} ({never_ran[failed]})")
                wrote = True
                continue
            if wearing(label, running) is not None:
                continue
            if (failed := wearing(label, spent)) is not None:
                comms.append_event("action", str(item["message"]["id"]),
                                   outcome=f"{comms.NETWORK_FAILED} ({spent[failed]})")
            comms.append_event("finished", str(item["message"]["id"]), label=label)
            wrote = True
        if wrote:
            self.refresh_comms_feed()
            self.comms_changed.emit()

    # MARK: The Pipeline
    #
    # A sync is the core's (:mod:`pipeline`). The agent work it owes becomes asks on the
    # queue every other ask waits in, so the ban list, the task cap and the budget all
    # still apply, each asked for once per attempt.

    def pipeline_settings_payload(self) -> dict:
        """The ``PipelineSettings`` JSON a sync is handed; the Pipeline skips GitLab roots."""
        teams, _ = pipeline.parse_linear_teams(self.pipeline_linear_teams_raw)
        with self._pipeline_lock:
            force = {kind: sorted(ids) for kind, ids in self._pipeline_force.items()}
        return {
            "roots": [{"owner": r.owner, "repo": r.repo, "path": r.path,
                       "me": self.known_me(r)}
                      for r in review.repo_roots() if not r.is_gitlab],
            "linearTeams": teams,
            "rate": self.pipeline_rate,
            "fix": self.pipeline_fix,
            "fastTrack": self.pipeline_fast_track,
            "merge": self.pipeline_merge,
            "fracture": self.pipeline_fracture,
            "force": force,
            "queued": pipeline.queued(self.requested_work, self._load_attempts(PIPELINE_ATTEMPTS)),
        }

    def pipeline_forced(self, kind: str) -> frozenset[str]:
        with self._pipeline_lock:
            return self._pipeline_force[kind]

    def pipeline_force_now(self, kind: str, item_id: str) -> None:
        """The screen's "Rate now" (``rate``) or "Fracture" (``fracture``): the item goes
        ahead of every limit in a sync started now."""
        with self._pipeline_lock:
            self._pipeline_force = {**self._pipeline_force,
                                    kind: self._pipeline_force[kind] | {item_id}}
        self.pipeline_changed.emit()
        self.run_pipeline_sync_async()

    def refresh_pipeline_last(self) -> None:
        """``pipeline-last``, so the screen opens on the last result before this run's
        first sync. None before any sync, or from a core that cannot answer: the first
        sync says why."""
        try:
            last = pipeline.last()
        except pipeline.Failure:
            return
        with self._pipeline_lock:
            if self.pipeline_result is None:
                self.pipeline_result = last
        self.pipeline_changed.emit()

    def run_pipeline_sync_async(self, *, then=None) -> None:
        """One sync on a worker, while the Pipeline is on. One asked for while another
        runs follows it once the running one is applied: that one may have been handed
        the force sets before the ask that added to them. The queue is changed back on
        the Qt thread (:meth:`_apply_pipeline_sync`), which then calls ``then``; called
        at once when no sync runs."""
        with self._pipeline_lock:
            run = self.pipeline_enabled and not self._pipeline_stopped
            if run and then is not None:
                self._pipeline_then.append(then)
            if run and self.pipeline_syncing:
                self._pipeline_again = True
                return
            self.pipeline_syncing = self.pipeline_syncing or run
        if not run:
            if then is not None:
                then()
            return
        self.pipeline_changed.emit()
        self._start_pipeline_sync()

    def _start_pipeline_sync(self) -> None:
        def work() -> None:
            try:
                plan = self._pipeline_sync_once()
            except Exception as exc:  # noqa: BLE001 — a sync must never wedge the flag
                plan = {"error": str(exc), "forced": {}}
            self._pipeline_synced.emit(plan)

        self.start_background(work, name="pipeline-sync")

    def stop_pipeline_sync(self) -> None:
        """At quit: no sync or Linear sign-in starts again, the running sync's core is
        stopped with what it runs (:func:`promptcore.stop`), and the sign-in cancelled
        (:meth:`stop_linear_login`)."""
        with self._pipeline_lock:
            self._pipeline_stopped = True
            proc = self._pipeline_proc
        if proc is not None:
            promptcore.stop(proc)
        self.stop_linear_login()

    def linear_login(self, cancelled: Callable[[], bool],
                     page: Callable[[str], None]) -> tuple[dict | None, str]:
        """:func:`pipeline.linear_login`, off the Qt thread. :meth:`stop_linear_login`
        cancels it, as does ``cancelled()`` answering true as its core starts, or a quit."""
        def started(proc: subprocess.Popen) -> None:
            with self._pipeline_lock:
                self._linear_login_proc = proc
                stopped = self._pipeline_stopped
            if stopped or cancelled():
                proc.terminate()

        try:
            return pipeline.linear_login(started, page)
        finally:
            with self._pipeline_lock:
                self._linear_login_proc = None

    def stop_linear_login(self) -> None:
        """SIGTERM to the sign-in's core alone, which cancels its wait for the browser.
        One past the wait finishes and saves its login: killed mid-exchange, it would
        leave Linear a grant nothing saved."""
        with self._pipeline_lock:
            proc = self._linear_login_proc
        if proc is not None:
            proc.terminate()

    def _pipeline_started(self, proc: subprocess.Popen) -> None:
        with self._pipeline_lock:
            self._pipeline_proc = proc
            stopped = self._pipeline_stopped
        if stopped:
            promptcore.stop(proc)

    def _pipeline_sync_once(self) -> dict:
        """The slow half of a sync, off the Qt thread: ``{"result"}`` or ``{"error"}``,
        with the force sets it was handed. Held while no root resolves, and while the
        ``gh`` login is unknown, by which the screen and the asks tell the operator's own
        as the sync does."""
        with self._pipeline_lock:
            epoch = self._pipeline_epoch
        if review.roots_guessed():
            return {"error": "no repo root in Settings resolves to a GitHub or GitLab "
                             "checkout", "forced": {}}
        self.fetch_me()
        settings = self.pipeline_settings_payload()
        handed = (None if review.roots_complete()
                  else [f"{r['owner']}/{r['repo']}" for r in settings["roots"]])
        if settings["roots"] and not self.me:
            return {"error": GITHUB_LOGIN_UNKNOWN, "forced": {}}
        # What this launch's first sync is told apart from (:meth:`_apply_pipeline_sync`),
        # read before the sync replaces it.
        if self.pipeline_result is None:
            self.refresh_pipeline_last()
        self._write_pipeline_control()
        started = time.time()
        try:
            out = pipeline.tick(settings, self._pipeline_started)
        finally:
            with self._pipeline_lock:
                self._pipeline_proc = None
        if "items" not in out:
            return {"error": out.get("error") or "the sync did not answer",
                    "forced": settings["force"]}
        self._build_pipeline_prompts(out)
        return {"result": out, "forced": settings["force"], "started": started,
                "epoch": epoch, "handed": handed}

    def _build_pipeline_prompts(self, result: dict) -> None:
        """Assemble the prompt of each ask :meth:`_apply_pipeline_effects` would queue from
        ``result`` now, so the Qt thread finds it memoised (:meth:`_requested_task`)
        rather than running ``diplomat-core`` once per ask."""
        owed = {"fixIssue": self.pipeline_fix, "fixLinear": self.pipeline_fix,
                "review": self.pipeline_fast_track}
        banned, unreadable = bans.read(), bans.unreadable()
        attempts = self._load_attempts(PIPELINE_ATTEMPTS)
        now = time.time()
        for effect in result.get("effects") or []:
            try:
                work = self.pipeline_work(effect) if owed.get(effect.get("kind")) else None
                if work is not None and autofix.decide(
                        attempts.get(str(effect.get("key") or "")),
                        str(effect.get("stamp") or ""), self._pipeline_in_flight(work),
                        unreadable or (bool(work.author)
                                       and bans.is_banned(work.author, banned)),
                        now)[0] == "dispatch":
                    self._requested_task(work)
            except Exception:  # noqa: BLE001 - the Qt thread's own build says why
                pass

    def _apply_pipeline_sync(self, plan: dict) -> None:
        """The Qt-thread half of a sync: publish its result, retire the force sets it
        was handed and the queued asks it no longer owes (:func:`pipeline.withdrawn`),
        and ask for the agent work it owes; then start the sync asked for meanwhile. A
        failed sync leaves the last result and every force and ask standing; one that
        answered the last result again (:func:`pipeline.ran_since`) every force, and
        every ask but one whose switch is off, as does one begun in an earlier
        :attr:`_pipeline_epoch`; one landing after the Pipeline went off every ask
        (switched off midway, it emits no effect).

        Each notice when it first appears, and each merge and split since the previous
        result (:func:`pipeline.fresh_events`), is logged once, whatever the switches. A
        result dated at the epoch, the core's answer while another sync holds its lock
        and none has a result yet, is not shown."""
        with self._pipeline_lock:
            again = (self._pipeline_again and self.pipeline_enabled
                     and not self._pipeline_stopped)
            self._pipeline_again = False
            self.pipeline_syncing = again
        try:
            self._settle_pipeline_error(plan.get("error"))
            result = plan.get("result")
            if result is not None:
                ran = pipeline.ran_since(result, plan["started"])
                judged = ran and plan["epoch"] == self._pipeline_epoch
                handed = (plan.get("forced") or {}) if ran else {}
                previous = self.pipeline_result
                seen = set((previous or {}).get("notices") or [])
                fresh = [n for n in result.get("notices") or [] if n not in seen]
                for notice in fresh:
                    activity.log("auto", "pipeline-notice", notice)
                done = pipeline.fresh_events(result, previous)
                for event in done:
                    activity.log("auto", "pipeline-merge" if event.get("kind") == "merged"
                                 else "pipeline-fracture", pipeline.event_line(event, result))
                with self._pipeline_lock:
                    if result.get("at") != pipeline.NEVER:
                        self.pipeline_result = result
                    self._pipeline_force = {
                        kind: ids - frozenset(handed.get(kind) or ())
                        for kind, ids in self._pipeline_force.items()}
                if self.pipeline_enabled:
                    self._withdraw_pipeline_asks(result if judged else None, plan.get("handed"))
                    if judged:
                        self._pipeline_judged = True
                        released = self._pipeline_stale & set(pipeline.judged(
                            self.requested_work, result, handed=plan.get("handed")))
                        if released:
                            self._pipeline_stale -= released
                            self._bring_poll_forward(self._settled_load)
                    self._apply_pipeline_effects(result, time.time(), judged=judged,
                                                 handed=plan.get("handed"))
            self.pipeline_changed.emit()
            self.pipeline_sync_applied.emit()
        finally:
            with self._pipeline_lock:
                then = [] if self.pipeline_syncing else self._pipeline_then
                if then:
                    self._pipeline_then = []
            if again:
                self._start_pipeline_sync()
            for call in then:
                call()

    def _withdraw_pipeline_asks(self, result: dict | None,
                                handed: list[str] | None = None) -> None:
        gone = set(pipeline.withdrawn(self.requested_work, result, fix=self.pipeline_fix,
                                      fast_track=self.pipeline_fast_track, handed=handed))
        gone -= {e.id for e in self.starting_tasks}
        roots = len(review.repo_roots())
        carried = set()
        for entry in [w for w in self.requested_work if w.key in gone]:
            self._forget_requested(entry.key)
            self._drop_queued_task(entry.key)
            if entry.offered:
                carried.add(entry.offered)
                continue
            activity.log("panel", "queue-drop",
                         f"{entry.label_among(roots)} - the pipeline no longer owes it, "
                         f"not run")
        if gone:
            self.refresh_activity()
        if carried:
            self._withdraw_unowed_async(carried)

    def _withdraw_unowed_async(self, tasks: set[str]) -> None:
        """Take back each offer of ``tasks`` the network still carries: they carried asks
        the pipeline no longer owes. Its run is retired as the offer ends. Twin of
        ``Store.withdrawUnowed``."""
        def work() -> None:
            seen = self._network_evidence(
                diplomacynetwork.state() if diplomacynetwork.enabled() else None)
            for r in agentregistry.load():
                if r.network not in tasks:
                    continue
                task = agentstate.withdraw_on_forget(r, agentstate.Evidence(network=seen))
                if task is not None:
                    self._withdraw(task, network.WITHDRAW_NOT_OWED, r.label or r.run_id,
                                   autofix.SOURCE_AUTO)
        self.start_background(work, name="network-unowed")

    def _settle_pipeline_error(self, error: str | None) -> None:
        """Audited only on the way into failing and back."""
        before = self.pipeline_error
        self.pipeline_error = error or None
        if self.pipeline_error and not before:
            activity.log("auto", "pipeline-error", self.pipeline_error)
        elif before and not self.pipeline_error:
            activity.log("auto", "pipeline-recovered", "Pipeline syncing again")

    def _apply_pipeline_effects(self, result: dict, now: float, *,
                                judged: bool = True, handed: list[str] | None = None) -> None:
        """Ask for the agent work a sync owes, each effect once per attempt: every sync
        emits it for as long as it is owed, and :func:`autofix.decide` over
        ``pipelineAttempts``, by the effect's ``key`` and ``stamp``, says whether this
        sync's is a new attempt. A fix only while the fix switch is on, a review only
        while the fast-track one is: the sync may have been handed them before it went
        off. A queued Linear fix whose effect now names another repo or text is queued
        again with them, as the same attempt: its agent cannot read Linear. Not one that is
        starting or that the network carries: a second ask would be a second fix run.

        The records kept are :func:`pipeline.retained`'s after a ``judged`` sync, every
        one after any other. An ask that could not be queued is an attempt too, retried
        on the same ladder."""
        banned = bans.read()
        unreadable = bans.unreadable()
        roots = len(review.repo_roots())
        starting = {e.id for e in self.starting_tasks}
        for effect in result.get("effects") or []:
            kind = effect.get("kind")
            if not {"fixIssue": self.pipeline_fix, "fixLinear": self.pipeline_fix,
                    "review": self.pipeline_fast_track}.get(kind, False):
                continue
            key, stamp = str(effect.get("key") or ""), str(effect.get("stamp") or "")
            try:
                work = self.pipeline_work(effect)
            except (KeyError, TypeError, ValueError):
                work = None
            if not key or work is None:
                continue
            old = next((w for w in self.requested_work if w.key == work.key), None)
            if (kind == "fixLinear" and old is not None and work.key not in starting
                    and not old.offered
                    and (old.repo, old.config.get("linear"))
                    != (work.repo, work.config.get("linear"))):
                self._forget_requested(old.key)
                self._drop_queued_task(old.key)
                work = dataclasses.replace(work, by_hand=old.by_hand)
                try:
                    self.request_one(work)
                except Exception as exc:  # noqa: BLE001 - a missing/wedged core binary
                    activity.log("auto", "pipeline-fix", f"{work.label_among(roots)} could "
                                                         f"not be queued: {exc}")
                    continue
                activity.log("auto", "pipeline-fix", f"{work.label_among(roots)} queued "
                                                     f"again: its repo or text changed")
                continue
            in_flight = self._pipeline_in_flight(work)
            # Read per effect: a worker thread's retirement may have concluded one while an
            # earlier ask's prompt was built.
            attempts = self._load_attempts(PIPELINE_ATTEMPTS)
            action, value = autofix.decide(
                attempts.get(key), stamp, in_flight,
                unreadable or (bool(work.author) and bans.is_banned(work.author, banned)), now)
            if action != "dispatch":
                continue
            attempt = int(value)
            attempts[key] = autofix.ReviewAttempt(stamp, now, attempt)
            self._save_attempts(PIPELINE_ATTEMPTS, attempts)
            verb = "pipeline-review" if kind == "review" else "pipeline-fix"
            try:
                fresh = self.request_one(work)
            except Exception as exc:  # noqa: BLE001 — a missing/wedged core binary
                activity.log("auto", verb, f"{work.label_among(roots)} could not be "
                                           f"queued: {exc}")
                continue
            if fresh:
                activity.log("auto", verb, f"{work.label_among(roots)} queued"
                             + (f" (attempt {attempt})" if attempt > 1 else ""))
        if judged:
            teams, _ = pipeline.parse_linear_teams(self.pipeline_linear_teams_raw)
            self._save_attempts(PIPELINE_ATTEMPTS, pipeline.retained(
                self._load_attempts(PIPELINE_ATTEMPTS), result, now, teams, handed=handed))

    def pipeline_work(self, effect: dict) -> autofix.RequestedWork | None:
        """The ask a ``PipelineEffect`` stands for, in its root's checkout; None when its
        repo is no GitHub root any more. The effect's ``author`` is the ask's ban
        dimension, as a Comms fix's is: the issue's text is what the fixer reads."""
        roots = [r for r in review.repo_roots() if not r.is_gitlab]
        root = root_named(str(effect.get("repo") or ""), roots)
        if root is None:
            return None
        # The sync judges by gh's account, not the Settings override.
        me = self.me
        url = str(effect.get("url") or "")
        kind = effect.get("kind")
        if kind == "review":
            number = int(effect["number"])
            cfg = review.ReviewConfig(depth=PIPELINE_REVIEW_DEPTH, target=PRTarget.SPECIFIC,
                                      specific_pr=str(number), me=me,
                                      specific_author=review.SpecificAuthor.MINE, home=root,
                                      fast_track=True)
        elif kind == "fixIssue":
            number = int(effect["number"])
            cfg = issues.IssueConfig(target=issues.Target.SPECIFIC, specific_issue=str(number),
                                     me=me, home=root, pipeline=True)
        elif kind == "fixLinear":
            identifier = str(effect["identifier"])
            number = 0
            cfg = issues.IssueConfig(target=issues.Target.SPECIFIC, me=me, home=root,
                                     pipeline=True,
                                     linear={"identifier": identifier, "url": url,
                                             "text": str(effect.get("text") or "")})
        else:
            return None
        author = str(effect.get("author") or "")
        mine = bool(me) and author.lower() == me.lower()
        return autofix.RequestedWork(number=number, url=url, author="" if mine else author,
                                     config=cfg.prompt_payload(), repo=root.key)

    def _pipeline_in_flight(self, work: autofix.RequestedWork) -> bool:
        waiting = ({e.id for e in self.queued_tasks + self.starting_tasks}
                   | {w.key for w in self.requested_work})
        if work.key in waiting:
            return True
        if work.action == autofix.QUEUE_REVIEW_ACTION:
            return self._in_flight(work.url)
        return self._pipeline_fix_running(work)

    def _pipeline_fix_running(self, work: autofix.RequestedWork) -> bool:
        """Whether an agent runs a fix of ``work``'s issue. Twin of
        ``Store.pipelineFixRunning``."""
        named = work.linear or item_label(work.item or "", len(review.repo_roots()))
        return self._fix_of(self.running_tasks, item_key_from_url(work.url), named) is not None

    def pipeline_badges(self) -> dict[str, str]:
        """``agent`` or ``queued`` by item id, for the items something is on now: an
        agent on the PR, or fixing the issue, not a released one; work about it
        waiting in the queue or starting."""
        rows = [a for a in self.running_tasks if not a.released]
        tasks = self.queued_tasks + self.starting_tasks
        waiting = {e.id for e in tasks}
        # A pipeline task's link names its item as the sync read it, after a rename too.
        waiting_items = ({autofix.item_of_key(k) for k in waiting}
                         | {item_key_from_url(e.job.pr_url or "") for e in tasks})
        roots = len(review.repo_roots())
        badges: dict[str, str] = {}
        for it in (self.pipeline_result or {}).get("items") or []:
            item_id = str(it.get("id") or "")
            if it.get("source") == "linear":
                identifier = str(it.get("label") or "")
                agent = self._fix_of(rows, None, identifier) is not None
                queued = autofix.queue_key(autofix.QUEUE_ISSUES_ACTION,
                                           autofix.linear_item(identifier)) in waiting
            else:
                item = item_key_from_url(item_id)
                if item is None:
                    continue
                agent = (any(a.item == item for a in rows)
                         or self._fix_of(rows, item, item_label(item, roots)) is not None)
                queued = item in waiting_items
            if agent:
                badges[item_id] = "agent"
            elif queued:
                badges[item_id] = "queued"
        return badges

    def pipeline_fix_effect(self, item: dict) -> dict | None:
        """The fix effect an issue Diplomat may act on would be asked for by: the one the
        last sync emitted for it; failing that, a GitHub issue's from its link, by whose
        text it carries (``splitFrom``, else its author). A Linear issue's text is
        Diplomat's read, so its fix is only the emitted one. None for an issue assigned to
        someone else, which a fix would claim, or one a hold stops. Twin of
        ``Store.pipelineFixEffect``."""
        if item.get("kind") != "issue" or not item.get("writable") or item.get("hold"):
            return None
        item_id = str(item.get("id") or "")
        emitted = next((e for e in (self.pipeline_result or {}).get("effects") or []
                        if e.get("kind") in ("fixIssue", "fixLinear")
                        and pipeline.identity(str(e.get("url") or ""))
                        == pipeline.identity(item_id)), None)
        if emitted is not None or item.get("source") == "linear":
            return emitted
        split = split_item_key(item_key_from_url(item_id) or "")
        if split is None:
            return None
        return {"kind": "fixIssue", "repo": item.get("repo"), "number": split[1],
                "url": item_id, "author": str(item.get("splitFrom") or item.get("author") or ""),
                "key": f"pipeline-fix:{item_id}", "stamp": "fix"}

    def pipeline_fix_unknown(self, item: dict) -> str:
        """Why an issue has no :meth:`pipeline_fix_effect`, said to the operator."""
        if not item.get("writable"):
            return "It is assigned to someone else"
        if item.get("hold"):
            return str(item["hold"])
        return "Diplomat has this Linear issue's text only while Open fix PRs is on"

    def pipeline_ban_unread(self) -> str | None:
        """Why a sync would rate and split nothing: the ban list cannot be read; None
        while it can. Twin of ``Store.pipelineBanUnread``."""
        return ("The prompt-injection ban list could not be read" if self.ban_list_unreadable
                else None)

    def pipeline_ban(self, item: dict) -> str | None:
        """Why the ban list stops ``item``'s fix: :meth:`pipeline_ban_unread`, or it
        names who wrote the text ``item`` carries (``splitFrom``, else its author); None
        for neither. Twin of ``Store.pipelineBan``."""
        unread = self.pipeline_ban_unread()
        if unread:
            return unread
        who = str(item.get("splitFrom") or item.get("author") or "")
        return (f"@{who} is on the prompt-injection ban list"
                if who and bans.is_banned(who, self.banned_authors) else None)

    def pipeline_rooted(self, item: dict) -> bool:
        """Whether a sync can read ``item``'s code: a Linear issue only when its team
        names a GitHub root (``PipelineRead.linear``'s match)."""
        if item.get("source") != "linear":
            return True
        teams, _ = pipeline.parse_linear_teams(self.pipeline_linear_teams_raw)
        slugs = {f"{r.owner}/{r.repo}".lower() for r in review.repo_roots() if not r.is_gitlab}
        key = str(item.get("repo") or "").lower()
        return any(t["key"].lower() == key and t["repo"].lower() in slugs for t in teams)

    def pipeline_start_fix(self, item: dict) -> str | None:
        """The screen's "Start fix" for a candidate issue, as the last sync left it: its
        fix queued now, past its attempt record (one cooling down or concluded
        included), which then records it; it waits for a bay like every ask. Returns why
        it was not, or None. Twin of ``Store.startPipelineFix``."""
        if not self.pipeline_enabled:
            return "The pipeline is off"
        item = next((i for i in (self.pipeline_result or {}).get("items") or []
                     if i.get("id") == item.get("id")), None)
        if item is None or item.get("kind") != "issue" or item.get("stage") != "candidate":
            return "The last sync found it no fix candidate"
        effect = self.pipeline_fix_effect(item)
        if effect is None:
            return self.pipeline_fix_unknown(item)
        work = self.pipeline_work(effect)
        if work is None:
            return (f"{effect.get('repo')} is no GitHub repo root here, so there is "
                    f"nowhere to fix it")
        work = dataclasses.replace(work, by_hand=True)
        if self._pipeline_fix_running(work):
            return "An agent is already fixing it"
        try:
            fresh = self.request_one(work)
        except Exception as exc:  # noqa: BLE001 — a missing/wedged core binary
            return f"Its fix could not be queued: {exc}"
        if not fresh:
            return "Its fix is already queued"
        key = str(effect["key"])
        attempts = self._load_attempts(PIPELINE_ATTEMPTS)
        prior = attempts.get(key)
        attempts[key] = autofix.ReviewAttempt(str(effect["stamp"]), time.time(),
                                              (prior.attempts if prior else 0) + 1)
        self._save_attempts(PIPELINE_ATTEMPTS, attempts)
        activity.log("panel", "pipeline-fix",
                     f"{work.label_among(len(review.repo_roots()))} queued from the "
                     f"Pipeline screen")
        self.tasks_changed.emit()
        self.pipeline_changed.emit()
        return None

    # MARK: device allocator

    def refresh_device_state(self) -> None:
        """Re-read the daemon's public state file (cheap) and signal on change."""
        new = deviceallocator.read_state()
        if new != self.device_state:
            self.device_state = new
            self.devices_changed.emit()

    @property
    def allocator_busy(self) -> bool:
        return self._allocator_gate.busy

    def _check_async(self, gate: _InstallerGate, check, attr: str, changed) -> None:
        """Shell an installer's --check off the UI thread into ``attr`` and signal
        ``changed`` if it says anything new, unless one of ``gate``'s actions ran
        meanwhile."""
        if gate.busy:
            return
        actions = gate.actions

        def work() -> None:
            status = check()
            with gate.lock:
                if gate.busy or actions != gate.actions or status == getattr(self, attr):
                    return
                setattr(self, attr, status)
            changed.emit()
        self.start_background(work)

    def _gated_action(self, gate: _InstallerGate, changed, work) -> None:
        with gate.lock:
            if gate.busy:
                return
            gate.busy = True
            gate.actions += 1
        changed.emit()

        def run() -> None:
            try:
                work()
            finally:
                gate.busy = False
                changed.emit()
        self.start_background(run)

    def refresh_allocator_install_async(self) -> None:
        self._check_async(self._allocator_gate, deviceallocator.check, "allocator_install",
                          self.allocator_changed)

    def _allocator_action(self, work) -> None:
        self._gated_action(self._allocator_gate, self.allocator_changed, work)

    def _after_device_action(self) -> None:
        self.refresh_activity()
        self.refresh_device_state()

    def kill_device_async(self, key: str) -> None:
        """Logged after the call, with the real outcome: the activity feed must not
        assert a kill that failed."""
        def work() -> None:
            ok = deviceallocator.kill_device(key)
            activity.log("panel", "kill-device",
                         f"Killed device {key}" if ok else f"Kill FAILED for device {key}")
            self._after_device_action()
        self.start_background(work)

    def release_device_async(self, dev: dict) -> None:
        owner = dev.get("owner") or {}
        pid = owner.get("ownerPid")
        if pid is None:
            return
        key = dev.get("key", "")
        name = dev.get("name") or key
        who = owner.get("agentName") or f"pid {pid}"

        def work() -> None:
            ok = deviceallocator.release_device(key, int(pid))
            activity.log("panel", "release-device",
                         f"Freed {name} from {who}" if ok else f"Free FAILED for {name}")
            self._after_device_action()
        self.start_background(work)

    def mark_device_repaired_async(self, key: str) -> None:
        """The daemon logs a success itself; only a refusal is this applet's to report,
        under the daemon's action so the Recent card shows it."""
        def work() -> None:
            if not deviceallocator.mark_repaired(key):
                activity.log("panel", "repair-done", f"Repaired FAILED for device {key}")
            self._after_device_action()
        self.start_background(work)

    def remote_sign_in_async(self) -> None:
        """One at a time, off the GUI thread: the daemon answers only once the browser
        sign-in is over."""
        if self.remote_sign_in.running:
            return
        self.remote_sign_in = RemoteCall(running=True)
        self.remote_changed.emit()

        def work() -> None:
            reply = deviceallocator.remote_sign_in()
            self.remote_sign_in = RemoteCall(reply=reply, at=time.time())
            self.remote_changed.emit()
            self.refresh_device_state()
        self.start_background(work, name="remote-sign-in")

    def list_remote_pool_async(self) -> None:
        if self.remote_listing.running:
            return
        self.remote_listing = RemoteCall(running=True)
        self.remote_changed.emit()

        def work() -> None:
            reply = deviceallocator.remote_devices()
            self.remote_listing = RemoteCall(reply=reply, at=time.time())
            self.remote_changed.emit()
        self.start_background(work, name="remote-listing")

    def start_allocator_daemon_async(self) -> None:
        def work() -> None:
            result = deviceallocator.start_daemon()
            self.allocator_install = deviceallocator.with_install_status(
                result, self.allocator_install)
            running = "true" if (result or {}).get("daemonRunning") else "false"
            error = (result or {}).get("error")
            activity.log("panel", "allocator-install",
                         f"Started the device-allocator daemon (ok: {running})"
                         + (f": {error}" if error else ""))
            self.allocator_changed.emit()
            self._after_device_action()
        self._allocator_action(work)

    def restart_allocator_daemon_async(self) -> None:
        def work() -> None:
            result = deviceallocator.restart_daemon()
            self.allocator_install = deviceallocator.with_install_status(
                result, self.allocator_install)
            error = (result or {}).get("error")
            ok = "true" if (result or {}).get("daemonRunning") and not error else "false"
            activity.log("panel", "allocator-install",
                         f"Restarted the device-allocator daemon (ok: {ok})"
                         + (f": {error}" if error else ""))
            self.allocator_changed.emit()
            self._after_device_action()
        self._allocator_action(work)

    # MARK: remote machines

    def refresh_machines_state(self) -> None:
        """Re-read the daemon's snapshot, and its history whenever the snapshot is a
        new one, and signal on change."""
        state = remotemachines.read_state()
        changed = state != self.machines_state
        self.machines_state = state
        stamp = state.updated_at if state else None
        if self.machines_history is None or stamp != self._machines_history_stamp:
            self._machines_history_stamp = stamp
            history = remotemachines.read_history()
            changed = changed or history != self.machines_history
            self.machines_history = history
        if changed:
            self.machines_changed.emit()

    @property
    def machines_busy(self) -> bool:
        return self._machines_gate.busy

    def refresh_machines_install_async(self) -> None:
        self._check_async(self._machines_gate, remotemachines.check, "machines_install",
                          self.machines_install_changed)

    def _machines_action(self, work) -> None:
        self._gated_action(self._machines_gate, self.machines_install_changed, work)

    def _after_machines_action(self) -> None:
        self.refresh_activity()
        self.refresh_machines_state()

    def install_machines_async(self) -> None:
        def work() -> None:
            remotemachines.ensure_deps()
            result = remotemachines.install()
            self.machines_install = result
            ok = "true" if (result or {}).get("installed") else "false"
            activity.log("panel", "machines-install", f"Installed remote machines (ok: {ok})")
            self._after_machines_action()
        self._machines_action(work)

    def uninstall_machines_async(self) -> None:
        def work() -> None:
            result = remotemachines.uninstall()
            self.machines_install = result
            ok = "true" if result is not None and result.get("installed") is False else "false"
            activity.log("panel", "machines-uninstall",
                         f"Uninstalled remote machines (ok: {ok})")
            self._after_machines_action()
        self._machines_action(work)

    def _start_machines_daemon(self) -> None:
        result = remotemachines.start_daemon()
        self.machines_install = deviceallocator.with_install_status(
            result, self.machines_install)
        running = "true" if (result or {}).get("daemonRunning") else "false"
        error = (result or {}).get("error")
        activity.log("panel", "machines-install",
                     f"Started the remote-machines daemon (ok: {running})"
                     + (f": {error}" if error else ""))
        self._after_machines_action()

    def start_machines_daemon_async(self) -> None:
        self._machines_action(self._start_machines_daemon)

    def restart_machines_daemon_async(self) -> None:
        def work() -> None:
            result = remotemachines.restart_daemon()
            self.machines_install = deviceallocator.with_install_status(
                result, self.machines_install)
            error = (result or {}).get("error")
            ok = "true" if (result or {}).get("daemonRunning") and not error else "false"
            activity.log("panel", "machines-install",
                         f"Restarted the remote-machines daemon (ok: {ok})"
                         + (f": {error}" if error else ""))
            self._after_machines_action()
        self._machines_action(work)

    def refresh_machines_async(self) -> None:
        """A full scan, asked of the daemon's socket rather than of ``daemonRunning``,
        which may be 15 s old; with no daemon there, a start, whose first act is one."""
        def work() -> None:
            self.machines_scanning = True
            self.machines_install_changed.emit()
            try:
                reply = remotemachines.scan()
            finally:
                self.machines_scanning = False
            if reply == deviceallocator.UNREACHABLE:
                self._start_machines_daemon()
                return
            if isinstance(reply, deviceallocator.DaemonReply):
                why = "" if reply.ok else f": {reply.get('error') or f'HTTP {reply.status}'}"
            else:
                why = ": the daemon did not answer"
            activity.log("panel", "machines-scan",
                         "Rescanned the remote machines" + (f" FAILED{why}" if why else ""))
            self._after_machines_action()
        self._machines_action(work)

    def _machine_exclusion_async(self, action: str, write, what: str) -> None:
        """``write(now)`` to the shared config, logged with what really happened. A
        daemon that is not running applies nothing, so an installed one is started; the
        socket says whether one runs, as ``daemonRunning`` may be 15 s old."""
        def work() -> None:
            try:
                write(time.time())
            except OSError:
                activity.log("panel", action, f"{what} FAILED: config.json was not written")
            else:
                activity.log("panel", action, what)
                install = self.machines_install or {}
                if install.get("installed") and not remotemachines.daemon_listening():
                    self.start_machines_daemon_async()
            self._after_machines_action()
        self.start_background(work, name=action)

    def pause_machine_async(self, m: remotemachines.Machine, seconds: float) -> None:
        until = Fmt.clock(datetime.fromtimestamp(time.time() + seconds, tz=timezone.utc))
        self._machine_exclusion_async(
            "machine-pause", lambda now: remotemachines.pause(m, seconds, now),
            f"Paused {m.target} until {until}")

    def exclude_machine_async(self, m: remotemachines.Machine) -> None:
        self._machine_exclusion_async(
            "machine-exclude", lambda now: remotemachines.exclude(m, now),
            f"Excluded {m.target} from the pool")

    def resume_machine_async(self, m: remotemachines.Machine) -> None:
        self._machine_exclusion_async(
            "machine-resume", lambda now: remotemachines.resume(m, now),
            f"Resumed {m.target}")

    def include_machine_async(self, m: remotemachines.Machine) -> None:
        self._machine_exclusion_async(
            "machine-include", lambda now: remotemachines.include(m, now),
            f"Put {m.target} back in the pool")

    # MARK: the Diplomacy Network
    #
    # What is sent and how answers read is :mod:`network`'s. Here the daemon is kept up
    # while the switch is on, and told this machine's pools and how many tasks it takes.

    #: How often an unchanged ``admit`` is said again: the daemon takes nothing after
    #: 120 s unheard.
    NETWORK_ADMIT_EVERY = 60.0
    #: A silent daemon's restart backoff, doubled per attempt between these.
    NETWORK_FIRST_START_DELAY = 15.0
    NETWORK_LONGEST_START_DELAY = 600.0

    @property
    def network_enabled(self) -> bool:
        return diplomacynetwork.enabled()

    @property
    def network_trouble(self) -> str:
        return network.trouble(self.network_answered, self.network_state,
                               diplomacynetwork.settings_unknown())

    @property
    def network_busy(self) -> bool:
        return self._network_lifecycle.locked()

    def set_network_enabled(self, on: bool) -> None:
        """Flip the switch, then start or stop the daemon off the UI thread. Raises
        ``OSError`` when the config will not save, with nothing started or stopped."""
        diplomacynetwork.set_enabled(on)
        self._network_memo = _NetworkCycle()
        self._network_unavailable_logged = False
        if not on:
            self.network_state = None
            self.network_answered = None
            self.network_refusals = {}
            self.network_job_refusals = {}
            self.network_pools_held = ""
        self.network_changed.emit()
        self.tasks_changed.emit()
        self.start_background(
            lambda: self._network_daemon_turn(self._follow_network_switch, wait=True),
            name="network-switch")

    def _network_daemon_turn(self, work, *, wait: bool) -> None:
        """Run one start, restart or stop of the daemon, one at a time. The switch
        waits its turn, so a switch flipped twice leaves the daemon as the second flip
        says; anything else gives way to the one under way."""
        if not self._network_lifecycle.acquire(blocking=wait):
            return
        self.network_changed.emit()
        try:
            work()
        finally:
            self._network_lifecycle.release()
            self.refresh_activity()
            self.network_changed.emit()

    def _follow_network_switch(self) -> None:
        """Bring the daemon to what the switch says by the time this turn comes."""
        if diplomacynetwork.enabled():
            self._start_network_daemon(autofix.SOURCE_PANEL)
            self._network_cycle()
            return
        # Before the stop, while the daemon can still be told.
        with self._settle_lock:
            self._drop_switched_off_runs()
        self.tasks_changed.emit()
        result = diplomacynetwork.stop_daemon()
        self._log_network_daemon(
            autofix.SOURCE_PANEL, network.AUDIT_STOP, "Stopped", result,
            ok=result is not None and not result.get("daemonRunning"),
            note=diplomacynetwork.ended_note(result))

    def _log_network_daemon(self, source: str, action: str, did: str,
                            result: dict | None, *, ok: bool, note: str = "") -> None:
        error = (result.get("error") if result is not None
                 else "the installer could not be run")
        ok = ok and not error
        activity.log(source, action,
                     f"{did} the Diplomacy Network daemon (ok: {'true' if ok else 'false'})"
                     + note + (f": {error}" if error else ""))

    def _start_network_daemon(self, source: str, *, restart: bool = False,
                              quietly: bool = False) -> None:
        """A failed start is said once per silence when the cycle asked (``quietly``),
        every time when the operator did."""
        result = (diplomacynetwork.restart_daemon() if restart
                  else diplomacynetwork.start_daemon())
        ok = (result is not None and not result.get("error")
              and bool(result.get("daemonRunning")))
        if not ok and quietly:
            if self._network_memo.start_failure_logged:
                return
            self._network_memo.start_failure_logged = True
        self._log_network_daemon(source, network.AUDIT_START,
                                 "Restarted" if restart else "Started", result, ok=ok)

    def start_network_async(self, *, restart: bool = False,
                            source: str = autofix.SOURCE_AUTO) -> None:
        """Start the daemon and take a cycle with it. Nothing while the switch is off,
        while :func:`diplomacynetwork.settings_unknown` - a daemon started on a config it
        cannot read switches itself off - or while another start or stop is under way."""
        def work() -> None:
            if not diplomacynetwork.enabled() or diplomacynetwork.settings_unknown():
                return
            self._start_network_daemon(source, restart=restart)
            self._network_cycle()
        self.start_background(lambda: self._network_daemon_turn(work, wait=False),
                              name="network-start")

    def start_network_daemon_async(self) -> None:
        self.start_network_async(source=autofix.SOURCE_PANEL)

    def restart_network_async(self) -> None:
        self.start_network_async(restart=True, source=autofix.SOURCE_PANEL)

    def retire_legacy_node_async(self) -> None:
        """Retire the mesh node an earlier Diplomat left, whatever the switch says."""
        def work() -> None:
            asked, removed, link = diplomacynetwork.retire_legacy_node()
            line = diplomacynetwork.legacy_retired_line(
                asked, removed, link, diplomacynetwork.legacy_dir())
            if line:
                activity.log(autofix.SOURCE_AUTO, network.AUDIT_STOP, line)
                self.refresh_activity()
        self.start_background(work, name="legacy-node")

    def run_network_cycle_async(self) -> None:
        if diplomacynetwork.enabled():
            self.start_background(self._network_cycle, name="network-cycle")

    def _network_cycle(self) -> None:
        if not self._network_cycle_lock.acquire(blocking=False):
            return
        try:
            self._network_cycle_once(time.time())
        finally:
            self._network_cycle_lock.release()

    def _network_cycle_once(self, now: float) -> None:
        """Read the daemon's snapshot, start it when silent, and tell it this machine's
        pools and how many more tasks it takes. ``pools`` is said when it changed,
        ``admit`` also once a minute, and both again to a daemon that started since.
        Neither is said, and no daemon started, while
        :func:`diplomacynetwork.settings_unknown`; nor anything read from the config
        while one read of it failed (:func:`appconfig.unreadable_reads`)."""
        if not diplomacynetwork.enabled():
            return
        snapshot = diplomacynetwork.state()
        if not diplomacynetwork.enabled():
            return  # switched off while this cycle was asking
        self._note_network_state(snapshot)
        if snapshot is None:
            self._revive_network_daemon(now)
            return
        daemon = f"{snapshot.pid} {snapshot.started_at}"
        if daemon != self._network_memo.daemon:
            self._network_memo = _NetworkCycle(daemon=daemon)
        memo = self._network_memo
        memo.start_after = memo.start_delay = 0.0
        memo.start_failure_logged = False
        if diplomacynetwork.settings_unknown():
            self._settle_offering(snapshot)
            return
        blind = appconfig.unreadable_reads()
        pools, unconfirmed = self._network_pools(now, snapshot)
        listed = self._listed_paths()
        admit = self._network_admit(snapshot)
        # A read that fell inside a rewrite of the config took defaults: the default
        # root's pools, the default cap.
        if appconfig.unreadable_reads() != blind:
            return
        if pools == memo.pools:
            memo.pools_refused, memo.pools_refusal = None, ""
        elif (pools != memo.pools_refused
              or now - memo.pools_refused_at >= self.NETWORK_ADMIT_EVERY):
            reply = diplomacynetwork.send(network.ROUTE_POOLS, network.pools_body(pools))
            why = diplomacynetwork.refusal(reply)
            if why is None:
                memo.pools, memo.pools_refused, memo.pools_refusal = pools, None, ""
                self._log_pools_left(snapshot, pools, listed)
            elif diplomacynetwork.definite(reply):
                said = f"The daemon refused this machine's pools: {why}"
                if (pools, said) != (memo.pools_refused, memo.pools_refusal):
                    activity.log(autofix.SOURCE_AUTO, network.AUDIT_UNAVAILABLE, said)
                    self.refresh_activity()
                memo.pools_refused, memo.pools_refusal, memo.pools_refused_at = pools, said, now
        held = "\n".join([*unconfirmed, *filter(None, [memo.pools_refusal])])
        if held != self.network_pools_held:
            self.network_pools_held = held
            self.network_changed.emit()
        if admit != memo.admit or now - memo.admit_at >= self.NETWORK_ADMIT_EVERY:
            if diplomacynetwork.refusal(diplomacynetwork.send(
                    network.ROUTE_ADMIT, admit.body)) is None:
                memo.admit, memo.admit_at = admit, now
        self._settle_offering(snapshot)
        # The runs the network carries move with what was just said.
        self.refresh_auto_task_count()

    def _revive_network_daemon(self, now: float) -> None:
        """Start a silent daemon once its backoff allows; while the settings are unknown
        nothing is tried and the backoff stays as it is."""
        memo = self._network_memo
        if now < memo.start_after or diplomacynetwork.settings_unknown():
            return

        def start() -> None:
            memo.start_delay = min(max(memo.start_delay * 2, self.NETWORK_FIRST_START_DELAY),
                                   self.NETWORK_LONGEST_START_DELAY)
            memo.start_after = now + memo.start_delay
            self._start_network_daemon(autofix.SOURCE_AUTO, quietly=True)
        self._network_daemon_turn(start, wait=False)

    def _network_login(self, repo: LocalRepo, now: float) -> str:
        """The login work is done as on ``repo``'s host, "" while unknown: gh's own on
        GitHub (as the poll reads it; never the username override, which only says
        whose PRs the lists show), glab's on GitLab. An unknown GitLab login is asked
        for here, as nothing else reads a host no root is on, but not every cycle."""
        if not repo.is_gitlab:
            return self.me
        known = self.known_me(repo)
        asked = self._network_login_asked.get(repo.host)
        if known or (asked is not None and now - asked < self.NETWORK_ADMIT_EVERY):
            return known
        self._network_login_asked[repo.host] = now
        try:
            return self.me_for(repo)
        except Exception:  # noqa: BLE001 - an unread login leaves the pools as they are
            return ""

    def _network_pools(self, now: float,
                       snapshot: network.Snapshot) -> tuple[list[dict], list[str]]:
        """Every linked repository as a pool, with the login each is worked as, and
        what could not be confirmed, which stays as ``snapshot`` has it
        (:func:`network.pools_listing`). The checkouts under Other repos are read again
        here: one that could not be read may be back, and one may have gained a
        remote."""
        roots, unread = review.roots_linking()
        checkouts = localrepos.resolve(self.other_repo_paths)
        if checkouts != self._local_checkouts:
            self._local_checkouts = checkouts
            self.local_repos_changed.emit()
        others = localrepos.local_repos(checkouts)
        identities: dict[str, str] = {}
        for repo in (*roots, *others):
            if repo.host not in identities:
                identities[repo.host] = self._network_login(repo, now)
        unread += [os.path.expanduser(c.path) for c in checkouts if not c.read]
        return network.pools_listing(roots, others, unread, identities, snapshot.pools)

    def _listed_paths(self) -> set[str]:
        return {os.path.expanduser(p)
                for p in (*review.repo_root_paths(), *self.other_repo_paths)}

    def _log_pools_left(self, snapshot: network.Snapshot, pools: list[dict],
                        listed: set[str]) -> None:
        """Log each pool the daemon had that ``pools`` omits, and what became of its
        path."""
        said = {pool["id"] for pool in pools}
        left = [pool for pool in snapshot.pools if pool.id not in said]
        for pool in left:
            activity.log(autofix.SOURCE_AUTO, network.AUDIT_LEAVE, f"Left {pool.id}: " + (
                f"{pool.path} no longer names it" if pool.path in listed
                else f"{pool.path} is no longer listed in Settings"))
        if left:
            self.refresh_activity()

    def _network_admit(self, snapshot: network.Snapshot) -> network.Admit:
        """How many more tasks this machine takes: what is left of the automatic cap
        after the runs it executes for the network and its own local agents, and
        nothing at all while the disk is low, the budget is spent or automatic work is
        switched off (:func:`network.admit`)."""
        disk = self._lowest_disk()
        local = len(self._tick_with(network.tasks(snapshot)).cap_load)
        return network.admit(
            self.auto_task_limit, network.running(snapshot) + local,
            low_disk=disk is not None and disk.low,
            affordable=not autobudget.enabled() or autobudget.decide().affordable,
            auto_run=self.queue_auto_run)

    # MARK: the network's runs

    def _withdraw(self, task: str, reason: str, label: str,
                  source: str) -> deviceallocator.DaemonReply | str:
        reply = diplomacynetwork.send(network.ROUTE_WITHDRAW,
                                      network.withdraw_body(task, reason))
        why = diplomacynetwork.refusal(reply)
        activity.log(source, network.AUDIT_WITHDRAW,
                     f"{label} - withdrawn ({reason})" if why is None
                     else f"{label} - not withdrawn: {why}")
        self.refresh_activity()
        return reply

    def _drop_switched_off_runs(self) -> None:
        """With the switch off: withdraw every offer the network still carries and drop
        its run as failed, freeing its PR or issue for an agent of this machine. A run
        that had ended, or whose PR merged, is settled as it would have been. A silent
        daemon is not told, and a run is dropped whatever the daemon answers. A step of
        a settle, under its lock."""
        self._withdraw_offering()
        if not any(r.network is not None for r in agentregistry.load()):
            return
        snapshot = diplomacynetwork.state()
        t = self._tick_with(network.tasks(snapshot))
        self._retire_finished(t, snapshot, self._withdraw_merged(t))
        left = [r for r in agentregistry.load() if r.network is not None]
        for r in left if snapshot is not None else ():
            diplomacynetwork.send(network.ROUTE_WITHDRAW, network.withdraw_body(
                r.network, network.WITHDRAW_SWITCHED_OFF))
        if left and self._write_book(
                lambda: agentregistry.forget({r.run_id for r in left})):
            why = "withdrawn: the Diplomacy Network was switched off"
            for r in left:
                activity.log(r.source, network.AUDIT_FAILED, f"{r.label or r.run_id} - {why}")
            self._network_claims_logged.clear()
            self.refresh_activity()
            # A ping whose run this was reads that it never ran, not that it finished.
            self._note_comms_runs({r.label: why for r in left})

    def forget_network_run_async(self, run_id: str) -> None:
        """Drop a network run on the operator's word, first withdrawing its offer while
        the network holds it (:func:`agentstate.withdraw_on_forget`): forgotten here
        alone, some machine would start on work nobody waits for. Dropped whatever the
        daemon answers."""
        def work() -> None:
            record = next((r for r in agentregistry.load()
                           if r.run_id == run_id and r.network is not None), None)
            if record is None:
                return
            who = record.label or record.run_id
            self._forget_offered(record.network)
            # Asked afresh: the snapshot kept may be a tick old.
            seen = self._network_evidence(
                diplomacynetwork.state() if diplomacynetwork.enabled() else None)
            task = agentstate.withdraw_on_forget(record, agentstate.Evidence(network=seen))
            if task is None:
                activity.log(autofix.SOURCE_PANEL, "retire", f"{who} - forgotten")
                self.refresh_activity()
            else:
                self._withdraw(task, network.WITHDRAW_FORGOTTEN, who, autofix.SOURCE_PANEL)
            self._write_book(lambda: agentregistry.forget({run_id}))
            self.tasks_changed.emit()
        self.start_background(work, name="network-forget")

    def stop_network_task_async(self, task: network.PoolTask, pool: str) -> None:
        """Stop a pool task: its run when this machine runs it, else this machine's
        offer. A run not there to stop is said so on the pool's card, and nothing is
        withdrawn instead: the button said the job goes back to the pool."""
        def work() -> None:
            title = task.title or task.item
            if not task.executor_here:
                reply = self._withdraw(task.task_id, network.WITHDRAW_STOPPED,
                                       title, autofix.SOURCE_PANEL)
                if diplomacynetwork.refusal(reply) is None:
                    self._forget_offered(task.task_id)
                self._note_network_reply(reply, pool)
                self.refresh_auto_task_count()
                return
            # Asked afresh: a run that ended since the kept snapshot is not there to stop.
            fresh = diplomacynetwork.state()
            run = next((r for r in (fresh.runs if fresh else ())
                        if r.task_id == task.task_id
                        and r.state in network.LIVE_RUN_STATES), None)
            if run is None:
                self._set_network_refusal(pool, diplomacynetwork.NOT_ANSWERING
                                          if fresh is None else diplomacynetwork.RUN_ENDED)
            else:
                reply = diplomacynetwork.send(network.ROUTE_STOP_RUN,
                                              network.stop_run_body(run.run_id))
                if diplomacynetwork.refusal(reply) is None:
                    activity.log(autofix.SOURCE_PANEL, network.AUDIT_STOP,
                                 f"{title} - its run on this machine was stopped "
                                 "and the job is back in the pool")
                    self.refresh_activity()
                self._note_network_reply(reply, pool)
            self.refresh_auto_task_count()
        self.start_background(work, name="network-stop")

    # MARK: the network's pools

    def _note_network_reply(self, reply: deviceallocator.DaemonReply | str,
                            card: str) -> str | None:
        """Keep an action's refusal under its panel (a pool id, "" before any pool), or
        clear it; return it."""
        why = diplomacynetwork.refusal(reply)
        self._set_network_refusal(card, why)
        return why

    def _set_network_refusal(self, card: str, why: str | None) -> None:
        refusals = dict(self.network_refusals)
        if why is None:
            refusals.pop(card, None)
        else:
            refusals[card] = why
        self.network_refusals = refusals
        self.network_changed.emit()

    def network_invite_async(self, pool: str) -> None:
        """Ask for an invite to ``pool``; the screen puts it on the clipboard."""
        def work() -> None:
            reply = diplomacynetwork.send(network.ROUTE_INVITE, network.invite_body(pool))
            if self._note_network_reply(reply, pool) is not None:
                return
            invite = reply.get("invite")
            if not (isinstance(invite, str) and invite):
                self._set_network_refusal(pool, "the daemon gave no invite")
                return
            activity.log(autofix.SOURCE_PANEL, network.AUDIT_INVITE,
                         f"Made an invite to {pool}")
            self.refresh_activity()
            self.network_invited.emit(pool, invite)
        self.start_background(work, name=network.AUDIT_INVITE)

    def network_join_async(self, invite: str, card: str) -> None:
        """Join the pool an invite is to. A refusal is kept for ``card``, the panel the
        invite was pasted into."""
        self._network_join(network.join_body(invite), card)

    def network_rejoin_async(self, pool: str) -> None:
        self._network_join(network.join_body(pool=pool), pool, rejoined=pool)

    def _network_join(self, body: dict, card: str, *, rejoined: str = "") -> None:
        def work() -> None:
            reply = diplomacynetwork.send(network.ROUTE_JOIN, body)
            if self._note_network_reply(reply, card) is not None:
                self.network_joined.emit(card, False)
                return
            pool = reply.get("pool")
            activity.log(autofix.SOURCE_PANEL, network.AUDIT_JOIN,
                         f"Rejoined {rejoined}" if rejoined else
                         f"Joining {pool if isinstance(pool, str) and pool else 'a pool'}: "
                         f"{diplomacynetwork.SEATED_LATER}")
            self.refresh_activity()
            self.network_joined.emit(card, True)
            self._network_cycle()
        self.start_background(work, name=network.AUDIT_JOIN)

    def network_leave_async(self, pool: str) -> None:
        def work() -> None:
            reply = diplomacynetwork.send(network.ROUTE_LEAVE, network.leave_body(pool))
            if self._note_network_reply(reply, pool) is not None:
                return
            activity.log(autofix.SOURCE_PANEL, network.AUDIT_LEAVE, f"Left {pool}")
            self.refresh_activity()
            self._network_cycle()
        self.start_background(work, name=network.AUDIT_LEAVE)

    # MARK: activity feed + bans

    def refresh_activity(self) -> None:
        """Re-read the shared activity feed (audit.jsonl) and ban list (cheap tail /
        small-file reads) and signal on change. Runs on the panel's 8s poll."""
        from diplomat_runtime import activity
        from . import bans

        new_audit = activity.read()
        new_bans = bans.read()
        unreadable = bans.unreadable()
        self._notice_new_bans(new_bans)
        bans_changed = new_bans != self.banned_authors
        if new_audit != self.audit_entries or bans_changed:
            self.audit_entries = new_audit
            self.banned_authors = new_bans
            self.activity_changed.emit()
        if bans_changed or unreadable != self.ban_list_unreadable:
            self.ban_list_unreadable = unreadable
            self.pipeline_changed.emit()

    def unban_async(self, login: str) -> None:
        """The panel's un-ban, off the GUI thread: the daemon may take seconds."""
        def work() -> None:
            done = bans.unban(login)
            if done.error:
                self.error = f"Could not un-ban @{login}: {done.error}"
                self.changed.emit()
            self.refresh_activity()
        self.start_background(work, name="unban")

    def _notice_new_bans(self, banned: list) -> None:
        """Announce each ban the last read did not hold, a re-ban included. Workers
        read too (a dispatch's ban-skip), hence the lock."""
        keys = {(b.login.lower(), b.at or ""): b for b in banned}
        with self._bans_known_lock:
            known, self._bans_known = self._bans_known, set(keys)
            quiet = set(self._bans_quiet)
        if known is None:
            return
        for key, b in keys.items():
            if key not in known and key[0] not in quiet:
                self.ban_noticed.emit(*self.ban_notification(b))

    @staticmethod
    def ban_notification(b) -> tuple[str, str]:
        """``(title, body)``: who, then where and the words that got them banned."""
        who = f"Slack user {b.name}" if b.is_slack else b.name
        where = (", ".join(p for p in (b.place, b.pr) if p) if b.is_slack else b.pr) or (
            "Slack" if b.is_slack else "GitHub")
        evidence = Store.comms_snippet(b.evidence or b.reason or "", 160)
        by = f" - reported by {b.reported_by}" if b.reported_by else ""
        return (f"Banned {who} for prompt injection",
                f"{where}: \"{evidence}\"{by}" if evidence else f"{where}{by}")

    def ensure_allocator_installed_async(self) -> None:
        """Install the device-allocator MCP when Diplomat is first set up, and keep
        an existing install current afterwards. Called blindly on every launch.

        Two jobs, one shell of the installer, because they answer to the same
        status. The first is the original one-time install, which only marks itself
        done once the install actually lands so a transient failure (no node yet)
        retries on a later launch. The second is the update: everything the
        installer writes — the skill, the always-on rule, the CLAUDE.md block, the
        MCP registration — is a *copy* of something in this checkout, and a
        ``git pull`` moves the originals alone. Without this, a machine set up once
        coerces its agents with whatever text shipped that day, forever.

        Which of the three situations this is — first run, stale, or an install the
        user deliberately removed — is :func:`deviceallocator.needs_install`, shared
        with its macOS twin so the two applets can't drift on the one question where
        being wrong reinstalls something behind the user's back.
        """
        if not deviceallocator.package_available():
            return

        def work() -> None:
            status = deviceallocator.check() or {}
            if not deviceallocator.needs_install(status, self.allocator_setup_done):
                self.allocator_install = status
                if status.get("installed"):
                    self.allocator_setup_done = True
                self.allocator_changed.emit()
                return
            # A first install and a stale one are the same act: pull the MCP server's
            # runtime deps, then (re-)register — `--install` rewrites every artifact,
            # so it is also the repair.
            deviceallocator.ensure_deps()
            result = deviceallocator.install()
            self.allocator_install = result
            if result and result.get("installed"):
                self.allocator_setup_done = True
            self.allocator_changed.emit()
            self.refresh_device_state()
        self._allocator_action(work)

    def install_allocator_async(self) -> None:
        def work() -> None:
            deviceallocator.ensure_deps()
            result = deviceallocator.install()
            self.allocator_install = result
            self.allocator_setup_done = True
            ok = "true" if (result or {}).get("installed") else "false"
            activity.log("panel", "allocator-install", f"Installed device allocator (ok: {ok})")
            self.allocator_changed.emit()
            self._after_device_action()
        self._allocator_action(work)

    def uninstall_allocator_async(self) -> None:
        def work() -> None:
            result = deviceallocator.uninstall()
            self.allocator_install = result
            # An explicit uninstall is a settled choice — don't auto-reinstall.
            self.allocator_setup_done = True
            ok = "true" if result is not None and result.get("installed") is False else "false"
            activity.log("panel", "allocator-uninstall",
                         f"Uninstalled device allocator (ok: {ok})")
            self.allocator_changed.emit()
            self._after_device_action()
        self._allocator_action(work)

    # MARK: self-update

    def refresh_update_status_async(self) -> None:
        """Fetch origin and compare HEAD to upstream, off the UI thread."""
        if (self.update_state or {}).get("phase") in ("checking", "updating", "restarting"):
            return

        def work() -> None:
            from . import selfupdate

            self.update_state = {"phase": "idle", **selfupdate.check()}
            self.update_changed.emit()

        self.update_state = {"phase": "checking"}
        self.update_changed.emit()
        self.start_background(work)

    def update_applet_async(self) -> None:
        """Pull the checkout, rebuild diplomat-core, relaunch the applet.

        The relaunched instance terminates this one (newest-wins singleton), so
        a successful run ends in the "restarting" phase with this process about
        to be replaced; only a failure leaves state to interact with.
        """
        if (self.update_state or {}).get("phase") in ("updating", "restarting"):
            return

        def work() -> None:
            from . import selfupdate

            def step(text: str) -> None:
                self.update_state = {"phase": "updating", "step": text}
                self.update_changed.emit()

            try:
                step("pulling from origin…")
                commit = selfupdate.pull()
                step(f"building diplomat-core at {commit}…")
                selfupdate.build_core()
                step("relaunching…")
                exited = selfupdate.relaunch_failure(selfupdate.relaunch())
                if exited is not None:
                    raise selfupdate.UpdateError(
                        f"the relaunched applet exited {exited}; this one is still the old build")
                self.update_state = {"phase": "restarting", "commit": commit}
            except (selfupdate.UpdateError, OSError, subprocess.TimeoutExpired) as exc:
                # TimeoutExpired (black-holed network on pull's fetch, or a hung swift
                # build) and OSError are NOT UpdateError subclasses; without catching
                # them the worker thread dies with update_state stuck on "updating",
                # and the phase guard above then makes every later update a permanent
                # no-op until the app restarts. Surface it as an error phase instead.
                self.update_state = {"phase": "error", "error": str(exc)}
            self.update_changed.emit()

        # Claim the phase before the thread runs so a double-click can't
        # start two updates.
        self.update_state = {"phase": "updating", "step": "starting…"}
        self.update_changed.emit()
        self.start_background(work)

    def count(self, tool_id: str) -> int:
        return len(self.items_for(tool_id))

    def lookup(self, number: int) -> LookupResult:
        on_lists = [
            t.id
            for t in self.visible_tools
            if any(item.id == number for item in self.items_for(t.id))
        ]
        pr = next((p for p in self.prs if p.number == number), None)
        if pr is not None:
            return LookupResult(
                number=number,
                on_lists=on_lists,
                presence=f"open PR · @{pr.author} · {'draft' if pr.is_draft else 'ready'}",
                url=pr.url,
            )
        issue = next((i for i in self.issues if i.number == number), None)
        if issue is not None:
            return LookupResult(
                number=number,
                on_lists=on_lists,
                presence=f"open issue · @{issue.author} [{issue.author_association}]",
                url=issue.url,
            )
        return LookupResult(
            number=number,
            on_lists=on_lists,
            presence="not in open PRs/issues (closed or unknown)",
            url=None,
        )

    # One row builder per tool: the ordered source objects, then the two lines each
    # row shows. Everything else about a row — its id, its `#N` badge, its title and
    # its url — is the same for all six, so `items_for` below owns that and each tool
    # contributes only what actually differs.
    #
    # The row TEXT is duplicated across platforms by necessity — `ToolData.items` in
    # diplomat-core/Sources/DiplomatCore/ToolKind.swift renders the same six lists for the macOS
    # panel, and neither side can shell out to the other for something rebuilt on
    # every render. `diplomat-platform/linux/tests/test_tooldata_parity.py` runs both over one fixture
    # and diffs the rows, so a change to either has to be made to both.
    def _row_specs(self) -> dict:
        me = self.known_me(self.selected_repo)
        return {
            "skillPRs": (
                lambda: sorted(Filters.skill_prs(self.prs), key=lambda p: -p.number),
                lambda p: f"@{p.author} · {Fmt.age(p.created_at)} · "
                          f"{'draft' if p.is_draft else 'ready'}",
                lambda p: "skills: " + ", ".join(
                    Fmt.skill_name(f) for f in p.files if Filters.is_skill_file(f)
                ),
            ),
            "installerPRs": (
                lambda: sorted(Filters.installer_prs(self.prs), key=lambda p: -p.number),
                lambda p: f"@{p.author} · {Fmt.age(p.created_at)} · "
                          f"{_count(len(_installer_files(p)), 'file')}",
                lambda p: "\n".join(Fmt.short_path(f) for f in _installer_files(p)),
            ),
            "staleReady": (
                lambda: sorted(Filters.stale_ready_prs(self.prs), key=lambda p: p.ready_at),
                lambda p: f"@{p.author} · ready {Fmt.days(p.ready_at)}d · "
                          f"{'born-ready' if p.ready_for_review_at is None else 'converted'}",
                lambda p: None,
            ),
            "unaddressedIssues": (
                lambda: sorted(Filters.unaddressed_external_issues(self.issues),
                               key=lambda i: i.created_at),
                lambda i: f"@{i.author} [{i.author_association}] · "
                          f"{Fmt.age(i.created_at)} · {i.comment_count}c",
                lambda i: f"labels: {', '.join(i.labels)}" if i.labels else None,
            ),
            "myApproved": (
                lambda: sorted(Filters.my_approved_prs(self.prs, me), key=lambda p: -p.number),
                lambda p: f"@{p.author} · {Fmt.age(p.created_at)} · approved · "
                          f"{'draft' if p.is_draft else 'ready'}",
                lambda p: None,
            ),
            "myUnaddressed": (
                lambda: sorted(Filters.my_unaddressed_review_prs(self.prs, me),
                               key=lambda p: -p.number),
                lambda p: f"@{p.author} · {Fmt.age(p.created_at)} · "
                          f"{_count(len(p.unaddressed_threads(me)), 'open thread')}",
                lambda p: None,
            ),
        }

    def items_for(self, tool_id: str) -> list[DisplayItem]:
        spec = self._row_specs().get(tool_id)
        if spec is None:
            return []
        source, line2, line3 = spec
        return [
            DisplayItem(
                id=obj.number,
                badge=f"#{obj.number}",
                title=obj.title,
                url=obj.url,
                line2=line2(obj),
                line3=line3(obj),
            )
            for obj in source()
        ]
