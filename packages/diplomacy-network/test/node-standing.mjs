// What gives a claim standing (PROTOCOL.md section 7), tried by a member that means harm
// against the host that offers a task and against a bystander alike; what a round does
// with a member it cannot agree with; and how long a host waits before it goes for a task.

import assert from 'node:assert/strict';
import { POOL, check, createWorld } from './lib/hosts.mjs';
import { ClaimRound, LockTable, buildClaim } from '../src/core/claims.js';
import { sign } from '../src/core/identity.js';
import { endClaim } from '../src/core/lease.js';
import { LIMITS } from '../src/core/records.js';

const offerArgs = (item) => ({ pool: POOL, kind: 'review', item, title: `Review ${item}`, prompt: 'p' });
const ROUND = 'AAAAAAAAAAA';
const OUTCOME = { ok: true, summary: 's', microUsd: 0, tokens: 0, runner: 'r', model: 'm' };
const said = (answer) => (answer.ok ? 'ok' : `${answer.code}${answer.detail ? `: ${answer.detail}` : ''}`);
const verdict = (answer) => [answer.body.accepted, answer.body.refused.map((r) => r.code)];
const failures = (hosts) => hosts.flatMap((h) => h.log.filter((line) => /failed|could not be served/.test(line)));
const locksOf = (w, h) => Object.values(w.stored(h, 'locks') ?? {}).flat().map(([taskId]) => taskId);

function free(h, slots = 1) {
  h.slots = slots;
  h.node.admit({ slots });
}

await check('a claim no host offering the task granted displaces nothing: not a generation later, not released, not at the last generation', async () => {
  const w = createWorld({ seed: 91 });
  const all = await w.pool(['req', 'exe', 'by']);
  const [req, exe, by] = all;
  const evil = await w.intruder('evil', req);
  await w.net.until(() => all.every((h) => w.members(h).length === 4), { what: 'the intruder a member for everyone' });
  const { taskId } = await req.node.offer(offerArgs('pr-1'));
  free(exe);
  await w.net.until(() => exe.executor.jobOf(taskId), { what: 'the task run by an honest member' });
  await w.agreed(all);
  const held = w.claim(req, taskId);
  assert.deepEqual([held.executor, held.grants.map((g) => g.by).includes(req.pk)], [exe.pk, true]);
  const now = w.net.now();
  const forged = (fields) => buildClaim(evil.id, {
    pool: POOL, taskId, round: ROUND, gen: held.gen + 1, hours: 12, grants: [], absent: [req.pk, exe.pk, by.pk].sort(), now, ...fields,
  });
  const { sig: _, ...released } = { ...held, seq: held.seq + 1, at: now, state: 'released' };
  const records = [
    ['a claim a generation later', forged({}), 'no-offer'],
    ['a release a generation later', endClaim(evil.id, forged({}), 'released', now), 'no-offer'],
    ['a release at the last generation a record carries', endClaim(evil.id, forged({ gen: LIMITS.time }), 'released', now), 'no-offer'],
    ['the standing claim, released by another hand', { ...released, sig: sign(evil.id, 'dn1/rec', released) }, 'bad-signature'],
  ];
  for (const h of all) {
    for (const [what, record, code] of records) {
      assert.deepEqual(verdict(await w.request(evil, h, 'push', { records: [record] })), [[], [code]], `${what}, pushed to ${h.name}`);
    }
  }
  assert.match(said(await w.request(evil, req, 'done', { taskId, round: held.round, outcome: OUTCOME })), /^denied/, 'nor is the outcome its to report');
  await w.run(60);
  for (const h of all) assert.deepEqual([w.claim(h, taskId).executor, w.claim(h, taskId).round, w.claim(h, taskId).state], [exe.pk, held.round, 'held'], h.name);
  assert.equal(w.offerRow(req, taskId).state, 'claimed');
  assert.ok(w.stored(req, 'keys').issued[taskId], 'the key the requester issued stands');
  const job = exe.executor.jobOf(taskId);
  assert.ok(job, 'and the job runs on');
  exe.executor.end(job.runId);
  await w.net.until(() => w.offerRow(req, taskId).state === 'done', { what: 'the offer done' });
  assert.deepEqual([w.offerRow(req, taskId).outcome.summary, w.offerRow(req, taskId).attempt], ['all done', 1]);
  assert.deepEqual(failures(all), []);
});

