import Foundation
import DiplomatCore

/// Bridge to the Diplomacy Network daemon (`packages/diplomacy-network`): its local
/// socket's routes and its installer's daemon verbs. What is said over them is the
/// shared core's (`Network.swift`).
enum DiplomacyNetwork {
    static let package = NodePackage.diplomacyNetwork

    static var hoursRange: ClosedRange<Int> {
        NetworkSettings.hoursFloor...NetworkSettings.hoursCeiling
    }
    /// What one press of an hours stepper moves it by.
    static let hoursStep = 12

    /// The telemetry ledger's `runner` for a task another machine ran. No `AgentRunner`
    /// spells it, so its tokens count against no rate-limit window here
    /// (`Telemetry.Task.anthropic`) and its dollars price no runner's tasks
    /// (`Telemetry.summarize`'s `usdRunner`).
    static let foreignRunner = "network"

    static let notAnswering = "the Diplomacy Network daemon is not answering"
    static let switchedOff = "the Diplomacy Network is switched off"

    /// What the daemon said to one request.
    enum Reply: Equatable {
        case ok(JSONValue?)
        /// Refused: the sentence it gave.
        case refused(String)
        /// No daemon answered.
        case down
    }

    /// How far a request got.
    enum Reach: Equatable {
        /// The daemon gave a definite answer: it took the request, or refused it (a 4xx).
        case answered
        /// Sent, with no definite answer: no reply, or a fault of the daemon's own (a
        /// 5xx). The daemon may have acted on it.
        case unsure
        /// It never reached a daemon.
        case unreached
    }

    /// POST to one of `NetworkRoute`'s routes: what the daemon said, and how far the
    /// request got. Blocking, so off the main actor.
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

    /// `ask`, for a caller that does not repeat a request.
    static func post(_ route: String, _ body: [String: Any], timeoutSecs: Int = 15) -> Reply {
        ask(route, body, timeoutSecs: timeoutSecs).reply
    }

    /// `GET /state`, or nil when no daemon answered with a snapshot. Blocking.
    static func state() -> NetworkSnapshot? {
        NetworkSnapshot.parse(package.get(NetworkRoute.state, timeoutSecs: 3))
    }

    // MARK: installer (blocking - call off the main thread)

    /// Stands in for the installer in a headless run, which starts no daemon.
    static var installerForSelfTest: (@Sendable (String) -> AllocatorInstall)?

    /// The package and node are both there to run the installer.
    static var ready: Bool { package.packageAvailable && NodePackage.resolveNode() != nil }

    /// Whether this process starts and stops the daemon at all: the live app, or a
    /// self-test that brought its own installer.
    static var drivesDaemon: Bool { !Headless.active || installerForSelfTest != nil }

    private static func run(_ verb: String, deps: Bool = false) -> AllocatorInstall {
        if Headless.active { return installerForSelfTest?(verb) ?? .unknown }
        if deps { package.ensureDeps() }
        return package.runInstaller(verb)
    }

    static func startDaemon() -> AllocatorInstall { run("--start-daemon", deps: true) }
    static func restartDaemon() -> AllocatorInstall { run("--restart-daemon", deps: true) }
    static func stopDaemon() -> AllocatorInstall { run("--stop-daemon") }

    // MARK: the retired mesh node

    /// The module the mesh node Diplomat once ran was started as (`python3 -m szpontnet`).
    static let legacyModule = "szpontnet"

    /// A process's argv, and the signal that ends it: the kernel's, behind a seam a
    /// self-test fills. A headless run signals nothing of its own accord.
    static var argumentsOf: @Sendable (Int) -> [String]? = {
        SingleInstance.arguments(of: pid_t($0))
    }
    static var terminate: @Sendable (Int) -> Bool = {
        !Headless.active && kill(pid_t($0), SIGTERM) == 0
    }

    /// Whether `argv` starts that node: `-m` directly followed by the module, each a
    /// whole element. A path or another module's name that contains the word is neither.
    static func isLegacyMeshNode(_ argv: [String]) -> Bool {
        zip(argv, argv.dropFirst()).contains { $0 == "-m" && $1 == legacyModule }
    }

