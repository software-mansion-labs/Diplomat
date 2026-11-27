import Foundation

/// A rating a sync asked for, run as a queued job: the sync writes the call to `rate/`, a
/// front-end runs it when the queue gives it a bay (`run`), and the next sync applies the
/// answer it leaves. Files are named by item and stamp, so a stale run never overwrites a
/// newer ask's answer.
public struct PipelineRateJob: Codable, Equatable, Sendable {
    public var item: String
    public var stamp: String
    var model: String
    var prompt: String
    var input: String
    var cwd: String

    /// What a run did.
    public enum Outcome: Equatable, Sendable {
        /// The rater answered; the rating as the answer gave it.
        case rated(String)
        case failed(String)
        /// An answer for this stamp was there already.
        case answered
        /// No job for this stamp: the sync no longer asks for it.
        case superseded
    }

    static func folder(_ dir: URL) -> URL { dir.appendingPathComponent("rate", isDirectory: true) }

    /// FNV-1a: an item id is a URL, too long and too free-form for a file name.
    static func name(_ item: String, _ stamp: String) -> String {
        var h: UInt64 = 0xcbf2_9ce4_8422_2325
        for b in item.utf8 { h = (h ^ UInt64(b)) &* 0x0000_0100_0000_01b3 }
        return String(h, radix: 16) + "-" + stamp
    }

    static func jobURL(_ item: String, _ stamp: String, _ dir: URL) -> URL {
        folder(dir).appendingPathComponent(name(item, stamp) + ".job.json")
    }

    static func answerURL(_ item: String, _ stamp: String, _ dir: URL) -> URL {
        folder(dir).appendingPathComponent(name(item, stamp) + ".answer.json")
    }

    func save(in dir: URL) -> Bool {
        guard let data = try? CommsLog.encoder.encode(self) else { return false }
        PrivateFiles.prepare(Self.folder(dir))
        return PrivateFiles.writeWhole(data, to: Self.jobURL(item, stamp, dir))
    }

    static func load(_ item: String, _ stamp: String, in dir: URL) -> PipelineRateJob? {
        guard let data = try? Data(contentsOf: jobURL(item, stamp, dir)),
              let job = try? CommsLog.decoder.decode(PipelineRateJob.self, from: data),
              job.item == item, job.stamp == stamp else { return nil }
        return job
    }

    static func answered(_ item: String, _ stamp: String, in dir: URL) -> Bool {
        FileManager.default.fileExists(atPath: answerURL(item, stamp, dir).path)
    }

    /// The asked call, run once: its exit is the answer the next sync applies.
    public static func run(item: String, stamp: String, dir: URL = PipelineLog.dir,
                           io: PipelineIO = .live) -> Outcome {
        guard let job = load(item, stamp, in: dir) else { return .superseded }
        if answered(item, stamp, in: dir) { return .answered }
        guard let model = try? CoreAssets.pipeline() else { return .failed("assets/pipeline.json could not be read") }
        let exit = io.claude(PipelineRater.arguments(model: job.model, schema: model.raterSchema, prompt: job.prompt),
                             Data(job.input.utf8), job.cwd, model.rater.timeoutSecs)
        let answer = PipelineRateAnswer(item: item, stamp: stamp, status: exit.status,
                                        stdout: String(decoding: exit.stdout, as: UTF8.self), stderr: exit.stderr)
        guard answer.save(in: dir) else {
            return .failed("\(answerURL(item, stamp, dir).path) could not be written")
        }
        switch PipelineRater.rating(exit) {
        case .success(let answer): return .rated("\(answer.0.risk.rawValue) risk, \(answer.0.complexity.rawValue) complexity")
        case .failure(let f): return .failed(f.message)
        }
    }

    /// The operator's cancel of a queued job: the next sync drops its ask and does not ask
    /// again unless forced. False when there is no such job, or it answered already.
    @discardableResult
    public static func cancel(item: String, stamp: String, dir: URL = PipelineLog.dir) -> Bool {
        guard load(item, stamp, in: dir) != nil, !answered(item, stamp, in: dir) else { return false }
        return PipelineRateAnswer(item: item, stamp: stamp, status: -1, stdout: "", stderr: "", cancelled: true)
            .save(in: dir)
    }

    static func answers(in dir: URL) -> [PipelineRateAnswer] {
        let files = (try? FileManager.default.contentsOfDirectory(at: folder(dir), includingPropertiesForKeys: nil)) ?? []
        return files.filter { $0.lastPathComponent.hasSuffix(".answer.json") }.sorted { $0.path < $1.path }.compactMap {
            (try? Data(contentsOf: $0)).flatMap { try? CommsLog.decoder.decode(PipelineRateAnswer.self, from: $0) }
        }
    }

    /// Removes every job and answer but those of `current`, by item and stamp.
    static func sweep(keeping current: [String: String], in dir: URL) {
        let keep = Set(current.flatMap { [name($0.key, $0.value) + ".job.json", name($0.key, $0.value) + ".answer.json"] })
        let files = (try? FileManager.default.contentsOfDirectory(at: folder(dir), includingPropertiesForKeys: nil)) ?? []
        for f in files where (f.lastPathComponent.hasSuffix(".job.json") || f.lastPathComponent.hasSuffix(".answer.json"))
            && !keep.contains(f.lastPathComponent) {
            try? FileManager.default.removeItem(at: f)
        }
    }
}

struct PipelineRateAnswer: Codable, Equatable {
    var item: String
    var stamp: String
    var status: Int32
    var stdout: String
    var stderr: String
    var cancelled: Bool?

    var exit: PipelineIO.Exit { .init(status: status, stdout: Data(stdout.utf8), stderr: stderr) }

    func save(in dir: URL) -> Bool {
        guard let data = try? CommsLog.encoder.encode(self) else { return false }
        PrivateFiles.prepare(PipelineRateJob.folder(dir))
        return PrivateFiles.writeWhole(data, to: PipelineRateJob.answerURL(item, stamp, dir))
    }
}

/// A rating asked for and not yet applied, by item id in `state.json`.
struct PipelineRateAsk: Codable, Equatable {
    var stamp: String
    /// A PR's head, whose diff the job rates.
    var head: String?
    /// The fast track's rating at a clean head.
    var again: Bool
    /// Rate now's.
    var forced: Bool
    /// What the diff the job rates floors it to, and why.
    var floor: PipelineRating?
    var reasons: [String]
}