await check('a claim round that throws - before it began, on its timer, on an answer, on a state that moved - is over: its locks are given back and the task is claimed later', async () => {
  const w = createWorld({ seed: 92 });
  const all = await w.pool(['req', 'exe', 'by']);
  const [req, exe, by] = all;
  free(exe);
  const broke = [];
  // `hold` is what a host takes its own lock with, on the timer that begins a round.
  for (const method of ['hold', 'tick', 'onSync', 'onLock', 'rebase']) {
    const { prototype } = method === 'hold' ? LockTable : ClaimRound;
    const real = prototype[method];
    let thrown = false;
    prototype[method] = function broken() {
      prototype[method] = real;
      thrown = true;
      throw new TypeError(`${method} broke`);
    };
    // A round that waits for a member is one whose timer comes due.
    if (method === 'tick') w.net.cut('exe', 'by');
    const { taskId } = await req.node.offer(offerArgs(`pr-${method.toLowerCase()}`));
    await w.net.until(() => thrown, { what: `${method} called` });
    w.net.heal();
    broke.push(`${method === 'hold' ? 'what a timer started' : 'a claim round'} failed: TypeError: ${method} broke`);
    await w.run(2);
    for (const h of all) assert.deepEqual(locksOf(w, h), [], `${method}: ${h.name} holds no lock`);
    assert.equal(w.task(req, taskId).state, 'available');
    await w.net.until(() => exe.executor.jobOf(taskId), { what: `the task claimed after ${method} broke` });
    exe.executor.end(exe.executor.jobOf(taskId).runId);
    await w.net.until(() => w.offerRow(req, taskId).state === 'done', { what: 'the offer done' });
  }
  assert.deepEqual(failures(all).map((line) => line.split('\n')[0]), broke, 'each failure is on record, and is all that failed');
});

await check('what fails on a timer after it had waited for something ends nothing: it is on record and the task is claimed later', async () => {
  const w = createWorld({ seed: 98 });
  const all = await w.pool(['req', 'exe', 'by']);
  const [req, exe] = all;
  const once = (prototype, method, fn) => {
    const real = prototype[method];
    prototype[method] = function patched() {
      prototype[method] = real;
      return fn();
    };
  };
  // The round is told to look at its state again, which it does on a timer, after it
  // waited; there the round breaks, and so does giving it up.
  let broken = false;
  once(ClaimRound.prototype, 'onSync', () => {
    once(ClaimRound.prototype, 'rebase', () => {
      once(LockTable.prototype, 'release', () => {
        broken = true;
        throw new TypeError('release broke');
      });
      throw new TypeError('rebase broke');
    });
    return [{ do: 'resync', with: null }];
  });
  free(exe);
  const { taskId } = await req.node.offer(offerArgs('pr-1'));
  await w.net.until(() => broken, { what: 'the failure' });
  await w.net.until(() => exe.executor.jobOf(taskId), { maxMs: 15 * 60 * 1000, what: 'the task claimed all the same' });
  assert.deepEqual(failures(all).map((line) => line.split('\n')[0]), [
    'a claim round failed: TypeError: rebase broke', 'what a timer started failed: TypeError: release broke',
  ]);
});

await check('the hours of a task are its offer\'s: no host grants a lock for others, and a claim for more than it was granted is no claim', async () => {
  const w = createWorld({ seed: 93 });
  const all = await w.pool(['req', 'by']);
  const [req] = all;
  const evil = await w.intruder('evil', req);
  await w.net.until(() => all.every((h) => w.members(h).length === 3), { what: 'the intruder a member for everyone' });
  const { taskId } = await req.node.offer(offerArgs('pr-1'));
  await w.agreed(all);
  const now = w.net.now();
  const lock = async (to, hours, id = taskId, asOf = now) => (await w.request(evil, to, 'lock', { taskId: id, round: ROUND, asOf, hash: w.view(to).hash, hours })).body;
  for (const h of all) assert.deepEqual(await lock(h, 720), { challenge: { reason: 'hours' } }, h.name);
  const grants = [];
  for (const h of all) grants.push((await lock(h, 12)).grant);
  grants.sort((x, y) => (x.by < y.by ? -1 : 1));
  assert.deepEqual(grants.map((g) => g.hours), [12, 12]);
  const claim = (hours) => buildClaim(evil.id, { pool: POOL, taskId, round: ROUND, gen: 0, hours, grants, absent: [], now });
  for (const h of all) {
    assert.deepEqual(verdict(await w.request(evil, h, 'push', { records: [claim(720)] })), [[], ['bad-grant']], h.name);
    assert.equal(w.task(h, taskId).state, 'available');
  }
  // For the hours it was granted the claim holds, and its deadline is the offer's.
  assert.deepEqual(verdict(await w.request(evil, req, 'push', { records: [claim(12)] })), [[`claim/${taskId}`], []]);
  const row = w.task(req, taskId);
  assert.deepEqual([row.executor, row.deadline - row.claimedAt], [evil.pk, 12 * 3600]);

  // An offer nobody ever held ends with no executor.
  const idle = await req.node.offer(offerArgs('pr-2'));
  await req.node.withdraw({ taskId: idle.taskId, reason: 'not needed' });
  const ended = w.offerRow(req, idle.taskId);
  assert.deepEqual([ended.state, ended.executor, ended.executorHere], ['cancelled', '', false]);

  // An offer keeps the executor that reported it done, also when its host first saw the
  // claim after the run was over.
  const quick = await req.node.offer(offerArgs('pr-3'));
  await w.agreed(all);
  const at = w.net.now();
  const granted = [];
  for (const h of all) granted.push((await lock(h, 12, quick.taskId, at)).grant);
  granted.sort((x, y) => (x.by < y.by ? -1 : 1));
  const made = buildClaim(evil.id, { pool: POOL, taskId: quick.taskId, round: ROUND, gen: 0, hours: 12, grants: granted, absent: [], now: at });
  assert.deepEqual(verdict(await w.request(evil, req, 'push', { records: [endClaim(evil.id, made, 'completed', at)] })), [[`claim/${quick.taskId}`], []]);
  assert.equal(w.offerRow(req, quick.taskId).executor, '');
  assert.equal((await w.request(evil, req, 'done', { taskId: quick.taskId, round: ROUND, outcome: OUTCOME })).ok, true);
  const over = w.offerRow(req, quick.taskId);
  assert.deepEqual([over.state, over.executor, over.executorHere], ['done', evil.pk, false]);
});

