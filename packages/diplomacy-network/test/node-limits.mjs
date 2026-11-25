import assert from 'node:assert/strict';
import { POOL, check, createWorld } from './lib/hosts.mjs';
import { forgeRequest } from './lib/fakes.mjs';
import { canon } from '../src/core/canon.js';
import { buildResponse, requestDigest } from '../src/core/envelope.js';
import { createVoucher } from '../src/core/membership.js';
import { Pool } from '../src/core/pool.js';
import { LIMITS, memberRecord, offerRecord } from '../src/core/records.js';
import { asksFile, memoryDisk, poolFile } from '../src/node/store.js';
import { MAX_BODY_BYTES, POW, POW_HOURLY, STRANGER_BODY_BYTES } from '../src/paths.js';

const offerArgs = (item) => ({ pool: POOL, kind: 'review', item, title: `Review ${item}`, prompt: 'p' });
const ROUND = 'AAAAAAAAAAA';
const MOST = Math.max(POW.memberBase * 2 ** POW.memberCap, POW.strangerBase * 2 ** POW.strangerCap);
const { peer: HOURLY, all: HOURLY_ALL, floor: HOURLY_FLOOR } = POW_HOURLY;
const failures = (hosts) => hosts.flatMap((h) => h.log.filter((line) => /failed|could not be served/.test(line)));
const sum = (list) => list.reduce((total, n) => total + n, 0);
const refused = (answer) => [answer.ok, answer.code, answer.detail];

// Answers for a node-less member: `respond(request)` returns `{ body }` or `{ error }`, with
// the `effort` it asks for next, or a Buffer sent as it is.
function answering(member, respond) {
  member.transport.onRequest(async (bytes) => {
    const request = JSON.parse(bytes.toString('utf8'));
    const says = respond(request);
    if (Buffer.isBuffer(says)) return says;
    return canon(buildResponse(member.id, { re: requestDigest(request), effort: POW.memberBase, ...says }));
  });
}

await check('a host that left a pool tells the members it left, and dials, pushes to and solves for nobody else; an outsider is told one thing whatever the pool', async () => {
  const w = createWorld({ seed: 71 });
  const [a, b, c] = await w.pool(['a', 'b', 'c']);
  w.net.split(['a', 'b'], ['c']);
  a.node.leave({ pool: POOL });
  await w.net.until(() => w.members(b).length === 2, { what: 'the member that hears it' });
  const mallory = w.stranger('mallory');
  const to = [];
  w.net.tap(({ from, to: name, kind }) => from === 'a' && to.push(`${kind} ${name}`));
  // Bait: anything sent to mallory would be answered with a demand for the most work.
  answering(mallory, () => ({ error: { code: 'effort', detail: '' }, effort: MOST }));
  const solved = a.solved.length;
  const asked = async (host, pool) => refused(await w.request(mallory, host, 'sync', { asOf: w.net.now(), hash: w.view(b).hash }, { effort: POW.strangerBase * 4, pool }));
  for (let i = 0; i < 4; i += 1) {
    assert.deepEqual(await asked(a, POOL), [false, 'not-member', ''], 'the pool the host left');
    await w.run(20);
  }
  assert.deepEqual(await asked(a, 'github.com/acme/never-linked'), [false, 'not-member', ''], 'a pool the host never linked');
  assert.deepEqual(await asked(b, POOL), [false, 'not-member', ''], 'a pool the host is a member of');
  assert.deepEqual(await asked(b, 'github.com/acme/never-linked'), [false, 'not-member', '']);
  assert.deepEqual([to, a.solved.length - solved], [[], 0], 'the stranger is sent nothing, and nothing is solved for it');

  // c is sent the farewell once however often it asks, and once more when c, no longer
  // taking a for a member, wants a stranger's price for it.
  w.net.heal();
  for (let i = 0; i < 3; i += 1) assert.deepEqual(refused(await w.request(c, a, 'sync', { asOf: w.net.now(), hash: w.view(c).hash }, { effort: POW.strangerBase * 8 })), [false, 'not-member', '']);
  await w.net.until(() => w.members(c).length === 2, { what: 'the member that missed it hearing it' });
  await w.run(30);
  assert.deepEqual([[...new Set(to)], to.length <= 2, a.solved.length - solved], [['push c'], true, to.length]);
});

