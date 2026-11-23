// Hours, leases and the heartbeat: when a claim is active, how a ping moves its lease on,
// what an extension must carry to hold for every host, and what a lapse does to the task.
// Run: node test/core-lease.mjs

import assert from 'node:assert/strict';
import { b64u } from '../src/core/canon.js';
import { verifyClaim } from '../src/core/claims.js';
import { sign, verify } from '../src/core/identity.js';
import {
  buildPing, eligible, endClaim, extendClaim, heldUntil, isActive, leaseAt, pingDue, pingWindow, speaksFor, verifyLease,
  verifyPing,
} from '../src/core/lease.js';
import { backing, signRecord } from '../src/core/records.js';
import { POOL, T0, claimNow, club, ident, offer, roundId } from './lib/core-fixtures.mjs';

function check(name, fn) {
  fn();
  console.log(`PASS ${name}`);
}

const TASK = `${POOL}#review:pr-578@octocat`;
const JOB = b64u(Buffer.alloc(32, 7));
const [LEASE, GRACE, LEAD, DAY] = [7200, 600, 600, 24 * 3600];

// Three hosts; the first offers the task and the second holds it since T0.
function held(hours = 12) {
  const hosts = club(3, T0, () => ({ maxAcceptedH: 48 }));
  hosts.forEach((h) => h.pool.merge(offer(hosts[0].id, { minRequiredH: hours }), T0));
  const claim = claimNow(hosts, 1, TASK, T0);
  return { hosts, claim, requester: hosts[0].id, executor: hosts[1].id, backed: backing(claim, hosts[0].id.pk) };
}
const keyOf = (claim) => `claim/${TASK}/${claim.executor}`;
const resign = (id, claim, over) => {
  const { sig: _, ...fields } = { ...claim, ...over };
  return signRecord(id, fields);
};
const repinged = (id, ping, over) => {
  const { sig: _, ...fields } = { ...ping, ...over };
  return { ...fields, sig: sign(id, 'dn1/ping', fields) };
};
// The claim extended `times` times, each ping sent as its window opens.
function extended(claim, requester, executor, times) {
  let current = claim;
  for (let i = 0; i < times; i++) {
    const at = current.leaseUntil - LEAD;
    current = extendClaim(executor, current, buildPing(requester, current, at), at + 1);
  }
  return current;
}

check('a member takes an offer only when it accepts its hours, and a claim holds each offer for that offer\'s hours and no longer', () => {
  assert.deepEqual([eligible(12, 12), eligible(48, 12), eligible(12, 13)], [true, true, false]);
  const hosts = club(3, T0, () => ({ maxAcceptedH: 48 }));
  const [short, executor, long] = hosts.map((h) => h.id);
  hosts.forEach((h) => h.pool.merge([offer(short, { minRequiredH: 12 }), offer(long, { minRequiredH: 36 })], T0));
  const claim = claimNow(hosts, 1, TASK, T0);
  assert.deepEqual([claim.hours, claim.deadline], [36, T0 + 36 * 3600], 'the claim lasts as long as the longest offer it holds');
  assert.deepEqual([backing(claim, short.pk).hours, backing(claim, long.pk).hours], [12, 36]);
  assert.equal(hosts[0].pool.claimSnapshot(TASK, T0).eligible, false);
  // Leases of two hours: the sixth ends where the shorter offer's hours do.
  const second = extended(claim, long, executor, 5);
  assert.deepEqual([heldUntil(claim, backing(claim, short.pk)), heldUntil(second, backing(second, short.pk))], [T0 + LEASE + GRACE, T0 + 12 * 3600 + GRACE]);
  assert.equal(pingWindow(second, backing(second, short.pk)), null, 'its host has nothing left to ask for');
  assert.deepEqual(verifyPing(buildPing(short, second, second.leaseUntil - 1), second), { ok: false, code: 'ended' });
  assert.equal(verifyClaim(extendClaim(executor, second, buildPing(short, second, second.leaseUntil - 1), second.leaseUntil - 1)), 'bad-ping');
  const third = extended(second, long, executor, 1);
  assert.equal(heldUntil(third, backing(third, short.pk)), T0 + 12 * 3600 + GRACE, 'whoever extends the claim');
  hosts[2].pool.merge([second, third], third.at);
  const at = (now) => hosts[2].pool.task(TASK, now).offers.map((o) => (o.claim ? 'held' : 'free'));
  // Offers come in the order of their hosts' keys.
  const order = (states) => (short.pk < long.pk ? states : [...states].reverse());
  assert.deepEqual(at(T0 + 12 * 3600 + GRACE - 1), ['held', 'held']);
  assert.deepEqual(at(T0 + 12 * 3600 + GRACE), order(['free', 'held']));
  assert.deepEqual(hosts[2].pool.task(TASK, T0 + 12 * 3600 + GRACE).free, [short.pk]);
});

