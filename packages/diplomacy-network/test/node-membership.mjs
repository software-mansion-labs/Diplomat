import assert from 'node:assert/strict';
import { POOL, check, createWorld } from './lib/hosts.mjs';
import { b64u, canon } from '../src/core/canon.js';
import { UNSERVED, buildResponse, requestDigest } from '../src/core/envelope.js';
import { sign } from '../src/core/identity.js';
import { createInvite, createVoucher, inviteToken } from '../src/core/membership.js';
import { LIMITS, memberRecord } from '../src/core/records.js';
import { asksFile, heardFile, poolFile } from '../src/node/store.js';
import { MEMBER_RETENTION_SECS, POW, POW_HOURLY, STRANGER_BODY_BYTES } from '../src/paths.js';

const offerArgs = (item) => ({ pool: POOL, kind: 'review', item, title: `Review ${item}`, prompt: 'p' });

await check('hosts join a pool by invite and see one another; a stranger is refused whatever it sends', async () => {
  const w = createWorld({ seed: 21 });
  const [a, b, c] = await w.pool(['a', 'b', 'c']);
  await w.run(120);
  for (const h of [a, b, c]) {
    assert.deepEqual(w.members(h), [a.pk, b.pk, c.pk].sort());
    for (const m of w.view(h).members) {
      assert.deepEqual([m.self, m.maxAcceptedH, m.reachable], [m.pk === h.pk, 12, true]);
      assert.ok(m.lastSeen > 0);
    }
  }
  assert.equal(a.node.snapshot().identity.pk, a.pk);
  assert.match(a.node.snapshot().identity.onion, /^[a-z2-7]{56}\.onion$/);

  const mallory = w.stranger('mallory');
  const now = w.net.now();
  const record = (voucher) => memberRecord(mallory.id, { pool: POOL, seq: 0, at: now, era: 0, maxAcceptedH: 12, voucher });
  const alone = record();
  const selfInvited = record(createVoucher(w.stranger('friend').id, { pool: POOL, era: 0, pk: mallory.pk, seat: 0, at: now }));
  const anothers = record(w.records(a).find((r) => r.pk === b.pk).voucher);
  const old = inviteToken(createInvite(a.id, { pool: POOL, exp: now - 3600, nonce: w.net.rnd.bytes(16) }));
  const said = async (kind, body) => {
    const { ok, code, detail } = await w.request(mallory, a, kind, body, { effort: 2048 });
    return [ok, code, detail];
  };
  assert.deepEqual(await said('sync', { asOf: now, hash: w.view(a).hash }), [false, 'not-member', '']);
  assert.deepEqual(await said('push', { records: [alone] }), [false, 'not-member', '']);
  assert.deepEqual(await said('hello', { member: alone }), [false, 'not-member', '']);
  assert.deepEqual(await said('hello', { member: selfInvited }), [false, 'not-member', ''], 'a voucher from nobody the host knows');
  assert.deepEqual(await said('hello', { member: anothers }), [false, 'not-member', ''], 'a voucher a member signed for another key');
  assert.deepEqual(await said('hello', { invite: old }), [false, 'denied', 'expired'], 'an invite of the host\'s own, past its time: its holder is told why');
  assert.deepEqual(await said('hello', b.node.invite({ pool: POOL })), [false, 'not-member', ''], 'an invite another member made');
  assert.deepEqual(await said('hello', { invite: 'nonsense' }), [false, 'not-member', '']);
  assert.deepEqual((await w.request(mallory, a, 'sync', {}, { effort: 2048, pool: 'github.com/acme/other' })).code, 'not-member');
  assert.deepEqual(w.members(a), [a.pk, b.pk, c.pk].sort());

  const late = w.add('late');
  await w.start(late);
  const { invite } = a.node.invite({ pool: POOL, ttlSecs: 60 });
  await w.run(90);
  // Refusals are shown to the operator: each must say what to do.
  await assert.rejects(late.node.join({ invite }), /^Error: That invite has run out: ask for a new one\.$/);
  await assert.rejects(late.node.join({ invite: 'nonsense' }), /^Error: That is not an invite: paste the whole token the other machine made\.$/);
  const forged = createInvite(mallory.id, { pool: POOL, exp: w.net.now() + 600, nonce: Buffer.alloc(16, 7) });
  const unsigned = inviteToken({ ...forged, by: a.pk });
  await assert.rejects(late.node.join({ invite: unsigned }), /^Error: That invite is not signed by the machine it names: ask for a new one\.$/);
  const own = late.node.invite({ pool: POOL }).invite;
  await assert.rejects(late.node.join({ invite: own }), /^Error: That invite was made on this machine: it lets another machine in, not this one\.$/);
});

await check('a host refuses an invite said to be good for longer than a day, and waits on none for longer than a day from when it was pasted, after a restart too', async () => {
  const w = createWorld({ seed: 47 });
  const [a] = await w.pool(['a', 'b']);
  const day = 24 * 3600;
  const most = Math.max(POW.memberBase * 2 ** POW.memberCap, POW.strangerBase * 2 ** POW.strangerCap);
  const s = w.stranger('s');
  s.transport.onRequest(async (buf) => {
    const request = JSON.parse(buf.toString('utf8'));
    return canon(buildResponse(s.id, { re: requestDigest(request), error: { code: 'effort', detail: '' }, effort: most }));
  });
  const asked = [];
  w.net.tap(({ from, to }) => from === 'a' && to === 's' && asked.push(w.net.now()));
  const made = (secs) => inviteToken(createInvite(s.id, { pool: POOL, exp: w.net.now() + secs, nonce: w.net.rnd.bytes(16) }));
  const joinOf = () => [w.view(a).joining, w.view(a).joinFailed];
  await assert.rejects(a.node.join({ invite: made(3650 * day) }), /^Error: That invite says it is good for longer than a day, and no machine makes one for longer: ask for a new one\.$/);
  assert.deepEqual([joinOf(), asked.length], [[false, ''], 0]);
  // Made by a clock four minutes ahead: taken, but good for a day from the paste.
  let pasted = w.net.now();
  await a.node.join({ invite: made(day + 240) });
  await w.run(day - 60);
  assert.deepEqual(joinOf(), [true, '']);
  await w.run(120);
  assert.deepEqual(joinOf(), [false, 'the invite ran out before the machine that made it answered']);
  assert.ok(asked.length > 0 && asked.every((at) => at < pasted + day), 'asked within the day alone');
  // A stored join with the invite's own time, ten years on, still lasts a day from the paste.
  w.net.kill('a');
  a.disk.write(poolFile(POOL), JSON.stringify({ ...w.doc(a), joining: { invite: made(day), by: s.pk, exp: w.net.now() + 3650 * day } }));
  pasted = w.net.now();
  await w.restart(a);
  await w.run(day + 60);
  const since = asked.filter((at) => at >= pasted);
  assert.deepEqual([joinOf()[0], since.length > 0, since.every((at) => at < pasted + day)], [false, true, true]);
});

await check('a host that left a pool stays out of it, whatever its list of pools says and however often it restarts, until it joins again', async () => {
  const w = createWorld({ seed: 22 });
  const [a, b, c] = await w.pool(['a', 'b', 'c']);
  c.node.leave({ pool: POOL });
  await w.net.until(() => w.members(a).length === 2 && w.members(b).length === 2, { what: 'c gone' });
  const out = { id: POOL, path: '/repos/widgets', identity: 'Octocat', hash: '', left: true, joining: false, joinFailed: '', unseated: false, returning: false, members: [], tasks: [] };
  assert.deepEqual(w.view(c), out);
  await assert.rejects(c.node.offer(offerArgs('pr-1')), /This machine left the pool .*: join it again first\./);
  assert.throws(() => c.node.invite({ pool: POOL }), /This machine left the pool/);
  c.node.leave({ pool: POOL });
  c.node.setPools(c.pools);
  assert.deepEqual(w.view(c), out, 'named again it is left still');
  await w.restart(c);
  const since = w.net.now() + 1;
  // Longer than any invite lasts.
  await w.run(30 * 3600);
  assert.deepEqual(w.view(c), out, 'and after a restart');
  assert.equal(w.net.count({ to: 'c', since }), 0, 'nobody asks a host that left');
  assert.equal(w.net.count({ from: 'c', since }), 0, 'and it asks nobody');
  // It left by its own word, so it is back without an invite, as the member it was.
  assert.deepEqual(await c.node.join({ pool: POOL }), { pool: POOL });
  await w.net.until(() => [a, b, c].every((h) => w.members(h).length === 3), { maxMs: 10000, what: 'c back at once, with no invite' });
  await w.agreed([a, b, c]);
  assert.equal(w.view(c).left, false);
  assert.equal(w.doc(c).left, undefined, 'a member keeps no farewell');
  assert.deepEqual(w.records(c).find((r) => r.type === 'member' && r.pk === c.pk).voucher, w.records(a).find((r) => r.pk === c.pk).voucher);
  assert.equal(w.records(a).find((r) => r.pk === c.pk).voucher.by, a.pk);
  c.node.leave({ pool: POOL });
  await w.net.until(() => w.members(a).length === 2 && w.members(b).length === 2, { what: 'c gone again' });
  await w.wait(c.node.join(b.node.invite({ pool: POOL })));
  await w.net.until(() => [a, b, c].every((h) => w.members(h).length === 3), { what: 'c back by invite' });
  await w.agreed([a, b, c]);
  assert.equal(w.records(a).find((r) => r.pk === c.pk).voucher.by, b.pk);
  assert.deepEqual(await c.node.join({ pool: POOL }), { pool: POOL }, 'joining a pool it is in changes nothing');
  await assert.rejects(c.node.join({ pool: 'github.com/acme/gadgets' }), /The pool github.com\/acme\/gadgets is not linked on this machine\./);
});

await check('a newcomer is let in by a member that has never heard of its inviter: hello carries the chain', async () => {
  const w = createWorld({ seed: 23 });
  const [a, b] = await w.pool(['a', 'b']);
  w.net.split(['a'], ['b']);
  const x = w.add('x');
  const y = w.add('y');
  await w.start(x);
  await w.start(y);
  w.net.split(['a', 'x', 'y'], ['b']);
  await w.wait(x.node.join(a.node.invite({ pool: POOL })));
  await w.net.until(() => w.members(x).length === 3, { what: 'x in' });
  await w.wait(y.node.join(x.node.invite({ pool: POOL })));
  await w.net.until(() => w.members(y).length === 4, { what: 'y in' });
  assert.deepEqual(w.members(b), [a.pk, b.pk].sort(), 'b has heard of neither');
  w.net.split(['a', 'x'], ['b', 'y']);
  const since = w.net.now() + 1;
  await w.net.until(() => w.members(b).length === 4, { what: 'b knowing everyone' });
  assert.deepEqual(w.members(b), [a.pk, b.pk, x.pk, y.pk].sort());
  assert.equal(w.net.count({ from: 'y', to: 'b', kind: 'hello', since }) >= 1, true);
  await w.agreed([b, y]);
});

await check('two halves of a pool that each moved on hold one state soon after the partition heals', async () => {
  const w = createWorld({ seed: 24 });
  const all = await w.pool(['a', 'b', 'c', 'd']);
  const [a, b, c, d] = all;
  w.net.split(['a', 'b'], ['c', 'd']);
  const left = await a.node.offer(offerArgs('pr-1'));
  const right = await d.node.offer(offerArgs('pr-2'));
  await w.run(300);
  assert.deepEqual([w.task(b, left.taskId)?.state, w.task(b, right.taskId)], ['available', null]);
  assert.deepEqual([w.task(c, right.taskId)?.state, w.task(c, left.taskId)], ['available', null]);
  assert.notEqual(w.view(a).hash, w.view(d).hash);
  w.net.heal();
  await w.agreed(all, 3 * 60 * 1000);
  for (const h of all) assert.deepEqual([w.task(h, left.taskId).state, w.task(h, right.taskId).state], ['available', 'available']);
  w.net.down('c');
  const missed = await b.node.offer(offerArgs('pr-3'));
  await w.run(120);
  assert.equal(w.task(c, missed.taskId), null);
  assert.equal(w.view(a).members.find((m) => m.pk === c.pk).reachable, false);
  w.net.down('c', false);
  await w.agreed(all, 15 * 60 * 1000);
  assert.equal(w.task(c, missed.taskId).state, 'available');
  await w.net.until(() => w.view(a).members.find((m) => m.pk === c.pk).reachable, { maxMs: 15 * 60 * 1000, what: 'c reachable again' });
});

await check('a host that closed a pool while nobody could hear tells whoever still asks, and the pool goes on without it', async () => {
  const w = createWorld({ seed: 26 });
  const [a, b, c] = await w.pool(['a', 'b', 'c'], { b: { slots: 1 } });
  const sent = w.net.count({ from: 'c' });
  c.transport.host.ready = false;
  c.pools = [];
  c.node.setPools([]);
  await w.run(5);
  c.transport.host.ready = true;
  c.transport.host.watchers.forEach((fn) => fn({ state: 'ready', detail: '' }));
  assert.equal(w.net.count({ from: 'c' }), sent, 'its farewell reached nobody');
  assert.equal(w.members(a).length, 3);
  await w.net.until(() => w.members(a).length === 2 && w.members(b).length === 2, { maxMs: 3 * 60 * 1000, what: 'c gone from the pool, by its own word' });
  const { taskId } = await a.node.offer(offerArgs('pr-1'));
  await w.net.until(() => b.executor.jobOf(taskId), { maxMs: 2 * 60 * 1000, what: 'the task claimed' });
  assert.deepEqual(w.claim(a, taskId).absent, []);
});

await check('a pool unlinked and linked again is a pool of the host\'s own, and the invites it gave before let nobody in', async () => {
  const w = createWorld({ seed: 27 });
  const [a, b, c] = await w.pool(['a', 'b', 'c']);
  const before = a.node.invite({ pool: POOL });
  // Cut off, so b and c never hear it leave.
  w.net.cut('a', 'b');
  w.net.cut('a', 'c');
  a.node.leave({ pool: POOL });
  a.node.setPools([]);
  a.node.setPools(a.pools);
  await w.run(5);
  w.net.heal();
  await w.run(900);
  assert.equal(w.view(a).left, false, 'a pool it left and then unlinked is not left when it is linked again');
  assert.deepEqual([w.members(a), w.members(b), w.members(c)], [[a.pk], [b.pk, c.pk].sort(), [b.pk, c.pk].sort()]);
  const late = w.add('late');
  await w.start(late);
  await late.node.join(before);
  await w.run(120);
  assert.deepEqual(w.members(a), [a.pk]);
  assert.match(late.log.join('\n'), /the invite to .* let this host in nowhere: that invite is no longer good/);
  assert.equal(w.net.count({ from: 'late', to: 'a', kind: 'hello' }), 1, 'an invite that was refused is given up');
  const joinOf = (h) => [w.view(h).joining, w.view(h).joinFailed];
  assert.deepEqual(joinOf(late), [false, 'that invite is no longer good']);
  await w.restart(late);
  assert.deepEqual(joinOf(late), [false, 'that invite is no longer good']);
  w.net.cut('late', 'a');
  await late.node.join(a.node.invite({ pool: POOL, ttlSecs: 600 }));
  assert.deepEqual(joinOf(late), [true, ''], 'a join under way, with nothing held against it from the invite before');
  await w.run(600);
  const asked = w.net.count({ from: 'late', to: 'a', kind: 'hello' });
  await w.run(600);
  assert.deepEqual(joinOf(late), [false, 'the invite ran out before the machine that made it answered']);
  w.net.heal();
  await w.run(60);
  assert.deepEqual([asked > 2, w.net.count({ from: 'late', to: 'a', kind: 'hello' }), w.members(a)], [true, asked, [a.pk]]);
  // A newer invite does not revive the old one.
  const old = await w.request(w.stranger('old'), a, 'hello', { invite: before.invite }, { effort: 2 ** 16 });
  assert.deepEqual([old.code, old.detail, w.doc(a).invites.length], ['denied', 'that invite is no longer good', 1]);
  // Nor does a voucher it signed before it left.
  const hello = await w.request(b, a, 'hello', { member: w.records(b).find((r) => r.pk === b.pk) }, { effort: 2 ** 16 });
  assert.deepEqual([hello.code, hello.detail, w.members(a)], ['denied', 'no-seat', [a.pk]]);
  // An invite is good once given, even if its maker restarts before anyone uses it.
  const now = a.node.invite({ pool: POOL });
  await w.restart(a);
  await late.node.join(now);
  await w.net.until(() => w.members(a).length === 2, { what: 'the newcomer let in' });
  assert.deepEqual(w.members(late), [a.pk, late.pk].sort());
});

