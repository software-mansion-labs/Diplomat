import Foundation
import DiplomatCore

// MARK: - Pipeline: the sync, on the macOS side
//
// The core reads, rates, labels and merges, and says which agent work is owed
// (`PipelineTick.run`); this side runs it on a timer while the master switch is on and
// turns each effect into the same requested ask a sweep or a Slack ping makes. Nothing
// here starts an agent: every ask waits in the queue for a bay, behind the ban list, the
// task cap, the spending budget, the disk floor and the master switch itself
// (`AutoCounter.pipeline`).

extension Store {
    /// `DIPLOMAT_PIPELINE_SECS` (ignored unless finite), else `pipeline.json`'s `syncSecs`.
    /// Never under its `minSyncSecs` (a sync reads every root and team, and may spend
    /// `claude` calls), nor over a day (a huge value would overflow the nanosecond sleep).
    static var pipelineSyncInterval: TimeInterval {
        let model = try? CoreAssets.pipeline()
        let floor = Double(model?.minSyncSecs ?? 60)
        let secs = ProcessInfo.processInfo.environment["DIPLOMAT_PIPELINE_SECS"]
            .flatMap(Double.init).flatMap { $0.isFinite ? $0 : nil }
        return min(max(floor, secs ?? Double(model?.syncSecs ?? 300)), 86_400)
    }

    /// The self-test's stand-in for `PipelineTick.run`; consulted only headless.
    static var pipelineTickOverride: (@MainActor (PipelineSettings) -> PipelineTickResult)?

    /// The only review a PR gets before the pipeline may merge it.
    static let pipelineReviewDepth = "max"

    /// What a sync is run with: the GitHub roots (GitLab ones are not read yet), the Linear
    /// teams, the switches, and whatever the screen forced that no sync has taken.
    var pipelineSettings: PipelineSettings {
        let force = pipelineForce
        let item = AppConfig.linearKeychainItem
        return PipelineSettings(
            roots: roots.filter { !$0.isGitLab }.map {
                PipelineSettings.Root(owner: $0.owner, repo: $0.repo, path: $0.path, me: knownMe(for: $0))
            },
            linearTeams: Store.pipelineTeams(pipelineLinearTeamsRaw),
            linearKeychainItem: item.isEmpty ? nil : item,
            rate: pipelineRate, fix: pipelineFix, fastTrack: pipelineFastTrack,
            merge: pipelineMerge, fracture: pipelineFracture,
            force: force.rate.isEmpty && force.fracture.isEmpty ? nil : force)
    }

    /// `ENG=owner/repo, OPS=owner/other`, commas or new lines between: each Linear team key
    /// and the root its issues are fixed in. An entry missing either is skipped.
    nonisolated static func pipelineTeams(_ raw: String) -> [PipelineSettings.LinearTeam] {
        raw.split(whereSeparator: { $0 == "," || $0.isNewline }).compactMap { entry in
            let parts = entry.split(separator: "=", maxSplits: 1)
                .map { $0.trimmingCharacters(in: .whitespaces) }
            guard parts.count == 2, !parts[0].isEmpty,
                  let slug = PRRef.splitSlug(parts[1]), !slug.owner.isEmpty, !slug.repo.isEmpty
            else { return nil }
            return PipelineSettings.LinearTeam(key: parts[0], repo: parts[1])
        }
    }

    // MARK: the loop

    /// Never stopped: a sync with the master switch off returns at once.
    func startPipelineMonitor() {
        guard pipelineMonitorTask == nil, !Headless.active else { return }
        pipelineMonitorTask = Task { [weak self] in
            while !Task.isCancelled {
                await AppLog.timed("pipelineSync", slowAfter: 120) { await self?.runPipelineSyncOnce() }
                try? await Task.sleep(nanoseconds: UInt64(Store.pipelineSyncInterval * 1_000_000_000))
            }
        }
    }

    /// A switch flipped on syncs at once; the master one also polls, so the queued work it
    /// held drains.
    func pipelineSwitched(on: Bool, master: Bool = false) {
        guard on, !Headless.active else { return }
        Task { await runPipelineSyncOnce() }
        if master { Task { await runAutofixPollOnce() } }
    }

