import Foundation

/// The pipeline's two model calls, rating and fracture: one `claude -p` each, answering a
/// fixed schema, sandboxed as `CommsClassifier`'s triage call is but for the read-only
/// tools it needs to read the code, run in the root's checkout.
///
/// The item's text and a PR's diff are untrusted, so they arrive on stdin, defanged and
/// quoted between fence lines (`CommsText.fillFenced`); the instructions are the argument.
enum PipelineRater {
    /// The fence the item's text is quoted in, on stdin and in a Linear fix's prompt.
    static let fence = "UNTRUSTED TRACKER TEXT"

    static let tools = "Read,Grep,Glob"

    /// The placeholders every instruction shares: the level definitions, filled from the
    /// floor's limits.
    static func values(_ model: CoreAssets.PipelineModel) -> [String: String] {
        let limits = ["maxSourceFiles": String(model.floor.maxSourceFiles),
                      "maxSourceLines": String(model.floor.maxSourceLines),
                      "maxChildren": String(model.fracture.maxChildren)]
        var out = limits
        for level in PipelineLevel.allCases {
            let name = level.rawValue.prefix(1).uppercased() + level.rawValue.dropFirst()
            out["complexity" + name] = CommsText.fill(model.levels.complexity[level], limits)
            out["risk" + name] = CommsText.fill(model.levels.risk[level], limits)
        }
        return out
    }

    /// `owner/repo`, or the Linear team and the repository its code is in.
    static func place(_ e: PipelineEntry) -> String {
        switch e.item.source {
        case .github: return e.item.repo
        case .linear: return "Linear team \(e.item.repo), whose code is \(e.root?.slug ?? "not checked out")"
        }
    }

    static func ratePrompt(_ e: PipelineEntry, _ model: CoreAssets.PipelineModel) -> String {
        var v = values(model)
        v["kind"] = e.item.kind == .pr ? "pull request" : "issue"
        v["where"] = place(e)
        v["it"] = e.item.kind == .pr ? "this pull request makes" : "this issue needs"
        return model.rater.instructions.map { CommsText.fill($0, v) }.joined(separator: "\n\n")
    }

    static func fracturePrompt(_ e: PipelineEntry, _ model: CoreAssets.PipelineModel) -> String {
        var v = values(model)
        v["where"] = place(e)
        return model.fracture.instructions.map { CommsText.fill($0, v) }.joined(separator: "\n\n")
    }

    /// The stdin: the title, the body up to `bodyChars` and, for a PR, its diff up to
    /// `diffChars`, defanged and quoted between the fence lines.
    static func input(_ e: PipelineEntry, diff: String?, _ model: CoreAssets.PipelineModel) -> String {
        var text = e.item.title + "\n\n" + clip(e.body, model.rater.bodyChars)
        if let diff { text += "\n\nDIFF:\n" + clip(diff, model.rater.diffChars) }
        return CommsText.fillFenced("BEGIN \(fence)\n{text}\nEND \(fence)",
                                    ["text": CommsText.defang(text, marker: fence)], marker: fence)
    }

    static func clip(_ s: String, _ n: Int) -> String {
        s.count > n ? String(s.prefix(n)) + "\n[cut at \(n) characters]" : s
    }

    /// No `--allowedTools`: it would let the tools read any path. Unlisted, `-p` refuses
    /// them every path outside the checkout, as there is no one to grant it, and
    /// `--setting-sources ""` keeps the checkout's own settings from allowing more.
    static func arguments(model name: String, schema: String, prompt: String) -> [String] {
        ["-p", "--model", name,
         "--tools", tools,
         "--strict-mcp-config",
         "--disable-slash-commands",
         "--setting-sources", "",
         "--no-session-persistence",
         "--output-format", "json",
         "--json-schema", schema,
         prompt]
    }

    /// The answer object of one call, or why there is none.
    static func answer(_ exit: PipelineIO.Exit, key: String) -> Result<[String: Any], PipelineIO.Failure> {
        switch CommsDecision.answerObject(in: exit.stdout, key: key) {
        case .object(let o?)?:
            return .success(o)
        case .failed(let d)?:
            return .failure(.init(String(d.reason.dropFirst(CommsClassifier.failurePrefix.count))))
        case .object(nil)?, nil:
            let tail = String(exit.stderr.trimmingCharacters(in: .whitespacesAndNewlines).suffix(200))
            return .failure(.init("claude exited \(exit.status) with no answer" + (tail.isEmpty ? "" : ": \(tail)")))
        }
    }

    /// A rating and its one sentence, or why there is none.
    static func rating(_ exit: PipelineIO.Exit) -> Result<(PipelineRating, String), PipelineIO.Failure> {
        answer(exit, key: "risk").flatMap { o in
            guard let risk = (o["risk"] as? String).flatMap(PipelineLevel.init(rawValue:)),
                  let complexity = (o["complexity"] as? String).flatMap(PipelineLevel.init(rawValue:))
            else { return .failure(.init("the rater's answer named no risk and complexity")) }
            return .success((PipelineRating(risk: risk, complexity: complexity),
                             CommsText.oneLine(o["why"] as? String ?? "")))
        }
    }

    /// The parts an issue splits into, at most `maxChildren`, and why; or why there is no
    /// answer.
    static func parts(_ exit: PipelineIO.Exit, max: Int)
        -> Result<(parts: [(title: String, body: String)], why: String), PipelineIO.Failure> {
        answer(exit, key: "parts").flatMap { o in
            guard let list = o["parts"] as? [[String: Any]] else {
                return .failure(.init("the fracture answer held no parts list"))
            }
            let parts = list.compactMap { p -> (String, String)? in
                guard let title = (p["title"] as? String).map(CommsText.oneLine), !title.isEmpty else { return nil }
                return (title, p["body"] as? String ?? "")
            }
            return .success((Array(parts.prefix(max)), CommsText.oneLine(o["why"] as? String ?? "")))
        }
    }
}