await check('gossip stays under the body any sender may send, however much there is to tell a newcomer', async () => {
  const w = createWorld({ seed: 28 });
  const [a, b] = await w.pool(['a', 'b']);
  const title = '\u00e9'.repeat(300);
  for (const h of [a, b]) {
    for (let i = 0; i < 60; i += 1) await h.node.offer({ ...offerArgs(`pr-${h.name}${i}`), title });
  }
  await w.agreed([a, b]);
  const late = w.add('late');
  await w.start(late);
  const since = w.net.now();
  await late.node.join(a.node.invite({ pool: POOL }));
  await w.agreed([a, b, late], 10 * 60 * 1000);
  assert.equal(w.view(late).tasks.length, 120);
  assert.ok(w.net.count({ from: 'late', kind: 'pull', since }) >= 2, 'what did not fit one answer was asked for again');
  assert.deepEqual(w.net.sent.filter((s) => s.bytes > STRANGER_BODY_BYTES), []);
});

await check('a hello that is refused leaves on disk whatever record it brought', async () => {
  const w = createWorld({ seed: 29 });
  const [a, b] = await w.pool(['a', 'b']);
  const m = await w.intruder('m', a);
  await w.agreed([a, b]);
  const held = w.records(a).find((r) => r.type === 'member' && r.pk === m.pk);
  const left = memberRecord(m.id, {
    pool: POOL, seq: held.seq + 1, at: w.net.now(), era: held.era, maxAcceptedH: 12, voucher: held.voucher, left: true,
  });
  const answer = await w.request(m, a, 'hello', { member: left }, { effort: 4096 });
  assert.deepEqual([answer.ok, answer.code, answer.detail], [false, 'denied', 'left']);
  assert.equal(w.records(a).find((r) => r.type === 'member' && r.pk === m.pk).seq, held.seq + 1);
});

await check('what a host ended as it left a pool is ended for the members that could not hear, once the host is back', async () => {
  const w = createWorld({ seed: 30 });
  const all = await w.pool(['a', 'b', 'c']);
  const [a, b, c] = all;
  const { taskId } = await a.node.offer(offerArgs('pr-1'));
  const own = await a.node.offer({ ...offerArgs('pr-2'), now: true });
  await w.net.until(() => a.executor.jobOf(own.taskId), { what: 'its own task run' });
  await w.agreed(all);
  // With a down, nobody hears its task finish, nor the other cancelled as it leaves.
  w.net.down('a');
  a.executor.end(a.executor.jobOf(own.taskId).runId);
  await w.net.until(() => w.offerRow(a, own.taskId).state === 'done', { what: 'its own task done' });
  a.node.leave({ pool: POOL });
  await w.run(60);
  assert.deepEqual([w.offerRow(a, taskId).state, w.task(b, taskId).state, w.task(c, own.taskId).state], ['cancelled', 'available', 'claimed']);
  w.net.down('a', false);
  await a.node.join({ pool: POOL });
  // The members still hold the offers open and hand them back to a.
  const states = (h) => [w.task(h, taskId)?.state, w.task(h, own.taskId)?.state];
  await w.net.until(() => all.every((h) => states(h).join() === 'cancelled,done'), { maxMs: 30 * 60 * 1000, what: 'each offer ended for every host as it ended' });
  await w.agreed(all);
  assert.deepEqual([w.offerRow(a, taskId).state, w.task(a, taskId).offeredHere], ['cancelled', false]);
});

await check('a lock a host granted binds it still when it left the pool, started again and came back; unlinked, the pool\'s locks go with it', async () => {
  const w = createWorld({ seed: 31 });
  const all = await w.pool(['a', 'b']);
  const [a, b] = all;
  const first = await w.intruder('first', a);
  const second = await w.intruder('second', a);
  await w.net.until(() => all.every((h) => w.members(h).length === 4), { what: 'both members for everyone' });
  const { taskId } = await a.node.offer(offerArgs('pr-1'));
  await w.agreed(all);
  const lock = async (from, round) => {
    const answer = await w.request(from, b, 'lock', { taskId, round, asOf: w.net.now(), hash: w.view(b).hash }, { effort: 128 });
    return answer.ok ? answer.body : `${answer.code}: ${answer.detail}`;
  };
  assert.equal((await lock(first, 'AAAAAAAAAAA')).grant.executor, first.pk);
  b.node.leave({ pool: POOL });
  await w.restart(b);
  await b.node.join({ pool: POOL });
  await w.net.until(() => w.task(b, taskId)?.state === 'available' && w.members(b).length === 4, { maxMs: 60 * 1000, what: 'the pool known again' });
  // Requests dated in the second b last served before its restart are not served.
  await w.run(2);
  assert.deepEqual(await lock(second, 'BBBBBBBBBBA'), { challenge: { reason: 'locked', holder: first.pk } });
  b.node.leave({ pool: POOL });
  assert.deepEqual(w.stored(b, 'locks')[POOL].map(([id, held]) => [id, held.executor]), [[taskId, first.pk]]);
  b.node.setPools([]);
  assert.deepEqual(w.stored(b, 'locks'), {});
});

await check('an invite is taken by the host that made it alone: each key that brings it is given a voucher for a seat of that host\'s', async () => {
  const w = createWorld({ seed: 32 });
  const [a, b] = await w.pool(['a', 'b']);
  const [m, other] = [w.stranger('m'), w.stranger('other')];
  const ask = async (from, to, body) => {
    const { ok, code, detail, body: answer } = await w.request(from, to, 'hello', body, { effort: 4096 });
    return ok ? answer : [code, detail];
  };
  const token = a.node.invite({ pool: POOL });
  assert.deepEqual(await ask(m, b, token), ['not-member', ''], 'a member that did not make it says nothing');
  for (const bad of [{ invite: 5 }, { ...token, member: {} }]) assert.deepEqual(await ask(b, a, bad), ['bad-request', '']);
  const first = await ask(m, a, token);
  const { sig, ...voucher } = first.voucher;
  assert.deepEqual(voucher, { pool: POOL, by: a.pk, era: 0, pk: m.pk, seat: 1, at: w.net.now() });
  assert.deepEqual(first.chain, [w.records(a).find((r) => r.pk === a.pk)], 'with the records that lead to the first member');
  assert.equal((await ask(other, a, token)).voucher.seat, 2, 'a second key is given the next seat, though no record holds the first yet');
  assert.deepEqual((await ask(w.stranger('deep'), b, b.node.invite({ pool: POOL }))).chain.map((r) => r.pk), [b.pk, a.pk], 'a member under the first names both');
  await w.run(30);
  const again = await ask(m, a, token);
  assert.deepEqual([again.voucher.seat, again.voucher.at >= first.voucher.at + 30], [1, true], 'and the first its own again, dated anew');
  // The voucher alone lets a key in, and only the key it names; the invite is in no record.
  const record = (id, v) => memberRecord(id, { pool: POOL, seq: 0, at: w.net.now(), era: 0, maxAcceptedH: 12, voucher: v });
  assert.deepEqual(await ask(other, b, { member: record(other.id, first.voucher) }), ['not-member', '']);
  assert.ok((await ask(m, b, { member: record(m.id, first.voucher), chain: first.chain })).index, 'any member lets it in');
  await w.agreed([a, b]);
  assert.deepEqual(w.members(a), [a.pk, b.pk, m.pk].sort());
  assert.equal(JSON.stringify(w.records(b)).includes(token.invite), false);
  // Seats given outlive the inviter's restart.
  const last = (await ask(w.stranger('last'), a, token)).voucher.seat;
  await w.restart(a);
  await w.run(2);
  assert.equal((await ask(other, a, token)).voucher.seat, 2);
  const long = a.node.invite({ pool: POOL, ttlSecs: 3 * 24 * 3600 });
  assert.deepEqual([last, (await ask(w.stranger('third'), a, long)).voucher.seat], [3, 4]);
  // Expired, the invite gives nothing, and seats it gave to keys that never came are free.
  await w.run(24 * 3600);
  assert.deepEqual(await ask(other, a, token), ['denied', 'expired']);
  assert.equal((await ask(w.stranger('fourth'), a, long)).voucher.seat, 2);
});

await check('a member gives 15 seats and one two invites from the first none; a seat is given again once its holder left or stopped signing', async () => {
  const w = createWorld({ seed: 33 });
  const [a, b] = await w.pool(['a', 'b']);
  const ask = async (from, to, body) => {
    const { ok, code, detail, body: answer } = await w.request(from, to, 'hello', body, { effort: 2 ** 16 });
    return ok ? answer : [code, detail];
  };
  // b has seat 0 of a's; fourteen more keys take the rest.
  const kept = a.node.invite({ pool: POOL, ttlSecs: 3 * 24 * 3600 });
  const more = [];
  for (let n = 1; n < LIMITS.invitees; n += 1) more.push(await w.intruder(`m${n}`, a));
  assert.deepEqual(more.map((m) => m.member.voucher.seat), Array.from({ length: LIMITS.invitees - 1 }, (_, n) => n + 1));
  await w.net.until(() => w.members(b).length === LIMITS.invitees + 1, { what: 'a pool of sixteen' });
  assert.throws(() => a.node.invite({ pool: POOL }), /^Error: Every one of the 15 machines this one may invite into the pool .* is a member of it: ask another machine of the pool\.$/);
  const late = w.stranger('late');
  assert.deepEqual(await ask(late, a, kept), ['denied', 'no-seat'], 'an invite made while a seat was free');
  const x = w.add('x');
  await w.start(x);
  await x.node.join(b.node.invite({ pool: POOL }));
  await w.net.until(() => w.members(a).includes(x.pk), { what: 'x a member' });
  assert.throws(() => x.node.invite({ pool: POOL }), /^Error: This machine is 2 invites away from the one that started the pool .*, and invites nobody: ask a machine nearer to that one\.$/);
  const leaver = more[6];
  const gone = memberRecord(leaver.id, { ...leaver.member, seq: 1, at: w.net.now(), left: true });
  assert.deepEqual((await w.request(leaver, a, 'push', { records: [gone] }, { effort: 2 ** 16 })).body.refused, []);
  const taken = (await ask(late, a, a.node.invite({ pool: POOL }))).voucher;
  assert.equal(taken.seat, leaver.member.voucher.seat);
  const lates = memberRecord(late.id, { pool: POOL, seq: 0, at: w.net.now(), era: 0, maxAcceptedH: 12, voucher: taken });
  assert.ok((await ask(late, a, { member: lates })).index);
  assert.equal(w.records(a).some((r) => r.pk === leaver.pk), false, 'and the one that left has none');
  await w.run(3600);
  const fresh = more[2];
  const resigned = memberRecord(fresh.id, { ...fresh.member, seq: 1, at: w.net.now() });
  assert.deepEqual((await w.request(fresh, a, 'push', { records: [resigned] }, { effort: 2 ** 16 })).body.refused, []);
  await w.run(23 * 3600 + 60);
  assert.equal(w.members(a).includes(fresh.pk), true);
  const silent = more.filter((m) => m !== fresh && m !== leaver).map((m) => m.member.voucher.seat);
  const given = [];
  for (let n = 0; n < silent.length + 1; n += 1) given.push((await ask(w.stranger(`next${n}`), a, a.node.invite({ pool: POOL }))).voucher.seat);
  assert.deepEqual(given, [...silent, taken.seat], 'the seats of the members that fell silent, the one that signed longest ago first');
  assert.throws(() => a.node.invite({ pool: POOL }), /^Error: Every one of the 15 machines/, 'the seats of the two that sign are theirs');
});

await check('a host joins under a member whose clock runs ahead of its own; joining again by another invite of that member it keeps its seat', async () => {
  const w = createWorld({ seed: 34 });
  const [a, b] = await w.pool(['a', 'b']);
  a.skew = 120;
  const c = w.add('c');
  await w.start(c);
  await c.node.join(a.node.invite({ pool: POOL }));
  await w.net.until(() => [a, b, c].every((h) => w.members(h).length === 3), { maxMs: 60 * 1000, what: 'c a member though its voucher is dated ahead of its clock' });
  const mine = w.records(c).find((r) => r.pk === c.pk);
  assert.deepEqual([mine.at, mine.voucher.at - w.net.now() > 60], [mine.voucher.at, true]);
  await w.run(300);
  await c.node.join(a.node.invite({ pool: POOL }));
  const voucher = () => w.records(b).find((r) => r.pk === c.pk).voucher;
  await w.net.until(() => voucher().at > mine.voucher.at, { what: 'its record under the voucher it was given last' });
  assert.deepEqual([voucher().seat, w.members(b).length], [mine.voucher.seat, 3]);
});

// A member record of the format without vouchers: a self-declared `joinedAt`, and the invite
// it came by.
function formerly(h, { seq, at, invite }) {
  const record = { type: 'member', pool: POOL, pk: h.pk, seq, at, joinedAt: at - 60, maxAcceptedH: 12, left: false, ...(invite ? { voucher: invite } : {}) };
  return { ...record, sig: sign(h.id, 'dn1/rec', record) };
}

