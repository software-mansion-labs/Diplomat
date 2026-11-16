// One task offered by several hosts - the machines of one operator that all find the
// same pull request. One run does for every offer it can be given, a host that offers
// the task later is taken into the run that is going, and what a host does with its own
// offer is nothing to the offer of another.

import assert from 'node:assert/strict';
import { POOL, check, createWorld } from './lib/hosts.mjs';
import { backers } from '../src/core/records.js';
import { LEASE_GRACE_SECS } from '../src/paths.js';

const offerArgs = (item, more = {}) => ({ pool: POOL, kind: 'review', item, title: `Review ${item}`, prompt: `look at ${item}`, ...more });
const started = (all) => all.reduce((sum, h) => sum + h.executor.started.length, 0);
const runner = (all, taskId) => all.find((h) => h.executor.jobOf(taskId));
const failures = (all) => all.flatMap((h) => h.log.filter((line) => /could not be served|step failed|round failed/.test(line)));
// Ends the job a host runs for a task, with the prompt it was given as its summary.
function finish(h, taskId) {
  const job = h.executor.jobOf(taskId);
  h.executor.end(job.runId, { summary: job.spec.prompt });
}
// Hosts of one pool, each with the hours it requires and accepts.
async function poolOf(w, hosts) {
  const all = Object.entries(hosts).map(([name, { slots = 0, requires = 12, accepts = 12 }]) => {
    const h = w.add(name, { slots });
    h.settings = { requiredMinimumH: requires, maximumAcceptedH: accepts };
    return h;
  });
  for (const h of all) await w.start(h);
  const { invite } = all[0].node.invite({ pool: POOL });
  for (const h of all.slice(1)) await h.node.join({ invite });
  await w.net.until(() => all.every((h) => w.members(h).length === all.length), { what: 'every host a member' });
  await w.agreed(all);
  return all;
}

await check('a host that offers a task while it runs is taken into that run, whoever has a slot free: no second job starts, and both offers end with the one outcome', async () => {
  const runners = new Set();
  for (const [seed, now] of [[31, true], [32, false], [33, true], [34, false], [35, true]]) {
    const w = createWorld({ seed });
    const all = await w.pool(['a', 'b', 'c'], { slots: 1 });
    const [a, b] = all;
    const { taskId } = await a.node.offer(offerArgs('pr-1'));
    await w.net.until(() => runner(all, taskId), { what: 'a job' });
    const by = runner(all, taskId);
    runners.add(by.name);
    // The second machine finds the pull request most of a minute later.
    await w.run(40);
    assert.equal((await b.node.offer(offerArgs('pr-1', { now }))).taskId, taskId);
    await w.run(600);
    assert.equal(started(all), 1, `seed ${seed}: one job`);
    assert.deepEqual(backers(w.claim(a, taskId)).sort(), [a.pk, b.pk].sort(), `seed ${seed}`);
    for (const h of all) assert.deepEqual([w.task(h, taskId).state, w.task(h, taskId).executor, [...w.task(h, taskId).offeredBy].sort()], ['claimed', by.pk, [a.pk, b.pk].sort()], h.name);
    assert.deepEqual([w.offerRow(b, taskId).state, w.offerRow(b, taskId).executor, w.offerRow(b, taskId).attempt], ['claimed', by.pk, 1]);
    finish(by, taskId);
    await w.net.until(() => [a, b].every((h) => w.offerRow(h, taskId).state === 'done'), { what: 'both offers done' });
    assert.deepEqual(w.offerRow(b, taskId).outcome, w.offerRow(a, taskId).outcome);
    assert.equal(w.offerRow(a, taskId).outcome.summary, 'look at pr-1');
    await w.run(600);
    assert.deepEqual([started(all), failures(all)], [1, []], `seed ${seed}: nobody ran it a second time`);
  }
  assert.ok(runners.size > 1, `the run was on different hosts: ${[...runners]}`);
});

