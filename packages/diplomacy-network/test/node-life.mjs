// A task's whole life between two hosts, and every way it can end: offered, claimed,
// acted on under the requester's key, finished - or withdrawn, or cut short when its pool
// is closed, or finished through another host that offers it too.

import assert from 'node:assert/strict';
import { forgeRequest } from './lib/fakes.mjs';
import { POOL, check, createWorld } from './lib/hosts.mjs';
import { GIVE_UP_WAIT_MS, MAX_ACT_BODY_BYTES, MAX_BODY_BYTES, STRANGER_BODY_BYTES } from '../src/paths.js';

const body = (answer) => JSON.parse(Buffer.from(answer.body, 'base64').toString('utf8'));
const offerArgs = (item, more = {}) => ({ pool: POOL, kind: 'review', item, title: `Review ${item}`, prompt: `look at ${item}`, base: 'abc123', ...more });

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
  const reserve = async (from, bytes) => (await w.request(from, req, 'reserve', { kind: 'act', bytes })).code ?? 'ok';
  assert.equal(await reserve(exe, MAX_ACT_BODY_BYTES), 'ok', 'the key holder may send a pack');
  assert.equal(await reserve(exe, MAX_ACT_BODY_BYTES + 1), 'bad-request');
  assert.equal(await reserve(other, MAX_BODY_BYTES + 1), 'bad-request', 'nobody else may');
  assert.equal(await reserve(other, MAX_BODY_BYTES), 'ok');
  assert.equal(await reserve(other, STRANGER_BODY_BYTES), 'bad-request', 'what anyone may send needs no place');

  // Three requests: two carried out, one no rule covers.
  req.requester.refuse('/secrets', 'this task may not read secrets');
  const first = await w.wait(job.act(forgeRequest('GET', '/repos/o/r/pr-7/files')));
  const refused = await w.wait(job.act(forgeRequest('GET', '/repos/o/r/pr-7/secrets')));
  const second = await w.wait(job.act(forgeRequest('POST', '/repos/o/r/pr-7/reviews', { event: 'COMMENT' })));
  const beyond = await w.wait(job.act(forgeRequest('GET', '/repos/o/r/pr-8/files')));
  assert.deepEqual([beyond.status, body(beyond)], [403, { message: 'no rule covers this request' }], 'the rules of the key are the ones asked');
  assert.deepEqual([first.status, first.headers, body(first)], [200, { 'content-type': 'application/json' }, { did: '/repos/o/r/pr-7/files' }]);
  assert.deepEqual([refused.status, body(refused)], [403, { message: 'this task may not read secrets' }]);
  assert.equal(second.status, 200);
  assert.deepEqual(req.requester.calls.map((c) => [c.op, c.path.split('/').at(-1)]), [
    ['authorize', 'files'], ['perform', 'files'], ['authorize', 'secrets'], ['authorize', 'reviews'], ['perform', 'reviews'],
    ['authorize', 'files'],
  ], 'every request is authorised before it is performed, and a refused one never is');
  assert.deepEqual(req.requester.unsent, [], 'of a request that was answered or refused the requester is told nothing more');
  assert.deepEqual(req.requester.calls.filter((c) => c.op === 'authorize').map((c) => c.asked), [1, 2, 3, 4], 'the key\'s state is carried from one request to the next');
  assert.deepEqual(req.requester.calls.find((c) => c.op === 'perform'), {
    op: 'perform', path: '/repos/o/r/pr-7/files', forge: 'github', host: 'github.com', as: 'octocat',
  }, 'what is performed is the request as the rules made it');
  assert.deepEqual([w.offerRow(req, taskId).requests, w.offerRow(req, taskId).refused], [4, 2]);

  // The job ends well: the offer is done everywhere and the key is dead.
  exe.executor.end(job.runId);
  await w.net.until(() => w.offerRow(req, taskId).state === 'done', { what: 'the offer done' });
  await w.agreed([req, exe, other]);
  for (const h of [req, exe, other]) assert.equal(w.task(h, taskId).state, 'done');
  const row = w.offerRow(req, taskId);
  assert.deepEqual(row.outcome, { ok: true, summary: 'all done', usd: 0.25, tokens: 1200, runner: 'claude', model: 'fable' });
  assert.deepEqual([row.pool, row.kind, row.item, row.title, row.attempt, row.endedAt > 0], [POOL, 'review', 'pr-7', 'Review pr-7', 1, true]);
  assert.deepEqual([row.executor, row.executorHere], [exe.pk, false], 'an ended offer keeps the executor that ended it');
  assert.deepEqual([w.runOf(exe, taskId).state, w.runOf(exe, taskId).exit], ['finished', 0]);
  assert.equal(w.stored(req, 'keys').issued[taskId], undefined, 'no key is kept for a finished task');
  await w.run(600);
  assert.equal(await reserve(exe, 5 * 2 ** 20), 'bad-request', 'without a key, no pack');
  const late = await w.wait(job.act(forgeRequest('GET', '/repos/o/r/pr-7/files')));
  assert.equal(late.status, 403);
  assert.equal(req.requester.calls.length, 6, 'a request after the end reaches nothing');
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
  assert.deepEqual([row.state, row.reason, row.executor, row.executorHere], ['cancelled', 'x'.repeat(200), exe.pk, false], 'the row keeps who held it last');
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
  const farewell = w.records(c).find((r) => r.type === 'offer' && r.taskId === mine.taskId && r.host === a.pk);
  assert.equal(farewell.state, 'cancelled', 'the members hold its signed word for it');
  assert.deepEqual([w.offerRow(a, mine.taskId).state, w.offerRow(a, mine.taskId).reason], ['cancelled', 'the pool was closed']);
  assert.equal(w.task(c, theirs.taskId).state, 'available');
  assert.equal(w.members(c).length, 1);
});

