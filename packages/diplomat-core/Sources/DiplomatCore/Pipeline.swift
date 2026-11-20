import Foundation

// MARK: - Pipeline: the model
//
// Every open issue and PR of every source (the GitHub roots, Linear teams) is rated for
// risk and complexity, and a low/low one goes down the fast track: issue -> fix PR -> the
// PR rated on its own -> reviewed until clean -> rated again at that head -> merged with no
// human review. Anything else is left to a human. The state is the trackers' labels
// (`assets/pipeline.json` `labels`) and Diplomat's clean-marker reviews; `PipelineLog.dir`
// only logs what happened and caches ratings Diplomat may not write. `PipelineTick` runs a
// sync; the Linux front-end reaches it through `diplomat-core pipeline-tick`, never by
// reimplementing it.

/// Ordered, so the higher of two is `max`.
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

    public var isFastTrack: Bool { risk == .low && complexity == .low }

    /// Each dimension raised to `floor`'s, never lowered.
    public func atLeast(_ floor: PipelineRating) -> PipelineRating {
        PipelineRating(risk: max(risk, floor.risk), complexity: max(complexity, floor.complexity))
    }
}

public enum PipelineSource: String, Codable, Sendable { case github, linear }

public enum PipelineKind: String, Codable, Sendable { case issue, pr }

/// Where an item stands. An issue: `unrated`, then `human` or `candidate` (low/low), or
/// `fractured` into children; `fixing` once an open PR fixes it; `closed`. A PR:
/// `unrated`, then `human` or `fast-track`; `clean` once a Diplomat clean marker names its
/// head; `cleared` once rated low/low again at that head; `merged` or `closed`.
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
    /// Its URL: GitHub's issue or PR page, Linear's issue page.
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
    /// Diplomat may write its labels and act on it: an issue unassigned or assigned to the
    /// operator, or the operator's own PR from a branch of the repository itself.
    public var writable: Bool
    public var rating: PipelineRating?
    /// `label` when read off the tracker, `local` when Diplomat rated an item it may not
    /// label; nil while unrated.
    public var ratedBy: String?
    /// The rater's one sentence, when Diplomat rated it.
    public var why: String?
    /// A PR's: the least rating its diff allows (`floor` in the asset).
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

    public init(id: String, source: PipelineSource, kind: PipelineKind, label: String,
                title: String, repo: String, state: String, author: String? = nil,
                assignees: [String] = [], writable: Bool, rating: PipelineRating? = nil,
                ratedBy: String? = nil, why: String? = nil, floor: PipelineRating? = nil,
                stage: PipelineStage, lane: PipelineLane, hold: String? = nil,
                headSha: String? = nil, cleanAt: String? = nil, updatedAt: Date? = nil) {
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
    }
}

/// Items laid out on a grid: each connected group of items left to right along its edges
/// (a parent before its children, an issue before the PR fixing it, a PR before the one
/// stacked on it), groups one below another, unsettled groups first.
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

/// One step of an item's traversal, as Diplomat saw or took it.
public struct PipelineEvent: Codable, Equatable, Sendable {
    public enum Kind: String, Codable, Sendable {
        case rated, labelled, fastTrack = "fast-track", clean, rerated, cleared, merged, held
        case fractured, child, asked, error
    }

    public var at: Date
    /// The item's id.
    public var item: String
    public var kind: Kind
    public var detail: String

    public init(at: Date, item: String, kind: Kind, detail: String) {
        self.at = at
        self.item = item
        self.kind = kind
        self.detail = detail
    }
}

/// Agent work a sync asks the front-end to queue. The front-end dedupes it by `key` and
/// `stamp` through its attempt records, as it does a review request.
public enum PipelineEffect: Codable, Equatable, Sendable {
    /// A Fix-issues run for one GitHub issue of the root `repo`.
    case fixIssue(repo: String, number: Int, url: String)
    /// A Fix-issues run in the root `repo` for one Linear issue, whose text Diplomat read.
    case fixLinear(repo: String, identifier: String, url: String, text: String)
    /// A fast-track review of the operator's PR at `headSha`.
    case review(repo: String, number: Int, url: String, headSha: String)

    public var url: String {
        switch self {
        case .fixIssue(_, _, let url), .fixLinear(_, _, let url, _), .review(_, _, let url, _): return url
        }
    }

    /// One per item and kind of work.
    public var key: String {
        switch self {
        case .fixIssue, .fixLinear: return "pipeline-fix:" + url
        case .review: return "pipeline-review:" + url
        }
    }

    /// What a new attempt is owed for: a review per head; a fix once.
    public var stamp: String {
        if case .review(_, _, _, let sha) = self { return sha }
        return "fix"
    }
}

public struct PipelineSettings: Codable, Equatable, Sendable {
    /// A GitHub root: its checkout, and the operator's login there.
    public struct Root: Codable, Equatable, Sendable {
        public var owner: String
        public var repo: String
        public var path: String
        public var me: String

        public init(owner: String, repo: String, path: String, me: String) {
            self.owner = owner
            self.repo = repo
            self.path = path
            self.me = me
        }

        public var slug: String { "\(owner)/\(repo)" }
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

    /// What the operator asked for from the view, ahead of every limit.
    public struct Force: Codable, Equatable, Sendable {
        public var rate: [String]
        public var fracture: [String]

        public init(rate: [String] = [], fracture: [String] = []) {
            self.rate = rate
            self.fracture = fracture
        }
    }

    public var roots: [Root]
    public var linearTeams: [LinearTeam]
    /// The Keychain item (macOS) or file (Linux) holding the Linear API key: its name, never
    /// the key. `DIPLOMAT_LINEAR_TOKEN` overrides either.
    public var linearKeychainItem: String?
    public var linearTokenFile: String?
    /// Rate unrated items. Off, a sync only reads.
    public var rate: Bool
    /// Ask for a fix PR for each candidate issue.
    public var fix: Bool
    /// Label low/low PRs `fastTrack` and ask for their reviews.
    public var fastTrack: Bool
    /// Merge cleared PRs past the review requirement.
    public var merge: Bool
    /// Split writable medium/high-complexity issues into low-complexity children.
    public var fracture: Bool
    public var force: Force?

    public init(roots: [Root], linearTeams: [LinearTeam] = [], linearKeychainItem: String? = nil,
                linearTokenFile: String? = nil, rate: Bool = false, fix: Bool = false,
                fastTrack: Bool = false, merge: Bool = false, fracture: Bool = false,
                force: Force? = nil) {
        self.roots = roots
        self.linearTeams = linearTeams
        self.linearKeychainItem = linearKeychainItem
        self.linearTokenFile = linearTokenFile
        self.rate = rate
        self.fix = fix
        self.fastTrack = fastTrack
        self.merge = merge
        self.fracture = fracture
        self.force = force
    }
}

public struct PipelineTickResult: Codable, Equatable, Sendable {
    public var at: Date
    public var items: [PipelineItem]
    public var graph: PipelineGraph
    public var effects: [PipelineEffect]
    /// The log's latest events, newest last: the view's traversals.
    public var events: [PipelineEvent]
    /// What failed this sync, one line per source or action.
    public var notices: [String]

    public init(at: Date, items: [PipelineItem] = [], graph: PipelineGraph = PipelineGraph(),
                effects: [PipelineEffect] = [], events: [PipelineEvent] = [],
                notices: [String] = []) {
        self.at = at
        self.items = items
        self.graph = graph
        self.effects = effects
        self.events = events
        self.notices = notices
    }
}
