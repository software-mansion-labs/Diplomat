import Foundation
import AppKit
import SwiftUI
import DiplomatCore

/// `DIPLOMAT_NETWORK_TEST=1`: the app's half of the Diplomacy Network (the core's is
/// pinned in `DiplomatCoreSmoke`): what the Store posts to the daemon each cycle, that a
/// job dispatched with the switch on is offered and never spawned, how an offered run
/// is drawn, withdrawn, priced and retired, what the switch going off does to the runs
/// the network still carries, and that the launch sweep ends the retired mesh node and
/// nothing else.
///
/// The daemon is a `FakeDaemon` on a scratch socket (`DN_BASE_DIR`), the installer and
/// the process table are stand-ins, and the feed, the run book and the shared config
/// are scratch. It opens no terminal: a dispatch that reached one would be refused and
/// counted (`AgentSpawner.refusedTerminals`), which is what the zero-spawn checks read.
enum NetworkTest {
    /// What the stand-in daemon answers with, changed between checks.
    private final class Script: @unchecked Sendable {
        private let lock = NSLock()
        private var snapshot: [String: Any] = [:]
        private var refusals: [String: (Int, String)] = [:]
        private var refusedItems: [String: (Int, String)] = [:]
        private var offers = 0
        private var asked: [String: Int] = [:]

        func set(_ doc: [String: Any]) {
            lock.lock(); defer { lock.unlock() }
            snapshot = doc
        }

        /// How many requests `route` has had.
        func count(_ route: String) -> Int {
            lock.lock(); defer { lock.unlock() }
            return asked[route] ?? 0
        }

        /// Answer `route` with this status and error until cleared with nil.
        func refuse(_ route: String, _ answer: (Int, String)?) {
            lock.lock(); defer { lock.unlock() }
            refusals[route] = answer
        }

        /// Answer the offers about `item` with this status and error until cleared with
        /// nil.
        func refuseOffer(item: String, _ answer: (Int, String)?) {
            lock.lock(); defer { lock.unlock() }
            refusedItems[item] = answer
        }

        func respond(_ route: String, _ body: [String: Any]) -> (Int, String) {
            lock.lock(); defer { lock.unlock() }
            asked[route, default: 0] += 1
            if let (status, error) = refusals[route]
                ?? (body["item"] as? String).flatMap({ refusedItems[$0] }) {
                return (status, NetworkTest.json(["error": error]))
            }
            switch route {
            case NetworkRoute.state: return (200, NetworkTest.json(snapshot))
            case NetworkRoute.offer:
                offers += 1
                return (200, NetworkTest.json(["taskId": "task-\(offers)"]))
            case NetworkRoute.invite: return (200, NetworkTest.json(["invite": "dn-invite-1"]))
            case NetworkRoute.join: return (200, NetworkTest.json(["pool": "github.com/o/r"]))
            default: return (200, NetworkTest.json(["ok": true]))
            }
        }
    }

    /// Records what a stand-in was asked.
    private final class Calls<T>: @unchecked Sendable {
        private let lock = NSLock()
        private var items: [T] = []
        var all: [T] { lock.lock(); defer { lock.unlock() }; return items }
        func add(_ item: T) { lock.lock(); items.append(item); lock.unlock() }
    }

    fileprivate static func json(_ object: Any) -> String {
        String(decoding: (try? JSONSerialization.data(withJSONObject: object)) ?? Data("{}".utf8),
               as: UTF8.self)
    }

