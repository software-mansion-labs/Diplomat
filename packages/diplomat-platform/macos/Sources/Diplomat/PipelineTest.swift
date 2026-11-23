import Foundation
import DiplomatCore

/// `DIPLOMAT_PIPELINE_TEST=1`: the app's half of a pipeline sync (the core's is pinned in
/// `DiplomatCoreSmoke`): what each effect queues and under which key and config, the
/// attempt records that keep the next sync from queueing it again, the switch that holds
/// the queued work, and the settings and forces a sync is run with. Composed results go
/// straight to `applyPipeline`, and `Store.pipelineTickOverride` stands in for the core's
/// tick, so no `gh`, `claude` or Linear; only `DIPLOMAT_PIPELINE_E2E` adds real syncs,
/// against stubs (`live`).
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
        store.pipelineFastTrack = true
        store.pipelineMerge = true
        store.pipelineFracture = false
        store.pipelineLinearTeamsRaw = "ENG=o/r"
        store.pipelineForce = PipelineSettings.Force()

        print("pipeline: the settings a sync is run with")
        let settings = store.pipelineSettings
        check("GitHub roots only, with the operator's login",
              settings.roots == [PipelineSettings.Root(owner: "o", repo: "r", path: scratch.path, me: "latekvo")])
        check("each switch as it stands",
              settings.rate && settings.fix && settings.fastTrack && settings.merge && !settings.fracture)
        check("the Linear teams", settings.linearTeams == [PipelineSettings.LinearTeam(key: "ENG", repo: "o/r")])
        check("no forces while none is asked for", settings.force == nil)
        check("Linear teams: the core's parse, keys in capitals, entries missing a part skipped",
              Store.pipelineTeams("eng=o/r; OPS = o/other\nBAD, =o/x, X=nope, Y=o/, Z=/r, ENG=o/second")
                  == [PipelineSettings.LinearTeam(key: "ENG", repo: "o/r"),
                      PipelineSettings.LinearTeam(key: "OPS", repo: "o/other")])
        check("…and the Settings line names the entries it skipped",
              SettingsView.linearTeamsSummary(PipelineSettings.LinearTeam.parse("ENG=o/r, BAD"))
                  == "Not KEY=owner/repo, so not tracked: BAD"
                  && SettingsView.linearTeamsSummary(PipelineSettings.LinearTeam.parse(" ")) == "None: GitHub only"
                  && SettingsView.linearTeamsSummary(PipelineSettings.LinearTeam.parse("eng=o/r,ops=o/x"))
                      == "ENG → o/r · OPS → o/x")
        func feed(_ action: String) -> [String] {
            AuditLog.read().filter { $0.action == action }.map { "\($0.source) \($0.detail)" }.reversed()
        }

        let issue = "https://github.com/o/r/issues/90010"
        let pr = "https://github.com/o/r/pull/90011"
        let linear = "https://linear.app/swm/issue/ENG-90010/the-same-digits"
        let fix = PipelineEffect.fixIssue(repo: "o/r", number: 90010, url: issue)
        let fixLinear = PipelineEffect.fixLinear(repo: "o/r", identifier: "ENG-90010", url: linear,
                                                 text: "Title\n\nBody")
        let review = PipelineEffect.review(repo: "o/r", number: 90011, url: pr, headSha: "aaa111")
        // SHIM: each becomes its effect's own `author:` once DiplomatCore's PipelineEffect has it.
        PipelineEffectAuthorShim.byKey = [fix.key: "bob", fixLinear.key: "Bob", review.key: "latekvo"]
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
        func line(_ key: String) -> String { ask(key)?.label(roots: store.roots.count) ?? key }
        let fixLine = line(fixKey)
        check("the feed: a pipeline-fix line per fix, a pipeline-review line per review",
              feed("pipeline-fix") == ["auto \(fixLine) queued", "auto \(line(linearKey)) queued"]
                  && feed("pipeline-review") == ["auto \(line(reviewKey)) queued"]
                  && feed("pipeline-queue").isEmpty)
        print("  (\(fixLine), \(line(linearKey)), \(line(reviewKey)))")
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
        check("…said so in the feed", feed("pipeline-fix").last == "auto \(fixLine) queued (attempt 2)")
        clearQueue()

        print("\npipeline: each kind waits on its own switch")
        let saved = store.loadPipelineAttempts()
        store.savePipelineAttempts([:])
        store.pipelineFastTrack = false
        await store.applyPipeline(result([fix, review]), now: t0)
        check("fast track off: its review is not queued, nor recorded",
              ids() == [fixKey] && store.loadPipelineAttempts().keys.sorted() == [fix.key])
        clearQueue()
        store.savePipelineAttempts([:])
        store.pipelineFastTrack = true
        store.pipelineFix = false
        await store.applyPipeline(result([fix, fixLinear, review]), now: t0)
        check("fixes off: neither fix is queued", ids() == [reviewKey])
        store.pipelineFix = true
        clearQueue()
        store.savePipelineAttempts([:])
        PipelineEffectAuthorShim.byKey[fix.key] = "LateKvo"  // SHIM: `author: "LateKvo"`
        await store.applyPipeline(result([fix]), now: t0)
        check("the operator's own issue: no author to ban", ask(fixKey).map { $0.author.isEmpty } == true)
        PipelineEffectAuthorShim.byKey[fix.key] = "bob"
        clearQueue()
        store.savePipelineAttempts(saved)

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
        let later = t0.addingTimeInterval(3 * 3600)
        check("at the backoff ceiling, a record no sync owes is dropped, a notice or not",
              Store.retainedPipelineAttempts([gone: old], after: result([], notices: ["Linear: no key"]),
                                             now: later).isEmpty)
        check("…kept inside it, so a read that failed does not make it new",
              Store.retainedPipelineAttempts([gone: old], after: result([]),
                                             now: later.addingTimeInterval(-1))[gone] == old)
        check("…and kept while owed, however old",
              Store.retainedPipelineAttempts([fix.key: old], after: result([fix]),
                                             now: t0.addingTimeInterval(30 * 86400))[fix.key] == old)

        print("\npipeline: what the feed is told once")
        func event(_ secs: Double, _ id: String, _ kind: PipelineEvent.Kind, _ detail: String) -> PipelineEvent {
            PipelineEvent(at: t0.addingTimeInterval(secs), item: id, kind: kind, detail: detail)
        }
        var labelled = items
        labelled[1].label = "#90011"
        let merged = event(10, pr, .merged, "merged aaa111a with --admin --squash")
        let unlisted = "https://github.com/o/r/issues/90050"
        let split = event(10, unlisted, .fractured, "split into 2 parts")
        let first = PipelineTickResult(at: t0, items: labelled,
                                       events: [event(5, pr, .rated, "low/low"), merged, split],
                                       notices: ["Linear was not read"])
        let repeated = PipelineTickResult(at: t0, items: labelled,
                                          events: first.events + [event(10, pr, .held, "x")],
                                          notices: ["Linear was not read"])
        check("no previous result: every merge and split of its own sync is fresh",
              Store.pipelineFreshEvents(first, after: nil) == [merged, split])
        check("…and none the log holds from before it",
              Store.pipelineFreshEvents(PipelineTickResult(at: t0, events: [event(-60, pr, .merged, "old"), merged]),
                                        after: nil) == [merged])
        check("…else none the previous result showed, nor one older than its newest",
              Store.pipelineFreshEvents(repeated, after: first).isEmpty
                  && Store.pipelineFreshEvents(PipelineTickResult(at: t0, events: [event(4, pr, .merged, "old")]),
                                               after: first).isEmpty)
        let again = event(10, pr, .merged, "merged bbb222b with --admin --squash")
        check("…but one in the same second as its newest, not among its events",
              Store.pipelineFreshEvents(PipelineTickResult(at: t0, events: first.events + [again]), after: first)
                  == [again])
        store.pipelineResult = nil
        let before = (feed("pipeline-merge").count, feed("pipeline-fracture").count, feed("pipeline-notice").count)
        await store.applyPipeline(first, now: t0)
        await store.applyPipeline(repeated, now: t0)
        check("a merge, a split and a notice are each logged once over two syncs",
              feed("pipeline-merge").count == before.0 + 1 && feed("pipeline-fracture").count == before.1 + 1
                  && feed("pipeline-notice").count == before.2 + 1)
        check("…under the item's label, else its link",
              feed("pipeline-merge").last == "auto #90011: merged aaa111a with --admin --squash"
                  && feed("pipeline-fracture").last == "auto \(unlisted): split into 2 parts"
                  && feed("pipeline-notice").last == "auto Linear was not read")
        clearQueue()

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
        store.pipelineForce.rate.insert(linear, at: 0)
        check("…and handed on sorted, as the Linux store does",
              store.pipelineSettings.force == PipelineSettings.Force(rate: [pr, linear], fracture: [issue]))
        store.pipelineForce.rate.removeFirst()
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

        print("\npipeline: syncs held")
        ticks = []
        Store.pipelineTickOverride = { settings in
            ticks.append(settings)
            return result([])
        }
        let errors = feed("pipeline-error").count, recoveries = feed("pipeline-recovered").count
        let pinned = store.roots
        let guessedWhy = "no repo root in Settings resolves to a GitHub or GitLab checkout"
        store.pinRoots(pinned, guessed: true)
        await store.runPipelineSyncOnce()
        await store.runPipelineSyncOnce()
        check("no root resolved: no sync runs, and the forces wait",
              ticks.isEmpty && store.pipelineForce.rate == [linear])
        check("…held with its reason, logged once",
              store.pipelineError == guessedWhy && feed("pipeline-error").count == errors + 1
                  && feed("pipeline-error").last == "auto \(guessedWhy)")
        store.pinRoots(pinned)
        await store.runPipelineSyncOnce()
        check("…resolved again: it syncs, and says so once",
              ticks.count == 1 && store.pipelineError == nil
                  && feed("pipeline-recovered").count == recoveries + 1
                  && feed("pipeline-recovered").last == "auto Pipeline syncing again")

        print("\npipeline: Start fix")
        store.pipelineForce = PipelineSettings.Force()
        Store.pipelineTickOverride = nil
        clearQueue()
        store.savePipelineAttempts([fix.key: ReviewAttempt(requestedAt: "fix", lastDispatchedAt: now,
                                                           attempts: 1, concludedAt: now)])
        store.pipelineResult = result([fixLinear])
        store.pipelineEnabled = false
        check("off: nothing is queued", store.startPipelineFix(items[0]) == "The pipeline is off" && ids().isEmpty)
        store.pipelineEnabled = true
        let screenLines = feed("pipeline-fix").count
        check("a GitHub candidate is queued past its concluded record",
              store.startPipelineFix(items[0]) == nil && ids() == [fixKey]
                  && store.loadPipelineAttempts()[fix.key]?.attempts == 2)
        check("…logged as the screen's",
              feed("pipeline-fix").count == screenLines + 1
                  && feed("pipeline-fix").last == "panel \(fixLine) queued from the Pipeline screen")
        check("…once", store.startPipelineFix(items[0]) == "Its fix is already queued" && ids() == [fixKey])
        check("a Linear candidate, from the effect its text came with",
              store.startPipelineFix(items[2]) == nil && ids().sorted() == [fixKey, linearKey].sorted())
        store.pipelineResult = result([])
        clearQueue()
        check("…and not without it",
              store.startPipelineFix(items[2]) == "Diplomat has this Linear issue's text only while Open fix PRs is on"
                  && ids().isEmpty)
        // The card is drawn from an earlier result than the one each press is checked against.
        var theirs = items[0]
        theirs.writable = false
        store.pipelineResult = PipelineTickResult(at: Date(), items: [theirs] + items.dropFirst())
        check("nor an issue the last sync found assigned to someone else, which the fix would claim",
              store.startPipelineFix(items[0]) == "It is assigned to someone else" && ids().isEmpty)
        var fixed = items[0]
        fixed.stage = .fixing
        store.pipelineResult = PipelineTickResult(at: Date(), items: [fixed] + items.dropFirst())
        check("nor one it found a PR fixing",
              store.startPipelineFix(items[0]) == "The last sync found it no fix candidate" && ids().isEmpty)
        store.pipelineResult = result([])
        check("nor one it did not read",
              store.startPipelineFix(item("https://github.com/o/r/issues/90031", .issue, author: "bob"))
                  == "The last sync found it no fix candidate" && ids().isEmpty)
        var heldLinear = items[2]
        heldLinear.hold = "Linear team ENG has no root to fix it in"
        store.pipelineResult = PipelineTickResult(at: Date(), items: [items[0], items[1], heldLinear])
        check("a held Linear candidate: the hold says why", store.startPipelineFix(items[2]) == heldLinear.hold)
        var elsewhere = items[0]
        elsewhere.id = "https://github.com/x/gone/issues/90012"
        elsewhere.repo = "x/gone"
        store.pipelineResult = PipelineTickResult(at: Date(), items: items + [elsewhere])
        check("nor one in a repo that is no root here",
              store.startPipelineFix(elsewhere) == "x/gone is no GitHub repo root here, so there is nowhere to fix it")
        store.pinAgentRows([agent(issue)])
        check("nor one an agent is fixing", store.startPipelineFix(items[0]) == "An agent is already fixing it")
        store.pinAgentRows([])
        store.pipelineResult = result([])

        print("\npipeline: the screen's actions")
        func at(_ stage: PipelineStage, _ kind: PipelineKind = .issue, writable: Bool = true) -> PipelineItem {
            var i = item(issue, kind, author: "bob")
            i.stage = stage
            i.writable = writable
            return i
        }
        check("Fracture: a writable open issue not split yet, whose code can be read",
              [PipelineStage.unrated, .human, .candidate].allSatisfy {
                  PipelineView.canFracture(at($0), edges: [], rooted: true)
              }
                  && !PipelineView.canFracture(at(.fixing), edges: [], rooted: true)
                  && !PipelineView.canFracture(at(.human, writable: false), edges: [], rooted: true)
                  && !PipelineView.canFracture(at(.human, .pr), edges: [], rooted: true)
                  && !PipelineView.canFracture(at(.human),
                                               edges: [PipelineGraph.Edge(from: issue, to: "c", kind: .child)],
                                               rooted: true)
                  && !PipelineView.canFracture(at(.human), edges: [], rooted: false))
        check("Start fix: a writable candidate issue only",
              PipelineView.canStartFix(at(.candidate)) && !PipelineView.canStartFix(at(.human))
                  && !PipelineView.canStartFix(at(.candidate, writable: false))
                  && !PipelineView.canStartFix(at(.candidate, .pr)))

        print("\npipeline: identity")
        check("a Linear link by its identifier, a GitHub one by its item key, anything else as it is",
              Store.pipelineIdentity(linear) == "linear:ENG-90010"
                  && Store.pipelineIdentity(issue) == "o/r#90010"
                  && Store.pipelineIdentity("https://example.com/x") == "https://example.com/x")

        print("\npipeline: control.json")
        let control = PipelineLog.dir.appendingPathComponent("control.json")
        func switches() -> [String: Bool]? {
            (try? Data(contentsOf: control)).flatMap { try? JSONDecoder().decode([String: Bool].self, from: $0) }
        }
        store.pipelineMerge = false
        check("a switch writes every switch as it stands",
              switches() == ["enabled": true, "rate": true, "fix": true, "fastTrack": true, "merge": false,
                             "fracture": false])
        let mode = (try? FileManager.default.attributesOfItem(atPath: control.path))?[.posixPermissions] as? Int
        let beside = (try? FileManager.default.contentsOfDirectory(atPath: PipelineLog.dir.path)) ?? []
        check("…owner-only, replaced whole", mode == 0o600 && !beside.contains { $0.hasPrefix("control.json.") })
        try? FileManager.default.removeItem(at: control)
        var handed: [String: Bool]?
        Store.pipelineTickOverride = { _ in
            handed = switches()
            return result([])
        }
        await store.runPipelineSyncOnce()
        check("…and a sync writes it before it runs", handed?["merge"] == false && handed?["enabled"] == true)
        store.pipelineMerge = true

        print("\npipeline: a sync's own result, and another's")
        clearQueue()
        store.savePipelineAttempts([:])
        store.pipelineForce = PipelineSettings.Force(rate: [pr])
        if let asked = store.pipelineAsk(review) { store.requestOne(asked) }
        let reviewLine = line(reviewKey)
        // Another sync held the lock: the core answers the last result, dated before this one began.
        Store.pipelineTickOverride = { _ in PipelineTickResult(at: Date().addingTimeInterval(-60), items: items) }
        await store.runPipelineSyncOnce()
        check("a stale result retires no force and withdraws no ask",
              store.pipelineForce.rate == [pr] && ids() == [reviewKey])
        Store.pipelineTickOverride = { _ in result([]) }
        await store.runPipelineSyncOnce()
        check("…its own retires the forces it was handed and the asks it no longer owes",
              store.pipelineForce.rate.isEmpty && ids().isEmpty && store.requestedWork.isEmpty)
        check("…which the feed says",
              feed("queue-drop").last == "panel \(reviewLine) - the pipeline no longer owes it, not run")
        check("a result dated in the second its sync began is that sync's",
              Store.pipelineRan(PipelineTickResult(at: Date(timeIntervalSince1970: 100)),
                                started: Date(timeIntervalSince1970: 100.7))
                  && !Store.pipelineRan(PipelineTickResult(at: Date(timeIntervalSince1970: 99)),
                                        started: Date(timeIntervalSince1970: 100.2)))

        print("\npipeline: asks a sync no longer owes")
        let asks = [fix, fixLinear, review].compactMap { store.pipelineAsk($0) } + [sweep]
        func withdrawn(_ seen: [PipelineItem], _ effects: [PipelineEffect]) -> [String] {
            Store.pipelineWithdrawn(asks, by: PipelineTickResult(at: Date(), items: seen, effects: effects)).sorted()
        }
        var assigned = items
        assigned[0].writable = false
        var fixing = items
        fixing[0].stage = .fixing
        var heldItems = items
        heldItems[2].hold = "Linear team ENG has no root to fix it in"
        check("a fix of an issue now assigned to someone else, or with a PR fixing it, goes",
              asks.count == 4 && withdrawn(assigned, [fixLinear, review]) == [fixKey]
                  && withdrawn(fixing, [fixLinear, review]) == [fixKey])
        check("…a review owed no more goes", withdrawn(items, [fix, fixLinear]) == [reviewKey])
        check("…a candidate's fix the sync did not emit stays (its switch off, a hold)",
              withdrawn(heldItems, []) == [reviewKey])
        check("…as does anything about an item it did not read, and an ask not the pipeline's",
              withdrawn([], []).isEmpty)

        print("\npipeline: concluded records")
        let closedOut = ReviewAttempt(requestedAt: "fix", lastDispatchedAt: t0, attempts: 1, concludedAt: t0)
        check("a concluded record no sync owes is kept for 30 days after its run concluded",
              Store.retainedPipelineAttempts([gone: closedOut], after: result([]),
                                             now: t0.addingTimeInterval(29 * 86400))[gone] == closedOut)
        check("…and dropped past them",
              Store.retainedPipelineAttempts([gone: closedOut], after: result([]),
                                             now: t0.addingTimeInterval(30 * 86400 + 1)).isEmpty)

        print("\npipeline: whose work it is")
        let banDir = scratch.appendingPathComponent("bans")
        try? FileManager.default.createDirectory(at: banDir, withIntermediateDirectories: true)
        try? Data(#"{"banned":[{"login":"mallory","reason":"prompt injection"}]}"#.utf8)
            .write(to: banDir.appendingPathComponent("banned.json"))
        clearQueue()
        store.savePipelineAttempts([:])
        // A split's part: filed by the operator, its fix by the author of the issue it was split from.
        let part = "https://github.com/o/r/issues/90030"
        let partFix = PipelineEffect.fixIssue(repo: "o/r", number: 90030, url: part)
        PipelineEffectAuthorShim.byKey[partFix.key] = "mallory"  // SHIM: `author: "mallory"`
        var partItem = item(part, .issue, author: "latekvo")
        partItem.label = "#90030"
        let parted = PipelineTickResult(at: Date(), items: items + [partItem], effects: [partFix])
        await store.applyPipeline(parted, now: now)
        check("a part split from a banned author's issue is not asked for, though the operator filed it",
              ids().isEmpty && store.loadPipelineAttempts().isEmpty)
        store.pipelineResult = parted
        check("…and Start fix asks for it as that author's",
              store.startPipelineFix(partItem) == nil
                  && job("issues:o/r#90030").map { $0.authorLogin == "mallory" } == true)
        try? FileManager.default.removeItem(at: banDir.appendingPathComponent("banned.json"))
        clearQueue()
        store.savePipelineAttempts([:])

        print("\npipeline: guards")
        ticks = []
        Store.pipelineTickOverride = { settings in
            ticks.append(settings)
            if ticks.count == 1 { store.pipelineSyncAgain = true }
            return result([])
        }
        await store.runPipelineSyncOnce()
        check("a sync asked for during one follows it", ticks.count == 2)
        ticks = []
        Store.pipelineTickOverride = { settings in
            ticks.append(settings)
            store.pipelineSyncAgain = true
            store.pipelineEnabled = false
            return result([])
        }
        await store.runPipelineSyncOnce()
        check("…unless the master switch went off meanwhile", ticks.count == 1)
        store.pipelineEnabled = true
        func finished(_ url: String, _ state: AgentState.RunState, released: Bool = false) -> Store.AgentRow {
            Store.AgentRow(record: AgentState.RunRecord(runID: "r-\(state)-\(released)",
                                                        dispatchedAt: now.timeIntervalSince1970 - 60, prURL: url,
                                                        kind: AgentTaskQueue.issuesAction, released: released),
                           state: state, reason: "", window: nil)
        }
        store.pinAgentRows([finished(issue, .finished), finished(issue, .running, released: true)])
        await store.applyPipeline(result([fix]), now: now)
        check("a run on the issue that ended, or gave its bay back, holds no fix", ids() == [fixKey])
        store.pinAgentRows([])
        clearQueue()
        store.savePipelineAttempts([:])
        check("the screen's badges: an agent on an item outranks its queued work",
              Store.pipelineBadges(rows: [agent(issue)], waiting: [], asks: store.pipelineAsk(fix).map { [$0] } ?? [])
                  == ["o/r#90010": .agent])
        let periodEnv = ProcessInfo.processInfo.environment["DIPLOMAT_PIPELINE_SECS"]
        setenv("DIPLOMAT_PIPELINE_SECS", "5", 1)
        let floorSecs = Double((try? CoreAssets.pipeline())?.minSyncSecs ?? 60)
        check("the sync period is never under its floor", floorSecs > 5 && Store.pipelineSyncInterval == floorSecs)
        if let periodEnv { setenv("DIPLOMAT_PIPELINE_SECS", periodEnv, 1) } else { unsetenv("DIPLOMAT_PIPELINE_SECS") }
        let ghEnv = ProcessInfo.processInfo.environment["DIPLOMAT_GH"]
        setenv("DIPLOMAT_GH", "/usr/bin/false", 1)
        store.usernameOverride = ""
        store.me = ""
        ticks = []
        Store.pipelineTickOverride = { settings in
            ticks.append(settings)
            return result([])
        }
        await store.runPipelineSyncOnce()
        check("with a GitHub root and no login known, no sync runs", ticks.isEmpty
              && store.pipelineError == Store.githubLoginUnknown)
        if let ghEnv { setenv("DIPLOMAT_GH", ghEnv, 1) } else { unsetenv("DIPLOMAT_GH") }
        store.usernameOverride = "latekvo"
        await store.runPipelineSyncOnce()
        check("…and syncs once it is", ticks.count == 1 && store.pipelineError == nil)
        Store.pipelineTickOverride = nil

        print("\npipeline: what the screen shows")
        let fastIssue = item(issue, .issue, author: "bob")
        var donePR = item(pr, .pr, author: "latekvo")
        donePR.lane = .done
        donePR.stage = .merged
        let lone = item("https://github.com/o/r/issues/90040", .issue, author: "bob")
        let laneResult = PipelineTickResult(
            at: Date(), items: [fastIssue, donePR, lone],
            graph: PipelineGraph(nodes: [.init(id: issue, column: 0, row: 0), .init(id: pr, column: 1, row: 0),
                                         .init(id: lone.id, column: 0, row: 1)],
                                 edges: [.init(from: issue, to: pr, kind: .fixes)]))
        check("a lane keeps each group with any member in it, whole",
              Set(PipelineLayout.make(laneResult, lane: .done).cards.map(\.item.id)) == [issue, pr])
        var eng = items[2]
        eng.repo = "ENG"
        var ops = items[2]
        ops.repo = "OPS"
        check("a Linear issue's code can be read when its team names a GitHub root; a GitHub item's always",
              store.pipelineRooted(eng) && !store.pipelineRooted(ops) && store.pipelineRooted(items[0]))
        var theirPR = item(pr, .pr, author: "carol")
        theirPR.writable = false
        var closedIssue = item(issue, .issue, author: "bob")
        closedIssue.state = "closed"
        closedIssue.writable = false
        let myPR = item(pr, .pr, author: "LateKvo")
        check("Rate now: an open issue whose code can be read, my own open PR",
              PipelineView.canRate(items[0], me: "latekvo", rooted: true)
                  && PipelineView.canRate(myPR, me: "latekvo", rooted: true)
                  && !PipelineView.canRate(theirPR, me: "latekvo", rooted: true)
                  && !PipelineView.canRate(myPR, me: "", rooted: true)
                  && !PipelineView.canRate(ops, me: "latekvo", rooted: false)
                  && !PipelineView.canRate(closedIssue, me: "latekvo", rooted: true))
        check("why Start fix cannot: assigned, else the hold, else the switch",
              store.pipelineFixUnknown(heldItems[2]) == "Linear team ENG has no root to fix it in"
                  && store.pipelineFixUnknown(assigned[0]) == "It is assigned to someone else"
                  && store.pipelineFixUnknown(items[2])
                      == "Diplomat has this Linear issue's text only while Open fix PRs is on")
        var mergedPR = myPR
        mergedPR.writable = false
        mergedPR.state = "merged"
        check("read only: said of every item Diplomat may not write, whatever kept it so",
              [mergedPR, theirPR, closedIssue].allSatisfy {
                  PipelineTint.access($0) == "Read only: Diplomat shows it and writes nothing to it."
              })
        var heldBy = theirPR
        heldBy.assignees = ["dave", "erin"]
        check("…and who it is by and assigned to",
              PipelineTint.people(heldBy) == "By @carol · assigned to @dave, @erin"
                  && PipelineTint.people(items[2]) == "By Bob · unassigned")
        check("a sync that read nothing says so",
              PipelineView.emptyText(enabled: true, synced: true) == "The last sync found no open issue or PR."
                  && PipelineView.emptyText(enabled: true, synced: false).hasPrefix("Nothing read yet")
                  && PipelineView.emptyText(enabled: false, synced: true).hasPrefix("The pipeline is off"))
        let cal = Calendar.current
        let synced = cal.date(from: DateComponents(year: 2026, month: 11, day: 20, hour: 12, minute: 5))!
        check("the last sync: its time today, its date too on any other day",
              PipelineTint.syncTime(synced, now: synced.addingTimeInterval(3600)) == Fmt.clock(synced)
                  && PipelineTint.syncTime(synced, now: synced.addingTimeInterval(3 * 86400)) == "Nov 20 12:05")

        if let harness = ProcessInfo.processInfo.environment["DIPLOMAT_PIPELINE_E2E"], !harness.isEmpty {
            await live(store, harness: URL(fileURLWithPath: harness), check: check)
        }

        print(pass ? "\nPIPELINE TEST: PASS" : "\nPIPELINE TEST: FAIL")
        return pass
    }

    /// `DIPLOMAT_PIPELINE_E2E=<dir>`: real syncs (`PipelineTick.run`) of `acme/app`, checked
    /// out at `<dir>/checkout`, through the stubs DIPLOMAT_GH, DIPLOMAT_CLAUDE and
    /// DIPLOMAT_LINEAR_API name, which log to `<dir>/gh.log`, `claude.log` and `linear.log`.
    /// None of these is in the repo: whoever runs it supplies an operator `op`, issues #1
    /// and #5, PR #2 fixing #1, PR #3 labelled cleared by hand at a clean head, someone
    /// else's PR #4, and Linear's ENG-1, every rating low/low.
    @MainActor
    private static func live(_ store: Store, harness: URL, check: (String, Bool) -> Void) async {
        print("\npipeline: real syncs against the stubs in \(harness.path)")
        func log(_ name: String) -> [Any] {
            let text = (try? String(contentsOf: harness.appendingPathComponent(name), encoding: .utf8)) ?? ""
            return text.split(separator: "\n").compactMap { try? JSONSerialization.jsonObject(with: Data($0.utf8)) }
        }
        func ghWrites() -> [String] {
            log("gh.log").compactMap { $0 as? [String] }
                .filter { !$0.starts(with: ["api", "graphql"]) && !$0.starts(with: ["pr", "diff"]) }
                .map { $0.joined(separator: " ") }
        }
        func linearWrites() -> [String] {
            log("linear.log").compactMap { ($0 as? [String: Any])?["op"] as? String }
                .filter { $0 != "Issues" && $0 != "Labels" }
        }
        func truncate() {
            for name in ["gh.log", "linear.log", "claude.log"] {
                try? Data().write(to: harness.appendingPathComponent(name))
            }
        }
        func feed() -> [String] {
            AuditLog.read().filter { $0.action.hasPrefix("pipeline-") }
                .map { "\($0.source) \($0.action) \($0.detail)" }.reversed()
        }
        func ids() -> [String] { store.queuedTasks.map(\.id).sorted() }
        func prompt(_ key: String) -> String { store.queuedTasks.first { $0.id == key }?.job.prompt ?? "" }

        Store.pipelineTickOverride = nil
        Store.pipelineTickLive = true
        defer { Store.pipelineTickLive = false }
        store.usernameOverride = "op"
        store.pinRoots([PRRef.LocalRepo(owner: "acme", repo: "app",
                                        path: harness.appendingPathComponent("checkout").path)])
        store.pipelineEnabled = true
        store.pipelineRate = true
        store.pipelineFix = true
        store.pipelineFastTrack = true
        store.pipelineMerge = true
        store.pipelineFracture = false
        store.pipelineLinearTeamsRaw = "ENG=acme/app"
        store.pipelineForce = PipelineSettings.Force()
        store.pipelineResult = nil
        store.requestedWork = []
        store.queuedTasks = []
        store.savePipelineAttempts([:])
        store.pinAgentRows([])
        let feedBefore = feed().count

        truncate()
        await store.runPipelineSyncOnce()
        let writes = ghWrites()
        print("  sync 1 gh writes:\n" + writes.map { "    gh \($0)" }.joined(separator: "\n"))
        print("  sync 1 Linear writes: \(linearWrites())")
        check("sync 1: gh labels #2 and #5 low/low, fast-tracks #2, and merges #3 at its head, nothing else",
              writes == [
                  "api -X POST repos/acme/app/issues/2/labels -f labels[]=risk:low",
                  "api -X POST repos/acme/app/issues/2/labels -f labels[]=complexity:low",
                  "api -X POST repos/acme/app/issues/5/labels -f labels[]=risk:low",
                  "api -X POST repos/acme/app/issues/5/labels -f labels[]=complexity:low",
                  "api -X POST repos/acme/app/issues/2/labels -f labels[]=diplomat:fast-track",
                  "pr merge 3 -R acme/app --admin --squash --match-head-commit " + String(repeating: "e5", count: 20),
              ])
        check("…the hand-cleared #3 re-rated first, by claude", log("claude.log").count == 4
              && ((log("claude.log").first as? [String: Any])?["stdin"] as? [String])?.last == "| Guard nil avatar")
        check("…and Linear labels ENG-1 low/low", linearWrites() == ["AddLabel", "AddLabel"])
        let reviewKey = "review:acme/app#2", fixKey = "issues:acme/app#5", linearKey = "issues:linear:ENG-1"
        check("its three effects are queued asks", ids() == [fixKey, linearKey, reviewKey].sorted())
        for (key, marker) in [(reviewKey, "FAST TRACK"), (linearKey, "Take Linear issue"), (linearKey, "FAST TRACK"),
                              (fixKey, "FAST TRACK")] {
            let hit = prompt(key).split(separator: "\n").first { $0.contains(marker) } ?? "(none)"
            print("  \(key) prompt: \(hit.prefix(150))…")
        }
        check("…the review's prompt carries the fast-track block",
              prompt(reviewKey).contains("THIS PR IS ON THE FAST TRACK"))
        check("…the Linear fix's the Linear scope and the pipeline's fix block",
              prompt(linearKey).contains("Take Linear issue ENG-1 (https://linear.app/acme/issue/ENG-1), fix it in acme/app")
                  && prompt(linearKey).contains("Header is blue, should be purple.")
                  && prompt(linearKey).contains("THIS ISSUE IS ON DIPLOMAT'S FAST TRACK"))
        check("…the GitHub fix's the pipeline's fix block, no Linear scope",
              prompt(fixKey).contains("THIS ISSUE IS ON DIPLOMAT'S FAST TRACK") && !prompt(fixKey).contains("Linear issue"))
        let lines = Array(feed().dropFirst(feedBefore))
        print("  sync 1 feed:\n" + lines.map { "    \($0)" }.joined(separator: "\n"))
        check("…and the feed has each ask and the merge once",
              lines.filter { $0.hasPrefix("auto pipeline-fix ") }.count == 2
                  && lines.filter { $0.hasPrefix("auto pipeline-review ") }.count == 1
                  && lines.filter { $0.hasPrefix("auto pipeline-merge ") }
                      == ["auto pipeline-merge #3: merged e5e5e5e with --admin --squash"]
                  && lines.count == 4)

        // Events are stamped to the second; a sync in a later one tells them apart.
        try? await Task.sleep(nanoseconds: 1_100_000_000)
        truncate()
        let queued = ids(), attempts = store.loadPipelineAttempts()
        await store.runPipelineSyncOnce()
        check("sync 2, nothing changed: gh, Linear and claude are only read",
              ghWrites().isEmpty && linearWrites().isEmpty && log("claude.log").isEmpty
                  && !log("gh.log").isEmpty)
        check("…nothing more is queued or attempted, and the feed is told nothing",
              ids() == queued && store.loadPipelineAttempts() == attempts && feed().count == feedBefore + 4)

        store.pipelineEnabled = false
        check("master off: none of the queued asks may start",
              store.queuedTasks.count == 3 && store.drainableTasks.isEmpty)
        store.requestedWork = []
        store.queuedTasks = []
        store.savePipelineAttempts([:])
        truncate()
        await store.runPipelineSyncOnce()
        if let last = store.pipelineResult { await store.applyPipeline(last) }
        check("…and nothing syncs or is queued", log("gh.log").isEmpty && ids().isEmpty
              && store.loadPipelineAttempts().isEmpty && feed().count == feedBefore + 4)
    }
}
