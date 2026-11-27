"""The Diplomacy Network in the applet: what each cycle tells the daemon, the gate that
offers a job instead of spawning it, and the runs the network carries. Against a fake
daemon (a real HTTP server on a unix socket) and the spawn seam, which nothing here may
reach.
"""

from __future__ import annotations

import dataclasses
import json
import os
import shutil
import socketserver
import subprocess
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler
from types import SimpleNamespace

import pytest
from PySide6.QtCore import Qt

from diplomat_runtime import (
    activity,
    agentregistry,
    agentstate,
    appconfig,
    atomicjson,
    autofix,
    localrepos,
    network,
    review,
    telemetry,
)
from diplomat_runtime.prref import LocalRepo
from diplomat_runtime.prtarget import PRTarget
from diplomat_app import audit, deviceallocator as da, issues
from diplomat_app import diplomacynetwork as dn
from diplomat_app import probes, procscan
from diplomat_app.store import PIPELINE_COUNTER
from test_autofix import (  # noqa: F401 - fixtures
    ROOT,
    _fixture_root,
    _job,
    _req,
    _spawn_recorder,
    fake_probes,
    store,
)
from test_requested_work import _poll, _sweep, swept_store  # noqa: F401 - fixture

ME, PEER = "4be07d21c9aa", "9f3c1a7755e0"
POOL = "github.com/o/r"
LAB = LocalRepo("group/sub", "tool", "/src/tool", host="gitlab.example.com")


