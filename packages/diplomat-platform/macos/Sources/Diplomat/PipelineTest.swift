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
        check("a launch: no pipeline ask queued before it starts until its first sync is applied",
              !store.pipelineJudged)
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
        check("Fast-track my PRs names only a PR closing only candidate issues, rated while it is on",
              SettingsView.pipelineFastTrackSummary
                  == "Labels diplomat:fast-track each low/low PR of yours that closes a candidate issue, "
                  + "and reviews it until clean"
                  && SettingsView.pipelineFastTrackDetail.hasPrefix(
                      "Only your own PRs from the repo itself into its default branch that close only "
                          + "candidate issues: the fixes the pipeline asks for.")
                  && SettingsView.pipelineFastTrackDetail.hasSuffix(" A PR rated while this is off stays a person's."))
        check("Merge cleared PRs points at every hold rather than listing some",
              SettingsView.pipelineMergeDetail.hasPrefix(
                  "A cleared PR is merged only when none of the holds in docs/pipeline.md applies "
                      + "to it, checked again right before the merge."))
        func feed(_ action: String) -> [String] {
            AuditLog.read().filter { $0.action == action }.map { "\($0.source) \($0.detail)" }.reversed()
        }

        let issue = "https://github.com/o/r/issues/90010"
        let pr = "https://github.com/o/r/pull/90011"
        let linear = "https://linear.app/swm/issue/ENG-90010/the-same-digits"
        let fix = PipelineEffect.fixIssue(repo: "o/r", number: 90010, url: issue, author: "bob")
        let fixLinear = PipelineEffect.fixLinear(repo: "o/r", identifier: "ENG-90010", url: linear,
                                                 text: "Title\n\nBody", author: "Bob")
        let review = PipelineEffect.review(repo: "o/r", number: 90011, url: pr, headSha: "aaa111",
                                           author: "latekvo")
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
                          .fixIssue(repo: "x/gone", number: 90012, url: "https://github.com/x/gone/issues/90012", author: ""),
                          .fixIssue(repo: "g/third", number: 90013, url: "https://gitlab.com/g/third/-/issues/90013", author: "")])
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
                      && cfg.fastTrack == true && cfg.depth == "max")
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
        await store.applyPipeline(all, now: t0.addingTimeInterval(ReviewReconcile.retryMaxBackoff))
        check("…nor asked again past its backoff while it waits in the queue",
              ids().sorted() == [fixKey, linearKey, reviewKey].sorted() && store.loadPipelineAttempts() == records)
        // As the drain leaves it: the asks dispatched, their agents gone without a word.
        clearQueue()
        await store.applyPipeline(all, now: t0.addingTimeInterval(60))
        check("dispatched a minute ago: none queued again", ids().isEmpty)
        check("…and the records stand", store.loadPipelineAttempts() == records)
        await store.applyPipeline(result([review]), now: t0.addingTimeInterval(120))
        check("…nor a review of the same head", ids().isEmpty)
        let pushed = PipelineEffect.review(repo: "o/r", number: 90011, url: pr, headSha: "bbb222", author: "latekvo")
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
        await store.applyPipeline(result([.fixIssue(repo: "o/r", number: 90010, url: issue,
                                                    author: "LateKvo")]), now: t0)
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
        var renamedRun = linearRun
        renamedRun.prURL = "https://linear.app/swm/issue/ENG-90010/a-new-title"
        check("…under whatever title its link follows",
              Store.pipelineConcluded(records, runs: [renamedRun], at: t1)
                  .filter { $0.value.concludedAt != nil }.keys.sorted() == [fixLinear.key])
        let reviewRun = AgentState.RunRecord(runID: "r-rev", dispatchedAt: t1.timeIntervalSince1970 + 60,
                                             prNumber: 90011, prURL: pr, kind: AgentTaskQueue.reviewAction)
        check("a review run concludes its PR's review record, not a fix's",
              Store.pipelineConcluded(records.filter { [review.key, fix.key].contains($0.key) },
                                      runs: [reviewRun], at: t1)
                  .mapValues { $0.concludedAt != nil } == [review.key: true, fix.key: false])
        var replyRun = reviewRun
        replyRun.ledgerKey = "review-reply:\(pr)@aaa111"
        check("…nor does a monitor's run on that PR",
              Store.pipelineConcluded(records, runs: [replyRun], at: t1) == records)
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
        let asked = Date().addingTimeInterval(-600)
        store.savePipelineAttempts([:])
        await store.applyPipeline(result([fix]), now: asked)
        if let task = store.queuedTasks.first(where: { $0.id == fixKey }) { store.recordQueuedAttempt(task) }
        check("…which the queue's spawn writes",
              store.loadPipelineAttempts()[fix.key].map { $0.lastDispatchedAt.timeIntervalSince(asked) > 500 } == true)
        clearQueue()
        store.savePipelineAttempts(concluded)
        await store.applyPipeline(result([fix]), now: t1.addingTimeInterval(5 * 3600))
        check("a concluded fix is not asked for again, hours later", ids().isEmpty)
        check("…and its record outlives the backoff ceiling while it is owed",
              store.loadPipelineAttempts()[fix.key]?.concludedAt == t1)

        print("\npipeline: records a sync keeps")
        let old = ReviewAttempt(requestedAt: "fix", lastDispatchedAt: t0, attempts: 1)
        let gone = "pipeline-fix:https://github.com/o/r/issues/90077"
        let later = t0.addingTimeInterval(3 * 3600)
        let teams = [PipelineSettings.LinearTeam(key: "ENG", repo: "o/r")]
        check("at the backoff ceiling, a record no sync owes is dropped, a notice or not",
              Store.retainedPipelineAttempts([gone: old], after: result([], notices: ["Linear: no key"]),
                                             teams: teams, now: later).isEmpty)
        check("…kept inside it, so a read that failed does not make it new",
              Store.retainedPipelineAttempts([gone: old], after: result([]),
                                             teams: teams, now: later.addingTimeInterval(-1))[gone] == old)
        check("…and kept while owed, however old",
              Store.retainedPipelineAttempts([fix.key: old], after: result([fix]),
                                             teams: teams, now: t0.addingTimeInterval(30 * 86400))[fix.key] == old)
        let unreadRoot = PipelineTickResult(at: Date(), unread: ["O/R"])
        check("…and in a root the sync did not judge in full, a Linear issue's by its team's",
              Store.retainedPipelineAttempts([gone: old, fixLinear.key: old], after: unreadRoot,
                                             teams: teams, now: later) == [gone: old, fixLinear.key: old]
                  && Store.retainedPipelineAttempts([gone: old, fixLinear.key: old], after: unreadRoot,
                                                    teams: [], now: later) == [gone: old]
                  && Store.retainedPipelineAttempts([gone: old], after: PipelineTickResult(at: Date(), unread: ["o/x"]),
                                                    teams: teams, now: later).isEmpty)
        store.savePipelineAttempts([gone: old])
        await store.applyPipeline(result([]), judged: false, now: later)
        check("…all of them after a sync not judged", store.loadPipelineAttempts() == [gone: old])
        await store.applyPipeline(result([]), now: later)
        check("…as a sync saves them", store.loadPipelineAttempts().isEmpty)
        let closedNow = ReviewAttempt(requestedAt: "fix", lastDispatchedAt: t0, attempts: 1, concludedAt: later)
        // Runs while the pass awaits the review's in-flight probe.
        Task { @MainActor in store.savePipelineAttempts([gone: closedNow]) }
        await store.applyPipeline(result([review]), now: later)
        check("…onto the records a run concluded while its pass awaited",
              store.loadPipelineAttempts()[gone] == closedNow && store.loadPipelineAttempts()[review.key] != nil)
        clearQueue()

        print("\npipeline: a cancelled ask")
        store.savePipelineAttempts([:])
        let t2 = Date()
        await store.applyPipeline(result([fix, review]), now: t2)
        let cancelLines = [fixKey, reviewKey].map { "panel \(job($0)?.label ?? $0) — cancelled, not run" }
        store.cancelRequestedWork(fixKey)
        store.cancelRequestedWork(reviewKey)
        let cancelled = store.loadPipelineAttempts()
        check("Cancel drops a sync's fix and review, each record concluded at its stamp",
              ids().isEmpty && store.requestedWork.isEmpty
                  && Array(feed("queue-cancel").suffix(2)) == cancelLines
                  && cancelled[fix.key].map { $0.requestedAt == "fix" && $0.concludedAt != nil } == true
                  && cancelled[review.key].map { $0.requestedAt == "aaa111" && $0.concludedAt != nil } == true)
        let t3 = t2.addingTimeInterval(ReviewReconcile.retryMaxBackoff)
        await store.applyPipeline(result([fix, review]), now: t3)
        await store.applyPipeline(result([fix, review]), now: t3.addingTimeInterval(60))
        check("…so no sync asks for either again, past every backoff", ids().isEmpty)
        let headMoved = PipelineEffect.review(repo: "o/r", number: 90011, url: pr, headSha: "ccc333",
                                              author: "latekvo")
        await store.applyPipeline(result([fix, headMoved]), now: t3)
        check("…but a new head's review is, a first attempt at it",
              ids() == [reviewKey] && store.loadPipelineAttempts()[review.key]
                  .map { $0.requestedAt == "ccc333" && $0.attempts == 1 && $0.concludedAt == nil } == true)
        store.pipelineResult = result([fix, headMoved])
        check("…and the fix by Start fix", store.startPipelineFix(items[0]) == nil
              && ids().sorted() == [fixKey, reviewKey].sorted())
        store.cancelRequestedWork(fixKey)
        await store.applyPipeline(result([fix, headMoved]), now: t3.addingTimeInterval(ReviewReconcile.retryMaxBackoff))
        check("…which a Cancel concludes too", ids() == [reviewKey])
        clearQueue()
        store.savePipelineAttempts([:])
        // Each runs while the pass awaits the review's in-flight probe.
        Task { @MainActor in store.cancelRequestedWork(fixKey) }
        await store.applyPipeline(result([fix, review]), now: t2)
        await store.applyPipeline(result([fix, review]), now: t3)
        check("…a Cancel of an ask its sync's pass queued, while that pass awaits", ids() == [reviewKey])
        clearQueue()
        store.savePipelineAttempts([:])
        await store.applyPipeline(result([fix]), now: t2)
        Task { @MainActor in store.cancelRequestedWork(fixKey) }
        await store.applyPipeline(result([review, fix]), now: t3)
        check("…or of one queued before, while a later pass awaits", ids() == [reviewKey])
        clearQueue()
        store.savePipelineAttempts([:])

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
        _ = AgentRegistry.save([AgentState.RunRecord(runID: "r-review", dispatchedAt: Date().timeIntervalSince1970,
                                                     prNumber: 90011, prURL: pr, kind: AgentTaskQueue.reviewAction)])
        await store.applyPipeline(result([review]), now: now)
        check("an agent on the PR holds its fast-track review", ids().isEmpty && store.loadPipelineAttempts().isEmpty)
        _ = AgentRegistry.save([])

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
        // The sync each starts, turned away while the switch is off rather than run with
        // whatever stub a later check sets.
        await Task.yield()
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
        check("…as the operator's, through a restart",
              ask(fixKey)?.byHand == true
                  && Store.decodeRequestedWork(try? JSONEncoder().encode(store.requestedWork), configured: "o/r")
                      .first { $0.key == fixKey }?.byHand == true)
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
        var triaged = at(.human)
        triaged.hold = "triaged as enhancement"
        var heldOther = at(.human)
        heldOther.hold = "an open PR fixes it"
        check("…which a sync refuses for an issue held as triaged, and the button says so",
              PipelineView.fractureRefused(triaged) == "No sync splits an issue triaged as enhancement"
                  && PipelineView.fractureRefused(heldOther) == nil && PipelineView.fractureRefused(at(.human)) == nil)
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
        if let asked = store.pipelineAsk(review) { store.requestOne(asked) }
        Store.pipelineTickOverride = { _ in
            store.pipelineEnabled = false
            return result([])
        }
        await store.runPipelineSyncOnce()
        store.pipelineEnabled = true
        check("a sync switched off midway, which emits nothing, withdraws nothing", ids() == [reviewKey])
        clearQueue()
        store.savePipelineAttempts([:])
        await store.applyPipeline(result([fix, fixLinear, review]), now: now)
        let other = item("https://github.com/o/r/issues/90014", .issue, author: "bob")
        store.pipelineResult = PipelineTickResult(at: Date(), items: items + [other])
        let otherKey = "issues:o/r#90014"
        check("Start fix queues beside the sync's asks",
              store.startPipelineFix(other) == nil && ids().sorted() == [fixKey, linearKey, reviewKey, otherKey].sorted())
        ticks = []
        Store.pipelineTickOverride = { settings in
            ticks.append(settings)
            return PipelineTickResult(at: Date(), items: items + [other], effects: [review], fixable: [other.id])
        }
        let dropsBefore = feed("queue-drop").count
        store.pipelineFix = false
        check("Open fix PRs off: the fixes the sync queued are withdrawn at once, no sync run, Start fix's kept",
              ids().sorted() == [otherKey, reviewKey].sorted() && ticks.isEmpty
                  && feed("queue-drop").count == dropsBefore + 2)
        await store.runPipelineSyncOnce()
        check("…and a sync keeps the Start fix while its issue is fixable", ids().sorted() == [otherKey, reviewKey].sorted())
        store.pipelineFastTrack = false
        check("Fast-track my PRs off: the review the sync queued is withdrawn at once", ids() == [otherKey])
        if let asked = store.pipelineAsk(fix) { store.requestOne(asked) }
        Store.pipelineTickOverride = { _ in
            PipelineTickResult(at: Date().addingTimeInterval(-60), items: items, unread: ["o/r"])
        }
        await store.runPipelineSyncOnce()
        check("a sync withdraws an ask whose switch is off, even with a stale result in an unread root",
              ids() == [otherKey])
        store.pipelineFix = true
        store.pipelineFastTrack = true
        clearQueue()
        store.savePipelineAttempts([:])
        check("a result dated in the second its sync began is that sync's",
              Store.pipelineRan(PipelineTickResult(at: Date(timeIntervalSince1970: 100)),
                                started: Date(timeIntervalSince1970: 100.7))
                  && !Store.pipelineRan(PipelineTickResult(at: Date(timeIntervalSince1970: 99)),
                                        started: Date(timeIntervalSince1970: 100.2)))

        print("\npipeline: switched back on")
        await store.applyPipeline(result([fix, review]), now: now)
        store.pipelineEnabled = false
        store.pipelineEnabled = true
        check("on again: none of the asks queued before starts until a sync begun since is applied",
              store.isPaused(.pipeline) && store.drainableTasks.isEmpty && ids().count == 2)
        Store.pipelineTickOverride = { _ in PipelineTickResult(at: Date().addingTimeInterval(-60), items: items) }
        await store.runPipelineSyncOnce()
        check("…nor once the last result is answered again", store.isPaused(.pipeline) && ids().count == 2)
        Store.pipelineTickOverride = { _ in
            store.pipelineEnabled = false
            store.pipelineEnabled = true
            return result([fix])
        }
        await store.runPipelineSyncOnce()
        check("…nor once one begun before it is, which withdraws nothing",
              store.isPaused(.pipeline) && ids().sorted() == [fixKey, reviewKey].sorted())
        Store.pipelineTickOverride = { _ in result([fix]) }
        await store.runPipelineSyncOnce()
        check("…which withdraws what it no longer owes, then lets the rest start",
              !store.isPaused(.pipeline) && ids() == [fixKey] && store.drainableTasks.map(\.id) == [fixKey])
        store.pipelineEnabled = false
        store.pipelineEnabled = true
        // `gh` names no login, so a poll stops at its viewer read: each one it logs is a poll.
        let pollLog = scratch.appendingPathComponent("polls.log"), pollGH = scratch.appendingPathComponent("gh-polls")
        try? "#!/bin/sh\ncase \"$*\" in *viewer*) echo poll >> '\(pollLog.path)';; esac\necho '{\"data\":{\"viewer\":{\"login\":\"\"}}}'\n"
            .write(to: pollGH, atomically: true, encoding: .utf8)
        chmod(pollGH.path, 0o755)
        let tripwire = ProcessInfo.processInfo.environment["DIPLOMAT_GH"]
        setenv("DIPLOMAT_GH", pollGH.path, 1)
        let login = store.usernameOverride
        store.usernameOverride = ""
        store.earlyPollFloor = 0
        store.pollsEarly = true
        /// The polls run so far, once one brought forward has started (well inside a second)
        /// and ended.
        func polls() async -> Int {
            try? await Task.sleep(nanoseconds: 1_000_000_000)
            while store.secondsUntilPoll(gap: 0) > 0 { try? await Task.sleep(nanoseconds: 50_000_000) }
            return ((try? String(contentsOf: pollLog, encoding: .utf8)) ?? "").split(separator: "\n").count
        }
        await store.applyPipeline(result([fix]), judged: false)
        let gated = await polls()
        await store.applyPipeline(result([fix]))
        let opened = await polls()
        await store.applyPipeline(result([fix]))
        let open = await polls()
        check("…and brings the poll that drains them forward, once", gated == 0 && opened == 1 && open == 1)
        store.pollsEarly = false
        store.usernameOverride = login
        if let tripwire { setenv("DIPLOMAT_GH", tripwire, 1) } else { unsetenv("DIPLOMAT_GH") }
        clearQueue()
        let lapsed = ReviewAttempt(requestedAt: "fix", lastDispatchedAt: Date().addingTimeInterval(-4 * 3600),
                                   attempts: 2)
        store.savePipelineAttempts([fix.key: lapsed])
        Store.pipelineTickOverride = { _ in
            store.pipelineFix = false
            store.pipelineFix = true
            return result([])
        }
        await store.runPipelineSyncOnce()
        check("a sync Open fix PRs went off during keeps the records of the fixes it left out",
              store.loadPipelineAttempts() == [fix.key: lapsed] && !store.isPaused(.pipeline))
        Store.pipelineTickOverride = { _ in result([]) }
        await store.runPipelineSyncOnce()
        check("…which the next sync drops", store.loadPipelineAttempts().isEmpty)
        Store.pipelineTickOverride = nil

        print("\npipeline: a queued Linear fix read otherwise")
        await store.applyPipeline(result([fixLinear]), now: now)
        // As Start fix would have queued it.
        if let i = store.requestedWork.firstIndex(where: { $0.key == linearKey }) { store.requestedWork[i].byHand = true }
        let recorded = store.loadPipelineAttempts()
        let edited = PipelineEffect.fixLinear(repo: "o/r", identifier: "ENG-90010", url: linear,
                                              text: "Title\n\nEdited", author: "Bob")
        func linearAsk() -> (repo: String, text: String?, byHand: Bool)? {
            guard let a = ask(linearKey), case .issues(let cfg) = a.config else { return nil }
            return (a.repo, cfg.linear?.text, a.byHand)
        }
        func owing(_ effect: PipelineEffect) -> PipelineTickResult {
            PipelineTickResult(at: Date(), items: items, effects: [effect], fixable: [linear])
        }
        await store.applyPipeline(owing(edited), now: now)
        check("its text edited: queued again with the new text, as the same attempt and the operator's",
              ids() == [linearKey] && linearAsk().map { $0 == ("o/r", "Title\n\nEdited", true) } == true
                  && job(linearKey)?.prompt.contains("Edited") == true && store.loadPipelineAttempts() == recorded
                  && feed("pipeline-fix").last == "auto \(line(linearKey)) queued again: its repo or text changed")
        let fixLines = feed("pipeline-fix").count
        let pinnedRoots = store.roots
        store.pinRoots(pinnedRoots + [PRRef.LocalRepo(owner: "o", repo: "web", path: scratch.path)])
        let moved = PipelineEffect.fixLinear(repo: "o/web", identifier: "ENG-90010", url: linear,
                                             text: "Title\n\nEdited", author: "Bob")
        await store.applyPipeline(owing(moved), now: now)
        await store.applyPipeline(owing(moved), now: now)
        check("…its team mapped to another repo: queued again there, once",
              ids() == [linearKey] && linearAsk()?.repo == "o/web"
                  && job(linearKey)?.prompt.contains("fix it in o/web") == true
                  && feed("pipeline-fix").count == fixLines + 1)
        store.pinRoots(pinnedRoots)
        clearQueue()
        store.savePipelineAttempts([:])

        print("\npipeline: asks a sync no longer owes")
        let asks = [fix, fixLinear, review].compactMap { store.pipelineAsk($0) } + [sweep]
        func withdrawn(_ seen: [PipelineItem], _ effects: [PipelineEffect], unread: [String] = [],
                       fixable: [String] = [], of asks: [Store.RequestedWork] = asks) -> [String] {
            Store.pipelineWithdrawn(asks, by: PipelineTickResult(at: Date(), items: seen, effects: effects,
                                                                 unread: unread, fixable: fixable),
                                    fix: true, fastTrack: true).sorted()
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
        check("…a candidate's fix the sync did not emit goes (its switch off, a hold)",
              withdrawn(heldItems, []) == [fixKey, linearKey, reviewKey].sorted())
        let fromScreen = asks.map { ask -> Store.RequestedWork in
            var fix = ask
            if case .issues = fix.config { fix.byHand = true }
            return fix
        }
        check("…but a Start fix stays while its issue is fixable, shown or not",
              withdrawn(heldItems, [], fixable: [issue], of: fromScreen) == [linearKey, reviewKey].sorted()
                  && withdrawn([], [], fixable: [issue, linear], of: fromScreen) == [reviewKey])
        check("…and nothing goes in a root the sync could not judge in full",
              withdrawn(assigned, [], unread: ["O/R"]).isEmpty)
        check("…an ask whose item a whole read left out goes (closed)",
              withdrawn([], []) == [fixKey, linearKey, reviewKey].sorted())
        check("…and one a sync queued goes while its switch is off, in an unread root or with no result",
              Store.pipelineWithdrawn(asks, by: result([fix, fixLinear, review]), fix: false, fastTrack: true).sorted()
                  == [fixKey, linearKey].sorted()
                  && Store.pipelineWithdrawn(asks, by: PipelineTickResult(at: Date(), unread: ["o/r"]),
                                             fix: true, fastTrack: false) == [reviewKey]
                  && Store.pipelineWithdrawn(fromScreen, by: nil, fix: false, fastTrack: false) == [reviewKey]
                  && Store.pipelineWithdrawn(asks, by: nil, fix: true, fastTrack: true).isEmpty)
        clearQueue()
        store.savePipelineAttempts([:])
        await store.applyPipeline(result([fix]))
        if let task = store.queuedTasks.first(where: { $0.id == fixKey }) { store.beginStarting(task) }
        await store.applyPipeline(result([]))
        check("…but one starting is left to its dispatch", store.requestedWork.map(\.key) == [fixKey])
        store.endStarting(fixKey)
        clearQueue()
        store.savePipelineAttempts([:])

        print("\npipeline: concluded records")
        let closedOut = ReviewAttempt(requestedAt: "fix", lastDispatchedAt: t0, attempts: 1, concludedAt: t0)
        check("a concluded record no sync owes is kept for 30 days after its run concluded",
              Store.retainedPipelineAttempts([gone: closedOut], after: result([]), teams: teams,
                                             now: t0.addingTimeInterval(29 * 86400))[gone] == closedOut)
        check("…and dropped past them",
              Store.retainedPipelineAttempts([gone: closedOut], after: result([]), teams: teams,
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
        let partFix = PipelineEffect.fixIssue(repo: "o/r", number: 90030, url: part, author: "mallory")
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
        clearQueue()
        // A part the sync held for the ban, emitting no fix for it.
        var heldPart = partItem
        heldPart.splitFrom = "mallory"
        heldPart.hold = "split from an issue of @mallory, who is on the prompt-injection ban list"
        store.pipelineResult = PipelineTickResult(at: Date(), items: items + [heldPart])
        check("a held part has no Start fix, and pressing it says the hold",
              store.pipelineFixEffect(for: heldPart) == nil
                  && store.startPipelineFix(heldPart) == heldPart.hold && ids().isEmpty)
        let bannedBefore = store.bannedAuthors
        store.bannedAuthors = [BannedAuthor(login: "mallory")]
        check("the screen holds Rate now and Fracture for the banned author its text came from",
              store.pipelineBanned(heldPart) == "mallory"
                  && store.pipelineBanned(item(issue, .issue, author: "Mallory")) == "Mallory"
                  && store.pipelineBanned(partItem) == nil)
        store.bannedAuthors = bannedBefore
        var unheld = heldPart
        unheld.hold = nil
        store.pipelineResult = PipelineTickResult(at: Date(), items: items + [unheld])
        check("a part with no emitted fix is asked for as the author its text came from",
              store.startPipelineFix(unheld) == nil
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
            if ticks.count == 1 {
                store.pipelineSyncAgain = true
                store.pipelineEnabled = false
            }
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
        store.pipelineLinearTeamsRaw = "ENG=o/r, OPS=g/third"
        check("a Linear issue's code can be read when its team names a GitHub root; a GitHub item's always",
              store.pipelineRooted(eng) && !store.pipelineRooted(ops) && store.pipelineRooted(items[0]))
        store.pipelineLinearTeamsRaw = "ENG=o/r"
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
        var humanPR = myPR
        humanPR.stage = .human
        humanPR.lane = .human
        check("writable: the same words for any item, promising no step its stage may not take",
              [humanPR, items[0]].allSatisfy {
                  PipelineTint.access($0) == "Writable: Diplomat may label it and act on it."
              })
        check("read only: said of every item Diplomat may not write, whatever kept it so",
              [mergedPR, theirPR, closedIssue].allSatisfy {
                  PipelineTint.access($0) == "Read only: Diplomat shows it and writes nothing to it."
              })
        var heldBy = theirPR
        heldBy.assignees = ["dave", "erin"]
        check("…and who it is by and assigned to",
              PipelineTint.people(heldBy) == "By @carol · assigned to @dave, @erin"
                  && PipelineTint.people(items[2]) == "By Bob · unassigned")
        heldBy.hold = "@carol is on the prompt-injection ban list"
        check("a hold is said as one",
              PipelineTint.hover(heldBy).components(separatedBy: "\n")
                  .contains("Held: @carol is on the prompt-injection ban list"))
        check("a sync that read nothing says so",
              PipelineView.emptyText(enabled: true, synced: true) == "The last sync found no open issue or PR."
                  && PipelineView.emptyText(enabled: true, synced: false).hasPrefix("Nothing read yet")
                  && PipelineView.emptyText(enabled: false, synced: true).hasPrefix(
                      "The pipeline is off. Switched on in Settings, it rates every open issue and your own PRs,"))
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
    /// DIPLOMAT_LINEAR_API name, which log to `<dir>/gh.log`, `claude.log` and `linear.log`,
    /// GitHub's state in `<dir>/gh-state.json`. None of these is in the repo: whoever runs it
    /// supplies an operator `op`; #1, rated low/low, and op's PR #2 fixing it, fast-tracked
    /// and clean at its head; unrated #5, and #6 by mallory, whom the gh stub bans once the
    /// first sync has read the ban list; someone else's PR #4; and Linear's ENG-1, claude
    /// rating each low/low. Reading #2 again before merging it, the stub writes
    /// `<dir>/flip-merge` and waits for control.json to say merge is off. While the state's
    /// `readErrors` is set, the `Repo` read answers with that error beside its data. The
    /// state's `later` holds low/low #7 and op's draft PR #3 fixing it, likewise clean, and
    /// its `more` low/low #8 and #9, its `extra` low/low #10 and #11, its `review` low/low #13
    /// and op's PR #12 fixing it, fast-tracked with no clean marker. While its `holdReads` is
    /// above 0, a `Repo` read writes its ordinal to `<dir>/held` and waits for `<dir>/go` to
    /// say the same. `acme/web`, checked out at `<dir>/checkout-web`, is empty.
    /// `<dir>/linear-state.json`'s `later` adds Linear's low/low ENG-2, its `extra` ENG-3; its
    /// `done` names the issues Linear no longer lists, its `text` an issue's edited text.
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
                .filter { !["Issues", "Issue", "Labels", "Attached"].contains($0) }
        }
        func truncate() {
            for name in ["gh.log", "linear.log", "claude.log"] {
                try? Data().write(to: harness.appendingPathComponent(name))
            }
        }
        func feed() -> [String] {
            AuditLog.read()
                .filter { $0.action.hasPrefix("pipeline-") || ["queue-drop", "queue-cancel"].contains($0.action) }
                .map { "\($0.source) \($0.action) \($0.detail)" }.reversed()
        }
        func ids() -> [String] { store.queuedTasks.map(\.id).sorted() }
        func prompt(_ key: String) -> String { store.queuedTasks.first { $0.id == key }?.job.prompt ?? "" }
        func ask(_ key: String) -> Store.RequestedWork? { store.requestedWork.first { $0.key == key } }
        func item(_ number: Int, _ kind: String = "issues") -> PipelineItem? {
            store.pipelineResult?.items.first { $0.id == "https://github.com/acme/app/\(kind)/\(number)" }
        }
        func patch(_ change: (inout [String: Any]) -> Void) {
            let state = harness.appendingPathComponent("gh-state.json")
            guard var github = (try? Data(contentsOf: state))
                .flatMap({ try? JSONSerialization.jsonObject(with: $0) }) as? [String: Any] else { return }
            change(&github)
            try? JSONSerialization.data(withJSONObject: github).write(to: state)
        }
        func assign(_ number: Int, _ who: [String]) {
            patch { github in
                var issues = github["issues"] as? [[String: Any]] ?? []
                for i in issues.indices where issues[i]["number"] as? Int == number { issues[i]["assignees"] = who }
                github["issues"] = issues
            }
        }
        func sync() async {
            // Events are stamped to the second; a sync in a later one tells them apart.
            try? await Task.sleep(nanoseconds: 1_100_000_000)
            truncate()
            await store.runPipelineSyncOnce()
        }
        let banned = URL(fileURLWithPath: ProcessInfo.processInfo.environment["DA_BAN_DIR"] ?? "")
            .appendingPathComponent("banned.json")
        try? FileManager.default.removeItem(at: banned)
        defer { try? FileManager.default.removeItem(at: banned) }

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

        // The Settings switch, flipped while the sync runs.
        let flip = harness.appendingPathComponent("flip-merge")
        let flipper = Task { @MainActor in
            while !FileManager.default.fileExists(atPath: flip.path) && !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 50_000_000)
            }
            if !Task.isCancelled { store.pipelineMerge = false }
        }
        truncate()
        await store.runPipelineSyncOnce()
        flipper.cancel()
        let writes = ghWrites()
        print("  sync 1 gh writes:\n" + writes.map { "    gh \($0)" }.joined(separator: "\n"))
        print("  sync 1 hooks: \(log("hooks.log"))")
        let flipped = log("hooks.log").compactMap { $0 as? [String: Any] }.first { $0["flip"] != nil }
        check("sync 1: merge switched off mid-sync reaches the core through control.json, and #2 is not merged",
              (flipped?["control"] as? [String: Any])?["merge"] as? Bool == false
                  && !store.pipelineMerge && !writes.contains { $0.hasPrefix("pr merge") }
                  && store.pipelineResult?.notices == ["Merge is switched off, so this sync took no merge step past that"])
        check("…while gh labels #6, #5 low/low and #2 cleared",
              writes.filter { $0.contains("/issues/") } == [
                  "api -X POST repos/acme/app/issues/6/labels -f labels[]=risk:low",
                  "api -X POST repos/acme/app/issues/6/labels -f labels[]=complexity:low",
                  "api -X POST repos/acme/app/issues/5/labels -f labels[]=risk:low",
                  "api -X POST repos/acme/app/issues/5/labels -f labels[]=complexity:low",
                  "api -X POST repos/acme/app/issues/2/labels -f labels[]=diplomat:cleared",
              ])
        check("…claude rates four, and Linear labels ENG-1 low/low",
              log("claude.log").count == 4 && linearWrites() == ["AddLabel", "AddLabel"])
        let fixKey = "issues:acme/app#5", linearKey = "issues:linear:ENG-1"
        let effects = store.pipelineResult?.effects.map { "\($0.url) \($0.author)" } ?? []
        print("  sync 1 effects: \(effects)")
        check("…#6's fix is emitted under mallory, banned since the core read the list, and not queued",
              effects.contains("https://github.com/acme/app/issues/6 mallory") && ids() == [fixKey, linearKey].sorted()
                  && store.loadPipelineAttempts().keys.allSatisfy { !$0.hasSuffix("/issues/6") })
        check("…the Linear fix's the Linear scope and the pipeline's fix block",
              prompt(linearKey).contains("Take Linear issue ENG-1 (https://linear.app/acme/issue/ENG-1), fix it in acme/app")
                  && prompt(linearKey).contains("Header is blue, should be purple.")
                  && prompt(linearKey).contains("THIS ISSUE IS ON DIPLOMAT'S FAST TRACK"))
        check("…the GitHub fix's the pipeline's fix block, no Linear scope",
              prompt(fixKey).contains("THIS ISSUE IS ON DIPLOMAT'S FAST TRACK") && !prompt(fixKey).contains("Linear issue"))
        let lines = Array(feed().dropFirst(feedBefore))
        print("  sync 1 feed:\n" + lines.map { "    \($0)" }.joined(separator: "\n"))
        check("…and the feed has the notice and each ask once",
              lines.count == 3 && lines.filter { $0.hasPrefix("auto pipeline-fix ") }.count == 2
                  && lines.contains("auto pipeline-notice Merge is switched off, so this sync took no merge step past that"))

        let queued = ids(), attempts = store.loadPipelineAttempts(), fed = feed().count
        await sync()
        check("sync 2, nothing changed: gh, Linear and claude are only read",
              ghWrites().isEmpty && linearWrites().isEmpty && log("claude.log").isEmpty
                  && !log("gh.log").isEmpty)
        check("…nothing more is queued or attempted, and the feed is told nothing",
              ids() == queued && store.loadPipelineAttempts() == attempts && feed().count == fed)
        let six = item(6)
        print("  #6 as shown: \(six.map(PipelineTint.hover) ?? "(not read)")")
        check("…#6 is held for the ban, said as a hold, and Start fix refuses it with that hold",
              six?.hold == "@mallory is on the prompt-injection ban list"
                  && six.map(PipelineTint.hover)?.contains("\nHeld: @mallory is on the prompt-injection ban list\n") == true
                  && six.map { store.pipelineFixEffect(for: $0) == nil && store.startPipelineFix($0) == $0.hold } == true
                  && ids() == queued)

        let error = "Something went wrong while executing your query."
        assign(5, ["carol"])
        patch { $0["readErrors"] = error }
        await sync()
        print("  sync 3 notices: \(store.pipelineResult?.notices ?? []), unread: \(store.pipelineResult?.unread ?? [])")
        print("  #2 as shown: \(item(2, "pull").map(PipelineTint.hover) ?? "(not read)")")
        check("sync 3, acme/app read with an error and #5 assigned to carol: the root is unread, no ask is withdrawn",
              store.pipelineResult?.unread == ["acme/app"] && item(5)?.writable == false
                  && ids() == queued && ghWrites().isEmpty
                  && Array(feed().dropFirst(fed)) == ["auto pipeline-notice acme/app was read in part: \(error)"])
        check("…and #2 says why it waits", item(2, "pull")?.hold == "acme/app was read only in part"
              && item(2, "pull").map(PipelineTint.hover)?.contains("\nHeld: acme/app was read only in part\n") == true)

        patch { $0["readErrors"] = nil }
        let read = feed().count
        await sync()
        let dropped = Array(feed().dropFirst(read))
        print("  sync 4 feed: \(dropped)")
        check("sync 4, read whole again: #5's queued fix is withdrawn, ENG-1's kept",
              ghWrites().isEmpty && store.pipelineResult?.unread == [] && ids() == [linearKey]
                  && dropped == ["panel queue-drop Issues · #5 · deep - the pipeline no longer owes it, not run"])

        assign(5, [])
        await sync()
        let five = item(5)
        check("sync 5, #5 unassigned: its fix is owed again, and not queued while its attempt cools down",
              store.pipelineResult?.effects.contains { $0.url == "https://github.com/acme/app/issues/5" } == true
                  && ids() == [linearKey])
        check("…Start fix queues it by hand",
              five.map { store.startPipelineFix($0) } == .some(nil) && ask(fixKey)?.byHand == true
                  && ids() == [fixKey, linearKey].sorted())
        let off = feed().count
        truncate()
        store.pipelineFix = false
        let withdrawn = Array(feed().dropFirst(off))
        print("  Open fix PRs off: \(withdrawn)")
        check("Open fix PRs off, before any sync: the fix the sync queued is withdrawn, the one Start fix queued kept",
              ids() == [fixKey] && log("gh.log").isEmpty
                  && withdrawn == ["panel queue-drop Issues · ENG-1 · deep - the pipeline no longer owes it, not run"])
        await sync()
        check("sync 6: no fix is emitted, and the Start fix stays while #5 is fixable",
              store.pipelineResult?.effects.isEmpty == true && ids() == [fixKey]
                  && store.pipelineResult?.fixable.contains("https://github.com/acme/app/issues/5") == true
                  && feed().count == off + 1)

        store.pipelineMerge = true
        await sync()
        print("  sync 7 gh writes: \(ghWrites())")
        check("sync 7, merge switched back on: #2 is merged at the head it was cleared at",
              ghWrites() == ["pr merge 2 -R acme/app --admin --squash --match-head-commit " + String(repeating: "a2", count: 20)]
                  && feed().last == "auto pipeline-merge #2: merged a2a2a2a with --admin --squash")

        patch { github in
            let later = github["later"] as? [String: Any] ?? [:]
            for key in ["issues", "prs"] {
                github[key] = (github[key] as? [Any] ?? []) + (later[key] as? [Any] ?? [])
            }
        }
        await sync()
        let three = item(3, "pull")
        print("  sync 8 gh writes: \(ghWrites())")
        print("  #3 as shown: \(three.map(PipelineTint.hover) ?? "(not read)")")
        check("sync 8, op's draft #3 fixing #7: re-rated, cleared and marked ready, not merged",
              log("claude.log").count == 1
                  && ghWrites() == ["api -X POST repos/acme/app/issues/3/labels -f labels[]=diplomat:cleared",
                                    "pr ready 3 -R acme/app"]
                  && three?.state == "open" && three?.hold == "marked ready for review; merged at a later sync"
                  && three.map(PipelineTint.hover)?.contains("\nHeld: marked ready for review; merged at a later sync\n") == true)
        await sync()
        print("  sync 9 gh writes: \(ghWrites())")
        check("sync 9: #3 is merged at the head it was marked ready at",
              ghWrites() == ["pr merge 3 -R acme/app --admin --squash --match-head-commit " + String(repeating: "a3", count: 20)]
                  && feed().last == "auto pipeline-merge #3: merged a3a3a3a with --admin --squash")

        patch { github in
            let more = github["more"] as? [String: Any] ?? [:]
            github["issues"] = (github["issues"] as? [Any] ?? []) + (more["issues"] as? [Any] ?? [])
        }
        let linearState = harness.appendingPathComponent("linear-state.json")
        try? Data(#"{"later": true}"#.utf8).write(to: linearState)
        store.pipelineFix = true
        await sync()
        let eightKey = "issues:acme/app#8", nineKey = "issues:acme/app#9", eng2Key = "issues:linear:ENG-2"
        check("sync 10, Open fix PRs back on, low/low #8, #9 and ENG-2 read: their fixes are queued",
              ids() == [fixKey, eightKey, nineKey, eng2Key].sorted())

        patch { github in
            var issues = github["issues"] as? [[String: Any]] ?? []
            for i in issues.indices where issues[i]["number"] as? Int == 8 { issues[i]["state"] = "CLOSED" }
            github["issues"] = issues
        }
        try? Data(#"{"later": true, "done": ["ENG-2"]}"#.utf8).write(to: linearState)
        let closed = feed().count
        await sync()
        let gone = Array(feed().dropFirst(closed)).sorted()
        print("  sync 11 feed: \(gone)")
        check("sync 11, #8 closed on GitHub and ENG-2 completed on Linear: their queued fixes are withdrawn",
              store.pipelineResult?.unread == [] && ids() == [fixKey, nineKey].sorted()
                  && gone == ["panel queue-drop Issues · #8 · deep - the pipeline no longer owes it, not run",
                              "panel queue-drop Issues · ENG-2 · deep - the pipeline no longer owes it, not run"])

        patch { $0["readErrors"] = error }
        await sync()
        check("sync 12, acme/app read with an error: nothing is withdrawn",
              store.pipelineResult?.unread == ["acme/app"] && ids() == [fixKey, nineKey].sorted())
        let unreadOff = feed().count
        store.pipelineFix = false
        check("…Open fix PRs off: #9's fix is withdrawn at once though its root is unread, the Start fix kept",
              ids() == [fixKey] && Array(feed().dropFirst(unreadOff))
                  == ["panel queue-drop Issues · #9 · deep - the pipeline no longer owes it, not run"])
        await sync()
        check("sync 13, still unread: nothing comes back", store.pipelineResult?.unread == ["acme/app"] && ids() == [fixKey])
        patch { $0["readErrors"] = nil }

        patch { github in
            let extra = github["extra"] as? [String: Any] ?? [:]
            github["issues"] = (github["issues"] as? [Any] ?? []) + (extra["issues"] as? [Any] ?? [])
        }
        try? Data(#"{"later": true, "done": ["ENG-2"], "extra": true}"#.utf8).write(to: linearState)
        store.pipelineFix = true
        await sync()
        let tenKey = "issues:acme/app#10", elevenKey = "issues:acme/app#11", eng3Key = "issues:linear:ENG-3"
        let owing = [fixKey, tenKey, elevenKey, eng3Key].sorted(), left = [fixKey, elevenKey, eng3Key].sorted()
        check("sync 14, low/low #10, #11 and ENG-3 read: their fixes are queued, and may start",
              ids() == owing && store.drainableTasks.map(\.id).sorted() == owing && ask(eng3Key)?.repo == "acme/app")

        func held(_ n: Int) async -> Bool {
            for _ in 0..<1200 {
                if (try? String(contentsOf: harness.appendingPathComponent("held"), encoding: .utf8)) == "\(n)" { return true }
                try? await Task.sleep(nanoseconds: 50_000_000)
            }
            return false
        }
        func release(_ n: Int) { try? Data("\(n)".utf8).write(to: harness.appendingPathComponent("go")) }
        store.pipelineEnabled = false
        patch { github in
            var issues = github["issues"] as? [[String: Any]] ?? []
            for i in issues.indices where issues[i]["number"] as? Int == 10 { issues[i]["state"] = "CLOSED" }
            github["issues"] = issues
            github["holdReads"] = 2
        }
        store.pipelineEnabled = true
        check("master off, #10 closed, master on: no queued fix may start before a sync",
              ids() == owing && store.drainableTasks.isEmpty)
        try? await Task.sleep(nanoseconds: 1_100_000_000)
        truncate()
        let back = feed().count
        let syncing = Task { @MainActor in await store.runPipelineSyncOnce() }
        let first = await held(1)
        store.pipelineEnabled = false
        store.pipelineEnabled = true
        await store.runPipelineSyncOnce()
        let again = store.pipelineSyncAgain
        release(1)
        let second = await held(2)
        print("  stale sync applied: queue \(ids()), drainable \(store.drainableTasks.map(\.id)), #10 read: \(item(10) != nil)")
        check("…a sync begun before master went off and on again reads #10 closed, yet withdraws nothing and lets nothing start",
              first && again && second && item(10) == nil && ids() == owing && store.drainableTasks.isEmpty
                  && !store.pipelineJudged && feed().count == back)
        release(2)
        await syncing.value
        let since = Array(feed().dropFirst(back))
        print("  sync begun since: \(since)")
        check("…the sync begun since withdraws #10's fix and lets the rest start",
              ids() == left && store.drainableTasks.map(\.id).sorted() == left && store.pipelineJudged
                  && since == ["panel queue-drop Issues · #10 · deep - the pipeline no longer owes it, not run"])

        store.pinRoots([PRRef.LocalRepo(owner: "acme", repo: "app",
                                        path: harness.appendingPathComponent("checkout").path),
                        PRRef.LocalRepo(owner: "acme", repo: "web",
                                        path: harness.appendingPathComponent("checkout-web").path)])
        let appOld = "pipeline-fix:https://github.com/acme/app/issues/77"
        let linearOld = "pipeline-fix:https://linear.app/acme/issue/ENG-77"
        let webOld = "pipeline-fix:https://github.com/acme/web/issues/78"
        var seeded = store.loadPipelineAttempts()
        for key in [appOld, linearOld, webOld] {
            seeded[key] = ReviewAttempt(requestedAt: "fix", lastDispatchedAt: Date().addingTimeInterval(-2 * 86400),
                                        attempts: 1)
        }
        store.savePipelineAttempts(seeded)
        patch { $0["readErrors"] = error }
        await sync()
        let kept = Set(store.loadPipelineAttempts().keys)
        print("  sync 17 unread: \(store.pipelineResult?.unread ?? []), records: \(kept.sorted())")
        check("sync 17, acme/app read with an error beside acme/web: a lapsed record in acme/app or its Linear team stays, acme/web's goes",
              store.pipelineResult?.unread == ["acme/app"] && kept.isSuperset(of: [appOld, linearOld]) && !kept.contains(webOld))
        patch { $0["readErrors"] = nil }
        await sync()
        let after = Set(store.loadPipelineAttempts().keys)
        check("sync 18, read whole: they go too",
              store.pipelineResult?.unread == [] && after.isDisjoint(with: [appOld, linearOld, webOld]))

        store.pipelineLinearTeamsRaw = "ENG=acme/web"
        let moved = feed().count
        await sync()
        let requeued = Array(feed().dropFirst(moved))
        print("  sync 19 feed: \(requeued), ENG-3 in \(ask(eng3Key)?.repo ?? "-")")
        check("sync 19, Linear's ENG moved to acme/web: ENG-3's queued fix is queued again there",
              ids() == left && ask(eng3Key)?.repo == "acme/web" && prompt(eng3Key).contains("fix it in acme/web")
                  && requeued == ["auto pipeline-fix Issues · ENG-3 · deep queued again: its repo or text changed"])
        let edited = "Typing any letter drops focus."
        try? Data(#"{"later": true, "done": ["ENG-2"], "extra": true, "text": {"ENG-3": "\#(edited)"}}"#.utf8)
            .write(to: linearState)
        await sync()
        check("sync 20, ENG-3 edited on Linear: its queued fix is queued again with the new text",
              ids() == left && ask(eng3Key)?.repo == "acme/web" && prompt(eng3Key).contains(edited)
                  && feed().last == "auto pipeline-fix Issues · ENG-3 · deep queued again: its repo or text changed")

        patch { github in
            let review = github["review"] as? [String: Any] ?? [:]
            for key in ["issues", "prs"] {
                github[key] = (github[key] as? [Any] ?? []) + (review[key] as? [Any] ?? [])
            }
        }
        await sync()
        let twelveKey = "review:acme/app#12", twelve = "https://github.com/acme/app/pull/12"
        let owedReview = "pipeline-review:\(twelve)", elevenFix = "pipeline-fix:https://github.com/acme/app/issues/11"
        func owes() -> [String] {
            store.pipelineResult?.effects.map(\.key).filter { [owedReview, elevenFix].contains($0) }.sorted() ?? []
        }
        check("sync 21, op's PR #12 fixing #13, fast-tracked and not clean at its head: its review is queued",
              ids() == (left + [twelveKey]).sorted() && owes() == [elevenFix, owedReview])
        let called = feed().count
        let cancelLines = [elevenKey, twelveKey].map { key in
            "panel queue-cancel \(store.queuedTasks.first { $0.id == key }?.job.label ?? key) — cancelled, not run"
        }
        store.cancelRequestedWork(elevenKey)
        store.cancelRequestedWork(twelveKey)
        print("  cancelled: \(Array(feed().dropFirst(called)))")
        check("…Cancel on #11's queued fix and #12's queued review takes both off the queue",
              ids() == [fixKey, eng3Key].sorted() && Array(feed().dropFirst(called)) == cancelLines)
        // As if the hours past every retry backoff had gone by.
        var aged = store.loadPipelineAttempts()
        for key in [elevenFix, owedReview] {
            aged[key]?.lastDispatchedAt.addTimeInterval(-ReviewReconcile.retryMaxBackoff)
        }
        store.savePipelineAttempts(aged)
        await sync()
        await sync()
        let records = [elevenFix, owedReview].map { key in
            store.loadPipelineAttempts()[key].map { "\($0.requestedAt) \($0.attempts) concluded \($0.concludedAt != nil)" }
        }
        print("  syncs 22, 23 records: \(records)")
        check("syncs 22 and 23, past every backoff, still owing both: neither is queued again",
              ids() == [fixKey, eng3Key].sorted() && owes() == [elevenFix, owedReview]
                  && Array(feed().dropFirst(called)) == cancelLines)
        let pushedHead = String(repeating: "c3", count: 20)
        patch { github in
            var prs = github["prs"] as? [[String: Any]] ?? []
            for i in prs.indices where prs[i]["number"] as? Int == 12 { prs[i]["head"] = pushedHead }
            github["prs"] = prs
        }
        await sync()
        let pushedLines = Array(feed().dropFirst(called + cancelLines.count))
        print("  sync 24 feed: \(pushedLines)")
        check("sync 24, a new head pushed to #12: its review is asked for again, at that head",
              ids() == [fixKey, eng3Key, twelveKey].sorted()
                  && store.loadPipelineAttempts()[owedReview].map { $0.requestedAt == pushedHead && $0.attempts == 1 } == true
                  && pushedLines.filter { $0.hasPrefix("auto pipeline-review ") }.count == 1)
        let remaining = ids()

        store.pipelineEnabled = false
        check("master off: none of the queued asks may start",
              ids() == remaining && store.drainableTasks.isEmpty)
        store.requestedWork = []
        store.queuedTasks = []
        store.savePipelineAttempts([:])
        let fedOff = feed().count
        truncate()
        await store.runPipelineSyncOnce()
        if let last = store.pipelineResult { await store.applyPipeline(last) }
        check("…and nothing syncs or is queued", log("gh.log").isEmpty && ids().isEmpty
              && store.loadPipelineAttempts().isEmpty && feed().count == fedOff)
    }
}
