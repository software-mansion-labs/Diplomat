// What gives a claim standing (PROTOCOL.md section 7), tried by a member that means harm
// against the host that offers a task and against a bystander alike; what a round does
// with a member it cannot agree with; and how long a host waits before it goes for a task.

import assert from 'node:assert/strict';
import { POOL, check, createWorld } from './lib/hosts.mjs';
import { specDigest } from '../src/core/capability.js';
import { ClaimRound, LockTable, buildClaim, joinClaim } from '../src/core/claims.js';
import { sign } from '../src/core/identity.js';
import { endClaim } from '../src/core/lease.js';
import { LIMITS, backers, offerRecord } from '../src/core/records.js';

const offerArgs = (item) => ({ pool: POOL, kind: 'review', item, title: `Review ${item}`, prompt: 'p' });
const ROUND = 'AAAAAAAAAAA';
const OUTCOME = { ok: true, summary: 's', microUsd: 0, tokens: 0, runner: 'r', model: 'm' };
const said = (answer) => (answer.ok ? 'ok' : `${answer.code}${answer.detail ? `: ${answer.detail}` : ''}`);
const verdict = (answer) => [answer.body.accepted, answer.body.refused.map((r) => r.code)];
const failures = (hosts) => hosts.flatMap((h) => h.log.filter((line) => /failed|could not be served/.test(line)));
const locksOf = (w, h) => Object.values(w.stored(h, 'locks') ?? {}).flat().map(([taskId]) => taskId);
const claimKey = (taskId, by) => `claim/${taskId}/${by.pk}`;
// What names the job of an offer a host made, as that host works it out.
function jobOf(w, h, taskId) {
  const { kind, item, title, identity, prompt, options } = w.stored(h, 'offers')[taskId];
  return specDigest({ taskId, kind, item, title, identity, prompt, options });
}

function free(h, slots = 1) {
  h.slots = slots;
  h.node.admit({ slots });
}

