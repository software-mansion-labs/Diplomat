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
  "devices": { "state": "none", "detail": "no adb server" },
  "admit": { "slots": 2, "at": 1794000290, "reason": "" },
  "pools": [ { "id": "github.com/o/r", "path": "/w/r", "identity": "octocat", "hash": "h1",
      "left": false,
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
  "offers": [ { "taskId": "github.com/o/r#review:pr-337@octocat", "pool": "github.com/o/r",
                "kind": "review", "item": "pr-337", "title": "Auto · Review · #337",
                "state": "claimed", "reason": "second attempt", "offeredAt": 1794000050,
                "executor": "eeeeffff00001111", "attempt": 1, "requests": 4, "refused": 1 },
              { "taskId": "github.com/o/r#issues:issue-9@octocat", "state": "claimed",
                "executor": "9999888877776666", "attempt": 2, "requests": 0, "refused": 0 },
              { "taskId": "github.com/o/r#audit:job-0b77ab9a731995c3@octocat", "state": "done",
                "executor": "aaaabbbbccccdddd", "attempt": 1, "requests": 9, "refused": 0,
                "outcome": { "ok": true, "summary": "clean", "usd": 0.42, "tokens": 12345,
                             "runner": "claude", "model": "opus" }, "endedAt": 1794000100 },
              { "taskId": "github.com/o/r#conflicts:pr-5@octocat", "state": "pooled",
                "executor": "", "executorHere": false, "attempt": 1, "requests": 0,
                "refused": 0 } ] }
"""

PANEL, AUTO = autofix.SOURCE_PANEL, autofix.SOURCE_AUTO

HOURS_SHORT = "this machine takes jobs of at most 12 h and this one needs 24"


# MARK: - network: what the snapshot says of this machine


def test_what_holds_this_machine_back_is_read_of_a_pool_and_of_an_offer():
    snap = N.Snapshot.from_json({
        "pools": [{"id": "p", "notTaking": "docker is down"}, {"id": "q"},
                  {"id": "r", "notTaking": 5}],
        "offers": [{"taskId": "t", "state": "pooled", "notTaking": HOURS_SHORT},
                   {"taskId": "u", "state": "pooled"},
                   {"taskId": "v", "state": "pooled", "notTaking": ["x"]}]})
    assert [p.not_taking for p in snap.pools] == ["docker is down", "", ""]
    assert [o.not_taking for o in snap.offers] == [HOURS_SHORT, "", ""]
    seen = N.tasks(snap).value
    assert (seen["t"].not_taking, seen["u"].not_taking) == (HOURS_SHORT, "")


def test_why_a_job_of_this_machines_own_waits_is_said_where_the_pool_does_not_say_it():
    held, free = N.Pool("p", not_taking="docker is down"), N.Pool("q")
    snap = N.Snapshot.from_json({"offers": [
        {"taskId": "t", "state": "pooled", "notTaking": "docker is down"},
        {"taskId": "u", "state": "pooled", "notTaking": HOURS_SHORT},
        {"taskId": "w", "state": "claimed", "notTaking": "stale"},
        {"taskId": "x", "state": "pooled"}]})
    assert N.not_taking("t", held, snap) == "", "the pool says it once for every job"
    assert N.not_taking("t", free, snap) == "docker is down"
    assert N.not_taking("u", held, snap) == HOURS_SHORT
    assert N.not_taking("w", free, snap) == "", "only of a job that waits"
    assert N.not_taking("x", held, snap) == "" and N.not_taking("none", free, snap) == ""
    assert N.not_taking("u", free, None) == ""
    assert N.not_taking("u", free, N.Snapshot()) == "", "a snapshot with no offers list"


LEFT = "this machine failed at it or gave it back, and leaves it to the others until "


@pytest.mark.parametrize("sentence, said", [
    (LEFT + "2026-11-17T10:30:56.000Z", LEFT + "16:00"),
    (LEFT + "2026-11-17T18:45:00Z", LEFT + "00:15"),
    ("from 2026-01-01T00:00:00.5Z to 2026-07-01T01:00:00.000Z, twice",
     "from 05:30 to 06:30, twice"),
    ("docker is down: no engine", None),
    ("", None),
    ("until 2026-13-17T10:30:56.000Z", None),
    ("until 2026-11-17T25:30:56.000Z", None),
    ("until 2026-11-17T10:30:56.000", None),
    ("until 2026-11-17 10:30:56Z", None),
    ("until 2026-11-17T10:30:56.000z", None),
    ("until \u0662\u0660\u0662\u0666-11-17T10:30:56Z", None),
])
def test_a_utc_time_in_a_sentence_of_the_daemons_reads_by_this_machines_clock(
        kolkata, sentence, said):
    assert N.local_times(sentence) == (sentence if said is None else said)


@pytest.mark.parametrize("name, sentence, said", [
    ("Asia/Kolkata", "until 9999-12-31T23:59:59Z", "until 05:29"),
    ("Pacific/Kiritimati", "until 9999-12-31T23:59:59.999Z", "until 13:59"),
    ("America/New_York", "until 0001-01-01T00:00:00Z", "until 19:03"),
    ("UTC", "until 9999-12-31T23:59:59Z", "until 23:59"),
    ("Asia/Kolkata", "until 0000-01-01T00:00:00Z", None),
])
def test_a_time_at_the_edge_of_the_calendar_costs_no_snapshot(
        clock_in, name, sentence, said):
    """The local day of such a time is in no year a date can have."""
    clock_in(name)
    assert N.local_times(sentence) == (said or sentence)
    snap = N.Snapshot.parse(json.dumps(
        {"pools": [{"id": "p", "notTaking": sentence}],
         "offers": [{"taskId": "t", "state": "pooled", "notTaking": sentence}]}))
    assert snap is not None and snap.pools[0].not_taking == (said or sentence)
    assert snap.offers[0].not_taking == (said or sentence)


@pytest.mark.parametrize("error", [OverflowError, OSError])
def test_a_time_this_machines_clock_cannot_read_is_left_as_written(monkeypatch, error):
    def refuses(_seconds):
        raise error("out of range")

    monkeypatch.setattr(N.time, "localtime", refuses)
    assert N.local_times("until 2026-11-17T10:30:56Z") == "until 2026-11-17T10:30:56Z"


def test_what_holds_this_machine_back_names_its_times_by_this_machines_clock(kolkata):
    until = LEFT + "2026-11-17T10:30:56.000Z"
    snap = N.Snapshot.from_json({
        "pools": [{"id": "p", "notTaking": "nothing taken before 2026-11-17T10:00:00.000Z"},
                  {"id": "q", "notTaking": until}],
        "offers": [{"taskId": "t", "state": "pooled", "notTaking": until,
                    "leftUntil": 1794911456, "leftForGood": False, "tooLong": False}]})
    assert [p.not_taking for p in snap.pools] == ["nothing taken before 15:30", LEFT + "16:00"]
    assert snap.offers[0].not_taking == LEFT + "16:00"
    assert N.tasks(snap).value["t"].not_taking == LEFT + "16:00"
    assert N.not_taking("t", snap.pools[0], snap) == LEFT + "16:00"
    assert N.not_taking("t", snap.pools[1], snap) == "", "said once, by the pool"


def test_an_outcome_says_whether_its_cost_was_capped():
    def read(outcome) -> N.Snapshot:
        return N.Snapshot.from_json({"offers": [
            {"taskId": "t", "state": "done", "outcome": outcome}]})

    assert read({"ok": True, "capped": True}).offers[0].outcome.capped is True
    for absent in ({"ok": True}, {"capped": False}, {"capped": 1}, {"capped": "true"}):
        assert read(absent).offers[0].outcome.capped is False, absent
    assert N.tasks(read({"capped": True})).value["t"].capped is True
    assert N.tasks(read({})).value["t"].capped is False
    assert N.tasks(read(None)).value["t"].capped is False, "an offer with no outcome"


def test_a_run_row_carries_no_log_whatever_the_daemon_sends():
    row = {"runId": "r", "taskId": "t", "state": "running", "exit": 0}
    with_log = N.Snapshot.from_json({"runs": [{**row, "log": "/l/1"}]})
    assert with_log == N.Snapshot.from_json({"runs": [row]})
    assert with_log.runs[0].run_id == "r"


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


HOSTS = [
    ("github.com", True), ("github.com:443", False), ("www.github.com", False),
    ("api.github.com", False), ("ghe.com", False), ("acme.ghe.com", False),
    ("a.b.ghe.com", False), ("acme.ghe.com:8443", False), ("github.localhost", False),
    ("x.github.localhost", False), ("github.localhost:3000", False), ("ghe.com:", False),
    ("github.mycorp.com", True), ("ghes.corp", True), ("ghes.corp:8443", True),
    ("ghes.corp:", True), ("notgithub.com", True), ("myghe.com", True), ("xghe.com", True),
    ("github.com.evil.example", True), ("gitlab.com", True), ("gitlab.example.com", True),
    ("localhost", True), ("ghe.com:x", True), ("ghe.com:12x", True), ("a:1:ghe.com", True),
    ("ghe.com:1:2", True), ("GHE.COM", True),
]


@pytest.mark.parametrize("host, ruled", HOSTS)
def test_the_hosts_the_requester_has_rules_for(host, ruled):
    """The daemon's ``githubApi`` (``requester/rules.js``), host for host."""
    assert N.has_rules(host) is ruled


@pytest.mark.parametrize("key, host", [
    ("acme.ghe.com/o/r", "acme.ghe.com"), ("gitlab.ghe.com/g/sub/p", "gitlab.ghe.com"),
    ("www.github.com/o/r", "www.github.com")])
def test_a_job_on_a_host_without_rules_is_refused(key, host):
    assert _offer("review-req", key=key) == \
        f"the network has no rules for a repository on {host}"


def test_a_job_on_any_other_host_is_offered_into_its_pool():
    assert _offer("review-req", key="github.mycorp.com/o/r").pool == "github.mycorp.com/o/r"


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


def test_a_two_part_key_is_githubs_and_a_longer_one_names_its_own_host():
    assert N.pool_for("O/R") == "github.com/o/r"
    assert N.pool_for("gitlab.com/Owner/Repo") == "gitlab.com/owner/repo"
    assert N.pool_for("gitlab.com/g/sub/p") == "gitlab.com/g/sub/p"
    assert N.pool_for("r") is None and N.pool_for("o//r") is None


# MARK: - network: the pools listing

LOGINS = {"github.com": "octocat", "gitlab.example.com": "me"}
OTHER = LocalRepo("a", "b", "/w/b")
WHOLE = ["github.com/o/r", "gitlab.example.com/g/sub/p", "github.com/x/y"]


GONE = N.Pool("github.com/q/gone", path="/mnt/x", identity="octocat")
LAB_GONE = N.Pool("gitlab.example.com/q/lab", path="/mnt/lab", identity="me")
STALE = N.Pool("github.com/q/stale", path="/w/stale", identity="octocat")


def _listing(others=(OTHER,), unread=(), identities=LOGINS, known=()):
    return N.pools_listing(ROOTS, others, unread, identities, known)


def _ids(listing) -> list[str]:
    return [p["id"] for p in listing[0]]


def test_the_listing_is_the_roots_then_what_the_other_checkouts_name():
    assert _ids(_listing()) == WHOLE + ["github.com/a/b"] and _listing()[1] == []
    assert _ids(_listing(others=(ROOTS[3], OTHER))) == WHOLE + ["github.com/a/b"], (
        "a checkout of a root's repository adds no pool")
    assert _ids(_listing(others=())) == WHOLE, "a checkout naming no forge is left out"


def test_the_pool_behind_an_unread_path_is_said_as_the_daemon_had_it():
    pools, unconfirmed = _listing(unread=("/mnt/x", "/mnt/lab", "/mnt/new"),
                                  known=(STALE, GONE, LAB_GONE))
    assert [p["id"] for p in pools] == WHOLE + [
        "github.com/a/b", "github.com/q/gone", "gitlab.example.com/q/lab"], (
        "and one behind no listed path is left")
    assert pools[-2:] == [
        {"id": "github.com/q/gone", "path": "/mnt/x", "forge": "github", "identity": "octocat"},
        {"id": "gitlab.example.com/q/lab", "path": "/mnt/lab", "forge": "gitlab",
         "identity": "me"}]
    assert unconfirmed == [
        f"{path} cannot be read: its pool stays as the daemon last had it until the path "
        "can be read or is taken out of Settings" for path in ("/mnt/x", "/mnt/lab", "/mnt/new")]


def test_a_repository_whose_login_is_unknown_keeps_the_pool_the_daemon_had():
    was = N.Pool("gitlab.example.com/g/sub/p", path="/old/p", identity="me")
    pools, unconfirmed = _listing(identities={"github.com": "octocat"}, known=(was, STALE))
    assert [p["id"] for p in pools] == [
        "github.com/o/r", "github.com/x/y", "github.com/a/b", "gitlab.example.com/g/sub/p"]
    assert pools[-1] == {"id": "gitlab.example.com/g/sub/p", "path": "/old/p",
                         "forge": "gitlab", "identity": "me"}
    assert unconfirmed == ["The login for g/sub/p on gitlab.example.com is not known yet: "
                           "its pool stays as the daemon last had it until it is"]
    assert _ids(_listing(identities={"github.com": "octocat"})) == [
        "github.com/o/r", "github.com/x/y", "github.com/a/b"], (
        "and has none the daemon never had, the others said all the same")
    assert _listing(identities={"gitlab.example.com": "me"})[1] == [
        N.unconfirmed_account(repo, "github.com") for repo in ("o/r", "x/y", "a/b")], (
        "each repository with no login is named once")


def test_a_pool_that_was_read_is_said_as_read():
    pools, _ = _listing(unread=("/old/r",), known=(
        N.Pool("github.com/o/r", path="/old/r", identity="someone"),))
    assert [p["id"] for p in pools] == WHOLE + ["github.com/a/b"]
    assert pools[0] == {"id": "github.com/o/r", "path": "/w/r", "forge": "github",
                        "identity": "octocat"}


GHE = LocalRepo("o", "r", "/w/ghe", "acme.ghe.com")
NO_RULES = ("o/r is on acme.ghe.com, which the Diplomacy Network has no rules for: it has "
            "no pool and none of its jobs is offered")


def test_a_repository_on_a_host_without_rules_has_no_pool_and_is_named():
    was = N.Pool("acme.ghe.com/o/r", path="/w/ghe", identity="me")
    logins = {**LOGINS, "acme.ghe.com": "me"}
    pools, said = N.pools_listing(ROOTS, (OTHER, GHE, GHE), (), logins, (was,))
    assert [p["id"] for p in pools] == WHOLE + ["github.com/a/b"], (
        "not the pool it would make, and not the one the daemon had for it")
    assert said == [NO_RULES], "named once"
    assert N.pools_listing([GHE], (), (), {}, (was,)) == ([], [NO_RULES]), (
        "with no login known there it is not said to wait for one")
    assert N.linked_pools([GHE], {"acme.ghe.com": "me"}) == []


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
    assert (N.ENABLED_KEY, N.REQUIRED_MINIMUM_H_KEY, N.MAXIMUM_ACCEPTED_H_KEY,
            N.DEVICES_KEY) == ("networkEnabled", "networkRequiredMinimumH",
                               "networkMaximumAcceptedH", "networkDevices")


#: Stored values and the hours the daemon's `hoursOf` makes of each: the same document
#: `NetworkSmoke.swift` reads. The daemon's own test sets 48, 100000, 1 and "many".
HOURS = json.loads("""
[[null, 12], [11, 12], [12, 12], [48, 48], [48.0, 48], [13.5, 14], [15.5, 16], [12.49, 12],
 [12.5, 13], [14.5, 15],
 [0, 12], [-5, 12], [719, 719], [719.5, 720], [720, 720], [721, 720], [1e30, 720],
 [100000, 720], [1, 12], ["many", 12], ["24", 24], [" 48 ", 48], ["", 12], ["15.5", 16],
 ["0x30", 48], ["1e2", 100], [".5e2", 50], ["4_8", 12], ["48h", 12], ["Infinity", 12],
 ["\u0664\u0668", 12], [true, 12], [false, 12], [[24], 24], [["36"], 36], [[], 12],
 [[24, 48], 12], [[null], 12], [{}, 12]]
""")


@pytest.mark.parametrize("stored,want", [
    *map(tuple, HOURS), (float("inf"), 12), (float("-inf"), 12), (float("nan"), 12),
    (10 ** 400, 12),
], ids=repr)
def test_the_hours_are_what_the_daemon_reads(stored, want):
    assert N.hours(stored) == want
    assert type(N.hours(stored)) is int


def test_the_daemons_floor_and_ceiling():
    assert (N.HOURS_FLOOR, N.HOURS_CEILING) == (12, 720)


def test_the_routes_and_their_bodies():
    assert [N.ROUTE_HEALTH, N.ROUTE_STATE, N.ROUTE_POOLS, N.ROUTE_ADMIT, N.ROUTE_OFFER,
            N.ROUTE_WITHDRAW, N.ROUTE_INVITE, N.ROUTE_JOIN, N.ROUTE_LEAVE,
            N.ROUTE_STOP_RUN] == ["health", "state", "pools", "admit", "offer",
                                  "withdraw", "invite", "join", "leave", "stop-run"]
    assert N.withdraw_body(TASK, N.WITHDRAW_MERGED) == {"taskId": TASK, "reason": "merged"}
    assert N.WITHDRAW_FORGOTTEN == "forgotten"
    assert (N.WITHDRAW_STOPPED, N.WITHDRAW_NOT_BOOKED,
            N.WITHDRAW_SWITCHED_OFF) == ("stopped", "not booked", "switched off")
    assert N.invite_body("github.com/o/r") == {"pool": "github.com/o/r"}
    assert N.invite_body("github.com/o/r", 600) == {"pool": "github.com/o/r",
                                                   "ttlSecs": 600}
    assert N.join_body("tok") == {"invite": "tok"}
    assert N.join_body(pool="github.com/o/r") == {"pool": "github.com/o/r"}
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
    assert snap.devices == N.Service("none", "no adb server")
    assert N.Snapshot.parse("{}").devices == N.Service()
    assert snap.admit == N.AdmitState(2, 1794000290, "")
    assert [(p.id, p.path, p.identity, p.hash, p.left) for p in snap.pools] == [
        ("github.com/o/r", "/w/r", "octocat", "h1", False)]
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
        container="dn-h1-p1", state="running", started_at=1794000150, ended_at=0, exit=0)
    assert snap.runs[1].ended_at == 1794000100
    assert len(snap.offers) == 4
    assert snap.offers[0] == N.OfferState(
        task_id=TASK, state="claimed", executor="eeeeffff00001111", attempt=1,
        requests=4, refused=1, outcome=None, ended_at=None, pool="github.com/o/r",
        kind="review", item="pr-337", title="Auto · Review · #337",
        reason="second attempt", executor_here=None, offered_at=1794000050)
    assert snap.offers[1].attempt == 2
    assert snap.offers[2].outcome == N.Outcome(True, "clean", 0.42, 12345, "claude", "opus")
    assert snap.offers[2].ended_at == 1794000100


