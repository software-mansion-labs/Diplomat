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
  // a's own background requests to b count toward the allowance too.
  const recent = () => w.net.count({ from: 'a', to: 'b', since: w.net.now() - 59 });
  while (recent() < POW.memberAllow) {
    const i = recent();
    assert.deepEqual([(await sync(MEMBER)).ok, i], [true, i], 'inside the allowance the base effort is enough');
  }
  // An unpaid request is quoted the stranger price whoever sent it; a member learns its own
  // price from answers it gets as a member.
  const short = await sync(MEMBER);
  assert.deepEqual([short.ok, short.code, short.effort], [false, 'effort', STRANGER], 'past it, the same work is too little');
  const paid2 = await sync(2 * MEMBER);
  assert.deepEqual([paid2.ok, paid2.effort], [true, 2 * MEMBER]);
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
  // Every request arrives twice; the copy is refused as a replay, so the sender sees a lost
  // answer. A write is not retried, a read is.
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
  // The same bytes resent are refused before any handler.
  const { capability: { keyId }, secret } = w.stored(exe, 'keys').held[taskId];
  const request = forgeRequest('POST', '/repos/o/r/pr-1/comments', { body: 'once' });
  const first = await w.request(exe, req, 'act', { taskId, keyId, seq: 9, request, mac: actMac(unb64u(secret), { keyId, seq: 9, request }) });
  assert.equal(first.body.status, 200);
  const raw = await w.wait(exe.transport.request(req.pk, first.sent));
  const second = verifyResponse(JSON.parse(raw.toString('utf8')), { request: first.request, from: req.pk });
  assert.deepEqual([second.ok, second.code], [false, 'replay']);
  assert.equal(performed().length, 6);
});

await check('six requests with real work at a stranger\'s price and nobody\'s signature are quoted the same prices whatever key and pool they name: the host\'s own key or a member\'s, a pool it is in or not', async () => {
  const other = 'github.com/acme/other';
  const rows = [];
  for (const [pool, named] of [[POOL, 'a'], [other, 'a'], [POOL, 'b'], [POOL, 'unseen'], [other, 'b']]) {
    const w = createWorld({ seed: 63 });
    const [a, b] = await w.pool(['a', 'b']);
    await w.run(61);
    const s = w.stranger('s');
    const key = { a, b, unseen: w.stranger('unseen') }[named].pk;
    // Work for the named key, signed by the stranger.
    const forged = { id: { ...s.id, pk: key }, transport: s.transport };
    const quoted = [];
    for (let n = 0; n < 6; n += 1) {
      const answer = await w.request(forged, a, 'sync', { asOf: w.net.now(), hash: w.view(b).hash }, { effort: STRANGER, pool });
      quoted.push([answer.code, answer.detail, answer.effort].join(' | '));
    }
    rows.push(quoted);
  }
  const refusal = (effort) => `effort | the work or the signature of this request does not hold | ${effort}`;
  assert.deepEqual(rows[0], [STRANGER, STRANGER, STRANGER, STRANGER * 2, STRANGER * 2, STRANGER * 2].map(refusal));
  for (const row of rows.slice(1)) assert.deepEqual(row, rows[0]);
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
  // High enough that a flipped counter solves by chance only once in thousands.
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
  // Headers are unauthenticated: whoever they name, they buy only the stranger's cap.
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

  assert.equal(limit({ 'dn-ticket': tickets[0] }, 2 ** 19 + 1), STRANGER_BODY_BYTES, 'not for more than was reserved');
  const place = limit({ 'dn-ticket': tickets[0] }, 2 ** 19);
  assert.equal(place.bytes, 2 ** 19);
  assert.equal(limit({ 'dn-ticket': tickets[0] }, 2 ** 19), STRANGER_BODY_BYTES, 'not twice');
  assert.equal((await reserve(rest[0])).code, 'busy', 'one place per member: none while its body is read');
  assert.equal((await reserve(rest[4])).code, 'busy', 'a body being read is one of the four');
  // A place is held while its body is read, however long; an unused ticket is void after 10 s.
  await w.run(600);
  assert.equal((await reserve(rest[0])).code, 'busy');
  for (const ticket of tickets.slice(1)) assert.equal(limit({ 'dn-ticket': ticket }, 2 ** 19), STRANGER_BODY_BYTES);
  const first = (await reserve(rest[4])).body.ticket;
  await a.transport.host.handler(Buffer.alloc(STRANGER_BODY_BYTES + 1, 0x20), { headers: { 'dn-ticket': tickets[0] } });
  place.release();
  place.release();
  const second = (await reserve(rest[4])).body.ticket;
  assert.notEqual(first, second);
  assert.equal(limit({ 'dn-ticket': first }, 2 ** 19), STRANGER_BODY_BYTES);
  for (const h of rest.slice(1, 4)) assert.equal((await reserve(h)).ok, true);
  const fifth2 = await reserve(rest[0]);
  assert.deepEqual([fifth2.code, fifth2.detail], ['busy', 'no place for a large body is free'], 'a place given back is a place, not five, and its member had one until just then');
  const kept = limit({ 'dn-ticket': second }, 2 ** 19);
  assert.equal(kept.bytes, 2 ** 19, 'and takes no ticket from the one that has it');
  await a.transport.host.handler(Buffer.alloc(STRANGER_BODY_BYTES + 1, 0x20), { headers: { 'dn-ticket': second } });
  kept.release();

  // Ticketless headers every minute must take no place from a member that paid for one.
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
  // The first act arrives twice; the copy lands while the first is being carried out, and a
  // host reads one large body per sender at a time.
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
  // None of the four just had a place, so a fifth waits for the 10 s void.
  assert.deepEqual(await Promise.all(four.map(reserve)), [TICKET, TICKET, TICKET, TICKET]);
  assert.equal(await reserve(hogs[4]), NONE);
  await w.run(9);
  assert.equal(await reserve(hogs[4]), NONE);
  await w.run(2);
  // Now each just had one, so the job's host, which had none, takes a place without waiting.
  for (const key of four) assert.equal(await reserve(key), TICKET);
  assert.deepEqual(await large(), [200, true]);
  // The job took the oldest ticket (four[0]'s); the other three have left two unused each.
  await w.run(11);
  assert.deepEqual(await Promise.all(four.map(reserve)), [TICKET, UNUSED, UNUSED, UNUSED]);
  const got = [];
  let served = 0;
  for (let n = 0; n < 180; n += 1) {
    got.push((await Promise.all(hogs.map(reserve))).filter((answer) => answer === TICKET).length);
    await w.run(10);
    if (n % 9 === 8) served += (await large())[0] === 200 ? 1 : 0;
  }
  const tickets = (from, to) => got.slice(from, to).reduce((a, b) => a + b, 0);
  assert.deepEqual([served, tickets(0, 180) <= 30, tickets(90, 180) <= 5], [20, true, true], `${tickets(0, 180)} tickets, ${tickets(90, 180)} in the second half`);
  // Using a ticket resets the unused count.
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
  // Announced headers hold the place while the rest of the body is awaited.
  const place = announce(ticket);
  await w.run(30);
  assert.deepEqual([place.bytes, await reserve(puppets[0])], [100000, NONE]);
  place.release();
  assert.equal((await reserve(puppets[0])).length, 22);
  assert.equal(await reserve(evil), NONE, 'nor has the member a place while a key it seated has one');
  await w.run(11);
  // The body that never came was one ticket unused; this is the second.
  announce(await reserve(evil)).release();
  assert.equal(await reserve(evil), UNUSED);
  await w.run(56);
  assert.equal(await reserve(evil), UNUSED);
  await w.run(5);
  // Releasing a stale place again must not free the member's newer ticket.
  const later = await reserve(evil);
  place.release();
  assert.equal(announce(later).bytes, 100000);
  // Reserving again leaves the held ticket unused.
  assert.deepEqual([(await reserve(exe)).length, await reserve(exe)], [22, UNUSED]);
});

