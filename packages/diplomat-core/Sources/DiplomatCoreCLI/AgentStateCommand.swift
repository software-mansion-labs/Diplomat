import DiplomatCore
import Foundation

/// `diplomat-core agent-state` — run one tick of the agent-state resolver over a
/// fixture and print every answer it produces.
///
/// Same standing as `tool-data` and `telemetry`: `AgentState` (Swift) and
/// `diplomat_runtime/agentstate.py` (the shared runtime) are two implementations of one
/// decision, and neither can delegate to the other — this runs on an 8-second poll and
/// on every dispatch, so a subprocess per tick is not an option. A drift would be
/// invisible in the worst way: both applets keep drawing rows, they just quietly
/// disagree about whether your agent is still running. `test_agent_state_parity.py`
/// drives both over the scenario table and diffs this output.
///
/// The whole pipeline is emitted, not just the resolver, because the order of its
/// steps is itself a decision the two sides have to share: screens are observed BEFORE
/// resolving (so a change seen this tick counts this tick), and untracked agents are
/// synthesized AFTER (so a live agent that already has a record is not duplicated).
///
/// Input:
/// ```
/// { "now": 1000000.0, "limit": 2, "deadline": 14400.0,
///   "roots": [ {"owner": "g/sub", "repo": "p", "path": "/w/p", "host": "gitlab.example.com"} ],
///   "records": [ {"runId": …, "dispatchedAt": …, "pid": …, …} ],
///   "evidence": { "processes": {"status": "present", "value": {"4242": {…}}},
///                 "mergedPrs": {"status": "present", "value": ["o/r#12"]},
///                 "liveAgents": {"status": "present", "value": {"o/r#404": "pts/3"}}, … },
///   "networkSnapshot": { "offers": [ {"taskId": …, "state": "claimed", …} ], … } }
/// ```
/// `networkSnapshot`, when the key is there, is the network daemon's answer as it gave
/// it - `null` for none - and takes the place of `evidence.network`, so the snapshot
/// decoder and the evidence built from it are diffed too.
/// Output: the resolved rows in display order, every record's verdict whether drawn or
/// not, every projection, and the records as the pipeline left them - so a stillness
/// clock written by the wrong step is a diff.
enum AgentStateCommand {
    static func run(_ obj: [String: Any]) {
        let now = (obj["now"] as? NSNumber)?.doubleValue ?? 0
        let limit = (obj["limit"] as? NSNumber)?.intValue ?? 2
        // Absent means the operator's switch is off, which is the Python default too —
        // a payload that forgot the key must not silently get a deadline of zero.
        let deadline = (obj["deadline"] as? NSNumber)?.doubleValue
        var evidence = decodeEvidence(obj["evidence"] as? [String: Any] ?? [:])
        let snapshot = (obj["networkSnapshot"] as? [String: Any]).map(NetworkSnapshot.init)
        if obj["networkSnapshot"] != nil { evidence.network = NetworkEvidence.tasks(snapshot) }
        let records = (obj["records"] as? [[String: Any]] ?? []).map(decodeRecord)
        // Absent is no roots: every synthesized run links to github.com.
        let roots = (obj["roots"] as? [[String: Any]] ?? []).compactMap { r -> PRRef.LocalRepo? in
            guard let owner = r["owner"] as? String, let repo = r["repo"] as? String else { return nil }
            return PRRef.LocalRepo(owner: owner, repo: repo, path: r["path"] as? String ?? "",
                                   host: r["host"] as? String ?? PRRef.LocalRepo.github)
        }
        let t = AgentState.tick(records: records, evidence: evidence, roots: roots,
                                now: now, limit: limit, deadline: deadline)

        var inFlight: [String: Bool] = [:]
        for item in Set(t.records.compactMap(\.item)) {
            inFlight[item] = t.inFlight(item: item)
        }
        func verdict(_ s: AgentState.Resolution) -> [String: Any] {
            ["state": s.state.rawValue, "reason": s.reason, "wedged": s.wedged,
             "expired": s.expired, "lapsed": s.lapsed, "reported": s.reported,
             "spent": s.spent]
        }
        let out: [String: Any] = [
            "rows": t.rows.map { r, s in verdict(s).merging(["runId": r.runID]) { $1 } },
            "states": t.states.mapValues(verdict),
            "capLoad": t.capLoad.sorted(),
            "retirable": t.retirable.map(\.runID).sorted(),
            // The two destructive projections, so the two sides have to agree on them
            // by name: a window closed on one platform and left open on the other is a
            // machine that behaves differently depending on which applet is running.
            "reapable": t.reapable.map(\.runID).sorted(),
            "closeOnRetire": t.closeOnRetire.map(\.runID).sorted(),
            "withdrawable": t.withdrawable.map(\.runID).sorted(),
            "withdrawOnForget": t.records.filter {
                AgentState.withdrawOnForget($0, evidence: evidence) != nil
            }.map(\.runID).sorted(),
            "withdrawUnstarted": t.records.filter {
                AgentState.withdrawUnstarted($0, evidence: evidence) != nil
            }.map(\.runID).sorted(),
            "network": network(evidence.network),
            "networkSnapshot": snapshot.map(dump) ?? NSNull(),
            "networkRunning": NetworkAdmit.running(snapshot),
            "freeSlots": t.freeSlots,
            "inFlight": inFlight,
            // Three timing constants, so the parity diff covers the NUMBERS and not
            // only the verdicts. `quietTimeout` is already pinned by the scenarios that
            // sit either side of it, but `runDeadline` is supplied in the payload and no
            // case lies within `spawnGrace` of its dispatch — so a Swift value that
            // drifted from the Python one would otherwise change nothing any case here
            // can see, while the two applets retired runs at different ages.
            "constants": ["runDeadline": AgentState.runDeadline,
                          "quietTimeout": AgentState.quietTimeout,
                          "spawnGrace": AgentState.spawnGrace],
            "records": t.records.map { r -> [String: Any] in
                ["runId": r.runID, "network": r.network.map { $0 as Any } ?? NSNull(),
                 "untracked": r.untracked, "released": r.released, "source": r.source,
                 "pid": r.pid.map { $0 as Any } ?? NSNull(), "tty": r.tty,
                 "dispatchedAt": r.dispatchedAt,
                 "quietDigest": r.quietDigest,
                 "quietSince": r.quietSince.map { $0 as Any } ?? NSNull(),
                 "reapRefusedAt": r.reapRefusedAt.map { $0 as Any } ?? NSNull()]
            },
        ]
        guard let data = try? JSONSerialization.data(
            withJSONObject: out, options: [.sortedKeys, .prettyPrinted]) else {
            die("could not serialise agent state", 1)
        }
        emit(data)
    }

