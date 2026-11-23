import SwiftUI
import AppKit
import DiplomatCore

/// The Pipeline screen: every open issue and PR the last sync read, as cards on the grid
/// `PipelineGraph` lays them on, joined by what links them; a lane filter; and the
/// selected card's rating, hold, traversal and actions.
///
/// Draws `store.pipelineResult` (the core's `PipelineTickResult`, which the Linux twin
/// draws too). The switches are in Settings; the agent work the pipeline asks for is
/// managed from the Agent-tasks list like any other ask.
struct PipelineView: View {
    @EnvironmentObject var store: Store
    @Binding var isPresented: Bool

    /// nil shows every group.
    @State private var lane: PipelineLane?
    /// The selected card's item id.
    @State private var selected: String?
    /// Why the selected card's last action was refused.
    @State private var actionError: String?

    static let detailWidth: CGFloat = 290

    /// Seeded only by the headless renders.
    init(isPresented: Binding<Bool>, seedSelected: String? = nil, seedLane: PipelineLane? = nil) {
        _isPresented = isPresented
        _selected = State(initialValue: seedSelected)
        _lane = State(initialValue: seedLane)
    }

    var body: some View {
        let result = store.pipelineResult
        return VStack(alignment: .leading, spacing: 8) {
            header(result)
            statusLine(result)
            if store.pipelineEnabled, let error = store.pipelineError {
                banner(error, tint: .red)
            }
            ForEach(result?.notices ?? [], id: \.self) { notice in
                banner(notice, tint: .orange)
            }
            if let result, !result.items.isEmpty {
                HStack(spacing: 5) {
                    laneChips(result.items)
                    Spacer(minLength: 8)
                    legend
                }
                HStack(alignment: .top, spacing: 12) {
                    graph(result)
                        .frame(maxWidth: .infinity, alignment: .topLeading)
                    detail(result)
                        .frame(width: PipelineView.detailWidth, alignment: .topLeading)
                }
            } else {
                Text(PipelineView.emptyText(enabled: store.pipelineEnabled, synced: result != nil))
                    .font(.system(size: 11)).foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .cardChrome(padding: 6)
            }
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, alignment: .topLeading)
        .onChange(of: selected) { _ in actionError = nil }
        .task { await store.loadPipelineLast() }
    }

    /// What stands in for the graph while there is none to draw.
    static func emptyText(enabled: Bool, synced: Bool) -> String {
        if !enabled {
            return "The pipeline is off. Switched on in Settings, it rates every open issue and your own PRs, "
                + "sends the low-risk, low-complexity ones down the fast track and shows them here."
        }
        return synced ? "The last sync found no open issue or PR."
            : "Nothing read yet: the first sync lists every open issue and PR of the GitHub roots "
                + "and the tracked Linear teams here."
    }

    // MARK: - Header and status

    private func header(_ result: PipelineTickResult?) -> some View {
        HStack(spacing: 6) {
            Image(systemName: PipelineView.symbol).foregroundStyle(.secondary)
            Text("Pipeline").font(.subheadline.bold())
            PipelineCountPill(count: result?.items.count ?? 0)
            Spacer()
            PipelineActionChip(symbol: "arrow.triangle.2.circlepath",
                               text: store.pipelineSyncing ? "Syncing…" : "Sync now",
                               tint: .accentColor,
                               enabled: store.pipelineEnabled && !store.pipelineSyncing) {
                store.syncPipelineNow()
            }
            Button { withAnimation(.easeInOut(duration: 0.15)) { isPresented = false } } label: {
                Text("Done").bold()
            }
            .buttonStyle(.borderless)
            .keyboardShortcut(.cancelAction)
        }
    }

    /// The header button's glyph and this screen's.
    static let symbol = "point.3.connected.trianglepath.dotted"

    private func statusLine(_ result: PipelineTickResult?) -> some View {
        let tint: Color = !store.pipelineEnabled ? .secondary
            : store.pipelineError != nil ? .red
            : (result?.notices.isEmpty == false ? .orange : .green)
        return HStack(spacing: 6) {
            Circle().fill(tint).frame(width: 7, height: 7)
            Text(statusText(result)).font(.system(size: 11)).foregroundStyle(.secondary)
            if store.pipelineSyncing { ProgressView().controlSize(.mini) }
            Spacer()
        }
    }

    private func statusText(_ result: PipelineTickResult?) -> String {
        let last = result.map { "last sync \(PipelineTint.syncTime($0.at))" } ?? "not synced yet"
        guard store.pipelineEnabled else { return "Off: switch the pipeline on in Settings · \(last)" }
        let roots = store.roots.filter { !$0.isGitLab }.count
        let teams = Store.pipelineTeams(store.pipelineLinearTeamsRaw).map(\.key)
        var read = "Open issues and PRs of \(roots) GitHub root\(roots == 1 ? "" : "s")"
        if !teams.isEmpty { read += " and Linear \(teams.joined(separator: ", "))" }
        let off = [(store.pipelineRate, "rating"), (store.pipelineFix, "fixes"),
                   (store.pipelineFastTrack, "fast track"), (store.pipelineMerge, "merges"),
                   (store.pipelineFracture, "splits")].filter { !$0.0 }.map(\.1)
        let doing = off.isEmpty ? "" : " · \(off.joined(separator: ", ")) off"
        return "\(read) · \(last) · every \(Fmt.duration(Store.pipelineSyncInterval))\(doing)"
    }

