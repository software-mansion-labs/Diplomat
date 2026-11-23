// A machine whose daemon was not running when the network was switched off: what the
// installer ends in its place, and what keeps the installer and a daemon that starts
// from the state directory at the same time.
// Real daemon processes on scratch directories; stand-in docker, forge and agent.
// Run: node test/daemon-off.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { holdSocket } from '../../daemon-core/src/serve.js';
import { switchOffStored } from '../src/node/offline.js';
import { createStore, readPool } from '../src/node/store.js';
import { DAEMON, POOL, check, createBench, passed, until } from './lib/daemons.mjs';

const bench = await createBench();

const OFF = 'the network was switched off';
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const taskOf = async (m, taskId) => (await m.state()).pools[0].tasks.find((t) => t.taskId === taskId) ?? null;
const offer = async (m, item, prompt, now = false) => (await m.ok('/offer', { pool: POOL, kind: 'review', item, title: item, prompt, now })).taskId;
const waiting = (m, taskId, file) => until(`${m.name}'s agent to wait for ${file}`, async () => {
  const run = (await m.state()).runs.filter((r) => r.taskId === taskId).at(-1);
  return run && m.agent(run.runId)?.waiting === file ? run : null;
});
// The documents of a machine's store, as they are on disk.
const stored = (m) => Object.fromEntries([
  ...['offers.json', 'runs.json', 'keys.json', 'locks.json'].filter((name) => fs.existsSync(path.join(m.base, name))),
  ...fs.readdirSync(path.join(m.base, 'pools')).map((f) => `pools/${f}`),
].map((name) => [name, fs.readFileSync(path.join(m.base, name), 'utf8')]));
const gone = { ok: true, daemonRunning: false, pid: null };

