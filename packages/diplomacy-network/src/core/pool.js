// One pool's state (PROTOCOL.md sections 5 and 6): the signed records a host holds for
// one repository, what it takes for another record to join them, the hash two hosts
// compare, and what the records say about each task.
//
// Which records are live is a function of the records themselves and a time, never of
// the order they arrived in: that is what lets two hosts holding the same records
// compute the same hash.

import { b64u, canon, hash } from './canon.js';
import { claimPrecedence, compareClaims, precedenceShaped, verifyClaim } from './claims.js';
import { eligible, isActive, taskHours } from './lease.js';
import { acceptedSet, checkJoin, verifyVoucher, voucherOf } from './membership.js';
import {
  LIMITS, checkShape, checkSignature, compareVersions, isBytes, isObject, isTime, parseKey, recordDigest, recordKey,
  shaped, versionPrecedence,
} from './records.js';
import { CLOCK_SKEW_SECS, MEMBER_RETENTION_SECS, RECORD_RETENTION_SECS } from '../paths.js';

export const MAX_PULL_KEYS = 4096;
export const MAX_PUSH_RECORDS = 1024;
export const MAX_HELLO_CHAIN = 8;

const memberKey = (pk) => `member/${pk}`;
const offerKey = (taskId, host) => `offer/${taskId}/${host}`;
const typeOfKey = (key) => key.slice(0, key.indexOf('/'));

// Negative when the first version of `key` wins, positive when the second does.
function order(key, precedenceA, digestA, precedenceB, digestB) {
  return typeOfKey(key) === 'claim'
    ? compareClaims(key.slice('claim/'.length), precedenceA, digestA, precedenceB, digestB)
    : compareVersions(precedenceA, digestA, precedenceB, digestB);
}

// Why a well-shaped record does not hold for every host alike, or null when it does.
function disproof(record) {
  if (!checkSignature(record)) return 'bad-signature';
  if (record.type === 'member') return verifyVoucher(record) ? null : 'bad-voucher';
  return record.type === 'claim' ? verifyClaim(record) : null;
}

// How far a member's record is from a root of the pool by vouchers: 0 for a record
// without one, one more than its voucher's signer's otherwise, and Infinity when the
// chain ends at a record that is not held or never ends.
function depthOf(pk, members, memo) {
  const path = [];
  let at = pk;
  while (!memo.has(at)) {
    const entry = members.get(at);
    const by = entry ? voucherOf(entry.record)?.by : null;
    if (!entry || path.includes(at)) memo.set(at, Infinity);
    else if (!by) memo.set(at, 0);
    else {
      path.push(at);
      at = by;
    }
  }
  let depth = memo.get(at);
  while (path.length > 0) memo.set(path.pop(), depth += 1);
  return memo.get(pk);
}

// The members a pool with more of them than it holds keeps: the ones nearest a root,
// then the earliest to join, then the lowest key. A member is further from the root
// than the one that vouched for it, so none is kept without that one. `self` is kept
// before any of them: a host is a member of its own state, and where the others keep
// no seat for it its hash is not theirs.
function seated(pks, members, self) {
  const memo = new Map();
  const seniority = new Map(pks.map((pk) => [pk, [depthOf(pk, members, memo), members.get(pk).record.joinedAt]]));
  const before = (a, b) => {
    if (a === self || b === self) return a === self ? -1 : 1;
    const [x, y] = [seniority.get(a), seniority.get(b)];
    if (x[0] !== y[0]) return x[0] < y[0] ? -1 : 1;
    if (x[1] !== y[1]) return x[1] - y[1];
    return a < b ? -1 : 1;
  };
  return [...pks].sort(before).slice(0, LIMITS.members);
}

