// Real daemon processes for the daemon's tests: each machine is a directory of its own
// under one scratch root - its state directory, Diplomat's config, a home, a git identity,
// a forge credential, a checkout of the pool's repository and a stand-in docker - and
// nothing a daemon is given leads to the operator's own. The machines share a loop
// directory (their network) and a stand-in forge.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { killDaemonsUnder, onInterrupt } from '../../../daemon-core/src/test-interrupt.js';
import { git, startFakeForge } from './fake-forge.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/// The daemon under test.
export const DAEMON = path.join(HERE, '..', '..', 'src', 'daemon.js');
/// The installer under test.
export const INSTALL = path.join(HERE, '..', '..', 'src', 'install.js');
const FAKE_DOCKER = path.join(HERE, 'fake-docker.mjs');
const FAKE_TOR = path.join(HERE, 'fake-tor.mjs');
const AGENT = path.join(HERE, 'agent.mjs');

/// The repository every machine links.
export const REPO = 'acme/widgets';
/// Its pool.
export const POOL = `github.com/${REPO}`;

/// A pause between two looks at something; never a wait for it.
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/// Waits until `fn` answers something truthy and returns it. The wait is long enough for
/// a machine with every core taken many times over; a test never sleeps a fixed time.
export async function until(what, fn, ms = 180000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(40)) {
    const got = await fn();
    if (got) return got;
  }
  return assert.fail(`never: ${what}`);
}

let checks = 0;
/// Runs one named check and prints how it went, like every other test file here.
export async function check(name, fn) {
  const from = Date.now();
  try {
    await fn();
  } catch (err) {
    console.log(`FAIL ${name}`);
    throw err;
  }
  checks += 1;
  console.log(`PASS ${name} (${((Date.now() - from) / 1000).toFixed(1)} s)`);
}
/// How many checks passed.
export const passed = () => checks;

