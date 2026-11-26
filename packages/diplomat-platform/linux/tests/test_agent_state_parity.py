"""`diplomat_runtime.agentstate` vs `DiplomatCore/AgentState.swift`, over one table.

The two are two implementations of one decision, and neither can delegate to the
other: this resolver runs on the panel's 8-second poll and on every dispatch, so a
subprocess per tick is not an option. A drift would be invisible in the worst way —
both applets keep drawing rows, they just quietly disagree about whether your agent
is still running.

So every case in ``test_agent_state.py`` is driven through both here, and the whole
tick is diffed: every record's resolved state and *reason text*, drawn or not, the
display order of the rows, the cap load, what is retirable, the free-slot count and
the per-item dedup answer. Reasons are compared verbatim rather than loosely, because
the reason is what a future debugging session reads — two sides that agree on the
verdict and disagree on why are two sides that will diverge on the next rung.

Mirrors `test_tooldata_parity.py` / `test_telemetry_parity.py`, including the
`DIPLOMAT_CORE_BIN` skip guard.
"""

from __future__ import annotations

import json
import os
import subprocess
import time

import pytest

from dataclasses import replace

from diplomat_runtime import agentstate as A
from diplomat_runtime import network as N

# The scenario table itself, so the two languages are pinned against exactly the
# cases the Python side already asserts rather than a second, drifting copy.
from test_agent_state import (
    AT_PROMPT, CASES, NO_DAEMON, PAST_DEADLINE, PEER, RELEASED_UNSEEN, T0, TASK, WORKING,
    ev, net, offer, proc, rec,
)

CORE_BIN = os.environ.get("DIPLOMAT_CORE_BIN")
pytestmark = pytest.mark.skipif(
    not CORE_BIN,
    reason="DIPLOMAT_CORE_BIN not set (build it with "
           "packages/diplomat-platform/linux/install/build-core.sh)")

#: The cap the fixture compares free slots against. Two, so a single occupied bay is
#: neither zero nor the whole cap and an off-by-one shows up.
LIMIT = 2


#: No ``networkSnapshot`` in the payload at all, as against a daemon that gave none.
_NO_SNAPSHOT = object()


def _payload(records, evidence, now=T0, limit=LIMIT,
             deadline=A.RUN_DEADLINE, snapshot=_NO_SNAPSHOT) -> dict:
    return {
        "now": now,
        "limit": limit,
        "deadline": deadline,
        "records": [r.to_json() for r in records],
        "evidence": evidence.to_json(),
        **({} if snapshot is _NO_SNAPSHOT else {"networkSnapshot": snapshot}),
    }


def _swift(payload: dict) -> dict:
    proc_ = subprocess.run([CORE_BIN, "agent-state"],
                           input=json.dumps(payload).encode("utf-8"),
                           capture_output=True, timeout=60, check=False)
    assert proc_.returncode == 0, \
        f"diplomat-core agent-state failed: {proc_.stderr.decode('utf-8', 'replace')}"
    return json.loads(proc_.stdout)


def _dump(s: N.Snapshot) -> dict:
    """The snapshot as this side read it, member for member, in the shape the CLI
    prints its own reading in."""
    return {
        "updatedAt": s.updated_at, "pid": s.pid, "startedAt": s.started_at,
        "pk": s.pk, "onion": s.onion,
        "transport": {"state": s.transport.state, "detail": s.transport.detail},
        "model": {"state": s.model.state, "detail": s.model.detail},
        "docker": {"state": s.docker.state, "image": s.docker.image,
                   "detail": s.docker.detail},
        "admit": {"slots": s.admit.slots, "at": s.admit.at, "reason": s.admit.reason},
        "pools": [{
            "id": p.id, "path": p.path, "identity": p.identity, "hash": p.hash,
            "left": p.left, "joining": p.joining, "joinFailed": p.join_failed,
            "returning": p.returning, "unseated": p.unseated,
            "notTaking": p.not_taking,
            "members": [{"pk": m.pk, "self": m.is_self, "maxAcceptedH": m.max_accepted_h,
                         "lastSeen": m.last_seen, "reachable": m.reachable}
                        for m in p.members],
            "tasks": [{"taskId": t.task_id, "kind": t.kind, "item": t.item,
                       "title": t.title, "identity": t.identity, "hours": t.hours,
                       "state": t.state, "offeredBy": list(t.offered_by),
                       "offeredHere": t.offered_here, "executor": t.executor,
                       "executorHere": t.executor_here, "claimedAt": t.claimed_at,
                       "leaseUntil": t.lease_until, "deadline": t.deadline}
                      for t in p.tasks]} for p in s.pools],
        "runs": [{"runId": r.run_id, "taskId": r.task_id, "pool": r.pool, "peer": r.peer,
                  "container": r.container, "state": r.state, "startedAt": r.started_at,
                  "endedAt": r.ended_at, "exit": r.exit} for r in s.runs],
        "offers": None if s.offers is None else [{
            "taskId": o.task_id, "pool": o.pool, "kind": o.kind, "item": o.item,
            "title": o.title, "state": o.state, "reason": o.reason,
            "executor": o.executor, "executorHere": o.executor_here,
            "offeredAt": o.offered_at,
            "attempt": o.attempt, "requests": o.requests, "refused": o.refused,
            "outcome": None if o.outcome is None else {
                "ok": o.outcome.ok, "summary": o.outcome.summary, "usd": o.outcome.usd,
                "tokens": o.outcome.tokens, "runner": o.outcome.runner,
                "model": o.outcome.model, "capped": o.outcome.capped},
            "endedAt": o.ended_at, "notTaking": o.not_taking} for o in s.offers],
    }


