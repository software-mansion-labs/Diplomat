// The requester's key: who is handed it, by which host, how often, and what a request
// under it must carry. Every request here that the executor's own node would not make
// is made by hand.

import assert from 'node:assert/strict';
import { forgeRequest } from './lib/fakes.mjs';
import { POOL, check, createWorld } from './lib/hosts.mjs';
import { unb64u } from '../src/core/canon.js';
import { actMac } from '../src/core/capability.js';
import { endClaim } from '../src/core/lease.js';
import { LEASE_SECS } from '../src/paths.js';

const offerArgs = (item) => ({ pool: POOL, kind: 'review', item, title: `Review ${item}`, prompt: 'p' });
const said = ({ ok, code, detail }) => (ok ? 'ok' : `${code}: ${detail}`);

await check('a key goes to the executor of the committed claim, from the one host that granted it, once', async () => {
  const w = createWorld({ seed: 41 });
  const all = await w.pool(['r1', 'r2', 'exe', 'other']);
  const [r1, r2, exe, other] = all;
  const { taskId } = await r1.node.offer(offerArgs('pr-1'));
  await r2.node.offer(offerArgs('pr-1'));
  await w.agreed(all);
  const round = 'AAAAAAAAAAA';
  assert.equal(said(await w.request(exe, r1, 'key', { taskId, round })), 'denied: no active claim of the task names that executor and round');

  // r2 is down while the task is claimed: it offers the task but granted nothing.
  w.net.down('r2');
  exe.slots = 1;
  exe.node.admit({ slots: 1 });
  await w.net.until(() => exe.executor.jobOf(taskId), { what: 'a job' });
  w.net.down('r2', false);
  await w.agreed(all, 15 * 60 * 1000);
  const claim = w.claim(r2, taskId);
  assert.deepEqual([claim.executor, claim.absent], [exe.pk, [r2.pk]]);
  const held = w.stored(exe, 'keys').held[taskId];
  assert.deepEqual([held.host, held.capability.host, held.capability.executor, held.capability.exp], [r1.pk, r1.pk, exe.pk, claim.leaseUntil + 600]);
  assert.equal(r1.requester.rulesAsked, 2, 'once to offer, once to issue');

  const key = (from, to, body = { taskId, round: claim.round }) => w.request(from, to, 'key', body);
  assert.equal(said(await key(other, r1)), 'denied: no active claim of the task names that executor and round', 'not to another member');
  assert.equal(said(await key(exe, r1, { taskId, round })), 'denied: no active claim of the task names that executor and round', 'not for another round');
  assert.equal(said(await key(exe, r2)), 'denied: another host answers for this claim', 'not from a host that did not grant the claim');
  assert.equal(said(await key(exe, other)), 'denied: not offered by this host');
  assert.equal(said(await key(exe, r1, { taskId })), 'bad-request: ');
  const again = await key(exe, r1);
  assert.deepEqual([again.body.capability, again.body.secret], [held.capability, held.secret], 'asked again, the same key: never a second secret');
  assert.deepEqual(again.body.spec, held.spec);
  assert.equal(r1.requester.rulesAsked, 2);
  assert.deepEqual(Object.keys(w.stored(r1, 'keys').issued), [taskId]);
  assert.deepEqual(w.stored(r2, 'keys')?.issued ?? {}, {});
});

