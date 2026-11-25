// Which records are live depends on the records and a time, never on their arrival
// order: that is what lets two hosts holding the same records compute the same hash.

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
/// A response is a mebibyte at most.
export const INDEX_PAGE_BYTES = 256 * 2 ** 10;
export const MAX_PUSH_RECORDS = 1024;
export const MAX_HELLO_CHAIN = LIMITS.depth;

const memberKey = (pk) => `member/${pk}`;
const offerKey = (taskId, host) => `offer/${taskId}/${host}`;
const typeOfKey = (key) => key.slice(0, key.indexOf('/'));

// Negative when the first version of `key` wins.
function order(key, precedenceA, digestA, precedenceB, digestB) {
  return (typeOfKey(key) === 'claim' ? compareClaims : compareVersions)(precedenceA, digestA, precedenceB, digestB);
}

// The refusal code, or null when the record proves itself.
function disproof(record) {
  if (!checkSignature(record)) return 'bad-signature';
  if (record.type === 'member') return verifyVoucher(record) ? null : 'bad-voucher';
  return record.type === 'claim' ? verifyClaim(record) : null;
}

// Members first, since an offer or a claim lives only while its signer does; then offers,
// since a claim lives only while a backer's offer does. Offers and claims go in key order
// against their signer's quota, so what an over-quota member keeps is order-independent.
// Each version is judged by its own `at`, so a winning version (signed no earlier) is
// never dropped before the one it beat.
// The answer holds for every time from `from` up to `until`.
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
  // A host's own member record never expires: it is the membership it signs again when back.
  const queue = [...members.values()].filter((e) => e.record.pk === self || !past(e.record.at + MEMBER_RETENTION_SECS)).map((e) => e.record.pk);
  // An expired member record stays while a kept member's voucher is signed by it, or
  // everyone it vouched for would be cut off.
  while (queue.length > 0) {
    const pk = queue.pop();
    if (kept.has(pk)) continue;
    kept.add(pk);
    const by = members.get(pk).record.voucher?.by;
    if (members.has(by)) queue.push(by);
  }
  const accepted = seating(self, [...kept].map((pk) => members.get(pk).record));
  const roster = new Map(); // pk -> live member record
  const present = new Map(); // pk -> member record: live, not left, unexpired
  const used = new Map();
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

/// `self`, this host's key, decides whom it seats (`seating`).
export class Pool {
  #entries = new Map(); // key -> { key, type, record, digest, size, precedence }
  #settled = null;
  #tasks = null; // `tasks()` cache
  #moved = { put: new Set(), drop: new Set() }; // since the last `delta()`
  #gone = []; // { record, code } since the last `gone()`

  constructor({ id, self }) {
    this.id = id;
    this.self = self;
  }

