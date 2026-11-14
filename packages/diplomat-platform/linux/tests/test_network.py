"""The Diplomacy Network gate: what a job is offered as, what this machine admits, and
what the daemon's snapshot says.

PARITY: every case here is mirrored, in this order and under these messages, by
``DiplomatCoreSmoke/NetworkSmoke.swift``. The resolver's network scenarios are in
``test_agent_state.py``'s ``CASES`` and run through both twins by
``test_agent_state_parity.py``, which also diffs the two snapshot decoders.
"""

from __future__ import annotations

import itertools
import json

import pytest

from diplomat_runtime import activity, autofix
from diplomat_runtime import agentstate as A
from diplomat_runtime import network as N
from diplomat_runtime.prref import LocalRepo

TASK = "github.com/o/r#review:pr-337@octocat"
ISSUE_TASK = "github.com/o/r#issues:issue-9@octocat"
AUDIT_TASK = "github.com/o/r#audit:job-0b77ab9a731995c3@octocat"
POOLED_TASK = "github.com/o/r#conflicts:pr-5@octocat"

#: A README-shaped snapshot: one pool, a live run for ``TASK``, four offers.
FULL_SNAPSHOT = """
{ "updatedAt": 1794000300, "daemon": { "pid": 4321, "startedAt": 1794000000 },
  "identity": { "pk": "aaaabbbbccccdddd", "onion": "abc.onion" },
  "transport": { "state": "ready", "detail": "" },
  "docker": { "state": "building", "image": "dn:1", "detail": "layer 3" },
  "model": { "state": "missing", "detail": "no credential" },
  "admit": { "slots": 2, "at": 1794000290, "reason": "" },
  "pools": [ { "id": "github.com/o/r", "path": "/w/r", "identity": "octocat", "hash": "h1",
      "members": [ { "pk": "aaaabbbbccccdddd", "self": true, "maxAcceptedH": 24,
                     "lastSeen": 1794000299, "reachable": true },
                   { "pk": "eeeeffff00001111", "self": false, "maxAcceptedH": 12,
                     "lastSeen": 1794000200, "reachable": false } ],
      "tasks": [ { "taskId": "github.com/o/r#issues:issue-9@octocat", "kind": "issues",
                   "item": "issue-9", "title": "Fix #9", "identity": "octocat", "hours": 12,
                   "state": "claimed", "offeredBy": ["aaaabbbbccccdddd"], "offeredHere": true,
                   "executor": "aaaabbbbccccdddd", "executorHere": true,
                   "claimedAt": 1794000100, "leaseUntil": 1794007300, "deadline": 1794043300 } ] } ],
  "runs": [ { "runId": "run-1", "taskId": "github.com/o/r#review:pr-337@octocat",
              "pool": "github.com/o/r", "peer": "eeeeffff00001111", "container": "dn-h1-p1",
              "state": "running", "startedAt": 1794000150, "endedAt": 0, "exit": 0, "log": "/l/1" },
            { "runId": "run-0", "taskId": "github.com/o/r#audit:job-0b77ab9a731995c3@octocat",
              "pool": "github.com/o/r", "peer": "eeeeffff00001111", "container": "dn-h1-p1",
              "state": "finished", "startedAt": 1794000000, "endedAt": 1794000100, "exit": 0,
              "log": "/l/0" } ],
  "offers": [ { "taskId": "github.com/o/r#review:pr-337@octocat", "state": "claimed",
                "executor": "eeeeffff00001111", "attempt": 1, "requests": 4, "refused": 1 },
              { "taskId": "github.com/o/r#issues:issue-9@octocat", "state": "claimed",
                "executor": "9999888877776666", "attempt": 2, "requests": 0, "refused": 0 },
              { "taskId": "github.com/o/r#audit:job-0b77ab9a731995c3@octocat", "state": "done",
                "executor": "aaaabbbbccccdddd", "attempt": 1, "requests": 9, "refused": 0,
                "outcome": { "ok": true, "summary": "clean", "usd": 0.42, "tokens": 12345,
                             "runner": "claude", "model": "opus" }, "endedAt": 1794000100 },
              { "taskId": "github.com/o/r#conflicts:pr-5@octocat", "state": "pooled",
                "executor": "", "attempt": 1, "requests": 0, "refused": 0 } ] }
"""