await check('a host whose repository is unlinked pays the keys it left out of the search\'s eighth of its hour, sends nothing to them again for more work, tells each of them it left once a day at most, and nothing once a month is over, however often they ask', async () => {
  const w = createWorld({ seed: 73 });
  const [a, b] = await w.pool(['a', 'b']);
  let hostile = false;
  const xs = [];
  for (let i = 0; i < 4; i += 1) {
    const x = await w.intruder(`x${i}`, a);
    answering(x, () => (hostile ? { error: { code: 'effort', detail: '' }, effort: MOST } : { body: { index: {}, accepted: [], refused: [] } }));
    xs.push(x);
  }
  await w.run(3600);
  const paid = [];
  const sent = new Map();
  w.net.tap(({ from, to, body }) => {
    if (from !== 'b' || !to?.startsWith('x')) return;
    const request = JSON.parse(body.toString('utf8'));
    paid.push([w.net.now(), request.pow.effort]);
    sent.set(to, [...(sent.get(to) ?? []), [w.net.now(), request.kind]]);
  });
  const left = w.net.now();
  b.node.setPools([]);
  hostile = true;
  // Every 10 minutes each asks b, paying whatever b demands.
  const ask = async (x) => {
    let effort = POW.strangerBase;
    for (let i = 0; i < 8; i += 1) {
      const answer = await w.request(x, b, 'sync', { asOf: w.net.now(), hash: 'x' }, { effort });
      if (answer.code !== 'effort') return;
      effort = answer.effort;
    }
  };
  for (let tick = 0; tick < 26 * 6; tick += 1) {
    for (const x of xs) await ask(x);
    await w.run(600);
  }
  const hour = Math.max(...paid.map(([at]) => sum(paid.filter(([t]) => t >= at && t < at + 3600).map(([, e]) => e))));
  assert.ok(hour <= POW_HOURLY.search, `${hour / HOURLY_ALL} of an hour's work paid them in an hour`);
  // One push on leaving, then at most one a day.
  const pushes = () => xs.map((x) => (sent.get(x.name) ?? []).map(([at, kind]) => [at - left, kind]));
  assert.deepEqual(pushes().map((list) => [list[0][0] < 60, list.length <= 2, list.every(([at, kind], i) => kind === 'push' && (i === 0 || at >= 24 * 3600))]), xs.map(() => [true, true, true]), JSON.stringify(pushes()));
  const before = pushes().flat().length;
  w.net.kill('a');
  await w.run(30 * 24 * 3600);
  for (let tick = 0; tick < 6 * 6; tick += 1) {
    for (const x of xs) await ask(x);
    await w.run(600);
  }
  assert.equal(pushes().flat().length, before, 'nothing once a month is over');
});

await check('the push of a host leaving its pool, to members that last asked it the most work, takes no more than the search\'s eighth of its hour', async () => {
  const w = createWorld({ seed: 74 });
  const [a, b] = await w.pool(['a', 'b']);
  // Once `pricey`, each demands the most work of a sender once, then never answers it again.
  let pricey = false;
  const xs = [];
  for (let i = 0; i < 4; i += 1) {
    const x = await w.intruder(`x${i}`, a);
    const asked = new Set();
    x.transport.onRequest(async (bytes) => {
      const request = JSON.parse(bytes.toString('utf8'));
      if (asked.has(request.from)) return new Promise(() => {});
      if (pricey) asked.add(request.from);
      const says = pricey ? { error: { code: 'effort', detail: '' }, effort: MOST } : { body: { index: {}, accepted: [], refused: [] }, effort: POW.memberBase };
      return canon(buildResponse(x.id, { re: requestDigest(request), ...says }));
    });
    xs.push(x);
  }
  await w.run(3600);
  pricey = true;
  await w.run(600);
  // Offline over an hour: b keeps the price and has paid nobody since.
  b.transport.host.ready = false;
  await w.run(2 * 3600);
  b.transport.host.ready = true;
  b.transport.host.watchers.forEach((fn) => fn({ state: 'ready', detail: '' }));
  const paid = [];
  w.net.tap(({ from, to, body }) => from === 'b' && to?.startsWith('x') && paid.push(JSON.parse(body.toString('utf8')).pow.effort));
  b.node.setPools([]);
  await w.run(600);
  assert.ok(paid.length > 0 && sum(paid) <= POW_HOURLY.search, `${paid.length} pushes, ${sum(paid) / HOURLY_ALL} of an hour's work`);
});

await check('a host pays a peer no more than an honest target can ask, asks no more of one that asks for more, and works for one peer no more in an hour than it says', async () => {
  const w = createWorld({ seed: 72 });
  const [a] = await w.pool(['a']);
  await w.net.until(() => a.transport.host.ready, { what: 'its transport' });
  const greedy = await w.intruder('greedy', a);
  let demand = MOST * 2;
  const got = [];
  answering(greedy, (request) => {
    got.push({ ms: w.net.ms(), effort: request.pow.effort });
    return { error: { code: 'effort', detail: '' }, effort: demand };
  });
  await w.run(600);
  assert.ok(got.length >= 3, 'the peer was asked');
  assert.equal(Math.max(...a.solved), MOST, 'paid the most an honest target asks, and no more');
  assert.equal(got.findIndex((g, i) => i > 0 && g.ms - got[i - 1].ms < 1000), -1, 'what it was refused it did not send again at once');

  demand = MOST;
  await w.run(3600);
  const paid = [];
  let from = w.net.ms();
  for (let hour = 0; hour < 3; hour += 1) {
    got.length = 0;
    await w.run(3600);
    paid.push(sum(got.filter((g) => g.ms > from).map((g) => g.effort)));
    from = w.net.ms();
  }
  assert.deepEqual(paid.map((n) => n <= HOURLY && n > HOURLY - MOST), [true, true, true], `paid ${paid} an hour, of ${HOURLY}`);
  assert.deepEqual(failures([a]), []);
});

