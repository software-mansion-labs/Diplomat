// A daemon that comes back to jobs an earlier one left running: nothing new is started
// in a container before the jobs left in it were taken up, whether the new job was
// waiting for its key when the daemon went or is offered the moment it is back, and a
// job the daemon has lost every record of is found in its container and stopped.
// Real daemon processes on scratch directories over the loop transport, with the
// stand-in docker, forge and agent.
// Run: node test/daemon-restart.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { GITLAB_POOL, POOL, check, createBench, passed, sleep, until } from './lib/daemons.mjs';
import { GITLAB_HOST } from './lib/fake-forge.mjs';

const bench = await createBench();

const offerOf = async (m, taskId) => (await m.state()).offers.find((o) => o.taskId === taskId);
const runOf = async (m, taskId) => (await m.state()).runs.filter((r) => r.taskId === taskId).at(-1) ?? null;
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
// Whether this host shows a process's environment, as a container's /proc does: where
// it does not, the stand-in docker cannot find a job's processes by their run id.
const PROC = fs.existsSync('/proc/self/environ');
// What a daemon asked of a run's container since `from`, as [verb, run id, group].
// Ends a process group this suite's stand-in docker could not: gone already is as good.
const end = (group) => { try { process.kill(-group, 'SIGKILL'); } catch {} };
const asked = (m, runId, from) => m.docker('exec').slice(from).filter((c) => c.includes(runId)).map((c) => c.slice(c.indexOf(runId) - 1, c.indexOf(runId) + 2));
const done = (m, taskId) => until(`${taskId} done`, async () => (await offerOf(m, taskId)).state === 'done');
// The run of a task on `m` once its agent waits for `file`.
const waiting = (m, taskId, file) => until(`${m.name}'s agent to wait for ${file}`, async () => {
  const run = await runOf(m, taskId);
  return run && m.agent(run.runId)?.waiting === file ? run : null;
});
// A task's second attempt open to be taken: the first is counted when its run's end is
// heard, and the offer is back in the pool one step of its requester later, when the
// claim is seen to be gone.
const backInThePool = (m, taskId) => until(`${taskId} back in the pool`, async () => {
  const offer = await offerOf(m, taskId);
  return offer.attempt === 2 && offer.state === 'pooled';
});
// A run as the node keeps it on disk, once it says there that its job is being started.
const launched = (m, taskId) => until(`${m.name} to start the job of ${taskId}`, () => {
  try {
    return Object.values(JSON.parse(fs.readFileSync(path.join(m.base, 'runs.json'), 'utf8')).runs).find((run) => run.taskId === taskId && run.launched) ?? null;
  } catch { return null; }
});
// Nothing shows that a start is held back until the jobs left from before are taken
// up: the start is given the time it would need to reach the container if it were not
// held, which is well under this, and is then looked at.
const TIME_TO_REACH_THE_CONTAINER = 1500;

// Two machines in one pool of their own: the first founds it, the second joins.
async function pair(names, linkOf, pool) {
  const all = names.map((name) => bench.machine(name));
  await Promise.all(all.map((m) => m.start()));
  await Promise.all(all.map((m) => m.ok('/pools', { pools: [linkOf(m)] })));
  const { invite } = await all[0].ok('/invite', { pool });
  await all[1].ok('/join', { invite });
  await until(`${names.join(' and ')} members of one pool`, async () => (await Promise.all(all.map((m) => m.state()))).every((s) => s.pools[0].members.length === 2));
  return all;
}

