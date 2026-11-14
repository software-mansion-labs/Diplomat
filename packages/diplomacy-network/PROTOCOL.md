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
ASCII domain tag (`dn1/req`, `dn1/res`, `dn1/rec`, `dn1/grant`, `dn1/ping`, `dn1/invite`,
`dn1/cap`). Times are integer Unix seconds.

Where a hash is written as a concatenation, a key is its 32 raw bytes, a nonce its raw
bytes, a string its UTF-8 bytes and a hash its 32 raw bytes. Inside JSON every byte
string, hashes included, is base64url without padding. Where keys are ordered ("the
lowest `pk`"), they are compared as their base64url strings, by code unit.

Everything a host receives is checked against the exact shape this document gives it: an
object with a missing member, an unknown member or a member of the wrong type is refused,
never repaired.

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

| Record | Key | Signed by | Precedence | Newer version wins by |
| --- | --- | --- | --- | --- |
| `member` | `member/<pk>` | that member | `[seq]` | higher `seq` |
| `offer` | `offer/<taskId>/<host pk>` | the offering host | `[seq]` | higher `seq` |
| `claim` | `claim/<taskId>` | the executor | `[gen, executor, round, seq]` | see section 7 |

Two versions with the same precedence are ordered by `H(canon(record))`, lower wins.

```json
{ "type": "member", "pool": "...", "pk": "...", "seq": 3, "at": 1794000900, "joinedAt": 1794000000,
  "maxAcceptedH": 12, "voucher": { "invite": "<invite token>" }, "left": false, "sig": "..." }

{ "type": "offer", "pool": "...", "taskId": "...", "host": "<pk>", "seq": 1, "at": 1794000000,
  "kind": "review", "item": "pr-578", "identity": "octocat", "title": "...",
  "minRequiredH": 12, "createdAt": 1794000000, "state": "open", "attempt": 1, "sig": "..." }
```

Every record carries `at`, the time that version was signed. A record dated more than
300 s past the receiver's clock is refused until its time comes. `offer.state` is `open`,
`cancelled` or `done`. An offer never carries the prompt. A member that started its pool
has no `voucher`.

Limits: a pool id is at most 200 characters, `host/owner/repo` or deeper, of `a-z`,
`0-9`, `.`, `_` and `-`; `kind` is `[a-z][a-z0-9-]{0,31}`; `item` is
`[a-z0-9][a-z0-9._-]{0,63}`; `identity` is `[a-z0-9][a-z0-9._-]{0,99}`; `title` is at
most 300 characters with no control character; hours are 12 to 720; `attempt` is 1 to
255; a claim lists at most 256 grants and 256 absent members; a time or a `seq` is at
most 2^40.

### Task ids

```
taskId = <pool id> "#" <kind> ":" <item> "@" <identity>
```

`identity` is the forge login the work is done as, lowercase. Two hosts acting as the
same login on the same item offer the same task; two different logins asking for the
same item are two tasks. A task is **available** while it has at least one open offer
from a member and no active claim.

### Membership

A host enters a pool with an invite: `{ "pool", "by": "<pk>", "exp", "nonce", "sig" }`,
signed by a member and handed over out of band as a token, the base64url of its canonical
form. `nonce` is 16 random bytes. Its `member` record carries the token as `voucher`; the
voucher holds when the invite is for that pool, signed by another key than the member's,
and `joinedAt` is no later than `exp`.

A host **accepts** the keys connected to itself through vouchers: itself, the signer of
its own invite, anyone vouched for by a member it accepts, and the voucher signer of any
member it accepts. A host that starts a pool has no voucher and is its own root. Nothing
else joins a pool. The pool's **members** are the accepted keys whose `member` record is
held and does not say `left`: they are who a claim needs the consent of.

A host lets in a key it has not accepted before only by `hello`, and only while the
invite is unexpired. Any member that accepts the invite's signer can be greeted, not only
the signer. A member a host learns of from another member needs no unexpired invite: that
member let it in.

### Live records and the state hash

```
stateHash(asOf) = H(canon([[key, H(canon(record))], ...] sorted by key))
```

over the records live at `asOf`. Whether a record is live depends only on the records
held and on `asOf`, so two hosts holding the same records hash the same set:

- An offer that is `cancelled` or `done` is live for 24 hours after its `at`.
- A claim is live for 24 hours after it ended: after its `at` when it is `released` or
  `completed`, after `leaseUntil + 600` when it is `held`.
- A member that `left` is live for 24 hours after its `at`, and beyond that for as long
  as the voucher of a live member is signed by it: dropped, it would cut that member off.
- A member is live only while its key is accepted. An offer or a claim is live only
  while the member record of its signer is. A claim that embeds a ping is live only
  while an offer of that task by the ping's signer is.

A record that is not live is dropped, and refused when it arrives. `asOf` is chosen by
whoever asks and is refused when more than 300 s from the answerer's clock, so a host
keeps every record for 300 s past the moment it stops being live.

## 6. Requests between members

Every kind but `hello` is refused with `not-member` unless `from` is a key the target
accepts in `pool` whose member record, when held, does not say `left`.

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

`index` maps every live key to `[precedence, H(canon(record))]`. `pull` takes at most 4096
keys and `push` at most 1024 records. `accepted` lists the keys the target now holds as
pushed; a refused record has an empty `key` when it is too malformed to have one, and its
`code` is `bad-record`, `wrong-pool`, `future`, `older` (the target holds a version that
wins), `bad-signature`, `bad-voucher`, `bad-claim`, `bad-grant`, `bad-lease`, `bad-ping`,
`expired`, `not-member` or `no-offer`. Records pushed together are taken in together, so
a member record lets in the records that depend on it whatever their order.

Objective facts - a member announcing itself, a task appearing, a task cancelled because
its issue or pull request closed, a committed claim - travel by `push` and need nobody's
consent: a host pushes a record it wrote or learned to every member, and a periodic
`sync` repairs what a push missed.

## 7. Claiming a task

A claim is the one thing that needs consent. A host with a free slot that sees an
available task:

1. **Confirms its own state.** It refreshes its own offers (an item that closed is
   cancelled first) and computes `stateHash(asOf)`.
2. **Confirms it with every member.** It sends `sync` to every other member and repairs
   differences until all that answer report its hash. A member that has answered nothing
   in this round when a request to it goes unanswered is **absent** for this round; a
   member that has answered anything is **present**.
3. **Sends a lock to every present member**: `{ taskId, round, asOf, hash }`, `round` a
   fresh random 8-byte value.

A member answers a lock with:

- `{ stale: true }` when its hash at `asOf` differs - the claimant goes back to step 2;
- `{ challenge: { reason, holder? } }` when the task is not available by its own clock
  (`unavailable`), the claimant's `maxAcceptedH` is below the task's hours
  (`hours`), or it has already granted or is itself claiming the task for another
  executor (`locked`, with that executor as `holder`);
- `{ grant }` otherwise: `{ pool, taskId, executor, round, gen, hash, by, exp, sig }`,
  signed, with `exp = asOf + 120`. `gen` is the claim's generation: one more than the
  `gen` of the claim record live for that task at `asOf`, zero when there is none. A
  granted lock binds the member through `exp` by its own clock, or until an `unlock` or
  the commit of that round. A host's own round binds it the same way, from its start
  until it commits, stands down or times out.

The claim holds only when every present member granted it on one `asOf` and `hash`, no
later than `exp`, and at least one host offering the task is among them or is the
claimant itself. A round times out 180 s after it started and commits nothing from then
on: the claimant unlocks every member it locked and stands down, as it does whenever a
present member has not granted by then. The claimant of a round that holds signs the
claim record and pushes it:

```json
{ "type": "claim", "pool": "...", "taskId": "...", "executor": "<pk>", "round": "...", "gen": 0,
  "seq": 0, "state": "held", "at": 1794000000, "claimedAt": 1794000000, "leaseUntil": 1794007200,
  "deadline": 1794043200, "hours": 12, "grants": [ ... ], "absent": ["<pk>", ...], "sig": "..." }
```

`grants` is ordered by `by` and `absent` is ordered; neither names a key twice, the
executor, or a key of the other. Every host checks of a claim what does not depend on
its own state: each grant is signed by its `by` and names the claim's pool, task,
executor, round and `gen`; all grants carry one `hash` and one `exp`; and
`exp - 120 <= claimedAt <= exp`. Who was absent is the claimant's word.

### Conflicts

Every conflict is settled by a value all hosts compute alike.

- **Rank.** `rank(taskId, executor) = H("dn1/rank" || 0x00 || taskId || 0x00 || executor)`.
  Lower wins.
- **Two claimants locking at once.** A claimant challenged with `locked` compares ranks
  with the `holder`. The one that ranks worse sends `unlock` to every member it locked and
  stands down; the one that ranks better re-sends its lock to the members that challenged
  it, until they grant or the round times out.
- **Two claim records for one task.** Exactly one stands, by the first of these that
  tells them apart: the higher `gen`; the better rank of the executor; the lower `round`
  (compared as base64url strings); the higher `seq`; the lower `H(canon(record))`. This
  order is total and transitive, so every host that has seen the same claims holds the
  same one, in whatever order it saw them.
- **Two sides of a partition each saw the other absent.** Both claimed on the same state,
  so both claims have the same `gen` and the better rank is the claim. The other executor
  stops its run the moment it learns of it.
- **A claim made after another ended.** The members that granted it saw the earlier claim
  released, completed or lapsed, so it is the next `gen` and stands over the earlier one,
  whatever that one's rank and whatever versions of it surface later.

To keep hosts from racing for the same task, a host waits before step 1 for a delay
proportional to its rank on that task, up to 5 s.

## 8. Hours, leases and the heartbeat

- A requester sets `minRequiredH` on every offer: the hours the task may take from start
  to finish. The default and the floor are 12.
- A member publishes `maxAcceptedH` in its `member` record: the longest task it takes.
  The default and the floor are 12.
- A task's `hours` is the largest `minRequiredH` among its open offers. A host may claim
  a task only when its `maxAcceptedH` is at least that.
- A claim is leased for 2 hours at a time. `deadline = claimedAt + hours * 3600`, and a
  held claim at `seq` has `leaseUntil = min(claimedAt + (seq + 1) * 7200, deadline)`.
- From 10 minutes before `leaseUntil` until the claim lapses, a host offering the task
  sends the executor a `ping`: `{ pool, taskId, executor, round, n, by, ts, sig }` with
  `n` the `seq` it asks for, one more than the claim's. The executor must answer with its
  claim at `seq = n`, `leaseUntil` moved 2 hours on (never past `deadline`), and the ping
  embedded as `ping`. The offering host pushes it to the pool.
- Every host checks of a held claim with `seq` above zero that it embeds a ping signed by
  its `by`, for that pool, task, executor and round, with `n = seq` and `ts` in the window
  of the lease before it: from 600 s before that `leaseUntil` to 600 s after. A held claim
  at `seq` zero embeds none. A claim whose `leaseUntil` has reached `deadline` has nothing
  left to extend.
- A claim is **active** while `state` is `held` and `now < leaseUntil + 600`. Past that
  it has lapsed: every host treats the task as available again, the executor stops the
  run, and the requester's key is dead.
- An executor that finishes or gives up pushes its claim at `seq + 1` with `state`
  `completed` or `released`, without a ping. A member that left holds no claim.

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
