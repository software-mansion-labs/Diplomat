import Foundation

// Diplomat's side of the Diplomacy Network daemon (`packages/diplomacy-network`): what a
// job is offered as, what this machine admits, and what the daemon's snapshot says.
// Python twin: `diplomat_runtime/network.py`, decision for decision.

// MARK: - Settings

/// The keys of `~/.diplomat/config.json` the daemon reads, and its rule for the two
/// hour settings.
public enum NetworkSettings {
    public static let enabledKey = "networkEnabled"
    public static let requiredMinimumHKey = "networkRequiredMinimumH"
    public static let maximumAcceptedHKey = "networkMaximumAcceptedH"
    /// Whether a job running on this machine may reach its adb server. Off unless `true`.
    public static let devicesKey = "networkDevices"

    /// The fewest hours a task may ask for or a member may accept, and the default of
    /// both. The daemon's `HOURS_FLOOR`.
    public static let hoursFloor = 12
    /// The most hours either may be. The daemon's `HOURS_CEILING`.
    public static let hoursCeiling = 720

    /// A number of hours as the daemon keeps it (its `hoursOf`): rounded to the nearest
    /// whole number, a half going up, and held to the floor and the ceiling. The floor
    /// when it is no finite number.
    public static func hours(_ stored: Double?) -> Int {
        guard let v = stored, v.isFinite else { return hoursFloor }
        return Int(min(max((v + 0.5).rounded(.down), Double(hoursFloor)), Double(hoursCeiling)))
    }

    /// A stored hours value, as `JSONSerialization` or `JSONInput` reads one, as the
    /// daemon reads it: `hours` of its JavaScript number.
    public static func hours(json stored: Any?) -> Int { hours(jsNumber(stored)) }

    /// JavaScript's `Number()` of a JSON value: a number is itself, `true` is 1, `false`
    /// and `null` are 0, a string is the number it spells (a blank one is 0) and an
    /// array is its members joined by commas, read as that string. Anything else, and a
    /// value that is absent, is NaN.
    static func jsNumber(_ value: Any?) -> Double {
        switch value {
        case let flag as JSONInput.Flag: return flag.on ? 1 : 0
        case let number as NSNumber: return number.doubleValue
        case is NSNull: return 0
        case let text as String: return jsNumber(text: text)
        case let array as [Any]: return jsNumber(text: jsString(array))
        default: return .nan
        }
    }

    /// A member of an array as JavaScript joins it into the array's string.
    private static func jsString(_ value: Any) -> String {
        switch value {
        case let flag as JSONInput.Flag: return flag.on ? "true" : "false"
        case let number as NSNumber: return "\(number.doubleValue)"
        case is NSNull: return ""
        case let text as String: return text
        case let array as [Any]: return array.map(jsString).joined(separator: ",")
        default: return "[object Object]"
        }
    }

    /// What JavaScript strips from the ends of a string it reads as a number.
    private static let jsSpace = CharacterSet(charactersIn:
        "\t\n\u{0B}\u{0C}\r \u{A0}\u{1680}\u{2000}\u{2001}\u{2002}\u{2003}\u{2004}\u{2005}"
        + "\u{2006}\u{2007}\u{2008}\u{2009}\u{200A}\u{2028}\u{2029}\u{202F}\u{205F}\u{3000}"
        + "\u{FEFF}")

    private static func jsNumber(text: String) -> Double {
        let text = text.trimmingCharacters(in: jsSpace)
        if text.isEmpty { return 0 }
        let decimal = #"^[+-]?([0-9]+\.?[0-9]*|\.[0-9]+)([eE][+-]?[0-9]+)?$"#
        if text.range(of: decimal, options: .regularExpression) != nil {
            return Double(text) ?? .nan
        }
        let radix: [Character: Double] = ["x": 16, "o": 8, "b": 2]
        let digits = text.dropFirst(2)
        guard text.first == "0", !digits.isEmpty,
              let base = text.dropFirst().first.flatMap({ radix[Character($0.lowercased())] })
        else { return .nan }
        var value = 0.0
        for digit in digits {
            guard let d = digit.hexDigitValue, digit.isASCII, Double(d) < base else { return .nan }
            value = value * base + Double(d)
        }
        return value
    }
}

