// A job under a running daemon when the docker engine restarts or goes silent, and when
// the job does the like to itself: what the engine says of the job's container and of
// its relay, which no job reaches, decides whether the requester loses an attempt.
// Real daemon processes on scratch directories over the loop transport, with the
// stand-in docker, forge and agent.
// Run: node test/daemon-engine.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { POOL, check, createBench, passed, sleep, until } from './lib/daemons.mjs';

const bench = await createBench();

const offerOf = async (m, taskId) => (await m.state()).offers.find((o) => o.taskId === taskId);
const runOf = async (m, taskId) => (await m.state()).runs.filter((r) => r.taskId === taskId).at(-1) ?? null;
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const review = (item, prompt) => ({ pool: POOL, kind: 'review', item, title: `Review ${item}`, prompt });
const waiting = (m, taskId, file) => until(`${m.name}'s agent to wait for ${file}`, async () => {
  const run = await runOf(m, taskId);
  return run && m.agent(run.runId)?.waiting === file ? run : null;
});
// A container the stand-in docker holds, set to no longer running: `oom` for one the
// kernel killed for its memory.
const stopped = (m, name, oom = false) => {
  const file = path.join(m.dockerDir, 'containers', `${name}.json`);
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), running: false, oom }));
};
const INSIDE = 'the job\'s container stopped before the job finished, its relay running on: it was stopped from inside';
// A's task once B's run of it has ended and the pool has heard: `attempt` is 2 for an
// attempt that counted.
const after = (a, taskId, attempt) => until(`${taskId} back in the pool at attempt ${attempt}`, async () => {
  const offer = await offerOf(a, taskId);
  return offer.state === 'pooled' && offer.attempt === attempt ? offer : null;
});

async function pair(names, env = {}) {
  const all = names.map((name) => bench.machine(name, { env }));
  await Promise.all(all.map((m) => m.start()));
  await Promise.all(all.map((m) => m.linked()));
  const { invite } = await all[0].ok('/invite', { pool: POOL });
  await all[1].ok('/join', { invite });
  await until(`${names.join(' and ')} members of one pool`, async () => (await Promise.all(all.map((m) => m.state()))).every((s) => s.pools[0].members.length === 2));
  return all;
}

