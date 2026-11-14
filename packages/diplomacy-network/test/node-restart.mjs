// A host killed and started again, at each moment where what it had promised matters:
// holding a lock it granted, in the middle of its own claim round, with a run going, and
// as the requester of a task whose key is out. Its disk is all it has left.

import assert from 'node:assert/strict';
import { forgeRequest } from './lib/fakes.mjs';
import { POOL, check, createWorld } from './lib/hosts.mjs';
import { unb64u } from '../src/core/canon.js';
import { actMac } from '../src/core/capability.js';
import { GRANT_TTL_SECS, LEASE_GRACE_SECS, LEASE_SECS } from '../src/paths.js';

const offerArgs = (item) => ({ pool: POOL, kind: 'review', item, title: `Review ${item}`, prompt: 'p' });
const get = (item, leaf) => forgeRequest('GET', `/repos/o/r/${item}/${leaf}`);

await check('a host that granted a lock still holds it after a restart: nobody else is granted the task', async () => {
  const w = createWorld({ seed: 71 });
  const all = await w.pool(['req', 'a', 'b']);
  const [req, a, b] = all;
  const { taskId } = await req.node.offer(offerArgs('pr-1'));
  await w.agreed(all);
  const asOf = w.net.now();
  const lock = (from, round) => w.request(from, req, 'lock', { taskId, round, asOf, hash: w.view(from).hash });
  const granted = await lock(a, 'AAAAAAAAAAA');
  assert.equal(granted.body.grant.executor, a.pk);
  await w.restart(req);
  assert.equal(req.node.snapshot().offers[0].taskId, taskId, 'its offers are its own again');
  assert.deepEqual((await lock(b, 'BBBBBBBBBBA')).body, { challenge: { reason: 'locked', holder: a.pk } });
  assert.deepEqual((await lock(a, 'AAAAAAAAAAA')).body, granted.body, 'asked again, the holder gets the very same grant');
  await w.run(GRANT_TTL_SECS + 2 - (w.net.now() - asOf));
  const later = w.net.now();
  const free = await w.request(b, req, 'lock', { taskId, round: 'BBBBBBBBBBA', asOf: later, hash: w.view(b).hash });
  assert.equal(free.body.grant.executor, b.pk, 'once the grant has run out the task can be granted again');
});

await check('a claimant killed in the middle of its round leaves one executor at most', async () => {
  const w = createWorld({ seed: 72 });
  const all = await w.pool(['req', 'x', 'y'], { x: { slots: 1 } });
  const [req, x, y] = all;
  const { taskId } = await req.node.offer(offerArgs('pr-1'));
  await w.net.until(() => w.net.count({ from: 'x', kind: 'lock' }) >= 1, { stepMs: 1, what: 'x asking for locks' });
  assert.equal(w.claim(req, taskId), undefined, 'nothing is committed yet');
  await w.restart(x);
  y.slots = 1;
  y.node.admit({ slots: 1 });
  await w.net.until(() => [x, y].some((h) => h.executor.jobOf(taskId)), { maxMs: 15 * 60 * 1000, what: 'somebody running the task' });
  await w.run(600);
  await w.agreed(all);
  assert.equal(x.executor.started.length + y.executor.started.length, 1, 'one job, on one host');
  const runner = x.executor.jobOf(taskId) ? x : y;
  for (const h of all) assert.equal(w.task(h, taskId).executor, runner.pk);
});

await check('a host restarted with a run going takes the run up again, and never uses a request number twice', async () => {
  const w = createWorld({ seed: 73 });
  const all = await w.pool(['req', 'exe'], { exe: { slots: 2 } });
  const [req, exe] = all;
  const kept = await req.node.offer(offerArgs('pr-1'));
  const lost = await req.node.offer(offerArgs('pr-2'));
  await w.net.until(() => exe.executor.started.length === 2, { what: 'two jobs' });
  const job = exe.executor.jobOf(kept.taskId);
  for (const leaf of ['a', 'b']) assert.equal((await w.wait(job.act(get('pr-1', leaf)))).status, 200);
  assert.equal(w.stored(req, 'keys').issued[kept.taskId].seq, 1);
  // The host dies; one of its two jobs dies with it.
  exe.executor.die(exe.executor.jobOf(lost.taskId).runId);
  assert.deepEqual(Object.values(w.stored(exe, 'runs').runs).map((r) => r.state), ['running', 'running'], 'what its disk holds as it dies');
  await w.restart(exe);
  assert.deepEqual([w.runOf(exe, kept.taskId).state, w.runOf(exe, lost.taskId).state], ['running', 'failed'], 'the executor was asked which of them live');
  const act = exe.node.actFor(job.runId);
  assert.equal((await w.wait(act(get('pr-1', 'c')))).status, 200, 'the job that lived goes on under the same key');
  assert.equal(w.stored(req, 'keys').issued[kept.taskId].seq, 2, 'with the next number, not one used before');
  await w.net.until(() => w.offerRow(req, lost.taskId).attempt === 2, { what: 'the dead job reported' });
  assert.deepEqual([w.runOf(exe, lost.taskId).state, w.offerRow(req, lost.taskId).reason], ['failed', 'the run ended without saying how']);
  await w.agreed(all);
  assert.deepEqual([w.task(req, lost.taskId).state, w.task(req, kept.taskId).state], ['available', 'claimed']);
  assert.equal(exe.executor.started.length, 2, 'nothing was started a second time');
  exe.executor.end(job.runId);
  await w.net.until(() => w.offerRow(req, kept.taskId).state === 'done', { what: 'the surviving run done' });
});

