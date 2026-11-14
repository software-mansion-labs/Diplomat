// A task's whole life between two hosts, and every way it can end: offered, claimed,
// acted on under the requester's key, finished - or withdrawn, or cut short when its pool
// is closed, or finished through another host that offers it too.

import assert from 'node:assert/strict';
import { forgeRequest } from './lib/fakes.mjs';
import { POOL, check, createWorld } from './lib/hosts.mjs';
import { MAX_ACT_BODY_BYTES, MAX_BODY_BYTES, STRANGER_BODY_BYTES } from '../src/paths.js';

const body = (answer) => JSON.parse(Buffer.from(answer.body, 'base64').toString('utf8'));
const offerArgs = (item, more = {}) => ({ pool: POOL, kind: 'review', item, title: `Review ${item}`, prompt: `look at ${item}`, base: 'abc123', ...more });
const actHeaders = (from, bytes) => ({ 'dn-from': from.pk, 'dn-pool': POOL, 'dn-kind': 'act', 'content-length': String(bytes) });

// A claimed task with its job started: `{ taskId, job }`.
async function going(w, requester, executor, item, more) {
  const { taskId } = await requester.node.offer(offerArgs(item, more));
  await w.net.until(() => executor.executor.jobOf(taskId), { what: `a job for ${taskId}` });
  return { taskId, job: executor.executor.jobOf(taskId) };
}

await check('a task is offered, claimed, acted on under the requester\'s key, and finished for every host', async () => {
  const w = createWorld({ seed: 11 });
  const [req, exe, other] = await w.pool(['req', 'exe', 'other'], { exe: { slots: 1 } });
  const { taskId, job } = await going(w, req, exe, 'pr-7', { options: { depth: 2 }, author: { name: 'Octo Cat', email: 'octo@example.com' } });

  assert.equal(taskId, `${POOL}#review:pr-7@octocat`);
  assert.deepEqual(job.spec, {
    taskId, kind: 'review', item: 'pr-7', title: 'Review pr-7', identity: 'octocat', prompt: 'look at pr-7',
    options: { depth: 2 }, base: 'abc123', name: 'Octo Cat', email: 'octo@example.com',
  });
  assert.deepEqual([job.peer, job.pool.id, job.task.taskId, job.task.hours], [req.pk, POOL, taskId, 12]);
  await w.agreed([req, exe, other]);
  for (const h of [req, exe, other]) {
    const task = w.task(h, taskId);
    assert.deepEqual([task.state, task.executor, task.executorHere, task.offeredHere], ['claimed', exe.pk, h === exe, h === req]);
  }
  assert.deepEqual([w.offerRow(req, taskId).state, w.offerRow(req, taskId).executor], ['claimed', exe.pk]);
  assert.deepEqual([w.runOf(exe, taskId).state, w.runOf(exe, taskId).container], ['running', `box-${job.runId}`]);
  assert.equal(req.transport.host.limit(actHeaders(exe, 5 * 2 ** 20)), MAX_ACT_BODY_BYTES, 'the key holder may send a pack');
  assert.equal(req.transport.host.limit(actHeaders(exe, 5 * 2 ** 20)), STRANGER_BODY_BYTES, 'one at a time');
  assert.equal(req.transport.host.limit(actHeaders(other, 5 * 2 ** 20)), STRANGER_BODY_BYTES, 'nobody else may');
  assert.equal(req.transport.host.limit(actHeaders(other, 2 ** 19)), MAX_BODY_BYTES);

  // Three requests: two carried out, one no rule covers.
  req.requester.refuse('/secrets', 'this task may not read secrets');
  const first = await w.wait(job.act(forgeRequest('GET', '/repos/o/r/pr-7/files')));
  const refused = await w.wait(job.act(forgeRequest('GET', '/repos/o/r/pr-7/secrets')));
  const second = await w.wait(job.act(forgeRequest('POST', '/repos/o/r/pr-7/reviews', { event: 'COMMENT' })));
  assert.deepEqual([first.status, first.headers, body(first)], [200, { 'content-type': 'application/json' }, { did: '/repos/o/r/pr-7/files' }]);
  assert.deepEqual([refused.status, body(refused)], [403, { message: 'this task may not read secrets' }]);
  assert.equal(second.status, 200);
  assert.deepEqual(req.requester.calls.map((c) => [c.op, c.path.split('/').at(-1)]), [
    ['authorize', 'files'], ['perform', 'files'], ['authorize', 'secrets'], ['authorize', 'reviews'], ['perform', 'reviews'],
  ], 'every request is authorised before it is performed, and a refused one never is');
  assert.deepEqual(req.requester.calls.filter((c) => c.op === 'authorize').map((c) => c.asked), [1, 2, 3], 'the key\'s state is carried from one request to the next');
  assert.deepEqual(req.requester.calls.find((c) => c.op === 'perform'), { op: 'perform', path: '/repos/o/r/pr-7/files', forge: 'github', host: 'github.com' });
  assert.deepEqual([w.offerRow(req, taskId).requests, w.offerRow(req, taskId).refused], [3, 1]);

  // The job ends well: the offer is done everywhere and the key is dead.
  exe.executor.end(job.runId);
  await w.net.until(() => w.offerRow(req, taskId).state === 'done', { what: 'the offer done' });
  await w.agreed([req, exe, other]);
  for (const h of [req, exe, other]) assert.equal(w.task(h, taskId).state, 'done');
  const row = w.offerRow(req, taskId);
  assert.deepEqual(row.outcome, { ok: true, summary: 'all done', usd: 0.25, tokens: 1200, runner: 'claude', model: 'fable' });
  assert.deepEqual([row.pool, row.kind, row.item, row.title, row.attempt, row.endedAt > 0], [POOL, 'review', 'pr-7', 'Review pr-7', 1, true]);
  assert.deepEqual([w.runOf(exe, taskId).state, w.runOf(exe, taskId).exit], ['finished', 0]);
  assert.equal(w.stored(req, 'keys').issued[taskId], undefined, 'no key is kept for a finished task');
  await w.run(600);
  assert.equal(req.transport.host.limit(actHeaders(exe, 5 * 2 ** 20)), STRANGER_BODY_BYTES, 'without a key, no pack');
  const late = await w.wait(job.act(forgeRequest('GET', '/repos/o/r/pr-7/files')));
  assert.equal(late.status, 403);
  assert.equal(req.requester.calls.length, 5, 'a request after the end reaches nothing');
  assert.equal(exe.executor.stopped.length, 0);
});

