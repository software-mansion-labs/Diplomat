import { hash, tagged, unb64u } from './canon.js';
import { sign, validPk, verify } from './identity.js';
import { leaseAt, verifyLease } from './lease.js';
import {
  LIMITS, backers, backing, grantShaped, isAscending, isBytes, isObject, isTime, parseTaskId, shaped, signRecord,
} from './records.js';
import { CLOCK_SKEW_SECS, GRANT_TTL_SECS, ROUND_TIMEOUT_MS } from '../paths.js';

/// Lower wins.
export function rank(taskId, executor) {
  return hash(tagged('dn1/rank', Buffer.from(taskId, 'utf8'), Buffer.from([0]), unb64u(executor)));
}

export function outranks(taskId, a, b) {
  return Buffer.compare(rank(taskId, a), rank(taskId, b)) < 0;
}

export function rankDelay(taskId, executor, max) {
  return Math.floor((rank(taskId, executor).readUInt32BE(0) / 2 ** 32) * max);
}

/// With `offer`, the member also backs the claim.
export function buildGrant(identity, { pool, taskId, executor, round, hash: stateHash, exp, offer }) {
  const grant = { pool, taskId, executor, round, hash: stateHash, by: identity.pk, exp, ...(offer ? { offer } : {}) };
  return { ...grant, sig: sign(identity, 'dn1/grant', grant) };
}

export function verifyGrant(grant, expect) {
  return grantShaped(grant) && Object.keys(expect).every((k) => grant[k] === expect[k])
    && verify(grant.by, 'dn1/grant', grant);
}

const hoursOf = (claim) => Math.max(...backers(claim).map((pk) => backing(claim, pk).hours));

/// `gen`: this is the executor's `gen`th claim of the task. `offer`: the executor's own
/// backing, when it offers the task too.
export function buildClaim(identity, { pool, taskId, round, gen, grants, absent, offer, now }) {
  const fields = {
    type: 'claim', pool, taskId, executor: identity.pk, round, gen, seq: 0, state: 'held', at: now, claimedAt: now,
    grants, absent, ...(offer ? { offer } : {}),
  };
  const hours = hoursOf(fields);
  return signRecord(identity, { ...fields, ...leaseAt(now, hours, 0), hours });
}

/// Adds a backer to the same version: `seq` stays.
export function joinClaim(identity, claim, { grant, offer }) {
  const { sig: _, ...fields } = claim;
  const next = grant ? {
    ...fields,
    grants: [...claim.grants.filter((g) => g.by !== grant.by), grant].sort((a, b) => (a.by < b.by ? -1 : 1)),
    absent: claim.absent.filter((pk) => pk !== grant.by),
  } : { ...fields, offer };
  const hours = hoursOf(next);
  return signRecord(identity, { ...next, hours, ...leaseAt(claim.claimedAt, hours, claim.seq) });
}

/// The checks every host makes alike; whether a backer offers the task is the pool's to check.
export function verifyClaim(claim) {
  const signers = claim.grants.map((g) => g.by);
  if (!isAscending(signers, validPk)) return 'bad-claim';
  if ((claim.spec !== undefined) !== (claim.state === 'completed')) return 'bad-claim';
  const outside = [claim.executor, ...signers];
  if (signers.includes(claim.executor) || claim.absent.some((pk) => outside.includes(pk))) return 'bad-claim';
  if (claim.hours !== hoursOf(claim)) return 'bad-claim';
  const bound = { pool: claim.pool, taskId: claim.taskId, executor: claim.executor, round: claim.round };
  for (const grant of claim.grants) {
    if (claim.claimedAt > grant.exp || !verifyGrant(grant, bound)) return 'bad-grant';
  }
  return verifyLease(claim);
}

export function claimPrecedence(claim) {
  return [claim.gen, claim.round, claim.seq, backers(claim).length];
}

export function precedenceShaped(p) {
  return Array.isArray(p) && p.length === 4 && isTime(p[0]) && isBytes(p[1], 8) && isTime(p[2])
    && Number.isSafeInteger(p[3]) && p[3] >= 0 && p[3] <= LIMITS.list + 1;
}