// MARK: - Routes

/// The daemon's local-socket routes, by the name a daemon client posts to, and the
/// bodies that are one or two fields.
public enum NetworkRoute {
    public static let health = "health"
    public static let state = "state"
    public static let pools = "pools"
    public static let admit = "admit"
    public static let offer = "offer"
    public static let withdraw = "withdraw"
    public static let invite = "invite"
    public static let join = "join"
    public static let leave = "leave"
    public static let stopRun = "stop-run"

    /// Why an offer is withdrawn: its PR merged, the operator forgot the run or stopped
    /// a task no run here carries, its run could not be booked, or the switch went off.
    public static let withdrawMerged = "merged"
    public static let withdrawForgotten = "forgotten"
    public static let withdrawStopped = "stopped"
    public static let withdrawNotBooked = "not booked"
    public static let withdrawSwitchedOff = "switched off"

    public static func withdrawBody(task: String, reason: String) -> [String: String] {
        ["taskId": task, "reason": reason]
    }

    /// `ttlSecs` absent leaves the invite's life to the daemon.
    public static func inviteBody(pool: String, ttlSecs: Int? = nil) -> [String: Any] {
        var body: [String: Any] = ["pool": pool]
        if let ttlSecs { body["ttlSecs"] = ttlSecs }
        return body
    }

    /// By invite into someone's pool.
    public static func joinBody(invite: String) -> [String: String] { ["invite": invite] }
    /// Back into a pool this machine left.
    public static func joinBody(pool: String) -> [String: String] { ["pool": pool] }
    public static func leaveBody(pool: String) -> [String: String] { ["pool": pool] }
    public static func stopRunBody(run: String) -> [String: String] { ["runId": run] }
}

/// The activity verbs of the `network` audit category.
public enum NetworkAudit {
    public static let offer = "network-offer"
    public static let claimed = "network-claimed"
    public static let done = "network-done"
    public static let failed = "network-failed"
    public static let withdraw = "network-withdraw"
    public static let unavailable = "network-unavailable"
    public static let join = "network-join"
    public static let invite = "network-invite"
    public static let leave = "network-leave"
    public static let start = "network-start"
    public static let stop = "network-stop"
}

// MARK: - What to offer

/// One job as the pool takes it.
public enum NetworkOffer {
    public static let kindReview = "review"
    public static let kindReviewOwn = "review-own"
    public static let kindConflicts = "conflicts"
    public static let kindIssues = "issues"
    public static let kindAudit = "audit"
    public static let kindInvestigate = "investigate"

    public static let optionVerdict = "verdict"
    public static let optionMarkReady = "markReady"
    public static let optionNoPRs = "noPRs"
    public static let optionReadOnly = "readOnly"

    /// The body of `POST /offer`.
    public struct Offer: Equatable {
        public let pool: String
        public let kind: String
        /// The kind's own option alone; empty for a kind that has none.
        public let options: [String: Bool]
        public let item: String
        public let title: String
        public let prompt: String
        /// Whether this machine claims it at once, whatever it admits.
        public let now: Bool

        public init(pool: String, kind: String, options: [String: Bool], item: String,
                    title: String, prompt: String, now: Bool) {
            self.pool = pool
            self.kind = kind
            self.options = options
            self.item = item
            self.title = title
            self.prompt = prompt
            self.now = now
        }

        public var body: [String: Any] {
            var body: [String: Any] = ["pool": pool, "kind": kind, "item": item,
                                       "title": title, "prompt": prompt, "now": now]
            if !options.isEmpty { body["options"] = options }
            return body
        }
    }

    public enum Decision: Equatable {
        case offer(Offer)
        /// Why the job cannot be offered.
        case refused(String)
    }