    // MARK: - The network
    //
    // The evidence and the snapshot as this side read them, member for member, so a
    // field one decoder drops or renames is a diff.

    private static func network(_ o: Observation<[String: AgentState.NetworkTask]>) -> [String: Any] {
        guard let tasks = o.value else { return ["unavailable": o.reason] }
        return ["present": tasks.mapValues { t -> [String: Any] in
            ["state": t.state, "executor": t.executor, "executorHere": t.executorHere,
             "ok": t.ok, "reason": t.reason, "notTaking": t.notTaking, "capped": t.capped]
        }]
    }

    private static func dump(_ s: NetworkSnapshot) -> [String: Any] {
        func opt<T>(_ v: T?) -> Any { v.map { $0 as Any } ?? NSNull() }
        func service(_ v: NetworkSnapshot.Service) -> [String: Any] {
            ["state": v.state, "detail": v.detail]
        }
        return [
            "updatedAt": opt(s.updatedAt), "pid": opt(s.pid), "startedAt": opt(s.startedAt),
            "pk": s.pk, "onion": s.onion,
            "transport": service(s.transport), "model": service(s.model),
            "docker": ["state": s.docker.state, "image": s.docker.image,
                       "detail": s.docker.detail],
            "admit": ["slots": s.admit.slots, "at": opt(s.admit.at),
                      "reason": s.admit.reason],
            "pools": s.pools.map { p -> [String: Any] in
                ["id": p.id, "path": p.path, "identity": p.identity, "hash": p.hash,
                 "left": p.left, "joining": p.joining, "joinFailed": p.joinFailed,
                 "notTaking": p.notTaking,
                 "members": p.members.map { m -> [String: Any] in
                     ["pk": m.pk, "self": m.isSelf, "maxAcceptedH": opt(m.maxAcceptedH),
                      "lastSeen": opt(m.lastSeen), "reachable": m.reachable]
                 },
                 "tasks": p.tasks.map { t -> [String: Any] in
                     ["taskId": t.taskId, "kind": t.kind, "item": t.item, "title": t.title,
                      "identity": t.identity, "hours": opt(t.hours), "state": t.state,
                      "offeredBy": t.offeredBy, "offeredHere": t.offeredHere,
                      "executor": t.executor, "executorHere": t.executorHere,
                      "claimedAt": opt(t.claimedAt), "leaseUntil": opt(t.leaseUntil),
                      "deadline": opt(t.deadline)]
                 }]
            },
            "runs": s.runs.map { r -> [String: Any] in
                ["runId": r.runId, "taskId": r.taskId, "pool": r.pool, "peer": r.peer,
                 "container": r.container, "state": r.state,
                 "startedAt": opt(r.startedAt), "endedAt": opt(r.endedAt),
                 "exit": opt(r.exit)]
            },
            "offers": opt(s.offers?.map { o -> [String: Any] in
                ["taskId": o.taskId, "pool": o.pool, "kind": o.kind, "item": o.item,
                 "title": o.title, "state": o.state, "reason": o.reason,
                 "executor": o.executor, "executorHere": opt(o.executorHere),
                 "offeredAt": opt(o.offeredAt), "attempt": o.attempt, "requests": o.requests, "refused": o.refused,
                 "outcome": opt(o.outcome.map { out -> [String: Any] in
                     ["ok": out.ok, "summary": out.summary, "usd": opt(out.usd),
                      "tokens": opt(out.tokens), "runner": out.runner, "model": out.model,
                      "capped": out.capped]
                 }),
                 "endedAt": opt(o.endedAt), "notTaking": o.notTaking]
            }),
        ]
    }

