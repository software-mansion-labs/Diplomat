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
request envelope) and a JSON response (the response envelope).

A target decides how large a body it reads before it has read it, when nothing of the
request is checked yet. So it reads 64 KiB from anyone, which is room for any `hello`,
and more only in a place the sender reserved: a member first sends a `reserve` request
(section 6) - small, signed and paid for like every request - naming the kind and the
size of the request to follow, and is answered with a ticket of 16 random bytes. The
large request carries the ticket in the HTTP header `dn-ticket`, and is read when the
ticket is live and the declared length is no more than was reserved. No other header
means anything to a target: words nobody signed buy nothing, and without a live ticket
every sender gets the 64 KiB, whoever it says it is.

- A member may reserve up to 1 MiB, and a member that holds a live key of the target
  (section 9) up to 48 MiB for an `act`.
- A ticket is good for one request, and is void when that request's headers have not
  arrived 60 s after it was given. A member that reserves again gives up the ticket it
  held.
- A member has one place at a time and a target four in all, counting the tickets not
  yet used and the bodies being read and served. A place is free again once its request
  was answered, refused or abandoned, however long that took. A `reserve` that finds no
  place free is answered `busy`.

A request over what the target will read is answered with HTTP status 413 and no envelope;
its sender may send it again, with a ticket of its own each time, unless it is an `act`:
a transport may send the same bytes twice, and the copy refused unread may follow one
that was read (section 9).

What a connection can cost a target before any proof of work is checked is bounded: its
headers are at most 8 KiB and have 20 s to arrive; a body without a ticket is at most
64 KiB and has 20 s more, plus 1 s per 32 KiB; a target holds 256 connections, and at
that number closes the idle ones and drops a new one unanswered. That is 72 KiB and 42 s
a connection, 18 MiB in all. A body with a ticket has the same 20 s plus 1 s per 32 KiB -
26 minutes for 48 MiB - and holds its place that long. Senders cannot be told apart
behind Tor, so there is no limit per sender: whoever keeps 256 connections busy with
bytes that are never a request keeps others out for as long as it keeps that up.

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
never repaired. A request and a response travel as their canonical bytes and as nothing
else: bytes that are JSON written any other way - whitespace, keys in another order, a
key given twice, a number or a string spelled as `canon` does not spell it - are no
envelope. Such a request is refused (`bad-request`), and such a response is no answer.

## 3. Request envelope and the proof of work

```json
{ "v": 1, "pool": "<pool id>", "kind": "<kind>", "from": "<pk>", "to": "<pk>",
  "ts": 1794000000, "body": { },
  "pow": { "epoch": 498333, "nonce": "<16 bytes b64u>", "effort": 16384, "counter": "<8 bytes b64u>" },
  "sig": "<b64u>" }
```

Every request carries its own proof of work. None is ever accepted without one.

- **Public seed.** `seed(to, epoch) = H("dn1/seed" || 0x00 || to || u64be(epoch))` with
  `epoch = floor(ts / 3600)`. `ts` is within 300 s of the target's clock, so the epoch of
  an accepted request is the target's own or one directly beside it.
- **Work seed.** `nonce` is 16 fresh random bytes per request. A target remembers every
  `(from, nonce)` it accepted for as long as the epoch stays acceptable - its own and the
  ones directly before and after it - and refuses a repeat.
- **Challenge.** `c = H("dn1/pow" || 0x00 || seed || to || from || nonce || u32be(effort) || H(canon(core)))`
  where `core` is the envelope's `v, pool, kind, from, to, ts, body`.
- **Solution.** `counter` is 8 bytes such that, with `R` the first 4 bytes of
  `blake2b-512(c || counter)` read big-endian, `R * effort <= 0xFFFFFFFF`. A solution
  costs `effort` hashes on average and one hash to check. `effort` is an integer from 1
  to 2^32 - 1.
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

A target checks, cheapest first, and stops at the first failure:

| Check | Refusal |
| --- | --- |
| envelope shape and size | `bad-request` |
| `to` is its own key | `bad-request` |
| `ts` within 300 s of its clock | `stale` |
| `pow.epoch` is the epoch of `ts` | `stale` |
| `effort` at least `required(from)` | `effort` |
| the solution | `bad-request` |
| the signature | `denied` |
| `(from, nonce)` unseen | `replay` |

Only a request that passed the signature counts toward its sender's `n`; a failure before
that counts toward the stranger counter.

### After a start