try {
  await check('an engine that restarts under a running daemon - the job\'s container and its relay stopped - gives the job back at no attempt, and so do a container removed from under its job and an engine that does not answer when the job is found gone; a container stopped from inside, its relay running on or killed for its memory, is a failed attempt', async () => {
    const [a, b] = await pair(['ra', 'rb']);
    await b.admit(1);
    const one = await a.ok('/offer', review('pr-1', 'wait never\nsay never'));
    const first = await waiting(b, one.taskId, 'never');
    // As the engine leaves them: no process of the job's left, both containers stopped.
    await b.admit(0);
    b.killJobs();
    stopped(b, first.container);
    stopped(b, `${first.container}-relay`);
    await after(a, one.taskId, 1);
    assert.equal((await runOf(b, one.taskId)).state, 'stopped');
    assert.ok(b.log().includes(`giving ${first.runId} back: the docker engine stopped its container and the container's relay under the job, as a restart of the engine or of the machine does\n`), b.log().slice(-1500));

    await b.admit(1);
    const two = await a.ok('/offer', review('pr-2', 'wait never\nsay never'));
    const second = await waiting(b, two.taskId, 'never');
    await b.admit(0);
    b.killJobs();
    stopped(b, second.container);
    const offer = await after(a, two.taskId, 2);
    assert.deepEqual([offer.reason, (await runOf(b, two.taskId)).state], [INSIDE, 'failed']);

    // A relay a job flooded until the kernel killed it, and then the job's own container
    // stopped from inside: both stopped, as a restart leaves them, but by the job.
    await b.admit(1);
    const five = await a.ok('/offer', review('pr-5', 'wait never\nsay never'));
    const fifth = await waiting(b, five.taskId, 'never');
    await b.admit(0);
    b.killJobs();
    stopped(b, `${fifth.container}-relay`, true);
    stopped(b, fifth.container);
    const flooded = await until(`${five.taskId} back in the pool`, async () => ((await offerOf(a, five.taskId)).state === 'pooled' ? offerOf(a, five.taskId) : null));
    assert.deepEqual([flooded.attempt, flooded.reason, (await runOf(b, five.taskId)).state], [2, INSIDE, 'failed']);

    // A container removed from under its job: no job can do that to its own.
    await b.admit(1);
    const three = await a.ok('/offer', review('pr-3', 'wait never\nsay never'));
    const third = await waiting(b, three.taskId, 'never');
    await b.admit(0);
    b.killJobs();
    fs.rmSync(path.join(b.dockerDir, 'containers', `${third.container}.json`));
    await after(a, three.taskId, 1);

    // An engine that stops answering as the job is found gone: nothing can be said of it.
    await b.admit(1);
    const four = await a.ok('/offer', review('pr-4', 'wait never\nsay never'));
    const fourth = await waiting(b, four.taskId, 'never');
    await b.admit(0);
    const mute = path.join(b.dockerDir, 'fail-version');
    fs.writeFileSync(mute, 'Cannot connect to the Docker daemon\n'.repeat(100000));
    try {
      b.killJobs();
      stopped(b, fourth.container);
      await after(a, four.taskId, 1);
    } finally {
      fs.rmSync(mute, { force: true });
    }
    assert.ok(b.log().includes(`giving ${fourth.runId} back: the docker engine did not answer when its container was looked at, and nothing can be said of the job in it\n`), b.log().slice(-1500));
    await Promise.all([a.kill(), b.kill()]);
  });

  await check('an engine that does not answer under a running daemon says nothing of a job: after the wait for it the job is given back at no attempt, once, and stopped once the engine is back; a container in which nothing can be run while the engine answers is a failed attempt', async () => {
    const [a, b] = await pair(['sa', 'sb'], { DN_ENGINE_WAIT_MS: '2000' });
    await b.admit(1);
    const one = await a.ok('/offer', review('pr-1', 'wait never\nsay never'));
    const first = await waiting(b, one.taskId, 'never');
    const pid = b.agent(first.runId).pid;
    await b.admit(0);
    const down = path.join(b.dockerDir, 'down');
    fs.writeFileSync(down, '');
    await after(a, one.taskId, 1);
    assert.deepEqual([(await runOf(b, one.taskId)).state, alive(pid)], ['stopped', true]);
    const silence = `giving ${first.runId} back: the docker engine did not answer for 2 s while the job ran, and nothing can be said of the job in it\n`;
    assert.ok(b.log().includes(silence), b.log().slice(-1500));
    // Given back once, however long the engine stays silent after.
    const looks = b.docker('version').length;
    await until('more looks at the engine', () => b.docker('version').length >= looks + 3);
    assert.equal(b.log().split(silence).length - 1, 1);
    fs.rmSync(down);
    await until('the job stopped', () => !alive(pid));

    await b.admit(1);
    const two = await a.ok('/offer', review('pr-2', 'wait never\nsay never'));
    await waiting(b, two.taskId, 'never');
    await b.admit(0);
    // What root in the container can bring about, as by putting something else at /bin/sh.
    const failing = path.join(b.dockerDir, 'fail-exec');
    fs.writeFileSync(failing, 'OCI runtime exec failed: exec failed: unable to start container process: resource temporarily unavailable\n'.repeat(20000));
    try {
      const offer = await after(a, two.taskId, 2);
      assert.deepEqual([offer.reason, (await runOf(b, two.taskId)).state], ['the job\'s processes went before it finished, in a container that runs on', 'failed']);
    } finally {
      fs.rmSync(failing, { force: true });
    }
    b.killJobs();
    await Promise.all([a.kill(), b.kill()]);
  });

  await check('a look at the engine that goes unanswered now and then, the looks between answered, never adds up to the wait: no job is given back', async () => {
    const [a, b] = await pair(['ta', 'tb'], { DN_ENGINE_WAIT_MS: '3000' });
    await b.admit(1);
    const one = await a.ok('/offer', review('pr-1', 'wait go\nsay done'));
    const first = await waiting(b, one.taskId, 'go');
    const down = path.join(b.dockerDir, 'down');
    // Two short spells of silence, each under the wait, further apart than it.
    for (let spell = 0; spell < 2; spell++) {
      const looks = b.docker('version').length;
      fs.writeFileSync(down, '');
      try {
        await until('looks in the silence', () => b.docker('version').length >= looks + 3);
        await sleep(1200);
      } finally {
        fs.rmSync(down);
      }
      await sleep(spell === 0 ? 4000 : 2000);
    }
    assert.deepEqual([(await runOf(b, one.taskId)).state, (await offerOf(a, one.taskId)).attempt], ['running', 1]);
    assert.ok(!b.log().includes(`giving ${first.runId} back`), b.log().slice(-1500));
    b.release('go');
    await until('the task done', async () => (await offerOf(a, one.taskId)).state === 'done');
    await Promise.all([a.kill(), b.kill()]);
  });

  console.log(`\nall ${passed()} checks passed`);
} finally {
  await bench.close();
}
process.exit(0);
