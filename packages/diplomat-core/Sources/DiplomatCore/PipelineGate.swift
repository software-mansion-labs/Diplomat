import Foundation

/// The code the pipeline's model never overrules: the floor a PR's diff puts under its
/// rating, and the holds that keep a cleared PR from merging. Code, never an agent, so
/// nothing a PR or its issue says can talk its way past either.
public enum PipelineGate {
    /// One file of a PR's diff as GitHub lists it.
    public struct ChangedFile: Equatable, Sendable {
        public let path: String
        public let additions: Int
        public let deletions: Int
        /// GitHub's `PatchStatus`: ADDED, DELETED, MODIFIED, RENAMED, COPIED or CHANGED.
        public let changeType: String

        public init(path: String, additions: Int, deletions: Int, changeType: String) {
            self.path = path
            self.additions = additions
            self.deletions = deletions
            self.changeType = changeType
        }
    }

    /// A file the fast track never merges a change to, whatever the change.
    public static func isDenied(_ path: String, _ floor: CoreAssets.PipelineModel.Floor) -> Bool {
        let parts = path.split(separator: "/").map { $0.lowercased() }
        guard let name = parts.last else { return true }
        let dirs = Set(floor.deniedDirs.map { $0.lowercased() })
        return parts.dropLast().contains(where: dirs.contains)
            || floor.deniedFiles.contains { glob($0.lowercased(), name) }
    }

    /// A test file, held to the test limits rather than the source ones.
    public static func isTest(_ path: String, _ floor: CoreAssets.PipelineModel.Floor) -> Bool {
        let parts = path.split(separator: "/").map(String.init)
        guard let name = parts.last else { return false }
        let dirs = Set(floor.testDirs.map { $0.lowercased() })
        return parts.dropLast().contains { dirs.contains($0.lowercased()) }
            || floor.testFiles.contains { glob($0, name) }
    }

    /// `*` matches any run of characters; nothing else is special.
    static func glob(_ pattern: String, _ name: String) -> Bool {
        let parts = pattern.components(separatedBy: "*")
        guard parts.count > 1 else { return pattern == name }
        let first = parts[0], last = parts[parts.count - 1]
        guard name.hasPrefix(first) else { return false }
        var rest = Substring(name.dropFirst(first.count))
        guard rest.hasSuffix(last) else { return false }
        rest = rest.dropLast(last.count)
        for middle in parts[1..<(parts.count - 1)] where !middle.isEmpty {
            guard let hit = rest.range(of: middle) else { return false }
            rest = rest[hit.upperBound...]
        }
        return true
    }

    /// The least rating a diff allows: a limit broken makes complexity at least medium,
    /// as do files GitHub changed but the read did not list; a denied path makes risk
    /// high; no test change, a file added outside tests, deleted, renamed, copied or
    /// otherwise not modified, or one with no lines (binary or a mode change) makes risk
    /// at least medium.
    public static func floor(files: [ChangedFile], changedFiles: Int) -> PipelineRating {
        floorWithReasons(files: files, changedFiles: changedFiles).rating
    }

    /// `floor`, with one short reason per dimension it raised, first cause first.
    static func floorWithReasons(files: [ChangedFile], changedFiles: Int)
        -> (rating: PipelineRating, reasons: [String]) {
        guard let f = (try? CoreAssets.pipeline())?.floor else {
            return (PipelineRating(risk: .high, complexity: .high), ["assets/pipeline.json could not be read"])
        }
        var risk = PipelineLevel.low, complexity = PipelineLevel.low
        var reasons: [String] = []
        func raise(_ level: inout PipelineLevel, to floor: PipelineLevel, _ why: String) {
            if floor > level { level = floor; reasons.append(why) }
        }
        if changedFiles > f.maxFiles {
            raise(&complexity, to: .medium, "changes \(changedFiles) files (limit \(f.maxFiles))")
        }
        if files.count < changedFiles {
            raise(&complexity, to: .medium, "changes files the read did not list")
        }
        for file in files {
            if isDenied(file.path, f) {
                raise(&risk, to: .high, "touches \(file.path), which the fast track never merges")
            }
            let addedTest = file.changeType == "ADDED" && isTest(file.path, f)
            if file.changeType != "MODIFIED" && !addedTest {
                raise(&risk, to: .medium, "\(file.changeType.lowercased()) \(file.path)")
            }
            if file.additions + file.deletions == 0 {
                raise(&risk, to: .medium, "changes \(file.path) with no lines (binary or mode)")
            }
        }
        let tests = files.filter { isTest($0.path, f) }
        let source = files.filter { !isTest($0.path, f) }
        if tests.isEmpty { raise(&risk, to: .medium, "changes no test") }
        if source.count > f.maxSourceFiles {
            raise(&complexity, to: .medium,
                  "changes \(source.count) files outside tests (limit \(f.maxSourceFiles))")
        }
        let sourceLines = source.reduce(0) { $0 + $1.additions + $1.deletions }
        if sourceLines > f.maxSourceLines {
            raise(&complexity, to: .medium,
                  "changes \(sourceLines) lines outside tests (limit \(f.maxSourceLines))")
        }
        let testLines = tests.reduce(0) { $0 + $1.additions + $1.deletions }
        if testLines > f.maxTestLines {
            raise(&complexity, to: .medium, "changes \(testLines) test lines (limit \(f.maxTestLines))")
        }
        return (PipelineRating(risk: risk, complexity: complexity), reasons)
    }