The memory of the `(from, nonce)` pairs a host accepted is its running process's. So a
host keeps on disk the latest `ts` among the requests it served, and after a start serves
no request dated at or before the latest it served before it went down: such a request,
having passed every check above, is answered `busy`. Nothing was done for it, and its
sender sends it again in a fresh envelope - once, 1.5 s later, for every kind but `act`
(section 9). The counters behind `required` are the process's too, and start from
nothing.

A sender whose clock runs ahead of the target's, inside the 300 s, moves that mark ahead
with it: after a start the requests of every other sender are `busy` until their own
clocks have passed it.

### What a sender pays

A sender pays what the target's last answer asked for. It never pays more than the most
the table above lets a target ask - 16384 << 12 = 262144 << 8 = 67 108 864 - and a target
that asks for more is not sent that request again. A request refused for `effort` is sent
again at the price asked, at most three times.

For one peer a host does at most 16384 << 14 = 268 435 456 hashes of work in any hour:
four requests at the highest price, or 16384 at a member's base. Once that is spent it
sends that peer nothing until the hour has moved on. So the most one member can make
another host work is that much an hour - about four minutes of one core at a million
hashes a second - however it prices itself.

## 4. Response envelope

```json
{ "v": 1, "ok": true, "re": "<H(canon(request)) b64u>", "body": { }, "effort": 16384, "sig": "<b64u>" }
```

`effort` is what the target would require of this sender's next request. A refusal has
`"ok": false` and `"error": { "code": "...", "detail": "..." }` in place of `body`;
`detail` is at most 200 characters. Codes: `effort` (too little work; `effort` says how
much), `stale` (clock or epoch), `replay`, `not-member`, `bad-request`, `denied`, and
`busy` (the target could not serve the request this once: it has only just started, it
has no place free, or it failed). A request that is not the canonical form of anything
is answered with `re` over its bytes as received. A sender takes a response only when it
is signed by the target and `re` names the request it sent.

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
300 s past the receiver's clock is refused until its time comes. A host signs each
version of a record of its own with an `at` no earlier than the version before.
`offer.state` is `open`, `cancelled` or `done`; `createdAt` is when the host began to
offer the task and stays the same through every version until the offer ends. An offer
never carries the prompt. A member that started its pool has no `voucher`.

Limits: a pool id is at most 200 characters, `host/owner/repo` or deeper, of `a-z`,
`0-9`, `.`, `_` and `-`; `kind` is `[a-z][a-z0-9-]{0,31}`; `item` is
`[a-z0-9][a-z0-9._-]{0,63}`; `identity` is `[a-z0-9][a-z0-9._-]{0,99}`; `title` is at
most 300 characters with no control character; hours are 12 to 720; `attempt` is 1 to
255; a claim lists at most 256 grants and 256 absent members; a time, a `seq` or a `gen`
is at most 2^40.

### How much a pool holds

- **256 members.** When a host accepts more member records than that, the live ones are
  the 256 most senior: the fewest vouchers away from a member that has none, then the
  earliest `joinedAt`, then the lowest `pk`. A member is further from the root than the
  one that vouched for it, so none is seated without that one. The others are not live
  (`full`). A host counts itself first in its own state: a host the others have no seat
  for is a member only where it looks itself, and its hash is nobody else's. A host makes
  no invite while it holds 256 member records of a pool.
- **Per member: 64 offers, 64 claims, 256 KiB.** A member has at most 64 offers and 64
  claims live, and its live records - its member record, the offers and the claims it
  signed - take at most 256 KiB together in canonical form. Offers, then claims, are
  counted in key order against what their signer has left, and one that does not fit is
  not live (`quota`): which records those are depends only on the records held, so every
  host drops the same ones. A record that ended counts for as long as it is live, so a
  member makes at most 64 offers and 64 claims in a pool in any 24 hours. A host signs
  no offer and no claim of its own that would not fit with 32 KiB to spare, the later
  versions of a record being longer than the first.

So a member's records never take more than 256 KiB of a pool, and a pool's never more
than 64 MiB, which takes every seat filled to its quota. A host keeps a pool as one
document and writes it whole when a record changes; a pool of ten members with 64 offers
each is half a megabyte. A claim carries the grant of every member that gave one, about
0.5 KiB plus 0.4 KiB per grant, and an executor's claims of the last day share its 256
KiB: in a pool of ten members an executor makes about fifty claims a day, in a pool of
fifty about ten, in a full one two.

### Task ids

