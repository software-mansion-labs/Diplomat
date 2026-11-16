// The proxy every container talks through. One listener per daemon, which a job
// container reaches through its relay and no other way; a job's proxy URL carries that
// job's own token, so every request names the job it belongs to and a request without a
// live token is answered 407 and nothing else.
//
// What a job's request becomes (a host is read without its case and its trailing dot):
//   CONNECT <name>.forward.dn -> the forward of that name opened for this job, if any
//   CONNECT to a forge host of its pool, or to the model provider, on 443
//                         -> TLS is terminated here with a certificate from ca.js, and
//                            the requests inside are read, each on its own:
//       fetch/clone of the pool's repository -> git upload-pack on the local mirror
//       anything else for the forge          -> onForge(job, request), the requester's answer
//       the model provider                   -> forwarded with this machine's credential,
//                                               until the job has had its share of it
//   the same hosts on any other port, over plain http, or by the forge's ssh host
//                         -> refused: those lead around the reading
//   CONNECT anywhere else -> a blind tunnel, unless the name resolves to this machine,
//                            its LAN or the docker bridge
//   GET http://...        -> forwarded, same destination rule, framed by the broker
//
// Everything a job sends is hostile. No handler lets an exception out (it would end the
// daemon for every peer), no upstream connection serves two jobs, and what one job may
// hold of this process at a time is bounded: connections, request bodies read whole,
// forge requests in flight, and the time a request may take to arrive.

import crypto from 'node:crypto';
import dns from 'node:dns';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import tls from 'node:tls';
import zlib from 'node:zlib';
import { execFile, spawn } from 'node:child_process';
import {
  BROKER_BIND, BROKER_PORT, CONTAINER_HOST, DOCKER_BIN, FORGE_ANSWER_TIMEOUT_MS, FORGE_BODY_CAP, FORGE_RESPONSE_MAX_BYTES,
  GIT_BIN, JOB_BODY_MS, JOB_BUFFER_BYTES, JOB_CONNECTIONS, JOB_FORGE_REQUESTS, JOB_HEADER_MS, JOB_IDLE_MS,
  JOB_MODEL_BYTES, JOB_MODEL_REQUESTS, LOCAL_PORTS_PATH, RELAY_HOST,
} from '../paths.js';
import { carriesPlaceholder } from './llm.js';

/// The model provider's hosts: the ones a job's requests gain this machine's credential on.
export const MODEL_HOSTS = ['api.anthropic.com'];

// Where the credential goes: inference and nothing else. The provider's other paths
// (the account's profile, its usage, its files) answer a subscriber's token too, and no
// job has a use for them.
const MODEL_PATHS = /^\/v1\/messages(\/count_tokens)?$/;

const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade']);

// What of the provider's answer a client has a use for: the body's description, the
// request's id for a bug report, and what tells it when to try again. The rest names the
// account behind this machine's credential (its organisation, how much of its allowance
// is left) or the provider's insides.
const MODEL_ANSWER_HEADERS = /^(content-type|content-encoding|content-length|cache-control|request-id|retry-after|x-should-retry)$/;

// An answer given before its request was read to the end: the rest of the request is
// read and thrown away this long and this far, so a client that is still sending reads
// the answer and not a reset connection.
const LINGER_MS = 10 * 1000;
const LINGER_BYTES = 2 * FORGE_BODY_CAP;

const FRAMING = 'the broker carries a request body by its Content-Length or as Transfer-Encoding: chunked, one of the two and nothing else';

/// A host name as every decision here reads it: lowercase, without brackets and without
/// the trailing dot of a fully qualified name.
export function normalHost(host) {
  return String(host ?? '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
}

/// The hosts a pool's forge is spoken to on: the ones whose requests go to the requester.
/// For github.com that is every host that takes a login or serves repositories over git
/// (gists are repositories). Its download hosts (codeload.github.com,
/// raw.githubusercontent.com, objects.githubusercontent.com) are not among them: what
/// they serve is public, or behind a short-lived link the requester's own answer
/// redirected to, and no credential in a container opens anything more. A GitLab host
/// serves all of it under its one name.
export function forgeHosts(pool) {
  if (pool.forge === 'github' && pool.host === 'github.com') return ['github.com', 'api.github.com', 'uploads.github.com', 'gist.github.com'];
  return [pool.host];
}

/// The hosts a pool's forge serves git over ssh on beside its own port 22: refused, since
/// they carry repositories around the requester and no container holds a key for them.
export function forgeSshHosts(pool) {
  if (pool.host === 'github.com') return ['ssh.github.com'];
  if (pool.host === 'gitlab.com') return ['altssh.gitlab.com'];
  return [];
}

// ---- addresses

function bytes4(s) {
  return Buffer.from(s.split('.').map(Number));
}

function bytes6(s) {
  let text = s;
  if (text.includes('.')) {
    const at = text.lastIndexOf(':');
    const v4 = bytes4(text.slice(at + 1));
    text = `${text.slice(0, at + 1)}${v4.readUInt16BE(0).toString(16)}:${v4.readUInt16BE(2).toString(16)}`;
  }
  const [head, tail] = text.split('::');
  const before = head ? head.split(':') : [];
  const after = tail ? tail.split(':') : [];
  const groups = tail === undefined ? before : [...before, ...Array(8 - before.length - after.length).fill('0'), ...after];
  const out = Buffer.alloc(16);
  groups.forEach((g, i) => out.writeUInt16BE(parseInt(g, 16), i * 2));
  return out;
}

// The address as bytes (4 or 16), or null when it is not one. A zone (`%en0`) is not part of it.
function addressBytes(address) {
  const bare = String(address ?? '').replace(/%.*$/, '');
  const family = net.isIP(bare);
  return family === 4 ? bytes4(bare) : family === 6 ? bytes6(bare) : null;
}

function within(address, prefix, bits) {
  if (address.length !== prefix.length) return false;
  for (let i = 0; i < address.length && bits > 0; i++, bits -= 8) {
    const mask = bits >= 8 ? 0xff : (0xff << (8 - bits)) & 0xff;
    if ((address[i] & mask) !== (prefix[i] & mask)) return false;
  }
  return true;
}

// Everything that is not the public internet: this machine, private and link-local
// space, carrier-grade NAT (where overlay networks live), multicast, reserved space, and
// the IPv6 ranges that carry an IPv4 address inside them (6to4, Teredo, IPv4-compatible
// and IPv4-translated addresses, the local NAT64 prefix).
const RANGES = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4],
  ['240.0.0.0', 4],
  ['::', 96], ['::ffff:0:0:0', 96], ['64:ff9b:1::', 48], ['100::', 64], ['2001::', 32], ['2002::', 16],
  ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
].map(([prefix, bits]) => [addressBytes(prefix), bits]);
const MAPPED = addressBytes('::ffff:0:0');
const NAT64 = addressBytes('64:ff9b::');

