// A machine that was not there for a while - asleep, switched off, without a network -
// and what it makes of its own offers once it is back: a job that was run for another
// machine's offer of it is not run a second time, nothing is counted against an offer by
// a state that is hours old, no offer is given away before the pool was asked what the
// machine missed, and an offer nobody could have signed for a day is over.

import assert from 'node:assert/strict';
import { POOL, check, createWorld } from './lib/hosts.mjs';
import { b64u } from '../src/core/canon.js';
import { backers } from '../src/core/records.js';
import { ELSEWHERE, OUTLIVED } from '../src/node/offers.js';
import { CATCH_UP_MS, CLOCK_SKEW_SECS, RECORD_RETENTION_SECS, REQUEST_TIMEOUT_MS } from '../src/paths.js';

const HOUR = 3600;
const offerArgs = (item, more = {}) => ({ pool: POOL, kind: 'review', item, title: `Review ${item}`, prompt: `look at ${item}`, ...more });
const started = (all) => all.reduce((sum, h) => sum + h.executor.started.length, 0);
const failures = (all) => all.flatMap((h) => h.log.filter((line) => /could not be served|step failed|round failed|could not be caught up/.test(line)));
const roundId = (n) => b64u(Buffer.alloc(8, n));
const NOTHING_BOOKED = { ok: true, summary: ELSEWHERE, usd: 0, tokens: 0, runner: '', model: '' };
// The record of the offer `by` made of a task, as `at` holds it.
const offerOf = (w, at, taskId, by) => w.records(at).find((r) => r.type === 'offer' && r.taskId === taskId && r.host === by.pk);
// How many tasks a machine runs at a time, said to its node at once.
function slots(h, n = 1) {
  h.slots = n;
  h.node.admit({ slots: n });
}
// Ends the job a host runs for a task, with the prompt it was given as its summary.
function finish(h, taskId, outcome = {}) {
  const job = h.executor.jobOf(taskId);
  h.executor.end(job.runId, { summary: job.spec.prompt, ...outcome });
}
// One request of a member with no node behind it, and what the host made of it.
const lock = async (w, from, to, taskId, round) => (await w.request(from, to, 'lock', { taskId, round, asOf: w.net.now(), hash: w.view(to).hash })).body;
const unlock = (w, from, to, taskId, round) => w.request(from, to, 'unlock', { taskId, round });

// A laptop `l` and a desktop `d` that offer one task, and `e`, which runs it; `more` are
// further machines. The laptop offers first and sleeps before anyone has a slot for it:
// the run is the desktop's offer's alone.
async function asleep(seed, { laptop = offerArgs('pr-1'), desktop = offerArgs('pr-1'), more = [] } = {}) {
  const w = createWorld({ seed });
  const all = await w.pool(['l', 'd', 'e', ...more]);
  const [l, d, e] = all;
  const { taskId } = await l.node.offer(laptop);
  await w.agreed(all);
  w.net.sleep('l');
  assert.equal((await d.node.offer(desktop)).taskId, taskId);
  slots(e);
  await w.net.until(() => e.executor.jobOf(taskId), { what: 'a job' });
  assert.deepEqual(backers(w.claim(d, taskId)), [d.pk], 'the run is the desktop\'s offer\'s alone');
  return { w, all, l, d, e, taskId };
}
// Ends that run well and waits for its claim to say so.
async function ran(w, d, e, taskId) {
  finish(e, taskId);
  await w.net.until(() => w.offerRow(d, taskId).state === 'done' && w.claim(d, taskId).state === 'completed', { what: 'the run over' });
}

await check('a machine that slept while its job was run for another machine\'s offer wakes to an offer that is done: nobody runs the job again, and the offer says who ran it and whose offer that run was given', async () => {
  const { w, all, l, d, e, taskId } = await asleep(101);
  const job = w.spec(e, taskId);
  await ran(w, d, e, taskId);
  assert.equal(w.claim(d, taskId).spec, job, 'the claim names the job that was run');
  // The laptop's offer is open in the pool all the while, and nobody can be given it.
  await w.run(2 * HOUR);
  assert.deepEqual([started(all), w.task(d, taskId).state, w.task(d, taskId).offeredBy], [1, 'available', [l.pk]]);
  w.net.sleep('l', false);
  await w.net.until(() => w.offerRow(l, taskId).state === 'done', { what: 'the laptop\'s offer done' });
  const row = w.offerRow(l, taskId);
  assert.deepEqual([row.executor, row.executorHere, row.backedBy, row.attempt, row.outcome], [e.pk, false, [d.pk], 1, NOTHING_BOOKED]);
  assert.deepEqual([w.offerRow(d, taskId).backedBy, w.offerRow(d, taskId).outcome.summary], [[], 'look at pr-1'], 'the offer the run was keyed for has its outcome');
  await w.run(HOUR);
  assert.deepEqual([started(all), failures(all)], [1, []]);
  for (const h of all) assert.equal(w.task(h, taskId).state, 'done', h.name);
});

