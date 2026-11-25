import Foundation
import DiplomatCore

/// Bridge to the Diplomacy Network daemon (`packages/diplomacy-network`); the protocol
/// itself is the shared core's (`Network.swift`).
enum DiplomacyNetwork {
    static let package = NodePackage.diplomacyNetwork

    static var hoursRange: ClosedRange<Int> {
        NetworkSettings.hoursFloor...NetworkSettings.hoursCeiling
    }
    static let hoursStep = 12

    /// Telemetry `runner` for a task another machine ran. Matching no `AgentRunner`, it
    /// counts against no rate-limit window here and prices no runner's tasks.
    static let foreignRunner = "network"

    static let notAnswering = "the Diplomacy Network daemon is not answering"
    static let runEnded = "That job's run on this machine has already ended."
    static let switchedOff = "the Diplomacy Network is switched off"

    enum Reply: Equatable {
        case ok(JSONValue?)
        case refused(String)
        case down
    }

    enum Reach: Equatable {
        case answered
        /// No reply, or a 5xx: the daemon may have acted on it.
        case unsure
        case unreached
    }

    /// Blocking: call off the main actor.
    static func ask(_ route: String, _ body: [String: Any],
                    timeoutSecs: Int = 15) -> (reply: Reply, reach: Reach) {
        switch package.send(route, body: body, timeoutSecs: timeoutSecs) {
        case .unreachable: return (.down, .unreached)
        case .unanswered: return (.down, .unsure)
        case .reply(let r) where (200..<300).contains(r.status): return (.ok(r.json), .answered)
        case .reply(let r):
            return (.refused(r.json?["error"]?.string ?? "the daemon answered HTTP \(r.status)"),
                    r.status >= 500 ? .unsure : .answered)
        }
    }

    /// For a caller that never repeats a request; one that does needs `ask`'s `Reach`.
    static func post(_ route: String, _ body: [String: Any], timeoutSecs: Int = 15) -> Reply {
        ask(route, body, timeoutSecs: timeoutSecs).reply
    }

    /// Blocking.
    static func state() -> NetworkSnapshot? {
        NetworkSnapshot.parse(package.get(NetworkRoute.state, timeoutSecs: 3))
    }

    // MARK: installer (blocking - call off the main thread)

    static var installerForSelfTest: (@Sendable (String) -> AllocatorInstall)?

    static var ready: Bool { package.packageAvailable && NodePackage.resolveNode() != nil }

    static var drivesDaemon: Bool { !Headless.active || installerForSelfTest != nil }

    private static func run(_ verb: String, deps: Bool = false) -> AllocatorInstall {
        if Headless.active { return installerForSelfTest?(verb) ?? .unknown }
        if deps { package.ensureDeps() }
        return package.runInstaller(verb)
    }

    static func startDaemon() -> AllocatorInstall { run("--start-daemon", deps: true) }
    static func restartDaemon() -> AllocatorInstall { run("--restart-daemon", deps: true) }
    static func stopDaemon() -> AllocatorInstall { run("--stop-daemon") }

    static func stoppedLine(_ result: AllocatorInstall) -> String {
        let said = [("cancelling", result.endedOffers, "offer"), ("ending", result.endedRuns, "run")]
            .filter { $0.1 > 0 }
            .map { "\($0.0) \($0.1) \($0.2)\($0.1 == 1 ? "" : "s")" }
        return "Stopped the Diplomacy Network daemon "
            + "(ok: \(!result.daemonRunning && result.error == nil))"
            + (said.isEmpty ? ""
                : ", \(said.joined(separator: " and ")) the daemon had left in its store")
            + (result.error.map { ": \($0)" } ?? "")
    }

    // MARK: the retired mesh node

    static let legacyModule = "szpontnet"

