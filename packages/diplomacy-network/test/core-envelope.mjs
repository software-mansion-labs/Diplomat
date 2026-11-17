// The envelopes: a request passes a target's checks only when all of them hold, each
// failure is refused at the cheapest check that sees it, and a response
// answers exactly the request it names.
// Run: node test/core-envelope.mjs

import assert from 'node:assert/strict';
import { b64u, hash } from '../src/core/canon.js';
import { CODES, KINDS, ReplayMemory, buildRequest, buildResponse, requestDigest, verifyRequest, verifyResponse } from '../src/core/envelope.js';
import { sign } from '../src/core/identity.js';
import { EffortMeter, solve } from '../src/core/pow.js';
import { MAX_ACT_BODY_BYTES, MAX_BODY_BYTES } from '../src/paths.js';
import { POOL, T0, ident } from './lib/core-fixtures.mjs';

async function check(name, fn) {
  await fn();
  console.log(`PASS ${name}`);
}

const [alice, bob, carol] = [ident(1), ident(2), ident(3)];
const params = { memberBase: 8, memberAllow: 3, memberCap: 4, strangerBase: 64, strangerAllow: 2, strangerCap: 3, windowSecs: 60 };
const solver = (c, effort) => solve(c, effort).counter;
const nonce = (n) => Buffer.alloc(16, n);

// A target (bob) that takes alice for a member of the test pool and nobody else.
function target() {
  const meter = new EffortMeter(params);
  const replay = new ReplayMemory();
  const ctx = (over = {}) => ({ self: bob.pk, now: T0, size: 500, meter, replay, isMember: (pool, pk) => pool === POOL && pk === alice.pk, ...over });
  return { meter, replay, ctx };
}

const request = (over = {}, from = alice) => buildRequest(from, {
  pool: POOL, kind: 'sync', to: bob.pk, ts: T0, body: { asOf: T0 }, nonce: nonce(1), effort: 8, ...over,
}, solver);

// The envelope with one part replaced, its work redone and its signature renewed.
function resealed(envelope, over, signer = alice) {
  const { sig: _, ...rest } = { ...envelope, ...over };
  return { ...rest, sig: sign(signer, 'dn1/req', rest) };
}

await check('a request built for a target passes every one of its checks', async () => {
  const { ctx } = target();
  const envelope = await request();
  assert.deepEqual(Object.keys(envelope).sort(), ['body', 'from', 'kind', 'pool', 'pow', 'sig', 'to', 'ts', 'v']);
  assert.equal(envelope.pow.epoch, Math.floor(T0 / 3600));
  const result = verifyRequest(envelope, ctx());
  assert.equal(result.ok, true);
  assert.equal(result.request, envelope);
  assert.equal(result.member, true);
  assert.equal(result.re, b64u(hash(envelope)));
  assert.equal(result.effort, 8);
});

await check('a request with a missing, extra or malformed member is a bad request', async () => {
  const good = await request();
  const { pow } = good;
  const broken = [
    null, undefined, 7, 'x', [], [good], Object.create(null),
    ...Object.keys(good).map((k) => { const { [k]: _, ...rest } = good; return rest; }),
    { ...good, extra: 1 },
    { ...good, v: 2 }, { ...good, v: '1' },
    { ...good, pool: 'Github.com/Acme/Widgets' }, { ...good, pool: 'acme' }, { ...good, pool: 5 },
    { ...good, kind: 'gossip' }, { ...good, kind: 5 },
    { ...good, from: good.from.slice(1) }, { ...good, from: `${good.from}A` }, { ...good, from: 5 },
    { ...good, to: 'nope' },
    { ...good, ts: 1.5 }, { ...good, ts: -1 }, { ...good, ts: `${T0}` }, { ...good, ts: 2 ** 53 },
    { ...good, body: [] }, { ...good, body: null }, { ...good, body: 'x' },
    { ...good, body: { a: 1.5 } }, { ...good, body: { a: null } }, { ...good, body: { a: [undefined] } },
    { ...good, pow: { ...pow, extra: 1 } }, { ...good, pow: { epoch: pow.epoch, nonce: pow.nonce, effort: pow.effort } },
    { ...good, pow: { ...pow, nonce: pow.nonce.slice(2) } }, { ...good, pow: { ...pow, counter: `${pow.counter}AA` } },
    { ...good, pow: { ...pow, effort: 0 } }, { ...good, pow: { ...pow, effort: 2 ** 32 } }, { ...good, pow: { ...pow, effort: 8.5 } },
    { ...good, pow: { ...pow, epoch: -1 } }, { ...good, pow: [] },
    { ...good, sig: good.sig.slice(4) }, { ...good, sig: 5 },
  ];
  let deep = { a: 1 };
  for (let i = 0; i < 20000; i++) deep = { a: deep };
  broken.push({ ...good, body: deep });
  for (const [i, envelope] of broken.entries()) {
    const { ctx } = target();
    const result = verifyRequest(envelope, ctx());
    assert.equal(result.ok, false, `case ${i}`);
    assert.equal(result.code, 'bad-request', `case ${i}`);
    assert.equal(result.effort, 64, `case ${i}`);
  }
});

