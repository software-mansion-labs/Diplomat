import Foundation
import DiplomatCore
#if canImport(Glibc)
import Glibc
#endif

// The browser is `curl` against the real loopback listener; Linear is a stub transport.

private func body(_ object: Any) -> Data {
    (try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])) ?? Data()
}

private func form(_ request: SlackAPI.Request) -> [String: String] {
    var c = URLComponents()
    c.percentEncodedQuery = String(decoding: request.body, as: UTF8.self)
    return Dictionary((c.queryItems ?? []).map { ($0.name, $0.value ?? "") }) { a, _ in a }
}

private final class FakeLinear {
    var requests: [SlackAPI.Request] = []
    var registration: (status: Int, answer: [String: Any]) = (201, ["client_id": "smoke-client"])
    var token: (status: Int, answer: [String: Any]) = (200, ["access_token": "acc1", "token_type": "Bearer",
                                                             "expires_in": 86399, "refresh_token": "ref1",
                                                             "scope": "read write"])
    var tokenFails = false
    var mcpFails = false
    var revokeStatus = 200
    var viewer: (status: Int, answer: [String: Any]) =
        (200, ["data": ["viewer": ["id": "u1", "name": "Ada"], "organization": ["name": "Acme"]]])

    func transport(_ r: SlackAPI.Request) throws -> (status: Int, headers: [String: String], body: Data) {
        requests.append(r)
        switch r.url.path {
        case "/register":
            return (registration.status, [:], body(registration.answer))
        case "/token" where form(r)["grant_type"] == nil:
            return (revokeStatus, [:], Data())
        case "/token":
            if tokenFails { throw SlackError.transport("timed out after 30s") }
            return (token.status, [:], body(token.answer))
        case "/mcp":
            if mcpFails { throw SlackError.transport("connection reset") }
            let rpc = (try? JSONSerialization.jsonObject(with: r.body)) as? [String: Any] ?? [:]
            let id = rpc["id"] ?? NSNull()
            switch rpc["method"] as? String {
            case "initialize":
                return (200, ["mcp-session-id": "s1"],
                        body(["jsonrpc": "2.0", "id": id, "result": ["protocolVersion": "2025-06-18"]]))
            case "notifications/initialized":
                return (202, [:], Data())
            default:
                let me = String(decoding: body(["user": ["id": "u1", "name": "Ada"], "workspace": ["name": "Acme"]]),
                                as: UTF8.self)
                let reply = body(["jsonrpc": "2.0", "id": id, "result": ["content": [["type": "text", "text": me]]]])
                return (200, ["content-type": "text/event-stream"],
                        Data("event: message\ndata: ".utf8) + reply + Data("\n\n".utf8))
            }
        default:
            return (viewer.status, [:], body(viewer.answer))
        }
    }

    func at(_ path: String) -> [SlackAPI.Request] { requests.filter { $0.url.path == path } }
    var exchanges: [[String: String]] { at("/token").map(form).filter { $0["grant_type"] != nil } }
    var revocations: [[String: String]] { at("/token").map(form).filter { $0["grant_type"] == nil } }
}

/// A listener on 127.0.0.1:`port` held by someone else.
private func occupy(_ port: UInt16) -> Int32 {
#if canImport(Glibc)
    let fd = socket(AF_INET, Int32(SOCK_STREAM.rawValue), 0)
#else
    let fd = socket(AF_INET, SOCK_STREAM, 0)
#endif
    var one: Int32 = 1
    setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &one, socklen_t(MemoryLayout<Int32>.size))
    var addr = sockaddr_in()
#if canImport(Darwin)
    addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
#endif
    addr.sin_family = sa_family_t(AF_INET)
    addr.sin_port = port.bigEndian
    addr.sin_addr.s_addr = in_addr_t(0x7f00_0001).bigEndian
    let bound = withUnsafePointer(to: &addr) {
        $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) }
    }
    check(bound == 0 && listen(fd, 1) == 0, "port \(port) could not be occupied")
    return fd
}