await check('two hosts offer one task: one run takes both offers and reports to both, and each host ends its own offer on that report alone', async () => {
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
  assert.deepEqual([w.task(exe, taskId).state, w.task(exe, taskId).offeredBy, w.claim(exe, taskId).state], ['claimed', [far.pk], 'held'], 'the claim is kept for the host still to be told');
  w.net.heal();
  await w.net.until(() => w.offerRow(far, taskId).state === 'done', { what: 'the farther offer done' });
  await w.agreed([r1, r2, exe]);
  for (const h of [r1, r2, exe]) assert.deepEqual([w.task(h, taskId).state, w.task(h, taskId).offeredBy], ['done', []]);
  assert.deepEqual([w.offerRow(far, taskId).reason, w.offerRow(far, taskId).outcome], ['', w.offerRow(near, taskId).outcome], 'told by the run itself, the same as the other');
  assert.deepEqual([exe.executor.started.length, w.claim(r1, taskId).state], [1, 'completed'], 'nobody ran it a second time');

  // Cancelled by one of two offering hosts, it is still the other's to offer.
  exe.slots = 0;
  exe.node.admit({ slots: 0 });
  const second = await r1.node.offer(offerArgs('pr-10'));
  await r2.node.offer(offerArgs('pr-10'));
  await w.agreed([r1, r2, exe]);
  await w.wait(r1.node.withdraw({ taskId: second.taskId, reason: 'closed' }));
  await w.agreed([r1, r2, exe]);
  await w.run(120);
  assert.deepEqual([w.offerRow(r1, second.taskId).state, w.offerRow(r2, second.taskId).state], ['cancelled', 'pooled']);
  assert.deepEqual([w.task(exe, second.taskId).state, w.task(exe, second.taskId).offeredBy], ['available', [r2.pk]]);
});

await check('a title is cut to what a record carries, and never through the middle of a character', async () => {
  const w = createWorld({ seed: 16 });
  const [req, exe] = await w.pool(['req', 'exe'], { exe: { slots: 1 } });
  const { taskId } = await req.node.offer(offerArgs('pr-1', { title: `${'x'.repeat(299)}\u{1F600} and more` }));
  assert.equal(w.offerRow(req, taskId).title, `${'x'.repeat(299)}\uFFFD`);
  await w.net.until(() => exe.executor.jobOf(taskId), { what: 'the task taken like any other' });
});

