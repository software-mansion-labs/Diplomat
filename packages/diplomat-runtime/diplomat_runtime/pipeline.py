"""The Pipeline, as the Linux front-end reaches it.

Everything the pipeline decides is ``DiplomatCore``'s, reached through the
``diplomat-core`` CLI (``pipeline-tick``, ``pipeline-last``, ``pipeline-rate``), which
reads and writes ``$DIPLOMAT_PIPELINE_DIR`` (default ``~/.diplomat/pipeline``). What lives
here is calling it, the sync period, the Linear teams parse, and the rules the store reads
a result and its attempt records by, each the twin of the macOS one its docstring names.

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
from .autofix import (QUEUE_ISSUES_ACTION, QUEUE_RATE_ACTION, QUEUE_REVIEW_ACTION,
                      RETRY_MAX_BACKOFF, linear_item)
from .prref import item_key_from_url, split_item_key

#: What :func:`last` raises.
Failure = (RuntimeError, promptcore.CoreBinaryMissing, ValueError)

#: A personal Linear API key, which wins over the Linear login (:func:`linear_login`).
TOKEN_ENV = "DIPLOMAT_LINEAR_TOKEN"


def pipeline_dir() -> Path:
    """Must match ``PipelineLog.dir``: the core reads ``control.json`` there."""
    env = os.environ.get("DIPLOMAT_PIPELINE_DIR")
    return Path(env) if env else Path.home() / ".diplomat" / "pipeline"


#: The switches a running sync re-reads from ``control.json`` before each outward action.
CONTROL_KEYS = ("enabled", "rate", "mirrorGitHub", "mirrorLinear", "fix", "fastTrack", "merge",
                "fracture")

#: ``PipelineMirrorScope``'s cases, narrowest first.
MIRROR_SCOPES = ("prs", "mine", "all")


def write_control(switches: dict) -> None:
    """The switches, the mirror scope (``prs`` unless one of :data:`MIRROR_SCOPES`), and the
    ``revoke`` asks (when any), which a running sync applies right before each merge and its
    asks. Never raises: a sync that cannot read ``control.json``, or finds a key missing,
    goes by the settings it was started with. Twin of ``Store.writePipelineControl``."""
    folder = pipeline_dir()
    tmp = folder / f"control.json.tmp-{os.getpid()}-{uuid.uuid4().hex}"
    try:
        folder.mkdir(mode=0o700, parents=True, exist_ok=True)
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            control: dict = {k: bool(switches.get(k)) for k in CONTROL_KEYS}
            scope = switches.get("mirrorScope")
            control["mirrorScope"] = scope if scope in MIRROR_SCOPES else "prs"
            if switches.get("revoke"):
                control["revoke"] = sorted(switches["revoke"])
            json.dump(control, fh, sort_keys=True)
        os.replace(tmp, folder / "control.json")
    except OSError:
        with contextlib.suppress(OSError):
            tmp.unlink()


def control_revokes() -> list[str]:
    """The ``revoke`` asks ``control.json`` holds; none when it is missing or unreadable."""
    try:
        revoke = json.loads((pipeline_dir() / "control.json").read_text()).get("revoke")
    except (OSError, ValueError, AttributeError):
        return []
    return [r for r in revoke if isinstance(r, str)] if isinstance(revoke, list) else []


def tunables() -> dict:
    try:
        return core.pipeline()
    except core.CoreError:
        return {}


#: Well inside a ``QTimer`` interval's int32 milliseconds.
MAX_SYNC_SECS = 86400.0


SECS_ENV = "DIPLOMAT_PIPELINE_SECS"
_DECIMAL = re.compile(r"[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?", re.ASCII)


def sync_secs() -> float:
    """``$DIPLOMAT_PIPELINE_SECS``, else ``syncSecs``; never under ``minSyncSecs`` (a sync
    may spend ``claude`` calls), nor over a day. Twin of ``Store.pipelineSyncInterval``."""
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
#: Per rating or split claim: a diff, label creates, adds and removes.
_GH_CALLS_PER_CLAUDE = 16
#: Per split part: a re-read, the parts filed before (twice after a failed create), the
#: create and its sub-issue link.
_GH_CALLS_PER_PART = 5
#: Per kept rating a mirror labels past those answered (``labels.mirrorPerSync``): a re-read,
#: then for each of its two labels a create, an add and the other levels' removal.
_GH_CALLS_PER_MIRROR = 9
#: Per takeover or revoke asked: a re-read, then the fast-track label's create and add, or
#: the fast-track labels' removal; and a PR's clear in the same sync, as `cleared`'s.
_GH_CALLS_PER_TAKEOVER = 6
#: A root's merges: each PR read twice before ``gh pr merge`` (once without Linear) and
#: once after, and the three compares and two trees that keep it cleared past its base merged
#: into it.
_MERGES_PER_ROOT = 3
_GH_CALLS_PER_MERGE = 9
#: Linear's reads (300 issues, paged), its label and child writes, and the re-read of
#: their candidates: 3 calls of 100 at ``httpTimeoutSecs``; and the login's refresh.
_LINEAR_SECS = 300 + 4 * 30
#: The login shell's lookups of ``gh`` and ``claude``, and a margin for the rest.
_LOOKUP_SECS = 10
_MARGIN_SECS = 30


def _read_calls(t: dict) -> int:
    """The ``gh`` calls of a root's read at ``githubMaxItems`` open issues and as many open
    PRs, every page ``githubPage.least`` long, as timeouts may halve it to: ``Repo``
    carries the first page of each, and each halving is a call of its own."""
    page = t.get("githubPage") or {}
    least = max(1, int(page.get("least", 3)))
    halvings = 0
    for size in (int(page.get("issues", 100)), int(page.get("prs", 12))):
        while size > least:
            size = max(least, size // 2)
            halvings += 1
    return 2 * math.ceil(max(1, int(t.get("githubMaxItems", 300))) / least) - 1 + halvings


def tick_timeout(settings: dict) -> float:
    """How long ``pipeline-tick`` runs before it is killed: every call a sync may make, at
    its timeout. Its ``claude`` calls are the splits'; a rating runs as a queued job
    (:func:`rate`), the sync reading the diff it rates and writing the labels it answers.
    It bounds a wedged core, not a slow sync, so it is generous."""
    t = tunables()
    rater = t.get("rater") or {}
    force = settings.get("force") or {}
    splits = 1 + len(force.get("fracture") or [])
    ratings = int(rater.get("asks", 4)) + len(force.get("rate") or [])
    per_claude = float(rater.get("timeoutSecs", 300)) + 5 + _GH_CALLS_PER_CLAUDE * _GH_CALL_SECS
    per_split = (int((t.get("fracture") or {}).get("maxChildren", 6)) * _GH_CALLS_PER_PART
                 * _GH_CALL_SECS)
    takeovers = len(force.get("takeover") or []) + len(force.get("revoke") or [])
    mirrors = (int((t.get("labels") or {}).get("mirrorPerSync", 10))
               if settings.get("mirrorGitHub") or settings.get("mirrorLinear") else 0)
    roots = max(1, len(settings.get("roots") or []))
    return min(MAX_SYNC_SECS, ratings * _GH_CALLS_PER_CLAUDE * _GH_CALL_SECS
               + splits * (per_claude + per_split)
               + takeovers * _GH_CALLS_PER_TAKEOVER * _GH_CALL_SECS
               + mirrors * _GH_CALLS_PER_MIRROR * _GH_CALL_SECS
               + roots * (_read_calls(t) + _MERGES_PER_ROOT * _GH_CALLS_PER_MERGE) * _GH_CALL_SECS
               + len(settings.get("queued") or []) * _GH_CALL_SECS
               + (_LINEAR_SECS if settings.get("linearTeams") else 0)
               + _LOOKUP_SECS + _MARGIN_SECS)


#: Spaces, tabs and a pasted CRLF line's carriage return, never Unicode spacing.
_SPACE = " \t\r\v\f"
_TEAM = re.compile(r"([A-Za-z0-9]+)[ \t\r\v\f]*=[ \t\r\v\f]*([\w.-]+/[\w.-]+)", re.ASCII)


def parse_linear_teams(raw: str) -> tuple[list[dict], list[str]]:
    """``PipelineSettings.linearTeams`` from the Settings text ``ENG=owner/repo,
    OPS=owner/other``, and the entries that are not ``KEY=owner/repo``, as typed. Keys are
    read in capitals, as Linear spells them; a team named twice keeps its first repo. Twin
    of ``PipelineSettings.LinearTeam.parse``, which ``diplomat-core pipeline-teams``
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
            "fixable": strings(obj.get("fixable")), "read": strings(obj.get("read"))}