PANEL, AUTO = autofix.SOURCE_PANEL, autofix.SOURCE_AUTO


# MARK: - network: the dispatch gate


def test_the_network_gate_over_every_combination():
    for source in (PANEL, AUTO):
        for banned, on_pr, outside, full, paused, disk, broke in itertools.product(
                (False, True), repeat=7):
            got = autofix.dispatch_decide(source, banned, on_pr, full, broke, outside,
                                          disk, paused=paused, network=True)
            want = (autofix.VERDICT_BANNED if banned
                    else autofix.VERDICT_NOT_ALLOWED if outside
                    else autofix.VERDICT_IN_FLIGHT if on_pr
                    else autofix.VERDICT_AT_CAPACITY if source == AUTO and paused
                    else autofix.VERDICT_PROCEED)
            assert got == want, (source, banned, on_pr, outside, full, paused, disk, broke)
            # Off the network the two halves of capacity are one hold.
            split = autofix.dispatch_decide(source, banned, on_pr, full, broke, outside,
                                            disk, paused=paused, network=False)
            folded = autofix.dispatch_decide(source, banned, on_pr, full or paused, broke,
                                             outside, disk)
            assert split == folded, "a local job is held by either half of capacity"


def _auto(low_disk=False, full=False, paused=False, broke=False, network=True) -> str:
    return autofix.dispatch_decide(AUTO, False, False, full, broke, False, low_disk,
                                   paused=paused, network=network)


def test_a_low_disk_holds_no_network_job():
    assert _auto(low_disk=True) == autofix.VERDICT_PROCEED


def test_a_full_cap_holds_no_network_job():
    assert _auto(full=True) == autofix.VERDICT_PROCEED


def test_a_spent_budget_holds_no_network_job():
    assert _auto(broke=True) == autofix.VERDICT_PROCEED


def test_a_paused_item_still_holds_a_network_job():
    assert _auto(paused=True) == autofix.VERDICT_AT_CAPACITY
    assert _auto(low_disk=True, full=True, paused=True,
                 broke=True) == autofix.VERDICT_AT_CAPACITY


def test_off_the_network_every_hold_still_holds():
    assert _auto(low_disk=True, network=False) == autofix.VERDICT_LOW_DISK
    assert _auto(full=True, network=False) == autofix.VERDICT_AT_CAPACITY
    assert _auto(paused=True, network=False) == autofix.VERDICT_AT_CAPACITY
    assert _auto(broke=True, network=False) == autofix.VERDICT_UNAFFORDABLE


def test_the_operators_own_click_is_never_paused():
    assert autofix.dispatch_decide(PANEL, False, False, True, paused=True,
                                   network=True) == autofix.VERDICT_PROCEED


# MARK: - network: what to offer


def _offer(verb, own=False, number=337, key="o/r", label="Auto · Review · #337",
           prompt="p", source=AUTO, forced=False, **options):
    return N.offer_for(verb, own, number, key, label, prompt, source, forced, **options)


def _shape(got) -> str:
    if isinstance(got, str):
        return "refused"
    options = ",".join(f"{k}={str(v).lower()}" for k, v in sorted(got.options.items()))
    return f"{got.kind} {got.item} [{options}]"


def test_a_requested_review_of_someone_elses_pr_whole():
    assert _offer("review-req", verdict=True) == N.Offer(
        pool="github.com/o/r", kind="review", options={"verdict": True}, item="pr-337",
        title="Auto · Review · #337", prompt="p", now=False)


def test_a_review_whose_policy_forbids_a_verdict_offers_none():
    assert _shape(_offer("review-req")) == "review pr-337 [verdict=false]"


def test_a_kind_carries_its_own_option_alone():
    assert _shape(_offer("review-req", verdict=True, mark_ready=True, no_prs=True,
                         read_only=True)) == "review pr-337 [verdict=true]"


def test_the_operators_own_pr_is_review_own():
    assert _shape(_offer("review", own=True, verdict=True,
                         mark_ready=True)) == "review-own pr-337 [markReady=true]"
    assert _shape(_offer("review", own=True)) == "review-own pr-337 [markReady=false]"


def test_someone_elses_pr_is_review():
    assert _shape(_offer("review")) == "review pr-337 [verdict=false]"