await check('no member seats a key but in a seat of its own: the keys one makes take no seat of another\'s on any host, and a job that runs goes on', async () => {
  const w = createWorld({ seed: 35 });
  const all = await w.pool(['root', 'a', 'b', 'c'], { b: { slots: 1 } });
  const [root, a, b] = all;
  const { taskId } = await a.node.offer(offerArgs('pr-1'));
  await w.net.until(() => b.executor.jobOf(taskId), { what: 'a job of a\'s running at b' });
  const [far, near] = [await w.intruder('far', a), await w.intruder('near', root)];
  await w.agreed(all);
  const puppet = (by, seat, over = {}) => {
    const id = w.stranger('puppet');
    const now = w.net.now();
    return memberRecord(id.id, { pool: POOL, seq: 0, at: now, era: 0, maxAcceptedH: 12, voucher: { ...createVoucher(by.id, { pool: POOL, era: 0, pk: id.pk, seat, at: now }), ...over } });
  };
  const seats = Array.from({ length: LIMITS.invitees }, (_, seat) => seat);
  const codes = async (from, to, records) => {
    const { body } = await w.request(from, to, 'push', { records }, { effort: 4096 });
    return [body.accepted.length, [...new Set(body.refused.map((r) => r.code))].join()];
  };
  const invite = inviteToken(createInvite(far.id, { pool: POOL, exp: w.net.now() - 1, nonce: w.net.rnd.bytes(16) }));
  for (const h of all) {
    // Records of the format without vouchers, seats `far` has not got, and seats in root's name.
    const old = Array.from({ length: 32 }, () => formerly(w.stranger('puppet'), { seq: 0, at: w.net.now(), invite }));
    assert.deepEqual(await codes(far, h, old), [0, 'bad-record'], h.name);
    assert.deepEqual(await codes(far, h, seats.map((seat) => puppet(far, seat))), [0, 'no-seat'], h.name);
    assert.deepEqual(await codes(near, h, seats.map((seat) => puppet(near, seat, { by: root.pk }))), [0, 'bad-voucher'], h.name);
  }
  // Its own seats it may give, and give again.
  assert.deepEqual(await codes(near, root, seats.map((seat) => puppet(near, seat))), [LIMITS.invitees, '']);
  await w.run(5);
  assert.deepEqual(await codes(near, a, [puppet(near, 0), puppet(near, 1)]), [2, '']);
  await w.run(300);
  await w.agreed(all);
  const members = w.members(root);
  assert.equal(members.length, all.length + 2 + LIMITS.invitees);
  for (const h of all) {
    assert.deepEqual(w.members(h), members, `${h.name} names the members root names`);
    assert.ok(all.every((g) => members.includes(g.pk)));
  }
  assert.ok(b.executor.jobOf(taskId), 'the job runs');
  assert.deepEqual([w.offerRow(a, taskId).state, w.offerRow(a, taskId).attempt, w.claim(root, taskId).executor, b.executor.started.length], ['claimed', 1, b.pk, 1]);
});

await check('a store of member records without vouchers is a pool of the host\'s own, with its offers in it: the others join by invite again', async () => {
  const w = createWorld({ seed: 36 });
  const all = await w.pool(['a', 'b'], { b: { slots: 1 } });
  const [a, b] = all;
  b.slots = 0;
  const { taskId } = await a.node.offer(offerArgs('pr-1'));
  await w.agreed(all);
  for (const h of all) w.net.kill(h.name);
  const file = [...a.disk.files.keys()].find((name) => name.startsWith('pools/'));
  for (const h of all) {
    const { joining, invites, ...doc } = w.doc(h);
    const now = w.net.now();
    const records = doc.records.map((r) => (r.type === 'member' ? formerly(all.find((g) => g.pk === r.pk), { seq: r.seq + 1, at: now, invite: r.voucher && 'an invite' }) : r));
    h.disk.write(file, JSON.stringify({ ...doc, records, inviter: a.pk }));
  }
  for (const h of all) await w.restart(h);
  await w.run(120);
  for (const h of all) {
    const [mine] = w.records(h).filter((r) => r.type === 'member');
    assert.deepEqual([w.members(h), mine.voucher, mine.era === mine.seq], [[h.pk], undefined, true], h.name);
  }
  assert.deepEqual([w.task(a, taskId).state, w.view(b).tasks.length], ['available', 0], 'each holds what it offered and nothing of the other');
  b.slots = 1;
  await b.node.join(a.node.invite({ pool: POOL }));
  await w.net.until(() => b.executor.jobOf(taskId), { what: 'the job running at the host that joined again' });
  assert.deepEqual(w.members(a), [a.pk, b.pk].sort());
});

await check('a machine joins by no invite of a machine that came into the pool through it, and a member seats no key it sits under: the pool stays one', async () => {
  const w = createWorld({ seed: 37 });
  const [r, a, h] = await w.pool(['r', 'a', 'h']);
  const [b, c] = [w.add('b'), w.add('c')];
  for (const [x, by] of [[b, a], [c, h]]) {
    await w.start(x);
    await x.node.join(by.node.invite({ pool: POOL }));
  }
  const all = [r, a, h, b, c];
  await w.net.until(() => all.every((x) => w.members(x).length === 5), { what: 'five members' });
  await w.agreed(all);
  const hash = w.view(r).hash;
  const through = /^Error: The machine that made that invite came into the pool .* through this one, which is in it already: an invite takes a machine in under its maker\. To move this machine, use an invite of a machine that did not come in through it\.$/;
  const made = (by) => ({ invite: inviteToken(createInvite(by.id, { pool: POOL, exp: w.net.now() + 3600, nonce: w.net.rnd.bytes(16) })) });
  await assert.rejects(r.node.join(a.node.invite({ pool: POOL })), through);
  await assert.rejects(r.node.join(made(b)), through, 'two vouchers out');
  await assert.rejects(a.node.join(made(b)), through);
  assert.deepEqual([w.view(r).joining, w.view(a).joining], [false, false]);
  // The invite's maker judges the same when a key brings the invite by hand.
  const ask = async (from, to, body) => {
    const { ok, code, detail, body: answer } = await w.request(from, to, 'hello', body, { effort: 4096 });
    return ok ? answer : [code, detail];
  };
  const above = ['denied', 'the maker of that invite sits under the key that brings it'];
  assert.deepEqual(await ask(r, a, a.node.invite({ pool: POOL })), above);
  assert.deepEqual(await ask(r, h, h.node.invite({ pool: POOL })), above);
  assert.equal((await ask(h, a, a.node.invite({ pool: POOL }))).voucher.by, a.pk, 'a key beside it is given a seat');
  await w.run(30 * 60);
  for (const x of all) assert.deepEqual([w.members(x).length, w.view(x).hash], [5, hash], x.name);
});

await check('the machine that began a pool, unlinked and linked again, is taken back by no invite of the pool it began, and is told why; its machines join its new pool by its invite', async () => {
  const w = createWorld({ seed: 52 });
  const [r, a, b] = await w.pool(['r', 'a', 'b']);
  const c = w.add('c');
  await w.start(c);
  await c.node.join(a.node.invite({ pool: POOL }));
  const all = [r, a, b, c];
  await w.net.until(() => all.every((x) => w.members(x).length === 4), { what: 'four members' });
  await w.agreed(all);
  r.node.setPools([]);
  r.node.setPools(r.pools);
  await w.run(600);
  const old = [a, b, c].map((x) => x.pk).sort();
  for (const by of [a, b]) {
    await r.node.join(by.node.invite({ pool: POOL }));
    await w.net.until(() => !w.view(r).joining, { maxMs: 60 * 1000, what: `${by.name} answered` });
    assert.deepEqual([w.view(r).joinFailed, w.members(r), w.members(by)], [
      'the machine that made that invite came into the pool under this one, before this one began the pool again, and no machine that came in under this one can let it back in: use an invite of one that did not, or - if this machine began that pool, so that every machine there came in under it - have them join this one\'s pool, each by an invite this machine makes',
      [r.pk], old,
    ], by.name);
  }
  await a.node.join(r.node.invite({ pool: POOL }));
  await w.net.until(() => w.members(r).length === 3, { maxMs: 10 * 60 * 1000, what: 'a and the machine it seated in the new pool' });
  assert.deepEqual(w.members(r), [r.pk, a.pk, c.pk].sort());
});

await check('two machines that each began the pool and join by one another\'s invite in one moment are one pool with one first member, whichever of its machines looks', async () => {
  const w = createWorld({ seed: 38 });
  const names = ['r1', 'a', 'x', 'r2', 'b', 'y'];
  const [r1, a, x, r2, b, y] = names.map((name) => w.add(name));
  for (const h of [r1, a, x, r2, b, y]) await w.start(h);
  for (const [h, by] of [[a, r1], [x, a], [b, r2], [y, b]]) {
    await h.node.join(by.node.invite({ pool: POOL }));
    await w.net.until(() => w.members(by).includes(h.pk) && w.members(h).includes(by.pk), { what: `${h.name} a member` });
  }
  await w.agreed([r1, a, x]);
  await w.agreed([r2, b, y]);
  const [to2, to1] = [r2.node.invite({ pool: POOL }), r1.node.invite({ pool: POOL })];
  r1.node.join(to2);
  r2.node.join(to1);
  await w.run(30 * 60);
  // One of the two is the first member; the machine three vouchers from it has no seat.
  const [top, low] = w.records(r1).find((rec) => rec.pk === r1.pk).voucher.at > w.records(r2).find((rec) => rec.pk === r2.pk).voucher.at ? [[r1, a, x, r2, b], y] : [[r2, b, y, r1, a], x];
  const members = top.map((h) => h.pk).sort();
  for (const h of top) assert.deepEqual([w.members(h), w.view(h).hash], [members, w.view(top[0]).hash], h.name);
  assert.equal(members.includes(low.pk), false);
  assert.deepEqual([...top, low].map((h) => w.view(h).unseated), [false, false, false, false, false, true]);
  await low.node.join(top[0].node.invite({ pool: POOL }));
  await w.net.until(() => w.members(top[1]).includes(low.pk) && w.members(low).length === 6, { what: 'the sixth a member again' });
  assert.equal(w.view(low).unseated, false);
});

await check('a machine that was off for longer than a member record is kept comes back as the member it was, by what its own store holds: the machines it seated were members all along and are members still', async () => {
  const w = createWorld({ seed: 40 });
  const [r, a, h] = await w.pool(['r', 'a', 'h']);
  const b = w.add('b');
  await w.start(b);
  await b.node.join(a.node.invite({ pool: POOL }));
  const all = [r, a, h, b];
  await w.net.until(() => all.every((x) => w.members(x).length === 4), { what: 'four members' });
  await w.agreed(all);
  // r and a are off for 31 days; h (seated by r) and b (seated by a) stay.
  const mine = (x) => w.records(x).find((rec) => rec.pk === x.pk);
  const before = [mine(r), mine(a)];
  w.net.kill('r');
  w.net.kill('a');
  await w.run(31 * 24 * 3600);
  for (const x of [h, b]) assert.deepEqual(w.members(x), [h.pk, b.pk].sort(), `${x.name} while the two are off`);
  for (const [i, x] of [r, a].entries()) {
    await w.restart(x);
    assert.deepEqual([mine(x).era, mine(x).voucher?.by, mine(x).seq > before[i].seq], [before[i].era, before[i].voucher?.by, true], `${x.name} signs the membership it had`);
  }
  await w.net.until(() => all.every((x) => w.members(x).length === 4), { maxMs: 10 * 60 * 1000, what: 'four members again' });
  await w.agreed(all);
  assert.deepEqual([mine(r).era, mine(r).voucher, mine(a).era, mine(a).voucher.by], [0, undefined, before[1].era, r.pk]);
});

await check('a machine whose seat went to another key reads so in its pool\'s row once every machine it knows of has refused it, and is a member again the moment it joins by a new invite', async () => {
  const w = createWorld({ seed: 42 });
  const [a, b, c] = await w.pool(['a', 'b', 'c']);
  const lone = w.add('lone');
  await w.start(lone);
  assert.deepEqual([a, b, c, lone].map((h) => w.view(h).unseated), [false, false, false, false]);
  // a gives b's seat to p (only a's key can); c, cut off from a, still takes b for a member.
  w.net.cut('a', 'c');
  await w.run(2);
  const p = w.stranger('p');
  const mine = () => w.records(b).find((rec) => rec.pk === b.pk);
  const seated = (id, seq, seat) => memberRecord(id, { pool: POOL, seq, at: w.net.now(), era: 0, maxAcceptedH: 12, voucher: createVoucher(a.id, { pool: POOL, era: 0, pk: id.pk, seat, at: w.net.now() }) });
  const now = w.net.now();
  assert.equal((await w.request(p, a, 'hello', { member: seated(p.id, 0, mine().voucher.seat) }, { effort: 4096 })).ok, true);
  await w.net.until(() => w.net.count({ from: 'b', to: 'a', kind: 'hello', since: now }) > 0, { maxMs: 10 * 60 * 1000, what: 'b refused by a' });
  await w.run(120);
  assert.deepEqual([w.members(a).includes(b.pk), w.members(c).includes(b.pk), w.view(b).unseated], [false, true, false], 'one machine that refuses it is not all of them');
  w.net.heal();
  await w.net.until(() => w.view(b).unseated, { maxMs: 30 * 60 * 1000, what: 'its row saying it has no seat' });
  assert.deepEqual([w.members(c).includes(b.pk), w.view(a).unseated, w.view(c).unseated], [false, false, false]);
  const asked = w.net.now();
  await b.node.join(a.node.invite({ pool: POOL }));
  await w.net.until(() => w.members(a).includes(b.pk) && w.members(c).includes(b.pk), { maxMs: 60 * 1000, what: 'a member again within the minute' });
  assert.deepEqual([w.view(b).unseated, w.net.now() - asked < 60], [false, true]);
  // Its seat is given away once more, then a seats it at seat 9 unasked: the machines that
  // refused it answer it again.
  await w.run(2);
  const q = w.stranger('q');
  const theirs = seated(q.id, 0, mine().voucher.seat);
  assert.equal((await w.request(q, a, 'hello', { member: theirs }, { effort: 4096 })).ok, true);
  await w.net.until(() => w.view(b).unseated, { maxMs: 30 * 60 * 1000, what: 'its row saying it has no seat again' });
  await w.run(2);
  const records = [memberRecord(q.id, { ...theirs, seq: 1, at: w.net.now(), left: true }), seated(b.id, mine().seq + 1, 9)];
  assert.deepEqual((await w.request(q, a, 'push', { records }, { effort: 4096 })).body.refused, []);
  await w.net.until(() => !w.view(b).unseated, { maxMs: 30 * 60 * 1000, what: 'its row saying nothing' });
  assert.equal(mine().voucher.seat, 9);
});

await check('a machine that goes back into a pool it left more than a month before is back: one a member seated by the record of that member it kept, and the one that began the pool by asking the machines it left - whenever they answer, however often it starts, and though it leaves and joins once more meanwhile', async () => {
  const w = createWorld({ seed: 43 });
  const all = await w.pool(['a', 'b', 'c']);
  const [a, b, c] = all;
  const row = (h) => {
    const { left, joining, joinFailed, returning, unseated } = w.view(h);
    return [left, joining, joinFailed, returning, unseated, w.members(h).length, w.asks(h).back.length];
  };
  c.node.leave({ pool: POOL });
  await w.run(31 * 24 * 3600);
  assert.deepEqual(await c.node.join({ pool: POOL }), { pool: POOL });
  await w.net.until(() => all.every((h) => w.members(h).length === 3), { maxMs: 60 * 1000, what: 'c a member again within the minute' });
  await w.agreed(all);
  assert.deepEqual(row(c), [false, false, '', false, false, 3, 0]);

  // a began the pool, so it holds no record but its own; nobody it left is reachable, so it
  // waits for them and asks them as often as a member asks one that does not answer.
  a.node.leave({ pool: POOL });
  await w.run(31 * 24 * 3600);
  w.net.kill('b');
  w.net.kill('c');
  const others = [b.pk, c.pk].sort();
  assert.deepEqual(await a.node.join({ pool: POOL }), { pool: POOL });
  assert.deepEqual([row(a), w.asks(a).back.map((e) => e.pk)], [[false, false, '', true, false, 1, 2], others]);
  await w.run(600);
  const since = w.net.now();
  await w.run(1800);
  assert.deepEqual([w.net.count({ from: 'a', since }), w.net.count({ from: 'a', kind: 'hello', since })], [6, 6]);
  await w.restart(a);
  await w.run(60);
  assert.deepEqual([row(a), w.asks(a).back.map((e) => e.pk)], [[false, false, '', true, false, 1, 2], others], 'started again');
  a.node.leave({ pool: POOL });
  assert.deepEqual([...w.stored(a, poolFile(POOL)).leftTo].sort(), others, 'what it leaves once more, it leaves to them');
  await w.run(60);
  await a.node.join({ pool: POOL });
  await w.restart(c);
  await w.net.until(() => w.members(a).length === 3 && w.members(c).length === 3, { maxMs: 15 * 60 * 1000, what: 'a back once one of them answers' });
  await w.run(2);
  // From c it holds b's record again: b is asked as a member.
  assert.deepEqual(row(a), [false, false, '', false, false, 3, 0]);
  await w.restart(b);
  await w.net.until(() => all.every((h) => w.members(h).length === 3), { maxMs: 15 * 60 * 1000, what: 'three members' });
  await w.agreed(all);
});

