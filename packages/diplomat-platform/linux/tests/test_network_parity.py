"""The Diplomacy Network's pure answers, twin against twin.

``network.py`` and the core's ``Network.swift`` answer the same questions on every
cycle and every draw, so neither can delegate to the other, and each side's own tests
pin it against its own expectations only. This file runs one fixture through both
(``diplomat-core network``) and demands the same answers: the hours a stored value
reads as, the pool a git remote names, the kind an offer is made as, the task a
snapshot holds for an offer, the pools list, and the panel's line on what of the
network does not work.
"""

from __future__ import annotations

import json
import os
import subprocess

import pytest

from diplomat_runtime import localrepos
from diplomat_runtime import network as N
from diplomat_runtime.prref import LocalRepo

CORE_BIN = os.environ.get("DIPLOMAT_CORE_BIN")
pytestmark = pytest.mark.skipif(
    not CORE_BIN,
    reason="DIPLOMAT_CORE_BIN not set (build it with "
           "packages/diplomat-platform/linux/install/build-core.sh)")

HOURS = [
    None, True, False, 0, 1, 11, 11.4, 11.5, 11.99, 12, 12.4, 12.49, 12.5, 13.5, 14.5, 24,
    47.999, 48, 100.5, 719, 719.49, 719.5, 720, 720.4, 721, 1000, 1e9, 1e21, 1e300, -1, -12,
    -0.5, 0.5, 2**53, 2**53 + 1,
    "", " ", "24", " 24 ", "\t48\n", "24.5", "24.49", "24h", "abc", "1e2", "1E2", ".5e2",
    "5.", "0024", "0x18", "0X18", "0b11000", "0o30", "+36", "-36", "Infinity", "-Infinity",
    "+Infinity", "infinity", "NaN", "12,5", "1_000", "true", "null", "36 48", "--36",
    [], [24], [24, 48], ["36"], [[36]], [None], [""], {}, {"h": 24},
]

REMOTES = [
    "https://github.com/o/r", "https://github.com/o/r.git", "https://github.com/o/r/",
    "https://github.com/o/r.git/", "http://github.com/o/r", "git://github.com/o/r.git",
    "ssh://git@github.com/o/r.git", "ssh://git@github.com:22/o/r.git",
    "https://user@github.com/o/r", "https://user:secret@github.com/o/r",
    "https://github.com:443/o/r.git", "git@github.com:o/r.git", "git@github.com:o/r",
    "org-1234@github.com:o/r.git", "  git@github.com:o/r.git\n", "git@GitHub.com:Owner/Repo.git",
    "https://GITHUB.COM/Owner/Repo", "https://github.com/o/r.name.git",
    "https://github.com/o-1/r_2.git", "https://github.com/o/r.git.git",
    "https://github.com/o", "https://github.com/o/r/extra", "https://github.com//r",
    "https://github.com/o/", "github.com/o/r", "git@github.com/o/r.git", "",
    "https://www.github.com/o/r", "https://github.com.evil.example/o/r",
    "https://notgithub.com/o/r", "https://github.mycorp.com/o/r.git",
    "git@github.mycorp.com:o/r.git", "https://bitbucket.org/o/r.git",
    "https://gitlab.com/o/r", "https://gitlab.com/o/r.git", "https://gitlab.com/o/r/",
    "https://gitlab.com/group/sub/r.git", "https://gitlab.com/a/b/c/d/r.git",
    "git@gitlab.com:o/r.git", "git@gitlab.com:group/sub/r.git",
    "ssh://git@gitlab.com:2222/group/sub/r.git", "https://GitLab.com/Group/Sub/Repo.git",
    "https://gitlab.acme.example/platform/api.git", "git@gitlab.acme.example:platform/api.git",
    "https://GITLAB.Acme.Example/Platform/API", "https://gitlab.acme.example:8443/p/api.git",
    "https://gitlab/o/r.git", "https://gitlab./o/r.git", "https://gitlab..example/o/r.git",
    "https://mygitlab.example/o/r.git", "https://git.example.org/o/r.git",
    "https://gitlab.com/r.git", "https://gitlab.com/o/r/-/tree/main", "git@gitlab.com:r.git",
    "https://gitlab.com/o/r.wiki.git", "file:///src/r", "/src/r", "../r", "o/r",
    "https://example.com/gitlab.com/o/r", "https://gitlab.com.evil.example/o/r",
    "https://codeberg.org/o/r", "ftp://github.com/o/r", "https://github.com/o/r?x=1",
    "https://github.com/o/r#frag", "https://github.com/o r/r", "git@github.com:o/r.git extra",
    "https://github.com/ö/r", "git@gitlab.com:group/sub/r", "https://gitlab.com/o/.git",
    "https://github.com/o/.git", "git@gitlab.acme.example:platform/sub/api.git",
]

