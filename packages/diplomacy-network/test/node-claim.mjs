// Claiming, as whole hosts do it: one task and several free hosts, a host that claims
// its own task at once, a member that is down, the slots Diplomat states, the hours a
// host accepts, and the locks a claimant gives back when it stands down.

import assert from 'node:assert/strict';
import { forgeRequest } from './lib/fakes.mjs';
import { POOL, check, createWorld } from './lib/hosts.mjs';
import { outranks, rankDelay } from '../src/core/claims.js';
import { PROBE_TIMEOUT_MS, RANK_DELAY_MS, REQUEST_TIMEOUT_MS } from '../src/paths.js';

const offerArgs = (item, more = {}) => ({ pool: POOL, kind: 'review', item, title: `Review ${item}`, prompt: 'p', ...more });
const signers = (claim) => claim.grants.map((g) => g.by);

await check('one task and three free hosts: one commits with every member\'s grant, the others stand down and take the next', async () => {
  const w = createWorld({ seed: 31 });
  const all = await w.pool(['req', 'a', 'b', 'c'], { a: { slots: 1 }, b: { slots: 1 }, c: { slots: 1 } });
  const [req, ...free] = all;
  const since = w.net.now();
  const first = await req.node.offer(offerArgs('pr-1'));
  await w.net.until(() => free.some((h) => h.executor.jobOf(first.taskId)), { what: 'a job for the first task' });
  await w.agreed(all);
  const winner = free.find((h) => h.executor.jobOf(first.taskId));
  assert.deepEqual(free.map((h) => h.executor.started.length), free.map((h) => (h === winner ? 1 : 0)), 'exactly one host runs it');
  for (const h of all) assert.deepEqual([w.task(h, first.taskId).state, w.task(h, first.taskId).executor], ['claimed', winner.pk], `${h.name} names the same executor`);
  const claim = w.claim(req, first.taskId);
  assert.deepEqual(signers(claim), all.filter((h) => h !== winner).map((h) => h.pk).sort(), 'every other member granted it');
  assert.deepEqual([claim.absent, claim.gen, claim.executor], [[], 0, winner.pk]);
  for (const h of all.filter((x) => x !== winner)) {
    assert.ok(w.net.count({ from: winner.name, to: h.name, kind: 'sync', since }) >= 1, `${h.name} was asked to confirm the state`);
    assert.ok(w.net.count({ from: winner.name, to: h.name, kind: 'lock', since }) >= 1, `${h.name} was asked for its lock`);
  }
  // The next two tasks go to the two hosts that stood down; a fourth finds nobody free.
  const more = [];
  for (const item of ['pr-2', 'pr-3', 'pr-4']) more.push((await req.node.offer(offerArgs(item))).taskId);
  await w.net.until(() => free.every((h) => h.executor.started.length === 1), { what: 'every free host running one task' });
  await w.run(120);
  await w.agreed(all);
  assert.deepEqual(free.map((h) => h.executor.started.length), [1, 1, 1], 'nobody runs more than its slots');
  assert.deepEqual(w.view(req).tasks.map((t) => t.state).sort(), ['available', 'claimed', 'claimed', 'claimed']);
  assert.equal(new Set(w.view(req).tasks.map((t) => t.executor).filter(Boolean)).size, 3);
  assert.equal(w.task(req, more[2]).state, 'available', 'the oldest offers went first');
});

