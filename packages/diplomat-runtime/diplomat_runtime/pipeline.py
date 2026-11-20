"""The Pipeline, as the Linux front-end reaches it.

Everything the pipeline decides - reading the trackers, rating, labelling, merging,
fracturing, the graph and the effects - is ``DiplomatCore``, reached through the
``diplomat-core`` CLI (``pipeline-tick``, ``pipeline-last``), which reads and writes
``$DIPLOMAT_PIPELINE_DIR`` (default ``~/.diplomat/pipeline``). What lives here is calling
it, the sync period of ``assets/pipeline.json``, and the parse of the Linear teams
setting into ``PipelineSettings.linearTeams``.

Stdlib-only, like the rest of the runtime.
"""

from __future__ import annotations

import json
import math
import re

from . import core, promptcore

#: Raised by :func:`last`: the CLI's own reason, or why it could not run.
Failure = (RuntimeError, promptcore.CoreBinaryMissing, ValueError)

#: The Linear key's environment override, which wins over ``linearTokenFile``.
TOKEN_ENV = "DIPLOMAT_LINEAR_TOKEN"


def tunables() -> dict:
    try:
        return core.pipeline()
    except core.CoreError:
        return {}


#: A day: well inside a ``QTimer`` interval's int32 milliseconds.
MAX_SYNC_SECS = 86400.0


def sync_secs() -> float:
    """``syncSecs``, held between ``minSyncSecs`` and a day."""
    t = tunables()
    secs = float(t.get("syncSecs", 300))
    if not math.isfinite(secs):
        secs = 300.0
    return min(MAX_SYNC_SECS, max(float(t.get("minSyncSecs", 60)), secs))


#: ``GH.timeout`` plus the five seconds ``GH.stop`` waits before its SIGKILL.
_GH_CALL_SECS = 65
#: The ``gh`` calls one rating or fracture may bring: a diff, label creates, adds and
#: removes, a fractured issue's children and their sub-issue links.
_GH_CALLS_PER_CLAUDE = 16
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
    calls around it; the roots' reads and merges; Linear. It bounds a wedged core, not
    a slow sync, so it is generous."""
    rater = tunables().get("rater") or {}
    force = settings.get("force") or {}
    claude_calls = (int(rater.get("perSync", 4)) + 1 + len(force.get("rate") or [])
                    + len(force.get("fracture") or []))
    per_claude = float(rater.get("timeoutSecs", 300)) + 5 + _GH_CALLS_PER_CLAUDE * _GH_CALL_SECS
    roots = max(1, len(settings.get("roots") or []))
    return (claude_calls * per_claude + roots * _GH_CALLS_PER_ROOT * _GH_CALL_SECS
            + (_LINEAR_SECS if settings.get("linearTeams") else 0)
            + _LOOKUP_SECS + _MARGIN_SECS)


_TEAM = re.compile(r"^([A-Za-z0-9]+)\s*=\s*([\w.-]+/[\w.-]+)$")


def parse_linear_teams(raw: str) -> tuple[list[dict], list[str]]:
    """``PipelineSettings.linearTeams`` from the Settings text ``ENG=owner/repo,
    OPS=owner/other`` (commas, semicolons or new lines between entries), and the
    entries that are not ``KEY=owner/repo``. Linear spells a team key in capitals; a
    team named twice keeps its first repo."""
    teams: list[dict] = []
    bad: list[str] = []
    for entry in (e.strip() for e in re.split(r"[,;\n]", raw or "")):
        if not entry:
            continue
        m = _TEAM.match(entry)
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

    notices = obj.get("notices")
    return {**obj, "items": rows(obj["items"]),
            "graph": {"nodes": rows(graph.get("nodes")), "edges": rows(graph.get("edges"))},
            "effects": rows(obj.get("effects")), "events": rows(obj.get("events")),
            "notices": ([n for n in notices if isinstance(n, str)]
                        if isinstance(notices, list) else [])}


def tick(settings: dict) -> dict:
    """``pipeline-tick``: the ``PipelineTickResult`` (``{at, items, graph: {nodes,
    edges}, effects, events, notices}``), or ``{"error": why}`` when the CLI could not
    answer. Never raises."""
    try:
        out = json.loads(promptcore.cli(["pipeline-tick"], stdin=settings,
                                        timeout=tick_timeout(settings)))
    except Failure as exc:
        return {"error": str(exc)}
    result = _result(out)
    if result is None:
        return {"error": "diplomat-core pipeline-tick answered something that is not a sync"}
    return result


def last() -> dict:
    """``pipeline-last``: the last sync's result, as its ``last.json`` holds it."""
    result = _result(json.loads(promptcore.cli(["pipeline-last"])))
    if result is None:
        raise ValueError("diplomat-core pipeline-last answered something that is not a sync")
    return result
