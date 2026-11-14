// Claiming: what a member answers a lock with, what a claimant does with each answer,
// what makes a committed claim hold for every host, and which of two claims stands.
// Run: node test/core-claims.mjs

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { b64u, unb64u } from '../src/core/canon.js';
import {
  ClaimRound, LockTable, buildClaim, buildGrant, claimPrecedence, compareClaims, keyHost, outranks, rank, rankDelay, verifyClaim, verifyGrant,
} from '../src/core/claims.js';
import { verify } from '../src/core/identity.js';
import { endClaim } from '../src/core/lease.js';
import { Pool } from '../src/core/pool.js';
import { recordDigest, signRecord } from '../src/core/records.js';
import { POOL, T0, claimNow, club, ident, offer, prng, roundId } from './lib/core-fixtures.mjs';

function check(name, fn) {
  fn();
  console.log(`PASS ${name}`);
}

const TASK = `${POOL}#review:pr-578@octocat`;
const HASH = b64u(Buffer.alloc(32, 7));

// Three hosts, the first offering the task. `hosts[i].id.pk` is in no particular order.
function trio(now = T0) {
  const hosts = club(3, now);
  hosts.forEach((h) => h.pool.merge(offer(hosts[0].id), now));
  return hosts;
}
const lockBody = (pool, over = {}) => ({ taskId: TASK, round: roundId(1), asOf: T0, hash: pool.stateHash(over.asOf ?? T0), ...over });
const ask = (member_, from, over = {}, now = T0) => member_.locks.answer({
  pool: member_.pool, identity: member_.id, from: from.id.pk, body: lockBody(member_.pool, over), now,
});
const resign = (id, claim, over) => {
  const { sig: _, ...fields } = { ...claim, ...over };
  return signRecord(id, fields);
};
// The executors of two hosts, better-ranked first.
const ranked = (a, b) => (outranks(TASK, a.id.pk, b.id.pk) ? [a, b] : [b, a]);

check('rank is the hash the protocol writes down, and lower wins', () => {
  const [a, b] = [ident(1), ident(2)];
  const direct = crypto.createHash('sha256').update(Buffer.concat([Buffer.from(`dn1/rank\0${TASK}\0`), unb64u(a.pk)])).digest();
  assert.deepEqual(rank(TASK, a.pk), direct);
  assert.notDeepEqual(rank(`${POOL}#review:pr-579@octocat`, a.pk), direct);
  assert.equal(outranks(TASK, a.pk, b.pk), Buffer.compare(rank(TASK, a.pk), rank(TASK, b.pk)) < 0);
  assert.notEqual(outranks(TASK, a.pk, b.pk), outranks(TASK, b.pk, a.pk));
  assert.equal(outranks(TASK, a.pk, a.pk), false);
});

check('the wait before claiming grows with the rank and stays under its maximum', () => {
  const ids = Array.from({ length: 50 }, (_, i) => ident(i));
  const byRank = [...ids].sort((x, y) => Buffer.compare(rank(TASK, x.pk), rank(TASK, y.pk)));
  const delays = byRank.map((id) => rankDelay(TASK, id.pk, 5000));
  assert.deepEqual(delays, [...delays].sort((x, y) => x - y));
  assert.ok(delays.every((d) => Number.isInteger(d) && d >= 0 && d < 5000));
  assert.ok(delays.at(-1) - delays[0] > 2500);
  assert.equal(rankDelay(TASK, ids[0].pk, 0), 0);
});

check('a lock on an available task is granted: signed, bound to the round and the state, valid 120 seconds', () => {
  const [a, b] = trio();
  const { body } = ask(a, b);
  assert.deepEqual(Object.keys(body), ['grant']);
  const { sig, ...fields } = body.grant;
  assert.deepEqual(fields, { pool: POOL, taskId: TASK, executor: b.id.pk, round: roundId(1), gen: 0, hash: a.pool.stateHash(T0), by: a.id.pk, exp: T0 + 120 });
  assert.ok(verify(a.id.pk, 'dn1/grant', body.grant));
  assert.ok(verifyGrant(body.grant, { executor: b.id.pk, round: roundId(1), by: a.id.pk }));
  assert.equal(verifyGrant(body.grant, { executor: a.id.pk }), false);
  assert.equal(verifyGrant({ ...body.grant, gen: 1 }, {}), false);
  assert.equal(verifyGrant({ ...body.grant, extra: 1 }, {}), false);
  assert.equal(verifyGrant(null, {}), false);
  assert.deepEqual(a.locks.holder(TASK, T0), { executor: b.id.pk, round: roundId(1), exp: T0 + 120 });
  assert.deepEqual(new LockTable(a.locks.entries()).holder(TASK, T0), a.locks.holder(TASK, T0));
});

check('a lock whose state hash differs from the member\'s is stale, and binds nothing', () => {
  const [a, b] = trio();
  assert.deepEqual(ask(a, b, { hash: HASH }), { body: { stale: true } });
  a.pool.merge(offer(a.id, { item: 'pr-9' }), T0);
  assert.deepEqual(a.locks.answer({ pool: a.pool, identity: a.id, from: b.id.pk, body: lockBody(b.pool), now: T0 }), { body: { stale: true } });
  assert.equal(a.locks.holder(TASK, T0), null);
});