try {
  await check('a machine whose daemon was down when the network was switched off has its open offers cancelled and its run stopped and given back by the installer, which says how many; switched on again it runs none of it, and the pool hears', async () => {
    const [a, b] = await Promise.all([bench.machine('a').start(), bench.machine('b').start()]);
    await Promise.all([a.linked(), b.linked()]);
    await b.ok('/join', { invite: (await a.ok('/invite', { pool: POOL })).invite });
    // One that waits in the pool - B, which was told of no free slot, takes nothing -
    // and one this machine runs itself.
    const pooled = await offer(a, 'pr-1', 'say done');
    await until('B knows the task', async () => (await taskOf(b, pooled))?.state === 'available');
    const own = await offer(a, 'pr-2', 'wait never\nsay never', true);
    const run = await waiting(a, own, 'never');
    const agentPid = a.agent(run.runId).pid;
    await until('B knows the claim', async () => (await taskOf(b, own))?.executor === (await a.state()).identity.pk);
    await a.kill();
    assert.equal(alive(agentPid), true, 'the job outlives its daemon');
    const claims = () => readPool(createStore({ dir: a.base }), POOL).records
      .filter((r) => r.type === 'claim').map((r) => [r.taskId, r.state]);
    assert.deepEqual(claims(), [[own, 'held']]);

    a.setConfig({ networkEnabled: false });
    assert.deepEqual(await a.install('--stop-daemon'), { ...gone, ended: { offers: 2, runs: 1 } });
    assert.deepEqual([a.containers(), alive(agentPid), claims()], [[], false, [[own, 'released']]]);
    assert.match(a.log(), /\] the network is switched off and no daemon runs: 2 offer\(s\) cancelled, 1 run\(s\) stopped and given back\n$/);
    assert.deepEqual([fs.existsSync(a.socket), fs.existsSync(`${a.socket}.lock`)], [false, false]);
    // Asked again, it finds nothing left to end.
    assert.deepEqual(await a.install('--stop-daemon'), { ...gone, ended: { offers: 0, runs: 0 } });
    assert.equal((await taskOf(b, pooled)).state, 'available', 'nobody was told');

    a.setConfig({ networkEnabled: true });
    await a.start();
    const back = await a.state();
    assert.deepEqual(back.offers.map((o) => [o.taskId, o.state, o.reason]).sort(), [[pooled, 'cancelled', OFF], [own, 'cancelled', OFF]].sort());
    assert.deepEqual(back.runs.map((r) => [r.runId, r.state]), [[run.runId, 'stopped']]);
    await until('B hears of both', async () => (await taskOf(b, pooled))?.state === 'cancelled' && (await taskOf(b, own))?.state === 'cancelled');
    // Work offered now is done by a machine that takes work; what was cancelled is not.
    await Promise.all([a.admit(1), b.admit(1)]);
    const next = await offer(a, 'pr-3', 'say done');
    await until('the next task done', async () => (await a.state()).offers.find((o) => o.taskId === next).state === 'done');
    const ran = [...(await a.state()).runs, ...(await b.state()).runs].map((r) => r.taskId).sort();
    assert.deepEqual(ran, [own, next].sort());
    await Promise.all([a.kill(), b.kill()]);
  });

  await check('with the network on the installer only stops the daemon; switched off, it ends nothing while the state directory is held, and ends what is open once it is free', async () => {
    const m = await bench.machine('on').start();
    await m.linked();
    const taskId = await offer(m, 'pr-1', 'say done');
    await m.kill();
    const before = stored(m);
    assert.deepEqual(await m.install('--stop-daemon'), gone);
    assert.deepEqual(stored(m), before);

    // Switched off, with the state directory held as a daemon that starts holds it.
    m.setConfig({ networkEnabled: false });
    const release = await holdSocket(m.socket);
    assert.deepEqual(await m.install('--stop-daemon'), gone);
    assert.deepEqual(stored(m), before);
    await release();
    assert.deepEqual(await m.install('--stop-daemon'), { ...gone, ended: { offers: 1, runs: 0 } });
    m.setConfig({ networkEnabled: true });
    await m.start();
    assert.deepEqual((await m.state()).offers.map((o) => [o.taskId, o.state]), [[taskId, 'cancelled']]);

    // A store that lost its list of pools has nothing ended over them, and the answer
    // counts only what was ended.
    await offer(m, 'pr-2', 'say done');
    await m.kill();
    fs.rmSync(path.join(m.base, 'links.json'));
    m.setConfig({ networkEnabled: false });
    const open = stored(m);
    assert.deepEqual(await m.install('--stop-daemon'), { ...gone, ended: { offers: 0, runs: 0 } });
    assert.deepEqual(stored(m), open);
  });

  await check('what a daemon ended itself the installer leaves as it is; a store it cannot end in is said, with docker cleared all the same; and a machine no daemon ran on is given no state', async () => {
    const m = await bench.machine('self').start();
    await m.linked();
    await offer(m, 'pr-1', 'say done');
    m.setConfig({ networkEnabled: false });
    assert.deepEqual(await m.exit, { code: 0, signal: null });
    const before = stored(m);
    assert.deepEqual(await m.install('--stop-daemon'), { ...gone, ended: { offers: 0, runs: 0 } });
    assert.deepEqual(stored(m), before);

    const n = await bench.machine('bad').start();
    await n.linked();
    const run = await waiting(n, await offer(n, 'pr-1', 'wait never\nsay never', true), 'never');
    await n.kill();
    // A document of the store that cannot be read.
    fs.renameSync(path.join(n.base, 'offers.json'), path.join(n.base, 'offers.kept'));
    fs.mkdirSync(path.join(n.base, 'offers.json'));
    n.setConfig({ networkEnabled: false });
    const said = await n.install('--stop-daemon');
    assert.deepEqual([said.ok, said.daemonRunning, said.ended], [false, false, undefined]);
    assert.match(said.error, /^what this machine offered and ran could not be ended in its store: EISDIR/);
    assert.deepEqual([n.containers(), alive(n.agent(run.runId).pid), fs.existsSync(n.socket), fs.existsSync(`${n.socket}.lock`)], [[], false, false, false]);
    fs.rmdirSync(path.join(n.base, 'offers.json'));
    fs.renameSync(path.join(n.base, 'offers.kept'), path.join(n.base, 'offers.json'));
    // One that is not a document: what the installer logs of it reads as one entry.
    fs.writeFileSync(path.join(n.base, 'peers.json'), 'x\n[2026-01-01T00:00:00.000Z] ended');
    assert.deepEqual(await n.install('--stop-daemon'), { ...gone, ended: { offers: 1, runs: 1 } });
    assert.match(n.log(), /store: peers\.json does not parse \([^\n]*\n  \[2026-01/);
    assert.deepEqual(n.log().split('\n').filter((line) => line.startsWith('[') && !/^\[\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z\] /.test(line)), []);

    const never = bench.machine('never');
    never.setConfig({ networkEnabled: false });
    assert.deepEqual([await never.install('--stop-daemon'), fs.existsSync(never.base)], [gone, false]);
    // A state directory with no host's key in it: nothing to end, and no key is made.
    fs.mkdirSync(never.base);
    assert.deepEqual([await never.install('--stop-daemon'), fs.readdirSync(never.base)], [{ ...gone, ended: { offers: 0, runs: 0 } }, ['daemon.log']]);
    // A host that died between naming a pool and writing it: the pool is one it is alone in.
    fs.copyFileSync(path.join(n.base, 'identity.json'), path.join(never.base, 'identity.json'));
    fs.writeFileSync(path.join(never.base, 'links.json'), JSON.stringify({ pools: [never.link] }));
    assert.deepEqual(await never.install('--stop-daemon'), { ...gone, ended: { offers: 0, runs: 0 } });
    assert.deepEqual(fs.readdirSync(path.join(never.base, 'pools')).length, 1);
  });

  await check('a job that ended with no daemon to say so, whether one saw its end and died or none was there, is not given back at the switch-off: the installer ends its run as the job did, this machine\'s own task is done with what the job said, and the job that still ran is stopped', async () => {
    const m = await bench.machine('told').start();
    await m.linked();
    const finished = await offer(m, 'pr-1', 'wait go\nsay by itself', true);
    const unfinished = await offer(m, 'pr-2', 'wait never\nsay never', true);
    const alone = await offer(m, 'pr-3', 'wait go\nsay alone', true);
    const [run, going, after] = [await waiting(m, finished, 'go'), await waiting(m, unfinished, 'never'), await waiting(m, alone, 'go')];
    await m.kill();
    m.release('go');
    await until('the jobs to end with nobody watching', () => [run, after].every(({ runId }) => fs.existsSync(path.join(m.base, 'runs', runId, 'done'))));
    // As the daemon writes it the moment it sees the job's end; of the other, only what the job left.
    fs.writeFileSync(path.join(m.base, 'runs', `${run.runId}.outcome.json`), JSON.stringify({ ok: true, summary: 'kept on disk', usd: 0, tokens: 0, model: '', runner: 'claude', exit: 0, state: 'finished' }));

    m.setConfig({ networkEnabled: false });
    assert.deepEqual(await m.install('--stop-daemon'), { ...gone, ended: { offers: 1, runs: 3 } });
    assert.match(m.log(), /\] the network is switched off and no daemon runs: 1 offer\(s\) cancelled, 1 run\(s\) stopped and given back, 2 run\(s\) ended as the job that had finished left it\n$/);
    assert.equal(alive(m.agent(going.runId).pid), false);
    // All of it is on disk by then: the runs that were told owe nothing more.
    const runs = JSON.parse(fs.readFileSync(path.join(m.base, 'runs.json'), 'utf8')).runs;
    assert.deepEqual([runs[run.runId].end, runs[after.runId].end], ['over', 'over']);
    m.setConfig({ networkEnabled: true });
    await m.start();
    const back = await m.state();
    assert.deepEqual(back.offers.map((o) => [o.taskId, o.state, o.attempt, o.outcome?.summary ?? o.reason]).sort(), [[finished, 'done', 1, 'kept on disk'], [unfinished, 'cancelled', 1, OFF], [alone, 'done', 1, 'alone']].sort());
    assert.deepEqual(back.runs.map((r) => [r.runId, r.state]).sort(), [[run.runId, 'finished'], [going.runId, 'stopped'], [after.runId, 'finished']].sort());
    // The job named tokens; jobs.json says the model carried none for it.
    const read = back.offers.find((o) => o.taskId === alone).outcome;
    assert.deepEqual([read.tokens, read.capped], [0, true]);
    await m.kill();
  });

  await check('the switch-off done on a store sets no timer: the host signs what a switch-off signs and takes no step of its own beside it', async () => {
    const m = await bench.machine('still').start();
    await m.linked();
    const run = await waiting(m, await offer(m, 'pr-1', 'wait never\nsay never', true), 'never');
    await m.kill();
    const real = globalThis.setTimeout;
    let timers = 0;
    globalThis.setTimeout = (...args) => { timers += 1; return real(...args); };
    let ended;
    try {
      ended = await switchOffStored({ store: createStore({ dir: m.base }) });
    } finally {
      globalThis.setTimeout = real;
    }
    assert.deepEqual([ended, timers], [{ offers: 1, runs: 1, reported: 0 }, 0]);
    // The installer finds it all ended, and takes the job down.
    m.setConfig({ networkEnabled: false });
    assert.deepEqual([await m.install('--stop-daemon'), alive(m.agent(run.runId).pid)], [{ ...gone, ended: { offers: 0, runs: 0 } }, false]);
  });

  await check('an installer that cannot read the config, or reads what is no settings, takes the network for on: it stops the daemon and nothing else, with what the machine offered, its job, its containers and its directories as they were; a setting that is anything but true is the network off', async () => {
    const m = await bench.machine('unread').start();
    await m.linked();
    const run = await waiting(m, await offer(m, 'pr-1', 'wait never\nsay never', true), 'never');
    const pid = m.agent(run.runId).pid;
    await m.kill();
    const good = fs.readFileSync(m.configPath, 'utf8');
    const there = () => [stored(m), m.containers(), alive(pid), ['runs', 'mirrors', 'ca'].filter((dir) => fs.existsSync(path.join(m.base, dir)))];
    const before = there();
    assert.deepEqual(before.slice(1), [[run.container, `${run.container}-relay`], true, ['runs', 'mirrors', 'ca']]);
    for (const config of ['{"networkEna', '', 'null', '"off"', '[]', '[{"networkEnabled":false}]']) {
      fs.writeFileSync(m.configPath, config);
      assert.deepEqual([await m.install('--stop-daemon'), there()], [gone, before], `a config of ${JSON.stringify(config)}`);
    }
    fs.writeFileSync(m.configPath, JSON.stringify({ ...JSON.parse(good), networkEnabled: 'true' }));
    assert.deepEqual(await m.install('--stop-daemon'), { ...gone, ended: { offers: 1, runs: 1 } });
    assert.deepEqual(there().slice(1), [[], false, []]);
  });

  await check('a daemon that starts while the state directory is held makes nothing and goes; one that serves is left its socket, and the socket a dead one left is taken', async () => {
    const m = bench.machine('hold');
    fs.mkdirSync(m.base, { recursive: true });
    const release = await holdSocket(m.socket);
    assert.equal((await m.call('GET', '/health')).status, 503);
    const child = spawn(process.execPath, [DAEMON], { env: m.env, stdio: 'ignore' });
    assert.deepEqual(await new Promise((resolve) => { child.on('exit', (code, signal) => resolve({ code, signal })); }), { code: 0, signal: null });
    assert.match(m.log(), /\] the startup lock is held by a live daemon; deferring\n$/);
    assert.deepEqual(fs.readdirSync(m.base).sort(), ['daemon.log', 'daemon.sock', 'daemon.sock.lock']);
    // A request whose end never comes does not keep the socket held.
    const half = net.connect(m.socket).on('error', () => {});
    await new Promise((resolve) => { half.write('GET /health HTTP/1.1\r\n', resolve); });
    // The socket is held by this very process, which reads that as its loop goes round.
    for (let turn = 0; turn < 3; turn += 1) await new Promise((resolve) => { setImmediate(resolve); });
    let free = false;
    release().then(() => { free = true; });
    await until('the socket given up', () => free, 20000);
    assert.deepEqual(fs.readdirSync(m.base), ['daemon.log']);

    await m.start();
    assert.equal(await holdSocket(m.socket), null);
    assert.deepEqual([(await m.call('GET', '/health')).body, fs.existsSync(`${m.socket}.lock`)], [{ ok: true, pid: m.pid }, false]);
    await m.kill();
    assert.equal(fs.existsSync(m.socket), true, 'a killed daemon leaves its socket');
    const again = await holdSocket(m.socket);
    assert.equal((await m.call('GET', '/health')).status, 503);
    await again();
    assert.deepEqual([fs.existsSync(m.socket), fs.existsSync(`${m.socket}.lock`)], [false, false]);
    // A socket that cannot be listened on at all is an error, and nothing stays held.
    const long = path.join(m.base, `${'s'.repeat(200)}.sock`);
    await assert.rejects(holdSocket(long), (err) => err.code !== 'EADDRINUSE');
    assert.deepEqual(fs.readdirSync(m.base).filter((name) => name.startsWith('sss')), []);
  });

  console.log(`\nall ${passed()} checks passed`);
} finally {
  await bench.close();
}
