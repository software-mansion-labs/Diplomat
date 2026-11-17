// The executor against the real docker engine and the real internet: the image built,
// real containers that reach nothing but their relay, the tools inside them leaving
// through the real broker, and one real agent run on this machine's model credential
// with no credential inside the container.
//
// Run: DN_TEST_DOCKER=real node test/executor-real.mjs
//   DN_TEST_SKIP_CLAUDE=1   leaves the agent run out (a machine with no model credential)
//   DN_TEST_KEEP_IMAGE=1    leaves the test image behind for the next run
// Everything it creates carries this run's own dn.base label and is removed at the end.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
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
const { createAdbFilter } = await import('../src/executor/adb.js');
const { fakeAdb } = await import('./lib/daemons.mjs');
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
const containers = createContainers({ now: () => Date.now() + clock.skew, broker: () => broker.address() });
const mirrors = createMirrors();
const llm = createLLM();
const broker = createBroker({ ca: createCA(), llm, mirrors, onForge });
const PEER_A = 'pkAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const PEER_B = 'pkBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const PEER_C = 'pkCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';

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
// What a container reaches when it ignores the proxy: one line per target, "<name>: no
// (<why>)" or "<name>: REACHED <what answered>". Besides the targets it is given
// (name=host:port, tried as HTTP), it tries the internet by name and by address over TCP
// and UDP, the resolver, every other address of its own network on the given ports, the
// cloud metadata address, the docker socket and IPv6.
const REACH = `
import ipaddress, os, socket, sys

def http(host, port):
    try:
        with socket.create_connection((host, int(port)), 3) as c:
            c.settimeout(3)
            c.sendall(('GET /version HTTP/1.0\\r\\nHost: %s\\r\\nx-via: direct\\r\\n\\r\\n' % host).encode())
            return 'REACHED ' + repr(c.recv(200)[:60])
    except Exception as e:
        return 'no (%s)' % e

def say(name, result):
    print('%s: %s' % (name, result), flush=True)

ports = sys.argv[1].split(',')
for target in sys.argv[2:]:
    name, at = target.split('=')
    say(name, http(*at.rsplit(':', 1)))
say('the internet by name', http('example.com', 80))
say('the internet by address', http('1.1.1.1', 80))
say('a resolver over TCP', http('1.1.1.1', 53))
try:
    u = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    u.settimeout(3)
    u.sendto(b'\\x12\\x34\\x01\\x00\\x00\\x01\\x00\\x00\\x00\\x00\\x00\\x00\\x07example\\x03com\\x00\\x00\\x01\\x00\\x01', ('1.1.1.1', 53))
    say('a resolver over UDP', 'REACHED %d bytes' % len(u.recv(512)))
except Exception as e:
    say('a resolver over UDP', 'no (%s)' % e)
try:
    say('a name outside, asked of the resolver in the container', 'REACHED %s' % socket.getaddrinfo('example.com', 80)[0][4][0])
except Exception as e:
    say('a name outside, asked of the resolver in the container', 'no (%s)' % e)
me = socket.gethostbyname(socket.gethostname())
for a in ipaddress.ip_network(me + '/29', strict=False):
    if str(a) != me:
        for port in ports:
            say('its own network, %s:%s' % (a, port), http(str(a), port))
say('the cloud metadata address', http('169.254.169.254', 80))
say('the docker socket', 'REACHED' if os.path.exists('/var/run/docker.sock') else 'no (no such file)')
v6 = [l.split()[-1] for l in open('/proc/net/if_inet6') if l.split()[-1] != 'lo'] if os.path.exists('/proc/net/if_inet6') else []
say('IPv6', 'REACHED an address on %s' % v6 if v6 else 'no (only loopback has an address)')
`;
const FWD = `const [h, p] = process.env.DN_FORWARD_ECHO.split(':');
const s = require('net').connect(p, h);
s.on('data', (d) => { process.stdout.write(d); s.end(); });
s.on('error', (e) => console.log(e.message));
s.write('ping');
`;
async function launch(runId, peer, { script = null, env = {}, prompt = 'Do nothing.', forwardTo = {} } = {}) {
  const job = { runId, pool };
  const container = await containers.acquire({ pool, peer, runId });
  if (script !== null) {
    const bin = path.join(container.runsDir, 'bin');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, 'claude'), STAND_IN, { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'reach.py'), REACH);
    fs.writeFileSync(path.join(bin, 'fwd.js'), FWD);
    fs.writeFileSync(path.join(bin, `${runId}.sh`), STEPS + script);
    env = { ...env, PATH: '/dn/runs/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' };
  }
  const proxy = await broker.addJob({ ...job, peer });
  const forwards = Object.entries(forwardTo).map(([name, port]) => broker.addForward(runId, { name, target: { port } }));
  const release = mirrors.retain(pool);
  const started = await startJob({ run: job, container, spec: { prompt, item: 'pr:1', base: '', name: 'Requester Name', email: 'requester@example.com' }, proxy, env, forwards });
  const outcome = watch(job).finally(() => { release(); broker.removeJob(runId); return containers.release({ name: container.name, runId }); });
  const out = (name) => fs.readFileSync(path.join(started.dir, `out-${name}.txt`), 'utf8').trim();
  const steps = () => Object.fromEntries(fs.readFileSync(path.join(started.dir, 'out-steps.txt'), 'utf8').trim().split('\n').map((l) => [l.split(' ')[0], Number(l.split(' ')[1])]));
  return { run: job, container, proxy, dir: started.dir, group: started.pid, outcome, out, steps };
}
const unreached = (out) => out.split('\n').filter((l) => !/: no \(/.test(l));
// A place in a pair's container, as a job that is still running has: the container stays
// to be looked at when the jobs beside it are over. Resolves to what gives the place up.
async function hold(peer, runId) {
  const { name } = await containers.acquire({ pool, peer, runId });
  return () => containers.release({ name, runId });
}
// What the engine holds under a container's name, by kind.
async function under(name) {
  const listed = async (...args) => (await sh(...args, ...mine, '--format', args[0] === 'ps' ? '{{.Names}}' : '{{.Name}}')).split('\n').filter(Boolean).sort();
  return [
    ...(await listed('ps', '-a')).filter((n) => n.startsWith(name)),
    ...(await listed('network', 'ls')).filter((n) => n === name).map((n) => `network ${n}`),
    ...(await listed('volume', 'ls')).filter((n) => n === name.replace('dn-', 'dn-work-')).map((n) => `volume ${n}`),
  ];
}
const groupAlive = async (job) => (await docker(['exec', job.container.name, 'sh', '-c', `kill -s 0 -- -${job.group}`])).code === 0;

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
  // On every interface, so that no address of this machine is a way to it.
  const hostPort = await new Promise((resolve) => hostService.listen(0, '0.0.0.0', () => resolve(hostService.address().port)));
  const bridgeGateway = await sh('network', 'inspect', 'bridge', '--format', '{{range .IPAM.Config}}{{.Gateway}}{{end}}');
  const lan = Object.entries(os.networkInterfaces()).flatMap(([name, list]) => list.filter((i) => i.family === 'IPv4' && !i.internal && !/^(docker|br-|veth|bridge)/.test(name)).map((i) => i.address))[0];
  assert.ok(net.isIPv4(bridgeGateway) && net.isIPv4(lan), `${bridgeGateway} ${lan}`);
  // Neighbours on this machine's own networks: the address beside its own, in each family.
  const neighbour = lan.replace(/\d+$/, (d) => String(Number(d) ^ 1));
  const own6 = Object.entries(os.networkInterfaces()).flatMap(([name, list]) => list.filter((i) => i.family === 'IPv6' && !i.internal && !/^(docker|br-|veth|bridge)/.test(name)))
    .sort((a, b) => Number(a.address.startsWith('fe80')) - Number(b.address.startsWith('fe80')))[0]?.address.replace(/%.*$/, '') ?? '';
  const neighbour6 = own6.replace(/.$/, (c) => (c === '1' ? '2' : '1'));
  await mirrors.ensureMirror({ pool, checkout });
  // Only the mirror has this commit: a clone that ends on it was answered by the mirror.
  fs.writeFileSync(path.join(checkout, 'only-in-mirror'), 'x\n');
  git(checkout, 'add', '.');
  git(checkout, 'commit', '--quiet', '-m', 'mirror only');
  const marked = git(checkout, 'rev-parse', 'HEAD');
  git(checkout, 'push', '--quiet', mirrors.path(pool), 'HEAD:refs/heads/main');

  let tools;
  let leaveA;
  await check('a job in a real container finishes, and its clone came from the mirror without a word to the requester', async () => {
    console.log(`INFO the broker listens on ${at.host}:${at.port}`);
    if (!process.env.DN_TEST_SKIP_CLAUDE) await llm.load();
    leaveA = await hold(PEER_A, 'held-a');
    tools = await launch('tools', PEER_A, { env: llm.env(), script: `
step tunnel "curl -sS -o /dev/null -w '%{http_code}' https://example.com"
step nodefetch "node -e \\"fetch('https://example.com').then((r) => console.log(r.status))\\""
step hostport "curl -sS -H 'x-via: proxy' -o /dev/null -w '%{http_code}' http://host.docker.internal:${hostPort}/"
step hostconnect "curl -sS -o /dev/null https://host.docker.internal:${hostPort}/"
step bridge "curl -sS -o /dev/null -w '%{http_code}' http://${bridgeGateway}:${hostPort}/"
step lan "curl -sS -o /dev/null -w '%{http_code}' http://${lan}:${hostPort}/"
step notoken "curl -sS -o /dev/null -w '%{http_code}' -x http://dn-broker:${at.port} http://example.com/"
step neighbour "curl -sS -m 20 -o /dev/null -w '%{http_code}' http://${neighbour}:${hostPort}/"
step mapped "curl -sS -m 20 -o /dev/null -w '%{http_code}' 'http://[::ffff:${lan}]:${hostPort}/'"
step neighbour6 "${neighbour6 ? `curl -sS -m 20 -o /dev/null -w '%{http_code}' 'http://[${neighbour6}]:${hostPort}/'` : 'echo 403'}"
step dotted "curl -sS -o /dev/null -w '%{http_code}' 'https://api.github.com./repos/dn-test/alpha?spelled=dot'"
step capitals "curl -sS -o /dev/null -w '%{http_code}' 'https://API.GitHub.com/repos/dn-test/alpha?spelled=capitals'"
step otherport "curl -sS -m 20 -o /dev/null https://api.github.com:8443/"
step sshhost "curl -sS -m 20 -o /dev/null https://ssh.github.com/"
step plainforge "curl -sS -o /dev/null -w '%{http_code}' http://github.com/dn-test/alpha"
step download "curl -sS -m 60 -o /dev/null -w '%{http_code}' https://codeload.github.com/"
step bareaddress "curl -sS -m 60 -o /dev/null -w '%{http_code}' http://1.1.1.1/"
step reach "python3 /dn/runs/bin/reach.py ${hostPort},2375 host.docker.internal=host.docker.internal:${hostPort} docker-desktop-host=192.168.65.254:${hostPort} bridge-gateway=${bridgeGateway}:${hostPort} bridge-gateway-docker-api=${bridgeGateway}:2375 lan=${lan}:${hostPort} lan-docker-api=${lan}:2375"
step resolv "cat /etc/resolv.conf; getent hosts dn-broker"
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
    assert.equal(tools.out('lan'), '403');
    assert.ok(!hostSeen.includes('proxy'), 'nothing came through the broker');
    assert.equal(tools.out('notoken'), '407', 'and the broker itself answers nothing without a token');
  });

  await check('a neighbour on any network of this machine is refused through the broker, in either family and however the address is written', () => {
    console.log(`INFO neighbours tried: ${neighbour}, ::ffff:${lan}, ${neighbour6 || 'none (this machine has no IPv6 address off loopback)'}`);
    assert.equal(tools.out('neighbour'), '403');
    assert.equal(tools.out('mapped'), '403');
    assert.equal(tools.out('neighbour6'), '403');
  });

  await check('the forge is read under every spelling of its hosts and on 443 only; its ssh host is refused, its download host and a bare address are the internet', () => {
    assert.equal(tools.out('dotted'), '403');
    assert.equal(tools.out('capitals'), '403');
    for (const spelled of ['dot', 'capitals']) assert.ok(forgeSeen.some((x) => x.line === `GET api.github.com/repos/dn-test/alpha?spelled=${spelled}`), `the requester answered the one spelled with ${spelled}`);
    assert.match(tools.out('otherport'), /403/);
    assert.match(tools.out('sshhost'), /403/);
    assert.equal(tools.out('plainforge'), '403');
    assert.ok(!forgeSeen.some((x) => /codeload|ssh\.github|:8443/.test(x.line)));
    console.log(`INFO through the broker: codeload.github.com answered ${tools.out('download')}, http://1.1.1.1/ answered ${tools.out('bareaddress')}`);
    assert.match(tools.out('download'), /^[2-5]\d\d$/);
    assert.notEqual(tools.out('download'), '403', 'not the broker\'s refusal');
    assert.match(tools.out('bareaddress'), /^[23]\d\d$/);
  });

  await check('ignoring the proxy leads nowhere: not to the internet by name or address, TCP or UDP, not to this machine by any of its addresses, its network or its docker API, and the container\'s resolver knows no name outside', async () => {
    const reach = tools.out('reach');
    console.log(`INFO without the proxy, from inside a job container:\n${reach.split('\n').map((l) => `INFO   ${l}`).join('\n')}`);
    assert.equal(tools.steps().reach, 0, reach);
    assert.deepEqual(unreached(reach), []);
    for (const tried of ['host.docker.internal', 'docker-desktop-host', 'bridge-gateway', 'bridge-gateway-docker-api', 'lan', 'lan-docker-api', 'the internet by name', 'the internet by address',
      'a resolver over TCP', 'a resolver over UDP', 'a name outside', 'its own network', 'the cloud metadata address', 'the docker socket', 'IPv6']) assert.ok(reach.includes(`${tried}`), tried);
    assert.ok(!hostSeen.includes('direct'), 'the service on this machine never heard from it');
    // The one name its resolver knows is its relay's, on its own network.
    assert.match(tools.out('resolv'), /^10\.213\.\d+\.\d+\s+dn-broker$/m);
    // The relay answers on that network only: from the default bridge its port is shut.
    const name = tools.container.name;
    const [inside, outside] = (await sh('inspect', `${name}-relay`, '--format', `{{(index .NetworkSettings.Networks "${name}").IPAddress}} {{.NetworkSettings.Networks.bridge.IPAddress}}`)).split(' ');
    assert.ok(net.isIPv4(inside) && net.isIPv4(outside));
    const knock = await docker(['run', '--rm', '--label', `dn.base=${BASE}`, tag, 'curl', '-sS', '-m', '4', '-o', '/dev/null', '-w', '%{http_code}', `http://${outside}:${at.port}/`]);
    assert.notEqual(knock.code, 0);
    assert.match(knock.stderr, /refused|Couldn't connect|Failed to connect/i);
    // And the job container is on no network but its own.
    assert.equal(await sh('inspect', name, '--format', '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}'), name);
    assert.match(await sh('network', 'inspect', name, '--format', '{{.Internal}} {{json .IPAM.Config}}'), /^true \[\{"Subnet":"10\.213\.\d+\.\d+\/29"\}\]$/, 'internal, and no gateway address');
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
    const leaveB = await hold(PEER_B, 'held-b');
    const other = await launch('other-peer', PEER_B, { script: 'step runs "ls /dn/runs"\nstep work "ls /work/jobs"\nexit 0\n' });
    assert.equal((await other.outcome).ok, true);
    assert.notEqual(other.container.name, tools.container.name);
    assert.deepEqual(other.out('runs').split('\n').sort(), ['bin', 'other-peer']);
    assert.equal(other.out('work'), 'other-peer');
    for (const c of [tools.container, other.container]) assert.match(c.name, /^dn-[0-9a-z]{25}-[0-9a-z]{25}$/);
    // Every container of this run by its labels: a job container and its relay for each pair, and nothing else.
    const listed = (await sh('ps', '-a', ...mine, '--format', '{{.Names}} {{.Label "dn.peer"}} {{.Label "dn.pool"}} {{.Label "dn.relay"}}')).split('\n').map((l) => l.trim()).sort();
    assert.deepEqual(listed, [[tools.container.name, PEER_A], [other.container.name, PEER_B]].flatMap(([name, peer]) => [`${name} ${peer} ${pool.id}`, `${name}-relay ${peer} ${pool.id} ${name}`]).sort());
    // Its network and its volume say whose they are as well.
    const whose = '{{index .Labels "dn.peer"}} {{index .Labels "dn.pool"}} {{index .Labels "dn.base"}}';
    for (const [name, peer] of [[tools.container.name, PEER_A], [other.container.name, PEER_B]]) {
      assert.equal(await sh('network', 'inspect', name, '--format', whose), `${peer} ${pool.id} ${BASE}`);
      assert.equal(await sh('volume', 'inspect', name.replace('dn-', 'dn-work-'), '--format', whose), `${peer} ${pool.id} ${BASE}`);
    }
    // Nothing is shared between a job container and its relay, or between two peers' containers: no volume, no namespace.
    const held = '{{range .Mounts}}{{.Type}}:{{if .Name}}{{.Name}}{{else}}{{.Source}}{{end}}:{{.Destination}} {{end}}| {{json .HostConfig.VolumesFrom}} {{json .HostConfig.PidMode}} {{json .HostConfig.IpcMode}} {{json .HostConfig.UTSMode}} {{json .HostConfig.UsernsMode}} {{.HostConfig.Privileged}}';
    for (const c of [tools.container, other.container]) {
      const volume = c.name.replace('dn-', 'dn-work-');
      assert.match(await sh('inspect', c.name, '--format', held), new RegExp(`^(volume:${volume}:/work bind:\\S+/\\.containers/${c.name}:/dn/runs|bind:\\S+/\\.containers/${c.name}:/dn/runs volume:${volume}:/work) \\| null "" "(private|shareable)" "" "" false$`));
      assert.match(await sh('inspect', `${c.name}-relay`, '--format', held), /^\| null "" "(private|shareable)" "" "" false$/, 'a relay holds no volume and no directory');
    }
    await leaveB();
  });

  await check('one peer\'s container cannot reach another\'s, and a forward opened for one job is of no use to a job in another container', async () => {
    const echo = net.createServer((c) => c.on('data', (d) => c.write(`echo:${d}`)).on('error', () => {}));
    const echoPort = await new Promise((resolve) => echo.listen(0, '127.0.0.1', () => resolve(echo.address().port)));
    const owner = await launch('owner', PEER_A, { forwardTo: { echo: echoPort }, script: `
node -e "require('http').createServer((q, s) => s.end('peer a')).listen(8099, '0.0.0.0')" &
step forward "node /dn/runs/bin/fwd.js"
step where "echo \\$DN_FORWARD_ECHO; hostname -i"
step wait "while [ ! -f /dn/runs/$DN_RUN_ID/go ]; do sleep 0.2; done"
exit 0
` });
    await until('the owner waits', () => fs.existsSync(path.join(owner.dir, 'out-wait.txt')));
    assert.equal(owner.out('forward'), 'echo:ping', 'the job it was opened for uses it');
    const [helper, ownerIp] = owner.out('where').split('\n');
    assert.match(helper, /^127\.0\.0\.1:\d+$/);
    const relayIp = await sh('inspect', `${owner.container.name}-relay`, '--format', `{{(index .NetworkSettings.Networks "${owner.container.name}").IPAddress}}`);
    const intruder = await launch('intruder', PEER_B, { script: `
step theirs "curl -sS -m 6 -o /dev/null -w '%{http_connect}' -p -x $HTTP_PROXY http://echo.forward.dn:1/"
step reach "python3 /dn/runs/bin/reach.py 8099 the-other-peers-container=${ownerIp}:8099 its-forward-listener=${ownerIp}:${helper.split(':')[1]} its-relay=${relayIp}:${at.port}"
exit 0
` });
    assert.equal((await intruder.outcome).ok, true);
    assert.match(intruder.out('theirs'), /404/, 'the name means nothing under another job\'s token');
    const reach = intruder.out('reach');
    console.log(`INFO from another peer's container:\n${reach.split('\n').slice(0, 3).map((l) => `INFO   ${l}`).join('\n')}`);
    assert.deepEqual(unreached(reach), []);
    assert.ok(reach.includes('the-other-peers-container') && reach.includes('its-forward-listener') && reach.includes('its-relay'));
    fs.writeFileSync(path.join(owner.dir, 'go'), '');
    assert.equal((await owner.outcome).ok, true);
    echo.close();
  });

  await check('the adb client in the image lists devices through the filter, and its connect, forward and reverse never reach the server behind it', async () => {
    const client = Number(/version \d+\.\d+\.(\d+)/.exec(await sh('run', '--rm', '--network', 'none', '--label', `dn.base=${BASE}`, tag, 'adb', 'version'))[1]);
    // A stand-in server of the client's own version behind the filter: the client has
    // no reason to replace it, and no device of this machine is touched.
    const server = await fakeAdb({ version: client });
    const filter = createAdbFilter({ target: { host: '127.0.0.1', port: server.port } });
    const job = await launch('adb', PEER_A, { forwardTo: { adb: (await filter.start()).port }, script: `
step where "echo \\$ADB_SERVER_SOCKET"
step devices "adb devices"
step connect "adb connect 127.0.0.1:1"
step forward "adb forward tcp:0 tcp:1"
step reverse "adb -s emulator-5554 reverse tcp:1 tcp:2"
exit 0
` });
    assert.equal((await job.outcome).ok, true);
    assert.match(job.out('where'), /^tcp:127\.0\.0\.1:\d+$/);
    assert.match(job.out('devices'), /emulator-5554\tdevice/);
    assert.match(job.out('connect'), /not offered to a task on this machine: host:connect:127\.0\.0\.1:1/);
    assert.match(job.out('forward'), /not offered to a task on this machine/);
    assert.deepEqual([job.steps().devices, job.steps().forward !== 0, job.steps().reverse !== 0], [0, true, true]);
    assert.deepEqual(server.asked.filter((service) => /connect|forward|reverse|kill/.test(service)), [], `the server heard ${JSON.stringify(server.asked)}`);
    assert.ok(server.asked.includes('host:devices'));
    console.log(`INFO adb 1.0.${client} in the image: devices listed, connect, forward and reverse refused by the filter`);
    await filter.stop();
    await server.close();
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

    const stopped = await stopJob(goes.run, containers);
    assert.equal(stopped.state, 'stopped');
    assert.equal(await groupAlive(goes), false);
    assert.equal(await sleeping(1), 0, 'its background child went with it');
    assert.equal(await groupAlive(stays), true, 'the other job runs on');
    assert.equal(await sh('exec', stays.container.name, 'sh', '-c', 'ls /work/jobs'), 'stays');
    await goes.outcome;
    fs.writeFileSync(path.join(stays.dir, 'go'), '');
    assert.equal((await stays.outcome).ok, true);
    assert.equal(await sleeping(2), 1, 'what left its group and its environment is there for as long as the container is');
  });

  await check('a container goes with its last job - relay, network and volume too - and the pair\'s next job starts in a new one from the image, with nothing the jobs before it installed, wrote or left running', async () => {
    const name = tools.container.name;
    const volume = name.replace('dn-', 'dn-work-');
    assert.deepEqual(await under(name), [name, `${name}-relay`, `network ${name}`, `volume ${volume}`]);
    // What the jobs so far left in it: two programs installed, files in the volume, a process no job owns.
    assert.equal(await sh('exec', name, 'sh', '-c', 'ls /usr/games/cowsay /usr/local/bin/cowsay && echo left > /work/left-by-a-job && pgrep -c -f "sleep 60[2]"'), '/usr/games/cowsay\n/usr/local/bin/cowsay\n1');
    const leaving = Date.now();
    await leaveA();
    const left = Date.now();
    assert.deepEqual(await under(name), [], 'nothing of the pair is on the engine between its jobs');
    assert.deepEqual(containers.list().filter((c) => c.name === name), []);
    const stay = await hold(PEER_A, 'held-fresh');
    const made = Date.now();
    const fresh = await launch('fresh', PEER_A, { script: `
step programs "ls /usr/games/cowsay /usr/local/bin/cowsay"
step work "ls -A /work /work/jobs"
step strays "pgrep -c -f 'sleep 60[2]'"
exit 0
` });
    assert.equal((await fresh.outcome).ok, true);
    console.log(`INFO the container of a pair between two jobs on this engine: removed in ${left - leaving} ms, made anew in ${made - left} ms`);
    assert.equal(fresh.container.name, name, 'the same name');
    assert.match(fresh.out('programs'), /cowsay.*No such file.*\n.*cowsay.*No such file/);
    assert.equal(fresh.out('work'), '/work:\njobs\n\n/work/jobs:\nfresh');
    assert.equal(fresh.out('strays'), '0');
    await stay();
    assert.deepEqual(await under(name), []);
  });

  await check('what a job put first on the container\'s PATH, into git\'s system settings and templates and under /work runs neither for the host\'s start, questions and stop nor in the runner of the job beside it', async () => {
    // Every planted program says who ran it: a job by its run id, the host by having none.
    const plants = await launch('plants', PEER_C, { script: `
trap '' TERM
ran=/dn/runs/plants/ran.txt
for t in sh setsid tr grep sleep rm; do
  cat > /usr/local/bin/$t <<EOF
#!/bin/dash
echo "$t \\\${DN_RUN_ID:-host}" >> $ran
exec /usr/bin/$t "\\$@"
EOF
  chmod +x /usr/local/bin/$t
done
mkdir -p /dn/runs/plants/hooks /usr/share/git-core/templates/hooks
for at in /dn/runs/plants/hooks/post-checkout /usr/share/git-core/templates/hooks/post-checkout /dn/runs/plants/uploadpack; do
  cat > $at <<EOF
#!/bin/dash
echo "$at \\\${DN_RUN_ID:-host}" >> $ran
EOF
  chmod +x $at
done
git config --file /etc/gitconfig core.hooksPath /dn/runs/plants/hooks
git init --quiet --bare /work/cache.git
git -C /work/cache.git config remote.origin.url /dn/runs/plants/elsewhere
git -C /work/cache.git config remote.origin.uploadpack /dn/runs/plants/uploadpack
echo planted > "$out/out-planted.txt"
while [ ! -f "$out/go" ]; do /usr/bin/sleep 0.2; done
exit 0
` });
    await until('the first job has planted', () => fs.existsSync(path.join(plants.dir, 'out-planted.txt')));
    const beside = await launch('beside', PEER_C, { script: 'exit 0\n' });
    assert.equal(beside.container.name, plants.container.name);
    assert.equal((await beside.outcome).ok, true);
    // The first job ignores TERM, so its stop waits out the grace and kills.
    assert.equal((await stopJob(plants.run, containers)).state, 'stopped');
    await plants.outcome;
    const ran = [...new Set(fs.readFileSync(path.join(plants.dir, 'ran.txt'), 'utf8').trim().split('\n'))];
    assert.deepEqual(ran, ['sh beside'], 'only the second job\'s own agent went through what was planted, by looking sh up on PATH');
  });

  if (process.env.DN_TEST_SKIP_CLAUDE) {
    console.log('SKIP the real agent run: DN_TEST_SKIP_CLAUDE is set');
  } else {
    await check('a real agent answers through the broker on this machine\'s credential, with only a placeholder inside the container', async () => {
      assert.equal(llm.state().state, 'ready', llm.state().detail);
      const leave = await hold(PEER_A, 'held-agent');
      const job = await launch('agent', PEER_A, { env: llm.env(), prompt: 'Reply with exactly: pong' });
      // While it runs: what every process in the container holds in its environment.
      await until('the agent is up', () => fs.existsSync(path.join(job.dir, 'log.jsonl')), 120000);
      const environ = await sh('exec', job.container.name, 'sh', '-c', 'cat /proc/[0-9]*/environ 2>/dev/null | tr "\\0" "\\n" | sort -u');
      const guard = setTimeout(() => stopJob(job.run, containers), 300000);
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
      await leave();
    });
  }

  await check('what a container holds of the disk is measured: its layer, its volume and its run records, a directory it gave to another user and every empty file included; and its run records still, once it is gone', async () => {
    const name = tools.container.name;
    const MiB = 2 ** 20;
    const leave = await hold(PEER_A, 'held-measured');
    const before = await containers.usage(name);
    await sh('exec', name, 'sh', '-c', [
      'dd if=/dev/urandom of=/root/layer.bin bs=1M count=10 2>/dev/null',
      'mkdir -m 700 /work/private && dd if=/dev/urandom of=/work/private/volume.bin bs=1M count=15 2>/dev/null',
      'mkdir /work/private/many && cd /work/private/many && i=0 && while [ $i -lt 5000 ]; do : > f$i; i=$((i+1)); done',
      'chown -R 1234:1234 /work/private',
      'dd if=/dev/urandom of=/dn/runs/records.bin bs=1M count=2 2>/dev/null',
    ].join(' && '));
    const started = Date.now();
    const after = await containers.usage(name);
    console.log(`INFO disk use of ${name}: ${before} bytes, then ${after} (${after - before} more) measured in ${Date.now() - started} ms`);
    // The directory, the file and the five thousand in the volume, and the one file among the records.
    const least = 27 * MiB + 5004 * 4096;
    assert.ok(after - before >= least && after - before < least + 2 * MiB, `${after - before} for ${least}`);
    assert.equal(await sh('ps', '-a', '-q', ...mine, '--filter', 'label=dn.probe'), '', 'what measured it is gone');
    assert.equal(await containers.usage('dn-no-such-container'), null);
    assert.deepEqual(await containers.overQuota(), [], 'under the 20 GiB a container may hold, none is named');
    await leave();
    const kept = await containers.usage(name);
    console.log(`INFO disk use under ${name} with the container gone: ${kept} bytes of run records`);
    assert.ok(kept >= 2 * MiB + 4096 && kept < before + 2 * MiB + 4096 && kept < after - 25 * MiB, `${kept} of ${before} and ${after}`);
    assert.equal(await sh('ps', '-a', '-q', ...mine, '--filter', 'label=dn.probe'), '');
  });

  await check('with its jobs over nothing of this run is left on the engine; a container no job of this daemon is in goes at a sweep once it has been seen for the idle time, and so does an image this daemon built that no job is started in', async () => {
    const left = async () => [await sh('ps', '-a', '-q', ...mine), await sh('volume', 'ls', '-q', ...mine), await sh('network', 'ls', '-q', ...mine)];
    assert.deepEqual(await left(), ['', '', '']);
    assert.deepEqual(containers.list(), []);
    // One an earlier daemon made, and an image of this state directory that is not the one jobs are started in.
    const stray = await createContainers({ broker: () => broker.address() }).acquire({ pool, peer: PEER_C, runId: 'left-behind' });
    const older = path.join(scratch, 'older');
    fs.mkdirSync(older);
    fs.writeFileSync(path.join(older, 'Dockerfile'), `FROM ${tag}\nLABEL dn.test=older\n`);
    await sh('build', '-q', '--label', `dn.base=${BASE}`, '-t', 'dn-test-agent:older', older);
    await sh('build', '-q', '--label', `dn.base=${BASE}`, '-t', 'dn-test-agent-derived:older', older);
    const images = async () => (await sh('image', 'ls', ...mine, '--format', '{{.Repository}}:{{.Tag}}')).split('\n').filter(Boolean).sort();
    // The image of this run carries the label when this run built it.
    const others = async () => (await images()).filter((i) => i !== tag);
    assert.deepEqual(await others(), ['dn-test-agent-derived:older', 'dn-test-agent:older']);
    await containers.sweep();
    assert.deepEqual(await under(stray.name), [stray.name, `${stray.name}-relay`, `network ${stray.name}`, `volume ${stray.name.replace('dn-', 'dn-work-')}`], 'it is given the idle time');
    assert.deepEqual(await others(), ['dn-test-agent-derived:older'], 'the image under this daemon\'s name went, the one built on top of it under another did not');
    assert.equal(await sh('image', 'inspect', '--format', '{{.Id}}', tag) !== '', true, 'and the image jobs are started in is there');
    clock.skew = 7 * 3600 * 1000;
    await containers.sweep();
    assert.deepEqual(await left(), ['', '', '']);
    await sh('image', 'rm', 'dn-test-agent-derived:older');
  });

  console.log(`\nall ${checks} checks passed`);
} finally {
  await broker.stop().catch(() => {});
  hostService.close();
  for (const id of (await docker(['ps', '-a', '-q', ...mine])).stdout.split('\n').filter(Boolean)) await docker(['rm', '-f', id]);
  for (const v of (await docker(['volume', 'ls', '-q', ...mine])).stdout.split('\n').filter(Boolean)) await docker(['volume', 'rm', '-f', v]);
  for (const n of (await docker(['network', 'ls', '-q', ...mine])).stdout.split('\n').filter(Boolean)) await docker(['network', 'rm', n]);
  for (const i of (await docker(['image', 'ls', ...mine, '--format', '{{.Repository}}:{{.Tag}}'])).stdout.split('\n').filter((i) => i && i !== tag)) await docker(['image', 'rm', i]);
  if (tag && !process.env.DN_TEST_KEEP_IMAGE) await docker(['image', 'rm', tag]);
  fs.rmSync(scratch, { recursive: true, force: true });
}
process.exit(0);
