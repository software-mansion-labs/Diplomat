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

The seed is public and names the hour, not anything the target chose: work for an hour to
come can be done ahead of it. A request solved today for a `ts` a month from now is
accepted in that hour. What bounds this is what a request costs when it arrives - it
counts toward its sender's volume like any other, and the price it paid is the one it
stated, checked against what is owed at that moment - and what its body may say then:
a state hash, a claim or a ping of an earlier day holds for nothing.

### Required effort

The target decides how much work a request owes; it rises with the requests it is
receiving.

```
required(sender) = BASE << min(CAP, max(0, ceil(log2(n / ALLOW))))
```

`n` counts the requests accepted from that sender in the last 60 seconds, this one
included. A sender that is not a member of the request's pool on the target is a
stranger: all strangers share one counter, and their `BASE` is 16 times higher. The
price a request must meet is that of the sender it names: a member's for a key the
target takes for a member of that pool, a stranger's for any other.

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
| the solution | `effort` |
| the signature | `effort` |
| `(from, nonce)` unseen | `replay` |

A request is authenticated once its solution and its signature hold. What a target
answers before that says nothing of the keys and pools it knows. Too little work, a
solution that does not hold and a signature that is not the sender's get one refusal -
`effort`, with the `detail` `the work or the signature of this request does not hold` -
and every refusal up to there quotes one price as the `effort` of its envelope (section
4): what a stranger owes at that moment, whatever key and pool the request named. So a
request made of nothing, under the target's own key or a member's, in a pool the target
is linked to or not, is answered alike. A member learns what it owes from the answers to
its authenticated requests; one that paid too little pays the stranger's price once, and
the answer to that names its own.

What counts toward `n`: an authenticated request, toward its sender; and a request
whose solution holds at a stranger's price and whose signature does not, toward the
strangers. Nothing else. Work that was not done raises nobody's price. A solution at a
member's price under a member's key, without that member's signature, raises neither
that member's price nor the strangers': it costs its sender a member's `BASE` of hashes
and the target one signature check, each time, at a price that does not rise.

### After a start

The memory of the `(from, nonce)` pairs a host accepted is its running process's. So a
host keeps on disk the latest `ts` among the requests it served, and after a start serves
no request dated at or before the latest it served before it went down: such a request,
having passed every check above, is answered `busy` with the `detail`
`dated before this host last started: send it again`. Nothing was done for it, and its
sender sends it again in a fresh envelope with a `ts` of that moment - once, 1.5 s
later, whatever its kind: an `act` goes out again under the `seq` it had (section 9).
The counters behind `required` are the process's too, and start from nothing.

Only a request the host served moves that mark: one of a member, in a pool the host
has linked, or the `hello` of a host that carries a member's invite. What is answered
`not-member` moves nothing. And the mark is never ahead of the host's own clock at the
start: where a sender whose clock runs ahead, inside the 300 s, left a later date on
disk, the host serves nothing dated at or before the second it started in, and
everything after. So a sender is `busy` after a target's start only for as long as its
own clock is behind that mark.

That leaves one request a host can serve twice: one dated after the second the host
started in and served before it - its sender's clock was ahead by more than the host
took to come back - when the same bytes arrive once more after the start. Every kind
but `act` answers the same when asked again, and an `act` is carried out once for its
`seq`, which is on disk (section 9).

### What a sender pays

A sender pays what the target's last answer asked for. It never pays more than the most
the table above lets a target ask - 16384 << 12 = 262144 << 8 = 67 108 864 - and a target
that asks for more is not sent that request again. A request refused for `effort` is sent
again at the price asked, at most three times. A member whose own volume has taken its
price above what a stranger owes, and that has lost count of it - it started again in
that minute - is quoted the stranger's price, pays too little again, and after the third
time leaves that request; a minute later its price has fallen.

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
`detail` is at most 200 characters. Codes: `effort` (too little work, or work or a
signature that does not hold; `effort` says what a stranger owes), `stale` (clock or
epoch), `replay`, `not-member`, `bad-request`, `denied`, and
`busy` (the target could not serve the request this once: it has only just started, it
has no place free, or it failed - and only the first of these says so in a `detail`
that is part of this contract, section 3). A request that is not the canonical form of anything
is answered with `re` over its bytes as received. A sender takes a response only when it
is signed by the target and `re` names the request it sent.

## 5. Pool state

A pool's state is a set of signed records, each stored under a key. A host keeps the
whole set for every pool it is in.

| Record | Key | Signed by | Precedence | Newer version wins by |
| --- | --- | --- | --- | --- |
| `member` | `member/<pk>` | that member | `[seq]` | higher `seq` |
| `offer` | `offer/<taskId>/<host pk>` | the offering host | `[seq]` | higher `seq` |
| `claim` | `claim/<taskId>/<executor pk>` | the executor | `[gen, round, seq, backers]` | see section 7 |

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

An offer is its host's alone. No record another host signs changes it or stands in for
it: an offer ends when its own host signs it `done` or `cancelled`, and a host signs
that by the rules of sections 6 and 7 only. Two hosts that offer one task have two
offers. What makes them one piece of work is the claim (section 7): one claim may hold
both, one run then does for both, and each host ends its own offer on that run's report -
or, where the report never reached it, on the record that run left (section 7). An
offer a host makes of a task it offered before is another offer, told from the earlier
one by a later `createdAt`.

For each open offer of a member, the records say which claim **holds** it at a given
moment, if any (section 7); an offer no claim holds is **free**. A task as a whole is a
view of its offers, for display and for choosing what to go for: **claimed** while a
claim holds one of its open offers, **available** while offers of it are open and none
is held, **done** when none is open and one is `done`, else **cancelled**.

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
  every 6 hours, and one that could not for 24 hours cancels it (section 7); a held
  claim is signed again by every lease extension.