try {
  await check('a run still waiting for its key when the daemon went is started by the next daemon only once the job left running is taken up: the container is not restarted under that job', async () => {
    const [a, b] = await pair(['ka', 'kb'], (m) => m.gitlabLink(), GITLAB_POOL);
    // The forge does not say the project's number, so the requester asks for it again
    // whenever it makes a task's rules; later the answer is kept back, and with it the
    // key those rules go into.
    let project = 'refused';
    const kept = [];
    bench.forge.route(GITLAB_HOST, 'GET', /^\/api\/v4\/projects\/acme%2Fwidgets$/, (req, res) => {
      const answer = (status) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(status === 200 ? { id: 99 } : { message: 'not now' }));
      if (project === 'kept') kept.push(() => answer(200));
      else answer(project === 'refused' ? 500 : 200);
    });
    const task = (item, file) => ({ pool: GITLAB_POOL, kind: 'review', item, title: `Review ${item}`, prompt: `wait ${file}\nsay reviewed ${item}` });

    await b.ok('/admit', { slots: 1 });
    const one = await a.ok('/offer', task('pr-1', 'one'));
    const first = await waiting(b, one.taskId, 'one');
    const firstPid = b.agent(first.runId).pid;
    const two = await a.ok('/offer', task('pr-2', 'two'));
    project = 'kept';
    await b.ok('/admit', { slots: 2 });
    await until('the second run to wait for its key', async () => kept.length > 0 && (await runOf(b, two.taskId))?.state === 'preparing');
    assert.deepEqual(await b.stop(), { code: 0, signal: null });
    const left = Object.values(JSON.parse(fs.readFileSync(path.join(b.base, 'runs.json'), 'utf8')).runs).find((run) => run.taskId === two.taskId);
    assert.deepEqual([left.state, left.launched, alive(firstPid)], ['preparing', false, true], 'one job left running, one run left without its key');
    project = 'given';
    for (const answer of kept) answer();

    // The engine is slow to answer the daemon that comes back, so nothing was looked at
    // when the second run has its key and its job is to be started.
    const [restarts, made] = [b.docker('restart').length, b.docker('run').length];
    fs.writeFileSync(path.join(b.dockerDir, 'hold-version'), '');
    await b.start();
    const second = await launched(b, two.taskId);
    await sleep(TIME_TO_REACH_THE_CONTAINER);
    assert.deepEqual([b.agent(second.runId), b.docker('restart').slice(restarts), alive(firstPid)], [null, [], true], 'held back while the first job cannot be taken up');
    fs.rmSync(path.join(b.dockerDir, 'hold-version'));

    await until('the first job taken up', () => b.log().includes(`${first.runId} taken up in ${first.container}`));
    const started = await waiting(b, two.taskId, 'two');
    assert.deepEqual([started.runId, started.container], [second.runId, first.container], 'the same run, in the same container');
    assert.deepEqual([b.docker('restart').slice(restarts), b.docker('run').length, alive(firstPid), b.agent(first.runId).waiting], [[], made, true, 'one'], 'and the first job went on undisturbed');
    b.release('one');
    b.release('two');
    await Promise.all([done(a, one.taskId), done(a, two.taskId)]);
    assert.deepEqual([b.agent(first.runId).pid, (await offerOf(a, one.taskId)).outcome.summary, (await offerOf(a, two.taskId)).outcome.summary], [firstPid, 'reviewed pr-1', 'reviewed pr-2']);
    await Promise.all([a.kill(), b.kill()]);
  });

  let a;
  let b;
  await check('a task this machine offers to run at once, the moment its daemon is back, waits the same way for a job left in the container it goes to', async () => {
    [a, b] = await pair(['na', 'nb'], (m) => m.link, POOL);
    const task = (kind, item, file, more = {}) => ({ pool: POOL, kind, item, title: `${kind} ${item}`, prompt: `wait ${file}\nsay did ${item}`, ...more });
    await b.ok('/admit', { slots: 1 });
    // One job for another machine and one of this machine's own: two containers.
    const theirs = await a.ok('/offer', task('review', 'pr-1', 'theirs'));
    const forA = await waiting(b, theirs.taskId, 'theirs');
    const mine = await b.ok('/offer', task('review', 'pr-2', 'mine', { now: true }));
    const own = await waiting(b, mine.taskId, 'mine');
    const ownPid = b.agent(own.runId).pid;
    assert.notEqual(own.container, forA.container);
    assert.deepEqual(await b.stop(), { code: 0, signal: null });
    assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(b.base, 'jobs.json'), 'utf8')).jobs), [forA.runId, own.runId], 'the job for the other machine is the first to be taken up');

    // The engine stops answering in the middle of that: the first job is being taken
    // up, the second has not been looked at.
    const [restarts, inspected] = [b.docker('restart').length, b.docker('container').length];
    fs.writeFileSync(path.join(b.dockerDir, 'hold-container-inspect'), '');
    await b.start();
    await until('the first job being taken up', () => b.docker('container').length > inspected);
    const next = await b.ok('/offer', task('issues', 'issue-2', 'next', { now: true }));
    const second = await launched(b, next.taskId);
    await sleep(TIME_TO_REACH_THE_CONTAINER);
    assert.deepEqual([b.agent(second.runId), alive(ownPid)], [null, true]);
    fs.rmSync(path.join(b.dockerDir, 'hold-container-inspect'));

    const started = await waiting(b, next.taskId, 'next');
    assert.deepEqual([started.runId, started.container], [second.runId, own.container], 'this machine\'s own container, where its earlier job still runs');
    assert.deepEqual([b.docker('restart').slice(restarts), alive(ownPid), b.agent(own.runId).waiting], [[], true, 'mine'], 'which was not restarted under that job');
    for (const file of ['theirs', 'mine', 'next']) b.release(file);
    await Promise.all([done(a, theirs.taskId), done(b, mine.taskId), done(b, next.taskId)]);
    assert.equal(b.agent(own.runId).pid, ownPid);
  });

  await check('a job whose process group the daemon before this one did not live to keep is ended by its run id, not by the group its own run directory names, and its container is left with no job', async () => {
    const m = await bench.machine('lost', { env: { DN_SWEEP_MS: '200', DN_CONTAINER_IDLE_MS: '1500' } }).start();
    await m.linked();
    const { taskId } = await m.ok('/offer', { pool: POOL, kind: 'review', item: 'pr-4', title: 'Review', prompt: 'wait never\nsay never', now: true });
    const run = await waiting(m, taskId, 'never');
    await m.kill();
    const file = path.join(m.base, 'jobs.json');
    const kept = JSON.parse(fs.readFileSync(file, 'utf8'));
    const group = kept.jobs[run.runId].pid;
    assert.ok(group > 1 && alive(group), 'the group the daemon kept');
    // As a daemon leaves it that goes between starting a job and hearing its group.
    kept.jobs[run.runId].pid = 0;
    fs.writeFileSync(file, JSON.stringify(kept));
    // What the job can write: the group of something that is not its own.
    const bystander = spawn('sleep', ['600'], { detached: true, stdio: 'ignore' });
    fs.writeFileSync(path.join(m.base, 'runs', run.runId, 'pid'), `${bystander.pid}\n`);
    const execs = m.docker('exec').length;
    try {
      await m.start();
      const line = `${run.runId} was being started when the daemon before this one went: stopping what there is of it in ${run.container}`;
      await until('the job looked at', () => m.log().includes(line) || m.log().includes(`${run.runId} taken up`));
      assert.ok(m.log().includes(line), m.log().slice(-1500));
      await until('the run failed', async () => (await runOf(m, taskId)).state === 'failed');
      assert.equal(alive(bystander.pid), true, 'the group its run directory named was not touched');
      assert.equal(m.log().includes(`${run.runId} taken up`), false);
      const ofIt = asked(m, run.runId, execs);
      assert.ok(ofIt.length >= 2 && ofIt.every(([verb, , named]) => ['stop', 'left'].includes(verb) && named === '0'), JSON.stringify(ofIt));
      if (PROC) await until('everything of the job gone', () => !alive(group));
      // The node knew the run and not what became of its job: a failed attempt.
      await backInThePool(m, taskId);
      assert.equal((await offerOf(m, taskId)).reason, 'the run ended without saying how');
      await until('its container, which holds no job, removed as idle', () => m.containers().length === 0);
      assert.equal(alive(bystander.pid), true);
    } finally {
      bystander.kill('SIGKILL');
      if (!PROC) end(group);
    }
    await m.kill();
  });

  await check('a job the daemon has no record of any more is found in its container and stopped, once', async () => {
    await b.ok('/admit', { slots: 1 });
    const { taskId } = await a.ok('/offer', { pool: POOL, kind: 'review', item: 'pr-3', title: 'Review', prompt: 'wait never\nsay never' });
    const run = await waiting(b, taskId, 'never');
    const agentPid = b.agent(run.runId).pid;
    await b.kill();
    const group = JSON.parse(fs.readFileSync(path.join(b.base, 'jobs.json'), 'utf8')).jobs[run.runId].pid;
    assert.ok(group > 1 && alive(group), 'the group the daemon kept');
    fs.rmSync(path.join(b.base, 'jobs.json'));
    const execs = b.docker('exec').length;
    await b.start();

    const line = `stopping ${run.runId} in ${run.container}: this daemon holds no record of the job`;
    await until('the job looked at', () => b.log().includes(line));
    // Nobody holds its group any more: it is known by its run id.
    await until('the job stopped', () => asked(b, run.runId, execs).some(([verb]) => verb === 'left'));
    assert.ok(asked(b, run.runId, execs).every(([, , named]) => named === '0'), JSON.stringify(asked(b, run.runId, execs)));
    if (PROC) await until('everything of the job gone', () => !alive(agentPid) && !alive(group));
    else end(group);
    // The node knew the run and not what became of its job: a failed attempt.
    await until('the run failed on B', async () => (await runOf(b, taskId)).state === 'failed');
    await backInThePool(a, taskId);
    assert.equal((await offerOf(a, taskId)).reason, 'the run ended without saying how');
    const outcome = await until('its end on record', () => {
      try { return JSON.parse(fs.readFileSync(path.join(b.base, 'runs', `${run.runId}.outcome.json`), 'utf8')); } catch { return null; }
    });
    assert.deepEqual([outcome.ok, outcome.state], [false, 'stopped']);
    // Looked at again and again from here on, and left alone.
    const from = (await b.state()).updatedAt;
    await until('more looks at the jobs', async () => (await b.state()).updatedAt >= from + 2);
    assert.equal(b.log().split(line).length - 1, 1);
    await Promise.all([a.kill(), b.kill()]);
  });

  console.log(`\nall ${passed()} checks passed`);
} finally {
  await bench.close();
}
process.exit(0);