await check('a request larger than the cap for its kind is a bad request', async () => {
  const { ctx } = target();
  const sync = await request();
  const act = await request({ kind: 'act', nonce: nonce(2) });
  assert.equal(verifyRequest(sync, ctx({ size: MAX_BODY_BYTES })).ok, true);
  assert.equal(verifyRequest(act, ctx({ size: MAX_ACT_BODY_BYTES })).ok, true);
  const big = target();
  assert.equal(verifyRequest(sync, big.ctx({ size: MAX_BODY_BYTES + 1 })).code, 'bad-request');
  assert.equal(verifyRequest(act, big.ctx({ size: MAX_ACT_BODY_BYTES + 1 })).code, 'bad-request');
});

await check('a request addressed to another host is refused, though its work and signature hold', async () => {
  const { ctx } = target();
  const envelope = await request({ to: carol.pk });
  const result = verifyRequest(envelope, ctx());
  assert.deepEqual([result.ok, result.code, result.detail], [false, 'bad-request', 'addressed to another host']);
  assert.equal(verifyRequest(envelope, ctx({ self: carol.pk })).ok, true);
});

await check('a request is stale more than 300 seconds from the target clock, either way', async () => {
  for (const [skew, ok] of [[300, true], [-300, true], [301, false], [-301, false]]) {
    const { ctx } = target();
    const result = verifyRequest(await request({ ts: T0 + skew }), ctx());
    assert.equal(result.ok, ok, `skew ${skew}`);
    if (!ok) assert.equal(result.code, 'stale');
  }
});

await check('a request whose epoch is not the one its ts falls in is stale', async () => {
  const { ctx } = target();
  const good = await request();
  for (const d of [-1, 1, 2]) {
    const result = verifyRequest(resealed(good, { pow: { ...good.pow, epoch: good.pow.epoch + d } }), ctx());
    assert.deepEqual([result.ok, result.code], [false, 'stale'], `epoch ${d}`);
  }
});

await check('a request with less work than its sender owes is refused, and told what a stranger owes', async () => {
  const { ctx } = target();
  const cheap = verifyRequest(await request({ effort: 7 }), ctx());
  assert.deepEqual([cheap.ok, cheap.code, cheap.effort], [false, 'effort', 64]);
  const stranger = verifyRequest(await request({ effort: 8 }, carol), ctx());
  assert.deepEqual([stranger.ok, stranger.code], [false, 'effort']);
  assert.ok(stranger.effort >= 64);
  const fresh = target();
  assert.equal(verifyRequest(await request({ effort: 64 }, carol), fresh.ctx()).ok, true);
  assert.equal(verifyRequest(await request({ effort: 4096, nonce: nonce(2) }), fresh.ctx()).ok, true);
});

await check('the effort owed doubles as accepted requests pile up, and the answer says what comes next', async () => {
  const { ctx } = target();
  const efforts = [];
  for (let i = 0; i < 7; i++) {
    const result = verifyRequest(await request({ nonce: nonce(i), effort: 64 }), ctx());
    assert.equal(result.ok, true);
    efforts.push(result.effort);
  }
  assert.deepEqual(efforts, [8, 8, 16, 16, 16, 32, 32]);
  const short = verifyRequest(await request({ nonce: nonce(8), effort: 16 }), ctx());
  assert.deepEqual([short.code, short.effort], ['effort', 64]);
  assert.equal(verifyRequest(await request({ nonce: nonce(8), effort: 32 }), ctx()).ok, true);
});

