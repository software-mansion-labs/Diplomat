"""The Pipeline, as the Linux front-end reaches it.

Everything the pipeline decides - reading the trackers, rating, labelling, merging,
fracturing, the graph and the effects - is ``DiplomatCore``, reached through the
``diplomat-core`` CLI (``pipeline-tick``, ``pipeline-last``), which reads and writes
``$DIPLOMAT_PIPELINE_DIR`` (default ``~/.diplomat/pipeline``). What lives here is calling
it, the sync period, the parse of the Linear teams setting into
``PipelineSettings.linearTeams``, and the rules the store reads a result and its attempt
records by, each the twin of the macOS one its docstring names.

Stdlib-only, like the rest of the runtime.
"""

from __future__ import annotations

import contextlib
import json
import math
import os
import re
import uuid
from collections.abc import Callable
from dataclasses import replace
from datetime import datetime
from pathlib import Path
from urllib.parse import urlsplit

from . import core, promptcore
from .autofix import QUEUE_ISSUES_ACTION, QUEUE_REVIEW_ACTION, RETRY_MAX_BACKOFF, linear_item
from .prref import item_key_from_url, split_item_key

#: Raised by :func:`last`: the CLI's own reason, or why it could not run.
Failure = (RuntimeError, promptcore.CoreBinaryMissing, ValueError)

#: The Linear key's environment override, which wins over ``linearTokenFile``.
TOKEN_ENV = "DIPLOMAT_LINEAR_TOKEN"


def pipeline_dir() -> Path:
    """Must match ``PipelineLog.dir``: the core reads ``control.json`` there."""
    env = os.environ.get("DIPLOMAT_PIPELINE_DIR")
    return Path(env) if env else Path.home() / ".diplomat" / "pipeline"


#: ``control.json``'s keys: the switches a running sync re-reads before each outward
#: action.
CONTROL_KEYS = ("enabled", "rate", "fix", "fastTrack", "merge", "fracture")


def write_control(switches: dict) -> None:
    """``control.json`` from ``switches`` (:data:`CONTROL_KEYS`): owner-only, replaced
    whole. Never raises; a sync that cannot read it goes by the settings it was started
    with. Twin of ``Store.writePipelineControl``."""
    folder = pipeline_dir()
    tmp = folder / f"control.json.tmp-{os.getpid()}-{uuid.uuid4().hex}"
    try:
        folder.mkdir(mode=0o700, parents=True, exist_ok=True)
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump({k: bool(switches.get(k)) for k in CONTROL_KEYS}, fh, sort_keys=True)
        os.replace(tmp, folder / "control.json")
    except OSError:
        with contextlib.suppress(OSError):
            tmp.unlink()


def tunables() -> dict:
    try:
        return core.pipeline()
    except core.CoreError:
        return {}


#: A day: well inside a ``QTimer`` interval's int32 milliseconds.
MAX_SYNC_SECS = 86400.0


#: The sync period's override, in seconds. Twin of ``Store.pipelineSyncInterval``.
SECS_ENV = "DIPLOMAT_PIPELINE_SECS"
_DECIMAL = re.compile(r"[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?", re.ASCII)


def sync_secs() -> float:
    """``$DIPLOMAT_PIPELINE_SECS`` (a decimal number, ignored unless finite), else
    ``syncSecs``. Never under ``minSyncSecs`` (a sync reads every root and team, and may
    spend ``claude`` calls), nor over a day."""
    t = tunables()
    raw = os.environ.get(SECS_ENV, "")
    secs = float(raw) if _DECIMAL.fullmatch(raw) else math.nan
    if not math.isfinite(secs):
        secs = float(t.get("syncSecs", 300))
    if not math.isfinite(secs):
        secs = 300.0
    return min(MAX_SYNC_SECS, max(float(t.get("minSyncSecs", 60)), secs))


#: ``GH.timeout`` plus the five seconds ``GH.stop`` waits before its SIGKILL.
_GH_CALL_SECS = 65
#: The ``gh`` calls one rating, or a split's claim, may bring: a diff, label creates,
#: adds and removes.
_GH_CALLS_PER_CLAUDE = 16
#: And each part of a split: a re-read, the parts filed before (twice after a failed
#: create), the create and its sub-issue link.
_GH_CALLS_PER_PART = 5
#: The read of a root, and its merges.
_GH_CALLS_PER_ROOT = 10
#: Linear's reads (300 issues, paged) and its label and child writes.
_LINEAR_SECS = 300
#: The login shell's lookups of ``gh`` and ``claude``, and a margin for the rest.
_LOOKUP_SECS = 10
_MARGIN_SECS = 30


