// Who is in a pool, as whole hosts see it: joining by invite, a stranger kept out, a
// newcomer let in by a member that has never met its inviter, a member that left, and
// two halves of a pool that find one state again after a partition.

import assert from 'node:assert/strict';
import { POOL, check, createWorld } from './lib/hosts.mjs';
import { sign } from '../src/core/identity.js';
import { createInvite, createVoucher, inviteToken } from '../src/core/membership.js';
import { LIMITS, memberRecord } from '../src/core/records.js';
import { STRANGER_BODY_BYTES } from '../src/paths.js';

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
  // Every refusal of an invite is a sentence the operator can act on.
  await assert.rejects(late.node.join({ invite }), /^Error: That invite has run out: ask for a new one\.$/);
  await assert.rejects(late.node.join({ invite: 'nonsense' }), /^Error: That is not an invite: paste the whole token the other machine made\.$/);
  const forged = createInvite(mallory.id, { pool: POOL, exp: w.net.now() + 600, nonce: Buffer.alloc(16, 7) });
  const unsigned = inviteToken({ ...forged, by: a.pk });
  await assert.rejects(late.node.join({ invite: unsigned }), /^Error: That invite is not signed by the machine it names: ask for a new one\.$/);
  const own = late.node.invite({ pool: POOL }).invite;
  await assert.rejects(late.node.join({ invite: own }), /^Error: That invite was made on this machine: it lets another machine in, not this one\.$/);
});

