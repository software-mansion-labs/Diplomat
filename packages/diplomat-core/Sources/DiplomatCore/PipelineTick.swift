import Foundation

/// What a sync reaches outside the process: `gh`, `claude`, Linear's HTTP API and the
/// Linear key. `live` is the real one; tests hand in stubs.
public struct PipelineIO {
    /// How one `gh` or `claude` call exited and what it printed. A call that could not
    /// start, or did not finish in time, is status -1 with the reason as `stderr`.
    public struct Exit: Equatable, Sendable {
        public var status: Int32
        public var stdout: Data
        public var stderr: String

        public init(status: Int32, stdout: Data = Data(), stderr: String = "") {
            self.status = status
            self.stdout = stdout
            self.stderr = stderr
        }

        public var ok: Bool { status == 0 }

        /// One line saying why it failed.
        var why: String {
            let tail = stderr.trimmingCharacters(in: .whitespacesAndNewlines)
            return tail.isEmpty ? "exited \(status)" : String(CommsText.oneLine(tail).suffix(200))
        }
    }

    /// Why a step did not happen, one line.
    struct Failure: Error, Equatable {
        let message: String
        init(_ message: String) { self.message = message }
    }

    public var gh: ([String]) -> Exit
    /// `arguments`, `input` on stdin, run in `cwd` for at most `timeout`.
    public var claude: (_ arguments: [String], _ input: Data, _ cwd: String, _ timeout: TimeInterval) -> Exit
    public var linear: SlackAPI.Transport
    public var linearKey: (PipelineSettings) -> String?

    public init(gh: @escaping ([String]) -> Exit,
                claude: @escaping ([String], Data, String, TimeInterval) -> Exit,
                linear: @escaping SlackAPI.Transport,
                linearKey: @escaping (PipelineSettings) -> String?) {
        self.gh = gh
        self.claude = claude
        self.linear = linear
        self.linearKey = linearKey
    }

    /// `gh` as `GH` finds it (`DIPLOMAT_GH` overrides), bounded by `GH.timeout`; `claude`
    /// as `CommsClassifier.binary` finds it (`DIPLOMAT_CLAUDE`); Linear through
    /// `SlackAPI.curl`; the key from `LinearAPI.key`. Each child gets
    /// `CommsClassifier.childEnvironment`, which holds no token.
    public static var live: PipelineIO {
        func exit(_ outcome: CommsClassifier.Outcome, _ name: String, _ timeout: TimeInterval) -> Exit {
            switch outcome {
            case .failedToStart(let why):
                return Exit(status: -1, stderr: "\(name) could not be started: \(why)")
            case .timedOut:
                return Exit(status: -1, stderr: "\(name) did not answer within \(Int(timeout))s")
            case .exited(let code, let out, let err):
                return Exit(status: code, stdout: out, stderr: String(decoding: err, as: UTF8.self))
            }
        }
        return PipelineIO(
            gh: { args in
                let path: String
                do { path = try GH.ghPath() } catch {
                    return Exit(status: -1, stderr: error.localizedDescription)
                }
                var env = CommsClassifier.childEnvironment
                let extra = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
                env["PATH"] = env["PATH"].map { "\($0):\(extra)" } ?? extra
                return exit(CommsClassifier.execute(path, args, input: Data(), timeout: GH.timeout,
                                                    environment: env), "gh", GH.timeout)
            },
            claude: { args, input, cwd, timeout in
                guard let exe = CommsClassifier.binary() else {
                    return Exit(status: -1, stderr: "the claude CLI was not found (set DIPLOMAT_CLAUDE to its path)")
                }
                return exit(CommsClassifier.execute(exe, args, input: input, timeout: timeout, cwd: cwd),
                            "claude", timeout)
            },
            linear: SlackAPI.curl,
            linearKey: { LinearAPI.key(keychainItem: $0.linearKeychainItem, tokenFile: $0.linearTokenFile) })
    }
}