await check('an outcome reported for an offer that was withdrawn ends no later offer of the task', async () => {
  const w = createWorld({ seed: 96 });
  const all = await w.pool(['req', 'exe']);
  const [req, exe] = all;
  const { taskId } = await req.node.offer(offerArgs('pr-1'));
  free(exe);
  await w.net.until(() => exe.executor.jobOf(taskId), { what: 'the task run' });
  const first = w.claim(req, taskId);
  // The executor hears nothing of what the requester does next.
  w.net.cut('req', 'exe');
  await req.node.withdraw({ taskId, reason: 'changed' });
  const again = await req.node.offer(offerArgs('pr-1'));
  assert.equal(again.taskId, taskId);
  w.net.heal();
  const late = await w.request(exe, req, 'done', { taskId, round: first.round, outcome: OUTCOME });
  assert.deepEqual([late.ok, late.body], [true, {}], 'heard, and no more');
  // The claim holds the task until its executor lets go of it; the offer made since is
  // not done by it, and its host asks for no extension of a claim it did not grant.
  assert.deepEqual([w.offerRow(req, taskId).state, w.offerRow(req, taskId).outcome ?? null], ['claimed', null]);
  await w.run(first.leaseUntil - 60 - w.net.now());
  assert.deepEqual([w.claim(req, taskId).seq, w.net.count({ from: 'req', kind: 'ping' })], [first.seq, 0]);
  const old = exe.executor.jobOf(taskId).runId;
  exe.executor.end(old, { summary: 'the old work' });
  await w.net.until(() => exe.executor.jobOf(taskId) && exe.executor.jobOf(taskId).runId !== old, { what: 'the task claimed for the offer made since' });
  assert.deepEqual([w.offerRow(req, taskId).state, w.offerRow(req, taskId).outcome ?? null], ['claimed', null]);
  exe.executor.end(exe.executor.jobOf(taskId).runId, { summary: 'the work asked for' });
  await w.net.until(() => w.offerRow(req, taskId).state === 'done', { what: 'the offer done' });
  assert.equal(w.offerRow(req, taskId).outcome.summary, 'the work asked for');
});

await check('a claim a host made of its own task is no claim of an offer it made later: what that run reports ends nothing', async () => {
  const w = createWorld({ seed: 99 });
  const [req] = await w.pool(['req', 'by']);
  const mine = (item) => ({ ...offerArgs(item), now: true });
  const { taskId } = await req.node.offer(mine('pr-1'));
  await w.net.until(() => req.executor.jobOf(taskId), { what: 'the task run by its own host' });
  await w.run(5);
  const old = req.executor.jobOf(taskId).runId;
  // Withdrawn and offered again before the run has heard of either.
  await req.node.withdraw({ taskId, reason: 'changed' });
  await req.node.offer(mine('pr-1'));
  req.executor.end(old, { summary: 'the old work' });
  await w.net.until(() => req.executor.jobOf(taskId) && req.executor.jobOf(taskId).runId !== old, { what: 'the task claimed for the offer made since' });
  assert.deepEqual([w.offerRow(req, taskId).state, w.offerRow(req, taskId).outcome ?? null], ['claimed', null]);
  req.executor.end(req.executor.jobOf(taskId).runId, { summary: 'the work asked for' });
  await w.net.until(() => w.offerRow(req, taskId).state === 'done', { what: 'the offer done' });
  assert.deepEqual([w.offerRow(req, taskId).outcome.summary, w.offerRow(req, taskId).executorHere], ['the work asked for', true]);
});

