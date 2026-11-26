// What a job's runner and the host's questions to a container take from the container,
// against the stand-in docker with the real runner.sh and stop.sh: the host's sh and
// tools by their full paths, nothing another job of the container wrote read before the
// agent starts, git settings that are one job's own, and a runner known by its run id
// from its first moment.
// Run: node test/executor-runner.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { scratchDir } from './lib/scratch.mjs';

const scratch = scratchDir('dn-runner-');
// The stand-in container shares the host's /proc, where stop.sh finds a job's processes
// by run id: two of this file at once under one id would stop each other's jobs.
const R = `runner-${process.pid}`;
const FAKE = fileURLToPath(new URL('./lib/fake-docker.mjs', import.meta.url));
const [fakeDir, agentDir, binDir, forgeDir, imageDir, plantedDir, pathDir] = ['docker', 'agent', 'bin', 'forge', 'image', 'planted', 'path'].map((d) => path.join(scratch, d));
for (const d of [fakeDir, agentDir, binDir, forgeDir, imageDir, plantedDir, pathDir]) fs.mkdirSync(d);
fs.writeFileSync(path.join(imageDir, 'Dockerfile'), 'FROM scratch\n');
fs.writeFileSync(path.join(scratch, 'gitconfig'), `[user]\n\tname = T\n\temail = t@example.com\n[init]\n\tdefaultBranch = main\n[url "${forgeDir}/"]\n\tinsteadOf = https://github.com/\n`);

// The agent: says what it found, then behaves as its prompt says. It names in full the
// one tool it waits with, so that what a check plants on PATH is run by nobody but the
// one that check is about.
fs.writeFileSync(path.join(binDir, 'claude'), `#!/bin/sh
out="$FAKE_AGENT_DIR/$DN_RUN_ID"
cat > "$out.prompt"
mode="$(sed -n 's/^MODE=//p' "$out.prompt" | tail -1)"
env > "$out.env"
held() { echo started > "$out.started"; while [ ! -e "$FAKE_AGENT_DIR/go-$DN_RUN_ID" ]; do /bin/sleep 0.05; done; }
case "$mode" in
  hold) trap '' TERM; echo started > "$out.started"; exec /bin/sleep 60 ;;
  plant) /bin/sh "$FAKE_AGENT_DIR/plant.sh" > "$out.plant" 2>&1; held ;;
  settle) git config --global user.name 'Somebody Else'; git config --global credential.helper theirs; git config --global url.https://elsewhere.example/.insteadOf https://github.com/ ;;
  late) held ;;
esac
{ git rev-parse HEAD; git config user.name; git config --get remote.origin.url; git config credential.helper; git config --get-regexp '^url[.]'; } > "$out.git"
cat .git/objects/info/alternates > "$out.borrows" 2>/dev/null
echo '{"type":"result","subtype":"success","is_error":false,"result":"did '"$DN_RUN_ID"'","total_cost_usd":0,"usage":{"input_tokens":1,"output_tokens":1}}'
`, { mode: 0o755 });