function prefixBits(entry, length) {
  const cidr = /\/(\d+)$/.exec(entry.cidr || '');
  if (cidr) return Number(cidr[1]);
  const mask = addressBytes(entry.netmask);
  if (!mask) return length * 8;
  let bits = 0;
  for (const byte of mask) {
    if (byte === 0xff) { bits += 8; continue; }
    bits += Math.clz32(~byte & 0xff) - 24;
    break;
  }
  return bits;
}

/// Whether the broker refuses to connect a job to `address`: this machine, anything on a
/// network one of its interfaces is on (its LAN, the docker bridge, a neighbour on its
/// public prefix), or any other address that is not the public internet. `interfaces` is
/// read anew at every call, so a network joined a moment ago counts.
export function deniedAddress(address, interfaces = os.networkInterfaces()) {
  const bytes = addressBytes(address);
  if (!bytes) return true;
  // An IPv4 address written as IPv6, mapped or behind the well-known NAT64 prefix, is
  // the IPv4 address.
  if (bytes.length === 16 && (within(bytes, MAPPED, 96) || within(bytes, NAT64, 96))) {
    return deniedAddress([...bytes.subarray(12)].join('.'), interfaces);
  }
  if (RANGES.some(([prefix, bits]) => within(bytes, prefix, bits))) return true;
  return Object.values(interfaces).some((list) => (list || []).some((entry) => {
    const own = addressBytes(entry.address);
    return !!own && within(bytes, own, prefixBits(entry, own.length));
  }));
}

/// The address the broker listens on: where a relay's `host-gateway` leads. Docker
/// Desktop carries it to the host's loopback; on Linux it is the default bridge's
/// gateway address, so that one address is bound and never every interface.
export async function brokerBindAddress({ platform = process.platform, override = BROKER_BIND, bridgeGateway = dockerBridgeGateway } = {}) {
  if (override) return override;
  if (platform !== 'linux') return '127.0.0.1';
  const gateway = await bridgeGateway();
  if (!net.isIPv4(gateway || '')) throw new Error('the docker bridge has no gateway address to listen on (is docker running? DN_BROKER_BIND names one by hand)');
  return gateway;
}

// Below this the ports with a service of their own sit close together.
const QUIET_PORTS_FROM = 10000;

function localPortRange() {
  try { return fs.readFileSync(LOCAL_PORTS_PATH, 'utf8'); } catch { return null; }
}

/// A port for a listener that has to be had again after a restart: one no outgoing
/// connection is dealt, or 0 for the system's pick. Linux deals outgoing connections
/// the ports of one range, and a port so dealt cannot be listened on while its
/// connection lasts, nor for a minute after. `range` is that range as the kernel states
/// it ("first last"), null where the system states none; the port is below its first.
export function quietPort({ range = localPortRange(), pick = crypto.randomInt } = {}) {
  const first = Number(String(range).trim().split(/\s+/)[0]);
  return first >= QUIET_PORTS_FROM + 1000 ? pick(QUIET_PORTS_FROM, first) : 0;
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

// The headers that travel on: not the hop-by-hop ones, and not the ones the sender's
// Connection header names as its own connection's affair.
function carried(pairs) {
  const own = new Set(HOP_BY_HOP);
  for (const [name, value] of pairs) {
    if (name.toLowerCase() === 'connection') for (const token of String(value).split(',')) own.add(token.trim().toLowerCase());
  }
  return pairs.filter(([name]) => !own.has(name.toLowerCase()));
}

function requestHeaders(headers, drop = []) {
  return Object.fromEntries(carried(Object.entries(headers)).filter(([name]) => !drop.includes(name)));
}

function rawPairs(res) {
  const pairs = [];
  for (let i = 0; i < res.rawHeaders.length; i += 2) pairs.push([res.rawHeaders[i], res.rawHeaders[i + 1]]);
  return pairs;
}

// An upstream's answer headers for the job: the length is stated once, as the parser
// that read the answer understood it.
function answerPairs(upRes) {
  const out = carried(rawPairs(upRes)).filter(([name]) => name.toLowerCase() !== 'content-length');
  const length = upRes.headers['content-length'];
  if (/^\d+$/.test(length ?? '')) out.push(['content-length', length]);
  return out;
}

function lowerKeys(headers) {
  const out = {};
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) return out;
  for (const [k, v] of Object.entries(headers)) out[k.toLowerCase()] = v;
  return out;
}

