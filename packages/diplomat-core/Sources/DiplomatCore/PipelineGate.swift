import Foundation

/// The floor a PR's diff puts under its rating, and the holds that keep a cleared PR from
/// merging: code, never the model, so nothing a PR or its issue says can talk its way past.
public enum PipelineGate {
    public struct ChangedFile: Equatable, Sendable {
        public let path: String
        public let additions: Int
        public let deletions: Int
        /// GitHub's `PatchStatus`.
        public let changeType: String

        public init(path: String, additions: Int, deletions: Int, changeType: String) {
            self.path = path
            self.additions = additions
            self.deletions = deletions
            self.changeType = changeType
        }
    }

    /// A file the fast track never merges a change to.
    public static func isDenied(_ path: String, _ floor: CoreAssets.PipelineModel.Floor) -> Bool {
        let parts = path.split(separator: "/").map { $0.lowercased() }
        guard let name = parts.last else { return true }
        let dirs = Set(floor.deniedDirs.map { $0.lowercased() })
        return parts.dropLast().contains(where: dirs.contains)
            || floor.deniedFiles.contains { glob($0.lowercased(), name) }
    }

    public static func isTest(_ path: String, _ floor: CoreAssets.PipelineModel.Floor) -> Bool {
        guard let name = path.split(separator: "/").last else { return false }
        return inTestDir(path, floor) || floor.testFiles.contains { glob($0, String(name)) }
    }