/// A client of 127.0.0.1:`port` that never finishes a request: it sends nothing, or a byte
/// every 0.3s (`trickle`), and hangs up after `secs`.
private func stall(_ port: UInt16, trickle: Bool, secs: Double) {
    Thread.detachNewThread {
#if canImport(Glibc)
        let fd = socket(AF_INET, Int32(SOCK_STREAM.rawValue), 0)
        let flags = Int32(MSG_NOSIGNAL)
#else
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        var one: Int32 = 1
        setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &one, socklen_t(MemoryLayout<Int32>.size))
        let flags: Int32 = 0
#endif
        var addr = sockaddr_in()
#if canImport(Darwin)
        addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
#endif
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = port.bigEndian
        addr.sin_addr.s_addr = in_addr_t(0x7f00_0001).bigEndian
        _ = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) }
        }
        let end = Date().addingTimeInterval(secs)
        while Date() < end {
            if trickle { _ = send(fd, "G", 1, flags) }
            usleep(300_000)
        }
        close(fd)
    }
}

/// Plays the browser: each of `visits` (a query string, or a path starting with `/`) is
/// fetched in order from the redirect the consent page names, `{state}` its state.
private final class Browser {
    var authorize: [String: String] = [:]
    var opened = 0
    private var process: Process?
    private let out = Pipe()
    let visits: [String]

    init(_ visits: [String]) { self.visits = visits }

    func open(_ url: URL) {
        opened += 1
        authorize = Dictionary((URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? [])
            .map { ($0.name, $0.value ?? "") }) { a, _ in a }
        let redirect = authorize["redirect_uri"] ?? ""
        let base = redirect.components(separatedBy: "/linear/")[0]
        let script = visits.map { visit -> String in
            let post = visit.hasPrefix("POST ")
            let query = post ? String(visit.dropFirst(5)) : visit
            let target = query.hasPrefix("/") ? base + query : redirect + "?" + query
            let url = target.replacingOccurrences(of: "{state}", with: authorize["state"] ?? "")
            return "curl -sS -m 30\(post ? " -X POST" : "") -w ' %{http_code}' '\(url)' | tr -d '\\n'; echo"
        }.joined(separator: "; ")
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/sh")
        p.arguments = ["-c", script]
        p.standardOutput = out
        guard (try? p.run()) != nil else { return }
        process = p
    }