await check('a host works for all its peers together no more in an hour than it says, however many ask for the most; a member it has known for an hour it asks all the same, and one that priced itself out it waits for no longer than for a silent one', async () => {
  const w = createWorld({ seed: 75 });
  const [a, b] = await w.pool(['a', 'b']);
  await w.run(3700);
  const { all, records } = w.crowd(a, 12, 1);
  for (const m of all) answering(m, () => ({ error: { code: 'effort', detail: '' }, effort: MOST }));
  assert.deepEqual((await w.request(b, a, 'push', { records }, { effort: POW.memberBase * 4 })).body.refused, []);
  await w.run(3600);
  const paid = [];
  for (let hour = 0; hour < 2; hour += 1) {
    const from = a.solved.length;
    const since = w.net.now();
    await w.run(3600);
    paid.push(sum(a.solved.slice(from)));
    assert.ok(w.net.count({ from: 'a', to: 'b', kind: 'sync', since }) >= 30, 'the member it knows is asked through the hour');
  }
  assert.deepEqual(paid.map((n) => n <= HOURLY_ALL + HOURLY_FLOOR && n > HOURLY_ALL - MOST), [true, true], `paid ${paid} an hour, of ${HOURLY_ALL}`);
  const since = w.net.now();
  const { taskId } = await a.node.offer({ ...offerArgs('pr-1'), now: true });
  await w.net.until(() => a.executor.jobOf(taskId), { what: 'its own task claimed' });
  const claim = w.claim(a, taskId);
  assert.deepEqual([w.net.now() - since < 40, claim.grants.map((g) => g.by), claim.absent.length], [true, [b.pk], 12]);
  assert.deepEqual(failures([a]), []);
});

await check('a host pays the hosts it asks that it holds no member record of out of the work it does for all its peers: past it, none of them is paid', async () => {
  const w = createWorld({ seed: 77 });
  const [a, b] = await w.pool(['a', 'b']);
  // Each asks twice what it was paid, a price inside the floor of a member known for an hour.
  const keys = Array.from({ length: 200 }, (_, i) => w.stranger(`k${i}`)).map((s) => {
    answering(s, (request) => ({ error: { code: 'effort', detail: '' }, effort: request.pow.effort * 2 }));
    return s.pk;
  });
  w.net.kill('a');
  a.disk.write(asksFile(POOL), JSON.stringify({ back: keys.map((pk) => ({ pk, from: w.heard(a)?.online ?? 0 })), former: [] }));
  await w.restart(a);
  const paid = [];
  w.net.tap(({ from, body }) => {
    if (from === 'a') paid.push([w.net.now(), JSON.parse(body.toString('utf8')).pow.effort]);
  });
  await w.run(4 * 3600);
  // b is the one member a has known for an hour, hence the floor.
  const hour = Math.max(...paid.map(([at]) => sum(paid.filter(([t]) => t >= at && t < at + 3600).map(([, e]) => e))));
  assert.ok(hour <= HOURLY_ALL + HOURLY_FLOOR, `paid ${hour} in an hour, of ${HOURLY_ALL}`);
});

await check('a member that asks for more work whatever it is paid stops a round like one that does not grant, until this host has done for it what it does for one peer in an hour: then the round goes on without it', async () => {
  const w = createWorld({ seed: 76 });
  const [a, b] = await w.pool(['a', 'b']);
  const { all, records } = w.crowd(a, 2, 1);
  // Until `most`, each asks a little more than it was paid: present, but never granting.
  let most = false;
  for (const m of all) answering(m, (request) => ({ error: { code: 'effort', detail: '' }, effort: most ? MOST : request.pow.effort + POW.memberBase }));
  assert.deepEqual((await w.request(b, a, 'push', { records }, { effort: POW.memberBase * 4 })).body.refused, []);
  const { taskId } = await a.node.offer({ ...offerArgs('pr-1'), now: true });
  await w.run(100);
  assert.equal(Boolean(a.executor.jobOf(taskId)), false, 'the round waits on a member that answers');
  most = true;
  const since = w.net.now();
  await w.net.until(() => a.executor.jobOf(taskId), { what: 'its own task claimed' });
  const claim = w.claim(a, taskId);
  assert.deepEqual([w.net.now() - since < 200, claim.grants.map((g) => g.by), claim.absent], [true, [b.pk], all.map((m) => m.pk).sort()], `claimed after ${w.net.now() - since} s`);
});

await check('a pool holds 241 members, 15 under each of the first 16: the next has no seat, no invite is made, and a host among 240 that never answer still claims', async () => {
  const w = createWorld({ seed: 73 });
  const [a] = await w.pool(['a']);
  await w.net.until(() => a.transport.host.ready, { what: 'its transport' });
  const now = w.net.now();
  const { all, records } = w.crowd(a, LIMITS.members - 1);
  const [evil] = all;
  assert.equal((await w.request(evil, a, 'hello', { member: records[0] }, { effort: POW.strangerBase })).ok, true);
  const push = async (pushed) => (await w.request(evil, a, 'push', { records: pushed }, { effort: POW.memberBase * 4 })).body;
  for (let i = 1; i < records.length; i += 32) assert.deepEqual((await push(records.slice(i, i + 32))).refused, []);
  assert.equal(w.members(a).length, LIMITS.members);
  // No seat under a member two vouchers from the first, nor in a held seat by a voucher older
  // than its holder's.
  const puppet = (by, seat, at) => {
    const id = w.stranger('puppet');
    return memberRecord(id.id, { pool: POOL, seq: 0, at: now, era: 0, maxAcceptedH: 12, voucher: createVoucher(by, { pool: POOL, era: 0, pk: id.pk, seat, at }) });
  };
  assert.deepEqual((await push([puppet(all[20].id, 0, now), puppet(evil.id, 3, now - 1), puppet(a.id, 3, now - 1)])).refused.map((r) => r.code), ['no-seat', 'no-seat', 'no-seat']);
  const late = w.stranger('late');
  const lates = memberRecord(late.id, { pool: POOL, seq: 0, at: now, era: 0, maxAcceptedH: 12, voucher: createVoucher(evil.id, { pool: POOL, era: 0, pk: late.pk, seat: 3, at: now - 1 }) });
  assert.deepEqual(refused(await w.request(late, a, 'hello', { member: lates }, { effort: POW.strangerBase * 4 })), [false, 'denied', 'no-seat']);
  assert.equal(w.members(a).length, LIMITS.members);
  assert.throws(() => a.node.invite({ pool: POOL }), /Every one of the 15 machines this one may invite/);
  // A claim naming 240 absent members still fits a record.
  const { taskId } = await a.node.offer({ ...offerArgs('pr-1'), now: true });
  await w.net.until(() => a.executor.jobOf(taskId), { what: 'its own task claimed' });
  assert.equal(w.claim(a, taskId).absent.length, LIMITS.members - 1);
  assert.deepEqual(failures([a]), []);
});

