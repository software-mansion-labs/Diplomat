// The requester's key: who is handed it, by which host, how often, and what a request
// under it must carry. Every request here that the executor's own node would not make
// is made by hand.

import assert from 'node:assert/strict';
import { forgeRequest } from './lib/fakes.mjs';
import { POOL, check, createWorld } from './lib/hosts.mjs';
import { unb64u } from '../src/core/canon.js';
import { actMac } from '../src/core/capability.js';
import { endClaim } from '../src/core/lease.js';

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