/// Negative when the first wins; a total order.
export function compareClaims([genA, roundA, seqA, backersA], hashA, [genB, roundB, seqB, backersB], hashB) {
  if (genA !== genB) return genB - genA;
  if (roundA !== roundB) return roundA < roundB ? -1 : 1;
  if (seqA !== seqB) return seqB - seqA;
  if (backersA !== backersB) return backersB - backersA;
  return Buffer.compare(unb64u(hashA), unb64u(hashB));
}

/// Negative when `a` holds the offer of `host`, which backs both.
export function compareBacked(host, a, b) {
  const [genA, genB] = [backing(a, host).gen, backing(b, host).gen];
  return genA !== genB ? genB - genA : Buffer.compare(rank(a.taskId, a.executor), rank(b.taskId, b.executor));
}

const LOCK = {
  taskId: (v) => parseTaskId(v) !== null, round: (v) => isBytes(v, 8), asOf: isTime, hash: (v) => isBytes(v, 32),
};
const UNLOCK = { taskId: LOCK.taskId, round: LOCK.round };

/// A host's own claim round holds its task here too, which is how it refuses a rival's
/// lock. A backing lock keeps `at` and `gen`, so asked again in the same round the member
/// gives the same backing.
export class LockTable {
  #locks = new Map(); // taskId -> { executor, round, exp, at?, gen? }

  constructor(entries = []) {
    for (const [taskId, lock] of entries) this.#locks.set(taskId, { ...lock });
  }