def test_a_pool_is_left_only_on_the_daemons_word():
    left = N.Snapshot.parse(
        '{"pools": [{"id": "a", "left": true}, {"id": "b"}, {"id": "c", "left": 1}]}')
    assert [p.left for p in left.pools] == [True, False, False]


def test_a_join_under_way_and_why_the_last_invite_failed_are_read_of_a_pool():
    seen = N.Snapshot.from_json({"pools": [
        {"id": "a", "joining": True}, {"id": "b", "joinFailed": "no-seat"}, {"id": "c"},
        {"id": "d", "joining": 1, "joinFailed": 5},
        {"id": "e", "joining": "true", "joinFailed": ["no-seat"]},
        {"id": "f", "joining": True, "joinFailed": "its voucher does not hold"}]}).pools
    assert [p.joining for p in seen] == [True, False, False, False, False, True]
    assert [p.join_failed for p in seen] == [
        "", "no-seat", "", "", "", "its voucher does not hold"]


def test_what_an_offer_row_carries_and_no_word_on_where_it_runs_is_not_a_no():
    offered = N.Snapshot.parse(FULL_SNAPSHOT).offers
    assert (offered[0].pool, offered[0].kind, offered[0].item, offered[0].title,
            offered[0].reason, offered[0].offered_at) == (
        "github.com/o/r", "review", "pr-337", "Auto · Review · #337", "second attempt",
        1794000050)
    assert (offered[0].executor_here, offered[3].executor_here) == (None, False)