await check('a machine that gave its offer to a run and slept through its end wakes to an offer that is done, at no failed attempt', async () => {
  const w = createWorld({ seed: 102 });
  const all = await w.pool(['l', 'd', 'e']);
  const [l, d, e] = all;
  const { taskId } = await l.node.offer(offerArgs('pr-1'));
  await d.node.offer(offerArgs('pr-1'));
  await w.agreed(all);
  slots(e);
  await w.net.until(() => e.executor.jobOf(taskId), { what: 'a job' });
  assert.deepEqual(backers(w.claim(d, taskId)).sort(), [d.pk, l.pk].sort());
  w.net.sleep('l');
  finish(e, taskId);
  // The run goes on telling the laptop until its lease is about to end.
  await w.net.until(() => w.claim(d, taskId).state === 'completed', { maxMs: 3 * HOUR * 1000, what: 'the claim completed' });
  await w.run(HOUR);
  w.net.sleep('l', false);
  await w.net.until(() => w.offerRow(l, taskId).state === 'done', { what: 'the laptop\'s offer done' });
  const row = w.offerRow(l, taskId);
  assert.deepEqual([row.executor, [...row.backedBy].sort(), row.attempt, row.outcome], [e.pk, [d.pk, l.pk].sort(), 1, NOTHING_BOOKED]);
  await w.run(HOUR);
  assert.deepEqual([started(all), failures(all)], [1, []]);
});

await check('a machine that slept through two leases of a run that goes on counts no failed attempt when it wakes, and one that was off for as long counts none while its transport comes up', async () => {
  for (const [seed, away] of [[103, 'asleep'], [104, 'off']]) {
    const w = createWorld({ seed });
    const all = await w.pool(['a', 'b', 'e']);
    const [a, b, e] = all;
    const { taskId } = await a.node.offer(offerArgs('pr-1'));
    await b.node.offer(offerArgs('pr-1'));
    await w.agreed(all);
    slots(e);
    await w.net.until(() => e.executor.jobOf(taskId), { what: 'a job' });
    assert.deepEqual(backers(w.claim(a, taskId)).sort(), [a.pk, b.pk].sort(), `${away}: the run has both offers`);
    // The machine the run has its key from stays, and keeps the lease; the other goes.
    const [stays, goes] = w.stored(e, 'keys').held[taskId].host === a.pk ? [a, b] : [b, a];
    const { leaseUntil } = w.claim(goes, taskId);
    if (away === 'asleep') w.net.sleep(goes.name);
    else w.net.kill(goes.name);
    await w.run(3 * HOUR);
    assert.ok(w.claim(stays, taskId).leaseUntil > leaseUntil && e.executor.jobOf(taskId), `${away}: the lease was kept`);
    if (away === 'asleep') w.net.sleep(goes.name, false);
    // Longer than a host waits for an answer before it goes by what it holds.
    else await w.restart(goes, { transportMs: CATCH_UP_MS + 2 * 60 * 1000 });
    await w.net.until(() => w.claim(goes, taskId).leaseUntil > leaseUntil, { what: 'the machine caught up' });
    await w.run(60);
    assert.deepEqual([w.offerRow(goes, taskId).state, w.offerRow(goes, taskId).attempt, w.offerRow(goes, taskId).reason], ['claimed', 1, ''], away);
    finish(e, taskId);
    await w.net.until(() => [a, b].every((h) => w.offerRow(h, taskId).state === 'done'), { what: 'both offers done' });
    assert.deepEqual([w.offerRow(goes, taskId).outcome.summary, w.offerRow(goes, taskId).attempt, started(all), failures(all)], ['look at pr-1', 1, 1, []], away);
  }
});