await check('a request under a key is its executor\'s alone, carries a number never used before, and a MAC', async () => {
  const w = createWorld({ seed: 42 });
  const all = await w.pool(['req', 'exe', 'thief'], { exe: { slots: 1 } });
  const [req, exe, thief] = all;
  const { taskId } = await req.node.offer(offerArgs('pr-1'));
  await w.net.until(() => exe.executor.jobOf(taskId), { what: 'a job' });
  const { capability, secret } = w.stored(exe, 'keys').held[taskId];
  const { keyId } = capability;
  const request = forgeRequest('GET', '/repos/o/r/pr-1/files');
  const act = (from, seq, change = {}) => {
    const body = { taskId, keyId, seq, request, mac: actMac(unb64u(secret), { keyId, seq, request }), ...change };
    return w.request(from, req, 'act', body);
  };
  const performed = () => req.requester.calls.filter((c) => c.op === 'perform').length;

  assert.equal(said(await act(thief, 5)), 'denied: not this key', 'the key and its secret in another member\'s hands are worth nothing');
  assert.equal(performed(), 0);
  const fine = await act(exe, 5);
  assert.deepEqual([fine.ok, fine.body.status, performed()], [true, 200, 1]);
  assert.equal(said(await act(exe, 5)), 'denied: seq is not new', 'the same number again');
  assert.equal(said(await act(exe, 4)), 'denied: seq is not new', 'a number below one already used');
  assert.equal(said(await act(exe, 6, { mac: actMac(unb64u(secret), { keyId, seq: 7, request }) })), 'denied: bad mac');
  assert.equal(said(await act(exe, 6, { keyId: 'AAAAAAAAAAAAAAAAAAAAAA' })), 'denied: not this key');
  assert.equal(said(await act(exe, 6, { request: { ...request, method: 'get' } })), 'bad-request: not an act body');
  assert.equal(performed(), 1);
  assert.equal((await act(exe, 6)).body.status, 200, 'a number a bad MAC named is not used up');
  assert.equal(w.stored(req, 'keys').issued[taskId].seq, 6);
  // The forge being down is the forge's answer, not the network's.
  req.requester.broken = true;
  const down = await act(exe, 7);
  assert.deepEqual([down.ok, down.body.status], [true, 502]);
  assert.deepEqual([w.offerRow(req, taskId).requests, w.offerRow(req, taskId).refused], [3, 0]);
  req.requester.broken = false;

  // The claim ends, and a request under its key arrives in the same instant, before the
  // requester has had a turn to take the key back: the claim is looked at again.
  Object.assign(w.net.faults, { minMs: 10, maxMs: 10 });
  const ended = endClaim(exe.id, w.claim(req, taskId), 'released', w.net.now());
  const [pushed, late] = await w.wait(Promise.all([
    w.request(exe, req, 'push', { records: [ended] }, { drive: false }),
    w.request(exe, req, 'act', { taskId, keyId, seq: 8, request, mac: actMac(unb64u(secret), { keyId, seq: 8, request }) }, { drive: false }),
  ]));
  assert.equal(pushed.body.accepted.length, 1);
  assert.equal(said(late), 'denied: the claim this key was issued for is not active');
  assert.equal(performed(), 3, 'nothing more was done on the forge');
  assert.equal(w.stored(req, 'keys').issued[taskId], undefined, 'and the key is gone');
});

await check('a key dies with what it was issued for, and a number is spent before the rules are asked', async () => {
  const w = createWorld({ seed: 43 });
  const all = await w.pool(['req', 'exe'], { exe: { slots: 3 } });
  const [req, exe] = all;
  const tasks = [];
  for (const item of ['pr-1', 'pr-2', 'pr-3']) tasks.push((await req.node.offer(offerArgs(item))).taskId);
  await w.net.until(() => exe.executor.started.length === 3, { what: 'three jobs' });
  const [failed, back, cut] = tasks;
  const act = (taskId, seq) => {
    const { capability: { keyId }, secret } = w.stored(exe, 'keys').held[taskId];
    const request = forgeRequest('GET', `/repos/o/r/pr-${tasks.indexOf(taskId) + 1}/files`);
    return w.request(exe, req, 'act', { taskId, keyId, seq, request, mac: actMac(unb64u(secret), { keyId, seq, request }) });
  };

  // The run is reported as failed while its claim still stands.
  assert.equal((await act(failed, 0)).body.status, 200);
  const outcome = { ok: false, summary: 'it broke', microUsd: 0, tokens: 0, runner: 'r', model: 'm' };
  assert.equal(said(await w.request(exe, req, 'done', { taskId: failed, round: w.claim(req, failed).round, outcome })), 'ok');
  assert.equal(w.task(req, failed).state, 'claimed');
  assert.equal(said(await act(failed, 1)), 'denied: no key');

  // The claim is given back, and nothing is asked under its key.
  await w.request(exe, req, 'push', { records: [endClaim(exe.id, w.claim(req, back), 'released', w.net.now())] });
  await w.run(1);
  assert.equal(w.stored(req, 'keys').issued[back], undefined);

  // The requester dies while its rules look at a request: the request's number is spent.
  const authorize = req.requester.authorize.bind(req.requester);
  req.requester.authorize = (...args) => {
    w.net.kill('req');
    return authorize(...args);
  };
  await assert.rejects(act(cut, 0), { code: 'timeout' });
  req.requester.authorize = authorize;
  assert.equal(w.stored(req, 'keys').issued[cut].seq, 0, 'it was on disk before the rules were asked');
  await w.restart(req);
  assert.equal(said(await act(cut, 0)), 'denied: seq is not new');
  assert.equal((await act(cut, 1)).body.status, 200);
});