await check('a task that ended and is offered again is a task again, whoever else had offered it', async () => {
  const w = createWorld({ seed: 17 });
  const [r1, r2, exe] = await w.pool(['r1', 'r2', 'exe'], { exe: { slots: 1 } });
  const { taskId } = await r1.node.offer(offerArgs('pr-1'));
  await r2.node.offer(offerArgs('pr-1'));
  await w.net.until(() => exe.executor.jobOf(taskId), { what: 'a job' });
  exe.executor.end(exe.executor.jobOf(taskId).runId);
  await w.net.until(() => [r1, r2].every((h) => w.offerRow(h, taskId).state === 'done'), { stepMs: 5, what: 'both offers done' });
  // Offered again in the second it ended: the end both hosts signed must not end this offer too.
  assert.equal((await r1.node.offer(offerArgs('pr-1', { prompt: 'once more' }))).taskId, taskId);
  await w.net.until(() => exe.executor.jobOf(taskId), { what: 'a second job' });
  const job = exe.executor.jobOf(taskId);
  assert.equal(job.spec.prompt, 'once more');
  assert.deepEqual([w.offerRow(r1, taskId).state, w.offerRow(r2, taskId).state], ['claimed', 'done'], 'the offer that was not made again stays ended');
  exe.executor.end(job.runId);
  await w.net.until(() => w.offerRow(r1, taskId).state === 'done', { what: 'the second offer done' });
  assert.deepEqual([w.offerRow(r1, taskId).outcome.ok, exe.executor.started.length], [true, 2]);
  await w.agreed([r1, r2, exe]);
  assert.equal(w.task(exe, taskId).state, 'done');
});

await check('an executor whose clock runs behind the requester\'s still gets its key and finishes the task', async () => {
  const w = createWorld({ seed: 18 });
  const all = [w.add('req'), w.add('exe', { slots: 1 })];
  const [req, exe] = all;
  exe.skew = -45;
  for (const h of all) await w.start(h);
  await w.wait(exe.node.join(req.node.invite({ pool: POOL })));
  await w.net.until(() => w.members(req).length === 2, { what: 'two members' });
  const { taskId, job } = await going(w, req, exe, 'pr-1');
  assert.ok(w.claim(req, taskId).claimedAt < w.offerRow(req, taskId).offeredAt, 'by the clocks the claim is older than the offer');
  assert.equal((await w.wait(job.act(forgeRequest('GET', '/repos/o/r/pr-1/files')))).status, 200);
  exe.executor.end(job.runId);
  await w.net.until(() => w.offerRow(req, taskId).state === 'done', { what: 'the offer done' });
  await w.run(300);
  assert.equal(exe.executor.started.length, 1, 'and it is not run again');
});

await check('a run stopped by the operator is stopped, its claim given back, and the task left to another machine', async () => {
  const w = createWorld({ seed: 19 });
  const [req, exe, other] = await w.pool(['req', 'exe', 'other'], { exe: { slots: 1 } });
  const { taskId, job } = await going(w, req, exe, 'pr-1');
  await exe.node.stopRun({ runId: job.runId });
  assert.deepEqual(exe.executor.stopped, [{ runId: job.runId, reason: 'stopped by the operator' }]);
  assert.equal(w.runOf(exe, taskId).state, 'stopped');
  await w.net.until(() => w.task(req, taskId).state === 'available', { what: 'the task in the pool again' });
  // The machine whose operator stopped it has a free slot, and leaves the task alone.
  await w.run(3 * 3600);
  assert.deepEqual([w.task(req, taskId).state, exe.executor.started.length], ['available', 1]);
  other.slots = 1;
  await w.net.until(() => other.executor.jobOf(taskId), { maxMs: 3 * 60 * 1000, what: 'a job on another machine' });
  assert.equal(w.offerRow(req, taskId).attempt, 1, 'a claim given back is no failed attempt');
  await assert.rejects(exe.node.stopRun({ runId: job.runId }), /No such run is going on this machine\./);
});

await check('a run the host stops for a reason of its own tells its job and its record that reason, and its claim is given back the same', async () => {
  const w = createWorld({ seed: 23 });
  const [req, exe] = await w.pool(['req', 'exe'], { exe: { slots: 1 } });
  const { taskId, job } = await going(w, req, exe, 'pr-1');
  await exe.node.stopRun({ runId: job.runId, reason: 'the broker could not listen where this job reaches it' });
  assert.deepEqual(exe.executor.stopped, [{ runId: job.runId, reason: 'the broker could not listen where this job reaches it' }]);
  assert.deepEqual([w.stored(exe, 'runs').runs[job.runId].state, w.stored(exe, 'runs').runs[job.runId].outcome.summary], ['stopped', 'the broker could not listen where this job reaches it']);
  await w.net.until(() => w.task(req, taskId).state === 'available', { what: 'the task in the pool again' });
  assert.equal(w.offerRow(req, taskId).attempt, 1);
  // What the host gave back by itself it goes for again after its wait, nobody else having taken it.
  const gaveBack = w.net.now();
  await w.net.until(() => exe.executor.jobOf(taskId), { what: 'a job again' });
  assert.deepEqual([Math.round((w.net.now() - gaveBack) / 60), w.offerRow(req, taskId).attempt], [GIVE_UP_WAIT_MS / 60000, 1]);
});