def _python(records, evidence, now=T0, limit=LIMIT,
            deadline=A.RUN_DEADLINE, snapshot=_NO_SNAPSHOT) -> dict:
    parsed = N.Snapshot.from_json(snapshot) if isinstance(snapshot, dict) else None
    if snapshot is not _NO_SNAPSHOT:
        evidence = replace(evidence, network=N.tasks(parsed))
    t = A.tick(records, evidence, now, limit, deadline)

    def verdict(s: A.Resolution) -> dict:
        return {"state": s.state, "reason": s.reason, "wedged": s.wedged,
                "expired": s.expired, "lapsed": s.lapsed, "reported": s.reported,
                "spent": s.spent}

    return {
        "rows": [{"runId": r.run_id, **verdict(s)} for r, s in t.rows],
        "states": {run_id: verdict(s) for run_id, s in t.states.items()},
        "capLoad": sorted(t.cap_load),
        "retirable": sorted(r.run_id for r in t.retirable),
        "reapable": sorted(r.run_id for r in t.reapable),
        "closeOnRetire": sorted(r.run_id for r in t.close_on_retire),
        "withdrawable": sorted(r.run_id for r in t.withdrawable),
        "withdrawOnForget": sorted(r.run_id for r in t.records
                                   if A.withdraw_on_forget(r, evidence) is not None),
        "network": ({"present": {task: seen.to_json()
                                 for task, seen in evidence.network.value.items()}}
                    if evidence.network.ok else {"unavailable": evidence.network.reason}),
        "networkSnapshot": None if parsed is None else _dump(parsed),
        "networkRunning": N.running(parsed),
        "freeSlots": t.free_slots,
        "constants": {"runDeadline": A.RUN_DEADLINE,
                      "quietTimeout": A.QUIET_TIMEOUT,
                      "spawnGrace": A.SPAWN_GRACE},
        "inFlight": {item: t.in_flight(item)
                     for item in {r.item for r in t.records if r.item is not None}},
        # quietDigest is compared because the two languages COMPUTE it, rather than
        # merely carrying it: it is persisted into the one book both front-ends read,
        # so a digest that differed would restart the stillness clock on every
        # hand-over. The mixed fixture gives several runs a screen, so a drift in
        # either implementation of `pane_digest` fails here. reapRefusedAt is merely
        # carried, and is here because a decode that dropped it would silence nothing
        # and show nothing: the applet that lost it would simply never wait before
        # retrying a window it cannot close, and would go on retiring the run. pid, tty,
        # dispatchedAt and source are what a released record inherits from the run it
        # replaces, and the pid is its identity from then on.
        "records": [{"runId": r.run_id, "network": r.network,
                     "untracked": r.untracked, "released": r.released,
                     "source": r.source,
                     "pid": r.pid, "tty": r.tty, "dispatchedAt": r.dispatched_at,
                     "quietDigest": r.quiet_digest, "quietSince": r.quiet_since,
                     "reapRefusedAt": r.reap_refused_at}
                    for r in t.records],
    }


def _python_decoding(payload: dict) -> dict:
    """The same answer, but with Python's own decoders in the path rather than the
    objects the payload was built from.

    Every other run here hands Python the records and evidence directly, which is right
    for diffing the RESOLVER but leaves the two decoders of this wire format untested
    against each other. They are the other half of the parity claim: two sides that read
    one payload differently disagree before a rung has run.
    """
    return _python([A.RunRecord.from_json(r) for r in payload["records"]],
                   A.Evidence.from_json(payload["evidence"]),
                   now=payload["now"], limit=payload["limit"],
                   deadline=payload["deadline"],
                   snapshot=payload.get("networkSnapshot", _NO_SNAPSHOT))


#: Values a hand-written payload puts where a JSON boolean belongs. `1` and `1.0` are
#: the ones that mattered: `JSONSerialization` bridges a JSON number to `NSNumber`, and
#: `NSNumber(1) as? Bool` is `true`, so this exact fixture used to resolve `finished`
#: and reapable on the Swift side and `running` on the Python one.
_NOT_A_FLAG = [1, 1.0, 0, 2, "true", "", None, []]


@pytest.mark.parametrize("value", _NOT_A_FLAG, ids=[repr(v) for v in _NOT_A_FLAG])
def test_a_token_reading_that_is_not_a_boolean_is_read_the_same_by_both(value):
    """The deadline's precondition, and the one flag both decoders are strict about by
    name. A run five hours old with a positive reading is finished, reaped and priced;
    with anything else it is a run that is still going."""
    record = rec(run_id="r1", pid=1, tty="pts/3", dispatched_at=T0 - PAST_DEADLINE,
                 pr_number=301)
    evidence = ev(processes={1: proc(elapsed=PAST_DEADLINE)},
                  tails={"pts/3": WORKING}, tokens=True)
    payload = _payload([record], evidence)
    payload["evidence"]["tokensLeft"]["value"] = value

    swift, python = _swift(payload), _python_decoding(payload)
    assert swift == python
    assert python["reapable"] == [], "only a real reading may end a run on the clock"


@pytest.mark.parametrize("value", _NOT_A_FLAG, ids=[repr(v) for v in _NOT_A_FLAG])
def test_a_record_flag_that_is_not_a_boolean_is_read_the_same_by_both(value):
    """`untracked` decides whether the deadline may look at a record at all, so it is
    the same hazard one field over."""
    record = rec(run_id="r1", pid=1, tty="pts/3", dispatched_at=T0 - PAST_DEADLINE,
                 pr_number=301)
    evidence = ev(processes={1: proc(elapsed=PAST_DEADLINE)},
                  tails={"pts/3": WORKING}, tokens=True)
    payload = _payload([record], evidence)
    payload["records"][0]["untracked"] = value

    assert _swift(payload) == _python_decoding(payload)


@pytest.mark.parametrize("wide", ["1e300", "99999999999999999999", "1e19"])
def test_a_wide_integer_in_a_record_is_read_the_same_by_both(wide):
    """The CLI decodes its records by a hand of its own, and every other payload here
    carries records Python normalized first. A pid or PR number outside Int64 is
    absent on both sides - the run has no pid, and the PR is not in flight - while
    a finite double stays what it is."""
    raw = json.loads(f'{{"runId": "r1", "dispatchedAt": {T0 - 60}, "tty": "pts/3", '
                     f'"pid": {wide}, "prNumber": {wide}, "quietSince": 1e300}}')
    # No screen: a read one restarts the stillness clock, and the clock is what
    # shows a finite double staying what it is.
    payload = _payload([], ev(processes={4242: proc()}, tokens=True))
    payload["records"] = [raw]

    swift, python = _swift(payload), _python_decoding(payload)
    assert swift == python
    assert python["inFlight"] == {}
    assert python["records"][0]["quietSince"] == 1e300