  #at(asOf) {
    const held = this.#settled;
    if (!held || asOf < held.from || asOf >= held.until) this.#settled = settle(this.#entries, this.self, asOf);
    return this.#settled;
  }

  /// `fresh`: accepted keys not held before. A malformed record is refused with an empty
  /// key. A list is taken in together, so a member record lets in the records that depend
  /// on it whatever their order. Records no longer live are dropped.
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
    for (const [key, entry] of this.#entries) {
      if (settled.live.has(key)) continue;
      drop.add(key);
      this.#gone.push({ record: entry.record, code: settled.dead.get(key) });
    }
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

  /// Would it fit its signer's quota with `LIMITS.spare` bytes left over? Also for a
  /// record not yet signed.
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

  prune(now) {
    this.merge([], now);
  }

  /// Records taken in and keys dropped since the last call.
  delta() {
    const { put, drop } = this.#moved;
    this.#moved = { put: new Set(), drop: new Set() };
    return { put: this.records([...put]), drop: [...drop].sort() };
  }

  /// Records dropped since the last call, each with the code `merge` would refuse it with.
  gone() {
    const gone = this.#gone;
    this.#gone = [];
    return gone;
  }

  get(key) {
    return this.#entries.get(key)?.record ?? null;
  }

  records(keys = [...this.#entries.keys()]) {
    return [...new Set(keys)].sort().map((key) => this.get(key)).filter(Boolean);
  }

  /// `{ key: [precedence, hash] }`, in key order.
  index(asOf) {
    const { live } = this.#at(asOf);
    return Object.fromEntries([...live.keys()].sort().map((key) => [key, [live.get(key).precedence, live.get(key).digest]]));
  }

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

  stateHash(asOf) {
    const settled = this.#at(asOf);
    settled.hash ??= b64u(hash([...settled.live.keys()].sort().map((key) => [key, settled.live.get(key).digest])));
    return settled.hash;
  }

  /// A seat, even for a key whose record says it left.
  vouched(pk, now) {
    return this.#at(now).accepted.has(pk);
  }

  depth(pk, now) {
    return this.#at(now).accepted.get(pk);
  }

  branch(pk, now) {
    return this.depth(pk, now) === LIMITS.depth ? this.get(memberKey(pk)).voucher.by : pk;
  }

  accepts(pk, now) {
    return this.vouched(pk, now) && this.#at(now).roster.get(pk)?.left !== true;
  }

  members(now) {
    const { present } = this.#at(now);
    return [...present.keys()].sort().map((pk) => present.get(pk));
  }

  member(pk, now) {
    return this.#at(now).present.get(pk) ?? null;
  }

  /// Also hosts whose records expired without leaving, so one that comes back is heard.
  known(now) {
    const { roster } = this.#at(now);
    return [...roster.keys()].sort().map((pk) => roster.get(pk)).filter((m) => !m.left);
  }

  /// An offer is its host's alone: no other host's record ends it, and only a claim its
  /// host backs holds it (PROTOCOL.md section 7). A row's `claim` holds the most open offers.
  tasks(now) {
    const settled = this.#at(now);
    if (this.#tasks?.settled === settled && this.#tasks.now === now) return this.#tasks.rows;
    const { live, present } = settled;
    const byTask = new Map();
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

  claims(taskId, now) {
    this.tasks(now);
    return this.#tasks.byTask.get(taskId)?.claims ?? [];
  }

  task(taskId, now) {
    return this.tasks(now).find((t) => t.taskId === taskId) ?? null;
  }

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

  /// Against a peer's index page: a key goes one way only, to the side holding the losing
  /// version or none.
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

  /// `chain`: the member records from the sender up to the pool's first member. A key that
  /// left keeps its seat: a newer record of its own brings it back.
  answerHello(body, from, now) {
    const chain = (v) => Array.isArray(v) && v.length <= MAX_HELLO_CHAIN;
    if (!shaped(body, { member: isObject }, { chain }) || body.member.pk !== from) return { error: 'bad-request' };
    const records = [body.member, ...(body.chain ?? [])];
    if (!records.every((r) => checkShape(r, this.id).ok && r.type === 'member')) return { error: 'bad-request' };
    const { refused } = this.merge(records, now);
    if (!this.member(from, now)) return { error: 'denied', detail: refused.find((r) => r.key === memberKey(from))?.code ?? 'left' };
    return { body: this.indexPage(now) };
  }

  answerSync(body, now) {
    const after = (v) => parseKey(v, this.id) !== null;
    if (!shaped(body, { asOf: isTime, hash: (v) => isBytes(v, 32) }, { after })) return { error: 'bad-request' };
    if (Math.abs(body.asOf - now) > CLOCK_SKEW_SECS) return { error: 'stale' };
    const mine = this.stateHash(body.asOf);
    return { body: mine === body.hash ? { hash: mine } : { hash: mine, ...this.indexPage(body.asOf, body.after) } };
  }

  answerPull(body) {
    const keys = (v) => Array.isArray(v) && v.length <= MAX_PULL_KEYS && v.every((k) => parseKey(k, this.id) !== null);
    if (!shaped(body, { keys })) return { error: 'bad-request' };
    return { body: { records: this.records(body.keys) } };
  }

  answerPush(body, now) {
    if (!shaped(body, { records: (v) => Array.isArray(v) && v.length <= MAX_PUSH_RECORDS })) return { error: 'bad-request' };
    const { accepted, refused } = this.merge(body.records, now);
    return { body: { accepted, refused } };
  }
}