// The entries of `entries` that are live at `asOf` for `self`, and why each other one is
// not. Members first, since an offer or a claim lives only while its signer does; then
// offers, since a claim lives only while an offer it rests on does. Offers and claims are
// taken in key order, each against what its signer has left of its quota, so which ones
// a member over its quota keeps does not depend on the order they arrived in.
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
  const queue = [...members.values()].filter((e) => !past(e.record.at + MEMBER_RETENTION_SECS)).map((e) => e.record.pk);
  // A member record past its retention stays for as long as a kept member's voucher is
  // signed by it: dropped, it would cut everyone it vouched for off from the rest.
  while (queue.length > 0) {
    const pk = queue.pop();
    if (kept.has(pk)) continue;
    kept.add(pk);
    const by = voucherOf(members.get(pk).record)?.by;
    if (by && members.has(by)) queue.push(by);
  }
  const accepted = acceptedSet(self, [...kept].map((pk) => members.get(pk).record));
  const inside = [...kept].filter((pk) => accepted.has(pk));
  const seats = inside.length > LIMITS.members ? new Set(seated(inside, members, self)) : null;
  const roster = new Map(); // pk -> the live member record
  const present = new Map(); // pk -> the record of a member: live, not left, signed lately
  const used = new Map(); // pk -> what that member has live: { offers, claims, bytes }
  for (const [pk, e] of members) {
    if (!kept.has(pk)) dead.set(e.key, 'expired');
    else if (!accepted.has(pk)) dead.set(e.key, 'not-member');
    else if (seats && !seats.has(pk)) dead.set(e.key, 'full');
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
    const offers = (pk) => live.has(offerKey(record.taskId, pk));
    if (expired(record)) dead.set(e.key, 'expired');
    else if (!roster.has(record.executor)) dead.set(e.key, 'not-member');
    // A claim stands on the consent of a host that offers its task - its executor or a
    // member that granted it - and an extension on the offer of the host that asked for it.
    else if (![record.executor, ...record.grants.map((g) => g.by)].some(offers) || (record.ping && !offers(record.ping.by))) dead.set(e.key, 'no-offer');
    else if (!fits(record.executor, 'claims', e.size)) dead.set(e.key, 'quota');
    else live.set(e.key, e);
  }
  return { live, dead, accepted, roster, present, from, until };
}

/// The records one host holds for one pool. `self` is the host's own public key: the
/// members it accepts are the ones connected to it.
export class Pool {
  #entries = new Map(); // key -> { key, type, record, digest, size, precedence }
  #settled = null;

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
  /// (`expired`), signed by nobody this host accepts (`not-member`), a member more than
  /// the pool holds (`full`), an offer or a claim beyond what its signer may have live
  /// (`quota`), or a claim no host offering its task stands behind (`no-offer`). A list
  /// is taken in together, so a member record may let in the records that depend on it
  /// whatever their order. Records no longer live are dropped.
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

  /// `stateHash(asOf)`, base64url.
  stateHash(asOf) {
    const settled = this.#at(asOf);
    settled.hash ??= b64u(hash([...settled.live.keys()].sort().map((key) => [key, settled.live.get(key).digest])));
    return settled.hash;
  }

  /// Is `pk` connected to this host by vouchers at `now`, whatever its member record says?
  vouched(pk, now) {
    return this.#at(now).accepted.has(pk);
  }

  /// Does this host take requests from `pk` at `now`: a key connected to it by vouchers
  /// whose member record, when held, does not say it left?
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

  /// Is the claim record held for the task, if any, signed no later than `asOf`? A claim
  /// made on a state then is signed no earlier than the record it stands over, so it is
  /// never dropped before that record.
  claimSettled(taskId, asOf) {
    const held = this.#entries.get(`claim/${taskId}`);
    return !held || held.record.at <= asOf;
  }

  /// The generation a claim of the task made on the state at `asOf` belongs to: one past
  /// the claim held for it, zero when none is.
  nextGen(taskId, asOf) {
    const claim = this.#at(asOf).live.get(`claim/${taskId}`);
    return claim ? claim.record.gen + 1 : 0;
  }

  /// Every task the pool's members offer, by task id, as
  /// `{ taskId, kind, item, identity, title, hours, createdAt, state, offeredBy, claim }`.
  /// A done offer ends the task for every offer created no later than it was signed, so
  /// one of two hosts offering a task finishes it for both. `state` is `available` or
  /// `claimed` while an offer of a member is open and not ended that way, else `done` when
  /// one is done, else `cancelled`; `offeredBy` lists the hosts of those open offers and
  /// `createdAt` is the earliest of them; `claim` is the claim record while the task is
  /// claimed, else null.
  tasks(now) {
    const { live, present } = this.#at(now);
    const member = (pk) => present.has(pk);
    const offers = new Map();
    for (const key of [...live.keys()].sort()) {
      const { type, record } = live.get(key);
      if (type !== 'offer' || !member(record.host)) continue;
      if (!offers.has(record.taskId)) offers.set(record.taskId, []);
      offers.get(record.taskId).push(record);
    }
    return [...offers].map(([taskId, all]) => {
      const done = all.filter((o) => o.state === 'done');
      const open = all.filter((o) => o.state === 'open' && !done.some((d) => d.at >= o.createdAt));
      const held = live.get(`claim/${taskId}`)?.record;
      const claim = held && member(held.executor) && isActive(held, now) ? held : null;
      const { kind, item, identity, title } = open[0] ?? all[0];
      return {
        taskId, kind, item, identity, title,
        hours: taskHours(open) ?? Math.max(...all.map((o) => o.minRequiredH)),
        createdAt: Math.min(...(open.length > 0 ? open : all).map((o) => o.createdAt)),
        state: open.length > 0 ? (claim ? 'claimed' : 'available') : done.length > 0 ? 'done' : 'cancelled',
        offeredBy: open.map((o) => o.host),
        claim: open.length > 0 ? claim : null,
      };
    });
  }

