// How the daemon comes up: with the tools it runs found where a user's installs are when
// the process that started it was given the system's directories alone, and with a start
// that cannot be finished ended, not left answering.
// Real daemon processes on scratch directories; stand-in tor, docker and forge.
// Run: node test/daemon-start.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { POOL, check, createBench, passed, until } from './lib/daemons.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const bench = await createBench();
// The tools a daemon is given stand-ins of here.
const STOOD_IN = ['tor', 'docker', 'gh', 'glab', 'claude', 'security'];
// The PATH launchd gives an app, and with it everything the app starts: the system's
// directories, as one of links to all that is in them but those tools. A Linux machine
// has a docker and a gh there, and a Mac its `security`, and no test runs the real one.
const SYSTEM_PATH = path.join(bench.root, 'system');
fs.mkdirSync(SYSTEM_PATH);
for (const dir of ['/sbin', '/usr/sbin', '/bin', '/usr/bin']) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch {}
  for (const name of names.filter((n) => !STOOD_IN.includes(n))) {
    fs.rmSync(path.join(SYSTEM_PATH, name), { force: true });
    fs.symlinkSync(path.join(dir, name), path.join(SYSTEM_PATH, name));
  }
}
// The daemon looks beside node last, and where one of those tools is there it finds it.
const BESIDE_NODE = STOOD_IN.find((name) => fs.existsSync(path.join(path.dirname(process.execPath), name)));
const offerOf = async (m, taskId) => (await m.state()).offers.find((o) => o.taskId === taskId);

// A machine whose daemon is told where no tool is: it is given the system's PATH, and
// `dir` as the one directory a user's installs are in.
function bare(name, dir, options = {}) {
  const m = bench.machine(name, { transport: 'tor', ...options });
  Object.assign(m.env, { PATH: SYSTEM_PATH, DN_TOOL_DIRS: dir });
  for (const named of ['DN_TOR', 'DN_DOCKER', 'DN_GH', 'DN_GLAB', 'DN_SECURITY', 'DN_CLAUDE']) delete m.env[named];
  return m;
}
// A check on such a machine, left out where its daemon would run a real tool.
const bareCheck = (name, fn) => (BESIDE_NODE
  ? console.log(`SKIP ${name}: this machine has a ${BESIDE_NODE} beside node, where the daemon would find the real one`)
  : check(name, fn));

