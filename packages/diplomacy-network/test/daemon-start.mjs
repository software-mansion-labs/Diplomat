// How the daemon comes up: with the tools it runs found where a user's installs are when
// the process that started it was given the system's directories alone, and with a start
// that cannot be finished ended, not left answering.
// Real daemon processes on scratch directories; stand-in tor, docker and forge.
// Run: node test/daemon-start.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { POOL, check, createBench, passed, until } from './lib/daemons.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const bench = await createBench();
// The PATH launchd gives an app, and with it everything the app starts.
const SYSTEM_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
const offerOf = async (m, taskId) => (await m.state()).offers.find((o) => o.taskId === taskId);

// A machine whose daemon is told where no tool is: it is given the system's PATH, and
// `dir` as the one directory a user's installs are in.
function bare(name, dir, options = {}) {
  const m = bench.machine(name, { transport: 'tor', ...options });
  Object.assign(m.env, { PATH: SYSTEM_PATH, DN_TOOL_DIRS: dir });
  for (const named of ['DN_TOR', 'DN_DOCKER', 'DN_GH', 'DN_GLAB', 'DN_SECURITY', 'DN_CLAUDE']) delete m.env[named];
  return m;
}

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

  await check('started with the PATH an app is given, the daemon finds tor, docker, gh and the rest where a user\'s installs are, and what they run finds its own helpers there', async () => {
    // Named from the home, and ahead of a directory whose gh is another one.
    const other = path.join(bench.root, 'more-installs');
    const m = bare('found', `~/installs:${other}`);
    const tools = path.join(m.home, 'installs');
    for (const dir of [tools, other]) fs.mkdirSync(dir);
    fs.writeFileSync(path.join(other, 'gh'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const install = (file, body) => fs.writeFileSync(path.join(tools, file), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    // tor and docker as node scripts, which run under `env node`: node is in none of
    // the system's directories either.
    assert.equal(SYSTEM_PATH.split(':').includes(path.dirname(process.execPath)), false, 'this test needs a node outside the system\'s directories');
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

  await check('a tool that is nowhere is named: tor and docker in the snapshot, each of them in the log, and found without a restart once it is installed', async () => {
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
    const looked = `${SYSTEM_PATH}:${tools}:${path.dirname(process.execPath)}`;
    for (const tool of ['tor', 'docker', 'gh', 'glab', 'claude']) assert.ok(m.log().includes(`] ${tool} is in none of ${looked}\n`), `${tool}: ${m.log()}`);

    fs.symlinkSync(path.join(HERE, 'lib', 'fake-tor.mjs'), path.join(tools, 'tor'));
    fs.symlinkSync(path.join(HERE, 'lib', 'fake-docker.mjs'), path.join(tools, 'docker'));
    await until('both found', async () => { const now = await m.state(); return now.transport.state === 'ready' && now.docker.state === 'ready'; });
    await until('the log to say where', () => ['tor', 'docker'].every((tool) => m.log().includes(`] ${tool} is ${path.join(tools, tool)}\n`)));
    assert.equal(m.log().split('] gh is in none of').length - 1, 1, 'what has not changed is said once');
    await m.kill();
  });

  await check('the installer removes a switched-off machine\'s containers with a docker that is only where a user\'s installs are', async () => {
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
    assert.deepEqual(await m.install('--stop-daemon'), { ok: true, daemonRunning: false, pid: null });
    assert.deepEqual(m.containers(), []);
  });

  console.log(`\nall ${passed()} checks passed`);
} finally {
  await bench.close();
}
process.exit(0);