public enum PipelineTick {
    /// One sync. Reads every root's open issues and PRs and every tracked Linear team's
    /// open issues; with `rate` (or forced) rates up to `rater.perSync` unrated ones,
    /// forced first, then clean PRs awaiting their second rating, the operator's unrated
    /// PRs, writable issues, other issues, newest first; writes each rating as labels
    /// where Diplomat may, never lower than the labels or the diff's floor, and caches the
    /// rest; with `fastTrack` labels a low/low PR of the operator's `fastTrack` once,
    /// takes `cleared` off one whose head moved past its clean marker, and asks for a
    /// review of each fast-track head no marker names; with `merge` merges a cleared PR
    /// no merge hold stops; with `fracture` (or forced) splits one writable
    /// medium/high-complexity issue that is not high risk into children; with `fix` asks
    /// for a fix PR for each candidate issue. Every step it takes, and each hold, notice
    /// and request the first time it is seen, is logged to `dir`; the result is saved as
    /// `last.json`.
    ///
    /// A read that fails is a notice, and the rest of the sync goes on without it; a root
    /// read only in part merges nothing, and a Linear issue whose root went unread is
    /// neither split nor fixed. One sync runs at a time per `dir`: another started
    /// meanwhile reads nothing and answers the last result with a notice.
    public static func run(settings: PipelineSettings, now: Date = Date(),
                           dir: URL = PipelineLog.dir, io: PipelineIO = .live) -> PipelineTickResult {
        PrivateFiles.prepare(dir)
        if let result = PrivateFiles.locked(dir.appendingPathComponent("tick.lock"), wait: false, {
            PipelineSync(settings: settings, now: now, dir: dir, io: io).run()
        }) {
            return result
        }
        var last = PipelineLog.last(in: dir) ?? PipelineTickResult(at: now)
        last.notices.append("another sync held \(dir.path)/tick.lock, so this one read nothing")
        return last
    }
}

/// One sync's working state; see `PipelineTick.run`.
final class PipelineSync {
    let settings: PipelineSettings
    let now: Date
    let dir: URL
    let io: PipelineIO
    var model: CoreAssets.PipelineModel!
    var state: PipelineState
    var cache: [String: PipelineCachedRating]
    var entries: [PipelineEntry] = []
    var pos: [String: Int] = [:]
    var repos: [String: PipelineRepo] = [:]
    var edges: [PipelineGraph.Edge] = []
    var events: [PipelineEvent] = []
    var notices: [String] = []
    /// Every source was read; only then does an item gone from the read take its state.
    var readAll = true
    /// The roots whose read failed: a Linear issue whose code is there cannot be seen to
    /// have a fix PR.
    var unread: Set<String> = []
    /// The roots read with errors, whose cleared PRs are not merged.
    var partial: Set<String> = []
    var linear: LinearAPI?
    /// Linear labels by lowercased name, each with its team (nil for a workspace label).
    var linearLabels: [String: [(id: String, team: String?)]] = [:]
    var floorWhy: [String: [String]] = [:]

    init(settings: PipelineSettings, now: Date, dir: URL, io: PipelineIO) {
        self.settings = settings
        self.now = now
        self.dir = dir
        self.io = io
        state = PipelineState.load(in: dir)
        cache = PipelineCachedRating.load(in: dir)
    }

    func run() -> PipelineTickResult {
        guard let model = try? CoreAssets.pipeline() else {
            return PipelineTickResult(at: now, notices: ["assets/pipeline.json could not be read"])
        }
        self.model = model
        readGitHub()
        readLinear()
        var unique: [PipelineEntry] = []
        for e in entries where pos[e.id] == nil {
            pos[e.id] = unique.count
            unique.append(e)
        }
        entries = unique
        edges = PipelineRead.edges(entries)
        annotate()
        if settings.fastTrack { dropStaleClears() }
        rate()
        if settings.fastTrack { putOnFastTrack() }
        fracture()
        settle()
        if settings.merge { merge() }
        let effects = owed()

        for n in notices where !state.notices.contains(n) { log("", .error, n) }
        state.notices = notices
        if readAll {
            let ids = Set(entries.map(\.id))
            state.keep(only: ids)
            cache = cache.filter { ids.contains($0.key) }
        }
        PipelineLog.append(events, in: dir)
        state.save(in: dir)
        PipelineCachedRating.save(cache, in: dir)
        let laid = PipelineGraph.layout(items: entries.map(\.item), edges: edges, maxItems: model.maxItems)
        let result = PipelineTickResult(at: now, items: laid.items, graph: laid.graph, effects: effects,
                                        events: Array(PipelineLog.read(in: dir).suffix(model.maxEvents)),
                                        notices: notices)
        PipelineLog.writeLast(result, in: dir)
        return result
    }

    // MARK: - Reading

    func readGitHub() {
        let query: String
        do { query = try CoreAssets.graphql("pipeline-repo") } catch {
            notice(error.localizedDescription)
            readAll = false
            return
        }
        for (n, root) in settings.roots.enumerated() {
            let args = ["api", "graphql", "-f", "query=\(query)", "-f", "owner=\(root.owner)",
                        "-f", "name=\(root.repo)"]
            // Read only, so a failure is tried once more: GitHub times the heavy queries
            // out now and then.
            var out = io.gh(args)
            if !out.ok {
                Thread.sleep(forTimeInterval: 0.8)
                out = io.gh(args)
            }
            let response = (try? JSONSerialization.jsonObject(with: out.stdout)) as? [String: Any]
            let errors = (response?["errors"] as? [[String: Any]] ?? []).compactMap { $0["message"] as? String }
            guard let response, (response["data"] as? [String: Any])?["repository"] is [String: Any] else {
                notice("\(root.slug) could not be read: "
                       + (errors.isEmpty ? out.why : errors.joined(separator: "; ")))
                readAll = false
                unread.insert(root.slug)
                continue
            }
            if !errors.isEmpty {
                notice("\(root.slug) was read in part: \(errors.joined(separator: "; "))")
                readAll = false
                partial.insert(root.slug)
            }
            let (repo, read) = PipelineRead.github(response, root: root, primary: n == 0, model: model)
            repos[root.slug] = repo
            entries += read
        }
    }

