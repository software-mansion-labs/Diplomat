import Foundation

// MARK: - Pipeline: the model
//
// Every open issue of every source (the GitHub roots, Linear teams), and the operator's
// open PRs, is rated for risk and complexity, and one within its root's limit goes down the fast track:
// issue -> fix PR -> the PR rated on its own -> reviewed until clean -> rated again at that
// head -> merged with no human review. Anything else is left to a human. The state is
// `PipelineLog.dir`, the ratings included, the trackers' `diplomat:` labels, and Diplomat's
// clean-marker reviews. The Linux front-end reaches `PipelineTick` through `diplomat-core
// pipeline-tick`, never by reimplementing it.

public enum PipelineLevel: String, Codable, CaseIterable, Comparable, Sendable {
    case low, medium, high

    public static func < (a: Self, b: Self) -> Bool {
        allCases.firstIndex(of: a)! < allCases.firstIndex(of: b)!
    }
}

public struct PipelineRating: Codable, Equatable, Sendable {
    public var risk: PipelineLevel
    public var complexity: PipelineLevel

    public init(risk: PipelineLevel, complexity: PipelineLevel) {
        self.risk = risk
        self.complexity = complexity
    }

    public static let low = PipelineRating(risk: .low, complexity: .low)
    /// The highest limit a root may set: a high-risk item takes a takeover.
    public static let maxLimit = PipelineRating(risk: .medium, complexity: .high)

    public func fits(_ limit: PipelineRating) -> Bool { risk <= limit.risk && complexity <= limit.complexity }

    public func atLeast(_ floor: PipelineRating) -> PipelineRating {
        PipelineRating(risk: max(risk, floor.risk), complexity: max(complexity, floor.complexity))
    }
}

public enum PipelineSource: String, Codable, Sendable { case github, linear }

/// Which items a mirrored tracker gets rating labels on, each taking in the one before: the
/// operator's PRs, also their issues (opened by or assigned to them), every item Diplomat may
/// write to.
public enum PipelineMirrorScope: String, Codable, CaseIterable, Comparable, Sendable {
    case prs, mine, all

    public static func < (a: Self, b: Self) -> Bool {
        allCases.firstIndex(of: a)! < allCases.firstIndex(of: b)!
    }
}

public enum PipelineKind: String, Codable, Sendable { case issue, pr }

/// Where an item stands. An issue: `unrated`, then `human` or `candidate` (within its limit, or
/// taken over), or `fractured` into children; `fixing` once an open PR fixes it; `closed`. A PR:
/// `unrated`, then `human` or `fast-track`; `clean` once a Diplomat clean marker names its
/// head; `cleared` once this Diplomat rated it within its limit again at that head, or put `cleared`
/// on it there for a takeover (its log or state says so:
/// the `cleared` label alone, which anyone with triage rights can add, does not), and at a
/// later head carrying that head's change unchanged; `merged` or `closed`.
public enum PipelineStage: String, Codable, CaseIterable, Sendable {
    case unrated, human, candidate, fractured, fixing
    case fastTrack = "fast-track"
    case clean, cleared, merged, closed
}

/// The view's lanes: `fast` is a candidate issue, a fast-track, clean or cleared PR, or an
/// issue a fast-track PR is fixing; `done` is merged or closed.
public enum PipelineLane: String, Codable, CaseIterable, Sendable {
    case unrated, fast, human, fractured, done
}

