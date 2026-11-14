// Leases as whole hosts keep them: a long run extended two hours at a time, a host that
// dies without a word, a run that outlives its deadline, and an offer that gives up
// after its third failed attempt.

import assert from 'node:assert/strict';
import { forgeRequest } from './lib/fakes.mjs';
import { POOL, check, createWorld } from './lib/hosts.mjs';
import { buildPing } from '../src/core/lease.js';
import { LEASE_GRACE_SECS, LEASE_SECS, OFFER_ATTEMPTS } from '../src/paths.js';

const offerArgs = (item) => ({ pool: POOL, kind: 'review', item, title: `Review ${item}`, prompt: 'p' });
const HOUR = 3600;

await check('a five-hour run is extended lease by lease, keeps its key, and finishes', async () => {
  const w = createWorld({ seed: 51 });
  const all = await w.pool(['req', 'exe', 'other'], { exe: { slots: 1 } });
  const [req, exe, other] = all;
  const { taskId } = await req.node.offer(offerArgs('pr-1'));
  await w.net.until(() => exe.executor.jobOf(taskId), { what: 'a job' });
  const job = exe.executor.jobOf(taskId);
  const { claimedAt } = w.claim(req, taskId);
  for (let hour = 1; hour <= 5; hour += 1) {
    await w.run(claimedAt + hour * HOUR - w.net.now());
    assert.equal((await w.wait(job.act(forgeRequest('GET', `/repos/o/r/pr-1/hour-${hour}`)))).status, 200, `the key works in hour ${hour}`);
    assert.equal(w.task(other, taskId).state, 'claimed');
  }
  await w.agreed(all);
  const claim = w.claim(other, taskId);
  assert.deepEqual([claim.seq, claim.leaseUntil - claimedAt, claim.ping.by], [2, 3 * LEASE_SECS, req.pk]);
  assert.equal(w.stored(req, 'keys').issued[taskId].capability.exp, claim.leaseUntil + LEASE_GRACE_SECS, 'the key expires with the lease it follows');
  assert.equal(w.task(req, taskId).leaseUntil, claim.leaseUntil);
  exe.executor.end(job.runId);
  await w.net.until(() => w.offerRow(req, taskId).state === 'done', { what: 'the offer done' });
  assert.equal(exe.executor.stopped.length, 0);
});

await check('a host that dies holding a claim loses it when the lease and its grace run out; the third such attempt fails the offer', async () => {
  const w = createWorld({ seed: 52 });
  const all = await w.pool(['req', 'e1', 'e2', 'e3'], { e1: { slots: 1 }, e2: { slots: 1 }, e3: { slots: 1 } });
  const [req, ...free] = all;
  const { taskId } = await req.node.offer(offerArgs('pr-1'));
  const dead = [];
  for (let attempt = 1; attempt <= OFFER_ATTEMPTS; attempt += 1) {
    const alive = free.filter((h) => !dead.includes(h));
    await w.net.until(() => alive.some((h) => h.executor.jobOf(taskId)), { what: `attempt ${attempt} running` });
    const runner = alive.find((h) => h.executor.jobOf(taskId));
    await w.run(30);
    const claim = w.claim(req, taskId);
    assert.deepEqual([claim.executor, claim.gen, w.offerRow(req, taskId).attempt], [runner.pk, attempt - 1, attempt]);
    assert.ok(w.stored(req, 'keys').issued[taskId], 'a key is out');
    w.net.kill(runner.name);
    dead.push(runner);
    const lapse = claim.leaseUntil + LEASE_GRACE_SECS;
    await w.run(lapse - 15 - w.net.now());
    assert.deepEqual([w.task(req, taskId).state, w.task(req, taskId).executor], ['claimed', runner.pk], 'held until the very end of the grace');
    assert.ok(w.net.count({ from: 'req', to: runner.name, kind: 'ping', since: claim.leaseUntil - 700 }) >= 2, 'it was pinged, more than once');
    await w.run(30);
    assert.notEqual(w.task(req, taskId).executor, runner.pk, 'and not a moment longer');
    assert.equal(w.stored(req, 'keys').issued[taskId]?.capability.executor === runner.pk, false, 'its key is gone from the store');
  }
  await w.net.until(() => w.offerRow(req, taskId).state === 'failed', { what: 'the offer failed' });
  assert.equal(w.offerRow(req, taskId).reason, 'the machine running it stopped answering');
  assert.equal(w.task(req, taskId).state, 'cancelled');
});