def test_a_reply_to_reviews_is_always_on_the_operators_own_pr():
    assert _shape(_offer("review-reply",
                         mark_ready=True)) == "review-own pr-337 [markReady=true]"


@pytest.mark.parametrize("got,want", [
    (lambda: _offer("comms-review", verdict=True), "review pr-337 [verdict=true]"),
    (lambda: _offer("comms-review", own=True), "review-own pr-337 [markReady=false]"),
    (lambda: _offer("conflicts", verdict=True), "conflicts pr-337 []"),
    (lambda: _offer("issues", number=12, no_prs=True), "issues issue-12 [noPRs=true]"),
    (lambda: _offer("comms-fix", number=12), "issues issue-12 [noPRs=false]"),
    (lambda: _offer("issues", number=None, prompt="abc"),
     "issues job-ba7816bf8f01cfea [noPRs=false]"),
    (lambda: _offer("audit", number=None, prompt="Audit the repository end to end.",
                    read_only=True), "audit job-0b77ab9a731995c3 [readOnly=true]"),
    (lambda: _offer("audit", number=5, prompt="abc"),
     "audit job-ba7816bf8f01cfea [readOnly=false]"),
    (lambda: _offer("investigate", number=None, prompt=""),
     "investigate job-e3b0c44298fc1c14 []"),
    (lambda: _offer("comms-investigate", number=7, prompt="abc"),
     "investigate job-ba7816bf8f01cfea []"),
])
def test_each_verb_is_offered_as_its_kind(got, want):
    assert _shape(got()) == want


def test_the_job_name_is_sha256_of_the_prompt_across_every_padding_boundary():
    long = "Review PR #337 in o/r. " * 12 + "żółć ✓"
    assert N.item_for("audit", None, long) == "job-ee5f1d37b928031d"
    assert N.item_for("audit", None, "x" * 55) == "job-d5e285683cd4efc0"
    assert N.item_for("audit", None, "x" * 56) == "job-04c26261370ee754"
    assert N.item_for("audit", None, "x" * 64) == "job-7ce100971f64e700"


def test_a_panel_job_runs_now():
    assert _offer("review-req", source=PANEL).now is True


def test_an_automatic_job_waits_its_turn():
    assert _offer("review-req", source=AUTO).now is False


def test_a_forced_job_runs_now():
    assert _offer("review-req", source=AUTO, forced=True).now is True


def test_a_pool_id_is_lowercase():
    assert _offer("review-req", key="O/R").pool == "github.com/o/r"


def test_a_gitlab_key_is_its_own_pool_id():
    assert _offer("review-req", key="gitlab.example.com/Group/Sub/Repo").pool \
        == "gitlab.example.com/group/sub/repo"


@pytest.mark.parametrize("key", ["", "norepo", "o//r", "/r", "o/"])
def test_a_key_that_names_no_repository_is_refused(key):
    assert _offer("review-req", key=key) == "no repository to offer it into"


def test_an_unknown_verb_is_refused():
    assert _offer("nudge") == "the network runs no nudge jobs"


def test_an_unlabelled_job_is_titled_by_what_it_is():
    assert _offer("audit", number=None, label="",
                  prompt="abc").title == "audit job-ba7816bf8f01cfea"


def test_the_offer_body():
    assert _offer("review-req", source=PANEL, verdict=True).body == {
        "pool": "github.com/o/r", "kind": "review", "item": "pr-337",
        "title": "Auto · Review · #337", "prompt": "p", "now": True,
        "options": {"verdict": True}}
    assert "options" not in _offer("conflicts").body, "a kind with no option sends none"


# MARK: - network: the linked pools

ROOTS = [LocalRepo("o", "r", "/w/r"), LocalRepo("O", "R", "/w/dup"),
         LocalRepo("g/sub", "p", "/w/p", "GitLab.example.com"),
         LocalRepo("x", "y", "/w/y")]
GITHUB_ONLY = [
    {"id": "github.com/o/r", "path": "/w/r", "forge": "github", "identity": "octocat"},
    {"id": "github.com/x/y", "path": "/w/y", "forge": "github", "identity": "octocat"}]


