// The broker, driven by plain TCP clients and a real git, against an internet that is a
// table in this file: who may speak to it, what it terminates and what it tunnels, where
// it refuses to connect, what reaches the requester, the mirror and the model provider.
// Run: node test/executor-broker.mjs

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import zlib from 'node:zlib';
import { execFile, execFileSync, spawn } from 'node:child_process';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'dn-broker-'));
const forgeDir = path.join(scratch, 'forge');
fs.mkdirSync(forgeDir);
fs.writeFileSync(path.join(scratch, 'gitconfig'), `[user]\n\tname = T\n\temail = t@example.com\n[init]\n\tdefaultBranch = main\n[url "${forgeDir}/"]\n\tinsteadOf = https://github.com/\n`);
Object.assign(process.env, {
  DN_BASE_DIR: path.join(scratch, 'base'), DN_BROKER_BIND: '127.0.0.1', DN_RELAY_HOST: '127.0.0.1', DN_FORGE_ANSWER_TIMEOUT_MS: '1500',
  DN_JOB_MODEL_REQUESTS: '12', DN_JOB_MODEL_BYTES: '300000',
  GIT_CONFIG_GLOBAL: path.join(scratch, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1',
});
const { createBroker, brokerBindAddress, deniedAddress, forgeHosts, MODEL_HOSTS } = await import('../src/executor/broker.js');
const { createCA } = await import('../src/executor/ca.js');
const { createLLM, PLACEHOLDER } = await import('../src/executor/llm.js');
const { createMirrors } = await import('../src/executor/mirror.js');
const { FORGE_BODY_CAP } = await import('../src/paths.js');

let checks = 0;
const check = async (name, fn) => { await fn(); checks++; console.log(`PASS ${name}`); };
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const closers = [];
const listen = (server, host = '127.0.0.1') => new Promise((resolve) => server.listen(0, host, () => { closers.push(() => server.close()); resolve(server.address().port); }));

// ---- the internet: names, the addresses they resolve to, and what answers there

const names = new Map(); // name -> [{ address, family }] or a function returning them
const routes = new Map(); // "address:port" -> local port
const lookups = [];
const dials = [];
const lookup = async (host) => {
  lookups.push(host);
  if (net.isIP(host)) return [{ address: host, family: net.isIP(host) }];
  const hit = names.get(host);
  if (!hit) throw Object.assign(new Error('not found'), { code: 'ENOTFOUND' });
  return typeof hit === 'function' ? hit() : hit;
};
const connect = ({ host, port }) => new Promise((resolve, reject) => {
  dials.push(`${host}:${port}`);
  const local = routes.get(`${host}:${port}`);
  if (!local) return reject(Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }));
  const s = net.connect(local, '127.0.0.1', () => resolve(s));
  s.once('error', reject);
});
const publish = (name, address, port, local) => {
  names.set(name, [{ address, family: net.isIP(address) }]);
  routes.set(`${address}:${port}`, local);
};

const echo = net.createServer((s) => { s.on('error', () => {}); s.write('hello from the internet\n'); s.pipe(s); });
publish('tunnel.test', '93.184.216.34', 443, await listen(echo));
routes.set('93.184.216.34:8443', echo.address().port);

const plainSeen = [];
const plain = http.createServer((req, res) => {
  plainSeen.push({ method: req.method, url: req.url, headers: req.headers });
  res.writeHead(200, { 'content-type': 'text/plain', 'x-from': 'plain.test' });
  res.end(`plain says ${req.url}`);
});
publish('plain.test', '93.184.216.40', 80, await listen(plain));

// The model provider: TLS under a CA of its own, recording what reaches it.
const providerCa = await createCA({ dir: path.join(scratch, 'provider-ca') }).authority(MODEL_HOSTS);
const providerLeaf = await providerCa.leaf('api.anthropic.com');
const providerSeen = [];
let providerAnswer = (req, res) => { res.writeHead(200, { 'content-type': 'application/json', 'request-id': 'req_1' }); res.end('{"ok":true}'); };
const provider = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    providerSeen.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks) });
    providerAnswer(req, res);
  });
});
const providerTls = tls.createServer({ key: providerLeaf.key, cert: providerLeaf.cert }, (s) => provider.emit('connection', s));
providerTls.on('tlsClientError', () => {});
publish('api.anthropic.com', '160.79.104.10', 443, await listen(providerTls));

// ---- the forge, as the requester would answer for it

const forgeSeen = [];
let forgeAnswer = async () => ({ status: 200, headers: { 'content-type': 'application/json' }, body: Buffer.from('{"stub":true}').toString('base64') });
const onForge = (job, request) => { forgeSeen.push({ job, request }); return forgeAnswer(job, request); };

// ---- a repository on the stand-in forge, its checkout and its mirror

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
  return { bare, checkout, pool: { id: `github.com/${owner}/${name}`, forge: 'github', host: 'github.com', owner, repo: name } };
}

const logged = [];
const mirrors = createMirrors();
const llmHome = fs.mkdtempSync(path.join(scratch, 'home-'));
const llm = createLLM({ env: { ANTHROPIC_API_KEY: 'sk-ant-api03-the-real-key' }, platform: 'linux', home: llmHome, user: 'op' });
await llm.load();
const broker = createBroker({ log: (...a) => logged.push(a.join(' ')), ca: createCA(), llm, mirrors, onForge, lookup, connect, upstreamCa: fs.readFileSync(providerCa.certPath) });

// ---- clients

const basic = (user, pass) => `Proxy-Authorization: Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}\r\n`;
let port = 0;