    private func banner(_ message: String, tint: Color) -> some View {
        HStack(alignment: .top, spacing: 6) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 10)).foregroundStyle(tint)
            Text(message).font(.system(size: 11))
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
            Spacer(minLength: 0)
        }
        .cardChrome(fill: tint.opacity(0.14))
    }

    // MARK: - Lanes

    private func laneChips(_ items: [PipelineItem]) -> some View {
        let counts = Dictionary(grouping: items, by: \.lane).mapValues(\.count)
        return HStack(spacing: 4) {
            PipelineLaneChip(text: "All", count: items.count, tint: .accentColor, on: lane == nil) {
                lane = nil
            }
            ForEach(PipelineView.lanes, id: \.self) { l in
                PipelineLaneChip(text: PipelineTint.word(l), count: counts[l] ?? 0,
                                 tint: PipelineTint.lane(l), on: lane == l) {
                    lane = lane == l ? nil : l
                }
            }
        }
    }

    /// In the order the chips read: where work is moving, where it waits on a person, then
    /// what is not sorted yet, what was split, and what is over.
    static let lanes: [PipelineLane] = [.fast, .human, .unrated, .fractured, .done]

    /// A writable open issue not split yet: not `fractured`, with no child, and no PR
    /// fixing it (`fixing`), whose code a sync can read (`rooted`, `Store.pipelineRooted`).
    /// Twin of `pipelineview.can_fracture`.
    static func canFracture(_ item: PipelineItem, edges: [PipelineGraph.Edge], rooted: Bool) -> Bool {
        item.kind == .issue && item.writable && rooted && [.unrated, .human, .candidate].contains(item.stage)
            && !edges.contains { $0.kind == .child && $0.from == item.id }
    }

    /// An open item a sync rates when asked: a PR only when it is `me`'s, an issue only
    /// when its code can be read (`rooted`). Twin of `pipelineview.can_rate`.
    static func canRate(_ item: PipelineItem, me: String, rooted: Bool) -> Bool {
        guard item.state == "open" || item.state == "draft" else { return false }
        if item.kind == .pr { return !me.isEmpty && item.author?.lowercased() == me.lowercased() }
        return rooted
    }

    /// A candidate issue: low/low, writable, no open PR fixing it.
    static func canStartFix(_ item: PipelineItem) -> Bool {
        item.kind == .issue && item.stage == .candidate && item.writable
    }

    private var legend: some View {
        HStack(spacing: 10) {
            ForEach([PipelineGraph.EdgeKind.fixes, .child, .stacked], id: \.self) { kind in
                HStack(spacing: 4) {
                    Canvas { ctx, size in
                        var path = Path()
                        path.move(to: CGPoint(x: 0, y: size.height / 2))
                        path.addLine(to: CGPoint(x: size.width, y: size.height / 2))
                        ctx.stroke(path, with: .color(PipelineTint.edge(kind)), style: PipelineTint.stroke(kind))
                    }
                    .frame(width: 22, height: 6)
                    Text(PipelineTint.word(kind)).font(.system(size: 9.5)).foregroundStyle(.secondary)
                }
            }
        }
        .fixedSize()
    }

    // MARK: - The graph

    /// Taller than this, the graph scrolls inside its own frame, so the selected card's
    /// details stay beside it.
    static let viewport: CGFloat = 560

    @Environment(\.isImageRendering) private var isImageRendering

    @ViewBuilder
    private func graph(_ result: PipelineTickResult) -> some View {
        let layout = PipelineLayout.make(result, lane: lane)
        let canvas = PipelineCanvas(layout: layout, badges: store.pipelineBadges,
                                    selected: selected) { id in
            selected = selected == id ? nil : id
        }
        if layout.cards.isEmpty {
            Text("No group has a card in this lane.")
                .font(.system(size: 11)).foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .cardChrome(padding: 6)
        } else if isImageRendering {
            // `ImageRenderer` draws no scroll view, so a graph too wide is cut at the edge.
            Color.clear.frame(height: layout.size.height)
                .overlay(alignment: .topLeading) { canvas }
                .clipped()
        } else if layout.size.height <= PipelineView.viewport {
            // Scrolls only a graph too wide for the screen.
            ViewThatFits(in: .horizontal) {
                canvas
                ScrollView(.horizontal) { canvas }
            }
        } else {
            // Both ways only once too wide: a scroll view centres narrower content.
            ViewThatFits(in: .horizontal) {
                ScrollView(.vertical) { canvas.frame(maxWidth: .infinity, alignment: .topLeading) }
                ScrollView([.horizontal, .vertical]) { canvas }
            }
            .frame(height: PipelineView.viewport)
        }
    }

    // MARK: - The selected card

    @ViewBuilder
    private func detail(_ result: PipelineTickResult) -> some View {
        if let id = selected, let item = result.items.first(where: { $0.id == id }) {
            let rooted = store.pipelineRooted(item)
            PipelineDetail(item: item,
                           events: result.events.filter { $0.item == id }.reversed(),
                           badge: store.pipelineBadges[Store.pipelineIdentity(item.id)],
                           enabled: store.pipelineEnabled,
                           forcedRate: store.pipelineForce.rate.contains(id),
                           forcedFracture: store.pipelineForce.fracture.contains(id),
                           canRate: PipelineView.canRate(item, me: store.effectiveMe, rooted: rooted),
                           canFracture: PipelineView.canFracture(item, edges: result.graph.edges,
                                                                 rooted: rooted),
                           canStartFix: store.pipelineFixEffect(for: item) != nil,
                           fixUnknown: store.pipelineFixUnknown(item),
                           error: actionError,
                           rate: { store.forcePipeline(rate: id) },
                           fracture: { store.forcePipeline(fracture: id) },
                           startFix: { actionError = store.startPipelineFix(item) },
                           close: { selected = nil })
        } else {
            VStack(alignment: .leading, spacing: 6) {
                Text("SELECTED").font(.system(size: 9, weight: .bold)).foregroundStyle(.secondary)
                    .kerning(0.5)
                Text("Select a card for its rating, why it is not moving, who may act on it "
                     + "and what happened to it so far.")
                    .font(.system(size: 11)).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .cardChrome(padding: 8)
        }
    }
}