    /// The offer for one job, from the audit verb it is logged under.
    ///
    /// The four option inputs are what the job's own prompt was built to allow: whether
    /// a review may approve or request changes, whether work on the operator's own PR
    /// may mark it ready, whether an issue fix opens no PRs, and whether an audit only
    /// reads. Each reaches the offer under the one kind it belongs to.
    ///
    /// A job the operator started, or forced past a hold, is theirs to run at once
    /// (`now`).
    public static func from(verb: String, ownPR: Bool, number: Int?, repoKey: String,
                            label: String, prompt: String,
                            source: AgentDispatchGate.Source, forced: Bool = false,
                            verdict: Bool = false, markReady: Bool = false,
                            noPRs: Bool = false, readOnly: Bool = false) -> Decision {
        guard let kind = kind(verb: verb, ownPR: ownPR) else {
            return .refused("the network runs no \(verb) jobs")
        }
        guard let pool = pool(repoKey: repoKey) else {
            return .refused("no repository to offer it into")
        }
        let options: [String: Bool]
        switch kind {
        case kindReview: options = [optionVerdict: verdict]
        case kindReviewOwn: options = [optionMarkReady: markReady]
        case kindIssues: options = [optionNoPRs: noPRs]
        case kindAudit: options = [optionReadOnly: readOnly]
        default: options = [:]
        }
        let item = item(kind: kind, number: number, prompt: prompt)
        return .offer(Offer(pool: pool, kind: kind, options: options, item: item,
                            title: label.isEmpty ? "\(kind) \(item)" : label,
                            prompt: prompt, now: source == .panel || forced))
    }

    /// The daemon's kind for an audit verb, or `nil` for a verb it has none for. A
    /// review of the operator's own PR is its own kind, and a reply to reviews is
    /// always one.
    public static func kind(verb: String, ownPR: Bool) -> String? {
        switch verb {
        case "review-req", "review", "comms-review": return ownPR ? kindReviewOwn : kindReview
        case "review-reply": return kindReviewOwn
        case "conflicts": return kindConflicts
        case "issues", "comms-fix": return kindIssues
        case "audit": return kindAudit
        case "investigate", "comms-investigate": return kindInvestigate
        default: return nil
        }
    }

    /// The pool a repository key (`PRRef.LocalRepo.key`) names: the forge's host and
    /// the project path, lowercase. `nil` for a key that names no repository.
    public static func pool(repoKey: String) -> String? {
        let key = repoKey.lowercased()
        let parts = key.split(separator: "/", omittingEmptySubsequences: false)
        guard parts.count >= 2, !parts.contains(where: \.isEmpty) else { return nil }
        return parts.count == 2 ? "\(PRRef.LocalRepo.github)/\(key)" : key
    }

    /// What the task is pinned to: the pull request or issue the kind works on, else a
    /// name for this prompt alone.
    public static func item(kind: String, number: Int?, prompt: String) -> String {
        if let number {
            if kind == kindIssues { return "issue-\(number)" }
            if [kindReview, kindReviewOwn, kindConflicts].contains(kind) { return "pr-\(number)" }
        }
        return "job-\(SHA256.hex(Array(prompt.utf8)).prefix(16))"
    }
}

/// The repositories this machine links to pools: the body of `POST /pools`.
public enum NetworkPools {
    public struct Pool: Equatable {
        public let id: String
        public let path: String
        /// `github` or `gitlab`.
        public let forge: String
        public let identity: String

        public init(id: String, path: String, forge: String, identity: String) {
            self.id = id
            self.path = path
            self.forge = forge
            self.identity = identity
        }

        public var json: [String: String] {
            ["id": id, "path": path, "forge": forge, "identity": identity]
        }
    }

    /// One pool per root, the first root winning an id. `identities` maps a forge host
    /// to the login work is done as there; a root on a host with none is left out, a
    /// task id being built on that login.
    public static func linked(roots: [PRRef.LocalRepo],
                              identities: [String: String]) -> [Pool] {
        var seen = Set<String>()
        var out: [Pool] = []
        for root in roots {
            let identity = (identities[root.host] ?? "")
                .trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            guard !identity.isEmpty, let id = NetworkOffer.pool(repoKey: root.key),
                  seen.insert(id).inserted else { continue }
            out.append(Pool(id: id, path: root.path,
                            forge: root.isGitLab ? "gitlab" : "github", identity: identity))
        }
        return out
    }

