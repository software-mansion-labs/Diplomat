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
  // The host's own requests to that member count like the ones made here.
  const recent = () => w.net.count({ from: 'a', to: 'b', since: w.net.now() - 59 });
  while (recent() < POW.memberAllow) {
    const i = recent();
    assert.deepEqual([(await sync(MEMBER)).ok, i], [true, i], 'inside the allowance the base effort is enough');
  }
  // A request that has not paid is told what a stranger owes, whoever sent it: what a
  // member owes is in the answers it gets as a member.
  const short = await sync(MEMBER);
  assert.deepEqual([short.ok, short.code, short.effort], [false, 'effort', STRANGER], 'past it, the same work is too little');
  const paid2 = await sync(2 * MEMBER);
  assert.deepEqual([paid2.ok, paid2.effort], [true, 2 * MEMBER]);
  // The node itself is told the same, solves again and is heard.
  const sent = w.net.count({ from: 'a', to: 'b' });
  assert.ok(sent - before >= 2);
  const paid = [];
  w.net.tap(({ from, kind, body }) => from === 'a' && kind === 'push' && paid.push(JSON.parse(body.toString('utf8')).pow.effort));
  const { taskId } = await a.node.offer(offerArgs('pr-1'));
  await w.net.until(() => w.task(b, taskId), { maxMs: 1000, stepMs: 10, what: 'the offer reaching b through the raised effort' });
  assert.deepEqual(paid, [MEMBER, STRANGER], 'refused at the old price, heard at the one it was told');
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
  for (let i = 0; i < POW.strangerAllow; i += 1) assert.equal((await hello(i % 2 ? m1 : m2, STRANGER)).code, 'not-member', 'paid for, it is looked at and refused as any outsider is');
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
  const raw = await w.wait(exe.transport.request(req.pk, first.sent));
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
  // At a price where another counter solves by chance once in thousands of times.
  assert.deepEqual(await checked({ effort: MEMBER * 2 ** 12, mangle: (r) => ({ ...r, pow: { ...r.pow, counter: flip(r.pow.counter) } }) }), ['effort', 0], 'work that solves nothing');
  assert.deepEqual(await checked({ effort: MEMBER, ts: w.net.now() - 3600 }), ['stale', 0], 'an old request');
  assert.deepEqual(await checked({ bytes: Buffer.from('{"v":1') }), ['bad-request', 0], 'no envelope at all');
  assert.deepEqual(await checked({ effort: MEMBER, mangle: (r) => ({ ...r, sig: flip(r.sig) }) }), ['effort', 1], 'paid for, with a bad signature');
  assert.deepEqual(await checked({ effort: MEMBER }), ['ok', 1]);
});