public struct PipelineItem: Codable, Equatable, Sendable {
    /// Its URL: GitHub's issue or PR page; for Linear, its issue page without the title's
    /// slug, `https://linear.app/<workspace>/issue/<IDENTIFIER>`, so a retitle keeps it.
    public var id: String
    public var source: PipelineSource
    public var kind: PipelineKind
    /// `#12` in the first root, `o/r#12` in another, `ENG-12` on Linear.
    public var label: String
    public var title: String
    /// GitHub `owner/repo`; a Linear team key.
    public var repo: String
    /// `open`, `draft`, `merged` or `closed`.
    public var state: String
    public var author: String?
    public var assignees: [String]
    /// Diplomat may write its labels and act on it: open, with no labels past what one read
    /// lists, unassigned or assigned to the operator only, and for a PR, the operator's own
    /// from a branch of the repository itself into its default branch.
    public var writable: Bool
    public var rating: PipelineRating?
    /// `local` when the rating Diplomat keeps stands, `label` when the tracker's labels set or
    /// raise it; nil while unrated.
    public var ratedBy: String?
    /// The rater's one sentence, when Diplomat rated it.
    public var why: String?
    /// A PR's: the least rating its diff allows.
    public var floor: PipelineRating?
    public var stage: PipelineStage
    public var lane: PipelineLane
    /// Why it is not moving on: a cleared PR's merge hold, an issue that would not split,
    /// a candidate with no repository to fix it in.
    public var hold: String?
    public var headSha: String?
    /// The head the latest Diplomat clean marker names.
    public var cleanAt: String?
    public var updatedAt: Date?
    /// For an issue Diplomat split off another, the author whose text it carries (the
    /// root ancestor's): its fix's ban dimension, as `PipelineEffect`'s `author`.
    public var splitFrom: String?
    /// Why a sync would refuse Rate now or Fracture on it; nil when it would go ahead. What
    /// a front-end gates those buttons on.
    public var rateRefused: String?
    public var fractureRefused: String?
    /// The operator took it over, open: neither its rating nor its triage holds it, nor a
    /// PR's diff floor. Nil when not.
    public var takenOver: Bool?
    /// Why a sync would refuse to take it over; nil when it would go ahead, or it is taken
    /// over already.
    public var takeoverRefused: String?

    public init(id: String, source: PipelineSource, kind: PipelineKind, label: String,
                title: String, repo: String, state: String, author: String? = nil,
                assignees: [String] = [], writable: Bool, rating: PipelineRating? = nil,
                ratedBy: String? = nil, why: String? = nil, floor: PipelineRating? = nil,
                stage: PipelineStage, lane: PipelineLane, hold: String? = nil,
                headSha: String? = nil, cleanAt: String? = nil, updatedAt: Date? = nil,
                splitFrom: String? = nil, rateRefused: String? = nil, fractureRefused: String? = nil,
                takenOver: Bool? = nil, takeoverRefused: String? = nil) {
        self.id = id
        self.source = source
        self.kind = kind
        self.label = label
        self.title = title
        self.repo = repo
        self.state = state
        self.author = author
        self.assignees = assignees
        self.writable = writable
        self.rating = rating
        self.ratedBy = ratedBy
        self.why = why
        self.floor = floor
        self.stage = stage
        self.lane = lane
        self.hold = hold
        self.headSha = headSha
        self.cleanAt = cleanAt
        self.updatedAt = updatedAt
        self.splitFrom = splitFrom
        self.rateRefused = rateRefused
        self.fractureRefused = fractureRefused
        self.takenOver = takenOver
        self.takeoverRefused = takeoverRefused
    }
}

public struct PipelineGraph: Codable, Equatable, Sendable {
    public struct Node: Codable, Equatable, Sendable {
        public var id: String
        public var column: Int
        public var row: Int

        public init(id: String, column: Int, row: Int) {
            self.id = id
            self.column = column
            self.row = row
        }
    }

    public enum EdgeKind: String, Codable, Sendable {
        /// Parent issue -> a child issue (GitHub sub-issue, Linear child).
        case child
        /// Issue -> the PR fixing it.
        case fixes
        /// PR -> the PR whose base branch is its head branch.
        case stacked
    }

    public struct Edge: Codable, Equatable, Sendable {
        public var from: String
        public var to: String
        public var kind: EdgeKind