def tick(settings: dict, started: Callable | None = None) -> dict:
    """``pipeline-tick``'s ``PipelineTickResult``, else ``{"error": why}``; never raises.
    ``started`` is handed the core's process (:func:`promptcore.cli`)."""
    try:
        out = json.loads(promptcore.cli(["pipeline-tick"], stdin=settings,
                                        timeout=tick_timeout(settings), started=started))
    except Failure as exc:
        return {"error": str(exc)}
    result = _result(out)
    if result is None:
        return {"error": "diplomat-core pipeline-tick answered something that is not a sync"}
    return result


def rate(item: str, stamp: str, *, cancel: bool = False,
         started: Callable | None = None) -> dict:
    """``pipeline-rate``'s ``{"outcome", "detail"}`` for the rating a sync asked of ``item``
    (its effect's ``url``) at ``stamp``, else ``{"error": why}``; never raises. Run, it
    makes the rater's call, so it is given the rater's ``timeoutSecs`` and a margin; with
    ``cancel``, it cancels the ask instead. ``started`` is handed the core's process
    (:func:`promptcore.cli`)."""
    timeout = (30.0 if cancel else float((tunables().get("rater") or {}).get("timeoutSecs", 300))
               + 5 + _MARGIN_SECS)
    ask = {"item": item, "stamp": stamp, **({"cancel": True} if cancel else {})}
    try:
        out = json.loads(promptcore.cli(["pipeline-rate"], stdin=ask, timeout=timeout,
                                        started=started))
    except Failure as exc:
        return {"error": str(exc)}
    if not isinstance(out, dict) or not isinstance(out.get("outcome"), str):
        return {"error": "diplomat-core pipeline-rate answered something that is not an outcome"}
    return {"outcome": out["outcome"], "detail": str(out.get("detail") or "")}