check('a claim is leased two hours at a time from when it was made, never past its deadline', () => {
  assert.deepEqual(leaseAt(T0, 12, 0), { leaseUntil: T0 + LEASE, deadline: T0 + 12 * 3600 });
  assert.deepEqual(leaseAt(T0, 12, 4), { leaseUntil: T0 + 5 * LEASE, deadline: T0 + 12 * 3600 });
  assert.equal(leaseAt(T0, 12, 5).leaseUntil, T0 + 12 * 3600);
  assert.equal(leaseAt(T0, 12, 6).leaseUntil, T0 + 12 * 3600, 'nothing past the deadline');
  assert.equal(leaseAt(T0, 13, 6).leaseUntil, T0 + 13 * 3600, 'a last lease may be a short one');
  const { claim } = held();
  assert.deepEqual([claim.leaseUntil, claim.deadline], [T0 + LEASE, T0 + 12 * 3600]);
});

check('a claim is active while held and less than ten minutes past its lease', () => {
  const { claim, executor } = held();
  assert.deepEqual([T0, T0 + LEASE, T0 + LEASE + GRACE - 1, T0 + LEASE + GRACE].map((now) => isActive(claim, now)), [true, true, true, false]);
  const released = endClaim(executor, claim, 'released', T0 + 50);
  assert.equal(isActive(released, T0 + 51), false);
  assert.deepEqual([released.seq, released.state, released.at, released.leaseUntil, released.ping], [1, 'released', T0 + 50, claim.leaseUntil, undefined]);
  assert.equal(verifyClaim(released), null);
  // A completed claim names the job its run did, and only a completed one does.
  const completed = endClaim(executor, claim, 'completed', T0 + 50, JOB);
  assert.deepEqual([completed.spec, released.spec, verifyClaim(completed)], [JOB, undefined, null]);
  assert.equal(verifyClaim(resign(executor, released, { state: 'completed' })), 'bad-claim', 'completed, and no job named');
  assert.equal(verifyClaim(resign(executor, released, { spec: JOB })), 'bad-claim', 'a job named by a claim that was given back');
  assert.equal(verifyClaim(resign(executor, claim, { spec: JOB })), 'bad-claim', 'a job named by a claim still held');
});

check('a ping is due from ten minutes before the lease ends until the claim lapses', () => {
  const { claim, requester, executor, backed } = held();
  assert.deepEqual(pingWindow(claim, backed), { from: T0 + LEASE - LEAD, until: T0 + LEASE + GRACE });
  const at = (d) => pingDue(claim, backed, T0 + LEASE + d);
  assert.deepEqual([at(-LEAD - 1), at(-LEAD), at(0), at(GRACE - 1), at(GRACE)], [false, true, true, true, false]);
  assert.equal(pingWindow(endClaim(executor, claim, 'released', T0 + 5), backed), null);
  const last = extended(claim, requester, executor, 5);
  assert.equal(last.leaseUntil, last.deadline);
  assert.equal(pingWindow(last, backed), null, 'at the deadline there is nothing left to extend');
  assert.equal(pingDue(last, backed, last.leaseUntil - 1), false);
});

