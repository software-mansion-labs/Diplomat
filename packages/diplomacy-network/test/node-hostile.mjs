// A member that means harm, and bytes that mean nothing: every request here is built by
// hand with a member's real key. Whatever arrives, the host answers with a signed
// response, holds the state it held, and goes on serving the others.

import assert from 'node:assert/strict';
import { POOL, check, createWorld } from './lib/hosts.mjs';
import { b64u, hash } from '../src/core/canon.js';
import { buildClaim, buildGrant } from '../src/core/claims.js';
import { KINDS, buildResponse } from '../src/core/envelope.js';
import { sign, verify } from '../src/core/identity.js';
import { buildPing, extendClaim } from '../src/core/lease.js';
import { offerRecord } from '../src/core/records.js';
import { LEASE_GRACE_SECS, POW } from '../src/paths.js';

const offerArgs = (item) => ({ pool: POOL, kind: 'review', item, title: `Review ${item}`, prompt: 'p' });
const ROUND = 'AAAAAAAAAAA';

// What `to` said to a request made by hand: the refusal's code and detail, or 'ok'. A
// sender past its allowance waits a minute instead of paying more.
async function say(w, from, to, kind, body, options = {}) {
  for (;;) {
    const answer = await w.request(from, to, kind, body, options);
    assert.ok(verify(to.pk, 'dn1/res', answer.response), `${kind}: the answer is signed by the host asked`);
    const { error } = answer.response;
    if (error?.code !== 'effort' || options.effort) return { ...answer, said: error ? `${error.code}${error.detail ? `: ${error.detail}` : ''}` : 'ok' };
    await w.run(61);
  }
}

