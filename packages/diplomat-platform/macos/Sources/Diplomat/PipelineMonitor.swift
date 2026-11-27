import AppKit
import Foundation
import os
import DiplomatCore

// MARK: - Pipeline: the sync, on the macOS side
//
// The core reads, labels and merges, and says which agent work and ratings are owed
// (`PipelineTick.run`); this side runs it on a timer while the master switch is on and
// turns each effect into the same requested ask a sweep or a Slack ping makes. Nothing
// here starts an agent: every ask waits in the queue for a bay, behind the ban list, the
// task cap, the spending budget, the disk floor and the master switch itself
// (`AutoCounter.pipeline`). A rating the queue dispatches runs headless here, in its bay
// until it returns (`startPipelineRate`), and the next sync applies its answer.

extension Store {
    /// Never under `minSyncSecs` (a sync reads every root and team, and may spend `claude`
    /// calls), nor over a day (a huge value would overflow the nanosecond sleep).
    static var pipelineSyncInterval: TimeInterval {
        let model = try? CoreAssets.pipeline()
        let floor = Double(model?.minSyncSecs ?? 60)
        let secs = ProcessInfo.processInfo.environment["DIPLOMAT_PIPELINE_SECS"]
            .flatMap(Double.init).flatMap { $0.isFinite ? $0 : nil }
        return min(max(floor, secs ?? Double(model?.syncSecs ?? 300)), 86_400)
    }

    /// The self-test's stand-in for `PipelineTick.run`.
    static var pipelineTickOverride: (@MainActor (PipelineSettings) -> PipelineTickResult)?
    /// The self-test's live pass: lets a headless sync run the real `PipelineTick.run`,
    /// shown each sync's settings first.
    static var pipelineTickLive: (@MainActor (PipelineSettings) -> Void)?

    /// The only review a PR gets before the pipeline may merge it.
    static let pipelineReviewDepth = "max"

    /// The forces sorted as the Linux store hands them on.
    var pipelineSettings: PipelineSettings {
        let force = PipelineSettings.Force(rate: pipelineForce.rate.sorted(),
                                           fracture: pipelineForce.fracture.sorted(),
                                           takeover: pipelineForce.takeover.sorted(),
                                           revoke: pipelineForce.revoke.sorted())
        return PipelineSettings(
            roots: roots.filter { !$0.isGitLab }.map {
                PipelineSettings.Root(owner: $0.owner, repo: $0.repo, path: $0.path, me: knownMe(for: $0))
            },
            linearTeams: Store.pipelineTeams(pipelineLinearTeamsRaw),
            rate: pipelineRate, mirrorGitHub: pipelineMirrorGitHub, mirrorLinear: pipelineMirrorLinear,
            mirrorScope: pipelineMirrorScope, fix: pipelineFix, fastTrack: pipelineFastTrack,
            merge: pipelineMerge, fracture: pipelineFracture,
            force: force.isEmpty ? nil : force,
            queued: Store.pipelineQueued(requestedWork, attempts: loadPipelineAttempts()))
    }

    /// `PipelineSettings.queued`, sorted: the item of each pipeline ask, queued or starting,
    /// and of each attempt record. Twin of `pipeline.queued`.
    nonisolated static func pipelineQueued(_ asks: [RequestedWork], attempts: [String: ReviewAttempt]) -> [String] {
        Set(asks.filter(\.config.isPipeline).map(\.url)
            + attempts.keys.map { String($0.drop { $0 != ":" }.dropFirst()) }).sorted()
    }

    /// The switches as they stand, which a running sync re-reads before each of its writes,
    /// merges and ratings (one that cannot read them keeps those it started with), and the
    /// revokes asked, which it applies right before each merge and its asks. Headless
    /// only into a `DIPLOMAT_PIPELINE_DIR`, so a render or self-test never steers the live
    /// app's sync. Twin of `pipeline.write_control`.
    func writePipelineControl() {
        let env = ProcessInfo.processInfo.environment["DIPLOMAT_PIPELINE_DIR"] ?? ""
        guard !Headless.active || !env.isEmpty else { return }
        let revoke = pipelineForce.revoke.sorted()
        PipelineControl(enabled: pipelineEnabled, rate: pipelineRate, mirrorGitHub: pipelineMirrorGitHub,
                        mirrorLinear: pipelineMirrorLinear, mirrorScope: pipelineMirrorScope, fix: pipelineFix,
                        fastTrack: pipelineFastTrack, merge: pipelineMerge, fracture: pipelineFracture,
                        revoke: revoke.isEmpty ? nil : revoke).save()
    }