```
taskId = <pool id> "#" <kind> ":" <item> "@" <identity>
```

`identity` is the forge login the work is done as, lowercase. Two hosts acting as the
same login on the same item offer the same task; two different logins asking for the
same item are two tasks.

A task is as finished as its most finished offer. A `done` offer ends every offer of the
task that was created no later than it was signed (`createdAt <= at` of the done offer):
the task is **done** for every host as soon as one offering host says so, whatever the
other offers say, and a host that sees its own open offer ended this way signs it `done`
itself. An offer created after that offers the task anew. A task is **cancelled** only
when no offer of it is open and none is done; a host that sees another host cancel an
offer of a task it offers too, signed no earlier than its own was created, cancels its
own. Both are facts, and need nobody's consent.

A task is **available** while a member has an open offer of it that no done offer ended,
and it has no active claim.

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
held, does not say `left`, and was signed within the last 24 hours: they are who a claim
needs the consent of, and the only hosts whose offers and claims count. A host that stays
in a pool signs its member record again, with a higher `seq`, every 6 hours. One that
stops is no member a day later, and nobody waits for it; its key stays accepted for as
long as its record is live (below), so it comes back by signing the record again.

A host lets in a key it has not accepted before only by `hello`, and only while the
invite is unexpired. Any member that accepts the invite's signer can be greeted, not only
the signer. A member a host learns of from another member needs no unexpired invite: that
member let it in.

A member that left was put out by nobody, and comes back as the member it was: it signs
its record again - a higher `seq`, the voucher it held, no `left` - and greets the
members it knew. A host whose vouchers still connect it to that key lets it in by that
`hello`, with no unexpired invite. A member record is held for 30 days after it was
signed; a host that stayed away longer is forgotten, and enters by a new invite.

An invite is good for the membership it was given in. A host keeps the nonce of every
unexpired invite it signed since it last became a member, and lets in nobody by an invite
of its own that is not among them: one it signed before it left the pool, or before it
lost what it stored.

The host a newcomer greets may not have heard yet of the member that invited it. So
`hello` carries a `chain` beside the newcomer's own record: the member records that lead
from it toward the pool's root - its inviter's, that one's inviter's, and so on - at most
8 of them. The greeted host takes them in together with the newcomer's record, before it
decides. A record of the chain whose key it has not accepted before is held to the same
rule as the newcomer's: its invite must be unexpired, or it is left out.

### Live records and the state hash

```
stateHash(asOf) = H(canon([[key, H(canon(record))], ...] sorted by key))
```

over the records live at `asOf`. Whether a record is live depends only on the records
held and on `asOf`, so two hosts holding the same records hash the same set:

- Every version of an offer or a claim is live for 24 hours after its `at`, whatever its
  state. A host that still offers a task signs its open offer again, with a higher `seq`,
  every 6 hours; a held claim is signed again by every lease extension.
- Every version of a member record is live for 30 days after its `at`, and beyond that
  for as long as the voucher of a live member is signed by it: dropped, it would cut that
  member off.
- A member is live only while its key is accepted and it has a seat (above). An offer or
  a claim is live only while the member record of its signer is, and while it fits its
  signer's quota (above).
- A claim is live only while a host that stands behind it has a live offer record of its
  task: its executor, or a member whose grant it carries (section 7). A claim that
  embeds a ping is live only while the ping's signer has one.

A record that is not live is dropped, and refused when it arrives. `asOf` is
chosen by whoever asks and is refused when more than 300 s from the answerer's clock, so
a host keeps every record for 300 s past the moment it stops being live.

Nothing that ended comes back. A version that wins over another of its key was signed
no earlier, so it is dropped no earlier: by the time a host forgets that an offer was
`done` or `cancelled`, that a claim was `released` or `completed`, or that a member
`left`, every version it replaced is too old to be taken in again. A host that was cut
off for days can push everything it still holds and reopen nothing. The same holds
across the claims of one task: a claim is made only on a state in which the claim record
before it lies in the past (section 7), so it too is signed no earlier than what it
stands over. The retention must stay far longer than a lease and its grace.

A host that left a pool keeps none of its records, and a member that did not hear it
leave still holds them: joined again, the host may be handed an open offer it cancelled
or finished on its way out, or a held claim it gave back. It ends them again: an open
offer of its own that it no longer makes it signs `cancelled` or `done`, as that offer
ended, and a held claim of its own with no run behind it it signs `released`.

## 6. Requests between members