    static func inTestDir(_ path: String, _ floor: CoreAssets.PipelineModel.Floor) -> Bool {
        let dirs = Set(floor.testDirs.map { $0.lowercased() })
        return path.split(separator: "/").dropLast().contains { dirs.contains($0.lowercased()) }
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

    /// The least rating a diff allows.
    public static func floor(files: [ChangedFile], changedFiles: Int) -> PipelineRating {
        floorWithReasons(files: files, changedFiles: changedFiles).rating
    }

    /// `floor`, with the reason for each raise.
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
            // A name alone would let a new module called `test_*.py` pass as a test.
            let addedTest = file.changeType == "ADDED" && inTestDir(file.path, f)
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

    /// What the diff's text adds to `floor`. A moved submodule is high risk: GitHub lists it
    /// as one modified line whatever it pulls in.
    static func diffFloor(_ diff: String, diffChars: Int) -> (rating: PipelineRating, reasons: [String]) {
        var rating = PipelineRating(risk: .low, complexity: .low)
        var reasons: [String] = []
        if diff.count > diffChars {
            rating.complexity = .medium
            reasons.append("its diff is longer than the \(diffChars) characters the rater reads")
        }
        let moved = diff.split(separator: "\n").contains {
            $0.hasPrefix("+Subproject commit ") || $0.hasPrefix("-Subproject commit ")
        }
        if moved {
            rating.risk = .high
            reasons.append("moves a submodule")
        }
        return (rating, reasons)
    }

    public struct Candidate: Equatable, Sendable {
        public var state: String
        public var author: String
        public var isCrossRepository: Bool
        public var baseRef: String
        public var defaultBranch: String
        /// The author of each review and PR comment: nil for a bot, "" for a deleted
        /// account.
        public var participants: [String?]
        /// More reviews or comments exist than the read lists.
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
        /// A comment or review of the operator's lacks Diplomat's tag, so a person wrote it.
        public var operatorUntagged: Bool
        public var reviewRequests: Int
        /// Who besides the operator authored or committed a commit; "" for an author with no
        /// GitHub account, or for commits past what the read lists.
        public var foreignCommits: [String]
        /// Both of Diplomat's fast-track labels are on it.
        public var trackLabels: Bool
        /// It closes an issue, and every one it closes is low risk, low complexity and one
        /// Diplomat may act on.
        public var fixesCandidate: Bool
        /// The issues it would close that Diplomat did not read.
        public var closesUnwritable: [String]
        /// Not every check on the head was skipped.
        public var ciRan: Bool
        public var wasReady: Bool
        /// GitHub's `mergeStateStatus`.
        public var mergeState: String
        /// Its base branch has a merge queue, which `--admin` would skip.
        public var mergeQueue: Bool
        /// The `stopLabels` it carries.
        public var stopLabels: [String]
        /// The status checks its base branch requires, nil when unread; and those that passed
        /// on the head as required ones.
        public var requiredChecks: [String]?
        public var passedChecks: Set<String>
        /// Its base branch's rules: each active ruleset rule's type and each protection
        /// setting on, by GraphQL field name; nil when unread.
        public var baseRules: [String]?
        /// A commit is not signed and verified, or not read.
        public var unsignedCommits: Bool
        /// The `gh pr merge` flag it would merge with.
        public var mergeFlag: String

        /// The fields after `ciState` default to what lets a PR merge.
        public init(state: String, author: String, isCrossRepository: Bool, baseRef: String,
                    defaultBranch: String, participants: [String?], participantsUnseen: Bool = false,
                    reviewDecision: String, unresolvedThreads: Int, rating: PipelineRating?,
                    floor: PipelineRating, mergeable: String, headSha: String, ciCommit: String,
                    ciState: String, operatorUntagged: Bool = false, reviewRequests: Int = 0,
                    foreignCommits: [String] = [], trackLabels: Bool = true, fixesCandidate: Bool = true,
                    closesUnwritable: [String] = [], ciRan: Bool = true, wasReady: Bool = false,
                    mergeState: String = "CLEAN", mergeQueue: Bool = false, stopLabels: [String] = [],
                    requiredChecks: [String]? = [], passedChecks: Set<String> = [], baseRules: [String]? = [],
                    unsignedCommits: Bool = false, mergeFlag: String = "--squash") {
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
            self.operatorUntagged = operatorUntagged
            self.reviewRequests = reviewRequests
            self.foreignCommits = foreignCommits
            self.trackLabels = trackLabels
            self.fixesCandidate = fixesCandidate
            self.closesUnwritable = closesUnwritable
            self.ciRan = ciRan
            self.wasReady = wasReady
            self.mergeState = mergeState
            self.mergeQueue = mergeQueue
            self.stopLabels = stopLabels
            self.requiredChecks = requiredChecks
            self.passedChecks = passedChecks
            self.baseRules = baseRules
            self.unsignedCommits = unsignedCommits
            self.mergeFlag = mergeFlag
        }
    }

    /// Why a cleared PR is not merged.
    public enum Hold: Equatable, Sendable {
        case closed
        case notMine(String)
        case fork
        case notDefaultBase(String)
        case mergeQueue
        case baseRulesUnread
        case baseRules([String])
        case human(String)
        case participantsUnseen
        case operatorComment
        case reviewRequested(Int)
        case redrafted
        case foreignCommits(String)
        case changesRequested
        case threads(Int)
        case stopLabel(String)
        case offTrack
        case notAFix
        case closesUnwritable(String)
        case rated(PipelineRating?)
        case floor(PipelineRating)
        case conflicting
        case mergeabilityUnknown
        case behind
        case ciStale
        case ciPending
        case ciFailing(String)
        /// No hold above stands: it is marked ready, as CI may skip drafts, and merged once
        /// the CI holds below clear.
        case draft
        case ciMissing
        case ciSkipped
        case requiredUnread
        case requiredChecks([String])

        /// A stable spelling for the log.
        public var code: String {
            switch self {
            case .closed: return "closed"
            case .notMine: return "not-mine"
            case .fork: return "fork"
            case .notDefaultBase: return "base"
            case .mergeQueue: return "merge-queue"
            case .baseRulesUnread: return "base-rules-unread"
            case .baseRules: return "base-rules"
            case .human: return "human"
            case .participantsUnseen: return "participants-unseen"
            case .operatorComment: return "operator-comment"
            case .reviewRequested: return "review-requested"
            case .redrafted: return "redrafted"
            case .foreignCommits: return "foreign-commits"
            case .changesRequested: return "changes-requested"
            case .threads: return "threads"
            case .stopLabel: return "stop-label"
            case .offTrack: return "off-track"
            case .notAFix: return "not-a-fix"
            case .closesUnwritable: return "closes-unwritable"
            case .rated: return "rated"
            case .floor: return "floor"
            case .conflicting: return "conflicting"
            case .mergeabilityUnknown: return "mergeability-unknown"
            case .behind: return "behind"
            case .ciStale: return "ci-stale"
            case .ciPending: return "ci-pending"
            case .ciFailing: return "ci-failing"
            case .draft: return "draft"
            case .ciMissing: return "ci-missing"
            case .ciSkipped: return "ci-skipped"
            case .requiredUnread: return "required-unread"
            case .requiredChecks: return "required-checks"
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
            case .mergeQueue: return "its base branch merges through a merge queue"
            case .baseRulesUnread: return "the rules on its base branch could not be read"
            case .baseRules(let rules):
                return rules.count == 1 ? "its base branch has a rule Diplomat does not check: \(rules[0])"
                    : "its base branch has rules Diplomat does not check: \(rules.joined(separator: ", "))"
            case .human(let who): return "@\(who.isEmpty ? "ghost" : who) has commented or reviewed"
            case .participantsUnseen: return "has more reviews or comments than one read lists"
            case .operatorComment: return "I commented on or reviewed it myself, not through Diplomat"
            case .reviewRequested(let n): return "waits on \(n) requested review\(n == 1 ? "" : "s")"
            case .redrafted: return "turned back into a draft after it was ready for review"
            case .foreignCommits(let who):
                return who.isEmpty ? "has commits by someone other than me" : "has commits by @\(who)"
            case .changesRequested: return "has changes requested"
            case .threads(let n): return "has \(n) unresolved review thread\(n == 1 ? "" : "s")"
            case .stopLabel(let label): return "carries the label \(label)"
            case .offTrack: return "lacks a fast-track label"
            case .notAFix: return "closes no issue, or one that is not a low-risk, low-complexity issue Diplomat may act on"
            case .closesUnwritable(let what): return "would close \(what), which Diplomat did not read or may not write to"
            case .rated(let r): return "rated \(pair(r)) on the tracker"
            case .floor(let r): return "its diff allows no less than \(pair(r))"
            case .conflicting: return "conflicts with its base"
            case .mergeabilityUnknown: return "mergeability not computed yet"
            case .behind: return "is behind its base branch"
            case .ciStale: return "CI was read for an older commit"
            case .ciPending: return "CI still running"
            case .ciFailing(let state): return "CI \(state.lowercased())"
            case .draft: return "still a draft; it is marked ready first, then merged at a later sync"
            case .ciMissing: return "has no CI checks"
            case .ciSkipped: return "every CI check was skipped"
            case .requiredUnread: return "the checks its base branch requires could not be read"
            case .requiredChecks(let names):
                return names.count == 1 ? "the required check \(names[0]) has not passed"
                    : "the required checks \(names.joined(separator: ", ")) have not passed"
            }
        }
    }

    /// The hold on `c`, or nil when it may merge. The first broken rule wins: who the PR is
    /// and who has seen it, then what it changes, then what GitHub is still computing, so a
    /// PR that can never merge says why rather than "CI still running". A required check
    /// that never reported is missing from `ciState`'s rollup, so each must pass by name.
    public static func hold(_ c: Candidate, me: String) -> Hold? {
        if c.state != "open" && c.state != "draft" { return .closed }
        let mine = me.lowercased()
        if c.author.lowercased() != mine || mine.isEmpty { return .notMine(c.author) }
        if c.isCrossRepository { return .fork }
        if c.baseRef != c.defaultBranch || c.baseRef.isEmpty { return .notDefaultBase(c.baseRef) }
        if c.mergeQueue { return .mergeQueue }
        guard let rules = c.baseRules else { return .baseRulesUnread }
        let unchecked = rules.filter { !checks($0, c) }
        if !unchecked.isEmpty { return .baseRules(unchecked) }
        if let other = c.participants.first(where: { $0 != nil && $0!.lowercased() != mine }) {
            return .human(other ?? "")
        }
        if c.participantsUnseen { return .participantsUnseen }
        if c.operatorUntagged { return .operatorComment }
        if c.reviewRequests > 0 { return .reviewRequested(c.reviewRequests) }
        if c.state == "draft" && c.wasReady { return .redrafted }
        if let who = c.foreignCommits.first { return .foreignCommits(who) }
        if c.reviewDecision == "CHANGES_REQUESTED" { return .changesRequested }
        if c.unresolvedThreads > 0 { return .threads(c.unresolvedThreads) }
        if let label = c.stopLabels.first { return .stopLabel(label) }
        if !c.trackLabels { return .offTrack }
        if !c.fixesCandidate { return .notAFix }
        if !c.closesUnwritable.isEmpty { return .closesUnwritable(c.closesUnwritable.joined(separator: ", ")) }
        if c.rating?.isFastTrack != true { return .rated(c.rating) }
        if !c.floor.isFastTrack { return .floor(c.floor) }
        if c.mergeable == "CONFLICTING" { return .conflicting }
        if c.mergeable != "MERGEABLE" || ["", "UNKNOWN"].contains(c.mergeState) { return .mergeabilityUnknown }
        // `--admin` merges a PR behind its base without testing it against the base.
        if c.mergeState == "BEHIND" { return .behind }
        if c.ciCommit != c.headSha { return .ciStale }
        switch c.ciState {
        case "SUCCESS", "": break
        case "PENDING", "EXPECTED": return .ciPending
        default: return .ciFailing(c.ciState)
        }
        if c.state == "draft" { return .draft }
        if c.ciState.isEmpty { return .ciMissing }
        if !c.ciRan { return .ciSkipped }
        guard let required = c.requiredChecks else { return .requiredUnread }
        let missing = required.filter { !c.passedChecks.contains($0) }
        if !missing.isEmpty { return .requiredChecks(missing) }
        return nil
    }

    /// Whether `hold` checks `rule`, or it is the review requirement `--admin` exists to
    /// skip: `--admin` would bypass any other.
    static func checks(_ rule: String, _ c: Candidate) -> Bool {
        switch rule {
        case "PULL_REQUEST", "REQUIRED_STATUS_CHECKS", "NON_FAST_FORWARD", "DELETION", "CREATION": return true
        case "REQUIRED_LINEAR_HISTORY", "requiresLinearHistory": return c.mergeFlag != "--merge"
        // GitHub cannot sign the commits a rebase merge makes.
        case "REQUIRED_SIGNATURES", "requiresCommitSignatures": return c.mergeFlag != "--rebase" && !c.unsignedCommits
        default: return false
        }
    }
}
