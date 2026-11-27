import Foundation

/// `dir` holds `log.jsonl` (a `rerated` event also proves a `cleared` label is this
/// Diplomat's own), `last.json`, `ratings.json`, `state.json`, `control.json` and the locks
/// `log.lock` and `tick.lock`: directories 0700, files 0600.
public enum PipelineLog {
    public static var dir: URL {
        if let env = ProcessInfo.processInfo.environment["DIPLOMAT_PIPELINE_DIR"], !env.isEmpty {
            return URL(fileURLWithPath: env, isDirectory: true)
        }
        return PrivateFiles.home.appendingPathComponent(".diplomat/pipeline", isDirectory: true)
    }

    static func logURL(in dir: URL) -> URL { dir.appendingPathComponent("log.jsonl") }
    static func lastURL(in dir: URL) -> URL { dir.appendingPathComponent("last.json") }

    /// The last sync's result; nil before the first or when unreadable.
    public static func last(in dir: URL = dir) -> PipelineTickResult? {
        guard let data = try? Data(contentsOf: lastURL(in: dir)) else { return nil }
        return try? CommsLog.decoder.decode(PipelineTickResult.self, from: data)
    }

    static func writeLast(_ result: PipelineTickResult, in dir: URL) {
        guard let data = try? CommsLog.encoder.encode(result) else { return }
        PrivateFiles.prepare(dir)
        PrivateFiles.writeWhole(data, to: lastURL(in: dir))
    }

    /// Past `maxLogBytes` the file keeps its newest whole lines.
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
/// logged once is not taken or logged again.
///
/// An item missing from a read keeps its entries, which guard outward steps: they go once it
/// is read merged or closed, or after `forgetDays` unseen. `takenOver` and the log-only `holds`,
/// `clean` and `asked` also go with an item missing from a read of every source.
struct PipelineState: Codable, Equatable {
    static let forgetDays: Double = 90

    /// Per `owner/repo`, the labels known to exist there.
    var labelsMade: [String: [String]] = [:]
    /// PRs Diplomat took off the fast track until taken over. Only a cache: the labels say it.
    var decided: [String] = []
    /// The items the operator took over, and what each is.
    var takenOver: [String: PipelineKind] = [:]
    /// PRs the fast-track label could not be put on at their first rating.
    var untracked: [String] = []
    /// Issues that would not split, or whose split stopped part-way, and why: not tried
    /// again unless forced.
    var unsplit: [String: String] = [:]
    /// Per issue claimed for a split that has not finished, the parts filed so far.
    var splitting: [String: [String]] = [:]
    /// Per issue being split, the parts the model answered, filed from here.
    var parts: [String: PipelineParts] = [:]
    /// Per PR, each head Diplomat rated it again at, and that rating.
    var rerated: [String: [String: PipelineRating]] = [:]
    /// Per PR, the head Diplomat put `cleared` on at, until Diplomat takes it off.
    var cleared: [String: String] = [:]
    /// Per PR, `"<head> <flag>"` of a merge asked of gh, until a read after it tells how it
    /// ended: kept past its PR's read as merged.
    var merging: [String: String] = [:]
    /// Per item, its failed ratings or splits: not tried again unforced before `after`.
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
    /// Per item, the rating asked of a queued job and not yet applied.
    var rateAsks: [String: PipelineRateAsk] = [:]
    /// The last rating ask's stamp.
    var rateSeq = 0
    /// Items whose queued rating the operator cancelled: not asked again unless forced.
    var declined: [String] = []
    /// The last sync's notices, so each is logged as an `error` once.
    var notices: [String] = []

    init() {}

    private enum CodingKeys: String, CodingKey {
        case merging
        case labelsMade, decided, takenOver, untracked, unsplit, splitting, parts, rerated, cleared, retry, syncs,
             lineage, seen, holds, clean, asked, rateAsks, rateSeq, declined, notices
    }

    /// A field missing is empty; one there but not of its type fails the whole file.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        labelsMade = try c.decodeIfPresent([String: [String]].self, forKey: .labelsMade) ?? [:]
        decided = try c.decodeIfPresent([String].self, forKey: .decided) ?? []
        takenOver = try c.decodeIfPresent([String: PipelineKind].self, forKey: .takenOver) ?? [:]
        untracked = try c.decodeIfPresent([String].self, forKey: .untracked) ?? []
        unsplit = try c.decodeIfPresent([String: String].self, forKey: .unsplit) ?? [:]
        splitting = try c.decodeIfPresent([String: [String]].self, forKey: .splitting) ?? [:]
        parts = try c.decodeIfPresent([String: PipelineParts].self, forKey: .parts) ?? [:]
        rerated = try c.decodeIfPresent([String: [String: PipelineRating]].self, forKey: .rerated) ?? [:]
        cleared = try c.decodeIfPresent([String: String].self, forKey: .cleared) ?? [:]
        merging = try c.decodeIfPresent([String: String].self, forKey: .merging) ?? [:]
        retry = try c.decodeIfPresent([String: PipelineRetry].self, forKey: .retry) ?? [:]
        syncs = try c.decodeIfPresent(Int.self, forKey: .syncs) ?? 0
        lineage = try c.decodeIfPresent([String: String].self, forKey: .lineage) ?? [:]
        seen = try c.decodeIfPresent([String: Date].self, forKey: .seen) ?? [:]
        holds = try c.decodeIfPresent([String: String].self, forKey: .holds) ?? [:]
        clean = try c.decodeIfPresent([String: String].self, forKey: .clean) ?? [:]
        asked = try c.decodeIfPresent([String: String].self, forKey: .asked) ?? [:]
        rateAsks = try c.decodeIfPresent([String: PipelineRateAsk].self, forKey: .rateAsks) ?? [:]
        rateSeq = try c.decodeIfPresent(Int.self, forKey: .rateSeq) ?? 0
        declined = try c.decodeIfPresent([String].self, forKey: .declined) ?? []
        notices = try c.decodeIfPresent([String].self, forKey: .notices) ?? []
    }