Every kind but `hello` is refused with `not-member` unless `from` is a key the target
accepts in `pool` whose member record, when held, does not say `left`. A sender a host
does not take for a member gets that one refusal, with an empty `detail`, whatever the
pool - one the host is a member of, one it left, one it never heard of - and whatever it
asked: the answer says nothing about the pools a host is linked to. A `hello` that is
refused is answered the same way, unless it carries an invite to the pool signed by a
key the host accepts: its sender was asked in, and is told why it is not let in.

| Kind | Body | Answer |
| --- | --- | --- |
| `hello` | `{ member, chain? }` - the sender's own record, and the records leading to its root | `{ index }` |
| `sync` | `{ asOf, hash }` | `{ hash }`, plus `{ index }` when the hashes differ |
| `pull` | `{ keys }` | `{ records }` |
| `push` | `{ records }` | `{ accepted, refused: [{ key, code }] }` |
| `lock` | `{ taskId, round, asOf, hash, hours }` | `{ grant }` or `{ challenge }` or `{ stale: true }` |
| `unlock` | `{ taskId, round }` | `{ }` |
| `ping` | `{ ping }` | `{ claim }` |
| `key` | `{ taskId, round }` | `{ capability, secret, spec }` |
| `act` | `{ taskId, keyId, seq, request, mac }` | `{ status, headers, body }` |
| `done` | `{ taskId, round, outcome }` | `{ }` |
| `reserve` | `{ kind, bytes }` | `{ ticket }` |

`index` maps every live key to `[precedence, H(canon(record))]`. `pull` takes at most 4096
keys and `push` at most 1024 records. A `pull` is answered with the records under the
first of its keys that fit 60 KiB together, in the order asked, and the asker asks again
from the key after the last record it was given; a host puts no more than 60 KiB of
records in one `push`. So gossip stays under the body any sender may send (section 1); a
record larger than that travels alone. Member and offer records are asked for and pushed
ahead of the claims that rest on them. `accepted` lists the keys the target now holds as
pushed; a refused record has an empty `key` when it is too malformed to have one, and its
`code` is `bad-record`, `wrong-pool`, `future`, `older` (the target holds a version that
wins), `bad-signature`, `bad-voucher`, `bad-claim`, `bad-grant`, `bad-lease`, `bad-ping`,
or the reason it would not be live (section 5): `expired`, `not-member`, `full`, `quota`
or `no-offer`. Records pushed together are taken in together, so a member record lets in
the records that depend on it, and an offer the claim that rests on it, whatever their
order.

Objective facts - a member announcing itself, a task appearing, a task cancelled because
its issue or pull request closed, a committed claim - travel by `push` and need nobody's
consent. A host pushes every record it signs to every member. Two records are also
pushed by a host that did not sign them: a newcomer's member record, by the host that
answered its `hello`, and a lease extension, by the offering host whose ping it answers.
A record learned by `push` is not pushed on, and a push that goes unanswered is not
repeated: every 60 s a host sends `sync` to every host whose member record it holds -
less often, down to once in 10 minutes, to one that does not answer - which carries
each record to whoever a push missed. A host that leaves a pool signs its member record
`left`, ends its claims, cancels its offers, and pushes all of it once. The locks it
granted bind it through their `exp` all the same, should it join again before. It
keeps the `left` record, and the keys of the members it left, for as long as it is not a
member again: one of those keys that asks it about the pool has not heard, and is pushed
that record, at most once in 10 minutes. Nobody else is sent anything. A host dials,
pushes to and solves a proof of work for only the keys a pool's own records name as its
members; a key it knows from a request alone it answers and nothing more. A host that
stops taking part without leaving - its network is switched off - cancels its open
offers and gives its claims back the same way, pushes that once, and stays a member for
as long as its record is fresh.

`done` tells a host offering a task how its run ended: `outcome` is
`{ ok, summary, microUsd, tokens, runner, model }`, the cost in millionths of a dollar,
`summary` at most 4000 characters. Its envelope is all that authenticates it. The host
takes it only when the envelope's sender is the executor of the claim record the host
holds for that task, `round` is that claim's round, and the claim is active or was ended
by that executor (`completed` or `released`); otherwise it answers `denied`. A `done`
for a round that already reported, or for a claim that was not made for the offer the
host has open (section 9), changes nothing. A lapsed claim reports nothing, and neither
does any other member,
whatever it knows of the key: no key and no MAC is involved, so an offering host that
issued no key decides the same way. On a `done` with `ok` the host signs its offer
`done`; without, the attempt failed and the task is offered again, or cancelled after
the third failed attempt. A claim that lapses (section 8) is a failed attempt too; a
claim its executor released without a `done` is none. An executor with an outcome to
report sends `done` to every host offering the task, again every 30 s until one of them
answers or its claim is no longer active, and only then ends its claim.

