"""The Pipeline in the Linux Store: its settings, the sync it runs, and what a sync's
effects do to the queue.

The sync is the core's (``diplomat-core pipeline-tick``); here its answer is a literal,
or a stand-in core that records what it was handed.
"""

from __future__ import annotations

import contextlib
import dataclasses
import json
import os
import signal
import stat
import sys
import threading
import time
from datetime import datetime, timezone
from types import SimpleNamespace

import pytest
from test_autofix import _spawn_recorder, fake_probes, store  # noqa: F401 — fixture

from diplomat_app import bans
from diplomat_app.store import PIPELINE_ATTEMPTS, Store, app_settings
from diplomat_runtime import activity, appconfig, autofix, pipeline, promptcore, review
from diplomat_runtime.prref import LocalRepo

pytest.importorskip("PySide6")
from PySide6.QtWidgets import QApplication  # noqa: E402

ROOT =LocalRepo("o", "r", "/src/r")
LAB = LocalRepo("group/sub", "r", "/src/lab", host="gitlab.example.com")
ISSUE = "https://github.com/o/r/issues/12"
PR = "https://github.com/o/r/pull/7"
LINEAR = "https://linear.app/acme/issue/ENG-12/a-thing"
SWITCHES = ("pipeline_enabled", "pipeline_rate", "pipeline_fix", "pipeline_fast_track",
            "pipeline_merge", "pipeline_fracture")
KEYS = ("pipelineEnabled", "pipelineRate", "pipelineFix", "pipelineFastTrack",
        "pipelineMerge", "pipelineFracture")


def _item(url: str = ISSUE, **fields) -> dict:
    return {"id": url, "source": "github", "kind": "issue", "label": "#12", "title": "t",
            "repo": "o/r", "state": "open", "assignees": [], "writable": True,
            "stage": "candidate", "lane": "fast", **fields}


def _fix(number: int = 12, author: str = "carol") -> dict:
    url = f"https://github.com/o/r/issues/{number}"
    return {"kind": "fixIssue", "repo": "o/r", "number": number, "url": url,
            "author": author, "key": f"pipeline-fix:{url}", "stamp": "fix"}


def _linear() -> dict:
    return {"kind": "fixLinear", "repo": "o/r", "identifier": "ENG-12", "url": LINEAR,
            "text": "A thing\n\nIt breaks.", "key": f"pipeline-fix:{LINEAR}", "stamp": "fix"}


def _review(head: str = "abc123") -> dict:
    return {"kind": "review", "repo": "o/r", "number": 7, "url": PR, "headSha": head,
            "key": f"pipeline-review:{PR}", "stamp": head}


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _result(*effects: dict, items: tuple = (), at: str | None = None,
            unread: tuple = (), fixable: tuple = ()) -> dict:
    """Dated now unless ``at`` says otherwise: a sync's result is dated when it began."""
    return {"at": at or _now_iso(), "items": list(items),
            "graph": {"nodes": [], "edges": []}, "effects": list(effects), "events": [],
            "notices": [], "unread": list(unread), "fixable": list(fixable)}


def _sync(pipe, result: dict) -> None:
    """A sync's own result, begun since the last switch flipped."""
    pipe._apply_pipeline_sync({"result": result, "forced": {}, "started": 0,
                               "epoch": pipe._pipeline_epoch})


@pytest.fixture
def pipe(store, monkeypatch):  # noqa: F811 — the shared Store fixture
    """The store with one GitHub root, mallory banned, and the Pipeline on with its fix
    and fast-track switches."""
    monkeypatch.setattr(review, "repo_roots", lambda: [ROOT])
    monkeypatch.setattr(review, "roots_guessed", lambda: False)
    monkeypatch.setattr("diplomat_app.bans.read",
                        lambda: [bans.BannedAuthor("mallory", "prompt injection")])
    store.pipeline_enabled = True
    store.pipeline_fix = True
    store.pipeline_fast_track = True
    return store


def _keys(st: Store) -> list[str]:
    return [w.key for w in st.requested_work]