    static func url(in dir: URL) -> URL { dir.appendingPathComponent("state.json") }

    /// A missing file is a first sync; one that does not decode is a failure, never an
    /// empty state, which would forget every guard.
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

    mutating func prune(read: Set<String>, done: Set<String>, readAll: Bool, now: Date) {
        for id in read { seen[id] = now }
        let cutoff = now.addingTimeInterval(-Self.forgetDays * 86_400)
        seen = seen.filter { !done.contains($0.key) && $0.value >= cutoff }
        func live(_ id: String) -> Bool { seen[id] != nil }
        decided.removeAll { !live($0) }
        untracked.removeAll { !live($0) }
        unsplit = unsplit.filter { live($0.key) }
        splitting = splitting.filter { live($0.key) }
        parts = parts.filter { live($0.key) }
        rerated = rerated.filter { live($0.key) }
        cleared = cleared.filter { live($0.key) }
        merging = merging.filter { live($0.key) || read.contains($0.key) }
        retry = retry.filter { live($0.key) }
        lineage = lineage.filter { live($0.key) }
        rateAsks = rateAsks.filter { live($0.key) }
        declined.removeAll { !live($0) }
        func keep(_ id: String) -> Bool { live(id) && (!readAll || read.contains(id)) }
        takenOver = takenOver.filter { keep($0.key) }
        holds = holds.filter { keep($0.key) }
        clean = clean.filter { keep($0.key) }
        // An effect key is `<kind>:<item id>`.
        asked = asked.filter { key, _ in key.split(separator: ":", maxSplits: 1).last.map { keep(String($0)) } ?? false }
    }
}

struct PipelineParts: Codable, Equatable {
    struct Part: Codable, Equatable {
        var title: String
        var body: String
    }

    var parts: [Part]
    var why: String
    var forced: Bool
    /// When the model answered, which its parts' markers name.
    var at: String?
    /// Whether a part's create may have made it unrecorded.
    var sent: Bool?
}

/// An item's ratings, rating labels or splits failed in a row: the next is tried at sync
/// `after`, 1, 2, 4 ... syncs on, and a day after `at` at the latest.
struct PipelineRetry: Codable, Equatable {
    var failures: Int
    var after: Int
    var at: Date
}

/// The rating Diplomat made of an item, by its id: the item's rating, which labels can only
/// raise. Forgotten with the item's `PipelineState.seen`.
struct PipelineCachedRating: Codable, Equatable {
    var rating: PipelineRating
    var why: String
    /// What the rating leads to, its labels where mirrored and the fast-track label, waits for
    /// a sync that reads the item again.
    var pending: Bool?
    /// A PR's first rating: none was kept for it before, and its timeline, read again before
    /// what the rating leads to, showed no rating or fast-track label.
    var first: Bool?

    static func url(in dir: URL) -> URL { dir.appendingPathComponent("ratings.json") }

    /// Like `PipelineState.load`: a missing file is empty, one that does not decode a
    /// failure, since an empty cache would forget every rating.
    static func load(in dir: URL) -> Result<[String: PipelineCachedRating], PipelineIO.Failure> {
        let url = url(in: dir)
        guard FileManager.default.fileExists(atPath: url.path) else { return .success([:]) }
        do {
            return .success(try CommsLog.decoder.decode([String: PipelineCachedRating].self, from: Data(contentsOf: url)))
        } catch {
            return .failure(.init("\(url.path) could not be read (\(error.localizedDescription))"))
        }
    }

    static func save(_ cache: [String: PipelineCachedRating], in dir: URL) {
        guard let data = try? CommsLog.encoder.encode(cache) else { return }
        PrivateFiles.prepare(dir)
        PrivateFiles.writeWhole(data, to: url(in: dir))
    }
}

extension PipelineControl {
    static func url(in dir: URL) -> URL { dir.appendingPathComponent("control.json") }

    /// nil when `control.json` is missing or does not hold every switch as a boolean.
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
