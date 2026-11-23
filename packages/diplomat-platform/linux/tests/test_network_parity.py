"""The Diplomacy Network's pure answers, twin against twin.

``network.py`` and the core's ``Network.swift`` answer the same questions on every
cycle and every draw, so neither can delegate to the other, and each side's own tests
pin it against its own expectations only. This file runs one fixture through both
(``diplomat-core network``) and demands the same answers: the hours a stored value
reads as, the pool a git remote names, the hosts the requester has rules for, the kind
and the body an offer is made as, the task a snapshot holds for an offer, the pools
list, why a job of this machine's own waits, the clock time a sentence of the daemon's
names, and the panel's line on what of the network does not work.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess

import pytest

from pathlib import Path

from diplomat_runtime import autofix, localrepos
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
    "https://github.com:8443/o/r", "https://u:pw@github.com:8443/o/r", "HTTP://github.com:8080/o/r",
    "http://github.com:443/o/r", "http://github.com:80/o/r", "https://github.com:0443/o/r",
    "https://gitlab.com:8443/g/r.git", "ssh://git@gitlab.acme.example:2222/p/api.git",
    "git://github.com:9418/o/r.git", "https://github.com:/o/r",
]

#: Remotes on a port the forge's API is not on: no pool.
OTHER_PORT = ("https://gitlab.acme.example:8443/p/api.git", "https://github.com:8443/o/r",
              "https://u:pw@github.com:8443/o/r", "HTTP://github.com:8080/o/r",
              "http://github.com:443/o/r", "https://gitlab.com:8443/g/r.git")

RULES = [
    "github.com", "github.com:443", "www.github.com", "api.github.com", "ghe.com",
    "acme.ghe.com", "a.b.ghe.com", "acme.ghe.com:8443", "github.localhost",
    "x.github.localhost", "github.localhost:3000", "ghe.com:", "github.mycorp.com",
    "ghes.corp", "ghes.corp:8443", "ghes.corp:", "notgithub.com", "myghe.com", "xghe.com",
    "github.com.evil.example", "gitlab.com", "gitlab.example.com", "localhost", "ghe.com:x",
    "ghe.com:12x", "a:1:ghe.com", "ghe.com:1:2", "GHE.COM", "", ":", ":443", ".ghe.com",
    "ghe.com.", "github.com:", "github.com:x", "ghe.com:\u0663", "x.github.com:80",
]

OFFERS = [{"verb": verb, "ownPR": False, "number": number, "repoKey": key, "label": label,
           "prompt": "p", "panel": panel, "forced": False}
          for verb in ("review-req", "issues", "audit", "nudge")
          for key in ("o/r", "O/R", "acme.ghe.com/o/r", "gitlab.ghe.com/g/sub/p",
                      "www.github.com/o/r", "github.mycorp.com/o/r", "gitlab.com/g/p", "r", "")
          for number, label, panel in ((7, "Auto · #7", False), (None, "", True))]

KINDS = [{"verb": verb, "ownPR": own}
         for verb in ("review-req", "review", "comms-review", "review-reply", "conflicts",
                      "issues", "comms-fix", "audit", "investigate", "comms-investigate",
                      "monitor", "REVIEW", "")
         for own in (False, True)]

POOL, LAB = "github.com/o/r", "gitlab.acme.example/platform/api"


def _offer(task: str, state: str, *, pool: str = POOL, kind: str = "review",
           item: str = "pr-9", not_taking: str = "") -> dict:
    ended = state in ("done", "failed", "cancelled")
    return {"taskId": task, "pool": pool, "kind": kind, "item": item, "title": "T",
            "state": state, "executor": "", "executorHere": False, "attempt": 1,
            "requests": 0, "refused": 0, "outcome": None, "reason": "",
            "offeredAt": 1_799_990_000, "endedAt": 1_800_000_000 if ended else 0,
            "notTaking": not_taking}


def _snapshot(*, offers=(), pools=(), **services) -> dict:
    return {"updatedAt": 1_800_000_000.0, "daemon": {"pid": 7, "startedAt": 1_799_990_000.0},
            "identity": {"pk": "a" * 64, "onion": "x.onion"},
            "transport": {"state": "ready"}, "docker": {"state": "ready"},
            "model": {"state": "ready"}, "devices": {"state": "off"},
            "admit": {"slots": 0}, "pools": list(pools), "runs": [],
            "offers": list(offers), **services}


def _pool(pool: str, path: str, identity: str, not_taking: str = "") -> dict:
    return {"id": pool, "path": path, "identity": identity, "left": False, "members": [],
            "tasks": [], "notTaking": not_taking}


DOWN, SHORT = "docker is down: no engine", "this machine takes jobs of at most 12 h"


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
    _snapshot(daemon={"pid": 7, "testSettings": ["DN_LEASE_SECS=60", "DN_TRANSPORT=loop"]}),
    _snapshot(daemon={"testSettings": ["DN_TRANSPORT=loop", 7, "", None, ["DN_X=1"], True]}),
    _snapshot(daemon={"testSettings": "DN_TRANSPORT=loop"}),
    _snapshot(offers=[_offer("t-down", "pooled", not_taking=DOWN),
                      _offer("t-short", "pooled", item="pr-2", not_taking=SHORT),
                      _offer("t-free", "pooled", item="pr-3"),
                      _offer("t-taken", "claimed", item="pr-4", not_taking=SHORT),
                      _offer("t-lab", "pooled", pool=LAB, not_taking=DOWN)],
              pools=[_pool(POOL, "/src/r", "octocat", DOWN), _pool(LAB, "/src/api", "ilatka")]),
]

HELD = len(SNAPSHOTS) - 1

#: What the daemon package's bench answered `GET /state` with: two machines of one
#: pool before, while and after a job, and a machine alone in its pool whose own job
#: is too long for it, was given back, or had its figures lowered.
DAEMON = json.loads(Path(__file__).with_name("daemon_snapshots.json").read_text("utf-8"))
REAL = len(SNAPSHOTS)
SNAPSHOTS += DAEMON.values()
WIDGETS = "github.com/acme/widgets"
TOO_LONG = "this machine takes jobs of at most 12 h and this one needs 24"
LEFT = "this machine failed at it or gave it back, and leaves it to the others until "

#: Sentences of the daemon's, with and without a UTC time in them.
TIMES = [
    LEFT + "2026-11-17T10:30:56.000Z", LEFT + "2026-11-17T18:45:00Z",
    "from 2026-01-01T00:00:00.5Z to 2026-07-01T01:00:00.000Z, twice",
    "docker is down: no engine", "", "until 2026-13-17T10:30:56.000Z",
    "until 2026-11-17T25:30:56.000Z", "until 2026-11-17T10:30:61.000Z",
    "until 2026-02-30T10:30:56.000Z", "until 2026-11-17T10:30:56.000",
    "until 2026-11-17 10:30:56Z", "until 2026-11-17T10:30:56.000z",
    "until \u0662\u0660\u0662\u0666-11-17T10:30:56Z", "2026-11-17T10:30:56Z2026-11-17T10:31:56Z",
]
#: Times whose local day is in no year a date can have, east or west of UTC, and the
#: year before the first.
EDGE = ["until 9999-12-31T23:59:59Z", "until 9999-12-31T23:59:59.999Z",
        "until 0001-01-01T00:00:00Z", "until 0000-01-01T00:00:00Z"]
TIMES += EDGE

#: Hosts as glab's config lists them (:func:`localrepos.config_hosts`): each to itself,
#: an ``ssh_host`` to its host. github.com is GitHub whatever glab lists.
HOSTED = {"git.example.org": "git.example.org", "ssh.git.example.org": "git.example.org",
          "code.acme.example": "code.acme.example", "mygitlab.example": "mygitlab.example",
          "github.com": "github.com", "gitlab.acme.example": "gitlab.acme.example"}
HOSTED_REMOTES = REMOTES + [
    "git@ssh.git.example.org:o/r.git", "ssh://git@SSH.Git.Example.Org:2222/Group/Sub/R.git",
    "https://Git.Example.Org/O/R", "https://code.acme.example:8443/p/api.git",
    "https://code.acme.example/a/b/c/api", "https://ssh.git.example.org/o/r",
    "https://other.example.org/o/r.git", "git@mygitlab.example:o/r.git",
]
NOT_TAKING = [{"task": task, "pool": pool, "snapshot": at}
              for at, pools in ((HELD, (0, 1)), (1, (0, 1, 2)), (None, (0,)))
              for pool in pools
              for task in ("t-down", "t-short", "t-free", "t-taken", "t-lab", "t-open", "")]
NOT_TAKING += [{"task": offer["taskId"], "pool": 0, "snapshot": REAL + at}
               for at, seen in enumerate(DAEMON.values()) for offer in seen["offers"]]

OPEN_TASK = [{"pool": pool, "kind": kind, "item": item, "snapshot": at}
             for at in (None, 0, 1)
             for pool, kind, item in (
                 (POOL, "review", "pr-9"), (POOL, "review", "pr-10"), (POOL, "review", "pr-11"),
                 (POOL, "issues", "issue-4"), (POOL, "issues", "pr-9"), (LAB, "review", "pr-9"),
                 ("github.com/O/R", "review", "pr-9"), (POOL, "Review", "pr-9"), ("", "", ""))]
OPEN_TASK += [{"pool": WIDGETS, "kind": "review", "item": "pr-1", "snapshot": REAL + at}
              for at in range(len(DAEMON))]

TROUBLE = [{"answered": answered, "snapshot": at, "unknown": unknown}
           for unknown in ("", "/home/u/.diplomat/config.json")
           for answered in (None, False, True)
           for at in (None, *range(len(SNAPSHOTS)))]

ROOT = {"owner": "o", "repo": "r", "path": "/src/r", "host": "github.com"}
API = {"owner": "platform", "repo": "api", "path": "/src/api", "host": "gitlab.acme.example"}
TOOL = {"owner": "acme", "repo": "tool", "path": "/mnt/tool", "host": "github.com"}
TWIN = {"owner": "O", "repo": "R", "path": "/src/r-again", "host": "github.com"}
GROUPED = {"owner": "group/sub", "repo": "r", "path": "/src/g", "host": "gitlab.com"}
GHE = {"owner": "o", "repo": "r", "path": "/src/ghe", "host": "acme.ghe.com"}
SUB = {"owner": "g/sub", "repo": "p", "path": "/src/sub", "host": "gitlab.github.com"}
PORTED = {**API, "path": "/src/api-8443", "web_port": 8443}
BOTH = {"github.com": "octocat", "gitlab.acme.example": "ilatka", "gitlab.com": "ila",
        "acme.ghe.com": "octocat"}

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
        ([ROOT, GHE], [SUB, GHE, API], [], BOTH),
        ([ROOT, PORTED], [], [], BOTH),
        ([PORTED], [API], [], BOTH),
        ([GHE], [SUB], ["/src/ghe"], {}),
    )]

PAYLOAD = {"hours": HOURS, "remotes": REMOTES, "rules": RULES, "kinds": KINDS,
           "gitlabHosts": HOSTED, "hostedRemotes": HOSTED_REMOTES,
           "offers": OFFERS, "snapshots": SNAPSHOTS, "openTask": OPEN_TASK,
           "trouble": TROUBLE, "notTaking": NOT_TAKING, "listing": LISTING, "times": TIMES}


def _python() -> dict:
    snapshots = [N.Snapshot.parse(json.dumps(s)) for s in SNAPSHOTS]

    def snapshot(row: dict) -> N.Snapshot | None:
        return None if row["snapshot"] is None else snapshots[row["snapshot"]]

    def pool(url: str, hosts: dict[str, str] = {}) -> str | None:
        at = localrepos.parse_remote(url, hosts)
        if at is None or localrepos.web_port(url) is not None:
            return None
        return N.pool_for(LocalRepo(owner=at[1], repo=at[2], path="", host=at[0]).key)

    def listing(row: dict) -> dict:
        seen = snapshot(row)
        pools, unconfirmed = N.pools_listing(
            [LocalRepo(**r) for r in row["roots"]], [LocalRepo(**r) for r in row["others"]],
            row["unread"], row["identities"], seen.pools if seen else [])
        return {"pools": pools, "unconfirmed": unconfirmed}

    def offer(row: dict) -> dict | str:
        made = N.offer_for(row["verb"], row["ownPR"], row["number"], row["repoKey"],
                           row["label"], row["prompt"],
                           autofix.SOURCE_PANEL if row["panel"] else autofix.SOURCE_AUTO,
                           row["forced"])
        return made if isinstance(made, str) else made.body

    def not_taking(row: dict) -> str:
        seen = snapshot(row)
        return N.not_taking(row["task"], seen.pools[row["pool"]], seen) if seen else ""

    return {
        "hours": [N.hours(v) for v in HOURS],
        "pools": [pool(url) for url in REMOTES],
        "hostedPools": [pool(url, {**localrepos.GITLAB_HOSTS, **HOSTED})
                        for url in HOSTED_REMOTES],
        "rules": [N.has_rules(host) for host in RULES],
        "offers": [offer(row) for row in OFFERS],
        "notTaking": [not_taking(row) for row in NOT_TAKING],
        "kinds": [N.kind_for(k["verb"], k["ownPR"]) for k in KINDS],
        "openTask": [N.open_task(r["pool"], r["kind"], r["item"], snapshot(r))
                     for r in OPEN_TASK],
        "trouble": [N.trouble(r["answered"], snapshot(r), r["unknown"] and N.unknown_note(
            N.settings_unknown(r["unknown"]))) for r in TROUBLE],
        "listing": [listing(r) for r in LISTING],
        "testSettings": [seen.test_settings_note for seen in snapshots],
        "times": [N.local_times(sentence) for sentence in TIMES],
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
    ("hours", HOURS), ("pools", REMOTES), ("hostedPools", HOSTED_REMOTES),
    ("rules", RULES), ("kinds", KINDS),
    ("offers", OFFERS), ("openTask", OPEN_TASK), ("trouble", TROUBLE),
    ("notTaking", NOT_TAKING), ("listing", LISTING), ("times", TIMES),
    ("testSettings", SNAPSHOTS)])
def test_the_twins_agree(twins, member, rows):
    swift, python = twins
    assert _differing(rows, swift[member], python[member]) == []


def test_the_fixture_reaches_what_it_claims_to(twins):
    """Agreement on a fixture that only ever reaches the defaults proves nothing."""
    _, python = twins
    assert len(HOURS) == 75 and len(REMOTES) == 82
    hosted = dict(zip(HOSTED_REMOTES, python["hostedPools"]))
    assert hosted["git@ssh.git.example.org:o/r.git"] == "git.example.org/o/r", "an ssh_host"
    assert hosted["https://git.example.org/o/r.git"] == "git.example.org/o/r"
    assert dict(zip(REMOTES, python["pools"]))["https://git.example.org/o/r.git"] is None
    assert hosted["https://code.acme.example:8443/p/api.git"] is None, "another port"
    by_remote = dict(zip(REMOTES, python["pools"]))
    assert [by_remote[url] for url in OTHER_PORT] == [None] * len(OTHER_PORT)
    assert [by_remote[url] for url in (
        "https://github.com:443/o/r.git", "https://github.com:0443/o/r",
        "http://github.com:80/o/r", "ssh://git@github.com:22/o/r.git",
        "git://github.com:9418/o/r.git")] == [POOL] * 5
    assert by_remote["ssh://git@gitlab.acme.example:2222/p/api.git"] == "gitlab.acme.example/p/api"
    assert hosted["https://other.example.org/o/r.git"] is None
    assert hosted["https://github.com/o/r"] == POOL, "GitHub, whatever glab lists"
    assert len(set(python["hostedPools"])) > len(set(python["pools"])) + 3
    assert {12, 13, 14, 24, 25, 36, 48, 101, 720} <= set(python["hours"])
    pools = set(python["pools"])
    assert {None, POOL, "github.com/owner/repo", "gitlab.com/group/sub/r", LAB} <= pools
    assert set(python["kinds"]) == {None, "review", "review-own", "conflicts", "issues",
                                    "audit", "investigate"}
    assert {None, "t-open", "t-issue", "t-lab", f"{WIDGETS}#review:pr-1@ra",
            f"{WIDGETS}#review:pr-1@rs", f"{WIDGETS}#review:pr-1@rl"} == set(python["openTask"])
    assert "" in python["trouble"] and len(set(python["trouble"])) >= 7
    assert python["trouble"].count(
        "Diplomacy Network: /home/u/.diplomat/config.json cannot be read as settings: "
        "until it can be, this machine's pools stay as the daemon has them and nothing "
        "is offered") == len(TROUBLE) // 2
    tested = "The daemon runs with settings only a test gives it, and is not one for the network: "
    assert set(python["testSettings"]) == {
        "", tested + "DN_LEASE_SECS=60, DN_TRANSPORT=loop", tested + "DN_TRANSPORT=loop"}
    assert any(row["unconfirmed"] for row in python["listing"])
    assert any(len(row["pools"]) >= 3 for row in python["listing"])
    ported = [row for row, asked in zip(python["listing"], LISTING) if PORTED in asked["roots"]]
    assert len(ported) == 6 and all(
        any("is reached on port 8443 of gitlab.acme.example" in line
            for line in row["unconfirmed"]) == (API not in asked["others"])
        for row, asked in zip(ported, [a for a in LISTING if PORTED in a["roots"]]))
    assert all(LAB not in [p["id"] for p in row["pools"]] for row in ported[0::2]), (
        "not the pool the daemon had either")
    assert python["rules"].count(False) >= 10 and python["rules"].count(True) >= 15
    assert sum("has no rules for" in " ".join(row["unconfirmed"])
               for row in python["listing"]) == 6
    refusals = {row for row in python["offers"] if isinstance(row, str)}
    assert {"the network has no rules for a repository on acme.ghe.com",
            "the network has no rules for a repository on gitlab.ghe.com",
            "the network has no rules for a repository on www.github.com",
            "the network runs no nudge jobs", "no repository to offer it into"} == refusals
    assert any(isinstance(row, dict) and row["pool"] == "github.mycorp.com/o/r"
               for row in python["offers"])
    left = DAEMON["left-until"]["offers"][0]["notTaking"]
    assert left.startswith(LEFT + "2026-") and left.endswith("Z")
    assert set(python["notTaking"]) == {"", DOWN, SHORT, TOO_LONG, N.local_times(left)}
    assert N.local_times(left) != left


def test_a_time_the_daemon_wrote_reads_by_this_machines_clock_on_both(kolkata):
    """The table above agrees in whatever zone the suite runs in, UTC among them."""
    proc = subprocess.run([CORE_BIN, "network"], input=json.dumps({"times": TIMES}).encode(),
                          capture_output=True, timeout=60, check=False)
    assert proc.returncode == 0, proc.stderr.decode("utf-8", "replace")
    swift = json.loads(proc.stdout)["times"]
    assert swift == [N.local_times(sentence) for sentence in TIMES]
    assert swift[:3] == [LEFT + "16:00", LEFT + "00:15", "from 05:30 to 06:30, twice"]
    plain = len(TIMES) - len(EDGE)
    assert swift[plain - 1] == "16:0016:01" and swift[3:plain - 1] == TIMES[3:plain - 1]
    assert swift[plain:] == ["until 05:29", "until 05:29", "until 05:53", EDGE[3]]


@pytest.fixture(scope="module")
def daemon_answers() -> dict:
    """The daemon's own ``githubApi``, ``hoursOf`` and ``remoteSlug`` over the fixture's
    hosts, hours and remotes, each value as its JSON reaches them from the config."""
    node, src = shutil.which("node"), Path(__file__).resolve().parents[3] / "diplomacy-network" / "src"
    if node is None:
        pytest.skip("node is not on PATH: the daemon's own functions are not run")
    if not (src / "requester" / "rules.js").is_file():
        pytest.skip(f"the daemon package is not at {src.parent}")
    script = (
        "import { readFileSync } from 'node:fs';\n"
        f"import {{ githubApi }} from {json.dumps((src / 'requester' / 'rules.js').as_uri())};\n"
        f"import {{ hoursOf }} from {json.dumps((src / 'node' / 'gossip.js').as_uri())};\n"
        f"import {{ remoteSlug }} from {json.dumps((src / 'executor' / 'mirror.js').as_uri())};\n"
        "const asked = JSON.parse(readFileSync(0, 'utf8'));\n"
        "console.log(JSON.stringify({ rules: asked.rules.map((host) => githubApi(host) !== null),"
        " hours: asked.hours.map(hoursOf), slugs: asked.remotes.map(remoteSlug) }));\n")
    proc = subprocess.run([node, "--input-type=module", "-e", script],
                          input=json.dumps({"rules": RULES, "hours": HOURS, "remotes": REMOTES}).encode("utf-8"),
                          capture_output=True, timeout=60, check=False)
    assert proc.returncode == 0, proc.stderr.decode("utf-8", "replace")
    return json.loads(proc.stdout)


@pytest.mark.parametrize("member, rows", [("rules", RULES), ("hours", HOURS)])
def test_each_twin_answers_as_the_daemons_own_function_does(twins, daemon_answers, member, rows):
    swift, python = twins
    assert _differing(rows, daemon_answers[member], python[member]) == []
    assert _differing(rows, daemon_answers[member], swift[member]) == []


def test_a_remote_the_twins_make_a_pool_of_is_the_one_the_daemon_names(twins, daemon_answers):
    """The daemon names a checkout's repository by ``remoteSlug``: no pool either twin
    makes of a remote is another, and a remote on a port the forge's API is not on
    names none there either."""
    named = dict(zip(REMOTES, daemon_answers["slugs"]))
    # No forge hosts a repository named `.git`, which the daemon reads as no name.
    nameless = {"https://github.com/o/.git": ("github.com/o/.git", "github.com/o/"),
                "https://gitlab.com/o/.git": ("gitlab.com/o/.git", "gitlab.com/o/")}
    for twin in twins:
        assert {url: (pool, named[url]) for url, pool in zip(REMOTES, twin["pools"])
                if pool is not None and pool != named[url]} == nameless
    assert [named[url] for url in OTHER_PORT] == [None] * len(OTHER_PORT)
    assert named["ssh://git@gitlab.acme.example:2222/p/api.git"] == "gitlab.acme.example/p/api"