// MARK: - Layout

/// Where `PipelineView` draws each card and connector: `PipelineGraph`'s columns as they
/// are, its rows packed per connected group, groups one below another in the order of
/// their first row. A lane filter keeps every group with a card in that lane, whole.
struct PipelineLayout {
    struct Card {
        let item: PipelineItem
        let frame: CGRect
    }

    /// `path` runs from the source's right side to the base of `arrow`, whose tip touches
    /// the target's left side.
    struct Link {
        let edge: PipelineGraph.Edge
        let path: Path
        let arrow: Path
    }

    var cards: [Card] = []
    var links: [Link] = []
    /// One behind each group.
    var bands: [CGRect] = []
    var size: CGSize = .zero

    static let cardSize = CGSize(width: 170, height: 88)
    static let columnGap: CGFloat = 40
    static let rowGap: CGFloat = 14
    static let groupGap: CGFloat = 12
    static let inset: CGFloat = 6
    static let arrowLength: CGFloat = 7
    static let arrowHalfWidth: CGFloat = 3.5
    /// The radius a connector turns at.
    static let corner: CGFloat = 6

    static func make(_ result: PipelineTickResult, lane: PipelineLane?) -> PipelineLayout {
        let items = Dictionary(result.items.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        let nodes = result.graph.nodes.filter { items[$0.id] != nil }
        var parent = Dictionary(nodes.map { ($0.id, $0.id) }, uniquingKeysWith: { first, _ in first })
        func find(_ id: String) -> String {
            var root = id
            while let up = parent[root], up != root { root = up }
            return root
        }
        let edges = result.graph.edges.filter { parent[$0.from] != nil && parent[$0.to] != nil }
        for edge in edges {
            let a = find(edge.from), b = find(edge.to)
            if a != b { parent[max(a, b)] = min(a, b) }
        }
        let groups = Dictionary(grouping: nodes, by: { find($0.id) }).values
            .sorted { a, b in
                let ka = (a.map(\.row).min() ?? 0, a.map(\.column).min() ?? 0)
                let kb = (b.map(\.row).min() ?? 0, b.map(\.column).min() ?? 0)
                return ka != kb ? ka < kb : (a.map(\.id).min() ?? "") < (b.map(\.id).min() ?? "")
            }
            .filter { group in lane == nil || group.contains { items[$0.id]?.lane == lane } }

        var out = PipelineLayout()
        var frames: [String: CGRect] = [:]
        let w = cardSize.width, h = cardSize.height
        // Only a connector into column 0 has to come round through a gutter left of it.
        let first = Set(groups.joined().filter { $0.column <= 0 }.map(\.id))
        let left = edges.contains { first.contains($0.to) } ? inset + columnGap / 2 : inset
        var top = inset
        for group in groups {
            let rows = Array(Set(group.map(\.row))).sorted()
            let index = Dictionary(uniqueKeysWithValues: rows.enumerated().map { ($1, $0) })
            var band = CGRect.null
            for node in group.sorted(by: { ($0.row, $0.column) < ($1.row, $1.column) }) {
                guard let item = items[node.id] else { continue }
                let frame = CGRect(x: left + CGFloat(max(0, node.column)) * (w + columnGap),
                                   y: top + CGFloat(index[node.row] ?? 0) * (h + rowGap),
                                   width: w, height: h)
                frames[node.id] = frame
                out.cards.append(Card(item: item, frame: frame))
                band = band.union(frame)
            }
            out.bands.append(band.insetBy(dx: -inset / 2 - 1, dy: -inset / 2 - 1))
            top = band.maxY + rowGap + groupGap
        }
        out.links = links(edges.filter { frames[$0.from] != nil && frames[$0.to] != nil }, frames)
        let maxX = (out.cards.map(\.frame.maxX) + out.links.map(\.path.boundingRect.maxX)).max() ?? 0
        let maxY = (out.cards.map(\.frame.maxY) + out.links.map(\.path.boundingRect.maxY)).max() ?? 0
        out.size = CGSize(width: maxX + inset, height: maxY + inset)
        return out
    }

    /// Each edge from its source's right side to its target's left side, never across a
    /// card: into the next column one curve through the gutter between; anything else out
    /// into the source's gutter, along the middle of the gap between card rows (above the
    /// source's row toward a target above it, else below), and in through the target's
    /// gutter. Connectors sharing a side spread along it in the order they head off to or
    /// come in from.
    private static func links(_ edges: [PipelineGraph.Edge], _ frames: [String: CGRect]) -> [Link] {
        let src = edges.map { frames[$0.from]! }, dst = edges.map { frames[$0.to]! }
        func next(_ i: Int) -> Bool { abs(dst[i].minX - src[i].maxX - columnGap) < 0.5 }
        func gap(_ i: Int) -> CGFloat {
            dst[i].minY < src[i].minY ? src[i].minY - rowGap / 2 : src[i].maxY + rowGap / 2
        }
        func ports(out: Bool) -> [CGFloat] {
            var ys = [CGFloat](repeating: 0, count: edges.count)
            let shares = Dictionary(grouping: edges.indices, by: { out ? edges[$0].from : edges[$0].to })
            for share in shares.values {
                func toward(_ i: Int) -> (CGFloat, CGFloat, Int) {
                    let far = out ? dst[i] : src[i]
                    return (next(i) ? far.midY : gap(i), far.minX, i)
                }
                for (n, i) in share.sorted(by: { toward($0) < toward($1) }).enumerated() {
                    let card = out ? src[i] : dst[i]
                    ys[i] = card.minY + card.height * CGFloat(n + 1) / CGFloat(share.count + 1)
                }
            }
            return ys
        }
        let y0 = ports(out: true), y1 = ports(out: false)
        return edges.indices.map { i in
            let start = CGPoint(x: src[i].maxX, y: y0[i]), tip = CGPoint(x: dst[i].minX, y: y1[i])
            let end = CGPoint(x: tip.x - arrowLength, y: tip.y)
            var path = Path()
            if next(i) {
                let mid = (start.x + end.x) / 2
                path.move(to: start)
                path.addCurve(to: end, control1: CGPoint(x: mid, y: start.y),
                              control2: CGPoint(x: mid, y: end.y))
            } else {
                let run = gap(i), out = src[i].maxX + columnGap / 2, into = dst[i].minX - columnGap / 2
                path = rounded([start, CGPoint(x: out, y: start.y), CGPoint(x: out, y: run),
                                CGPoint(x: into, y: run), CGPoint(x: into, y: end.y), end])
            }
            var arrow = Path()
            arrow.move(to: tip)
            arrow.addLine(to: CGPoint(x: end.x, y: tip.y - arrowHalfWidth))
            arrow.addLine(to: CGPoint(x: end.x, y: tip.y + arrowHalfWidth))
            arrow.closeSubpath()
            return Link(edge: edges[i], path: path, arrow: arrow)
        }
    }

    /// Straight runs through `points`, each corner rounded at `corner` or half the shorter
    /// run beside it.
    private static func rounded(_ points: [CGPoint]) -> Path {
        func toward(_ at: CGPoint, _ other: CGPoint) -> CGPoint {
            let length = hypot(other.x - at.x, other.y - at.y)
            guard length > 0 else { return at }
            let t = min(corner, length / 2) / length
            return CGPoint(x: at.x + (other.x - at.x) * t, y: at.y + (other.y - at.y) * t)
        }
        var path = Path()
        path.move(to: points[0])
        for i in points.indices.dropFirst().dropLast() {
            path.addLine(to: toward(points[i], points[i - 1]))
            path.addQuadCurve(to: toward(points[i], points[i + 1]), control: points[i])
        }
        path.addLine(to: points[points.count - 1])
        return path
    }
}

// MARK: - Canvas

/// The cards at their frames over the connectors.
private struct PipelineCanvas: View {
    let layout: PipelineLayout
    let badges: [String: Store.PipelineBadge]
    let selected: String?
    let select: (String) -> Void