check('a lock for a task that is not available is challenged as unavailable', () => {
  const hosts = trio();
  const [a, b, c] = hosts;
  const none = { ...lockBody(a.pool), taskId: `${POOL}#review:pr-1@octocat` };
  assert.deepEqual(a.locks.answer({ pool: a.pool, identity: a.id, from: b.id.pk, body: none, now: T0 }), { body: { challenge: { reason: 'unavailable' } } });
  claimNow(hosts, 2, TASK, T0);
  assert.deepEqual(ask(a, b), { body: { challenge: { reason: 'unavailable' } } });
  const closed = trio();
  closed.forEach((h) => h.pool.merge(offer(closed[0].id, { seq: 1, at: T0, state: 'cancelled' }), T0));
  assert.deepEqual(ask(closed[1], closed[2]), { body: { challenge: { reason: 'unavailable' } } });
  assert.equal(c.locks.holder(TASK, T0), null);
});

check('a lock from a member that accepts fewer hours than the task needs is challenged', () => {
  const hosts = club(3, T0, (i) => ({ maxAcceptedH: i === 2 ? 24 : 12 }));
  hosts.forEach((h) => h.pool.merge(offer(hosts[0].id, { minRequiredH: 24 }), T0));
  const [a, b, c] = hosts;
  assert.deepEqual(ask(a, b), { body: { challenge: { reason: 'hours' } } });
  assert.ok(ask(a, c).body.grant);
});

check('a lock for a task another executor holds is challenged with that holder', () => {
  const [a, b, c] = trio();
  assert.ok(ask(a, b).body.grant);
  assert.deepEqual(ask(a, c, { round: roundId(2) }), { body: { challenge: { reason: 'locked', holder: b.id.pk } } });
  assert.deepEqual(a.locks.holder(TASK, T0).executor, b.id.pk, 'the first lock stands');
  assert.ok(ask(a, b).body.grant, 'the holder is granted again');
  assert.ok(ask(a, b, { round: roundId(3) }).body.grant, 'and again in a new round of its own');
  assert.equal(a.locks.holder(TASK, T0).round, roundId(3));
});

check('a host running its own round for a task challenges a rival with itself as the holder', () => {
  const [a, b] = trio();
  assert.equal(a.locks.hold(TASK, a.id.pk, roundId(5), T0 + 180, T0), true);
  assert.deepEqual(ask(a, b), { body: { challenge: { reason: 'locked', holder: a.id.pk } } });
  a.locks.release(TASK, a.id.pk, roundId(6));
  assert.ok(a.locks.holder(TASK, T0), 'another round does not release it');
  a.locks.release(TASK, a.id.pk, roundId(5));
  assert.ok(ask(a, b).body.grant);
  assert.equal(a.locks.hold(TASK, a.id.pk, roundId(7), T0 + 180, T0), false, 'nor does it start a round on a task it granted');
  assert.equal(a.locks.holder(TASK, T0).executor, b.id.pk);
});

check('a lock binds until its grant expires, its executor unlocks, or the claim is committed', () => {
  const [a, b, c] = trio();
  ask(a, b);
  const rival = (now) => a.locks.answer({
    pool: a.pool, identity: a.id, from: c.id.pk, body: lockBody(a.pool, { asOf: now, round: roundId(2) }), now,
  });
  assert.deepEqual(rival(T0 + 120).body, { challenge: { reason: 'locked', holder: b.id.pk } }, 'a claim may still be made at exp');
  assert.ok(rival(T0 + 121).body.grant, 'free past exp');

  const [m, x, y] = trio();
  ask(m, x);
  assert.deepEqual(m.locks.unlock({ from: y.id.pk, body: { taskId: TASK, round: roundId(1) } }), { body: {} });
  assert.ok(m.locks.holder(TASK, T0), 'only the holder unlocks');
  m.locks.unlock({ from: x.id.pk, body: { taskId: TASK, round: roundId(9) } });
  assert.ok(m.locks.holder(TASK, T0), 'and only for its round');
  m.locks.unlock({ from: x.id.pk, body: { taskId: TASK, round: roundId(1) } });
  assert.equal(m.locks.holder(TASK, T0), null);
  for (const bad of [null, {}, { taskId: TASK }, { taskId: 'x', round: roundId(1) }, { taskId: TASK, round: 'x' }, { taskId: TASK, round: roundId(1), more: 1 }]) {
    assert.deepEqual(m.locks.unlock({ from: x.id.pk, body: bad }), { error: 'bad-request' });
  }
  ask(m, x);
  m.locks.release(TASK, y.id.pk, roundId(1));
  m.locks.release(TASK, x.id.pk, roundId(9));
  assert.ok(m.locks.holder(TASK, T0), 'a claim of another executor or round settles nothing');
  m.locks.release(TASK, x.id.pk, roundId(1));
  assert.equal(m.locks.holder(TASK, T0), null);
});