await check('a host that is switched off cancels its offers, stops its runs and gives their claims back, tells the pool, and stops - a member still', async () => {
  const w = createWorld({ seed: 20 });
  const [a, b, c] = await w.pool(['a', 'b', 'c'], { a: { slots: 1 } });
  const theirs = await going(w, b, a, 'pr-1'); // b offers, a runs
  const mine = await a.node.offer(offerArgs('pr-2')); // a offers, nobody else is free
  await w.agreed([a, b, c]);
  // Its job takes three seconds to stop.
  const { stop } = a.executor;
  a.executor.stop = (...args) => new Promise((resolve) => { a.clock.setTimeout(() => resolve(stop.apply(a.executor, args)), 3000); });
  const began = w.net.now();
  await w.wait(a.node.switchOff());
  const took = w.net.now() - began;
  assert.ok(took >= 3 && took <= 4, `it waits for its jobs to stop and the members to answer, and no longer: ${took} s`);
  a.executor.stop = stop;
  assert.deepEqual(a.executor.stopped, [{ runId: theirs.job.runId, reason: 'the network was switched off' }]);
  // The others heard all of it before it stopped, and it is a member still.
  for (const h of [b, c]) {
    assert.deepEqual([w.claim(h, theirs.taskId).state, w.task(h, theirs.taskId).state, w.task(h, mine.taskId).state], ['released', 'available', 'cancelled'], h.name);
    assert.equal(w.members(h).length, 3);
  }
  assert.deepEqual([w.offerRow(a, mine.taskId).state, w.offerRow(a, mine.taskId).reason], ['cancelled', 'the network was switched off']);
  assert.equal(w.runOf(a, theirs.taskId).state, 'stopped');
  assert.equal(w.offerRow(b, theirs.taskId).attempt, 1, 'a claim given back is no failed attempt');
  a.slots = 0;
  await w.run(3600);
  assert.equal(w.net.timers('a'), 0, 'nothing of it is left going');
  // Switched on again it is what it was, and takes the task it gave back like any other.
  a.slots = 1;
  await w.restart(a, { named: false });
  await w.net.until(() => a.executor.started.length === 2, { maxMs: 5 * 60 * 1000, what: 'the task taken again' });
  assert.equal(a.executor.started[1].task.taskId, theirs.taskId);
  // At once, too: what it gave back at switch-off is not a task it gave up on.
  await w.wait(a.node.switchOff());
  await w.restart(a, { named: false });
  await w.net.until(() => a.executor.started.length === 3, { maxMs: 100 * 1000, what: 'the task taken a third time' });

  // Cut off, and with a job that will not stop, it stops all the same when its wait is
  // over; the others hear what it ended once it is back.
  const late = await a.node.offer(offerArgs('pr-3'));
  await w.agreed([a, b, c]);
  w.net.split(['a'], ['b', 'c']);
  a.executor.stop = () => new Promise(() => {});
  const from = w.net.now();
  await w.wait(a.node.switchOff({ waitMs: 5000 }));
  assert.ok(w.net.now() - from >= 5 && w.net.now() - from <= 6, `stopped after ${w.net.now() - from} s`);
  a.slots = 0;
  await w.run(3600);
  assert.equal(w.net.timers('a'), 0);
  assert.equal(w.task(b, late.taskId).state, 'available', 'nobody heard');
  a.executor.stop = stop;
  w.net.heal();
  await w.restart(a, { named: false });
  await w.net.until(() => [b, c].every((h) => w.task(h, late.taskId).state === 'cancelled'), { what: 'the cancelled offer known to the others' });
  await w.wait(a.node.switchOff());
  await a.node.switchOff();
});