check('a ping names the claim, the lease it asks for and the host that asks, and is signed by it', () => {
  const { claim, requester } = held();
  const ping = buildPing(requester, claim, T0 + LEASE - 100);
  const { sig, ...fields } = ping;
  assert.deepEqual(fields, { pool: POOL, taskId: TASK, executor: claim.executor, round: claim.round, n: 1, by: requester.pk, ts: T0 + LEASE - 100 });
  assert.ok(verify(requester.pk, 'dn1/ping', ping));
});

check('an executor answers only the next ping for its own claim, in its window, from a host that backs the claim', () => {
  const { hosts, claim, requester, executor } = held();
  const due = T0 + LEASE - 100;
  const ping = buildPing(requester, claim, due);
  assert.deepEqual(verifyPing(ping, claim), { ok: true });
  const refused = (p, c = claim) => verifyPing(p, c).code;
  assert.equal(refused(buildPing(hosts[2].id, claim, due)), 'not-offering', 'a member that granted the lock and offers nothing');
  assert.equal(refused(buildPing(executor, claim, due)), 'not-offering', 'the executor cannot ping itself into a lease');
  assert.equal(refused(repinged(requester, ping, { round: roundId(9) })), 'bad-ping');
  assert.equal(refused(repinged(requester, ping, { taskId: `${POOL}#review:pr-579@octocat` })), 'bad-ping');
  assert.equal(refused(repinged(requester, ping, { executor: requester.pk })), 'bad-ping');
  assert.equal(refused(repinged(requester, ping, { pool: 'github.com/acme/other' })), 'bad-ping');
  assert.equal(refused(repinged(requester, ping, { n: 2 })), 'bad-ping', 'a lease is not skipped');
  assert.equal(refused({ ...ping, ts: due + 1 }), 'bad-ping', 'changed after it was signed');
  assert.equal(refused(repinged(ident(8), ping, {})), 'bad-ping', 'signed by another key than it names');
  assert.equal(refused(repinged(requester, ping, { n: 0 })), 'old');
  assert.equal(refused(repinged(requester, ping, { ts: T0 + LEASE - LEAD - 1 })), 'early');
  assert.equal(verifyPing(repinged(requester, ping, { ts: T0 + LEASE - LEAD }), claim).ok, true);
  assert.equal(refused(repinged(requester, ping, { ts: T0 + LEASE + GRACE })), 'late');
  assert.equal(verifyPing(repinged(requester, ping, { ts: T0 + LEASE + GRACE - 1 }), claim).ok, true);
  const next = extendClaim(executor, claim, ping, due + 1);
  assert.equal(refused(ping, next), 'old', 'that lease is already taken');
  assert.equal(refused(buildPing(requester, claim, due), endClaim(executor, claim, 'released', T0 + 9)), 'old');
  assert.equal(refused(repinged(requester, ping, { n: 2 }), endClaim(executor, claim, 'released', T0 + 9)), 'ended');
});

check('an extension is the claim at seq + 1, its lease two hours on, the ping embedded', () => {
  const { hosts, claim, requester, executor } = held();
  const due = T0 + LEASE - 100;
  const ping = buildPing(requester, claim, due);
  const next = extendClaim(executor, claim, ping, due + 3);
  assert.deepEqual([next.seq, next.leaseUntil, next.deadline, next.at, next.claimedAt, next.ping], [1, T0 + 2 * LEASE, claim.deadline, due + 3, T0, ping]);
  assert.deepEqual([next.grants, next.absent, next.round, next.gen], [claim.grants, claim.absent, claim.round, claim.gen]);
  assert.equal(verifyClaim(next), null);
  for (const h of hosts) {
    assert.deepEqual(h.pool.merge(next, due + 3).refused, []);
    assert.equal(h.pool.task(TASK, T0 + LEASE + GRACE).state, 'claimed', 'past the first lease, inside the second');
    assert.deepEqual(h.pool.merge(claim, due + 4).refused, [{ key: keyOf(claim), code: 'older' }]);
  }
});

