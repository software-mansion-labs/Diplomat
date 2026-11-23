// Containers and jobs against the stand-in docker: one container per peer and
// repository, its by its labels and not by its name, on a network of its own with a
// relay as its one way out, many jobs in it, each stopped on its own; what it may take
// of the machine, its disk included; the image built once per tag; the real runner
// script cloning through the real broker from a real mirror, with a stand-in for the agent.
// Run: node test/executor-container.mjs

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'dn-ctr-'));
// What every run id here begins with. The stand-in container shares the host's /proc,
// where stop.sh finds a job's processes by the run id in their environment: two of this
// file at once under one id would stop each other's jobs.
const R = `run-${process.pid}`;
const FAKE = fileURLToPath(new URL('./lib/fake-docker.mjs', import.meta.url));
const fakeDir = path.join(scratch, 'docker');
const agentDir = path.join(scratch, 'agent');
const binDir = path.join(scratch, 'bin');
const forgeDir = path.join(scratch, 'forge');
const imageDir = path.join(scratch, 'image');
for (const d of [fakeDir, agentDir, binDir, forgeDir, imageDir]) fs.mkdirSync(d);
fs.writeFileSync(path.join(imageDir, 'Dockerfile'), 'FROM scratch\n');
fs.writeFileSync(path.join(scratch, 'gitconfig'), `[user]\n\tname = T\n\temail = t@example.com\n[init]\n\tdefaultBranch = main\n[url "${forgeDir}/"]\n\tinsteadOf = https://github.com/\n`);

// The agent: records what it was started with, then behaves as its prompt says.
fs.writeFileSync(path.join(binDir, 'claude'), `#!/bin/sh
out="$FAKE_AGENT_DIR/$DN_RUN_ID"
cat > "$out.prompt"
printf '%s\\n' "$@" > "$out.args"
env > "$out.env"
pwd -P > "$out.cwd"
{ git rev-parse HEAD; git config user.name; git config user.email; git config --get remote.origin.url; cat .git/objects/info/alternates 2>/dev/null; } > "$out.git"
mode="$(sed -n 's/^MODE=//p' "$out.prompt" | tail -1)"
run="$DN_ROOT/dn/runs/$DN_RUN_ID"
echo '{"type":"system","subtype":"init","model":"claude-big"}'
case "$mode" in
  sleep) echo started > "$out.started"; exec sleep 60 ;;
  defy) trap '' TERM; printf '#!/bin/sh\\nexit 0\\n' > "$run/stop.sh"; sed -n 's/^GROUP=//p' "$out.prompt" > "$run/pid"; echo started > "$out.started"; exec sleep 60 ;;
  vanish) echo started > "$out.started"; kill -9 "$PPID" "$$" ;;
  crash) echo "boom: the agent fell over" >&2; exit 3 ;;
  refused) echo '{"type":"result","subtype":"error_during_execution","is_error":true,"result":"the model refused","total_cost_usd":0.01,"usage":{"input_tokens":5,"output_tokens":1}}'; exit 1 ;;
  link) rm -f "$run/log.jsonl"; ln -s "$FAKE_AGENT_DIR/planted/log.jsonl" "$run/log.jsonl"; exit 0 ;;
  swap) sleep 1; mv "$run" "$run.real"; ln -s "$FAKE_AGENT_DIR/planted" "$run"; exit 0 ;;
  leave) echo left > "$DN_ROOT/work/left-by-a-job"; echo left > "$DN_ROOT/left-by-a-job"; echo left > "$DN_ROOT/dn/runs/left-by-a-job" ;;
  commit) echo fix > fix.txt; git add fix.txt; git commit --quiet -m "fix by the agent"; git log -1 --format='%an <%ae>' > "$out.author" ;;
  forward) node -e 'const [h, p] = process.env.DN_FORWARD_ECHO.split(":"); const s = require("net").connect(p, h); s.on("data", (d) => { process.stdout.write(d); s.end(); }); s.on("error", (e) => console.log(e.message)); s.write("ping");' > "$out.forward" 2>&1 ;;
esac
echo '{"type":"assistant","message":{"content":[{"type":"text","text":"working"}]}}'
echo '{"type":"result","subtype":"success","is_error":false,"result":"did '"$DN_RUN_ID"'","total_cost_usd":0.25,"usage":{"input_tokens":1,"output_tokens":1},"modelUsage":{"claude-small":{"inputTokens":1,"outputTokens":2,"cacheReadInputTokens":3,"cacheCreationInputTokens":4,"costUSD":0.05},"claude-big":{"inputTokens":10,"outputTokens":20,"cacheReadInputTokens":300,"cacheCreationInputTokens":4000,"costUSD":0.2}}}'
`, { mode: 0o755 });

