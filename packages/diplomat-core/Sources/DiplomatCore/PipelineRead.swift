import Foundation

/// One item as a sync read it: the `PipelineItem` the view gets, and what the sync decides
/// on besides.
struct PipelineEntry {
    /// What only `PullRequest`'s `Gate` reads of a PR.
    struct Gate {
        /// Who, besides the operator, authored or committed one of its commits: "" for
        /// one GitHub links to no account, or for commits past the read's page.
        var foreignCommits: [String] = []
        /// A check on the head ran rather than being skipped.
        var ciRan = false
        /// The checks its base branch requires, by name; nil when they could not be read.
        var requiredChecks: [String]? = []
        /// The head's checks that succeeded as ones its base branch requires of it.
        var passedChecks: Set<String> = []
        /// Its base branch's rules (`baseRules`); nil when they could not be read.
        var baseRules: [String]? = []
        /// A commit is not signed and verified, or past the read's page.
        var unsignedCommits = false
        /// The `gh pr merge` flags every pull request rule on its base branch allows.
        var mergeFlags = PipelineRead.mergeFlags.map(\.flag)
    }

    var item: PipelineItem
    var labels: [String]
    var body: String
    /// The GitHub root it is in; for a Linear issue, its team's root, if it has one.
    var root: PipelineSettings.Root?
    var number: Int?
    /// The id a mutation names it by: a GitHub issue's node id, a Linear issue's id.
    var nodeID: String?
    var parent: String?
    var children: [String] = []
    /// A PR's closing references; a Linear issue's attachment URLs.
    var links: [String] = []
    /// A Linear issue's attachments run past the read's page.
    var linksPast = false
    /// The operator's issue says it is a part Diplomat split off.
    var isPart = false
    /// Whose text that part carries, as its marker names it.
    var lineage: String?
    /// A GitHub issue's type, nil for none.
    var issueType: String?
    /// A Linear issue's state when its type is triage or duplicate.
    var triageState: String?
    /// A PR's: the Linear identifiers its title and body close (`PipelineRead.linearCloses`),
    /// and with `Gate` its commit messages too.
    var closesLinear: [String] = []
    /// A PR's open closing references: an empty URL for references past the read's page.
    var closes: [String] = []
    /// A PR's, read with `Gate`: each issue it would close as it stands now, and whether it
    /// would close more than the read lists.
    var closing: [PipelineEntry] = []
    var closingPast = false
    /// A PR's, read with `Gate`: the GitHub issues its title and commit messages close, which
    /// GitHub leaves out of its closing references but closes on the merge.
    var closesText: [String] = []
    /// A PR's, read with `Gate`: it was ready for review at some point.
    var readied = false
    /// A merged PR's, read with `PullRequest`: who merged it.
    var mergedBy: String?
    /// A PR's, read with `Item`: the labels ever added to it, lowercased; nil when the read
    /// did not list them all.
    var labeled: Set<String>?
    var headRef = ""
    var baseRef = ""
    var defaultBranch = ""
    var isDraft = false
    var isCrossRepository = false
    var mergeable = ""
    var mergeState = ""
    var mergeQueue = false
    var reviewDecision = ""
    var changedFiles = 0
    var files: [PipelineGate.ChangedFile] = []
    var ciCommit = ""
    var ciState = ""
    var unresolvedThreads = 0
    var reviewRequests = 0
    var participants: [String?] = []
    var participantsUnseen = false
    /// A comment or review body of the operator's that does not open with Diplomat's tag.
    var operatorUntagged = false
    /// The heads the operator's clean-marker reviews name, oldest first.
    var markers: [String] = []
    /// Nil unless it was read with `Gate`.
    var gate: Gate?
    /// Linear: the team's id, and the issue's labels by name.
    var teamID: String?
    var labelIDs: [String: String] = [:]
    /// Why Diplomat may not write to it, nil when it may.
    var unwritable: String?

    var id: String { item.id }
}

/// What one root's read says about the repository itself.
struct PipelineRepo {
    var defaultBranch: String
    /// Of `--squash`, `--merge` and `--rebase`, in that order, those the repository allows.
    var mergeFlags: [String]
}

enum PipelineRead {
    /// A response `gh` handed over bridges its booleans to `Bool`; the CLI's stdin keeps
    /// them apart from numbers (`JSONInput.Flag`).
    static func bool(_ value: Any?, _ fallback: Bool) -> Bool {
        (value as? JSONInput.Flag)?.on ?? (value as? Bool) ?? fallback
    }

    static func nodes(_ object: [String: Any]?, _ key: String) -> [[String: Any]] {
        (object?[key] as? [String: Any])?["nodes"] as? [[String: Any]] ?? []
    }

    static func total(_ object: [String: Any]?, _ key: String) -> Int {
        (object?[key] as? [String: Any])?["totalCount"] as? Int ?? 0
    }

    static func date(_ value: Any?) -> Date? { (value as? String).flatMap(CommsLog.parseISO) }

    static func login(_ node: [String: Any]?) -> String {
        (node?["author"] as? [String: Any])?["login"] as? String ?? ""
    }

    /// Whether two GitHub issue or PR links are of one repository: the same
    /// `https://host/owner/repo/` before their last two components.
    static func sameRepo(_ a: String, _ b: String) -> Bool {
        func base(_ url: String) -> String? {
            URL(string: url)?.deletingLastPathComponent().deletingLastPathComponent().absoluteString.lowercased()
        }
        return base(a) != nil && base(a) == base(b)
    }