await check('a task offered to run at once is claimed by its own host with no slot, through the whole round; a member that is down is written off as absent', async () => {
  const w = createWorld({ seed: 32 });
  const all = await w.pool(['req', 'a', 'b']);
  const [req, a, b] = all;
  const since = w.net.now();
  const { taskId } = await req.node.offer(offerArgs('pr-1', { now: true }));
  await w.net.until(() => req.executor.jobOf(taskId), { what: 'the host running its own task' });
  await w.agreed(all);
  const claim = w.claim(a, taskId);
  assert.deepEqual([claim.executor, signers(claim), claim.absent], [req.pk, [a.pk, b.pk].sort(), []]);
  for (const h of [a, b]) {
    assert.ok(w.net.count({ from: 'req', to: h.name, kind: 'sync', since }) >= 1);
    assert.ok(w.net.count({ from: 'req', to: h.name, kind: 'lock', since }) >= 1);
    assert.equal(h.executor.started.length, 0);
  }
  const job = req.executor.jobOf(taskId);
  assert.equal(job.peer, req.pk, 'its key is its own');
  assert.equal((await w.wait(job.act(forgeRequest('GET', '/repos/o/r/pr-1/files')))).status, 200);
  assert.deepEqual(req.requester.calls.map((c) => c.op), ['authorize', 'perform']);
  assert.deepEqual([w.task(req, taskId).executorHere, w.offerRow(req, taskId).executorHere], [true, true]);

  // With b down, the next such task is claimed without it, and the claim says so.
  w.net.down('b');
  const second = await req.node.offer(offerArgs('pr-2', { now: true }));
  await w.net.until(() => req.executor.jobOf(second.taskId), { what: 'the second task running' });
  const without = w.claim(a, second.taskId);
  assert.deepEqual([signers(without), without.absent], [[a.pk], [b.pk]]);
  assert.ok(w.net.count({ from: 'req', to: 'b', kind: 'sync', since: without.claimedAt - 120 }) >= 1, 'the member that is down was asked in this very round');
  // A task not marked so waits for a slot like any other.
  const third = await req.node.offer(offerArgs('pr-3'));
  await w.run(120);
  assert.equal(w.task(req, third.taskId).state, 'available');
  req.executor.end(job.runId);
  await w.net.until(() => w.offerRow(req, taskId).state === 'done', { what: 'its own task done' });
});

await check('a host claims only on a fresh word about its slots, and never more than they allow', async () => {
  const w = createWorld({ seed: 33 });
  const all = await w.pool(['req', 'exe']);
  const [req, exe] = all;
  exe.node.admit({ slots: 2, reason: 'said once' });
  assert.deepEqual(exe.node.snapshot().admit, { slots: 2, at: w.net.now(), reason: 'said once' });
  await w.run(130);
  const tasks = [];
  for (const item of ['pr-1', 'pr-2', 'pr-3']) tasks.push((await req.node.offer(offerArgs(item))).taskId);
  await w.run(120);
  assert.equal(exe.executor.started.length, 0, 'a word two minutes old is no word');
  assert.equal(w.net.count({ from: 'exe', kind: 'lock' }), 0);
  exe.slots = 2;
  exe.node.admit({ slots: 2 });
  await w.net.until(() => exe.executor.started.length === 2, { what: 'two tasks running' });
  await w.run(300);
  assert.equal(exe.executor.started.length, 2);
  assert.deepEqual(tasks.map((t) => w.task(req, t).state), ['claimed', 'claimed', 'available']);
  // What the executor would not take is left alone.
  exe.executor.takes = (task) => task.item !== 'pr-3';
  exe.executor.end(exe.executor.jobOf(tasks[0]).runId);
  await w.net.until(() => w.task(req, tasks[0]).state === 'done', { what: 'the first task done' });
  await w.run(300);
  assert.equal(w.task(req, tasks[2]).state, 'available');
  exe.executor.takes = () => true;
  await w.net.until(() => w.task(req, tasks[2]).state === 'claimed', { what: 'the third task claimed' });
});

await check('a task that needs 24 hours is taken only by a host that accepts 24', async () => {
  const w = createWorld({ seed: 34 });
  const all = [w.add('req'), w.add('short', { slots: 1 }), w.add('long')];
  const [req, short, long] = all;
  req.settings.requiredMinimumH = 24;
  long.settings.maximumAcceptedH = 24;
  for (const h of all) await w.start(h);
  const { invite } = req.node.invite({ pool: POOL });
  for (const h of [short, long]) await h.node.join({ invite });
  await w.net.until(() => all.every((h) => w.members(h).length === 3), { what: 'the pool' });
  await w.agreed(all);
  assert.deepEqual(w.view(req).members.map((m) => [w.name(m.pk), m.maxAcceptedH]).sort(), [['long', 24], ['req', 12], ['short', 12]]);
  const weighed = [];
  short.executor.takes = (task) => weighed.push(task.taskId) > 0;
  const { taskId } = await req.node.offer(offerArgs('pr-1'));
  await w.run(300);
  assert.deepEqual([w.task(short, taskId).hours, w.task(short, taskId).state], [24, 'available']);
  assert.equal(w.net.count({ from: 'short', kind: 'lock' }), 0, 'the host that accepts 12 asks nobody for it');
  assert.deepEqual(weighed, [], 'nor its own executor whether it would take it');
  assert.deepEqual(short.log.filter((line) => line.includes('stood down')), [], 'and starts no round it would have to give up');
  long.slots = 1;
  long.node.admit({ slots: 1 });
  await w.net.until(() => long.executor.jobOf(taskId), { what: 'the 24-hour host running it' });
  const claim = w.claim(req, taskId);
  assert.deepEqual([claim.hours, claim.deadline - claim.claimedAt], [24, 24 * 3600]);
  // A setting that changes is a member record signed again.
  short.settings.maximumAcceptedH = 48;
  await w.net.until(() => w.view(req).members.find((m) => m.pk === short.pk).maxAcceptedH === 48, { what: 'the new hours known' });
});

