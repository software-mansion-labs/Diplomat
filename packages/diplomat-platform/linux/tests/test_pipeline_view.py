"""The Pipeline screen and its ⊶ header button, built offscreen.

``Store.pipeline_result`` is the core's ``PipelineTickResult`` as ``pipeline.tick`` and
``pipeline.last`` hand it over, so here it is a literal: what is pinned is how the
screen draws one, not how a sync makes it.
"""

from __future__ import annotations

import os
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

import pytest
from test_autofix import fake_probes

from diplomat_app import pipelineview
from diplomat_app.pipelineview import EventRow, PipelineView, two_lines
from diplomat_app.store import Store
from diplomat_runtime import autofix, comms
from diplomat_runtime.models import Fmt

pytest.importorskip("PySide6")

from PySide6.QtCore import QPoint, QPointF, QRectF, Qt  # noqa: E402
from PySide6.QtGui import QColor, QFont, QImage, QPalette  # noqa: E402
from PySide6.QtWidgets import QLabel  # noqa: E402

_LINUX_DIR = Path(__file__).resolve().parents[1]
_PIPELINE_SWIFT = (Path(__file__).resolve().parents[3] / "diplomat-core" / "Sources"
                   / "DiplomatCore" / "Pipeline.swift")

H = "https://github.com/o/r"


def _url(n: int, kind: str = "issue") -> str:
    return f"{H}/{'pull' if kind == 'pr' else 'issues'}/{n}"


I1, P2, P3, I4, I5, I6, I7, I8, P9 = (_url(1), _url(2, "pr"), _url(3, "pr"), _url(4), _url(5),
                                      _url(6), _url(7), _url(8), _url(9, "pr"))
LOW = {"risk": "low", "complexity": "low"}


def _item(n: int, *, kind: str = "issue", stage: str, lane: str, writable: bool = True,
          **extra) -> dict:
    return {"id": _url(n, kind), "source": "github", "kind": kind, "label": f"#{n}",
            "title": f"Item {n}", "repo": "o/r", "state": "open", "assignees": [],
            "writable": writable, "stage": stage, "lane": lane, **extra}


def _result() -> dict:
    """Four groups: an issue with a PR fixing it, a PR stacked on that one and fixing
    the issue too; a fractured parent with two children; an issue someone else holds;
    a closed issue and the merged PR that closed it."""
    items = [
        _item(1, stage="fixing", lane="fast", rating=LOW, ratedBy="label"),
        _item(2, kind="pr", stage="fast-track", lane="fast", rating=LOW, ratedBy="label",
              why="One timeout around one call.", floor={"risk": "low", "complexity": "medium"},
              hold="CI is pending on abc1234", headSha="abc1234def", cleanAt="0ff1ce0000",
              author="me"),
        _item(3, kind="pr", stage="clean", lane="fast", rating=LOW),
        _item(4, stage="fractured", lane="fractured",
              rating={"risk": "medium", "complexity": "high"}),
        _item(5, stage="candidate", lane="fast", rating=LOW),
        _item(6, stage="unrated", lane="unrated"),
        _item(7, stage="human", lane="human", writable=False, author="carol",
              assignees=["bob", "dave"], rating={"risk": "high", "complexity": "low"},
              ratedBy="local"),
        _item(8, stage="closed", lane="done", state="closed"),
        _item(9, kind="pr", stage="merged", lane="done", state="merged"),
    ]
    nodes = [(I1, 0, 0), (P2, 1, 0), (P3, 2, 0), (I4, 0, 1), (I5, 1, 1), (I6, 1, 2),
             (I7, 0, 3), (I8, 0, 4), (P9, 1, 4)]
    edges = [(I1, P2, "fixes"), (P2, P3, "stacked"), (I1, P3, "fixes"), (I4, I5, "child"),
             (I4, I6, "child"), (I8, P9, "fixes")]
    events = [("2026-11-20T10:00:00Z", P2, "rated", "low risk, low complexity"),
              ("2026-11-20T10:01:00Z", I1, "labelled", "risk:low, complexity:low"),
              ("2026-11-20T10:02:00Z", P2, "fast-track", "labelled diplomat:fast-track"),
              ("2026-11-20T10:05:00Z", P2, "held", "CI is pending on abc1234")]
    return {"at": "2026-11-20T10:06:00Z", "items": items,
            "graph": {"nodes": [{"id": i, "column": c, "row": r} for i, c, r in nodes],
                      "edges": [{"from": a, "to": b, "kind": k} for a, b, k in edges]},
            "effects": [],
            "events": [{"at": t, "item": i, "kind": k, "detail": d} for t, i, k, d in events],
            "notices": []}


def _rect(column: int, row: int) -> QRectF:
    """170x88 cards, 48 between columns and 16 between rows, inside 28/12 margins."""
    return QRectF(28 + column * 218, 12 + row * 104, 170, 88)