await check('one member has 64 offers live in a pool, the same ones on every host, and a host makes no offer of its own past them', async () => {
  const w = createWorld({ seed: 74 });
  const all = await w.pool(['a', 'b']);
  const [a, b] = all;
  const evil = await w.intruder('evil', a);
  await w.net.until(() => all.every((h) => w.members(h).length === 3), { what: 'the intruder a member for everyone' });
  const now = w.net.now();
  const offers = Array.from({ length: 200 }, (_, i) => offerRecord(evil.id, {
    pool: POOL, kind: 'review', item: `pr-${String(i).padStart(3, '0')}`, identity: 'octocat', seq: 0, at: now, title: 'x'.repeat(300), minRequiredH: 12, createdAt: now,
  }));
  const push = async (to, records) => {
    for (let i = 0; i < records.length; i += 50) await w.request(evil, to, 'push', { records: records.slice(i, i + 50) }, { effort: POW.memberBase * 4 });
  };
  await push(a, offers);
  await push(b, offers.toReversed());
  const held = (h) => w.records(h).filter((r) => r.type === 'offer' && r.host === evil.pk).map((r) => r.item).sort();
  assert.deepEqual(held(a), offers.slice(0, LIMITS.offers).map((r) => r.item), 'the first 64 by key');
  assert.deepEqual(held(b), held(a));
  await w.agreed(all);
  const again = await w.request(evil, a, 'push', { records: [offers[150]] });
  assert.deepEqual(again.body.refused.map((r) => r.code), ['quota']);
  assert.ok(a.disk.read(poolFile(POOL)).length + (a.disk.appended(poolFile(POOL)) ?? '').length < 128 * 2 ** 10, 'what the store holds of the pool stays small');

  for (let i = 0; i < LIMITS.offers; i += 1) await a.node.offer(offerArgs(`pr-a${i}`));
  await assert.rejects(a.node.offer(offerArgs('pr-one-more')), /as many offers and claims in the pool .* as one member may/);
  await w.agreed(all);
  assert.equal(w.view(b).tasks.length, 2 * LIMITS.offers);
  await a.node.withdraw({ taskId: w.offerRow(a, a.node.snapshot().offers[0].taskId).taskId, reason: 'done with' });
  await w.run(1);
  assert.deepEqual(failures(all), []);
});

await check("a member's push costs a host's disk the length of what it brought: the pool's document is written whole once its log is as long as it, a request that changes nothing writes nothing of the pool, and a host that starts again holds every record", async () => {
  const w = createWorld({ seed: 75, audit: true });
  const real = memoryDisk();
  const did = { whole: 0, wholeBytes: 0, lines: 0, lineBytes: 0, others: new Set() };
  const disk = {
    ...real,
    write(name, text) {
      if (name === poolFile(POOL)) Object.assign(did, { whole: did.whole + 1, wholeBytes: did.wholeBytes + text.length });
      else did.others.add(name);
      real.write(name, text);
    },
    append(name, text) {
      Object.assign(did, { lines: did.lines + 1, lineBytes: did.lineBytes + text.length });
      real.append(name, text);
    },
  };
  const a = w.add('a');
  const h = w.add('h', { disk });
  for (const host of [a, h]) await w.start(host);
  await h.node.join(a.node.invite({ pool: POOL }));
  await w.net.until(() => w.members(a).length === 2 && w.members(h).length === 2, { what: 'two members' });
  const evil = await w.intruder('evil', a);
  await w.net.until(() => w.members(h).length === 3, { what: 'the intruder a member for the host' });
  const now = w.net.now();
  const push = async (records) => {
    const answer = await w.request(evil, h, 'push', { records }, { effort: MOST });
    assert.deepEqual([answer.ok, answer.body?.refused], [true, []]);
  };
  await push(Array.from({ length: 60 }, (_, i) => offerRecord(evil.id, {
    pool: POOL, kind: 'review', item: `pr-${i}`, identity: 'octocat', seq: 0, at: now, title: 'x'.repeat(300), minRequiredH: 12, createdAt: now,
  })));
  Object.assign(did, { whole: 0, wholeBytes: 0, lines: 0, lineBytes: 0, others: new Set() });
  const versions = 400;
  for (let seq = 1; seq <= versions; seq += 1) await push([memberRecord(evil.id, { ...evil.member, seq, at: now })]);
  assert.equal(did.lines + did.whole, versions, 'each push is on disk when it is answered');
  assert.ok(did.lineBytes < versions * 700, `${did.lineBytes} bytes of lines`);
  const length = real.read(poolFile(POOL)).length;
  assert.ok(length > 2 ** 15 && length < 2 ** 16, `a document of ${length} bytes`);
  assert.ok(did.whole >= 2 && did.whole <= did.lineBytes / 2 ** 16 + 1, `whole ${did.whole} times for ${did.lineBytes} bytes of lines: once for every 64 KiB of them`);
  assert.deepEqual([...did.others].filter((name) => name !== 'heard'), [], 'and no other document of the host is written for it');

  const before = did.lines + did.whole;
  const hello = await w.request(evil, h, 'hello', { member: memberRecord(evil.id, { ...evil.member, seq: versions, at: now }) }, { effort: MOST });
  assert.deepEqual([hello.ok, did.lines + did.whole], [true, before]);

  // Killed the moment the last push was answered, with a down too: h restarts from its disk alone.
  const held = w.view(h);
  w.net.kill('a');
  w.net.kill('h');
  const written = did.lines + did.whole;
  await w.restart(h);
  assert.deepEqual([w.view(h).hash, w.view(h).tasks.length, w.members(h)], [held.hash, 60, held.members.map((m) => m.pk).sort()]);
  assert.equal(w.records(h).find((r) => r.type === 'member' && r.pk === evil.pk).seq, versions);
  assert.equal(did.lines + did.whole, written, 'and writes nothing of a pool it holds as its store does');
  // A day on, the records have run out: the first change writes the document without them.
  w.net.kill('h');
  await w.run(25 * 3600);
  await w.restart(h);
  await w.run(5);
  assert.deepEqual([w.view(h).tasks.length, w.records(h).filter((r) => r.type === 'offer').length], [0, 0]);
});