check('a lock that is malformed, too far from the clock or from a stranger is an error', () => {
  const [a, b] = trio();
  const good = lockBody(a.pool);
  const answer = (body, from = b.id.pk, now = T0) => a.locks.answer({ pool: a.pool, identity: a.id, from, body, now });
  for (const bad of [null, [], {}, { ...good, more: 1 }, { ...good, taskId: 'x' }, { ...good, taskId: 'github.com/acme/other#review:pr-578@octocat' },
    { ...good, round: 'AAAA' }, { ...good, round: 5 }, { ...good, asOf: -1 }, { ...good, asOf: 1.5 }, { ...good, hash: 'x' },
    (({ hash: _, ...rest }) => rest)(good)]) {
    assert.deepEqual(answer(bad), { error: 'bad-request' }, JSON.stringify(bad));
  }
  assert.deepEqual(answer({ ...good, asOf: T0 + 301 }), { error: 'stale' });
  assert.deepEqual(answer({ ...good, asOf: T0 - 301 }), { error: 'stale' });
  assert.deepEqual(answer(good, ident(30).pk), { error: 'not-member' });
  assert.ok(answer({ ...good, asOf: T0 + 300, hash: a.pool.stateHash(T0 + 300) }).body.grant);
  assert.equal(answer({ ...good, asOf: T0 + 300, hash: a.pool.stateHash(T0 + 300) }).body.grant.exp, T0 + 420);
});

check('a round among three hosts commits a claim every one of them holds, granted by both others', () => {
  const hosts = trio();
  const claim = claimNow(hosts, 1, TASK, T0 + 4);
  assert.deepEqual(claim.grants.map((g) => g.by), [hosts[0].id.pk, hosts[2].id.pk].sort());
  assert.deepEqual([claim.executor, claim.seq, claim.gen, claim.state, claim.absent], [hosts[1].id.pk, 0, 0, 'held', []]);
  assert.deepEqual([claim.claimedAt, claim.at, claim.leaseUntil, claim.deadline, claim.hours], [T0 + 4, T0 + 4, T0 + 4 + 7200, T0 + 4 + 12 * 3600, 12]);
  assert.equal(verifyClaim(claim), null);
  for (const h of hosts) assert.equal(h.pool.get(`claim/${TASK}`), claim);
  assert.equal(new Set(hosts.map((h) => h.pool.stateHash(T0 + 4))).size, 1);
  assert.equal(claimNow(hosts, 2, TASK, T0 + 5, 1), 'unavailable');
});

// A round of host `a` with members `b` and `c`, both having confirmed its state.
function synced(over = {}) {
  const [a, b, c] = [ident(1), ident(2), ident(3)];
  const snapshot = { pool: POOL, asOf: T0, hash: HASH, gen: 0, hours: 12, members: [b.pk, c.pk], offering: [b.pk], available: true, eligible: true, ...over };
  const round = new ClaimRound({ taskId: TASK, self: a.pk, round: roundId(1), now: T0 });
  const started = round.rebase(snapshot, T0);
  const grant = (by, more = {}) => buildGrant(by, { pool: POOL, taskId: TASK, executor: a.pk, round: roundId(1), gen: 0, hash: HASH, exp: T0 + 120, ...more });
  return { a, b, c, round, snapshot, started, grant };
}

check('a round confirms its state with every member, then locks them, then commits their grants', () => {
  const { b, c, round, started, grant } = synced();
  const sync = (to) => ({ do: 'sync', to, wave: 1, body: { asOf: T0, hash: HASH } });
  const lock = (to) => ({ do: 'lock', to, wave: 1, body: { taskId: TASK, round: roundId(1), asOf: T0, hash: HASH } });
  assert.deepEqual(started, [sync(b.pk), sync(c.pk)]);
  assert.equal(round.phase, 'sync');
  assert.deepEqual(round.onSync(b.pk, 1, { hash: HASH }, T0), []);
  assert.deepEqual(round.onSync(c.pk, 1, { hash: HASH }, T0), [lock(b.pk), lock(c.pk)]);
  assert.equal(round.phase, 'lock');
  assert.deepEqual(round.onLock(c.pk, 1, { grant: grant(c) }, T0 + 1), []);
  const grants = [grant(b), grant(c)].sort((x, y) => (x.by < y.by ? -1 : 1));
  assert.deepEqual(round.onLock(b.pk, 1, { grant: grant(b) }, T0 + 1), [{ do: 'commit', gen: 0, hours: 12, grants, absent: [] }]);
  assert.deepEqual([round.phase, round.over, round.present], ['committed', true, [b.pk, c.pk].sort()]);
  assert.deepEqual(round.onLock(c.pk, 1, { grant: grant(c) }, T0 + 2), [], 'a finished round does nothing more');
  assert.deepEqual(round.tick(T0 + 999), []);
});

check('the only member of a pool commits at once, when it offers the task itself', () => {
  const alone = synced({ members: [], offering: [ident(1).pk] });
  assert.deepEqual(alone.started, [{ do: 'commit', gen: 0, hours: 12, grants: [], absent: [] }]);
  const stranger = synced({ members: [], offering: [ident(2).pk] });
  assert.deepEqual(stranger.started, [{ do: 'stand-down', reason: 'no-requester' }]);
});

check('a member that never answers is absent, and the claim says so', () => {
  const { b, c, round, grant } = synced();
  round.onSync(b.pk, 1, { hash: HASH }, T0);
  const locks = round.noAnswer(c.pk, 1, T0 + 60);
  assert.deepEqual(locks.map((x) => [x.do, x.to]), [['lock', b.pk]]);
  assert.deepEqual(round.absent, [c.pk]);
  assert.deepEqual(round.onLock(b.pk, 1, { grant: grant(b) }, T0 + 61), [{ do: 'commit', gen: 0, hours: 12, grants: [grant(b)], absent: [c.pk] }]);
});