        public init(from: String, to: String, kind: EdgeKind) {
            self.from = from
            self.to = to
            self.kind = kind
        }
    }

    public var nodes: [Node]
    public var edges: [Edge]

    public init(nodes: [Node] = [], edges: [Edge] = []) {
        self.nodes = nodes
        self.edges = edges
    }
}

public struct PipelineEvent: Codable, Equatable, Sendable {
    public enum Kind: String, Codable, Sendable {
        case rated, labelled, fastTrack = "fast-track", clean, rerated, cleared, merged, held
        case fractured, child, asked, takeover, error
    }

    public var at: Date
    /// The item's id.
    public var item: String
    public var kind: Kind
    public var detail: String
    /// A PR's `rated` or `rerated`: the head it was rated at; a `cleared`: the head it was
    /// cleared at, none for a clear carried to a later head.
    public var head: String?
    /// A `rated` or `rerated`: the rating given, never below the labels or the diff's floor.
    public var rating: PipelineRating?

    public init(at: Date, item: String, kind: Kind, detail: String, head: String? = nil,
                rating: PipelineRating? = nil) {
        self.at = at
        self.item = item
        self.kind = kind
        self.detail = detail
        self.head = head
        self.rating = rating
    }
}

/// Work a sync asks the front-end to queue. The front-end dedupes it by `key` and `stamp`:
/// a fix or review through its attempt records, as it does a review request; a rating by
/// the stamp its job runs at (`PipelineRateJob.run`).
///
/// JSON, flat: `{"kind": "fixIssue", "repo", "number", "url"}`, `{"kind": "fixLinear",
/// "repo", "identifier", "url", "text"}`, `{"kind": "review", "repo", "number", "url",
/// "headSha"}`, `{"kind": "rate", "repo", "number", "url", "stamp", "forced"}`, each with its
/// `author`, `key` and `stamp` beside (the last two written, never read back but a rating's
/// `stamp`).
///
/// `author` is the work's ban dimension, which a front-end checks against the ban list:
/// the issue's author, or for a split's part, its root ancestor's; "" only for the
/// operator's own (a review of their PR).
public enum PipelineEffect: Codable, Equatable, Sendable {
    /// A Fix-issues run for one GitHub issue of the root `repo`.
    case fixIssue(repo: String, number: Int, url: String, author: String)
    /// A Fix-issues run in the root `repo` for one Linear issue, whose text Diplomat read.
    case fixLinear(repo: String, identifier: String, url: String, text: String, author: String)
    /// A fast-track review of the operator's PR at `headSha`.
    case review(repo: String, number: Int, url: String, headSha: String, author: String)
    /// A rating of one item of the root `repo` (`number` 0 for a Linear issue), run at
    /// `stamp`; `forced` by Rate now.
    case rate(repo: String, number: Int, url: String, stamp: String, forced: Bool, author: String)

    public var url: String {
        switch self {
        case .fixIssue(_, _, let url, _), .fixLinear(_, _, let url, _, _), .review(_, _, let url, _, _),
             .rate(_, _, let url, _, _, _): return url
        }
    }

    public var author: String {
        switch self {
        case .fixIssue(_, _, _, let a), .fixLinear(_, _, _, _, let a), .review(_, _, _, _, let a),
             .rate(_, _, _, _, _, let a): return a
        }
    }

    /// One per item and kind of work.
    public var key: String {
        switch self {
        case .fixIssue, .fixLinear: return "pipeline-fix:" + url
        case .review: return "pipeline-review:" + url
        case .rate: return "pipeline-rate:" + url
        }
    }

    /// What a new attempt is owed for: a review per head; a fix once; a rating per ask.
    public var stamp: String {
        switch self {
        case .review(_, _, _, let sha, _): return sha
        case .rate(_, _, _, let stamp, _, _): return stamp
        case .fixIssue, .fixLinear: return "fix"
        }
    }

