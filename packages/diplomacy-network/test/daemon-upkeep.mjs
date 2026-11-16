// What the daemon does on its own, with nobody asking: it starts its transport again
// after a start that failed, sweeps and prunes on its timers, forgets runs and mirrors
// that are old, keeps its state directory to the operator, survives a fault in an
// event's handler and gives up on one that keeps coming back, refuses requests while it
// stops, takes what it made out of docker when the network is switched off, and keeps
// what a job has spent of the model for the daemon after it.
// Real daemon processes on scratch directories, with the stand-in docker, tor, forge
// and agent.
// Run: node test/daemon-upkeep.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { POOL, check, createBench, passed, until } from './lib/daemons.mjs';

// Whatever the daemon's files are allowed, it is not because this process was strict.
process.umask(0o022);

const FAKE_TOR = fileURLToPath(new URL('./lib/fake-tor.mjs', import.meta.url));
const bench = await createBench();

const offerOf = async (m, taskId) => (await m.state()).offers.find((o) => o.taskId === taskId);
const runOf = async (m, taskId) => (await m.state()).runs.filter((r) => r.taskId === taskId).at(-1) ?? null;
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const exists = (...parts) => fs.existsSync(path.join(...parts));
const names = (dir) => { try { return fs.readdirSync(dir).sort(); } catch { return []; } };
const done = (m, taskId) => until(`${taskId} done`, async () => (await offerOf(m, taskId)).state === 'done');
// A task this machine runs itself, at once.
// The interval the first check's daemon writes its snapshot at.
const STATE_WRITE_MS = 2000;
const own = async (m, item, prompt) => (await m.ok('/offer', { pool: POOL, kind: item.startsWith('pr') ? 'review' : 'issues', item, title: item, prompt, now: true })).taskId;
const waiting = (m, taskId, file) => until(`${m.name}'s agent to wait for ${file}`, async () => {
  const run = await runOf(m, taskId);
  return run && m.agent(run.runId)?.waiting === file ? run : null;
});
// How many times the sweep has run: each one lists this daemon's containers.
const sweeps = (m) => m.docker('ps').length;
const moreSweeps = (m, n = 3) => { const from = sweeps(m); return until(`${n} more sweeps on ${m.name}`, () => sweeps(m) >= from + n); };
const count = (text, part) => text.split(part).length - 1;
// How a daemon that is to end by itself ended; one that goes on fails the check.
const gone = async (m) => { await until(`${m.name} to end`, () => m.exited); return m.exit; };
// A few of the node's ticks: time for a transport that would be started again to be.
async function moreTicks(m) {
  const from = (await m.state()).updatedAt;
  await until('the daemon to go on a while', async () => (await m.state()).updatedAt >= from + 2);
}