    /// The revokes `control.json` holds that no sync answered before the app quit, asked
    /// again so the first sync applies them. Read only where `writePipelineControl` writes.
    func restorePipelineRevokes() {
        let env = ProcessInfo.processInfo.environment["DIPLOMAT_PIPELINE_DIR"] ?? ""
        guard !Headless.active || !env.isEmpty else { return }
        for id in PipelineControl.read()?.revoke ?? [] where !pipelineForce.revoke.contains(id) {
            pipelineForce.revoke.append(id)
        }
    }

    nonisolated static func pipelineTeams(_ raw: String) -> [PipelineSettings.LinearTeam] {
        PipelineSettings.LinearTeam.parse(raw).teams
    }

    // MARK: the loop

    /// Never stopped: a sync with the master switch off returns at once.
    func startPipelineMonitor() {
        // The loop's sleep pauses while the Mac sleeps: a wake runs the sync it slept through,
        // in its place. Headless too, where a sync runs only the self-test's stand-ins.
        if pipelineWakeObserver == nil {
            pipelineWakeObserver = NSWorkspace.shared.notificationCenter.addObserver(
                forName: NSWorkspace.didWakeNotification, object: nil, queue: .main
            ) { [weak self] _ in
                Task { @MainActor in
                    guard let self, !self.pipelineSyncing, self.pipelineSyncWait <= 0 else { return }
                    await self.runTimedPipelineSync()
                }
            }
        }
        guard pipelineMonitorTask == nil, !Headless.active else { return }
        pipelineMonitorTask = Task { [weak self] in
            while !Task.isCancelled {
                guard let wait = self?.pipelineSyncWait else { return }
                if wait > 0 {
                    try? await Task.sleep(nanoseconds: UInt64(wait * 1_000_000_000))
                } else {
                    await AppLog.timed("pipelineSync", slowAfter: 120) { await self?.runTimedPipelineSync() }
                }
            }
        }
    }

    /// Until the loop's next sync: an interval after the last timed one ended, by the clock,
    /// which runs on while the Mac sleeps; a whole interval while one runs.
    var pipelineSyncWait: TimeInterval {
        let interval = Store.pipelineSyncInterval
        if pipelineTimedSyncing { return interval }
        return pipelineTimedSyncEnded.map { min(interval, interval + $0.timeIntervalSinceNow) } ?? 0
    }

    private func runTimedPipelineSync() async {
        pipelineTimedSyncing = true
        await runPipelineSyncOnce()
        pipelineTimedSyncing = false
        pipelineTimedSyncEnded = Date()
    }

    func pipelineCut(master: Bool = false) {
        pipelineEpoch += 1
        if master {
            pipelineJudged = false
            pipelineStale = Set(requestedWork.filter(\.config.isPipeline).map(\.key))
        }
    }

    func pipelineSwitched(on: Bool) {
        guard on, !Headless.active else { return }
        Task { await runPipelineSyncOnce() }
    }

    /// Any asks made while one runs are answered by one more sync after it. Held, as
    /// `pipelineError`, while no root resolves (a guessed root may check out another repo)
    /// or the `gh` login is unknown, by which the screen and the asks tell the operator's
    /// own as the sync does.
    func runPipelineSyncOnce() async {
        guard pipelineEnabled,
              !Headless.active || Store.pipelineTickOverride != nil || Store.pipelineTickLive != nil else { return }
        guard !pipelineSyncing else {
            pipelineSyncAgain = true
            return
        }
        pipelineSyncing = true
        defer { pipelineSyncing = false }
        await loadPipelineLast()
        repeat {
            pipelineSyncAgain = false
            await refreshRoots()
            var hold: String?
            if rootsGuessed {
                hold = "no repo root in Settings resolves to a GitHub or GitLab checkout"
            } else {
                await fetchMe()
                if roots.contains(where: { !$0.isGitLab }) && me.isEmpty { hold = Store.githubLoginUnknown }
            }
            notePipelineHealth(hold)
            if hold != nil { return }
            let epoch = pipelineEpoch
            let settings = pipelineSettings
            let handed = rootsResolved ? nil : Set(settings.roots.map { "\($0.owner)/\($0.repo)".lowercased() })
            writePipelineControl()
            let started = Date()
            let result: PipelineTickResult
            if let stub = Store.pipelineTickOverride {
                result = stub(settings)
            } else {
                Store.pipelineTickLive?(settings)
                result = await Task.detached(priority: .utility) {
                    PipelineTick.run(settings: settings)
                }.value
            }
            // The sync forgets a login it can no longer refresh; a sign-out under way reads
            // it once it ends.
            if !linearSigningOut { refreshLinearLogin() }
            let ran = Store.pipelineRan(result, started: started)
            // Taken by this sync; what was forced during it waits for the next.
            if ran, let sent = settings.force {
                pipelineForce = PipelineSettings.Force(
                    rate: pipelineForce.rate.filter { !sent.rate.contains($0) },
                    fracture: pipelineForce.fracture.filter { !sent.fracture.contains($0) },
                    takeover: pipelineForce.takeover.filter { !sent.takeover.contains($0) },
                    revoke: pipelineForce.revoke.filter { !sent.revoke.contains($0) })
            }
            await applyPipeline(result, judged: ran && epoch == pipelineEpoch, handed: handed)
        } while pipelineSyncAgain && pipelineEnabled
    }