@pytest.fixture
def app():
    from PySide6.QtWidgets import QApplication

    return QApplication.instance() or QApplication([])


@pytest.fixture
def store(app, monkeypatch):
    monkeypatch.setattr(Store, "refresh_allocator_install_async", lambda self: None)
    monkeypatch.setattr(Store, "refresh_update_status_async", lambda self: None)
    fake_probes(monkeypatch)
    st = Store()
    st.me = "me"
    st.pipeline_enabled = True
    st.pipeline_result = _result()
    return st


def _fixing(monkeypatch, n: int) -> None:
    """An agent fixing issue ``n``."""
    row = autofix.RunningAgent(pr_number=0, label=f"Auto · Issues · #{n} · quick",
                               kind="issues", tracked=True, item=f"o/r#{n}")
    monkeypatch.setattr(Store, "running_tasks", property(lambda self: [row]))


def _labels(widget) -> list[str]:
    return [label.text() for label in widget.findChildren(QLabel) if label.parent() is not None]


# MARK: the graph


def test_one_card_per_node_at_its_column_and_row(store):
    view = PipelineView(store)
    assert view.canvas.cards == {I1: _rect(0, 0), P2: _rect(1, 0), P3: _rect(2, 0),
                                 I4: _rect(0, 1), I5: _rect(1, 1), I6: _rect(1, 2),
                                 I7: _rect(0, 3), I8: _rect(0, 4), P9: _rect(1, 4)}
    # Three columns and five rows, so the scroll area scrolls the whole graph.
    assert (view.canvas.minimumWidth(), view.canvas.minimumHeight()) == (
        2 * 28 + 3 * 170 + 2 * 48, 2 * 12 + 5 * 88 + 4 * 16)


def test_each_edge_is_one_connector_from_a_right_side_to_a_left_side(store):
    view = PipelineView(store)
    cards = view.canvas.cards
    drawn = {(c.source, c.target): c for c in view.canvas.connectors}
    assert set(drawn) == {(I1, P2), (P2, P3), (I1, P3), (I4, I5), (I4, I6), (I8, P9)}
    assert {k: c.style for k, c in drawn.items()} == {
        (I1, P2): Qt.PenStyle.SolidLine, (I1, P3): Qt.PenStyle.SolidLine,
        (I8, P9): Qt.PenStyle.SolidLine, (P2, P3): Qt.PenStyle.DotLine,
        (I4, I5): Qt.PenStyle.DashLine, (I4, I6): Qt.PenStyle.DashLine}
    for (a, b), c in drawn.items():
        assert c.start.x() == cards[a].right()
        assert cards[a].top() < c.start.y() < cards[a].bottom()
        assert c.tip.x() == cards[b].left()
        assert cards[b].top() < c.tip.y() < cards[b].bottom()
        # The arrowhead's tip touches the card; the line meets the arrowhead's base.
        assert c.arrow[0] == c.tip
        end, start = c.path.pointAtPercent(1.0), c.path.pointAtPercent(0.0)
        assert (end.x(), end.y()) == pytest.approx((cards[b].left() - 7, c.tip.y()))
        assert (start.x(), start.y()) == pytest.approx((c.start.x(), c.start.y()))


def test_connectors_sharing_a_side_take_their_own_places_on_it(store):
    """#1 leaves to #2 beside it and to #3 two columns on, which runs along the gap under
    its row: #2 takes the upper place on #1's side, #3 the lower. #3 is reached from #2
    beside it and from that gap below: #2's comes in above."""
    view = PipelineView(store)
    drawn = {(c.source, c.target): c for c in view.canvas.connectors}
    upper, lower, middle = 12 + 88 / 3, 12 + 88 * 2 / 3, 12 + 44
    assert drawn[(I1, P2)].start.y() == pytest.approx(upper)
    assert drawn[(I1, P3)].start.y() == pytest.approx(lower)
    assert drawn[(P2, P3)].tip.y() == pytest.approx(upper)
    assert drawn[(I1, P3)].tip.y() == pytest.approx(lower)
    assert drawn[(P2, P3)].start.y() == pytest.approx(middle)
    assert drawn[(I1, P2)].tip.y() == pytest.approx(middle)


def _crossings(canvas) -> list[tuple[str, str, str]]:
    """(source, target, card) for every connector passing through a card's inside."""
    hits = []
    for c in canvas.connectors:
        points = [c.path.pointAtPercent(i / 400) for i in range(401)]
        for card, rect in canvas.cards.items():
            inside = rect.adjusted(1, 1, -1, -1)
            if any(inside.contains(p) for p in points):
                hits.append((c.source, c.target, card))
    return hits


def test_no_connector_crosses_a_card(store):
    view = PipelineView(store)
    assert len(view.canvas.connectors) == 6
    assert _crossings(view.canvas) == []