await check('every kind of request, with a body of every wrong shape, gets a signed refusal; the host never throws', async () => {
  const w = createWorld({ seed: 81 });
  const all = await w.pool(['req', 'a', 'evil']);
  const [req, a, evil] = all;
  const { taskId } = await req.node.offer(offerArgs('pr-1'));
  await w.agreed(all);
  const before = w.view(req).hash;
  const deep = JSON.parse(`${'{"a":'.repeat(60)}1${'}'.repeat(60)}`);
  const bodies = [
    {}, { taskId: 7 }, { taskId: 'x', round: 'y' }, { taskId, round: 5, asOf: -1, hash: [] }, { taskId, round: ROUND },
    { taskId: 'constructor' }, { taskId: '__proto__', round: ROUND }, { taskId: 'toString', keyId: 'hasOwnProperty', seq: 1 },
    JSON.parse('{"__proto__":{"taskId":"x"},"constructor":{"prototype":1}}'),
    { taskId, round: ROUND, outcome: 5 }, { taskId, round: ROUND, outcome: { ok: 'yes' } },
    { taskId, keyId: 1, seq: 'x', request: [], mac: {} }, { taskId, keyId: ROUND, seq: -1, request: { method: 'GET' }, mac: 'm' },
    { records: 'no' }, { records: [7, 'x', {}, [], { type: 'claim' }, { type: 'offer', pool: POOL }, { type: 'member', pk: 5 }] },
    { records: Array.from({ length: 2000 }, () => 1) }, { keys: [1, {}, 'claim/', 'offer//', 'member/x'] }, { keys: 'all' },
    { member: 'x' }, { member: {}, chain: 'x' }, { member: { type: 'member', pool: POOL, pk: evil.pk }, chain: [1, 2] },
    { ping: {} }, { ping: 5 }, { ping: { pool: POOL, taskId, executor: evil.pk, round: ROUND, n: 1, by: evil.pk, ts: 1, sig: 'x' } },
    { asOf: 'x', hash: 5 }, { asOf: 2 ** 50, hash: 'x'.repeat(43) }, { grant: {}, claim: [] }, deep,
    { taskId: `${taskId}${'x'.repeat(3000)}`, round: ROUND }, { text: 'x'.repeat(50000) },
  ];
  const seen = new Map();
  for (const kind of KINDS) {
    for (const body of bodies) {
      const { said } = await say(w, evil, req, kind, body);
      const code = said.split(':')[0];
      assert.ok(['bad-request', 'denied', 'ok'].includes(code), `${kind} ${JSON.stringify(body).slice(0, 80)} -> ${said}`);
      seen.set(`${kind} ${code}`, (seen.get(`${kind} ${code}`) ?? 0) + 1);
    }
  }
  // What a wrong body may be answered with as if it were fine: nothing was asked of the host.
  const fine = [...seen].filter(([k]) => k.endsWith(' ok')).map(([k, n]) => `${k} ${n}`);
  assert.deepEqual(fine, ['push ok 1', 'unlock ok 1'], 'a push of records none of which holds, an unlock of a lock nobody has');

  // Envelopes that are not envelopes, and ones changed after they were signed.
  const envelopes = [
    { bytes: Buffer.alloc(0) }, { bytes: Buffer.from('null') }, { bytes: Buffer.from('[]') }, { bytes: Buffer.from('"x"') },
    { bytes: Buffer.from('{}') }, { bytes: Buffer.from([0xff, 0xfe, 0x00, 0x7b]) }, { bytes: Buffer.from('{"v":1,"kind":"sync"') },
    { bytes: Buffer.from(JSON.stringify({ v: 1, kind: 'sync', pool: POOL, from: evil.pk, to: req.pk, ts: w.net.now(), body: {}, pow: {}, sig: 'x' })) },
    { mangle: (r) => ({ ...r, kind: 'shutdown' }) }, { mangle: (r) => ({ ...r, v: 2 }) }, { mangle: (r) => ({ ...r, body: null }) },
    { mangle: (r) => ({ ...r, body: { asOf: 1.5 } }) }, { mangle: (r) => ({ ...r, to: a.pk }) }, { mangle: (r) => ({ ...r, from: a.pk }) },
    { mangle: (r) => ({ ...r, pool: 7 }) }, { mangle: (r) => ({ ...r, ts: 'now' }) }, { mangle: (r) => ({ ...r, pow: 'none' }) },
    { mangle: (r) => ({ ...r, extra: true }) }, { mangle: (r) => [r] }, { mangle: ({ sig: _, ...r }) => r },
  ];
  for (const options of envelopes) {
    const { said } = await say(w, evil, req, 'sync', { asOf: w.net.now(), hash: before }, { effort: POW.memberBase * 4, ...options });
    assert.ok(['bad-request', 'denied', 'stale'].includes(said.split(':')[0]), `${options.bytes ?? options.mangle} -> ${said}`);
  }

  assert.deepEqual(req.log.filter((line) => /could not be served|step failed/.test(line)), [], 'nothing threw');
  assert.equal(w.view(req).hash, before, 'and nothing changed');
  // The host serves the others as before.
  a.slots = 1;
  a.node.admit({ slots: 1 });
  await w.net.until(() => a.executor.jobOf(taskId), { what: 'the task claimed by an honest member' });
  a.executor.end(a.executor.jobOf(taskId).runId);
  await w.net.until(() => w.offerRow(req, taskId).state === 'done', { what: 'the offer done' });
});