def test_an_offer_row_that_carries_none_of_it():
    row = N.Snapshot.parse(FULL_SNAPSHOT).offers[1]
    assert (row.pool, row.kind, row.item, row.title, row.reason, row.offered_at) == (
        "", "", "", "", "", None)


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


@pytest.mark.parametrize("daemon, settings", [
    ({"pid": 7}, ()),
    ({"testSettings": []}, ()),
    ({"testSettings": ["DN_LEASE_SECS=60", "DN_TRANSPORT=loop"]},
     ("DN_LEASE_SECS=60", "DN_TRANSPORT=loop")),
    ({"testSettings": ["DN_TRANSPORT=loop", 7, "", None, ["DN_X=1"], True]},
     ("DN_TRANSPORT=loop",)),
    ({"testSettings": "DN_TRANSPORT=loop"}, ()),
    ({"testSettings": {"DN_TRANSPORT": "loop"}}, ()),
])
def test_a_snapshot_lists_what_only_a_test_gave_the_daemon(daemon, settings):
    snap = N.Snapshot.parse(json.dumps({"daemon": daemon}))
    assert snap.test_settings == settings
    assert snap.test_settings_note == (
        ("The daemon runs with settings only a test gives it, and is not one for the "
         "network: " + ", ".join(settings)) if settings else "")


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


