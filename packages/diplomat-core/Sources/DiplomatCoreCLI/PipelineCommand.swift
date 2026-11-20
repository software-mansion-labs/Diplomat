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