  /// The latest `at` among the done offers members hold for a task at `now`, or null when
  /// none is done: an offer of that task created no later is ended by it.
  doneAt(taskId, now) {
    const { live, present } = this.#at(now);
    let latest = null;
    for (const { type, record } of live.values()) {
      if (type === 'offer' && record.taskId === taskId && record.state === 'done' && present.has(record.host)) {
        latest = Math.max(latest ?? 0, record.at);
      }
    }
    return latest;
  }

  /// One task of `tasks(now)`, or null when no member offers it.
  task(taskId, now) {
    return this.tasks(now).find((t) => t.taskId === taskId) ?? null;
  }

  /// What a claim round by this host starts from at `now`:
  /// `{ pool, asOf, hash, gen, hours, members, offering, available, eligible }` -
  /// `members` are the other members, `offering` the hosts whose offer is open, `eligible`
  /// whether this host is a member that accepts tasks of that many hours.
  claimSnapshot(taskId, now) {
    const task = this.task(taskId, now);
    const me = this.member(this.self, now);
    return {
      pool: this.id, asOf: now, hash: this.stateHash(now), gen: this.nextGen(taskId, now),
      hours: task?.hours ?? 0,
      members: this.members(now).map((m) => m.pk).filter((pk) => pk !== this.self),
      offering: task?.offeredBy ?? [],
      available: task?.state === 'available' && this.claimSettled(taskId, now) && isTime(this.nextGen(taskId, now)),
      eligible: Boolean(me && task && eligible(me.maxAcceptedH, task.hours)),
    };
  }

  /// `{ pull, push }`: the keys to ask a member for and the keys to send it, given the
  /// index it answered a `sync` at `asOf` with. A key goes one way only: to whichever
  /// side holds the losing version or none. Null when the index is malformed.
  reconcile(theirs, asOf) {
    if (!isObject(theirs)) return null;
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
      if (!Object.hasOwn(theirs, key)) push.push(key);
    }
    return { pull, push };
  }

  /// The answer to `hello` from `from`: `{ body: { index } }` once its member record is
  /// held and it is accepted, else `{ error }` with `bad-request` or `denied`. `chain`,
  /// when given, is the member records that connect the sender to members this host may
  /// know; they are taken in together with the sender's own. A key no voucher connects
  /// to this host yet, the sender's or one of its chain, must also pass `checkJoin`: a
  /// chain record that does not is left out. A key that left is connected still: nobody
  /// put it out, and a newer record of its own brings it back.
  answerHello(body, from, now) {
    const chain = (v) => Array.isArray(v) && v.length <= MAX_HELLO_CHAIN;
    if (!shaped(body, { member: isObject }, { chain }) || body.member.pk !== from) return { error: 'bad-request' };
    const records = [body.member, ...(body.chain ?? [])];
    if (!records.every((r) => checkShape(r, this.id).ok && r.type === 'member')) return { error: 'bad-request' };
    const lets = (record) => this.vouched(record.pk, now) || checkJoin(record, now).ok;
    if (!lets(body.member)) return { error: 'denied', detail: checkJoin(body.member, now).code };
    const { refused } = this.merge(records.filter(lets), now);
    if (!this.member(from, now)) return { error: 'denied', detail: refused.find((r) => r.key === memberKey(from))?.code ?? 'left' };
    return { body: { index: this.index(now) } };
  }

  /// The answer to `sync`: `{ body: { hash } }`, with `index` beside it when the asker's
  /// hash differs; `{ error }` with `bad-request`, or `stale` for an `asOf` too far from `now`.
  answerSync(body, now) {
    if (!shaped(body, { asOf: isTime, hash: (v) => isBytes(v, 32) })) return { error: 'bad-request' };
    if (Math.abs(body.asOf - now) > CLOCK_SKEW_SECS) return { error: 'stale' };
    const mine = this.stateHash(body.asOf);
    return { body: mine === body.hash ? { hash: mine } : { hash: mine, index: this.index(body.asOf) } };
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