@pytest.mark.parametrize("key", ["pid", "dispatchedAt", "prNumber"])
def test_a_record_number_that_is_a_boolean_is_read_the_same_by_both(key):
    """The other direction: `true` is not pid 1, nor a run dispatched in 1970. Both
    decoders see a `Flag`/`bool` there and read the field's default."""
    record = rec(run_id="r1", pid=1, tty="pts/3", dispatched_at=T0 - PAST_DEADLINE,
                 pr_number=1)
    evidence = ev(processes={1: proc(elapsed=PAST_DEADLINE)},
                  tails={"pts/3": WORKING}, tokens=True)
    payload = _payload([record], evidence)
    payload["records"][0][key] = True

    assert _swift(payload) == _python_decoding(payload)


def test_the_real_booleans_still_survive_both_decoders():
    """Anti-vacuity for the two above: strictness that dropped every flag would agree
    just as well, and say nothing."""
    record = rec(run_id="r1", pid=1, tty="pts/3", dispatched_at=T0 - PAST_DEADLINE,
                 pr_number=301)
    evidence = ev(processes={1: proc(elapsed=PAST_DEADLINE)},
                  tails={"pts/3": WORKING}, tokens=True)
    payload = _payload([record], evidence)

    swift, python = _swift(payload), _python_decoding(payload)
    assert swift == python
    assert python["reapable"] == ["r1"], "a genuine reading must still arm the deadline"


@pytest.mark.parametrize("name,record,evidence,_state,_reason", CASES,
                         ids=[c[0] for c in CASES])
def test_each_scenario_resolves_identically(name, record, evidence, _state, _reason):
    payload = _payload([record], evidence)
    assert _swift(payload) == _python([record], evidence), name


# MARK: - One fixture that exercises every projection at once
#
# The per-case runs above each hold a single record, so they cannot catch a
# disagreement about ORDER, about which records are summed into the cap, or about the
# adopt-then-synthesize sequence. This one does.


def _mixed():
    """Records covering every state a readable machine produces and both sources, plus
    a live PR with no record so the untracked synthesis runs."""
    records = [
        rec(run_id="working", pid=1, dispatched_at=T0 - 300, pr_number=301),
        rec(run_id="at-prompt", pid=2, tty="pts/4", dispatched_at=T0 - 400,
            pr_number=302),
        rec(run_id="clicked", pid=3, tty="pts/5", source=A.SOURCE_PANEL,
            dispatched_at=T0 - 500, pr_number=303),
        rec(run_id="exited", pid=99, dispatched_at=T0 - 600, pr_number=304),
        rec(run_id="landed", pid=4, tty="pts/6", dispatched_at=T0 - 700,
            pr_number=305),
        rec(run_id="just-spawned", pid=None, dispatched_at=T0 - 3, pr_number=309),
        # Pid-less long past the grace: the spawn's own report that its terminal never
        # ran the command. Carries a PR the scan cannot find, so the two sides also
        # have to agree on which of the two rungs answers first.
        rec(run_id="never-ran", pid=None, tty="", dispatched_at=T0 - 5000,
            pr_number=310),
        # The same, found by the prompt scan.
        rec(run_id="no-pid-seen", pid=None, tty="", dispatched_at=T0 - 5000,
            pr_number=311),
        # Alive, working, and past the deadline — so the fixture carries the one rung
        # that overrules a screen rather than reading it, and the two sides have to
        # agree on the age it quotes as well as on the verdict.
        rec(run_id="over-deadline", pid=6, tty="pts/10",
            dispatched_at=T0 - PAST_DEADLINE, pr_number=312),
        # Its CLI reported the turn over with its agent still up and seen by the scan,
        # so this tick also releases that agent.
        rec(run_id="reported", pid=7, tty="pts/11", dispatched_at=T0 - 1100,
            pr_number=313),
        # Untracked, working, and first seen past the deadline: RUNNING without a bay.
        rec(run_id="untracked:o/r#314", pid=None, tty="pts/12", untracked=True,
            dispatched_at=T0 - PAST_DEADLINE, pr_number=314),
        # Released on an earlier tick, and somebody typed into it since. The scan names a
        # second session on its PR, which a pid-held record does not follow.
        rec(run_id="untracked:o/r#315", pid=8, tty="pts/13", untracked=True, released=True,
            dispatched_at=T0 - 1200, pr_number=315),
        # Reported its turn over on a PR "working" still holds: released all the same.
        rec(run_id="reported-beside", pid=9, tty="pts/15", dispatched_at=T0 - 1300,
            pr_number=301),
        # The same with no pid, which only the scan could hold it to: not released.
        rec(run_id="pidless-beside", pid=None, tty="", dispatched_at=T0 - 1600,
            pr_number=301),
        # Reported over beside the released "untracked:o/r#315", whose run id is taken.
        rec(run_id="reported-past-released", pid=12, tty="pts/19",
            dispatched_at=T0 - 1250, pr_number=315),
        # Reported over after twenty still minutes: its agent is released and closed on
        # this tick.
        rec(run_id="reported-still", pid=10, tty="pts/17", dispatched_at=T0 - 1400,
            pr_number=317, quiet_digest=A.pane_digest(AT_PROMPT),
            quiet_since=T0 - A.QUIET_TIMEOUT),
        # The same, clicked, and its window refused a close a minute ago: the released
        # agent keeps the click's source and waits out the refusal.
        rec(run_id="reported-refused", pid=11, tty="pts/18", source=A.SOURCE_PANEL,
            dispatched_at=T0 - 1500, pr_number=318,
            quiet_digest=A.pane_digest(AT_PROMPT), quiet_since=T0 - A.QUIET_TIMEOUT,
            reap_refused_at=T0 - 60),
        # Pid-less on a released agent's PR, which the scan still names by the released
        # agent's tty: it adopts none.
        rec(run_id="untracked:o/r#319", pid=13, tty="pts/20", untracked=True, released=True,
            dispatched_at=T0 - 1700, pr_number=319),
        rec(run_id="pidless-beside-released", pid=None, tty="",
            dispatched_at=T0 - 30, pr_number=319),
        # A pid-less untracked record whose PR's sighting is another record's tty: it
        # stays where it is.
        rec(run_id="untracked:o/r#320", pid=None, tty="pts/21", untracked=True,
            dispatched_at=T0 - 1800, pr_number=320),
        rec(run_id="pidless-holding", pid=None, tty="pts/22",
            dispatched_at=T0 - 40, pr_number=320),
    ]
    evidence = ev(
        processes={1: proc(elapsed=300), 2: proc(elapsed=400, tty="pts/4"),
                   3: proc(elapsed=500, tty="pts/5"), 4: proc(elapsed=700, tty="pts/6"),
                   6: proc(elapsed=PAST_DEADLINE, tty="pts/10"),
                   7: proc(elapsed=1100, tty="pts/11"),
                   8: proc(elapsed=1200, tty="pts/13"),
                   9: proc(elapsed=1300, tty="pts/15"),
                   10: proc(elapsed=1400, tty="pts/17"),
                   11: proc(elapsed=1500, tty="pts/18"),
                   12: proc(elapsed=1250, tty="pts/19"),
                   13: proc(elapsed=1700, tty="pts/20")},
        tails={"pts/3": WORKING, "pts/4": AT_PROMPT, "pts/5": WORKING,
               "pts/6": WORKING, "pts/9": WORKING,
               "pts/10": WORKING, "pts/11": AT_PROMPT, "pts/12": WORKING,
               "pts/13": WORKING, "pts/15": AT_PROMPT,
               "pts/17": AT_PROMPT, "pts/18": AT_PROMPT, "pts/19": AT_PROMPT,
               "pts/20": AT_PROMPT, "pts/21": AT_PROMPT, "pts/22": WORKING},
        merged={305},
        live_agents={404: "pts/8", 311: "pts/9", 313: "pts/11", 314: "pts/12",
                     315: "pts/14", 301: "pts/15", 317: "pts/17",
                     318: "pts/18", 319: "pts/20", 320: "pts/22"},
        activity={"reported": ("idle", T0 - 5), "reported-beside": ("idle", T0 - 5),
                  "pidless-beside": ("idle", T0 - 5),
                  "reported-past-released": ("idle", T0 - 5),
                  "reported-still": ("idle", T0 - 5),
                  "reported-refused": ("idle", T0 - 5)},
    )
    return records, evidence