    /// What `POST /pools` is to say, and a sentence for each thing that could not be
    /// confirmed.
    public struct Listing: Equatable {
        public let pools: [Pool]
        public let unconfirmed: [String]
    }

    public static func unconfirmed(unread path: String) -> String {
        "\(path) cannot be read: its pool stays as the daemon last had it until the "
            + "path can be read or is taken out of Settings"
    }
    public static func unconfirmed(account repo: String, host: String) -> String {
        "The login for \(repo) on \(host) is not known yet: its pool stays as the "
            + "daemon last had it until it is"
    }

    /// Every linked repository as a pool: the roots, then what the OTHER REPOS
    /// checkouts name that no root does (`others`). A root or a checkout that was read
    /// and names no forge is no pool, and is in neither list. What could not be
    /// confirmed is said as the daemon last had it (`known`, its snapshot's pools): the
    /// pool at a path that could not be read (`unread`), and the pool of a repository
    /// whose forge login is unknown. The daemon leaves a pool the list omits, so the
    /// list is never cut short by what is unknown, and a repository taken out of
    /// Settings leaves its pool whatever else cannot be read.
    public static func listing(roots: [PRRef.LocalRepo], others: [PRRef.LocalRepo],
                               unread: [String], identities: [String: String],
                               known: [NetworkSnapshot.Pool]) -> Listing {
        let repos = roots + others
        var pools = linked(roots: repos, identities: identities)
        var listed = Set(pools.map(\.id))
        var nameless: [(id: String, repo: PRRef.LocalRepo)] = []
        for repo in repos {
            guard let id = NetworkOffer.pool(repoKey: repo.key), !listed.contains(id),
                  !nameless.contains(where: { $0.id == id }) else { continue }
            nameless.append((id, repo))
        }
        for pool in known where !listed.contains(pool.id)
            && (unread.contains(pool.path) || nameless.contains { $0.id == pool.id }) {
            listed.insert(pool.id)
            pools.append(Pool(id: pool.id, path: pool.path,
                              forge: pool.id.hasPrefix("\(PRRef.LocalRepo.github)/")
                                ? "github" : "gitlab",
                              identity: pool.identity))
        }
        return Listing(pools: pools, unconfirmed: unread.map { unconfirmed(unread: $0) }
            + nameless.map { unconfirmed(account: $0.repo.slug, host: $0.repo.host) })
    }

    public static func body(_ pools: [Pool]) -> [String: [[String: String]]] {
        ["pools": pools.map(\.json)]
    }
}

// MARK: - Admit

/// How many more tasks this machine takes now: the body of `POST /admit`.
public enum NetworkAdmit {
    public static let disk = "disk"
    public static let budget = "budget"
    public static let paused = "paused"

    /// The states of a snapshot run that hold a bay.
    public static let live: Set<String> = ["preparing", "running"]

    public struct Answer: Equatable {
        public let slots: Int
        /// Why it is zero when something other than a full cap makes it so; else "".
        public let reason: String

        public init(slots: Int, reason: String = "") {
            self.slots = slots
            self.reason = reason
        }

        public var body: [String: Any] {
            reason.isEmpty ? ["slots": slots] : ["slots": slots, "reason": reason]
        }
    }

    /// The free bays of the cap, or none while the disk is low, the budget is spent or
    /// the operator has automatic work off - the first of those that holds is the
    /// reason given.
    public static func slots(limit: Int, running: Int, lowDisk: Bool, affordable: Bool,
                             autoRun: Bool) -> Answer {
        if lowDisk { return Answer(slots: 0, reason: disk) }
        if !affordable { return Answer(slots: 0, reason: budget) }
        if !autoRun { return Answer(slots: 0, reason: paused) }
        return Answer(slots: max(0, limit - running), reason: "")
    }

    /// The runs this machine is executing for the network.
    public static func running(_ snapshot: NetworkSnapshot?) -> Int {
        (snapshot?.runs ?? []).filter { live.contains($0.state) }.count
    }
}

// MARK: - The snapshot