await check('a run that failed for another machine\'s offer costs a machine that slept nothing: its offer is open when it wakes, at its first attempt, and the next run is that attempt', async () => {
  const { w, all, l, d, e, taskId } = await asleep(105, { more: ['f'] });
  const f = all[3];
  finish(e, taskId, { ok: false });
  await w.net.until(() => w.offerRow(d, taskId).attempt === 2 && w.claim(d, taskId, e).state === 'released', { what: 'the failed run over' });
  assert.equal(w.claim(d, taskId, e).spec, undefined, 'a claim that was given back names no job');
  slots(e, 0);
  await w.run(HOUR);
  w.net.sleep('l', false);
  await w.run(120);
  assert.deepEqual([w.offerRow(l, taskId).state, w.offerRow(l, taskId).attempt, w.offerRow(l, taskId).outcome], ['pooled', 1, null]);
  slots(f);
  await w.net.until(() => f.executor.jobOf(taskId), { what: 'the next run' });
  assert.deepEqual(backers(w.claim(d, taskId, f)).sort(), [d.pk, l.pk].sort());
  finish(f, taskId);
  await w.net.until(() => [l, d].every((h) => w.offerRow(h, taskId).state === 'done'), { what: 'both offers done' });
  assert.deepEqual([w.offerRow(l, taskId).attempt, w.offerRow(d, taskId).attempt, w.offerRow(l, taskId).outcome.summary, started(all), failures(all)], [1, 2, 'look at pr-1', 2, []]);
});

await check('a run ends an offer made no longer after it was claimed than two clocks may differ: an offer made a second later than that was made knowing of the run, and is run', async () => {
  for (const [later, runs] of [[CLOCK_SKEW_SECS, 1], [CLOCK_SKEW_SECS + 1, 2]]) {
    const w = createWorld({ seed: 106 });
    const all = await w.pool(['l', 'd', 'e']);
    const [l, d, e] = all;
    const { taskId } = await d.node.offer(offerArgs('pr-1'));
    slots(e);
    await w.net.until(() => e.executor.jobOf(taskId), { what: 'a job' });
    const { claimedAt } = w.claim(d, taskId);
    await ran(w, d, e, taskId);
    await w.agreed(all);
    await w.run(claimedAt + later - w.net.now());
    await l.node.offer(offerArgs('pr-1'));
    assert.equal(offerOf(w, l, taskId, l).createdAt, claimedAt + later);
    await w.run(600);
    assert.equal(started(all), runs, `an offer ${later} s after the claim`);
    if (runs === 1) {
      assert.deepEqual([w.offerRow(l, taskId).state, w.offerRow(l, taskId).outcome, w.offerRow(l, taskId).backedBy], ['done', NOTHING_BOOKED, [d.pk]]);
    } else {
      finish(e, taskId);
      await w.net.until(() => w.offerRow(l, taskId).state === 'done', { what: 'the later offer done by its own run' });
      assert.deepEqual([w.offerRow(l, taskId).outcome.summary, w.offerRow(l, taskId).backedBy], ['look at pr-1', []]);
    }
    assert.deepEqual(failures(all), []);
  }
});

await check('a host that offers a task again as soon as its run ended has it run again: the run its earlier offer was given says nothing of the next', async () => {
  const w = createWorld({ seed: 107 });
  const all = await w.pool(['d', 'e']);
  const [d, e] = all;
  const { taskId } = await d.node.offer(offerArgs('pr-1'));
  slots(e);
  await w.net.until(() => e.executor.jobOf(taskId), { what: 'a job' });
  await ran(w, d, e, taskId);
  await d.node.offer(offerArgs('pr-1'));
  assert.ok(offerOf(w, d, taskId, d).createdAt - w.claim(d, taskId).claimedAt < CLOCK_SKEW_SECS, 'inside what two clocks may differ by');
  await w.net.until(() => started(all) === 2, { what: 'the task run again' });
  finish(e, taskId);
  await w.net.until(() => w.offerRow(d, taskId).state === 'done', { what: 'the second offer done' });
  assert.deepEqual([w.offerRow(d, taskId).outcome.summary, w.offerRow(d, taskId).backedBy, failures(all)], ['look at pr-1', [], []]);
});