def services(**states) -> N.Snapshot:
    """A snapshot whose services are ready but for the ones named, each a
    ``(state, detail)``."""
    doc = {name: {"state": "ready", "detail": ""} for name in ("transport", "docker", "model")}
    doc.update({name: {"state": state, "detail": detail}
                for name, (state, detail) in states.items()})
    return N.Snapshot.from_json(doc)


@pytest.mark.parametrize("answered,snapshot,want", [
    (None, None, ""),
    (True, services(), ""),
    (False, None, "Diplomacy Network: the daemon is not answering"),
    (False, services(), "Diplomacy Network: the daemon is not answering"),
    (True, None, ""),
    (True, services(transport=("starting", "tor is 45% through its bootstrap"),
                    docker=("building", "building the job image")), ""),
    (True, services(transport=("failed", "tor not found")),
     "Diplomacy Network: transport failed (tor not found)"),
    (True, services(docker=("missing", "docker not found: every job runs in a container"),
                    model=("missing", "")),
     "Diplomacy Network: docker missing (docker not found: every job runs in a "
     "container); model missing"),
    (True, services(transport=("down", "")), "Diplomacy Network: transport down"),
    (True, N.Snapshot.from_json({"devices": {"state": "failed", "detail": "x"}}), ""),
], ids=["not asked", "all ready", "silent", "silent over an old snapshot", "no snapshot",
        "coming up", "transport failed", "docker and model missing", "down",
        "the devices are not the panel's"])