await check('a host reads a large body only for a ticket a member paid and signed for: one place per member, four in all', async () => {
  const w = createWorld({ seed: 65 });
  const [a, ...rest] = await w.pool(['a', 'b', 'c', 'd', 'e', 'f']);
  const limit = (headers, bytes) => a.transport.host.limit({ ...headers, 'content-length': String(bytes) });
  const named = (from) => ({ 'dn-from': from.pk, 'dn-pool': POOL, 'dn-kind': 'push' });
  const mallory = w.stranger('mallory');
  // Headers are words anybody can write: whoever they name, they buy the stranger's cap.
  for (const headers of [{}, named(rest[0]), named(mallory), { 'dn-ticket': 'AAAAAAAAAAAAAAAAAAAAAA' }, { 'dn-ticket': '' }]) {
    assert.equal(limit(headers, 2 ** 19), STRANGER_BODY_BYTES, JSON.stringify(headers));
  }
  const big = Buffer.alloc(70000, 0x20);
  await assert.rejects(w.wait(mallory.transport.request(a.pk, big, { headers: named(rest[0]) })), { code: 'http-413' });

  const reserve = (from, body = { kind: 'push', bytes: 2 ** 19 }, options) => w.request(from, a, 'reserve', body, options);
  assert.equal((await reserve(mallory, undefined, { effort: 2048 })).code, 'not-member', 'a stranger reserves nothing');
  for (const bad of [{}, { kind: 'push' }, { kind: 'push', bytes: STRANGER_BODY_BYTES }, { kind: 'push', bytes: MAX_BODY_BYTES + 1 },
    { kind: 'act', bytes: 5 * 2 ** 20 }, { kind: 'shutdown', bytes: 2 ** 19 }, { kind: 'push', bytes: '524288' }, { kind: 'push', bytes: 2 ** 19, more: 1 }]) {
    assert.equal((await reserve(rest[0], bad)).code, 'bad-request', JSON.stringify(bad));
  }
  assert.equal((await reserve(rest[0], { kind: 'push', bytes: MAX_BODY_BYTES })).ok, true, 'up to what a member may send');
  await w.run(61);
  const tickets = [];
  for (const h of rest.slice(0, 4)) tickets.push((await reserve(h)).body.ticket);
  assert.equal(new Set(tickets).size, 4);
  const fifth = await reserve(rest[4]);
  assert.deepEqual([fifth.code, fifth.detail], ['busy', 'no place for a large body is free'], 'four places in all');

  // A ticket is good for the size it was asked for, once.
  assert.equal(limit({ 'dn-ticket': tickets[0] }, 2 ** 19 + 1), STRANGER_BODY_BYTES, 'not for more than was reserved');
  const place = limit({ 'dn-ticket': tickets[0] }, 2 ** 19);
  assert.equal(place.bytes, 2 ** 19);
  assert.equal(limit({ 'dn-ticket': tickets[0] }, 2 ** 19), STRANGER_BODY_BYTES, 'not twice');
  assert.equal((await reserve(rest[0])).code, 'busy', 'one place per member: none while its body is read');
  assert.equal((await reserve(rest[4])).code, 'busy', 'a body being read is one of the four');
  // The place is taken for as long as the transport reads and serves the body, however
  // long that is. A ticket not used within 10 s is void, and its place free.
  await w.run(600);
  assert.equal((await reserve(rest[0])).code, 'busy');
  for (const ticket of tickets.slice(1)) assert.equal(limit({ 'dn-ticket': ticket }, 2 ** 19), STRANGER_BODY_BYTES);
  const first = (await reserve(rest[4])).body.ticket;
  await a.transport.host.handler(Buffer.from('{}'), { headers: { 'dn-ticket': tickets[0] } });
  place.release();
  place.release();
  // A member that asks again holds one ticket, the later one.
  const second = (await reserve(rest[4])).body.ticket;
  assert.notEqual(first, second);
  assert.equal(limit({ 'dn-ticket': first }, 2 ** 19), STRANGER_BODY_BYTES);
  for (const h of rest.slice(1, 4)) assert.equal((await reserve(h)).ok, true);
  const fifth2 = await reserve(rest[0]);
  assert.deepEqual([fifth2.code, fifth2.detail], ['busy', 'no place for a large body is free'], 'a place given back is a place, not five, and its member had one until just then');
  const kept = limit({ 'dn-ticket': second }, 2 ** 19);
  assert.equal(kept.bytes, 2 ** 19, 'and takes no ticket from the one that has it');
  await a.transport.host.handler(Buffer.from('{}'), { headers: { 'dn-ticket': second } });
  kept.release();

  // Words in headers repeated every minute take no place from a member that paid for one.
  await w.run(61);
  for (let minute = 0; minute < 3; minute += 1) {
    for (const h of rest.slice(0, 4)) limit({ ...named(h), 'content-length': String(2 ** 20) }, 2 ** 20);
    const { ticket } = (await reserve(rest[4], { kind: 'push', bytes: 110000 })).body;
    const pushed = await w.request(rest[4], a, 'push', { records: ['x'.repeat(100000)] }, { headers: { 'dn-ticket': ticket } });
    assert.deepEqual([pushed.ok, pushed.body.refused.length], [true, 1], 'a real 100 kB push is read and answered');
    await w.run(61);
  }
});

