import Foundation

/// Linear's MCP server (JSON-RPC over Streamable HTTP), answering each operation of
/// `linear.graphql` from its tools in the shape the GraphQL API answers it, so a sync reads
/// one shape under either login. One per sync: it holds the session, the pages `Issues`
/// merges, and the issues it answered.
///
/// Its tools list no issues by attachment, so `Attached` names only issues it answered,
/// and says more may link the URL. A listed issue's full description, attachments and
/// children take two more calls; they are kept in `cache`, read again once its `updatedAt`
/// moves, and read afresh by `Issue`, `Recheck` and `Queued`. An issue names its creator by
/// full name, so each creator's `displayName`, which the ban list is checked against, is
/// one more call a sync.
final class LinearMCP {
    let url: URL
    let timeout: TimeInterval
    let transport: SlackAPI.Transport
    let authorization: () throws -> String
    let cache: URL?

    /// `Issues`' page size, under `list_issues`' cap of 250.
    static let page = 100
    /// Each state type but completed and canceled, as `list_issues` filters by one.
    static let openStates = ["triage", "backlog", "unstarted", "started", "duplicate"]
    static let fields = ["id", "uuid", "title", "description", "url", "updatedAt", "archivedAt", "status",
                         "statusType", "labels", "createdById", "assignee", "assigneeId", "parentId", "teamId"]

    init(url: URL, authorization: @escaping () throws -> String, timeout: TimeInterval,
         transport: @escaping SlackAPI.Transport, cache: URL?) {
        self.url = url
        self.authorization = authorization
        self.timeout = timeout
        self.transport = transport
        self.cache = cache
    }

    func call(_ operation: String, _ variables: [String: Any]) throws -> [String: Any] {
        func text(_ key: String) -> String { variables[key] as? String ?? "" }
        switch operation {
        case "Viewer":
            let me = try viewer()
            return ["viewer": me.viewer, "organization": me.organization]
        case "Issues":
            return try issues(teams: variables["teams"] as? [String] ?? [], first: variables["after"] as? String == nil)
        case "Issue":
            defer { save() }
            return ["issue": try fresh(text("id"))]
        case "Recheck":
            defer { save() }
            return ["issues": ["nodes": try (variables["ids"] as? [String] ?? []).compactMap(found)]]
        case "Queued":
            defer { save() }
            return ["issues": ["nodes": try Self.identifiers(variables["filter"]).compactMap(found)]]
        case "Attached":
            return ["attachmentsForURL": attached(text("url"))]
        case "Labels":
            return ["issueLabels": ["nodes": try labels(text("name"))]]
        case "LabelCreate":
            let made = try tool("save_issue_label", ["name": text("name"), "color": text("color")]) as? [String: Any]
            guard let id = made?["id"] as? String else { throw LinearAPI.Failure.api("save_issue_label answered no label") }
            return ["issueLabelCreate": ["success": true, "issueLabel": ["id": id, "name": text("name")]]]
        case "AddLabel", "RemoveLabel":
            _ = try tool("save_issue", ["id": text("id"),
                                        operation == "AddLabel" ? "addLabels" : "removeLabels": [text("labelId")]])
            return [operation == "AddLabel" ? "issueAddLabel" : "issueRemoveLabel": ["success": true]]
        case "IssueCreate":
            let made = try tool("save_issue", ["team": text("teamId"), "title": text("title"),
                                               "description": text("description"), "parentId": text("parentId")])
                as? [String: Any]
            guard let url = made?["url"] as? String else { throw LinearAPI.Failure.api("save_issue answered no issue") }
            return ["issueCreate": ["success": true, "issue": ["id": made?["uuid"] ?? NSNull(),
                                                               "identifier": made?["id"] ?? NSNull(), "url": url]]]
        default:
            throw LinearAPI.Failure.api("\(operation) has no counterpart among Linear's MCP tools")
        }
    }

    // MARK: - Operations

    private var me: (viewer: [String: Any], organization: [String: Any])?

    private func viewer() throws -> (viewer: [String: Any], organization: [String: Any]) {
        if let me { return me }
        let answer = try tool("whoami", [:]) as? [String: Any]
        let user = answer?["user"] as? [String: Any]
        guard let id = user?["id"] as? String else { throw LinearAPI.Failure.api("whoami answered no user") }
        let found = (["id": id, "name": user?["name"] as? String ?? ""] as [String: Any],
                     ["name": (answer?["workspace"] as? [String: Any])?["name"] as? String ?? ""] as [String: Any])
        me = found
        return found
    }