await check('an offer withdrawn while its task runs stops the run and frees the executor', async () => {
  const w = createWorld({ seed: 12 });
  const [req, exe] = await w.pool(['req', 'exe'], { exe: { slots: 1 } });
  const { taskId, job } = await going(w, req, exe, 'pr-1');
  await w.wait(req.node.withdraw({ taskId, reason: 'x'.repeat(300) }));
  await w.net.until(() => exe.executor.stopped.length === 1, { what: 'the run stopped' });
  assert.deepEqual(exe.executor.stopped, [{ runId: job.runId, reason: 'the task was withdrawn' }]);
  await w.agreed([req, exe]);
  for (const h of [req, exe]) assert.deepEqual([w.task(h, taskId).state, w.task(h, taskId).executor], ['cancelled', '']);
  const row = w.offerRow(req, taskId);
  assert.deepEqual([row.state, row.reason, row.executor], ['cancelled', 'x'.repeat(200), '']);
  assert.equal(w.runOf(exe, taskId).state, 'stopped');
  assert.equal((await w.wait(job.act(forgeRequest('GET', '/repos/o/r/pr-1/files')))).status, 403);
  assert.equal(req.requester.calls.length, 0);
  await assert.rejects(req.node.withdraw({ taskId }), /no open offer/);
  // The slot is free again: the next task is taken.
  const next = await going(w, req, exe, 'pr-2');
  assert.notEqual(next.job.runId, job.runId);
});

await check('offering refuses what cannot be offered, and offering an open task again is the same offer', async () => {
  const w = createWorld({ seed: 13 });
  const [req, exe] = await w.pool(['req', 'exe']);
  await assert.rejects(req.node.offer(offerArgs('pr-1', { kind: 'deploy' })), /No rules exist for a "deploy" task/);
  await assert.rejects(req.node.offer(offerArgs('pr-1', { pool: 'github.com/acme/other' })), /not linked on this machine/);
  await assert.rejects(req.node.offer(offerArgs('PR 1')), /not a task this network can name/);
  await assert.rejects(req.node.offer(offerArgs('pr-1', { options: { ratio: 0.5 } })), /cannot be sent to another machine/);
  assert.deepEqual(req.node.snapshot().offers, []);
  const first = await req.node.offer(offerArgs('pr-1'));
  const again = await req.node.offer(offerArgs('pr-1', { title: 'something else' }));
  assert.deepEqual(again, first);
  await w.agreed([req, exe]);
  assert.equal(req.node.snapshot().offers.length, 1);
  assert.deepEqual([w.task(exe, first.taskId).title, w.task(exe, first.taskId).state], ['Review pr-1', 'available']);
  assert.equal(w.stored(exe, 'offers'), null, 'the private half stays on the host that offered');
  assert.ok(![...exe.disk.files.values()].some((text) => text.includes('look at pr-1')), 'and so does the prompt');
});

