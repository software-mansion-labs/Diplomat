// Three days in the life of a pool: members stay members by signing their records again,
// what ended stays ended, and a host cut off for longer than a record lives brings
// nothing back with it.

import assert from 'node:assert/strict';

// Three days of a sync every minute would be most of this suite's time; every ten
// minutes shows the same thing.
process.env.DN_SYNC_INTERVAL_MS ??= '600000';
const { POOL, check, createWorld } = await import('./lib/hosts.mjs');
const { RECORD_RETENTION_SECS, RESIGN_INTERVAL_MS } = await import('../src/paths.js');

const offerArgs = (item) => ({ pool: POOL, kind: 'review', item, title: `Review ${item}`, prompt: 'p' });
const HOUR = 3600;

await check('over three days every member signs its record again and again, and a task that ended never comes back', async () => {
  const w = createWorld({ seed: 101 });
  const all = await w.pool(['req', 'exe', 'idle', 'away'], { exe: { slots: 1 } });
  const [req, exe, idle, away] = all;
  const done = await req.node.offer(offerArgs('pr-1'));
  const dropped = await req.node.offer(offerArgs('pr-2'));
  await w.agreed(all, 30 * 60 * 1000);
  // One host loses the network while both tasks are open, and keeps what it knew.
  w.net.split(['req', 'exe', 'idle'], ['away']);
  await w.net.until(() => exe.executor.jobOf(done.taskId), { maxMs: 30 * 60 * 1000, what: 'a job' });
  exe.executor.end(exe.executor.jobOf(done.taskId).runId);
  await w.net.until(() => w.offerRow(req, done.taskId).state === 'done', { what: 'the first task done' });
  await req.node.withdraw({ taskId: dropped.taskId, reason: 'not needed' });
  const ended = w.net.now();
  assert.deepEqual([w.task(away, done.taskId).state, w.task(away, dropped.taskId).state], ['available', 'available'], 'as far as it knows');

  const signedAt = (h, of) => w.records(h).find((r) => r.type === 'member' && r.pk === of.pk)?.at ?? 0;
  const never = (h) => {
    for (const taskId of [done.taskId, dropped.taskId]) {
      const state = w.task(h, taskId)?.state ?? 'forgotten';
      assert.ok(['done', 'cancelled', 'forgotten'].includes(state), `${h.name} sees ${taskId} as ${state} ${(w.net.now() - ended) / HOUR} h after it ended`);
    }
  };
  for (let hour = 1; hour <= 72; hour += 1) {
    await w.run(HOUR);
    for (const h of [req, exe, idle]) never(h);
    if (hour === 30) {
      // Back after thirty hours: its open offers of both tasks are older than a record lives.
      assert.equal(w.members(req).length, 3, 'a host silent for a day is no member until it signs again');
      w.net.heal();
      away.slots = 1;
    }
    if (hour > 31) never(away);
    if (hour % 24 === 0 && hour !== 24) {
      for (const h of all) {
        assert.equal(w.members(h).length, 4, `${h.name} counts four members after ${hour} h`);
        for (const of of all) assert.ok(w.net.now() - signedAt(h, of) <= 2 * RESIGN_INTERVAL_MS / 1000, `${h.name} holds a late record of ${of.name}`);
      }
    }
  }
  await w.agreed(all, 30 * 60 * 1000);
  assert.ok(w.net.now() - ended > 2 * RECORD_RETENTION_SECS);
  assert.deepEqual(all.map((h) => h.executor.started.length), [0, 1, 0, 0], 'nothing was run a second time');
  assert.deepEqual(w.view(req).tasks, [], 'the ended tasks are gone from the pool, not back in it');
  assert.deepEqual(req.node.snapshot().offers, [], 'and from the list of offers, a day after they ended');
  // The pool is as alive as on its first day.
  const fresh = await req.node.offer(offerArgs('pr-3'));
  await w.net.until(() => [exe, away].some((h) => h.executor.jobOf(fresh.taskId)), { maxMs: 30 * 60 * 1000, what: 'a job for a task offered on the fourth day' });
});