try {
  await check('a tool is the first file of its name on the path that can be run; one named by a path is looked for there alone', async () => {
    process.env.DN_BASE_DIR = path.join(bench.root, 'unused');
    const { locate } = await import('../src/paths.js');
    const [first, second] = ['first', 'second'].map((name) => path.join(bench.root, name));
    for (const dir of [first, second]) fs.mkdirSync(dir);
    const tool = (dir, name, mode = 0o755) => { fs.writeFileSync(path.join(dir, name), '#!/bin/sh\n', { mode }); return path.join(dir, name); };
    tool(first, 'unrunnable', 0o644);
    fs.mkdirSync(path.join(first, 'folder'));
    const on = `${first}:${second}`;
    assert.deepEqual([locate('one', on), locate('unrunnable', on), locate('folder', on)], [null, null, null]);
    const [inSecond, runnable, file] = [tool(second, 'one'), tool(second, 'unrunnable'), tool(second, 'folder')];
    assert.deepEqual([locate('one', on), locate('unrunnable', on), locate('folder', on)], [inSecond, runnable, file]);
    assert.equal(locate('one', `${tool(first, 'one').slice(0, -4)}:${second}`), path.join(first, 'one'));
    assert.deepEqual([locate(inSecond, first), locate(path.join(first, 'unrunnable'), on), locate(path.join(first, 'absent'), on)], [inSecond, null, null]);
  });

  await bareCheck('started with the PATH an app is given, the daemon finds tor, docker, gh and the rest where a user\'s installs are, and what they run finds its own helpers there', async () => {
    // Named from the home, and ahead of a directory whose gh is another one.
    const other = path.join(bench.root, 'more-installs');
    const m = bare('found', `~/installs:${other}`);
    const tools = path.join(m.home, 'installs');
    for (const dir of [tools, other]) fs.mkdirSync(dir);
    fs.writeFileSync(path.join(other, 'gh'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const install = (file, body) => fs.writeFileSync(path.join(tools, file), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    // tor and docker as node scripts, which run under `env node`: where node is in none
    // of the system's directories, they run only on a PATH that has node's own.
    fs.symlinkSync(path.join(HERE, 'lib', 'fake-tor.mjs'), path.join(tools, 'tor'));
    fs.symlinkSync(path.join(HERE, 'lib', 'fake-docker.mjs'), path.join(tools, 'docker'));
    // gh hands its work to a helper of its own, as the real one runs git.
    install('gh', '[ "$1 $2 $3 $4" = "auth token --hostname github.com" ] && exec gh-helper\nexit 1');
    install('gh-helper', `echo "${m.token}"`);
    install('glab', 'exit 1');
    install('security', 'exit 44');
    install('claude', 'exit 1');

    await m.start();
    const state = await until('everything ready', async () => {
      const now = await m.state();
      return now.transport.state === 'ready' && now.docker.state === 'ready' && now.model.state === 'ready' ? now : null;
    });
    assert.deepEqual([state.transport.state, state.docker.state, state.model.state], ['ready', 'ready', 'ready']);
    for (const tool of ['tor', 'docker', 'gh', 'glab', 'claude']) assert.ok(m.log().includes(`] ${tool} is ${path.join(tools, tool)}\n`), `${tool}: ${m.log()}`);
    assert.match(m.log(), /\] git is \/\S+\/git\n/);

    // A task end to end: its forge request goes out with the token gh gave.
    await m.linked();
    const { taskId } = await m.ok('/offer', { pool: POOL, kind: 'review', item: 'pr-1', title: 'Review', now: true, prompt: 'api POST /repos/acme/widgets/pulls/1/reviews {"event":"COMMENT","body":"seen"}\nsay reviewed' });
    const done = await until('the task done', async () => { const offer = await offerOf(m, taskId); return offer.state === 'done' ? offer : null; });
    assert.equal(done.outcome.summary, 'reviewed');
    assert.deepEqual(bench.sentWith(m.token).filter(([method, host]) => method === 'POST' && host === 'api.github.com'), [['POST', 'api.github.com', '/repos/acme/widgets/pulls/1/reviews']]);
    assert.deepEqual(await m.stop(), { code: 0, signal: null });
  });

  await bareCheck('a tool that is nowhere is named: tor and docker in the snapshot, each of them in the log, and found without a restart once it is installed', async () => {
    const tools = path.join(bench.root, 'no-installs');
    fs.mkdirSync(tools);
    const m = bare('nowhere', tools, { env: { DN_TRANSPORT_RETRY_MS: '100', DN_TRANSPORT_RETRY_MAX_MS: '400' } });
    await m.start();
    const state = await until('the snapshot to say what is missing', async () => {
      const now = await m.state();
      return now.transport.state === 'failed' && now.docker.state === 'missing' ? now : null;
    });
    assert.equal(state.transport.detail, 'cannot run tor: it is not installed where this machine\'s tools are looked for (DN_TOR names it by hand)');
    assert.equal(state.docker.detail, 'docker not found: every job runs in a container');
    const looked = [...new Set([...SYSTEM_PATH.split(':'), tools, path.dirname(process.execPath)])].join(':');
    for (const tool of ['tor', 'docker', 'gh', 'glab', 'claude']) assert.ok(m.log().includes(`] ${tool} is in none of ${looked}\n`), `${tool}: ${m.log()}`);

    fs.symlinkSync(path.join(HERE, 'lib', 'fake-tor.mjs'), path.join(tools, 'tor'));
    fs.symlinkSync(path.join(HERE, 'lib', 'fake-docker.mjs'), path.join(tools, 'docker'));
    await until('both found', async () => { const now = await m.state(); return now.transport.state === 'ready' && now.docker.state === 'ready'; });
    await until('the log to say where', () => ['tor', 'docker'].every((tool) => m.log().includes(`] ${tool} is ${path.join(tools, tool)}\n`)));
    assert.equal(m.log().split('] gh is in none of').length - 1, 1, 'what has not changed is said once');
    await m.kill();
  });

  await bareCheck('the installer removes a switched-off machine\'s containers with a docker that is only where a user\'s installs are', async () => {
    const tools = path.join(bench.root, 'installs');
    fs.mkdirSync(tools);
    fs.symlinkSync(path.join(HERE, 'lib', 'fake-docker.mjs'), path.join(tools, 'docker'));
    const m = bare('swept', tools, { transport: 'loop' });
    await m.start();
    await m.linked();
    const { taskId } = await m.ok('/offer', { pool: POOL, kind: 'review', item: 'pr-1', title: 'Review', now: true, prompt: 'wait never\nsay never' });
    await until('its job to run', async () => (await m.state()).runs.some((run) => run.taskId === taskId && m.agent(run.runId)?.waiting === 'never'));
    assert.equal(m.containers().length > 0, true);
    await m.kill();
    m.setConfig({ networkEnabled: false });
    assert.deepEqual(await m.install('--stop-daemon'), { ok: true, daemonRunning: false, pid: null, ended: { offers: 1, runs: 1 } });
    assert.deepEqual(m.containers(), []);
  });

  // What keeps a daemon from being built behind its socket, and what its reason reads like.
  const UNSTARTABLE = [
    ['daemon.json cannot be written', (m) => fs.mkdirSync(path.join(m.base, 'daemon.json', 'in the way'), { recursive: true }), /daemon\.json/],
    ['a document of the store cannot be read', (m) => fs.mkdirSync(path.join(m.base, 'identity.json'), { recursive: true }), /EISDIR/],
    ['DN_TRANSPORT names no transport', (m) => { m.env.DN_TRANSPORT = 'pigeon'; }, /unknown transport kind: pigeon/],
  ];
  for (const [i, [what, prepare, reason]] of UNSTARTABLE.entries()) {
    await check(`a start that cannot be finished ends the daemon with a failure, leaves no socket to answer for it, and says why: ${what}`, async () => {
      const m = bench.machine(`un${i}`);
      prepare(m);
      await assert.rejects(m.start(), /exited/);
      assert.deepEqual(await m.exit, { code: 1, signal: null });
      assert.match(m.log(), new RegExp(`\\] the daemon could not start: .*${reason.source}`));
      assert.deepEqual([fs.existsSync(m.socket), fs.statSync(path.join(m.base, 'daemon.json'), { throwIfNoEntry: false })?.isFile() ?? false], [false, false]);
      assert.deepEqual(await m.install('--check'), { installed: true, daemonRunning: false, pid: null });
      // As an applet starts it: the reason is in the answer, which is not waited for as
      // that of a daemon slow to come up is.
      const from = Date.now();
      const answer = await m.install('--start-daemon');
      assert.ok(Date.now() - from < 45000, `answered after ${Date.now() - from} ms`);
      assert.deepEqual([answer.ok, answer.daemonRunning, answer.pid], [false, false, null]);
      assert.match(answer.error, new RegExp(`^diplomacy-network daemon failed to start \\(exit 1\\): the daemon could not start: .*${reason.source}`));
    });
  }

  await check('a daemon that is slow to answer is the daemon that was started: the installer waits for it, and says that it runs', async () => {
    const m = bench.machine('slow');
    fs.mkdirSync(m.base, { recursive: true });
    // Something listens where the daemon will and answers nothing. The daemon asks it
    // three times, 3 s each, before it takes the socket: longer than a start is given.
    const silent = net.createServer(() => {}).listen(m.socket);
    await once(silent, 'listening');
    const answer = await m.install('--start-daemon');
    try {
      assert.deepEqual([answer.ok, answer.daemonRunning, answer.error], [true, true, undefined]);
      assert.equal(JSON.parse(fs.readFileSync(path.join(m.base, 'daemon.json'), 'utf8')).pid, answer.pid);
    } finally {
      // The daemon first: closing a server removes the socket's file, whoever has it by now.
      if (answer.pid) {
        process.kill(answer.pid, 'SIGKILL');
        await until('the daemon gone', () => { try { process.kill(answer.pid, 0); return false; } catch { return true; } });
      }
      silent.close();
    }
  });

  await check('a start asked for with the network switched off is answered at once that it is, and so is a restart, which stops the daemon first: no daemon is started; a config that cannot be read is not the network off', async () => {
    const m = bench.machine('offstart', { env: { DN_CONFIG_POLL_MS: '3600000' } });
    const off = { ok: false, daemonRunning: false, pid: null, error: 'the network is switched off in Diplomat\'s settings: no daemon was started' };
    const good = fs.readFileSync(m.configPath, 'utf8');
    m.setConfig({ networkEnabled: false });
    const from = Date.now();
    assert.deepEqual([await m.install('--start-daemon'), await m.install('--restart-daemon'), fs.existsSync(m.base)], [off, off, false]);
    assert.ok(Date.now() - from < 45000, `answered after ${Date.now() - from} ms`);

    // Half a file, as a start finds it in the middle of a rewrite: that says nothing.
    fs.writeFileSync(m.configPath, good.slice(0, 20));
    const started = await m.install('--start-daemon');
    try {
      assert.deepEqual([started.ok, started.daemonRunning, started.error], [true, true, undefined]);
      // The daemon reads the setting as it starts and not again: the restart finds it off.
      fs.writeFileSync(m.configPath, good);
      m.setConfig({ networkEnabled: 0 });
      assert.deepEqual(await m.install('--restart-daemon'), off);
    } finally {
      if (started.pid) { try { process.kill(started.pid, 'SIGKILL'); } catch {} }
    }
  });

  await check('a links.json that holds no list of pools is one Diplomat has yet to post: the daemon starts with no pool linked', async () => {
    const m = bench.machine('nolist');
    fs.mkdirSync(m.base, { recursive: true });
    fs.writeFileSync(path.join(m.base, 'links.json'), '{"pools":5}\n');
    await m.start();
    assert.deepEqual((await m.state()).pools, []);
    await m.linked();
    assert.deepEqual((await m.state()).pools.map((pool) => pool.id), [POOL]);
    await m.kill();
  });

  await check('a daemon says at its start, and lists in its snapshot, what it was given that only a test sets - a figure of the protocol off its default among them, and no setting of the machine\'s own; it says which tools were named to it by hand and which setting asked for no bound where one always holds, and shows a loop transport as one; given none, it says nothing', async () => {
    const m = bench.machine('knobs', { env: {
      DN_CONTAINER_PIDS: '0', DN_JOB_IDLE_MS: '0', DN_CONTAINER_MEMORY: '0', DN_CONTAINER_CPUS: '0',
      // Figures the protocol fixes: two off their defaults, one at its default, one that is no number.
      DN_LEASE_SECS: '60', DN_ADMIT_TTL_MS: '99999999999', DN_GRANT_TTL_SECS: '120', DN_LEASE_GRACE_SECS: 'none',
    } });
    m.env.DN_TEST_FAULTS = path.join(m.home, 'faults');
    await m.start();
    const unbounded = (text) => text.split('\n').filter((line) => line.includes('would leave no bound')).map((line) => line.replace(/^\[[^\]]+\] /, ''));
    assert.deepEqual(unbounded(m.log()).sort(), ['DN_CONTAINER_CPUS', 'DN_CONTAINER_MEMORY', 'DN_CONTAINER_PIDS', 'DN_JOB_IDLE_MS'].map((name) => `${name}=0 would leave no bound where one always holds: the default is used`));
    const said = (text) => text.split('\n').filter((line) => line.includes('which only a test does')).map((line) => line.replace(/^\[[^\]]+\] /, ''));
    const knob = (name) => `${name}=${m.env[name]} is set, which only a test does: this daemon is not one to run on the network`;
    // What the bench gives every machine to be quick, and what this one was given: of the
    // settings of this machine's own (DN_CONFIG_POLL_MS, DN_RECONCILE_MS, ...) none.
    const tests = [
      'DN_ADMIT_TTL_MS', 'DN_FORGE_ORIGINS', 'DN_LEASE_SECS', 'DN_PEER_BACKOFF_MAX_MS', 'DN_PEER_BACKOFF_MS', 'DN_POW_MEMBER_BASE', 'DN_POW_STRANGER_BASE',
      'DN_PROBE_TIMEOUT_MS', 'DN_RANK_DELAY_MS', 'DN_REQUEST_TIMEOUT_MS', 'DN_RETRY_MS', 'DN_ROUND_TIMEOUT_MS', 'DN_SWITCH_OFF_WAIT_MS', 'DN_SYNC_INTERVAL_MS',
      'DN_TEST_FAULTS', 'DN_TICK_MS', 'DN_TRANSPORT',
    ];
    assert.deepEqual(said(m.log()), tests.map(knob));
    const named = ['docker', 'git', 'gh', 'glab', ...(process.platform === 'darwin' ? ['security'] : [])];
    const tools = m.log().split('\n').filter((line) => /\] (docker|gh|glab|git|security) is /.test(line)).map((line) => line.replace(/^\[[^\]]+\] /, '').replace(/^git is \S+$/, 'git is found'));
    assert.deepEqual(tools, named.map((tool) => (tool === 'git' ? 'git is found' : `${tool} is ${m.env[`DN_${tool.toUpperCase()}`]}, which DN_${tool.toUpperCase()} names`)));
    const { transport, daemon } = await until('its transport', async () => { const now = await m.state(); return now.transport.state === 'ready' ? now : null; });
    assert.match(transport.detail, /^loop \(test transport\): 127\.0\.0\.1:\d+$/);
    assert.deepEqual(daemon.testSettings, tests.map((name) => `${name}=${m.env[name]}`));
    await m.kill();

    // As Diplomat starts it: over Tor, with the forge and the proof of work as they are.
    const plain = bench.machine('plain', { transport: 'tor', timing: 'default' });
    delete plain.env.DN_FORGE_ORIGINS;
    await plain.start();
    const { transport: tor, daemon: asRun } = await until('its transport', async () => { const now = await plain.state(); return now.transport.state === 'ready' ? now : null; });
    assert.doesNotMatch(tor.detail, /test/);
    assert.deepEqual([said(plain.log()), unbounded(plain.log()), asRun.testSettings], [[], [], []]);
    await plain.kill();
  });

  await check('what a writer that died left half-written beside daemon.json, state.json and jobs.json is removed at the start; a living writer\'s is not', async () => {
    const m = bench.machine('tmp');
    fs.mkdirSync(m.base, { recursive: true });
    // No process has this pid: it is above what either system deals.
    const dead = 2 ** 22 + 7;
    const left = ['daemon.json', 'state.json', 'jobs.json'].map((name) => `${name}.tmp.${dead}`);
    const held = `state.json.tmp.${process.pid}`;
    for (const name of [...left, held]) fs.writeFileSync(path.join(m.base, name), '{');
    await m.start();
    assert.deepEqual([...left, held].filter((name) => fs.existsSync(path.join(m.base, name))), [held]);
    await m.kill();
  });

  console.log(`\nall ${passed()} checks passed`);
} finally {
  await bench.close();
}
process.exit(0);