    var body: some View {
        ZStack(alignment: .topLeading) {
            ForEach(Array(layout.bands.enumerated()), id: \.offset) { _, band in
                RoundedRectangle(cornerRadius: 7)
                    .fill(Color.gray.opacity(0.07))
                    .frame(width: band.width, height: band.height)
                    .offset(x: band.minX, y: band.minY)
            }
            Canvas { ctx, _ in
                for link in layout.links { PipelineCanvas.draw(link, in: &ctx) }
            }
            .frame(width: layout.size.width, height: layout.size.height)
            ForEach(layout.cards, id: \.item.id) { card in
                PipelineCard(item: card.item, badge: badges[Store.pipelineIdentity(card.item.id)],
                             selected: selected == card.item.id) { select(card.item.id) }
                    .offset(x: card.frame.minX, y: card.frame.minY)
            }
        }
        .frame(width: layout.size.width, height: layout.size.height, alignment: .topLeading)
    }

    static func draw(_ link: PipelineLayout.Link, in ctx: inout GraphicsContext) {
        let tint = PipelineTint.edge(link.edge.kind)
        ctx.stroke(link.path, with: .color(tint), style: PipelineTint.stroke(link.edge.kind))
        ctx.fill(link.arrow, with: .color(tint))
    }
}

// MARK: - A card

private struct PipelineCard: View {
    let item: PipelineItem
    let badge: Store.PipelineBadge?
    let selected: Bool
    let select: () -> Void