await check('a host that offers another job under the name of a task that runs waits for that run and then has its own job done: the outcome of the one is nothing to the other', async () => {
  const w = createWorld({ seed: 41 });
  const all = await w.pool(['a', 'b', 'c'], { c: { slots: 1 } });
  const [a, b, c] = all;
  const { taskId } = await a.node.offer(offerArgs('pr-1'));
  await w.net.until(() => c.executor.jobOf(taskId), { what: 'a job' });
  await b.node.offer(offerArgs('pr-1', { prompt: 'something else' }));
  await w.run(300);
  assert.deepEqual([started(all), w.offerRow(b, taskId).state, w.offerRow(b, taskId).executor], [1, 'claimed', c.pk]);
  finish(c, taskId);
  await w.net.until(() => w.offerRow(a, taskId).state === 'done', { what: 'the first offer done' });
  await w.net.until(() => c.executor.jobOf(taskId), { what: 'a job for the second offer' });
  assert.deepEqual([c.executor.jobOf(taskId).spec.prompt, c.executor.jobOf(taskId).peer], ['something else', b.pk]);
  assert.deepEqual([w.offerRow(b, taskId).state, w.offerRow(b, taskId).attempt, w.offerRow(b, taskId).outcome], ['claimed', 1, null], 'the first run cost it no attempt');
  finish(c, taskId);
  await w.net.until(() => w.offerRow(b, taskId).state === 'done', { what: 'the second offer done' });
  assert.deepEqual([w.offerRow(a, taskId).outcome.summary, w.offerRow(b, taskId).outcome.summary, started(all)], ['look at pr-1', 'something else', 2]);
  assert.deepEqual(failures(all), []);
});

await check('two hosts that offer one task on two sides of a cut each have it run: when the cut heals both runs go on, and each offer ends by its own', async () => {
  const w = createWorld({ seed: 42 });
  const all = await w.pool(['a', 'b', 'e1', 'e2'], { e1: { slots: 1 }, e2: { slots: 1 } });
  const [a, b, e1, e2] = all;
  w.net.split(['a', 'e1'], ['b', 'e2']);
  const { taskId } = await a.node.offer(offerArgs('pr-1'));
  await b.node.offer(offerArgs('pr-1'));
  await w.net.until(() => e1.executor.jobOf(taskId) && e2.executor.jobOf(taskId), { maxMs: 30 * 60 * 1000, what: 'a job on either side' });
  assert.deepEqual([e1.executor.jobOf(taskId).peer, e2.executor.jobOf(taskId).peer], [a.pk, b.pk]);
  w.net.heal();
  await w.agreed(all);
  await w.run(600);
  assert.deepEqual([e1.executor.stopped, e2.executor.stopped, started(all)], [[], [], 2]);
  assert.deepEqual([backers(w.claim(a, taskId, e1)), backers(w.claim(a, taskId, e2))], [[a.pk], [b.pk]], 'neither run is given the offer the other holds');
  for (const h of all) assert.deepEqual([w.task(h, taskId).state, [...w.task(h, taskId).offeredBy].sort()], ['claimed', [a.pk, b.pk].sort()], h.name);
  e1.executor.end(e1.executor.jobOf(taskId).runId, { summary: 'the one' });
  await w.net.until(() => w.offerRow(a, taskId).state === 'done', { what: 'the first offer done' });
  await w.run(120);
  assert.deepEqual([w.offerRow(b, taskId).state, w.offerRow(b, taskId).executor, e2.executor.stopped], ['claimed', e2.pk, []]);
  e2.executor.end(e2.executor.jobOf(taskId).runId, { summary: 'the other' });
  await w.net.until(() => w.offerRow(b, taskId).state === 'done', { what: 'the second offer done' });
  assert.deepEqual([w.offerRow(a, taskId).outcome.summary, w.offerRow(b, taskId).outcome.summary], ['the one', 'the other']);
  assert.deepEqual(failures(all), []);
});