    func readLinear() {
        let teams = settings.linearTeams
        guard !teams.isEmpty else { return }
        guard let key = io.linearKey(settings) else {
            notice("Linear was not read: no API key (\(LinearAPI.envVar), "
                   + (settings.linearKeychainItem.map { "the Keychain item \($0)" }
                      ?? settings.linearTokenFile.map { "the file \($0)" } ?? "none set") + ")")
            readAll = false
            return
        }
        let env = ProcessInfo.processInfo.environment["DIPLOMAT_LINEAR_API"] ?? ""
        guard let url = URL(string: env.isEmpty ? model.linearAPI : env) else {
            notice("Linear was not read: \(env) is not a URL")
            readAll = false
            return
        }
        let api = LinearAPI(key: key, url: url, timeout: model.httpTimeoutSecs, transport: io.linear)
        linear = api
        var after: String?
        var read = 0
        do {
            repeat {
                let data = try api.call("Issues", ["teams": teams.map(\.key), "after": after ?? NSNull()])
                let viewer = (data["viewer"] as? [String: Any])?["id"] as? String ?? ""
                let page = PipelineRead.linear(data, viewer: viewer, teams: teams, roots: settings.roots)
                entries += page.entries
                read += page.entries.count
                after = page.next
            } while after != nil && read < model.linearMaxIssues
        } catch {
            notice(error.localizedDescription)
            readAll = false
            return
        }
        if after != nil {
            notice("Linear holds more open issues than one sync reads; the newest \(read) were read")
        }
    }

    /// Ratings off the labels, else the cache; each open PR's floor and clean marker.
    func annotate() {
        for i in entries.indices {
            var e = entries[i]
            if let r = labelRating(e.labels) {
                e.item.rating = r
                e.item.ratedBy = "label"
                if let c = cache[e.id], c.rating == r { e.item.why = c.why }
            } else if !e.item.writable, let c = cache[e.id], c.updatedAt == e.item.updatedAt {
                e.item.rating = c.rating
                e.item.ratedBy = "local"
                e.item.why = c.why
            }
            if e.item.kind == .pr, open(e) {
                let floor = PipelineGate.floorWithReasons(files: e.files, changedFiles: e.changedFiles)
                e.item.floor = floor.rating
                floorWhy[e.id] = floor.reasons
                let head = e.item.headSha ?? ""
                e.item.cleanAt = e.markers.contains(head) ? head : e.markers.last
            }
            entries[i] = e
        }
    }

    // MARK: - Labels

    /// Each dimension's level, the higher of two labels; nil where it has none.
    func levels(_ labels: [String]) -> (risk: PipelineLevel?, complexity: PipelineLevel?) {
        let have = Set(labels.map { $0.lowercased() })
        func top(_ names: CoreAssets.PipelineModel.PerLevel) -> PipelineLevel? {
            PipelineLevel.allCases.filter { have.contains(names[$0].lowercased()) }.max()
        }
        return (top(model.labels.risk), top(model.labels.complexity))
    }

    func labelRating(_ labels: [String]) -> PipelineRating? {
        let l = levels(labels)
        guard let risk = l.risk, let complexity = l.complexity else { return nil }
        return PipelineRating(risk: risk, complexity: complexity)
    }

    func has(_ e: PipelineEntry, _ label: String) -> Bool {
        e.labels.contains { $0.lowercased() == label.lowercased() }
    }

    /// Adds `name` to a writable item; false (with a notice) when it could not.
    @discardableResult
    func add(_ i: Int, _ name: String) -> Bool {
        let e = entries[i]
        guard e.item.writable else { return false }
        if has(e, name) { return true }
        switch e.item.source {
        case .github:
            guard let root = e.root, let n = e.number, ensureLabel(root.slug, name) else { return false }
            let out = io.gh(["api", "-X", "POST", "repos/\(root.slug)/issues/\(n)/labels", "-f", "labels[]=\(name)"])
            guard out.ok else {
                notice("\(e.item.label): could not add \(name): \(out.why)")
                return false
            }
        case .linear:
            guard let api = linear, let id = e.nodeID, let label = linearLabel(name, team: e.teamID) else {
                return false
            }
            do { _ = try api.call("AddLabel", ["id": id, "labelId": label]) } catch {
                notice("\(e.item.label): could not add \(name): \(error.localizedDescription)")
                return false
            }
            entries[i].labelIDs[name] = label
        }
        entries[i].labels.append(name)
        return true
    }

