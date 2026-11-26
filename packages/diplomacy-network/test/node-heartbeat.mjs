import assert from 'node:assert/strict';
import { forgeRequest } from './lib/fakes.mjs';
import { POOL, check, createWorld } from './lib/hosts.mjs';
import { buildPing } from '../src/core/lease.js';
import { backing } from '../src/core/records.js';
import { GIVE_UP_WAIT_MS, LEASE_GRACE_SECS, LEASE_SECS, OFFER_ATTEMPTS } from '../src/paths.js';

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
    const claim = w.claim(req, taskId, runner);
    // Each executor claims once (gen 0); the requester's backing gen counts the attempts.
    assert.deepEqual([claim.gen, backing(claim, req.pk).gen, w.offerRow(req, taskId).attempt], [0, attempt, attempt]);
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
  await w.run(GIVE_UP_WAIT_MS / 1000 - 30);
  assert.equal(exe.executor.started.length, 1, 'the host that failed at it leaves it alone for a while');
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

await check('a machine alone in its pool uses the three attempts of its offer: it leaves a task it failed at alone for two minutes, then for four, takes it again when nobody else did, and the offer ends failed', async () => {
  const w = createWorld({ seed: 57 });
  const [solo] = await w.pool(['solo'], { solo: { slots: 1 } });
  const { taskId } = await solo.node.offer(offerArgs('pr-1'));
  const [began, ended] = [[], []];
  for (let attempt = 1; attempt <= OFFER_ATTEMPTS; attempt += 1) {
    await w.net.until(() => solo.executor.jobOf(taskId), { what: `job ${attempt}` });
    began.push(w.net.now());
    assert.equal(w.offerRow(solo, taskId).attempt, attempt);
    solo.executor.end(solo.executor.jobOf(taskId).runId, { ok: false, summary: `no luck ${attempt}` });
    ended.push(w.net.now());
  }
  await w.net.until(() => w.offerRow(solo, taskId).state === 'failed', { what: 'the offer failed' });
  // Slack for one TICK_MS between looks.
  const waits = [began[1] - ended[0], began[2] - ended[1]];
  assert.deepEqual(waits.map((s, i) => s >= GIVE_UP_WAIT_MS / 1000 * 2 ** i && s <= GIVE_UP_WAIT_MS / 1000 * 2 ** i + 15), [true, true], `${waits}`);
  assert.deepEqual([GIVE_UP_WAIT_MS, w.offerRow(solo, taskId).reason, w.task(solo, taskId).state], [2 * 60 * 1000, 'no luck 3', 'cancelled']);
  await w.run(60);
  // An offer made again starts its give-up waits over.
  await solo.node.offer(offerArgs('pr-1'));
  await w.net.until(() => solo.executor.jobOf(taskId), { maxMs: 20 * 1000, what: 'a job of the offer made again' });
  solo.executor.end(solo.executor.jobOf(taskId).runId, { ok: false });
  const failed = w.net.now();
  await w.net.until(() => solo.executor.jobOf(taskId), { what: 'its second job' });
  assert.equal(Math.round((w.net.now() - failed) / 60), 2);
});

await check('a machine that gives a task back time after time leaves it alone twice as long each time, up to an hour, and the offer loses no attempt by it; its row says until when, and alone in its pool the machine takes its own job once it can', async () => {
  for (const order of ['the start fails', 'the executor gives the run back and then fails the start']) {
    const w = createWorld({ seed: 68 });
    const [solo] = await w.pool(['solo'], { solo: { slots: 1 } });
    const { start } = solo.executor;
    if (order === 'the start fails') solo.executor.failStart = 'local';
    else {
      solo.executor.start = ({ runId }) => {
        solo.node.stopRun({ runId, reason: 'this machine could not start it: no docker' });
        throw Object.assign(new Error('no docker'), { name: 'OwnFault' });
      };
    }
    const { taskId } = await solo.node.offer(offerArgs('pr-1'));
    const at = [];
    for (let n = 1; n <= 8; n += 1) {
      await w.net.until(() => solo.executor.stopped.length === n, { maxMs: 2 * HOUR * 1000, stepMs: 1000, what: `the claim given back, ${n}` });
      at.push(w.net.now());
    }
    assert.deepEqual(at.slice(1).map((t, i) => Math.round((t - at[i]) / 60)), [2, 4, 8, 16, 32, 60, 60], order);
    const row = w.offerRow(solo, taskId);
    assert.deepEqual([row.state, row.attempt, solo.executor.started.length], ['pooled', 1, 0], order);
    assert.deepEqual([Math.abs(row.leftUntil - (at[7] + 3600)) <= 1, row.leftForGood, row.tooLong], [true, false, false], `${order}: left until ${row.leftUntil}`);
    solo.executor.failStart = false;
    solo.executor.start = start;
    await w.net.until(() => solo.executor.jobOf(taskId), { maxMs: 2 * HOUR * 1000, what: 'its own job' });
    assert.deepEqual([Math.round((w.net.now() - at[7]) / 60), w.offerRow(solo, taskId).state, w.offerRow(solo, taskId).leftUntil], [60, 'claimed', 0], order);
  }
});