/// The daemon's `GET /state`, read without ever failing: a member that is absent or of
/// the wrong type is its default, a row without its identity is dropped, and anything
/// else in the document is ignored.
public struct NetworkSnapshot: Equatable {
    public struct Service: Equatable {
        public let state: String
        public let detail: String
    }

    public struct Docker: Equatable {
        public let state: String
        public let image: String
        public let detail: String
    }

    public struct Admit: Equatable {
        public let slots: Int
        public let at: Double?
        public let reason: String
    }

    public struct Member: Equatable {
        public let pk: String
        public let isSelf: Bool
        public let maxAcceptedH: Int?
        public let lastSeen: Double?
        public let reachable: Bool
    }

    public struct Task: Equatable {
        public let taskId: String
        public let kind: String
        public let item: String
        public let title: String
        public let identity: String
        public let hours: Int?
        /// `available`, `claimed`, `done` or `cancelled`.
        public let state: String
        public let offeredBy: [String]
        public let offeredHere: Bool
        public let executor: String
        public let executorHere: Bool
        public let claimedAt: Double?
        public let leaseUntil: Double?
        public let deadline: Double?
    }

    public struct Pool: Equatable {
        public let id: String
        public let path: String
        public let identity: String
        public let hash: String
        /// Whether this machine left the pool: it takes and offers nothing there.
        public let left: Bool
        public let members: [Member]
        public let tasks: [Task]
    }

    public struct Run: Equatable {
        public let runId: String
        public let taskId: String
        public let pool: String
        public let peer: String
        public let container: String
        /// `preparing`, `running`, `finished`, `failed` or `stopped`.
        public let state: String
        public let startedAt: Double?
        public let endedAt: Double?
        public let exit: Int?
        public let log: String
    }

    public struct Outcome: Equatable {
        public let ok: Bool
        public let summary: String
        public let usd: Double?
        public let tokens: Double?
        public let runner: String
        public let model: String
    }

    public struct Offer: Equatable {
        public let taskId: String
        public let pool: String
        public let kind: String
        public let item: String
        public let title: String
        /// `pooled`, `claimed`, `done`, `failed` or `cancelled`.
        public let state: String
        /// How the last attempt of a `failed` offer ended, or why a `cancelled` one
        /// was withdrawn; "" when the daemon gave none.
        public let reason: String
        public let executor: String
        /// The daemon's own word on whether the executor is this machine; `nil` when
        /// the document gave none.
        public let executorHere: Bool?
        public let offeredAt: Double?
        public let attempt: Int
        public let requests: Int
        public let refused: Int
        public let outcome: Outcome?
        public let endedAt: Double?
    }

    public let updatedAt: Double?
    public let pid: Int?
    public let startedAt: Double?
    public let pk: String
    public let onion: String
    public let transport: Service
    public let docker: Docker
    public let model: Service
    /// Whether jobs running here reach this machine's adb server: `off`, `ready` or
    /// `none`.
    public let devices: Service
    public let admit: Admit
    public let pools: [Pool]
    public let runs: [Run]
    /// `nil` when the document has no `offers` list, which says nothing about any
    /// offer; an empty list says there are none.
    public let offers: [Offer]?

    /// The daemon's answer, or `nil` when there was none or it is not a JSON object.
    public static func parse(_ data: Data?) -> NetworkSnapshot? {
        data.flatMap { JSONInput.parse($0) }.map(NetworkSnapshot.init)
    }

