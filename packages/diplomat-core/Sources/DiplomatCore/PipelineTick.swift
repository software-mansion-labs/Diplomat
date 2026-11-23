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
    /// One sync. Reads every root's open issues and PRs (at most `githubMaxItems` of each),
    /// its recently merged or closed PRs that carry a pipeline label and the closed issues
    /// they close, and every tracked Linear team's open issues; with `rate` (or forced)
    /// rates up to `rater.perSync` unrated ones, forced first, then clean PRs awaiting
    /// their second rating, the operator's unrated PRs, writable issues, other open
    /// issues, newest first, leaving out for 1, 2, 4 ... syncs (a day at most) one whose
    /// rating just failed; writes each rating as labels where Diplomat may, never lower
    /// than the labels or the diff's floor, and caches the rest; with `fastTrack` labels
    /// `fastTrack` a PR of the operator's at its first rating if it is low/low and fixes
    /// candidate issues, puts `cleared` on one rated low/low again at a head a clean marker
    /// names, takes `cleared` off one whose head no marker names, takes both off one rated
    /// above low/low again or whose `cleared` a person took off, and asks for a review of
    /// each fast-track head no marker names; with `merge` reads each cleared PR no merge
    /// hold stops again and, if it is unchanged and nothing holds it then, marks a draft
    /// ready or merges it; with `fracture` (or forced) splits one writable
    /// medium/high-complexity issue that is not high risk into children; with `fix` asks
    /// for a fix PR for each candidate issue. A banned author's item, and every part split
    /// from one, gets none of that. Every step it takes, and each hold, notice and request
    /// the first time it is seen, is logged to `dir`, and its state saved after each step;
    /// the result is saved as `last.json`.
    ///
    /// Right before each outward step and each model call it reads `PipelineControl`, and
    /// skips the step whose switch is off now. A `state.json` that cannot be read leaves
    /// the sync reading and showing only. A read that fails is a notice, and the rest of
    /// the sync goes on without it; a root read past `githubMaxItems` neither fixes nor
    /// splits its issues, and one read with errors, or whose Linear team was not read,
    /// is read and shown only. Such roots, or all of them when the sync is blocked, are
    /// its `unread`. One sync runs at a time per `dir`: another started meanwhile reads
    /// nothing and answers the last result with a notice.
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
        last.unread = settings.roots.map(\.slug)
        return last
    }
}

/// One sync's working state; see `PipelineTick.run`.
final class PipelineSync {
    /// What a switch allows: `forced` is the operator's own request, which needs only
    /// the pipeline enabled.
    enum Step { case rate, fix, fastTrack, merge, fracture, forced }

    let settings: PipelineSettings
    let now: Date
    let dir: URL
    let io: PipelineIO
    var model: CoreAssets.PipelineModel!
    var state: PipelineState
    var cache: [String: PipelineCachedRating]
    /// Why this sync writes, splits and merges nothing: a `state.json` there but not
    /// readable, whose guards it would act without.
    var blocked: String?
    var entries: [PipelineEntry] = []
    var pos: [String: Int] = [:]
    /// Each entry's index by its id lowercased, without a trailing slash.
    var byURL: [String: Int] = [:]
    var repos: [String: PipelineRepo] = [:]
    var edges: [PipelineGraph.Edge] = []
    /// Events not in the log yet.
    var unsaved: [PipelineEvent] = []
    var notices: [String] = []
    /// Every source was read whole; only then does an item gone from the read lose what
    /// only keeps the log from repeating itself.
    var readAll = true
    /// Per root, why a PR fixing one of its issues might not have been read.
    var incomplete: [String: String] = [:]
    /// Per root read with errors, or whose Linear team was not read, why: such a root is
    /// read and shown only.
    var partial: [String: String] = [:]
    /// The roots judged on less than all they hold, besides `incomplete` and `partial`.
    var unread: Set<String> = []
    var githubQuery: String?
    var linear: LinearAPI?
    /// Each read Linear issue's index by its identifier, uppercased.
    var linearIssue: [String: Int] = [:]
    /// Linear labels by lowercased name, each with its team (nil for a workspace label).
    var linearLabels: [String: [(id: String, team: String?)]] = [:]
    var floorWhy: [String: [String]] = [:]
    /// Per PR, each head this Diplomat rated it again at, and that rating: the state's, and
    /// its log's `rerated` events.
    var rerates: [String: [String: PipelineRating]] = [:]
    /// `"<item> <head>"` of each head the log says this Diplomat put `cleared` on at.
    var clearsLogged: Set<String> = []
    /// The prompt-injection ban list, lowercased.
    var banned: Set<String> = []
    /// Per cleared PR, the code of the hold `settle` found on it.
    var holdCodes: [String: String] = [:]

    init(settings: PipelineSettings, now: Date, dir: URL, io: PipelineIO) {
        self.settings = settings
        self.now = now
        self.dir = dir
        self.io = io
        switch PipelineState.load(in: dir) {
        case .success(let s):
            state = s
        case .failure(let f):
            state = PipelineState()
            blocked = f.message
        }
        cache = PipelineCachedRating.load(in: dir)
    }