    // MARK: - Decoding
    //
    // A field absent from the payload decodes to `.unavailable`, never to an empty
    // answer — the same rule the resolver is built on, applied to its own input.

    private static func decodeObs<T>(_ raw: Any?,
                                     _ coerce: (Any) -> T?) -> Observation<T> {
        guard let d = raw as? [String: Any] else { return .unavailable("absent from payload") }
        let status = d["status"] as? String ?? "unavailable"
        guard status == "present" else {
            let reason = d["reason"] as? String ?? ""
            return status == "unsupported" ? .unsupported(reason) : .unavailable(reason)
        }
        guard let v = d["value"], let coerced = coerce(v) else {
            return .unavailable("value did not decode")
        }
        return .present(coerced)
    }

    private static func decodeEvidence(_ d: [String: Any]) -> AgentState.Evidence {
        AgentState.Evidence(
            processes: decodeObs(d["processes"]) { v in
                guard let m = v as? [String: Any] else { return nil }
                var out: [Int: AgentState.ProcInfo] = [:]
                for (k, p) in m {
                    guard let pid = Int(k), let pd = p as? [String: Any] else { continue }
                    out[pid] = AgentState.ProcInfo(
                        tty: pd["tty"] as? String ?? "",
                        elapsed: (pd["elapsed"] as? NSNumber)?.doubleValue ?? 0,
                        isAgent: JSONInput.flag(pd["isAgent"]))
                }
                return out
            },
            sentinels: decodeObs(d["sentinels"]) { ($0 as? [String]).map(Set.init) },
            tails: decodeObs(d["tails"]) { $0 as? [String: String] },
            mergedPRs: decodeObs(d["mergedPrs"]) { ($0 as? [String]).map(Set.init) },
            liveAgents: decodeObs(d["liveAgents"]) { v in
                (v as? [String: Any])?.mapValues { $0 as? String ?? "" }
            },
            sessions: decodeObs(d["sessions"]) { v in
                guard let m = v as? [String: Any] else { return nil }
                var out: [String: AgentState.SessionState] = [:]
                for (runID, s) in m {
                    guard let sd = s as? [String: Any] else { continue }
                    out[runID] = AgentState.SessionState(busy: JSONInput.flag(sd["busy"]),
                                                         failure: sd["failure"] as? String)
                }
                return out
            },
            activity: decodeObs(d["activity"]) { v in
                guard let m = v as? [String: Any] else { return nil }
                var out: [String: AgentState.TurnReport] = [:]
                for (runID, pair) in m {
                    guard let t = pair as? [Any], t.count == 2,
                          let raw = t[0] as? String,
                          let verb = AgentState.TurnReport.Verb(rawValue: raw),
                          let at = (t[1] as? NSNumber)?.doubleValue else { continue }
                    out[runID] = AgentState.TurnReport(verb: verb, at: at)
                }
                return out
            },
            tokensLeft: decodeObs(d["tokensLeft"]) { ($0 as? JSONInput.Flag)?.on },
            network: decodeObs(d["network"]) { v in
                guard let m = v as? [String: Any] else { return nil }
                var out: [String: AgentState.NetworkTask] = [:]
                for (task, raw) in m {
                    guard let t = raw as? [String: Any] else { continue }
                    out[task] = AgentState.NetworkTask(
                        state: t["state"] as? String ?? "",
                        executor: t["executor"] as? String ?? "",
                        executorHere: JSONInput.flag(t["executorHere"]),
                        ok: JSONInput.flag(t["ok"]),
                        reason: t["reason"] as? String ?? "",
                        notTaking: t["notTaking"] as? String ?? "",
                        capped: JSONInput.flag(t["capped"]))
                }
                return out
            })
    }

    private static func decodeRecord(_ d: [String: Any]) -> AgentState.RunRecord {
        AgentState.RunRecord(
            runID: d["runId"] as? String ?? "",
            dispatchedAt: AgentRegistry.number(d["dispatchedAt"]) ?? 0,
            prNumber: AgentRegistry.integer(d["prNumber"]),
            prURL: d["prUrl"] as? String ?? "",
            kind: d["kind"] as? String ?? "",
            label: d["label"] as? String ?? "",
            source: d["source"] as? String ?? AgentDispatchGate.Source.auto.rawValue,
            ledgerKey: d["ledgerKey"] as? String ?? "",
            pid: AgentRegistry.integer(d["pid"]),
            tty: d["tty"] as? String ?? "",
            quietDigest: d["quietDigest"] as? String ?? "",
            quietSince: AgentRegistry.number(d["quietSince"]),
            reapRefusedAt: AgentRegistry.number(d["reapRefusedAt"]),
            untracked: JSONInput.flag(d["untracked"]),
            released: JSONInput.flag(d["released"]),
            network: (d["network"] as? String).flatMap { $0.isEmpty ? nil : $0 })
    }
}