const BASE = path.join(scratch, 'base');
Object.assign(process.env, {
  DN_BASE_DIR: BASE, DN_DOCKER: FAKE, FAKE_DOCKER_DIR: fakeDir, FAKE_DOCKER_PATH: binDir, FAKE_AGENT_DIR: agentDir,
  DN_BROKER_BIND: '127.0.0.1', DN_RELAY_HOST: '127.0.0.1', DN_IMAGE_REPO: 'dn-test-agent',
  DN_JOB_POLL_MS: '40', DN_JOB_LIVENESS_MS: '250', DN_JOB_STOP_GRACE_MS: '1000', DN_CONTAINER_IDLE_MS: '3600000',
  GIT_CONFIG_GLOBAL: path.join(scratch, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1',
});
const { createContainers, containerName } = await import('../src/executor/container.js');
const { startJob, watch, stopJob } = await import('../src/executor/job.js');
// The same module as a daemon started later holds it: it knows of no job.
const later = await import('../src/executor/job.js?later');
const { createBroker } = await import('../src/executor/broker.js');
const { createCA } = await import('../src/executor/ca.js');
const { createMirrors } = await import('../src/executor/mirror.js');
const { RUNS_DIR } = await import('../src/paths.js');

let checks = 0;
const check = async (name, fn) => { await fn(); checks++; console.log(`PASS ${name}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const calls = (command) => fs.readFileSync(path.join(fakeDir, 'calls.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((a) => a[0] === command);
const agent = (runId, what) => fs.readFileSync(path.join(agentDir, `${runId}.${what}`), 'utf8');
const envOf = (runId) => Object.fromEntries(agent(runId, 'env').split('\n').filter((l) => l.includes('=')).map((l) => l.split(/=(.*)/s).slice(0, 2)));
// Long enough for a machine with every core taken many times over.
const until = async (what, fn, ms = 120000) => { for (const end = Date.now() + ms; Date.now() < end;) { if (await fn()) return; await sleep(25); } assert.fail(`never: ${what}`); };
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const started = (runId) => until(`${runId} runs its agent`, () => fs.existsSync(path.join(agentDir, `${runId}.started`)));
const go = (runId) => fs.writeFileSync(path.join(agentDir, `go-${runId}`), '');
// Whether this host shows a process's environment, as a container's /proc does: where
// it does not, the stand-in docker cannot find a job's processes by their run id.
const PROC = fs.existsSync('/proc/self/environ');

const bare = path.join(forgeDir, 'dn-test', 'alpha.git');
fs.mkdirSync(bare, { recursive: true });
git(bare, 'init', '--quiet', '--bare');
const checkout = path.join(scratch, 'checkout');
git(scratch, 'clone', '--quiet', 'https://github.com/dn-test/alpha.git', checkout);
fs.writeFileSync(path.join(checkout, 'README'), 'alpha\n');
git(checkout, 'add', '.');
git(checkout, 'commit', '--quiet', '-m', 'one');
git(checkout, 'push', '--quiet', 'origin', 'main');
const HEAD = git(checkout, 'rev-parse', 'HEAD');
const pool = { id: 'github.com/dn-test/alpha', forge: 'github', host: 'github.com', owner: 'dn-test', repo: 'alpha' };
const PEER = 'pkAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

const log = () => {};
const containers = createContainers({ log, imageDir, broker: () => broker.address() });
const mirrors = createMirrors({ log });
const broker = createBroker({
  log, ca: createCA(), mirrors,
  llm: { authorize: async (h) => h, refused: async () => false },
  onForge: async () => ({ status: 403, headers: {}, body: '' }),
});

// What the daemon does to start one job; `env` is what the engine's exec of its runner
// carries besides: the stand-in's way to say what the container holds. `ca` stands in
// for the certificate authority the broker gave the job.
async function start(runId, spec = {}, env = {}, ca = null) {
  const run = { runId, pool };
  const container = await containers.acquire({ pool, peer: PEER, runId });
  await mirrors.ensureMirror({ pool, checkout });
  const proxy = { ...await broker.addJob({ ...run, peer: PEER }), ...(ca ? { caCertPath: ca } : {}) };
  const before = { ...process.env };
  for (const [k, v] of Object.entries(env)) { if (v === null) delete process.env[k]; else process.env[k] = v; }
  let job;
  try {
    job = await startJob({ run, container, spec: { prompt: 'Review.', item: 'pr:7', base: '', name: 'Requester Name', email: 'requester@example.com', ...spec }, proxy });
  } finally {
    for (const k of Object.keys(env)) { if (k in before) process.env[k] = before[k]; else delete process.env[k]; }
  }
  const end = () => { broker.removeJob(runId); return containers.release({ name: container.name, runId }); };
  return { run, container, proxy, pid: job.pid, dir: job.dir, end };
}
const launch = async (...args) => {
  const job = await start(...args);
  return { ...job, outcome: watch(job.run).finally(job.end) };
};

try {
  await broker.start();
  const root = path.join(fakeDir, 'roots', containerName(pool.id, PEER));

  await check('what the host runs in a container - its first process, the start of a job, the questions after it and its end - is named by its full path or found in the system\'s own directories: a sh, setsid, kill, grep, tr, sleep and rm put earlier on the container\'s PATH run for none of it', async () => {
    const ran = path.join(scratch, 'ran-from-path');
    for (const tool of ['sh', 'setsid', 'kill', 'grep', 'tr', 'sleep', 'rm']) {
      fs.writeFileSync(path.join(pathDir, tool), `#!/bin/sh\necho ${tool} >> '${ran}'\nexec "$(PATH="\${PATH#'${pathDir}':}" command -v ${tool})" "$@"\n`, { mode: 0o755 });
    }
    process.env.FAKE_DOCKER_PATH = `${pathDir}:${binDir}`;
    try {
      const job = await launch(`${R}-path`, { prompt: 'MODE=hold' });
      await started(`${R}-path`);
      const asked = () => calls('exec').map((c) => [c[2], c[6]]);
      await until('the job is asked after', () => asked().some(([, verb]) => verb === 'up'));
      assert.equal((await stopJob(job.run, containers)).state, 'stopped');
      await job.outcome;
      await until('its runner is dead', () => !pidAlive(job.pid));
      // The start, and every verb of stop.sh: the agent ignores TERM, so the stop waits out its grace.
      assert.deepEqual([...new Set(asked().map(([, verb]) => verb))].sort(), [`/dn/runs/${R}-path/run.sh`, 'left', 'stop', 'up'].sort());
      assert.equal(fs.existsSync(ran) ? fs.readFileSync(ran, 'utf8') : '', '', 'run from what the job put on PATH');
      assert.deepEqual([...new Set(asked().map(([program]) => program))], ['/bin/sh']);
      // What a restart of the container starts again is named the same way.
      assert.deepEqual(calls('run').map((c) => c.slice(-2)), [['/usr/bin/sleep', 'infinity']]);
    } finally {
      process.env.FAKE_DOCKER_PATH = binDir;
    }
  });

  await check('a runner reads nothing another job of its container wrote before its agent starts: a copy of the repository under /work with a remote and hooks of that job\'s choosing, git\'s system settings and its template directory run nothing in the job that starts beside it', async () => {
    const marks = path.join(scratch, 'ran-in-another-job');
    const mark = (file, what) => {
      fs.mkdirSync(path.dirname(path.join(plantedDir, file)), { recursive: true });
      fs.writeFileSync(path.join(plantedDir, file), `#!/bin/sh\necho "${what} ran in $DN_RUN_ID with $DN_PROXY" >> '${marks}'\nexit 1\n`, { mode: 0o755 });
    };
    mark('uploadpack', 'the upload-pack of the copy');
    mark('reference-transaction', 'a hook of the copy');
    mark('system/post-checkout', 'a hook the system settings name');
    mark('templates/hooks/post-checkout', 'a hook from the template directory');
    // The first job, as root in the container, while it runs.
    fs.writeFileSync(path.join(agentDir, 'plant.sh'), `set -e
cache="$DN_ROOT/work/cache.git"
[ -d "$cache" ] || git init --quiet --bare "$cache"
git -C "$cache" config remote.origin.url '${plantedDir}/elsewhere'
git -C "$cache" config remote.origin.uploadpack '${plantedDir}/uploadpack'
mkdir -p "$cache/hooks" "$DN_ROOT/etc" "$DN_ROOT/usr/share/git-core"
cp '${plantedDir}/reference-transaction' "$cache/hooks/"
printf '[core]\\n\\thooksPath = %s\\n' '${plantedDir}/system' > "$DN_ROOT/etc/gitconfig"
cp -R '${plantedDir}/templates' "$DN_ROOT/usr/share/git-core/"
`);
    const first = await launch(`${R}-plants`, { prompt: 'MODE=plant' });
    await started(`${R}-plants`);
    assert.equal(agent(`${R}-plants`, 'plant'), '', 'the planting itself');
    assert.equal(git(path.join(root, 'work', 'cache.git'), 'config', 'remote.origin.uploadpack'), path.join(plantedDir, 'uploadpack'));

    // The second job's runner in the container as the first left it: the system
    // settings and the templates git finds there are the ones the first job wrote.
    const second = await launch(`${R}-beside`, {}, {
      GIT_CONFIG_NOSYSTEM: null, GIT_CONFIG_SYSTEM: path.join(root, 'etc', 'gitconfig'), GIT_TEMPLATE_DIR: path.join(root, 'usr', 'share', 'git-core', 'templates'),
    });
    assert.equal(second.container.name, first.container.name);
    const outcome = await second.outcome;
    assert.equal(fs.existsSync(marks) ? fs.readFileSync(marks, 'utf8') : '', '', 'the first job\'s programs ran in the second');
    assert.equal(outcome.ok, true, fs.readFileSync(path.join(second.dir, 'setup.log'), 'utf8'));
    assert.deepEqual([agent(`${R}-beside`, 'git').split('\n'), agent(`${R}-beside`, 'borrows')], [[HEAD, 'Requester Name', 'https://github.com/dn-test/alpha.git', ''], ''], 'a clone of its own from the mirror, borrowing from nothing');
    assert.deepEqual([envOf(`${R}-beside`).GIT_CONFIG_NOSYSTEM, envOf(`${R}-beside`).GIT_TEMPLATE_DIR], ['1', ''], 'and its agent reads neither');
    go(`${R}-plants`);
    assert.equal((await first.outcome).ok, true);
  });

  await check('git\'s settings are one job\'s own: what a job of the same container sets for every repository - a name, a credential helper, another address for the forge - reaches no other job', async () => {
    const mine = await launch(`${R}-mine`, { prompt: 'MODE=late', name: 'First Requester' });
    await started(`${R}-mine`);
    const theirs = await launch(`${R}-theirs`, { prompt: 'MODE=settle', name: 'Second Requester' });
    assert.equal(theirs.container.name, mine.container.name);
    assert.equal((await theirs.outcome).ok, true);
    assert.deepEqual(agent(`${R}-theirs`, 'git').split('\n').slice(1, 5), ['Somebody Else', 'https://github.com/dn-test/alpha.git', 'theirs', 'url.https://elsewhere.example/.insteadof https://github.com/']);
    go(`${R}-mine`);
    assert.equal((await mine.outcome).ok, true);
    assert.deepEqual(agent(`${R}-mine`, 'git').split('\n'), [HEAD, 'First Requester', 'https://github.com/dn-test/alpha.git', ''], 'the first job\'s settings after the second set its own');
    for (const runId of [`${R}-mine`, `${R}-theirs`]) assert.equal(envOf(runId).GIT_CONFIG_GLOBAL, path.join(root, 'work', 'jobs', runId, 'gitconfig'));
  });

  await check('a job that brings another certificate authority than the one its container has installs it beside that one, under a name of its own: both are trusted while both jobs run', async () => {
    const first = await launch(`${R}-ca-1`, { prompt: 'MODE=late' });
    await started(`${R}-ca-1`);
    const store = path.join(root, 'usr/local/share/ca-certificates');
    const own = fs.readFileSync(first.proxy.caCertPath, 'utf8');
    const sum = (text) => execFileSync('cksum', { input: text, encoding: 'utf8' }).split(' ')[0];
    assert.deepEqual(fs.readdirSync(store), [`dn-broker-${sum(own)}.crt`]);
    // The broker's own again, as a file of other bytes: git still trusts the broker by it.
    const newer = path.join(scratch, 'newer-ca.crt');
    fs.writeFileSync(newer, `${own}\n`);
    const second = await launch(`${R}-ca-2`, {}, {}, newer);
    assert.equal(second.container.name, first.container.name);
    assert.equal((await second.outcome).ok, true, fs.readFileSync(path.join(second.dir, 'setup.log'), 'utf8'));
    assert.deepEqual(fs.readdirSync(store).sort(), [`dn-broker-${sum(own)}.crt`, `dn-broker-${sum(`${own}\n`)}.crt`].sort());
    assert.deepEqual([fs.readFileSync(path.join(store, `dn-broker-${sum(own)}.crt`), 'utf8'), fs.readFileSync(path.join(store, `dn-broker-${sum(`${own}\n`)}.crt`), 'utf8')], [own, `${own}\n`]);
    const bundle = fs.readFileSync(path.join(root, 'etc/ssl/certs/ca-certificates.crt'), 'utf8');
    assert.equal(bundle.split(own.trim()).length - 1, 2, 'the bundle every tool reads holds the two');
    go(`${R}-ca-1`);
    assert.equal((await first.outcome).ok, true);
  });

  await check('a runner carries its run\'s id from its first moment: a job nobody kept the process group of is ended runner first, before the runner can say how its agent ended', async () => {
    const job = await start(`${R}-id`, { prompt: 'MODE=hold' });
    await started(`${R}-id`);
    if (PROC) assert.ok(fs.readFileSync(`/proc/${job.pid}/environ`, 'utf8').split('\0').includes(`DN_RUN_ID=${R}-id`));
    assert.equal(later.attachJob({ runId: `${R}-id`, container: job.container }), true);
    assert.equal((await later.stopJob(job.run, containers)).state, 'stopped');
    if (PROC) {
      await until('its runner is dead', () => !pidAlive(job.pid));
      // The agent ignores TERM and dies of the KILL: a runner that outlived the TERM would write how.
      assert.equal(fs.existsSync(path.join(job.dir, 'done')), false, 'the runner was still there when its agent was killed');
    } else process.kill(-job.pid, 'SIGKILL');
    await job.end();
  });

  console.log(`\nall ${checks} checks passed`);
} finally {
  await broker.stop().catch(() => {});
  // Whatever a failed check left running.
  for (const f of fs.existsSync(path.join(fakeDir, 'containers')) ? fs.readdirSync(path.join(fakeDir, 'containers')) : []) {
    try { execFileSync(FAKE, ['rm', '-f', f.replace(/\.json$/, '')]); } catch {}
  }
}
process.exit(0);