    func run() -> PipelineTickResult {
        let roots = settings.roots.map(\.slug)
        guard let model = try? CoreAssets.pipeline() else {
            return PipelineTickResult(at: now, notices: ["assets/pipeline.json could not be read"], unread: roots)
        }
        self.model = model
        if let blocked { notice("\(blocked), so this sync writes, splits and merges nothing") }
        state.syncs += 1
        for (id, heads) in state.rerated { rerates[id, default: [:]].merge(heads) { $1 } }
        for e in PipelineLog.read(in: dir) { noteRecord(e) }
        banned = Self.bannedLogins()
        readGitHub()
        readLinear()
        var unique: [PipelineEntry] = []
        for e in entries where pos[e.id] == nil {
            pos[e.id] = unique.count
            byURL[PipelineRead.norm(e.id)] = unique.count
            if e.item.source == .linear { linearIssue[e.item.label.uppercased()] = unique.count }
            unique.append(e)
        }
        entries = unique
        edges = PipelineRead.edges(entries)
        for i in entries.indices { annotate(&entries[i]) }
        if settings.fastTrack { dropStaleClears() }
        rate()
        // With Fast track off too: a `cleared` not recorded could not be told from one a person put on.
        for i in entries.indices { track(i) }
        fracture()
        settle()
        if settings.merge { merge() }
        let effects = owed()

        for n in notices where !state.notices.contains(n) { log("", .error, n) }
        state.notices = notices
        if blocked == nil {
            state.prune(read: Set(entries.map(\.id)), done: Set(entries.filter { !open($0) }.map(\.id)),
                        readAll: readAll, now: now)
            cache = cache.filter { state.seen[$0.key] != nil }
        }
        persist()
        let laid = PipelineGraph.layout(items: entries.map(\.item), edges: edges, maxItems: model.maxItems)
        let short = unread.union(incomplete.keys).union(partial.keys)
        let result = PipelineTickResult(at: now, items: laid.items, graph: laid.graph, effects: effects,
                                        events: Array(PipelineLog.read(in: dir).suffix(model.maxEvents)),
                                        notices: notices,
                                        unread: blocked == nil ? roots.filter(short.contains) : roots)
        PipelineLog.writeLast(result, in: dir)
        return result
    }

    /// The log, the state and the ratings as they stand: after every outward step, so a
    /// sync that dies between two repeats neither. A blocked sync writes none: without the
    /// state it would log the same events again at every sync.
    func persist() {
        guard blocked == nil else { return }
        PipelineLog.append(unsaved, in: dir)
        unsaved = []
        state.save(in: dir)
        PipelineCachedRating.save(cache, in: dir)
    }

    /// Whether `step` may happen now: the sync's settings allow it, and `control.json`,
    /// read now, still does.
    func may(_ step: Step) -> Bool {
        guard blocked == nil else { return false }
        let c = PipelineControl.read(in: dir) ?? PipelineControl(settings: settings)
        let (set, now, name): (Bool, Bool, String)
        switch step {
        case .rate: (set, now, name) = (settings.rate, c.rate, "Rate")
        case .fix: (set, now, name) = (settings.fix, c.fix, "Fix")
        case .fastTrack: (set, now, name) = (settings.fastTrack, c.fastTrack, "Fast track")
        case .merge: (set, now, name) = (settings.merge, c.merge, "Merge")
        case .fracture: (set, now, name) = (settings.fracture, c.fracture, "Fracture")
        case .forced: (set, now, name) = (true, true, "")
        }
        guard set else { return false }
        if !c.enabled {
            notice("the pipeline is switched off, so this sync took no step past that")
            return false
        }
        if !now {
            notice("\(name) is switched off, so this sync took no \(name.lowercased()) step past that")
            return false
        }
        return true
    }

    /// The prompt-injection ban list the front-ends read: `banned.json` in `$DA_BAN_DIR`,
    /// its `~` read as `PrivateFiles.home`, else in `~/.diplomat/pr-monitor`, as
    /// `{"banned": [{"login": …}, …]}`; lowercased, and empty when it cannot be read.
    static func bannedLogins() -> Set<String> {
        let env = ProcessInfo.processInfo.environment["DA_BAN_DIR"] ?? ""
        let dir = env.isEmpty
            ? PrivateFiles.home.appendingPathComponent(".diplomat/pr-monitor")
            : URL(fileURLWithPath: PrivateFiles.expandingTilde(env))
        guard let data = try? Data(contentsOf: dir.appendingPathComponent("banned.json")),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let list = obj["banned"] as? [[String: Any]] else { return [] }
        return Set(list.compactMap { ($0["login"] as? String)?.lowercased() })
    }

    /// Whose text an item carries, the dimension the ban list is checked on: its author,
    /// or for a part Diplomat split off, the author its parent had; "" for the operator.
    func banDimension(_ e: PipelineEntry) -> String {
        state.lineage[e.id] ?? e.item.author ?? ""
    }

    /// Why nothing is done with `e`'s text, nil when its author is not banned.
    func banHold(_ e: PipelineEntry) -> String? {
        let who = banDimension(e)
        guard !who.isEmpty, banned.contains(who.lowercased()) else { return nil }
        return state.lineage[e.id] == nil ? "@\(who) is on the prompt-injection ban list"
            : "split from an issue of @\(who), who is on the prompt-injection ban list"
    }

    // MARK: - Reading

    /// One `pipeline-repo.graphql` operation on `root`, tried once more on failure: GitHub
    /// times the heavy reads out now and then. The response when it holds the repository,
    /// with any errors beside it; else why not.
    func graphql(_ root: PipelineSettings.Root, _ operation: String, _ variables: [String])
        -> (response: [String: Any]?, errors: [String], why: String) {
        guard let query = githubQuery else { return (nil, [], "assets/graphql/pipeline-repo.graphql was not read") }
        let args = ["api", "graphql", "-f", "query=\(query)", "-f", "operationName=\(operation)",
                    "-f", "owner=\(root.owner)", "-f", "name=\(root.repo)"] + variables
        var out = io.gh(args)
        if !out.ok {
            Thread.sleep(forTimeInterval: 0.8)
            out = io.gh(args)
        }
        let response = (try? JSONSerialization.jsonObject(with: out.stdout)) as? [String: Any]
        let errors = (response?["errors"] as? [[String: Any]] ?? []).compactMap { $0["message"] as? String }
        let why = errors.isEmpty ? out.why : errors.joined(separator: "; ")
        guard let response, (response["data"] as? [String: Any])?["repository"] is [String: Any] else {
            return (nil, errors, why)
        }
        return (response, errors, why)
    }

