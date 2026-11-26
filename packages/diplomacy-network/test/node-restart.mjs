import assert from 'node:assert/strict';
import { forgeRequest } from './lib/fakes.mjs';
import { POOL, check, createWorld } from './lib/hosts.mjs';
import { unb64u } from '../src/core/canon.js';
import { actMac } from '../src/core/capability.js';
import { GRANT_TTL_SECS, LEASE_GRACE_SECS, LEASE_SECS, PEER_QUIET_MS, PROBE_TIMEOUT_MS, RECORD_RETENTION_SECS, REQUEST_TIMEOUT_MS } from '../src/paths.js';

const offerArgs = (item) => ({ pool: POOL, kind: 'review', item, title: `Review ${item}`, prompt: 'p' });
const get = (item, leaf) => forgeRequest('GET', `/repos/o/r/${item}/${leaf}`);

await check('a host that granted a lock still holds it after a restart: nobody else is granted the task', async () => {
  const w = createWorld({ seed: 71 });
  const all = await w.pool(['req', 'a', 'b']);
  const [req, a, b] = all;
  const { taskId } = await req.node.offer(offerArgs('pr-1'));
  await w.agreed(all);
  const asOf = w.net.now();
  const lock = (from, round) => w.request(from, req, 'lock', { taskId, round, asOf, hash: w.view(from).hash });
  const granted = await lock(a, 'AAAAAAAAAAA');
  assert.equal(granted.body.grant.executor, a.pk);
  await w.restart(req);
  // So the next hand-made request is dated after the last one req served before going down.
  await w.run(1);
  assert.equal(req.node.snapshot().offers[0].taskId, taskId, 'its offers are its own again');
  assert.deepEqual((await lock(b, 'BBBBBBBBBBA')).body, { challenge: { reason: 'locked', holder: a.pk } });
  assert.deepEqual((await lock(a, 'AAAAAAAAAAA')).body, granted.body, 'asked again, the holder gets the very same grant');
  await w.run(GRANT_TTL_SECS + 2);
  const later = w.net.now();
  const free = await w.request(b, req, 'lock', { taskId, round: 'BBBBBBBBBBA', asOf: later, hash: w.view(b).hash });
  assert.equal(free.body.grant.executor, b.pk, 'once the grant has run out the task can be granted again');
});

await check('a claimant killed in the middle of its round leaves one executor at most', async () => {
  const w = createWorld({ seed: 72 });
  const all = await w.pool(['req', 'x', 'y'], { x: { slots: 1 } });
  const [req, x, y] = all;
  const { taskId } = await req.node.offer(offerArgs('pr-1'));
  await w.net.until(() => w.net.count({ from: 'x', kind: 'lock' }) >= 1, { stepMs: 1, what: 'x asking for locks' });
  assert.equal(w.claim(req, taskId), undefined, 'nothing is committed yet');
  await w.restart(x);
  y.slots = 1;
  y.node.admit({ slots: 1 });
  await w.net.until(() => [x, y].some((h) => h.executor.jobOf(taskId)), { maxMs: 15 * 60 * 1000, what: 'somebody running the task' });
  await w.run(600);
  await w.agreed(all);
  assert.equal(x.executor.started.length + y.executor.started.length, 1, 'one job, on one host');
  const runner = x.executor.jobOf(taskId) ? x : y;
  for (const h of all) assert.equal(w.task(h, taskId).executor, runner.pk);
});

