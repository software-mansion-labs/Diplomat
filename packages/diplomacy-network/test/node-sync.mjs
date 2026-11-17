// Three days in the life of a pool: members stay members by signing their records again,
// what ended stays ended, and a host cut off for longer than a record lives brings
// nothing back with it.

import assert from 'node:assert/strict';

// Three days of a sync every minute would be most of this suite's time; every ten
// minutes shows the same thing.
process.env.DN_SYNC_INTERVAL_MS ??= '600000';
const { POOL, check, createWorld } = await import('./lib/hosts.mjs');
const { PEER_QUIET_MS, PUSH_REPEAT_MS, RECORD_RETENTION_SECS, RESIGN_INTERVAL_MS } = await import('../src/paths.js');

const offerArgs = (item) => ({ pool: POOL, kind: 'review', item, title: `Review ${item}`, prompt: 'p' });
const HOUR = 3600;

await check('over three days every member signs its record again and again, and a task that ended never comes back', async () => {
  const w = createWorld({ seed: 101 });
  const all = await w.pool(['req', 'exe', 'idle', 'away'], { exe: { slots: 1 } });
  const [req, exe, idle, away] = all;
  const done = await req.node.offer(offerArgs('pr-1'));
  const dropped = await req.node.offer(offerArgs('pr-2'));
  // A third task nobody takes stays offered for as long as its host is there to sign for it.
  for (const h of all) h.executor.takes = (task) => task.item !== 'pr-4';
  const kept = await req.node.offer(offerArgs('pr-4'));
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
  const offered = () => w.records(req).find((r) => r.type === 'offer' && r.taskId === kept.taskId);
  for (let hour = 1; hour <= 72; hour += 1) {
    await w.run(HOUR);
    for (const h of [req, exe, idle]) never(h);
    assert.ok(w.net.now() - offered().at <= 2 * RESIGN_INTERVAL_MS / 1000, `the open offer was last signed ${(w.net.now() - offered().at) / HOUR} h ago`);
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
  assert.deepEqual(w.view(req).tasks.map((t) => t.taskId), [kept.taskId], 'the ended tasks are gone from the pool, not back in it');
  assert.deepEqual(req.node.snapshot().offers.map((o) => o.taskId), [kept.taskId], 'and from the list of offers, a day after they ended');
  assert.deepEqual(all.map((h) => w.task(h, kept.taskId).state), ['available', 'available', 'available', 'available'], 'the open one is as open as on its first day');
  // The pool is as alive as on its first day.
  const fresh = await req.node.offer(offerArgs('pr-3'));
  await w.net.until(() => [exe, away].some((h) => h.executor.jobOf(fresh.taskId)), { maxMs: 30 * 60 * 1000, what: 'a job for a task offered on the fourth day' });
});

// A pool of the hosts `names`, the first of them `a`, and `pushed(to, since)`: how many
// milliseconds after `since` each push of `a` to that host left.
async function pushing(seed, names) {
  const w = createWorld({ seed });
  const all = await w.pool(names);
  const seen = [];
  w.net.tap(({ from, to, kind }) => {
    if (from === 'a' && kind === 'push') seen.push([w.net.ms(), to]);
  });
  const pushed = (to, since) => seen.filter(([at, name]) => name === to && at >= since).map(([at]) => at - since);
  return { w, all, pushed };
}
const [SECOND, THIRD, FOURTH] = PUSH_REPEAT_MS.map((_, i) => PUSH_REPEAT_MS.slice(0, i + 1).reduce((sum, ms) => sum + ms, 0));

await check('a host pushes its own offer again to a member that has not said it holds it - after 2 s, 5 s more and 15 s more - and then leaves it to the sync', async () => {
  assert.deepEqual(PUSH_REPEAT_MS, [2000, 5000, 15000]);
  {
    // One member hears nothing of this host, the other answers the first push.
    const { w, all: [a, b], pushed } = await pushing(105, ['a', 'b', 'c']);
    w.net.cut('a', 'b');
    const since = w.net.ms();
    const { taskId } = await a.node.offer(offerArgs('pr-1'));
    await w.run(50);
    assert.deepEqual([pushed('b', since), pushed('c', since)], [[0, SECOND, THIRD, FOURTH], [0]]);
    assert.equal(w.task(b, taskId), null);
  }
  {
    // A second offer three seconds after the first: the waits start over, and both
    // offers go in one push. Its own first push waits behind the unanswered one.
    const { w, all: [a], pushed } = await pushing(110, ['a', 'b']);
    w.net.cut('a', 'b');
    const since = w.net.ms();
    await a.node.offer(offerArgs('pr-1'));
    await w.run(3);
    await a.node.offer(offerArgs('pr-2'));
    await w.run(47);
    assert.deepEqual(pushed('b', since), [0, SECOND, 3000 + SECOND, 3000 + THIRD, 3000 + FOURTH]);
  }
  {
    // A link that takes a second and a half each way, and a second offer before the
    // first push is acknowledged: that acknowledgement is for the first offer alone.
    // The second goes out when its turn comes, and again two seconds after it was made.
    const { w, all: [a, b], pushed } = await pushing(113, ['a', 'b']);
    Object.assign(w.net.faults, { minMs: 1500, maxMs: 1500 });
    const since = w.net.ms();
    await a.node.offer(offerArgs('pr-1'));
    await w.run(1.2);
    const { taskId } = await a.node.offer(offerArgs('pr-2'));
    await w.run(40);
    assert.deepEqual([pushed('b', since), Boolean(w.task(b, taskId))], [[0, 3000, 1200 + SECOND], true]);
  }
  {
    // The host leaves the pool a second after its offer: it says so once, and pushes no more.
    const { w, all: [a], pushed } = await pushing(111, ['a', 'b']);
    w.net.cut('a', 'b');
    const since = w.net.ms();
    await a.node.offer(offerArgs('pr-1'));
    await w.run(1);
    a.pools = [];
    a.node.setPools([]);
    await w.run(49);
    assert.deepEqual(pushed('b', since), [0, 1000]);
  }
  {
    // The first push is lost on the way, and nothing after it.
    const { w, all: [a, b], pushed } = await pushing(106, ['a', 'b']);
    w.net.faults.drop = 1;
    const since = w.net.ms();
    const { taskId } = await a.node.offer(offerArgs('pr-1'));
    await w.run(1);
    w.net.faults.drop = 0;
    await w.run(1.5);
    assert.ok(w.task(b, taskId), 'the member holds the offer two seconds on, not a sync later');
    await w.run(40);
    assert.deepEqual(pushed('b', since), [0, SECOND], 'what was acknowledged is pushed no more');
    // An offer that ends is told the same way. Its first push waits its turn behind the
    // push that was lost, which is still unanswered: the one after goes out beside it.
    const ended = w.net.ms();
    await a.node.withdraw({ taskId, reason: 'not wanted' });
    await w.run(2.5);
    assert.deepEqual([w.task(b, taskId).state, pushed('b', ended)], ['cancelled', [SECOND]]);
  }
});

await check('a member that shows by its own sync that it holds what this host holds is pushed nothing more, and neither is one this host leaves alone or has not heard for long', async () => {
  {
    // The member takes the push and its answer is lost; then it asks, naming the state this host holds.
    const { w, all: [a, b], pushed } = await pushing(107, ['a', 'b']);
    let taken = false;
    w.net.tap(({ from, kind }) => (from === 'a' && kind === 'push' && !taken ? () => {
      taken = true;
      w.net.cut('a', 'b');
    } : undefined));
    const since = w.net.ms();
    const { taskId } = await a.node.offer(offerArgs('pr-1'));
    await w.net.until(() => taken, { stepMs: 1, what: 'the push taken' });
    await w.run(0.2);
    w.net.heal();
    assert.ok(w.task(b, taskId));
    const same = await w.request(b, a, 'sync', { asOf: w.net.now(), hash: w.view(b).hash });
    assert.deepEqual(Object.keys(same.body), ['hash']);
    await w.run(40);
    assert.deepEqual(pushed('b', since), [0]);
  }
  {
    // The member asks while it holds another state than this host: that says nothing of
    // what it holds, and the push goes out again.
    const { w, all: [a, b], pushed } = await pushing(112, ['a', 'b']);
    w.net.cut('a', 'b');
    await b.node.offer(offerArgs('pr-2'));
    const since = w.net.ms();
    const { taskId } = await a.node.offer(offerArgs('pr-1'));
    await w.run(0.5);
    w.net.heal();
    const other = await w.request(b, a, 'sync', { asOf: w.net.now(), hash: w.view(b).hash });
    assert.ok(other.body.index);
    await w.run(40);
    assert.deepEqual([pushed('b', since), Boolean(w.task(b, taskId))], [[0, SECOND], true]);
  }
  {
    // A member that is down refuses at once, and is left alone for five seconds, then
    // ten: the push that falls into that time is not sent.
    const { w, all: [a], pushed } = await pushing(108, ['a', 'b']);
    w.net.kill('b');
    const since = w.net.ms();
    await a.node.offer(offerArgs('pr-1'));
    await w.run(50);
    assert.deepEqual(pushed('b', since), [0, SECOND, FOURTH]);
  }
  {
    // A member asleep for longer than this host takes to call one quiet gets the one
    // push every member gets.
    const { w, all: [a], pushed } = await pushing(109, ['a', 'b', 'c']);
    w.net.sleep('c');
    let asked = 0;
    w.net.tap(({ from, to }) => {
      if (from === 'a' && to === 'c') asked = w.net.ms();
    });
    await w.run(PEER_QUIET_MS / 1000 + 600);
    // No request to it is on its way, and the time this host leaves it alone is over.
    await w.net.until(() => w.net.ms() - asked > 5 * 60 * 1000, { maxMs: 3600 * 1000, what: 'five minutes in which the sleeper is not asked' });
    const since = w.net.ms();
    await a.node.offer(offerArgs('pr-1'));
    await w.run(50);
    assert.deepEqual([pushed('b', since), pushed('c', since)], [[0], [0]]);
  }
});