A request may arrive twice, or be answered and the answer lost. Every kind is safe to
send again in a fresh envelope: a `lock` of the same executor and round is granted the
same way, `key` answers with the same capability and secret, `unlock`, `push` and `done`
change nothing the second time, `reserve` gives a new ticket for the same place, and
`act` is guarded by its `seq` (section 9).

## 7. Claiming a task

A claim is the one thing that needs consent. A host with a free slot that sees an
available task:

1. **Confirms its own state.** It computes `stateHash(asOf)` over what it holds. Whether
   an offered item is still open is its offerer's to say: the offerer cancels the offer
   of an item that closed.
2. **Confirms it with every member.** It sends `sync` to every other member and repairs
   differences until all that answer report its hash. A member that has answered nothing
   in this round when a request to it goes unanswered is **absent** for this round; a
   member that has answered anything is **present**.
3. **Sends a lock to every present member**: `{ taskId, round, asOf, hash, hours }`,
   `round` a fresh random 8-byte value and `hours` the task's hours (section 8) in the
   state the round confirmed.

A member is absent only by this round's own request to it: what earlier requests came
to decides how long the round waits, never whether it asks. A signed refusal is an
answer, and its sender is present - but for `stale`: a member whose clock is more than
300 s from the claimant's can take no request of the claimant and give it no grant it
could use, and counts as one that did not answer. The first connection to an onion
service can take minutes, while a member that is gone must not hold up every round, so
the wait for one member's answer is:

- 60 s for a member that answered the claimant within the last 3 minutes;
- 60 s, asked again until the round is 90 s old, for a member the claimant has known for
  less than 3 minutes and never reached;
- 15 s for any other.

A host claims only while it has a slot to run the task in, and looks again before it
commits: a claimant whose slot went while its round ran unlocks every member that
granted and stands down. A task its own host offered to run at once is the exception:
its host claims it whatever its slots, without the rank delay below, through the same
three steps. A claimant that cannot send - its own transport is down - writes nobody off
as absent for it: it stands down.

A member answers a lock with:

- `{ stale: true }` when its hash at `asOf` differs - the claimant goes back to step 2;
- `{ challenge: { reason, holder? } }` when the task is not available by its own clock,
  the claim record it holds for the task is dated after `asOf`, or that record is at
  the last generation a record can carry (`unavailable`); when the claimant's
  `maxAcceptedH` is below the task's hours, or the lock asks for other hours than the
  task has in the member's own state (`hours`); or when it has already granted or is
  itself claiming the task for another executor (`locked`, with that executor as
  `holder`);
- `{ grant }` otherwise: `{ pool, taskId, executor, round, gen, hours, hash, by, exp, sig }`,
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
executor, round, `gen` and `hours`; all grants carry one `hash` and one `exp`; and
`exp - 120 <= claimedAt <= exp`. Who was absent is the claimant's word, and excuses
nothing: a claim stands by the grants it carries (below).

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
proportional to its rank on that task, up to 5 s. A host may wait longer, up to a minute
more: how well a task suits a machine is weighed by the host that would take it, on what
that machine has, and neither that nor the wait is told to anyone. A task its own host
offered to run at once waits for nothing.

### What gives a claim standing

A claim record is live - it holds its task, stands over another claim, is extended, is
reported on - only while a host that offers the task stands behind it: its executor,
when that host offers the task itself, or a member whose grant the claim carries, for as
long as that host holds a live offer record of the task. This is part of what makes a
record live (section 5), so every host applies it when a record arrives, the host that
offers the task and a bystander alike, and a claim without it is refused (`no-offer`)
and enters no pool. With the checks above it comes to this:

- **A grant is consent to one thing**: this executor, this task, this round, this `gen`,
  these hours, on this state. A member grants only the hours the task has in its own
  state, and a claim for other hours than its grants name is refused (`bad-grant`). So
  the hours of a claim are its offer's, and its `deadline`, every lease and every key
  (sections 8 and 9) end `hours` after `claimedAt`.