await check('a claimant that stands down gives back the locks it was granted', async () => {
  const w = createWorld({ seed: 35 });
  const all = await w.pool(['req', 'x', 'y', 'q']);
  const [req, x, y, q] = all;
  const { taskId } = await req.node.offer(offerArgs('pr-1'));
  await w.agreed(all);
  const [better, worse] = outranks(taskId, x.pk, y.pk) ? [x, y] : [y, x];
  // The better-ranked host holds q's lock, by a request made by hand; its node sits idle.
  const lock = (round) => ({ taskId, round, asOf: w.net.now(), hash: w.view(better).hash });
  const held = await w.request(better, q, 'lock', lock('AAAAAAAAAAA'));
  assert.equal(held.body.grant.executor, better.pk);
  // The worse-ranked one goes for the task: req grants it, q names the holder, it stands down.
  worse.slots = 1;
  worse.node.admit({ slots: 1 });
  await w.net.until(() => worse.log.some((line) => line.includes('stood down: outranked')), { what: 'the worse-ranked host standing down' });
  await w.run(5);
  assert.ok(w.net.count({ from: worse.name, to: 'req', kind: 'unlock' }) >= 1);
  const after = await w.request(better, req, 'lock', lock('AAAAAAAAAAA'));
  assert.equal(after.body.grant?.executor, better.pk, 'req is free to grant the better-ranked host at once');
  assert.equal(worse.executor.started.length, 0);
  assert.equal(w.task(req, taskId).state, 'available');
});

await check('a host commits only with a slot still free, and counts nobody absent it never asked', async () => {
  const w = createWorld({ seed: 36 });
  const all = await w.pool(['req', 'exe', 'slow'], { exe: { slots: 1 } });
  const [req, exe] = all;
  // The word on slots is taken back while the round waits for a member that says nothing.
  // Once every host has asked the others what it missed, the next sync is a round's.
  await w.run(2);
  w.net.cut('exe', 'slow');
  let since = w.net.now();
  const { taskId } = await req.node.offer(offerArgs('pr-1'));
  await w.net.until(() => w.net.count({ from: 'exe', to: 'slow', kind: 'sync', since }) >= 1, { stepMs: 5, what: 'a round under way' });
  exe.slots = 0;
  exe.node.admit({ slots: 0, reason: 'busy' });
  await w.run(240);
  assert.equal(exe.executor.started.length, 0);
  assert.equal(w.claim(req, taskId), undefined, 'nothing was committed');
  assert.ok(exe.log.some((line) => line.includes('stood down: no slot left')));
  assert.ok(w.net.count({ from: 'exe', to: 'req', kind: 'unlock', since }) >= 1, 'the lock it was granted is given back');
  w.net.heal();

  // Its transport loses its footing in the middle of a round: what was never sent is no silence of a member's.
  exe.slots = 1;
  exe.node.admit({ slots: 1 });
  since = w.net.now();
  await w.net.until(() => w.net.count({ from: 'exe', kind: 'sync', since }) >= 2, { stepMs: 1, what: 'the next round under way' });
  exe.transport.host.ready = false;
  await w.run(300);
  assert.equal(w.claim(req, taskId), undefined, 'no claim with every member written off unasked');
  assert.ok(exe.log.some((line) => line.includes('stood down: offline')));
  exe.transport.host.ready = true;
  exe.transport.host.watchers.forEach((fn) => fn({ state: 'ready', detail: '' }));
  await w.net.until(() => exe.executor.jobOf(taskId), { what: 'the task claimed once the transport is back' });
  assert.deepEqual([signers(w.claim(req, taskId)), w.claim(req, taskId).absent], [all.filter((h) => h !== exe).map((h) => h.pk).sort(), []]);
});