await check('a version a machine signs after its clock was set back is dated earlier than the one before, and takes its place on every member all the same', async () => {
  const w = createWorld({ seed: 47 });
  const [a, b] = await w.pool(['a', 'b']);
  const held = () => w.records(b).find((r) => r.pk === a.pk);
  a.skew = 200;
  a.settings.maximumAcceptedH = 24;
  await w.net.until(() => held().maxAcceptedH === 24, { maxMs: 60 * 1000, what: 'the version signed ahead of time' });
  const ahead = held();
  a.skew = 0;
  a.settings.maximumAcceptedH = 48;
  await w.net.until(() => held().maxAcceptedH === 48, { maxMs: 60 * 1000, what: 'the version signed by the clock set right' });
  assert.deepEqual([held().seq > ahead.seq, ahead.at - held().at > 100, ahead.at - w.net.now() > 100], [true, true, true]);
  await w.agreed([a, b]);
});

await check('a machine back after more than a month whose voucher leads up to a machine gone for good asks the others it knew, left or not, and takes and gives no job until one of them answers', async () => {
  for (const how of ['left', 'off']) {
    const w = createWorld({ seed: 91 });
    const [r, a, b, m] = await w.pool(['r', 'a', 'b', 'm']);
    assert.equal(w.records(m).find((x) => x.pk === m.pk).voucher.by, r.pk);
    if (how === 'left') m.node.leave({ pool: POOL });
    else w.net.kill('m');
    await w.run(24 * 3600);
    w.net.kill('r');
    await w.run(31 * 24 * 3600);
    w.net.kill('a');
    w.net.kill('b');
    if (how === 'left') await m.node.join({ pool: POOL });
    else await w.restart(m);
    m.slots = 1;
    const { taskId } = await m.node.offer(offerArgs('pr-1'));
    await w.run(3600);
    const row = () => [w.view(m).returning, w.view(m).unseated, w.members(m)];
    assert.deepEqual([row(), m.node.snapshot().runs, w.task(m, taskId).state], [[true, false, [m.pk]], [], 'available'], `${how}: nobody answered`);
    assert.ok(['r', 'a', 'b'].every((to) => w.net.count({ from: 'm', to, kind: 'hello' }) > 0), `${how}: each of them asked`);
    await w.restart(a);
    await w.restart(b);
    await w.net.until(() => [a, b, m].every((h) => w.members(h).length === 3), { maxMs: 15 * 60 * 1000, what: `${how}: m a member again` });
    await w.agreed([a, b, m]);
    assert.deepEqual(row(), [false, false, [a.pk, b.pk, m.pk].sort()]);
    for (const h of [a, b]) h.slots = 1;
    await w.net.until(() => [a, b, m].some((h) => h.executor.jobOf(taskId)), { maxMs: 15 * 60 * 1000, what: `${how}: the task run` });
    await w.run(600);
    assert.equal([a, b, m].filter((h) => h.executor.jobOf(taskId)).length, 1, `${how}: once`);
  }
});

// Reports a Tor transport state to the node.
const say = (h, state) => {
  h.transport.host.ready = state === 'ready';
  h.transport.host.watchers.forEach((fn) => fn({ state, detail: '' }));
};
// Requests from `h` to keys `to` picks are never answered.
const silence = (h, to) => {
  const real = h.transport.request.bind(h.transport);
  h.transport.request = (pk, ...rest) => (to(pk) ? new Promise(() => {}) : real(pk, ...rest));
};
const torDown = (h) => ['failed', 'starting'].forEach((state) => say(h, state));
const torUp = async (w, h) => {
  say(h, 'bootstrapping');
  await w.run(5);
  say(h, 'publishing');
  await w.run(30);
  say(h, 'ready');
};

await check('a machine that heard nobody of its pool for less than a month is not coming back: the last of a pool whose other member stopped runs its jobs after a weekend off, asleep, or with its transport down - and comes back once it has heard nobody for a month', async () => {
  for (const how of ['off', 'asleep', 'down']) {
    const w = createWorld({ seed: 61 });
    const [r, a] = await w.pool(['r', 'a']);
    // a stops an hour after it last signed.
    await w.run(3600);
    w.net.kill('a');
    await w.run(5 * 24 * 3600);
    if (how === 'off') {
      w.net.kill('r');
      await w.run(50 * 3600);
      await w.restart(r);
    } else if (how === 'asleep') {
      w.net.sleep('r');
      await w.run(50 * 3600);
      w.net.sleep('r', false);
    } else {
      torDown(r);
      await w.run(50 * 3600);
      await torUp(w, r);
    }
    await w.run(600);
    assert.deepEqual([w.view(r).returning, w.asks(r).back, w.members(r)], [false, [], [r.pk]], how);
    r.slots = 1;
    const { taskId } = await r.node.offer(offerArgs('pr-1'));
    await w.net.until(() => r.executor.jobOf(taskId), { maxMs: 3600 * 1000, what: `${how}: its job running` });
    assert.equal(w.net.count({ from: 'r', to: 'a', kind: 'hello' }), 0, `${how}: the machine that stopped is not asked as one whose record ran out`);
    if (how !== 'off') continue;
    await w.run(22 * 24 * 3600);
    assert.deepEqual([w.view(r).returning, w.asks(r).back.map((e) => e.pk)], [false, []], 'a day short of a month');
    await w.run(2 * 24 * 3600);
    assert.deepEqual([w.view(r).returning, w.asks(r).back.map((e) => e.pk)], [true, [a.pk]], 'a month of silence');
  }
});

await check('two machines back after a month that reach each other first go on asking the machines that stayed, and are one pool with them once those are up', async () => {
  const w = createWorld({ seed: 64 });
  const [r, a, b, c, m] = await w.pool(['r', 'a', 'b', 'c', 'm']);
  w.net.kill('c');
  w.net.kill('m');
  await w.run(24 * 3600);
  w.net.kill('r');
  await w.run(31 * 24 * 3600);
  // The two that stayed are off for a weekend.
  w.net.kill('a');
  w.net.kill('b');
  await w.restart(c);
  await w.run(600);
  await w.restart(m);
  await w.run(50 * 3600);
  const back = (h) => w.asks(h).back.map((e) => e.pk);
  assert.deepEqual([c, m].map((h) => [w.view(h).returning, w.members(h), back(h)]), [
    [false, [c.pk, m.pk].sort(), [a.pk, b.pk].sort()],
    [false, [c.pk, m.pk].sort(), [a.pk, b.pk].sort()],
  ]);
  await w.restart(a);
  await w.restart(b);
  const live = [a, b, c, m];
  await w.net.until(() => live.every((h) => w.members(h).length === 4), { maxMs: 30 * 60 * 1000, what: 'one pool of four' });
  await w.agreed(live);
  assert.deepEqual(live.map((h) => back(h).length), [0, 0, 0, 0]);
  for (const h of live) h.slots = 1;
  const { taskId } = await a.node.offer(offerArgs('pr-1'));
  await m.node.offer(offerArgs('pr-1'));
  await w.net.until(() => live.some((h) => h.executor.jobOf(taskId)), { maxMs: 3600 * 1000, what: 'pr-1 running' });
  await w.run(600);
  assert.equal(live.filter((h) => h.executor.jobOf(taskId)).length, 1);
});

await check('a machine back after a month asks a machine that never answers for 30 days, and then once a day', async () => {
  const w = createWorld({ seed: 66 });
  const all = await w.pool(['a', 'b', 'c']);
  const [a, b] = all;
  for (const h of all) w.net.kill(h.name);
  await w.run(31 * 24 * 3600);
  await w.restart(a);
  await w.restart(b);
  await w.net.until(() => !w.view(a).returning, { maxMs: 3600 * 1000, what: 'b answered' });
  await w.run(60);
  assert.deepEqual(w.asks(a).back.map((e) => w.name(e.pk)), ['c']);
  await w.run(2 * 24 * 3600);
  const day2 = w.net.now();
  await w.run(24 * 3600);
  assert.deepEqual([w.asks(a).back.map((e) => w.name(e.pk)), w.net.count({ from: 'a', to: 'c', since: day2 }) > 0], [['c'], true], 'asked on its third day');
  await w.run(27 * 24 * 3600 + 3600);
  assert.deepEqual([w.asks(a).back, w.view(a).returning], [[], false]);
  const since = w.net.now();
  await w.run(2 * 24 * 3600);
  const asked = w.net.count({ from: 'a', to: 'c', since });
  assert.ok(asked >= 1 && asked <= 5 && asked === w.net.count({ from: 'a', to: 'c', kind: 'hello', since }), `asked ${asked} times in two days`);
});

await check('a machine that heard nobody of its pool for a month - asleep, cut off, with its transport down, or cut off and then restarted - comes back: it asks every machine it knew there, and is one pool with them', async () => {
  for (const how of ['sleep', 'cut', 'down', 'woke', 'restart']) {
    const w = createWorld({ seed: 91 });
    const [r, a, b, m] = await w.pool(['r', 'a', 'b', 'm']);
    const cut = (on) => { for (const x of ['r', 'a', 'b']) w.net.cut('m', x, on); };
    // m last hears the others hours after they last signed.
    await w.run(3 * 3600);
    // 'woke' is never cut, so it is answered as soon as it wakes.
    cut(how !== 'woke');
    if (how === 'sleep' || how === 'woke') w.net.sleep('m');
    else if (how === 'down') torDown(m);
    await w.run(24 * 3600);
    w.net.kill('r');
    await w.run(31 * 24 * 3600);
    if (how === 'sleep' || how === 'woke') w.net.sleep('m', false);
    else if (how === 'down') await torUp(w, m);
    else if (how === 'restart') await w.restart(m);
    const woken = w.net.now();
    await w.run(60);
    // r too: m keeps the record of the member that seated it, whatever its age.
    if (how !== 'woke') assert.deepEqual([w.view(m).returning, w.asks(m).back.map((e) => w.name(e.pk)).sort()], [true, ['a', 'b', 'r']], how);
    cut(false);
    const since = how === 'woke' ? woken : w.net.now();
    await w.net.until(() => [a, b, m].every((h) => w.members(h).length === 3), { maxMs: 30 * 60 * 1000, what: `${how}: m a member again` });
    await w.agreed([a, b, m]);
    assert.ok(w.net.count({ from: 'm', to: 'a', since }) > 0, how);
    assert.deepEqual([w.view(m).returning, w.asks(m).back], [false, []], how);
    for (const h of [a, b, m]) h.slots = 1;
    const { taskId } = await m.node.offer(offerArgs('pr-1'));
    await a.node.offer(offerArgs('pr-1'));
    await w.net.until(() => [a, b, m].some((h) => h.executor.jobOf(taskId)), { maxMs: 3600 * 1000, what: `${how}: pr-1 running` });
    await w.run(600);
    assert.equal([a, b, m].filter((h) => h.executor.jobOf(taskId)).length, 1, how);
  }
});

await check('a machine cut off from its pool with its transport up, or asleep in dark wakes, that offers a job the moment it reaches the others again runs it once with them: after 2 days, and after 31', async () => {
  for (const [how, days] of [['cut', 2], ['cut', 31], ['dark', 2]]) {
    const w = createWorld({ seed: 91 });
    const [, a, b, m] = await w.pool(['r', 'a', 'b', 'm']);
    const cut = (on) => { for (const x of ['r', 'a', 'b']) w.net.cut('m', x, on); };
    cut(true);
    if (how === 'cut') await w.run(days * 24 * 3600);
    // A sleeping Mac wakes every minute or so, too briefly for Tor to reach anyone.
    for (let t = 0; how === 'dark' && t < days * 24 * 3600; t += 90) {
      w.net.sleep('m');
      await w.run(50);
      w.net.sleep('m', false);
      await w.run(40);
    }
    cut(false);
    assert.equal(w.view(m).returning, days > 30, `${how} ${days}`);
    for (const h of [a, b, m]) h.slots = 1;
    await w.run(5);
    const { taskId } = await m.node.offer(offerArgs('pr-1'));
    await w.run(1);
    await a.node.offer(offerArgs('pr-1'));
    await w.run(2 * 3600);
    assert.deepEqual([a, b, m].filter((h) => h.executor.jobOf(taskId)).length, 1, `${how} ${days}`);
  }
});

await check('the first word a machine gets in a pool after more than 6 hours of none makes the pool out of date: it asks every member what it missed', async () => {
  for (const hours of [5, 8]) {
    const w = createWorld({ seed: 93 });
    const [, a, , m] = await w.pool(['r', 'a', 'b', 'm']);
    const cut = (on) => { for (const x of ['r', 'a', 'b']) w.net.cut('m', x, on); };
    cut(true);
    await w.run(hours * 3600);
    cut(false);
    const since = m.log.length;
    assert.equal((await w.request(a, m, 'push', { records: [] }, { effort: 4096 })).ok, true);
    await w.run(30);
    assert.equal(m.log.slice(since).filter((line) => line.includes(' is up to date ')).length, hours > 6 ? 1 : 0, `${hours} h`);
  }
});

await check('a machine that only reaches the others, or that only the others reach, has heard them: it is not out of date for having heard nobody', async () => {
  for (const way of ['out', 'in']) {
    const w = createWorld({ seed: 94 });
    const [r, a, b, m] = await w.pool(['r', 'a', 'b', 'm']);
    if (way === 'out') silence(m, () => true);
    else for (const h of [r, a, b]) silence(h, (pk) => pk === m.pk);
    await w.run(8 * 3600);
    assert.ok(w.net.now() - w.heard(m).heard <= 30 * 60, way);
  }
});

await check('a machine that restarts while the other members it hears are off takes a member that stopped signing long before for one that stopped: what it heard is on disk', async () => {
  const w = createWorld({ seed: 74 });
  const [h, , y] = await w.pool(['h', 'x', 'y']);
  w.net.kill('x');
  await w.run(29.5 * 24 * 3600);
  assert.ok(w.net.now() - w.heard(h).heard <= 600, 'when y was last heard is on disk to within 10 minutes');
  w.net.kill('y');
  await w.restart(h);
  await w.run(1.5 * 24 * 3600);
  assert.deepEqual([w.asks(h).back, w.view(h).returning], [[], false]);
  await w.restart(y);
  const since = w.net.now();
  await w.run(24 * 3600);
  // x is asked as any member whose record was dropped, and no more.
  const asked = w.net.count({ from: 'h', to: 'x', since });
  assert.ok(asked <= 2 && asked === w.net.count({ from: 'h', to: 'x', kind: 'hello', since }), `asked ${asked} times in a day`);
});