check('a member that challenged is neither granted nor absent: the round does not commit without it', () => {
  const { a, b, c, round, grant } = synced();
  const worse = Array.from({ length: 40 }, (_, i) => ident(100 + i)).find((id) => outranks(TASK, a.pk, id.pk));
  round.onSync(b.pk, 1, { hash: HASH }, T0);
  round.onSync(c.pk, 1, { hash: HASH }, T0);
  assert.deepEqual(round.onLock(b.pk, 1, { grant: grant(b) }, T0 + 1), []);
  const again = { do: 'lock', to: c.pk, wave: 1, body: { taskId: TASK, round: roundId(1), asOf: T0, hash: HASH }, retry: true };
  assert.deepEqual(round.onLock(c.pk, 1, { challenge: { reason: 'locked', holder: worse.pk } }, T0 + 1), [again], 're-sends its lock to the member that challenged');
  assert.deepEqual(round.noAnswer(c.pk, 1, T0 + 30), [again], 'a present member is never written off as absent');
  assert.deepEqual(round.absent, []);
  assert.equal(round.phase, 'lock');
  assert.deepEqual(round.tick(T0 + 100), []);
  assert.deepEqual(round.tick(T0 + 180), [
    { do: 'unlock', to: b.pk, body: { taskId: TASK, round: roundId(1) } },
    { do: 'unlock', to: c.pk, body: { taskId: TASK, round: roundId(1) } },
    { do: 'stand-down', reason: 'timeout' },
  ]);
  assert.deepEqual([round.phase, round.reason], ['stood-down', 'timeout']);
});

check('a claimant outranked by the holder unlocks every member it locked and stands down', () => {
  const { a, b, c, round, grant } = synced();
  const better = Array.from({ length: 40 }, (_, i) => ident(100 + i)).find((id) => outranks(TASK, id.pk, a.pk));
  round.onSync(b.pk, 1, { hash: HASH }, T0);
  round.onSync(c.pk, 1, { hash: HASH }, T0);
  round.onLock(b.pk, 1, { grant: grant(b) }, T0 + 1);
  assert.deepEqual(round.onLock(c.pk, 1, { challenge: { reason: 'locked', holder: better.pk } }, T0 + 1), [
    { do: 'unlock', to: b.pk, body: { taskId: TASK, round: roundId(1) } },
    { do: 'unlock', to: c.pk, body: { taskId: TASK, round: roundId(1) } },
    { do: 'stand-down', reason: 'outranked' },
  ]);
  assert.equal(round.over, true);
});

check('two claimants locking at once: exactly the better-ranked one commits, the other stands down', () => {
  const hosts = trio();
  const [m, p, q] = hosts;
  const [best, worst] = ranked(p, q);
  // The member grants whichever asked first; each claimant challenges the other.
  for (const first of [best, worst]) {
    const second = first === best ? worst : best;
    const table = new LockTable();
    const rounds = new Map([first, second].map((h, i) => [h, new ClaimRound({ taskId: TASK, self: h.id.pk, round: roundId(i), now: T0 })]));
    const own = new Map([first, second].map((h) => [h, new LockTable()]));
    const outcomes = new Map();
    const queue = [];
    for (const h of [first, second]) {
      own.get(h).hold(TASK, h.id.pk, rounds.get(h).round, T0 + 180, T0);
      queue.push(...rounds.get(h).rebase(h.pool.claimSnapshot(TASK, T0), T0).map((action) => [h, action]));
    }
    let steps = 0;
    while (queue.length > 0) {
      assert.ok(++steps < 200, 'the two rounds never settle');
      const [h, action] = queue.shift();
      const round = rounds.get(h);
      const to = hosts.find((x) => x.id.pk === action.to);
      const locks = to === m ? table : own.get(to);
      let next = [];
      if (action.do === 'sync') next = round.onSync(action.to, action.wave, to.pool.answerSync(action.body, T0).body, T0);
      else if (action.do === 'lock') next = round.onLock(action.to, action.wave, locks.answer({ pool: to.pool, identity: to.id, from: h.id.pk, body: action.body, now: T0 }).body, T0);
      else if (action.do === 'unlock') locks.unlock({ from: h.id.pk, body: action.body });
      else {
        outcomes.set(h, action);
        own.get(h).release(TASK, h.id.pk, round.round);
      }
      queue.push(...next.map((x) => [h, x]));
    }
    assert.deepEqual(outcomes.get(worst), { do: 'stand-down', reason: 'outranked' });
    assert.equal(outcomes.get(best).do, 'commit');
    assert.deepEqual(outcomes.get(best).grants.map((g) => g.by), [m.id.pk, worst.id.pk].sort());
  }
});