def test_the_panel_line_says_what_of_the_network_does_not_work(answered, snapshot, want):
    assert N.trouble(answered, snapshot) == want
    assert N.TROUBLE_STATES == {"failed", "missing", "down"}
    # Settings that cannot be read outrank whatever the daemon says.
    unknown = N.settings_unknown("/home/u/.diplomat/config.json")
    assert unknown == "/home/u/.diplomat/config.json cannot be read as settings"
    assert N.trouble(answered, snapshot, unknown) == f"Diplomacy Network: {unknown}"
    assert N.unknown_note(unknown) == (
        "/home/u/.diplomat/config.json cannot be read as settings: until it can be, this "
        "machine's pools stay as the daemon has them and nothing is offered")


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
        TASK: A.NetworkTask("claimed", "eeeeffff00001111", True,
                            reason="second attempt"),
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


def test_the_offers_own_word_on_where_it_runs_wins_and_a_word_that_is_no_flag_is_none():
    """Every road says ``t`` runs here and none says ``u`` does; the offers say
    otherwise."""
    told = N.Snapshot.parse("""
        {"identity": {"pk": "aaaa"},
         "pools": [{"id": "p", "tasks": [{"taskId": "t", "executorHere": true}]}],
         "runs": [{"runId": "r", "taskId": "t", "state": "running"}],
         "offers": [{"taskId": "t", "state": "claimed", "executor": "aaaa", "executorHere": false},
                    {"taskId": "u", "state": "claimed", "executor": "bbbb", "executorHere": true},
                    {"taskId": "v", "state": "claimed", "executor": "aaaa", "executorHere": 0},
                    {"taskId": "w", "state": "failed", "reason": "the container exited 137"}]}
        """)
    assert N.tasks(told).value == {
        "t": A.NetworkTask("claimed", "aaaa"),
        "u": A.NetworkTask("claimed", "bbbb", True),
        "v": A.NetworkTask("claimed", "aaaa", True),
        "w": A.NetworkTask("failed", reason="the container exited 137")}