- Every version of a member record is live for 30 days after its `at`, and beyond that
  for as long as the voucher of a live member is signed by it: dropped, it would cut that
  member off.
- A member is live only while its key is accepted and it has a seat (above). An offer or
  a claim is live only while the member record of its signer is, and while it fits its
  signer's quota (above).
- A claim is live only while a host that backs it (section 7) has a live offer record of
  its task, in whatever state.

A record that is not live is dropped, and refused when it arrives. `asOf` is
chosen by whoever asks and is refused when more than 300 s from the answerer's clock, so
a host keeps every record for 300 s past the moment it stops being live.

Nothing that ended comes back. A version that wins over another of its key was signed
no earlier, so it is dropped no earlier: by the time a host forgets that an offer was
`done` or `cancelled`, that a claim was `released` or `completed`, or that a member
`left`, every version it replaced is too old to be taken in again. A host that was cut
off for days can push everything it still holds and reopen nothing. Nor does an old
claim take an offer back from a later one: a host gives its offer to one claim after
another under a number that only grows (section 7), and of the claims on record the one
it gave the offer to last is the one that can hold it. The retention must stay far
longer than a lease and its grace.

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
| `hello` | `{ member, chain? }` - the sender's own record, and the records leading to its root | `{ index, more? }` |
| `sync` | `{ asOf, hash, after? }` | `{ hash }`, plus `{ index, more? }` when the hashes differ |
| `pull` | `{ keys }` | `{ records }` |
| `push` | `{ records }` | `{ accepted, refused: [{ key, code }] }` |
| `lock` | `{ taskId, round, asOf, hash }` | `{ grant }` or `{ challenge }` or `{ stale: true }` |
| `unlock` | `{ taskId, round }` | `{ }` |
| `ping` | `{ ping }` | `{ claim }` |
| `key` | `{ taskId, round }` | `{ capability, secret, spec }` |
| `act` | `{ taskId, keyId, seq, request, mac }` | `{ status, headers, body }` |
| `done` | `{ taskId, round, spec, outcome }` | `{ }` or `{ offer }` |
| `reserve` | `{ kind, bytes }` | `{ ticket }` |

`index` maps live keys to `[precedence, H(canon(record))]`, a page at a time: the keys
in order, by code unit, as many as come to 256 KiB, with `more: true` beside them when
keys remain past the last. `hello` is answered with the first page. A `sync` with
`after`, which must be a key of the pool, is answered with the page of the keys after
it; the asker settles one page - what to pull, and what to push of its own keys in the
range that page covers - and asks for the next from the page's last key, at a new
`asOf`, up to 128 pages in a row. A page with `more` whose last key is not past `after`
is no answer. The index of a pool at its caps is some 5 MiB, so no answer has to carry
it whole. `pull` takes at most
4096 keys and `push` at most 1024 records. A `pull` is answered with the records under the
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
each record to whoever a push missed. One record does not wait for that: an offer of the
host's own - made, signed again or ended. A member that has not said it holds it is
pushed it again 2 s after the first push, 5 s after that and 15 s after that, beside
whatever push to that member is still unanswered. A member has said so when it answers a
push that carried the record, or sends a `sync` that names the very state the host
holds. Another offer signed meanwhile starts the three waits over, and goes in the same
push. These are requests like any other push: none is sent while the host leaves the
member alone after a request that went unanswered, none to a member that has not
answered the host for 3 minutes, and what is still not acknowledged after the third is
left to the `sync`. A host that leaves a pool signs its member record
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

`done` tells a host that offers a task how the run of its job ended: `outcome` is
`{ ok, summary, microUsd, tokens, runner, model }`, the cost in millionths of a dollar,
`summary` at most 4000 characters, and `spec` names the job that was run:
`H(canon(spec))` of the spec the executor was handed with its key (section 9). Its
envelope is all that authenticates it. The host takes it only when the envelope's sender
is the executor of a claim record the host holds for that task, `round` is that claim's
round, and the claim is active or was ended by that executor (`completed` or
`released`); otherwise it answers `denied`. A lapsed claim reports nothing, and neither
does any other member, whatever it knows of the key: no key and no MAC is involved, so a
host that issued no key decides the same way.

A `done` that is taken changes the host's offer only when all of this holds: the host
has the offer open; it backs the claim with that very offer (section 7); the round has
not reported before; `spec` names the job the host hands out for the offer; and no other
executor's claim holds the offer at that moment. Then, with `ok`, the host signs its
offer `done`; without, the attempt failed, and the offer is free again or, after the
third failed attempt, `cancelled`. The answer carries `offer`: the host's offer record
as the report left it. Any other `done` is answered `{ }` and changes nothing - a run
reports in vain to a host whose job it did not do, or whose offer is another run's.

So an offer ends by its own host and in these ways only: withdrawn; out of attempts;
done by the report of a run the host gave it to; done by the record of a run of its very
job that sent it no report; or cancelled because its host was away for longer than an
offer lasts (section 7 for the last two). An offer that a claim stops holding without a
report is free again. That counts as a failed attempt when the hold ran out - the lease
lapsed, or the claim outlived the offer's hours (section 8) - and counts for nothing
when the executor ended its claim before that: its run did another host's job, was
stopped on its machine, or never began for a fault of that machine's own.

Giving a claim back is no way to keep an offer. For 60 s after a claim let go of an
offer before its hold ran out, the offer's host gives that offer to no claim of the same
executor: it grants that executor's `lock` without `offer` (section 7), and the other
members go first.

An executor does not go straight back to a task either. One that failed at a task, or
gave its claim back, leaves the task to the other members for 2 minutes, and for twice
as long each time it does so again while the earliest open offer of the task is the
same one, up to an hour; then it may go for the task again. A machine alone in its pool
so makes all three attempts at its own offer, 2 and 4 minutes apart, and the offer ends
failed; with others in the pool, one with a free slot takes the task meanwhile. A run
its machine's operator stopped is not taken up by that machine again while that offer
stands. These waits are the executor's own, and no other host checks them: the 60 s
are what a host holds a member to.