await check('a host with 64 claims of its own in a pool goes for no more there', async () => {
  const w = createWorld({ seed: 81 });
  const all = await w.pool(['req', 'other', 'exe']);
  const [req, other, exe] = all;
  exe.slots = 100;
  exe.node.admit({ slots: 100 });
  const tasks = [];
  for (let i = 0; i < LIMITS.claims; i += 1) tasks.push((await req.node.offer(offerArgs(`pr-${i}`))).taskId);
  await w.net.until(() => tasks.every((taskId) => exe.executor.jobOf(taskId)), { maxMs: 30 * 60 * 1000, what: 'every task run' });
  const locks = w.net.count({ from: 'exe', kind: 'lock' });
  const extra = await other.node.offer(offerArgs('pr-extra'));
  await w.run(180);
  assert.deepEqual([w.task(exe, extra.taskId).state, w.net.count({ from: 'exe', kind: 'lock' }) - locks], ['available', 0]);
  assert.deepEqual(exe.log.filter((line) => line.includes('stood down')), [], 'it began no round it would have to give up');
  // A job that ends frees no room: its claim record stays for a day.
  exe.executor.end(exe.executor.jobOf(tasks[0]).runId);
  await w.net.until(() => w.offerRow(req, tasks[0]).state === 'done', { what: 'an offer done' });
  await w.run(180);
  assert.equal(w.task(exe, extra.taskId).state, 'available');
  assert.deepEqual(failures(all), []);
});

await check('a claim that would not fit beside what its host has in the pool is not made: its locks are given back', async () => {
  const w = createWorld({ seed: 82 });
  const [a] = await w.pool(['a']);
  await w.net.until(() => a.transport.host.ready, { what: 'its transport' });
  const evil = await w.intruder('evil', a);
  const now = w.net.now();
  // 200 silent members: every claim lists them all as absent.
  const puppets = w.crowd(a, 200, 1).records;
  for (let i = 0; i < puppets.length; i += 40) await w.request(evil, a, 'push', { records: puppets.slice(i, i + 40) }, { effort: POW.memberBase * 4 });
  assert.equal(w.members(a).length, 202);
  const size = (record) => canon(record).length;
  const mine = () => w.records(a).filter((r) => [r.pk, r.host, r.executor].includes(a.pk));
  const dropped = () => a.log.filter((line) => line.includes('stood down: this host has as many claims in the pool as a member may')).length;
  let made = 0;
  while (dropped() === 0) {
    const { taskId } = await a.node.offer({ ...offerArgs(`pr-${made}`), now: true });
    await w.net.until(() => w.claim(a, taskId) || dropped() > 0, { maxMs: 30 * 60 * 1000, what: 'a claim made or given up' });
    made += 1;
    assert.ok(made < LIMITS.claims, 'the bytes run out before the count does');
  }
  const claims = mine().filter((r) => r.type === 'claim');
  assert.equal(claims.length, made - 1);
  const used = mine().reduce((total, r) => total + size(r), 0);
  assert.ok(used <= LIMITS.bytes - LIMITS.spare && used + size(claims[0]) > LIMITS.bytes - LIMITS.spare, `${used} bytes held, a claim is ${size(claims[0])}`);
  await w.run(5);
  assert.deepEqual([Object.values(w.stored(a, 'locks')).flat().length, a.executor.started.length], [0, made - 1]);
  assert.deepEqual(failures([a]), []);
});

