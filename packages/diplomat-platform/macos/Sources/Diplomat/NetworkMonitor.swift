import Foundation
import DiplomatCore

/// What `Store.runNetworkCycleOnce` remembers between cycles.
struct NetworkCycle {
    /// How often `admit` is said again unchanged. The daemon takes nothing once it has
    /// not heard for 120 s.
    static let admitEvery: TimeInterval = 60
    /// The wait before a silent daemon is started again: doubled per attempt between
    /// these.
    static let firstStartDelay: TimeInterval = 15
    static let longestStartDelay: TimeInterval = 600

    /// The daemon the posts below went to, as its pid and start time. Another one has
    /// heard none of them.
    var daemon = ""
    var pools: [NetworkPools.Pool]?
    var admit: NetworkAdmit.Answer?
    var admitAt: TimeInterval = 0
    /// When the logins `pools` waits for were last asked after.
    var identitiesAskedAt: TimeInterval = 0
    var startAfter: TimeInterval = 0
    var startDelay: TimeInterval = 0
    /// Whether the feed has said a start failed, for the current silence.
    var startFailureLogged = false
    /// A cycle is in flight: the poll does not start a second beside it.
    var running = false
}

/// The Diplomacy Network's lifecycle, its per-cycle posts and the Network screen's
/// actions. The dispatch gate, the tick's evidence and a run's retirement are in
/// `Store.swift`, beside the local paths they stand in for.
extension Store {
    // MARK: lifecycle

    /// The switch moved: start the daemon, or retire the runs the network carried and
    /// stop it.
    func networkSwitched() {
        networkCycle = NetworkCycle()
        networkUnavailableLogged = false
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
                    // While the daemon is still there to hear a withdrawal.
                    await self.settleAgents()
                    await self.withdrawOffering(offering)
                    let result = await Task.detached(priority: .userInitiated) {
                        DiplomacyNetwork.stopDaemon()
                    }.value
                    AuditLog.log("panel", NetworkAudit.stop,
                                 "Stopped the Diplomacy Network daemon "
                                 + "(ok: \(!result.daemonRunning && result.error == nil))"
                                 + (result.error.map { ": \($0)" } ?? ""))
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

    /// Run the installer's start, and say how it went. A failed start is said once for a
    /// silence when the cycle asked (`quietly`), every time when the operator did.
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

    /// The Network screen's Start and Restart.
    func startNetworkDaemon(restart: Bool) async {
        guard networkEnabled, !networkBusy else { return }
        await whileNetworkBusy {
            await self.startNetworkDaemon(source: "panel", restart: restart)
        }
        await runNetworkCycleOnce()
    }

    /// End the mesh node an earlier Diplomat left running, whatever the switch says.
    func endLegacyMeshNodes() async {
        let ended = await Task.detached(priority: .utility) {
            DiplomacyNetwork.endLegacyMeshNodes()
        }.value
        guard !ended.isEmpty else { return }
        AuditLog.log("auto", NetworkAudit.stop,
                     "Ended the retired mesh node (pid "
                     + ended.map(String.init).joined(separator: ", ") + ")")
        refreshAudit()
    }

    // MARK: one cycle

    /// One round with the daemon while the switch is on: read its snapshot, start it when
    /// it is silent, and tell it which pools this machine is in and how many more tasks
    /// it takes. `pools` is said when it changed and `admit` also once a minute; a
    /// daemon that started since is told both again.
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
        await postNetworkPools(now: now)
        await postNetworkAdmit(snapshot, now: now)
        await settleOffering(snapshot)
    }

    /// Start a daemon that is not answering, no sooner than its backoff allows.
    private func reviveNetworkDaemon(now: TimeInterval) async {
        guard DiplomacyNetwork.drivesDaemon, !networkBusy, now >= networkCycle.startAfter else {
            return
        }
        networkCycle.startDelay = min(max(networkCycle.startDelay * 2,
                                          NetworkCycle.firstStartDelay),
                                      NetworkCycle.longestStartDelay)
        networkCycle.startAfter = now + networkCycle.startDelay
        await whileNetworkBusy {
            await self.startNetworkDaemon(source: "auto", quietly: true)
        }
    }

    /// Say this machine's pools when they changed. The OTHER REPOS checkouts are read
    /// again first: one that could not be read may be back, and one may have gained a
    /// remote.
    private func postNetworkPools(now: TimeInterval) async {
        await rereadLocalRepos()
        let listing = networkPools()
        guard case .pools(let pools) = listing else {
            if case .held(let why) = listing, networkPoolsHeld != why { networkPoolsHeld = why }
            if now - networkCycle.identitiesAskedAt >= NetworkCycle.admitEvery {
                networkCycle.identitiesAskedAt = now
                await readNetworkIdentities()
            }
            return
        }
        if !networkPoolsHeld.isEmpty { networkPoolsHeld = "" }
        guard pools != networkCycle.pools else { return }
        let body = NetworkPools.body(pools)
        let reply = await Task.detached(priority: .utility) {
            DiplomacyNetwork.post(NetworkRoute.pools, body)
        }.value
        if case .ok = reply { networkCycle.pools = pools }
    }