def test_one_pool_per_repository_the_first_root_winning_none_without_an_identity():
    assert N.linked_pools(ROOTS, {"github.com": " Octocat "}) == GITHUB_ONLY
    both = N.linked_pools(ROOTS, {"github.com": "octocat", "gitlab.example.com": "Me"})
    assert [p["id"] for p in both] == ["github.com/o/r", "gitlab.example.com/g/sub/p",
                                       "github.com/x/y"]
    assert (both[1]["forge"], both[1]["identity"]) == ("gitlab", "me")


def test_a_blank_identity_is_none():
    assert N.linked_pools(ROOTS, {"github.com": "  "}) == []


def test_the_pools_body():
    assert N.pools_body(GITHUB_ONLY) == {"pools": GITHUB_ONLY}


# MARK: - network: admit


def _admit(limit=3, running=1, low_disk=False, affordable=True, auto_run=True) -> N.Admit:
    return N.admit(limit, running, low_disk, affordable, auto_run)


def test_the_free_bays_of_the_cap():
    assert _admit() == N.Admit(2, "")
    assert (_admit(running=0).slots, _admit(running=3).slots) == (3, 0)


def test_never_below_zero():
    assert _admit(running=5) == N.Admit(0, "")


def test_each_hold_admits_nothing_and_says_why():
    assert _admit(low_disk=True) == N.Admit(0, "disk")
    assert _admit(affordable=False) == N.Admit(0, "budget")
    assert _admit(auto_run=False) == N.Admit(0, "paused")


def test_the_disk_is_named_first_then_the_budget_then_the_pause():
    assert _admit(low_disk=True, affordable=False, auto_run=False).reason == "disk"
    assert _admit(affordable=False, auto_run=False).reason == "budget"


def test_the_admit_body():
    assert _admit().body == {"slots": 2}
    assert _admit(low_disk=True).body == {"slots": 0, "reason": "disk"}


# MARK: - network: settings and routes


def test_the_settings_keys():
    assert (N.ENABLED_KEY, N.REQUIRED_MINIMUM_H_KEY, N.MAXIMUM_ACCEPTED_H_KEY) == (
        "networkEnabled", "networkRequiredMinimumH", "networkMaximumAcceptedH")


@pytest.mark.parametrize("stored,want", [
    (None, 12), (11, 12), (12, 12), (48, 48), (13.5, 12), (0, 12), (-5, 12),
    (1e30, 12), (float("inf"), 12), (float("nan"), 12),
    # What only a JSON value can be: none of them is a whole number.
    (48.0, 48), (True, 12), ("24", 12), ([24], 12),
], ids=repr)
def test_the_hours_clamp(stored, want):
    assert N.hours(stored) == want
    assert type(N.hours(stored)) is int


def test_the_routes_and_their_bodies():
    assert [N.ROUTE_HEALTH, N.ROUTE_STATE, N.ROUTE_POOLS, N.ROUTE_ADMIT, N.ROUTE_OFFER,
            N.ROUTE_WITHDRAW, N.ROUTE_INVITE, N.ROUTE_JOIN, N.ROUTE_LEAVE,
            N.ROUTE_STOP_RUN] == ["health", "state", "pools", "admit", "offer",
                                  "withdraw", "invite", "join", "leave", "stop-run"]
    assert N.withdraw_body(TASK, N.WITHDRAW_MERGED) == {"taskId": TASK, "reason": "merged"}
    assert N.WITHDRAW_FORGOTTEN == "forgotten"
    assert N.invite_body("github.com/o/r") == {"pool": "github.com/o/r"}
    assert N.invite_body("github.com/o/r", 600) == {"pool": "github.com/o/r",
                                                   "ttlSecs": 600}
    assert N.join_body("tok") == {"invite": "tok"}
    assert N.leave_body("github.com/o/r") == {"pool": "github.com/o/r"}
    assert N.stop_run_body("run-1") == {"runId": "run-1"}


# MARK: - network: the snapshot