#: The date of a result no sync produced: ``pipeline-last``'s before the first sync, and a
#: locked-out ``pipeline-tick``'s.
NEVER = "1970-01-01T00:00:00Z"


def last() -> dict | None:
    """The last sync's result; None before the first sync."""
    result = _result(json.loads(promptcore.cli(["pipeline-last"])))
    if result is None:
        raise ValueError("diplomat-core pipeline-last answered something that is not a sync")
    return None if result.get("at") == NEVER else result


def _epoch(iso: str) -> float | None:
    try:
        return datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def ran_since(result: dict, started: float) -> bool:
    """Whether ``result`` is a sync begun at or after ``started`` (epoch seconds), not the
    last one answered again because the core could not take ``tick.lock``. Results are
    dated to the second. Twin of ``Store.pipelineRan``."""
    at = _epoch(str(result.get("at") or ""))
    return at is not None and at >= math.floor(started)


# MARK: - the Linear login


#: ``SlackAPI.curl``'s grace past a request's timeout.
_HTTP_GRACE_SECS = 5


def _linear_call_secs(t: dict) -> float:
    return float(t.get("httpTimeoutSecs", 30)) + _HTTP_GRACE_SECS


def _linear_answer(verb: str, timeout: float, started: Callable | None = None,
                   line: Callable | None = None) -> tuple[dict | None, str]:
    """The last line of ``diplomat-core <verb>``'s stdout, read as an object."""
    try:
        out = promptcore.cli([verb], timeout=timeout, started=started, line=line)
    except (RuntimeError, promptcore.CoreBinaryMissing) as exc:
        return None, str(exc)
    try:
        answer = json.loads((out.strip().splitlines() or [""])[-1])
    except ValueError:
        answer = None
    if not isinstance(answer, dict):
        return None, f"diplomat-core {verb} answered something that is not an answer"
    return answer, ""


