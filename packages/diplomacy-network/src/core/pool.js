// One pool's state (PROTOCOL.md sections 5 and 6): the signed records a host holds for
// one repository, what it takes for another record to join them, the hash two hosts
// compare, and what the records say about each task.
//
// Which records are live is a function of the records themselves and a time, never of
// the order they arrived in: that is what lets two hosts holding the same records
// compute the same hash.

import { b64u, canon, hash } from './canon.js';
import { claimPrecedence, compareBacked, compareClaims, precedenceShaped, verifyClaim } from './claims.js';
import { eligible, heldUntil } from './lease.js';
import { seating, verifyVoucher } from './membership.js';
import {
  LIMITS, backers, backing, checkShape, checkSignature, compareVersions, isBytes, isObject, isTime, parseKey, recordDigest,
  recordKey, shaped, versionPrecedence,
} from './records.js';
import { CLOCK_SKEW_SECS, MEMBER_RETENTION_SECS, RECORD_RETENTION_SECS } from '../paths.js';

export const MAX_PULL_KEYS = 4096;
/// The most bytes of index one answer carries: a response is a mebibyte at most.
export const INDEX_PAGE_BYTES = 256 * 2 ** 10;
export const MAX_PUSH_RECORDS = 1024;
export const MAX_HELLO_CHAIN = LIMITS.depth;

const memberKey = (pk) => `member/${pk}`;
const offerKey = (taskId, host) => `offer/${taskId}/${host}`;
const typeOfKey = (key) => key.slice(0, key.indexOf('/'));

// Negative when the first version of `key` wins, positive when the second does.
function order(key, precedenceA, digestA, precedenceB, digestB) {
  return (typeOfKey(key) === 'claim' ? compareClaims : compareVersions)(precedenceA, digestA, precedenceB, digestB);
}

// Why a well-shaped record does not hold for every host alike, or null when it does.
function disproof(record) {
  if (!checkSignature(record)) return 'bad-signature';
  if (record.type === 'member') return verifyVoucher(record) ? null : 'bad-voucher';
  return record.type === 'claim' ? verifyClaim(record) : null;
}

