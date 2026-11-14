// Containers and jobs against the stand-in docker: one container per peer and
// repository, many jobs in it, each stopped on its own; the image built once per tag;
// the real runner script cloning through the real broker from a real mirror, with a
// stand-in for the agent.
// Run: node test/executor-container.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'dn-ctr-'));
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
  vanish) echo started > "$out.started"; kill -9 "$PPID" "$$" ;;
  crash) echo "boom: the agent fell over" >&2; exit 3 ;;
  refused) echo '{"type":"result","subtype":"error_during_execution","is_error":true,"result":"the model refused","total_cost_usd":0.01,"usage":{"input_tokens":5,"output_tokens":1}}'; exit 1 ;;
  link) rm -f "$run/log.jsonl"; ln -s "$FAKE_AGENT_DIR/planted/log.jsonl" "$run/log.jsonl"; exit 0 ;;
  swap) sleep 1; mv "$run" "$run.real"; ln -s "$FAKE_AGENT_DIR/planted" "$run"; exit 0 ;;
  commit) echo fix > fix.txt; git add fix.txt; git commit --quiet -m "fix by the agent"; git log -1 --format='%an <%ae>' > "$out.author" ;;
esac
echo '{"type":"assistant","message":{"content":[{"type":"text","text":"working"}]}}'
echo '{"type":"result","subtype":"success","is_error":false,"result":"did '"$DN_RUN_ID"'","total_cost_usd":0.25,"usage":{"input_tokens":1,"output_tokens":1},"modelUsage":{"claude-small":{"inputTokens":1,"outputTokens":2,"cacheReadInputTokens":3,"cacheCreationInputTokens":4,"costUSD":0.05},"claude-big":{"inputTokens":10,"outputTokens":20,"cacheReadInputTokens":300,"cacheCreationInputTokens":4000,"costUSD":0.2}}}'
`, { mode: 0o755 });

const BASE = path.join(scratch, 'base');
Object.assign(process.env, {
  DN_BASE_DIR: BASE, DN_DOCKER: FAKE, FAKE_DOCKER_DIR: fakeDir, FAKE_DOCKER_PATH: binDir, FAKE_AGENT_DIR: agentDir,
  DN_BROKER_BIND: '127.0.0.1', DN_CONTAINER_HOST: '127.0.0.1', DN_IMAGE_REPO: 'dn-test-agent',
  DN_JOB_POLL_MS: '40', DN_JOB_LIVENESS_MS: '250', DN_JOB_STOP_GRACE_MS: '1000', DN_CONTAINER_IDLE_MS: '3600000',
  GIT_CONFIG_GLOBAL: path.join(scratch, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1',
});
const { createContainers, containerName, imageTag, IMAGE_DIR } = await import('../src/executor/container.js');
const { startJob, watch, stopJob, renderPrompt, forwardEnv } = await import('../src/executor/job.js');
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
const until = async (what, fn, ms = 10000) => { for (const end = Date.now() + ms; Date.now() < end;) { if (await fn()) return; await sleep(25); } assert.fail(`never: ${what}`); };
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
const containers = createContainers({ log, now: () => clock.now, imageDir });
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
async function launch(runId, peer, repo, spec = {}) {
  const run = { runId, pool: repo.pool };
  const container = await containers.acquire({ pool: repo.pool, peer, runId });
  await mirrors.ensureMirror({ pool: repo.pool, checkout: repo.checkout });
  const proxy = await broker.addJob({ ...run, peer });
  const started = await startJob({ run, container, spec: { ...SPEC, ...spec }, proxy, env: { CLAUDE_CODE_OAUTH_TOKEN: 'dn-placeholder' } });
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

    fs.writeFileSync(path.join(fakeDir, 'build-ms'), '400');
    const building = Promise.all([containers.ensureImage(), containers.ensureImage()]);
    await until('the build shows', () => containers.dockerState().state === 'building');
    assert.equal(containers.dockerState().image, imageTag(imageDir));
    const [tag, same] = await building;
    assert.equal(tag, imageTag(imageDir));
    assert.equal(same, tag);
    assert.deepEqual(containers.dockerState(), { state: 'ready', image: tag, detail: '' });
    assert.equal(await containers.ensureImage(), tag);
    assert.equal(calls('build').length, 2, 'the failed one and the one that worked: never again for the same tag');
    assert.deepEqual(calls('build').at(-1), ['build', '--progress', 'plain', '-t', tag, imageDir]);
    fs.rmSync(path.join(fakeDir, 'build-ms'));
  });

  await broker.start();
  const alpha = makeRepo('dn-test', 'alpha');
  const beta = makeRepo('dn-test', 'beta');

  let first;
  await check('a job runs the agent in a clone of the repository, as the requester, behind the broker, holding no credential', async () => {
    first = await launch('run-1', PEER_A, alpha);
    const outcome = await first.outcome;
    assert.deepEqual(outcome, { ok: true, summary: 'did run-1', usd: 0.25, tokens: 4340, model: 'claude-big', runner: 'claude', exit: 0, state: 'finished' });

    const dir = path.join(RUNS_DIR, '.containers', first.container.name, 'run-1');
    assert.equal(first.started.dir, dir);
    assert.equal(first.started.log, path.join(dir, 'log.jsonl'));
    assert.equal(fs.realpathSync(path.join(RUNS_DIR, 'run-1')), fs.realpathSync(dir), 'runs/<run id> leads to it');
    assert.deepEqual(fs.readdirSync(path.join(RUNS_DIR, '.staging')), [], 'nothing is left where it was put together');
    assert.equal(fs.readFileSync(path.join(dir, 'done'), 'utf8'), '0\n');
    assert.equal(fs.statSync(path.join(dir, 'env.sh')).mode & 0o777, 0o600);

    assert.deepEqual(agent('run-1', 'args').trim().split('\n'), ['-p', '--dangerously-skip-permissions', '--output-format', 'stream-json', '--verbose']);
    const [head, name, email, origin] = agent('run-1', 'git').split('\n');
    assert.equal(head, alpha.main, 'the default branch when the task names no base');
    assert.equal(name, 'Requester Name');
    assert.equal(email, 'requester@example.com');
    assert.equal(origin, 'https://github.com/dn-test/alpha.git');
    const root = path.join(fakeDir, 'roots', first.container.name);
    assert.equal(agent('run-1', 'cwd').trim(), path.join(fs.realpathSync(path.join(fakeDir, 'volumes')), first.container.name.replace('dn-', 'dn-work-'), 'jobs', 'run-1', 'repo'));

    const env = Object.fromEntries(agent('run-1', 'env').split('\n').filter((l) => l.includes('=')).map((l) => l.split(/=(.*)/s).slice(0, 2)));
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
    assert.equal(env.DN_RUN_ID, 'run-1');
    assert.equal(fs.existsSync(path.join(root, 'work', 'jobs', 'run-1')), false, 'the work tree is gone when the job is');
    assert.ok(fs.existsSync(path.join(root, 'work', 'cache.git', 'HEAD')), 'the container keeps its copy of the repository');
    assert.equal(forgeSeen.length, 0, 'the clone never went to the requester');
  });

  await check('the prompt is the container preamble, a rule, and the requester\'s words', () => {
    const prompt = agent('run-1', 'prompt');
    assert.equal(prompt, fs.readFileSync(path.join(RUNS_DIR, 'run-1', 'prompt.txt'), 'utf8'));
    assert.ok(prompt.endsWith('\n\n---\n\nReview the pull request.\n'));
    assert.doesNotMatch(prompt, /\{\{/, 'every blank is filled');
    for (const said of ['https://github.com/dn-test/alpha.git', '`pr:7`', 'apt-get update && apt-get install -y', 'GNU', '403', '`gh`', 'git fetch origin pull/<n>/head',
      'Requester Name <requester@example.com>', 'No simulator, emulator or device is offered']) assert.ok(prompt.includes(said), said);
    const lab = renderPrompt({ pool: { id: 'gitlab.example.org/g/r', forge: 'gitlab', host: 'gitlab.example.org', owner: 'g', repo: 'r' }, spec: { ...SPEC, item: '' },
      forwards: [{ name: 'adb', host: 'host.docker.internal', port: 5 }] });
    for (const said of ['https://gitlab.example.org/g/r.git', '`glab`', 'merge-requests/<n>/head', 'the repository as a whole', 'forwarded from the host and already in your environment: adb']) assert.ok(lab.includes(said), said);
  });

  await check('a forward reaches a job as the variable its tool reads', () => {
    assert.deepEqual(forwardEnv([{ name: 'adb', host: 'host.docker.internal', port: 40001 }, { name: 'tool-server', host: 'host.docker.internal', port: 40002 }]),
      { ADB_SERVER_SOCKET: 'tcp:host.docker.internal:40001', DN_FORWARD_TOOL_SERVER: 'host.docker.internal:40002' });
    assert.deepEqual(forwardEnv([]), {});
  });

  await check('the container is created locked down: six capabilities, no new privileges, limits, its own volume and run records, nothing of the host\'s', () => {
    const [run] = calls('run');
    const name = containerName(alpha.pool.id, PEER_A);
    assert.equal(first.container.name, name);
    assert.deepEqual(run, ['run', '-d', '--init', '--name', name,
      '--label', 'dn.pool=github.com/dn-test/alpha', '--label', `dn.peer=${PEER_A}`, '--label', `dn.base=${BASE}`,
      '--cap-drop=ALL', '--cap-add=CHOWN', '--cap-add=DAC_OVERRIDE', '--cap-add=FOWNER', '--cap-add=FSETID', '--cap-add=SETGID', '--cap-add=SETUID',
      '--security-opt', 'no-new-privileges', '--pids-limit', '4096', '--memory', '8g', '--cpus', '4',
      '-v', `${name.replace('dn-', 'dn-work-')}:/work`, '-v', `${path.join(RUNS_DIR, '.containers', name)}:/dn/runs`,
      imageTag(imageDir), 'sleep', 'infinity']);
    const all = calls().flat().join(' ');
    assert.doesNotMatch(all, /docker\.sock|--privileged|\.ssh|--network[ =]host|--pid[ =]host/);
    assert.deepEqual(calls('volume').filter((c) => c[1] === 'create'), [['volume', 'create', '--label', `dn.base=${BASE}`, name.replace('dn-', 'dn-work-')]]);
  });

  await check('the same peer on the same repository gets the same container again; its second clone borrows from the first', async () => {
    const second = await launch('run-2', PEER_A, alpha, { base: 'pull/7/head' });
    assert.equal(second.container.name, first.container.name);
    assert.equal((await second.outcome).ok, true);
    assert.equal(calls('run').length, 1, 'one container, not two');
    const [head, , , , alternates] = agent('run-2', 'git').split('\n');
    assert.equal(head, alpha.pr, 'the pull request head, fetched from the mirror');
    assert.match(alternates, /\/cache\.git\/objects$/);
  });

  await check('another peer on the same repository, and the same peer on another repository, each get a container of their own', async () => {
    const otherPeer = await launch('run-3', PEER_B, alpha);
    const otherPool = await launch('run-4', PEER_A, beta);
    assert.equal((await otherPeer.outcome).ok, true);
    assert.equal((await otherPool.outcome).ok, true);
    const names = new Set([first.container.name, otherPeer.container.name, otherPool.container.name]);
    assert.equal(names.size, 3);
    assert.equal(calls('run').length, 3);
    assert.deepEqual(containers.list().map((c) => c.name).sort(), [...names].sort());
    // Each sees its own run records and no one else's.
    for (const [name, mine] of [[first.container.name, ['run-1', 'run-2']], [otherPeer.container.name, ['run-3']], [otherPool.container.name, ['run-4']]]) {
      assert.deepEqual(fs.readdirSync(path.join(fakeDir, 'roots', name, 'dn', 'runs')).sort(), mine);
    }
    assert.equal(agent('run-4', 'git').split('\n')[3], 'https://github.com/dn-test/beta.git');
  });

  await check('two jobs run at once in one container, and stopping one leaves the other to finish', async () => {
    const stays = await launch('run-5', PEER_A, alpha, { prompt: 'MODE=sleep' });
    const goes = await launch('run-6', PEER_A, alpha, { prompt: 'MODE=sleep' });
    assert.equal(stays.container.name, goes.container.name);
    await until('both agents run', () => fs.existsSync(path.join(agentDir, 'run-5.started')) && fs.existsSync(path.join(agentDir, 'run-6.started')));
    assert.deepEqual(containers.list().find((c) => c.name === stays.container.name).jobs.sort(), ['run-5', 'run-6']);
    const pid = (r) => Number(fs.readFileSync(path.join(RUNS_DIR, r, 'pid'), 'utf8'));
    const [staysPid, goesPid] = [pid('run-5'), pid('run-6')];
    assert.ok(pidAlive(staysPid) && pidAlive(goesPid));

    const stopped = await stopJob(goes.run);
    assert.deepEqual(stopped, { ok: false, summary: 'stopped', usd: 0, tokens: 0, model: '', runner: 'claude', exit: null, state: 'stopped' });
    assert.equal(await goes.outcome, stopped);
    assert.equal(pidAlive(goesPid), false, 'its runner is dead');
    assert.throws(() => process.kill(-goesPid, 0), 'and so is everything it started');
    assert.equal(pidAlive(staysPid), true, 'the other job was not touched');
    process.kill(-staysPid, 0);
    assert.equal(fs.existsSync(path.join(fakeDir, 'roots', stays.container.name, 'work', 'jobs', 'run-6')), false);
    assert.equal(fs.existsSync(path.join(fakeDir, 'roots', stays.container.name, 'work', 'jobs', 'run-5', 'repo', 'README')), true);
    assert.equal(calls('rm').length, 0, 'the container was never removed');
    assert.equal(await stopJob(goes.run), null, 'stopping what has ended is nothing');
    const restarts = calls('restart').length;
    await containers.release({ name: goes.container.name, runId: 'run-6' });
    assert.equal(calls('restart').length, restarts, 'nor restarted under the job still in it');

    // The survivor ends on its own terms: here, by being stopped later.
    assert.equal((await stopJob(stays.run)).state, 'stopped');
    assert.equal(pidAlive(staysPid), false);
    await stays.outcome;
    assert.deepEqual(calls('restart').slice(restarts), [['restart', '-t', '0', stays.container.name]], 'with its last job gone the container is restarted: nothing a job started outlives it');
  });

  await check('an agent that reports an error, one that dies without a word, and a task that cannot start are failures that say why', async () => {
    const refused = await (await launch('run-7', PEER_A, alpha, { prompt: 'MODE=refused' })).outcome;
    assert.deepEqual(refused, { ok: false, summary: 'the model refused', usd: 0.01, tokens: 6, model: '', runner: 'claude', exit: 1, state: 'failed' });
    const crashed = await (await launch('run-8', PEER_A, alpha, { prompt: 'MODE=crash' })).outcome;
    assert.deepEqual(crashed, { ok: false, summary: 'the agent left no result: boom: the agent fell over', usd: 0, tokens: 0, model: '', runner: 'claude', exit: 3, state: 'failed' });
    const noBase = await (await launch('run-9', PEER_A, alpha, { base: 'no-such-branch' })).outcome;
    assert.equal(noBase.ok, false);
    assert.equal(noBase.exit, 70);
    assert.match(noBase.summary, /^the agent left no result: .*dn: the base revision no-such-branch is not in the repository$/s);
    assert.equal(fs.existsSync(path.join(agentDir, 'run-9.prompt')), false, 'the agent was never started');
  });

  await check('a job whose process vanishes without a done file is a failure, never a success', async () => {
    const vanished = await launch('run-10', PEER_A, alpha, { prompt: 'MODE=vanish' });
    const outcome = await vanished.outcome;
    assert.equal(fs.existsSync(path.join(RUNS_DIR, 'run-10', 'done')), false);
    assert.equal(outcome.ok, false);
    assert.equal(outcome.state, 'failed');
    assert.equal(outcome.exit, null);
    assert.match(outcome.summary, /disappeared without finishing/);
  });

  await check('a container removed under a running job fails that job, and the next one gets a new container', async () => {
    const doomed = await launch('run-11', PEER_B, alpha, { prompt: 'MODE=sleep' });
    await until('the agent runs', () => fs.existsSync(path.join(agentDir, 'run-11.started')));
    execFileSync(FAKE, ['rm', '-f', doomed.container.name]);
    const outcome = await doomed.outcome;
    assert.equal(outcome.ok, false);
    assert.equal(outcome.state, 'failed');
    // Processes killed together do not die at one instant: the runner may outlive the
    // agent long enough to record its death, and that is as much a failure as no record.
    assert.match(outcome.summary, /disappeared without finishing|left no result/);
    const runs = calls('run').length;
    const next = await launch('run-12', PEER_B, alpha);
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
    const linked = await (await launch('run-13', PEER_A, alpha, { prompt: 'MODE=link' })).outcome;
    assert.deepEqual(linked, { ok: false, summary: 'the agent left no result', usd: 0, tokens: 0, model: '', runner: 'claude', exit: 0, state: 'failed' });
    // The same with the whole directory swapped for a link: not even its `done` counts.
    const swapped = await (await launch('run-13b', PEER_A, alpha, { prompt: 'MODE=swap' })).outcome;
    assert.equal(swapped.ok, false);
    assert.equal(swapped.exit, null);
    assert.doesNotMatch(JSON.stringify(swapped), /contents of a file on the host/);
    assert.match(swapped.summary, /disappeared without finishing/);
  });

  await check('a commit made in a job is authored as the requester', async () => {
    const job = await launch('run-14', PEER_A, alpha, { prompt: 'MODE=commit' });
    assert.equal((await job.outcome).ok, true);
    assert.equal(agent('run-14', 'author').trim(), 'Requester Name <requester@example.com>');
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
    const live = await launch('run-15', PEER_A, alpha, { prompt: 'MODE=sleep' });
    await assert.rejects(startJob({ run: live.run, container, spec: SPEC, proxy }), /already started/);
    await stopJob(live.run);
    containers.release({ name: container.name, runId: 'x' });
    await assert.rejects(watch({ runId: 'never-started' }), /is not running/);
  });

  await check('a container with a job in it survives any idle time; an idle one is removed with its volume after CONTAINER_IDLE_MS', async () => {
    const name = first.container.name;
    const busy = await launch('run-16', PEER_A, alpha, { prompt: 'MODE=sleep' });
    await until('the agent runs', () => fs.existsSync(path.join(agentDir, 'run-16.started')));
    clock.now += 10 * 3600 * 1000;
    await containers.sweep();
    const gone = calls('rm').map((c) => c.at(-1));
    assert.ok(!gone.includes(name), 'not the one with a job in it');
    assert.ok(gone.includes(containerName(beta.pool.id, PEER_A)), 'the idle ones went');
    assert.ok(calls('volume').some((c) => c[1] === 'rm' && c.at(-1) === containerName(beta.pool.id, PEER_A).replace('dn-', 'dn-work-')));
    assert.equal(fs.existsSync(path.join(fakeDir, 'volumes', name.replace('dn-', 'dn-work-'))), true);
    await stopJob(busy.run);
    await busy.outcome;

    const before = calls('rm').length;
    clock.now += 3599 * 1000;
    await containers.sweep();
    assert.equal(calls('rm').length, before, 'idle time is counted from the end of the last job');
    clock.now += 2000;
    await containers.sweep();
    assert.deepEqual(calls('rm').at(-1), ['rm', '-f', name]);
    assert.equal(fs.existsSync(path.join(fakeDir, 'volumes', name.replace('dn-', 'dn-work-'))), false);
    assert.deepEqual(containers.list(), []);
  });

  await check('a new image replaces a container only when no job is running in it, and keeps its volume', async () => {
    const before = await launch('run-17', PEER_A, alpha, { prompt: 'MODE=sleep' });
    await until('the agent runs', () => fs.existsSync(path.join(agentDir, 'run-17.started')));
    const oldTag = before.container.image;
    fs.appendFileSync(path.join(imageDir, 'Dockerfile'), 'RUN true\n');
    const newTag = imageTag(imageDir);
    assert.notEqual(newTag, oldTag);

    const runs = calls('run').length;
    const joined = await launch('run-18', PEER_A, alpha);
    assert.equal(joined.container.image, oldTag, 'with a job running, the newcomer joins it in the old image');
    assert.equal((await joined.outcome).ok, true);
    assert.equal(calls('run').length, runs);
    assert.equal(fs.existsSync(path.join(agentDir, 'run-17.started')), true);
    assert.ok(pidAlive(Number(fs.readFileSync(path.join(RUNS_DIR, 'run-17', 'pid'), 'utf8'))), 'and the running job was not disturbed');

    await stopJob(before.run);
    await before.outcome;
    const volumeRemovals = calls('volume').filter((c) => c[1] === 'rm').length;
    const after = await launch('run-19', PEER_A, alpha);
    assert.equal(after.container.image, newTag);
    assert.equal((await after.outcome).ok, true);
    assert.equal(calls('run').length, runs + 1);
    assert.equal(calls('run').at(-1).at(-3), newTag);
    assert.equal(calls('volume').filter((c) => c[1] === 'rm').length, volumeRemovals, 'the work volume and its cache stay');
    assert.match(agent('run-19', 'git').split('\n')[4], /cache\.git/);
  });

  await check('a container an earlier daemon left is restarted before it is used, and one of another daemon is never touched', async () => {
    const tag = await containers.ensureImage();
    // Left behind by this base's previous daemon, for a pair this one has not seen.
    const mine = containerName(beta.pool.id, PEER_B);
    execFileSync(FAKE, ['run', '-d', '--name', mine, '--label', `dn.base=${BASE}`, '-v', `${mine.replace('dn-', 'dn-work-')}:/work`, '-v', `${path.join(RUNS_DIR, '.containers', mine)}:/dn/runs`, tag, 'sleep', 'infinity']);
    const restarts = calls('restart').length;
    const runs = calls('run').length;
    const held = await containers.acquire({ pool: beta.pool, peer: PEER_B, runId: 'adopter' });
    assert.equal(held.name, mine);
    assert.deepEqual(calls('restart').slice(restarts), [['restart', '-t', '0', mine]]);
    assert.equal(calls('run').length, runs, 'it is used, not made again');
    await containers.release({ name: mine, runId: 'adopter' });
    assert.equal((await (await launch('run-20', PEER_B, beta)).outcome).ok, true);

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
  });

  await check('a stray container this daemon never used is removed once it has been seen idle for the full time', async () => {
    const tag = await containers.ensureImage();
    const stray = containerName('github.com/dn-test/stray', PEER_A);
    execFileSync(FAKE, ['run', '-d', '--name', stray, '--label', `dn.base=${BASE}`, tag, 'sleep', 'infinity']);
    await containers.sweep();
    assert.ok(!calls('rm').some((c) => c.at(-1) === stray), 'first seen is not yet idle');
    clock.now += 3601 * 1000;
    await containers.sweep();
    assert.deepEqual(calls('rm').at(-1), ['rm', '-f', stray]);
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
