// Who is in a pool, as whole hosts see it: joining by invite, a stranger kept out, a
// newcomer let in by a member that has never met its inviter, a member that left, and
// two halves of a pool that find one state again after a partition.

import assert from 'node:assert/strict';
import { POOL, check, createWorld } from './lib/hosts.mjs';
import { createInvite, inviteToken } from '../src/core/membership.js';
import { memberRecord } from '../src/core/records.js';
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
  const alone = memberRecord(mallory.id, { pool: POOL, seq: 0, at: now, joinedAt: now, maxAcceptedH: 12 });
  const selfInvited = memberRecord(mallory.id, {
    pool: POOL, seq: 0, at: now, joinedAt: now, maxAcceptedH: 12,
    voucher: inviteToken(createInvite(w.stranger('friend').id, { pool: POOL, exp: now + 3600, nonce: w.net.rnd.bytes(16) })),
  });
  const old = memberRecord(mallory.id, {
    pool: POOL, seq: 0, at: now - 7200, joinedAt: now - 7200, maxAcceptedH: 12,
    voucher: inviteToken(createInvite(a.id, { pool: POOL, exp: now - 3600, nonce: w.net.rnd.bytes(16) })),
  });
  const said = async (kind, body) => {
    const { ok, code, detail } = await w.request(mallory, a, kind, body, { effort: 2048 });
    return [ok, code, detail];
  };
  assert.deepEqual(await said('sync', { asOf: now, hash: w.view(a).hash }), [false, 'not-member', 'say hello first']);
  assert.deepEqual(await said('push', { records: [alone] }), [false, 'not-member', 'say hello first']);
  assert.deepEqual(await said('hello', { member: alone }), [false, 'denied', 'no-voucher']);
  assert.deepEqual(await said('hello', { member: selfInvited }), [false, 'denied', 'not-member'], 'an invite from nobody the host knows');
  assert.deepEqual(await said('hello', { member: old }), [false, 'denied', 'expired'], 'an invite past its time');
  assert.deepEqual((await w.request(mallory, a, 'sync', {}, { effort: 2048, pool: 'github.com/acme/other' })).code, 'unknown-pool');
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
  assert.equal(w.stored(c, [...c.disk.files.keys()].find((name) => name.startsWith('pools/'))).left, null, 'a member keeps no farewell');
  assert.equal(w.records(c).find((r) => r.type === 'member' && r.pk === c.pk).voucher.invite, w.records(a).find((r) => r.pk === c.pk).voucher.invite);
  // It leaves once more, and this time comes back by an invite.
  c.node.leave({ pool: POOL });
  await w.net.until(() => w.members(a).length === 2 && w.members(b).length === 2, { what: 'c gone again' });
  await w.wait(c.node.join(b.node.invite({ pool: POOL })));
  await w.net.until(() => [a, b, c].every((h) => w.members(h).length === 3), { what: 'c back by invite' });
  await w.agreed([a, b, c]);
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
  for (let i = 0; i < 150; i += 1) await a.node.offer({ ...offerArgs(`pr-${i}`), title });
  await w.agreed([a, b]);
  const late = w.add('late');
  await w.start(late);
  const since = w.net.now();
  await late.node.join(a.node.invite({ pool: POOL }));
  await w.agreed([a, b, late], 10 * 60 * 1000);
  assert.equal(w.view(late).tasks.length, 150);
  assert.ok(w.net.count({ from: 'late', kind: 'pull', since }) >= 3, 'what did not fit one answer was asked for again');
  assert.deepEqual(w.net.sent.filter((s) => s.bytes > STRANGER_BODY_BYTES), []);
});

await check('a hello that is refused leaves on disk whatever record it brought', async () => {
  const w = createWorld({ seed: 29 });
  const [a, b] = await w.pool(['a', 'b']);
  const m = await w.intruder('m', a);
  await w.agreed([a, b]);
  const held = w.records(a).find((r) => r.type === 'member' && r.pk === m.pk);
  const left = memberRecord(m.id, {
    pool: POOL, seq: held.seq + 1, at: w.net.now(), joinedAt: held.joinedAt, maxAcceptedH: 12, voucher: held.voucher.invite, left: true,
  });
  const answer = await w.request(m, a, 'hello', { member: left }, { effort: 4096 });
  assert.deepEqual([answer.ok, answer.code, answer.detail], [false, 'denied', 'left']);
  assert.equal(w.records(a).find((r) => r.type === 'member' && r.pk === m.pk).seq, held.seq + 1);
});