def test_the_readmes_snapshot_decodes():
    snap = N.Snapshot.parse(FULL_SNAPSHOT)
    assert (snap.updated_at, snap.pid, snap.started_at, snap.pk, snap.onion) == (
        1794000300, 4321, 1794000000, "aaaabbbbccccdddd", "abc.onion")
    assert snap.transport == N.Service("ready", "")
    assert snap.docker == N.Docker("building", "dn:1", "layer 3")
    assert snap.model == N.Service("missing", "no credential")
    assert snap.admit == N.AdmitState(2, 1794000290, "")
    assert [(p.id, p.path, p.identity, p.hash) for p in snap.pools] == [
        ("github.com/o/r", "/w/r", "octocat", "h1")]
    assert snap.pools[0].members == (
        N.Member("aaaabbbbccccdddd", True, 24, 1794000299, True),
        N.Member("eeeeffff00001111", False, 12, 1794000200, False))
    assert snap.pools[0].tasks == (N.PoolTask(
        task_id=ISSUE_TASK, kind="issues", item="issue-9", title="Fix #9",
        identity="octocat", hours=12, state="claimed", offered_by=("aaaabbbbccccdddd",),
        offered_here=True, executor="aaaabbbbccccdddd", executor_here=True,
        claimed_at=1794000100, lease_until=1794007300, deadline=1794043300),)
    assert [r.run_id for r in snap.runs] == ["run-1", "run-0"]
    assert snap.runs[0] == N.Run(
        run_id="run-1", task_id=TASK, pool="github.com/o/r", peer="eeeeffff00001111",
        container="dn-h1-p1", state="running", started_at=1794000150, ended_at=0, exit=0,
        log="/l/1")
    assert snap.runs[1].ended_at == 1794000100
    assert len(snap.offers) == 4
    assert snap.offers[0] == N.OfferState(
        task_id=TASK, state="claimed", executor="eeeeffff00001111", attempt=1,
        requests=4, refused=1, outcome=None, ended_at=None)
    assert snap.offers[1].attempt == 2
    assert snap.offers[2].outcome == N.Outcome(True, "clean", 0.42, 12345, "claude", "opus")
    assert snap.offers[2].ended_at == 1794000100


def test_only_a_preparing_or_running_run_holds_a_bay():
    assert N.running(N.Snapshot.parse(FULL_SNAPSHOT)) == 1
    assert N.running(None) == 0
    assert N.running(N.Snapshot.parse(json.dumps({"runs": [
        {"runId": "a", "state": "preparing"}, {"runId": "b", "state": "running"},
        {"runId": "c", "state": "finished"}, {"runId": "d", "state": "failed"},
        {"runId": "e", "state": "stopped"}]}))) == 2


def test_an_empty_document_is_a_snapshot_of_defaults_and_lists_no_offers():
    empty = N.Snapshot.parse("{}")
    assert empty == N.Snapshot()
    assert (empty.updated_at, empty.pid, empty.pk, empty.transport.state,
            empty.admit.slots, empty.admit.at, empty.pools, empty.runs,
            empty.offers) == (None, None, "", "", 0, None, (), (), None)


SPOILT = """
{"updatedAt": "soon", "daemon": 7, "identity": ["pk"], "transport": "ready",
 "admit": {"slots": true, "at": "now", "reason": 3}, "extra": {"k": 1},
 "pools": [3, {"path": "/no/id"}, {"id": "p", "members": [{"self": true}, {"pk": "k", "self": 1,
           "reachable": "yes", "maxAcceptedH": "12"}], "tasks": [{"kind": "x"},
           {"taskId": "t", "offeredBy": ["a", 2], "executorHere": 1, "hours": 12.0}]}],
 "runs": [{"taskId": "t"}, {"runId": "r", "exit": "0", "startedAt": true}],
 "offers": [{"state": "done"}, "x", {"taskId": "t", "attempt": "2", "outcome": {"ok": 1}},
            {"taskId": "u", "outcome": []}]}
"""


def test_a_member_of_the_wrong_type_is_its_default():
    spoilt = N.Snapshot.parse(SPOILT)
    assert (spoilt.updated_at, spoilt.pid, spoilt.pk, spoilt.transport.state) == (
        None, None, "", "")
    assert spoilt.admit == N.AdmitState(0, None, "")