- **A claim nobody granted is no claim**, and neither is one granted only by members
  that do not offer the task. `absent` may name any member but cannot stand in for the
  host that offers the task: an offerer that cannot be reached cannot act for the task
  either, so nothing is lost by waiting for it.
- **Nothing but a claim with standing replaces a claim.** A later generation, a release
  and a completion are claim records, signed by their executor and judged as any other:
  only its executor ends a claim, and a member that does not offer the task can put no
  record over one, whatever `gen` it writes.
- **An offering host acts only on a claim it agreed to.** It asks for the extension of a
  claim, issues its key, takes its `done` and counts its lapse as a failed attempt only
  when the claim is its own or one it granted, in a round it noted while the offer it
  has open was open (section 9).
- **The generations end.** `gen` is at most 2^40. A claim record at that generation has
  no successor: no member grants a lock over it and no host begins a round, until the
  record is no longer live.

What remains, and nothing in a record hides it:

- **A member that offers a task is a requester of it.** Any member may sign an offer of
  any task, and one that offers a task another host offers too stands behind a claim of
  it as that host does - its own included, with no grant from anyone. Such a member can
  put a claim over one that stands, by writing a later `gen`: the executor stops, and the
  task is held until that claim's lease lapses, or for as long as the member extends it
  by its own pings, up to the hours. It can use up the generations the same way. It gets
  no key from the other requester and reports nothing to it, so it cannot act as that
  requester or end its offer; it can keep the task from being done. Hosts that offer the
  same task act as one forge login, and trust each other this far.
- **Two hosts that offer one task, separated.** Each can grant a claim on the same state
  while it cannot reach the other. Both claims have the same `gen`, the better rank is
  the claim once the two sides meet, and the other executor stops then with whatever it
  had done.
- **A grant is good for 120 s.** A claim made inside that time on a state that has since
  moved on is taken in when it surfaces, and stands or not by `gen` and rank.
- **A lease that lapses on one side of a partition.** When the two hosts offering one
  task are separated, the executor may keep extending its claim through the offering
  host on its own side while, on the other side, the claim lapses unseen and the task is
  claimed again as the next generation. After the partition heals the later generation
  stands for every host, and the earlier executor stops the moment it learns of it, with
  whatever it had done until then.
- **A claim lives no longer than the offer records behind it.** When the last of them is
  dropped a day after it was signed, the claim goes with it, also the record of a claim
  that ended.

## 8. Hours, leases and the heartbeat

- A requester sets `minRequiredH` on every offer: the hours the task may take from start
  to finish. The default and the floor are 12.
- A member publishes `maxAcceptedH` in its `member` record: the longest task it takes.
  The default and the floor are 12.
- A task's `hours` is the largest `minRequiredH` among its open offers. A host may claim
  a task only when its `maxAcceptedH` is at least that, no member grants it a lock
  otherwise, and the `hours` of a claim are the ones its grants name (section 7).
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
- A held claim is dated by what it answers: at `seq` zero its `at` is its `claimedAt`,
  and an extension's `at` is within 300 s of its ping's `ts`. An executor answers a ping
  only when that `ts` is within 300 s of its own clock. So a version's retention, which
  runs from `at`, cannot be made to end while its lease still holds.
- An executor extends a lease only for a job it started and has not seen end. Asked
  about a claim whose job is gone, or one still waiting for its key, it answers
  `denied`.
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

1. After its claim is committed, the executor sends `key` to a host offering the task:
   the lowest `pk` among the offering hosts that granted the lock, the executor itself
   counted when it offers the task.
   Any other host answers `denied`.
   The executor asks again 30 s after each ask that brought no key, and releases its
   claim when its first lease would run out first.
2. That host checks that the claim in its own state names this executor and round, is
   active, has not reported how its run ended, and was made for the offer the host has
   open: a task that ended and was offered again is a new offer, and a claim of the old
   one gets nothing from it - no key, no `done`, and its lapse is no failed attempt. The
   host tells by the round: it notes every round it grants a lock for while an offer is
   open, and a claim it granted is of that offer when its round is among them. A claim
   it did not grant is not of its offer; its own claim of a task it runs itself is, when
   `claimedAt` is no earlier than the offer. It issues one key
   per claim: asked again for the same claim it answers with the same capability and
   secret, and a key it issued for an earlier claim of the task is revoked first. It
   answers with:
   - `capability`: `{ keyId, pool, taskId, executor, host, rules, exp, sig }`, signed by
     that host - `keyId` is 16 random bytes, `rules` is the exact list of requests this
     task may make (section 10), at most 128 of them, `exp` is `leaseUntil + 600`;
   - `secret`: 32 random bytes;
   - `spec`: what the executor needs to run the task - the prompt, the item, the base
     revision, and the name and email commits are authored with.