await check('a host that closes a pool cancels its offers there, stops its runs and tells the members it left', async () => {
  const w = createWorld({ seed: 14 });
  const [a, b, c] = await w.pool(['a', 'b', 'c'], { b: { slots: 1 } });
  const mine = await going(w, a, b, 'pr-1'); // a offers, b runs
  const theirs = await c.node.offer(offerArgs('pr-2')); // c offers, nobody is free
  await w.agreed([a, b, c]);
  // b, running a's task, closes the pool: the run stops and the claim is given back.
  b.pools = [];
  b.node.setPools([]);
  await w.net.settled();
  assert.deepEqual(b.executor.stopped, [{ runId: mine.job.runId, reason: 'the pool was closed' }]);
  await w.net.until(() => w.members(a).length === 2 && w.members(c).length === 2, { what: 'b gone from the pool' });
  await w.agreed([a, c]);
  assert.deepEqual([w.task(a, mine.taskId).state, w.task(c, mine.taskId).state], ['available', 'available']);
  assert.deepEqual(b.node.snapshot().pools, []);
  const since = w.net.now() + 1;
  await w.run(600);
  assert.equal(w.net.count({ to: 'b', since }), 0, 'nobody asks a host that left');
  assert.equal(w.net.count({ from: 'b', since }), 0, 'and it asks nobody');
  // a closes it too: its offer is cancelled, and gone for the one host that remains.
  a.pools = [];
  a.node.setPools([]);
  await w.net.until(() => w.task(c, mine.taskId) === null, { what: 'the task gone' });
  assert.deepEqual([w.offerRow(a, mine.taskId).state, w.offerRow(a, mine.taskId).reason], ['cancelled', 'the pool was closed']);
  assert.equal(w.task(c, theirs.taskId).state, 'available');
  assert.equal(w.members(c).length, 1);
});

await check('two hosts offer one task: the run reports to both, and the task is done on both', async () => {
  const w = createWorld({ seed: 15 });
  const [r1, r2, exe] = await w.pool(['r1', 'r2', 'exe'], { exe: { slots: 1 } });
  const { taskId } = await r1.node.offer(offerArgs('pr-9'));
  assert.equal((await r2.node.offer(offerArgs('pr-9'))).taskId, taskId);
  await w.net.until(() => exe.executor.jobOf(taskId), { what: 'a job' });
  const job = exe.executor.jobOf(taskId);
  // The second offering host is cut off when the run ends: it learns of it afterwards.
  const [near, far] = job.peer === r1.pk ? [r1, r2] : [r2, r1];
  w.net.split(['exe', near.name], [far.name]);
  exe.executor.end(job.runId);
  await w.net.until(() => w.offerRow(near, taskId).state === 'done', { what: 'the nearer offer done' });
  assert.equal(w.offerRow(far, taskId).state, 'claimed', 'the other knows nothing yet');
  w.net.heal();
  await w.net.until(() => w.offerRow(far, taskId).state === 'done', { what: 'the farther offer done' });
  await w.agreed([r1, r2, exe]);
  for (const h of [r1, r2, exe]) assert.deepEqual([w.task(h, taskId).state, w.task(h, taskId).offeredBy], ['done', []]);
  assert.equal(w.offerRow(far, taskId).reason, 'finished through another machine offering it');
  assert.equal(exe.executor.started.length, 1, 'nobody ran it a second time');

  // Cancelled by one of two offering hosts, it is cancelled by the other.
  const second = await r1.node.offer(offerArgs('pr-10'));
  await r2.node.offer(offerArgs('pr-10'));
  await w.agreed([r1, r2, exe]);
  exe.slots = 0;
  await w.wait(r1.node.withdraw({ taskId: second.taskId, reason: 'closed' }));
  await w.net.until(() => w.offerRow(r2, second.taskId).state === 'cancelled', { what: 'the sibling offer cancelled' });
  await w.agreed([r1, r2, exe]);
  assert.equal(w.task(exe, second.taskId).state, 'cancelled');
});