await check('two machines of one operator: the laptop sleeps, the desktop runs the job for its own offer, and the laptop wakes to an offer that is done - the job is run once, and the offer names the desktop as the machine that ran it and as the host whose offer that run was given; with a third machine that offers the task too, the offer names both', async () => {
  for (const [seed, names] of [[108, ['l', 'd']], [118, ['l', 'd', 'x']]]) {
    const w = createWorld({ seed });
    const all = await w.pool(names);
    const [l, d] = all;
    const { taskId } = await l.node.offer(offerArgs('pr-1'));
    await w.agreed(all);
    w.net.sleep('l');
    for (const h of all.slice(1)) await h.node.offer(offerArgs('pr-1'));
    await w.agreed(all.slice(1));
    slots(d);
    await w.net.until(() => d.executor.jobOf(taskId), { what: 'the desktop running the task it offers' });
    finish(d, taskId);
    await w.net.until(() => all.slice(1).every((h) => w.offerRow(h, taskId).state === 'done') && w.claim(d, taskId).state === 'completed', { what: 'the run over' });
    const backed = all.slice(1).map((h) => h.pk).sort();
    assert.deepEqual([w.claim(d, taskId).executor, backers(w.claim(d, taskId)).sort()], [d.pk, backed], `${names}`);
    await w.run(HOUR);
    w.net.sleep('l', false);
    await w.net.until(() => w.offerRow(l, taskId).state === 'done', { what: 'the laptop\'s offer done' });
    const row = w.offerRow(l, taskId);
    assert.deepEqual([row.executor, [...row.backedBy].sort(), row.attempt, row.outcome], [d.pk, backed, 1, NOTHING_BOOKED], `${names}`);
    await w.run(HOUR);
    assert.deepEqual([started(all), failures(all)], [1, []], `${names}`);
    for (const h of all) assert.equal(w.task(h, taskId).state, 'done', h.name);
  }
});

await check('a run of another job under the name of the task ends no offer: the machine that slept has its own job run when it wakes', async () => {
  const { w, all, l, d, e, taskId } = await asleep(109, { desktop: offerArgs('pr-1', { prompt: 'another look' }) });
  await ran(w, d, e, taskId);
  await w.run(HOUR);
  w.net.sleep('l', false);
  await w.net.until(() => started(all) === 2, { what: 'the laptop\'s job' });
  assert.equal(e.executor.jobOf(taskId).spec.prompt, 'look at pr-1');
  finish(e, taskId);
  await w.net.until(() => w.offerRow(l, taskId).state === 'done', { what: 'the laptop\'s offer done' });
  assert.deepEqual([w.offerRow(l, taskId).outcome.summary, w.offerRow(l, taskId).backedBy, w.offerRow(d, taskId).outcome.summary, failures(all)], ['look at pr-1', [], 'another look', []]);
});

await check('a machine that slept a minute less than an offer lasts is told of the run and signs its offer once, done; one that slept longer has no offer left: it is cancelled, and nobody runs the job again', async () => {
  for (const [slept, state, reason] of [[RECORD_RETENTION_SECS - 60, 'done', ''], [RECORD_RETENTION_SECS + HOUR, 'cancelled', OUTLIVED]]) {
    const { w, all, l, d, e, taskId } = await asleep(110);
    const { offeredAt } = w.offerRow(l, taskId);
    const { seq } = offerOf(w, d, taskId, l);
    await ran(w, d, e, taskId);
    slots(e, 0);
    await w.run(offeredAt + slept - w.net.now());
    assert.equal(Boolean(w.claim(d, taskId)), state === 'done', 'the record of the run lasts a day and no longer');
    slots(e);
    w.net.sleep('l', false);
    await w.net.until(() => w.offerRow(l, taskId).state === state, { what: `the laptop's offer ${state}` });
    assert.deepEqual([w.offerRow(l, taskId).reason, w.offerRow(l, taskId).outcome], [reason, state === 'done' ? NOTHING_BOOKED : null]);
    await w.net.until(() => offerOf(w, d, taskId, l)?.state === state, { what: 'the pool told' });
    assert.equal(offerOf(w, d, taskId, l).seq, seq + 1, 'it was never signed open again');
    await w.run(HOUR);
    assert.deepEqual([started(all), failures(all)], [1, []], `asleep for ${slept} s`);
  }
});