await check('a store that keeps when another member was last heard in the pool document is read from it, and one that keeps it nowhere as when this machine last signed', async () => {
  for (const kept of ['document', 'nowhere']) {
    const w = createWorld({ seed: 68 });
    const [r, a] = await w.pool(['r', 'a']);
    w.net.kill('r');
    w.net.kill('a');
    await w.run(31 * 24 * 3600);
    r.disk.remove(heardFile(POOL));
    const doc = w.doc(r);
    r.disk.write(poolFile(POOL), JSON.stringify(kept === 'document' ? { ...doc, heard: w.net.now() - 24 * 3600 } : doc));
    await w.restart(r);
    assert.deepEqual([w.view(r).returning, w.asks(r).back.map((e) => e.pk)], kept === 'document' ? [false, []] : [true, [a.pk]], kept);
    await w.run(60);
    // Read from the document, it moves to its own file before the document is written again.
    assert.equal(w.heard(r)?.heard ?? null, kept === 'document' ? w.net.now() - 60 - 24 * 3600 : null, kept);
  }
});

await check('a hello counts as hearing the pool only once it lets its sender in: not one with a copy of a member record, nor one with an invite that ran out', async () => {
  for (const sent of ['record', 'old', 'fresh']) {
    const w = createWorld({ seed: 97 });
    const [, a, , m] = await w.pool(['r', 'a', 'b', 'm']);
    await w.run(3600);
    const s = w.stranger('s');
    const old = m.node.invite({ pool: POOL, ttlSecs: 3600 });
    const record = w.records(m).find((x) => x.type === 'member' && x.pk === a.pk);
    for (const x of ['r', 'a', 'b']) w.net.cut('m', x, true);
    await w.run(7 * 3600);
    const body = sent === 'record' ? { member: record } : sent === 'old' ? old : m.node.invite({ pool: POOL });
    const first = await w.request(s, m, 'hello', body, { effort: 128 });
    const answer = first.code === 'effort' ? await w.request(s, m, 'hello', body, { effort: first.effort }) : first;
    assert.equal(answer.ok, sent === 'fresh', `${sent}: ${answer.code}`);
    await w.run(30);
    assert.equal(w.net.now() - w.heard(m).heard < 60, sent === 'fresh', sent);
  }
});

await check('a pool whose members all answer is not written whole for being heard: what it heard is a file of its own', async () => {
  const w = createWorld({ seed: 96 });
  const all = await w.pool(['r', 'a', 'b', 'm']);
  await w.run(3600);
  const writes = new Map();
  for (const h of all) {
    const write = h.disk.write.bind(h.disk);
    h.disk.write = (name, text) => {
      writes.set(`${h.name} ${name}`, (writes.get(`${h.name} ${name}`) ?? 0) + 1);
      write(name, text);
    };
  }
  await w.run(24 * 3600);
  for (const h of all) {
    assert.equal(writes.get(`${h.name} ${poolFile(POOL)}`) ?? 0, 0, h.name);
    assert.ok(writes.get(`${h.name} ${heardFile(POOL)}`) <= 24 * 6, h.name);
    assert.ok(w.net.now() - w.heard(h).heard <= 600, h.name);
  }
});

await check('a machine that leaves a pool, or whose repository is removed, while an answer of the pool is on its way stays out of it - back after a month too: the answer writes nothing, and a pool linked again meanwhile is a pool of one', async () => {
  for (const act of ['leave', 'back', 'remove', 'again']) {
    const w = createWorld({ seed: 95 });
    const [r, a, b] = await w.pool(['r', 'a', 'b']);
    await w.run(3600);
    // r hears nobody for 15 minutes, or is off for a month; then each way takes 15 s, as a slow
    // Tor circuit does, and only r's own requests are answered.
    const cut = (on) => { for (const x of ['a', 'b']) w.net.cut('r', x, on); };
    for (const h of [a, b]) silence(h, (pk) => pk === r.pk);
    if (act === 'back') w.net.kill('r');
    else cut(true);
    await w.run(act === 'back' ? 31 * 24 * 3600 : 15 * 60);
    Object.assign(w.net.faults, { minMs: 15000, maxMs: 15000 });
    let asked = false;
    w.net.tap(({ from }) => { asked ||= from === 'r'; });
    if (act === 'back') await w.restart(r);
    else cut(false);
    await w.net.until(() => asked, { stepMs: 1, what: `${act}: r asks` });
    if (act === 'leave' || act === 'back') r.node.leave({ pool: POOL });
    else r.node.setPools([]);
    if (act === 'again') r.node.setPools(r.pools);
    await w.run(120);
    Object.assign(w.net.faults, { minMs: 5, maxMs: 40 });
    const doc = JSON.parse(r.disk.read(poolFile(POOL)));
    if (act === 'again') {
      assert.deepEqual([doc.linked, w.records(r).filter((x) => x.type === 'member').map((x) => x.pk)], [true, [r.pk]], act);
      continue;
    }
    assert.deepEqual([doc.linked, doc.left?.left, r.disk.read(heardFile(POOL)) === null], [false, true, act === 'remove'], act);
    if (act !== 'remove') {
      await w.restart(r);
      await w.run(7 * 3600);
      assert.deepEqual([w.view(r)?.left ?? null, w.members(a).includes(r.pk)], [true, false], act);
      r.node.setPools([]);
      await w.run(60);
      assert.equal(r.disk.read(heardFile(POOL)), null, act);
    } else {
      r.node.setPools(r.pools);
      await w.run(600);
      assert.deepEqual(w.members(r), [r.pk], act);
    }
  }
});

await check('a machine that leaves a pool, or whose repository is removed and added again, 2 s after it starts or wakes stays out of the pool it was in', async () => {
  for (const way of ['start', 'wake']) {
    for (const act of ['leave', 'remove']) {
      for (let seed = 2000; seed < 2004; seed += 1) {
        const w = createWorld({ seed });
        const [r] = await w.pool(['r', 'a', 'b']);
        await w.run(3600);
        Object.assign(w.net.faults, { minMs: 1000, maxMs: 20000 });
        if (way === 'wake') {
          w.net.sleep('r');
          await w.run(3600);
          w.net.sleep('r', false);
        } else {
          w.net.kill('r');
          await w.run(3600);
          await w.restart(r);
        }
        await w.run(2);
        if (act === 'leave') r.node.leave({ pool: POOL });
        else r.node.setPools([]);
        await w.run(300);
        const what = `${way} ${act} ${seed}`;
        assert.equal(JSON.parse(r.disk.read(poolFile(POOL))).linked, false, what);
        if (act === 'leave') continue;
        r.node.setPools(r.pools);
        await w.run(60);
        assert.deepEqual(w.records(r).filter((x) => x.type === 'member').map((x) => x.pk), [r.pk], what);
      }
    }
  }
});

await check('the last machine of a pool whose others stopped for good waits a month for them once it has heard nobody for a month, founder or not, restarted or not, and then runs its jobs alone', async () => {
  for (const last of ['m', 'r']) {
    const w = createWorld({ seed: 33 });
    const hosts = await w.pool(['r', 'a', 'm']);
    const s = hosts.find((h) => h.name === last);
    for (const h of hosts) if (h !== s) w.net.kill(h.name);
    s.slots = 1;
    let t = 0;
    for (const day of [29, 31, 61, 65]) {
      await w.run((day - t) * 24 * 3600);
      const { taskId } = await s.node.offer(offerArgs(`pr-${day}`));
      await w.run(3600);
      t = day + 1 / 24;
      assert.deepEqual([w.view(s).returning, Boolean(w.runOf(s, taskId))], [day === 31, day !== 31], `${last} day ${day}`);
      // Restarts: when it last heard the others and how long it has asked them must come from disk.
      if (day === 29 || day === 31) await w.restart(s);
    }
    await w.restart(s);
    await w.run(600);
    assert.equal(w.view(s).returning, false, `${last} restarted`);
  }
});

await check('a machine back after a month counts its month of asking only while it runs with its transport up: up an hour while nobody answers, then off, asleep or without its transport - or back by Rejoin - past the month, it still asks the others and is one pool with them, and a job offered on both sides runs once', async () => {
  for (const how of ['off', 'asleep', 'down', 'rejoin']) {
    const w = createWorld({ seed: 8 });
    const [r, a, b, m] = await w.pool(['r', 'a', 'b', 'm']);
    const others = ['r', 'a', 'b'];
    const cut = (on) => { for (const x of others) w.net.cut('m', x, on); };
    if (how === 'rejoin') {
      m.node.leave({ pool: POOL });
      await w.run(24 * 3600);
    } else {
      w.net.kill('m');
      await w.run(31 * 24 * 3600);
    }
    for (const x of others) w.net.sleep(x);
    if (how === 'rejoin') await m.node.join({ pool: POOL });
    else await w.restart(m);
    await w.run(3600);
    assert.deepEqual([w.view(m).returning, w.asks(m).back.map((e) => w.name(e.pk)).sort()], [true, ['a', 'b', 'r']], `${how}: back an hour`);
    if (how === 'asleep') w.net.sleep('m');
    else if (how === 'down') torDown(m);
    else w.net.kill('m');
    for (const x of others) w.net.sleep(x, false);
    await w.run(9 * 24 * 3600);
    w.net.kill('r');
    await w.run(22 * 24 * 3600);
    cut(true);
    if (how === 'asleep') w.net.sleep('m', false);
    else if (how === 'down') await torUp(w, m);
    else await w.restart(m);
    await w.run(3600);
    assert.deepEqual([w.view(m).returning, w.asks(m).back.map((e) => w.name(e.pk)).sort()], [true, ['a', 'b', 'r']], `${how}: up again`);
    cut(false);
    await w.net.until(() => [m, a].every((h) => w.members(h).length === 3), { maxMs: 30 * 60 * 1000, what: `${how}: one pool` });
    for (const h of [a, b, m]) h.slots = 1;
    const { taskId } = await m.node.offer(offerArgs('pr-1'));
    await w.run(1);
    await a.node.offer(offerArgs('pr-1'));
    await w.run(2 * 3600);
    assert.equal([a, b, m].filter((h) => h.executor.jobOf(taskId)).length, 1, how);
  }
});

await check('two parts of a pool cut off from each other for longer than a month, the machine that seated them gone, ask the machines they dropped once a day, restarted or not, though a member filled every machine\'s list of members it dropped with keys whose records it dated to run out, and are one pool again within a day of reaching each other: a job offered on both sides runs once', async () => {
  const day = 24 * 3600;
  const w = createWorld({ seed: 5 });
  const hosts = await w.pool(['r', 'a', 'b', 'c', 'm']);
  const [r, a, b, c, m] = hosts;
  const x = await w.intruder('x', r);
  const resign = resigner(w, x, () => [a, b, c, m]);
  const cut = (on) => { for (const p of ['a', 'b']) for (const q of ['c', 'm']) w.net.cut(p, q, on); };
  cut(true);
  await w.run(10 * day);
  w.net.kill('r');
  // r carried each part's records to the other until it stopped: they run out on day 40.
  await w.run(15 * day);
  await resign();
  await w.run(17 * day);
  assert.deepEqual([a, m].map((h) => [w.members(h), w.asks(h).back].map((list) => list.length)), [[2, 0], [2, 0]]);
  await w.restart(a);
  await resign();
  await expiring(w, x, [a, b, c, m], 110, false);
  const since = w.net.now();
  await w.run(10 * day);
  const asked = w.net.count({ from: 'a', to: 'c', since });
  assert.ok(asked >= 6 && asked <= 15 && asked === w.net.count({ from: 'a', to: 'c', kind: 'hello', since }), `a asked c ${asked} times in 10 days`);
  cut(false);
  await w.run(36 * 3600);
  for (const h of [a, b, c, m]) assert.deepEqual(w.members(h).filter((pk) => pk !== x.pk).map((pk) => w.name(pk)).sort().join(), 'a,b,c,m', h.name);
  for (const h of [a, b, c, m]) h.slots = 1;
  const { taskId } = await m.node.offer(offerArgs('pr-1'));
  await w.run(1);
  await a.node.offer(offerArgs('pr-1'));
  await w.run(2 * 3600);
  assert.equal([a, b, c, m].filter((h) => h.executor.jobOf(taskId)).length, 1);
});

await check('a machine back after a month that nobody answers waits for the machines it asks for 30 days, and then runs its jobs alone', async () => {
  const w = createWorld({ seed: 72 });
  const [r] = await w.pool(['r', 'a']);
  w.net.kill('r');
  w.net.kill('a');
  await w.run(31 * 24 * 3600);
  await w.restart(r);
  r.slots = 1;
  const { taskId } = await r.node.offer(offerArgs('pr-1'));
  await w.run(29 * 24 * 3600);
  assert.deepEqual([w.view(r).returning, w.asks(r).back.length, r.executor.jobOf(taskId)], [true, 1, undefined]);
  await w.run(24 * 3600 + 3600);
  assert.deepEqual([w.view(r).returning, w.asks(r).back, w.doc(r).returning], [false, [], false]);
  const again = await r.node.offer(offerArgs('pr-2'));
  await w.net.until(() => r.executor.jobOf(again.taskId), { maxMs: 3600 * 1000, what: 'a job running' });
});

await check('a machine asks the last 1,024 members whose records it dropped whether they are still in the pool, each about once a day, one at a time', async () => {
  const w = createWorld({ seed: 68 });
  const [a, b] = await w.pool(['a', 'b']);
  const dropped = Array.from({ length: 1100 }, () => w.net.rnd.bytes(32).toString('base64url'));
  w.net.kill('a');
  a.disk.write(poolFile(POOL), JSON.stringify({ ...w.doc(a), former: dropped }));
  await w.restart(a);
  const log = [];
  const real = a.transport.request.bind(a.transport);
  a.transport.request = (pk, ...rest) => {
    log.push(pk);
    return real(pk, ...rest);
  };
  const kept = dropped.slice(-1024);
  // All are due at once, and asked one every 84 s.
  const start = w.net.now();
  await w.run(2 * 3600);
  const burst = w.net.count({ from: 'a', kind: 'hello', since: start });
  assert.ok(burst > 60 && burst < 100, `${burst} hellos in the first two hours`);
  await w.run(10 * 3600);
  const since = w.net.now();
  await w.run(2 * 3600);
  const hellos = w.net.count({ from: 'a', kind: 'hello', since });
  assert.ok(hellos > 0 && hellos < 150, `${hellos} hellos in two hours`);
  await w.run(46 * 3600);
  const asked = new Set(log);
  assert.deepEqual([kept.filter((pk) => !asked.has(pk)).length, dropped.slice(0, -1024).filter((pk) => asked.has(pk)).length], [0, 0]);
  // Twelve hours without its transport skip nobody's turn: the first asked after was due at
  // their start.
  const down = w.net.now();
  torDown(a);
  await w.run(12 * 3600);
  const due = new Map(w.asks(a).former.map((e) => [e.pk, e.due]));
  const upAt = log.length;
  await torUp(w, a);
  await w.run(3600);
  const first = log.slice(upAt).find((pk) => kept.includes(pk));
  assert.ok(due.get(first) < down + 3600, `the first asked was due ${(due.get(first) - down) / 3600} h in`);
  // One more dropped, the earliest of them goes.
  w.net.kill('b');
  w.net.kill('a');
  await w.run(31 * 24 * 3600);
  await w.restart(a);
  assert.deepEqual([w.asks(a).former.length, w.asks(a).former.at(-1).pk, w.asks(a).former[0].pk], [1024, b.pk, dropped.at(-1023)]);
});

