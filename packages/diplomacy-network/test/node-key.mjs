// The requester's key: who is handed it, by which host, how often, and what a request
// under it must carry. Every request here that the executor's own node would not make
// is made by hand.

import assert from 'node:assert/strict';
import { forgeRequest } from './lib/fakes.mjs';
import { POOL, check, createWorld } from './lib/hosts.mjs';
import { world as fakeForge } from './lib/world.mjs';
import { unb64u } from '../src/core/canon.js';
import { actMac } from '../src/core/capability.js';
import { buildClaim } from '../src/core/claims.js';
import { endClaim } from '../src/core/lease.js';
import { Pool } from '../src/core/pool.js';
import { backers } from '../src/core/records.js';
import { LEASE_SECS, RETAKE_WAIT_MS } from '../src/paths.js';
import { authorize as realAuthorize, conclude } from '../src/requester/authorize.js';

const offerArgs = (item) => ({ pool: POOL, kind: 'review', item, title: `Review ${item}`, prompt: 'p' });
const said = ({ ok, code, detail }) => (ok ? 'ok' : `${code}: ${detail}`);

await check('a key goes to the executor of the committed claim, from a host whose offer the claim holds, once', async () => {
  const w = createWorld({ seed: 41 });
  const all = await w.pool(['r1', 'r2', 'exe', 'other']);
  const [r1, r2, exe, other] = all;
  const { taskId } = await r1.node.offer(offerArgs('pr-1'));
  // The offer of r2 is for more hours than the executor accepts: it is never the claim's.
  r2.settings.requiredMinimumH = 24;
  await r2.node.offer(offerArgs('pr-1'));
  await w.agreed(all);
  const round = 'AAAAAAAAAAA';
  assert.equal(said(await w.request(exe, r1, 'key', { taskId, round })), 'denied: no claim of that executor and round holds the offer of this host');

  exe.slots = 1;
  exe.node.admit({ slots: 1 });
  await w.net.until(() => exe.executor.jobOf(taskId), { what: 'a job' });
  await w.agreed(all, 15 * 60 * 1000);
  const claim = w.claim(r2, taskId);
  assert.deepEqual([claim.executor, claim.absent, backers(claim)], [exe.pk, [], [r1.pk]]);
  const held = w.stored(exe, 'keys').held[taskId];
  assert.deepEqual([held.host, held.capability.host, held.capability.executor, held.capability.exp], [r1.pk, r1.pk, exe.pk, claim.leaseUntil + 600]);
  assert.equal(r1.requester.rulesAsked, 2, 'once to offer, once to issue');

  const key = (from, to, body = { taskId, round: claim.round }) => w.request(from, to, 'key', body);
  assert.equal(said(await key(other, r1)), 'denied: no claim of that executor and round holds the offer of this host', 'not to another member');
  assert.equal(said(await key(exe, r1, { taskId, round })), 'denied: no claim of that executor and round holds the offer of this host', 'not for another round');
  assert.equal(said(await key(exe, r2)), 'denied: no claim of that executor and round holds the offer of this host', 'not from a host that does not back the claim');
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
  assert.deepEqual(req.requester.unsent, [request.path], 'and the requester is told that its request got no answer');
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
  assert.equal(said(await w.request(exe, req, 'done', { taskId: failed, round: w.claim(req, failed).round, spec: w.spec(exe, failed), outcome })), 'ok');
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

await check('a key is one claim\'s: when a later claim holds the offer and its executor asks before the host has looked at its offers again, the key issued before is void from that moment and the executor is issued one of its own - never the secret issued for the claim before, whether the later claim is another executor\'s, the same executor\'s next, or another executor\'s under the same round', async () => {
  const [R1, R2] = ['AAAAAAAAAAA', 'AAAAAAAAAAE'];
  for (const [next, round, counted] of [['two', R2, 2], ['one', R2, 2], ['two', R1, 1]]) {
    const w = createWorld({ seed: 48 });
    const [req] = await w.pool(['req']);
    await w.run(1);
    // Two executors with no node behind them: they answer no ping.
    const one = await w.intruder('one', req);
    const two = await w.intruder('two', req);
    const later = next === 'one' ? one : two;
    const { taskId } = await req.node.offer(offerArgs('pr-1'));
    const claimed = async (who, id, gen) => {
      const now = w.net.now();
      const { grant } = (await w.request(who, req, 'lock', { taskId, round: id, asOf: now, hash: w.view(req).hash })).body;
      return buildClaim(who.id, { pool: POOL, taskId, round: id, gen, grants: [grant], absent: [who === one ? two.pk : one.pk], now });
    };
    const issued = () => w.stored(req, 'keys').issued[taskId];
    const request = forgeRequest('GET', '/repos/o/r/pr-1/files');
    const act = (who, { capability: { keyId }, secret }, seq) => w.request(who, req, 'act', {
      taskId, keyId, seq, request, mac: actMac(unb64u(secret), { keyId, seq, request }),
    });

    const first = await claimed(one, R1, 0);
    assert.equal((await w.request(one, req, 'push', { records: [first] })).body.accepted.length, 1);
    const k1 = (await w.request(one, req, 'key', { taskId, round: R1 })).body;
    assert.deepEqual([k1.capability.executor, issued().round], [one.pk, R1]);

    // Its lease runs out unanswered. From that second the claim holds the offer no
    // longer, and the host, which looks at its offers every ten seconds, has not yet
    // seen it.
    const lapse = first.leaseUntil + 600;
    await w.net.until(() => w.net.now() >= lapse, { stepMs: 10, maxMs: 3 * 3600 * 1000, what: 'the lease and its grace over' });
    Object.assign(w.net.faults, { minMs: 10, maxMs: 10 });
    const second = await claimed(later, round, later === one ? 1 : 0);
    assert.deepEqual([backers(second), issued().secret], [[req.pk], k1.secret], 'the offer is given on while the first key is still on the books');
    const [pushed, asked] = await w.wait(Promise.all([
      w.request(later, req, 'push', { records: [second] }, { drive: false }),
      w.request(later, req, 'key', { taskId, round }, { drive: false }),
    ]));
    assert.deepEqual([pushed.body.accepted.length, said(asked)], [1, 'ok'], `${next} ${round}`);
    const k2 = asked.body;
    assert.deepEqual([k2.capability.executor, k2.capability.keyId === k1.capability.keyId, k2.secret === k1.secret], [later.pk, false, false], `${next} ${round}`);
    // The host looks at its offers: a lapse of the first claim that it counts as a failed
    // attempt costs the claim that holds the offer now nothing.
    await w.run(1);
    assert.deepEqual([w.offerRow(req, taskId).attempt, issued().round, issued().secret], [counted, round, k2.secret], `${next} ${round}`);
    assert.equal(said(await act(one, k1, 0)), 'denied: not this key', 'the key of the claim before is worth nothing');
    assert.equal((await act(later, k2, 1)).body.status, 200);
  }
});

await check('a claim that lets go of an offer before its hold ran out costs the offer nothing, and its executor is not given that offer again for a minute - asked before the host has looked at its offers again or after - while another member is given it at once', async () => {
  const [R1, R2, R3, R4] = ['AAAAAAAAAAA', 'AAAAAAAAAAE', 'AAAAAAAAAAI', 'AAAAAAAAAAM'];
  for (const looked of [true, false]) {
    const w = createWorld({ seed: 67 });
    const [req] = await w.pool(['req']);
    await w.run(1);
    const one = await w.intruder('one', req);
    const two = await w.intruder('two', req);
    const { taskId } = await req.node.offer(offerArgs('pr-1'));
    const lock = (who, round, hash = w.view(req).hash, options = {}) => w.request(who, req, 'lock', { taskId, round, asOf: w.net.now(), hash }, options);
    const unlock = (who, round) => w.request(who, req, 'unlock', { taskId, round });
    const first = buildClaim(one.id, { pool: POOL, taskId, round: R1, gen: 0, grants: [(await lock(one, R1)).body.grant], absent: [two.pk], now: w.net.now() });
    assert.equal((await w.request(one, req, 'push', { records: [first] })).body.accepted.length, 1);
    // It sits on the task for an hour, and gives it back.
    await w.run(3600);
    assert.equal(w.offerRow(req, taskId).state, 'claimed');
    const now = w.net.now();
    const released = endClaim(one.id, first, 'released', now);
    let again;
    if (looked) {
      await w.request(one, req, 'push', { records: [released] });
      again = await lock(one, R2);
    } else {
      // Its next lock arrives with the end of its claim: it names the state that end makes.
      const after = new Pool({ id: POOL, self: one.pk });
      after.merge([...w.records(req), released], now);
      Object.assign(w.net.faults, { minMs: 10, maxMs: 10 });
      [, again] = await w.wait(Promise.all([
        w.request(one, req, 'push', { records: [released] }, { drive: false }),
        lock(one, R2, after.stateHash(now), { drive: false }),
      ]));
    }
    assert.deepEqual([again.ok, Object.keys(again.body), again.body.grant?.offer], [true, ['grant'], undefined], `a lock and no offer with it, ${looked}`);
    await unlock(one, R2);
    // Another member is given the offer at once. It gives it back too, and both wait.
    const granted = (await lock(two, R3)).body.grant;
    assert.equal(granted.offer.gen, 2);
    const second = buildClaim(two.id, { pool: POOL, taskId, round: R3, gen: 0, grants: [granted], absent: [one.pk], now: w.net.now() });
    assert.equal((await w.request(two, req, 'push', { records: [second] })).body.accepted.length, 1);
    await w.run(RETAKE_WAIT_MS / 1000 - 5);
    await w.request(two, req, 'push', { records: [endClaim(two.id, second, 'released', w.net.now())] });
    assert.equal((await lock(one, R4)).body.grant.offer, undefined, `not yet, ${looked}`);
    await w.run(6);
    assert.equal((await lock(one, R4)).body.grant.offer.gen, 3, `the one that let go a minute ago is given it again, ${looked}`);
    await unlock(one, R4);
    assert.equal((await lock(two, R2)).body.grant.offer, undefined, 'and not the one that let go since');
    assert.deepEqual([w.offerRow(req, taskId).state, w.offerRow(req, taskId).attempt, RETAKE_WAIT_MS], ['pooled', 1, 60 * 1000]);
  }
});

await check('an executor asks for its key again half a minute after each ask, however long the requester stays out of reach', async () => {
  const w = createWorld({ seed: 47 });
  const [req, exe] = await w.pool(['req', 'exe'], { exe: { slots: 1 } });
  // The requester drops out of reach as the first ask for the key leaves.
  let cut = false;
  w.net.tap(({ from, kind }) => {
    if (cut || from !== 'exe' || kind !== 'key') return;
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
// `prepare(req)` runs before anything is offered.
async function keyed(seed, prepare = () => {}) {
  const w = createWorld({ seed });
  const [req, exe] = await w.pool(['req', 'exe'], { exe: { slots: 1 } });
  prepare(req);
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
    'the run reported as failed': ({ w, req, exe, taskId }) => w.request(exe, req, 'done', { taskId, round: w.claim(req, taskId).round, spec: w.spec(exe, taskId), outcome: FAILED }, { effort: 4096 }),
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
    assert.deepEqual(req.requester.unsent, [write('reviews').path], `the requester is told: ${way}`);
  }
});

await check('a request the rules allowed and the forge was never asked is settled with the requester as not sent: the task may send it again, and what it used is kept as the requester left it', async () => {
  // The requester's own rules, over a forge in memory: one draft pull request a task,
  // from a branch it pushed.
  const rules = [{
    host: 'api.github.com', method: 'POST', path: '/repos/o/r/pulls',
    body: { head: { created: true, required: true }, draft: { equals: true, required: true }, title: 'free', base: 'free' },
  }];
  const draft = forgeRequest('POST', '/repos/o/r/pulls', { head: 'fix-1', base: 'main', title: 't', draft: true });
  const setup = async (seed) => {
    const forge = fakeForge();
    const seen = { state: null, down: false };
    const world = await keyed(seed, (req) => Object.assign(req.requester, {
      rulesFor: () => rules,
      context({ state }) {
        state.branches ??= ['refs/heads/fix-1'];
        seen.state = state;
        return { ...forge, state };
      },
      authorize: realAuthorize,
      conclude,
      async perform(request) {
        if (seen.down) throw new Error('no route to the forge');
        conclude(request, { status: 201, body: Buffer.from('{}') });
        return { status: 201, headers: {}, body: '' };
      },
    }));
    const used = async () => {
      await world.w.run(1);
      return world.w.stored(world.req, 'offers')[world.taskId].used;
    };
    return { ...world, forge, seen, used };
  };
  const counted = { branches: ['refs/heads/fix-1'], reserved: [], sent: {}, pulls: [], asked: ['fix-1'] };

  // The forge cannot be reached, and the stand-in for it says nothing of the request to the rules.
  const one = await setup(64);
  one.seen.down = true;
  assert.equal((await one.w.wait(one.act(0, draft))).body.status, 502);
  assert.deepEqual(await one.used(), counted, 'counted, since nobody can say it was not opened');
  one.seen.down = false;
  assert.equal((await one.w.wait(one.act(1, draft))).body.status, 201, 'sent again');
  assert.deepEqual(one.forge.listed, [['fix-1', undefined, true]], 'once the forge was asked what became of the first');
  assert.deepEqual(await one.used(), { ...counted, pulls: ['fix-1'], asked: [] });

  // The claim is given back while the rules are asked: the request is never sent.
  const two = await setup(65);
  const pending = two.act(0, draft);
  await two.w.net.until(() => two.asked.n === 1, { stepMs: 5, what: 'the rules asked' });
  await two.w.request(two.exe, two.req, 'push', { records: [endClaim(two.exe.id, two.w.claim(two.req, two.taskId), 'released', two.w.net.now())] }, { effort: 4096 });
  assert.equal(said(await two.w.wait(pending)), 'denied: the key was taken back');
  assert.deepEqual(await two.used(), counted);
  const again = await realAuthorize(rules, draft, { ...two.forge, state: two.seen.state });
  assert.deepEqual([again.ok, two.forge.listed], [true, [['fix-1', undefined, true]]], again.reason);
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

await check('a round that said how it ended is counted once and gets no second key; each of two hosts that back the claim answers for its own offer', async () => {
  const w = createWorld({ seed: 52 });
  const [r1, r2, exe] = await w.pool(['r1', 'r2', 'exe'], { exe: { slots: 1 } });
  const { taskId } = await r1.node.offer(offerArgs('pr-1'));
  await r2.node.offer(offerArgs('pr-1'));
  await w.net.until(() => exe.executor.jobOf(taskId), { what: 'a job' });
  const [keeper, other] = exe.executor.jobOf(taskId).peer === r1.pk ? [r1, r2] : [r2, r1];
  const { round, grants } = w.claim(keeper, taskId);
  const ask = (to, kind, body) => w.request(exe, to, kind, body, { effort: 4096 });
  assert.deepEqual(grants.map((g) => [g.by, g.offer.gen]).sort(), [[r1.pk, 1], [r2.pk, 1]].sort(), 'both back the claim');
  const held = w.stored(exe, 'keys').held[taskId];
  assert.equal((await ask(keeper, 'key', { taskId, round })).body.secret, held.secret, 'asked again, the same key');
  // The other host's key is its own: another secret, for what its own offer allows.
  const second = (await ask(other, 'key', { taskId, round })).body;
  assert.deepEqual([second.capability.host, second.secret === held.secret, second.spec], [other.pk, false, held.spec]);
  // The run reports that it failed, twice over: one failed attempt, and the key is dead.
  const spec = w.spec(exe, taskId);
  for (let i = 0; i < 2; i += 1) assert.equal((await ask(keeper, 'done', { taskId, round, spec, outcome: FAILED })).ok, true);
  assert.equal(w.offerRow(keeper, taskId).attempt, 2);
  assert.equal(w.stored(keeper, 'keys').issued[taskId], undefined);
  assert.deepEqual([w.offerRow(other, taskId).attempt, Object.keys(w.stored(other, 'keys').issued)], [1, [taskId]], 'what one host was told is nothing to the other');
  // Its claim still stands, and buys no new key with a fresh count of what it may do.
  assert.equal(w.claim(keeper, taskId).state, 'held');
  assert.equal(said(await ask(keeper, 'key', { taskId, round })), 'denied: no claim of that executor and round holds the offer of this host');
  assert.equal(w.stored(keeper, 'keys').issued[taskId], undefined);
});

await check('a claim made for an offer that was taken back holds nothing of the offer made after it: its executor gives it back and claims the task as it is offered', async () => {
  const w = createWorld({ seed: 53 });
  const [req, exe] = await w.pool(['req', 'exe'], { exe: { slots: 1 } });
  // The requester grants the claim and drops out of reach before it hands over the key.
  let cut = false;
  w.net.tap(({ from, kind }) => {
    if (cut || from !== 'exe' || kind !== 'key') return;
    cut = true;
    w.net.cut('req', 'exe');
  });
  const { taskId } = await req.node.offer(offerArgs('pr-1'));
  await w.net.until(() => cut, { stepMs: 5, what: 'the first ask for the key' });
  await w.run(2);
  // Its operator takes the offer back and makes it again, with another prompt.
  await req.node.withdraw({ taskId, reason: 'the wrong prompt' });
  await req.node.offer({ ...offerArgs('pr-1'), prompt: 'the second prompt' });
  const first = w.claim(req, taskId);
  assert.deepEqual([first.state, first.gen, w.task(req, taskId).state], ['held', 0, 'available'], 'the claim of the first offer is a record, and the task is free');
  w.net.heal();
  // The offer it gave up on is the first: the second it goes for at once.
  await w.net.until(() => exe.executor.jobOf(taskId), { maxMs: 90 * 1000, what: 'a job under a claim of the second offer' });
  const job = exe.executor.jobOf(taskId);
  assert.equal(job.spec.prompt, 'the second prompt');
  const second = w.claim(req, taskId);
  assert.deepEqual([second.gen, second.state, second.round === first.round], [1, 'held', false], 'its next claim of the task');
  assert.equal(w.stored(exe, 'runs').runs[w.runOf(exe, taskId).runId].round, second.round);
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
  w.net.tap(({ from, kind }) => {
    if (cut || from !== 'exe' || kind !== 'key') return;
    cut = true;
    w.net.cut('req', 'exe');
  });
  const { taskId } = await req.node.offer(offerArgs('pr-1'));
  await w.net.until(() => cut, { stepMs: 5, what: 'the first ask for the key' });
  await w.run(2);
  assert.equal(w.claim(req, taskId).state, 'held', 'the requester holds the claim of the first offer');
  // Its executor dies holding it.
  w.net.kill('exe');
  await req.node.withdraw({ taskId, reason: 'the wrong prompt' });
  await req.node.offer({ ...offerArgs('pr-1'), prompt: 'the second prompt' });
  w.net.heal();
  await w.run(LEASE_SECS + 900);
  assert.deepEqual([w.task(req, taskId).state, w.offerRow(req, taskId).attempt], ['available', 1]);
});

await check('what a task has used belongs to the task: every key issued for it carries on from the last, and a restart forgets none of it', async () => {
  const w = createWorld({ seed: 61 });
  const all = await w.pool(['req', 'e1', 'e2'], { e1: { slots: 1 } });
  const [req, e1, e2] = all;
  // What the requester keeps for a claim (the policies it read) is not the task's.
  const claims = [];
  const { context } = req.requester;
  req.requester.context = (asked) => {
    claims.push(asked.claim);
    return context(asked);
  };
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
  assert.equal(claims.length, 3);
  assert.ok(claims[0] && claims[1] === claims[0] && claims[2] && claims[2] !== claims[0], 'one claim, then another');

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

await check('a request is judged by the rules the catalogue gives its task now, and a task the catalogue gives none loses its key before anything is asked', async () => {
  const narrow = (rules) => rules.map((r) => ({ ...r, path: r.path.replace('/**', '/files') }));
  for (const [seed, update] of [[67, narrow], [68, () => null], [69, () => { throw new Error('broken'); }]]) {
    const w = createWorld({ seed });
    const [req, exe] = await w.pool(['req', 'exe'], { exe: { slots: 1 } });
    const { taskId } = await req.node.offer(offerArgs('pr-1'));
    await w.net.until(() => exe.executor.jobOf(taskId), { what: 'a job' });
    const job = exe.executor.jobOf(taskId);
    const get = (leaf) => forgeRequest('GET', `/repos/o/r/pr-1/${leaf}`);
    const message = (answer) => [answer.status, JSON.parse(Buffer.from(answer.body, 'base64')).message];
    assert.equal((await w.wait(job.act(get('a')))).status, 200);
    // An update changes what the catalogue gives this task.
    const { rulesFor } = req.requester;
    req.requester.rulesFor = function changed(...args) { return update(rulesFor.apply(this, args)); };
    await w.restart(req);
    const authorized = req.requester.calls.filter((c) => c.op === 'authorize').length;
    if (update === narrow) {
      assert.deepEqual(message(await w.wait(job.act(get('b')))), [403, 'no rule covers this request']);
      assert.equal((await w.wait(job.act(get('files')))).status, 200);
      assert.notEqual(w.stored(req, 'keys').issued[taskId], undefined, 'the key stands');
      continue;
    }
    // Asked by hand, so that nothing the executor does once it is denied clouds what the host did.
    const { capability: { keyId }, secret } = w.stored(exe, 'keys').held[taskId];
    const { requests } = w.offerRow(req, taskId);
    const act = (seq) => w.request(exe, req, 'act', { taskId, keyId, seq, request: get('files'), mac: actMac(unb64u(secret), { keyId, seq, request: get('files') }) });
    await w.run(1);
    assert.equal(said(await act(100)), 'denied: the task has no rules any more', `seed ${seed}`);
    assert.equal(w.stored(req, 'keys').issued[taskId], undefined, 'the key is taken back');
    assert.equal(w.offerRow(req, taskId).requests, requests, 'and the request is not counted');
    assert.equal(req.requester.calls.filter((c) => c.op === 'authorize').length, authorized, 'nothing was asked');
  }
});

await check('a key that is not there at the first ask is asked for a second later, then two, then four, and every half minute from then on', async () => {
  const w = createWorld({ seed: 59 });
  const [req, exe] = await w.pool(['req', 'exe'], { exe: { slots: 1 } });
  const asked = [];
  w.net.tap(({ from, kind }) => (from === 'exe' && kind === 'key' ? () => asked.push(w.net.ms()) : undefined));
  const rules = req.requester.rulesFor.bind(req.requester);
  const { taskId } = await req.node.offer(offerArgs('pr-1'));
  // The rules are not to be had for the first five asks.
  req.requester.rulesFor = (...args) => {
    if (asked.length < 5) throw new Error('the rules are not there yet');
    return rules(...args);
  };
  await w.net.until(() => exe.executor.jobOf(taskId), { what: 'a job' });
  const gaps = asked.slice(1).map((at, i) => Math.round((at - asked[i]) / 1000));
  assert.deepEqual(gaps, [1, 2, 4, 30, 30]);
  assert.equal(w.net.count({ from: 'exe', to: 'req', kind: 'key' }), 6);
});