await check('a host that offers a task of another host and gives its own offer to the claim gets the run to do its job or not: the other offer ends by a run of its own job alone, at no attempt lost', async () => {
  const keyFrom = new Set();
  for (const seed of [51, 52, 53, 54, 55, 56]) {
    const w = createWorld({ seed });
    const all = await w.pool(['a', 'm', 'e']);
    const [a, m, e] = all;
    const { taskId } = await a.node.offer(offerArgs('pr-1'));
    await m.node.offer(offerArgs('pr-1', { prompt: 'do as I say' }));
    await w.agreed(all);
    e.slots = 1;
    e.node.admit({ slots: 1 });
    await w.net.until(() => e.executor.jobOf(taskId), { what: 'a job' });
    assert.deepEqual(backers(w.claim(a, taskId)).sort(), [a.pk, m.pk].sort());
    const first = e.executor.jobOf(taskId);
    keyFrom.add(w.name(first.peer));
    // Which of them it asks first is the run's own draw: no host arranges to be the one.
    assert.equal(first.peer, [a.pk, m.pk].sort()[w.stored(e, 'runs').runs[first.runId].pick % 2], `seed ${seed}`);
    assert.equal(w.net.count({ from: 'e', kind: 'key' }), 1);
    finish(e, taskId);
    // Whichever job the run did, the other is still to do: the same machine takes it next.
    await w.net.until(() => e.executor.jobOf(taskId) && e.executor.jobOf(taskId).runId !== first.runId, { what: 'the other job' });
    assert.notEqual(e.executor.jobOf(taskId).peer, first.peer);
    const mine = w.offerRow(a, taskId);
    if (first.peer === m.pk) assert.deepEqual([mine.state, mine.attempt, mine.outcome], ['claimed', 1, null], `seed ${seed}: the run of the other job said nothing of this offer`);
    finish(e, taskId);
    await w.net.until(() => [a, m].every((h) => w.offerRow(h, taskId).state === 'done'), { what: 'both offers done' });
    assert.deepEqual([w.offerRow(a, taskId).outcome.summary, w.offerRow(a, taskId).attempt, w.offerRow(a, taskId).executor], ['look at pr-1', 1, e.pk], `seed ${seed}`);
    assert.deepEqual([w.offerRow(m, taskId).outcome.summary, started(all)], ['do as I say', 2]);
    assert.deepEqual(failures(all), []);
  }
  assert.deepEqual([...keyFrom].sort(), ['a', 'm'], 'the run drew its key from either host');
});

