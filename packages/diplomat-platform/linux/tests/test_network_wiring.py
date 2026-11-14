"""The Diplomacy Network in the applet: what each monitor cycle tells the daemon, the
dispatch gate that offers a job where a spawn would be, and what becomes of the run
the network then carries. Against a fake daemon - a real HTTP server on a unix socket in
a scratch dir - and the spawn seam, which nothing here may reach.
"""

from __future__ import annotations

import dataclasses
import json
import os
import shutil
import signal
import socketserver
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler
from types import SimpleNamespace

import pytest

from diplomat_runtime import (
    activity,
    agentregistry,
    agentstate,
    appconfig,
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
from test_autofix import (  # noqa: F401 - fixtures
    ROOT,
    _fixture_root,
    _job,
    _req,
    _spawn_recorder,
    fake_probes,
    store,
)

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
        """The bodies posted to ``route``, in order."""
        return [body for method, path, body in self.got
                if method == "POST" and path == f"/{route}"]

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        shutil.rmtree(self.dir, ignore_errors=True)


def snapshot(offers=(), runs=(), pools=(), admit=None) -> dict:
    return {"updatedAt": time.time(), "daemon": {"pid": 7, "startedAt": time.time() - 60},
            "identity": {"pk": ME, "onion": "x.onion"},
            "transport": {"state": "ready"}, "docker": {"state": "ready"},
            "model": {"state": "ready"}, "admit": admit or {"slots": 0},
            "pools": list(pools), "runs": list(runs), "offers": list(offers)}


def offer(task="t1", state="pooled", **extra) -> dict:
    return {"taskId": task, "state": state, **extra}


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
    """The switch on, the fixture root resolved, and no host disk or budget read."""
    appconfig.set_bool(network.ENABLED_KEY, True)
    monkeypatch.setattr(review, "roots_guessed", lambda: False)
    monkeypatch.setattr(review, "roots_complete", lambda: True)
    monkeypatch.setattr("diplomat_app.bans.read", lambda: [])


def takes_offers(task="t1"):
    return {"/offer": (200, {"taskId": task})}


def job(number=9, **fields) -> autofix.AgentJob:
    """A find of the review monitor: automatic work a refusal queues."""
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

def test_the_pools_are_posted_once_every_login_is_known(store, on, daemon, monkeypatch):
    d = daemon()
    asked = []

    def login(host=None):
        asked.append(host)
        raise RuntimeError("glab is not signed in")

    monkeypatch.setattr("diplomat_app.store.API.fetch_viewer_login", login)
    store._local_checkouts = [localrepos.Checkout("/src/tool", (LAB,))]

    store._network_cycle()
    store._network_cycle()
    assert d.sent("pools") == [], "a list missing a repository would make the daemon leave its pool"
    assert store.network_pools_held == "the login on gitlab.example.com is not known yet"
    assert asked == ["gitlab.example.com"], "an unknown login is not asked for on every cycle"
    assert len(d.sent("admit")) == 2, "the admit goes whatever holds the pools back"

    store._gitlab_me[LAB.host] = ("Bob", localrepos.glab_host_entry(LAB.host))
    store._network_cycle()
    assert d.sent("pools") == [{"pools": [
        {"id": POOL, "path": "/src/r", "forge": "github", "identity": "alice"},
        {"id": "gitlab.example.com/group/sub/tool", "path": "/src/tool", "forge": "gitlab",
         "identity": "bob"}]}]
    assert store.network_pools_held == ""


@pytest.mark.parametrize("break_it, why", [
    (lambda mp, st: mp.setattr(review, "roots_complete", lambda: False),
     "a repo root in Settings has no GitHub or GitLab remote"),
    (lambda mp, st: mp.setattr(review, "roots_guessed", lambda: True),
     "a repo root in Settings has no GitHub or GitLab remote"),
    (lambda mp, st: setattr(st, "_local_checkouts", [localrepos.Checkout("/src/x", ())]),
     "a checkout under Other repos has no GitHub or GitLab remote"),
    (lambda mp, st: (setattr(st, "me", ""),
                     mp.setattr("diplomat_app.store.API.fetch_viewer_login", lambda: "")),
     "the login on github.com is not known yet"),
])
def test_an_unresolved_repository_holds_the_pools_back(store, on, daemon, monkeypatch,
                                                       break_it, why):
    d = daemon()
    break_it(monkeypatch, store)
    store._network_cycle()
    assert d.sent("pools") == []
    assert store.network_pools_held == why
    assert store.network_state is not None


def test_the_github_login_is_ghs_own_not_the_username_override(store, on, daemon):
    d = daemon()
    store.username_override = "someone-else"
    store._network_cycle()
    assert [p["identity"] for p in d.sent("pools")[0]["pools"]] == ["alice"]


# MARK: - the cycle: admit

def test_the_admit_is_counted_again_and_posted_every_cycle(store, on, daemon, monkeypatch):
    d = daemon()
    store.auto_task_limit = 3
    store._network_cycle()
    assert d.sent("admit") == [{"slots": 3}]

    # One container this machine runs for the network, and one agent in a terminal.
    d.state = snapshot(runs=[{"runId": "r1", "taskId": "tx", "state": "running"},
                             {"runId": "r0", "taskId": "ty", "state": "finished"}])
    local = agentregistry.create_run(agentstate.RunRecord(
        run_id="local-1", dispatched_at=time.time(), pr_number=4,
        pr_url="https://github.com/o/r/pull/4", kind="review",
        source=autofix.SOURCE_AUTO, pid=4242, tty="pts/4"), "P")
    fake_probes(monkeypatch, processes={local.pid: agentstate.ProcInfo(
        tty="pts/4", elapsed=5.0, is_agent=True)})
    store._network_cycle()
    assert d.sent("admit")[-1] == {"slots": 1}

    store.queue_auto_run = False
    store._network_cycle()
    assert d.sent("admit")[-1] == {"slots": 0, "reason": "paused"}

    monkeypatch.setattr("diplomat_app.store.autobudget.enabled", lambda: True)
    monkeypatch.setattr("diplomat_app.store.autobudget.decide",
                        lambda: autofix.Budget(affordable=False))
    store._network_cycle()
    assert d.sent("admit")[-1] == {"slots": 0, "reason": "budget"}

    monkeypatch.setattr("diplomat_app.store.diskfloor.lowest",
                        lambda paths: SimpleNamespace(low=True))
    store._network_cycle()
    assert d.sent("admit")[-1] == {"slots": 0, "reason": "disk"}
    assert len(d.sent("admit")) == 5, "once a cycle, since the daemon lets it go stale"


def test_the_snapshot_kept_is_the_one_read_after_the_posts(store, on, daemon):
    d = daemon()
    d.routes["/admit"] = lambda body: (d.__setattr__("state", snapshot(admit=body)), (200, {}))[1]
    store.auto_task_limit = 2
    store._network_cycle()
    assert store.network_state.admit.slots == 2
    assert [m for m, path, _ in d.got if path == "/state"] == ["GET", "GET"]


def test_a_refused_post_is_kept_for_the_screen(store, on, daemon):
    daemon({"/admit": (400, {"error": "slots must be a whole number."})})
    store._network_cycle()
    assert store.network_error == "slots must be a whole number."


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
    assert store.network_state is None and not store.network_asked


# MARK: - the daemon's lifecycle

@pytest.fixture
def installer(monkeypatch):
    """The installer's runs, recorded: each answers a daemon that is then up, or down
    after a stop."""
    ran = []

    def run(script, arg):
        ran.append((os.path.basename(script), arg))
        return {"daemonRunning": arg != "--stop-daemon"}

    monkeypatch.setattr(da, "run_installer", run)
    return ran


def test_the_switch_starts_and_stops_the_daemon_off_the_gui_thread(store, daemon, installer,
                                                                   monkeypatch):
    daemon()
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
    assert store.network_state is not None, "the start takes a first cycle"
    assert lines("network-start") == ["Started the Diplomacy Network daemon (ok: true)"]

    store.set_network_enabled(False)
    assert store.wait_for_background() == []
    assert appconfig.read()[network.ENABLED_KEY] is False
    assert installer[-1] == ("install.js", "--stop-daemon")
    assert store.network_state is None and not store.network_asked
    assert lines("network-stop") == ["Stopped the Diplomacy Network daemon (ok: true)"]


def test_neither_a_start_nor_a_restart_runs_with_the_switch_off(store, daemon, installer):
    d = daemon()
    store.start_network_async()
    assert store.wait_for_background() == []
    store.restart_network_async()
    assert store.wait_for_background() == []
    assert installer == [] and d.got == []


def test_a_switch_turned_off_while_the_daemon_starts_stops_it(store, on, daemon, monkeypatch):
    """The switch's own stop is dropped while the start holds the gate."""
    d = daemon()
    ran = []

    def run(script, arg):
        ran.append(arg)
        if arg == "--start-daemon":
            store.set_network_enabled(False)
        return {"daemonRunning": arg != "--stop-daemon"}

    monkeypatch.setattr(da, "run_installer", run)
    store.start_network_daemon_async()
    assert store.wait_for_background() == []
    assert ran == ["--start-daemon", "--stop-daemon"]
    assert d.got == [] and store.network_state is None
    assert lines("network-stop") == ["Stopped the Diplomacy Network daemon (ok: true)"]


def test_a_start_the_installer_could_not_make_says_so(store, on):
    store.start_network_daemon_async()
    assert store.wait_for_background() == []
    assert lines("network-start") == [
        "Started the Diplomacy Network daemon (ok: false): the installer could not be run"]


def test_a_daemon_found_dead_is_started_again_with_a_growing_wait(store, on, installer):
    store._network_cycle()
    assert store.wait_for_background() == []
    assert installer == [("install.js", "--start-daemon")]
    assert store.network_asked and store.network_state is None

    store._network_cycle()
    assert store.wait_for_background() == []
    assert len(installer) == 1, "not on every cycle"

    due = store._network_start_due
    store._revive_network_daemon(due - 1)
    store._revive_network_daemon(due)
    assert store.wait_for_background() == []
    assert len(installer) == 2
    assert store._network_start_due == due + 2 * store.NETWORK_START_WAIT
    assert all(e.source == "auto" for e in activity.read() if e.action == "network-start")


def test_an_answer_resets_the_wait(store, on, installer, daemon):
    store._network_cycle()
    assert store.wait_for_background() == []
    assert store._network_start_wait == 2 * store.NETWORK_START_WAIT
    daemon()
    store._network_cycle()
    assert (store._network_start_due, store._network_start_wait) == (
        0.0, store.NETWORK_START_WAIT)


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
    assert (run.label, run.source, run.ledger_key) == (
        "Auto · Review · #9", autofix.SOURCE_AUTO, "review:o/r#9")
    assert lines("network-offer") == ["Auto · Review · #9 - offered to github.com/o/r"]
    assert [(e["ev"], e["key"]) for e in ledger()] == [("started", "review:o/r#9")]


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
    assert lines("network-claimed") == ["Auto · Review · #9 - claimed by 9f3c1a77"]

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
    assert done.startswith("Auto · Review · #9") and "finished on 9f3c1a77" in done
    assert calls == [] and len(d.sent("offer")) == 1 and d.sent("withdraw") == []


@pytest.mark.parametrize("executor, runner, counted", [(ME, "claude", True),
                                                       (PEER, dn.RUNNER_ELSEWHERE, False)])
def test_only_a_task_this_machine_ran_counts_against_its_own_limits(
        store, on, daemon, executor, runner, counted):
    daemon(state=snapshot(offers=[offer(
        state="done", executor=executor,
        outcome={"ok": True, "tokens": 500, "runner": "claude", "model": "opus"})]))
    book_network_run(ledger_key="review:o/r#9")
    telemetry.record_started("review:o/r#9")
    store._network_cycle()
    (done,) = [e for e in ledger() if e["ev"] == "done"]
    assert done.get("runner") == runner
    (task,) = [t for t in telemetry.load().tasks if t.key == "review:o/r#9"]
    assert task.anthropic is counted and task.tokens == 500


def test_a_task_that_failed_is_logged_as_failed_and_still_priced(store, on, daemon):
    daemon(state=snapshot(offers=[offer(
        state="done", executor=ME, outcome={"ok": False, "tokens": 90, "runner": "claude"})]))
    book_network_run(ledger_key="review:o/r#9")
    store._network_cycle()
    assert agentregistry.load() == []
    (failed,) = lines("network-failed")
    assert "failed on this machine" in failed
    assert [e["tokens"] for e in ledger() if e["ev"] == "done"] == [90]


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
    assert lines("in-flight") == ["Audit - the pool already has this job"]
    assert calls == []


def test_an_offer_no_run_could_be_booked_for_is_taken_back(store, on, daemon, monkeypatch):
    d = daemon(takes_offers())
    calls = _spawn_recorder(monkeypatch)

    def full(record, prompt):
        raise OSError(28, "No space left on device")

    monkeypatch.setattr(agentregistry, "create_run", full)
    assert store.dispatch_agent(job(ledger_key="review:o/r#9"), autofix.SOURCE_AUTO) == "failed"
    assert d.sent("withdraw") == [{"taskId": "t1", "reason": dn.WITHDRAW_UNBOOKED}]
    assert lines("network-failed") == [
        "Review · #9 - offered, then withdrawn: the run could not be booked "
        "(No space left on device)"]
    assert lines("network-offer") == [] and ledger() == [] and calls == []


def test_a_panel_job_is_this_machines_to_run_at_once(store, on, daemon, monkeypatch):
    d = daemon(takes_offers())
    _spawn_recorder(monkeypatch)
    store.dispatch_agent(job(1), autofix.SOURCE_PANEL)
    store.dispatch_agent(job(2), autofix.SOURCE_AUTO, bypass_capacity=True, forced=True)
    store.dispatch_agent(job(3), autofix.SOURCE_AUTO, bypass_capacity=True)
    assert [b["now"] for b in d.sent("offer")] == [True, True, False]
    assert lines("network-offer")[-1] == (
        "Review · #1 - offered to github.com/o/r, to run on this machine")
    assert [e for e in ledger() if e["ev"] == "started"] == [], "no ledger key, no entry"


# MARK: - a daemon that does not take the job

def test_with_the_daemon_down_auto_work_waits_and_a_panel_job_says_why(
        store, on, monkeypatch):
    calls = _spawn_recorder(monkeypatch)

    verdicts = [store.dispatch_agent(job(n), autofix.SOURCE_AUTO) for n in (1, 2)]

    assert verdicts == [dn.VERDICT_REFUSED] * 2
    assert all(not v.answered and v.sentence == dn.NOT_RUNNING for v in verdicts)
    store.commit_queue()
    assert [e.id for e in store.queued_tasks] == ["review-req:o/r#1", "review-req:o/r#2"]
    assert lines("network-unavailable") == [
        "The network daemon is not running. Automatic work waits in the queue."]

    clicked = store.dispatch_agent(job(3), autofix.SOURCE_PANEL)
    assert clicked == dn.VERDICT_REFUSED and clicked.sentence == dn.NOT_RUNNING
    assert lines("network-unavailable")[0] == "Review · #3 - The network daemon is not running."
    assert "review-req:o/r#3" not in [e.id for e in store._staged_queue]

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


def test_a_refusal_of_one_job_is_said_once_per_job(store, on, daemon, monkeypatch):
    daemon({"/offer": (409, {"error": "This machine is not in that pool."})})
    calls = _spawn_recorder(monkeypatch)
    for _ in range(2):
        for n in (1, 2):
            verdict = store.dispatch_agent(job(n), autofix.SOURCE_AUTO)
            assert verdict == dn.VERDICT_REFUSED and verdict.answered
    assert lines("network-unavailable") == [
        "Review · #2 - This machine is not in that pool. It waits in the queue.",
        "Review · #1 - This machine is not in that pool. It waits in the queue."]
    assert calls == []


@pytest.mark.parametrize("answer, sentence", [
    ((200, {}), "The network daemon named no task for the offer."),
    ((500, {}), "The network daemon refused the request (HTTP 500)."),
])
def test_an_offer_with_no_task_books_nothing(store, on, daemon, monkeypatch, answer, sentence):
    daemon({"/offer": answer})
    calls = _spawn_recorder(monkeypatch)
    verdict = store.dispatch_agent(job(), autofix.SOURCE_PANEL)
    assert verdict == dn.VERDICT_REFUSED and verdict.sentence == sentence
    assert agentregistry.load() == [] and calls == []


def test_a_job_with_no_repository_or_kind_is_refused_without_asking(store, on, daemon,
                                                                    monkeypatch):
    d = daemon(takes_offers())
    calls = _spawn_recorder(monkeypatch)
    nowhere = autofix.AgentJob(kind="audit", audit_action="audit", label="Audit",
                               prompt="A", checkout="/src/not-listed")
    verdict = store.dispatch_agent(nowhere, autofix.SOURCE_PANEL)
    assert verdict.sentence == "No repository to offer it into."
    unknown = autofix.AgentJob(kind="x", audit_action="telemetry", label="X", prompt="A")
    assert store.dispatch_agent(unknown, autofix.SOURCE_PANEL).sentence == (
        "The network runs no telemetry jobs.")
    assert d.sent("offer") == [] and calls == []


def test_execute_now_with_the_daemon_down_shows_the_sentence(store, on, monkeypatch):
    calls = _spawn_recorder(monkeypatch)
    entry = autofix.QueuedTask("review-req:o/r#5", job(5), 1)
    store.queued_tasks = [entry]
    store._execute_queued_task(entry)
    assert store.error == "Review · #5: The network daemon is not running."
    assert calls == [] and lines("queue-run") == []


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

    # Each of the three holds a local dispatch; none is this machine's to answer for a
    # job another machine may take.
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
    assert d.sent("withdraw") == [{"taskId": "t1", "reason": network.WITHDRAW_MERGED}]
    assert agentregistry.load() == []
    assert lines("network-withdraw") == ["Auto · Review · #9 - withdrawn, its PR is merged"]


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
    assert d.sent("withdraw") == [{"taskId": "t1", "reason": network.WITHDRAW_MERGED}]
    assert agentregistry.load() == []


def test_forgetting_a_run_withdraws_an_offer_the_network_still_holds(store, on, daemon):
    d = daemon(state=snapshot(offers=[offer("t1", "pooled"),
                                      offer("t2", "done", outcome={"ok": True})]))
    live, over = book_network_run("t1", 9), book_network_run("t2", 10)
    store._network_cycle()
    # The second is over and would be retired by the next settle; forgotten first, it
    # has nothing to withdraw.
    for run in (live, over):
        store.forget_network_run_async(run.run_id)
        assert store.wait_for_background() == []
    assert d.sent("withdraw") == [{"taskId": "t1", "reason": network.WITHDRAW_FORGOTTEN}]
    assert agentregistry.load() == []
    assert lines("network-withdraw") == ["Auto · Review · #9 - forgotten and withdrawn"]


def test_a_run_is_forgotten_whatever_the_daemon_answers(store, on):
    run = book_network_run()
    store.forget_network_run_async(run.run_id)
    assert store.wait_for_background() == []
    assert agentregistry.load() == []
    assert lines("network-withdraw") == [
        "Auto · Review · #9 - forgotten; its offer was not withdrawn: "
        "The network daemon is not running."]


def test_stop_ends_the_container_here_and_otherwise_withdraws(store, on, daemon):
    d = daemon(state=snapshot(
        offers=[offer("t1", "claimed", executor=ME), offer("t2", "claimed", executor=PEER)],
        runs=[{"runId": "r-7", "taskId": "t1", "state": "running"},
              {"runId": "r-6", "taskId": "t1", "state": "failed"}]))
    here, there = book_network_run("t1", 9), book_network_run("t2", 10)
    store._network_cycle()
    for run in (here, there):
        store.stop_network_run_async(run.run_id)
        assert store.wait_for_background() == []
    assert d.sent("stop-run") == [{"runId": "r-7"}]
    assert d.sent("withdraw") == [{"taskId": "t2", "reason": dn.WITHDRAW_STOPPED}]
    assert lines("network-withdraw") == ["Auto · Review · #10 - withdrawn",
                                         "Auto · Review · #9 - stopped on this machine"]
    assert len(agentregistry.load()) == 2, "each reads how it ended off the next snapshot"


def test_stop_and_forget_leave_a_local_run_alone(store, on, daemon):
    d = daemon()
    local = agentregistry.create_run(agentstate.RunRecord(
        run_id="local-1", dispatched_at=time.time(), pr_number=4), "P")
    store.stop_network_run_async(local.run_id)
    store.forget_network_run_async(local.run_id)
    assert store.wait_for_background() == []
    assert [m for m, _, _ in d.got] == [] and len(agentregistry.load()) == 1


# MARK: - the three calls of the Network screen

def test_invite_join_and_leave_post_and_are_logged(store, on, daemon):
    d = daemon({"/invite": (200, {"invite": "dn1-secret"}), "/join": (200, {"pool": POOL})})
    store.network_invite_async(POOL)
    assert store.wait_for_background() == []
    assert store.network_call == dataclasses.replace(
        store.network_call, kind="invite", pool=POOL, running=False, error="",
        invite="dn1-secret")
    store.network_join_async("dn1-other")
    assert store.wait_for_background() == []
    assert (store.network_call.kind, store.network_call.pool) == ("join", POOL)
    store.network_leave_async(POOL)
    assert store.wait_for_background() == []
    assert (d.sent("invite"), d.sent("join"), d.sent("leave")) == (
        [{"pool": POOL}], [{"invite": "dn1-other"}], [{"pool": POOL}])
    assert [(e.action, e.detail) for e in activity.read()
            if e.action in ("network-invite", "network-join", "network-leave")] == [
        ("network-leave", f"Left {POOL}"), ("network-join", f"Joined {POOL}"),
        ("network-invite", f"Made an invite to {POOL}")]
    assert "dn1-secret" not in json.dumps([e.detail for e in activity.read()])


def test_a_call_the_daemon_refuses_shows_its_sentence_and_logs_nothing(store, on, daemon):
    daemon({"/join": (400, {"error": "That invite has expired."})})
    store.network_join_async("dn1-old")
    assert store.wait_for_background() == []
    assert store.network_call.error == "That invite has expired."
    assert lines("network-join") == []


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


def test_the_launch_sweep_ends_the_legacy_node_alone_and_says_so_once(store, monkeypatch):
    table = {11: ["python3", "-m", "szpontnet"],
             12: ["node", "/src/szpontnet/daemon.js"],
             13: ["python3", "-m", "diplomat_app"]}
    monkeypatch.setattr(procscan, "scan_own_pids",
                        lambda match: {pid for pid in table if match(pid)})
    monkeypatch.setattr(procscan, "cmdline_tokens", lambda pid: table[pid])
    killed = []
    monkeypatch.setattr(dn.os, "kill", lambda pid, sig: killed.append((pid, sig)))

    store.end_legacy_nodes_async()
    assert store.wait_for_background() == []
    assert killed == [(11, signal.SIGTERM)]
    assert lines("network-stop") == [
        "Ended the SzpontNet node the Diplomacy Network replaces (pid 11)"]

    del table[11]
    store.end_legacy_nodes_async()
    assert store.wait_for_background() == []
    assert len(killed) == 1 and len(lines("network-stop")) == 1


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
    """The host's ``ps`` lists a container's processes beside its own. A job of the
    network that names its PR in its argv would be found as an untracked agent and hold
    a bay of the cap for work already counted as a network run."""
    _fake_cgroups(monkeypatch, tmp_path, {
        100: "0::/user.slice/user-1000.slice/session-3.scope\n",
        200: "0::/system.slice/docker-" + "ab12" * 16 + ".scope\n"})
    dump = agentstate.Observation.present(
        "  100 pts/1  60 claude Review PR #5 in o/r. Use the `gh` CLI.\n"
        "  200 ?      60 claude Review PR #6 in o/r. Use the `gh` CLI.\n")
    assert probes.live_agents(dump, {"o/r"}).value == {"o/r#5": "pts/1"}


# MARK: - launch, and the agent dump

@pytest.mark.parametrize("switch", [True, False])
def test_launch_sweeps_the_legacy_node_always_and_starts_the_daemon_only_when_on(
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
    monkeypatch.delenv("DIPLOMAT_NETWORK_SECS", raising=False)

    app = app_module.DiplomatApp()

    assert called.count("end_legacy_nodes_async") == 1
    assert called.count("start_network_async") == (1 if switch else 0)
    assert app.network_timer.interval == 30_000
    del called[:]
    for slot in app.network_timer.slots:
        slot()
    assert called == ["run_network_cycle_async"]


@pytest.mark.parametrize("raw, secs", [(None, 30.0), ("12", 12.0), ("600", 60.0),
                                       ("1", 5.0), ("soon", 30.0)])
def test_the_cycle_is_never_slower_than_the_admit_goes_stale(monkeypatch, raw, secs):
    from diplomat_app import app as app_module

    if raw is None:
        monkeypatch.delenv("DIPLOMAT_NETWORK_SECS", raising=False)
    else:
        monkeypatch.setenv("DIPLOMAT_NETWORK_SECS", raw)
    assert app_module.network_cycle_secs() == secs


def test_the_agent_dump_asks_the_daemon_only_while_the_switch_is_on(
        daemon, monkeypatch, capsys):
    from diplomat_app import agentdump

    fake_probes(monkeypatch)
    book_network_run()
    d = daemon(state=snapshot(offers=[offer(state="claimed", executor=PEER)]))
    agentdump.run()
    out = capsys.readouterr().out
    assert d.got == [] and "  network " not in out
    assert "because: the network could not be asked: not probed" in out

    appconfig.set_bool(network.ENABLED_KEY, True)
    agentdump.run()
    out = capsys.readouterr().out
    assert "  network         ok (1 item)" in out
    assert "because: running on 9f3c1a77" in out

    d.close()
    agentdump.run()
    out = capsys.readouterr().out
    assert f"  network         UNAVAILABLE — {network.UNANSWERED}" in out
