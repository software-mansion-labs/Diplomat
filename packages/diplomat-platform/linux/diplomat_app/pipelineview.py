"""The Pipeline screen: ``Store.pipeline_result`` of the root the header picked as a graph of
cards, and the selected card's detail. The layout, stages and lanes are the core's, drawn as
they come. The macOS twin is ``PipelineView.swift``.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import datetime

from PySide6.QtCore import QEvent, QPointF, QRectF, QSize, Qt, QUrl, Signal
from PySide6.QtGui import (
    QColor,
    QDesktopServices,
    QFont,
    QFontMetricsF,
    QPainter,
    QPainterPath,
    QPalette,
    QPen,
    QPolygonF,
    QTextLayout,
    QTextOption,
)
from PySide6.QtWidgets import (
    QApplication,
    QButtonGroup,
    QFrame,
    QHBoxLayout,
    QLabel,
    QPushButton,
    QScrollArea,
    QSizePolicy,
    QToolTip,
    QVBoxLayout,
    QWidget,
)

from diplomat_runtime import comms, pipeline, review
from diplomat_runtime.models import Fmt
from diplomat_runtime.prref import root_label
from . import glyphs
from .store import Store
from .widgets import ElidedLabel, GlyphLabel, ToggleChip, _draw_glyph, muted, plain_tooltip, tint_bg

#: assets/pipeline.json → labels.color.
TINT = "#5856D6"
_RED, _GREEN, _ORANGE, _BLUE, _PURPLE, _TEAL = (
    "#FF3B30", "#34C759", "#FF9500", "#0A84FF", "#AF52DE", "#30B0C7")
_GREY = glyphs.MUTED

#: `PipelineLevel`'s raw values.
LEVEL_TINT = {"low": _GREEN, "medium": _ORANGE, "high": _RED}
LEVEL_SHORT = {"low": "LOW", "medium": "MED", "high": "HIGH"}

#: `PipelineStage`'s raw values.
STAGE_TINT = {"unrated": _GREY, "human": _ORANGE, "candidate": TINT, "fractured": _TEAL,
              "fixing": _BLUE, "fast-track": TINT, "clean": TINT, "cleared": _GREEN,
              "merged": _PURPLE, "closed": _GREY}

#: The filter chips in order: "all", then `PipelineLane`'s raw values.
LANES = (("all", "All"), ("fast", "Fast"), ("human", "Human"), ("unrated", "Unrated"),
         ("fractured", "Fractured"), ("done", "Done"))
LANE_TINT = {"fast": TINT, "human": _ORANGE, "unrated": _GREY, "fractured": _TEAL,
             "done": _GREY}

#: `PipelineGraph.EdgeKind`'s raw values, in the edge key's order.
EDGE_STYLE = {"fixes": Qt.PenStyle.SolidLine, "child": Qt.PenStyle.DashLine,
              "stacked": Qt.PenStyle.DotLine}

#: `PipelineEvent.Kind`'s raw values.
EVENT_TINT = {"rated": _GREY, "labelled": _GREY, "fast-track": TINT, "clean": TINT,
              "rerated": _GREY, "cleared": _GREEN, "merged": _PURPLE, "held": _ORANGE,
              "fractured": _TEAL, "child": _TEAL, "asked": _BLUE, "takeover": TINT,
              "error": _RED}

#: A connector bends halfway across a column gap; MARGIN_X gives the outer columns that
#: room too.
CARD_W, CARD_H, RADIUS = 170, 88, 5
COL_GAP, ROW_GAP = 48, 16
MARGIN_X, MARGIN_Y = 28, 12
ARROW = 7
DETAIL_W = 290


def _plain(text: str) -> QLabel:
    """Never markup: titles, names and holds come from GitHub, Linear and the rater."""
    label = QLabel(text)
    label.setTextFormat(Qt.TextFormat.PlainText)
    return label


class _Wrapped(QLabel):
    """:func:`_plain`, wrapped, and broken inside a word wider than the line, as SwiftUI's
    ``Text`` is: QLabel's own word wrap widens the label to that word."""

    def __init__(self, text: str) -> None:
        super().__init__(text)
        self.setTextFormat(Qt.TextFormat.PlainText)
        self.setWordWrap(True)

    def _layout(self, width: float) -> tuple[QTextLayout, float]:
        layout = QTextLayout(self.text(), self.font())
        option = QTextOption()
        option.setWrapMode(QTextOption.WrapMode.WrapAtWordBoundaryOrAnywhere)
        layout.setTextOption(option)
        layout.beginLayout()
        height = 0.0
        while (line := layout.createLine()).isValid():
            line.setLineWidth(width)
            line.setPosition(QPointF(0, height))
            height += line.height()
        layout.endLayout()
        return layout, height

    def heightForWidth(self, width: int) -> int:  # noqa: N802
        m = self.contentsMargins()
        return math.ceil(self._layout(width - m.left() - m.right())[1]) + m.top() + m.bottom()

    def minimumSizeHint(self) -> QSize:  # noqa: N802
        return QSize(0, super().minimumSizeHint().height())

    def paintEvent(self, event) -> None:  # noqa: N802
        p = QPainter(self)
        p.setPen(self.palette().color(self.foregroundRole()))
        box = self.contentsRect()
        self._layout(box.width())[0].draw(p, QPointF(box.topLeft()))
        p.end()


def _chip(text: str, tint: str) -> QLabel:
    chip = _plain(text)
    chip.setStyleSheet(
        f"color: {tint}; background-color: {tint_bg(tint, 0.15)}; border-radius: 5px;"
        " padding: 1px 5px; font-size: 8px; font-weight: 700;"
    )
    return chip


def _small_button(text: str, on_click) -> QPushButton:
    btn = QPushButton(text)
    btn.setCursor(Qt.CursorShape.PointingHandCursor)
    btn.setStyleSheet("font-size: 9px; padding: 1px 6px;")
    btn.clicked.connect(lambda _=False: on_click())
    return btn