    private enum CodingKeys: String, CodingKey {
        case kind, repo, number, url, identifier, text, headSha, author, key, stamp, forced
    }

    /// An effect without its `author` does not decode: a missing one must not read as
    /// the operator's own.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let kind = try c.decode(String.self, forKey: .kind)
        let repo = try c.decode(String.self, forKey: .repo)
        let url = try c.decode(String.self, forKey: .url)
        let author = try c.decode(String.self, forKey: .author)
        switch kind {
        case "fixIssue":
            self = .fixIssue(repo: repo, number: try c.decode(Int.self, forKey: .number), url: url, author: author)
        case "fixLinear":
            self = .fixLinear(repo: repo, identifier: try c.decode(String.self, forKey: .identifier),
                              url: url, text: try c.decode(String.self, forKey: .text), author: author)
        case "review":
            self = .review(repo: repo, number: try c.decode(Int.self, forKey: .number), url: url,
                           headSha: try c.decode(String.self, forKey: .headSha), author: author)
        case "rate":
            self = .rate(repo: repo, number: try c.decode(Int.self, forKey: .number), url: url,
                         stamp: try c.decode(String.self, forKey: .stamp),
                         forced: try c.decode(Bool.self, forKey: .forced), author: author)
        default:
            throw DecodingError.dataCorruptedError(forKey: .kind, in: c,
                                                   debugDescription: "unknown effect \(kind)")
        }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .fixIssue(let repo, let number, _, _):
            try c.encode("fixIssue", forKey: .kind)
            try c.encode(repo, forKey: .repo)
            try c.encode(number, forKey: .number)
        case .fixLinear(let repo, let identifier, _, let text, _):
            try c.encode("fixLinear", forKey: .kind)
            try c.encode(repo, forKey: .repo)
            try c.encode(identifier, forKey: .identifier)
            try c.encode(text, forKey: .text)
        case .review(let repo, let number, _, let headSha, _):
            try c.encode("review", forKey: .kind)
            try c.encode(repo, forKey: .repo)
            try c.encode(number, forKey: .number)
            try c.encode(headSha, forKey: .headSha)
        case .rate(let repo, let number, _, _, let forced, _):
            try c.encode("rate", forKey: .kind)
            try c.encode(repo, forKey: .repo)
            try c.encode(number, forKey: .number)
            try c.encode(forced, forKey: .forced)
        }
        try c.encode(author, forKey: .author)
        try c.encode(url, forKey: .url)
        try c.encode(key, forKey: .key)
        try c.encode(stamp, forKey: .stamp)
    }
}

public struct PipelineSettings: Codable, Equatable, Sendable {
    /// A GitHub root: its checkout, and `me`, which a sync takes from the account `gh` acts
    /// as.
    public struct Root: Codable, Equatable, Sendable {
        public var owner: String
        public var repo: String
        public var path: String
        public var me: String
        /// The highest rating its fast track takes, at most `PipelineRating.maxLimit`.
        public let limit: PipelineRating
        /// GitHub's `owner/repo` for it as a sync read it, which a rename or transfer makes
        /// differ from `slug`; never encoded.
        var nameWithOwner: String?

        public init(owner: String, repo: String, path: String, me: String, limit: PipelineRating = .low) {
            self.owner = owner
            self.repo = repo
            self.path = path
            self.me = me
            self.limit = PipelineRating(risk: min(limit.risk, PipelineRating.maxLimit.risk),
                                        complexity: min(limit.complexity, PipelineRating.maxLimit.complexity))
        }

        private enum CodingKeys: String, CodingKey { case owner, repo, path, me, limit }

        /// A missing `limit` reads as low/low.
        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            self.init(owner: try c.decode(String.self, forKey: .owner), repo: try c.decode(String.self, forKey: .repo),
                      path: try c.decode(String.self, forKey: .path), me: try c.decode(String.self, forKey: .me),
                      limit: try c.decodeIfPresent(PipelineRating.self, forKey: .limit) ?? .low)
        }

