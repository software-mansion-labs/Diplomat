# Diplomacy Network protocol, version 1

The wire contract between two Diplomacy Network daemons. Everything a peer can observe
is here; how one daemon is built is in the README.

Words used throughout:

- **host** - one machine running the daemon. Its identity is one Ed25519 key pair; `pk`
  is the 32-byte public key in base64url without padding.
- **pool** - the shared set of tasks for one repository. The pool id is the repository's
  lowercase forge slug: `github.com/owner/repo`, `gitlab.com/group/sub/repo`.
- **requester** - a host that put a task in the pool and will act on the forge for it.
- **executor** - the host that claimed a task and runs it.

## 1. Transport

A host is reachable only as a Tor v3 onion service. The onion key is the host key, so the
onion address is a pure function of `pk`:

```
onion(pk) = base32(pk || sha3-256(".onion checksum" || pk || 0x03)[0..2] || 0x03) + ".onion"
```

Reaching `onion(pk)` therefore authenticates the target; no other address is ever
exchanged. A request is one HTTP/1.1 `POST /dn1` to virtual port 80 with a JSON body (the
request envelope) and a JSON response (the response envelope). Bodies are capped at 1 MiB,
except `act` requests, capped at 48 MiB.

## 2. Canonical form, hashes, signatures

`canon(x)` is JSON with object keys sorted by code unit, no insignificant whitespace,
strings as UTF-8, and numbers restricted to integers in the safe range. Floats, `null`
inside records, and duplicate keys are invalid. `H(x)` is SHA-256. Every signature is
Ed25519 over `tag || 0x00 || canon(object without its "sig" member)`, where `tag` is an
ASCII domain tag (`dn1/req`, `dn1/res`, `dn1/rec`, `dn1/grant`, `dn1/ping`, `dn1/invite`).
Times are integer Unix seconds.

## 3. Request envelope and the proof of work

```json
{ "v": 1, "pool": "<pool id>", "kind": "<kind>", "from": "<pk>", "to": "<pk>",
  "ts": 1794000000, "body": { },
  "pow": { "epoch": 498333, "nonce": "<16 bytes b64u>", "effort": 16384, "counter": "<8 bytes b64u>" },
  "sig": "<b64u>" }
```

Every request carries its own proof of work. None is ever accepted without one.

- **Public seed.** `seed(to, epoch) = H("dn1/seed" || 0x00 || to || u64be(epoch))` with
  `epoch = floor(ts / 3600)`. A target accepts its current epoch and the ones directly
  before and after it.
- **Work seed.** `nonce` is 16 fresh random bytes per request. A target remembers every
  `(from, nonce)` it accepted for as long as the epoch stays acceptable and refuses a
  repeat.
- **Challenge.** `c = H("dn1/pow" || 0x00 || seed || to || from || nonce || u32be(effort) || H(canon(core)))`
  where `core` is the envelope's `v, pool, kind, from, to, ts, body`.
- **Solution.** `counter` is 8 bytes such that, with `R` the first 4 bytes of
  `blake2b-512(c || counter)` read big-endian, `R * effort <= 0xFFFFFFFF`. A solution
  costs `effort` hashes on average and one hash to check.
- **Signature.** `sig` covers the whole envelope including `pow`, so the work is bound to
  the sender key, the target key, the difficulty, the public seed and the work seed.

### Required effort

The target decides how much work a request owes; it rises with the requests it is
receiving.

```
required(sender) = BASE << min(CAP, max(0, ceil(log2(n / ALLOW))))
```

`n` counts the requests accepted from that sender in the last 60 seconds, this one
included. A sender that is not a member of the request's pool on the target is a
stranger: all strangers share one counter, and their `BASE` is 16 times higher.

| | BASE | ALLOW per 60 s | CAP |
| --- | --- | --- | --- |
| pool member | 16384 | 30 | 12 doublings |
| stranger | 262144 | 4 | 8 doublings |

### Verification order

A target checks, cheapest first, and stops at the first failure: envelope shape and size;
`to` is its own key; `ts` within 300 s of its clock; `pow.epoch` acceptable; `effort`
at least `required(from)`; the solution; the signature; `(from, nonce)` unseen. Only a
request that passed the signature counts toward its sender's `n`; a failure before that
counts toward the stranger counter.

## 4. Response envelope

```json
{ "v": 1, "ok": true, "re": "<H(canon(request)) b64u>", "body": { }, "effort": 16384, "sig": "<b64u>" }
```

