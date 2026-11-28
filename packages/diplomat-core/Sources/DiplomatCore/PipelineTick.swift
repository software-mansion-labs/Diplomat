import Foundation
#if canImport(Glibc)
import Glibc
#endif

/// What a sync reaches outside the process; tests stub it.
public struct PipelineIO {
    /// A call that could not start or finish in time is status -1, the reason as `stderr`.
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

        var why: String {
            let tail = stderr.trimmingCharacters(in: .whitespacesAndNewlines)
            return tail.isEmpty ? "exited \(status)" : String(CommsText.oneLine(tail).suffix(200))
        }
    }

    struct Failure: Error, Equatable {
        let message: String
        init(_ message: String) { self.message = message }
    }

    public var gh: ([String]) -> Exit
    public var claude: (_ arguments: [String], _ input: Data, _ cwd: String, _ timeout: TimeInterval) -> Exit
    public var linear: SlackAPI.Transport
    /// A Linear call's `Authorization`, nil when signed out (`LinearLogin.authorization`).
    public var linearAuth: () throws -> String?

    public init(gh: @escaping ([String]) -> Exit,
                claude: @escaping ([String], Data, String, TimeInterval) -> Exit,
                linear: @escaping SlackAPI.Transport,
                linearAuth: @escaping () throws -> String?) {
        self.gh = gh
        self.claude = claude
        self.linear = linear
        self.linearAuth = linearAuth
    }

    /// Each child gets `CommsClassifier.childEnvironment`, which holds no token.
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
            linearAuth: { try LinearLogin.authorization() })
    }
}

public enum PipelineTick {
    /// One sync, as docs/pipeline.md describes it. A read that fails is a notice, and the
    /// rest of the sync goes on without it. One sync runs at a time per `dir`: another
    /// started meanwhile, or one that cannot open the lock, reads nothing and answers the
    /// last result, or before any one dated at the epoch, with a notice.
    public static func run(settings: PipelineSettings, now: Date = Date(),
                           dir: URL = PipelineLog.dir, io: PipelineIO = .live) -> PipelineTickResult {
        PrivateFiles.prepare(dir)
        let lock = dir.appendingPathComponent("tick.lock")
        if let result = PrivateFiles.locked(lock, wait: false, {
            PipelineSync(settings: settings, now: now, dir: dir, io: io).run()
        }) {
            return result
        }
        // Never dated now: a front-end would take it for a sync it started. Dated at the epoch,
        // it is not shown, though its notices are logged.
        var last = PipelineLog.last(in: dir) ?? PipelineTickResult(at: Date(timeIntervalSince1970: 0))
        let fd = open(lock.path, O_RDWR)
        if fd >= 0 { close(fd) }
        last.notices.append(fd >= 0 ? "another sync held \(lock.path), so this one read nothing"
                                    : "\(lock.path) could not be opened, so this sync read nothing")
        last.unread = settings.roots.map(\.slug)
        last.read = []
        return last
    }
}

final class PipelineSync {
    /// What a switch allows: `forced` is the operator's own request, which needs only
    /// the pipeline enabled; `undo` takes back Diplomat's own claim, which no switch stops.
    enum Step { case rate, mirror, fix, fastTrack, merge, fracture, forced, undo }

    let settings: PipelineSettings
    /// `settings.roots`, each with the name its `Repo` read answered.
    var roots: [PipelineSettings.Root]
    let now: Date
    let dir: URL
    let io: PipelineIO
    var model: CoreAssets.PipelineModel!
    var state: PipelineState
    var cache: [String: PipelineCachedRating]
    /// Why this sync writes, splits and merges nothing: a `state.json` or `ratings.json`
    /// there but unreadable.
    var blocked: String?
    var entries: [PipelineEntry] = []
    var pos: [String: Int] = [:]
    /// Each entry's index by `PipelineRead.norm` of its id.
    var byURL: [String: Int] = [:]
    var repos: [String: PipelineRepo] = [:]
    var edges: [PipelineGraph.Edge] = []
    var unsaved: [PipelineEvent] = []
    var notices: [String] = []
    /// Every source was read whole: only then does an item gone from the read lose its
    /// log-only state.
    var readAll = true
    /// Per root, why a PR fixing one of its issues might not have been read.
    var incomplete: [String: String] = [:]
    /// Per root read with errors, or whose Linear team was not read, why: such a root is
    /// read and shown only.
    var partial: [String: String] = [:]
    /// The roots judged on less than all they hold, besides `incomplete` and `partial`.
    var unread: Set<String> = []
    /// The Linear issues a failed recheck left unjudged.
    var unrechecked: Set<String> = []
    /// Per root a tracked Linear team maps to, why that team was not read whole: an issue
    /// it missed may be attached to any of the root's issues.
    var linearShort: [String: String] = [:]
    var githubQuery: String?
    /// Per root, the page sizes a read halved after a timeout left, by `graphql` variable.
    var pages: [String: [String: Int]] = [:]
    var linear: LinearAPI?
    /// The Linear login's user.
    var linearViewer = ""
    /// Each read Linear issue's index by its identifier, uppercased.
    var linearIssue: [String: Int] = [:]
    /// The read Linear issues attached to each GitHub issue, by its `owner/repo#N` lowercased.
    var linearTwins: [String: [Int]] = [:]
    /// Linear labels by lowercased name, each with its team (nil for a workspace label).
    var linearLabels: [String: [(id: String, team: String?)]] = [:]
    var floorWhy: [String: [String]] = [:]
    /// Per PR, each head this Diplomat rated it again at, and that rating: the state's, and
    /// its log's `rerated` events.
    var rerates: [String: [String: PipelineRating]] = [:]
    /// `"<item> <head>"` of each head the log says this Diplomat put `cleared` on at.
    var clearsLogged: Set<String> = []
    /// The prompt-injection ban list, lowercased, as `may` last read it; nil once a read
    /// failed.
    var banned: Set<String>? = []
    /// The items whose takeover a revoke asked while this sync ran undid (`lateRevokes`).
    var lateRevoked: Set<String> = []
    /// Per cleared PR, the code of the hold `settle` found on it.
    var holdCodes: [String: String] = [:]
    /// Per cleared PR whose head moved, why `carrySyncs` did not keep it cleared there.
    var uncarried: [String: String] = [:]
    /// Each issue a merge this sync asked for may have closed, by its id as `byURL` keys it.
    var closedHere: Set<String> = []
    /// The cleared PRs `merge` read again, which this sync told the end of.
    var mergeRead: Set<String> = []

    init(settings: PipelineSettings, now: Date, dir: URL, io: PipelineIO) {
        self.settings = settings
        roots = settings.roots
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
        switch PipelineCachedRating.load(in: dir) {
        case .success(let c):
            cache = c
        case .failure(let f):
            cache = [:]
            blocked = blocked ?? f.message
        }
    }