await check('a large request refused unread may be the second copy of one that was read: a write is not sent again', async () => {
  const w = createWorld({ seed: 66 });
  const [req, exe] = await w.pool(['req', 'exe'], { exe: { slots: 1 } });
  const { taskId } = await req.node.offer(offerArgs('pr-1'));
  await w.net.until(() => exe.executor.jobOf(taskId), { what: 'a job' });
  const job = exe.executor.jobOf(taskId);
  const perform = req.requester.perform.bind(req.requester);
  req.requester.perform = async (...args) => {
    await new Promise((resolve) => { req.clock.setTimeout(resolve, 5000); });
    return perform(...args);
  };
  // The transport sends the first request twice. The second copy arrives while the
  // first is being carried out, and a host reads one large body per sender at a time.
  let acts = 0;
  w.net.tap(({ kind }) => {
    if (kind !== 'act') return;
    acts += 1;
    w.net.faults.duplicate = acts === 1 ? 1 : 0;
  });
  const answer = await w.wait(job.act(forgeRequest('POST', '/repos/o/r/pr-1/comments', { body: 'x'.repeat(STRANGER_BODY_BYTES + 5000) })));
  await w.run(30);
  assert.equal(answer.status, 504, 'the job is told the outcome is not known');
  assert.equal(req.requester.calls.filter((c) => c.op === 'perform').length, 1, 'and the comment is posted once');
});

await check('keys that take every place for a large body and send none keep no job\'s large request out: a ticket is void 10 s on, a member that had no place for a minute takes the ticket of one that just had, and a key whose tickets go unused gets none for a minute, twice as long each time, up to an hour', async () => {
  const w = createWorld({ seed: 66 });
  const [req, exe] = await w.pool(['req', 'exe'], { exe: { slots: 1 } });
  const { all: hogs, records } = w.crowd(req, 5, 1);
  assert.deepEqual((await w.request(exe, req, 'push', { records }, { effort: POW.memberBase * 4 })).body.refused, []);
  const { taskId } = await req.node.offer(offerArgs('pr-1'));
  await w.net.until(() => exe.executor.jobOf(taskId), { what: 'the job running' });
  const job = exe.executor.jobOf(taskId);
  const large = async () => {
    const since = w.net.now();
    const { status } = await w.wait(job.act(forgeRequest('POST', '/repos/o/r/pr-1/comments', { body: 'x'.repeat(120 * 1024) })));
    return [status, w.net.now() - since < 5];
  };
  const [TICKET, UNUSED, NONE] = ['ticket', 'the tickets this member took went unused', 'no place for a large body is free'];
  const reserve = async (from) => {
    const answer = await w.request(from, req, 'reserve', { kind: 'push', bytes: 100000 }, { effort: POW.memberBase * 64 });
    return answer.ok ? TICKET : answer.detail;
  };
  const four = hogs.slice(0, 4);
  // Four keys take the four places. None of them just had one, so a fifth waits - 10 s.
  assert.deepEqual(await Promise.all(four.map(reserve)), [TICKET, TICKET, TICKET, TICKET]);
  assert.equal(await reserve(hogs[4]), NONE);
  await w.run(9);
  assert.equal(await reserve(hogs[4]), NONE);
  await w.run(2);
  // They take them again, and now each just had one: the job's host had none, and does not wait.
  for (const key of four) assert.equal(await reserve(key), TICKET);
  assert.deepEqual(await large(), [200, true]);
  // It took the oldest of the four, whose key did not leave it unused. The others did, twice.
  await w.run(11);
  assert.deepEqual(await Promise.all(four.map(reserve)), [TICKET, UNUSED, UNUSED, UNUSED]);
  // Half an hour of it, every key asking every 10 s: each of the job's requests gets through,
  // and the keys get fewer tickets all the time.
  const got = [];
  let served = 0;
  for (let n = 0; n < 180; n += 1) {
    got.push((await Promise.all(hogs.map(reserve))).filter((answer) => answer === TICKET).length);
    await w.run(10);
    if (n % 9 === 8) served += (await large())[0] === 200 ? 1 : 0;
  }
  const tickets = (from, to) => got.slice(from, to).reduce((a, b) => a + b, 0);
  assert.deepEqual([served, tickets(0, 180) <= 30, tickets(90, 180) <= 5], [20, true, true], `${tickets(0, 180)} tickets, ${tickets(90, 180)} in the second half`);
  // A key that uses its ticket begins again at none unused. The first unused costs nothing,
  // the second a minute, and so on up to an hour.
  await w.run(3601);
  const [key] = hogs;
  const { ticket } = (await w.request(key, req, 'reserve', { kind: 'push', bytes: 110000 }, { effort: POW.memberBase * 64 })).body;
  assert.equal((await w.request(key, req, 'push', { records: ['x'.repeat(100000)] }, { headers: { 'dn-ticket': ticket }, effort: POW.memberBase * 64 })).ok, true);
  assert.equal(await reserve(key), TICKET);
  await w.run(11);
  for (const wait of [60, 120, 240, 480, 960, 1920, 3600, 3600]) {
    assert.equal(await reserve(key), TICKET, `before the wait of ${wait} s`);
    await w.run(wait - 4);
    assert.equal(await reserve(key), UNUSED, `${wait} s`);
    await w.run(16);
  }
});