await check('a host restarted with a run going takes the run up again, and never uses a request number twice', async () => {
  const w = createWorld({ seed: 73 });
  const all = await w.pool(['req', 'exe'], { exe: { slots: 2 } });
  const [req, exe] = all;
  const kept = await req.node.offer(offerArgs('pr-1'));
  const lost = await req.node.offer(offerArgs('pr-2'));
  await w.net.until(() => exe.executor.started.length === 2, { what: 'two jobs' });
  const job = exe.executor.jobOf(kept.taskId);
  for (const leaf of ['a', 'b']) assert.equal((await w.wait(job.act(get('pr-1', leaf)))).status, 200);
  assert.equal(w.stored(req, 'keys').issued[kept.taskId].seq, 1);
  // The host dies; one of its two jobs dies with it.
  exe.executor.die(exe.executor.jobOf(lost.taskId).runId);
  assert.deepEqual(Object.values(w.stored(exe, 'runs').runs).map((r) => r.state), ['running', 'running'], 'what its disk holds as it dies');
  await w.restart(exe);
  assert.deepEqual([w.runOf(exe, kept.taskId).state, w.runOf(exe, lost.taskId).state], ['running', 'failed'], 'the executor was asked which of them live');
  const act = exe.node.actFor(job.runId);
  assert.equal((await w.wait(act(get('pr-1', 'c')))).status, 200, 'the job that lived goes on under the same key');
  assert.equal(w.stored(req, 'keys').issued[kept.taskId].seq, 2, 'with the next number, not one used before');
  await w.net.until(() => w.offerRow(req, lost.taskId).attempt === 2, { what: 'the dead job reported' });
  assert.deepEqual([w.runOf(exe, lost.taskId).state, w.offerRow(req, lost.taskId).reason], ['failed', 'the run ended without saying how']);
  await w.agreed(all);
  assert.deepEqual([w.task(req, lost.taskId).state, w.task(req, kept.taskId).state], ['available', 'claimed']);
  assert.equal(exe.executor.started.length, 2, 'nothing was started a second time');
  exe.executor.end(job.runId);
  await w.net.until(() => w.offerRow(req, kept.taskId).state === 'done', { what: 'the surviving run done' });
});

await check('a requester restarted while its key is out serves the same key, with its counters, and keeps the lease alive', async () => {
  const w = createWorld({ seed: 74 });
  const all = await w.pool(['req', 'exe'], { exe: { slots: 1 } });
  const [req, exe] = all;
  const { taskId } = await req.node.offer(offerArgs('pr-1'));
  await w.net.until(() => exe.executor.jobOf(taskId), { what: 'a job' });
  const job = exe.executor.jobOf(taskId);
  req.requester.refuse('/secrets', 'no');
  for (const leaf of ['a', 'secrets']) await w.wait(job.act(get('pr-1', leaf)));
  const before = w.stored(req, 'keys').issued[taskId];
  await w.restart(req);
  assert.deepEqual(w.stored(req, 'keys').issued[taskId], before);
  assert.equal((await w.wait(job.act(get('pr-1', 'c')))).status, 200, 'the key works across the restart');
  assert.deepEqual(req.requester.calls.filter((c) => c.op === 'authorize').map((c) => c.asked), [1, 2, 3], 'what the rules remembered is remembered');
  const row = w.offerRow(req, taskId);
  assert.deepEqual([row.state, row.requests, row.refused, row.executor], ['claimed', 3, 1, exe.pk]);
  const { capability: { keyId }, secret } = w.stored(exe, 'keys').held[taskId];
  const replay = { taskId, keyId, seq: 1, request: get('pr-1', 'a'), mac: actMac(unb64u(secret), { keyId, seq: 1, request: get('pr-1', 'a') }) };
  assert.equal((await w.request(exe, req, 'act', replay)).detail, 'seq is not new', 'a number used before the restart is still used');
  const again = await w.request(exe, req, 'key', { taskId, round: w.claim(req, taskId).round });
  assert.deepEqual([again.body.capability, again.body.secret], [before.capability, before.secret]);
  const { claimedAt } = w.claim(req, taskId);
  await w.run(claimedAt + LEASE_SECS + LEASE_GRACE_SECS + 60 - w.net.now());
  assert.deepEqual([w.task(exe, taskId).state, w.claim(exe, taskId).seq], ['claimed', 1], 'the restarted requester pinged in time');
  assert.equal((await w.wait(job.act(get('pr-1', 'd')))).status, 200);
});

await check('a host that lost the record of its runs gives back the claims it cannot account for', async () => {
  const w = createWorld({ seed: 75 });
  const all = await w.pool(['req', 'exe'], { exe: { slots: 1 } });
  const [req, exe] = all;
  const { taskId } = await req.node.offer(offerArgs('pr-1'));
  await w.net.until(() => exe.executor.jobOf(taskId), { what: 'a job' });
  await w.agreed(all);
  w.net.kill('exe');
  exe.disk.write('runs', '{"runs":{"run-');
  exe.slots = 0;
  await w.restart(exe);
  assert.match(exe.log.join('\n'), /store: runs\.json does not parse/);
  await w.net.until(() => w.claim(req, taskId).state === 'released', { maxMs: 5000, what: 'the claim given back' });
  assert.deepEqual([w.offerRow(req, taskId).state, w.offerRow(req, taskId).attempt], ['pooled', 1], 'a claim given back is no failed attempt');
  assert.deepEqual([w.stored(exe, 'keys').held, w.stored(req, 'keys').issued], [{}, {}], 'and its key is gone on both sides');
  assert.deepEqual(exe.node.snapshot().runs, []);
});