def test_an_open_offer_is_found_by_its_pool_kind_and_item():
    snap = N.Snapshot.parse(FULL_SNAPSHOT)
    assert N.open_task("github.com/o/r", "review", "pr-337", snap) == TASK
    assert N.open_task("github.com/o/x", "review", "pr-337", snap) is None
    assert N.open_task("github.com/o/r", "review-own", "pr-337", snap) is None
    assert N.open_task("github.com/o/r", "review", "pr-338", snap) is None


def test_an_offer_that_ended_is_not_the_one_held():
    ended = N.Snapshot.parse("""
        {"offers": [{"taskId": "a", "pool": "p", "kind": "k", "item": "i", "state": "done"},
                    {"taskId": "b", "pool": "p", "kind": "k", "item": "i", "state": "failed"},
                    {"taskId": "c", "pool": "p", "kind": "k", "item": "i", "state": "cancelled"},
                    {"taskId": "d", "pool": "p", "kind": "k", "item": "i", "state": "pooled"}]}
        """)
    assert N.open_task("p", "k", "i", ended) == "d"
    assert N.open_task("p", "k", "i", None) is None
    assert N.open_task("p", "k", "i", N.Snapshot.parse("{}")) is None


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


def test_every_network_row_has_a_glyph_of_its_own():
    assert [activity.glyph_for(v) for v in VERBS] == [
        "↗", "↘", "✓", "△", "↶", "△", "⊕", "✉", "⊖", "▷", "□"]
    assert {activity.color_for(v) for v in VERBS} == {"#30B0C7"}
