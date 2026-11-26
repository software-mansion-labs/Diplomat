import Foundation
import DiplomatCore

struct NetworkCycle {
    /// The daemon takes nothing once `admit` is 120 s old.
    static let admitEvery: TimeInterval = 60
    static let firstStartDelay: TimeInterval = 15
    static let longestStartDelay: TimeInterval = 600

    /// pid + start time of the daemon that heard the posts below; a new one hears them again.
    var daemon = ""
    var pools: [NetworkPools.Pool]?
    var poolsRefused: [NetworkPools.Pool]?
    var poolsRefusal = ""
    var poolsRefusedAt: TimeInterval = 0
    var admit: NetworkAdmit.Answer?
    var admitAt: TimeInterval = 0
    var identitiesAskedAt: TimeInterval = 0
    var startAfter: TimeInterval = 0
    var startDelay: TimeInterval = 0
    var startFailureLogged = false
    var running = false
}

/// The dispatch gate, tick evidence and run retirement live in `Store.swift`.
extension Store {
    // MARK: lifecycle

    func networkSwitched() {
        networkCycle = NetworkCycle()
        networkUnavailableLogged = false
        networkJobRefusals = [:]
        let offering = networkOffering
        networkOffering = []
        if !networkEnabled {
            networkState = nil
            networkAnswered = nil
            networkRefusals = [:]
            networkPoolsHeld = ""
        }
        guard DiplomacyNetwork.drivesDaemon else { return }
        let on = networkEnabled
        let previous = networkLifecycle
        networkLifecycle = Task {
            await previous?.value
            if on {
                await whileNetworkBusy { await self.startNetworkDaemon(source: "panel") }
                await runNetworkCycleOnce()
            } else {
                await whileNetworkBusy {
                    // Before the stop: a withdrawal needs the daemon.
                    await self.settleAgents()
                    await self.withdrawOffering(offering)
                    let result = await Task.detached(priority: .userInitiated) {
                        DiplomacyNetwork.stopDaemon()
                    }.value
                    AuditLog.log("panel", NetworkAudit.stop, DiplomacyNetwork.stoppedLine(result))
                }
            }
        }
    }

    private func whileNetworkBusy(_ work: () async -> Void) async {
        networkBusy = true
        await work()
        refreshAudit()
        networkBusy = false
    }

    @discardableResult
    private func startNetworkDaemon(source: String, restart: Bool = false,
                                    quietly: Bool = false) async -> Bool {
        let result = await Task.detached(priority: .userInitiated) {
            restart ? DiplomacyNetwork.restartDaemon() : DiplomacyNetwork.startDaemon()
        }.value
        let ok = result.daemonRunning && result.error == nil
        if !ok, quietly {
            guard !networkCycle.startFailureLogged else { return false }
            networkCycle.startFailureLogged = true
        }
        AuditLog.log(source, NetworkAudit.start,
                     "\(restart ? "Restarted" : "Started") the Diplomacy Network daemon "
                     + "(ok: \(ok))" + (result.error.map { ": \($0)" } ?? ""))
        return ok
    }

    /// Not while `networkSettingsUnknown`: a daemon started on an unreadable config
    /// switches itself off.
    func startNetworkDaemon(restart: Bool) async {
        guard networkEnabled, !networkBusy, networkSettingsUnknown.isEmpty else { return }
        await whileNetworkBusy {
            await self.startNetworkDaemon(source: "panel", restart: restart)
        }
        await runNetworkCycleOnce()
    }

    func retireLegacyMeshNode() async {
        let line = await Task.detached(priority: .utility) {
            let retired = DiplomacyNetwork.retireLegacyMeshNode()
            return DiplomacyNetwork.legacyRetiredLine(
                asked: retired.asked, removed: retired.removed, link: retired.link)
        }.value
        guard let line else { return }
        AuditLog.log("auto", NetworkAudit.stop, line)
        refreshAudit()
    }

    // MARK: one cycle

