import Foundation
#if canImport(Glibc)
import Glibc
#endif

/// Diplomat's own sign-in to Linear: OAuth with PKCE in the browser, which hands the code
/// back to a loopback port. The tokens are kept owner-only in the pipeline's directory and
/// refreshed under its lock by whoever reads them. `LinearAPI.envVar` overrides the login.
public enum LinearLogin {
    public struct Saved: Codable, Equatable, Sendable {
        public var accessToken: String
        public var refreshToken: String?
        public var expiresAt: Date?
        /// Who Linear answered the token is, and their workspace.
        public var user: String
        public var organization: String
    }

    public enum Failure: LocalizedError, Equatable {
        case noClient
        case noPort([Int])
        case noBrowser(String)
        case timedOut
        case cancelled
        case declined(String)
        case refused(String)
        case transport(String)
        case expired
        case file(String)

        public var errorDescription: String? {
            switch self {
            case .noClient:
                return "Linear sign-in has no OAuth client: linearOAuth.clientID in pipeline.json is empty"
            case .noPort(let ports):
                return "Linear sign-in needs one of the ports " + ports.map(String.init).joined(separator: ", ")
                    + " free on 127.0.0.1, and none was"
            case .noBrowser(let url):
                return "No browser opened Linear's sign-in page: \(url)"
            case .timedOut:
                return "Linear sign-in was not finished in the browser in time"
            case .cancelled:
                return "Linear sign-in was cancelled"
            case .declined(let why):
                return "Linear sign-in was declined: \(why)"
            case .refused(let why):
                return "Linear refused the sign-in: \(why)"
            case .transport(let why):
                return "Linear could not be reached: \(why)"
            case .expired:
                return "Linear no longer accepts the login: sign in again (Settings → Pipeline → Linear login)"
            case .file(let why):
                return why
            }
        }
    }

    static func file(in dir: URL) -> URL { dir.appendingPathComponent("linear-login.json") }
    static func lock(in dir: URL) -> URL { dir.appendingPathComponent("linear-login.lock") }

    public static func saved(in dir: URL = PipelineLog.dir) -> Saved? {
        guard let data = FileManager.default.contents(atPath: file(in: dir).path) else { return nil }
        return try? CommsLog.decoder.decode(Saved.self, from: data)
    }

    /// The `Authorization` a Linear call carries: the override's key as is, else the saved
    /// token, refreshed first once it expires within `refreshMarginSecs`. Nil when signed out;
    /// a login Linear no longer accepts is forgotten.
    public static func authorization(in dir: URL = PipelineLog.dir, now: Date = Date(),
                                     transport: @escaping SlackAPI.Transport = SlackAPI.curl) throws -> String? {
        if let env = ProcessInfo.processInfo.environment[LinearAPI.envVar], !env.isEmpty { return env }
        guard saved(in: dir) != nil else { return nil }
        let model = try config()
        let oauth = model.linearOAuth
        guard let answer = try PrivateFiles.locked(lock(in: dir), { () throws -> String? in
            guard var login = saved(in: dir) else { return nil }
            if let expires = login.expiresAt, expires <= now.addingTimeInterval(oauth.refreshMarginSecs) {
                do {
                    guard let refresh = login.refreshToken else { throw Failure.expired }
                    let t = try tokens([("grant_type", "refresh_token"), ("refresh_token", refresh),
                                        ("client_id", oauth.clientID)], to: oauth.token, model: model,
                                       now: now, transport: transport)
                    login.accessToken = t.access
                    login.refreshToken = t.refresh ?? refresh
                    login.expiresAt = t.expires
                    try save(login, in: dir)
                } catch Failure.expired {
                    unlink(file(in: dir).path)
                    throw Failure.expired
                } catch where expires > now {
                    // Still good for now: the next read refreshes it.
                }
            }
            return "Bearer " + login.accessToken
        }) else {
            throw Failure.file("\(lock(in: dir).path) could not be locked")
        }
        return answer
    }