await check('a counter that does not solve the challenge is refused', async () => {
  const { ctx } = target();
  const good = await request({ effort: 4096 });
  const counter = Buffer.from(good.pow.counter, 'base64url');
  counter[7] ^= 1;
  const result = verifyRequest(resealed(good, { pow: { ...good.pow, counter: b64u(counter) } }), ctx());
  assert.deepEqual([result.ok, result.code], [false, 'effort']);
});

await check('work solved for one request does not carry over to another body, target or sender', async () => {
  const good = await request({ effort: 4096 });
  for (const over of [{ body: { asOf: T0 + 1 } }, { kind: 'pull' }, { ts: T0 + 1 }, { pool: 'github.com/acme/other' }]) {
    const { ctx } = target();
    const result = verifyRequest(resealed(good, over), ctx({ isMember: () => true }));
    assert.deepEqual([result.ok, result.code], [false, 'effort'], JSON.stringify(over));
  }
  const { ctx } = target();
  const stolen = verifyRequest(resealed(good, { from: carol.pk }, carol), ctx({ isMember: () => true }));
  assert.deepEqual([stolen.ok, stolen.code], [false, 'effort']);
});

await check('a request not signed by its sender is refused as one that has not paid', async () => {
  const good = await request();
  const forged = [resealed(good, {}, carol), { ...good, sig: b64u(Buffer.alloc(64, 1)) }];
  for (const envelope of forged) {
    const { ctx } = target();
    const result = verifyRequest(envelope, ctx());
    assert.deepEqual([result.ok, result.code], [false, 'effort']);
  }
});

await check('a request seen before is a replay, and a new nonce is not', async () => {
  const { ctx, replay } = target();
  const envelope = await request();
  assert.equal(verifyRequest(envelope, ctx()).ok, true);
  const again = verifyRequest(envelope, ctx());
  assert.deepEqual([again.ok, again.code], [false, 'replay']);
  assert.equal(verifyRequest(await request({ nonce: nonce(2) }), ctx()).ok, true);
  assert.equal(verifyRequest(await request({ nonce: nonce(1), effort: 64 }, carol), ctx()).ok, true);
  assert.equal(replay.size, 3);
});

await check('the first failing check names the refusal: to, then ts, then effort, then work, then signature, then replay', async () => {
  const far = { to: carol.pk, ts: T0 + 900, effort: 1 };
  const order = [
    [await request(far), 'bad-request'],
    [await request({ ts: T0 + 900, effort: 1 }), 'stale'],
    [resealed(await request({ effort: 1 }), {}, carol), 'effort'],
    [resealed(await request(), { body: { asOf: 0 } }, carol), 'effort'],
    [resealed(await request(), {}, carol), 'effort'],
  ];
  // A signature is the dearest check: nothing refused before it has cost the target one.
  const checked = [];
  for (const [envelope, code] of order) {
    const { ctx } = target();
    const tally = { signatures: 0 };
    assert.equal(verifyRequest(envelope, ctx({ tally })).code, code);
    checked.push(tally.signatures);
  }
  assert.deepEqual(checked, [0, 0, 0, 0, 1]);
  const { ctx } = target();
  const tally = { signatures: 0 };
  const seen = await request();
  verifyRequest(seen, ctx({ tally }));
  assert.equal(verifyRequest(seen, ctx({ tally })).code, 'replay');
  assert.equal(tally.signatures, 2);
});

await check('a request that passed its signature counts toward its sender, a replay too', async () => {
  const { ctx, meter } = target();
  const envelope = await request({ effort: 64 });
  verifyRequest(envelope, ctx());
  verifyRequest(envelope, ctx());
  verifyRequest(envelope, ctx());
  assert.equal(meter.required(alice.pk, true, T0), 16, 'two replays and the original are three requests of alice');
  assert.equal(meter.required(carol.pk, false, T0), 64);
  const strange = await request({ effort: 64 }, carol);
  verifyRequest(strange, ctx());
  verifyRequest(strange, ctx());
  assert.deepEqual([meter.required(alice.pk, true, T0), meter.required(carol.pk, false, T0)], [16, 128], 'and a stranger\'s toward the strangers');
});

