import Foundation
import DiplomatCore

/// `DIPLOMAT_PIPELINE_TEST=1`: the app's half of a pipeline sync (the core's is pinned in
/// `DiplomatCoreSmoke`): what each effect queues and under which key and config, the
/// attempt records that keep the next sync from queueing it again, the switch that holds
/// the queued work, and the settings and forces a sync is run with. Composed results go
/// straight to `applyPipeline`, and `Store.pipelineTickOverride` stands in for the core's
/// tick, so no `gh`, `claude` or Linear.
///
/// Starts no agent: the queue is drained only by the poll a headless Store never starts.
/// The feed, the ban list, the run book and the shared config point at scratch.
enum PipelineTest {
    @discardableResult
    @MainActor
    static func run() async -> Bool {
        var pass = true
        func check(_ name: String, _ ok: Bool) {
            print("\(ok ? "PASS" : "FAIL") — \(name)")
            if !ok { pass = false }
        }

        let scratch = FileManager.default.temporaryDirectory
            .appendingPathComponent("diplomat-pipelinetest-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: scratch) }
        setenv("DIPLOMAT_AUDIT_DIR", scratch.appendingPathComponent("audit").path, 1)
        setenv("DIPLOMAT_AGENTS_DIR", scratch.appendingPathComponent("agents").path, 1)
        setenv("DIPLOMAT_CONFIG", scratch.appendingPathComponent("config.json").path, 1)
        setenv("DIPLOMAT_PIPELINE_DIR", scratch.appendingPathComponent("pipeline").path, 1)
        setenv("DA_BAN_DIR", scratch.appendingPathComponent("bans").path, 1)
        setenv("DA_BASE_DIR", scratch.appendingPathComponent("allocator").path, 1)
        setenv("DIPLOMAT_QUOTA_PROBE", "0", 1)
        setenv(DiskFloor.envOverride, "0", 1)
        AgentProbes.pinDump(.present(""))
        defer { AgentProbes.pinDump(nil) }

        let store = Store()
        // A headless Store still READS the operator's settings and their stored asks: pin
        // every one an assertion below depends on. Records live in `headlessJSON`.
        store.headlessJSON = [:]
        store.requestedWork = []
        store.queuedTasks = []
        store.usernameOverride = "latekvo"
        store.queueAutoRun = true
        store.pinRoots([PRRef.LocalRepo(owner: "o", repo: "r", path: scratch.path),
                        PRRef.LocalRepo(owner: "g", repo: "third", path: scratch.path, host: "gitlab.com")])
        store.pipelineEnabled = true
        store.pipelineRate = true
        store.pipelineFix = true
        store.pipelineFastTrack = false
        store.pipelineMerge = true
        store.pipelineFracture = false
        store.pipelineLinearTeamsRaw = "ENG=o/r"
        store.pipelineForce = PipelineSettings.Force()

        print("pipeline: the settings a sync is run with")
        let settings = store.pipelineSettings
        check("GitHub roots only, with the operator's login",
              settings.roots == [PipelineSettings.Root(owner: "o", repo: "r", path: scratch.path, me: "latekvo")])
        check("each switch as it stands",
              settings.rate && settings.fix && !settings.fastTrack && settings.merge && !settings.fracture)
        check("the Linear teams", settings.linearTeams == [PipelineSettings.LinearTeam(key: "ENG", repo: "o/r")])
        check("no forces while none is asked for", settings.force == nil)
        check("Linear teams: commas or new lines, entries missing a part skipped",
              Store.pipelineTeams("ENG=o/r, OPS = o/other\nBAD, =o/x, X=nope, Y=o/, Z=/r")
                  == [PipelineSettings.LinearTeam(key: "ENG", repo: "o/r"),
                      PipelineSettings.LinearTeam(key: "OPS", repo: "o/other")])

        let issue = "https://github.com/o/r/issues/90010"
        let pr = "https://github.com/o/r/pull/90011"
        let linear = "https://linear.app/swm/issue/ENG-90010/the-same-digits"
        let fix = PipelineEffect.fixIssue(repo: "o/r", number: 90010, url: issue)
        let fixLinear = PipelineEffect.fixLinear(repo: "o/r", identifier: "ENG-90010", url: linear,
                                                 text: "Title\n\nBody")
        let review = PipelineEffect.review(repo: "o/r", number: 90011, url: pr, headSha: "aaa111")
        func item(_ id: String, _ kind: PipelineKind, source: PipelineSource = .github,
                  author: String) -> PipelineItem {
            PipelineItem(id: id, source: source, kind: kind, label: "", title: "", repo: "o/r",
                         state: "open", author: author, writable: true, stage: .candidate, lane: .fast)
        }
        let items = [item(issue, .issue, author: "bob"), item(pr, .pr, author: "latekvo"),
                     item(linear, .issue, source: .linear, author: "Bob")]
        func result(_ effects: [PipelineEffect], notices: [String] = []) -> PipelineTickResult {
            PipelineTickResult(at: Date(), items: items, effects: effects, notices: notices)
        }
        let all = result([fix, fixLinear, review,
                          // A root that is not loaded here, and a GitLab one: nowhere to run.
                          .fixIssue(repo: "x/gone", number: 90012, url: "https://github.com/x/gone/issues/90012"),
                          .fixIssue(repo: "g/third", number: 90013, url: "https://gitlab.com/g/third/-/issues/90013")])
        func ids() -> [String] { store.queuedTasks.map(\.id) }
        func ask(_ key: String) -> Store.RequestedWork? { store.requestedWork.first { $0.key == key } }
        func job(_ key: String) -> Store.AgentJob? { store.queuedTasks.first { $0.id == key }?.job }
        func clearQueue() {
            store.requestedWork = []
            store.queuedTasks = []
        }

        print("\npipeline: each effect queues one ask")
        let t0 = Date()
        await store.applyPipeline(all, now: t0)
        let fixKey = "issues:o/r#90010", linearKey = "issues:linear:ENG-90010", reviewKey = "review:o/r#90011"
        check("exactly one queued task per effect with a root, nothing else",
              ids().sorted() == [fixKey, linearKey, reviewKey].sorted() && store.requestedWork.count == 3)
        if case .issues(let cfg)? = ask(fixKey)?.config {
            check("a GitHub fix: that issue, the pipeline's block, no Linear scope",
                  cfg.target == .specific && cfg.specificIssue == "90010" && cfg.pipeline == true
                      && cfg.linear == nil && cfg.home?.key == "o/r")
        } else {
            check("a GitHub fix is a Fix-issues ask", false)
        }
        check("…for its author's ban, linked to the issue, no PR number, held by the pipeline's switch",
              job(fixKey).map { $0.authorLogin == "bob" && $0.prURL == issue && $0.prNumber == nil
                  && $0.counter == .pipeline } == true)
        if case .issues(let cfg)? = ask(linearKey)?.config {
            check("a Linear fix: its text as Diplomat read it, the pipeline's block",
                  cfg.linear == LinearIssue(identifier: "ENG-90010", url: linear, text: "Title\n\nBody")
                      && cfg.pipeline == true && cfg.target == .specific && cfg.home?.key == "o/r")
        } else {
            check("a Linear fix is a Fix-issues ask", false)
        }
        check("…keyed in a space of its own, never an item key of o/r",
              linearKey != fixKey && AgentTaskQueue.item(ofKey: linearKey) == nil)
        check("…labelled by its identifier, linked to Linear, held by the pipeline's switch",
              job(linearKey).map { $0.label == "Issues · ENG-90010 · deep" && $0.prURL == linear
                  && $0.prNumber == nil && $0.counter == .pipeline } == true)
        if case .review(let cfg)? = ask(reviewKey)?.config {
            check("a fast-track review: my PR, that PR, the fast-track block, the deepest read",
                  cfg.target == .specific && cfg.specificPR == "90011" && cfg.specificAuthor == .mine
                      && cfg.fastTrack == true && cfg.depth == Store.pipelineReviewDepth)
        } else {
            check("a fast-track review is a Review ask", false)
        }
        check("…on its PR, held by the pipeline's switch",
              job(reviewKey).map { $0.prNumber == 90011 && $0.prURL == pr && $0.counter == .pipeline } == true)
        let records = store.loadPipelineAttempts()
        check("an attempt recorded per queued effect, at its stamp",
              records.keys.sorted() == [fix.key, fixLinear.key, review.key].sorted()
                  && records[review.key]?.requestedAt == "aaa111" && records[fix.key]?.requestedAt == "fix"
                  && records.values.allSatisfy { $0.attempts == 1 && $0.lastDispatchedAt == t0 })

        print("\npipeline: the next sync at the same stamp")
        await store.applyPipeline(all, now: t0.addingTimeInterval(30))
        check("still queued: nothing queued twice", ids().sorted() == [fixKey, linearKey, reviewKey].sorted()
              && store.requestedWork.count == 3)
        // As the drain leaves it: the asks dispatched, their agents gone without a word.
        clearQueue()
        await store.applyPipeline(all, now: t0.addingTimeInterval(60))
        check("dispatched a minute ago: none queued again", ids().isEmpty)
        check("…and the records stand", store.loadPipelineAttempts() == records)
        await store.applyPipeline(result([review]), now: t0.addingTimeInterval(120))
        check("…nor a review of the same head", ids().isEmpty)
        let pushed = PipelineEffect.review(repo: "o/r", number: 90011, url: pr, headSha: "bbb222")
        await store.applyPipeline(result([pushed]), now: t0.addingTimeInterval(600))
        check("a new head inside the re-request cooldown waits", ids().isEmpty)
        await store.applyPipeline(result([pushed]), now: t0.addingTimeInterval(2 * 3600))
        check("…and is reviewed past it, a first attempt at that head",
              ids() == [reviewKey] && store.loadPipelineAttempts()[review.key]
                  .map { $0.requestedAt == "bbb222" && $0.attempts == 1 } == true)
        clearQueue()
        await store.applyPipeline(result([fix]), now: t0.addingTimeInterval(2 * 3600))
        check("a fix whose run died is retried once its backoff is over, as attempt 2",
              ids() == [fixKey] && store.loadPipelineAttempts()[fix.key]?.attempts == 2)
        clearQueue()

        print("\npipeline: a run that answered")
        let t1 = t0.addingTimeInterval(2 * 3600)
        let fixRun = AgentState.RunRecord(runID: "r-fix", dispatchedAt: t1.timeIntervalSince1970 + 60,
                                          prURL: issue, kind: AgentTaskQueue.issuesAction)
        let otherRun = AgentState.RunRecord(runID: "r-other", dispatchedAt: t1.timeIntervalSince1970 + 60,
                                            prURL: "https://github.com/o/r/issues/90099",
                                            kind: AgentTaskQueue.issuesAction)
        let linearRun = AgentState.RunRecord(runID: "r-linear", dispatchedAt: t1.timeIntervalSince1970 + 60,
                                             prURL: linear, kind: AgentTaskQueue.issuesAction)
        let concluded = Store.pipelineConcluded(store.loadPipelineAttempts(),
                                                runs: [fixRun, otherRun], at: t1)
        check("a fix run concludes its issue's record, and no other",
              concluded[fix.key]?.concludedAt == t1 && concluded[review.key]?.concludedAt == nil
                  && concluded[fixLinear.key]?.concludedAt == nil)
        check("…a Linear fix run its Linear issue's",
              Store.pipelineConcluded(records, runs: [linearRun], at: t1)
                  .filter { $0.value.concludedAt != nil }.keys.sorted() == [fixLinear.key])
        let reviewRun = AgentState.RunRecord(runID: "r-rev", dispatchedAt: t1.timeIntervalSince1970 + 60,
                                             prNumber: 90011, prURL: pr, kind: AgentTaskQueue.reviewAction)
        check("a review run concludes its PR's review record, not a fix's",
              Store.pipelineConcluded(records.filter { [review.key, fix.key].contains($0.key) },
                                      runs: [reviewRun], at: t1)
                  .mapValues { $0.concludedAt != nil } == [review.key: true, fix.key: false])
        func spawned(_ kind: String, _ url: String) -> Store.AgentJob {
            Store.AgentJob(kind: kind, auditAction: kind, label: "", prompt: "", prURL: url,
                           prNumber: nil, authorLogin: nil, counter: .pipeline)
        }
        let started = t1.addingTimeInterval(1800)
        let restamped = Store.pipelineSpawned(records, job: spawned(AgentTaskQueue.issuesAction, issue),
                                              at: started)
        check("a spawn dates its own record, so the backoff runs from the run",
              restamped[fix.key]?.lastDispatchedAt == started && restamped[fix.key]?.attempts == 1
                  && restamped[fixLinear.key] == records[fixLinear.key]
                  && restamped[review.key] == records[review.key])
        check("…a review's spawn its review's, none once concluded",
              Store.pipelineSpawned(records, job: spawned(AgentTaskQueue.reviewAction, pr), at: started)
                  .filter { $0.value.lastDispatchedAt == started }.keys.sorted() == [review.key]
                  && Store.pipelineSpawned(concluded, job: spawned(AgentTaskQueue.issuesAction, issue),
                                           at: started)[fix.key] == concluded[fix.key])
        store.savePipelineAttempts(concluded)
        await store.applyPipeline(result([fix]), now: t1.addingTimeInterval(5 * 3600))
        check("a concluded fix is not asked for again, hours later", ids().isEmpty)
        check("…and its record outlives the backoff ceiling while it is owed",
              store.loadPipelineAttempts()[fix.key]?.concludedAt == t1)

        print("\npipeline: records a sync keeps")
        let old = ReviewAttempt(requestedAt: "fix", lastDispatchedAt: t0, attempts: 1)
        let gone = "pipeline-fix:https://github.com/o/r/issues/90077"
        let later = t0.addingTimeInterval(4 * 3600)
        check("past the ceiling, a record no sync owes is dropped",
              Store.retainedPipelineAttempts([gone: old], after: result([]), now: later).isEmpty)
        check("…unless the sync had a notice and did not list its item",
              Store.retainedPipelineAttempts([gone: old], after: result([], notices: ["Linear: no key"]),
                                             now: later)[gone] == old)
        check("…a listed item's record goes even then",
              Store.retainedPipelineAttempts([fix.key: old], after: result([], notices: ["x"]), now: later).isEmpty)

        print("\npipeline: what is already running")
        store.savePipelineAttempts([:])
        let now = t0.addingTimeInterval(10 * 3600)
        func agent(_ url: String) -> Store.AgentRow {
            Store.AgentRow(record: AgentState.RunRecord(runID: "r-\(url.hashValue)",
                                                        dispatchedAt: now.timeIntervalSince1970 - 60,
                                                        prURL: url, kind: AgentTaskQueue.issuesAction),
                           state: .running, reason: "", window: nil)
        }
        store.pinAgentRows([agent(issue)])
        await store.applyPipeline(result([fix, fixLinear]), now: now)
        check("an agent fixing the GitHub issue holds its fix, not the Linear issue of the same digits",
              ids() == [linearKey])
        check("…which records no attempt for the held one",
              store.loadPipelineAttempts().keys.sorted() == [fixLinear.key])
        check("the screen's badges: an agent on the issue, the Linear fix queued",
              store.pipelineBadges == ["o/r#90010": .agent, "linear:ENG-90010": .queued])
        clearQueue()
        store.savePipelineAttempts([:])
        store.pinAgentRows([agent(linear)])
        await store.applyPipeline(result([fix, fixLinear]), now: now)
        check("an agent on the Linear issue holds its fix, not the GitHub one's", ids() == [fixKey])
        store.pinAgentRows([])
        clearQueue()
        store.savePipelineAttempts([:])

        print("\npipeline: the master switch")
        let sweep = Store.RequestedWork(number: 90020, url: "https://github.com/o/r/pull/90020", author: "",
                                        config: .review(ReviewConfig(target: .specific, me: "latekvo",
                                                                     specificPR: "90020")), repo: "o/r")
        store.requestOne(sweep)
        await store.applyPipeline(result([fix, fixLinear, review]), now: now)
        let drainable = { Set(store.drainableTasks.map(\.id)) }
        check("on: the drain may start the pipeline's work",
              drainable() == [fixKey, linearKey, reviewKey, sweep.key])
        store.pipelineEnabled = false
        check("off: the pipeline's counter is paused", store.isPaused(.pipeline))
        check("…its queued work stays queued, and the drain starts none of it",
              ids().count == 4 && drainable() == [sweep.key])
        clearQueue()
        store.savePipelineAttempts([:])
        await store.applyPipeline(result([fix, fixLinear, review]), now: now)
        check("…a sync result landing then queues nothing and records nothing",
              ids().isEmpty && store.loadPipelineAttempts().isEmpty)
        check("…but is still drawn", store.pipelineResult?.effects.count == 3)
        var ticks: [PipelineSettings] = []
        Store.pipelineTickOverride = { settings in
            ticks.append(settings)
            return result([])
        }
        defer { Store.pipelineTickOverride = nil }
        await store.runPipelineSyncOnce()
        check("…and no sync runs", ticks.isEmpty)

        print("\npipeline: forces")
        store.forcePipeline(rate: pr)
        store.forcePipeline(rate: pr, fracture: issue)
        check("Rate now and Fracture are kept once each",
              store.pipelineForce == PipelineSettings.Force(rate: [pr], fracture: [issue]))
        store.pipelineEnabled = true
        Store.pipelineTickOverride = { settings in
            ticks.append(settings)
            // Forced while this sync runs: the next one takes it.
            store.pipelineForce.rate.append(linear)
            return result([])
        }
        await store.runPipelineSyncOnce()
        check("the sync is run with them", ticks.map(\.force) == [PipelineSettings.Force(rate: [pr], fracture: [issue])])
        check("…which it takes, leaving what was forced during it",
              store.pipelineForce == PipelineSettings.Force(rate: [linear], fracture: []))
        check("…and the master switch's settings", ticks.first.map { $0.rate && $0.fix && $0.roots.count == 1 } == true)

        print("\npipeline: Start fix")
        store.pipelineForce = PipelineSettings.Force()
        Store.pipelineTickOverride = nil
        clearQueue()
        store.savePipelineAttempts([fix.key: ReviewAttempt(requestedAt: "fix", lastDispatchedAt: now,
                                                           attempts: 1, concludedAt: now)])
        store.pipelineResult = result([fixLinear])
        check("a GitHub candidate is queued past its concluded record",
              store.startPipelineFix(items[0]) == nil && ids() == [fixKey]
                  && store.loadPipelineAttempts()[fix.key]?.attempts == 2)
        check("…once", store.startPipelineFix(items[0]) == "Its fix is already queued" && ids() == [fixKey])
        check("a Linear candidate, from the effect its text came with",
              store.startPipelineFix(items[2]) == nil && ids().sorted() == [fixKey, linearKey].sorted())
        store.pipelineResult = result([])
        clearQueue()
        check("…and not without it", store.startPipelineFix(items[2]) != nil && ids().isEmpty)
        var theirs = items[0]
        theirs.writable = false
        check("nor an issue assigned to someone else, which the fix would claim",
              store.startPipelineFix(theirs) != nil && ids().isEmpty)

        print("\npipeline: identity")
        check("a Linear link by its identifier, a GitHub one by its item key, anything else as it is",
              Store.pipelineIdentity(linear) == "linear:ENG-90010"
                  && Store.pipelineIdentity(issue) == "o/r#90010"
                  && Store.pipelineIdentity("https://example.com/x") == "https://example.com/x")

        print(pass ? "\nPIPELINE TEST: PASS" : "\nPIPELINE TEST: FAIL")
        return pass
    }
}