`effort` is what the target would require of this sender's next request. A refusal has
`"ok": false` and `"error": { "code": "...", "detail": "..." }` in place of `body`. Codes:
`effort` (too little work; `effort` says how much), `stale` (clock or epoch), `replay`,
`unknown-pool`, `not-member`, `bad-request`, `denied`, `busy`.

## 5. Pool state

A pool's state is a set of signed records, each stored under a key. A host keeps the
whole set for every pool it is in.

| Record | Key | Signed by | Newer version wins by |
| --- | --- | --- | --- |
| `member` | `member/<pk>` | that member | higher `seq` |
| `offer` | `offer/<taskId>/<host pk>` | the offering host | higher `seq` |
| `claim` | `claim/<taskId>` | the executor | see section 7 |

Two versions with the same precedence are ordered by `H(canon(record))`, lower wins.

```json
{ "type": "member", "pool": "...", "pk": "...", "seq": 3, "joinedAt": 1794000000,
  "maxAcceptedH": 12, "voucher": { "invite": "<invite token>" }, "left": false, "sig": "..." }

{ "type": "offer", "pool": "...", "taskId": "...", "host": "<pk>", "seq": 1,
  "kind": "review", "item": "pr-578", "identity": "octocat", "title": "...",
  "minRequiredH": 12, "createdAt": 1794000000, "state": "open", "attempt": 1, "sig": "..." }
```

`offer.state` is `open`, `cancelled` or `done`. An offer never carries the prompt.

### Task ids

```
taskId = <pool id> "#" <kind> ":" <item> "@" <identity>
```

`identity` is the forge login the work is done as, lowercase. Two hosts acting as the
same login on the same item offer the same task; two different logins asking for the
same item are two tasks. A task is **available** while it has at least one open offer and
no active claim.

### State hash

```
stateHash(asOf) = H(canon([[key, H(canon(record))], ...] sorted by key))
```

over the records live at `asOf`. A record stops being live, and is dropped, 24 hours
after it became final: an offer that is `cancelled` or `done`, a claim that is released,
completed or lapsed, a member that `left`. `asOf` is chosen by whoever asks and is
refused when more than 300 s from the answerer's clock, so both sides hash the same set.

### Membership

A host enters a pool with an invite: `{ "pool", "by": "<pk>", "exp", "nonce", "sig" }`,
signed by a member and handed over out of band. Its `member` record carries the invite as
`voucher`. A host accepts the members connected to itself through vouchers: itself, the
signer of its own invite, anyone vouched for by a member it accepts, and the voucher
signer of any member it accepts. A host that starts a pool has no voucher and is its own
root. Nothing else joins a pool.

## 6. Requests between members

Every kind but `hello` is refused with `not-member` unless `from` is an accepted member of
`pool` on the target.

| Kind | Body | Answer |
| --- | --- | --- |
| `hello` | `{ member }` - the sender's own record, with voucher | `{ index }` |
| `sync` | `{ asOf, hash }` | `{ hash }`, plus `{ index }` when the hashes differ |
| `pull` | `{ keys }` | `{ records }` |
| `push` | `{ records }` | `{ accepted, refused: [{ key, code }] }` |
| `lock` | `{ taskId, round, asOf, hash }` | `{ grant }` or `{ challenge }` or `{ stale: true }` |
| `unlock` | `{ taskId, round }` | `{ }` |
| `ping` | `{ ping }` | `{ claim }` |
| `key` | `{ taskId, round }` | `{ capability, secret, spec }` |
| `act` | `{ taskId, keyId, seq, request, mac }` | `{ status, headers, body }` |
| `done` | `{ taskId, keyId, outcome, summary, mac }` | `{ }` |

`index` maps every live key to `[precedence, H(canon(record))]`. Objective facts - a
member announcing itself, a task appearing, a task cancelled because its issue or pull
request closed, a committed claim - travel by `push` and need nobody's consent: a host
pushes a record it wrote or learned to every member, and a periodic `sync` repairs what
a push missed.

## 7. Claiming a task

A claim is the one thing that needs consent. A host with a free slot that sees an
available task:

1. **Confirms its own state.** It refreshes its own offers (an item that closed is
   cancelled first) and computes `stateHash(asOf)`.
2. **Confirms it with every member.** It sends `sync` to every other member and repairs
   differences until all that answer report its hash. A member that does not answer
   within the round's timeout is **absent** for this round.
3. **Sends a lock to every present member**: `{ taskId, round, asOf, hash }`, `round` a
   fresh random 8-byte value.