  entries() {
    return [...this.#locks].map(([taskId, lock]) => [taskId, { ...lock }]);
  }

  /// Live through `exp`: the claim may be made at that very second.
  holder(taskId, now) {
    const lock = this.#locks.get(taskId);
    if (lock && lock.exp < now) this.#locks.delete(taskId);
    return this.#locks.get(taskId) ?? null;
  }

  hold(taskId, executor, round, exp, now) {
    const lock = this.holder(taskId, now);
    if (lock && lock.executor !== executor) return false;
    this.#locks.set(taskId, { executor, round, exp });
    return true;
  }

  prune(now) {
    const before = this.#locks.size;
    for (const [taskId, lock] of this.#locks) {
      if (lock.exp < now) this.#locks.delete(taskId);
    }
    return this.#locks.size !== before;
  }

  release(taskId, executor, round) {
    const lock = this.#locks.get(taskId);
    return lock?.executor === executor && lock.round === round && this.#locks.delete(taskId);
  }

  /// The grant backs the claim when this member offers the task, no claim holds that offer
  /// and the claimant accepts its hours; `nextGen()` then gives the backing's `gen`, or null
  /// to withhold it.
  answer({ pool, identity, from, body, now, nextGen }) {
    if (!shaped(body, LOCK) || parseTaskId(body.taskId).pool !== pool.id) return { error: 'bad-request' };
    if (Math.abs(body.asOf - now) > CLOCK_SKEW_SECS) return { error: 'stale' };
    const claimant = pool.member(from, now);
    if (!claimant) return { error: 'not-member' };
    if (pool.stateHash(body.asOf) !== body.hash) return { body: { stale: true } };
    const task = pool.task(body.taskId, now);
    if (!task || task.free.length === 0) return { body: { challenge: { reason: 'unavailable' } } };
    const before = this.holder(body.taskId, now);
    // By this member's clock, whatever time the claimant says it is.
    if (!this.hold(body.taskId, from, body.round, now + GRANT_TTL_SECS, now)) {
      return { body: { challenge: { reason: 'locked', holder: before.executor } } };
    }
    const mine = task.offers.find((o) => o.host === identity.pk);
    const again = before?.round === body.round && before.at === mine?.createdAt ? before.gen : undefined;
    const gen = mine && !mine.claim && claimant.maxAcceptedH >= mine.hours ? again ?? nextGen() : null;
    if (gen !== null) Object.assign(this.#locks.get(body.taskId), { at: mine.createdAt, gen });
    const grant = buildGrant(identity, {
      pool: pool.id, taskId: body.taskId, executor: from, round: body.round, hash: body.hash, exp: body.asOf + GRANT_TTL_SECS,
      ...(gen === null ? {} : { offer: { at: mine.createdAt, gen, hours: mine.hours } }),
    });
    return { body: { grant } };
  }

  unlock({ from, body }) {
    if (!shaped(body, UNLOCK)) return { error: 'bad-request' };
    this.release(body.taskId, from, body.round);
    return { body: {} };
  }
}

const CHALLENGE = {
  reason: (v) => ['unavailable', 'locked'].includes(v),
};

/// One attempt by `self` to claim a task, as a state machine that does nothing itself:
/// each method returns the actions to carry out, in order:
///
/// - `{ do: 'sync' | 'lock', to, wave, body, retry? }` - send it and feed the answer to
///   `onSync` / `onLock`, or call `noAnswer`. `retry` marks a repeat the caller should pace.
/// - `{ do: 'resync', with }` - reconcile records with that member (null: the grants are
///   just too old), then `rebase` on a fresh snapshot.
/// - `{ do: 'unlock', to, body }` - send it; the answer does not matter.
/// - `{ do: 'commit', gen, grants, absent, own }` - `buildClaim` at the same `now` and push
///   it; `own` is `{ at, hours }` of the claimant's own offer when the claim takes it, else null.
/// - `{ do: 'stand-down', reason }`.
///
/// A member is absent once a request to it went unanswered and it has answered nothing in
/// this round; one that has answered anything must grant.
export class ClaimRound {
  #members = new Map(); // pk -> { heard, absent, agreed, asked, locked, grant }
  #snapshot = null;
  #restated = false;

  constructor({ taskId, self, round, now, timeoutSecs = Math.ceil(ROUND_TIMEOUT_MS / 1000) }) {
    this.taskId = taskId;
    this.self = self;
    this.round = round;
    this.deadline = now + timeoutSecs;
    this.wave = 0;
    this.phase = 'new'; // new, sync, lock, committed, stood-down
    this.reason = null;
  }

  get over() {
    return this.phase === 'committed' || this.phase === 'stood-down';
  }

  get present() {
    return [...this.#members].filter(([, m]) => m.heard).map(([pk]) => pk).sort();
  }

  get absent() {
    return [...this.#members].filter(([, m]) => m.absent).map(([pk]) => pk).sort();
  }

  /// `snapshot`: from `Pool.claimSnapshot`.
  rebase(snapshot, now) {
    if (this.over) return [];
    if (!snapshot.available) return this.#standDown('unavailable');
    if (!snapshot.eligible) return this.#standDown('hours');
    if (now >= this.deadline) return this.#standDown('timeout');
    const actions = [];
    const members = new Map();
    for (const pk of snapshot.members) {
      const { heard = false, absent = false, locked = false } = this.#members.get(pk) ?? {};
      members.set(pk, { heard, absent, locked, agreed: false, asked: false, grant: null });
    }
    for (const [pk, m] of this.#members) {
      if (!members.has(pk) && m.locked) actions.push(this.#unlock(pk));
    }
    this.#members = members;
    this.#snapshot = snapshot;
    this.#restated = false;
    this.wave += 1;
    this.phase = 'sync';
    for (const pk of members.keys()) actions.push(this.#sync(pk));
    return [...actions, ...this.#advance(now)];
  }

  /// An earlier wave's answer decides nothing but still makes its member present.
  onSync(from, wave, body, now) {
    const [m, back] = this.#hear(from);
    if (!m) return [];
    if (wave !== this.wave) return back ? [this.#sync(from, true)] : [];
    if (!isObject(body) || body.hash !== this.#snapshot.hash) {
      m.agreed = false;
      m.grant = null;
      return [{ do: 'resync', with: from }];
    }
    m.agreed = true;
    return this.#advance(now);
  }

  onLock(from, wave, body, now) {
    const [m] = this.#hear(from);
    if (!m || wave !== this.wave || !m.asked) return [];
    const s = this.#snapshot;
    if (shaped(body, { grant: grantShaped })) {
      const { offer } = body.grant;
      const asked = s.backers[from];
      // Only with the offer the claimant saw it hold.
      const fine = (!offer || (asked !== undefined && offer.at === asked.at && offer.hours === asked.hours))
        && verifyGrant(body.grant, {
          pool: s.pool, taskId: this.taskId, executor: this.self, round: this.round, hash: s.hash, by: from,
          exp: s.asOf + GRANT_TTL_SECS,
        });
      if (!fine) return [this.#lock(from, true)];
      m.grant = body.grant;
      return this.#advance(now);
    }
    if (shaped(body, { stale: (v) => v === true })) {
      m.agreed = false;
      m.grant = null;
      return [{ do: 'resync', with: from }];
    }
    if (!shaped(body, { challenge: (c) => shaped(c, CHALLENGE, { holder: validPk }) })) return [this.#lock(from, true)];
    const { reason, holder } = body.challenge;
    if (reason !== 'locked') return this.#standDown(reason);
    if (holder === undefined || holder === this.self) return [this.#lock(from, true)];
    if (outranks(this.taskId, holder, this.self)) return this.#standDown('outranked');
    return [this.#lock(from, true)];
  }

  noAnswer(from, wave, now) {
    const m = this.#current(from, wave);
    if (!m) return [];
    if (!m.heard) {
      m.absent = true;
      return this.#advance(now);
    }
    if (this.phase === 'sync' && !m.agreed) return [this.#sync(from, true)];
    if (this.phase === 'lock' && !m.grant) return [this.#lock(from, true)];
    return [];
  }

  tick(now) {
    if (this.over || this.phase === 'new') return [];
    if (now >= this.deadline) return this.#standDown('timeout');
    return this.#tooOld(now) ? this.#restate() : [];
  }

  abort(reason) {
    return this.over ? [] : this.#standDown(reason);
  }

  #current(from, wave) {
    return this.over || wave !== this.wave ? null : this.#members.get(from) ?? null;
  }

  // `[member, wasAbsent]`; present whichever wave it answered.
  #hear(from) {
    const m = this.over ? null : this.#members.get(from) ?? null;
    if (!m) return [null, false];
    const back = m.absent;
    m.heard = true;
    m.absent = false;
    return [m, back];
  }

  #tooOld(now) {
    return now > this.#snapshot.asOf + GRANT_TTL_SECS;
  }

  #restate() {
    if (this.#restated) return [];
    this.#restated = true;
    return [{ do: 'resync', with: null }];
  }

  #sync(to, retry = false) {
    const { asOf, hash: stateHash } = this.#snapshot;
    return { do: 'sync', to, wave: this.wave, body: { asOf, hash: stateHash }, ...(retry ? { retry } : {}) };
  }

  #lock(to, retry = false) {
    const m = this.#members.get(to);
    m.asked = true;
    m.locked = true;
    const { asOf, hash: stateHash } = this.#snapshot;
    const body = { taskId: this.taskId, round: this.round, asOf, hash: stateHash };
    return { do: 'lock', to, wave: this.wave, body, ...(retry ? { retry } : {}) };
  }

  #unlock(to) {
    return { do: 'unlock', to, body: { taskId: this.taskId, round: this.round } };
  }

  #advance(now) {
    const members = [...this.#members];
    if (this.phase === 'sync') {
      if (!members.every(([, m]) => m.agreed || m.absent)) return [];
      this.phase = 'lock';
    }
    const actions = members.filter(([, m]) => m.agreed && !m.absent && !m.asked).map(([pk]) => this.#lock(pk));
    if (actions.length > 0 || !members.every(([, m]) => m.grant || m.absent)) return actions;
    if (now >= this.deadline) return this.#standDown('timeout');
    if (this.#tooOld(now)) return this.#restate();
    const grants = members.filter(([, m]) => m.grant).map(([, m]) => m.grant).sort((a, b) => (a.by < b.by ? -1 : 1));
    const { gen, own } = this.#snapshot;
    if (!own && !grants.some((g) => g.offer)) return this.#standDown('no-requester');
    this.phase = 'committed';
    return [{ do: 'commit', gen, grants, absent: this.absent, own }];
  }

  #standDown(reason) {
    const actions = [...this.#members].filter(([, m]) => m.locked).map(([pk]) => this.#unlock(pk));
    this.phase = 'stood-down';
    this.reason = reason;
    return [...actions, { do: 'stand-down', reason }];
  }
}
