// The proxy every container talks through. One listener per daemon; a job's proxy URL
// carries that job's own token, so every request names the job it belongs to and a
// request without a live token is answered 407 and nothing else.
//
// What a job's request becomes:
//   CONNECT to a forge host of its pool, or to the model provider, on 443
//                         -> TLS is terminated here with a certificate from ca.js, and
//                            the requests inside are read:
//       fetch/clone of the pool's repository -> git upload-pack on the local mirror
//       anything else for the forge          -> onForge(job, request), the requester's answer
//       the model provider                   -> forwarded with this machine's credential
//   CONNECT anywhere else -> a blind tunnel, unless the name resolves to this machine,
//                            its LAN or the docker bridge
//   GET http://...        -> forwarded, same destination rule

import crypto from 'node:crypto';
import dns from 'node:dns';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import tls from 'node:tls';
import zlib from 'node:zlib';
import { execFile, spawn } from 'node:child_process';
import { BROKER_BIND, BROKER_PORT, CONTAINER_HOST, DOCKER_BIN, FORGE_BODY_CAP, FORGE_TIMEOUT_MS, GIT_BIN } from '../paths.js';
import { carriesPlaceholder } from './llm.js';

/// The model provider's hosts: the ones a job's requests gain this machine's credential on.
export const MODEL_HOSTS = ['api.anthropic.com'];

// Where the credential goes: inference and nothing else. The provider's other paths
// (the account's profile, its usage, its files) answer a subscriber's token too, and no
// job has a use for them.
const MODEL_PATHS = /^\/v1\/messages(\/count_tokens)?$/;

const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade']);

/// The hosts a pool's forge is spoken to on: the ones whose requests go to the requester.
export function forgeHosts(pool) {
  if (pool.forge === 'github' && pool.host === 'github.com') return ['github.com', 'api.github.com', 'uploads.github.com'];
  return [pool.host];
}

// Loopback, link-local, private, carrier-grade NAT (where overlay networks live),
// multicast and reserved space, and the IPv6 forms that smuggle an IPv4 address.
const RANGES = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4],
  ['240.0.0.0', 4], ['::', 127, 'ipv6'], ['64:ff9b::', 96, 'ipv6'], ['2002::', 16, 'ipv6'],
  ['fc00::', 7, 'ipv6'], ['fe80::', 10, 'ipv6'], ['ff00::', 8, 'ipv6'],
];
const DENIED = new net.BlockList();
for (const [prefix, bits, family = 'ipv4'] of RANGES) DENIED.addSubnet(prefix, bits, family);

/// Whether the broker refuses to connect a job to `address`: this machine, its LAN, the
/// docker bridge, or any other address that is not the public internet.
export function deniedAddress(address, interfaces = os.networkInterfaces()) {
  const family = net.isIP(address);
  if (!family) return true;
  const bare = address.replace(/%.*$/, '');
  if (DENIED.check(bare, family === 6 ? 'ipv6' : 'ipv4')) return true;
  // A machine with a public address of its own is still this machine.
  return Object.values(interfaces).some((list) => (list || []).some((i) => i.address === bare));
}

/// The address the broker listens on: where a container's `host.docker.internal` leads.
/// Docker Desktop carries it to the host's loopback; on Linux `host-gateway` is the
/// bridge's gateway address, so that one address is bound and never every interface.
export async function brokerBindAddress({ platform = process.platform, override = BROKER_BIND, bridgeGateway = dockerBridgeGateway } = {}) {
  if (override) return override;
  if (platform !== 'linux') return '127.0.0.1';
  const gateway = await bridgeGateway();
  if (!net.isIPv4(gateway || '')) throw new Error('the docker bridge has no gateway address to listen on (is docker running? DN_BROKER_BIND names one by hand)');
  return gateway;
}

