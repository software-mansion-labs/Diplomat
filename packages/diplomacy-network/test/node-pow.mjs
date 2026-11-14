// Proof of work at a whole host's door: what a burst costs its sender, what a stranger
// pays, a request sent twice, and how little a request that has not paid costs the host.

import assert from 'node:assert/strict';
import { forgeRequest } from './lib/fakes.mjs';
import { POOL, check, createWorld } from './lib/hosts.mjs';
import { unb64u } from '../src/core/canon.js';
import { actMac } from '../src/core/capability.js';
import { verifyResponse } from '../src/core/envelope.js';
import { MAX_BODY_BYTES, POW, STRANGER_BODY_BYTES } from '../src/paths.js';

const offerArgs = (item) => ({ pool: POOL, kind: 'review', item, title: `Review ${item}`, prompt: 'p' });
const [MEMBER, STRANGER] = [POW.memberBase, POW.strangerBase];

await check('a burst raises what its sender owes; the sender pays and still gets through', async () => {
  const w = createWorld({ seed: 61 });
  const [a, b] = await w.pool(['a', 'b']);
  await w.run(61);
  const sync = (effort) => w.request(a, b, 'sync', { asOf: w.net.now(), hash: w.view(a).hash }, { effort });
  const before = w.net.count({ from: 'a', to: 'b' });
  for (let i = w.net.count({ from: 'a', to: 'b', since: w.net.now() - 59 }); i < POW.memberAllow; i += 1) {
    assert.deepEqual([(await sync(MEMBER)).ok, i], [true, i], 'inside the allowance the base effort is enough');
  }
  const short = await sync(MEMBER);
  assert.deepEqual([short.ok, short.code, short.effort], [false, 'effort', 2 * MEMBER], 'past it, the same work is too little');
  assert.equal((await sync(2 * MEMBER)).ok, true);
  // The node itself is told the same, solves again and is heard.
  const sent = w.net.count({ from: 'a', to: 'b' });
  assert.ok(sent - before >= 2);
  const paid = [];
  w.net.tap(({ from, headers, body }) => from === 'a' && headers['dn-kind'] === 'push' && paid.push(JSON.parse(body.toString('utf8')).pow.effort));
  const { taskId } = await a.node.offer(offerArgs('pr-1'));
  await w.net.until(() => w.task(b, taskId), { maxMs: 1000, stepMs: 10, what: 'the offer reaching b through the raised effort' });
  assert.deepEqual(paid, [MEMBER, 2 * MEMBER], 'refused at the old price, heard at the one it was told');
  await w.run(120);
  assert.equal((await sync(MEMBER)).ok, true, 'a quiet minute later the base effort is enough again');
});

await check('a stranger owes sixteen times a member\'s work, and all strangers pay for each other', async () => {
  const w = createWorld({ seed: 62 });
  const [a] = await w.pool(['a', 'b']);
  await w.run(61);
  assert.equal(STRANGER, 16 * MEMBER);
  const m1 = w.stranger('m1');
  const m2 = w.stranger('m2');
  const hello = (from, effort) => w.request(from, a, 'hello', { member: {} }, { effort });
  const cheap = await hello(m1, MEMBER);
  assert.deepEqual([cheap.code, cheap.effort], ['effort', STRANGER]);
  for (let i = 0; i < POW.strangerAllow - 1; i += 1) assert.equal((await hello(i % 2 ? m1 : m2, STRANGER)).code, 'bad-request', 'paid for, it reaches the handler');
  const crowded = await hello(m2, STRANGER);
  assert.deepEqual([crowded.code, crowded.effort], ['effort', 2 * STRANGER], 'one stranger\'s requests raise the price for the next');
});