    /// One `list_issues` filter's issues, newest first, a page at a time.
    private struct Stream {
        let team: String
        let state: String
        var buffer: [[String: Any]] = []
        var cursor: String?
        var done = false
    }

    private var streams: [Stream] = []

    /// The next `page` issues, newest first, across every team and open state: the
    /// streams merged as `updatedAt` orders them.
    private func issues(teams: [String], first: Bool) throws -> [String: Any] {
        if first { streams = teams.flatMap { t in Self.openStates.map { Stream(team: t, state: $0) } } }
        var page: [[String: Any]] = []
        func updated(_ i: Int) -> Date { PipelineRead.date(streams[i].buffer[0]["updatedAt"]) ?? .distantPast }
        while page.count < Self.page {
            for i in streams.indices {
                while streams[i].buffer.isEmpty && !streams[i].done { try fill(i) }
            }
            guard let next = streams.indices.filter({ !streams[$0].buffer.isEmpty })
                .max(by: { updated($0) < updated($1) }) else { break }
            page.append(streams[next].buffer.removeFirst())
        }
        let more = streams.contains { !$0.buffer.isEmpty || !$0.done }
        defer { save() }
        let nodes = try page.map(listed)
        if !more { complete = true }
        return ["viewer": try viewer().viewer,
                "issues": ["pageInfo": ["hasNextPage": more, "endCursor": more ? "more" as Any : NSNull()], "nodes": nodes]]
    }

    private func fill(_ i: Int) throws {
        var args: [String: Any] = ["team": streams[i].team, "state": streams[i].state, "limit": Self.page,
                                   "orderBy": "updatedAt", "fields": Self.fields]
        if let cursor = streams[i].cursor { args["cursor"] = cursor }
        let answer = try tool("list_issues", args) as? [String: Any]
        let state = streams[i].state
        // `state` also matches a state's name.
        streams[i].buffer = (answer?["issues"] as? [[String: Any]] ?? []).filter { $0["statusType"] as? String == state }
        streams[i].cursor = answer?["cursor"] as? String
        streams[i].done = !PipelineRead.bool(answer?["hasNextPage"], false) || streams[i].cursor == nil
    }

    /// `identifier`s an `Issue` filter of `Queued` names: `{or: [{team: {key: {eq}}, number: {in}}]}`.
    static func identifiers(_ filter: Any?) -> [String] {
        ((filter as? [String: Any])?["or"] as? [[String: Any]] ?? []).flatMap { clause -> [String] in
            let key = (((clause["team"] as? [String: Any])?["key"] as? [String: Any])?["eq"] as? String) ?? ""
            let numbers = (clause["number"] as? [String: Any])?["in"] as? [Int] ?? []
            return numbers.map { "\(key)-\($0)" }
        }
    }

    /// The issues answered so far whose attachments link `url`; never the last page, as
    /// another team's may too.
    private func attached(_ url: String) -> [String: Any] {
        let want = PipelineRead.norm(url)
        let nodes = answered.values.filter { n in
            PipelineRead.nodes(n, "attachments").contains { ($0["url"] as? String).map(PipelineRead.norm) == want }
        }.sorted { ($0["identifier"] as? String ?? "") < ($1["identifier"] as? String ?? "") }
        return ["pageInfo": ["hasNextPage": true],
                "nodes": nodes.map { ["issue": ["identifier": $0["identifier"] ?? NSNull(), "state": $0["state"] ?? NSNull()]] }]
    }

    /// The workspace's labels named `name` in any case, then each answered issue's team's own.
    private func labels(_ name: String) throws -> [[String: Any]] {
        func named(_ team: String?) throws -> [[String: Any]] {
            var args: [String: Any] = ["name": name, "limit": 250]
            if let team { args["team"] = team }
            let answer = try tool("list_issue_labels", args) as? [String: Any]
            return (answer?["labels"] as? [[String: Any]] ?? [])
                .filter { ($0["name"] as? String)?.lowercased() == name.lowercased() }
        }
        let workspace = try named(nil)
        let shared = Set(workspace.compactMap { $0["id"] as? String })
        var out: [[String: Any]] = workspace.map { ["id": $0["id"] ?? NSNull(), "name": $0["name"] ?? NSNull(), "team": NSNull()] }
        // A team's labels list the workspace's too.
        for team in Set(answered.values.compactMap { ($0["team"] as? [String: Any])?["id"] as? String }).sorted() {
            for l in try named(team) where !shared.contains(l["id"] as? String ?? "") {
                out.append(["id": l["id"] ?? NSNull(), "name": l["name"] ?? NSNull(), "team": ["id": team]])
            }
        }
        return out
    }