await check('a member whose clock is far off is absent from a round, a task whose offerer\'s clock is far off is taken by nobody, and every host shows why', async () => {
  const w = createWorld({ seed: 94 });
  const all = await w.pool(['req', 'exe', 'off']);
  const [req, exe, off] = all;
  const member = (h, of) => w.view(h).members.find((m) => m.pk === of.pk);
  off.skew = 400;
  const { taskId } = await req.node.offer(offerArgs('pr-1'));
  await w.net.until(() => member(req, off).skew, { what: 'the offerer seeing one clock is off' });
  assert.equal(w.task(req, taskId).blocked, '', 'one member of several is not every host a claim needs');
  free(exe);
  await w.net.until(() => exe.executor.jobOf(taskId), { maxMs: 4 * 60 * 1000, what: 'the task claimed without the member whose clock is off' });
  const claim = w.claim(req, taskId);
  assert.deepEqual([claim.grants.map((g) => g.by), claim.absent], [[req.pk], [off.pk]]);
  assert.deepEqual([member(exe, off).skew, member(exe, req).skew, w.task(exe, taskId).blocked], [true, false, '']);
  await w.net.until(() => member(off, exe).skew && member(off, req).skew, { what: 'the host whose clock is off seeing so' });
  exe.executor.end(exe.executor.jobOf(taskId).runId);
  await w.net.until(() => w.offerRow(req, taskId).state === 'done', { what: 'the offer done' });

  off.skew = 0;
  free(exe, 0);
  const second = await req.node.offer(offerArgs('pr-2'));
  await w.agreed(all, 15 * 60 * 1000);
  req.skew = 400;
  free(exe);
  await w.net.until(() => exe.log.some((line) => line.includes(`claim of ${second.taskId} stood down: no-requester`)), { what: 'a round without the offerer' });
  await w.net.until(() => member(req, exe).skew && member(req, off).skew, { what: 'the offerer seeing its clock is off' });
  for (const h of all) assert.deepEqual([w.task(h, second.taskId).state, w.task(h, second.taskId).blocked], ['available', 'clock'], h.name);
  req.skew = 0;
  await w.net.until(() => exe.executor.jobOf(second.taskId), { what: 'the task claimed once the clocks agree' });
  await w.net.until(() => !member(exe, req).skew, { what: 'the note gone' });
  assert.equal(w.task(exe, second.taskId).blocked, '');
});

await check('a host waits as long as its executor weighs a task before it goes for it: another host takes the task meanwhile, and alone it takes it after the wait', async () => {
  const w = createWorld({ seed: 95 });
  const all = await w.pool(['req', 'slow', 'fast']);
  const [req, slow, fast] = all;
  const weighed = [];
  slow.executor.weigh = (task) => {
    weighed.push(task.taskId);
    return slow.wait;
  };
  slow.wait = 30000;
  free(slow);
  free(fast);
  const taken = async (item, options = {}) => {
    const from = w.net.now();
    const { taskId } = await (options.by ?? req).node.offer({ ...offerArgs(item), ...options.offer });
    await w.net.until(() => w.claim(req, taskId), { stepMs: 100, what: `${item} claimed` });
    const after = w.net.now() - from;
    await w.net.until(() => all.some((h) => h.executor.jobOf(taskId)), { what: `${item} run` });
    return { taskId, by: all.find((h) => h.executor.jobOf(taskId)).name, after };
  };
  const one = await taken('pr-1');
  assert.deepEqual([one.by, one.after < 15, weighed.includes(one.taskId)], ['fast', true, true]);
  // The wait over, the task is no longer there to go for: no round is begun for it.
  await w.run(45);
  assert.deepEqual([w.net.count({ from: 'slow', kind: 'lock' }), slow.log.filter((line) => line.includes('stood down'))], [0, []]);

  // The other host has no slot left: the task waits for this one.
  const two = await taken('pr-2');
  assert.deepEqual([two.by, two.after >= 30, two.after < 50], ['slow', true, true], `after ${two.after} s`);
  slow.executor.end(slow.executor.jobOf(two.taskId).runId);
  await w.net.until(() => w.offerRow(req, two.taskId).state === 'done', { what: 'the offer done' });

  // No wait is longer than a minute, and a task this host offered to run at once waits for nothing.
  slow.wait = 3600 * 1000;
  const three = await taken('pr-3');
  assert.deepEqual([three.by, three.after >= 60, three.after < 80], ['slow', true, true], `after ${three.after} s`);
  const own = await taken('pr-4', { by: slow, offer: { now: true } });
  assert.deepEqual([own.by, own.after < 10], ['slow', true], `after ${own.after} s`);
  assert.deepEqual(failures(all), []);
});