check('a member whose state differs sends the round back to confirming, on a new wave', () => {
  const { b, c, round, snapshot, grant } = synced();
  assert.deepEqual(round.onSync(b.pk, 1, { hash: b64u(Buffer.alloc(32, 9)), index: {} }, T0), [{ do: 'resync', with: b.pk }]);
  const other = b64u(Buffer.alloc(32, 8));
  const again = round.rebase({ ...snapshot, asOf: T0 + 2, hash: other }, T0 + 2);
  assert.deepEqual(again.map((x) => [x.do, x.to, x.wave, x.body.hash]), [['sync', b.pk, 2, other], ['sync', c.pk, 2, other]]);
  assert.deepEqual(round.onSync(b.pk, 1, { hash: other }, T0 + 2), [], 'an answer to an earlier wave decides nothing');
  round.onSync(b.pk, 2, { hash: other }, T0 + 2);
  round.onSync(c.pk, 2, { hash: other }, T0 + 2);
  assert.deepEqual(round.onLock(b.pk, 2, { stale: true }, T0 + 3), [{ do: 'resync', with: b.pk }]);
  round.rebase({ ...snapshot, asOf: T0 + 4, hash: other }, T0 + 4);
  round.onSync(b.pk, 3, { hash: other }, T0 + 4);
  round.onSync(c.pk, 3, { hash: other }, T0 + 4);
  const fresh = { hash: other, exp: T0 + 124 };
  assert.deepEqual(round.onLock(b.pk, 3, { grant: grant(b, { hash: other }) }, T0 + 5).map((x) => x.do), ['lock'], 'a grant of an earlier wave is not this wave\'s');
  round.onLock(b.pk, 3, { grant: grant(b, fresh) }, T0 + 5);
  assert.equal(round.onLock(c.pk, 3, { grant: grant(c, fresh) }, T0 + 5)[0].do, 'commit');
});

check('a grant that is not this round\'s, this member\'s or properly signed is not a grant', () => {
  const { a, b, c, round, grant } = synced();
  round.onSync(b.pk, 1, { hash: HASH }, T0);
  round.onSync(c.pk, 1, { hash: HASH }, T0);
  round.onLock(c.pk, 1, { grant: grant(c) }, T0);
  const wrong = [
    grant(b, { round: roundId(2) }), grant(b, { taskId: `${POOL}#review:pr-579@octocat` }), grant(b, { executor: c.pk }),
    grant(b, { gen: 1 }), grant(b, { hash: b64u(Buffer.alloc(32, 1)) }), grant(b, { exp: T0 + 121 }), grant(b, { pool: 'github.com/acme/other' }),
    grant(c), grant(a), { ...grant(b), sig: grant(c).sig }, { ...grant(b), extra: 1 }, 'grant', null,
  ];
  for (const [i, bad] of wrong.entries()) {
    const out = round.onLock(b.pk, 1, { grant: bad }, T0);
    assert.deepEqual(out.map((x) => [x.do, x.retry]), [['lock', true]], `case ${i}`);
    assert.equal(round.phase, 'lock');
  }
  for (const junk of [null, 5, {}, { grant: grant(b), stale: true }, { stale: false }, { challenge: { reason: 'because' } }, { challenge: { reason: 'locked' } },
    { challenge: { reason: 'locked', holder: 'nope' } }, { challenge: { reason: 'locked', holder: a.pk } }, { challenge: { reason: 'locked', holder: b.pk, more: 1 } }]) {
    assert.deepEqual(round.onLock(b.pk, 1, junk, T0).map((x) => x.do), ['lock'], JSON.stringify(junk));
  }
  assert.deepEqual(round.onLock(ident(50).pk, 1, { grant: grant(b) }, T0), [], 'not a member of this round');
  assert.equal(round.onLock(b.pk, 1, { grant: grant(b) }, T0)[0].do, 'commit');
});

check('a challenge that the task is unavailable, or needs more hours than the claimant accepts, ends the round', () => {
  for (const reason of ['unavailable', 'hours']) {
    const { b, c, round } = synced();
    round.onSync(b.pk, 1, { hash: HASH }, T0);
    round.onSync(c.pk, 1, { hash: HASH }, T0);
    const out = round.onLock(b.pk, 1, { challenge: { reason } }, T0);
    assert.deepEqual(out.map((x) => x.do), ['unlock', 'unlock', 'stand-down']);
    assert.equal(out.at(-1).reason, reason);
  }
  assert.deepEqual(synced({ available: false }).started, [{ do: 'stand-down', reason: 'unavailable' }]);
  assert.deepEqual(synced({ eligible: false }).started, [{ do: 'stand-down', reason: 'hours' }]);
});

check('a round whose grants grew too old asks for a fresh state once, and still ends at its deadline', () => {
  const { b, c, round, snapshot, grant } = synced();
  round.onSync(b.pk, 1, { hash: HASH }, T0);
  round.onSync(c.pk, 1, { hash: HASH }, T0);
  round.onLock(b.pk, 1, { grant: grant(b) }, T0 + 1);
  assert.deepEqual(round.tick(T0 + 120), []);
  assert.deepEqual(round.tick(T0 + 121), [{ do: 'resync', with: null }]);
  assert.deepEqual(round.tick(T0 + 122), [], 'asked once per wave');
  assert.deepEqual(round.onLock(c.pk, 1, { grant: grant(c) }, T0 + 122), [], 'the grants can no longer be committed');
  assert.equal(round.phase, 'lock');
  assert.deepEqual(round.rebase({ ...snapshot, asOf: T0 + 123 }, T0 + 123).map((x) => x.do), ['sync', 'sync']);
  assert.deepEqual(round.rebase({ ...snapshot, asOf: T0 + 180 }, T0 + 180).map((x) => x.do), ['unlock', 'unlock', 'stand-down']);

  const late = synced();
  late.round.onSync(late.b.pk, 1, { hash: HASH }, T0);
  late.round.onSync(late.c.pk, 1, { hash: HASH }, T0);
  late.round.onLock(late.b.pk, 1, { grant: late.grant(late.b) }, T0 + 1);
  assert.deepEqual(late.round.onLock(late.c.pk, 1, { grant: late.grant(late.c) }, T0 + 121), [{ do: 'resync', with: null }], 'the last grant arrived too late');

  const over = synced();
  over.round.rebase({ ...over.snapshot, asOf: T0 + 100 }, T0 + 100);
  const fresh = { exp: T0 + 220 };
  over.round.onSync(over.b.pk, 2, { hash: HASH }, T0 + 100);
  over.round.onSync(over.c.pk, 2, { hash: HASH }, T0 + 100);
  over.round.onLock(over.b.pk, 2, { grant: over.grant(over.b, fresh) }, T0 + 179);
  assert.deepEqual(over.round.onLock(over.c.pk, 2, { grant: over.grant(over.c, fresh) }, T0 + 180).map((x) => x.do), ['unlock', 'unlock', 'stand-down'], 'no commit at the deadline, whatever was granted');
  assert.equal(over.round.reason, 'timeout');
});