    // MARK: - Issues

    struct Details: Codable, Equatable {
        var updatedAt: String
        var description: String
        var attachments: [String]
        var children: [String]
    }

    /// Each answered issue by its id.
    private var answered: [String: [String: Any]] = [:]
    private lazy var kept: [String: Details] = cache.flatMap { FileManager.default.contents(atPath: $0.path) }
        .flatMap { try? JSONDecoder().decode([String: Details].self, from: $0) } ?? [:]
    /// The ids kept since this sync began: once `Issues` read its last page, all `cache` holds.
    private var touched: Set<String> = []
    private var complete = false

    private func listed(_ issue: [String: Any]) throws -> [String: Any] {
        guard let id = issue["uuid"] as? String else { throw LinearAPI.Failure.api("list_issues answered an issue with no uuid") }
        if let d = kept[id], d.updatedAt == issue["updatedAt"] as? String {
            touched.insert(id)
            return try shape(issue, d)
        }
        return try fresh(id)
    }

    private var displayNames: [String: String] = [:]

    private func displayName(_ user: String) throws -> String {
        if let known = displayNames[user] { return known }
        guard let name = (try tool("get_user", ["query": user]) as? [String: Any])?["displayName"] as? String else {
            throw LinearAPI.Failure.api("get_user answered no displayName for \(user)")
        }
        displayNames[user] = name
        return name
    }

    private func fresh(_ id: String) throws -> [String: Any] {
        guard let issue = try tool("get_issue", ["id": id, "fields": Self.fields + ["attachments"]]) as? [String: Any],
              let uuid = issue["uuid"] as? String else { throw LinearAPI.Failure.api("get_issue answered no issue for \(id)") }
        let children = try tool("list_issues", ["parentId": uuid, "limit": 10, "fields": ["url"]]) as? [String: Any]
        let d = Details(updatedAt: issue["updatedAt"] as? String ?? "", description: issue["description"] as? String ?? "",
                        attachments: (issue["attachments"] as? [[String: Any]] ?? []).compactMap { $0["url"] as? String },
                        children: (children?["issues"] as? [[String: Any]] ?? []).compactMap { $0["url"] as? String })
        kept[uuid] = d
        touched.insert(uuid)
        return try shape(issue, d)
    }

    /// `fresh(id)`, or nil for an issue Linear cannot find, which a GraphQL list leaves out.
    private func found(_ id: String) throws -> [String: Any]? {
        do {
            return try fresh(id)
        } catch LinearAPI.Failure.api(let why) where why.hasPrefix("get_issue: ") && why.contains("Could not find referenced Issue") {
            return nil
        }
    }

    /// A `get_issue` or `list_issues` issue, with `d`, as `linear.graphql` reads one; its
    /// labels are named by their names, which `save_issue` takes as ids.
    private func shape(_ i: [String: Any], _ d: Details) throws -> [String: Any] {
        let identifier = i["id"] as? String ?? ""
        let url = i["url"] as? String ?? ""
        var n: [String: Any] = [
            "id": i["uuid"] ?? NSNull(), "identifier": identifier, "title": i["title"] ?? NSNull(),
            "description": d.description, "url": url, "updatedAt": d.updatedAt, "archivedAt": i["archivedAt"] ?? NSNull(),
            "state": ["type": i["statusType"] ?? NSNull(), "name": i["status"] ?? NSNull()],
            "labels": ["pageInfo": ["hasNextPage": false],
                       "nodes": (i["labels"] as? [String] ?? []).map { ["id": $0, "name": $0] }],
            "children": ["nodes": d.children.map { ["url": $0] }],
            "attachments": ["pageInfo": ["hasNextPage": false], "nodes": d.attachments.map { ["url": $0] }],
            "team": ["id": i["teamId"] ?? NSNull(), "key": identifier.split(separator: "-").first.map(String.init) ?? ""],
        ]
        if let a = i["assigneeId"] as? String { n["assignee"] = ["id": a, "name": i["assignee"] as? String ?? ""] }
        if let c = i["createdById"] as? String { n["creator"] = ["id": c, "displayName": try displayName(c)] }
        if let p = i["parentId"] as? String, let issue = url.range(of: "/issue/") {
            n["parent"] = ["url": String(url[..<issue.upperBound]) + p]
        }
        if let id = i["uuid"] as? String { answered[id] = n }
        return n
    }