    /// End every such node this user runs, and return the pids signalled. Another user's
    /// process shows no argv, so it is never one. Blocking.
    static func endLegacyMeshNodes(now: TimeInterval = Date().timeIntervalSince1970) -> [Int] {
        let own = Int(getpid())
        return AgentProbes.pids(mentioning: legacyModule, now: now).filter { pid in
            pid != own && argumentsOf(pid).map(isLegacyMeshNode) == true && terminate(pid)
        }
    }
}

extension NetworkSnapshot {
    /// Whether `other` says what this does, whenever each was written.
    func saysTheSame(as other: NetworkSnapshot?) -> Bool {
        guard let other else { return false }
        return pid == other.pid && startedAt == other.startedAt && pk == other.pk
            && onion == other.onion && transport == other.transport && docker == other.docker
            && model == other.model && devices == other.devices && admit == other.admit
            && pools == other.pools
            && runs == other.runs && offers == other.offers
    }
}

/// The Network screen's words, and the ones a network run's row and the activity feed
/// share with it.
enum NetworkText {
    static let explanation = "Every job is offered to a shared pool per repository and runs "
        + "in a docker container, possibly on another machine in the pool."
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
    static let acceptedSummary = "A job that may take longer is left to the other machines "
        + "of its pool."
    static let devicesTitle = "Let jobs use this machine's devices"
    static let devicesSummary = "Off: jobs see no device. On: a job running here can use the "
        + "Android devices and emulators attached to this machine through adb - including a "
        + "phone on USB - and an emulator can reach services on this machine. Switch it on "
        + "only for pools whose machines you trust with that."
    static let noPools = "No pools yet. Each repository in Settings gets one once Diplomat "
        + "knows which account works on it."
    static let noMembers = "No members listed yet."
    static let noTasks = "No tasks in this pool."
    static let noEvents = "No network actions in the activity feed."
    static let invitePlaceholder = "Paste an invite"
    static let inviteCopied = "Invite copied. Send it to the machine that should join."
    static let stopRunHelp = "Stop this job's run on this machine. It goes back to the pool."
    static let withdrawHelp = "Withdraw this job from the pool."

    /// The button that ends a pool's task from here, and its tooltip: the run, when this
    /// machine is running it, else the offer this machine made of it.
    static func stopButton(_ task: NetworkSnapshot.Task) -> (title: String, help: String) {
        task.executorHere ? ("Stop", stopRunHelp) : ("Withdraw", withdrawHelp)
    }
    /// The feed's words for a run stopped here, after the task's title.
    static let runStopped = "its run on this machine was stopped and the job is back in the pool"
    /// The feed's words for a run retired because the switch went off.
    static let switchedOffRun = "withdrawn: the Diplomacy Network was switched off"
    static let leftNote = "left - this machine takes and offers nothing here"

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

    /// A member's or executor's key as it is shown.
    static func short(_ pk: String) -> String { String(pk.prefix(8)) }

    /// The pools this machine is in and what they hold; one it left is not counted.
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

    /// A pool task's state as the screen words it.
    static func state(_ state: String) -> String {
        switch state {
        case "available": return "in the pool"
        case "claimed": return "running"
        default: return state
        }
    }

    /// How the offer this machine made of `task` ended, in the words its run's row has,
    /// where the daemon gave a reason; nil for any other task.
    static func ending(of task: String, in snapshot: NetworkSnapshot?) -> String? {
        let offers = NetworkEvidence.tasks(snapshot)
        guard let offer = offers.value?[task], !offer.reason.isEmpty,
              offer.state == AgentState.NetworkTask.failed
                || offer.state == AgentState.NetworkTask.cancelled else { return nil }
        return AgentState.networkVerdict(task: task, network: offers, age: 0).1
    }

    /// Where a pool's task is and until when: "on this machine · lease to 14:05".
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