function dockerBridgeGateway() {
  return new Promise((resolve) => {
    execFile(DOCKER_BIN, ['network', 'inspect', 'bridge', '--format', '{{range .IPAM.Config}}{{.Gateway}} {{end}}'],
      { timeout: 10000, encoding: 'utf8' }, (err, stdout) => {
        resolve(err ? null : stdout.split(/\s+/).find((a) => net.isIPv4(a)) || null);
      });
  });
}

async function systemLookup(host) {
  return dns.promises.lookup(host, { all: true, order: 'ipv4first' });
}

function systemConnect({ host, port }) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    socket.setTimeout(15000, () => socket.destroy(new Error('connect timed out')));
    socket.once('error', reject);
    socket.once('connect', () => {
      socket.setTimeout(0);
      socket.off('error', reject);
      resolve(socket);
    });
  });
}

class Refusal extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const pkt = (s) => (s.length + 4).toString(16).padStart(4, '0') + s;

function plainHeaders(headers, drop = []) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    if (!HOP_BY_HOP.has(k) && !drop.includes(k)) out[k] = v;
  }
  return out;
}

function rawHeaders(res) {
  const out = [];
  for (let i = 0; i < res.rawHeaders.length; i += 2) {
    if (!HOP_BY_HOP.has(res.rawHeaders[i].toLowerCase())) out.push(res.rawHeaders[i], res.rawHeaders[i + 1]);
  }
  return out;
}

function sendJson(res, status, obj) {
  if (res.headersSent) return res.destroy();
  const body = Buffer.from(JSON.stringify(obj));
  // A refusal sent while the body is still arriving ends the connection with it.
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.length, ...(status === 413 ? { connection: 'close' } : {}) });
  res.end(body);
}

// The whole body, or a Refusal(413) once it passes the cap; the rest is left unread.
function collect(req, cap) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > cap) {
        req.pause();
        req.removeAllListeners('data');
        return reject(new Refusal(413, `the request body is over ${cap / 2 ** 20} MiB, the most the network carries in one request`));
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
    req.on('close', () => reject(new Error('the client went away')));
  });
}