await check('only the canonical bytes of a request are a request, and only the canonical bytes of an answer are an answer', async () => {
  const w = createWorld({ seed: 75 });
  const [a, b] = await w.pool(['a', 'b']);
  const sync = (bytes) => w.request(b, a, 'sync', { asOf: w.net.now(), hash: w.view(b).hash }, { bytes });
  const text = (fn) => (bytes) => Buffer.from(fn(bytes.toString('utf8')));
  const spellings = {
    'with a space': (t) => t.replace('{', '{ '),
    'indented': (t) => JSON.stringify(JSON.parse(t), null, 1),
    'a key twice': (t) => t.replace('{"body":', '{"body":{},"body":'),
    'its keys in another order': (t) => `{"v":1,${t.slice(1).replace(/,"v":1\}$/, '}')}`,
    'a whole number written as a fraction': (t) => t.replace(/"v":1\}$/, '"v":1.0}'),
    'an exponent': (t) => t.replace(/"v":1\}$/, '"v":1e0}'),
    'an escape nobody needs': (t) => t.replace('"kind":"sync"', '"kind":"s\\u0079nc"'),
  };
  assert.equal((await sync()).ok, true, 'as it is');
  for (const [what, respell] of Object.entries(spellings)) {
    let sent = null;
    const answer = await sync(text((t) => {
      sent = respell(t);
      return sent;
    }));
    assert.notEqual(sent, answer.request && canon(answer.request).toString('utf8'), `${what}: other bytes`);
    assert.deepEqual(JSON.parse(sent), JSON.parse(canon(answer.request).toString('utf8')), `${what}: the same JSON`);
    assert.equal(answer.response.error?.code, 'bad-request', what);
  }

  // The refusals above count against strangers for a minute.
  await w.run(61);
  const loose = await w.intruder('loose', a);
  answering(loose, (request) => Buffer.from(JSON.stringify(buildResponse(loose.id, {
    re: requestDigest(request), effort: POW.memberBase, body: { hash: request.body.hash ?? '', accepted: [], refused: [] },
  }), null, 1)));
  await w.run(300);
  assert.ok(w.net.count({ from: 'a', to: 'loose' }) > 0);
  assert.equal(w.view(a).members.find((m) => m.pk === loose.pk).reachable, false);
});

await check('a lock is dropped once it has run out, whatever became of its task', async () => {
  const w = createWorld({ seed: 76 });
  const [req, a] = await w.pool(['req', 'a']);
  const { taskId } = await req.node.offer(offerArgs('pr-1'));
  await w.agreed([req, a]);
  const lock = await w.request(a, req, 'lock', { taskId, round: ROUND, asOf: w.net.now(), hash: w.view(req).hash });
  assert.equal(lock.body.grant.executor, a.pk);
  const locks = () => Object.values(w.stored(req, 'locks')).flat().length;
  assert.equal(locks(), 1);
  await req.node.withdraw({ taskId, reason: 'changed' });
  await w.run(20 * 60);
  assert.equal(locks(), 0);
});

await check('what a host served before it went down it does not serve after: the same bytes are refused, to be sent again', async () => {
  const w = createWorld({ seed: 77 });
  const [a, b] = await w.pool(['a', 'b']);
  const body = () => ({ asOf: w.net.now(), hash: w.view(b).hash });
  const first = await w.request(b, a, 'sync', body());
  assert.equal(first.ok, true);
  const same = () => w.request(b, a, 'sync', body(), { bytes: first.sent });
  assert.equal((await same()).response.error.code, 'replay');
  await w.restart(a);
  const after = (await same()).response;
  assert.deepEqual([after.ok, after.error?.code, after.error?.detail], [false, 'busy', 'dated before this host last started: send it again']);
  assert.ok(w.stored(a, 'heard').ts >= first.request.ts, 'the latest request it served is on disk');
  assert.equal((await w.request(b, a, 'sync', body(), { ts: first.request.ts })).code, 'busy', 'nor another request of that second');
  await w.run(2);
  assert.equal((await w.request(b, a, 'sync', body())).ok, true, 'a request made since is served');
  await w.run(10);
  const latest = w.net.now();
  assert.equal((await w.request(b, a, 'sync', body(), { ts: latest })).ok, true);
  assert.equal((await w.request(b, a, 'sync', body(), { ts: latest - 3 })).ok, true, 'one dated before it, served after it');
  assert.ok(w.stored(a, 'heard').ts >= latest);
  await w.restart(a);
  assert.equal((await w.request(b, a, 'sync', body(), { ts: latest - 1 })).code, 'busy', 'nothing dated up to the latest is served by the next process');
  const { taskId } = await a.node.offer(offerArgs('pr-1'));
  await w.agreed([a, b]);
  assert.equal(w.view(a).members.find((m) => m.pk === b.pk).reachable, true);

  // A node told so resends once and soon - an `act` under the same seq, since it was not
  // carried out.
  b.slots = 1;
  b.node.admit({ slots: 1 });
  await w.net.until(() => b.executor.jobOf(taskId), { what: 'the job' });
  // a restarts within the second of the last request it served.
  const downAt = async () => {
    await w.net.until(() => w.net.ms() % 1000 < 100, { stepMs: 10, what: 'a second that has just begun' });
    const floor = w.net.now();
    assert.equal((await w.request(b, a, 'sync', body())).ok, true);
    await w.restart(a);
    assert.equal(w.net.now(), floor);
    return floor;
  };
  let floor = await downAt();
  const second = await b.node.offer(offerArgs('pr-2'));
  await w.run(3);
  assert.deepEqual([w.net.count({ from: 'b', to: 'a', kind: 'push', since: floor }), Boolean(w.task(a, second.taskId))], [2, true]);
  floor = await downAt();
  const act = b.node.actFor(b.executor.jobOf(taskId).runId);
  const write = (n) => w.wait(act(forgeRequest('POST', `/repos/o/r/pr-1/pack-${n}`, { pack: 'x' })));
  const performed = () => a.requester.calls.filter((c) => c.op === 'perform').length;
  const seqs = [];
  w.net.tap(({ kind, body }) => kind === 'act' && seqs.push(JSON.parse(body.toString('utf8')).body.seq));
  assert.deepEqual([(await write(1)).status, seqs, performed()], [200, [0, 0], 1]);

  // With b's clock behind, every try is dated before a's start and refused, so the job is
  // told the request was not carried out.
  await downAt();
  b.skew = -40;
  assert.deepEqual([(await write(2)).status, performed()], [503, 1]);
  assert.deepEqual(seqs.slice(2), [1, 1, 2, 2, 3, 3]);
  b.skew = 0;

  // A failure after the forge was asked may have been carried out, so that `act` is sent once.
  await w.run(2);
  const store = a.disk.write.bind(a.disk);
  a.disk.write = (...args) => {
    if (performed() === 2) {
      a.disk.write = store;
      throw new Error('the disk is full');
    }
    return store(...args);
  };
  assert.deepEqual([(await write(3)).status, performed(), seqs.length], [504, 2, 9]);
  assert.equal(a.log.filter((line) => line.includes('could not be served')).length, 1);
  assert.equal((await write(4)).status, 200);
});

