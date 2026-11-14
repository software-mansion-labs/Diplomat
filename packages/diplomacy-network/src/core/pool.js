// One pool's state (PROTOCOL.md sections 5 and 6): the signed records a host holds for
// one repository, what it takes for another record to join them, the hash two hosts
// compare, and what the records say about each task.
//
// Which records are live is a function of the records themselves and a time, never of
// the order they arrived in: that is what lets two hosts holding the same records
// compute the same hash.

import { b64u, hash } from './canon.js';
import { claimPrecedence, compareClaims, precedenceShaped, verifyClaim } from './claims.js';
import { eligible, endsAt, isActive, taskHours } from './lease.js';
import { acceptedSet, checkJoin, verifyVoucher, voucherOf } from './membership.js';
import {
  checkShape, checkSignature, compareVersions, isBytes, isObject, isTime, parseKey, recordDigest, shaped,
  versionPrecedence,
} from './records.js';
import { CLOCK_SKEW_SECS, RECORD_RETENTION_SECS } from '../paths.js';

export const MAX_PULL_KEYS = 4096;
export const MAX_PUSH_RECORDS = 1024;

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

// The entries of `entries` that are live at `asOf` for `self`, and why each other one is
// not. Members first, since an offer or a claim lives only while its signer does; then
// offers, since a lease extension lives only while the offer its ping rests on does.
// The answer is the same for every time from `from` up to `until`: the retention of some
// record runs out at each of the two, and of none in between.
function settle(entries, self, asOf) {
  const live = new Map();
  const dead = new Map();
  const of = (type) => [...entries.values()].filter((e) => e.type === type);
  let [from, until] = [-Infinity, Infinity];
  const over = (endedAt) => {
    const drop = endedAt + RECORD_RETENTION_SECS;
    if (drop <= asOf) from = Math.max(from, drop);
    else until = Math.min(until, drop);
    return drop <= asOf;
  };

  const members = new Map(of('member').map((e) => [e.record.pk, e]));
  const kept = new Set();
  const queue = [...members.values()].filter((e) => !(e.record.left && over(e.record.at))).map((e) => e.record.pk);
  // A member that left stays for as long as a kept member's voucher is signed by it:
  // dropped, it would cut everyone it vouched for off from the rest.
  while (queue.length > 0) {
    const pk = queue.pop();
    if (kept.has(pk)) continue;
    kept.add(pk);
    const by = voucherOf(members.get(pk).record)?.by;
    if (by && members.has(by)) queue.push(by);
  }
  const accepted = acceptedSet(self, [...kept].map((pk) => members.get(pk).record));
  const roster = new Map(); // pk -> the live member record
  for (const [pk, e] of members) {
    if (!kept.has(pk)) dead.set(e.key, 'expired');
    else if (!accepted.has(pk)) dead.set(e.key, 'not-member');
    else {
      live.set(e.key, e);
      roster.set(pk, e.record);
    }
  }
  for (const e of of('offer')) {
    if (e.record.state !== 'open' && over(e.record.at)) dead.set(e.key, 'expired');
    else if (!roster.has(e.record.host)) dead.set(e.key, 'not-member');
    else live.set(e.key, e);
  }
  for (const e of of('claim')) {
    const { record } = e;
    if (over(endsAt(record))) dead.set(e.key, 'expired');
    else if (!roster.has(record.executor)) dead.set(e.key, 'not-member');
    else if (record.ping && !live.has(offerKey(record.taskId, record.ping.by))) dead.set(e.key, 'no-offer');
    else live.set(e.key, e);
  }
  return { live, dead, accepted, roster, from, until };
}

/// The records one host holds for one pool. `self` is the host's own public key: the
/// members it accepts are the ones connected to it.
export class Pool {
  #entries = new Map(); // key -> { key, type, record, digest, precedence }
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
  /// (`expired`), signed by nobody this host accepts (`not-member`), or extending a claim
  /// for a host that does not offer its task (`no-offer`). A list is taken in together,
  /// so a member record may let in the records that depend on it whatever their order.
  /// Records no longer live are dropped.
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
        key, type: record.type, record, digest: recordDigest(record),
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

  /// Does this host take requests from `pk` at `now`: a key connected to it by vouchers
  /// whose member record, when held, does not say it left?
  accepts(pk, now) {
    const { accepted, roster } = this.#at(now);
    return accepted.has(pk) && roster.get(pk)?.left !== true;
  }

  /// The member records of the pool's members at `now` - accepted, held, not left - by key.
  members(now) {
    const { roster } = this.#at(now);
    return [...roster.keys()].sort().map((pk) => roster.get(pk)).filter((m) => !m.left);
  }

  /// The member record of `pk` when it is a member at `now`, or null.
  member(pk, now) {
    const record = this.#at(now).roster.get(pk);
    return record && !record.left ? record : null;
  }

  /// The generation a claim of the task made on the state at `asOf` belongs to: one past
  /// the claim held for it, zero when none is.
  nextGen(taskId, asOf) {
    const claim = this.#at(asOf).live.get(`claim/${taskId}`);
    return claim ? claim.record.gen + 1 : 0;
  }

  /// Every task the pool's members offer, by task id, as
  /// `{ taskId, kind, item, identity, title, hours, state, offeredBy, claim }`. `state` is
  /// `available` or `claimed` while a member's offer is open, else `done` when one is done,
  /// else `cancelled`; `offeredBy` lists the hosts whose offer is open; `claim` is the
  /// claim record while the task is claimed, else null.
  tasks(now) {
    const { live, roster } = this.#at(now);
    const member = (pk) => roster.get(pk)?.left === false;
    const offers = new Map();
    for (const key of [...live.keys()].sort()) {
      const { type, record } = live.get(key);
      if (type !== 'offer' || !member(record.host)) continue;
      if (!offers.has(record.taskId)) offers.set(record.taskId, []);
      offers.get(record.taskId).push(record);
    }
    return [...offers].map(([taskId, all]) => {
      const open = all.filter((o) => o.state === 'open');
      const held = live.get(`claim/${taskId}`)?.record;
      const claim = held && member(held.executor) && isActive(held, now) ? held : null;
      const { kind, item, identity, title } = open[0] ?? all[0];
      return {
        taskId, kind, item, identity, title,
        hours: taskHours(open) ?? Math.max(...all.map((o) => o.minRequiredH)),
        state: open.length > 0 ? (claim ? 'claimed' : 'available') : all.some((o) => o.state === 'done') ? 'done' : 'cancelled',
        offeredBy: open.map((o) => o.host),
        claim: open.length > 0 ? claim : null,
      };
    });
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
      available: task?.state === 'available',
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
  /// held and it is accepted, else `{ error }` with `bad-request` or `denied`. A member
  /// this host has not accepted before must also pass `checkJoin`.
  answerHello(body, from, now) {
    if (!shaped(body, { member: isObject }) || body.member.pk !== from) return { error: 'bad-request' };
    if (!this.accepts(from, now)) {
      const shape = checkShape(body.member, this.id);
      if (!shape.ok || body.member.type !== 'member') return { error: 'bad-request' };
      const join = checkJoin(body.member, now);
      if (!join.ok) return { error: 'denied', detail: join.code };
    }
    const { refused } = this.merge([body.member], now);
    if (!this.member(from, now)) return { error: 'denied', detail: refused[0]?.code ?? 'left' };
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
