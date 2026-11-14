// The transport over tor: two hosts that reach each other through their onion services,
// and what the transport does with a tor that stalls, dies, lies or is left behind.
//
// Runs against test/lib/fake-tor.mjs. `DN_TEST_TOR=real` runs the end-to-end cases on the
// real `tor` binary and the Tor network instead (minutes, not seconds) and skips the
// cases only the stand-in can stage. `DN_TEST_TOR_SEED=<dir>` keeps tor's cached
// directory documents there between real runs, which saves the first host a cold
// bootstrap.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { onInterrupt } from '../../daemon-core/src/test-interrupt.js';
import { generateIdentity, onionAddress } from '../src/core/identity.js';

const REAL = process.env.DN_TEST_TOR === 'real';
const SEED = REAL && process.env.DN_TEST_TOR_SEED;
// Short: tor's paths and the control port file live under it.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dn-'));
const NET = path.join(tmp, 'net');
if (!REAL) {
  process.env.DN_TOR = fileURLToPath(new URL('./lib/fake-tor.mjs', import.meta.url));
  process.env.FAKE_TOR_NET = NET;
  fs.mkdirSync(NET);
}
// After the environment is set: paths.js reads DN_TOR when it loads.
const INDEX = new URL('../src/transport/index.js', import.meta.url).href;
const { createTransport } = await import(INDEX);

const MIB = 1 << 20;
const hosts = [];
const children = new Set();

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
};

function cleanup() {
  for (const child of children) child.kill('SIGKILL');
  for (const name of fs.readdirSync(tmp)) {
    try { process.kill(Number(fs.readFileSync(path.join(tmp, name, 'tor.pid'), 'utf8')), 'SIGKILL'); } catch {}
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}
onInterrupt(cleanup);

async function check(name, fn) {
  try {
    await fn();
  } catch (err) {
    console.error(`FAIL ${name}`);
    throw err;
  }
  console.log(`PASS ${name}`);
}

// A case only the stand-in can stage.
async function staged(name, fn) {
  if (REAL) console.log(`SKIP ${name} (staged by the stand-in tor only)`);
  else await check(name, fn);
}

async function timed(label, fn) {
  const from = performance.now();
  const value = await fn();
  console.log(`TIME ${label}: ${Math.round(performance.now() - from)} ms`);
  return value;
}

async function until(probe, ms, what) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) assert.fail(`${what} did not happen within ${ms} ms`);
    await sleep(10);
  }
}

// A mutated transport hangs where a correct one answers; a test must fail then, not wait.
function within(ms, promise, what) {
  let timer;
  const late = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} took over ${ms} ms`)), ms); });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

const code = (promise) => promise.then(() => 'resolved', (err) => err.code ?? `uncoded: ${err.message}`);

function host(name, { tune, identity = generateIdentity() } = {}) {
  const dir = path.join(tmp, name);
  const h = { name, identity, dir, logs: [], states: [] };
  const log = (line) => {
    h.logs.push(line);
    if (REAL) console.log(`  [${name}] ${line}`);
  };
  h.t = createTransport({ kind: 'tor', identity, dir, log, tune });
  h.t.onState((s) => h.states.push(s));
  h.t.onRequest(async (body) => body);
  h.torPid = () => Number(fs.readFileSync(path.join(dir, 'tor.pid'), 'utf8'));
  h.reached = (state) => h.states.some((s) => s.state === state);
  hosts.push(h);
  return h;
}

// Starts a host with the stand-in told to stage `stage`, and returns once tor is spawned
// (the stage is read then, and the host reports bootstrapping after). The start itself
// may never settle; its promise is `h.starting`.
async function begin(h, stage = '') {
  process.env.FAKE_TOR_STAGE = stage;
  h.starting = h.t.start();
  h.starting.catch(() => {});
  await until(() => h.reached('bootstrapping') || h.reached('failed'), 5000, 'the spawn of tor');
  delete process.env.FAKE_TOR_STAGE;
}

// A real tor with an empty data directory downloads the whole network directory first;
// one that finds another's cached copy is up in seconds.
function seed(from, to) {
  if (!fs.existsSync(from)) return;
  fs.mkdirSync(to, { recursive: true });
  for (const name of fs.readdirSync(from)) {
    if (name.startsWith('cached-')) fs.copyFileSync(path.join(from, name), path.join(to, name));
  }
}

async function started(name, { stage, tune, seedFrom } = {}) {
  const h = host(name, { tune });
  if (REAL) seed(seedFrom.dir, h.dir);
  await begin(h, stage);
  await within(REAL ? 180000 : 10000, h.starting, `the start of ${name}`);
  return h;
}

// A request that is repeated until the peer answers. Over the real network a service
// published a moment ago is unreachable at first, and each failure must be one of the
// two answers the node is told to expect.
async function reach(from, to, body, budgetMs) {
  const deadline = Date.now() + budgetMs;
  for (let attempt = 1; ; attempt++) {
    const began = Date.now();
    try {
      const answer = await from.t.request(to.identity.pk, body);
      if (REAL) console.log(`  attempt ${attempt}: answered after ${Date.now() - began} ms`);
      return answer;
    } catch (err) {
      if (REAL) console.log(`  attempt ${attempt}: ${err.message} after ${Date.now() - began} ms`);
      assert.ok(['unreachable', 'timeout'].includes(err.code), `an unexpected failure: ${err.stack}`);
      if (Date.now() > deadline) assert.fail(`${to.name} was not reached within ${budgetMs} ms`);
      await sleep(REAL ? 5000 : 10);
    }
  }
}

// A separate process that starts a transport on `dir` and then idles, as a daemon would:
// what it prints first is "started" or "failed <why>".
const DAEMON = `
  import { createTransport } from ${JSON.stringify(INDEX)};
  import { generateIdentity } from ${JSON.stringify(new URL('../src/core/identity.js', import.meta.url).href)};
  const t = createTransport({ kind: 'tor', identity: generateIdentity(), dir: process.env.DN_CHILD_DIR });
  try {
    await t.start();
    console.log('started');
    setInterval(() => {}, 1000);
  } catch (err) {
    console.log('failed ' + err.message);
  }
