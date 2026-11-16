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
const { createBroker, brokerBindAddress, quietPort, deniedAddress, forgeHosts, forgeSshHosts, normalHost, MODEL_HOSTS } = await import('../src/executor/broker.js');
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

// An exception or a rejection nobody caught ends the daemon, so every one that happens
// in this process is kept: nothing a job sends may cause one.
const faults = [];
process.on('uncaughtException', (e) => faults.push(e));
process.on('unhandledRejection', (e) => faults.push(e));
const noFaults = () => assert.deepEqual(faults.map((e) => String(e?.stack ?? e)), []);
const until = async (met, what, ms = 60000) => {
  for (const end = Date.now() + ms; !met();) {
    if (Date.now() > end) throw new Error(`never: ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
};
const within = (promise, what, ms = 60000) => {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`never: ${what}`)), ms); })]).finally(() => clearTimeout(timer));
};

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
const gates = new Map(); // "address:port" -> a promise a connection made there is kept back for
const connect = ({ host, port }) => new Promise((resolve, reject) => {
  dials.push(`${host}:${port}`);
  const local = routes.get(`${host}:${port}`);
  if (!local) return reject(Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }));
  const s = net.connect(local, '127.0.0.1', () => Promise.resolve(gates.get(`${host}:${port}`)).then(() => resolve(s)));
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
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    plainSeen.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() });
    res.writeHead(200, { 'content-type': 'text/plain', 'x-from': 'plain.test' });
    res.end(`plain says ${req.url}`);
  });
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
    providerSeen.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks), socket: req.socket });
    providerAnswer(req, res);
  });
});
provider.keepAliveTimeout = 600000;
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
// and for a refusal `body` once the proxy has closed. A connection closed without an
// answer is status 0.
function tunnel(target, auth) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    let buf = Buffer.alloc(0);
    socket.on('error', reject);
    socket.on('close', () => { if (buf.indexOf('\r\n\r\n') < 0) resolve({ status: 0, head: '', socket, body: '' }); });
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
    const req = http.request({ createConnection: () => socket, host, port: 443, defaultPort: 443, method, path: p, headers: { ...headers, ...(chunked ? { 'transfer-encoding': 'chunked' } : {}) } });
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

// One http:// request through the proxy, on a connection of its own.
function viaProxy(job, url, { method = 'GET', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, agent: false, method, path: url,
      headers: { host: new URL(url).host, 'proxy-authorization': `Basic ${Buffer.from(`dn:${job.token}`).toString('base64')}`, ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(body || undefined);
  });
}

// Bytes written to the proxy as they are, on a connection of their own, and everything
// it said before it closed: `{ status, text }`, status 0 when it closed without an answer.
function raw(bytes) {
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1', () => s.write(bytes));
    const got = [];
    s.on('data', (d) => got.push(d));
    s.on('error', () => {});
    s.on('close', () => {
      const text = Buffer.concat(got).toString('latin1');
      resolve({ status: Number(/^HTTP\/1\.1 (\d{3})/.exec(text)?.[1] ?? 0), text });
    });
  });
}

// The answers on an open connection, each framed by its Content-Length: resolves to the
// next `count` of them as `{ status, head, body }`, fewer when the connection closes first.
function answers(socket, count = 1) {
  return new Promise((resolve) => {
    const out = [];
    let buf = Buffer.alloc(0);
    const done = () => { socket.off('data', onData); socket.off('close', done); resolve(out); };
    const onData = (d) => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        const i = buf.indexOf('\r\n\r\n');
        if (i < 0) return;
        const head = buf.subarray(0, i).toString('latin1');
        const length = Number(/^content-length: (\d+)/im.exec(head)?.[1] ?? 0);
        if (buf.length < i + 4 + length) return;
        out.push({ status: Number(head.split(' ')[1]), head, body: buf.subarray(i + 4, i + 4 + length).toString() });
        buf = buf.subarray(i + 4 + length);
        if (out.length === count) return done();
      }
    };
    socket.on('data', onData);
    socket.on('close', done);
  });
}
const exchange = async (socket, text) => {
  const got = answers(socket);
  socket.write(text);
  return (await got)[0] ?? { status: 0, head: '', body: '' };
};

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

  await check('the port is one below the range the system deals outgoing connections from, where it states one with room below it; the system\'s pick anywhere else', () => {
    const picked = [];
    const pick = (from, to) => { picked.push([from, to]); return from + 7; };
    assert.deepEqual([quietPort({ range: '32768\t60999\n', pick }), quietPort({ range: '11000 65535', pick })], [10007, 10007]);
    assert.deepEqual(picked, [[10000, 32768], [10000, 11000]], 'from 10000 up to the first port of the range, which is not one of them');
    for (const range of ['10999 65535', '1024\t65535\n', '', 'not a range', null]) assert.equal(quietPort({ range, pick }), 0, String(range));
    assert.equal(picked.length, 2);
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

  await check('a forge host and the model provider are read here on 443, and refused on every other port and over plain http', async () => {
    const s = await secure(job, 'api.github.com');
    const cert = s.getPeerX509Certificate();
    assert.equal(cert.subjectAltName, 'DNS:api.github.com');
    assert.equal(cert.checkIssued(new crypto.X509Certificate(fs.readFileSync(job.caCertPath))), true);
    assert.equal(s.alpnProtocol, false);
    s.destroy();
    // Each of them has an address a tunnel could lead to, and something listens there.
    for (const name of forgeHosts(alpha.pool)) names.set(name, [{ address: '93.184.216.34', family: 4 }]);
    for (const p of [22, 80, 8080, 9418]) routes.set(`93.184.216.34:${p}`, echo.address().port);
    for (const p of [80, 8443]) routes.set(`160.79.104.10:${p}`, echo.address().port);
    const state = () => [lookups.length, dials.length, forgeSeen.length, providerSeen.length, plainSeen.length];
    const before = state();
    for (const [target, how] of [['api.github.com:8443', 'port 8443'], ['github.com:22', 'port 22'], ['github.com:80', 'plain http'], ['gist.github.com:9418', 'port 9418'],
      ['uploads.github.com:8080', 'port 8080'], ['api.anthropic.com:8443', 'port 8443'], ['api.anthropic.com:80', 'plain http']]) {
      const r = await tunnel(target, basic('dn', job.token));
      assert.equal(r.status, 403, target);
      assert.equal(r.body, `the broker connects to ${target.split(':')[0]} on port 443 only, where its requests are read; ${how} would lead around that\n`);
    }
    for (const url of ['http://github.com/dn-test/alpha.git/info/refs?service=git-upload-pack', 'http://api.github.com:8080/user', 'http://api.anthropic.com/v1/messages', 'http://GitHub.com./x']) {
      const r = await viaProxy(job, url);
      assert.equal(r.status, 403, url);
      assert.match(r.body, /^the broker connects to \S+ on port 443 only, where its requests are read; /, url);
    }
    assert.deepEqual(state(), before, 'nothing was resolved, dialled or asked');
    for (const name of forgeHosts(alpha.pool)) names.delete(name);
    for (const p of [22, 80, 8080, 9418]) routes.delete(`93.184.216.34:${p}`);
    for (const p of [80, 8443]) routes.delete(`160.79.104.10:${p}`);
  });

  await check('a host is the same host in capitals and with its trailing dot, and the hosts a forge serves git over ssh on are refused', async () => {
    assert.deepEqual(['GitHub.COM.', 'github.com', '[2606:4700::1111]', '.', '', undefined].map(normalHost), ['github.com', 'github.com', '2606:4700::1111', '', '', '']);
    const gitlab = { id: 'gitlab.com/g/r', forge: 'gitlab', host: 'gitlab.com', owner: 'g', repo: 'r' };
    assert.deepEqual(forgeSshHosts(alpha.pool), ['ssh.github.com']);
    assert.deepEqual(forgeSshHosts(gitlab), ['altssh.gitlab.com']);
    assert.deepEqual(forgeSshHosts({ ...gitlab, host: 'gitlab.example.org' }), []);
    // Every one of these names resolves, so a spelling that slipped past would be dialled.
    const spelled = ['github.com.', 'GitHub.com', 'API.GITHUB.COM.', 'gist.github.com.', 'Api.Anthropic.Com.'];
    const resolving = [...spelled, 'github.com', 'api.github.com', 'gist.github.com', 'ssh.github.com', 'SSH.GitHub.com.', 'altssh.gitlab.com', 'AltSSH.GitLab.com.'];
    for (const name of resolving) names.set(name, [{ address: '93.184.216.34', family: 4 }]);
    routes.set('93.184.216.34:22', echo.address().port);
    const dialled = dials.length;
    for (const name of spelled) {
      const host = name.toLowerCase().replace(/\.$/, '');
      const t = await tunnel(`${name}:443`, basic('dn', job.token));
      assert.equal(t.status, 200, name);
      const s = await within(new Promise((resolve, reject) => {
        const c = tls.connect({ socket: t.socket, servername: host, ca: fs.readFileSync(job.caCertPath) }, () => resolve(c));
        c.on('error', reject);
      }), `${name} to be answered under the job's CA`);
      assert.equal(s.getPeerX509Certificate().subjectAltName, `DNS:${host}`, `${name} is read here`);
      s.destroy();
    }
    // The name inside may be spelled the same ways, and reaches the requester as the one host.
    for (const named of ['GITHUB.COM', 'github.com.', 'github.com:443', 'GitHub.com.:443']) {
      const n = forgeSeen.length;
      const s = await secure(job, 'github.com');
      const r = await exchange(s, `GET /spelled HTTP/1.1\r\nHost: ${named}\r\n\r\n`);
      s.destroy();
      assert.equal(r.status, 200, named);
      assert.equal(forgeSeen.length, n + 1, named);
      assert.equal(forgeSeen.at(-1).request.host, 'github.com');
    }
    for (const target of ['ssh.github.com:443', 'SSH.GitHub.com.:443', 'ssh.github.com:22']) {
      const r = await tunnel(target, basic('dn', job.token));
      assert.equal(r.status, 403, target);
      assert.equal(r.body, 'the broker does not connect to ssh.github.com: it serves github.com over ssh, around the requester, and no key for it is in this container. Use https://github.com/\n');
    }
    assert.equal(dials.length, dialled, 'none of them was dialled');
    // Another forge's ssh host is no affair of this job's forge: a tunnel like any other.
    const labJob = await broker.addJob({ runId: 'run-gitlab', pool: gitlab });
    assert.equal((await tunnel('AltSSH.GitLab.com.:443', basic('dn', labJob.token))).status, 403);
    assert.equal(dials.length, dialled);
    const t = await tunnel('ssh.github.com:443', basic('dn', labJob.token));
    assert.equal(t.status, 200);
    assert.equal(dials.at(-1), '93.184.216.34:443');
    t.socket.destroy();
    broker.removeJob('run-gitlab');
    // What is no host and port is said to be none, and nothing is asked about it.
    const asked = lookups.length;
    for (const target of ['.:443', 'github.com:0', 'github.com:65536', 'github.com:99999', 'github.com', 'a:b:1', 'github.com:443:443', '[::1:443', 'github.com:']) {
      const r = await tunnel(target, basic('dn', job.token));
      assert.equal(r.status, 400, target);
      assert.equal(r.body, `not a host and port: ${target}\n`);
    }
    assert.equal(lookups.length, asked);
    for (const name of resolving) names.delete(name);
    routes.delete('93.184.216.34:22');
  });

  await check('a forge\'s download hosts and a bare address hold nobody\'s credential: they are tunnels, to public addresses only', async () => {
    for (const name of ['codeload.github.com', 'raw.githubusercontent.com', 'objects.githubusercontent.com']) names.set(name, [{ address: '93.184.216.34', family: 4 }]);
    const seen = forgeSeen.length;
    for (const target of ['codeload.github.com:443', 'raw.githubusercontent.com:443', 'objects.githubusercontent.com:443', '93.184.216.34:443']) {
      const t = await tunnel(target, basic('dn', job.token));
      assert.equal(t.status, 200, target);
      assert.equal(dials.at(-1), '93.184.216.34:443');
      t.socket.destroy();
    }
    assert.equal(forgeSeen.length, seen);
    for (const name of ['codeload.github.com', 'raw.githubusercontent.com', 'objects.githubusercontent.com']) names.delete(name);
  });

  await check('an address on any network this machine is on is refused, whatever the family, and so is every range that is not the public internet', async () => {
    const on = {
      lo0: [{ address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4', cidr: '127.0.0.1/8', internal: true }],
      en0: [
        { address: '198.51.100.7', netmask: '255.255.255.0', family: 'IPv4', cidr: '198.51.100.7/24' },
        { address: '2001:db8:1:2::10', netmask: 'ffff:ffff:ffff:ffff::', family: 'IPv6', cidr: '2001:db8:1:2::10/64' },
        // A prefix that ends inside a byte, and an entry whose length is its netmask's to say.
        { address: '203.0.113.200', netmask: '255.255.255.240', family: 'IPv4', cidr: null },
        { address: '2a00:1450:4000:8000::1', netmask: 'ffff:ffff:ffff:8000::', family: 'IPv6', cidr: null },
      ],
      utun3: [{ address: '2a01:4f8::5', netmask: 'ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff', family: 'IPv6', cidr: '2a01:4f8::5/128' }],
      down0: undefined,
    };
    const table = [
      // On a network of this machine's: neighbours on the link, in either family.
      ['198.51.100.7', true], ['198.51.100.1', true], ['198.51.100.255', true], ['198.51.101.1', false], ['198.51.99.255', false],
      ['2001:db8:1:2::10', true], ['2001:db8:1:2::1', true], ['2001:db8:1:2:aaaa:bbbb:cccc:dddd', true], ['2001:db8:1:3::1', false], ['2001:db8:1:1:ffff:ffff:ffff:ffff', false],
      ['203.0.113.193', true], ['203.0.113.207', true], ['203.0.113.208', false], ['203.0.113.191', false],
      ['2a00:1450:4000:8000::2', true], ['2a00:1450:4000:ffff::2', true], ['2a00:1450:4000:7fff::2', false],
      ['2a01:4f8::5', true], ['2a01:4f8::6', false],
      // The same addresses written as IPv6.
      ['::ffff:198.51.100.9', true], ['64:ff9b::c633:6409', true], ['::ffff:198.51.101.9', false], ['64:ff9b::808:808', false],
      // Never the public internet, whatever this machine is on.
      ['0.1.2.3', true], ['10.255.255.255', true], ['100.64.0.1', true], ['127.1.2.3', true], ['169.254.0.1', true], ['172.16.0.1', true], ['192.0.0.8', true],
      ['192.168.255.255', true], ['198.18.0.1', true], ['198.19.255.255', true], ['224.0.0.251', true], ['239.255.255.250', true], ['240.0.0.1', true], ['255.255.255.255', true],
      ['::', true], ['::1', true], ['::7f00:1', true], ['::ffff:0:7f00:1', true], ['64:ff9b::a00:1', true], ['64:ff9b::7f00:1', true], ['64:ff9b:1::7f00:1', true],
      ['100::1', true], ['2001::1', true], ['2001:0:0:0:0:0:7f00:1', true], ['2002:7f00:1::1', true], ['2002:c0a8:101::1', true],
      ['fc00::1', true], ['fdff:ffff::1', true], ['fe80::1', true], ['febf::1', true], ['fe80::1%en0', true], ['fec0::1', true], ['feff::1', true], ['ff02::1', true], ['ff0e::1', true],
      // And what is next to those ranges is.
      ['1.0.0.1', false], ['9.255.255.255', false], ['11.0.0.1', false], ['100.63.255.255', false], ['100.128.0.1', false], ['172.15.255.255', false], ['172.32.0.1', false],
      ['192.0.1.1', false], ['192.167.255.255', false], ['192.169.0.1', false], ['198.17.255.255', false], ['198.20.0.1', false], ['223.255.255.255', false],
      ['2606:4700:4700::1111', false], ['2001:4860:4860::8888', false], ['2003::1', false], ['100:0:0:1::1', false], ['64:ff9b:2::1', false], ['fbff::1', false],
    ];
    for (const [address, refused] of table) assert.equal(deniedAddress(address, on), refused, `${address} ${refused ? 'is refused' : 'is the public internet'}`);
    for (const junk of ['', 'example.com', '1.2.3', '999.1.1.1', ':::', '1.2.3.4.5', null, undefined]) assert.equal(deniedAddress(junk, on), true, `not an address: ${junk}`);

    // The interfaces are read when a connection is asked for, not when the broker began.
    names.set('neighbour.test', [{ address: '2001:db8:77:1::9', family: 6 }]);
    routes.set('2001:db8:77:1::9:443', echo.address().port);
    const real = os.networkInterfaces;
    try {
      const open = await tunnel('neighbour.test:443', basic('dn', job.token));
      assert.equal(open.status, 200, 'an address on no network of this machine');
      open.socket.destroy();
      os.networkInterfaces = () => ({ ...real(), en7: [{ address: '2001:db8:77:1::1', netmask: 'ffff:ffff:ffff:ffff::', family: 'IPv6', cidr: '2001:db8:77:1::1/64' }] });
      const d = dials.length;
      const shut = await tunnel('neighbour.test:443', basic('dn', job.token));
      assert.equal(shut.status, 403, 'the same address once this machine has joined its network');
      assert.match(shut.body, /^the broker does not connect to neighbour\.test: 2001:db8:77:1::9 is not a public internet address\. /);
      assert.equal((await tunnel('[2001:db8:77:1::9]:443', basic('dn', job.token))).status, 403);
      assert.equal(dials.length, d);
    } finally { os.networkInterfaces = real; }
    names.delete('neighbour.test');
    routes.delete('2001:db8:77:1::9:443');
  });

  await check('another pool\'s forge is not this job\'s: a GitLab job\'s github.com is a tunnel, its own host is read', async () => {
    assert.deepEqual(forgeHosts(alpha.pool), ['github.com', 'api.github.com', 'uploads.github.com', 'gist.github.com']);
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
    assert.equal(r.status, 200, r.body.toString());
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
      const req = http.request({ createConnection: () => s, host: 'api.github.com', port: 443, defaultPort: 443, method: 'POST', path: '/over', headers: { 'content-length': FORGE_BODY_CAP + 1 } });
      req.on('response', (res) => { const unsent = s.writableLength; let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => resolve({ status: res.statusCode, body: b, unsent })); });
      req.on('error', reject);
      req.write(exact);
      req.end(Buffer.alloc(1));
    });
    // This request is the last on its connection, which closes behind the answer: an
    // answer given while the body was still coming would be lost to a reset.
    assert.equal(r.unsent, 0, 'the refusal waits until the request has been sent to its end');
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

  await check('a certificate that nears its end under a running job is replaced there: the job\'s next connection is answered with the new one', async () => {
    let ahead = 0;
    const aging = createBroker({ ca: createCA({ dir: path.join(scratch, 'aging-ca'), now: () => Date.now() + ahead }), llm, mirrors, onForge, lookup, connect, upstreamCa: fs.readFileSync(providerCa.certPath) });
    port = (await aging.start()).port;
    try {
      const j = await aging.addJob({ runId: 'aging', pool: alpha.pool });
      const serial = async () => {
        const s = await secure(j, 'api.github.com');
        const { serialNumber } = s.getPeerX509Certificate();
        s.destroy();
        return serialNumber;
      };
      const first = await serial();
      assert.equal(await serial(), first, 'one certificate while it is good');
      // Issued for 90 days, replaced from two weeks before its end.
      ahead = 80 * 24 * 3600 * 1000;
      assert.notEqual(await serial(), first);
    } finally {
      await aging.stop();
      port = at.port;
    }
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

  // ---- what a job may send, and what may come back for it

  const okAnswer = { status: 200, headers: {}, body: '' };
  const okProvider = (req, res) => { res.writeHead(200, { 'content-type': 'application/json', 'request-id': 'req_1' }); res.end('{"ok":true}'); };
  const FRAMING = 'the broker carries a request body by its Content-Length or as Transfer-Encoding: chunked, one of the two and nothing else';
  // Another broker in this one's place, for what the tunables of one job are set to.
  const withBroker = async (more, fn) => {
    const b = createBroker({ log: (...a) => logged.push(a.join(' ')), ca: createCA(), llm, mirrors, onForge, lookup, connect, upstreamCa: fs.readFileSync(providerCa.certPath), ...more });
    port = (await b.start()).port;
    try { await fn(b); } finally { await b.stop(); port = at.port; }
  };

  await check('an upstream whose status is no status is a 502 for the job that asked, and the broker serves on', async () => {
    forgeAnswer = async () => okAnswer;
    let status = '099';
    const odd = net.createServer((s) => { s.on('error', () => {}); s.once('data', () => s.end(`HTTP/1.1 ${status} Odd\r\nContent-Length: 0\r\n\r\n`)); });
    publish('odd.test', '93.184.216.41', 80, await listen(odd));
    for (status of ['099', '000', '042', '600', '999']) {
      const r = await viaProxy(job, 'http://odd.test/x');
      assert.equal(r.status, 502, status);
      assert.equal(r.body, `odd.test answered with the status ${Number(status)}, which is no HTTP answer\n`);
    }
    const asker = await broker.addJob({ runId: 'run-odd', pool: alpha.pool });
    for (status of ['099', '000', '600']) {
      providerAnswer = (req, res) => res.socket.end(`HTTP/1.1 ${status} Odd\r\nContent-Length: 0\r\n\r\n`);
      const r = await request(asker, 'api.anthropic.com', { method: 'POST', path: '/v1/messages', headers: { 'x-api-key': PLACEHOLDER }, body: Buffer.from('{}') });
      assert.equal(r.status, 502, status);
      assert.deepEqual(JSON.parse(r.body), { message: `the model provider answered with the status ${Number(status)}, which is no HTTP answer` });
    }
    providerAnswer = okProvider;
    broker.removeJob('run-odd');
    noFaults();
    assert.equal((await viaProxy(job, 'http://plain.test/still-here')).status, 200);
    assert.equal((await request(job, 'api.github.com', { path: '/still-here' })).status, 200);
  });

  await check('a fault of the broker\'s own while it handles a request ends that request\'s connection and nothing else', async () => {
    const faulty = (line) => { if (line.includes('boom')) throw new Error('a fault in a handler'); };
    await withBroker({ trace: faulty }, async (b) => {
      const j = await b.addJob({ runId: 'run-fault', pool: alpha.pool });
      const said = logged.length;
      assert.equal((await raw(`GET http://plain.test/boom HTTP/1.1\r\nHost: plain.test\r\n${basic('dn', j.token)}\r\n`)).status, 0, 'a plain request');
      assert.equal((await tunnel('boom.test:443', basic('dn', j.token))).status, 0, 'a CONNECT');
      const s = await secure(j, 'api.github.com');
      const closed = new Promise((r) => { s.on('close', r); s.on('error', () => {}); });
      s.write('GET /boom HTTP/1.1\r\nHost: api.github.com\r\n\r\n');
      await within(closed, 'the terminated connection to be dropped');
      assert.equal(logged.slice(said).filter((l) => l.includes('a connection is dropped on a fault of the broker\'s own: Error: a fault in a handler')).length, 3);
      noFaults();
      assert.equal((await viaProxy(j, 'http://plain.test/still-here')).status, 200);
      assert.equal((await request(j, 'api.github.com', { path: '/still-here' })).status, 200);
    });
  });

  await check('a few hundred things that are no request and no answer, all from one job, end nothing: another job is served as before', async () => {
    const wild = await broker.addJob({ runId: 'run-wild', pool: alpha.pool });
    const W = basic('dn', wild.token);
    const wildCa = fs.readFileSync(wild.caCertPath);
    let seed = 20261114;
    const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
    const junk = (n) => Buffer.from(Array.from({ length: n }, () => Math.floor(rnd() * 256)));
    const long = (n) => 'a'.repeat(n);

    // What an upstream says in place of an answer; null is a connection cut without one.
    const said = [
      'HTTP/1.1 099 Low\r\nContent-Length: 0\r\n\r\n', 'HTTP/1.1 000 Zero\r\n\r\n', 'HTTP/1.1 1000 High\r\n\r\n', 'HTTP/1.1 600 Six\r\nContent-Length: 0\r\n\r\n', 'HTTP/1.1 -200 OK\r\n\r\n',
      'HTTP/9.9 200 OK\r\n\r\n', 'HTTP/1.1 200\r\n', 'HTTP/1.1 200 OK\r\nContent-Length: -1\r\n\r\n', 'HTTP/1.1 200 OK\r\nContent-Length: 5\r\nContent-Length: 6\r\n\r\nhello!',
      'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nContent-Length: 5\r\n\r\n5\r\nhello\r\n0\r\n\r\n', 'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\nzz\r\nhello\r\n',
      'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhel', 'HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\nshort', 'HTTP/1.1 100 Continue\r\n\r\n',
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: x\r\nConnection: Upgrade\r\n\r\n', 'HTTP/1.1 103 Early Hints\r\nLink: </x>\r\n\r\n', 'HTTP/1.1 204 No Content\r\nContent-Length: 5\r\n\r\nhello',
      'HTTP/1.1 200 OK\r\nBad Header: x\r\n\r\n', 'HTTP/1.1 200 OK\r\nX-A: a\0b\r\n\r\n', `HTTP/1.1 200 OK\r\nX-Big: ${long(100000)}\r\n\r\n`, 'HTTP/1.1 200 OK\r\nX-A: 1\r\n folded\r\n\r\n',
      'HTTP/1.1 200 OK\nContent-Length: 0\n\n', 'HTTP/1.1 304 Not Modified\r\nContent-Length: 9\r\n\r\n', 'HTTP/1.1 200 OK\r\nConnection: close, x-a\r\nX-A: 1\r\nContent-Length: 2\r\n\r\nok',
      '', 'not http at all\r\n\r\n', 'HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nokHTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nno',
      'HTTP/1.1 200 OK\r\nTrailer: X\r\nTransfer-Encoding: chunked\r\n\r\n2\r\nok\r\n0\r\nX: \x01\r\n\r\n', 'HTTP/1.1 200 OK\r\nContent-Length: 99999999999999999999\r\n\r\n',
      'HTTP/1.1 200 OK\r\nTransfer-Encoding: gzip\r\n\r\nxx', `HTTP/1.1 200 ${long(70000)}\r\n\r\n`, 'HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n', junk(500), null,
    ];
    let turn = 0;
    const chaos = net.createServer((s) => {
      s.on('error', () => {});
      const a = said[turn++ % said.length];
      if (a === null) return s.resetAndDestroy();
      s.once('data', () => s.end(a));
    });
    publish('chaos.test', '93.184.216.44', 80, await listen(chaos));
    routes.set('93.184.216.44:443', chaos.address().port);
    providerAnswer = (req, res) => {
      const a = said[turn++ % said.length];
      if (a === null) return res.socket.destroy();
      res.socket.end(a);
    };
    // What a requester sends in place of an answer.
    const nonsense = [
      null, undefined, 7, 'text', [], {}, { status: 99 }, { status: 100 }, { status: 101 }, { status: 200.5 }, { status: '200' }, { status: 600 }, { status: NaN },
      { status: 200, headers: { 'x-bad': 'a\r\nb: c' } }, { status: 200, headers: { 'bad name': '1' } }, { status: 200, headers: [['a', 'b']] }, { status: 200, headers: 'x' },
      { status: 200, headers: { 'x-num': 5, 'x-null': null, 'x-obj': {} } }, { status: 200, headers: { 'set-cookie': ['a=1', 'b=2'], 'x-und': undefined } },
      { status: 200, body: 12 }, { status: 200, body: {} }, { status: 200, body: '%%% not base64 %%%' }, { status: 200, headers: { 'content-length': '999999' }, body: 'aGk=' },
      { status: 204, body: 'aGk=' }, { status: 304, body: 'aGk=' }, { status: 200, headers: { 'transfer-encoding': 'chunked', connection: 'x-a', 'x-a': '1' }, body: 'aGk=' },
      { status: 599 }, { status: 200, headers: { '': 'x' } }, { status: 200, headers: { 'x\0': 'x' } },
      () => { throw new Error('the requester failed'); }, () => { throw null; }, () => { throw 'a string'; }, () => Promise.reject(undefined), () => Promise.reject({ status: 'x', message: 5 }),
    ];
    let said2 = 0;
    forgeAnswer = async () => {
      const a = nonsense[said2++ % nonsense.length];
      return typeof a === 'function' ? a() : a;
    };

    // Bytes to the proxy itself. Over when an answer's head has come or the connection
    // has closed; `cut` closes it as soon as the bytes are written.
    const outer = (bytes, { cut = false } = {}) => () => new Promise((resolve) => {
      const s = net.connect(port, '127.0.0.1', () => s.write(bytes, () => { if (cut) s.destroy(); }));
      let got = '';
      s.on('data', (d) => { got += d.toString('latin1'); if (got.includes('\r\n\r\n')) s.destroy(); });
      s.on('error', () => {});
      s.on('close', resolve);
    });
    // Bytes through a CONNECT: to a tunnel's far end, or in place of a TLS handshake.
    const through = (target, bytes, { cut = false } = {}) => async () => {
      const t = await tunnel(target, W).catch(() => ({ status: 0 }));
      if (t.status !== 200) return;
      await new Promise((resolve) => {
        t.socket.on('close', resolve);
        t.socket.on('data', () => t.socket.destroy());
        t.socket.on('error', () => {});
        t.socket.write(bytes, () => { if (cut) t.socket.destroy(); });
      });
    };
    // Bytes inside a terminated connection.
    const inner = (host, bytes, { cut = false } = {}) => async () => {
      const t = await tunnel(`${host}:443`, W).catch(() => ({ status: 0 }));
      if (t.status !== 200) return;
      await new Promise((resolve) => {
        const c = tls.connect({ socket: t.socket, servername: host, ca: wildCa });
        const end = () => { c.destroy(); t.socket.destroy(); };
        let got = '';
        c.on('secureConnect', () => c.write(bytes, () => { if (cut) end(); }));
        c.on('data', (d) => { got += d.toString('latin1'); if (got.includes('\r\n\r\n')) end(); });
        c.on('error', () => {});
        c.on('close', () => { t.socket.destroy(); resolve(); });
      });
    };

    const G = (p, more = '') => `GET http://chaos.test/${p} HTTP/1.1\r\nHost: chaos.test\r\n${W}${more}Connection: close\r\n\r\n`;
    const H = 'Host: api.github.com\r\n';
    const M = (key) => `Host: api.anthropic.com\r\nx-api-key: ${key}\r\n`;
    const pack = 'Host: github.com\r\nContent-Type: application/x-git-upload-pack-request\r\n';
    const shots = [];
    // Requests that are well formed, to an upstream, a requester and a provider that are not.
    for (let i = 0; i < 3 * said.length; i++) shots.push([`upstream answer ${i}`, outer(i % 5 === 4 ? G(i).replace('GET', 'HEAD') : G(i))]);
    for (let i = 0; i < 2 * nonsense.length; i++) shots.push([`requester answer ${i}`, inner('api.github.com', `GET /n${i} HTTP/1.1\r\n${H}Connection: close\r\n\r\n`)]);
    for (let i = 0; i < said.length; i++) {
      // The first of them on this machine's credential, the rest under a key of the job's own, which is not counted.
      shots.push([`provider answer ${i}`, inner('api.anthropic.com', `POST /v1/messages HTTP/1.1\r\n${M(i < 8 ? PLACEHOLDER : 'sk-the-jobs-own')}Content-Length: 2\r\nConnection: close\r\n\r\n{}`)]);
    }
    // Requests that are not.
    const bad = () => [
      outer(junk(64)), outer(Buffer.concat([junk(3000), Buffer.from('\r\n\r\n')])), outer('\r\n\r\n\r\n\r\n', { cut: true }), outer(`GET ${long(100000)} HTTP/1.1\r\n\r\n`), outer(`${long(20)} ${long(20)}\r\n\r\n`),
      outer(G('long', `X-Long: ${long(100000)}\r\n`)), outer(G('many', Array.from({ length: 3000 }, (_, k) => `X-${k}: 1\r\n`).join(''))), outer(`Proxy-Authorization: Basic ${long(100000)}\r\n\r\n`),
      outer(`GET http://chaos.test/ HTTP/1.1\nHost: chaos.test\n${W}\n`), outer(G('fold', 'X-A: 1\r\n folded\r\n')), outer(G('nul', 'X-A: a\0b\r\n')), outer(G('space', 'X-A : 1\r\n')),
      outer(`${G('tecl', 'Transfer-Encoding: chunked\r\nContent-Length: 4\r\n')}0\r\n\r\n`), outer(`${G('te', 'Transfer-Encoding: gzip, chunked\r\n')}0\r\n\r\n`),
      outer(`${G('chunk', 'Transfer-Encoding: chunked\r\n')}zz\r\nnot hex\r\n`), outer(`${G('chunk2', 'Transfer-Encoding: chunked\r\n')}ffffffffffffffffff\r\n`),
      outer(`${G('short', 'Content-Length: 1000\r\n')}short`, { cut: true }), outer(G('cl', 'Content-Length: -1\r\n')), outer(G('cl2', 'Content-Length: 99999999999999999999\r\n')),
      outer(G('expect', 'Expect: 100-continue\r\nContent-Length: 10\r\n')), outer(G('upgrade', 'Upgrade: websocket\r\n').replace('Connection: close', 'Connection: Upgrade')),
      outer(`GET / HTTP/1.1\r\nHost: x\r\n${W}\r\n`), outer(`OPTIONS * HTTP/1.1\r\nHost: x\r\n${W}\r\n`), outer(`GET ftp://chaos.test/ HTTP/1.1\r\n${W}\r\n`),
      outer(`GET http://chaos.test:99999/ HTTP/1.1\r\n${W}\r\n`), outer(`GET http://[::1/ HTTP/1.1\r\n${W}\r\n`), outer(`GET http:// HTTP/1.1\r\n${W}\r\n`), outer(`GET http://./ HTTP/1.1\r\n${W}\r\n`),
      outer(`GET http://chaos.test/%zz%00 HTTP/1.1\r\n${W}Connection: close\r\n\r\n`), outer(`BREW http://chaos.test/ HTTP/1.1\r\n${W}\r\n`), outer(`GET http://chaos.test/ HTTP/3.0\r\n${W}\r\n`),
      outer(`TRACE http://chaos.test/ HTTP/1.1\r\n${W}Connection: close\r\n\r\n`), outer(`POST http://chaos.test/ HTTP/1.1\r\n${W}Connection: close\r\nContent-Length: 4\r\n\r\nbodyGET http://chaos.test/next HTTP/1.1\r\n${W}\r\n`),
      ...['x', ':', 'a:99999', '[::1', `${long(70000)}:443`, 'http://chaos.test/', '*', 'chaos.test:80 extra', '%00:443', '..:443'].map((t) => outer(`CONNECT ${t} HTTP/1.1\r\n${W}\r\n`)),
      outer(`CONNECT chaos.test:80 HTTP/1.1\r\n${W}Content-Length: 10\r\n\r\n0123456789`), outer('CONNECT api.github.com:443 HTTP/1.1\r\nHost', { cut: true }),
      outer(`CONNECT chaos.test:80 HTTP/1.1\r\n${W}\r\n`, { cut: true }), outer(`CONNECT api.github.com:443 HTTP/1.1\r\n${W}\r\n`, { cut: true }),
      through('chaos.test:80', junk(5000)), through('chaos.test:443', junk(100), { cut: true }), through('api.github.com:443', junk(300)), through('api.anthropic.com:443', Buffer.from('GET / HTTP/1.1\r\n\r\n')),
      through('api.github.com:443', Buffer.from([0x16, 0x03, 0x01, 0xff, 0xff, 0x01]), { cut: true }), through('github.com:443', Buffer.concat([Buffer.from([0x16, 0x03, 0x03, 0x00, 0x40]), junk(64)])),
      inner('api.github.com', junk(200)), inner('api.github.com', `GET https://api.anthropic.com/v1/messages HTTP/1.1\r\n${H}\r\n`), inner('api.github.com', 'GET /x HTTP/1.1\r\nHost: evil.test\r\n\r\n'),
      inner('api.github.com', 'GET /x HTTP/1.1\r\n\r\n'), inner('api.github.com', `CONNECT chaos.test:80 HTTP/1.1\r\n${H}\r\n`), inner('api.github.com', `GET /x HTTP/1.1\r\n${H}Upgrade: websocket\r\nConnection: Upgrade\r\n\r\n`),
      inner('api.github.com', `POST /x HTTP/1.1\r\n${H}Transfer-Encoding: gzip\r\n\r\nxx`), inner('api.github.com', `POST /x HTTP/1.1\r\n${H}Transfer-Encoding: chunked\r\n\r\nzz\r\n`),
      inner('api.github.com', `POST /x HTTP/1.1\r\n${H}Content-Length: 1000\r\n\r\nshort`, { cut: true }), inner('api.github.com', `POST /x HTTP/1.1\r\n${H}Content-Length: ${FORGE_BODY_CAP + 1}\r\n\r\n`),
      inner('api.github.com', `GET /x HTTP/1.1\r\n${H}X-Long: ${long(100000)}\r\n\r\n`), inner('api.github.com', `GET /a HTTP/1.1\r\n${H}\r\nGET /b HTTP/1.1\r\n${H}\r\n${junk(50).toString('latin1')}`),
      inner('api.github.com', `GET /%zz%00?%ff HTTP/1.1\r\n${H}Connection: close\r\n\r\n`), inner('api.github.com', `GET //evil.test/x HTTP/1.1\r\n${H}Connection: close\r\n\r\n`),
      inner('api.github.com', `POST /x HTTP/1.1\r\n${H}Expect: 100-continue\r\nContent-Length: 10\r\n\r\n`), inner('api.github.com', `GET /x HTTP/1.1\r\n${H}Content-Length: 5\r\nContent-Length: 6\r\n\r\nhello!`),
      inner('github.com', `POST /dn-test/alpha.git/git-upload-pack HTTP/1.1\r\n${pack}Content-Length: 300\r\nConnection: close\r\n\r\n${junk(300).toString('latin1')}`),
      inner('github.com', `POST /dn-test/alpha.git/git-upload-pack HTTP/1.1\r\n${pack}Content-Encoding: gzip\r\nContent-Length: 300\r\nConnection: close\r\n\r\n${junk(300).toString('latin1')}`),
      inner('github.com', `POST /dn-test/alpha.git/git-upload-pack HTTP/1.1\r\n${pack}Content-Length: 1000\r\n\r\nshort`, { cut: true }),
      inner('github.com', 'GET /dn-test/alpha.git/info/refs?service=git-upload-pack HTTP/1.1\r\nHost: github.com\r\n\r\n', { cut: true }),
      inner('github.com', `GET /dn-test/alpha.git/info/refs?service=git-upload-pack HTTP/1.1\r\nHost: github.com\r\nGit-Protocol: ${long(5000)}\r\nConnection: close\r\n\r\n`),
      inner('api.anthropic.com', `POST /v1/messages HTTP/1.1\r\n${M(PLACEHOLDER)}Transfer-Encoding: chunked\r\n\r\nzz\r\n`),
      inner('api.anthropic.com', `POST /v1/messages HTTP/1.1\r\n${M(PLACEHOLDER)}Content-Length: 1000\r\n\r\nshort`, { cut: true }),
      inner('api.anthropic.com', `GET /v1/messages?${long(60000)} HTTP/1.1\r\n${M('sk-the-jobs-own')}Connection: close\r\n\r\n`), inner('api.anthropic.com', `POST /v1/messages HTTP/1.1\r\n${M('a\0b')}\r\n`),
      inner('api.anthropic.com', `POST https://api.github.com/user HTTP/1.1\r\n${M(PLACEHOLDER)}Content-Length: 0\r\n\r\n`),
    ];
    for (const round of [1, 2]) bad().forEach((run, i) => shots.push([`malformed request ${i}, round ${round}`, run]));
    assert.ok(shots.length > 300, `${shots.length} things thrown`);
    for (let i = shots.length - 1; i > 0; i--) {
      const k = Math.floor(rnd() * (i + 1));
      [shots[i], shots[k]] = [shots[k], shots[i]];
    }

    const stuck = [];
    let cursor = 0;
    await Promise.all(Array.from({ length: 16 }, async () => {
      while (cursor < shots.length) {
        const [what, run] = shots[cursor++];
        await within(run(), what, 40000).catch((e) => stuck.push(`${what}: ${e.message}`));
      }
    }));
    assert.deepEqual(stuck, [], 'each was answered or its connection closed');
    noFaults();

    // Another job, on every path, as if none of it had happened.
    forgeAnswer = async () => okAnswer;
    providerAnswer = okProvider;
    assert.equal((await request(job, 'api.github.com', { path: '/zen' })).status, 200);
    assert.equal((await request(job, 'api.anthropic.com', { method: 'POST', path: '/v1/messages', headers: { 'x-api-key': PLACEHOLDER }, body: Buffer.from('{}') })).status, 200);
    assert.equal((await viaProxy(job, 'http://plain.test/after')).status, 200);
    const t = await tunnel('tunnel.test:443', basic('dn', job.token));
    assert.equal(t.status, 200);
    t.socket.destroy();
    const cloned = await gitVia(job, ['ls-remote', 'https://github.com/dn-test/alpha.git', 'refs/heads/main']);
    assert.equal(cloned.code, 0, cloned.stderr);
    // And nothing the wild job held is held still.
    await until(() => Object.values(broker.load('run-wild')).every((n) => n === 0), `everything the wild job held to be given back: ${JSON.stringify(broker.load('run-wild'))}`);
    broker.removeJob('run-wild');
    noFaults();
  });

  await check('a job\'s upstream connections are its own: kept for its next request, never lent to another job, closed with it', async () => {
    const open = new Set();
    let made = 0;
    const counted = http.createServer((req, res) => res.end(`connection ${req.socket.dnId} for ${req.url}`));
    counted.keepAliveTimeout = 600000;
    counted.on('connection', (s) => { s.dnId = ++made; open.add(s); s.on('close', () => open.delete(s)); });
    publish('counted.test', '93.184.216.42', 80, await listen(counted));
    const one = await broker.addJob({ runId: 'run-one', pool: alpha.pool });
    const two = await broker.addJob({ runId: 'run-two', pool: alpha.pool });
    const got = [];
    for (const [j, p] of [[one, 'a1'], [two, 'b1'], [one, 'a2'], [two, 'b2']]) got.push((await viaProxy(j, `http://counted.test/${p}`)).body);
    assert.deepEqual(got, ['connection 1 for /a1', 'connection 2 for /b1', 'connection 1 for /a2', 'connection 2 for /b2']);

    // The same for the model provider's.
    const ask = async (j) => {
      assert.equal((await request(j, 'api.anthropic.com', { method: 'POST', path: '/v1/messages', headers: { 'x-api-key': 'sk-the-jobs-own' }, body: Buffer.from('{}') })).status, 200);
      return providerSeen.at(-1).socket;
    };
    const sockets = [await ask(one), await ask(two), await ask(one), await ask(two)];
    assert.equal(sockets[2], sockets[0], 'a job\'s next request goes down the connection it has');
    assert.equal(sockets[3], sockets[1]);
    assert.notEqual(sockets[1], sockets[0], 'and never down another job\'s');

    broker.removeJob('run-one');
    await until(() => [...open].map((s) => s.dnId).join() === '2' && sockets[0].destroyed, 'the removed job\'s upstream connections to close');
    assert.equal(sockets[1].destroyed, false);
    assert.equal((await viaProxy(two, 'http://counted.test/b3')).body, 'connection 2 for /b3', 'the other job\'s are untouched');
    broker.removeJob('run-two');
    await until(() => open.size === 0 && sockets[1].destroyed, 'the last of them to close');
  });

  await check('a job that ends while a connection of its is still being made leaves none behind', async () => {
    const open = new Set();
    let made = 0;
    const lateSeen = [];
    const late = http.createServer((req, res) => { lateSeen.push(req.url); res.end('late'); });
    late.keepAliveTimeout = 600000;
    late.on('connection', (s) => { made += 1; open.add(s); s.on('close', () => open.delete(s)); });
    publish('late.test', '93.184.216.43', 80, await listen(late));
    routes.set('93.184.216.43:443', late.address().port);
    // The connection is handed over in the turn the job ends, when the job's own
    // connection is cut and has not yet been seen to close, and once it has closed.
    for (const [what, target, start] of [
      ['a request', '93.184.216.43:80', (j) => viaProxy(j, 'http://late.test/x')],
      ['a tunnel', '93.184.216.43:443', (j) => tunnel('late.test:443', basic('dn', j.token))],
    ]) {
      for (const closedFirst of [false, true]) {
        const j = await broker.addJob({ runId: 'run-late', pool: alpha.pool });
        let release;
        gates.set(target, new Promise((r) => { release = r; }));
        const dialled = dials.length;
        const before = made;
        const asked = start(j).catch((e) => e);
        await until(() => dials.length === dialled + 1 && made === before + 1, `the connection for ${what} to be made`);
        broker.removeJob('run-late');
        // The client learns of the cut in the turn of the loop the broker does, or a
        // later one: a turn on, the broker has seen its side close.
        if (closedFirst) {
          await asked;
          await new Promise((r) => setImmediate(r));
        }
        release();
        gates.delete(target);
        await asked;
        await until(() => open.size === 0, `the connection made for ${what} of a job that ended to be closed`, 20000);
      }
    }
    assert.deepEqual(lateSeen, []);
  });

  await check('a request\'s body is framed by the broker: nothing in it is a request of its own upstream, and a request framed two ways is refused', async () => {
    const A = basic('dn', job.token);
    const hidden = 'GET /smuggled HTTP/1.1\r\nHost: plain.test\r\n\r\n';
    let n = plainSeen.length;
    let r = await raw(`GET http://plain.test/carrier HTTP/1.1\r\nHost: plain.test\r\n${A}Transfer-Encoding: chunked\r\nConnection: close\r\n\r\n${hidden.length.toString(16)}\r\n${hidden}\r\n0\r\n\r\n`);
    assert.equal(r.status, 200);
    assert.deepEqual(plainSeen.slice(n).map((s) => [s.url, s.body, s.headers['transfer-encoding'], s.headers['content-length']]), [['/carrier', hidden, 'chunked', undefined]]);
    n = plainSeen.length;
    r = await raw(`GET http://plain.test/counted HTTP/1.1\r\nHost: plain.test\r\n${A}Content-Length: 0${hidden.length}\r\nConnection: close\r\n\r\n${hidden}`);
    assert.equal(r.status, 200);
    assert.deepEqual(plainSeen.slice(n).map((s) => [s.url, s.body, s.headers['transfer-encoding'], s.headers['content-length']]), [['/counted', hidden, undefined, String(hidden.length)]]);

    // Framed two ways, or in a way an upstream may read differently: answered 400 or
    // cut, and never passed on.
    n = plainSeen.length;
    const req = (headers, body = '') => `POST http://plain.test/framed HTTP/1.1\r\nHost: plain.test\r\n${A}${headers}Connection: close\r\n\r\n${body}`;
    const mine = [
      ['a coding before chunked', req('Transfer-Encoding: gzip, chunked\r\n', '2\r\nxx\r\n0\r\n\r\n')],
      ['another coding before chunked', req('Transfer-Encoding: identity, chunked\r\n', '2\r\nxx\r\n0\r\n\r\n')],
    ];
    const parsers = [
      ['a length and a coding', req('Transfer-Encoding: chunked\r\nContent-Length: 4\r\n', '0\r\n\r\n')],
      ['a coding and a length', req('Content-Length: 4\r\nTransfer-Encoding: chunked\r\n', '0\r\n\r\n')],
      ['two lengths', req('Content-Length: 5\r\nContent-Length: 6\r\n', 'hello!')],
      ['chunked twice', req('Transfer-Encoding: chunked\r\nTransfer-Encoding: chunked\r\n', '0\r\n\r\n')],
      ['a coding that is not chunked', req('Transfer-Encoding: gzip\r\n', 'xx')],
      ['a folded header', req('X-A: 1\r\n folded: yes\r\n')],
      ['a bare line feed', `GET http://plain.test/framed HTTP/1.1\r\nHost: plain.test\n${A}\r\n`],
      ['a bare line feed after a chunk size', req('Transfer-Encoding: chunked\r\n', '2\nxx\n0\n\n')],
      ['a space before a colon', req('Transfer-Encoding : chunked\r\n', '0\r\n\r\n')],
      ['a length with a sign', req('Content-Length: +5\r\n', 'hello')],
      ['a coding with a parameter', req('Transfer-Encoding: chunked;q=1\r\n', '2\r\nxx\r\n0\r\n\r\n')],
    ];
    for (const [what, text] of mine) {
      const got = await raw(text);
      assert.equal(got.status, 400, what);
      assert.match(got.text, new RegExp(FRAMING.replace(/[.:]/g, '\\$&')), what);
    }
    for (const [what, text] of parsers) assert.ok([0, 400].includes((await raw(text)).status), what);
    assert.equal(plainSeen.length, n, 'none of them reached the upstream');
  });

  await check('what belongs to one connection stays on it, in both directions: the hop-by-hop headers and whatever Connection names', async () => {
    const seen = [];
    const hops = net.createServer((s) => {
      s.on('error', () => {});
      s.once('data', (d) => {
        seen.push(d.toString('latin1'));
        s.end('HTTP/1.1 200 OK\r\nConnection: X-Internal, close\r\nX-Internal: 1\r\nKeep-Alive: timeout=9\r\nProxy-Authenticate: Basic realm="upstream"\r\nUpgrade: h2c\r\nTrailer: X-T\r\n'
          + 'X-Kept: yes\r\nTransfer-Encoding: chunked\r\n\r\n2\r\nok\r\n0\r\nX-T: 1\r\n\r\n');
      });
    });
    publish('hops.test', '93.184.216.45', 80, await listen(hops));
    const r = await raw(`GET http://hops.test/x HTTP/1.1\r\nHost: hops.test\r\n${basic('dn', job.token)}Connection: X-Private, close\r\nX-Private: 1\r\nKeep-Alive: timeout=5\r\nTE: trailers\r\n`
      + 'Upgrade: h2c\r\nTrailer: X-T\r\nProxy-Connection: keep-alive\r\nX-Kept: yes\r\n\r\n');
    assert.equal(r.status, 200);
    const [head, body] = r.text.toLowerCase().split('\r\n\r\n');
    for (const gone of ['x-internal', 'timeout=9', 'proxy-authenticate', 'upgrade:', 'trailer:']) assert.equal(head.includes(gone), false, `${gone} came back to the job`);
    assert.match(head, /\r\nx-kept: yes/);
    assert.match(body, /^2\r\nok\r\n0/, 'the body, framed again');
    const sent = seen[0].toLowerCase();
    for (const gone of ['x-private', 'timeout=5', '\r\nte:', 'upgrade:', 'trailer:', 'proxy-']) assert.equal(sent.includes(gone), false, `${gone} went upstream`);
    assert.match(sent, /\r\nx-kept: yes/);
    assert.match(sent, /^get \/x http\/1\.1\r\n/);
  });

  await check('each request on a terminated connection is judged on its own: its Host is the connection\'s, its target a path, its coding chunked or none, and it counts', async () => {
    forgeAnswer = async () => okAnswer;
    const seen = () => [forgeSeen.length, providerSeen.length];
    const s = await secure(job, 'api.github.com');
    assert.equal((await exchange(s, 'GET /a HTTP/1.1\r\nHost: api.github.com\r\n\r\n')).status, 200);
    const before = seen();
    const elsewhere = 'this connection is to api.github.com: a request for another host needs a connection of its own';
    const turned = [
      ['the model provider, down a connection to the forge', `POST /v1/messages HTTP/1.1\r\nHost: api.anthropic.com\r\nx-api-key: ${PLACEHOLDER}\r\nContent-Length: 2\r\n\r\n{}`, 421, elsewhere],
      ['another host of the same forge', 'GET /user HTTP/1.1\r\nHost: github.com\r\n\r\n', 421, elsewhere],
      ['two hosts', 'GET /user HTTP/1.1\r\nHost: api.github.com\r\nHost: api.anthropic.com\r\n\r\n', 421, elsewhere],
      ['the host twice', 'GET /user HTTP/1.1\r\nHost: api.github.com\r\nHost: api.github.com\r\n\r\n', 421, elsewhere],
      ['another site as the target', `GET https://api.anthropic.com/v1/messages HTTP/1.1\r\nHost: api.github.com\r\nx-api-key: ${PLACEHOLDER}\r\n\r\n`, 400, 'the request target must be a path'],
      ['an address of the host as the target', 'GET http://169.254.169.254/latest/meta-data HTTP/1.1\r\nHost: api.github.com\r\n\r\n', 400, 'the request target must be a path'],
      ['no target', 'OPTIONS * HTTP/1.1\r\nHost: api.github.com\r\n\r\n', 400, 'the request target must be a path'],
      ['a coding before chunked', 'POST /x HTTP/1.1\r\nHost: api.github.com\r\nTransfer-Encoding: gzip, chunked\r\n\r\n0\r\n\r\n', 400, FRAMING],
    ];
    for (const [what, text, status, message] of turned) {
      const r = await exchange(s, text);
      assert.equal(r.status, status, what);
      assert.deepEqual(JSON.parse(r.body), { message }, what);
    }
    const old = await secure(job, 'api.github.com');
    assert.equal((await exchange(old, 'GET /user HTTP/1.0\r\n\r\n')).status, 421, 'no host at all');
    old.destroy();
    assert.deepEqual(seen(), before, 'neither the requester nor the provider was asked');
    assert.equal((await exchange(s, 'GET /b HTTP/1.1\r\nHost: api.github.com\r\n\r\n')).status, 200, 'and the connection goes on serving what is its own');
    // The name decides, however it is spelled and whatever port is written beside it.
    for (const named of ['api.github.com:443', 'API.GitHub.com.', 'api.github.com:80']) {
      assert.equal((await exchange(s, `GET /c HTTP/1.1\r\nHost: ${named}\r\n\r\n`)).status, 200, named);
      assert.equal(forgeSeen.at(-1).request.host, 'api.github.com');
    }
    s.destroy();

    // Two requests sent at once are two requests: the second finds the job's share used up.
    providerAnswer = (req, res) => { res.writeHead(200, { 'content-type': 'application/json', 'content-length': 11 }); res.end('{"ok":true}'); };
    const last = await broker.addJob({ runId: 'run-last', pool: alpha.pool }, { spent: { requests: 11, bytes: 0 } });
    const m = await secure(last, 'api.anthropic.com');
    const ask = `POST /v1/messages HTTP/1.1\r\nHost: api.anthropic.com\r\nx-api-key: ${PLACEHOLDER}\r\nContent-Length: 2\r\n\r\n{}`;
    const both = answers(m, 2);
    m.write(ask + ask);
    assert.deepEqual((await within(both, 'two answers')).map((r) => r.status), [200, 429]);
    m.destroy();
    broker.removeJob('run-last');
    providerAnswer = okProvider;
  });

  await check('a request read after its job ended is dropped, even on a connection that is still open', async () => {
    const traced = [];
    let onTrace = null;
    await withBroker({ trace: (line) => { traced.push(line); if (onTrace) onTrace(line); } }, async (b) => {
      const j = await b.addJob({ runId: 'run-ended', pool: alpha.pool });
      const s = await secure(j, 'api.github.com');
      const closed = new Promise((r) => { s.on('close', r); s.on('error', () => {}); });
      const seen = forgeSeen.length;
      // The job ends while the first of two requests that arrived together is being read.
      onTrace = (line) => { if (line.includes('/first')) b.removeJob('run-ended'); };
      s.write('GET /first HTTP/1.1\r\nHost: api.github.com\r\n\r\nGET /second HTTP/1.1\r\nHost: api.github.com\r\n\r\n');
      await within(closed, 'the connection to be cut');
      assert.equal(traced.filter((l) => l.includes('/first')).length, 1);
      assert.deepEqual(traced.filter((l) => l.includes('/second')), [], 'the second was not so much as looked at');
      assert.deepEqual(forgeSeen.slice(seen).map((x) => x.request.path).filter((p) => p === '/second'), []);
    });
  });

  await check('a job holds so much of the broker at a time and no more: connections, bodies read whole, forge requests in flight', async () => {
    await withBroker({ limits: { connections: 4, bufferBytes: 2 ** 20, forgeRequests: 2, answerMs: 600000 } }, async (b) => {
      const held = await b.addJob({ runId: 'held', pool: alpha.pool });
      const free = await b.addJob({ runId: 'free', pool: alpha.pool });
      const load = () => b.load('held');
      assert.deepEqual(load(), { connections: 0, bytes: 0, requests: 0, waiting: 0 });
      assert.equal(b.load('nobody'), null);

      // Connections.
      const tunnels = [];
      for (let i = 0; i < 4; i++) tunnels.push(await tunnel('tunnel.test:443', basic('dn', held.token)));
      assert.deepEqual(tunnels.map((t) => t.status), [200, 200, 200, 200]);
      assert.equal(load().connections, 4);
      const fifth = await tunnel('tunnel.test:443', basic('dn', held.token));
      assert.equal(fifth.status, 503);
      assert.equal(fifth.body, 'this job has 4 connections open through the broker, the most a job gets at a time: close some\n');
      const sixth = await viaProxy(held, 'http://plain.test/x');
      assert.equal(sixth.status, 503);
      assert.match(JSON.parse(sixth.body).message, /^this job has 4 connections open/);
      const theirs = await tunnel('tunnel.test:443', basic('dn', free.token));
      assert.equal(theirs.status, 200, 'another job has connections of its own');
      theirs.socket.destroy();
      tunnels.pop().socket.destroy();
      await until(() => load().connections === 3, 'a closed connection to be given back');
      const again = await tunnel('tunnel.test:443', basic('dn', held.token));
      assert.equal(again.status, 200);
      for (const t of [again, ...tunnels]) t.socket.destroy();
      await until(() => load().connections === 0, 'the connections to be given back');

      // Bodies read whole: one that does not fit beside those being held waits, unread.
      const pending = [];
      const waitFor = (p) => until(() => pending.some((a) => a.path === p), `${p} to reach the requester`);
      const answer = (p) => pending.find((a) => a.path === p).resolve(okAnswer);
      forgeAnswer = (jb, r) => new Promise((resolve) => pending.push({ path: r.path, resolve }));
      const big = Buffer.alloc(700 * 1024, 1);
      const post = (j, p, body) => request(j, 'api.github.com', { method: 'POST', path: p, body, headers: { 'content-length': body.length } }).catch((e) => e);
      const first = post(held, '/first', big);
      await waitFor('/first');
      assert.deepEqual(load(), { connections: 1, bytes: big.length, requests: 1, waiting: 0 });
      const second = post(held, '/second', big);
      await until(() => load().waiting === 1, 'the second body to wait its turn');
      // One that would fit beside the first does not go ahead of the one that waits.
      const third = post(held, '/third', Buffer.alloc(10, 1));
      await until(() => load().waiting === 2, 'the third body to wait behind the second');
      assert.deepEqual(pending.map((a) => a.path), ['/first']);
      // A request with no body is short of nothing the second waits for.
      const bodiless = request(held, 'api.github.com', { path: '/bodiless' });
      await waitFor('/bodiless');
      answer('/bodiless');
      assert.equal((await bodiless).status, 200);
      // Another job's requests wait for nobody but themselves.
      const other = post(free, '/theirs', big);
      await waitFor('/theirs');
      answer('/theirs');
      assert.equal((await other).status, 200);
      assert.equal(load().waiting, 2);
      answer('/first');
      assert.equal((await first).status, 200);
      await waitFor('/second');
      await waitFor('/third');
      assert.equal(load().waiting, 0);
      answer('/second');
      answer('/third');
      assert.deepEqual([(await second).status, (await third).status], [200, 200]);
      await until(() => load().bytes === 0 && load().requests === 0, 'what the answered requests held to be given back');

      // Forge requests in flight: two, the third waits; the model is no forge request.
      const three = ['/s1', '/s2', '/s3'].map((p) => request(held, 'api.github.com', { path: p }));
      await until(() => load().waiting === 1 && pending.filter((a) => /^\/s\d/.test(a.path)).length === 2, 'two requests at the requester and a third waiting');
      assert.equal(load().requests, 2);
      assert.equal((await request(held, 'api.anthropic.com', { method: 'POST', path: '/v1/messages', headers: { 'x-api-key': PLACEHOLDER }, body: Buffer.from('{}') })).status, 200);
      assert.equal(pending.filter((a) => /^\/s\d/.test(a.path)).length, 2);
      for (const a of pending.filter((x) => /^\/s\d/.test(x.path))) a.resolve(okAnswer);
      await until(() => pending.filter((a) => /^\/s\d/.test(a.path)).length === 3, 'the third to take its turn');
      pending.at(-1).resolve(okAnswer);
      assert.deepEqual((await Promise.all(three)).map((r) => r.status), [200, 200, 200]);

      // A body over what one request may carry is refused on its head alone.
      const s = await secure(free, 'api.github.com');
      const over = await within(exchange(s, `POST /over HTTP/1.1\r\nHost: api.github.com\r\nContent-Length: ${FORGE_BODY_CAP + 1}\r\n\r\n`), 'a refusal before the body');
      assert.equal(over.status, 413);
      s.destroy();

      // The model's answer is passed on as it comes, so the request's bytes are given back
      // as it begins and not when the job has read it all.
      await until(() => load().bytes === 0 && load().requests === 0, 'what the answered requests held to be given back');
      let streaming = null;
      providerAnswer = (req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('data: 1\n\n'); streaming = res; };
      const m = await secure(held, 'api.anthropic.com');
      let had = '';
      m.on('data', (d) => { had += d; });
      m.write(`POST /v1/messages HTTP/1.1\r\nHost: api.anthropic.com\r\nx-api-key: ${PLACEHOLDER}\r\nContent-Length: 2\r\n\r\n{}`);
      await until(() => had.includes('data: 1'), 'the model\'s answer to begin');
      assert.equal(load().bytes, 0);
      streaming.end();
      m.destroy();
      providerAnswer = okProvider;

      // A connection that closes takes its requests with it: the one being answered gives
      // back what it held, and the one waiting behind it on that connection is not given it.
      const x = await secure(held, 'api.github.com');
      x.on('error', () => {});
      x.write(`POST /x1 HTTP/1.1\r\nHost: api.github.com\r\nContent-Length: ${big.length}\r\n\r\n`);
      x.write(big);
      x.write(`POST /x2 HTTP/1.1\r\nHost: api.github.com\r\nContent-Length: ${big.length}\r\n\r\n`);
      await waitFor('/x1');
      await until(() => load().waiting === 1, 'the second request on the connection to wait');
      const y = post(held, '/y', Buffer.alloc(10, 1));
      await until(() => load().waiting === 2, 'a request on another connection to wait behind it');
      x.destroy();
      await waitFor('/y');
      answer('/y');
      assert.equal((await y).status, 200);
      await until(() => load().bytes === 0 && load().requests === 0 && load().waiting === 0, 'all of it to be given back, and once', 20000);
      assert.deepEqual(pending.filter((a) => a.path === '/x2'), []);

      // A place waited for is given up when its client goes away, and when its job ends.
      const early = await secure(held, 'api.github.com');
      early.on('error', () => {});
      const blocker = post(held, '/blocker', big);
      await waitFor('/blocker');
      const leaver = await secure(held, 'api.github.com');
      leaver.write(`POST /leaver HTTP/1.1\r\nHost: api.github.com\r\nContent-Length: ${big.length}\r\n\r\n`);
      await until(() => load().waiting === 1, 'a request to wait');
      leaver.destroy();
      await until(() => load().waiting === 0, 'the place of a client that went away to be given up');
      const waiting = post(held, '/waiting', big);
      await until(() => load().waiting === 1, 'another request to wait');
      // One that waits for a place only, on a connection older than those of the requests
      // it waits for: theirs close first, and it has nothing left to read once let in.
      const placed = request(held, 'api.github.com', { path: '/second-place' }).catch((e) => e);
      await waitFor('/second-place');
      const cut = new Promise((r) => { early.on('close', r); });
      early.write('GET /placeless HTTP/1.1\r\nHost: api.github.com\r\n\r\n');
      await until(() => load().waiting === 2, 'a request to wait for a place');
      b.removeJob('held');
      assert.equal(b.load('held'), null);
      assert.ok((await waiting) instanceof Error, 'the waiting request is cut with its job');
      await within(cut, 'the connection of the request that waited for a place to be cut');
      assert.ok((await blocker) instanceof Error);
      assert.ok((await placed) instanceof Error);
      assert.deepEqual(pending.map((a) => a.path).filter((p) => ['/leaver', '/waiting', '/placeless'].includes(p)), [], 'what waited as its job ended is not let in on the way out');
    });
    forgeAnswer = async () => okAnswer;
  });

  await check('what does not arrive is not waited for: a request\'s head and its body each have their time, however they trickle in', async () => {
    await withBroker({ limits: { headerMs: 2000, bodyMs: 1500, forgeRequests: 1 } }, async (b) => {
      forgeAnswer = async () => okAnswer;
      const j = await b.addJob({ runId: 'slow', pool: alpha.pool });
      const closed = (s) => new Promise((r) => { s.on('error', () => {}); s.on('close', r); });
      // A byte now and then keeps a connection from being idle. It does not make a request arrive.
      const trickle = (s, text) => {
        let i = 0;
        const timer = setInterval(() => { if (!s.destroyed && i < text.length) s.write(text[i++]); }, 250);
        s.on('close', () => clearInterval(timer));
      };
      const cases = [];
      cases.push(['a connection that says nothing', closed(net.connect(port, '127.0.0.1'))]);
      const half = net.connect(port, '127.0.0.1', () => { half.write(`GET http://plain.test/ HTTP/1.1\r\nHost: plain.test\r\n${basic('dn', j.token)}X-Slow: `); trickle(half, 'a'.repeat(400)); });
      cases.push(['a head that trickles in', closed(half)]);
      const bare = await tunnel('api.github.com:443', basic('dn', j.token));
      assert.equal(bare.status, 200);
      cases.push(['a terminated connection with no handshake', closed(bare.socket)]);
      cases.push(['a terminated connection with no request', closed(await secure(j, 'api.github.com'))]);
      const next = await secure(j, 'api.github.com');
      assert.equal((await exchange(next, 'GET /one HTTP/1.1\r\nHost: api.github.com\r\n\r\n')).status, 200);
      next.write('GET /two HTTP/1.1\r\nHost: api.github.com\r\nX-Slow: ');
      trickle(next, 'a'.repeat(400));
      cases.push(['a second head that trickles in', closed(next)]);
      const seen = forgeSeen.length;
      const bodied = await secure(j, 'api.github.com');
      const told = answers(bodied);
      bodied.write('POST /body HTTP/1.1\r\nHost: api.github.com\r\nContent-Length: 400\r\n\r\n');
      trickle(bodied, 'b'.repeat(400));
      cases.push(['a body that trickles in', told.then(([r]) => {
        assert.equal(r?.status, 408);
        assert.deepEqual(JSON.parse(r.body), { message: 'the request body did not arrive within 1.5 s' });
      })]);
      for (const [what, over] of cases) await within(over, `${what} to be given up on`, 30000);
      assert.equal(forgeSeen.length, seen, 'none of it reached the requester');
      bodied.destroy();

      // A request that is being answered has arrived: it is not cut when the time its head
      // had is over, and one that waits behind it for longer than a body may take is told
      // why. The answer here is one its client is slow to read.
      const down = crypto.randomBytes(16 * 2 ** 20);
      forgeAnswer = async (jb, r) => (r.path === '/held' ? { status: 200, headers: {}, body: down } : okAnswer);
      const holder = await secure(j, 'api.github.com');
      holder.pause();
      const started = Date.now();
      holder.write('GET /held HTTP/1.1\r\nHost: api.github.com\r\n\r\n');
      await until(() => b.load('slow').bytes === down.length, 'the held answer to be on its way');
      const behind = await request(j, 'api.github.com', { path: '/behind' });
      assert.equal(behind.status, 503);
      assert.deepEqual(JSON.parse(behind.body), { message: 'this job\'s earlier requests hold all the broker reads for one job at a time (48 MiB of bodies, forge requests in flight: 1), and none ended within 1.5 s' });
      await until(() => Date.now() - started > 3000, 'the time a head has to pass');
      assert.equal(b.load('slow').requests, 1, 'the answer is still being read');
      const whole = new Promise((resolve) => {
        let got = 0;
        holder.on('data', (d) => { got += d.length; if (got >= down.length) resolve(); });
      });
      holder.resume();
      await within(whole, 'the held answer to arrive whole');
      holder.destroy();
    });
    forgeAnswer = async () => okAnswer;
  });

  await check('a connection nothing moves on is closed after a while: a tunnel, and a request whose upstream stays silent', async () => {
    const silent = net.createServer((c) => c.on('error', () => {}).resume());
    publish('silent.test', '93.184.216.44', 80, await listen(silent));
    await withBroker({ limits: { idleMs: 1000 } }, async (b) => {
      const j = await b.addJob({ runId: 'idle', pool: alpha.pool });
      const t = await tunnel('tunnel.test:443', basic('dn', j.token));
      assert.equal(t.status, 200);
      await within(new Promise((r) => { t.socket.on('close', r); }), 'an idle tunnel to be closed', 30000);
      const plainly = await within(viaProxy(j, 'http://silent.test/x').catch((e) => e), 'a plain request nobody answers to be closed', 30000);
      assert.ok(plainly instanceof Error);
      providerAnswer = () => {};
      const asked = request(j, 'api.anthropic.com', { method: 'POST', path: '/v1/messages', headers: { 'x-api-key': PLACEHOLDER }, body: Buffer.from('{}') }).catch((e) => e);
      assert.ok(await within(asked, 'a model request nobody answers to be closed', 30000) instanceof Error);
    });
    providerAnswer = okProvider;
  });

  await check('of the provider\'s answer a job gets what a client needs, and nothing that tells of the account behind the credential', async () => {
    providerAnswer = (req, res) => {
      res.writeHead(429, {
        'content-type': 'application/json', 'content-length': '2', 'request-id': 'req_9', 'retry-after': '7', 'x-should-retry': 'true', 'cache-control': 'no-store',
        'anthropic-organization-id': 'org-of-the-operator', 'anthropic-ratelimit-unified-5h-utilization': '0.93', 'anthropic-ratelimit-requests-remaining': '12',
        'set-cookie': 'session=operator', 'cf-ray': 'abc-WAW', server: 'cloudflare', via: '1.1 google', 'x-envoy-upstream-service-time': '81', 'strict-transport-security': 'max-age=1',
        'x-robots-tag': 'none', 'www-authenticate': 'Bearer realm="operator"', 'x-request-id': 'internal',
      });
      res.end('{}');
    };
    const asker = await broker.addJob({ runId: 'run-headers', pool: alpha.pool });
    for (const key of [PLACEHOLDER, 'sk-the-jobs-own']) {
      const r = await request(asker, 'api.anthropic.com', { method: 'POST', path: '/v1/messages', headers: { 'x-api-key': key }, body: Buffer.from('{}') });
      assert.equal(r.status, 429);
      // Beside what the broker's own server says of its connection.
      const got = Object.fromEntries(Object.entries(r.headers).filter(([name]) => !['connection', 'date', 'keep-alive'].includes(name)));
      assert.deepEqual(got, { 'content-type': 'application/json', 'content-length': '2', 'request-id': 'req_9', 'retry-after': '7', 'x-should-retry': 'true', 'cache-control': 'no-store' });
    }
    broker.removeJob('run-headers');
    providerAnswer = okProvider;
  });

  await check('what a job has had of the model is told as it grows, and a job taken up again goes on from what it had', async () => {
    providerAnswer = okProvider;
    const heard = [];
    const off = broker.onSpend((runId, spent) => heard.push([runId, spent]));
    const failing = broker.onSpend(() => { throw new Error('a listener that fails'); });
    const body = Buffer.from(JSON.stringify({ messages: [] }));
    const ask = (j) => request(j, 'api.anthropic.com', { method: 'POST', path: '/v1/messages', headers: { 'x-api-key': PLACEHOLDER }, body });
    await broker.addJob({ runId: 'run-spend', pool: alpha.pool }).then(async (fresh) => {
      assert.deepEqual(broker.spent('run-spend'), { requests: 0, bytes: 0 });
      assert.equal(broker.spent('nobody'), null);
      const r = await ask(fresh);
      assert.equal(r.status, 200, 'a listener that fails costs the job nothing');
      await until(() => heard.length === 2, 'the spend to be told as the request is counted and again once its answer has passed');
      assert.deepEqual(heard, [['run-spend', { requests: 1, bytes: body.length }], ['run-spend', { requests: 1, bytes: body.length + r.body.length }]]);
      assert.deepEqual(broker.spent('run-spend'), heard[1][1]);
      heard[1][1].requests = 99;
      assert.equal(broker.spent('run-spend').requests, 1, 'what a listener is handed is a copy');
      assert.ok(logged.some((l) => l.includes('a spend listener failed: a listener that fails')));
    });
    broker.removeJob('run-spend');
    assert.equal(broker.spent('run-spend'), null);

    // One request short of its share, which is 12 here; then all its bytes had.
    const again = await broker.addJob({ runId: 'run-spend', pool: alpha.pool }, { spent: { requests: 11, bytes: 1000 } });
    assert.deepEqual(broker.spent('run-spend'), { requests: 11, bytes: 1000 });
    assert.deepEqual([(await ask(again)).status, (await ask(again)).status], [200, 429]);
    assert.equal(broker.spent('run-spend').requests, 12);
    broker.removeJob('run-spend');
    const full = await broker.addJob({ runId: 'run-spend', pool: alpha.pool }, { spent: { requests: 0, bytes: 300000 } });
    assert.equal((await ask(full)).status, 429);
    broker.removeJob('run-spend');
    // What is no count is none.
    for (const none of [null, undefined, {}, 'x', { requests: -5, bytes: 'many' }, { requests: NaN, bytes: Infinity }]) {
      await broker.addJob({ runId: 'run-spend', pool: alpha.pool }, { spent: none });
      assert.deepEqual(broker.spent('run-spend'), { requests: 0, bytes: 0 }, JSON.stringify(none));
      broker.removeJob('run-spend');
    }
    // A listener that has left hears no more.
    off();
    failing();
    const told = heard.length;
    const quiet = await broker.addJob({ runId: 'run-spend', pool: alpha.pool });
    assert.equal((await ask(quiet)).status, 200);
    await until(() => broker.spent('run-spend').bytes > body.length, 'the answer to be counted');
    assert.equal(heard.length, told);
    broker.removeJob('run-spend');
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
      // A job of another forge is under another CA: the one this job trusts is named.
      const newest = await later.addJob({ runId: 'newcomer', pool: { id: 'gitlab.example.org/g/r', forge: 'gitlab', host: 'gitlab.example.org', owner: 'g', repo: 'r' } });
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

  noFaults();
  console.log(`\nall ${checks} checks passed`);
} catch (e) {
  console.error(e);
  process.exitCode = 1;
} finally {
  await broker.stop().catch(() => {});
  for (const close of closers) close();
  for (const s of [echo, plain, providerTls]) s.closeAllConnections?.();
  fs.rmSync(scratch, { recursive: true, force: true });
}
process.exit();
