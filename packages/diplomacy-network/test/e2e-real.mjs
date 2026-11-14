// Two whole daemons and one job against the real things: each daemon with a tor of its
// own, reaching the other through its onion service; the real docker engine and the real
// image; the real agent on this machine's model credential. The forge stays a stand-in on
// this host, and every forge credential is a made-up one.
//
// Run: DN_TEST_TOR=real DN_TEST_DOCKER=real node test/e2e-real.mjs
//   DN_TEST_TOR=real alone      real tor, the stand-in docker and agent
//   DN_TEST_DOCKER=real alone   real docker and the real agent, the loop transport
//   DN_TEST_SKIP_CLAUDE=1       no model credential is used: the agent starts and fails
//   DN_TEST_TOR_SEED=<dir>      keeps tor's cached network directory between runs
//   DN_TEST_KEEP_IMAGE=1        leaves the test image behind for the next run
// With either real part, a job also lists the host's adb server through its forward,
// where the machine has adb: the version and the devices are all that is asked of it,
// and a server started for the check is stopped again.
// Everything it creates in docker carries a dn.base label of this run and is removed.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { POOL, check, createBench, passed, sleep, until } from './lib/daemons.mjs';

const TOR = process.env.DN_TEST_TOR === 'real';
const DOCKER = process.env.DN_TEST_DOCKER === 'real';
if (!TOR && !DOCKER) {
  console.log('SKIP the real end-to-end run: set DN_TEST_TOR=real, DN_TEST_DOCKER=real, or both');
  process.exit(0);
}
const SEED = TOR && process.env.DN_TEST_TOR_SEED;
const MINUTES = 60 * 1000;

const docker = (...args) => new Promise((resolve) => {
  execFile('docker', args, { encoding: 'utf8', timeout: 2 * MINUTES }, (err, stdout, stderr) => resolve({ code: err ? err.code ?? 1 : 0, out: stdout.trim(), err: stderr.trim() }));
});
const mine = (m) => ['--filter', `label=dn.base=${m.base}`];
const secs = (ms) => `${(ms / 1000).toFixed(1)} s`;
const offerOf = async (m, taskId) => (await m.state()).offers.find((o) => o.taskId === taskId);
const runOf = async (m, taskId) => (await m.state()).runs.filter((r) => r.taskId === taskId).at(-1) ?? null;

// Whether the real agent can be run: only with real docker, and only where this machine
// has a model credential.
async function modelHere(scratch) {
  if (!DOCKER) return false;
  if (process.env.DN_TEST_SKIP_CLAUDE) {
    console.log('SKIP the real agent run: DN_TEST_SKIP_CLAUDE is set');
    return false;
  }
  Object.assign(process.env, { DN_BASE_DIR: path.join(scratch, 'probe'), DIPLOMAT_CONFIG: path.join(scratch, 'probe.json'), DN_MODEL_TOKEN_PATH: path.join(scratch, 'probe-token') });
  const { createLLM } = await import('../src/executor/llm.js');
  const llm = createLLM();
  await llm.load();
  if (llm.state().state === 'ready') return true;
  console.log(`SKIP the real agent run: no model credential on this machine (${llm.state().detail})`);
  return false;
}

// tor's cached copy of the network directory: one that finds another's is up in seconds.
function seed(from, to) {
  if (!fs.existsSync(from)) return;
  fs.mkdirSync(to, { recursive: true, mode: 0o700 });
  for (const name of fs.readdirSync(from)) {
    if (name.startsWith('cached-')) fs.copyFileSync(path.join(from, name), path.join(to, name));
  }
}

// Removes what the daemons of a bench left in docker, by their own label.
async function sweep(machines) {
  for (const m of machines) {
    for (const id of (await docker('ps', '-a', '-q', ...mine(m))).out.split('\n').filter(Boolean)) await docker('rm', '-f', id);
    for (const v of (await docker('volume', 'ls', '-q', ...mine(m))).out.split('\n').filter(Boolean)) await docker('volume', 'rm', '-f', v);
    for (const n of (await docker('network', 'ls', '-q', ...mine(m))).out.split('\n').filter(Boolean)) await docker('network', 'rm', n);
  }
}