await check('a host that comes back takes up the pools it was linked to before anyone names them; one that lost the list ends nothing until they are named', async () => {
  const w = createWorld({ seed: 76 });
  const all = await w.pool(['req', 'exe'], { exe: { slots: 1 } });
  const [req, exe] = all;
  const { taskId } = await req.node.offer(offerArgs('pr-1'));
  await w.net.until(() => exe.executor.jobOf(taskId), { what: 'a job' });
  const job = exe.executor.jobOf(taskId);
  const act = async (leaf) => (await w.wait(exe.node.actFor(job.runId)(get('pr-1', leaf)))).status;
  // Nobody names their pools: the list is in the store.
  for (const h of all) await w.restart(h, { named: false });
  assert.deepEqual([w.members(req).length, w.members(exe).length], [2, 2]);
  assert.deepEqual([w.runOf(exe, taskId).state, w.offerRow(req, taskId).state], ['running', 'claimed']);
  assert.equal(await act('a'), 200);
  w.net.kill('exe');
  exe.disk.remove('links');
  await w.restart(exe, { gapSecs: 30 });
  assert.deepEqual(exe.executor.stopped, [], 'the job goes on');
  assert.deepEqual([w.runOf(exe, taskId).state, w.offerRow(req, taskId).state], ['running', 'claimed']);
  assert.equal(await act('b'), 200);
  exe.executor.end(job.runId);
  await w.net.until(() => w.offerRow(req, taskId).state === 'done', { what: 'the offer done' });
  // A pool that is gone from the list when the daemon comes back was closed while it was down.
  const second = await req.node.offer(offerArgs('pr-2'));
  await w.net.until(() => exe.executor.jobOf(second.taskId), { what: 'a second job' });
  exe.pools = [];
  await w.restart(exe);
  await w.net.settled();
  assert.deepEqual(exe.executor.stopped.map((s) => s.reason), ['the pool was closed']);
});

await check('a host that died around the moment it started a job never starts that job twice', async () => {
  for (const fate of ['alive', 'dead', 'unknown']) {
    const w = createWorld({ seed: 77 });
    const all = await w.pool(['req', 'exe'], { exe: { slots: 1 } });
    const [req, exe] = all;
    // The process dies inside the executor's start: the job exists, the host never learns of it.
    const start = exe.executor.start.bind(exe.executor);
    exe.executor.start = (args) => {
      const handle = start(args);
      w.net.kill('exe');
      return handle;
    };
    const { taskId } = await req.node.offer(offerArgs('pr-1'));
    await w.net.until(() => exe.executor.started.length === 1, { what: 'the job started' });
    exe.executor.start = start;
    const { runId } = exe.executor.started[0];
    assert.deepEqual(Object.values(w.stored(exe, 'runs').runs).map((r) => [r.state, r.launched]), [['preparing', true]], 'what the disk knows');
    if (fate === 'dead') exe.executor.die(runId);
    const alive = exe.executor.alive;
    if (fate === 'unknown') exe.executor.alive = () => { throw new Error('docker is not up yet'); };
    await w.restart(exe);
    await w.run(60);
    assert.equal(exe.executor.started.length, 1, `${fate}: started once`);
    if (fate === 'alive') assert.equal(w.runOf(exe, taskId).state, 'running');
    if (fate === 'unknown') {
      assert.equal(w.runOf(exe, taskId).state, 'preparing', 'nothing is decided while the executor cannot say');
      exe.executor.alive = alive;
      await w.run(20);
      assert.equal(w.runOf(exe, taskId).state, 'running');
    }
    if (fate === 'dead') {
      await w.net.until(() => w.offerRow(req, taskId).attempt === 2, { what: 'the lost job reported as a failed attempt' });
      assert.equal(w.runOf(exe, taskId).state, 'failed');
    }
  }
});