    /// Takes `name` off a writable item; false (with a notice) when it could not.
    @discardableResult
    func remove(_ i: Int, _ name: String) -> Bool {
        let e = entries[i]
        guard e.item.writable else { return false }
        guard let actual = e.labels.first(where: { $0.lowercased() == name.lowercased() }) else { return true }
        switch e.item.source {
        case .github:
            guard let root = e.root, let n = e.number else { return false }
            let path = actual.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? actual
            let out = io.gh(["api", "-X", "DELETE", "repos/\(root.slug)/issues/\(n)/labels/\(path)"])
            // Already off is off.
            guard out.ok || out.stderr.contains("HTTP 404") else {
                notice("\(e.item.label): could not remove \(actual): \(out.why)")
                return false
            }
        case .linear:
            guard let api = linear, let id = e.nodeID, let label = e.labelIDs[actual] else { return false }
            do { _ = try api.call("RemoveLabel", ["id": id, "labelId": label]) } catch {
                notice("\(e.item.label): could not remove \(actual): \(error.localizedDescription)")
                return false
            }
        }
        entries[i].labels.removeAll { $0.lowercased() == name.lowercased() }
        return true
    }

    /// Makes `name` exist in `slug` before an item is given it, once per repository.
    func ensureLabel(_ slug: String, _ name: String) -> Bool {
        if state.labelsMade[slug, default: []].contains(name) { return true }
        let seen = entries.contains { $0.item.source == .github && $0.item.repo == slug && has($0, name) }
        if !seen {
            let out = io.gh(["api", "-X", "POST", "repos/\(slug)/labels", "-f", "name=\(name)",
                             "-f", "color=\(model.labels.color)"])
            // 422: it exists already.
            guard out.ok || out.stderr.contains("HTTP 422") else {
                notice("\(slug): could not create the label \(name): \(out.why)")
                return false
            }
        }
        state.labelsMade[slug, default: []].append(name)
        return true
    }

    /// The id of the Linear label `name` an issue of `team` may carry: the team's own,
    /// else the workspace's, made when there is neither.
    func linearLabel(_ name: String, team: String?) -> String? {
        guard let api = linear else { return nil }
        let key = name.lowercased()
        func pick() -> String? {
            let known = linearLabels[key] ?? []
            return (known.first { $0.team != nil && $0.team == team } ?? known.first { $0.team == nil })?.id
        }
        do {
            if linearLabels[key] == nil {
                let data = try api.call("Labels", ["names": [name]])
                let found = ((data["issueLabels"] as? [String: Any])?["nodes"] as? [[String: Any]] ?? [])
                    .compactMap { l -> (id: String, team: String?)? in
                        guard let id = l["id"] as? String else { return nil }
                        return (id, (l["team"] as? [String: Any])?["id"] as? String)
                    }
                linearLabels[key] = found
            }
            if let id = pick() { return id }
            let data = try api.call("LabelCreate", ["name": name, "color": "#" + model.labels.color])
            guard let id = ((data["issueLabelCreate"] as? [String: Any])?["issueLabel"] as? [String: Any])?["id"]
                as? String else { throw LinearAPI.Failure.api("issueLabelCreate answered no label") }
            linearLabels[key, default: []].append((id, nil))
            return id
        } catch {
            notice("Linear: could not find or make the label \(name): \(error.localizedDescription)")
            return nil
        }
    }

    /// `rating` as the item's rating labels, a dimension at a time: the label it wants
    /// added, then any other of that dimension taken off.
    @discardableResult
    func writeRating(_ i: Int, _ rating: PipelineRating) -> Bool {
        var changes: [String] = []
        var ok = true
        for (names, level) in [(model.labels.risk, rating.risk), (model.labels.complexity, rating.complexity)] {
            let want = names[level]
            let all = Set(PipelineLevel.allCases.map { names[$0].lowercased() })
            let have = entries[i].labels.filter { all.contains($0.lowercased()) }
            if have.map({ $0.lowercased() }) == [want.lowercased()] { continue }
            if !has(entries[i], want) {
                guard add(i, want) else {
                    ok = false
                    continue
                }
                changes.append("+" + want)
            }
            for old in have where old.lowercased() != want.lowercased() {
                if remove(i, old) { changes.append("-" + old) } else { ok = false }
            }
        }
        if !changes.isEmpty { log(entries[i].id, .labelled, changes.joined(separator: " ")) }
        return ok
    }

    // MARK: - Rating

    func own(_ e: PipelineEntry) -> Bool {
        guard e.item.kind == .pr, let me = e.root?.me.lowercased(), !me.isEmpty else { return false }
        return e.item.author?.lowercased() == me
    }