    @discardableResult
    @MainActor
    static func run() async -> Bool {
        var pass = true
        func check(_ name: String, _ ok: Bool) {
            print("\(ok ? "PASS" : "FAIL") - \(name)")
            if !ok { pass = false }
        }

        // Short, because a unix socket path has about a hundred bytes.
        let scratch = FileManager.default.temporaryDirectory
            .appendingPathComponent("dn-\(getpid())")
        try? FileManager.default.removeItem(at: scratch)
        defer { try? FileManager.default.removeItem(at: scratch) }
        let base = scratch.appendingPathComponent("n")
        try? FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
        let feed = scratch.appendingPathComponent("audit")
        setenv("DIPLOMAT_AUDIT_DIR", feed.path, 1)
        setenv("DIPLOMAT_AGENTS_DIR", scratch.appendingPathComponent("agents").path, 1)
        setenv("DIPLOMAT_CONFIG", scratch.appendingPathComponent("config.json").path, 1)
        setenv("DIPLOMAT_COMMS_DIR", scratch.appendingPathComponent("comms").path, 1)
        setenv("DA_BAN_DIR", scratch.appendingPathComponent("bans").path, 1)
        setenv("DA_BASE_DIR", scratch.appendingPathComponent("allocator").path, 1)
        setenv(DiplomacyNetwork.package.baseEnv, base.path, 1)
        setenv("DIPLOMAT_QUOTA_PROBE", "0", 1)
        setenv(DiskFloor.envOverride, "0", 1)
        AgentProbes.pinDump(.present(""))
        defer { AgentProbes.pinDump(nil) }
        // A `gh` that answers nothing and notes what it was asked: a retired review run
        // has its review checked on GitHub.
        let ghLog = scratch.appendingPathComponent("gh.log")
        let gh = scratch.appendingPathComponent("gh")
        try? "#!/bin/sh\necho \"$*\" >> '\(ghLog.path)'\nexit 1\n"
            .write(to: gh, atomically: true, encoding: .utf8)
        chmod(gh.path, 0o755)
        setenv("DIPLOMAT_GH", gh.path, 1)
        func ghAsked(_ needle: String) -> Bool {
            ((try? String(contentsOf: ghLog, encoding: .utf8)) ?? "").contains(needle)
        }

        func feedDetails(_ action: String) -> [String] {
            let text = (try? String(contentsOf: feed.appendingPathComponent("audit.jsonl"),
                                    encoding: .utf8)) ?? ""
            return text.split(separator: "\n").compactMap { line in
                guard let obj = try? JSONSerialization.jsonObject(with: Data(line.utf8))
                        as? [String: Any], obj["action"] as? String == action else { return nil }
                return obj["detail"] as? String
            }
        }
        func ledger(_ event: String, key: String) -> [[String: Any]] {
            let text = (try? String(contentsOf: TelemetryLog.url, encoding: .utf8)) ?? ""
            return text.split(separator: "\n").compactMap { line in
                guard let obj = try? JSONSerialization.jsonObject(with: Data(line.utf8))
                        as? [String: Any], obj["ev"] as? String == event,
                      obj["key"] as? String == key else { return nil }
                return obj
            }
        }

        // MARK: the launch sweep

        // 1. The node the mesh directory's state.json names is ended while its argv is
        //    `-m szpontnet`, each a whole element, and the directory goes once it has
        //    quit. No other process is signalled, whatever its argv.
        let own = Int(getpid())
        let argvs: [Int: [String]] = [
            1: ["python3", "-m", "szpontnet"],
            4001: ["/usr/bin/python3", "-m", "szpontnet", "--daemon"],
            4002: ["/opt/szpontnet/bin/python3", "-m", "http.server"],
            4003: ["python3", "-m", "szpontnet.bench"],
            4004: ["python3", "-c", "run('-m szpontnet')"],
            4005: ["python3", "-m", "szpontnet"],
            4006: ["/bin/zsh", "-c", "python3 -m szpontnet"],
            4007: ["python3", "-m", "szpontnet"],
            own: ["python3", "-m", "szpontnet"],
            // No pid a process can have, whatever answers for it.
            0: ["python3", "-m", "szpontnet"], -1: ["python3", "-m", "szpontnet"],
            7: ["python3", "-m", "szpontnet"],
            2_147_483_648: ["python3", "-m", "szpontnet"],
            4_294_967_296: ["python3", "-m", "szpontnet"],
        ]
        let ended = Calls<Int>()
        let (realArguments, realTerminate) = (DiplomacyNetwork.argumentsOf, DiplomacyNetwork.terminate)
        let realExitWait = DiplomacyNetwork.legacyExitWait
        check("a headless run has no mesh directory of its own",
              DiplomacyNetwork.legacyStateDir == nil)
        let meshDir = scratch.appendingPathComponent("mesh")
        func meshNames(_ state: String?) {
            try? FileManager.default.createDirectory(at: meshDir, withIntermediateDirectories: true)
            try? Data("secret".utf8).write(to: meshDir.appendingPathComponent("device.key"))
            let file = meshDir.appendingPathComponent("state.json")
            if let state {
                try? Data(state.utf8).write(to: file)
            } else {
                try? FileManager.default.removeItem(at: file)
            }
        }
        func meshThere() -> Bool { FileManager.default.fileExists(atPath: meshDir.path) }
        let quits: @Sendable (Int) -> [String]? = { ended.all.contains($0) ? nil : argvs[$0] }
        DiplomacyNetwork.argumentsOf = quits
        DiplomacyNetwork.terminate = { ended.add($0); return true }
        DiplomacyNetwork.legacyExitWait = 0.3
        let store = Store()
        meshNames("{\"pid\": 4001}")
        await store.retireLegacyMeshNode()
        check("with no directory named, a launch signals nothing, removes nothing and is silent",
              ended.all.isEmpty && meshThere() && feedDetails(NetworkAudit.stop).isEmpty)
        try? FileManager.default.removeItem(at: meshDir)
        DiplomacyNetwork.legacyStateDir = meshDir
        await store.retireLegacyMeshNode()
        check("…and so does one whose directory is not there",
              ended.all.isEmpty && feedDetails(NetworkAudit.stop).isEmpty)
        let noNode: [String?] = [
            "{\"pid\": 4002}", "{\"pid\": 4003}", "{\"pid\": 4004}", "{\"pid\": 4006}",
            "{\"pid\": \(own)}", "{\"pid\": 4999}", "{\"pid\": \"4001\"}", "{\"pid\": 4001.0}",
            "{\"pid\": true}", "[4001]", "{ not json", nil,
            "{\"pid\": 0}", "{\"pid\": -1}", "{\"pid\": 1.0}", "{\"pid\": \"7\"}",
            "{\"pid\": [1]}", "{\"pid\": 2147483648}", "{\"pid\": 4294967296}",
            "{\"pid\": 99999999999999999999999}",
            "{\"pid\": \(4_294_967_296 + 4001)}",  // 4001, cut to 32 bits
        ]
        for state in noNode {
            meshNames(state)
            let before = feedDetails(NetworkAudit.stop).count
            await store.retireLegacyMeshNode()
            check("a directory that names no running node (\(state ?? "no state.json")) is "
                    + "removed, and nothing is signalled",
                  ended.all.isEmpty && !meshThere()
                    && Array(feedDetails(NetworkAudit.stop).dropFirst(before))
                        == ["Removed \(meshDir.path), the retired mesh's state and keys"])
        }
        DiplomacyNetwork.argumentsOf = realArguments
        for state in ["{\"pid\": 2147483648}", "{\"pid\": 4294967296}"] {
            meshNames(state)
            await store.retireLegacyMeshNode()
            check("…nor is the kernel asked of a pid it has no type for (\(state))",
                  ended.all.isEmpty && !meshThere())
        }
        DiplomacyNetwork.argumentsOf = quits
        meshNames("{\"pid\": 4001}")
        var stopsSaid = feedDetails(NetworkAudit.stop).count
        await store.retireLegacyMeshNode()
        check("the node the directory names is ended, no other, and the directory goes "
                + "with its keys",
              ended.all == [4001] && !meshThere()
                && Array(feedDetails(NetworkAudit.stop).dropFirst(stopsSaid))
                    == ["Ended the retired mesh node (pid 4001) and removed \(meshDir.path), "
                        + "the retired mesh's state and keys"])
        stopsSaid = feedDetails(NetworkAudit.stop).count
        await store.retireLegacyMeshNode()
        check("…and the launch after that finds nothing",
              ended.all == [4001] && feedDetails(NetworkAudit.stop).count == stopsSaid)
        DiplomacyNetwork.argumentsOf = { argvs[$0] }
        meshNames("{\"pid\": 4005}")
        let waited = Date()
        await store.retireLegacyMeshNode()
        let waitedFor = Date().timeIntervalSince(waited)
        check("a node that does not quit keeps its directory for the next launch, and the "
                + "feed says so",
              ended.all == [4001, 4005] && meshThere() && waitedFor >= 0.3 && waitedFor < 3
                && feedDetails(NetworkAudit.stop).last
                    == "Asked the retired mesh node (pid 4005) to quit: \(meshDir.path) is "
                        + "removed once it has")
        stopsSaid = feedDetails(NetworkAudit.stop).count
        DiplomacyNetwork.terminate = { _ in false }
        await store.retireLegacyMeshNode()
        check("a signal that fails is no node asked, and the directory stays",
              meshThere() && feedDetails(NetworkAudit.stop).count == stopsSaid)
        DiplomacyNetwork.argumentsOf = quits
        await store.retireLegacyMeshNode()
        check("once it has quit, the directory goes",
              !meshThere() && feedDetails(NetworkAudit.stop).last
                == "Removed \(meshDir.path), the retired mesh's state and keys")
        //    A directory that is a link loses the link: what it leads to is not
        //    Diplomat's to delete, and the feed says which of the two went.
        let behind = scratch.appendingPathComponent("mesh-elsewhere")
        DiplomacyNetwork.terminate = { ended.add($0); return true }
        for (pid, node, signalled) in [
            (4002, "Removed", [4001, 4005]),
            (4007, "Ended the retired mesh node (pid 4007) and removed", [4001, 4005, 4007]),
        ] {
            try? FileManager.default.createDirectory(at: behind, withIntermediateDirectories: true)
            try? Data("secret".utf8).write(to: behind.appendingPathComponent("device.key"))
            try? Data("{\"pid\": \(pid)}".utf8).write(to: behind.appendingPathComponent("state.json"))
            try? FileManager.default.createSymbolicLink(at: meshDir, withDestinationURL: behind)
            stopsSaid = feedDetails(NetworkAudit.stop).count
            await store.retireLegacyMeshNode()
            await store.retireLegacyMeshNode()
            check("a directory that is a link loses the link and keeps what it leads to (pid \(pid))",
                  ended.all == signalled
                    && (try? FileManager.default.destinationOfSymbolicLink(atPath: meshDir.path)) == nil
                    && (try? Data(contentsOf: behind.appendingPathComponent("device.key")))
                        == Data("secret".utf8)
                    && Array(feedDetails(NetworkAudit.stop).dropFirst(stopsSaid))
                        == ["\(node) the link \(meshDir.path): what it leads to, the retired "
                            + "mesh's state and keys, is left as it is"])
        }
        try? FileManager.default.removeItem(at: behind)
        DiplomacyNetwork.legacyStateDir = nil
        DiplomacyNetwork.legacyExitWait = realExitWait
        DiplomacyNetwork.argumentsOf = realArguments
        DiplomacyNetwork.terminate = realTerminate

        // MARK: the switch and the cycle

        let root = PRRef.LocalRepo(owner: "o", repo: "r",
                                   path: scratch.appendingPathComponent("r").path)
        let lab = PRRef.LocalRepo(owner: "acme", repo: "api",
                                  path: scratch.appendingPathComponent("api").path,
                                  host: "gitlab.example.com")
        store.pinRoots([root, lab])
        store.selectedRepo = ""
        store.writesConfig = true
        store.reviewRequestsEnabled = true
        store.prAutofixEnabled = true
        store.reviewAllowlistRaw = ""
        store.queueAutoRun = true
        store.autoBudgetGate = true
        store.autoTaskLimit = 3
        store.me = ""

        let here = "aaaa1111bbbb2222"
        let away = "cccc3333dddd4444"
        var daemonPid = 700
        func snapshot(offers: [[String: Any]] = [], runs: [[String: Any]] = [],
                      tasks: [[String: Any]] = [],
                      more: [[String: Any]] = []) -> [String: Any] {
            ["updatedAt": Date().timeIntervalSince1970,
             "daemon": ["pid": daemonPid, "startedAt": 1000 + daemonPid],
             "identity": ["pk": here, "onion": "x.onion"],
             "transport": ["state": "ready", "detail": ""],
             "docker": ["state": "ready", "image": "i", "detail": ""],
             "model": ["state": "ready", "detail": ""],
             "admit": ["slots": 0, "at": 0, "reason": ""],
             "pools": [["id": "github.com/o/r", "path": root.path, "identity": "latekvo",
                        "hash": "h", "members": [[String: Any]](), "tasks": tasks]] + more,
             "runs": runs, "offers": offers]
        }
        let script = Script()
        script.set(snapshot())
        let socket = DiplomacyNetwork.package.socketPath
        var daemon = FakeDaemon(path: socket, answering: true) { script.respond($0, $1) }
        check("the stand-in daemon listens on the scratch socket", daemon != nil)
        // Every request since the test began: a daemon stood up again starts a new list.
        var earlier: [(String, [String: Any])] = []
        func requests(_ route: String) -> [[String: Any]] {
            (earlier + (daemon?.requests ?? [])).filter { $0.0 == route }.map(\.1)
        }
        func stopDaemon() {
            earlier += daemon?.requests ?? []
            daemon?.stop()
            daemon = nil
        }
        func startDaemon() {
            daemon = FakeDaemon(path: socket, answering: true) { script.respond($0, $1) }
        }
        defer { daemon?.stop() }

        let installer = Calls<String>()
        // The withdrawals the daemon had heard each time it was told to stop.
        let withdrawnAtStop = Calls<Int>()
        // The offers and runs the next stop finds left in the store.
        let leftInStore = Calls<(Int, Int)>()
        // What the installer answers as its error, with no daemon running; "" for none.
        let installerError = Calls<String>()
        DiplomacyNetwork.installerForSelfTest = { verb in
            installer.add(verb)
            var result = AllocatorInstall()
            if verb == "--stop-daemon" {
                withdrawnAtStop.add(script.count(NetworkRoute.withdraw))
                (result.endedOffers, result.endedRuns) = leftInStore.all.last ?? (0, 0)
            }
            result.daemonRunning = verb != "--stop-daemon" && FileManager.default.fileExists(atPath: socket)
            if let why = installerError.all.last, !why.isEmpty {
                result.error = why
                result.daemonRunning = false
            }
            return result
        }
        defer { DiplomacyNetwork.installerForSelfTest = nil }

        // 2. Off, nothing is asked of the daemon, by the cycle or by a tick.
        await store.runNetworkCycleOnce()
        await store.settleAgents()
        check("with the switch off the daemon is asked nothing",
              (daemon?.requests ?? []).isEmpty && store.networkAnswered == nil)

        // 3. Switching on writes the key, runs the installer's start and says so.
        store.networkEnabled = true
        await store.networkLifecycle?.value
        check("switching on saves networkEnabled to config.json",
              AppConfig.read()[NetworkSettings.enabledKey] as? Bool == true)
        check("…runs the installer's --start-daemon once",
              installer.all == ["--start-daemon"])
        check("…and logs network-start", feedDetails(NetworkAudit.start).count == 1)
        check("…and the daemon's snapshot is published",
              store.networkAnswered == true && store.networkState?.pk == here)

        // 4. `pools` says every linked repository; one that cannot be confirmed holds
        //    back its own pool alone, which stays as the daemon has it.
        func postedPools() -> [String] {
            ((requests(NetworkRoute.pools).last?["pools"] as? [[String: String]]) ?? [])
                .map { $0["id"] ?? "" }
        }
        func poolsPosted() -> Int { requests(NetworkRoute.pools).count }
        let (noHubLogin, noLabLogin) = (
            NetworkPools.unconfirmed(account: "o/r", host: "github.com"),
            NetworkPools.unconfirmed(account: "acme/api", host: "gitlab.example.com"))
        check("with no login known, the pool the daemon has is said as it has it",
              poolsPosted() == 1
                && requests(NetworkRoute.pools).last?["pools"] as? [[String: String]]
                    == [["id": "github.com/o/r", "path": root.path, "forge": "github",
                         "identity": "latekvo"]]
                && store.networkPoolsHeld == "\(noHubLogin)\n\(noLabLogin)")
        store.me = "LatekVO"
        await store.runNetworkCycleOnce()
        check("a repository whose login is unknown holds back its own pool alone, and is named",
              poolsPosted() == 1 && store.networkPoolsHeld == noLabLogin)
        let asking = Date().timeIntervalSince1970
        store.networkCycle.identitiesAskedAt = asking - 59
        await store.runNetworkCycleOnce(now: asking)
        check("the logins it lacks are not asked after on every cycle",
              store.networkCycle.identitiesAskedAt == asking - 59)
        store.networkCycle.identitiesAskedAt = asking - 60
        await store.runNetworkCycleOnce(now: asking)
        check("…and are once a minute", store.networkCycle.identitiesAskedAt == asking)
        store.pinGitLabMe("ilatka", host: "gitlab.example.com")
        await store.runNetworkCycleOnce()
        let posted = requests(NetworkRoute.pools).last?["pools"] as? [[String: String]]
        check("with every login known the whole list is posted once",
              poolsPosted() == 2 && store.networkPoolsHeld.isEmpty
                && posted == [
                    ["id": "github.com/o/r", "path": root.path, "forge": "github",
                     "identity": "latekvo"],
                    ["id": "gitlab.example.com/acme/api", "path": lab.path, "forge": "gitlab",
                     "identity": "ilatka"],
                ])
        store.networkCycle.identitiesAskedAt = 0
        await store.runNetworkCycleOnce()
        check("an unchanged list is not posted again, and with nothing unconfirmed no login "
                + "is asked after",
              poolsPosted() == 2 && store.networkCycle.identitiesAskedAt == 0)

        //    A root that cannot be read keeps its pool as the daemon has it; one that
        //    was read and names no forge is no pool. Neither holds another pool back.
        let labPool = "gitlab.example.com/acme/api"
        store.pinRoots([root, lab], linked: [lab], unread: [root.path])
        await store.runNetworkCycleOnce()
        check("a root that cannot be read keeps its pool as the daemon has it, and is named",
              postedPools() == [labPool, "github.com/o/r"]
                && store.networkPoolsHeld == NetworkPools.unconfirmed(unread: root.path))
        let leftBefore = feedDetails(NetworkAudit.leave).count
        store.pinRoots([root, lab], linked: [lab])
        await store.runNetworkCycleOnce()
        check("a root that was read and names no forge is no pool, and holds nothing back",
              postedPools() == [labPool] && store.networkPoolsHeld.isEmpty
                && feedDetails(NetworkAudit.leave).count == leftBefore + 1
                && feedDetails(NetworkAudit.leave).last?.hasPrefix("Left github.com/o/r: ") == true)
        store.pinRoots([root, lab])
        await store.runNetworkCycleOnce()

        //    An OTHER REPOS checkout that cannot be read keeps the pool the daemon has
        //    for it until it can be, or is taken off the list; one that names no forge
        //    is left out.
        func git(_ arguments: String...) {
            let proc = Process()
            proc.executableURL = URL(fileURLWithPath: "/usr/bin/git")
            proc.arguments = arguments
            proc.standardOutput = Pipe()
            proc.standardError = Pipe()
            try? proc.run()
            proc.waitUntilExit()
        }
        let bare = scratch.appendingPathComponent("bare").path
        let gone = scratch.appendingPathComponent("unmounted/tool").path
        let whole = ["github.com/o/r", labPool]
        git("init", "-q", bare)
        store.localRepoPaths = [gone, bare]
        var sent = poolsPosted()
        await store.runNetworkCycleOnce()
        await store.runNetworkCycleOnce()
        check("a checkout that cannot be read holds nothing else back, and is named",
              poolsPosted() == sent && postedPools() == whole
                && store.networkPoolsHeld == NetworkPools.unconfirmed(unread: gone))
        git("init", "-q", gone)
        git("-C", gone, "remote", "add", "origin", "https://github.com/acme/tool.git")
        await store.runNetworkCycleOnce()
        check("readable again, it is posted on the next cycle; one naming no forge is left out",
              poolsPosted() == sent + 1 && store.networkPoolsHeld.isEmpty
                && postedPools() == whole + ["github.com/acme/tool"])
        let toolRow: [String: Any] = ["id": "github.com/acme/tool", "path": gone,
                                      "identity": "latekvo"]
        script.set(snapshot(more: [toolRow]))
        try? FileManager.default.removeItem(atPath: gone)
        await store.runNetworkCycleOnce()
        check("gone again, its pool stays as the daemon has it",
              poolsPosted() == sent + 1
                && store.networkPoolsHeld == NetworkPools.unconfirmed(unread: gone))
        git("-C", bare, "remote", "add", "origin", "https://github.com/acme/scratch.git")
        await store.runNetworkCycleOnce()
        check("…while a repository linked since gains its pool",
              postedPools() == whole + ["github.com/acme/scratch", "github.com/acme/tool"])
        let bareConfig = bare + "/.git/config"
        let sound = (try? String(contentsOfFile: bareConfig, encoding: .utf8)) ?? ""
        try? "[remote \"origin\"\n".write(toFile: bareConfig, atomically: true, encoding: .utf8)
        script.set(snapshot(more: [toolRow, ["id": "github.com/acme/scratch", "path": bare,
                                             "identity": "latekvo"]]))
        await store.runNetworkCycleOnce()
        check("a checkout git fails on is unread as well, its pool staying too",
              postedPools().sorted() == (whole + ["github.com/acme/scratch",
                                                  "github.com/acme/tool"]).sorted()
                && store.networkPoolsHeld == [gone, bare]
                    .map { NetworkPools.unconfirmed(unread: $0) }.joined(separator: "\n"))
        try? sound.write(toFile: bareConfig, atomically: true, encoding: .utf8)
        git("-C", bare, "remote", "set-url", "origin", "https://github.com/acme/renamed.git")
        let left = feedDetails(NetworkAudit.leave).count
        await store.runNetworkCycleOnce()
        check("a checkout that names another repository leaves the pool it named, and the "
                + "feed says so",
              postedPools() == whole + ["github.com/acme/renamed", "github.com/acme/tool"]
                && Array(feedDetails(NetworkAudit.leave).dropFirst(left))
                    == ["Left github.com/acme/scratch: \(bare) no longer names it"])
        store.localRepoPaths = []
        await store.runNetworkCycleOnce()
        check("a path taken off the list leaves its pool, readable or not",
              postedPools() == whole && store.networkPoolsHeld.isEmpty
                && feedDetails(NetworkAudit.leave).last
                    == "Left github.com/acme/scratch: \(bare) is no longer listed in Settings"
                && feedDetails(NetworkAudit.leave).contains(
                    "Left github.com/acme/tool: \(gone) is no longer listed in Settings"))
        script.set(snapshot())

        //    A list the daemon refuses is said once, shown, and sent again as it is no
        //    more often than admit; one it did not settle is sent on the next cycle.
        git("-C", bare, "remote", "set-url", "origin", "https://github.com/acme/scratch.git")
        let refusedAt = Date().timeIntervalSince1970
        let unavailableBefore = feedDetails(NetworkAudit.unavailable).count
        script.refuse(NetworkRoute.pools, (409, "A pool is listed twice."))
        store.localRepoPaths = [bare]
        sent = poolsPosted()
        await store.runNetworkCycleOnce(now: refusedAt)
        await store.runNetworkCycleOnce(now: refusedAt + 59)
        let refusal = "The daemon refused this machine's pools: A pool is listed twice."
        check("a list the daemon refuses is shown and said once, and not sent again as it is",
              poolsPosted() == sent + 1 && store.networkPoolsHeld == refusal
                && Array(feedDetails(NetworkAudit.unavailable).dropFirst(unavailableBefore))
                    == [refusal])
        await store.runNetworkCycleOnce(now: refusedAt + 60)
        check("…until a minute on",
              poolsPosted() == sent + 2
                && feedDetails(NetworkAudit.unavailable).count == unavailableBefore + 1)
        script.refuse(NetworkRoute.pools, (500, "boom"))
        store.localRepoPaths = []
        await store.runNetworkCycleOnce(now: refusedAt + 61)
        check("the list the daemon last took is no refused one",
              poolsPosted() == sent + 2 && store.networkPoolsHeld.isEmpty)
        store.localRepoPaths = [bare]
        await store.runNetworkCycleOnce(now: refusedAt + 62)
        await store.runNetworkCycleOnce(now: refusedAt + 63)
        check("a list the daemon did not settle is sent again on the next cycle, with nothing said",
              poolsPosted() == sent + 4 && store.networkPoolsHeld.isEmpty
                && feedDetails(NetworkAudit.unavailable).count == unavailableBefore + 1)
        script.refuse(NetworkRoute.pools, nil)
        store.localRepoPaths = []
        await store.runNetworkCycleOnce()

        // 5. `admit` is the cap less what runs here, said again when it changes and
        //    once a minute, and withheld for the reasons the local gate holds a job.
        func lastAdmit() -> [String: Any] { requests(NetworkRoute.admit).last ?? [:] }
        func admitIs(_ slots: Int, _ reason: String? = nil) -> Bool {
            lastAdmit()["slots"] as? Int == slots && lastAdmit()["reason"] as? String == reason
        }
        let t0 = Date().timeIntervalSince1970
        check("admit is posted with the whole cap free", admitIs(3))
        let admits = requests(NetworkRoute.admit).count
        await store.runNetworkCycleOnce(now: t0 + 30)
        check("an unchanged admit is not posted again inside a minute",
              requests(NetworkRoute.admit).count == admits)
        await store.runNetworkCycleOnce(now: t0 + 200)
        check("…and is posted again once a minute has passed",
              requests(NetworkRoute.admit).count == admits + 1 && admitIs(3))
        store.pinAutoTasksMeasured(2)
        await store.runNetworkCycleOnce(now: t0 + 201)
        check("admit counts the agents this machine runs for itself", admitIs(1))
        script.set(snapshot(runs: [["runId": "r1", "taskId": "x", "state": "running"],
                                   ["runId": "r0", "taskId": "w", "state": "finished"]]))
        await store.runNetworkCycleOnce(now: t0 + 202)
        check("…and the live runs it executes for the network", admitIs(0))
        script.set(snapshot())
        store.pinAutoTasksMeasured(0)
        setenv(DiskFloor.envOverride, "99999999999999999999", 1)
        await store.runNetworkCycleOnce(now: t0 + 203)
        check("a low disk admits nothing, and says disk", admitIs(0, NetworkAdmit.disk))
        setenv(DiskFloor.envOverride, "0", 1)
        store.queueAutoRun = false
        await store.runNetworkCycleOnce(now: t0 + 204)
        check("a paused queue admits nothing, and says paused", admitIs(0, NetworkAdmit.paused))
        store.queueAutoRun = true
        await store.runNetworkCycleOnce(now: t0 + 205)
        check("…and the cap is admitted again once neither holds", admitIs(3))

        // 6. A daemon that started since has heard neither.
        daemonPid = 701
        script.set(snapshot())
        let (poolsBefore, admitsBefore) = (requests(NetworkRoute.pools).count,
                                           requests(NetworkRoute.admit).count)
        await store.runNetworkCycleOnce(now: t0 + 206)
        check("a restarted daemon is told its pools and admit again",
              requests(NetworkRoute.pools).count == poolsBefore + 1
                && requests(NetworkRoute.admit).count == admitsBefore + 1)

        // MARK: the gate

        func url(_ n: Int) -> String { "https://github.com/o/r/pull/\(n)" }
        func ledgerKey(_ n: Int) -> String {
            AutofixWork.ledgerKey(kind: AutofixWork.kindReviewReq, prURL: url(n), headSha: "abc")
        }
        func job(_ n: Int, allows: Store.AgentJob.Allows = .init()) -> Store.AgentJob {
            Store.AgentJob(kind: "review", auditAction: "review-req",
                           label: "Review-req · #\(n)", prompt: "review \(n)",
                           prURL: url(n), prNumber: n, authorLogin: nil,
                           ledgerKey: ledgerKey(n), counter: .reviewRequests,
                           attemptStamp: Store.AttemptStamp.unresolvedReview,
                           directory: root.path, allows: allows)
        }
        func isOffered(_ outcome: Store.DispatchOutcome) -> Bool {
            if case .offered = outcome { return true }
            return false
        }
        func row(_ task: String) -> Store.AgentRow? {
            store.agentRows.first { $0.record.network == task }
        }
        func booked(_ task: String) -> AgentState.RunRecord? {
            AgentRegistry.load().first { $0.network == task }
        }
        let refusedBefore = AgentSpawner.refusedTerminals

        // 7. One offer, no spawn, and a run booked under the offer's task id.
        let offered = await store.dispatchAgent(job(90210), source: .auto)
        let body = requests(NetworkRoute.offer).last ?? [:]
        check("an automatic job with the switch on is offered", isOffered(offered))
        check("…with exactly one offer call", requests(NetworkRoute.offer).count == 1)
        check("…and no terminal asked for", AgentSpawner.refusedTerminals == refusedBefore)
        check("the offer names the pool, the kind, the item and the prompt",
              body["pool"] as? String == "github.com/o/r"
                && body["kind"] as? String == NetworkOffer.kindReview
                && body["item"] as? String == NetworkOffer.item(kind: NetworkOffer.kindReview,
                                                                number: 90210, prompt: "review 90210")
                && body["prompt"] as? String == "review 90210" && body["now"] as? Bool == false)
        let first = booked("task-1")
        check("the run is booked with the task id and no pid, tty or window",
              first != nil && first?.pid == nil && first?.tty == ""
                && first?.label == "Auto · Review-req · #90210"
                && first?.ledgerKey == ledgerKey(90210)
                && AgentRegistry.load().count == 1)
        check("…logged as network-offer", feedDetails(NetworkAudit.offer).count == 1)
        check("…and its telemetry entry is opened once",
              ledger("started", key: ledgerKey(90210)).count == 1)
        check("its row says the offer is not in the pool yet",
              row("task-1")?.state == .starting
                && row("task-1")?.reason.hasSuffix("not in the pool yet") == true)
        check("a second dispatch for the same PR is in flight, with no second offer",
              await store.dispatchAgent(job(90210), source: .auto) == .inFlight
                && requests(NetworkRoute.offer).count == 1)

        // 8. The row follows the daemon's word on the offer. A row has every member the
        //    daemon's `rows()` lists (`packages/diplomacy-network/src/node/offers.js`),
        //    `executorHere` being whether the executor is this machine.
        func offerRow(_ task: String, _ state: String, executor: String = "",
                      reason: String = "", outcome: [String: Any]? = nil,
                      kind: String = NetworkOffer.kindReview, item: String = "") -> [String: Any] {
            let ended = ["done", "failed", "cancelled"].contains(state)
            return ["taskId": task, "pool": "github.com/o/r", "kind": kind, "item": item,
                    "title": "", "state": state, "executor": executor,
                    "executorHere": executor == here, "attempt": 1, "requests": 0, "refused": 0,
                    "outcome": outcome ?? NSNull(), "reason": reason,
                    "offeredAt": 1_799_990_000, "endedAt": ended ? 1_800_000_000 : 0]
        }
        script.set(snapshot(offers: [offerRow("task-1", "pooled")]))
        await store.settleAgents()
        check("pooled, it reads in the pool", row("task-1")?.reason == "in the pool")
        script.set(snapshot(offers: [offerRow("task-1", "claimed", executor: away)]))
        await store.settleAgents()
        await store.settleAgents()
        check("claimed, it reads running on the executor's key",
              row("task-1")?.state == .running
                && row("task-1")?.reason == "running on \(NetworkText.short(away))")
        check("…and the claim is logged once over two ticks",
              feedDetails(NetworkAudit.claimed).count == 1)
        check("a run the network carries holds no bay of the local cap",
              store.autoTasksMeasured == 0)

        // 9. A daemon that does not answer is no evidence: the run stays, past the grace
        //    an offer the pool never took is given.
        _ = AgentRegistry.update { book in
            book.map { r in
                var r = r
                if r.network == "task-1" { r.dispatchedAt -= 120 }
                return r
            }
        }
        stopDaemon()
        await store.settleAgents()
        check("with the daemon silent the run is unknown, not failed",
              row("task-1")?.state == .unknown && booked("task-1") != nil
                && feedDetails(NetworkAudit.failed).isEmpty)
        check("…and the screen is told the daemon is not answering",
              store.networkAnswered == false && store.networkState == nil)

        // 10. Daemon down: an automatic job is staged back, a panel job gets the
        //     sentence, and neither starts an agent here.
        let offersBefore = requests(NetworkRoute.offer).count
        let spells = feedDetails(NetworkAudit.unavailable).count
        let down = await store.dispatchAgent(job(90211), source: .auto)
        check("with the daemon down an automatic job is refused with the sentence",
              down == .networkDown(DiplomacyNetwork.notAnswering))
        store.commitQueue()
        check("…and staged back into the queue",
              store.queuedTasks.map(\.id)
                == [AgentTaskQueue.key(auditAction: "review-req", item: "o/r#90211")])
        _ = await store.dispatchAgent(job(90212), source: .auto)
        check("…logged once for the spell",
              feedDetails(NetworkAudit.unavailable).count == spells + 1)
        let panelDown = await store.dispatchAgent(job(90213), source: .panel)
        check("a job the operator started gets the sentence",
              panelDown == .networkDown(DiplomacyNetwork.notAnswering)
                && statusText(for: panelDown, terminal: "Terminal")
                    == "Not offered: \(DiplomacyNetwork.notAnswering)")
        check("…and none of them asked for a terminal or booked a run",
              AgentSpawner.refusedTerminals == refusedBefore
                && AgentRegistry.load().count == 1
                && requests(NetworkRoute.offer).count == offersBefore)
        //     Known silent, an automatic job is not offered at all, whatever stands on
        //     the socket by then: the cycle is what finds the daemon back.
        startDaemon()
        let unseen = await store.dispatchAgent(job(90216), source: .auto)
        check("automatic work is not offered while the daemon is known silent",
              unseen == .networkDown(DiplomacyNetwork.notAnswering)
                && store.networkAnswered == false
                && requests(NetworkRoute.offer).count == offersBefore)
        script.refuse(NetworkRoute.offer, (409, "not today"))
        let pressed = await store.dispatchAgent(job(90217), source: .panel)
        script.refuse(NetworkRoute.offer, (503, "The Diplomacy Network daemon is stopping."))
        let executedNow = await store.dispatchAgent(job(90216), source: .auto, forced: true)
        script.refuse(NetworkRoute.offer, nil)
        check("…while what the operator starts, or has executed now, asks",
              pressed == .networkRefused("not today")
                && executedNow == .networkDown("The Diplomacy Network daemon is stopping.")
                && store.networkAnswered == false
                && requests(NetworkRoute.offer).count == offersBefore + 2)
        store.networkAnswered = nil
        script.refuse(NetworkRoute.offer, (503, "The Diplomacy Network daemon is stopping."))
        let unasked = await store.dispatchAgent(job(90218), source: .auto)
        script.refuse(NetworkRoute.offer, nil)
        store.networkAnswered = false
        check("…and automatic work asks a daemon not asked yet",
              unasked == .networkDown("The Diplomacy Network daemon is stopping.")
                && requests(NetworkRoute.offer).count == offersBefore + 3)
        stopDaemon()
        store.queuedTasks = []

        // 11. A silent daemon is started again, each try waiting longer.
        let t1 = Date().timeIntervalSince1970 + 1000
        func starts() -> Int { installer.all.filter { $0 == "--start-daemon" }.count }
        let startsBefore = starts()
        let failuresBefore = feedDetails(NetworkAudit.start).count
        await store.runNetworkCycleOnce(now: t1)
        check("a cycle that finds the daemon silent starts it", starts() == startsBefore + 1)
        await store.runNetworkCycleOnce(now: t1 + 14)
        check("…not again inside the first wait", starts() == startsBefore + 1)
        await store.runNetworkCycleOnce(now: t1 + 16)
        check("…again after it", starts() == startsBefore + 2)
        await store.runNetworkCycleOnce(now: t1 + 40)
        check("…and the second wait is twice the first", starts() == startsBefore + 2)
        await store.runNetworkCycleOnce(now: t1 + 47)
        check("…after which it tries a third time", starts() == startsBefore + 3)
        check("the failed starts are logged once for the silence",
              feedDetails(NetworkAudit.start).count == failuresBefore + 1)

        // 12. The daemon back, a 4xx is the sentence it gave.
        daemonPid = 702
        script.set(snapshot(offers: [offerRow("task-1", "claimed", executor: away)]))
        startDaemon()
        await store.runNetworkCycleOnce(now: t1 + 48)
        script.refuse(NetworkRoute.offer, (409, "o/r has no pool on this machine"))
        check("a refusal is shown as the daemon worded it",
              await store.dispatchAgent(job(90214), source: .panel)
                == .networkRefused("o/r has no pool on this machine"))
        script.refuse(NetworkRoute.offer, nil)
        check("a job of a kind the network does not run is refused before any call",
              await store.dispatchAgent(
                Store.AgentJob(kind: "review", auditAction: "sweep", label: "Sweep",
                               prompt: "p", prURL: nil, prNumber: nil, authorLogin: nil,
                               counter: nil, directory: root.path), source: .panel)
                == .networkRefused("the network runs no sweep jobs"))

        // 13. Finished elsewhere: retired, logged, priced once under the foreign runner,
        //     and not withdrawn.
        script.set(snapshot(offers: [offerRow("task-1", "done", executor: away, outcome: [
            "ok": true, "summary": "reviewed", "usd": 1.25, "tokens": 42_000,
            "runner": "claude", "model": "claude-opus-4",
        ])]))
        await store.settleAgents()
        await store.settleAgents()
        let done = ledger("done", key: ledgerKey(90210))
        check("a finished run leaves the book and the list",
              booked("task-1") == nil && row("task-1") == nil)
        check("…logged as network-done", feedDetails(NetworkAudit.done).count == 1
                && feedDetails(NetworkAudit.done).first?
                    .hasSuffix("finished on \(NetworkText.short(away))") == true)
        check("its telemetry entry is closed once, with the outcome's cost and model",
              done.count == 1 && done.first?["usd"] as? Double == 1.25
                && done.first?["tokens"] as? Double == 42_000
                && done.first?["model"] as? String == "claude-opus-4"
                && done.first?["at"] as? Double == 1_800_000_000)
        check("a task another machine ran is filed under no runner of this one",
              done.first?["runner"] as? String == DiplomacyNetwork.foreignRunner)
        check("a finished run's offer is not withdrawn", requests(NetworkRoute.withdraw).isEmpty)
        for _ in 0..<50 where !ghAsked("number=90210") {
            try? await Task.sleep(nanoseconds: 100_000_000)
        }
        check("a review the network finished is checked on GitHub like a local one",
              ghAsked("-f owner=o -f name=r -f me=LatekVO -F number=90210"))

        // 14. Finished here: the outcome's own runner. Failed: logged as failed, and an
        //     outcome that spent nothing closes no entry.
        check("a second job is offered", isOffered(await store.dispatchAgent(job(90220), source: .auto)))
        script.set(snapshot(offers: [offerRow("task-2", "done", executor: here, outcome: [
            "ok": true, "summary": "", "usd": 0.5, "tokens": 9000, "runner": "claude", "model": "m",
            "capped": true,
        ])]))
        await store.settleAgents()
        check("a task this machine ran keeps the runner its outcome names",
              ledger("done", key: ledgerKey(90220)).first?["runner"] as? String == "claude")
        check("…and one whose reported cost the executor lowered says so where it ends",
              feedDetails(NetworkAudit.done).last?
                .hasSuffix("finished on this machine, its reported cost capped") == true)
        check("a third job is offered", isOffered(await store.dispatchAgent(job(90221), source: .auto)))
        script.set(snapshot(offers: [offerRow("task-3", "failed", executor: away,
                                              reason: "the container exited 137", outcome: [
            "ok": false, "summary": "", "usd": 0, "tokens": 0, "runner": "claude", "model": "m",
        ])]))
        await store.settleAgents()
        check("an offer the network gave up on is logged as network-failed",
              booked("task-3") == nil && feedDetails(NetworkAudit.failed).count == 1
                && ledger("done", key: ledgerKey(90221)).isEmpty)
        check("…with the daemon's reason after the verdict",
              feedDetails(NetworkAudit.failed).first?
                .hasSuffix("refused by the network: the container exited 137") == true)

        // 15. A merged PR: withdrawn once, then forgotten.
        check("a fourth job is offered", isOffered(await store.dispatchAgent(job(90230), source: .auto)))
        script.set(snapshot(offers: [offerRow("task-4", "claimed", executor: away)]))
        await store.settleAgents()
        store.pinMergedPRs(["o/r#90230"])
        await store.settleAgents()
        await store.settleAgents()
        let withdrawn = requests(NetworkRoute.withdraw)
        check("a run whose PR merged is withdrawn exactly once, as merged",
              withdrawn.count == 1 && withdrawn.first?["taskId"] as? String == "task-4"
                && withdrawn.first?["reason"] as? String == NetworkRoute.withdrawMerged)
        check("…and leaves the book", booked("task-4") == nil)
        store.pinMergedPRs([])

        // 16. Forgetting a run the pool still holds withdraws it; stopping a task goes
        //     to its run when this machine has it, else to the offer.
        check("a fifth job is offered", isOffered(await store.dispatchAgent(job(90240), source: .auto)))
        script.set(snapshot(offers: [offerRow("task-5", "pooled")]))
        await store.settleAgents()
        if let run = booked("task-5") { store.forgetRun(run.runID) }
        for _ in 0..<50 where requests(NetworkRoute.withdraw).count < 2 {
            try? await Task.sleep(nanoseconds: 100_000_000)
        }
        check("a forgotten run's offer is withdrawn, as forgotten",
              requests(NetworkRoute.withdraw).count == 2
                && requests(NetworkRoute.withdraw).last?["taskId"] as? String == "task-5"
                && requests(NetworkRoute.withdraw).last?["reason"] as? String
                    == NetworkRoute.withdrawForgotten
                && booked("task-5") == nil)
        func poolTask(_ id: String, here executorHere: Bool) -> NetworkSnapshot.Task? {
            let doc = snapshot(
                runs: [["runId": "run-9", "taskId": "t-here", "state": "running"],
                       ["runId": "run-8", "taskId": "t-ended", "state": "done"]],
                tasks: [["taskId": id, "kind": "review", "item": "pr-1", "title": "Review · #1",
                         "state": "claimed", "offeredHere": true, "executor": executorHere ? here : away,
                         "executorHere": executorHere]])
            script.set(doc)
            return NetworkSnapshot.parse(Data(json(doc).utf8))?.pools.first?.tasks.first
        }
        if let mine = poolTask("t-here", here: true) {
            await store.stopNetworkTask(mine, pool: "github.com/o/r")
        }
        check("stopping a task this machine runs stops its run",
              requests(NetworkRoute.stopRun).count == 1
                && requests(NetworkRoute.stopRun).first?["runId"] as? String == "run-9"
                && requests(NetworkRoute.withdraw).count == 2
                && feedDetails(NetworkAudit.stop).last
                    == "Review · #1 - its run on this machine was stopped and the job is "
                        + "back in the pool")
        check("the stop button says where the job goes",
              NetworkText.stopRunHelp
                == "Stop this job's run on this machine. It goes back to the pool.")
        if let theirs = poolTask("t-away", here: false) {
            await store.stopNetworkTask(theirs, pool: "github.com/o/r")
        }
        check("stopping one another machine runs withdraws the offer",
              requests(NetworkRoute.stopRun).count == 1
                && requests(NetworkRoute.withdraw).count == 3
                && requests(NetworkRoute.withdraw).last?["taskId"] as? String == "t-away"
                && requests(NetworkRoute.withdraw).last?["reason"] as? String
                    == "stopped")
        let sentBefore = (requests(NetworkRoute.stopRun).count, requests(NetworkRoute.withdraw).count)
        if let ended = poolTask("t-ended", here: true) {
            await store.stopNetworkTask(ended, pool: "github.com/o/r")
        }
        check("a run that ended since the screen drew it is not there to stop, and nothing "
                + "is withdrawn in its place",
              requests(NetworkRoute.stopRun).count == sentBefore.0
                && requests(NetworkRoute.withdraw).count == sentBefore.1
                && store.networkRefusals["github.com/o/r"] == DiplomacyNetwork.runEnded
                && DiplomacyNetwork.runEnded == "That job's run on this machine has already ended.")
        if let unseen = poolTask("t-here", here: true) {
            script.refuse(NetworkRoute.state, (500, "boom"))
            await store.stopNetworkTask(unseen, pool: "github.com/o/r")
            script.refuse(NetworkRoute.state, nil)
        }
        check("…nor when the daemon does not say what runs here",
              requests(NetworkRoute.stopRun).count == sentBefore.0
                && requests(NetworkRoute.withdraw).count == sentBefore.1
                && store.networkRefusals["github.com/o/r"] == DiplomacyNetwork.notAnswering)
        script.set(snapshot())
        await store.settleAgents()

        // 17. What holds a network job: a pause. Not a full local cap, not a low disk.
        store.queueAutoRun = false
        setenv(DiskFloor.envOverride, "99999999999999999999", 1)
        let offersHeld = requests(NetworkRoute.offer).count
        check("a paused queue holds an automatic job, low disk or not",
              await store.dispatchAgent(job(90250), source: .auto) == .atCapacity
                && requests(NetworkRoute.offer).count == offersHeld)
        store.queueAutoRun = true
        check("a low disk does not hold one",
              isOffered(await store.dispatchAgent(job(90251), source: .auto)))
        setenv(DiskFloor.envOverride, "0", 1)
        store.autoTaskLimit = 1
        let now = Date().timeIntervalSince1970
        AgentRegistry.createRun(
            AgentState.RunRecord(runID: AgentRegistry.newRunID(now: now), dispatchedAt: now + 600,
                                 prNumber: 5, prURL: url(5), kind: "review",
                                 label: "Auto · Review · #5",
                                 source: AgentDispatchGate.Source.auto.rawValue),
            prompt: "")
        await store.settleAgents()
        check("the local cap is full", store.autoTasksMeasured >= store.autoTaskLimit)
        check("…and does not hold a network job either",
              isOffered(await store.dispatchAgent(job(90252), source: .auto)))
        store.autoTaskLimit = 3

        // 18. The four options are the prompt's own, in both polarities.
        func options(_ verb: String, _ allows: Store.AgentJob.Allows, _ n: Int,
                     prompt: String) async -> [String: Bool]? {
            let j = Store.AgentJob(kind: verb, auditAction: verb, label: "\(verb) · #\(n)",
                                   prompt: prompt, prURL: url(n), prNumber: nil,
                                   authorLogin: nil, counter: nil, directory: root.path,
                                   allows: allows)
            guard isOffered(await store.dispatchAgent(j, source: .panel)),
                  let sent = requests(NetworkRoute.offer).last,
                  sent["prompt"] as? String == prompt, sent["now"] as? Bool == true else { return nil }
            return sent["options"] as? [String: Bool] ?? [:]
        }
        func review(theirs: Bool, finalPass: Bool = false, markReady: Bool = false) -> ReviewConfig {
            ReviewConfig(depth: "max", target: .specific, me: "latekvo", markReady: markReady,
                         leaveReviews: theirs, replyToReviews: !theirs, specificPR: "1",
                         finalPass: finalPass, specificAuthor: theirs ? .theirs : .mine)
        }
        var n = 90300
        func next() -> Int { n += 1; return n }
        let verdictOn = review(theirs: true, finalPass: true)
        let verdictOff = review(theirs: true, finalPass: false)
        check("a review that may give a verdict is offered with verdict on",
              await options("review", .init(review: verdictOn), next(),
                            prompt: verdictOn.buildPrompt()) == [NetworkOffer.optionVerdict: true])
        check("…and one that may not, with it off",
              await options("review", .init(review: verdictOff), next(),
                            prompt: verdictOff.buildPrompt()) == [NetworkOffer.optionVerdict: false])
        var monitors = review(theirs: true)
        monitors.automaticVerdict = true
        check("…and so is the review-request monitor's, whose verdict comes at its own depth",
              await options("review", .init(review: monitors), next(),
                            prompt: monitors.buildPrompt()) == [NetworkOffer.optionVerdict: true])
        var ownMonitored = review(theirs: false)
        ownMonitored.automaticVerdict = true
        check("…never on my own PR", !Store.AgentJob.Allows(review: ownMonitored).verdict)
        let readyOn = review(theirs: false, markReady: true)
        let readyOff = review(theirs: false, markReady: false)
        check("a review of my own PR that may mark it ready says so",
              await options("review", .init(review: readyOn), next(),
                            prompt: readyOn.buildPrompt()) == [NetworkOffer.optionMarkReady: true])
        check("…and one that may not, does not",
              await options("review", .init(review: readyOff), next(),
                            prompt: readyOff.buildPrompt()) == [NetworkOffer.optionMarkReady: false])
        let (prs, noPRs) = (IssueConfig(openPRs: true), IssueConfig(openPRs: false))
        check("an issue fix that opens PRs is offered with noPRs off",
              await options("issues", .init(issues: prs), next(),
                            prompt: prs.buildPrompt()) == [NetworkOffer.optionNoPRs: false])
        check("…and one that opens none, with it on",
              await options("issues", .init(issues: noPRs), next(),
                            prompt: noPRs.buildPrompt()) == [NetworkOffer.optionNoPRs: true])
        let (writes, reads) = (AuditConfig(openPRs: true), AuditConfig(openPRs: false))
        check("an audit that opens PRs is offered with readOnly off",
              await options("audit", .init(audit: writes), next(),
                            prompt: writes.buildPrompt()) == [NetworkOffer.optionReadOnly: false])
        check("…and a read-only one, with it on",
              await options("audit", .init(audit: reads), next(),
                            prompt: reads.buildPrompt()) == [NetworkOffer.optionReadOnly: true])
        check("the prompts those options came from differ with them",
              verdictOn.buildPrompt() != verdictOff.buildPrompt()
                && readyOn.buildPrompt() != readyOff.buildPrompt()
                && prs.buildPrompt() != noPRs.buildPrompt()
                && writes.buildPrompt() != reads.buildPrompt())

        // 19. No path past the gate reaches a terminal while the switch is on.
        var thrown: Error?
        do {
            _ = try await store.spawnTracked(kind: "review", label: "x", prURL: nil, prNumber: nil,
                                             prompt: "", source: "panel", terminal: store.terminal)
        } catch { thrown = error }
        check("a spawn asked for past the gate is refused before any terminal",
              (thrown as? AgentSpawner.SpawnError).map {
                  if case .network = $0 { return true } else { return false }
              } == true && AgentSpawner.refusedTerminals == refusedBefore)

        // 20. The screen's pool actions.
        check("an invite is asked of the pool and handed back",
              await store.networkInvite(pool: "github.com/o/r") == "dn-invite-1"
                && requests(NetworkRoute.invite).last?["pool"] as? String == "github.com/o/r"
                && feedDetails(NetworkAudit.invite).count == 1)
        script.refuse(NetworkRoute.join, (400, "that invite has expired"))
        check("a refused join shows the daemon's sentence on its panel",
              await store.joinNetworkPool(invite: "dn-x", card: "github.com/o/r") == false
                && store.networkRefusals["github.com/o/r"] == "that invite has expired"
                && feedDetails(NetworkAudit.join).isEmpty)
        script.refuse(NetworkRoute.join, nil)
        check("a join that lands clears it and is logged",
              await store.joinNetworkPool(invite: "dn-y", card: "github.com/o/r")
                && store.networkRefusals["github.com/o/r"] == nil
                && requests(NetworkRoute.join).last?["invite"] as? String == "dn-y"
                && feedDetails(NetworkAudit.join)
                    == ["Joining github.com/o/r: the machine that made the invite seats this "
                        + "one once it is reached"])
        await store.leaveNetworkPool("github.com/o/r")
        check("leaving a pool names it and is logged",
              requests(NetworkRoute.leave).last?["pool"] as? String == "github.com/o/r"
                && feedDetails(NetworkAudit.leave).last == "Left github.com/o/r")
        script.refuse(NetworkRoute.join, (409, "github.com/o/r is not linked on this machine"))
        await store.rejoinNetworkPool("github.com/o/r")
        check("a refused rejoin shows the daemon's sentence on the pool's panel",
              store.networkRefusals["github.com/o/r"]
                == "github.com/o/r is not linked on this machine"
                && feedDetails(NetworkAudit.join).count == 1)
        script.refuse(NetworkRoute.join, nil)
        await store.rejoinNetworkPool("github.com/o/r")
        check("rejoining a pool this machine left names the pool, not an invite",
              (requests(NetworkRoute.join).last as? [String: String])
                == ["pool": "github.com/o/r"]
                && store.networkRefusals["github.com/o/r"] == nil
                && feedDetails(NetworkAudit.join).last == "Rejoined github.com/o/r")
        let leftDoc = snapshot(
            offers: [offerRow("t-spent", "failed", reason: "the container exited 137"),
                     offerRow("t-gone", "cancelled", reason: "merged"),
                     offerRow("t-quiet", "cancelled"),
                     offerRow("t-open", "claimed", reason: "second attempt")],
            tasks: [["taskId": "t-open", "state": "claimed"]],
            more: [["id": "github.com/o/gone", "left": true,
                    "tasks": [["taskId": "t-old", "state": "available"]]]])
        let leftSnap = NetworkSnapshot.parse(Data(json(leftDoc).utf8))
        check("the screen is told which pool this machine left",
              leftSnap?.pools.map(\.left) == [false, true])
        check("…and counts neither it nor its tasks",
              leftSnap.map(NetworkText.counts) == "1 pool · 1 task")
        check("a task whose offer failed or was withdrawn says why, as its run's row would",
              NetworkText.ending(of: "t-spent", in: leftSnap)
                == "refused by the network: the container exited 137"
                && NetworkText.ending(of: "t-gone", in: leftSnap)
                    == "withdrawn from the network: merged")
        check("…and one with no reason, still open or not this machine's says nothing",
              NetworkText.ending(of: "t-quiet", in: leftSnap) == nil
                && NetworkText.ending(of: "t-open", in: leftSnap) == nil
                && NetworkText.ending(of: "t-old", in: leftSnap) == nil
                && NetworkText.ending(of: "t-spent", in: nil) == nil)

        let noDocker = "docker is missing: docker not found"
        let short = "this machine takes jobs of at most 12 h and this one needs 24"
        func held(_ task: String, _ why: String, state: String = "pooled") -> [String: Any] {
            offerRow(task, state).merging(["notTaking": why]) { $1 }
        }
        let heldSnap = NetworkSnapshot.parse(Data(json(snapshot(
            offers: [held("t-long", short), held("t-down", noDocker),
                     held("t-taken", short, state: "claimed"), offerRow("t-free", "pooled")],
            more: [["id": "github.com/o/held", "notTaking": noDocker]])).utf8))
        let (takes, holds) = (heldSnap?.pools.first, heldSnap?.pools.last)
        check("a pool this machine takes no job of says why on its card, and no other does",
              holds.flatMap(NetworkText.poolHeld)
                == "This machine takes none of this pool's jobs: \(noDocker)"
                && takes != nil && takes.flatMap(NetworkText.poolHeld) == nil)
        check("a job of this machine's own that it does not take says why on its row",
              takes.flatMap { NetworkText.taskHeld("t-long", pool: $0, in: heldSnap) }
                == "This machine is not taking this job: \(short)")
        check("…and one the pool's card speaks for, one taken, one it would take say nothing",
              holds != nil && takes != nil
                && holds.flatMap { NetworkText.taskHeld("t-down", pool: $0, in: heldSnap) } == nil
                && takes.flatMap { NetworkText.taskHeld("t-taken", pool: $0, in: heldSnap) } == nil
                && takes.flatMap { NetworkText.taskHeld("t-free", pool: $0, in: heldSnap) } == nil
                && takes.flatMap { NetworkText.taskHeld("t-long", pool: $0, in: nil) } == nil)
        let joinCards = NetworkSnapshot.parse(Data(json(snapshot(
            more: [["id": "github.com/o/waits", "joining": true],
                   ["id": "github.com/o/refused", "joinFailed": "no-seat"]])).utf8))?.pools ?? []
        let waits = "Joining: the machine that made the invite seats this one once it is reached"
        check("a pool whose invite waits for its maker says so on its card, and no other does",
              joinCards.map(NetworkText.poolJoining) == [nil, waits, nil])
        check("a pool whose last invite came to nothing says why on its card, and no other does",
              joinCards.map(NetworkText.poolJoinFailed)
                == [nil, nil, "The last invite came to nothing: no-seat"])

        // 21. The hours are kept inside the daemon's range.
        store.networkRequiredMinimumH = 5
        store.networkMaximumAcceptedH = 9999
        check("the hours settings are clamped and saved",
              store.networkRequiredMinimumH == NetworkSettings.hoursFloor
                && store.networkMaximumAcceptedH == 720
                && AppConfig.read()[NetworkSettings.maximumAcceptedHKey] as? Int == 720)
        _ = AppConfig.setInt(NetworkSettings.maximumAcceptedHKey, 9999)
        check("a stored value above the ceiling reads as the ceiling",
              AppConfig.networkHours(NetworkSettings.maximumAcceptedHKey) == 720
                && DiplomacyNetwork.hoursRange == 12...720)
        func storeRaw(_ key: String, _ value: Any) {
            var doc = AppConfig.read()
            doc[key] = value
            try? JSONSerialization.data(withJSONObject: doc).write(to: AppConfig.url)
        }
        storeRaw(NetworkSettings.maximumAcceptedHKey, 15.5)
        let rounded = AppConfig.networkHours(NetworkSettings.maximumAcceptedHKey)
        storeRaw(NetworkSettings.maximumAcceptedHKey, " 48 ")
        check("a stored value reads as the daemon reads it: rounded, a string as its number",
              rounded == 16 && AppConfig.networkHours(NetworkSettings.maximumAcceptedHKey) == 48)
        _ = AppConfig.setInt(NetworkSettings.maximumAcceptedHKey, 720)
        check("jobs see no device until the setting says so",
              !store.networkDevices && !AppConfig.networkDevices
                && AppConfig.read()[NetworkSettings.devicesKey] == nil)

        //     The screen itself, in a window never ordered on screen: typing goes through
        //     each field's editor. It asks the daemon nothing of its own here.
        var noPools = snapshot()
        noPools["pools"] = [[String: Any]]()
        script.set(noPools)
        await store.settleAgents()
        let screen = NSHostingView(rootView: NetworkScreen(isPresented: .constant(true), live: false)
            .environmentObject(store))
        let screenWindow = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 900, height: 1400),
                                    styleMask: [.borderless], backing: .buffered, defer: false)
        screenWindow.isReleasedWhenClosed = false
        screenWindow.contentView = screen
        defer { screenWindow.contentView = nil }
        func screenFields(_ view: NSView) -> [NSTextField] {
            ((view as? NSTextField).map { [$0] } ?? []) + view.subviews.flatMap(screenFields)
        }
        func screenField(_ placeholder: String) -> NSTextField? {
            screenFields(screen).first { $0.isEditable && $0.placeholderString == placeholder }
        }
        func screenShows(_ text: String) -> Bool {
            screenFields(screen).contains { $0.stringValue == text }
        }
        func screenSettles(until done: () -> Bool) async {
            for _ in 0..<60 {
                screen.layoutSubtreeIfNeeded()
                if done() { return }
                try? await Task.sleep(nanoseconds: 50_000_000)
            }
        }
        func enter(_ text: String, in field: NSTextField) {
            screenWindow.makeFirstResponder(field)
            field.currentEditor()?.selectAll(nil)
            field.currentEditor()?.insertText(text)
            field.currentEditor()?.insertNewline(nil)
        }
        await screenSettles { screenField(NetworkText.invitePlaceholder) != nil }
        let joinsBefore = requests(NetworkRoute.join).count
        if let invite = screenField(NetworkText.invitePlaceholder) {
            enter("  dn-typed ", in: invite)
            await screenSettles { requests(NetworkRoute.join).count > joinsBefore }
            check("Return in the invite field joins with what was typed",
                  requests(NetworkRoute.join).count == joinsBefore + 1
                    && requests(NetworkRoute.join).last?["invite"] as? String == "dn-typed")
        } else {
            check("the screen draws an invite field while this machine is in no pool", false)
        }
        check("an empty invite, or one being sent, is not sent",
              NetworkText.joinable("  dn-x \n", sending: false) == "dn-x"
                && NetworkText.joinable(" \n", sending: false) == nil
                && NetworkText.joinable("dn-x", sending: true) == nil)
        if let hours = screenField(NetworkText.requiredTitle) {
            enter("100", in: hours)
            await screenSettles { store.networkRequiredMinimumH == 100 }
            check("any whole hour can be typed into an hours field",
                  store.networkRequiredMinimumH == 100
                    && AppConfig.read()[NetworkSettings.requiredMinimumHKey] as? Int == 100)
            enter("5", in: hours)
            await screenSettles {
                store.networkRequiredMinimumH == NetworkSettings.hoursFloor
                    && hours.stringValue == "\(NetworkSettings.hoursFloor)"
            }
            check("…and one outside the range is shown as the setting keeps it",
                  store.networkRequiredMinimumH == NetworkSettings.hoursFloor
                    && hours.stringValue == "\(NetworkSettings.hoursFloor)")
        } else {
            check("the screen draws an hours field that can be typed in", false)
        }
        check("the screen says nothing of a save while every change lands",
              !store.configSaveFailed && !screenShows(AllocatorUI.saveError))
        script.set(snapshot())
        await store.settleAgents()
        let drawnAt = Date(timeIntervalSince1970: 1_800_000_000)
        check("a network run's row says how long since it was offered, from a minute on",
              NetworkText.rowDetail("in the pool", offeredAt: drawnAt.timeIntervalSince1970 - 59,
                                    now: drawnAt) == "in the pool"
                && NetworkText.rowDetail("running on this machine",
                                         offeredAt: drawnAt.timeIntervalSince1970 - 600,
                                         now: drawnAt)
                    == "running on this machine · offered 10m ago")
        check("Settings says under the switch where the rest is",
              NetworkText.settingsExplanation == NetworkText.explanation
                + " While it is on, no agent starts in a terminal on this machine. The pools "
                + "and the hours a job may take are on the Network screen.")

        // 22. An offer whose run cannot be booked is withdrawn, and says why. Every
        //     network verb has its row symbol.
        let unbookable = scratch.appendingPathComponent("not-a-directory")
        FileManager.default.createFile(atPath: unbookable.path, contents: nil)
        setenv("DIPLOMAT_AGENTS_DIR", unbookable.appendingPathComponent("agents").path, 1)
        let withdrawnBooked = requests(NetworkRoute.withdraw).count
        let unbooked = await store.dispatchAgent(job(90250), source: .panel)
        setenv("DIPLOMAT_AGENTS_DIR", scratch.appendingPathComponent("agents").path, 1)
        check("an offer whose run cannot be booked is withdrawn as not booked",
              unbooked == .failed("could not register the run, so its offer is withdrawn")
                && requests(NetworkRoute.withdraw).count == withdrawnBooked + 1
                && requests(NetworkRoute.withdraw).last?["reason"] as? String == "not booked")
        check("every network verb has its row symbol",
              [NetworkAudit.offer, NetworkAudit.claimed, NetworkAudit.done,
               NetworkAudit.withdraw, NetworkAudit.join, NetworkAudit.invite,
               NetworkAudit.leave, NetworkAudit.start, NetworkAudit.stop]
                .allSatisfy { AuditRow.icon(for: $0) == "point.3.connected.trianglepath.dotted" }
                && [NetworkAudit.failed, NetworkAudit.unavailable]
                    .allSatisfy { AuditRow.icon(for: $0) == "exclamationmark.triangle.fill" }
                && AuditRow.icon(for: "network-unheard-of") == "circle.fill")

        // 23. Off again: what the network still carries is withdrawn and retired as
        //     failed before the daemon is stopped, and what it had finished is retired on
        //     its outcome.
        _ = AgentRegistry.forget(Set(AgentRegistry.load().map(\.runID)))
        func taskOf(_ n: Int) -> String {
            AgentRegistry.load().first { $0.prNumber == n }?.network ?? "no run for #\(n)"
        }
        for n in [90260, 90261, 90262] {
            check("#\(n) is offered", isOffered(await store.dispatchAgent(job(n), source: .auto)))
        }
        let (pooledTask, claimedTask, doneTask) = (taskOf(90260), taskOf(90261), taskOf(90262))
        script.set(snapshot(offers: [
            offerRow(pooledTask, "pooled"), offerRow(claimedTask, "claimed", executor: away),
            offerRow(doneTask, "claimed", executor: away),
        ]))
        await store.settleAgents()
        check("three runs are booked and listed",
              AgentRegistry.load().count == 3 && row(pooledTask) != nil
                && row(claimedTask) != nil && row(doneTask) != nil)
        // A ping that took a run's start, as Comms logs it.
        func ping(_ n: Int, startedBy task: String) -> String {
            let ts = "17000\(n).000100"
            let m = CommsMessage(id: "D0ALICE:\(ts)", channelID: "D0ALICE", channelName: "U0ALICE",
                                 isDM: true, userID: "U0ALICE", userName: "alice", teamID: "T0",
                                 text: "review #\(n)", ts: ts, permalink: "", reasons: [.dm])
            CommsLog.append(CommsEvent(kind: .ping, id: m.id, message: m))
            CommsLog.append(CommsEvent(kind: .started, id: m.id, label: booked(task)?.label))
            return m.id
        }
        func pinged(_ id: String) -> CommsItem? { store.commsItems.first { $0.message.id == id } }
        let askPooled = ping(90260, startedBy: pooledTask)
        let askDone = ping(90262, startedBy: doneTask)
        store.refreshComms()
        // Each run answers a review request, as the monitor's attempt records have it.
        func reviewAsks() -> [String: ReviewAttempt] {
            store.headlessJSON?["reviewReqAttempts"]
                .flatMap { try? JSONDecoder().decode([String: ReviewAttempt].self, from: $0) } ?? [:]
        }
        store.headlessJSON = [:]
        store.headlessJSON?["reviewReqAttempts"] = try? JSONEncoder().encode(
            Dictionary(uniqueKeysWithValues: [90260, 90262].map {
                ("o/r#\($0)", ReviewAttempt(requestedAt: "2026-01-01T00:00:00Z",
                                            lastDispatchedAt: Date(), attempts: 1))
            }))
        // The third finishes unseen: the settle the switch takes is the one that finds it.
        script.set(snapshot(offers: [
            offerRow(pooledTask, "pooled"), offerRow(claimedTask, "claimed", executor: away),
            offerRow(doneTask, "done", executor: away, outcome: [
                "ok": true, "summary": "", "usd": 0.25, "tokens": 5000, "runner": "claude",
                "model": "m"]),
        ]))
        let (withdrawsBefore, failedBefore, doneBefore) = (
            requests(NetworkRoute.withdraw).count, feedDetails(NetworkAudit.failed).count,
            feedDetails(NetworkAudit.done).count)
        store.networkEnabled = false
        await store.networkLifecycle?.value
        check("switching off saves the key and runs --stop-daemon",
              AppConfig.read()[NetworkSettings.enabledKey] as? Bool == false
                && installer.all.filter { $0 == "--stop-daemon" }.count == 1
                && installer.all.last == "--stop-daemon"
                && feedDetails(NetworkAudit.stop).last
                    == "Stopped the Diplomacy Network daemon (ok: true)")
        let offWithdrawals = Array(requests(NetworkRoute.withdraw).dropFirst(withdrawsBefore))
        check("with the switch off, the evidence of the network's runs says so",
              DiplomacyNetwork.switchedOff == "the Diplomacy Network is switched off")
        check("…having withdrawn every offer the network still carried, as switched off",
              Set(offWithdrawals.compactMap { $0["taskId"] as? String })
                == [pooledTask, claimedTask]
                && offWithdrawals.count == 2
                && offWithdrawals.allSatisfy { $0["reason"] as? String == "switched off" })
        check("…before the daemon was told to stop",
              withdrawnAtStop.all == [script.count(NetworkRoute.withdraw)])
        check("their runs leave the book and the list as failed, and say why",
              booked(pooledTask) == nil && booked(claimedTask) == nil
                && row(pooledTask) == nil && row(claimedTask) == nil
                && Array(feedDetails(NetworkAudit.failed).dropFirst(failedBefore)).sorted() == [
                    "Auto · Review-req · #90260 - withdrawn: the Diplomacy Network was switched off",
                    "Auto · Review-req · #90261 - withdrawn: the Diplomacy Network was switched off",
                ])
        check("a ping whose run was withdrawn reads that it never ran, not that it finished",
              pinged(askPooled)?.label == "Auto · Review-req · #90260"
                && pinged(askPooled)?.outcome == Store.commsNeverStartedOutcome
                    + " (withdrawn: the Diplomacy Network was switched off)"
                && pinged(askPooled)?.finishedAt == nil)
        check("…and one whose run the network had finished reads finished",
              pinged(askDone)?.finishedAt != nil && pinged(askDone)?.outcome == nil)
        check("a review request is concluded by the network run that finished it alone",
              reviewAsks()["o/r#90262"]?.concludedAt != nil && reviewAsks()["o/r#90260"] != nil
                && reviewAsks()["o/r#90260"]?.concludedAt == nil)
        check("…and no window is closed for a run that had none here",
              feedDetails("kill-device").isEmpty)
        check("a run the network had finished is retired on its outcome instead",
              booked(doneTask) == nil && row(doneTask) == nil
                && feedDetails(NetworkAudit.done).count == doneBefore + 1
                && feedDetails(NetworkAudit.done).last?
                    .hasSuffix("#90262 — finished on \(NetworkText.short(away))") == true
                && ledger("done", key: ledgerKey(90262)).count == 1)
        let offersOff = requests(NetworkRoute.offer).count
        let local = await store.dispatchAgent(job(90260), source: .panel)
        check("a withdrawn run's PR is free for a local run at once, which offers nothing",
              local == .failed(AgentSpawner.SpawnError.headless.localizedDescription)
                && AgentSpawner.refusedTerminals == refusedBefore + 1
                && requests(NetworkRoute.offer).count == offersOff)

        // 24. A network run found in the book while the switch is off is withdrawn and
        //     leaves it at the next settle; with none there the daemon is asked nothing.
        func bookByHand(_ n: Int, task: String) {
            let at = Date().timeIntervalSince1970
            AgentRegistry.createRun(
                AgentState.RunRecord(runID: AgentRegistry.newRunID(now: at), dispatchedAt: at,
                                     prNumber: n, prURL: url(n), kind: "review",
                                     label: "Auto · Review-req · #\(n)",
                                     source: AgentDispatchGate.Source.auto.rawValue,
                                     network: task),
                prompt: "")
        }
        func asked() -> Int { (earlier + (daemon?.requests ?? [])).count }
        bookByHand(90270, task: "task-stray")
        script.set(snapshot(offers: [offerRow("task-stray", "pooled")]))
        await store.settleAgents()
        check("a network run in the book with the switch off is withdrawn and retired as failed",
              booked("task-stray") == nil
                && requests(NetworkRoute.withdraw).last?["taskId"] as? String == "task-stray"
                && requests(NetworkRoute.withdraw).last?["reason"] as? String == "switched off"
                && feedDetails(NetworkAudit.failed).last
                    == "Auto · Review-req · #90270 - withdrawn: the Diplomacy Network was switched off")
        bookByHand(90272, task: "task-landed")
        script.set(snapshot(offers: [offerRow("task-landed", "claimed", executor: away)]))
        store.pinMergedPRs(["o/r#90272"])
        let failedOff = feedDetails(NetworkAudit.failed).count
        await store.settleAgents()
        store.pinMergedPRs([])
        check("…and one whose PR merged is withdrawn as merged and retired as merged",
              booked("task-landed") == nil
                && requests(NetworkRoute.withdraw).last?["taskId"] as? String == "task-landed"
                && requests(NetworkRoute.withdraw).last?["reason"] as? String
                    == NetworkRoute.withdrawMerged
                && feedDetails(NetworkAudit.failed).count == failedOff)
        bookByHand(90273, task: "task-unheard")
        script.refuse(NetworkRoute.state, (500, "no snapshot"))
        let withdrawnOff = script.count(NetworkRoute.withdraw)
        await store.settleAgents()
        script.refuse(NetworkRoute.state, nil)
        check("…and one a daemon gave no snapshot for is retired with no withdrawal sent",
              booked("task-unheard") == nil
                && script.count(NetworkRoute.withdraw) == withdrawnOff
                && feedDetails(NetworkAudit.failed).last
                    == "Auto · Review-req · #90273 - withdrawn: the Diplomacy Network was switched off")
        let askedBefore = asked()
        await store.settleAgents()
        await store.runNetworkCycleOnce()
        check("…after which the daemon is asked nothing, the switch being off",
              asked() == askedBefore && store.networkState == nil)

        // 25. On again, a task the switch retired is announced afresh; and a daemon that
        //     does not answer as the switch goes off holds nothing back.
        store.networkEnabled = true
        await store.networkLifecycle?.value
        bookByHand(90274, task: claimedTask)
        script.set(snapshot(offers: [offerRow(claimedTask, "claimed", executor: away)]))
        let claimedLines = feedDetails(NetworkAudit.claimed).count
        await store.settleAgents()
        check("a task whose run the switch retired is announced again when next seen claimed",
              feedDetails(NetworkAudit.claimed).count == claimedLines + 1)
        _ = AgentRegistry.forget(Set(AgentRegistry.load().map(\.runID)))
        bookByHand(90271, task: "task-deaf")
        stopDaemon()
        leftInStore.add((2, 1))
        store.networkEnabled = false
        await store.networkLifecycle?.value
        leftInStore.add((0, 0))
        check("with the daemon silent the run is retired all the same, and the daemon stopped",
              booked("task-deaf") == nil
                && feedDetails(NetworkAudit.failed).last
                    == "Auto · Review-req · #90271 - withdrawn: the Diplomacy Network was switched off"
                && installer.all.last == "--stop-daemon"
                && installer.all.filter { $0 == "--stop-daemon" }.count == 2)
        let leftNote = " the daemon had left in its store"
        check("…and the feed says what the installer ended in the store",
              feedDetails(NetworkAudit.stop).last
                == "Stopped the Diplomacy Network daemon (ok: true), cancelling 2 offers and "
                    + "ending 1 run" + leftNote)
        func stopped(_ answer: String) -> String? {
            (try? JSONDecoder().decode(AllocatorInstall.self, from: Data(answer.utf8)))
                .map(DiplomacyNetwork.stoppedLine)
        }
        let stoppedOK = "Stopped the Diplomacy Network daemon (ok: true)"
        let stopAnswers: [(String, String)] = [
            (#"{"ok":true,"daemonRunning":false,"pid":null}"#, stoppedOK),
            (#"{"ended":{"offers":0,"runs":0}}"#, stoppedOK),
            (#"{"ended":{"offers":1,"runs":0}}"#, stoppedOK + ", cancelling 1 offer" + leftNote),
            (#"{"ended":{"offers":2}}"#, stoppedOK + ", cancelling 2 offers" + leftNote),
            (#"{"ended":{"offers":0,"runs":1}}"#, stoppedOK + ", ending 1 run" + leftNote),
            (#"{"ended":{"runs":3}}"#, stoppedOK + ", ending 3 runs" + leftNote),
            (#"{"ended":{"offers":2,"runs":1}}"#,
             stoppedOK + ", cancelling 2 offers and ending 1 run" + leftNote),
            (#"{"ended":"2"}"#, stoppedOK),
            (#"{"ended":[2,1]}"#, stoppedOK),
            (#"{"ended":{"offers":"2","runs":true}}"#, stoppedOK),
            (#"{"ended":{"offers":-1,"runs":1.5}}"#, stoppedOK),
            (#"{"ok":false,"ended":{"offers":0,"runs":2},"error":"a container is still there"}"#,
             "Stopped the Diplomacy Network daemon (ok: false), ending 2 runs" + leftNote
                + ": a container is still there"),
            (#"{"daemonRunning":true,"ended":{"offers":1}}"#,
             "Stopped the Diplomacy Network daemon (ok: false), cancelling 1 offer" + leftNote),
        ]
        for (answer, line) in stopAnswers {
            check("a stop that answers \(answer) is said as \(line)", stopped(answer) == line)
        }
        // The installer's own sentences: it starts no daemon while the network is off,
        // and a stop that could not remove a directory left no daemon all the same.
        let startOff = "the network is switched off in Diplomat's settings: no daemon was started"
        let stopLeft = "/h/ca and /h/runs could not be removed. The next --stop-daemon tries again."
        installerError.add(startOff)
        store.networkEnabled = true
        await store.networkLifecycle?.value
        check("a start the installer refuses with the network off is said in its sentence",
              feedDetails(NetworkAudit.start).last
                == "Started the Diplomacy Network daemon (ok: false): \(startOff)")
        installerError.add(stopLeft)
        let stopsBeforeLeft = installer.all.filter { $0 == "--stop-daemon" }.count
        store.networkEnabled = false
        await store.networkLifecycle?.value
        await store.runNetworkCycleOnce()
        check("a stop that left a directory says so, and is no daemon that stayed",
              feedDetails(NetworkAudit.stop).last
                == "Stopped the Diplomacy Network daemon (ok: false): \(stopLeft)"
                && store.networkState == nil && store.networkAnswered == nil
                && store.networkTrouble == nil
                && installer.all.filter { $0 == "--stop-daemon" }.count == stopsBeforeLeft + 1)
        installerError.add("")

        // 26. An ask is answered by work that ran, not by its offer. Offered, it stands
        //     marked and is not offered twice; its run finishing forgets it, and so does
        //     the operator taking the offer back, and the network giving it up with its
        //     attempts used; one whose offer ended unrun - its pool closed, or withdrawn
        //     as the switch goes off - is as it was, for the next drain.
        startDaemon()
        script.set(snapshot())
        store.networkEnabled = true
        await store.networkLifecycle?.value
        _ = AgentRegistry.forget(Set(AgentRegistry.load().map(\.runID)))
        store.requestedWork = []
        // Ends the cycle the refusals above staged work in.
        store.commitQueue()
        store.queuedTasks = []
        let sweptPRs = [90280, 90281, 90282, 90283, 90284, 90285]
        store.prs = sweptPRs.map { n in
            OpenPR(number: n, title: "PR \(n)", url: url(n), isDraft: true, author: "LatekVO",
                   createdAt: Date(), readyForReviewAt: nil, files: [], reviewDecision: nil,
                   reviewThreads: [])
        }
        let offersSwept = requests(NetworkRoute.offer).count
        let swept = store.requestReviewSweep(ReviewConfig(
            depth: "deep", target: .mine, me: "LatekVO", includeDrafts: true,
            includeReady: false))
        await store.drainQueuedTasks(snaps: [], closed: [])
        let carried = sweptPRs.map(taskOf)
        func asks() -> [String] { store.requestedWork.map { "\($0.number) \($0.offered)" } }
        let askSpent = ping(90285, startedBy: carried[5])
        store.refreshComms()
        check("an offered ask stands, marked with the task that carries it",
              swept.queued == 6 && requests(NetworkRoute.offer).count == offersSwept + 6
                && asks() == zip(sweptPRs, carried).map { "\($0) \($1)" })
        script.set(snapshot(offers: carried.map { offerRow($0, "pooled") }))
        await store.settleAgents()
        store.offerRequestedWork()
        store.commitQueue()
        await store.drainQueuedTasks(snaps: [], closed: [])
        check("…and is neither queued nor offered again while the pool holds it",
              store.queuedTasks.isEmpty && AgentRegistry.load().count == 6
                && requests(NetworkRoute.offer).count == offersSwept + 6)
        check("the mark is stored with the ask",
              Store.decodeRequestedWork(try? JSONEncoder().encode(store.requestedWork),
                                        configured: "o/r").map(\.offered) == carried)
        script.set(snapshot(offers: [
            offerRow(carried[0], "pooled"), offerRow(carried[1], "pooled"),
            offerRow(carried[2], "done", executor: away, outcome: ["ok": true]),
            offerRow(carried[3], "cancelled", reason: "the pool was closed"),
            offerRow(carried[4], "pooled"),
            offerRow(carried[5], "failed", reason: "the container exited 137"),
        ]))
        await store.settleAgents()
        check("a run that finished forgets its ask; an offer that ended unrun keeps it",
              store.requestedWork.map(\.number).prefix(4) == [90280, 90281, 90283, 90284]
                && booked(carried[2]) == nil && booked(carried[3]) == nil)
        check("an offer the network gave up with its attempts used ends its ask",
              store.requestedWork.map(\.number) == [90280, 90281, 90283, 90284]
                && booked(carried[5]) == nil)
        check("…and a ping whose run that was reads that it failed, and is finished",
              pinged(askSpent)?.outcome == Store.commsNetworkFailedOutcome
                    + " (refused by the network: the container exited 137)"
                && pinged(askSpent)?.finishedAt != nil)
        script.refuse(NetworkRoute.withdraw, (409, "The task is not yours."))
        if let theirs = poolTask(carried[4], here: false) {
            await store.stopNetworkTask(theirs, pool: "github.com/o/r")
        }
        script.refuse(NetworkRoute.withdraw, nil)
        check("a withdrawal the daemon refused leaves the ask standing",
              store.requestedWork.map(\.number) == [90280, 90281, 90283, 90284])
        if let theirs = poolTask(carried[4], here: false) {
            await store.stopNetworkTask(theirs, pool: "github.com/o/r")
        }
        check("an offer the operator takes back takes its ask with it",
              requests(NetworkRoute.withdraw).last?["taskId"] as? String == carried[4]
                && store.requestedWork.map(\.number) == [90280, 90281, 90283])
        script.set(snapshot(offers: [
            offerRow(carried[0], "pooled"), offerRow(carried[1], "pooled"),
            offerRow(carried[4], "cancelled", reason: "stopped"),
        ]))
        await store.settleAgents()
        store.offerRequestedWork()
        store.commitQueue()
        check("the ask whose offer ended unrun is queued again, unmarked",
              store.queuedTasks.map(\.job.prNumber) == [90283]
                && asks() == ["90280 \(carried[0])", "90281 \(carried[1])", "90283 "])
        await store.drainQueuedTasks(snaps: [], closed: [])
        let again = taskOf(90283)
        check("…and the drain offers it afresh",
              requests(NetworkRoute.offer).count == offersSwept + 7
                && asks().last == "90283 \(again)")
        if let run = booked(again) { store.forgetRun(run.runID) }
        for _ in 0..<50 where store.requestedWork.count > 2 {
            try? await Task.sleep(nanoseconds: 100_000_000)
        }
        check("a run the operator forgets takes its ask with it",
              store.requestedWork.map(\.number) == [90280, 90281])
        for _ in 0..<50 where booked(again) != nil {
            try? await Task.sleep(nanoseconds: 100_000_000)
        }
        await store.settleAgents()

        store.networkEnabled = false
        await store.networkLifecycle?.value
        store.offerRequestedWork()
        store.commitQueue()
        check("switched off with two offers still in the pool, each ask is as it was",
              AgentRegistry.load().isEmpty && asks() == ["90280 ", "90281 "]
                && store.queuedTasks.map(\.job.prNumber) == [90280, 90281])
        let (terminalsOff, offersAsked) = (AgentSpawner.refusedTerminals,
                                           requests(NetworkRoute.offer).count)
        // A terminal that will not open ends a drain, so the second is run by hand.
        await store.drainQueuedTasks(snaps: [], closed: [])
        await store.executeQueuedTask(store.queuedTasks.last?.id ?? "")
        check("…and the queue starts each on this machine, offering nothing",
              AgentSpawner.refusedTerminals == terminalsOff + 2
                && requests(NetworkRoute.offer).count == offersAsked
                && store.requestedWork.map(\.number) == [90280, 90281])

        // 27. The settings are the shared file's: written there by another process, they
        //     are followed on the next cycle, the switch as one moved here is.
        store.queuedTasks = []
        store.requestedWork = []
        script.set(snapshot())
        func stops() -> Int { installer.all.filter { $0 == "--stop-daemon" }.count }
        store.writesConfig = false
        store.networkEnabled = true
        await store.networkLifecycle?.value
        await store.runNetworkCycleOnce()
        check("a store that writes no config keeps the switch it was given", store.networkEnabled)
        store.networkEnabled = false
        await store.networkLifecycle?.value
        store.writesConfig = true
        let (startsOutside, stopsOutside) = (starts(), stops())
        storeRaw(NetworkSettings.enabledKey, true)
        storeRaw(NetworkSettings.requiredMinimumHKey, 35.5)
        storeRaw(NetworkSettings.devicesKey, true)
        await store.runNetworkCycleOnce()
        await store.networkLifecycle?.value
        check("a switch another process turned on in config.json is followed on the next cycle",
              store.networkEnabled && starts() == startsOutside + 1
                && store.networkAnswered == true)
        check("…and so are the hours and the devices setting",
              store.networkRequiredMinimumH == 36 && store.networkDevices)
        check("…none of them written back",
              AppConfig.read()[NetworkSettings.requiredMinimumHKey] as? Double == 35.5)

        // 28. Devices: the setting is the daemon's `networkDevices`, and the snapshot's
        //     word on them is drawn as it changes.
        store.networkDevices = false
        let devicesOff = AppConfig.read()[NetworkSettings.devicesKey] as? Bool
        store.networkDevices = true
        check("the devices switch is saved to config.json as networkDevices",
              devicesOff == false && AppConfig.read()["networkDevices"] as? Bool == true)
        func devices(_ state: String, _ detail: String = "") -> [String: Any] {
            var doc = snapshot()
            doc["devices"] = ["state": state, "detail": detail]
            return doc
        }
        script.set(devices("ready"))
        await store.runNetworkCycleOnce()
        let ready = store.networkState?.devices
        script.set(devices("none", "no adb server answers"))
        await store.runNetworkCycleOnce()
        check("the snapshot's word on devices is published, and again when it alone changes",
              ready?.state == "ready" && ready?.detail == ""
                && store.networkState?.devices.state == "none"
                && store.networkState?.devices.detail == "no adb server answers")
        check("the devices setting says what it gives",
              NetworkText.devicesTitle == "Let jobs use this machine's devices"
                && NetworkText.devicesSummary == "Off: jobs see no device. On: a job running "
                    + "here can use the Android devices and emulators attached to this machine "
                    + "through adb - including a phone on USB - and an emulator can reach "
                    + "services on this machine. It is one switch for every pool this "
                    + "machine is in: switch it on only when you trust all their machines with "
                    + "that. Either way it applies to jobs started afterwards.")

        // 29. What the screen's buttons say they do.
        check("a restart is said to leave the jobs running",
              NetworkText.restartHelp == "Stop the running daemon and start this checkout's. "
                + "Jobs running in containers here keep running, and the daemon that starts "
                + "takes them up.")
        if let mine = poolTask("t-here", here: true), let theirs = poolTask("t-away", here: false) {
            check("a task this machine runs is stopped, one it only offered is withdrawn",
                  NetworkText.stopButton(mine) == ("Stop", NetworkText.stopRunHelp)
                    && NetworkText.stopButton(theirs) == ("Withdraw", NetworkText.withdrawHelp))
        } else {
            check("the pool's tasks are read", false)
        }
        script.set(snapshot())

        // 30. A job in a directory that is no linked repository's is offered nowhere; one
        //     that names no directory works in the primary root.
        func audit(in directory: String?) -> Store.AgentJob {
            Store.AgentJob(kind: "audit", auditAction: "audit", label: "Audit", prompt: "audit it",
                           prURL: nil, prNumber: nil, authorLogin: nil, counter: nil,
                           directory: directory)
        }
        let offersNowhere = requests(NetworkRoute.offer).count
        check("a job whose directory is no linked repository's is refused",
              await store.dispatchAgent(audit(in: scratch.appendingPathComponent("stray").path),
                                        source: .panel)
                == .networkRefused("no repository to offer it into")
                && requests(NetworkRoute.offer).count == offersNowhere)
        check("…and one that names no directory goes to the primary root's pool",
              isOffered(await store.dispatchAgent(audit(in: nil), source: .panel))
                && requests(NetworkRoute.offer).last?["pool"] as? String == "github.com/o/r")

        //     A linked repository on a host the network has no rules for has no pool, the
        //     screen is told why, and none of its jobs is offered.
        let cloud = PRRef.LocalRepo(owner: "acme", repo: "cloud",
                                    path: scratch.appendingPathComponent("cloud").path,
                                    host: "acme.ghe.com")
        store.pinRoots([root, lab, cloud])
        store.pinGitLabMe("ilatka", host: cloud.host)
        let (poolsBeforeCloud, offersBeforeCloud) = (
            requests(NetworkRoute.pools).count, requests(NetworkRoute.offer).count)
        await store.runNetworkCycleOnce()
        check("a repository on a host the network has no rules for has no pool, and is named",
              requests(NetworkRoute.pools).count == poolsBeforeCloud
                && store.networkPoolsHeld
                    == "acme/cloud is on acme.ghe.com, which the Diplomacy Network has no "
                        + "rules for: it has no pool and none of its jobs is offered")
        check("…and a job in it is refused without asking the daemon",
              await store.dispatchAgent(audit(in: cloud.path), source: .panel)
                == .networkRefused("the network has no rules for a repository on acme.ghe.com")
                && requests(NetworkRoute.offer).count == offersBeforeCloud)
        store.pinRoots([root, lab])
        await store.runNetworkCycleOnce()
        check("…and off the list it is named no more", store.networkPoolsHeld.isEmpty)

        // 31. A request body is not an argument of curl: one longer than an argument list
        //     may be arrives whole.
        let long = String(repeating: "x", count: 1_200_000)
        let longReply = await Task.detached {
            DiplomacyNetwork.post(NetworkRoute.offer, ["pool": "p", "prompt": long])
        }.value
        var tookLong = false
        if case .ok = longReply { tookLong = true }
        check("a body longer than an argument list may be reaches the daemon whole",
              tookLong && (requests(NetworkRoute.offer).last?["prompt"] as? String)?.count
                == long.count)

        // 32. A job is this machine's when the ended offer says its executor is, and no
        //     one's here when the attempts ran out with nobody holding it.
        check("an offer row has the members the daemon lists",
              Set(offerRow("t", "pooled").keys) == [
                "taskId", "pool", "kind", "item", "title", "state", "executor", "executorHere",
                "attempt", "requests", "refused", "outcome", "reason", "offeredAt", "endedAt"])
        func runnerBooked(_ n: Int, _ state: String, executor: String) async -> String? {
            guard case .offered(let task) = await store.dispatchAgent(job(n), source: .auto)
            else { return nil }
            script.set(snapshot(offers: [offerRow(task, state, executor: executor, outcome: [
                "ok": state == "done", "summary": "", "usd": 0.25, "tokens": 800,
                "runner": "claude", "model": "m",
            ])]))
            await store.settleAgents()
            return ledger("done", key: ledgerKey(n)).first?["runner"] as? String
        }
        check("a finished offer that names this machine is booked to its runner",
              await runnerBooked(90296, "done", executor: here) == "claude")
        check("…one that names another machine, to none of this machine's",
              await runnerBooked(90297, "done", executor: away) == DiplomacyNetwork.foreignRunner)
        check("an outcome nobody held when the attempts ran out is not this machine's",
              await runnerBooked(90298, "failed", executor: "") == DiplomacyNetwork.foreignRunner)

        // 33. A merged run's withdrawal is final only on a definite answer: a 5xx is
        //     asked again, a refusal is not.
        var merging = ""
        if case .offered(let task) = await store.dispatchAgent(job(90299), source: .auto) {
            merging = task
        }
        script.set(snapshot(offers: [offerRow(merging, "claimed", executor: away)]))
        await store.settleAgents()
        script.refuse(NetworkRoute.withdraw, (503, "The Diplomacy Network daemon is stopping."))
        store.pinMergedPRs(["o/r#90299"])
        let withdrawalsMerged = requests(NetworkRoute.withdraw).count
        func kept() -> Int {
            feedDetails(NetworkAudit.withdraw).filter { $0.contains("the network kept its offer") }
                .count
        }
        let keptBefore = kept()
        await store.settleAgents()
        check("a withdrawal answered 503 does not retire the merged run",
              requests(NetworkRoute.withdraw).count == withdrawalsMerged + 1
                && booked(merging) != nil && kept() == keptBefore)
        await store.settleAgents()
        check("…and is made again on the next tick",
              requests(NetworkRoute.withdraw).count == withdrawalsMerged + 2
                && booked(merging) != nil)
        script.refuse(NetworkRoute.withdraw, (409, "that task is another machine's"))
        await store.settleAgents()
        check("a refusal is final, and is said",
              booked(merging) == nil && kept() == keptBefore + 1
                && feedDetails(NetworkAudit.withdraw).last?
                    .hasSuffix("the network kept its offer: that task is another machine's") == true)
        script.refuse(NetworkRoute.withdraw, nil)
        store.pinMergedPRs([])

        // 34. An offer of the operator's the daemon gave no definite answer to is kept:
        //     booked when the snapshot lists it, offered again when it does not, dropped
        //     with the sentence when refused, withdrawn when the switch goes off.
        func item(_ n: Int) -> String {
            NetworkOffer.item(kind: NetworkOffer.kindReview, number: n, prompt: "review \(n)")
        }
        func offering() -> [Int] { store.networkOffering.compactMap(\.job.prNumber) }
        script.set(snapshot())
        script.refuse(NetworkRoute.offer, (500, "boom"))
        let unsure = await store.dispatchAgent(job(90301), source: .panel)
        check("an offer of the operator's with no definite answer is kept, and reads offering",
              unsure == .offering && offering() == [90301]
                && statusText(for: unsure, terminal: "Terminal") == "Offering to the pool…"
                && !AgentRegistry.load().contains { $0.prNumber == 90301 })
        check("…while automatic work is refused as before, the queue offering it again",
              await store.dispatchAgent(job(90302), source: .auto) == .networkDown("boom")
                && offering() == [90301])
        store.commitQueue()
        store.queuedTasks = []
        let offersUnsure = requests(NetworkRoute.offer).count
        await store.runNetworkCycleOnce()
        check("the next cycle makes the offer again, and keeps it while there is no answer",
              requests(NetworkRoute.offer).count == offersUnsure + 1 && offering() == [90301])
        script.set(snapshot(offers: [
            offerRow("task-ended", "cancelled", item: item(90301)),
            offerRow("task-held", "pooled", item: item(90301)),
        ]))
        await store.runNetworkCycleOnce()
        check("found open in the snapshot by pool, kind and item, it is booked, not offered",
              requests(NetworkRoute.offer).count == offersUnsure + 1 && offering().isEmpty
                && booked("task-held")?.prNumber == 90301
                && booked("task-held")?.source == "panel")
        _ = await store.dispatchAgent(job(90303), source: .panel)
        script.refuse(NetworkRoute.offer, nil)
        await store.runNetworkCycleOnce()
        check("one the snapshot does not list is offered again, and booked when taken",
              offering().isEmpty && AgentRegistry.load().contains { $0.prNumber == 90303 })
        script.refuse(NetworkRoute.offer, (500, "boom"))
        _ = await store.dispatchAgent(job(90304), source: .panel)
        script.refuse(NetworkRoute.offer, (409, "o/r has no pool on this machine"))
        await store.runNetworkCycleOnce()
        check("one the daemon refuses is dropped with the sentence",
              offering().isEmpty && !AgentRegistry.load().contains { $0.prNumber == 90304 }
                && feedDetails(NetworkAudit.unavailable).last
                    == "Review-req · #90304 was not offered: o/r has no pool on this machine")
        script.refuse(NetworkRoute.offer, (500, "boom"))
        _ = await store.dispatchAgent(job(90305), source: .panel)
        _ = await store.dispatchAgent(job(90306), source: .panel)
        script.refuse(NetworkRoute.offer, nil)
        script.set(snapshot(offers: [offerRow("task-off", "pooled", item: item(90305))]))
        // Switched off by another process: followed, and the offer it held withdrawn.
        storeRaw(NetworkSettings.enabledKey, false)
        await store.runNetworkCycleOnce()
        await store.networkLifecycle?.value
        check("a switch another process turned off is followed, and the daemon stopped",
              !store.networkEnabled && stops() == stopsOutside + 1)
        check("…and an unanswered offer the daemon turned out to hold is withdrawn",
              offering().isEmpty && requests(NetworkRoute.withdraw).contains {
                  $0["taskId"] as? String == "task-off"
                      && $0["reason"] as? String == NetworkRoute.withdrawSwitchedOff
              })
        check("…and one it does not hold is said not to have been offered",
              feedDetails(NetworkAudit.unavailable).last
                == "Review-req · #90306 was not offered: \(DiplomacyNetwork.switchedOff)")

        // 35. A job the daemon refuses for a reason of the job's own waits on its row
        //     with the reason, said once, and the queue goes on past it; a daemon that
        //     takes no job stops the queue and marks no row.
        store.networkEnabled = true
        await store.networkLifecycle?.value
        script.set(snapshot())
        await store.runNetworkCycleOnce()
        _ = AgentRegistry.forget(Set(AgentRegistry.load().map(\.runID)))
        func queue(_ numbers: Int...) {
            store.commitQueue()
            store.queuedTasks = numbers.map { n in
                Store.QueuedAgentTask(id: AgentTaskQueue.key(auditAction: "review-req", item: "o/r#\(n)"),
                                job: job(n), attemptNumber: 1)
            }
        }
        func offeredItems(since n: Int) -> [String] {
            requests(NetworkRoute.offer).dropFirst(n).compactMap { $0["item"] as? String }
        }
        func said(since n: Int) -> [String] {
            Array(feedDetails(NetworkAudit.unavailable).dropFirst(n))
        }
        let noRules = "That pool's rules name no review."
        let label = "Review-req · #90401"
        script.refuseOffer(item: item(90401), (409, noRules))
        queue(90401, 90402)
        var asked = requests(NetworkRoute.offer).count
        let unavailable = feedDetails(NetworkAudit.unavailable).count
        await store.drainQueuedTasks(snaps: [], closed: [])
        check("a job refused for a reason of its own does not stop the queue",
              offeredItems(since: asked) == [item(90401), item(90402)]
                && AgentRegistry.load().map(\.prNumber) == [90402])
        store.commitQueue()
        check("…and waits on its row with the reason",
              store.queuedTasks.map(\.job.prNumber) == [90401]
                && store.networkJobRefusals == [label: noRules])
        await store.drainQueuedTasks(snaps: [], closed: [])
        store.commitQueue()
        check("…said once for the job, however often it is refused",
              said(since: unavailable) == ["\(label) was not offered: \(noRules)"]
                && store.networkJobRefusals == [label: noRules])
        script.refuseOffer(item: item(90401), (409, "o/r has no pool on this machine"))
        await store.drainQueuedTasks(snaps: [], closed: [])
        store.commitQueue()
        check("…and again for another reason",
              said(since: unavailable).count == 2
                && store.networkJobRefusals == [label: "o/r has no pool on this machine"])
        script.refuseOffer(item: item(90401), nil)
        await store.drainQueuedTasks(snaps: [], closed: [])
        check("the offer that goes through takes the reason off its row",
              store.networkJobRefusals.isEmpty
                && AgentRegistry.load().contains { $0.prNumber == 90401 })
        var odd = job(90407)
        odd.auditAction = "translate"
        store.commitQueue()
        store.queuedTasks = [
            Store.QueuedAgentTask(id: AgentTaskQueue.key(auditAction: "review-req", item: "o/r#90407"),
                                  job: odd, attemptNumber: 1),
            Store.QueuedAgentTask(id: AgentTaskQueue.key(auditAction: "review-req", item: "o/r#90408"),
                                  job: job(90408), attemptNumber: 1),
        ]
        asked = requests(NetworkRoute.offer).count
        await store.drainQueuedTasks(snaps: [], closed: [])
        check("a job no offer can be made of is refused for a reason of its own",
              offeredItems(since: asked) == [item(90408)]
                && store.networkJobRefusals
                    == ["Review-req · #90407": "the network runs no translate jobs"])
        script.refuseOffer(item: item(90405), (409, noRules))
        queue(90405)
        await store.drainQueuedTasks(snaps: [], closed: [])
        store.commitQueue()
        let waiting = store.networkJobRefusals
        // A cycle that offers the job no more: its row goes.
        store.commitQueue()
        check("a row that left the queue takes its reason with it",
              waiting == ["Review-req · #90405": noRules] && store.queuedTasks.isEmpty
                && store.networkJobRefusals.isEmpty)
        script.refuseOffer(item: item(90405), nil)
        for (name, answer) in [("stopping", (503, "The Diplomacy Network daemon is stopping.")),
                               ("at fault", (500, "boom"))] {
            script.refuse(NetworkRoute.offer, answer)
            queue(90403, 90404)
            asked = requests(NetworkRoute.offer).count
            await store.drainQueuedTasks(snaps: [], closed: [])
            check("a daemon that is \(name) takes no job: the queue stops, and no row is marked",
                  offeredItems(since: asked) == [item(90403)] && store.networkJobRefusals.isEmpty)
        }
        script.refuse(NetworkRoute.offer, (409, noRules))
        queue(90406)
        await store.drainQueuedTasks(snaps: [], closed: [])
        let marked = store.networkJobRefusals.count
        store.networkEnabled = false
        await store.networkLifecycle?.value
        check("switching the network off forgets the reasons",
              marked == 1 && store.networkJobRefusals.isEmpty)
        script.refuse(NetworkRoute.offer, nil)
        store.commitQueue()
        store.queuedTasks = []

        // 37. What of the network does not work here is the panel's line: nothing while
        //     it is off or coming up, each failed service with the daemon's detail, and a
        //     daemon that does not answer.
        check("switched off, the panel says nothing of the network", store.networkTrouble == nil)
        script.set(snapshot())
        store.networkEnabled = true
        await store.networkLifecycle?.value
        await store.runNetworkCycleOnce()
        check("…nor while every service is ready",
              store.networkAnswered == true && store.networkTrouble == nil)
        var broken = snapshot()
        broken["transport"] = ["state": "failed", "detail": "tor not found"]
        broken["docker"] = ["state": "building", "image": "", "detail": "building the job image"]
        script.set(broken)
        await store.runNetworkCycleOnce()
        check("a transport that failed is said with the daemon's detail, a service coming up is not",
              store.networkTrouble == "Diplomacy Network: transport failed (tor not found)")
        stopDaemon()
        await store.runNetworkCycleOnce()
        check("a daemon that does not answer is said",
              store.networkTrouble == "Diplomacy Network: the daemon is not answering")
        startDaemon()
        store.networkEnabled = false
        await store.networkLifecycle?.value
        check("…and switched off again, nothing is", store.networkTrouble == nil)

        // 41. A restart asked for while the daemon is being started or stopped is dropped.
        store.networkEnabled = true
        await store.networkLifecycle?.value
        let installsBefore = installer.all.count
        store.networkBusy = true
        await store.startNetworkDaemon(restart: true)
        store.networkBusy = false
        check("a restart asked for while another daemon action runs is dropped",
              installer.all.count == installsBefore)
        await store.startNetworkDaemon(restart: true)
        check("…and one asked for after it runs",
              installer.all.count == installsBefore + 1)

        // 42. A socket nothing listens on was not reached, which an offer may rely on:
        //     no answer from a daemon that was reached leaves the offer in doubt.
        stopDaemon()
        let staleSocket = FakeDaemon.stale(path: socket)
        let unheard = await Task.detached {
            DiplomacyNetwork.package.send(NetworkRoute.offer, timeoutSecs: 2)
        }.value
        startDaemon()
        var notReached = false
        if case .unreachable = unheard { notReached = true }
        check("a request to a socket file nothing listens on was not delivered",
              staleSocket && notReached)

        // 43. A pass begun before the switch went off says nothing of the daemon as it is.
        script.set(snapshot(offers: [offerRow("task-stale", "claimed", executor: away)]))
        bookByHand(90430, task: "task-stale")
        let claimedBefore = feedDetails(NetworkAudit.claimed).count
        let stalePass = await store.agentTick()
        store.networkEnabled = false
        await store.networkLifecycle?.value
        store.publishNetwork(stalePass)
        check("a pass begun before the switch went off publishes nothing of the daemon",
              stalePass.networkAsked && stalePass.network != nil
                && store.networkState == nil && store.networkAnswered == nil
                && feedDetails(NetworkAudit.claimed).count == claimedBefore)

        // 39. The hours say when they leave this machine none of its own jobs.
        check("hours that leave this machine none of its own jobs say so",
              NetworkText.hoursNote(required: 48, accepted: 48) == nil
                && NetworkText.hoursNote(required: 72, accepted: 48)
                    == "This machine takes none of its own jobs: one may take 72 h, and the "
                        + "longest job it takes is 48 h.")

        // 40. A git call that hangs is ended at its budget, and reads as a checkout git
        //     failed on.
        let realGit = LocalRepos.gitCall
        let hung = scratch.appendingPathComponent("hung-git")
        try? Data("#!/bin/sh\nexec sleep 30\n".utf8).write(to: hung)
        try? FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: hung.path)
        LocalRepos.gitCall = (hung.path, 0.5)
        let gitAsked = Date()
        let remotes = LocalRepos.readRemotes(of: bare)
        let gitTook = Date().timeIntervalSince(gitAsked)
        LocalRepos.gitCall = realGit
        check("a git call that hangs is ended at its budget",
              remotes == nil && gitTook >= 0.4 && gitTook < 5)
        check("…and the real one still reads the checkout",
              LocalRepos.readRemotes(of: bare)?.contains("github.com/acme/") == true)

        // 38. A config that is there and cannot be read says nothing: the switch stays
        //     as it was last read, nothing is withdrawn, retired or started on it, and
        //     no setting is written over the file.
        script.set(snapshot(offers: [offerRow("task-cfg", "pooled")]))
        store.networkEnabled = true
        await store.networkLifecycle?.value
        bookByHand(90380, task: "task-cfg")
        await store.runNetworkCycleOnce()
        var testDaemon = snapshot(offers: [offerRow("task-cfg", "pooled")])
        testDaemon["daemon"] = (testDaemon["daemon"] as? [String: Any] ?? [:])
            .merging(["testSettings": ["DN_LEASE_SECS=60", "DN_TRANSPORT=loop"]]) { $1 }
        script.set(testDaemon)
        await store.runNetworkCycleOnce()
        let testedNote = "The daemon runs with settings only a test gives it, and is not "
            + "one for the network: DN_LEASE_SECS=60, DN_TRANSPORT=loop"
        await screenSettles { screenShows(testedNote) }
        check("what only a test gave the daemon is read from its snapshot",
              store.networkState?.testSettings == ["DN_LEASE_SECS=60", "DN_TRANSPORT=loop"])
        check("…and the Network screen says so", screenShows(testedNote))
        script.set(snapshot(offers: [offerRow("task-cfg", "pooled")]))
        await store.runNetworkCycleOnce()
        await screenSettles { !screenShows(testedNote) }
        check("…and a daemon that lists none is not", !screenShows(testedNote))
        let configWhole = (try? Data(contentsOf: AppConfig.url)) ?? Data()
        let configWithdrawn = requests(NetworkRoute.withdraw).count
        func unreadableNotes() -> Int {
            feedDetails("warn").filter { $0 == AppConfig.unreadableNote }.count
        }
        script.refuse(NetworkRoute.offer, (500, "boom"))
        _ = await store.dispatchAgent(job(90381), source: .panel)
        script.refuse(NetworkRoute.offer, nil)
        let offeredBeforeSpell = requests(NetworkRoute.offer).count
        try? configWhole.dropLast(3).write(to: AppConfig.url)
        script.set(snapshot(offers: [offerRow("task-cfg", "pooled"),
                                     offerRow("task-cfg-held", "pooled", item: item(90381))]))
        await store.runNetworkCycleOnce()
        await store.settleAgents()
        check("one brace short, the config says nothing: the switch stays on",
              AppConfig.unreadable && store.networkEnabled)
        check("…nothing is withdrawn and the run stays booked",
              requests(NetworkRoute.withdraw).count == configWithdrawn
                && booked("task-cfg") != nil)
        check("…and an offer the daemon had not answered is settled against what it holds",
              offering() == [] && booked("task-cfg-held")?.prNumber == 90381
                && requests(NetworkRoute.offer).count == offeredBeforeSpell)
        await store.runNetworkCycleOnce()
        check("…and the feed says so once for the spell", unreadableNotes() == 1)
        let unknown = NetworkSettings.unknown(path: AppConfig.url.path)
        let saidInSpell = [NetworkRoute.pools, NetworkRoute.admit].map { requests($0).count }
        await store.runNetworkCycleOnce(now: Date().timeIntervalSince1970 + 120)
        check("…the cap is not said again as a default would have it",
              [NetworkRoute.pools, NetworkRoute.admit].map { requests($0).count } == saidInSpell)
        await screenSettles { screenShows(NetworkSettings.unknownNote(unknown)) }
        check("…and the panel and the Network screen say that the settings cannot be read",
              store.networkTrouble == "Diplomacy Network: \(unknown)"
                && screenShows(NetworkSettings.unknownNote(unknown)))
        let limit = store.autoTaskLimit
        store.networkDevices.toggle()
        check("no setting is saved over a file that cannot be read",
              !AppConfig.setInt(AppConfig.autoTaskLimitKey, limit + 1)
                && !AppConfig.setBool(NetworkSettings.enabledKey, false)
                && !AppConfig.set(AppConfig.agentTokenKeychainItemKey, "x")
                && !AppConfig.setDouble(AppConfig.autoBudgetFloorPctKey, 1)
                && !AppConfig.setRepoRoots(["/nowhere"])
                && !AppConfig.update { _ in [:] }
                && (try? Data(contentsOf: AppConfig.url)) == configWhole.dropLast(3)
                && store.configSaveFailed)
        await screenSettles { screenShows(AllocatorUI.saveError) }
        check("…and the Network screen says the change was not saved",
              screenShows(AllocatorUI.saveError))
        store.networkEnabled = false
        check("…and a switch that would not save stays where it was", store.networkEnabled)
        try? Data().write(to: AppConfig.url)
        await store.runNetworkCycleOnce()
        check("an empty file is one that cannot be read", AppConfig.unreadable && store.networkEnabled)
        try? configWhole.write(to: AppConfig.url)
        await store.runNetworkCycleOnce()
        try? Data("[]".utf8).write(to: AppConfig.url)
        await store.runNetworkCycleOnce()
        check("an array is no settings either, and a second spell is said again",
              AppConfig.unreadable && store.networkEnabled && unreadableNotes() == 2)
        try? Data("{\"networkEnabled\": \"true\"}".utf8).write(to: AppConfig.url)
        await store.runNetworkCycleOnce()
        await store.networkLifecycle?.value
        check("what can be read is believed: a value that is no boolean is off",
              !AppConfig.unreadable && !store.networkEnabled)
        try? FileManager.default.removeItem(at: AppConfig.url)
        check("…and no file is no setting, which a write may follow",
              !AppConfig.unreadable && AppConfig.setInt(AppConfig.autoTaskLimitKey, limit))
        check("…and the settings are known again",
              store.networkTrouble == nil && !screenShows(NetworkSettings.unknownNote(unknown)))

        // 44. The switch is on record beside the config as each reading had it: a
        //     Diplomat that starts while the config cannot be read takes that for the
        //     switch, starts no agent in a terminal and takes no offer back.
        let switchRecord = AppConfig.url.deletingLastPathComponent()
            .appendingPathComponent("network-switch.json")
        func isRecorded(_ on: Bool) -> Bool {
            let record = (try? Data(contentsOf: switchRecord))
                .flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [String: Any]
            return record?.count == 2 && record?["config"] as? String == AppConfig.url.path
                && record?[NetworkSettings.enabledKey] as? Bool == on
        }
        check("a switch that went off is on record as off", isRecorded(false))
        let linked = scratch.appendingPathComponent("linked").path
        git("init", "-q", linked)
        git("-C", linked, "remote", "add", "origin", "https://github.com/o/linked.git")
        let linkedPool: [String: Any] = [
            "id": "github.com/o/linked", "path": linked, "identity": "latekvo", "hash": "h",
            "members": [[String: Any]](), "tasks": [[String: Any]]()]
        if daemon == nil { startDaemon() }
        script.set(snapshot(offers: [offerRow("task-launch", "pooled")], more: [linkedPool]))
        check("the linked root is saved", AppConfig.setRepoRoots([linked]))
        storeRaw(NetworkSettings.enabledKey, true)
        storeRaw(AppConfig.autoTaskLimitKey, 5)
        await store.runNetworkCycleOnce()
        await store.networkLifecycle?.value
        check("the switch a reading of the config had is on record beside it",
              store.networkEnabled && isRecorded(true))
        bookByHand(90400, task: "task-launch")
        let launchWhole = (try? Data(contentsOf: AppConfig.url)) ?? Data()
        try? launchWhole.dropLast(3).write(to: AppConfig.url)

        let fresh = Store()
        fresh.writesConfig = true
        fresh.me = "latekvo"
        fresh.reviewRequestsEnabled = true
        fresh.queueAutoRun = true
        func saidOf() -> [Int] {
            [NetworkRoute.pools, NetworkRoute.admit, NetworkRoute.offer, NetworkRoute.withdraw]
                .map { requests($0).count }
        }
        let (saidAtLaunch, terminalsAtLaunch, notesAtLaunch) = (
            saidOf(), AgentSpawner.refusedTerminals, unreadableNotes())
        check("a Diplomat that starts on a config it cannot read keeps the switch last read",
              AppConfig.unreadable && fresh.networkEnabled)
        check("…and knows before its first cycle that neither its settings nor its roots "
                + "are the config's",
              fresh.networkTrouble == "Diplomacy Network: \(unknown)" && fresh.rootsReadBlind)
        await fresh.runNetworkCycleOnce()
        await fresh.settleAgents()
        await fresh.refreshRoots()
        await fresh.runNetworkCycleOnce(now: Date().timeIntervalSince1970 + 120)
        let heldJobs = [await fresh.dispatchAgent(job(90401), source: .auto),
                    await fresh.dispatchAgent(job(90402), source: .auto, forced: true),
                    await fresh.dispatchAgent(job(90403), source: .panel)]
        fresh.commitQueue()
        var launchThrown: Error?
        do {
            _ = try await fresh.spawnTracked(kind: "review", label: "x", prURL: nil,
                                             prNumber: nil, prompt: "", source: "panel",
                                             terminal: fresh.terminal)
        } catch { launchThrown = error }
        check("…nothing is withdrawn or retired, and nothing a setting decides is said",
              saidOf() == saidAtLaunch && booked("task-launch") != nil
                && fresh.networkAnswered == true)
        check("…no agent starts in a terminal, and each job is answered with why",
              AgentSpawner.refusedTerminals == terminalsAtLaunch
                && heldJobs == Array(repeating: .networkDown(unknown), count: 3)
                && (launchThrown as? AgentSpawner.SpawnError).map {
                    if case .network = $0 { return true } else { return false }
                } == true)
        check("…the queue has no room to drain into",
              !fresh.queuedTasks.isEmpty && !fresh.drainHasRoom(capLoad: 0))
        check("…and the panel and the feed say why",
              fresh.networkTrouble == "Diplomacy Network: \(unknown)"
                && unreadableNotes() == notesAtLaunch + 1)
        fresh.networkEnabled = false
        check("…a toggle writes nothing over the file and moves nothing",
              fresh.networkEnabled && isRecorded(true)
                && (try? Data(contentsOf: AppConfig.url)) == launchWhole.dropLast(3))

        // 45. Read again, the roots are the config's own and not the default root's:
        //     the pools list is said from them, through the real reading of the roots.
        func linkedPosted() -> Bool {
            requests(NetworkRoute.pools).last?["pools"] as? [[String: String]]
                == [["id": "github.com/o/linked", "path": linked, "forge": "github",
                     "identity": "latekvo"]]
        }
        try? launchWhole.write(to: AppConfig.url)
        await fresh.runNetworkCycleOnce()
        check("once the config reads, the pools of its own roots are said, and the cap",
              saidOf()[0] == saidAtLaunch[0] + 1 && saidOf()[1] == saidAtLaunch[1] + 1
                && linkedPosted() && fresh.networkTrouble == nil
                && fresh.drainHasRoom(capLoad: 0))
        check("…the cap being the file's and not a default's, as the roots Settings shows are",
              fresh.autoTaskLimit == 5 && fresh.repoRootPaths == [linked]
                && requests(NetworkRoute.admit).last?["slots"] as? Int == 5)
        //     One that breaks while Diplomat runs: the roots read meanwhile are the
        //     default root's, and no list of them is posted - on the timer, with the
        //     screen open, or after a restart of the daemon.
        let saidWhileRead = saidOf()
        func linkedLeft() -> Int {
            feedDetails(NetworkAudit.leave).filter { $0.contains("o/linked") }.count
        }
        let leftWhileRead = linkedLeft()
        try? launchWhole.dropLast(3).write(to: AppConfig.url)
        fresh.autoTaskLimit = 9
        fresh.repoRootPaths = ["/elsewhere"]
        check("a cap and a root typed meanwhile are not saved, and each keeps what was last read",
              fresh.autoTaskLimit == 5 && fresh.repoRootPaths == [linked] && fresh.configSaveFailed
                && (try? Data(contentsOf: AppConfig.url)) == launchWhole.dropLast(3))
        await fresh.refreshRoots()
        await fresh.runNetworkCycleOnce()
        await fresh.runNetworkCycleOnce(now: Date().timeIntervalSince1970 + 120)
        daemonPid += 1
        script.set(snapshot(offers: [offerRow("task-launch", "pooled")], more: [linkedPool]))
        let restartsBefore = installer.all.filter { $0 == "--restart-daemon" }.count
        await fresh.startNetworkDaemon(restart: true)
        check("while the roots cannot be read no list of pools is posted, to a daemon "
                + "restarted since either",
              saidOf() == saidWhileRead && fresh.networkEnabled
                && installer.all.filter { $0 == "--restart-daemon" }.count == restartsBefore + 1
                && linkedLeft() == leftWhileRead)
        //     One that breaks while the roots are read, by the git that reads them.
        let breaker = scratch.appendingPathComponent("git-breaks-config")
        try? Data("#!/bin/sh\nprintf '{' > '\(AppConfig.url.path)'\nexec \(realGit.path) \"$@\"\n".utf8)
            .write(to: breaker)
        try? FileManager.default.setAttributes([.posixPermissions: 0o755],
                                               ofItemAtPath: breaker.path)
        try? launchWhole.write(to: AppConfig.url)
        LocalRepos.gitCall = (breaker.path, realGit.timeout)
        await fresh.runNetworkCycleOnce(now: Date().timeIntervalSince1970 + 240)
        LocalRepos.gitCall = realGit
        check("a config that breaks while the roots are read is no list either, and no cap",
              AppConfig.unreadable && saidOf() == saidWhileRead)
        try? launchWhole.write(to: AppConfig.url)
        await fresh.runNetworkCycleOnce()
        check("…and read again, the list the daemon is told is the config's own",
              saidOf()[0] == saidWhileRead[0] + 1 && linkedPosted()
                && requests(NetworkRoute.admit).last?["slots"] as? Int == 5
                && linkedLeft() == leftWhileRead)
        //     One that breaks with the roots as they were last read, under a daemon
        //     that started since and has heard nothing: it is told nothing either.
        let saidRead = saidOf()
        try? launchWhole.dropLast(3).write(to: AppConfig.url)
        daemonPid += 1
        script.set(snapshot(offers: [offerRow("task-launch", "pooled")], more: [linkedPool]))
        await fresh.runNetworkCycleOnce(now: Date().timeIntervalSince1970 + 300)
        check("a daemon started since the config broke is told no list and no cap, "
                + "whenever the roots were read",
              AppConfig.unreadable && !fresh.rootsReadBlind && saidOf() == saidRead)
        try? launchWhole.write(to: AppConfig.url)
        await fresh.runNetworkCycleOnce(now: Date().timeIntervalSince1970 + 301)
        check("…and both once the config reads",
              saidOf()[0] == saidRead[0] + 1 && saidOf()[1] == saidRead[1] + 1
                && linkedPosted())

        // 46. With no switch on record a config that cannot be read is no network at
        //     all: a job starts in a terminal, and the daemon is asked nothing.
        fresh.networkEnabled = false
        await fresh.networkLifecycle?.value
        check("switched off, the record says so", isRecorded(false))
        try? FileManager.default.removeItem(at: switchRecord)
        storeRaw(NetworkSettings.enabledKey, true)
        try? launchWhole.dropLast(3).write(to: AppConfig.url)
        let cold = Store()
        cold.writesConfig = true
        func heard() -> Int { (earlier + (daemon?.requests ?? [])).count }
        let (heardCold, terminalsCold) = (heard(), AgentSpawner.refusedTerminals)
        await cold.runNetworkCycleOnce()
        let coldRun = await cold.dispatchAgent(job(90410), source: .panel)
        check("with no switch on record a broken config holds no work back",
              !cold.networkEnabled && cold.networkTrouble == nil && heard() == heardCold
                && coldRun == .failed(AgentSpawner.SpawnError.headless.localizedDescription)
                && AgentSpawner.refusedTerminals == terminalsCold + 1
                && !FileManager.default.fileExists(atPath: switchRecord.path))
        for text in ["{", "[true]", "{\"networkEnabled\": 1, \"config\": \"\(AppConfig.url.path)\"}",
                     "{\"networkEnabled\": true, \"config\": \"/elsewhere/config.json\"}",
                     "{\"networkEnabled\": true}"] {
            try? Data(text.utf8).write(to: switchRecord)
            check("a record that is none, or another config's, says nothing (\(text))",
                  !Store().networkEnabled)
        }
        try? FileManager.default.removeItem(at: switchRecord)
        try? FileManager.default.removeItem(at: AppConfig.url)

        print(pass ? "NETWORK TEST OK" : "NETWORK TEST FAILED")
        return pass
    }
}