await check('what a request that is not authenticated is answered says nothing of the keys and pools its target knows: one refusal and one price, the strangers\', whoever it says it is from', async () => {
  const mine = (pool, pk) => pool === POOL && [alice.pk, bob.pk].includes(pk);
  const said = (envelope) => {
    const { ctx } = target();
    const { ok, code, detail, effort } = verifyRequest(envelope, ctx({ isMember: mine }));
    return { ok, code, detail, effort };
  };
  const fixed = { ok: false, code: 'effort', detail: 'the work or the signature of this request does not hold', effort: 64 };
  // No work and no signature: a linked pool and the target's own key, a member's key, a
  // stranger's key, and a pool the target is not in.
  const blank = (from, pool) => ({ ...unsigned, from, pool });
  const unsigned = { ...(await request({ effort: 1 })), pow: { epoch: Math.floor(T0 / 3600), nonce: b64u(nonce(1)), effort: 1, counter: b64u(Buffer.alloc(8)) }, sig: b64u(Buffer.alloc(64)) };
  for (const [from, pool] of [[bob.pk, POOL], [alice.pk, POOL], [carol.pk, POOL], [bob.pk, 'github.com/acme/other']]) {
    assert.deepEqual(said(blank(from, pool)), fixed, `${from === bob.pk ? 'own' : from === alice.pk ? 'member' : 'stranger'} ${pool}`);
  }
  // Work at a member's price under a member's name, and no signature of that member.
  assert.deepEqual(said(resealed(await request(), {}, carol)), fixed);
  assert.deepEqual(said({ ...(await request()), sig: b64u(Buffer.alloc(64, 1)) }), fixed);
  // A member that paid too little is told the same: its price is in the answers it gets as a member.
  const { ctx, meter } = target();
  for (let i = 0; i < 3; i += 1) meter.count(alice.pk, true, T0);
  const short = verifyRequest(await request(), ctx({ isMember: mine }));
  assert.deepEqual([short.code, short.detail, short.effort], ['effort', fixed.detail, 64]);
  const paid = verifyRequest(await request({ effort: 16 }), ctx({ isMember: mine }));
  assert.deepEqual([paid.ok, paid.effort], [true, 16]);
  // The date and the address are refused as they are, at the same price.
  assert.deepEqual(said(await request({ ts: T0 + 900 })), { ok: false, code: 'stale', detail: 'ts is too far from this clock', effort: 64 });
  assert.deepEqual(said(await request({ to: carol.pk })), { ok: false, code: 'bad-request', detail: 'addressed to another host', effort: 64 });
});

await check('work that does not hold raises nobody\'s price, and work under a member\'s name that the member did not sign raises neither the member\'s nor the strangers\'', async () => {
  const { ctx, meter } = target();
  const prices = () => [meter.required(alice.pk, true, T0), meter.required(carol.pk, false, T0)];
  for (let i = 0; i < 20; i += 1) {
    verifyRequest(null, ctx());
    verifyRequest(await request({ to: carol.pk }), ctx());
    verifyRequest(await request({ ts: T0 + 900 }), ctx());
    verifyRequest(await request({ effort: 1 }), ctx());
    verifyRequest(await request({ effort: 1 }, carol), ctx());
    verifyRequest(resealed(await request(), { body: { asOf: 0 } }), ctx());
    verifyRequest(resealed(await request(), {}, carol), ctx());
  }
  assert.deepEqual(prices(), [8, 64]);
  // A stranger's work that holds counts toward the strangers, signed by it or not.
  const strange = await request({ effort: 64, nonce: nonce(7) }, carol);
  verifyRequest({ ...strange, sig: b64u(Buffer.alloc(64, 1)) }, ctx());
  verifyRequest({ ...strange, sig: b64u(Buffer.alloc(64, 1)) }, ctx());
  assert.deepEqual(prices(), [8, 128]);
});

await check('a pair is remembered while its epoch is acceptable and forgotten after', () => {
  const memory = new ReplayMemory();
  const epoch = Math.floor(T0 / 3600);
  assert.equal(memory.seen('a', 'n1', epoch, T0), false);
  assert.equal(memory.seen('a', 'n1', epoch, T0), true);
  assert.equal(memory.seen('b', 'n1', epoch, T0), false);
  assert.equal(memory.seen('a', 'n1', epoch + 1, T0 + 3600), true, 'one epoch on');
  assert.equal(memory.size, 2);
  assert.equal(memory.seen('c', 'n2', epoch + 2, T0 + 7200), false);
  assert.equal(memory.size, 1, 'two epochs on, the first pairs are gone');
  assert.equal(memory.seen('a', 'n1', epoch + 2, T0 + 7200), false);
});