    func open(_ e: PipelineEntry) -> Bool { e.item.state == "open" || e.item.state == "draft" }

    /// The open PRs fixing an issue.
    func fixers(_ e: PipelineEntry) -> [Int] {
        edges.filter { $0.from == e.id && $0.kind == .fixes }
            .compactMap { pos[$0.to] }.filter { open(entries[$0]) }
    }

    /// An issue already split, or already being fixed: a rating would route it nowhere.
    func settled(_ e: PipelineEntry) -> Bool {
        has(e, model.labels.fractured) || !e.children.isEmpty || !fixers(e).isEmpty
    }

    /// A fast-track PR with a clean marker at its head and no `cleared` yet.
    func awaitingRerate(_ e: PipelineEntry) -> Bool {
        own(e) && open(e) && e.item.writable && has(e, model.labels.fastTrack)
            && !has(e, model.labels.cleared) && e.item.cleanAt != nil && e.item.cleanAt == e.item.headSha
    }

    func newer(_ a: Int, _ b: Int) -> Bool {
        let x = entries[a].item.updatedAt ?? .distantPast, y = entries[b].item.updatedAt ?? .distantPast
        return x != y ? x > y : entries[a].id < entries[b].id
    }

    func rate() {
        var forced: [Int] = []
        for id in settings.force?.rate ?? [] {
            guard let i = pos[id] else {
                notice("\(id) was not read, so it was not rated")
                continue
            }
            let e = entries[i]
            if e.item.kind == .pr && !(own(e) && open(e)) {
                notice("\(e.item.label) was not rated: only my own open PRs are")
            } else if e.root == nil {
                notice("\(e.item.label) was not rated: Linear team \(e.item.repo) has no root to read its code in")
            } else if !forced.contains(i) {
                forced.append(i)
            }
        }
        var bands: [[Int]] = []
        if settings.rate {
            let idx = Array(entries.indices)
            bands = [
                settings.fastTrack ? idx.filter { awaitingRerate(entries[$0]) } : [],
                idx.filter { own(entries[$0]) && open(entries[$0]) && entries[$0].item.rating == nil },
                idx.filter {
                    let e = entries[$0]
                    return e.item.kind == .issue && e.item.writable && e.item.rating == nil
                        && e.root != nil && !settled(e)
                },
                idx.filter {
                    let e = entries[$0]
                    return e.item.kind == .issue && !e.item.writable && e.item.rating == nil
                        && e.root != nil && !settled(e)
                },
            ].map { $0.sorted(by: newer) }
        }
        let rest = bands.joined().filter { !forced.contains($0) }.prefix(max(0, model.rater.perSync))
        for i in forced + rest { rateOne(i) }
    }

    func rateOne(_ i: Int) {
        let e = entries[i]
        guard let root = e.root else { return }
        let again = awaitingRerate(e)
        var diff: String?
        if e.item.kind == .pr, let n = e.number {
            let out = io.gh(["pr", "diff", "\(n)", "-R", root.slug])
            guard out.ok else {
                notice("\(e.item.label) was not rated: its diff could not be read: \(out.why)")
                return
            }
            diff = String(decoding: out.stdout, as: UTF8.self)
        }
        let name = e.item.kind == .pr ? model.rater.prModel : model.rater.model
        let out = io.claude(PipelineRater.arguments(model: name, schema: model.raterSchema,
                                                    prompt: PipelineRater.ratePrompt(e, model)),
                            Data(PipelineRater.input(e, diff: diff, model).utf8), root.path,
                            model.rater.timeoutSecs)
        let said: PipelineRating, why: String
        switch PipelineRater.rating(out) {
        case .failure(let f):
            notice("\(e.item.label) was not rated: \(f.message)")
            return
        case .success(let answer):
            (said, why) = answer
        }
        // Never lower than a label already on it, nor than its diff allows.
        let have = levels(e.labels)
        var rating = PipelineRating(risk: max(said.risk, have.risk ?? .low),
                                    complexity: max(said.complexity, have.complexity ?? .low))
        var detail = describe(rating) + (why.isEmpty ? "" : ": " + why)
        if let floor = e.item.floor, rating.atLeast(floor) != rating {
            rating = rating.atLeast(floor)
            detail = describe(rating) + ", floored by its diff ("
                + (floorWhy[e.id] ?? []).joined(separator: "; ") + ")" + (why.isEmpty ? "" : ": " + why)
        }
        log(e.id, again ? .rerated : .rated, detail)
        cache[e.id] = PipelineCachedRating(rating: rating, why: why, updatedAt: e.item.updatedAt)
        entries[i].item.why = why
        guard e.item.writable else {
            entries[i].item.rating = rating
            entries[i].item.ratedBy = "local"
            return
        }
        writeRating(i, rating)
        entries[i].item.rating = labelRating(entries[i].labels)
        entries[i].item.ratedBy = entries[i].item.rating == nil ? nil : "label"
        guard again, entries[i].item.rating == rating else { return }
        let head = String((e.item.headSha ?? "").prefix(7))
        if rating.isFastTrack {
            if add(i, model.labels.cleared) { log(e.id, .cleared, "cleared at \(head)") }
        } else if remove(i, model.labels.fastTrack) {
            log(e.id, .labelled, "-\(model.labels.fastTrack): rated \(describe(rating)) at \(head), for a human")
            if !state.decided.contains(e.id) { state.decided.append(e.id) }
        }
    }