    func runNetworkCycleOnce(now: TimeInterval = Date().timeIntervalSince1970) async {
        rereadNetworkSettings()
        guard networkEnabled, !networkCycle.running else { return }
        networkCycle.running = true
        defer { networkCycle.running = false }
        let snapshot = await Task.detached(priority: .utility) { DiplomacyNetwork.state() }.value
        guard networkEnabled else { return }
        noteNetworkState(snapshot)
        guard let snapshot else {
            await reviveNetworkDaemon(now: now)
            return
        }
        let daemon = "\(snapshot.pid ?? 0) \(snapshot.startedAt ?? 0)"
        if daemon != networkCycle.daemon {
            networkCycle = NetworkCycle(daemon: daemon, running: true)
        }
        networkCycle.startDelay = 0
        networkCycle.startAfter = 0
        networkCycle.startFailureLogged = false
        guard networkSettingsUnknown.isEmpty else {
            await settleOffering(snapshot)
            return
        }
        if rootsReadBlind { await refreshRoots() }
        await postNetworkPools(snapshot, now: now)
        await postNetworkAdmit(snapshot, now: now)
        await settleOffering(snapshot)
    }

    private func reviveNetworkDaemon(now: TimeInterval) async {
        guard DiplomacyNetwork.drivesDaemon, !networkBusy, now >= networkCycle.startAfter,
              networkSettingsUnknown.isEmpty else { return }
        networkCycle.startDelay = min(max(networkCycle.startDelay * 2,
                                          NetworkCycle.firstStartDelay),
                                      NetworkCycle.longestStartDelay)
        networkCycle.startAfter = now + networkCycle.startDelay
        await whileNetworkBusy {
            await self.startNetworkDaemon(source: "auto", quietly: true)
        }
    }

    /// Local repos are re-read first: an unreadable one may be back, or one may have
    /// gained a remote.
    private func postNetworkPools(_ snapshot: NetworkSnapshot, now: TimeInterval) async {
        await rereadLocalRepos()
        guard !rootsReadBlind else { return }
        let listing = networkPools(known: snapshot.pools)
        if !listing.unconfirmed.isEmpty,
           now - networkCycle.identitiesAskedAt >= NetworkCycle.admitEvery {
            networkCycle.identitiesAskedAt = now
            await readNetworkIdentities()
        }
        let pools = listing.pools
        if pools == networkCycle.pools {
            networkCycle.poolsRefused = nil
            networkCycle.poolsRefusal = ""
        } else if pools != networkCycle.poolsRefused
                    || now - networkCycle.poolsRefusedAt >= NetworkCycle.admitEvery {
            let body = NetworkPools.body(pools)
            let (reply, reach) = await Task.detached(priority: .utility) {
                DiplomacyNetwork.ask(NetworkRoute.pools, body)
            }.value
            switch reply {
            case .ok:
                networkCycle.pools = pools
                networkCycle.poolsRefused = nil
                networkCycle.poolsRefusal = ""
                logPoolsLeft(snapshot.pools, said: pools)
            case .refused(let why) where reach == .answered:
                let said = "The daemon refused this machine's pools: \(why)"
                if pools != networkCycle.poolsRefused || said != networkCycle.poolsRefusal {
                    AuditLog.log("auto", NetworkAudit.unavailable, said)
                    refreshAudit()
                }
                networkCycle.poolsRefused = pools
                networkCycle.poolsRefusal = said
                networkCycle.poolsRefusedAt = now
            case .refused, .down:
                break
            }
        }
        let held = (listing.unconfirmed + [networkCycle.poolsRefusal].filter { !$0.isEmpty })
            .joined(separator: "\n")
        if networkPoolsHeld != held { networkPoolsHeld = held }
    }