await check('a member that offers a task another host offers too backs a claim of its own at the last generation a record carries, and signs its offer done and cancelled: the executor the other host granted is not stopped, its key stands, and that host\'s offer ends by its own run alone', async () => {
  const w = createWorld({ seed: 91 });
  const all = await w.pool(['req', 'exe', 'by']);
  const [req, exe, by] = all;
  const evil = await w.intruder('evil', req);
  await w.net.until(() => all.every((h) => w.members(h).length === 4), { what: 'the intruder a member for everyone' });
  const { taskId } = await req.node.offer(offerArgs('pr-1'));
  const push = async (h, record) => verdict(await w.request(evil, h, 'push', { records: [record] }));
  const lock = async (h) => (await w.request(evil, h, 'lock', { taskId, round: ROUND, asOf: w.net.now(), hash: w.view(h).hash })).body;
  free(exe);
  await w.net.until(() => exe.executor.jobOf(taskId), { what: 'the task run by an honest member' });
  await w.agreed(all);
  const held = w.claim(req, taskId);
  assert.deepEqual([held.executor, backers(held)], [exe.pk, [req.pk]]);
  const now = w.net.now();
  const mine = (fields) => offerRecord(evil.id, {
    pool: POOL, kind: 'review', item: 'pr-1', identity: taskId.split('@')[1], seq: 0, at: now, title: 'Mine', minRequiredH: 720, createdAt: now, ...fields,
  });
  const forged = buildClaim(evil.id, {
    pool: POOL, taskId, round: ROUND, gen: LIMITS.time, grants: [], absent: [req.pk, exe.pk, by.pk].sort(), now,
    offer: { at: now, gen: LIMITS.time, hours: 720 },
  });
  const { sig: _, offer: __, ...bare } = forged;
  const { sig: ___, ...released } = { ...held, seq: held.seq + 1, at: now, state: 'released' };
  for (const h of all) {
    // While it offers nothing, nothing backs its claim; and no lock is to be had on a task no offer of which is free.
    assert.deepEqual(await push(h, forged), [[], ['no-offer']], h.name);
    assert.deepEqual(await push(h, { ...bare, sig: sign(evil.id, 'dn1/rec', bare) }), [[], ['bad-claim']], 'a claim that says nobody backs it');
    assert.deepEqual(await push(h, { ...released, sig: sign(evil.id, 'dn1/rec', released) }), [[], ['bad-signature']], 'the standing claim, released by another hand');
    assert.deepEqual(await lock(h), { challenge: { reason: 'unavailable' } });
  }
  assert.match(said(await w.request(evil, req, 'done', { taskId, round: held.round, spec: w.spec(exe, taskId), outcome: OUTCOME })), /^denied/, 'nor is the outcome its to report');

  // It offers the task itself. The host whose offer is claimed consents to its claim as
  // any member does, and gives it nothing of its own offer.
  for (const h of all) assert.deepEqual(await push(h, mine({})), [[`offer/${taskId}/${evil.pk}`], []]);
  for (const h of all) {
    const { grant } = await lock(h);
    assert.deepEqual([grant.by, grant.executor, grant.offer], [h.pk, evil.pk, undefined], h.name);
    await w.request(evil, h, 'unlock', { taskId, round: ROUND });
  }
  for (const h of all) assert.deepEqual(await push(h, forged), [[claimKey(taskId, evil)], []]);
  await w.run(60);
  const stands = () => {
    for (const h of all) assert.deepEqual([w.claim(h, taskId, exe).round, w.claim(h, taskId, exe).state], [held.round, 'held'], h.name);
    const row = w.offerRow(req, taskId);
    assert.deepEqual([row.state, row.executor, row.attempt], ['claimed', exe.pk, 1]);
    assert.deepEqual([w.task(req, taskId).executor, w.task(exe, taskId).executorHere], [exe.pk, true], 'each host shows the claim that holds its own offer, or is its own');
    assert.ok(w.stored(req, 'keys').issued[taskId], 'the key the requester issued stands');
    assert.deepEqual([exe.executor.stopped, w.runOf(exe, taskId).state], [[], 'running']);
  };
  stands();

  // It signs its own offer done, then cancelled: that ends its own offer and no other.
  for (const [seq, state] of [[1, 'done'], [2, 'cancelled']]) {
    for (const h of all) assert.deepEqual(await push(h, mine({ seq, at: now + seq, state })), [[`offer/${taskId}/${evil.pk}`], []]);
    await w.run(60);
    stands();
    assert.deepEqual([w.task(by, taskId).state, w.task(by, taskId).offeredBy], ['claimed', [req.pk]]);
  }
  const job = exe.executor.jobOf(taskId);
  assert.equal(job.task.hours, 12, 'the hours of the job are those of the offer it was handed out for');
  exe.executor.end(job.runId);
  await w.net.until(() => w.offerRow(req, taskId).state === 'done', { what: 'the offer done' });
  assert.deepEqual([w.offerRow(req, taskId).outcome.summary, w.offerRow(req, taskId).attempt], ['all done', 1]);
  assert.deepEqual(failures(all), []);

  // An offer of more hours than an honest host accepts, made first, keeps nobody from the
  // other host's offer of the task.
  const at = w.net.now();
  const second = taskId.replace('pr-1', 'pr-2');
  for (const h of all) await push(h, mine({ item: 'pr-2', at, createdAt: at }));
  await req.node.offer(offerArgs('pr-2'));
  await w.net.until(() => exe.executor.jobOf(second), { what: 'the second task run' });
  assert.deepEqual([backers(w.claim(exe, second)), exe.executor.jobOf(second).task.hours], [[req.pk], 12]);
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

await check('an executor that reports the end of a job in words nothing can be made of breaks nothing: it is on record, and the run counts as ended without a word', async () => {
  const w = createWorld({ seed: 97 });
  const all = await w.pool(['req', 'exe']);
  const [req, exe] = all;
  free(exe);
  const { taskId } = await req.node.offer(offerArgs('pr-1'));
  await w.net.until(() => exe.executor.jobOf(taskId), { what: 'the task run' });
  const { runId } = exe.executor.jobOf(taskId);
  exe.executor.end(runId, { summary: { toString() { throw new TypeError('no words'); } } });
  assert.deepEqual(exe.log.filter((line) => line.includes('could not be taken up')).map((line) => line.split('\n')[0]), [`the end of ${runId} could not be taken up: TypeError: no words`]);
  await w.net.until(() => w.offerRow(req, taskId).attempt === 2, { what: 'the attempt counted as failed' });
  assert.deepEqual([w.offerRow(req, taskId).reason, w.runOf(exe, taskId).state], ['the run ended without saying how', 'failed']);
});

await check('the hours of a claim are those of the offers that back it: a host backs a claim for the hours of its own offer, gives nothing to a claimant that accepts fewer, and a claim that states other hours is no claim', async () => {
  const w = createWorld({ seed: 93 });
  const all = await w.pool(['req', 'by']);
  const [req, by] = all;
  const evil = await w.intruder('evil', req);
  await w.net.until(() => all.every((h) => w.members(h).length === 3), { what: 'the intruder a member for everyone' });
  const { taskId } = await req.node.offer(offerArgs('pr-1'));
  await w.agreed(all);
  const now = w.net.now();
  const lock = async (to, id = taskId, asOf = now) => (await w.request(evil, to, 'lock', { taskId: id, round: ROUND, asOf, hash: w.view(to).hash })).body;
  const granted = async (id, asOf) => {
    const grants = [];
    for (const h of all) grants.push((await lock(h, id, asOf)).grant);
    return grants.sort((x, y) => (x.by < y.by ? -1 : 1));
  };
  assert.equal((await w.request(evil, req, 'lock', { taskId, round: ROUND, asOf: now, hash: w.view(req).hash, hours: 12 })).code, 'bad-request', 'a lock asks for no hours');
  const grants = await granted(taskId, now);
  const created = w.stored(req, 'offers')[taskId].createdAt;
  assert.deepEqual(grants.map((g) => [g.by, g.offer]).sort(), [[req.pk, { at: created, gen: 1, hours: 12 }], [by.pk, undefined]].sort());
  const claim = buildClaim(evil.id, { pool: POOL, taskId, round: ROUND, gen: 0, grants, absent: [], now });
  const { sig: _, ...fields } = { ...claim, hours: 720, deadline: claim.claimedAt + 720 * 3600 };
  for (const h of all) {
    assert.deepEqual(verdict(await w.request(evil, h, 'push', { records: [{ ...fields, sig: sign(evil.id, 'dn1/rec', fields) }] })), [[], ['bad-claim']], h.name);
    assert.equal(w.task(h, taskId).state, 'available');
  }
  // For the hours it is backed for the claim holds, and its deadline is the offer's.
  assert.deepEqual(verdict(await w.request(evil, req, 'push', { records: [claim] })), [[claimKey(taskId, evil)], []]);
  const row = w.task(req, taskId);
  assert.deepEqual([row.executor, row.deadline - row.claimedAt], [evil.pk, 12 * 3600]);

  // An offer of more hours than the claimant accepts is not given to it.
  req.settings.requiredMinimumH = 24;
  const long = await req.node.offer(offerArgs('pr-4'));
  req.settings.requiredMinimumH = 12;
  await w.agreed(all);
  const witnessed = await granted(long.taskId, w.net.now());
  assert.deepEqual(witnessed.map((g) => g.offer), [undefined, undefined]);
  assert.throws(() => buildClaim(evil.id, { pool: POOL, taskId: long.taskId, round: ROUND, gen: 0, grants: witnessed, absent: [], now: w.net.now() }), TypeError);
  assert.equal(w.stored(req, 'offers')[long.taskId].gen, 0, 'and is not counted as given');

  // An offer nobody ever held ends with no executor.
  const idle = await req.node.offer(offerArgs('pr-2'));
  await req.node.withdraw({ taskId: idle.taskId, reason: 'not needed' });
  const ended = w.offerRow(req, idle.taskId);
  assert.deepEqual([ended.state, ended.executor, ended.executorHere], ['cancelled', '', false]);

  // An offer keeps the executor that reported it done, also when its host first saw the
  // claim after the run was over - and only for the job the offer is.
  const quick = await req.node.offer(offerArgs('pr-3'));
  await w.agreed(all);
  const at = w.net.now();
  const made = buildClaim(evil.id, { pool: POOL, taskId: quick.taskId, round: ROUND, gen: 0, grants: await granted(quick.taskId, at), absent: [], now: at });
  assert.deepEqual(verdict(await w.request(evil, req, 'push', { records: [endClaim(evil.id, made, 'completed', at)] })), [[claimKey(quick.taskId, evil)], []]);
  await w.run(5);
  assert.deepEqual([w.offerRow(req, quick.taskId).executor, w.offerRow(req, quick.taskId).state, w.offerRow(req, quick.taskId).attempt], ['', 'pooled', 1], 'a claim ended without a word of the job counts for nothing');
  const done = (spec) => w.request(evil, req, 'done', { taskId: quick.taskId, round: ROUND, spec, outcome: OUTCOME });
  assert.deepEqual([(await done(jobOf(w, req, taskId))).body, w.offerRow(req, quick.taskId).state], [{}, 'pooled'], 'the outcome of another job is heard, and no more');
  assert.equal((await done(jobOf(w, req, quick.taskId))).ok, true);
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
  const old = exe.executor.jobOf(taskId).runId;
  assert.deepEqual([w.offerRow(req, taskId).state, w.task(req, taskId).state], ['pooled', 'available'], 'the claim of the offer before holds nothing of this one');
  w.net.heal();
  const late = await w.request(exe, req, 'done', { taskId, round: first.round, spec: w.spec(exe, taskId), outcome: OUTCOME });
  assert.deepEqual([late.ok, late.body], [true, {}], 'heard, and no more');
  assert.deepEqual([w.offerRow(req, taskId).state, w.offerRow(req, taskId).outcome ?? null], ['pooled', null]);
  // The executor learns that its claim holds no offer: it stops that run, gives the
  // claim back and goes for the task as it is offered.
  await w.net.until(() => exe.executor.jobOf(taskId) && exe.executor.jobOf(taskId).runId !== old, { what: 'the task claimed for the offer made since' });
  assert.deepEqual(exe.executor.stopped, [{ runId: old, reason: 'the offer it ran for is no longer its claim\'s' }]);
  assert.deepEqual([w.offerRow(req, taskId).state, w.offerRow(req, taskId).outcome ?? null, w.net.count({ from: 'req', kind: 'ping' })], ['claimed', null, 0]);
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

await check('a host that gave its offer to a claim holds the lock until it holds that claim with its grant in it: asked again it gives the same number, and nobody else is granted the task', async () => {
  const w = createWorld({ seed: 97 });
  const all = await w.pool(['req', 'by']);
  const [req, by] = all;
  const evil = await w.intruder('evil', req);
  await w.net.until(() => all.every((h) => w.members(h).length === 3), { what: 'the intruder a member for everyone' });
  const { taskId } = await req.node.offer(offerArgs('pr-1'));
  await w.agreed(all);
  const now = w.net.now();
  // A member that offers the task too and runs it by a claim of its own.
  const offer = offerRecord(evil.id, {
    pool: POOL, kind: 'review', item: 'pr-1', identity: taskId.split('@')[1], seq: 0, at: now, title: 'Mine', minRequiredH: 12, createdAt: now, state: 'open',
  });
  const claim = buildClaim(evil.id, { pool: POOL, taskId, round: ROUND, gen: 0, grants: [], absent: [by.pk, req.pk].sort(), now, offer: { at: now, gen: 1, hours: 12 } });
  for (const h of all) assert.deepEqual(verdict(await w.request(evil, h, 'push', { records: [offer, claim] })), [[`offer/${taskId}/${evil.pk}`, claimKey(taskId, evil)], []]);
  const lock = async (from, round) => (await w.request(from, req, 'lock', { taskId, round, asOf: w.net.now(), hash: w.view(req).hash }, { effort: 4096 })).body;
  // It asks the other host for its offer, for the claim it holds.
  const { grant } = await lock(evil, ROUND);
  assert.deepEqual([grant.offer.gen, grant.offer.hours, locksOf(w, req)], [1, 12, [taskId]]);
  // The pool moves on, and the claim that round made is there without the grant.
  await req.node.offer(offerArgs('pr-2'));
  await w.run(5);
  assert.deepEqual(locksOf(w, req), [taskId]);
  assert.deepEqual(await lock(by, 'AAAAAAAAAAE'), { challenge: { reason: 'locked', holder: evil.pk } });
  assert.equal((await lock(evil, ROUND)).grant.offer.gen, 1, 'the same round is given the offer the same time over');
  assert.deepEqual(verdict(await w.request(evil, req, 'push', { records: [joinClaim(evil.id, claim, { grant })] })), [[claimKey(taskId, evil)], []]);
  await w.run(5);
  assert.deepEqual([locksOf(w, req), w.offerRow(req, taskId).state, w.offerRow(req, taskId).executor], [[], 'claimed', evil.pk]);
  assert.deepEqual(failures(all), []);
});

await check('an offer made again in the second the one before was made is another offer: a claim of the first holds nothing of it', async () => {
  const w = createWorld({ seed: 98 });
  const all = await w.pool(['req', 'by']);
  const [req, by] = all;
  const evil = await w.intruder('evil', req);
  await w.net.until(() => all.every((h) => w.members(h).length === 3), { what: 'the intruder a member for everyone' });
  await w.net.run(1000 - (w.net.ms() % 1000));
  const { taskId } = await req.node.offer(offerArgs('pr-1'));
  const first = w.net.now();
  const { grant } = (await w.request(evil, req, 'lock', { taskId, round: ROUND, asOf: first, hash: w.view(req).hash })).body;
  assert.deepEqual(grant.offer, { at: first, gen: 1, hours: 12 });
  const claim = buildClaim(evil.id, { pool: POOL, taskId, round: ROUND, gen: 0, grants: [grant], absent: [by.pk], now: first });
  assert.deepEqual(verdict(await w.request(evil, req, 'push', { records: [claim] })), [[claimKey(taskId, evil)], []]);
  assert.deepEqual([w.task(req, taskId).state, w.task(req, taskId).executor], ['claimed', evil.pk]);
  await req.node.withdraw({ taskId });
  await req.node.offer(offerArgs('pr-1'));
  assert.deepEqual([w.net.now(), w.task(req, taskId).state, w.task(req, taskId).executor], [first, 'available', '']);
});
