import Foundation
import DiplomatCore

// The Diplomacy Network gate. PARITY: every case here is mirrored, in this order and
// under these names, by diplomat-platform/linux/tests/test_network.py; the resolver's
// network scenarios are in test_agent_state.py's CASES and run through both twins by
// test_agent_state_parity.py.

private typealias Gate = AgentDispatchGate
private typealias Seen = AgentState.NetworkTask

private let networkTask = "github.com/o/r#review:pr-337@octocat"

private func same(_ got: Observation<[String: Seen]>, _ want: [String: Seen]?,
                  _ reason: String = "") -> Bool {
    got.value == want && got.reason == reason
}

/// Whether two request bodies are the same JSON. `NSDictionary.isEqual(to:)` does not
/// say so of a number under swift-corelibs-foundation.
private func sameBody(_ got: [String: Any], _ want: [String: Any]) -> Bool {
    func wire(_ body: [String: Any]) -> Data? {
        try? JSONSerialization.data(withJSONObject: body, options: [.sortedKeys])
    }
    guard let got = wire(got), let want = wire(want) else { return false }
    return got == want
}

/// A README-shaped snapshot: one pool, a live run for `networkTask`, four offers.
private let fullSnapshot = """
{ "updatedAt": 1794000300, "daemon": { "pid": 4321, "startedAt": 1794000000 },
  "identity": { "pk": "aaaabbbbccccdddd", "onion": "abc.onion" },
  "transport": { "state": "ready", "detail": "" },
  "docker": { "state": "building", "image": "dn:1", "detail": "layer 3" },
  "model": { "state": "missing", "detail": "no credential" },
  "admit": { "slots": 2, "at": 1794000290, "reason": "" },
  "pools": [ { "id": "github.com/o/r", "path": "/w/r", "identity": "octocat", "hash": "h1",
      "left": false,
      "members": [ { "pk": "aaaabbbbccccdddd", "self": true, "maxAcceptedH": 24,
                     "lastSeen": 1794000299, "reachable": true },
                   { "pk": "eeeeffff00001111", "self": false, "maxAcceptedH": 12,
                     "lastSeen": 1794000200, "reachable": false } ],
      "tasks": [ { "taskId": "github.com/o/r#issues:issue-9@octocat", "kind": "issues",
                   "item": "issue-9", "title": "Fix #9", "identity": "octocat", "hours": 12,
                   "state": "claimed", "offeredBy": ["aaaabbbbccccdddd"], "offeredHere": true,
                   "executor": "aaaabbbbccccdddd", "executorHere": true,
                   "claimedAt": 1794000100, "leaseUntil": 1794007300, "deadline": 1794043300 } ] } ],
  "runs": [ { "runId": "run-1", "taskId": "github.com/o/r#review:pr-337@octocat",
              "pool": "github.com/o/r", "peer": "eeeeffff00001111", "container": "dn-h1-p1",
              "state": "running", "startedAt": 1794000150, "endedAt": 0, "exit": 0, "log": "/l/1" },
            { "runId": "run-0", "taskId": "github.com/o/r#audit:job-0b77ab9a731995c3@octocat",
              "pool": "github.com/o/r", "peer": "eeeeffff00001111", "container": "dn-h1-p1",
              "state": "finished", "startedAt": 1794000000, "endedAt": 1794000100, "exit": 0,
              "log": "/l/0" } ],
  "offers": [ { "taskId": "github.com/o/r#review:pr-337@octocat", "pool": "github.com/o/r",
                "kind": "review", "item": "pr-337", "title": "Auto · Review · #337",
                "state": "claimed", "reason": "second attempt", "offeredAt": 1794000050,
                "executor": "eeeeffff00001111", "attempt": 1, "requests": 4, "refused": 1 },
              { "taskId": "github.com/o/r#issues:issue-9@octocat", "state": "claimed",
                "executor": "9999888877776666", "attempt": 2, "requests": 0, "refused": 0 },
              { "taskId": "github.com/o/r#audit:job-0b77ab9a731995c3@octocat", "state": "done",
                "executor": "aaaabbbbccccdddd", "attempt": 1, "requests": 9, "refused": 0,
                "outcome": { "ok": true, "summary": "clean", "usd": 0.42, "tokens": 12345,
                             "runner": "claude", "model": "opus" }, "endedAt": 1794000100 },
              { "taskId": "github.com/o/r#conflicts:pr-5@octocat", "state": "pooled",
                "executor": "", "executorHere": false, "attempt": 1, "requests": 0,
                "refused": 0 } ] }
"""