await check('a run that outlasts the hours of one of the offers it holds goes on for the other: the offer it lost is run again by another machine, and each ends by its own run', async () => {
  let [seen, short] = [0, 0];
  for (const seed of [61, 62, 63, 64, 65, 66]) {
    const w = createWorld({ seed });
    const all = await poolOf(w, { a: { requires: 24 }, b: {}, e: { accepts: 24 }, f: {} });
    const [a, b, e, f] = all;
    const { taskId } = await a.node.offer(offerArgs('pr-1'));
    await b.node.offer(offerArgs('pr-1'));
    await w.agreed(all);
    e.slots = 1;
    e.node.admit({ slots: 1 });
    await w.net.until(() => e.executor.jobOf(taskId), { what: 'a job' });
    const job = e.executor.jobOf(taskId);
    const claim = w.claim(a, taskId);
    assert.deepEqual([backers(claim).sort(), claim.hours], [[a.pk, b.pk].sort(), 24]);
    // The job has the hours of the offer its key is from.
    if (job.peer === b.pk) {
      assert.equal(job.task.hours, 12);
      await w.run(12 * 3600 + 60);
      assert.deepEqual(e.executor.stopped, [{ runId: job.runId, reason: 'not finished by its deadline' }]);
      await w.net.until(() => [a, b].every((h) => w.offerRow(h, taskId).attempt === 2), { what: 'the attempt failed for both' });
      assert.deepEqual([a, b].map((h) => [w.offerRow(h, taskId).state, w.offerRow(h, taskId).reason]), Array(2).fill(['pooled', 'not finished by its deadline']));
      short += 1;
      continue;
    }
    seen += 1;
    assert.equal(job.task.hours, 24);
    await w.run(12 * 3600 + LEASE_GRACE_SECS + 60);
    assert.deepEqual([w.offerRow(b, taskId).state, w.offerRow(b, taskId).attempt, w.offerRow(b, taskId).reason], ['pooled', 2, 'not finished in the hours this machine gives it']);
    assert.deepEqual([e.executor.stopped, w.offerRow(a, taskId).state, w.offerRow(a, taskId).executor], [[], 'claimed', e.pk]);
    assert.deepEqual([w.task(f, taskId).state, w.task(f, taskId).executor], ['claimed', e.pk]);
    // Another machine takes the offer that is free again.
    f.slots = 1;
    f.node.admit({ slots: 1 });
    await w.net.until(() => f.executor.jobOf(taskId), { what: 'a second job' });
    assert.deepEqual([f.executor.jobOf(taskId).peer, backers(w.claim(f, taskId, f)), w.offerRow(b, taskId).executor], [b.pk, [b.pk], f.pk]);
    e.executor.end(job.runId, { summary: 'the long one' });
    await w.net.until(() => w.offerRow(a, taskId).state === 'done', { what: 'the longer offer done' });
    await w.run(120);
    assert.deepEqual([w.offerRow(b, taskId).state, f.executor.stopped], ['claimed', []], 'the run it gave the offer on from says nothing of it');
    f.executor.end(f.executor.jobOf(taskId).runId, { summary: 'the short one' });
    await w.net.until(() => w.offerRow(b, taskId).state === 'done', { what: 'the shorter offer done' });
    assert.deepEqual([w.offerRow(a, taskId).outcome.summary, w.offerRow(b, taskId).outcome.summary, started(all)], ['the long one', 'the short one', 2]);
    assert.deepEqual(failures(all), []);
    if (seen > 0 && short > 0) break;
  }
  assert.ok(seen > 0 && short > 0, `a run with its key from either host: ${seen} and ${short}`);
});

await check('a machine that offers a task and runs it has the key from itself, and one that offers a task it already runs takes its own offer into that run', async () => {
  const w = createWorld({ seed: 43 });
  const all = await w.pool(['a', 'e']);
  const [a, e] = all;
  const { taskId } = await a.node.offer(offerArgs('pr-1'));
  await e.node.offer(offerArgs('pr-1'));
  await w.agreed(all);
  e.slots = 1;
  e.node.admit({ slots: 1 });
  await w.net.until(() => e.executor.jobOf(taskId), { what: 'a job' });
  assert.deepEqual([backers(w.claim(a, taskId)), e.executor.jobOf(taskId).peer, w.net.count({ from: 'e', to: 'a', kind: 'key' })], [[e.pk, a.pk], e.pk, 0]);
  finish(e, taskId);
  await w.net.until(() => all.every((h) => w.offerRow(h, taskId).state === 'done'), { what: 'both offers done' });

  const second = (await a.node.offer(offerArgs('pr-2'))).taskId;
  await w.net.until(() => e.executor.jobOf(second), { what: 'a job' });
  assert.deepEqual([backers(w.claim(a, second)), e.executor.jobOf(second).peer], [[a.pk], a.pk]);
  await e.node.offer(offerArgs('pr-2'));
  await w.run(300);
  assert.deepEqual([backers(w.claim(a, second)), w.offerRow(e, second).state, w.offerRow(e, second).executorHere, started(all)], [[e.pk, a.pk], 'claimed', true, 2]);
  finish(e, second);
  await w.net.until(() => all.every((h) => w.offerRow(h, second).state === 'done'), { what: 'both offers done' });
  assert.deepEqual([w.offerRow(e, second).outcome, started(all), failures(all)], [w.offerRow(a, second).outcome, 2, []]);
});