An executor with an outcome to report sends `done` to every host that backs its claim,
still offers the task and has not answered - again every 30 s, until each has answered
or the lease has less than 30 s left. It takes in the offer records the answers carry,
and only then ends its claim: `completed` on an `ok` outcome, else `released`. A
`completed` claim carries `spec`, the job its run did, as its `done` named it; no other
claim carries one. Until then the claim holds what it was given: the offer of a host
that heard of a failed attempt is free again when the claim ends, and so is the offer of
a host that never heard, with no attempt counted - a failed run leaves a `released`
claim, which names no job and ends nobody's offer. A run that never got a key has no
job to report, and releases its claim.

A request may arrive twice, or be answered and the answer lost. Every kind is safe to
send again in a fresh envelope: a `lock` of the same executor and round is granted the
same way, `key` answers with the same capability and secret, `unlock`, `push` and `done`
change nothing the second time, `reserve` gives a new ticket for the same place, and
`act` is guarded by its `seq` (section 9).

## 7. Claiming a task

A claim is the one thing that needs consent. What a claim takes is an offer, and one
rule decides whose consent that needs: **a host's word binds its own offer and no
other.** Every member consents to the claim being made; only the host of an offer gives
that offer to it.

**What the pool holds, and what stays with the offering host.** A job belongs to no
machine: every member holds its offer, any member with a slot may take it, and none is
asked before another. What the job needs in order to run stays with the host that
offered it, and with that host alone. Only it backs a claim with the offer, hands out
the prompt and the key (section 9), carries out every forge request of the run, and asks
for the next lease (section 8). No other member can do any of that in its place: none
holds the prompt or that host's access to the forge. So while the offering host is
asleep or out of reach:

- its job, when nobody has claimed it, cannot be taken - a claim no host backs is no
  claim;
- its job, when it is running, has no way to the forge from that moment, and the run is
  stopped when its lease and the 10 minutes of grace are over;
- its offer is in no pool once it was not signed again for 24 hours, and the host
  cancels it when it returns ("A host that was away").

A host with a free slot that sees a task with a free offer it may take (section 8):

1. **Confirms its own state.** It computes `stateHash(asOf)` over what it holds. Whether
   an offered item is still open is its offerer's to say: the offerer cancels the offer
   of an item that closed.
2. **Confirms it with every member.** It sends `sync` to every other member and repairs
   differences until all that answer report its hash. A member that has answered nothing
   in this round when a request to it goes unanswered is **absent** for this round; a
   member that has answered anything is **present**.
3. **Sends a lock to every present member**: `{ taskId, round, asOf, hash }`, `round` a
   fresh random 8-byte value.