    /// Whether `result` is a sync begun at or after `started` (results are dated to the
    /// second), not the last one answered again because `tick.lock` was held or could not
    /// be opened. Twin of `pipeline.ran_since`.
    nonisolated static func pipelineRan(_ result: PipelineTickResult, started: Date) -> Bool {
        result.at.timeIntervalSince1970 >= started.timeIntervalSince1970.rounded(.down)
    }

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

    /// The core's `last.json`: shown by a screen opened before this launch's first sync, and
    /// what `applyPipeline` tells that sync's notices, merges and splits apart from.
    func loadPipelineLast() async {
        guard pipelineResult == nil, !Headless.active else { return }
        let last = await Task.detached(priority: .utility) { PipelineLog.last() }.value
        if pipelineResult == nil, let last { pipelineResult = last }
    }

    // MARK: acting on a sync

    /// Queues each owed effect whose switch is still on (the sync may have been handed it
    /// before the switch went off) and that is not queued, running, cooling down after an
    /// attempt or concluded by one or a Cancel (`ReviewReconcile.decide`); a rating by its
    /// stamp alone (`queuePipelineRate`). A queued Linear fix whose repo or text changed is
    /// queued again as the same attempt: its agent cannot read Linear. Not one that is
    /// starting or that the network carries: a second ask would be a second fix run. Not
    /// private: the self-test hands it composed results.
    ///
    /// With the master switch off it queues and withdraws nothing (a sync switched off
    /// midway emits no effect). Only a `judged` result, a sync's own (`pipelineRan`) begun in
    /// this `pipelineEpoch`, withdraws the asks it no longer owes, releases the stale ones
    /// whose item it judged and prunes the attempt records; any other withdraws by the
    /// switches alone. `handed`: the roots that sync was handed while a root path did not
    /// resolve, nil when every one did. A result dated at the epoch, the core's answer while
    /// another sync holds its lock and none has a result yet, is not shown.
    func applyPipeline(_ result: PipelineTickResult, judged: Bool = true, handed: Set<String>? = nil,
                       now: Date = Date()) async {
        let previous = pipelineResult
        let seen = Set(previous?.notices ?? [])
        let fresh = result.notices.filter { !seen.contains($0) }
        for notice in fresh { AuditLog.log("auto", "pipeline-notice", notice) }
        let done = Store.pipelineFreshEvents(result, after: previous)
        for event in done {
            AuditLog.log("auto", event.kind == .merged ? "pipeline-merge" : "pipeline-fracture",
                         Store.pipelineEventLine(event, in: result))
        }
        if result.at.timeIntervalSince1970 != 0 { pipelineResult = result }
        if pipelineEnabled {
            withdrawPipelineAsks(judged ? result : nil, handed: handed)
            if judged {
                pipelineJudged = true
                let released = pipelineStale.intersection(Store.pipelineJudgedAsks(requestedWork, by: result,
                                                                                    handed: handed))
                if !released.isEmpty {
                    pipelineStale.subtract(released)
                    bringPollForward(capLoad: autoTasksMeasured)
                }
            }
        }
        var queued = false
        if pipelineEnabled {
            let file = BanList.readFile()
            let banned = BanList.read(file)
            let unreadable = file.isUnreadable
            for effect in result.effects {
                guard pipelineAsking(effect) else { continue }
                guard var ask = pipelineAsk(effect) else { continue }
                if case .rate = effect {
                    if queuePipelineRate(ask, banned: unreadable || BanList.isBanned(ask.author, in: banned)) {
                        queued = true
                    }
                    continue
                }
                if case .fixLinear = effect, let old = requestedWork.first(where: { $0.key == ask.key }),
                   !startingTasks.contains(where: { $0.id == ask.key }), old.offered.isEmpty,
                   old.repo != ask.repo || Store.pipelineLinear(old) != Store.pipelineLinear(ask) {
                    forgetRequested(old.key)
                    dropQueuedTask(old.key)
                    ask.byHand = old.byHand
                    requestOne(ask)
                    queued = true
                    AuditLog.log("auto", "pipeline-fix",
                                 "\(ask.label(roots: roots.count)) queued again: its repo or text changed")
                    continue
                }
                let inFlight = await pipelineInFlight(effect, ask: ask)
                // A switch turned off in that wait withdrew only what was queued by then.
                guard pipelineEnabled, pipelineAsking(effect) else { continue }
                // Read after that wait, in which a Cancel, a retirement or Start fix may write a
                // record; saved before the ask is queued, so a Cancel finds it.
                var records = loadPipelineAttempts()
                let decision = ReviewReconcile.decide(
                    prior: records[effect.key], stamp: effect.stamp, inFlight: inFlight,
                    banned: unreadable || BanList.isBanned(ask.author, in: banned), now: now)
                guard case .dispatch(let attempt) = decision else { continue }
                records[effect.key] = ReviewAttempt(requestedAt: effect.stamp, lastDispatchedAt: now,
                                                    attempts: attempt)
                savePipelineAttempts(records)
                if requestOne(ask) {
                    queued = true
                    AuditLog.log("auto", Store.pipelineVerb(effect), "\(ask.label(roots: roots.count)) queued"
                                 + (attempt > 1 ? " (attempt \(attempt))" : ""))
                }
            }
            if judged {
                savePipelineAttempts(Store.retainedPipelineAttempts(
                    loadPipelineAttempts(), after: result, handed: handed,
                    teams: Store.pipelineTeams(pipelineLinearTeamsRaw), now: now))
            }
        }
        if !fresh.isEmpty || !done.isEmpty || queued { refreshAudit() }
    }