await check('the row of a job of this machine\'s own says what keeps the machine from it: the operator stopped its run here, or it needs more hours than the machine takes', async () => {
  const w = createWorld({ seed: 69 });
  const [solo] = await w.pool(['solo'], { solo: { slots: 1 } });
  const flags = (taskId) => [w.offerRow(solo, taskId).state, w.offerRow(solo, taskId).leftUntil, w.offerRow(solo, taskId).leftForGood, w.offerRow(solo, taskId).tooLong];
  const { taskId } = await solo.node.offer(offerArgs('pr-1'));
  await w.net.until(() => solo.executor.jobOf(taskId), { what: 'its job' });
  assert.deepEqual(flags(taskId), ['claimed', 0, false, false]);
  await solo.node.stopRun({ runId: solo.executor.jobOf(taskId).runId });
  await w.net.until(() => w.offerRow(solo, taskId).state === 'pooled', { what: 'the job in the pool again' });
  assert.deepEqual(flags(taskId), ['pooled', 0, true, false]);
  solo.settings.requiredMinimumH = 24;
  const long = await solo.node.offer(offerArgs('pr-2'));
  assert.deepEqual(flags(long.taskId), ['pooled', 0, false, true]);
  await w.run(HOUR);
  assert.deepEqual([flags(taskId), flags(long.taskId), solo.executor.started.length], [['pooled', 0, true, false], ['pooled', 0, false, true], 1]);
  assert.equal('log' in solo.node.snapshot().runs[0], false, 'a run\'s row names no file');
  // Once another machine runs it, the row shows no `leftUntil`.
  const v = createWorld({ seed: 70 });
  const [a, b] = await v.pool(['a', 'b'], { a: { slots: 1 } });
  a.executor.failStart = 'local';
  const given = await a.node.offer(offerArgs('pr-3'));
  await v.net.until(() => v.offerRow(a, given.taskId).leftUntil > 0, { what: 'the job given back' });
  const { leftUntil } = v.offerRow(a, given.taskId);
  b.slots = 1;
  b.node.admit({ slots: 1 });
  await v.net.until(() => b.executor.jobOf(given.taskId), { what: 'the other machine at it' });
  assert.deepEqual([v.offerRow(a, given.taskId).state, v.offerRow(a, given.taskId).leftUntil, v.net.now() < leftUntil], ['claimed', 0, true]);
});

await check('a machine that failed at a task leaves it to the others first: one with a slot takes it meanwhile, and with none in the pool to take it, it goes for it again itself', async () => {
  for (const taker of [true, false]) {
    const w = createWorld({ seed: 58 });
    const [req, exe, other] = await w.pool(['req', 'exe', 'other'], { exe: { slots: 1 } });
    const { taskId } = await req.node.offer(offerArgs('pr-1'));
    await w.net.until(() => exe.executor.jobOf(taskId), { what: 'a job' });
    exe.executor.end(exe.executor.jobOf(taskId).runId, { ok: false });
    await w.net.until(() => w.offerRow(req, taskId).attempt === 2, { what: 'the attempt counted' });
    await w.run(GIVE_UP_WAIT_MS / 1000 - 30);
    assert.equal(w.task(req, taskId).state, 'available', 'nobody has it');
    if (taker) {
      other.slots = 1;
      other.node.admit({ slots: 1 });
    }
    await w.net.until(() => (taker ? other : exe).executor.jobOf(taskId), { what: 'the next job' });
    await w.run(HOUR);
    assert.deepEqual([exe.executor.started.length, other.executor.started.length], taker ? [1, 1] : [2, 0]);
  }
});