3. Each `act` request names the `keyId`, carries a strictly increasing `seq`, one forge
   request, and `mac = HMAC-SHA256(secret, canon({ keyId, seq, request }))`:

   ```json
   { "host": "api.github.com", "method": "POST", "path": "/repos/o/r/pulls/578/reviews",
     "headers": { "content-type": "application/json", "accept": "..." }, "body": "<base64>" }
   ```

   `path` carries the query string, if any. Header names are lowercase. `body` is
   padded base64 (RFC 4648 section 4), here and in the answer. The host
   performs it only when: the envelope is signed by the capability's executor; the key is
   unexpired and unrevoked; the claim is still active for that executor; `seq` is greater
   than every `seq` used under the key; the MAC matches; and the request matches a rule.
   A request whose MAC matched has used its `seq` whether or not a rule covered it. The
   host sends the request to the forge with its own credentials and answers
   `{ status, headers, body }`. A request no rule covers is answered the same way, with
   status 403 and a JSON body `{ "message": "<why>" }`; a forge that cannot be reached,
   with status 502.
4. Each lease extension moves `exp` with it: the host signs the capability again under
   the same `keyId` and secret. An `act` names the key and does not carry it, so the
   executor has nothing to fetch. A lapse, a `done`, a cancelled offer or a better-ranked
   claim revokes the key.
5. Both sides write a `seq` down before they use it: the executor before the request
   leaves, the host before it asks the rules. Requests under one key are served one at a
   time, in the order their numbers were accepted, and a request whose key was revoked
   while the rules were asked is answered `denied` and not performed. An `act` refused
   for want of work (`effort`) was not looked at, and goes out again as it is, under the
   same `seq`. One whose answer never came, came as `replay` because the request arrived
   twice, came as `busy`, or came as HTTP 413, may have been performed. The executor
   sends it again, under a new `seq`, only when the forge request is a `GET` or a
   `HEAD`; for any other it tells the job that the outcome is unknown.

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
- `"deny": "<why>"` makes the rule refuse what it matches, with that reason: a carve-out
  placed before a wider rule. `"without": { ":": "<why>" }` refuses a path any segment of
  which, once decoded, holds the character.
- `"query": { "service": { "equals": "git-receive-pack" } }` pins query parameters:
  `"free"`, `equals`, `oneOf`, or `search` - a forge search string that must carry
  `repo:<owner>/<name>` exactly once as a term of its own, with no other repository,
  organisation or user qualifier, no negation and no top-level OR. Its terms are told
  apart by the plain space alone; a quote may wrap a whole term or the whole value of one
  qualifier, and what it wraps holds no qualifier. A pinned parameter is required unless
  `optional` and is given once. A parameter the rule does not name is refused on a write,
  because a forge reads a write's parameters from the query as readily as from the body,
  and on a read whose rule carries `query`. `sudo`, `private_token`, `access_token`,
  `job_token` and `_method` are refused always.
- `"body": { "event": { "oneOf": ["COMMENT"] }, "body": "free" }` pins a JSON body member
  by member. The body is parsed strictly (`application/json`, UTF-8, no duplicate key) and
  a member the rule does not name is refused. A member is `"free"`, or pinned with
  `equals`, `oneOf`, `prefix`, `prose` (text with no line starting with `/`, which GitLab
  would run as a quick action), `created` (a branch this task created, from which it has
  opened no pull request yet; `"created": "label"` reads the member as GitHub's head
  label, which is `branch` for a branch of the pool's repository and `account:branch`
  for one in that account's fork of it) or `"assignees": <issue>` (the whole new list of that
  issue's assignees, as account ids: the list the forge holds now, with the task's own
  account added or taken away and no other change), and may be `required` - which the
  pinned query parameter of the same name satisfies as well. What is sent to the forge is
  the parsed body, written out again. A rule without `body` takes no body.
- `pull` and `comment` have the forge asked, before anything is sent, which pull request
  the number or comment id in the path belongs to, who opened or wrote it and whether it
  is open or pending. `"project": { "segment": 3, "owner": "me", "repo": "group/proj" }`
  has the forge asked what the project named in that path segment is: the request is
  allowed only when it is the fork of `repo` that the account `owner` holds itself (see
  `fork` below), and a `created` branch of that rule is one this task created in that
  fork. `pick` lists the members of the forge's JSON answer an executor
  gets back - of each entry, when the answer is a list. An answer that is neither an
  object nor a list of objects is not passed on.