await check('a requester restarted while its key is out serves the same key, with its counters, and keeps the lease alive', async () => {
  const w = createWorld({ seed: 74 });
  const all = await w.pool(['req', 'exe'], { exe: { slots: 1 } });
  const [req, exe] = all;
  const { taskId } = await req.node.offer(offerArgs('pr-1'));
  await w.net.until(() => exe.executor.jobOf(taskId), { what: 'a job' });
  const job = exe.executor.jobOf(taskId);
  req.requester.refuse('/secrets', 'no');
  for (const leaf of ['a', 'secrets']) await w.wait(job.act(get('pr-1', leaf)));
  const before = w.stored(req, 'keys').issued[taskId];
  await w.restart(req);
  assert.deepEqual(w.stored(req, 'keys').issued[taskId], before);
  assert.equal((await w.wait(job.act(get('pr-1', 'c')))).status, 200, 'the key works across the restart');
  assert.deepEqual(req.requester.calls.filter((c) => c.op === 'authorize').map((c) => c.asked), [1, 2, 3], 'what the rules remembered is remembered');
  const row = w.offerRow(req, taskId);
  assert.deepEqual([row.state, row.requests, row.refused, row.executor], ['claimed', 3, 1, exe.pk]);
  const { capability: { keyId }, secret } = w.stored(exe, 'keys').held[taskId];
  const replay = { taskId, keyId, seq: 1, request: get('pr-1', 'a'), mac: actMac(unb64u(secret), { keyId, seq: 1, request: get('pr-1', 'a') }) };
  assert.equal((await w.request(exe, req, 'act', replay)).detail, 'seq is not new', 'a number used before the restart is still used');
  const again = await w.request(exe, req, 'key', { taskId, round: w.claim(req, taskId).round });
  assert.deepEqual([again.body.capability, again.body.secret], [before.capability, before.secret]);
  const { claimedAt } = w.claim(req, taskId);
  await w.run(claimedAt + LEASE_SECS + LEASE_GRACE_SECS + 60 - w.net.now());
  assert.deepEqual([w.task(exe, taskId).state, w.claim(exe, taskId).seq], ['claimed', 1], 'the restarted requester pinged in time');
  assert.equal((await w.wait(job.act(get('pr-1', 'd')))).status, 200);
});

await check('a host that lost the record of its runs gives back the claims it cannot account for', async () => {
  const w = createWorld({ seed: 75 });
  const all = await w.pool(['req', 'exe'], { exe: { slots: 1 } });
  const [req, exe] = all;
  const { taskId } = await req.node.offer(offerArgs('pr-1'));
  await w.net.until(() => exe.executor.jobOf(taskId), { what: 'a job' });
  await w.agreed(all);
  w.net.kill('exe');
  exe.disk.write('runs', '{"runs":{"run-');
  exe.slots = 0;
  await w.restart(exe);
  assert.match(exe.log.join('\n'), /store: runs\.json does not parse/);
  await w.net.until(() => w.claim(req, taskId).state === 'released', { maxMs: 5000, what: 'the claim given back' });
  assert.deepEqual([w.offerRow(req, taskId).state, w.offerRow(req, taskId).attempt], ['pooled', 1], 'a claim given back is no failed attempt');
  assert.deepEqual([w.stored(exe, 'keys').held, w.stored(req, 'keys').issued], [{}, {}], 'and its key is gone on both sides');
  assert.deepEqual(exe.node.snapshot().runs, []);
});