// The entries of `entries` that are live at `asOf` for `self`, and why each other one is
// not. Members first, since an offer or a claim lives only while its signer does; then
// offers, since a claim lives only while an offer of a host that backs it does. Offers
// and claims are taken in key order, each against what its signer has left of its quota,
// so which ones a member over its quota keeps does not depend on the order they arrived
// in.
// Every version is judged by its own `at` alone, so a version that wins over another of
// its key was signed no earlier and is never dropped before it.
// The answer is the same for every time from `from` up to `until`: the retention of some
// record runs out at each of the two, and of none in between.
function settle(entries, self, asOf) {
  const live = new Map();
  const dead = new Map();
  const of = (type) => [...entries.values()].filter((e) => e.type === type).sort((a, b) => (a.key < b.key ? -1 : 1));
  let [from, until] = [-Infinity, Infinity];
  const past = (moment) => {
    if (moment <= asOf) from = Math.max(from, moment);
    else until = Math.min(until, moment);
    return moment <= asOf;
  };
  const expired = (record) => past(record.at + RECORD_RETENTION_SECS);

  const members = new Map(of('member').map((e) => [e.record.pk, e]));
  const kept = new Set();
  // A host's own member record stays whatever its age: it is the membership the host
  // signs again when it is back.
  const queue = [...members.values()].filter((e) => e.record.pk === self || !past(e.record.at + MEMBER_RETENTION_SECS)).map((e) => e.record.pk);
  // A member record past its retention stays for as long as a kept member's voucher is
  // signed by it: dropped, it would cut everyone it vouched for off from the rest.
  while (queue.length > 0) {
    const pk = queue.pop();
    if (kept.has(pk)) continue;
    kept.add(pk);
    const by = members.get(pk).record.voucher?.by;
    if (members.has(by)) queue.push(by);
  }
  const accepted = seating(self, [...kept].map((pk) => members.get(pk).record));
  const roster = new Map(); // pk -> the live member record
  const present = new Map(); // pk -> the record of a member: live, not left, signed lately
  const used = new Map(); // pk -> what that member has live: { offers, claims, bytes }
  for (const [pk, e] of members) {
    if (!kept.has(pk)) dead.set(e.key, 'expired');
    else if (!accepted.has(pk)) dead.set(e.key, accepted.has(e.record.voucher?.by) ? 'no-seat' : 'not-member');
    else {
      live.set(e.key, e);
      roster.set(pk, e.record);
      used.set(pk, { offers: 0, claims: 0, bytes: e.size });
      if (!expired(e.record) && !e.record.left) present.set(pk, e.record);
    }
  }
  const fits = (pk, kind, size) => {
    const mine = used.get(pk);
    if (mine[kind] >= LIMITS[kind] || mine.bytes + size > LIMITS.bytes) return false;
    mine[kind] += 1;
    mine.bytes += size;
    return true;
  };
  for (const e of of('offer')) {
    if (expired(e.record)) dead.set(e.key, 'expired');
    else if (!roster.has(e.record.host)) dead.set(e.key, 'not-member');
    else if (!fits(e.record.host, 'offers', e.size)) dead.set(e.key, 'quota');
    else live.set(e.key, e);
  }
  for (const e of of('claim')) {
    const { record } = e;
    if (expired(record)) dead.set(e.key, 'expired');
    else if (!roster.has(record.executor)) dead.set(e.key, 'not-member');
    else if (!backers(record).some((pk) => live.has(offerKey(record.taskId, pk)))) dead.set(e.key, 'no-offer');
    else if (!fits(record.executor, 'claims', e.size)) dead.set(e.key, 'quota');
    else live.set(e.key, e);
  }
  return { live, dead, accepted, roster, present, from, until };
}

/// The records one host holds for one pool. `self` is the host's own public key: the
/// members it accepts are the ones seated in the pool it is in.
export class Pool {
  #entries = new Map(); // key -> { key, type, record, digest, size, precedence }
  #settled = null;
  #tasks = null; // { settled, now, rows }: the tasks last worked out
  #moved = { put: new Set(), drop: new Set() }; // the keys taken in and dropped since `delta` was asked

  constructor({ id, self }) {
    this.id = id;
    this.self = self;
  }