def _feed(action: str) -> list[str]:
    path = activity.audit_path()
    lines = [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []
    return [e["detail"] for e in lines if e["action"] == action]


# MARK: - Settings


def test_every_pipeline_setting_defaults_off():
    st = Store()
    assert [getattr(st, name) for name in SWITCHES] == [False] * len(SWITCHES)
    assert st.pipeline_linear_teams_raw == ""


def test_the_pipeline_settings_persist_under_their_keys():
    st = Store()
    for name in SWITCHES:
        setattr(st, name, True)
    st.pipeline_linear_teams_raw = "ENG=o/r"
    raw = app_settings()
    assert [raw.value(k, False, bool) for k in KEYS] == [True] * len(KEYS)
    assert raw.value("pipelineLinearTeams", "", str) == "ENG=o/r"
    again = Store()
    assert [getattr(again, name) for name in SWITCHES] == [True] * len(SWITCHES)
    assert again.pipeline_linear_teams_raw == "ENG=o/r"


def test_a_sync_is_handed_the_github_roots_the_teams_and_the_switches(pipe, monkeypatch):
    monkeypatch.setattr(review, "repo_roots", lambda: [ROOT, LAB])
    monkeypatch.setattr(Store, "run_pipeline_sync_async", lambda self: None)
    pipe.pipeline_linear_teams_raw = "eng = o/r; OPS=o/other, nonsense"
    appconfig.set_value(appconfig.LINEAR_TOKEN_FILE, " ~/.diplomat/linear ")
    monkeypatch.setenv("HOME", "/home/elsewhere")
    pipe.pipeline_force_now("rate", ISSUE)
    pipe.pipeline_force_now("rate", PR)
    pipe.pipeline_force_now("fracture", ISSUE)
    assert pipe.pipeline_settings_payload() == {
        "roots": [{"owner": "o", "repo": "r", "path": "/src/r", "me": "alice"}],
        "linearTeams": [{"key": "ENG", "repo": "o/r"}, {"key": "OPS", "repo": "o/other"}],
        "linearTokenFile": "/home/elsewhere/.diplomat/linear",
        "rate": False, "fix": True, "fastTrack": True, "merge": False, "fracture": False,
        "force": {"rate": [ISSUE, PR], "fracture": [ISSUE]},
    }


def test_no_token_file_is_handed_on_when_none_is_named(pipe):
    assert "linearTokenFile" not in pipe.pipeline_settings_payload()


# MARK: - Effects to asks


def test_a_fix_effect_is_the_fix_of_that_one_issue(pipe):
    work = pipe.pipeline_work(_fix())
    assert work.key == "issues:o/r#12"
    assert (work.number, work.url, work.author, work.repo) == (12, ISSUE, "carol", "o/r")
    assert {k: work.config[k] for k in ("kind", "target", "specificIssue", "me", "pipeline")
            } == {"kind": "issues", "target": "specific", "specificIssue": "12",
                  "me": "alice", "pipeline": True}
    assert work.config["home"]["path"] == "/src/r"
    assert work.pipeline


def test_my_own_issue_has_no_author_to_ban(pipe):
    assert pipe.pipeline_work(_fix(author="Alice")).author == ""


def test_a_linear_fix_carries_the_issue_and_never_a_github_key(pipe):
    work = pipe.pipeline_work(_linear())
    assert work.key == "issues:linear:ENG-12"
    assert (work.item, work.number) == (None, 0)
    assert work.config["linear"] == {"identifier": "ENG-12", "url": LINEAR,
                                     "text": "A thing\n\nIt breaks."}
    assert work.config["specificIssue"] == ""
    assert (work.author, work.repo) == ("", "o/r")
    assert work.label_among(1) == f"Issues · ENG-12 · {work.config['depth']}"


def test_a_fast_track_effect_is_a_review_of_my_pr(pipe):
    work = pipe.pipeline_work(_review())
    assert work.key == "review:o/r#7"
    assert {k: work.config[k] for k in ("kind", "target", "specificPR", "specificAuthor",
                                        "fastTrack", "depth")
            } == {"kind": "review", "target": "specific", "specificPR": "7",
                  "specificAuthor": "mine", "fastTrack": True, "depth": "max"}
    assert work.pipeline


def test_a_linear_fix_is_the_pipelines_work_whatever_its_flags(pipe):
    """The master switch pauses it (``Store.is_paused``), as ``isPipeline`` does on
    macOS for any fix carrying a Linear issue."""
    cfg = {"kind": "issues", "linear": {"identifier": "ENG-12", "url": LINEAR, "text": ""}}
    work = autofix.RequestedWork(number=0, url=LINEAR, author="", config=cfg, repo="o/r")
    assert work.pipeline
    assert not autofix.RequestedWork(number=0, url=LINEAR, author="",
                                     config={"kind": "issues"}, repo="o/r").pipeline


def test_a_linear_fixs_queued_task_carries_the_issues_link(pipe):
    pipe._apply_pipeline_effects(_result(_linear()), time.time())
    [task] = pipe.queued_tasks
    assert (task.id, task.job.pr_url, task.job.pr_number, task.job.counter) == (
        "issues:linear:ENG-12", LINEAR, None, "pipeline")


@pytest.mark.parametrize("repo", ["x/y", "group/sub/r"])
def test_an_effect_in_no_github_root_is_no_ask(pipe, monkeypatch, repo):
    monkeypatch.setattr(review, "repo_roots", lambda: [ROOT, LAB])
    assert pipe.pipeline_work({**_fix(), "repo": repo}) is None


def test_a_linear_fix_and_the_github_issue_of_its_number_are_two_asks(pipe):
    pipe._apply_pipeline_effects(_result(_fix(12), _linear()), time.time())
    assert _keys(pipe) == ["issues:o/r#12", "issues:linear:ENG-12"]
    assert {t.id for t in pipe.queued_tasks} == {"issues:o/r#12", "issues:linear:ENG-12"}


# MARK: - Once per attempt


def test_an_effect_is_asked_for_once_per_attempt(pipe):
    now = time.time()
    pipe._apply_pipeline_effects(_result(_fix()), now)
    pipe._apply_pipeline_effects(_result(_fix()), now + 60)
    assert _keys(pipe) == ["issues:o/r#12"]
    stored = json.loads(app_settings().value(PIPELINE_ATTEMPTS, "", str))
    assert stored == {f"pipeline-fix:{ISSUE}": {"requestedAt": "fix",
                                                "lastDispatchedAt": now, "attempts": 1}}

    # Dispatched and over, still owed: retried once the backoff has passed, not sooner.
    pipe.requested_work = []
    pipe.queued_tasks = []
    pipe._apply_pipeline_effects(_result(_fix()), now + autofix.retry_delay(1) - 1)
    assert _keys(pipe) == []
    pipe._apply_pipeline_effects(_result(_fix()), now + autofix.retry_delay(1))
    assert _keys(pipe) == ["issues:o/r#12"]
    assert pipe._load_attempts(PIPELINE_ATTEMPTS)[f"pipeline-fix:{ISSUE}"].attempts == 2
    label = pipe.pipeline_work(_fix()).label_among(1)
    assert _feed("pipeline-fix") == [f"{label} queued", f"{label} queued (attempt 2)"]


def test_a_new_head_waits_out_the_re_request_cooldown(pipe):
    now = time.time()
    pipe._apply_pipeline_effects(_result(_review("abc")), now)
    pipe.requested_work = []
    pipe.queued_tasks = []
    pipe._apply_pipeline_effects(_result(_review("def")), now + 600)
    assert _keys(pipe) == []
    pipe._apply_pipeline_effects(_result(_review("def")),
                                 now + autofix.RE_REQUEST_COOLDOWN)
    assert _keys(pipe) == ["review:o/r#7"]
    label = pipe.pipeline_work(_review()).label_among(1)
    assert _feed("pipeline-review") == [f"{label} queued"] * 2


def test_a_cancelled_ask_is_asked_for_again_only_at_another_stamp(pipe):
    """Cancel concludes its record: a review comes back for a new head, a fix only by
    Start fix."""
    now = time.time()
    pipe._apply_pipeline_effects(_result(_fix(), _review("abc")), now)
    keys = ("issues:o/r#12", "review:o/r#7")
    labels = {t.id: t.job.label for t in pipe.queued_tasks}
    for key in keys:
        pipe.cancel_requested_work(key)
    assert (_keys(pipe), pipe.queued_tasks) == ([], [])
    assert _feed("queue-cancel") == [f"{labels[key]} — cancelled, not run" for key in keys]
    later = now + autofix.RETRY_MAX_BACKOFF
    for at in (later, later + 60):
        pipe._apply_pipeline_effects(_result(_fix(), _review("abc")), at)
        assert _keys(pipe) == []
    pipe._apply_pipeline_effects(_result(_fix(), _review("def")), later)
    assert _keys(pipe) == ["review:o/r#7"]
    records = pipe._load_attempts(PIPELINE_ATTEMPTS)
    assert {k: (a.requested_at, a.attempts, a.concluded_at is None) for k, a in records.items()
            } == {f"pipeline-fix:{ISSUE}": ("fix", 1, False),
                  f"pipeline-review:{PR}": ("def", 1, True)}
    assert _start(pipe, _item()) is None
    assert _keys(pipe) == ["review:o/r#7", "issues:o/r#12"]
    pipe.cancel_requested_work("issues:o/r#12")
    pipe._apply_pipeline_effects(_result(_fix()), later + autofix.RETRY_MAX_BACKOFF)
    assert _keys(pipe) == ["review:o/r#7"]


def test_a_cancel_concludes_only_its_own_asks_record():
    now = time.time()
    other = "https://github.com/o/r/issues/13"
    attempts = {f"pipeline-fix:{ISSUE}": _attempt(), f"pipeline-fix:{other}": _attempt(),
                f"pipeline-review:{PR}": _attempt()}
    out = pipeline.cancelled(attempts, autofix.QUEUE_ISSUES_ACTION, ISSUE, now)
    assert {k: a.concluded_at for k, a in out.items()} == {
        f"pipeline-fix:{ISSUE}": now, f"pipeline-fix:{other}": None,
        f"pipeline-review:{PR}": None}
    assert pipeline.cancelled(out, autofix.QUEUE_REVIEW_ACTION, PR, now + 1)[
        f"pipeline-review:{PR}"].concluded_at == now + 1


def test_work_already_queued_is_not_asked_for_again(pipe):
    """A row the operator re-ordered keeps its place: the next sync's same effect is
    in flight, not a second ask."""
    now = time.time()
    pipe._apply_pipeline_effects(_result(_fix()), now)
    pipe._apply_pipeline_effects(_result(_fix()), now + autofix.RETRY_MAX_BACKOFF)
    assert _keys(pipe) == ["issues:o/r#12"]
    assert pipe._load_attempts(PIPELINE_ATTEMPTS)[f"pipeline-fix:{ISSUE}"].attempts == 1


def test_a_fix_running_under_a_linear_label_is_in_flight(pipe, monkeypatch):
    row = autofix.RunningAgent(pr_number=0, label="Auto · Issues · ENG-12 · quick",
                               kind="issues", tracked=True)
    monkeypatch.setattr(Store, "running_tasks", property(lambda self: [row]))
    pipe._apply_pipeline_effects(_result(_linear()), time.time())
    assert _keys(pipe) == []


def test_a_review_waits_while_an_agent_is_on_its_pr(pipe, monkeypatch):
    monkeypatch.setattr(Store, "_in_flight", lambda self, url: url == PR)
    pipe._apply_pipeline_effects(_result(_review()), time.time())
    assert _keys(pipe) == []
    assert pipe._load_attempts(PIPELINE_ATTEMPTS) == {}


def test_a_banned_authors_issue_is_not_asked_for(pipe):
    pipe._apply_pipeline_effects(_result(_fix(author="mallory")), time.time())
    assert _keys(pipe) == []


def test_the_ban_is_the_effects_author_not_the_items(pipe):
    """A part Diplomat split off a banned author's issue is filed by the operator; the
    core names the root's author on its fix, and that is the one the ban list checks."""
    child = _item(author="alice")
    pipe._apply_pipeline_effects(_result(_fix(author="mallory"), items=(child,)),
                                 time.time())
    assert _keys(pipe) == []
    pipe._apply_pipeline_effects(_result(_fix(author="carol"), items=(_item(author="mallory"),)),
                                 time.time())
    assert _keys(pipe) == ["issues:o/r#12"]


@pytest.mark.parametrize("off, asked", [
    ("pipeline_fix", ["review:o/r#7"]),
    ("pipeline_fast_track", ["issues:o/r#12", "issues:linear:ENG-12"]),
])
def test_a_switch_off_by_the_time_its_sync_lands_asks_for_nothing(pipe, off, asked):
    setattr(pipe, off, False)
    pipe._apply_pipeline_effects(_result(_fix(), _linear(), _review()), time.time())
    assert _keys(pipe) == asked


def test_a_sync_landing_after_the_pipeline_went_off_asks_for_nothing(pipe):
    pipe.pipeline_enabled = False
    result = _result(_fix())
    _sync(pipe, result)
    assert pipe.pipeline_result == result
    assert _keys(pipe) == []


def test_records_are_kept_while_owed_and_age_out_after(pipe):
    now = time.time()
    old = now - autofix.RETRY_MAX_BACKOFF - 1
    owed = autofix.ReviewAttempt("fix", old, 5)
    fresh = autofix.ReviewAttempt("fix", now - 60, 1)
    pipe._save_attempts(PIPELINE_ATTEMPTS, {
        f"pipeline-fix:{ISSUE}": owed,
        "pipeline-fix:https://github.com/o/r/issues/99": autofix.ReviewAttempt("fix", old, 1),
        "pipeline-fix:https://github.com/o/r/issues/98": fresh,
    })
    # Owed but queued already, so in flight: its record is left as it was.
    pipe._request([pipe.pipeline_work(_fix())])
    pipe._apply_pipeline_effects(_result(_fix()), now)
    assert pipe._load_attempts(PIPELINE_ATTEMPTS) == {
        f"pipeline-fix:{ISSUE}": owed, "pipeline-fix:https://github.com/o/r/issues/98": fresh}


def test_a_record_is_kept_while_its_effect_is_owed_whatever_the_switches(pipe):
    """Owed is what the sync emitted: a fix the switch holds back, or one in a root
    gone, keeps its record, so turning the switch back on does not ask again at once."""
    now = time.time()
    old = now - autofix.RETRY_MAX_BACKOFF - 1
    held = autofix.ReviewAttempt("fix", old, 3)
    gone = autofix.ReviewAttempt("fix", old, 2)
    pipe._save_attempts(PIPELINE_ATTEMPTS, {f"pipeline-fix:{ISSUE}": held,
                                            "pipeline-fix:https://github.com/x/y/issues/1": gone})
    pipe.pipeline_fix = False
    pipe._apply_pipeline_effects(_result(_fix(), {**_fix(1), "repo": "x/y",
                                                  "url": "https://github.com/x/y/issues/1",
                                                  "key": "pipeline-fix:https://github.com/x/y/issues/1"}),
                                 now)
    assert pipe._load_attempts(PIPELINE_ATTEMPTS) == {
        f"pipeline-fix:{ISSUE}": held, "pipeline-fix:https://github.com/x/y/issues/1": gone}


@pytest.mark.parametrize("age", [60, autofix.RETRY_MAX_BACKOFF])
def test_a_record_concluded_while_a_sync_asks_stays_concluded(pipe, monkeypatch, age):
    """A run's retirement saves its record while the sync's pass builds a prompt, cooling
    down or past its backoff."""
    now = time.time()
    other = "https://github.com/o/r/issues/13"
    pipe._save_attempts(PIPELINE_ATTEMPTS, {
        f"pipeline-fix:{other}": autofix.ReviewAttempt("fix", now - age, 1)})
    request = pipe.request_one

    def concluding(work):
        pipe._save_attempts(PIPELINE_ATTEMPTS, pipeline.concluded(
            pipe._load_attempts(PIPELINE_ATTEMPTS), [_run(autofix.QUEUE_ISSUES_ACTION, other)],
            now))
        return request(work)

    monkeypatch.setattr(pipe, "request_one", concluding)
    pipe._apply_pipeline_effects(_result(_fix(), _fix(13)), now)
    assert _keys(pipe) == ["issues:o/r#12"]
    records = pipe._load_attempts(PIPELINE_ATTEMPTS)
    assert {k: (a.attempts, a.concluded_at) for k, a in records.items()} == {
        f"pipeline-fix:{ISSUE}": (1, None), f"pipeline-fix:{other}": (1, now)}


def test_an_ask_that_cannot_be_queued_is_an_attempt(pipe, monkeypatch):
    def broken(cfg):
        raise RuntimeError("diplomat-core build-prompt failed: no such kind")

    monkeypatch.setattr("diplomat_runtime.promptcore.build_prompt", broken)
    now = time.time()
    pipe._apply_pipeline_effects(_result(_fix()), now)
    pipe._apply_pipeline_effects(_result(_fix()), now + 60)
    assert _keys(pipe) == []
    label = pipe.pipeline_work(_fix()).label_among(1)
    assert _feed("pipeline-fix") == [
        f"{label} could not be queued: diplomat-core build-prompt failed: no such kind"]
    assert pipe._load_attempts(PIPELINE_ATTEMPTS)[f"pipeline-fix:{ISSUE}"].attempts == 1


# MARK: - Paused while off


def test_pipeline_asks_wait_while_the_pipeline_is_off(pipe):
    _sync(pipe, _result(_fix(), _review()))
    pipe._request([autofix.RequestedWork(
        number=13, url="https://github.com/o/r/pull/13", author="",
        config=review.ReviewConfig(specific_pr="13", me="alice", home=ROOT).prompt_payload(),
        repo="o/r")])
    jobs = {t.id: t.job.counter for t in pipe.queued_tasks}
    assert jobs == {"issues:o/r#12": "pipeline", "review:o/r#7": "pipeline",
                    "review:o/r#13": None}
    assert [t.id for t in pipe.drainable_tasks] == [t.id for t in pipe.queued_tasks]
    pipe.pipeline_enabled = False
    assert pipe.is_paused("pipeline")
    assert [t.id for t in pipe.drainable_tasks] == ["review:o/r#13"]


def test_switched_back_on_no_ask_starts_until_a_sync_begun_since_is_applied(pipe,
                                                                           monkeypatch):
    """The asks queued before may be stale; that sync withdraws the ones it no longer
    owes, and brings the poll that drains the rest forward."""
    _sync(pipe, _result(_fix(), _review()))
    pipe.pipeline_enabled = False
    pipe.pipeline_enabled = True
    assert pipe.is_paused("pipeline")
    assert (pipe.drainable_tasks, len(pipe.queued_tasks)) == ([], 2)
    polls = []
    monkeypatch.setattr(Store, "_bring_poll_forward", lambda self, load: polls.append(load))
    calls = []

    def tick(settings, started=None):
        calls.append(1)
        if len(calls) == 1:
            return _result(_fix(), at="2026-11-20T10:00:00Z")
        if len(calls) == 2:
            pipe.pipeline_enabled = False
            pipe.pipeline_enabled = True
        return _result(_fix())

    monkeypatch.setattr(pipeline, "tick", tick)
    # The last result answered again, then a sync begun before the switch went on.
    for _ in range(2):
        pipe._apply_pipeline_sync(pipe._pipeline_sync_once())
        assert pipe.is_paused("pipeline")
        assert sorted(_keys(pipe)) == ["issues:o/r#12", "review:o/r#7"]
    assert polls == []
    pipe._apply_pipeline_sync(pipe._pipeline_sync_once())
    assert not pipe.is_paused("pipeline")
    assert [t.id for t in pipe.drainable_tasks] == ["issues:o/r#12"]
    assert len(polls) == 1
    pipe._apply_pipeline_sync(pipe._pipeline_sync_once())
    assert len(polls) == 1


def test_a_launch_starts_no_ask_until_its_first_sync_is_applied(pipe):
    _sync(pipe, _result(_fix()))
    again = Store()
    assert again.pipeline_enabled and again.is_paused("pipeline")


# MARK: - The sync


def test_a_sync_reads_nothing_while_the_pipeline_is_off(pipe, monkeypatch):
    calls = []
    monkeypatch.setattr(pipeline, "tick", lambda settings, started=None: calls.append(settings) or {})
    pipe.pipeline_enabled = False
    pipe.run_pipeline_sync_async()
    assert pipe.wait_for_background() == []
    assert calls == []
    assert not pipe.pipeline_syncing


def test_a_sync_is_held_while_the_github_login_is_unknown(pipe, monkeypatch):
    calls = []
    monkeypatch.setattr(pipeline, "tick", lambda settings, started=None: calls.append(settings) or {})
    monkeypatch.setattr(Store, "fetch_me", lambda self: None)
    pipe.me = ""
    assert pipe._pipeline_sync_once() == {"error": "GitHub login unknown — is `gh` "
                                                   "installed and authenticated?",
                                          "forced": {}}
    assert calls == []


def test_a_failed_sync_keeps_the_last_result_and_the_forced_items(pipe, monkeypatch):
    monkeypatch.setattr(Store, "run_pipeline_sync_async", lambda self: None)
    answers = [{"error": "gh: rate limited"}, {"error": "gh: rate limited"},
               _result(_fix())]
    handed = []

    def tick(settings, started=None):
        handed.append(settings["force"])
        return answers.pop(0)

    monkeypatch.setattr(pipeline, "tick", tick)
    first = _result()
    pipe.pipeline_result = first
    pipe.pipeline_force_now("rate", ISSUE)
    for _ in range(2):
        pipe._apply_pipeline_sync(pipe._pipeline_sync_once())
        assert pipe.pipeline_result is first
        assert pipe.pipeline_error == "gh: rate limited"
        assert pipe.pipeline_forced("rate") == {ISSUE}
    # Asked again while the third sync ran: kept for the next one.
    plan = pipe._pipeline_sync_once()
    pipe.pipeline_force_now("rate", PR)
    pipe._apply_pipeline_sync(plan)
    assert pipe.pipeline_result["effects"] == [_fix()]
    assert pipe.pipeline_error is None
    assert pipe.pipeline_forced("rate") == {PR}
    assert handed == [{"rate": [ISSUE], "fracture": []}] * 3
    assert _feed("pipeline-error") == ["gh: rate limited"]
    assert _feed("pipeline-recovered") == ["Pipeline syncing again"]
    assert _keys(pipe) == ["issues:o/r#12"]


def test_a_notice_is_logged_when_it_first_appears(pipe):
    first = {**_result(), "notices": ["Linear was not read: no API key"]}
    _sync(pipe, first)
    _sync(pipe, dict(first))
    _sync(pipe, {**first, "notices": [
        "Linear was not read: no API key", "o/r could not be read: gh: rate limited"]})
    assert _feed("pipeline-notice") == ["Linear was not read: no API key",
                                        "o/r could not be read: gh: rate limited"]


def _event(at: str, item: str, kind: str, detail: str) -> dict:
    return {"at": at, "item": item, "kind": kind, "detail": detail}


def test_each_merge_and_split_is_logged_once(pipe):
    """Whatever the switches: the core made them. The log the core keeps repeats an
    event in every result after it, so only those past the previous result are new."""
    pipe.pipeline_fix = pipe.pipeline_fast_track = False
    old = _event("2026-11-20T09:00:00Z", PR, "merged", "merged 0000000 with --admin --squash")
    merged = _event("2026-11-20T10:00:00Z", PR, "merged", "merged abc1234 with --admin --squash")
    split = _event("2026-11-20T10:00:00Z", ISSUE, "fractured", "split into 2 parts")
    rated = _event("2026-11-20T10:00:00Z", ISSUE, "rated", "low risk, low complexity")
    items = (_item(), _item(PR, kind="pr", label="#7"))
    pipe.pipeline_result = {**_result(items=items), "events": [old]}
    first = {**_result(items=items), "events": [old, rated, merged, split]}
    _sync(pipe, first)
    _sync(pipe, dict(first))
    later = _event("2026-11-20T10:00:00Z", "https://github.com/o/r/pull/8", "merged", "merged")
    _sync(pipe, {**first, "events": [old, rated, merged, split, later]})
    assert _feed("pipeline-merge") == ["#7: merged abc1234 with --admin --squash",
                                       "https://github.com/o/r/pull/8: merged"]
    assert _feed("pipeline-fracture") == ["#12: split into 2 parts"]
    # One older than anything the previous result showed is not new, though that
    # result left it out.
    older = _event("2026-11-20T09:30:00Z", PR, "merged", "merged 1111111")
    _sync(pipe, {**first, "events": [older]})
    assert len(_feed("pipeline-merge")) == 2


def test_the_first_sync_is_told_apart_from_the_last_one_before_launch(pipe, monkeypatch):
    """A relaunch logs no merge the last launch saw: ``last.json`` is read before the
    first sync replaces it."""
    merged = _event("2026-11-20T10:00:00Z", PR, "merged", "merged abc1234")
    before = {**_result(), "events": [merged]}
    read = []
    monkeypatch.setattr(pipeline, "last", lambda: read.append(1) or before)
    monkeypatch.setattr(pipeline, "tick", lambda settings, started=None: dict(before))
    pipe._apply_pipeline_sync(pipe._pipeline_sync_once())
    pipe._apply_pipeline_sync(pipe._pipeline_sync_once())
    assert read == [1]
    assert _feed("pipeline-merge") == []


def test_a_sync_asked_for_while_one_runs_follows_it(pipe, monkeypatch):
    import threading

    entered, gate = threading.Event(), threading.Event()
    handed = []

    def tick(settings, started=None):
        handed.append(settings["force"]["rate"])
        if len(handed) == 1:
            entered.set()
            gate.wait(10)
        return _result()

    monkeypatch.setattr(pipeline, "tick", tick)
    QApplication.instance() or QApplication([])
    pipe.run_pipeline_sync_async()
    assert entered.wait(10)
    pipe.pipeline_force_now("rate", ISSUE)
    gate.set()
    _land(pipe)
    assert handed == [[], [ISSUE]]
    assert not pipe.pipeline_syncing


def _land(pipe, syncs: int = 2) -> None:
    """Wait out each sync and apply it, which starts the one asked for meanwhile."""
    for _ in range(syncs):
        assert pipe.wait_for_background() == []
        QApplication.processEvents()


def test_a_sync_asked_for_while_one_runs_waits_for_its_plan_to_be_applied(pipe,
                                                                          monkeypatch):
    """So it is handed none of the forces the first one took."""
    entered, gate = threading.Event(), threading.Event()
    handed = []

    def tick(settings, started=None):
        handed.append(settings["force"]["rate"])
        if len(handed) == 1:
            entered.set()
            gate.wait(10)
        return _result()

    monkeypatch.setattr(pipeline, "tick", tick)
    QApplication.instance() or QApplication([])
    pipe.pipeline_force_now("rate", ISSUE)
    assert entered.wait(10)
    pipe.pipeline_force_now("rate", PR)
    gate.set()
    assert pipe.wait_for_background() == []
    assert (handed, pipe.pipeline_syncing) == ([[ISSUE]], True)
    QApplication.processEvents()
    assert pipe.pipeline_syncing
    _land(pipe, 1)
    assert handed == [[ISSUE], [PR]]
    assert (pipe.pipeline_forced("rate"), pipe.pipeline_syncing) == (frozenset(), False)


# MARK: - What the screen shows and starts


def test_badges_name_the_items_something_is_on(pipe, monkeypatch):
    linear_item = _item(LINEAR, source="linear", label="ENG-12")
    other = _item("https://github.com/o/r/issues/13", label="#13")
    running = _item("https://github.com/o/r/issues/14", label="#14")
    pr = _item(PR, kind="pr", label="#7")
    pipe.pipeline_result = _result(items=(_item(), linear_item, other, running, pr))
    pipe._apply_pipeline_effects(_result(_fix(), _linear()), time.time())
    rows = [autofix.RunningAgent(pr_number=7, label="Auto · Review · #7 · max",
                                 kind="review", tracked=True, item="o/r#7"),
            autofix.RunningAgent(pr_number=0, label="Auto · Issues · #14 · quick",
                                 kind="issues", tracked=True)]
    monkeypatch.setattr(Store, "running_tasks", property(lambda self: rows))
    assert pipe.pipeline_badges() == {ISSUE: "queued", LINEAR: "queued",
                                      running["id"]: "agent", PR: "agent"}


def _start(pipe, item: dict) -> str | None:
    pipe.pipeline_result = pipe.pipeline_result or _result(items=(item,))
    return pipe.pipeline_start_fix(item)


def test_start_fix_queues_the_candidates_fix_past_its_record(pipe):
    """With the fix switch off the sync owes no effect: the item alone names the fix.
    A record that is cooling down, or concluded, does not stop it."""
    pipe.pipeline_fix = False
    now = time.time()
    pipe._save_attempts(PIPELINE_ATTEMPTS, {f"pipeline-fix:{ISSUE}": autofix.ReviewAttempt(
        "fix", now - 60, 2, concluded_at=now - 30)})
    item = _item(author="carol")
    assert _start(pipe, item) is None
    [task] = pipe.queued_tasks
    assert (task.id, task.job.kind, task.job.prompt, task.job.counter,
            task.job.author_login) == ("issues:o/r#12", "issues", "PROMPT:issues:12",
                                       "pipeline", "carol")
    record = pipe._load_attempts(PIPELINE_ATTEMPTS)[f"pipeline-fix:{ISSUE}"]
    assert (record.requested_at, record.attempts, record.concluded_at) == ("fix", 3, None)
    assert record.last_dispatched_at >= now
    label = pipe.pipeline_work(_fix()).label_among(1)
    assert _feed("pipeline-fix") == [f"{label} queued from the Pipeline screen"]
    assert pipe.pipeline_badges() == {ISSUE: "queued"}
    assert [w.by_hand for w in pipe.requested_work] == [True]
    assert _start(pipe, item) == "Its fix is already queued"


def test_start_fix_says_why_it_queued_nothing(pipe, monkeypatch):
    linear = _item(LINEAR, source="linear", label="ENG-12")
    held = _item(LINEAR.replace("ENG-12", "OPS-7"), source="linear", label="OPS-7",
                 hold="Linear team OPS has no root to fix it in")
    elsewhere = _item("https://github.com/x/y/issues/12", repo="x/y")
    pipe.pipeline_result = _result(items=(_item(), linear, held, elsewhere))
    pipe.pipeline_enabled = False
    assert pipe.pipeline_start_fix(_item()) == "The pipeline is off"
    pipe.pipeline_enabled = True
    assert pipe.pipeline_start_fix(linear) == ("Diplomat has this Linear issue's text only "
                                               "while Open fix PRs is on")
    assert pipe.pipeline_start_fix(held) == "Linear team OPS has no root to fix it in"
    assert pipe.pipeline_start_fix(elsewhere) == (
        "x/y is no GitHub repo root here, so there is nowhere to fix it")
    row = autofix.RunningAgent(pr_number=0, label="Auto · Issues · #12 · quick",
                               kind="issues", tracked=True)
    monkeypatch.setattr(Store, "running_tasks", property(lambda self: [row]))
    assert pipe.pipeline_start_fix(_item()) == "An agent is already fixing it"
    assert pipe.queued_tasks == []
    assert _feed("pipeline-fix") == []


def test_start_fix_goes_by_the_last_sync_not_the_card_it_was_pressed_on(pipe):
    """The card was drawn from an older result: the issue has since been assigned to
    someone else, been rated past the fast track, or gone."""
    card = _item()
    pipe.pipeline_result = _result(items=(_item(writable=False, assignees=["bob"]),))
    assert pipe.pipeline_start_fix(card) == "It is assigned to someone else"
    pipe.pipeline_result = _result(items=(_item(stage="human", lane="human"),))
    assert pipe.pipeline_start_fix(card) == "The last sync found it no fix candidate"
    pipe.pipeline_result = _result()
    assert pipe.pipeline_start_fix(card) == "The last sync found it no fix candidate"
    assert pipe.queued_tasks == []


def test_start_fix_asks_under_the_author_the_sync_named(pipe):
    """The emitted effect's author, a split part's root author, is its ban dimension."""
    child = _item(author="alice")
    pipe.pipeline_result = _result(_fix(author="mallory"), items=(child,))
    assert pipe.pipeline_start_fix(child) is None
    assert [w.author for w in pipe.requested_work] == ["mallory"]


def test_start_fix_refuses_a_held_part_and_asks_one_it_emitted_nothing_for_as_its_roots(pipe):
    """A part split off mallory's issue, filed by the operator: held, Start fix says the
    hold; unheld with no emitted fix, the fix built from its link is mallory's."""
    held = _item(author="alice", splitFrom="mallory",
                 hold="split from an issue of @mallory, who is on the prompt-injection ban list")
    pipe.pipeline_result = _result(items=(held,))
    assert pipe.pipeline_fix_effect(held) is None
    assert pipe.pipeline_start_fix(held) == held["hold"]
    assert pipe.queued_tasks == []
    unheld = {**held, "hold": None}
    pipe.pipeline_result = _result(items=(unheld,))
    assert pipe.pipeline_start_fix(unheld) is None
    assert [w.author for w in pipe.requested_work] == ["mallory"]


def test_start_fix_of_a_linear_issue_queues_its_synced_text(pipe):
    linear = _item(LINEAR, source="linear", label="ENG-12")
    pipe.pipeline_result = _result(_linear(), items=(linear,))
    assert pipe.pipeline_start_fix(linear) is None
    assert [t.id for t in pipe.queued_tasks] == ["issues:linear:ENG-12"]
    assert pipe.pipeline_badges() == {LINEAR: "queued"}


def test_a_pipeline_run_dates_its_record_when_it_spawns_and_concludes_it_when_it_reports(
        pipe, monkeypatch):
    """Twin of ``pipelineSpawned`` and ``pipelineConcluded``: the backoff runs from the
    spawn, not the wait in the queue; a run whose agent said its turn was over answered
    the effect, so no later sync asks again, past the whole backoff ladder."""
    from diplomat_runtime import agentregistry

    calls = _spawn_recorder(monkeypatch)
    asked = time.time() - 600
    pipe._apply_pipeline_effects(_result(_fix()), asked)
    [task] = pipe.queued_tasks
    pipe._execute_queued_task(task)
    assert len(calls) == 1
    record = pipe._load_attempts(PIPELINE_ATTEMPTS)[f"pipeline-fix:{ISSUE}"]
    assert record.last_dispatched_at > asked + 500

    (run,) = agentregistry.load()
    assert (run.kind, run.pr_url) == ("issues", ISSUE)
    fake_probes(monkeypatch, activity={run.run_id: ("idle", time.time() - 5)})
    pipe._settle_agents()
    assert agentregistry.load() == [], "the run must retire, or this pins nothing"
    record = pipe._load_attempts(PIPELINE_ATTEMPTS)[f"pipeline-fix:{ISSUE}"]
    assert record.concluded_at is not None

    pipe.requested_work = []
    pipe.queued_tasks = []
    pipe._apply_pipeline_effects(_result(_fix()), time.time() + 4 * 3600)
    assert _keys(pipe) == []


def test_a_run_that_did_not_report_leaves_its_record_open(pipe, monkeypatch):
    from diplomat_runtime import agentregistry

    calls = _spawn_recorder(monkeypatch)
    pipe._apply_pipeline_effects(_result(_fix()), time.time())
    pipe._execute_queued_task(pipe.queued_tasks[0])
    with open(calls[0]["done"], "w") as fh:
        fh.write("0")
    fake_probes(monkeypatch)
    pipe._settle_agents()
    assert agentregistry.load() == []
    assert pipe._load_attempts(PIPELINE_ATTEMPTS)[f"pipeline-fix:{ISSUE}"].concluded_at is None


def test_a_pipeline_identity_names_an_item_across_its_links():
    assert [pipeline.identity(u) for u in (
        ISSUE, "https://github.com/O/R/issues/12#issuecomment-1", LINEAR,
        "https://linear.app/acme/issue/ENG-12", "https://linear.app/acme/project/x",
        "not a link")] == [
        "o/r#12", "o/r#12", "linear:ENG-12", "linear:ENG-12",
        "https://linear.app/acme/project/x", "not a link"]


# MARK: - The core's answer


def test_sync_secs_is_held_between_the_floor_and_a_day(monkeypatch):
    monkeypatch.delenv(pipeline.SECS_ENV, raising=False)
    for asked, held in [(300, 300), (5, 60), (float("inf"), 300), (10**9, 86400)]:
        monkeypatch.setattr(pipeline, "tunables",
                            lambda asked=asked: {"syncSecs": asked, "minSyncSecs": 60})
        assert pipeline.sync_secs() == held


@pytest.mark.parametrize("env, held", [
    ("120", 120.0), ("90.5", 90.5), ("1e3", 1000.0), ("5", 60.0), ("999999", 86400.0),
    # Not a finite decimal number: the asset's period.
    ("inf", 300.0), ("nan", 300.0), ("1e999", 300.0), (" 120", 300.0), ("1_000", 300.0),
    ("", 300.0), ("soon", 300.0),
])
def test_the_sync_period_follows_its_environment_override(monkeypatch, env, held):
    """Twin of ``Store.pipelineSyncInterval``: ``Double(_:)`` takes neither spaces nor
    underscores, which ``float`` would."""
    monkeypatch.setattr(pipeline, "tunables", lambda: {"syncSecs": 300, "minSyncSecs": 60})
    monkeypatch.setenv(pipeline.SECS_ENV, env)
    assert pipeline.sync_secs() == held


def test_a_syncs_deadline_grows_with_what_it_may_do(monkeypatch):
    monkeypatch.setattr(pipeline, "tunables",
                        lambda: {"rater": {"perSync": 4, "timeoutSecs": 300}})
    # 4 ratings, a fracture and the 3 forced: 8 claude calls at 300 + 5 + 16 gh calls of
    # 65; each of the 2 splits 6 parts of 5 gh calls; 2 roots of 216 gh calls (below);
    # Linear; the lookups and the margin.
    assert pipeline.tick_timeout({
        "roots": [{}, {}], "linearTeams": [{}],
        "force": {"rate": ["a", "b"], "fracture": ["c"]}}) == (
            8 * 1345 + 2 * 1950 + 2 * 14040 + 300 + 40)
    assert pipeline.tick_timeout({}) == 5 * 1345 + 1950 + 14040 + 40


def test_a_syncs_deadline_fits_a_capped_roots_whole_read():
    """A root read whole at ``githubMaxItems`` open issues and as many open PRs, every page
    cut to ``githubPage.least`` by timeouts: 300 / 3 pages of each, the first two in one
    ``Repo`` call, the halvings that cut them (100 issues to 3 in five, 12 PRs in two),
    and 10 calls for its merges."""
    t = pipeline.tunables()
    assert (t["githubMaxItems"], t["githubPage"]) == (300, {"issues": 100, "prs": 12, "least": 3})
    per_root = pipeline.tick_timeout({"roots": [{}, {}]}) - pipeline.tick_timeout({"roots": [{}]})
    assert per_root == (2 * 100 - 1 + 5 + 2 + 10) * 65


def test_a_syncs_deadline_is_a_day_at_most(monkeypatch):
    monkeypatch.setattr(pipeline, "tunables",
                        lambda: {"githubMaxItems": 10**6, "githubPage": {"least": 0}})
    assert pipeline.tick_timeout({"roots": [{}]}) == pipeline.MAX_SYNC_SECS


def test_the_linear_teams_line_is_read_entry_by_entry():
    assert pipeline.parse_linear_teams(
        " eng=o/r ,\nOPS = o/other.js;ENG=o/elsewhere; nope ,= o/r, A=b") == (
        [{"key": "ENG", "repo": "o/r"}, {"key": "OPS", "repo": "o/other.js"}],
        ["nope", "= o/r", "A=b"])
    assert pipeline.parse_linear_teams("") == ([], [])


def test_a_linear_team_is_ascii_and_trimmed_of_ascii_space_only():
    """``PipelineSettings.LinearTeam.parse``'s rule; test_pipeline_teams_parity.py pins
    the two against each other."""
    assert pipeline.parse_linear_teams("\u00a0ENG=o/r, x=o/\u00f1, \u00c4=o/r, ok=o/r\r") == (
        [{"key": "OK", "repo": "o/r"}], ["\u00a0ENG=o/r", "x=o/\u00f1", "\u00c4=o/r"])


def _fake_core(tmp_path, monkeypatch, answer: str, status: int = 0):
    """A ``diplomat-core`` that keeps its argv and stdin and answers ``answer``."""
    (tmp_path / "answer").write_text(answer)
    core = tmp_path / "diplomat-core"
    core.write_text(f"#!/bin/sh\nprintf '%s' \"$*\" > {tmp_path}/argv\n"
                    f"cat > {tmp_path}/stdin\ncat {tmp_path}/answer\n"
                    f"echo 'it failed' >&2\nexit {status}\n")
    core.chmod(0o755)
    monkeypatch.setenv("DIPLOMAT_CORE_BIN", str(core))


def test_a_sync_hands_the_core_its_settings_and_reads_back_its_result(tmp_path,
                                                                      monkeypatch):
    answer = {**_result(_fix(), items=(_item(),)), "notices": ["Linear: no key"],
              "graph": {"nodes": [{"id": ISSUE, "column": 0, "row": 0}], "edges": []}}
    _fake_core(tmp_path, monkeypatch, json.dumps(answer))
    settings = {"roots": [], "linearTeams": [], "rate": True, "fix": False,
                "fastTrack": False, "merge": False, "fracture": False,
                "force": {"rate": [], "fracture": []}}
    assert pipeline.tick(settings) == answer
    assert (tmp_path / "argv").read_text() == "pipeline-tick"
    assert json.loads((tmp_path / "stdin").read_text()) == settings
    assert pipeline.last() == answer
    assert (tmp_path / "argv").read_text() == "pipeline-last"


@pytest.mark.parametrize("answer, status, error", [
    ("{}", 1, "diplomat-core pipeline-tick failed: it failed"),
    ('{"items": "no"}', 0, "diplomat-core pipeline-tick answered something that is not a "
                           "sync"),
    ("not json", 0, "Expecting value: line 1 column 1 (char 0)"),
])
def test_a_core_that_cannot_answer_is_an_error_never_a_raise(tmp_path, monkeypatch,
                                                             answer, status, error):
    _fake_core(tmp_path, monkeypatch, answer, status)
    assert pipeline.tick({}) == {"error": error}


def test_a_core_past_its_deadline_is_an_error_at_once(tmp_path, monkeypatch):
    """Whatever it started still holding its output open."""
    core = tmp_path / "diplomat-core"
    core.write_text("#!/bin/sh\nsleep 30 &\nsleep 30\n")
    core.chmod(0o755)
    monkeypatch.setenv("DIPLOMAT_CORE_BIN", str(core))
    monkeypatch.setattr(pipeline, "tick_timeout", lambda settings: 1)
    began = time.monotonic()
    assert pipeline.tick({}) == {"error": "diplomat-core pipeline-tick did not answer "
                                          "within 1s"}
    assert time.monotonic() - began < 10


def test_a_malformed_result_keeps_only_what_it_should_hold(tmp_path, monkeypatch):
    _fake_core(tmp_path, monkeypatch, json.dumps({
        "at": "x", "items": [{"id": "a"}, 3], "graph": {"nodes": "no", "edges": [None]},
        "effects": [{"kind": "review"}, "x"], "notices": ["one", 2], "unread": ["o/r", 3],
        "fixable": [ISSUE, None]}))
    assert pipeline.tick({}) == {
        "at": "x", "items": [{"id": "a"}], "graph": {"nodes": [], "edges": []},
        "effects": [{"kind": "review"}], "events": [], "notices": ["one"],
        "unread": ["o/r"], "fixable": [ISSUE]}


# MARK: - What a running sync reads


def _control() -> dict:
    return json.loads((pipeline.pipeline_dir() / "control.json").read_text())


def test_each_switch_is_written_where_a_running_sync_reads_it(pipe):
    """``control.json``: the core reads it before each write, so a switch turned off
    stops the sync already running."""
    assert _control() == {"enabled": True, "rate": False, "fix": True, "fastTrack": True,
                          "merge": False, "fracture": False}
    for name, key in [("pipeline_merge", "merge"), ("pipeline_fracture", "fracture"),
                      ("pipeline_rate", "rate")]:
        setattr(pipe, name, True)
        assert _control()[key] is True
    pipe.pipeline_enabled = False
    assert _control()["enabled"] is False
    mode = stat.S_IMODE(os.stat(pipeline.pipeline_dir() / "control.json").st_mode)
    assert mode == 0o600
    assert [f.name for f in pipeline.pipeline_dir().iterdir()] == ["control.json"]


def test_a_sync_writes_the_switches_before_it_starts(pipe, monkeypatch):
    seen = []
    monkeypatch.setattr(pipeline, "tick", lambda settings, started=None: seen.append(
        _control()) or _result())
    (pipeline.pipeline_dir() / "control.json").unlink()
    pipe._pipeline_sync_once()
    assert seen == [{"enabled": True, "rate": False, "fix": True, "fastTrack": True,
                     "merge": False, "fracture": False}]


def test_a_headless_store_writes_the_switches_only_into_a_named_dir(pipe, tmp_path,
                                                                    monkeypatch):
    """A render's switches never reach the live app's sync."""
    monkeypatch.setenv("DIPLOMAT_RENDER", "settings")
    monkeypatch.delenv("DIPLOMAT_PIPELINE_DIR")
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    pipe.pipeline_merge = True
    assert not (tmp_path / "home").exists()
    monkeypatch.setenv("DIPLOMAT_PIPELINE_DIR", str(tmp_path / "named"))
    pipe.pipeline_merge = False
    assert _control()["merge"] is False


def test_an_unwritable_control_file_is_no_raise(pipe, tmp_path, monkeypatch):
    monkeypatch.setenv("DIPLOMAT_PIPELINE_DIR", str(tmp_path / "file"))
    (tmp_path / "file").write_text("not a dir")
    pipe.pipeline_merge = True
    assert (tmp_path / "file").read_text() == "not a dir"


def _core_that_waits(tmp_path, monkeypatch):
    """A ``diplomat-core`` that starts a child in a process group of its own, as
    Foundation's ``Process`` starts ``gh`` and ``claude``, and waits on it. The child
    notes both pids."""
    child = ("import os, sys, time; os.setpgid(0, 0); "
             "open(sys.argv[1], 'w').write(f'{os.getppid()} {os.getpid()}'); time.sleep(300)")
    core = tmp_path / "diplomat-core"
    core.write_text(f"#!/bin/sh\n[ \"$1\" = pipeline-tick ] || exit 1\n"
                    f"'{sys.executable}' -c \"{child}\" {tmp_path}/pids &\nwait\n")
    core.chmod(0o755)
    monkeypatch.setenv("DIPLOMAT_CORE_BIN", str(core))
    return tmp_path / "pids"


def _pids(pids_file) -> tuple[int, int]:
    deadline = time.time() + 10
    while not (pids_file.exists() and pids_file.read_text().strip()) and time.time() < deadline:
        time.sleep(0.05)
    core, child = (int(x) for x in pids_file.read_text().split())
    return core, child


def _all_dead(*pids: int) -> bool:
    deadline = time.time() + 5
    while any(_alive(pid) for pid in pids) and time.time() < deadline:
        time.sleep(0.05)
    return not any(_alive(pid) for pid in pids)


def _alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    # A zombie is gone but for its parent's wait.
    try:
        with open(f"/proc/{pid}/stat") as fh:
            return fh.read().split(") ")[-1][0] != "Z"
    except OSError:
        return True


def test_stopping_the_sync_ends_its_core_and_what_the_core_started(pipe, tmp_path,
                                                                   monkeypatch):
    """Quitting the app: a sync inside the macOS app ends with it."""
    pids_file = _core_that_waits(tmp_path, monkeypatch)
    monkeypatch.setattr(pipeline, "tick_timeout", lambda settings: 60)
    done = []
    worker = threading.Thread(target=lambda: done.append(pipe._pipeline_sync_once()),
                              daemon=True)
    worker.start()
    core, child = _pids(pids_file)
    try:
        pipe.stop_pipeline_sync()
        worker.join(10)
        assert not worker.is_alive()
        assert done[0]["error"].startswith("diplomat-core pipeline-tick failed")
        assert _all_dead(core, child)
    finally:
        for pid in (core, child):
            with contextlib.suppress(OSError):
                os.kill(pid, signal.SIGKILL)
    # And none starts after.
    monkeypatch.setattr(pipeline, "tick", lambda settings, started=None: pytest.fail("ran"))
    pipe.run_pipeline_sync_async()
    assert pipe.wait_for_background() == []


def test_a_core_past_its_deadline_is_ended_with_what_it_started(tmp_path, monkeypatch):
    pids_file = _core_that_waits(tmp_path, monkeypatch)
    monkeypatch.setattr(pipeline, "tick_timeout", lambda settings: 2)
    done = []
    worker = threading.Thread(target=lambda: done.append(pipeline.tick({})), daemon=True)
    worker.start()
    core, child = _pids(pids_file)
    try:
        worker.join(15)
        assert done == [{"error": "diplomat-core pipeline-tick did not answer within 2s"}]
        assert _all_dead(core, child)
    finally:
        for pid in (core, child):
            with contextlib.suppress(OSError):
                os.kill(pid, signal.SIGKILL)


def test_a_core_that_starts_after_the_stop_is_stopped_at_once(pipe, monkeypatch):
    stopped = []
    monkeypatch.setattr(promptcore, "stop", lambda proc: stopped.append(proc))
    pipe.stop_pipeline_sync()
    pipe._pipeline_started("proc")
    assert stopped == ["proc"]


# MARK: - The period


def test_then_runs_once_the_syncs_running_end(pipe, monkeypatch):
    """The app's timer is re-armed through ``then``, so the period runs from the end of
    a sync and a long one is not followed at once by the next."""
    entered, gate = threading.Event(), threading.Event()
    ticks = []

    def tick(settings, started=None):
        ticks.append(1)
        if len(ticks) == 1:
            entered.set()
            gate.wait(10)
        return _result()

    monkeypatch.setattr(pipeline, "tick", tick)
    QApplication.instance() or QApplication([])
    calls = []
    pipe.run_pipeline_sync_async(then=lambda: calls.append("first"))
    assert entered.wait(10)
    pipe.run_pipeline_sync_async(then=lambda: calls.append("second"))
    gate.set()
    assert pipe.wait_for_background() == []
    QApplication.processEvents()
    assert calls == []
    _land(pipe, 1)
    assert (len(ticks), calls) == (2, ["first", "second"])
    pipe.pipeline_enabled = False
    pipe.run_pipeline_sync_async(then=lambda: calls.append("off"))
    assert calls[-1] == "off"


def test_the_apps_sync_timer_is_armed_only_once_a_sync_ends(monkeypatch):
    from PySide6.QtCore import QObject, QTimer, Signal

    from diplomat_app import app as app_module

    QApplication.instance() or QApplication([])
    asked = []

    class _Store(QObject):
        autofix_poll_started = Signal()

        def run_pipeline_sync_async(self, *, then=None):
            asked.append(then)

        def __getattr__(self, name):
            return lambda *args, **kwargs: None

    class _Timer(QTimer):
        @staticmethod
        def singleShot(*args, **kwargs):
            pass

    class _Anything:
        def __getattr__(self, name):
            return _Anything()

        def __call__(self, *args, **kwargs):
            return _Anything()

    monkeypatch.setattr(app_module, "Store", _Store)
    monkeypatch.setattr(app_module, "QTimer", _Timer)
    for name in ("QApplication", "Panel", "_app_icon"):
        monkeypatch.setattr(app_module, name, _Anything())
    monkeypatch.setattr(app_module.DiplomatApp, "_build_tray", lambda self: None)
    monkeypatch.setattr(app_module.DiplomatApp, "trigger_refresh", lambda self: None)
    app = app_module.DiplomatApp()
    try:
        timer = app.pipeline_timer
        assert timer.isSingleShot() and not timer.isActive()
        app._pipeline_tick()
        assert not timer.isActive()
        asked[-1]()
        assert timer.isActive()
        assert timer.interval() == int(pipeline.sync_secs() * 1000)
    finally:
        for t in vars(app).values():
            if isinstance(t, QTimer):
                t.stop()


def test_a_failing_apply_still_re_arms_the_timer(pipe, monkeypatch):
    def broken(self, result, now, judged):
        raise RuntimeError("boom")

    monkeypatch.setattr(Store, "_apply_pipeline_effects", broken)
    calls = []
    with pipe._pipeline_lock:
        pipe._pipeline_then = [lambda: calls.append(1)]
    with pytest.raises(RuntimeError):
        _sync(pipe, _result())
    assert calls == [1]


def test_a_follow_up_sync_stops_once_the_pipeline_is_off(pipe, monkeypatch):
    """Asked for while one ran, then the master switch went off: no second sync."""
    entered, gate = threading.Event(), threading.Event()
    ticks = []

    def tick(settings, started=None):
        ticks.append(1)
        entered.set()
        gate.wait(10)
        return _result()

    monkeypatch.setattr(pipeline, "tick", tick)
    QApplication.instance() or QApplication([])
    pipe.run_pipeline_sync_async()
    assert entered.wait(10)
    pipe.pipeline_force_now("rate", ISSUE)
    pipe.pipeline_enabled = False
    gate.set()
    _land(pipe)
    assert len(ticks) == 1
    assert not pipe.pipeline_syncing


# MARK: - A stale answer


def test_a_sync_that_found_the_lock_held_retires_nothing(pipe, monkeypatch):
    """The core answers the last result again when tick.lock is held or cannot be
    opened: it read nothing, so the forces it was handed stand, and so do the queued asks."""
    monkeypatch.setattr(Store, "run_pipeline_sync_async", lambda self: None)
    pipe.pipeline_force_now("rate", ISSUE)
    pipe._request([pipe.pipeline_work(_fix())])
    stale = _result(items=(_item(writable=False),), at="2026-11-20T10:00:00Z")
    monkeypatch.setattr(pipeline, "tick", lambda settings, started=None: stale)
    pipe._apply_pipeline_sync(pipe._pipeline_sync_once())
    assert pipe.pipeline_result is stale
    assert pipe.pipeline_forced("rate") == {ISSUE}
    assert _keys(pipe) == ["issues:o/r#12"]
    fresh = _result(items=(_item(writable=False),))
    monkeypatch.setattr(pipeline, "tick", lambda settings, started=None: fresh)
    pipe._apply_pipeline_sync(pipe._pipeline_sync_once())
    assert pipe.pipeline_forced("rate") == frozenset()
    assert _keys(pipe) == []


def test_ran_since_is_to_the_second():
    """A result is dated, to the second, when its sync began."""
    started = datetime(2026, 11, 20, 10, 0, 0, 700000, tzinfo=timezone.utc).timestamp()
    assert pipeline.ran_since({"at": "2026-11-20T10:00:00Z"}, started)
    assert not pipeline.ran_since({"at": "2026-11-20T09:59:59Z"}, started)
    assert not pipeline.ran_since({"at": "x"}, started)
    assert not pipeline.ran_since({}, started)


# MARK: - Asks a later sync no longer owes


def _queued_fix(pipe, effect=None) -> None:
    pipe._apply_pipeline_effects(_result(effect or _fix()), time.time())
    assert _keys(pipe) == [pipe.pipeline_work(effect or _fix()).key]


@pytest.mark.parametrize("now", [
    _item(writable=False, assignees=["bob"]),
    _item(stage="fixing"),
    _item(stage="human", lane="human"),
    _item(state="closed", stage="closed", lane="done", writable=False),
])
def test_a_queued_fix_leaves_when_its_issue_is_no_writable_candidate(pipe, now):
    _queued_fix(pipe)
    _sync(pipe, _result(items=(now,)))
    assert _keys(pipe) == []
    assert pipe.queued_tasks == []
    label = pipe.pipeline_work(_fix()).label_among(1)
    assert _feed("queue-drop") == [f"{label} - the pipeline no longer owes it, not run"]


@pytest.mark.parametrize("fix, now", [
    # Open fix PRs switched off.
    (False, _item()),
    # A hold.
    (True, _item(hold="the author is banned")),
])
def test_a_queued_fix_leaves_once_the_sync_emits_none(pipe, fix, now):
    _queued_fix(pipe)
    pipe.pipeline_fix = fix
    _sync(pipe, _result(items=(now,)))
    assert _keys(pipe) == []


def test_a_start_fix_stays_while_its_issue_is_fixable(pipe):
    """``fixable`` names it whether or not ``items``, which the layout caps, holds it."""
    pipe.pipeline_fix = False
    assert _start(pipe, _item()) is None
    _sync(pipe, _result(items=(_item(),), fixable=(ISSUE,)))
    _sync(pipe, _result(fixable=(ISSUE,)))
    assert _keys(pipe) == ["issues:o/r#12"]
    _sync(pipe, _result(items=(_item(writable=False, assignees=["bob"]),)))
    assert _keys(pipe) == []


def test_a_start_fix_leaves_once_a_whole_read_finds_its_issue_gone(pipe):
    pipe.pipeline_fix = False
    assert _start(pipe, _item()) is None
    _sync(pipe, _result())
    assert _keys(pipe) == []


@pytest.mark.parametrize("effect", [_fix(), _linear()])
def test_a_queued_fix_leaves_once_a_whole_read_finds_its_issue_gone(pipe, effect):
    """Closed on GitHub, completed or canceled on Linear: no item, and no effect."""
    _queued_fix(pipe, effect)
    _sync(pipe, _result())
    assert _keys(pipe) == []


def test_nothing_leaves_in_a_root_the_sync_could_not_judge_in_full(pipe):
    _queued_fix(pipe)
    _sync(pipe, _result(items=(_item(writable=False, assignees=["bob"]),), unread=("O/R",)))
    assert _keys(pipe) == ["issues:o/r#12"]


@pytest.mark.parametrize("switch, left", [
    ("pipeline_fix", ["issues:o/r#13", "review:o/r#7"]),
    ("pipeline_fast_track", ["issues:linear:ENG-12", "issues:o/r#12", "issues:o/r#13"]),
])
def test_a_switch_turned_off_withdraws_what_syncs_queued_for_it_at_once(pipe, monkeypatch,
                                                                        switch, left):
    """No sync needed; a Start fix stays."""
    syncs = []
    monkeypatch.setattr(Store, "run_pipeline_sync_async", lambda self: syncs.append(1))
    _sync(pipe, _result(_fix(), _linear(), _review()))
    thirteen = _item("https://github.com/o/r/issues/13", label="#13")
    pipe.pipeline_result = _result(items=(thirteen,))
    assert pipe.pipeline_start_fix(thirteen) is None
    setattr(pipe, switch, False)
    assert sorted(_keys(pipe)) == left
    assert sorted(t.id for t in pipe.drainable_tasks) == left
    assert syncs == []


@pytest.mark.parametrize("ran", [True, False])
def test_a_sync_withdraws_an_ask_whose_switch_is_off_even_in_a_root_it_could_not_read(
        pipe, ran):
    """However it was queued, and whether the result is its own or the last answered
    again."""
    pipe.pipeline_fix = False
    pipe._request([pipe.pipeline_work(_fix())])
    assert _keys(pipe) == ["issues:o/r#12"]
    pipe._apply_pipeline_sync({"result": _result(unread=("o/r",), at="2026-11-20T10:00:00Z"),
                               "forced": {}, "started": 0 if ran else time.time(),
                               "epoch": pipe._pipeline_epoch})
    assert _keys(pipe) == []


@pytest.mark.parametrize("now", [_item(), _item(writable=False, assignees=["bob"])])
def test_a_sync_landing_after_the_pipeline_went_off_withdraws_nothing(pipe, now):
    """Switched off midway, a sync emits no effect."""
    _queued_fix(pipe)
    pipe.pipeline_enabled = False
    _sync(pipe, _result(items=(now,)))
    assert _keys(pipe) == ["issues:o/r#12"]


def test_a_failed_sync_withdraws_nothing(pipe, monkeypatch):
    _queued_fix(pipe)
    monkeypatch.setattr(pipeline, "tick", lambda settings, started=None: {"error": "boom"})
    pipe._apply_pipeline_sync(pipe._pipeline_sync_once())
    assert _keys(pipe) == ["issues:o/r#12"]


def test_a_queued_review_leaves_when_the_sync_owes_it_no_more(pipe):
    """Off the fast track, or Fast-track my PRs switched off: no review effect."""
    pipe._apply_pipeline_effects(_result(_review()), time.time())
    pr = _item(PR, kind="pr", label="#7", stage="fast-track", lane="fast")
    _sync(pipe, _result(_review(), items=(pr,)))
    assert _keys(pipe) == ["review:o/r#7"]
    pipe.pipeline_fast_track = False
    _sync(pipe, _result(items=(pr,)))
    assert _keys(pipe) == []


def test_a_linear_fix_is_judged_by_its_issue_whatever_its_link(pipe):
    _queued_fix(pipe, _linear())
    item = _item("https://linear.app/acme/issue/ENG-12", source="linear", label="ENG-12",
                 writable=False)
    _sync(pipe, _result(items=(item,)))
    assert _keys(pipe) == []


def test_only_the_pipelines_asks_are_withdrawn(pipe):
    sweep = autofix.RequestedWork(
        number=12, url=ISSUE, author="",
        config={"kind": "issues", "target": "specific", "specificIssue": "12"}, repo="o/r")
    assert not sweep.pipeline
    assert pipeline.withdrawn([sweep], _result(items=(_item(writable=False),)), fix=False,
                              fast_track=False) == []


def test_a_starting_fix_is_left_to_its_dispatch(pipe):
    _queued_fix(pipe)
    pipe._begin_starting(pipe.queued_tasks[0])
    _sync(pipe, _result(items=(_item(writable=False),)))
    assert _keys(pipe) == ["issues:o/r#12"]


# MARK: - Records


def test_a_concluded_record_is_kept_for_thirty_days(pipe):
    """A fix whose run concluded and whose PR was closed unmerged is not asked for
    again when the issue comes back as a candidate."""
    now = time.time()
    day = 86400
    concluded = autofix.ReviewAttempt("fix", now - 10 * day, 1, concluded_at=now - 10 * day)
    stale = autofix.ReviewAttempt("fix", now - 31 * day, 1, concluded_at=now - 31 * day)
    open_old = autofix.ReviewAttempt("fix", now - 10 * day, 1)
    other = "pipeline-fix:https://github.com/o/r/issues/"
    pipe._save_attempts(PIPELINE_ATTEMPTS, {f"{other}1": concluded, f"{other}2": stale,
                                            f"{other}3": open_old})
    pipe._apply_pipeline_effects(_result(), now)
    assert pipe._load_attempts(PIPELINE_ATTEMPTS) == {f"{other}1": concluded}
    pipe._apply_pipeline_effects(_result(_fix(1)), now)
    assert _keys(pipe) == []


@pytest.mark.parametrize("teams, kept", [
    ("ENG=o/r", [f"pipeline-fix:{ISSUE}", f"pipeline-fix:{LINEAR}"]),
    # A Linear issue's root is its team's.
    ("", [f"pipeline-fix:{ISSUE}"]),
])
def test_a_sync_keeps_the_records_in_a_root_it_could_not_judge_in_full(pipe, teams, kept):
    """Read in part, or not at all (``state.json`` unreadable): it may have left their
    effects out."""
    pipe.pipeline_linear_teams_raw = teams
    lapsed = autofix.ReviewAttempt("fix", time.time() - autofix.RETRY_MAX_BACKOFF - 1, 2)
    pipe._save_attempts(PIPELINE_ATTEMPTS, {
        f"pipeline-fix:{ISSUE}": lapsed, f"pipeline-fix:{LINEAR}": lapsed,
        "pipeline-fix:https://github.com/x/y/issues/1": lapsed})
    _sync(pipe, _result(unread=("O/R",)))
    assert pipe._load_attempts(PIPELINE_ATTEMPTS) == {k: lapsed for k in kept}


@pytest.mark.parametrize("switch", ["pipeline_enabled", "pipeline_fix",
                                    "pipeline_fast_track"])
def test_a_sync_a_switch_went_off_during_prunes_no_record(pipe, monkeypatch, switch):
    """It may have emitted less than it owes; the next sync prunes."""
    lapsed = autofix.ReviewAttempt("fix", time.time() - autofix.RETRY_MAX_BACKOFF - 1, 2)
    pipe._save_attempts(PIPELINE_ATTEMPTS, {f"pipeline-fix:{ISSUE}": lapsed})

    def flipped(settings, started=None):
        setattr(pipe, switch, False)
        setattr(pipe, switch, True)
        return _result()

    monkeypatch.setattr(pipeline, "tick", flipped)
    pipe._apply_pipeline_sync(pipe._pipeline_sync_once())
    assert pipe._load_attempts(PIPELINE_ATTEMPTS) == {f"pipeline-fix:{ISSUE}": lapsed}
    monkeypatch.setattr(pipeline, "tick", lambda settings, started=None: _result())
    pipe._apply_pipeline_sync(pipe._pipeline_sync_once())
    assert pipe._load_attempts(PIPELINE_ATTEMPTS) == {}


def test_a_queued_linear_fix_is_queued_again_with_the_repo_and_text_a_sync_reads(
        pipe, monkeypatch):
    """Its agent cannot read Linear: the text and the repo it is handed are all it has."""
    web = LocalRepo("o", "web", "/src/web")
    monkeypatch.setattr(review, "repo_roots", lambda: [ROOT, web])
    monkeypatch.setattr("diplomat_runtime.promptcore.build_prompt", json.dumps)
    _sync(pipe, _result(_linear()))
    # As Start fix would have queued it.
    pipe.requested_work = [dataclasses.replace(pipe.requested_work[0], by_hand=True)]
    records = pipe._load_attempts(PIPELINE_ATTEMPTS)
    edited = {**_linear(), "text": "A thing\n\nIt breaks twice."}
    moved = {**edited, "repo": "o/web"}
    for effect in (edited, moved, moved):
        _sync(pipe, _result(effect, fixable=(LINEAR,)))
    [work] = pipe.requested_work
    [task] = pipe.queued_tasks
    assert (work.repo, work.config["linear"]["text"], work.by_hand) == (
        "o/web", "A thing\n\nIt breaks twice.", True)
    prompt = json.loads(task.job.prompt)
    assert (prompt["home"]["path"], prompt["linear"]["text"], task.id) == (
        "/src/web", "A thing\n\nIt breaks twice.", work.key)
    assert pipe._load_attempts(PIPELINE_ATTEMPTS) == records
    label = work.label_among(2)
    assert _feed("pipeline-fix") == [f"{label} queued"] + [
        f"{label} queued again: its repo or text changed"] * 2


def test_a_starting_linear_fix_is_not_queued_again(pipe):
    """A second ask beside it would be a second fix run."""
    _sync(pipe, _result(_linear()))
    pipe._begin_starting(pipe.queued_tasks[0])
    _sync(pipe, _result({**_linear(), "text": "A thing\n\nIt breaks twice."}))
    assert [w.config["linear"]["text"] for w in pipe.requested_work] == ["A thing\n\nIt breaks."]
    assert pipe.queued_tasks == []
    assert len(_feed("pipeline-fix")) == 1


# MARK: - The first sync


def test_pipeline_last_before_any_sync_is_no_sync(tmp_path, monkeypatch, pipe):
    _fake_core(tmp_path, monkeypatch, json.dumps({
        "at": "1970-01-01T00:00:00Z", "items": [], "graph": {"nodes": [], "edges": []},
        "effects": [], "events": [], "notices": [], "unread": [], "fixable": []}))
    assert pipeline.last() is None
    pipe.refresh_pipeline_last()
    assert pipe.pipeline_result is None


def test_with_no_last_result_only_this_syncs_events_are_new(pipe):
    """last.json missing while the log still holds events: the log's past merges are
    not announced as if just made."""
    at = _now_iso()
    old = _event("2026-11-20T09:00:00Z", PR, "merged", "merged 0000000")
    now = _event(at, PR, "merged", "merged abc1234")
    _sync(pipe, {**_result(at=at), "events": [old, now]})
    assert _feed("pipeline-merge") == ["https://github.com/o/r/pull/7: merged abc1234"]


# MARK: - Which runs answer which records


def _run(kind: str, url: str, ledger_key: str = "") -> SimpleNamespace:
    return SimpleNamespace(kind=kind, pr_url=url, ledger_key=ledger_key)


def _attempt(concluded=None) -> autofix.ReviewAttempt:
    return autofix.ReviewAttempt("fix", 100.0, 1, concluded_at=concluded)


def test_a_run_concludes_only_its_own_items_record():
    attempts = {f"pipeline-fix:{ISSUE}": _attempt(),
                "pipeline-fix:https://github.com/o/r/issues/13": _attempt(),
                f"pipeline-review:{PR}": _attempt()}
    out = pipeline.concluded(attempts, [_run(autofix.QUEUE_ISSUES_ACTION, ISSUE)], 500.0)
    assert {k: a.concluded_at for k, a in out.items()} == {
        f"pipeline-fix:{ISSUE}": 500.0,
        "pipeline-fix:https://github.com/o/r/issues/13": None,
        f"pipeline-review:{PR}": None}


def test_a_review_run_concludes_its_prs_review_record():
    attempts = {f"pipeline-review:{PR}": _attempt(),
                "pipeline-fix:https://github.com/o/r/issues/7": _attempt()}
    out = pipeline.concluded(attempts, [_run(autofix.QUEUE_REVIEW_ACTION, PR)], 500.0)
    assert {k: a.concluded_at for k, a in out.items()} == {
        f"pipeline-review:{PR}": 500.0,
        "pipeline-fix:https://github.com/o/r/issues/7": None}


def test_a_run_concludes_its_items_record_keyed_by_another_link_to_it():
    """The core keys a Linear issue by its link less the title's slug."""
    key = "pipeline-fix:https://linear.app/acme/issue/ENG-12"
    out = pipeline.concluded({key: _attempt()}, [_run(autofix.QUEUE_ISSUES_ACTION, LINEAR)],
                             500.0)
    assert out[key].concluded_at == 500.0


def test_a_monitors_run_on_the_pr_concludes_no_record():
    attempts = {f"pipeline-review:{PR}": _attempt()}
    reply = _run(autofix.QUEUE_REVIEW_ACTION, PR, ledger_key=f"review-reply:{PR}@aaa111")
    assert pipeline.concluded(attempts, [reply], 500.0) == attempts


def test_a_concluded_record_is_not_dated_again_by_a_spawn():
    attempts = {f"pipeline-fix:{ISSUE}": _attempt(concluded=200.0)}
    out = pipeline.spawned(attempts, autofix.QUEUE_ISSUES_ACTION, ISSUE, 900.0)
    assert out[f"pipeline-fix:{ISSUE}"].last_dispatched_at == 100.0


def test_a_fix_running_for_another_linear_issue_is_not_this_ones(pipe, monkeypatch):
    """ENG-12's label holds "ENG-1"; only the delimited label names a run's issue."""
    row = autofix.RunningAgent(pr_number=0, label="Auto · Issues · ENG-12 · quick",
                               kind="issues", tracked=True)
    monkeypatch.setattr(Store, "running_tasks", property(lambda self: [row]))
    eng1 = {**_linear(), "identifier": "ENG-1", "url": "https://linear.app/acme/issue/ENG-1",
            "key": "pipeline-fix:https://linear.app/acme/issue/ENG-1"}
    pipe._apply_pipeline_effects(_result(eng1), time.time())
    assert _keys(pipe) == ["issues:linear:ENG-1"]