@pytest.fixture(scope="module")
def mixed_results():
    records, evidence = _mixed()
    return _swift(_payload(records, evidence)), _python(records, evidence)


def test_the_whole_tick_agrees(mixed_results):
    swift, python = mixed_results
    assert swift == python


def test_the_fixture_actually_reaches_every_state(mixed_results):
    """Anti-vacuity: a fixture that only ever produces `running` would diff clean
    while every other rung drifted freely. `unknown` takes evidence that could not be
    read, which the per-case runs above cover and a fixture read whole cannot."""
    _swift_out, python = mixed_results
    assert {r["state"] for r in python["rows"]} == set(A.STATE_ORDER) - {A.UNKNOWN}


def test_the_fixture_exercises_every_projection(mixed_results):
    """Anti-vacuity, again: each projection has to be non-trivial, or agreeing about
    it proves nothing."""
    _swift_out, python = mixed_results
    assert python["capLoad"], "no run holds a bay — the cap projection is untested"
    assert python["retirable"], "nothing retires — the retirement projection is untested"
    assert python["reapable"], "no window is reaped — the destructive projection is untested"
    assert "reported" in python["closeOnRetire"] \
        and "reported-refused" not in python["closeOnRetire"], \
        "a reported run's window must close, and a clicked one's must not"
    assert any(python["inFlight"].values()) and not all(python["inFlight"].values()), \
        "the dedup answer must be both True and False somewhere in the fixture"
    assert any(r["untracked"] for r in python["records"]), \
        "the untracked synthesis never ran"
    assert any(r["runId"] == "untracked:o/r#313" and r["released"] and r["pid"] == 7
               for r in python["records"]), "no ended run released its agent"
    heirs = {r["runId"]: r["pid"] for r in python["records"] if r["released"]}
    assert (heirs.get("untracked:o/r#301"), heirs.get("untracked:o/r#315:12")) == (9, 12), \
        "no run that ended beside another record released its agent"
    assert None not in heirs.values(), "a pid-less run was released beside another"
    assert any(r["lapsed"] for r in python["rows"]), "no untracked bay lapsed"
    assert python["inFlight"]["o/r#315"] is False and "untracked:o/r#315" not in python["capLoad"], \
        "a released agent mid-turn must hold neither its PR nor a bay"
    drawn = {r["runId"]: r["state"] for r in python["rows"]}
    assert (drawn.get("untracked:o/r#315"), "untracked:o/r#319" in drawn) == (A.RUNNING, False), \
        "a released agent is drawn while working, and only then"
    assert "untracked:o/r#317" in python["reapable"], "no released agent was closed at once"
    refused = next(r for r in python["records"] if r["runId"] == "untracked:o/r#318")
    assert (refused["source"], refused["reapRefusedAt"]) == (A.SOURCE_PANEL, T0 - 60)
    assert "untracked:o/r#318" not in python["reapable"], \
        "a released agent must wait out its run's refused close"
    ttys = {r["runId"]: r["tty"] for r in python["records"]}
    assert (ttys["pidless-beside-released"], ttys["untracked:o/r#320"]) == ("", "pts/21"), \
        "a pid-less record took another record's tty off the scan"


def test_the_tick_after_a_release_agrees_too():
    """The release only pays off on the NEXT tick, when the run is gone from the book
    and the scan still sees its agent. Fed the book both stores would leave, the two
    sides must agree that nothing is re-booked and no bay is taken."""
    records, evidence = _mixed()
    t = A.tick(records, evidence, T0, LIMIT, A.RUN_DEADLINE)
    gone = {r.run_id for r in t.retirable}
    book = [r for r in t.records if r.run_id not in gone]
    later = T0 + 8
    swift, again = _swift(_payload(book, evidence, now=later)), \
        _python(book, evidence, now=later)
    assert swift == again
    assert [r["runId"] for r in again["records"]].count("untracked:o/r#313") == 1
    assert "untracked:o/r#313" not in again["capLoad"] and again["inFlight"]["o/r#313"] is False


#: A merge ending a pid-less run already named `untracked:<pr>` (a hand edit made it a
#: dispatch: `"untracked": 1` is no flag), whose agent the scan still sees.
_RELEASE_INTO_ITS_OWN_NAME = {
    "now": 1000000.0, "limit": 2, "deadline": 14400.0,
    "records": [{"runId": "untracked:o/r#337", "dispatchedAt": 1000000.0, "prNumber": 337,
                 "prUrl": "https://github.com/o/r/pull/337", "kind": "review",
                 "label": "Auto · Review · #337", "source": "auto",
                 "ledgerKey": "", "pid": None, "tty": "pts/3",
                 "quietDigest": "", "quietSince": None,
                 "reapRefusedAt": None, "untracked": 1, "released": False}],
    "evidence": {
        key: {"status": "present", "value": value, "reason": ""}
        for key, value in {
            "activity": {}, "processes": {}, "sentinels": [],
            "tails": {"pts/3": "● Posted the review.\n❯\n"
                               "⏵⏵ bypass permissions on (shift+tab to cycle)"},
            "mergedPrs": ["o/r#337"], "liveAgents": {"o/r#337": "pts/3"},
            "sessions": {}, "tokensLeft": True}.items()},
}


