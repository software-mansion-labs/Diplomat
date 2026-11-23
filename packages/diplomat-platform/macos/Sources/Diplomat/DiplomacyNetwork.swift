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
    /// What a Stop says of a run the daemon no longer lists as going.
    static let runEnded = "That job's run on this machine has already ended."
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

    /// The feed line for a stop: how it went, and how many offers and runs the installer
    /// ended that the daemon had left in its store.
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

    /// The module the mesh node Diplomat once ran was started as (`python3 -m szpontnet`).
    static let legacyModule = "szpontnet"

    /// Where that node kept its state and its keys, and how long it is given to quit
    /// before the directory is left for the next launch. A headless run has no such
    /// directory of its own: a self-test names a scratch one.
    static var legacyStateDir: URL? = Headless.active ? nil
        : FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".diplomat/mesh")
    static var legacyExitWait: TimeInterval = 5

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

    /// Another user's process shows no argv, so it is never one.
    private static func legacyNodeRunning(_ pid: Int) -> Bool {
        pid != Int(getpid()) && argumentsOf(pid).map(isLegacyMeshNode) == true
    }

    /// End that node and remove its directory, keys included. The node is the pid the
    /// directory's `state.json` names - a JSON integer from 1 to 2^31 - 1, the pids a
    /// process can have - while that pid is a `-m szpontnet` of this user: a node kept
    /// anywhere else is its operator's own program. One still running after
    /// `legacyExitWait` keeps the directory. A directory that is a link loses the link
    /// alone: what it leads to was put there by its operator. Returns the pid asked to
    /// quit and the directory removed, each nil when there was none, and whether that
    /// directory is a link. Blocking.
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

    /// What the feed says of `retireLegacyMeshNode`; nil when it found nothing.
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
    /// Whether `other` says what this does, whenever each was written.
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

/// The Network screen's words, and the ones a network run's row and the activity feed
/// share with it.
enum NetworkText {
    static let explanation = "Every job is offered to a shared pool per repository and runs "
        + "in a docker container, possibly on another machine in the pool."
    /// What Settings says under the switch, the Network screen being elsewhere.
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
    /// What the two hours say together when a job of this machine's own may take longer
    /// than the longest job it takes, or nil.
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
    /// What a join by invite waits for, as the feed's line and the pool's card end.
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

    /// The invite a join row may send: what is typed without the space around it, or nil
    /// for an empty field and while a join is being sent.
    static func joinable(_ typed: String, sending: Bool) -> String? {
        let token = typed.trimmingCharacters(in: .whitespacesAndNewlines)
        return token.isEmpty || sending ? nil : token
    }

    /// The line under a run the network carries in the task list: where the daemon says
    /// it is, and how long since it was offered once that is a minute or more.
    static func rowDetail(_ reason: String, offeredAt: TimeInterval, now: Date) -> String {
        let age = Fmt.duration(now.timeIntervalSince1970 - offeredAt)
        return age == "just now" ? reason : "\(reason) · offered \(age) ago"
    }

    /// A pool card's line while an invite pasted here waits for its maker, or nil.
    static func poolJoining(_ pool: NetworkSnapshot.Pool) -> String? {
        pool.joining ? "Joining: \(seatedLater)" : nil
    }

    /// A pool card's line while this machine, back in the pool, waits to be let back in,
    /// or nil. Once every machine it asked refused it, `poolUnseated` says so instead.
    static func poolReturning(_ pool: NetworkSnapshot.Pool) -> String? {
        pool.returning && !pool.unseated
            ? "Returning: waiting for a machine this one knew here to let it back in; until "
                + "one does, it takes and offers none of this pool's jobs"
            : nil
    }

    /// A pool card's line once every machine this one asked refused it as no member, or nil.
    static func poolUnseated(_ pool: NetworkSnapshot.Pool) -> String? {
        pool.unseated
            ? "No seat here: every machine this one asked refused it as no member, and it "
                + "needs an invite again"
            : nil
    }

    /// A pool card's line on why the last invite let this machine in nowhere, or nil.
    static func poolJoinFailed(_ pool: NetworkSnapshot.Pool) -> String? {
        pool.joinFailed.isEmpty ? nil : "The last invite came to nothing: \(pool.joinFailed)"
    }

    /// A pool card's line on why this machine takes none of its jobs, or nil.
    static func poolHeld(_ pool: NetworkSnapshot.Pool) -> String? {
        pool.notTaking.isEmpty ? nil
            : "This machine takes none of this pool's jobs: \(pool.notTaking)"
    }

    /// The lines a pool card this machine has not left says above its members, in order;
    /// `warns` tints a line as a warning.
    static func poolNotes(_ pool: NetworkSnapshot.Pool) -> [(text: String, warns: Bool)] {
        [(poolJoining(pool), false), (poolReturning(pool), false), (poolUnseated(pool), true),
         (poolJoinFailed(pool), true), (poolHeld(pool), true)]
            .compactMap { line, warns in line.map { ($0, warns) } }
    }

    /// A task row's line on why this machine does not take that job of its own, where
    /// the pool's card does not say it already (`NetworkEvidence.notTaking`), or nil.
    static func taskHeld(_ task: String, pool: NetworkSnapshot.Pool,
                         in snapshot: NetworkSnapshot?) -> String? {
        let why = NetworkEvidence.notTaking(task: task, pool: pool, in: snapshot)
        return why.isEmpty ? nil : "This machine is not taking this job: \(why)"
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