    /// Opens Linear's consent page with `open` and waits on 127.0.0.1 for the browser to
    /// come back, until `signInSecs` pass or `cancelled` answers true; then exchanges the
    /// code, asks Linear who the token is, and saves the login.
    public static func signIn(in dir: URL = PipelineLog.dir, oauth given: CoreAssets.PipelineModel.LinearOAuth? = nil,
                              open: (URL) -> Bool, cancelled: () -> Bool = { false },
                              transport: @escaping SlackAPI.Transport = SlackAPI.curl) throws -> Saved {
        let model = try config()
        let oauth = given ?? model.linearOAuth
        guard !oauth.clientID.isEmpty else { throw Failure.noClient }
        guard let listener = oauth.ports.lazy.compactMap({ Listener(port: UInt16(clamping: $0)) }).first else {
            throw Failure.noPort(oauth.ports)
        }
        let redirect = oauth.redirect.replacingOccurrences(of: "{port}", with: String(listener.port))
        let verifier = randomToken()
        let state = randomToken()
        var page = URLComponents(string: oauth.authorize)
        page?.queryItems = [
            URLQueryItem(name: "client_id", value: oauth.clientID),
            URLQueryItem(name: "redirect_uri", value: redirect),
            URLQueryItem(name: "response_type", value: "code"),
            URLQueryItem(name: "scope", value: oauth.scope),
            URLQueryItem(name: "state", value: state),
            URLQueryItem(name: "code_challenge", value: challenge(verifier)),
            URLQueryItem(name: "code_challenge_method", value: "S256"),
            // Lets a second sign-in pick another workspace.
            URLQueryItem(name: "prompt", value: "consent"),
        ]
        guard let url = page?.url, open(url) else { throw Failure.noBrowser(page?.string ?? oauth.authorize) }
        let path = URLComponents(string: redirect)?.path ?? ""
        let deadline = Date().addingTimeInterval(oauth.signInSecs)
        while true {
            guard let call = listener.next(until: deadline, cancelled: cancelled) else {
                throw cancelled() ? Failure.cancelled : Failure.timedOut
            }
            let query = URLComponents(string: call.target)
            guard query?.path == path else {
                call.answer(404, "Not found.")
                continue
            }
            func param(_ name: String) -> String? { query?.queryItems?.first { $0.name == name }?.value }
            guard param("state") == state else {
                call.answer(400, "This is not the sign-in Diplomat is waiting for.")
                continue
            }
            do {
                if let error = param("error") {
                    throw Failure.declined(param("error_description") ?? error)
                }
                guard let code = param("code"), !code.isEmpty else { throw Failure.refused("no code came back") }
                let t = try tokens([("grant_type", "authorization_code"), ("code", code),
                                    ("redirect_uri", redirect), ("client_id", oauth.clientID),
                                    ("code_verifier", verifier)], to: oauth.token, model: model, now: Date(),
                                   transport: transport)
                let me = try whoami("Bearer " + t.access, model: model, transport: transport)
                let login = Saved(accessToken: t.access, refreshToken: t.refresh, expiresAt: t.expires,
                                  user: me.user, organization: me.organization)
                PrivateFiles.prepare(dir)
                guard try PrivateFiles.locked(lock(in: dir), { try save(login, in: dir) }) != nil else {
                    throw Failure.file("\(lock(in: dir).path) could not be locked")
                }
                call.answer(200, "Diplomat is signed in to Linear as \(me.user) (\(me.organization)). "
                    + "You can close this tab.")
                return login
            } catch {
                call.answer(400, (error as? LocalizedError)?.errorDescription ?? "\(error)")
                throw error
            }
        }
    }

    /// Forgets the login, then asks Linear to revoke it: nil once both are done, else why
    /// Linear did not.
    public static func signOut(in dir: URL = PipelineLog.dir,
                               transport: @escaping SlackAPI.Transport = SlackAPI.curl) throws -> String? {
        guard saved(in: dir) != nil else { return nil }
        guard let login = try PrivateFiles.locked(lock(in: dir), { () throws -> Saved? in
            let login = saved(in: dir)
            if unlink(file(in: dir).path) != 0 && errno != ENOENT {
                throw Failure.file("\(file(in: dir).path) could not be removed")
            }
            return login
        }) else {
            throw Failure.file("\(lock(in: dir).path) could not be locked")
        }
        guard let login else { return nil }
        do {
            let model = try config()
            let token = login.refreshToken.map { ($0, "refresh_token") } ?? (login.accessToken, "access_token")
            let answer = try post(model.linearOAuth.revoke, [("token", token.0), ("token_type_hint", token.1)],
                                  timeout: model.httpTimeoutSecs, transport: transport)
            return answer.status == 200 ? nil : "Linear answered HTTP \(answer.status) to the revocation"
        } catch {
            return (error as? LocalizedError)?.errorDescription ?? "\(error)"
        }
    }

    // MARK: - Linear's answers

    static func config() throws -> CoreAssets.PipelineModel {
        do { return try CoreAssets.pipeline() } catch { throw Failure.refused(error.localizedDescription) }
    }