def test_a_run_whose_release_has_no_name_of_its_own_retires_on_both():
    """Its heir's name is taken by the run itself, and with no pid there is nothing to
    tell the two apart: Swift kept the clashing id, whose verdict hid the run's own so
    it never retired and its PR stayed in flight; Python named the heir
    `untracked:o/r#337:None`. No heir: the run retires, and the next tick's scan books the
    agent it still sees."""
    payload = _RELEASE_INTO_ITS_OWN_NAME
    swift, python = _swift(payload), _python_decoding(payload)
    assert swift == python
    assert [r["runId"] for r in python["records"]] == ["untracked:o/r#337"]
    assert python["retirable"] == ["untracked:o/r#337"]
    assert python["inFlight"] == {"o/r#337": False}


@pytest.mark.parametrize("record, evidence, state", RELEASED_UNSEEN)
def test_a_released_agent_nothing_saw_working_is_left_off_by_both(record, evidence,
                                                                  state):
    swift, python = _swift(_payload([record], evidence)), _python([record], evidence)
    assert swift == python
    assert (python["rows"], python["states"][record.run_id]["state"]) == ([], state)


def test_the_deadline_being_off_agrees_too():
    """The switch is the caller's, not the resolver's, so it is a parity surface of its
    own: a side that read an absent deadline as zero would retire the whole fixture."""
    records, evidence = _mixed()
    payload = _payload(records, evidence, deadline=None)
    del payload["deadline"]  # absent, the way a front-end with the switch off sends it
    assert _swift(payload) == _python(records, evidence, deadline=None)


def test_the_fixture_reaches_the_deadline_rung(mixed_results):
    """Anti-vacuity: the fixture must actually contain a run the deadline ended, or the
    rung is unpinned in both languages at once."""
    _swift_out, python = mixed_results
    assert any(r["runId"] == "over-deadline" and "deadline" in r["reason"]
               for r in python["rows"])


def test_a_case_the_two_disagree_on_would_actually_fail(mixed_results):
    """The diff has teeth: perturbing one field of the Python answer must break the
    comparison the other tests rely on."""
    swift, python = mixed_results
    tampered = json.loads(json.dumps(python))
    tampered["rows"][0]["reason"] += " (tampered)"
    assert swift != tampered


# MARK: - The network
#
# The scenario table above already runs every network verdict through both resolvers.
# What is left is what a single hand-built observation cannot reach: the daemon's
# snapshot as each side DECODES it, the evidence each builds from it, and the
# projections over a book that holds local and network runs together.

ISSUE_TASK = "github.com/o/r#issues:issue-9@octocat"
AUDIT_TASK = "github.com/o/r#audit:job-0b77ab9a731995c3@octocat"
POOLED_TASK = "github.com/o/r#conflicts:pr-5@octocat"
#: This machine's own key in :func:`_snapshot`.
SELF = "aaaabbbbccccdddd"
HOURS_SHORT = "this machine takes jobs of at most 12 h and this one needs 24"


def _snapshot() -> dict:
    """The README's snapshot with every member populated but an offer's own
    ``executorHere``: one pool, a live run for :data:`TASK`, and an offer here by each
    of the three roads plus one in the pool."""
    return {
        "updatedAt": 1794000300, "daemon": {"pid": 4321, "startedAt": 1794000000},
        "identity": {"pk": SELF, "onion": "abc.onion"},
        "transport": {"state": "ready", "detail": ""},
        "docker": {"state": "building", "image": "dn:1", "detail": "layer 3"},
        "model": {"state": "missing", "detail": "no credential"},
        "admit": {"slots": 2, "at": 1794000290, "reason": ""},
        "pools": [{
            "id": "github.com/o/r", "path": "/w/r", "identity": "octocat", "hash": "h1",
            "left": False, "joining": False, "joinFailed": "", "returning": False,
            "unseated": False, "notTaking": "",
            "members": [
                {"pk": SELF, "self": True, "maxAcceptedH": 24, "lastSeen": 1794000299,
                 "reachable": True},
                {"pk": PEER, "self": False, "maxAcceptedH": 12, "lastSeen": 1794000200,
                 "reachable": False}],
            "tasks": [{
                "taskId": ISSUE_TASK, "kind": "issues", "item": "issue-9",
                "title": "Fix #9", "identity": "octocat", "hours": 12, "state": "claimed",
                "offeredBy": [SELF], "offeredHere": True, "executor": SELF,
                "executorHere": True, "claimedAt": 1794000100, "leaseUntil": 1794007300,
                "deadline": 1794043300}]}],
        "runs": [
            {"runId": "run-1", "taskId": TASK, "pool": "github.com/o/r", "peer": PEER,
             "container": "dn-h1-p1", "state": "running", "startedAt": 1794000150,
             "endedAt": 0, "exit": 0},
            {"runId": "run-0", "taskId": AUDIT_TASK, "pool": "github.com/o/r",
             "peer": PEER, "container": "dn-h1-p1", "state": "finished",
             "startedAt": 1794000000, "endedAt": 1794000100, "exit": 0}],
        "offers": [
            {"taskId": TASK, "pool": "github.com/o/r", "kind": "review", "item": "pr-337",
             "title": "Auto · Review · #337", "state": "claimed", "reason": "",
             "executor": PEER, "offeredAt": 1794000050, "attempt": 1, "requests": 4,
             "refused": 1},
            {"taskId": ISSUE_TASK, "pool": "github.com/o/r", "kind": "issues",
             "item": "issue-9", "title": "Fix #9", "state": "claimed", "reason": "",
             "executor": "9999888877776666", "offeredAt": 1794000060, "attempt": 2,
             "requests": 0, "refused": 0},
            {"taskId": AUDIT_TASK, "pool": "github.com/o/r", "kind": "audit",
             "item": "job-0b77ab9a731995c3", "title": "Audit", "state": "done",
             "reason": "", "executor": SELF, "offeredAt": 1794000000, "attempt": 1,
             "requests": 9, "refused": 0,
             "outcome": {"ok": True, "summary": "clean", "usd": 0.42, "tokens": 12345,
                         "runner": "claude", "model": "opus", "capped": True},
             "endedAt": 1794000100},
            {"taskId": POOLED_TASK, "pool": "github.com/o/r", "kind": "conflicts",
             "item": "pr-5", "title": "Conflicts · #5", "state": "pooled", "reason": "",
             "executor": "", "offeredAt": 1794000070, "attempt": 1, "requests": 0,
             "refused": 0, "notTaking": HOURS_SHORT}],
    }


