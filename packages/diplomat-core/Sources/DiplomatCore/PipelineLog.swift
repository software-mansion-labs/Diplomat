import Foundation

/// `dir` holds `log.jsonl` (every `PipelineEvent`), `last.json` (the last sync's result),
/// `ratings.json` and `state.json`, and the locks `log.lock` and `tick.lock`: directories
/// 0700, files 0600.
public enum PipelineLog {
    public static var dir: URL {
        if let env = ProcessInfo.processInfo.environment["DIPLOMAT_PIPELINE_DIR"], !env.isEmpty {
            return URL(fileURLWithPath: env, isDirectory: true)
        }
        return FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".diplomat/pipeline", isDirectory: true)
    }

    static func logURL(in dir: URL) -> URL { dir.appendingPathComponent("log.jsonl") }
    static func lastURL(in dir: URL) -> URL { dir.appendingPathComponent("last.json") }

    /// The last sync's result; nil before the first, or when it cannot be read.
    public static func last(in dir: URL = dir) -> PipelineTickResult? {
        guard let data = try? Data(contentsOf: lastURL(in: dir)) else { return nil }
        return try? CommsLog.decoder.decode(PipelineTickResult.self, from: data)
    }

    static func writeLast(_ result: PipelineTickResult, in dir: URL) {
        guard let data = try? CommsLog.encoder.encode(result) else { return }
        PrivateFiles.prepare(dir)
        PrivateFiles.writeWhole(data, to: lastURL(in: dir))
    }

    /// Under `log.lock`; past `maxLogBytes` the file keeps its newest whole lines.
    static func append(_ events: [PipelineEvent], in dir: URL) {
        guard !events.isEmpty else { return }
        var data = Data()
        for event in events {
            guard let line = try? CommsLog.encoder.encode(event) else { continue }
            data.append(line)
            data.append(UInt8(ascii: "\n"))
        }
        let max = (try? CoreAssets.pipeline())?.maxLogBytes ?? 2 << 20
        PrivateFiles.prepare(dir)
        _ = PrivateFiles.locked(dir.appendingPathComponent("log.lock")) {
            PrivateFiles.append(data, to: logURL(in: dir), maxBytes: max)
        }
    }

    /// Oldest first; a torn or foreign line costs only that line.
    static func read(in dir: URL) -> [PipelineEvent] {
        guard let data = try? Data(contentsOf: logURL(in: dir)) else { return [] }
        let d = CommsLog.decoder
        return data.split(separator: UInt8(ascii: "\n")).compactMap {
            try? d.decode(PipelineEvent.self, from: Data($0))
        }
    }
}

/// What a sync remembers between runs besides the trackers' labels, so a step taken or
/// logged once is not taken or logged again. Keyed by item id.
struct PipelineState: Codable, Equatable {
    /// Per repository (`owner/repo`), the labels known to exist there.
    var labelsMade: [String: [String]] = [:]
    /// PRs whose fast-track was decided: labelled, or rated off it. A person taking the
    /// label off is not overruled.
    var decided: [String] = []
    /// Issues that would not split, or whose split failed part-way, and why: not tried
    /// again unless forced.
    var unsplit: [String: String] = [:]
    /// The head and hold code last logged as `held`, `"<head> <code>"`.
    var holds: [String: String] = [:]
    /// The head last logged `clean`.
    var clean: [String: String] = [:]
    /// Per effect key, the stamp last logged `asked`.
    var asked: [String: String] = [:]
    /// The last sync's notices, so each is logged as an `error` once.
    var notices: [String] = []

    init() {}

    private enum CodingKeys: String, CodingKey {
        case labelsMade, decided, unsplit, holds, clean, asked, notices
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        labelsMade = (try? c.decodeIfPresent([String: [String]].self, forKey: .labelsMade)) ?? [:]
        decided = (try? c.decodeIfPresent([String].self, forKey: .decided)) ?? []
        unsplit = (try? c.decodeIfPresent([String: String].self, forKey: .unsplit)) ?? [:]
        holds = (try? c.decodeIfPresent([String: String].self, forKey: .holds)) ?? [:]
        clean = (try? c.decodeIfPresent([String: String].self, forKey: .clean)) ?? [:]
        asked = (try? c.decodeIfPresent([String: String].self, forKey: .asked)) ?? [:]
        notices = (try? c.decodeIfPresent([String].self, forKey: .notices)) ?? []
    }

    static func url(in dir: URL) -> URL { dir.appendingPathComponent("state.json") }

    /// A missing or unreadable file reads as a first sync.
    static func load(in dir: URL) -> PipelineState {
        guard let data = try? Data(contentsOf: url(in: dir)),
              let state = try? JSONDecoder().decode(PipelineState.self, from: data) else {
            return PipelineState()
        }
        return state
    }

    func save(in dir: URL) {
        let enc = JSONEncoder()
        enc.outputFormatting = [.sortedKeys]
        guard let data = try? enc.encode(self) else { return }
        PrivateFiles.prepare(dir)
        PrivateFiles.writeWhole(data, to: Self.url(in: dir))
    }

    /// Drops every entry about an item not in `ids`: run only after a sync that read every
    /// source, so an item a failed read left out keeps its entries.
    mutating func keep(only ids: Set<String>) {
        decided.removeAll { !ids.contains($0) }
        unsplit = unsplit.filter { ids.contains($0.key) }
        holds = holds.filter { ids.contains($0.key) }
        clean = clean.filter { ids.contains($0.key) }
        asked = asked.filter { key, _ in ids.contains { key.hasSuffix(":" + $0) } }
    }
}

/// A rating Diplomat made, by item id: the rating itself for an item it may not label,
/// read back while the item's `updatedAt` is unchanged; for one it labelled, only the why.
struct PipelineCachedRating: Codable, Equatable {
    var rating: PipelineRating
    var why: String
    var updatedAt: Date?

    static func url(in dir: URL) -> URL { dir.appendingPathComponent("ratings.json") }

    static func load(in dir: URL) -> [String: PipelineCachedRating] {
        guard let data = try? Data(contentsOf: url(in: dir)),
              let cache = try? CommsLog.decoder.decode([String: PipelineCachedRating].self, from: data)
        else { return [:] }
        return cache
    }

    static func save(_ cache: [String: PipelineCachedRating], in dir: URL) {
        guard let data = try? CommsLog.encoder.encode(cache) else { return }
        PrivateFiles.prepare(dir)
        PrivateFiles.writeWhole(data, to: url(in: dir))
    }
}
