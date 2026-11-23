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
        var mine = items
        mine[0].author = "LateKvo"
        await store.applyPipeline(PipelineTickResult(at: Date(), items: mine, effects: [fix]), now: t0)
        check("the operator's own issue: no author to ban", ask(fixKey).map { $0.author.isEmpty } == true)
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
        check("no previous result: every merge and split is fresh",
              Store.pipelineFreshEvents(first, after: nil) == [merged, split])
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
        var theirs = items[0]
        theirs.writable = false
        check("nor an issue assigned to someone else, which the fix would claim",
              store.startPipelineFix(theirs) == "It is assigned to someone else" && ids().isEmpty)
        var elsewhere = items[0]
        elsewhere.id = "https://github.com/x/gone/issues/90012"
        elsewhere.repo = "x/gone"
        check("nor one in a repo that is no root here",
              store.startPipelineFix(elsewhere) == "x/gone is no GitHub repo root here, so there is nowhere to fix it")
        store.pinAgentRows([agent(issue)])
        check("nor one an agent is fixing", store.startPipelineFix(items[0]) == "An agent is already fixing it")
        store.pinAgentRows([])

        print("\npipeline: the screen's actions")
        func at(_ stage: PipelineStage, _ kind: PipelineKind = .issue, writable: Bool = true) -> PipelineItem {
            var i = item(issue, kind, author: "bob")
            i.stage = stage
            i.writable = writable
            return i
        }
        check("Fracture: a writable open issue not split yet",
              [PipelineStage.unrated, .human, .candidate].allSatisfy { PipelineView.canFracture(at($0), edges: []) }
                  && !PipelineView.canFracture(at(.fixing), edges: [])
                  && !PipelineView.canFracture(at(.human, writable: false), edges: [])
                  && !PipelineView.canFracture(at(.human, .pr), edges: [])
                  && !PipelineView.canFracture(at(.human),
                                               edges: [PipelineGraph.Edge(from: issue, to: "c", kind: .child)]))
        check("Start fix: a writable candidate issue only",
              PipelineView.canStartFix(at(.candidate)) && !PipelineView.canStartFix(at(.human))
                  && !PipelineView.canStartFix(at(.candidate, writable: false))
                  && !PipelineView.canStartFix(at(.candidate, .pr)))

        print("\npipeline: connectors")
        func graph(_ cells: [(String, Int, Int)], _ edges: [(String, String, PipelineGraph.EdgeKind)])
            -> PipelineLayout {
            PipelineLayout.make(PipelineTickResult(
                at: Date(), items: cells.map { item($0.0, .issue, author: "bob") },
                graph: PipelineGraph(nodes: cells.map { PipelineGraph.Node(id: $0.0, column: $0.1, row: $0.2) },
                                     edges: edges.map { PipelineGraph.Edge(from: $0.0, to: $0.1, kind: $0.2) })),
                lane: nil)
        }
        func gh(_ n: Int) -> String { "https://github.com/o/r/issues/\(n)" }
        func name(_ id: String) -> String { String(id.split(separator: "/").last ?? "") }
        let eng10 = "https://linear.app/o/issue/ENG-10"
        // One row, as the core lays them out when #11 is newer than #12.
        let stack = graph([(eng10, 0, 0), (gh(11), 1, 0), (gh(12), 2, 0)],
                          [(eng10, gh(11), .fixes), (eng10, gh(12), .fixes), (gh(11), gh(12), .stacked)])
        let closes = graph([(gh(30), 0, 0), (gh(31), 1, 0), (gh(34), 2, 0)],
                           [(gh(30), gh(31), .child), (gh(31), gh(34), .fixes), (gh(30), gh(34), .fixes)])
        let children = (101...106).map(gh)
        let fan = graph([(gh(100), 0, 0)] + children.enumerated().map { ($1, 1, $0) },
                        children.map { (gh(100), $0, .child) })
        let cycle = graph([(gh(60), 0, 0), (gh(61), 1, 0)],
                          [(gh(60), gh(61), .stacked), (gh(61), gh(60), .stacked)])
        func samples(_ link: PipelineLayout.Link) -> [CGPoint] {
            func at(_ polygon: [CGPoint], _ t: CGFloat) -> CGPoint {
                polygon.count == 1 ? polygon[0] : at(zip(polygon, polygon.dropFirst()).map {
                    CGPoint(x: $0.x + ($1.x - $0.x) * t, y: $0.y + ($1.y - $0.y) * t)
                }, t)
            }
            var points: [CGPoint] = []
            link.path.forEach { element in
                let from = points.last ?? .zero
                let polygon: [CGPoint]
                switch element {
                case .move(let p): points.append(p); return
                case .line(let p): polygon = [from, p]
                case .quadCurve(let p, let c): polygon = [from, c, p]
                case .curve(let p, let c1, let c2): polygon = [from, c1, c2, p]
                case .closeSubpath: return
                }
                points += (1...200).map { at(polygon, CGFloat($0) / 200) }
            }
            return points
        }
        /// Each connector inside a card other than its two (1pt clear of it), inside one of its
        /// own past the side it meets, or off the canvas; each into the next column out of the
        /// gutter between.
        func astray(_ layout: PipelineLayout) -> [String] {
            let frames = Dictionary(uniqueKeysWithValues: layout.cards.map { ($0.item.id, $0.frame) })
            return layout.links.flatMap { link -> [String] in
                let points = samples(link), a = frames[link.edge.from]!, b = frames[link.edge.to]!
                let what = "\(name(link.edge.from)) → \(name(link.edge.to))"
                var bad = layout.cards.compactMap { card -> String? in
                    let own = card.item.id == link.edge.from || card.item.id == link.edge.to
                    let box = card.frame.insetBy(dx: own ? 0.5 : -1, dy: own ? 0.5 : -1)
                    return points.contains { box.contains($0) } ? "\(what) under \(name(card.item.id))" : nil
                }
                if !points.allSatisfy({ CGRect(origin: .zero, size: layout.size).contains($0) }) {
                    bad.append("\(what) off the canvas")
                }
                if abs(b.minX - a.maxX - PipelineLayout.columnGap) < 0.5,
                   !points.allSatisfy({ $0.x >= a.maxX - 0.01 && $0.x <= b.minX + 0.01 }) {
                    bad.append("\(what) out of its gutter")
                }
                return bad
            }
        }
        func clear(_ name: String, _ layout: PipelineLayout, edges: Int) {
            let bad = astray(layout)
            check(name, layout.links.count == edges && bad.isEmpty)
            if !bad.isEmpty { print("  " + bad.joined(separator: "; ")) }
        }
        clear("ENG-10 fixed by #11 and by #12 stacked on it, one row: through gutters and gaps only", stack, edges: 3)
        clear("#34 closing #30 and its child #31, one row: through gutters and gaps only", closes, edges: 3)
        clear("#100's six children: through their gutter only", fan, edges: 6)
        clear("#60 and #61 stacked on each other: the edge back round through the outer gutters", cycle, edges: 2)
        let cards = fan.cards.map(\.frame).reduce(CGRect.null) { $0.union($1) }, pad = PipelineLayout.inset
        check("no connector round the outer cards: the canvas is the cards and an inset round them",
              CGRect(origin: .zero, size: fan.size) == cards.insetBy(dx: -pad, dy: -pad))
        func port(_ layout: PipelineLayout, _ from: String, _ to: String, end: Bool) -> CGFloat {
            layout.links.first { $0.edge.from == from && $0.edge.to == to }
                .flatMap { end ? samples($0).last?.y : samples($0).first?.y } ?? .nan
        }
        let out100 = children.map { port(fan, gh(100), $0, end: false) }
        check("connectors sharing a side meet it apart, in the order they head off to or come in from",
              zip(out100, out100.dropFirst()).allSatisfy { $1 - $0 >= 10 }
                  && port(stack, gh(11), gh(12), end: true) + 10 <= port(stack, eng10, gh(12), end: true))

        print("\npipeline: identity")
        check("a Linear link by its identifier, a GitHub one by its item key, anything else as it is",
              Store.pipelineIdentity(linear) == "linear:ENG-90010"
                  && Store.pipelineIdentity(issue) == "o/r#90010"
                  && Store.pipelineIdentity("https://example.com/x") == "https://example.com/x")

        if let harness = ProcessInfo.processInfo.environment["DIPLOMAT_PIPELINE_E2E"], !harness.isEmpty {
            await live(store, harness: URL(fileURLWithPath: harness), check: check)
        }

        print(pass ? "\nPIPELINE TEST: PASS" : "\nPIPELINE TEST: FAIL")
        return pass
    }

    /// `DIPLOMAT_PIPELINE_E2E=<dir>`: real syncs (`PipelineTick.run`) of `acme/app`, checked
    /// out at `<dir>/checkout`, through the stubs DIPLOMAT_GH, DIPLOMAT_CLAUDE and
    /// DIPLOMAT_LINEAR_API name, which log to `<dir>/gh.log`, `claude.log` and `linear.log`
    /// (the harness in the build notes: an operator `op`, issues #1 and #5, PR #2 fixing
    /// #1, PR #3 labelled cleared by hand at a clean head, someone else's PR #4, and
    /// Linear's ENG-1, every rating low/low).
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