await check('an executor asks for its key again half a minute after each ask, however long the requester stays out of reach', async () => {
  const w = createWorld({ seed: 47 });
  const [req, exe] = await w.pool(['req', 'exe'], { exe: { slots: 1 } });
  // The requester drops out of reach as the first ask for the key leaves.
  let cut = false;
  w.net.tap(({ from, headers }) => {
    if (cut || from !== 'exe' || headers['dn-kind'] !== 'key') return;
    cut = true;
    w.net.cut('req', 'exe');
  });
  const { taskId } = await req.node.offer(offerArgs('pr-1'));
  await w.net.until(() => cut, { what: 'the first ask' });
  await w.run(20 * 60);
  assert.equal(w.runOf(exe, taskId).state, 'preparing');
  w.net.heal();
  // One ask may still be waiting out its minute; the next follows half a minute later.
  await w.net.until(() => exe.executor.jobOf(taskId), { maxMs: 100 * 1000, what: 'the job started once the requester is back' });
});

const FAILED = { ok: false, summary: 'it broke', microUsd: 0, tokens: 0, runner: 'r', model: 'm' };

// A requester and an executor with a job going, and `act(seq, request)`: a forge request
// made by hand under the executor's key, left for the caller to run the network for.
async function keyed(seed) {
  const w = createWorld({ seed });
  const [req, exe] = await w.pool(['req', 'exe'], { exe: { slots: 1 } });
  const { taskId } = await req.node.offer(offerArgs('pr-1'));
  await w.net.until(() => exe.executor.jobOf(taskId), { what: 'a job' });
  const { capability: { keyId }, secret } = w.stored(exe, 'keys').held[taskId];
  const act = (seq, request) => w.request(exe, req, 'act', {
    taskId, keyId, seq, request, mac: actMac(unb64u(secret), { keyId, seq, request }),
  }, { effort: 4096, drive: false });
  // The rules take twenty seconds over the first request they are asked about.
  const authorize = req.requester.authorize.bind(req.requester);
  const asked = { n: 0 };
  req.requester.authorize = (...args) => {
    asked.n += 1;
    if (asked.n > 1) return authorize(...args);
    return new Promise((resolve) => { req.clock.setTimeout(() => resolve(authorize(...args)), 20000); });
  };
  return { w, req, exe, taskId, act, asked };
}
const write = (leaf) => forgeRequest('POST', `/repos/o/r/pr-1/${leaf}`, { n: 1 });

await check('a request is not carried out once its key was taken back, however far the rules had got with it', async () => {
  const ways = {
    'the offer withdrawn': ({ req, taskId }) => req.node.withdraw({ taskId, reason: 'no longer wanted' }),
    'the run reported as failed': ({ w, req, exe, taskId }) => w.request(exe, req, 'done', { taskId, round: w.claim(req, taskId).round, outcome: FAILED }, { effort: 4096 }),
    'the claim given back': ({ w, req, exe, taskId }) => w.request(exe, req, 'push', { records: [endClaim(exe.id, w.claim(req, taskId), 'released', w.net.now())] }, { effort: 4096 }),
    'the pool closed': ({ req }) => {
      req.pools = [];
      req.node.setPools([]);
    },
  };
  for (const [way, during] of Object.entries(ways)) {
    const world = await keyed(48);
    const { w, req, act, asked } = world;
    const pending = act(0, write('reviews'));
    await w.net.until(() => asked.n === 1, { stepMs: 5, what: 'the rules asked' });
    await during(world);
    assert.equal(said(await w.wait(pending)), 'denied: the key was taken back', way);
    assert.deepEqual(req.requester.calls.filter((c) => c.op === 'perform'), [], way);
  }
});

await check('requests under one key are carried out in the order of their numbers, however long the rules take over one', async () => {
  const { w, req, act, asked } = await keyed(49);
  const first = act(0, write('one'));
  await w.net.until(() => asked.n === 1, { stepMs: 5, what: 'the rules asked about the first' });
  const second = act(1, write('two'));
  const answers = await w.wait(Promise.all([first, second]));
  assert.deepEqual(answers.map((a) => a.body.status), [200, 200]);
  assert.deepEqual(req.requester.calls.filter((c) => c.op === 'perform').map((c) => c.path.split('/').at(-1)), ['one', 'two']);
});