await check('an offer whose machine slept for less than an offer lasts is open when it wakes and is taken; one whose machine slept longer is cancelled and taken by nobody', async () => {
  for (const [slept, runs] of [[RECORD_RETENTION_SECS - 60, 1], [RECORD_RETENTION_SECS + 60, 0]]) {
    const w = createWorld({ seed: 111 });
    const all = await w.pool(['l', 'e']);
    const [l, e] = all;
    const { taskId } = await l.node.offer(offerArgs('pr-1'));
    await w.agreed(all);
    w.net.sleep('l');
    await w.run(w.offerRow(l, taskId).offeredAt + slept - w.net.now());
    slots(e);
    w.net.sleep('l', false);
    await w.run(600);
    const row = w.offerRow(l, taskId);
    assert.deepEqual([started(all), row.state, row.reason, row.attempt], runs === 1 ? [1, 'claimed', '', 1] : [0, 'cancelled', OUTLIVED, 1], `asleep for ${slept} s`);
    assert.deepEqual(failures(all), []);
  }
});

await check('an offer nobody takes stays open for more than a day while its machine is there to sign it again', async () => {
  const w = createWorld({ seed: 120 });
  const all = await w.pool(['l', 'e']);
  const [l, e] = all;
  const { taskId } = await l.node.offer(offerArgs('pr-1'));
  await w.run(RECORD_RETENTION_SECS + HOUR);
  assert.deepEqual([w.offerRow(l, taskId).state, w.offerRow(l, taskId).reason, w.task(e, taskId).state], ['pooled', '', 'available']);
  slots(e);
  await w.net.until(() => e.executor.jobOf(taskId), { what: 'a job' });
  assert.deepEqual([w.offerRow(l, taskId).attempt, failures(all)], [1, []]);
});

await check('a machine that wakes gives none of its offers away before the pool was asked what it missed, whether a lock reaches it before its timers fire or after', async () => {
  for (const timersInMs of [0, 200]) {
    const w = createWorld({ seed: 112 });
    const all = await w.pool(['l', 'd']);
    const [l, d] = all;
    const evil = await w.intruder('evil', d);
    await w.net.until(() => w.members(l).includes(evil.pk), { what: 'the member known' });
    const { taskId } = await l.node.offer(offerArgs('pr-1'));
    await w.agreed(all);
    assert.equal((await lock(w, evil, l, taskId, roundId(1))).grant.offer.gen, 1, 'awake, it gives its offer');
    await unlock(w, evil, l, taskId, roundId(1));
    w.net.sleep('l');
    await w.run(2 * HOUR);
    // The lock is there in 20 ms, and the first answer to what the laptop asks in 40.
    Object.assign(w.net.faults, { minMs: 20, maxMs: 20 });
    const since = w.net.now();
    w.net.sleep('l', false, { timersInMs });
    const woken = await lock(w, evil, l, taskId, roundId(2));
    assert.deepEqual([Boolean(woken.grant), woken.grant.offer], [true, undefined], `timers after ${timersInMs} ms: the lock is granted, the offer is not given`);
    await unlock(w, evil, l, taskId, roundId(2));
    await w.net.until(() => w.net.count({ from: 'l', to: 'd', kind: 'sync', since }) >= 1, { what: 'the pool asked' });
    await w.run(5);
    assert.equal((await lock(w, evil, l, taskId, roundId(3))).grant.offer.gen, 2, 'the pool asked, it gives its offer again');
    assert.deepEqual(failures(all), []);
  }
});