KINDS = [{"verb": verb, "ownPR": own}
         for verb in ("review-req", "review", "comms-review", "review-reply", "conflicts",
                      "issues", "comms-fix", "audit", "investigate", "comms-investigate",
                      "monitor", "REVIEW", "")
         for own in (False, True)]

POOL, LAB = "github.com/o/r", "gitlab.acme.example/platform/api"


def _offer(task: str, state: str, *, pool: str = POOL, kind: str = "review",
           item: str = "pr-9") -> dict:
    ended = state in ("done", "failed", "cancelled")
    return {"taskId": task, "pool": pool, "kind": kind, "item": item, "title": "T",
            "state": state, "executor": "", "executorHere": False, "attempt": 1,
            "requests": 0, "refused": 0, "outcome": None, "reason": "",
            "offeredAt": 1_799_990_000, "endedAt": 1_800_000_000 if ended else 0}


def _snapshot(*, offers=(), pools=(), **services) -> dict:
    return {"updatedAt": 1_800_000_000.0, "daemon": {"pid": 7, "startedAt": 1_799_990_000.0},
            "identity": {"pk": "a" * 64, "onion": "x.onion"},
            "transport": {"state": "ready"}, "docker": {"state": "ready"},
            "model": {"state": "ready"}, "devices": {"state": "off"},
            "admit": {"slots": 0}, "pools": list(pools), "runs": [],
            "offers": list(offers), **services}


def _pool(pool: str, path: str, identity: str) -> dict:
    return {"id": pool, "path": path, "identity": identity, "left": False, "members": [],
            "tasks": []}


SNAPSHOTS = [
    _snapshot(),
    _snapshot(offers=[_offer("t-done", "done"), _offer("t-open", "pooled"),
                      _offer("t-later", "claimed"),
                      _offer("t-issue", "claimed", kind="issues", item="issue-4"),
                      _offer("t-lab", "pooled", pool=LAB),
                      _offer("t-gone", "cancelled", item="pr-10"),
                      _offer("t-failed", "failed", item="pr-11")],
              pools=[_pool(POOL, "/src/r", "octocat"), _pool(LAB, "/src/api", "ilatka"),
                     _pool("github.com/acme/tool", "/mnt/tool", "octocat")]),
    _snapshot(transport={"state": "failed", "detail": "tor is not installed"}),
    _snapshot(docker={"state": "missing", "detail": "docker is not on the PATH"},
              model={"state": "missing"}),
    _snapshot(transport={"state": "starting"}, docker={"state": "building"}),
    _snapshot(transport={"state": "failed"}, docker={"state": "failed", "detail": "27.0"},
              model={"state": "missing", "detail": "no credential"},
              devices={"state": "none", "detail": "no adb server answers"}),
    _snapshot(transport={"state": "down"}, devices={"state": "failed"}),
    _snapshot(transport={"state": "odd"}, docker={}, model={"state": ""}),
]

OPEN_TASK = [{"pool": pool, "kind": kind, "item": item, "snapshot": at}
             for at in (None, 0, 1)
             for pool, kind, item in (
                 (POOL, "review", "pr-9"), (POOL, "review", "pr-10"), (POOL, "review", "pr-11"),
                 (POOL, "issues", "issue-4"), (POOL, "issues", "pr-9"), (LAB, "review", "pr-9"),
                 ("github.com/O/R", "review", "pr-9"), (POOL, "Review", "pr-9"), ("", "", ""))]

TROUBLE = [{"answered": answered, "snapshot": at}
           for answered in (None, False, True)
           for at in (None, *range(len(SNAPSHOTS)))]

ROOT = {"owner": "o", "repo": "r", "path": "/src/r", "host": "github.com"}
API = {"owner": "platform", "repo": "api", "path": "/src/api", "host": "gitlab.acme.example"}
TOOL = {"owner": "acme", "repo": "tool", "path": "/mnt/tool", "host": "github.com"}
TWIN = {"owner": "O", "repo": "R", "path": "/src/r-again", "host": "github.com"}
GROUPED = {"owner": "group/sub", "repo": "r", "path": "/src/g", "host": "gitlab.com"}
BOTH = {"github.com": "octocat", "gitlab.acme.example": "ilatka", "gitlab.com": "ila"}