await check('a machine asks no member whose record it dropped once it holds a record of it again: one that left is asked nothing', async () => {
  const w = createWorld({ seed: 70 });
  const [a, , x] = await w.pool(['a', 'b', 'x']);
  x.node.leave({ pool: POOL });
  await w.run(600);
  w.net.kill('a');
  assert.ok(w.doc(a).records.some((r) => r.pk === x.pk && r.left));
  a.disk.write(poolFile(POOL), JSON.stringify({ ...w.doc(a), former: [x.pk] }));
  await w.restart(a);
  const since = w.net.now();
  await w.run(2 * 24 * 3600);
  assert.equal(w.net.count({ from: 'a', to: 'x', since }), 0);
});

await check('a member that fills its seats with new keys again and again, each asking a host something while seated, leaves no host anything to ask of them once their seats went to the next: nobody keeps their keys, works for them or writes a pool larger for them, and a machine that joins after is served as any', async () => {
  const w = createWorld({ seed: 3 });
  const [r, a, b] = await w.pool(['r', 'a', 'b']);
  const m = await w.intruder('m', r);
  await w.run(120);
  let [written, asked] = [0, 0];
  const write = a.disk.write.bind(a.disk);
  a.disk.write = (name, text) => {
    written += text.length;
    asked += name.startsWith('asks/');
    return write(name, text);
  };
  const seated = new Set();
  for (let round = 0; round < 69; round += 1) {
    const now = w.net.now();
    const keys = Array.from({ length: LIMITS.invitees }, (_, seat) => w.stranger(`s${round}-${seat}`));
    const records = keys.map((s, seat) => {
      seated.add(s.pk);
      return memberRecord(s.id, { pool: POOL, seq: 0, at: now, era: 0, maxAcceptedH: 12, voucher: createVoucher(m.id, { pool: POOL, era: 0, pk: s.pk, seat, at: now }) });
    });
    for (const h of [a, b, r]) {
      let answer = await w.request(m, h, 'push', { records }, { effort: POW.memberBase });
      for (let i = 0; i < 6 && answer.code === 'effort'; i += 1) answer = await w.request(m, h, 'push', { records }, { effort: answer.effort });
    }
    for (const s of keys) assert.equal((await w.request(s, a, 'pull', { keys: [] })).ok, true);
    await w.run(15);
  }
  const { back, former } = w.asks(a);
  assert.deepEqual([...back, ...former].filter((e) => seated.has(e.pk)).length, 0);
  assert.ok(written < 512 * 1024, `${written} bytes written in 17 minutes`);
  assert.equal(asked, 0, 'what a asks is not written again unchanged');
  await w.run(3600);
  const paid = a.solved.length;
  await w.run(3600);
  const hour = a.solved.slice(paid).reduce((x, y) => x + y, 0);
  assert.ok(hour <= POW_HOURLY.search, `${hour / POW_HOURLY.all} of an hour's work paid in an hour`);
  const n = w.add('n', { slots: 0 });
  await w.start(n);
  await n.node.join(r.node.invite({ pool: POOL }));
  const since = w.net.now();
  await w.run(3600);
  assert.ok(w.net.count({ from: 'a', to: 'n', since }) >= 30, `a asked the newcomer ${w.net.count({ from: 'a', to: 'n', since })} times in its first hour`);
});

await check('the search pays at most an eighth of a host\'s hour of work, and a key that asks it for more work is asked nothing more that day', async () => {
  const w = createWorld({ seed: 11 });
  const [a] = await w.pool(['a', 'b']);
  const most = Math.max(POW.memberBase * 2 ** POW.memberCap, POW.strangerBase * 2 ** POW.strangerCap);
  const asked = new Map();
  const paid = [];
  w.net.tap(({ from, to, body }) => {
    if (from === 'a' && to?.startsWith('k')) paid.push([w.net.now(), JSON.parse(body.toString('utf8')).pow.effort]);
  });
  const keys = Array.from({ length: 200 }, (_, i) => {
    const s = w.stranger(`k${i}`);
    s.transport.onRequest(async (buf) => {
      const request = JSON.parse(buf.toString('utf8'));
      asked.set(s.pk, (asked.get(s.pk) ?? 0) + 1);
      return canon(buildResponse(s.id, { re: requestDigest(request), error: { code: 'effort', detail: 'more' }, effort: most }));
    });
    return s.pk;
  });
  w.net.kill('a');
  a.disk.write(poolFile(POOL), JSON.stringify({ ...w.doc(a), former: keys }));
  await w.restart(a);
  await w.run(30 * 3600);
  const hour = Math.max(...paid.map(([at]) => paid.filter(([t]) => t >= at && t < at + 3600).reduce((x, [, e]) => x + e, 0)));
  assert.ok(hour <= POW_HOURLY.search, `${hour / POW_HOURLY.all} of an hour's work paid for the search in an hour`);
  assert.ok(Math.max(...asked.values()) <= 2, `a key was asked ${Math.max(...asked.values())} times in 30 hours`);
});

await check('two parts of a pool cut off from each other for longer than a month, their machines up for 10 hours a day, are one pool again within about a day of reaching each other', async () => {
  const w = createWorld({ seed: 5 });
  const hosts = await w.pool(['r', 'a', 'b', 'c', 'm']);
  const [r, a, b, c, m] = hosts;
  const cut = (on) => { for (const x of ['a', 'b']) for (const y of ['c', 'm']) w.net.cut(x, y, on); };
  cut(true);
  await w.run(10 * 24 * 3600);
  w.net.kill('r');
  await w.run(30 * 24 * 3600);
  cut(false);
  const live = [a, b, c, m];
  for (let day = 0; day < 2; day += 1) {
    for (const h of live) await w.restart(h);
    await w.run(10 * 3600);
    for (const h of live) w.net.kill(h.name);
    await w.run(14 * 3600);
  }
  for (const h of live) await w.restart(h);
  await w.run(600);
  for (const h of live) assert.deepEqual(w.members(h).map((pk) => w.name(pk)).sort().join(), 'a,b,c,m', h.name);
  for (const h of live) h.slots = 1;
  const { taskId } = await m.node.offer(offerArgs('pr-1'));
  await w.run(1);
  await a.node.offer(offerArgs('pr-1'));
  await w.run(2 * 3600);
  assert.equal(live.filter((h) => h.executor.jobOf(taskId)).length, 1);
});

await check('a key whose record ran out that answers a machine\'s search counts for no machine of the pool until it holds a seat: cut off from the others, the machine still comes back after a month, and the key is pushed none of its offers or claims', async () => {
  const w = createWorld({ seed: 4 });
  const [r, a, b] = await w.pool(['r', 'a', 'b']);
  for (const h of [r, a, b]) h.slots = 4;
  const m = await w.intruder('m', r);
  // a looks only for a member it heard from.
  assert.equal((await w.request(m, a, 'pull', { keys: [] })).ok, true);
  await w.run(31 * 24 * 3600);
  assert.deepEqual(w.asks(a).former.map((e) => e.pk), [m.pk]);
  const pushed = [];
  m.transport.onRequest(async (buf) => {
    const request = JSON.parse(buf.toString('utf8'));
    pushed.push(...(request.body?.records ?? []).map((x) => x.type));
    return canon(buildResponse(m.id, { re: requestDigest(request), body: { index: {} }, effort: POW.strangerBase }));
  });
  for (const x of ['r', 'b']) w.net.cut('a', x, true);
  await w.run(31 * 24 * 3600);
  const { taskId } = await a.node.offer(offerArgs('pr-1'));
  await w.run(1);
  await r.node.offer(offerArgs('pr-1'));
  await w.run(2 * 3600);
  const ran = [r, a, b].filter((h) => h.executor.jobOf(taskId)).map((h) => h.name);
  assert.deepEqual([w.view(a).returning, ran.length, ran.includes('a')], [true, 1, false]);
  assert.deepEqual(pushed.filter((type) => type !== 'member'), []);
});

await check('a machine asks at most 241 machines besides the members whose records it holds: of more, the ones it began asking last', async () => {
  const w = createWorld({ seed: 43 });
  const [a, b, c] = await w.pool(['a', 'b', 'c']);
  for (const h of [a, b, c]) w.net.kill(h.name);
  await w.run(31 * 24 * 3600);
  const online = w.heard(a)?.online ?? 0;
  const keys = Array.from({ length: LIMITS.members }, (_, i) => w.stranger(`k${i}`).pk);
  a.disk.write(asksFile(POOL), JSON.stringify({ back: keys.map((pk) => ({ pk, from: online - 1 })), former: [] }));
  await w.restart(a);
  await w.run(1);
  const back = w.asks(a).back.map((e) => e.pk);
  assert.deepEqual([back.length, back.includes(b.pk), back.includes(c.pk)], [LIMITS.members, true, true]);
});

await check('a machine that starts with a record in its store whose seat another holds does not look for its key', async () => {
  const w = createWorld({ seed: 41 });
  const [a] = await w.pool(['a', 'b']);
  const m = await w.intruder('m', a);
  const seated = (name) => {
    const s = w.stranger(name);
    const now = w.net.now();
    return memberRecord(s.id, { pool: POOL, seq: 0, at: now, era: 0, maxAcceptedH: 12, voucher: createVoucher(m.id, { pool: POOL, era: 0, pk: s.pk, seat: 0, at: now }) });
  };
  const first = seated('s1');
  assert.deepEqual((await w.request(m, a, 'push', { records: [first] }, { effort: 2 ** 16 })).body.refused, []);
  await w.run(60);
  w.net.kill('a');
  const doc = w.doc(a);
  const second = seated('s2');
  a.disk.write(poolFile(POOL), JSON.stringify({ ...doc, records: [...doc.records, second] }));
  await w.restart(a);
  await w.run(1);
  const keys = [first.pk, second.pk];
  const { back, former } = w.asks(a);
  assert.deepEqual([[...back, ...former].filter((e) => keys.includes(e.pk)), w.members(a).filter((pk) => keys.includes(pk))], [[], [second.pk]]);
});

await check('a machine back after a month pushes a machine it asks that it holds no member record of its own member records alone', async () => {
  const w = createWorld({ seed: 6 });
  const [r, a, b] = await w.pool(['r', 'a', 'b']);
  a.slots = 1;
  const [m, n] = [await w.intruder('m', r), await w.intruder('n', r)];
  const pushed = [];
  for (const x of [m, n]) {
    x.transport.onRequest(async (buf) => {
      const request = JSON.parse(buf.toString('utf8'));
      pushed.push(...(request.body?.records ?? []));
      if (x === n) throw new Error('n answers nothing');
      return canon(buildResponse(x.id, { re: requestDigest(request), body: { index: {}, accepted: [], refused: [] }, effort: POW.memberBase }));
    });
  }
  await w.run(60);
  for (const x of ['r', 'b', 'm', 'n']) w.net.cut('a', x, true);
  await w.run(31 * 24 * 3600);
  assert.deepEqual([w.view(a).returning, [m.pk, n.pk].filter((pk) => w.asks(a).back.some((e) => e.pk === pk)).length], [true, 2]);
  for (const x of ['m', 'n']) w.net.cut('a', x, false);
  await a.node.offer(offerArgs('pr-1'));
  await w.run(3600);
  a.node.leave({ pool: POOL });
  await w.run(600);
  assert.deepEqual([pushed.filter((x) => x.type !== 'member'), pushed.some((x) => x.pk === a.pk && x.left)], [[], true]);
});

await check('a machine restarted every two hours greets a key whose record ran out about once a day, as one that runs on', async () => {
  const w = createWorld({ seed: 23 });
  const [a, , x] = await w.pool(['a', 'b', 'x']);
  w.net.kill('x');
  const killed = w.net.now();
  // It is first greeted half a day after its record ran out.
  await w.net.until(() => w.asks(a).former.length > 0, { maxMs: 40 * 24 * 3600 * 1000, stepMs: 10000, what: 'x dropped' });
  assert.deepEqual(w.asks(a).former.map((e) => [e.pk, e.due - w.net.now() > 12 * 3600 - 20]), [[x.pk, true]]);
  await w.run(killed + 40 * 24 * 3600 - w.net.now());
  const since = w.net.now();
  for (let i = 0; i < 24; i += 1) {
    await w.run(2 * 3600 - 60);
    w.net.kill('a');
    await w.run(60);
    await w.restart(a);
  }
  const hellos = w.net.count({ from: 'a', to: 'x', kind: 'hello', since });
  assert.ok(hellos >= 1 && hellos <= 3, `${hellos} hellos in 2 days`);
});

await check('a member whose record saying it left runs out is not looked for', async () => {
  const w = createWorld({ seed: 21 });
  const [a, , x] = await w.pool(['a', 'b', 'x']);
  x.node.leave({ pool: POOL });
  await w.run(29 * 24 * 3600);
  const since = w.net.now();
  await w.run(6 * 24 * 3600);
  assert.deepEqual([w.asks(a).former, w.net.count({ from: 'a', to: 'x', since })], [[], 0]);
});

await check('a clock set back while a machine comes back takes nothing off the month it asks for', async () => {
  const w = createWorld({ seed: 72 });
  const [r] = await w.pool(['r', 'a']);
  w.net.kill('r');
  w.net.kill('a');
  await w.run(31 * 24 * 3600);
  await w.restart(r);
  await w.run(24 * 3600);
  assert.equal(w.view(r).returning, true);
  r.skew = -10 * 24 * 3600;
  await w.run(31 * 24 * 3600);
  assert.equal(w.view(r).returning, false);
});

await check('a back list a store before this one kept with when each was asked until is asked for a month afresh, run out or not', async () => {
  const w = createWorld({ seed: 69 });
  const [a, b] = await w.pool(['a', 'b']);
  w.net.kill('b');
  w.net.kill('a');
  a.disk.write(poolFile(POOL), JSON.stringify({ ...w.doc(a), returning: true, back: [{ pk: b.pk, until: w.net.now() - 3600 }] }));
  await w.restart(a);
  await w.run(29 * 24 * 3600);
  assert.deepEqual([w.view(a).returning, w.asks(a).back.map((e) => e.pk)], [true, [b.pk]]);
  await w.run(2 * 24 * 3600);
  assert.equal(w.view(a).returning, false);
});

await check('a back list written as bare keys is read as nothing to ask', async () => {
  const w = createWorld({ seed: 67 });
  const [a, b] = await w.pool(['a', 'b']);
  const nobody = w.add('nobody');
  w.net.kill('a');
  const file = [...a.disk.files.keys()].find((name) => name.startsWith('pools/'));
  const { returning, ...doc } = w.doc(a);
  assert.equal(returning, false);
  a.disk.write(file, JSON.stringify({ ...doc, back: [nobody.pk, b.pk] }));
  await w.restart(a);
  await w.run(600);
  assert.deepEqual([w.view(a).returning, w.members(a), w.net.count({ to: 'nobody' })], [false, [a.pk, b.pk].sort(), 0]);
});

