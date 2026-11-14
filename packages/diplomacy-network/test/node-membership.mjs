// Who is in a pool, as whole hosts see it: joining by invite, a stranger kept out, a
// newcomer let in by a member that has never met its inviter, a member that left, and
// two halves of a pool that find one state again after a partition.

import assert from 'node:assert/strict';
import { POOL, check, createWorld } from './lib/hosts.mjs';
import { createInvite, inviteToken } from '../src/core/membership.js';
import { memberRecord } from '../src/core/records.js';

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
  await assert.rejects(late.node.join({ invite }), /cannot be used: expired/);
  await assert.rejects(late.node.join({ invite: 'nonsense' }), /not an invite/);
});

await check('a member that leaves is asked nothing more, and comes back only by a new invite', async () => {
  const w = createWorld({ seed: 22 });
  const [a, b, c] = await w.pool(['a', 'b', 'c']);
  c.node.leave({ pool: POOL });
  await w.net.until(() => w.members(a).length === 2 && w.members(b).length === 2, { what: 'c gone' });
  assert.deepEqual(w.members(c), [c.pk], 'it is alone in its own copy of the pool');
  const since = w.net.now() + 1;
  await w.run(900);
  assert.equal(w.net.count({ to: 'c', since }), 0);
  assert.equal(w.net.count({ from: 'c', since }), 0);
  await w.wait(c.node.join(b.node.invite({ pool: POOL })));
  await w.net.until(() => [a, b, c].every((h) => w.members(h).length === 3), { what: 'c back' });
  await w.agreed([a, b, c]);
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