await check('the second a host serves nothing up to after a start is that of the last request it served, and never one its own clock has not reached: a stranger moves it by nothing, a pool the host never linked by nothing, and a member whose clock runs ahead holds no start back', async () => {
  const w = createWorld({ seed: 86 });
  const [a, b] = await w.pool(['a', 'b']);
  const body = () => ({ asOf: w.net.now(), hash: w.view(b).hash });
  const s = w.stranger('s');
  const quiet = () => w.net.until(() => w.stored(a, 'heard').ts < w.net.now() - 1, { stepMs: 100, what: 'two seconds in which the host served nothing' });

  // The joining hellos counted as a stranger's for a minute. Requests dated as far ahead as
  // a clock may be, from outsiders, must leave the last served second as it was.
  await w.run(61);
  await quiet();
  const before = w.stored(a, 'heard').ts;
  const ahead = w.net.now() + 58;
  const member = memberRecord(s.id, { pool: POOL, seq: 0, at: w.net.now(), era: 0, maxAcceptedH: 12 });
  assert.deepEqual(refused(await w.request(s, a, 'hello', { member }, { effort: 128, ts: ahead })), [false, 'not-member', '']);
  assert.deepEqual(refused(await w.request(s, a, 'sync', body(), { effort: 128, ts: ahead })), [false, 'not-member', '']);
  assert.deepEqual(refused(await w.request(b, a, 'sync', body(), { effort: 128, pool: 'github.com/o/elsewhere', ts: ahead })), [false, 'not-member', '']);
  assert.equal(w.stored(a, 'heard').ts, before);
  await w.restart(a);
  assert.equal((await w.request(b, a, 'sync', body(), { ts: w.net.now() - 1 })).ok, true, 'served after the start');

  // A member's request dated ahead is stored under its date, but after a start the host goes
  // by its own clock.
  await quiet();
  const fast = w.net.now() + 58;
  assert.equal((await w.request(b, a, 'sync', body(), { ts: fast })).ok, true);
  assert.equal(w.stored(a, 'heard').ts, fast);
  await w.restart(a);
  const started = w.net.now();
  assert.deepEqual(refused(await w.request(b, a, 'sync', body(), { ts: started })).slice(0, 2), [false, 'busy'], 'the second of the start itself is not served');
  await w.net.until(() => w.net.now() > started, { stepMs: 10, what: 'the next second' });
  assert.deepEqual([(await w.request(b, a, 'sync', body())).ok, w.net.now() < fast], [true, true], 'served long before the date that member gave');

  await quiet();
  const hello = await w.request(s, a, 'hello', a.node.invite({ pool: POOL }), { effort: 128 });
  assert.deepEqual([hello.ok, w.stored(a, 'heard').ts], [true, hello.request.ts]);
  assert.deepEqual(failures([a, b]), []);
});

await check('a host that dies between writing its key and writing its run starts the job once, through the host the key is from', async () => {
  const w = createWorld({ seed: 78 });
  const [req, exe] = await w.pool(['req', 'exe']);
  const { taskId } = await req.node.offer(offerArgs('pr-1'));
  await w.agreed([req, exe]);
  const start = exe.executor.start.bind(exe.executor);
  exe.executor.start = (args) => {
    if (exe.transport.host.dead) throw new Error('the process is gone');
    return start(args);
  };
  exe.crashAfter = 'keys';
  exe.slots = 1;
  exe.node.admit({ slots: 1 });
  await w.net.until(() => exe.transport.host.dead, { stepMs: 5, what: 'the death' });
  assert.equal(exe.executor.started.length, 0);
  assert.ok(w.stored(exe, 'keys').held[taskId], 'the key is on disk');
  assert.equal(Object.values(w.stored(exe, 'runs').runs).find((run) => run.taskId === taskId).peer, '', 'the run is as it was before the key came');
  await w.restart(exe);
  await w.net.until(() => exe.executor.jobOf(taskId), { what: 'the job' });
  assert.deepEqual([exe.executor.started.length, exe.executor.started[0].peer, w.runOf(exe, taskId).peer], [1, req.pk, req.pk]);
});