def _networked():
    """A book of local and network runs together, under :func:`_snapshot`: a network
    run per verdict the snapshot can give, one whose PR merged while pooled, one the
    snapshot never held, and a local run beside them holding the only bay."""
    records = [
        rec(run_id="local", pid=1, dispatched_at=T0 - 300, pr_number=301),
        net(run_id="claimed-here", dispatched_at=T0 - 400),
        net(run_id="claimed-by-pool", dispatched_at=T0 - 500, pr_number=9,
            network=ISSUE_TASK),
        net(run_id="done", dispatched_at=T0 - 600, pr_number=None, network=AUDIT_TASK),
        net(run_id="pooled", dispatched_at=T0 - 700, pr_number=5, network=POOLED_TASK,
            source=A.SOURCE_PANEL),
        net(run_id="merged-while-pooled", dispatched_at=T0 - 800, pr_number=305,
            network=POOLED_TASK),
        net(run_id="never-held", dispatched_at=T0 - 900, pr_number=306,
            network="github.com/o/r#review:pr-306@octocat"),
        net(run_id="just-offered", dispatched_at=T0 - 3, pr_number=307,
            network="github.com/o/r#review:pr-307@octocat"),
    ]
    evidence = ev(processes={1: proc(elapsed=300)}, tails={"pts/3": WORKING},
                  merged={305}, live_agents={337: "pts/9", 404: "pts/8"})
    return records, evidence


@pytest.fixture(scope="module")
def networked_results():
    records, evidence = _networked()
    return (_swift(_payload(records, evidence, snapshot=_snapshot())),
            _python(records, evidence, snapshot=_snapshot()))


def test_a_book_of_local_and_network_runs_agrees(networked_results):
    swift, python = networked_results
    assert swift == python


def test_the_network_fixture_reaches_what_it_claims_to(networked_results):
    """Anti-vacuity: an agreement over a fixture that decoded to nothing is no
    agreement."""
    _swift_out, python = networked_results
    assert {run: v["reason"] for run, v in python["states"].items()} == {
        "local": "pid 1 alive; working",
        "claimed-here": "running on this machine",
        "claimed-by-pool": "running on this machine",
        "done": "finished on this machine, its reported cost capped",
        "pooled": f"in the pool, not taken here: {HOURS_SHORT}",
        "merged-while-pooled": "PR #305 is merged",
        "never-held": "the network holds no such offer",
        "just-offered": "offered 3s ago, not in the pool yet",
        "untracked:o/r#404": "found in process table; no screen for tty pts/8",
    }
    assert python["capLoad"] == ["local", "untracked:o/r#404"]
    assert python["withdrawable"] == ["merged-while-pooled"]
    assert python["withdrawOnForget"] == [
        "claimed-by-pool", "claimed-here", "merged-while-pooled", "pooled"]
    assert python["retirable"] == ["done", "merged-while-pooled", "never-held"]
    assert (python["reapable"], python["closeOnRetire"]) == ([], [])
    assert python["inFlight"] == {
        "o/r#301": True, "o/r#337": True, "o/r#9": True, "o/r#5": True,
        "o/r#305": False, "o/r#306": False, "o/r#307": True, "o/r#404": True}
    assert python["networkRunning"] == 1
    assert python["networkSnapshot"] == {
        **{k: v for k, v in _snapshot().items()
           if k not in ("daemon", "identity", "offers")},
        "pid": 4321, "startedAt": 1794000000, "pk": SELF, "onion": "abc.onion",
        "offers": [{"outcome": None, "endedAt": None, "executorHere": None,
                    "notTaking": "", **o} for o in _snapshot()["offers"]],
    }
    assert [r["network"] for r in python["records"]][:3] == [None, TASK, ISSUE_TASK]


#: What the daemon package's bench answered `GET /state` with (see
#: ``test_network_parity.py``).
with open(os.path.join(os.path.dirname(__file__), "daemon_snapshots.json"),
          encoding="utf-8") as _f:
    DAEMON = json.load(_f)


def _offered(snapshot: dict):
    """A run booked for each offer of ``snapshot``, and one it never held, looked at as
    the snapshot was written."""
    tasks = [o["taskId"] for o in snapshot["offers"]] + ["github.com/acme/widgets#review:pr-7@x"]
    records = [net(run_id=f"offer-{n}", dispatched_at=snapshot["updatedAt"] - 600,
                   pr_number=n + 1, network=task) for n, task in enumerate(tasks)]
    return records, ev(), snapshot["updatedAt"]


@pytest.mark.parametrize("name", list(DAEMON))
def test_a_snapshot_of_the_stand_in_daemon_is_read_the_same_by_both(name, kolkata):
    records, evidence, now = _offered(DAEMON[name])
    payload = _payload(records, evidence, now=now, snapshot=DAEMON[name])
    assert _swift(payload) == _python_decoding(payload)