await check('the word on slots is how many more: runs begun before it are not counted twice, one begun as it was said is', async () => {
  const w = createWorld({ seed: 37 });
  const [req, exe] = await w.pool(['req', 'exe']);
  // The machine runs two at a time, and Diplomat says how many more it takes.
  exe.node.admit({ slots: 1 });
  const first = await req.node.offer(offerArgs('pr-1'));
  await w.net.until(() => w.runOf(exe, first.taskId), { what: 'the first run' });
  // A word three seconds later may have been counted before that run was there to see.
  await w.run(3);
  exe.node.admit({ slots: 1 });
  const second = await req.node.offer(offerArgs('pr-2'));
  await w.run(40);
  assert.equal(w.task(req, second.taskId).state, 'available', 'one more was allowed, and one was taken');
  // A later word counted the run itself: one more means one more.
  exe.node.admit({ slots: 1 });
  await w.net.until(() => w.runOf(exe, second.taskId), { maxMs: 30000, what: 'the second run' });
  await w.run(100);
  const third = await req.node.offer(offerArgs('pr-3'));
  await w.run(60);
  assert.equal(w.task(req, third.taskId).state, 'available', 'and no more than that');
});

await check('a host says in one line of its log where the time of each round went, and when a run had its key and its job began: seconds and counts, and nothing any member said', async () => {
  const w = createWorld({ seed: 39 });
  const all = await w.pool(['req', 'exe', 'idle', 'zzz']);
  const [req, exe, idle] = all;
  // One member sleeps, for long enough that the others give it a short time to answer.
  w.net.sleep('zzz');
  await w.run(600);
  const first = await req.node.offer(offerArgs('pr-1'));
  const second = await req.node.offer(offerArgs('pr-2'));
  await w.agreed([req, exe, idle]);
  const about = (taskId) => exe.log.filter((line) => line.includes(` of ${taskId} `));
  // What it said as it started: once for each time it had to ask what it missed.
  const back = exe.log.filter((line) => line.includes(' is up to date '));
  assert.ok(back.length > 0 && back.every((line) => /^\S+ is up to date \d+ s after this host came back to it$/.test(line)), back.join(' | '));
  const numbers = (line, shape) => {
    assert.match(line, shape);
    return shape.exec(line).slice(1).map(Number);
  };

  exe.slots = 1;
  exe.node.admit({ slots: 1 });
  await w.net.until(() => exe.executor.jobOf(first.taskId), { what: 'a job' });
  const lines = about(first.taskId);
  assert.equal(lines.length, 3, lines.join(' | '));
  const [begun, waited, over] = numbers(lines[0], /^claim of \S+ made - begun (\d+) s after the offer, after a wait of (\d+) ms, over in (\d+) s: 3 members asked, 2 answered, 1 absent, 1 gave an offer$/);
  const sleeper = PROBE_TIMEOUT_MS / 1000;
  assert.ok(waited === rankDelay(first.taskId, exe.pk, RANK_DELAY_MS) && begun >= Math.floor(waited / 1000) && over >= sleeper && over <= sleeper + 2, lines[0]);
  const [keyed] = numbers(lines[1], /^key of \S+ received (\d+) s after its claim, at ask 1$/);
  const [started] = numbers(lines[2], /^job of \S+ started (\d+) s after its claim$/);
  assert.ok(keyed <= 1 && started >= keyed && started <= 1, lines.slice(1).join(' | '));

  // The host that offers the second task is gone when the round for it comes: the one
  // member that answers has no offer to give.
  w.net.sleep('req');
  exe.slots = 2;
  exe.node.admit({ slots: 1 });
  await w.net.until(() => about(second.taskId).length > 0, { what: 'a round for the second task' });
  const [, , gone] = numbers(about(second.taskId)[0], /^claim of \S+ stood down: no-requester - begun (\d+) s after the offer, after a wait of (\d+) ms, over in (\d+) s: 3 members asked, 1 answered, 2 absent$/);
  assert.ok(gone >= REQUEST_TIMEOUT_MS / 1000 && gone <= REQUEST_TIMEOUT_MS / 1000 + 2, about(second.taskId)[0]);
  // A member that stays tells it the state it holds, time and again.
  await w.run(200);
  assert.equal(exe.log.filter((line) => line.includes(' is up to date ')).length, back.length, 'a host that stayed says nothing more of being up to date');
});