def tick_timeout(settings: dict) -> float:
    """How long ``pipeline-tick`` runs before it is killed: every ``claude`` call a sync
    may make (``rater.perSync`` ratings, one fracture, and each one the view forced) at
    ``rater.timeoutSecs`` and the five seconds before its SIGKILL, each with the ``gh``
    calls around it, a fracture's for ``fracture.maxChildren`` parts too; the roots'
    reads and merges; Linear. It bounds a wedged core, not a slow sync, so it is
    generous."""
    t = tunables()
    rater = t.get("rater") or {}
    force = settings.get("force") or {}
    splits = 1 + len(force.get("fracture") or [])
    claude_calls = int(rater.get("perSync", 4)) + len(force.get("rate") or []) + splits
    per_claude = float(rater.get("timeoutSecs", 300)) + 5 + _GH_CALLS_PER_CLAUDE * _GH_CALL_SECS
    per_split = (int((t.get("fracture") or {}).get("maxChildren", 6)) * _GH_CALLS_PER_PART
                 * _GH_CALL_SECS)
    roots = max(1, len(settings.get("roots") or []))
    return (claude_calls * per_claude + splits * per_split
            + roots * _GH_CALLS_PER_ROOT * _GH_CALL_SECS
            + (_LINEAR_SECS if settings.get("linearTeams") else 0)
            + _LOOKUP_SECS + _MARGIN_SECS)


#: Spaces, tabs and a pasted CRLF line's carriage return, never Unicode spacing.
_SPACE = " \t\r\v\f"
_TEAM = re.compile(r"([A-Za-z0-9]+)[ \t\r\v\f]*=[ \t\r\v\f]*([\w.-]+/[\w.-]+)", re.ASCII)


def parse_linear_teams(raw: str) -> tuple[list[dict], list[str]]:
    """``PipelineSettings.linearTeams`` from the Settings text ``ENG=owner/repo,
    OPS=owner/other`` (commas, semicolons or new lines between entries), and the
    entries that are not ``KEY=owner/repo``, as typed. A key is ASCII letters and
    digits, read in capitals as Linear spells it; an owner and a repo are ASCII letters,
    digits, ``_``, ``.`` and ``-``. A team named twice keeps its first repo. Twin of
    ``PipelineSettings.LinearTeam.parse``, which ``diplomat-core pipeline-teams``
    answers with."""
    teams: list[dict] = []
    bad: list[str] = []
    for entry in (e.strip(_SPACE) for e in re.split(r"[,;\n]", raw or "")):
        if not entry:
            continue
        m = _TEAM.fullmatch(entry)
        if m is None:
            bad.append(entry)
            continue
        key = m[1].upper()
        if all(t["key"] != key for t in teams):
            teams.append({"key": key, "repo": m[2]})
    return teams, bad


def _result(obj: object) -> dict | None:
    """``obj`` as a ``PipelineTickResult``, its lists holding only what they should; None
    when it is not one."""
    if not isinstance(obj, dict) or not isinstance(obj.get("items"), list):
        return None
    graph = obj.get("graph") if isinstance(obj.get("graph"), dict) else {}

    def rows(value: object) -> list[dict]:
        return [r for r in value if isinstance(r, dict)] if isinstance(value, list) else []

    def strings(value: object) -> list[str]:
        return [s for s in value if isinstance(s, str)] if isinstance(value, list) else []

    return {**obj, "items": rows(obj["items"]),
            "graph": {"nodes": rows(graph.get("nodes")), "edges": rows(graph.get("edges"))},
            "effects": rows(obj.get("effects")), "events": rows(obj.get("events")),
            "notices": strings(obj.get("notices")), "unread": strings(obj.get("unread")),
            "fixable": strings(obj.get("fixable"))}