def linear_login(started: Callable | None = None,
                 page: Callable[[str], None] | None = None) -> tuple[dict | None, str]:
    """``({"user", "organization"}, "")`` once signed in to Linear in the browser, else
    ``(None, why not)``. ``page`` is handed Linear's consent page to open, ``started``
    the core's process, whose SIGTERM cancels a sign-in still waiting for the browser.
    Bounded by ``signInSecs`` and three Linear calls: the code's exchange, who the token
    is, and a sync's refresh holding the login's lock. Never raises."""
    def line(text: str) -> None:
        with contextlib.suppress(ValueError, AttributeError):
            url = json.loads(text).get("url")
            if isinstance(url, str) and page is not None:
                page(url)

    t = tunables()
    timeout = (float((t.get("linearOAuth") or {}).get("signInSecs", 300))
               + 3 * _linear_call_secs(t) + _MARGIN_SECS)
    answer, error = _linear_answer("linear-login", timeout, started, line)
    if answer is None:
        return None, error
    if answer.get("ok") is not True:
        return None, str(answer.get("error") or "Linear sign-in did not say why it failed")
    return {"user": str(answer.get("user") or ""),
            "organization": str(answer.get("organization") or "")}, ""


def linear_logout() -> tuple[bool, str]:
    """``(True, why Linear did not revoke the login, else "")`` once it is forgotten, else
    ``(False, why not)``. Never raises."""
    answer, error = _linear_answer(
        "linear-logout", 2 * _linear_call_secs(tunables()) + _MARGIN_SECS)
    if answer is None:
        return False, error
    if answer.get("ok") is not True:
        return False, str(answer.get("error") or "Linear sign-out did not say why it failed")
    return True, str(answer.get("warning") or "")


def linear_whoami() -> dict | None:
    """``{"user", "organization"}`` of the saved login, without a call to Linear; None
    when there is none, or the core cannot say. Never raises."""
    answer, _ = _linear_answer("linear-whoami", 10)
    if answer is None or "user" not in answer:
        return None
    return {"user": str(answer["user"]), "organization": str(answer.get("organization") or "")}


# MARK: - reading a result


def fresh_events(result: dict, previous: dict | None) -> list[dict]:
    """The ``merged`` and ``fractured`` events of ``result`` newer than anything
    ``previous`` showed: none older than its newest, nor one it held (events are stamped
    to the second, so two syncs can share one). With no ``previous``, those stamped with
    ``result``'s own date. Twin of ``Store.pipelineFreshEvents``."""
    shown = (previous or {}).get("events") or []
    newest = (max((str(e.get("at") or "") for e in shown), default=None)
              if previous is not None else str(result.get("at") or ""))
    return [e for e in result.get("events") or []
            if e.get("kind") in ("merged", "fractured")
            and (newest is None or str(e.get("at") or "") >= newest)
            and e not in shown]


def event_line(event: dict, result: dict) -> str:
    """``#12: merged abc1234 with --admin --squash``. Twin of ``Store.pipelineEventLine``."""
    item = str(event.get("item") or "")
    label = next((str(i.get("label") or "") for i in result.get("items") or []
                  if i.get("id") == item), "") or item
    return f"{label}: {event.get('detail') or ''}"