func networkSmoke() throws {
    section("network: the dispatch gate")
    let flags = [false, true]
    for source in [Gate.Source.panel, .auto] {
        for banned in flags { for onPR in flags { for outside in flags {
            for full in flags { for paused in flags { for disk in flags { for broke in flags {
                let got = Gate.decide(source: source, banned: banned, agentOnPR: onPR,
                                      atCapacity: full, unaffordable: broke,
                                      outsideAllowlist: outside, lowDisk: disk,
                                      paused: paused, network: true)
                let want: Gate.Verdict = banned ? .banned : outside ? .notAllowed
                    : onPR ? .inFlight : source == .auto && paused ? .atCapacity : .proceed
                check(got == want, "network gate \(source.rawValue) banned=\(banned) "
                      + "onPR=\(onPR) outside=\(outside) full=\(full) paused=\(paused) "
                      + "disk=\(disk) broke=\(broke): \(got)")
                // Off the network the two halves of capacity are one hold.
                let split = Gate.decide(source: source, banned: banned, agentOnPR: onPR,
                                        atCapacity: full, unaffordable: broke,
                                        outsideAllowlist: outside, lowDisk: disk,
                                        paused: paused, network: false)
                let folded = Gate.decide(source: source, banned: banned, agentOnPR: onPR,
                                         atCapacity: full || paused, unaffordable: broke,
                                         outsideAllowlist: outside, lowDisk: disk)
                check(split == folded, "a local job is held by either half of capacity")
            } } } }
        } } }
    }
    func auto(lowDisk: Bool = false, full: Bool = false, paused: Bool = false,
              broke: Bool = false, network: Bool = true) -> Gate.Verdict {
        Gate.decide(source: .auto, banned: false, agentOnPR: false, atCapacity: full,
                    unaffordable: broke, lowDisk: lowDisk, paused: paused, network: network)
    }
    check(auto(lowDisk: true) == .proceed, "a low disk holds no network job")
    check(auto(full: true) == .proceed, "a full cap holds no network job")
    check(auto(broke: true) == .proceed, "a spent budget holds no network job")
    check(auto(paused: true) == .atCapacity, "a paused item still holds a network job")
    check(auto(lowDisk: true, full: true, paused: true, broke: true) == .atCapacity,
          "a paused network job is held as paused, whatever else is true of the machine")
    check(auto(lowDisk: true, network: false) == .lowDisk
          && auto(full: true, network: false) == .atCapacity
          && auto(paused: true, network: false) == .atCapacity
          && auto(broke: true, network: false) == .unaffordable,
          "off the network every hold still holds")
    check(Gate.decide(source: .panel, banned: false, agentOnPR: false, atCapacity: true,
                      paused: true, network: true) == .proceed,
          "the operator's own click is never paused")

    section("network: what to offer")
    func offer(_ verb: String, own: Bool = false, number: Int? = 337, key: String = "o/r",
               label: String = "Auto · Review · #337", prompt: String = "p",
               source: Gate.Source = .auto, forced: Bool = false, verdict: Bool = false,
               markReady: Bool = false, noPRs: Bool = false,
               readOnly: Bool = false) -> NetworkOffer.Decision {
        NetworkOffer.from(verb: verb, ownPR: own, number: number, repoKey: key,
                          label: label, prompt: prompt, source: source, forced: forced,
                          verdict: verdict, markReady: markReady, noPRs: noPRs,
                          readOnly: readOnly)
    }
    func made(_ d: NetworkOffer.Decision) -> NetworkOffer.Offer? {
        if case .offer(let o) = d { return o }
        return nil
    }
    func shape(_ d: NetworkOffer.Decision) -> String {
        guard let o = made(d) else { return "refused" }
        let options = o.options.sorted { $0.key < $1.key }.map { "\($0.key)=\($0.value)" }
        return "\(o.kind) \(o.item) [\(options.joined(separator: ","))]"
    }
    check(offer("review-req", verdict: true) == .offer(NetworkOffer.Offer(
        pool: "github.com/o/r", kind: "review", options: ["verdict": true], item: "pr-337",
        title: "Auto · Review · #337", prompt: "p", now: false)),
          "a requested review of someone else's PR, whole")
    check(shape(offer("review-req")) == "review pr-337 [verdict=false]",
          "a review whose policy forbids a verdict offers none")
    check(shape(offer("review-req", verdict: true, markReady: true, noPRs: true,
                      readOnly: true)) == "review pr-337 [verdict=true]",
          "a kind carries its own option alone")
    check(shape(offer("review", own: true, verdict: true, markReady: true))
          == "review-own pr-337 [markReady=true]", "the operator's own PR is review-own")
    check(shape(offer("review", own: true)) == "review-own pr-337 [markReady=false]")
    check(shape(offer("review")) == "review pr-337 [verdict=false]",
          "someone else's PR is review")
    check(shape(offer("review-reply", markReady: true)) == "review-own pr-337 [markReady=true]",
          "a reply to reviews is always on the operator's own PR")
    check(shape(offer("comms-review", verdict: true)) == "review pr-337 [verdict=true]")
    check(shape(offer("comms-review", own: true)) == "review-own pr-337 [markReady=false]")
    check(shape(offer("conflicts", verdict: true)) == "conflicts pr-337 []")
    check(shape(offer("issues", number: 12, noPRs: true)) == "issues issue-12 [noPRs=true]")
    check(shape(offer("comms-fix", number: 12)) == "issues issue-12 [noPRs=false]")
    check(shape(offer("issues", number: nil, prompt: "abc"))
          == "issues job-ba7816bf8f01cfea [noPRs=false]", "a sweep is named by its prompt")
    check(shape(offer("audit", number: nil, prompt: "Audit the repository end to end.",
                      readOnly: true)) == "audit job-0b77ab9a731995c3 [readOnly=true]")
    check(shape(offer("audit", number: 5, prompt: "abc")) == "audit job-ba7816bf8f01cfea [readOnly=false]",
          "an audit is pinned to no pull request, whatever number rides along")
    check(shape(offer("investigate", number: nil, prompt: "")) == "investigate job-e3b0c44298fc1c14 []")
    check(shape(offer("comms-investigate", number: 7, prompt: "abc"))
          == "investigate job-ba7816bf8f01cfea []")
    let long = String(repeating: "Review PR #337 in o/r. ", count: 12) + "żółć ✓"
    check(NetworkOffer.item(kind: "audit", number: nil, prompt: long) == "job-ee5f1d37b928031d"
          && NetworkOffer.item(kind: "audit", number: nil,
                               prompt: String(repeating: "x", count: 55)) == "job-d5e285683cd4efc0"
          && NetworkOffer.item(kind: "audit", number: nil,
                               prompt: String(repeating: "x", count: 56)) == "job-04c26261370ee754"
          && NetworkOffer.item(kind: "audit", number: nil,
                               prompt: String(repeating: "x", count: 64)) == "job-7ce100971f64e700",
          "the job name is SHA-256 of the prompt, across every padding boundary")
    check(made(offer("review-req", source: .panel))?.now == true, "a panel job runs now")
    check(made(offer("review-req", source: .auto))?.now == false, "an automatic job waits its turn")
    check(made(offer("review-req", source: .auto, forced: true))?.now == true, "a forced job runs now")
    check(made(offer("review-req", key: "O/R"))?.pool == "github.com/o/r", "a pool id is lowercase")
    check(made(offer("review-req", key: "gitlab.example.com/Group/Sub/Repo"))?.pool
          == "gitlab.example.com/group/sub/repo", "a GitLab key is its own pool id")
    for key in ["", "norepo", "o//r", "/r", "o/"] {
        check(offer("review-req", key: key) == .refused("no repository to offer it into"),
              "`\(key)` names no repository")
    }
    check(offer("nudge") == .refused("the network runs no nudge jobs"), "an unknown verb is refused")
    check(made(offer("audit", number: nil, label: "", prompt: "abc"))?.title
          == "audit job-ba7816bf8f01cfea", "an unlabelled job is titled by what it is")
    let body = made(offer("review-req", source: .panel, verdict: true))?.body ?? [:]
    check(sameBody(body, [
        "pool": "github.com/o/r", "kind": "review", "item": "pr-337",
        "title": "Auto · Review · #337", "prompt": "p", "now": true,
        "options": ["verdict": true]]), "the /offer body: \(body)")
    check(made(offer("conflicts"))?.body["options"] == nil, "a kind with no option sends none")

    section("network: the linked pools")
    let roots = [PRRef.LocalRepo(owner: "o", repo: "r", path: "/w/r"),
                 PRRef.LocalRepo(owner: "O", repo: "R", path: "/w/dup"),
                 PRRef.LocalRepo(owner: "g/sub", repo: "p", path: "/w/p", host: "GitLab.example.com"),
                 PRRef.LocalRepo(owner: "x", repo: "y", path: "/w/y")]
    let githubOnly = NetworkPools.linked(roots: roots, identities: ["github.com": " Octocat "])
    check(githubOnly == [
        NetworkPools.Pool(id: "github.com/o/r", path: "/w/r", forge: "github", identity: "octocat"),
        NetworkPools.Pool(id: "github.com/x/y", path: "/w/y", forge: "github", identity: "octocat")],
          "one pool per repository, the first root winning, none without an identity: \(githubOnly)")
    let both = NetworkPools.linked(roots: roots, identities: ["github.com": "octocat",
                                                              "gitlab.example.com": "Me"])
    check(both.map(\.id) == ["github.com/o/r", "gitlab.example.com/g/sub/p", "github.com/x/y"]
          && both[1].forge == "gitlab" && both[1].identity == "me")
    check(NetworkPools.linked(roots: roots, identities: ["github.com": "  "]).isEmpty,
          "a blank identity is none")
    check(NetworkPools.body(githubOnly) == ["pools": [
        ["id": "github.com/o/r", "path": "/w/r", "forge": "github", "identity": "octocat"],
        ["id": "github.com/x/y", "path": "/w/y", "forge": "github", "identity": "octocat"]]],
          "the /pools body")

    section("network: admit")
    func admit(limit: Int = 3, running: Int = 1, lowDisk: Bool = false,
               affordable: Bool = true, autoRun: Bool = true) -> NetworkAdmit.Answer {
        NetworkAdmit.slots(limit: limit, running: running, lowDisk: lowDisk,
                           affordable: affordable, autoRun: autoRun)
    }
    check(admit() == NetworkAdmit.Answer(slots: 2, reason: ""), "the free bays of the cap")
    check(admit(running: 0).slots == 3 && admit(running: 3).slots == 0)
    check(admit(running: 5) == NetworkAdmit.Answer(slots: 0, reason: ""), "never below zero")
    check(admit(lowDisk: true) == NetworkAdmit.Answer(slots: 0, reason: "disk"))
    check(admit(affordable: false) == NetworkAdmit.Answer(slots: 0, reason: "budget"))
    check(admit(autoRun: false) == NetworkAdmit.Answer(slots: 0, reason: "paused"))
    check(admit(lowDisk: true, affordable: false, autoRun: false).reason == "disk",
          "the disk is named first")
    check(admit(affordable: false, autoRun: false).reason == "budget",
          "then the budget, then the pause")
    check(sameBody(admit().body, ["slots": 2])
          && sameBody(admit(lowDisk: true).body, ["slots": 0, "reason": "disk"]),
          "the /admit body")

    section("network: settings and routes")
    check(NetworkSettings.enabledKey == "networkEnabled"
          && NetworkSettings.requiredMinimumHKey == "networkRequiredMinimumH"
          && NetworkSettings.maximumAcceptedHKey == "networkMaximumAcceptedH")
    let hours: [(Double?, Int)] = [(nil, 12), (11, 12), (12, 12), (48, 48), (13.5, 12),
                                   (0, 12), (-5, 12), (719, 719), (720, 720), (721, 720),
                                   (1e30, 720), (.infinity, 12), (.nan, 12)]
    for (stored, want) in hours {
        check(NetworkSettings.hours(stored) == want, "hours(\(String(describing: stored))) is \(want)")
    }
    check(NetworkSettings.hoursFloor == 12 && NetworkSettings.hoursCeiling == 720,
          "the daemon's floor and ceiling")
    check([NetworkRoute.health, NetworkRoute.state, NetworkRoute.pools, NetworkRoute.admit,
           NetworkRoute.offer, NetworkRoute.withdraw, NetworkRoute.invite, NetworkRoute.join,
           NetworkRoute.leave, NetworkRoute.stopRun]
          == ["health", "state", "pools", "admit", "offer", "withdraw", "invite", "join",
              "leave", "stop-run"])
    check(NetworkRoute.withdrawBody(task: networkTask, reason: NetworkRoute.withdrawMerged)
          == ["taskId": networkTask, "reason": "merged"]
          && NetworkRoute.withdrawForgotten == "forgotten")
    check(NetworkRoute.withdrawStopped == "stopped"
          && NetworkRoute.withdrawNotBooked == "not booked"
          && NetworkRoute.withdrawSwitchedOff == "switched off",
          "the reasons an applet withdraws an offer for")
    check(sameBody(NetworkRoute.inviteBody(pool: "github.com/o/r"), ["pool": "github.com/o/r"])
          && sameBody(NetworkRoute.inviteBody(pool: "github.com/o/r", ttlSecs: 600),
                      ["pool": "github.com/o/r", "ttlSecs": 600]), "the /invite body")
    check(NetworkRoute.joinBody(invite: "tok") == ["invite": "tok"]
          && NetworkRoute.joinBody(pool: "github.com/o/r") == ["pool": "github.com/o/r"]
          && NetworkRoute.leaveBody(pool: "github.com/o/r") == ["pool": "github.com/o/r"]
          && NetworkRoute.stopRunBody(run: "run-1") == ["runId": "run-1"])

    section("network: the snapshot")
    guard let snap = NetworkSnapshot.parse(Data(fullSnapshot.utf8)) else {
        check(false, "the README's snapshot decodes")
        return
    }
    check(snap.updatedAt == 1794000300 && snap.pid == 4321 && snap.startedAt == 1794000000
          && snap.pk == "aaaabbbbccccdddd" && snap.onion == "abc.onion")
    check(snap.transport.state == "ready" && snap.transport.detail == ""
          && snap.docker.state == "building" && snap.docker.image == "dn:1"
          && snap.docker.detail == "layer 3"
          && snap.model.state == "missing" && snap.model.detail == "no credential"
          && snap.admit.slots == 2 && snap.admit.at == 1794000290 && snap.admit.reason == "")
    check(snap.pools.count == 1 && snap.pools[0].id == "github.com/o/r"
          && snap.pools[0].path == "/w/r" && snap.pools[0].identity == "octocat"
          && snap.pools[0].hash == "h1" && !snap.pools[0].left)
    let left = NetworkSnapshot.parse(Data("""
        {"pools": [{"id": "a", "left": true}, {"id": "b"}, {"id": "c", "left": 1}]}
        """.utf8))
    check(left?.pools.map(\.left) == [true, false, false],
          "a pool is left only on the daemon's word")
    let members = snap.pools[0].members
    check(members.map(\.pk) == ["aaaabbbbccccdddd", "eeeeffff00001111"]
          && members.map(\.isSelf) == [true, false]
          && members.map(\.maxAcceptedH) == [24, 12]
          && members.map(\.lastSeen) == [1794000299, 1794000200]
          && members.map(\.reachable) == [true, false])
    let pooled = snap.pools[0].tasks
    check(pooled.count == 1 && pooled[0].taskId == "github.com/o/r#issues:issue-9@octocat"
          && pooled[0].kind == "issues" && pooled[0].item == "issue-9"
          && pooled[0].title == "Fix #9" && pooled[0].identity == "octocat"
          && pooled[0].hours == 12 && pooled[0].state == "claimed"
          && pooled[0].offeredBy == ["aaaabbbbccccdddd"] && pooled[0].offeredHere
          && pooled[0].executor == "aaaabbbbccccdddd" && pooled[0].executorHere
          && pooled[0].claimedAt == 1794000100 && pooled[0].leaseUntil == 1794007300
          && pooled[0].deadline == 1794043300)
    let ran = snap.runs
    check(ran.map(\.runId) == ["run-1", "run-0"] && ran[0].taskId == networkTask
          && ran[0].pool == "github.com/o/r" && ran[0].peer == "eeeeffff00001111"
          && ran[0].container == "dn-h1-p1" && ran[0].state == "running"
          && ran[0].startedAt == 1794000150 && ran[0].endedAt == 0 && ran[0].exit == 0
          && ran[0].log == "/l/1" && ran[1].endedAt == 1794000100)
    let offered = snap.offers ?? []
    check(offered.count == 4 && offered[0].taskId == networkTask
          && offered[0].state == "claimed" && offered[0].executor == "eeeeffff00001111"
          && offered[0].attempt == 1 && offered[0].requests == 4 && offered[0].refused == 1
          && offered[0].outcome == nil && offered[0].endedAt == nil && offered[1].attempt == 2)
    check(offered[0].pool == "github.com/o/r" && offered[0].kind == "review"
          && offered[0].item == "pr-337" && offered[0].title == "Auto · Review · #337"
          && offered[0].reason == "second attempt" && offered[0].offeredAt == 1794000050
          && offered[0].executorHere == nil && offered[3].executorHere == false,
          "what an offer row carries, and no word on where it runs is not a no")
    check(offered[1].pool == "" && offered[1].kind == "" && offered[1].item == ""
          && offered[1].title == "" && offered[1].reason == "" && offered[1].offeredAt == nil,
          "an offer row that carries none of it")
    let outcome = offered[2].outcome
    check(outcome?.ok == true && outcome?.summary == "clean" && outcome?.usd == 0.42
          && outcome?.tokens == 12345 && outcome?.runner == "claude"
          && outcome?.model == "opus" && offered[2].endedAt == 1794000100)
    check(NetworkAdmit.running(snap) == 1 && NetworkAdmit.running(nil) == 0,
          "only a preparing or running run holds a bay")
    let states = NetworkSnapshot.parse(Data("""
        {"runs": [{"runId": "a", "state": "preparing"}, {"runId": "b", "state": "running"},
                  {"runId": "c", "state": "finished"}, {"runId": "d", "state": "failed"},
                  {"runId": "e", "state": "stopped"}]}
        """.utf8))
    check(NetworkAdmit.running(states) == 2)

    let empty = NetworkSnapshot.parse(Data("{}".utf8))
    check(empty != nil && empty?.updatedAt == nil && empty?.pid == nil && empty?.pk == ""
          && empty?.transport.state == "" && empty?.admit.slots == 0 && empty?.admit.at == nil
          && empty?.pools == [] && empty?.runs == [] && empty?.offers == nil,
          "an empty document is a snapshot of defaults, and lists no offers")
    let spoilt = NetworkSnapshot.parse(Data("""
        {"updatedAt": "soon", "daemon": 7, "identity": ["pk"], "transport": "ready",
         "admit": {"slots": true, "at": "now", "reason": 3}, "extra": {"k": 1},
         "pools": [3, {"path": "/no/id"}, {"id": "p", "members": [{"self": true}, {"pk": "k", "self": 1,
                   "reachable": "yes", "maxAcceptedH": "12"}], "tasks": [{"kind": "x"},
                   {"taskId": "t", "offeredBy": ["a", 2], "executorHere": 1, "hours": 12.0}]}],
         "runs": [{"taskId": "t"}, {"runId": "r", "exit": "0", "startedAt": true}],
         "offers": [{"state": "done"}, "x", {"taskId": "t", "attempt": "2", "outcome": {"ok": 1}},
                    {"taskId": "u", "outcome": []}]}
        """.utf8))
    check(spoilt != nil && spoilt?.updatedAt == nil && spoilt?.pid == nil && spoilt?.pk == ""
          && spoilt?.transport.state == "" && spoilt?.admit.slots == 0
          && spoilt?.admit.at == nil && spoilt?.admit.reason == "",
          "a member of the wrong type is its default")
    check(spoilt?.pools.map(\.id) == ["p"]
          && spoilt?.pools[0].members.map(\.pk) == ["k"]
          && spoilt?.pools[0].members[0].isSelf == false
          && spoilt?.pools[0].members[0].reachable == false
          && spoilt?.pools[0].members[0].maxAcceptedH == nil
          && spoilt?.pools[0].tasks.map(\.taskId) == ["t"]
          && spoilt?.pools[0].tasks[0].offeredBy == ["a"]
          && spoilt?.pools[0].tasks[0].executorHere == false
          && spoilt?.pools[0].tasks[0].hours == 12,
          "a row without its identity is dropped, and 1 is not a flag")
    check(spoilt?.runs.map(\.runId) == ["r"] && spoilt?.runs[0].exit == nil
          && spoilt?.runs[0].startedAt == nil)
    check(spoilt?.offers?.map(\.taskId) == ["t", "u"] && spoilt?.offers?[0].attempt == 0
          && spoilt?.offers?[0].outcome?.ok == false && spoilt?.offers?[1].outcome == nil)
    for junk in ["", "[]", "nope", "3", "{\"offers\": [}"] {
        check(NetworkSnapshot.parse(Data(junk.utf8)) == nil, "`\(junk)` is no snapshot")
    }
    check(NetworkSnapshot.parse(nil) == nil)
    check(NetworkSnapshot.parse(Data("{\"offers\": {}}".utf8))?.offers == nil
          && NetworkSnapshot.parse(Data("{\"offers\": []}".utf8))?.offers == [],
          "no offers list is not an empty one")

    section("network: the evidence")
    check(same(NetworkEvidence.tasks(nil), nil, "the daemon did not answer"),
          "a daemon that did not answer is unavailable, never an empty map")
    check(same(NetworkEvidence.tasks(empty), nil, "the snapshot lists no offers"),
          "no offers list is not an empty one")
    check(same(NetworkEvidence.tasks(NetworkSnapshot.parse(Data("{\"offers\": []}".utf8))), [:]),
          "a snapshot naming no offers says there are none")
    check(same(NetworkEvidence.tasks(snap), [
        networkTask: Seen(state: "claimed", executor: "eeeeffff00001111", executorHere: true,
                          reason: "second attempt"),
        "github.com/o/r#issues:issue-9@octocat":
            Seen(state: "claimed", executor: "9999888877776666", executorHere: true),
        "github.com/o/r#audit:job-0b77ab9a731995c3@octocat":
            Seen(state: "done", executor: "aaaabbbbccccdddd", executorHere: true, ok: true),
        "github.com/o/r#conflicts:pr-5@octocat": Seen(state: "pooled")]),
          "here by a live run, by the pool's word, by this machine's own key; and not here")
    let elsewhere = NetworkSnapshot.parse(Data("""
        {"identity": {"pk": "aaaa"},
         "runs": [{"runId": "r", "taskId": "t", "state": "finished"}],
         "offers": [{"taskId": "t", "state": "claimed", "executor": "bbbb"},
                    {"taskId": "u", "state": "done", "executor": "", "outcome": {"ok": false}}]}
        """.utf8))
    check(same(NetworkEvidence.tasks(elsewhere), [
        "t": Seen(state: "claimed", executor: "bbbb"), "u": Seen(state: "done")]),
          "a run that ended here does not put a claim here, and no executor is not this machine")
    // Every road says t runs here and none says u does; the offers say otherwise.
    let told = NetworkSnapshot.parse(Data("""
        {"identity": {"pk": "aaaa"},
         "pools": [{"id": "p", "tasks": [{"taskId": "t", "executorHere": true}]}],
         "runs": [{"runId": "r", "taskId": "t", "state": "running"}],
         "offers": [{"taskId": "t", "state": "claimed", "executor": "aaaa", "executorHere": false},
                    {"taskId": "u", "state": "claimed", "executor": "bbbb", "executorHere": true},
                    {"taskId": "v", "state": "claimed", "executor": "aaaa", "executorHere": 0},
                    {"taskId": "w", "state": "failed", "reason": "the container exited 137"}]}
        """.utf8))
    check(same(NetworkEvidence.tasks(told), [
        "t": Seen(state: "claimed", executor: "aaaa"),
        "u": Seen(state: "claimed", executor: "bbbb", executorHere: true),
        "v": Seen(state: "claimed", executor: "aaaa", executorHere: true),
        "w": Seen(state: "failed", reason: "the container exited 137")]),
          "the offer's own word on where it runs wins, and a word that is no flag is none")

    section("network: what a run resolves to")
    let now: TimeInterval = 1_000_000
    func run(_ id: String = "n1", age: TimeInterval = 60, task: String? = networkTask,
             source: Gate.Source = .auto) -> AgentState.RunRecord {
        AgentState.RunRecord(runID: id, dispatchedAt: now - age, prNumber: 337,
                             prURL: "https://github.com/o/r/pull/337", kind: "review",
                             label: "Auto · Review · #337", source: source.rawValue,
                             network: task)
    }
    func seen(_ tasks: Observation<[String: Seen]>, merged: Set<String> = [],
              live: [String: String] = [:]) -> AgentState.Evidence {
        AgentState.Evidence(processes: .present([:]), sentinels: .present([]),
                            tails: .present([:]), mergedPRs: .present(merged),
                            liveAgents: .present(live), sessions: .present([:]),
                            activity: .present([:]), tokensLeft: .present(true),
                            network: tasks)
    }
    func verdict(_ task: Seen?, age: TimeInterval = 60) -> String {
        let v = AgentState.resolveOne(run(age: age), evidence: seen(.present(
            task.map { [networkTask: $0] } ?? [:])), now: now, deadline: AgentState.runDeadline)
        return "\(v.state.rawValue): \(v.reason)"
    }
    check(verdict(Seen(state: "pooled")) == "starting: in the pool")
    check(verdict(Seen(state: "claimed", executor: "eeeeffff00001111", executorHere: true))
          == "running: running on this machine")
    check(verdict(Seen(state: "claimed", executor: "eeeeffff00001111"))
          == "running: running on eeeeffff")
    check(verdict(Seen(state: "claimed")) == "running: running on the network")
    check(verdict(Seen(state: "done", executor: "eeeeffff00001111", ok: true))
          == "finished: finished on eeeeffff")
    check(verdict(Seen(state: "done", executor: "eeeeffff00001111"))
          == "failed: failed on eeeeffff", "a task reported done but not well has failed")
    check(verdict(Seen(state: "failed")) == "failed: refused by the network")
    check(verdict(Seen(state: "cancelled")) == "failed: withdrawn from the network")
    check(verdict(Seen(state: "failed", reason: "the container exited 137"))
          == "failed: refused by the network: the container exited 137",
          "an offer the network gave up on says how its last attempt ended")
    check(verdict(Seen(state: "cancelled", reason: "merged"))
          == "failed: withdrawn from the network: merged",
          "a withdrawn offer says why")
    check(verdict(Seen(state: "pooled", reason: "x")) == "starting: in the pool"
          && verdict(Seen(state: "claimed", reason: "x")) == "running: running on the network"
          && verdict(Seen(state: "done", ok: true, reason: "x")) == "finished: finished on the network"
          && verdict(Seen(state: "done", reason: "x")) == "failed: failed on the network",
          "a reason is read of a failed or cancelled offer alone")
    check(verdict(Seen(state: "limbo")) == "unknown: the network reports limbo")
    check(verdict(nil, age: 10) == "starting: offered 10s ago, not in the pool yet")
    check(verdict(nil, age: 20) == "starting: offered 20s ago, not in the pool yet"
          && verdict(nil, age: 21) == "failed: the network holds no such offer",
          "an absent offer fails only past the grace a spawn gets")
    let silent = AgentState.resolveOne(
        run(age: 3600), evidence: seen(NetworkEvidence.tasks(nil)), now: now,
        deadline: AgentState.runDeadline)
    check(silent.state == .unknown
          && silent.reason == "the network could not be asked: the daemon did not answer",
          "a daemon that did not answer fails no run: \(silent.reason)")
    let landed = AgentState.resolveOne(
        run(), evidence: seen(.present([networkTask: Seen(state: "pooled")]),
                              merged: ["o/r#337"]), now: now)
    check(landed.state == .merged && landed.reason == "PR #337 is merged",
          "a merged PR still wins first")
    // Five hours claimed, tokens left, the deadline armed: no clock ends a network run.
    let old = AgentState.resolveOne(
        run(age: 5 * 3600), evidence: seen(.present([networkTask: Seen(state: "claimed")])),
        now: now, deadline: AgentState.runDeadline)
    check(old.state == .running && !old.expired && !old.wedged && !old.lapsed && !old.reported)
    check(!AgentState.deadlineApplies(run()) && AgentState.deadlineApplies(run(task: nil)),
          "the deadline never applies to a network run")
    check(!run().runsHere && run(task: nil).runsHere)

    section("network: the projections")
    do {
        // A claimed network run on #337 while the process table shows an agent on that
        // PR: the run adopts nothing, holds no bay and gets no second row.
        let claimed = seen(.present([networkTask: Seen(state: "claimed")]),
                           live: ["o/r#337": "pts/9"])
        let t = AgentState.tick(records: [run()], evidence: claimed, roots: [], now: now,
                                limit: 2, deadline: AgentState.runDeadline)
        check(t.records.map(\.runID) == ["n1"] && t.records[0].tty.isEmpty,
              "no untracked twin, no adopted tty: \(t.records.map(\.runID))")
        check(t.capLoad.isEmpty && t.freeSlots == 2, "a network run holds no bay here")
        check(t.inFlight(item: "o/r#337"), "but its PR is taken")
        check(t.rows.map(\.0.runID) == ["n1"] && t.retirable.isEmpty && t.reapable.isEmpty
              && t.closeOnRetire.isEmpty && t.withdrawable.isEmpty)
        let local = AgentState.tick(records: [run(task: nil)], evidence: claimed, roots: [],
                                    now: now, limit: 2, deadline: AgentState.runDeadline)
        check(local.capLoad == ["n1"] && local.records[0].tty == "pts/9",
              "the same record without a task is a local run")
    }
    for (task, blocks) in [(Seen(state: "pooled"), true), (Seen(state: "claimed"), true),
                           (Seen(state: "limbo"), true), (Seen(state: "done", ok: true), false),
                           (Seen(state: "failed"), false), (Seen(state: "cancelled"), false)] {
        let t = AgentState.tick(records: [run()], evidence: seen(.present([networkTask: task])),
                                roots: [], now: now, limit: 2)
        check(t.inFlight(item: "o/r#337") == blocks && t.retirable.isEmpty == blocks
              && t.capLoad.isEmpty && t.reapable.isEmpty && t.closeOnRetire.isEmpty,
              "\(task.state): in flight \(blocks), retirable \(!blocks)")
    }
    do {
        let down = AgentState.tick(records: [run()], evidence: seen(NetworkEvidence.tasks(nil)),
                                   roots: [], now: now, limit: 2)
        check(down.inFlight(item: "o/r#337") && down.retirable.isEmpty && down.capLoad.isEmpty,
              "an unanswered daemon keeps the PR taken and retires nothing")
        // A finished network run beside a live agent on its PR: that agent was never
        // the run's, so nothing is released to it.
        let done = AgentState.tick(
            records: [run()],
            evidence: seen(.present([networkTask: Seen(state: "done", ok: true)]),
                           live: ["o/r#337": "pts/9"]),
            roots: [], now: now, limit: 2)
        check(done.records.map(\.runID) == ["n1"] && done.retirable.map(\.runID) == ["n1"],
              "nothing is released for a network run: \(done.records.map(\.runID))")
    }
    do {
        func withdrawn(_ tasks: Observation<[String: Seen]>, merged: Bool = true,
                       task: String? = networkTask) -> ([String], String?) {
            let e = seen(tasks, merged: merged ? ["o/r#337"] : [])
            let t = AgentState.tick(records: [run(task: task)], evidence: e, roots: [],
                                    now: now, limit: 2)
            return (t.withdrawable.map(\.runID),
                    AgentState.withdrawOnForget(run(task: task), evidence: e))
        }
        check(withdrawn(.present([networkTask: Seen(state: "pooled")])) == (["n1"], networkTask),
              "merged while pooled: withdraw it")
        check(withdrawn(.present([networkTask: Seen(state: "claimed")])) == (["n1"], networkTask))
        check(withdrawn(.unavailable("the daemon did not answer")) == (["n1"], networkTask),
              "an unread snapshot still owes the withdrawal")
        check(withdrawn(.present([networkTask: Seen(state: "done", ok: true)])) == ([], nil),
              "the network finished it: nothing to withdraw")
        check(withdrawn(.present([networkTask: Seen(state: "cancelled")])) == ([], nil))
        check(withdrawn(.present([:])) == ([], nil), "the network never held it")
        check(withdrawn(.present([networkTask: Seen(state: "pooled")]), merged: false)
              == ([], networkTask), "unmerged: withdrawn only when forgotten")
        check(withdrawn(.present([networkTask: Seen(state: "pooled")]), task: nil) == ([], nil),
              "a local run has no offer")
    }

    section("network: the run book")
    do {
        let book = FileManager.default.temporaryDirectory
            .appendingPathComponent("diplomat-smoke-network-\(UUID().uuidString)", isDirectory: true)
        setenv("DIPLOMAT_AGENTS_DIR", book.path, 1)
        defer { try? FileManager.default.removeItem(at: book) }
        try? FileManager.default.createDirectory(at: book, withIntermediateDirectories: true)
        let records = [run("n1"), run("l1", task: nil)]
        AgentRegistry.save(records)
        check(AgentRegistry.load() == records, "a network run survives the book")
        let raw = try JSONSerialization.jsonObject(with: Data(contentsOf: AgentRegistry.runsPath()))
        let runs = (raw as? [String: Any])?["runs"] as? [[String: Any]] ?? []
        check(runs.map { $0["network"] as? String } == [networkTask, nil]
              && runs[1].keys.contains("network") == false,
              "`network` is written for a network run alone")
        try "{\"version\": \(AgentRegistry.schemaVersion), \"runs\": [{\"runId\": \"a\", \"network\": 7}, {\"runId\": \"b\", \"network\": \"\"}, {\"runId\": \"c\", \"placement\": \"mesh-peer\", \"node\": \"box\", \"workKey\": \"w\", \"claimSeenAt\": 1}]}"
            .write(to: AgentRegistry.runsPath(), atomically: true, encoding: .utf8)
        check(AgentRegistry.load().map(\.network) == [nil, nil, nil],
              "a task id of the wrong type, an empty one and a stale mesh record are local runs")
    }

    section("network: the audit category")
    for verb in [NetworkAudit.offer, NetworkAudit.claimed, NetworkAudit.done,
                 NetworkAudit.failed, NetworkAudit.withdraw, NetworkAudit.unavailable,
                 NetworkAudit.join, NetworkAudit.invite, NetworkAudit.leave,
                 NetworkAudit.start, NetworkAudit.stop] {
        check(AuditCategory.of(action: verb) == .network, "\(verb) is a Network row")
    }
    check([NetworkAudit.offer, NetworkAudit.claimed, NetworkAudit.done, NetworkAudit.failed,
           NetworkAudit.withdraw, NetworkAudit.unavailable, NetworkAudit.join,
           NetworkAudit.invite, NetworkAudit.leave, NetworkAudit.start, NetworkAudit.stop]
          == ["network-offer", "network-claimed", "network-done", "network-failed",
              "network-withdraw", "network-unavailable", "network-join", "network-invite",
              "network-leave", "network-start", "network-stop"])
    check(AuditCategory.displayOrder.firstIndex(of: .network)
          == AuditCategory.displayOrder.firstIndex(of: .comms)! + 1
          && AuditCategory.network.title == "Network"
          && AuditCategory.network.symbol == "point.3.connected.trianglepath.dotted",
          "the Network chip sits after Comms")
    print("network assertions passed")
}