def tick(settings: dict, started: Callable | None = None) -> dict:
    """``pipeline-tick``: the ``PipelineTickResult`` (``{at, items, graph: {nodes,
    edges}, effects, events, notices, unread, fixable}``), or ``{"error": why}`` when the CLI
    could not answer. ``started`` is handed the core's process (:func:`promptcore.cli`).
    Never raises."""
    try:
        out = json.loads(promptcore.cli(["pipeline-tick"], stdin=settings,
                                        timeout=tick_timeout(settings), started=started))
    except Failure as exc:
        return {"error": str(exc)}
    result = _result(out)
    if result is None:
        return {"error": "diplomat-core pipeline-tick answered something that is not a sync"}
    return result


#: ``pipeline-last``'s date before the first sync.
_NEVER = "1970-01-01T00:00:00Z"


def last() -> dict | None:
    """``pipeline-last``: the last sync's result, as its ``last.json`` holds it; None
    before the first sync."""
    result = _result(json.loads(promptcore.cli(["pipeline-last"])))
    if result is None:
        raise ValueError("diplomat-core pipeline-last answered something that is not a sync")
    return None if result.get("at") == _NEVER else result


def _epoch(iso: str) -> float | None:
    try:
        return datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def ran_since(result: dict, started: float) -> bool:
    """Whether ``result`` is a sync begun at or after ``started`` (epoch seconds), not
    the last one answered again because ``tick.lock`` was held or could not be opened. A
    result is dated, to the second, when its sync began. Twin of ``Store.pipelineRan``."""
    at = _epoch(str(result.get("at") or ""))
    return at is not None and at >= math.floor(started)


# MARK: - reading a result


def fresh_events(result: dict, previous: dict | None) -> list[dict]:
    """The ``merged`` and ``fractured`` events of ``result`` newer than anything
    ``previous`` showed: none older than its newest event, nor one it held (events are
    stamped to the second, so two syncs can share one). With no previous result, those
    of ``result``'s own sync, which stamps them with its date. Twin of
    ``Store.pipelineFreshEvents``."""
    shown = (previous or {}).get("events") or []
    newest = (max((str(e.get("at") or "") for e in shown), default=None)
              if previous is not None else str(result.get("at") or ""))
    return [e for e in result.get("events") or []
            if e.get("kind") in ("merged", "fractured")
            and (newest is None or str(e.get("at") or "") >= newest)
            and e not in shown]


def event_line(event: dict, result: dict) -> str:
    """``#12: merged abc1234 with --admin --squash``: the item's label, else its link.
    Twin of ``Store.pipelineEventLine``."""
    item = str(event.get("item") or "")
    label = next((str(i.get("label") or "") for i in result.get("items") or []
                  if i.get("id") == item), "") or item
    return f"{label}: {event.get('detail') or ''}"


# MARK: - the attempt records of runs


def identity(url: str) -> str:
    """What a pipeline item is known by across the links that name it: a GitHub item
    key, a Linear issue's :func:`autofix.linear_item` (its URL's last segment follows
    the title), else the link itself. Twin of ``Store.pipelineIdentity``."""
    key = item_key_from_url(url)
    if key is not None:
        return key
    parts = urlsplit(url)
    host = parts.netloc.rpartition("@")[2].partition(":")[0]
    if parts.scheme and host.endswith("linear.app"):
        segments = [p for p in parts.path.split("/") if p]
        if "issue" in segments:
            i = segments.index("issue")
            if i + 1 < len(segments):
                return linear_item(segments[i + 1])
    return url


#: The attempt record keys of a fast-track review's and a fix's effect, before its link.
_REVIEW_PREFIX = "pipeline-review:"
_FIX_PREFIX = "pipeline-fix:"


def _open_keys(attempts: dict, kind: str, url: str) -> list[str]:
    """The open records a run of ``kind`` on ``url`` is the attempt of: a review's of
    its PR, a fix's of its issue. Twin of ``Store.pipelineOpenKeys``."""
    prefix = {QUEUE_REVIEW_ACTION: _REVIEW_PREFIX, QUEUE_ISSUES_ACTION: _FIX_PREFIX}.get(kind)
    if prefix is None:
        return []
    item = identity(url)
    return [k for k, a in attempts.items()
            if a.concluded_at is None and k.startswith(prefix)
            and identity(k[len(prefix):]) == item]