/// A stand-in for the host's adb server: answers `host:version` and `host:devices` in
/// adb's framing, and keeps what it was asked. `{ port, asked, close() }`.
export async function fakeAdb() {
  const asked = [];
  const server = net.createServer((socket) => {
    socket.on('error', () => {});
    socket.once('data', (chunk) => {
      const service = chunk.toString('latin1').slice(4);
      asked.push(service);
      const payload = service === 'host:version' ? '0029' : service === 'host:devices' ? 'emulator-5554\tdevice\n' : null;
      socket.end(payload === null ? 'FAIL0007unknown' : `OKAY${payload.length.toString(16).padStart(4, '0')}${payload}`);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { port: server.address().port, asked, close: () => new Promise((resolve) => server.close(resolve)) };
}

/// The bench: `{ root, forge, loopDir, machine(name, options), close() }`.
export async function createBench() {
  // The real path: a real docker engine is given directories under it to mount.
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'dn-'));
  const forge = await startFakeForge();
  const loopDir = path.join(root, 'loop');
  // Where the stand-in tors find one another.
  const torNet = path.join(root, 'tor-net');
  fs.mkdirSync(torNet);
  const machines = [];
  onInterrupt(() => {
    killDaemonsUnder(DAEMON, 'DN_SCRATCH', root);
    for (const m of machines) m.killJobs();
  });

  // The repository on the forge: one commit on main, a pull request and an issue.
  forge.bare(REPO);
  const seed = path.join(root, 'seed');
  fs.mkdirSync(seed);
  git(seed, 'init', '--quiet', '--initial-branch=main', '.');
  fs.writeFileSync(path.join(seed, 'README'), 'widgets\n');
  git(seed, 'add', '.');
  git(seed, 'commit', '--quiet', '-m', 'one');
  git(seed, 'push', '--quiet', path.join(forge.gitRoot, `${REPO}.git`), 'main');
  forge.pull(REPO, { number: 1, author: 'someone', head: 'feature' });
  forge.issue(REPO, { number: 2, author: 'someone' });

  /// A machine, not yet started. `docker` is 'fake', 'none' (no docker binary) or 'real';
  /// `transport` is 'loop', 'tor' (the stand-in tor) or 'real-tor'; `model` is 'fake' (a
  /// key that is no key) or 'real' (this machine's own Claude login, for which the
  /// daemon keeps the real home); `timing` is 'fast' or 'default' (the network's own
  /// constants); `env` is put over everything else the daemon is given.
  function machine(name, { docker = 'fake', transport = 'loop', model = 'fake', timing = 'fast', env: extra = {} } = {}) {
    const home = path.join(root, name);
    const base = path.join(home, 'b');
    const bin = path.join(home, 'bin');
    const agentDir = path.join(home, 'agent');
    const dockerDir = path.join(home, 'docker');
    const configPath = path.join(home, 'config.json');
    const checkout = path.join(home, 'w');
    for (const d of [home, bin, agentDir, dockerDir]) fs.mkdirSync(d, { recursive: true });
    const token = `ghs_${name}${'0'.repeat(24)}`.slice(0, 28);
    forge.tokens.add(token);
    const script = (file, body) => {
      fs.writeFileSync(path.join(bin, file), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
      return path.join(bin, file);
    };
    const gitconfig = path.join(home, 'gitconfig');
    // This machine's own way to the repository, for its checkout and its mirror: its
    // token, not the requester's.
    fs.writeFileSync(gitconfig, [
      '[user]', `\tname = ${name} Operator`, `\temail = ${name}@example.com`, '[init]', '\tdefaultBranch = main',
      `[url "http://x-access-token:${token}@127.0.0.1:${forge.port}/h/github.com/"]`, '\tinsteadOf = https://github.com/', '',
    ].join('\n'));
    const env = {
      PATH: process.env.PATH, TMPDIR: os.tmpdir(), HOME: model === 'real' ? os.homedir() : home, LANG: 'C',
      DN_SCRATCH: root, DN_BASE_DIR: base, DIPLOMAT_CONFIG: configPath,
      GIT_CONFIG_GLOBAL: gitconfig, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
      DN_FORGE_ORIGINS: forge.env.DN_FORGE_ORIGINS,
      DN_GH: script('gh', `[ "$1 $2 $3 $4" = "auth token --hostname github.com" ] && echo "${token}" && exit 0\nexit 1`),
      DN_GLAB: script('glab', 'exit 1'),
      // No Keychain and no login of the operator's: the model credential is a key that
      // is no key.
      ...(model === 'real' ? { DN_MODEL_TOKEN_PATH: path.join(home, 'model-token') } : {
        DN_SECURITY: script('security', 'exit 44'), DN_CLAUDE: script('claude-cli', 'exit 1'), ANTHROPIC_API_KEY: 'sk-ant-api03-stand-in',
      }),
      DN_TRANSPORT: transport === 'loop' ? 'loop' : 'tor', DN_LOOP_DIR: loopDir,
      ...(transport === 'tor' ? { DN_TOR: FAKE_TOR, FAKE_TOR_NET: torNet } : {}),
      // The real docker CLI finds its plugins and its engine through its own config
      // directory, which a home made for the test does not have.
      ...(docker === 'real' ? { DOCKER_CONFIG: process.env.DOCKER_CONFIG || path.join(os.homedir(), '.docker') } : {
        DN_DOCKER: docker === 'none' ? path.join(bin, 'no-docker') : FAKE_DOCKER, FAKE_DOCKER_DIR: dockerDir, FAKE_DOCKER_PATH: bin,
        // The stand-in docker has no networks: a job in it runs on this host, where the
        // name of its relay is the loopback address the broker listens on.
        DN_BROKER_BIND: '127.0.0.1', DN_RELAY_HOST: '127.0.0.1',
      }),
      DN_IMAGE_REPO: 'dn-test-agent',
      // No adb server of the operator's is asked unless a test names it.
      DN_ADB_SERVER: '127.0.0.1:1',
      FAKE_AGENT_DIR: agentDir,
      ...(timing === 'default' ? {} : {
        DN_POW_MEMBER_BASE: '8', DN_POW_STRANGER_BASE: '128',
        DN_TICK_MS: '250', DN_RETRY_MS: '400', DN_SYNC_INTERVAL_MS: '1500', DN_RANK_DELAY_MS: '300', DN_PEER_BACKOFF_MS: '300',
        DN_PEER_BACKOFF_MAX_MS: '1500', DN_PROBE_TIMEOUT_MS: '3000', DN_ROUND_TIMEOUT_MS: '8000', DN_REQUEST_TIMEOUT_MS: '20000',
        DN_CONFIG_POLL_MS: '150', DN_SWITCH_OFF_WAIT_MS: '8000',
        DN_EXECUTOR_CHECK_MS: '700', DN_RECONCILE_MS: '500', DN_EXECUTOR_RETRY_MS: '300',
        // A job under the stand-in docker is a process on this host, seen at once.
        ...(docker === 'real' ? {} : { DN_JOB_POLL_MS: '50', DN_JOB_LIVENESS_MS: '400', DN_JOB_STOP_GRACE_MS: '1000' }),
      }),
      ...extra,
    };
    script('claude', `exec "${process.execPath}" "${AGENT}"`);
    fs.writeFileSync(configPath, JSON.stringify({ networkEnabled: true, networkRequiredMinimumH: 12, networkMaximumAcceptedH: 12 }));
    git(home, 'clone', '--quiet', path.join(forge.gitRoot, `${REPO}.git`), checkout);
    git(checkout, 'remote', 'set-url', 'origin', `https://github.com/${REPO}.git`);

    let child = null;
    let admitting = null;
    const m = {
      name, home, base, env, token, checkout, agentDir, dockerDir, configPath,
      socket: path.join(base, 'daemon.sock'),
      link: { id: POOL, path: checkout, forge: 'github', identity: name },
      get pid() { return child?.pid ?? null; },
      get exited() { return child === null || child.exitCode !== null || child.signalCode !== null; },
      exit: null,

      /// Starts the daemon; resolves once its socket answers.
      async start() {
        child = spawn(process.execPath, [DAEMON], { env, stdio: 'ignore' });
        const mine = child;
        m.exit = new Promise((resolve) => { mine.on('exit', (code, signal) => resolve({ code, signal })); });
        await until(`${name}'s socket`, async () => (await m.call('GET', '/health')).status === 200 || (m.exited && assert.fail(`${name} exited: ${m.log().slice(-2000)}`)));
        return m;
      },
      /// One request on the socket: `{ status, body }`, status 0 when nothing answered.
      call(method, route, body, { raw = null, timeout = 60000 } = {}) {
        return new Promise((resolve) => {
          const data = raw ?? (body === undefined ? null : JSON.stringify(body));
          const req = http.request({
            socketPath: m.socket, path: route, method, timeout,
            headers: { 'content-type': 'application/json', ...(data === null ? {} : { 'content-length': Buffer.byteLength(data) }) },
          }, (res) => {
            let said = '';
            res.setEncoding('utf8');
            res.on('data', (c) => { said += c; });
            res.on('end', () => {
              let parsed = null;
              try { parsed = JSON.parse(said); } catch {}
              resolve({ status: res.statusCode, body: parsed });
            });
          });
          req.on('error', () => resolve({ status: 0, body: null }));
          req.on('timeout', () => req.destroy());
          req.end(data ?? undefined);
        });
      },
      /// A request that must be taken: its answer's body.
      async ok(route, body) {
        const answer = await m.call('POST', route, body);
        assert.equal(answer.status, 200, `${name} ${route}: ${JSON.stringify(answer.body)}`);
        return answer.body;
      },
      state: async () => (await m.call('GET', '/state')).body,
      /// Tells the daemon its pools, as Diplomat does once it knows them.
      linked: () => m.ok('/pools', { pools: [m.link] }),
      /// Says, and keeps saying, how many tasks this machine takes at a time, counted
      /// against its own snapshot as Diplomat counts.
      admit(slots) {
        clearInterval(admitting);
        const say = async () => {
          const going = (await m.state())?.runs.filter((run) => run.endedAt === 0).length ?? 0;
          await m.call('POST', '/admit', { slots: Math.max(0, slots - going), reason: 'test' });
        };
        admitting = setInterval(() => say().catch(() => {}), 400);
        return say();
      },
      quiet() { clearInterval(admitting); },
      setConfig(patch) {
        const next = { ...JSON.parse(fs.readFileSync(configPath, 'utf8')), ...patch };
        fs.writeFileSync(`${configPath}.tmp`, JSON.stringify(next));
        fs.renameSync(`${configPath}.tmp`, configPath);
      },
      log: () => { try { return fs.readFileSync(path.join(base, 'daemon.log'), 'utf8'); } catch { return ''; } },
      /// What the stand-in agent of a run recorded, or null.
      agent(runId) { try { return JSON.parse(fs.readFileSync(path.join(agentDir, `${runId}.json`), 'utf8')); } catch { return null; } },
      /// Lets an agent that waits for `name` go on.
      release(file) { fs.writeFileSync(path.join(agentDir, file), ''); },
      /// Every invocation of the stand-in docker, or those of one subcommand.
      docker(command) {
        let lines = [];
        try { lines = fs.readFileSync(path.join(dockerDir, 'calls.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch {}
        return command ? lines.filter((a) => a[0] === command) : lines;
      },
      /// The containers the stand-in docker holds, by name.
      containers() {
        try { return fs.readdirSync(path.join(dockerDir, 'containers')).map((f) => f.replace(/\.json$/, '')).sort(); } catch { return []; }
      },
      /// Runs the installer as an applet would; its one JSON object.
      install(flag) {
        return new Promise((resolve, reject) => {
          const run = spawn(process.execPath, [INSTALL, flag], { env, stdio: ['ignore', 'pipe', 'inherit'] });
          let out = '';
          run.stdout.on('data', (c) => { out += c; });
          run.on('error', reject);
          run.on('exit', () => { try { resolve(JSON.parse(out)); } catch { reject(new Error(`${flag} printed: ${out}`)); } });
        });
      },
      /// SIGTERM, and the exit that follows.
      async stop() {
        m.quiet();
        if (m.exited) return m.exit;
        child.kill('SIGTERM');
        return m.exit;
      },
      /// The process gone at once, as a crash or a power cut takes it.
      async kill() {
        m.quiet();
        if (!m.exited) child.kill('SIGKILL');
        await m.exit;
      },
      /// Kills what the stand-in docker started for this machine's jobs.
      killJobs() {
        for (const c of m.containers()) {
          try {
            const { pids = [] } = JSON.parse(fs.readFileSync(path.join(dockerDir, 'containers', `${c}.json`), 'utf8'));
            for (const pid of pids) { try { process.kill(-pid, 'SIGKILL'); } catch {} }
          } catch {}
        }
      },
    };
    machines.push(m);
    return m;
  }

  return {
    root, forge, loopDir, machine,
    /// The forge's requests so far that carried `token`, as `[method, host, path]`.
    sentWith(token) {
      const bearer = `Bearer ${token}`;
      const basic = `Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;
      return forge.log.filter((r) => [bearer, basic].includes(r.headers.authorization)).map((r) => [r.method, r.host, r.path]);
    },
    /// What a branch of the repository on the forge points at: `{ sha, author }`, or null.
    branch(name) {
      try {
        const [sha, author] = git(path.join(forge.gitRoot, `${REPO}.git`), 'log', '-1', '--format=%H%n%an <%ae>', `refs/heads/${name}`).split('\n');
        return { sha, author };
      } catch { return null; }
    },
    /// Stops everything and removes every trace.
    async close() {
      for (const m of machines) m.quiet();
      await Promise.all(machines.map((m) => m.kill().catch(() => {})));
      // A daemon started through the installer is no child of this process.
      killDaemonsUnder(DAEMON, 'DN_SCRATCH', root);
      for (const m of machines) m.killJobs();
      await forge.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}