- `{ "graphql": { "forge": "github", "repo": "o/r", "roots": [...], "mutations": [...],
  "item": { "type": "pr", "number": 578 }, "identity": "me" } }` on the GraphQL endpoint
  confines the document, which must be exactly one query or mutation. A query may select
  only the listed root fields: `repository` (GitLab: `project`) pinned to the pool's own,
  the viewer's public scalars, a `search` confined as above, and `node(id:)` once the id
  has been resolved to an object of the pool's repository. Below a root, a field with a
  selection set must be one the reader knows the reach of, so a selection cannot walk from
  the repository to its owner's other repositories; on an account, or on an object that
  may live in another repository, such a field takes no argument, which would look
  another object up from there. Of a branch's protection one scalar is read, whether its
  checks must be up to date. A mutation must be a single field
  from the list, its input may hold only the members the reader's table names, and every
  object it addresses is resolved on the forge and must belong to the task's own item.
- `{ "git": "receive-pack", "repo": "o/r", "refs": ["refs/heads/**"], "create": 1,
  "denyPaths": [".github/workflows/**"] }` on the two smart-HTTP push endpoints of a
  repository confines a push. Without `fork` the repository is `repo`, the pool's own,
  and no other. With `"fork": "me"` the rule's path names a repository of that account
  (`/me/*/info/refs`, `/me/*/git-receive-pack`), and the push is allowed only when the
  forge says the repository at the path belongs to that account and is a fork of `repo`
  itself, both compared without regard to case. A repository the forge does not show,
  one of another owner and one that is not a fork of `repo` are refused in the same
  words. No ref may be deleted. A ref may be created when `refs` covers it, up to
  `create` refs per task, counted over `repo` and the fork together; it may be updated
  when it is a ref this task created in the repository the push goes to, or the head
  branch of the pull request `"head": { "number": 578 }` names (`{ "author": "me" }`: of
  any open pull request by that author) - an open pull request of `repo` whose head
  branch the forge places in the repository the push goes to. The default branch of
  that repository, and a branch the forge reports as protected there, is never created
  or moved. The forge is asked where each ref is: a creation
  must be of a name the forge has no branch of, an update must start from the branch's
  current value and be a fast-forward of it, proven by indexing the pack in a quarantine.
  No pushed commit may add, change or delete a path under `denyPaths` - compared without
  regard to case - except to what one of its parents holds there; a commit in the pack
  that a branch of the forge holds already is the forge's own and is not compared. The
  push must build on commits a branch of the repository pushed to holds - for a fork, a
  branch of the fork or of `repo`, which are the two repositories the quarantine
  fetches from. On GitLab the file the project is set to
  read its CI configuration from, when it is a file of the project's own repository, is
  under `denyPaths` too; for a push to a fork, the fork's file and `repo`'s both are.
  The push must ask for the forge's report (`report-status`);
  push options, a `shallow` line, a ref name that is not UTF-8, a pack holding an object
  git's own check calls broken, and a pack whose objects add up to more than 512 MiB once
  unpacked - a delta counted as the object it builds - are refused.

A rule carrying `graphql` or `git` never allows a request by its host, method and path
alone: its own check must pass too.

Where a check asks the forge - who opened a pull request, where a branch is, which branch
is the default, who is assigned, whose a repository is and what it is a fork of - only
an answer that settles the question is used. A
forge that says there is no such thing has answered; a rate limit, an error or anything
else has not, and the request is refused.

What a rule lets a task use up is counted for the task, not for the key: the branches it
may create, and one pull request from each. A branch in a fork is counted with the
others and kept under the fork's name, so it is never taken for the branch of that name
in the pool's repository. The host keeps the count with its offer, on
disk, so a key issued for a later claim of the same offer goes on from where the last one
stopped, and a restart forgets nothing. A creation is counted before the push is sent. The
branch is "a ref this task created" once the forge's report says `ok` for it; a creation
the forge declined is given back; one whose outcome is not known stays counted and is not
the task's to move or to open a pull request from.

The rules a task receives come from the daemon's catalogue (`src/requester/rules.js`),
keyed by forge and kind and pinned to the task's own item. A kind without an entry can be
offered by nobody.