    static func save(_ login: Saved, in dir: URL) throws {
        guard let data = try? CommsLog.encoder.encode(login),
              PrivateFiles.writeWhole(data, to: file(in: dir)) else {
            throw Failure.file("\(file(in: dir).path) could not be written")
        }
    }

    /// The token endpoint's answer; `invalid_grant` on a refresh is the login's end.
    static func tokens(_ fields: [(String, String)], to endpoint: String, model: CoreAssets.PipelineModel, now: Date,
                       transport: SlackAPI.Transport) throws -> (access: String, refresh: String?, expires: Date?) {
        let answer = try post(endpoint, fields, timeout: model.httpTimeoutSecs, transport: transport)
        let obj = (try? JSONSerialization.jsonObject(with: answer.body)) as? [String: Any]
        guard answer.status == 200, let access = obj?["access_token"] as? String, !access.isEmpty else {
            let code = obj?["error"] as? String ?? ""
            if code == "invalid_grant" && fields.first?.1 == "refresh_token" { throw Failure.expired }
            let why = [code, obj?["error_description"] as? String ?? ""].filter { !$0.isEmpty }
            throw Failure.refused(why.isEmpty ? "HTTP \(answer.status)" : why.joined(separator: ": "))
        }
        let expires = (obj?["expires_in"] as? NSNumber).map { now.addingTimeInterval($0.doubleValue) }
        return (access, obj?["refresh_token"] as? String, expires)
    }

    static func whoami(_ authorization: String, model: CoreAssets.PipelineModel,
                       transport: @escaping SlackAPI.Transport) throws -> (user: String, organization: String) {
        guard let url = LinearAPI.endpoint(model) else { throw Failure.transport("the Linear API is not a URL") }
        let data: [String: Any]
        do {
            data = try LinearAPI(authorization: authorization, url: url, timeout: model.httpTimeoutSecs,
                                 transport: transport).call("Viewer", [:])
        } catch {
            throw Failure.refused(error.localizedDescription)
        }
        let user = (data["viewer"] as? [String: Any])?["name"] as? String ?? ""
        return (user, (data["organization"] as? [String: Any])?["name"] as? String ?? "")
    }

    private static func post(_ endpoint: String, _ fields: [(String, String)], timeout: TimeInterval,
                             transport: SlackAPI.Transport) throws -> (status: Int, headers: [String: String], body: Data) {
        guard let url = URL(string: endpoint) else { throw Failure.transport("\(endpoint) is not a URL") }
        let unreserved = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")
        let body = fields.map { "\($0.0)=\($0.1.addingPercentEncoding(withAllowedCharacters: unreserved) ?? "")" }
            .joined(separator: "&")
        do {
            return try transport(SlackAPI.Request(
                url: url, headers: ["Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json"],
                body: Data(body.utf8), timeout: timeout))
        } catch SlackError.transport(let why) {
            throw Failure.transport(why)
        } catch {
            throw Failure.transport("no HTTP answer (\(error.localizedDescription))")
        }
    }

    // MARK: - PKCE

    /// PKCE's S256 challenge for `verifier`.
    public static func challenge(_ verifier: String) -> String { base64url(sha256(Data(verifier.utf8))) }

    /// 32 random bytes, base64url: a PKCE verifier (43 characters) or a state.
    static func randomToken() -> String {
        var rng = SystemRandomNumberGenerator()
        return base64url(Data((0..<32).map { _ in UInt8.random(in: .min ... .max, using: &rng) }))
    }

    static func base64url(_ data: Data) -> String {
        data.base64EncodedString().replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }

    /// FIPS 180-4, as `CryptoKit` is not on Linux.
    static func sha256(_ message: Data) -> Data {
        let k: [UInt32] = [
            0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
            0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
            0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
            0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
            0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
            0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
            0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
            0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
        ]
        var h: [UInt32] = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
                           0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]
        var bytes = [UInt8](message)
        let bits = UInt64(bytes.count) * 8
        bytes.append(0x80)
        while bytes.count % 64 != 56 { bytes.append(0) }
        for i in (0..<8).reversed() { bytes.append(UInt8(truncatingIfNeeded: bits >> (UInt64(i) * 8))) }
        func rotr(_ x: UInt32, _ n: UInt32) -> UInt32 { (x >> n) | (x << (32 - n)) }
        var w = [UInt32](repeating: 0, count: 64)
        for chunk in stride(from: 0, to: bytes.count, by: 64) {
            for i in 0..<16 {
                w[i] = (0..<4).reduce(0) { $0 << 8 | UInt32(bytes[chunk + i * 4 + $1]) }
            }
            for i in 16..<64 {
                let s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >> 3)
                let s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >> 10)
                w[i] = w[i - 16] &+ s0 &+ w[i - 7] &+ s1
            }
            var (a, b, c, d, e, f, g, hh) = (h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7])
            for i in 0..<64 {
                let t1 = hh &+ (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) &+ ((e & f) ^ (~e & g)) &+ k[i] &+ w[i]
                let t2 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) &+ ((a & b) ^ (a & c) ^ (b & c))
                (hh, g, f, e, d, c, b, a) = (g, f, e, d &+ t1, c, b, a, t1 &+ t2)
            }
            for (i, v) in [a, b, c, d, e, f, g, hh].enumerated() { h[i] = h[i] &+ v }
        }
        return Data(h.flatMap { v in (0..<4).map { UInt8(truncatingIfNeeded: v >> (24 - $0 * 8)) } })
    }

    // MARK: - The loopback port

    /// A listening socket on 127.0.0.1, closed with it.
    final class Listener {
        struct Call {
            let target: String
            let fd: Int32

            /// The page the browser shows, after which the connection is closed.
            func answer(_ status: Int, _ text: String) {
                let escaped = text.replacingOccurrences(of: "&", with: "&amp;")
                    .replacingOccurrences(of: "<", with: "&lt;").replacingOccurrences(of: ">", with: "&gt;")
                let body = Data("<!doctype html><meta charset=utf-8><title>Diplomat</title><p>\(escaped)</p>\n".utf8)
                let reason = [200: "OK", 400: "Bad Request", 404: "Not Found"][status] ?? "Error"
                let head = "HTTP/1.1 \(status) \(reason)\r\nContent-Type: text/html; charset=utf-8\r\n"
                    + "Content-Length: \(body.count)\r\nConnection: close\r\n\r\n"
                let all = Data(head.utf8) + body
#if canImport(Glibc)
                _ = all.withUnsafeBytes { send(fd, $0.baseAddress, $0.count, Int32(MSG_NOSIGNAL)) }
#else
                _ = all.withUnsafeBytes { write(fd, $0.baseAddress, $0.count) }
#endif
                close(fd)
            }
        }

        let fd: Int32
        let port: UInt16

        init?(port: UInt16) {
#if canImport(Glibc)
            let fd = socket(AF_INET, Int32(SOCK_STREAM.rawValue), 0)
#else
            let fd = socket(AF_INET, SOCK_STREAM, 0)
#endif
            guard fd >= 0 else { return nil }
            // Rebinds past the last sign-in's connections in TIME_WAIT; never past a listener.
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
                $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                    bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
                }
            }
            guard bound == 0, listen(fd, 8) == 0 else {
                close(fd)
                return nil
            }
            self.fd = fd
            self.port = port
        }

        deinit { close(fd) }

        /// The next GET's target, its connection left open for `answer`; nil once `deadline`
        /// passes or `cancelled` answers true, which is asked every quarter second.
        func next(until deadline: Date, cancelled: () -> Bool) -> Call? {
            while !cancelled() {
                let left = deadline.timeIntervalSinceNow
                guard left > 0 else { return nil }
                var p = pollfd(fd: fd, events: Int16(POLLIN), revents: 0)
                guard poll(&p, 1, Int32(min(left, 0.25) * 1000) + 1) > 0 else { continue }
                let client = accept(fd, nil, nil)
                guard client >= 0 else { continue }
                // A browser's speculative connection, which may send nothing, holds the wait
                // up no longer.
                var tv = timeval(tv_sec: 2, tv_usec: 0)
                setsockopt(client, SOL_SOCKET, SO_RCVTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))
#if canImport(Darwin)
                var one: Int32 = 1
                setsockopt(client, SOL_SOCKET, SO_NOSIGPIPE, &one, socklen_t(MemoryLayout<Int32>.size))
#endif
                var head = Data()
                var chunk = [UInt8](repeating: 0, count: 4096)
                while head.count < 16384, head.range(of: Data("\r\n\r\n".utf8)) == nil {
                    let n = read(client, &chunk, chunk.count)
                    guard n > 0 else { break }
                    head.append(contentsOf: chunk[0..<n])
                }
                let line = String(decoding: head, as: UTF8.self).components(separatedBy: "\r\n")[0]
                let parts = line.split(separator: " ")
                guard parts.count == 3, parts[0] == "GET" else {
                    close(client)
                    continue
                }
                return Call(target: String(parts[1]), fd: client)
            }
            return nil
        }
    }
}