    /// Whether a clean-marker review's `body`, past Diplomat's tag, opens with `marker` and
    /// the full `oid` the review was submitted at.
    static func names(_ body: String, marker: String, oid: String) -> Bool {
        guard !oid.isEmpty else { return false }
        var text = Substring(body.trimmingCharacters(in: .whitespacesAndNewlines))
        if text.hasPrefix(ReviewAudit.tag), let close = text.range(of: #"\]: "#) {
            text = text[close.upperBound...]
        }
        guard text.hasPrefix(marker + " ") else { return false }
        return text.dropFirst(marker.count + 1).prefix { $0.isHexDigit }.lowercased() == oid.lowercased()
    }

    /// Why an item whose labels run past the read's page may not be written: a rating
    /// label among the unread ones would go unseen. GitHub counts them; Linear says
    /// whether a page follows.
    static func labelsCut(_ node: [String: Any], _ labels: [String]) -> String? {
        let page = (node["labels"] as? [String: Any])?["pageInfo"] as? [String: Any]
        return total(node, "labels") > labels.count || bool(page?["hasNextPage"], false)
            ? "has more labels than one read lists" : nil
    }

    /// Each `gh pr merge` flag, with the repository setting and the pull request rule's
    /// `allowedMergeMethods` value that allow it.
    static let mergeFlags = [(flag: "--squash", setting: "squashMergeAllowed", method: "SQUASH"),
                             (flag: "--merge", setting: "mergeCommitAllowed", method: "MERGE"),
                             (flag: "--rebase", setting: "rebaseMergeAllowed", method: "REBASE")]

    /// The hidden marker the `k`th part of `parent` ends with, naming `who`, whose text it
    /// carries.
    static func partMarker(_ k: Int, of parent: String, by who: String) -> String {
        "<!-- Diplomat: part \(k) of \(parent) by \(who.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? "") -->"
    }

