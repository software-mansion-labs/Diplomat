// Claiming a task (PROTOCOL.md section 7): the rank that settles every tie, the locks a
// member grants, the round a claimant runs to collect them, and which of two claims for
// one task stands.

import { hash, tagged, unb64u } from './canon.js';
import { sign, validPk, verify } from './identity.js';
import { leaseAt, verifyLease } from './lease.js';
import { grantShaped, isAscending, isBytes, isObject, isTime, parseTaskId, shaped, signRecord } from './records.js';
import { CLOCK_SKEW_SECS, GRANT_TTL_SECS, ROUND_TIMEOUT_MS } from '../paths.js';

/// `rank(taskId, executor)`: 32 bytes every host computes alike. Lower wins.
export function rank(taskId, executor) {
  return hash(tagged('dn1/rank', Buffer.from(taskId, 'utf8'), Buffer.from([0]), unb64u(executor)));
}

/// Does executor `a` rank better than executor `b` on this task?
export function outranks(taskId, a, b) {
  return Buffer.compare(rank(taskId, a), rank(taskId, b)) < 0;
}

/// How long a host waits before it starts to claim a task: its rank's share of `max`.
export function rankDelay(taskId, executor, max) {
  return Math.floor((rank(taskId, executor).readUInt32BE(0) / 2 ** 32) * max);
}

/// A member's signed consent to `executor` claiming `taskId` in `round`, as generation
/// `gen`, on the state `hash`, until `exp`.
export function buildGrant(identity, { pool, taskId, executor, round, gen, hash: stateHash, exp }) {
  const grant = { pool, taskId, executor, round, gen, hash: stateHash, by: identity.pk, exp };
  return { ...grant, sig: sign(identity, 'dn1/grant', grant) };
}

/// Is this a grant signed by the member it names, with every member of `expect` as given?
export function verifyGrant(grant, expect) {
  return grantShaped(grant) && Object.keys(expect).every((k) => grant[k] === expect[k])
    && verify(grant.by, 'dn1/grant', grant);
}

/// A committed claim: the executor's signed record of a round every present member granted.
export function buildClaim(identity, { pool, taskId, round, gen, hours, grants, absent, now }) {
  return signRecord(identity, {
    type: 'claim', pool, taskId, executor: identity.pk, round, gen, seq: 0, state: 'held', at: now,
    claimedAt: now, ...leaseAt(now, hours, 0), hours, grants, absent,
  });
}

/// Null when a well-shaped claim holds for every host alike: its grants are from distinct
/// members other than the executor and the absent, each signed, bound to this task,
/// executor, round and generation, all for one state hash, and live when the claim was
/// made; and its lease is the one its times dictate. Otherwise `bad-claim`, `bad-grant`,
/// `bad-lease` or `bad-ping`.
export function verifyClaim(claim) {
  const signers = claim.grants.map((g) => g.by);
  if (!isAscending(signers, validPk)) return 'bad-claim';
  const outside = [claim.executor, ...signers];
  if (signers.includes(claim.executor) || claim.absent.some((pk) => outside.includes(pk))) return 'bad-claim';
  const bound = { pool: claim.pool, taskId: claim.taskId, executor: claim.executor, round: claim.round, gen: claim.gen };
  for (const grant of claim.grants) {
    if (grant.hash !== claim.grants[0].hash || grant.exp !== claim.grants[0].exp) return 'bad-grant';
    if (claim.claimedAt > grant.exp || claim.claimedAt < grant.exp - GRANT_TTL_SECS) return 'bad-grant';
    if (!verifyGrant(grant, bound)) return 'bad-grant';
  }
  return verifyLease(claim);
}

/// What orders a claim among the claims for its task: `[gen, executor, round, seq]`.
export function claimPrecedence(claim) {
  return [claim.gen, claim.executor, claim.round, claim.seq];
}

/// Is this shaped like a claim's precedence?
export function precedenceShaped(p) {
  return Array.isArray(p) && p.length === 4 && isTime(p[0]) && validPk(p[1]) && isBytes(p[2], 8) && isTime(p[3]);
}