    func readGitHub() {
        do { githubQuery = try CoreAssets.graphql("pipeline-repo") } catch {
            notice(error.localizedDescription)
            readAll = false
            for root in settings.roots { incomplete[root.slug] = "\(root.slug) could not be read" }
            return
        }
        for (n, root) in settings.roots.enumerated() {
            let first = graphql(root, "Repo", [])
            guard let response = first.response else {
                notice("\(root.slug) could not be read: \(first.why)")
                readAll = false
                incomplete[root.slug] = "\(root.slug) could not be read"
                continue
            }
            func readInPart(_ why: String) {
                notice("\(root.slug) was read in part: \(why)")
                readAll = false
                partial[root.slug] = "\(root.slug) was read only in part"
                incomplete[root.slug] = "\(root.slug) was read only in part"
            }
            if !first.errors.isEmpty { readInPart(first.why) }
            let page = PipelineRead.github(response, root: root, primary: n == 0, model: model)
            repos[root.slug] = page.repo
            entries += page.entries
            for (operation, kind, start) in [("Issues", PipelineKind.issue, page.issuesAfter),
                                             ("PullRequests", .pr, page.prsAfter)] {
                var after = start
                var read = page.entries.filter { $0.item.kind == kind && open($0) }.count
                while let cursor = after, read < model.githubMaxItems {
                    let next = graphql(root, operation, ["-f", "after=\(cursor)"])
                    guard let r = next.response, next.errors.isEmpty else {
                        readInPart(next.why)
                        break
                    }
                    let more = PipelineRead.github(r, root: root, primary: n == 0, model: model, repo: page.repo)
                    entries += more.entries
                    read += more.entries.count
                    after = kind == .issue ? more.issuesAfter : more.prsAfter
                }
                if after != nil {
                    let what = kind == .issue ? "issues" : "PRs"
                    if read >= model.githubMaxItems {
                        notice("\(root.slug) has more open \(what) than one sync reads; the newest \(read) were read")
                    }
                    readAll = false
                    incomplete[root.slug] = incomplete[root.slug] ?? "\(root.slug) was read only in part"
                }
            }
        }
    }

    func readLinear() {
        let teams = settings.linearTeams
        guard !teams.isEmpty else { return }
        for team in teams where !settings.roots.contains(where: { $0.slug.lowercased() == team.repo.lowercased() }) {
            notice("Linear team \(team.key) maps to \(team.repo), which is not a GitHub root, "
                   + "so its issues are neither rated nor fixed")
        }
        // A mapped root's PRs may close issues this read would have named.
        func mapped(_ why: String?) {
            for team in teams {
                guard let root = settings.roots.first(where: { $0.slug.lowercased() == team.repo.lowercased() })
                else { continue }
                unread.insert(root.slug)
                if let why, partial[root.slug] == nil { partial[root.slug] = why }
            }
        }
        func unreadable(_ why: String) {
            notice(why)
            readAll = false
            mapped("Linear was not read")
        }
        guard let key = io.linearKey(settings) else {
            return unreadable("Linear was not read: no API key (\(LinearAPI.envVar), "
                + (settings.linearKeychainItem.map { "the Keychain item \($0)" }
                   ?? settings.linearTokenFile.map { "the file \($0)" } ?? "none set") + ")")
        }
        let env = ProcessInfo.processInfo.environment["DIPLOMAT_LINEAR_API"] ?? ""
        guard let url = URL(string: env.isEmpty ? model.linearAPI : env) else {
            return unreadable("Linear was not read: \(env) is not a URL")
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
            return unreadable(error.localizedDescription)
        }
        if after != nil {
            notice("Linear holds more open issues than one sync reads; the newest \(read) were read")
            readAll = false
            mapped(nil)
        }
    }