    private func save() {
        guard let cache, let data = try? JSONEncoder().encode(complete ? kept.filter { touched.contains($0.key) } : kept)
        else { return }
        _ = PrivateFiles.writeWhole(data, to: cache)
    }

    // MARK: - The session

    static let version = "2025-06-18"
    private var session: String?
    private var negotiated: String?
    private var started = false
    private var nextID = 1

    /// A tool's answer: the JSON its text holds.
    func tool(_ name: String, _ arguments: [String: Any]) throws -> Any {
        try start()
        let result: [String: Any]
        do {
            result = try request("tools/call", ["name": name, "arguments": arguments]).result
        } catch LinearAPI.Failure.http(404, _) where session != nil {
            // The server ended the session.
            (started, session, negotiated) = (false, nil, nil)
            try start()
            result = try request("tools/call", ["name": name, "arguments": arguments]).result
        }
        let text = (result["content"] as? [[String: Any]] ?? []).compactMap { $0["text"] as? String }.joined(separator: "\n")
        if PipelineRead.bool(result["isError"], false) { throw LinearAPI.Failure.api("\(name): \(CommsText.oneLine(text))") }
        guard let value = try? JSONSerialization.jsonObject(with: Data(text.utf8)) else {
            throw LinearAPI.Failure.api("\(name) answered no JSON: \(CommsText.oneLine(String(text.prefix(200))))")
        }
        return value
    }

    private func start() throws {
        guard !started else { return }
        let (result, headers) = try request("initialize", [
            "protocolVersion": Self.version, "capabilities": [:] as [String: Any],
            "clientInfo": ["name": "Diplomat", "version": "1"],
        ])
        session = headers["mcp-session-id"]
        negotiated = result["protocolVersion"] as? String ?? Self.version
        let note = try post(["jsonrpc": "2.0", "method": "notifications/initialized"])
        guard (200..<300).contains(note.status) else { throw LinearAPI.Failure.http(note.status, "") }
        started = true
    }

    private func request(_ method: String, _ params: [String: Any]) throws -> (result: [String: Any], headers: [String: String]) {
        let id = nextID
        nextID += 1
        let answer = try post(["jsonrpc": "2.0", "id": id, "method": method, "params": params])
        guard answer.status == 200 else {
            let root = (try? JSONSerialization.jsonObject(with: answer.body)) as? [String: Any]
            throw LinearAPI.Failure.http(answer.status, LinearLogin.oauthError(root) ?? "")
        }
        guard let reply = Self.reply(answer.body, id: id) else {
            throw LinearAPI.Failure.api("Linear's MCP server answered no \(method) reply")
        }
        if let error = reply["error"] as? [String: Any] {
            throw LinearAPI.Failure.api("\(method): \(error["message"] as? String ?? "failed")")
        }
        guard let result = reply["result"] as? [String: Any] else {
            throw LinearAPI.Failure.api("Linear's MCP server answered no \(method) result")
        }
        return (result, answer.headers)
    }

    private func post(_ message: [String: Any]) throws -> (status: Int, headers: [String: String], body: Data) {
        var headers = ["Authorization": try authorization(), "Content-Type": "application/json",
                       "Accept": "application/json, text/event-stream"]
        if let session { headers["Mcp-Session-Id"] = session }
        if let negotiated { headers["MCP-Protocol-Version"] = negotiated }
        let body = try JSONSerialization.data(withJSONObject: message, options: [.sortedKeys])
        do {
            return try transport(SlackAPI.Request(url: url, headers: headers, body: body, timeout: timeout))
        } catch SlackError.transport(let why) {
            throw LinearAPI.Failure.transport(why)
        } catch {
            throw LinearAPI.Failure.transport("no HTTP answer (\(error.localizedDescription))")
        }
    }

    /// The JSON-RPC reply to `id`: `body` itself, or the data of the event in it that is.
    static func reply(_ body: Data, id: Int) -> [String: Any]? {
        func matching(_ data: Data) -> [String: Any]? {
            guard let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
                  (obj["id"] as? NSNumber)?.intValue == id else { return nil }
            return obj
        }
        if let obj = matching(body) { return obj }
        let text = String(decoding: body, as: UTF8.self).replacingOccurrences(of: "\r\n", with: "\n")
        for event in text.components(separatedBy: "\n\n") {
            let data = event.split(separator: "\n").compactMap { line -> Substring? in
                guard line.hasPrefix("data:") else { return nil }
                let rest = line.dropFirst(5)
                return rest.first == " " ? rest.dropFirst() : rest
            }.joined(separator: "\n")
            if let obj = matching(Data(data.utf8)) { return obj }
        }
        return nil
    }
}