def _clear(layout) -> None:
    while layout.count():
        item = layout.takeAt(0)
        w = item.widget()
        if w is not None:
            w.setParent(None)
            w.deleteLater()
        elif item.layout() is not None:
            _clear(item.layout())


def open_url(url: str) -> None:
    QDesktopServices.openUrl(QUrl(url))


def _clock(iso: str | None) -> str:
    when = comms.parse_iso(iso or "")
    if when is None:
        return "—"
    today = when.astimezone().date() == datetime.now().astimezone().date()
    return Fmt.clock(when) if today else _when(iso)


def _when(iso: str | None) -> str:
    when = comms.parse_iso(iso or "")
    return when.astimezone().strftime("%b %d %H:%M") if when else "—"


def source_glyph(item: dict) -> str:
    if item.get("source") == "linear":
        return glyphs.G_LINEAR
    return glyphs.G_PULL if item.get("kind") == "pr" else glyphs.G_ISSUES


def _who(name: str, item: dict) -> str:
    return name if item.get("source") == "linear" else f"@{name}"


# MARK: the graph's geometry


def card_rect(column: int, row: int) -> QRectF:
    return QRectF(MARGIN_X + column * (CARD_W + COL_GAP), MARGIN_Y + row * (CARD_H + ROW_GAP),
                  CARD_W, CARD_H)


def _ends(edge: dict) -> tuple[str, str]:
    return str(edge.get("from") or ""), str(edge.get("to") or "")


def groups(nodes: list[dict], edges: list[dict]) -> dict[str, str]:
    """Each node id → a representative id of its connected component."""
    parent = {str(n.get("id")): str(n.get("id")) for n in nodes}

    def find(x: str) -> str:
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    for edge in edges:
        a, b = _ends(edge)
        if a in parent and b in parent:
            parent[find(a)] = find(b)
    return {n: find(n) for n in parent}


def shown_nodes(result: dict, lane: str) -> list[dict]:
    """The nodes ``lane`` keeps, emptied rows closed up: each whole group with an item in
    ``lane``, so a card keeps what it links to beside it."""
    items = {str(i.get("id")): i for i in result.get("items") or []}
    graph = result.get("graph") or {}
    nodes = [n for n in graph.get("nodes") or [] if str(n.get("id")) in items]
    if lane != "all":
        group = groups(nodes, graph.get("edges") or [])
        kept = {group[str(n["id"])] for n in nodes if items[str(n["id"])].get("lane") == lane}
        nodes = [n for n in nodes if group[str(n["id"])] in kept]
    rows = {r: i for i, r in enumerate(sorted({int(n.get("row") or 0) for n in nodes}))}
    return [{**n, "row": rows[int(n.get("row") or 0)]} for n in nodes]


def in_root(result: dict, root: str, roots: set[str], teams: list[dict]) -> dict:
    """``result`` cut to what picking ``root`` (a ``LocalRepo.key``) shows: each group with a
    card in it, a Linear issue's being its team's repo, or with none in any of ``roots``,
    whole. Twin of ``PipelineView.inRoot``."""
    graph = result.get("graph") or {}
    nodes, edges = graph.get("nodes") or [], graph.get("edges") or []
    group = groups(nodes, edges)
    picked: set[str] = set()
    rooted: set[str] = set()
    for item in result.get("items") or []:
        at = str(item.get("repo") or "").lower()
        if item.get("source") == "linear":
            at = next((t["repo"].lower() for t in teams if t["key"].lower() == at), "")
        item_id = str(item.get("id"))
        if at == root:
            picked.add(group.get(item_id, item_id))
        if at in roots:
            rooted.add(group.get(item_id, item_id))

    def shown(item_id: str) -> bool:
        return group.get(item_id, item_id) in picked or group.get(item_id, item_id) not in rooted

    return {**result,
            "items": [i for i in result.get("items") or [] if shown(str(i.get("id")))],
            "graph": {**graph, "nodes": [n for n in nodes if shown(str(n.get("id")))],
                      "edges": [e for e in edges if all(map(shown, _ends(e)))]}}


def lane_counts(items: list[dict]) -> dict[str, int]:
    counts = {lane: 0 for lane, _ in LANES}
    for item in items:
        if item.get("lane") in counts:
            counts[item["lane"]] += 1
    counts["all"] = len(items)
    return counts


@dataclass(frozen=True)
class Connector:
    """``start`` is on the source card's right side; ``tip``, the arrowhead's point, on the
    target's left."""

    source: str
    target: str
    kind: str
    start: QPointF
    tip: QPointF
    path: QPainterPath
    arrow: QPolygonF

    @property
    def style(self) -> Qt.PenStyle:
        return EDGE_STYLE.get(self.kind, Qt.PenStyle.SolidLine)


def _toward(at: QPointF, other: QPointF, radius: float) -> QPointF:
    dx, dy = other.x() - at.x(), other.y() - at.y()
    length = math.hypot(dx, dy)
    if not length:
        return at
    t = min(radius, length / 2) / length
    return QPointF(at.x() + dx * t, at.y() + dy * t)


def _rounded(points: list[QPointF], radius: float = 6.0) -> QPainterPath:
    path = QPainterPath(points[0])
    for before, at, after in zip(points, points[1:], points[2:]):
        path.lineTo(_toward(at, before, radius))
        path.quadTo(at, _toward(at, after, radius))
    path.lineTo(points[-1])
    return path


def _adjacent(src: QRectF, dst: QRectF) -> bool:
    """Whether ``dst`` is in the next column."""
    return abs(dst.left() - src.right() - COL_GAP) < 0.5


def _gap(src: QRectF, dst: QRectF) -> float:
    """The row gap a connector not into the next column runs along."""
    return src.top() - ROW_GAP / 2 if dst.top() < src.top() else src.bottom() + ROW_GAP / 2