    static var legacyStateDir: URL? = Headless.active ? nil
        : FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".diplomat/mesh")
    static var legacyExitWait: TimeInterval = 5

    /// Seams a self-test fills.
    static var argumentsOf: @Sendable (Int) -> [String]? = {
        SingleInstance.arguments(of: pid_t($0))
    }
    static var terminate: @Sendable (Int) -> Bool = {
        !Headless.active && kill(pid_t($0), SIGTERM) == 0
    }

    static func isLegacyMeshNode(_ argv: [String]) -> Bool {
        zip(argv, argv.dropFirst()).contains { $0 == "-m" && $1 == legacyModule }
    }

    /// Another user's process shows no argv, so it is never one.
    private static func legacyNodeRunning(_ pid: Int) -> Bool {
        pid != Int(getpid()) && argumentsOf(pid).map(isLegacyMeshNode) == true
    }

    /// End the node `state.json` names and remove its directory, keys included. A pid
    /// that is not this user's `-m szpontnet` is the operator's own program and is left
    /// alone; a node still running after `legacyExitWait` keeps the directory. A
    /// symlinked directory loses only the link. Blocking.
    static func retireLegacyMeshNode() -> (asked: Int?, removed: String?, link: Bool) {
        var isDir: ObjCBool = false
        guard let dir = legacyStateDir,
              FileManager.default.fileExists(atPath: dir.path, isDirectory: &isDir),
              isDir.boolValue else { return (nil, nil, false) }
        let link = (try? FileManager.default.destinationOfSymbolicLink(atPath: dir.path)) != nil
        let state = (try? Data(contentsOf: dir.appendingPathComponent("state.json")))
            .flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [String: Any]
        var asked: Int?
        if let named = state?["pid"] as? NSNumber, CFGetTypeID(named) != CFBooleanGetTypeID(),
           !CFNumberIsFloatType(named), let fits = Int32(exactly: named.doubleValue), fits > 0,
           case let pid = Int(fits), legacyNodeRunning(pid) {
            if terminate(pid) { asked = pid }
            let deadline = Date().addingTimeInterval(legacyExitWait)
            while legacyNodeRunning(pid) {
                if Date() >= deadline { return (asked, nil, link) }
                Thread.sleep(forTimeInterval: 0.1)
            }
        }
        try? FileManager.default.removeItem(at: dir)
        return (asked, FileManager.default.fileExists(atPath: dir.path) ? nil : dir.path, link)
    }

    static func legacyRetiredLine(asked: Int?, removed: String?, link: Bool) -> String? {
        if let removed {
            let node = asked.map { "Ended the retired mesh node (pid \($0)) and removed" }
                ?? "Removed"
            return link
                ? "\(node) the link \(removed): what it leads to, the retired mesh's state "
                    + "and keys, is left as it is"
                : "\(node) \(removed), the retired mesh's state and keys"
        }
        guard let asked, let dir = legacyStateDir else { return nil }
        return "Asked the retired mesh node (pid \(asked)) to quit: \(dir.path) is removed "
            + "once it has"
    }
}

extension NetworkSnapshot {
    /// Equal but for `updatedAt`.
    func saysTheSame(as other: NetworkSnapshot?) -> Bool {
        guard let other else { return false }
        return pid == other.pid && startedAt == other.startedAt
            && testSettings == other.testSettings && pk == other.pk
            && onion == other.onion && transport == other.transport && docker == other.docker
            && model == other.model && devices == other.devices && admit == other.admit
            && pools == other.pools
            && runs == other.runs && offers == other.offers
    }
}

enum NetworkText {
    static let explanation = "Every job is offered to a shared pool per repository and runs "
        + "in a docker container, possibly on another machine in the pool."
    static let settingsExplanation = explanation + " While it is on, no agent starts in a "
        + "terminal on this machine. The pools and the hours a job may take are on the "
        + "Network screen."
    static let offering = "Offering to the pool…"
    static let offeringHelp = "The daemon has not answered this job's offer. Diplomat asks "
        + "it again until it does."
    static let rowHelp = "Open the Network screen."
    static let forgetHelp = "Withdraw this job from the pool and remove it from the list."
    static let symbol = "point.3.connected.trianglepath.dotted"

    static let switchTitle = "Offer every job to the Diplomacy Network"
    static let offNote = "Off: every job runs in a terminal on this machine."
    static let asking = "Asking the daemon…"
    static let silent = "Not answering. Diplomat starts it again on its own, waiting longer "
        + "after each try."
    static let restartHelp = "Stop the running daemon and start this checkout's. Jobs running "
        + "in containers here keep running, and the daemon that starts takes them up."
    static let requiredTitle = "Hours a job of yours may take"
    static let requiredSummary = "Counted from when a machine takes it. Only machines that "
        + "take jobs this long run yours."
    static let acceptedTitle = "Longest job this machine takes"
    static func hoursNote(required: Int, accepted: Int) -> String? {
        required > accepted
            ? "This machine takes none of its own jobs: one may take \(hours(required)), and "
                + "the longest job it takes is \(hours(accepted))."
            : nil
    }
    static let acceptedSummary = "A job that may take longer is left to the other machines "
        + "of its pool."
    static let devicesTitle = "Let jobs use this machine's devices"
    static let devicesSummary = "Off: jobs see no device. On: a job running here can use the "
        + "Android devices and emulators attached to this machine through adb - including a "
        + "phone on USB - and an emulator can reach services on this machine. It is one "
        + "switch for every pool this machine is in: switch it on only when you trust all "
        + "their machines with that. Either way it applies to jobs started afterwards."
    static let noPools = "No pools yet. Each repository in Settings gets one once Diplomat "
        + "knows which account works on it."
    static let noMembers = "No members listed yet."
    static let noTasks = "No tasks in this pool."
    static let noEvents = "No network actions in the activity feed."
    static let invitePlaceholder = "Paste an invite"
    static let inviteCopied = "Invite copied. Send it to the machine that should join."
    static let stopRunHelp = "Stop this job's run on this machine. It goes back to the pool."
    static let withdrawHelp = "Withdraw this job from the pool."

    static func stopButton(_ task: NetworkSnapshot.Task) -> (title: String, help: String) {
        task.executorHere ? ("Stop", stopRunHelp) : ("Withdraw", withdrawHelp)
    }
    /// This and `switchedOffRun` follow a task's title in the feed.
    static let runStopped = "its run on this machine was stopped and the job is back in the pool"
    static let switchedOffRun = "withdrawn: the Diplomacy Network was switched off"
    static let leftNote = "left - this machine takes and offers nothing here"
    static let seatedLater = "the machine that made the invite seats this one once it is reached"