def concluded(attempts: dict, runs, now_ts: float) -> dict:
    """``attempts`` with the record of each of ``runs`` (``kind``, ``pr_url``,
    ``ledger_key``) stamped concluded: its agent said its turn was over, so what it left,
    a PR, a clean marker or nothing, is its answer. A monitor's run (its ``ledger_key``)
    answers that monitor, not the pipeline, whose runs carry none. Twin of
    ``Store.pipelineConcluded``."""
    out = dict(attempts)
    for run in runs:
        if run.ledger_key:
            continue
        for k in _open_keys(attempts, run.kind, run.pr_url or ""):
            out[k] = replace(out[k], concluded_at=now_ts)
    return out


#: How long a concluded record is kept after its run concluded, whatever syncs owe.
CONCLUDED_KEEP_SECS = 30 * 86400.0


def _root_of(url: str, teams: list[dict]) -> str:
    """The root, lowercased, an item's fix or review runs in: a GitHub item's own, a
    Linear issue's team's in ``teams`` (:func:`parse_linear_teams`); "" for none."""
    item = identity(url)
    linear = linear_item("")
    if item.startswith(linear):
        team = item[len(linear):].rpartition("-")[0].upper()
        return next((t["repo"].lower() for t in teams if t["key"] == team), "")
    split = split_item_key(item)
    return split[0].lower() if split else ""


def retained(attempts: dict, result: dict, now: float, teams: list[dict]) -> dict:
    """The records a sync keeps: each in a root it did not judge in full (``unread``),
    whose effect it may have left out; each while it owes the effect, so its retry
    ladder and its conclusion stand; for the backoff ceiling after its last dispatch,
    so an effect a failed read left out is not taken for a new one when it is back; and
    a concluded one for :data:`CONCLUDED_KEEP_SECS` after its run concluded, so a fix
    whose PR was closed unmerged is not asked for again. Twin of
    ``Store.retainedPipelineAttempts``."""
    owed = {str(e.get("key") or "") for e in result.get("effects") or []}
    unread = {r.lower() for r in result.get("unread") or []}
    return {k: a for k, a in attempts.items()
            if k in owed or _root_of(k.partition(":")[2], teams) in unread
            or now - a.last_dispatched_at < RETRY_MAX_BACKOFF
            or (a.concluded_at is not None and now - a.concluded_at < CONCLUDED_KEEP_SECS)}


def withdrawn(asks: list, result: dict | None, *, fix: bool, fast_track: bool) -> list[str]:
    """The keys of the pipeline's ``asks`` (``RequestedWork``) no longer owed: one a sync
    queued while its kind's switch (``fix``, ``fast_track``) is off; and in a root
    ``result`` (a sync's own; None judges by the switches alone) read in full, not
    ``unread``, one it emitted no effect for, or a Start fix (``by_hand``) whose issue is
    not ``fixable``. Twin of ``Store.pipelineWithdrawn``."""
    owed = {(e.get("kind") == "review", identity(str(e.get("url") or "")))
            for e in (result or {}).get("effects") or []}
    fixable = {identity(i) for i in (result or {}).get("fixable") or []}
    unread = {r.lower() for r in (result or {}).get("unread") or []}
    out = []
    for ask in asks:
        if not ask.pipeline:
            continue
        review = ask.action == QUEUE_REVIEW_ACTION
        if not ask.by_hand and not (fast_track if review else fix):
            out.append(ask.key)
        elif result is None or ask.repo.lower() in unread:
            continue
        elif ask.by_hand:
            if identity(ask.url) not in fixable:
                out.append(ask.key)
        elif (review, identity(ask.url)) not in owed:
            out.append(ask.key)
    return out


def spawned(attempts: dict, kind: str, url: str, now_ts: float) -> dict:
    """``attempts`` with the record of the queued job (``kind`` on ``url``) that just
    spawned dated then, so its retry backoff runs from the run rather than from the
    wait in the queue. Twin of ``Store.pipelineSpawned``."""
    out = dict(attempts)
    for k in _open_keys(attempts, kind, url):
        out[k] = replace(out[k], last_dispatched_at=now_ts)
    return out


def cancelled(attempts: dict, kind: str, url: str, now_ts: float) -> dict:
    """``attempts`` with the record of the queued ask (``kind`` on ``url``) the operator
    cancelled stamped concluded, so no sync asks for it again at that stamp. Twin of
    ``Store.pipelineCancelled``."""
    out = dict(attempts)
    for k in _open_keys(attempts, kind, url):
        out[k] = replace(out[k], concluded_at=now_ts)
    return out