// One job from A, run by B. `model` says whether the agent can finish it.
async function oneJob({ model }) {
  const bench = await createBench();
  const transport = TOR ? 'real-tor' : 'loop';
  const kind = DOCKER ? 'real' : 'fake';
  // Over tor the network runs on its own constants; nothing is shortened.
  const timing = TOR ? 'default' : 'fast';
  const a = bench.machine('a', { transport, docker: kind, timing });
  const b = bench.machine('b', { transport, docker: kind, timing, model: model ? 'real' : 'fake' });
  const took = {};
  const timed = async (what, fn) => { const from = Date.now(); const got = await fn(); took[what] = Date.now() - from; return got; };
  const ready = (m) => until(`${m.name}'s transport`, async () => {
    const { transport: t } = await m.state();
    assert.notEqual(t.state, 'failed', `${m.name}: ${t.detail}`);
    return t.state === 'ready';
  }, 20 * MINUTES);
  let image = '';

  try {
    if (SEED) seed(SEED, path.join(a.base, 'tor'));
    await a.start();
    await timed('A reachable', () => ready(a));
    if (TOR) seed(path.join(a.base, 'tor'), path.join(b.base, 'tor'));
    await b.start();
    await timed('B reachable', () => ready(b));
    await Promise.all([a.linked(), b.linked()]);
    const pk = { a: (await a.state()).identity.pk, b: (await b.state()).identity.pk };
    if (TOR) {
      for (const m of [a, b]) assert.match((await m.state()).identity.onion, /^[a-z2-7]{56}\.onion$/);
      assert.equal(execFileSync('pgrep', ['-f', `tor -f ${bench.root}`], { encoding: 'utf8' }).trim().split('\n').length, 2, 'a tor of its own for each daemon');
    }

    // B joins by A's invite: its first request to A's onion service.
    const { invite } = await a.ok('/invite', { pool: POOL });
    await timed('B joined', () => until('B to join', async () => (await b.call('POST', '/join', { invite }, { timeout: 10 * MINUTES })).status === 200, 20 * MINUTES));
    await timed('two members on both', () => until('two members on both', async () => (await a.state()).pools[0].members.length === 2 && (await b.state()).pools[0].members.length === 2, 20 * MINUTES));

    await timed('B able to take work', () => until('B\'s docker and model', async () => {
      const s = await b.state();
      assert.ok(!['missing', 'failed'].includes(s.docker.state), `docker: ${s.docker.detail}`);
      return s.docker.state === 'ready' && s.model.state === 'ready';
    }, 40 * MINUTES));
    image = (await b.state()).docker.image;
    await b.admit(1);

    const before = bench.forge.log.length;
    const prompt = DOCKER
      ? [
        'Run exactly these three shell commands, in this order, each once, and nothing else:',
        '1. gh api repos/acme/widgets/pulls/1 --jq .user.login',
        '2. gh api -X POST repos/acme/widgets/pulls/1/reviews -f event=COMMENT -f body=pong',
        '3. gh api -X DELETE repos/acme/widgets',
        'The third is refused; do not try it again. Then reply with exactly: pong',
      ].join('\n')
      : ['api GET /repos/acme/widgets/pulls/1', 'api POST /repos/acme/widgets/pulls/1/reviews {"event":"COMMENT","body":"pong"}', 'api DELETE /repos/acme/widgets', 'say pong'].join('\n');
    const offered = Date.now();
    const { taskId } = await a.ok('/offer', { pool: POOL, kind: 'review', item: 'pr-1', title: 'Review the pull request', prompt });
    assert.equal((await offerOf(a, taskId)).state, 'pooled');
    // On record from the moment B's claim holds; its job starts once B has the key.
    const run = await until('B to run it', async () => {
      const r = await runOf(b, taskId);
      return r && r.state !== 'preparing' ? r : null;
    }, 30 * MINUTES);
    took['offered to started on B'] = Date.now() - offered;
    await until('A to see the claim', async () => (await offerOf(a, taskId)).attempt > 1 || ['claimed', 'done'].includes((await offerOf(a, taskId)).state), 10 * MINUTES);
    assert.deepEqual([run.peer, run.pool], [pk.a, POOL]);

    if (DOCKER) {
      // The container the job is in: this requester's, on a network that leads nowhere
      // but its relay.
      const [box] = JSON.parse((await docker('inspect', run.container)).out);
      assert.deepEqual([box.Config.Labels['dn.base'], box.Config.Labels['dn.peer'], box.Config.Labels['dn.pool']], [b.base, pk.a, POOL]);
      assert.deepEqual([box.HostConfig.NetworkMode, box.HostConfig.Privileged, box.HostConfig.CapDrop, box.HostConfig.SecurityOpt], [run.container, false, ['ALL'], ['no-new-privileges']]);
      assert.deepEqual(box.HostConfig.PortBindings ?? {}, {});
      const [network] = JSON.parse((await docker('network', 'inspect', run.container)).out);
      assert.equal(network.Internal, true);
      assert.deepEqual((await docker('ps', '-a', '--format', '{{.Names}}', ...mine(b))).out.split('\n').sort(), [run.container, `${run.container}-relay`]);
      assert.equal((await docker('ps', '-a', '-q', ...mine(a))).out, '', 'A runs nothing');
      const env = fs.readFileSync(path.join(b.base, 'runs', run.runId, 'env.sh'), 'utf8');
      assert.ok(!env.includes(a.token) && !env.includes(b.token) && !/sk-ant-/.test(env), 'no credential is in the job\'s environment');
    }

    const api = () => bench.forge.log.slice(before).filter((r) => r.host === 'api.github.com' && r.headers.authorization);
    const as = (m) => (r) => r.headers.authorization === `Bearer ${m.token}`;
    if (DOCKER && !model) {
      // The agent starts - the clone from B's mirror is behind it - and the provider
      // refuses the key that is no key: the attempt fails and says so.
      const failed = await timed('started to failed', () => until('the attempt to fail', async () => {
        const offer = await offerOf(a, taskId);
        return offer.attempt === 2 && offer.state === 'pooled' ? offer : null;
      }, 30 * MINUTES));
      assert.ok(failed.reason.length > 0, 'with a reason');
      const ended = await until('B\'s run over', async () => { const r = await runOf(b, taskId); return r.endedAt > 0 ? r : null; });
      assert.equal(ended.state, 'failed');
      assert.ok(fs.statSync(ended.log).size > 0, 'the agent ran');
      assert.equal(api().length, 0, 'nothing reached the forge');
      assert.deepEqual(await a.ok('/withdraw', { taskId }), { ok: true, ended: true });
      console.log(`INFO without a model credential the attempt failed with: ${JSON.stringify(failed.reason)}`);
    } else {
      const done = await timed('started to done', () => until('the offer to end', async () => {
        const offer = await offerOf(a, taskId);
        assert.equal(offer.attempt, 1, `the attempt failed: ${offer.reason}`);
        return offer.state === 'done' ? offer : null;
      }, 30 * MINUTES));
      assert.equal(done.outcome.ok, true, JSON.stringify(done.outcome));
      assert.match(done.outcome.summary, /pong/i);
      if (DOCKER) {
        assert.ok(done.outcome.usd > 0 && done.outcome.tokens > 0, 'a cost');
        assert.match(done.outcome.model, /^claude-/);
        assert.ok(done.requests >= 3 && done.refused >= 1, `requests ${done.requests}, refused ${done.refused}`);
      } else {
        assert.deepEqual([done.requests, done.refused, done.outcome.usd], [3, 1, 0.42]);
        assert.deepEqual(b.agent(run.runId).steps.map((s) => s.status ?? null), [200, 201, 403, null]);
      }
      await until('B\'s slot free', async () => (await runOf(b, taskId)).endedAt > 0, 10 * MINUTES);
      assert.equal((await runOf(b, taskId)).state, 'finished');
      await until('done on B', async () => (await b.state()).pools[0].tasks.find((t) => t.taskId === taskId).state === 'done', 10 * MINUTES);

      // Everything the task asked of the forge left A, with A's credential.
      const seen = api();
      assert.ok(seen.every(as(a)), 'no request to the forge\'s API carried anything but A\'s credential');
      const posts = seen.filter((r) => r.method === 'POST');
      assert.deepEqual(posts.map((r) => [r.path, JSON.parse(r.body)]), [['/repos/acme/widgets/pulls/1/reviews', { event: 'COMMENT', body: 'pong' }]]);
      assert.ok(seen.some((r) => r.method === 'GET' && r.path === '/repos/acme/widgets/pulls/1'));
      assert.ok(!seen.some((r) => r.method === 'DELETE'), 'the forbidden request never left');
      console.log(`INFO the agent answered ${JSON.stringify(done.outcome.summary)}: model ${JSON.stringify(done.outcome.model)}, ${done.outcome.tokens} tokens, $${done.outcome.usd}, ${done.requests} requests under the key, ${done.refused} refused`);
    }
    // The clone came from B's mirror, which B fetched as itself.
    assert.ok(bench.forge.log.slice(before).concat(bench.forge.log.slice(0, before)).some((r) => r.host === 'github.com' && r.path.endsWith('git-upload-pack') && r.headers.authorization && !as(a)(r)));
    assert.match(b.log(), /mirror created .* from github\.com\/acme\/widgets/);

    for (const m of [a, b]) assert.deepEqual(await m.stop(), { code: 0, signal: null }, `${m.name} stops cleanly`);
    if (TOR) {
      await until('both tors gone', () => { try { execFileSync('pgrep', ['-f', `tor -f ${bench.root}`]); return false; } catch { return true; } });
      if (SEED) seed(path.join(a.base, 'tor'), SEED);
    }
    console.log(`INFO timings: ${Object.entries(took).map(([what, ms]) => `${what} ${secs(ms)}`).join(', ')}`);
  } finally {
    await Promise.all([a.kill(), b.kill()]);
    if (DOCKER) await sweep([a, b]);
    await bench.close();
    if (DOCKER && image && !process.env.DN_TEST_KEEP_IMAGE) await docker('image', 'rm', image);
  }
}