await check('inside a member\'s seats too, a key that had the place within the last minute yields its unused ticket to one that had it longer ago or never - a body being read is not interrupted - and a body no larger than a stranger may send leaves its ticket unused', async () => {
  const w = createWorld({ seed: 68 });
  const [req] = await w.pool(['req', 'exe']);
  const evil = await w.intruder('evil', req);
  const { all: [p, q], records } = w.crowd(evil, 2);
  assert.deepEqual((await w.request(evil, req, 'push', { records }, { effort: MEMBER * 4 })).body.refused, []);
  const [UNUSED, NONE] = ['the tickets this member took went unused', 'no place for a large body is free'];
  const reserve = async (from) => {
    const answer = await w.request(from, req, 'reserve', { kind: 'push', bytes: 100000 }, { effort: MEMBER * 64 });
    return answer.ok ? answer.body.ticket : answer.detail;
  };
  const announce = (ticket) => req.transport.host.limit({ 'dn-ticket': ticket, 'content-length': '100000' });
  const send = async (ticket, bytes) => {
    const place = announce(ticket);
    await req.transport.host.handler(Buffer.alloc(bytes, 0x20), { headers: { 'dn-ticket': ticket } });
    place.release();
  };
  // A key's first ticket cannot be taken; it is void after 10 s.
  const first = await reserve(evil);
  assert.equal(await reserve(p), NONE);
  await w.run(11);
  // evil just had the place, so p, which never had one, takes evil's new ticket.
  const second = await reserve(evil);
  const mine = await reserve(p);
  assert.deepEqual([first.length, second.length, mine.length], [22, 22, 22]);
  assert.equal(announce(second), STRANGER_BODY_BYTES, 'the ticket taken is good for nothing');
  assert.equal(await reserve(q), NONE, 'what a key that had no place took is its own');
  await send(mine, STRANGER_BODY_BYTES + 1);
  // Both had the place within the minute: the one that had it longer ago takes the other's ticket.
  const again = await reserve(p);
  const back = await reserve(evil);
  await w.run(1);
  assert.deepEqual([again.length, back.length, announce(again), await reserve(p)], [22, 22, STRANGER_BODY_BYTES, NONE]);
  // Announced headers hold it even against a key that never had one.
  const place = announce(back);
  assert.equal(await reserve(q), NONE);
  // A body within the stranger cap needed no ticket, so this one counts as unused (the second
  // in a row).
  await req.transport.host.handler(Buffer.alloc(STRANGER_BODY_BYTES, 0x20), { headers: { 'dn-ticket': back } });
  place.release();
  assert.equal(await reserve(evil), UNUSED);
  await w.run(59);
  assert.equal(await reserve(evil), UNUSED);
  // After a minute's rest a key counts as one that had no place.
  await w.run(2);
  assert.equal((await reserve(evil)).length, 22);
  assert.equal(await reserve(q), NONE);
  // A tie (both last had it in the same second): the holder keeps it.
  await w.run(11);
  await send(await reserve(p), STRANGER_BODY_BYTES + 1);
  const at = w.net.now();
  assert.equal((await reserve(q)).length, 22);
  assert.equal(w.net.now(), at, 'both had the place in one second');
  await w.run(11);
  assert.deepEqual([(await reserve(p)).length, await reserve(q)], [22, NONE]);
});
