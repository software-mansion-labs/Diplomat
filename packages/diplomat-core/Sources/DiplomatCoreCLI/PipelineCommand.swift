import DiplomatCore
import Foundation

/// The Linux front-end's whole reach into the pipeline, so it has one implementation.
///
///   pipeline-tick  stdin = PipelineSettings JSON. One sync (`PipelineTick.run`) with the
///                  real gh, claude and Linear; stdout = the PipelineTickResult. Exits 0
///                  with what failed in `notices` (a failed read is an answer), 1 when
///                  stdin is not settings or stdout cannot be written.
///   pipeline-last  no stdin. stdout = the last sync's PipelineTickResult, or an empty one
///                  dated 1970-01-01 before the first.
///   pipeline-teams stdin = `{"raw": <the Linear teams setting>}`. stdout = `{"teams":
///                  [{"key", "repo"}], "bad": [entry]}` (`PipelineSettings.LinearTeam.parse`),
///                  so the Linux twin of the parse is tested against this one.
///   linear-login   no stdin. `LinearLogin.signIn`, its page opened with `$BROWSER`, else
///                  `xdg-open` (`open` on macOS), and printed on stderr; stdout = {"ok":
///                  true, "user", "organization"} or {"ok": false, "error"}. Exits 0 either
///                  way; killing it abandons the sign-in.
///   linear-logout  no stdin. `LinearLogin.signOut`; stdout = {"ok": true, "warning":
///                  <why Linear did not revoke it>|null} or {"ok": false, "error"}.
///   linear-whoami  no stdin. stdout = {"user", "organization"} of the saved login, or {}.
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

    static func teams(_ obj: [String: Any]) {
        struct Answer: Encodable {
            let teams: [PipelineSettings.LinearTeam]
            let bad: [String]
        }
        let parsed = PipelineSettings.LinearTeam.parse(obj["raw"] as? String ?? "")
        emitJSON(Answer(teams: parsed.teams, bad: parsed.bad))
    }

    static func login() {
        let answer: [String: Any]
        do {
            let me = try LinearLogin.signIn(open: openBrowser)
            answer = ["ok": true, "user": me.user, "organization": me.organization]
        } catch {
            answer = ["ok": false, "error": error.localizedDescription]
        }
        emitObject(answer)
    }

    static func logout() {
        do {
            emitObject(["ok": true, "warning": try LinearLogin.signOut() ?? NSNull()])
        } catch {
            emitObject(["ok": false, "error": error.localizedDescription])
        }
    }

    static func whoami() {
        emitObject(LinearLogin.saved().map { ["user": $0.user, "organization": $0.organization] } ?? [:])
    }

    /// Launched, and not seen failing within ten seconds; a browser that stays up is left running.
    private static func openBrowser(_ url: URL) -> Bool {
        try? FileHandle.standardError.write(contentsOf: Data("Sign in to Linear: \(url.absoluteString)\n".utf8))
        let browser = ProcessInfo.processInfo.environment["BROWSER"] ?? ""
#if os(macOS)
        let fallback = "/usr/bin/open"
#else
        let fallback = "xdg-open"
#endif
        let name = browser.isEmpty ? fallback : browser
        guard let path = name.hasPrefix("/") ? name : LoginShell.onPath(name) else { return false }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: path)
        p.arguments = [url.absoluteString]
        p.standardInput = FileHandle.nullDevice
        p.standardOutput = FileHandle.nullDevice
        p.standardError = FileHandle.nullDevice
        do { try p.run() } catch { return false }
        let until = Date().addingTimeInterval(10)
        while p.isRunning && Date() < until { usleep(50_000) }
        return p.isRunning || p.terminationStatus == 0
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