await check('building a malformed request throws before any work is done', async () => {
  let solved = 0;
  const counting = (c, effort) => { solved += 1; return solver(c, effort); };
  const build = (over) => buildRequest(alice, { pool: POOL, kind: 'sync', to: bob.pk, ts: T0, body: {}, nonce: nonce(1), effort: 8, ...over }, counting);
  for (const over of [{ to: 'nope' }, { effort: 0 }, { nonce: Buffer.alloc(8) }, { nonce: undefined }, { body: { a: 1.5 } }, { kind: 'gossip' }, { pool: 'x' }, { ts: -1 }]) {
    await assert.rejects(build(over), TypeError, JSON.stringify(over));
  }
  assert.equal(solved, 0);
  await build({});
  assert.equal(solved, 1);
  assert.deepEqual(KINDS, ['hello', 'sync', 'pull', 'push', 'lock', 'unlock', 'ping', 'key', 'act', 'done', 'reserve']);
});

await check('a response is accepted only as the answer of that target to that request', async () => {
  const asked = await request();
  const other = await request({ nonce: nonce(2) });
  const re = requestDigest(asked);
  const response = buildResponse(bob, { re, body: { hash: 'x' }, effort: 16 });
  assert.deepEqual(verifyResponse(response, { request: asked, from: bob.pk }), { ok: true, body: { hash: 'x' }, effort: 16 });
  assert.equal(verifyResponse(response, { request: other, from: bob.pk }), null, 'another request');
  assert.equal(verifyResponse(response, { request: asked, from: carol.pk }), null, 'another target');
  assert.equal(verifyResponse(buildResponse(carol, { re, body: {}, effort: 16 }), { request: asked, from: bob.pk }), null);
  assert.equal(verifyResponse({ ...response, body: { hash: 'y' } }, { request: asked, from: bob.pk }), null, 'tampered');
  assert.equal(verifyResponse({ ...response, effort: 8 }, { request: asked, from: bob.pk }), null, 'tampered effort');
});

await check('a refusal carries its code, its detail and the effort owed next', async () => {
  const asked = await request();
  const re = requestDigest(asked);
  const refusal = buildResponse(bob, { re, error: { code: 'effort', detail: 'this request owes 32' }, effort: 32 });
  assert.deepEqual(verifyResponse(refusal, { request: asked, from: bob.pk }), { ok: false, code: 'effort', detail: 'this request owes 32', effort: 32 });
  assert.equal(refusal.body, undefined);
  const long = buildResponse(bob, { re, error: { code: 'denied', detail: 'x'.repeat(5000) }, effort: 8 });
  assert.equal(verifyResponse(long, { request: asked, from: bob.pk }).detail.length, 200);
  assert.equal(verifyResponse(buildResponse(bob, { re, error: { code: 'busy' }, effort: 8 }), { request: asked, from: bob.pk }).detail, '');
  assert.deepEqual(CODES, ['effort', 'stale', 'replay', 'not-member', 'bad-request', 'denied', 'busy']);
});

await check('a malformed response is no answer at all', async () => {
  const asked = await request();
  const re = requestDigest(asked);
  const seal = (fields) => ({ ...fields, sig: sign(bob, 'dn1/res', fields) });
  const good = { v: 1, ok: true, re, body: {}, effort: 8 };
  assert.ok(verifyResponse(seal(good), { request: asked, from: bob.pk }));
  const broken = [
    null, 5, [], { ...good },
    seal({ ...good, extra: 1 }), seal({ ...good, v: 2 }), seal({ ...good, ok: 1 }), seal({ ...good, effort: 0 }),
    seal({ ...good, body: [] }), seal({ ...good, re: 'short' }),
    seal({ ...good, error: { code: 'busy', detail: '' } }),
    seal({ v: 1, ok: true, re, effort: 8 }),
    seal({ v: 1, ok: false, re, body: {}, effort: 8 }),
    seal({ v: 1, ok: false, re, error: { code: 'made-up', detail: '' }, effort: 8 }),
    seal({ v: 1, ok: false, re, error: { code: 'busy' }, effort: 8 }),
    seal({ v: 1, ok: false, re, error: { code: 'busy', detail: '', more: 1 }, effort: 8 }),
    seal({ v: 1, ok: false, re, error: { code: 'busy', detail: 'x'.repeat(201) }, effort: 8 }),
  ];
  for (const [i, response] of broken.entries()) {
    assert.equal(verifyResponse(response, { request: asked, from: bob.pk }), null, `case ${i}`);
  }
  assert.equal(requestDigest({ a: 1.5 }), null);
});