LISTING = [
    {"roots": roots, "others": others, "unread": unread, "identities": identities,
     "snapshot": at}
    for at in (None, 0, 1)
    for roots, others, unread, identities in (
        ([], [], [], BOTH),
        ([ROOT], [], [], BOTH),
        ([ROOT, TWIN], [API, GROUPED], [], BOTH),
        ([ROOT], [API, TOOL], [], {"github.com": "octocat"}),
        ([ROOT], [API], ["/mnt/tool"], BOTH),
        ([ROOT], [], ["/mnt/tool", "/src/api", "/nowhere"], BOTH),
        ([ROOT, API], [TOOL], ["/mnt/tool"], {}),
        ([API], [ROOT], [], {"gitlab.acme.example": "ilatka"}),
    )]

PAYLOAD = {"hours": HOURS, "remotes": REMOTES, "kinds": KINDS, "snapshots": SNAPSHOTS,
           "openTask": OPEN_TASK, "trouble": TROUBLE, "listing": LISTING}


def _python() -> dict:
    snapshots = [N.Snapshot.parse(json.dumps(s)) for s in SNAPSHOTS]

    def snapshot(row: dict) -> N.Snapshot | None:
        return None if row["snapshot"] is None else snapshots[row["snapshot"]]

    def pool(url: str) -> str | None:
        at = localrepos.parse_remote(url, {})
        if at is None:
            return None
        return N.pool_for(LocalRepo(owner=at[1], repo=at[2], path="", host=at[0]).key)

    def listing(row: dict) -> dict:
        seen = snapshot(row)
        pools, unconfirmed = N.pools_listing(
            [LocalRepo(**r) for r in row["roots"]], [LocalRepo(**r) for r in row["others"]],
            row["unread"], row["identities"], seen.pools if seen else [])
        return {"pools": pools, "unconfirmed": unconfirmed}

    return {
        "hours": [N.hours(v) for v in HOURS],
        "pools": [pool(url) for url in REMOTES],
        "kinds": [N.kind_for(k["verb"], k["ownPR"]) for k in KINDS],
        "openTask": [N.open_task(r["pool"], r["kind"], r["item"], snapshot(r))
                     for r in OPEN_TASK],
        "trouble": [N.trouble(r["answered"], snapshot(r)) for r in TROUBLE],
        "listing": [listing(r) for r in LISTING],
    }


@pytest.fixture(scope="module")
def twins() -> tuple[dict, dict]:
    proc = subprocess.run([CORE_BIN, "network"], input=json.dumps(PAYLOAD).encode("utf-8"),
                          capture_output=True, timeout=60, check=False)
    assert proc.returncode == 0, \
        f"diplomat-core network failed: {proc.stderr.decode('utf-8', 'replace')}"
    return json.loads(proc.stdout), _python()


def _differing(rows: list, swift: list, python: list) -> list:
    assert len(swift) == len(python) == len(rows)
    return [(row, s, p) for row, s, p in zip(rows, swift, python) if s != p]


@pytest.mark.parametrize("member, rows", [
    ("hours", HOURS), ("pools", REMOTES), ("kinds", KINDS), ("openTask", OPEN_TASK),
    ("trouble", TROUBLE), ("listing", LISTING)])
def test_the_twins_agree(twins, member, rows):
    swift, python = twins
    assert _differing(rows, swift[member], python[member]) == []


def test_the_fixture_reaches_what_it_claims_to(twins):
    """Agreement on a fixture that only ever reaches the defaults proves nothing."""
    _, python = twins
    assert len(HOURS) == 75 and len(REMOTES) == 72
    assert {12, 13, 14, 24, 25, 36, 48, 101, 720} <= set(python["hours"])
    pools = set(python["pools"])
    assert {None, POOL, "github.com/owner/repo", "gitlab.com/group/sub/r", LAB} <= pools
    assert set(python["kinds"]) == {None, "review", "review-own", "conflicts", "issues",
                                    "audit", "investigate"}
    assert {None, "t-open", "t-issue", "t-lab"} == set(python["openTask"])
    assert "" in python["trouble"] and len(set(python["trouble"])) >= 6
    assert any(row["unconfirmed"] for row in python["listing"])
    assert any(len(row["pools"]) >= 3 for row in python["listing"])