await check('a round that said how it ended is counted once and gets no second key; of two hosts that granted, one answers for the claim', async () => {
  const w = createWorld({ seed: 52 });
  const [r1, r2, exe] = await w.pool(['r1', 'r2', 'exe'], { exe: { slots: 1 } });
  const { taskId } = await r1.node.offer(offerArgs('pr-1'));
  await r2.node.offer(offerArgs('pr-1'));
  await w.net.until(() => exe.executor.jobOf(taskId), { what: 'a job' });
  const [keeper, other] = exe.executor.jobOf(taskId).peer === r1.pk ? [r1, r2] : [r2, r1];
  const { round, grants } = w.claim(keeper, taskId);
  const ask = (to, kind, body) => w.request(exe, to, kind, body, { effort: 4096 });
  assert.deepEqual(grants.map((g) => g.by).sort(), [r1.pk, r2.pk].sort(), 'both granted the claim');
  assert.equal(said(await ask(other, 'key', { taskId, round })), 'denied: another host answers for this claim');
  const held = w.stored(exe, 'keys').held[taskId];
  assert.equal((await ask(keeper, 'key', { taskId, round })).body.secret, held.secret, 'asked again, the same key');
  // The run reports that it failed, twice over: one failed attempt, and the key is dead.
  for (let i = 0; i < 2; i += 1) assert.equal((await ask(keeper, 'done', { taskId, round, outcome: FAILED })).ok, true);
  assert.equal(w.offerRow(keeper, taskId).attempt, 2);
  assert.equal(w.stored(keeper, 'keys').issued[taskId], undefined);
  // Its claim still stands, and buys no new key with a fresh count of what it may do.
  assert.equal(w.claim(keeper, taskId).state, 'held');
  assert.equal(said(await ask(keeper, 'key', { taskId, round })), 'denied: no active claim of the task names that executor and round');
  assert.equal(w.stored(keeper, 'keys').issued[taskId], undefined);
});

await check('a claim made for an offer that was taken back gets nothing from the offer made after it', async () => {
  const w = createWorld({ seed: 53 });
  const [req, exe] = await w.pool(['req', 'exe'], { exe: { slots: 1 } });
  // The requester grants the claim and drops out of reach before it hands over the key.
  let cut = false;
  w.net.tap(({ from, headers }) => {
    if (cut || from !== 'exe' || headers['dn-kind'] !== 'key') return;
    cut = true;
    w.net.cut('req', 'exe');
  });
  const { taskId } = await req.node.offer(offerArgs('pr-1'));
  await w.net.until(() => cut, { stepMs: 5, what: 'the first ask for the key' });
  await w.run(2);
  // Its operator takes the offer back and makes it again, with another prompt.
  await req.node.withdraw({ taskId, reason: 'the wrong prompt' });
  await req.node.offer({ ...offerArgs('pr-1'), prompt: 'the second prompt' });
  w.net.heal();
  await w.run(600);
  assert.equal(w.claim(req, taskId).state, 'held', 'the claim of the first offer stands');
  assert.equal(exe.executor.started.length, 0, 'and is given no key');
  // The executor gives it back before its lease ends, and claims the task as it is offered.
  await w.net.until(() => exe.executor.jobOf(taskId), { maxMs: (LEASE_SECS + 600) * 1000, what: 'a job under a claim of the second offer' });
  const job = exe.executor.jobOf(taskId);
  assert.equal(job.spec.prompt, 'the second prompt');
  exe.executor.end(job.runId);
  await w.net.until(() => w.offerRow(req, taskId).state === 'done', { what: 'the offer done' });
  assert.deepEqual([w.offerRow(req, taskId).attempt, exe.executor.started.length], [1, 1], 'no failed attempt, and one job');
});

await check('while the rules of an offer are asked, the same offer made again is that offer, and a pool closed meanwhile takes none', async () => {
  const w = createWorld({ seed: 54 });
  const [req, other] = await w.pool(['req', 'other']);
  const rulesFor = req.requester.rulesFor.bind(req.requester);
  req.requester.rulesFor = (args) => new Promise((resolve) => { req.clock.setTimeout(() => resolve(rulesFor(args)), 5000); });
  const [one, two] = await w.wait(Promise.all([req.node.offer(offerArgs('pr-1')), req.node.offer(offerArgs('pr-1'))]));
  assert.equal(one.taskId, two.taskId);
  await w.agreed([req, other]);
  assert.deepEqual(w.records(other).filter((r) => r.type === 'offer').map((r) => r.seq), [0], 'signed once');
  const pending = req.node.offer(offerArgs('pr-2'));
  await w.run(1);
  req.pools = [];
  req.node.setPools([]);
  await assert.rejects(w.wait(pending), /is not linked on this machine/);
  assert.equal(req.node.snapshot().offers.some((o) => o.item === 'pr-2'), false);
});

