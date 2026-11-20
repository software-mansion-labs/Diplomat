"""The Pipeline in the Linux Store: its settings, the sync it runs, and what a sync's
effects do to the queue.

The sync is the core's (``diplomat-core pipeline-tick``); here its answer is a literal,
or a stand-in core that records what it was handed.
"""

from __future__ import annotations

import json
import time

import pytest
from test_autofix import _spawn_recorder, fake_probes, store  # noqa: F401 — fixture

from diplomat_app import bans
from diplomat_app.store import PIPELINE_ATTEMPTS, Store, app_settings
from diplomat_runtime import activity, appconfig, autofix, pipeline, review
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


def _fix(number: int = 12) -> dict:
    url = f"https://github.com/o/r/issues/{number}"
    return {"kind": "fixIssue", "repo": "o/r", "number": number, "url": url,
            "key": f"pipeline-fix:{url}", "stamp": "fix"}


def _linear() -> dict:
    return {"kind": "fixLinear", "repo": "o/r", "identifier": "ENG-12", "url": LINEAR,
            "text": "A thing\n\nIt breaks.", "key": f"pipeline-fix:{LINEAR}", "stamp": "fix"}


def _review(head: str = "abc123") -> dict:
    return {"kind": "review", "repo": "o/r", "number": 7, "url": PR, "headSha": head,
            "key": f"pipeline-review:{PR}", "stamp": head}


def _result(*effects: dict, items: tuple = ()) -> dict:
    return {"at": "2026-11-20T10:00:00Z", "items": list(items),
            "graph": {"nodes": [], "edges": []}, "effects": list(effects), "events": [],
            "notices": []}


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
    pipe.pipeline_force_now("rate", ISSUE)
    pipe.pipeline_force_now("rate", PR)
    pipe.pipeline_force_now("fracture", ISSUE)
    assert pipe.pipeline_settings_payload() == {
        "roots": [{"owner": "o", "repo": "r", "path": "/src/r", "me": "alice"}],
        "linearTeams": [{"key": "ENG", "repo": "o/r"}, {"key": "OPS", "repo": "o/other"}],
        "linearTokenFile": "~/.diplomat/linear",
        "rate": False, "fix": True, "fastTrack": True, "merge": False, "fracture": False,
        "force": {"rate": [ISSUE, PR], "fracture": [ISSUE]},
    }


def test_no_token_file_is_handed_on_when_none_is_named(pipe):
    assert "linearTokenFile" not in pipe.pipeline_settings_payload()


# MARK: - Effects to asks


def test_a_fix_effect_is_the_fix_of_that_one_issue(pipe):
    work = pipe.pipeline_work(_fix(), _item(author="carol"))
    assert work.key == "issues:o/r#12"
    assert (work.number, work.url, work.author, work.repo) == (12, ISSUE, "carol", "o/r")
    assert {k: work.config[k] for k in ("kind", "target", "specificIssue", "me", "pipeline")
            } == {"kind": "issues", "target": "specific", "specificIssue": "12",
                  "me": "alice", "pipeline": True}
    assert work.config["home"]["path"] == "/src/r"
    assert work.pipeline


def test_my_own_issue_has_no_author_to_ban(pipe):
    assert pipe.pipeline_work(_fix(), _item(author="Alice")).author == ""


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


def test_a_banned_authors_issue_is_not_asked_for(pipe):
    pipe._apply_pipeline_effects(_result(_fix(), items=(_item(author="mallory"),)),
                                 time.time())
    assert _keys(pipe) == []


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
    pipe._apply_pipeline_sync({"result": result, "forced": {}})
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
    pipe._apply_pipeline_effects(_result(_fix(), _review()), time.time())
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


# MARK: - The sync


def test_a_sync_reads_nothing_while_the_pipeline_is_off(pipe, monkeypatch):
    calls = []
    monkeypatch.setattr(pipeline, "tick", lambda settings: calls.append(settings) or {})
    pipe.pipeline_enabled = False
    pipe.run_pipeline_sync_async()
    assert pipe.wait_for_background() == []
    assert calls == []
    assert not pipe.pipeline_syncing