def test_a_connector_into_its_own_or_an_earlier_column_goes_round_the_cards(store):
    """A cycle is the one way the layout puts a target in its source's column or before
    it: such a connector still leaves a right side and arrives at a left one, around
    every card."""
    x, y, z = _url(10), _url(11, "pr"), _url(12, "pr")
    store.pipeline_result = {
        "at": "2026-11-20T10:00:00Z", "effects": [], "events": [], "notices": [],
        "items": [_item(10, stage="fixing", lane="fast"),
                  _item(11, kind="pr", stage="human", lane="human"),
                  _item(12, kind="pr", stage="human", lane="human")],
        "graph": {"nodes": [{"id": x, "column": 0, "row": 0}, {"id": y, "column": 1, "row": 0},
                            {"id": z, "column": 1, "row": 1}],
                  "edges": [{"from": x, "to": y, "kind": "fixes"},
                            {"from": y, "to": z, "kind": "stacked"},
                            {"from": z, "to": x, "kind": "stacked"}]}}
    view = PipelineView(store)
    cards = view.canvas.cards
    drawn = {(c.source, c.target): c for c in view.canvas.connectors}
    for (a, b) in ((y, z), (z, x)):
        assert drawn[(a, b)].start.x() == cards[a].right()
        assert drawn[(a, b)].tip.x() == cards[b].left()
    assert _crossings(view.canvas) == []
    # Back into column 0 it bends in the margin left of it, inside the canvas.
    lefts = [drawn[(z, x)].path.pointAtPercent(i / 100).x() for i in range(101)]
    assert min(lefts) == pytest.approx(28 - 24)


# MARK: lanes


def test_each_lane_chip_counts_its_items(store):
    view = PipelineView(store)
    assert [view.lane_chips[k].text() for k, _ in pipelineview.LANES] == [
        "All 9", "Fast 4", "Human 1", "Unrated 1", "Fractured 1", "Done 2"]
    assert view.lane_chips["all"].isChecked()


def test_a_lane_keeps_whole_groups_and_closes_up_their_rows(store):
    view = PipelineView(store)
    view.lane_chips["unrated"].click()
    # #6 is the only unrated item; its parent and its sibling stay beside it.
    assert view.canvas.cards == {I4: _rect(0, 0), I5: _rect(1, 0), I6: _rect(1, 1)}
    assert {(c.source, c.target) for c in view.canvas.connectors} == {(I4, I5), (I4, I6)}
    view.lane_chips["human"].click()
    assert view.canvas.cards == {I7: _rect(0, 0)}
    assert view.canvas.connectors == []
    view.lane_chips["done"].click()
    assert view.canvas.cards == {I8: _rect(0, 0), P9: _rect(1, 0)}
    view.lane_chips["fast"].click()
    assert view.canvas.cards == {I1: _rect(0, 0), P2: _rect(1, 0), P3: _rect(2, 0),
                                 I4: _rect(0, 1), I5: _rect(1, 1), I6: _rect(1, 2)}
    assert [k for k, chip in view.lane_chips.items() if chip.isChecked()] == ["fast"]


def test_an_empty_lane_says_so(store):
    store.pipeline_result = {**_result(), "items": [i for i in _result()["items"]
                                                    if i["lane"] != "human"]}
    view = PipelineView(store)
    view.lane_chips["human"].click()
    assert view.canvas.cards == {}
    assert view.canvas.placeholder == "Nothing in this lane."


# MARK: cards


def test_done_cards_dim_and_a_card_diplomat_may_not_write_is_locked(store):
    view = PipelineView(store)
    faces = view.canvas.faces
    assert {i for i, f in faces.items() if f.dimmed} == {I8, P9}
    assert {i for i, f in faces.items() if f.locked} == {I7}
    assert (faces[P2].risk, faces[P2].complexity, faces[P2].stage, faces[P2].hold) == (
        "low", "low", "fast-track", "CI is pending on abc1234")
    assert (faces[I6].risk, faces[I6].complexity) == (None, None)
    assert (faces[P2].glyph, faces[I1].glyph) == ("⎇", "⊙")


def test_the_painted_cards_show_the_dimming_and_the_lock(store):
    view = PipelineView(store)
    canvas = view.canvas
    canvas.resize(canvas.minimumSize())
    image = canvas.grab().toImage()
    cards = canvas.cards

    def stripe(item: str) -> str:
        return image.pixelColor(int(cards[item].left()) + 1,
                                int(cards[item].center().y())).name(QColor.NameFormat.HexArgb)

    def lock(item: str) -> str:
        return image.pixelColor(int(cards[item].right()) - 13,
                                int(cards[item].top()) + 16).name(QColor.NameFormat.HexArgb)

    # #6 is unrated and #8 done: one grey stripe, and the done one painted faded.
    assert stripe(I6) == "#ff9aa0a6"
    assert stripe(I8) != stripe(I6)
    mid = canvas.palette().color(QPalette.ColorRole.Mid).name(QColor.NameFormat.HexArgb)
    assert lock(I7) == mid
    assert lock(I6) != mid