await check('records that do not hold are refused one by one, each for its reason, and change nothing', async () => {
  const w = createWorld({ seed: 82 });
  const all = await w.pool(['req', 'a', 'evil']);
  const [req, a, evil] = all;
  const { taskId } = await req.node.offer(offerArgs('pr-1'));
  await w.agreed(all);
  const now = w.net.now();
  const before = w.view(req).hash;
  const outsider = w.stranger('outsider');
  const mine = w.records(req).find((r) => r.type === 'offer');
  const offer = (id, more = {}) => offerRecord(id, { pool: POOL, kind: 'review', item: 'pr-9', identity: 'octocat', seq: 0, at: now, title: 't', minRequiredH: 12, createdAt: now, ...more });
  const grantOf = async (round) => (await say(w, evil, a, 'lock', { taskId, round, asOf: now, hash: before })).body.grant;
  const granted = await grantOf(ROUND);
  assert.equal(granted.executor, evil.pk);
  const claim = (fields) => buildClaim(evil.id, { pool: POOL, taskId, round: ROUND, gen: 0, hours: 12, grants: [], absent: [], now, ...fields });
  const forgedGrant = { ...granted, by: req.pk };
  // A record signed with `id`'s key whatever host it names.
  const resign = ({ sig: _, ...fields }, id, change) => ({ ...fields, ...change, sig: sign(id, 'dn1/rec', { ...fields, ...change }) });
  const cases = [
    ['an offer of another pool', offer(evil.id, { pool: 'github.com/acme/other' }), 'wrong-pool'],
    ['an offer signed by nobody the pool knows', offer(outsider.id), 'not-member'],
    ['the requester\'s offer, cancelled by another hand', { ...mine, seq: mine.seq + 1, state: 'cancelled' }, 'bad-signature'],
    ['an offer in the requester\'s name, signed by another', resign(mine, evil.id, { seq: mine.seq + 1, state: 'cancelled' }), 'bad-signature'],
    ['a claim whose grant was given for another round', claim({ round: 'BBBBBBBBBBA', grants: [granted], absent: [req.pk] }), 'bad-grant'],
    ['a claim whose grant names a member that never signed it', claim({ grants: [forgedGrant, granted].sort((x, y) => (x.by < y.by ? -1 : 1)) }), 'bad-grant'],
    ['a claim with a lease longer than its hours give', resign(claim({ grants: [granted], absent: [req.pk] }), evil.id, { leaseUntil: now + 99999 }), 'bad-lease'],
  ];
  for (const [what, record, code] of cases) {
    const { said, body } = await say(w, evil, req, 'push', { records: [record] });
    assert.deepEqual([said, body.accepted, body.refused.map((r) => r.code)], ['ok', [], [code]], what);
  }
  assert.equal(w.view(req).hash, before);
  assert.equal(w.task(req, taskId).state, 'available');
});