await check('a machine that sleeps again before the pool has answered it is not up to date by the answer to what it asked before', async () => {
  const w = createWorld({ seed: 119 });
  const all = await w.pool(['l', 'd', 'x']);
  const [l, d] = all;
  const evil = await w.intruder('evil', d);
  await w.net.until(() => all.every((h) => w.members(h).includes(evil.pk)), { what: 'the member known' });
  const { taskId } = await l.node.offer(offerArgs('pr-1'));
  await w.agreed(all);
  for (const name of ['l', 'x']) w.net.sleep(name);
  await w.run(2 * HOUR);
  // It wakes and asks: one member has answered and the other is yet to have its time.
  w.net.sleep('l', false);
  await w.run(5);
  assert.equal((await lock(w, evil, l, taskId, roundId(1))).grant.offer, undefined, 'not up to date while a member may still answer');
  await unlock(w, evil, l, taskId, roundId(1));
  w.net.sleep('l');
  await w.run(2 * HOUR);
  Object.assign(w.net.faults, { minMs: 20, maxMs: 20 });
  w.net.sleep('l', false);
  const woken = await lock(w, evil, l, taskId, roundId(2));
  assert.deepEqual([Boolean(woken.grant), woken.grant.offer], [true, undefined], 'the lock is granted, the offer is not given');
  await unlock(w, evil, l, taskId, roundId(2));
  await w.run(REQUEST_TIMEOUT_MS / 1000 + 15);
  assert.equal((await lock(w, evil, l, taskId, roundId(3))).grant.offer.gen, 1, 'every member has had its time: it gives its offer');
  assert.deepEqual(failures(all), []);
});

await check('a machine whose transport comes back gives none of its offers away before the pool was asked: the job that was run meanwhile ends its offer', async () => {
  const w = createWorld({ seed: 113 });
  const all = await w.pool(['l', 'd', 'e']);
  const [l, d, e] = all;
  const evil = await w.intruder('evil', d);
  await w.net.until(() => all.every((h) => w.members(h).includes(evil.pk)), { what: 'the member known' });
  const { taskId } = await l.node.offer(offerArgs('pr-1'));
  await w.agreed(all);
  const say = (ready) => {
    l.transport.host.ready = ready;
    l.transport.host.watchers.forEach((fn) => fn({ state: ready ? 'ready' : 'starting', detail: '' }));
  };
  say(false);
  await d.node.offer(offerArgs('pr-1'));
  slots(e);
  await w.net.until(() => e.executor.jobOf(taskId), { what: 'a job' });
  await ran(w, d, e, taskId);
  slots(e, 0);
  await w.run(600);
  Object.assign(w.net.faults, { minMs: 20, maxMs: 20 });
  say(true);
  const back = await lock(w, evil, l, taskId, roundId(1));
  assert.deepEqual([Boolean(back.grant), back.grant.offer], [true, undefined], 'the lock is granted, the offer is not given');
  await w.run(5);
  assert.deepEqual([w.offerRow(l, taskId).state, w.offerRow(l, taskId).outcome, w.offerRow(l, taskId).backedBy], ['done', NOTHING_BOOKED, [d.pk]]);
  slots(e);
  await w.run(HOUR);
  assert.deepEqual([started(all), failures(all)], [1, []]);
});

await check('the record of a run and a lock that reach a host in one instant: the offer is done before it can be given away', async () => {
  const w = createWorld({ seed: 114 });
  const all = await w.pool(['l', 'd', 'e']);
  const [l, d, e] = all;
  const evil = await w.intruder('evil', d);
  await w.net.until(() => all.every((h) => w.members(h).includes(evil.pk)), { what: 'the member known' });
  const { taskId } = await l.node.offer(offerArgs('pr-1'));
  await w.agreed(all);
  w.net.split(['l'], ['d', 'e', 'evil']);
  await d.node.offer(offerArgs('pr-1'));
  slots(e);
  await w.net.until(() => e.executor.jobOf(taskId), { what: 'a job' });
  await ran(w, d, e, taskId);
  slots(e, 0);
  await w.agreed([d, e]);
  assert.deepEqual([w.offerRow(l, taskId).state, w.claim(l, taskId)], ['pooled', undefined], 'the laptop heard of none of it');
  w.net.heal();
  Object.assign(w.net.faults, { minMs: 20, maxMs: 20 });
  // What the desktop holds and the laptop lacks, and a lock on the state both then hold.
  const records = [offerOf(w, d, taskId, d), w.claim(d, taskId)];
  const pushed = w.request(d, l, 'push', { records }, { drive: false });
  const locked = w.request(evil, l, 'lock', { taskId, round: roundId(1), asOf: w.net.now(), hash: w.view(d).hash }, { drive: false });
  const [push, answer] = await w.wait(Promise.all([pushed, locked]));
  assert.deepEqual([push.body.accepted.length, Boolean(answer.body.grant), answer.body.grant.offer], [2, true, undefined], 'both records taken, the lock granted, the offer not given');
  assert.deepEqual([w.offerRow(l, taskId).state, w.offerRow(l, taskId).outcome], ['done', NOTHING_BOOKED]);
  assert.deepEqual(failures(all), []);
});