try {
  await check('a transport whose start fails is made and started again, each wait twice the last up to the cap, and comes up in the same daemon once tor can run', async () => {
    const m = bench.machine('t1', { transport: 'tor', env: { DN_TRANSPORT_RETRY_MS: '100', DN_TRANSPORT_RETRY_MAX_MS: '400' } });
    const tor = path.join(m.home, 'bin', 'tor');
    m.env.DN_TOR = tor;
    await m.start();
    const { daemon } = await m.state();
    const tries = () => [...m.log().matchAll(/the transport did not start \((.*)\): the next try is in ([\d.]+) s/g)].map((found) => [found[1].replace(/:.*/, ''), Number(found[2])]);

    // No tor on this machine.
    await until('five failed starts', () => tries().length >= 5);
    assert.deepEqual(tries().slice(0, 5), [0.1, 0.2, 0.4, 0.4, 0.4].map((wait) => [`cannot run ${tor}`, wait]));
    const failed = await until('the snapshot to say so', async () => { const { transport } = await m.state(); return transport.state === 'failed' ? transport : null; });
    assert.match(failed.detail, /^cannot run .*\/bin\/tor: /);
    assert.equal((await m.call('POST', '/admit', { slots: 0 })).status, 200, 'the socket answers all the while');

    // A tor that starts and falls over: each try is seen starting before it fails.
    const install = (body) => { fs.writeFileSync(`${tor}.new`, `#!/bin/sh\n${body}\n`, { mode: 0o755 }); fs.renameSync(`${tor}.new`, tor); };
    install('sleep 0.3\nexit 1');
    await until('a start that is under way', async () => ['starting', 'bootstrapping'].includes((await m.state()).transport.state));
    await until('and fails for the new reason', async () => { const { transport } = await m.state(); return transport.state === 'failed' && /^tor exited \(code 1\)/.test(transport.detail); });

    install(`exec "${process.execPath}" "${FAKE_TOR}" "$@"`);
    await until('the transport ready', async () => (await m.state()).transport.state === 'ready');
    assert.deepEqual((await m.state()).daemon, daemon, 'the daemon that was started first');

    // And it is the node's transport: another machine joins through it.
    const other = await bench.machine('t2', { transport: 'tor' }).start();
    await Promise.all([m.linked(), other.linked()]);
    const { invite } = await m.ok('/invite', { pool: POOL });
    await other.ok('/join', { invite });
    await until('two members on both', async () => (await Promise.all([m, other].map((x) => x.state()))).every((s) => s.pools[0].members.length === 2));
    const failures = tries().length;
    await moreTicks(m);
    assert.equal(tries().length, failures, 'a transport that came up is not started again');
    assert.deepEqual([await m.stop(), await other.stop()], [{ code: 0, signal: null }, { code: 0, signal: null }]);
  });

  let up;
  await check('the sweep and the prune fire on their timer: an idle container goes, an old certificate authority goes once no job runs, and state.json is written no more often than its interval under a burst of changes', async () => {
    up = await bench.machine('up', { env: { DN_SWEEP_MS: '200', DN_CONTAINER_IDLE_MS: '1500', DN_STATE_WRITE_MS: String(STATE_WRITE_MS) } }).start();
    await up.linked();
    const taskId = await own(up, 'pr-1', 'wait held\nsay swept');
    const run = await waiting(up, taskId, 'held');
    const ca = path.join(up.base, 'ca');
    // The job's authority; beside it an older one for the same hosts, and what is no
    // authority at all.
    const [current] = names(ca);
    assert.deepEqual([names(ca).length, names(path.join(ca, current))], [1, ['ca.crt', 'ca.key', 'leaves', 'meta.json']]);
    fs.cpSync(path.join(ca, current), path.join(ca, '0123456789ab'), { recursive: true });
    const meta = JSON.parse(fs.readFileSync(path.join(ca, current, 'meta.json'), 'utf8'));
    fs.writeFileSync(path.join(ca, '0123456789ab', 'meta.json'), JSON.stringify({ ...meta, createdAt: meta.createdAt - 3600 }));
    fs.writeFileSync(path.join(ca, 'current'), `${current}\n`);
    await moreSweeps(up);
    assert.deepEqual([names(ca), up.containers().includes(run.container)], [['0123456789ab', current, 'current'].sort(), true], 'nothing goes while a job runs');
    up.release('held');
    await done(up, taskId);
    await until('the old authority pruned', () => !exists(ca, '0123456789ab'));
    await until('the idle container removed', () => up.containers().length === 0);
    assert.deepEqual(names(ca), [current], 'the one a next job of these hosts is given stays');
    assert.match(up.log(), new RegExp(`removing ${run.container}: idle`));

    // Every change moves the snapshot; the file follows one interval behind at most, and
    // is not written more often than that. Four writes begin three intervals apart; the
    // first may have begun before the burst did, by less than an interval.
    const file = path.join(up.base, 'state.json');
    const written = new Set([fs.statSync(file).mtimeMs]);
    const from = Date.now();
    let slots = 0;
    await until('four writes under a burst', async () => {
      slots = (slots % 900) + 1;
      await up.ok('/admit', { slots });
      written.add(fs.statSync(file).mtimeMs);
      return written.size > 4;
    });
    const took = Date.now() - from;
    assert.ok(took >= 2 * STATE_WRITE_MS, `state.json was written four times in ${took} ms, at an interval of ${STATE_WRITE_MS} ms`);
    await until('the file to catch up', () => JSON.parse(fs.readFileSync(file, 'utf8')).admit.slots === slots);
  });

  await check('a run\'s directory and outcome are forgotten a day after it ended and never while it runs; a mirror goes a day after its pool was last linked', async () => {
    const runs = path.join(up.base, 'runs');
    const ended = await runOf(up, (await up.state()).offers[0].taskId);
    const going = await waiting(up, await own(up, 'issue-2', 'wait kept\nsay kept'), 'kept');
    const parts = (run) => [path.join(runs, run.runId), path.join(runs, '.containers', run.container, run.runId), path.join(runs, `${run.runId}.outcome.json`)];
    const kept = (run) => parts(run).map((part) => { try { fs.lstatSync(part); return true; } catch { return false; } });
    const mirror = path.join(up.base, 'mirrors', names(path.join(up.base, 'mirrors'))[0]);
    const age = (file, hours) => fs.lutimesSync(file, Date.now() / 1000 - hours * 3600, Date.now() / 1000 - hours * 3600);

    await moreSweeps(up);
    assert.deepEqual([kept(ended), kept(going), exists(mirror)], [[true, true, true], [true, true, false], true], 'all of it is there the day it ended');
    // A day and an hour on: both runs, and the mirror of a pool that is still linked.
    for (const part of [parts(ended)[0], parts(ended)[2], parts(going)[0], mirror]) age(part, 25);
    await until('the ended run forgotten', () => kept(ended).every((there) => !there));
    assert.match(up.log(), /forgot 1 run\(s\) that ended over 24 h ago/);
    await moreSweeps(up);
    assert.deepEqual([kept(going), exists(mirror)], [[true, true, false], true], 'the run that goes on stays, and so does the mirror');
    assert.ok(Date.now() - fs.statSync(mirror).mtimeMs < 3600000, 'a linked pool\'s mirror is as young as the last sweep');
    up.release('kept');
    await done(up, going.taskId);

    // Unlinked: the mirror is left to age, and goes once it is a day old.
    await up.ok('/pools', { pools: [] });
    await moreSweeps(up);
    age(mirror, 23);
    await moreSweeps(up);
    assert.equal(exists(mirror), true, 'not yet');
    assert.ok(Date.now() - fs.statSync(mirror).mtimeMs > 22 * 3600000, 'nor touched any more');
    age(mirror, 25);
    await until('the mirror removed', () => !exists(mirror));
    assert.deepEqual(kept(going), [true, true, true], 'a run that ended a moment ago is kept');
    await up.kill();
  });

  await check('an exception in an event\'s handler is logged once with its stack and the daemon goes on; the same one five times within a minute ends it with a failure, to be started again', async () => {
    const m = bench.machine('f');
    const file = path.join(m.home, 'faults');
    m.env.DN_TEST_FAULTS = file;
    await m.start();
    const { daemon } = await m.state();
    const thrown = () => count(m.log(), 'uncaught: Error: ');
    const fault = (...lines) => { fs.writeFileSync(`${file}.new`, lines.map((line) => `${line}\n`).join('')); fs.renameSync(`${file}.new`, file); };

    fault('first fault', 'second fault');
    await until('both thrown', () => thrown() === 2);
    for (const what of ['first fault', 'second fault']) {
      assert.equal(count(m.log(), `uncaught: Error: ${what}\n    at `), 1, `${what}: once, with where it was thrown`);
    }
    assert.equal(count(m.log(), 'first fault'), 1, 'and nowhere else in the log');
    await m.linked();
    assert.deepEqual([(await m.state()).daemon, (await m.state()).pools.length], [daemon, 1], 'the same daemon, serving');

    // Four of one and four of another: neither came back five times.
    fault('same', 'other', 'same', 'other', 'same', 'other', 'same', 'other');
    await until('eight more thrown', () => thrown() === 10);
    assert.equal((await m.call('GET', '/health')).status, 200);
    fault('same');
    assert.deepEqual(await gone(m), { code: 1, signal: null });
    assert.equal(count(m.log(), 'uncaught: Error: same\n    at '), 5);
    assert.match(m.log(), /the same fault 5 times within 60 s: exiting, to be started again\n$/);
    assert.equal(exists(m.socket), false);
    await m.start();
    assert.equal((await m.state()).pools.length, 1, 'the next daemon takes over what was there');
    await m.kill();
  });

  await check('everything under the state directory is the operator\'s alone, whatever the directory and the log were before and whatever the umask is', async () => {
    const m = bench.machine('modes', { transport: 'tor' });
    // As an earlier daemon left them.
    fs.mkdirSync(m.base);
    fs.chmodSync(m.base, 0o755);
    fs.writeFileSync(path.join(m.base, 'daemon.log'), 'from before\n', { mode: 0o644 });
    await m.start();
    await m.linked();
    await done(m, await own(m, 'pr-1', 'api GET /repos/acme/widgets/pulls/1\nsay done'));
    await until('the snapshot on disk', () => exists(m.base, 'state.json'));

    const open = [];
    const walk = (at) => {
      const st = fs.lstatSync(at);
      // A link has no mode of its own to speak of.
      if (st.isSymbolicLink()) return;
      if ((st.mode & 0o077) !== 0) open.push(`${path.relative(m.base, at) || '.'} ${(st.mode & 0o777).toString(8)}`);
      if (st.isDirectory()) for (const name of fs.readdirSync(at)) walk(path.join(at, name));
    };
    walk(m.base);
    assert.deepEqual(open, []);
    const seen = (...parts) => exists(m.base, ...parts);
    const [authority] = names(path.join(m.base, 'ca'));
    assert.deepEqual([seen('daemon.log'), seen('daemon.sock'), seen('identity.json'), seen('runs', '.containers'), seen('mirrors'), ...['ca.key', 'ca.crt', 'meta.json', path.join('leaves', 'api.github.com.key')].map((part) => seen('ca', authority, part)), seen('tor'), seen('jobs.json')],
      Array(11).fill(true), 'the walk met every part of it');
    assert.ok(fs.readFileSync(path.join(m.base, 'daemon.log'), 'utf8').startsWith('from before\n'));
    assert.deepEqual(await m.stop(), { code: 0, signal: null });
  });

  await check('a request that reaches the daemon while it stops is refused with a 503 and a sentence, and changes nothing', async () => {
    const m = await bench.machine('s', { env: { DN_SWITCH_OFF_WAIT_MS: '60000' } }).start();
    await m.linked();
    await waiting(m, await own(m, 'pr-1', 'wait never\nsay never'), 'never');
    // A request already under way when the daemon starts to stop: its last bytes arrive
    // while the daemon waits for a job the engine is slow to stop.
    const body = JSON.stringify({ slots: 7, reason: 'late' });
    const socket = net.connect(m.socket);
    let said = '';
    socket.on('data', (chunk) => { said += chunk; });
    await new Promise((resolve) => socket.on('connect', resolve));
    socket.write(`POST /admit HTTP/1.1\r\nHost: daemon\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\n\r\n${body.slice(0, 5)}`);
    assert.equal((await m.call('GET', '/health')).status, 200);
    fs.writeFileSync(path.join(m.dockerDir, 'hold-exec'), '');
    m.setConfig({ networkEnabled: false });
    await until('the daemon to start stopping', () => /ending: the network was switched off/.test(m.log()));
    socket.write(body.slice(5));
    // The answer's body comes chunked: its end is the empty chunk.
    await until('its answer', () => said.endsWith('\r\n0\r\n\r\n'));
    assert.match(said, /^HTTP\/1\.1 503 /);
    assert.deepEqual(JSON.parse(/\{.*\}/.exec(said)[0]), { error: 'The Diplomacy Network daemon is stopping.' });
    assert.equal((await m.call('GET', '/health')).status, 0, 'and nobody new is let in');
    fs.rmSync(path.join(m.dockerDir, 'hold-exec'));
    assert.deepEqual(await gone(m), { code: 0, signal: null });
    assert.notEqual(JSON.parse(fs.readFileSync(path.join(m.base, 'state.json'), 'utf8')).admit.slots, 7);
    socket.destroy();
  });

  await check('a machine that leaves the network takes its containers, relays, networks and volumes with it, by the daemon\'s own end or by the installer after a daemon that died; a daemon that is only stopped leaves them for the next', async () => {
    const world = (m) => [m.containers().length, names(path.join(m.dockerDir, 'networks')).length, names(path.join(m.dockerDir, 'volumes')).filter((n) => n.endsWith('.labels')).length];
    const m = await bench.machine('o1').start();
    await m.linked();
    const run = await waiting(m, await own(m, 'pr-1', 'wait never\nsay never'), 'never');
    const agentPid = m.agent(run.runId).pid;
    // The container and its relay, their network, the work volume.
    assert.deepEqual(world(m), [2, 1, 1]);
    m.setConfig({ networkEnabled: false });
    assert.deepEqual(await gone(m), { code: 0, signal: null });
    assert.deepEqual([world(m), alive(agentPid)], [[0, 0, 0], false]);
    assert.match(m.log(), /removed 2 container\(s\), 1 network\(s\) and 1 volume\(s\)/);
    assert.equal(exists(m.dockerDir, 'images', encodeURIComponent(m.docker('build')[0][m.docker('build')[0].indexOf('-t') + 1])), true, 'the image is kept');

    // A daemon that died with a job going. Stopped while the network is on, nothing is
    // touched: the next daemon is to find its job.
    const n = await bench.machine('o2').start();
    await n.linked();
    const left = await waiting(n, await own(n, 'pr-1', 'wait never\nsay never'), 'never');
    const leftPid = n.agent(left.runId).pid;
    await n.kill();
    assert.deepEqual([await n.install('--stop-daemon'), world(n), alive(leftPid)], [{ ok: true, daemonRunning: false, pid: null }, [2, 1, 1], true]);
    // Nor on a config caught in the middle of a rewrite, which says nothing.
    fs.writeFileSync(n.configPath, '{"networkEna');
    assert.deepEqual([await n.install('--stop-daemon'), world(n), alive(leftPid)], [{ ok: true, daemonRunning: false, pid: null }, [2, 1, 1], true]);
    fs.writeFileSync(n.configPath, '{"networkEnabled":true}');
    n.setConfig({ networkEnabled: false });
    assert.deepEqual([await n.install('--stop-daemon'), world(n), alive(leftPid)], [{ ok: true, daemonRunning: false, pid: null }, [0, 0, 0], false]);
  });

  await check('a container that outgrew its disk allowance has its job stopped as a failed attempt that says so, and goes with its relay, its network, its volume and its run records', async () => {
    const m = await bench.machine('q', { env: { DN_SWEEP_MS: '200', DN_CONTAINER_DISK_BYTES: String(4 * 2 ** 20) } }).start();
    await m.linked();
    const taskId = await own(m, 'pr-1', 'wait never\nsay never');
    const run = await waiting(m, taskId, 'never');
    const agentPid = m.agent(run.runId).pid;
    const records = path.join(m.base, 'runs', '.containers', run.container);
    await moreSweeps(m);
    assert.deepEqual([m.containers().includes(run.container), alive(agentPid), exists(records, run.runId)], [true, true, true], 'within its allowance it is left alone');

    const [volume] = names(path.join(m.dockerDir, 'volumes')).filter((n) => !n.endsWith('.labels'));
    fs.writeFileSync(path.join(m.dockerDir, 'volumes', volume, 'big'), Buffer.alloc(5 * 2 ** 20, 1));
    await until('the run failed', async () => (await m.state()).runs.find((r) => r.runId === run.runId).state === 'failed');
    await until('the offer to say why', async () => (await offerOf(m, taskId)).reason === 'the container outgrew its disk allowance');
    assert.equal((await offerOf(m, taskId)).attempt, 2, 'which cost the task an attempt');
    await until('the container discarded', () => m.log().includes(`discarded ${run.container}`));
    assert.match(m.log(), new RegExp(`${run.container} holds \\d+ bytes of this machine's disk, over the ${4 * 2 ** 20} a container gets: stopping its 1 job\\(s\\) and removing it`));
    assert.equal(alive(agentPid), false);
    assert.doesNotMatch(m.log(), /upkeep of .* failed/, 'it was removed once its job was gone, not tried before');
    const removed = (kind, name) => m.docker(kind).some((c) => c.includes('rm') && c.at(-1) === name);
    assert.deepEqual([m.docker('rm').some((c) => c.at(-1) === run.container), removed('network', run.container), removed('volume', volume)], [true, true, true]);
    assert.deepEqual([exists(records, run.runId), fs.lstatSync(path.join(m.base, 'runs', run.runId), { throwIfNoEntry: false })], [false, undefined], 'its run records and the link to them');
    await m.kill();
  });

  await check('what a job has spent of the model is kept for the daemon after it, which counts on from there', async () => {
    const m = await bench.machine('sp').start();
    await m.linked();
    const taskId = await own(m, 'pr-1', 'wait go\nmodel\nsay asked');
    const run = await waiting(m, taskId, 'go');
    const jobsFile = path.join(m.base, 'jobs.json');
    const keptOf = () => JSON.parse(fs.readFileSync(jobsFile, 'utf8')).jobs[run.runId];
    assert.deepEqual(await m.stop(), { code: 0, signal: null });
    assert.deepEqual(keptOf().spent, { requests: 0, bytes: 0 });
    // As if the job had used up its share before the daemon went.
    const all = JSON.parse(fs.readFileSync(jobsFile, 'utf8'));
    all.jobs[run.runId].spent = { requests: 5000, bytes: 123 };
    fs.writeFileSync(jobsFile, JSON.stringify(all));
    const at = fs.statSync(jobsFile).mtimeMs;
    await m.start();
    await until('the job taken up and jobs.json written again', () => m.log().includes(`${run.runId} taken up in ${run.container}`) && fs.statSync(jobsFile).mtimeMs !== at);
    assert.deepEqual(keptOf().spent, { requests: 5000, bytes: 123 }, 'the broker counts on from what was kept');
    m.release('go');
    await done(m, taskId);
    const step = m.agent(run.runId).steps.find((s) => s.verb === 'model');
    assert.equal(step.status, 429);
    assert.match(JSON.stringify(step.body), /this job has used all of the model it gets on this executor/);
    await m.kill();
  });

  console.log(`\nall ${passed()} checks passed`);
} finally {
  await bench.close();
}
process.exit(0);