    private func pipelineAsking(_ effect: PipelineEffect) -> Bool {
        switch effect {
        case .review: return pipelineFastTrack
        case .rate(_, _, _, _, let forced, _): return pipelineRate || forced
        case .fixIssue, .fixLinear: return pipelineFix
        }
    }

    /// Queues the rating `ask` a sync emitted while the master switch is on (an earlier
    /// effect's wait may have outlasted it), unless its author is `banned` or its job is
    /// starting or running. One queued at another stamp is replaced; one at its stamp only
    /// becomes Rate now's (`byHand`) when this ask is, keeping its place and with no feed
    /// line. No attempt record: the stamp is what a rating is asked again by. Whether it
    /// queued.
    private func queuePipelineRate(_ ask: RequestedWork, banned: Bool) -> Bool {
        guard pipelineEnabled, !banned, !pipelineRateRuns.contains(where: { $0.key == ask.key }),
              !startingTasks.contains(where: { $0.id == ask.key }) else { return false }
        if let held = requestedWork.first(where: { $0.key == ask.key }) {
            let same = Store.pipelineRateStamp(held) == Store.pipelineRateStamp(ask)
            if same && (held.byHand || !ask.byHand) { return false }
            forgetRequested(ask.key)
            dropQueuedTask(ask.key)
            if same {
                requestOne(ask)
                return false
            }
        }
        guard requestOne(ask) else { return false }
        AuditLog.log("auto", "pipeline-rate", "\(ask.label(roots: roots.count)) queued"
                     + (ask.byHand ? " (Rate now)" : ""))
        return true
    }

    nonisolated static func pipelineRateStamp(_ ask: RequestedWork) -> String? {
        if case .rate(let cfg) = ask.config { return cfg.stamp }
        return nil
    }

    func withdrawPipelineAsks(_ result: PipelineTickResult?, handed: Set<String>? = nil) {
        let gone = Set(Store.pipelineWithdrawn(requestedWork, by: result, handed: handed, fix: pipelineFix,
                                               fastTrack: pipelineFastTrack, rate: pipelineRate))
            .subtracting(startingTasks.map(\.id))
        var carried = Set<String>()
        for entry in requestedWork where gone.contains(entry.key) {
            forgetRequested(entry.key)
            dropQueuedTask(entry.key)
            if !entry.offered.isEmpty {
                carried.insert(entry.offered)
                continue
            }
            AuditLog.log("panel", "queue-drop",
                         "\(entry.label(roots: roots.count)) - the pipeline no longer owes it, not run")
        }
        if !gone.isEmpty { refreshAudit() }
        if !carried.isEmpty { Task { await withdrawUnowed(carried) } }
    }

    /// The keys of the pipeline's `asks` no longer owed: one a sync queued while its kind's
    /// switch is off; one `result` (a sync's own; nil judges by the switches alone) judged
    /// and emitted no effect for (a rating's at its stamp); a Start fix (`byHand`) in a root
    /// judged in full whose issue is not `fixable`. A Rate now's rating (`byHand`) only by
    /// `result`. Twin of `pipeline.withdrawn`.
    nonisolated static func pipelineWithdrawn(_ asks: [RequestedWork], by result: PipelineTickResult?,
                                              handed: Set<String>? = nil, fix: Bool,
                                              fastTrack: Bool, rate: Bool) -> [String] {
        let owed = Set((result?.effects ?? []).map { effect -> String in
            switch effect {
            case .review: return "review " + pipelineIdentity(effect.url)
            case .fixIssue, .fixLinear: return "fix " + pipelineIdentity(effect.url)
            case .rate: return "rate \(effect.stamp) " + pipelineIdentity(effect.url)
            }
        })
        let fixable = Set((result?.fixable ?? []).map(pipelineIdentity))
        let judged = Set(result.map { pipelineJudgedAsks(asks, by: $0, handed: handed) } ?? [])
        let short = pipelineShort(result?.unread ?? [], handed: handed)
        return asks.filter { ask in
            guard ask.config.isPipeline else { return false }
            let id = pipelineIdentity(ask.url)
            if let stamp = pipelineRateStamp(ask) {
                if !ask.byHand && !rate { return true }
                return result != nil && !owed.contains("rate \(stamp) " + id) && judged.contains(ask.key)
            }
            let review: Bool
            if case .review = ask.config { review = true } else { review = false }
            if !ask.byHand && !(review ? fastTrack : fix) { return true }
            guard result != nil else { return false }
            return ask.byHand ? !short(ask.repo.lowercased()) && !fixable.contains(id)
                : !owed.contains((review ? "review " : "fix ") + id) && judged.contains(ask.key)
        }.map(\.key)
    }