    var body: some View {
        let laneTint = PipelineTint.lane(item.lane)
        let shape = RoundedRectangle(cornerRadius: 5)
        return VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 4) {
                Image(systemName: PipelineTint.glyph(item))
                    .font(.system(size: 9.5, weight: .semibold))
                    .foregroundStyle(PipelineTint.source(item.source))
                Text(item.label).font(.system(size: 10, weight: .semibold, design: .monospaced))
                    .lineLimit(1).truncationMode(.middle)
                Spacer(minLength: 2)
                if item.hold != nil {
                    Image(systemName: "hand.raised.fill").font(.system(size: 8.5))
                        .foregroundStyle(.orange)
                }
                if !item.writable {
                    Image(systemName: "lock.fill").font(.system(size: 8)).foregroundStyle(.secondary)
                }
                if let badge { PipelineQueueBadge(badge: badge) }
            }
            Text(item.title).font(.system(size: 10.5))
                .lineLimit(2).truncationMode(.tail)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .topLeading)
            Spacer(minLength: 0)
            HStack(spacing: 3) {
                PipelineLevelBadge(letter: "R", level: item.rating?.risk)
                PipelineLevelBadge(letter: "C", level: item.rating?.complexity)
                Spacer(minLength: 2)
                PipelineStageChip(stage: item.stage)
            }
        }
        .padding(.leading, 9).padding(.trailing, 7).padding(.vertical, 6)
        .frame(width: PipelineLayout.cardSize.width, height: PipelineLayout.cardSize.height,
               alignment: .topLeading)
        .background(shape.fill(Color(nsColor: .controlBackgroundColor)))
        .background(shape.fill(laneTint.opacity(0.08)).padding(-0.5))
        .overlay(alignment: .leading) {
            Rectangle().fill(laneTint.opacity(item.lane == .done ? 0.5 : 0.9)).frame(width: 3)
        }
        .clipShape(shape)
        .overlay(shape.strokeBorder(selected ? Color.accentColor : Color.gray.opacity(0.32),
                                    lineWidth: selected ? 2 : 1))
        .opacity(item.lane == .done ? 0.6 : 1)
        .contentShape(shape)
        .onTapGesture(perform: select)
        .accessibilityAddTraits(.isButton)
        .tooltip(PipelineTint.hover(item))
    }
}

// MARK: - The detail pane