def _path(src: QRectF, dst: QRectF, y0: float, y1: float) -> QPainterPath:
    """Up to the arrowhead's base. Beyond the next column, or backward, it runs through the
    gutters and a row gap, which hold no card to cross."""
    start, end = QPointF(src.right(), y0), QPointF(dst.left() - ARROW, y1)
    if _adjacent(src, dst):
        mid = (start.x() + end.x()) / 2
        path = QPainterPath(start)
        path.cubicTo(QPointF(mid, y0), QPointF(mid, y1), end)
        return path
    gap = _gap(src, dst)
    out_x, in_x = src.right() + COL_GAP / 2, dst.left() - COL_GAP / 2
    return _rounded([start, QPointF(out_x, y0), QPointF(out_x, gap), QPointF(in_x, gap),
                     QPointF(in_x, y1), end])


def connectors(cards: dict[str, QRectF], edges: list[dict]) -> list[Connector]:
    """A connector per edge between two drawn cards. Those sharing a card's side are
    spread along it in the order they head off or come in from, so neither their lines nor
    their arrowheads land on each other."""
    shown = [e for e in edges
             if (ends := _ends(e))[0] in cards and ends[1] in cards and ends[0] != ends[1]]
    outs: dict[str, list[dict]] = {}
    ins: dict[str, list[dict]] = {}
    for e in shown:
        a, b = _ends(e)
        outs.setdefault(a, []).append(e)
        ins.setdefault(b, []).append(e)

    def toward(e: dict, end: int) -> tuple[float, float]:
        src, dst = cards[_ends(e)[0]], cards[_ends(e)[1]]
        other = (src, dst)[end]
        return (other.center().y() if _adjacent(src, dst) else _gap(src, dst), other.left())

    def slots(by_card: dict[str, list[dict]], end: int) -> dict[int, tuple[int, int]]:
        out: dict[int, tuple[int, int]] = {}
        for es in by_card.values():
            es.sort(key=lambda e: toward(e, end))
            out.update({id(e): (i, len(es)) for i, e in enumerate(es)})
        return out

    out_slot, in_slot = slots(outs, 1), slots(ins, 0)

    def port(rect: QRectF, slot: tuple[int, int]) -> float:
        return rect.top() + rect.height() * (slot[0] + 1) / (slot[1] + 1)

    drawn = []
    for e in shown:
        a, b = _ends(e)
        src, dst = cards[a], cards[b]
        y0, y1 = port(src, out_slot[id(e)]), port(dst, in_slot[id(e)])
        tip = QPointF(dst.left(), y1)
        arrow = QPolygonF([tip, QPointF(tip.x() - ARROW, y1 - ARROW / 2),
                           QPointF(tip.x() - ARROW, y1 + ARROW / 2)])
        drawn.append(Connector(a, b, str(e.get("kind") or ""), QPointF(src.right(), y0), tip,
                               _path(src, dst, y0, y1), arrow))
    return drawn


def two_lines(text: str, font: QFont, width: float) -> list[str]:
    """The first wrapped line of ``text``, then the rest elided onto a second."""
    layout = QTextLayout(text, font)
    option = QTextOption()
    option.setWrapMode(QTextOption.WrapMode.WrapAtWordBoundaryOrAnywhere)
    layout.setTextOption(option)
    layout.beginLayout()
    first = layout.createLine()
    if not first.isValid():
        layout.endLayout()
        return []
    first.setLineWidth(width)
    # QTextLayout counts UTF-16 units, not code points.
    cut = (first.textStart() + first.textLength()) * 2
    layout.endLayout()
    units = text.encode("utf-16-le")
    one = units[:cut].decode("utf-16-le", "ignore").rstrip()
    rest = units[cut:].decode("utf-16-le", "ignore").strip()
    if not rest:
        return [one]
    return [one, QFontMetricsF(font).elidedText(rest, Qt.TextElideMode.ElideRight, width)]


# MARK: the canvas


@dataclass(frozen=True)
class CardFace:
    glyph: str
    label: str
    title: str
    #: `PipelineLevel` raw values; None while unrated.
    risk: str | None
    complexity: str | None
    stage: str
    lane: str
    #: ``agent`` or ``queued`` (:meth:`Store.pipeline_badges`).
    badge: str | None
    locked: bool
    hold: str | None

    @property
    def dimmed(self) -> bool:
        return self.lane == "done"


def card_face(item: dict, badge: str | None) -> CardFace:
    rating = item.get("rating") or {}
    return CardFace(glyph=source_glyph(item), label=str(item.get("label") or ""),
                    title=" ".join(str(item.get("title") or "").split()),
                    risk=rating.get("risk"), complexity=rating.get("complexity"),
                    stage=str(item.get("stage") or ""), lane=str(item.get("lane") or ""),
                    badge=badge, locked=not item.get("writable"), hold=item.get("hold") or None)


def _chip_font(p: QPainter) -> QFont:
    font = QFont(p.font())
    font.setPixelSize(8)
    font.setBold(True)
    return font


def _paint_chip(p: QPainter, x: float, y: float, text: str, tint: str, *,
                right: bool = False, pad: float = 10.0) -> float:
    """Starts at ``x``, or ends there with ``right``. Returns its width."""
    font = _chip_font(p)
    width = QFontMetricsF(font).horizontalAdvance(text) + pad
    box = QRectF(x - width if right else x, y, width, 14)
    color = QColor(tint)
    fill = QColor(color)
    fill.setAlphaF(0.16)
    p.setPen(Qt.PenStyle.NoPen)
    p.setBrush(fill)
    p.drawRoundedRect(box, 4, 4)
    p.setFont(font)
    p.setPen(color)
    p.drawText(box, int(Qt.AlignmentFlag.AlignCenter), text)
    return width


def _paint_lock(p: QPainter, box: QRectF, color: QColor) -> None:
    """Drawn, not a glyph: the text padlocks are all colour emoji."""
    body = QRectF(box.left(), box.top() + box.height() * 0.45, box.width(),
                  box.height() * 0.55)
    p.setPen(Qt.PenStyle.NoPen)
    p.setBrush(color)
    p.drawRoundedRect(body, 1.5, 1.5)
    r = box.width() * 0.3
    left, right = box.left() + box.width() * 0.2, box.left() + box.width() * 0.8
    shackle = QPainterPath(QPointF(left, body.top()))
    shackle.lineTo(left, box.top() + r)
    shackle.arcTo(QRectF(left, box.top(), right - left, 2 * r), 180, -180)
    shackle.lineTo(right, body.top())
    p.setPen(QPen(color, 1.4))
    p.setBrush(Qt.BrushStyle.NoBrush)
    p.drawPath(shackle)


