// How the daemon ends and what the daemon after it finds: which of its two ends a signal
// brings, what an end leaves of the socket when another daemon has it, a job that
// finished while the daemon was on its way out, and what a switch-off takes with it.
// Real daemon processes on scratch directories; stand-in tor, docker, forge and agent.
// Run: node test/daemon-end.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DAEMON, POOL, check, createBench, passed, until } from './lib/daemons.mjs';

const bench = await createBench();

const offerOf = async (m, taskId) => (await m.state()).offers.find((o) => o.taskId === taskId);
const runsOf = async (m, taskId) => (await m.state()).runs.filter((r) => r.taskId === taskId);
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const names = (dir) => { try { return fs.readdirSync(dir).sort(); } catch { return []; } };
const json = (...parts) => JSON.parse(fs.readFileSync(path.join(...parts), 'utf8'));
const count = (text, part) => text.split(part).length - 1;
// The containers, networks and volumes the stand-in docker holds for a machine.
const world = (m) => [m.containers().length, names(path.join(m.dockerDir, 'networks')).length, names(path.join(m.dockerDir, 'volumes')).filter((n) => n.endsWith('.labels')).length];
// A task this machine runs itself, at once.
const own = async (m, item, prompt) => (await m.ok('/offer', { pool: POOL, kind: 'review', item, title: item, prompt, now: true })).taskId;
const waiting = (m, taskId, file) => until(`${m.name}'s agent to wait for ${file}`, async () => {
  const run = (await runsOf(m, taskId)).at(-1);
  return run && m.agent(run.runId)?.waiting === file ? run : null;
});
// A daemon that reads Diplomat's config once, as it starts: what it does at a signal is
// by what it reads then.
const NO_POLL = { DN_CONFIG_POLL_MS: '3600000' };