await check('a host that left a pool unheard and came back gives up the claim it finds itself holding', async () => {
  const w = createWorld({ seed: 78 });
  const all = await w.pool(['req', 'exe'], { exe: { slots: 1 } });
  const [req, exe] = all;
  const { taskId } = await req.node.offer(offerArgs('pr-1'));
  await w.net.until(() => exe.executor.jobOf(taskId), { what: 'a job' });
  w.net.cut('req', 'exe');
  exe.slots = 0;
  exe.node.setPools([]);
  await w.run(30);
  assert.equal(w.claim(req, taskId).state, 'held', 'the requester never heard the claim was given back');
  exe.node.setPools(exe.pools);
  w.net.heal();
  await w.wait(exe.node.join(req.node.invite({ pool: POOL })));
  await w.net.until(() => w.claim(req, taskId).state === 'released', { maxMs: 3 * 60 * 1000, what: 'the claim given back again' });
  assert.equal(exe.executor.started.length, 1);
});

await check('a stopped host leaves no timer behind, whatever it was in the middle of', async () => {
  const w = createWorld({ seed: 79 });
  const all = await w.pool(['req', 'exe', 'silent'], { exe: { slots: 2 } });
  const [req, exe] = all;
  // One run waits for a key that never comes; one round waits for a member that says nothing.
  req.requester.rulesFor = (args) => (args.item === 'pr-1' ? [{ host: 'api.github.com', method: 'GET', path: '/**' }] : null);
  const first = await req.node.offer(offerArgs('pr-1'));
  req.requester.rulesFor = () => { throw new Error('the rules are gone'); };
  await w.net.until(() => w.runOf(exe, first.taskId), { what: 'a run waiting for its key' });
  req.requester.rulesFor = (args) => {
    if (args.item === 'pr-1') throw new Error('the rules are gone');
    return [{ host: 'api.github.com', method: 'GET', path: '/**' }];
  };
  w.net.cut('exe', 'silent');
  await w.run(15);
  exe.node.admit({ slots: 1 });
  const second = await req.node.offer(offerArgs('pr-2'));
  req.requester.rulesFor = () => { throw new Error('the rules are gone'); };
  // A round holds this host's own lock on the task from its first request on.
  await w.net.until(() => JSON.stringify(w.stored(exe, 'locks')).includes(second.taskId), { stepMs: 5, what: 'a round under way' });
  exe.slots = 0;
  const said = exe.log.length;
  assert.equal(w.runOf(exe, first.taskId).state, 'preparing');
  await exe.node.stop();
  await w.run(3600);
  assert.deepEqual(exe.log.slice(said).filter((line) => line.includes('stood down')), [], 'its rounds end with it, unsaid');
  assert.deepEqual(exe.node.snapshot().runs.map((run) => run.taskId), [first.taskId], 'and commit nothing');
  assert.equal(w.net.timers('exe'), 0);
  assert.equal(w.net.count({ from: 'exe', since: w.net.now() - 3000 }), 0, 'and it sends nothing');
});

await check('a host started with its clock an hour behind keeps its place in the pool', async () => {
  const w = createWorld({ seed: 83 });
  const all = await w.pool(['a', 'b', 'c']);
  const [a, b] = all;
  await w.run(600);
  const doc = () => w.doc(b);
  const { records } = doc();
  b.skew = -3600;
  await w.restart(b);
  await w.run(120);
  assert.equal(doc().records.length, records.length, 'what it held it still holds');
  assert.ok(doc().records.find((r) => r.type === 'member' && r.pk === b.pk).voucher, 'and it did not found a pool of its own');
  b.skew = 0;
  await w.run(300);
  const everyone = all.map((h) => h.pk).sort();
  assert.deepEqual([w.members(a), w.members(b)], [everyone, everyone]);
});

await check('a store that could not be written at one step is written at the next, and the host goes on', async () => {
  const w = createWorld({ seed: 84 });
  const [req, exe] = await w.pool(['req', 'exe'], { exe: { slots: 1 } });
  const { taskId } = await req.node.offer(offerArgs('pr-1'));
  await w.net.until(() => exe.executor.jobOf(taskId), { what: 'a job' });
  await w.run(1);
  const write = req.disk.write;
  let failed = 0;
  req.disk.write = (name, text) => {
    if (failed > 0) return write(name, text);
    failed += 1;
    throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
  };
  await w.run(15);
  assert.equal(failed, 1);
  assert.ok(req.log.some((line) => line.includes('the store could not be written')));
  // The lease is still extended when it comes due.
  await w.run(LEASE_SECS);
  assert.ok(w.claim(req, taskId).seq >= 1);
});