    func describe(_ r: PipelineRating) -> String {
        "\(r.risk.rawValue) risk, \(r.complexity.rawValue) complexity"
    }

    // MARK: - Fast track

    /// A clean marker names an earlier head than `cleared` was given at: back to the fast
    /// track for a review of the new one.
    func dropStaleClears() {
        for i in entries.indices {
            let e = entries[i]
            guard own(e), open(e), has(e, model.labels.cleared), e.item.cleanAt != e.item.headSha else { continue }
            if remove(i, model.labels.cleared) {
                log(e.id, .labelled, "-\(model.labels.cleared): the head moved to "
                    + "\(String((e.item.headSha ?? "").prefix(7))), past its clean marker")
            }
        }
    }

    /// A low/low PR of mine, its diff's floor low/low too, labelled once: a person who
    /// takes the label off is not overruled.
    func putOnFastTrack() {
        for i in entries.indices {
            let e = entries[i]
            guard own(e), open(e), !has(e, model.labels.fastTrack), !has(e, model.labels.cleared),
                  !state.decided.contains(e.id),
                  let r = e.item.rating, r.atLeast(e.item.floor ?? r).isFastTrack else { continue }
            if add(i, model.labels.fastTrack) {
                log(e.id, .fastTrack, "+\(model.labels.fastTrack): rated \(describe(r))")
                state.decided.append(e.id)
            }
        }
    }

    // MARK: - Fracture

    func fracture() {
        var picks: [Int] = []
        for id in settings.force?.fracture ?? [] {
            guard let i = pos[id] else {
                notice("\(id) was not read, so it was not split")
                continue
            }
            let e = entries[i]
            if let why = fractureRefusal(e) {
                notice("\(e.item.label) was not split: \(why)")
            } else if !picks.contains(i) {
                picks.append(i)
            }
        }
        if settings.fracture {
            let auto = entries.indices.filter { i in
                let e = entries[i]
                guard !picks.contains(i), fractureRefusal(e) == nil, state.unsplit[e.id] == nil,
                      let r = e.item.rating else { return false }
                return r.complexity >= .medium && r.risk != .high
            }.sorted(by: newer)
            picks += auto.prefix(1)
        }
        for i in picks { fractureOne(i) }
    }

    /// Why an issue may not be split, nil when it may.
    func fractureRefusal(_ e: PipelineEntry) -> String? {
        if e.item.kind != .issue { return "it is not an issue" }
        if let why = e.unwritable { return why }
        if has(e, model.labels.fractured) || !e.children.isEmpty { return "it is split already" }
        if !fixers(e).isEmpty { return "an open PR fixes it" }
        if e.root == nil { return "Linear team \(e.item.repo) has no root to read its code in" }
        if let slug = e.root?.slug, unread.contains(slug) { return "\(slug) could not be read" }
        return nil
    }

    func fractureOne(_ i: Int) {
        let e = entries[i]
        guard let root = e.root else { return }
        let out = io.claude(PipelineRater.arguments(model: model.rater.model, schema: model.fractureSchema,
                                                    prompt: PipelineRater.fracturePrompt(e, model)),
                            Data(PipelineRater.input(e, diff: nil, model).utf8), root.path,
                            model.rater.timeoutSecs)
        let parts: [(title: String, body: String)], why: String
        switch PipelineRater.parts(out, max: model.fracture.maxChildren) {
        case .failure(let f):
            notice("\(e.item.label) was not split: \(f.message)")
            return
        case .success(let answer):
            (parts, why) = answer
        }
        guard !parts.isEmpty else {
            state.unsplit[e.id] = "would not split: " + (why.isEmpty ? "the model named no parts" : why)
            log(e.id, .held, state.unsplit[e.id]!)
            return
        }
        state.unsplit[e.id] = nil
        var made: [String] = []
        for part in parts {
            switch createChild(i, part) {
            case .success(let url):
                made.append(url)
                log(e.id, .child, "\(url): \(part.title)")
                continue
            case .failure(let f):
                // Never retried unforced: a second split would file the made parts again.
                state.unsplit[e.id] = "split stopped after \(made.count) of \(parts.count) parts: \(f.message)"
                notice("\(e.item.label): \(state.unsplit[e.id]!)")
            }
            break
        }
        if !made.isEmpty, add(i, model.labels.fractured) {
            log(e.id, .fractured, "split into \(made.count) parts" + (why.isEmpty ? "" : ": " + why))
        }
    }