const BASE = path.join(scratch, 'base');
Object.assign(process.env, {
  DN_BASE_DIR: BASE, DN_DOCKER: FAKE, FAKE_DOCKER_DIR: fakeDir, FAKE_DOCKER_PATH: binDir, FAKE_AGENT_DIR: agentDir,
  // The stand-in docker has no networks: a job in it runs on this host, where the name
  // of its relay has to be the loopback address the broker itself listens on.
  DN_BROKER_BIND: '127.0.0.1', DN_RELAY_HOST: '127.0.0.1', DN_IMAGE_REPO: 'dn-test-agent',
  DN_JOB_POLL_MS: '40', DN_JOB_LIVENESS_MS: '250', DN_JOB_STOP_GRACE_MS: '1000', DN_CONTAINER_IDLE_MS: '3600000',
  DN_CONTAINER_DISK_BYTES: String(16 * 2 ** 20),
  GIT_CONFIG_GLOBAL: path.join(scratch, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1',
});
const { createContainers, containerName, docker, imageTag, IMAGE_DIR } = await import('../src/executor/container.js');
const { OwnFault } = await import('../src/executor/own-fault.js');
const { startJob, watch, stopJob, renderPrompt, readOutcome } = await import('../src/executor/job.js');
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
const calls = (command) => fs.readFileSync(path.join(fakeDir, 'calls.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((a) => !command || a[0] === command);
const agent = (runId, what) => fs.readFileSync(path.join(agentDir, `${runId}.${what}`), 'utf8');
// Long enough for a machine with every core taken many times over.
const until = async (what, fn, ms = 120000) => { for (const end = Date.now() + ms; Date.now() < end;) { if (await fn()) return; await sleep(25); } assert.fail(`never: ${what}`); };
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
// Whether this host shows a process's environment, as a container's /proc does: where
// it does not, the stand-in docker cannot find a job's processes by their run id.
const PROC = fs.existsSync('/proc/self/environ');
const NAME = /^dn-[0-9a-z]{25}-[0-9a-z]{25}$/;
const volumeOf = (name) => name.replace('dn-', 'dn-work-');
const labels = (pool, peer) => ['--label', `dn.pool=${pool.id}`, '--label', `dn.peer=${peer}`, '--label', `dn.base=${BASE}`];
// A container, its network and its volume as an earlier daemon of this base left them.
const leave = (name, pool, peer, tag, { network = true, mounts = true } = {}) => {
  if (network) execFileSync(FAKE, ['network', 'create', '--internal', '-o', 'com.docker.network.bridge.gateway_mode_ipv4=isolated', ...labels(pool, peer), name]);
  if (mounts) execFileSync(FAKE, ['volume', 'create', ...labels(pool, peer), volumeOf(name)]);
  execFileSync(FAKE, ['run', '-d', '--name', name, ...labels(pool, peer), ...(network ? ['--network', name] : []),
    ...(mounts ? ['-v', `${volumeOf(name)}:/work`, '-v', `${path.join(RUNS_DIR, '.containers', name)}:/dn/runs`] : []), tag, 'sleep', 'infinity']);
};
// A child process with its own stand-in engine and `env` on top of this one's: what `script` prints, as JSON.
const child = (env, script) => {
  const dir = fs.mkdtempSync(path.join(scratch, 'child-'));
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', `
    const { createContainers, containerName } = await import(${JSON.stringify(new URL('../src/executor/container.js', import.meta.url).href)});
    const paths = await import(${JSON.stringify(new URL('../src/paths.js', import.meta.url).href)});
    const fs = await import('node:fs');
    const calls = () => fs.readFileSync(process.env.FAKE_DOCKER_DIR + '/calls.jsonl', 'utf8').split('\\n').filter(Boolean).map((l) => JSON.parse(l));
    ${script}`], { env: { ...process.env, DN_BASE_DIR: path.join(dir, 'base'), FAKE_DOCKER_DIR: path.join(dir, 'docker'), ...env }, encoding: 'utf8' });
  return JSON.parse(out);
};

function makeRepo(owner, name) {
  const bare = path.join(forgeDir, owner, `${name}.git`);
  fs.mkdirSync(bare, { recursive: true });
  git(bare, 'init', '--quiet', '--bare');
  const checkout = path.join(scratch, `checkout-${owner}-${name}`);
  git(scratch, 'clone', '--quiet', `https://github.com/${owner}/${name}.git`, checkout);
  fs.writeFileSync(path.join(checkout, 'README'), `${owner}/${name}\n`);
  git(checkout, 'add', '.');
  git(checkout, 'commit', '--quiet', '-m', 'one');
  git(checkout, 'push', '--quiet', 'origin', 'main');
  const main = git(checkout, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(checkout, 'README'), 'the pull request\n');
  git(checkout, 'commit', '--quiet', '-am', 'pr');
  git(checkout, 'push', '--quiet', 'origin', 'HEAD:refs/pull/7/head');
  const pr = git(checkout, 'rev-parse', 'HEAD');
  git(checkout, 'reset', '--quiet', '--hard', main);
  return { bare, checkout, main, pr, pool: { id: `github.com/${owner}/${name}`, forge: 'github', host: 'github.com', owner, repo: name } };
}

const clock = { now: Date.now() };
const logged = [];
const log = (...a) => logged.push(a.join(' '));
const containers = createContainers({ log, now: () => clock.now, imageDir, broker: () => broker.address() });
const mirrors = createMirrors({ log });
const forgeSeen = [];
const broker = createBroker({
  log, ca: createCA(), mirrors,
  llm: { authorize: async (h) => h, refused: async () => false },
  onForge: async (job, request) => { forgeSeen.push({ job, request }); return { status: 403, headers: {}, body: Buffer.from('{"message":"not for this task"}').toString('base64') }; },
});
const PEER_A = 'pkAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const PEER_B = 'pkBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const SPEC = { prompt: 'Review the pull request.', item: 'pr:7', base: '', name: 'Requester Name', email: 'requester@example.com' };

// What the daemon does around one job: container, mirror, broker, start.
async function launch(runId, peer, repo, spec = {}, forwardTo = {}, alsoTold = []) {
  const run = { runId, pool: repo.pool };
  const container = await containers.acquire({ pool: repo.pool, peer, runId });
  await mirrors.ensureMirror({ pool: repo.pool, checkout: repo.checkout });
  const proxy = await broker.addJob({ ...run, peer });
  const forwards = [...Object.entries(forwardTo).map(([name, port]) => broker.addForward(runId, { name, target: { port } })), ...alsoTold];
  const started = await startJob({ run, container, spec: { ...SPEC, ...spec }, proxy, env: { CLAUDE_CODE_OAUTH_TOKEN: 'dn-placeholder' }, forwards });
  // The group a job is asked after and stopped by is there the moment the start names it.
  assert.doesNotThrow(() => process.kill(-started.pid, 0), `no process group ${started.pid} yet`);
  const outcome = watch(run).finally(() => { broker.removeJob(runId); return containers.release({ name: container.name, runId }); });
  return { run, container, proxy, started, outcome };
}

// A count in a pair's container with no job behind it: the container lasts until the
// function this resolves to is called, for a check that looks into it after its jobs.
async function hold(peer, repo) {
  const runId = `hold-${crypto.randomBytes(4).toString('hex')}`;
  const { name } = await containers.acquire({ pool: repo.pool, peer, runId });
  return () => containers.release({ name, runId });
}

try {
  await check('the image tag is the hash of the image directory: stable, and new when any file in it changes', () => {
    const tag = imageTag(imageDir);
    assert.match(tag, /^dn-test-agent:[0-9a-f]{12}$/);
    assert.equal(imageTag(imageDir), tag);
    fs.mkdirSync(path.join(imageDir, 'sub'));
    fs.writeFileSync(path.join(imageDir, 'sub', 'tool.sh'), 'echo\n');
    const withFile = imageTag(imageDir);
    assert.notEqual(withFile, tag, 'a new file');
    fs.renameSync(path.join(imageDir, 'sub', 'tool.sh'), path.join(imageDir, 'sub', 'tool2.sh'));
    assert.notEqual(imageTag(imageDir), withFile, 'a renamed file');
    fs.rmSync(path.join(imageDir, 'sub'), { recursive: true });
    assert.equal(imageTag(imageDir), tag);
    assert.match(imageTag(IMAGE_DIR), /^dn-test-agent:[0-9a-f]{12}$/, 'the real one hashes too');
  });

  await check('a container is named by its pool and its peer, by nothing else, and by 128 bits of each: no key can be ground to another peer\'s name', () => {
    const name = containerName('github.com/o/r', PEER_A);
    assert.match(name, NAME);
    assert.equal(containerName('github.com/o/r', PEER_A), name);
    const otherPeer = containerName('github.com/o/r', PEER_B);
    const otherPool = containerName('github.com/o/r2', PEER_A);
    assert.equal(otherPeer.slice(0, 28), name.slice(0, 28), 'same pool, same first half');
    assert.notEqual(otherPeer.slice(29), name.slice(29), 'another peer, another second half');
    assert.notEqual(otherPool.slice(0, 28), name.slice(0, 28), 'another pool, another first half');
    assert.equal(otherPool.slice(29), name.slice(29));
    // Each half is the first sixteen bytes of the SHA-256, written in base 36.
    const bits = (part) => [...part].reduce((n, c) => n * 36n + BigInt(parseInt(c, 36)), 0n).toString(16).padStart(32, '0');
    const first16 = (text) => crypto.createHash('sha256').update(text).digest('hex').slice(0, 32);
    assert.deepEqual(name.slice(3).split('-').map(bits), [first16('github.com/o/r'), first16(PEER_A)]);
    // Docker's rule for a name, and a DNS label's length, with the longest thing made from it.
    for (const made of [name, `${name}-relay`, `${name}-probe`, volumeOf(name)]) assert.match(made, /^[a-zA-Z0-9][a-zA-Z0-9_.-]{1,62}$/, made);
  });

  await check('without a docker binary the state is missing; with an engine that does not answer it is down', async () => {
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', `
      const { createContainers } = await import(${JSON.stringify(new URL('../src/executor/container.js', import.meta.url).href)});
      const c = createContainers();
      const err = await c.ensureImage().then(() => null, (e) => e.message);
      console.log(JSON.stringify({ err, state: c.dockerState() }));`], { env: { ...process.env, DN_DOCKER: path.join(scratch, 'no-docker') }, encoding: 'utf8' });
    const missing = JSON.parse(out);
    assert.equal(missing.state.state, 'missing');
    assert.match(missing.err, /no-docker not found: every job runs in a container/);

    fs.writeFileSync(path.join(fakeDir, 'down'), '');
    await assert.rejects(containers.ensureImage(), /the docker engine is not answering \(Cannot connect to the Docker daemon/);
    assert.equal(containers.dockerState().state, 'down');
    assert.deepEqual(calls('build'), [], 'and nothing tried to start or build anything');
    fs.rmSync(path.join(fakeDir, 'down'));
  });

  await check('an engine older than the one that can keep this machine off a job\'s network is a failed state that names the version needed, and nothing is built or made on it', async () => {
    for (const old of ['27.0.3', '26.1.4', '20.10.24', '5.3.1']) {
      fs.writeFileSync(path.join(fakeDir, 'engine-version'), `${old}\n`);
      await assert.rejects(containers.ensureImage(), new RegExp(`^Error: this docker engine is ${old.replace(/\./g, '\\.')}: a job's network must carry no address of this machine, which takes Docker 27\\.1 or later$`));
      assert.deepEqual(containers.dockerState(), { state: 'failed', image: '', detail: `this docker engine is ${old}: a job's network must carry no address of this machine, which takes Docker 27.1 or later` });
      await assert.rejects(containers.acquire({ pool: { id: 'github.com/o/r' }, peer: PEER_A, runId: 'old' }), /^OwnFault: this docker engine is \S+: a job's network must carry no address of this machine, which takes Docker 27\.1 or later$/);
    }
    assert.deepEqual([...calls('build'), ...calls('run'), ...calls('create'), ...calls('network')], []);
    fs.rmSync(path.join(fakeDir, 'engine-version'));
    // The first release that has it, a later one, and a version that is no number: none is refused for its version.
    for (const fine of ['27.1.0', '27.1.1-rc.1', '28.0.4', '100.0.0', 'dev']) {
      const said = child({ FAKE_ENGINE: fine }, `
        fs.mkdirSync(process.env.FAKE_DOCKER_DIR, { recursive: true });
        fs.writeFileSync(process.env.FAKE_DOCKER_DIR + '/engine-version', process.env.FAKE_ENGINE);
        const c = createContainers({ imageDir: ${JSON.stringify(imageDir)} });
        await c.ensureImage();
        console.log(JSON.stringify(c.dockerState().state));`);
      assert.equal(said, 'ready', fine);
    }
  });

  await check('the image is built once, reports that it is building, and a failed build is a failed state with docker\'s last line', async () => {
    fs.writeFileSync(path.join(fakeDir, 'fail-build'), 'ERROR: failed to solve: process "/bin/sh -c apt-get update" did not complete successfully: exit code: 100\n');
    await assert.rejects(containers.ensureImage(), /the image did not build: ERROR: failed to solve/);
    assert.equal(containers.dockerState().state, 'failed');
    assert.match(containers.dockerState().detail, /apt-get update/);

    fs.writeFileSync(path.join(fakeDir, 'hold-build'), '');
    const building = Promise.all([containers.ensureImage(), containers.ensureImage()]);
    await until('the build shows', () => containers.dockerState().state === 'building');
    assert.equal(containers.dockerState().image, imageTag(imageDir));
    fs.rmSync(path.join(fakeDir, 'hold-build'));
    const [tag, same] = await building;
    assert.equal(tag, imageTag(imageDir));
    assert.equal(same, tag);
    assert.deepEqual(containers.dockerState(), { state: 'ready', image: tag, detail: '' });
    assert.equal(await containers.ensureImage(), tag);
    assert.equal(calls('build').length, 2, 'the failed one and the one that worked: never again for the same tag');
    assert.deepEqual(calls('build').at(-1), ['build', '--progress', 'plain', '--label', `dn.base=${BASE}`, '-t', tag, imageDir]);
  });

  await check('without a broker listening no container is made: it would have no way out', async () => {
    await assert.rejects(containers.acquire({ pool: { id: 'github.com/o/r' }, peer: PEER_A, runId: 'early' }), /^OwnFault: the broker is not listening, and a container has no other way out$/);
    assert.deepEqual([...calls('run'), ...calls('create'), ...calls('network').filter((c) => c[1] !== 'inspect')], []);
  });

  await broker.start();
  const alpha = makeRepo('dn-test', 'alpha');
  const beta = makeRepo('dn-test', 'beta');

  let first;
  await check('a job runs the agent in a clone of the repository, as the requester, behind the broker, holding no credential', async () => {
    const kept = await hold(PEER_A, alpha);
    first = await launch(`${R}-1`, PEER_A, alpha);
    const outcome = await first.outcome;
    assert.deepEqual(outcome, { ok: true, summary: `did ${R}-1`, usd: 0.25, tokens: 4340, model: 'claude-big', runner: 'claude', exit: 0, state: 'finished' });

    const dir = path.join(RUNS_DIR, '.containers', first.container.name, `${R}-1`);
    assert.equal(first.started.dir, dir);
    assert.equal(first.started.log, path.join(dir, 'log.jsonl'));
    assert.equal(fs.realpathSync(path.join(RUNS_DIR, `${R}-1`)), fs.realpathSync(dir), 'runs/<run id> leads to it');
    assert.deepEqual(fs.readdirSync(path.join(RUNS_DIR, '.staging')), [], 'nothing is left where it was put together');
    assert.equal(fs.readFileSync(path.join(dir, 'done'), 'utf8'), '0\n');
    assert.equal(fs.statSync(path.join(dir, 'env.sh')).mode & 0o777, 0o600);
    // The outcome is kept for a later daemon, beside the run directories and not in one.
    assert.deepEqual(readOutcome(`${R}-1`), outcome);
    assert.equal(fs.statSync(path.join(RUNS_DIR, `${R}-1.outcome.json`)).mode & 0o777, 0o600);
    assert.deepEqual(fs.readdirSync(dir).filter((f) => f.includes('outcome')), []);
    assert.equal(readOutcome(`${R}-none`), null);
    // An id is never a path into what a container writes.
    fs.writeFileSync(path.join(dir, 'planted.outcome.json'), '{"ok":true,"summary":"forged"}');
    assert.equal(readOutcome(`${R}-1/planted`), null);
    fs.rmSync(path.join(dir, 'planted.outcome.json'));

    assert.deepEqual(agent(`${R}-1`, 'args').trim().split('\n'), ['-p', '--dangerously-skip-permissions', '--output-format', 'stream-json', '--verbose']);
    const [head, name, email, origin] = agent(`${R}-1`, 'git').split('\n');
    assert.equal(head, alpha.main, 'the default branch when the task names no base');
    assert.equal(name, 'Requester Name');
    assert.equal(email, 'requester@example.com');
    assert.equal(origin, 'https://github.com/dn-test/alpha.git');
    const root = path.join(fakeDir, 'roots', first.container.name);
    assert.equal(agent(`${R}-1`, 'cwd').trim(), path.join(fs.realpathSync(path.join(fakeDir, 'volumes')), first.container.name.replace('dn-', 'dn-work-'), 'jobs', `${R}-1`, 'repo'));

    const env = Object.fromEntries(agent(`${R}-1`, 'env').split('\n').filter((l) => l.includes('=')).map((l) => l.split(/=(.*)/s).slice(0, 2)));
    for (const k of ['HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy']) assert.equal(env[k], first.proxy.proxyUrl, k);
    assert.equal(env.NO_PROXY, 'localhost,127.0.0.1');
    assert.equal(env.NODE_USE_ENV_PROXY, '1');
    for (const k of ['SSL_CERT_FILE', 'GIT_SSL_CAINFO', 'NODE_EXTRA_CA_CERTS', 'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE']) assert.equal(env[k], path.join(root, 'etc/ssl/certs/ca-certificates.crt'), k);
    assert.ok(fs.readFileSync(env.SSL_CERT_FILE, 'utf8').includes(fs.readFileSync(first.proxy.caCertPath, 'utf8').trim()), 'the broker\'s CA is in the bundle');
    assert.equal(env.GH_TOKEN, 'dn-placeholder');
    assert.equal(env.GITLAB_TOKEN, 'dn-placeholder');
    assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, 'dn-placeholder');
    assert.equal(env.IS_SANDBOX, '1');
    assert.equal(env.GIT_TERMINAL_PROMPT, '0');
    assert.equal(env.DN_RUN_ID, `${R}-1`);
    assert.equal(fs.existsSync(path.join(root, 'work', 'jobs', `${R}-1`)), false, 'the work tree is gone when the job is');
    assert.deepEqual(fs.readdirSync(path.join(root, 'work')), ['jobs'], 'and the container keeps no copy of the repository for the next one');
    assert.equal(forgeSeen.length, 0, 'the clone never went to the requester');
    await kept();
  });

  await check('the prompt is the container preamble, a rule, and the requester\'s words', () => {
    const prompt = agent(`${R}-1`, 'prompt');
    assert.equal(prompt, fs.readFileSync(path.join(RUNS_DIR, `${R}-1`, 'prompt.txt'), 'utf8'));
    assert.ok(prompt.endsWith('\n\n---\n\nReview the pull request.\n'));
    assert.doesNotMatch(prompt, /\{\{/, 'every blank is filled');
    for (const said of ['https://github.com/dn-test/alpha.git', '`pr:7`', 'apt-get update && apt-get install -y', 'GNU', '403', '`gh`', 'git fetch origin pull/<n>/head',
      'Requester Name <requester@example.com>', 'No simulator, emulator or device is offered',
      // What is true of the forge here, and no more: https on 443 only, links to other hosts followed.
      '`github.com` is reached over https on port 443 and no other way: there is no ssh to it', 'that host is reached like any other site',
      // A head branch in the requester's own fork: fetched from origin, pushed by URL.
      '`refs/pull/<N>/head`, on GitLab `refs/merge-requests/<N>/head`', 'the fork itself cannot be fetched from here',
      '`git push https://github.com/<account>/<fork>.git HEAD:refs/heads/<head branch>`', '`gh pr create --draft --head <account>:<branch>`',
      'a merge request on the fork\'s project with this repository\'s project as the target']) assert.ok(prompt.includes(said), said);
    const lab = renderPrompt({ pool: { id: 'gitlab.example.org/g/r', forge: 'gitlab', host: 'gitlab.example.org', owner: 'g', repo: 'r' }, spec: { ...SPEC, item: '' },
      forwards: [{ name: 'adb' }] });
    for (const said of ['https://gitlab.example.org/g/r.git', '`glab`', 'merge-requests/<n>/head', 'the repository as a whole', 'forwarded from the host and already in your environment: adb',
      '`git push https://gitlab.example.org/<account>/<fork>.git HEAD:refs/heads/<head branch>`']) assert.ok(lab.includes(said), said);
    // What adb is good for through the host's filter is said to a job that has it, and
    // to no other.
    const ADB = '`adb devices` lists what is attached to the host, and a device is named by its serial (`adb -s <serial>` or `ANDROID_SERIAL`). `adb connect`, `forward`, `reverse`, `pair` and `kill-server` are refused by the host: do not retry them.';
    assert.ok(lab.includes(`already in your environment: adb. ${ADB}\n`));
    const other = renderPrompt({ pool: { id: 'github.com/g/r', forge: 'github', host: 'github.com', owner: 'g', repo: 'r' }, spec: SPEC, forwards: [{ name: 'alloc' }] });
    assert.ok(other.includes('already in your environment: alloc.\n') && !other.includes('adb devices'));
  });

  await check('a forward reaches a job as the variable its tool reads, and leads through the broker to its target', async () => {
    const echo = net.createServer((c) => c.on('data', (d) => c.write(`echo:${d}`)).on('error', () => {}));
    await new Promise((r) => echo.listen(0, '127.0.0.1', r));
    // Another job keeps the container up, so nothing here ends because the container did.
    const holder = await launch(`${R}-h`, PEER_A, alpha, { prompt: 'MODE=sleep' });
    const job = await launch(`${R}-f`, PEER_A, alpha, { prompt: 'MODE=forward' }, { echo: echo.address().port, adb: echo.address().port });
    assert.equal((await job.outcome).ok, true);
    assert.equal(agent(`${R}-f`, 'forward'), 'echo:ping');
    const env = agent(`${R}-f`, 'env');
    const at = /^DN_FORWARD_ECHO=(127\.0\.0\.1:\d+)$/m.exec(env);
    assert.ok(at, 'a listener inside the container, not an address of the host');
    assert.notEqual(at[1], `127.0.0.1:${echo.address().port}`);
    assert.match(env, /^ADB_SERVER_SOCKET=tcp:127\.0\.0\.1:\d+$/m);
    assert.match(agent(`${R}-f`, 'prompt'), /forwarded from the host and already in your environment: echo, adb\./);
    assert.doesNotMatch(agent(`${R}-1`, 'env'), /DN_FORWARD|ADB_SERVER_SOCKET/, 'a job given none has none');
    await until('the listener is gone with its job', () => new Promise((resolve) => {
      const c = net.connect(Number(at[1].split(':')[1]), '127.0.0.1');
      c.on('connect', () => { c.destroy(); resolve(false); });
      c.on('error', () => resolve(true));
    }));
    // A forward the broker does not have for this job is a connection that closes, not the broker's refusal fed to the tool.
    const ghost = await launch(`${R}-g`, PEER_A, alpha, { prompt: 'MODE=forward' }, {}, [{ name: 'echo' }]);
    assert.equal((await ghost.outcome).ok, true);
    assert.equal(agent(`${R}-g`, 'forward'), '');
    await stopJob(holder.run, containers);
    await holder.outcome;
    echo.close();
  });

  await check('the container is created locked down: six capabilities, no new privileges, limits on processes, memory, CPU and disk, its own volume and run records, nothing of the host\'s', () => {
    const [run] = calls('run');
    const name = containerName(alpha.pool.id, PEER_A);
    assert.equal(first.container.name, name);
    assert.deepEqual(run, ['run', '-d', '--init', '--name', name,
      '--label', 'dn.pool=github.com/dn-test/alpha', '--label', `dn.peer=${PEER_A}`, '--label', `dn.base=${BASE}`,
      '--cap-drop=ALL', '--cap-add=CHOWN', '--cap-add=DAC_OVERRIDE', '--cap-add=FOWNER', '--cap-add=FSETID', '--cap-add=SETGID', '--cap-add=SETUID',
      '--security-opt', 'no-new-privileges', '--pids-limit', '4096', '--memory', '8g', '--memory-swap', '8g', '--cpus', '4',
      '--storage-opt', `size=${16 * 2 ** 20}`,
      '--network', name,
      '-v', `${volumeOf(name)}:/work`, '-v', `${path.join(RUNS_DIR, '.containers', name)}:/dn/runs`,
      imageTag(imageDir), '/usr/bin/sleep', 'infinity']);
    const all = calls().flat().join(' ');
    assert.doesNotMatch(all, /docker\.sock|--privileged|\.ssh|--(network|net|pid|ipc|uts|userns|cgroupns)[ =]host|--volumes-from|--device|-p \d|--publish/);
    // One for each container this pair has had so far, each made with it.
    assert.deepEqual(calls('volume').filter((c) => c[1] === 'create'), Array(calls('run').length).fill(['volume', 'create', ...labels(alpha.pool, PEER_A), volumeOf(name)]));
  });

  await check('every limit is the operator\'s to set, and unset it is 4096 processes, 8g of memory, 4 CPUs and 20 GiB of disk', () => {
    const run = (env) => child(env, `
      const c = createContainers({ imageDir: ${JSON.stringify(imageDir)}, broker: () => ({ port: 1 }) });
      await c.acquire({ pool: { id: 'github.com/o/r' }, peer: 'pk', runId: 'r' });
      const run = calls().find((a) => a[0] === 'run');
      const at = (flag) => run[run.indexOf(flag) + 1];
      console.log(JSON.stringify({ pids: at('--pids-limit'), memory: at('--memory'), swap: at('--memory-swap'), cpus: at('--cpus'), disk: at('--storage-opt'), quota: paths.CONTAINER_DISK_BYTES }));`);
    const unset = Object.fromEntries(['DN_CONTAINER_PIDS', 'DN_CONTAINER_MEMORY', 'DN_CONTAINER_CPUS', 'DN_CONTAINER_DISK_BYTES'].map((k) => [k, '']));
    assert.deepEqual(run(unset), { pids: '4096', memory: '8g', swap: '8g', cpus: '4', disk: `size=${20 * 2 ** 30}`, quota: 20 * 2 ** 30 });
    assert.deepEqual(run({ DN_CONTAINER_PIDS: '512', DN_CONTAINER_MEMORY: '2g', DN_CONTAINER_CPUS: '1.5', DN_CONTAINER_DISK_BYTES: '5000000000' }),
      { pids: '512', memory: '2g', swap: '2g', cpus: '1.5', disk: 'size=5000000000', quota: 5000000000 });
  });

  await check('its one network is its own: internal, with no address of this machine on it, and the only other thing there is a relay that leads to the broker\'s port', () => {
    const name = containerName(alpha.pool.id, PEER_A);
    const port = String(broker.address().port);
    const made = calls().filter((c) => ['network', 'create', 'start', 'run'].includes(c[0]) && c[1] !== 'inspect' && c.some((a) => a === name || a === `${name}-relay`)).slice(0, 5);
    const subnet = made[0][7];
    assert.match(subnet, /^10\.213\.\d+\.\d+\/29$/);
    assert.deepEqual(made.slice(0, 4), [
      ['network', 'create', '--internal', '--ipv6=false', '-o', 'com.docker.network.bridge.gateway_mode_ipv4=isolated', '--subnet', subnet, ...labels(alpha.pool, PEER_A), name],
      ['create', '--name', `${name}-relay`, '--label', `dn.relay=${name}`, '--label', `dn.broker=host.docker.internal:${port}`, ...labels(alpha.pool, PEER_A),
        '--cap-drop=ALL', '--security-opt', 'no-new-privileges', '--read-only', '--user', '65534:65534', '--pids-limit', '64', '--memory', '256m', '--memory-swap', '256m', '--cpus', '1',
        '--network', name, '--network-alias', '127.0.0.1', '--add-host', 'host.docker.internal:host-gateway',
        imageTag(imageDir), 'node', '/opt/dn/relay.mjs', subnet, port, 'host.docker.internal', port],
      ['network', 'connect', 'bridge', `${name}-relay`],
      ['start', `${name}-relay`],
    ]);
    assert.equal(made[4][0], 'run', 'and only then the container');
    // No container but a relay is ever put on a second network, and that one is the default bridge.
    for (const c of calls('network').filter((x) => x[1] === 'connect')) assert.match(c.slice(2).join(' '), /^bridge dn-[0-9a-z]{25}-[0-9a-z]{25}-relay$/);
    for (const c of calls('run')) assert.equal(c.filter((a) => a === '--network').length, 1);
    // A relay holds no volume and no directory of this machine: nothing a job writes is in it.
    for (const c of calls('create')) assert.ok(!c.includes('-v') && !c.includes('--mount') && !c.includes('--volumes-from'), c.join(' '));
  });

  await check('the same peer on the same repository gets a container of the same name, made anew once the last job has left the one before: nothing an earlier job wrote is in it', async () => {
    const name = first.container.name;
    const runs = calls('run').length;
    // What a job can leave for the next: a file in the volume, one in the container's
    // own layer, and one among the run records beside its own.
    const leaver = await launch(`${R}-2`, PEER_A, alpha, { prompt: 'MODE=leave', base: 'pull/7/head' });
    assert.equal(leaver.container.name, name);
    assert.equal((await leaver.outcome).ok, true);
    const [head, , , , alternates] = agent(`${R}-2`, 'git').split('\n');
    assert.equal(head, alpha.pr, 'the pull request head, fetched from the mirror');
    assert.equal(alternates, '', 'it borrows from nothing in the container');
    for (const gone of [['containers', `${name}.json`], ['containers', `${name}-relay.json`], ['networks', `${name}.json`], ['volumes', volumeOf(name)], ['roots', name]]) {
      assert.equal(fs.existsSync(path.join(fakeDir, ...gone)), false, `${gone.join('/')} went with its last job`);
    }
    assert.deepEqual(containers.list(), []);
    const next = await launch(`${R}-2b`, PEER_A, alpha, { prompt: 'MODE=sleep' });
    await until('the agent runs', () => fs.existsSync(path.join(agentDir, `${R}-2b.started`)));
    assert.equal(next.container.name, name);
    assert.equal(calls('run').length, runs + 2, 'a container for each of the two');
    assert.equal(fs.existsSync(path.join(fakeDir, 'volumes', volumeOf(name), 'left-by-a-job')), false, 'the volume is a new one');
    assert.equal(fs.existsSync(path.join(fakeDir, 'roots', name, 'left-by-a-job')), false, 'and so is the container\'s own file system');
    assert.deepEqual(fs.readdirSync(path.join(fakeDir, 'roots', name, 'dn/runs')), [`${R}-2b`], 'and among the run records it is shown there is its own job\'s directory alone');
    assert.match(fs.readFileSync(path.join(RUNS_DIR, `${R}-2`, 'log.jsonl'), 'utf8'), /did run-\d+-2/, 'while the earlier job\'s are where the operator reads them');
    await stopJob(next.run, containers);
    await next.outcome;
  });

  await check('another peer on the same repository, and the same peer on another repository, each get a container of their own', async () => {
    const [runs, relays] = [calls('run').length, calls('create').length];
    const kept = await hold(PEER_A, alpha);
    const otherPeer = await launch(`${R}-3`, PEER_B, alpha, { prompt: 'MODE=sleep' });
    const otherPool = await launch(`${R}-4`, PEER_A, beta, { prompt: 'MODE=sleep' });
    const names = new Set([first.container.name, otherPeer.container.name, otherPool.container.name]);
    assert.equal(names.size, 3);
    assert.equal(calls('run').length, runs + 3);
    assert.deepEqual(containers.list().map((c) => c.name).sort(), [...names].sort());
    // Each is shown its own run records and no one else's.
    const shown = (c) => c[c.findIndex((a) => a.endsWith(':/dn/runs'))];
    assert.deepEqual(calls('run').slice(runs).map(shown).sort(), [...names].sort().map((name) => `${path.join(RUNS_DIR, '.containers', name)}:/dn/runs`));
    for (const [name, mine] of [[otherPeer.container.name, [`${R}-3`]], [otherPool.container.name, [`${R}-4`]]]) {
      assert.deepEqual(fs.readdirSync(path.join(fakeDir, 'roots', name, 'dn', 'runs')), mine);
    }
    // And each is on a network of its own, which is what keeps one peer's container from another's.
    const networks = calls('run').slice(runs).map((c) => c[c.indexOf('--network') + 1]);
    assert.deepEqual(networks.sort(), [...names].sort());
    assert.deepEqual(calls('create').slice(relays).map((c) => [c[c.indexOf('--name') + 1], c[c.indexOf('--network') + 1]]).sort(), [...names].sort().map((n) => [`${n}-relay`, n]));
    await until('both agents run', () => [`${R}-3`, `${R}-4`].every((r) => fs.existsSync(path.join(agentDir, `${r}.started`))));
    assert.equal(agent(`${R}-4`, 'git').split('\n')[3], 'https://github.com/dn-test/beta.git');
    for (const job of [otherPeer, otherPool]) {
      await stopJob(job.run, containers);
      await job.outcome;
    }
    await kept();
    assert.deepEqual(containers.list(), [], 'and each is gone with its last job');
  });

  await check('two jobs run at once in one container, and stopping one leaves the other to finish', async () => {
    fs.writeFileSync(path.join(RUNS_DIR, `${R}-5.outcome.json`), '{"ok":true,"summary":"an earlier run of that name"}');
    const stays = await launch(`${R}-5`, PEER_A, alpha, { prompt: 'MODE=sleep' });
    assert.equal(readOutcome(`${R}-5`), null, 'a run that is running has no outcome yet');
    const goes = await launch(`${R}-6`, PEER_A, alpha, { prompt: 'MODE=sleep' });
    assert.equal(stays.container.name, goes.container.name);
    await until('both agents run', () => fs.existsSync(path.join(agentDir, `${R}-5.started`)) && fs.existsSync(path.join(agentDir, `${R}-6.started`)));
    assert.deepEqual(containers.list().find((c) => c.name === stays.container.name).jobs.sort(), [`${R}-5`, `${R}-6`]);
    const [staysPid, goesPid] = [stays.started.pid, goes.started.pid];
    assert.ok(pidAlive(staysPid) && pidAlive(goesPid));

    const stopped = await stopJob(goes.run, containers);
    assert.deepEqual(stopped, { ok: false, summary: 'stopped', usd: 0, tokens: 0, model: '', runner: 'claude', exit: null, state: 'stopped' });
    assert.equal(await goes.outcome, stopped);
    assert.deepEqual(readOutcome(`${R}-6`), stopped);
    // A killed process is gone when the kernel gets to it, which is soon and not at once.
    await until('its runner is dead', () => !pidAlive(goesPid));
    await until('and so is everything it started', () => { try { process.kill(-goesPid, 0); return false; } catch { return true; } });
    assert.equal(pidAlive(staysPid), true, 'the other job was not touched');
    process.kill(-staysPid, 0);
    assert.equal(fs.existsSync(path.join(fakeDir, 'roots', stays.container.name, 'work', 'jobs', `${R}-6`)), false);
    assert.equal(fs.existsSync(path.join(fakeDir, 'roots', stays.container.name, 'work', 'jobs', `${R}-5`, 'repo', 'README')), true);
    assert.equal(await stopJob(goes.run, containers), null, 'stopping what has ended is nothing');
    const [removals, restarts] = [calls('rm').length, calls('restart').length];
    await containers.release({ name: goes.container.name, runId: `${R}-6` });
    assert.deepEqual([calls('rm').length, calls('restart').length], [removals, restarts], 'the container is neither removed nor restarted under the job still in it');

    // The survivor ends on its own terms: here, by being stopped later.
    assert.equal((await stopJob(stays.run, containers)).state, 'stopped');
    await until('the survivor is dead too', () => !pidAlive(staysPid));
    await stays.outcome;
    assert.deepEqual(calls('rm').slice(removals), [['rm', '-f', stays.container.name], ['rm', '-f', `${stays.container.name}-relay`]], 'with its last job gone the container is removed: nothing a job started or wrote outlives it');
    assert.equal(calls('restart').length, restarts);
  });

  await check('an agent that reports an error, one that dies without a word, and a task that cannot start are failures that say why', async () => {
    const refused = await (await launch(`${R}-7`, PEER_A, alpha, { prompt: 'MODE=refused' })).outcome;
    assert.deepEqual(refused, { ok: false, summary: 'the model refused', usd: 0.01, tokens: 6, model: '', runner: 'claude', exit: 1, state: 'failed' });
    const crashed = await (await launch(`${R}-8`, PEER_A, alpha, { prompt: 'MODE=crash' })).outcome;
    assert.deepEqual(crashed, { ok: false, summary: 'the agent left no result: boom: the agent fell over', usd: 0, tokens: 0, model: '', runner: 'claude', exit: 3, state: 'failed' });
    const noBase = await (await launch(`${R}-9`, PEER_A, alpha, { base: 'no-such-branch' })).outcome;
    assert.equal(noBase.ok, false);
    assert.equal(noBase.exit, 70);
    assert.match(noBase.summary, /^the agent left no result: .*dn: the base revision no-such-branch is not in the repository$/s);
    assert.equal(fs.existsSync(path.join(agentDir, `${R}-9.prompt`)), false, 'the agent was never started');
  });

  await check('a job whose process vanishes without a done file is a failure, never a success', async () => {
    const vanished = await launch(`${R}-10`, PEER_A, alpha, { prompt: 'MODE=vanish' });
    const outcome = await vanished.outcome;
    assert.equal(fs.existsSync(path.join(RUNS_DIR, `${R}-10`, 'done')), false);
    assert.equal(outcome.ok, false);
    assert.equal(outcome.state, 'failed');
    assert.equal(outcome.exit, null);
    assert.match(outcome.summary, /disappeared without finishing/);
    assert.deepEqual(readOutcome(`${R}-10`), outcome);
  });

  await check('a container removed under a running job fails that job, and the next one gets a new container', async () => {
    const doomed = await launch(`${R}-11`, PEER_B, alpha, { prompt: 'MODE=sleep' });
    await until('the agent runs', () => fs.existsSync(path.join(agentDir, `${R}-11.started`)));
    execFileSync(FAKE, ['rm', '-f', doomed.container.name]);
    const outcome = await doomed.outcome;
    assert.equal(outcome.ok, false);
    assert.equal(outcome.state, 'failed');
    // Processes killed together do not die at one instant: the runner may outlive the
    // agent long enough to record its death, and that is as much a failure as no record.
    assert.match(outcome.summary, /disappeared without finishing|left no result/);
    const runs = calls('run').length;
    const next = await launch(`${R}-12`, PEER_B, alpha);
    assert.equal((await next.outcome).ok, true);
    assert.equal(calls('run').length, runs + 1);

    // While a job is still counted in the lost container, no other job is started beside it.
    const held = await containers.acquire({ pool: alpha.pool, peer: PEER_B, runId: 'held' });
    execFileSync(FAKE, ['rm', '-f', held.name]);
    await assert.rejects(containers.acquire({ pool: alpha.pool, peer: PEER_B, runId: 'beside' }), /^Error: container \S+ is gone with 1 job\(s\) in it$/);
    await containers.release({ name: held.name, runId: 'held' });
    assert.equal((await containers.acquire({ pool: alpha.pool, peer: PEER_B, runId: 'after' })).name, held.name);
    await containers.release({ name: held.name, runId: 'after' });
  });

  await check('what a job leaves in its run directory is read as a plain file there or not at all', async () => {
    // A file elsewhere on this machine that says the job succeeded, and a link to it
    // where the job's own log should be.
    fs.mkdirSync(path.join(agentDir, 'planted'));
    fs.writeFileSync(path.join(agentDir, 'planted', 'log.jsonl'), '{"type":"result","subtype":"success","is_error":false,"result":"contents of a file on the host","total_cost_usd":1}\n');
    fs.writeFileSync(path.join(agentDir, 'planted', 'done'), '0\n');
    const linked = await (await launch(`${R}-13`, PEER_A, alpha, { prompt: 'MODE=link' })).outcome;
    assert.deepEqual(linked, { ok: false, summary: 'the agent left no result', usd: 0, tokens: 0, model: '', runner: 'claude', exit: 0, state: 'failed' });
    // The same with the whole directory swapped for a link: not even its `done` counts.
    const swapped = await (await launch(`${R}-13b`, PEER_A, alpha, { prompt: 'MODE=swap' })).outcome;
    assert.equal(swapped.ok, false);
    assert.equal(swapped.exit, null);
    assert.doesNotMatch(JSON.stringify(swapped), /contents of a file on the host/);
    assert.match(swapped.summary, /disappeared without finishing/);
  });

  await check('a commit made in a job is authored as the requester', async () => {
    const job = await launch(`${R}-14`, PEER_A, alpha, { prompt: 'MODE=commit' });
    assert.equal((await job.outcome).ok, true);
    assert.equal(agent(`${R}-14`, 'author').trim(), 'Requester Name <requester@example.com>');
  });

  await check('a run id that is not one, and a run started twice, are refused before anything is written', async () => {
    const container = await containers.acquire({ pool: alpha.pool, peer: PEER_A, runId: 'x' });
    const proxy = { proxyUrl: 'http://dn:t@127.0.0.1:1', caCertPath: first.proxy.caCertPath };
    for (const bad of ['../escape', 'a b', '', 'x'.repeat(65), 'a/b']) {
      await assert.rejects(startJob({ run: { runId: bad, pool: alpha.pool }, container, spec: SPEC, proxy }), /not a run id/);
    }
    assert.equal(fs.existsSync(path.join(RUNS_DIR, 'escape')), false);
    // Something the container put where a run's directory is to go that the host cannot
    // clear away (here: what this user may not empty; root may empty anything). The run
    // does not start, and its files, its token among them, are not left lying about.
    if (process.getuid() !== 0) {
      fs.mkdirSync(path.join(container.runsDir, 'taken', 'x', 'y'), { recursive: true });
      fs.chmodSync(path.join(container.runsDir, 'taken', 'x'), 0o000);
      try {
        await assert.rejects(startJob({ run: { runId: 'taken', pool: alpha.pool }, container, spec: SPEC, proxy }), /the run directory could not be put in place/);
      } finally { fs.chmodSync(path.join(container.runsDir, 'taken', 'x'), 0o700); }
    }
    assert.deepEqual(fs.readdirSync(path.join(RUNS_DIR, '.staging')), []);
    const live = await launch(`${R}-15`, PEER_A, alpha, { prompt: 'MODE=sleep' });
    await assert.rejects(startJob({ run: live.run, container, spec: SPEC, proxy }), /already started/);
    await stopJob(live.run, containers);
    containers.release({ name: container.name, runId: 'x' });
    await assert.rejects(watch({ runId: 'never-started' }), /is not running/);
  });

  await check('a container lasts as long as a job is in it and no longer: no sweep takes it from under a job, however long that runs, and with its last job everything of it goes at once', async () => {
    const name = first.container.name;
    const busy = await launch(`${R}-16`, PEER_A, alpha, { prompt: 'MODE=sleep' });
    await until('the agent runs', () => fs.existsSync(path.join(agentDir, `${R}-16.started`)));
    const before = calls('rm').length;
    clock.now += 10 * 3600 * 1000;
    await containers.sweep();
    assert.equal(calls('rm').length, before, 'not the one with a job in it');
    await stopJob(busy.run, containers);
    await busy.outcome;
    assert.deepEqual(calls('rm').slice(before), [['rm', '-f', name], ['rm', '-f', `${name}-relay`]]);
    assert.deepEqual(calls().slice(-2), [['network', 'rm', name], ['volume', 'rm', '-f', volumeOf(name)]]);
    for (const kind of ['containers', 'networks', 'volumes', 'roots']) assert.deepEqual(fs.readdirSync(path.join(fakeDir, kind)), [], kind);
    assert.deepEqual(containers.list(), []);
    // And nothing is left for a sweep to find.
    const acted = calls().filter((c) => c.includes('rm')).length;
    await containers.sweep();
    assert.equal(calls().filter((c) => c.includes('rm')).length, acted);
  });

  await check('a job joins the jobs in its pair\'s container in the image they were started in; with no job in it the next container is of the image as it is then, and so is its relay', async () => {
    const before = await launch(`${R}-17`, PEER_A, alpha, { prompt: 'MODE=sleep' });
    await until('the agent runs', () => fs.existsSync(path.join(agentDir, `${R}-17.started`)));
    const oldTag = before.container.image;
    fs.appendFileSync(path.join(imageDir, 'Dockerfile'), 'RUN true\n');
    const newTag = imageTag(imageDir);
    assert.notEqual(newTag, oldTag);

    const runs = calls('run').length;
    const joined = await launch(`${R}-18`, PEER_A, alpha);
    assert.equal(joined.container.image, oldTag, 'with a job running, the newcomer joins it in the old image');
    assert.equal((await joined.outcome).ok, true);
    assert.equal(calls('run').length, runs);
    assert.equal(fs.existsSync(path.join(agentDir, `${R}-17.started`)), true);
    assert.ok(pidAlive(before.started.pid), 'and the running job was not disturbed');

    await stopJob(before.run, containers);
    await before.outcome;
    const after = await launch(`${R}-19`, PEER_A, alpha);
    assert.equal(after.container.image, newTag);
    assert.equal((await after.outcome).ok, true);
    assert.equal(calls('run').length, runs + 1);
    assert.equal(calls('run').at(-1).at(-3), newTag);
    assert.equal(calls('create').at(-1).at(-7), newTag);
  });

  await check('what an earlier daemon left under a pair\'s name is removed before that pair\'s job starts - container, relay, network and volume - and made anew; what is another daemon\'s is never touched', async () => {
    const tag = await containers.ensureImage();
    // Left behind by this base's previous daemon, for a pair this one has not seen: a
    // container a job wrote in, and a relay of an image that is no longer the one.
    const mine = containerName(beta.pool.id, PEER_B);
    leave(mine, beta.pool, PEER_B, tag);
    execFileSync(FAKE, ['create', '--name', `${mine}-relay`, '--label', `dn.relay=${mine}`, ...labels(beta.pool, PEER_B), '--network', mine, tag, 'node', '/opt/dn/relay.mjs']);
    fs.writeFileSync(path.join(fakeDir, 'volumes', volumeOf(mine), 'left-by-a-job'), 'x');
    fs.writeFileSync(path.join(fakeDir, 'roots', mine, 'left-by-a-job'), 'x');
    fs.appendFileSync(path.join(imageDir, 'Dockerfile'), 'RUN true\n');
    const [restarts, runs, from] = [calls('restart').length, calls('run').length, calls().length];
    const held = await containers.acquire({ pool: beta.pool, peer: PEER_B, runId: 'adopter' });
    assert.equal(held.name, mine);
    assert.deepEqual(calls().slice(from).filter((c) => c.includes('rm')), [['rm', '-f', mine], ['rm', '-f', `${mine}-relay`], ['network', 'rm', mine], ['volume', 'rm', '-f', volumeOf(mine)]]);
    assert.deepEqual([calls('restart').length, calls('run').length], [restarts, runs + 1], 'it is made again, not restarted');
    assert.deepEqual([calls('run').at(-1).at(-3), calls('create').at(-1)[2], calls('create').at(-1).at(-7)], [imageTag(imageDir), `${mine}-relay`, imageTag(imageDir)], 'of the image as it is, and its relay too');
    for (const left of [['volumes', volumeOf(mine)], ['roots', mine]]) assert.equal(fs.existsSync(path.join(fakeDir, ...left, 'left-by-a-job')), false, left[0]);
    await containers.release({ name: mine, runId: 'adopter' });
    assert.equal((await (await launch(`${R}-20`, PEER_B, beta)).outcome).ok, true);

    // One that is not on a network of its own is no container of this kind: it is made again.
    const loosePool = { ...beta.pool, id: 'github.com/dn-test/loose' };
    const loose = containerName(loosePool.id, PEER_A);
    leave(loose, loosePool, PEER_A, tag, { network: false, mounts: false });
    const before = calls('run').length;
    await containers.acquire({ pool: loosePool, peer: PEER_A, runId: 'l' });
    assert.equal(calls('run').length, before + 1);
    assert.equal(calls('run').at(-1)[calls('run').at(-1).indexOf('--network') + 1], loose);
    await containers.release({ name: loose, runId: 'l' });

    // The same name under another daemon's base.
    const pool = { ...beta.pool, id: 'github.com/dn-test/foreign' };
    const theirs = containerName(pool.id, PEER_A);
    execFileSync(FAKE, ['run', '-d', '--name', theirs, '--label', 'dn.base=/somewhere/else', tag, 'sleep', 'infinity']);
    const rms = calls('rm').length;
    await assert.rejects(containers.acquire({ pool, peer: PEER_A, runId: 'r' }), /^OwnFault: the container dn-\S+ belongs to another daemon on this machine \(\/somewhere\/else\)$/);
    clock.now += 100 * 3600 * 1000;
    await containers.sweep();
    assert.ok(!calls('rm').slice(rms).some((c) => c.at(-1) === theirs));
    assert.ok(calls('ps').every((c) => c.includes(`label=dn.base=${BASE}`)), 'every listing is of this daemon\'s own');
    execFileSync(FAKE, ['rm', '-f', theirs]);
    // And the same for a network of that name, with a relay and a volume.
    const takenPool = { ...beta.pool, id: 'github.com/dn-test/taken' };
    const taken = containerName(takenPool.id, PEER_A);
    const theirLabel = ['--label', 'dn.base=/somewhere/else'];
    execFileSync(FAKE, ['network', 'create', ...theirLabel, taken]);
    execFileSync(FAKE, ['run', '-d', '--name', `${taken}-relay`, ...theirLabel, tag, 'sleep', 'infinity']);
    execFileSync(FAKE, ['volume', 'create', ...theirLabel, volumeOf(taken)]);
    const theirOwn = () => [['networks', `${taken}.json`], ['containers', `${taken}-relay.json`], ['volumes', `${volumeOf(taken)}.labels`]].map((f) => fs.existsSync(path.join(fakeDir, ...f)));
    await assert.rejects(containers.acquire({ pool: takenPool, peer: PEER_A, runId: 'r' }), /^OwnFault: the network dn-\S+ belongs to another daemon on this machine \(\/somewhere\/else\)$/);
    assert.deepEqual(theirOwn(), [true, true, true], 'which are left as they were');
    // Nor is anything of that name removed when this daemon clears the name: a sweep, a discard.
    clock.now += 100 * 3600 * 1000;
    await containers.sweep();
    await containers.discard(taken);
    assert.deepEqual(theirOwn(), [true, true, true]);
    execFileSync(FAKE, ['rm', '-f', `${taken}-relay`]);
    execFileSync(FAKE, ['network', 'rm', taken]);
    execFileSync(FAKE, ['volume', 'rm', '-f', volumeOf(taken)]);
  });

  await check('a name does not make a container a pair\'s own: one labelled for another peer or another repository is refused, with its relay, network and volume, and left as it is', async () => {
    const tag = await containers.ensureImage();
    const refusals = () => logged.filter((l) => l.includes('it is left as it is and not used')).length;
    const acted = () => calls().filter((c) => ['run', 'create', 'rm', 'restart', 'exec', 'start'].includes(c[0]) || (['network', 'volume'].includes(c[0]) && c[1] !== 'inspect')).length;
    // What a second peer whose key hashed to the same name would meet: the first peer's container.
    const pool = { ...beta.pool, id: 'github.com/dn-test/shared', repo: 'shared' };
    const name = containerName(pool.id, PEER_B);
    leave(name, pool, PEER_A, tag);
    fs.writeFileSync(path.join(fakeDir, 'volumes', volumeOf(name), 'secret-of-peer-a'), 'x');
    const before = { acted: acted(), said: refusals() };
    const reason = new RegExp(`^OwnFault: the container ${name} is labelled for ${PEER_A} on github\\.com/dn-test/shared, not for ${PEER_B} on github\\.com/dn-test/shared: it is left as it is and not used$`);
    await assert.rejects(containers.acquire({ pool, peer: PEER_B, runId: 'intruder' }), reason);
    assert.equal(await containers.adopt({ pool, peer: PEER_B, runId: 'intruder' }), null, 'nor taken up as a job\'s container after a restart');
    assert.equal(acted(), before.acted, 'nothing was made, started, restarted or removed');
    assert.equal(refusals(), before.said + 2, 'and each refusal is in the log');
    assert.deepEqual(containers.list().filter((c) => c.name === name), []);
    // The same name, the right peer, another repository.
    execFileSync(FAKE, ['rm', '-f', name]);
    execFileSync(FAKE, ['run', '-d', '--name', name, ...labels({ id: 'github.com/dn-test/elsewhere' }, PEER_B), '--network', name, tag, 'sleep', 'infinity']);
    await assert.rejects(containers.acquire({ pool, peer: PEER_B, runId: 'intruder' }), /is labelled for pkB+ on github\.com\/dn-test\/elsewhere, not for pkB+ on github\.com\/dn-test\/shared/);
    // One of this daemon's base with no word of whose it is.
    execFileSync(FAKE, ['rm', '-f', name]);
    execFileSync(FAKE, ['run', '-d', '--name', name, '--label', `dn.base=${BASE}`, '--network', name, tag, 'sleep', 'infinity']);
    await assert.rejects(containers.acquire({ pool, peer: PEER_B, runId: 'intruder' }), /is labelled for no peer on no repository, not for pkB+ on/);
    execFileSync(FAKE, ['rm', '-f', name]);

    // With the container gone, each thing left under the name is asked whose it is before it is used.
    const runs = calls('run').length;
    await assert.rejects(containers.acquire({ pool, peer: PEER_B, runId: 'intruder' }), new RegExp(`^OwnFault: the network ${name} is labelled for ${PEER_A} on `));
    execFileSync(FAKE, ['network', 'rm', name]);
    execFileSync(FAKE, ['network', 'create', '--internal', '-o', 'com.docker.network.bridge.gateway_mode_ipv4=isolated', ...labels(pool, PEER_B), name]);
    execFileSync(FAKE, ['create', '--name', `${name}-relay`, '--label', `dn.relay=${name}`, ...labels(pool, PEER_A), '--network', name, tag, 'node', '/opt/dn/relay.mjs']);
    await assert.rejects(containers.acquire({ pool, peer: PEER_B, runId: 'intruder' }), new RegExp(`^OwnFault: the relay ${name}-relay is labelled for ${PEER_A} on `));
    execFileSync(FAKE, ['rm', '-f', `${name}-relay`]);
    await assert.rejects(containers.acquire({ pool, peer: PEER_B, runId: 'intruder' }), new RegExp(`^OwnFault: the volume ${volumeOf(name)} is labelled for ${PEER_A} on `));
    assert.equal(calls('run').length, runs, 'no container was started on the first peer\'s volume');
    assert.ok(fs.existsSync(path.join(fakeDir, 'volumes', volumeOf(name), 'secret-of-peer-a')), 'which is as it was');
    assert.ok(fs.existsSync(path.join(fakeDir, 'networks', `${name}.json`)), 'and so is the network that was the pair\'s own: nothing is removed beside what is not');
    execFileSync(FAKE, ['network', 'rm', name]);

    // Everything under this daemon's base is this daemon's to remove: the sweep takes what the pair could not use, and then the pair has a container.
    await containers.sweep();
    assert.ok(!fs.existsSync(path.join(fakeDir, 'volumes', volumeOf(name))), 'a volume with no container goes at the sweep');
    const held = await containers.acquire({ pool, peer: PEER_B, runId: 'rightful' });
    assert.equal(held.name, name);
    assert.deepEqual(calls('volume').filter((c) => c[1] === 'create').at(-1), ['volume', 'create', ...labels(pool, PEER_B), volumeOf(name)]);
    await containers.release({ name, runId: 'rightful' });
  });

  await check('what another daemon holds under a pair\'s name is not joined, taken up or removed: no job is started beside a job in a container, on a network or behind a relay that is another daemon\'s, none is taken up in one or in a container off its own network, a probe of another daemon\'s keeps its name, and every listing asks for this daemon\'s own', async () => {
    const pool = { ...beta.pool, id: 'github.com/dn-test/guarded' };
    const name = containerName(pool.id, PEER_A);
    const record = (kind, n) => path.join(fakeDir, kind, `${n}.json`);
    const rewrite = (kind, n, change) => {
      const o = JSON.parse(fs.readFileSync(record(kind, n), 'utf8'));
      change(o);
      fs.writeFileSync(record(kind, n), JSON.stringify(o));
    };
    const relabel = (kind, n, base) => rewrite(kind, n, (o) => { o.labels['dn.base'] = base; });
    const onlyAsked = (from) => calls().slice(from).every((c) => c[0] === 'version' || c[1] === 'inspect');
    const held = await containers.acquire({ pool, peer: PEER_A, runId: 'g1' });
    // With a job counted in the pair's container, what stands under one of its names is another daemon's.
    for (const [kind, n, what] of [['containers', name, 'container'], ['networks', name, 'network'], ['containers', `${name}-relay`, 'relay']]) {
      relabel(kind, n, '/somewhere/else');
      const from = calls().length;
      await assert.rejects(containers.acquire({ pool, peer: PEER_A, runId: 'g2' }), (e) => e instanceof OwnFault && e.message === `the ${what} ${n} belongs to another daemon on this machine (/somewhere/else)`);
      assert.ok(onlyAsked(from), 'nothing is made, started or removed');
      relabel(kind, n, BASE);
    }
    assert.deepEqual(containers.list().map((c) => c.jobs), [['g1']]);

    // A daemon after this one, with a job of the one before it to take up.
    const after = createContainers({ log, now: () => clock.now, imageDir, broker: () => broker.address() });
    for (const [change, undo] of [
      [() => relabel('containers', name, '/somewhere/else'), () => relabel('containers', name, BASE)],
      [() => rewrite('containers', name, (o) => { o.networks = ['bridge']; }), () => rewrite('containers', name, (o) => { o.networks = [name]; })],
    ]) {
      change();
      const from = calls().length;
      assert.equal(await after.adopt({ pool, peer: PEER_A, runId: 'g1' }), null);
      assert.ok(onlyAsked(from));
      assert.deepEqual(after.list(), []);
      undo();
    }
    assert.deepEqual(await after.adopt({ pool, peer: PEER_A, runId: 'g1' }), held, 'as it was made, it is taken up');

    // The probe's name, held by a container of another daemon: no measurement, and no removal.
    execFileSync(FAKE, ['run', '-d', '--name', `${name}-probe`, '--label', 'dn.base=/somewhere/else', held.image, 'sleep', 'infinity']);
    const rms = calls('rm').length;
    assert.equal(await containers.usage(name), null);
    assert.deepEqual([calls('rm').length, fs.existsSync(record('containers', `${name}-probe`))], [rms, true]);
    execFileSync(FAKE, ['rm', '-f', `${name}-probe`]);

    await after.sweep();
    const listings = calls().filter((c) => c[0] === 'ps' || c[1] === 'ls');
    assert.deepEqual([...new Set(listings.map((c) => c.slice(0, 2).join(' ')))].sort(), ['image ls', 'network ls', 'ps -a', 'volume ls']);
    assert.ok(listings.every((c) => c.includes(`label=dn.base=${BASE}`)));
    await after.release({ name, runId: 'g1' });
    await containers.release({ name, runId: 'g1' });
  });

  await check('a relay that leads to where an earlier daemon\'s broker listened is made again, and the container it serves is kept', async () => {
    const name = containerName(beta.pool.id, PEER_B);
    // The jobs of the daemon before: counted there, taken up by the one after it.
    const earlier = ['moved', 'same', 'down'];
    for (const runId of earlier) await containers.acquire({ pool: beta.pool, peer: PEER_B, runId });
    const later = createContainers({ log, now: () => clock.now, imageDir, broker: () => ({ host: '127.0.0.1', port: 61234 }) });
    const [runs, creates] = [calls('run').length, calls('create').length];
    await later.adopt({ pool: beta.pool, peer: PEER_B, runId: 'moved' });
    assert.equal(calls('run').length, runs, 'the container stays');
    assert.equal(calls('create').length, creates + 1);
    const relay = calls('create').at(-1);
    assert.equal(relay[2], `${name}-relay`);
    assert.ok(relay.includes('dn.broker=host.docker.internal:61234'));
    assert.deepEqual(relay.slice(-3), ['61234', 'host.docker.internal', '61234']);
    // With the broker where the relay leads, the relay is left alone.
    await later.adopt({ pool: beta.pool, peer: PEER_B, runId: 'same' });
    assert.equal(calls('create').length, creates + 1);
    // One that has stopped is made again, under a container that stays.
    const record = path.join(fakeDir, 'containers', `${name}-relay.json`);
    fs.writeFileSync(record, JSON.stringify({ ...JSON.parse(fs.readFileSync(record, 'utf8')), running: false }));
    await later.adopt({ pool: beta.pool, peer: PEER_B, runId: 'down' });
    assert.deepEqual([calls('create').length, calls('run').length], [creates + 2, runs]);
    assert.deepEqual(calls('start').at(-1), ['start', `${name}-relay`]);
    for (const runId of earlier) await later.release({ name, runId });
    assert.equal(fs.existsSync(path.join(fakeDir, 'containers', `${name}.json`)), false, 'and it goes with the last of the jobs taken up');
    for (const runId of earlier) await containers.release({ name, runId });
  });

  await check('a relay with no container is removed with its network at the next sweep, and so is a volume with none', async () => {
    const tag = await containers.ensureImage();
    const name = containerName(beta.pool.id, PEER_B);
    execFileSync(FAKE, ['network', 'create', '--internal', ...labels(beta.pool, PEER_B), name]);
    execFileSync(FAKE, ['create', '--name', `${name}-relay`, '--label', `dn.relay=${name}`, ...labels(beta.pool, PEER_B), '--network', name, tag, 'node', '/opt/dn/relay.mjs']);
    execFileSync(FAKE, ['volume', 'create', ...labels(alpha.pool, PEER_B), volumeOf(containerName(alpha.pool.id, PEER_B))]);
    await containers.sweep();
    assert.deepEqual(calls('rm').at(-1), ['rm', '-f', `${name}-relay`]);
    assert.equal(fs.existsSync(path.join(fakeDir, 'containers', `${name}-relay.json`)), false);
    assert.equal(fs.existsSync(path.join(fakeDir, 'networks', `${name}.json`)), false);
    assert.deepEqual(fs.readdirSync(path.join(fakeDir, 'volumes')), []);
  });

  await check('a sweep that meets a container on its way leaves that container\'s network and relay alone', async () => {
    const pool = { ...beta.pool, id: 'github.com/dn-test/arriving' };
    const name = containerName(pool.id, PEER_A);
    fs.writeFileSync(path.join(fakeDir, 'hold-run'), '');
    const arriving = containers.acquire({ pool, peer: PEER_A, runId: 'a' });
    await until('its relay is up and the container is not yet', () => calls('start').some((c) => c[1] === `${name}-relay`));
    const listings = calls('network').filter((c) => c[1] === 'ls').length;
    const sweeping = containers.sweep();
    await until('the sweep has seen the network', () => calls('network').filter((c) => c[1] === 'ls').length > listings);
    fs.rmSync(path.join(fakeDir, 'hold-run'));
    await Promise.all([arriving, sweeping]);
    for (const kept of [['containers', `${name}.json`], ['containers', `${name}-relay.json`], ['networks', `${name}.json`]]) assert.equal(fs.existsSync(path.join(fakeDir, ...kept)), true, kept[1]);
    await containers.release({ name, runId: 'a' });
  });

  await check('an engine that puts an address of this machine on a job\'s network, or will not make one without, is refused until it is another engine: nothing is started, the network is not kept, and the state names the Docker it takes', async () => {
    const other = createContainers({ log, now: () => clock.now, imageDir, broker: () => broker.address() });
    const made = () => calls('network').filter((c) => c[1] === 'create').length;
    const networks = () => fs.readdirSync(path.join(fakeDir, 'networks')).sort();
    const acted = () => [calls('run').length, calls('create').length];
    const pool = (n) => ({ ...beta.pool, id: `github.com/dn-test/old-${n}` });
    const [before, was] = [networks(), acted()];
    fs.writeFileSync(path.join(fakeDir, 'old-engine'), '');
    const name = containerName(pool(1).id, PEER_A);
    const carries = `the network ${name} carries an address of this machine \\(10\\.213\\.\\d+\\.1\\)`;
    await assert.rejects(other.acquire({ pool: pool(1), peer: PEER_A, runId: 'o' }),
      new RegExp(`^OwnFault: ${carries}, so a job on it would reach whatever this machine serves: this docker engine does not make an isolated network$`));
    assert.deepEqual(acted(), was);
    assert.deepEqual(networks(), before, 'the network it made is not kept');
    const { state, image, detail } = other.dockerState();
    assert.deepEqual([state, image], ['failed', '']);
    assert.match(detail, new RegExp(`^this docker engine \\(27\\.5\\.1\\) does not make a network without an address of this machine on it, and a job on such a network would reach whatever this machine serves: it takes Docker 27\\.1 or later \\(${carries}\\)$`));

    // It is asked for no other network, even once it would make a good one.
    fs.rmSync(path.join(fakeDir, 'old-engine'));
    const tried = made();
    await assert.rejects(other.acquire({ pool: pool(2), peer: PEER_A, runId: 'o' }), (e) => e instanceof OwnFault && e.message === detail);
    await assert.rejects(other.ensureImage(), (e) => !(e instanceof OwnFault) && e.message === detail);
    assert.equal(made(), tried);
    assert.deepEqual(other.dockerState(), { state: 'failed', image: '', detail });

    // Another engine is tried again.
    fs.writeFileSync(path.join(fakeDir, 'engine-version'), '28.0.4\n');
    const held = await other.acquire({ pool: pool(2), peer: PEER_A, runId: 'o' });
    assert.equal(other.dockerState().state, 'ready');
    await other.release({ name: held.name, runId: 'o' });

    // One that will not take the option at all is the same engine by another answer.
    fs.writeFileSync(path.join(fakeDir, 'no-isolated-gateway'), '');
    const refusal = 'Error response from daemon: invalid gateway mode "isolated" for com.docker.network.bridge.gateway_mode_ipv4';
    await assert.rejects(other.acquire({ pool: pool(3), peer: PEER_A, runId: 'o' }), (e) => e.message === `docker network create: ${refusal}`);
    fs.rmSync(path.join(fakeDir, 'no-isolated-gateway'));
    assert.deepEqual(other.dockerState(), { state: 'failed', image: '', detail: `this docker engine (28.0.4) does not make a network without an address of this machine on it, and a job on such a network would reach whatever this machine serves: it takes Docker 27.1 or later (${refusal})` });
    await assert.rejects(other.ensureImage(), /it takes Docker 27\.1 or later/);
    assert.deepEqual(acted(), [was[0] + 1, was[1] + 1], 'one container and its relay, on the engine that isolated');
    fs.rmSync(path.join(fakeDir, 'engine-version'));
    assert.equal(await other.ensureImage(), imageTag(imageDir));
    assert.equal(other.dockerState().state, 'ready');

    // A job found running on a network with such an address, or on one with a route
    // out, is not taken up there, and that says nothing of today's engine. The pair's
    // next job has all of it made anew.
    const tag = await containers.ensureImage();
    for (const [n, options, refusal] of [
      [4, ['--internal'], /^Error: the network dn-\S+ carries an address of this machine \(\S+\), so a job on it would reach whatever this machine serves$/],
      [5, ['-o', 'com.docker.network.bridge.gateway_mode_ipv4=isolated'], /^Error: the network dn-\S+ is not an internal one: a job on it would have a route out$/],
    ]) {
      const found = containerName(pool(n).id, PEER_A);
      execFileSync(FAKE, ['network', 'create', ...options, ...labels(pool(n), PEER_A), found]);
      execFileSync(FAKE, ['run', '-d', '--name', found, ...labels(pool(n), PEER_A), '--network', found, tag, 'sleep', 'infinity']);
      await assert.rejects(other.adopt({ pool: pool(n), peer: PEER_A, runId: 'o' }), refusal);
      assert.equal(other.dockerState().state, 'ready');
      assert.deepEqual(other.list(), []);
      await other.acquire({ pool: pool(n), peer: PEER_A, runId: 'o' });
      const made = JSON.parse(fs.readFileSync(path.join(fakeDir, 'networks', `${found}.json`), 'utf8'));
      assert.deepEqual([made.internal, made.gateway], [true, undefined]);
      await other.release({ name: found, runId: 'o' });
    }
  });

  await check('an engine whose storage holds no writable layer to a size is asked once: the container is made without, and the next ones are not asked for it', async () => {
    const said = [];
    const other = createContainers({ log: (...a) => said.push(a.join(' ')), now: () => clock.now, imageDir, broker: () => broker.address() });
    const pool = (n) => ({ ...beta.pool, id: `github.com/dn-test/unsized-${n}` });
    fs.writeFileSync(path.join(fakeDir, 'no-storage-opt'), '');
    const [runs, rms] = [calls('run').length, calls('rm').length];
    const one = await other.acquire({ pool: pool(1), peer: PEER_A, runId: 's' });
    const made = calls('run').slice(runs);
    assert.equal(made.length, 2);
    assert.deepEqual(made[0].slice(made[0].indexOf('--storage-opt'), made[0].indexOf('--storage-opt') + 2), ['--storage-opt', `size=${16 * 2 ** 20}`]);
    assert.deepEqual(made[1], made[0].filter((a, i) => a !== '--storage-opt' && made[0][i - 1] !== '--storage-opt'), 'the same container in every other word');
    assert.equal(calls('rm').length, rms, 'a refused container left nothing to remove');
    assert.deepEqual(said.filter((l) => l.includes('writable layer')), ['docker this engine sets no size on a container\'s writable layer (docker: Error response from daemon: --storage-opt is supported only for overlay over xfs with \'pquota\' mount option): disk use is measured instead'], 'in docker\'s own words, not its pointer to its help');
    const two = await other.acquire({ pool: pool(2), peer: PEER_A, runId: 's' });
    assert.equal(calls('run').length, runs + 3);
    assert.ok(!calls('run').at(-1).includes('--storage-opt'));
    // Any other refusal is said as docker said it, once.
    fs.writeFileSync(path.join(fakeDir, 'fail-run'), 'docker: Error response from daemon: no space left on device\n');
    await assert.rejects(other.acquire({ pool: pool(3), peer: PEER_A, runId: 's' }), /^OwnFault: docker run: docker: Error response from daemon: no space left on device$/);
    assert.equal(calls('run').length, runs + 4);
    fs.rmSync(path.join(fakeDir, 'no-storage-opt'));
    for (const c of [one, two]) await other.release({ name: c.name, runId: 's' });
  });

  await check('what a container holds of the disk is its layer, its volume and its run records, every file counted; one past its allowance is named with its jobs, and discarded with all that is its own', async () => {
    const MiB = 2 ** 20;
    const pool = { ...beta.pool, id: 'github.com/dn-test/heavy' };
    const held = await containers.acquire({ pool, peer: PEER_A, runId: 'h1' });
    const name = held.name;
    const root = path.join(fakeDir, 'roots', name);
    const volume = path.join(fakeDir, 'volumes', volumeOf(name));
    // What a file system adds of its own to a file or a directory.
    const slack = 2 ** 17;
    const grew = async (by) => {
      const before = await containers.usage(name);
      by();
      return (await containers.usage(name)) - before;
    };
    const between = (n, least) => assert.ok(n >= least && n < least + slack, `${n} for ${least}`);
    between(await grew(() => fs.writeFileSync(path.join(root, 'layer.bin'), Buffer.alloc(3 * MiB, 1))), 3 * MiB);
    between(await grew(() => {
      fs.mkdirSync(path.join(volume, 'many'));
      for (let i = 0; i < 1000; i++) fs.writeFileSync(path.join(volume, 'many', `f${i}`), '');
    }), 1001 * 4096);
    between(await grew(() => fs.writeFileSync(path.join(held.runsDir, 'records.bin'), Buffer.alloc(2 * MiB, 1))), 2 * MiB + 4096);
    assert.deepEqual(calls('run').at(-1), ['run', '--rm', '--name', `${name}-probe`, '--label', `dn.probe=${name}`, '--label', `dn.base=${BASE}`,
      '--network', 'none', '--read-only', '--cap-drop=ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '64', '--memory', '256m', '--memory-swap', '256m', '--cpus', '1',
      '--cap-add=DAC_READ_SEARCH', '-v', `${volumeOf(name)}:/v:ro`, '-v', `${held.runsDir}:/r:ro`,
      held.image, 'sh', '-c', 'du -sxB1 /v /r 2>/dev/null; du -sx --inodes /v /r 2>/dev/null']);

    // A measurement an earlier one left half done holds the probe's name: it is removed and the measurement made.
    execFileSync(FAKE, ['run', '-d', '--name', `${name}-probe`, '--label', `dn.probe=${name}`, '--label', `dn.base=${BASE}`, held.image, 'sleep', 'infinity']);
    assert.ok(await containers.usage(name) > 5 * MiB);
    assert.ok(!fs.existsSync(path.join(fakeDir, 'containers', `${name}-probe.json`)));
    // One the engine cannot make is no number at all.
    fs.writeFileSync(path.join(fakeDir, 'fail-run'), 'docker: Error response from daemon: no space left on device\n');
    assert.equal(await containers.usage(name), null);
    // Nothing is said of what is not this daemon's, and nothing is run to find out.
    const theirs = 'dn-somebody-elses';
    execFileSync(FAKE, ['run', '-d', '--name', theirs, '--label', 'dn.base=/somewhere/else', held.image, 'sleep', 'infinity']);
    const probes = calls('run').length;
    for (const none of [theirs, 'dn-nobody-at-all', `${name}-relay`, '--help']) assert.equal(await containers.usage(none), null, none);
    assert.equal(calls('run').length, probes);

    assert.deepEqual(await containers.overQuota(), [], 'under its allowance nothing is named');
    fs.writeFileSync(path.join(volume, 'big.bin'), Buffer.alloc(12 * MiB, 1));
    const over = await containers.overQuota();
    assert.deepEqual(over.map((o) => [o.name, o.jobs]), [[name, ['h1']]]);
    assert.ok(over[0].bytes > 16 * MiB && over[0].bytes < 23 * MiB, String(over[0].bytes));

    // As a job leaves them: its records in the container's directory, a link to them among the runs.
    fs.mkdirSync(path.join(held.runsDir, 'h1'));
    fs.symlinkSync(path.join('.containers', name, 'h1'), path.join(RUNS_DIR, 'h1'));
    const others = fs.readdirSync(RUNS_DIR).filter((n) => n !== 'h1').sort();
    await assert.rejects(containers.discard(name), (e) => e.message === `container ${name} still has 1 job(s) in it`);
    assert.ok(fs.existsSync(path.join(fakeDir, 'containers', `${name}.json`)) && fs.existsSync(path.join(volume, 'big.bin')));
    await containers.release({ name, runId: 'h1' });
    await containers.discard(name);
    for (const gone of [['containers', `${name}.json`], ['containers', `${name}-relay.json`], ['networks', `${name}.json`], ['volumes', volumeOf(name)], ['volumes', `${volumeOf(name)}.labels`]]) {
      assert.equal(fs.existsSync(path.join(fakeDir, ...gone)), false, gone[1]);
    }
    assert.equal(fs.existsSync(held.runsDir), false, 'its run records');
    assert.deepEqual(fs.readdirSync(RUNS_DIR).sort(), others, 'and the links to them, and no other run\'s');
    assert.deepEqual(containers.list().filter((c) => c.name === name), []);
    assert.deepEqual(await containers.overQuota(), []);
    assert.ok(fs.existsSync(path.join(fakeDir, 'containers', `${theirs}.json`)));
    for (const bad of ['../x', theirs.toUpperCase(), `${name}-relay`, `${name}-probe`, '']) await assert.rejects(containers.discard(bad), /^Error: not a container's name: /);
    await assert.rejects(containers.discard(theirs), /^Error: the container dn-somebody-elses belongs to another daemon on this machine \(\/somewhere\/else\)$/);
    execFileSync(FAKE, ['rm', '-f', theirs]);

    // Records this user may not delete (root's, in a bind mount on Linux) are emptied through the engine.
    const again = await containers.acquire({ pool, peer: PEER_A, runId: 'h2' });
    fs.mkdirSync(path.join(again.runsDir, 'h2'));
    fs.writeFileSync(path.join(again.runsDir, 'h2', 'log.jsonl'), 'x');
    await containers.release({ name, runId: 'h2' });
    const realRm = fs.promises.rm;
    let denied = 0;
    fs.promises.rm = (target, options) => (target === again.runsDir && denied++ === 0
      ? Promise.reject(Object.assign(new Error(`EACCES: permission denied, unlink '${target}/h2/log.jsonl'`), { code: 'EACCES' }))
      : realRm(target, options));
    try { await containers.discard(name); } finally { fs.promises.rm = realRm; }
    assert.equal(denied, 2);
    assert.deepEqual(calls('run').at(-1), ['run', '--rm', '--name', `${name}-probe`, '--label', `dn.probe=${name}`, '--label', `dn.base=${BASE}`,
      '--network', 'none', '--read-only', '--cap-drop=ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '64', '--memory', '256m', '--memory-swap', '256m', '--cpus', '1',
      '--cap-add=DAC_OVERRIDE', '--cap-add=FOWNER', '-v', `${again.runsDir}:/r`, again.image, 'find', '/r', '-mindepth', '1', '-delete']);
    assert.equal(fs.existsSync(again.runsDir), false);
  });

  await check('a run\'s directory comes into its container\'s sight whole and at once: nothing is made or written among the container\'s run records but by one rename from outside them', async () => {
    const run = { runId: 'run-50', pool: alpha.pool };
    const container = await containers.acquire({ pool: alpha.pool, peer: PEER_A, runId: run.runId });
    const proxy = await broker.addJob({ ...run, peer: PEER_A });
    const records = path.join(RUNS_DIR, '.containers');
    const under = (dir, p) => typeof p === 'string' && `${path.resolve(p)}${path.sep}`.startsWith(`${dir}${path.sep}`);
    // Every way this process has of making or writing a file, by the argument that names what is made.
    const makers = { writeFile: 0, appendFile: 0, mkdir: 0, mkdtemp: 0, truncate: 0, open: 0, copyFile: 1, cp: 1, symlink: 1, link: 1, rename: 1 };
    const events = [];
    const real = [];
    for (const [base, at] of Object.entries(makers)) {
      for (const [holder, fn] of [[fs, base], [fs, `${base}Sync`], [fs.promises, base]]) {
        const was = holder[fn];
        real.push([holder, fn, was]);
        holder[fn] = function wrapped(...args) {
          const reads = base === 'open' && (args[1] === undefined || args[1] === 'r' || args[1] === fs.constants.O_RDONLY || args[1] === (fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW));
          if (under(container.runsDir, args[at]) && !reads) {
            events.push(base === 'rename'
              ? { fn, from: args[0], to: args[1], there: fs.existsSync(args[1]), holds: fs.readdirSync(args[0]).sort(), secret: fs.statSync(path.join(args[0], 'env.sh')).mode & 0o777 }
              : { fn, to: args[at] });
          }
          return was.apply(this, args);
        };
      }
    }
    try {
      await startJob({ run, container, spec: SPEC, proxy, env: { CLAUDE_CODE_OAUTH_TOKEN: 'dn-placeholder' } });
    } finally { for (const [holder, fn, was] of real) holder[fn] = was; }
    assert.equal(events.length, 1, JSON.stringify(events));
    const [{ fn, from, to, there, holds, secret }] = events;
    assert.deepEqual([fn, to, there], ['renameSync', path.join(container.runsDir, run.runId), false]);
    assert.ok(!under(records, from), `${from} is where no container looks`);
    assert.deepEqual(holds, ['ca.crt', 'env.sh', 'forward.mjs', 'prompt.txt', 'run.sh'], 'and it is whole before it is seen, with nothing the host runs to stop the job in it');
    assert.equal(secret, 0o600);
    assert.equal((await watch(run)).ok, true);
    broker.removeJob(run.runId);
    await containers.release({ name: container.name, runId: run.runId });
  });

  await check('a subnet another network has is passed over for the next one, and any other refusal is said as docker said it', async () => {
    const made = () => calls('network').filter((c) => c[1] === 'create');
    const before = made().length;
    fs.writeFileSync(path.join(fakeDir, 'fail-network-create'), 'Error response from daemon: invalid pool request: Pool overlaps with other one on this address space\n');
    const pool = { ...beta.pool, id: 'github.com/dn-test/crowded' };
    const held = await containers.acquire({ pool, peer: PEER_A, runId: 'c' });
    const tried = made().slice(before).map((c) => c[7]);
    assert.equal(tried.length, 2);
    assert.notEqual(tried[0], tried[1]);
    await containers.release({ name: held.name, runId: 'c' });
    fs.writeFileSync(path.join(fakeDir, 'fail-network-create'), 'Error response from daemon: operation not permitted\n');
    await assert.rejects(containers.acquire({ pool: { ...beta.pool, id: 'github.com/dn-test/denied' }, peer: PEER_A, runId: 'd' }), /^OwnFault: docker network create: Error response from daemon: operation not permitted$/);
    assert.equal(made().length, before + 3, 'tried once');
  });

  await check('a stray container this daemon never used is removed once it has been seen idle for the full time, and so is one named the way an earlier daemon named them, with its relay, network and volume', async () => {
    const tag = await containers.ensureImage();
    const stray = containerName('github.com/dn-test/stray', PEER_A);
    execFileSync(FAKE, ['run', '-d', '--name', stray, '--label', `dn.base=${BASE}`, tag, 'sleep', 'infinity']);
    // Sixteen hex digits for the pool and for the peer, and nothing on it but whose it is.
    const old = 'dn-0f1e2d3c4b5a6978-8796a5b4c3d2e1f0';
    const own = ['--label', `dn.base=${BASE}`];
    execFileSync(FAKE, ['network', 'create', ...own, old]);
    execFileSync(FAKE, ['volume', 'create', ...own, volumeOf(old)]);
    for (const name of [old, `${old}-relay`]) execFileSync(FAKE, ['run', '-d', '--name', name, ...own, '--network', old, tag, 'sleep', 'infinity']);
    const gone = (kind, name) => calls(kind).some((c) => (kind === 'rm' || c[1] === 'rm') && c.at(-1) === name);
    const left = () => [gone('rm', stray), gone('rm', old), gone('rm', `${old}-relay`), gone('network', old), gone('volume', volumeOf(old))];
    await containers.sweep();
    assert.deepEqual(left(), Array(5).fill(false), 'first seen is not yet idle');
    clock.now += 3601 * 1000;
    await containers.sweep();
    assert.deepEqual(left(), Array(5).fill(true));
  });

  await check('the directory a container\'s run records were in goes once the container is gone and no run in it is kept, with whatever else a job left there, and no other directory does', async () => {
    const tag = await containers.ensureImage();
    const dir = (name) => path.join(RUNS_DIR, '.containers', name);
    const name = (pool, peer) => `dn-${pool.repeat(25)}-${peer.repeat(25)}`;
    const [empty, full, left, littered] = [name('a', 'b'), name('c', 'd'), name('e', 'f'), name('g', 'h')];
    for (const made of [dir(empty), path.join(dir(full), 'run-x'), path.join(dir(full), 'not-a-run'), dir(left), dir('notes'), dir(`${empty}-relay`), path.join(dir(littered), 'not-a-run', 'deep')]) fs.mkdirSync(made, { recursive: true });
    // A run is kept while the link `startJob` made to it is: of one container's records, one still is.
    fs.symlinkSync(path.join('.containers', full, 'run-x'), path.join(RUNS_DIR, 'run-x'));
    // One an earlier daemon left on the engine and this one has not used.
    execFileSync(FAKE, ['run', '-d', '--name', left, '--label', `dn.base=${BASE}`, tag, 'sleep', 'infinity']);
    // And one made while the sweep is on its way, after it listed the containers: no run
    // is in it yet.
    fs.writeFileSync(path.join(fakeDir, 'hold-network-ls'), '');
    const listed = calls('network').length;
    const sweeping = containers.sweep();
    await until('the sweep past its list of containers', () => calls('network').length > listed);
    const own = await containers.acquire({ pool: { ...beta.pool, id: 'github.com/dn-test/no-run-yet' }, peer: PEER_B, runId: `${R}-60` });
    assert.deepEqual(fs.readdirSync(own.runsDir), []);
    fs.rmSync(path.join(fakeDir, 'hold-network-ls'));
    await sweeping;
    assert.deepEqual([empty, full, left, 'notes', `${empty}-relay`, littered].map((n) => fs.existsSync(dir(n))), [false, true, true, true, true, false]);
    assert.deepEqual(fs.readdirSync(dir(full)).sort(), ['not-a-run', 'run-x'], 'beside a run that is kept nothing is touched');
    assert.equal(fs.existsSync(own.runsDir), true);
    await containers.release({ name: own.name, runId: `${R}-60` });
    // With its last run forgotten the rest goes at the next sweep.
    fs.rmSync(path.join(RUNS_DIR, 'run-x'));
    fs.rmSync(path.join(dir(full), 'run-x'), { recursive: true });
    await containers.sweep();
    assert.deepEqual([full, own.name].map((n) => fs.existsSync(dir(n))), [false, false]);
    execFileSync(FAKE, ['rm', '-f', left]);
    for (const made of [left, 'notes', `${empty}-relay`]) fs.rmSync(dir(made), { recursive: true });
  });

  await check('a stop the engine did not hear has stopped nothing: the engine is looked at until it answers, and the job asked after until it is gone', async () => {
    const job = await launch(`${R}-40`, PEER_A, alpha, { prompt: 'MODE=sleep' });
    await until('the agent runs', () => fs.existsSync(path.join(agentDir, `${R}-40.started`)));
    const { pid } = job.started;
    const asked = () => calls('exec').filter((c) => c[6] === 'stop' && c[7] === `${R}-40`).length;
    const looked = calls('version').length;
    fs.writeFileSync(path.join(fakeDir, 'down'), '');
    let settled = false;
    const stopping = stopJob(job.run, containers).then((outcome) => { settled = true; return outcome; });
    await until('the engine was looked at a second time', () => calls('version').length >= looked + 2);
    assert.equal(asked(), 0, 'and asked nothing else');
    assert.equal(settled, false, 'the run is not called stopped');
    assert.equal(pidAlive(pid), true, 'and it is not');
    assert.equal(readOutcome(`${R}-40`), null);
    fs.rmSync(path.join(fakeDir, 'down'));
    assert.equal((await stopping).state, 'stopped');
    await until('its runner is dead', () => !pidAlive(pid));
    await job.outcome;
  });

  await check('a job stopped while it was being asked after ends as stopped: the answer that it is gone came of the stop', async () => {
    const job = await launch(`${R}-44`, PEER_A, alpha, { prompt: 'MODE=sleep' });
    await until('the agent runs', () => fs.existsSync(path.join(agentDir, `${R}-44.started`)));
    const asked = () => calls('exec').filter((c) => c[6] === 'up' && c[7] === `${R}-44`).length;
    // The engine holds its answers: whether the job is up is being asked when the stop
    // begins, and is answered once the job was killed.
    fs.writeFileSync(path.join(fakeDir, 'hold-exec'), '');
    const before = asked();
    await until('the job is asked after', () => asked() > before);
    const stopping = stopJob(job.run, containers);
    process.kill(-job.started.pid, 'SIGKILL');
    await until('its runner is dead', () => !pidAlive(job.started.pid));
    fs.rmSync(path.join(fakeDir, 'hold-exec'));
    assert.equal((await stopping).state, 'stopped');
    assert.equal((await job.outcome).summary, 'stopped');
  });

  await check('a job an earlier daemon started is taken up where it stands: nothing is restarted, it is watched to its end, and it can be stopped', async () => {
    // Started and never watched: the daemon that started them is gone.
    const startOnly = async (runId, prompt) => {
      const run = { runId, pool: alpha.pool };
      const container = await containers.acquire({ pool: alpha.pool, peer: PEER_A, runId });
      const proxy = await broker.addJob({ ...run, peer: PEER_A });
      const started = await startJob({ run, container, spec: { ...SPEC, prompt }, proxy, env: { CLAUDE_CODE_OAUTH_TOKEN: 'dn-placeholder' } });
      return { container, pid: started.pid };
    };
    const { container, pid } = await startOnly(`${R}-41`, 'MODE=sleep');
    const short = await startOnly(`${R}-42`, 'Review.');
    await until('the long one runs', () => fs.existsSync(path.join(agentDir, `${R}-41.started`)));
    await until('the short one ended with nobody watching', () => fs.existsSync(path.join(RUNS_DIR, `${R}-42`, 'done')));

    const fresh = createContainers({ log, now: () => clock.now, imageDir, broker: () => broker.address() });
    const [restarts, creates] = [calls('restart').length, calls('create').length];
    const taken = await fresh.adopt({ pool: alpha.pool, peer: PEER_A, runId: `${R}-41` });
    assert.deepEqual(taken, container);
    assert.deepEqual(await fresh.adopt({ pool: alpha.pool, peer: PEER_A, runId: `${R}-42` }), container);
    assert.deepEqual(fresh.list().map((c) => [c.name, c.jobs.sort()]), [[container.name, [`${R}-41`, `${R}-42`]]]);
    // Its next job joins the one still running in it.
    await fresh.acquire({ pool: alpha.pool, peer: PEER_A, runId: `${R}-43` });
    assert.deepEqual([calls('restart').length, calls('create').length], [restarts, creates], 'the container and its relay are used as they stand');
    assert.equal(pidAlive(pid), true);
    assert.equal(await fresh.adopt({ pool: { ...alpha.pool, id: 'github.com/dn-test/never-made' }, peer: PEER_A, runId: 'x' }), null, 'a container that is not there is nobody\'s');

    assert.equal(later.attachJob({ runId: `${R}-41`, container: taken, pid }), true);
    assert.equal(later.attachJob({ runId: `${R}-42`, container: taken, pid: short.pid }), true);
    assert.equal(later.attachJob({ runId: `${R}-43`, container: taken }), false, 'a run that never came up');
    assert.equal(later.attachJob({ runId: `../${R}-41`, container: taken }), false);
    await assert.rejects(later.watch({ runId: `${R}-43` }), /is not running/);
    const ended = await later.watch({ runId: `${R}-42` });
    assert.deepEqual([ended.ok, ended.state, ended.summary, ended.usd], [true, 'finished', `did ${R}-42`, 0.25]);
    assert.deepEqual(readOutcome(`${R}-42`), ended);
    assert.equal((await later.stopJob({ runId: `${R}-41` }, containers)).state, 'stopped');
    await until('its runner is dead', () => !pidAlive(pid));
    for (const runId of [`${R}-41`, `${R}-42`]) broker.removeJob(runId);
    await fresh.release({ name: container.name, runId: `${R}-41` });
    await fresh.release({ name: container.name, runId: `${R}-42` });
    await fresh.release({ name: container.name, runId: `${R}-43` });
    // The first daemon's own count of the container, which nothing ended.
    for (const runId of [`${R}-41`, `${R}-42`]) await containers.release({ name: container.name, runId });
  });

  await check('a job that left a stop script and another job\'s process group in its run directory, and ignores TERM, is stopped by what the host itself holds, and nothing else is', async () => {
    const other = await launch(`${R}-50`, PEER_A, alpha, { prompt: 'MODE=sleep' });
    const otherPid = other.started.pid;
    const run = { runId: `${R}-51`, pool: alpha.pool };
    const container = await containers.acquire({ pool: alpha.pool, peer: PEER_A, runId: `${R}-51` });
    const started = await startJob({ run, container, spec: { ...SPEC, prompt: `MODE=defy\nGROUP=${otherPid}` }, proxy: await broker.addJob({ ...run, peer: PEER_A }), env: { CLAUDE_CODE_OAUTH_TOKEN: 'dn-placeholder' } });
    await until('both agents run', () => [`${R}-50`, `${R}-51`].every((r) => fs.existsSync(path.join(agentDir, `${r}.started`))));
    assert.deepEqual([Number(fs.readFileSync(path.join(RUNS_DIR, `${R}-51`, 'pid'), 'utf8')), fs.readFileSync(path.join(RUNS_DIR, `${R}-51`, 'stop.sh'), 'utf8')], [otherPid, '#!/bin/sh\nexit 0\n'], 'what the job wrote');
    // The group the host has is the one its own start named, whatever the job wrote since.
    assert.ok(started.pid > 1 && started.pid !== otherPid && pidAlive(started.pid));

    // No job's process group is the one that names every process of the container, or
    // the asking shell's own.
    for (const none of [1, 0, -7, 1.5, '1', 'x']) assert.equal(later.attachJob({ runId: `${R}-51`, container, pid: none }), false, `a group of ${none}`);
    // The daemon after this one knows the job by what this one kept of it.
    assert.equal(later.attachJob({ runId: `${R}-51`, container, pid: started.pid }), true);
    const stopped = await later.stopJob(run, containers);
    assert.equal(stopped.state, 'stopped');
    await until('its runner is dead', () => !pidAlive(started.pid));
    assert.equal(pidAlive(otherPid), true, 'the job whose group it named was not touched');
    assert.deepEqual(calls('exec').filter((c) => c.some((a) => a.includes(`/dn/runs/${R}-51`))).map((c) => c.slice(-2)), [[`/dn/runs/${R}-51/run.sh`, `${R}-51`]],
      'nothing was run from its run directory but the runner, once');
    broker.removeJob(`${R}-51`);
    await containers.release({ name: container.name, runId: `${R}-51` });
    await stopJob(other.run, containers);
    await other.outcome;
  });

  await check('a job nobody kept the process group of is stopped by the run id its processes carry: the group its run directory names is not believed, and the job of that group runs on', async () => {
    const other = await launch(`${R}-52`, PEER_A, alpha, { prompt: 'MODE=sleep' });
    const run = { runId: `${R}-53`, pool: alpha.pool };
    const container = await containers.acquire({ pool: alpha.pool, peer: PEER_A, runId: `${R}-53` });
    const started = await startJob({ run, container, spec: { ...SPEC, prompt: `MODE=defy\nGROUP=${other.started.pid}` }, proxy: await broker.addJob({ ...run, peer: PEER_A }), env: { CLAUDE_CODE_OAUTH_TOKEN: 'dn-placeholder' } });
    await until('both agents run', () => [`${R}-52`, `${R}-53`].every((r) => fs.existsSync(path.join(agentDir, `${r}.started`))));
    assert.equal(Number(fs.readFileSync(path.join(RUNS_DIR, `${R}-53`, 'pid'), 'utf8')), other.started.pid, 'what the job wrote');
    // The runner carries the run's id from the moment it is started, as everything it starts does.
    if (PROC) assert.ok(fs.readFileSync(`/proc/${started.pid}/environ`, 'utf8').split('\0').includes(`DN_RUN_ID=${R}-53`));

    const before = calls('exec').length;
    assert.equal(later.attachJob({ runId: `${R}-53`, container }), true);
    assert.equal((await later.stopJob(run, containers)).state, 'stopped');
    assert.equal(pidAlive(other.started.pid), true, 'the job whose group it named was not touched');
    const asked = calls('exec').slice(before).filter((c) => c.includes(`${R}-53`)).map((c) => c.slice(c.indexOf(`${R}-53`) - 1, c.indexOf(`${R}-53`) + 2));
    assert.ok(asked.length >= 2 && asked.every(([verb, , group]) => ['stop', 'left'].includes(verb) && group === '0'), JSON.stringify(asked));
    if (PROC) await until('its runner is dead', () => !pidAlive(started.pid));
    else process.kill(-started.pid, 'SIGKILL');
    broker.removeJob(`${R}-53`);
    await containers.release({ name: container.name, runId: `${R}-53` });
    await stopJob(other.run, containers);
    await other.outcome;
  });

  await check('a container is restarted in its turn, after what was being done to it, and the answer is whether the engine did; the jobs in it are over with that, and the next job gets a container made anew', async () => {
    const container = await containers.acquire({ pool: alpha.pool, peer: PEER_A, runId: `${R}-60` });
    // An engine that refused restarted nothing, and ended no job: the next one joins them.
    fs.writeFileSync(path.join(fakeDir, 'fail-restart'), 'Error response from daemon: cannot restart container\n');
    assert.equal(await containers.restart(container.name), false);
    const made = calls('run').length;
    await containers.acquire({ pool: alpha.pool, peer: PEER_A, runId: `${R}-59` });
    assert.equal(calls('run').length, made);
    await containers.release({ name: container.name, runId: `${R}-59` });
    const [restarts, inspects] = [calls('restart').length, calls('container').length];
    // A second job is on its way into the container: the engine holds its first answer.
    fs.writeFileSync(path.join(fakeDir, 'hold-container-inspect'), '');
    const joining = containers.acquire({ pool: alpha.pool, peer: PEER_A, runId: `${R}-61` });
    await until('the engine is asked about the container', () => calls('container').length > inspects);
    const restarting = containers.restart(container.name);
    // Time for a restart that waited for nothing to reach the engine.
    for (let i = 0; i < 3; i++) await docker(['version']);
    assert.equal(calls('restart').length, restarts, 'not while the container is being looked at');
    fs.rmSync(path.join(fakeDir, 'hold-container-inspect'));
    await joining;
    assert.equal(await restarting, true);
    assert.deepEqual(calls().at(-1), ['restart', '-t', '0', container.name]);
    // What the jobs it ended wrote is still in it: a job that comes before they are
    // released does not join them there.
    fs.writeFileSync(path.join(fakeDir, 'volumes', volumeOf(container.name), 'left-by-a-job'), 'x');
    const from = calls().length;
    const next = await containers.acquire({ pool: alpha.pool, peer: PEER_A, runId: `${R}-62` });
    assert.equal(next.name, container.name);
    assert.deepEqual(calls().slice(from).filter((c) => c.includes('rm') || c[0] === 'run').map((c) => c.slice(0, 2).join(' ')), ['rm -f', 'rm -f', 'network rm', 'volume rm', 'run -d']);
    assert.equal(fs.existsSync(path.join(fakeDir, 'volumes', volumeOf(container.name), 'left-by-a-job')), false);
    // And their release takes nothing from the job that has it since.
    const removals = calls('rm').length;
    for (const runId of [`${R}-60`, `${R}-61`]) await containers.release({ name: container.name, runId });
    assert.equal(calls('rm').length, removals);
    assert.deepEqual(containers.list().map((c) => [c.name, c.jobs]), [[container.name, [`${R}-62`]]]);
    await containers.release({ name: container.name, runId: `${R}-62` });
    assert.deepEqual(containers.list(), []);
  });

  await check('everything of this daemon on the engine is removed when asked, and nothing of anybody else', async () => {
    const tag = await containers.ensureImage();
    const world = () => ({
      containers: fs.readdirSync(path.join(fakeDir, 'containers')).map((f) => f.replace(/\.json$/, '')).sort(),
      networks: fs.readdirSync(path.join(fakeDir, 'networks')).map((f) => f.replace(/\.json$/, '')).sort(),
      volumes: fs.readdirSync(path.join(fakeDir, 'volumes')).filter((f) => f.endsWith('.labels')).map((f) => f.replace(/\.labels$/, '')).sort(),
    });
    const held = await containers.acquire({ pool: alpha.pool, peer: PEER_B, runId: 'last' });
    // A measurement cut off, and a volume whose container went.
    execFileSync(FAKE, ['run', '-d', '--name', `${held.name}-probe`, '--label', `dn.probe=${held.name}`, '--label', `dn.base=${BASE}`, tag, 'sleep', 'infinity']);
    execFileSync(FAKE, ['volume', 'create', ...labels(beta.pool, PEER_B), 'dn-work-left-behind']);
    const ours = world();
    assert.ok(ours.containers.includes(held.name) && ours.containers.includes(`${held.name}-relay`) && ours.networks.includes(held.name) && ours.volumes.includes(volumeOf(held.name)));
    // Another daemon's under the very names this one uses, and things with no label at all.
    const foreign = ['--label', 'dn.base=/somewhere/else', '--label', `dn.pool=${alpha.pool.id}`, '--label', `dn.peer=${PEER_B}`];
    execFileSync(FAKE, ['network', 'create', ...foreign, 'dn-theirs']);
    execFileSync(FAKE, ['volume', 'create', ...foreign, 'dn-work-theirs']);
    execFileSync(FAKE, ['run', '-d', '--name', 'dn-theirs', ...foreign, '--network', 'dn-theirs', '-v', 'dn-work-theirs:/work', tag, 'sleep', 'infinity']);
    execFileSync(FAKE, ['run', '-d', '--name', 'dn-theirs-relay', ...foreign, '--label', 'dn.relay=dn-theirs', '--network', 'dn-theirs', tag, 'sleep', 'infinity']);
    execFileSync(FAKE, ['network', 'create', 'supabase_network_app']);
    for (const idle of [['dn-theirs-idle', ...foreign], ['somebody_default']]) execFileSync(FAKE, ['network', 'create', ...idle.slice(1), idle[0]]);
    execFileSync(FAKE, ['volume', 'create', 'supabase_db_app']);
    execFileSync(FAKE, ['run', '-d', '--name', 'supabase_db_app', '--network', 'supabase_network_app', '-v', 'supabase_db_app:/var/lib/postgresql', tag, 'sleep', 'infinity']);
    const gone = await containers.removeAll();
    assert.deepEqual({ containers: [...gone.containers].sort(), networks: [...gone.networks].sort(), volumes: [...gone.volumes].sort() }, ours);
    assert.deepEqual(world(), {
      containers: ['dn-theirs', 'dn-theirs-relay', 'supabase_db_app'], networks: ['dn-theirs', 'dn-theirs-idle', 'somebody_default', 'supabase_network_app'], volumes: ['dn-work-theirs', 'supabase_db_app'],
    });
    assert.deepEqual(containers.list(), []);
    assert.deepEqual(await containers.removeAll(), { containers: [], networks: [], volumes: [] });
    // The daemon that goes on after it makes what it needs again.
    const runs = calls('run').length;
    const next = await containers.acquire({ pool: alpha.pool, peer: PEER_B, runId: 'next' });
    assert.equal(calls('run').length, runs + 1);
    await containers.release({ name: next.name, runId: 'next' });
  });

  await check('what the engine would not remove is said, the first of it, with the rest tried all the same; what it would not list ends the asking there', async () => {
    const held = await containers.acquire({ pool: alpha.pool, peer: PEER_B, runId: 'kept' });
    const left = () => [
      fs.existsSync(path.join(fakeDir, 'containers', `${held.name}.json`)), fs.existsSync(path.join(fakeDir, 'networks', `${held.name}.json`)),
      fs.existsSync(path.join(fakeDir, 'volumes', `${volumeOf(held.name)}.labels`)),
    ];
    assert.deepEqual(left(), [true, true, true]);
    fs.writeFileSync(path.join(fakeDir, 'fail-network-rm'), 'Error response from daemon: network has active endpoints\n');
    const refusals = path.join(fakeDir, 'fail-volume-rm');
    fs.writeFileSync(refusals, 'Error response from daemon: volume is in use\nError response from daemon: volume is still in use\n');
    await assert.rejects(containers.removeAll(), { message: `${held.name} could not be removed: Error response from daemon: network has active endpoints` });
    const once = 'Error response from daemon: volume is still in use\n';
    assert.deepEqual([left(), fs.readFileSync(refusals, 'utf8')], [[false, true, true], once], 'the volume was tried, after the network');
    fs.writeFileSync(path.join(fakeDir, 'fail-network-ls'), 'Cannot connect to the Docker daemon\n');
    await assert.rejects(containers.removeAll(), { message: 'the networks could not be listed: Cannot connect to the Docker daemon' });
    assert.deepEqual([left(), fs.readFileSync(refusals, 'utf8')], [[false, true, true], once], 'and nothing is tried after the listing');
    fs.rmSync(refusals);
    assert.deepEqual(await containers.removeAll(), { containers: [], networks: [held.name], volumes: [volumeOf(held.name)] });
  });

  console.log(`\nall ${checks} checks passed`);
} finally {
  await broker.stop().catch(() => {});
  // Whatever a failed check left running.
  for (const f of fs.existsSync(path.join(fakeDir, 'containers')) ? fs.readdirSync(path.join(fakeDir, 'containers')) : []) {
    try { execFileSync(FAKE, ['rm', '-f', f.replace(/\.json$/, '')]); } catch {}
  }
  fs.rmSync(scratch, { recursive: true, force: true });
}
process.exit(0);