def _paint_hold(p: QPainter, box: QRectF, color: QColor) -> None:
    bar = box.width() / 3
    p.setPen(Qt.PenStyle.NoPen)
    p.setBrush(color)
    p.drawRect(QRectF(box.left(), box.top(), bar, box.height()))
    p.drawRect(QRectF(box.right() - bar, box.top(), bar, box.height()))


class GraphCanvas(QWidget):
    #: The id of the card clicked, or "" for none.
    clicked = Signal(str)

    def __init__(self) -> None:
        super().__init__()
        self.cards: dict[str, QRectF] = {}
        self.faces: dict[str, CardFace] = {}
        self.connectors: list[Connector] = []
        self.selected: str | None = None
        self.placeholder = ""
        self.setMouseTracking(True)

    def set_graph(self, nodes: list[dict], edges: list[dict], faces: dict[str, CardFace],
                  selected: str | None, placeholder: str) -> None:
        self.cards = {str(n["id"]): card_rect(int(n.get("column") or 0), int(n["row"]))
                      for n in nodes}
        self.faces = faces
        self.connectors = connectors(self.cards, edges)
        self.selected = selected
        self.placeholder = "" if self.cards else placeholder
        columns = 1 + max((int(n.get("column") or 0) for n in nodes), default=-1)
        rows = 1 + max((int(n["row"]) for n in nodes), default=-1)
        self.setMinimumSize(
            2 * MARGIN_X + columns * CARD_W + max(0, columns - 1) * COL_GAP,
            2 * MARGIN_Y + rows * CARD_H + max(0, rows - 1) * ROW_GAP)
        self.update()

    def card_at(self, pos: QPointF) -> str | None:
        return next((i for i, rect in self.cards.items() if rect.contains(pos)), None)

    def mousePressEvent(self, event) -> None:  # noqa: N802
        if event.button() == Qt.MouseButton.LeftButton:
            self.clicked.emit(self.card_at(event.position()) or "")
        super().mousePressEvent(event)

    def mouseMoveEvent(self, event) -> None:  # noqa: N802
        self.setCursor(Qt.CursorShape.PointingHandCursor if self.card_at(event.position())
                       else Qt.CursorShape.ArrowCursor)
        super().mouseMoveEvent(event)

    def event(self, event) -> bool:  # noqa: N802
        if event.type() == QEvent.Type.ToolTip:
            hit = self.card_at(QPointF(event.pos()))
            if hit is None:
                QToolTip.hideText()
            else:
                f = self.faces[hit]
                tip = f"{f.label} · {f.title}" + (f"\nHeld: {f.hold}" if f.hold else "")
                QToolTip.showText(event.globalPos(), plain_tooltip(tip), self)
            return True
        return super().event(event)

    def paintEvent(self, event) -> None:  # noqa: N802
        p = QPainter(self)
        p.setRenderHint(QPainter.RenderHint.Antialiasing)
        p.setRenderHint(QPainter.RenderHint.TextAntialiasing)
        if self.placeholder:
            font = QFont(p.font())
            font.setPixelSize(11)
            p.setFont(font)
            p.setPen(self.palette().color(QPalette.ColorRole.Mid))
            p.drawText(QRectF(self.rect()),
                       int(Qt.AlignmentFlag.AlignCenter | Qt.TextFlag.TextWordWrap),
                       self.placeholder)
        for c in self.connectors:
            on = self.selected in (c.source, c.target)
            color = QColor(TINT if on else _GREY)
            p.strokePath(c.path, QPen(color, 2.0 if on else 1.5, c.style,
                                      Qt.PenCapStyle.FlatCap, Qt.PenJoinStyle.RoundJoin))
            p.setPen(Qt.PenStyle.NoPen)
            p.setBrush(color)
            p.drawPolygon(c.arrow)
        for item_id, rect in self.cards.items():
            self._paint_card(p, rect, self.faces[item_id], item_id == self.selected)
        p.end()

    def _paint_card(self, p: QPainter, rect: QRectF, face: CardFace, selected: bool) -> None:
        palette = self.palette()
        text = palette.color(QPalette.ColorRole.WindowText)
        p.save()
        if face.dimmed:
            p.setOpacity(0.45)
        outline = QPainterPath()
        outline.addRoundedRect(rect, RADIUS, RADIUS)
        p.fillPath(outline, palette.color(QPalette.ColorRole.Base))
        wash = QColor(TINT if selected else "#808080")
        wash.setAlphaF(0.12 if selected else 0.06)
        p.fillPath(outline, wash)
        p.save()
        p.setClipPath(outline)
        p.fillRect(QRectF(rect.left(), rect.top(), 3, rect.height()),
                   QColor(LANE_TINT.get(face.lane, _GREY)))
        p.restore()
        p.setPen(QPen(QColor(TINT), 2) if selected else QPen(QColor(128, 128, 128, 90), 1))
        p.setBrush(Qt.BrushStyle.NoBrush)
        p.drawPath(outline)

        left, right, top = rect.left() + 10, rect.right() - 8, rect.top() + 7
        # The glyph goes first: a chip leaves the painter's font bold.
        p.save()
        _draw_glyph(p, QRectF(left, top, 13, 14), face.glyph, text.name(), 11)
        p.restore()
        x = right
        if face.badge:
            x -= _paint_chip(p, x, top, face.badge.upper(),
                             glyphs.AGENT_LIVE if face.badge == "agent" else _GREY,
                             right=True) + 4
        if face.locked:
            x -= 9
            _paint_lock(p, QRectF(x, top + 1, 9, 12), palette.color(QPalette.ColorRole.Mid))
            x -= 4
        font = QFont(p.font())
        font.setPixelSize(10)
        font.setBold(True)
        p.setFont(font)
        p.setPen(text)
        label_box = QRectF(left + 17, top, max(0.0, x - left - 17), 14)
        p.drawText(label_box, int(Qt.AlignmentFlag.AlignVCenter | Qt.AlignmentFlag.AlignLeft),
                   QFontMetricsF(font).elidedText(face.label, Qt.TextElideMode.ElideMiddle,
                                                  label_box.width()))
        font.setBold(False)
        p.setFont(font)
        for i, line in enumerate(two_lines(face.title, font, right - left)):
            p.drawText(QRectF(left, top + 18 + i * 13, right - left, 13),
                       int(Qt.AlignmentFlag.AlignVCenter | Qt.AlignmentFlag.AlignLeft), line)
        # In a wide font the chips give up padding, down to 4px, to keep them apart.
        foot = rect.bottom() - 7 - 14
        chips = [(f"{letter} {LEVEL_SHORT.get(level or '', '?')}",
                  LEVEL_TINT.get(level or "", _GREY))
                 for letter, level in (("R", face.risk), ("C", face.complexity))]
        stage = (face.stage.upper(), STAGE_TINT.get(face.stage, _GREY))
        metrics = QFontMetricsF(_chip_font(p))
        texts = sum(metrics.horizontalAdvance(text) for text, _ in chips + [stage])
        mark = 12 if face.hold else 0
        pad = min(10.0, max(4.0, (right - left - 8 - mark - texts) / 3))
        x = left
        for text, tint in chips:
            x += _paint_chip(p, x, foot, text, tint, pad=pad) + 4
        if face.hold:
            _paint_hold(p, QRectF(x, foot + 3, 8, 8), QColor(_ORANGE))
        _paint_chip(p, right, foot, *stage, right=True, pad=pad)
        p.restore()