    static var packageProblem: String? {
        let pkg = DiplomacyNetwork.package
        if !pkg.packageAvailable {
            return "⚠ Package not found at \(pkg.packageDir). Set "
                + "\(pkg.dirEnv) to point at it."
        }
        if NodePackage.resolveNode() == nil {
            return "⚠ Node.js not found. Install Node (or set DIPLOMAT_NODE): the daemon needs it."
        }
        return nil
    }

    static func leaveQuestion(_ pool: String) -> String {
        "Leave \(pool)? This machine stops taking its jobs and offering jobs to it."
    }

    static func short(_ pk: String) -> String { String(pk.prefix(8)) }

    static func counts(_ s: NetworkSnapshot) -> String {
        let pools = s.pools.filter { !$0.left }
        let tasks = pools.reduce(0) { $0 + $1.tasks.count }
        return "\(pools.count) \(pools.count == 1 ? "pool" : "pools") · "
            + "\(tasks) \(tasks == 1 ? "task" : "tasks")"
    }

    static func admit(_ a: NetworkSnapshot.Admit) -> String {
        if a.slots > 0 { return "taking \(a.slots) more" }
        return a.reason.isEmpty ? "taking nothing: full" : "taking nothing: \(a.reason)"
    }

    static func hours(_ h: Int) -> String { "\(h) h" }

    static func ago(_ at: Double?, now: Date) -> String {
        guard let at, at > 0 else { return "never seen" }
        return "seen " + MachinesText.ago(seconds: max(0, now.timeIntervalSince1970 - at))
    }

    static func state(_ state: String) -> String {
        switch state {
        case "available": return "in the pool"
        case "claimed": return "running"
        default: return state
        }
    }

    static func ending(of task: String, in snapshot: NetworkSnapshot?) -> String? {
        let offers = NetworkEvidence.tasks(snapshot)
        guard let offer = offers.value?[task], !offer.reason.isEmpty,
              offer.state == AgentState.NetworkTask.failed
                || offer.state == AgentState.NetworkTask.cancelled else { return nil }
        return AgentState.networkVerdict(task: task, network: offers, age: 0).1
    }

    static func joinable(_ typed: String, sending: Bool) -> String? {
        let token = typed.trimmingCharacters(in: .whitespacesAndNewlines)
        return token.isEmpty || sending ? nil : token
    }

    static func rowDetail(_ reason: String, offeredAt: TimeInterval, now: Date) -> String {
        let age = Fmt.duration(now.timeIntervalSince1970 - offeredAt)
        return age == "just now" ? reason : "\(reason) · offered \(age) ago"
    }

    static func poolJoining(_ pool: NetworkSnapshot.Pool) -> String? {
        pool.joining ? "Joining: \(seatedLater)" : nil
    }

    static func poolReturning(_ pool: NetworkSnapshot.Pool) -> String? {
        pool.returning && !pool.unseated
            ? "Returning: waiting for a machine this one knew here to let it back in; until "
                + "one does, it takes and offers none of this pool's jobs"
            : nil
    }

    static func poolUnseated(_ pool: NetworkSnapshot.Pool) -> String? {
        pool.unseated
            ? "No seat here: every machine this one asked refused it as no member, and it "
                + "needs an invite again"
            : nil
    }

    static func poolJoinFailed(_ pool: NetworkSnapshot.Pool) -> String? {
        pool.joinFailed.isEmpty ? nil : "The last invite came to nothing: \(pool.joinFailed)"
    }

    static func poolHeld(_ pool: NetworkSnapshot.Pool) -> String? {
        pool.notTaking.isEmpty ? nil
            : "This machine takes none of this pool's jobs: \(pool.notTaking)"
    }

    static func poolNotes(_ pool: NetworkSnapshot.Pool) -> [(text: String, warns: Bool)] {
        [(poolJoining(pool), false), (poolReturning(pool), false), (poolUnseated(pool), true),
         (poolJoinFailed(pool), true), (poolHeld(pool), true)]
            .compactMap { line, warns in line.map { ($0, warns) } }
    }

    /// Nil where the pool's card already says why (`NetworkEvidence.notTaking`).
    static func taskHeld(_ task: String, pool: NetworkSnapshot.Pool,
                         in snapshot: NetworkSnapshot?) -> String? {
        let why = NetworkEvidence.notTaking(task: task, pool: pool, in: snapshot)
        return why.isEmpty ? nil : "This machine is not taking this job: \(why)"
    }

    static func place(_ task: NetworkSnapshot.Task) -> String {
        var parts: [String] = []
        if task.offeredHere { parts.append("offered here") }
        if task.executorHere {
            parts.append("on this machine")
        } else if !task.executor.isEmpty {
            parts.append("on \(short(task.executor))")
        }
        if task.state == "claimed", let at = task.leaseUntil, at > 0 {
            parts.append("lease to " + Fmt.clock(Date(timeIntervalSince1970: at)))
        }
        return parts.joined(separator: " · ")
    }
}