        /// The root as configured, which the settings, `unread` and effects name it by.
        public var slug: String { "\(owner)/\(repo)" }
        /// The name its links carry and its calls use.
        var name: String { nameWithOwner ?? slug }
    }

    /// A Linear team tracked, and the root (`owner/repo`) its issues are fixed in.
    public struct LinearTeam: Codable, Equatable, Sendable {
        public var key: String
        public var repo: String

        public init(key: String, repo: String) {
            self.key = key
            self.repo = repo
        }
    }

    /// What the operator asked for from the view, past a sync's own limits on asks and splits:
    /// items to rate, to split, to take over and whose takeover to revoke.
    public struct Force: Codable, Equatable, Sendable {
        public var rate: [String]
        public var fracture: [String]
        public var takeover: [String]
        public var revoke: [String]

        public init(rate: [String] = [], fracture: [String] = [], takeover: [String] = [], revoke: [String] = []) {
            self.rate = rate
            self.fracture = fracture
            self.takeover = takeover
            self.revoke = revoke
        }

        private enum CodingKeys: String, CodingKey { case rate, fracture, takeover, revoke }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            self.init(rate: try c.decodeIfPresent([String].self, forKey: .rate) ?? [],
                      fracture: try c.decodeIfPresent([String].self, forKey: .fracture) ?? [],
                      takeover: try c.decodeIfPresent([String].self, forKey: .takeover) ?? [],
                      revoke: try c.decodeIfPresent([String].self, forKey: .revoke) ?? [])
        }

        public var isEmpty: Bool { rate.isEmpty && fracture.isEmpty && takeover.isEmpty && revoke.isEmpty }
    }

    public var roots: [Root]
    public var linearTeams: [LinearTeam]
    /// Rate items unasked, and finish the ratings a sync could not. It stops nothing else: a
    /// forced rating, and each other switch's steps, go on with it off.
    public var rate: Bool
    /// Write each rating as labels on GitHub, on Linear, onto the items `mirrorScope` takes in.
    public var mirrorGitHub: Bool
    public var mirrorLinear: Bool
    public var mirrorScope: PipelineMirrorScope
    /// Ask for a fix PR for each candidate issue.
    public var fix: Bool
    /// Label PRs within their root's limit `fastTrack` and ask for their reviews.
    public var fastTrack: Bool
    /// Merge cleared PRs past the review requirement.
    public var merge: Bool
    /// Split writable issues more complex than their root's limit into low-complexity children.
    public var fracture: Bool
    public var force: Force?
    /// The ids of the items the front-end holds a pipeline ask or attempt record for, which a
    /// sync reads even past a cap or once closed, so `read` can take each back.
    public var queued: [String]

    public init(roots: [Root], linearTeams: [LinearTeam] = [], rate: Bool = false,
                mirrorGitHub: Bool = false, mirrorLinear: Bool = false, mirrorScope: PipelineMirrorScope = .prs,
                fix: Bool = false, fastTrack: Bool = false, merge: Bool = false, fracture: Bool = false,
                force: Force? = nil, queued: [String] = []) {
        self.roots = roots
        self.linearTeams = linearTeams
        self.rate = rate
        self.mirrorGitHub = mirrorGitHub
        self.mirrorLinear = mirrorLinear
        self.mirrorScope = mirrorScope
        self.fix = fix
        self.fastTrack = fastTrack
        self.merge = merge
        self.fracture = fracture
        self.force = force
        self.queued = queued
    }

    private enum CodingKeys: String, CodingKey {
        case roots, linearTeams, rate, mirrorGitHub, mirrorLinear, mirrorScope, fix, fastTrack,
             merge, fracture, force, queued
    }

    /// A missing field reads as empty, a missing switch as off, and a missing scope as `prs`.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        func on(_ key: CodingKeys) throws -> Bool { try c.decodeIfPresent(Bool.self, forKey: key) ?? false }
        self.init(roots: try c.decodeIfPresent([Root].self, forKey: .roots) ?? [],
                  linearTeams: try c.decodeIfPresent([LinearTeam].self, forKey: .linearTeams) ?? [],
                  rate: try on(.rate), mirrorGitHub: try on(.mirrorGitHub), mirrorLinear: try on(.mirrorLinear),
                  mirrorScope: try c.decodeIfPresent(PipelineMirrorScope.self, forKey: .mirrorScope) ?? .prs,
                  fix: try on(.fix), fastTrack: try on(.fastTrack),
                  merge: try on(.merge), fracture: try on(.fracture),
                  force: try c.decodeIfPresent(Force.self, forKey: .force),
                  queued: try c.decodeIfPresent([String].self, forKey: .queued) ?? [])
    }
}