class _EdgeKey(QWidget):
    def __init__(self, kind: str) -> None:
        super().__init__()
        self.kind = kind
        self.setFixedSize(24, 12)

    def paintEvent(self, event) -> None:  # noqa: N802
        p = QPainter(self)
        p.setRenderHint(QPainter.RenderHint.Antialiasing)
        color = QColor(_GREY)
        y = self.height() / 2
        p.setPen(QPen(color, 1.5, EDGE_STYLE[self.kind], Qt.PenCapStyle.FlatCap))
        p.drawLine(QPointF(0, y), QPointF(self.width() - ARROW, y))
        p.setPen(Qt.PenStyle.NoPen)
        p.setBrush(color)
        w = self.width()
        p.drawPolygon(QPolygonF([QPointF(w, y), QPointF(w - ARROW, y - ARROW / 2),
                                 QPointF(w - ARROW, y + ARROW / 2)]))
        p.end()


# MARK: the detail


class _Link(ElidedLabel):
    """Elided in the middle, keeping the URL's number."""

    elide = Qt.TextElideMode.ElideMiddle

    def __init__(self, url: str) -> None:
        super().__init__(url, 9, _BLUE)
        self.url = url
        self.setCursor(Qt.CursorShape.PointingHandCursor)
        self.setToolTip(plain_tooltip(url))

    def mouseReleaseEvent(self, event) -> None:  # noqa: N802
        if event.button() == Qt.MouseButton.LeftButton:
            open_url(self.url)
        super().mouseReleaseEvent(event)


class _Head(ElidedLabel):
    """Elided in the middle, keeping ``#N``: ``owner/repo#N`` may be wider than the pane,
    which does not scroll sideways."""

    elide = Qt.TextElideMode.ElideMiddle

    def __init__(self, text: str) -> None:
        super().__init__(text, 11,
                         QApplication.palette().color(QPalette.ColorRole.WindowText).name())
        font = self.font()
        font.setBold(True)
        self.setFont(font)
        self.setTextFormat(Qt.TextFormat.PlainText)
        self.setText(text)
        self.setSizePolicy(QSizePolicy.Policy.Preferred, QSizePolicy.Policy.Fixed)
        self.setToolTip(plain_tooltip(text))

    def sizeHint(self) -> QSize:  # noqa: N802
        # Not QFontMetrics': its rounded-down advance is narrower than the text elides at.
        width = QFontMetricsF(self.font()).horizontalAdvance(self._full)
        return QSize(math.ceil(width), self.height())

    def minimumSizeHint(self) -> QSize:  # noqa: N802
        return QSize(0, self.height())


class EventRow(QWidget):
    def __init__(self, event: dict) -> None:
        super().__init__()
        #: Not ``event``: that would shadow ``QWidget.event``.
        self.step = event
        col = QVBoxLayout(self)
        col.setContentsMargins(0, 0, 0, 0)
        col.setSpacing(1)
        head = QHBoxLayout()
        head.setSpacing(5)
        when = QLabel(_when(event.get("at")))
        when.setStyleSheet(muted(9, mono=True))
        head.addWidget(when)
        kind = str(event.get("kind") or "")
        head.addWidget(_chip(kind.upper(), EVENT_TINT.get(kind, _GREY)))
        head.addStretch(1)
        col.addLayout(head)
        if event.get("detail"):
            detail = _Wrapped(str(event["detail"]))
            detail.setStyleSheet("font-size: 10px;")
            col.addWidget(detail)


_KIND_WORD = {("github", "issue"): "GitHub issue", ("github", "pr"): "GitHub PR",
              ("linear", "issue"): "Linear issue"}

_RATED_BY = {"label": "Read off its labels.",
             "local": "Rated here, not labelled."}


def can_start_fix(item: dict) -> bool:
    """A candidate issue: low/low, writable, no open PR fixing it. Twin of
    ``PipelineView.canStartFix``."""
    return (item.get("kind") == "issue" and item.get("stage") == "candidate"
            and bool(item.get("writable")))