    private static let marker = try! NSRegularExpression(pattern: #"<!-- Diplomat: part \d+ of \S+ by (\S*) -->"#)

    /// Whose text a part's `body` carries, as its marker names it; nil for none.
    static func lineage(_ body: String) -> String? {
        let ns = body as NSString
        guard let m = marker.matches(in: body, range: NSRange(location: 0, length: ns.length)).last else { return nil }
        return ns.substring(with: m.range(at: 1)).removingPercentEncoding
    }

    private static let link = try! NSRegularExpression(pattern: #"https?://[^\s<>()\[\]]+"#)

    /// Whether the body of an issue whose parent is `parent` says it is a part Diplomat split
    /// off: by its marker, in any form, or by a line naming that parent, which Linear may keep
    /// where it drops the marker.
    static func isPart(_ body: String, parent: String?) -> Bool {
        if body.contains("<!-- Diplomat: part ") { return true }
        guard let parent else { return false }
        return body.split(whereSeparator: \.isNewline).contains { line in
            guard line.hasPrefix("Part of ") else { return false }
            let text = String(line)
            return link.matches(in: text, range: NSRange(location: 0, length: (text as NSString).length)).contains {
                norm(linearURL((text as NSString).substring(with: $0.range))) == norm(parent)
            }
        }
    }

    /// One page of a `pipeline-repo.graphql` operation for `root`: `Repo`'s, or one of
    /// `Issues` or `PullRequests` given the `repo` that `Repo` read, with the cursors of
    /// the pages after it. `primary` is the first root, whose items are labelled `#N`;
    /// others' are `owner/repo#N`.
    static func github(_ response: [String: Any], root: PipelineSettings.Root, primary: Bool,
                       model: CoreAssets.PipelineModel, repo known: PipelineRepo? = nil)
        -> (repo: PipelineRepo, entries: [PipelineEntry], issuesAfter: String?, prsAfter: String?) {
        let repo = (response["data"] as? [String: Any])?["repository"] as? [String: Any]
        let read = known ?? PipelineRepo(
            defaultBranch: (repo?["defaultBranchRef"] as? [String: Any])?["name"] as? String ?? "",
            mergeFlags: mergeFlags.filter { bool(repo?[$0.setting], false) }.map(\.flag))
        func after(_ key: String) -> String? {
            let page = (repo?[key] as? [String: Any])?["pageInfo"] as? [String: Any]
            return bool(page?["hasNextPage"], false) ? page?["endCursor"] as? String : nil
        }
        func label(_ n: Int) -> String { primary ? "#\(n)" : "\(root.slug)#\(n)" }
        var out: [PipelineEntry] = []

        for n in nodes(repo, "issues") {
            if let e = issue(n, root: root, label: label) { out.append(e) }
        }

        for n in nodes(repo, "pullRequests") {
            if let e = pr(n, root: root, label: label, defaultBranch: read.defaultBranch, model: model) {
                out.append(e)
            }
        }

        let pipelineLabels = Set(model.all.map { $0.lowercased() })
        for n in nodes(repo, "done") {
            guard let number = n["number"] as? Int, let url = n["url"] as? String else { continue }
            let labels = nodes(n, "labels").compactMap { $0["name"] as? String }
            guard labels.contains(where: { pipelineLabels.contains($0.lowercased()) }) else { continue }
            let merged = n["state"] as? String == "MERGED"
            var e = PipelineEntry(
                item: PipelineItem(id: url, source: .github, kind: .pr, label: label(number),
                                   title: n["title"] as? String ?? "", repo: root.slug,
                                   state: merged ? "merged" : "closed", author: login(n),
                                   writable: false, stage: merged ? .merged : .closed, lane: .done,
                                   updatedAt: date(n["updatedAt"])),
                labels: labels, body: "", root: root, number: number)
            e.links = nodes(n, "closingIssuesReferences").compactMap { $0["url"] as? String }
            e.headRef = n["headRefName"] as? String ?? ""
            e.baseRef = n["baseRefName"] as? String ?? ""
            e.defaultBranch = read.defaultBranch
            e.isCrossRepository = bool(n["isCrossRepository"], true)
            e.unwritable = merged ? "merged" : "closed"
            out.append(e)
            // The closed issues of this repository it closes, so its group reads issue ->
            // PR. An open one is left to the open issues' read.
            for c in nodes(n, "closingIssuesReferences") {
                guard c["state"] as? String == "CLOSED", let fixed = c["number"] as? Int,
                      let issue = c["url"] as? String, sameRepo(issue, url) else { continue }
                var closed = PipelineEntry(
                    item: PipelineItem(id: issue, source: .github, kind: .issue, label: label(fixed),
                                       title: c["title"] as? String ?? "", repo: root.slug, state: "closed",
                                       writable: false, stage: .closed, lane: .done),
                    labels: [], body: "", root: root, number: fixed)
                closed.unwritable = "closed"
                out.append(closed)
            }
        }
        return (read, out, after("issues"), after("pullRequests"))
    }

    /// One `Issue` node of `root`'s repository, none for one outside every root, which is no
    /// one's to write to: open, unless the node says otherwise.
    static func issue(_ n: [String: Any], root: PipelineSettings.Root?, label: (Int) -> String) -> PipelineEntry? {
        guard let number = n["number"] as? Int, let url = n["url"] as? String else { return nil }
        let me = root?.me.lowercased() ?? ""
        let assignees = nodes(n, "assignees").compactMap { $0["login"] as? String }
        let labels = nodes(n, "labels").compactMap { $0["name"] as? String }
        let state = n["state"] as? String == "CLOSED" ? "closed" : "open"
        let unwritable = state == "closed" ? state : labelsCut(n, labels)
            ?? (assignees.allSatisfy { $0.lowercased() == me } && !me.isEmpty ? nil
                : "assigned to \(assignees.map { "@" + $0 }.joined(separator: ", "))")
        var e = PipelineEntry(
            item: PipelineItem(id: url, source: .github, kind: .issue, label: label(number),
                               title: n["title"] as? String ?? "", repo: root?.slug ?? "", state: state,
                               author: login(n), assignees: assignees, writable: unwritable == nil,
                               stage: .unrated, lane: .unrated, updatedAt: date(n["updatedAt"])),
            labels: labels, body: n["body"] as? String ?? "", root: root, number: number,
            nodeID: n["id"] as? String)
        e.parent = (n["parent"] as? [String: Any])?["url"] as? String
        e.children = nodes(n, "subIssues").compactMap { $0["url"] as? String }
        e.issueType = (n["issueType"] as? [String: Any])?["name"] as? String
        // Diplomat files a part as the operator: no one else's text names a lineage.
        if !me.isEmpty, e.item.author?.lowercased() == me {
            e.isPart = isPart(e.body, parent: e.parent)
            e.lineage = lineage(e.body)
        }
        e.unwritable = unwritable
        return e
    }

    /// The `PullRequest` operation's answer: the PR, read with `Gate`, labelled `label`; the
    /// issues it closes are judged against `roots`.
    static func pullRequest(_ response: [String: Any], root: PipelineSettings.Root, label: String,
                            roots: [PipelineSettings.Root], model: CoreAssets.PipelineModel) -> PipelineEntry? {
        let repo = (response["data"] as? [String: Any])?["repository"] as? [String: Any]
        guard let n = repo?["pullRequest"] as? [String: Any] else { return nil }
        let defaultBranch = (repo?["defaultBranchRef"] as? [String: Any])?["name"] as? String ?? ""
        return pr(n, root: root, label: { _ in label }, defaultBranch: defaultBranch, roots: roots, model: model)
    }

    /// The `Item` operation's answer: the issue or PR as it is now, labelled `label`.
    static func item(_ response: [String: Any], root: PipelineSettings.Root, label: String,
                     model: CoreAssets.PipelineModel) -> PipelineEntry? {
        let repo = (response["data"] as? [String: Any])?["repository"] as? [String: Any]
        guard let n = repo?["issueOrPullRequest"] as? [String: Any] else { return nil }
        guard n["headRefOid"] != nil else { return issue(n, root: root, label: { _ in label }) }
        let defaultBranch = (repo?["defaultBranchRef"] as? [String: Any])?["name"] as? String ?? ""
        return pr(n, root: root, label: { _ in label }, defaultBranch: defaultBranch, model: model)
    }

    /// One node of the `PR` fragment, and of `Gate` when it was read with it.
    static func pr(_ n: [String: Any], root: PipelineSettings.Root, label: (Int) -> String,
                   defaultBranch: String, roots: [PipelineSettings.Root] = [],
                   model: CoreAssets.PipelineModel) -> PipelineEntry? {
        guard let number = n["number"] as? Int, let url = n["url"] as? String,
              let head = n["headRefOid"] as? String else { return nil }
        let me = root.me.lowercased()
        func person(_ node: [String: Any]) -> String? {
            guard let a = node["author"] as? [String: Any] else { return "" }
            return a["__typename"] as? String == "Bot" ? nil : a["login"] as? String ?? ""
        }
        let author = login(n)
        let draft = bool(n["isDraft"], false)
        let fork = bool(n["isCrossRepository"], true)
        let base = n["baseRefName"] as? String ?? ""
        let state: String
        switch n["state"] as? String {
        case "MERGED"?: state = "merged"
        case "CLOSED"?: state = "closed"
        default: state = draft ? "draft" : "open"
        }
        let labels = nodes(n, "labels").compactMap { $0["name"] as? String }
        let assignees = nodes(n, "assignees").compactMap { $0["login"] as? String }
        let unwritable: String? = state == "merged" || state == "closed" ? state
            : author.lowercased() != me || me.isEmpty
            ? "authored by @\(author.isEmpty ? "ghost" : author), not me"
            : fork ? "comes from a fork"
            : base != defaultBranch || base.isEmpty ? "targets \(base), not the default branch"
            : labelsCut(n, labels)
            ?? (assignees.allSatisfy { $0.lowercased() == me } ? nil
                : "assigned to \(assignees.map { "@" + $0 }.joined(separator: ", "))")
        var e = PipelineEntry(
            item: PipelineItem(id: url, source: .github, kind: .pr, label: label(number),
                               title: n["title"] as? String ?? "", repo: root.slug,
                               state: state, author: author, assignees: assignees,
                               writable: unwritable == nil, stage: .unrated, lane: .unrated,
                               headSha: head, updatedAt: date(n["updatedAt"])),
            labels: labels, body: n["body"] as? String ?? "", root: root, number: number)
        let closing = nodes(n, "closingIssuesReferences")
        e.links = closing.compactMap { $0["url"] as? String }
        e.closes = closing.compactMap { $0["state"] as? String == "OPEN" ? $0["url"] as? String : nil }
        if total(n, "closingIssuesReferences") > closing.count { e.closes.append("") }
        e.closesLinear = linearCloses(e.item.title + "\n" + e.body)
        if let labeled = n["labeled"] as? [String: Any] {
            let events = labeled["nodes"] as? [[String: Any]] ?? []
            let names = events.compactMap { (($0["label"] as? [String: Any])?["name"] as? String)?.lowercased() }
            let count = labeled["filteredCount"] as? Int ?? Int.max
            e.labeled = names.count < events.count || count > events.count ? nil : Set(names)
        }
        e.headRef = n["headRefName"] as? String ?? ""
        e.baseRef = base
        e.defaultBranch = defaultBranch
        e.isDraft = draft
        e.isCrossRepository = fork
        e.mergeable = n["mergeable"] as? String ?? ""
        e.mergeState = n["mergeStateStatus"] as? String ?? ""
        // Unread, as if it had one.
        e.mergeQueue = bool(n["isMergeQueueEnabled"], true)
        e.reviewDecision = n["reviewDecision"] as? String ?? ""
        // A count it cannot read is one past every limit.
        e.changedFiles = n["changedFiles"] as? Int ?? Int.max
        e.files = nodes(n, "files").compactMap { f in
            guard let path = f["path"] as? String else { return nil }
            return PipelineGate.ChangedFile(path: path, additions: f["additions"] as? Int ?? 0,
                                            deletions: f["deletions"] as? Int ?? 0,
                                            changeType: f["changeType"] as? String ?? "")
        }
        let tip = nodes(n, "tip").first?["commit"] as? [String: Any]
        e.ciCommit = tip?["oid"] as? String ?? ""
        e.ciState = (tip?["statusCheckRollup"] as? [String: Any])?["state"] as? String ?? ""
        let threads = nodes(n, "reviewThreads")
        e.unresolvedThreads = threads.filter { !bool($0["isResolved"], false) }.count
            + max(0, total(n, "reviewThreads") - threads.count)
        e.reviewRequests = total(n, "reviewRequests")
        let reviews = nodes(n, "reviews"), comments = nodes(n, "comments")
        e.participants = (reviews + comments).map(person)
        e.participantsUnseen = total(n, "reviews") > reviews.count
            || total(n, "comments") > comments.count
        func untagged(_ r: [String: Any]) -> Bool {
            let body = (r["body"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            return !me.isEmpty && login(r).lowercased() == me && !body.isEmpty && !body.hasPrefix(ReviewAudit.tag)
        }
        // A review with no body says what it says in its threads, which `Gate` reads.
        e.operatorUntagged = (reviews + comments).contains(where: untagged)
        e.markers = reviews.compactMap { r -> String? in
            // A pending review is seen by its author alone.
            guard login(r).lowercased() == me, !me.isEmpty, r["state"] as? String != "PENDING",
                  let oid = (r["commit"] as? [String: Any])?["oid"] as? String,
                  names(r["body"] as? String ?? "", marker: model.cleanMarker, oid: oid)
            else { return nil }
            return oid
        }
        if n["gateTip"] != nil {
            e.gate = gate(n, me: me)
            let messages = nodes(n, "commits").map { ($0["commit"] as? [String: Any])?["message"] as? String ?? "" }
            e.closesLinear = linearCloses(([e.item.title, e.body] + messages).joined(separator: "\n"))
            e.closesText = githubCloses(([e.item.title] + messages).joined(separator: "\n"), repo: root.name)
            let fresh = nodes(n, "closing")
            e.closing = fresh.compactMap { c in
                issue(c, root: (c["url"] as? String).flatMap { PipelineRead.root(of: $0, in: roots) }, label: { "#\($0)" })
            }
            e.closingPast = total(n, "closing") > fresh.count
            // Marked ready, or opened ready and turned into a draft; unread, as if it was.
            e.readied = ((n["readied"] as? [String: Any])?["filteredCount"] as? Int ?? 1) > 0
            e.mergedBy = (n["mergedBy"] as? [String: Any])?["login"] as? String
            for t in nodes(n, "threads") {
                let comments = nodes(t, "comments")
                if total(t, "comments") > comments.count { e.participantsUnseen = true }
                if comments.contains(where: untagged) { e.operatorUntagged = true }
            }
        }
        e.unwritable = unwritable
        return e
    }

    /// The root whose repository `url`, an issue or PR page, is in.
    static func root(of url: String, in roots: [PipelineSettings.Root]) -> PipelineSettings.Root? {
        roots.first { sameRepo(url, "https://github.com/\($0.name)/issues/0") }
    }

    /// `Gate`'s fields of a PR node, for the operator `me` (lowercased).
    static func gate(_ n: [String: Any], me: String) -> PipelineEntry.Gate {
        var g = PipelineEntry.Gate()
        func note(_ who: String) {
            if who.lowercased() != me, !g.foreignCommits.contains(who) { g.foreignCommits.append(who) }
        }
        let commits = nodes(n, "commits")
        for c in commits {
            let commit = c["commit"] as? [String: Any]
            func user(_ key: String) -> String {
                ((commit?[key] as? [String: Any])?["user"] as? [String: Any])?["login"] as? String ?? ""
            }
            let committer = commit?["committer"] as? [String: Any]
            // GitHub's own committer, of a commit made or merged on the web, signs for
            // the author.
            let gitHub = !(committer?["user"] is [String: Any])
                && (committer?["email"] as? String)?.lowercased() == "noreply@github.com"
            note(user("author"))
            if !gitHub { note(user("committer")) }
            if !bool((commit?["signature"] as? [String: Any])?["isValid"], false) { g.unsignedCommits = true }
        }
        if total(n, "commits") > commits.count {
            note("")
            g.unsignedCommits = true
        }
        let rollup = (nodes(n, "gateTip").first?["commit"] as? [String: Any])?["statusCheckRollup"] as? [String: Any]
        for c in nodes(rollup, "contexts") {
            if bool(c["isRequired"], false), (c["conclusion"] ?? c["state"]) as? String == "SUCCESS",
               let name = (c["name"] ?? c["context"]) as? String { g.passedChecks.insert(name) }
            // A check run skipped did not run; a commit status always did.
            if let conclusion = c["conclusion"] as? String, ["SKIPPED", "NEUTRAL"].contains(conclusion) { continue }
            guard c["conclusion"] != nil || c["state"] != nil else { continue }
            g.ciRan = true
        }
        g.requiredChecks = requiredChecks(n["baseRef"] as? [String: Any])
        g.baseRules = baseRules(n["baseRef"] as? [String: Any])
        for r in nodes(n["baseRef"] as? [String: Any], "rules") where r["type"] as? String == "PULL_REQUEST" {
            let allowed = (r["parameters"] as? [String: Any])?["allowedMergeMethods"] as? [String] ?? []
            g.mergeFlags = g.mergeFlags.filter { flag in mergeFlags.contains { $0.flag == flag && allowed.contains($0.method) } }
        }
        return g
    }

    /// The branch protection settings `PipelineGate.hold` weighs besides required checks.
    static let protections = ["lockBranch", "restrictsPushes", "requiresDeployments", "requiresCommitSignatures",
                              "requiresLinearHistory"]

    /// The rules on `base`, a PR's base branch read with `Gate`: each type of rule its active
    /// rulesets hold, and each of `protections` its branch protection rule turns on. Nil when
    /// the branch, its protection rule (which only an admin reads in full) or a ruleset past
    /// the read's page leaves them unknown.
    static func baseRules(_ base: [String: Any]?) -> [String]? {
        guard let base, let rules = base["rules"] as? [String: Any], let ruleNodes = rules["nodes"] as? [[String: Any]],
              total(base, "rules") <= ruleNodes.count else { return nil }
        var out: [String] = []
        for r in ruleNodes {
            guard let type = r["type"] as? String else { return nil }
            if type == "PULL_REQUEST", !((r["parameters"] as? [String: Any])?["allowedMergeMethods"] is [String]) {
                return nil
            }
            if !out.contains(type) { out.append(type) }
        }
        if let rule = base["branchProtectionRule"] as? [String: Any] {
            for field in protections {
                guard let on = rule[field] as? Bool else { return nil }
                if on { out.append(field) }
            }
        } else if base["refUpdateRule"] is [String: Any] {
            return nil
        }
        return out
    }

    /// The status checks `base`, a PR's base branch read with `Gate`, requires: its branch
    /// protection rule's, which an admin reads as `branchProtectionRule` and anyone else as
    /// `refUpdateRule`, and its active rulesets'. Nil when the branch or a ruleset past the
    /// read's page leaves them unknown.
    static func requiredChecks(_ base: [String: Any]?) -> [String]? {
        guard let base, let rules = base["rules"] as? [String: Any], let ruleNodes = rules["nodes"] as? [[String: Any]],
              total(base, "rules") <= ruleNodes.count else { return nil }
        var names: [String] = []
        func add(_ list: Any?) {
            for name in list as? [String] ?? [] where !names.contains(name) { names.append(name) }
        }
        if let rule = base["branchProtectionRule"] as? [String: Any], bool(rule["requiresStatusChecks"], true) {
            guard rule["requiredStatusCheckContexts"] is [String] else { return nil }
            add(rule["requiredStatusCheckContexts"])
        }
        add((base["refUpdateRule"] as? [String: Any])?["requiredStatusCheckContexts"])
        for r in ruleNodes where r["type"] as? String == "REQUIRED_STATUS_CHECKS" {
            guard let checks = (r["parameters"] as? [String: Any])?["requiredStatusChecks"] as? [[String: Any]]
            else { return nil }
            add(checks.compactMap { $0["context"] as? String })
        }
        return names
    }

    /// A Linear issue's page URL without the title's slug, which a retitle changes:
    /// `https://linear.app/<workspace>/issue/<IDENTIFIER>`.
    static func linearURL(_ url: String) -> String {
        guard let issue = url.range(of: "/issue/") else { return url }
        let rest = url[issue.upperBound...]
        return String(url[..<issue.upperBound]) + rest.prefix { $0 != "/" && $0 != "?" && $0 != "#" }
    }

    /// One page of the `Issues` operation (`assets/graphql/linear.graphql`): its issues, and
    /// the next page's cursor when there is one.
    static func linear(_ data: [String: Any], viewer: String, teams: [PipelineSettings.LinearTeam],
                       roots: [PipelineSettings.Root]) -> (entries: [PipelineEntry], next: String?) {
        let issues = data["issues"] as? [String: Any]
        let page = issues?["pageInfo"] as? [String: Any]
        let next = bool(page?["hasNextPage"], false) ? page?["endCursor"] as? String : nil
        let entries = (issues?["nodes"] as? [[String: Any]] ?? []).compactMap {
            linearIssue($0, viewer: viewer, teams: teams, roots: roots)
        }
        return (entries, next)
    }

    /// One Linear `Issue` node: open, unless its state says completed or canceled.
    static func linearIssue(_ n: [String: Any], viewer: String, teams: [PipelineSettings.LinearTeam],
                            roots: [PipelineSettings.Root]) -> PipelineEntry? {
        guard let id = n["id"] as? String, let url = n["url"] as? String,
              let identifier = n["identifier"] as? String else { return nil }
        let team = n["team"] as? [String: Any]
        let key = team?["key"] as? String ?? ""
        let assignee = n["assignee"] as? [String: Any]
        let labels = nodes(n, "labels")
        let names = labels.compactMap { $0["name"] as? String }
        let state = n["state"] as? [String: Any]
        let type = state?["type"] as? String ?? ""
        let done = ["completed", "canceled"].contains(type)
        let unwritable = done ? "closed" : n["archivedAt"] is String ? "archived" : labelsCut(n, names)
            ?? (assignee == nil || (assignee?["id"] as? String) == viewer ? nil
                : "assigned to \(assignee?["name"] as? String ?? "someone else")")
        let repo = teams.first { $0.key.lowercased() == key.lowercased() }?.repo
        var e = PipelineEntry(
            item: PipelineItem(id: linearURL(url), source: .linear, kind: .issue, label: identifier,
                               title: n["title"] as? String ?? "", repo: key, state: done ? "closed" : "open",
                               author: (n["creator"] as? [String: Any])?["name"] as? String,
                               assignees: (assignee?["name"] as? String).map { [$0] } ?? [],
                               writable: unwritable == nil, stage: .unrated, lane: .unrated,
                               updatedAt: date(n["updatedAt"])),
            labels: names, body: n["description"] as? String ?? "",
            root: roots.first { $0.slug.lowercased() == repo?.lowercased() }, nodeID: id)
        e.parent = ((n["parent"] as? [String: Any])?["url"] as? String).map(linearURL)
        e.children = nodes(n, "children").compactMap { ($0["url"] as? String).map(linearURL) }
        e.links = nodes(n, "attachments").compactMap { $0["url"] as? String }
        e.linksPast = bool(((n["attachments"] as? [String: Any])?["pageInfo"] as? [String: Any])?["hasNextPage"], false)
        e.teamID = team?["id"] as? String
        if !viewer.isEmpty, (n["creator"] as? [String: Any])?["id"] as? String == viewer {
            e.isPart = isPart(e.body, parent: e.parent)
            e.lineage = lineage(e.body)
        }
        if ["triage", "duplicate"].contains(type) { e.triageState = state?["name"] as? String ?? type }
        for l in labels {
            if let name = l["name"] as? String, let id = l["id"] as? String { e.labelIDs[name] = id }
        }
        e.unwritable = unwritable
        return e
    }

    /// One reference in a list after a closing word: a Markdown link, a URL, a GitHub
    /// reference, or an identifier-shaped token (`ENG-12`, any team, any case).
    private static let reference = #"\[[^\]\n]*\]\([^)\s]*\)|https?://[^\s<>()\[\]]+|[\w.-]+/[\w.-]+#\d+|#\d+|`?[A-Za-z][A-Za-z0-9]*-\d+`?(?![\w-])"#

    /// Linear's closing magic words, each followed by a list of references.
    private static let closing: NSRegularExpression = {
        let words = "close[sd]?|closing|fix(?:e[sd]|ing)?|resolve[sd]?|resolving|complete[sd]?|completing"
            + "|implement(?:s|ed|ing)?|linear issue"
        let gap = #"(?:[ \t]*,[ \t]*(?:and[ \t]+)?|[ \t]+and[ \t]+|[ \t]*&[ \t]*|[ \t]+)"#
        return try! NSRegularExpression(
            pattern: #"(?<![\w-])(?:"# + words + #")(?![\w-])\s*:?\s*((?:"# + reference + ")(?:" + gap
                + "(?:" + reference + "))*)",
            options: [.caseInsensitive])
    }()

    private static let references = try! NSRegularExpression(pattern: reference, options: [])
    private static let identifier = try! NSRegularExpression(pattern: #"^`?([A-Za-z][A-Za-z0-9]*-\d+)`?$"#)
    private static let linearLink = try! NSRegularExpression(pattern: #"^https?://linear\.app/[^/\s]+/issue/([A-Za-z0-9]+-\d+)"#,
                                                              options: [.caseInsensitive])
    private static let githubIssue = try! NSRegularExpression(
        pattern: #"^(?:([\w.-]+/[\w.-]+)?#|`?gh-)(\d+)`?$|^https?://github\.com/([\w.-]+/[\w.-]+)/(?:issues|pull)/(\d+)(?!\d)"#,
        options: [.caseInsensitive])

    /// Each reference `text` names in a list after a closing word; a Markdown link's text
    /// and its target both.
    private static func closingReferences(_ text: String) -> [String] {
        var out: [String] = []
        let ns = text as NSString
        for list in closing.matches(in: text, range: NSRange(location: 0, length: ns.length)) {
            let refs = ns.substring(with: list.range(at: 1))
            let rs = refs as NSString
            for r in references.matches(in: refs, range: NSRange(location: 0, length: rs.length)) {
                let ref = rs.substring(with: r.range)
                if ref.hasPrefix("["), let close = ref.range(of: "](") {
                    out += [String(ref.dropFirst()[..<close.lowerBound]), String(ref[close.upperBound...].dropLast())]
                } else {
                    out.append(ref)
                }
            }
        }
        return out
    }

    /// The GitHub issues `text` closes, each as `https://github.com/<owner>/<repo>/issues/<n>`
    /// lowercased: `#n` and `GH-n` of `repo`, `owner/repo#n` or a link, in a list after a
    /// closing word. GitHub's closing keywords are among Linear's magic words.
    static func githubCloses(_ text: String, repo: String) -> [String] {
        var out: [String] = []
        for t in closingReferences(text) {
            let ns = t as NSString
            guard let m = githubIssue.firstMatch(in: t, range: NSRange(location: 0, length: ns.length)) else { continue }
            func group(_ k: Int) -> String? { m.range(at: k).location == NSNotFound ? nil : ns.substring(with: m.range(at: k)) }
            let url = group(4).map { "https://github.com/\(group(3) ?? repo)/issues/\($0)" }
                ?? "https://github.com/\(group(1) ?? repo)/issues/\(group(2) ?? "")"
            if !out.contains(norm(url)) { out.append(norm(url)) }
        }
        return out
    }

    /// The Linear identifiers `text` closes, uppercased: each one in a list after one of
    /// Linear's closing magic words (`Fixes ENG-1, OPS-2, and #3`), named by itself, by its
    /// link, or as a Markdown link's text or target. A bare mention closes nothing.
    static func linearCloses(_ text: String) -> [String] {
        func first(_ re: NSRegularExpression, _ s: String) -> String? {
            let ns = s as NSString
            guard let m = re.firstMatch(in: s, range: NSRange(location: 0, length: ns.length)) else { return nil }
            return ns.substring(with: m.range(at: 1)).uppercased()
        }
        var out: [String] = []
        for t in closingReferences(text) {
            if let id = first(identifier, t) ?? first(linearLink, t), !out.contains(id) { out.append(id) }
        }
        return out
    }

    static func norm(_ url: String) -> String {
        var u = url
        while u.hasSuffix("/") { u.removeLast() }
        return u.lowercased()
    }

    /// Whether merging `pr` would close the Linear issue `issue`: it names the issue after a
    /// closing word (`closesLinear`), or one of the issue's attachments links it.
    static func closes(_ pr: PipelineEntry, linear issue: PipelineEntry) -> Bool {
        pr.closesLinear.contains(issue.item.label.uppercased()) || issue.links.contains { norm($0) == norm(pr.id) }
    }

    /// Every edge between `entries`: parent -> child, issue -> the PR fixing it (a GitHub
    /// closing reference; for Linear, `closes`), PR -> the PR stacked on it in the same
    /// repository.
    static func edges(_ entries: [PipelineEntry]) -> [PipelineGraph.Edge] {
        var byURL: [String: String] = [:]
        for e in entries { byURL[norm(e.id)] = e.id }
        var out: [PipelineGraph.Edge] = []
        var seen = Set<String>()
        func add(_ from: String, _ to: String, _ kind: PipelineGraph.EdgeKind) {
            guard from != to, seen.insert("\(from)\u{0}\(to)").inserted else { return }
            out.append(PipelineGraph.Edge(from: from, to: to, kind: kind))
        }
        let prs = entries.filter { $0.item.kind == .pr }
        for e in entries {
            if let p = e.parent.flatMap({ byURL[norm($0)] }) { add(p, e.id, .child) }
            for c in e.children { if let c = byURL[norm(c)] { add(e.id, c, .child) } }
            switch (e.item.kind, e.item.source) {
            case (.pr, _):
                for issue in e.links { if let i = byURL[norm(issue)] { add(i, e.id, .fixes) } }
                // A fork's branch, or the default one, is no PR's to stack on.
                for other in prs where other.item.repo == e.item.repo && !e.isCrossRepository
                    && !e.headRef.isEmpty && e.headRef != e.defaultBranch && other.baseRef == e.headRef {
                    add(e.id, other.id, .stacked)
                }
            case (.issue, .linear):
                for pr in prs where closes(pr, linear: e) { add(e.id, pr.id, .fixes) }
            case (.issue, .github):
                break
            }
        }
        return out
    }
}

/// Linear's GraphQL API, reached with the operator's API key, read on each sync and never
/// cached. The transport is `SlackAPI.curl`'s: the key travels in a config on curl's
/// stdin, which `CommsClassifier.execute` stages in an owner-only file of its own 0700
/// directory, removed when curl exits.
public struct LinearAPI {
    /// Overrides the Keychain item and the file. `CommsClassifier.childEnvironment`, and so
    /// every child Diplomat starts, goes without it.
    public static let envVar = "DIPLOMAT_LINEAR_TOKEN"

    let key: String
    let url: URL
    let timeout: TimeInterval
    let transport: SlackAPI.Transport

    enum Failure: LocalizedError {
        case transport(String)
        case http(Int, String)
        case api(String)

        var errorDescription: String? {
            switch self {
            case .transport(let why): return "Linear could not be reached: \(why)"
            case .http(let code, let why): return "Linear answered HTTP \(code)" + (why.isEmpty ? "" : ": \(why)")
            case .api(let why): return "Linear: \(why)"
            }
        }
    }

    /// `DIPLOMAT_LINEAR_TOKEN`; else on macOS the Keychain item `keychainItem`, the
    /// operator's own account first since an empty same-named item can shadow it; else
    /// the file `tokenFile`, its `~` read as `PrivateFiles.home`. Nil when none holds a key.
    static func key(keychainItem: String?, tokenFile: String?) -> String? {
        if let env = ProcessInfo.processInfo.environment[envVar], !env.isEmpty { return env }
        func trimmed(_ data: Data) -> String? {
            let s = String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
            return s.isEmpty ? nil : s
        }
#if os(macOS)
        if let item = keychainItem, !item.isEmpty {
            let user = ProcessInfo.processInfo.environment["USER"] ?? ""
            let account = user.isEmpty ? NSUserName() : user
            for extra in [["-a", account], []] {
                let args = ["find-generic-password"] + extra + ["-s", item, "-w"]
                if case .exited(0, let out, _) = CommsClassifier.execute(
                    "/usr/bin/security", args, input: Data(), timeout: 10), let key = trimmed(out) {
                    return key
                }
            }
        }
#endif
        if let file = tokenFile, !file.isEmpty,
           let data = FileManager.default.contents(atPath: PrivateFiles.expandingTilde(file)) {
            return trimmed(data)
        }
        return nil
    }

    /// The `data` of `assets/graphql/linear.graphql`'s operation `operation`, or the
    /// failure: a transport error, an HTTP status other than 200, or an `errors` array.
    func call(_ operation: String, _ variables: [String: Any]) throws -> [String: Any] {
        let query: String
        do { query = try CoreAssets.graphql("linear") } catch { throw Failure.api(error.localizedDescription) }
        let body = try JSONSerialization.data(
            withJSONObject: ["query": query, "operationName": operation, "variables": variables],
            options: [.sortedKeys])
        let answer: (status: Int, headers: [String: String], body: Data)
        do {
            answer = try transport(SlackAPI.Request(
                url: url, headers: ["Authorization": key, "Content-Type": "application/json"],
                body: body, timeout: timeout))
        } catch SlackError.transport(let why) {
            throw Failure.transport(why)
        } catch {
            throw Failure.transport("no HTTP answer (\(error.localizedDescription))")
        }
        let root = (try? JSONSerialization.jsonObject(with: answer.body)) as? [String: Any]
        let errors = (root?["errors"] as? [[String: Any]] ?? []).compactMap { $0["message"] as? String }
        guard answer.status == 200 else { throw Failure.http(answer.status, errors.joined(separator: "; ")) }
        if !errors.isEmpty { throw Failure.api(errors.joined(separator: "; ")) }
        guard let data = root?["data"] as? [String: Any] else { throw Failure.api("no data in the answer") }
        return data
    }
}