check('a lease is extended up to the deadline and never past it', () => {
  const { hosts, claim, requester, executor } = held(13);
  let current = claim;
  const leases = [];
  for (let i = 0; i < 6; i++) {
    const at = current.leaseUntil - LEAD;
    const ping = buildPing(requester, current, at);
    assert.deepEqual(verifyPing(ping, current), { ok: true });
    current = extendClaim(executor, current, ping, at);
    assert.equal(verifyClaim(current), null);
    assert.deepEqual(hosts[2].pool.merge(current, at).refused, []);
    leases.push(current.leaseUntil - T0);
  }
  assert.deepEqual(leases, [2, 3, 4, 5, 6].map((n) => n * LEASE).concat(13 * 3600));
  assert.deepEqual(verifyPing(buildPing(requester, current, current.leaseUntil - 1), current), { ok: false, code: 'ended' });
  const past = resign(executor, current, { seq: 7, leaseUntil: current.leaseUntil + LEASE, ping: buildPing(requester, current, current.leaseUntil - 1) });
  assert.equal(verifyClaim(past), 'bad-lease', 'a lease past the deadline');
  const kept = resign(executor, current, { seq: 7, ping: buildPing(requester, current, current.leaseUntil - 1) });
  assert.equal(verifyClaim(kept), 'bad-ping', 'an extension with nothing left to extend');
  assert.equal(hosts[2].pool.task(TASK, current.deadline + GRACE - 1).state, 'claimed');
  assert.equal(hosts[2].pool.task(TASK, current.deadline + GRACE).state, 'available');
});

check('a claim whose times are not the ones its start, hours and seq dictate is refused', () => {
  const { hosts, claim, requester, executor } = held();
  const due = T0 + LEASE - 100;
  const ping = buildPing(requester, claim, due);
  const next = extendClaim(executor, claim, ping, due);
  const bad = {
    'a longer first lease': [resign(executor, claim, { leaseUntil: claim.leaseUntil + 1 }), 'bad-lease'],
    'a shorter first lease': [resign(executor, claim, { leaseUntil: claim.leaseUntil - 1 }), 'bad-lease'],
    'a later deadline': [resign(executor, claim, { deadline: claim.deadline + 3600 }), 'bad-lease'],
    // Its hours are the ones its backers give it: a pool refuses it for them first.
    'more hours than its deadline': [resign(executor, claim, { hours: 13 }), 'bad-lease', 'bad-claim'],
    'a lease two leases on': [resign(executor, next, { leaseUntil: next.leaseUntil + LEASE }), 'bad-lease'],
    'a first claim carrying a ping': [resign(executor, claim, { ping }), 'bad-ping'],
    'an extension without its ping': [resign(executor, claim, { seq: 1, leaseUntil: T0 + 2 * LEASE }), 'bad-ping'],
    'an extension two leases on from one ping': [resign(executor, next, { seq: 2, leaseUntil: T0 + 3 * LEASE }), 'bad-ping'],
    'a ping for another round': [resign(executor, next, { ping: repinged(requester, ping, { round: roundId(9) }) }), 'bad-ping'],
    'a ping sent before its window': [resign(executor, next, { ping: repinged(requester, ping, { ts: T0 + 60 }) }), 'bad-ping'],
    'a ping sent after the lapse': [resign(executor, next, { ping: repinged(requester, ping, { ts: T0 + LEASE + GRACE }) }), 'bad-ping'],
    'a ping whose signature is forged': [resign(executor, next, { ping: { ...ping, by: hosts[2].id.pk } }), 'bad-ping'],
    'an ended claim at seq 0': [resign(executor, claim, { state: 'released' }), 'bad-lease'],
    'an ended claim carrying a ping': [resign(executor, next, { state: 'completed', spec: JOB }), 'bad-lease'],
    'an ended claim leased past its deadline': [resign(executor, claim, { seq: 1, state: 'released', leaseUntil: claim.deadline + 1 }), 'bad-lease'],
  };
  for (const [what, [record, code, merged = code]] of Object.entries(bad)) {
    assert.equal(verifyLease(record), code, what);
    // A host that holds no claim for the task yet, so nothing but the record decides.
    const [blank] = club(3, T0, () => ({ maxAcceptedH: 48 }));
    blank.pool.merge(offer(hosts[0].id), T0);
    assert.deepEqual(blank.pool.merge(record, due).refused, [{ key: keyOf(claim), code: merged }], what);
  }
  assert.equal(verifyLease(next), null);
  assert.throws(() => resign(executor, claim, { at: claim.claimedAt - 1 }), TypeError);
  assert.throws(() => resign(executor, claim, { hours: 11 }), TypeError);
  assert.throws(() => resign(executor, claim, { ping: { ...ping, extra: 1 } }), TypeError);
});