A member answers a lock with:

- `{ stale: true }` when its hash at `asOf` differs - the claimant goes back to step 2;
- `{ challenge: { reason, holder? } }` when the task is not available in its state
  (`unavailable`), the claimant's `maxAcceptedH` is below the task's hours
  (`hours`), or it has already granted or is itself claiming the task for another
  executor (`locked`, with that executor as `holder`);
- `{ grant }` otherwise: `{ pool, taskId, executor, round, hash, by, exp, sig }`, signed,
  valid 120 s. A granted lock binds the member until `exp`, an `unlock`, or the commit.

The claim holds only when every present member granted it. The claimant then signs the
claim record and pushes it:

```json
{ "type": "claim", "pool": "...", "taskId": "...", "executor": "<pk>", "round": "...",
  "seq": 0, "state": "held", "claimedAt": 1794000000, "leaseUntil": 1794007200,
  "deadline": 1794043200, "hours": 12, "grants": [ ... ], "absent": ["<pk>", ...], "sig": "..." }
```

### Conflicts

Every conflict is settled by a value all hosts compute alike.

- **Rank.** `rank(taskId, executor) = H("dn1/rank" || 0x00 || taskId || 0x00 || executor)`.
  Lower wins.
- **Two claimants locking at once.** A claimant challenged with `locked` compares ranks
  with the `holder`. The one that ranks worse sends `unlock` to every member it locked and
  stands down; the one that ranks better re-sends its lock to the members that challenged
  it, until they grant or the round times out.
- **Two committed claims for one task** (two sides of a partition each saw the other
  absent). The claim with the better rank is the claim; the other executor stops its run
  the moment it learns of it.
- **A claim against a newer claim of the same executor.** Higher `seq` wins.
- **An active claim against a later one.** A claim that is `held` and unexpired cannot be
  replaced by another executor's claim with a later `claimedAt` unless that one ranks
  better and their lease windows overlap, which is the partition case above.

To keep hosts from racing for the same task, a host waits before step 1 for a delay
proportional to its rank on that task, up to 5 s.

## 8. Hours, leases and the heartbeat

- A requester sets `minRequiredH` on every offer: the hours the task may take from start
  to finish. The default and the floor are 12.
- A member publishes `maxAcceptedH` in its `member` record: the longest task it takes.
  The default and the floor are 12.
- A task's `hours` is the largest `minRequiredH` among its open offers. A host may claim
  a task only when its `maxAcceptedH` is at least that.
- A claim is leased for 2 hours at a time: `leaseUntil = claimedAt + 7200`,
  `deadline = claimedAt + hours * 3600`.
- From 10 minutes before `leaseUntil`, a host offering the task sends the executor a
  `ping`: `{ pool, taskId, executor, round, n, by, ts, sig }`. The executor must answer
  with its claim at `seq + 1`, `leaseUntil` moved 2 hours on (never past `deadline`), and
  the ping embedded as `ping`. The offering host pushes it to the pool.
- A claim is **active** while `state` is `held` and `now < leaseUntil + 600`. Past that
  it has lapsed: every host treats the task as available again, the executor stops the
  run, and the requester's key is dead. At `deadline` there is nothing left to extend.
- An executor that finishes or gives up pushes its claim with `state` `completed` or
  `released`.

## 9. Acting as the requester

Everything done on the forge for a task - reading an issue, posting a review, pushing a
commit, opening a pull request - is done by the requester, on the executor's request. No
credential of the requester crosses the network, and the executor needs none of its own
for the forge.

1. After its claim is committed, the executor sends `key` to a host offering the task
   (the lowest `pk` among the offering hosts that granted the lock).
2. That host checks that the claim in its own state names this executor and round, that
   it is active, and that it has issued no other live key for the task. It answers with:
   - `capability`: `{ keyId, pool, taskId, executor, host, rules, exp, sig }` - `rules`
     is the exact list of requests this task may make (section 10), `exp` is
     `leaseUntil + 600`;
   - `secret`: 32 random bytes;
   - `spec`: what the executor needs to run the task - the prompt, the item, the base
     revision, and the name and email commits are authored with.
3. Each `act` request names the `keyId`, carries a strictly increasing `seq`, one forge
   request, and `mac = HMAC-SHA256(secret, canon({ keyId, seq, request }))`:

   ```json
   { "host": "api.github.com", "method": "POST", "path": "/repos/o/r/pulls/578/reviews",
     "headers": { "content-type": "application/json", "accept": "..." }, "body": "<b64>" }
   ```

   The host performs it only when: the envelope is signed by the capability's executor;
   the key is unexpired and unrevoked; the claim is still active for that executor; `seq`
   is new; the MAC matches; and the request matches a rule. It sends the request to the
   forge with its own credentials and answers `{ status, headers, body }`.