/// The broker. `ca` is ca.js's authority, `llm` llm.js's credential, `mirrors` answers
/// `path(pool)` with the bare mirror to serve, and `onForge(job, { host, method, path,
/// headers, body })` (body base64) resolves to `{ status, headers, body }` (body base64
/// or a Buffer). `lookup`, `connect` and `upstreamCa` replace name resolution, the
/// outgoing TCP connection and the trust roots of the model provider: tests have no
/// other way to stand in for the internet.
export function createBroker({ log = () => {}, ca, llm, mirrors, onForge, trace = null,
  lookup = systemLookup, connect = systemConnect, upstreamCa = undefined } = {}) {
  const jobs = new Map(); // runId -> job
  const tokens = new Map(); // token -> job
  const contexts = new Map(); // "<authority id>/<host>" -> Promise<SecureContext>
  let listening = null; // { host, port }

  // One resolution per connection, and the connection goes to the address that passed
  // the check: a name that answers differently a moment later gets no second look.
  async function dial(host, port) {
    let found;
    try { found = await lookup(host); } catch (e) { throw new Refusal(502, `${host} does not resolve (${e.code || e.message})`); }
    const allowed = found.filter((a) => !deniedAddress(a.address));
    if (allowed.length === 0) {
      throw new Refusal(403, `the broker does not connect to ${host}: ${found.length ? `${found[0].address} is` : 'it has no address and so is'} not a public internet address. `
        + 'A job reaches the internet and nothing on its executor\'s machine or network.');
    }
    let last;
    for (const a of allowed.slice(0, 3)) {
      try { return await connect({ host: a.address, port }); } catch (e) { last = e; }
    }
    throw new Refusal(502, `could not connect to ${host}:${port} (${last.code || last.message})`);
  }

  const plainAgent = new http.Agent({ keepAlive: true });
  plainAgent.createConnection = (opts, cb) => { dial(opts.host, opts.port).then((s) => cb(null, s), cb); };
  const modelAgent = new http.Agent({ keepAlive: true });
  modelAgent.createConnection = (opts, cb) => {
    dial(opts.host, opts.port).then((raw) => {
      const secure = tls.connect({ socket: raw, servername: opts.host, ALPNProtocols: ['http/1.1'], ca: upstreamCa });
      secure.once('error', cb);
      secure.once('secureConnect', () => { secure.off('error', cb); cb(null, secure); });
    }, cb);
  };

  function jobOf(req) {
    const m = /^Basic\s+(\S+)$/i.exec(req.headers['proxy-authorization'] || '');
    if (!m) return null;
    const [user, token] = Buffer.from(m[1], 'base64').toString('utf8').split(/:(.*)/s);
    return user === 'dn' ? tokens.get(token) || null : null;
  }

  const DENY_407 = 'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="dn"\r\n'
    + 'Content-Length: 0\r\nConnection: close\r\n\r\n';

  function hold(job, socket) {
    job.sockets.add(socket);
    socket.once('close', () => job.sockets.delete(socket));
  }

  function refuse(socket, e) {
    const status = e.status || 502;
    const body = `${e.message}\n`;
    socket.end(`HTTP/1.1 ${status} ${http.STATUS_CODES[status]}\r\nContent-Type: text/plain; charset=utf-8\r\n`
      + `Content-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
  }

  // ---- the listener a container sees

  const outer = http.createServer();

  outer.on('connect', (req, socket, head) => {
    socket.on('error', () => socket.destroy());
    const job = jobOf(req);
    if (!job) {
      if (trace) trace(`407 CONNECT ${req.url}`);
      return socket.end(DENY_407);
    }
    hold(job, socket);
    const m = /^(\[[0-9a-fA-F:.]+\]|[^:[\]]+):(\d{1,5})$/.exec(req.url);
    if (!m) return refuse(socket, new Refusal(400, `not a host and port: ${req.url}`));
    const host = m[1].replace(/^\[|\]$/g, '').toLowerCase();
    const port = Number(m[2]);
    if (trace) trace(`${job.info.runId} CONNECT ${host}:${port}`);
    if (port === 443 && job.intercept.has(host)) return intercept(job, host, socket, head);
    dial(host, port).then((upstream) => {
      if (socket.destroyed) return upstream.destroy();
      hold(job, upstream);
      upstream.on('error', () => socket.destroy());
      socket.on('close', () => upstream.destroy());
      upstream.on('close', () => socket.destroy());
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      socket.pipe(upstream);
      upstream.pipe(socket);
    }, (e) => {
      log('broker', job.info.runId, `refused ${host}:${port}: ${e.message}`);
      refuse(socket, e);
    });
  });

  outer.on('request', (req, res) => {
    const job = jobOf(req);
    if (!job) {
      if (trace) trace(`407 ${req.method} ${req.url.split('?')[0]}`);
      res.writeHead(407, { 'proxy-authenticate': 'Basic realm="dn"', 'content-length': 0, connection: 'close' });
      return res.end();
    }
    hold(job, req.socket);
    let url;
    try { url = new URL(req.url); } catch { url = null; }
    if (!url || url.protocol !== 'http:') {
      return sendJson(res, 400, { message: 'this is a proxy: it takes CONNECT and http:// requests' });
    }
    if (trace) trace(`${job.info.runId} ${req.method} http://${url.host}${url.pathname}`);
    const up = http.request({
      agent: plainAgent, host: url.hostname.replace(/^\[|\]$/g, ''), port: Number(url.port) || 80, method: req.method,
      path: url.pathname + url.search, headers: plainHeaders(req.headers), setHost: false,
    });
    up.on('response', (upRes) => {
      res.writeHead(upRes.statusCode, rawHeaders(upRes));
      upRes.pipe(res);
    });
    up.on('error', (e) => {
      if (res.headersSent) return res.destroy();
      const body = `${e.message}\n`;
      res.writeHead(e.status || 502, { 'content-type': 'text/plain; charset=utf-8', 'content-length': Buffer.byteLength(body) });
      res.end(body);
    });
    res.on('close', () => up.destroy());
    req.pipe(up);
  });

  outer.on('clientError', (e, socket) => socket.destroy());

  // ---- the requests inside a terminated connection

  function contextFor(job, host) {
    const key = `${job.authority.id}/${host}`;
    if (!contexts.has(key)) {
      const made = job.authority.leaf(host).then(({ key: k, cert }) => tls.createSecureContext({ key: k, cert }));
      made.catch(() => contexts.delete(key));
      contexts.set(key, made);
    }
    return contexts.get(key);
  }

  function intercept(job, host, socket, head) {
    contextFor(job, host).then((secureContext) => {
      if (socket.destroyed) return;
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) socket.unshift(head);
      const secure = new tls.TLSSocket(socket, { isServer: true, secureContext, ALPNProtocols: ['http/1.1'] });
      secure.on('error', () => secure.destroy());
      secure.dn = { job, host };
      inner.emit('connection', secure);
    }, (e) => refuse(socket, new Refusal(502, e.message)));
  }

  const inner = http.createServer((req, res) => {
    const { job, host } = req.socket.dn;
    if (trace) trace(`${job.info.runId} ${req.method} https://${host}${req.url.split('?')[0]} [${Object.keys(req.headers).join(' ')}]`);
    if (!req.url.startsWith('/')) return sendJson(res, 400, { message: 'the request target must be a path' });
    const handler = MODEL_HOSTS.includes(host) ? model : forge;
    handler(job, host, req, res).catch((e) => {
      if (e.message !== 'the client went away') log('broker', job.info.runId, `${req.method} ${host}: ${e.message}`);
      sendJson(res, e.status || 502, { message: e.message });
    });
  });
  inner.on('clientError', (e, socket) => socket.destroy());
  inner.on('upgrade', (req, socket) => socket.destroy());

  // The job's own repository, asked for the way git fetch and git clone ask: the two
  // upload-pack requests. Every other request for the forge, push included, is not this.
  function uploadPack(job, host, req) {
    const { pool } = job.info;
    const gitHost = pool.forge === 'github' && pool.host === 'github.com' ? 'github.com' : pool.host;
    if (host !== gitHost) return null;
    const url = new URL(req.url, `https://${host}`);
    const m = /^\/(.+?)(?:\.git)?\/(info\/refs|git-upload-pack)$/.exec(url.pathname);
    if (!m) return null;
    const mine = `${pool.owner}/${pool.repo}`;
    const same = pool.forge === 'github' ? m[1].toLowerCase() === mine.toLowerCase() : m[1] === mine;
    if (!same) return null;
    if (m[2] === 'info/refs') {
      return req.method === 'GET' && url.searchParams.get('service') === 'git-upload-pack' ? { advertise: true } : null;
    }
    return req.method === 'POST' ? { advertise: false } : null;
  }

  function serveUploadPack(job, { advertise }, req, res) {
    return new Promise((resolve, reject) => {
      const mirror = mirrors.path(job.info.pool);
      if (!mirror) return reject(new Refusal(502, 'this executor holds no mirror of the repository'));
      const protocol = /^[A-Za-z0-9=:._-]{1,128}$/.test(req.headers['git-protocol'] || '') ? req.headers['git-protocol'] : '';
      // The operator's own git configuration has no say in what a container is served.
      const env = { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', ...(protocol ? { GIT_PROTOCOL: protocol } : {}) };
      const child = spawn(GIT_BIN, ['-c', 'uploadpack.allowFilter=true', 'upload-pack', '--stateless-rpc',
        ...(advertise ? ['--advertise-refs'] : []), mirror], { env, stdio: ['pipe', 'pipe', 'pipe'] });
      let stderr = '';
      let started = false;
      const begin = () => {
        if (started) return;
        started = true;
        res.writeHead(200, {
          'content-type': `application/x-git-upload-pack-${advertise ? 'advertisement' : 'result'}`,
          'cache-control': 'no-cache',
        });
        // Protocol v2 opens with the capability advertisement itself.
        if (advertise && !/(^|:)version=2(:|$)/.test(protocol)) res.write(`${pkt('# service=git-upload-pack\n')}0000`);
      };
      child.stderr.on('data', (c) => { stderr = (stderr + c).slice(-2000); });
      child.stdout.once('data', begin);
      child.stdout.pipe(res, { end: false });
      child.stdin.on('error', () => {});
      child.on('error', (e) => reject(new Refusal(502, `git upload-pack: ${e.message}`)));
      child.on('close', (code) => {
        if (code !== 0 && !started) return reject(new Refusal(502, `git upload-pack failed: ${stderr.trim().split('\n').pop() || `exit ${code}`}`));
        begin();
        res.end();
        resolve();
      });
      res.on('close', () => child.kill('SIGKILL'));
      if (advertise) return child.stdin.end();
      const body = /^(x-)?gzip$/i.test(req.headers['content-encoding'] || '') ? req.pipe(zlib.createGunzip()) : req;
      body.on('error', () => child.kill('SIGKILL'));
      body.pipe(child.stdin);
    });
  }

  async function forge(job, host, req, res) {
    const route = uploadPack(job, host, req);
    if (route) return serveUploadPack(job, route, req, res);
    const body = await collect(req, FORGE_BODY_CAP);
    // A credential a container came by is not this network's to carry: the requester
    // acts under its own.
    const request = { host, method: req.method, path: req.url, headers: plainHeaders(req.headers, ['host', 'content-length', 'authorization', 'cookie']), body: body.toString('base64') };
    let timer;
    const answer = await Promise.race([
      Promise.resolve().then(() => onForge(job.info, request)),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`the requester did not answer within ${FORGE_TIMEOUT_MS / 1000} s`)), FORGE_TIMEOUT_MS); }),
    ]).finally(() => clearTimeout(timer));
    if (!answer || !Number.isInteger(answer.status) || answer.status < 200 || answer.status > 599) {
      throw new Refusal(502, 'the requester sent no usable answer');
    }
    const out = Buffer.isBuffer(answer.body) ? answer.body : Buffer.from(answer.body || '', 'base64');
    const bodiless = req.method === 'HEAD' || answer.status === 204 || answer.status === 304;
    res.writeHead(answer.status, { ...plainHeaders(lowerKeys(answer.headers), ['content-length']), ...(bodiless ? {} : { 'content-length': out.length }) });
    res.end(bodiless ? undefined : out);
  }

  function upstreamRequest(host, req, res, headers, body) {
    return new Promise((resolve, reject) => {
      const up = http.request({ agent: modelAgent, host, port: 443, method: req.method, path: req.url, headers, setHost: false });
      up.on('response', resolve);
      up.on('error', (e) => reject(new Refusal(e.status || 502, `the model provider is unreachable: ${e.message}`)));
      res.on('close', () => up.destroy());
      up.end(body);
    });
  }

  async function model(job, host, req, res) {
    const body = await collect(req, FORGE_BODY_CAP);
    const base = { ...plainHeaders(req.headers, ['content-length']), host, 'content-length': String(body.length) };
    const inject = carriesPlaceholder(req.headers) && MODEL_PATHS.test(req.url.split('?')[0]);
    let upRes;
    for (let attempt = 0; ; attempt++) {
      let headers = base;
      if (inject) {
        try { headers = await llm.authorize(base); } catch (e) {
          // The provider's own error shape and status: the client reports it and stops
          // instead of retrying a credential that is not there.
          return sendJson(res, 401, { type: 'error', error: { type: 'authentication_error', message: `this executor has no model credential: ${e.message}` } });
        }
      }
      upRes = await upstreamRequest(host, req, res, headers, body);
      if (!(inject && upRes.statusCode === 401)) break;
      // A refused credential gets one more try when the store has a newer one.
      const renewed = await llm.refused(headers);
      if (!renewed || attempt > 0) break;
      upRes.resume();
    }
    res.writeHead(upRes.statusCode, rawHeaders(upRes));
    res.flushHeaders();
    upRes.pipe(res);
    upRes.on('error', () => res.destroy());
  }

  // ---- jobs and forwards

  /// Admits a job: `{ runId, pool: { id, forge, host, owner, repo }, ... }`, handed to
  /// onForge as it is. Resolves to `{ proxyUrl, token, caCertPath }`.
  async function addJob(info) {
    if (!listening) throw new Error('the broker is not listening');
    if (jobs.has(info.runId)) throw new Error(`job ${info.runId} is already admitted`);
    const hosts = [...forgeHosts(info.pool), ...MODEL_HOSTS];
    const authority = await ca.authority(hosts);
    const token = crypto.randomBytes(32).toString('hex');
    const job = { info, token, authority, intercept: new Set(hosts), sockets: new Set(), forwards: new Set() };
    jobs.set(info.runId, job);
    tokens.set(token, job);
    return { proxyUrl: `http://dn:${token}@${CONTAINER_HOST}:${listening.port}`, token, caCertPath: authority.certPath };
  }

  /// Ends a job's access: its token dies, its connections and its forwards close.
  function removeJob(runId) {
    const job = jobs.get(runId);
    if (!job) return;
    jobs.delete(runId);
    tokens.delete(job.token);
    for (const f of job.forwards) f.close();
    for (const s of job.sockets) s.destroy();
  }

  /// Opens a TCP listener that leads to `target` (`{ host, port }` on this machine, the
  /// adb server for one) for as long as the job lives. Resolves to `{ name, host, port }`
  /// as the container dials it. The listener cannot tell one container from another:
  /// whatever reaches the broker's address reaches the target while the job runs.
  function addForward(runId, { name, target }) {
    const job = jobs.get(runId);
    if (!job) return Promise.reject(new Error(`job ${runId} is not admitted`));
    return new Promise((resolve, reject) => {
      const conns = new Set();
      const server = net.createServer((conn) => {
        const up = net.connect({ host: target.host || '127.0.0.1', port: target.port });
        for (const s of [conn, up]) {
          conns.add(s);
          s.on('error', () => {});
          s.on('close', () => { conns.delete(s); conn.destroy(); up.destroy(); });
        }
        conn.pipe(up);
        up.pipe(conn);
      });
      const forward = { close() { server.close(); for (const s of conns) s.destroy(); job.forwards.delete(forward); } };
      server.once('error', reject);
      server.listen(0, listening.host, () => {
        if (!jobs.has(runId)) { forward.close(); return reject(new Error(`job ${runId} ended`)); }
        job.forwards.add(forward);
        resolve({ name, host: CONTAINER_HOST, port: server.address().port });
      });
    });
  }

  /// Starts listening; resolves to `{ host, port }`.
  async function start() {
    const host = await brokerBindAddress();
    await new Promise((resolve, reject) => {
      outer.once('error', reject);
      outer.listen(BROKER_PORT, host, resolve);
    });
    listening = { host, port: outer.address().port };
    log('broker', `listening on ${host}:${listening.port}`);
    return listening;
  }

  /// Ends every job and stops listening.
  async function stop() {
    for (const runId of [...jobs.keys()]) removeJob(runId);
    plainAgent.destroy();
    modelAgent.destroy();
    if (!listening) return;
    listening = null;
    outer.closeAllConnections();
    await new Promise((resolve) => outer.close(resolve));
  }

  return { start, stop, address: () => listening, addJob, removeJob, addForward };
}

function lowerKeys(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) out[k.toLowerCase()] = v;
  return out;
}