// Asks the adb server on this host what it is, in adb's own framing.
const adbAnswers = () => new Promise((resolve) => {
  const socket = net.connect(5037, '127.0.0.1');
  let said = '';
  socket.setTimeout(3000, () => socket.destroy());
  socket.on('connect', () => socket.write('000chost:version'));
  socket.on('data', (c) => { said += c; });
  socket.on('error', () => {});
  socket.on('close', () => resolve(said.startsWith('OKAY')));
});

// The host's own adb server, listed by a job through the forward the daemon opens for
// it. The job is the stand-in agent, which asks for the version and the devices and
// nothing else; no device is touched.
async function realAdb() {
  let found = true;
  try { execFileSync('adb', ['version'], { stdio: 'ignore' }); } catch { found = false; }
  if (!found) return console.log('SKIP the real adb server: no adb on this machine');
  const started = !(await adbAnswers());
  if (started) execFileSync('adb', ['start-server'], { stdio: 'ignore' });
  const bench = await createBench();
  try {
    const m = await bench.machine('adb', { env: { DN_ADB_SERVER: '127.0.0.1:5037' } }).start();
    await m.linked();
    const { taskId } = await m.ok('/offer', { pool: POOL, kind: 'review', item: 'pr-1', title: 'List devices', prompt: 'adb\nsay listed', now: true });
    await until('the job done', async () => (await offerOf(m, taskId)).state === 'done');
    const agent = m.agent((await runOf(m, taskId)).runId);
    const step = agent.steps.find((s) => s.verb === 'adb');
    assert.match(agent.env.ADB_SERVER_SOCKET, /^tcp:127\.0\.0\.1:\d+$/);
    assert.notEqual(agent.env.ADB_SERVER_SOCKET, 'tcp:127.0.0.1:5037', 'through a listener of its own, not the host\'s port');
    assert.match(step.version, /^OKAY0004[0-9a-f]{4}$/);
    assert.match(step.devices, /^OKAY[0-9a-f]{4}/);
    // What `adb devices` on the host lists, serial for serial.
    const listed = (text) => text.split('\n').map((l) => l.split('\t')[0].trim()).filter(Boolean).sort();
    const host = listed(execFileSync('adb', ['devices'], { encoding: 'utf8' }).replace(/^List of devices attached\s*/, ''));
    assert.deepEqual(listed(step.devices.slice(8)), host);
    console.log(`INFO the job listed ${host.length} device(s) through its forward, as adb devices does on the host`);
    await m.kill();
  } finally {
    await bench.close();
    if (started) execFileSync('adb', ['kill-server'], { stdio: 'ignore' });
  }
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'dn-probe-'));
try {
  const model = await modelHere(scratch);
  const what = [TOR ? 'real tor' : 'the loop transport', DOCKER ? 'real docker' : 'the stand-in docker', model ? 'the real agent' : DOCKER ? 'an agent without a model' : 'the stand-in agent'].join(', ');
  await check(`a task offered on one daemon is run by another and reported back: ${what}`, async () => {
    // tor's first circuits to a new onion service sometimes never come up: a second go
    // starts from fresh ones.
    for (let attempt = 1; ; attempt += 1) {
      try { return await oneJob({ model }); } catch (err) {
        if (!TOR || attempt === 2) throw err;
        console.log(`INFO attempt ${attempt} failed; trying once more. It said:\n${err?.stack ?? err}`);
        await sleep(1000);
      }
    }
  });
  await check('a job lists the devices of the host\'s own adb server through its forward', realAdb);
  console.log(`\nall ${passed()} checks passed`);
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
process.exit(0);