def test_a_row_without_its_identity_is_dropped_and_1_is_not_a_flag():
    spoilt = N.Snapshot.parse(SPOILT)
    assert [p.id for p in spoilt.pools] == ["p"]
    assert spoilt.pools[0].members == (N.Member("k", False, None, None, False),)
    task, = spoilt.pools[0].tasks
    assert (task.task_id, task.offered_by, task.executor_here, task.hours) == (
        "t", ("a",), False, 12)
    assert [(r.run_id, r.exit, r.started_at) for r in spoilt.runs] == [("r", None, None)]
    assert [o.task_id for o in spoilt.offers] == ["t", "u"]
    assert (spoilt.offers[0].attempt, spoilt.offers[0].outcome.ok,
            spoilt.offers[1].outcome) == (0, False, None)


@pytest.mark.parametrize("junk", ["", "[]", "nope", "3", '{"offers": [}', None])
def test_what_is_no_json_object_is_no_snapshot(junk):
    assert N.Snapshot.parse(junk) is None


def test_no_offers_list_is_not_an_empty_one():
    assert N.Snapshot.parse('{"offers": {}}').offers is None
    assert N.Snapshot.parse('{"offers": []}').offers == ()
    assert N.Snapshot.parse(b'{"offers": []}').offers == ()


# MARK: - network: the evidence


def test_a_daemon_that_did_not_answer_is_unavailable_never_an_empty_map():
    got = N.tasks(None)
    assert (got.ok, got.value, got.reason) == (False, None, "the daemon did not answer")
    silent = N.tasks(N.Snapshot.parse("{}"))
    assert (silent.ok, silent.reason) == (False, "the snapshot lists no offers")


def test_a_snapshot_naming_no_offers_says_there_are_none():
    got = N.tasks(N.Snapshot.parse('{"offers": []}'))
    assert (got.ok, got.value) == (True, {})


def test_here_by_a_live_run_by_the_pools_word_by_this_machines_own_key_and_not_here():
    assert N.tasks(N.Snapshot.parse(FULL_SNAPSHOT)).value == {
        TASK: A.NetworkTask("claimed", "eeeeffff00001111", True),
        ISSUE_TASK: A.NetworkTask("claimed", "9999888877776666", True),
        AUDIT_TASK: A.NetworkTask("done", "aaaabbbbccccdddd", True, True),
        POOLED_TASK: A.NetworkTask("pooled")}


def test_a_run_that_ended_here_puts_no_claim_here_and_no_executor_is_not_this_machine():
    elsewhere = N.Snapshot.parse("""
        {"identity": {"pk": "aaaa"},
         "runs": [{"runId": "r", "taskId": "t", "state": "finished"}],
         "offers": [{"taskId": "t", "state": "claimed", "executor": "bbbb"},
                    {"taskId": "u", "state": "done", "executor": "", "outcome": {"ok": false}}]}
        """)
    assert N.tasks(elsewhere).value == {"t": A.NetworkTask("claimed", "bbbb"),
                                        "u": A.NetworkTask("done")}


# MARK: - network: what a run resolves to, and the projections
#
# In test_agent_state.py: the ``CASES`` rows under "a run the network carries" and the
# tests under the same heading.


# MARK: - network: the audit category

VERBS = ["network-offer", "network-claimed", "network-done", "network-failed",
         "network-withdraw", "network-unavailable", "network-join", "network-invite",
         "network-leave", "network-start", "network-stop"]


def test_every_network_verb_is_a_network_row():
    assert [N.AUDIT_OFFER, N.AUDIT_CLAIMED, N.AUDIT_DONE, N.AUDIT_FAILED,
            N.AUDIT_WITHDRAW, N.AUDIT_UNAVAILABLE, N.AUDIT_JOIN, N.AUDIT_INVITE,
            N.AUDIT_LEAVE, N.AUDIT_START, N.AUDIT_STOP] == VERBS
    assert {activity.category_of(v) for v in VERBS} == {"network"}


def test_the_network_chip_sits_after_comms():
    ids = [c.id for c in activity.categories()]
    assert ids.index("network") == ids.index("comms") + 1
    net = next(c for c in activity.categories() if c.id == "network")
    assert (net.title, net.color_hex) == ("Network", "#30B0C7")


def test_a_network_row_has_a_glyph_of_its_own_or_its_categorys():
    assert [activity.glyph_for(v) for v in VERBS] == [
        "↗", "↘", "✓", "△", "↶", "△", "⊕", "⬡", "⊖", "⬡", "⬡"]
    assert {activity.color_for(v) for v in VERBS} == {"#30B0C7"}