    /// One sync. The timer, Sync now, a switch and the screen's forces can each ask while
    /// one runs; any number of those asks is answered by one more sync after it.
    func runPipelineSyncOnce() async {
        guard pipelineEnabled, !Headless.active || Store.pipelineTickOverride != nil else { return }
        guard !pipelineSyncing else {
            pipelineSyncAgain = true
            return
        }
        pipelineSyncing = true
        defer { pipelineSyncing = false }
        repeat {
            pipelineSyncAgain = false
            await refreshRoots()
            let settings = pipelineSettings
            let result: PipelineTickResult
            if let stub = Store.pipelineTickOverride {
                result = stub(settings)
            } else {
                result = await Task.detached(priority: .utility) {
                    PipelineTick.run(settings: settings)
                }.value
            }
            // Taken by this sync; what was forced during it waits for the next.
            if let sent = settings.force {
                pipelineForce = PipelineSettings.Force(
                    rate: pipelineForce.rate.filter { !sent.rate.contains($0) },
                    fracture: pipelineForce.fracture.filter { !sent.fracture.contains($0) })
            }
            await applyPipeline(result)
        } while pipelineSyncAgain && pipelineEnabled
    }

    /// The core's `last.json`, for a screen opened before this launch's first sync.
    func loadPipelineLast() async {
        guard pipelineResult == nil, !Headless.active else { return }
        let last = await Task.detached(priority: .utility) { PipelineLog.last() }.value
        if pipelineResult == nil, let last { pipelineResult = last }
    }

    // MARK: acting on a sync

    /// Queues each owed effect not already waiting, running, cooling down after an attempt
    /// or concluded by one (`ReviewReconcile.decide`, over `pipelineAttempts`). Not
    /// private: the self-test hands it composed results.
    ///
    /// A result that lands after the master switch went off queues nothing. A notice is
    /// logged when it first appears, not on every sync that repeats it.
    func applyPipeline(_ result: PipelineTickResult, now: Date = Date()) async {
        let seen = Set(pipelineResult?.notices ?? [])
        let fresh = result.notices.filter { !seen.contains($0) }
        for notice in fresh { AuditLog.log("auto", "pipeline-notice", notice) }
        pipelineResult = result
        var queued: [String: ReviewAttempt] = [:]
        if pipelineEnabled {
            let banned = BanList.read()
            let prior = loadPipelineAttempts()
            for effect in result.effects {
                guard let ask = pipelineAsk(effect, in: result) else { continue }
                let decision = ReviewReconcile.decide(
                    prior: prior[effect.key], stamp: effect.stamp,
                    inFlight: await pipelineInFlight(effect, ask: ask),
                    banned: BanList.isBanned(ask.author, in: banned), now: now)
                guard case .dispatch(let attempt) = decision, requestOne(ask) else { continue }
                queued[effect.key] = ReviewAttempt(requestedAt: effect.stamp, lastDispatchedAt: now,
                                                   attempts: attempt)
                AuditLog.log("auto", "pipeline-queue", "\(ask.label(roots: roots.count)) queued"
                             + (attempt > 1 ? " (attempt \(attempt))" : ""))
            }
            // Onto the records as they stand now: a retirement may have concluded one, or
            // Start fix written one, while this pass awaited.
            savePipelineAttempts(Store.retainedPipelineAttempts(
                loadPipelineAttempts().merging(queued) { _, new in new }, after: result, now: now))
        }
        if !fresh.isEmpty || !queued.isEmpty { refreshAudit() }
    }

    /// The ask an effect stands for, in the root its repo names; nil once that is no root.
    func pipelineAsk(_ effect: PipelineEffect, in result: PipelineTickResult) -> RequestedWork? {
        func root(_ slug: String) -> PRRef.LocalRepo? {
            PRRef.root(named: slug, in: roots).flatMap { $0.isGitLab ? nil : $0 }
        }
        switch effect {
        case .fixIssue(let repo, let number, let url):
            guard let root = root(repo) else { return nil }
            var cfg = IssueConfig(target: .specific, me: knownMe(for: root), specificIssue: String(number))
            cfg.home = root
            cfg.pipeline = true
            // The ban dimension, as a Slack-asked fix's is.
            let author = result.items.first { $0.id == url }?.author ?? ""
            return RequestedWork(number: number, url: url, author: author, config: .issues(cfg),
                                 repo: root.key)
        case .fixLinear(let repo, let identifier, let url, let text):
            guard let root = root(repo) else { return nil }
            var cfg = IssueConfig(target: .specific, me: knownMe(for: root))
            cfg.home = root
            cfg.linear = LinearIssue(identifier: identifier, url: url, text: text)
            cfg.pipeline = true
            return RequestedWork(number: 0, url: url, author: "", config: .issues(cfg), repo: root.key)
        case .review(let repo, let number, let url, _):
            guard let root = root(repo) else { return nil }
            var cfg = ReviewConfig(depth: Store.pipelineReviewDepth, target: .specific,
                                   me: knownMe(for: root), specificPR: String(number),
                                   specificAuthor: .mine)
            cfg.home = root
            cfg.fastTrack = true
            return RequestedWork(number: number, url: url, author: "", config: .review(cfg),
                                 repo: root.key)
        }
    }