/// Which of two claims for `taskId` stands, each given as its precedence and its
/// base64url record hash: negative when the first does, positive when the second does,
/// zero for the same record. The later generation stands; within a generation the
/// better-ranked executor; for one executor the lower round, then the higher `seq`, then
/// the lower hash. Every pair is ordered, and the order is transitive.
export function compareClaims(taskId, [genA, executorA, roundA, seqA], hashA, [genB, executorB, roundB, seqB], hashB) {
  if (genA !== genB) return genB - genA;
  if (executorA !== executorB) return Buffer.compare(rank(taskId, executorA), rank(taskId, executorB));
  if (roundA !== roundB) return roundA < roundB ? -1 : 1;
  if (seqA !== seqB) return seqB - seqA;
  return Buffer.compare(unb64u(hashA), unb64u(hashB));
}

/// The host a claim's executor asks for the key: the lowest key among the hosts
/// `offering` the task that granted the claim, the executor itself counted when it offers
/// it. Null when none of them offers it.
export function keyHost(claim, offering) {
  const party = [claim.executor, ...claim.grants.map((g) => g.by)];
  return offering.filter((pk) => party.includes(pk)).sort()[0] ?? null;
}

const LOCK = {
  taskId: (v) => parseTaskId(v) !== null, round: (v) => isBytes(v, 8), asOf: isTime, hash: (v) => isBytes(v, 32),
};
const UNLOCK = { taskId: LOCK.taskId, round: LOCK.round };

/// The locks one member holds in one pool: at most one executor per task, each until its
/// grant expires, the executor unlocks, or the claim is committed. A host's own claim
/// round holds its task here too, until the round's deadline, which is how it refuses a
/// rival's lock.
export class LockTable {
  #locks = new Map(); // taskId -> { executor, round, exp }

  /// A table holding `entries`, as `entries()` returned them.
  constructor(entries = []) {
    for (const [taskId, lock] of entries) this.#locks.set(taskId, { ...lock });
  }