def test_the_stand_in_daemons_snapshots_are_read_for_what_they_say(kolkata):
    def read(name: str) -> dict:
        records, evidence, now = _offered(DAEMON[name])
        return _python(records, evidence, now=now, snapshot=DAEMON[name])

    def first(name: str) -> tuple[str, str]:
        verdict = read(name)["states"]["offer-0"]
        return verdict["state"], verdict["reason"]

    assert first("joining") == (A.FAILED, "the network holds no such offer")
    held = DAEMON["requester-pooled"]["offers"][0]["notTaking"]
    assert held and first("requester-pooled") == (
        A.STARTING, f"in the pool, not taken here: {held}")
    other = DAEMON["requester-claimed"]["offers"][0]["executor"][:8]
    assert len(other) == 8 and first("requester-claimed") == (A.RUNNING, f"running on {other}")
    assert first("requester-done") == (A.FINISHED, f"finished on {other}")
    assert first("too-long") == (
        A.STARTING, "in the pool, not taken here: this machine takes jobs of at most 12 h "
                    "and this one needs 24")
    left = DAEMON["left-until"]["offers"][0]
    until = left["leftUntil"]
    assert left["notTaking"].endswith(time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime(until)))
    assert first("left-until") == (
        A.STARTING, "in the pool, not taken here: this machine failed at it or gave it back, "
                    "and leaves it to the others until "
                    + time.strftime("%H:%M", time.gmtime(until + 5.5 * 3600)))
    assert first("capped") == (A.FINISHED, "finished on this machine, its reported cost capped")
    assert DAEMON["capped"]["offers"][0]["outcome"]["capped"] is True
    assert "capped" not in DAEMON["requester-done"]["offers"][0]["outcome"]
    runs = read("executor-finished")["networkSnapshot"]["runs"]
    assert [r["state"] for r in runs] == ["finished"] and "log" not in runs[0]
    assert "log" not in DAEMON["executor-finished"]["runs"][0]
    assert read("executor-running")["networkRunning"] == 1
    waiting, refused = (read(name)["networkSnapshot"]["pools"][0]
                        for name in ("joining", "join-failed"))
    assert (waiting["joining"], waiting["joinFailed"], len(waiting["members"])) == (True, "", 1)
    assert (refused["joining"], refused["joinFailed"], len(refused["members"])) == (
        False, "that invite is no longer good", 1)
    assert DAEMON["requester-pooled"]["pools"][0]["joining"] is False


def _spoil(edit) -> dict:
    snapshot = _snapshot()
    edit(snapshot)
    return snapshot


#: The daemon's answer, damaged one way at a time. Both decoders read each the same.
_SPOILT_SNAPSHOTS = {
    "no answer": None,
    "not an object": ["offers"],
    "empty": {},
    "no offers list": _spoil(lambda s: s.pop("offers")),
    "offers of the wrong type": _spoil(lambda s: s.update(offers={"t": 1})),
    "no offers at all": _spoil(lambda s: s.update(offers=[])),
    "sections of the wrong type": _spoil(lambda s: s.update(
        daemon=7, identity=["pk"], transport="ready", docker=None, model=3,
        admit="2", pools={"id": "p"}, runs="none", updatedAt="soon")),
    "numbers that are not": _spoil(lambda s: (
        s["admit"].update(slots=True, at="now"),
        s["daemon"].update(pid=1e300, startedAt=False),
        s["offers"][0].update(attempt="1", requests=2.9, refused=1e19, endedAt=True,
                              offeredAt="then"),
        s["offers"][2]["outcome"].update(usd="0.42", tokens=True),
        s["runs"][0].update(exit=12.5, startedAt="then"),
        s["pools"][0]["tasks"][0].update(hours=12.0, claimedAt=None),
        s["pools"][0]["members"][0].update(maxAcceptedH=True, lastSeen="x"))),
    "flags that are not": _spoil(lambda s: (
        s["pools"][0].update(left=1, joining=1, returning="true", unseated=1),
        s["pools"][0]["members"][0].update(self=1, reachable="yes"),
        s["pools"][0]["tasks"][0].update(offeredHere=1.0, executorHere=1),
        s["offers"][0].update(executorHere=0), s["offers"][3].update(executorHere="yes"),
        s["offers"][2]["outcome"].update(ok=1, capped=1))),
    "text that is not": _spoil(lambda s: (
        s["identity"].update(pk=5, onion=None),
        s["transport"].update(state=True, detail=["x"]),
        s["offers"][0].update(state=3, executor=None, pool=1, kind=None, item=[],
                              title=False, reason={"why": "x"}),
        s["runs"][0].update(state=None, taskId=9, log=False),
        s["offers"][3].update(notTaking=["x"]),
        s["pools"][0].update(path=1, identity=None, hash=[], notTaking=5, joinFailed=["x"]),
        s["pools"][0]["tasks"][0].update(offeredBy=["a", 2, None], kind=4))),
    "rows without their identity": _spoil(lambda s: (
        s["offers"].extend([{"state": "done"}, "x", 3, {"taskId": ""}, {"taskId": 5}]),
        s["runs"].extend([{"taskId": TASK, "state": "running"}, None, {"runId": ""}]),
        s["pools"].extend([{"path": "/no/id"}, [], {"id": ""}]),
        s["pools"][0]["members"].extend([{"self": True}, 4]),
        s["pools"][0]["tasks"].extend([{"kind": "x"}, "t"]))),
    "an outcome of the wrong type": _spoil(lambda s: s["offers"][2].update(outcome=[True])),
    "a finished run and no flag": _spoil(lambda s: (
        s["runs"][0].update(state="finished"),
        s["pools"][0]["tasks"][0].update(executorHere=False))),
    "the offers' own word on where they run": _spoil(lambda s: (
        s["offers"][0].update(executorHere=False),
        s["offers"][1].update(executorHere=False),
        s["offers"][2].update(executorHere=False),
        s["offers"][3].update(state="claimed", executor=PEER, executorHere=True))),
    "offers that say why they ended": _spoil(lambda s: (
        s["offers"][0].update(state="failed", reason="the container exited 137"),
        s["offers"][3].update(state="cancelled", reason="merged"))),
    "a pool this machine left": _spoil(lambda s: s["pools"][0].update(left=True)),
    "a pool whose invite waits for its maker": _spoil(
        lambda s: s["pools"][0].update(joining=True)),
    "a pool whose last invite came to nothing": _spoil(
        lambda s: s["pools"][0].update(joinFailed="no-seat")),
    "a pool this machine is returning to": _spoil(
        lambda s: s["pools"][0].update(returning=True)),
    "a pool that has no seat for this machine": _spoil(
        lambda s: s["pools"][0].update(returning=True, unseated=True)),
    "a pool whose jobs this machine does not take": _spoil(lambda s: (
        s["pools"][0].update(notTaking="docker is down: no engine"),
        s["offers"][3].update(notTaking="docker is down: no engine"))),
    "rows as an earlier daemon wrote them": _spoil(lambda s: (
        s["pools"][0].pop("notTaking"), s["offers"][3].pop("notTaking"),
        s["pools"][0].pop("joining"), s["pools"][0].pop("joinFailed"),
        s["pools"][0].pop("returning"), s["pools"][0].pop("unseated"),
        s["offers"][2]["outcome"].pop("capped"),
        s["runs"][0].update(log="/l/1"), s["runs"][1].update(log=""))),
    "the same task offered twice": _spoil(lambda s: s["offers"].append(
        {"taskId": TASK, "state": "done", "executor": SELF, "outcome": {"ok": True}})),
    "members nobody asked for": _spoil(lambda s: (
        s.update(extra={"k": [1, 2]}), s["offers"][0].update(more=True))),
}