check('an extension is asked for by a host that backs the claim, and by no other, whatever it offers', () => {
  const { hosts, claim, executor } = held();
  const outsider = hosts[2].id;
  const due = T0 + LEASE - 100;
  const selfMade = extendClaim(executor, claim, buildPing(executor, claim, due), due);
  const friendly = extendClaim(executor, claim, buildPing(outsider, claim, due), due);
  for (const record of [selfMade, friendly]) {
    assert.equal(verifyClaim(record), 'bad-ping');
    const both = [record, offer(outsider, { at: due, createdAt: due })];
    assert.deepEqual(hosts[0].pool.merge(both, due).refused, [{ key: keyOf(claim), code: 'bad-ping' }]);
  }
  assert.equal(hosts[0].pool.get(keyOf(claim)), claim);
  assert.deepEqual(hosts[0].pool.task(TASK, T0 + LEASE + GRACE).free, [hosts[0].id.pk, outsider.pk].sort(), 'so the claim lapses');
});

check('a lapsed claim makes its task available again for every host at the same instant', () => {
  const { hosts, claim } = held();
  const lapse = T0 + LEASE + GRACE;
  for (const h of hosts) {
    assert.deepEqual([h.pool.task(TASK, lapse - 1).state, h.pool.task(TASK, lapse - 1).claim], ['claimed', claim]);
    assert.deepEqual([h.pool.task(TASK, lapse).state, h.pool.task(TASK, lapse).claim], ['available', null]);
    assert.deepEqual([h.pool.claimSnapshot(TASK, lapse - 1).available, h.pool.claimSnapshot(TASK, lapse).available], [false, true]);
  }
  assert.equal(new Set(hosts.map((h) => h.pool.stateHash(lapse))).size, 1);
  const next = claimNow(hosts, 2, TASK, lapse, 1);
  assert.deepEqual([next.executor, next.gen, next.claimedAt], [hosts[2].id.pk, 0, lapse]);
  assert.deepEqual([backing(claim, hosts[0].id.pk).gen, backing(next, hosts[0].id.pk).gen], [1, 2], 'the offer was given a second time');
  for (const h of hosts) {
    assert.deepEqual([h.pool.get(keyOf(claim)), h.pool.task(TASK, lapse).claim], [claim, next], 'both records are held, and the later one holds the offer');
  }
});

check('a claim its executor released or completed frees the task at once', () => {
  for (const state of ['released', 'completed']) {
    const { hosts, claim, executor } = held();
    const ended = endClaim(executor, claim, state, T0 + 30, JOB);
    for (const h of hosts) {
      assert.deepEqual(h.pool.merge(ended, T0 + 30).refused, []);
      assert.deepEqual([h.pool.task(TASK, T0 + 30).state, h.pool.task(TASK, T0 + 30).claim], ['available', null]);
    }
    assert.equal(backing(claimNow(hosts, 2, TASK, T0 + 31, 1), hosts[0].id.pk).gen, 2);
    // Ended by a clock set back behind the claim's start, it is dated by that start.
    const early = endClaim(executor, claim, state, T0 - 100, JOB);
    assert.deepEqual([early.at, early.state, early.seq], [claim.claimedAt, state, 1]);
  }
});