    /// A cleared PR as the merge gate reads it.
    public struct Candidate: Equatable, Sendable {
        public var state: String
        public var author: String
        public var isCrossRepository: Bool
        public var baseRef: String
        public var defaultBranch: String
        /// The author of each review and PR comment: nil for a bot, "" for a deleted
        /// account.
        public var participants: [String?]
        /// More reviews or comments than the read lists, any of which could be a person's.
        public var participantsUnseen: Bool
        public var reviewDecision: String
        public var unresolvedThreads: Int
        public var rating: PipelineRating?
        public var floor: PipelineRating
        public var mergeable: String
        public var headSha: String
        /// The commit `ciState` was read for, which a lagging index can leave behind
        /// `headSha`.
        public var ciCommit: String
        /// `statusCheckRollup.state`, "" when the commit has no checks at all.
        public var ciState: String

        public init(state: String, author: String, isCrossRepository: Bool, baseRef: String,
                    defaultBranch: String, participants: [String?], participantsUnseen: Bool = false,
                    reviewDecision: String, unresolvedThreads: Int, rating: PipelineRating?,
                    floor: PipelineRating, mergeable: String, headSha: String, ciCommit: String,
                    ciState: String) {
            self.state = state
            self.author = author
            self.isCrossRepository = isCrossRepository
            self.baseRef = baseRef
            self.defaultBranch = defaultBranch
            self.participants = participants
            self.participantsUnseen = participantsUnseen
            self.reviewDecision = reviewDecision
            self.unresolvedThreads = unresolvedThreads
            self.rating = rating
            self.floor = floor
            self.mergeable = mergeable
            self.headSha = headSha
            self.ciCommit = ciCommit
            self.ciState = ciState
        }
    }

    /// Why a cleared PR is not merged at its head.
    public enum Hold: Equatable, Sendable {
        case closed
        case notMine(String)
        case fork
        case notDefaultBase(String)
        case human(String)
        case participantsUnseen
        case changesRequested
        case threads(Int)
        case rated(PipelineRating?)
        case floor(PipelineRating)
        case conflicting
        case mergeabilityUnknown
        case ciStale
        case ciMissing
        case ciPending
        case ciFailing(String)

        /// A stable spelling for the log.
        public var code: String {
            switch self {
            case .closed: return "closed"
            case .notMine: return "not-mine"
            case .fork: return "fork"
            case .notDefaultBase: return "base"
            case .human: return "human"
            case .participantsUnseen: return "participants-unseen"
            case .changesRequested: return "changes-requested"
            case .threads: return "threads"
            case .rated: return "rated"
            case .floor: return "floor"
            case .conflicting: return "conflicting"
            case .mergeabilityUnknown: return "mergeability-unknown"
            case .ciStale: return "ci-stale"
            case .ciMissing: return "ci-missing"
            case .ciPending: return "ci-pending"
            case .ciFailing: return "ci-failing"
            }
        }

        public var message: String {
            func pair(_ r: PipelineRating?) -> String {
                r.map { "\($0.risk.rawValue) risk, \($0.complexity.rawValue) complexity" } ?? "unrated"
            }
            switch self {
            case .closed: return "no longer open"
            case .notMine(let who): return "authored by @\(who.isEmpty ? "ghost" : who), not me"
            case .fork: return "comes from a fork"
            case .notDefaultBase(let base): return "targets \(base), not the default branch"
            case .human(let who): return "@\(who.isEmpty ? "ghost" : who) has commented or reviewed"
            case .participantsUnseen: return "has more reviews or comments than one read lists"
            case .changesRequested: return "has changes requested"
            case .threads(let n): return "has \(n) unresolved review thread\(n == 1 ? "" : "s")"
            case .rated(let r): return "rated \(pair(r)) on the tracker"
            case .floor(let r): return "its diff allows no less than \(pair(r))"
            case .conflicting: return "conflicts with its base"
            case .mergeabilityUnknown: return "mergeability not computed yet"
            case .ciStale: return "CI was read for an older commit"
            case .ciMissing: return "has no CI checks"
            case .ciPending: return "CI still running"
            case .ciFailing(let state): return "CI \(state.lowercased())"
            }
        }
    }

    /// The hold on `c`, or nil when it may merge. The first broken rule wins, in a fixed
    /// order: who the PR is and who has seen it, then what it changes, then the state
    /// GitHub is still computing - so a PR that can never merge says why, rather than
    /// reading "CI still running" until its checks finish.
    public static func hold(_ c: Candidate, me: String) -> Hold? {
        if c.state != "open" && c.state != "draft" { return .closed }
        let mine = me.lowercased()
        if c.author.lowercased() != mine || mine.isEmpty { return .notMine(c.author) }
        if c.isCrossRepository { return .fork }
        if c.baseRef != c.defaultBranch || c.baseRef.isEmpty { return .notDefaultBase(c.baseRef) }
        if let other = c.participants.first(where: { $0 != nil && $0!.lowercased() != mine }) {
            return .human(other ?? "")
        }
        if c.participantsUnseen { return .participantsUnseen }
        if c.reviewDecision == "CHANGES_REQUESTED" { return .changesRequested }
        if c.unresolvedThreads > 0 { return .threads(c.unresolvedThreads) }
        if c.rating?.isFastTrack != true { return .rated(c.rating) }
        if !c.floor.isFastTrack { return .floor(c.floor) }
        if c.mergeable == "CONFLICTING" { return .conflicting }
        if c.mergeable != "MERGEABLE" { return .mergeabilityUnknown }
        if c.ciCommit != c.headSha { return .ciStale }
        switch c.ciState {
        case "SUCCESS": return nil
        case "": return .ciMissing
        case "PENDING", "EXPECTED": return .ciPending
        default: return .ciFailing(c.ciState)
        }
    }
}
