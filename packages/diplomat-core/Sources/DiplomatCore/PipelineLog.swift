import Foundation

/// `dir` holds `log.jsonl` (every `PipelineEvent`; a `rerated` one is also the proof a
/// `cleared` label is this Diplomat's own), `last.json` (the last sync's result),
/// `ratings.json`, `state.json` (the guards against repeating a step), `control.json`
/// (the front-end's switches, `PipelineControl`), and the locks `log.lock` and
/// `tick.lock`: directories 0700, files 0600.
public enum PipelineLog {
    public static var dir: URL {
        if let env = ProcessInfo.processInfo.environment["DIPLOMAT_PIPELINE_DIR"], !env.isEmpty {
            return URL(fileURLWithPath: env, isDirectory: true)
        }
        return PrivateFiles.home.appendingPathComponent(".diplomat/pipeline", isDirectory: true)
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
///
/// `decided`, `unsplit`, `rerated`, `cleared`, `retry` and `lineage` guard against
/// repeating an outward step, so an item missing from a read keeps them: they go once it
/// is read merged or closed, or after `forgetDays` unseen. The rest only keeps the log
/// from repeating itself, and also goes with an item missing from a read of every source.
struct PipelineState: Codable, Equatable {
    static let forgetDays: Double = 90

    /// Per repository (`owner/repo`), the labels known to exist there.
    var labelsMade: [String: [String]] = [:]
    /// PRs Diplomat took off the fast track for good. Only a cache: the labels say it.
    var decided: [String] = []
    /// Issues that would not split, or whose split stopped part-way, and why: not tried
    /// again unless forced.
    var unsplit: [String: String] = [:]
    /// Per PR, each head Diplomat rated it again at, and that rating.
    var rerated: [String: [String: PipelineRating]] = [:]
    /// Per PR, the head Diplomat put `cleared` on at, until Diplomat takes it off.
    var cleared: [String: String] = [:]
    /// Per item, its ratings or splits that failed: not tried again unforced before then.
    var retry: [String: PipelineRetry] = [:]
    /// Syncs run, the clock `retry` counts in.
    var syncs = 0
    /// Per issue Diplomat filed as a split's part, the ban its text carries: its parent's.
    var lineage: [String: String] = [:]
    /// When each item was last read, or filed by Diplomat.
    var seen: [String: Date] = [:]
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
        case labelsMade, decided, unsplit, rerated, cleared, retry, syncs, lineage, seen, holds, clean, asked, notices
    }

    /// A field missing is empty; one there but not of its type fails the whole file.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        labelsMade = try c.decodeIfPresent([String: [String]].self, forKey: .labelsMade) ?? [:]
        decided = try c.decodeIfPresent([String].self, forKey: .decided) ?? []
        unsplit = try c.decodeIfPresent([String: String].self, forKey: .unsplit) ?? [:]
        rerated = try c.decodeIfPresent([String: [String: PipelineRating]].self, forKey: .rerated) ?? [:]
        cleared = try c.decodeIfPresent([String: String].self, forKey: .cleared) ?? [:]
        retry = try c.decodeIfPresent([String: PipelineRetry].self, forKey: .retry) ?? [:]
        syncs = try c.decodeIfPresent(Int.self, forKey: .syncs) ?? 0
        lineage = try c.decodeIfPresent([String: String].self, forKey: .lineage) ?? [:]
        seen = try c.decodeIfPresent([String: Date].self, forKey: .seen) ?? [:]
        holds = try c.decodeIfPresent([String: String].self, forKey: .holds) ?? [:]
        clean = try c.decodeIfPresent([String: String].self, forKey: .clean) ?? [:]
        asked = try c.decodeIfPresent([String: String].self, forKey: .asked) ?? [:]
        notices = try c.decodeIfPresent([String].self, forKey: .notices) ?? []
    }

    static func url(in dir: URL) -> URL { dir.appendingPathComponent("state.json") }

    /// A missing file reads as a first sync. One that is there but does not decode is a
    /// failure, never an empty state: that would forget every guard in it.
    static func load(in dir: URL) -> Result<PipelineState, PipelineIO.Failure> {
        let url = url(in: dir)
        guard FileManager.default.fileExists(atPath: url.path) else { return .success(PipelineState()) }
        do {
            return .success(try CommsLog.decoder.decode(PipelineState.self, from: Data(contentsOf: url)))
        } catch {
            return .failure(.init("\(url.path) could not be read (\(error.localizedDescription))"))
        }
    }

    func save(in dir: URL) {
        guard let data = try? CommsLog.encoder.encode(self) else { return }
        PrivateFiles.prepare(dir)
        PrivateFiles.writeWhole(data, to: Self.url(in: dir))
    }

    /// Marks `read` seen at `now`, then forgets everything about an item read merged or
    /// closed (`done`) or unseen for `forgetDays`; with `readAll`, also the log-once
    /// entries of an item missing from the read.
    mutating func prune(read: Set<String>, done: Set<String>, readAll: Bool, now: Date) {
        for id in read { seen[id] = now }
        let cutoff = now.addingTimeInterval(-Self.forgetDays * 86_400)
        seen = seen.filter { !done.contains($0.key) && $0.value >= cutoff }
        func live(_ id: String) -> Bool { seen[id] != nil }
        decided.removeAll { !live($0) }
        unsplit = unsplit.filter { live($0.key) }
        rerated = rerated.filter { live($0.key) }
        cleared = cleared.filter { live($0.key) }
        retry = retry.filter { live($0.key) }
        lineage = lineage.filter { live($0.key) }
        func keep(_ id: String) -> Bool { live(id) && (!readAll || read.contains(id)) }
        holds = holds.filter { keep($0.key) }
        clean = clean.filter { keep($0.key) }
        // An effect key is `<kind>:<item id>`.
        asked = asked.filter { key, _ in key.split(separator: ":", maxSplits: 1).last.map { keep(String($0)) } ?? false }
    }
}

/// An item's ratings or splits failed in a row, and when the last did: the next is tried
/// at sync `after`, 1, 2, 4 ... syncs on, and a day on at the latest.
struct PipelineRetry: Codable, Equatable {
    var failures: Int
    var after: Int
    var at: Date
}

/// A rating Diplomat made, by item id: the rating itself for an item it may not label,
/// read back while the item's `updatedAt` is unchanged, or for one whose rating labels
/// the tracker refused (`unwritten`), until it wears a rating; for one it labelled, only
/// the why. Forgotten with the item's `PipelineState.seen`.
struct PipelineCachedRating: Codable, Equatable {
    var rating: PipelineRating
    var why: String
    var updatedAt: Date?
    var unwritten: Bool?

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

extension PipelineControl {
    static func url(in dir: URL) -> URL { dir.appendingPathComponent("control.json") }

    /// `control.json` in `dir`; nil when it is missing or does not hold all six switches
    /// as booleans.
    public static func read(in dir: URL = PipelineLog.dir) -> PipelineControl? {
        guard let data = try? Data(contentsOf: url(in: dir)) else { return nil }
        return try? JSONDecoder().decode(PipelineControl.self, from: data)
    }

    /// Owner-only, replaced whole.
    @discardableResult
    public func save(in dir: URL = PipelineLog.dir) -> Bool {
        let enc = JSONEncoder()
        enc.outputFormatting = [.sortedKeys]
        guard let data = try? enc.encode(self) else { return false }
        PrivateFiles.prepare(dir)
        return PrivateFiles.writeWhole(data, to: Self.url(in: dir))
    }
}