await check('what a member answers after a pool was closed is not taken into it', async () => {
  const w = createWorld({ seed: 85 });
  const [a, b] = await w.pool(['a', 'b']);
  w.net.kill('a');
  await b.node.offer(offerArgs('pr-1'));
  await w.run(200);
  // Its pool is closed while the answer to its pull is on the way - unheard, so b still answers.
  let pulling = false;
  w.net.tap(({ from, kind }) => {
    if (pulling || from !== 'a' || kind !== 'pull') return;
    pulling = true;
    w.net.clock('world').setTimeout(() => {
      a.transport.host.ready = false;
      a.pools = [];
      a.node.setPools([]);
    }, 1);
  });
  await w.restart(a);
  await w.net.until(() => pulling, { what: 'a pull by a' });
  await w.run(120);
  const doc = w.doc(a);
  assert.deepEqual([doc.linked, doc.records], [false, undefined]);
});

await check('a host that starts again knows which members had long been silent when it last ran: it gives each the short time to answer, and counts it absent as ever', async () => {
  const w = createWorld({ seed: 88 });
  const [req, exe, zzz] = await w.pool(['req', 'exe', 'zzz'], { exe: { slots: 1 } });
  const silent = () => w.stored(exe, 'peers')?.silent;
  let n = 0;
  // `[seconds the executor's round took, absent]` for a freshly offered task.
  const round = async () => {
    n += 1;
    const { taskId } = await req.node.offer(offerArgs(`pr-${n}`));
    await w.net.until(() => exe.executor.jobOf(taskId), { maxMs: 15 * 60 * 1000, what: `job ${n}` });
    const line = exe.log.find((l) => l.startsWith(`claim of ${taskId} made`));
    exe.executor.end(exe.executor.jobOf(taskId).runId);
    await w.net.until(() => w.offerRow(req, taskId).state === 'done', { what: `task ${n} done` });
    return [Number(/over in (\d+) s/.exec(line)[1]), w.claim(req, taskId).absent];
  };
  const short = PROBE_TIMEOUT_MS / 1000;
  const long = REQUEST_TIMEOUT_MS / 1000;

  w.net.sleep('zzz');
  const slept = w.net.now();
  await w.net.until(() => silent()?.[zzz.pk], { what: 'the sleeper known to be silent' });
  const since = silent();
  assert.deepEqual(Object.keys(since), [zzz.pk], 'the member it asked in vain for long, and no other');
  assert.ok(since[zzz.pk] > slept && since[zzz.pk] <= w.net.now(), `asleep at ${slept}, silent since ${since[zzz.pk]}`);
  await w.run(900);
  assert.deepEqual(silent(), since, 'since when is said once, however often it is asked in vain after');
  await w.restart(exe);
  let [took, absent] = await round();
  assert.ok(took >= short && took <= short + 2, `${took} s for a member known to be silent`);
  assert.deepEqual(absent, [zzz.pk]);

  // Answering again clears the mark. One failed request after it dies is no long silence,
  // so after a restart it is a member never reached and gets the long timeout.
  w.net.sleep('zzz', false);
  await w.net.until(() => Object.keys(silent()).length === 0, { what: 'the mark gone' });
  await w.agreed([req, exe, zzz]);
  w.net.kill('zzz');
  await w.net.until(() => !w.view(exe).members.find((m) => m.pk === zzz.pk).reachable, { what: 'a request to it failed' });
  await w.run(1);
  assert.deepEqual(silent(), {});
  await w.restart(exe);
  [took, absent] = await round();
  assert.ok(took >= long, `${took} s for a member never reached`);
  assert.deepEqual(absent, [zzz.pk]);

  // A silence older than RECORD_RETENTION_SECS says nothing: such a member is gone or has
  // joined again.
  for (const [age, fits] of [[RECORD_RETENTION_SECS, (s) => s >= long], [RECORD_RETENTION_SECS - 60, (s) => s <= short + 2]]) {
    await w.run(PEER_QUIET_MS / 1000 + 300);
    exe.disk.write('peers', JSON.stringify({ silent: { [zzz.pk]: w.net.now() - age } }));
    await w.restart(exe);
    [took] = await round();
    assert.ok(fits(took), `${took} s for a member silent since ${age} s ago`);
  }
});