check('a member written off as absent that answers after all is present again and must grant', () => {
  const { b, c, round, grant } = synced();
  round.onSync(b.pk, 1, { hash: HASH }, T0);
  round.noAnswer(c.pk, 1, T0 + 10);
  assert.deepEqual(round.absent, [c.pk]);
  assert.deepEqual(round.onSync(c.pk, 1, { hash: HASH }, T0 + 11).map((x) => [x.do, x.to]), [['lock', c.pk]]);
  assert.deepEqual([round.absent, round.present], [[], [b.pk, c.pk].sort()]);
  assert.deepEqual(round.onLock(b.pk, 1, { grant: grant(b) }, T0 + 12), [], 'not without the member that turned up');
  assert.equal(round.onLock(c.pk, 1, { grant: grant(c) }, T0 + 12)[0].do, 'commit');
});

check('a member that answered an earlier wave is present, though this wave\'s request to it goes unanswered', () => {
  const { b, c, round, snapshot, grant } = synced();
  round.onSync(b.pk, 1, { hash: b64u(Buffer.alloc(32, 9)), index: {} }, T0);
  round.rebase({ ...snapshot, asOf: T0 + 2 }, T0 + 2);
  round.onSync(b.pk, 2, { hash: HASH }, T0 + 2);
  assert.deepEqual(round.onSync(c.pk, 1, { hash: HASH }, T0 + 3), [], 'its answer to the first wave is no agreement with the second');
  assert.deepEqual(round.present, [b.pk, c.pk].sort());
  assert.deepEqual(round.noAnswer(c.pk, 2, T0 + 12).map((x) => [x.do, x.to, x.wave, x.retry]), [['sync', c.pk, 2, true]], 'asked again, not written off');
  assert.deepEqual(round.absent, []);
  assert.deepEqual(round.onLock(b.pk, 2, { grant: grant(b, { exp: T0 + 122 }) }, T0 + 13), [], 'no commit without it');

  const late = synced();
  late.round.onSync(late.b.pk, 1, { hash: b64u(Buffer.alloc(32, 9)), index: {} }, T0);
  late.round.rebase({ ...late.snapshot, asOf: T0 + 2 }, T0 + 2);
  late.round.onSync(late.b.pk, 2, { hash: HASH }, T0 + 2);
  late.round.noAnswer(late.c.pk, 2, T0 + 12);
  assert.deepEqual(late.round.absent, [late.c.pk]);
  assert.deepEqual(late.round.onSync(late.c.pk, 1, { hash: HASH }, T0 + 13).map((x) => [x.do, x.to, x.wave, x.retry]), [['sync', late.c.pk, 2, true]], 'written off, then heard: asked again');
  assert.deepEqual([late.round.absent, late.round.present], [[], [late.b.pk, late.c.pk].sort()]);
});

check('a round with no host that offers the task among its grants stands down', () => {
  const { b, c, round, grant } = synced();
  round.noAnswer(b.pk, 1, T0 + 10);
  round.onSync(c.pk, 1, { hash: HASH }, T0 + 10);
  assert.deepEqual(round.onLock(c.pk, 1, { grant: grant(c) }, T0 + 11), [
    { do: 'unlock', to: c.pk, body: { taskId: TASK, round: roundId(1) } },
    { do: 'stand-down', reason: 'no-requester' },
  ]);
});

check('a new wave takes in a new member, unlocks one that is gone, and keeps who was heard', () => {
  const { b, c, round, snapshot } = synced();
  const d = ident(4);
  round.onSync(b.pk, 1, { hash: HASH }, T0);
  round.onSync(c.pk, 1, { hash: HASH }, T0);
  const out = round.rebase({ ...snapshot, members: [b.pk, d.pk], asOf: T0 + 1 }, T0 + 1);
  assert.deepEqual(out.map((x) => [x.do, x.to]), [['unlock', c.pk], ['sync', b.pk], ['sync', d.pk]]);
  assert.deepEqual(round.present, [b.pk]);
  assert.deepEqual(round.noAnswer(b.pk, 2, T0 + 2).map((x) => [x.do, x.to, x.retry]), [['sync', b.pk, true]], 'heard before: asked again, not written off');
  assert.deepEqual(round.abort('no-slot').map((x) => x.do), ['unlock', 'stand-down']);
  assert.deepEqual(round.abort('no-slot'), []);
});