    func run() -> PipelineTickResult {
        let slugs = settings.roots.map(\.slug)
        guard let model = try? CoreAssets.pipeline() else {
            return PipelineTickResult(at: now, notices: ["assets/pipeline.json could not be read"], unread: slugs)
        }
        self.model = model
        if let blocked { notice("\(blocked), so this sync writes, splits and merges nothing") }
        state.syncs += 1
        for (id, heads) in state.rerated { rerates[id, default: [:]].merge(heads) { $1 } }
        for e in PipelineLog.read(in: dir) { noteRecord(e) }
        banned = Self.bannedLogins()
        if banned == nil { notice(Self.banNotice) }
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
        for i in entries.indices where entries[i].item.source == .linear {
            for key in Set(entries[i].links.compactMap { Self.githubIssue($0)?.lowercased() }) {
                linearTwins[key, default: []].append(i)
            }
        }
        edges = PipelineRead.edges(entries)
        carrySyncs()
        for i in entries.indices { annotate(&entries[i]) }
        takeOver()
        if settings.fastTrack { dropStaleClears() }
        rate()
        mirror()
        // With Fast track off too: a `cleared` not recorded could not be told from one a person put on.
        for i in entries.indices { track(i) }
        fracture()
        settle()
        if settings.merge { merge() }
        confirmMerges()
        let effects = owed()
        for i in entries.indices {
            entries[i].item.rateRefused = rateRefusal(entries[i])
            entries[i].item.fractureRefused = fractureRefusal(entries[i])
            let taken = takenOver(entries[i]) && open(entries[i])
            entries[i].item.takenOver = taken ? true : nil
            entries[i].item.takeoverRefused = taken ? nil : takeoverRefusal(entries[i])
        }

        for n in notices where !state.notices.contains(n) { log("", .error, n) }
        state.notices = notices
        if blocked == nil {
            state.prune(read: Set(entries.map(\.id)), done: Set(entries.filter { !open($0) }.map(\.id)),
                        readAll: readAll, now: now)
            cache = cache.filter { state.seen[$0.key] != nil }
            PipelineRateJob.sweep(keeping: state.rateAsks.mapValues(\.stamp), in: dir)
        }
        persist()
        let laid = PipelineGraph.layout(items: entries.map(\.item), edges: edges, maxItems: model.maxItems)
        let short = unread.union(incomplete.keys).union(partial.keys)
        let fixable = entries.filter { $0.item.kind == .issue && $0.item.stage == .candidate && $0.item.hold == nil }
        let judged = entries.filter {
            !unrechecked.contains($0.id) && $0.root.map { partial[$0.slug] == nil && repos[$0.slug] != nil } ?? false
        }
        // Without the ban list no item was judged in full.
        let whole = blocked == nil && banned != nil
        let result = PipelineTickResult(at: now, items: laid.items, graph: laid.graph, effects: effects,
                                        events: Array(PipelineLog.read(in: dir).suffix(model.maxEvents)),
                                        notices: notices,
                                        unread: whole ? slugs.filter(short.contains) : slugs,
                                        fixable: whole ? fixable.map(\.id) : [],
                                        read: whole ? judged.map(\.id) : [])
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
    /// read now, still does. It reads the ban list again too, for the step's own check, until
    /// a read fails: then the sync takes no step past that.
    func may(_ step: Step) -> Bool {
        guard blocked == nil else { return false }
        if step == .undo { return true }
        if banned != nil { banned = Self.bannedLogins() }
        guard banned != nil else {
            notice(Self.banNotice)
            return false
        }
        let c = control()
        let (set, now, name): (Bool, Bool, String)
        switch step {
        case .rate: (set, now, name) = (settings.rate, c.rate, "Rate")
        case .mirror: (set, now, name) = (settings.mirrorGitHub || settings.mirrorLinear,
                                          c.mirrorGitHub || c.mirrorLinear, "Mirror")
        case .fix: (set, now, name) = (settings.fix, c.fix, "Fix")
        case .fastTrack: (set, now, name) = (settings.fastTrack, c.fastTrack, "Fast track")
        case .merge: (set, now, name) = (settings.merge, c.merge, "Merge")
        case .fracture: (set, now, name) = (settings.fracture, c.fracture, "Fracture")
        case .forced, .undo: (set, now, name) = (true, true, "")
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
        if [.fix, .fastTrack, .merge].contains(step),
           let root = settings.roots.first(where: { c.limit($0.slug).map($0.limit.fits) == false }) {
            notice("\(root.slug)'s fast-track limit was lowered, so this sync took no \(name.lowercased()) step past that")
            return false
        }
        return true
    }

    func control() -> PipelineControl { PipelineControl.read(in: dir) ?? PipelineControl(settings: settings) }

    /// Whether `e`'s rating goes on it as labels: Diplomat may write to it, and its tracker's
    /// mirror is on and the scope takes it in, in the settings and in `c`.
    func mirrors(_ e: PipelineEntry, _ c: PipelineControl) -> Bool {
        let on = e.item.source == .github ? settings.mirrorGitHub && c.mirrorGitHub : settings.mirrorLinear && c.mirrorLinear
        guard e.item.writable, on else { return false }
        switch min(settings.mirrorScope, c.mirrorScope) {
        case .prs: return e.item.kind == .pr
        case .mine: return e.item.kind == .pr || e.mine
        case .all: return true
        }
    }

    /// The prompt-injection ban list the front-ends read, lowercased. Empty when there is
    /// no file or it lists no `banned`; nil when it cannot be read.
    static func bannedLogins() -> Set<String>? {
        let env = ProcessInfo.processInfo.environment["DA_BAN_DIR"] ?? ""
        let file = (env.isEmpty
            ? PrivateFiles.home.appendingPathComponent(".diplomat/pr-monitor")
            : URL(fileURLWithPath: PrivateFiles.expandingTilde(env))).appendingPathComponent("banned.json")
        var info = stat()
        if stat(file.path, &info) != 0, errno == ENOENT || errno == ENOTDIR { return [] }
        guard let data = try? Data(contentsOf: file),
              let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return nil }
        switch obj["banned"] {
        case nil: return []
        case let list as [Any]: return Set(list.compactMap { (($0 as? [String: Any])?["login"] as? String)?.lowercased() })
        default: return nil
        }
    }

    static let banNotice = "the prompt-injection ban list could not be read, so this sync took no step past that"
    /// Why an item a rating was asked for is neither merged nor fixed until it is in.
    static let ratingAsked = "a rating asked for it is not in yet"
    static let banUnread = "the prompt-injection ban list could not be read"

    /// Whose text a part Diplomat split off carries: its marker's, else the one recorded
    /// when it was filed.
    func lineage(_ e: PipelineEntry) -> String? { e.lineage ?? state.lineage[e.id] }

    /// Whose text an item carries, the dimension the ban list is checked on: its author,
    /// or for a part Diplomat split off, the author its parent had; "" for the operator.
    func banDimension(_ e: PipelineEntry) -> String {
        lineage(e) ?? e.item.author ?? ""
    }

    /// Why nothing is done with `e`'s text, nil when its author is not banned: a part whose
    /// lineage is unknown holds as a banned one does, as does every item while the list
    /// cannot be read.
    func banHold(_ e: PipelineEntry) -> String? {
        guard let banned else { return Self.banUnread }
        if e.isPart && lineage(e) == nil { return "split from an issue whose author could not be read" }
        let who = banDimension(e)
        guard !who.isEmpty, banned.contains(who.lowercased()) else { return nil }
        return lineage(e) == nil ? "@\(who) is on the prompt-injection ban list"
            : "split from an issue of @\(who), who is on the prompt-injection ban list"
    }

    // MARK: - Reading

    /// One `pipeline-repo.graphql` operation on `root`, its `sized` variables (`issues`, `prs`)
    /// the root's page sizes. A GitHub timeout halves those, down to `githubPage.least`, for
    /// this and the root's later pages; any other failure is tried once more. The response
    /// when it holds the repository, with any errors beside it; else why not.
    func graphql(_ root: PipelineSettings.Root, _ operation: String, _ variables: [String],
                 sized: [String] = []) -> (response: [String: Any]?, errors: [String], why: String) {
        guard let query = githubQuery else { return (nil, [], "assets/graphql/pipeline-repo.graphql was not read") }
        let name = root.name.split(separator: "/", maxSplits: 1).map(String.init)
        let args = ["api", "graphql", "-f", "query=\(query)", "-f", "operationName=\(operation)",
                    "-f", "owner=\(name.first ?? "")", "-f", "name=\(name.last ?? "")"] + variables
        let least = model.githubPage.least
        var tried = false
        while true {
            let page = pages[root.slug] ?? ["issues": model.githubPage.issues, "prs": model.githubPage.prs]
            let out = io.gh(args + sized.flatMap { ["-F", "\($0)=\(page[$0] ?? least)"] })
            let response = (try? JSONSerialization.jsonObject(with: out.stdout)) as? [String: Any]
            let raw = response?["errors"] as? [[String: Any]] ?? []
            // Stripped of GitHub's time and request id, a lasting failure reads the same at each sync.
            let errors = raw.compactMap {
                ($0["message"] as? String)?.replacingOccurrences(
                    of: #" on \d{4}-\d\d-\d\dT[\d:]+Z|\s*Please include `[^`]*` when reporting this issue\."#, with: "",
                    options: .regularExpression)
            }
            let read = (response?["data"] as? [String: Any])?["repository"] is [String: Any]
            if out.ok && read && raw.isEmpty { return (response, [], "") }
            if Self.overloaded(out, raw), sized.contains(where: { page[$0, default: least] > least }) {
                for k in sized { pages[root.slug, default: page][k] = max(least, page[k, default: least] / 2) }
                continue
            }
            if !out.ok && !tried {
                tried = true
                Thread.sleep(forTimeInterval: 0.8)
                continue
            }
            let why = errors.isEmpty ? out.why : errors.joined(separator: "; ")
            return (read ? response : nil, errors, why)
        }
    }

    /// Whether a read failed as one past GitHub's ten-second limit does.
    static func overloaded(_ out: PipelineIO.Exit, _ errors: [[String: Any]]) -> Bool {
        let stderr = out.stderr.lowercased()
        if !out.ok, stderr.contains("unexpected end of json")
            || stderr.range(of: #"http 5\d\d"#, options: .regularExpression) != nil { return true }
        return errors.contains {
            let message = ($0["message"] as? String ?? "").lowercased()
            return $0["type"] as? String == "RESOURCE_LIMITS_EXCEEDED" || message.contains("timeout")
                || message.contains("respond to your request in time")
        }
    }

    func readGitHub() {
        do { githubQuery = try CoreAssets.graphql("pipeline-repo") } catch {
            notice(error.localizedDescription)
            readAll = false
            for root in settings.roots { incomplete[root.slug] = "\(root.slug) could not be read" }
            return
        }
        for n in roots.indices {
            let first = graphql(roots[n], "Repo", [], sized: ["issues", "prs"])
            let root = roots[n]
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
            let login = ((response["data"] as? [String: Any])?["viewer"] as? [String: Any])?["login"] as? String ?? ""
            if login.isEmpty {
                readInPart("GitHub did not say which account gh acts as")
            } else if login.lowercased() != root.me.lowercased() {
                if !root.me.isEmpty {
                    notice("gh acts as @\(login), not the @\(root.me) Settings names, so Diplomat judges by @\(login)")
                }
                roots[n].me = login
            }
            let repository = (response["data"] as? [String: Any])?["repository"] as? [String: Any]
            if let name = repository?["nameWithOwner"] as? String, name.contains("/") { roots[n].nameWithOwner = name }
            let page = PipelineRead.github(response, root: roots[n], primary: n == 0, model: model)
            repos[root.slug] = page.repo
            entries += page.entries
            for (operation, kind, start) in [("Issues", PipelineKind.issue, page.issuesAfter),
                                             ("PullRequests", .pr, page.prsAfter)] {
                var after = start
                var read = page.entries.filter { $0.item.kind == kind && open($0) }.count
                while let cursor = after, read < model.githubMaxItems {
                    let next = graphql(roots[n], operation, ["-f", "after=\(cursor)"],
                                       sized: [kind == .issue ? "issues" : "prs"])
                    guard let r = next.response, next.errors.isEmpty else {
                        readInPart(next.why)
                        break
                    }
                    let more = PipelineRead.github(r, root: roots[n], primary: n == 0, model: model, repo: page.repo)
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
            if partial[root.slug] == nil { readQueued(n) }
        }
    }

    /// The ids of `settings.queued`, of the ratings asked for and of the merges whose end no
    /// read saw, that no read so far listed: a front-end takes an ask or record back, a sync
    /// drops a rating ask, and a merge is told, only once a read of its item judged it.
    func unlisted() -> [String] {
        let listed = Set(entries.map { PipelineRead.norm($0.id) })
        let queued = Set(settings.queued.map(PipelineRead.norm))
        let asked = (state.rateAsks.keys.sorted() + state.merging.keys.sorted())
            .filter { !queued.contains(PipelineRead.norm($0)) }
        return (settings.queued + asked).filter { !listed.contains(PipelineRead.norm($0)) }
    }

    func readQueued(_ n: Int) {
        let root = roots[n]
        for id in unlisted() where PipelineRead.root(of: id, in: [root]) != nil {
            guard let number = id.split(separator: "/").last.flatMap({ Int($0) }) else { continue }
            let r = graphql(root, "Queued", ["-F", "number=\(number)"])
            guard let response = r.response, r.errors.isEmpty,
                  let e = PipelineRead.item(response, root: root, label: n == 0 ? "#\(number)" : "\(root.slug)#\(number)",
                                            model: model) else {
                notice("\(id), which an ask, an attempt record or a merge whose end no read saw names, "
                       + "could not be read: \(r.why)")
                continue
            }
            entries.append(done(e))
        }
    }

    func done(_ e: PipelineEntry) -> PipelineEntry {
        guard !open(e) else { return e }
        var e = e
        e.item.stage = e.item.state == "merged" ? .merged : .closed
        e.item.lane = .done
        return e
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
                linearShort[root.slug] = linearShort[root.slug] ?? why ?? "Linear was read only in part"
                if let why, partial[root.slug] == nil { partial[root.slug] = why }
            }
        }
        func unreadable(_ why: String) {
            notice(why)
            readAll = false
            mapped("Linear was not read")
        }
        let signedOut = "not signed in to Linear (Settings → Pipeline → Linear login)"
        do {
            guard try io.linearAuth() != nil else { return unreadable("Linear was not read: \(signedOut)") }
        } catch {
            return unreadable("Linear was not read: \(error.localizedDescription)")
        }
        guard let url = LinearAPI.endpoint(model) else {
            return unreadable("Linear was not read: DIPLOMAT_LINEAR_API is not a URL")
        }
        let api = LinearAPI(authorization: { [io] in
            guard let auth = try io.linearAuth() else { throw LinearAPI.Failure.api(signedOut) }
            return auth
        }, url: url, timeout: model.httpTimeoutSecs, transport: io.linear)
        linear = api
        var after: String?
        var read = 0
        do {
            repeat {
                let data = try api.call("Issues", ["teams": teams.map(\.key), "after": after ?? NSNull()])
                linearViewer = (data["viewer"] as? [String: Any])?["id"] as? String ?? ""
                let page = PipelineRead.linear(data, viewer: linearViewer, teams: teams, roots: roots)
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
        readQueued(api)
    }

    func readQueued(_ api: LinearAPI) {
        let tracked = Set(settings.linearTeams.map { $0.key.uppercased() })
        let wanted = unlisted().compactMap { id -> (key: String, number: Int)? in
            guard let at = id.range(of: "/issue/") else { return nil }
            let parts = id[at.upperBound...].split(separator: "-")
            guard parts.count == 2, tracked.contains(parts[0].uppercased()), let n = Int(parts[1]) else { return nil }
            return (parts[0].uppercased(), n)
        }
        for start in stride(from: 0, to: wanted.count, by: 100) {
            let page = Dictionary(grouping: wanted[start..<min(wanted.count, start + 100)], by: \.key)
            let filter = ["or": page.sorted { $0.key < $1.key }.map { key, ids in
                ["team": ["key": ["eq": key]], "number": ["in": ids.map(\.number)]]
            }]
            do {
                let data = try api.call("Queued", ["filter": filter])
                entries += PipelineRead.linear(data, viewer: linearViewer, teams: settings.linearTeams,
                                               roots: roots).entries.map(done)
            } catch {
                notice("Linear: the issues asks or attempt records name could not be read: \(error.localizedDescription)")
            }
        }
    }

    func annotate(_ e: inout PipelineEntry) {
        if let r = rating(e) {
            let kept = cache[e.id]
            e.item.rating = r
            e.item.ratedBy = kept?.rating == r ? "local" : "label"
            if kept?.rating == r { e.item.why = kept?.why }
        }
        if e.item.kind == .pr, open(e) {
            let floor = PipelineGate.floorWithReasons(files: e.files, changedFiles: e.changedFiles)
            e.item.floor = floor.rating
            floorWhy[e.id] = floor.reasons
            let head = reviewed(e) ?? ""
            e.item.cleanAt = e.markers.contains(head) ? head : e.markers.last
        }
    }

    // MARK: - Labels

    /// Each dimension's highest labelled level; nil where it has none.
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

    /// The rating kept for `e`, raised by its labels; else theirs, when they rate both.
    func rating(_ e: PipelineEntry) -> PipelineRating? {
        cache[e.id].map { atLeastLabels($0.rating, e.labels) } ?? labelRating(e.labels)
    }

    /// `e`'s first rating is to be rated again at its head instead of finished
    /// (`PipelineCachedRating.first`).
    func rateAgain(_ e: PipelineEntry) -> Bool {
        guard settings.fastTrack, let c = cache[e.id], c.pending == true, c.first == true, let h = c.head
        else { return false }
        return h != head(e) && unworn(Set(e.labels.map { $0.lowercased() }))
    }

    /// Each dimension wears `r`'s label and no other.
    func wears(_ labels: [String], _ r: PipelineRating) -> Bool {
        [(model.labels.risk, r.risk), (model.labels.complexity, r.complexity)].allSatisfy { names, level in
            let all = Set(PipelineLevel.allCases.map { names[$0].lowercased() })
            return labels.map { $0.lowercased() }.filter(all.contains) == [names[level].lowercased()]
        }
    }

    func atLeastLabels(_ r: PipelineRating, _ labels: [String]) -> PipelineRating {
        let have = levels(labels)
        return PipelineRating(risk: max(r.risk, have.risk ?? .low),
                              complexity: max(r.complexity, have.complexity ?? .low))
    }

    func has(_ e: PipelineEntry, _ label: String) -> Bool {
        e.labels.contains { $0.lowercased() == label.lowercased() }
    }

    /// False, with a notice when the tracker refused, when `name` was not added.
    @discardableResult
    func add(_ i: Int, _ name: String, _ step: Step) -> Bool {
        let e = entries[i]
        guard e.item.writable else { return false }
        if has(e, name) { return true }
        guard may(step), banHold(e) == nil else { return false }
        switch e.item.source {
        case .github:
            guard let root = e.root, let n = e.number, ensureLabel(root, name) else { return false }
            let out = io.gh(["api", "-X", "POST", "repos/\(root.name)/issues/\(n)/labels", "-f", "labels[]=\(name)"])
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

    /// False, with a notice when the tracker refused, when `name` may still be on.
    @discardableResult
    func remove(_ i: Int, _ name: String, _ step: Step) -> Bool { takeOff(i, name, step) != nil }

    /// `remove`, telling who took it off: true when this call did, false when it was off
    /// already, nil when it may still be on: not asked off, or asked and the call failed,
    /// which the tracker may have applied all the same.
    func takeOff(_ i: Int, _ name: String, _ step: Step) -> Bool? {
        let e = entries[i]
        guard e.item.writable else { return nil }
        guard let actual = e.labels.first(where: { $0.lowercased() == name.lowercased() }) else { return false }
        guard may(step), step == .undo || banHold(e) == nil else { return nil }
        var mine = true
        switch e.item.source {
        case .github:
            guard let root = e.root, let n = e.number else { return nil }
            let path = actual.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? actual
            let out = io.gh(["api", "-X", "DELETE", "repos/\(root.name)/issues/\(n)/labels/\(path)"])
            mine = out.ok
            guard out.ok || out.stderr.contains("HTTP 404") else {
                notice("\(e.item.label): could not remove \(actual): \(out.why)")
                return nil
            }
        case .linear:
            guard let api = linear, let id = e.nodeID, let label = e.labelIDs[actual] else { return nil }
            do { _ = try api.call("RemoveLabel", ["id": id, "labelId": label]) } catch {
                notice("\(e.item.label): could not remove \(actual): \(error.localizedDescription)")
                return nil
            }
        }
        entries[i].labels.removeAll { $0.lowercased() == name.lowercased() }
        persist()
        return mine
    }

    /// Reads `entries[i]` again and keeps what it says now. False, with a notice, when it
    /// could not be read.
    func refresh(_ i: Int) -> Bool {
        let e = entries[i]
        var fresh: PipelineEntry?
        var why = "it was not found"
        switch e.item.source {
        case .github:
            guard let root = e.root, let n = e.number else { return false }
            let r = graphql(root, "Item", ["-F", "number=\(n)"])
            if let response = r.response, r.errors.isEmpty {
                fresh = PipelineRead.item(response, root: root, label: e.item.label, model: model)
            } else {
                why = r.why
            }
        case .linear:
            guard let api = linear, let id = e.nodeID else { return false }
            do {
                let data = try api.call("Issue", ["id": id])
                fresh = (data["issue"] as? [String: Any]).flatMap {
                    PipelineRead.linearIssue($0, viewer: linearViewer, teams: settings.linearTeams, roots: roots)
                }
            } catch {
                why = error.localizedDescription
            }
        }
        guard let fresh, PipelineRead.norm(fresh.id) == PipelineRead.norm(e.id) else {
            notice("\(e.item.label) was not written to: it could not be read again: \(why)")
            return false
        }
        entries[i].labels = fresh.labels
        entries[i].labelIDs = fresh.labelIDs
        entries[i].labeled = fresh.labeled
        entries[i].item.assignees = fresh.item.assignees
        entries[i].item.state = fresh.item.state
        entries[i].item.writable = fresh.item.writable
        entries[i].unwritable = fresh.unwritable
        entries[i].item.updatedAt = fresh.item.updatedAt
        entries[i].item.headSha = fresh.item.headSha
        entries[i].isDraft = fresh.isDraft
        entries[i].issueType = fresh.issueType
        entries[i].triageState = fresh.triageState
        entries[i].parent = fresh.parent
        entries[i].children = fresh.children
        entries[i].mine = fresh.mine
        entries[i].isPart = fresh.isPart
        entries[i].lineage = fresh.lineage
        // A PR's `Item` read lists no closing references.
        if e.item.kind == .issue { (entries[i].links, entries[i].linksPast) = (fresh.links, fresh.linksPast) }
        return true
    }

    /// `refresh` right before a write: false, with a notice, also when the item is no longer
    /// open and writable.
    func recheck(_ i: Int) -> Bool {
        guard refresh(i) else { return false }
        let e = entries[i]
        guard open(e), e.item.writable else {
            notice("\(e.item.label) was not written to, as it changed since this sync read it: "
                   + (e.unwritable ?? e.item.state))
            return false
        }
        return true
    }

    func ensureLabel(_ root: PipelineSettings.Root, _ name: String) -> Bool {
        let slug = root.slug
        if state.labelsMade[slug, default: []].contains(name) { return true }
        let seen = entries.contains { $0.item.source == .github && $0.item.repo == slug && has($0, name) }
        if !seen {
            let out = io.gh(["api", "-X", "POST", "repos/\(root.name)/labels", "-f", "name=\(name)",
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
                let data = try api.call("Labels", ["name": name])
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

    /// A dimension at a time: the wanted label added, then any other of that dimension
    /// taken off.
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

    func fixers(_ e: PipelineEntry) -> [Int] {
        edges.filter { $0.from == e.id && $0.kind == .fixes }
            .compactMap { pos[$0.to] }.filter { open(entries[$0]) }
    }

    func fixed(by pr: PipelineEntry) -> [Int] {
        pr.links.compactMap { byURL[PipelineRead.norm($0)] }
            + entries.indices.filter { entries[$0].item.source == .linear && PipelineRead.closes(pr, linear: entries[$0]) }
    }

    func limit(_ e: PipelineEntry) -> PipelineRating { e.root?.limit ?? .low }

    /// `lifted`: whatever its rating or triage, as when taken over.
    func isCandidate(_ x: PipelineEntry, lifted: Bool = false) -> Bool {
        x.item.kind == .issue && x.item.writable
            && (lifted || takenOver(x) || rating(x)?.fits(limit(x)) == true && triaged(x) == nil)
            && stops(x).isEmpty && onGitHub(x) == nil && twinHold(x) == nil && twinsUnread(x) == nil
            && !has(x, model.labels.fractured) && x.children.isEmpty && banHold(x) == nil && x.root != nil
    }

    /// An issue a PR taken over (`taken`, else as recorded) closes counts as taken over too.
    func isCandidate(_ x: PipelineEntry, for pr: PipelineEntry, taken: Bool? = nil) -> Bool {
        isCandidate(x, lifted: taken ?? takenOver(pr)) && (x.item.source == .github || x.root?.slug.lowercased() == pr.item.repo.lowercased())
    }

    func stops(_ e: PipelineEntry) -> [String] {
        let stop = Set(model.stopLabels.flatMap(Self.triageForms))
        return e.labels.filter { !stop.isDisjoint(with: Self.triageForms($0)) }
    }

    /// A PR taken over (`taken`, else as recorded) may close no issue.
    func fixesCandidate(_ pr: PipelineEntry, taken: Bool? = nil) -> Bool {
        let taken = taken ?? takenOver(pr)
        let closing = fixed(by: pr).filter { open(entries[$0]) }
        return (!closing.isEmpty || taken) && closing.allSatisfy { isCandidate(entries[$0], for: pr, taken: taken) }
    }

    /// The issues `pr` would close that this sync did not read, so `fixesCandidate` did not
    /// judge. Linear's integration closes an issue of any team, tracked or not.
    func closesUnwritable(_ pr: PipelineEntry) -> [String] {
        pr.closes.filter { $0.isEmpty || byURL[PipelineRead.norm($0)] == nil }
            .map { $0.isEmpty ? "issues past what one read lists" : $0 }
            + pr.closesLinear.filter { linearIssue[$0] == nil }
    }

    /// The merge gate's hold on what `pr` would close, as this sync read it.
    func closesHold(_ pr: PipelineEntry, taken: Bool? = nil) -> PipelineGate.Hold? {
        PipelineGate.closes(fixesCandidate(pr, taken: taken), closesUnwritable(pr))
    }

    /// What a cleared PR about to merge would close on Linear, read right before: the open
    /// issues it closes, what no read judged, each identifier looked at, and for each GitHub
    /// issue it closes, by `norm`ed URL, why an open Linear issue attached to it holds it (nil
    /// when none does).
    struct LinearJudged {
        var closing: [PipelineEntry] = []
        var unjudged: [String] = []
        var seen: Set<String> = []
        var twins: [String: String?] = [:]
    }

    func linearJudged(_ pr: PipelineEntry) -> LinearJudged {
        var out = LinearJudged()
        var ids = pr.closesLinear
        var attachedTo: [(issue: String, label: String, ids: [String])] = []
        if !settings.linearTeams.isEmpty {
            /// The open Linear issues an attachment links `url` from; a hold names `url` `name`.
            func attached(_ url: String, _ name: String) -> [String] {
                let linking = "the Linear issues linking \(name)"
                guard let api = linear else {
                    out.unjudged.append(linking)
                    return []
                }
                do {
                    let found = try api.call("Attached", ["url": url])["attachmentsForURL"] as? [String: Any]
                    if (found?["pageInfo"] as? [String: Any])?["hasNextPage"] as? Bool != false { out.unjudged.append(linking) }
                    return (found?["nodes"] as? [[String: Any]] ?? []).compactMap { node in
                        let issue = node["issue"] as? [String: Any]
                        let done = ["completed", "canceled"].contains((issue?["state"] as? [String: Any])?["type"] as? String ?? "")
                        return done ? nil : (issue?["identifier"] as? String)?.uppercased()
                    }
                } catch {
                    notice("\(pr.item.label): Linear could not say which issues link \(name): \(error.localizedDescription)")
                    out.unjudged.append(linking)
                    return []
                }
            }
            for id in attached(pr.id, "it") where !ids.contains(id) { ids.append(id) }
            for x in pr.closing where open(x) { attachedTo.append((x.id, x.item.label, attached(x.id, x.item.label))) }
        }
        let tracked = Set(settings.linearTeams.map { $0.key.uppercased() })
        var read: [String: PipelineEntry?] = [:]
        func judged(_ id: String) -> PipelineEntry? {
            if let x = read[id] { return x }
            var x: PipelineEntry?
            if let api = linear, let key = id.split(separator: "-").first, tracked.contains(String(key)) {
                do {
                    let data = try api.call("Issue", ["id": id])
                    guard let fresh = (data["issue"] as? [String: Any]).flatMap({
                        PipelineRead.linearIssue($0, viewer: linearViewer, teams: settings.linearTeams, roots: roots)
                    }) else { throw LinearAPI.Failure.api("Linear answered no issue") }
                    x = fresh
                } catch {
                    notice("\(pr.item.label): \(id) could not be read: \(error.localizedDescription)")
                }
            }
            read[id] = .some(x)
            return x
        }
        for id in ids {
            guard let x = judged(id) else {
                out.unjudged.append(id)
                continue
            }
            if open(x) { out.closing.append(x) }
        }
        out.seen = Set(ids)
        for (issue, label, found) in attachedTo {
            let twins = found.map(judged)
            let linking = "the Linear issues linking \(label)"
            if twins.contains(where: { $0 == nil }), !out.unjudged.contains(linking) { out.unjudged.append(linking) }
            let held = twins.compactMap { $0 }.filter(open).lazy
                .compactMap { l in self.twinRefusal(l).map { Self.trackedOnLinear(l.item.label, $0) } }.first
            out.twins[PipelineRead.norm(issue)] = .some(held)
        }
        return out
    }

    /// What merging `pr`, read again with `Gate`, would close: whether it closes an open
    /// issue (unless taken over) and each one is a candidate, and what no read judged. GitHub
    /// also closes the issues a closing word names in its title or a commit message. Each is
    /// judged as these fresh reads have it, whatever the sync's first read saw.
    func freshCloses(_ pr: PipelineEntry, linear: LinearJudged) -> (fixes: Bool, unjudged: [String]) {
        let closing = pr.closing.filter(open) + linear.closing
        var unjudged = pr.closingPast ? ["issues past what one read lists"] : []
        let listed = Set(pr.closing.map { PipelineRead.norm($0.id) })
        unjudged += pr.closesText.filter { !listed.contains($0) }
        unjudged += linear.unjudged + pr.closesLinear.filter { !linear.seen.contains($0) }
        if !settings.linearTeams.isEmpty {
            unjudged += pr.closing.filter { open($0) && linear.twins[PipelineRead.norm($0.id)] == nil }
                .map { "the Linear issues linking \($0.item.label)" }
        }
        // One an earlier merge closed may still read open: GitHub and Linear close it a moment later.
        return ((!closing.isEmpty || takenOver(pr)) && closing.allSatisfy {
            !closedHere.contains(PipelineRead.norm($0.id)) && isCandidate($0, for: pr)
                && (linear.twins[PipelineRead.norm($0.id)] ?? nil) == nil
        }, unjudged)
    }

    func triaged(_ e: PipelineEntry) -> String? {
        if let state = e.triageState { return state }
        if let type = e.issueType, type.lowercased() != "bug" { return type }
        let triage = Set(model.triageLabels.flatMap(Self.triageForms))
        return e.labels.first { !triage.isDisjoint(with: Self.triageForms($0)) }
    }

    /// `label` as triage matches it: lowercased, its words split at every character but a
    /// letter or digit (`🚧 WIP`, `[wip]`, `do_not-merge`), and with a `prefix:` or
    /// `prefix/`, each side of it (`type: Feature`, `kind/feature`,
    /// `enhancement: pending triage`).
    static func triageForms(_ label: String) -> [String] {
        let s = label.lowercased()
        let sides = s.firstIndex { $0 == ":" || $0 == "/" }.map { [s[..<$0], s[$0...].dropFirst()] } ?? [Substring(s)]
        return sides.map { $0.split { !$0.isLetter && !$0.isNumber }.joined(separator: " ") }
    }

    /// Already split or being fixed: a rating would route it nowhere.
    func settled(_ e: PipelineEntry) -> Bool {
        has(e, model.labels.fractured) || !e.children.isEmpty || !fixers(e).isEmpty
    }

    /// A fast-track PR, not taken over, at a clean head this Diplomat has not rated again:
    /// each head is rated again once, whatever the answer.
    func awaitingRerate(_ e: PipelineEntry) -> Bool {
        guard !takenOver(e), own(e), open(e), e.item.writable, has(e, model.labels.fastTrack),
              let head = reviewed(e), e.item.cleanAt == head, rerates[e.id]?[head] == nil,
              let r = e.item.rating, r.atLeast(e.item.floor ?? r).fits(limit(e)),
              offTrack(e) == nil else { return false }
        return closesHold(e) == nil
    }

    /// `cleared`, with a clean marker at its `reviewed` head, at which this Diplomat rated it
    /// within its limit again, or, taken over, put `cleared` on. The label alone is no proof of
    /// either: anyone with triage rights can add it.
    func clearedByMe(_ e: PipelineEntry) -> Bool {
        guard has(e, model.labels.cleared), let head = reviewed(e), e.item.cleanAt == head else { return false }
        return takenOver(e) ? state.cleared[e.id] == head : rerates[e.id]?[head]?.fits(limit(e)) == true
    }

    /// The head a PR's clean marker, second rating and clear count at: its own, or for a head
    /// carrying a cleared change, the head it was cleared at (`carrySyncs`).
    func reviewed(_ e: PipelineEntry) -> String? {
        guard let head = e.item.headSha, !head.isEmpty else { return nil }
        return state.synced[e.id]?[head] ?? head
    }

    func newer(_ a: Int, _ b: Int) -> Bool {
        let x = entries[a].item.updatedAt ?? .distantPast, y = entries[b].item.updatedAt ?? .distantPast
        return x != y ? x > y : entries[a].id < entries[b].id
    }

    func rateRefusal(_ e: PipelineEntry) -> String? {
        if e.item.kind == .pr && !(own(e) && open(e)) { return "only my own open PRs are" }
        if !open(e) { return "it is \(e.item.state)" }
        if e.root == nil { return "Linear team \(e.item.repo) has no root to read its code in" }
        if let why = e.root.flatMap({ partial[$0.slug] }) { return why }
        return banHold(e) ?? stops(e).first.map { "it carries the label \($0)" }
    }

    func rate() {
        var forced: [Int] = []
        for id in settings.force?.rate ?? [] {
            guard let i = pos[id] else {
                notice("\(id) was not read, so it was not rated")
                continue
            }
            if let why = rateRefusal(entries[i]) {
                notice("\(entries[i].item.label) was not rated: \(why)")
            } else if !forced.contains(i) {
                forced.append(i)
            }
        }
        answers()
        // A Rate now ask refused now, or of an item gone from a whole read, is dropped; one
        // whose PR was pushed to, or whose job is gone, is asked again.
        for (id, a) in state.rateAsks.sorted(by: { $0.key < $1.key }) where a.forced {
            guard let i = pos[id], !waits(entries[i]) else {
                if pos[id] == nil && readAll { state.rateAsks[id] = nil }
                continue
            }
            guard may(.forced) else { break }
            if let why = rateRefusal(entries[i]) {
                notice("\(entries[i].item.label) was not rated: \(why)")
                state.rateAsks[id] = nil
            } else if a.head != head(entries[i]) || !queued(id, a) {
                state.rateAsks[id] = nil
                if !forced.contains(i) { forced.append(i) }
            }
        }
        let idx = settings.rate ? entries.indices.filter { eligible(entries[$0]) && !backingOff(entries[$0].id) } : []
        let pending = idx.filter {
            cache[entries[$0].id]?.pending == true && entries[$0].item.writable && open(entries[$0])
        }
        let bands = [0, 1, 2, 3].map { band in
            idx.filter { self.band(entries[$0]) == band && !state.declined.contains(entries[$0].id) }.sorted(by: newer)
        }
        for i in forced { ask(i, forced: true) }
        for i in pending where !forced.contains(i) { finish(i) }
        // With Rate off nothing is wanted: each ask of an item read whole is dropped.
        let wanted = Set(bands.joined())
        var waiting = 0
        for (id, a) in state.rateAsks.sorted(by: { $0.key < $1.key }) where !a.forced {
            guard let i = pos[id], !waits(entries[i]) else {
                if pos[id] == nil && readAll { state.rateAsks[id] = nil } else { waiting += 1 }
                continue
            }
            if wanted.contains(i) && a.head == head(entries[i]) && a.again == awaitingRerate(entries[i]) && queued(id, a) {
                waiting += 1
            } else {
                state.rateAsks[id] = nil
            }
        }
        guard settings.rate else { return persist() }
        // A first rating pushed past is rated again only once its answer could be applied.
        for i in bands.joined() where waiting < model.rater.asks && !forced.contains(i)
            && state.rateAsks[entries[i].id] == nil && (entries[i].item.writable || !rateAgain(entries[i])) {
            if ask(i, forced: false) { waiting += 1 }
        }
        persist()
    }

    /// Whether this sync's read of `e` is too partial to judge its ask by: the ban list
    /// unread, or its root read in part.
    func waits(_ e: PipelineEntry) -> Bool {
        banned == nil || e.root.map { partial[$0.slug] != nil } ?? false
    }

    /// Whether the job of ask `a` is still there to run, or has answered.
    func queued(_ id: String, _ a: PipelineRateAsk) -> Bool {
        PipelineRateJob.load(id, a.stamp, in: dir) != nil || PipelineRateJob.answered(id, a.stamp, in: dir)
    }

    /// Not held from a rating by its author, a stop label or a root read with errors.
    func eligible(_ e: PipelineEntry) -> Bool {
        banHold(e) == nil && stops(e).isEmpty && e.root.map { partial[$0.slug] == nil } ?? true
    }

    /// Where `e` stands in the order a sync asks for ratings, nil for none: a fast-track PR
    /// at its clean head, an unrated PR of mine or one to be rated again (`rateAgain`), an
    /// unrated issue Diplomat may write to, another unrated issue.
    func band(_ e: PipelineEntry) -> Int? {
        if settings.fastTrack && awaitingRerate(e) { return 0 }
        guard e.item.rating == nil || rateAgain(e), open(e) else { return nil }
        if e.item.kind == .pr { return own(e) ? 1 : nil }
        guard e.root != nil, !settled(e) else { return nil }
        return e.item.writable ? 2 : 3
    }

    /// The head a rating of `e` reads the diff at; nil for an issue.
    func head(_ e: PipelineEntry) -> String? { e.item.kind == .pr ? e.item.headSha : nil }

    /// Applies each answer a rating job left for a current ask, in the order they were
    /// asked for, and drops each ask an answer shows is no longer worth applying. An answer
    /// for an item this sync did not read in full, or that a switch keeps from applying
    /// now, waits; one at a head the item has left is `rate`'s to drop.
    func answers() {
        let current = PipelineRateJob.answers(in: dir).filter { state.rateAsks[$0.item]?.stamp == $0.stamp }
        for answer in current.sorted(by: { asked(state.rateAsks[$0.item]!, before: state.rateAsks[$1.item]!) }) {
            guard let a = state.rateAsks[answer.item], let i = pos[answer.item], !waits(entries[i]) else { continue }
            let id = answer.item
            if answer.cancelled == true {
                state.rateAsks[id] = nil
                if !state.declined.contains(id) { state.declined.append(id) }
                persist()
                continue
            }
            guard a.head == head(entries[i]), may(a.forced ? .forced : .rate) else { continue }
            state.rateAsks[id] = nil
            persist()
            let current = a.forced ? rateRefusal(entries[i]) == nil
                : eligible(entries[i]) && band(entries[i]) != nil && a.again == awaitingRerate(entries[i])
            if current { rated(i, answer.exit, a) }
        }
    }

    /// Finishes the rating kept pending for `entries[i]`, never lower than the labels on it
    /// now, with no new rating asked for. A PR's is dropped once its diff at the head this sync
    /// read allows less.
    func finish(_ i: Int) {
        let id = entries[i].id
        guard let kept = cache[id]?.rating, !rateAgain(entries[i]), may(.rate) else { return }
        let head = entries[i].item.headSha
        guard recheck(i), entries[i].item.headSha == head else { return failed(id) }
        guard stops(entries[i]).isEmpty else { return }
        let rating = atLeastLabels(kept, entries[i].labels)
        if entries[i].item.kind == .pr {
            guard let head, let out = diff(entries[i], at: head), out.ok else { return failed(id) }
            let floor = (entries[i].item.floor ?? PipelineRating(risk: .high, complexity: .high))
                .atLeast(PipelineGate.diffFloor(String(decoding: out.stdout, as: UTF8.self),
                                                diffChars: model.rater.diffChars).rating)
            guard rating.atLeast(floor) == rating else {
                cache[id] = nil
                notice("\(entries[i].item.label): the rating kept for it is below what its diff allows now, so it was dropped")
                return persist()
            }
        }
        if !unworn(entries[i].labeled) { cache[id]?.first = nil }
        cache[id]?.rating = rating
        state.retry[id] = nil
        entries[i].item.rating = rating
        entries[i].item.ratedBy = "local"
        apply(i, rating)
    }

    /// What a finished rating leads to: its labels where mirrored, then the fast-track label
    /// at a PR's first rating.
    func apply(_ i: Int, _ rating: PipelineRating) {
        cache[entries[i].id]?.pending = nil
        persist()
        if mirrors(entries[i], control()), !writeRating(i, rating, .mirror) { failed(entries[i].id) }
        trackFirst(i, rating)
    }

    /// Writes the kept ratings as labels where they are mirrored and the labels do not say so
    /// yet, the PRs first, then the newest: `labels.mirrorPerSync` a sync.
    func mirror() {
        guard may(.mirror) else { return }
        let c = control()
        let owed = entries.indices.filter {
            let e = entries[$0]
            guard let kept = cache[e.id], kept.pending != true, mirrors(e, c), banHold(e) == nil,
                  stops(e).isEmpty, !backingOff(e.id), e.root.map({ partial[$0.slug] == nil }) ?? true
            else { return false }
            return !wears(e.labels, atLeastLabels(kept.rating, e.labels))
        }.sorted { a, b in
            entries[a].item.kind == entries[b].item.kind ? newer(a, b) : entries[a].item.kind == .pr
        }
        for i in owed.prefix(model.labels.mirrorPerSync) {
            let id = entries[i].id
            guard recheck(i) else {
                failed(id)
                continue
            }
            guard let kept = cache[id]?.rating, mirrors(entries[i], control()), stops(entries[i]).isEmpty else { continue }
            if writeRating(i, atLeastLabels(kept, entries[i].labels), .mirror) { state.retry[id] = nil } else { failed(id) }
            persist()
        }
    }

    /// `e`'s three-dot diff against its base, as `gh pr diff` reads it but pinned to `head`;
    /// nil outside a root.
    func diff(_ e: PipelineEntry, at head: String) -> PipelineIO.Exit? {
        guard let root = e.root else { return nil }
        let base = e.baseRef.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? e.baseRef
        return io.gh(["api", "-H", "Accept: application/vnd.github.diff", "repos/\(root.name)/compare/\(base)...\(head)"])
    }

    /// Asks a queued job to rate `entries[i]`: its call saved in `rate/` and the ask in the
    /// state, for `owed` to hand the front-end. An ask at its current head stands, Rate now
    /// marking it forced. False when it was not asked.
    @discardableResult
    func ask(_ i: Int, forced: Bool) -> Bool {
        let e = entries[i]
        guard let root = e.root, may(forced ? .forced : .rate) else { return false }
        if let why = banHold(e) {
            notice("\(e.item.label) was not rated: \(why)")
            return false
        }
        if forced { state.declined.removeAll { $0 == e.id } }
        if let a = state.rateAsks[e.id], a.head == head(e) {
            if forced { state.rateAsks[e.id]?.forced = true }
            return true
        }
        var diff: String?
        if e.item.kind == .pr {
            let out = head(e).flatMap { self.diff(e, at: $0) }
            guard let out, out.ok else {
                notice("\(e.item.label) was not rated: its diff could not be read: \(out?.why ?? "it has no head")")
                failed(e.id)
                return false
            }
            diff = String(decoding: out.stdout, as: UTF8.self)
        }
        let floor = diff.map { PipelineGate.diffFloor($0, diffChars: model.rater.diffChars) }
        state.rateSeq += 1
        let job = PipelineRateJob(item: e.id, stamp: String(state.rateSeq),
                                  model: e.item.kind == .pr ? model.rater.prModel : model.rater.model,
                                  prompt: PipelineRater.ratePrompt(e, model),
                                  input: PipelineRater.input(e, diff: diff, model), cwd: root.path)
        guard job.save(in: dir) else {
            notice("\(e.item.label) was not rated: its rating could not be saved for the queue")
            return false
        }
        state.rateAsks[e.id] = PipelineRateAsk(stamp: job.stamp, head: head(e), again: awaitingRerate(e),
                                               forced: forced, floor: floor?.rating, reasons: floor?.reasons ?? [])
        persist()
        return true
    }

    /// The answer `out` to the ask `a` for `entries[i]`, labelled as a rating made in this
    /// sync is.
    func rated(_ i: Int, _ out: PipelineIO.Exit, _ a: PipelineRateAsk) {
        let e = entries[i]
        let step: Step = a.forced ? .forced : .rate
        let (again, head) = (a.again, a.head)
        let said: PipelineRating, why: String
        switch PipelineRater.rating(out) {
        case .failure(let f):
            notice("\(e.item.label) was not rated: \(f.message)")
            return failed(e.id)
        case .success(let answer):
            (said, why) = answer
        }
        state.retry[e.id] = nil
        let fresh = cache[e.id] == nil || rateAgain(e)
        // Never below its labels, nor the rating kept for it before.
        var rating = atLeastLabels(said.atLeast(cache[e.id]?.rating ?? said), e.labels)
        var detail = describe(rating) + (why.isEmpty ? "" : ": " + why)
        var floor = e.item.floor ?? PipelineRating(risk: .low, complexity: .low)
        var reasons = floorWhy[e.id] ?? []
        if let more = a.floor {
            floor = floor.atLeast(more)
            reasons += a.reasons
        }
        if rating.atLeast(floor) != rating {
            rating = rating.atLeast(floor)
            detail = describe(rating) + ", floored by its diff (" + reasons.joined(separator: "; ") + ")"
                + (why.isEmpty ? "" : ": " + why)
        }
        let counts = may(step) && banHold(e) == nil
        let allowed = counts && e.item.writable
        let first = counts && fresh && e.item.kind == .pr && may(.fastTrack)
        // Saved before what it leads to: a sync stopped there does not ask again.
        record(i, rating, why, detail, head: head, again: again, pending: allowed || first, first: first)
        guard allowed else { return }
        guard recheck(i), entries[i].item.headSha == e.item.headSha else { return failed(e.id) }
        // Left pending, for `finish` once the stop label is off.
        guard stops(entries[i]).isEmpty else { return }
        // A label put on meanwhile.
        if atLeastLabels(rating, entries[i].labels) != rating {
            rating = atLeastLabels(rating, entries[i].labels)
            record(i, rating, why, describe(rating) + ", as labelled meanwhile", head: head, again: again, pending: true,
                   first: first)
        }
        if !unworn(entries[i].labeled) { cache[e.id]?.first = nil }
        apply(i, rating)
    }

    func record(_ i: Int, _ rating: PipelineRating, _ why: String, _ detail: String, head: String?, again: Bool,
                pending: Bool, first: Bool) {
        let e = entries[i]
        if again, let head {
            state.rerated[e.id, default: [:]][head] = rating
            rerates[e.id, default: [:]][head] = rating
        }
        log(e.id, again ? .rerated : .rated, detail, head: head, rating: rating)
        cache[e.id] = PipelineCachedRating(rating: rating, why: why, pending: pending ? true : nil,
                                           first: first ? true : nil, head: head)
        entries[i].item.why = why
        entries[i].item.rating = rating
        entries[i].item.ratedBy = "local"
        persist()
    }

    /// Whether `labeled`, a PR's timeline, shows no rating or fast-track label ever on it.
    func unworn(_ labeled: Set<String>?) -> Bool {
        let history = PipelineLevel.allCases.flatMap { [model.labels.risk[$0], model.labels.complexity[$0]] }
            + [model.labels.fastTrack]
        return labeled?.isDisjoint(with: history.map { $0.lowercased() }) == true
    }

    /// Puts `fastTrack` on a PR rated within its limit that closes only candidates, at its first
    /// rating only: one rated before, or that wore a rating or fast-track label, is a person's.
    /// One it could not be put on, that would also close what no read judged, or that an older
    /// version left pending, its `first` set whatever the switch, is recorded.
    func trackFirst(_ i: Int, _ rating: PipelineRating) {
        let e = entries[i]
        guard e.item.kind == .pr, settings.fastTrack, rating.fits(limit(e)), cache[e.id]?.first == true,
              fixesCandidate(e) else { return }
        if let why = cache[e.id]?.head == nil ? "its first rating was left pending by an older version"
            : closesHold(e).map({ "at its first rating it " + $0.message }) {
            let hold = "off the fast track until taken over: " + why
            log(e.id, .held, hold)
            state.keptOff[e.id] = hold
            persist()
        } else if add(i, model.labels.fastTrack, .fastTrack) {
            log(e.id, .fastTrack, "+\(model.labels.fastTrack): rated \(describe(rating))")
        } else if !state.untracked.contains(e.id) {
            state.untracked.append(e.id)
            persist()
        }
    }

    func describe(_ r: PipelineRating) -> String {
        "\(r.risk.rawValue) risk, \(r.complexity.rawValue) complexity"
    }

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

    /// Why my fast-track PR is off the fast track until taken over. A takeover stands whatever
    /// it is rated, and forgot what came off it before.
    func offTrack(_ e: PipelineEntry) -> String? {
        let head = reviewed(e) ?? ""
        let taken = takenOver(e)
        let above = taken ? [:] : (rerates[e.id] ?? [:]).filter { !$0.value.fits(limit(e)) }
        if let h = above[head] != nil ? head : above.keys.sorted().first, let r = above[h] {
            return "re-rated \(describe(r)) at " + (h == head ? "this head" : String(h.prefix(7)))
        }
        if !has(e, model.labels.cleared),
           let h = state.cleared[e.id] ?? (!taken && clearsLogged.contains("\(e.id) \(head)") ? head : nil) {
            return "\(model.labels.cleared) came off it at \(h.prefix(7))"
        }
        return state.decided.contains(e.id) ? "Diplomat took it off the fast track" : nil
    }

    func track(_ i: Int) {
        let e = entries[i]
        let (ft, cl) = (model.labels.fastTrack, model.labels.cleared)
        guard own(e), open(e), e.item.writable, partial[e.item.repo] == nil else { return }
        // Its takeover put `ft` on: a person took it off since.
        if takenOver(e) && !has(e, ft) {
            state.takenOver[e.id] = nil
            log(e.id, .takeover, "takeover ended: \(ft) came off it")
            return persist()
        }
        guard has(e, ft) || has(e, cl) else { return }
        if let why = offTrack(e) {
            let off = recheck(i) ? [ft, cl].filter { has(entries[i], $0) && remove(i, $0, .fastTrack) } : []
            if !off.isEmpty { log(e.id, .labelled, off.map { "-" + $0 }.joined(separator: " ") + ": \(why), for a human") }
            if !state.decided.contains(e.id) { state.decided.append(e.id) }
            if state.takenOver.removeValue(forKey: e.id) != nil { log(e.id, .takeover, "takeover ended: \(why)") }
            return persist()
        }
        guard has(e, ft), let head = reviewed(e), e.item.cleanAt == head,
              takenOver(e) ? closesHold(e) == nil : rerates[e.id]?[head]?.fits(limit(e)) == true,
              !has(e, cl) || state.cleared[e.id] != head else { return }
        if !has(e, cl) {
            guard recheck(i), entries[i].item.headSha == e.item.headSha, has(entries[i], ft), add(i, cl, .fastTrack)
            else { return }
        }
        state.cleared[e.id] = head
        log(e.id, .cleared, "cleared at \(head.prefix(7))", head: head)
        persist()
    }

    /// Takes `cleared` off my fast-track PR whose head no clean marker names, nor carries a
    /// cleared change (`carrySyncs`), for a review of that head. One a person took off first is
    /// their opt-out, which `track` writes.
    func dropStaleClears() {
        for i in entries.indices {
            let e = entries[i]
            guard own(e), open(e), has(e, model.labels.fastTrack), has(e, model.labels.cleared),
                  partial[e.item.repo] == nil, let head = e.item.headSha, e.item.cleanAt != reviewed(e),
                  offTrack(e) == nil, may(.fastTrack), recheck(i) else { continue }
            let off = takeOff(i, model.labels.cleared, .fastTrack)
            // A failed call may have taken it off all the same.
            guard off == true || off == nil && refresh(i) && !has(entries[i], model.labels.cleared) else { continue }
            state.cleared[e.id] = nil
            state.synced[e.id] = nil
            if off == true {
                log(e.id, .labelled, "-\(model.labels.cleared): " + (e.item.cleanAt == nil
                    ? "no clean marker names its head \(head.prefix(7))"
                    : "the head moved to \(head.prefix(7)), past its clean marker"
                        + (uncarried[e.id].map { ": " + $0 } ?? "")))
            }
            persist()
        }
    }

    /// Keeps my cleared PR cleared at a head it moved to, as merging its base moves it, when
    /// that head's change is the one cleared (`changeDiffers`): its merge is then the change
    /// reviewed and rated, on its base as the base stands. Fast track's, as is taking a clear
    /// off a head that carries none.
    func carrySyncs() {
        guard blocked == nil, settings.fastTrack else { return }
        for e in entries {
            guard own(e), open(e), e.item.writable, partial[e.item.repo] == nil, let root = e.root,
                  has(e, model.labels.fastTrack), has(e, model.labels.cleared),
                  let head = e.item.headSha, !head.isEmpty, state.synced[e.id]?[head] == nil,
                  let from = state.cleared[e.id], from != head, e.markers.contains(from), offTrack(e) == nil
            else { continue }
            if let why = changeDiffers(root, e.baseRef, head, from) {
                uncarried[e.id] = why
                continue
            }
            state.synced[e.id, default: [:]][head] = from
            // No `head`: a clear the log names at a head is one a person took off once gone.
            log(e.id, .cleared, "cleared at \(head.prefix(7)): its change against \(e.baseRef) is the one cleared at "
                + from.prefix(7))
            persist()
        }
    }

    /// GitHub's compare lists at most this many files.
    static let compareFiles = 300

    /// Why a PR's change at `head` is not the one cleared at `from`, nil when it is: its diff
    /// against `baseRef` changes the same files to the same blobs at both, which hold each of
    /// those paths in the same mode (a compare lists no modes), and the base changed none of
    /// them since `from`. What cannot be read whole is a difference.
    func changeDiffers(_ root: PipelineSettings.Root, _ baseRef: String, _ head: String, _ from: String) -> String? {
        let unread = "its diff against \(baseRef) could not be read whole"
        func json(_ path: String) -> [String: Any]? {
            let out = io.gh(["api", "repos/\(root.name)/" + path])
            return out.ok ? (try? JSONSerialization.jsonObject(with: out.stdout)) as? [String: Any] : nil
        }
        func files(_ base: String, _ head: String) -> [[String]]? {
            guard let list = json("compare/\(base)...\(head)?per_page=1")?["files"] as? [[String: Any]],
                  list.count < Self.compareFiles else { return nil }
            return list.map { f in ["status", "previous_filename", "filename", "sha"].map { f[$0] as? String ?? "" } }
        }
        let base = baseRef.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? baseRef
        guard let now = files(base, head), let then = files(base, from), let since = files(from, base) else {
            return unread
        }
        let paths = Set(then.flatMap { $0[1...2] }).subtracting([""])
        if let path = since.flatMap({ $0[1...2] }).filter(paths.contains).min() {
            return "\(baseRef) changed \(path), which it changes too, since \(from.prefix(7))"
        }
        let differs = "its change against \(baseRef) is not the one cleared at \(from.prefix(7))"
        guard Set(now) == Set(then) else { return differs }
        // Each path's mode and object, nil for a tree GitHub cut short.
        func tree(_ sha: String) -> [String: String]? {
            guard let body = json("git/trees/\(sha)?recursive=1"), !PipelineRead.bool(body["truncated"], true),
                  let list = body["tree"] as? [[String: Any]] else { return nil }
            var out: [String: String] = [:]
            for t in list { if let p = t["path"] as? String { out[p] = "\(t["mode"] ?? "") \(t["sha"] ?? "")" } }
            return out
        }
        guard let at = tree(head), let was = tree(from) else { return unread }
        return paths.allSatisfy { at[$0] == was[$0] } ? nil : differs
    }

    // MARK: - Takeover

    func takenOver(_ e: PipelineEntry) -> Bool { state.takenOver[e.id] != nil }

    /// Applies the revokes pressed since this sync started, from `control.json`: right before
    /// each merge and the asks, so neither acts on a takeover taken back, an issue's included.
    func lateRevokes() {
        guard blocked == nil else { return }
        for id in PipelineControl.read(in: dir)?.revoke ?? [] where state.takenOver[id] != nil {
            revoke(id)
            lateRevoked.insert(id)
            if let i = pos[id] { entries[i].item.hold = "its takeover was revoked" }
        }
    }

    /// Forgets `id`'s takeover, if any; a PR's labels come off at `track`.
    func revoke(_ id: String) {
        guard let kind = state.takenOver.removeValue(forKey: id) else { return }
        if kind == .pr && !state.decided.contains(id) { state.decided.append(id) }
        log(id, .takeover, "takeover revoked from the Pipeline screen")
        persist()
    }

    /// Why `e` may not be taken over now. Never its rating, its triage, its diff floor or its
    /// being off the fast track, which a takeover stands past.
    func takeoverRefusal(_ e: PipelineEntry) -> String? {
        if let why = e.unwritable { return why }
        if e.root == nil { return "Linear team \(e.item.repo) has no root to fix it in" }
        if let why = e.root.flatMap({ partial[$0.slug] }) { return why }
        if let why = banHold(e) { return why }
        if let stop = stops(e).first { return "it carries the label \(stop)" }
        if e.item.kind == .pr {
            if !settings.fastTrack { return "Fast-track my PRs is off" }
            if let x = fixed(by: e).map({ entries[$0] }).first(where: { open($0) && !isCandidate($0, for: e, taken: true) }) {
                return "it closes \(x.item.label), which Diplomat may not fix: " + (fixRefusal(x) ?? "it is fixed in another root")
            }
            return closesHold(e, taken: true).map { "it " + $0.message }
        }
        if has(e, model.labels.fractured) || !e.children.isEmpty { return "it is split already" }
        if !fixers(e).isEmpty { return "an open PR fixes it" }
        if let issue = onGitHub(e) { return "it is tracked on GitHub as \(issue)" }
        return twinHold(e)
    }

    /// Why Diplomat may not fix `x`, whatever its rating or triage; nil when it may, in its root.
    func fixRefusal(_ x: PipelineEntry) -> String? {
        if let why = x.unwritable { return why }
        if let stop = stops(x).first { return "it carries the label \(stop)" }
        if let why = banHold(x) { return why }
        if let issue = onGitHub(x) { return "it is tracked on GitHub as \(issue)" }
        if let why = twinHold(x) ?? twinsUnread(x) { return why }
        return has(x, model.labels.fractured) || !x.children.isEmpty ? "it is split already" : nil
    }

    /// The operator's revokes, then takeovers. A revoke needs no read: it forgets the
    /// takeover, and a PR goes off the fast track until taken over again, which `track`
    /// writes to its labels. A takeover is recorded once a read right before refuses it
    /// nothing; a PR's once `fastTrack` is on it, which forgets what came off it before.
    func takeOver() {
        if let blocked {
            for id in settings.force?.revoke ?? [] { notice("\(id)'s takeover was not revoked: \(blocked)") }
            for id in settings.force?.takeover ?? [] { notice("\(id) was not taken over: \(blocked)") }
            return
        }
        for id in settings.force?.revoke ?? [] { revoke(id) }
        for id in settings.force?.takeover ?? [] where state.takenOver[id] == nil {
            guard let i = pos[id] else {
                notice("\(id) was not read, so it was not taken over")
                continue
            }
            if let why = takeoverRefusal(entries[i]) {
                notice("\(entries[i].item.label) was not taken over: \(why)")
                continue
            }
            guard may(.forced), recheck(i) else { continue }
            let e = entries[i]
            if let why = takeoverRefusal(e) {
                notice("\(e.item.label) was not taken over: \(why)")
                continue
            }
            if e.item.kind == .pr {
                guard add(i, model.labels.fastTrack, .fastTrack) else {
                    notice("\(e.item.label) was not taken over: \(model.labels.fastTrack) could not be put on")
                    continue
                }
                state.decided.removeAll { $0 == id }
                state.untracked.removeAll { $0 == id }
                state.keptOff[id] = nil
                state.cleared[id] = nil
            }
            state.takenOver[id] = e.item.kind
            log(id, .takeover, "taken over from the Pipeline screen, whatever its rating")
            persist()
        }
    }

    // MARK: - Fracture

    func fracture() {
        resumeSplits()
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
                // A takeover is for the issue as it stands.
                guard !picks.contains(i), !takenOver(e), fractureRefusal(e) == nil, state.unsplit[e.id] == nil,
                      !backingOff(e.id), let r = e.item.rating else { return false }
                return r.complexity > limit(e).complexity && r.risk != .high
            }.sorted(by: newer)
            picks += auto.prefix(1)
        }
        for (n, i) in picks.enumerated() { fractureOne(i, n < forced ? .forced : .fracture) }
    }

    func fractureRefusal(_ e: PipelineEntry) -> String? {
        if e.item.kind != .issue { return "it is not an issue" }
        if let why = e.unwritable { return why }
        if has(e, model.labels.fractured) || !e.children.isEmpty { return "it is split already" }
        return partRefusal(e) ?? e.root.flatMap { incomplete[$0.slug] ?? partial[$0.slug] } ?? twinsUnread(e)
    }

    /// Why no part of an issue claimed for a split may be filed now.
    func partRefusal(_ e: PipelineEntry) -> String? {
        if !fixers(e).isEmpty { return "an open PR fixes it" }
        if e.linksPast { return Self.linksPast }
        if let t = triaged(e) { return "triaged as \(t)" }
        if let stop = stops(e).first { return "it carries the label \(stop)" }
        if let issue = onGitHub(e) { return "it is tracked on GitHub as \(issue)" }
        if let why = twinHold(e) { return why }
        if e.root == nil { return "Linear team \(e.item.repo) has no root to read its code in" }
        return banHold(e)
    }

    static let claimHeld = "it was claimed for a split, which did not happen"
    static let linksPast = "it has more attachments than one read lists, so a PR fixing it might not be seen"

    /// Each split a sync stopped in before it finished: the rest of its parts filed, once the
    /// model named them, at a sync that read its root whole; else its claim taken back, and
    /// the split tried again later, when it filed no part, or held, naming the parts.
    func resumeSplits() {
        for (id, made) in state.splitting.sorted(by: { $0.key < $1.key }) {
            guard let i = pos[id], open(entries[i]) else { continue }
            let parts = made + entries[i].children.filter { !made.contains($0) }
            if let answer = state.parts[id] {
                let step: Step = answer.forced ? .forced : .fracture
                guard may(step), entries[i].root.flatMap({ incomplete[$0.slug] ?? partial[$0.slug] }) == nil
                else { continue }
                state.splitting[id] = parts
                file(i, step)
                continue
            }
            if !parts.isEmpty {
                state.unsplit[id] = "split stopped after filing \(parts.joined(separator: ", "))"
            } else if refresh(i), remove(i, model.labels.fractured, .undo) {
                if [nil, Self.claimHeld].contains(state.unsplit[id]) {
                    state.unsplit[id] = nil
                    notice("\(entries[i].item.label): a split stopped before it filed a part, so its claim was taken back")
                    failed(id)
                }
            } else {
                state.unsplit[id] = state.unsplit[id] ?? Self.claimHeld
                persist()
                continue
            }
            state.splitting[id] = nil
            persist()
        }
    }

    /// Splits one issue, read again first, claiming it with `fractured`, a claim the state
    /// records before it is made, and saving the model's answer before the first part is filed:
    /// a split that files no part, nor may have, takes the claim back, and one stopped part-way
    /// keeps it, with a hold naming the parts, so no part is filed twice.
    func fractureOne(_ i: Int, _ step: Step) {
        guard let root = entries[i].root, may(step), recheck(i) else { return }
        let e = entries[i]
        if let why = fractureRefusal(e) { return notice("\(e.item.label) was not split: \(why)") }
        state.splitting[e.id] = []
        persist()
        guard add(i, model.labels.fractured, step) else {
            failed(e.id)
            // A call that failed may have put the claim on all the same.
            return release(i, nil)
        }
        guard may(step) else { return release(i, nil) }
        if let why = banHold(e) {
            notice("\(e.item.label) was not split: \(why)")
            return release(i, nil)
        }
        let out = io.claude(PipelineRater.arguments(model: model.rater.model, schema: model.fractureSchema,
                                                    prompt: PipelineRater.fracturePrompt(e, model)),
                            Data(PipelineRater.input(e, diff: nil, model).utf8), root.path,
                            model.rater.timeoutSecs)
        let parts: [(title: String, body: String)], why: String
        switch PipelineRater.parts(out, max: model.fracture.maxChildren) {
        case .failure(let f):
            notice("\(e.item.label) was not split: \(f.message)")
            failed(e.id)
            return release(i, nil)
        case .success(let answer):
            (parts, why) = answer
        }
        guard parts.count > 1 else {
            let held = "would not split: " + (parts.isEmpty
                ? (why.isEmpty ? "the model named no parts" : why)
                : "the model named one part" + (why.isEmpty ? "" : ": " + why))
            log(e.id, .held, held)
            state.unsplit[e.id] = held
            persist()
            return release(i, held)
        }
        state.parts[e.id] = PipelineParts(parts: parts.map { .init(title: $0.title, body: $0.body) }, why: why,
                                          forced: step == .forced, at: CommsLog.isoString(now))
        persist()
        file(i, step)
    }

    /// Files the parts the model named for `entries[i]`, from the first not filed yet.
    func file(_ i: Int, _ step: Step) {
        let e = entries[i]
        guard let answer = state.parts[e.id] else { return }
        var made = state.splitting[e.id] ?? []
        func stop(_ why: String) {
            guard !made.isEmpty else {
                notice("\(e.item.label) was not split: \(why)")
                // The next sync files this answer, taking its first part if made.
                return state.parts[e.id]?.sent == true ? persist() : release(i, nil)
            }
            // Never retried unforced: a second split would file the made parts again.
            state.splitting[e.id] = nil
            state.parts[e.id] = nil
            state.unsplit[e.id] = "split stopped after \(made.count) of \(answer.parts.count) parts"
                + " (\(made.joined(separator: ", "))): \(why)"
            notice("\(e.item.label): \(state.unsplit[e.id]!)")
            persist()
        }
        for (k, part) in answer.parts.enumerated().dropFirst(made.count) {
            guard may(step) else { return stop("the switch was turned off") }
            let child = createChild(i, k + 1, (part.title, part.body))
            if let url = child.url {
                made.append(url)
                state.splitting[e.id] = made
                log(e.id, .child, "\(url): \(partTitle(part.title))")
                persist()
            }
            if let why = child.failure {
                if made.isEmpty { failed(e.id) }
                return stop(why)
            }
        }
        state.splitting[e.id] = nil
        state.parts[e.id] = nil
        state.unsplit[e.id] = nil
        state.retry[e.id] = nil
        log(e.id, .fractured, "split into \(made.count) parts" + (answer.why.isEmpty ? "" : ": " + answer.why))
        persist()
    }

    /// Takes `entries[i]`'s split claim back, read again first, and holds it `why`, or with no
    /// `why` tries the split again later; a claim it cannot take back holds it.
    func release(_ i: Int, _ why: String?) {
        let id = entries[i].id
        state.unsplit[id] = why
        state.parts[id] = nil
        if refresh(i), remove(i, model.labels.fractured, .undo) {
            state.splitting[id] = nil
        } else if why == nil {
            state.unsplit[id] = Self.claimHeld
        }
        persist()
    }

    /// The model wrote it from untrusted text.
    func fromModel(_ text: String) -> String {
        PipelineRater.inert(CommsText.defang(PipelineRater.unmarked(text, cleanMarker: model.cleanMarker),
                                             marker: PipelineRater.fence))
    }

    func partTitle(_ title: String) -> String { String(fromModel(CommsText.oneLine(title)).prefix(200)) }

    /// The `k`th part of `entries[i]`: its URL once made, recorded at once, and why it was not
    /// made or not linked. Its body ends with a line naming the parent and a hidden marker
    /// naming the answer and whose text it carries, which every read takes its lineage from.
    /// On GitHub the marker finds a part an earlier try of the answer filed, which is taken
    /// rather than filed again; Linear files it as the parent's child in one call, so a part a
    /// failed call made is found among the new children.
    func createChild(_ i: Int, _ k: Int, _ part: (title: String, body: String)) -> (url: String?, failure: String?) {
        guard recheck(i) else { return (nil, "\(entries[i].item.label) could not be read again, or changed") }
        let e = entries[i]
        if let why = partRefusal(e) { return (nil, why) }
        let title = partTitle(part.title)
        let answered = state.parts[e.id]?.at
        let marker = PipelineRead.partMarker(k, of: e.id, by: banDimension(e), at: answered)
        let body = String(fromModel(part.body).prefix(4000)) + "\n\nPart of \(e.id)\n\n\(marker)"
        func made(_ url: String) {
            state.lineage[url] = banDimension(e)
            state.seen[url] = now
            persist()
        }
        func sent(_ maybe: Bool) {
            state.parts[e.id]?.sent = maybe
            persist()
        }
        switch e.item.source {
        case .github:
            guard let root = e.root, let parent = e.nodeID else { return (nil, "no repository to file it in") }
            // An answer saved without `at` was filed under markers naming none, or, older, no lineage.
            let markers = answered != nil ? [marker]
                : ["<!-- Diplomat: part \(k) of \(e.id) by ", "<!-- Diplomat: part \(k) of \(e.id) -->"]
            func filed() -> (part: (url: String, node: String, linked: Bool)?, failure: String?) {
                let r = graphql(root, "Parts", ["-f", "me=\(root.me)"])
                guard let response = r.response, r.errors.isEmpty else { return (nil, r.why) }
                let repo = (response["data"] as? [String: Any])?["repository"] as? [String: Any]
                for n in PipelineRead.nodes(repo, "issues") {
                    let text = n["body"] as? String ?? ""
                    guard markers.contains(where: text.contains), let url = n["url"] as? String,
                          let node = n["id"] as? String else { continue }
                    return ((url, node, n["parent"] is [String: Any]), nil)
                }
                return (nil, nil)
            }
            var found = filed()
            if let why = found.failure { return (nil, "the parts filed before could not be read: \(why)") }
            var why = ""
            if found.part == nil {
                sent(true)
                let out = io.gh(["api", "-X", "POST", "repos/\(root.name)/issues", "-f", "title=\(title)",
                                 "-f", "body=\(body)"])
                let answer = (try? JSONSerialization.jsonObject(with: out.stdout)) as? [String: Any]
                if out.ok, let url = answer?["html_url"] as? String, let node = answer?["node_id"] as? String {
                    found.part = (url, node, false)
                } else {
                    // GitHub may have made it all the same.
                    why = out.why
                    found = filed()
                    if found.part == nil && found.failure == nil { sent(false) }
                }
            }
            guard let child = found.part else { return (nil, "the issue may not have been created: \(why)") }
            made(child.url)
            if child.linked { return (child.url, nil) }
            let mutation: String
            do { mutation = try CoreAssets.graphql("pipeline-add-sub-issue") } catch {
                return (child.url, "\(child.url) was created, but \(error.localizedDescription)")
            }
            let link = io.gh(["api", "graphql", "-f", "query=\(mutation)", "-f", "issueId=\(parent)",
                              "-f", "subIssueId=\(child.node)"])
            let linked = (try? JSONSerialization.jsonObject(with: link.stdout)) as? [String: Any]
            guard link.ok, linked?["errors"] == nil else {
                return (child.url, "\(child.url) was created but not made a sub-issue: \(link.why)")
            }
            return (child.url, nil)
        case .linear:
            guard let api = linear, let team = e.teamID, let parent = e.nodeID else {
                return (nil, "no Linear team to file it in")
            }
            let before = e.children
            sent(true)
            do {
                let data = try api.call("IssueCreate", ["teamId": team, "title": title,
                                                        "description": body, "parentId": parent])
                guard let url = ((data["issueCreate"] as? [String: Any])?["issue"] as? [String: Any])?["url"]
                    as? String else { throw LinearAPI.Failure.api("Linear created no issue") }
                made(PipelineRead.linearURL(url))
                return (PipelineRead.linearURL(url), nil)
            } catch {
                let read = refresh(i)
                let new = entries[i].children.filter { !before.contains($0) }
                if read && new.isEmpty { sent(false) }
                guard new.count == 1 else { return (nil, error.localizedDescription) }
                made(new[0])
                return (new[0], nil)
            }
        }
    }

    // MARK: - Stages

    /// Every open item's stage, lane and hold, PRs first since a fixed issue's lane is
    /// its PR's.
    func settle() {
        for i in entries.indices where entries[i].item.kind == .pr && open(entries[i]) {
            let e = entries[i]
            let head = reviewed(e) ?? ""
            let atHead = !head.isEmpty && e.item.cleanAt == head
            var hold: String?
            let stage: PipelineStage
            let floor = e.item.floor ?? PipelineRating(risk: .low, complexity: .low)
            if !own(e) || !has(e, model.labels.fastTrack) {
                stage = e.item.rating == nil ? .unrated : .human
                if own(e), let r = e.item.rating, r.atLeast(floor).fits(limit(e)) {
                    hold = e.unwritable.map { "off the fast track: \($0)" }
                        ?? (rateAgain(e) && state.declined.contains(e.id)
                            ? "off the fast track until Rate now: the rating asked at its new head was cancelled"
                            : cache[e.id]?.pending == true ? "off the fast track until a sync reads it again"
                            : !state.untracked.contains(e.id) ? state.keptOff[e.id]
                            : "off the fast track: \(model.labels.fastTrack) could not be put on at its first rating")
                }
            } else if let why = partial[e.item.repo] {
                // Missing labels, reviews or comments would read as a person's step, or no one's.
                stage = clearedByMe(e) ? .cleared : atHead ? .clean : .fastTrack
                hold = why
                if stage == .cleared { noteHold(i, "partial", why) }
            } else if let why = offTrack(e) {
                stage = .human
                hold = "off the fast track until taken over: \(why)"
            } else if !takenOver(e), e.item.rating == nil {
                stage = .unrated
            } else if !takenOver(e), let r = e.item.rating, !r.fits(limit(e)) {
                stage = .human
                hold = "off the fast track: it is " + PipelineGate.Hold.rated(r).message
            } else if !takenOver(e), !floor.fits(limit(e)) {
                stage = .human
                hold = "off the fast track: " + PipelineGate.Hold.floor(floor).message
            } else if clearedByMe(e) {
                stage = .cleared
                let code: String?
                if let stop = stops(e).first {
                    (code, hold) = (PipelineGate.Hold.stopLabel(stop).code, PipelineGate.Hold.stopLabel(stop).message)
                } else if state.rateAsks[e.id] != nil {
                    (code, hold) = ("rating-asked", Self.ratingAsked)
                } else if let h = mergeHold(e, fixes: fixesCandidate(e), unjudged: closesUnwritable(e)) {
                    (code, hold) = (h.code, h.message)
                } else if let why = e.unwritable {
                    (code, hold) = ("unwritable", why)
                } else if mergeFlag(e) == nil {
                    (code, hold) = ("no-method", "its repository allows none of squash, merge or rebase")
                } else {
                    code = nil
                }
                // `merge` logs what it does with a draft.
                if code == PipelineGate.Hold.draft.code { holdCodes[e.id] = code } else { noteHold(i, code, hold) }
            } else if let h = closesHold(e) {
                stage = .human
                hold = "off the fast track: it " + h.message
            } else {
                stage = atHead ? .clean : .fastTrack
                hold = e.unwritable.map { "on the fast track, but \($0)" }
            }
            if atHead && state.clean[e.id] != head && [.clean, .cleared].contains(stage) {
                log(e.id, .clean, "clean marker at \(head.prefix(7))")
                state.clean[e.id] = head
            }
            entries[i].item.stage = stage
            entries[i].item.lane = [.fastTrack, .clean, .cleared].contains(stage) ? .fast
                : stage == .unrated ? .unrated : .human
            entries[i].item.hold = banHold(e) ?? stops(e).first.map { PipelineGate.Hold.stopLabel($0).message } ?? hold
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
            } else if takenOver(e) && e.item.writable && onGitHub(e) == nil && twinHold(e) == nil {
                (stage, lane) = (.candidate, .fast)
                hold = candidateHold(e)
            } else if let r = e.item.rating {
                if r.fits(limit(e)) && e.item.writable && triaged(e) == nil && onGitHub(e) == nil && twinHold(e) == nil {
                    (stage, lane) = (.candidate, .fast)
                    hold = candidateHold(e)
                } else {
                    (stage, lane) = (.human, .human)
                }
            } else {
                (stage, lane) = (.unrated, .unrated)
            }
            // Rated or not; a takeover stands whatever its triage.
            let refused: String? = (takenOver(e) ? nil : triaged(e).map { "triaged as \($0)" })
                ?? stops(e).first.map { "carries the label \($0)" }
                ?? onGitHub(e).map { "it is tracked on GitHub as \($0)" } ?? twinHold(e) ?? (e.linksPast ? Self.linksPast : nil)
            entries[i].item.stage = stage
            entries[i].item.lane = lane
            entries[i].item.hold = banHold(e) ?? refused ?? hold
            entries[i].item.splitFrom = lineage(e)
        }
    }

    /// The GitHub issue a Linear issue's attachment links, as `owner/repo#N`: Linear's
    /// GitHub sync links the two, and the work is the GitHub issue's.
    func onGitHub(_ e: PipelineEntry) -> String? {
        guard e.item.source == .linear else { return nil }
        return e.links.lazy.compactMap(Self.githubIssue).first
    }

    static func githubIssue(_ link: String) -> String? {
        guard let url = URL(string: link), url.host?.lowercased() == "github.com" else { return nil }
        let path = url.path.split(separator: "/")
        return path.count == 4 && path[2] == "issues" && Int(path[3]) != nil ? "\(path[0])/\(path[1])#\(path[3])" : nil
    }

    /// Why a tracked Linear issue holds the GitHub issue it is attached to: its own holds on
    /// whose work it is, but being tracked on GitHub.
    func twinRefusal(_ l: PipelineEntry) -> String? {
        l.unwritable ?? triaged(l).map { "triaged as \($0)" } ?? stops(l).first.map { "it carries the label \($0)" }
            ?? banHold(l)
    }

    static func trackedOnLinear(_ label: String, _ why: String) -> String { "it is tracked on Linear as \(label): \(why)" }

    func twinHold(_ x: PipelineEntry) -> String? {
        guard x.item.source == .github, x.item.kind == .issue, let n = x.number else { return nil }
        let keys = Set([Self.githubIssue(x.id), "\(x.item.repo)#\(n)"].compactMap { $0?.lowercased() })
        for i in keys.flatMap({ linearTwins[$0] ?? [] }).sorted() where open(entries[i]) {
            if let why = twinRefusal(entries[i]) { return Self.trackedOnLinear(entries[i].item.label, why) }
        }
        return nil
    }

    func twinsUnread(_ x: PipelineEntry) -> String? {
        guard x.item.source == .github, let why = x.root.flatMap({ linearShort[$0.slug] }) else { return nil }
        return "\(why), so a Linear issue tracking it might not be seen"
    }

    func candidateHold(_ e: PipelineEntry) -> String? {
        guard let root = e.root else { return "Linear team \(e.item.repo) has no root to fix it in" }
        if let why = incomplete[root.slug] { return "\(why), so a PR fixing it might not be seen" }
        if let why = partial[root.slug] ?? twinsUnread(e) { return why }
        if cache[e.id]?.pending == true && !takenOver(e) { return "its rating waits for a sync that reads it again" }
        if state.rateAsks[e.id] != nil { return Self.ratingAsked }
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

    /// `upToDate`: as it would be with its base merged into it.
    func mergeHold(_ e: PipelineEntry, fixes: Bool, unjudged: [String], upToDate: Bool = false) -> PipelineGate.Hold? {
        PipelineGate.hold(PipelineGate.Candidate(
            state: e.item.state, author: e.item.author ?? "", isCrossRepository: e.isCrossRepository,
            baseRef: e.baseRef, defaultBranch: e.defaultBranch, participants: e.participants,
            participantsUnseen: e.participantsUnseen, reviewDecision: e.reviewDecision,
            unresolvedThreads: e.unresolvedThreads, rating: e.item.rating,
            floor: e.item.floor ?? PipelineRating(risk: .high, complexity: .high),
            mergeable: e.mergeable, headSha: e.item.headSha ?? "", ciCommit: e.ciCommit,
            ciState: e.ciState, operatorUntagged: e.operatorUntagged, reviewRequests: e.reviewRequests,
            foreignCommits: e.gate?.foreignCommits ?? [],
            trackLabels: has(e, model.labels.fastTrack) && has(e, model.labels.cleared),
            fixesCandidate: fixes, closesUnwritable: unjudged, ciRan: e.gate?.ciRan ?? true,
            wasReady: e.readied, mergeState: upToDate && e.mergeState == "BEHIND" ? "CLEAN" : e.mergeState,
            behindBy: upToDate ? 0 : e.gate.map(\.behindBy) ?? 0, mergeQueue: e.mergeQueue,
            stopLabels: stops(e),
            requiredChecks: e.gate.map(\.requiredChecks) ?? [], passedChecks: e.gate?.passedChecks ?? [],
            baseRules: e.gate.map(\.baseRules) ?? [], unsignedCommits: e.gate?.unsignedCommits ?? false,
            mergeFlag: mergeFlag(e) ?? "", takenOver: takenOver(e), limit: limit(e)),
            me: e.root?.me ?? "")
    }

    func mergeFlag(_ e: PipelineEntry) -> String? {
        repos[e.item.repo]?.mergeFlags.first { e.gate?.mergeFlags.contains($0) ?? true }
    }

    // MARK: - Merge

    /// The PR as GitHub has it now, read with `Gate`; nil (with a notice saying it `outcome`)
    /// when it could not be read whole.
    func reread(_ e: PipelineEntry, _ outcome: String = "was not merged") -> PipelineEntry? {
        guard let root = e.root, let n = e.number else { return nil }
        let r = graphql(root, "PullRequest", ["-F", "number=\(n)", "-f", "head=\(e.item.headSha ?? "")"])
        guard let response = r.response, r.errors.isEmpty,
              var fresh = PipelineRead.pullRequest(response, root: root, label: e.item.label,
                                                   roots: roots, model: model)
        else {
            notice("\(e.item.label) \(outcome): it could not be read again: \(r.why)")
            return nil
        }
        annotate(&fresh)
        return fresh
    }

    /// Each cleared PR no hold stops but being a draft or behind its base, read again: merged
    /// at exactly the head the sync read if nothing changed and nothing holds it now; a draft
    /// never ready before is marked ready instead, and merged at a later sync once nothing
    /// holds it; one behind its base that nothing else would hold has the base merged into
    /// it, for a later sync to carry its clear to the head that makes (`carrySyncs`).
    func merge() {
        for i in entries.indices where entries[i].item.stage == .cleared
            && [nil, PipelineGate.Hold.draft.code, PipelineGate.Hold.behind.code].contains(holdCodes[entries[i].id]) {
            let e = entries[i]
            guard let root = e.root, let n = e.number, let head = e.item.headSha, may(.merge) else { continue }
            mergeRead.insert(e.id)
            guard let read = reread(e) else { continue }
            // Linear first, so GitHub's last read sees whatever changed on the PR meanwhile.
            let judged = linearJudged(read)
            // Right before the hold is judged: the ban list goes into it.
            guard let fresh = linear == nil ? read : reread(e), may(.merge) else { continue }
            lateRevokes()
            if lateRevoked.contains(e.id) { continue }
            let flag = mergeFlag(fresh)
            let noMethod = "the rules on its base branch allow none of the merge methods its repository allows"
            var hold: (code: String, message: String)?
            // Behind: what would still hold it with its base merged in, "" for nothing.
            var upToDate: String?
            if fresh.item.headSha != head {
                hold = ("moved", "its head moved to \((fresh.item.headSha ?? "").prefix(7)) since this sync read it")
            } else if let why = offTrack(fresh) {
                hold = ("off-track", why)
            } else if !clearedByMe(fresh) {
                hold = ("not-cleared", "it is no longer cleared at its head")
            } else {
                let closes = freshCloses(fresh, linear: judged)
                let held = mergeHold(fresh, fixes: closes.fixes, unjudged: closes.unjudged)
                if held == .behind {
                    let after = mergeHold(fresh, fixes: closes.fixes, unjudged: closes.unjudged, upToDate: true)
                    upToDate = after.flatMap { $0 == .draft ? nil : $0.message } ?? fresh.unwritable
                        ?? (flag == nil ? noMethod : "")
                }
                let gate = held.map { (code: $0.code, message: $0.message) }
                hold = gate.flatMap { $0.code == PipelineGate.Hold.draft.code ? nil : $0 }
                    ?? fresh.unwritable.map { ("unwritable", $0) }
                    ?? (flag == nil ? ("no-method", noMethod) : nil)
                    ?? gate
            }
            if let hold, hold.code != PipelineGate.Hold.draft.code {
                var message = hold.message
                if let after = upToDate, !after.isEmpty {
                    message += "; " + after
                } else if upToDate != nil, may(.fastTrack), syncBase(fresh) {
                    message += "; GitHub was asked to merge \(fresh.baseRef) into it"
                }
                entries[i].item.hold = message
                noteHold(i, hold.code, message)
                continue
            }
            guard let flag else { continue }
            if hold != nil || fresh.isDraft {
                let ready = io.gh(["pr", "ready", "\(n)", "-R", root.name])
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
            state.merging[e.id] = PipelineMerge(head: head, flag: flag, at: now)
            persist()
            let out = io.gh(["pr", "merge", "\(n)", "-R", root.name, "--admin", flag,
                             "--match-head-commit", head])
            state.merging[e.id]?.merged = out.ok
            persist()
            closedHere.formUnion((fresh.closing + judged.closing).map { PipelineRead.norm($0.id) })
            // gh exits 0 on a PR merged already, at any head and by anyone, and GitHub may merge
            // one all the same when gh fails: only a read after tells this merge's.
            let after = reread(e, out.ok ? "may have been merged" : "was not merged (\(out.why))")
            guard let after, ended(e, after, head: head, flag: flag, ours: true, why: out.ok ? nil : out.why) else {
                continue
            }
            entries[i].item.state = "merged"
            entries[i].item.writable = false
            entries[i].unwritable = "merged"
            entries[i].item.stage = .merged
            entries[i].item.lane = .done
            entries[i].item.hold = nil
            for j in fixed(by: fresh) {
                entries[j].item.state = "closed"
                entries[j].item.writable = false
                entries[j].unwritable = "closed"
                entries[j].item.stage = .closed
                entries[j].item.lane = .done
                entries[j].item.hold = nil
            }
            persist()
        }
    }

    /// `ended` for each merge an earlier sync asked of gh that no read after it saw, as its PR
    /// reads now, read again only if this sync read it merged: this merge's only if gh said it
    /// merged, as a person may have merged it since. One `merge` read again has told its own.
    func confirmMerges() {
        for (id, asked) in state.merging.sorted(by: { $0.key < $1.key }) where asked.at < now {
            guard let i = pos[id] else { continue }
            var e = entries[i]
            // Read open or closed, it was not merged.
            guard e.item.state == "merged" else {
                if mergeRead.contains(id) {
                    state.merging[id] = nil
                } else {
                    ended(e, e, head: asked.head, flag: asked.flag, ours: false, why: nil)
                }
                continue
            }
            // `reread` needs a head, and a merged PR's read names none.
            e.item.headSha = asked.head
            guard let after = reread(e, "may have been merged") else { continue }
            ended(e, after, head: asked.head, flag: asked.flag, ours: asked.merged == true, why: nil)
        }
    }

    /// Logs how the merge of `e` at `head` with `flag` ended, as `after` reads, and forgets
    /// it: merged at that head by me, it is this merge if `ours`, else a notice; `why` gh
    /// failed. True when `after` is merged.
    @discardableResult
    func ended(_ e: PipelineEntry, _ after: PipelineEntry, head: String, flag: String, ours: Bool,
               why: String?) -> Bool {
        state.merging[e.id] = nil
        guard after.item.state == "merged" else {
            notice("\(e.item.label) was not merged: " + (why ?? "it is still \(after.item.state)"))
            return false
        }
        if after.item.headSha == head, after.mergedBy?.lowercased() == e.root?.me.lowercased() {
            if ours {
                log(e.id, .merged, "merged \(head.prefix(7)) with --admin \(flag)")
            } else {
                notice("\(e.item.label) was merged at \(head.prefix(7)), "
                       + "but gh did not say it was this Diplomat's merge")
            }
        } else {
            notice("\(e.item.label) was merged, but not by this Diplomat's merge at \(head.prefix(7))")
        }
        return true
    }

    /// Asks GitHub to merge `fresh`'s base into it at the head this sync read, logged `asked`
    /// once per head; false, with a notice, when GitHub refused.
    func syncBase(_ fresh: PipelineEntry) -> Bool {
        guard let root = fresh.root, let n = fresh.number, let head = fresh.item.headSha else { return false }
        let out = io.gh(["api", "-X", "PUT", "repos/\(root.name)/pulls/\(n)/update-branch",
                         "-f", "expected_head_sha=\(head)"])
        guard out.ok else {
            notice("\(fresh.item.label) was not brought up to date with \(fresh.baseRef): \(out.why)")
            return false
        }
        let key = "pipeline-update:" + fresh.id
        if state.asked[key] != head {
            log(fresh.id, .asked, "asked GitHub to merge \(fresh.baseRef) into it at \(head.prefix(7))")
            state.asked[key] = head
            persist()
        }
        return true
    }

    // MARK: - Effects

    /// The agent work owed, newest item first, judged by the ban list as it reads now; each
    /// logged `asked` once per stamp.
    func owed() -> [PipelineEffect] {
        let fix = may(.fix), review = may(.fastTrack)
        if fix { recheckLinear() }
        lateRevokes()
        var out = rateAsked()
        for i in entries.indices.sorted(by: newer) {
            let e = entries[i]
            guard e.item.hold == nil else { continue }
            if let why = banHold(e) {
                entries[i].item.hold = why
                continue
            }
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
                if let h = closesHold(e) {
                    entries[i].item.hold = "off the fast track: it " + h.message
                    continue
                }
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
            case .rate(_, _, _, _, let forced, _):
                let again = state.rateAsks[effect.url].flatMap { $0.again ? $0.head : nil }
                what = "asked for a rating" + (again.map { " again at \($0.prefix(7))" } ?? "") + (forced ? " (Rate now)" : "")
            }
            log(effect.url, .asked, what)
            state.asked[effect.key] = effect.stamp
        }
        return out
    }

    /// Forced first, then oldest first.
    func asked(_ a: PipelineRateAsk, before b: PipelineRateAsk) -> Bool {
        (a.forced ? 0 : 1, Int(a.stamp) ?? 0) < (b.forced ? 0 : 1, Int(b.stamp) ?? 0)
    }

    /// A rating effect per ask this sync read the item of and no answer is waiting for, in
    /// `asked` order.
    func rateAsked() -> [PipelineEffect] {
        let unforced = may(.rate), forced = may(.forced)
        return state.rateAsks.sorted { asked($0.value, before: $1.value) }.compactMap { id, a in
            guard let i = pos[id], let root = entries[i].root, a.forced ? forced : unforced,
                  banHold(entries[i]) == nil, !PipelineRateJob.answered(id, a.stamp, in: dir) else { return nil }
            return .rate(repo: root.slug, number: entries[i].number ?? 0, url: id, stamp: a.stamp, forced: a.forced,
                         author: banDimension(entries[i]))
        }
    }

    /// Holds each Linear candidate about to be asked a fix for that a fresh read finds no
    /// longer a candidate, linked to other URLs, or unreadable: its fix run cannot read
    /// Linear, and gets the text this read finds.
    func recheckLinear() {
        let picks = entries.indices.filter {
            entries[$0].item.source == .linear && entries[$0].item.stage == .candidate && entries[$0].item.hold == nil
        }
        guard !picks.isEmpty, let api = linear else { return }
        var fresh: [String: PipelineEntry] = [:]
        do {
            for start in stride(from: 0, to: picks.count, by: 100) {
                let ids = picks[start..<min(picks.count, start + 100)].compactMap { entries[$0].nodeID }
                let data = try api.call("Recheck", ["ids": ids])
                for n in PipelineRead.nodes(data, "issues") {
                    guard let x = PipelineRead.linearIssue(n, viewer: linearViewer, teams: settings.linearTeams,
                                                           roots: roots), let id = x.nodeID else { continue }
                    fresh[id] = x
                }
            }
        } catch {
            notice("Linear: the issues a fix was about to be asked for could not be read again: \(error.localizedDescription)")
            for i in picks {
                entries[i].item.hold = "it could not be read again right before its fix was asked for"
                unrechecked.insert(entries[i].id)
                if let root = entries[i].root { unread.insert(root.slug) }
            }
            return
        }
        for i in picks {
            guard let x = entries[i].nodeID.flatMap({ fresh[$0] }) else {
                entries[i].item.hold = "it changed since this sync read it: it was not found"
                continue
            }
            if isCandidate(x), !x.linksPast, Set(x.links) == Set(entries[i].links) {
                (entries[i].item.title, entries[i].body) = (x.item.title, x.body)
                continue
            }
            entries[i].item.hold = "it changed since this sync read it: "
                + (x.unwritable ?? (isCandidate(x) ? "its links changed" : "it is no longer a candidate"))
        }
    }

    // MARK: - Log

    func log(_ item: String, _ kind: PipelineEvent.Kind, _ detail: String, head: String? = nil,
             rating: PipelineRating? = nil) {
        let event = PipelineEvent(at: now, item: item, kind: kind, detail: detail, head: head, rating: rating)
        unsaved.append(event)
    }

    /// The re-rates and clears a logged event records: they outlive a lost `state.json`. Of two
    /// re-rates of a head, the higher counts.
    func noteRecord(_ e: PipelineEvent) {
        guard let head = e.head, !head.isEmpty else { return }
        if e.kind == .rerated, let r = e.rating {
            rerates[e.item, default: [:]][head] = rerates[e.item]?[head]?.atLeast(r) ?? r
        }
        if e.kind == .cleared { clearsLogged.insert("\(e.item) \(head)") }
    }

    func notice(_ text: String) {
        if !notices.contains(text) { notices.append(text) }
    }
}