    /// Waiting in the queue or starting, or an agent on it already: any agent on a PR (the
    /// dispatch gate's own rule), a fix run on an issue.
    private func pipelineInFlight(_ effect: PipelineEffect, ask: RequestedWork) async -> Bool {
        if requestedWork.contains(where: { $0.key == ask.key })
            || queuedTasks.contains(where: { $0.id == ask.key })
            || startingTasks.contains(where: { $0.id == ask.key }) {
            return true
        }
        if case .review = effect { return await inFlight(ask.item) }
        return pipelineFixRunning(effect.url)
    }

    private func pipelineFixRunning(_ url: String) -> Bool {
        let item = Store.pipelineIdentity(url)
        return agentRows.contains {
            $0.record.kind == AgentTaskQueue.issuesAction && Store.blocks($0)
                && Store.pipelineIdentity($0.record.prURL) == item
        }
    }

    nonisolated private static func blocks(_ row: AgentRow) -> Bool {
        !row.record.released && AgentState.blocking.contains(row.state)
    }

    /// The records a sync keeps (`ReviewReconcile.retained`, `owed` being its effects).
    /// After a sync with a notice, a source may have gone unread, so the record of every
    /// item it did not list is kept too: dropping a concluded one asks for its work again.
    nonisolated static func retainedPipelineAttempts(_ attempts: [String: ReviewAttempt],
                                                     after result: PipelineTickResult,
                                                     now: Date) -> [String: ReviewAttempt] {
        let owed = Dictionary(result.effects.map { ($0.key, $0.stamp) }, uniquingKeysWith: { first, _ in first })
        let kept = ReviewReconcile.retained(attempts, owed: owed, now: now)
        guard !result.notices.isEmpty else { return kept }
        let listed = Set(result.items.map(\.id))
        return attempts.filter { key, _ in
            // `pipeline-fix:<url>`, `pipeline-review:<url>`.
            kept[key] != nil || !listed.contains(String(key.drop { $0 != ":" }.dropFirst()))
        }
    }

    // MARK: identity

    /// A Linear issue's item: a space of its own, so its fix's queue key
    /// (`issues:linear:ENG-12`) is no GitHub item's, whatever the numbers.
    nonisolated static func linearItem(_ identifier: String) -> String { "linear:" + identifier }

    /// What a pipeline item is known by across the links that name it: a GitHub item key,
    /// a Linear issue's `linearItem` (its URL's last segment follows the title), else the
    /// link itself.
    nonisolated static func pipelineIdentity(_ url: String) -> String {
        if let key = PRRef.itemKey(url: url) { return key }
        if let u = URL(string: url), u.host?.hasSuffix("linear.app") == true {
            let parts = u.pathComponents
            if let i = parts.firstIndex(of: "issue"), i + 1 < parts.count {
                return linearItem(parts[i + 1])
            }
        }
        return url
    }

    // MARK: runs that answered

    /// Concludes the attempt behind each retired run whose agent said its turn was over
    /// (`AgentState.Resolution.reported`): what it left, a PR, a clean marker or nothing,
    /// is its answer, so the same effect is not asked for again. A run that died or failed
    /// leaves its attempt on the retry ladder.
    func concludePipelineRuns(_ retired: [AgentState.RunRecord],
                              verdicts: [String: AgentState.Resolution]) {
        let reported = retired.filter { verdicts[$0.runID]?.reported == true }
        guard !reported.isEmpty else { return }
        let attempts = loadPipelineAttempts()
        let next = Store.pipelineConcluded(attempts, runs: reported, at: Date())
        if next != attempts { savePipelineAttempts(next) }
    }

    nonisolated private static let pipelineReviewKey = PipelineEffect.review(repo: "", number: 0, url: "", headSha: "").key
    nonisolated private static let pipelineFixKey = PipelineEffect.fixIssue(repo: "", number: 0, url: "").key

    /// The open records a run of `kind` on `url` is the attempt of: a review's of its PR,
    /// a fix's of its issue.
    nonisolated private static func pipelineOpenKeys(_ attempts: [String: ReviewAttempt],
                                                     kind: String, url: String) -> [String] {
        let prefix: String
        switch kind {
        case AgentTaskQueue.reviewAction: prefix = pipelineReviewKey
        case AgentTaskQueue.issuesAction: prefix = pipelineFixKey
        default: return []
        }
        let item = pipelineIdentity(url)
        return attempts.filter { key, rec in
            rec.concludedAt == nil && key.hasPrefix(prefix)
                && pipelineIdentity(String(key.dropFirst(prefix.count))) == item
        }.map(\.key)
    }

