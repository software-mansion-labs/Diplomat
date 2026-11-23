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
    /// Lets a headless sync run the real `PipelineTick.run`: the self-test's live pass,
    /// whose `gh`, `claude` and Linear are the stubs its environment names.
    static var pipelineTickLive = false

    /// The only review a PR gets before the pipeline may merge it.
    static let pipelineReviewDepth = "max"

    /// What a sync is run with: the GitHub roots (GitLab ones are not read yet), the Linear
    /// teams, the switches, and whatever the screen forced that no sync has taken, sorted
    /// as the Linux store hands its forces on.
    var pipelineSettings: PipelineSettings {
        let force = PipelineSettings.Force(rate: pipelineForce.rate.sorted(),
                                           fracture: pipelineForce.fracture.sorted())
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

    /// `control.json` in `PipelineLog.dir`: the switches as they stand, which a running sync
    /// re-reads before each of its writes, merges and ratings. Owner-only, replaced whole;
    /// a sync that cannot read it goes by the settings it was started with. Headless only
    /// into a `DIPLOMAT_PIPELINE_DIR`, so a render or self-test never steers the live app's
    /// sync. Twin of `pipeline.write_control`.
    func writePipelineControl() {
        let env = ProcessInfo.processInfo.environment["DIPLOMAT_PIPELINE_DIR"] ?? ""
        guard !Headless.active || !env.isEmpty else { return }
        let switches = ["enabled": pipelineEnabled, "rate": pipelineRate, "fix": pipelineFix,
                        "fastTrack": pipelineFastTrack, "merge": pipelineMerge,
                        "fracture": pipelineFracture]
        let encoder = JSONEncoder()
        encoder.outputFormatting = .sortedKeys
        guard let data = try? encoder.encode(switches) else { return }
        let dir = PipelineLog.dir
        let fm = FileManager.default
        let tmp = dir.appendingPathComponent("control.json.tmp-\(getpid())-\(UUID().uuidString)")
        try? fm.createDirectory(at: dir, withIntermediateDirectories: true,
                                attributes: [.posixPermissions: 0o700])
        if !fm.createFile(atPath: tmp.path, contents: data, attributes: [.posixPermissions: 0o600])
            || rename(tmp.path, dir.appendingPathComponent("control.json").path) != 0 {
            try? fm.removeItem(at: tmp)
        }
    }

    /// The teams the Settings line names (`PipelineSettings.LinearTeam.parse`).
    nonisolated static func pipelineTeams(_ raw: String) -> [PipelineSettings.LinearTeam] {
        PipelineSettings.LinearTeam.parse(raw).teams
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
    /// one runs; any number of those asks is answered by one more sync after it. Held, as
    /// `pipelineError`, while no root resolves (a guessed root may check out another
    /// repo) and while the GitHub login is unknown, which would make none of the
    /// operator's PRs theirs; the forces then wait.
    func runPipelineSyncOnce() async {
        guard pipelineEnabled,
              !Headless.active || Store.pipelineTickOverride != nil || Store.pipelineTickLive else { return }
        guard !pipelineSyncing else {
            pipelineSyncAgain = true
            return
        }
        pipelineSyncing = true
        defer { pipelineSyncing = false }
        // What the first sync's merges and splits are told apart from (`applyPipeline`).
        await loadPipelineLast()
        repeat {
            pipelineSyncAgain = false
            await refreshRoots()
            var hold: String?
            if rootsGuessed {
                hold = "no repo root in Settings resolves to a GitHub or GitLab checkout"
            } else {
                if effectiveMe.isEmpty { await fetchMe() }
                if roots.contains(where: { !$0.isGitLab }) && effectiveMe.isEmpty { hold = Store.githubLoginUnknown }
            }
            notePipelineHealth(hold)
            if hold != nil { return }
            let settings = pipelineSettings
            writePipelineControl()
            let started = Date()
            let result: PipelineTickResult
            if let stub = Store.pipelineTickOverride {
                result = stub(settings)
            } else {
                result = await Task.detached(priority: .utility) {
                    PipelineTick.run(settings: settings)
                }.value
            }
            let ran = Store.pipelineRan(result, started: started)
            // Taken by this sync; what was forced during it waits for the next.
            if ran, let sent = settings.force {
                pipelineForce = PipelineSettings.Force(
                    rate: pipelineForce.rate.filter { !sent.rate.contains($0) },
                    fracture: pipelineForce.fracture.filter { !sent.fracture.contains($0) })
            }
            await applyPipeline(result, ran: ran)
        } while pipelineSyncAgain && pipelineEnabled
    }

    /// Whether `result` is a sync begun at or after `started`, not the last one answered
    /// again because another sync held the lock. A result is dated, to the second, when
    /// its sync began. Twin of `pipeline.ran_since`.
    nonisolated static func pipelineRan(_ result: PipelineTickResult, started: Date) -> Bool {
        result.at.timeIntervalSince1970 >= started.timeIntervalSince1970.rounded(.down)
    }

    /// Logs only transitions: a hold lasts every sync until it lifts.
    func notePipelineHealth(_ error: String?) {
        if let error {
            if pipelineError == nil {
                AuditLog.log("auto", "pipeline-error", error)
                refreshAudit()
            }
            if pipelineError != error { pipelineError = error }
        } else if pipelineError != nil {
            AuditLog.log("auto", "pipeline-recovered", "Pipeline syncing again")
            refreshAudit()
            pipelineError = nil
        }
    }

    /// The core's `last.json`, for a screen opened before this launch's first sync and
    /// for that sync to be told apart from.
    func loadPipelineLast() async {
        guard pipelineResult == nil, !Headless.active else { return }
        let last = await Task.detached(priority: .utility) { PipelineLog.last() }.value
        if pipelineResult == nil, let last { pipelineResult = last }
    }

    // MARK: acting on a sync

    /// Queues each owed effect not already waiting, running, cooling down after an attempt
    /// or concluded by one (`ReviewReconcile.decide`, over `pipelineAttempts`): a fix only
    /// while the fix switch is on, a review only while the fast-track one is, since the
    /// sync may have been handed them before either went off. A dispatch is an attempt
    /// whether or not the queue takes the ask. Not private: the self-test hands it
    /// composed results.
    ///
    /// A result that lands after the master switch went off queues nothing. One of a sync's
    /// own (`ran`, `pipelineRan`) first retires the queued asks it no longer owes
    /// (`pipelineWithdrawn`). A notice is logged when it first appears, and each merge and
    /// split the core made since the previous result once (`Store.pipelineFreshEvents`),
    /// whatever the switches.
    func applyPipeline(_ result: PipelineTickResult, ran: Bool = true, now: Date = Date()) async {
        let previous = pipelineResult
        let seen = Set(previous?.notices ?? [])
        let fresh = result.notices.filter { !seen.contains($0) }
        for notice in fresh { AuditLog.log("auto", "pipeline-notice", notice) }
        let done = Store.pipelineFreshEvents(result, after: previous)
        for event in done {
            AuditLog.log("auto", event.kind == .merged ? "pipeline-merge" : "pipeline-fracture",
                         Store.pipelineEventLine(event, in: result))
        }
        pipelineResult = result
        let withdrawn = ran ? withdrawPipelineAsks(result) : false
        var queued = false
        if pipelineEnabled {
            let banned = BanList.read()
            let prior = loadPipelineAttempts()
            var dispatched: [String: ReviewAttempt] = [:]
            for effect in result.effects {
                switch effect {
                case .fixIssue, .fixLinear: guard pipelineFix else { continue }
                case .review: guard pipelineFastTrack else { continue }
                }
                guard let ask = pipelineAsk(effect) else { continue }
                let decision = ReviewReconcile.decide(
                    prior: prior[effect.key], stamp: effect.stamp,
                    inFlight: await pipelineInFlight(effect, ask: ask),
                    banned: BanList.isBanned(ask.author, in: banned), now: now)
                guard case .dispatch(let attempt) = decision else { continue }
                dispatched[effect.key] = ReviewAttempt(requestedAt: effect.stamp, lastDispatchedAt: now,
                                                       attempts: attempt)
                if requestOne(ask) {
                    queued = true
                    AuditLog.log("auto", Store.pipelineVerb(effect), "\(ask.label(roots: roots.count)) queued"
                                 + (attempt > 1 ? " (attempt \(attempt))" : ""))
                }
            }
            // Onto the records as they stand now: a retirement may have concluded one, or
            // Start fix written one, while this pass awaited.
            savePipelineAttempts(Store.retainedPipelineAttempts(
                loadPipelineAttempts().merging(dispatched) { _, new in new }, after: result, now: now))
        }
        if !fresh.isEmpty || !done.isEmpty || queued || withdrawn { refreshAudit() }
    }

    /// Drops each ask `pipelineWithdrawn` names, unless it is starting; whether any went.
    private func withdrawPipelineAsks(_ result: PipelineTickResult) -> Bool {
        let gone = Set(Store.pipelineWithdrawn(requestedWork, by: result))
            .subtracting(startingTasks.map(\.id))
        for entry in requestedWork where gone.contains(entry.key) {
            forgetRequested(entry.key)
            dropQueuedTask(entry.key)
            AuditLog.log("panel", "queue-drop",
                         "\(entry.label(roots: roots.count)) - the pipeline no longer owes it, not run")
        }
        return !gone.isEmpty
    }

    /// The keys of the pipeline's `asks` that `result`, a sync's own, no longer owes: a
    /// review it emitted no effect for, a fix of an issue that is no longer a writable
    /// candidate. An item it did not read is not judged. A candidate it emitted no fix for
    /// (the fix switch off, a hold on what it could not read) keeps its fix. Twin of
    /// `pipeline.withdrawn`.
    nonisolated static func pipelineWithdrawn(_ asks: [RequestedWork],
                                              by result: PipelineTickResult) -> [String] {
        let items = Dictionary(result.items.map { (pipelineIdentity($0.id), $0) },
                               uniquingKeysWith: { first, _ in first })
        let owed = Set(result.effects.map { effect -> String in
            if case .review = effect { return "review " + pipelineIdentity(effect.url) }
            return "fix " + pipelineIdentity(effect.url)
        })
        return asks.filter { ask in
            guard ask.config.isPipeline else { return false }
            let review: Bool
            if case .review = ask.config { review = true } else { review = false }
            let id = pipelineIdentity(ask.url)
            guard let item = items[id], !owed.contains((review ? "review " : "fix ") + id) else { return false }
            return review || !(item.kind == .issue && item.stage == .candidate && item.writable)
        }.map(\.key)
    }

    /// `pipeline-fix` for a fix, `pipeline-review` for a fast-track review.
    nonisolated static func pipelineVerb(_ effect: PipelineEffect) -> String {
        if case .review = effect { return "pipeline-review" }
        return "pipeline-fix"
    }

    /// The `merged` and `fractured` events of `result` newer than anything `previous`
    /// showed: none older than its newest event, nor one it held (events are stamped to
    /// the second, so two syncs can share one). With no previous result, those of
    /// `result`'s own sync, which stamps them with its date. Twin of `pipeline.fresh_events`.
    nonisolated static func pipelineFreshEvents(_ result: PipelineTickResult,
                                                after previous: PipelineTickResult?) -> [PipelineEvent] {
        let shown = previous?.events ?? []
        let newest = previous == nil ? result.at : shown.map(\.at).max()
        return result.events.filter { event in
            [.merged, .fractured].contains(event.kind) && newest.map { event.at >= $0 } != false
                && !shown.contains(event)
        }
    }

    /// `#12: merged abc1234 with --admin --squash`: the item's label, else its link.
    nonisolated static func pipelineEventLine(_ event: PipelineEvent, in result: PipelineTickResult) -> String {
        let label = result.items.first { $0.id == event.item }?.label ?? event.item
        return "\(label): \(event.detail)"
    }

    /// The ask an effect stands for, in the root its repo names; nil once that is no root.
    func pipelineAsk(_ effect: PipelineEffect) -> RequestedWork? {
        func root(_ slug: String) -> PRRef.LocalRepo? {
            PRRef.root(named: slug, in: roots).flatMap { $0.isGitLab ? nil : $0 }
        }
        guard let root = root(Store.pipelineRepo(effect)) else { return nil }
        let me = knownMe(for: root)
        // The ban dimension, which the operator's own work has none of.
        let mine = !me.isEmpty && effect.author.lowercased() == me.lowercased()
        let author = mine ? "" : effect.author
        switch effect {
        case .fixIssue(_, let number, let url, _):
            var cfg = IssueConfig(target: .specific, me: me, specificIssue: String(number))
            cfg.home = root
            cfg.pipeline = true
            return RequestedWork(number: number, url: url, author: author,
                                 config: .issues(cfg), repo: root.key)
        case .fixLinear(_, let identifier, let url, let text, _):
            var cfg = IssueConfig(target: .specific, me: me)
            cfg.home = root
            cfg.linear = LinearIssue(identifier: identifier, url: url, text: text)
            cfg.pipeline = true
            return RequestedWork(number: 0, url: url, author: author, config: .issues(cfg), repo: root.key)
        case .review(_, let number, let url, _, _):
            var cfg = ReviewConfig(depth: Store.pipelineReviewDepth, target: .specific,
                                   me: me, specificPR: String(number), specificAuthor: .mine)
            cfg.home = root
            cfg.fastTrack = true
            return RequestedWork(number: number, url: url, author: author, config: .review(cfg),
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

    /// How long a concluded record is kept once no sync owes its effect.
    nonisolated static let pipelineConcludedKeep: TimeInterval = 30 * 86_400

    /// The records a sync keeps: each while the sync owes its effect, so its retry ladder
    /// and its conclusion stand; for the backoff ceiling after its last dispatch, so an
    /// effect a failed read left out is not taken for a new one when it is back; and a
    /// concluded one for `pipelineConcludedKeep` after its run concluded, so a fix whose
    /// PR was closed unmerged is not asked for again. Twin of `pipeline.retained`.
    nonisolated static func retainedPipelineAttempts(_ attempts: [String: ReviewAttempt],
                                                     after result: PipelineTickResult,
                                                     now: Date) -> [String: ReviewAttempt] {
        let owed = Set(result.effects.map(\.key))
        return attempts.filter { key, rec in
            owed.contains(key) || now.timeIntervalSince(rec.lastDispatchedAt) < ReviewReconcile.retryMaxBackoff
                || rec.concludedAt.map { now.timeIntervalSince($0) < pipelineConcludedKeep } == true
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

    nonisolated private static let pipelineReviewKey = PipelineEffect.review(repo: "", number: 0, url: "", headSha: "", author: "").key
    nonisolated private static let pipelineFixKey = PipelineEffect.fixIssue(repo: "", number: 0, url: "", author: "").key

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

    /// The fix effect an issue Diplomat may act on would be asked for by: the one the last
    /// sync emitted for it; failing that, a GitHub issue's from its link, by whose text it
    /// carries (`splitFrom`, else its author). A Linear issue's text is Diplomat's read, so
    /// its fix is only the emitted one. None for an issue assigned to someone else, which a
    /// fix would claim, or one a hold stops. Twin of `Store.pipeline_fix_effect`.
    func pipelineFixEffect(for item: PipelineItem) -> PipelineEffect? {
        guard item.kind == .issue, item.writable, item.hold == nil else { return nil }
        let emitted = pipelineResult?.effects.first {
            if case .review = $0 { return false }
            return Store.pipelineIdentity($0.url) == Store.pipelineIdentity(item.id)
        }
        if emitted != nil || item.source == .linear { return emitted }
        guard let number = PRRef.itemKey(url: item.id).flatMap(PRRef.splitItemKey)?.number else { return nil }
        return .fixIssue(repo: item.repo, number: number, url: item.id, author: item.splitFrom ?? item.author ?? "")
    }

    /// Why an issue has no `pipelineFixEffect`, said to the operator.
    func pipelineFixUnknown(_ item: PipelineItem) -> String {
        if !item.writable { return "It is assigned to someone else" }
        if let hold = item.hold { return hold }
        return "Diplomat has this Linear issue's text only while Open fix PRs is on"
    }

    /// Whether a sync can read `item`'s code: a Linear issue only when its team names a
    /// GitHub root (`PipelineRead.linear`'s match). Twin of `Store.pipeline_rooted`.
    func pipelineRooted(_ item: PipelineItem) -> Bool {
        guard item.source == .linear else { return true }
        let slugs = Set(roots.filter { !$0.isGitLab }.map { "\($0.owner)/\($0.repo)".lowercased() })
        return Store.pipelineTeams(pipelineLinearTeamsRaw).contains {
            $0.key.lowercased() == item.repo.lowercased() && slugs.contains($0.repo.lowercased())
        }
    }

    /// Start fix: the issue's fix queued now, as the last sync left it, past its attempt
    /// record (one cooling down or concluded included), which then records it; it waits
    /// for a bay like every ask. Returns why it was not, or nil.
    @discardableResult
    func startPipelineFix(_ item: PipelineItem) -> String? {
        guard pipelineEnabled else { return "The pipeline is off" }
        guard let item = pipelineResult?.items.first(where: { $0.id == item.id }),
              item.kind == .issue, item.stage == .candidate
        else { return "The last sync found it no fix candidate" }
        guard let effect = pipelineFixEffect(for: item) else { return pipelineFixUnknown(item) }
        guard let ask = pipelineAsk(effect) else {
            return "\(Store.pipelineRepo(effect)) is no GitHub repo root here, so there is nowhere to fix it"
        }
        if pipelineFixRunning(effect.url) { return "An agent is already fixing it" }
        guard requestOne(ask) else { return "Its fix is already queued" }
        var attempts = loadPipelineAttempts()
        attempts[effect.key] = ReviewAttempt(requestedAt: effect.stamp, lastDispatchedAt: Date(),
                                             attempts: (attempts[effect.key]?.attempts ?? 0) + 1)
        savePipelineAttempts(attempts)
        AuditLog.log("panel", Store.pipelineVerb(effect),
                     "\(ask.label(roots: roots.count)) queued from the Pipeline screen")
        refreshAudit()
        return nil
    }

    nonisolated static func pipelineRepo(_ effect: PipelineEffect) -> String {
        switch effect {
        case .fixIssue(let repo, _, _, _), .fixLinear(let repo, _, _, _, _), .review(let repo, _, _, _, _): return repo
        }
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