def test_a_sync_is_held_while_the_github_login_is_unknown(pipe, monkeypatch):
    calls = []
    monkeypatch.setattr(pipeline, "tick", lambda settings: calls.append(settings) or {})
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

    def tick(settings):
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
    pipe._apply_pipeline_sync({"result": first, "forced": {}})
    pipe._apply_pipeline_sync({"result": dict(first), "forced": {}})
    pipe._apply_pipeline_sync({"result": {**first, "notices": [
        "Linear was not read: no API key", "o/r could not be read: gh: rate limited"]},
        "forced": {}})
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
    pipe._apply_pipeline_sync({"result": first, "forced": {}})
    pipe._apply_pipeline_sync({"result": dict(first), "forced": {}})
    later = _event("2026-11-20T10:00:00Z", "https://github.com/o/r/pull/8", "merged", "merged")
    pipe._apply_pipeline_sync({"result": {**first, "events": [old, rated, merged, split, later]},
                               "forced": {}})
    assert _feed("pipeline-merge") == ["#7: merged abc1234 with --admin --squash",
                                       "https://github.com/o/r/pull/8: merged"]
    assert _feed("pipeline-fracture") == ["#12: split into 2 parts"]
    # One older than anything the previous result showed is not new, though that
    # result left it out.
    older = _event("2026-11-20T09:30:00Z", PR, "merged", "merged 1111111")
    pipe._apply_pipeline_sync({"result": {**first, "events": [older]}, "forced": {}})
    assert len(_feed("pipeline-merge")) == 2


def test_the_first_sync_is_told_apart_from_the_last_one_before_launch(pipe, monkeypatch):
    """A relaunch logs no merge the last launch saw: ``last.json`` is read before the
    first sync replaces it."""
    merged = _event("2026-11-20T10:00:00Z", PR, "merged", "merged abc1234")
    before = {**_result(), "events": [merged]}
    read = []
    monkeypatch.setattr(pipeline, "last", lambda: read.append(1) or before)
    monkeypatch.setattr(pipeline, "tick", lambda settings: dict(before))
    pipe._apply_pipeline_sync(pipe._pipeline_sync_once())
    pipe._apply_pipeline_sync(pipe._pipeline_sync_once())
    assert read == [1]
    assert _feed("pipeline-merge") == []


def test_a_sync_asked_for_while_one_runs_follows_it(pipe, monkeypatch):
    import threading

    entered, gate = threading.Event(), threading.Event()
    handed = []

    def tick(settings):
        handed.append(settings["force"]["rate"])
        if len(handed) == 1:
            entered.set()
            gate.wait(10)
        return _result()

    monkeypatch.setattr(pipeline, "tick", tick)
    pipe.run_pipeline_sync_async()
    assert entered.wait(10)
    pipe.pipeline_force_now("rate", ISSUE)
    gate.set()
    assert pipe.wait_for_background() == []
    assert handed == [[], [ISSUE]]
    assert not pipe.pipeline_syncing


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
    assert _start(pipe, item) == "Its fix is already queued"


def test_start_fix_says_why_it_queued_nothing(pipe, monkeypatch):
    linear = _item(LINEAR, source="linear", label="ENG-12")
    pipe.pipeline_result = _result(items=(_item(), linear))
    pipe.pipeline_enabled = False
    assert pipe.pipeline_start_fix(_item()) == "The pipeline is off"
    pipe.pipeline_enabled = True
    assert pipe.pipeline_start_fix(_item(writable=False)) == "It is assigned to someone else"
    assert pipe.pipeline_start_fix(linear) == ("Diplomat has this Linear issue's text only "
                                               "while Open fix PRs is on")
    assert pipe.pipeline_start_fix(_item("https://github.com/x/y/issues/12", repo="x/y")) == (
        "x/y is no GitHub repo root here, so there is nowhere to fix it")
    row = autofix.RunningAgent(pr_number=0, label="Auto · Issues · #12 · quick",
                               kind="issues", tracked=True)
    monkeypatch.setattr(Store, "running_tasks", property(lambda self: [row]))
    assert pipe.pipeline_start_fix(_item()) == "An agent is already fixing it"
    assert pipe.queued_tasks == []
    assert _feed("pipeline-fix") == []


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
    # 65; 2 roots of 10 gh calls; Linear; the lookups and the margin.
    assert pipeline.tick_timeout({
        "roots": [{}, {}], "linearTeams": [{}],
        "force": {"rate": ["a", "b"], "fracture": ["c"]}}) == 8 * 1345 + 1300 + 300 + 40
    assert pipeline.tick_timeout({}) == 5 * 1345 + 650 + 40


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


def test_a_malformed_result_keeps_only_what_it_should_hold(tmp_path, monkeypatch):
    _fake_core(tmp_path, monkeypatch, json.dumps({
        "at": "x", "items": [{"id": "a"}, 3], "graph": {"nodes": "no", "edges": [None]},
        "effects": [{"kind": "review"}, "x"], "notices": ["one", 2]}))
    assert pipeline.tick({}) == {
        "at": "x", "items": [{"id": "a"}], "graph": {"nodes": [], "edges": []},
        "effects": [{"kind": "review"}], "events": [], "notices": ["one"]}
