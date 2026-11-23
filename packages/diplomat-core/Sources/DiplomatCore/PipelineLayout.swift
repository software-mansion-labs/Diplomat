import Foundation

extension PipelineGraph {
    /// `items` on the grid, and in the order the grid reads: groups one below another,
    /// each top to bottom, left to right.
    ///
    /// A group is the items one chain of `edges` connects. Within it an item's column is
    /// its longest path from the group's sources; its row comes from a walk down from the
    /// sources, newest first, that puts an item's first child not yet placed on its own row
    /// and each further one on a new row below everything placed so far, so a child sits
    /// at the row of the parent it was reached from or below it. An edge closing a cycle is
    /// left out of both. Groups holding an unrated or fast-track item come first, then
    /// those with nothing left but merged or closed ones last; within each, newest
    /// `updatedAt` first. Whole groups are kept while they fit in `maxItems`; a first group
    /// larger than that keeps its top rows. Equal input lays out the same.
    public static func layout(items: [PipelineItem], edges: [Edge], maxItems: Int = 300)
        -> (items: [PipelineItem], graph: PipelineGraph) {
        var byID: [String: PipelineItem] = [:]
        var ids: [String] = []
        for item in items where byID[item.id] == nil {
            byID[item.id] = item
            ids.append(item.id)
        }
        var seen = Set<String>()
        let edges = edges.filter {
            byID[$0.from] != nil && byID[$0.to] != nil && $0.from != $0.to
                && seen.insert($0.from + "\u{0}" + $0.to).inserted
        }
        func newer(_ a: String, _ b: String) -> Bool {
            let x = byID[a]?.updatedAt ?? .distantPast, y = byID[b]?.updatedAt ?? .distantPast
            return x != y ? x > y : a < b
        }

        var parent = Dictionary(uniqueKeysWithValues: ids.map { ($0, $0) })
        func find(_ x: String) -> String {
            var r = x
            while let p = parent[r], p != r { r = p }
            return r
        }
        var out: [String: [String]] = [:]
        var incoming: [String: [String]] = [:]
        for e in edges {
            out[e.from, default: []].append(e.to)
            incoming[e.to, default: []].append(e.from)
            let a = find(e.from), b = find(e.to)
            if a != b { parent[max(a, b)] = min(a, b) }
        }
        for k in out.keys { out[k]?.sort(by: newer) }
        var members: [String: [String]] = [:]
        for id in ids { members[find(id), default: []].append(id) }

        struct Group {
            var ids: [String]
            var cell: [String: (row: Int, column: Int)]
            var tier: Int
            var newest: Date
        }
        var groups: [Group] = members.values.map { list in
            let list = list.sorted(by: newer)
            let starts = list.filter { (incoming[$0] ?? []).isEmpty } + list
            var state: [String: Bool] = [:]  // false while on the walk, true once done
            var back = Set<String>()
            var finished: [String] = []
            func visit(_ n: String) {
                state[n] = false
                for c in out[n] ?? [] {
                    switch state[c] {
                    case false?: back.insert(n + "\u{0}" + c)
                    case nil: visit(c)
                    default: break
                    }
                }
                state[n] = true
                finished.append(n)
            }
            for s in starts where state[s] == nil { visit(s) }
            func forward(_ a: String, _ b: String) -> Bool { !back.contains(a + "\u{0}" + b) }

            var column: [String: Int] = [:]
            for n in finished.reversed() {
                column[n] = (incoming[n] ?? []).filter { forward($0, n) }
                    .compactMap { column[$0].map { $0 + 1 } }.max() ?? 0
            }
            var row: [String: Int] = [:]
            var next = 0
            func place(_ n: String, _ r: Int) {
                row[n] = r
                next = max(next, r + 1)
                var at = r
                for c in out[n] ?? [] where row[c] == nil && forward(n, c) {
                    place(c, at)
                    at = next
                }
            }
            for s in starts where row[s] == nil { place(s, next) }

            // No two share a cell: a row holds one chain of forward edges, along which the
            // column only grows.
            var cell: [String: (row: Int, column: Int)] = [:]
            for n in list { cell[n] = (row[n] ?? 0, column[n] ?? 0) }
            let lanes = Set(list.compactMap { byID[$0]?.lane })
            let tier = !lanes.isDisjoint(with: [.unrated, .fast]) ? 0 : lanes == [.done] ? 2 : 1
            return Group(ids: list, cell: cell, tier: tier,
                         newest: list.compactMap { byID[$0]?.updatedAt }.max() ?? .distantPast)
        }
        groups.sort {
            ($0.tier, $1.newest, $0.ids.min() ?? "") < ($1.tier, $0.newest, $1.ids.min() ?? "")
        }

        var nodes: [Node] = []
        var kept: [PipelineItem] = []
        var top = 0
        for g in groups {
            var take = g.ids.sorted {
                let a = g.cell[$0]!, b = g.cell[$1]!
                return (a.row, a.column, $0) < (b.row, b.column, $1)
            }
            if kept.count + take.count > maxItems {
                guard kept.isEmpty else { break }
                take = Array(take.prefix(maxItems))
            }
            for id in take {
                let c = g.cell[id]!
                nodes.append(Node(id: id, column: c.column, row: top + c.row))
                kept.append(byID[id]!)
            }
            top += (take.compactMap { g.cell[$0]?.row }.max() ?? -1) + 1
        }
        let shown = Set(kept.map(\.id))
        return (kept, PipelineGraph(nodes: nodes,
                                    edges: edges.filter { shown.contains($0.from) && shown.contains($0.to) }))
    }
}