// Claims the three hosts would all verify, with one thing changed and signed again.
function committed() {
  const hosts = trio();
  const claim = claimNow(hosts, 1, TASK, T0 + 4);
  return { hosts, claim, executor: hosts[1].id, others: [hosts[0].id, hosts[2].id].sort((x, y) => (x.pk < y.pk ? -1 : 1)) };
}

check('a claim holds for every host only with each grant signed and bound to its task, executor, round and generation', () => {
  const { claim, executor, others } = committed();
  const regrant = (by, over) => buildGrant(by, { pool: POOL, taskId: TASK, executor: executor.pk, round: claim.round, gen: 0, hash: claim.grants[0].hash, exp: claim.grants[0].exp, ...over });
  const withGrants = (grants, over = {}) => resign(executor, claim, { grants, ...over });
  assert.equal(verifyClaim(withGrants([regrant(others[0], {}), regrant(others[1], {})])), null);
  const bad = {
    'a forged signature': [{ ...claim.grants[0], sig: claim.grants[1].sig }, claim.grants[1]],
    'another round': [regrant(others[0], { round: roundId(9) }), claim.grants[1]],
    'another task': [regrant(others[0], { taskId: `${POOL}#review:pr-579@octocat` }), claim.grants[1]],
    'another executor': [regrant(others[0], { executor: others[1].pk }), claim.grants[1]],
    'another generation': [regrant(others[0], { gen: 1 }), claim.grants[1]],
    'another pool': [regrant(others[0], { pool: 'github.com/acme/other' }), claim.grants[1]],
    'another state': [regrant(others[0], { hash: HASH }), claim.grants[1]],
    'another expiry': [regrant(others[0], { exp: claim.grants[0].exp + 1 }), claim.grants[1]],
  };
  for (const [what, grants] of Object.entries(bad)) assert.equal(verifyClaim(withGrants(grants)), 'bad-grant', what);
  const expired = [regrant(others[0], { exp: T0 + 3 }), regrant(others[1], { exp: T0 + 3 })];
  assert.equal(verifyClaim(withGrants(expired)), 'bad-grant', 'granted until before the claim was made');
  const early = [regrant(others[0], { exp: T0 + 125 }), regrant(others[1], { exp: T0 + 125 })];
  assert.equal(verifyClaim(withGrants(early)), 'bad-grant', 'granted for a state later than the claim');
  const edge = [regrant(others[0], { exp: T0 + 4 }), regrant(others[1], { exp: T0 + 4 })];
  assert.equal(verifyClaim(withGrants(edge)), null, 'claimed in the last second of its grants');
  const { hosts } = committed();
  const fresh = club(3);
  fresh.forEach((h) => h.pool.merge(offer(hosts[0].id), T0));
  assert.deepEqual(fresh[0].pool.merge(withGrants(bad['a forged signature']), T0 + 4).refused, [{ key: `claim/${TASK}`, code: 'bad-grant' }]);
  assert.deepEqual(fresh[0].pool.merge({ ...claim, absent: [ident(77).pk] }, T0 + 4).refused, [{ key: `claim/${TASK}`, code: 'bad-signature' }]);
  assert.deepEqual(fresh[0].pool.merge(claim, T0 + 4).refused, []);
});

check('a claim names each granting member once, in order, and never its executor or an absent one', () => {
  const { claim, executor, others } = committed();
  const self = buildGrant(executor, { pool: POOL, taskId: TASK, executor: executor.pk, round: claim.round, gen: 0, hash: claim.grants[0].hash, exp: claim.grants[0].exp });
  const cases = [
    { grants: [claim.grants[1], claim.grants[0]] },
    { grants: [claim.grants[0], claim.grants[0]] },
    { grants: [...claim.grants, self].sort((x, y) => (x.by < y.by ? -1 : 1)) },
    { absent: [others[0].pk] },
    { absent: [executor.pk] },
  ];
  for (const over of cases) assert.equal(verifyClaim(resign(executor, claim, over)), 'bad-claim', JSON.stringify(Object.keys(over)));
  assert.equal(verifyClaim(resign(executor, claim, { grants: [claim.grants[0]], absent: [others[1].pk] })), null);
  assert.equal(verifyClaim(resign(executor, claim, { grants: [], absent: others.map((o) => o.pk) })), null, 'a claim made alone holds: who was absent is the claimant\'s word');
  for (const over of [{ absent: [others[1].pk, others[0].pk] }, { absent: [others[0].pk, others[0].pk] }, { absent: ['nope'] }, { grants: [{}] }, { grants: 'x' }, { round: 'x' }, { gen: -1 }, { state: 'stolen' }]) {
    assert.throws(() => resign(executor, claim, over), TypeError, JSON.stringify(over));
  }
});