# MARK: - the attempt records of runs


def identity(url: str) -> str:
    """What a pipeline item is known by across the links that name it: a GitHub item
    key, a Linear issue's :func:`autofix.linear_item` (not its URL's last segment, a title
    slug), else the link itself. Twin of ``Store.pipelineIdentity``."""
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


#: An attempt record's key: one of these, then its effect's link.
_REVIEW_PREFIX = "pipeline-review:"
_FIX_PREFIX = "pipeline-fix:"


def _open_keys(attempts: dict, kind: str, url: str) -> list[str]:
    """The open records a run of ``kind`` on ``url`` is the attempt of. Twin of
    ``Store.pipelineOpenKeys``."""
    prefix = {QUEUE_REVIEW_ACTION: _REVIEW_PREFIX, QUEUE_ISSUES_ACTION: _FIX_PREFIX}.get(kind)
    if prefix is None:
        return []
    item = identity(url)
    return [k for k, a in attempts.items()
            if a.concluded_at is None and k.startswith(prefix)
            and identity(k[len(prefix):]) == item]


def concluded(attempts: dict, runs, now_ts: float) -> dict:
    """``attempts`` with the record of each of ``runs`` (``kind``, ``pr_url``,
    ``ledger_key``) stamped concluded: its agent said its turn was over, so what it left
    is its answer. A monitor's run (its ``ledger_key``) answers that monitor, not the
    pipeline, whose runs carry none. Twin of ``Store.pipelineConcluded``."""
    out = dict(attempts)
    for run in runs:
        if run.ledger_key:
            continue
        for k in _open_keys(attempts, run.kind, run.pr_url or ""):
            out[k] = replace(out[k], concluded_at=now_ts)
    return out


CONCLUDED_KEEP_SECS = 30 * 86400.0


def _root_of(url: str, teams: list[dict]) -> str:
    """The root, lowercased, an item's fix or review runs in; "" for none."""
    item = identity(url)
    linear = linear_item("")
    if item.startswith(linear):
        team = item[len(linear):].rpartition("-")[0].upper()
        return next((t["repo"].lower() for t in teams if t["key"] == team), "")
    split = split_item_key(item)
    return split[0].lower() if split else ""


def _short(result: dict, handed: list[str] | None) -> Callable[[str], bool]:
    """Whether a root (lowercased) was judged on less than all it holds: in ``unread``,
    or not ``handed`` to the sync (None when every root path resolved)."""
    unread = {r.lower() for r in result.get("unread") or []}
    given = None if handed is None else {r.lower() for r in handed}
    return lambda root: root in unread or (given is not None and root not in given)


def retained(attempts: dict, result: dict, now: float, teams: list[dict], *,
             handed: list[str] | None = None) -> dict:
    """The records a sync keeps: each it may have left out (:func:`_short`, not ``read``);
    each while it owes the effect, so its retry ladder and its conclusion stand; for the
    backoff ceiling after its last dispatch, so an effect a failed read left out is not
    taken for a new one when it is back; and a concluded one for
    :data:`CONCLUDED_KEEP_SECS`, so a fix whose PR was closed unmerged is not asked for
    again. Twin of ``Store.retainedPipelineAttempts``."""
    owed = {str(e.get("key") or "") for e in result.get("effects") or []}
    short = _short(result, handed)
    read = {identity(i) for i in result.get("read") or []}

    def unseen(url: str) -> bool:
        return short(_root_of(url, teams)) and identity(url) not in read

    return {k: a for k, a in attempts.items()
            if k in owed or unseen(k.partition(":")[2])
            or now - a.last_dispatched_at < RETRY_MAX_BACKOFF
            or (a.concluded_at is not None and now - a.concluded_at < CONCLUDED_KEEP_SECS)}