    private func postNetworkAdmit(_ snapshot: NetworkSnapshot, now: TimeInterval) async {
        let (limit, load, autoRun) = (autoTaskLimit, autoTasksMeasured, queueAutoRun)
        let answer = await Task.detached(priority: .utility) {
            NetworkAdmit.slots(
                limit: limit, running: NetworkAdmit.running(snapshot) + load,
                lowDisk: Store.agentDisk()?.low == true,
                affordable: !AutoBudget.enabled || AutoBudget.decide().affordable,
                autoRun: autoRun)
        }.value
        // An unreadable config left the budget above on defaults.
        guard answer != networkCycle.admit
                || now - networkCycle.admitAt >= NetworkCycle.admitEvery,
              !AppConfig.unreadable else { return }
        let body = answer.body
        let reply = await Task.detached(priority: .utility) {
            DiplomacyNetwork.post(NetworkRoute.admit, body)
        }.value
        if case .ok = reply {
            networkCycle.admit = answer
            networkCycle.admitAt = now
        }
    }

    // MARK: runs

    func withdrawForgotten(_ record: AgentState.RunRecord) async {
        let snapshot = await Task.detached(priority: .utility) { DiplomacyNetwork.state() }.value
        let evidence = AgentState.Evidence(network: NetworkEvidence.tasks(snapshot))
        guard let task = AgentState.withdrawOnForget(record, evidence: evidence) else { return }
        await withdraw(task, reason: NetworkRoute.withdrawForgotten,
                       label: record.label.isEmpty ? record.runID : record.label,
                       source: "panel")
    }

    /// Twin of `Store._withdraw_unowed_async`.
    func withdrawUnowed(_ tasks: Set<String>) async {
        let snapshot = await Task.detached(priority: .utility) { DiplomacyNetwork.state() }.value
        let evidence = AgentState.Evidence(network: NetworkEvidence.tasks(snapshot))
        for r in AgentRegistry.load() where tasks.contains(r.network ?? "") {
            guard let task = AgentState.withdrawOnForget(r, evidence: evidence) else { continue }
            await withdraw(task, reason: NetworkRoute.withdrawNotOwed,
                           label: r.label.isEmpty ? r.runID : r.label, source: "auto")
        }
    }

    private func withdrawOffering(_ offering: [OfferingJob]) async {
        guard !offering.isEmpty else { return }
        let snapshot = await Task.detached(priority: .utility) { DiplomacyNetwork.state() }.value
        for held in offering {
            guard let task = held.task(in: snapshot) else {
                AuditLog.log(held.source.rawValue, NetworkAudit.unavailable,
                             "\(held.job.label) was not offered: \(DiplomacyNetwork.switchedOff)")
                continue
            }
            await withdraw(task, reason: NetworkRoute.withdrawSwitchedOff, label: held.rowLabel,
                           source: held.source.rawValue)
        }
        refreshAudit()
    }

    @discardableResult
    private func withdraw(_ task: String, reason: String, label: String,
                          source: String) async -> DiplomacyNetwork.Reply {
        let body = NetworkRoute.withdrawBody(task: task, reason: reason)
        let reply = await Task.detached(priority: .userInitiated) {
            DiplomacyNetwork.post(NetworkRoute.withdraw, body)
        }.value
        switch reply {
        case .ok:
            AuditLog.log(source, NetworkAudit.withdraw, "\(label) - withdrawn (\(reason))")
        case .refused(let why):
            AuditLog.log(source, NetworkAudit.withdraw, "\(label) - not withdrawn: \(why)")
        case .down:
            AuditLog.log(source, NetworkAudit.withdraw,
                         "\(label) - not withdrawn: \(DiplomacyNetwork.notAnswering)")
        }
        refreshAudit()
        return reply
    }

    /// A run already gone is reported, not withdrawn instead: the button promised the
    /// job goes back to the pool.
    func stopNetworkTask(_ task: NetworkSnapshot.Task, pool: String) async {
        if task.executorHere {
            await stopRun(of: task, pool: pool)
        } else {
            let reply = await withdraw(task.taskId, reason: NetworkRoute.withdrawStopped,
                                       label: task.title, source: "panel")
            if case .ok = reply { forgetOffered(task.taskId) }
            noteNetworkReply(reply, about: pool)
        }
        await settleAgents()
    }