    /// From a document `JSONInput.parse` read.
    public init(_ d: [String: Any]) {
        func text(_ raw: Any?) -> String { raw as? String ?? "" }
        func object(_ raw: Any?) -> [String: Any] { raw as? [String: Any] ?? [:] }
        func rows(_ raw: Any?) -> [[String: Any]] {
            (raw as? [Any] ?? []).compactMap { $0 as? [String: Any] }
        }
        func service(_ raw: Any?) -> Service {
            let s = object(raw)
            return Service(state: text(s["state"]), detail: text(s["detail"]))
        }
        let number = AgentRegistry.number, integer = AgentRegistry.integer

        updatedAt = number(d["updatedAt"])
        let daemon = object(d["daemon"])
        pid = integer(daemon["pid"])
        startedAt = number(daemon["startedAt"])
        let identity = object(d["identity"])
        pk = text(identity["pk"])
        onion = text(identity["onion"])
        transport = service(d["transport"])
        model = service(d["model"])
        devices = service(d["devices"])
        let dock = object(d["docker"])
        docker = Docker(state: text(dock["state"]), image: text(dock["image"]),
                        detail: text(dock["detail"]))
        let adm = object(d["admit"])
        admit = Admit(slots: integer(adm["slots"]) ?? 0, at: number(adm["at"]),
                      reason: text(adm["reason"]))
        pools = rows(d["pools"]).compactMap { p in
            guard let id = p["id"] as? String, !id.isEmpty else { return nil }
            let members = rows(p["members"]).compactMap { m -> Member? in
                guard let pk = m["pk"] as? String, !pk.isEmpty else { return nil }
                return Member(pk: pk, isSelf: JSONInput.flag(m["self"]),
                              maxAcceptedH: integer(m["maxAcceptedH"]),
                              lastSeen: number(m["lastSeen"]),
                              reachable: JSONInput.flag(m["reachable"]))
            }
            let tasks = rows(p["tasks"]).compactMap { t -> Task? in
                guard let taskId = t["taskId"] as? String, !taskId.isEmpty else { return nil }
                return Task(taskId: taskId, kind: text(t["kind"]), item: text(t["item"]),
                            title: text(t["title"]), identity: text(t["identity"]),
                            hours: integer(t["hours"]), state: text(t["state"]),
                            offeredBy: (t["offeredBy"] as? [Any] ?? []).compactMap { $0 as? String },
                            offeredHere: JSONInput.flag(t["offeredHere"]),
                            executor: text(t["executor"]),
                            executorHere: JSONInput.flag(t["executorHere"]),
                            claimedAt: number(t["claimedAt"]),
                            leaseUntil: number(t["leaseUntil"]),
                            deadline: number(t["deadline"]))
            }
            return Pool(id: id, path: text(p["path"]), identity: text(p["identity"]),
                        hash: text(p["hash"]), left: JSONInput.flag(p["left"]),
                        members: members, tasks: tasks)
        }
        runs = rows(d["runs"]).compactMap { r in
            guard let runId = r["runId"] as? String, !runId.isEmpty else { return nil }
            return Run(runId: runId, taskId: text(r["taskId"]), pool: text(r["pool"]),
                       peer: text(r["peer"]), container: text(r["container"]),
                       state: text(r["state"]), startedAt: number(r["startedAt"]),
                       endedAt: number(r["endedAt"]), exit: integer(r["exit"]),
                       log: text(r["log"]))
        }
        offers = (d["offers"] as? [Any]).map { list in
            list.compactMap { $0 as? [String: Any] }.compactMap { o in
                guard let taskId = o["taskId"] as? String, !taskId.isEmpty else { return nil }
                let outcome = (o["outcome"] as? [String: Any]).map { out in
                    Outcome(ok: JSONInput.flag(out["ok"]), summary: text(out["summary"]),
                            usd: number(out["usd"]), tokens: number(out["tokens"]),
                            runner: text(out["runner"]), model: text(out["model"]))
                }
                return Offer(taskId: taskId, pool: text(o["pool"]), kind: text(o["kind"]),
                             item: text(o["item"]), title: text(o["title"]),
                             state: text(o["state"]), reason: text(o["reason"]),
                             executor: text(o["executor"]),
                             executorHere: (o["executorHere"] as? JSONInput.Flag)?.on,
                             offeredAt: number(o["offeredAt"]),
                             attempt: integer(o["attempt"]) ?? 0,
                             requests: integer(o["requests"]) ?? 0,
                             refused: integer(o["refused"]) ?? 0,
                             outcome: outcome, endedAt: number(o["endedAt"]))
            }
        }
    }
}

/// What a snapshot says of this machine's own offers, as the agent-state resolver
/// reads it (`AgentState.Evidence.network`).
public enum NetworkEvidence {
    public static let unanswered = "the daemon did not answer"
    public static let noOffers = "the snapshot lists no offers"