/// The pipeline's switches as the front-end has them now: `control.json` in
/// `PipelineLog.dir`, which it rewrites whole whenever one changes, a takeover or revoke is
/// asked, and before each sync. A sync reads it right before every outward step and rating
/// call, and skips a step whose switch, or `enabled`, is off; a forced step needs `enabled`
/// alone, and taking back the sync's own split claim needs neither. It can only stop what
/// the settings allow: any root's limit below the sync's stops every fix, fast-track and
/// merge step. A missing, incomplete or unreadable file leaves the settings as they were.
public struct PipelineControl: Codable, Equatable, Sendable {
    public var enabled: Bool
    public var rate: Bool
    public var mirrorGitHub: Bool
    public var mirrorLinear: Bool
    public var mirrorScope: PipelineMirrorScope
    public var fix: Bool
    public var fastTrack: Bool
    public var merge: Bool
    public var fracture: Bool
    /// The items whose takeover the operator revoked and no sync has answered yet: a sync
    /// running applies them right before each merge and its asks.
    public var revoke: [String]?
    /// Each root's limit by its `owner/repo`, lowercased, a root missing from it at low/low;
    /// nil stops nothing.
    public var limits: [String: PipelineRating]?

    public init(enabled: Bool, rate: Bool, mirrorGitHub: Bool, mirrorLinear: Bool, mirrorScope: PipelineMirrorScope,
                fix: Bool, fastTrack: Bool, merge: Bool, fracture: Bool, revoke: [String]? = nil,
                limits: [String: PipelineRating]? = nil) {
        self.enabled = enabled
        self.rate = rate
        self.mirrorGitHub = mirrorGitHub
        self.mirrorLinear = mirrorLinear
        self.mirrorScope = mirrorScope
        self.fix = fix
        self.fastTrack = fastTrack
        self.merge = merge
        self.fracture = fracture
        self.revoke = revoke
        self.limits = limits
    }

    public init(settings: PipelineSettings) {
        self.init(enabled: true, rate: settings.rate, mirrorGitHub: settings.mirrorGitHub,
                  mirrorLinear: settings.mirrorLinear, mirrorScope: settings.mirrorScope, fix: settings.fix,
                  fastTrack: settings.fastTrack, merge: settings.merge, fracture: settings.fracture,
                  limits: Dictionary(settings.roots.map { ($0.slug.lowercased(), $0.limit) }) { a, _ in a })
    }

    public func limit(_ slug: String) -> PipelineRating? {
        limits.map { $0[slug.lowercased()] ?? .low }
    }
}