await check('the lapse of a claim made for an offer that was taken back is no failed attempt of the offer made after it', async () => {
  const w = createWorld({ seed: 55 });
  const [req, exe] = await w.pool(['req', 'exe'], { exe: { slots: 1 } });
  let cut = false;
  w.net.tap(({ from, headers }) => {
    if (cut || from !== 'exe' || headers['dn-kind'] !== 'key') return;
    cut = true;
    w.net.cut('req', 'exe');
  });
  const { taskId } = await req.node.offer(offerArgs('pr-1'));
  await w.net.until(() => cut, { stepMs: 5, what: 'the first ask for the key' });
  await w.run(2);
  await req.node.withdraw({ taskId, reason: 'the wrong prompt' });
  await req.node.offer({ ...offerArgs('pr-1'), prompt: 'the second prompt' });
  w.net.heal();
  await w.net.until(() => w.claim(req, taskId)?.state === 'held', { what: 'the old claim known to the requester' });
  // Its executor dies holding it.
  w.net.kill('exe');
  await w.run(LEASE_SECS + 900);
  assert.deepEqual([w.task(req, taskId).state, w.offerRow(req, taskId).attempt], ['available', 1]);
});

await check('what a task has used belongs to the task: every key issued for it carries on from the last, and a restart forgets none of it', async () => {
  const w = createWorld({ seed: 61 });
  const all = await w.pool(['req', 'e1', 'e2'], { e1: { slots: 1 } });
  const [req, e1, e2] = all;
  const { taskId } = await req.node.offer(offerArgs('pr-1'));
  await w.net.until(() => e1.executor.jobOf(taskId), { what: 'the first job' });
  const first = e1.executor.jobOf(taskId);
  const get = (leaf) => forgeRequest('GET', `/repos/o/r/pr-1/${leaf}`);
  const asked = () => req.requester.calls.filter((c) => c.op === 'authorize').map((c) => c.asked);
  for (const leaf of ['a', 'b']) assert.equal((await w.wait(first.act(get(leaf)))).status, 200);
  const firstKey = w.stored(req, 'keys').issued[taskId].capability.keyId;

  // The run fails, its key dies, and another machine takes the task under a key of its own.
  e1.executor.end(first.runId, { ok: false, summary: 'out of time' });
  await w.net.until(() => w.offerRow(req, taskId).attempt === 2, { what: 'a second attempt' });
  assert.equal(w.stored(req, 'keys').issued[taskId], undefined);
  e2.slots = 1;
  e2.node.admit({ slots: 1 });
  await w.net.until(() => e2.executor.jobOf(taskId), { what: 'the second job' });
  const second = e2.executor.jobOf(taskId);
  assert.equal((await w.wait(second.act(get('c')))).status, 200);
  const key = w.stored(req, 'keys').issued[taskId];
  assert.notEqual(key.capability.keyId, firstKey, 'a new key');
  assert.deepEqual(asked(), [1, 2, 3], 'the second key does not start from nothing');
  assert.deepEqual(w.stored(req, 'offers')[taskId].used, { asked: 3 }, 'it is kept with the offer');
  assert.deepEqual(Object.keys(key).sort(), ['capability', 'round', 'secret', 'seq'], 'and not with the key');

  // What the rules counted is on disk before the request leaves: a machine that dies in between forgets nothing.
  const { perform } = req.requester;
  let onDisk;
  req.requester.perform = function sent(...args) {
    onDisk = w.stored(req, 'offers')[taskId].used;
    return perform.apply(this, args);
  };
  assert.equal((await w.wait(second.act(get('d')))).status, 200);
  req.requester.perform = perform;
  assert.deepEqual(onDisk, { asked: 4 });

  await w.restart(req);
  assert.equal((await w.wait(second.act(get('d')))).status, 200);
  assert.deepEqual(asked(), [1, 2, 3, 4, 5]);

  // A store that holds an offer without the member, and a key with a state of its own, is read all the same.
  const offers = w.stored(req, 'offers');
  delete offers[taskId].used;
  req.disk.write('offers', JSON.stringify(offers));
  const keys = w.stored(req, 'keys');
  keys.issued[taskId].state = { asked: 40 };
  req.disk.write('keys', JSON.stringify(keys));
  await w.restart(req);
  assert.equal((await w.wait(second.act(get('e')))).status, 200);
  assert.deepEqual(asked(), [1, 2, 3, 4, 5, 1]);
  assert.deepEqual(w.stored(req, 'offers')[taskId].used, { asked: 1 });
});