    /// One child of a writable issue, its body ending with a line naming the parent: its
    /// URL, or why it was not made (or made but not linked).
    func createChild(_ i: Int, _ part: (title: String, body: String)) -> Result<String, PipelineIO.Failure> {
        let e = entries[i]
        guard e.item.writable else { return .failure(.init("\(e.item.label) is not writable")) }
        let body = part.body + "\n\nPart of \(e.id)"
        switch e.item.source {
        case .github:
            guard let root = e.root, let parent = e.nodeID else { return .failure(.init("no repository to file it in")) }
            let out = io.gh(["api", "-X", "POST", "repos/\(root.slug)/issues", "-f", "title=\(part.title)",
                             "-f", "body=\(body)"])
            let made = (try? JSONSerialization.jsonObject(with: out.stdout)) as? [String: Any]
            guard out.ok, let url = made?["html_url"] as? String, let node = made?["node_id"] as? String else {
                return .failure(.init("the issue could not be created: \(out.why)"))
            }
            let mutation: String
            do { mutation = try CoreAssets.graphql("pipeline-add-sub-issue") } catch {
                return .failure(.init("\(url) was created, but \(error.localizedDescription)"))
            }
            let link = io.gh(["api", "graphql", "-f", "query=\(mutation)", "-f", "issueId=\(parent)",
                              "-f", "subIssueId=\(node)"])
            let answer = (try? JSONSerialization.jsonObject(with: link.stdout)) as? [String: Any]
            guard link.ok, answer?["errors"] == nil else {
                return .failure(.init("\(url) was created but not made a sub-issue: \(link.why)"))
            }
            return .success(url)
        case .linear:
            guard let api = linear, let team = e.teamID, let parent = e.nodeID else {
                return .failure(.init("no Linear team to file it in"))
            }
            do {
                let data = try api.call("IssueCreate", ["teamId": team, "title": part.title,
                                                        "description": body, "parentId": parent])
                guard let url = ((data["issueCreate"] as? [String: Any])?["issue"] as? [String: Any])?["url"]
                    as? String else { return .failure(.init("Linear created no issue")) }
                return .success(url)
            } catch {
                return .failure(.init(error.localizedDescription))
            }
        }
    }

    // MARK: - Stages

    /// Every open item's stage, lane and hold, PRs first since a fixed issue's lane is
    /// its PR's; a cleared PR's merge hold logged when it, or the head, changes.
    func settle() {
        for i in entries.indices where entries[i].item.kind == .pr && open(entries[i]) {
            let e = entries[i]
            let head = e.item.headSha ?? ""
            let atHead = !head.isEmpty && e.item.cleanAt == head
            var hold: String?
            let stage: PipelineStage
            if !own(e) {
                stage = e.item.rating == nil ? .unrated : .human
            } else if has(e, model.labels.cleared) && atHead {
                stage = .cleared
                let code: String?
                if partial.contains(e.item.repo) {
                    // Missing reviews or comments would read as no one else having looked.
                    (code, hold) = ("partial", "\(e.item.repo) was read only in part")
                } else if let h = mergeHold(e) {
                    (code, hold) = (h.code, h.message)
                } else if repos[e.item.repo]?.mergeFlag == nil {
                    (code, hold) = ("no-method", "its repository allows none of squash, merge or rebase")
                } else {
                    code = nil
                }
                if let code {
                    if state.holds[e.id] != "\(head) \(code)" {
                        log(e.id, .held, hold ?? code)
                        state.holds[e.id] = "\(head) \(code)"
                    }
                } else {
                    state.holds[e.id] = nil
                }
            } else if has(e, model.labels.fastTrack) {
                stage = atHead ? .clean : .fastTrack
                hold = e.unwritable.map { "on the fast track, but \($0)" }
            } else if let r = e.item.rating {
                stage = .human
                if let why = e.unwritable, r.atLeast(e.item.floor ?? r).isFastTrack {
                    hold = "off the fast track: \(why)"
                }
            } else {
                stage = .unrated
            }
            if atHead && state.clean[e.id] != head && [.clean, .cleared].contains(stage) {
                log(e.id, .clean, "clean marker at \(head.prefix(7))")
                state.clean[e.id] = head
            }
            entries[i].item.stage = stage
            entries[i].item.lane = [.fastTrack, .clean, .cleared].contains(stage) ? .fast
                : stage == .unrated ? .unrated : .human
            entries[i].item.hold = hold
        }
        for i in entries.indices where entries[i].item.kind == .issue && open(entries[i]) {
            let e = entries[i]
            let fixing = fixers(e)
            var hold = state.unsplit[e.id]
            let stage: PipelineStage
            let lane: PipelineLane
            if !fixing.isEmpty {
                stage = .fixing
                lane = fixing.contains { entries[$0].item.lane == .fast } ? .fast : .human
            } else if has(e, model.labels.fractured) || !e.children.isEmpty {
                (stage, lane) = (.fractured, .fractured)
            } else if let r = e.item.rating {
                if r.isFastTrack && e.item.writable {
                    (stage, lane) = (.candidate, .fast)
                    hold = e.root == nil ? "Linear team \(e.item.repo) has no root to fix it in"
                        : unread.contains(e.root!.slug)
                        ? "\(e.root!.slug) could not be read, so a PR fixing it would not be seen" : nil
                } else {
                    (stage, lane) = (.human, .human)
                }
            } else {
                (stage, lane) = (.unrated, .unrated)
            }
            entries[i].item.stage = stage
            entries[i].item.lane = lane
            entries[i].item.hold = hold
        }
    }

