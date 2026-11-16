// What the core tests build their worlds from: fixed identities, a seeded generator,
// records with sensible defaults, and hosts that already share a pool.

import crypto from 'node:crypto';
import { b64u } from '../../src/core/canon.js';
import { ClaimRound, LockTable, buildClaim } from '../../src/core/claims.js';
import { identityFromSeed } from '../../src/core/identity.js';
import { createInvite, inviteToken } from '../../src/core/membership.js';
import { Pool } from '../../src/core/pool.js';
import { memberRecord, offerRecord } from '../../src/core/records.js';

export const POOL = 'github.com/acme/widgets';
export const T0 = 1794000000;

const digest = (text) => crypto.createHash('sha256').update(text).digest();

/// The same identity for the same number, every run.
export function ident(n) {
  return identityFromSeed(digest(`dn test identity ${n}`));
}

/// A seeded generator (mulberry32): `next()` in [0, 1), `int(n)` in [0, n), `bytes(n)`,
/// `pick(list)`, `chance(p)`, `shuffle(list)`.
export function prng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
  const int = (n) => Math.floor(next() * n);
  return {
    next, int,
    bytes: (n) => Buffer.from(Array.from({ length: n }, () => int(256))),
    pick: (list) => list[int(list.length)],
    chance: (p) => next() < p,
    shuffle: (list) => {
      const out = [...list];
      for (let i = out.length - 1; i > 0; i--) {
        const j = int(i + 1);
        [out[i], out[j]] = [out[j], out[i]];
      }
      return out;
    },
  };
}

/// An invite token to the test pool signed by `by`.
export function invite(by, { exp = T0 + 86400, n = 0, pool = POOL } = {}) {
  return inviteToken(createInvite(by, { pool, exp, nonce: digest(`invite ${n}`).subarray(0, 16) }));
}

/// A member record of the test pool; `over` replaces any field.
export function member(id, over = {}) {
  return memberRecord(id, { pool: POOL, seq: 0, at: T0, joinedAt: T0, maxAcceptedH: 12, ...over });
}

/// An offer of the test pool's "review pr-578 as octocat"; `over` replaces any field.
export function offer(id, over = {}) {
  return offerRecord(id, {
    pool: POOL, kind: 'review', item: 'pr-578', identity: 'octocat', seq: 0, at: T0, title: 'Review #578',
    minRequiredH: 12, createdAt: T0, ...over,
  });
}

// How many times a host gave an offer away: the count its next backing carries.
function counter() {
  let n = 0;
  return () => (n += 1);
}

/// `n` hosts sharing the test pool: host 0 started it and invited every other. Each is
/// `{ id, pool, locks, nextGen }` and already holds every member record; `nextGen` is
/// what the host hands `LockTable.answer`.
export function club(n, now = T0, over = () => ({})) {
  const ids = Array.from({ length: n }, (_, i) => ident(i));
  const members = ids.map((id, i) => member(id, { ...(i === 0 ? {} : { voucher: invite(ids[0], { n: i }) }), ...over(i) }));
  return ids.map((id) => {
    const pool = new Pool({ id: POOL, self: id.pk });
    pool.merge(members, now);
    return { id, pool, locks: new LockTable(), nextGen: counter() };
  });
}

/// An 8-byte round id for the nth round of a test.
export function roundId(n) {
  return b64u(digest(`round ${n}`).subarray(0, 8));
}

/// Runs a whole claim round for `hosts[i]` at `now`, every other host answering at once,
/// and returns the committed claim (merged into every host) or the reason it stood down.
/// A member that is not among `hosts` never answers.
export function claimNow(hosts, i, taskId, now, n = 0) {
  const me = hosts[i];
  const round = new ClaimRound({ taskId, self: me.id.pk, round: roundId(n), now });
  const peer = (pk) => hosts.find((h) => h.id.pk === pk);
  const queue = round.rebase(me.pool.claimSnapshot(taskId, now), now);
  while (queue.length > 0) {
    const action = queue.shift();
    if (action.to && !peer(action.to)) {
      if (action.do !== 'unlock') queue.push(...round.noAnswer(action.to, action.wave, now));
    } else if (action.do === 'sync') {
      queue.push(...round.onSync(action.to, action.wave, peer(action.to).pool.answerSync(action.body, now).body, now));
    } else if (action.do === 'lock') {
      const { pool, id, locks, nextGen } = peer(action.to);
      queue.push(...round.onLock(action.to, action.wave, locks.answer({ pool, identity: id, from: me.id.pk, body: action.body, now, nextGen }).body, now));
    } else if (action.do === 'unlock') {
      peer(action.to).locks.unlock({ from: me.id.pk, body: action.body });
    } else if (action.do === 'commit') {
      const { gen, grants, absent, own } = action;
      const claim = buildClaim(me.id, {
        pool: POOL, taskId, round: round.round, gen, grants, absent, now, ...(own ? { offer: { ...own, gen: me.nextGen() } } : {}),
      });
      for (const h of hosts) {
        h.pool.merge(claim, now);
        h.locks.release(taskId, claim.executor, claim.round);
      }
      return claim;
    } else if (action.do === 'stand-down') {
      return action.reason;
    } else {
      throw new Error(`a direct round cannot ${action.do}`);
    }
  }
  throw new Error('the round stopped without an outcome');
}