def test_badges_follow_the_queue(store, monkeypatch):
    view = PipelineView(store)
    assert {i: f.badge for i, f in view.canvas.faces.items() if f.badge} == {}
    _fixing(monkeypatch, 5)
    store.queued_tasks = [autofix.QueuedTask(
        autofix.queue_key(autofix.QUEUE_REVIEW_ACTION, "o/r#2"),
        autofix.AgentJob(kind="review", audit_action="review", label="Review · #2",
                         prompt=""), 1)]
    store.tasks_changed.emit()
    assert {i: f.badge for i, f in view.canvas.faces.items() if f.badge} == {
        I5: "agent", P2: "queued"}


def test_a_badge_leaves_the_source_glyph_as_it_is_without_one(store, monkeypatch):
    _fixing(monkeypatch, 5)
    view = PipelineView(store)
    canvas = view.canvas
    canvas.resize(canvas.minimumSize())
    image = canvas.grab().toImage()

    def glyph(item: str):
        rect = canvas.cards[item]
        return image.copy(int(rect.left()) + 10, int(rect.top()) + 7, 14, 14)

    assert (canvas.faces[I5].badge, canvas.faces[I6].badge) == ("agent", None)
    assert glyph(I5) == glyph(I6)


def test_two_lines_cuts_the_second():
    font = QFont()
    font.setPixelSize(10)
    words = " ".join(f"word{n}" for n in range(40))
    first, second = two_lines(words, font, 150)
    assert words.startswith(first)
    assert second.endswith("…")
    assert two_lines("Short", font, 150) == ["Short"]
    # Qt counts an emoji as two units; the cut still falls between whole characters.
    emoji = "🙂 " * 40
    first, second = two_lines(emoji, font, 150)
    assert emoji.startswith(first) and set(first) <= {"🙂", " "}


# MARK: the detail


def _select(view, item_id: str) -> None:
    from PySide6.QtTest import QTest

    centre = view.canvas.cards[item_id].center().toPoint()
    QTest.mouseClick(view.canvas, Qt.MouseButton.LeftButton, Qt.KeyboardModifier.NoModifier,
                     centre)


def test_a_click_selects_the_card_and_its_detail_shows_its_traversal_newest_first(store):
    view = PipelineView(store)
    assert view.event_rows == []
    _select(view, P2)
    assert view.selected == P2
    assert view.canvas.selected == P2
    assert [(r.step["kind"], r.step["at"]) for r in view.event_rows] == [
        ("held", "2026-11-20T10:05:00Z"), ("fast-track", "2026-11-20T10:02:00Z"),
        ("rated", "2026-11-20T10:00:00Z")]
    texts = _labels(view.detail)
    for line in ("#2", "GitHub PR", "Item 2", "FAST-TRACK", "RISK LOW", "COMPLEXITY LOW",
                 "Read off its labels.", "“One timeout around one call.”",
                 "Its diff allows no less than risk low · complexity medium.",
                 "Held: CI is pending on abc1234",
                 "Writable: Diplomat may label it and act on it.", "By @me · unassigned",
                 "Head abc1234 · clean at 0ff1ce0", "TRAVERSAL", "3"):
        assert line in texts, line
    # A click beside every card clears the selection.
    from PySide6.QtTest import QTest

    QTest.mouseClick(view.canvas, Qt.MouseButton.LeftButton, Qt.KeyboardModifier.NoModifier,
                     QPoint(5, 5))
    assert view.selected is None
    assert view.event_rows == []


def test_someone_elses_item_says_who_holds_it(store):
    view = PipelineView(store)
    view.select(I7)
    texts = _labels(view.detail)
    assert "Read only: Diplomat shows it and writes nothing to it." in texts
    assert "By @carol · assigned to @bob, @dave" in texts
    assert "Diplomat's own, kept on this machine: it may not label this item." in texts
    assert "Nothing logged about it yet." in texts


@pytest.mark.parametrize("label, whole", [
    ("#1810", True),
    # A root's `owner/repo#N`: the pane does not scroll sideways.
    ("software-mansion/react-native-reanimated#6789", False),
])
def test_the_head_label_is_cut_only_past_the_detail_and_nothing_else_is(store, app, label,
                                                                        whole):
    result = _result()
    result["items"][1] = {**result["items"][1], "label": label}
    store.pipeline_result = result
    view = PipelineView(store)
    view.resize(1100, 700)
    view.show()
    try:
        view.select(P2)
        app.processEvents()
        port = view.detail_scroll.viewport().width()
        assert view.detail.minimumSizeHint().width() <= port
        assert view.detail.width() == port
        [head] = view.detail.findChildren(pipelineview._Head)
        assert head.text() == label and label in head.toolTip()
        drawn = head.fontMetrics().elidedText(label, Qt.TextElideMode.ElideRight, head.width())
        assert (drawn == label) is whole
        [kind] = [w for w in view.detail.findChildren(QLabel) if w.text() == "GitHub PR"]
        assert kind.mapTo(view.detail, kind.rect().topRight()).x() < port
    finally:
        view.close()