await check('a member and the keys in its seats have one place for a large body between them, and a body announced that never comes whole is a ticket unused', async () => {
  const w = createWorld({ seed: 67 });
  const [req, exe] = await w.pool(['req', 'exe']);
  const evil = await w.intruder('evil', req);
  const { all: puppets, records } = w.crowd(evil, 3);
  assert.deepEqual((await w.request(evil, req, 'push', { records }, { effort: MEMBER * 4 })).body.refused, []);
  const [UNUSED, NONE] = ['the tickets this member took went unused', 'no place for a large body is free'];
  const reserve = async (from) => {
    const answer = await w.request(from, req, 'reserve', { kind: 'push', bytes: 100000 }, { effort: MEMBER * 64 });
    return answer.ok ? answer.body.ticket : answer.detail;
  };
  const announce = (ticket) => req.transport.host.limit({ 'dn-ticket': ticket, 'content-length': '100000' });
  const ticket = await reserve(evil);
  assert.deepEqual([await reserve(puppets[0]), await reserve(puppets[1])], [NONE, NONE], 'the place of the member that seated them is theirs');
  assert.equal((await reserve(exe)).length, 22, 'a member seated elsewhere has its own');
  // The headers of a body hold the place for as long as the transport waits for the rest.
  const place = announce(ticket);
  await w.run(30);
  assert.deepEqual([place.bytes, await reserve(puppets[0])], [100000, NONE]);
  place.release();
  assert.equal((await reserve(puppets[0])).length, 22);
  assert.equal(await reserve(evil), NONE, 'nor has the member a place while a key it seated has one');
  await w.run(11);
  // The body that never came was the member's first ticket wasted, and the next is its second.
  announce(await reserve(evil)).release();
  assert.equal(await reserve(evil), UNUSED);
  await w.run(56);
  assert.equal(await reserve(evil), UNUSED);
  await w.run(5);
  // A place is given back once: what its member reserved since is its own.
  const later = await reserve(evil);
  place.release();
  assert.equal(announce(later).bytes, 100000);
  // A member that reserves again left the ticket it had unused.
  assert.deepEqual([(await reserve(exe)).length, await reserve(exe)], [22, UNUSED]);
});