def can_fracture(item: dict, edges: list[dict], rooted: bool) -> bool:
    """A writable open issue not split yet and with no PR fixing it, whose code a sync can
    read (``Store.pipeline_rooted``). Twin of ``PipelineView.canFracture``."""
    item_id = str(item.get("id") or "")
    return (item.get("kind") == "issue" and bool(item.get("writable")) and rooted
            and item.get("stage") in ("unrated", "human", "candidate")
            and not any(e.get("kind") == "child" and _ends(e)[0] == item_id for e in edges))


def can_take_over(item: dict) -> bool:
    """A writable open item not taken over, unrated or left to a human."""
    return (item.get("takenOver") is not True and bool(item.get("writable"))
            and item.get("state") in ("open", "draft")
            and item.get("stage") in ("unrated", "human"))


def empty_text(repo: str, gitlab: bool, unread: bool, reads: bool) -> str:
    """The placeholder after a sync that read no item the picked root shows. ``repo``: its
    label; ``unread``: the sync read it in part; ``reads``: a GitHub root or a Linear team
    is set. Twin of ``PipelineView.emptyText``."""
    if not reads:
        return "GitLab roots are not read, and no GitHub root or Linear team is set."
    if gitlab:
        return f"{repo} is a GitLab root, and GitLab roots are not read."
    if unread:
        return (f"The last sync did not read all of {repo}, and found no open issue or PR in "
                "what it did.")
    return f"The last sync found no open issue or PR in {repo}."


def can_rate(item: dict, me: str, rooted: bool) -> bool:
    """An open item a sync rates when asked. Twin of ``PipelineView.canRate``."""
    if item.get("state") not in ("open", "draft"):
        return False
    if item.get("kind") == "pr":
        return bool(me) and str(item.get("author") or "").lower() == me.lower()
    return rooted