def test_selection_and_lane_survive_a_rebuild_and_an_opening_resets_them(store):
    view = PipelineView(store)
    view.lane_chips["fast"].click()
    view.select(P2)
    store.pipeline_result = _result()
    store.pipeline_changed.emit()
    store.tasks_changed.emit()
    assert (view.lane, view.selected, view.canvas.selected) == ("fast", P2, P2)
    assert len(view.event_rows) == 3
    view.open()
    assert (view.lane, view.selected) == ("all", None)
    assert view.lane_chips["all"].isChecked()
    assert len(view.canvas.cards) == 9


def test_a_selection_whose_item_is_gone_is_dropped(store):
    view = PipelineView(store)
    view.select(P2)
    store.pipeline_result = {**_result(), "items": [i for i in _result()["items"]
                                                    if i["id"] != P2]}
    store.pipeline_changed.emit()
    assert view.selected is None
    assert P2 not in view.canvas.cards


def test_titles_are_never_markup(store):
    hostile = "<b>bold</b> &amp; <a href='x'>link</a>"
    result = _result()
    result["items"][1] = {**result["items"][1], "title": hostile, "hold": hostile}
    store.pipeline_result = result
    view = PipelineView(store)
    view.select(P2)
    shown = [w for w in view.detail.findChildren(QLabel) if hostile in w.text()]
    assert [w.text() for w in shown] == [hostile, f"Held: {hostile}"]
    assert all(w.textFormat() == Qt.TextFormat.PlainText for w in shown)


# MARK: actions


def _recorder(store, monkeypatch) -> list:
    calls = []
    monkeypatch.setattr(store, "pipeline_force_now",
                        lambda kind, item_id: calls.append((kind, item_id)))
    monkeypatch.setattr(store, "pipeline_start_fix",
                        lambda item: calls.append(("fix", item["id"])))
    return calls


def test_each_action_asks_the_store_about_the_selected_item(store, monkeypatch):
    calls = _recorder(store, monkeypatch)
    opened = []
    monkeypatch.setattr(pipelineview.QDesktopServices, "openUrl",
                        lambda url: opened.append(url.toString()))
    view = PipelineView(store)
    view.select(I5)
    assert list(view.buttons) == ["open", "rate", "fracture", "fix"]
    assert all(b.isEnabled() for b in view.buttons.values())
    for key in ("rate", "fracture", "fix"):
        view.buttons[key].click()
    view.buttons["open"].click()
    assert calls == [("rate", I5), ("fracture", I5), ("fix", I5)]
    assert opened == [I5]


@pytest.mark.parametrize("item, shown", [
    # A fixing issue: a PR is on it, so it is neither split nor fixed again.
    (I1, ["open", "rate"]),
    (P2, ["open", "rate"]),
    # Not mine: a sync rates only my own PRs.
    (P3, ["open"]),
    (I4, ["open", "rate"]),
    # Unrated, writable, no child: it may be split.
    (I6, ["open", "rate", "fracture"]),
    # Someone else's: never split.
    (I7, ["open", "rate"]),
    # Done: nothing left to ask.
    (I8, ["open"]),
    (P9, ["open"]),
])
def test_actions_are_offered_where_they_can_act(store, item, shown):
    view = PipelineView(store)
    view.select(item)
    assert list(view.buttons) == shown


def test_my_pr_is_mine_whatever_the_case_of_my_login():
    mine = _item(2, kind="pr", stage="fast-track", lane="fast", author="Me")
    assert pipelineview.can_rate(mine, "me", rooted=False)
    assert not pipelineview.can_rate({**mine, "author": "carol"}, "me", rooted=False)


def test_a_linear_issue_is_rated_and_split_only_in_a_team_with_a_root(store, monkeypatch):
    from diplomat_runtime import review
    from diplomat_runtime.prref import LocalRepo

    linear = "https://linear.app/acme/issue/ENG-6"
    result = _result()
    result["items"].append({**result["items"][5], "id": linear, "source": "linear",
                            "label": "ENG-6", "repo": "ENG"})
    store.pipeline_result = result
    monkeypatch.setattr(review, "repo_roots", lambda: [LocalRepo("o", "r", "/src/r")])
    view = PipelineView(store)
    view.select(linear)
    assert list(view.buttons) == ["open"]
    store.pipeline_linear_teams_raw = "ENG=o/elsewhere"
    store.pipeline_changed.emit()
    assert list(view.buttons) == ["open"]
    store.pipeline_linear_teams_raw = "eng=O/R"
    store.pipeline_changed.emit()
    assert list(view.buttons) == ["open", "rate", "fracture"]