await check('a machine back after a month that was answered is back after a restart, whoever is up: what it was told is on disk at once', async () => {
  const w = createWorld({ seed: 65 });
  const [r, a] = await w.pool(['r', 'a']);
  w.net.kill('r');
  w.net.kill('a');
  await w.run(31 * 24 * 3600);
  await w.restart(r);
  assert.deepEqual([w.doc(r).returning, w.asks(r).back.map((e) => e.pk)], [true, [a.pk]], 'it is coming back, and asks a');
  await w.restart(a);
  await w.net.until(() => !w.view(r).returning && !w.view(a).returning, { maxMs: 3600 * 1000, what: 'both answered' });
  await w.run(60);
  assert.deepEqual([w.doc(r).returning, w.asks(r).back], [false, []]);
  w.net.kill('a');
  await w.run(600);
  await w.restart(r);
  await w.run(600);
  assert.equal(w.view(r).returning, false);
  r.slots = 1;
  const { taskId } = await r.node.offer(offerArgs('pr-1'));
  await w.net.until(() => r.executor.jobOf(taskId), { maxMs: 3600 * 1000, what: 'its job running' });
});

await check('a machine back in a pool it left, refused by every machine it left, reads in its row that it has no seat there', async () => {
  const w = createWorld({ seed: 45 });
  const [a, b] = await w.pool(['a', 'b']);
  a.node.leave({ pool: POOL });
  await w.run(31 * 24 * 3600);
  // b begins the pool again meanwhile.
  b.node.setPools([]);
  b.node.setPools(b.pools);
  await a.node.join({ pool: POOL });
  await w.net.until(() => w.view(a).unseated, { maxMs: 10 * 60 * 1000, what: 'its row saying it has no seat' });
  assert.deepEqual([w.view(a).returning, w.members(a), w.members(b)], [true, [a.pk], [b.pk]]);
  // A machine that refused it is asked again every 10 minutes, not at every sync.
  const since = w.net.now();
  await w.run(1800);
  const hellos = w.net.count({ from: 'a', to: 'b', kind: 'hello', since });
  assert.ok(hellos >= 2 && hellos <= 4, `${hellos} in 30 minutes`);
});

await check('a machine back an hour after it left is back as soon as a member answers its sync, and takes the pool\'s jobs again', async () => {
  const w = createWorld({ seed: 48 });
  const [a, b] = await w.pool(['a', 'b']);
  // b never hears that a left: it holds a for a member all along.
  w.net.cut('a', 'b');
  a.node.leave({ pool: POOL });
  await w.run(3600);
  await a.node.join({ pool: POOL });
  await w.run(600);
  assert.equal(w.view(a).returning, true);
  const since = w.net.now();
  w.net.cut('a', 'b', false);
  await w.net.until(() => !w.view(a).returning, { maxMs: 10 * 60 * 1000, what: 'an answer' });
  assert.equal(w.net.count({ from: 'a', to: 'b', kind: 'hello', since }), 0, 'a sync, answered');
  await w.run(60);
  assert.equal(w.doc(a).returning, false);
  a.slots = 1;
  const { taskId } = await b.node.offer(offerArgs('pr-1'));
  await w.net.until(() => a.executor.jobOf(taskId), { maxMs: 10 * 60 * 1000, what: 'the job running at a' });
});

await check('a machine that starts after a month asks none of the machines it holds only as having left, nor one whose stored record does not hold: alone in its pool, it runs its jobs', async () => {
  const w = createWorld({ seed: 49 });
  const all = await w.pool(['a', 'b', 'c']);
  const [a, b, c] = all;
  c.node.leave({ pool: POOL });
  await w.net.until(() => w.members(a).length === 2, { what: 'c gone' });
  for (const h of all) w.net.kill(h.name);
  await w.run(31 * 24 * 3600);
  const file = [...a.disk.files.keys()].find((name) => name.startsWith('pools/'));
  const doc = w.doc(a);
  const records = doc.records.map((r) => (r.pk === b.pk ? { ...r, at: r.at + 1 } : r));
  assert.deepEqual(records.filter((r) => r.type === 'member' && r.pk !== a.pk).map((r) => [r.pk, !!r.left]).sort(), [[b.pk, false], [c.pk, true]].sort());
  a.disk.write(file, JSON.stringify({ ...doc, records }));
  await w.restart(a);
  await w.run(600);
  assert.deepEqual([w.view(a).returning, w.members(a)], [false, [a.pk]]);
  a.slots = 1;
  const { taskId } = await a.node.offer(offerArgs('pr-1'));
  await w.net.until(() => a.executor.jobOf(taskId), { maxMs: 10 * 60 * 1000, what: 'its job running' });
});

await check('a machine back in a pool whose hellos are refused for its clock is still coming back, not without a seat: it asks again every 10 minutes and is in once its clock is right', async () => {
  const w = createWorld({ seed: 47 });
  const [a, b] = await w.pool(['a', 'b']);
  a.node.leave({ pool: POOL });
  await w.run(31 * 24 * 3600);
  a.skew = 400;
  await a.node.join({ pool: POOL });
  const since = w.net.now();
  await w.run(1800);
  const hellos = w.net.count({ from: 'a', to: 'b', kind: 'hello', since });
  assert.ok(hellos >= 2 && hellos <= 4, `${hellos} in 30 minutes`);
  assert.deepEqual([w.view(a).returning, w.view(a).unseated, w.members(a)], [true, false, [a.pk]]);
  a.skew = 0;
  await w.net.until(() => w.members(a).length === 2 && w.members(b).length === 2, { maxMs: 15 * 60 * 1000, what: 'a back' });
  assert.deepEqual([w.view(a).returning, w.view(a).unseated], [false, false]);
});

await check('an invite its maker could not serve this once is asked about again: the maker had just started, and serves nothing dated up to what it served in its life before', async () => {
  const w = createWorld({ seed: 46 });
  const [a, b] = await w.pool(['a', 'b']);
  const c = w.add('c');
  await w.start(c);
  c.skew = -20;
  assert.equal((await w.request(b, a, 'sync', { asOf: w.net.now(), hash: w.view(b).hash })).ok, true);
  await w.restart(a);
  const since = w.net.now();
  const { invite } = a.node.invite({ pool: POOL });
  const first = await w.request(c, a, 'hello', { invite }, { effort: 2 ** 16, ts: w.net.now() - 20 });
  assert.deepEqual([first.code, first.detail], ['busy', UNSERVED]);
  await c.node.join({ invite });
  await w.net.until(() => w.members(a).includes(c.pk), { maxMs: 60 * 1000, what: 'c let in within the minute' });
  assert.deepEqual([w.view(c).joining, w.view(c).joinFailed, w.net.count({ from: 'c', to: 'a', kind: 'hello', since }) > 3], [false, '', true]);
});

// Re-signs x's member record and pushes it, as a running member does.
function resigner(w, x, hosts) {
  let seq = 1;
  return async () => {
    x.member = memberRecord(x.id, { pool: POOL, seq: seq++, at: w.net.now(), era: 0, maxAcceptedH: 12, voucher: x.member.voucher });
    for (const h of hosts()) await pushAs(w, x, h, [x.member]);
  };
}
async function pushAs(w, x, to, records) {
  let answer = await w.request(x, to, 'push', { records }, { effort: POW.memberBase });
  for (let i = 0; i < 6 && answer.code === 'effort'; i += 1) answer = await w.request(x, to, 'push', { records }, { effort: answer.effort });
  return answer;
}
// `rounds` rounds of 15 keys `x` seats, every 15 s, dated to run out at once; when
// `speaking`, every other round's keys ask each host something while still held.
async function expiring(w, x, hosts, rounds, speaking) {
  const keys = new Set();
  for (let round = 0; round < rounds; round += 1) {
    const speak = speaking && round % 2 === 1;
    const at = w.net.now() - MEMBER_RETENTION_SECS + (speak ? 60 : -290);
    const seated = Array.from({ length: LIMITS.invitees }, (_, seat) => {
      const s = w.stranger(`${x.name}${round}-${seat}`);
      s.transport.host.ready = speak;
      keys.add(s.pk);
      const voucher = createVoucher(x.id, { pool: POOL, era: 0, pk: s.pk, seat, at });
      return [s, memberRecord(s.id, { pool: POOL, seq: 0, at, era: 0, maxAcceptedH: 12, voucher })];
    });
    for (const h of hosts) await pushAs(w, x, h, seated.map(([, record]) => record));
    if (speak) {
      for (const [s] of seated) for (const h of hosts) assert.equal((await w.request(s, h, 'pull', { keys: [] })).ok, true);
    }
    await w.run(15);
  }
  return keys;
}

await check('a member that seats key after key whose records it dated to run out leaves no machine looking for them, whether they spoke first or not: the member a machine dropped is still looked for, by the machines it spoke to', async () => {
  const w = createWorld({ seed: 3 });
  const hosts = await w.pool(['r', 'a', 'b', 'c']);
  const [r, a, b, c] = hosts;
  // q says hello to a alone, and nothing after.
  const q = await w.intruder('q', a);
  const seatedBy = w.records(a).find((x) => x.pk === c.pk).voucher.by;
  await w.run(700);
  // Off for a month: every record of the others runs out.
  for (const h of hosts) w.net.kill(h.name);
  await w.run(31 * 24 * 3600);
  for (const h of [r, a, b]) await w.restart(h);
  await w.run(600);
  const m = await w.intruder('m', r);
  await resigner(w, m, () => [r, a, b])();
  const former = (h) => w.asks(h).former.map((e) => e.pk).filter((pk) => ![r, a, b].some((x) => x.pk === pk)).sort();
  assert.deepEqual([r, a, b].map(former), [[c.pk], [c.pk, q.pk].sort(), [c.pk]]);
  assert.deepEqual(w.asks(a).former.filter((e) => [c.pk, q.pk].includes(e.pk)).map((e) => [e.pk, e.by]).sort(), [[c.pk, seatedBy], [q.pk, a.pk]].sort());
  const keys = await expiring(w, m, [r, a, b], 70, true);
  await w.run(700);
  for (const h of [r, a, b]) assert.deepEqual([former(h).filter((pk) => keys.has(pk)), w.asks(h).back.filter((e) => keys.has(e.pk))], [[], []], h.name);
  assert.deepEqual([former(a), w.heard(a).met.sort()], [[c.pk, q.pk].sort(), [r.pk, b.pk, m.pk].sort()]);
});

await check('a machine looks for the latest 15 members one member seated, and the members of one that seated fewer than its share are pushed out by none', async () => {
  const w = createWorld({ seed: 31 });
  const [a] = await w.pool(['a', 'b']);
  const looked = async (former) => {
    w.net.kill('a');
    const due = w.net.now() + 20 * 3600;
    // The first is due now: asking it moves a `due`, so the list is written.
    a.disk.write(asksFile(POOL), JSON.stringify({ back: [], former: former.map(([pk, by], i) => ({ pk, by, due: i === 0 ? w.net.now() : due })) }));
    await w.restart(a);
    await w.run(900);
    return w.asks(a).former.map((e) => e.pk);
  };
  const of = (by, n) => Array.from({ length: n }, (_, i) => [`${by}-${i}`, by]);
  assert.deepEqual(await looked([['y-0', 'y'], ...of('x', 20)]), ['y-0', ...of('x', 20).slice(5).map(([pk]) => pk)]);
  // 72 seaters, 71 of them with 15 keys: past 1,024, the earliest of each goes, one by one,
  // while it holds more than an even share.
  const many = [...of('x', 15), ...Array.from({ length: 70 }, (_, i) => of(`r${i}`, 15)).flat()];
  const pushed = new Set(['x-0', ...Array.from({ length: 41 }, (_, i) => `r${i}-0`)]);
  assert.deepEqual(await looked([['y-0', 'y'], ...many]), ['y-0', ...many.map(([pk]) => pk).filter((pk) => !pushed.has(pk))]);
});

await check('keys a machine looks for that answer its hello and then ask for the most work are paid out of the search\'s eighth of its hour, and no request to them is sent again for more work', async () => {
  const w = createWorld({ seed: 11 });
  const [a] = await w.pool(['a', 'b']);
  const most = Math.max(POW.memberBase * 2 ** POW.memberCap, POW.strangerBase * 2 ** POW.strangerCap);
  const lacked = Array.from({ length: 1500 }, () => `member/${w.stranger('lacked').pk}`).sort();
  const page = (after) => ({ index: Object.fromEntries(lacked.filter((k) => k > after).slice(0, 100).map((k) => [k, [[w.net.now() - 60], b64u(w.net.rnd.bytes(32))]])), more: true });
  const sent = new Map();
  const paid = [];
  w.net.tap(({ from, to, body }) => {
    if (from !== 'a' || !to?.startsWith('k')) return;
    const request = JSON.parse(body.toString('utf8'));
    paid.push([w.net.now(), request.pow.effort]);
    sent.set(to, [...(sent.get(to) ?? []), JSON.stringify([request.kind, request.body])]);
  });
  const keys = Array.from({ length: 200 }, (_, i) => {
    const s = w.stranger(`k${i}`);
    s.transport.onRequest(async (buf) => {
      const request = JSON.parse(buf.toString('utf8'));
      const re = requestDigest(request);
      if (request.kind === 'pull') return canon(buildResponse(s.id, { re, error: { code: 'effort', detail: 'more' }, effort: most }));
      const body = request.kind === 'sync' ? { hash: b64u(w.net.rnd.bytes(32)), ...page(request.body.after ?? '') } : page('');
      return canon(buildResponse(s.id, { re, body, effort: POW.strangerBase }));
    });
    return s.pk;
  });
  w.net.kill('a');
  a.disk.write(poolFile(POOL), JSON.stringify({ ...w.doc(a), former: keys }));
  await w.restart(a);
  await w.run(30 * 3600);
  const hour = Math.max(...paid.map(([at]) => paid.filter(([t]) => t >= at && t < at + 3600).reduce((x, [, e]) => x + e, 0)));
  assert.ok(hour <= POW_HOURLY.search, `${hour / POW_HOURLY.all} of an hour's work paid for the search in an hour`);
  const again = [...sent.values()].reduce((n, list) => n + list.filter((x, i) => i > 0 && x === list[i - 1]).length, 0);
  assert.deepEqual([again, [...sent.values()].some((list) => list.some((x) => x.startsWith('["pull"')))], [0, true]);
});

// Restarts `h` with `asks` as the hosts it asks besides its members.
async function asking(w, h, asks) {
  w.net.kill(h.name);
  h.disk.write(asksFile(POOL), JSON.stringify({ back: [], former: [], ...asks }));
  await w.restart(h);
}
const goneFor = (w, names) => names.map((name) => {
  const s = w.stranger(name);
  w.net.kill(name);
  return s;
});

