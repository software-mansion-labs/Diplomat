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
        /// A check on the head started after it last went from draft to ready, or it never
        /// was a draft.
        var ciSinceReady = false
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
    /// A PR's open closing references, each with who it is assigned to: nil when more
    /// than the read lists, and an empty URL for references past the read's page.
    var closes: [(url: String, assignees: [String]?)] = []
    var headRef = ""
    var baseRef = ""
    var defaultBranch = ""
    var isDraft = false
    var isCrossRepository = false
    var mergeable = ""
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
    /// `--squash`, `--merge` or `--rebase`, the first the repository allows.
    var mergeFlag: String?
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
            mergeFlag: [("squashMergeAllowed", "--squash"), ("mergeCommitAllowed", "--merge"),
                        ("rebaseMergeAllowed", "--rebase")].first { bool(repo?[$0.0], false) }?.1)
        func after(_ key: String) -> String? {
            let page = (repo?[key] as? [String: Any])?["pageInfo"] as? [String: Any]
            return bool(page?["hasNextPage"], false) ? page?["endCursor"] as? String : nil
        }
        let me = root.me.lowercased()
        func label(_ n: Int) -> String { primary ? "#\(n)" : "\(root.slug)#\(n)" }
        var out: [PipelineEntry] = []

        for n in nodes(repo, "issues") {
            guard let number = n["number"] as? Int, let url = n["url"] as? String else { continue }
            let assignees = nodes(n, "assignees").compactMap { $0["login"] as? String }
            let labels = nodes(n, "labels").compactMap { $0["name"] as? String }
            let unwritable = labelsCut(n, labels)
                ?? (assignees.allSatisfy { $0.lowercased() == me } && !me.isEmpty ? nil
                    : "assigned to \(assignees.map { "@" + $0 }.joined(separator: ", "))")
            var e = PipelineEntry(
                item: PipelineItem(id: url, source: .github, kind: .issue, label: label(number),
                                   title: n["title"] as? String ?? "", repo: root.slug, state: "open",
                                   author: login(n), assignees: assignees, writable: unwritable == nil,
                                   stage: .unrated, lane: .unrated, updatedAt: date(n["updatedAt"])),
                labels: labels, body: n["body"] as? String ?? "", root: root, number: number,
                nodeID: n["id"] as? String)
            e.parent = (n["parent"] as? [String: Any])?["url"] as? String
            e.children = nodes(n, "subIssues").compactMap { $0["url"] as? String }
            e.unwritable = unwritable
            out.append(e)
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

    /// The `PullRequest` operation's answer: the PR, read with `Gate`, labelled `label`.
    static func pullRequest(_ response: [String: Any], root: PipelineSettings.Root, label: String,
                            model: CoreAssets.PipelineModel) -> PipelineEntry? {
        let repo = (response["data"] as? [String: Any])?["repository"] as? [String: Any]
        guard let n = repo?["pullRequest"] as? [String: Any] else { return nil }
        let defaultBranch = (repo?["defaultBranchRef"] as? [String: Any])?["name"] as? String ?? ""
        return pr(n, root: root, label: { _ in label }, defaultBranch: defaultBranch, model: model)
    }

    /// One node of the `PR` fragment, and of `Gate` when it was read with it.
    static func pr(_ n: [String: Any], root: PipelineSettings.Root, label: (Int) -> String,
                   defaultBranch: String, model: CoreAssets.PipelineModel) -> PipelineEntry? {
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
        let unwritable: String? = state == "merged" || state == "closed" ? state
            : author.lowercased() != me || me.isEmpty
            ? "authored by @\(author.isEmpty ? "ghost" : author), not me"
            : fork ? "comes from a fork"
            : base != defaultBranch || base.isEmpty ? "targets \(base), not the default branch"
            : labelsCut(n, labels)
        var e = PipelineEntry(
            item: PipelineItem(id: url, source: .github, kind: .pr, label: label(number),
                               title: n["title"] as? String ?? "", repo: root.slug,
                               state: state, author: author,
                               writable: unwritable == nil, stage: .unrated, lane: .unrated,
                               headSha: head, updatedAt: date(n["updatedAt"])),
            labels: labels, body: n["body"] as? String ?? "", root: root, number: number)
        let closing = nodes(n, "closingIssuesReferences")
        e.links = closing.compactMap { $0["url"] as? String }
        e.closes = closing.compactMap { c in
            guard c["state"] as? String == "OPEN", let url = c["url"] as? String else { return nil }
            let who = nodes(c, "assignees").compactMap { $0["login"] as? String }
            return (url, total(c, "assignees") > who.count ? nil : who)
        }
        if total(n, "closingIssuesReferences") > closing.count { e.closes.append(("", nil)) }
        e.headRef = n["headRefName"] as? String ?? ""
        e.baseRef = base
        e.defaultBranch = defaultBranch
        e.isDraft = draft
        e.isCrossRepository = fork
        e.mergeable = n["mergeable"] as? String ?? ""
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
        // A review with no body says what it says in its threads.
        e.operatorUntagged = !me.isEmpty && (reviews + comments).contains { r in
            let body = (r["body"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            return login(r).lowercased() == me && !body.isEmpty && !body.hasPrefix(ReviewAudit.tag)
        }
        e.markers = reviews.compactMap { r -> String? in
            guard login(r).lowercased() == me, !me.isEmpty,
                  let oid = (r["commit"] as? [String: Any])?["oid"] as? String,
                  names(r["body"] as? String ?? "", marker: model.cleanMarker, oid: oid)
            else { return nil }
            return oid
        }
        if n["gateTip"] != nil { e.gate = gate(n, me: me) }
        e.unwritable = unwritable
        return e
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
        }
        if total(n, "commits") > commits.count { note("") }
        let rollup = (nodes(n, "gateTip").first?["commit"] as? [String: Any])?["statusCheckRollup"] as? [String: Any]
        let readied = date(nodes(n, "readied").first?["createdAt"])
        g.ciSinceReady = readied == nil
        for c in nodes(rollup, "contexts") {
            // A check run skipped did not run; a commit status always did.
            if let conclusion = c["conclusion"] as? String, ["SKIPPED", "NEUTRAL"].contains(conclusion) { continue }
            guard c["conclusion"] != nil || c["state"] != nil else { continue }
            g.ciRan = true
            if let readied, let at = date(c["startedAt"] ?? c["createdAt"]), at > readied { g.ciSinceReady = true }
        }
        return g
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
        let entries = (issues?["nodes"] as? [[String: Any]] ?? []).compactMap { n -> PipelineEntry? in
            guard let id = n["id"] as? String, let url = n["url"] as? String,
                  let identifier = n["identifier"] as? String else { return nil }
            let team = n["team"] as? [String: Any]
            let key = team?["key"] as? String ?? ""
            let assignee = n["assignee"] as? [String: Any]
            let labels = nodes(n, "labels")
            let names = labels.compactMap { $0["name"] as? String }
            let unwritable = labelsCut(n, names)
                ?? (assignee == nil || (assignee?["id"] as? String) == viewer ? nil
                    : "assigned to \(assignee?["name"] as? String ?? "someone else")")
            let repo = teams.first { $0.key.lowercased() == key.lowercased() }?.repo
            var e = PipelineEntry(
                item: PipelineItem(id: linearURL(url), source: .linear, kind: .issue, label: identifier,
                                   title: n["title"] as? String ?? "", repo: key, state: "open",
                                   author: (n["creator"] as? [String: Any])?["name"] as? String,
                                   assignees: (assignee?["name"] as? String).map { [$0] } ?? [],
                                   writable: unwritable == nil, stage: .unrated, lane: .unrated,
                                   updatedAt: date(n["updatedAt"])),
                labels: names, body: n["description"] as? String ?? "",
                root: roots.first { $0.slug.lowercased() == repo?.lowercased() }, nodeID: id)
            e.parent = ((n["parent"] as? [String: Any])?["url"] as? String).map(linearURL)
            e.children = nodes(n, "children").compactMap { ($0["url"] as? String).map(linearURL) }
            e.links = nodes(n, "attachments").compactMap { $0["url"] as? String }
            e.teamID = team?["id"] as? String
            for l in labels {
                if let name = l["name"] as? String, let id = l["id"] as? String { e.labelIDs[name] = id }
            }
            e.unwritable = unwritable
            return e
        }
        return (entries, next)
    }

    /// Whether `text` names `identifier` as a word of its own: `ENG-12` in "fixes ENG-12."
    /// but not in "ENG-123" or "XENG-12".
    static func mentions(_ text: String, _ identifier: String) -> Bool {
        let id = identifier.lowercased()
        let hay = text.lowercased()
        var from = hay.startIndex
        while let hit = hay.range(of: id, range: from..<hay.endIndex) {
            let before = hit.lowerBound == hay.startIndex ? nil : hay[hay.index(before: hit.lowerBound)]
            let after = hit.upperBound == hay.endIndex ? nil : hay[hit.upperBound]
            func word(_ c: Character?) -> Bool { c.map { $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" } ?? false }
            if !word(before) && !word(after) { return true }
            from = hit.upperBound
        }
        return false
    }

    static func norm(_ url: String) -> String {
        var u = url
        while u.hasSuffix("/") { u.removeLast() }
        return u.lowercased()
    }

    /// Whether `pr` fixes the Linear issue `issue`: the issue's attachments link it, or its
    /// title or body names the issue's identifier.
    static func fixes(_ pr: PipelineEntry, linear issue: PipelineEntry) -> Bool {
        issue.links.contains { norm($0) == norm(pr.id) } || mentions(pr.item.title + "\n" + pr.body, issue.item.label)
    }

    /// Every edge between `entries`: parent -> child, issue -> the PR fixing it (a GitHub
    /// closing reference; for Linear, `fixes`), PR -> the PR stacked on it in the same
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
                for pr in prs where fixes(pr, linear: e) { add(e.id, pr.id, .fixes) }
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