4. Each lease extension moves `exp` with it. A lapse, a `done`, a cancelled offer or a
   better-ranked claim revokes the key.

## 10. Rules

A rule allows one shape of forge request:

```json
{ "host": "api.github.com", "method": "POST", "path": "/repos/o/r/pulls/578/reviews", "fold": [1, 2] }
```

A request is first brought to one spelling and refused when it has more than one reading:
the method is one of GET, POST, PUT, PATCH, DELETE; the host is a plain lowercase name; the
path is absolute, with no empty or dot segment, no fragment, no `;`, and no encoded slash,
dot, backslash, percent sign or control character (GitLab's URL-encoded project path, the
segment after `/api/v4/projects/`, is the one place an encoded slash may stand); a header
is given once; the body is base64. Then the first rule whose host, method and path match
decides, alone. A request no rule matches is refused.

- `path` is matched segment by segment: a literal, `*` for exactly one segment, or a
  trailing `**` for any remainder. `fold` lists the segments, counted from 0, that are
  compared without regard to case: the ones naming the repository, which both forges
  resolve that way. Every other literal must equal the segment as sent. The query string
  is not part of the path.
- `"query": { "service": { "equals": "git-receive-pack" } }` pins query parameters:
  `equals`, `oneOf`, or `search` - a forge search string that must carry
  `repo:<owner>/<name>` as a term of its own, with no other repository, organisation or
  user qualifier, no negation and no top-level OR. A pinned parameter is required unless
  `optional` and is given once. On a write, a parameter the rule does not pin is refused,
  because a forge reads a write's parameters from the query as readily as from the body.
  `sudo`, `private_token`, `access_token`, `job_token` and `_method` are refused always.
- `"body": { "event": { "oneOf": ["COMMENT"] }, "body": "free" }` pins a JSON body member
  by member. The body is parsed strictly (`application/json`, UTF-8, no duplicate key) and
  a member the rule does not name is refused. A member is `"free"`, or pinned with
  `equals`, `oneOf`, `prefix`, `prose` (text with no line starting with `/`, which GitLab
  would run as a quick action), `created` (a branch this key pushed) or `self` (the
  requester's own account id), and may be `required`. What is sent to the forge is the
  parsed body, written out again. A rule without `body` takes no body.
- `pull` and `comment` have the forge asked, before anything is sent, which pull request
  the number or comment id in the path belongs to, who opened or wrote it and whether it
  is open or pending. `pick` lists the members of the forge's JSON answer an executor
  gets back.
- `{ "graphql": { "forge": "github", "repo": "o/r", "roots": [...], "mutations": [...],
  "item": { "type": "pr", "number": 578 }, "identity": "me" } }` on the GraphQL endpoint
  confines the document, which must be exactly one query or mutation. A query may select
  only the listed root fields: `repository` (GitLab: `project`) pinned to the pool's own,
  the viewer's public scalars, a `search` confined as above, and `node(id:)` once the id
  has been resolved to an object of the pool's repository. Below a root, a field with a
  selection set must be one the reader knows the reach of, so a selection cannot walk from
  the repository to its owner's other repositories. A mutation must be a single field
  from the list, its input may hold only the members the reader's table names, and every
  object it addresses is resolved on the forge and must belong to the task's own item.
- `{ "git": "receive-pack", "repo": "o/r", "refs": ["refs/heads/**"], "create": 1,
  "denyPaths": [".github/workflows/**"] }` on the two smart-HTTP push endpoints confines a
  push. No ref may be deleted. A ref may be created when `refs` covers it, up to `create`
  refs per key; it may be updated when it is a ref this key created, or the head branch
  of the pull request `"head": { "number": 578 }` names (`{ "author": "me" }`: of any open
  pull request by that author). Every update must be a fast-forward of the ref's current
  value, proven by indexing the pack in a quarantine. No pushed commit may write a path
  under `denyPaths` that none of its parents holds, and the push must build on commits a
  branch of that repository holds. Push options are refused.

The rules a task receives come from the daemon's catalogue (`src/requester/rules.js`),
keyed by forge and kind and pinned to the task's own item. A kind without an entry can be
offered by nobody.