    private func stopRun(of task: NetworkSnapshot.Task, pool: String) async {
        // The published snapshot may be a tick old.
        let fresh = await Task.detached(priority: .userInitiated) { DiplomacyNetwork.state() }.value
        guard let run = fresh?.runs.first(where: {
            $0.taskId == task.taskId && NetworkAdmit.live.contains($0.state)
        }) else {
            networkRefusals[pool] = fresh == nil ? DiplomacyNetwork.notAnswering
                                                 : DiplomacyNetwork.runEnded
            return
        }
        let body = NetworkRoute.stopRunBody(run: run.runId)
        let reply = await Task.detached(priority: .userInitiated) {
            DiplomacyNetwork.post(NetworkRoute.stopRun, body)
        }.value
        if case .ok = reply {
            AuditLog.log("panel", NetworkAudit.stop, "\(task.title) - \(NetworkText.runStopped)")
            refreshAudit()
        }
        noteNetworkReply(reply, about: pool)
    }

    // MARK: pools

    func networkInvite(pool: String) async -> String? {
        let body = NetworkRoute.inviteBody(pool: pool)
        let reply = await Task.detached(priority: .userInitiated) {
            DiplomacyNetwork.post(NetworkRoute.invite, body)
        }.value
        noteNetworkReply(reply, about: pool)
        guard case .ok(let answer) = reply, let invite = answer?["invite"]?.string,
              !invite.isEmpty else {
            if case .ok = reply { networkRefusals[pool] = "the daemon gave no invite" }
            return nil
        }
        AuditLog.log("panel", NetworkAudit.invite, "Made an invite to \(pool)")
        refreshAudit()
        return invite
    }

    /// `card`: the panel the invite was pasted into, which shows a refusal.
    func joinNetworkPool(invite: String, card: String) async -> Bool {
        let body = NetworkRoute.joinBody(invite: invite)
        let reply = await Task.detached(priority: .userInitiated) {
            DiplomacyNetwork.post(NetworkRoute.join, body)
        }.value
        noteNetworkReply(reply, about: card)
        guard case .ok(let answer) = reply else { return false }
        AuditLog.log("panel", NetworkAudit.join,
                     "Joining \(answer?["pool"]?.string ?? "a pool"): \(NetworkText.seatedLater)")
        refreshAudit()
        await runNetworkCycleOnce()
        return true
    }

    func rejoinNetworkPool(_ pool: String) async {
        let body = NetworkRoute.joinBody(pool: pool)
        let reply = await Task.detached(priority: .userInitiated) {
            DiplomacyNetwork.post(NetworkRoute.join, body)
        }.value
        noteNetworkReply(reply, about: pool)
        guard case .ok = reply else { return }
        AuditLog.log("panel", NetworkAudit.join, "Rejoined \(pool)")
        refreshAudit()
        await runNetworkCycleOnce()
    }

    func leaveNetworkPool(_ pool: String) async {
        let body = NetworkRoute.leaveBody(pool: pool)
        let reply = await Task.detached(priority: .userInitiated) {
            DiplomacyNetwork.post(NetworkRoute.leave, body)
        }.value
        noteNetworkReply(reply, about: pool)
        guard case .ok = reply else { return }
        AuditLog.log("panel", NetworkAudit.leave, "Left \(pool)")
        refreshAudit()
        await runNetworkCycleOnce()
    }

    /// `pool` is a pool id, or "" for the panel shown before any pool.
    private func noteNetworkReply(_ reply: DiplomacyNetwork.Reply, about pool: String) {
        switch reply {
        case .ok: networkRefusals[pool] = nil
        case .refused(let why): networkRefusals[pool] = why
        case .down: networkRefusals[pool] = DiplomacyNetwork.notAnswering
        }
    }

    // MARK: wizards

    func dispatchingText(terminal: String) -> String {
        networkEnabled ? NetworkText.offering : "Launching \(terminal)…"
    }
}