await check('a run still going at its deadline is stopped there, and counts as a failed attempt', async () => {
  const w = createWorld({ seed: 53 });
  const all = await w.pool(['req', 'exe'], { exe: { slots: 1 } });
  const [req, exe] = all;
  const { taskId } = await req.node.offer(offerArgs('pr-1'));
  await w.net.until(() => exe.executor.jobOf(taskId), { what: 'a job' });
  const job = exe.executor.jobOf(taskId);
  const { deadline, claimedAt } = w.claim(req, taskId);
  assert.equal(deadline - claimedAt, 12 * HOUR);
  await w.run(deadline - 20 - w.net.now());
  assert.equal(exe.executor.stopped.length, 0);
  assert.deepEqual([w.claim(req, taskId).seq, w.claim(req, taskId).leaseUntil], [5, deadline], 'extended up to the deadline and no further');
  await w.run(40);
  assert.deepEqual(exe.executor.stopped, [{ runId: job.runId, reason: 'not finished by its deadline' }]);
  await w.net.until(() => w.offerRow(req, taskId).attempt === 2, { what: 'the attempt counted' });
  await w.agreed(all);
  const row = w.offerRow(req, taskId);
  assert.deepEqual([row.state, row.reason, row.outcome.ok], ['pooled', 'not finished by its deadline', false]);
  assert.equal(w.claim(req, taskId).state, 'released');
  await w.run(900);
  assert.equal(exe.executor.started.length, 1, 'the host that failed at it does not take it again');
});

await check('a run that fails, a job that vanishes and a job that cannot start are three failed attempts', async () => {
  const w = createWorld({ seed: 54 });
  const all = await w.pool(['req', 'e1', 'e2', 'e3'], { e1: { slots: 1 } });
  const [req, e1, e2, e3] = all;
  const { taskId } = await req.node.offer(offerArgs('pr-1'));
  await w.net.until(() => e1.executor.jobOf(taskId), { what: 'the first job' });
  e1.executor.end(e1.executor.jobOf(taskId).runId, { ok: false, summary: 'the tests would not pass' });
  await w.net.until(() => w.offerRow(req, taskId).attempt === 2, { what: 'a second attempt' });
  assert.deepEqual([w.offerRow(req, taskId).state, w.offerRow(req, taskId).reason], ['pooled', 'the tests would not pass']);
  assert.equal(w.runOf(e1, taskId).state, 'failed');

  e2.slots = 1;
  e2.node.admit({ slots: 1 });
  await w.net.until(() => e2.executor.jobOf(taskId), { what: 'the second job' });
  e2.executor.die(e2.executor.jobOf(taskId).runId);
  await w.net.until(() => w.offerRow(req, taskId).attempt === 3, { what: 'a third attempt' });
  assert.equal(w.offerRow(req, taskId).reason, 'the run ended without saying how');

  e3.executor.failStart = true;
  e3.slots = 1;
  e3.node.admit({ slots: 1 });
  await w.net.until(() => w.offerRow(req, taskId).state === 'failed', { what: 'the offer failed' });
  assert.equal(w.offerRow(req, taskId).reason, 'the run could not be started: no docker');
  await w.agreed(all);
  for (const h of all) assert.equal(w.task(h, taskId).state, 'cancelled');
  assert.deepEqual([e1, e2, e3].map((h) => h.executor.started.length), [1, 1, 0]);
});

await check('a lease is extended for a run that is going, never for a claim whose job is gone', async () => {
  const w = createWorld({ seed: 55 });
  const [req, exe] = await w.pool(['req', 'exe'], { exe: { slots: 1 } });
  const { taskId } = await req.node.offer(offerArgs('pr-1'));
  await w.net.until(() => exe.executor.jobOf(taskId), { what: 'a job' });
  const claim = w.claim(req, taskId);
  // The requester's own pings do not get through; one made by hand arrives the moment the job dies.
  w.net.cut('req', 'exe');
  await w.run(claim.leaseUntil - 300 - w.net.now());
  w.net.heal();
  exe.executor.die(exe.executor.jobOf(taskId).runId);
  const answer = await w.request(req, exe, 'ping', { ping: buildPing(req.id, claim, w.net.now()) });
  assert.deepEqual([answer.ok, answer.code, answer.detail], [false, 'denied', 'no run']);
  await w.net.until(() => w.offerRow(req, taskId).attempt === 2, { what: 'the dead job reported' });
  assert.equal(w.claim(req, taskId).state, 'released');
});