await check('a host that left a pool stays out of it, whatever its list of pools says and however often it restarts, until it joins again', async () => {
  const w = createWorld({ seed: 22 });
  const [a, b, c] = await w.pool(['a', 'b', 'c']);
  c.node.leave({ pool: POOL });
  await w.net.until(() => w.members(a).length === 2 && w.members(b).length === 2, { what: 'c gone' });
  const out = { id: POOL, path: '/repos/widgets', identity: 'Octocat', hash: '', left: true, members: [], tasks: [] };
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
  // Nobody put it out: it is back by its own word, as the member it was.
  assert.deepEqual(await c.node.join({ pool: POOL }), { pool: POOL });
  await w.net.until(() => [a, b, c].every((h) => w.members(h).length === 3), { maxMs: 10000, what: 'c back at once, with no invite' });
  await w.agreed([a, b, c]);
  assert.equal(w.view(c).left, false);
  assert.equal(w.stored(c, [...c.disk.files.keys()].find((name) => name.startsWith('pools/'))).left, undefined, 'a member keeps no farewell');
  assert.deepEqual(w.records(c).find((r) => r.type === 'member' && r.pk === c.pk).voucher, w.records(a).find((r) => r.pk === c.pk).voucher);
  assert.equal(w.records(a).find((r) => r.pk === c.pk).voucher.by, a.pk);
  // It leaves once more, and this time comes back by an invite.
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
  // b loses the network; meanwhile x joins through a, and y through x.
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
  // Now b can reach y, and only y.
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
  // A member that was down hears of what it missed when it is back.
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
  // It goes unheard: the others go on asking it, vouched for by its own invite.
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
  // An invite it gave as a member of what it left is spent; one it gives now is good.
  const late = w.add('late');
  await w.start(late);
  await late.node.join(before);
  await w.run(120);
  assert.deepEqual(w.members(a), [a.pk]);
  assert.match(late.log.join('\n'), /the invite to .* let this host in nowhere: that invite is no longer good/);
  assert.equal(w.net.count({ from: 'late', to: 'a', kind: 'hello' }), 1, 'an invite that was refused is given up');
  // One whose maker never answers is asked about until it runs out, and no longer.
  w.net.cut('late', 'a');
  await late.node.join(a.node.invite({ pool: POOL, ttlSecs: 600 }));
  await w.run(600);
  const asked = w.net.count({ from: 'late', to: 'a', kind: 'hello' });
  await w.run(600);
  w.net.heal();
  await w.run(60);
  assert.deepEqual([asked > 2, w.net.count({ from: 'late', to: 'a', kind: 'hello' }), w.members(a)], [true, asked, [a.pk]]);
  // Nor is a voucher it signed then: a member of what it left has no seat under it.
  const hello = await w.request(b, a, 'hello', { member: w.records(b).find((r) => r.pk === b.pk) }, { effort: 2 ** 16 });
  assert.deepEqual([hello.code, hello.detail, w.members(a)], ['denied', 'no-seat', [a.pk]]);
  // It is good from the moment it is given: the host may die before anyone comes with it.
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
  // Nobody hears the one task finished, nor the other cancelled as the host leaves.
  w.net.down('a');
  a.executor.end(a.executor.jobOf(own.taskId).runId);
  await w.net.until(() => w.offerRow(a, own.taskId).state === 'done', { what: 'its own task done' });
  a.node.leave({ pool: POOL });
  await w.run(60);
  assert.deepEqual([w.offerRow(a, taskId).state, w.task(b, taskId).state, w.task(c, own.taskId).state], ['cancelled', 'available', 'claimed']);
  w.net.down('a', false);
  await a.node.join({ pool: POOL });
  // The members still hold the offers as open, and hand them back to the host that made them.
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
  // What is dated in the second the host last served before it went down is not served.
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
  // The voucher is the whole of it: the invite is in no record, and a key gets in by its own voucher alone.
  const record = (id, v) => memberRecord(id, { pool: POOL, seq: 0, at: w.net.now(), era: 0, maxAcceptedH: 12, voucher: v });
  assert.deepEqual(await ask(other, b, { member: record(other.id, first.voucher) }), ['not-member', '']);
  assert.ok((await ask(m, b, { member: record(m.id, first.voucher), chain: first.chain })).index, 'any member lets it in');
  await w.agreed([a, b]);
  assert.deepEqual(w.members(a), [a.pk, b.pk, m.pk].sort());
  assert.equal(JSON.stringify(w.records(b)).includes(token.invite), false);
  // What a key was given it is given again a restart of the inviter later, and no other key gets its seat.
  const last = (await ask(w.stranger('last'), a, token)).voucher.seat;
  await w.restart(a);
  await w.run(2);
  assert.equal((await ask(other, a, token)).voucher.seat, 2);
  const long = a.node.invite({ pool: POOL, ttlSecs: 3 * 24 * 3600 });
  assert.deepEqual([last, (await ask(w.stranger('third'), a, long)).voucher.seat], [3, 4]);
  // Past its time the invite gives nothing, and the seats it gave to keys that never came are free.
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
  // b gives seats of its own, and whoever holds one of those gives none.
  const x = w.add('x');
  await w.start(x);
  await x.node.join(b.node.invite({ pool: POOL }));
  await w.net.until(() => w.members(a).includes(x.pk), { what: 'x a member' });
  assert.throws(() => x.node.invite({ pool: POOL }), /^Error: This machine is 2 invites away from the one that started the pool .*, and invites nobody: ask a machine nearer to that one\.$/);
  // One of a's invitees says it left: its seat is the next given.
  const leaver = more[6];
  const gone = memberRecord(leaver.id, { ...leaver.member, seq: 1, at: w.net.now(), left: true });
  assert.deepEqual((await w.request(leaver, a, 'push', { records: [gone] }, { effort: 2 ** 16 })).body.refused, []);
  const taken = (await ask(late, a, a.node.invite({ pool: POOL }))).voucher;
  assert.equal(taken.seat, leaver.member.voucher.seat);
  const lates = memberRecord(late.id, { pool: POOL, seq: 0, at: w.net.now(), era: 0, maxAcceptedH: 12, voucher: taken });
  assert.ok((await ask(late, a, { member: lates })).index);
  assert.equal(w.records(a).some((r) => r.pk === leaver.pk), false, 'and the one that left has none');
  // The others stop signing their records: a day on, the one that signed longest ago gives way.
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

// A member record as the build before vouchers signed it: the day it joined by its own
// word, and the invite it came by.
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
    // By an invite and a day of joining of its own telling, as members were made once; in
    // seats it has not got to give; and in the name of a member that has them.
    const old = Array.from({ length: 32 }, () => formerly(w.stranger('puppet'), { seq: 0, at: w.net.now(), invite }));
    assert.deepEqual(await codes(far, h, old), [0, 'bad-record'], h.name);
    assert.deepEqual(await codes(far, h, seats.map((seat) => puppet(far, seat))), [0, 'no-seat'], h.name);
    assert.deepEqual(await codes(near, h, seats.map((seat) => puppet(near, seat, { by: root.pk }))), [0, 'bad-voucher'], h.name);
  }
  // The seats it has are its own to give, and to give again: nobody else's go with them.
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
    const { joining, invites, ...doc } = JSON.parse(h.disk.read(file));
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
