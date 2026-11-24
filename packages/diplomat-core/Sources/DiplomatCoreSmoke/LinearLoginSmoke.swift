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
    var token: (status: Int, answer: [String: Any]) = (200, ["access_token": "acc1", "token_type": "Bearer",
                                                             "expires_in": 86399, "refresh_token": "ref1",
                                                             "scope": "read write"])
    var tokenFails = false
    var revokeStatus = 200

    func transport(_ r: SlackAPI.Request) throws -> (status: Int, headers: [String: String], body: Data) {
        requests.append(r)
        switch r.url.path {
        case "/oauth/token":
            if tokenFails { throw SlackError.transport("timed out after 30s") }
            return (token.status, [:], body(token.answer))
        case "/oauth/revoke":
            return (revokeStatus, [:], Data())
        default:
            return (200, [:], body(["data": ["viewer": ["id": "u1", "name": "Ada"], "organization": ["name": "Acme"]]]))
        }
    }

    func at(_ path: String) -> [SlackAPI.Request] { requests.filter { $0.url.path == path } }
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

/// Plays the browser: each of `visits` (a query string, or a path starting with `/`) is
/// fetched in order from the redirect the consent page names, `{state}` its state.
private final class Browser {
    var authorize: [String: String] = [:]
    var opened = 0
    private var process: Process?
    private let out = Pipe()
    let visits: [String]

    init(_ visits: [String]) { self.visits = visits }