public struct PipelineTickResult: Codable, Equatable, Sendable {
    public var at: Date
    public var items: [PipelineItem]
    public var graph: PipelineGraph
    public var effects: [PipelineEffect]
    /// The log's latest events, newest last.
    public var events: [PipelineEvent]
    /// What failed this sync, one line per source or action.
    public var notices: [String]
    /// The roots (`owner/repo`) this sync could not judge in full, whose effects it may
    /// have left out: a front-end withdraws a queued ask on them only for an item in `read`.
    public var unread: [String]
    /// The ids of every issue this sync read that a fix may act on, the ones `items` leaves
    /// out included: what keeps a fix the operator started queued.
    public var fixable: [String]
    /// The ids of every item this sync read, the ones `items` leaves out included, but none
    /// of a root it only read and showed, nor a Linear issue whose mapped root it did not
    /// read or that it could not read again before its fix, nor of a sync blocked or without
    /// the ban list: in an `unread` root, the asks a front-end may still judge.
    public var read: [String]

    public init(at: Date, items: [PipelineItem] = [], graph: PipelineGraph = PipelineGraph(),
                effects: [PipelineEffect] = [], events: [PipelineEvent] = [],
                notices: [String] = [], unread: [String] = [], fixable: [String] = [],
                read: [String] = []) {
        self.at = at
        self.items = items
        self.graph = graph
        self.effects = effects
        self.events = events
        self.notices = notices
        self.unread = unread
        self.fixable = fixable
        self.read = read
    }
}

/// A Linear issue as Diplomat read it, for a fix run that cannot read Linear itself.
public struct LinearIssue: Codable, Equatable, Sendable {
    public var identifier: String
    public var url: String
    public var text: String

    public init(identifier: String, url: String, text: String) {
        self.identifier = identifier
        self.url = url
        self.text = text
    }
}

extension PipelineSettings.LinearTeam {
    /// The Settings line `ENG=owner/repo, OPS=owner/other` (commas, semicolons or new
    /// lines between entries) as teams, and the entries that are not `KEY=owner/repo`, as
    /// typed. A key is ASCII letters and digits, read in capitals as Linear spells it; an
    /// owner and a repo are ASCII letters, digits, `_`, `.` and `-`. A team named twice
    /// keeps its first repo. Twin of `pipeline.parse_linear_teams`, which
    /// `diplomat-core pipeline-teams` pins it to.
    public static func parse(_ raw: String) -> (teams: [Self], bad: [String]) {
        // Spaces, tabs and the carriage return of a pasted CRLF line, never Unicode
        // spacing: Python's `strip()` and Foundation's whitespace sets disagree on it.
        let space = CharacterSet(charactersIn: " \t\r\u{0B}\u{0C}")
        let alnum: [ClosedRange<Unicode.Scalar>] = ["a"..."z", "A"..."Z", "0"..."9"]
        func ascii(_ s: String, also extra: String) -> Bool {
            !s.isEmpty && s.unicodeScalars.allSatisfy { c in
                alnum.contains { $0.contains(c) } || extra.unicodeScalars.contains(c)
            }
        }
        // By scalar: a `\r\n` is one Character, which would hide its `\n`.
        var entries: [String] = []
        var piece = String.UnicodeScalarView()
        for c in raw.unicodeScalars {
            if c == "," || c == ";" || c == "\n" {
                entries.append(String(piece))
                piece = String.UnicodeScalarView()
            } else {
                piece.append(c)
            }
        }
        entries.append(String(piece))
        var teams: [Self] = []
        var bad: [String] = []
        for entry in entries.map({ $0.trimmingCharacters(in: space) }) where !entry.isEmpty {
            let scalars = entry.unicodeScalars
            guard let eq = scalars.firstIndex(of: "=") else {
                bad.append(entry)
                continue
            }
            let key = String(scalars[..<eq]).trimmingCharacters(in: space)
            let repo = String(scalars[scalars.index(after: eq)...]).trimmingCharacters(in: space)
            let parts = repo.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
            guard ascii(key, also: ""), parts.count == 2, parts.allSatisfy({ ascii($0, also: "_.-") }) else {
                bad.append(entry)
                continue
            }
            let upper = key.uppercased()
            if !teams.contains(where: { $0.key == upper }) { teams.append(Self(key: upper, repo: repo)) }
        }
        return (teams, bad)
    }
}