    /// Its rating off the labels, else the cache; an open PR's floor and clean marker.
    func annotate(_ e: inout PipelineEntry) {
        if let r = labelRating(e.labels) {
            e.item.rating = r
            e.item.ratedBy = "label"
            if let c = cache[e.id], c.rating == r { e.item.why = c.why }
        } else if let c = cache[e.id], c.unwritten == true || !e.item.writable && c.updatedAt == e.item.updatedAt {
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

    /// Adds `name` to a writable item if `step` may happen now; false (with a notice when
    /// the tracker refused) when it was not added.
    @discardableResult
    func add(_ i: Int, _ name: String, _ step: Step) -> Bool {
        let e = entries[i]
        guard e.item.writable else { return false }
        if has(e, name) { return true }
        guard may(step) else { return false }
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
        persist()
        return true
    }

    /// Takes `name` off a writable item if `step` may happen now; false (with a notice
    /// when the tracker refused) when it is still on.
    @discardableResult
    func remove(_ i: Int, _ name: String, _ step: Step) -> Bool {
        let e = entries[i]
        guard e.item.writable else { return false }
        guard let actual = e.labels.first(where: { $0.lowercased() == name.lowercased() }) else { return true }
        guard may(step) else { return false }
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
        persist()
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
    func writeRating(_ i: Int, _ rating: PipelineRating, _ step: Step) -> Bool {
        var changes: [String] = []
        var ok = true
        for (names, level) in [(model.labels.risk, rating.risk), (model.labels.complexity, rating.complexity)] {
            let want = names[level]
            let all = Set(PipelineLevel.allCases.map { names[$0].lowercased() })
            let have = entries[i].labels.filter { all.contains($0.lowercased()) }
            if have.map({ $0.lowercased() }) == [want.lowercased()] { continue }
            if !has(entries[i], want) {
                guard add(i, want, step) else {
                    ok = false
                    continue
                }
                changes.append("+" + want)
            }
            for old in have where old.lowercased() != want.lowercased() {
                if remove(i, old, step) { changes.append("-" + old) } else { ok = false }
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

    /// The read issues `pr` would close: its closing references, and the Linear issues it
    /// closes.
    func fixed(by pr: PipelineEntry) -> [Int] {
        pr.links.compactMap { byURL[PipelineRead.norm($0)] }
            + entries.indices.filter { entries[$0].item.source == .linear && PipelineRead.closes(pr, linear: entries[$0]) }
    }

    /// Whether `pr` is a fix the pipeline asks for: it closes an open issue, and each open
    /// issue it closes is writable, rated low/low on its labels, unsplit, not of a banned
    /// author, and on Linear, of a team mapped to `pr`'s own repository.
    func fixesCandidate(_ pr: PipelineEntry) -> Bool {
        let closing = fixed(by: pr).filter { open(entries[$0]) }
        return !closing.isEmpty && closing.allSatisfy { i in
            let x = entries[i]
            return x.item.kind == .issue && x.item.writable && x.item.ratedBy == "label"
                && x.item.rating?.isFastTrack == true && !has(x, model.labels.fractured)
                && x.children.isEmpty && banHold(x) == nil
                && (x.item.source == .github || x.root?.slug.lowercased() == pr.item.repo.lowercased())
        }
    }

    /// The issues `pr` would close that this sync did not read, so `fixesCandidate` did
    /// not judge: GitHub's past the read or in another repository, but for one assigned
    /// to no one but me, and each Linear identifier its text closes that the Linear read
    /// did not return. Linear's integration closes an issue of any team, tracked or not.
    func closesUnwritable(_ pr: PipelineEntry) -> [String] {
        let me = pr.root?.me.lowercased() ?? ""
        var out: [String] = []
        for c in pr.closes where c.url.isEmpty || byURL[PipelineRead.norm(c.url)] == nil {
            if c.url.isEmpty {
                out.append("issues past what one read lists")
            } else if me.isEmpty || !(c.assignees?.allSatisfy { $0.lowercased() == me } ?? false) {
                out.append(c.url)
            }
        }
        return out + pr.closesLinear.filter { linearIssue[$0] == nil }
    }

    /// An issue already split, or already being fixed: a rating would route it nowhere.
    func settled(_ e: PipelineEntry) -> Bool {
        has(e, model.labels.fractured) || !e.children.isEmpty || !fixers(e).isEmpty
    }

    /// A fast-track PR rated low/low and fixing candidates, with a clean marker at a head
    /// this Diplomat has not rated again: each head is rated again once, whatever the
    /// answer.
    func awaitingRerate(_ e: PipelineEntry) -> Bool {
        guard own(e), open(e), e.item.writable, has(e, model.labels.fastTrack), let head = e.item.headSha, !head.isEmpty, e.item.cleanAt == head, rerates[e.id]?[head] == nil,
              e.item.ratedBy == "label", let r = e.item.rating, r.atLeast(e.item.floor ?? r).isFastTrack,
              offTrack(e) == nil else { return false }
        return fixesCandidate(e)
    }

    /// `cleared`, with a clean marker at its head, at which this Diplomat rated it low/low
    /// again. The label alone is no proof of that re-rate: anyone with triage rights can
    /// add it.
    func clearedByMe(_ e: PipelineEntry) -> Bool {
        guard has(e, model.labels.cleared), let head = e.item.headSha, !head.isEmpty,
              e.item.cleanAt == head else { return false }
        return rerates[e.id]?[head]?.isFastTrack == true
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
            } else if !open(e) {
                notice("\(e.item.label) was not rated: it is \(e.item.state)")
            } else if e.root == nil {
                notice("\(e.item.label) was not rated: Linear team \(e.item.repo) has no root to read its code in")
            } else if let why = e.root.flatMap({ partial[$0.slug] }) {
                notice("\(e.item.label) was not rated: \(why)")
            } else if let why = banHold(e) {
                notice("\(e.item.label) was not rated: \(why)")
            } else if !forced.contains(i) {
                forced.append(i)
            }
        }
        var bands: [[Int]] = []
        if settings.rate {
            let idx = entries.indices.filter {
                let e = entries[$0]
                return banHold(e) == nil && !backingOff(e.id) && e.root.map { partial[$0.slug] == nil } ?? true
            }
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
                    return e.item.kind == .issue && open(e) && !e.item.writable && e.item.rating == nil
                        && e.root != nil && !settled(e)
                },
            ].map { $0.sorted(by: newer) }
        }
        // An item in two bands is rated once.
        var rest: [Int] = []
        for i in bands.joined() where !forced.contains(i) && !rest.contains(i) && rest.count < model.rater.perSync {
            rest.append(i)
        }
        for i in forced { rateOne(i, .forced) }
        for i in rest { rateOne(i, .rate) }
    }

    func rateOne(_ i: Int, _ step: Step) {
        let e = entries[i]
        guard let root = e.root, may(step) else { return }
        let again = awaitingRerate(e)
        let first = e.item.kind == .pr && labelRating(e.labels) == nil
        var diff: String?
        if e.item.kind == .pr, let n = e.number {
            let out = io.gh(["pr", "diff", "\(n)", "-R", root.slug])
            guard out.ok else {
                notice("\(e.item.label) was not rated: its diff could not be read: \(out.why)")
                return failed(e.id)
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
            return failed(e.id)
        case .success(let answer):
            (said, why) = answer
        }
        state.retry[e.id] = nil
        // Never lower than a label already on it, nor than its diff allows.
        let have = levels(e.labels)
        var rating = PipelineRating(risk: max(said.risk, have.risk ?? .low),
                                    complexity: max(said.complexity, have.complexity ?? .low))
        var detail = describe(rating) + (why.isEmpty ? "" : ": " + why)
        var floor = e.item.floor ?? PipelineRating(risk: .low, complexity: .low)
        var reasons = floorWhy[e.id] ?? []
        if let diff {
            let more = PipelineGate.diffFloor(diff, diffChars: model.rater.diffChars)
            floor = floor.atLeast(more.rating)
            reasons += more.reasons
        }
        if rating.atLeast(floor) != rating {
            rating = rating.atLeast(floor)
            detail = describe(rating) + ", floored by its diff (" + reasons.joined(separator: "; ") + ")"
                + (why.isEmpty ? "" : ": " + why)
        }
        if again, let head = e.item.headSha {
            state.rerated[e.id, default: [:]][head] = rating
            rerates[e.id, default: [:]][head] = rating
        }
        log(e.id, again ? .rerated : .rated, detail, head: e.item.kind == .pr ? e.item.headSha : nil,
            rating: rating)
        cache[e.id] = PipelineCachedRating(rating: rating, why: why, updatedAt: e.item.updatedAt)
        entries[i].item.why = why
        entries[i].item.rating = rating
        entries[i].item.ratedBy = "local"
        guard e.item.writable, may(step) else {
            persist()
            return
        }
        writeRating(i, rating, step)
        guard labelRating(entries[i].labels) == rating else {
            // Kept, so it is not paid for again while the labels cannot be written.
            cache[e.id]?.unwritten = true
            notice("\(e.item.label): its rating labels could not be written, so the rating is kept here")
            persist()
            return
        }
        entries[i].item.ratedBy = "label"
        persist()
        // Only a PR's first rating puts it on the fast track: a rated PR without the label is a person's.
        guard first, settings.fastTrack, rating.isFastTrack, !has(entries[i], model.labels.fastTrack),
              fixesCandidate(entries[i]) else { return }
        if add(i, model.labels.fastTrack, .fastTrack) {
            log(e.id, .fastTrack, "+\(model.labels.fastTrack): rated \(describe(rating))")
        }
    }

    func describe(_ r: PipelineRating) -> String {
        "\(r.risk.rawValue) risk, \(r.complexity.rawValue) complexity"
    }

    /// Whether `id`'s last rating or split failed too recently to be tried again unforced.
    func backingOff(_ id: String) -> Bool {
        guard let r = state.retry[id] else { return false }
        return state.syncs < r.after && now.timeIntervalSince(r.at) < 86_400
    }

    func failed(_ id: String) {
        let failures = (state.retry[id]?.failures ?? 0) + 1
        state.retry[id] = PipelineRetry(failures: failures, after: state.syncs + (1 << min(failures - 1, 20)), at: now)
        persist()
    }

    // MARK: - Fast track

    /// Why my fast-track PR is off the fast track for good, nil when it is not: rated
    /// again above low/low at some head, `cleared` gone from a head Diplomat put it on at,
    /// or taken off by Diplomat before.
    func offTrack(_ e: PipelineEntry) -> String? {
        let head = e.item.headSha ?? ""
        let above = (rerates[e.id] ?? [:]).filter { !$0.value.isFastTrack }
        if let h = above[head] != nil ? head : above.keys.sorted().first, let r = above[h] {
            return "re-rated \(describe(r)) at " + (h == head ? "this head" : String(h.prefix(7)))
        }
        if !has(e, model.labels.cleared),
           let h = state.cleared[e.id] ?? (clearsLogged.contains("\(e.id) \(head)") ? head : nil) {
            return "\(model.labels.cleared) came off it at \(h.prefix(7))"
        }
        return state.decided.contains(e.id) ? "Diplomat took it off the fast track" : nil
    }

    /// Writes what this Diplomat decided of my PR wearing a fast-track label: both labels
    /// off once it is off the fast track for good, else `cleared` on at a head rated
    /// low/low again.
    func track(_ i: Int) {
        let e = entries[i]
        let (ft, cl) = (model.labels.fastTrack, model.labels.cleared)
        guard own(e), open(e), e.item.writable, partial[e.item.repo] == nil, has(e, ft) || has(e, cl) else { return }
        if let why = offTrack(e) {
            let off = [ft, cl].filter { has(entries[i], $0) && remove(i, $0, .fastTrack) }
            if !off.isEmpty { log(e.id, .labelled, off.map { "-" + $0 }.joined(separator: " ") + ": \(why), for a human") }
            if !state.decided.contains(e.id) { state.decided.append(e.id) }
            return persist()
        }
        guard has(e, ft), let head = e.item.headSha, e.item.cleanAt == head, rerates[e.id]?[head]?.isFastTrack == true,
              !has(e, cl) || state.cleared[e.id] != head else { return }
        if !has(e, cl) { guard add(i, cl, .fastTrack) else { return } }
        state.cleared[e.id] = head
        log(e.id, .cleared, "cleared at \(head.prefix(7))", head: head)
        persist()
    }

    /// `cleared` on my fast-track PR whose head no clean marker names: back to the fast
    /// track for a review of that head.
    func dropStaleClears() {
        for i in entries.indices {
            let e = entries[i]
            guard own(e), open(e), has(e, model.labels.fastTrack), has(e, model.labels.cleared),
                  partial[e.item.repo] == nil, let head = e.item.headSha, e.item.cleanAt != head,
                  offTrack(e) == nil, remove(i, model.labels.cleared, .fastTrack) else { continue }
            state.cleared[e.id] = nil
            log(e.id, .labelled, "-\(model.labels.cleared): " + (e.item.cleanAt == nil
                ? "no clean marker names its head \(head.prefix(7))"
                : "the head moved to \(head.prefix(7)), past its clean marker"))
            persist()
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
        let forced = picks.count
        if settings.fracture {
            let auto = entries.indices.filter { i in
                let e = entries[i]
                guard !picks.contains(i), fractureRefusal(e) == nil, state.unsplit[e.id] == nil, !backingOff(e.id),
                      let r = e.item.rating else { return false }
                return r.complexity >= .medium && r.risk != .high
            }.sorted(by: newer)
            picks += auto.prefix(1)
        }
        for (n, i) in picks.enumerated() { fractureOne(i, n < forced ? .forced : .fracture) }
    }

    /// Why an issue may not be split, nil when it may.
    func fractureRefusal(_ e: PipelineEntry) -> String? {
        if e.item.kind != .issue { return "it is not an issue" }
        if let why = e.unwritable { return why }
        if has(e, model.labels.fractured) || !e.children.isEmpty { return "it is split already" }
        if !fixers(e).isEmpty { return "an open PR fixes it" }
        if e.root == nil { return "Linear team \(e.item.repo) has no root to read its code in" }
        if let slug = e.root?.slug, let why = incomplete[slug] ?? partial[slug] { return why }
        if let why = banHold(e) { return why }
        return nil
    }

    /// Splits one issue, claiming it first with `fractured` so a split interrupted
    /// part-way is never filed again: the label stays, with a hold naming what was filed.
    func fractureOne(_ i: Int, _ step: Step) {
        let e = entries[i]
        guard let root = e.root, may(step) else { return }
        state.unsplit[e.id] = "a split was started and did not finish"
        persist()
        guard add(i, model.labels.fractured, step) else {
            state.unsplit[e.id] = nil
            persist()
            return
        }
        func release(_ why: String?) {
            state.unsplit[e.id] = why
            if !remove(i, model.labels.fractured, .forced) {
                state.unsplit[e.id] = why ?? "it was claimed for a split, which did not happen"
            }
            persist()
        }
        guard may(step) else { return release(nil) }
        let out = io.claude(PipelineRater.arguments(model: model.rater.model, schema: model.fractureSchema,
                                                    prompt: PipelineRater.fracturePrompt(e, model)),
                            Data(PipelineRater.input(e, diff: nil, model).utf8), root.path,
                            model.rater.timeoutSecs)
        let parts: [(title: String, body: String)], why: String
        switch PipelineRater.parts(out, max: model.fracture.maxChildren) {
        case .failure(let f):
            notice("\(e.item.label) was not split: \(f.message)")
            failed(e.id)
            return release(nil)
        case .success(let answer):
            (parts, why) = answer
        }
        guard !parts.isEmpty else {
            let held = "would not split: " + (why.isEmpty ? "the model named no parts" : why)
            log(e.id, .held, held)
            return release(held)
        }
        var made: [String] = []
        func stop(_ why: String) {
            guard !made.isEmpty else {
                notice("\(e.item.label) was not split: \(why)")
                return release(nil)
            }
            // Never retried unforced: a second split would file the made parts again.
            state.unsplit[e.id] = "split stopped after \(made.count) of \(parts.count) parts"
                + " (\(made.joined(separator: ", "))): \(why)"
            notice("\(e.item.label): \(state.unsplit[e.id]!)")
            persist()
        }
        for part in parts {
            guard may(step) else { return stop("the switch was turned off") }
            let child = createChild(i, part)
            if let url = child.url {
                made.append(url)
                log(e.id, .child, "\(url): \(part.title)")
                persist()
            }
            if let why = child.failure {
                if made.isEmpty { failed(e.id) }
                return stop(why)
            }
        }
        state.unsplit[e.id] = nil
        state.retry[e.id] = nil
        log(e.id, .fractured, "split into \(made.count) parts" + (why.isEmpty ? "" : ": " + why))
        persist()
    }

    /// One child of a writable issue, its body ending with a line naming the parent: its
    /// URL once made, recorded as a part of the parent at once, and why it was not made or
    /// not linked. The model wrote the part from untrusted text, so it is defanged, its
    /// mentions and references made inert, and cut to the fracture schema's limits.
    func createChild(_ i: Int, _ part: (title: String, body: String)) -> (url: String?, failure: String?) {
        let e = entries[i]
        guard e.item.writable else { return (nil, "\(e.item.label) is not writable") }
        let title = String(PipelineRater.inert(CommsText.defang(CommsText.oneLine(part.title),
                                                                marker: PipelineRater.fence)).prefix(200))
        let body = String(PipelineRater.inert(CommsText.defang(part.body, marker: PipelineRater.fence)).prefix(4000))
            + "\n\nPart of \(e.id)"
        func made(_ url: String) {
            state.lineage[url] = banDimension(e)
            state.seen[url] = now
            persist()
        }
        switch e.item.source {
        case .github:
            guard let root = e.root, let parent = e.nodeID else { return (nil, "no repository to file it in") }
            let out = io.gh(["api", "-X", "POST", "repos/\(root.slug)/issues", "-f", "title=\(title)",
                             "-f", "body=\(body)"])
            let answer = (try? JSONSerialization.jsonObject(with: out.stdout)) as? [String: Any]
            guard out.ok, let url = answer?["html_url"] as? String, let node = answer?["node_id"] as? String else {
                return (nil, "the issue could not be created: \(out.why)")
            }
            made(url)
            let mutation: String
            do { mutation = try CoreAssets.graphql("pipeline-add-sub-issue") } catch {
                return (url, "\(url) was created, but \(error.localizedDescription)")
            }
            let link = io.gh(["api", "graphql", "-f", "query=\(mutation)", "-f", "issueId=\(parent)",
                              "-f", "subIssueId=\(node)"])
            let linked = (try? JSONSerialization.jsonObject(with: link.stdout)) as? [String: Any]
            guard link.ok, linked?["errors"] == nil else {
                return (url, "\(url) was created but not made a sub-issue: \(link.why)")
            }
            return (url, nil)
        case .linear:
            guard let api = linear, let team = e.teamID, let parent = e.nodeID else {
                return (nil, "no Linear team to file it in")
            }
            do {
                let data = try api.call("IssueCreate", ["teamId": team, "title": title,
                                                        "description": body, "parentId": parent])
                guard let url = ((data["issueCreate"] as? [String: Any])?["issue"] as? [String: Any])?["url"]
                    as? String else { return (nil, "Linear created no issue") }
                made(PipelineRead.linearURL(url))
                return (PipelineRead.linearURL(url), nil)
            } catch {
                return (nil, error.localizedDescription)
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
            let labelled = e.item.ratedBy == "label" ? e.item.rating : nil
            let floor = e.item.floor ?? PipelineRating(risk: .low, complexity: .low)
            if !own(e) || !has(e, model.labels.fastTrack) {
                stage = e.item.rating == nil ? .unrated : .human
                if own(e), let r = e.item.rating, let why = e.unwritable, r.atLeast(floor).isFastTrack {
                    hold = "off the fast track: \(why)"
                }
            } else if let why = partial[e.item.repo] {
                // Missing labels, reviews or comments would read as a person's step, or no one's.
                stage = clearedByMe(e) ? .cleared : atHead ? .clean : .fastTrack
                hold = why
                if stage == .cleared { noteHold(i, "partial", why) }
            } else if let why = offTrack(e) {
                stage = .human
                hold = "off the fast track for good: \(why)"
            } else if labelled == nil {
                stage = e.item.rating == nil ? .unrated : .human
                if e.item.rating != nil { hold = "off the fast track: its rating labels could not be written" }
            } else if let r = labelled, !r.isFastTrack {
                stage = .human
                hold = "off the fast track: it is " + PipelineGate.Hold.rated(r).message
            } else if !floor.isFastTrack {
                stage = .human
                hold = "off the fast track: " + PipelineGate.Hold.floor(floor).message
            } else if clearedByMe(e) {
                stage = .cleared
                let code: String?
                if let h = mergeHold(e) {
                    (code, hold) = (h.code, h.message)
                } else if let why = e.unwritable {
                    (code, hold) = ("unwritable", why)
                } else if repos[e.item.repo]?.mergeFlag == nil {
                    (code, hold) = ("no-method", "its repository allows none of squash, merge or rebase")
                } else {
                    code = nil
                }
                // `merge` logs what it does with a draft.
                if code == PipelineGate.Hold.draft.code { holdCodes[e.id] = code } else { noteHold(i, code, hold) }
            } else if fixesCandidate(e) {
                stage = atHead ? .clean : .fastTrack
                hold = e.unwritable.map { "on the fast track, but \($0)" }
            } else {
                stage = .human
                hold = "off the fast track: it " + PipelineGate.Hold.notAFix.message
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
                    hold = candidateHold(e)
                } else {
                    (stage, lane) = (.human, .human)
                }
            } else {
                (stage, lane) = (.unrated, .unrated)
            }
            entries[i].item.stage = stage
            entries[i].item.lane = lane
            entries[i].item.hold = banHold(e) ?? hold
            entries[i].item.splitFrom = state.lineage[e.id]
        }
    }

    /// Why no fix is asked for a candidate, nil when one is.
    func candidateHold(_ e: PipelineEntry) -> String? {
        guard let root = e.root else { return "Linear team \(e.item.repo) has no root to fix it in" }
        if let why = incomplete[root.slug] { return "\(why), so a PR fixing it might not be seen" }
        if let why = partial[root.slug] { return why }
        if e.item.ratedBy != "label" { return "its rating labels could not be written" }
        if e.item.source == .linear, e.item.repo.uppercased() == "GH" {
            return "GitHub reads Linear team GH's `Fixes \(e.item.label)` as closing #\(e.item.label.dropFirst(3))"
        }
        return nil
    }

    /// Logs a cleared PR's hold when it, or the head, changed since the last one logged.
    /// No hold leaves that record: the first read lacks the fields only `merge`'s
    /// re-read has, whose holds would otherwise be logged anew at every sync.
    func noteHold(_ i: Int, _ code: String?, _ message: String?) {
        let e = entries[i]
        holdCodes[e.id] = code
        guard let code else { return }
        let head = e.item.headSha ?? ""
        if state.holds[e.id] != "\(head) \(code)" {
            log(e.id, .held, message ?? code)
            state.holds[e.id] = "\(head) \(code)"
        }
    }

    func mergeHold(_ e: PipelineEntry) -> PipelineGate.Hold? {
        PipelineGate.hold(PipelineGate.Candidate(
            state: e.item.state, author: e.item.author ?? "", isCrossRepository: e.isCrossRepository,
            baseRef: e.baseRef, defaultBranch: e.defaultBranch, participants: e.participants,
            participantsUnseen: e.participantsUnseen, reviewDecision: e.reviewDecision,
            unresolvedThreads: e.unresolvedThreads, rating: e.item.ratedBy == "label" ? e.item.rating : nil,
            floor: e.item.floor ?? PipelineRating(risk: .high, complexity: .high),
            mergeable: e.mergeable, headSha: e.item.headSha ?? "", ciCommit: e.ciCommit,
            ciState: e.ciState, operatorUntagged: e.operatorUntagged, reviewRequests: e.reviewRequests,
            foreignCommits: e.gate?.foreignCommits ?? [],
            trackLabels: has(e, model.labels.fastTrack) && has(e, model.labels.cleared),
            fixesCandidate: fixesCandidate(e), closesUnwritable: closesUnwritable(e),
            ciRan: e.gate?.ciRan ?? true), me: e.root?.me ?? "")
    }

    // MARK: - Merge

    /// The PR as GitHub has it now, read with `Gate`; nil (with a notice) when it could
    /// not be read whole.
    func reread(_ e: PipelineEntry) -> PipelineEntry? {
        guard let root = e.root, let n = e.number else { return nil }
        let r = graphql(root, "PullRequest", ["-F", "number=\(n)"])
        guard let response = r.response, r.errors.isEmpty,
              var fresh = PipelineRead.pullRequest(response, root: root, label: e.item.label, model: model)
        else {
            notice("\(e.item.label) was not merged: it could not be read again: \(r.why)")
            return nil
        }
        annotate(&fresh)
        return fresh
    }

    /// Each cleared PR no hold stops but being a draft, read again: merged at exactly the
    /// head the sync rated if nothing changed and nothing holds it now; a draft is marked
    /// ready instead, and merged at a later sync.
    func merge() {
        for i in entries.indices where entries[i].item.stage == .cleared
            && [nil, "draft"].contains(holdCodes[entries[i].id]) {
            let e = entries[i]
            guard let root = e.root, let n = e.number, let head = e.item.headSha,
                  let flag = repos[e.item.repo]?.mergeFlag, may(.merge), let fresh = reread(e) else { continue }
            var hold: (code: String, message: String)?
            if fresh.item.headSha != head {
                hold = ("moved", "its head moved to \((fresh.item.headSha ?? "").prefix(7)) since this sync read it")
            } else if let why = offTrack(fresh) {
                hold = ("off-track", why)
            } else if !clearedByMe(fresh) {
                hold = ("not-cleared", "it is no longer cleared at its head")
            } else {
                hold = mergeHold(fresh).map { ($0.code, $0.message) } ?? fresh.unwritable.map { ("unwritable", $0) }
            }
            if hold == nil, !fresh.isDraft, let unwritable = linearLinks(fresh) {
                hold = (PipelineGate.Hold.closesUnwritable("").code, unwritable)
            }
            if let hold, hold.code != PipelineGate.Hold.draft.code {
                entries[i].item.hold = hold.message
                noteHold(i, hold.code, hold.message)
                continue
            }
            if hold != nil || fresh.isDraft {
                guard may(.merge) else { continue }
                let ready = io.gh(["pr", "ready", "\(n)", "-R", root.slug])
                guard ready.ok else {
                    notice("\(e.item.label) was not marked ready: \(ready.why)")
                    continue
                }
                entries[i].item.state = "open"
                entries[i].isDraft = false
                entries[i].item.hold = "marked ready for review; merged at a later sync"
                log(e.id, .held, "marked ready for review; merged at a later sync")
                state.holds[e.id] = "\(head) ready"
                persist()
                continue
            }
            guard may(.merge) else { continue }
            let out = io.gh(["pr", "merge", "\(n)", "-R", root.slug, "--admin", flag,
                             "--match-head-commit", head])
            // GitHub may have merged it all the same; at another head, it was not this merge.
            guard out.ok || reread(e).map({ $0.item.state == "merged" && $0.item.headSha == head }) == true else {
                notice("\(e.item.label) was not merged: \(out.why)")
                continue
            }
            log(e.id, .merged, "merged \(head.prefix(7)) with --admin \(flag)")
            entries[i].item.state = "merged"
            entries[i].item.writable = false
            entries[i].unwritable = "merged"
            entries[i].item.stage = .merged
            entries[i].item.lane = .done
            entries[i].item.hold = nil
            // A second PR closing the same issue no longer fixes a candidate.
            for j in fixed(by: fresh) { entries[j].item.state = "closed" }
            persist()
        }
    }

    /// Why merging `pr` might close a Linear issue Diplomat did not read or may not write
    /// to, by Linear's own record of the issues linking it; nil when it would not, or no
    /// Linear team is tracked.
    func linearLinks(_ pr: PipelineEntry) -> String? {
        guard !settings.linearTeams.isEmpty else { return nil }
        guard let api = linear else { return "Linear was not read, so the issues linking it are unknown" }
        let data: [String: Any]
        do { data = try api.call("Attached", ["url": pr.id]) } catch {
            notice("\(pr.item.label): Linear could not say which issues link it: \(error.localizedDescription)")
            return "Linear could not say which issues link it"
        }
        let found = data["attachmentsForURL"] as? [String: Any]
        if (found?["pageInfo"] as? [String: Any])?["hasNextPage"] as? Bool != false {
            return "more Linear issues link it than one read lists"
        }
        var out: [String] = []
        for node in found?["nodes"] as? [[String: Any]] ?? [] {
            let issue = node["issue"] as? [String: Any]
            guard let id = (issue?["identifier"] as? String)?.uppercased() else { continue }
            let done = ["completed", "canceled"].contains((issue?["state"] as? [String: Any])?["type"] as? String ?? "")
            if !done, !out.contains(id), linearIssue[id].map({ !entries[$0].item.writable }) ?? true { out.append(id) }
        }
        return out.isEmpty ? nil : PipelineGate.Hold.closesUnwritable(out.joined(separator: ", ")).message
    }

    // MARK: - Effects

    /// The agent work owed, newest item first, while its switch is on; each logged
    /// `asked` once per stamp.
    func owed() -> [PipelineEffect] {
        let fix = may(.fix), review = may(.fastTrack)
        var out: [PipelineEffect] = []
        for i in entries.indices.sorted(by: newer) {
            let e = entries[i]
            guard e.item.hold == nil else { continue }
            switch (e.item.kind, e.item.stage, e.item.source) {
            case (.issue, .candidate, .github) where fix:
                if let root = e.root, let n = e.number {
                    out.append(.fixIssue(repo: root.slug, number: n, url: e.id, author: banDimension(e)))
                }
            case (.issue, .candidate, .linear) where fix:
                if let root = e.root {
                    out.append(.fixLinear(repo: root.slug, identifier: e.item.label, url: e.id,
                                          text: e.item.title + "\n\n" + PipelineRater.clip(e.body, model.rater.bodyChars),
                                          author: banDimension(e)))
                }
            case (.pr, .fastTrack, _) where review:
                if let root = e.root, let n = e.number, let head = e.item.headSha {
                    out.append(.review(repo: root.slug, number: n, url: e.id, headSha: head, author: ""))
                }
            default:
                break
            }
        }
        for effect in out where state.asked[effect.key] != effect.stamp {
            let what: String
            switch effect {
            case .fixIssue, .fixLinear: what = "asked for a fix PR"
            case .review(_, _, _, let head, _): what = "asked for a fast-track review at \(head.prefix(7))"
            }
            log(effect.url, .asked, what)
            state.asked[effect.key] = effect.stamp
        }
        return out
    }

    // MARK: - Log

    func log(_ item: String, _ kind: PipelineEvent.Kind, _ detail: String, head: String? = nil,
             rating: PipelineRating? = nil) {
        let event = PipelineEvent(at: now, item: item, kind: kind, detail: detail, head: head, rating: rating)
        unsaved.append(event)
    }

    /// The re-rates and clears a logged event records: they outlive a lost `state.json`.
    func noteRecord(_ e: PipelineEvent) {
        guard let head = e.head, !head.isEmpty else { return }
        if e.kind == .rerated, let r = e.rating, rerates[e.item]?[head] == nil { rerates[e.item, default: [:]][head] = r }
        if e.kind == .cleared { clearsLogged.insert("\(e.item) \(head)") }
    }

    func notice(_ text: String) {
        if !notices.contains(text) { notices.append(text) }
    }
}