check('of two claims the later generation stands, then the better rank, then the lower round, the higher seq, the lower hash', () => {
  const [p, q] = ranked({ id: ident(1) }, { id: ident(2) });
  const prec = (over) => [over.gen ?? 0, (over.by ?? p).id.pk, over.round ?? roundId(1), over.seq ?? 0];
  const [h1, h2] = [b64u(Buffer.alloc(32, 1)), b64u(Buffer.alloc(32, 2))];
  const stands = (x, y, hx = h1, hy = h1) => compareClaims(TASK, prec(x), hx, prec(y), hy);
  assert.ok(stands({ gen: 1, by: q }, { gen: 0, by: p, seq: 9 }) < 0, 'generation before rank');
  assert.ok(stands({ gen: 0, by: p }, { gen: 1, by: q }) > 0);
  assert.ok(stands({ by: p }, { by: q, seq: 9 }) < 0, 'rank before seq');
  assert.ok(stands({ by: q, seq: 9 }, { by: p }) > 0);
  const [r1, r2] = [roundId(1), roundId(2)].sort();
  assert.ok(stands({ round: r1 }, { round: r2, seq: 9 }) < 0, 'round before seq');
  assert.ok(stands({ round: r2 }, { round: r1 }) > 0);
  assert.ok(stands({ seq: 3 }, { seq: 2 }) < 0);
  assert.ok(stands({ seq: 2 }, { seq: 3 }) > 0);
  assert.ok(stands({}, {}, h1, h2) < 0);
  assert.ok(stands({}, {}, h2, h1) > 0);
  assert.equal(stands({}, {}), 0);
});

check('any set of claims has one that stands, whatever order they meet in', () => {
  const rng = prng(11);
  const ids = Array.from({ length: 6 }, (_, i) => ident(i));
  const claims = Array.from({ length: 40 }, () => ({
    p: [rng.int(3), rng.pick(ids).pk, roundId(rng.int(3)), rng.int(4)], h: b64u(rng.bytes(32)),
  }));
  const cmp = (x, y) => compareClaims(TASK, x.p, x.h, y.p, y.h);
  for (const x of claims) {
    for (const y of claims) {
      assert.equal(Math.sign(cmp(x, y)) + Math.sign(cmp(y, x)), 0);
      for (const z of claims) if (cmp(x, y) < 0 && cmp(y, z) < 0) assert.ok(cmp(x, z) < 0, 'not transitive');
    }
  }
  const best = [...claims].sort(cmp)[0];
  for (let i = 0; i < 20; i++) assert.equal(rng.shuffle(claims).reduce((held, next) => (cmp(next, held) < 0 ? next : held)), best);
});

check('a pool keeps the claim that stands, whichever of two it sees first', () => {
  // Two sides of a partition each claim the task without the other's member.
  const hosts = trio();
  const [m, p, q] = hosts;
  const [best, worst] = ranked(p, q);
  const side = (h) => claimNow([{ ...m, pool: clone(m.pool), locks: new LockTable() }, h], 1, TASK, T0 + 4, h === best ? 1 : 2);
  const clone = (pool) => {
    const copy = new Pool({ id: POOL, self: pool.self });
    copy.merge(pool.records(), T0);
    return copy;
  };
  const [winning, losing] = [side(best), side(worst)];
  assert.deepEqual([winning.executor, losing.executor], [best.id.pk, worst.id.pk]);
  for (const order of [[winning, losing], [losing, winning]]) {
    const pool = clone(m.pool);
    for (const claim of order) pool.merge(claim, T0 + 5);
    assert.equal(pool.get(`claim/${TASK}`), winning, 'the better-ranked claim of one generation');
    assert.deepEqual(pool.merge(losing, T0 + 5).refused, [{ key: `claim/${TASK}`, code: 'older' }]);
  }
  assert.ok(compareClaims(TASK, claimPrecedence(winning), recordDigest(winning), claimPrecedence(losing), recordDigest(losing)) < 0);

  // The worse-ranked claim ends; a claim made on that state is the next generation and stands over both.
  const pool = clone(m.pool);
  const ended = endClaim(worst.id, losing, 'released', T0 + 10);
  pool.merge(ended, T0 + 10);
  assert.equal(pool.nextGen(TASK, T0 + 10), 1);
  const lockTable = new LockTable();
  const body = { taskId: TASK, round: roundId(5), asOf: T0 + 11, hash: pool.stateHash(T0 + 11) };
  const { grant } = lockTable.answer({ pool, identity: m.id, from: worst.id.pk, body, now: T0 + 11 }).body;
  assert.equal(grant.gen, 1);
  const next = buildClaim(worst.id, { pool: POOL, taskId: TASK, round: roundId(5), gen: 1, hours: 12, grants: [grant], absent: [best.id.pk], now: T0 + 12 });
  for (const order of [[winning, ended, next], [next, winning, ended], [ended, next, winning]]) {
    const fresh = clone(m.pool);
    for (const claim of order) fresh.merge(claim, T0 + 12);
    assert.equal(fresh.get(`claim/${TASK}`), next);
  }
});

check('the executor asks the lowest-keyed offering host that granted its claim for the key, itself included', () => {
  const { claim, executor, others } = committed();
  assert.equal(keyHost(claim, [others[1].pk, others[0].pk]), others[0].pk);
  assert.equal(keyHost(claim, [others[1].pk]), others[1].pk);
  assert.equal(keyHost(claim, [executor.pk]), executor.pk);
  assert.equal(keyHost(claim, [ident(60).pk]), null);
  assert.equal(keyHost(resign(executor, claim, { grants: [claim.grants[1]], absent: [others[0].pk] }), [others[0].pk]), null, 'an absent host granted nothing');
  assert.equal(keyHost(claim, []), null);
});