@pytest.mark.parametrize("snapshot", _SPOILT_SNAPSHOTS.values(),
                         ids=list(_SPOILT_SNAPSHOTS))
def test_a_damaged_snapshot_is_read_the_same_by_both(snapshot):
    records, evidence = _networked()
    payload = _payload(records, evidence, snapshot=snapshot)
    assert _swift(payload) == _python_decoding(payload)


def test_only_a_snapshot_with_an_offers_list_says_anything_about_a_run():
    """Anti-vacuity for the table above, and the rule it protects: of the damaged
    snapshots, the ones that lost their offers leave every network run unknown, and
    only the one that truly lists none fails them."""
    records, evidence = _networked()

    def states(name: str) -> set[str]:
        out = _python(records, evidence, snapshot=_SPOILT_SNAPSHOTS[name])
        return {v["state"] for run, v in out["states"].items()
                if run not in ("local", "untracked:o/r#404", "merged-while-pooled")}

    for silent in ("no answer", "not an object", "empty", "no offers list",
                   "offers of the wrong type"):
        assert states(silent) == {A.UNKNOWN}, silent
    assert states("no offers at all") == {A.FAILED, A.STARTING}
    here = _python(records, evidence, snapshot=_SPOILT_SNAPSHOTS["a finished run and no flag"])
    assert here["states"]["claimed-here"]["reason"] == "running on eeeeffff"
    assert here["networkRunning"] == 0


def test_the_spoilt_snapshots_that_carry_the_offers_own_fields_reach_them():
    """Anti-vacuity for the three rows of the table that set an offer's own word, its
    reason and a pool's ``left``."""
    records, evidence = _networked()

    def read(name: str) -> dict:
        return _python(records, evidence, snapshot=_SPOILT_SNAPSHOTS[name])

    told = read("the offers' own word on where they run")["states"]
    assert {run: told[run]["reason"] for run in (
        "claimed-here", "claimed-by-pool", "done", "pooled")} == {
        "claimed-here": "running on eeeeffff",
        "claimed-by-pool": "running on 99998888",
        "done": "finished on aaaabbbb, its reported cost capped",
        "pooled": "running on this machine"}
    why = read("offers that say why they ended")["states"]
    assert (why["claimed-here"]["reason"], why["pooled"]["reason"]) == (
        "refused by the network: the container exited 137",
        "withdrawn from the network: merged")
    held = read("a pool whose jobs this machine does not take")
    assert held["networkSnapshot"]["pools"][0]["notTaking"] == "docker is down: no engine"
    assert held["states"]["pooled"]["reason"] == \
        "in the pool, not taken here: docker is down: no engine"
    earlier = read("rows as an earlier daemon wrote them")
    assert (earlier["states"]["pooled"]["reason"], earlier["states"]["done"]["reason"]) == (
        "in the pool", "finished on this machine")
    assert "log" not in earlier["networkSnapshot"]["runs"][0]
    assert read("a pool this machine left")["networkSnapshot"]["pools"][0]["left"] is True
    assert read("flags that are not")["networkSnapshot"]["pools"][0]["left"] is False

    def join(name: str) -> tuple[bool, str]:
        pool = read(name)["networkSnapshot"]["pools"][0]
        return pool["joining"], pool["joinFailed"]

    assert join("a pool whose invite waits for its maker") == (True, "")
    assert join("a pool whose last invite came to nothing") == (False, "no-seat")
    assert join("flags that are not") == (False, "") == join("text that is not")
    assert join("rows as an earlier daemon wrote them") == (False, "")

    def seat(name: str) -> tuple[bool, bool]:
        pool = read(name)["networkSnapshot"]["pools"][0]
        return pool["returning"], pool["unseated"]

    assert seat("a pool this machine is returning to") == (True, False)
    assert seat("a pool that has no seat for this machine") == (True, True)
    assert seat("flags that are not") == (False, False) == seat(
        "rows as an earlier daemon wrote them")


@pytest.mark.parametrize("value", [7, "", None, True, ["t"], {"taskId": "t"}],
                         ids=repr)
def test_a_task_id_that_is_not_text_is_read_the_same_by_both(value):
    """A record whose ``network`` did not survive its trip is a local run on both
    sides, judged by its pid."""
    payload = _payload([rec()], ev(processes={4242: proc()}, tails={"pts/3": WORKING},
                                   network=NO_DAEMON))
    payload["records"][0]["network"] = value
    swift, python = _swift(payload), _python_decoding(payload)
    assert swift == python
    assert python["states"]["r1"]["reason"] == "pid 4242 alive; working"
    assert python["capLoad"] == ["r1"]


def test_a_record_carrying_a_removed_meshs_keys_is_read_the_same_by_both():
    """The keys a removed mesh wrote into the book name no network run."""
    payload = _payload([rec()], ev(processes={4242: proc()}, tails={"pts/3": WORKING},
                                   network=NO_DAEMON))
    payload["records"][0].update(placement="mesh-peer", node="brick",
                                 workKey="review:github.com/o/r#337@abc",
                                 claimSeenAt=T0 - 1)
    swift, python = _swift(payload), _python_decoding(payload)
    assert swift == python
    assert python["states"]["r1"]["reason"] == "pid 4242 alive; working"
    assert python["records"][0]["network"] is None


@pytest.mark.parametrize("value", [None, [], "claimed", {TASK: "claimed"},
                                   {TASK: {"state": 3, "executorHere": 1, "ok": "yes"}},
                                   {TASK: {"state": "pooled", "notTaking": "x"}},
                                   {TASK: {"state": "pooled", "notTaking": 4}},
                                   {TASK: {"state": "done", "ok": True, "capped": True}},
                                   {TASK: {"state": "done", "ok": True, "capped": 1}}],
                         ids=repr)
def test_network_evidence_that_did_not_decode_is_read_the_same_by_both(value):
    payload = _payload([net()], ev(network=offer("claimed", PEER, here=True)))
    payload["evidence"]["network"]["value"] = value
    assert _swift(payload) == _python_decoding(payload)