await check('a request too large to send unasked is sent through a place the host reserved, one such request to a member at a time', async () => {
  const w = createWorld({ seed: 79 });
  const [req, exe] = await w.pool(['req', 'exe']);
  const { taskId } = await req.node.offer(offerArgs('pr-1'));
  const other = await req.node.offer(offerArgs('pr-2'));
  exe.slots = 2;
  exe.node.admit({ slots: 2 });
  await w.net.until(() => exe.executor.jobOf(taskId) && exe.executor.jobOf(other.taskId), { what: 'the jobs' });
  const sent = [];
  w.net.tap(({ from, kind, headers, body }) => {
    if (from === 'exe' && ['reserve', 'act'].includes(kind)) sent.push(`${kind}${headers['dn-ticket'] ? ' with a ticket' : ''}${body.length > STRANGER_BODY_BYTES ? ', large' : ''}`);
  });
  const act = exe.node.actFor(exe.executor.jobOf(taskId).runId);
  const small = await w.wait(act(forgeRequest('GET', '/repos/o/r/pr-1/files')));
  assert.deepEqual([small.status, sent.splice(0)], [200, ['act']], 'a small one needs none');
  // Two runs share the one place the requester keeps for this host, so they take turns.
  const pack = (n) => forgeRequest('POST', `/repos/o/r/pr-${n}/pack`, { pack: 'x'.repeat(100000) });
  const both = await w.wait(Promise.all([act(pack(1)), exe.node.actFor(exe.executor.jobOf(other.taskId).runId)(pack(2))]));
  assert.deepEqual(both.map((answer) => answer.status), [200, 200]);
  assert.deepEqual(sent, ['reserve', 'act with a ticket, large', 'reserve', 'act with a ticket, large']);
  assert.deepEqual(req.requester.calls.filter((call) => call.op === 'perform').map((call) => call.path).slice(-2), ['/repos/o/r/pr-1/pack', '/repos/o/r/pr-2/pack']);
});

await check('what the store lost of a pool the host left, and what a member answers a pull with, never throws', async () => {
  const w = createWorld({ seed: 80 });
  const [a, b] = await w.pool(['a', 'b']);
  const odd = await w.intruder('odd', a);
  const mine = new Pool({ id: POOL, self: odd.pk });
  const now = w.net.now();
  mine.merge([...w.records(a), offerRecord(odd.id, { pool: POOL, kind: 'review', item: 'pr-9', identity: 'octocat', seq: 0, at: now, title: 't', minRequiredH: 12, createdAt: now })], now);
  const junk = [[true], [7], [{ type: 'nope', pool: POOL }], [{ type: 'claim' }], 'none', [[]]];
  let pulls = 0;
  const pushed = [];
  answering(odd, (request) => {
    if (request.kind === 'sync') return mine.answerSync(request.body, w.net.now());
    if (request.kind === 'push') pushed.push(...request.body.records);
    if (request.kind !== 'pull') return { body: { accepted: [], refused: [] } };
    pulls += 1;
    return { body: { records: junk[pulls % junk.length] } };
  });
  await w.net.until(() => pulls >= 2 * junk.length, { maxMs: 60 * 60 * 1000, what: 'every answer tried' });
  assert.deepEqual(failures([a, b]), []);
  junk.splice(0, junk.length, [7]);
  w.net.cut('b', 'odd');
  const { taskId } = await b.node.offer(offerArgs('pr-1'));
  await w.net.until(() => pushed.some((r) => r.type === 'offer' && r.taskId === taskId), { maxMs: 60 * 60 * 1000, what: 'the push that follows a pull' });
  w.net.heal();

  a.node.leave({ pool: POOL });
  a.disk.remove(poolFile(POOL));
  await a.node.join({ pool: POOL });
  assert.equal(w.view(a).left, false);
  b.node.leave({ pool: POOL });
  b.disk.remove(poolFile(POOL));
  b.node.setPools([]);
  assert.deepEqual(b.node.snapshot().pools, []);
  assert.deepEqual(failures([a, b]), []);
});

await check('the largest job a host lets itself offer reaches its executor, in an answer well inside what a host takes for one, and a job one byte larger is refused where it is offered', async () => {
  const w = createWorld({ seed: 84 });
  const [req, exe] = await w.pool(['req', 'exe'], { exe: { slots: 1 } });
  let answer = 0;
  w.net.tap(({ from, kind }) => (from === 'exe' && kind === 'key' ? { reached: (out) => { answer = out.length; } } : undefined));
  // Measure what a spec comes to beside its prompt.
  const first = await req.node.offer(offerArgs('pr-1'));
  await w.net.until(() => exe.executor.jobOf(first.taskId), { what: 'a job' });
  const job = exe.executor.jobOf(first.taskId);
  const most = 512 * 2 ** 10 - (canon(job.spec).length - job.spec.prompt.length);
  exe.executor.end(job.runId, {});
  await w.net.until(() => w.offerRow(req, first.taskId).state === 'done', { what: 'the first job done' });
  await assert.rejects(req.node.offer({ ...offerArgs('pr-2'), prompt: 'x'.repeat(most + 1) }), /cannot be sent to another machine: its prompt and options are too long/);
  const { taskId } = await req.node.offer({ ...offerArgs('pr-2'), prompt: 'x'.repeat(most) });
  await w.net.until(() => exe.executor.jobOf(taskId), { what: 'the largest job' });
  assert.equal(canon(exe.executor.jobOf(taskId).spec).length, 512 * 2 ** 10);
  assert.ok(answer > 512 * 2 ** 10 && answer < 512 * 2 ** 10 + 4096 && answer < MAX_BODY_BYTES, `the answer with the key is ${answer} bytes`);
  assert.deepEqual(failures([req, exe]), []);
});