def test_an_issue_with_children_is_not_split_again(store):
    result = _result()
    result["items"][3] = {**result["items"][3], "stage": "human", "lane": "human"}
    store.pipeline_result = result
    view = PipelineView(store)
    view.select(I4)
    assert list(view.buttons) == ["open", "rate"]


def test_an_ask_waiting_for_its_sync_shows_asked(store, monkeypatch):
    monkeypatch.setattr(store, "run_pipeline_sync_async", lambda: None)
    view = PipelineView(store)
    view.select(I6)
    view.buttons["rate"].click()
    assert (view.buttons["rate"].text(), view.buttons["rate"].isEnabled()) == ("Rate asked", False)
    assert (view.buttons["fracture"].text(), view.buttons["fracture"].isEnabled()) == (
        "Fracture", True)
    view.buttons["fracture"].click()
    assert (view.buttons["fracture"].text(), view.buttons["fracture"].isEnabled()) == (
        "Fracture asked", False)


def test_start_fix_is_off_while_anything_is_on_it(store, monkeypatch):
    view = PipelineView(store)
    view.select(I5)
    fix = view.buttons["fix"]
    assert (fix.text(), fix.isEnabled(), fix.toolTip()) == (
        "Start fix", True, "Queue its fix now, past its retry backoff")
    store.queued_tasks = [autofix.QueuedTask(
        autofix.queue_key(autofix.QUEUE_ISSUES_ACTION, "o/r#5"),
        autofix.AgentJob(kind="issues", audit_action="issues", label="Issues · #5",
                         prompt=""), 1)]
    store.tasks_changed.emit()
    assert not view.buttons["fix"].isEnabled()
    store.queued_tasks = []
    _fixing(monkeypatch, 5)
    store.tasks_changed.emit()
    assert not view.buttons["fix"].isEnabled()


def test_start_fix_is_for_a_writable_candidate_whose_fix_is_known(store):
    linear = "https://linear.app/acme/issue/ENG-5/a-thing"
    result = _result()
    result["items"][4] = {**result["items"][4], "writable": False}
    result["items"].append({**result["items"][4], "id": linear, "source": "linear",
                            "label": "ENG-5", "writable": True})
    store.pipeline_result = result
    view = PipelineView(store)
    view.select(I5)
    assert list(view.buttons) == ["open", "rate"]
    view.select(linear)
    fix = view.buttons["fix"]
    assert (fix.isEnabled(), fix.toolTip()) == (
        False, "Diplomat has this Linear issue's text only while Open fix PRs is on")
    # Held, the hold is why.
    store.pipeline_result["items"][-1]["hold"] = "Linear team ENG has no root to fix it in"
    store.pipeline_changed.emit()
    assert view.buttons["fix"].toolTip() == "Linear team ENG has no root to fix it in"
    del store.pipeline_result["items"][-1]["hold"]
    store.pipeline_result = {**result, "effects": [{
        "kind": "fixLinear", "repo": "o/r", "identifier": "ENG-5", "url": linear,
        "text": "t", "key": f"pipeline-fix:{linear}", "stamp": "fix"}]}
    store.pipeline_changed.emit()
    assert view.buttons["fix"].isEnabled()


def test_start_fix_is_off_for_a_held_issue_the_hold_saying_why(store):
    """A part split off a banned author's issue, though the operator filed it."""
    held = "split from an issue of @mallory, who is on the prompt-injection ban list"
    result = _result()
    result["items"][4] = {**result["items"][4], "hold": held, "splitFrom": "mallory"}
    store.pipeline_result = result
    view = PipelineView(store)
    view.select(I5)
    fix = view.buttons["fix"]
    assert (fix.isEnabled(), fix.toolTip()) == (False, held)


def test_why_start_fix_queued_nothing_shows_under_the_buttons(store, monkeypatch):
    answers = ["An agent is already fixing it", None]
    monkeypatch.setattr(store, "pipeline_start_fix", lambda item: answers.pop(0))
    view = PipelineView(store)
    view.select(I5)
    assert view.fix_answer is None
    view.buttons["fix"].click()
    assert view.fix_answer.text() == "An agent is already fixing it"
    # Another item's answer is its own.
    view.select(I6)
    assert view.fix_answer is None
    view.select(I5)
    assert view.fix_answer.text() == "An agent is already fixing it"
    view.buttons["fix"].click()
    assert view.fix_answer is None