#: The queue verb of each effect kind's ask.
_ACTIONS = {"fixIssue": QUEUE_ISSUES_ACTION, "fixLinear": QUEUE_ISSUES_ACTION,
            "review": QUEUE_REVIEW_ACTION, "rate": QUEUE_RATE_ACTION}


def withdrawn(asks: list, result: dict | None, *, fix: bool, fast_track: bool, rate: bool,
              handed: list[str] | None = None) -> list[str]:
    """The keys of the pipeline's ``asks`` (``RequestedWork``) no longer owed: one a sync
    queued while its kind's switch is off; one ``result`` (a sync's own; None judges by
    the switches alone) judged and emitted no effect for, for a rating none at its stamp;
    and a Start fix in a root judged in full whose issue is not ``fixable``. A rating Rate
    now forced goes by its stamp alone. Twin of ``Store.pipelineWithdrawn``."""
    def owing(action: str | None, url: str, stamp: object) -> tuple:
        return action, identity(url), str(stamp or "") if action == QUEUE_RATE_ACTION else ""

    owed = {owing(_ACTIONS.get(e.get("kind")), str(e.get("url") or ""), e.get("stamp"))
            for e in (result or {}).get("effects") or []}
    fixable = {identity(i) for i in (result or {}).get("fixable") or []}
    seen = set() if result is None else set(judged(asks, result, handed=handed))
    short = _short(result or {}, handed)
    out = []
    for ask in asks:
        if not ask.pipeline:
            continue
        rating = ask.action == QUEUE_RATE_ACTION
        on = {QUEUE_REVIEW_ACTION: fast_track, QUEUE_RATE_ACTION: rate}.get(ask.action, fix)
        if not ask.by_hand and not on:
            out.append(ask.key)
        elif result is None:
            continue
        elif ask.by_hand and not rating:
            if not short(ask.repo.lower()) and identity(ask.url) not in fixable:
                out.append(ask.key)
        elif owing(ask.action, ask.url, ask.config.get("stamp")) not in owed and ask.key in seen:
            out.append(ask.key)
    return out


def judged(asks: list, result: dict, *, handed: list[str] | None = None) -> list[str]:
    """The keys of the pipeline's ``asks`` whose item ``result`` (a sync's own) judged: in
    a root it judged in full (:func:`_short`), or by reading it. Twin of
    ``Store.pipelineJudgedAsks``."""
    short = _short(result, handed)
    read = {identity(i) for i in result.get("read") or []}
    return [a.key for a in asks
            if a.pipeline and (not short(a.repo.lower()) or identity(a.url) in read)]


def queued(asks: list, attempts: dict) -> list[str]:
    """``PipelineSettings.queued``: the items of the pipeline's ``asks`` and of its
    ``attempts`` records, which a sync that reads the item lets :func:`retained` prune.
    Twin of ``Store.pipelineQueued``."""
    return sorted({a.url for a in asks if a.pipeline} | {k.partition(":")[2] for k in attempts})


def spawned(attempts: dict, kind: str, url: str, now_ts: float) -> dict:
    """``attempts`` with the record of the job (``kind`` on ``url``) that just spawned
    dated then, so its retry backoff runs from the run, not its wait in the queue. Twin of
    ``Store.pipelineSpawned``."""
    out = dict(attempts)
    for k in _open_keys(attempts, kind, url):
        out[k] = replace(out[k], last_dispatched_at=now_ts)
    return out


def cancelled(attempts: dict, kind: str, url: str, now_ts: float) -> dict:
    """``attempts`` with the record of the ask (``kind`` on ``url``) the operator cancelled
    stamped concluded, so no sync asks for it again. Twin of ``Store.pipelineCancelled``."""
    out = dict(attempts)
    for k in _open_keys(attempts, kind, url):
        out[k] = replace(out[k], concluded_at=now_ts)
    return out