    /// `attempts` with the record of each of `runs` stamped concluded.
    nonisolated static func pipelineConcluded(_ attempts: [String: ReviewAttempt],
                                              runs: [AgentState.RunRecord],
                                              at now: Date) -> [String: ReviewAttempt] {
        var out = attempts
        for run in runs {
            for key in pipelineOpenKeys(attempts, kind: run.kind, url: run.prURL) { out[key]?.concludedAt = now }
        }
        return out
    }

    /// `attempts` with the record of the queued `job` that just spawned dated then, so its
    /// retry backoff runs from the run rather than from the wait in the queue.
    nonisolated static func pipelineSpawned(_ attempts: [String: ReviewAttempt], job: AgentJob,
                                            at now: Date) -> [String: ReviewAttempt] {
        var out = attempts
        for key in pipelineOpenKeys(attempts, kind: job.kind, url: job.prURL ?? "") {
            out[key]?.lastDispatchedAt = now
        }
        return out
    }

    // MARK: the screen's actions

    func syncPipelineNow() {
        Task { await runPipelineSyncOnce() }
    }

    /// Rate now / Fracture: rated or split on the next sync ahead of every limit, which
    /// this asks for at once.
    func forcePipeline(rate id: String? = nil, fracture split: String? = nil) {
        if let id, !pipelineForce.rate.contains(id) { pipelineForce.rate.append(id) }
        if let split, !pipelineForce.fracture.contains(split) { pipelineForce.fracture.append(split) }
        syncPipelineNow()
    }

    /// The fix effect an issue Diplomat may act on would be asked for by: a GitHub issue's
    /// from its link, a Linear one's only as the last sync emitted it, the text being
    /// Diplomat's read. None for an issue assigned to someone else, which a fix would claim.
    func pipelineFixEffect(for item: PipelineItem) -> PipelineEffect? {
        guard item.kind == .issue, item.writable else { return nil }
        if item.source == .linear {
            return pipelineResult?.effects.first {
                if case .fixLinear = $0 { return Store.pipelineIdentity($0.url) == Store.pipelineIdentity(item.id) }
                return false
            }
        }
        guard let number = PRRef.itemKey(url: item.id).flatMap(PRRef.splitItemKey)?.number else { return nil }
        return .fixIssue(repo: item.repo, number: number, url: item.id)
    }

    /// Start fix: the issue's fix queued now, past its attempt record (one cooling down or
    /// concluded included), which then records it. Returns why it was not, or nil.
    @discardableResult
    func startPipelineFix(_ item: PipelineItem) -> String? {
        guard item.writable else { return "It is assigned to someone else" }
        guard let effect = pipelineFixEffect(for: item), let result = pipelineResult else {
            return "Diplomat has not read this issue's text: it is read for a fix while Open fix PRs is on"
        }
        guard let ask = pipelineAsk(effect, in: result) else {
            return "\(item.repo) is no repo root here, so there is nowhere to fix it"
        }
        if pipelineFixRunning(effect.url) { return "An agent is already fixing it" }
        guard requestOne(ask) else { return "Its fix is already queued" }
        var attempts = loadPipelineAttempts()
        attempts[effect.key] = ReviewAttempt(requestedAt: effect.stamp, lastDispatchedAt: Date(),
                                             attempts: (attempts[effect.key]?.attempts ?? 0) + 1)
        savePipelineAttempts(attempts)
        AuditLog.log("panel", "pipeline-queue", "\(ask.label(roots: roots.count)) queued from the Pipeline screen")
        refreshAudit()
        return nil
    }

    // MARK: what the queue holds, per item

    enum PipelineBadge: Equatable { case agent, queued }

    /// Each item's agent or waiting work, by `pipelineIdentity`: an agent on it outranks
    /// work queued for it.
    var pipelineBadges: [String: PipelineBadge] {
        Store.pipelineBadges(rows: agentRows, waiting: queuedTasks + startingTasks, asks: requestedWork)
    }

    nonisolated static func pipelineBadges(rows: [AgentRow], waiting: [QueuedAgentTask],
                                           asks: [RequestedWork]) -> [String: PipelineBadge] {
        var out: [String: PipelineBadge] = [:]
        for link in waiting.compactMap(\.job.prURL) + asks.map(\.url) where !link.isEmpty {
            out[pipelineIdentity(link)] = .queued
        }
        for row in rows where blocks(row) && !row.record.prURL.isEmpty {
            out[pipelineIdentity(row.record.prURL)] = .agent
        }
        return out
    }
}