    func mergeHold(_ e: PipelineEntry) -> PipelineGate.Hold? {
        PipelineGate.hold(PipelineGate.Candidate(
            state: e.item.state, author: e.item.author ?? "", isCrossRepository: e.isCrossRepository,
            baseRef: e.baseRef, defaultBranch: e.defaultBranch, participants: e.participants,
            participantsUnseen: e.participantsUnseen, reviewDecision: e.reviewDecision,
            unresolvedThreads: e.unresolvedThreads, rating: e.item.rating,
            floor: e.item.floor ?? PipelineRating(risk: .high, complexity: .high),
            mergeable: e.mergeable, headSha: e.item.headSha ?? "", ciCommit: e.ciCommit,
            ciState: e.ciState), me: e.root?.me ?? "")
    }

    // MARK: - Merge

    /// Each cleared PR no hold stops: marked ready if a draft, then merged with admin
    /// rights at exactly the head the gate read.
    func merge() {
        for i in entries.indices where entries[i].item.stage == .cleared && entries[i].item.hold == nil {
            let e = entries[i]
            guard let root = e.root, let n = e.number, let head = e.item.headSha,
                  let flag = repos[e.item.repo]?.mergeFlag else { continue }
            if e.isDraft {
                let ready = io.gh(["pr", "ready", "\(n)", "-R", root.slug])
                guard ready.ok else {
                    notice("\(e.item.label) was not merged: it could not be marked ready: \(ready.why)")
                    continue
                }
            }
            let out = io.gh(["pr", "merge", "\(n)", "-R", root.slug, "--admin", flag,
                             "--match-head-commit", head])
            guard out.ok else {
                notice("\(e.item.label) was not merged: \(out.why)")
                continue
            }
            log(e.id, .merged, "merged \(head.prefix(7)) with --admin \(flag)")
            entries[i].item.state = "merged"
            entries[i].item.writable = false
            entries[i].unwritable = "merged"
            entries[i].item.stage = .merged
            entries[i].item.lane = .done
        }
    }

    // MARK: - Effects

    /// The agent work owed, newest item first; each logged `asked` once per stamp.
    func owed() -> [PipelineEffect] {
        var out: [PipelineEffect] = []
        for i in entries.indices.sorted(by: newer) {
            let e = entries[i]
            guard e.item.hold == nil else { continue }
            switch (e.item.kind, e.item.stage, e.item.source) {
            case (.issue, .candidate, .github) where settings.fix:
                if let root = e.root, let n = e.number { out.append(.fixIssue(repo: root.slug, number: n, url: e.id)) }
            case (.issue, .candidate, .linear) where settings.fix:
                if let root = e.root {
                    out.append(.fixLinear(repo: root.slug, identifier: e.item.label, url: e.id,
                                          text: e.item.title + "\n\n" + PipelineRater.clip(e.body, model.rater.bodyChars)))
                }
            case (.pr, .fastTrack, _) where settings.fastTrack:
                if let root = e.root, let n = e.number, let head = e.item.headSha {
                    out.append(.review(repo: root.slug, number: n, url: e.id, headSha: head))
                }
            default:
                break
            }
        }
        for effect in out where state.asked[effect.key] != effect.stamp {
            let what: String
            switch effect {
            case .fixIssue, .fixLinear: what = "asked for a fix PR"
            case .review(_, _, _, let head): what = "asked for a fast-track review at \(head.prefix(7))"
            }
            log(effect.url, .asked, what)
            state.asked[effect.key] = effect.stamp
        }
        return out
    }

    // MARK: - Log

    func log(_ item: String, _ kind: PipelineEvent.Kind, _ detail: String) {
        events.append(PipelineEvent(at: now, item: item, kind: kind, detail: detail))
    }

    func notice(_ text: String) {
        if !notices.contains(text) { notices.append(text) }
    }
}
