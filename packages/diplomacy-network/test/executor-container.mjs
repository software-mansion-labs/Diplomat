// Containers and jobs against the stand-in docker: one container per peer and
// repository, on a network of its own with a relay as its one way out, many jobs in it,
// each stopped on its own; the image built once per tag; the real runner script cloning
// through the real broker from a real mirror, with a stand-in for the agent.
// Run: node test/executor-container.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
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
  GIT_CONFIG_GLOBAL: path.join(scratch, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1',
});
const { createContainers, containerName, imageTag, IMAGE_DIR } = await import('../src/executor/container.js');
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

  await check('a container is named by its pool and its peer, and by nothing else', () => {
    const name = containerName('github.com/o/r', PEER_A);
    assert.match(name, /^dn-[0-9a-f]{8}-[0-9a-f]{8}$/);
    assert.equal(containerName('github.com/o/r', PEER_A), name);
    const otherPeer = containerName('github.com/o/r', PEER_B);
    const otherPool = containerName('github.com/o/r2', PEER_A);
    assert.equal(otherPeer.slice(0, 11), name.slice(0, 11), 'same pool, same first half');
    assert.notEqual(otherPeer.slice(12), name.slice(12), 'another peer, another second half');
    assert.notEqual(otherPool.slice(0, 11), name.slice(0, 11), 'another pool, another first half');
    assert.equal(otherPool.slice(12), name.slice(12));
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
    assert.deepEqual(calls('build').at(-1), ['build', '--progress', 'plain', '-t', tag, imageDir]);
  });

  await check('without a broker listening no container is made: it would have no way out', async () => {
    await assert.rejects(containers.acquire({ pool: { id: 'github.com/o/r' }, peer: PEER_A, runId: 'early' }), /the broker is not listening, and a container has no other way out/);
    assert.deepEqual([...calls('run'), ...calls('create'), ...calls('network').filter((c) => c[1] !== 'inspect')], []);
  });

  await broker.start();
  const alpha = makeRepo('dn-test', 'alpha');
  const beta = makeRepo('dn-test', 'beta');

  let first;
  await check('a job runs the agent in a clone of the repository, as the requester, behind the broker, holding no credential', async () => {
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
    assert.ok(fs.existsSync(path.join(root, 'work', 'cache.git', 'HEAD')), 'the container keeps its copy of the repository');
    assert.equal(forgeSeen.length, 0, 'the clone never went to the requester');
  });

  await check('the prompt is the container preamble, a rule, and the requester\'s words', () => {
    const prompt = agent(`${R}-1`, 'prompt');
    assert.equal(prompt, fs.readFileSync(path.join(RUNS_DIR, `${R}-1`, 'prompt.txt'), 'utf8'));
    assert.ok(prompt.endsWith('\n\n---\n\nReview the pull request.\n'));
    assert.doesNotMatch(prompt, /\{\{/, 'every blank is filled');
    for (const said of ['https://github.com/dn-test/alpha.git', '`pr:7`', 'apt-get update && apt-get install -y', 'GNU', '403', '`gh`', 'git fetch origin pull/<n>/head',
      'Requester Name <requester@example.com>', 'No simulator, emulator or device is offered']) assert.ok(prompt.includes(said), said);
    const lab = renderPrompt({ pool: { id: 'gitlab.example.org/g/r', forge: 'gitlab', host: 'gitlab.example.org', owner: 'g', repo: 'r' }, spec: { ...SPEC, item: '' },
      forwards: [{ name: 'adb' }] });
    for (const said of ['https://gitlab.example.org/g/r.git', '`glab`', 'merge-requests/<n>/head', 'the repository as a whole', 'forwarded from the host and already in your environment: adb']) assert.ok(lab.includes(said), said);
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
    await stopJob(holder.run);
    await holder.outcome;
    echo.close();
  });

  await check('the container is created locked down: six capabilities, no new privileges, limits, its own volume and run records, nothing of the host\'s', () => {
    const [run] = calls('run');
    const name = containerName(alpha.pool.id, PEER_A);
    assert.equal(first.container.name, name);
    assert.deepEqual(run, ['run', '-d', '--init', '--name', name,
      '--label', 'dn.pool=github.com/dn-test/alpha', '--label', `dn.peer=${PEER_A}`, '--label', `dn.base=${BASE}`,
      '--cap-drop=ALL', '--cap-add=CHOWN', '--cap-add=DAC_OVERRIDE', '--cap-add=FOWNER', '--cap-add=FSETID', '--cap-add=SETGID', '--cap-add=SETUID',
      '--security-opt', 'no-new-privileges', '--pids-limit', '4096', '--memory', '8g', '--cpus', '4',
      '--network', name,
      '-v', `${name.replace('dn-', 'dn-work-')}:/work`, '-v', `${path.join(RUNS_DIR, '.containers', name)}:/dn/runs`,
      imageTag(imageDir), 'sleep', 'infinity']);
    const all = calls().flat().join(' ');
    assert.doesNotMatch(all, /docker\.sock|--privileged|\.ssh|--network[ =]host|--pid[ =]host|-p \d|--publish/);
    assert.deepEqual(calls('volume').filter((c) => c[1] === 'create'), [['volume', 'create', '--label', `dn.base=${BASE}`, name.replace('dn-', 'dn-work-')]]);
  });

  await check('its one network is its own: internal, with no address of this machine on it, and the only other thing there is a relay that leads to the broker\'s port', () => {
    const name = containerName(alpha.pool.id, PEER_A);
    const port = String(broker.address().port);
    const made = calls().filter((c) => ['network', 'create', 'start', 'run'].includes(c[0]) && c[1] !== 'inspect' && c.some((a) => a === name || a === `${name}-relay`)).slice(0, 5);
    const subnet = made[0][7];
    assert.match(subnet, /^10\.213\.\d+\.\d+\/29$/);
    assert.deepEqual(made.slice(0, 4), [
      ['network', 'create', '--internal', '--ipv6=false', '-o', 'com.docker.network.bridge.gateway_mode_ipv4=isolated', '--subnet', subnet, '--label', `dn.base=${BASE}`, name],
      ['create', '--name', `${name}-relay`, '--label', `dn.relay=${name}`, '--label', `dn.broker=host.docker.internal:${port}`, '--label', `dn.base=${BASE}`,
        '--cap-drop=ALL', '--security-opt', 'no-new-privileges', '--read-only', '--user', '65534:65534', '--pids-limit', '64', '--memory', '256m',
        '--network', name, '--network-alias', '127.0.0.1', '--add-host', 'host.docker.internal:host-gateway',
        imageTag(imageDir), 'node', '/opt/dn/relay.mjs', subnet, port, 'host.docker.internal', port],
      ['network', 'connect', 'bridge', `${name}-relay`],
      ['start', `${name}-relay`],
    ]);
    assert.equal(made[4][0], 'run', 'and only then the container');
    // No container but a relay is ever put on a second network, and that one is the default bridge.
    for (const c of calls('network').filter((x) => x[1] === 'connect')) assert.match(c.slice(2).join(' '), /^bridge dn-[0-9a-f]{8}-[0-9a-f]{8}-relay$/);
    for (const c of calls('run')) assert.equal(c.filter((a) => a === '--network').length, 1);
  });

  await check('a relay carries what it is sent to the one address it was started with, whatever a client asks of it', async () => {
    const seen = [];
    const target = net.createServer((c) => c.on('data', (d) => { seen.push(String(d)); c.write('from the broker'); }).on('error', () => {}));
    await new Promise((r) => target.listen(0, '127.0.0.1', r));
    const free = net.createServer();
    await new Promise((r) => free.listen(0, '127.0.0.1', r));
    const port = free.address().port;
    await new Promise((r) => free.close(r));
    const relayFile = path.join(IMAGE_DIR, 'relay.mjs');
    const relay = spawn(process.execPath, [relayFile, '127.0.0.0/8', String(port), '127.0.0.1', String(target.address().port)], { stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      const said = await new Promise((resolve) => relay.stdout.once('data', (d) => resolve(String(d).trim())));
      assert.equal(said, `relay: 127.0.0.1:${port} -> 127.0.0.1:${target.address().port}`, 'it listens on its address in the job network and on no other');
      const asked = 'CONNECT elsewhere.example:443 HTTP/1.1\r\nHost: elsewhere.example:443\r\n\r\n';
      const answer = await new Promise((resolve, reject) => {
        const c = net.connect(port, '127.0.0.1', () => c.write(asked));
        c.on('data', (d) => { resolve(String(d)); c.destroy(); });
        c.on('error', reject);
        c.on('close', () => reject(new Error('the relay closed the connection without an answer')));
        c.setTimeout(60000, () => c.destroy(new Error('the relay gave no answer')));
      });
      assert.equal(answer, 'from the broker');
      assert.deepEqual(seen, [asked], 'word for word, to the broker');
    } finally { relay.kill('SIGKILL'); target.close(); }
    // In a container with no address on the network it was told to serve, it serves nothing.
    const none = spawn(process.execPath, [relayFile, '203.0.113.0/24', String(port), '127.0.0.1', '1'], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    none.stderr.on('data', (d) => { err += d; });
    assert.equal(await new Promise((r) => none.on('close', r)), 1);
    assert.match(err, /no address in 203\.0\.113\.0\/24/);
  });

  await check('the same peer on the same repository gets the same container again; its second clone borrows from the first', async () => {
    const second = await launch(`${R}-2`, PEER_A, alpha, { base: 'pull/7/head' });
    assert.equal(second.container.name, first.container.name);
    assert.equal((await second.outcome).ok, true);
    assert.equal(calls('run').length, 1, 'one container, not two');
    const [head, , , , alternates] = agent(`${R}-2`, 'git').split('\n');
    assert.equal(head, alpha.pr, 'the pull request head, fetched from the mirror');
    assert.match(alternates, /\/cache\.git\/objects$/);
  });

  await check('another peer on the same repository, and the same peer on another repository, each get a container of their own', async () => {
    const otherPeer = await launch(`${R}-3`, PEER_B, alpha);
    const otherPool = await launch(`${R}-4`, PEER_A, beta);
    assert.equal((await otherPeer.outcome).ok, true);
    assert.equal((await otherPool.outcome).ok, true);
    const names = new Set([first.container.name, otherPeer.container.name, otherPool.container.name]);
    assert.equal(names.size, 3);
    assert.equal(calls('run').length, 3);
    assert.deepEqual(containers.list().map((c) => c.name).sort(), [...names].sort());
    // Each sees its own run records and no one else's.
    for (const [name, mine] of [[first.container.name, [`${R}-1`, `${R}-2`, `${R}-f`, `${R}-g`, `${R}-h`]], [otherPeer.container.name, [`${R}-3`]], [otherPool.container.name, [`${R}-4`]]]) {
      assert.deepEqual(fs.readdirSync(path.join(fakeDir, 'roots', name, 'dn', 'runs')).sort(), mine);
    }
    // And each is on a network of its own, which is what keeps one peer's container from another's.
    const networks = calls('run').map((c) => c[c.indexOf('--network') + 1]);
    assert.deepEqual(networks.sort(), [...names].sort());
    assert.deepEqual(calls('create').map((c) => [c[c.indexOf('--name') + 1], c[c.indexOf('--network') + 1]]).sort(), [...names].sort().map((n) => [`${n}-relay`, n]));
    assert.equal(agent(`${R}-4`, 'git').split('\n')[3], 'https://github.com/dn-test/beta.git');
  });

  await check('two jobs run at once in one container, and stopping one leaves the other to finish', async () => {
    fs.writeFileSync(path.join(RUNS_DIR, `${R}-5.outcome.json`), '{"ok":true,"summary":"an earlier run of that name"}');
    const stays = await launch(`${R}-5`, PEER_A, alpha, { prompt: 'MODE=sleep' });
    assert.equal(readOutcome(`${R}-5`), null, 'a run that is running has no outcome yet');
    const goes = await launch(`${R}-6`, PEER_A, alpha, { prompt: 'MODE=sleep' });
    assert.equal(stays.container.name, goes.container.name);
    await until('both agents run', () => fs.existsSync(path.join(agentDir, `${R}-5.started`)) && fs.existsSync(path.join(agentDir, `${R}-6.started`)));
    assert.deepEqual(containers.list().find((c) => c.name === stays.container.name).jobs.sort(), [`${R}-5`, `${R}-6`]);
    const pid = (r) => Number(fs.readFileSync(path.join(RUNS_DIR, r, 'pid'), 'utf8'));
    const [staysPid, goesPid] = [pid(`${R}-5`), pid(`${R}-6`)];
    assert.ok(pidAlive(staysPid) && pidAlive(goesPid));

    const stopped = await stopJob(goes.run);
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
    assert.equal(calls('rm').length, 0, 'the container was never removed');
    assert.equal(await stopJob(goes.run), null, 'stopping what has ended is nothing');
    const restarts = calls('restart').length;
    await containers.release({ name: goes.container.name, runId: `${R}-6` });
    assert.equal(calls('restart').length, restarts, 'nor restarted under the job still in it');

    // The survivor ends on its own terms: here, by being stopped later.
    assert.equal((await stopJob(stays.run)).state, 'stopped');
    await until('the survivor is dead too', () => !pidAlive(staysPid));
    await stays.outcome;
    assert.deepEqual(calls('restart').slice(restarts), [['restart', '-t', '0', stays.container.name]], 'with its last job gone the container is restarted: nothing a job started outlives it');
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
    await assert.rejects(containers.acquire({ pool: alpha.pool, peer: PEER_B, runId: 'beside' }), /is gone with 1 job\(s\) in it/);
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
    // Something the container put where a run's directory is to go, after the host
    // cleared the name (here: the clearing is made to miss it). The run does not start,
    // and its files, its token among them, are not left lying about.
    fs.mkdirSync(path.join(container.runsDir, 'taken', 'x'), { recursive: true });
    const realRm = fs.rmSync;
    fs.rmSync = (p, o) => (p === path.join(container.runsDir, 'taken') ? undefined : realRm(p, o));
    try {
      await assert.rejects(startJob({ run: { runId: 'taken', pool: alpha.pool }, container, spec: SPEC, proxy }), /the run directory could not be put in place/);
    } finally { fs.rmSync = realRm; }
    assert.deepEqual(fs.readdirSync(path.join(RUNS_DIR, '.staging')), []);
    const live = await launch(`${R}-15`, PEER_A, alpha, { prompt: 'MODE=sleep' });
    await assert.rejects(startJob({ run: live.run, container, spec: SPEC, proxy }), /already started/);
    await stopJob(live.run);
    containers.release({ name: container.name, runId: 'x' });
    await assert.rejects(watch({ runId: 'never-started' }), /is not running/);
  });

  await check('a container with a job in it survives any idle time; an idle one is removed with its volume after CONTAINER_IDLE_MS', async () => {
    const name = first.container.name;
    const busy = await launch(`${R}-16`, PEER_A, alpha, { prompt: 'MODE=sleep' });
    await until('the agent runs', () => fs.existsSync(path.join(agentDir, `${R}-16.started`)));
    clock.now += 10 * 3600 * 1000;
    await containers.sweep();
    const gone = calls('rm').map((c) => c.at(-1));
    assert.ok(!gone.includes(name), 'not the one with a job in it');
    const idle = containerName(beta.pool.id, PEER_A);
    assert.ok(gone.includes(idle), 'the idle ones went');
    assert.ok(gone.includes(`${idle}-relay`), 'each with its relay');
    assert.ok(calls('network').some((c) => c[1] === 'rm' && c[2] === idle), 'its network');
    assert.ok(calls('volume').some((c) => c[1] === 'rm' && c.at(-1) === idle.replace('dn-', 'dn-work-')), 'and its volume');
    assert.equal(fs.existsSync(path.join(fakeDir, 'networks', `${idle}.json`)), false);
    assert.equal(fs.existsSync(path.join(fakeDir, 'volumes', name.replace('dn-', 'dn-work-'))), true);
    await stopJob(busy.run);
    await busy.outcome;

    const before = calls('rm').length;
    clock.now += 3599 * 1000;
    await containers.sweep();
    assert.equal(calls('rm').length, before, 'idle time is counted from the end of the last job');
    clock.now += 2000;
    await containers.sweep();
    assert.deepEqual(calls('rm').slice(-2), [['rm', '-f', name], ['rm', '-f', `${name}-relay`]]);
    assert.deepEqual(calls('network').at(-1), ['network', 'rm', name]);
    assert.equal(fs.existsSync(path.join(fakeDir, 'volumes', name.replace('dn-', 'dn-work-'))), false);
    assert.deepEqual(fs.readdirSync(path.join(fakeDir, 'networks')), []);
    assert.deepEqual(containers.list(), []);
  });

  await check('a new image replaces a container only when no job is running in it, and keeps its volume', async () => {
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
    assert.ok(pidAlive(Number(fs.readFileSync(path.join(RUNS_DIR, `${R}-17`, 'pid'), 'utf8'))), 'and the running job was not disturbed');

    await stopJob(before.run);
    await before.outcome;
    const volumeRemovals = calls('volume').filter((c) => c[1] === 'rm').length;
    const after = await launch(`${R}-19`, PEER_A, alpha);
    assert.equal(after.container.image, newTag);
    assert.equal((await after.outcome).ok, true);
    assert.equal(calls('run').length, runs + 1);
    assert.equal(calls('run').at(-1).at(-3), newTag);
    assert.equal(calls('create').at(-1).at(-7), newTag, 'and its relay is of the new image too');
    assert.equal(calls('volume').filter((c) => c[1] === 'rm').length, volumeRemovals, 'the work volume and its cache stay');
    assert.match(agent(`${R}-19`, 'git').split('\n')[4], /cache\.git/);

    // A relay that outlived its container is of the image that container had: it is made again as well.
    fs.appendFileSync(path.join(imageDir, 'Dockerfile'), 'RUN true\n');
    execFileSync(FAKE, ['rm', '-f', after.container.name]);
    const creates = calls('create').length;
    assert.equal((await (await launch(`${R}-20`, PEER_A, alpha)).outcome).ok, true);
    assert.equal(calls('create').length, creates + 1);
    assert.deepEqual(calls('create').at(-1).slice(2, 3).concat(calls('create').at(-1).at(-7)), [`${after.container.name}-relay`, imageTag(imageDir)]);
  });

  await check('a container an earlier daemon left is restarted before it is used, and one of another daemon is never touched', async () => {
    const tag = await containers.ensureImage();
    // Left behind by this base's previous daemon, for a pair this one has not seen.
    const mine = containerName(beta.pool.id, PEER_B);
    const isolated = ['--internal', '-o', 'com.docker.network.bridge.gateway_mode_ipv4=isolated', '--label', `dn.base=${BASE}`];
    execFileSync(FAKE, ['network', 'create', ...isolated, mine]);
    execFileSync(FAKE, ['run', '-d', '--name', mine, '--label', `dn.base=${BASE}`, '--network', mine, '-v', `${mine.replace('dn-', 'dn-work-')}:/work`, '-v', `${path.join(RUNS_DIR, '.containers', mine)}:/dn/runs`, tag, 'sleep', 'infinity']);
    const restarts = calls('restart').length;
    const runs = calls('run').length;
    const held = await containers.acquire({ pool: beta.pool, peer: PEER_B, runId: 'adopter' });
    assert.equal(held.name, mine);
    assert.deepEqual(calls('restart').slice(restarts), [['restart', '-t', '0', mine]]);
    assert.equal(calls('run').length, runs, 'it is used, not made again');
    assert.equal(calls('create').at(-1)[2], `${mine}-relay`, 'and given the relay it lacked');
    await containers.release({ name: mine, runId: 'adopter' });
    assert.equal((await (await launch(`${R}-20`, PEER_B, beta)).outcome).ok, true);

    // One that is not on a network of its own is no container of this kind: it is made again.
    const loosePool = { ...beta.pool, id: 'github.com/dn-test/loose' };
    const loose = containerName(loosePool.id, PEER_A);
    execFileSync(FAKE, ['run', '-d', '--name', loose, '--label', `dn.base=${BASE}`, tag, 'sleep', 'infinity']);
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
    await assert.rejects(containers.acquire({ pool, peer: PEER_A, runId: 'r' }), /belongs to another daemon on this machine \(\/somewhere\/else\)/);
    clock.now += 100 * 3600 * 1000;
    await containers.sweep();
    assert.ok(!calls('rm').slice(rms).some((c) => c.at(-1) === theirs));
    assert.ok(calls('ps').every((c) => c.includes(`label=dn.base=${BASE}`)), 'every listing is of this daemon\'s own');
    execFileSync(FAKE, ['rm', '-f', theirs]);
    // And the same for a network of that name.
    const takenPool = { ...beta.pool, id: 'github.com/dn-test/taken' };
    const taken = containerName(takenPool.id, PEER_A);
    execFileSync(FAKE, ['network', 'create', '--label', 'dn.base=/somewhere/else', taken]);
    await assert.rejects(containers.acquire({ pool: takenPool, peer: PEER_A, runId: 'r' }), /a network named for dn-\S+ belongs to another daemon on this machine \(\/somewhere\/else\)/);
    assert.ok(fs.existsSync(path.join(fakeDir, 'networks', `${taken}.json`)), 'which is left as it was');
    execFileSync(FAKE, ['network', 'rm', taken]);
  });

  await check('a relay that leads to where an earlier daemon\'s broker listened is made again, and the container it serves is kept', async () => {
    const name = containerName(beta.pool.id, PEER_B);
    assert.equal((await (await launch(`${R}-21`, PEER_B, beta)).outcome).ok, true);
    const later = createContainers({ log, now: () => clock.now, imageDir, broker: () => ({ host: '127.0.0.1', port: 61234 }) });
    const [runs, creates] = [calls('run').length, calls('create').length];
    await later.acquire({ pool: beta.pool, peer: PEER_B, runId: 'moved' });
    assert.equal(calls('run').length, runs, 'the container stays');
    assert.equal(calls('create').length, creates + 1);
    const relay = calls('create').at(-1);
    assert.equal(relay[2], `${name}-relay`);
    assert.ok(relay.includes('dn.broker=host.docker.internal:61234'));
    assert.deepEqual(relay.slice(-3), ['61234', 'host.docker.internal', '61234']);
    await later.release({ name, runId: 'moved' });
    // With the broker where the relay leads, the relay is left alone.
    await later.acquire({ pool: beta.pool, peer: PEER_B, runId: 'same' });
    assert.equal(calls('create').length, creates + 1);
    await later.release({ name, runId: 'same' });
    // One that has stopped is made again, under a container that stays.
    const record = path.join(fakeDir, 'containers', `${name}-relay.json`);
    fs.writeFileSync(record, JSON.stringify({ ...JSON.parse(fs.readFileSync(record, 'utf8')), running: false }));
    await later.acquire({ pool: beta.pool, peer: PEER_B, runId: 'down' });
    assert.deepEqual([calls('create').length, calls('run').length], [creates + 2, runs]);
    assert.deepEqual(calls('start').at(-1), ['start', `${name}-relay`]);
    await later.release({ name, runId: 'down' });
  });

  await check('a relay whose container is gone is removed with its network at the next sweep', async () => {
    const name = containerName(beta.pool.id, PEER_B);
    execFileSync(FAKE, ['rm', '-f', name]);
    await containers.sweep();
    assert.deepEqual(calls('rm').at(-1), ['rm', '-f', `${name}-relay`]);
    assert.equal(fs.existsSync(path.join(fakeDir, 'containers', `${name}-relay.json`)), false);
    assert.equal(fs.existsSync(path.join(fakeDir, 'networks', `${name}.json`)), false);
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

  await check('an engine that puts an address of this machine on a job\'s network is refused, and nothing is started on that network', async () => {
    fs.writeFileSync(path.join(fakeDir, 'old-engine'), '');
    const pool = { ...beta.pool, id: 'github.com/dn-test/old' };
    const [runs, creates] = [calls('run').length, calls('create').length];
    await assert.rejects(containers.acquire({ pool, peer: PEER_A, runId: 'o' }), /carries an address of this machine \(10\.213\.\d+\.1\), so a job on it would reach whatever this machine serves: this docker engine does not make an isolated network/);
    assert.deepEqual([calls('run').length, calls('create').length], [runs, creates]);
    fs.rmSync(path.join(fakeDir, 'old-engine'));
    // The network it made for nothing goes at the next sweep, and no other does.
    const left = () => fs.readdirSync(path.join(fakeDir, 'networks')).sort();
    const before = left();
    assert.ok(before.includes(`${containerName(pool.id, PEER_A)}.json`));
    await containers.sweep();
    assert.deepEqual(left(), before.filter((f) => f !== `${containerName(pool.id, PEER_A)}.json`));
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
    await assert.rejects(containers.acquire({ pool: { ...beta.pool, id: 'github.com/dn-test/denied' }, peer: PEER_A, runId: 'd' }), /^Error: docker network create: Error response from daemon: operation not permitted$/);
    assert.equal(made().length, before + 3, 'tried once');
  });

  await check('a stray container this daemon never used is removed once it has been seen idle for the full time', async () => {
    const tag = await containers.ensureImage();
    const stray = containerName('github.com/dn-test/stray', PEER_A);
    execFileSync(FAKE, ['run', '-d', '--name', stray, '--label', `dn.base=${BASE}`, tag, 'sleep', 'infinity']);
    await containers.sweep();
    assert.ok(!calls('rm').some((c) => c.at(-1) === stray), 'first seen is not yet idle');
    clock.now += 3601 * 1000;
    await containers.sweep();
    assert.ok(calls('rm').some((c) => c.at(-1) === stray));
  });

  await check('a stop the engine did not hear has stopped nothing: it is asked again until the job is gone', async () => {
    const job = await launch(`${R}-40`, PEER_A, alpha, { prompt: 'MODE=sleep' });
    await until('the agent runs', () => fs.existsSync(path.join(agentDir, `${R}-40.started`)));
    const pid = Number(fs.readFileSync(path.join(RUNS_DIR, `${R}-40`, 'pid'), 'utf8'));
    const asked = () => calls('exec').filter((c) => c[6] === 'stop' && c[7] === `${R}-40`).length;
    fs.writeFileSync(path.join(fakeDir, 'down'), '');
    let settled = false;
    const stopping = stopJob(job.run).then((outcome) => { settled = true; return outcome; });
    await until('the engine was asked a second time', () => asked() >= 2);
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
    const stopping = stopJob(job.run);
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
      await startJob({ run, container, spec: { ...SPEC, prompt }, proxy, env: { CLAUDE_CODE_OAUTH_TOKEN: 'dn-placeholder' } });
      return container;
    };
    const container = await startOnly(`${R}-41`, 'MODE=sleep');
    await startOnly(`${R}-42`, 'Review.');
    await until('the long one runs', () => fs.existsSync(path.join(agentDir, `${R}-41.started`)));
    await until('the short one ended with nobody watching', () => fs.existsSync(path.join(RUNS_DIR, `${R}-42`, 'done')));
    const pid = Number(fs.readFileSync(path.join(RUNS_DIR, `${R}-41`, 'pid'), 'utf8'));

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

    assert.equal(later.attachJob({ runId: `${R}-41`, container: taken }), true);
    assert.equal(later.attachJob({ runId: `${R}-42`, container: taken }), true);
    assert.equal(later.attachJob({ runId: `${R}-43`, container: taken }), false, 'a run that never came up');
    assert.equal(later.attachJob({ runId: `../${R}-41`, container: taken }), false);
    await assert.rejects(later.watch({ runId: `${R}-43` }), /is not running/);
    const ended = await later.watch({ runId: `${R}-42` });
    assert.deepEqual([ended.ok, ended.state, ended.summary, ended.usd], [true, 'finished', `did ${R}-42`, 0.25]);
    assert.deepEqual(readOutcome(`${R}-42`), ended);
    assert.equal((await later.stopJob({ runId: `${R}-41` })).state, 'stopped');
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
    const pid = (r) => Number(fs.readFileSync(path.join(RUNS_DIR, r, 'pid'), 'utf8'));
    const otherPid = other.started.pid;
    const run = { runId: `${R}-51`, pool: alpha.pool };
    const container = await containers.acquire({ pool: alpha.pool, peer: PEER_A, runId: `${R}-51` });
    const started = await startJob({ run, container, spec: { ...SPEC, prompt: `MODE=defy\nGROUP=${otherPid}` }, proxy: await broker.addJob({ ...run, peer: PEER_A }), env: { CLAUDE_CODE_OAUTH_TOKEN: 'dn-placeholder' } });
    await until('both agents run', () => [`${R}-50`, `${R}-51`].every((r) => fs.existsSync(path.join(agentDir, `${r}.started`))));
    assert.deepEqual([pid(`${R}-50`), pid(`${R}-51`), fs.readFileSync(path.join(RUNS_DIR, `${R}-51`, 'stop.sh'), 'utf8')], [otherPid, otherPid, '#!/bin/sh\nexit 0\n'], 'what the job wrote');
    // The group the host has is the one its own start named, whatever the job wrote since.
    assert.ok(started.pid > 1 && started.pid !== otherPid && pidAlive(started.pid));

    // No job's process group is the one that names every process of the container, or
    // the asking shell's own.
    for (const none of [1, 0, -7, 1.5, '1', 'x']) assert.equal(later.attachJob({ runId: `${R}-51`, container, pid: none }), false, `a group of ${none}`);
    // The daemon after this one knows the job by what this one kept of it.
    assert.equal(later.attachJob({ runId: `${R}-51`, container, pid: started.pid }), true);
    const stopped = await later.stopJob(run);
    assert.equal(stopped.state, 'stopped');
    await until('its runner is dead', () => !pidAlive(started.pid));
    assert.equal(pidAlive(otherPid), true, 'the job whose group it named was not touched');
    assert.deepEqual(calls('exec').filter((c) => c.some((a) => a.includes(`/dn/runs/${R}-51`))).map((c) => c.at(-1)), [`/dn/runs/${R}-51/run.sh`],
      'nothing was run from its run directory but the runner, once');
    broker.removeJob(`${R}-51`);
    await containers.release({ name: container.name, runId: `${R}-51` });
    await stopJob(other.run);
    await other.outcome;
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