await check('a run tells each host that offers its task how it ended until that host has heard, and no host twice', async () => {
  const w = createWorld({ seed: 44 });
  const all = await w.pool(['a', 'b', 'e']);
  const [a, b, e] = all;
  const { taskId } = await a.node.offer(offerArgs('pr-1'));
  await b.node.offer(offerArgs('pr-1'));
  await w.agreed(all);
  e.slots = 1;
  e.node.admit({ slots: 1 });
  await w.net.until(() => e.executor.jobOf(taskId), { what: 'a job' });
  assert.deepEqual(backers(w.claim(a, taskId)).sort(), [a.pk, b.pk].sort());
  w.net.cut('e', 'b');
  finish(e, taskId);
  await w.net.until(() => w.offerRow(a, taskId).state === 'done', { what: 'the offer of the host that hears done' });
  await w.run(600);
  assert.deepEqual([w.net.count({ from: 'e', to: 'a', kind: 'done' }), w.offerRow(b, taskId).state, w.claim(a, taskId).state], [1, 'claimed', 'held']);
  w.net.heal();
  await w.net.until(() => w.offerRow(b, taskId).state === 'done', { what: 'the other offer done' });
  await w.net.until(() => w.claim(a, taskId).state === 'completed', { what: 'the claim ended' });
  assert.deepEqual([w.net.count({ from: 'e', to: 'a', kind: 'done' }), w.offerRow(b, taskId).outcome, started(all), failures(all)], [1, w.offerRow(a, taskId).outcome, 1, []]);
});

await check('a run whose key is from a host that takes its offer back stops, though its claim holds the offer of another host: that offer is in the pool again, at no attempt lost', async () => {
  const w = createWorld({ seed: 45 });
  const all = await w.pool(['a', 'b', 'e']);
  const [a, b, e] = all;
  const { taskId } = await a.node.offer(offerArgs('pr-1'));
  await b.node.offer(offerArgs('pr-1'));
  await w.agreed(all);
  e.slots = 1;
  e.node.admit({ slots: 1 });
  await w.net.until(() => e.executor.jobOf(taskId), { what: 'a job' });
  const job = e.executor.jobOf(taskId);
  const [from, other] = job.peer === a.pk ? [a, b] : [b, a];
  assert.deepEqual(backers(w.claim(a, taskId)).sort(), [a.pk, b.pk].sort());
  from.node.withdraw({ taskId });
  await w.net.until(() => e.executor.stopped.length > 0, { what: 'the job stopped' });
  assert.deepEqual(e.executor.stopped, [{ runId: job.runId, reason: 'the task was withdrawn' }]);
  await w.net.until(() => w.offerRow(other, taskId).state === 'pooled', { what: 'the other offer in the pool again' });
  assert.deepEqual([w.offerRow(other, taskId).attempt, w.claim(other, taskId).state, failures(all)], [1, 'released', []]);
});

await check('a run leaves alone an offer of more hours than its machine accepts: another machine takes that offer', async () => {
  const w = createWorld({ seed: 46 });
  const all = await poolOf(w, { a: {}, b: { requires: 24 }, e: {}, f: { accepts: 24 } });
  const [a, b, e, f] = all;
  const { taskId } = await a.node.offer(offerArgs('pr-1'));
  await b.node.offer(offerArgs('pr-1'));
  await w.agreed(all);
  e.slots = 1;
  e.node.admit({ slots: 1 });
  await w.net.until(() => e.executor.jobOf(taskId), { what: 'a job' });
  await w.run(120);
  assert.deepEqual([backers(w.claim(a, taskId, e)), w.offerRow(b, taskId).state], [[a.pk], 'pooled']);
  f.slots = 1;
  f.node.admit({ slots: 1 });
  await w.net.until(() => f.executor.jobOf(taskId), { maxMs: 5 * 60 * 1000, what: 'a job for the longer offer' });
  assert.deepEqual([backers(w.claim(a, taskId, f)), f.executor.jobOf(taskId).task.hours, e.executor.stopped, failures(all)], [[b.pk], 24, [], []]);
});
