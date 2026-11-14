// The executor against the real docker engine and the real internet: the image built,
// real containers, the tools inside them leaving through the real broker, and one real
// agent run on this machine's model credential with no credential inside the container.
//
// Run: DN_TEST_DOCKER=real node test/executor-real.mjs
//   DN_TEST_SKIP_CLAUDE=1   leaves the agent run out (a machine with no model credential)
//   DN_TEST_KEEP_IMAGE=1    leaves the test image behind for the next run
// Everything it creates carries this run's own dn.base label and is removed at the end.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';

if (process.env.DN_TEST_DOCKER !== 'real') {
  console.log('SKIP the real-docker suite: set DN_TEST_DOCKER=real to run it');
  process.exit(0);
}

const scratch = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'dn-real-'));
const forgeDir = path.join(scratch, 'forge');
fs.mkdirSync(forgeDir);
fs.writeFileSync(path.join(scratch, 'gitconfig'), `[user]\n\tname = T\n\temail = t@example.com\n[init]\n\tdefaultBranch = main\n[url "${forgeDir}/"]\n\tinsteadOf = https://github.com/\n`);
const BASE = path.join(scratch, 'base');
Object.assign(process.env, {
  DN_BASE_DIR: BASE, DN_IMAGE_REPO: 'dn-test-agent', DN_JOB_STOP_GRACE_MS: '2000',
  GIT_CONFIG_GLOBAL: path.join(scratch, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1',
});
const { createContainers, docker } = await import('../src/executor/container.js');
const { startJob, watch, stopJob } = await import('../src/executor/job.js');
const { createBroker } = await import('../src/executor/broker.js');
const { createCA } = await import('../src/executor/ca.js');
const { createLLM } = await import('../src/executor/llm.js');
const { createMirrors } = await import('../src/executor/mirror.js');
const { RUNS_DIR } = await import('../src/paths.js');

let checks = 0;
const check = async (name, fn) => { await fn(); checks++; console.log(`PASS ${name}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (what, fn, ms = 60000) => { for (const end = Date.now() + ms; Date.now() < end;) { if (await fn()) return; await sleep(200); } assert.fail(`never: ${what}`); };
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const sh = async (...args) => { const r = await docker(args, { timeout: 120000 }); assert.equal(r.code, 0, `docker ${args.join(' ')}: ${r.stderr}`); return r.stdout.trim(); };
const mine = ['--filter', `label=dn.base=${BASE}`];

// The repository: on a stand-in forge on this host, with a commit only the mirror gets.
const bare = path.join(forgeDir, 'dn-test', 'alpha.git');
fs.mkdirSync(bare, { recursive: true });
git(bare, 'init', '--quiet', '--bare');
const checkout = path.join(scratch, 'checkout');
git(scratch, 'clone', '--quiet', 'https://github.com/dn-test/alpha.git', checkout);
fs.writeFileSync(path.join(checkout, 'README'), 'alpha\n');
git(checkout, 'add', '.');
git(checkout, 'commit', '--quiet', '-m', 'one');
git(checkout, 'push', '--quiet', 'origin', 'main');
const pool = { id: 'github.com/dn-test/alpha', forge: 'github', host: 'github.com', owner: 'dn-test', repo: 'alpha' };

// The requester: answers one API path, and plays the forge's push endpoints with the
// real receive-pack, so a push that reaches it lands on the stand-in forge.
const forgeSeen = [];
const pkt = (s) => (s.length + 4).toString(16).padStart(4, '0') + s;
const run = (args, input) => new Promise((resolve) => {
  const child = spawn('git', args, { stdio: ['pipe', 'pipe', 'ignore'] });
  const out = [];
  child.stdout.on('data', (c) => out.push(c));
  child.on('close', () => resolve(Buffer.concat(out)));
  // git may be done before it has read what it was sent.
  child.stdin.on('error', () => {});
  child.stdin.end(input);
});
const onForge = async (job, r) => {
  forgeSeen.push({ run: job.runId, line: `${r.method} ${r.host}${r.path}`, headers: r.headers });
  const json = (status, o) => ({ status, headers: { 'content-type': 'application/json; charset=utf-8' }, body: Buffer.from(JSON.stringify(o)).toString('base64') });
  if (r.host === 'api.github.com' && r.path === '/repos/dn-test/alpha') return json(200, { full_name: 'dn-test/alpha', answered_by: 'the requester' });
  if (r.path === '/dn-test/alpha.git/info/refs?service=git-receive-pack') {
    const adv = await run(['receive-pack', '--stateless-rpc', '--advertise-refs', bare], '');
    return { status: 200, headers: { 'content-type': 'application/x-git-receive-pack-advertisement' }, body: Buffer.concat([Buffer.from(`${pkt('# service=git-receive-pack\n')}0000`), adv]) };
  }
  if (r.path === '/dn-test/alpha.git/git-receive-pack') {
    return { status: 200, headers: { 'content-type': 'application/x-git-receive-pack-result' }, body: await run(['receive-pack', '--stateless-rpc', bare], Buffer.from(r.body, 'base64')) };
  }
  return json(403, { message: 'not for this task' });
};

const clock = { skew: 0 };
const containers = createContainers({ now: () => Date.now() + clock.skew });
const mirrors = createMirrors();
const llm = createLLM();
const broker = createBroker({ ca: createCA(), llm, mirrors, onForge });
const PEER_A = 'pkAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const PEER_B = 'pkBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

// A service of this machine that no job may reach.
const hostSeen = [];
const hostService = http.createServer((req, res) => { hostSeen.push(req.headers['x-via'] || ''); res.end('a service of the executor\'s machine'); });

// A job whose agent is a shell script: the real runner, environment and clone, with a
// stand-in for `claude` put first on PATH that runs the script and reports its exit.
const STAND_IN = `#!/bin/sh
cat > /dev/null
sh "/dn/runs/bin/$DN_RUN_ID.sh"
code=$?
printf '{"type":"result","subtype":"success","is_error":false,"result":"script exit %s","total_cost_usd":0}\\n' "$code"
exit $code
`;
const STEPS = `out="/dn/runs/$DN_RUN_ID"
step() { n="$1"; shift; sh -c "$*" > "$out/out-$n.txt" 2>&1; echo "$n $?" >> "$out/out-steps.txt"; }
`;
async function launch(runId, peer, { script = null, env = {}, prompt = 'Do nothing.' } = {}) {
  const job = { runId, pool };
  const container = await containers.acquire({ pool, peer, runId });
  if (script !== null) {
    fs.mkdirSync(path.join(container.runsDir, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(container.runsDir, 'bin', 'claude'), STAND_IN, { mode: 0o755 });
    fs.writeFileSync(path.join(container.runsDir, 'bin', `${runId}.sh`), STEPS + script);
    env = { ...env, PATH: '/dn/runs/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' };
  }
  const proxy = await broker.addJob({ ...job, peer });
  const release = mirrors.retain(pool);
  const started = await startJob({ run: job, container, spec: { prompt, item: 'pr:1', base: '', name: 'Requester Name', email: 'requester@example.com' }, proxy, env });
  const outcome = watch(job).finally(() => { release(); broker.removeJob(runId); return containers.release({ name: container.name, runId }); });
  const out = (name) => fs.readFileSync(path.join(started.dir, `out-${name}.txt`), 'utf8').trim();
  const steps = () => Object.fromEntries(fs.readFileSync(path.join(started.dir, 'out-steps.txt'), 'utf8').trim().split('\n').map((l) => [l.split(' ')[0], Number(l.split(' ')[1])]));
  return { run: job, container, proxy, dir: started.dir, outcome, out, steps };
}
const groupAlive = async (job) => (await docker(['exec', job.container.name, 'sh', '-c', `kill -s 0 -- -${fs.readFileSync(path.join(job.dir, 'pid'), 'utf8').trim()}`])).code === 0;

let tag = '';
try {
  await check('the image builds from image/ and is found again without a second build', async () => {
    const started = Date.now();
    tag = await containers.ensureImage();
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    assert.match(tag, /^dn-test-agent:[0-9a-f]{12}$/);
    assert.deepEqual(containers.dockerState(), { state: 'ready', image: tag, detail: '' });
    const size = Number(await sh('image', 'inspect', '--format', '{{.Size}}', tag));
    console.log(`INFO image ${tag}: ${(size / 1e9).toFixed(2)} GB (${size} bytes), ensureImage took ${seconds} s (${os.platform()}/${os.arch()})`);
    const again = Date.now();
    assert.equal(await containers.ensureImage(), tag);
    assert.ok(Date.now() - again < 15000);
    console.log(`INFO in the image: ${(await sh('run', '--rm', '--label', `dn.base=${BASE}`, tag, 'sh', '-c',
      'echo "node $(node -v), npm $(npm -v), python $(python3 -V | cut -d" " -f2), git $(git --version | cut -d" " -f3), $(gh --version | head -1), $(glab --version | head -1), claude $(claude --version), adb $(adb version | head -1 | cut -d" " -f5)"')).replace(/\n/g, ' ')}`);
  });

  const at = await broker.start();
  const hostPort = await new Promise((resolve) => hostService.listen(0, at.host === '127.0.0.1' ? '127.0.0.1' : '0.0.0.0', () => resolve(hostService.address().port)));
  await mirrors.ensureMirror({ pool, checkout });
  // Only the mirror has this commit: a clone that ends on it was answered by the mirror.
  fs.writeFileSync(path.join(checkout, 'only-in-mirror'), 'x\n');
  git(checkout, 'add', '.');
  git(checkout, 'commit', '--quiet', '-m', 'mirror only');
  const marked = git(checkout, 'rev-parse', 'HEAD');
  git(checkout, 'push', '--quiet', mirrors.path(pool), 'HEAD:refs/heads/main');

  let tools;
  await check('a job in a real container finishes, and its clone came from the mirror without a word to the requester', async () => {
    console.log(`INFO the broker listens on ${at.host}:${at.port}`);
    if (!process.env.DN_TEST_SKIP_CLAUDE) await llm.load();
    tools = await launch('tools', PEER_A, { env: llm.env(), script: `
step tunnel "curl -sS -o /dev/null -w '%{http_code}' https://example.com"
step nodefetch "node -e \\"fetch('https://example.com').then((r) => console.log(r.status))\\""
step hostport "curl -sS -H 'x-via: proxy' -o /dev/null -w '%{http_code}' http://host.docker.internal:${hostPort}/"
step hostconnect "curl -sS -o /dev/null https://host.docker.internal:${hostPort}/"
step bridge "curl -sS -o /dev/null -w '%{http_code}' http://172.17.0.1:${hostPort}/"
step notoken "curl -sS -o /dev/null -w '%{http_code}' -x http://host.docker.internal:${at.port} http://example.com/"
step direct_host "curl -sS --noproxy '*' -m 6 -H 'x-via: direct' -o /dev/null -w '%{http_code}' http://host.docker.internal:${hostPort}/"
step direct_internet "curl -sS --noproxy '*' -m 8 -o /dev/null -w '%{http_code}' https://example.com"
step head "git rev-parse HEAD && git config user.name && git config user.email"
step gh "gh api repos/dn-test/alpha"
step ghother "gh api user"
step push "git checkout -q -b fix && echo fixed > fix.txt && git add fix.txt && git commit -q -m fix && git push -q origin HEAD:refs/heads/fix-1 && git rev-parse HEAD"
step apt "apt-get update -q && apt-get install -y -q cowsay && /usr/games/cowsay moo"
step npm "npm install -g cowsay && /usr/local/bin/cowsay moo"
step pip "python3 -m venv /tmp/venv && /tmp/venv/bin/pip install -q cowsay && /tmp/venv/bin/python -c 'import cowsay; cowsay.cow(\\"moo\\")'"
step mount "mount -t tmpfs none /mnt"
step status "grep -E 'CapEff|NoNewPrivs' /proc/self/status; id -u"
step env "env"
step secrets "grep -rIl -e 'sk-an[t]-' /root /work /dn /tmp /etc /home /run /var 2>/dev/null; true"
step mounts "ls /var/run/docker.sock /root/.ssh /root/.claude 2>&1; ls /dn/runs"
exit 0
` });
    const outcome = await tools.outcome;
    assert.deepEqual(outcome, { ok: true, summary: 'script exit 0', usd: 0, tokens: 0, model: '', runner: 'claude', exit: 0, state: 'finished' });
    assert.equal(tools.out('head'), `${marked}\nRequester Name\nrequester@example.com`);
    assert.deepEqual(forgeSeen.filter((s) => s.line.includes('upload-pack')), []);
  });

  await check('the internet is reached through the broker by curl and by node', () => {
    assert.equal(tools.out('tunnel'), '200');
    assert.equal(tools.out('nodefetch'), '200');
  });

  await check('a service of the executor\'s machine is refused through the broker, by name and by address', () => {
    assert.equal(tools.out('hostport'), '403');
    assert.notEqual(tools.steps().hostconnect, 0);
    assert.match(tools.out('hostconnect'), /403/);
    assert.equal(tools.out('bridge'), '403');
    assert.ok(!hostSeen.includes('proxy'), 'nothing came through the broker');
    assert.equal(tools.out('notoken'), '407', 'and the broker itself answers nothing without a token');
    // Not asserted, recorded: what the container reaches when it ignores the proxy.
    console.log(`INFO without the proxy, from inside the container: this machine's port -> ${tools.out('direct_host').split('\n').pop()}, the internet -> ${tools.out('direct_internet').split('\n').pop()}`);
  });

  await check('gh prints what the requester answered, and what the requester refuses is a 403 with its reason', () => {
    assert.deepEqual(JSON.parse(tools.out('gh')), { full_name: 'dn-test/alpha', answered_by: 'the requester' });
    const asked = forgeSeen.find((s) => s.line === 'GET api.github.com/repos/dn-test/alpha');
    assert.ok(asked);
    assert.equal(asked.headers.authorization, undefined, 'the placeholder token stays here');
    assert.notEqual(tools.steps().ghother, 0);
    assert.match(tools.out('ghother'), /not for this task.*403/s);
  });

  await check('git push reaches the requester as the two receive-pack requests and lands where it puts it', () => {
    assert.equal(tools.steps().push, 0, tools.out('push'));
    assert.deepEqual(forgeSeen.filter((s) => s.line.includes('receive-pack')).map((s) => s.line),
      ['GET github.com/dn-test/alpha.git/info/refs?service=git-receive-pack', 'POST github.com/dn-test/alpha.git/git-receive-pack']);
    assert.equal(git(bare, 'rev-parse', 'refs/heads/fix-1'), tools.out('push').split('\n').pop());
    assert.equal(git(bare, 'log', '-1', '--format=%an <%ae>', 'refs/heads/fix-1'), 'Requester Name <requester@example.com>');
  });

  await check('apt-get, npm and pip install through the broker', () => {
    for (const tool of ['apt', 'npm', 'pip']) {
      assert.equal(tools.steps()[tool], 0, `${tool}: ${tools.out(tool).slice(-600)}`);
      assert.match(tools.out(tool), /moo/, tool);
    }
  });

  await check('root in the container holds the six capabilities and no way to more: mount is refused', () => {
    const status = tools.out('status');
    // CHOWN, DAC_OVERRIDE, FOWNER, FSETID, SETGID, SETUID.
    assert.match(status, /CapEff:\s+00000000000000db/);
    assert.match(status, /NoNewPrivs:\s+1/);
    assert.match(status, /^0$/m);
    assert.notEqual(tools.steps().mount, 0);
    assert.match(tools.out('mount'), /permission denied|not permitted/i);
    const seen = tools.out('mounts');
    assert.match(seen, /docker\.sock.*No such file/);
    assert.match(seen, /\.ssh.*No such file/);
    assert.match(seen, /\.claude.*No such file/);
  });

  await check('nothing in the job\'s environment or the container\'s files is a credential', () => {
    const env = Object.fromEntries(tools.out('env').split('\n').filter((l) => l.includes('=')).map((l) => l.split(/=(.*)/s).slice(0, 2)));
    const secretish = Object.entries(env).filter(([k]) => /TOKEN|KEY|SECRET|PASSWORD|AUTH/i.test(k));
    for (const [k, v] of secretish) assert.equal(v, 'dn-placeholder', k);
    assert.ok(secretish.length >= 2, 'the forge placeholders are there');
    assert.doesNotMatch(tools.out('env'), /sk-ant-/);
    // The one secret a job holds is its own pass to the broker.
    assert.equal(env.HTTPS_PROXY, tools.proxy.proxyUrl);
    assert.equal(tools.out('secrets'), '');
  });

  await check('another peer on the same repository works in another container and sees none of the first one\'s runs', async () => {
    const other = await launch('other-peer', PEER_B, { script: 'step runs "ls /dn/runs"\nstep work "ls /work/jobs"\nexit 0\n' });
    assert.equal((await other.outcome).ok, true);
    assert.notEqual(other.container.name, tools.container.name);
    assert.deepEqual(other.out('runs').split('\n').sort(), ['bin', 'other-peer']);
    assert.equal(other.out('work'), 'other-peer');
    const listed = (await sh('ps', '-a', ...mine, '--format', '{{.Names}} {{.Label "dn.peer"}} {{.Label "dn.pool"}}')).split('\n').sort();
    assert.deepEqual(listed, [`${tools.container.name} ${PEER_A} ${pool.id}`, `${other.container.name} ${PEER_B} ${pool.id}`].sort());
  });

  await check('two jobs run at once in one container, and stopping one leaves the other to finish', async () => {
    const waiting = 'step wait "while [ ! -f /dn/runs/$DN_RUN_ID/go ]; do sleep 0.2; done"\nexit 0\n';
    // One leaves a child in the background; the other a process outside its group and
    // without its environment, which no stop of a job can find.
    const stays = await launch('stays', PEER_A, { script: `setsid env -i sleep 602 > /dev/null 2>&1 &\n${waiting}` });
    const goes = await launch('goes', PEER_A, { script: `sleep 601 &\n${waiting}` });
    assert.equal(stays.container.name, tools.container.name, 'the first job\'s container again');
    assert.equal(goes.container.name, stays.container.name);
    await until('both scripts run', () => fs.existsSync(path.join(stays.dir, 'out-wait.txt')) && fs.existsSync(path.join(goes.dir, 'out-wait.txt')));
    assert.ok(await groupAlive(stays) && await groupAlive(goes));
    const sleeping = async (n) => Number(await sh('exec', stays.container.name, 'sh', '-c', `pgrep -c -f "sleep 60[${n}]" || true`));
    assert.deepEqual([await sleeping(1), await sleeping(2)], [1, 1]);

    const stopped = await stopJob(goes.run);
    assert.equal(stopped.state, 'stopped');
    assert.equal(await groupAlive(goes), false);
    assert.equal(await sleeping(1), 0, 'its background child went with it');
    assert.equal(await groupAlive(stays), true, 'the other job runs on');
    assert.equal(await sh('exec', stays.container.name, 'sh', '-c', 'ls /work/jobs'), 'stays');
    await goes.outcome;
    fs.writeFileSync(path.join(stays.dir, 'go'), '');
    assert.equal((await stays.outcome).ok, true);
    assert.equal(await sleeping(2), 0, 'with its last job over the container is restarted, and the stray is gone');
    assert.equal(await sh('exec', stays.container.name, 'sh', '-c', 'ls /work/cache.git/HEAD'), '/work/cache.git/HEAD', 'its volume is as it was');
  });

  if (process.env.DN_TEST_SKIP_CLAUDE) {
    console.log('SKIP the real agent run: DN_TEST_SKIP_CLAUDE is set');
  } else {
    await check('a real agent answers through the broker on this machine\'s credential, with only a placeholder inside the container', async () => {
      assert.equal(llm.state().state, 'ready', llm.state().detail);
      const job = await launch('agent', PEER_A, { env: llm.env(), prompt: 'Reply with exactly: pong' });
      // While it runs: what every process in the container holds in its environment.
      await until('the agent is up', () => fs.existsSync(path.join(job.dir, 'log.jsonl')), 120000);
      const environ = await sh('exec', job.container.name, 'sh', '-c', 'cat /proc/[0-9]*/environ 2>/dev/null | tr "\\0" "\\n" | sort -u');
      const guard = setTimeout(() => stopJob(job.run), 300000);
      const outcome = await job.outcome;
      clearTimeout(guard);
      assert.equal(outcome.ok, true, JSON.stringify(outcome));
      assert.match(outcome.summary, /pong/i);
      assert.equal(outcome.state, 'finished');
      assert.equal(outcome.exit, 0);
      assert.ok(outcome.usd > 0, 'a cost');
      assert.ok(outcome.tokens > 0, 'tokens');
      assert.match(outcome.model, /^claude-/);
      console.log(`INFO the agent answered ${JSON.stringify(outcome.summary)}: model ${outcome.model}, ${outcome.tokens} tokens, $${outcome.usd}`);

      assert.doesNotMatch(environ, /sk-ant-/);
      const held = environ.split('\n').filter((l) => /^(CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|GH_TOKEN|GITLAB_TOKEN)=/.test(l)).map((l) => l.split('=')[1]);
      assert.ok(held.length >= 3);
      for (const v of held) assert.equal(v, 'dn-placeholder');
      const files = await sh('exec', job.container.name, 'sh', '-c', 'grep -rIl -e "sk-an[t]-" /root /work /dn /tmp /etc /home /run /var 2>/dev/null; true');
      assert.equal(files, '', 'no file in the container holds a credential');
      assert.doesNotMatch(fs.readFileSync(path.join(job.dir, 'log.jsonl'), 'utf8'), /sk-ant-/);
    });
  }

  await check('an idle container is removed with its volume, and nothing of this run is left in docker', async () => {
    clock.skew = 7 * 3600 * 1000;
    await containers.sweep();
    assert.equal(await sh('ps', '-a', '-q', ...mine), '');
    assert.equal(await sh('volume', 'ls', '-q', ...mine), '');
    assert.deepEqual(containers.list(), []);
  });

  console.log(`\nall ${checks} checks passed`);
} finally {
  await broker.stop().catch(() => {});
  hostService.close();
  for (const id of (await docker(['ps', '-a', '-q', ...mine])).stdout.split('\n').filter(Boolean)) await docker(['rm', '-f', id]);
  for (const v of (await docker(['volume', 'ls', '-q', ...mine])).stdout.split('\n').filter(Boolean)) await docker(['volume', 'rm', '-f', v]);
  if (tag && !process.env.DN_TEST_KEEP_IMAGE) await docker(['image', 'rm', tag]);
  fs.rmSync(scratch, { recursive: true, force: true });
}
process.exit(0);
