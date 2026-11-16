// A job that will not be stopped: one that left a stop script and a process group of
// its choosing in its run directory, ignores TERM and left a child behind, one in a
// container where nothing can be run any more, one beside a job that was being asked
// after, and one of which only a process outside its group is left. Either way the job's
// proxy token is dead before anything is asked of its container, and the job is gone in
// the end.
// Real daemon processes on scratch directories over the loop transport, with the
// stand-in docker, forge and agent.
// Run: node test/daemon-stop.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { POOL, check, createBench, passed, until } from './lib/daemons.mjs';

const bench = await createBench();

const offerOf = async (m, taskId) => (await m.state()).offers.find((o) => o.taskId === taskId);
const runOf = async (m, taskId) => (await m.state()).runs.filter((r) => r.taskId === taskId).at(-1) ?? null;
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const review = (item, prompt) => ({ pool: POOL, kind: 'review', item, title: `Review ${item}`, prompt });
const waiting = (m, taskId, file) => until(`${m.name}'s agent to wait for ${file}`, async () => {
  const run = await runOf(m, taskId);
  return run && m.agent(run.runId)?.waiting === file ? run : null;
});
const kept = (m) => JSON.parse(fs.readFileSync(path.join(m.base, 'jobs.json'), 'utf8'));

// What the broker of `m` answers a job's token that asks for a way to the forge: the
// status of its answer to the CONNECT.
const proxyStatus = (m, token) => new Promise((resolve) => {
  const socket = net.connect(kept(m).port, '127.0.0.1');
  let said = '';
  const done = (status) => { socket.destroy(); resolve(status); };
  socket.on('connect', () => socket.write(`CONNECT api.github.com:443 HTTP/1.1\r\nHost: api.github.com:443\r\nProxy-Authorization: Basic ${Buffer.from(`dn:${token}`).toString('base64')}\r\n\r\n`));
  socket.on('data', (chunk) => {
    said += chunk.toString('latin1');
    if (said.includes('\r\n')) done(Number(said.split(' ')[1]));
  });
  socket.on('error', () => done(0));
  socket.on('close', () => done(0));
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

const strays = [];
try {
  await check('a job that planted a stop script and another group in its run directory, ignores TERM and left a child behind is stopped by the daemon after the one that started it, and its token is dead before its container is asked anything', async () => {
    const [a, b] = await pair(['da', 'db']);
    await b.ok('/admit', { slots: 2 });
    const other = await a.ok('/offer', review('pr-1', 'wait other\nsay other'));
    const beside = await waiting(b, other.taskId, 'other');
    const besidePid = b.agent(beside.runId).pid;
    const group = (run) => kept(b).jobs[run.runId].pid;
    // The job names the other job's process group as its own, for whoever believes it.
    const { taskId } = await a.ok('/offer', review('pr-2', ['plant stop.sh exit 0', `plant pid ${group(beside)}`, 'deaf', 'child', 'wait never', 'say never'].join('\n')));
    const run = await waiting(b, taskId, 'never');
    const agent = b.agent(run.runId);
    strays.push(agent.steps.find((s) => s.verb === 'child').pid);
    const { token } = kept(b).jobs[run.runId];
    assert.equal(fs.readFileSync(path.join(b.base, 'runs', run.runId, 'pid'), 'utf8').trim(), String(group(beside)), 'what the job wrote');
    assert.notEqual(group(run), group(beside));
    assert.equal(await proxyStatus(b, token), 200);

    assert.deepEqual(await b.stop(), { code: 0, signal: null });
    await b.start();
    await until('both jobs taken up', () => [run, beside].every((r) => b.log().includes(`${r.runId} taken up in ${r.container}`)));
    assert.equal(await proxyStatus(b, token), 200, 'the job goes on under its token');

    // The engine does not answer while the job is stopped: nothing was asked of the
    // container yet when the token is already refused.
    fs.writeFileSync(path.join(b.dockerDir, 'hold-exec'), '');
    await a.ok('/withdraw', { taskId, reason: 'no longer wanted' });
    await until('the token refused', async () => (await proxyStatus(b, token)) === 407);
    assert.equal(alive(agent.pid), true, 'while the job itself still runs');
    fs.rmSync(path.join(b.dockerDir, 'hold-exec'));

    await until('the job gone', () => !alive(agent.pid));
    await until('the run stopped', async () => (await runOf(b, taskId)).state === 'stopped');
    // Processes are found by their environment where there is a /proc to read it from.
    if (fs.existsSync('/proc/self/environ')) await until('the child it left gone', () => !alive(strays[0]));
    assert.deepEqual([alive(besidePid), b.agent(beside.runId).waiting, await proxyStatus(b, kept(b).jobs[beside.runId].token)], [true, 'other', 200], 'the job whose group it named was not touched');
    assert.deepEqual(b.docker('exec').filter((c) => c.some((arg) => arg.includes('/dn/runs/')) && !/\/run\.sh$/.test(c.at(-2))), [], 'nothing is run from a run directory but the runner');
    b.release('other');
    await until('the other job done', async () => (await offerOf(a, other.taskId)).state === 'done');
    await Promise.all([a.kill(), b.kill()]);
  });

  await check('a container in which nothing can be run is restarted once a stop has gone unanswered long enough, and the other job in it ends as a failed attempt that says so', async () => {
    // The other job is not asked after meanwhile: it would be given up for lost first.
    const [a, b] = await pair(['ra', 'rb'], { DN_JOB_STOP_BOUND_MS: '1500', DN_JOB_LIVENESS_MS: '600000' });
    await b.ok('/admit', { slots: 2 });
    const one = await a.ok('/offer', review('pr-1', 'wait one\nsay one'));
    const two = await a.ok('/offer', review('pr-2', 'wait two\nsay two'));
    const [first, second] = [await waiting(b, one.taskId, 'one'), await waiting(b, two.taskId, 'two')];
    assert.equal(first.container, second.container);
    const pids = [first, second].map((run) => b.agent(run.runId).pid);
    const { token } = kept(b).jobs[first.runId];
    const restarts = b.docker('restart').length;

    fs.writeFileSync(path.join(b.dockerDir, 'fail-exec'), 'OCI runtime exec failed: exec failed: unable to start container process: resource temporarily unavailable\n'.repeat(20000));
    const from = Date.now();
    await a.ok('/withdraw', { taskId: one.taskId, reason: 'no longer wanted' });
    await until('the token refused', async () => (await proxyStatus(b, token)) === 407);
    await until('the container restarted', () => b.docker('restart').length > restarts);
    assert.ok(Date.now() - from >= 1500, 'not before the stop had its time');
    assert.deepEqual(b.docker('restart')[restarts], ['restart', '-t', '0', first.container]);
    fs.rmSync(path.join(b.dockerDir, 'fail-exec'), { force: true });
    await until('both jobs gone', () => pids.every((pid) => !alive(pid)));

    await until('the stopped run stopped', async () => (await runOf(b, one.taskId)).state === 'stopped');
    await until('the other run failed', async () => (await runOf(b, two.taskId)).state === 'failed');
    await until('the other task back in the pool', async () => (await offerOf(a, two.taskId)).attempt === 2);
    assert.equal((await offerOf(a, two.taskId)).reason, 'the container was restarted to stop another job');
    await Promise.all([a.kill(), b.kill()]);
  });

  await check('a job that was being asked after when its container was restarted to stop another ends as a failed attempt that says so, not as one that disappeared', async () => {
    const [a, b] = await pair(['ca', 'cb'], { DN_JOB_STOP_BOUND_MS: '1500', DN_JOB_LIVENESS_MS: '100' });
    await b.ok('/admit', { slots: 2 });
    const one = await a.ok('/offer', review('pr-1', 'wait one\nsay one'));
    const two = await a.ok('/offer', review('pr-2', 'wait two\nsay two'));
    const [first, second] = [await waiting(b, one.taskId, 'one'), await waiting(b, two.taskId, 'two')];
    assert.equal(first.container, second.container);
    const restarts = b.docker('restart').length;

    // The first job's stop is never heard. Whether the second is up is being asked when
    // the container is restarted, and is answered after.
    for (const verb of ['stop', 'left']) fs.writeFileSync(path.join(b.dockerDir, `fail-exec-${verb}`), 'OCI runtime exec failed: exec failed: resource temporarily unavailable\n'.repeat(20000));
    fs.writeFileSync(path.join(b.dockerDir, 'hold-exec-up'), '');
    const asked = () => b.docker('exec').filter((c) => c.includes('up') && c.includes(second.runId)).length;
    const before = asked();
    await until('the second job asked after', () => asked() > before);
    await a.ok('/withdraw', { taskId: one.taskId, reason: 'no longer wanted' });
    await until('the container restarted', () => b.docker('restart').length > restarts);
    await until('both jobs gone', () => [first, second].every((run) => !alive(b.agent(run.runId).pid)));
    fs.rmSync(path.join(b.dockerDir, 'hold-exec-up'));
    for (const verb of ['stop', 'left']) fs.rmSync(path.join(b.dockerDir, `fail-exec-${verb}`), { force: true });

    await until('the other run failed', async () => (await runOf(b, two.taskId)).state === 'failed');
    await until('the other task back in the pool', async () => (await offerOf(a, two.taskId)).attempt === 2);
    assert.equal((await offerOf(a, two.taskId)).reason, 'the container was restarted to stop another job');
    await Promise.all([a.kill(), b.kill()]);
  });

  // A process outside the job's group is found by its environment, where there is a
  // /proc to read that from.
  if (!fs.existsSync('/proc/self/environ')) console.log('SKIP a job of which only a process outside its group is left: no /proc on this machine');
  else {
    await check('a job is not called stopped while a process it left outside its group lives, though its runner is gone and the stop did not get through: it is stopped again until nothing is left', async () => {
      const [a, b] = await pair(['sa', 'sb'], { DN_JOB_LIVENESS_MS: '600000' });
      await b.ok('/admit', { slots: 1 });
      const { taskId } = await a.ok('/offer', review('pr-1', 'child\nwait never\nsay never'));
      const run = await waiting(b, taskId, 'never');
      const agent = b.agent(run.runId);
      const child = agent.steps.find((s) => s.verb === 'child').pid;
      strays.push(child);
      // The runner and the agent die; what the agent left behind lives on.
      process.kill(-kept(b).jobs[run.runId].pid, 'SIGKILL');
      await until('the agent gone', () => !alive(agent.pid));
      assert.equal(alive(child), true);

      // Two stops in a row that the container never hears.
      fs.writeFileSync(path.join(b.dockerDir, 'fail-exec-stop'), 'OCI runtime exec failed: exec failed: resource temporarily unavailable\n'.repeat(2));
      const stops = () => b.docker('exec').filter((c) => c.includes('stop') && c.includes(run.runId)).length;
      const before = stops();
      await a.ok('/withdraw', { taskId, reason: 'no longer wanted' });
      await until('the run stopped', async () => (await runOf(b, taskId)).state === 'stopped');
      await until('the child gone', () => !alive(child));
      assert.ok(stops() - before >= 3, 'asked a third time, which was heard');
      await Promise.all([a.kill(), b.kill()]);
    });
  }

  console.log(`\nall ${passed()} checks passed`);
} finally {
  for (const pid of strays) { try { process.kill(pid, 'SIGKILL'); } catch {} }
  await bench.close();
}
process.exit(0);
