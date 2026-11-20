import Foundation

/// One item as a sync read it: the `PipelineItem` the view gets, and what the sync decides
/// on besides.
struct PipelineEntry {
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
    var participants: [String?] = []
    var participantsUnseen = false
    /// The heads the operator's clean-marker reviews name, oldest first.
    var markers: [String] = []
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

    /// Whether `body` names, right after `marker`, `oid` or a prefix of it at least seven
    /// characters long: a marker counts only on the commit it was submitted at.
    static func names(_ body: String, marker: String, oid: String) -> Bool {
        guard !oid.isEmpty else { return false }
        var rest = Substring(body)
        while let hit = rest.range(of: marker + " ") {
            let sha = rest[hit.upperBound...].prefix { $0.isHexDigit }
            if sha.count >= 7, oid.lowercased().hasPrefix(sha.lowercased()) { return true }
            rest = rest[hit.upperBound...]
        }
        return false
    }

    /// A `pipeline-repo.graphql` response for `root`. `primary` is the first root, whose
    /// items are labelled `#N`; others' are `owner/repo#N`.
    static func github(_ response: [String: Any], root: PipelineSettings.Root, primary: Bool,
                       model: CoreAssets.PipelineModel) -> (PipelineRepo, [PipelineEntry]) {
        let repo = (response["data"] as? [String: Any])?["repository"] as? [String: Any]
        let defaultBranch = (repo?["defaultBranchRef"] as? [String: Any])?["name"] as? String ?? ""
        let mergeFlag = [("squashMergeAllowed", "--squash"), ("mergeCommitAllowed", "--merge"),
                         ("rebaseMergeAllowed", "--rebase")]
            .first { bool(repo?[$0.0], false) }?.1
        let me = root.me.lowercased()
        func label(_ n: Int) -> String { primary ? "#\(n)" : "\(root.slug)#\(n)" }
        func login(_ node: [String: Any]?) -> String {
            (node?["author"] as? [String: Any])?["login"] as? String ?? ""
        }
        func person(_ node: [String: Any]) -> String? {
            guard let a = node["author"] as? [String: Any] else { return "" }
            return a["__typename"] as? String == "Bot" ? nil : a["login"] as? String ?? ""
        }
        var out: [PipelineEntry] = []

        for n in nodes(repo, "issues") {
            guard let number = n["number"] as? Int, let url = n["url"] as? String else { continue }
            let assignees = nodes(n, "assignees").compactMap { $0["login"] as? String }
            let writable = assignees.allSatisfy { $0.lowercased() == me } && !me.isEmpty
            var e = PipelineEntry(
                item: PipelineItem(id: url, source: .github, kind: .issue, label: label(number),
                                   title: n["title"] as? String ?? "", repo: root.slug, state: "open",
                                   author: login(n), assignees: assignees, writable: writable,
                                   stage: .unrated, lane: .unrated, updatedAt: date(n["updatedAt"])),
                labels: nodes(n, "labels").compactMap { $0["name"] as? String },
                body: n["body"] as? String ?? "", root: root, number: number,
                nodeID: n["id"] as? String)
            e.parent = (n["parent"] as? [String: Any])?["url"] as? String
            e.children = nodes(n, "subIssues").compactMap { $0["url"] as? String }
            e.unwritable = writable ? nil : "assigned to \(assignees.map { "@" + $0 }.joined(separator: ", "))"
            out.append(e)
        }

        for n in nodes(repo, "pullRequests") {
            guard let number = n["number"] as? Int, let url = n["url"] as? String,
                  let head = n["headRefOid"] as? String else { continue }
            let author = login(n)
            let draft = bool(n["isDraft"], false)
            let fork = bool(n["isCrossRepository"], true)
            let base = n["baseRefName"] as? String ?? ""
            let unwritable: String? = author.lowercased() != me || me.isEmpty
                ? "authored by @\(author.isEmpty ? "ghost" : author), not me"
                : fork ? "comes from a fork"
                : base != defaultBranch || base.isEmpty ? "targets \(base), not the default branch"
                : nil
            var e = PipelineEntry(
                item: PipelineItem(id: url, source: .github, kind: .pr, label: label(number),
                                   title: n["title"] as? String ?? "", repo: root.slug,
                                   state: draft ? "draft" : "open", author: author,
                                   writable: unwritable == nil, stage: .unrated, lane: .unrated,
                                   headSha: head, updatedAt: date(n["updatedAt"])),
                labels: nodes(n, "labels").compactMap { $0["name"] as? String },
                body: n["body"] as? String ?? "", root: root, number: number)
            e.links = nodes(n, "closingIssuesReferences").compactMap { $0["url"] as? String }
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
            let commit = nodes(n, "commits").first?["commit"] as? [String: Any]
            e.ciCommit = commit?["oid"] as? String ?? ""
            e.ciState = (commit?["statusCheckRollup"] as? [String: Any])?["state"] as? String ?? ""
            let threads = nodes(n, "reviewThreads")
            e.unresolvedThreads = threads.filter { !bool($0["isResolved"], false) }.count
                + max(0, total(n, "reviewThreads") - threads.count)
            let reviews = nodes(n, "reviews"), comments = nodes(n, "comments")
            e.participants = (reviews + comments).map(person)
            e.participantsUnseen = total(n, "reviews") > reviews.count
                || total(n, "comments") > comments.count
            e.markers = reviews.compactMap { r -> String? in
                guard login(r).lowercased() == me, !me.isEmpty,
                      let oid = (r["commit"] as? [String: Any])?["oid"] as? String,
                      names(r["body"] as? String ?? "", marker: model.cleanMarker, oid: oid)
                else { return nil }
                return oid
            }
            e.unwritable = unwritable
            out.append(e)
        }

        let pipelineLabels = model.all
        for n in nodes(repo, "done") {
            guard let number = n["number"] as? Int, let url = n["url"] as? String else { continue }
            let labels = nodes(n, "labels").compactMap { $0["name"] as? String }
            guard labels.contains(where: pipelineLabels.contains) else { continue }
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
            e.defaultBranch = defaultBranch
            e.isCrossRepository = bool(n["isCrossRepository"], true)
            e.unwritable = merged ? "merged" : "closed"
            out.append(e)
        }
        return (PipelineRepo(defaultBranch: defaultBranch, mergeFlag: mergeFlag), out)
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
            let writable = assignee == nil || (assignee?["id"] as? String) == viewer
            let repo = teams.first { $0.key.lowercased() == key.lowercased() }?.repo
            let labels = (n["labels"] as? [String: Any])?["nodes"] as? [[String: Any]] ?? []
            var e = PipelineEntry(
                item: PipelineItem(id: url, source: .linear, kind: .issue, label: identifier,
                                   title: n["title"] as? String ?? "", repo: key, state: "open",
                                   author: (n["creator"] as? [String: Any])?["name"] as? String,
                                   assignees: (assignee?["name"] as? String).map { [$0] } ?? [],
                                   writable: writable, stage: .unrated, lane: .unrated,
                                   updatedAt: date(n["updatedAt"])),
                labels: labels.compactMap { $0["name"] as? String },
                body: n["description"] as? String ?? "",
                root: roots.first { $0.slug.lowercased() == repo?.lowercased() }, nodeID: id)
            e.parent = (n["parent"] as? [String: Any])?["url"] as? String
            e.children = ((n["children"] as? [String: Any])?["nodes"] as? [[String: Any]] ?? [])
                .compactMap { $0["url"] as? String }
            e.links = ((n["attachments"] as? [String: Any])?["nodes"] as? [[String: Any]] ?? [])
                .compactMap { $0["url"] as? String }
            e.teamID = team?["id"] as? String
            for l in labels {
                if let name = l["name"] as? String, let id = l["id"] as? String { e.labelIDs[name] = id }
            }
            e.unwritable = writable ? nil : "assigned to \(assignee?["name"] as? String ?? "someone else")"
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

    /// Every edge between `entries`: parent -> child, issue -> the PR fixing it (a GitHub
    /// closing reference; for Linear, a PR the issue's attachments link or whose title or
    /// body names its identifier), PR -> the PR stacked on it in the same repository.
    static func edges(_ entries: [PipelineEntry]) -> [PipelineGraph.Edge] {
        func norm(_ url: String) -> String {
            var u = url
            while u.hasSuffix("/") { u.removeLast() }
            return u.lowercased()
        }
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
                for link in e.links {
                    if let pr = byURL[norm(link)], prs.contains(where: { $0.id == pr }) { add(e.id, pr, .fixes) }
                }
                for pr in prs where mentions(pr.item.title + "\n" + pr.body, e.item.label) {
                    add(e.id, pr.id, .fixes)
                }
            case (.issue, .github):
                break
            }
        }
        return out
    }
}

/// Linear's GraphQL API, reached with the operator's API key: read on each sync, never
/// cached or written, and never handed to a child process or an agent. The transport is
/// `SlackAPI.curl`'s, so the key travels in a config on curl's stdin.
struct LinearAPI {
    /// Overrides the Keychain item and the file. Never reaches a child process.
    static let envVar = "DIPLOMAT_LINEAR_TOKEN"

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
    /// the file `tokenFile`, `~` expanded. Nil when none holds a key.
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
           let data = FileManager.default.contents(atPath: (file as NSString).expandingTildeInPath) {
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