private struct PipelineDetail: View {
    let item: PipelineItem
    /// Newest first.
    let events: [PipelineEvent]
    let badge: Store.PipelineBadge?
    /// The master switch: off, a force would wait for a sync that never comes.
    let enabled: Bool
    let forcedRate: Bool
    let forcedFracture: Bool
    let canRate: Bool
    let canFracture: Bool
    /// The fix effect is known: a Linear issue's text comes only with a sync's.
    let canStartFix: Bool
    /// Why it is not (`Store.pipelineFixUnknown`).
    let fixUnknown: String
    let error: String?
    let rate: () -> Void
    let fracture: () -> Void
    let startFix: () -> Void
    let close: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 5) {
                Image(systemName: PipelineTint.glyph(item))
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(PipelineTint.source(item.source))
                Text(item.label).font(.system(size: 11, weight: .bold, design: .monospaced))
                    .textSelection(.enabled)
                PipelineStageChip(stage: item.stage)
                Spacer(minLength: 4)
                Button(action: close) {
                    Image(systemName: "xmark").font(.system(size: 9, weight: .bold))
                        .foregroundStyle(.secondary)
                }
                .buttonStyle(.plain)
                .tooltip("Deselect")
            }
            Text(item.title).font(.system(size: 12, weight: .semibold))
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
            Text(item.id).font(.system(size: 9.5, design: .monospaced)).foregroundStyle(Color.accentColor)
                .lineLimit(1).truncationMode(.middle)
                .onTapGesture(perform: open)
                .tooltip(item.id)
            section("RATING") { rating }
            if let hold = item.hold {
                HStack(alignment: .top, spacing: 5) {
                    Image(systemName: "hand.raised.fill").font(.system(size: 9)).foregroundStyle(.orange)
                    Text(PipelineTint.held(hold)).font(.system(size: 10.5)).fixedSize(horizontal: false, vertical: true)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .cardChrome(fill: Color.orange.opacity(0.13), padding: 5)
            }
            section("WHO MAY ACT") {
                Text(PipelineTint.access(item)).font(.system(size: 10.5))
                    .fixedSize(horizontal: false, vertical: true)
                Text(PipelineTint.people(item)).font(.system(size: 10)).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                if let head = item.headSha {
                    Text(headLine(head)).font(.system(size: 10, design: .monospaced))
                        .foregroundStyle(.secondary)
                }
                if let badge {
                    HStack(spacing: 4) {
                        PipelineQueueBadge(badge: badge)
                        Text(badge == .agent ? "an agent is on it" : "its work is queued")
                            .font(.system(size: 10)).foregroundStyle(.secondary)
                    }
                }
            }
            section("ACTIONS") { actions }
            section("TRAVERSAL") { traversal }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .cardChrome(padding: 8)
    }

    private func section<Content: View>(_ title: String, @ViewBuilder _ content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(title).font(.system(size: 9, weight: .bold)).foregroundStyle(.secondary).kerning(0.5)
            content()
        }
    }

    @ViewBuilder
    private var rating: some View {
        HStack(spacing: 4) {
            PipelineLevelBadge(letter: "risk", level: item.rating?.risk)
            PipelineLevelBadge(letter: "complexity", level: item.rating?.complexity)
            Text(PipelineTint.ratedBy(item)).font(.system(size: 10)).foregroundStyle(.secondary)
        }
        if let why = item.why, !why.isEmpty {
            Text(why).font(.system(size: 10.5)).italic()
                .fixedSize(horizontal: false, vertical: true)
        }
        if let floor = item.floor {
            HStack(spacing: 4) {
                Text("diff floor").font(.system(size: 10)).foregroundStyle(.secondary)
                PipelineLevelBadge(letter: "R", level: floor.risk)
                PipelineLevelBadge(letter: "C", level: floor.complexity)
            }
        }
    }

    private func open() {
        if let url = URL(string: item.id) { NSWorkspace.shared.open(url) }
    }

    private func headLine(_ head: String) -> String {
        let short = String(head.prefix(7))
        guard let clean = item.cleanAt else { return "head \(short) · no clean marker" }
        return clean == head ? "head \(short) · clean at it"
            : "head \(short) · clean at \(clean.prefix(7)), an older head"
    }

    private var actions: some View {
        VStack(alignment: .leading, spacing: 4) {
            FlowLayout(spacing: 4) {
                PipelineActionChip(symbol: "arrow.up.right.square", text: "Open", tint: .accentColor,
                                   action: open)
                if canRate {
                    PipelineActionChip(symbol: "gauge.with.needle",
                                       text: forcedRate ? "Rate asked" : "Rate now",
                                       tint: .accentColor, enabled: enabled && !forcedRate, action: rate)
                        .tooltip("Rate it in a sync started now, ahead of every limit")
                }
                if canFracture {
                    PipelineActionChip(symbol: "square.split.2x2",
                                       text: forcedFracture ? "Fracture asked" : "Fracture",
                                       tint: .purple, enabled: enabled && !forcedFracture, action: fracture)
                        .tooltip("Split it into low-complexity child issues in a sync started now")
                }
                if PipelineView.canStartFix(item) {
                    PipelineActionChip(symbol: "wrench.and.screwdriver", text: "Start fix",
                                       tint: .green, enabled: enabled && canStartFix && badge == nil,
                                       action: startFix)
                        .tooltip(canStartFix ? "Queue its fix now, past its retry backoff" : fixUnknown)
                }
            }
            if let error {
                Text(error).font(.system(size: 10)).foregroundStyle(.red)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    @ViewBuilder
    private var traversal: some View {
        if events.isEmpty {
            Text("Nothing logged for it yet.").font(.system(size: 10)).foregroundStyle(.secondary)
        }
        ForEach(Array(events.prefix(PipelineDetail.eventsShown).enumerated()), id: \.offset) { _, event in
            HStack(alignment: .firstTextBaseline, spacing: 5) {
                Text(PipelineTint.ago(event.at)).font(.system(size: 9).monospacedDigit())
                    .foregroundStyle(.secondary)
                    .frame(width: 26, alignment: .trailing)
                Text(event.kind.rawValue).font(.system(size: 8.5, weight: .bold))
                    .foregroundStyle(PipelineTint.event(event.kind))
                    .padding(.horizontal, 4).padding(.vertical, 1)
                    .background(RoundedRectangle(cornerRadius: 3)
                        .fill(PipelineTint.event(event.kind).opacity(0.14)))
                    .fixedSize()
                Text(event.detail).font(.system(size: 10.5))
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .tooltip(event.at.formatted(date: .abbreviated, time: .shortened))
        }
        if events.count > PipelineDetail.eventsShown {
            Text("\(events.count - PipelineDetail.eventsShown) older in ~/.diplomat/pipeline/log.jsonl")
                .font(.system(size: 9.5)).foregroundStyle(.secondary)
        }
    }

    private static let eventsShown = 14
}

// MARK: - Small pieces

private struct PipelineLevelBadge: View {
    let letter: String
    let level: PipelineLevel?

    var body: some View {
        let tint = PipelineTint.level(level)
        return Text("\(letter) \(level.map(PipelineTint.word) ?? "?")")
            .font(.system(size: 8.5, weight: .bold))
            .foregroundStyle(tint)
            .lineLimit(1)
            .padding(.horizontal, 4).padding(.vertical, 1)
            .background(RoundedRectangle(cornerRadius: 3).fill(tint.opacity(0.15)))
            .fixedSize()
    }
}

private struct PipelineStageChip: View {
    let stage: PipelineStage

    var body: some View {
        let tint = PipelineTint.stage(stage)
        return Text(stage.rawValue).font(.system(size: 8.5, weight: .bold))
            .foregroundStyle(tint)
            .lineLimit(1)
            .padding(.horizontal, 5).padding(.vertical, 1)
            .background(Capsule().fill(tint.opacity(0.15)))
            .fixedSize()
    }
}

private struct PipelineQueueBadge: View {
    let badge: Store.PipelineBadge

    var body: some View {
        let agent = badge == .agent
        let tint: Color = agent ? .blue : .orange
        return HStack(spacing: 2) {
            Image(systemName: agent ? "cpu" : "clock").font(.system(size: 7.5, weight: .bold))
            Text(agent ? "agent" : "queued").font(.system(size: 8.5, weight: .bold))
        }
        .foregroundStyle(tint)
        .padding(.horizontal, 4).padding(.vertical, 1)
        .background(Capsule().fill(tint.opacity(0.16)))
        .fixedSize()
    }
}

private struct PipelineLaneChip: View {
    let text: String
    let count: Int
    let tint: Color
    let on: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 4) {
                Text(text).font(.system(size: 10, weight: .semibold))
                Text("\(count)").font(.system(size: 9).monospacedDigit())
                    .padding(.horizontal, 4).padding(.vertical, 0.5)
                    .background(Capsule().fill(tint.opacity(on ? 0.25 : 0.12)))
            }
            .foregroundStyle(on ? tint : Color.secondary)
            .padding(.horizontal, 7).padding(.vertical, 3)
            .background(Capsule().fill(tint.opacity(on ? 0.16 : 0.06)))
            .overlay(Capsule().stroke(tint.opacity(on ? 0.6 : 0.2), lineWidth: 1))
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .fixedSize()
    }
}

/// A small button drawn by SwiftUI alone, so a headless `ImageRenderer` snapshot shows it.
private struct PipelineActionChip: View {
    let symbol: String?
    let text: String
    let tint: Color
    var enabled = true
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 3) {
                if let symbol { Image(systemName: symbol).font(.system(size: 9, weight: .semibold)) }
                Text(text).font(.system(size: 10, weight: .semibold))
            }
            .foregroundStyle(tint)
            .padding(.horizontal, 6).padding(.vertical, 2.5)
            .background(RoundedRectangle(cornerRadius: 5).fill(tint.opacity(0.12)))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
        .opacity(enabled ? 1 : 0.45)
        .fixedSize()
    }
}