// One CONNECT, by hand. Resolves once the proxy's answer is read: `{ status, head, socket, rest }`,
// and for a refusal `body` once the proxy has closed.
function tunnel(target, auth) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    let buf = Buffer.alloc(0);
    socket.on('error', reject);
    socket.on('connect', () => socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${auth}\r\n`));
    const onData = (c) => {
      buf = Buffer.concat([buf, c]);
      const i = buf.indexOf('\r\n\r\n');
      if (i < 0) return;
      socket.off('data', onData);
      const head = buf.subarray(0, i).toString();
      const status = Number(head.split(' ')[1]);
      const rest = [buf.subarray(i + 4)];
      if (status === 200) return resolve({ status, head, socket, rest: rest[0] });
      socket.on('data', (d) => rest.push(d));
      socket.on('close', () => resolve({ status, head, socket, body: Buffer.concat(rest).toString() }));
    };
    socket.on('data', onData);
  });
}

// A TLS connection to `host` through the proxy, trusting only `caPem`.
async function secure(job, host, caPem = fs.readFileSync(job.caCertPath)) {
  const t = await tunnel(`${host}:443`, basic('dn', job.token));
  assert.equal(t.status, 200, t.head);
  return new Promise((resolve, reject) => {
    const s = tls.connect({ socket: t.socket, servername: host, ca: caPem }, () => resolve(s));
    s.on('error', reject);
  });
}

function send(socket, host, { method = 'GET', path: p = '/', headers = {}, body = null, chunked = false, onChunk = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ createConnection: () => socket, host, method, path: p, headers: { ...headers, ...(chunked ? { 'transfer-encoding': 'chunked' } : {}) } });
    req.on('error', reject);
    req.on('response', (res) => {
      const chunks = [];
      res.on('data', (c) => { chunks.push(c); if (onChunk) onChunk(c, res); });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, raw: res.rawHeaders, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    if (body && chunked) { for (let i = 0; i < body.length; i += 1 << 20) req.write(body.subarray(i, i + (1 << 20))); req.end(); } else req.end(body || undefined);
  });
}
const request = async (job, host, opts) => send(await secure(job, host), host, opts);

// git, as a container would run it: through the proxy, trusting the job's CA.
function gitVia(job, args, cwd = scratch) {
  return new Promise((resolve) => {
    const bundle = path.join(scratch, `bundle-${job.token.slice(0, 8)}.crt`);
    fs.writeFileSync(bundle, fs.readFileSync(job.caCertPath));
    execFile('git', ['-c', `http.proxy=${job.proxyUrl}`, '-c', 'http.proxyAuthMethod=basic', ...args], {
      cwd, encoding: 'utf8',
      env: { PATH: process.env.PATH, HOME: scratch, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_SSL_CAINFO: bundle, GIT_TERMINAL_PROMPT: '0',
        GIT_AUTHOR_NAME: 'A', GIT_AUTHOR_EMAIL: 'a@example.com', GIT_COMMITTER_NAME: 'A', GIT_COMMITTER_EMAIL: 'a@example.com' },
    }, (err, stdout, stderr) => resolve({ code: err ? err.code ?? 1 : 0, stdout, stderr }));
  });
}

try {
  await check('the bind address is loopback under Docker Desktop, the bridge gateway on Linux, and never every interface', async () => {
    assert.equal(await brokerBindAddress({ platform: 'darwin', override: '', bridgeGateway: async () => '172.17.0.1' }), '127.0.0.1');
    assert.equal(await brokerBindAddress({ platform: 'linux', override: '', bridgeGateway: async () => '172.17.0.1' }), '172.17.0.1');
    assert.equal(await brokerBindAddress({ platform: 'linux', override: '10.9.8.7', bridgeGateway: async () => '172.17.0.1' }), '10.9.8.7');
    for (const none of [null, '', 'fe80::1']) {
      await assert.rejects(brokerBindAddress({ platform: 'linux', override: '', bridgeGateway: async () => none }), /no gateway address/);
    }
  });

  await check('a job cannot be admitted before the broker listens', async () => {
    assert.equal(broker.address(), null);
    await assert.rejects(broker.addJob({ runId: 'early', pool: { id: 'github.com/a/b', forge: 'github', host: 'github.com', owner: 'a', repo: 'b' } }), /not listening/);
  });

  const at = await broker.start();
  port = at.port;
  const alpha = makeRepo('dn-test', 'alpha');
  const other = makeRepo('dn-test', 'other');
  await mirrors.ensureMirror({ pool: alpha.pool, checkout: alpha.checkout });
  await mirrors.ensureMirror({ pool: other.pool, checkout: other.checkout });
  const info = { runId: 'run-a', pool: alpha.pool, taskId: 'github.com/dn-test/alpha#review:7@op', requester: 'pk-of-requester' };
  const job = await broker.addJob(info);

  await check('a job gets a proxy URL with a token of its own and the CA to trust', async () => {
    assert.deepEqual(at, { host: '127.0.0.1', port });
    assert.match(job.token, /^[0-9a-f]{64}$/);
    assert.equal(job.proxyUrl, `http://dn:${job.token}@127.0.0.1:${port}`);
    assert.match(fs.readFileSync(job.caCertPath, 'utf8'), /BEGIN CERTIFICATE/);
    const second = await broker.addJob({ runId: 'run-b', pool: alpha.pool });
    assert.notEqual(second.token, job.token);
    await assert.rejects(broker.addJob({ runId: 'run-b', pool: alpha.pool }), /already admitted/);
    broker.removeJob('run-b');
  });

  await check('without a live token every request is answered 407 and nothing else happens', async () => {
    const before = { lookups: lookups.length, dials: dials.length, forge: forgeSeen.length };
    const cases = { none: '', 'an unknown token': basic('dn', 'f'.repeat(64)), 'the wrong user': basic('root', job.token), 'an empty token': basic('dn', ''),
      'another scheme': `Proxy-Authorization: Bearer ${job.token}\r\n`, 'not base64': 'Proxy-Authorization: Basic %%%\r\n', 'a removed job': basic('dn', (await broker.addJob({ runId: 'gone', pool: alpha.pool })).token) };
    broker.removeJob('gone');
    for (const [what, auth] of Object.entries(cases)) {
      for (const target of ['tunnel.test:443', 'api.github.com:443', 'api.anthropic.com:443']) {
        const r = await tunnel(target, auth);
        assert.equal(r.status, 407, `${what} -> ${target}`);
        assert.match(r.head, /Proxy-Authenticate: Basic realm="dn"/);
        assert.equal(r.body, '', what);
      }
      const r = await new Promise((resolve, reject) => {
        const s = net.connect(port, '127.0.0.1', () => s.write(`GET http://plain.test/x HTTP/1.1\r\nHost: plain.test\r\n${auth}\r\n`));
        let buf = '';
        s.on('data', (d) => { buf += d; });
        s.on('close', () => resolve(buf));
        s.on('error', reject);
      });
      assert.match(r, /^HTTP\/1\.1 407 /, what);
      assert.ok(r.endsWith('\r\n\r\n'), `${what}: no body`);
    }
    assert.deepEqual({ lookups: lookups.length, dials: dials.length, forge: forgeSeen.length }, before);
    assert.equal(plainSeen.length, 0);
  });

  await check('a host that is not the job\'s forge or the model provider is tunnelled untouched', async () => {
    const t = await tunnel('tunnel.test:443', basic('dn', job.token));
    assert.equal(t.status, 200);
    const got = [t.rest];
    t.socket.on('data', (d) => got.push(d));
    const payload = crypto.randomBytes(200000);
    t.socket.write(payload);
    const want = Buffer.concat([Buffer.from('hello from the internet\n'), payload]);
    for (let i = 0; i < 200 && Buffer.concat(got).length < want.length; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(sha(Buffer.concat(got)), sha(want));
    t.socket.destroy();
  });

  await check('a forge host is terminated here only on 443; any other port of it is a tunnel like any other', async () => {
    const s = await secure(job, 'api.github.com');
    const cert = s.getPeerX509Certificate();
    assert.equal(cert.subjectAltName, 'DNS:api.github.com');
    assert.equal(cert.checkIssued(new crypto.X509Certificate(fs.readFileSync(job.caCertPath))), true);
    assert.equal(s.alpnProtocol, false);
    s.destroy();
    names.set('api.github.com', [{ address: '93.184.216.34', family: 4 }]);
    const t = await tunnel('api.github.com:8443', basic('dn', job.token));
    assert.equal(t.status, 200);
    assert.equal(dials.at(-1), '93.184.216.34:8443');
    t.socket.destroy();
    names.delete('api.github.com');
  });

  await check('another pool\'s forge is not this job\'s: a GitLab job\'s github.com is a tunnel, its own host is read', async () => {
    assert.deepEqual(forgeHosts(alpha.pool), ['github.com', 'api.github.com', 'uploads.github.com']);
    const lab = { id: 'gitlab.example.org/group/sub/repo', forge: 'gitlab', host: 'gitlab.example.org', owner: 'group/sub', repo: 'repo' };
    assert.deepEqual(forgeHosts(lab), ['gitlab.example.org']);
    assert.deepEqual(forgeHosts({ ...alpha.pool, host: 'ghe.example.org' }), ['ghe.example.org']);
    const labJob = await broker.addJob({ runId: 'run-lab', pool: lab });
    names.set('github.com', [{ address: '93.184.216.34', family: 4 }]);
    const t = await tunnel('github.com:443', basic('dn', labJob.token));
    assert.equal(dials.at(-1), '93.184.216.34:443');
    t.socket.destroy();
    names.delete('github.com');
    const seen = forgeSeen.length;
    const r = await request(labJob, 'gitlab.example.org', { path: '/api/v4/projects/1' });
    assert.equal(r.status, 200);
    assert.equal(forgeSeen.length, seen + 1);
    assert.equal(forgeSeen.at(-1).request.host, 'gitlab.example.org');
    // The first job's connections are still answered under the CA it was given.
    assert.notEqual(labJob.caCertPath, job.caCertPath);
    assert.equal((await request(job, 'api.github.com', { path: '/zen' })).status, 200);
    broker.removeJob('run-lab');
  });

  await check('the broker refuses every address that is this machine, its network or the docker bridge', async () => {
    const own = Object.values(os.networkInterfaces()).flat().find((i) => !i.internal && i.family === 'IPv4');
    const refused = ['127.0.0.1', '127.8.9.10', '0.0.0.0', '10.0.0.5', '172.17.0.1', '172.31.255.254', '192.168.1.10', '169.254.169.254', '100.64.0.1',
      '100.127.255.254', '224.0.0.1', '255.255.255.255', '::1', '::', 'fe80::1', 'fd00::1', 'fc00::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', '64:ff9b::7f00:1',
      '2002:7f00:1::1', 'ff02::1', 'fe80::1%en0', ...(own ? [own.address] : [])];
    for (const a of refused) assert.equal(deniedAddress(a), true, a);
    for (const a of ['93.184.216.34', '8.8.8.8', '172.15.255.255', '172.32.0.1', '100.63.255.255', '100.128.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8']) assert.equal(deniedAddress(a), false, a);
    for (const junk of ['', 'example.com', '1.2.3', '999.1.1.1']) assert.equal(deniedAddress(junk), true, `not an address: ${junk}`);
    assert.equal(deniedAddress('203.0.113.9', { en9: [{ address: '203.0.113.9', family: 'IPv4' }] }), true, 'a public address of this machine is still this machine');

    const before = dials.length;
    names.set('localhost.evil.test', [{ address: '127.0.0.1', family: 4 }]);
    names.set('bridge.evil.test', [{ address: '172.17.0.1', family: 4 }]);
    names.set('lan.evil.test', [{ address: '192.168.1.10', family: 4 }]);
    names.set('six.evil.test', [{ address: '::1', family: 6 }]);
    names.set('mapped.evil.test', [{ address: '::ffff:127.0.0.1', family: 6 }]);
    names.set('metadata.evil.test', [{ address: '169.254.169.254', family: 4 }]);
    names.set('nothing.evil.test', []);
    for (const target of ['localhost.evil.test:443', 'bridge.evil.test:5037', 'lan.evil.test:22', 'six.evil.test:443', 'mapped.evil.test:443', 'metadata.evil.test:80',
      'nothing.evil.test:443', '127.0.0.1:8080', '[::1]:443', '10.1.2.3:443', `127.0.0.1:${port}`]) {
      const r = await tunnel(target, basic('dn', job.token));
      assert.equal(r.status, 403, `${target}: ${r.head}`);
      assert.match(r.body, /the broker does not connect to .*not a public internet address/, target);
    }
    for (const url of ['http://localhost.evil.test/', 'http://127.0.0.1:8080/x', 'http://bridge.evil.test:2375/containers/json']) {
      const r = await new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port, path: url, headers: { 'proxy-authorization': basic('dn', job.token).slice(21).trim(), host: new URL(url).host } }, (res) => {
          let b = '';
          res.on('data', (d) => { b += d; });
          res.on('end', () => resolve({ status: res.statusCode, body: b }));
        }).on('error', reject);
      });
      assert.equal(r.status, 403, url);
      assert.match(r.body, /does not connect/);
    }
    assert.equal(dials.length, before, 'nothing was dialled');
    // The host's names inside a container are refused by name: out here they resolve to nothing.
    const asked = lookups.length;
    for (const target of ['host.docker.internal:5037', 'gateway.docker.internal:80', 'HOST.DOCKER.INTERNAL:443']) {
      const r = await tunnel(target, basic('dn', job.token));
      assert.equal(r.status, 403, target);
      assert.match(r.body, /that name is this machine/);
    }
    assert.equal(lookups.length, asked);
    assert.equal((await tunnel('unknown.evil.test:443', basic('dn', job.token))).status, 502, 'a name that does not resolve is not a refusal, just an error');
  });

  await check('a name is resolved once and the connection goes to the address that passed, so a second answer never gets a look', async () => {
    // Public and private together: the public one is used.
    names.set('mixed.test', [{ address: '10.0.0.1', family: 4 }, { address: '93.184.216.34', family: 4 }]);
    let l = lookups.length;
    let t = await tunnel('mixed.test:443', basic('dn', job.token));
    assert.equal(t.status, 200);
    assert.deepEqual(lookups.slice(l), ['mixed.test']);
    assert.equal(dials.at(-1), '93.184.216.34:443');
    t.socket.destroy();
    // A resolver that says "public" the first time and "loopback" every time after.
    let asked = 0;
    names.set('rebind.test', () => (asked++ === 0 ? [{ address: '93.184.216.34', family: 4 }] : [{ address: '127.0.0.1', family: 4 }]));
    routes.set(`127.0.0.1:443`, echo.address().port);
    l = lookups.length;
    const d = dials.length;
    t = await tunnel('rebind.test:443', basic('dn', job.token));
    assert.equal(t.status, 200);
    assert.deepEqual(lookups.slice(l), ['rebind.test'], 'one resolution');
    assert.deepEqual(dials.slice(d), ['93.184.216.34:443'], 'and the dial is to its answer, by address');
    t.socket.destroy();
    assert.equal((await tunnel('rebind.test:443', basic('dn', job.token))).status, 403, 'the second connection is judged on the second answer');
    routes.delete('127.0.0.1:443');
  });

  await check('a plain http:// request is forwarded without the proxy\'s own headers', async () => {
    const r = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: 'http://plain.test/debian/dists/InRelease?x=1', headers: { 'proxy-authorization': basic('dn', job.token).slice(21).trim(), host: 'plain.test', 'proxy-connection': 'keep-alive', 'user-agent': 'apt' } }, (res) => {
        let b = '';
        res.on('data', (d) => { b += d; });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b }));
      }).on('error', reject);
    });
    assert.equal(r.status, 200);
    assert.equal(r.body, 'plain says /debian/dists/InRelease?x=1');
    assert.equal(r.headers['x-from'], 'plain.test');
    const seen = plainSeen.at(-1);
    assert.equal(seen.headers.host, 'plain.test');
    assert.equal(seen.headers['user-agent'], 'apt');
    assert.equal(seen.headers['proxy-authorization'], undefined);
    assert.equal(seen.headers['proxy-connection'], undefined);
  });

  await check('a forge request reaches the requester as host, method, path, headers and base64 body, and its answer comes back as sent', async () => {
    const answerBody = crypto.randomBytes(3000);
    forgeAnswer = async () => ({ status: 201, headers: { 'Content-Type': 'application/json', 'X-RateLimit-Remaining': '4999', etag: 'W/"abc"', 'content-length': '5', connection: 'close' }, body: answerBody.toString('base64') });
    const body = Buffer.from(JSON.stringify({ body: 'looks good', event: 'COMMENT' }));
    const r = await request(job, 'api.github.com', {
      method: 'POST', path: '/repos/dn-test/alpha/pulls/7/reviews?per_page=1&q=a%20b', body,
      headers: { authorization: 'token dn-placeholder', cookie: 'session=1', accept: 'application/vnd.github+json', 'content-type': 'application/json', 'content-length': body.length, 'x-github-api-version': '2022-11-28', 'user-agent': 'gh' },
    });
    const seen = forgeSeen.at(-1);
    assert.equal(seen.job, info, 'the job is the object that was admitted, so the requester knows the task');
    assert.deepEqual(seen.request, {
      host: 'api.github.com', method: 'POST', path: '/repos/dn-test/alpha/pulls/7/reviews?per_page=1&q=a%20b',
      headers: { accept: 'application/vnd.github+json', 'content-type': 'application/json', 'x-github-api-version': '2022-11-28', 'user-agent': 'gh' },
      body: body.toString('base64'),
    });
    assert.equal(r.status, 201);
    assert.equal(sha(r.body), sha(answerBody));
    assert.equal(r.headers['content-type'], 'application/json');
    assert.equal(r.headers['x-ratelimit-remaining'], '4999');
    assert.equal(r.headers.etag, 'W/"abc"');
    assert.equal(r.headers['content-length'], '3000', 'the length is the body\'s, whatever the requester claimed');
    // A Buffer is as good as base64, and an upload host goes the same way.
    forgeAnswer = async () => ({ status: 200, headers: {}, body: answerBody });
    assert.equal(sha((await request(job, 'uploads.github.com', { path: '/repos/dn-test/alpha/releases/1/assets' })).body), sha(answerBody));
    assert.equal(forgeSeen.at(-1).request.host, 'uploads.github.com');
  });

  await check('a 20 MiB body goes to the requester and comes back from it byte for byte, chunked or not', async () => {
    const up = crypto.randomBytes(20 * 2 ** 20);
    const down = crypto.randomBytes(20 * 2 ** 20);
    forgeAnswer = async () => ({ status: 200, headers: { 'content-type': 'application/octet-stream' }, body: down.toString('base64') });
    for (const chunked of [true, false]) {
      const r = await request(job, 'uploads.github.com', { method: 'POST', path: '/upload', body: up, chunked, headers: chunked ? {} : { 'content-length': up.length } });
      assert.equal(r.status, 200);
      assert.equal(sha(Buffer.from(forgeSeen.at(-1).request.body, 'base64')), sha(up), `request, chunked=${chunked}`);
      assert.equal(forgeSeen.at(-1).request.headers['transfer-encoding'], undefined);
      assert.equal(sha(r.body), sha(down), `response, chunked=${chunked}`);
    }
  });

  await check('a body over the 48 MiB one request may carry is refused with 413 and never reaches the requester', async () => {
    assert.equal(FORGE_BODY_CAP, 48 * 2 ** 20);
    const seen = forgeSeen.length;
    const exact = Buffer.alloc(FORGE_BODY_CAP, 1);
    assert.equal((await request(job, 'api.github.com', { method: 'POST', path: '/exact', body: exact, headers: { 'content-length': exact.length } })).status, 200);
    assert.equal(Buffer.from(forgeSeen.at(-1).request.body, 'base64').length, FORGE_BODY_CAP);
    const s = await secure(job, 'api.github.com');
    const r = await new Promise((resolve, reject) => {
      const req = http.request({ createConnection: () => s, host: 'api.github.com', method: 'POST', path: '/over', headers: { 'content-length': FORGE_BODY_CAP + 1 } });
      req.on('response', (res) => { let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => resolve({ status: res.statusCode, body: b })); });
      req.on('error', (e) => { if (e.code !== 'EPIPE' && e.code !== 'ECONNRESET') reject(e); });
      req.write(exact);
      req.end(Buffer.alloc(1));
    });
    assert.equal(r.status, 413);
    assert.match(JSON.parse(r.body).message, /over 48 MiB/);
    assert.equal(forgeSeen.length, seen + 1, 'only the one that fit');
  });

  await check('a requester that refuses, fails, stays silent or answers nonsense becomes a 502 whose JSON message says why', async () => {
    forgeAnswer = async () => ({ status: 403, headers: { 'content-type': 'application/json' }, body: Buffer.from('{"message":"this task may not merge pull requests"}').toString('base64') });
    let r = await request(job, 'api.github.com', { method: 'PUT', path: '/repos/dn-test/alpha/pulls/7/merge' });
    assert.equal(r.status, 403, 'a refusal by rule is the requester\'s own 403');
    assert.equal(JSON.parse(r.body).message, 'this task may not merge pull requests');

    forgeAnswer = async () => { throw new Error('the key has expired'); };
    r = await request(job, 'api.github.com', { path: '/user' });
    assert.equal(r.status, 502);
    assert.deepEqual(JSON.parse(r.body), { message: 'the key has expired' });
    assert.match(r.headers['content-type'], /application\/json/);

    forgeAnswer = () => new Promise(() => {});
    const started = Date.now();
    r = await request(job, 'api.github.com', { path: '/user' });
    assert.equal(r.status, 502);
    assert.equal(JSON.parse(r.body).message, 'the requester did not answer within 1.5 s');
    assert.ok(Date.now() - started < 10000);

    for (const bad of [null, {}, { status: 'ok' }, { status: 99 }, { status: 200, headers: { 'x-bad': 'a\r\nb: c' } }]) {
      forgeAnswer = async () => bad;
      r = await request(job, 'api.github.com', { path: '/user' });
      assert.equal(r.status, 502, JSON.stringify(bad));
      assert.equal(typeof JSON.parse(r.body).message, 'string');
    }
    forgeAnswer = async () => ({ status: 204, headers: {}, body: '' });
    r = await request(job, 'api.github.com', { method: 'DELETE', path: '/repos/dn-test/alpha/issues/comments/1' });
    assert.equal(r.status, 204);
    assert.equal(r.body.length, 0);
  });

  // From here the requester stands in for the forge's git endpoints too, by running the
  // real receive-pack against the stand-in forge: a push that reaches it lands there.
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
  const gitForge = async (j, r) => {
    const m = /^\/([^/]+\/[^/]+?)(?:\.git)?\/(info\/refs\?service=git-(receive|upload)-pack|git-(receive|upload)-pack)$/.exec(r.path);
    if (!m) return { status: 404, headers: {}, body: '' };
    const service = `${m[3] || m[4]}-pack`;
    const bare = path.join(forgeDir, `${m[1].toLowerCase()}.git`);
    if (m[2].startsWith('info/refs')) {
      const adv = await run([service, '--stateless-rpc', '--advertise-refs', bare], '');
      return { status: 200, headers: { 'content-type': `application/x-git-${service}-advertisement` }, body: Buffer.concat([Buffer.from(`${pkt(`# service=git-${service}\n`)}0000`), adv]) };
    }
    return { status: 200, headers: { 'content-type': `application/x-git-${service}-result` }, body: await run([service, '--stateless-rpc', bare], Buffer.from(r.body, 'base64')) };
  };

  await check('git clone and fetch of the job\'s own repository are answered from the mirror and never reach the requester', async () => {
    forgeAnswer = gitForge;
    const seen = forgeSeen.length;
    // A commit only the mirror has: whoever answers the clone with it is the mirror.
    const mirrorPath = mirrors.path(alpha.pool);
    fs.writeFileSync(path.join(alpha.checkout, 'only-in-mirror'), 'x\n');
    git(alpha.checkout, 'add', '.');
    git(alpha.checkout, 'commit', '--quiet', '-m', 'mirror only');
    const marked = git(alpha.checkout, 'rev-parse', 'HEAD');
    git(alpha.checkout, 'push', '--quiet', mirrorPath, 'HEAD:refs/heads/main', 'HEAD:refs/pull/7/head');
    git(alpha.checkout, 'reset', '--quiet', '--hard', 'HEAD~1');

    for (const [label, extra, url] of [['protocol v2', [], 'https://github.com/dn-test/alpha.git'], ['protocol v0', ['-c', 'protocol.version=0'], 'https://github.com/dn-test/alpha.git'],
      ['another spelling of the name', [], 'https://github.com/DN-Test/Alpha']]) {
      const dir = path.join(scratch, `clone-${label.replace(/\W/g, '')}`);
      const r = await gitVia(job, [...extra, 'clone', '--quiet', url, dir]);
      assert.equal(r.code, 0, `${label}: ${r.stderr}`);
      assert.equal(git(dir, 'rev-parse', 'HEAD'), marked, label);
    }
    const dir = path.join(scratch, 'clone-protocolv2');
    const f = await gitVia(job, ['fetch', '--quiet', 'origin', 'pull/7/head'], dir);
    assert.equal(f.code, 0, f.stderr);
    assert.equal(git(dir, 'rev-parse', 'FETCH_HEAD'), marked);
    assert.equal(forgeSeen.length, seen, 'the requester saw none of it');
    assert.equal(git(alpha.bare, 'rev-parse', 'refs/heads/main') === marked, false, 'and the forge never had that commit');
  });

  await check('a large pack is served whole, and a gzip\'d request is read', async () => {
    const big = makeRepo('dn-test', 'big');
    const blob = crypto.randomBytes(24 * 2 ** 20);
    fs.writeFileSync(path.join(big.checkout, 'blob.bin'), blob);
    git(big.checkout, 'add', '.');
    git(big.checkout, 'commit', '--quiet', '-m', 'big');
    git(big.checkout, 'push', '--quiet', 'origin', 'main');
    await mirrors.ensureMirror({ pool: big.pool, checkout: big.checkout });
    const bigJob = await broker.addJob({ runId: 'run-big', pool: big.pool });
    const dir = path.join(scratch, 'clone-big');
    const r = await gitVia(bigJob, ['clone', '--quiet', 'https://github.com/dn-test/big.git', dir]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(sha(fs.readFileSync(path.join(dir, 'blob.bin'))), sha(blob));

    const lsRefs = Buffer.from(`${pkt('command=ls-refs\n')}${pkt('object-format=sha1\n')}0001${pkt('ref-prefix refs/heads/\n')}0000`);
    for (const encoding of ['gzip', 'x-gzip', null]) {
      const res = await request(bigJob, 'github.com', {
        method: 'POST', path: '/dn-test/big.git/git-upload-pack', body: encoding ? zlib.gzipSync(lsRefs) : lsRefs,
        headers: { 'content-type': 'application/x-git-upload-pack-request', 'git-protocol': 'version=2', ...(encoding ? { 'content-encoding': encoding } : {}) },
      });
      assert.equal(res.status, 200, String(encoding));
      assert.equal(res.headers['content-type'], 'application/x-git-upload-pack-result');
      assert.match(res.body.toString(), new RegExp(`${git(big.bare, 'rev-parse', 'refs/heads/main')} refs/heads/main`), String(encoding));
    }
    // A header that is not a protocol list never becomes an environment variable.
    const odd = await request(bigJob, 'github.com', { path: '/dn-test/big.git/info/refs?service=git-upload-pack', headers: { 'git-protocol': 'version=2 $(reboot)' } });
    assert.match(odd.body.toString(), /^001e# service=git-upload-pack\n0000/, 'answered as the oldest protocol');
    broker.removeJob('run-big');
  });

  await check('another repository on the same forge is the requester\'s to answer, even when this machine mirrors it', async () => {
    assert.ok(mirrors.path(other.pool), 'there is a mirror it could have been served from');
    const seen = forgeSeen.length;
    const dir = path.join(scratch, 'clone-other');
    const r = await gitVia(job, ['clone', '--quiet', 'https://github.com/dn-test/other.git', dir]);
    assert.equal(r.code, 0, r.stderr);
    const asked = forgeSeen.slice(seen).map((s) => `${s.request.method} ${s.request.path}`);
    assert.deepEqual(asked, ['GET /dn-test/other.git/info/refs?service=git-upload-pack', 'POST /dn-test/other.git/git-upload-pack']);
    for (const p of ['/dn-test/alpha.git.evil/info/refs?service=git-upload-pack', '/dn-test/alpha.git/info/refs/x?service=git-upload-pack', '/x/dn-test/alpha.git/info/refs?service=git-upload-pack',
      '/dn-test/alpha/git-upload-pack/x', '/dn-test/alpha.git/info/refs', '/dn-test/alpha.git/info/refs?service=git-upload-archive']) {
      const n = forgeSeen.length;
      await request(job, 'github.com', { path: p });
      assert.equal(forgeSeen.length, n + 1, `${p} is not the job's fetch`);
    }
    // The mirror answers on the forge's git host only.
    const n = forgeSeen.length;
    await request(job, 'api.github.com', { path: '/dn-test/alpha.git/info/refs?service=git-upload-pack' });
    assert.equal(forgeSeen.length, n + 1);
  });

  await check('a push is two requests to the requester, lands where the requester puts it, and never touches the mirror', async () => {
    const mirrorPath = mirrors.path(alpha.pool);
    const mirrorBefore = git(mirrorPath, 'for-each-ref');
    const dir = path.join(scratch, 'clone-protocolv2');
    fs.writeFileSync(path.join(dir, 'fix.txt'), 'fixed\n');
    git(dir, 'add', '.');
    git(dir, '-c', 'user.name=A', '-c', 'user.email=a@example.com', 'commit', '--quiet', '-m', 'fix');
    const pushed = git(dir, 'rev-parse', 'HEAD');
    const seen = forgeSeen.length;
    const r = await gitVia(job, ['push', '--quiet', 'origin', 'HEAD:refs/heads/fix-7'], dir);
    assert.equal(r.code, 0, r.stderr);
    const asked = forgeSeen.slice(seen).map((s) => `${s.request.method} ${s.request.path}`);
    assert.deepEqual(asked, ['GET /dn-test/alpha.git/info/refs?service=git-receive-pack', 'POST /dn-test/alpha.git/git-receive-pack']);
    assert.equal(forgeSeen.at(-1).request.headers['content-type'], 'application/x-git-receive-pack-request');
    assert.equal(forgeSeen.at(-1).request.headers.authorization, undefined);
    assert.equal(git(alpha.bare, 'rev-parse', 'refs/heads/fix-7'), pushed);
    assert.equal(git(mirrorPath, 'for-each-ref'), mirrorBefore);
    // Asked for by hand as well: neither push endpoint is ever the mirror's.
    for (const [method, p] of [['GET', '/dn-test/alpha.git/info/refs?service=git-receive-pack'], ['POST', '/dn-test/alpha.git/git-receive-pack'], ['POST', '/dn-test/alpha/git-receive-pack']]) {
      const n = forgeSeen.length;
      await request(job, 'github.com', { method, path: p, body: method === 'POST' ? Buffer.from('0000') : null });
      assert.equal(forgeSeen.length, n + 1, `${method} ${p}`);
    }
    assert.equal(git(mirrorPath, 'for-each-ref'), mirrorBefore);
  });

  await check('a job without a mirror is told so, not handed to the forge', async () => {
    const lost = await broker.addJob({ runId: 'run-lost', pool: { ...alpha.pool, id: 'github.com/dn-test/unmirrored', repo: 'unmirrored' } });
    const seen = forgeSeen.length;
    const r = await request(lost, 'github.com', { path: '/dn-test/unmirrored.git/info/refs?service=git-upload-pack' });
    assert.equal(r.status, 502);
    assert.equal(JSON.parse(r.body).message, 'this executor holds no mirror of the repository');
    assert.equal(forgeSeen.length, seen);
    broker.removeJob('run-lost');
  });

  await check('the model provider gets this machine\'s credential in place of the placeholder, on inference requests only', async () => {
    forgeAnswer = async () => ({ status: 200, headers: {}, body: '' });
    const body = Buffer.from(JSON.stringify({ model: 'claude-x', max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }));
    const sent = { authorization: `Bearer ${PLACEHOLDER}`, 'x-api-key': PLACEHOLDER, 'anthropic-version': '2023-06-01', 'anthropic-beta': 'oauth-2025-04-20,claude-code-20250219',
      'content-type': 'application/json', 'content-length': body.length, 'user-agent': 'claude-cli/2.1.325', 'x-app': 'cli' };
    let r = await request(job, 'api.anthropic.com', { method: 'POST', path: '/v1/messages?beta=true', headers: sent, body });
    assert.equal(r.status, 200);
    assert.equal(r.body.toString(), '{"ok":true}');
    assert.equal(r.headers['request-id'], 'req_1');
    let seen = providerSeen.at(-1);
    assert.equal(seen.url, '/v1/messages?beta=true');
    assert.equal(sha(seen.body), sha(body));
    assert.equal(seen.headers['x-api-key'], 'sk-ant-api03-the-real-key');
    assert.equal(seen.headers.authorization, undefined, 'the client\'s own Authorization does not travel beside the real key');
    assert.equal(seen.headers.host, 'api.anthropic.com');
    for (const k of ['anthropic-version', 'anthropic-beta', 'content-type', 'user-agent', 'x-app']) assert.equal(seen.headers[k], sent[k], `${k} is untouched`);
    assert.equal(seen.headers['proxy-authorization'], undefined);

    // The account's other endpoints get what the client sent: a placeholder, which the provider refuses.
    for (const p of ['/api/oauth/profile', '/api/oauth/usage', '/v1/files', '/v1/messages/batches', '/v1/organizations/x', '/api/claude_cli/bootstrap', '/v1/messages/../files']) {
      r = await request(job, 'api.anthropic.com', { path: p, headers: { authorization: `Bearer ${PLACEHOLDER}` } });
      seen = providerSeen.at(-1);
      assert.equal(seen.headers.authorization, `Bearer ${PLACEHOLDER}`, p);
      assert.equal(seen.headers['x-api-key'], undefined, p);
    }
    r = await request(job, 'api.anthropic.com', { method: 'POST', path: '/v1/messages/count_tokens', headers: { 'x-api-key': PLACEHOLDER }, body });
    assert.equal(providerSeen.at(-1).headers['x-api-key'], 'sk-ant-api03-the-real-key');
    // A request that brought a credential of its own keeps it: no placeholder, no swap.
    r = await request(job, 'api.anthropic.com', { method: 'POST', path: '/v1/messages', headers: { 'x-api-key': 'sk-the-agents-own' }, body });
    assert.equal(providerSeen.at(-1).headers['x-api-key'], 'sk-the-agents-own');
    assert.doesNotMatch(logged.join('\n'), /the-real-key/);
  });

  await check('a subscriber\'s login is sent as Authorization, with no API key header beside it', async () => {
    const home = fs.mkdtempSync(path.join(scratch, 'home-'));
    fs.mkdirSync(path.join(home, '.claude'));
    fs.writeFileSync(path.join(home, '.claude', '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'sk-ant-oat01-the-real-login', expiresAt: Date.now() + 3600e3 } }));
    const sub = createLLM({ env: {}, platform: 'linux', home, user: 'op' });
    await sub.load();
    const b2 = createBroker({ ca: createCA(), llm: sub, mirrors, onForge, lookup, connect, upstreamCa: fs.readFileSync(providerCa.certPath) });
    port = (await b2.start()).port;
    try {
      const j2 = await b2.addJob({ runId: 'sub', pool: alpha.pool });
      await request(j2, 'api.anthropic.com', { method: 'POST', path: '/v1/messages', headers: { authorization: `Bearer ${PLACEHOLDER}`, 'x-api-key': 'stray', 'anthropic-beta': 'claude-code-20250219' }, body: Buffer.from('{}') });
      const seen = providerSeen.at(-1);
      assert.equal(seen.headers.authorization, 'Bearer sk-ant-oat01-the-real-login');
      assert.equal(seen.headers['x-api-key'], undefined);
      assert.equal(seen.headers['anthropic-beta'], 'claude-code-20250219');
    } finally {
      await b2.stop();
      port = at.port;
    }
  });

  await check('a streamed answer reaches the client event by event, not when it is over', async () => {
    let release;
    const firstSeen = new Promise((r) => { release = r; });
    providerAnswer = async (req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.write('event: message_start\ndata: {"n":1}\n\n');
      // The second event is not written until the client has the first: a broker that
      // held the stream back would wait here for ever.
      await firstSeen;
      res.write('event: message_stop\ndata: {"n":2}\n\n');
      res.end();
    };
    const got = [];
    const r = await Promise.race([
      request(job, 'api.anthropic.com', { method: 'POST', path: '/v1/messages', headers: { 'x-api-key': PLACEHOLDER, accept: 'text/event-stream' }, body: Buffer.from('{"stream":true}'),
        onChunk: (c) => { got.push(c.toString()); if (got.join('').includes('message_start')) release(); } }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('the stream was held back')), 120000)),
    ]);
    assert.equal(r.headers['content-type'], 'text/event-stream');
    assert.equal(r.body.toString(), 'event: message_start\ndata: {"n":1}\n\nevent: message_stop\ndata: {"n":2}\n\n');
    assert.ok(got.length >= 2, 'in more than one piece');
  });

  await check('a 401 from the provider is retried once with a renewed credential, and passed on when there is none', async () => {
    const tokens = ['sk-one', 'sk-two'];
    const asked = [];
    const stub = {
      authorize: async (h) => ({ ...h, 'x-api-key': tokens[0] }),
      refused: async (h) => { asked.push(h['x-api-key']); if (tokens.length > 1) { tokens.shift(); return true; } return false; },
    };
    providerAnswer = (req, res) => {
      const ok = req.headers['x-api-key'] === 'sk-two';
      res.writeHead(ok ? 200 : 401, { 'content-type': 'application/json' });
      res.end(ok ? '{"ok":true}' : '{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}');
    };
    const b3 = createBroker({ ca: createCA(), llm: stub, mirrors, onForge, lookup, connect, upstreamCa: fs.readFileSync(providerCa.certPath) });
    port = (await b3.start()).port;
    try {
      const j3 = await b3.addJob({ runId: 'r3', pool: alpha.pool });
      const body = Buffer.from('{"messages":[1]}');
      const n = providerSeen.length;
      let r = await request(j3, 'api.anthropic.com', { method: 'POST', path: '/v1/messages', headers: { 'x-api-key': PLACEHOLDER }, body });
      assert.equal(r.status, 200, 'the client never saw the 401');
      assert.deepEqual(providerSeen.slice(n).map((s) => [s.headers['x-api-key'], s.body.toString()]), [['sk-one', '{"messages":[1]}'], ['sk-two', '{"messages":[1]}']]);
      assert.deepEqual(asked, ['sk-one']);
      tokens[0] = 'sk-dead';
      r = await request(j3, 'api.anthropic.com', { method: 'POST', path: '/v1/messages', headers: { 'x-api-key': PLACEHOLDER }, body });
      assert.equal(r.status, 401);
      assert.equal(JSON.parse(r.body).error.type, 'authentication_error');
      assert.deepEqual(asked, ['sk-one', 'sk-dead']);
      // A 401 for a credential of the client's own is the client's affair.
      r = await request(j3, 'api.anthropic.com', { method: 'POST', path: '/v1/messages', headers: { 'x-api-key': 'sk-their-own' }, body });
      assert.equal(r.status, 401);
      assert.equal(asked.length, 2);
    } finally {
      await b3.stop();
      port = at.port;
      providerAnswer = (req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); };
    }
  });

  await check('with no credential on this machine the job is told at once, in the provider\'s own error shape, and the provider is not asked', async () => {
    const none = createLLM({ env: {}, platform: 'linux', home: fs.mkdtempSync(path.join(scratch, 'home-')), user: 'op' });
    const b4 = createBroker({ ca: createCA(), llm: none, mirrors, onForge, lookup, connect, upstreamCa: fs.readFileSync(providerCa.certPath) });
    port = (await b4.start()).port;
    try {
      const j4 = await b4.addJob({ runId: 'r4', pool: alpha.pool });
      const n = providerSeen.length;
      const r = await request(j4, 'api.anthropic.com', { method: 'POST', path: '/v1/messages', headers: { authorization: `Bearer ${PLACEHOLDER}` }, body: Buffer.from('{}') });
      assert.equal(r.status, 401);
      assert.deepEqual(JSON.parse(r.body), { type: 'error', error: { type: 'authentication_error', message: 'this executor has no model credential: no networkModelToken, no Claude Code login and no ANTHROPIC_API_KEY on this machine' } });
      assert.equal(providerSeen.length, n);
    } finally {
      await b4.stop();
      port = at.port;
    }
  });

  await check('a forward is its job\'s alone: that job\'s token opens it, no other does, and it closes with the job', async () => {
    const adb = net.createServer((c) => { c.on('error', () => {}); c.on('data', (d) => c.write(`OKAY${d}`)); });
    const adbPort = await listen(adb);
    assert.throws(() => broker.addForward('no-such-run', { name: 'adb', target: { port: adbPort } }), /not admitted/);
    const fjob = await broker.addJob({ runId: 'run-f', pool: alpha.pool });
    for (const bad of ['Not A Name', 'a.b', '', 'x'.repeat(33)]) assert.throws(() => broker.addForward('run-f', { name: bad, target: { port: adbPort } }), /not a forward's name/);
    assert.deepEqual(broker.addForward('run-f', { name: 'adb', target: { host: '127.0.0.1', port: adbPort } }), { name: 'adb' });
    const talk = async (auth, name = 'adb') => {
      const t = await tunnel(`${name}.forward.dn:1`, auth);
      if (t.status !== 200) return t;
      t.socket.write('host:devices');
      return { ...t, said: await new Promise((r) => t.socket.once('data', (d) => r(d.toString()))) };
    };
    const open = await talk(basic('dn', fjob.token));
    assert.equal(open.said, 'OKAYhost:devices');
    // The same name under another job's token, a name this job was not given, no token at all.
    const others = await talk(basic('dn', job.token));
    assert.equal(others.status, 404);
    assert.equal(others.body, 'this job has no forward named adb\n');
    assert.equal((await talk(basic('dn', fjob.token), 'tool-server')).status, 404);
    assert.equal((await talk('')).status, 407);
    const closed = new Promise((r) => open.socket.on('close', r));
    broker.removeJob('run-f');
    try {
      await Promise.race([closed, new Promise((_, reject) => setTimeout(() => reject(new Error('the forward outlived its job')), 60000))]);
    } finally { open.socket.destroy(); }
    assert.equal((await talk(basic('dn', fjob.token))).status, 407);
  });

  await check('a job gets so much of the model and no more: past its requests or its bytes the answer is a 429 that says so, and the provider is not asked', async () => {
    providerAnswer = (req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); };
    const body = Buffer.from(JSON.stringify({ model: 'claude-x', max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }));
    const ask = (j, opts = {}) => request(j, 'api.anthropic.com', { method: 'POST', path: '/v1/messages', headers: { 'x-api-key': PLACEHOLDER }, body, ...opts });
    const greedy = await broker.addJob({ runId: 'run-greedy', pool: alpha.pool });
    for (let i = 0; i < 12; i++) assert.equal((await ask(greedy, i % 2 ? { path: '/v1/messages/count_tokens' } : {})).status, 200, `request ${i + 1}`);
    const asked = providerSeen.length;
    for (let i = 0; i < 2; i++) {
      const over = await ask(greedy);
      assert.equal(over.status, 429);
      assert.equal(over.headers['x-should-retry'], 'false', 'the client is told not to try again');
      const said = JSON.parse(over.body);
      assert.equal(said.type, 'error');
      assert.equal(said.error.type, 'rate_limit_error');
      assert.match(said.error.message, /^this job has used all of the model it gets on this executor \(12 requests, 300000 bytes\): it made 12 requests of \d+ bytes\. /);
    }
    assert.equal(providerSeen.length, asked, 'the provider never saw them');
    assert.equal(logged.filter((l) => l.includes('run-greedy the model is closed to this job after 12 requests')).length, 1, 'said once in the log');
    // What is not sent on this machine's credential is not this machine's to count.
    assert.equal((await ask(greedy, { headers: { 'x-api-key': 'sk-the-agents-own' } })).status, 200);
    assert.equal((await ask(job)).status, 200, 'and another job has its own share');

    // Bytes: what the job sends...
    const big = Buffer.from(JSON.stringify({ model: 'claude-x', messages: [{ role: 'user', content: 'x'.repeat(160000) }] }));
    const wordy = await broker.addJob({ runId: 'run-wordy', pool: alpha.pool });
    assert.deepEqual([(await ask(wordy, { body: big })).status, (await ask(wordy, { body: big })).status, (await ask(wordy)).status], [200, 200, 429]);
    // ...and what it is sent back.
    providerAnswer = (req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ text: 'y'.repeat(160000) })); };
    const reader = await broker.addJob({ runId: 'run-reader', pool: alpha.pool });
    assert.deepEqual([(await ask(reader)).status, (await ask(reader)).status, (await ask(reader)).status], [200, 200, 429]);
    for (const id of ['run-greedy', 'run-wordy', 'run-reader']) broker.removeJob(id);
    providerAnswer = (req, res) => { res.writeHead(200, { 'content-type': 'application/json', 'request-id': 'req_1' }); res.end('{"ok":true}'); };
  });

  await check('removing a job cuts its open connections and leaves the other jobs\' alone', async () => {
    const doomed = await broker.addJob({ runId: 'run-d', pool: alpha.pool });
    const mine = await tunnel('tunnel.test:443', basic('dn', job.token));
    const theirs = await tunnel('tunnel.test:443', basic('dn', doomed.token));
    const theirTls = await secure(doomed, 'api.github.com');
    const closed = Promise.all([new Promise((r) => theirs.socket.on('close', r)), new Promise((r) => theirTls.on('close', r))]);
    broker.removeJob('run-d');
    broker.removeJob('run-d');
    await closed;
    const echoed = new Promise((r) => mine.socket.once('data', r));
    mine.socket.write('still here');
    assert.equal((await echoed).toString(), 'still here');
    mine.socket.destroy();
  });

  await check('stopping the broker ends every job and frees the port', async () => {
    const t = await tunnel('tunnel.test:443', basic('dn', job.token));
    const closed = new Promise((r) => t.socket.on('close', r));
    await broker.stop();
    await closed;
    assert.equal(broker.address(), null);
    await assert.rejects(tunnel('tunnel.test:443', basic('dn', job.token)), /ECONNREFUSED/);
    await broker.stop();
  });

  await check('a later daemon\'s broker listens where the earlier one did, and knows a job that is still running by the token it was started with', async () => {
    const make = () => createBroker({ ca: createCA(), llm, mirrors, onForge, lookup, connect, upstreamCa: fs.readFileSync(providerCa.certPath) });
    const later = make();
    const other = make();
    try {
      assert.equal((await later.start({ port })).port, port);
      // Another forge host joined since: the newest CA is not the one this job trusts.
      const newest = await later.addJob({ runId: 'newcomer', pool: alpha.pool });
      assert.notEqual(newest.generation, job.generation);
      const again = await later.addJob(info, { token: job.token, generation: job.generation });
      assert.deepEqual(again, job, 'the same token, port and certificate authority');
      assert.equal((await request(again, 'api.github.com', { path: '/user' })).status, 200, 'its forge still answers under the CA it was started with');
      await assert.rejects(later.addJob({ runId: 'orphan', pool: alpha.pool }, { generation: 'ffffffffffff' }), /job orphan cannot be admitted: the certificate authority it was started under is gone/);
      await assert.rejects(later.addJob({ runId: 'orphan', pool: alpha.pool }, { generation: '../ca' }), /is gone/);
      // One token is one job, and a token is 32 random bytes.
      await assert.rejects(later.addJob({ runId: 'thief', pool: alpha.pool }, { token: job.token }), /job thief cannot be admitted under that token/);
      await assert.rejects(later.addJob({ runId: 'short', pool: alpha.pool }, { token: 'abc' }), /job short cannot be admitted under that token/);
      // A port somebody else took is said, and the broker can still start on another.
      await assert.rejects(other.start({ port }), /EADDRINUSE/);
      assert.equal(other.address(), null);
      assert.notEqual((await other.start()).port, port);
    } finally {
      await later.stop();
      await other.stop();
    }
  });

  console.log(`\nall ${checks} checks passed`);
} finally {
  await broker.stop().catch(() => {});
  for (const close of closers) close();
  for (const s of [echo, plain, providerTls]) s.closeAllConnections?.();
  fs.rmSync(scratch, { recursive: true, force: true });
}
process.exit(0);