`;
function daemon(dir, env = {}) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', DAEMON], {
    env: { ...process.env, ...env, DN_CHILD_DIR: dir },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  children.add(child);
  child.once('exit', () => children.delete(child));
  let out = '';
  child.stdout.on('data', (chunk) => { out += chunk; });
  child.said = () => until(() => out.split('\n')[1] !== undefined && out.split('\n')[0], REAL ? 180000 : 10000, 'the daemon reporting');
  return child;
}

try {
  let a;
  let b;
  const echoed = Buffer.from('{"through":"tor"}');

  await check('two hosts bootstrap tor and publish the onion derived from their keys', async () => {
    a = host('a');
    b = host('b');
    if (SEED) seed(SEED, a.dir);
    await timed('bootstrap of the first host', () => a.t.start());
    if (REAL) seed(a.dir, b.dir);
    await timed('bootstrap of the second host', () => b.t.start());
    for (const h of [a, b]) {
      assert.equal(h.t.address, onionAddress(h.identity.pk));
      assert.match(h.t.address, /^[a-z2-7]{56}\.onion$/);
      assert.deepEqual(h.states.map((s) => s.state).filter((s, i, all) => s !== all[i - 1]).slice(0, 3), ['starting', 'bootstrapping', 'publishing']);
      assert.ok(alive(h.torPid()));
    }
    await timed('publishing until both report ready', () => until(
      () => a.t.state().state === 'ready' && b.t.state().state === 'ready',
      REAL ? 150000 : 5000,
      'both hosts becoming ready',
    ));
    console.log(`  ready: ${a.t.state().detail} / ${b.t.state().detail}`);
    assert.equal(a.t.state().detail, 'descriptor uploaded');
  });

  await check('a first request reaches the peer through its onion', async () => {
    b.t.onRequest(async (body, info) => Buffer.from(JSON.stringify({ got: body.toString(), kind: info.headers['dn-kind'] ?? null })));
    const answer = await timed('first dial', () => reach(a, b, echoed, REAL ? 8 * 60000 : 5000));
    assert.deepEqual(JSON.parse(answer), { got: echoed.toString(), kind: null });
  });

  await check('the next request rides the connection the first one left open', async () => {
    const answer = await timed('second request', () => a.t.request(b.identity.pk, echoed, { headers: { 'dn-kind': 'ping' } }));
    assert.deepEqual(JSON.parse(answer), { got: echoed.toString(), kind: 'ping' });
    if (REAL) return;
    const dials = fs.readFileSync(path.join(NET, 'socks.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(dials, [{ user: b.t.address, host: b.t.address, port: 80 }]);
  });

  await check('a 5 MiB body makes the round trip when the peer allows it, and is refused unsent when not', async () => {
    const big = crypto.randomBytes(5 * MIB);
    b.t.onRequest(async (body) => body);
    b.t.limitFor((headers) => (headers['dn-kind'] === 'act' ? 8 * MIB : MIB));
    const options = { timeoutMs: 5 * 60000, maxResponseBytes: 8 * MIB };
    const back = await timed('5 MiB round trip', () => a.t.request(b.identity.pk, big, { ...options, headers: { 'dn-kind': 'act' } }));
    assert.ok(back.equals(big));
    assert.equal(await timed('5 MiB refusal', () => code(a.t.request(b.identity.pk, big, options))), 'http-413');
    const over = { timeoutMs: 5 * 60000, headers: { 'dn-kind': 'act' } };
    assert.equal(await code(a.t.request(b.identity.pk, Buffer.alloc(MIB + 1), over)), 'too-large');
  });

  await check('the peer dials back through the first host\'s onion', async () => {
    a.t.onRequest(async (body) => Buffer.concat([Buffer.from('a:'), body]));
    const answer = await timed('first dial back', () => reach(b, a, echoed, REAL ? 8 * 60000 : 5000));
    assert.equal(answer.toString(), `a:${echoed}`);
  });

  await check('an onion nobody serves is unreachable, as an ordinary answer', async () => {
    const nobody = generateIdentity().pk;
    const failure = await timed('dial of an unpublished onion', () => a.t.request(nobody, echoed, { timeoutMs: 120000 }).catch((err) => err));
    if (REAL) console.log(`  ${failure.message}`);
    assert.ok(REAL ? ['unreachable', 'timeout'].includes(failure.code) : failure.code === 'unreachable', failure.stack);
    assert.equal((await a.t.request(b.identity.pk, echoed)).toString(), echoed.toString());
  });

  await check('tor exits with the daemon that owned it', async () => {
    const dir = path.join(tmp, 'owned');
    if (REAL) seed(a.dir, dir);
    const child = daemon(dir);
    assert.equal(await child.said(), 'started');
    const pid = Number(fs.readFileSync(path.join(dir, 'tor.pid'), 'utf8'));
    assert.ok(alive(pid));
    child.kill('SIGKILL');
    await timed('tor gone after its daemon was killed', () => until(() => !alive(pid), REAL ? 30000 : 3000, 'tor exiting'));
  });

  await check('stop ends tor, fails what was in flight and leaves the data directory to the next start', async () => {
    const pid = a.torPid();
    b.t.onRequest(() => new Promise(() => {}));
    const inFlight = code(a.t.request(b.identity.pk, echoed));
    await sleep(REAL ? 2000 : 50);
    await timed('stop', () => a.t.stop());
    assert.equal(alive(pid), false);
    assert.equal(await inFlight, 'stopped');
    assert.equal(await code(a.t.request(b.identity.pk, echoed)), 'stopped');
    assert.deepEqual(a.t.state(), { state: 'failed', detail: 'stopped' });
    for (const left of ['tor.pid', 'control.port']) assert.equal(fs.existsSync(path.join(a.dir, left)), false, left);
    await assert.rejects(a.t.start(), /starts once/);

    const again = host('a', { identity: a.identity });
    await timed('start on the same data directory', () => again.t.start());
    assert.notEqual(again.torPid(), pid);
    b.t.onRequest(async (body) => body);
    if (!REAL) {
      await until(() => again.t.state().state === 'ready', 5000, 'the restarted host becoming ready');
      assert.equal((await again.t.request(b.identity.pk, echoed)).toString(), echoed.toString());
    }
    const second = again.torPid();
    await again.t.stop();
    assert.equal(alive(second), false);
  });

  await check('a tor that dies is started again, and the host reaches and is reached as before', async () => {
    const budget = REAL ? 8 * 60000 : 5000;
    const h = await started('crash', { tune: { restartMinMs: 300 }, seedFrom: b });
    await until(() => h.t.state().state === 'ready', REAL ? 150000 : 5000, 'ready');
    assert.equal((await timed('first dial of a third host', () => reach(b, h, echoed, budget))).toString(), echoed.toString());
    const pid = h.torPid();
    h.states.length = 0;
    process.kill(pid, 'SIGKILL');
    await until(() => h.reached('failed'), 2000, 'the failure being noticed');
    assert.match(h.states[0].detail, /tor exited \(SIGKILL\)/);
    assert.equal(await code(h.t.request(b.identity.pk, echoed)), 'unreachable');
    await timed('a killed tor back to ready', () => until(() => h.t.state().state === 'ready', REAL ? 150000 : 5000, 'ready again'));
    assert.deepEqual(h.states.map((s) => s.state).filter((s, i, all) => s !== all[i - 1]), ['failed', 'starting', 'bootstrapping', 'publishing', 'ready']);
    assert.notEqual(h.torPid(), pid);
    assert.equal((await timed('first dial out after the restart', () => reach(h, b, echoed, budget))).toString(), echoed.toString());
    assert.equal((await timed('first dial in after the restart', () => reach(b, h, echoed, budget))).toString(), echoed.toString());
    await h.t.stop();
  });

  await staged('a bootstrap that stalls keeps reporting how far it got, and stop ends it', async () => {
    const h = host('stall');
    await begin(h, 'stall:45');
    await until(() => h.t.state().detail.endsWith('unreachable'), 5000, 'the stall being reported');
    await sleep(100);
    assert.deepEqual(h.t.state(), { state: 'bootstrapping', detail: '45% Asking for relay descriptors: Network is unreachable' });
    assert.equal(await code(h.t.request(b.identity.pk, echoed, { timeoutMs: 500 })), 'unreachable');
    const pid = h.torPid();
    await h.t.stop();
    assert.equal(await code(h.starting), 'stopped');
    assert.equal(alive(pid), false);
  });

  await staged('a tor that dies while bootstrapping fails the start at once, with its last words', async () => {
    const h = host('die');
    const began = Date.now();
    await begin(h, 'die:25');
    await assert.rejects(h.starting, /tor exited \(code 1\): The stand-in was told to die here\./);
    assert.ok(Date.now() - began < 3000);
    assert.equal(h.t.state().state, 'failed');
    assert.match(h.t.state().detail, /tor exited \(code 1\)/);
    assert.equal(fs.existsSync(path.join(h.dir, 'tor.pid')), false);
  });

  await staged('a tor that cannot be run fails the start', async () => {
    const child = daemon(path.join(tmp, 'nobin'), { DN_TOR: path.join(tmp, 'no-such-tor') });
    assert.match(await child.said(), /^failed cannot run .*no-such-tor: spawn .* ENOENT/);
    // Nothing of the failed start holds that process open.
    await until(() => child.exitCode !== null, 3000, 'the daemon exiting by itself');
  });

  await staged('a refused ADD_ONION fails the start and leaves no tor', async () => {
    const h = host('refused');
    await begin(h, 'reject-add-onion');
    await assert.rejects(h.starting, /tor refused ADD_ONION: 550 Onion address collision/);
    assert.equal(h.t.state().state, 'failed');
    assert.equal(fs.existsSync(path.join(h.dir, 'tor.pid')), false);
    assert.ok(!h.logs.join('\n').includes('ED25519-V3'), 'the secret key reached the log');
  });

  await staged('a service published under any address but the derived one fails the start', async () => {
    const h = host('wrongid');
    await begin(h, 'wrong-service-id');
    await assert.rejects(h.starting, /which is not this host's/);
    assert.equal(h.t.state().state, 'failed');
    assert.equal(h.reached('publishing'), false);
    assert.equal(fs.existsSync(path.join(h.dir, 'tor.pid')), false);
  });

  await staged('a host whose descriptor upload is never confirmed counts as ready after the grace, and dials to it are unreachable', async () => {
    const h = await started('nodesc', { stage: 'no-descriptor', tune: { publishGraceMs: 300 } });
    assert.equal(h.t.state().state, 'publishing');
    await sleep(150);
    assert.equal(h.t.state().state, 'publishing');
    await until(() => h.t.state().state === 'ready', 2000, 'ready after the grace');
    assert.match(h.t.state().detail, /no upload confirmed/);
    const failure = await b.t.request(h.identity.pk, echoed).catch((err) => err);
    assert.equal(failure.code, 'unreachable');
    assert.match(failure.message, /descriptor not found \(SOCKS reply 0xf0\)/);
  });

  await staged('an upload confirmed in the same breath as the service being added still makes the host ready', async () => {
    const h = await started('atonce', { stage: 'upload-at-once', tune: { publishGraceMs: 60000 } });
    assert.deepEqual(h.t.state(), { state: 'ready', detail: 'descriptor uploaded' });
    assert.ok(h.reached('publishing'));
    assert.equal((await b.t.request(h.identity.pk, echoed)).toString(), echoed.toString());
  });

  await staged('SOCKS failures are ordinary answers, and the dial after them can succeed', async () => {
    const h = await started('socks04', { stage: 'socks-04:2' });
    for (let i = 0; i < 2; i++) {
      const failure = await h.t.request(b.identity.pk, echoed).catch((err) => err);
      assert.equal(failure.code, 'unreachable');
      assert.match(failure.message, /host unreachable \(SOCKS reply 0x04\)/);
    }
    assert.equal((await h.t.request(b.identity.pk, echoed)).toString(), echoed.toString());
  });

  await staged('a connection tor reports made that closes before any byte is unreachable, not an answer', async () => {
    const h = await started('eof', { stage: 'socks-eof:1' });
    assert.equal(await within(5000, code(h.t.request(b.identity.pk, echoed)), 'the request'), 'unreachable');
    assert.equal((await h.t.request(b.identity.pk, echoed)).toString(), echoed.toString());
  });

  await staged('a dial tor never answers ends on the request\'s timeout and on the dial\'s own', async () => {
    const h = await started('stalled', { stage: 'socks-stall', tune: { dialTimeoutMs: 600 } });
    let began = Date.now();
    assert.equal(await within(5000, code(h.t.request(b.identity.pk, echoed, { timeoutMs: 250 })), 'the request'), 'timeout');
    assert.ok(Date.now() - began >= 240 && Date.now() - began < 550, `${Date.now() - began} ms`);
    began = Date.now();
    const failure = await within(5000, h.t.request(b.identity.pk, echoed, { timeoutMs: 30000 }), 'the dial').catch((err) => err);
    assert.equal(failure.code, 'timeout');
    assert.match(failure.message, /tor did not connect/);
    assert.ok(Date.now() - began < 1500, `${Date.now() - began} ms`);
  });

  await staged('a dial in flight when tor dies is unreachable', async () => {
    const h = await started('dying', { stage: 'socks-stall' });
    const pending = code(h.t.request(b.identity.pk, echoed));
    await sleep(100);
    process.kill(h.torPid(), 'SIGKILL');
    assert.equal(await within(3000, pending, 'the request'), 'unreachable');
  });

  await staged('a restart that fails leaves no tor behind and is tried again, later each time until one succeeds', async () => {
    const h = await started('relapse', { tune: { restartMinMs: 100, restartMaxMs: 400 } });
    let refusals = 0;
    h.t.onState(({ detail }) => { if (detail.includes('ADD_ONION')) refusals++; });
    process.env.FAKE_TOR_STAGE = 'reject-add-onion';
    try {
      process.kill(h.torPid(), 'SIGKILL');
      await until(() => refusals === 1, 5000, 'the restart failing');
      assert.equal(h.t.state().state, 'failed');
      assert.equal(fs.existsSync(path.join(h.dir, 'tor.pid')), false, 'the tor of the failed restart is still there');
      await until(() => refusals === 3, 5000, 'two more restarts failing');
    } finally {
      delete process.env.FAKE_TOR_STAGE;
    }
    // The waits were 100 and 200 ms; the one running is 400, and would be 800 uncapped.
    const failed = Date.now();
    await sleep(200);
    assert.equal(fs.existsSync(path.join(h.dir, 'tor.pid')), false, 'the fourth restart came as early as the first');
    await until(() => fs.existsSync(path.join(h.dir, 'tor.pid')), 3000, 'the fourth restart');
    assert.ok(Date.now() - failed < 650, `the fourth restart came after ${Date.now() - failed} ms`);
    await until(() => h.t.state().state === 'ready', 5000, 'the next restart succeeding');
    assert.equal((await h.t.request(b.identity.pk, echoed)).toString(), echoed.toString());

    // After a restart that succeeded the wait is the shortest again.
    const pid = h.torPid();
    const from = Date.now();
    process.kill(pid, 'SIGKILL');
    await until(() => fs.existsSync(path.join(h.dir, 'tor.pid')) && h.torPid() !== pid, 3000, 'tor being started again');
    assert.ok(Date.now() - from < 300, `the restart took ${Date.now() - from} ms`);
  });

  await staged('every peer is dialled under a SOCKS username of its own, on virtual port 80', async () => {
    const h = await started('isolate');
    const c = await started('isolate-peer');
    await until(() => c.t.state().state === 'ready', 5000, 'the peer becoming ready');
    fs.rmSync(path.join(NET, 'socks.log'));
    await h.t.request(b.identity.pk, echoed);
    await h.t.request(c.identity.pk, echoed);
    await within(5000, Promise.all(Array.from({ length: 12 }, () => h.t.request(b.identity.pk, echoed))), 'twelve requests at once');
    const dials = fs.readFileSync(path.join(NET, 'socks.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.ok(dials.length >= 2);
    for (const dial of dials) {
      assert.ok([b.t.address, c.t.address].includes(dial.host));
      assert.equal(dial.user, dial.host);
      assert.equal(dial.port, 80);
    }
  });

  await staged('a tor that ignores SIGTERM is killed after the grace', async () => {
    const h = await started('deaf', { stage: 'ignore-term', tune: { stopGraceMs: 300 } });
    const pid = h.torPid();
    const began = Date.now();
    await within(5000, h.t.stop(), 'stop');
    assert.equal(alive(pid), false);
    assert.ok(Date.now() - began >= 290, `${Date.now() - began} ms`);
  });

  for (const [stage, means] of [['ignore-owning-pid', 'the control connection it took ownership on'], ['ignore-takeownership', 'the owning pid in its torrc']]) {
    await staged(`tor is tied to its daemon through ${means}`, async () => {
      const dir = path.join(tmp, stage);
      const child = daemon(dir, { FAKE_TOR_STAGE: stage });
      assert.equal(await child.said(), 'started');
      const pid = Number(fs.readFileSync(path.join(dir, 'tor.pid'), 'utf8'));
      child.kill('SIGKILL');
      await until(() => !alive(pid), 3000, 'tor exiting');
    });
  }

  await staged('a start ends the tor a killed daemon left on the data directory', async () => {
    const dir = path.join(tmp, 'orphan');
    const child = daemon(dir, { FAKE_TOR_STAGE: 'ignore-owning-pid,ignore-takeownership' });
    assert.equal(await child.said(), 'started');
    const pid = Number(fs.readFileSync(path.join(dir, 'tor.pid'), 'utf8'));
    child.kill('SIGKILL');
    await sleep(500);
    assert.ok(alive(pid), 'the stand-in was meant to outlive its daemon');
    const h = await started('orphan');
    assert.equal(alive(pid), false);
    assert.notEqual(h.torPid(), pid);
    assert.match(h.logs.join('\n'), new RegExp(`ending the tor \\(pid ${pid}\\)`));
  });

  await staged('a start reads nothing a dead tor left behind and ends no process that is not its tor', async () => {
    const dir = path.join(tmp, 'stale');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'control.port'), 'PORT=127.0.0.1:1\n');
    fs.writeFileSync(path.join(dir, 'control_auth_cookie'), Buffer.alloc(32));
    fs.writeFileSync(path.join(dir, 'lock'), '999999');
    // A pid file naming a live process that is no tor of this directory: this test.
    fs.writeFileSync(path.join(dir, 'tor.pid'), String(process.pid));
    const h = await started('stale');
    assert.notEqual(h.torPid(), process.pid);
    assert.equal((await h.t.request(b.identity.pk, echoed)).toString(), echoed.toString());
  });

  await staged('a data directory created too open is closed to others before tor sees it', async () => {
    fs.mkdirSync(path.join(tmp, 'open'), { mode: 0o755 });
    fs.chmodSync(path.join(tmp, 'open'), 0o755);
    await started('open');
    assert.equal(fs.statSync(path.join(tmp, 'open')).mode & 0o777, 0o700);
  });

  await staged('a log line of any length neither stops tor\'s output being read nor reaches the log whole', async () => {
    const h = await started('longline', { stage: 'long-line' });
    await until(() => h.logs.some((l) => l.includes('the line after the long one')), 3000, 'the line after the long one');
    assert.ok(h.logs.some((l) => l.includes('xxxx')));
    assert.ok(h.logs.every((l) => l.length < 5000));
  });
} catch (err) {
  console.error(err);
  process.exitCode = 1;
} finally {
  if (SEED && hosts[0]) seed(hosts[0].dir, SEED);
  await Promise.all(hosts.map((h) => h.t.stop()));
  cleanup();
}

// Every transport is stopped: a timer, socket or child any of them left would keep this
// process alive, and the watchdog below says so instead of letting the run hang.
setTimeout(() => {
  console.error('FAIL something a stopped transport left keeps the event loop alive:', process.getActiveResourcesInfo());
  process.exit(1);
}, 5000).unref();
process.once('beforeExit', () => {
  if (!process.exitCode) console.log('PASS nothing a stopped transport left keeps the event loop alive');
});