// `n` keys that answer with endless pages of lacked keys and demand the most work: each
// greeting of one takes the whole of the search's eighth for an hour.
function draining(w, n) {
  const most = Math.max(POW.memberBase * 2 ** POW.memberCap, POW.strangerBase * 2 ** POW.strangerCap);
  const lacked = Array.from({ length: 1500 }, () => `member/${w.stranger('lacked').pk}`).sort();
  const page = (after) => ({ index: Object.fromEntries(lacked.filter((k) => k > after).slice(0, 100).map((k) => [k, [[w.net.now() - 60], b64u(w.net.rnd.bytes(32))]])), more: true });
  return Array.from({ length: n }, (_, i) => {
    const s = w.stranger(`k${i}`);
    s.transport.onRequest(async (buf) => {
      const request = JSON.parse(buf.toString('utf8'));
      const body = request.kind === 'hello' ? page('') : request.kind === 'sync' ? { hash: b64u(w.net.rnd.bytes(32)), ...page(request.body.after ?? '') } : { records: [] };
      return canon(buildResponse(s.id, { re: requestDigest(request), body, effort: most }));
    });
    return s;
  });
}
const spread = (w, keys, by) => keys.map((s) => ({ pk: s.pk, by, due: w.net.now() + Math.floor(w.net.rnd.next() * 24 * 3600) }));

await check('a machine whose search keys of one member take the whole of the search\'s eighth redeems an invite into another pool at once', async () => {
  const w = createWorld({ seed: 23 });
  const [a] = await w.pool(['a', 'b']);
  const link = { id: 'github.com/acme/gadgets', path: '/repos/gadgets', forge: 'github', identity: 'Octocat' };
  const z = w.add('z', { pools: [link] });
  await w.start(z);
  await asking(w, a, { former: spread(w, draining(w, LIMITS.invitees), 'x') });
  await w.run(2 * 24 * 3600);
  const { pools } = a;
  const took = [];
  for (let trial = 0; trial < 8; trial += 1) {
    const { invite } = z.node.invite({ pool: link.id });
    a.node.setPools([...pools, link]);
    const start = w.net.now();
    await a.node.join({ invite });
    const joined = () => a.node.snapshot().pools.find((p) => p.id === link.id)?.members.some((m) => m.pk === z.pk);
    await w.net.until(joined, { maxMs: 2 * 3600 * 1000, what: 'a in the other pool' });
    took.push(w.net.now() - start);
    a.node.setPools(pools);
    await w.run(3 * 3600);
  }
  assert.ok(took.every((secs) => secs <= 60), `took ${took.join(' ')} s`);
});

await check('a machine coming back to its pool pays a key it is back to out of the whole of its hour, each request once, and out of the search\'s eighth once it is back', async () => {
  const w = createWorld({ seed: 37 });
  const [a] = await w.pool(['a', 'b']);
  w.net.kill('b');
  // It asks the most work for anything, so a pays it whatever is left of the purse it pays from.
  const most = Math.max(POW.memberBase * 2 ** POW.memberCap, POW.strangerBase * 2 ** POW.strangerCap);
  const k = w.stranger('kb');
  k.transport.onRequest(async (buf) => {
    const request = JSON.parse(buf.toString('utf8'));
    return canon(buildResponse(k.id, { re: requestDigest(request), error: { code: 'effort', detail: '' }, effort: most }));
  });
  w.net.kill('a');
  a.disk.write(poolFile(POOL), JSON.stringify({ ...w.doc(a), returning: true }));
  await asking(w, a, { back: [{ pk: k.pk, from: 0 }] });
  const sent = [];
  w.net.tap(({ from, to }) => from === 'a' && to === 'kb' && sent.push(w.net.ms()));
  await w.run(3600);
  const since = w.net.now();
  await w.run(3600);
  // Not resent at once: the next request pays what was asked.
  const again = sent.filter((ms, i) => i > 0 && ms - sent[i - 1] < 1000).length;
  assert.deepEqual([w.view(a).returning, w.net.count({ from: 'a', to: 'kb', since }) > POW_HOURLY.search / most, again], [true, true, 0]);
  w.net.kill('a');
  a.disk.write(poolFile(POOL), JSON.stringify({ ...w.doc(a), returning: false }));
  await w.restart(a);
  await w.run(3600);
  const after = w.net.now();
  await w.run(3600);
  assert.deepEqual([w.view(a).returning, w.asks(a).back.length, w.net.count({ from: 'a', to: 'kb', since: after }) <= POW_HOURLY.search / most], [false, 1, true]);
});

await check('the keys one member seated take no more of the search\'s eighth than an even share: the machine still asks the keys another seated', async () => {
  const w = createWorld({ seed: 29 });
  const [a] = await w.pool(['a', 'b']);
  const gone = goneFor(w, ['y0', 'y1', 'y2', 'y3', 'y4']);
  const paid = [];
  w.net.tap(({ from, to, body }) => from === 'a' && /^k\d/.test(to ?? '') && paid.push([w.net.now(), JSON.parse(body.toString('utf8')).pow.effort]));
  await asking(w, a, { former: [...spread(w, draining(w, LIMITS.invitees), 'x'), ...spread(w, gone, 'y')] });
  // Each move of a y key's `due` is a turn, and each turn must be one hello.
  const since = w.net.now();
  const turns = new Map(gone.map((s) => [s.pk, 0]));
  let dues = new Map();
  for (let t = 0; t < 4.5 * 24 * 6; t += 1) {
    await w.run(600);
    const now = new Map(w.asks(a).former.filter((e) => e.by === 'y').map((e) => [e.pk, e.due]));
    for (const [pk, due] of now) if (dues.has(pk) && dues.get(pk) !== due) turns.set(pk, turns.get(pk) + 1);
    dues = now;
  }
  const hellos = gone.map((s) => w.net.count({ from: 'a', to: s.name, kind: 'hello', since }));
  assert.deepEqual(hellos, [...turns.values()]);
  // Two members seated them: x's share is half the eighth, or one request at the most.
  const most = Math.max(POW.memberBase * 2 ** POW.memberCap, POW.strangerBase * 2 ** POW.strangerCap);
  const hour = Math.max(...paid.map(([at]) => paid.filter(([t]) => t >= at && t < at + 3600).reduce((x, [, e]) => x + e, 0)));
  assert.ok(hour <= Math.max(POW_HOURLY.search / 2, most), `${hour / POW_HOURLY.search} of the eighth paid x's keys in an hour`);
});

// Returns what `a` paid the keys `pattern` matches in its dearest hour.
function dearest(w, pattern) {
  const paid = [];
  w.net.tap(({ from, to, body }) => from === 'a' && pattern.test(to ?? '') && paid.push([w.net.now(), JSON.parse(body.toString('utf8')).pow.effort]));
  return () => Math.max(0, ...paid.map(([at]) => paid.filter(([t]) => t >= at && t < at + 3600).reduce((x, [, e]) => x + e, 0)));
}

await check('the members that seated the keys a machine looks for in every pool it is in count towards the share of each: one member\'s keys in one pool, beside sixteen members\' in another, take no more than one request at the most in an hour', async () => {
  const w = createWorld({ seed: 31 });
  const [a] = await w.pool(['a', 'b']);
  const other = { id: 'github.com/acme/other', path: '/repos/other', forge: 'github', identity: 'Octocat' };
  a.pools = [...a.pools, other];
  a.node.setPools(a.pools);
  await w.run(5);
  const hour = dearest(w, /^k\d/);
  const gone = goneFor(w, Array.from({ length: 16 }, (_, i) => `y${i}`));
  w.net.kill('a');
  a.disk.write(asksFile(POOL), JSON.stringify({ back: [], former: spread(w, draining(w, LIMITS.invitees), 'x') }));
  a.disk.write(asksFile(other.id), JSON.stringify({ back: [], former: gone.map((s, i) => ({ pk: s.pk, by: `y${i}`, due: w.net.now() + 3600 })) }));
  await w.restart(a);
  await w.run(2 * 24 * 3600);
  const most = Math.max(POW.memberBase * 2 ** POW.memberCap, POW.strangerBase * 2 ** POW.strangerCap);
  assert.ok(hour() <= Math.max(POW_HOURLY.search / 17, most), `${hour() / POW_HOURLY.search} of the eighth paid x's keys in an hour`);
});

await check('however many members seated the keys a machine looks for, it pays them no more than the whole of its hour, and redeems an invite into another pool at once', async () => {
  const w = createWorld({ seed: 39 });
  const [a] = await w.pool(['a', 'b']);
  const hour = dearest(w, /^k\d/);
  // Sixty seaters: one max-price request an hour each would be more than the whole hour.
  // The second day greets keys at the price they asked the first.
  const keys = draining(w, 60 * LIMITS.invitees);
  await asking(w, a, { former: keys.flatMap((s, i) => spread(w, [s], `x${i % 60}`)) });
  await w.run(48 * 3600);
  const link = { id: 'github.com/acme/gadgets', path: '/repos/gadgets', forge: 'github', identity: 'Octocat' };
  const z = w.add('z', { pools: [link] });
  await w.start(z);
  a.node.setPools([...a.pools, link]);
  const start = w.net.now();
  await a.node.join(z.node.invite({ pool: link.id }));
  await w.net.until(() => a.node.snapshot().pools.find((p) => p.id === link.id)?.members.some((m) => m.pk === z.pk), { what: 'a in z\'s pool' });
  assert.deepEqual([hour() > POW_HOURLY.search, hour() <= POW_HOURLY.all, w.net.now() - start <= 60], [true, true, true], `${hour() / POW_HOURLY.all} of the whole hour paid them, the invite redeemed in ${w.net.now() - start} s`);
});

await check('a key that asks the most work there is is still asked each time it is due, though four members seated the keys a machine looks for', async () => {
  const w = createWorld({ seed: 41 });
  const [a] = await w.pool(['a', 'b']);
  const most = Math.max(POW.memberBase * 2 ** POW.memberCap, POW.strangerBase * 2 ** POW.strangerCap);
  const t = w.stranger('t');
  t.transport.onRequest(async (buf) => {
    const request = JSON.parse(buf.toString('utf8'));
    return canon(buildResponse(t.id, { re: requestDigest(request), body: { index: {}, more: false }, effort: most }));
  });
  const others = goneFor(w, ['x1', 'x2', 'x3']);
  await asking(w, a, { former: [{ pk: t.pk, by: 'y', due: w.net.now() }, ...others.map((s, i) => ({ pk: s.pk, by: `x${i + 1}`, due: w.net.now() + 3600 }))] });
  const since = w.net.now();
  let turns = 0;
  let due = null;
  for (let i = 0; i < 4.5 * 24 * 6; i += 1) {
    await w.run(600);
    const now = w.asks(a).former.find((e) => e.pk === t.pk).due;
    if (due !== null && now !== due) turns += 1;
    due = now;
  }
  const hellos = w.net.count({ from: 'a', to: 't', kind: 'hello', since });
  assert.ok(turns >= 3 && hellos === turns + 1, `${hellos} hellos in ${turns} turns and the first`);
});

await check('a key that asked the most work once is asked at the base price a day later', async () => {
  const w = createWorld({ seed: 43 });
  const [a] = await w.pool(['a', 'b']);
  const most = Math.max(POW.memberBase * 2 ** POW.memberCap, POW.strangerBase * 2 ** POW.strangerCap);
  const k = w.stranger('kb');
  let answered = false;
  k.transport.onRequest(async (buf) => {
    const request = JSON.parse(buf.toString('utf8'));
    if (answered) return new Promise(() => {});
    answered = true;
    return canon(buildResponse(k.id, { re: requestDigest(request), error: { code: 'effort', detail: '' }, effort: most }));
  });
  const paid = [];
  w.net.tap(({ from, to, body }) => from === 'a' && to === 'kb' && paid.push([w.net.now(), JSON.parse(body.toString('utf8')).pow.effort]));
  await asking(w, a, { back: [{ pk: k.pk, from: 0 }] });
  await w.run(26 * 3600);
  const [first] = paid;
  const late = paid.filter(([at]) => at - first[0] > 24 * 3600 + 60).map(([, effort]) => effort);
  assert.deepEqual([paid.some(([, effort]) => effort === most), late.length > 0 && late.every((effort) => effort < most)], [true, true]);
});

await check('a clock that ran days ahead for a while puts off no member a machine looks for past a day and a half: it asks them once a day as before', async () => {
  const w = createWorld({ seed: 13 });
  const [a] = await w.pool(['a', 'b']);
  const gone = goneFor(w, ['c', 'd']);
  await asking(w, a, { former: gone.map((s) => ({ pk: s.pk, by: s.pk, due: w.net.now() + 12 * 3600 })) });
  a.skew = 5 * 24 * 3600;
  await w.run(1800);
  a.skew = 0;
  await w.run(600);
  assert.ok(w.asks(a).former.every((e) => e.due <= w.net.now() + 36 * 3600), 'every key due within a day and a half');
  const since = w.net.now();
  await w.run(4 * 24 * 3600);
  for (const to of ['c', 'd']) {
    const hellos = w.net.count({ from: 'a', to, kind: 'hello', since });
    assert.ok(hellos >= 2 && hellos <= 6, `${hellos} hellos to ${to} in 4 days`);
  }
});

await check('a machine that still asks a host it holds no member record of gives the claims of the job it runs to the members it holds a record of alone', async () => {
  const w = createWorld({ seed: 6 });
  const [a, b] = await w.pool(['a', 'b']);
  [a.slots, b.slots] = [1, 0];
  const m = w.stranger('m');
  const pushed = [];
  m.transport.onRequest(async (buf) => {
    const request = JSON.parse(buf.toString('utf8'));
    pushed.push(...(request.body?.records ?? []));
    return canon(buildResponse(m.id, { re: requestDigest(request), body: { index: {}, accepted: [], refused: [] }, effort: POW.memberBase }));
  });
  await asking(w, a, { back: [{ pk: m.pk, from: 0 }] });
  await w.run(600);
  assert.deepEqual(w.asks(a).back.map((e) => e.pk), [m.pk]);
  const { taskId } = await a.node.offer(offerArgs('pr-1'));
  const since = w.net.now();
  await w.run(3600);
  assert.deepEqual([Boolean(a.executor.jobOf(taskId)), w.net.count({ from: 'a', to: 'm', since }) > 0, pushed.filter((x) => x.type !== 'member')], [true, true, []]);
});

await check('a machine whose repository is unlinked and linked again looks for none of the members it dropped before, restarted or not', async () => {
  const w = createWorld({ seed: 17 });
  const [a] = await w.pool(['a', 'b']);
  const [c] = goneFor(w, ['c']);
  await asking(w, a, { former: [{ pk: c.pk, by: c.pk, due: w.net.now() }] });
  await w.run(600);
  assert.deepEqual([w.asks(a).former.map((e) => e.pk), w.net.count({ from: 'a', to: 'c', kind: 'hello' })], [[c.pk], 1]);
  const { pools } = a;
  a.node.setPools([]);
  await w.run(60);
  a.node.setPools(pools);
  await w.run(600);
  await w.restart(a);
  const since = w.net.now();
  await w.run(3 * 24 * 3600);
  assert.deepEqual([w.asks(a).former, w.net.count({ from: 'a', to: 'c', since })], [[], 0]);
});

await check('a machine whose store kept no word of which members it heard from looks for each member it held a record of that ran out', async () => {
  const w = createWorld({ seed: 19 });
  const [a, b, c] = await w.pool(['a', 'b', 'c']);
  await w.run(700);
  for (const h of [a, b, c]) w.net.kill(h.name);
  const { met, ...heard } = w.heard(a);
  assert.deepEqual(met.sort(), [b.pk, c.pk].sort());
  a.disk.write(heardFile(POOL), JSON.stringify(heard));
  await w.run(31 * 24 * 3600);
  await w.restart(a);
  await w.run(60);
  assert.deepEqual(w.asks(a).former.map((e) => e.pk).sort(), [b.pk, c.pk].sort());
});