check('every version of a claim is dropped a day after it was signed, for every host at the same instant', () => {
  const { hosts, claim, requester, executor } = held();
  const key = keyOf(claim);
  assert.ok(Object.hasOwn(hosts[0].pool.index(T0 + DAY - 1), key));
  assert.equal(Object.hasOwn(hosts[0].pool.index(T0 + DAY), key), false);
  assert.equal(hosts[1].pool.claimSnapshot(TASK, T0 + DAY - 1).gen, 1, 'the executor\'s next claim of the task is its second');
  assert.equal(hosts[1].pool.claimSnapshot(TASK, T0 + DAY).gen, 0);
  const ended = endClaim(executor, claim, 'completed', T0 + 100, JOB);
  // The offer the claim stands on is signed again, so the claim's own age decides.
  for (const h of hosts) h.pool.merge(offer(requester, { seq: 1, at: T0 + 400 }), T0 + 100);
  hosts[1].pool.merge(ended, T0 + 100);
  assert.ok(Object.hasOwn(hosts[1].pool.index(T0 + 100 + DAY - 1), key));
  assert.equal(Object.hasOwn(hosts[1].pool.index(T0 + 100 + DAY), key), false);
  assert.deepEqual(hosts[2].pool.merge(ended, T0 + 100 + 2 * DAY).refused, [{ key, code: 'expired' }]);
  // The version it ended is older still: once the end is forgotten, so is what it ended.
  for (const now of [T0 + 100 + DAY + 300, T0 + 100 + DAY + 301, T0 + 3 * DAY]) {
    assert.deepEqual(hosts[2].pool.merge(claim, now).refused, [{ key, code: 'expired' }]);
  }
  // An extension is dated by its ping, so a claim held for days is never dropped while it holds.
  const { hosts: [a], claim: first } = held(48);
  let current = first;
  for (let i = 0; i < 20; i++) {
    const at = current.leaseUntil - LEAD;
    for (const id of [hosts[0].id, hosts[1].id, hosts[2].id]) a.pool.merge(resign(id, a.pool.get(`member/${id.pk}`), { seq: i + 1, at }), at);
    a.pool.merge(offer(requester, { minRequiredH: 48, seq: i + 1, at }), at);
    current = extendClaim(executor, current, buildPing(requester, current, at), at);
    assert.deepEqual(a.pool.merge(current, at).refused, []);
    assert.equal(a.pool.task(TASK, current.leaseUntil - LEAD - 1).state, 'claimed', `through lease ${i + 2}`);
  }
  assert.ok(current.leaseUntil > T0 + DAY + 12 * 3600);
});

check('a held version is dated by what it answers: the claim by its start, an extension by its ping', () => {
  const { hosts, claim, requester, executor } = held();
  const due = T0 + LEASE - 100;
  const ping = buildPing(requester, claim, due);
  const next = extendClaim(executor, claim, ping, due);
  assert.equal(verifyLease(resign(executor, claim, { at: claim.claimedAt + 1 })), 'bad-lease', 'a first version dated after its start');
  for (const [d, verdict] of [[-301, 'bad-lease'], [-300, null], [0, null], [300, null], [301, 'bad-lease']]) {
    const dated = resign(executor, next, { at: due + d });
    assert.equal(verifyLease(dated), verdict, `an extension dated ${d} s from its ping`);
    if (verdict) assert.deepEqual(hosts[2].pool.merge(dated, due + 400).refused, [{ key: keyOf(claim), code: verdict }]);
  }
});

check('only the executor of the claim a host holds speaks for its round, while it is active or after ending it', () => {
  const { claim, requester, executor } = held();
  const lapse = T0 + LEASE + GRACE;
  const by = (from, round, now, record = claim) => speaksFor(record, { from, round, now });
  assert.equal(by(executor.pk, claim.round, T0 + 5), true);
  assert.equal(by(executor.pk, claim.round, lapse - 1), true);
  assert.equal(by(executor.pk, claim.round, lapse), false, 'a lapsed claim speaks for nothing');
  assert.equal(by(requester.pk, claim.round, T0 + 5), false, 'another member');
  assert.equal(by(executor.pk, roundId(9), T0 + 5), false, 'another round');
  assert.equal(by(executor.pk, claim.round, T0 + 5, null), false, 'no claim held');
  for (const state of ['completed', 'released']) {
    const ended = endClaim(executor, claim, state, T0 + 50, JOB);
    assert.equal(by(executor.pk, claim.round, lapse + 5000, ended), true, `after it ${state} the claim itself`);
    assert.equal(by(requester.pk, claim.round, T0 + 60, ended), false);
  }
});