await check('a job that could not be started for a fault of its own machine is no attempt of the offer: the claim is given back with no report, and the machine goes for the task again after its wait', async () => {
  const w = createWorld({ seed: 60 });
  const [req, exe] = await w.pool(['req', 'exe'], { exe: { slots: 1 } });
  exe.executor.failStart = 'local';
  const { taskId } = await req.node.offer(offerArgs('pr-1'));
  await w.net.until(() => w.claim(req, taskId)?.state === 'released', { what: 'the claim given back' });
  const gaveBack = w.net.now();
  await w.run(15);
  const run = Object.values(w.stored(exe, 'runs').runs)[0];
  assert.deepEqual([run.state, run.outcome.summary, run.end], ['stopped', 'the run could not be started: no docker', 'over']);
  const row = w.offerRow(req, taskId);
  assert.deepEqual([row.state, row.attempt, row.reason, row.outcome], ['pooled', 1, '', null]);
  assert.equal(w.net.count({ from: 'exe', to: 'req', kind: 'done' }), 0);
  exe.executor.failStart = false;
  await w.net.until(() => exe.executor.jobOf(taskId), { what: 'a job' });
  assert.equal(w.net.now() - gaveBack >= GIVE_UP_WAIT_MS / 1000 - 1, true, 'not before its wait is over');
  exe.executor.end(exe.executor.jobOf(taskId).runId, { capped: true });
  await w.net.until(() => w.offerRow(req, taskId).state === 'done', { what: 'the offer done' });
  assert.equal(w.offerRow(req, taskId).attempt, 1);
  assert.deepEqual(w.offerRow(req, taskId).outcome, { ok: true, summary: 'all done', usd: 0.25, tokens: 1200, runner: 'claude', model: 'fable', capped: true });
});

await check('a lease is extended for a run that is going, never for a claim whose job is gone', async () => {
  const w = createWorld({ seed: 55 });
  const [req, exe] = await w.pool(['req', 'exe'], { exe: { slots: 1 } });
  const { taskId } = await req.node.offer(offerArgs('pr-1'));
  await w.net.until(() => exe.executor.jobOf(taskId), { what: 'a job' });
  const claim = w.claim(req, taskId);
  // The requester's own pings are cut off; a hand-made one arrives as the job dies.
  w.net.cut('req', 'exe');
  await w.run(claim.leaseUntil - 300 - w.net.now());
  w.net.heal();
  exe.executor.die(exe.executor.jobOf(taskId).runId);
  const answer = await w.request(req, exe, 'ping', { ping: buildPing(req.id, claim, w.net.now()) });
  assert.deepEqual([answer.ok, answer.code, answer.detail], [false, 'denied', 'no run']);
  await w.net.until(() => w.offerRow(req, taskId).attempt === 2, { what: 'the dead job reported' });
  assert.equal(w.claim(req, taskId).state, 'released');
});

await check('a run that never gets its key gives its claim back before its first lease ends', async () => {
  const w = createWorld({ seed: 56 });
  const [req, exe] = await w.pool(['req', 'exe'], { exe: { slots: 1 } });
  const { taskId } = await req.node.offer(offerArgs('pr-1'));
  req.requester.rulesFor = () => { throw new Error('the rules are gone'); };
  await w.net.until(() => w.claim(req, taskId), { what: 'the claim' });
  const { claimedAt } = w.claim(req, taskId);
  await w.run(LEASE_SECS - 120);
  assert.deepEqual([w.claim(req, taskId).state, w.runOf(exe, taskId).state], ['held', 'preparing']);
  assert.ok(w.net.count({ from: 'exe', to: 'req', kind: 'key', since: claimedAt }) > 200, 'asked every half minute, whatever the last answer was');
  assert.equal(w.net.count({ from: 'req', to: 'exe', kind: 'ping', since: claimedAt }), 0, 'asked for no lease: it has no key of this host\'s');
  const answer = await w.request(req, exe, 'ping', { ping: buildPing(req.id, w.claim(req, taskId), w.net.now()) });
  assert.deepEqual([answer.ok, answer.code, answer.detail], [false, 'denied', 'no run']);
  await w.run(130);
  const claim = w.claim(req, taskId);
  assert.deepEqual([claim.state, claim.seq, claim.leaseUntil - claimedAt], ['released', 1, LEASE_SECS], 'given back, never extended');
  assert.deepEqual([exe.executor.started.length, w.offerRow(req, taskId).attempt], [0, 1], 'no job, and no failed attempt');
});