private struct PipelineCountPill: View {
    let count: Int

    var body: some View {
        Text("\(count)").font(.system(size: 9).monospacedDigit())
            .foregroundStyle(.secondary)
            .padding(.horizontal, 5).padding(.vertical, 1)
            .background(Capsule().fill(Color.gray.opacity(0.15)))
    }
}

// MARK: - Colours and words

enum PipelineTint {
    static func level(_ l: PipelineLevel?) -> Color {
        switch l {
        case .low: return .green
        case .medium: return .orange
        case .high: return .red
        case nil: return .secondary
        }
    }

    static func word(_ l: PipelineLevel) -> String {
        switch l {
        case .low: return "low"
        case .medium: return "med"
        case .high: return "high"
        }
    }

    static func stage(_ s: PipelineStage) -> Color {
        switch s {
        case .unrated: return .secondary
        case .human: return .blue
        case .candidate, .fastTrack: return .green
        case .fractured: return .purple
        case .fixing: return .teal
        case .clean: return .mint
        case .cleared: return .indigo
        case .merged: return .purple
        case .closed: return .secondary
        }
    }

    static func lane(_ l: PipelineLane) -> Color {
        switch l {
        case .unrated: return .gray
        case .fast: return .green
        case .human: return .blue
        case .fractured: return .purple
        case .done: return .gray
        }
    }