    /// The free bays of the cap less what runs here for the network and for this
    /// machine's own queue, or none for the reason the local gate would hold a job.
    private func postNetworkAdmit(_ snapshot: NetworkSnapshot, now: TimeInterval) async {
        let (limit, load, autoRun) = (autoTaskLimit, autoTasksMeasured, queueAutoRun)
        let answer = await Task.detached(priority: .utility) {
            NetworkAdmit.slots(
                limit: limit, running: NetworkAdmit.running(snapshot) + load,
                lowDisk: Store.agentDisk()?.low == true,
                affordable: !AutoBudget.enabled || AutoBudget.decide().affordable,
                autoRun: autoRun)
        }.value
        guard answer != networkCycle.admit
                || now - networkCycle.admitAt >= NetworkCycle.admitEvery else { return }
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

    /// Withdraw the offer of a run the operator removed, while the network still holds
    /// it.
    func withdrawForgotten(_ record: AgentState.RunRecord) async {
        let snapshot = await Task.detached(priority: .utility) { DiplomacyNetwork.state() }.value
        let evidence = AgentState.Evidence(network: NetworkEvidence.tasks(snapshot))
        guard let task = AgentState.withdrawOnForget(record, evidence: evidence) else { return }
        await withdraw(task, reason: NetworkRoute.withdrawForgotten,
                       label: record.label.isEmpty ? record.runID : record.label,
                       source: "panel")
    }

    /// The switch went off over jobs whose offer was never definitely answered: withdraw
    /// each one the daemon turns out to hold.
    private func withdrawOffering(_ offering: [OfferingJob]) async {
        guard !offering.isEmpty else { return }
        let snapshot = await Task.detached(priority: .utility) { DiplomacyNetwork.state() }.value
        for held in offering {
            guard let task = held.task(in: snapshot) else { continue }
            await withdraw(task, reason: NetworkRoute.withdrawSwitchedOff, label: held.rowLabel,
                           source: held.source.rawValue)
        }
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

    /// Stop one task of a pool: its run, when this machine is the one running it, else
    /// the offer this machine made of it.
    func stopNetworkTask(_ task: NetworkSnapshot.Task, pool: String) async {
        // Asked afresh: the published snapshot may be a tick old, and a run that ended
        // since is not there to stop.
        let runs = !task.executorHere ? [] : await Task.detached(priority: .userInitiated) {
            DiplomacyNetwork.state()?.runs ?? []
        }.value
        let run = runs.first { $0.taskId == task.taskId && NetworkAdmit.live.contains($0.state) }
        let reply: DiplomacyNetwork.Reply
        if let run {
            let body = NetworkRoute.stopRunBody(run: run.runId)
            reply = await Task.detached(priority: .userInitiated) {
                DiplomacyNetwork.post(NetworkRoute.stopRun, body)
            }.value
            if case .ok = reply {
                AuditLog.log("panel", NetworkAudit.stop,
                             "\(task.title) - \(NetworkText.runStopped)")
                refreshAudit()
            }
        } else {
            reply = await withdraw(task.taskId, reason: NetworkRoute.withdrawStopped,
                                   label: task.title, source: "panel")
            if case .ok = reply { forgetOffered(task.taskId) }
        }
        noteNetworkReply(reply, about: pool)
        await settleAgents()
    }

    // MARK: pools

    /// An invite to `pool`, or nil with the refusal kept for the screen.
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

    /// Join the pool an invite is to. False with the refusal kept for `card`, the panel
    /// the invite was pasted into.
    func joinNetworkPool(invite: String, card: String) async -> Bool {
        let body = NetworkRoute.joinBody(invite: invite)
        let reply = await Task.detached(priority: .userInitiated) {
            DiplomacyNetwork.post(NetworkRoute.join, body)
        }.value
        noteNetworkReply(reply, about: card)
        guard case .ok(let answer) = reply else { return false }
        AuditLog.log("panel", NetworkAudit.join,
                     "Joined \(answer?["pool"]?.string ?? "a pool")")
        refreshAudit()
        await runNetworkCycleOnce()
        return true
    }

    /// Go back into a pool this machine left.
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

    /// Keep what an action was refused with under the panel it was made in (a pool's id,
    /// or "" before any pool), or clear what the last one there was.
    private func noteNetworkReply(_ reply: DiplomacyNetwork.Reply, about pool: String) {
        switch reply {
        case .ok: networkRefusals[pool] = nil
        case .refused(let why): networkRefusals[pool] = why
        case .down: networkRefusals[pool] = DiplomacyNetwork.notAnswering
        }
    }

    // MARK: wizards

    /// What a wizard says between its button and the dispatch's answer.
    func dispatchingText(terminal: String) -> String {
        networkEnabled ? NetworkText.offering : "Launching \(terminal)…"
    }
}