await check('a machine that wakes waits for every member it asks to have had its time to answer, and with nobody to answer goes on by what it holds after a while', async () => {
  for (const [seed, awake, atLeast, atMost, asked] of [[115, ['e'], REQUEST_TIMEOUT_MS, CATCH_UP_MS - 30000, 6], [116, [], CATCH_UP_MS, CATCH_UP_MS + 60000, 10]]) {
    const w = createWorld({ seed });
    const all = await w.pool(['l', 'd', 'e']);
    const [l] = all;
    const { taskId } = await l.node.offer(offerArgs('pr-1'));
    await w.agreed(all);
    for (const name of ['l', 'd', 'e']) w.net.sleep(name);
    await w.run(HOUR);
    for (const name of awake) w.net.sleep(name, false);
    await w.run(30);
    const [woke, since] = [w.net.ms(), w.net.now()];
    w.net.sleep('l', false);
    slots(l);
    await w.net.until(() => l.executor.jobOf(taskId), { stepMs: 1000, what: 'its own task run' });
    const waited = w.net.ms() - woke;
    assert.ok(waited >= atLeast && waited <= atMost, `with ${awake.length} of two members awake it ran its task after ${waited} ms`);
    // One question at a time: a member that says nothing is asked again when its time is up, and by the rounds for the task.
    assert.ok(w.net.count({ from: 'l', to: 'd', kind: 'sync', since }) <= asked, `it asked the member that says nothing ${w.net.count({ from: 'l', to: 'd', kind: 'sync', since })} times`);
    assert.deepEqual([w.offerRow(l, taskId).executorHere, failures(all)], [true, []]);
  }
});

await check('a machine that wakes asks the members it had given up on for a while, at once: it hears of the run and ends its offer', async () => {
  const w = createWorld({ seed: 117 });
  const all = await w.pool(['l', 'd', 'e']);
  const [l, d, e] = all;
  const { taskId } = await l.node.offer(offerArgs('pr-1'));
  await w.agreed(all);
  w.net.split(['l'], ['d', 'e']);
  await d.node.offer(offerArgs('pr-1'));
  slots(e);
  await w.net.until(() => e.executor.jobOf(taskId), { what: 'a job' });
  await ran(w, d, e, taskId);
  slots(e, 0);
  // Nobody has answered the laptop for so long that it asks only every ten minutes.
  await w.run(HOUR);
  w.net.sleep('l');
  w.net.heal();
  await w.run(120);
  w.net.sleep('l', false);
  await w.run(5);
  assert.deepEqual([w.offerRow(l, taskId).state, w.offerRow(l, taskId).outcome, w.offerRow(l, taskId).backedBy], ['done', NOTHING_BOOKED, [d.pk]]);
  assert.deepEqual(failures(all), []);
});

await check('a machine alone in its pool has nobody to ask what it missed, and runs its own offer as soon as it is started', async () => {
  const w = createWorld({ seed: 122 });
  const [solo] = await w.pool(['solo'], { solo: { slots: 1 } });
  await w.restart(solo);
  const { taskId } = await solo.node.offer(offerArgs('pr-1'));
  await w.run(10);
  assert.deepEqual([w.offerRow(solo, taskId).executorHere, failures([solo])], [true, []]);
});

await check('a run that ends when the host it reports to is back in reach tells that host at once, however long it had not answered: the offer ends by the report, with what the run cost', async () => {
  const w = createWorld({ seed: 123 });
  const all = await w.pool(['req', 'exe'], { exe: { slots: 1 } });
  const [req, exe] = all;
  const { taskId } = await req.node.offer(offerArgs('pr-1'));
  await w.net.until(() => exe.executor.jobOf(taskId), { what: 'a job' });
  w.net.cut('req', 'exe');
  await w.run(HOUR);
  w.net.heal();
  finish(exe, taskId, { usd: 0.5 });
  await w.run(5);
  assert.deepEqual([w.offerRow(req, taskId).state, w.offerRow(req, taskId).outcome.summary, w.offerRow(req, taskId).outcome.usd], ['done', 'look at pr-1', 0.5]);
  assert.deepEqual(failures(all), []);
});