    static func word(_ l: PipelineLane) -> String {
        switch l {
        case .unrated: return "Unrated"
        case .fast: return "Fast"
        case .human: return "Human"
        case .fractured: return "Fractured"
        case .done: return "Done"
        }
    }

    static func edge(_ k: PipelineGraph.EdgeKind) -> Color {
        switch k {
        case .fixes: return Color.primary.opacity(0.5)
        case .child: return Color.purple.opacity(0.75)
        case .stacked: return Color.orange.opacity(0.85)
        }
    }

    static func stroke(_ k: PipelineGraph.EdgeKind) -> StrokeStyle {
        switch k {
        case .fixes: return StrokeStyle(lineWidth: 1.4, lineCap: .round)
        case .child: return StrokeStyle(lineWidth: 1.3, lineCap: .butt, dash: [5, 3])
        case .stacked: return StrokeStyle(lineWidth: 1.7, lineCap: .round, dash: [0.1, 3.5])
        }
    }

    static func word(_ k: PipelineGraph.EdgeKind) -> String {
        switch k {
        case .fixes: return "fixes"
        case .child: return "child"
        case .stacked: return "stacked"
        }
    }

    static func event(_ k: PipelineEvent.Kind) -> Color {
        switch k {
        case .rated, .rerated, .labelled: return .blue
        case .fastTrack, .clean: return .green
        case .cleared: return .indigo
        case .merged, .fractured, .child: return .purple
        case .held: return .orange
        case .asked: return .teal
        case .error: return .red
        }
    }

    static func source(_ s: PipelineSource) -> Color {
        s == .linear ? .indigo : .primary
    }

    /// A GitHub issue's or PR's glyph; a Linear issue's letter.
    static func glyph(_ item: PipelineItem) -> String {
        if item.source == .linear { return "l.square.fill" }
        return item.kind == .pr ? "arrow.triangle.pull" : "smallcircle.filled.circle"
    }

    static func ratedBy(_ item: PipelineItem) -> String {
        switch item.ratedBy {
        case "label": return "from its labels"
        case "local": return "rated here, not labelled"
        case nil: return "unrated"
        case let other?: return other
        }
    }

    static func access(_ item: PipelineItem) -> String {
        guard item.writable else { return "Read only: Diplomat shows it and writes nothing to it." }
        return item.kind == .pr ? "Your PR: Diplomat labels it, reviews it and may merge it."
            : "Diplomat labels it and may fix or split it."
    }

    /// `By @bob · assigned to @carol`, a Linear name as it is. Twin of `pipelineview`'s WHO
    /// people line.
    static func people(_ item: PipelineItem) -> String {
        func who(_ name: String) -> String { item.source == .linear ? name : "@\(name)" }
        var parts = item.author.flatMap { $0.isEmpty ? nil : ["by \(who($0))"] } ?? []
        parts.append(item.assignees.isEmpty ? "unassigned"
                     : "assigned to " + item.assignees.map(who).joined(separator: ", "))
        let text = parts.joined(separator: " · ")
        return text.prefix(1).uppercased() + text.dropFirst()
    }

    static func hover(_ item: PipelineItem) -> String {
        let source = item.source == .linear ? "Linear issue" : (item.kind == .pr ? "GitHub PR" : "GitHub issue")
        return ([item.title, "\(source) · \(item.stage.rawValue) · \(word(item.lane).lowercased()) lane",
                 item.hold.map(held), item.id] as [String?]).compactMap { $0 }.joined(separator: "\n")
    }

    /// A hold as the card's tooltip and the detail pane say it, as on Linux.
    static func held(_ hold: String) -> String { "Held: \(hold)" }

    /// The time today; with its date on any other day.
    static func syncTime(_ date: Date, now: Date = Date()) -> String {
        guard !Calendar.current.isDate(date, inSameDayAs: now) else { return Fmt.clock(date) }
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "MMM dd HH:mm"
        return f.string(from: date)
    }

    /// `now`, `12m`, `5h`, `3d`.
    static func ago(_ date: Date, now: Date = Date()) -> String {
        now.timeIntervalSince(date) < 60 ? "now" : Fmt.age(date, now: now)
    }
}