**Whose consent a claim needs.** One consent cannot be done without: that of a host
whose offer the claim takes. A claim no offering host backs holds nothing, however many
members granted it, so no offer is ever taken while its host is silent. Beyond that,
every member that answers must grant - one that is there and has locked the task for
another executor, or holds another state, stops the round. A member that does not
answer is written into the claim as absent, and the round goes on without it: a pool
would otherwise run nothing while one laptop sleeps. Its consent is not needed for what
consent is there to prevent. A lock keeps two executors from running one job. A job is
run under a key, the key is issued for an offer by that offer's host alone, and that
host gives its offer to one claim at a time under a number it gives once ("Which claim
holds an offer"). So when two executors both claimed a task because a member between
them was silent, the host of each offer tells them apart, and at most one holds that
offer and is handed its key. What the silent member could have added is an offer of its
own of the same task: that offer is in no claim made without it, and is taken into the
run, or run by itself, when the member is back ("One run for every offer", "What
remains").

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
- 15 s for any other: one that has not answered the claimant for 3 minutes.

A claimant that starts again has reached nobody yet. It keeps on disk which members had
not answered it for 3 minutes when a request to them last failed, and since when, until
one answers: such a member gets the 15 s from the first round on, not the wait of one
never reached. A silence that began more than 24 h ago is not gone by. Nothing else
changes for that member: it is asked in every round, counted absent when it does not
answer, and has its say when it does.

A host claims only while it has a slot to run the task in, and looks again before it
commits: a claimant whose slot went while its round ran unlocks every member that
granted and stands down. A task its own host offered to run at once is the exception:
its host claims it whatever its slots, without the rank delay below, through the same
three steps. A claimant that cannot send - its own transport is down - writes nobody off
as absent for it: it stands down.

A member answers a lock with:

- `{ stale: true }` when its hash at `asOf` differs - the claimant goes back to step 2;
- `{ challenge: { reason, holder? } }` when by its own clock no member has a free offer
  of the task (`unavailable`), or when it has already granted or is itself claiming the
  task for another executor (`locked`, with that executor as `holder`);
- `{ grant }` otherwise: `{ pool, taskId, executor, round, hash, by, exp, offer?, sig }`,
  signed, with `exp = asOf + 120`. A granted lock binds the member through `exp` by its
  own clock, or until an `unlock`, or until it holds the claim of that round with its
  grant in it. A host's own round binds it the same way, from its start until it
  commits, stands down or times out.

A grant is a member's consent to this executor claiming this task in this round, on this
state. A member that offers the task itself may add `offer` to it, `{ at, gen, hours }`,
and so **backs** the claim: the offer it made at `at` (that offer's `createdAt`) is the
claim's, for `hours` (that offer's `minRequiredH`), as the `gen`th claim the host gave
that offer to. It backs when its offer is open and free, the claimant's `maxAcceptedH`
is at least those hours, what it holds of the pool is up to date ("A host that was
away"), and no claim of the claimant let go of that offer within the last 60 s (section
6); otherwise its grant is consent and nothing more. `gen` is the host's own count
for that offer, on its disk before anyone sees it, and one higher each time it gives the
offer away; asked again by the same round while its lock stands, it answers with the
same number. A claimant that offers the task itself backs its own claim the same way,
with its own free offer and its own next number, as `offer` in the claim record.

The claim holds only when every present member granted it on one `asOf` and `hash`, no
later than `exp`, and at least one host backs it. A grant that backs it must be for the
offer the claimant saw free in the state the round confirmed - that `at`, those hours -
or it is asked for again. A round times out 180 s after it started and commits nothing
from then on: the claimant unlocks every member it locked and stands down, as it does
whenever a present member has not granted by then. The claimant of a round that holds
signs the claim record and pushes it:

```json
{ "type": "claim", "pool": "...", "taskId": "...", "executor": "<pk>", "round": "...", "gen": 0,
  "seq": 0, "state": "held", "at": 1794000000, "claimedAt": 1794000000, "leaseUntil": 1794007200,
  "deadline": 1794043200, "hours": 12, "grants": [ ... ], "absent": ["<pk>", ...],
  "offer": { "at": 1793999000, "gen": 1, "hours": 12 }, "sig": "..." }
```

`grants` is ordered by `by` and `absent` is ordered; neither names a key twice, the
executor, or a key of the other. `offer` is there only when the executor backs the claim
itself. `gen` counts the claims of the task this executor made: one more than the `gen`
of its claim record of the task that was live when the round began, zero when there was
none. `hours` is the longest any host backs the claim for. Every host checks of a claim
what does not depend on its own state: each grant is signed by its `by`, names the
claim's pool, task, executor and round, and has an `exp` no earlier than `claimedAt`;
`hours` is the longest of its backings, so a claim no host backs is refused
(`bad-claim`); it carries `spec`, 32 bytes, when its `state` is `completed` and at no
other time (`bad-claim`); and its lease is the one its times dictate (section 8). Who
was absent is the claimant's word, and excuses nothing: a claim holds what its backings
give it (below).

### Which claim holds an offer

Take an open offer of a member `h`, made at `createdAt`. Of the claim records live in the
pool, those that `h` backs with `at = createdAt` are the claims `h` gave that offer to.
The one it gave it to last comes first - the highest `gen` in `h`'s backing, and, should
two carry the same number, the better rank of the executor (below). That claim **holds**
the offer while its `state` is `held`, its executor is a member, and

```
now < min(leaseUntil, claimedAt + hours * 3600) + 600
```

with `hours` those of `h`'s backing. When it does not, no claim holds the offer: not one
`h` gave it to before, and not one `h` did not back. Every host works this out alike from
the records it holds. It comes to this:

- **A claim holds exactly the offers whose own hosts gave them to it.** Whatever a
  member signs - a claim of its own at any `gen`, a grant, an offer of the same task in
  any state - changes nothing about which claim holds another host's offer.
- **Claims of different executors are different records.** None replaces, outranks or
  ends another. Two claims of one task can each hold an offer of it, and that is two
  runs ("What remains").
- **A host gives its offer to one claim at a time.** It backs a claim only while its
  offer is free, and a lock binds it to one executor per task. So an executor that a
  host gave its offer to keeps it until its claim ends, lapses or outlives the offer's
  hours, whoever else claims the task meanwhile.
- **An executor runs while its claim holds an offer.** Before it has a key: any offer.
  With a key: the offer of the host the key is from (section 9). When that is no longer
  so it stops its run and releases its claim.
- **A host acts only for the claim that holds its own offer.** It pings that claim's
  executor, issues it the key, serves its `act` requests and ends its offer on its
  `done` (sections 6, 8 and 9). A claim it did not back gets nothing from it.
- **Nobody's numbers are another's to use up.** A claim's `gen` is its executor's own
  count and orders only that executor's records; a backing's `gen` is the offering
  host's own count and orders only the claims of that host's offer.

### One run for every offer

A round asks every member, so a claim is backed by every host that offers the task,
could be reached, and had its offer free: one claim holds all those offers, one run does
the job, and each host ends its own offer on that run's report (section 6).

An offer of the task that is free while the claim is held - its host began to offer the
task later, or was absent in the round - is taken into the same run. The executor sends
that host a `lock` for its claim's own `round`, on the state at that moment; a grant
that backs the claim with that offer takes the place of any grant the host gave before
and takes the host off `absent`, and the executor signs its claim again with it: the
same `gen`, `round` and `seq`, one more host backing it, `hours`, `deadline` and
`leaseUntil` following the longest backing. An executor that begins to offer the task
itself adds its own offer as the claim's `offer` in the same way. This consent is the
offer's host's alone; no other member is asked again. The executor asks when it hears
of such an offer and every 30 s after - not for an offer of more hours than it
accepts, and not for one whose hours, counted from `claimedAt`, the claim has already
outlived. To give it the time, a host that would go for a free offer of a task waits
60 s longer when a claim already holds another offer of that task, whatever the task
is to that host.

### A job that was run for another offer

A host is not always there when its job is run: it was asleep, switched off or out of
reach during the round, so no claim was given its offer, or during the report, so it
never heard how the run it backed ended. Its offer is open and no claim's, and the job
is done - for another host's offer, or for the offer of the very machine that ran it.
The record the run left speaks for it. A host signs an open offer of its own
`done` when no claim holds that offer and the pool holds a live claim record of the task
of which all of this is true:

- it is `completed`, and its `spec` is `H(canon(spec))` of the spec this host hands out
  for the offer (section 9);
- `claimedAt + 300 >= createdAt` of the offer: the run was claimed no earlier than the
  offer was made, the 300 s two clocks may differ by aside. A run that began before that
  says nothing of an offer made knowing of it;
- this host backs it with that very offer or not at all: a run it gave an earlier offer
  of its own to was over, for this host, when it offered the task again.

Whose offers the run was given does not matter: a machine that ran the task it offers
itself, backed by nobody else, leaves such a record too. Of two machines of one
operator, when one runs its own offer while the other sleeps, the sleeper's offer is
`done` when it wakes and the job is run once.

A record that reaches a host - pushed, pulled, or brought by the executor's later
`sync` - is weighed at once, also when a `lock` for the offer is being answered: the
offer is done before it can be given away. An offer that a claim holds is not touched:
it ends by that claim's run, so no record stops a run that is going.

The host books nothing for an offer that ends this way: what the run cost is with the
offer the run reported to. It keeps who ran the job and every host that backed that
run, the executor among them when it ran its own offer.

The spec is everything an executor is handed to run a task, and so everything the digest
covers: the task id, kind, item and title, the forge login, the prompt and its options,
the base revision, and the name and email commits are authored with. Two offers are
offers of one job when all of that is the same to the byte. Then one run does for both,
in one claim or by this rule; otherwise they are two jobs under one name, and each is
run ("What remains").

### A host that was away

What a host holds of a pool is as old as the last moment it was there. A host is away,
and its pools are **out of date**, from the moment it starts, from the moment it finds
its clock more than 60 s past where it last looked - the machine slept - and from the
moment its transport comes up. Until a member has told it what it missed, it holds back
what it would do of its own accord for its offers by that state:

- it backs no claim. A `lock` is granted as any member's is, without `offer`: its
  consent to the claim, and nothing of its own given;
- it signs no offer again, counts no lapse and no failed attempt, sends no ping.

What it is asked - a `key`, an `act`, a `done` - it answers as ever. It asks by sending
`sync` to every host whose member record it holds, at once and whatever it made of that
host before. A pool is up to date as soon as one member has told the host what that
member holds: the first to answer, once the host has pulled what that answer shows it
lacks, or a member whose own `sync` to the host names the very state the host holds,
which is the same word from the other side. A member that is asleep, or slow to be
reached, keeps nobody waiting. With nobody to ask, the pool is up to date at once.
When nobody answers, the host asks again, and after 180 s of that with its transport up
it goes on with what it holds. A host that goes out of date again meanwhile starts
over: what a member said before says nothing of what came after.

Then it looks at its offers. One whose job was run meanwhile is `done` (above). One
whose last version this host signed 24 hours ago or longer is `cancelled`: its record
is live in no pool, nobody could have been given it since, and whether its job was run
can no longer be told - the record of that run may have been dropped as well. Whoever
offered the work offers it again when the forge still shows it undone. Every other
offer goes on as before.

The 24 hours are no gap. A run that ended while the host was away left its `completed`
record at some `t` after the host last signed its offer, at `s`, and that record is live
until `t + 24 h`, later than `s + 24 h`. So for as long as an offer is still open on its
host's return, the record of a run of its job is still held by every member that ever
held it. And a claimant that holds that record cannot be granted a lock by a host that
lacks it: a lock is granted only on the state the claimant confirmed (step 2).

### Conflicts

Every conflict is settled by a value all hosts compute alike.

- **Rank.** `rank(taskId, executor) = H("dn1/rank" || 0x00 || taskId || 0x00 || executor)`.
  Lower wins.
- **Two claimants locking at once.** A claimant challenged with `locked` compares ranks
  with the `holder`. The one that ranks worse sends `unlock` to every member it locked and
  stands down; the one that ranks better re-sends its lock to the members that challenged
  it, until they grant or the round times out.
- **Two versions of one executor's claim of a task.** Exactly one is kept, by the first
  of these that tells them apart: the higher `gen`; the lower `round` (compared as
  base64url strings); the higher `seq`; the more hosts backing it; the lower
  `H(canon(record))`. This order is total and transitive, so every host that has seen
  the same versions keeps the same one, in whatever order it saw them.
- **Two claims backed with one offer.** The one its host gave the offer to later holds
  it (above). A host gives each number once, so only a host that breaks this rule makes
  the rank decide, and only for its own offer.
- **Two hosts that offer one task, each out of the other's reach.** Each backs a claim
  on its own side. Each claim holds the offer of the host that backed it, both runs go
  on when the two sides meet, and each offer ends by its own run.

To keep hosts from racing for the same task, a host waits before step 1 for a delay
proportional to its rank on that task, up to 5 s. A host may wait longer, up to a minute
more: how well a task suits a machine is weighed by the host that would take it, on what
that machine has. Nothing of that is announced or sent: no record and no request says
what a machine has or how long it waited. It is not hidden from a member that watches:
the rank delay follows from the task id and the host's key, so a member that offers
such work and sees who takes it, and when, can infer whether that host waited ("What
remains"). A task its own host offered to run at once waits for neither of the two.

### What remains

Nothing in a record hides any of this.

- **A job cannot do without the machine that offered it.** No machine owns a job, and
  only one can serve it: the offering host backs the claim, hands out the prompt and
  the key, carries out the forge requests and extends the lease (above). While that
  host is asleep, its unclaimed jobs are taken by nobody, its running jobs cannot reach
  the forge and stop at the end of their lease and its grace, and after a day its
  offers are gone. A second machine that offers the same job, to the byte, is a second
  host an executor can be given it by ("One run for every offer"); a run that has its
  key from the machine that fell asleep is lost all the same.
- **A member that does not answer is not asked for its consent.** A claim carries the
  grant of every member that answered and the names of those that did not. What holds
  without the absent ones is that an offer is one claim's at a time, by its host's word;
  what does not hold is that the task is run once - the absent member may offer it too,
  and that offer is run when it returns unless the first run took it in or did its very
  job (below).
- **A repository that was renamed or moved is two pools.** A pool is named by the
  repository's forge slug, and nothing else ties two names to one repository. Machines
  linked under the old name and machines linked under the new one share no offers and
  no members.
- **Work can be done ahead of its hour.** The seed of the proof of work names the hour
  and nothing the target chose (section 3): a sender can solve requests for an hour to
  come and send them then, at the price it solved for. What it owes is weighed on
  arrival, and a body solved ahead says nothing current.
- **One task, two runs.** One run does for every offer of a task only where one claim
  holds them all and they are offers of one job. Otherwise an offer is run by itself:
  - *Hosts out of each other's reach.* Two hosts that offer one task and cannot reach
    each other each give their offer to a claim (above). The same happens when a lease
    lapses on one side of a partition only: the host on that side counts a failed
    attempt and gives its offer to another claim, while the first run goes on for the
    host that still reaches it.
  - *Offers of different hours.* A claim outlives the shorter offer's hours while it
    still holds the longer one. A run whose key is from the host of the longer offer
    goes on; the shorter offer counts a failed attempt and is run again. A run whose key
    is from the host of the shorter offer stops at that offer's hours and reports the
    attempt failed to both.
  - *Offers of different jobs.* A `done` ends an offer only when `spec` names the job
    its host hands out (section 6): the title, the prompt and its options, the base
    revision, the commit author. Two hosts whose specs for one task differ in a single
    byte have two jobs under one name. One run holds both offers, does the job of the
    host it has its key from, and reports to both; the other host changes nothing, and
    once that claim ends its offer is free, at no attempt lost, and its job is run next.
    Machines that are to share a run must be given the same job to the byte.
  - *A host that was away when its job was run* ends its offer by the record of that
    run ("A job that was run for another offer"). The job is run a second time all the
    same where that rule does not reach:
    - *the run was claimed more than 300 s before the offer was made*, and the offer was
      never given to it: the host made its offer while the run was going and was gone
      before the run could take that offer in.
    - *nobody answered the host when it came back.* After 180 s it goes on with what it
      holds, and gives its offer to whoever asks.
    - *the first member to tell the host what it missed had missed the run too.* The
      host goes by the first word it gets. From a member that was away as well it learns
      nothing of the run, and gives its offer to the next claimant that holds no record
      of it either. The record, when another member brings it, ends an offer no claim
      holds; one that a claim holds by then ends by that claim's run.
    - *the host was there and out of reach for more than a day.* It kept signing its
      offer, and the record of the run was dropped before the host could hear of it.
- **A member that offers a task another host offers too** is a requester of its own
  offer and of nothing else. It cannot stop a run, take an offer from the claim that
  holds it, or fail or cancel another host's offer; how another host's offer can be
  made to end `done` is under "An outcome is the executor's word" and "One member that
  holds a job" below. What is left to it:
  - *Being asked for the key.* An executor whose claim holds several offers asks their
    hosts for the key in an order that starts at a place it draws at random (section
    9). When it starts with this member, the run does the job this member hands out,
    and every forge request of the run goes through this member, for as long as the
    claim lasts. Where that is another job than the other host's, the other host's offer
    is held meanwhile and free again after, at no attempt lost. Where it is the same job
    to the byte, the other host ends its offer `done` on the run's report, having seen
    none of the run's requests: whether they reached the forge was this member's to
    decide.
  - *The minute.* While its own claim holds its own offer of a task, every other host
    waits the 60 s above before it goes for the other offers of that task.
  - *The view.* A task's row is made from all its open offers: the title of the first by
    key, the earliest `createdAt`, the longest hours. Hosts go for the tasks with the
    earliest `createdAt` first, and a host that failed at a task leaves it alone for a
    while only as long as that `createdAt` stays what it was (section 6). So a member
    that offers a task too changes what others see of it, when they go for it, and how
    soon a host that gave it up tries it again.
- **An outcome is the executor's word.** A host ends its offer `done` on the report of
  the executor it gave the offer to. A member that takes an offer and reports `ok`
  without doing the work has finished it, and so has a member through whose key the
  work was done (above). What a host sees for itself is how many forge requests it
  served for the task.
- **One member that holds a job can make a host that offers it end its offer unrun.**
  A `completed` claim that names a job is its executor's word. A member offers the
  task, claims its own offer, and signs that claim `completed` under the digest of
  another host's job; a host whose offer of that job is open and free then signs it
  `done`, unrun. The digest takes the job itself to compute - the prompt, its options
  and the commit author, to the byte, none of which a record carries - so the member
  must already hold that exact job: it offers the same work itself, or was handed it
  with a key before. This is no more than any executor can do by taking a job and
  reporting it done (above), and it gets the member less: no key is issued and no
  forge request made, an offer that a claim holds is untouched, and the host keeps
  whom it took for the executor and for its backers. The forge shows the work undone,
  and Diplomat offers it again.
- **What a machine has shows in what it takes.** A host weighs a task against what its
  machine has and waits longer for one that suits it less ("Conflicts"). It announces
  nothing and sends nothing of that. A member that offers such work and watches who
  takes it, and when, can infer it all the same: the rank delay is anybody's to
  compute, so one observation tells a host that waited from one that did not - a
  machine with no device to give from one that has one. Any private preference shows
  in who takes what.
- **A member can take an offer and sit on it.** A claim made by the rules holds the
  offers it was given for one lease and its grace, 2 h 10 min, and for as long after as
  its executor answers the pings, up to each offer's hours; a job's own executor answers
  only for a job that is going, and nothing shows another host whether it is. Each lapse
  is a failed attempt of the offer, and the third cancels it. A member that gives its
  claim back before the lapse costs the offer no attempt and is given the offer again
  60 s later (section 6): where no other member goes for the task in that minute, or
  where a second member takes it then and does the same, the offer is kept from being
  run for as long as they keep that up, and never ends failed. A member invited into a
  pool can do this to every task in it.
- **A member that answers and does not grant** stops every round it is asked in: a round
  needs the grant of every present member, and stands down after 180 s without one.
- **A lock costs one request.** A member can ask every member for a lock on a task and
  commit nothing. Each lock binds for 120 s, and while it does that member grants no
  other executor one. Asking again keeps the task locked, at the price of the requests
  (section 3).
- **A grant is good for 120 s.** A claim signed inside that time and shown later is
  taken in when it surfaces. It holds an offer only when no claim its host gave that
  offer to since is on record, and no longer than its lease, which began when it was
  signed.
- **Members are whoever members invite.** A member that invites keys of its own has a
  voice in every round and a quota of records for each of them, up to the pool's 256
  seats.
- **A claim lives no longer than the offer records behind it.** When the last offer
  record of the hosts that back it is dropped, a day after it was signed, the claim goes
  with it, also the record of a claim that ended.
- **A full pool is slow to enter.** The index of a pool at its caps is some 20 pages and
  its records up to 64 MiB, pulled 60 KiB at a time: about a thousand requests, each
  paid for (section 3).

## 8. Hours, leases and the heartbeat

- A requester sets `minRequiredH` on every offer: the hours the task may take from start
  to finish. The default and the floor are 12. They are the hours of that offer, and of
  no other host's offer of the task.
- A member publishes `maxAcceptedH` in its `member` record: the longest task it takes.
  The default and the floor are 12.
- A host may take an offer only when its `maxAcceptedH` is at least that offer's hours:
  it goes for no other, and no host backs its claim with one (section 7). The `hours` of
  a claim are the longest of the offers it was given.
- A claim is leased for 2 hours at a time. `deadline = claimedAt + hours * 3600`, and a
  held claim at `seq` has `leaseUntil = min(claimedAt + (seq + 1) * 7200, deadline)`.
- A claim **holds** the offer of a host that gave it that offer (section 7) no longer
  than `min(leaseUntil, claimedAt + h * 3600) + 600`, `h` the hours of that offer: with
  its lease and 10 minutes of grace, and never past the offer's own hours.
- From 10 minutes before `leaseUntil` to 10 minutes after it, a host whose offer the
  claim holds sends the executor a `ping`, again every 30 s until it is answered:
  `{ pool, taskId, executor, round, n, by, ts, sig }` with `n` the `seq` it asks for, one
  more than the claim's. A host sends none once `leaseUntil` has reached
  `claimedAt + h * 3600` for its own offer: that offer has no lease left to give. The
  executor must answer with its claim at `seq = n`, `leaseUntil` moved 2 hours on (never
  past `deadline`), and the ping embedded as `ping`. The host pushes it to the pool.
- Every host checks of a held claim with `seq` above zero that it embeds a ping signed by
  its `by`, a host that backs the claim, for that pool, task, executor and round, with
  `n = seq` and `ts` in the window of the lease before it: from 600 s before that
  `leaseUntil` to 600 s after, that lease ending before the hours of that host's offer
  do. A held claim at `seq` zero embeds none. An executor refuses a ping from a host
  that does not back its claim (`denied`, with the detail `not-offering`) and one for a
  lease past that host's hours (`ended`).
- A held claim is dated by what it answers: at `seq` zero its `at` is its `claimedAt`,
  and an extension's `at` is within 300 s of its ping's `ts`. An executor answers a ping
  only when that `ts` is within 300 s of its own clock. So a version's retention, which
  runs from `at`, cannot be made to end while its lease still holds.
- An executor extends a lease only for a job it started and has not seen end. Asked
  about a claim whose job is gone, or one still waiting for its key, it answers
  `denied`.
- A claim is **active** while `state` is `held` and `now < leaseUntil + 600`. Past that
  it has lapsed: it holds no offer, the executor stops the run, and every key issued for
  it is dead.
- A job has the hours of the offer its key is for (section 9). A run that reaches them,
  counted from `claimedAt`, is stopped and reported as a failed attempt, whatever hours
  the claim has left for another host.
- An executor that finishes or gives up pushes its claim at `seq + 1` with `state`
  `completed` or `released`, without a ping, and a `completed` one with the `spec` of
  the job it ran (section 6). A member that left holds no claim.

## 9. Acting as the requester

Everything done on the forge for a task - reading an issue, posting a review, pushing a
commit, opening a pull request - is done by the requester, on the executor's request. No
credential of the requester crosses the network. The executor's machine uses its own for
one thing: it keeps a mirror of the repository current with the git access that machine
has, and the job clones from that mirror. Everything else a job does on the forge goes
through the requester.

1. After its claim is committed, the executor asks a host whose offer the claim holds
   for the key. It pushes its claim to that host - a host gives a key only for a claim
   it holds - and then sends `key`. It asks itself first, when its own offer is among
   them. The others it takes in the order of their keys, from a place it drew at random
   when the run began, and after each ask that brought no key it goes on to the next.
   It waits 1 s, 2 s and 4 s after the first three asks that brought none and 30 s
   after every later one, and releases its claim when its first lease would run out
   first.
2. The host asked checks that it has the offer open and that the claim holding it, by
   its own state (section 7), is this executor's of this round and has not reported how
   its run ended; otherwise it answers `denied`. It issues one key per claim: asked
   again for the same claim it answers with the same capability and secret, and a key
   it issued for another claim of the task is revoked first. It answers with:
   - `capability`: `{ keyId, pool, taskId, executor, host, rules, exp, sig }`, signed by
     that host - `keyId` is 16 random bytes, `rules` is the exact list of requests this
     task may make (section 10), at most 128 of them, `exp` is the moment the claim
     stops holding that host's offer (section 8);
   - `secret`: 32 random bytes;
   - `spec`: what the executor needs to run the task - the prompt, the item, the base
     revision, and the name and email commits are authored with.

   The executor takes the answer for a key only when the capability is signed by the
   host it asked and names this pool, task and executor, the secret is 32 bytes and
   `spec` is an object. The job it starts is that host's: its spec, its hours, and every
   forge request through that host.
3. Each `act` request names the `keyId`, carries a strictly increasing `seq`, one forge
   request, and `mac = HMAC-SHA256(secret, canon({ keyId, seq, request }))`:

   ```json
   { "host": "api.github.com", "method": "POST", "path": "/repos/o/r/pulls/578/reviews",
     "headers": { "content-type": "application/json", "accept": "..." }, "body": "<base64>" }
   ```

   `path` carries the query string, if any. Header names are lowercase. `body` is
   padded base64 (RFC 4648 section 4), here and in the answer. The host
   performs it only when: the envelope is signed by the capability's executor; the key is
   unexpired and unrevoked; `seq` is greater than every `seq` used under the key; the MAC
   matches; the claim the key was issued for still holds the host's offer; and the
   request matches a rule. A request whose MAC matched has used its `seq` whether or not
   it was performed. The host sends the request to the forge with its own credentials
   and answers `{ status, headers, body }`. A request no rule covers is answered the
   same way, with status 403 and a JSON body `{ "message": "<why>" }`; a forge that
   cannot be reached, with status 502.
4. Each lease extension moves `exp` with it: the host signs the capability again under
   the same `keyId` and secret. An `act` names the key and does not carry it, so the
   executor has nothing to fetch. A key is revoked when the claim it was issued for
   stops holding the host's offer - it ended, it lapsed, it outlived the offer's hours -
   when the run's `done` is taken, and when the offer ends. The executor stops its run
   and releases its claim when the claim no longer holds the offer of the host its key
   is from, whatever other offer it holds.
5. Both sides write a `seq` down before they use it: the executor before the request
   leaves, the host before it asks the rules. Requests under one key are served one at a
   time, in the order their numbers were accepted, and a request whose key was revoked
   while the rules were asked is answered `denied` and not performed. Two refusals say
   that an `act` was not looked at, and it goes out again under the same `seq`: one for
   want of work (`effort`), and a `busy` with the detail of section 3 - dated before
   the host last started - which is signed again with the time of that moment and sent
   once more. An `act` refused that way a second time was never performed either: the
   executor sends it again under a new `seq`, whatever its method. One whose answer never
   came, came as `replay` because the request arrived twice, came as any other `busy`,
   or came as HTTP 413, may have been performed. The executor sends it again, under a
   new `seq`, only when the forge request is a `GET` or a `HEAD`; for any other it tells
   the job that the outcome is unknown. Three attempts are made at most. The job is
   then answered with status 503 when the last was not performed, and with status 504 -
   there, and for a request that is not sent again - when it may have been.

## 10. Rules

A rule allows one shape of forge request:

```json
{ "host": "api.github.com", "method": "POST", "path": "/repos/o/r/pulls/578/reviews", "fold": [1, 2] }
```

A request is first brought to one spelling and refused when it has more than one reading:
the method is one of GET, POST, PUT, PATCH, DELETE; the host is a plain lowercase name; the
path is absolute, with no empty or dot segment, no fragment, no `;`, no encoded slash,
dot, backslash, percent sign, semicolon or control character (GitLab's URL-encoded project
path, the segment after `/api/v4/projects/`, is the one place an encoded slash may stand),
and no escape of a character that needs none - a letter, a digit, `-`, `_` or `~` - so a
route's name is spelled one way; a header is given once; the body is base64. Then the
first rule whose host, method and path match decides, alone. A request no rule matches is
refused. So is one that a different rule would be the first to match under the widest
reading a forge's router could give its path - no literal's case counting, a segment free
to carry an extension (`compare.json`): the forge may take it for that rule's route.

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
  another object up from there. A field takes only the arguments the reader lists, which
  page, order and filter what the object it is selected on holds; one that names an object
  by its node id (GitHub's `pullRequestId`) is resolved on the forge as `node(id:)` is, and
  any other is refused, since it could name another repository. A scalar is read freely on
  what is inside the repository, with two exceptions. Of the repository itself - the root
  field, and a `node` that turns out to be it - a query reads the scalars that hold what
  the REST rule's `pick` passes on, and on GitHub `viewerPermission`, which `gh` reads
  before it opens a pull request. And no scalar is read that tells of the account asking
  and not of the repository: on GitHub a name with `viewer` in it other than
  `viewerDidAuthor`, on GitLab `can...`, `subscribed`, `createNoteEmail` and
  `troubleshootJobWithAi`. Of a branch's protection one scalar is read, whether its
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
  regard to case - except to what one of its parents holds there, so a merge may take
  the path, or its absence, from any commit it merges; a commit in the pack
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
the task's to move or to open a pull request from, until the forge has said what became
of it. Before the task's next push is checked the host asks the forge for each such
branch: none, and the creation is given back; the branch at the commit that was sent, and
it is a ref this task created; the branch at another commit, and it stays counted. A pull
request is counted the same way - before the request is sent, as opened once the forge
answers 2xx (for the GraphQL mutation: without errors and with its payload), given back
on 4xx (or on errors and no payload). After any other outcome the host asks the forge,
before the task's next pull request is checked, for the pull requests from that head in
any state: none gives it back, any makes it the one this task opened. A creation whose
request is still out is not asked about, and a question the forge does not settle refuses
the request that waits on it. A request that was allowed and never got an answer from
the forge - the key was taken back while it was checked, the forge could not be reached -
does not count as still out: its outcome is not known, and the forge is asked.

The rules a task receives come from the daemon's catalogue (`src/requester/rules.js`),
keyed by forge and kind and pinned to the task's own item. A kind without an entry can be
offered by nobody.