  #at(asOf) {
    const held = this.#settled;
    if (!held || asOf < held.from || asOf >= held.until) this.#settled = settle(this.#entries, this.self, asOf);
    return this.#settled;
  }

  /// Takes in one record or a list of them at `now` and answers
  /// `{ accepted, refused, fresh }`: the keys now held as given, `{ key, code }` for each
  /// record that is not, and the keys among `accepted` whose record was not held before.
  /// A record is refused when it is malformed (`bad-record`, `wrong-pool`, with an empty
  /// key), dated past the clock tolerance (`future`), loses to the version already held
  /// (`older`), does not prove itself (`bad-signature`, `bad-voucher`, `bad-claim`,
  /// `bad-grant`, `bad-lease`, `bad-ping`), or would not be live here: past its retention
  /// (`expired`), signed by nobody this host accepts (`not-member`), a member whose
  /// voucher is an accepted key's and gives it no seat (`no-seat`: another record holds
  /// that seat, its signer has none to give, or its signer began another membership
  /// since), an offer or a claim beyond what its
  /// signer may have live
  /// (`quota`), or a claim none of the hosts that back it offers the task of
  /// (`no-offer`). A list is taken in together, so a member record may let in the records
  /// that depend on it whatever their order. Records no longer live are dropped.
  merge(input, now) {
    const verdicts = [];
    const tentative = new Map(this.#entries);
    const fresh = new Set();
    for (const record of Array.isArray(input) ? input : [input]) {
      const shape = checkShape(record, this.id);
      if (!shape.ok) {
        verdicts.push({ key: '', code: shape.code });
        continue;
      }
      const { key } = shape;
      const entry = {
        key, type: record.type, record, digest: recordDigest(record), size: canon(record).length,
        precedence: record.type === 'claim' ? claimPrecedence(record) : versionPrecedence(record),
      };
      const verdict = { key, digest: entry.digest, code: null };
      verdicts.push(verdict);
      const held = tentative.get(key);
      if (held?.digest === entry.digest) continue;
      if (record.at > now + CLOCK_SKEW_SECS) verdict.code = 'future';
      else if (held && order(key, entry.precedence, entry.digest, held.precedence, held.digest) > 0) verdict.code = 'older';
      else verdict.code = disproof(record);
      if (verdict.code) continue;
      tentative.set(key, entry);
      fresh.add(key);
    }
    const why = new Map();
    let settled;
    for (;;) {
      settled = settle(tentative, this.self, now - CLOCK_SKEW_SECS);
      const lost = [...fresh].filter((key) => !settled.live.has(key));
      if (lost.length === 0) break;
      for (const key of lost) {
        why.set(key, settled.dead.get(key));
        fresh.delete(key);
        if (this.#entries.has(key)) tentative.set(key, this.#entries.get(key));
        else tentative.delete(key);
      }
    }
    const { put, drop } = this.#moved;
    for (const key of this.#entries.keys()) if (!settled.live.has(key)) drop.add(key);
    for (const key of fresh) {
      put.add(key);
      drop.delete(key);
    }
    this.#entries = settled.live;
    this.#settled = null;
    const accepted = new Set();
    const refused = [];
    for (const { key, digest, code } of verdicts) {
      if (!code && this.#entries.get(key)?.digest === digest) accepted.add(key);
      else refused.push({ key, code: code ?? why.get(key) ?? settled.dead.get(key) ?? 'older' });
    }
    return { accepted: [...accepted], refused, fresh: [...fresh] };
  }

  /// Has the signer of this offer or claim room for it: would it be live here beside
  /// everything else its signer has, with `LIMITS.spare` of the signer's bytes left over?
  /// A host asks before it adds a record of its own, and may ask about one it has yet to
  /// sign: what counts is the record's type, key, signer and size as given.
  room(record) {
    const signer = (r) => r.host ?? r.executor ?? r.pk;
    const key = recordKey(record);
    let [count, bytes] = [0, canon(record).length + LIMITS.spare];
    for (const e of this.#entries.values()) {
      if (signer(e.record) !== signer(record) || e.key === key) continue;
      bytes += e.size;
      if (e.type === record.type) count += 1;
    }
    return count < LIMITS[`${record.type}s`] && bytes <= LIMITS.bytes;
  }

  /// Drops the records that stopped being live.
  prune(now) {
    this.merge([], now);
  }

  /// What changed since this was last asked, `{ put, drop }`: the records taken in that
  /// are still held, in key order, and the keys of the records dropped.
  delta() {
    const { put, drop } = this.#moved;
    this.#moved = { put: new Set(), drop: new Set() };
    return { put: this.records([...put]), drop: [...drop].sort() };
  }

  /// The record held under `key`, or null.
  get(key) {
    return this.#entries.get(key)?.record ?? null;
  }

  /// The records held under `keys`, or every record held, in key order.
  records(keys = [...this.#entries.keys()]) {
    return [...new Set(keys)].sort().map((key) => this.get(key)).filter(Boolean);
  }

  /// `{ key: [precedence, hash] }` for every record live at `asOf`, in key order.
  index(asOf) {
    const { live } = this.#at(asOf);
    return Object.fromEntries([...live.keys()].sort().map((key) => [key, [live.get(key).precedence, live.get(key).digest]]));
  }

  /// One page of `index(asOf)`: `{ index }` with the keys after `after`, in key order, as
  /// many as one answer carries, and `more: true` beside it when keys remain past them.
  indexPage(asOf, after = '') {
    const index = {};
    let bytes = 0;
    for (const [key, entry] of Object.entries(this.index(asOf))) {
      if (key <= after) continue;
      bytes += key.length + JSON.stringify(entry).length + 4;
      if (bytes > INDEX_PAGE_BYTES) return { index, more: true };
      index[key] = entry;
    }
    return { index };
  }

  /// `stateHash(asOf)`, base64url.
  stateHash(asOf) {
    const settled = this.#at(asOf);
    settled.hash ??= b64u(hash([...settled.live.keys()].sort().map((key) => [key, settled.live.get(key).digest])));
    return settled.hash;
  }

  /// Has `pk` a seat in this host's pool at `now`, whatever its member record says?
  vouched(pk, now) {
    return this.#at(now).accepted.has(pk);
  }

  /// How many vouchers `pk` is from the member that started the pool, as this host sees
  /// it at `now`; undefined for a key without a seat.
  depth(pk, now) {
    return this.#at(now).accepted.get(pk);
  }

  /// The member whose seats `pk` sits among at `now`: the one that seated it, for a key
  /// two vouchers from the first member, and `pk` itself for any other.
  branch(pk, now) {
    return this.depth(pk, now) === LIMITS.depth ? this.get(memberKey(pk)).voucher.by : pk;
  }

  /// Does this host take requests from `pk` at `now`: a key with a seat whose member
  /// record does not say it left?
  accepts(pk, now) {
    return this.vouched(pk, now) && this.#at(now).roster.get(pk)?.left !== true;
  }

  /// The member records of the pool's members at `now` - accepted, held, not left, signed
  /// within the retention - by key.
  members(now) {
    const { present } = this.#at(now);
    return [...present.keys()].sort().map((pk) => present.get(pk));
  }

  /// The member record of `pk` when it is a member at `now`, or null.
  member(pk, now) {
    return this.#at(now).present.get(pk) ?? null;
  }

  /// The member records held at `now` of every key that has not left, by key: the members
  /// and the hosts that stopped signing theirs, which a host keeps in touch with so that
  /// one that comes back is heard.
  known(now) {
    const { roster } = this.#at(now);
    return [...roster.keys()].sort().map((pk) => roster.get(pk)).filter((m) => !m.left);
  }

  /// Every task the pool's members offer, by task id, as
  /// `{ taskId, kind, item, identity, title, hours, createdAt, state, offeredBy, free, offers, claim }`.
  /// Each open offer of a member is one of `offers`, `{ host, hours, createdAt, claim }`:
  /// `claim` is the claim that holds that offer at `now`, or null - of the claims its host
  /// backs for the offer it made at `createdAt`, the one the host gave the offer to last,
  /// while that claim is held, its executor a member, and its lease and the offer's hours
  /// last; when it does not, none holds the offer. An offer is its host's alone: no other
  /// host's record ends it, and no claim its host did not back holds it. `offeredBy`
  /// lists the hosts of the open offers and `free` those whose offer no claim holds;
  /// `hours` is the longest of the open offers and `createdAt` the earliest. `state` is
  /// `claimed` while a claim holds an open offer, `available` while offers are open and
  /// none is held, else `done` when an offer is done, else `cancelled`; `claim` is the
  /// claim that holds the most of the open offers, or null.
  tasks(now) {
    const settled = this.#at(now);
    if (this.#tasks?.settled === settled && this.#tasks.now === now) return this.#tasks.rows;
    const { live, present } = settled;
    const byTask = new Map(); // taskId -> { offers, claims }
    const of = (taskId) => {
      if (!byTask.has(taskId)) byTask.set(taskId, { offers: [], claims: [] });
      return byTask.get(taskId);
    };
    for (const key of [...live.keys()].sort()) {
      const { type, record } = live.get(key);
      if (type === 'offer' && present.has(record.host)) of(record.taskId).offers.push(record);
      if (type === 'claim') of(record.taskId).claims.push(record);
    }
    const rows = [];
    for (const [taskId, { offers: all, claims }] of byTask) {
      if (all.length === 0) continue;
      const open = all.filter((o) => o.state === 'open');
      const offers = open.map((o) => {
        const [last] = claims.filter((claim) => backing(claim, o.host)?.at === o.createdAt).sort((a, b) => compareBacked(o.host, a, b));
        const holds = last && last.state === 'held' && present.has(last.executor) && now < heldUntil(last, backing(last, o.host));
        return { host: o.host, hours: o.minRequiredH, createdAt: o.createdAt, claim: holds ? last : null };
      });
      const held = (claim) => offers.filter((o) => o.claim === claim).length;
      const holding = claims.filter((claim) => held(claim) > 0).sort((a, b) => held(b) - held(a));
      const { kind, item, identity, title } = open[0] ?? all[0];
      rows.push({
        taskId, kind, item, identity, title,
        hours: Math.max(...(open.length > 0 ? open : all).map((o) => o.minRequiredH)),
        createdAt: Math.min(...(open.length > 0 ? open : all).map((o) => o.createdAt)),
        state: open.length > 0 ? (holding.length > 0 ? 'claimed' : 'available') : all.some((o) => o.state === 'done') ? 'done' : 'cancelled',
        offeredBy: offers.map((o) => o.host),
        free: offers.filter((o) => !o.claim).map((o) => o.host),
        offers,
        claim: holding[0] ?? null,
      });
    }
    this.#tasks = { settled, now, rows, byTask };
    return rows;
  }

  /// The live claim records of a task at `now`, whatever their state.
  claims(taskId, now) {
    this.tasks(now);
    return this.#tasks.byTask.get(taskId)?.claims ?? [];
  }

  /// One task of `tasks(now)`, or null when no member offers it.
  task(taskId, now) {
    return this.tasks(now).find((t) => t.taskId === taskId) ?? null;
  }

  /// What a claim round by this host starts from at `now`:
  /// `{ pool, asOf, hash, gen, members, backers, own, available, eligible }` - `gen` counts
  /// the claims of the task this host made before, `members` are the other members,
  /// `backers` is `{ pk: { at, hours } }` for every other host whose open offer no claim
  /// holds and whose hours this host accepts, `own` the same of this host's own such
  /// offer or null, `available` whether any offer is free, `eligible` whether this host is
  /// a member one of them is for.
  claimSnapshot(taskId, now) {
    const task = this.task(taskId, now);
    const me = this.member(this.self, now);
    const before = this.#at(now).live.get(`claim/${taskId}/${this.self}`);
    const free = (task?.offers ?? []).filter((o) => !o.claim && me && eligible(me.maxAcceptedH, o.hours));
    const backers = Object.fromEntries(free.filter((o) => o.host !== this.self).map((o) => [o.host, { at: o.createdAt, hours: o.hours }]));
    const mine = free.find((o) => o.host === this.self);
    return {
      pool: this.id, asOf: now, hash: this.stateHash(now), gen: before ? before.record.gen + 1 : 0,
      members: this.members(now).map((m) => m.pk).filter((pk) => pk !== this.self),
      backers, own: mine ? { at: mine.createdAt, hours: mine.hours } : null,
      available: Boolean(task) && task.free.length > 0,
      eligible: free.length > 0,
    };
  }

  /// `{ pull, push }`: the keys to ask a member for and the keys to send it, given the
  /// page of its index it answered with at `asOf`: the keys after `after`, to the end of
  /// the index or, with `more`, as far as the page goes. A key goes one way only: to
  /// whichever side holds the losing version or none. Null when the page is malformed.
  reconcile(theirs, asOf, { after = '', more = false } = {}) {
    if (!isObject(theirs)) return null;
    const last = more ? Object.keys(theirs).sort().at(-1) : null;
    if (more && !(last > after)) return null;
    const mine = this.index(asOf);
    const pull = [];
    const push = [];
    for (const [key, entry] of Object.entries(theirs)) {
      const parsed = parseKey(key, this.id);
      const fine = parsed && Array.isArray(entry) && entry.length === 2 && isBytes(entry[1], 32)
        && (parsed.type === 'claim' ? precedenceShaped(entry[0]) : Array.isArray(entry[0]) && entry[0].length === 1 && isTime(entry[0][0]));
      if (!fine) return null;
      if (!Object.hasOwn(mine, key)) pull.push(key);
      else if (mine[key][1] !== entry[1]) (order(key, mine[key][0], mine[key][1], entry[0], entry[1]) < 0 ? push : pull).push(key);
    }
    for (const key of Object.keys(mine)) {
      if (!Object.hasOwn(theirs, key) && key > after && (last === null || key <= last)) push.push(key);
    }
    return { pull, push };
  }

  /// The answer to `hello` from `from`: `{ body: { index } }` once its member record is
  /// held and it is a member, else `{ error }` with `bad-request` or `denied`. `chain`,
  /// when given, is the member records that lead from the sender to the member that
  /// started the pool; they are taken in together with the sender's own. A key that left
  /// has its seat still: nobody put it out, and a newer record of its own brings it back.
  answerHello(body, from, now) {
    const chain = (v) => Array.isArray(v) && v.length <= MAX_HELLO_CHAIN;
    if (!shaped(body, { member: isObject }, { chain }) || body.member.pk !== from) return { error: 'bad-request' };
    const records = [body.member, ...(body.chain ?? [])];
    if (!records.every((r) => checkShape(r, this.id).ok && r.type === 'member')) return { error: 'bad-request' };
    const { refused } = this.merge(records, now);
    if (!this.member(from, now)) return { error: 'denied', detail: refused.find((r) => r.key === memberKey(from))?.code ?? 'left' };
    return { body: this.indexPage(now) };
  }

  /// The answer to `sync`: `{ body: { hash } }`, and beside it, when the asker's hash
  /// differs, the page of the index after the key `after` (from its start when none is
  /// given) as `indexPage` makes it; `{ error }` with `bad-request`, or `stale` for an
  /// `asOf` too far from `now`.
  answerSync(body, now) {
    const after = (v) => parseKey(v, this.id) !== null;
    if (!shaped(body, { asOf: isTime, hash: (v) => isBytes(v, 32) }, { after })) return { error: 'bad-request' };
    if (Math.abs(body.asOf - now) > CLOCK_SKEW_SECS) return { error: 'stale' };
    const mine = this.stateHash(body.asOf);
    return { body: mine === body.hash ? { hash: mine } : { hash: mine, ...this.indexPage(body.asOf, body.after) } };
  }

  /// The answer to `pull`: `{ body: { records } }`, the records held under the keys asked
  /// for, or `{ error: 'bad-request' }`.
  answerPull(body) {
    const keys = (v) => Array.isArray(v) && v.length <= MAX_PULL_KEYS && v.every((k) => parseKey(k, this.id) !== null);
    if (!shaped(body, { keys })) return { error: 'bad-request' };
    return { body: { records: this.records(body.keys) } };
  }

  /// The answer to `push`: `{ body: { accepted, refused } }` as `merge` reports them, or
  /// `{ error: 'bad-request' }`.
  answerPush(body, now) {
    if (!shaped(body, { records: (v) => Array.isArray(v) && v.length <= MAX_PUSH_RECORDS })) return { error: 'bad-request' };
    const { accepted, refused } = this.merge(body.records, now);
    return { body: { accepted, refused } };
  }
}