class FakeDaemon:
    """The daemon's local socket: ``GET /state`` answers ``state`` (None: a 503), every
    other route answers from ``routes`` (a ``(status, body)`` or a function of the
    request body giving one; unlisted, ``200 {}``), and ``got`` is every request, in
    order."""

    def __init__(self, routes=None, state=None):
        self.dir = tempfile.mkdtemp(prefix="dn.", dir="/tmp")
        self.path = os.path.join(self.dir, "daemon.sock")
        self.routes = dict(routes or {})
        self.state = snapshot() if state is None else state
        self.got: list[tuple[str, str, object]] = []
        fake = self

        class Handler(BaseHTTPRequestHandler):
            def _answer(self, status, answer):
                data = json.dumps(answer).encode()
                self.send_response(status)
                self.send_header("content-length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def do_GET(self):  # noqa: N802
                fake.got.append(("GET", self.path, None))
                if self.path == "/state" and fake.state is not None:
                    return self._answer(200, fake.state)
                self._answer(503, {"error": "The daemon is starting."})

            def do_POST(self):  # noqa: N802
                body = json.loads(self.rfile.read(int(self.headers["content-length"])))
                fake.got.append(("POST", self.path, body))
                route = fake.routes.get(self.path, (200, {}))
                self._answer(*(route(body) if callable(route) else route))

            def log_message(self, *args):
                pass

        class Server(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
            daemon_threads = True

        self.server = Server(self.path, Handler)
        threading.Thread(target=self.server.serve_forever, args=(0.01,), daemon=True).start()

    def sent(self, route: str) -> list:
        return [body for method, path, body in self.got
                if method == "POST" and path == f"/{route}"]

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        shutil.rmtree(self.dir, ignore_errors=True)


def snapshot(offers=(), runs=(), pools=(), admit=None) -> dict:
    return {"updatedAt": time.time(), "daemon": {"pid": 7, "startedAt": 1_793_990_000.0},
            "identity": {"pk": ME, "onion": "x.onion"},
            "transport": {"state": "ready"}, "docker": {"state": "ready"},
            "model": {"state": "ready"}, "admit": admit or {"slots": 0},
            "pools": list(pools), "runs": list(runs), "offers": list(offers)}


def offer(task="t1", state="pooled", **extra) -> dict:
    return {"taskId": task, "state": state, **extra}


def daemon_row(task="t1", state="pooled", *, executor="", outcome=None, reason="",
               kind="review", item="pr-9") -> dict:
    """An offer with every member the daemon gives it (``rows()`` in its
    ``src/node/offers.js``)."""
    now = int(time.time())
    ended = state in (agentstate.NET_DONE, agentstate.NET_FAILED, agentstate.NET_CANCELLED)
    return {"taskId": task, "pool": POOL, "kind": kind, "item": item,
            "title": "Review · #9", "state": state, "executor": executor,
            "executorHere": executor == ME, "attempt": 1, "requests": 0, "refused": 0,
            "outcome": outcome, "reason": reason, "offeredAt": now - 60,
            "endedAt": now if ended else 0}


def spent(ok=True, tokens=500) -> dict:
    return {"ok": ok, "summary": "reviewed", "usd": 0.42, "tokens": tokens,
            "runner": "claude", "model": "opus"}


@pytest.fixture
def daemon(monkeypatch):
    made = []

    def make(routes=None, state=None) -> FakeDaemon:
        d = FakeDaemon(routes, state)
        monkeypatch.setenv("DN_BASE_DIR", d.dir)
        made.append(d)
        return d

    yield make
    for d in made:
        d.close()


@pytest.fixture
def on(monkeypatch):
    appconfig.set_bool(network.ENABLED_KEY, True)
    monkeypatch.setattr(review, "roots_guessed", lambda: False)
    monkeypatch.setattr(review, "roots_complete", lambda: True)
    monkeypatch.setattr(review, "roots_linking", lambda: (review.repo_roots(), []))
    monkeypatch.setattr("diplomat_app.bans.read", lambda: [])


def takes_offers(task="t1"):
    return {"/offer": (200, {"taskId": task})}


def job(number=9, **fields) -> autofix.AgentJob:
    """A review-monitor find: automatic, so a refusal queues it."""
    return dataclasses.replace(
        _job(number, counter="review_requests", action="review-req"), **fields)


def merged(store, *numbers) -> None:
    store._merged_prs = agentstate.Observation.present({f"o/r#{n}" for n in numbers})


def lines(action: str) -> list[str]:
    return [e.detail for e in activity.read() if e.action == action]


def ledger() -> list[dict]:
    return [json.loads(line) for line in telemetry.read_lines()]


def rows(store) -> list[tuple[str, str]]:
    return [(a.state, a.reason) for a in store.running_tasks]


def book_network_run(task="t1", number=9, *, age=0.0, ledger_key="", source=autofix.SOURCE_AUTO):
    now = time.time() - age
    return agentregistry.create_run(agentstate.RunRecord(
        run_id=agentregistry.new_run_id(now), dispatched_at=now, pr_number=number,
        pr_url=f"https://github.com/o/r/pull/{number}", kind="review",
        label=f"Auto · Review · #{number}", source=source, ledger_key=ledger_key,
        network=task), "P")


# MARK: - the cycle: pools

GH = {"id": POOL, "path": "/src/r", "forge": "github", "identity": "alice"}
LAB_POOL = {"id": "gitlab.example.com/group/sub/tool", "path": "/src/tool", "forge": "gitlab",
            "identity": "bob"}
TOOL = LocalRepo("acme", "tool", "/src/tool")
TOOL_POOL = {"id": "github.com/acme/tool", "path": "/src/tool", "forge": "github",
             "identity": "alice"}


def has_pools(*pools) -> dict:
    return snapshot(pools=[{"id": i, "path": path, "identity": who} for i, path, who in pools])


def test_a_repository_with_no_login_holds_back_its_own_pool_alone(store, on, daemon,
                                                                  monkeypatch):
    d = daemon()
    asked = []

    def login(host=None):
        asked.append(host)
        raise RuntimeError("glab is not signed in")

    monkeypatch.setattr("diplomat_app.store.API.fetch_viewer_login", login)
    monkeypatch.setattr(localrepos, "resolve",
                        lambda paths: [localrepos.Checkout("/src/tool", (LAB,))])

    store._network_cycle_once(1000.0)
    store._network_cycle_once(1030.0)
    assert d.sent("pools") == [{"pools": [GH]}], "the rest is said, once"
    assert store.network_pools_held == (
        "The login for group/sub/tool on gitlab.example.com is not known yet: its pool "
        "stays as the daemon last had it until it is")
    assert asked == ["gitlab.example.com"], "an unknown login is not asked for on every cycle"
    assert len(d.sent("admit")) == 1

    d.state = has_pools((POOL, "/src/r", "alice"), (LAB_POOL["id"], "/src/tool", "bob"))
    store._network_cycle_once(1035.0)
    assert d.sent("pools")[1:] == [{"pools": [GH, LAB_POOL]}], "as the daemon had it"

    store._gitlab_me[LAB.host] = ("Bob", localrepos.glab_host_entry(LAB.host))
    store._network_cycle_once(1040.0)
    store._network_cycle_once(1050.0)
    assert len(d.sent("pools")) == 2, "and is said again only when it changed"
    assert store.network_pools_held == ""


def test_an_unread_root_keeps_its_pool_and_holds_nothing_else_back(store, on, daemon,
                                                                   monkeypatch):
    d = daemon(state=has_pools((POOL, "/src/r", "alice"),
                               ("github.com/o/gone", "/mnt/gone", "alice")))
    monkeypatch.setattr(review, "roots_linking", lambda: ([], ["/src/r"]))
    monkeypatch.setattr(localrepos, "resolve",
                        lambda paths: [localrepos.Checkout("/src/tool", (TOOL,))])
    changed = []
    store.network_changed.connect(lambda: changed.append(store.network_pools_held))
    store._network_cycle()
    assert d.sent("pools") == [{"pools": [TOOL_POOL, GH]}], (
        "a repository linked since gains its pool, one taken out of Settings leaves its own")
    why = ("/src/r cannot be read: its pool stays as the daemon last had it until the path "
           "can be read or is taken out of Settings")
    assert store.network_pools_held == why and why in changed, "and the screen is told"
    assert lines("network-leave") == [
        "Left github.com/o/gone: /mnt/gone is no longer listed in Settings"]
    assert len(d.sent("admit")) == 1


def test_an_unknown_github_login_keeps_the_pools_the_daemon_had(store, on, daemon):
    d = daemon(state=has_pools((POOL, "/src/r", "alice")))
    store.me = ""
    store._network_cycle()
    assert d.sent("pools") == [{"pools": [GH]}]
    assert store.network_pools_held == network.unconfirmed_account("o/r", "github.com")


def test_a_repository_on_a_host_without_rules_has_no_pool_and_none_of_its_jobs_is_offered(
        store, on, daemon, monkeypatch):
    d = daemon(takes_offers())
    calls = _spawn_recorder(monkeypatch)
    cloud = LocalRepo("acme", "cloud", "/src/cloud", host="acme.ghe.com")
    monkeypatch.setattr(localrepos, "resolve",
                        lambda paths: [localrepos.Checkout("/src/cloud", (cloud,))])
    store._gitlab_me[cloud.host] = ("Bob", localrepos.glab_host_entry(cloud.host))
    changed = []
    store.network_changed.connect(lambda: changed.append(store.network_pools_held))
    store._network_cycle()
    why = ("acme/cloud is on acme.ghe.com, which the Diplomacy Network has no rules for: "
           "it has no pool and none of its jobs is offered")
    assert d.sent("pools") == [{"pools": [GH]}]
    assert store.network_pools_held == why and why in changed

    there = autofix.AgentJob(kind="audit", audit_action="audit", label="Audit", prompt="A",
                             checkout="/src/cloud")
    assert store.dispatch_agent(there, autofix.SOURCE_PANEL).sentence == (
        "the network has no rules for a repository on acme.ghe.com")
    assert d.sent("offer") == [] and calls == []


def test_a_list_the_daemon_refuses_is_said_once_and_not_sent_again_as_it_is(
        store, on, daemon, monkeypatch):
    d = daemon({"/pools": (409, {"error": '"x" is not a pool id.'})})
    for at in (1000.0, 1001.0, 1002.0):
        store._network_cycle_once(at)
    why = 'The daemon refused this machine\'s pools: "x" is not a pool id.'
    assert len(d.sent("pools")) == 1
    assert store.network_pools_held == why and lines("network-unavailable") == [why]

    d.routes["/pools"] = (409, {"error": "A pool is listed twice."})
    monkeypatch.setattr(localrepos, "resolve",
                        lambda paths: [localrepos.Checkout("/src/tool", (TOOL,))])
    store._network_cycle_once(1003.0)
    assert d.sent("pools")[1:] == [{"pools": [GH, TOOL_POOL]}], "a list that changed is sent"
    assert store.network_pools_held == (
        "The daemon refused this machine's pools: A pool is listed twice.")
    assert len(lines("network-unavailable")) == 2, "and another refusal is said"

    d.routes["/pools"] = (200, {"ok": True})
    store._network_cycle_once(1063.0)
    assert len(d.sent("pools")) == 3 and store.network_pools_held == "", (
        "taken, it clears the line")


def test_a_refusal_is_moot_once_the_list_is_the_one_the_daemon_took(store, on, daemon,
                                                                    monkeypatch):
    d = daemon()
    store._network_cycle_once(1000.0)
    d.routes["/pools"] = (409, {"error": "A pool is listed twice."})
    monkeypatch.setattr(localrepos, "resolve",
                        lambda paths: [localrepos.Checkout("/src/tool", (TOOL,))])
    store._network_cycle_once(1001.0)
    assert store.network_pools_held != ""
    monkeypatch.setattr(localrepos, "resolve", lambda paths: [])
    store._network_cycle_once(1002.0)
    assert len(d.sent("pools")) == 2 and store.network_pools_held == ""


def test_a_list_the_daemon_did_not_settle_is_sent_again(store, on, daemon):
    d = daemon({"/pools": (500, {})})
    store._network_cycle_once(1000.0)
    store._network_cycle_once(1001.0)
    assert len(d.sent("pools")) == 2
    assert store.network_pools_held == "" and lines("network-unavailable") == []


REAL_LINKING = review.roots_linking


@pytest.fixture
def root_paths(monkeypatch):
    """The roots read for real, from the list returned."""
    paths: list[str] = []
    monkeypatch.setattr(review, "repo_root_paths", lambda: paths)
    monkeypatch.setattr(review, "_roots_cache", None)
    monkeypatch.setattr(review, "roots_linking", REAL_LINKING)
    return paths


def test_a_root_that_names_no_forge_is_skipped_and_holds_nothing_back(
        store, on, daemon, root_paths, tmp_path):
    folder = tmp_path / "notes"
    folder.mkdir()
    root_paths += [_checkout(tmp_path / "r", "https://github.com/o/r.git"),
                   _checkout(tmp_path / "bucket", "https://bitbucket.org/acme/x.git"),
                   _checkout(tmp_path / "bare"), str(folder)]
    d = daemon()
    store._network_cycle()
    assert d.sent("pools") == [{"pools": [
        {"id": POOL, "path": root_paths[0], "forge": "github", "identity": "alice"}]}]
    assert store.network_pools_held == ""


def test_a_lone_root_that_names_no_forge_is_no_pool(store, on, daemon, root_paths, tmp_path):
    root_paths.append(_checkout(tmp_path / "bucket", "https://bitbucket.org/acme/x.git"))
    d = daemon(state=has_pools((POOL, root_paths[0], "alice")))
    store._network_cycle()
    assert d.sent("pools") == [{"pools": []}], (
        "the root that stands in for the configured repo is not one its path names")
    assert store.network_pools_held == ""
    assert lines("network-leave") == [f"Left {POOL}: {root_paths[0]} no longer names it"]


def test_a_missing_root_is_unread_and_keeps_the_pool_the_daemon_had(
        store, on, daemon, root_paths, tmp_path):
    gone = str(tmp_path / "unmounted" / "r")
    root_paths += [gone, _checkout(tmp_path / "other", "https://github.com/o/other.git")]
    d = daemon(state=has_pools((POOL, gone, "alice")))
    store._network_cycle()
    assert d.sent("pools") == [{"pools": [
        {"id": "github.com/o/other", "path": root_paths[1], "forge": "github",
         "identity": "alice"},
        {"id": POOL, "path": gone, "forge": "github", "identity": "alice"}]}]
    assert store.network_pools_held == network.unconfirmed_unread(gone)


def test_a_root_git_fails_on_is_unread(store, on, daemon, root_paths, tmp_path):
    broken = tmp_path / "broken"
    (broken / ".git").mkdir(parents=True)
    root_paths.append(str(broken))
    d = daemon(state=has_pools((POOL, str(broken), "alice")))
    store._network_cycle()
    assert d.sent("pools") == [{"pools": [
        {"id": POOL, "path": str(broken), "forge": "github", "identity": "alice"}]}]
    assert store.network_pools_held == network.unconfirmed_unread(str(broken))


def _checkout(path, remote="") -> str:
    subprocess.run(["git", "init", "-q", str(path)], check=True)
    if remote:
        subprocess.run(["git", "-C", str(path), "remote", "add", "origin", remote], check=True)
    return str(path)


def test_an_unread_checkout_keeps_its_pool_until_it_is_read_or_taken_out(
        store, on, daemon, tmp_path):
    d = daemon()
    gone, bare = tmp_path / "unmounted" / "tool", _checkout(tmp_path / "scratch")
    store.other_repo_paths = [str(gone), bare]
    store._network_cycle_once(1000.0)
    store._network_cycle_once(1001.0)
    assert d.sent("pools") == [{"pools": [GH]}], "the daemon had no pool behind it"
    assert store.network_pools_held == network.unconfirmed_unread(str(gone))

    _checkout(gone, "https://github.com/acme/tool.git")
    store._network_cycle_once(1002.0)
    tool = {"id": "github.com/acme/tool", "path": str(gone), "forge": "github",
            "identity": "alice"}
    assert d.sent("pools")[1:] == [{"pools": [GH, tool]}], (
        "read again on the next cycle, with no restart")
    assert store.network_pools_held == ""
    assert [c.read for c in store.local_checkouts] == [True, True]

    # Gone again after its pool was said: the pool stays as the daemon has it.
    shutil.rmtree(gone)
    d.state = has_pools((POOL, "/src/r", "alice"), ("github.com/acme/tool", str(gone), "alice"))
    store._network_cycle_once(1003.0)
    assert len(d.sent("pools")) == 2, "the same list is not said again"
    assert store.network_pools_held == network.unconfirmed_unread(str(gone))

    # Taken out of Settings it holds nothing: its pool is left, and the feed says so.
    store.other_repo_paths = [bare]
    store._network_cycle_once(1004.0)
    assert d.sent("pools")[2:] == [{"pools": [GH]}] and store.network_pools_held == ""
    assert lines("network-leave") == [
        f"Left github.com/acme/tool: {gone} is no longer listed in Settings"]


def test_a_pool_whose_path_names_it_no_more_is_left_and_said(store, on, daemon, tmp_path):
    mirror = _checkout(tmp_path / "mirror", "https://code.example.org/acme/mirror.git")
    d = daemon(state=has_pools((POOL, "/src/r", "alice"),
                               ("code.example.org/acme/mirror", mirror, "alice")))
    store.other_repo_paths = [mirror]
    store._network_cycle()
    assert d.sent("pools") == [{"pools": [GH]}]
    assert lines("network-leave") == [
        f"Left code.example.org/acme/mirror: {mirror} no longer names it"]


def test_a_checkout_with_no_forge_remote_is_left_out_and_holds_nothing_back(
        store, on, daemon, tmp_path):
    d = daemon()
    bare = _checkout(tmp_path / "scratch")
    folder = tmp_path / "notes"
    folder.mkdir()
    elsewhere = _checkout(tmp_path / "mirror", "https://example.org/acme/mirror.git")
    store.other_repo_paths = [bare, str(folder), elsewhere]
    store._network_cycle_once(1000.0)
    assert d.sent("pools") == [{"pools": [
        {"id": POOL, "path": "/src/r", "forge": "github", "identity": "alice"}]}]
    assert store.network_pools_held == ""

    subprocess.run(["git", "-C", bare, "remote", "add", "origin",
                    "git@github.com:acme/scratch.git"], check=True)
    store._network_cycle_once(1001.0)
    assert [p["id"] for p in d.sent("pools")[-1]["pools"]] == [POOL, "github.com/acme/scratch"], (
        "a remote added since is read on the next cycle")


def test_a_checkout_git_fails_on_is_unread_not_empty(tmp_path):
    broken = tmp_path / "broken"
    (broken / ".git").mkdir(parents=True)
    assert localrepos.checkout_remotes(str(broken)) is None
    assert localrepos.inspect(str(broken)) == localrepos.Checkout(str(broken), (), read=False)
    assert localrepos.checkout_remotes(str(tmp_path / "nowhere")) is None
    assert localrepos.checkout_remotes(str(tmp_path)) == ""
    assert localrepos.checkout_remotes(_checkout(tmp_path / "bare")) == ""


def test_no_linked_repository_is_an_empty_list_once_the_roots_are_resolved(
        store, on, daemon, monkeypatch):
    d = daemon()
    monkeypatch.setattr(review, "roots_linking", lambda: ([], []))
    store._network_cycle()
    assert d.sent("pools") == [{"pools": []}]


def test_the_github_login_is_ghs_own_not_the_username_override(store, on, daemon):
    d = daemon()
    store.username_override = "someone-else"
    store._network_cycle()
    assert [p["identity"] for p in d.sent("pools")[0]["pools"]] == ["alice"]


# MARK: - the cycle: admit

def test_the_admit_is_said_when_it_changes_and_once_a_minute(store, on, daemon, monkeypatch):
    d = daemon()
    store.auto_task_limit = 3
    store._network_cycle_once(1000.0)
    store._network_cycle_once(1059.0)
    assert d.sent("admit") == [{"slots": 3}], "unchanged, and said under a minute ago"
    store._network_cycle_once(1060.0)
    assert d.sent("admit") == [{"slots": 3}] * 2, "the daemon lets it go stale"

    # One container this machine runs for the network, and one agent in a terminal.
    d.state = snapshot(runs=[{"runId": "r1", "taskId": "tx", "state": "running"},
                             {"runId": "r0", "taskId": "ty", "state": "finished"}])
    local = agentregistry.create_run(agentstate.RunRecord(
        run_id="local-1", dispatched_at=time.time(), pr_number=4,
        pr_url="https://github.com/o/r/pull/4", kind="review",
        source=autofix.SOURCE_AUTO, pid=4242, tty="pts/4"), "P")
    fake_probes(monkeypatch, processes={local.pid: agentstate.ProcInfo(
        tty="pts/4", elapsed=5.0, is_agent=True)})
    store._network_cycle_once(1061.0)
    assert d.sent("admit")[-1] == {"slots": 1}

    store.queue_auto_run = False
    store._network_cycle_once(1062.0)
    assert d.sent("admit")[-1] == {"slots": 0, "reason": "paused"}

    monkeypatch.setattr("diplomat_app.store.autobudget.enabled", lambda: True)
    monkeypatch.setattr("diplomat_app.store.autobudget.decide",
                        lambda: autofix.Budget(affordable=False))
    store._network_cycle_once(1063.0)
    assert d.sent("admit")[-1] == {"slots": 0, "reason": "budget"}

    monkeypatch.setattr("diplomat_app.store.diskfloor.lowest",
                        lambda paths: SimpleNamespace(low=True))
    store._network_cycle_once(1064.0)
    assert d.sent("admit")[-1] == {"slots": 0, "reason": "disk"}
    assert len(d.sent("admit")) == 6 and len(d.sent("pools")) == 1


def test_the_admit_leaves_out_the_bays_ratings_hold(store, on, daemon):
    from diplomat_app.store import RatingJob

    d = daemon()
    store.auto_task_limit = 3
    url = "https://github.com/o/r/pull/7"
    store._ratings = {url: RatingJob(url=url, stamp="1", label="Rating · #7", started_at=0.0,
                                     forced=False)}
    store._network_cycle_once(1000.0)
    assert d.sent("admit") == [{"slots": 2}]


def test_a_daemon_that_started_since_is_told_both_again(store, on, daemon):
    d = daemon()
    store._network_cycle_once(1000.0)
    store._network_cycle_once(1010.0)
    assert (len(d.sent("pools")), len(d.sent("admit"))) == (1, 1)
    d.state = {**snapshot(), "daemon": {"pid": 8, "startedAt": 1_794_000_000.0}}
    store._network_cycle_once(1020.0)
    assert (len(d.sent("pools")), len(d.sent("admit"))) == (2, 2)


def test_a_post_the_daemon_refused_is_made_again(store, on, daemon):
    d = daemon({"/admit": (400, {"error": "slots must be a whole number."}),
                "/pools": (400, {"error": "No such checkout."})})
    store._network_cycle_once(1000.0)
    store._network_cycle_once(1001.0)
    assert (len(d.sent("pools")), len(d.sent("admit"))) == (1, 2)
    store._network_cycle_once(1059.0)
    store._network_cycle_once(1060.0)
    assert len(d.sent("pools")) == 2, "a refused list is said again as often as admit is"
    assert len(lines("network-unavailable")) == 1, "and its refusal once"


def test_nothing_asks_the_daemon_with_the_switch_off(store, daemon, monkeypatch):
    d = daemon(takes_offers())
    calls = _spawn_recorder(monkeypatch)
    store._network_cycle()
    store.run_network_cycle_async()
    store.start_network_async()
    assert store.wait_for_background() == []
    assert store.dispatch_agent(job(), autofix.SOURCE_AUTO) == "spawned"
    store._settle_agents()
    assert d.got == []
    assert len(calls) == 1
    assert [r.network for r in agentregistry.load()] == [None]
    assert store.network_state is None and store.network_answered is None


def switch_off_while_asked(monkeypatch) -> None:
    state = dn.state

    def asked():
        snap = state()
        appconfig.set_bool(network.ENABLED_KEY, False)
        return snap

    monkeypatch.setattr(dn, "state", asked)


def test_a_cycle_the_switch_went_off_under_says_nothing_to_the_daemon(
        store, on, daemon, monkeypatch):
    d = daemon()
    switch_off_while_asked(monkeypatch)
    store._network_cycle()
    assert [path for _, path, _ in d.got] == ["/state"]
    assert store.network_state is None and store.network_answered is None


def test_a_settle_the_switch_went_off_under_keeps_nothing_the_daemon_said(
        store, on, daemon, monkeypatch):
    daemon(state=snapshot(offers=[daemon_row("t1", agentstate.NET_CLAIMED, executor=PEER)]))
    book_network_run("t1", 9)
    switch_off_while_asked(monkeypatch)
    store._settle_agents()
    assert store.network_state is None and store.network_answered is None
    assert lines("network-claimed") == []


def test_with_the_switch_off_the_evidence_says_so(store, daemon):
    seen = store._network_evidence(network.Snapshot.from_json(snapshot(offers=[offer()])))
    assert seen == agentstate.Observation.unavailable("the Diplomacy Network is switched off")


def test_every_settle_asks_the_daemon_and_keeps_what_it_said(store, on, daemon):
    d = daemon()
    told = []
    store.network_changed.connect(lambda: told.append(1))
    store._settle_agents()
    first = len(told)
    d.state = {**d.state, "updatedAt": d.state["updatedAt"] + 5}
    store._settle_agents()
    assert [path for _, path, _ in d.got] == ["/state", "/state"]
    assert store.network_answered is True and store.network_state.pid == 7
    assert len(told) == first, "its clock moving on is no change to redraw for"
    d.state = {**d.state, "admit": {"slots": 4}}
    store._settle_agents()
    assert len(told) == first + 1 and store.network_state.admit.slots == 4
    d.close()
    store._settle_agents()
    assert store.network_answered is False and store.network_state is None
    assert len(told) == first + 2


# MARK: - the daemon's lifecycle

@pytest.fixture
def installer(monkeypatch):
    ran = []

    def run(script, arg):
        ran.append((os.path.basename(script), arg))
        return {"daemonRunning": arg != "--stop-daemon"}

    monkeypatch.setattr(da, "run_installer", run)
    return ran


def test_the_switch_starts_and_stops_the_daemon_off_the_gui_thread(store, daemon, installer,
                                                                   monkeypatch):
    d = daemon()
    monkeypatch.setattr(review, "roots_guessed", lambda: False)
    monkeypatch.setattr(review, "roots_complete", lambda: True)
    threads = []
    real = dn.start_daemon
    monkeypatch.setattr(dn, "start_daemon", lambda: (
        threads.append(threading.current_thread() is threading.main_thread()), real())[1])

    store.set_network_enabled(True)
    assert store.wait_for_background() == []
    assert appconfig.read()[network.ENABLED_KEY] is True
    assert installer == [("install.js", "--start-daemon")] and threads == [False]
    assert store.network_answered is True, "the start takes a first cycle"
    assert lines("network-start") == ["Started the Diplomacy Network daemon (ok: true)"]

    asked = len(d.got)
    store.set_network_enabled(False)
    assert store.wait_for_background() == []
    assert appconfig.read()[network.ENABLED_KEY] is False
    assert installer[-1] == ("install.js", "--stop-daemon")
    assert len(d.got) == asked, "no run of the network's is booked: nothing to take back"
    assert store.network_state is None and store.network_answered is None
    assert lines("network-stop") == ["Stopped the Diplomacy Network daemon (ok: true)"]


LEFT = " the daemon had left in its store"


@pytest.mark.parametrize("answer, note", [
    (None, ""),
    ({}, ""),
    ({"ended": {"offers": 0, "runs": 0}}, ""),
    ({"ended": {"offers": 1, "runs": 0}}, ", cancelling 1 offer" + LEFT),
    ({"ended": {"offers": 2}}, ", cancelling 2 offers" + LEFT),
    ({"ended": {"offers": 0, "runs": 1}}, ", ending 1 run" + LEFT),
    ({"ended": {"runs": 3}}, ", ending 3 runs" + LEFT),
    ({"ended": {"offers": 2, "runs": 1}}, ", cancelling 2 offers and ending 1 run" + LEFT),
    ({"ended": "2"}, ""),
    ({"ended": [2, 1]}, ""),
    ({"ended": {"offers": "2", "runs": True}}, ""),
    ({"ended": {"offers": -1, "runs": 1.5}}, ""),
])
def test_what_a_stop_ended_in_the_store_is_a_note_only_when_it_ended_something(answer, note):
    assert dn.ended_note(answer) == note


@pytest.mark.parametrize("answer, line", [
    ({"ok": True, "daemonRunning": False, "pid": None, "ended": {"offers": 2, "runs": 1}},
     "Stopped the Diplomacy Network daemon (ok: true), cancelling 2 offers and ending 1 run"
     + LEFT),
    ({"ok": False, "daemonRunning": False, "ended": {"offers": 0, "runs": 2},
      "error": "a container is still there"},
     "Stopped the Diplomacy Network daemon (ok: false), ending 2 runs" + LEFT
     + ": a container is still there"),
])
def test_a_stop_with_no_daemon_answering_runs_the_installer_and_says_what_it_ended(
        store, on, monkeypatch, answer, line):
    ran = []
    monkeypatch.setattr(da, "run_installer", lambda script, arg: ran.append(arg) or answer)
    store.set_network_enabled(False)
    assert store.wait_for_background() == []
    assert ran == ["--stop-daemon"]
    assert lines("network-stop") == [line]


#: The installer's answers to a start while the network is off, and to a stop that left
#: records behind.
START_OFF = ("the network is switched off in Diplomat's settings: no daemon was started")
STOP_LEFT = ("/h/.diplomat/network/ca and /h/.diplomat/network/runs could not be removed: "
             "a job left among its records what this user may not delete, and no docker "
             "engine deleted it. The next --stop-daemon tries again.")


@pytest.mark.parametrize("restart, did", [(False, "Started"), (True, "Restarted")])
def test_a_start_the_installer_refuses_with_the_network_off_says_its_sentence(
        store, on, daemon, monkeypatch, restart, did):
    daemon()
    monkeypatch.setattr(da, "run_installer", lambda script, arg: {
        "ok": False, "daemonRunning": False, "pid": None, "error": START_OFF})
    store.start_network_async(restart=restart, source=autofix.SOURCE_PANEL)
    assert store.wait_for_background() == []
    assert lines("network-start") == [
        f"{did} the Diplomacy Network daemon (ok: false): {START_OFF}"]


def test_a_stop_that_left_a_directory_says_so_and_holds_no_daemon(store, on, daemon,
                                                                  monkeypatch):
    d = daemon()
    store._network_cycle_once(1000.0)
    assert store.network_answered is True
    ran = []
    monkeypatch.setattr(da, "run_installer", lambda script, arg: ran.append(arg) or {
        "ok": False, "daemonRunning": False, "pid": None, "error": STOP_LEFT,
        "ended": {"offers": 1, "runs": 0}})
    asked = len(d.got)
    store.set_network_enabled(False)
    assert store.wait_for_background() == []
    assert lines("network-stop") == [
        "Stopped the Diplomacy Network daemon (ok: false), cancelling 1 offer" + LEFT
        + f": {STOP_LEFT}"]
    assert ran == ["--stop-daemon"], "said, and not tried again as a daemon that stayed"
    assert store.network_state is None and store.network_answered is None
    assert not dn.enabled() and store.network_trouble == ""
    store._network_cycle_once(1100.0)
    assert len(d.got) == asked and ran == ["--stop-daemon"]


def test_a_snapshot_that_differs_only_in_its_test_settings_is_kept_and_drawn(
        store, on, daemon):
    d = daemon()
    store._network_cycle_once(1000.0)
    assert store.network_state.test_settings == ()
    drawn = []
    store.network_changed.connect(lambda: drawn.append(store.network_state.test_settings))
    d.state = {**d.state, "daemon": {**d.state["daemon"],
                                     "testSettings": ["DN_TRANSPORT=loop"]}}
    store._network_cycle_once(1002.0)
    assert drawn and drawn[-1] == ("DN_TRANSPORT=loop",)


def test_a_start_says_nothing_of_a_store(store, on, monkeypatch):
    monkeypatch.setattr(da, "run_installer", lambda script, arg: {
        "daemonRunning": True, "ended": {"offers": 2, "runs": 1}})
    store.start_network_async()
    assert store.wait_for_background() == []
    assert lines("network-start") == ["Started the Diplomacy Network daemon (ok: true)"]


def test_a_start_fetches_no_dependency(store, on, installer, monkeypatch):
    fetched = []
    monkeypatch.setattr(da, "ensure_deps", lambda *a, **kw: fetched.append(a) or True)
    store.start_network_async()
    assert store.wait_for_background() == []
    store.restart_network_async()
    assert store.wait_for_background() == []
    assert [arg for _, arg in installer] == ["--start-daemon", "--restart-daemon"]
    assert fetched == []
    assert not hasattr(dn, "ensure_deps")


def test_neither_a_start_nor_a_restart_runs_with_the_switch_off(store, daemon, installer):
    d = daemon()
    store.start_network_async()
    assert store.wait_for_background() == []
    store.restart_network_async()
    assert store.wait_for_background() == []
    assert installer == [] and d.got == []


def test_a_switch_flipped_twice_leaves_the_daemon_as_the_second_flip_says(store, monkeypatch):
    ran, release = [], threading.Event()

    def run(script, arg):
        ran.append(arg)
        if len(ran) == 1:
            release.wait(10)
        return {"daemonRunning": arg != "--stop-daemon"}

    monkeypatch.setattr(da, "run_installer", run)
    store.set_network_enabled(True)
    deadline = time.monotonic() + 10
    while not ran and time.monotonic() < deadline:
        time.sleep(0.01)
    assert store.network_busy
    store.set_network_enabled(False)
    store.restart_network_async()
    release.set()
    assert store.wait_for_background() == []
    assert ran == ["--start-daemon", "--stop-daemon"], "the stop waited, the button gave way"
    assert not store.network_busy


def test_a_start_asked_for_while_one_is_under_way_gives_way(store, on, installer):
    with store._network_lifecycle:
        store.start_network_daemon_async()
        store.restart_network_async()
        assert store.wait_for_background() == [], "neither waits for its turn"
    assert installer == []


def test_a_start_that_keeps_failing_is_said_once_for_the_silence(store, on):
    store._network_cycle_once(1000.0)
    store._network_cycle_once(1015.0)
    assert lines("network-start") == [
        "Started the Diplomacy Network daemon (ok: false): the installer could not be run"]
    store.restart_network_async()
    assert store.wait_for_background() == []
    assert lines("network-start")[0] == (
        "Restarted the Diplomacy Network daemon (ok: false): the installer could not be run"
    ), "the operator's own is answered every time"


def test_a_daemon_found_dead_is_started_again_with_a_growing_wait(store, on, installer):
    store._network_cycle_once(1000.0)
    assert installer == [("install.js", "--start-daemon")]
    assert store.network_answered is False and store.network_state is None

    store._network_cycle_once(1014.0)
    assert len(installer) == 1, "not on every cycle"
    store._network_cycle_once(1015.0)
    assert len(installer) == 2
    store._network_cycle_once(1044.0)
    store._network_cycle_once(1045.0)
    assert len(installer) == 3

    waits, now = [], 1045.0
    for _ in range(6):
        now = store._network_memo.start_after
        store._network_cycle_once(now)
        waits.append(store._network_memo.start_delay)
    assert waits == [120.0, 240.0, 480.0, 600.0, 600.0, 600.0]
    assert all(e.source == "auto" for e in activity.read() if e.action == "network-start")


def test_an_answer_resets_the_wait_and_brings_the_poll_forward(store, on, installer, daemon,
                                                               monkeypatch):
    forwarded = []
    monkeypatch.setattr(store, "_bring_poll_forward", forwarded.append)
    d = daemon()
    store._network_cycle_once(990.0)
    # The same daemon goes quiet and comes back: nothing of it reads as another one.
    up, d.state = d.state, None
    store._network_cycle_once(1000.0)
    store._network_cycle_once(1015.0)
    assert store._network_memo.start_delay == 30.0 and forwarded == []
    d.state = up
    store._network_cycle_once(1016.0)
    assert (store._network_memo.start_after, store._network_memo.start_delay) == (0.0, 0.0)
    assert len(forwarded) == 1, "work held while it was silent has somewhere to go"


# MARK: - the gate

def test_a_dispatch_is_one_offer_and_no_spawn(store, on, daemon, monkeypatch):
    d = daemon(takes_offers())
    calls = _spawn_recorder(monkeypatch)

    verdict = store.dispatch_agent(job(ledger_key="review:o/r#9"), autofix.SOURCE_AUTO)

    assert verdict == "spawned"
    assert calls == [], "nothing starts on this machine while the switch is on"
    assert d.sent("offer") == [{
        "pool": POOL, "kind": "review", "item": "pr-9", "title": "Review · #9",
        "prompt": "PROMPT", "now": False, "options": {"verdict": False}}]
    (run,) = agentregistry.load()
    assert (run.network, run.pid, run.tty) == ("t1", None, "")
    assert (run.label, run.source, run.ledger_key, run.pipeline) == (
        "Auto · Review · #9", autofix.SOURCE_AUTO, "review:o/r#9", False)
    assert lines("network-offer") == ["Auto · Review · #9 - offered to github.com/o/r"]
    assert [(e["ev"], e["key"]) for e in ledger()] == [("started", "review:o/r#9")]


def test_an_offered_pipeline_job_books_the_pipelines_run(store, on, daemon, monkeypatch):
    """Whose report alone concludes the Pipeline's record (:func:`pipeline.concluded`)."""
    daemon(takes_offers())
    _spawn_recorder(monkeypatch)
    pipelines = job(counter=PIPELINE_COUNTER, ledger_key="")
    assert store.dispatch_agent(pipelines, autofix.SOURCE_AUTO, bypass_capacity=True) == "spawned"
    (run,) = agentregistry.load()
    assert (run.network, run.pipeline) == ("t1", True)


def test_the_run_reads_where_it_is_as_the_snapshot_moves_and_is_priced_once(
        store, on, daemon, monkeypatch):
    d = daemon(takes_offers())
    calls = _spawn_recorder(monkeypatch)
    store.dispatch_agent(job(ledger_key="review:o/r#9"), autofix.SOURCE_AUTO)

    store._network_cycle()
    (state, reason), = rows(store)
    assert state == agentstate.STARTING and reason.endswith("not in the pool yet")

    d.state = snapshot(offers=[offer()])
    store._network_cycle()
    assert rows(store) == [(agentstate.STARTING, "in the pool")]

    d.state = snapshot(offers=[offer(state="claimed", executor=PEER)])
    store._network_cycle()
    store._network_cycle()
    assert rows(store) == [(agentstate.RUNNING, "running on 9f3c1a77")]
    assert lines("network-claimed") == ["Auto · Review · #9 - running on 9f3c1a77"]

    d.state = snapshot(offers=[offer(
        state="done", executor=PEER, endedAt=1_794_000_000.0,
        outcome={"ok": True, "summary": "reviewed", "usd": 0.42, "tokens": 81_000,
                 "runner": "claude", "model": "opus"})])
    store._network_cycle()
    store._network_cycle()
    store._settle_agents()

    assert rows(store) == [] and agentregistry.load() == []
    assert [e for e in ledger() if e["ev"] == "done"] == [{
        "at": 1_794_000_000.0, "ev": "done", "key": "review:o/r#9", "tokens": 81_000,
        "runner": dn.RUNNER_ELSEWHERE, "usd": 0.42, "model": "opus"}]
    (done,) = lines("network-done")
    assert done.startswith("Auto · Review · #9") and done.endswith("finished on 9f3c1a77")
    assert calls == [] and len(d.sent("offer")) == 1 and d.sent("withdraw") == []


@pytest.mark.parametrize("state, executor, ok, runner, counted", [
    (agentstate.NET_DONE, ME, True, "claude", True),
    (agentstate.NET_DONE, PEER, True, dn.RUNNER_ELSEWHERE, False),
    (agentstate.NET_FAILED, ME, False, "claude", True),
    # Attempts ran out with nobody holding it: the last outcome is no run of this machine's.
    (agentstate.NET_FAILED, "", False, dn.RUNNER_ELSEWHERE, False)])
def test_an_ended_offer_is_booked_to_the_machine_its_row_names(
        store, on, daemon, state, executor, ok, runner, counted):
    row = daemon_row(state=state, executor=executor, outcome=spent(ok))
    assert set(row) == {
        "taskId", "pool", "kind", "item", "title", "state", "executor", "executorHere",
        "attempt", "requests", "refused", "outcome", "reason", "offeredAt", "endedAt"}
    daemon(state=snapshot(offers=[row]))
    book_network_run(ledger_key="review:o/r#9")
    telemetry.record_started("review:o/r#9")
    store._network_cycle()
    assert agentregistry.load() == []
    (done,) = [e for e in ledger() if e["ev"] == "done"]
    assert done.get("runner") == runner and done["at"] == row["endedAt"]
    (task,) = [t for t in telemetry.load().tasks if t.key == "review:o/r#9"]
    assert task.anthropic is counted and task.tokens == 500


@pytest.mark.parametrize("row, concluded", [
    (offer(state="done", executor=PEER, executorHere=False, outcome={"ok": True}), True),
    (offer(state="done", executor=PEER, executorHere=False, outcome={"ok": False}), False),
    (offer(state="failed", reason="the container exited 137"), False),
    (offer(state="cancelled", reason="pool closed"), False)])
def test_a_review_request_is_concluded_by_the_network_run_that_finished_it(
        store, on, daemon, row, concluded):
    daemon(state=snapshot(offers=[row]))
    book_network_run(ledger_key=autofix.ledger_key(
        autofix.WORK_REVIEW_REQ, "https://github.com/o/r/pull/9", "abc"))
    asked = autofix.ReviewAttempt("2026-01-01T00:00:00Z", time.time(), 1)
    store._save_attempts("reviewReqAttempts", {"o/r#9": asked})
    store._network_cycle()
    assert agentregistry.load() == []
    kept = store._load_attempts("reviewReqAttempts")["o/r#9"]
    assert (kept.concluded_at is not None) is concluded
    assert dataclasses.replace(kept, concluded_at=None) == asked
    assert lines("kill-device") == [], "a run in a container has no window here"


def test_a_run_with_no_ledger_entry_is_priced_into_none(store, on, daemon):
    daemon(state=snapshot(offers=[daemon_row(
        state=agentstate.NET_DONE, executor=ME, outcome=spent())]))
    book_network_run(ledger_key="", source=autofix.SOURCE_PANEL)
    store._network_cycle()
    assert agentregistry.load() == [] and ledger() == []


def test_a_task_that_failed_is_logged_as_failed_and_still_priced(store, on, daemon):
    daemon(state=snapshot(offers=[offer(
        state="done", executor=ME, outcome={"ok": False, "tokens": 90, "runner": "claude"})]))
    book_network_run(ledger_key="review:o/r#9")
    store._network_cycle()
    assert agentregistry.load() == []
    (failed,) = lines("network-failed")
    assert "failed on this machine" in failed
    assert [e["tokens"] for e in ledger() if e["ev"] == "done"] == [90]


@pytest.mark.parametrize("state, reason, said", [
    ("failed", "the container exited 137", "refused by the network: the container exited 137"),
    ("cancelled", "merged", "withdrawn from the network: merged")])
def test_an_offer_the_network_ended_retires_its_run_with_the_daemons_reason(
        store, on, daemon, state, reason, said):
    daemon(state=snapshot(offers=[offer(state=state, reason=reason)]))
    book_network_run()
    store._settle_agents()
    assert agentregistry.load() == []
    (failed,) = lines("network-failed")
    assert failed.startswith("Auto · Review · #9") and failed.endswith(f" {said}")


@pytest.mark.parametrize("ok, audited", [(True, [("https://github.com/o/r/pull/9", "alice")]),
                                         (False, [])])
def test_a_review_the_network_finished_is_audited_like_one_run_here(
        store, on, daemon, monkeypatch, ok, audited):
    asked = []
    monkeypatch.setattr("diplomat_runtime.reviewaudit.audit", lambda url, me, since: (
        asked.append((url, me)), ["left a review nobody can see"])[1])
    daemon(state=snapshot(offers=[offer(state="done", executor=PEER, outcome={"ok": ok})]))
    book_network_run()
    store._settle_agents()
    assert store.wait_for_background() == []
    assert asked == audited
    assert lines("warn") == (
        ["Auto · Review · #9 left a review nobody can see"] if ok else [])


def test_an_outcome_that_spent_nothing_leaves_the_ledger_entry_open(store, on, daemon):
    daemon(state=snapshot(offers=[offer(
        state="done", executor=ME, outcome={"ok": True, "tokens": 0, "usd": 0})]))
    book_network_run(ledger_key="review:o/r#9")
    store._network_cycle()
    assert agentregistry.load() == [] and len(lines("network-done")) == 1
    assert [e for e in ledger() if e["ev"] == "done"] == []


def test_a_daemon_that_does_not_answer_is_not_an_empty_snapshot(store, on):
    """Read as empty, a run past its grace has no offer and is retired as failed."""
    book_network_run(age=agentstate.SPAWN_GRACE + 60)
    store._network_cycle()
    store._settle_agents()
    ((state, reason),) = rows(store)
    assert state == agentstate.UNKNOWN
    assert reason == f"the network could not be asked: {network.UNANSWERED}"
    assert len(agentregistry.load()) == 1


def test_an_offer_the_pool_already_holds_books_no_second_run(store, on, daemon, monkeypatch):
    d = daemon(takes_offers())
    calls = _spawn_recorder(monkeypatch)
    assert store.dispatch_agent(job(), autofix.SOURCE_AUTO) == "spawned"
    # An item with no number is not deduped on, so its second offer reaches the daemon.
    sweep = autofix.AgentJob(kind="audit", audit_action="audit", label="Audit", prompt="A")
    d.routes["/offer"] = (200, {"taskId": "t2"})
    assert store.dispatch_agent(sweep, autofix.SOURCE_PANEL) == "spawned"
    assert store.dispatch_agent(sweep, autofix.SOURCE_PANEL) == autofix.VERDICT_IN_FLIGHT
    assert sorted(r.network for r in agentregistry.load()) == ["t1", "t2"]
    assert lines("in-flight") == ["Audit - already offered to github.com/o/r"]
    assert calls == []


def test_an_offer_no_run_could_be_booked_for_is_taken_back(store, on, daemon, monkeypatch):
    d = daemon(takes_offers())
    calls = _spawn_recorder(monkeypatch)

    def full(record, prompt):
        raise OSError(28, "No space left on device")

    monkeypatch.setattr(agentregistry, "create_run", full)
    assert store.dispatch_agent(job(ledger_key="review:o/r#9"), autofix.SOURCE_AUTO) == "failed"
    assert d.sent("withdraw") == [{"taskId": "t1", "reason": "not booked"}]
    assert lines("network-failed") == [
        "Review · #9 - could not register the run, so its offer is withdrawn"]
    assert lines("network-offer") == [] and ledger() == [] and calls == []


def test_a_panel_job_is_this_machines_to_run_at_once(store, on, daemon, monkeypatch):
    d = daemon(takes_offers())
    _spawn_recorder(monkeypatch)
    store.dispatch_agent(job(1), autofix.SOURCE_PANEL)
    store.dispatch_agent(job(2), autofix.SOURCE_AUTO, bypass_capacity=True, forced=True)
    store.dispatch_agent(job(3), autofix.SOURCE_AUTO, bypass_capacity=True)
    assert [b["now"] for b in d.sent("offer")] == [True, True, False]
    assert lines("network-offer")[-1] == "Review · #1 - offered to github.com/o/r"
    assert [e for e in ledger() if e["ev"] == "started"] == [], "no ledger key, no entry"


# MARK: - a daemon that does not take the job

def test_with_the_daemon_down_auto_work_waits_and_a_panel_job_says_why(
        store, on, monkeypatch):
    calls = _spawn_recorder(monkeypatch)

    verdicts = [store.dispatch_agent(job(n), autofix.SOURCE_AUTO) for n in (1, 2)]

    assert verdicts == [dn.VERDICT_REFUSED] * 2
    assert all(v.sentence == "the Diplomacy Network daemon is not answering"
               for v in verdicts)
    store.commit_queue()
    assert [e.id for e in store.queued_tasks] == ["review-req:o/r#1", "review-req:o/r#2"]
    assert lines("network-unavailable") == [
        "Holding auto work - the Diplomacy Network did not take Review · #1: "
        "the Diplomacy Network daemon is not answering"]

    clicked = store.dispatch_agent(job(3), autofix.SOURCE_PANEL)
    assert clicked == dn.VERDICT_REFUSED and clicked.sentence == dn.NOT_ANSWERING
    assert lines("network-unavailable")[0] == (
        "Review · #3 was not offered: the Diplomacy Network daemon is not answering")
    assert "review-req:o/r#3" not in [e.id for e in store._staged_queue]
    assert store.network_offering == [], "no daemon was reached, so none may hold it"

    assert calls == [] and agentregistry.load() == [] and ledger() == []


def test_the_queue_retries_next_cycle_and_stops_at_a_daemon_that_is_down(
        store, on, daemon, monkeypatch):
    calls = _spawn_recorder(monkeypatch)
    store.auto_task_limit = 8
    store.queued_tasks = [autofix.QueuedTask("review-req:o/r#6", job(6), 1),
                          autofix.QueuedTask("review-req:o/r#7", job(7), 1)]
    store._drain_queued_tasks([], closed=set())
    assert [e.id for e in store._staged_queue] == ["review-req:o/r#6"], "the one it tried"
    assert [e.id for e in store.queued_tasks] == ["review-req:o/r#7"], "the rest were not asked"

    # A task offered holds no bay of this machine's, so a full cap keeps none queued.
    d = daemon(takes_offers())
    monkeypatch.setattr(store, "_auto_tasks_running", lambda: store.auto_task_limit)
    store._staged_queue = []
    store.queued_tasks = [autofix.QueuedTask("review-req:o/r#6", job(6), 1)]
    store._drain_queued_tasks([], closed=set())
    assert [b["item"] for b in d.sent("offer")] == ["pr-6"]
    assert store._staged_queue == [] and calls == []


def test_the_queue_has_room_whenever_the_daemon_answers(store, on):
    store.queued_tasks = [autofix.QueuedTask("review-req:o/r#6", job(6), 1)]
    full = store.auto_task_limit
    assert store._drain_has_room(full), "a full cap of this machine's is no bar to the pool"
    store.network_answered = False
    assert not store._drain_has_room(0)
    store.network_answered = True
    assert store._drain_has_room(full)
    appconfig.set_bool(network.ENABLED_KEY, False)
    assert not store._drain_has_room(full) and store._drain_has_room(0)


def test_automatic_work_is_not_offered_while_the_daemon_is_known_silent(
        store, on, daemon, monkeypatch):
    d = daemon(takes_offers())
    calls = _spawn_recorder(monkeypatch)
    store.network_answered = False

    verdicts = [store.dispatch_agent(job(n), autofix.SOURCE_AUTO) for n in (1, 2)]
    assert [(v, v.sentence, v.own) for v in verdicts] == [
        (dn.VERDICT_REFUSED, dn.NOT_ANSWERING, False)] * 2
    assert d.sent("offer") == [], "an offer would wait out its timeout"
    store.commit_queue()
    assert [e.id for e in store.queued_tasks] == ["review-req:o/r#1", "review-req:o/r#2"]
    assert lines("network-unavailable") == [
        "Holding auto work - the Diplomacy Network did not take Review · #1: "
        "the Diplomacy Network daemon is not answering"]

    entry = store.queued_tasks[0]
    store._execute_queued_task(entry)
    assert [b["item"] for b in d.sent("offer")] == ["pr-1"], "execute now asks"
    d.routes["/offer"] = (200, {"taskId": "t4"})
    assert store.dispatch_agent(job(4), autofix.SOURCE_PANEL) == "spawned"
    assert [b["item"] for b in d.sent("offer")] == ["pr-1", "pr-4"], "and so does a start"
    assert store.network_answered is False
    store._network_cycle()
    assert store.network_answered is True
    d.routes["/offer"] = (200, {"taskId": "t3"})
    assert store.dispatch_agent(job(3), autofix.SOURCE_AUTO) == "spawned"
    assert [b["item"] for b in d.sent("offer")] == ["pr-1", "pr-4", "pr-3"] and calls == []


def test_a_job_whose_reported_cost_was_capped_says_so_where_it_ends(store, on, daemon):
    daemon(state=snapshot(offers=[offer(
        state="done", executor=PEER, endedAt=1_794_000_000.0,
        outcome={"ok": True, "usd": 0.42, "tokens": 81_000, "capped": True})]))
    book_network_run(ledger_key="review:o/r#9")
    store._network_cycle()
    assert agentregistry.load() == []
    (done,) = lines("network-done")
    assert done.endswith("finished on 9f3c1a77, its reported cost capped")


STOPPING = (503, {"error": "The Diplomacy Network daemon is stopping."})


def test_a_daemon_that_takes_no_job_is_said_once_for_the_spell_of_it(
        store, on, daemon, monkeypatch):
    d = daemon({"/offer": STOPPING})
    calls = _spawn_recorder(monkeypatch)
    for n in (1, 2):
        verdict = store.dispatch_agent(job(n), autofix.SOURCE_AUTO)
        assert verdict.sentence == "The Diplomacy Network daemon is stopping."
        assert not verdict.own
    assert lines("network-unavailable") == [
        "Holding auto work - the Diplomacy Network did not take Review · #1: "
        "The Diplomacy Network daemon is stopping."]
    assert store.network_job_refusals == {}

    d.routes["/offer"] = (200, {"taskId": "t3"})
    assert store.dispatch_agent(job(3), autofix.SOURCE_AUTO) == "spawned"
    d.routes["/offer"] = STOPPING
    store.dispatch_agent(job(4), autofix.SOURCE_AUTO)
    assert len(lines("network-unavailable")) == 2, "an offer that went through ends the spell"
    assert calls == []


NO_RULES = "That pool's rules name no review."


def _refuses(*items):
    def answer(body):
        if body["item"] in items:
            return 409, {"error": NO_RULES}
        return 200, {"taskId": f"t-{body['item']}"}
    return answer


def _queue(store, *numbers) -> None:
    store._staged_queue = []
    store.queued_tasks = [autofix.QueuedTask(f"review-req:o/r#{n}", job(n), 1) for n in numbers]


def test_a_job_refused_for_its_own_reason_does_not_stop_the_queue(
        store, on, daemon, monkeypatch):
    d = daemon({"/offer": _refuses("pr-6")})
    calls = _spawn_recorder(monkeypatch)
    store.auto_task_limit = 8
    _queue(store, 6, 7)
    store._drain_queued_tasks([], closed=set())
    assert [b["item"] for b in d.sent("offer")] == ["pr-6", "pr-7"], "the next is asked about"
    assert [r.network for r in agentregistry.load()] == ["t-pr-7"]
    assert [e.id for e in store._staged_queue] == ["review-req:o/r#6"], "and it waits"
    assert store.network_job_refusals == {"Review · #6": NO_RULES}
    store.commit_queue()
    assert [e.id for e in store.queued_tasks] == ["review-req:o/r#6"]
    assert store.network_job_refusals == {"Review · #6": NO_RULES}, "its row keeps the reason"

    _queue(store, 6)
    store._drain_queued_tasks([], closed=set())
    store.commit_queue()
    assert lines("network-unavailable") == [f"Review · #6 was not offered: {NO_RULES}"], \
        "said once for the job, however often it is refused"

    d.routes["/offer"] = (409, {"error": "This machine is not in that pool."})
    _queue(store, 6)
    store._drain_queued_tasks([], closed=set())
    assert lines("network-unavailable")[:-1] == [
        "Review · #6 was not offered: This machine is not in that pool."], "and again for another"
    assert calls == []


def test_a_refusal_of_a_jobs_own_ends_with_the_offer_that_goes_through(
        store, on, daemon, monkeypatch):
    d = daemon({"/offer": _refuses("pr-6", "pr-8")})
    _spawn_recorder(monkeypatch)
    store.auto_task_limit = 8
    _queue(store, 6, 8)
    store._drain_queued_tasks([], closed=set())
    assert set(store.network_job_refusals) == {"Review · #6", "Review · #8"}
    changed = []
    store.tasks_changed.connect(lambda: changed.append(dict(store.network_job_refusals)))

    d.routes["/offer"] = _refuses("pr-8")
    _queue(store, 6, 8)
    store._drain_queued_tasks([], closed=set())
    assert store.network_job_refusals == {"Review · #8": NO_RULES}

    # A row that left the queue for any other reason takes its reason with it.
    store.commit_queue()
    assert changed[-1] == {"Review · #8": NO_RULES}
    store._staged_queue = []
    store.commit_queue()
    assert store.network_job_refusals == {}
    assert changed[-1] == {}, "before the panel is told the row went"


def test_the_panel_is_told_of_a_reason_that_changed_under_a_row(store, on, daemon, monkeypatch):
    d = daemon({"/offer": _refuses("pr-6")})
    _spawn_recorder(monkeypatch)
    told = []
    store.tasks_changed.connect(lambda: told.append(dict(store.network_job_refusals)))
    store.dispatch_agent(job(6), autofix.SOURCE_AUTO)
    assert told == [{"Review · #6": NO_RULES}]
    store.dispatch_agent(job(6), autofix.SOURCE_AUTO)
    assert len(told) == 1, "a reason that stands is not news"
    d.routes["/offer"] = (409, {"error": "This machine is not in that pool."})
    store.dispatch_agent(job(6), autofix.SOURCE_AUTO)
    assert told[1:] == [{"Review · #6": "This machine is not in that pool."}]


@pytest.mark.parametrize("answer", [STOPPING, (500, {}), (200, {})],
                         ids=["stopping", "a fault of the daemon's", "no task named"])
def test_a_daemon_that_takes_no_job_stops_the_queue(store, on, daemon, monkeypatch, answer):
    d = daemon({"/offer": answer})
    _spawn_recorder(monkeypatch)
    store.auto_task_limit = 8
    _queue(store, 6, 7)
    store._drain_queued_tasks([], closed=set())
    assert [b["item"] for b in d.sent("offer")] == ["pr-6"], "the rest were not asked"
    assert store.network_job_refusals == {}


def test_a_job_no_offer_can_be_made_of_is_refused_for_its_own_reason(
        store, on, daemon, monkeypatch):
    d = daemon(takes_offers())
    _spawn_recorder(monkeypatch)
    store.auto_task_limit = 8
    odd = dataclasses.replace(job(6), audit_action="translate")
    store.queued_tasks = [autofix.QueuedTask("review-req:o/r#6", odd, 1),
                          autofix.QueuedTask("review-req:o/r#7", job(7), 1)]
    store._drain_queued_tasks([], closed=set())
    assert [b["item"] for b in d.sent("offer")] == ["pr-7"]
    assert store.network_job_refusals == {"Review · #6": "the network runs no translate jobs"}


def test_switching_the_network_off_forgets_the_refusals(store, on, daemon, installer,
                                                        monkeypatch):
    daemon({"/offer": _refuses("pr-6")})
    _spawn_recorder(monkeypatch)
    store.dispatch_agent(job(6), autofix.SOURCE_AUTO)
    assert store.network_job_refusals
    store.set_network_enabled(False)
    assert store.wait_for_background() == []
    assert store.network_job_refusals == {}


@pytest.mark.parametrize("answer, source, sentence", [
    ((200, {}), autofix.SOURCE_PANEL, "the daemon named no task for the offer"),
    ((200, {}), autofix.SOURCE_AUTO, "the daemon named no task for the offer"),
    ((409, {"error": "That pool is closed."}), autofix.SOURCE_PANEL, "That pool is closed."),
    ((500, {}), autofix.SOURCE_AUTO, "the daemon answered HTTP 500"),
])
def test_an_offer_with_no_task_books_nothing(store, on, daemon, monkeypatch, answer, source,
                                             sentence):
    daemon({"/offer": answer})
    calls = _spawn_recorder(monkeypatch)
    verdict = store.dispatch_agent(job(), source)
    assert verdict == dn.VERDICT_REFUSED and verdict.sentence == sentence
    assert agentregistry.load() == [] and calls == [] and store.network_offering == []


# MARK: - an offer the daemon did not settle

def lose_offer_replies(monkeypatch) -> None:
    send = dn.send

    def lost(route, body=None, **kw):
        reply = send(route, body, **kw)
        return da.NO_REPLY if route == network.ROUTE_OFFER else reply

    monkeypatch.setattr(dn, "send", lost)


@pytest.mark.parametrize("how", ["a fault of the daemon's", "no reply"])
def test_an_offer_of_the_operators_the_daemon_did_not_settle_is_kept(
        store, on, daemon, monkeypatch, how):
    from diplomat_app import widgets

    d = daemon({"/offer": (500, {})} if how != "no reply" else takes_offers())
    if how == "no reply":
        lose_offer_replies(monkeypatch)
    calls = _spawn_recorder(monkeypatch)
    told = []
    store.tasks_changed.connect(lambda: told.append(1))

    verdict = store.dispatch_agent(job(), autofix.SOURCE_PANEL)

    assert verdict == dn.VERDICT_OFFERING
    assert widgets.dispatch_status_text(verdict, "T", network=True) == "Offering to the pool…"
    (held,) = store.network_offering
    assert held.key == (POOL, "review", "pr-9") and held.source == autofix.SOURCE_PANEL
    assert (held.row_label, held.offer.body) == ("Review · #9", d.sent("offer")[0])
    assert told, "the panel draws it"
    assert agentregistry.load() == [] and lines("network-unavailable") == [] and calls == []
    # The same job pressed again is held once.
    assert store.dispatch_agent(job(), autofix.SOURCE_PANEL) == dn.VERDICT_OFFERING
    assert len(store.network_offering) == 1

    # Automatic work is not kept: it goes back to the queue, which offers it again.
    auto = store.dispatch_agent(job(2), autofix.SOURCE_AUTO)
    assert auto == dn.VERDICT_REFUSED and len(store.network_offering) == 1
    assert [e.id for e in store._staged_queue] == ["review-req:o/r#2"]


def test_an_unsettled_offer_is_booked_once_the_snapshot_lists_it(store, on, daemon):
    d = daemon({"/offer": (500, {})})
    store.dispatch_agent(job(ledger_key="review:o/r#9"), autofix.SOURCE_PANEL)
    store._network_cycle()
    assert len(d.sent("offer")) == 2, "not in the snapshot, so the offer is made again"
    assert len(store.network_offering) == 1 and agentregistry.load() == []

    # An offer of another item and one that ended are not it.
    d.state = snapshot(offers=[daemon_row("t5", item="pr-10"),
                               daemon_row("t6", agentstate.NET_CANCELLED)])
    store._network_cycle()
    assert len(d.sent("offer")) == 3 and len(store.network_offering) == 1

    d.state = snapshot(offers=[daemon_row("t7")])
    store._network_cycle()
    assert len(d.sent("offer")) == 3, "found open, so it is booked and not offered"
    assert store.network_offering == []
    (run,) = agentregistry.load()
    assert (run.network, run.source, run.ledger_key) == (
        "t7", autofix.SOURCE_PANEL, "review:o/r#9")
    assert lines("network-offer") == ["Review · #9 - offered to github.com/o/r"]
    assert ledger() == [], "the ledger is the monitors', as for a job offered at once"


def test_an_unsettled_offer_made_again_is_booked_when_taken_and_dropped_when_refused(
        store, on, daemon, monkeypatch):
    d = daemon({"/offer": (500, {})})
    calls = _spawn_recorder(monkeypatch)
    store.dispatch_agent(job(9), autofix.SOURCE_PANEL)
    store.dispatch_agent(job(10), autofix.SOURCE_PANEL)
    assert [h.key[2] for h in store.network_offering] == ["pr-9", "pr-10"]

    d.routes["/offer"] = lambda body: (
        (200, {"taskId": "t9"}) if body["item"] == "pr-9"
        else (409, {"error": "That pool is closed."}))
    store._network_cycle()
    assert store.network_offering == []
    assert [(r.network, r.pr_number) for r in agentregistry.load()] == [("t9", 9)]
    assert lines("network-unavailable") == ["Review · #10 was not offered: That pool is closed."]
    assert calls == []


def test_an_unsettled_offer_a_second_press_booked_gains_no_second_run(store, on, daemon):
    d = daemon({"/offer": (500, {})})
    store.dispatch_agent(job(), autofix.SOURCE_PANEL)
    book_network_run("t7", 9, source=autofix.SOURCE_PANEL)
    d.state = snapshot(offers=[daemon_row("t7")])
    store._network_cycle()
    assert store.network_offering == [] and len(agentregistry.load()) == 1


def test_switching_off_withdraws_the_unsettled_offers_the_daemon_holds(store, on, daemon):
    d = daemon({"/offer": (500, {})})
    store.dispatch_agent(job(9), autofix.SOURCE_PANEL)
    store.dispatch_agent(job(10), autofix.SOURCE_PANEL)
    d.state = snapshot(offers=[daemon_row("t7")])
    appconfig.set_bool(network.ENABLED_KEY, False)
    store._settle_agents()
    assert d.sent("withdraw") == [{"taskId": "t7", "reason": "switched off"}]
    assert lines("network-withdraw") == ["Review · #9 - withdrawn (switched off)"]
    assert lines("network-unavailable") == [
        "Review · #10 was not offered: the Diplomacy Network is switched off"]
    assert store.network_offering == []


def test_a_job_with_no_repository_or_kind_is_refused_without_asking(store, on, daemon,
                                                                    monkeypatch):
    d = daemon(takes_offers())
    calls = _spawn_recorder(monkeypatch)
    nowhere = autofix.AgentJob(kind="audit", audit_action="audit", label="Audit",
                               prompt="A", checkout="/src/not-listed")
    verdict = store.dispatch_agent(nowhere, autofix.SOURCE_PANEL)
    assert verdict.sentence == "no repository to offer it into"
    unknown = autofix.AgentJob(kind="x", audit_action="telemetry", label="X", prompt="A")
    assert store.dispatch_agent(unknown, autofix.SOURCE_PANEL).sentence == (
        "the network runs no telemetry jobs")
    assert d.sent("offer") == [] and calls == []


def test_execute_now_with_the_daemon_down_shows_the_sentence(store, on, monkeypatch):
    calls = _spawn_recorder(monkeypatch)
    entry = autofix.QueuedTask("review-req:o/r#5", job(5), 1)
    store.queued_tasks = [entry]
    store._execute_queued_task(entry)
    assert store.error == (
        "Review · #5 was not offered: the Diplomacy Network daemon is not answering.")
    assert calls == [] and lines("queue-run") == []


def test_execute_now_offers_the_job_for_this_machine_to_run(store, on, daemon, monkeypatch):
    d = daemon(takes_offers())
    calls = _spawn_recorder(monkeypatch)
    entry = autofix.QueuedTask("review-req:o/r#5", job(5), 1)
    store.queued_tasks = [entry]
    store._execute_queued_task(entry)
    assert [b["now"] for b in d.sent("offer")] == [True]
    assert lines("queue-run") == ["Review · #5 - offered for this machine to run at once"]
    assert calls == []


def test_no_road_to_a_spawn_is_open_with_the_switch_on(store, on, monkeypatch):
    calls = _spawn_recorder(monkeypatch)
    with pytest.raises(review.SpawnError, match="the Diplomacy Network is on"):
        store._spawn_tracked("P", "https://github.com/o/r/pull/1", 1, autofix.SOURCE_PANEL)
    assert calls == [] and agentregistry.load() == []


@pytest.mark.parametrize("start", [
    lambda st: st._dispatch_conflict_fix(4, "https://github.com/o/r/pull/4", 1,
                                         autofix.SOURCE_AUTO),
    lambda st: st._dispatch_conflict_fix(4, "https://github.com/o/r/pull/4", 1,
                                         autofix.SOURCE_PANEL),
    lambda st: st._dispatch_my_review(SimpleNamespace(
        number=4, url="https://github.com/o/r/pull/4", item="o/r#4", head_sha="")),
    lambda st: st._dispatch_review_request(_req(number=4)),
])
def test_every_monitor_offers_and_none_spawns(store, on, daemon, monkeypatch, start):
    d = daemon(takes_offers())
    calls = _spawn_recorder(monkeypatch)
    start(store)
    assert len(d.sent("offer")) == 1 and d.sent("offer")[0]["item"] == "pr-4"
    assert calls == []
    d.close()
    start(store)  # in flight: the run the first offer booked
    daemon_down = [r.network for r in agentregistry.load()]
    assert daemon_down == ["t1"] and calls == []


# MARK: - what the gate holds

def test_a_paused_item_is_held_and_a_full_cap_a_low_disk_and_a_spent_budget_are_not(
        store, on, daemon, monkeypatch):
    d = daemon({"/offer": lambda body: (200, {"taskId": body["item"]})})
    calls = _spawn_recorder(monkeypatch)

    # Each of the three holds a local dispatch, never a job another machine may take.
    read = []
    monkeypatch.setattr("diplomat_app.store.diskfloor.lowest", lambda paths: (
        read.append("disk"), SimpleNamespace(low=True, path="/", free=0, floor=1))[1])
    monkeypatch.setattr("diplomat_app.store.autobudget.enabled", lambda: True)
    monkeypatch.setattr("diplomat_app.store.autobudget.decide", lambda: (
        read.append("budget"), autofix.Budget(affordable=False))[1])
    bays = [store.auto_task_limit]
    monkeypatch.setattr(store, "_auto_tasks_running", lambda: bays[0])
    assert store.dispatch_agent(job(1), autofix.SOURCE_AUTO) == "spawned"
    bays[0] = 0
    assert store.dispatch_agent(job(4), autofix.SOURCE_AUTO) == "spawned"
    assert len(d.sent("offer")) == 2
    assert read == [], "the disk and the budget are read for the admit, not for an offer"

    store.review_requests_enabled = False
    assert store.dispatch_agent(job(2), autofix.SOURCE_AUTO) == autofix.VERDICT_AT_CAPACITY
    store.review_requests_enabled = True
    store.queue_auto_run = False
    assert store.dispatch_agent(job(3), autofix.SOURCE_AUTO) == autofix.VERDICT_AT_CAPACITY
    assert len(d.sent("offer")) == 2, "a paused monitor and a paused queue offer nothing"
    assert [e.id for e in store._staged_queue] == ["review-req:o/r#2", "review-req:o/r#3"]

    # The operator's own start is held by neither.
    assert store.dispatch_agent(job(3), autofix.SOURCE_PANEL) == "spawned"
    assert len(d.sent("offer")) == 3 and calls == []


def test_a_banned_author_and_an_item_in_flight_are_still_refused(store, on, daemon,
                                                                 monkeypatch):
    d = daemon(takes_offers())
    monkeypatch.setattr("diplomat_app.bans.is_banned", lambda login, banned: login == "evil")
    assert store.dispatch_agent(job(1, author_login="evil"),
                                autofix.SOURCE_AUTO) == autofix.VERDICT_BANNED
    assert store.dispatch_agent(job(2), autofix.SOURCE_AUTO) == "spawned"
    assert store.dispatch_agent(job(2), autofix.SOURCE_AUTO) == autofix.VERDICT_IN_FLIGHT
    assert len(d.sent("offer")) == 1


# MARK: - the options an offer carries

def _offered_options(store, d, job_) -> dict:
    del d.got[:]
    assert store.dispatch_agent(job_, autofix.SOURCE_PANEL) == "spawned"
    (body,) = d.sent("offer")
    return {"kind": body["kind"], **body.get("options", {})}


@pytest.mark.parametrize("allowed", [True, False])
def test_each_option_is_what_the_jobs_own_prompt_allows(store, on, daemon, monkeypatch,
                                                        allowed):
    d = daemon({"/offer": lambda body: (200, {"taskId": body["kind"] + body["item"]})})
    _spawn_recorder(monkeypatch)

    def review_job(number, whose, **toggles):
        payload = review.ReviewConfig(
            target=PRTarget.SPECIFIC, me="alice", specific_pr=str(number),
            specific_author=whose, **toggles).prompt_payload()
        return job(number, **dn.terms(payload))

    theirs = review_job(1, review.SpecificAuthor.THEIRS, final_pass=allowed,
                        mark_ready=not allowed)
    assert _offered_options(store, d, theirs) == {"kind": "review", "verdict": allowed}

    mine = review_job(2, review.SpecificAuthor.MINE, mark_ready=allowed,
                      final_pass=not allowed)
    assert _offered_options(store, d, mine) == {"kind": "review-own", "markReady": allowed}

    fix = autofix.AgentJob(
        kind="issues", audit_action="issues", label="Issues", prompt="I",
        **dn.terms(issues.IssueConfig(open_prs=allowed).prompt_payload()))
    assert _offered_options(store, d, fix) == {"kind": "issues", "noPRs": not allowed}

    sweep = autofix.AgentJob(
        kind="audit", audit_action="audit", label="Audit", prompt="A",
        **dn.terms(audit.AuditConfig(open_prs=allowed).prompt_payload()))
    assert _offered_options(store, d, sweep) == {"kind": "audit", "readOnly": not allowed}


def test_a_review_follows_the_prompt_builders_gates():
    """The builder gives no verdict on the operator's own PR and marks nothing ready on
    someone else's, whatever the toggles say."""
    base = {"kind": "review", "finalPass": True, "markReady": True}
    assert dn.terms({**base, "specificAuthor": "mine"}) == {
        "own_pr": True, "verdict": False, "mark_ready": True}
    assert dn.terms({**base, "specificAuthor": "theirs"}) == {
        "own_pr": False, "verdict": True, "mark_ready": False}
    assert dn.terms({**base, "specificAuthor": "unknown"}) == {
        "own_pr": False, "verdict": True, "mark_ready": True}
    monitors = {"kind": "review", "automaticVerdict": True}
    assert dn.terms({**monitors, "specificAuthor": "theirs"})["verdict"] is True
    assert dn.terms({**monitors, "specificAuthor": "mine"})["verdict"] is False
    assert dn.terms({"kind": "review", "specificAuthor": "theirs"})["verdict"] is False
    assert dn.terms({"kind": "conflicts"}) == {}


@pytest.mark.parametrize("files, verdict", [(["a.py"], True), (["foo.skill.md"], False)])
def test_the_review_monitors_verdict_policy_reaches_the_offer(store, on, daemon, monkeypatch,
                                                              files, verdict):
    d = daemon(takes_offers())
    _spawn_recorder(monkeypatch)
    store.pr_autofix_enabled = False
    store.review_requests_enabled = store.auto_approve_enabled = True
    reqs = [_req(requested_at="2026-01-02", files=files)]
    monkeypatch.setattr("diplomat_app.autofixmonitor.fetch_review_requests",
                        lambda *a, **k: reqs)
    store._poll_review_requests([ROOT])
    (body,) = d.sent("offer")
    assert (body["kind"], body["options"]) == ("review", {"verdict": verdict})


# MARK: - withdrawing

def test_a_merged_pr_is_withdrawn_once_and_a_finished_run_never(store, on, daemon):
    d = daemon(state=snapshot(offers=[
        offer("t1", "claimed", executor=PEER),
        offer("t2", "done", executor=PEER, outcome={"ok": True})]))
    book_network_run("t1", 9)
    book_network_run("t2", 10)
    merged(store, 9)
    store._network_cycle()
    store._settle_agents()
    store._network_cycle()
    assert d.sent("withdraw") == [{"taskId": "t1", "reason": "merged"}]
    assert agentregistry.load() == []
    assert lines("network-withdraw") == [
        "Auto · Review · #9 - its PR merged, so its offer is withdrawn"]


def test_a_merged_pr_whose_offer_the_network_keeps_says_why(store, on, daemon):
    daemon({"/withdraw": (409, {"error": "That task is not this machine's."})},
           state=snapshot(offers=[offer("t1", "claimed", executor=PEER)]))
    book_network_run("t1", 9)
    merged(store, 9)
    store._settle_agents()
    assert lines("network-withdraw") == [
        "Auto · Review · #9 - its PR merged; the network kept its offer: "
        "That task is not this machine's."]
    assert agentregistry.load() == [], "answered, so the run is not asked about again"


@pytest.mark.parametrize("status", [500, 503])
def test_a_withdrawal_the_daemon_did_not_settle_is_asked_again(store, on, daemon, status):
    d = daemon({"/withdraw": (status, {"error": "The daemon is stopping."})},
               state=snapshot(offers=[daemon_row("t1", agentstate.NET_CLAIMED, executor=PEER)]))
    book_network_run("t1", 9)
    merged(store, 9)
    store._settle_agents()
    assert len(agentregistry.load()) == 1, "kept, so the next tick asks again"
    assert lines("network-withdraw") == []
    # A task the daemon no longer holds is answered as withdrawn, so asking twice is safe.
    d.routes["/withdraw"] = (200, {"ok": True, "ended": True})
    store._settle_agents()
    assert d.sent("withdraw") == [{"taskId": "t1", "reason": "merged"}] * 2
    assert agentregistry.load() == []
    assert lines("network-withdraw") == [
        "Auto · Review · #9 - its PR merged, so its offer is withdrawn"]


def test_a_withdrawal_nobody_answered_is_asked_again(store, on, daemon):
    d = daemon(state=snapshot(offers=[offer(state="pooled")]))
    book_network_run()
    store._network_cycle()
    d.close()
    merged(store, 9)
    store._settle_agents()
    assert len(agentregistry.load()) == 1, "kept, so the next tick asks again"
    d = daemon(state=snapshot(offers=[offer(state="pooled")]))
    store._settle_agents()
    assert d.sent("withdraw") == [{"taskId": "t1", "reason": "merged"}]
    assert agentregistry.load() == []


def test_forgetting_a_run_withdraws_an_offer_the_network_still_holds(store, on, daemon):
    d = daemon(state=snapshot(offers=[offer("t1", "pooled"),
                                      offer("t2", "done", outcome={"ok": True})]))
    live, over = book_network_run("t1", 9), book_network_run("t2", 10)
    # The second is over and would be retired by the next settle; forgotten first, it
    # has nothing to withdraw. Neither was ever seen by a cycle: the forget asks itself.
    for run in (live, over):
        store.forget_network_run_async(run.run_id)
        assert store.wait_for_background() == []
    assert d.sent("withdraw") == [{"taskId": "t1", "reason": "forgotten"}]
    assert agentregistry.load() == []
    assert lines("network-withdraw") == ["Auto · Review · #9 - withdrawn (forgotten)"]
    assert lines("retire") == ["Auto · Review · #10 - forgotten"]


def test_a_run_is_forgotten_whatever_the_daemon_answers(store, on):
    run = book_network_run()
    store.forget_network_run_async(run.run_id)
    assert store.wait_for_background() == []
    assert agentregistry.load() == []
    assert lines("network-withdraw") == [
        "Auto · Review · #9 - not withdrawn: the Diplomacy Network daemon is not answering"]


def test_a_switch_read_from_one_config_says_nothing_of_another(tmp_path, monkeypatch):
    first, second = tmp_path / "a.json", tmp_path / "b.json"
    first.write_text('{"networkEnabled": true}')
    second.write_text("{ not json")
    monkeypatch.setenv("DIPLOMAT_CONFIG", str(first))
    assert dn.enabled() is True
    monkeypatch.setenv("DIPLOMAT_CONFIG", str(second))
    assert dn.enabled() is False
    monkeypatch.setenv("DIPLOMAT_CONFIG", str(first))
    first.write_text("{ not json")
    assert dn.enabled() is True
    first.write_text('{"networkEnabled": "true"}')
    assert dn.enabled() is False
    first.write_text("{ not json")
    assert dn.enabled() is False


def unreadable_notes() -> list[str]:
    return [line for line in lines("warn") if line == appconfig.unreadable_note()]


def test_a_config_that_cannot_be_read_leaves_the_switch_as_it_was(store, on, daemon,
                                                                 monkeypatch, tmp_path):
    """One bad read is not "off": the daemon needs five, and on "off" the offers are
    withdrawn, the runs retired and agents started in terminals on the same items."""
    d = daemon(state=snapshot(offers=[daemon_row("t1")]))
    run = book_network_run()
    assert dn.enabled()
    whole = appconfig.path().read_text(encoding="utf-8")
    appconfig.path().write_text(whole.rstrip()[:-1], encoding="utf-8")
    assert dn.enabled() and store.network_enabled, "one brace short"
    store._settle_agents()
    store._settle_agents()
    assert d.sent("withdraw") == []
    assert [r.run_id for r in agentregistry.load()] == [run.run_id]
    assert len(unreadable_notes()) == 1, "said once for the spell"
    # Every setting reads as its default meanwhile, the repo roots among them: the job
    # has no pool, and is still not started in a terminal.
    assert store.dispatch_agent(job(77), autofix.SOURCE_AUTO) == dn.VERDICT_REFUSED
    with pytest.raises(OSError):
        store.set_network_enabled(False)
    assert dn.enabled(), "a switch that would not save stays where it was"

    appconfig.path().write_text(whole, encoding="utf-8")
    store._settle_agents()
    appconfig.path().write_text("", encoding="utf-8")
    store._settle_agents()
    assert dn.enabled() and len(unreadable_notes()) == 2, "an empty file, a second spell"

    # What can be read is believed: a value that is no boolean is off. A file that was
    # there and is gone - an editor saving by rename - says nothing.
    appconfig.path().write_text('{"networkEnabled": "true"}', encoding="utf-8")
    assert not dn.enabled()
    appconfig.set_bool(network.ENABLED_KEY, True)
    assert dn.enabled()
    appconfig.path().unlink()
    assert dn.enabled() and dn.settings_unknown() == unknown()

    # Read on from one config says nothing of another that cannot be read.
    appconfig.set_bool(network.ENABLED_KEY, True)
    assert dn.enabled()
    other = tmp_path / "other.json"
    other.write_text("{", encoding="utf-8")
    monkeypatch.setenv("DIPLOMAT_CONFIG", str(other))
    assert not dn.enabled()


def break_config() -> str:
    whole = appconfig.path().read_text(encoding="utf-8")
    appconfig.path().write_text(whole.rstrip()[:-1], encoding="utf-8")
    return whole


def move_config_away() -> str:
    """Rename the config aside, as vim and nvim save it on Linux."""
    whole = appconfig.path().read_text(encoding="utf-8")
    appconfig.path().rename(appconfig.path().with_name("config.json~"))
    return whole


def unknown() -> str:
    return f"{appconfig.path()} cannot be read as settings"


@pytest.fixture
def relaunched(on, monkeypatch):
    """A Diplomat that read the switch on and quit, leaving the config broken. Name it
    before ``store``: the store is the next Diplomat to start."""
    assert dn.enabled()
    whole = break_config()
    monkeypatch.setattr(dn, "_switch_read", None)
    return whole


def test_a_diplomat_that_starts_on_a_config_it_cannot_read_keeps_the_switch_last_read(
        relaunched, store, daemon, monkeypatch):
    """A new process has read nothing itself: a login, a crash or a self-update on a
    broken file would start agents in terminals and take every offer back."""
    d = daemon(takes_offers("t2"), state=snapshot(offers=[daemon_row("t1")]))
    calls = _spawn_recorder(monkeypatch)
    run = book_network_run()
    broken = appconfig.path().read_text(encoding="utf-8")
    assert json.loads(dn.switch_record().read_text(encoding="utf-8")) == {
        "config": str(appconfig.path()), "networkEnabled": True}
    assert dn.enabled() and store.network_enabled
    drawn = []
    store.network_changed.connect(lambda: drawn.append(dn.settings_unknown()))

    for number, source, forced in ((77, autofix.SOURCE_AUTO, False),
                                   (78, autofix.SOURCE_AUTO, True),
                                   (79, autofix.SOURCE_PANEL, False)):
        refused = store.dispatch_agent(job(number), source, forced=forced)
        assert refused == dn.VERDICT_REFUSED and refused.sentence == unknown()
    with pytest.raises(review.SpawnError, match="the Diplomacy Network is on"):
        store._spawn_tracked("P", None, 77, autofix.SOURCE_AUTO)
    store._settle_agents()
    store._network_cycle_once(1000.0)
    store._settle_agents()
    assert calls == [], "no agent in a terminal"
    assert [path for method, path, _ in d.got if method == "POST"] == [], (
        "nothing withdrawn, and nothing said that a setting decides")
    assert [r.run_id for r in agentregistry.load()] == [run.run_id]
    store.queued_tasks = [autofix.QueuedTask("review-req:o/r#6", job(6), 1)]
    assert store.drainable_tasks and not store._drain_has_room(0)
    assert len(unreadable_notes()) == 1
    assert dn.settings_unknown() == unknown()
    assert store.network_trouble == f"Diplomacy Network: {unknown()}"
    assert drawn[-1] == unknown(), "the panel and the Network screen are redrawn"

    with pytest.raises(OSError):
        store.set_network_enabled(False)
    assert dn.enabled() and appconfig.path().read_text(encoding="utf-8") == broken, (
        "a toggle writes nothing over the file, and moves nothing")

    appconfig.path().write_text(relaunched, encoding="utf-8")
    store._settle_agents()
    assert drawn[-1] == "" and store.network_trouble == ""
    assert dn.settings_unknown() == "" and store._drain_has_room(0)
    assert isinstance(store.dispatch_agent(job(77), autofix.SOURCE_AUTO), dn.Offered)
    assert len(d.sent("offer")) == 1 and calls == []


@pytest.fixture
def never_on(monkeypatch):
    """A broken config where no Diplomat ever read the switch on. Name it before
    ``store``."""
    appconfig.path().write_text('{"networkEnabled": true', encoding="utf-8")
    monkeypatch.setattr(dn, "_switch_read", None)


def test_with_no_switch_on_record_a_broken_config_holds_no_automatic_work(
        never_on, store, daemon, monkeypatch):
    d = daemon(takes_offers())
    calls = _spawn_recorder(monkeypatch)
    assert not dn.enabled() and not store.network_enabled
    assert store.dispatch_agent(job(77), autofix.SOURCE_AUTO) == "spawned"
    store._network_cycle_once(1000.0)
    store._settle_agents()
    assert len(calls) == 1 and d.got == [], "a terminal, as with no network at all"
    assert dn.settings_unknown() == "" and store.network_trouble == ""
    assert not dn.switch_record().exists()


@pytest.mark.parametrize("text", [
    "[]", '[{"networkEnabled": false}]', "null", "7", '"off"', ""])
def test_a_config_that_is_no_object_says_nothing_of_the_switch(store, on, daemon, text):
    """The daemon and its installer take only an object for settings: an array is no
    switch-off to them, and is none here."""
    d = daemon()
    assert dn.enabled()
    appconfig.path().write_text(text, encoding="utf-8")
    assert appconfig.read_known() is None
    assert dn.enabled() and dn.settings_unknown() == unknown()
    store._settle_agents()
    store._network_cycle_once(1000.0)
    assert [path for method, path, _ in d.got if method == "POST"] == []
    assert store.network_trouble == f"Diplomacy Network: {unknown()}"


def test_the_switch_on_record_follows_each_reading_of_the_config(monkeypatch):
    def recorded():
        return atomicjson.read_object(dn.switch_record())

    assert not dn.enabled() and recorded() is None, "never on: nothing is kept"
    appconfig.set_bool(network.ENABLED_KEY, True)
    assert dn.enabled()
    on = {"config": str(appconfig.path()), "networkEnabled": True}
    assert recorded() == on
    wrote = []
    with monkeypatch.context() as patch:
        patch.setattr(atomicjson, "write_atomic", lambda *a: wrote.append(a))
        assert dn.enabled() and dn.enabled() and wrote == [], "written when it moves"
    break_config()
    assert dn.enabled() and recorded() == on

    appconfig.path().write_text('{"networkEnabled": false}', encoding="utf-8")
    assert not dn.enabled() and recorded() == {**on, "networkEnabled": False}
    appconfig.path().write_text("{", encoding="utf-8")
    monkeypatch.setattr(dn, "_switch_read", None)
    assert not dn.enabled(), "off was the last word"

    # A record that is no record, and one of another config, say nothing.
    for text in ("{", "[true]", json.dumps({**on, "networkEnabled": 1}),
                 json.dumps({**on, "config": "/elsewhere/config.json"}),
                 json.dumps({"networkEnabled": True})):
        dn.switch_record().write_text(text, encoding="utf-8")
        monkeypatch.setattr(dn, "_switch_read", None)
        assert not dn.enabled(), text


def test_a_record_that_will_not_save_costs_the_record_not_the_reading(monkeypatch):
    appconfig.set_bool(network.ENABLED_KEY, True)

    def full(*args):
        raise OSError(28, "No space left on device")

    monkeypatch.setattr(atomicjson, "write_atomic", full)
    assert dn.enabled() and not dn.switch_record().exists()


@pytest.fixture
def linked(tmp_path, monkeypatch):
    """The switch on and one root in Settings, a checkout of github.com/o/r read for
    real. The default root, used when Settings list none, is another repository's."""
    root = _checkout(tmp_path / "r", "https://github.com/o/r.git")
    default = _checkout(tmp_path / "default", "https://github.com/o/default.git")
    appconfig.set_repo_roots([root])
    appconfig.set_bool(network.ENABLED_KEY, True)
    monkeypatch.delenv("DIPLOMAT_REPO", raising=False)
    monkeypatch.setattr(review, "default_repo_path", lambda: default)
    monkeypatch.setattr(review, "_roots_cache", None)
    monkeypatch.setattr("diplomat_app.bans.read", lambda: [])
    return root


def test_no_list_of_pools_is_posted_while_the_roots_cannot_be_read(
        store, linked, daemon, installer, monkeypatch):
    """Every setting reads as its default while the file does not parse, the roots
    among them: a list built then names the default root, and the daemon closes each
    pool a list omits."""
    pool = {"id": POOL, "path": linked, "forge": "github", "identity": "alice"}
    d = daemon()
    store._network_cycle_once(1000.0)
    assert d.sent("pools") == [{"pools": [pool]}] and len(d.sent("admit")) == 1

    d.state = has_pools((POOL, linked, "alice"))
    whole = break_config()
    assert dn.enabled() and review.repo_root_paths() != [linked]
    walked, real = [], review.roots_linking
    with monkeypatch.context() as patch:
        patch.setattr(review, "roots_linking", lambda: walked.append(1) or real())
        for at in (1002.0, 1004.0, 1200.0):
            store._network_cycle_once(at)
    assert walked == [], "no checkout is read for a list that will not be said"
    assert d.sent("pools") == [{"pools": [pool]}], "on the timer and with the screen open"
    assert len(d.sent("admit")) == 1, "nor how many tasks a default cap would take"

    # A daemon started since has heard nothing, and is told nothing either.
    d.state = {**d.state, "daemon": {"pid": 8, "startedAt": 1_793_990_500.0}}
    store._network_cycle_once(1250.0)
    assert d.sent("pools") == [{"pools": [pool]}] and len(d.sent("admit")) == 1
    assert lines("network-leave") == []

    appconfig.path().write_text(whole, encoding="utf-8")
    store._network_cycle_once(1300.0)
    assert d.sent("pools") == [{"pools": [pool]}] * 2 and len(d.sent("admit")) == 2
    assert lines("network-leave") == []


def test_a_config_that_breaks_while_the_roots_are_read_posts_no_list(
        store, linked, daemon, monkeypatch):
    d = daemon(state=has_pools((POOL, linked, "alice")))
    real = review.roots_linking

    def breaks():
        break_config()
        return real()

    monkeypatch.setattr(review, "roots_linking", breaks)
    store._network_cycle_once(1000.0)
    assert d.sent("pools") == [] and d.sent("admit") == []


@pytest.mark.parametrize("spoil", [break_config, move_config_away],
                         ids=["truncated", "renamed-away"])
def test_a_read_of_the_config_inside_a_rewrite_of_it_says_nothing_it_read(
        store, linked, daemon, monkeypatch, spoil):
    """A writer that truncates and rewrites in place leaves the file unreadable for a
    moment, and one that renames a new file into place leaves none: a setting read then
    is its default, however the file reads before and after."""
    pool = {"id": POOL, "path": linked, "forge": "github", "identity": "alice"}
    d = daemon(state=has_pools((POOL, linked, "alice")))

    def inside_a_rewrite(real):
        def read(*args):
            whole = spoil()
            try:
                return real(*args)
            finally:
                appconfig.path().write_text(whole, encoding="utf-8")
        return read

    with monkeypatch.context() as patch:
        patch.setattr(review, "roots_linking", inside_a_rewrite(review.roots_linking))
        store._network_cycle_once(1000.0)
    with monkeypatch.context() as patch:
        # The read the "Left" lines judge each path by.
        patch.setattr(store, "_listed_paths", inside_a_rewrite(store._listed_paths))
        store._network_cycle_once(1001.0)
    with monkeypatch.context() as patch:
        patch.setattr(store, "_network_admit", inside_a_rewrite(store._network_admit))
        store._network_cycle_once(1002.0)
    assert d.sent("pools") == [] and d.sent("admit") == [], (
        "the default root's pools, nor the default cap")
    assert lines("network-leave") == []

    store._network_cycle_once(1004.0)
    assert d.sent("pools") == [{"pools": [pool]}] and len(d.sent("admit")) == 1


@pytest.mark.parametrize("spoil", [break_config, move_config_away],
                         ids=["truncated", "renamed-away"])
def test_a_settle_that_reads_the_switch_inside_a_save_withdraws_nothing(
        store, on, daemon, monkeypatch, spoil):
    """Read inside a save, the switch is as it was: not off, so no run is withdrawn -
    not even the one a peer runs."""
    d = daemon(state=snapshot(offers=[offer("t1", "claimed", executor=PEER),
                                      offer("t2", "pooled")]))
    book_network_run("t1", 9)
    book_network_run("t2", 10)
    assert dn.enabled()
    real, first = dn.enabled, []

    def enabled() -> bool:
        if first:
            return real()
        first.append(True)
        whole = spoil()
        try:
            return real()
        finally:
            appconfig.path().write_text(whole, encoding="utf-8")

    monkeypatch.setattr(dn, "enabled", enabled)
    store._settle_agents()
    assert first and d.sent("withdraw") == []
    assert sorted(r.network for r in agentregistry.load()) == ["t1", "t2"]
    assert lines("network-failed") == []


def test_a_config_deleted_for_good_is_the_defaults_once_the_daemon_would_take_it_so(
        store, on, daemon, monkeypatch, installer):
    """Gone past the grace the daemon also gives a config, it is no save under way: the
    switch is off as with the defaults, the runs go as on any switch-off, the feed says
    the file is gone - not that it cannot be read - and Settings draws the switch off."""
    now = [100.0]
    monkeypatch.setattr(appconfig, "_clock", lambda: now[0])
    d = daemon(state=snapshot(offers=[offer("t1", "claimed", executor=PEER)]))
    book_network_run("t1", 9)
    assert dn.enabled()
    store._settle_agents()
    drawn = []
    store.network_changed.connect(lambda: drawn.append(dn.enabled()))
    appconfig.path().unlink()
    store._settle_agents()
    now[0] = 104.9
    store._settle_agents()
    store._network_cycle_once(104.9)
    assert dn.enabled() and d.sent("withdraw") == [] and len(agentregistry.load()) == 1
    assert unreadable_notes() == [] and lines("warn") == [], "a save under way says nothing"

    now[0] = 105.0
    store._settle_agents()
    assert not dn.enabled() and not store.network_enabled
    assert d.sent("withdraw") == [{"taskId": "t1", "reason": "switched off"}]
    assert agentregistry.load() == []
    assert lines("network-failed") == [
        "Auto · Review · #9 - withdrawn: the Diplomacy Network was switched off"]
    assert lines("warn") == [f"{appconfig.path()} is gone: settings are the defaults"]
    assert drawn and drawn[-1] is False, "Settings and the Network screen draw it off"
    assert not dn.switch_record().exists()
    store._settle_agents()
    assert len(lines("warn")) == 1, "said once"

    # A Diplomat started later reads the defaults at once.
    monkeypatch.setattr(appconfig, "_read_paths", set())
    monkeypatch.setattr(dn, "_switch_read", None)
    counted = appconfig.unreadable_reads()
    assert not dn.enabled() and dn.settings_unknown() == ""
    assert appconfig.unreadable_reads() == counted


def test_no_daemon_is_started_while_the_settings_are_unknown(store, linked, installer):
    """A daemon started on a config it cannot read switches itself off within seconds:
    started on each silence, it would come and go for as long as the file stays broken."""
    assert dn.enabled()
    whole = break_config()
    assert dn.settings_unknown()
    for at in (1000.0, 1001.0, 1100.0):
        store._network_cycle_once(at)
    store.start_network_async()
    store.restart_network_async()
    assert store.wait_for_background() == []
    assert installer == [] and lines("network-start") == []

    appconfig.path().write_text(whole, encoding="utf-8")
    store._network_cycle_once(1101.0)
    assert installer == [("install.js", "--start-daemon")], (
        "on the first cycle the file reads, no wait run up meanwhile")


def test_an_offer_the_daemon_had_not_answered_is_settled_while_the_settings_are_unknown(
        store, on, daemon):
    """It was made of settings that were read: left unsettled, the job the daemon holds
    would end unbooked, and be offered a second time."""
    d = daemon({"/offer": (500, {})})
    store.dispatch_agent(job(), autofix.SOURCE_PANEL)
    assert len(store.network_offering) == 1
    break_config()
    d.state = snapshot(offers=[daemon_row("t7")])
    store._network_cycle_once(1000.0)
    assert store.network_offering == []
    assert [(r.network, r.pr_number) for r in agentregistry.load()] == [("t7", 9)]
    assert [path for method, path, _ in d.got if method == "POST"] == ["/offer"], (
        "the one offer made before, and nothing a setting decides")


def pool_task(task, **fields) -> network.PoolTask:
    return network.PoolTask(task_id=task, kind="review", item="pr-9", title="Review · #9",
                            state="claimed", **fields)


def test_stop_ends_the_run_here_and_otherwise_withdraws(store, on, daemon):
    d = daemon(state=snapshot(runs=[{"runId": "r-7", "taskId": "t1", "state": "running"},
                                    {"runId": "r-6", "taskId": "t1", "state": "failed"},
                                    {"runId": "r-5", "taskId": "t3", "state": "finished"}]))
    # The first runs here. The second runs elsewhere: its offer is taken back. The
    # third's run here has ended since the screen drew it: there is nothing to stop,
    # and the offer its button never spoke of stays.
    for task in (pool_task("t1", executor=ME, executor_here=True),
                 pool_task("t2", executor=PEER, offered_here=True),
                 pool_task("t3", executor=ME, executor_here=True)):
        store.stop_network_task_async(task, POOL)
        assert store.wait_for_background() == []
    assert d.sent("stop-run") == [{"runId": "r-7"}]
    assert d.sent("withdraw") == [{"taskId": "t2", "reason": "stopped"}]
    assert lines("network-stop") == [
        "Review · #9 - its run on this machine was stopped and the job is back in the pool"]
    assert lines("network-withdraw") == ["Review · #9 - withdrawn (stopped)"]
    settled = "/state"  # each stop ends in a settle, which reads the daemon itself
    assert [path for _, path, _ in d.got] == [
        "/state", "/stop-run", settled, "/withdraw", settled,
        "/state", settled], "asked afresh for a task this machine runs"
    assert store.network_refusals == {POOL: "That job's run on this machine has already ended."}
    assert dn.RUN_ENDED == store.network_refusals[POOL]


def test_stop_of_a_run_the_daemon_does_not_show_withdraws_nothing(store, on):
    """The read timed out, or the daemon is down: Stop said the job goes back to the
    pool, and a withdrawal would cancel this machine's own offer instead."""
    store.stop_network_task_async(
        pool_task("t1", executor=ME, executor_here=True, offered_here=True), POOL)
    assert store.wait_for_background() == []
    assert store.network_refusals == {POOL: dn.NOT_ANSWERING}
    assert lines("network-withdraw") == []


def test_a_run_booked_while_the_daemon_is_asked_is_not_judged_by_that_answer(
        store, on, monkeypatch):
    """The book is read before the daemon is asked: a snapshot older than an offer says
    nothing of its run, and a row that ended before it must not end it."""
    stale = network.Snapshot.from_json(
        snapshot(offers=[daemon_row("t1", "failed", reason="the container exited 137")]))

    def state():
        book_network_run("t1")
        return stale

    monkeypatch.setattr(dn, "state", state)
    store._settle_agents()
    assert [r.network for r in agentregistry.load()] == ["t1"]
    assert lines("network-failed") == []


def test_a_stop_the_daemon_refuses_is_shown_in_its_pool(store, on, daemon):
    daemon({"/withdraw": (409, {"error": "That task is not this machine's."})})
    store.stop_network_task_async(pool_task("t2", offered_here=True), POOL)
    assert store.wait_for_background() == []
    assert store.network_refusals == {POOL: "That task is not this machine's."}
    assert lines("network-withdraw") == [
        "Review · #9 - not withdrawn: That task is not this machine's."]


def test_forget_leaves_a_local_run_alone(store, on, daemon):
    d = daemon()
    local = agentregistry.create_run(agentstate.RunRecord(
        run_id="local-1", dispatched_at=time.time(), pr_number=4), "P")
    store.forget_network_run_async(local.run_id)
    assert store.wait_for_background() == []
    assert [m for m, _, _ in d.got] == [] and len(agentregistry.load()) == 1


def test_forgetting_a_run_with_the_switch_off_asks_the_daemon_for_no_state(store, daemon):
    d = daemon(state=snapshot(offers=[offer("t1", "pooled")]))
    run = book_network_run()
    store.forget_network_run_async(run.run_id)
    assert store.wait_for_background() == []
    assert [path for _, path, _ in d.got if path == "/state"] == []


def test_a_held_offer_the_switch_emptied_while_it_was_sent_is_not_booked(store, on, daemon,
                                                                         monkeypatch):
    d = daemon({"/offer": (500, {})})
    store.dispatch_agent(job(ledger_key="review:o/r#9"), autofix.SOURCE_PANEL)
    assert len(store.network_offering) == 1
    d.routes.update(takes_offers())
    send = dn.send

    def as_the_switch_goes_off(route, body=None, **kw):
        reply = send(route, body, **kw)
        if route == network.ROUTE_OFFER:
            store.network_offering = []
        return reply

    monkeypatch.setattr(dn, "send", as_the_switch_goes_off)
    store._network_cycle()
    assert len(d.sent("offer")) == 2
    assert agentregistry.load() == [] and store.network_offering == []
    assert lines("network-offer") == []


def test_a_task_that_runs_again_after_the_switch_went_off_is_said_again(store, on, daemon,
                                                                        monkeypatch):
    daemon(state=snapshot(offers=[offer("t1", "claimed", executor=PEER)]))
    monkeypatch.setattr(da, "run_installer",
                        lambda script, arg: {"daemonRunning": arg != "--stop-daemon"})
    for said in (1, 2):
        book_network_run("t1", 9)
        store._network_cycle()
        store._network_cycle()
        assert len(lines("network-claimed")) == said
        store.set_network_enabled(False)
        assert store.wait_for_background() == []
        assert agentregistry.load() == []
        store.set_network_enabled(True)
        assert store.wait_for_background() == []


# MARK: - the switch going off

def test_switching_off_takes_every_offer_back_and_frees_its_item(store, on, daemon,
                                                                 monkeypatch):
    d = daemon(state=snapshot(offers=[
        offer("t1", "claimed", executor=PEER),
        offer("t2", "done", executor=PEER, endedAt=1_794_000_000.0,
              outcome={"ok": True, "tokens": 70, "runner": "claude"}),
        offer("t3", "pooled")]))
    calls = _spawn_recorder(monkeypatch)
    at_stop = []
    monkeypatch.setattr(da, "run_installer", lambda script, arg: (
        at_stop.append((arg, len(d.sent("withdraw")))), {"daemonRunning": False})[1])
    store.auto_task_limit = 8
    book_network_run("t1", 9)
    book_network_run("t2", 10, ledger_key="review:o/r#10")
    book_network_run("t3", 11)
    book_network_run("t4", 12)  # the daemon holds no offer of it
    local = agentregistry.create_run(agentstate.RunRecord(
        run_id="local-1", dispatched_at=time.time(), pr_number=4,
        pr_url="https://github.com/o/r/pull/4", pid=4242, tty="pts/4"), "P")
    fake_probes(monkeypatch, processes={local.pid: agentstate.ProcInfo(
        tty="pts/4", elapsed=5.0, is_agent=True)})
    merged(store, 11)

    store.set_network_enabled(False)
    assert store.wait_for_background() == []

    assert sorted((b["taskId"], b["reason"]) for b in d.sent("withdraw")) == [
        ("t1", "switched off"), ("t3", "merged"), ("t4", "switched off")]
    assert at_stop == [("--stop-daemon", 3)], "asked before the daemon is stopped"
    assert [r.run_id for r in agentregistry.load()] == ["local-1"]
    assert sorted(lines("network-failed")) == [
        f"Auto · Review · #{n} - withdrawn: the Diplomacy Network was switched off"
        for n in (12, 9)]
    assert lines("network-withdraw") == [
        "Auto · Review · #11 - its PR merged, so its offer is withdrawn"]
    assert len(lines("network-done")) == 1, "the one that had ended is settled as it would be"
    assert [e["tokens"] for e in ledger() if e["ev"] == "done"] == [70]

    # Its PR is free for an agent of this machine at once.
    assert store.dispatch_agent(job(9), autofix.SOURCE_AUTO) == "spawned"
    assert len(calls) == 1 and d.sent("offer") == []


def test_switching_off_drops_the_runs_of_a_daemon_that_does_not_answer(store, on, installer):
    book_network_run("t1", 9)
    store.set_network_enabled(False)
    assert store.wait_for_background() == []
    assert agentregistry.load() == []
    assert lines("network-failed") == [
        "Auto · Review · #9 - withdrawn: the Diplomacy Network was switched off"]
    assert installer == [("install.js", "--stop-daemon")]


def test_switching_off_sends_no_withdrawal_to_a_daemon_that_gave_no_snapshot(store, daemon):
    d = daemon()
    d.state = None
    book_network_run("t1", 9)
    store._settle_agents()
    assert agentregistry.load() == [] and d.sent("withdraw") == []
    assert lines("network-failed") == [
        "Auto · Review · #9 - withdrawn: the Diplomacy Network was switched off"]


def test_a_run_still_booked_with_the_switch_off_is_dropped_by_the_next_settle(store, daemon):
    d = daemon()
    book_network_run("t1", 9)
    store._settle_agents()
    assert agentregistry.load() == []
    assert d.sent("withdraw") == [{"taskId": "t1", "reason": "switched off"}]
    assert lines("network-failed") == [
        "Auto · Review · #9 - withdrawn: the Diplomacy Network was switched off"]
    del d.got[:]
    store._settle_agents()
    assert d.got == [], "with none booked, nothing is asked"


# MARK: - an ask is answered by work that ran, not by its offer

def names_tasks():
    return {"/offer": lambda body: (200, {"taskId": "t-" + body["item"]})}


def asks(store) -> list[tuple[int, str]]:
    return [(w.number, w.offered) for w in store.requested_work]


def swept(store, d, monkeypatch) -> None:
    store.request_review_sweep(_sweep(store))
    d.state = snapshot(offers=[offer("t-pr-1"), offer("t-pr-2")])
    _poll(store, monkeypatch)
    assert [b["item"] for b in d.sent("offer")] == ["pr-1", "pr-2"]


def test_an_offered_ask_stands_and_is_not_offered_twice(swept_store, on, daemon, monkeypatch):
    d = daemon(names_tasks())
    _spawn_recorder(monkeypatch)
    swept(swept_store, d, monkeypatch)
    assert asks(swept_store) == [(1, "t-pr-1"), (2, "t-pr-2")]

    _poll(swept_store, monkeypatch)
    _poll(swept_store, monkeypatch)
    assert len(d.sent("offer")) == 2 and swept_store.queued_tasks == []
    assert len(agentregistry.load()) == 2
    # The mark is stored with the ask: a restart reads it back.
    from diplomat_app.store import Store
    assert asks(Store()) == [(1, "t-pr-1"), (2, "t-pr-2")]


def test_asks_whose_offers_never_ran_are_started_here_once_the_switch_is_off(
        swept_store, on, daemon, monkeypatch):
    d = daemon(names_tasks())
    calls = _spawn_recorder(monkeypatch)
    monkeypatch.setattr(da, "run_installer", lambda script, arg: {"daemonRunning": False})
    swept(swept_store, d, monkeypatch)

    swept_store.set_network_enabled(False)
    assert swept_store.wait_for_background() == []
    assert sorted(b["taskId"] for b in d.sent("withdraw")) == ["t-pr-1", "t-pr-2"]
    assert agentregistry.load() == [] and calls == []

    _poll(swept_store, monkeypatch)
    assert asks(swept_store) == [(1, ""), (2, "")], "each ask is as it was before its offer"
    assert [t.job.pr_number for t in swept_store.queued_tasks] == [1, 2]
    _poll(swept_store, monkeypatch)
    assert [c["prompt"] for c in calls] == ["PROMPT:review:1", "PROMPT:review:2"]
    assert asks(swept_store) == [] and len(d.sent("offer")) == 2
    assert all(r.network is None for r in agentregistry.load())


def test_an_ask_is_forgotten_when_its_network_run_finishes(swept_store, on, daemon, monkeypatch):
    d = daemon(names_tasks())
    _spawn_recorder(monkeypatch)
    swept(swept_store, d, monkeypatch)
    d.state = snapshot(offers=[
        offer("t-pr-1", "done", executor=PEER, executorHere=False, outcome={"ok": True}),
        offer("t-pr-2")])
    swept_store._settle_agents()
    assert asks(swept_store) == [(2, "t-pr-2")]
    _poll(swept_store, monkeypatch)
    assert len(d.sent("offer")) == 2, "a finished review is not asked for again"


@pytest.mark.parametrize("ended", [
    offer("t-pr-1", "failed", reason="the container exited 137"),
    offer("t-pr-1", "done", executor=PEER, executorHere=False, outcome={"ok": False}),
])
def test_an_ask_whose_offer_used_its_attempts_is_not_offered_again(
        swept_store, on, daemon, monkeypatch, ended):
    d = daemon(names_tasks())
    _spawn_recorder(monkeypatch)
    swept(swept_store, d, monkeypatch)
    d.state = snapshot(offers=[ended, offer("t-pr-2")])
    swept_store._settle_agents()
    assert [r.network for r in agentregistry.load()] == ["t-pr-2"]
    assert asks(swept_store) == [(2, "t-pr-2")], "ended, as by a run here that came to nothing"
    for _ in range(3):
        _poll(swept_store, monkeypatch)
    assert [b["item"] for b in d.sent("offer")] == ["pr-1", "pr-2"]


@pytest.mark.parametrize("ended", [
    offer("t-pr-1", "cancelled", reason="pool closed"),
    None,  # the daemon holds no such offer any more
])
def test_an_ask_whose_offer_ended_unrun_is_offered_again(swept_store, on, daemon,
                                                         monkeypatch, ended):
    d = daemon(names_tasks())
    _spawn_recorder(monkeypatch)
    swept(swept_store, d, monkeypatch)
    d.state = snapshot(offers=[o for o in (ended, offer("t-pr-2")) if o])
    # Past the grace a snapshot has to list a new offer in.
    agentregistry.update(lambda book: [
        dataclasses.replace(r, dispatched_at=r.dispatched_at - 600) for r in book])
    swept_store._settle_agents()
    assert [r.network for r in agentregistry.load()] == ["t-pr-2"]
    assert asks(swept_store) == [(1, "t-pr-1"), (2, "t-pr-2")], "kept: the work did not run"

    _poll(swept_store, monkeypatch)  # the ask is back in the queue
    assert asks(swept_store) == [(1, ""), (2, "t-pr-2")]
    _poll(swept_store, monkeypatch)  # and the drain offers it
    assert [b["item"] for b in d.sent("offer")] == ["pr-1", "pr-2", "pr-1"]


def test_an_offer_the_operator_takes_back_takes_its_ask_with_it(swept_store, on, daemon,
                                                                monkeypatch):
    d = daemon(names_tasks())
    _spawn_recorder(monkeypatch)
    swept(swept_store, d, monkeypatch)

    swept_store.stop_network_task_async(pool_task("t-pr-1"), POOL)
    assert swept_store.wait_for_background() == []
    assert asks(swept_store) == [(2, "t-pr-2")]

    run = next(r for r in agentregistry.load() if r.network == "t-pr-2")
    swept_store.forget_network_run_async(run.run_id)
    assert swept_store.wait_for_background() == []
    assert asks(swept_store) == []


def test_a_withdraw_the_daemon_refused_keeps_the_ask(swept_store, on, daemon, monkeypatch):
    d = daemon({**names_tasks(), "/withdraw": (409, {"error": "The task is not yours."})})
    _spawn_recorder(monkeypatch)
    swept(swept_store, d, monkeypatch)
    swept_store.stop_network_task_async(pool_task("t-pr-1"), POOL)
    assert swept_store.wait_for_background() == []
    assert asks(swept_store) == [(1, "t-pr-1"), (2, "t-pr-2")]


# MARK: - the Pipeline's asks the network carries

LINEAR = "https://linear.app/acme/issue/ENG-12/a-thing"
ISSUE = "https://github.com/o/r/issues/12"


def numbers_tasks():
    """A new task per offer, as the daemon makes of one naming no PR."""
    made = iter(range(1, 100))
    return {"/offer": lambda body: (200, {"taskId": f"t{next(made)}"})}


def pipeline_linear(text="A thing\n\nIt breaks.") -> dict:
    return {"kind": "fixLinear", "repo": "o/r", "identifier": "ENG-12", "url": LINEAR,
            "text": text, "key": f"pipeline-fix:{LINEAR}", "stamp": "fix"}


def pipeline_fix() -> dict:
    return {"kind": "fixIssue", "repo": "o/r", "number": 12, "url": ISSUE, "author": "carol",
            "key": f"pipeline-fix:{ISSUE}", "stamp": "fix"}


def pipeline_sync(store, *effects) -> None:
    store._apply_pipeline_sync({"result": {
        "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "items": [],
        "graph": {"nodes": [], "edges": []}, "effects": list(effects), "events": [],
        "notices": [], "unread": [], "fixable": [], "read": []},
        "forced": {}, "started": 0, "epoch": store._pipeline_epoch})


def offered_by_the_pipeline(store, d, monkeypatch, effect) -> None:
    store.pipeline_enabled = store.pipeline_fix = True
    pipeline_sync(store, effect)
    _poll(store, monkeypatch)
    assert [w.offered for w in store.requested_work] == ["t1"]
    d.state = snapshot(offers=[offer("t1", "claimed", executor=PEER)])


def test_a_linear_fix_the_network_carries_is_not_offered_again_as_its_text_changes(
        store, on, daemon, monkeypatch):
    d = daemon(numbers_tasks())
    calls = _spawn_recorder(monkeypatch)
    # The text is in the prompt, and so in the item a Linear fix is offered as.
    monkeypatch.setattr("diplomat_runtime.promptcore.build_prompt", json.dumps)
    offered_by_the_pipeline(store, d, monkeypatch, pipeline_linear())

    pipeline_sync(store, pipeline_linear("A thing\n\nIt breaks twice."))
    _poll(store, monkeypatch)
    _poll(store, monkeypatch)
    assert len(d.sent("offer")) == 1 and calls == []
    assert [(w.offered, w.config["linear"]["text"]) for w in store.requested_work] == [
        ("t1", "A thing\n\nIt breaks.")]
    assert store.queued_tasks == [] and lines("pipeline-fix") == ["Issues · ENG-12 · deep queued"]


def test_an_ask_the_pipeline_no_longer_owes_takes_its_offer_back(store, on, daemon,
                                                                  monkeypatch):
    d = daemon(numbers_tasks())
    _spawn_recorder(monkeypatch)
    offered_by_the_pipeline(store, d, monkeypatch, pipeline_fix())

    pipeline_sync(store)
    assert store.wait_for_background() == []
    assert d.sent("withdraw") == [{"taskId": "t1", "reason": network.WITHDRAW_NOT_OWED}]
    assert store.requested_work == [] and lines("queue-drop") == []
    assert lines("network-withdraw") == ["Issues · #12 · deep - withdrawn (no longer owed)"]

    d.state = snapshot(offers=[offer("t1", "cancelled", reason=network.WITHDRAW_NOT_OWED)])
    store._settle_agents()
    _poll(store, monkeypatch)
    assert agentregistry.load() == [] and len(d.sent("offer")) == 1


def test_an_ask_the_pipeline_no_longer_owes_takes_back_only_an_offer_still_held(
        store, on, daemon, monkeypatch):
    d = daemon(numbers_tasks())
    _spawn_recorder(monkeypatch)
    offered_by_the_pipeline(store, d, monkeypatch, pipeline_fix())
    d.state = snapshot(offers=[offer("t1", "done", executor=PEER, outcome={"ok": True})])

    pipeline_sync(store)
    assert store.wait_for_background() == []
    assert d.sent("withdraw") == [] and store.requested_work == []


# MARK: - the three calls of the Network screen

def test_invite_join_and_leave_post_and_are_logged(store, on, daemon):
    d = daemon({"/invite": (200, {"invite": "dn1-secret"}), "/join": (200, {"pool": POOL})})
    invited, joined = [], []
    store.network_invited.connect(lambda pool, invite: invited.append((pool, invite)),
                                  Qt.ConnectionType.DirectConnection)
    store.network_joined.connect(lambda card, ok: joined.append((card, ok)),
                                 Qt.ConnectionType.DirectConnection)
    store.network_invite_async(POOL)
    assert store.wait_for_background() == []
    store.network_join_async("dn1-other", "")
    assert store.wait_for_background() == []
    store.network_leave_async(POOL)
    assert store.wait_for_background() == []
    assert invited == [(POOL, "dn1-secret")] and joined == [("", True)]
    assert (d.sent("invite"), d.sent("join"), d.sent("leave")) == (
        [{"pool": POOL}], [{"invite": "dn1-other"}], [{"pool": POOL}])
    assert [(e.action, e.detail) for e in activity.read()
            if e.action in ("network-invite", "network-join", "network-leave")] == [
        ("network-leave", f"Left {POOL}"), ("network-join", f"Joining {POOL}: the machine that made the invite seats this one "
                         "once it is reached"),
        ("network-invite", f"Made an invite to {POOL}")]
    assert "dn1-secret" not in json.dumps([e.detail for e in activity.read()])
    assert store.network_refusals == {}


def test_rejoining_a_pool_names_it_and_is_a_join_in_the_feed(store, on, daemon):
    d = daemon({"/join": (200, {"pool": POOL})})
    joined = []
    store.network_joined.connect(lambda card, ok: joined.append((card, ok)),
                                 Qt.ConnectionType.DirectConnection)
    store.network_rejoin_async(POOL)
    assert store.wait_for_background() == []
    assert d.sent("join") == [{"pool": POOL}]
    assert lines("network-join") == [f"Rejoined {POOL}"] and store.network_refusals == {}
    d.routes["/join"] = (409, {"error": "That repository is not linked."})
    store.network_rejoin_async(POOL)
    assert store.wait_for_background() == []
    assert store.network_refusals == {POOL: "That repository is not linked."}
    assert joined == [(POOL, True), (POOL, False)] and len(lines("network-join")) == 1


def test_a_call_the_daemon_refuses_is_kept_for_its_panel_and_logs_nothing(store, on, daemon):
    d = daemon({"/join": (400, {"error": "That invite has expired."}),
                "/invite": (200, {}), "/leave": (409, {"error": "Not in that pool."})})
    joined = []
    store.network_joined.connect(lambda card, ok: joined.append((card, ok)),
                                 Qt.ConnectionType.DirectConnection)
    store.network_join_async("dn1-old", "")
    store.network_invite_async(POOL)
    assert store.wait_for_background() == []
    assert store.network_refusals == {"": "That invite has expired.",
                                      POOL: "the daemon gave no invite"}
    store.network_leave_async(POOL)
    assert store.wait_for_background() == []
    assert store.network_refusals[POOL] == "Not in that pool."
    assert joined == [("", False)]
    assert lines("network-join") + lines("network-invite") + lines("network-leave") == []

    # The next one that goes through clears what its panel was showing.
    d.routes["/leave"] = (200, {})
    store.network_leave_async(POOL)
    assert store.wait_for_background() == []
    assert store.network_refusals == {"": "That invite has expired."}


# MARK: - the node the network took the place of

@pytest.mark.parametrize("argv, legacy", [
    (["python3", "-m", "szpontnet"], True),
    (["/opt/venv/bin/python", "-u", "-m", "szpontnet", "--port", "7"], True),
    (["/home/u/szpontnet/bin/python", "-m", "diplomat_app"], False),
    (["python3", "/opt/szpontnet/run.py"], False),
    (["python3", "-m", "szpontnet.cli"], False),
    (["python3", "-m", "szpontnet_tools"], False),
    (["python3", "-m", "pytest", "szpontnet"], False),
    (["szpontnet", "-m"], False),
    (["python3", "-um", "szpontnet"], False),
    ([], False),
])
def test_only_the_exact_module_is_the_legacy_node(argv, legacy):
    assert dn._is_legacy_node(argv) is legacy


@pytest.fixture
def mesh(monkeypatch):
    """The retired node's directory, a process table and the signals sent: a pid that
    is signalled leaves the table unless it is in ``deaf``."""
    world = SimpleNamespace(
        dir=dn.legacy_dir(), deaf=set(), killed=[],
        table={11: ["python3", "-m", "szpontnet"],
               12: ["python3", "-m", "szpontnet", "--port", "7"],
               13: ["python3", "-m", "diplomat_app"]})

    def kill(pid):
        world.killed.append(pid)
        if pid not in world.deaf:
            del world.table[pid]

    def names(pid):
        world.dir.mkdir(parents=True, exist_ok=True)
        (world.dir / "device.key").write_text("secret")
        (world.dir / "state.json").write_text(json.dumps({"pid": pid}))

    def linked(pid):
        behind = world.dir.with_name("mesh-elsewhere")
        behind.mkdir()
        (behind / "device.key").write_text("secret")
        (behind / "state.json").write_text(json.dumps({"pid": pid}))
        world.dir.symlink_to(behind, target_is_directory=True)
        return behind

    world.linked = linked

    world.names = names
    monkeypatch.setattr(procscan, "scan_own_pids",
                        lambda match: {pid for pid in world.table if match(pid)})
    monkeypatch.setattr(procscan, "cmdline_tokens", lambda pid: world.table[pid])
    monkeypatch.setattr(dn, "_terminate", kill)
    monkeypatch.setattr(dn, "LEGACY_EXIT_SECS", 0.3)
    return world


def test_the_launch_ends_the_node_its_directory_names_and_removes_the_directory(store, mesh):
    mesh.names(11)

    store.retire_legacy_node_async()
    assert store.wait_for_background() == []
    assert mesh.killed == [11], "another -m szpontnet, kept elsewhere, is its operator's own"
    assert not mesh.dir.exists()
    assert lines("network-stop") == [
        f"Ended the retired mesh node (pid 11) and removed {mesh.dir}, the retired "
        "mesh's state and keys"]

    store.retire_legacy_node_async()
    assert store.wait_for_background() == []
    assert mesh.killed == [11] and len(lines("network-stop")) == 1


@pytest.mark.parametrize("state, impostor", [
    ('{"pid": 13}', None), ('{"pid": 99}', None), ('{"pid": "11"}', None),
    ('{"pid": true}', True), ('{"pid": 11.0}', None), ("[11]", None), ("{ not json", None),
    (None, None),
    # No number a process of this user's can have, whatever answers for it.
    ('{"pid": 0}', 0), ('{"pid": -1}', -1), ('{"pid": 1}', None), ('{"pid": 1.0}', 1),
    ('{"pid": "7"}', 7), ('{"pid": [1]}', 1), ('{"pid": 2147483648}', 2 ** 31),
    ('{"pid": 4294967296}', 2 ** 32), ('{"pid": 4294967307}', 2 ** 32 + 11),
    ('{"pid": 99999999999999999999999}', 99999999999999999999999),
    ('{"pid": %d}' % os.getpid(), os.getpid())])
def test_a_directory_that_names_no_running_node_is_removed_and_nothing_is_signalled(
        store, mesh, state, impostor):
    mesh.names(11)
    if state is None:
        (mesh.dir / "state.json").unlink()
    else:
        (mesh.dir / "state.json").write_text(state)
    if impostor is not None:
        mesh.table[impostor] = mesh.table[11]

    store.retire_legacy_node_async()
    assert store.wait_for_background() == []
    assert mesh.killed == [] and not mesh.dir.exists()
    assert lines("network-stop") == [
        f"Removed {mesh.dir}, the retired mesh's state and keys"]


def test_a_node_that_does_not_quit_keeps_its_directory_for_the_next_launch(store, mesh):
    mesh.names(11)
    mesh.deaf.add(11)

    began = time.monotonic()
    store.retire_legacy_node_async()
    assert store.wait_for_background() == []
    assert 0.3 <= time.monotonic() - began < 3
    assert mesh.killed == [11] and (mesh.dir / "device.key").exists()
    assert lines("network-stop") == [
        f"Asked the retired mesh node (pid 11) to quit: {mesh.dir} is removed once it has"]

    mesh.deaf.clear()
    store.retire_legacy_node_async()
    assert store.wait_for_background() == []
    assert mesh.killed == [11, 11] and not mesh.dir.exists()


@pytest.mark.parametrize("pid, node", [
    (13, "Removed"), (11, "Ended the retired mesh node (pid 11) and removed")])
def test_a_directory_that_is_a_link_loses_the_link_and_keeps_what_it_leads_to(
        store, mesh, pid, node):
    behind = mesh.linked(pid)

    store.retire_legacy_node_async()
    assert store.wait_for_background() == []
    assert mesh.killed == ([11] if pid == 11 else [])
    assert not mesh.dir.is_symlink() and (behind / "device.key").read_text() == "secret"
    assert lines("network-stop") == [
        f"{node} the link {mesh.dir}: what it leads to, the retired mesh's state and "
        "keys, is left as it is"]

    store.retire_legacy_node_async()
    assert store.wait_for_background() == []
    assert len(lines("network-stop")) == 1, "said once: the next launch finds nothing"


def test_no_directory_is_no_node_whatever_runs(store, mesh):
    store.retire_legacy_node_async()
    assert store.wait_for_background() == []
    assert mesh.killed == [] and lines("network-stop") == []


def test_a_signal_that_fails_is_no_node_asked(mesh, monkeypatch):
    mesh.names(11)

    def gone(pid):
        del mesh.table[pid]
        raise ProcessLookupError(pid)

    monkeypatch.setattr(dn, "_terminate", gone)
    assert dn.retire_legacy_node() == (None, mesh.dir, False)


def test_the_suite_reaches_no_real_mesh_directory_and_signals_nothing(tmp_path):
    assert dn.legacy_dir() == tmp_path / "mesh"
    assert dn._terminate.__name__ == "no_signal"


# MARK: - containers in the process table

def _fake_cgroups(monkeypatch, tmp_path, cgroups: dict[int, str]) -> None:
    for pid, text in cgroups.items():
        (tmp_path / "proc" / str(pid)).mkdir(parents=True)
        (tmp_path / "proc" / str(pid) / "cgroup").write_text(text)
    monkeypatch.setattr(procscan, "Path", lambda p: tmp_path / str(p).lstrip("/"))


@pytest.mark.parametrize("cgroup, inside", [
    ("0::/system.slice/docker-" + "ab12" * 16 + ".scope\n", True),
    ("12:pids:/docker/" + "ab12" * 16 + "\n1:name=systemd:/docker/" + "ab12" * 16 + "\n", True),
    ("0::/machine.slice/libpod-" + "0f" * 32 + ".scope/container\n", True),
    ("0::/system.slice/cri-containerd-" + "0f" * 32 + ".scope\n", True),
    ("0::/user.slice/user-1000.slice/session-3.scope\n", False),
    ("0::/system.slice/docker.service\n", False),
    ("0::/user.slice/app-docker-compose.scope\n", False),
    ("", False),
])
def test_a_container_is_told_by_its_cgroup(monkeypatch, tmp_path, cgroup, inside):
    _fake_cgroups(monkeypatch, tmp_path, {7: cgroup})
    assert procscan.in_container(7) is inside
    assert procscan.in_container(8) is False, "no cgroup to read: not known to be in one"


def test_an_agent_in_a_container_is_no_agent_of_this_machine(monkeypatch, tmp_path):
    """The host's ``ps`` lists a container's processes too: a network job naming its PR
    would be found as an untracked agent and hold a bay for work counted as a network
    run."""
    _fake_cgroups(monkeypatch, tmp_path, {
        100: "0::/user.slice/user-1000.slice/session-3.scope\n",
        200: "0::/system.slice/docker-" + "ab12" * 16 + ".scope\n"})
    dump = agentstate.Observation.present(
        "  100 pts/1  60 claude Review PR #5 in o/r. Use the `gh` CLI.\n"
        "  200 ?      60 claude Review PR #6 in o/r. Use the `gh` CLI.\n")
    assert probes.live_agents(dump, {"o/r"}).value == {"o/r#5": "pts/1"}


# MARK: - launch, and the agent dump

@pytest.mark.parametrize("switch", [True, False])
def test_launch_retires_the_legacy_node_always_and_starts_the_daemon_only_when_on(
        monkeypatch, switch):
    from diplomat_app import app as app_module

    called, timers = [], []

    class _Anything:
        def __getattr__(self, name):
            return _Anything()

        def __call__(self, *args, **kwargs):
            return _Anything()

    class _Timer(_Anything):
        def __init__(self):
            self.slots = []
            self.timeout = SimpleNamespace(connect=self.slots.append)
            timers.append(self)

        def setInterval(self, ms):  # noqa: N802
            self.interval = ms

        @staticmethod
        def singleShot(*args, **kwargs):  # noqa: N802
            pass

    class _Store:
        autofix_poll_started = _Anything()
        network_enabled = switch

        def __getattr__(self, name):
            return lambda *args, **kwargs: called.append(name)

    for name in ("QApplication", "Panel", "_app_icon"):
        monkeypatch.setattr(app_module, name, _Anything())
    monkeypatch.setattr(app_module, "QTimer", _Timer)
    monkeypatch.setattr(app_module, "Store", _Store)
    monkeypatch.setattr(app_module.DiplomatApp, "_build_tray", lambda self: None)
    monkeypatch.setattr(app_module.DiplomatApp, "trigger_refresh", lambda self: None)
    monkeypatch.delenv("DIPLOMAT_PREFILL", raising=False)

    app = app_module.DiplomatApp()

    assert called.count("retire_legacy_node_async") == 1
    assert called.count("start_network_async") == (1 if switch else 0)
    assert app.network_timer.interval == 30_000 < 2 * 60_000, (
        "well inside the two minutes after which the daemon takes no task")
    del called[:]
    for slot in app.network_timer.slots:
        slot()
    assert called == ["run_network_cycle_async"]


def test_the_agent_dump_asks_the_daemon_only_while_the_switch_is_on(
        daemon, monkeypatch, capsys):
    from diplomat_app import agentdump

    fake_probes(monkeypatch)
    book_network_run()
    d = daemon(state=snapshot(offers=[offer(state="claimed", executor=PEER)]))
    agentdump.run()
    out = capsys.readouterr().out
    assert d.got == [] and "  network " not in out
    assert ("because: the network could not be asked: "
            "the Diplomacy Network is switched off") in out

    appconfig.set_bool(network.ENABLED_KEY, True)
    agentdump.run()
    out = capsys.readouterr().out
    assert "  network         ok (1 item)" in out
    assert "because: running on 9f3c1a77" in out

    d.close()
    agentdump.run()
    out = capsys.readouterr().out
    assert f"  network         UNAVAILABLE — {network.UNANSWERED}" in out