    func open(_ url: URL) -> Bool {
        opened += 1
        authorize = Dictionary((URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? [])
            .map { ($0.name, $0.value ?? "") }) { a, _ in a }
        let redirect = authorize["redirect_uri"] ?? ""
        let base = redirect.components(separatedBy: "/linear/")[0]
        let script = visits.map { visit -> String in
            let target = visit.hasPrefix("/") ? base + visit : redirect + "?" + visit
            let url = target.replacingOccurrences(of: "{state}", with: authorize["state"] ?? "")
            return "curl -sS -m 30 -w ' %{http_code}' '\(url)' | tr -d '\\n'; echo"
        }.joined(separator: "; ")
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/sh")
        p.arguments = ["-c", script]
        p.standardOutput = out
        guard (try? p.run()) != nil else { return false }
        process = p
        return true
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
    func oauth(client: String = "smoke-client", secs: Double = 30) throws -> CoreAssets.PipelineModel.LinearOAuth {
        try JSONDecoder().decode(CoreAssets.PipelineModel.LinearOAuth.self, from: body([
            "clientID": client, "authorize": "https://linear.test/oauth/authorize",
            "token": "https://api.linear.test/oauth/token", "revoke": "https://api.linear.test/oauth/revoke",
            "scope": "read,write", "redirect": "http://127.0.0.1:{port}/linear/callback",
            "ports": [39170, 39171, 39172], "signInSecs": secs, "refreshMarginSecs": 600,
        ]))
    }
    func failure<T>(_ body: () throws -> T) -> LinearLogin.Failure? {
        do { _ = try body(); return nil } catch { return error as? LinearLogin.Failure }
    }

    // ---- Signing in: the consent page, a stray request and a forged state, then the code ----
    let dir = freshDir()
    let linear = FakeLinear()
    let browser = Browser(["/favicon.ico", "code=forged&state=not-it", "code=c1&state={state}"])
    let started = Date()
    let login = try LinearLogin.signIn(in: dir, oauth: oauth(), open: browser.open, transport: linear.transport)
    let pages = browser.pages()
    check(pages.count == 3 && pages[0].hasSuffix(" 404") && pages[1].hasSuffix(" 400")
          && pages[2].contains("signed in to Linear as Ada (Acme)") && pages[2].hasSuffix(" 200"),
          "the browser saw: \(pages)")
    let page = browser.authorize
    check(browser.opened == 1 && page["client_id"] == "smoke-client" && page["response_type"] == "code"
          && page["scope"] == "read,write" && page["code_challenge_method"] == "S256" && page["prompt"] == "consent"
          && page["redirect_uri"] == "http://127.0.0.1:39170/linear/callback" && page["state"]?.count == 43,
          "the consent page: \(page)")
    let exchange = linear.at("/oauth/token").map(form)
    check(exchange.count == 1 && exchange[0]["grant_type"] == "authorization_code" && exchange[0]["code"] == "c1"
          && exchange[0]["redirect_uri"] == page["redirect_uri"] && exchange[0]["client_id"] == "smoke-client"
          && exchange[0]["client_secret"] == nil, "the exchange: \(exchange)")
    check(exchange.first?["code_verifier"].map(LinearLogin.challenge) == page["code_challenge"],
          "the verifier answers the challenge")
    check(linear.at("/oauth/token").first?.headers["Content-Type"] == "application/x-www-form-urlencoded")
    let viewer = linear.requests.filter { $0.url.path == "/graphql" }
    check(viewer.count == 1 && viewer[0].headers["Authorization"] == "Bearer acc1"
          && String(decoding: viewer[0].body, as: UTF8.self).contains(#""operationName":"Viewer""#),
          "who the token is: \(viewer.map(\.headers))")
    check(login.accessToken == "acc1" && login.refreshToken == "ref1" && login.user == "Ada"
          && login.organization == "Acme", "the login: \(login)")
    check(login.expiresAt.map { abs($0.timeIntervalSince(started.addingTimeInterval(86399))) < 60 } == true,
          "expires a day on: \(String(describing: login.expiresAt))")
    let file = dir.appendingPathComponent("linear-login.json")
    let mode = (try? FileManager.default.attributesOfItem(atPath: file.path)[.posixPermissions] as? Int) ?? nil
    let kept = LinearLogin.saved(in: dir)
    check(mode == 0o600 && kept?.accessToken == "acc1" && kept?.refreshToken == "ref1" && kept?.user == "Ada"
          && kept?.organization == "Acme" && kept?.expiresAt.map { abs($0.timeIntervalSince(login.expiresAt!)) < 1 } == true,
          "saved owner-only: \(String(describing: mode)) \(String(describing: kept))")

    // ---- A port taken: the next one listed ----
    let held = occupy(39170)
    let next = Browser(["code=c2&state={state}"])
    _ = try LinearLogin.signIn(in: freshDir(), oauth: oauth(), open: next.open, transport: FakeLinear().transport)
    _ = next.pages()
    check(next.authorize["redirect_uri"] == "http://127.0.0.1:39171/linear/callback",
          "past a taken port: \(next.authorize["redirect_uri"] ?? "")")
    let held2 = occupy(39171), held3 = occupy(39172)
    check(failure { try LinearLogin.signIn(in: freshDir(), oauth: oauth(), open: { _ in true }) }
          == .noPort([39170, 39171, 39172]), "every port taken")
    for fd in [held, held2, held3] { close(fd) }

    // ---- Each way a sign-in ends without a login ----
    let declinedDir = freshDir()
    let declined = Browser(["error=access_denied&error_description=The%20user%20said%20no&state={state}"])
    let declinedFake = FakeLinear()
    check(failure { try LinearLogin.signIn(in: declinedDir, oauth: oauth(), open: declined.open,
                                           transport: declinedFake.transport) } == .declined("The user said no"))
    check(declined.pages().first?.contains("declined: The user said no") == true && declinedFake.requests.isEmpty
          && LinearLogin.saved(in: declinedDir) == nil, "declined: nothing asked, nothing saved")

    let refusedDir = freshDir()
    let refusedFake = FakeLinear()
    refusedFake.token = (400, ["error": "invalid_grant", "error_description": "code expired"])
    let refused = Browser(["code=c3&state={state}"])
    check(failure { try LinearLogin.signIn(in: refusedDir, oauth: oauth(), open: refused.open,
                                           transport: refusedFake.transport) } == .refused("invalid_grant: code expired"))
    check(refused.pages().first?.hasSuffix(" 400") == true && LinearLogin.saved(in: refusedDir) == nil,
          "a refused code: nothing saved")

    let quick = Date()
    check(failure { try LinearLogin.signIn(in: freshDir(), oauth: oauth(secs: 0.5), open: { _ in true }) } == .timedOut)
    check(Date().timeIntervalSince(quick) < 5, "signInSecs bounds the wait")
    check(failure { try LinearLogin.signIn(in: freshDir(), oauth: oauth(), open: { _ in true }, cancelled: { true }) }
          == .cancelled)
    check(failure { try LinearLogin.signIn(in: freshDir(), oauth: oauth(), open: { _ in false }) }.map {
        if case .noBrowser(let url) = $0 { return url.hasPrefix("https://linear.test/oauth/authorize?client_id=smoke-client") }
        return false
    } == true, "no browser: the page is named")
    var asked = false
    check(failure { try LinearLogin.signIn(in: freshDir(), oauth: oauth(client: ""), open: { _ in asked = true; return true }) }
          == .noClient && !asked, "no client ID: no page opened")

    // ---- The Authorization a sync sends, refreshed under the margin ----
    let now = Date()
    func saveLogin(_ dir: URL, expires: Date?, refresh: String? = "ref1") throws {
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        var obj: [String: Any] = ["accessToken": "acc1", "user": "Ada", "organization": "Acme"]
        if let expires { obj["expiresAt"] = ISO8601DateFormatter().string(from: expires) }
        if let refresh { obj["refreshToken"] = refresh }
        try body(obj).write(to: dir.appendingPathComponent("linear-login.json"))
    }
    let authDir = freshDir()
    let auth = FakeLinear()
    check((try LinearLogin.authorization(in: authDir, now: now, transport: auth.transport)) == nil, "signed out: nil")
    try saveLogin(authDir, expires: now.addingTimeInterval(3600))
    check((try LinearLogin.authorization(in: authDir, now: now, transport: auth.transport)) == "Bearer acc1"
          && auth.requests.isEmpty, "a fresh token is sent as it is")
    try saveLogin(authDir, expires: now.addingTimeInterval(300))
    auth.token = (200, ["access_token": "acc2", "expires_in": 86399, "refresh_token": "ref2"])
    check((try LinearLogin.authorization(in: authDir, now: now, transport: auth.transport)) == "Bearer acc2")
    let refresh = auth.at("/oauth/token").map(form)
    let client = try CoreAssets.pipeline().linearOAuth.clientID
    check(refresh.count == 1 && refresh[0]["grant_type"] == "refresh_token" && refresh[0]["refresh_token"] == "ref1"
          && refresh[0]["client_id"] == client, "the refresh: \(refresh)")
    let rotated = LinearLogin.saved(in: authDir)
    check(rotated?.accessToken == "acc2" && rotated?.refreshToken == "ref2" && rotated?.user == "Ada"
          && rotated?.expiresAt.map { $0 > now.addingTimeInterval(86000) } == true, "rotated and saved: \(String(describing: rotated))")

    try saveLogin(authDir, expires: now.addingTimeInterval(300))
    auth.tokenFails = true
    check((try LinearLogin.authorization(in: authDir, now: now, transport: auth.transport)) == "Bearer acc1"
          && LinearLogin.saved(in: authDir)?.refreshToken == "ref1", "a failed refresh keeps a token not yet expired")
    try saveLogin(authDir, expires: now.addingTimeInterval(-60))
    check(failure { try LinearLogin.authorization(in: authDir, now: now, transport: auth.transport) }
          == .transport("timed out after 30s"), "an expired token whose refresh failed")
    auth.tokenFails = false
    auth.token = (400, ["error": "invalid_grant"])
    check(failure { try LinearLogin.authorization(in: authDir, now: now, transport: auth.transport) } == .expired
          && LinearLogin.saved(in: authDir) == nil, "a login Linear no longer accepts is forgotten")
    try saveLogin(authDir, expires: now.addingTimeInterval(-60), refresh: nil)
    check(failure { try LinearLogin.authorization(in: authDir, now: now, transport: auth.transport) } == .expired,
          "expired with nothing to refresh it with")
    setenv(LinearAPI.envVar, "lin_api_override", 1)
    check((try LinearLogin.authorization(in: freshDir(), now: now, transport: auth.transport)) == "lin_api_override")
    unsetenv(LinearAPI.envVar)

    // ---- Signing out: forgotten, then revoked ----
    let outDir = freshDir()
    let out = FakeLinear()
    try saveLogin(outDir, expires: now.addingTimeInterval(3600))
    check((try LinearLogin.signOut(in: outDir, transport: out.transport)) == nil && LinearLogin.saved(in: outDir) == nil)
    let revoke = out.at("/oauth/revoke").map(form)
    check(revoke.count == 1 && revoke[0]["token"] == "ref1" && revoke[0]["token_type_hint"] == "refresh_token",
          "the revocation: \(revoke)")
    try saveLogin(outDir, expires: now.addingTimeInterval(3600))
    out.revokeStatus = 400
    check((try LinearLogin.signOut(in: outDir, transport: out.transport)) == "Linear answered HTTP 400 to the revocation"
          && LinearLogin.saved(in: outDir) == nil, "forgotten though Linear did not revoke it")
    out.requests = []
    check((try LinearLogin.signOut(in: outDir, transport: out.transport)) == nil && out.requests.isEmpty,
          "nothing saved: nothing to revoke")
    check((try LinearLogin.signOut(in: base.appendingPathComponent("none"), transport: out.transport)) == nil,
          "no directory: nothing to sign out of")
}