await check('a claim made behind every member\'s back gets no key, cannot be extended by its maker, and lapses', async () => {
  const w = createWorld({ seed: 83 });
  const all = await w.pool(['req', 'a']);
  const [req, a] = all;
  const evil = await w.intruder('evil', req);
  await w.net.until(() => w.members(a).length === 3, { what: 'the intruder a member for everyone' });
  const { taskId } = await req.node.offer(offerArgs('pr-1'));
  await w.agreed(all);
  const now = w.net.now();
  // Nobody was asked: the claim calls every other member absent, which is its maker's word alone.
  const claim = buildClaim(evil.id, { pool: POOL, taskId, round: ROUND, gen: 0, hours: 12, grants: [], absent: [req.pk, a.pk].sort(), now });
  for (const h of [req, a]) assert.equal((await say(w, evil, h, 'push', { records: [claim] })).body.accepted.length, 1);
  assert.deepEqual([w.task(req, taskId).state, w.task(req, taskId).executor], ['claimed', evil.pk]);
  assert.equal((await say(w, evil, req, 'key', { taskId, round: ROUND })).said, 'denied: another host answers for this claim');
  assert.equal(w.stored(req, 'keys')?.issued?.[taskId], undefined);
  assert.equal((await say(w, evil, req, 'act', { taskId, keyId: ROUND, seq: 0, request: { method: 'GET', path: '/x', headers: {} }, mac: ROUND })).said.split(':')[0], 'denied');
  assert.deepEqual(req.requester.calls, []);

  // Its maker cannot keep it past its first lease: only a host offering the task can ask for the next.
  await w.run(claim.leaseUntil - 300 - w.net.now());
  const forged = extendClaim(evil.id, claim, buildPing(evil.id, claim, w.net.now()), w.net.now());
  const pushed = await say(w, evil, req, 'push', { records: [forged] });
  assert.deepEqual([pushed.body.accepted, pushed.body.refused.map((r) => r.code)], [[], ['no-offer']]);
  // Nor can it end the task, or anybody else's run.
  assert.equal((await say(w, a, req, 'done', { taskId, round: ROUND, outcome: { ok: true, summary: 's', microUsd: 0, tokens: 0, runner: 'r', model: 'm' } })).said.split(':')[0], 'denied');
  assert.equal(w.offerRow(req, taskId).state, 'claimed');
  a.slots = 1;
  await w.run(claim.leaseUntil + LEASE_GRACE_SECS + 5 - w.net.now());
  await w.net.until(() => a.executor.jobOf(taskId), { what: 'an honest member taking the task once the claim lapsed' });
  const real = w.claim(req, taskId);
  assert.deepEqual([real.executor, real.gen, real.grants.map((g) => g.by), real.absent], [a.pk, 1, [req.pk], [evil.pk]]);
  assert.equal(w.offerRow(req, taskId).attempt, 2, 'what it did cost the offer: one of its attempts');
  await w.agreed(all);

  // A ping from a host that does not offer the task moves no lease.
  const ping = async (from, signer, at) => (await say(w, from, a, 'ping', { ping: buildPing(signer.id, real, at) })).said;
  assert.equal(await ping(evil, evil, real.leaseUntil - 300), 'denied: not-offering');
  assert.equal(await ping(evil, req, real.leaseUntil - 300), 'denied: not a ping for a claim of this host');
  assert.equal(await ping(req, req, real.leaseUntil - 300), 'denied: stale', 'nor does one dated far from now');
  assert.equal(w.claim(a, taskId).seq, 0);
  // A lock is its holder's to give back, nobody else's.
  const second = await req.node.offer(offerArgs('pr-2'));
  await w.agreed(all);
  const lock = (from) => say(w, from, req, 'lock', { taskId: second.taskId, round: ROUND, asOf: w.net.now(), hash: w.view(req).hash });
  assert.equal((await lock(a)).body.grant.executor, a.pk);
  assert.equal((await say(w, evil, req, 'unlock', { taskId: second.taskId, round: ROUND })).said, 'ok');
  assert.deepEqual((await lock(evil)).body, { challenge: { reason: 'locked', holder: a.pk } });
  assert.deepEqual(all.flatMap((h) => h.log.filter((line) => /could not be served|step failed/.test(line))), []);
});

await check('an answer that is signed but names another request is no answer', async () => {
  const w = createWorld({ seed: 84 });
  const all = await w.pool(['req', 'a']);
  const [req, a] = all;
  const evil = await w.intruder('evil', req);
  await w.net.until(() => w.members(a).length === 3, { what: 'the intruder a member for everyone' });
  // Whatever it is asked, it agrees and grants - in a response that answers something else.
  let answered = 0;
  evil.transport.onRequest(async (bytes) => {
    const { kind, body, from } = JSON.parse(bytes.toString('utf8'));
    answered += 1;
    const says = kind === 'lock'
      ? { grant: buildGrant(evil.id, { pool: POOL, taskId: body.taskId, executor: from, round: body.round, gen: 0, hash: body.hash, exp: body.asOf + 120 }) }
      : { hash: body.hash ?? '', accepted: [], refused: [] };
    return Buffer.from(JSON.stringify(buildResponse(evil.id, { re: b64u(hash('another request')), body: says, effort: POW.memberBase })));
  });
  const { taskId } = await req.node.offer(offerArgs('pr-1'));
  a.slots = 1;
  a.node.admit({ slots: 1 });
  await w.net.until(() => a.executor.jobOf(taskId), { what: 'the task claimed' });
  const claim = w.claim(req, taskId);
  assert.ok(answered >= 1);
  assert.deepEqual([claim.grants.map((g) => g.by), claim.absent], [[req.pk], [evil.pk]], 'its grant is in no claim: it never answered');
  assert.equal(w.view(a).members.find((m) => m.pk === evil.pk).reachable, false);
});