    /// Task id → its offer. Whether a task runs here is the offer's own word where the
    /// daemon gives it. Where it gives none, a task runs here when one of this
    /// machine's live runs is for it, when its pool lists this machine as its
    /// executor, or when its executor is this machine's own key.
    public static func tasks(_ snapshot: NetworkSnapshot?)
        -> Observation<[String: AgentState.NetworkTask]> {
        guard let snapshot else { return .unavailable(unanswered) }
        guard let offers = snapshot.offers else { return .unavailable(noOffers) }
        var here = Set(snapshot.runs.filter { NetworkAdmit.live.contains($0.state) }
            .map(\.taskId))
        for pool in snapshot.pools {
            here.formUnion(pool.tasks.filter(\.executorHere).map(\.taskId))
        }
        var out: [String: AgentState.NetworkTask] = [:]
        for offer in offers {
            let mine = !offer.executor.isEmpty && offer.executor == snapshot.pk
            out[offer.taskId] = AgentState.NetworkTask(
                state: offer.state, executor: offer.executor,
                executorHere: offer.executorHere ?? (mine || here.contains(offer.taskId)),
                ok: offer.outcome?.ok ?? false, reason: offer.reason)
        }
        return .present(out)
    }

    /// The task the daemon holds for an offer of `item` as `kind` to `pool`: its open
    /// offer of the three, which is what it names a task by. Nil when the snapshot
    /// lists none.
    public static func openTask(pool: String, kind: String, item: String,
                                in snapshot: NetworkSnapshot?) -> String? {
        let open = [AgentState.NetworkTask.pooled, AgentState.NetworkTask.claimed]
        return snapshot?.offers?.first {
            $0.pool == pool && $0.kind == kind && $0.item == item && open.contains($0.state)
        }?.taskId
    }
}

// MARK: - SHA-256

/// FIPS 180-4 SHA-256, written out because this target is Foundation-only and builds
/// on Linux, where `CryptoKit` does not exist. The Python twin is `hashlib.sha256`.
enum SHA256 {
    private static let k: [UInt32] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
        0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
        0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
        0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
        0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
        0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
        0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
    ]

    static func hex(_ bytes: [UInt8]) -> String {
        var h: [UInt32] = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
                           0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]
        var message = bytes
        let bits = UInt64(bytes.count) * 8
        message.append(0x80)
        while message.count % 64 != 56 { message.append(0) }
        for shift in stride(from: 56, through: 0, by: -8) {
            message.append(UInt8(truncatingIfNeeded: bits >> UInt64(shift)))
        }
        func rotr(_ x: UInt32, _ n: UInt32) -> UInt32 { (x >> n) | (x << (32 - n)) }
        var w = [UInt32](repeating: 0, count: 64)
        for block in stride(from: 0, to: message.count, by: 64) {
            for i in 0..<16 {
                let j = block + i * 4
                w[i] = UInt32(message[j]) << 24 | UInt32(message[j + 1]) << 16
                    | UInt32(message[j + 2]) << 8 | UInt32(message[j + 3])
            }
            for i in 16..<64 {
                let s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >> 3)
                let s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >> 10)
                w[i] = w[i - 16] &+ s0 &+ w[i - 7] &+ s1
            }
            var v = h
            for i in 0..<64 {
                let s1 = rotr(v[4], 6) ^ rotr(v[4], 11) ^ rotr(v[4], 25)
                let ch = (v[4] & v[5]) ^ (~v[4] & v[6])
                let t1 = v[7] &+ s1 &+ ch &+ k[i] &+ w[i]
                let s0 = rotr(v[0], 2) ^ rotr(v[0], 13) ^ rotr(v[0], 22)
                let maj = (v[0] & v[1]) ^ (v[0] & v[2]) ^ (v[1] & v[2])
                v = [t1 &+ s0 &+ maj, v[0], v[1], v[2], v[3] &+ t1, v[4], v[5], v[6]]
            }
            for i in 0..<8 { h[i] = h[i] &+ v[i] }
        }
        return h.map { String(format: "%08x", $0) }.joined()
    }
}