  /// `[taskId, { executor, round, exp }]` for every lock held, to store or restore.
  entries() {
    return [...this.#locks].map(([taskId, lock]) => [taskId, { ...lock }]);
  }

  /// The lock on a task that is live at `now`, or null. A lock is live through its `exp`:
  /// the claim it was granted for may be made at that very second.
  holder(taskId, now) {
    const lock = this.#locks.get(taskId);
    if (lock && lock.exp < now) this.#locks.delete(taskId);
    return this.#locks.get(taskId) ?? null;
  }

  /// Takes the lock on a task for `executor` until `exp`. False, with nothing changed,
  /// when another executor holds it at `now`.
  hold(taskId, executor, round, exp, now) {
    const lock = this.holder(taskId, now);
    if (lock && lock.executor !== executor) return false;
    this.#locks.set(taskId, { executor, round, exp });
    return true;
  }

  /// Drops the lock on a task when `executor` holds it for `round`: the executor unlocked,
  /// or its claim of that round was committed.
  release(taskId, executor, round) {
    const lock = this.#locks.get(taskId);
    if (lock && lock.executor === executor && lock.round === round) this.#locks.delete(taskId);
  }

  /// A member's answer to a `lock` request from `from`: `{ body }` holding `{ grant }`,
  /// `{ challenge: { reason, holder? } }` or `{ stale: true }`, or `{ error }` with
  /// `bad-request`, `stale` (an `asOf` too far from `now`) or `not-member`. `pool` is the
  /// member's own Pool and `identity` signs the grant.
  answer({ pool, identity, from, body, now }) {
    if (!shaped(body, LOCK) || parseTaskId(body.taskId).pool !== pool.id) return { error: 'bad-request' };
    if (Math.abs(body.asOf - now) > CLOCK_SKEW_SECS) return { error: 'stale' };
    const claimant = pool.member(from, now);
    if (!claimant) return { error: 'not-member' };
    if (pool.stateHash(body.asOf) !== body.hash) return { body: { stale: true } };
    const task = pool.task(body.taskId, now);
    if (task?.state !== 'available') return { body: { challenge: { reason: 'unavailable' } } };
    if (claimant.maxAcceptedH < task.hours) return { body: { challenge: { reason: 'hours' } } };
    const exp = body.asOf + GRANT_TTL_SECS;
    if (!this.hold(body.taskId, from, body.round, exp, now)) {
      return { body: { challenge: { reason: 'locked', holder: this.#locks.get(body.taskId).executor } } };
    }
    const grant = buildGrant(identity, {
      pool: pool.id, taskId: body.taskId, executor: from, round: body.round, gen: pool.nextGen(body.taskId, body.asOf),
      hash: body.hash, exp,
    });
    return { body: { grant } };
  }

  /// A member's answer to an `unlock` request from `from`: `{ body: {} }`, the lock
  /// dropped when `from` holds it for that round, or `{ error: 'bad-request' }`.
  unlock({ from, body }) {
    if (!shaped(body, UNLOCK)) return { error: 'bad-request' };
    this.release(body.taskId, from, body.round);
    return { body: {} };
  }
}

const CHALLENGE = {
  reason: (v) => ['unavailable', 'hours', 'locked'].includes(v),
};

/// One attempt by `self` to claim a task, as a state machine. It does nothing by itself:
/// each method takes what happened and returns the actions to carry out, in order:
///
/// - `{ do: 'sync', to, wave, body, retry? }` and `{ do: 'lock', to, wave, body, retry? }` -
///   send that request and feed the answer to `onSync` / `onLock`, or call `noAnswer`
///   when there is none. `retry` marks a repeat the caller should pace.
/// - `{ do: 'resync', with }` - reconcile records with that member (`with` null: with
///   nobody, the grants are simply too old), then `rebase` on a fresh snapshot.
/// - `{ do: 'unlock', to, body }` - send it; the answer does not matter.
/// - `{ do: 'commit', gen, hours, grants, absent }` - sign the claim with `buildClaim` at
///   the same `now` and push it. The round is over.
/// - `{ do: 'stand-down', reason }` - the round is over without a claim: `unavailable`,
///   `hours`, `outranked`, `no-requester` or `timeout`.
///
/// A member is absent once a request to it went unanswered and it has answered nothing in
/// this round; one that has answered anything is present and must grant.
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

  /// Is the round over, committed or stood down?
  get over() {
    return this.phase === 'committed' || this.phase === 'stood-down';
  }

  /// The members that have answered in this round.
  get present() {
    return [...this.#members].filter(([, m]) => m.heard).map(([pk]) => pk).sort();
  }

  /// The members written off as absent in this round.
  get absent() {
    return [...this.#members].filter(([, m]) => m.absent).map(([pk]) => pk).sort();
  }

  /// Starts a wave on `snapshot`, the claimant's own view of the task as
  /// `Pool.claimSnapshot` gives it: every member is asked to confirm the state again.
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

  /// A member's answer to a `sync` of this round. One to an earlier wave decides nothing,
  /// but its member is present all the same.
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

  /// A member's answer to this wave's `lock`.
  onLock(from, wave, body, now) {
    const [m] = this.#hear(from);
    if (!m || wave !== this.wave || !m.asked) return [];
    const s = this.#snapshot;
    if (shaped(body, { grant: grantShaped })) {
      const fine = verifyGrant(body.grant, {
        pool: s.pool, taskId: this.taskId, executor: this.self, round: this.round, gen: s.gen, hash: s.hash,
        by: from, exp: s.asOf + GRANT_TTL_SECS,
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

  /// A request of this wave to `from` got no answer.
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

  /// Time passed. Stands the round down at its deadline, and asks for a fresh snapshot
  /// once this wave's grants can no longer be committed.
  tick(now) {
    if (this.over || this.phase === 'new') return [];
    if (now >= this.deadline) return this.#standDown('timeout');
    return this.#tooOld(now) ? this.#restate() : [];
  }

  /// Gives the round up for the caller's own reason.
  abort(reason) {
    return this.over ? [] : this.#standDown(reason);
  }

  #current(from, wave) {
    return this.over || wave !== this.wave ? null : this.#members.get(from) ?? null;
  }

  // The member an answer came from, present whichever wave it answered, and whether it
  // had been written off.
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
    const party = [this.self, ...grants.map((g) => g.by)];
    if (!this.#snapshot.offering.some((pk) => party.includes(pk))) return this.#standDown('no-requester');
    this.phase = 'committed';
    return [{ do: 'commit', gen: this.#snapshot.gen, hours: this.#snapshot.hours, grants, absent: this.absent }];
  }

  #standDown(reason) {
    const actions = [...this.#members].filter(([, m]) => m.locked).map(([pk]) => this.#unlock(pk));
    this.phase = 'stood-down';
    this.reason = reason;
    return [...actions, { do: 'stand-down', reason }];
  }
}