    /// The keys of the pipeline's `asks` whose item `result` (a sync's own) judged: in a
    /// root it judged in full, or by reading it. Twin of `pipeline.judged`.
    nonisolated static func pipelineJudgedAsks(_ asks: [RequestedWork], by result: PipelineTickResult,
                                               handed: Set<String>? = nil) -> [String] {
        let read = Set(result.read.map(pipelineIdentity))
        let short = pipelineShort(result.unread, handed: handed)
        return asks.filter {
            $0.config.isPipeline && (!short($0.repo.lowercased()) || read.contains(pipelineIdentity($0.url)))
        }.map(\.key)
    }

    /// Whether a root (lowercased) was judged on less than all it holds: in `unread`, or not
    /// among the roots `handed` (nil: every root path resolved). Twin of `pipeline._short`.
    nonisolated static func pipelineShort(_ unread: [String], handed: Set<String>?) -> (String) -> Bool {
        let unread = Set(unread.map { $0.lowercased() })
        return { root in unread.contains(root) || handed.map { !$0.contains(root) } == true }
    }

    nonisolated static func pipelineVerb(_ effect: PipelineEffect) -> String {
        switch effect {
        case .review: return "pipeline-review"
        case .rate: return "pipeline-rate"
        case .fixIssue, .fixLinear: return "pipeline-fix"
        }
    }

    /// The `merged` and `fractured` events of `result` that `previous` did not show: none
    /// older than its newest, nor one it held (events are stamped to the second, so two syncs
    /// can share one). With no `previous`, those stamped from `result.at` on, its own sync's.
    /// Twin of `pipeline.fresh_events`.
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