def test_off_the_asks_are_disabled_and_open_is_not(store):
    store.pipeline_enabled = False
    view = PipelineView(store)
    view.select(I5)
    assert {k: b.isEnabled() for k, b in view.buttons.items()} == {
        "open": True, "rate": False, "fracture": False, "fix": False}
    assert not view.sync_btn.isEnabled()
    assert view.status.text() == "Off - turn the Pipeline on in Settings."
    # The last result is still drawn.
    assert len(view.canvas.cards) == 9


# MARK: the status line and banners


def test_the_status_line_counts_and_says_when(store):
    """The clock today; the date with it on any other day, so an old result does not
    read as today's."""
    view = PipelineView(store)
    at = comms.parse_iso("2026-11-20T10:06:00Z").astimezone().strftime("%b %d %H:%M")
    assert view.status.text() == f"9 items · 4 fast · last sync {at}"
    now = datetime.now(timezone.utc).replace(microsecond=0)
    store.pipeline_result = {**_result(), "at": now.strftime("%Y-%m-%dT%H:%M:%SZ")}
    store.pipeline_changed.emit()
    assert view.status.text() == f"9 items · 4 fast · last sync {Fmt.clock(now)}"
    assert view.sync_btn.isEnabled()
    store.pipeline_syncing = True
    store.pipeline_changed.emit()
    assert view.status.text() == "9 items · 4 fast · syncing…"
    assert not view.sync_btn.isEnabled()
    store.pipeline_syncing = False
    store.pipeline_result = None
    store.pipeline_changed.emit()
    assert view.status.text() == "0 items · 0 fast · not synced yet"
    assert view.canvas.placeholder == "No sync has run yet."


def test_a_failed_sync_and_the_notices_are_banners(store):
    store.pipeline_error = "diplomat-core pipeline-tick failed: boom"
    store.pipeline_result = {**_result(), "notices": ["Linear: no key", "o/r: HTTP 502"]}
    view = PipelineView(store)
    assert not view.error_banner.isHidden()
    assert view.error_banner.text() == "⚠ diplomat-core pipeline-tick failed: boom"
    assert not view.notices_banner.isHidden()
    assert view.notices_banner.text() == "⚠ Linear: no key\n⚠ o/r: HTTP 502"
    store.pipeline_error = None
    store.pipeline_result = _result()
    store.pipeline_changed.emit()
    assert view.error_banner.isHidden()
    assert view.notices_banner.isHidden()


def test_the_sync_error_shows_only_while_the_pipeline_is_on(store):
    store.pipeline_error = "diplomat-core pipeline-tick failed: boom"
    store.pipeline_enabled = False
    view = PipelineView(store)
    assert view.error_banner.isHidden()
    store.pipeline_enabled = True
    store.pipeline_changed.emit()
    assert not view.error_banner.isHidden()


def _luminance(c: QColor) -> float:
    def lin(v: float) -> float:
        return v / 12.92 if v <= 0.03928 else ((v + 0.055) / 1.055) ** 2.4
    return 0.2126 * lin(c.redF()) + 0.7152 * lin(c.greenF()) + 0.0722 * lin(c.blueF())


@pytest.mark.parametrize("banner", ["error_banner", "notices_banner"])
def test_a_banners_text_is_readable_on_it(store, banner):
    """WCAG's 4.5:1 between the banner's ground and its darkest or lightest text."""
    store.pipeline_error = "diplomat-core pipeline-tick failed: boom"
    store.pipeline_result = {**_result(), "notices": ["Linear was not read: no API key"]}
    view = PipelineView(store)
    view.resize(900, 600)
    label = getattr(view, banner)
    # Over the window it sits on.
    image = QImage(label.size(), QImage.Format.Format_ARGB32)
    image.fill(label.palette().color(QPalette.ColorRole.Window))
    label.render(image)
    counts: dict[int, int] = {}
    for y in range(image.height()):
        for x in range(image.width()):
            rgb = image.pixel(x, y)
            counts[rgb] = counts.get(rgb, 0) + 1
    ground = QColor(max(counts, key=counts.get))
    lg = _luminance(ground)
    best = max(counts, key=lambda rgb: abs(_luminance(QColor(rgb)) - lg))
    lt = _luminance(QColor(best))
    ratio = (max(lg, lt) + 0.05) / (min(lg, lt) + 0.05)
    assert ratio >= 4.5, (ground.name(), QColor(best).name(), ratio)


def test_sync_now_runs_a_sync(store, monkeypatch):
    runs = []
    monkeypatch.setattr(store, "run_pipeline_sync_async", lambda: runs.append(1))
    view = PipelineView(store)
    view.sync_btn.click()
    assert runs == [1]


def test_sync_now_leaves_nothing_to_call_after_the_sync(store, monkeypatch):
    """``clicked`` hands its ``checked`` to a slot's first optional positional
    parameter, which ``then`` must not be."""
    monkeypatch.setattr(Store, "_pipeline_sync_once", lambda self: {"error": "x", "forced": {}})
    view = PipelineView(store)
    view.sync_btn.click()
    assert store._pipeline_then == []
    assert store.wait_for_background() == []


