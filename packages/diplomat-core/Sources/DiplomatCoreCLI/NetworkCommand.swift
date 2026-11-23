import DiplomatCore
import Foundation

/// `diplomat-core network` - the Diplomacy Network's pure answers over a fixture, for
/// `test_network_parity.py` to hold against `network.py`'s: an applet asks them on every
/// cycle and every draw, so neither twin can delegate to the other.
///
/// Input, every member optional:
/// ```
/// { "hours": [ <any JSON value>, … ],
///   "remotes": [ "<git remote URL>", … ],
///   "gitlabHosts": { "<host a remote may name>": "<the GitLab host it is on>", … },
///   "hostedRemotes": [ "<git remote URL>", … ],
///   "rules": [ "<forge host>", … ],
///   "times": [ "<a sentence of the daemon's>", … ],
///   "kinds": [ {"verb", "ownPR"}, … ],
///   "offers": [ {"verb", "ownPR", "number", "repoKey", "label", "prompt", "panel",
///                "forced"}, … ],
///   "snapshots": [ <the daemon's /state>, … ],
///   "openTask": [ {"pool", "kind", "item", "snapshot": <index or null>}, … ],
///   "trouble": [ {"answered": true|false|null, "snapshot": <index or null>,
///                 "unknown": "<a config's path>" or ""}, … ],
///   "notTaking": [ {"task", "pool": <index into the snapshot's pools>, "snapshot"}, … ],
///   "listing": [ {"roots", "others", "unread", "identities", "snapshot"}, … ] }
/// ```
/// Output: one answer per input row under the same member (`pools` for `remotes`, and
/// `hostedPools` for `hostedRemotes`, read with `gitlabHosts`), with sorted keys. An
/// offer is its body, or the sentence it was refused with.
enum NetworkCommand {
    static func run(_ obj: [String: Any]) {
        let snapshots = (obj["snapshots"] as? [[String: Any]] ?? []).map(NetworkSnapshot.init)
        func rows(_ key: String) -> [[String: Any]] { obj[key] as? [[String: Any]] ?? [] }
        func snapshot(_ row: [String: Any]) -> NetworkSnapshot? {
            (row["snapshot"] as? Int).map { snapshots[$0] }
        }
        func repos(_ raw: Any?) -> [PRRef.LocalRepo] {
            (raw as? [[String: String]] ?? []).map {
                PRRef.LocalRepo(owner: $0["owner"] ?? "", repo: $0["repo"] ?? "",
                                path: $0["path"] ?? "",
                                host: $0["host"] ?? PRRef.LocalRepo.github)
            }
        }

        var out: [String: Any] = [:]
        out["hours"] = (obj["hours"] as? [Any] ?? []).map { NetworkSettings.hours(json: $0) }
        func pool(_ url: String, _ hosts: GitLabHosts) -> Any {
            guard let at = PRRef.LocalRepo.coordinates(remoteURL: url, gitlabHosts: hosts) else {
                return NSNull()
            }
            let repo = PRRef.LocalRepo(owner: at.owner, repo: at.repo, path: "", host: at.host)
            return NetworkOffer.pool(repoKey: repo.key) ?? NSNull()
        }
        out["pools"] = (obj["remotes"] as? [String] ?? []).map { pool($0, []) }
        let hosted = GitLabHosts(obj["gitlabHosts"] as? [String: String] ?? [:])
        out["hostedPools"] = (obj["hostedRemotes"] as? [String] ?? []).map { pool($0, hosted) }
        out["rules"] = (obj["rules"] as? [String] ?? []).map { NetworkPools.hasRules(host: $0) }
        out["times"] = (obj["times"] as? [String] ?? []).map(NetworkSnapshot.localTimes)
        out["offers"] = rows("offers").map { row -> Any in
            switch NetworkOffer.from(
                verb: row["verb"] as? String ?? "", ownPR: JSONInput.flag(row["ownPR"]),
                number: row["number"] as? Int, repoKey: row["repoKey"] as? String ?? "",
                label: row["label"] as? String ?? "", prompt: row["prompt"] as? String ?? "",
                source: JSONInput.flag(row["panel"]) ? .panel : .auto,
                forced: JSONInput.flag(row["forced"])) {
            case .offer(let offer): return offer.body
            case .refused(let why): return why
            }
        }
        out["notTaking"] = rows("notTaking").map { row -> String in
            guard let snapshot = snapshot(row), let at = row["pool"] as? Int else { return "" }
            return NetworkEvidence.notTaking(task: row["task"] as? String ?? "",
                                             pool: snapshot.pools[at], in: snapshot)
        }
        out["kinds"] = rows("kinds").map { row -> Any in
            NetworkOffer.kind(verb: row["verb"] as? String ?? "",
                              ownPR: JSONInput.flag(row["ownPR"])) ?? NSNull()
        }
        out["openTask"] = rows("openTask").map { row -> Any in
            NetworkEvidence.openTask(pool: row["pool"] as? String ?? "",
                                     kind: row["kind"] as? String ?? "",
                                     item: row["item"] as? String ?? "",
                                     in: snapshot(row)) ?? NSNull()
        }
        out["trouble"] = rows("trouble").map {
            NetworkTrouble.line(
                answered: $0["answered"] is NSNull ? nil : JSONInput.flag($0["answered"]),
                snapshot: snapshot($0),
                unknown: ($0["unknown"] as? String).flatMap {
                    $0.isEmpty ? nil : NetworkSettings.unknownNote(NetworkSettings.unknown(path: $0))
                } ?? "")
        }
        out["listing"] = rows("listing").map { row -> [String: Any] in
            let listing = NetworkPools.listing(
                roots: repos(row["roots"]), others: repos(row["others"]),
                unread: row["unread"] as? [String] ?? [],
                identities: row["identities"] as? [String: String] ?? [:],
                known: snapshot(row)?.pools ?? [])
            return ["pools": listing.pools.map(\.json), "unconfirmed": listing.unconfirmed]
        }
        guard let data = try? JSONSerialization.data(withJSONObject: out,
                                                     options: [.sortedKeys]) else {
            die("could not serialise the network answers", 1)
        }
        emit(data)
    }
}
