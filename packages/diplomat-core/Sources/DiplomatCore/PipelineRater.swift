import Foundation

/// The rating and fracture calls: one `claude -p` each, sandboxed as `CommsClassifier`'s
/// triage call but for read-only tools, run in the root's checkout. The untrusted item
/// text and diff arrive on stdin, defanged and fenced; the instructions are the argument.
enum PipelineRater {
    static let fence = "UNTRUSTED TRACKER TEXT"

    static let tools = "Read,Grep,Glob"

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

    static func input(_ e: PipelineEntry, diff: String?, _ model: CoreAssets.PipelineModel) -> String {
        var text = e.item.title + "\n\n" + clip(e.body, model.rater.bodyChars)
        if let diff { text += "\n\nDIFF:\n" + clip(diff, model.rater.diffChars) }
        return CommsText.fillFenced("BEGIN \(fence)\n{text}\nEND \(fence)",
                                    ["text": CommsText.defang(text, marker: fence)], marker: fence)
    }

    static func clip(_ s: String, _ n: Int) -> String {
        s.count > n ? String(s.prefix(n)) + "\n[cut at \(n) characters]" : s
    }

    private static let references = try! NSRegularExpression(
        pattern: #"(@)(?=[A-Za-z0-9])|(#)(?=\d)|\b(GH-)(?=\d)|(github)(?=\.com/)"#, options: [.caseInsensitive])

    /// Mentions, issue references and GitHub links broken with a zero-width space: filed
    /// under the operator's account, the text notifies no one and links nothing.
    static func inert(_ text: String) -> String {
        references.stringByReplacingMatches(in: text, range: NSRange(location: 0, length: (text as NSString).length),
                                            withTemplate: "$1$2$3$4\u{200B}")
    }

    /// Without HTML comments (an unclosed one to the end, as GitHub hides it) or
    /// `cleanMarker` before a sha, so model-written text forges no Diplomat marker. Loops,
    /// as a cut can join two halves into a new match.
    static func unmarked(_ text: String, cleanMarker: String) -> String {
        let pattern = #"<!--[\s\S]*?(?:-->|\z)|"# + NSRegularExpression.escapedPattern(for: cleanMarker)
            + #"\s+[0-9a-f]{7,}"#
        var s = text
        while let r = s.range(of: pattern, options: [.regularExpression, .caseInsensitive]) { s.removeSubrange(r) }
        return s
    }

    /// No `--allowedTools`: it would let the tools read any path, while unlisted, `-p`
    /// refuses them every path outside the checkout, having no one to ask.
    /// `--setting-sources ""` keeps the checkout's settings from allowing more.
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

    static func rating(_ exit: PipelineIO.Exit) -> Result<(PipelineRating, String), PipelineIO.Failure> {
        answer(exit, key: "risk").flatMap { o in
            guard let risk = (o["risk"] as? String).flatMap(PipelineLevel.init(rawValue:)),
                  let complexity = (o["complexity"] as? String).flatMap(PipelineLevel.init(rawValue:))
            else { return .failure(.init("the rater's answer named no risk and complexity")) }
            return .success((PipelineRating(risk: risk, complexity: complexity),
                             CommsText.oneLine(o["why"] as? String ?? "")))
        }
    }

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
