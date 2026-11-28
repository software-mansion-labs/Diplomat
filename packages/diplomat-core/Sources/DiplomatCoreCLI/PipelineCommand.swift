import DiplomatCore
import Foundation

/// Set by `linear-login`'s SIGTERM.
private var linearLoginTerminated: sig_atomic_t = 0

/// The Linux front-end's whole reach into the pipeline, so it has one implementation.
///
///   pipeline-tick  stdin = PipelineSettings JSON. One sync (`PipelineTick.run`) with the
///                  real gh, claude and Linear; stdout = the PipelineTickResult. Exits 0
///                  with what failed in `notices` (a failed read is an answer), 1 when
///                  stdin is not settings or stdout cannot be written.
///   pipeline-last  no stdin. stdout = the last sync's PipelineTickResult, or an empty one
///                  dated 1970-01-01 before the first.
///   pipeline-rate  stdin = `{"item", "stamp", "cancel"?}`: a rating effect's `url` and
///                  `stamp`. `PipelineRateJob.run`, or with `cancel` true
///                  `PipelineRateJob.cancel`; stdout = `{"outcome": "rated" | "failed" |
///                  "answered" | "superseded" | "cancelled", "detail"}`. Exits 0 either
///                  way, 1 when stdin names no item and stamp.
///   pipeline-teams stdin = `{"raw": <the Linear teams setting>}`. stdout = `{"teams":
///                  [{"key", "repo"}], "bad": [entry]}` (`PipelineSettings.LinearTeam.parse`),
///                  so the Linux twin of the parse is tested against this one.
///   linear-login   no stdin. `LinearLogin.signIn` through Linear's MCP server; stdout =
///                  {"url": <its consent page, for the caller to open>} once listening,
///                  then {"ok": true, "user", "organization"} or {"ok": false, "error"}.
///                  Exits 0 either way. SIGTERM, or its parent's exit, cancels a sign-in
///                  still waiting for the browser; one past it ends as it would have.
///   linear-login-key stdin = {"key": <a personal API key>}. `LinearLogin.signIn(key:)`;
///                  stdout = {"ok": true, "user", "organization"} or {"ok": false, "error"}.
///   linear-logout  no stdin. `LinearLogin.signOut`; stdout = {"ok": true, "warning":
///                  <why Linear did not revoke it>|null} or {"ok": false, "error"}.
///   linear-whoami  no stdin. stdout = {"user", "organization", "method": "key"|"mcp"} of
///                  the saved login, or {}.
///
/// Dates are ISO 8601 and keys sorted, as `CommsLog.encoder` writes them. Both read and
/// write `$DIPLOMAT_PIPELINE_DIR` (default `~/.diplomat/pipeline`); `DIPLOMAT_GH`,
/// `DIPLOMAT_CLAUDE`, `DIPLOMAT_LINEAR_API` and `DIPLOMAT_LINEAR_TOKEN` override what the
/// sync reaches.
enum PipelineCommand {
    static func tick(_ input: Data) {
        let settings: PipelineSettings
        do { settings = try CommsLog.decoder.decode(PipelineSettings.self, from: input) } catch {
            die("stdin is not a PipelineSettings: \(error)", 1)
        }
        let result = PipelineTick.run(settings: settings)
        // Past the sync's last child, which would inherit it: a gone reader is then an
        // error, not a signal.
        signal(SIGPIPE, SIG_IGN)
        emitJSON(result)
    }

    static func rate(_ obj: [String: Any]) {
        guard let item = obj["item"] as? String, let stamp = obj["stamp"] as? String else {
            die("stdin names no item and stamp", 1)
        }
        if (obj["cancel"] as? JSONInput.Flag)?.on == true {
            let done = PipelineRateJob.cancel(item: item, stamp: stamp)
            return emitObject(["outcome": done ? "cancelled" : "superseded", "detail": ""])
        }
        signal(SIGPIPE, SIG_IGN)
        let (outcome, detail): (String, String)
        switch PipelineRateJob.run(item: item, stamp: stamp) {
        case .rated(let r): (outcome, detail) = ("rated", r)
        case .failed(let why): (outcome, detail) = ("failed", why)
        case .answered: (outcome, detail) = ("answered", "")
        case .superseded: (outcome, detail) = ("superseded", "")
        }
        emitObject(["outcome": outcome, "detail": detail])
    }

    static func teams(_ obj: [String: Any]) {
        struct Answer: Encodable {
            let teams: [PipelineSettings.LinearTeam]
            let bad: [String]
        }
        let parsed = PipelineSettings.LinearTeam.parse(obj["raw"] as? String ?? "")
        emitJSON(Answer(teams: parsed.teams, bad: parsed.bad))
    }

    static func login() {
        let parent = getppid()
        signal(SIGTERM) { _ in linearLoginTerminated = 1 }
        let answer: [String: Any]
        do {
            let me = try LinearLogin.signIn(open: { emitObject(["url": $0.absoluteString]) },
                                            cancelled: { linearLoginTerminated != 0 || getppid() != parent })
            answer = ["ok": true, "user": me.user, "organization": me.organization]
        } catch {
            answer = ["ok": false, "error": error.localizedDescription]
        }
        emitObject(answer)
    }

    static func loginKey(_ obj: [String: Any]) {
        do {
            let me = try LinearLogin.signIn(key: obj["key"] as? String ?? "")
            emitObject(["ok": true, "user": me.user, "organization": me.organization])
        } catch {
            emitObject(["ok": false, "error": error.localizedDescription])
        }
    }

    static func logout() {
        do {
            emitObject(["ok": true, "warning": try LinearLogin.signOut() ?? NSNull()])
        } catch {
            emitObject(["ok": false, "error": error.localizedDescription])
        }
    }

    static func whoami() {
        emitObject(LinearLogin.saved().map {
            ["user": $0.user, "organization": $0.organization, "method": $0.method.rawValue]
        } ?? [:])
    }

    private static func emitObject(_ answer: [String: Any]) {
        guard var data = try? JSONSerialization.data(withJSONObject: answer, options: [.sortedKeys]) else {
            die("could not encode the answer", 1)
        }
        data.append(UInt8(ascii: "\n"))
        emit(data)
    }

    static func last() {
        emitJSON(PipelineLog.last() ?? PipelineTickResult(at: Date(timeIntervalSince1970: 0)))
    }

    private static func emitJSON<T: Encodable>(_ value: T) {
        guard var data = try? CommsLog.encoder.encode(value) else {
            die("could not encode the answer", 1)
        }
        data.append(UInt8(ascii: "\n"))
        emit(data)
    }
}
