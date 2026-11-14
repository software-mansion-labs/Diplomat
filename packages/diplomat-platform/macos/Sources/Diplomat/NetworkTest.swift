import Foundation
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

        func respond(_ route: String, _ body: [String: Any]) -> (Int, String) {
            lock.lock(); defer { lock.unlock() }
            asked[route, default: 0] += 1
            if let (status, error) = refusals[route] {
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
            print("\(ok ? "PASS" : "FAIL") — \(name)")
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

        // 1. Only a process started as `-m szpontnet`, each a whole argv element, is
        //    ended: not a path or a module that contains the word, not one whose single
        //    argument spells it, not another user's (no argv to read), not this process.
        let own = Int(getpid())
        let argvs: [Int: [String]] = [
            4001: ["/usr/bin/python3", "-m", "szpontnet", "--daemon"],
            4002: ["/opt/szpontnet/bin/python3", "-m", "http.server"],
            4003: ["python3", "-m", "szpontnet.bench"],
            4004: ["python3", "-c", "run('-m szpontnet')"],
            4006: ["/bin/zsh", "-c", "python3 -m szpontnet"],
            own: ["python3", "-m", "szpontnet"],
        ]
        AgentProbes.pinDump(.present("""
             4001 ??       01:00 /usr/bin/python3 -m szpontnet --daemon
             4002 ??       01:00 /opt/szpontnet/bin/python3 -m http.server
             4003 ??       01:00 python3 -m szpontnet.bench
             4004 ??       01:00 python3 -c run('-m szpontnet')
             4005 ??       01:00 python3 -m szpontnet
             4006 ??       01:00 /bin/zsh -c python3 -m szpontnet
             4007 ??       01:00 /Applications/Diplomat.app/Contents/MacOS/Diplomat
             \(own) ??       01:00 python3 -m szpontnet
            """))
        let ended = Calls<Int>()
        let (realArguments, realTerminate) = (DiplomacyNetwork.argumentsOf, DiplomacyNetwork.terminate)
        DiplomacyNetwork.argumentsOf = { argvs[$0] }
        DiplomacyNetwork.terminate = { ended.add($0); return true }
        let store = Store()
        await store.endLegacyMeshNodes()
        check("the launch sweep ends the process started as -m szpontnet and no other",
              ended.all == [4001])
        check("…and says so once", feedDetails(NetworkAudit.stop).count == 1
                && feedDetails(NetworkAudit.stop).first?.contains("4001") == true)
        AgentProbes.pinDump(.present(""))
        await store.endLegacyMeshNodes()
        check("a launch that finds none says nothing",
              ended.all == [4001] && feedDetails(NetworkAudit.stop).count == 1)
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
        DiplomacyNetwork.installerForSelfTest = { verb in
            installer.add(verb)
            if verb == "--stop-daemon" { withdrawnAtStop.add(script.count(NetworkRoute.withdraw)) }
            var result = AllocatorInstall()
            result.daemonRunning = verb != "--stop-daemon" && FileManager.default.fileExists(atPath: socket)
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

        // 4. `pools` waits for every linked repository's login.
        check("pools are not posted while the GitHub login is unknown",
              requests(NetworkRoute.pools).isEmpty)
        store.me = "LatekVO"
        await store.runNetworkCycleOnce()
        check("…nor while one repository's GitLab login is",
              requests(NetworkRoute.pools).isEmpty)
        store.pinGitLabMe("ilatka", host: "gitlab.example.com")
        await store.runNetworkCycleOnce()
        let posted = requests(NetworkRoute.pools).first?["pools"] as? [[String: String]]
        check("with every login known the whole list is posted once",
              requests(NetworkRoute.pools).count == 1
                && posted == [
                    ["id": "github.com/o/r", "path": root.path, "forge": "github",
                     "identity": "latekvo"],
                    ["id": "gitlab.example.com/acme/api", "path": lab.path, "forge": "gitlab",
                     "identity": "ilatka"],
                ])
        await store.runNetworkCycleOnce()
        check("an unchanged list is not posted again", requests(NetworkRoute.pools).count == 1)

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
        check("an automatic job with the switch on is offered", offered == .offered)
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

        // 8. The row follows the daemon's word on the offer.
        func offerRow(_ task: String, _ state: String, executor: String = "",
                      reason: String = "", outcome: [String: Any]? = nil) -> [String: Any] {
            var o: [String: Any] = ["taskId": task, "state": state, "executor": executor,
                                    "reason": reason, "attempt": 1, "requests": 0, "refused": 0]
            if let outcome {
                o["outcome"] = outcome
                o["endedAt"] = 1_800_000_000.0
            }
            return o
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
        let down = await store.dispatchAgent(job(90211), source: .auto)
        check("with the daemon down an automatic job is refused with the sentence",
              down == .networkRefused(DiplomacyNetwork.notAnswering))
        store.commitQueue()
        check("…and staged back into the queue",
              store.queuedTasks.map(\.id)
                == [AgentTaskQueue.key(auditAction: "review-req", item: "o/r#90211")])
        _ = await store.dispatchAgent(job(90212), source: .auto)
        check("…logged once for the spell", feedDetails(NetworkAudit.unavailable).count == 1)
        let panelDown = await store.dispatchAgent(job(90213), source: .panel)
        check("a job the operator started gets the sentence",
              panelDown == .networkRefused(DiplomacyNetwork.notAnswering)
                && statusText(for: panelDown, terminal: "Terminal")
                    == "Not offered: \(DiplomacyNetwork.notAnswering)")
        check("…and none of them asked for a terminal or booked a run",
              AgentSpawner.refusedTerminals == refusedBefore
                && AgentRegistry.load().count == 1
                && requests(NetworkRoute.offer).count == offersBefore)
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
        check("a second job is offered", await store.dispatchAgent(job(90220), source: .auto) == .offered)
        script.set(snapshot(offers: [offerRow("task-2", "done", executor: here, outcome: [
            "ok": true, "summary": "", "usd": 0.5, "tokens": 9000, "runner": "claude", "model": "m",
        ])]))
        await store.settleAgents()
        check("a task this machine ran keeps the runner its outcome names",
              ledger("done", key: ledgerKey(90220)).first?["runner"] as? String == "claude")
        check("a third job is offered", await store.dispatchAgent(job(90221), source: .auto) == .offered)
        script.set(snapshot(offers: [offerRow("task-3", "failed", executor: away,
                                              reason: "the container exited 137")]))
        await store.settleAgents()
        check("an offer the network gave up on is logged as network-failed",
              booked("task-3") == nil && feedDetails(NetworkAudit.failed).count == 1
                && ledger("done", key: ledgerKey(90221)).isEmpty)
        check("…with the daemon's reason after the verdict",
              feedDetails(NetworkAudit.failed).first?
                .hasSuffix("refused by the network: the container exited 137") == true)

        // 15. A merged PR: withdrawn once, then forgotten.
        check("a fourth job is offered", await store.dispatchAgent(job(90230), source: .auto) == .offered)
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
        check("a fifth job is offered", await store.dispatchAgent(job(90240), source: .auto) == .offered)
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
                runs: [["runId": "run-9", "taskId": "t-here", "state": "running"]],
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
                    == DiplomacyNetwork.withdrawStopped)
        script.set(snapshot())

        // 17. What holds a network job: a pause. Not a full local cap, not a low disk.
        store.queueAutoRun = false
        setenv(DiskFloor.envOverride, "99999999999999999999", 1)
        let offersHeld = requests(NetworkRoute.offer).count
        check("a paused queue holds an automatic job, low disk or not",
              await store.dispatchAgent(job(90250), source: .auto) == .atCapacity
                && requests(NetworkRoute.offer).count == offersHeld)
        store.queueAutoRun = true
        check("a low disk does not hold one",
              await store.dispatchAgent(job(90251), source: .auto) == .offered)
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
              await store.dispatchAgent(job(90252), source: .auto) == .offered)
        store.autoTaskLimit = 3

        // 18. The four options are the prompt's own, in both polarities.
        func options(_ verb: String, _ allows: Store.AgentJob.Allows, _ n: Int,
                     prompt: String) async -> [String: Bool]? {
            let j = Store.AgentJob(kind: verb, auditAction: verb, label: "\(verb) · #\(n)",
                                   prompt: prompt, prURL: url(n), prNumber: nil,
                                   authorLogin: nil, counter: nil, directory: root.path,
                                   allows: allows)
            guard await store.dispatchAgent(j, source: .panel) == .offered,
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
                && feedDetails(NetworkAudit.join).count == 1)
        await store.leaveNetworkPool("github.com/o/r")
        check("leaving a pool names it and is logged",
              requests(NetworkRoute.leave).last?["pool"] as? String == "github.com/o/r"
                && feedDetails(NetworkAudit.leave).count == 1)
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
        _ = AppConfig.setInt(NetworkSettings.maximumAcceptedHKey, 720)

        // 22. Off again: what the network still carries is withdrawn and retired as
        //     failed before the daemon is stopped, and what it had finished is retired on
        //     its outcome.
        _ = AgentRegistry.forget(Set(AgentRegistry.load().map(\.runID)))
        func taskOf(_ n: Int) -> String {
            AgentRegistry.load().first { $0.prNumber == n }?.network ?? "no run for #\(n)"
        }
        for n in [90260, 90261, 90262] {
            check("#\(n) is offered", await store.dispatchAgent(job(n), source: .auto) == .offered)
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

        // 23. A network run found in the book while the switch is off is withdrawn and
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

        // 24. On again, a task the switch retired is announced afresh; and a daemon that
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
        store.networkEnabled = false
        await store.networkLifecycle?.value
        check("with the daemon silent the run is retired all the same, and the daemon stopped",
              booked("task-deaf") == nil
                && feedDetails(NetworkAudit.failed).last
                    == "Auto · Review-req · #90271 - withdrawn: the Diplomacy Network was switched off"
                && installer.all.last == "--stop-daemon"
                && installer.all.filter { $0 == "--stop-daemon" }.count == 2)

        print(pass ? "NETWORK TEST OK" : "NETWORK TEST FAILED")
        return pass
    }
}