await check('what a run says of itself is told and shown without a control character in it, whoever wrote it', async () => {
  const w = createWorld({ seed: 17 });
  const [req, exe] = await w.pool(['req', 'exe'], { exe: { slots: 1 } });
  const dirty = 'done\u001b[2J\r\nfa\u0007ke \u009b31mline\u007f';
  const clean = 'done [2J  fa ke  31mline ';

  // The executor's own node cleans what its agent printed before it keeps or tells it.
  const one = await going(w, req, exe, 'pr-1');
  exe.executor.end(one.job.runId, { summary: dirty, runner: 'cl\u0000aude', model: 'fa\nble' });
  await w.net.until(() => w.offerRow(req, one.taskId).state === 'done', { what: 'the offer done' });
  const kept = w.stored(exe, 'runs').runs[one.job.runId].outcome;
  assert.deepEqual([kept.summary, kept.runner, kept.model], [clean, 'cl aude', 'fa ble']);
  const shown = w.offerRow(req, one.taskId).outcome;
  assert.deepEqual([shown.summary, shown.runner, shown.model], [clean, 'cl aude', 'fa ble']);

  // An executor that cleans nothing: the requester shows none of it either.
  const two = await going(w, req, exe, 'pr-2');
  const { round } = w.claim(exe, two.taskId);
  const outcome = { ok: false, summary: dirty, microUsd: 0, tokens: 0, runner: 'cl\u0000aude', model: 'fa\nble' };
  assert.equal((await w.request(exe, req, 'done', { taskId: two.taskId, round, spec: w.spec(exe, two.taskId), outcome })).ok, true);
  const row = w.offerRow(req, two.taskId);
  assert.deepEqual([row.outcome.summary, row.outcome.runner, row.outcome.model, row.reason], [clean, 'cl aude', 'fa ble', clean]);
});

await check('an offer withdrawn before its run has a key ends the run all the same', async () => {
  const w = createWorld({ seed: 19 });
  const all = await w.pool(['req', 'exe', 'by'], { exe: { slots: 1 } });
  const [req, exe] = all;
  // The requester drops out of the executor's reach as the first ask for the key leaves.
  let cut = false;
  w.net.tap(({ from, kind }) => {
    if (cut || from !== 'exe' || kind !== 'key') return;
    cut = true;
    w.net.cut('req', 'exe');
  });
  const { taskId } = await req.node.offer(offerArgs('pr-1'));
  await w.net.until(() => cut, { stepMs: 5, what: 'the first ask for the key' });
  await req.node.withdraw({ taskId });
  // The executor hears of it from the third member.
  await w.net.until(() => w.runOf(exe, taskId).state === 'stopped', { maxMs: 10 * 60 * 1000, what: 'the run stopped' });
  await w.net.until(() => w.claim(exe, taskId).state === 'released', { what: 'the claim given back' });
  assert.deepEqual([exe.executor.started.length, w.offerRow(req, taskId).state], [0, 'cancelled']);
});

await check('an offer whose run reports that it failed is waiting again from the moment the attempt is counted: nothing shows it claimed at its next attempt, for as long as the claim of that run is still on record', async () => {
  for (const unheard of [0, 60]) {
    const w = createWorld({ seed: 20 });
    const [req, exe] = await w.pool(['req', 'exe'], { exe: { slots: 1 } });
    const { taskId, job } = await going(w, req, exe, 'pr-1');
    exe.slots = 0;
    exe.node.admit({ slots: 0, reason: 'busy' });
    const shown = () => {
      const { state, attempt, executor } = w.offerRow(req, taskId);
      return `${state} ${attempt} ${executor === exe.pk ? 'exe' : executor}`;
    };
    const seen = [];
    req.node.onChange(() => seen.push(shown()));
    // What the requester shows as it answers the report, before the executor ends its
    // claim - which the requester hears of `unheard` seconds later.
    let told = 0;
    w.net.tap(({ from, kind }) => (from === 'exe' && kind === 'done' ? () => {
      if (unheard > 0 && (told += 1) === 1) w.net.cut('req', 'exe');
      seen.push(shown());
    } : undefined));
    exe.executor.end(job.runId, { ok: false, summary: 'no luck' });
    if (unheard > 0) {
      await w.run(unheard);
      assert.equal(w.claim(req, taskId).state, 'held', 'the claim is on record as it was');
      w.net.heal();
    }
    await w.net.until(() => w.claim(req, taskId).state === 'released', { what: 'the claim given back' });
    await w.run(5);
    assert.deepEqual([...new Set(seen)], ['pooled 2 '], `the row from the report on, the end of the claim heard ${unheard} s later`);
  }
});