class PipelineView(QWidget):
    done = Signal()

    def __init__(self, store: Store) -> None:
        super().__init__()
        self.store = store
        self.setStyleSheet("PipelineView { background: transparent; }")
        self.lane = "all"
        self.selected: str | None = None
        #: Why each item's last "Start fix" was not queued.
        self._fix_answers: dict[str, str] = {}
        self.buttons: dict[str, QPushButton] = {}
        self.fix_answer: QLabel | None = None
        self.event_rows: list[EventRow] = []

        col = QVBoxLayout(self)
        col.setContentsMargins(0, 0, 0, 0)
        col.setSpacing(8)
        col.addLayout(self._build_header())

        self.status = _plain("")
        self.status.setStyleSheet(muted(10))
        self.status.setWordWrap(True)
        col.addWidget(self.status)

        self.error_banner = self._banner(_RED)
        col.addWidget(self.error_banner)
        self.notices_banner = self._banner(_ORANGE)
        col.addWidget(self.notices_banner)
        col.addLayout(self._build_lanes())

        body = QHBoxLayout()
        body.setSpacing(12)
        self.canvas = GraphCanvas()
        self.canvas.clicked.connect(self.select)
        self.graph_scroll = QScrollArea()
        self.graph_scroll.setWidgetResizable(True)
        self.graph_scroll.setFrameShape(QScrollArea.Shape.NoFrame)
        self.graph_scroll.setWidget(self.canvas)
        body.addWidget(self.graph_scroll, 1)

        self.detail = QFrame()
        self.detail.setObjectName("pipelineDetail")
        self.detail.setStyleSheet("#pipelineDetail { background-color: rgba(128,128,128,0.07);"
                                  " border-radius: 8px; }")
        self.detail_col = QVBoxLayout(self.detail)
        self.detail_col.setContentsMargins(10, 10, 10, 10)
        self.detail_col.setSpacing(6)
        self.detail_scroll = QScrollArea()
        self.detail_scroll.setWidgetResizable(True)
        self.detail_scroll.setFrameShape(QScrollArea.Shape.NoFrame)
        self.detail_scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        self.detail_scroll.setFixedWidth(DETAIL_W)
        self.detail_scroll.setWidget(self.detail)
        body.addWidget(self.detail_scroll)
        col.addLayout(body, 1)

        store.pipeline_changed.connect(self.rebuild)
        store.tasks_changed.connect(self.rebuild)
        store.selected_repo_changed.connect(self.rebuild)
        self.rebuild()

    def _build_header(self) -> QHBoxLayout:
        row = QHBoxLayout()
        row.setContentsMargins(2, 0, 2, 0)
        row.setSpacing(6)
        row.addWidget(GlyphLabel(glyphs.G_PIPELINE, 16, TINT, font_px=14))
        title = QLabel("Pipeline")
        title.setStyleSheet("font-weight: 700; font-size: 13px;")
        row.addWidget(title)
        row.addStretch(1)
        self.sync_btn = QPushButton("Sync now")
        self.sync_btn.setToolTip("Read the trackers, rate and act now rather than at the "
                                 "next sync")
        self.sync_btn.clicked.connect(self.store.run_pipeline_sync_async)
        row.addWidget(self.sync_btn)
        done = QPushButton("Done")
        done.setStyleSheet("font-weight: 700;")
        done.clicked.connect(self.done.emit)
        row.addWidget(done)
        return row

    @staticmethod
    def _banner(tint: str) -> QLabel:
        banner = _Wrapped("")
        banner.setStyleSheet(
            f"background-color: {tint_bg(tint, 0.14)}; border-radius: 6px;"
            " padding: 6px; font-size: 10px;")
        return banner

    def _build_lanes(self) -> QHBoxLayout:
        row = QHBoxLayout()
        row.setSpacing(4)
        self.lane_group = QButtonGroup(self)
        self.lane_group.setExclusive(True)
        self.lane_chips: dict[str, ToggleChip] = {}
        for lane, _ in LANES:
            chip = ToggleChip("", tint=TINT)
            chip.clicked.connect(lambda _=False, lane=lane: self.set_lane(lane))
            self.lane_group.addButton(chip)
            self.lane_chips[lane] = chip
            row.addWidget(chip)
        row.addStretch(1)
        for kind in EDGE_STYLE:
            row.addWidget(_EdgeKey(kind))
            word = QLabel(kind)
            word.setStyleSheet(muted(9))
            row.addWidget(word)
            row.addSpacing(6)
        return row

    def open(self) -> None:
        self.lane = "all"
        self.selected = None
        self._fix_answers.clear()
        self.rebuild()

    def set_lane(self, lane: str) -> None:
        self.lane = lane
        self.rebuild()

    def select(self, item_id: str) -> None:
        self.selected = item_id or None
        self.rebuild()
        self.detail_scroll.verticalScrollBar().setValue(0)

    def _start_fix(self, item: dict) -> None:
        item_id = str(item.get("id") or "")
        error = self.store.pipeline_start_fix(item)
        if error is None:
            self._fix_answers.pop(item_id, None)
        else:
            self._fix_answers[item_id] = error
        self.rebuild()

    # MARK: rebuild

    def _status_text(self, result: dict | None) -> str:
        st = self.store
        if not st.pipeline_enabled:
            return "Off - turn the Pipeline on in Settings."
        items = (result or {}).get("items") or []
        fast = sum(1 for i in items if i.get("lane") == "fast")
        parts = [f"{len(items)} item{'' if len(items) == 1 else 's'}", f"{fast} fast"]
        if st.pipeline_syncing:
            parts.append("syncing…")
        elif result is not None:
            parts.append(f"last sync {_clock(result.get('at'))}")
        else:
            parts.append("not synced yet")
        return " · ".join(parts)

    def rebuild(self) -> None:
        st = self.store
        teams, _ = pipeline.parse_linear_teams(st.pipeline_linear_teams_raw)
        roots = review.repo_roots()
        picked = st.selected_repo
        shown = None if st.pipeline_result is None else in_root(
            st.pipeline_result, picked.key, {r.key for r in roots}, teams)
        result = shown or {}
        items = result.get("items") or []
        by_id = {str(i.get("id")): i for i in items}
        self.status.setText(self._status_text(shown))
        self.sync_btn.setEnabled(st.pipeline_enabled and not st.pipeline_syncing)
        error = st.pipeline_error if st.pipeline_enabled else None
        self.error_banner.setVisible(bool(error))
        self.error_banner.setText(f"⚠ {error}" if error else "")
        notices = result.get("notices") or []
        self.notices_banner.setVisible(bool(notices))
        self.notices_banner.setText("\n".join(f"⚠ {n}" for n in notices))
        counts = lane_counts(items)
        for lane, word in LANES:
            self.lane_chips[lane].setText(f"{word} {counts[lane]}")
            self.lane_chips[lane].setChecked(lane == self.lane)

        if self.selected not in by_id:
            self.selected = None
        badges = st.pipeline_badges()
        nodes = shown_nodes(result, self.lane)
        edges = (result.get("graph") or {}).get("edges") or []
        faces = {str(n["id"]): card_face(by_id[str(n["id"])], badges.get(str(n["id"])))
                 for n in nodes}
        reads = bool(teams) or any(not r.is_gitlab for r in roots)
        unread = picked.key in {str(u).lower() for u in result.get("unread") or []}
        placeholder = ("No sync has run yet." if shown is None
                       else empty_text(root_label(picked, roots), picked.is_gitlab, unread, reads)
                       if not items else "Nothing in this lane.")
        self.canvas.set_graph(nodes, edges, faces, self.selected, placeholder)
        self._rebuild_detail(by_id.get(self.selected or ""), badges.get(self.selected or ""),
                             result, edges)

    def _line(self, text: str, style: str) -> QLabel:
        label = _Wrapped(text)
        label.setStyleSheet(style)
        self.detail_col.addWidget(label)
        return label

    def _section(self, title: str, count: int | None = None) -> None:
        row = QHBoxLayout()
        head = QLabel(title)
        head.setStyleSheet(muted(10, bold=True))
        row.addWidget(head)
        if count is not None:
            c = QLabel(str(count))
            c.setStyleSheet(muted(10, mono=True))
            row.addWidget(c)
        row.addStretch(1)
        self.detail_col.addSpacing(4)
        self.detail_col.addLayout(row)

    def _rebuild_detail(self, item: dict | None, badge: str | None, result: dict,
                        edges: list[dict]) -> None:
        _clear(self.detail_col)
        self.buttons = {}
        self.fix_answer = None
        self.event_rows = []
        if item is None:
            self._line("Select a card for its rating, who may act on it and its traversal.",
                       muted(10))
            self.detail_col.addStretch(1)
            return
        item_id = str(item.get("id") or "")

        head = QHBoxLayout()
        head.setSpacing(6)
        head.addWidget(GlyphLabel(source_glyph(item), 14, TINT, font_px=12))
        head.addWidget(_Head(str(item.get("label") or "")))
        kind = _plain(_KIND_WORD.get((item.get("source"), item.get("kind")), ""))
        kind.setStyleSheet(muted(9))
        head.addWidget(kind)
        head.addStretch(1)
        self.detail_col.addLayout(head)
        self._line(str(item.get("title") or ""), "font-weight: 700; font-size: 12px;")
        self.detail_col.addWidget(_Link(item_id))
        chips = QHBoxLayout()
        chips.setSpacing(4)
        stage = str(item.get("stage") or "")
        chips.addWidget(_chip(stage.upper(), STAGE_TINT.get(stage, _GREY)))
        if item.get("state") not in (None, "open"):
            chips.addWidget(_chip(str(item["state"]).upper(), _GREY))
        if badge:
            chips.addWidget(_chip(badge.upper(),
                                  glyphs.AGENT_LIVE if badge == "agent" else _GREY))
        chips.addStretch(1)
        self.detail_col.addLayout(chips)

        self._section("RATING")
        rating = item.get("rating")
        if rating:
            row = QHBoxLayout()
            row.setSpacing(4)
            for dim in ("risk", "complexity"):
                level = str(rating.get(dim) or "")
                row.addWidget(_chip(f"{dim.upper()} {level.upper()}",
                                    LEVEL_TINT.get(level, _GREY)))
            row.addStretch(1)
            self.detail_col.addLayout(row)
            if item.get("ratedBy") in _RATED_BY:
                self._line(_RATED_BY[item["ratedBy"]], muted(9))
        else:
            self._line("Not rated yet.", muted(10))
        if item.get("why"):
            self._line(f"“{item['why']}”", "font-size: 10px;")
        floor = item.get("floor")
        if floor:
            self._line(f"Its diff allows no less than risk {floor.get('risk')} · "
                       f"complexity {floor.get('complexity')}.", muted(9))
        if item.get("hold"):
            self._line(f"Held: {item['hold']}",
                       f"color: {_ORANGE}; background-color: {tint_bg(_ORANGE, 0.12)};"
                       " border-radius: 5px; padding: 4px; font-size: 10px;")

        self._section("WHO")
        self._line("Writable: Diplomat may label it and act on it." if item.get("writable")
                   else "Read only: Diplomat shows it and writes nothing to it.",
                   "font-size: 10px;")
        if item.get("takenOver") is True:
            self._line("Taken over: its rating does not hold it", muted(9))
        assignees = [str(a) for a in item.get("assignees") or []]
        people = ([f"by {_who(str(item['author']), item)}"] if item.get("author") else [])
        people.append(f"assigned to {', '.join(_who(a, item) for a in assignees)}"
                      if assignees else "unassigned")
        text = " · ".join(people)
        self._line(text[:1].upper() + text[1:], muted(9))
        head_sha = str(item.get("headSha") or "")
        if head_sha:
            clean = str(item.get("cleanAt") or "")
            self._line(f"Head {head_sha[:7]}" + (" · clean at it" if clean == head_sha
                                                  else f" · clean at {clean[:7]}" if clean
                                                  else ""), muted(9, mono=True))

        self._build_actions(item, badge, edges)

        events = [e for e in result.get("events") or [] if e.get("item") == item_id][::-1]
        self._section("TRAVERSAL", len(events))
        if not events:
            self._line("Nothing logged about it yet.", muted(10))
        for event in events:
            row = EventRow(event)
            self.event_rows.append(row)
            self.detail_col.addWidget(row)
        self.detail_col.addStretch(1)

    def _build_actions(self, item: dict, badge: str | None, edges: list[dict]) -> None:
        """A PR is the operator's by ``gh``'s account (``Store.me``), as a sync judges it,
        not the Settings override's."""
        st = self.store
        item_id = str(item.get("id") or "")
        on = st.pipeline_enabled
        rooted = st.pipeline_rooted(item)
        ban_unread = st.pipeline_ban_unread()
        split_asked = item_id in st.pipeline_forced("fracture")
        self.buttons["open"] = _small_button("Open", lambda: open_url(item_id))
        if can_rate(item, st.me, rooted):
            asked = item_id in st.pipeline_forced("rate")
            refused = ban_unread or item.get("rateRefused")
            btn = _small_button("Rate asked" if asked else "Rate now",
                                lambda: st.pipeline_force_now("rate", item_id))
            btn.setToolTip(plain_tooltip(
                refused or "Rate it in a sync started now, ahead of every limit"))
            btn.setEnabled(on and not asked and not refused)
            self.buttons["rate"] = btn
        if can_fracture(item, edges, rooted):
            refused = ban_unread or item.get("fractureRefused")
            btn = _small_button("Fracture asked" if split_asked else "Fracture",
                                lambda: st.pipeline_force_now("fracture", item_id))
            btn.setToolTip(plain_tooltip(
                refused or "Split it into low-complexity child issues in a sync started now"))
            btn.setEnabled(on and not split_asked and badge is None and not refused)
            self.buttons["fracture"] = btn
        if can_start_fix(item):
            ban = st.pipeline_ban(item)
            known = st.pipeline_fix_effect(item) is not None
            btn = _small_button("Start fix", lambda: self._start_fix(item))
            btn.setToolTip(plain_tooltip(
                ban or ("Queue its fix now, past its retry backoff" if known
                        else st.pipeline_fix_unknown(item))))
            btn.setEnabled(on and known and badge is None and not split_asked and ban is None)
            self.buttons["fix"] = btn
        pr = item.get("kind") == "pr"
        if can_take_over(item):
            asked = item_id in st.pipeline_forced("takeover")
            refused = ban_unread or item.get("takeoverRefused")
            btn = _small_button("Takeover asked" if asked else "Authorize takeover",
                                lambda: st.pipeline_force_now("takeover", item_id))
            btn.setToolTip(plain_tooltip(refused or (
                "Hand it to Diplomat in a sync started now: reviewed until clean and merged, "
                "whatever its rating" if pr else
                "Hand it to Diplomat in a sync started now: a fix candidate whatever its "
                "rating or triage")))
            btn.setEnabled(on and not asked and not refused)
            self.buttons["takeover"] = btn
        if item.get("takenOver") is True:
            asked = item_id in st.pipeline_forced("revoke")
            btn = _small_button("Revoke asked" if asked else "Revoke takeover",
                                lambda: st.pipeline_force_now("revoke", item_id))
            btn.setToolTip(plain_tooltip("Take it back from Diplomat in a sync started now"
                                         + (": off the fast track for good" if pr else "")))
            btn.setEnabled(on and not asked)
            self.buttons["revoke"] = btn
        self.detail_col.addSpacing(4)
        # The pane does not scroll sideways, and all five on one line are wider than it.
        apart = ("takeover", "revoke")
        for line in ([b for k, b in self.buttons.items() if k not in apart],
                     [b for k, b in self.buttons.items() if k in apart]):
            if line:
                row = QHBoxLayout()
                row.setSpacing(4)
                for btn in line:
                    row.addWidget(btn)
                row.addStretch(1)
                self.detail_col.addLayout(row)
        answer = self._fix_answers.get(item_id)
        if answer is not None:
            self.fix_answer = self._line(answer, f"color: {_RED}; font-size: 10px;")