try {
  await check('a signal that follows the switch at once switches the daemon off, though it never read the setting itself; one that finds the config unreadable only stops it', async () => {
    const m = await bench.machine('sig', { env: NO_POLL }).start();
    await m.linked();
    const taskId = await own(m, 'pr-1', 'wait never\nsay never');
    const run = await waiting(m, taskId, 'never');
    const agentPid = m.agent(run.runId).pid;
    assert.deepEqual(world(m), [2, 1, 1]);
    // Half a file, as the signal finds it in the middle of a rewrite: that says nothing.
    const good = fs.readFileSync(m.configPath, 'utf8');
    fs.writeFileSync(m.configPath, good.slice(0, 20));
    assert.deepEqual(await m.stop(), { code: 0, signal: null });
    assert.deepEqual([world(m), alive(agentPid)], [[2, 1, 1], true], 'its job is left going for the daemon after it');

    fs.writeFileSync(m.configPath, good);
    await m.start();
    await until('the job taken up', () => m.log().includes(`${run.runId} taken up in ${run.container}`));
    // As an applet does it: the setting, then the signal.
    m.setConfig({ networkEnabled: false });
    assert.deepEqual(await m.stop(), { code: 0, signal: null });
    assert.deepEqual([world(m), alive(agentPid)], [[0, 0, 0], false]);
    assert.doesNotMatch(m.log(), /ending: the network was switched off/, 'it was the signal that ended it');
    const left = json(m.base, 'state.json');
    assert.deepEqual([left.offers.map((o) => [o.state, o.reason]), left.runs.map((r) => r.state)], [[['cancelled', 'the network was switched off']], ['stopped']]);
  });

  await check('SIGHUP ends the daemon as SIGTERM does: its runs left going, its socket and daemon.json gone, and the log says so', async () => {
    const m = await bench.machine('hup').start();
    await m.linked();
    const run = await waiting(m, await own(m, 'pr-1', 'wait never\nsay never'), 'never');
    process.kill(m.pid, 'SIGHUP');
    assert.deepEqual(await m.exit, { code: 0, signal: null });
    assert.match(m.log(), /ending: SIGHUP\n[\s\S]*ended\n$/);
    assert.deepEqual([fs.existsSync(m.socket), fs.existsSync(path.join(m.base, 'daemon.json')), alive(m.agent(run.runId).pid)], [false, false, true]);
    await m.start();
    await until('the job taken up', () => m.log().includes(`${run.runId} taken up in ${run.container}`));
    await m.kill();
  });

  await check('a daemon that ends after another took its socket leaves the socket and daemon.json to that one', async () => {
    const m = bench.machine('own');
    const start = () => {
      const child = spawn(process.execPath, [DAEMON], { env: m.env, stdio: 'ignore' });
      return { child, exit: new Promise((resolve) => { child.on('exit', (code, signal) => resolve({ code, signal })); }) };
    };
    const owner = () => { try { return json(m.base, 'daemon.json').pid; } catch { return null; } };
    const first = start();
    await until('the first daemon', () => owner() === first.child.pid);
    // A daemon that answers nothing for longer than a start waits is taken for dead.
    first.child.kill('SIGSTOP');
    const second = start();
    try {
      await until('the second daemon to take the socket', () => owner() === second.child.pid);
      first.child.kill('SIGTERM');
      first.child.kill('SIGCONT');
      assert.deepEqual(await first.exit, { code: 0, signal: null });
      assert.deepEqual([(await m.call('GET', '/health')).body, owner()], [{ ok: true, pid: second.child.pid }, second.child.pid]);
    } finally {
      second.child.kill('SIGKILL');
      first.child.kill('SIGKILL');
      await Promise.all([first.exit, second.exit]);
    }
    // With no daemon.json to name another, the socket is its own to remove.
    const alone = await bench.machine('own2').start();
    fs.rmSync(path.join(alone.base, 'daemon.json'));
    assert.deepEqual(await alone.stop(), { code: 0, signal: null });
    assert.equal(fs.existsSync(alone.socket), false);
  });

  await check('a job that finishes while its daemon is on its way out is forgotten only once the node\'s word on its end is on disk: the daemon after it has one run, done, and no second attempt', async () => {
    // A tor that will not go when asked: the daemon's end lasts the grace tor is given.
    const m = await bench.machine('late', { transport: 'tor', env: { FAKE_TOR_STAGE: 'ignore-term' } }).start();
    await m.linked();
    await until('its tor', async () => (await m.state()).transport.state === 'ready');
    const jobsFile = path.join(m.base, 'jobs.json');
    // The job has to end between the node's stop and the daemon's exit. Under enough load
    // it misses that, and is then taken up and finished by the next daemon: tried again.
    let ended = null;
    for (let n = 1; !ended; n += 1) {
      assert.ok(n <= 6, 'no job ended while its daemon was on its way out');
      const taskId = await own(m, `pr-${n}`, `wait go-${n}\nsay late`);
      const run = await waiting(m, taskId, `go-${n}`);
      const kept = fs.readFileSync(jobsFile, 'utf8');
      const from = m.log().length;
      const stopped = m.stop();
      await until('the daemon to start ending', () => m.log().slice(from).includes('ending: SIGTERM\n'));
      m.release(`go-${n}`);
      assert.deepEqual(await stopped, { code: 0, signal: null });
      if (m.log().slice(from).includes(`${run.runId} ended: finished\n`)) {
        ended = { taskId, run, kept };
        assert.deepEqual([Object.keys(json(jobsFile).jobs), json(m.base, 'runs.json').runs[run.runId].endedAt > 0], [[], true], 'the job is gone from jobs.json, and its run has ended in runs.json');
      }
      await m.start();
      await until('the task done', async () => (await offerOf(m, taskId)).state === 'done');
    }
    const { taskId, run, kept } = ended;
    const once = async () => [(await offerOf(m, taskId)).attempt, (await offerOf(m, taskId)).outcome.summary, (await runsOf(m, taskId)).map((r) => [r.runId, r.state])];
    assert.deepEqual(await once(), [1, 'late', [[run.runId, 'finished']]]);
    assert.doesNotMatch(m.log(), /the run ended without saying how/);

    // Killed between the two writes, a daemon leaves the job in jobs.json and the run
    // ended in runs.json: the next one reports nothing twice.
    assert.deepEqual(await m.stop(), { code: 0, signal: null });
    fs.writeFileSync(jobsFile, kept);
    assert.deepEqual(Object.keys(json(jobsFile).jobs), [run.runId]);
    await m.start();
    await until('jobs.json written again', () => Object.keys(json(jobsFile).jobs).length === 0);
    assert.deepEqual(await once(), [1, 'late', [[run.runId, 'finished']]]);
    assert.doesNotMatch(m.log(), /could not be taken up/);
    await m.kill();
  });

  await check('an outcome on disk is honoured by the daemon after a kill, whether jobs.json still names the job or not', async () => {
    const m = await bench.machine('hand').start();
    await m.linked();
    const tasks = [await own(m, 'pr-1', 'wait go\nsay by itself'), await own(m, 'pr-2', 'wait go\nsay by itself')];
    const [named, lost] = await Promise.all(tasks.map((taskId) => waiting(m, taskId, 'go')));
    await m.kill();
    m.release('go');
    for (const run of [named, lost]) {
      await until(`${run.runId} to end with nobody watching`, () => fs.existsSync(path.join(m.base, 'runs', run.runId, 'done')));
      // As the daemon writes it the moment it sees the job's end.
      fs.writeFileSync(path.join(m.base, 'runs', `${run.runId}.outcome.json`), JSON.stringify({ ok: true, summary: 'kept on disk', usd: 0, tokens: 0, model: '', runner: 'claude', exit: 0, state: 'finished' }));
    }
    const jobsFile = path.join(m.base, 'jobs.json');
    const jobs = json(jobsFile);
    assert.deepEqual(Object.keys(jobs.jobs).sort(), [named.runId, lost.runId].sort());
    delete jobs.jobs[lost.runId];
    fs.writeFileSync(jobsFile, JSON.stringify(jobs));

    await m.start();
    await until('both tasks done', async () => (await Promise.all(tasks.map((taskId) => offerOf(m, taskId)))).every((offer) => offer.state !== 'pooled' && offer.state !== 'claimed'));
    for (const [taskId, run] of [[tasks[0], named], [tasks[1], lost]]) {
      const offer = await offerOf(m, taskId);
      assert.deepEqual([offer.state, offer.attempt, offer.outcome?.summary, (await runsOf(m, taskId)).map((r) => [r.runId, r.state])], ['done', 1, 'kept on disk', [[run.runId, 'finished']]]);
    }
    assert.doesNotMatch(m.log(), /the run ended without saying how/);
    await m.kill();
  });

  await check('a job is not forgotten while the node\'s word on its end cannot be written: jobs.json names it until then, and the daemon after a kill finds its outcome', async () => {
    const m = await bench.machine('full').start();
    await m.linked();
    const taskId = await own(m, 'pr-1', 'wait go\nsay written late');
    const run = await waiting(m, taskId, 'go');
    // As a full disk has it: the node's documents cannot be replaced.
    const runsFile = path.join(m.base, 'runs.json');
    const runs = fs.readFileSync(runsFile, 'utf8');
    fs.rmSync(runsFile);
    fs.mkdirSync(path.join(runsFile, 'in the way'), { recursive: true });
    m.release('go');
    await until('the job\'s end seen', () => m.log().includes(`${run.runId} ended: finished\n`));
    await until('jobs.json left as it was', () => m.log().includes('] jobs.json is as it was: '));
    assert.deepEqual(Object.keys(json(m.base, 'jobs.json').jobs), [run.runId]);
    await m.kill();
    fs.rmSync(runsFile, { recursive: true });
    fs.writeFileSync(runsFile, runs, { mode: 0o600 });
    await m.start();
    await until('the task done', async () => (await offerOf(m, taskId)).state === 'done');
    assert.deepEqual([(await offerOf(m, taskId)).attempt, (await offerOf(m, taskId)).outcome.summary, (await runsOf(m, taskId)).length], [1, 'written late', 1]);
    await m.kill();
  });

  await check('reads of the config that fail count in a row: failures on either side of a good read never add up to a switch-off', async () => {
    const m = await bench.machine('row', { env: { DN_CONFIG_UNREADABLE_POLLS: '6', DN_CONFIG_POLL_MS: '1000' } }).start();
    const good = JSON.parse(fs.readFileSync(m.configPath, 'utf8'));
    const failed = () => count(m.log(), 'config.json could not be read (');
    const told = () => count(m.log(), '] the jobs started from now on are given ');
    // Four times two failed reads, six of which in a row would switch it off.
    for (let round = 1; round <= 4; round += 1) {
      fs.writeFileSync(m.configPath, '{"networkEna');
      await until(`two more failed reads (${round})`, () => failed() >= 2 * round);
      // A good read, seen by what it changes.
      fs.writeFileSync(m.configPath, JSON.stringify({ ...good, networkDevices: round % 2 === 1 }));
      await until(`a good read (${round})`, () => { assert.equal(m.exited, false, m.log().slice(-600)); return told() === round; });
    }
    assert.doesNotMatch(m.log(), /ending/);
    assert.match(m.log(), /could not be read \(1 of 6\)[\s\S]*could not be read \(1 of 6\)/);
    await m.kill();
  });

  const kept = (m) => ['runs', 'mirrors', 'ca', 'identity.json', 'pools', 'links.json', 'offers.json'].filter((name) => fs.existsSync(path.join(m.base, name)));

  await check('a machine that leaves the network keeps its key, its pools and what it offered, and nothing of its jobs: no run record, no mirror, no certificate authority; one that is only stopped keeps them all', async () => {
    const m = await bench.machine('gone').start();
    await m.linked();
    const taskId = await own(m, 'pr-1', 'say done');
    await until('a job that ended', async () => (await offerOf(m, taskId)).state === 'done');
    const run = await waiting(m, await own(m, 'pr-2', 'wait never\nsay never'), 'never');
    const everything = ['runs', 'mirrors', 'ca', 'identity.json', 'pools', 'links.json', 'offers.json'];
    assert.deepEqual(await m.stop(), { code: 0, signal: null });
    assert.deepEqual([kept(m), fs.existsSync(path.join(m.base, 'runs', run.runId, 'prompt.txt'))], [everything, true]);

    await m.start();
    await until('the job taken up', () => m.log().includes(`${run.runId} taken up in ${run.container}`));
    m.setConfig({ networkEnabled: false });
    assert.deepEqual(await m.exit, { code: 0, signal: null });
    assert.deepEqual([kept(m), world(m)], [['identity.json', 'pools', 'links.json', 'offers.json'], [0, 0, 0]]);
  });

  await check('a switch-off that finds the docker engine not answering says what it left and ends with a failure; the installer answers in its time that it is still there, and removes it once the engine answers', async () => {
    const m = await bench.machine('eng', { env: { DN_SWITCH_OFF_WAIT_MS: '1500', DN_INSTALLER_ANSWER_MS: '3000' } }).start();
    await m.linked();
    const run = await waiting(m, await own(m, 'pr-1', 'wait never\nsay never'), 'never');
    const agentPid = m.agent(run.runId).pid;
    // The engine takes every listing and answers none.
    const hold = path.join(m.dockerDir, 'hold-ps');
    fs.writeFileSync(hold, '');
    m.setConfig({ networkEnabled: false });
    assert.deepEqual(await m.exit, { code: 1, signal: null });
    assert.match(m.log(), /\] switched off with what this daemon made in docker still there: the docker engine did not answer within 1\.5 s\n[^\n]*\] ended\n$/);
    assert.deepEqual([world(m), alive(agentPid), kept(m).slice(0, 3)], [[2, 1, 1], false, ['runs', 'mirrors', 'ca']], 'its job is stopped; what a container left behind may hold stays');

    const from = Date.now();
    assert.deepEqual(await m.install('--stop-daemon'), {
      ok: false, daemonRunning: false, pid: null, error: 'the daemon is gone, but what it made in docker is still there: the docker engine did not answer in time',
    });
    assert.ok(Date.now() - from < 30000, 'answered, and gone, with the engine still silent');
    assert.deepEqual(world(m), [2, 1, 1]);

    fs.rmSync(hold);
    assert.deepEqual(await m.install('--stop-daemon'), { ok: true, daemonRunning: false, pid: null });
    assert.deepEqual([world(m), kept(m)], [[0, 0, 0], ['identity.json', 'pools', 'links.json', 'offers.json']]);
  });

  await check('a machine with no docker at all has nothing in docker to leave: its switch-off and the installer both end well', async () => {
    const m = await bench.machine('bare', { docker: 'none' }).start();
    await m.linked();
    await until('its word on docker', async () => (await m.state()).docker.state === 'missing');
    m.setConfig({ networkEnabled: false });
    assert.deepEqual(await m.exit, { code: 0, signal: null });
    assert.deepEqual(await m.install('--stop-daemon'), { ok: true, daemonRunning: false, pid: null });
  });

  // A git that waits, at the commands a mirror is made or refreshed with, while a file is there.
  function heldGit(m) {
    const hold = path.join(m.home, 'hold-git');
    const file = path.join(m.home, 'bin', 'git-held');
    fs.writeFileSync(file, `#!/bin/sh\ncase " $* " in *" clone "*|*" update "*) : > "${hold}.waiting"; while [ -e "${hold}" ]; do sleep 0.05; done;; esac\nexec git "$@"\n`, { mode: 0o755 });
    m.env.DN_GIT = file;
    return { hold, waiting: () => fs.existsSync(`${hold}.waiting`) };
  }
  const jobStarts = (m) => m.docker('exec').filter((call) => call.some((arg) => /run\.sh$/.test(arg)));

  await check('a job being started when the network is switched off is not started: the switch-off waits for the start to find that out, no container is made for it, and nothing is left', async () => {
    // Its start waits for the mirror.
    const a = bench.machine('mid1', { env: { DN_SWITCH_OFF_WAIT_MS: '60000' } });
    const git = heldGit(a);
    await a.start();
    await a.linked();
    fs.writeFileSync(git.hold, '');
    const first = await own(a, 'pr-1', 'say started');
    await until('the start to wait for its mirror', git.waiting);
    const [early] = await runsOf(a, first);
    a.setConfig({ networkEnabled: false });
    await until('the daemon to start ending', () => /ending: the network was switched off/.test(a.log()));
    fs.rmSync(git.hold);
    assert.deepEqual(await a.exit, { code: 0, signal: null });
    assert.deepEqual([a.docker('run'), a.agent(early.runId), world(a)], [[], null, [0, 0, 0]]);

    // Its start waits for the engine to make its container.
    const b = await bench.machine('mid2', { env: { DN_SWITCH_OFF_WAIT_MS: '60000' } }).start();
    await b.linked();
    const hold = path.join(b.dockerDir, 'hold-run');
    fs.writeFileSync(hold, '');
    const second = await own(b, 'pr-1', 'say started');
    await until('the container to be asked for', () => b.docker('run').length > 0);
    const [late] = await runsOf(b, second);
    b.setConfig({ networkEnabled: false });
    await until('the daemon to start ending', () => /ending: the network was switched off/.test(b.log()));
    fs.rmSync(hold);
    assert.deepEqual(await b.exit, { code: 0, signal: null });
    assert.deepEqual([jobStarts(b), b.agent(late.runId), world(b)], [[], null, [0, 0, 0]]);
  });

  await check('a start that outlasts the switch-off is said to be left, with a failure: a container the engine makes after the daemon went is removed by the installer', async () => {
    const a = bench.machine('out1', { env: { DN_SWITCH_OFF_WAIT_MS: '1500' } });
    const git = heldGit(a);
    await a.start();
    await a.linked();
    fs.writeFileSync(git.hold, '');
    await own(a, 'pr-1', 'say started');
    await until('the start to wait for its mirror', git.waiting);
    a.setConfig({ networkEnabled: false });
    assert.deepEqual(await a.exit, { code: 1, signal: null });
    assert.match(a.log(), /\] switched off with what this daemon made in docker still there: a job was still being started\n/);
    fs.rmSync(git.hold);

    const b = await bench.machine('out2', { env: { DN_SWITCH_OFF_WAIT_MS: '1500' } }).start();
    await b.linked();
    const hold = path.join(b.dockerDir, 'hold-run');
    fs.writeFileSync(hold, '');
    await own(b, 'pr-1', 'say started');
    await until('the container to be asked for', () => b.docker('run').length > 0);
    b.setConfig({ networkEnabled: false });
    assert.deepEqual(await b.exit, { code: 1, signal: null });
    assert.match(b.log(), /\] switched off with what this daemon made in docker still there: the docker engine did not answer within 1\.5 s\n/);
    // The engine goes on with what it was asked.
    fs.rmSync(hold);
    await until('the container made after all', () => b.containers().length > 0);
    assert.deepEqual(await b.install('--stop-daemon'), { ok: true, daemonRunning: false, pid: null });
    assert.deepEqual(world(b), [0, 0, 0]);
  });

  console.log(`\nall ${passed()} checks passed`);
} finally {
  await bench.close();
}
process.exit(0);