    /// Each visit's page and status.
    func pages() -> [String] {
        process?.waitUntilExit()
        let text = String(decoding: out.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
        return text.split(separator: "\n").map(String.init)
    }
}

func linearLoginSmoke() throws {
    section("linear login")
    // RFC 7636's appendix B, and SHA-256 over nothing and over two blocks.
    check(LinearLogin.challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk") == "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")
    check(LinearLogin.challenge("") == "47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU")
    check(LinearLogin.challenge("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")
          == "JI1qYdIGOLjlwCaTDD5gOaM85Flk_yFn9uzt1BnbBsE")

    let override = ProcessInfo.processInfo.environment[LinearAPI.envVar]
    unsetenv(LinearAPI.envVar)
    defer { if let override { setenv(LinearAPI.envVar, override, 1) } }
    let base = FileManager.default.temporaryDirectory
        .appendingPathComponent("diplomat-linear-login-\(getpid())", isDirectory: true)
    try? FileManager.default.removeItem(at: base)
    defer { try? FileManager.default.removeItem(at: base) }
    var dirs = 0
    func freshDir() -> URL {
        dirs += 1
        return base.appendingPathComponent("\(dirs)", isDirectory: true)
    }
    func mcp(secs: Double = 30) throws -> CoreAssets.PipelineModel.LinearMCP {
        try JSONDecoder().decode(CoreAssets.PipelineModel.LinearMCP.self, from: body([
            "url": "https://mcp.linear.test/mcp", "authorize": "https://mcp.linear.test/authorize",
            "token": "https://mcp.linear.test/token", "register": "https://mcp.linear.test/register",
            "revoke": "https://mcp.linear.test/token", "scope": "read write",
            "redirect": "http://127.0.0.1:{port}/linear/callback",
            "ports": [39170, 39171, 39172], "signInSecs": secs, "refreshMarginSecs": 600,
        ]))
    }
    func failure<T>(_ body: () throws -> T) -> LinearLogin.Failure? {
        do { _ = try body(); return nil } catch { return error as? LinearLogin.Failure }
    }
    func mode(_ url: URL) -> Int? { (try? FileManager.default.attributesOfItem(atPath: url.path)[.posixPermissions] as? Int) ?? nil }

    // ---- Signing in through the MCP server: the consent page, a stray request and a forged state, then the code ----
    let dir = freshDir()
    let linear = FakeLinear()
    let browser = Browser(["/favicon.ico", "code=forged&state=not-it", "POST code=c0&state={state}",
                           "code=c1&state={state}"])
    let started = Date()
    let login = try LinearLogin.signIn(in: dir, mcp: mcp(), open: browser.open, transport: linear.transport)
    let pages = browser.pages()
    check(pages.count == 4 && pages[0].hasSuffix(" 404") && pages[1].hasSuffix(" 400") && pages[2].hasSuffix(" 000")
          && pages[3].contains("signed in to Linear as Ada (Acme)") && pages[3].hasSuffix(" 200"),
          "the browser saw: \(pages)")
    let page = browser.authorize
    let registered = linear.at("/register").map { (try? JSONSerialization.jsonObject(with: $0.body)) as? [String: Any] }
    check(registered.count == 1 && registered[0]?["redirect_uris"] as? [String] == [page["redirect_uri"] ?? ""]
          && registered[0]?["token_endpoint_auth_method"] as? String == "none"
          && registered[0]?["grant_types"] as? [String] == ["authorization_code", "refresh_token"]
          && registered[0]?["client_name"] as? String == "Diplomat", "the registration: \(registered)")
    check(browser.opened == 1 && page["client_id"] == "smoke-client" && page["response_type"] == "code"
          && page["scope"] == "read write" && page["code_challenge_method"] == "S256" && page["prompt"] == "consent"
          && page["resource"] == "https://mcp.linear.test/mcp"
          && page["redirect_uri"] == "http://127.0.0.1:39170/linear/callback" && page["state"]?.count == 43,
          "the consent page: \(page)")
    let exchange = linear.exchanges
    check(exchange.count == 1 && exchange[0]["grant_type"] == "authorization_code" && exchange[0]["code"] == "c1"
          && exchange[0]["redirect_uri"] == page["redirect_uri"] && exchange[0]["client_id"] == "smoke-client"
          && exchange[0]["resource"] == "https://mcp.linear.test/mcp" && exchange[0]["client_secret"] == nil,
          "the exchange: \(exchange)")
    check(exchange.first?["code_verifier"].map(LinearLogin.challenge) == page["code_challenge"],
          "the verifier answers the challenge")
    check(linear.at("/token").first?.headers["Content-Type"] == "application/x-www-form-urlencoded")
    let rpc = linear.at("/mcp")
    let methods = rpc.map { ((try? JSONSerialization.jsonObject(with: $0.body)) as? [String: Any])?["method"] as? String ?? "" }
    check(methods == ["initialize", "notifications/initialized", "tools/call"]
          && rpc.allSatisfy { $0.headers["Authorization"] == "Bearer acc1" }
          && rpc[0].headers["Mcp-Session-Id"] == nil && rpc[2].headers["Mcp-Session-Id"] == "s1"
          && rpc[2].headers["MCP-Protocol-Version"] == "2025-06-18"
          && rpc[2].headers["Accept"] == "application/json, text/event-stream"
          && String(decoding: rpc[2].body, as: UTF8.self).contains(#""name":"whoami""#),
          "who the token is, asked of the MCP server: \(methods) \(rpc.map(\.headers))")
    check(linear.at("/graphql").isEmpty, "an MCP login never reaches the GraphQL API")
    check(login.method == .mcp && login.accessToken == "acc1" && login.refreshToken == "ref1"
          && login.clientID == "smoke-client" && login.user == "Ada" && login.organization == "Acme",
          "the login: \(login)")
    check(login.expiresAt.map { abs($0.timeIntervalSince(started.addingTimeInterval(86399))) < 60 } == true,
          "expires a day on: \(String(describing: login.expiresAt))")
    let file = dir.appendingPathComponent("linear-login.json")
    var kept = LinearLogin.saved(in: dir)
    check(kept?.expiresAt.map { abs($0.timeIntervalSince(login.expiresAt!)) < 1 } == true)
    kept?.expiresAt = login.expiresAt
    check(mode(file) == 0o600 && kept == login, "saved owner-only: \(String(describing: mode(file))) \(String(describing: kept))")
    check(mode(dir) == 0o700, "in a directory only its owner opens: \(String(describing: mode(dir)))")

    // ---- A port taken: the next one listed ----
    let held = occupy(39170)
    let next = Browser(["code=c2&state={state}"])
    let nextFake = FakeLinear()
    _ = try LinearLogin.signIn(in: freshDir(), mcp: mcp(), open: next.open, transport: nextFake.transport)
    _ = next.pages()
    check(next.authorize["redirect_uri"] == "http://127.0.0.1:39171/linear/callback"
          && nextFake.at("/register").first.map { String(decoding: $0.body, as: UTF8.self) }?
            .contains("127.0.0.1:39171") == true,
          "past a taken port, registered at it: \(next.authorize["redirect_uri"] ?? "")")
    let held2 = occupy(39171), held3 = occupy(39172)
    let portless = FakeLinear()
    check(failure { try LinearLogin.signIn(in: freshDir(), mcp: mcp(), open: { _ in }, transport: portless.transport) }
          == .noPort([39170, 39171, 39172]) && portless.requests.isEmpty, "every port taken: nothing registered")
    for fd in [held, held2, held3] { close(fd) }

    // ---- Each way a sign-in ends without a login ----
    let unregistered = FakeLinear()
    unregistered.registration = (400, ["error": "invalid_redirect_uri", "error_description": "loopback only"])
    var asked = false
    check(failure { try LinearLogin.signIn(in: freshDir(), mcp: mcp(), open: { _ in asked = true },
                                           transport: unregistered.transport) }
          == .refused("the client was not registered: invalid_redirect_uri: loopback only") && !asked,
          "no client registered: no page opened")

    let declinedDir = freshDir()
    let declined = Browser(["error=access_denied&error_description=The%20user%20said%20%3Cno%3E&state={state}"])
    let declinedFake = FakeLinear()
    check(failure { try LinearLogin.signIn(in: declinedDir, mcp: mcp(), open: declined.open,
                                           transport: declinedFake.transport) } == .declined("The user said <no>"))
    check(declined.pages().first?.contains("declined: The user said &lt;no&gt;") == true
          && declinedFake.exchanges.isEmpty && declinedFake.at("/mcp").isEmpty
          && LinearLogin.saved(in: declinedDir) == nil, "declined: nothing asked, nothing saved")

    let refusedDir = freshDir()
    let refusedFake = FakeLinear()
    refusedFake.token = (400, ["error": "invalid_grant", "error_description": "code expired"])
    let refused = Browser(["code=c3&state={state}"])
    check(failure { try LinearLogin.signIn(in: refusedDir, mcp: mcp(), open: refused.open,
                                           transport: refusedFake.transport) } == .refused("invalid_grant: code expired"))
    check(refused.pages().first?.hasSuffix(" 400") == true && LinearLogin.saved(in: refusedDir) == nil,
          "a refused code: nothing saved")

    let codeless = Browser(["state={state}"])
    check(failure { try LinearLogin.signIn(in: freshDir(), mcp: mcp(), open: codeless.open,
                                           transport: FakeLinear().transport) } == .refused("no code came back"))
    _ = codeless.pages()
    let failedFake = FakeLinear()
    failedFake.token = (500, ["access_token": "acc1"])
    let failed = Browser(["code=c5&state={state}"])
    check(failure { try LinearLogin.signIn(in: freshDir(), mcp: mcp(), open: failed.open,
                                           transport: failedFake.transport) } == .refused("HTTP 500"),
          "a token in an answer that is not a 200 is none")
    _ = failed.pages()

    let unreachedDir = freshDir()
    let unreachedFake = FakeLinear()
    unreachedFake.mcpFails = true
    let unreached = Browser(["code=c4&state={state}"])
    var why = ""
    do {
        _ = try LinearLogin.signIn(in: unreachedDir, mcp: mcp(), open: unreached.open, transport: unreachedFake.transport)
    } catch { why = error.localizedDescription }
    check(why == "Linear could not be reached: connection reset" && LinearLogin.saved(in: unreachedDir) == nil,
          "who the token is, unreached: \(why)")
    _ = unreached.pages()

    // Nobody comes back: the page was handed over all the same, to be opened by hand.
    let quick = Date()
    var handed: URL?
    check(failure { try LinearLogin.signIn(in: freshDir(), mcp: mcp(secs: 0.5), open: { handed = $0 },
                                           transport: FakeLinear().transport) } == .timedOut)
    check(Date().timeIntervalSince(quick) < 5, "signInSecs bounds the wait")
    check(handed?.absoluteString.hasPrefix("https://mcp.linear.test/authorize?client_id=smoke-client") == true,
          "the page handed over: \(String(describing: handed))")
    var handedCancelled = false
    check(failure { try LinearLogin.signIn(in: freshDir(), mcp: mcp(), open: { _ in handedCancelled = true },
                                           cancelled: { true }, transport: FakeLinear().transport) }
          == .cancelled && !handedCancelled, "cancelled before it waits: no page handed over")
    var cancelAt = Date().addingTimeInterval(0.5)
    check(failure { try LinearLogin.signIn(in: freshDir(), mcp: mcp(), open: { _ in },
                                           cancelled: { Date() > cancelAt }, transport: FakeLinear().transport) } == .cancelled
          && Date().timeIntervalSince(cancelAt) < 1, "a Cancel is heard within a quarter second or so")
    for trickle in [false, true] {
        cancelAt = Date().addingTimeInterval(0.5)
        check(failure { try LinearLogin.signIn(in: freshDir(), mcp: mcp(), open: { url in
            let redirect = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?
                .first { $0.name == "redirect_uri" }?.value ?? ""
            stall(UInt16(URLComponents(string: redirect)?.port ?? 0), trickle: trickle, secs: 6)
        }, cancelled: { Date() > cancelAt }, transport: FakeLinear().transport) } == .cancelled
              && Date().timeIntervalSince(cancelAt) < 3.5,
              "a client \(trickle ? "trickling bytes" : "sending nothing") holds a Cancel up "
                  + "\(Date().timeIntervalSince(cancelAt))s")
    }

    // ---- Signing in with a personal API key ----
    let keyDir = freshDir()
    let keyFake = FakeLinear()
    let keyed = try LinearLogin.signIn(key: "  lin_api_k1\n", in: keyDir, transport: keyFake.transport)
    let asked1 = keyFake.at("/graphql")
    check(keyFake.requests.count == 1 && asked1.count == 1 && asked1[0].headers["Authorization"] == "lin_api_k1"
          && String(decoding: asked1[0].body, as: UTF8.self).contains(#""operationName":"Viewer""#),
          "a key is asked who it is, trimmed: \(keyFake.requests.map(\.url))")
    check(keyed.method == .key && keyed.accessToken == "lin_api_k1" && keyed.refreshToken == nil
          && keyed.expiresAt == nil && keyed.clientID == nil && keyed.user == "Ada" && keyed.organization == "Acme"
          && LinearLogin.saved(in: keyDir) == keyed && mode(keyDir.appendingPathComponent("linear-login.json")) == 0o600,
          "the key saved owner-only: \(keyed)")
    let rejected = FakeLinear()
    rejected.viewer = (401, ["errors": [["message": "Authentication required, not authenticated"]]])
    let rejectedDir = freshDir()
    why = ""
    do { _ = try LinearLogin.signIn(key: "lin_api_bad", in: rejectedDir, transport: rejected.transport) } catch {
        why = error.localizedDescription
    }
    check(why == "Linear answered HTTP 401: Authentication required, not authenticated"
          && LinearLogin.saved(in: rejectedDir) == nil, "a key Linear refuses is not saved: \(why)")
    for broken in ["lin_api_a\nurl = \"http://127.0.0.1:9\"", "lin_api_a\rb"] {
        why = ""
        do { _ = try LinearLogin.signIn(key: broken, in: rejectedDir, transport: SlackAPI.curl) } catch {
            why = error.localizedDescription
        }
        check(why == "Linear could not be reached: the Authorization header holds a line break",
              "a key that would break curl's config is not sent: \(why)")
    }
    let blank = FakeLinear()
    check(failure { try LinearLogin.signIn(key: " \n", in: freshDir(), transport: blank.transport) } == .noKey
          && blank.requests.isEmpty, "no key: Linear is not asked")

    // ---- What a sync sends, an MCP login refreshed under the margin ----
    let now = Date()
    let real = try CoreAssets.pipeline().linearMCP
    func saveLogin(_ dir: URL, method: String = "mcp", expires: Date?, refresh: String? = "ref1") throws {
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        var obj: [String: Any] = ["method": method, "accessToken": "acc1", "clientID": "cid-saved", "user": "Ada",
                                  "organization": "Acme"]
        if let expires { obj["expiresAt"] = ISO8601DateFormatter().string(from: expires) }
        if let refresh { obj["refreshToken"] = refresh }
        try body(obj).write(to: dir.appendingPathComponent("linear-login.json"))
    }
    let authDir = freshDir()
    let auth = FakeLinear()
    check((try LinearLogin.access(in: authDir, now: now, transport: auth.transport)) == nil, "signed out: nil")
    try saveLogin(authDir, expires: now.addingTimeInterval(3600))
    check((try LinearLogin.access(in: authDir, now: now, transport: auth.transport)) == .init(.mcp, "Bearer acc1")
          && auth.requests.isEmpty, "a fresh token is sent as it is")
    try saveLogin(authDir, expires: now.addingTimeInterval(300))
    auth.token = (200, ["access_token": "acc2", "expires_in": 86399, "refresh_token": "ref2"])
    check((try LinearLogin.access(in: authDir, now: now, transport: auth.transport)) == .init(.mcp, "Bearer acc2"))
    let refresh = auth.exchanges
    check(refresh.count == 1 && refresh[0]["grant_type"] == "refresh_token" && refresh[0]["refresh_token"] == "ref1"
          && refresh[0]["client_id"] == "cid-saved" && refresh[0]["resource"] == real.url
          && auth.at("/token").first?.url.absoluteString == real.token, "the refresh: \(refresh)")
    let rotated = LinearLogin.saved(in: authDir)
    check(rotated?.accessToken == "acc2" && rotated?.refreshToken == "ref2" && rotated?.clientID == "cid-saved"
          && rotated?.expiresAt.map { $0 > now.addingTimeInterval(86000) } == true, "rotated and saved: \(String(describing: rotated))")

    try saveLogin(authDir, expires: now.addingTimeInterval(300))
    auth.token = (200, ["access_token": "acc3", "expires_in": 86399])
    _ = try LinearLogin.access(in: authDir, now: now, transport: auth.transport)
    check(LinearLogin.saved(in: authDir)?.refreshToken == "ref1", "a refresh that names no new refresh token keeps the last")

    try saveLogin(authDir, expires: now.addingTimeInterval(300))
    auth.tokenFails = true
    check((try LinearLogin.access(in: authDir, now: now, transport: auth.transport)) == .init(.mcp, "Bearer acc1")
          && LinearLogin.saved(in: authDir)?.refreshToken == "ref1", "a failed refresh keeps a token not yet expired")
    let tried = auth.exchanges.count
    _ = try LinearLogin.access(in: authDir, now: now.addingTimeInterval(59), transport: auth.transport)
    check(auth.exchanges.count == tried, "…and is not tried again within a minute")
    _ = try LinearLogin.access(in: authDir, now: now.addingTimeInterval(60), transport: auth.transport)
    check(auth.exchanges.count == tried + 1, "…but is once it has passed")
    try saveLogin(authDir, expires: now.addingTimeInterval(-60))
    check(failure { try LinearLogin.access(in: authDir, now: now, transport: auth.transport) }
          == .transport("timed out after 30s"), "an expired token whose refresh failed")
    auth.tokenFails = false
    auth.token = (400, ["error": "invalid_grant"])
    check(failure { try LinearLogin.access(in: authDir, now: now, transport: auth.transport) } == .expired
          && LinearLogin.saved(in: authDir) == nil, "a login whose refresh Linear refuses is forgotten")
    try saveLogin(authDir, expires: now.addingTimeInterval(-60), refresh: nil)
    check(failure { try LinearLogin.access(in: authDir, now: now, transport: auth.transport) } == .expired,
          "expired with nothing to refresh it with")
    auth.requests = []
    try saveLogin(authDir, method: "key", expires: now.addingTimeInterval(-60))
    check((try LinearLogin.access(in: authDir, now: now, transport: auth.transport)) == .init(.key, "acc1")
          && auth.requests.isEmpty, "a key is sent as it is, whatever its file says of expiry")
    setenv(LinearAPI.envVar, "lin_api_override", 1)
    check((try LinearLogin.access(in: authDir, now: now, transport: auth.transport)) == .init(.key, "lin_api_override"))
    unsetenv(LinearAPI.envVar)

    // ---- Signing out: forgotten, then an MCP login revoked ----
    let outDir = freshDir()
    let out = FakeLinear()
    try saveLogin(outDir, expires: now.addingTimeInterval(3600))
    check((try LinearLogin.signOut(in: outDir, transport: out.transport)) == nil && LinearLogin.saved(in: outDir) == nil)
    check(out.revocations.count == 1 && out.revocations[0]["token"] == "ref1"
          && out.revocations[0]["token_type_hint"] == "refresh_token" && out.revocations[0]["client_id"] == "cid-saved"
          && out.at("/token").first?.url.absoluteString == real.revoke, "the revocation: \(out.revocations)")
    try saveLogin(outDir, expires: now.addingTimeInterval(3600))
    out.revokeStatus = 400
    check((try LinearLogin.signOut(in: outDir, transport: out.transport)) == "Linear answered HTTP 400 to the revocation"
          && LinearLogin.saved(in: outDir) == nil, "forgotten though Linear did not revoke it")
    out.requests = []
    out.revokeStatus = 200
    try saveLogin(outDir, expires: now.addingTimeInterval(3600), refresh: nil)
    _ = try LinearLogin.signOut(in: outDir, transport: out.transport)
    check(out.revocations.count == 1 && out.revocations[0]["token"] == "acc1"
          && out.revocations[0]["token_type_hint"] == "access_token",
          "no refresh token: the access token is revoked: \(out.revocations)")
    out.requests = []
    try saveLogin(outDir, method: "key", expires: nil, refresh: nil)
    check((try LinearLogin.signOut(in: outDir, transport: out.transport)) == nil && LinearLogin.saved(in: outDir) == nil
          && out.requests.isEmpty, "a key is forgotten, with nothing to revoke")
    check((try LinearLogin.signOut(in: outDir, transport: out.transport)) == nil && out.requests.isEmpty,
          "nothing saved: nothing to revoke")
    let cache = outDir.appendingPathComponent("linear-mcp-cache.json")
    try saveLogin(outDir, expires: now.addingTimeInterval(3600))
    try Data("{}".utf8).write(to: cache)
    _ = try LinearLogin.signOut(in: outDir, transport: out.transport)
    check(!FileManager.default.fileExists(atPath: cache.path), "the issues kept under the login go with it")
    out.requests = []
    try Data(#"{"accessToken":"old","refreshToken":"old-r","user":"Ada","organization":"Acme"}"#.utf8)
        .write(to: outDir.appendingPathComponent("linear-login.json"))
    let unreadable = LinearLogin.saved(in: outDir)
    let unreadableOut = try LinearLogin.signOut(in: outDir, transport: out.transport)
    check(unreadable == nil && unreadableOut == nil
          && !FileManager.default.fileExists(atPath: outDir.appendingPathComponent("linear-login.json").path)
          && out.requests.isEmpty, "a login it cannot read is forgotten all the same")
    check((try LinearLogin.signOut(in: base.appendingPathComponent("none"), transport: out.transport)) == nil,
          "no directory: nothing to sign out of")
}