    /// nil once the effect's repo is no GitHub root here.
    func pipelineAsk(_ effect: PipelineEffect) -> RequestedWork? {
        func root(_ slug: String) -> PRRef.LocalRepo? {
            PRRef.root(named: slug, in: roots).flatMap { $0.isGitLab ? nil : $0 }
        }
        guard let root = root(Store.pipelineRepo(effect)) else { return nil }
        // The sync judges by gh's account, not the Settings override.
        let me = self.me
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
        case .rate(_, let number, let url, let stamp, let forced, _):
            var ask = RequestedWork(number: number, url: url, author: author,
                                    config: .rate(RateConfig(url: url, stamp: stamp, forced: forced)),
                                    repo: root.key)
            ask.byHand = forced
            return ask
        }
    }

    nonisolated static func pipelineLinear(_ ask: RequestedWork) -> LinearIssue? {
        if case .issues(let cfg) = ask.config { return cfg.linear }
        return nil
    }

    /// Queued, starting, or an agent on it already: any agent on a PR (the dispatch gate's
    /// own rule), a fix run on an issue.
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

    nonisolated static let pipelineConcludedKeep: TimeInterval = 30 * 86_400

    /// The root, lowercased, an item's fix or review runs in; "" for none. Twin of
    /// `pipeline._root_of`.
    nonisolated static func pipelineRoot(_ url: String, teams: [PipelineSettings.LinearTeam]) -> String {
        let item = pipelineIdentity(url)
        let linear = linearItem("")
        if item.hasPrefix(linear) {
            let identifier = item.dropFirst(linear.count)
            let team = identifier.lastIndex(of: "-").map { identifier[..<$0].uppercased() } ?? ""
            return teams.first { $0.key == team }?.repo.lowercased() ?? ""
        }
        return PRRef.splitItemKey(item)?.root.lowercased() ?? ""
    }

    /// The records a sync keeps: each it may have left out (in a root it did not judge in
    /// full, of an item it did not `read`); each it still owes, so its retry ladder and
    /// conclusion stand; each for the backoff ceiling after its last dispatch, so an effect
    /// a failed read left out is not taken for a new one when back; and a concluded one for
    /// `pipelineConcludedKeep`, so a fix of its own whose PR was closed unmerged is not asked
    /// for again. Twin of `pipeline.retained`.
    nonisolated static func retainedPipelineAttempts(_ attempts: [String: ReviewAttempt],
                                                     after result: PipelineTickResult,
                                                     handed: Set<String>? = nil,
                                                     teams: [PipelineSettings.LinearTeam],
                                                     now: Date) -> [String: ReviewAttempt] {
        let owed = Set(result.effects.map(\.key))
        let short = pipelineShort(result.unread, handed: handed)
        let read = Set(result.read.map(pipelineIdentity))
        return attempts.filter { key, rec in
            let url = key.firstIndex(of: ":").map { String(key[key.index(after: $0)...]) } ?? ""
            return owed.contains(key)
                || (short(pipelineRoot(url, teams: teams)) && !read.contains(pipelineIdentity(url)))
                || now.timeIntervalSince(rec.lastDispatchedAt) < ReviewReconcile.retryMaxBackoff
                || rec.concludedAt.map { now.timeIntervalSince($0) < pipelineConcludedKeep } == true
        }
    }

    // MARK: identity

    /// Prefixed so a Linear fix's queue key (`issues:linear:ENG-12`) is no GitHub item's.
    nonisolated static func linearItem(_ identifier: String) -> String { "linear:" + identifier }

    /// What an item is known by across the links that name it: a GitHub item key, a Linear
    /// issue's `linearItem` (its URL ends in a title slug), else the link itself.
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

    /// Concludes the attempt of each retired run whose agent said its turn was over
    /// (`AgentState.Resolution.reported`): what it left, if anything, answers the effect. A
    /// run that died or failed leaves its attempt on the retry ladder.
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

    /// Only a run the pipeline dispatched (`RunRecord.pipeline`) answers it: a monitor's,
    /// another asker's or one started by hand answers its own.
    nonisolated static func pipelineConcluded(_ attempts: [String: ReviewAttempt],
                                              runs: [AgentState.RunRecord],
                                              at now: Date) -> [String: ReviewAttempt] {
        var out = attempts
        for run in runs where run.pipeline {
            for key in pipelineOpenKeys(attempts, kind: run.kind, url: run.prURL) { out[key]?.concludedAt = now }
        }
        return out
    }

    /// Redates the spawned `job`'s record, so its retry backoff runs from the run rather than
    /// from the wait in the queue.
    nonisolated static func pipelineSpawned(_ attempts: [String: ReviewAttempt], job: AgentJob,
                                            at now: Date) -> [String: ReviewAttempt] {
        var out = attempts
        for key in pipelineOpenKeys(attempts, kind: job.kind, url: job.prURL ?? "") {
            out[key]?.lastDispatchedAt = now
        }
        return out
    }

    /// Sets the open record of each of the pipeline's `asks` another asker's took the place
    /// of to no attempts, its stamp and date kept: the pipeline's next ask for it is its
    /// first. Twin of `pipeline.preempted`.
    nonisolated static func pipelinePreempted(_ attempts: [String: ReviewAttempt],
                                              by asks: [RequestedWork]) -> [String: ReviewAttempt] {
        var out = attempts
        for ask in asks {
            for key in pipelineOpenKeys(out, kind: ask.config.action, url: ask.url) { out[key]?.attempts = 0 }
        }
        return out
    }

    /// Concludes the cancelled `job`'s record, so no sync asks for it again at that stamp.
    /// Twin of `pipeline.cancelled`.
    nonisolated static func pipelineCancelled(_ attempts: [String: ReviewAttempt], job: AgentJob,
                                              at now: Date) -> [String: ReviewAttempt] {
        var out = attempts
        for key in pipelineOpenKeys(attempts, kind: job.kind, url: job.prURL ?? "") {
            out[key]?.concludedAt = now
        }
        return out
    }

    /// What the queued row's cancel says of a pipeline ask; nil for any other. Twin of
    /// `Store.pipeline_cancel_help`.
    nonisolated static func pipelineCancelHelp(_ job: AgentJob) -> String? {
        guard job.counter == .pipeline else { return nil }
        if job.rating != nil {
            return """
                Drop this rating from the queue without running it. The pipeline does not ask for \
                it again; Rate now on the Pipeline screen does.
                """
        }
        if job.kind == AgentTaskQueue.reviewAction {
            return """
                Drop this review from the queue without running it. The pipeline asks for it \
                again once the PR's head moves.
                """
        }
        return """
            Drop this fix from the queue without running it. The pipeline does not ask for it \
            again; Start fix on the Pipeline screen does.
            """
    }

    // MARK: the Linear login

    /// The self-test's stand-ins for the browser, Diplomat's OAuth application and Linear.
    static var linearLoginOverride: (open: (URL) -> Bool, oauth: CoreAssets.PipelineModel.LinearOAuth,
                                     transport: SlackAPI.Transport)?

    func refreshLinearLogin() {
        linearLogin = LinearLogin.saved()
    }

    /// Waits off the main actor for the browser to come back, or for a Cancel while it has
    /// not; once signed in, syncs as a switch turned on does.
    func signInToLinear() async {
        guard !linearSigningIn else { return }
        linearSigningIn = true
        linearLoginNote = nil
        let stub = Store.linearLoginOverride
        let signIn = Task.detached(priority: .userInitiated) { [weak self] in
            Result {
                try LinearLogin.signIn(oauth: stub?.oauth, open: { url in
                    Task { @MainActor in self?.openLinearPage(url) }
                }, cancelled: { Task.isCancelled }, transport: stub?.transport ?? SlackAPI.curl)
            }
        }
        linearSignIn = signIn
        let answer = await signIn.value
        linearSignIn = nil
        linearSigningIn = false
        linearSignInPage = nil
        refreshLinearLogin()
        switch answer {
        case .success: if pipelineEnabled { Task { await runPipelineSyncOnce() } }
        case .failure where signIn.isCancelled: break
        case .failure(let error): linearLoginNote = error.localizedDescription
        }
    }

    func openLinearPage(_ url: URL) {
        guard linearSignIn != nil else { return }
        linearSignInPage = (url, Store.linearLoginOverride?.open(url) ?? NSWorkspace.shared.open(url))
    }

    func copyLinearPage(to pasteboard: NSPasteboard = .general) {
        guard let page = linearSignInPage else { return }
        pasteboard.clearContents()
        pasteboard.setString(page.url.absoluteString, forType: .string)
    }

    func cancelLinearSignIn() {
        linearSignIn?.cancel()
        linearSignIn = nil
    }

    /// Off the main actor: the revocation is a call to Linear.
    func signOutOfLinear() async {
        guard !linearSigningOut else { return }
        linearSigningOut = true
        linearLoginNote = nil
        let transport = Store.linearLoginOverride?.transport ?? SlackAPI.curl
        let answer = await Task.detached(priority: .userInitiated) {
            Result { try LinearLogin.signOut(transport: transport) }
        }.value
        linearSigningOut = false
        refreshLinearLogin()
        switch answer {
        case .success(let warning): linearLoginNote = warning.map { "Signed out, but " + $0 }
        case .failure(let error): linearLoginNote = error.localizedDescription
        }
    }

    // MARK: the screen's actions

    func syncPipelineNow() {
        Task { await runPipelineSyncOnce() }
    }

    /// Rate now / Fracture / Authorize or Revoke takeover: asked of the next sync, past its
    /// own limits. Of a takeover and a revoke asked of one item, the last asked wins.
    func forcePipeline(rate id: String? = nil, fracture split: String? = nil,
                       takeover taken: String? = nil, revoke: String? = nil) {
        if let id, !pipelineForce.rate.contains(id) { pipelineForce.rate.append(id) }
        if let split, !pipelineForce.fracture.contains(split) { pipelineForce.fracture.append(split) }
        if let taken {
            pipelineForce.revoke.removeAll { $0 == taken }
            if !pipelineForce.takeover.contains(taken) { pipelineForce.takeover.append(taken) }
        }
        if let revoke {
            pipelineForce.takeover.removeAll { $0 == revoke }
            if !pipelineForce.revoke.contains(revoke) { pipelineForce.revoke.append(revoke) }
        }
        if taken != nil || revoke != nil { writePipelineControl() }
        syncPipelineNow()
    }

    /// The last sync's fix effect for an issue Diplomat may act on, else a GitHub issue's
    /// from its link, by whoever wrote its text (`splitFrom`, else its author); a Linear
    /// issue's text comes only with the emitted one. None for a held issue or one assigned
    /// to someone else, which a fix would claim. Twin of `Store.pipeline_fix_effect`.
    func pipelineFixEffect(for item: PipelineItem) -> PipelineEffect? {
        guard item.kind == .issue, item.writable, item.hold == nil else { return nil }
        let emitted = pipelineResult?.effects.first {
            switch $0 {
            case .review, .rate: return false
            case .fixIssue, .fixLinear: return Store.pipelineIdentity($0.url) == Store.pipelineIdentity(item.id)
            }
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

    /// Why a sync would rate, split and take over nothing: the ban list cannot be read. Twin of
    /// `Store.pipeline_ban_unread`.
    var pipelineBanUnread: String? {
        banListUnreadable ? "The prompt-injection ban list could not be read" : nil
    }

    /// Why, by the ban list, the queue would not run `item`'s fix. Twin of
    /// `Store.pipeline_ban`.
    func pipelineBan(_ item: PipelineItem) -> String? {
        if let why = pipelineBanUnread { return why }
        let who = item.splitFrom ?? item.author ?? ""
        return !who.isEmpty && BanList.isBanned(who, in: bannedAuthors)
            ? "@\(who) is on the prompt-injection ban list" : nil
    }

    /// `pipelineResult` as the Pipeline screen shows it, cut to the picked root
    /// (`PipelineView.inRoot`).
    var pipelineShown: PipelineTickResult? {
        pipelineResult.map {
            PipelineView.inRoot($0, root: selectedRoot.key, roots: Set(roots.map(\.key)),
                                teams: Store.pipelineTeams(pipelineLinearTeamsRaw))
        }
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

    /// `PipelineView.canRate` by the `gh` account a sync judges PRs by, not the Settings
    /// override.
    func pipelineCanRate(_ item: PipelineItem) -> Bool {
        PipelineView.canRate(item, me: me, rooted: pipelineRooted(item))
    }

    /// Start fix: queues the issue's fix as the last sync left it, past its attempt record
    /// (even one cooling down or concluded) and records the attempt. Returns why not, or nil.
    @discardableResult
    func startPipelineFix(_ item: PipelineItem) -> String? {
        guard pipelineEnabled else { return "The pipeline is off" }
        guard let item = pipelineResult?.items.first(where: { $0.id == item.id }),
              item.kind == .issue, item.stage == .candidate
        else { return "The last sync found it no fix candidate" }
        guard let effect = pipelineFixEffect(for: item) else { return pipelineFixUnknown(item) }
        guard var ask = pipelineAsk(effect) else {
            return "\(Store.pipelineRepo(effect)) is no GitHub repo root here, so there is nowhere to fix it"
        }
        ask.byHand = true
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
        case .fixIssue(let repo, _, _, _), .fixLinear(let repo, _, _, _, _), .review(let repo, _, _, _, _),
             .rate(let repo, _, _, _, _, _): return repo
        }
    }

    // MARK: what the queue holds, per item

    enum PipelineBadge: Equatable { case agent, queued }

    /// By `pipelineIdentity`; an agent or a rating job on an item outranks work queued for it.
    var pipelineBadges: [String: PipelineBadge] {
        Store.pipelineBadges(rows: agentRows, waiting: queuedTasks + startingTasks, asks: requestedWork,
                             rating: pipelineRateRuns)
    }

    nonisolated static func pipelineBadges(rows: [AgentRow], waiting: [QueuedAgentTask],
                                           asks: [RequestedWork],
                                           rating: [PipelineRateRun] = []) -> [String: PipelineBadge] {
        var out: [String: PipelineBadge] = [:]
        for link in waiting.compactMap(\.job.prURL) + asks.map(\.url) where !link.isEmpty {
            out[pipelineIdentity(link)] = .queued
        }
        for link in rows.filter(blocks).map(\.record.prURL) + rating.map(\.url) where !link.isEmpty {
            out[pipelineIdentity(link)] = .agent
        }
        return out
    }

    // MARK: rating jobs

    /// A rating ask's config: its item's link, the stamp the sync wrote its job at, and
    /// whether Rate now asked for it.
    struct RateConfig: Codable, Equatable, Sendable {
        let url: String
        let stamp: String
        let forced: Bool
    }

    /// A rating job the queue started, holding a bay of the cap until it returns.
    struct PipelineRateRun: Equatable {
        /// Its ask's queue key.
        let key: String
        /// Its queued row's, which its running row and feed lines wear.
        let label: String
        let url: String
        let startedAt: Date
        let forced: Bool
    }

    /// Runs the dispatched `rating`'s job off the main actor, its bay held
    /// (`pipelineRateRuns`) until it returns; then says in the feed what it did, frees the
    /// bay and, for Rate now, syncs to apply it. Not awaited at a quit.
    func startPipelineRate(_ rating: RateConfig, label: String) {
        let run = PipelineRateRun(
            key: AgentTaskQueue.key(auditAction: AgentTaskQueue.rateAction, item: Store.pipelineIdentity(rating.url)),
            label: label, url: rating.url, startedAt: Date(), forced: rating.forced)
        pipelineRateRuns.append(run)
        Task {
            let outcome = await Task.detached(priority: .utility) {
                PipelineRateJob.run(item: rating.url, stamp: rating.stamp)
            }.value
            finishPipelineRate(run, outcome)
        }
    }

    func finishPipelineRate(_ run: PipelineRateRun, _ outcome: PipelineRateJob.Outcome) {
        pipelineRateRuns.removeAll { $0 == run }
        switch outcome {
        case .rated(let rating): AuditLog.log("auto", "pipeline-rate", "\(run.label) rated: \(rating)")
        case .failed(let why): AuditLog.log("auto", "pipeline-rate", "\(run.label) was not rated: \(why)")
        case .answered, .superseded: break
        }
        refreshAudit()
        bringPollForward(capLoad: autoTasksMeasured)
        if run.forced { syncPipelineNow() }
    }
}