/// The broker. `ca` is ca.js's authority, `llm` llm.js's credential, `mirrors` answers
/// `path(pool)` with the bare mirror to serve, and `onForge(job, { host, method, path,
/// headers, body })` (body base64) resolves to `{ status, headers, body }` (body base64
/// or a Buffer). `lookup`, `connect` and `upstreamCa` replace name resolution, the
/// outgoing TCP connection and the trust roots of the model provider: tests have no
/// other way to stand in for the internet. `limits` replaces what one job may hold at a
/// time and for how long: `{ connections, bufferBytes, forgeRequests, headerMs, bodyMs,
/// idleMs, answerMs }`, by default the JOB_* tunables of paths.js and, for `answerMs`,
/// FORGE_ANSWER_TIMEOUT_MS.
export function createBroker({ log = () => {}, ca, llm, mirrors, onForge, trace = null,
  lookup = systemLookup, connect = systemConnect, upstreamCa = undefined, limits: given = {} } = {}) {
  const limits = {
    connections: JOB_CONNECTIONS, bufferBytes: JOB_BUFFER_BYTES, forgeRequests: JOB_FORGE_REQUESTS,
    headerMs: JOB_HEADER_MS, bodyMs: JOB_BODY_MS, idleMs: JOB_IDLE_MS, answerMs: FORGE_ANSWER_TIMEOUT_MS, ...given,
  };
  const jobs = new Map(); // runId -> job
  const tokens = new Map(); // token -> job
  const contexts = new WeakMap(); // a leaf as its authority hands it out -> SecureContext
  const spendHeard = new Set();
  let listening = null; // { host, port }

  const NOT_HERE = 'A job reaches the internet and nothing on its executor\'s machine or network.';
  const live = (job) => jobs.get(job.info.runId) === job;

  // An exception that leaves an event handler ends the daemon, and every peer's jobs
  // with it. Whatever a handler throws or rejects with ends the connections it was
  // working on and nothing else.
  const guard = (fn, ...held) => (...args) => {
    const drop = (e) => {
      log('broker', `a connection is dropped on a fault of the broker's own: ${e?.stack ?? e}`);
      for (const s of [...held, ...args]) {
        try { if (s && typeof s.destroy === 'function') s.destroy(); } catch {}
      }
    };
    try {
      const made = fn(...args);
      if (made && typeof made.then === 'function') made.then(null, drop);
    } catch (e) { drop(e); }
  };

  // One resolution per connection, and the connection goes to the address that passed
  // the check: a name that answers differently a moment later gets no second look.
  async function dial(host, port) {
    // The names a container knows this machine by mean nothing to the resolver out
    // here, and the job is owed the reason rather than "does not resolve".
    if (host === normalHost(CONTAINER_HOST) || /(^|\.)docker\.internal$/.test(host)) {
      throw new Refusal(403, `the broker does not connect to ${host}: that name is this machine, not a public internet address. ${NOT_HERE}`);
    }
    let found;
    try { found = await lookup(host); } catch (e) { throw new Refusal(502, `${host} does not resolve (${e.code || e.message})`); }
    const allowed = found.filter((a) => !deniedAddress(a.address));
    if (allowed.length === 0) {
      throw new Refusal(403, `the broker does not connect to ${host}: ${found.length ? `${found[0].address} is` : 'it has no address and so is'} not a public internet address. ${NOT_HERE}`);
    }
    let last;
    for (const a of allowed.slice(0, 3)) {
      try {
        const socket = await connect({ host: a.address, port });
        socket.on('error', () => {});
        return socket;
      } catch (e) { last = e; }
    }
    throw new Refusal(502, `could not connect to ${host}:${port} (${last.code || last.message})`);
  }

  // A job's own upstream connections: kept alive for its next request, never lent to
  // another job, and closed with it.
  function agentFor(job, wrap) {
    const agent = new http.Agent({ keepAlive: true, maxSockets: 16, maxFreeSockets: 4 });
    agent.createConnection = (opts, cb) => {
      dial(opts.host, opts.port).then((raw) => {
        // A job that ended meanwhile: its request is torn down as its connection
        // closes, which is later than this.
        if (!live(job)) {
          raw.destroy();
          return cb(new Error('the job has ended'));
        }
        hold(job, raw);
        wrap(raw, opts, cb);
      }).catch(cb);
    };
    return agent;
  }
  const plainWrap = (raw, opts, cb) => cb(null, raw);
  const tlsWrap = (raw, opts, cb) => {
    const secure = tls.connect({ socket: raw, servername: opts.host, ALPNProtocols: ['http/1.1'], ca: upstreamCa });
    secure.once('error', cb);
    secure.once('secureConnect', () => {
      secure.off('error', cb);
      secure.on('error', () => {});
      cb(null, secure);
    });
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
    if (job.sockets.has(socket)) return;
    job.sockets.add(socket);
    socket.once('close', () => job.sockets.delete(socket));
  }

  // A place among the job's connections for one of its container's, or false when the
  // job has as many as it gets.
  function seat(job, socket) {
    if (job.clients.has(socket)) return true;
    if (job.clients.size >= limits.connections) return false;
    job.clients.add(socket);
    socket.once('close', () => job.clients.delete(socket));
    hold(job, socket);
    return true;
  }
  const crowded = () => `this job has ${limits.connections} connections open through the broker, the most a job gets at a time: close some`;

  // Written whole, and the connection closed once the client has had a moment to read it.
  function sayAndClose(socket, text) {
    socket.end(text);
    const timer = setTimeout(() => socket.destroy(), LINGER_MS);
    timer.unref();
    socket.once('close', () => clearTimeout(timer));
  }

  function refuse(socket, e) {
    const status = e.status || 502;
    const body = `${e.message}\n`;
    sayAndClose(socket, `HTTP/1.1 ${status} ${http.STATUS_CODES[status]}\r\nContent-Type: text/plain; charset=utf-8\r\n`
      + `Content-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
  }

  // On a connection that goes on, the answer is written at once and the rest of the
  // request read beside it. An answer that is the last thing on its connection waits
  // for the rest of the request: node closes the connection as soon as such an answer
  // is written.
  function send(res, status, type, body, extra = {}) {
    if (res.headersSent) return res.destroy();
    const write = () => {
      if (res.destroyed || res.headersSent) return;
      res.writeHead(status, { 'content-type': type, 'content-length': body.length, ...extra });
      res.end(body);
    };
    const { req } = res;
    if (!req || req.complete) return write();
    const last = !res.shouldKeepAlive;
    if (!last) write();
    let seen = 0;
    const enough = () => {
      clearTimeout(timer);
      req.off('data', count);
      if (last) write();
      else if (!req.complete) req.socket?.destroy();
    };
    const count = (c) => {
      seen += c.length;
      if (seen > LINGER_BYTES) enough();
    };
    const timer = setTimeout(enough, LINGER_MS);
    timer.unref();
    req.on('data', count);
    req.once('end', enough);
    req.once('close', () => clearTimeout(timer));
  }
  const sendJson = (res, status, obj, extra) => send(res, status, 'application/json; charset=utf-8', Buffer.from(JSON.stringify(obj)), extra);
  const sendText = (res, status, text) => send(res, status, 'text/plain; charset=utf-8', Buffer.from(`${text}\n`));

  // A response is over when it closes or when its connection does: one that waits
  // behind an earlier answer on the same connection is not told that the connection
  // went. Returns the function that ends the watching.
  function over(res, fn) {
    const { socket } = res.req;
    const stop = () => {
      res.off('close', done);
      socket.off('close', done);
    };
    const done = () => {
      stop();
      fn();
    };
    if (socket.destroyed) fn();
    else {
      res.once('close', done);
      socket.once('close', done);
    }
    return stop;
  }

  // ---- how long a request may take to arrive

  // The head of a request (or the TLS handshake before it) is given headerMs from the
  // moment it is due. The inner server never listens, so node's own header and request
  // timeouts, which run off a listening server, do not apply to it.
  const HEAD = Symbol('head');
  function expectHead(socket) {
    if (socket.destroyed) return;
    if (socket[HEAD] === undefined) socket.once('close', () => clearTimeout(socket[HEAD]));
    clearTimeout(socket[HEAD]);
    socket[HEAD] = setTimeout(() => socket.destroy(), limits.headerMs);
    socket[HEAD].unref();
  }
  function gotHead(socket) {
    clearTimeout(socket[HEAD]);
    socket[HEAD] = null;
  }

  // A request has begun on its connection: no head is awaited while one is being
  // answered, and the next is due once the last of them is.
  const BUSY = Symbol('busy');
  function begun(req, res) {
    const { socket } = req;
    gotHead(socket);
    socket[BUSY] = (socket[BUSY] || 0) + 1;
    res.on('error', () => res.destroy());
    res.once('close', () => {
      socket[BUSY] -= 1;
      if (socket[BUSY] === 0) expectHead(socket);
    });
  }

  // ---- what a job may hold in this process's memory at a time

  // A request whose body is read whole (a forge request, a model request) takes its
  // place here first: the bytes it declares, or the most a request may carry when it
  // declares none, and a place among the forge requests when its answer is held whole
  // too. One that does not fit waits, unread. A lease is given back when the response
  // is over.

  // Whoever fits is let in, the earlier first. One that waits for bytes keeps back the
  // bodies behind it, and nothing else: a request with no body does not wait for one
  // that has, and one that needs no place among the forge requests does not wait for one.
  function drain(job) {
    const { gate } = job;
    let bytesKept = false;
    for (const waiter of [...gate.queue]) {
      // A connection on its way out gets nothing; its request leaves the queue as it closes.
      if (waiter.socket.destroyed) continue;
      const noPlace = waiter.slot && gate.slots >= limits.forgeRequests;
      const noBytes = waiter.need > 0 && (bytesKept || (gate.bytes > 0 && gate.bytes + waiter.need > limits.bufferBytes));
      if (!noPlace && !noBytes) waiter.admit();
      bytesKept ||= noBytes;
    }
  }

  function enter(job, req, res, { slot, streamed = false }) {
    const { gate } = job;
    const declared = req.headers['content-length'];
    if (declared !== undefined && !/^\d{1,15}$/.test(declared)) return Promise.reject(new Refusal(400, FRAMING));
    const need = streamed ? 0 : req.headers['transfer-encoding'] !== undefined ? FORGE_BODY_CAP : Number(declared ?? 0);
    if (need > FORGE_BODY_CAP) {
      return Promise.reject(new Refusal(413, `the request body is over ${FORGE_BODY_CAP / 2 ** 20} MiB, the most the network carries in one request`));
    }
    const lease = { bytes: 0, slot: false, left: false };
    lease.resize = (n) => {
      if (lease.left) return;
      gate.bytes += n - lease.bytes;
      lease.bytes = n;
      drain(job);
    };
    lease.leave = () => {
      if (lease.left) return;
      lease.left = true;
      gate.bytes -= lease.bytes;
      if (lease.slot) gate.slots -= 1;
      drain(job);
    };
    return new Promise((resolve, reject) => {
      const waiter = { need, slot, socket: req.socket };
      let unwatch = () => {};
      const settle = (fn, value) => {
        clearTimeout(timer);
        unwatch();
        const at = gate.queue.indexOf(waiter);
        if (at >= 0) gate.queue.splice(at, 1);
        fn(value);
      };
      const gone = () => { settle(reject, new Error('the client went away')); drain(job); };
      const timer = setTimeout(() => {
        settle(reject, new Refusal(503, `this job's earlier requests hold all the broker reads for one job at a time (${limits.bufferBytes / 2 ** 20} MiB of bodies, forge requests in flight: ${limits.forgeRequests}), and none ended within ${limits.bodyMs / 1000} s`));
        drain(job);
      }, limits.bodyMs);
      waiter.admit = () => {
        lease.bytes = need;
        lease.slot = slot;
        gate.bytes += need;
        if (slot) gate.slots += 1;
        settle(resolve, lease);
        over(res, lease.leave);
      };
      waiter.drop = () => settle(reject, new Error('the client went away'));
      gate.queue.push(waiter);
      unwatch = over(res, gone);
      drain(job);
    });
  }

  // The whole body: a Refusal(413) once it passes the cap, a Refusal(408) when it has
  // not all come within bodyMs.
  function collect(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      let settled = false;
      const settle = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        req.off('data', onData);
        fn(value);
      };
      const timer = setTimeout(() => settle(reject, new Refusal(408, `the request body did not arrive within ${limits.bodyMs / 1000} s`)), limits.bodyMs);
      const onData = (c) => {
        size += c.length;
        if (size > FORGE_BODY_CAP) return settle(reject, new Refusal(413, `the request body is over ${FORGE_BODY_CAP / 2 ** 20} MiB, the most the network carries in one request`));
        chunks.push(c);
      };
      req.on('data', onData);
      req.once('end', () => settle(resolve, Buffer.concat(chunks)));
      req.once('error', (e) => settle(reject, e));
      req.once('close', () => settle(reject, new Error('the client went away')));
    });
  }

  // ---- the listener a container sees

  const outer = http.createServer({ requestTimeout: 0 });
  outer.timeout = limits.idleMs;
  outer.on('connection', (socket) => expectHead(socket));
  outer.on('error', (e) => log('broker', `the listener: ${e.message}`));

  const onlyHttps = (host, port) => `the broker connects to ${host} on port 443 only, where its requests are read; ${port === 80 ? 'plain http' : `port ${port}`} would lead around that`;
  const noSsh = (job, host) => `the broker does not connect to ${host}: it serves ${job.info.pool.host} over ssh, around the requester, and no key for it is in this container. Use https://${job.info.pool.host}/`;

  outer.on('connect', guard(async (req, socket, head) => {
    gotHead(socket);
    socket.on('error', () => socket.destroy());
    socket.setTimeout(limits.idleMs, () => socket.destroy());
    const job = jobOf(req);
    if (!job) {
      if (trace) trace(`407 CONNECT ${req.url}`);
      return sayAndClose(socket, DENY_407);
    }
    if (!seat(job, socket)) return refuse(socket, new Refusal(503, crowded()));
    const m = /^(\[[0-9a-fA-F:.]+\]|[^:[\]]+):(\d{1,5})$/.exec(req.url);
    const port = m ? Number(m[2]) : 0;
    const host = m ? normalHost(m[1]) : '';
    if (!host || port < 1 || port > 65535) return refuse(socket, new Refusal(400, `not a host and port: ${req.url}`));
    if (trace) trace(`${job.info.runId} CONNECT ${host}:${port}`);
    if (job.intercept.has(host)) {
      if (port !== 443) return refuse(socket, new Refusal(403, onlyHttps(host, port)));
      return intercept(job, host, socket, head);
    }
    if (job.ssh.has(host)) return refuse(socket, new Refusal(403, noSsh(job, host)));
    const forward = /^([a-z0-9-]+)\.forward\.dn$/.exec(host);
    const target = forward && job.forwards.get(forward[1]);
    if (forward && !target) return refuse(socket, new Refusal(404, `this job has no forward named ${forward[1]}`));
    let upstream;
    try {
      // A forward leads to this machine on purpose, so it is not held to the rule for
      // everything else; which job may use it is settled by the token it came with.
      upstream = await (target ? systemConnect({ host: target.host || '127.0.0.1', port: target.port }) : dial(host, port));
    } catch (e) {
      log('broker', job.info.runId, `refused ${host}:${port}: ${e.message}`);
      return refuse(socket, e);
    }
    upstream.on('error', () => socket.destroy());
    // Removing the job closed its connection, and this one goes with it.
    if (socket.destroyed) return upstream.destroy();
    hold(job, upstream);
    socket.on('close', () => upstream.destroy());
    upstream.on('close', () => socket.destroy());
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head.length) upstream.write(head);
    socket.pipe(upstream);
    upstream.pipe(socket);
  }));

  outer.on('request', guard((req, res) => {
    begun(req, res);
    const job = jobOf(req);
    if (!job) {
      if (trace) trace(`407 ${req.method} ${req.url.split('?')[0]}`);
      res.writeHead(407, { 'proxy-authenticate': 'Basic realm="dn"', 'content-length': 0, connection: 'close' });
      return res.end();
    }
    if (!seat(job, req.socket)) return sendJson(res, 503, { message: crowded() });
    let url;
    try { url = new URL(req.url); } catch { url = null; }
    const host = url ? normalHost(url.hostname) : '';
    if (!host || url.protocol !== 'http:') {
      return sendJson(res, 400, { message: 'this is a proxy: it takes CONNECT and http:// requests' });
    }
    const port = Number(url.port) || 80;
    if (trace) trace(`${job.info.runId} ${req.method} http://${url.host}${url.pathname}`);
    if (job.intercept.has(host)) return sendText(res, 403, onlyHttps(host, port));
    if (job.ssh.has(host)) return sendText(res, 403, noSsh(job, host));

    // The request is framed again here, from what the parser read: a length or a
    // transfer coding passed on as the job wrote it is a second request the upstream
    // reads on a connection that outlives this one.
    const coding = req.headers['transfer-encoding'];
    const declared = req.headers['content-length'];
    if (coding !== undefined && (declared !== undefined || coding.trim().toLowerCase() !== 'chunked')) return sendJson(res, 400, { message: FRAMING });
    if (declared !== undefined && !/^\d{1,15}$/.test(declared)) return sendJson(res, 400, { message: FRAMING });
    const headers = { ...requestHeaders(req.headers, ['content-length', 'host']), host: url.host };
    if (coding !== undefined) headers['transfer-encoding'] = 'chunked';
    else if (declared !== undefined) headers['content-length'] = String(Number(declared));
    const bodied = coding !== undefined || Number(declared ?? 0) > 0;

    let up;
    try {
      up = http.request({ agent: job.plain, host, port, method: req.method, path: url.pathname + url.search, headers, setHost: false });
    } catch (e) {
      return sendJson(res, 400, { message: `the request cannot be carried: ${e.message}` });
    }
    let answered = false;
    up.on('response', guard((upRes) => {
      upRes.on('error', () => res.destroy());
      answered = true;
      const status = upRes.statusCode;
      if (!Number.isInteger(status) || status < 200 || status > 599) {
        up.destroy();
        return sendText(res, 502, `${url.host} answered with the status ${status}, which is no HTTP answer`);
      }
      res.writeHead(status, answerPairs(upRes).flat());
      upRes.once('close', () => { if (!upRes.complete) res.destroy(); });
      upRes.pipe(res);
    }, res, up));
    up.on('error', guard((e) => {
      if (answered) return res.headersSent && !res.writableEnded ? res.destroy() : undefined;
      answered = true;
      sendText(res, e.status || 502, e.message);
    }, res));
    // An upstream that switches protocols, or closes on a note that is no answer, ends
    // the request without an error.
    up.once('close', guard(() => {
      if (answered) return;
      answered = true;
      sendText(res, 502, `${url.host} gave no answer`);
    }, res));
    over(res, () => up.destroy());
    req.once('close', () => { if (!req.complete) up.destroy(); });
    if (bodied) req.pipe(up); else up.end();
  }));

  outer.on('clientError', (e, socket) => socket.destroy());

  // ---- the requests inside a terminated connection

  // By the leaf the job's authority has for the host now: one near its end is replaced
  // there, under a job that runs on.
  async function contextFor(job, host) {
    const leaf = await job.authority.leaf(host);
    if (!contexts.has(leaf)) contexts.set(leaf, tls.createSecureContext({ key: leaf.key, cert: leaf.cert }));
    return contexts.get(leaf);
  }

  async function intercept(job, host, socket, head) {
    let secureContext;
    try { secureContext = await contextFor(job, host); } catch (e) { return refuse(socket, new Refusal(502, e.message)); }
    if (socket.destroyed) return;
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head.length) socket.unshift(head);
    // From here the connection's idle time is the terminated one's to keep.
    socket.setTimeout(0);
    const secure = new tls.TLSSocket(socket, { isServer: true, secureContext, ALPNProtocols: ['http/1.1'] });
    secure.on('error', () => secure.destroy());
    secure.on('close', () => socket.destroy());
    socket.on('close', () => secure.destroy());
    secure.dn = { job, host };
    expectHead(secure);
    inner.emit('connection', secure);
  }

  // Each request on a terminated connection is judged on its own, however many came
  // before it: the job still admitted, the target a path, the Host the name the
  // connection was opened to. A port beside that name decides nothing: clients that
  // tunnel by hand write the wrong one.
  const inner = http.createServer(guard((req, res) => {
    begun(req, res);
    const { job, host } = req.socket.dn;
    if (!live(job)) return res.destroy();
    if (trace) trace(`${job.info.runId} ${req.method} https://${host}${req.url.split('?')[0]} [${Object.keys(req.headers).join(' ')}]`);
    if (!req.url.startsWith('/')) return sendJson(res, 400, { message: 'the request target must be a path' });
    const named = req.rawHeaders.filter((h, i) => i % 2 === 0 && h.toLowerCase() === 'host').length === 1 ? normalHost(req.headers.host.replace(/:\d+$/, '')) : null;
    if (named !== host) return sendJson(res, 421, { message: `this connection is to ${host}: a request for another host needs a connection of its own` });
    const coding = req.headers['transfer-encoding'];
    if (coding !== undefined && coding.trim().toLowerCase() !== 'chunked') return sendJson(res, 400, { message: FRAMING });
    const handler = MODEL_HOSTS.includes(host) ? model : forge;
    return handler(job, host, req, res).catch((e) => {
      if (e.message !== 'the client went away') log('broker', job.info.runId, `${req.method} ${host}: ${e.message}`);
      sendJson(res, e.status || 502, { message: e.message });
    });
  }));
  inner.timeout = limits.idleMs;
  inner.on('clientError', (e, socket) => socket.destroy());
  inner.on('upgrade', (req, socket) => socket.destroy());
  inner.on('connect', (req, socket) => socket.destroy());

  // The job's own repository, asked for the way git fetch and git clone ask: the two
  // upload-pack requests. Every other request for the forge, push included, is not this.
  function uploadPack(job, host, req) {
    const { pool } = job.info;
    const gitHost = pool.forge === 'github' && pool.host === 'github.com' ? 'github.com' : pool.host;
    if (host !== gitHost) return null;
    let url;
    try { url = new URL(req.url, `https://${host}`); } catch { return null; }
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
      const kill = { destroy: () => child.kill('SIGKILL') };
      for (const pipe of [child.stdin, child.stdout, child.stderr]) pipe.on('error', () => {});
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
      child.stdout.once('data', guard(begin, res, kill));
      child.stdout.pipe(res, { end: false });
      child.on('error', (e) => reject(new Refusal(502, `git upload-pack: ${e.message}`)));
      child.on('close', guard((code) => {
        if (code !== 0 && !started) return reject(new Refusal(502, `git upload-pack failed: ${stderr.trim().split('\n').pop() || `exit ${code}`}`));
        begin();
        res.end();
        resolve();
      }, res));
      over(res, () => child.kill('SIGKILL'));
      if (advertise) return child.stdin.end();
      const body = /^(x-)?gzip$/i.test(req.headers['content-encoding'] || '') ? req.pipe(zlib.createGunzip()) : req;
      body.on('error', () => child.kill('SIGKILL'));
      body.pipe(child.stdin);
    });
  }

  async function forge(job, host, req, res) {
    const route = uploadPack(job, host, req);
    // A fetch from the mirror holds a slot like a forge request (each is a git process
    // on this machine) and none of the bytes: its body goes to git as it comes.
    const lease = await enter(job, req, res, { slot: true, streamed: !!route });
    if (route) return serveUploadPack(job, route, req, res);
    let body = await collect(req);
    lease.resize(body.length);
    // A credential a container came by is not this network's to carry: the requester
    // acts under its own.
    const request = { host, method: req.method, path: req.url, headers: requestHeaders(req.headers, ['host', 'content-length', 'authorization', 'cookie']), body: body.toString('base64') };
    body = null;
    let timer;
    const answer = await Promise.race([
      Promise.resolve().then(() => onForge(job.info, request)),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`the requester did not answer within ${limits.answerMs / 1000} s`)), limits.answerMs); }),
    ]).finally(() => clearTimeout(timer));
    if (!answer || !Number.isInteger(answer.status) || answer.status < 200 || answer.status > 599) {
      throw new Refusal(502, 'the requester sent no usable answer');
    }
    const out = Buffer.isBuffer(answer.body) ? answer.body : Buffer.from(typeof answer.body === 'string' ? answer.body : '', 'base64');
    if (out.length > FORGE_RESPONSE_MAX_BYTES) {
      throw new Refusal(502, `the requester's answer is over ${FORGE_RESPONSE_MAX_BYTES / 2 ** 20} MiB, the most the network carries back`);
    }
    // The answer is held until the job has read it: it counts in place of the request.
    lease.resize(out.length);
    const bodiless = req.method === 'HEAD' || answer.status === 204 || answer.status === 304;
    res.writeHead(answer.status, { ...requestHeaders(lowerKeys(answer.headers), ['content-length']), ...(bodiless ? {} : { 'content-length': out.length }) });
    res.end(bodiless ? undefined : out);
  }

  function upstreamRequest(job, host, req, res, headers, body) {
    return new Promise((resolve, reject) => {
      const up = http.request({ agent: job.model, host, port: 443, method: req.method, path: req.url, headers, setHost: false });
      up.on('response', resolve);
      up.on('error', (e) => reject(new Refusal(e.status || 502, `the model provider is unreachable: ${e.message}`)));
      up.once('close', () => reject(new Refusal(502, 'the model provider gave no answer')));
      over(res, () => up.destroy());
      up.end(body);
    });
  }

  function heard(job) {
    const spent = { requests: job.spent.requests, bytes: job.spent.bytes };
    for (const fn of spendHeard) {
      try { fn(job.info.runId, spent); } catch (e) { log('broker', `a spend listener failed: ${e?.message ?? e}`); }
    }
  }

  async function model(job, host, req, res) {
    // Read whole, because a refused credential is answered by sending it again.
    const lease = await enter(job, req, res, { slot: false });
    const body = await collect(req);
    lease.resize(body.length);
    const base = { ...requestHeaders(req.headers, ['content-length', 'host']), host, 'content-length': String(body.length) };
    const inject = carriesPlaceholder(req.headers) && MODEL_PATHS.test(req.url.split('?')[0]);
    if (inject) {
      const { spent } = job;
      if (spent.requests >= JOB_MODEL_REQUESTS || spent.bytes >= JOB_MODEL_BYTES) {
        if (!spent.said) log('broker', job.info.runId, `the model is closed to this job after ${spent.requests} requests and ${spent.bytes} bytes`);
        spent.said = true;
        // The provider's shape for "slow down", marked as not worth another try.
        return sendJson(res, 429, { type: 'error', error: { type: 'rate_limit_error', message: `this job has used all of the model it gets on this executor (${JOB_MODEL_REQUESTS} requests, ${JOB_MODEL_BYTES} bytes): it made ${spent.requests} requests of ${spent.bytes} bytes. No further request will be answered; finish with what you have.` } },
          { 'x-should-retry': 'false' });
      }
      spent.requests += 1;
      spent.bytes += body.length;
      heard(job);
    }
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
      upRes = await upstreamRequest(job, host, req, res, headers, body);
      if (!(inject && upRes.statusCode === 401)) break;
      // A refused credential gets one more try when the store has a newer one.
      const renewed = await llm.refused(headers);
      if (!renewed || attempt > 0) break;
      upRes.resume();
    }
    upRes.on('error', () => res.destroy());
    lease.leave();
    if (!Number.isInteger(upRes.statusCode) || upRes.statusCode < 200 || upRes.statusCode > 599) {
      upRes.destroy();
      throw new Refusal(502, `the model provider answered with the status ${upRes.statusCode}, which is no HTTP answer`);
    }
    res.writeHead(upRes.statusCode, answerPairs(upRes).filter(([name]) => MODEL_ANSWER_HEADERS.test(name.toLowerCase())).flat());
    res.flushHeaders();
    if (inject) {
      upRes.on('data', (c) => { job.spent.bytes += c.length; });
      over(res, () => heard(job));
    }
    upRes.once('close', () => { if (!upRes.complete) res.destroy(); });
    upRes.pipe(res);
  }

  // ---- jobs and forwards

  const count = (n) => (Number.isFinite(n) && n > 0 ? n : 0);

  /// Admits a job: `{ runId, pool: { id, forge, host, owner, repo }, ... }`, handed to
  /// onForge as it is. Resolves to `{ proxyUrl, token, caCertPath, generation }`. A job
  /// that is already running, taken up by a later daemon, is admitted under the `token`
  /// it was started with, the CA `generation` it trusts, and what it had `spent` of the
  /// model by then (`{ requests, bytes }`): its share does not start again.
  async function addJob(info, { token = crypto.randomBytes(32).toString('hex'), generation = null, spent = null } = {}) {
    if (!listening) throw new Error('the broker is not listening');
    if (jobs.has(info.runId)) throw new Error(`job ${info.runId} is already admitted`);
    const hosts = [...forgeHosts(info.pool), ...MODEL_HOSTS].map(normalHost);
    if (!/^[0-9a-f]{64}$/.test(token) || tokens.has(token)) throw new Error(`job ${info.runId} cannot be admitted under that token`);
    const authority = generation === null ? await ca.authority(hosts) : ca.kept(generation);
    if (!authority) throw new Error(`job ${info.runId} cannot be admitted: the certificate authority it was started under is gone`);
    if (jobs.has(info.runId)) throw new Error(`job ${info.runId} is already admitted`);
    const job = {
      info, token, authority, intercept: new Set(hosts), ssh: new Set(forgeSshHosts(info.pool).map(normalHost)),
      sockets: new Set(), clients: new Set(), forwards: new Map(),
      spent: { requests: count(spent?.requests), bytes: count(spent?.bytes), said: false },
      gate: { bytes: 0, slots: 0, queue: [] },
    };
    job.plain = agentFor(job, plainWrap);
    job.model = agentFor(job, tlsWrap);
    jobs.set(info.runId, job);
    tokens.set(token, job);
    return { proxyUrl: `http://dn:${token}@${RELAY_HOST}:${listening.port}`, token, caCertPath: authority.certPath, generation: authority.id };
  }

  /// Ends a job's access: its token dies, its connections, its upstream connections and
  /// its forwards close, and its requests still waiting their turn are dropped.
  function removeJob(runId) {
    const job = jobs.get(runId);
    if (!job) return;
    jobs.delete(runId);
    tokens.delete(job.token);
    for (const waiter of [...job.gate.queue]) waiter.drop();
    job.plain.destroy();
    job.model.destroy();
    for (const s of job.sockets) s.destroy();
  }

  /// Gives a job a way to `target` (`{ host, port }` on this machine, the adb server for
  /// one) for as long as the job lives: a CONNECT to `<name>.forward.dn` under that
  /// job's token leads there, and under any other token leads nowhere. Returns `{ name }`.
  function addForward(runId, { name, target }) {
    const job = jobs.get(runId);
    if (!job) throw new Error(`job ${runId} is not admitted`);
    if (!/^[a-z0-9-]{1,32}$/.test(name)) throw new Error(`not a forward's name: ${name}`);
    job.forwards.set(name, target);
    return { name };
  }

  /// What a job has had of the model on this machine's credential, `{ requests, bytes }`,
  /// or null for a job that is not admitted: what `addJob` takes back as `spent`.
  function spent(runId) {
    const job = jobs.get(runId);
    return job ? { requests: job.spent.requests, bytes: job.spent.bytes } : null;
  }

  /// Calls `fn(runId, { requests, bytes })` when a job's spend has grown: as a request is
  /// counted, and again when its answer has been passed on. Returns the function that
  /// ends the listening.
  function onSpend(fn) {
    spendHeard.add(fn);
    return () => spendHeard.delete(fn);
  }

  /// What a job holds of the broker now: `{ connections, bytes, requests, waiting }` -
  /// its container's connections, the bodies read whole, the forge requests in flight,
  /// and the requests waiting their turn. Null for a job that is not admitted.
  function load(runId) {
    const job = jobs.get(runId);
    return job ? { connections: job.clients.size, bytes: job.gate.bytes, requests: job.gate.slots, waiting: job.gate.queue.length } : null;
  }

  /// Starts listening, on `port` when given: the port the jobs of an earlier daemon were
  /// told. Otherwise on the port the operator named, or one the next daemon can have
  /// again. Resolves to `{ host, port }`.
  async function start({ port = BROKER_PORT || quietPort() } = {}) {
    const host = await brokerBindAddress();
    await new Promise((resolve, reject) => {
      const failed = (err) => { outer.off('listening', up); reject(err); };
      const up = () => { outer.off('error', failed); resolve(); };
      outer.once('error', failed);
      outer.once('listening', up);
      outer.listen(port, host);
    });
    listening = { host, port: outer.address().port };
    log('broker', `listening on ${host}:${listening.port}`);
    return listening;
  }

  /// Ends every job and stops listening.
  async function stop() {
    for (const runId of [...jobs.keys()]) removeJob(runId);
    if (!listening) return;
    listening = null;
    outer.closeAllConnections();
    await new Promise((resolve) => outer.close(resolve));
  }

  return { start, stop, address: () => listening, addJob, removeJob, addForward, spent, onSpend, load };
}