await check('a request delivered twice is carried out once', async () => {
  const w = createWorld({ seed: 63 });
  const [req, exe] = await w.pool(['req', 'exe'], { exe: { slots: 1 } });
  const { taskId } = await req.node.offer(offerArgs('pr-1'));
  await w.net.until(() => exe.executor.jobOf(taskId), { what: 'a job' });
  // The transport sends every request twice: the second copy is refused as a replay, so
  // its sender knows only that the answer was lost. A write is not made again; a read is.
  w.net.faults.duplicate = 1;
  const job = exe.executor.jobOf(taskId);
  const performed = () => req.requester.calls.filter((c) => c.op === 'perform').map((c) => c.path.split('/').at(-1));
  assert.equal((await w.wait(job.act(forgeRequest('POST', '/repos/o/r/pr-1/comments', { body: 'twice?' })))).status, 504);
  assert.deepEqual(performed(), ['comments'], 'carried out once, and reported as unknown');
  assert.equal((await w.wait(job.act(forgeRequest('GET', '/repos/o/r/pr-1/files')))).status, 504, 'a read is asked again, each time under a new number, until the tries run out');
  assert.deepEqual(performed(), ['comments', 'files', 'files', 'files']);
  w.net.faults.duplicate = 0;
  assert.equal((await w.wait(job.act(forgeRequest('GET', '/repos/o/r/pr-1/files')))).status, 200);
  assert.deepEqual(w.stored(req, 'keys').issued[taskId].seq, 4, 'five numbers used, none twice');
  // The very same bytes sent again are refused before they reach a handler.
  const { capability: { keyId }, secret } = w.stored(exe, 'keys').held[taskId];
  const request = forgeRequest('POST', '/repos/o/r/pr-1/comments', { body: 'once' });
  const first = await w.request(exe, req, 'act', { taskId, keyId, seq: 9, request, mac: actMac(unb64u(secret), { keyId, seq: 9, request }) });
  assert.equal(first.body.status, 200);
  const raw = await w.wait(exe.transport.request(req.pk, first.sent, { headers: { 'dn-from': exe.pk, 'dn-pool': POOL, 'dn-kind': 'act' } }));
  const second = verifyResponse(JSON.parse(raw.toString('utf8')), { request: first.request, from: req.pk });
  assert.deepEqual([second.ok, second.code], [false, 'replay']);
  assert.equal(performed().length, 6);
});

await check('a request that has not paid costs the host no signature check', async () => {
  const w = createWorld({ seed: 64 });
  const [a, b] = await w.pool(['a', 'b']);
  const body = { asOf: w.net.now(), hash: w.view(a).hash };
  const code = async (options) => (await w.request(a, b, 'sync', body, options)).response.error?.code ?? 'ok';
  const checked = async (options) => {
    const before = b.node.stats();
    const said = await code(options);
    const after = b.node.stats();
    assert.equal(after.requests - before.requests, 1);
    return [said, after.signatures - before.signatures];
  };
  const flip = (text) => (text.startsWith('A') ? `B${text.slice(1)}` : `A${text.slice(1)}`);
  assert.deepEqual(await checked({ effort: MEMBER / 2 }), ['effort', 0], 'too little work');
  assert.deepEqual(await checked({ effort: MEMBER, mangle: (r) => ({ ...r, pow: { ...r.pow, counter: flip(r.pow.counter) } }) }), ['bad-request', 0], 'work that solves nothing');
  assert.deepEqual(await checked({ effort: MEMBER, ts: w.net.now() - 3600 }), ['stale', 0], 'an old request');
  assert.deepEqual(await checked({ bytes: Buffer.from('{"v":1') }), ['bad-request', 0], 'no envelope at all');
  assert.deepEqual(await checked({ effort: MEMBER, mangle: (r) => ({ ...r, sig: flip(r.sig) }) }), ['denied', 1], 'paid for, with a bad signature');
  assert.deepEqual(await checked({ effort: MEMBER }), ['ok', 1]);
});

await check('a host reads one large body per sender at a time and four in all, and none from a stranger', async () => {
  const w = createWorld({ seed: 65 });
  const [a, ...rest] = await w.pool(['a', 'b', 'c', 'd', 'e', 'f']);
  const headers = (from, pool = POOL) => ({ 'dn-from': from.pk, 'dn-pool': pool, 'dn-kind': 'push' });
  const limit = (from, bytes, pool) => a.transport.host.limit({ ...headers(from, pool), 'content-length': String(bytes) });
  const mallory = w.stranger('mallory');
  assert.equal(limit(mallory, 2 ** 19), STRANGER_BODY_BYTES);
  assert.equal(limit(rest[0], 2 ** 19, 'github.com/acme/other'), STRANGER_BODY_BYTES, 'a member of some other pool is a stranger to this one');
  assert.equal(limit(rest[0], 2 ** 21), STRANGER_BODY_BYTES, 'more than a member may send');
  assert.deepEqual(rest.map((h) => limit(h, 2 ** 19)), [MAX_BODY_BYTES, MAX_BODY_BYTES, MAX_BODY_BYTES, MAX_BODY_BYTES, STRANGER_BODY_BYTES], 'four at once');
  assert.equal(limit(rest[0], 2 ** 19), STRANGER_BODY_BYTES, 'one per sender');
  // Refused before a byte of the body is read, whoever the headers name.
  const big = Buffer.alloc(70000, 0x20);
  await assert.rejects(w.wait(mallory.transport.request(a.pk, big, { headers: headers(mallory) })), { code: 'http-413' });
  await assert.rejects(w.wait(mallory.transport.request(a.pk, big, { headers: headers(rest[0]) })), { code: 'http-413' });
  // A place is given back when its body was served, or after a minute.
  await w.run(61);
  const pushed = await w.request(rest[4], a, 'push', { records: ['x'.repeat(100000)] });
  assert.deepEqual([pushed.ok, pushed.body.refused.length], [true, 1]);
  assert.equal(limit(rest[4], 2 ** 19), MAX_BODY_BYTES);
});