# MARK: the panel


def _row_of(layout, widget):
    """The layout under ``layout`` that holds ``widget`` itself."""
    for i in range(layout.count()):
        item = layout.itemAt(i)
        if item.widget() is widget:
            return layout
        found = item.layout() and _row_of(item.layout(), widget)
        if found:
            return found
    return None


def test_the_header_button_sits_between_comms_and_telemetry_and_opens_the_screen(store):
    from diplomat_app.panel import Panel

    panel = Panel(store)
    try:
        row = _row_of(panel.layout(), panel.pipeline_btn)
        header = [row.itemAt(i).widget() for i in range(row.count())]
        at = header.index(panel.pipeline_btn)
        assert header[at - 1:at + 2] == [panel.comms_btn, panel.pipeline_btn,
                                         panel.telemetry_btn]
        assert (panel.pipeline_btn.text(), panel.pipeline_btn.toolTip()) == ("⊶", "Pipeline")
        panel.pipeline_view.select(P2)
        panel.pipeline_btn.click()
        assert panel._screen == "pipeline"
        # The screen is the page itself: its graph scrolls both ways inside it.
        assert panel.body.currentWidget() is panel.pipeline_view
        assert panel.pipeline_view.selected is None
        panel.pipeline_view.done.emit()
        assert panel._screen == "main"
        panel.pipeline_btn.click()
        panel.pipeline_btn.click()
        assert panel._screen == "main"
    finally:
        panel.deleteLater()


# MARK: the render fixture


def _swift_cases(enum: str) -> set[str]:
    """The raw values of a ``String`` enum in Pipeline.swift."""
    text = _PIPELINE_SWIFT.read_text()
    body = text[text.index(f"enum {enum}"):]
    body = body[:body.index("}")]
    values = set()
    for line in re.findall(r"^\s*case (.+)$", body, re.M):
        for case in line.split(","):
            name, _, raw = case.partition("=")
            values.add(raw.strip().strip('"') if raw else name.strip())
    return values


def test_the_render_fixture_covers_every_stage_lane_edge_and_event_kind():
    from diplomat_app.render import pipeline_fixture_result

    result = pipeline_fixture_result("o/r", datetime(2026, 11, 20, 10, tzinfo=timezone.utc))
    items = result["items"]
    assert {i["stage"] for i in items} == _swift_cases("PipelineStage") == set(
        pipelineview.STAGE_TINT)
    assert {i["lane"] for i in items} == _swift_cases("PipelineLane")
    assert {e["kind"] for e in result["graph"]["edges"]} == _swift_cases("EdgeKind") == set(
        pipelineview.EDGE_STYLE)
    assert {e["kind"] for e in result["events"]} == _swift_cases("Kind") == set(
        pipelineview.EVENT_TINT)
    assert {i["source"] for i in items} == {"github", "linear"}
    assert {i["writable"] for i in items} == {True, False}
    assert any(i.get("why") and i.get("floor") for i in items)
    assert any(i.get("hold") for i in items) and result["notices"]
    ids = [i["id"] for i in items]
    assert sorted(n["id"] for n in result["graph"]["nodes"]) == sorted(ids)
    assert {e["item"] for e in result["events"]} <= set(ids)
    # Newest last, as the core hands them over.
    assert [e["at"] for e in result["events"]] == sorted(e["at"] for e in result["events"])


@pytest.mark.skipif(not os.environ.get("DIPLOMAT_CORE_BIN"), reason="DIPLOMAT_CORE_BIN not set")
def test_the_render_mode_draws_through_the_entry_point(tmp_path):
    """Its fixture goes through the real ``diplomat-core pipeline-last``."""
    home = tmp_path / "home"
    home.mkdir()
    out = tmp_path / "pipeline.png"
    env = {k: v for k, v in os.environ.items()
           if k not in ("DIPLOMAT_PIPELINE_DIR", "DIPLOMAT_CONFIG")}
    env.update(HOME=str(home), XDG_CONFIG_HOME=str(home / ".config"),
               QT_QPA_PLATFORM="offscreen", DIPLOMAT_SELF_REPO="/nonexistent",
               DIPLOMAT_RENDER="pipeline", DIPLOMAT_RENDER_OUT=str(out),
               PYTHONPATH=os.pathsep.join([str(_LINUX_DIR),
                                           str(_LINUX_DIR.parents[1] / "diplomat-runtime")]))
    done = subprocess.run([sys.executable, "-m", "diplomat_app"], cwd=str(_LINUX_DIR),
                          env=env, capture_output=True, text=True, timeout=180)
    assert done.returncode == 0, done.stderr
    assert out.stat().st_size > 10_000
    # Nothing the fixture wrote reached the private HOME's real Pipeline dir.
    assert not (home / ".diplomat" / "pipeline").exists()
