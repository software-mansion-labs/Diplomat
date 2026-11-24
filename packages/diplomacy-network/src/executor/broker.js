// The proxy every container talks through. One listener per daemon, which a job
// container reaches through its relay and no other way; a job's proxy URL carries that
// job's own token, so every request names the job it belongs to. The relay carries each
// connection in frames, which bound what all jobs hold of this machine's socket buffers
// on the way (hop.js). A connection is the job's whose token its first request carries.
// The broker reads that first head itself, off the socket: a connection that names no
// admitted job is answered 407 once and read no further, and a CONNECT never reaches
// node's http parser. The other requests of a job's connection reach the parser through
// a feed (feed.js), one head at a time.
//
// What a job's request becomes (a host is read without its case and its trailing dot;
// a CONNECT is the first request of its connection):
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
//   CONNECT anywhere else -> a blind tunnel, unless the name is one of a machine's own
//                            network (asked of nobody), or DNS resolves it to this
//                            machine, its LAN or the docker bridge
//   GET http://...        -> forwarded, same destination rule, framed by the broker
//
// Everything a job sends is hostile. No handler lets an exception out (it would end the
// daemon for every peer), no upstream connection serves two jobs, and what one job may
// hold of this process at a time is bounded: connections, requests, connections out,
// names being resolved, request bodies read whole, forge requests in flight, and the
// time a request may take to arrive. So is what is no job's: the connections whose
// first head has not come, or was refused.

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
import { createFeeder, edgeAfter, headEnd } from './feed.js';
import { createHop, PREFACE } from './hop.js';
import { carriesPlaceholder } from './llm.js';
import { own } from './own-fault.js';
import { createOutbound } from './outbound.js';
import { clip, createSparingLog } from './sparing.js';

/// The model provider's hosts: the ones a job's requests gain this machine's credential on.
export const MODEL_HOSTS = ['api.anthropic.com'];

/// The most requests one job has in the broker at a time, those being answered and
/// those waiting their turn together, on however many connections it sends them.
export const JOB_REQUESTS = 256;

/// The most requests of one job the broker carries upstream itself at a time, each
/// down a connection out: its plain http requests and its requests to the model
/// provider together. A tunnel has a connection out of its own.
export const JOB_UPSTREAMS = 32;

/// The most names one job has asked of DNS at a time; a connection that needs another
/// waits for one of them.
export const JOB_LOOKUPS = 8;

/// How long a name may take to resolve.
export const LOOKUP_MS = 5000;

/// The most connections the broker keeps that are no job's: those whose first request
/// has not come, and those refused and given a moment to read why.
export const STRANGERS = 1024;

// The longest request head a connection's first may be: what node's own parser takes.
const HEAD_BYTES = http.maxHeaderSize;

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

// What of a refused connection is read and dropped after its answer; past it the
// connection is reset. Bytes left unread wait in this machine's network memory.
const REFUSED_BYTES = 64 * 1024;

// The pieces a streamed body is written on in.
const CARRY_BYTES = 16 * 1024;

const FRAMING = 'the broker carries a request body by its Content-Length or as Transfer-Encoding: chunked, one of the two and nothing else';

/// A host as every decision here reads it: an address, without brackets, or a name in
/// lowercase without the one trailing dot of a fully qualified name. '' for anything
/// else: a name is labels of letters, digits, hyphens and underscores, none empty and
/// none over 63 characters, 253 characters in all.
export function normalHost(host) {
  const text = String(host ?? '').toLowerCase();
  const bare = text.replace(/^\[(.*)\]$/, '$1');
  if (net.isIP(bare)) return bare;
  const name = text.replace(/\.$/, '');
  return name.length <= 253 && /^[a-z0-9_-]{1,63}(\.[a-z0-9_-]{1,63})*$/.test(name) ? name : '';
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
/// read anew at every call, so a network joined a moment ago counts. A publicly
/// addressed range this machine reaches by a route alone (behind a VPN, on another
/// subnet of its site) is on no interface, and is not refused.
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

// The names no public name server answers for: a single label, and the names set aside
// for a machine's own use or its network's. Whether one resolves is the word of this
// machine's local name services (its hosts file, mDNS, its search domains), which take
// seconds to say no and say what is on the network around it.
const LOCAL_NAMES = /(^|\.)(localhost|local|internal|intranet|private|corp|home|lan|home\.arpa)$/;

/// Whether the broker refuses `host`, a name as normalHost gives it, without asking any
/// resolver: it cannot be a name of the public internet.
export function localName(host) {
  return !host.includes('.') || LOCAL_NAMES.test(host);
}

/// A lookup that asks DNS and nothing else of this machine: not its hosts file, not
/// mDNS, and not getaddrinfo, whose calls wait their turn for the few threads the
/// daemon reads its own files on, so that one slow name holds up the next. `lookup(host)`
/// resolves to `[{ address, family }]`, IPv4 first. `servers` replaces the name servers
/// of the system.
export function dnsLookup({ servers = null } = {}) {
  const resolver = new dns.promises.Resolver({ timeout: LOOKUP_MS / 2, tries: 2 });
  if (servers) resolver.setServers(servers);
  return async (host) => {
    const [v4, v6] = await Promise.allSettled([resolver.resolve4(host), resolver.resolve6(host)]);
    const found = [...(v4.value ?? []).map((address) => ({ address, family: 4 })), ...(v6.value ?? []).map((address) => ({ address, family: 6 }))];
    if (found.length === 0) throw v4.reason;
    return found;
  };
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
/// other way to stand in for the internet. `outbound` is handed to createOutbound
/// (outbound.js), the count of the kernel memory of the connections out. `limits` replaces
/// what one job may hold at a time and for how long, and how many connections may be no
/// job's: `{ connections, requests, upstreams, lookups, bufferBytes, forgeRequests,
/// strangers, headerMs, bodyMs, idleMs, answerMs, lookupMs }`, by default JOB_REQUESTS,
/// JOB_UPSTREAMS, JOB_LOOKUPS, STRANGERS and LOOKUP_MS, the JOB_* tunables of paths.js
/// and, for `answerMs`, FORGE_ANSWER_TIMEOUT_MS.
export function createBroker({ log = () => {}, ca, llm, mirrors, onForge, trace = null,
  lookup = dnsLookup(), connect = systemConnect, upstreamCa = undefined, outbound: outGiven = {}, limits: given = {} } = {}) {
  const limits = {
    connections: JOB_CONNECTIONS, requests: JOB_REQUESTS, upstreams: JOB_UPSTREAMS, lookups: JOB_LOOKUPS, bufferBytes: JOB_BUFFER_BYTES,
    forgeRequests: JOB_FORGE_REQUESTS, strangers: STRANGERS,
    headerMs: JOB_HEADER_MS, bodyMs: JOB_BODY_MS, idleMs: JOB_IDLE_MS, answerMs: FORGE_ANSWER_TIMEOUT_MS, lookupMs: LOOKUP_MS, ...given,
  };
  // What a job brings about as often as it likes is written once a minute for each kind.
  const sparing = createSparingLog(log);
  const outbound = createOutbound({ ...outGiven,
    say: (job, text, why) => (job ? sparing(`job ${job.info.runId} reset ${why}`, 'broker', job.info.runId, text) : log('broker', text)) });
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
      const fault = String(e?.stack ?? e);
      // Told of by where it was thrown, which is what follows its message in the stack:
      // one that repeats keeps no other out of the log, and a message has no say in it.
      const message = String(e?.message ?? e);
      const thrown = fault.slice(fault.indexOf(message) + message.length).split('\n')[1];
      sparing(`fault ${thrown}`, 'broker', `a connection is dropped on a fault of the broker's own: ${fault.slice(0, 4000)}`);
      for (const s of [...held, ...args]) {
        try { if (s && typeof s.destroy === 'function') s.destroy(); } catch {}
      }
    };
    try {
      const made = fn(...args);
      if (made && typeof made.then === 'function') made.then(null, drop);
    } catch (e) { drop(e); }
  };

  // What a name resolves to, asked for a job: no more of its names are asked at a time
  // than its share, the rest wait in the order they came, and an answer is waited for no
  // longer than lookupMs. A job's lookups wait for nothing of another job's. The line
  // is no longer than the job may have connections: a request whose sender went leaves
  // its name in it until its turn.
  async function resolve(job, host) {
    if (job.looking < limits.lookups) job.looking += 1;
    else if (job.lookTurns.length >= limits.connections) throw new Error(`${job.lookTurns.length} names of this job wait to be resolved already`);
    else await new Promise((turn) => job.lookTurns.push(turn));
    let timer;
    try {
      // A place that came round after the job ended is asked nothing for.
      if (!live(job)) throw new Error('the job has ended');
      return await Promise.race([
        lookup(host),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`no answer within ${limits.lookupMs / 1000} s`)), limits.lookupMs); }),
      ]);
    } finally {
      clearTimeout(timer);
      // The place goes to whoever waited longest, or is given back.
      const next = job.lookTurns.shift();
      if (next) next();
      else job.looking -= 1;
    }
  }

  // One resolution per connection, and the connection goes to the address that passed
  // the check: a name that answers differently a moment later gets no second look.
  async function dial(job, host, port) {
    if (outbound.full(job)) throw new Refusal(503, `this job has ${outbound.fallback} connections out open, the most a job gets while this machine cannot tell what they hold: close some`);
    // The names a container knows this machine by mean nothing to the resolver out
    // here, and the job is owed the reason rather than "does not resolve".
    if (host === normalHost(CONTAINER_HOST) || /(^|\.)docker\.internal$/.test(host)) {
      throw new Refusal(403, `the broker does not connect to ${host}: that name is this machine, not a public internet address. ${NOT_HERE}`);
    }
    const family = net.isIP(host);
    if (!family && localName(host)) {
      throw new Refusal(403, `the broker does not connect to ${host}: that is a name of a machine's own network, not of the public internet. ${NOT_HERE}`);
    }
    let found;
    try { found = family ? [{ address: host, family }] : await resolve(job, host); } catch (e) { throw new Refusal(502, `${host} does not resolve (${e.code || e.message})`); }
    const allowed = found.filter((a) => !deniedAddress(a.address));
    if (allowed.length === 0) {
      throw new Refusal(403, `the broker does not connect to ${host}: ${family ? 'that is' : found.length ? 'what it resolves to is' : 'it has no address and so is'} not a public internet address. ${NOT_HERE}`);
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

  // A job's own upstream connections: never lent to another job, and closed with it.
  // One request goes down each, and a request takes its place among the job's
  // connections out before it is given one.
  function agentFor(job, wrap, kept) {
    const agent = new http.Agent(kept);
    agent.createConnection = (opts, cb) => {
      dial(job, opts.host, opts.port).then((raw) => {
        // A job that ended meanwhile: its request is torn down as its connection
        // closes, which is later than this.
        if (!live(job)) {
          raw.destroy();
          return cb(new Error('the job has ended'));
        }
        hold(job, raw);
        outbound.add(job, raw);
        wrap(raw, opts, cb);
      }).catch(cb);
    };
    return agent;
  }
  const plainWrap = (raw, opts, cb) => cb(null, raw);
  const tlsWrap = (raw, opts, cb) => {
    const secure = tls.connect({ socket: raw, servername: opts.host, ALPNProtocols: ['http/1.1'], ca: upstreamCa });
    outbound.over(raw, secure);
    secure.once('error', cb);
    secure.once('secureConnect', () => {
      secure.off('error', cb);
      secure.on('error', () => {});
      cb(null, secure);
    });
  };

  // The job a Proxy-Authorization header's value names, or null.
  function jobBy(authorization) {
    const m = /^Basic\s+(\S+)$/i.exec(authorization || '');
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

  // `requests` is the feed the requests that come down `client` are read from: its own
  // bytes, or those of the terminated connection inside it. While the job is at its
  // share of requests the feed is stopped, from the first when the job is at its share
  // by then.
  function reads(job, client, requests) {
    job.clients.set(client, requests);
    // Each request it has here watches it close, some from several places.
    requests.setMaxListeners(0);
    if (job.stopped) requests.stop();
  }

  // A place among the job's connections for one of its container's, or false when the
  // job has as many as it gets.
  function seat(job, socket) {
    if (job.clients.size >= limits.connections) return false;
    hop.seat(socket, job);
    job.clients.set(socket, null);
    socket.once('close', () => job.clients.delete(socket));
    hold(job, socket);
    return true;
  }
  const crowded = () => `this job has ${limits.connections} connections open through the broker, the most a job gets at a time: close some`;

  // Written whole, and the connection closed once the client has had a moment to read
  // it. What the client sends meanwhile is read and dropped; one that sends more than
  // REFUSED_BYTES is closed under what it sends, which resets it.
  function sayAndClose(socket, text) {
    socket.end(text);
    let dropped = 0;
    socket.on('data', (c) => {
      dropped += c.length;
      if (dropped > REFUSED_BYTES) socket.destroy();
    });
    socket.resume();
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
  // went. `fn` is called once: a connection that closes under the answer being written
  // closes that answer too, in the same breath. Returns the function that ends the
  // watching.
  function over(res, fn) {
    const { socket } = res.req;
    let told = false;
    const stop = () => {
      res.off('close', done);
      socket.off('close', done);
    };
    const done = () => {
      if (told) return;
      told = true;
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

  // ---- how many requests a job may have here at a time

  // A request counts from its head to the end of its answer. At the job's share the
  // feeds its requests come through hand nothing on, so what it sends next waits with
  // its sender, and so does the news that it closed a connection, until a request ends
  // by its answer or its time. A feed hands node one request head at a time, so none
  // comes past the share. A feed node had paused itself, for a body nobody reads yet,
  // stays paused when the stop ends: starting it would read the body into memory.
  function counted(job, req, res) {
    job.asked += 1;
    over(res, () => {
      job.asked -= 1;
      job.stopped = false;
      for (const requests of job.clients.values()) requests?.start();
    });
    if (job.asked >= limits.requests) {
      job.stopped = true;
      for (const requests of job.clients.values()) requests?.stop();
    }
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
    socket.bodyOf(req);
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
  // too. One the broker carries upstream itself (a model request, a plain http one)
  // takes a place among the job's connections out. One that does not fit waits, unread.
  // A lease is given back when the response is over.

  // Whoever fits is let in, the earlier first. One that waits for bytes keeps back the
  // bodies behind it, and nothing else: a request with no body does not wait for one
  // that has, and one that needs no place among the forge requests, or no connection
  // out, does not wait for one. The queue is never longer than the job's share of
  // requests.
  function drain(job) {
    const { gate } = job;
    let bytesKept = false;
    for (const waiter of gate.queue) {
      // A connection on its way out gets nothing; its request leaves the queue as it closes.
      if (waiter.socket.destroyed) continue;
      const noPlace = waiter.slot && gate.slots >= limits.forgeRequests;
      const noWayOut = waiter.out && gate.outs >= limits.upstreams;
      const noBytes = waiter.need > 0 && (bytesKept || (gate.bytes > 0 && gate.bytes + waiter.need > limits.bufferBytes));
      if (!noPlace && !noWayOut && !noBytes) waiter.admit();
      bytesKept ||= noBytes;
    }
  }

  function enter(job, req, res, { slot = false, out = false, streamed = false }) {
    const { gate } = job;
    const declared = req.headers['content-length'];
    // The parser takes a length of up to 20 digits; past 15 it is not the number it reads
    // as, which matters to a body streamed on.
    if (declared !== undefined && !/^\d{1,15}$/.test(declared)) return Promise.reject(new Refusal(400, FRAMING));
    const need = streamed ? 0 : req.headers['transfer-encoding'] !== undefined ? FORGE_BODY_CAP : Number(declared ?? 0);
    if (need > FORGE_BODY_CAP) {
      return Promise.reject(new Refusal(413, `the request body is over ${FORGE_BODY_CAP / 2 ** 20} MiB, the most the network carries in one request`));
    }
    const lease = { bytes: 0, slot: false, out: false, left: false };
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
      if (lease.out) gate.outs -= 1;
      drain(job);
    };
    return new Promise((resolve, reject) => {
      const waiter = { need, slot, out, socket: req.socket };
      let unwatch = () => {};
      const settle = (fn, value) => {
        clearTimeout(timer);
        unwatch();
        gate.queue.delete(waiter);
        fn(value);
      };
      const gone = () => { settle(reject, new Error('the client went away')); drain(job); };
      const timer = setTimeout(() => {
        settle(reject, new Refusal(503, `this job's earlier requests hold all the broker gives one job at a time (${limits.bufferBytes / 2 ** 20} MiB of bodies, forge requests in flight: ${limits.forgeRequests}, connections out: ${limits.upstreams}), and none ended within ${limits.bodyMs / 1000} s`));
        drain(job);
      }, limits.bodyMs);
      waiter.admit = () => {
        lease.bytes = need;
        lease.slot = slot;
        lease.out = out;
        gate.bytes += need;
        if (slot) gate.slots += 1;
        if (out) gate.outs += 1;
        settle(resolve, lease);
        over(res, lease.leave);
      };
      waiter.drop = () => settle(reject, new Error('the client went away'));
      gate.queue.add(waiter);
      unwatch = over(res, gone);
      drain(job);
    });
  }

  // The whole body: a Refusal(413) once it passes the cap, a Refusal(408) when it has
  // not all come within bodyMs. It is copied into one buffer as it comes, whatever the
  // chunks it comes in.
  function collect(req) {
    return new Promise((resolve, reject) => {
      const declared = Number(req.headers['content-length'] ?? 0);
      let body = null;
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
        if (size + c.length > FORGE_BODY_CAP) return settle(reject, new Refusal(413, `the request body is over ${FORGE_BODY_CAP / 2 ** 20} MiB, the most the network carries in one request`));
        if (!body || body.length - size < c.length) {
          const bigger = Buffer.allocUnsafe(Math.min(FORGE_BODY_CAP, Math.max(declared, 2 * (size + c.length), 65536)));
          body?.copy(bigger, 0, 0, size);
          body = bigger;
        }
        c.copy(body, size);
        size += c.length;
      };
      req.on('data', onData);
      req.once('end', () => settle(resolve, !body ? Buffer.alloc(0) : size === body.length ? body : Buffer.from(body.subarray(0, size))));
      req.once('error', (e) => settle(reject, e));
      req.once('close', () => settle(reject, new Error('the client went away')));
    });
  }

  // A body passed on to `to` as it comes, in pieces of up to CARRY_BYTES: the parser
  // hands it on in the chunks its sender framed it in, down to a byte, and each written
  // on its own would be a write of its own all the way out. `req` waits while `to` is
  // full, and what comes after `to` closed is read and dropped.
  function carry(req, to) {
    let piece = null;
    let length = 0;
    let soon = null;
    let gone = false;
    to.once('close', () => {
      gone = true;
      req.resume();
    });
    const flush = () => {
      clearImmediate(soon);
      soon = null;
      if (length === 0 || gone) return;
      const out = piece.subarray(0, length);
      piece = null;
      length = 0;
      if (!to.write(out) && !req.isPaused()) {
        req.pause();
        to.once('drain', () => req.resume());
      }
    };
    req.on('data', (c) => {
      if (length + c.length > CARRY_BYTES) flush();
      if (c.length >= CARRY_BYTES) {
        piece = c;
        length = c.length;
        return flush();
      }
      piece ??= Buffer.allocUnsafe(CARRY_BYTES);
      c.copy(piece, length);
      length += c.length;
      soon ??= setImmediate(flush);
    });
    req.once('end', () => {
      flush();
      if (!gone) to.end();
    });
  }

  // ---- the listener a container sees

  const feed = createFeeder();
  const hop = createHop();
  // The connections that are no job's: those whose first request head has not come, and
  // those refused, which are given a moment to read why. When there are as many as the
  // broker keeps, the one that has waited longest is closed for the next.
  const strangers = new Set();

  const onlyHttps = (host, port) => `the broker connects to ${host} on port 443 only, where its requests are read; ${port === 80 ? 'plain http' : `port ${port}`} would lead around that`;
  const noSsh = (job, host) => `the broker does not connect to ${host}: it serves ${job.info.pool.host} over ssh, around the requester, and no key for it is in this container. Use https://${job.info.pool.host}/`;

  // A connection's first request head is read here, off the socket, before node's
  // parser is given a byte of it: a connection that names no admitted job costs one
  // look at one head, one answer and nothing after, whatever it sends and however much.
  // A connection that opens with the hop's PREFACE comes from a job's relay, in frames
  // (hop.js), and is read from there on as the bytes the frames carry.
  const front = net.createServer({ allowHalfOpen: true, noDelay: true }, (socket) => arrive(socket, true));
  front.on('error', (e) => log('broker', `the listener: ${e.message}`));

  function arrive(socket, raw) {
    socket.on('error', () => socket.destroy());
    socket.setTimeout(limits.idleMs, () => socket.destroy());
    if (strangers.size >= limits.strangers) {
      const [longest] = strangers;
      strangers.delete(longest);
      longest.destroy();
    }
    strangers.add(socket);
    socket.once('close', () => strangers.delete(socket));
    expectHead(socket);
    // What came before the chunk at hand, at the start of a buffer with room for more:
    // each chunk is looked at once, however few bytes it brings.
    let kept = null;
    let length = 0;
    let edge = 0;
    const more = guard((chunk) => {
      if (raw && length === 0 && chunk[0] === PREFACE[0]) {
        socket.off('data', more);
        strangers.delete(socket);
        gotHead(socket);
        socket.setTimeout(0);
        return arrive(hop.framed(socket, chunk), false);
      }
      const found = headEnd(chunk, edge);
      const end = found === -1 ? -1 : length + found;
      if ((end === -1 ? length + chunk.length : end) > HEAD_BYTES) return socket.destroy();
      if (end === -1) {
        edge = edgeAfter(chunk, edge);
        if (!kept || kept.length - length < chunk.length) {
          const bigger = Buffer.allocUnsafe(Math.min(HEAD_BYTES, Math.max(2 * (length + chunk.length), 1024)));
          kept?.copy(bigger, 0, 0, length);
          kept = bigger;
        }
        chunk.copy(kept, length);
        length += chunk.length;
        return undefined;
      }
      socket.off('data', more);
      socket.pause();
      gotHead(socket);
      return first(socket, length ? Buffer.concat([kept.subarray(0, length), chunk]) : chunk, end);
    }, socket);
    socket.on('data', more);
  }

  // What the broker itself goes by in a first head: the request line, and the token.
  // A CONNECT is answered from here. Any other request is node's to read, the bytes of
  // its head with it, through a feed.
  function first(socket, seen, end) {
    const lines = seen.latin1Slice(0, end).split(/\r?\n/);
    const line = /^([A-Z]+) (\S+) HTTP\/1\.[01]$/.exec(lines[0]);
    if (!line) return socket.destroy();
    const [, method, target] = line;
    const authorization = lines.find((l) => /^proxy-authorization:/i.test(l));
    const job = jobBy(authorization?.slice(authorization.indexOf(':') + 1).trim());
    if (!job) {
      if (trace) trace(`407 ${method} ${method === 'CONNECT' ? target : target.split('?')[0]}`);
      return sayAndClose(socket, DENY_407);
    }
    if (!seat(job, socket)) return refuse(socket, new Refusal(503, crowded()));
    strangers.delete(socket);
    if (method === 'CONNECT') return tunnel(job, target, socket, seen.subarray(end));
    const requests = feed(socket, seen);
    requests.dn = { job };
    plain.emit('connection', requests);
    return reads(job, socket, requests);
  }

  const tunnel = guard(async (job, target, socket, head) => {
    const m = /^(\[[0-9a-fA-F:.]+\]|[^:[\]]+):(\d{1,5})$/.exec(target);
    const port = m ? Number(m[2]) : 0;
    const host = m ? normalHost(m[1]) : '';
    if (!host || port < 1 || port > 65535) return refuse(socket, new Refusal(400, `not a host and port: ${target}`));
    if (trace) trace(`${job.info.runId} CONNECT ${host}:${port}`);
    if (job.intercept.has(host)) {
      if (port !== 443) return refuse(socket, new Refusal(403, onlyHttps(host, port)));
      return intercept(job, host, socket, head);
    }
    if (job.ssh.has(host)) return refuse(socket, new Refusal(403, noSsh(job, host)));
    const forward = /^([a-z0-9-]+)\.forward\.dn$/.exec(host);
    const to = forward && job.forwards.get(forward[1]);
    if (forward && !to) return refuse(socket, new Refusal(404, `this job has no forward named ${forward[1]}`));
    let upstream;
    try {
      // A forward leads to this machine on purpose, so it is not held to the rule for
      // everything else; which job may use it is settled by the token it came with.
      upstream = await (to ? systemConnect({ host: to.host || '127.0.0.1', port: to.port }) : dial(job, host, port));
    } catch (e) {
      sparing(`job ${job.info.runId} refused`, 'broker', job.info.runId, clip(`refused ${host}:${port}: ${e.message}`));
      return refuse(socket, e);
    }
    upstream.on('error', () => socket.destroy());
    // Removing the job closed its connection, and this one goes with it.
    if (socket.destroyed) return upstream.destroy();
    hold(job, upstream);
    outbound.add(job, upstream);
    socket.on('close', () => outbound.close(upstream));
    upstream.on('close', () => socket.destroy());
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head.length) upstream.write(head);
    socket.pipe(upstream);
    upstream.pipe(socket);
  });

  // The requests of a connection that began with one that was no CONNECT. The
  // connection is the job's whose token its first request carried, and a request on it
  // that does not carry that token is its last. So is a CONNECT: node closes the
  // connection of one that nobody listens for.
  const plain = http.createServer(guard(async (req, res) => {
    begun(req, res);
    const { job } = req.socket.dn;
    if (jobBy(req.headers['proxy-authorization']) !== job) {
      if (trace) trace(`407 ${req.method} ${req.url.split('?')[0]}`);
      req.socket.last();
      res.writeHead(407, { 'proxy-authenticate': 'Basic realm="dn"', 'content-length': 0, connection: 'close' });
      return res.end();
    }
    counted(job, req, res);
    let url;
    try { url = new URL(req.url); } catch { url = null; }
    if (url?.protocol !== 'http:') return sendJson(res, 400, { message: 'this is a proxy: it takes CONNECT and http:// requests' });
    const host = normalHost(url.hostname);
    if (!host) return sendJson(res, 400, { message: `not a host: ${url.hostname}` });
    const port = Number(url.port) || 80;
    if (trace) trace(`${job.info.runId} ${req.method} http://${url.host}${url.pathname}`);
    if (job.intercept.has(host)) return sendText(res, 403, onlyHttps(host, port));
    if (job.ssh.has(host)) return sendText(res, 403, noSsh(job, host));

    // The request is framed again here, from what the parser read: a length or a
    // transfer coding passed on as the job wrote it is a second request the upstream
    // reads on a connection that outlives this one.
    const coding = req.headers['transfer-encoding'];
    const declared = req.headers['content-length'];
    if (coding !== undefined && coding.trim().toLowerCase() !== 'chunked') return sendJson(res, 400, { message: FRAMING });
    const headers = { ...requestHeaders(req.headers, ['content-length', 'host']), host: url.host };
    if (coding !== undefined) headers['transfer-encoding'] = 'chunked';
    else if (declared !== undefined) headers['content-length'] = String(Number(declared));
    const bodied = coding !== undefined || Number(declared ?? 0) > 0;

    try { await enter(job, req, res, { out: true, streamed: true }); } catch (e) {
      return sendJson(res, e.status || 502, { message: e.message });
    }
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
    if (bodied) carry(req, up); else up.end();
  }));
  plain.timeout = limits.idleMs;
  plain.on('clientError', (e, socket) => socket.destroy());

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
    const requests = feed(secure);
    requests.dn = { job, host };
    expectHead(requests);
    inner.emit('connection', requests);
    reads(job, socket, requests);
  }

  // Each request on a terminated connection is judged on its own, however many came
  // before it: the job still admitted, the target a path, the Host the name the
  // connection was opened to. A port beside that name decides nothing: clients that
  // tunnel by hand write the wrong one.
  const inner = http.createServer(guard((req, res) => {
    begun(req, res);
    const { job, host } = req.socket.dn;
    if (!live(job)) return res.destroy();
    counted(job, req, res);
    if (trace) trace(`${job.info.runId} ${req.method} https://${host}${req.url.split('?')[0]} [${Object.keys(req.headers).join(' ')}]`);
    if (!req.url.startsWith('/')) return sendJson(res, 400, { message: 'the request target must be a path' });
    const named = req.rawHeaders.filter((h, i) => i % 2 === 0 && h.toLowerCase() === 'host').length === 1 ? normalHost(req.headers.host.replace(/:\d+$/, '')) : null;
    if (named !== host) return sendJson(res, 421, { message: `this connection is to ${host}: a request for another host needs a connection of its own` });
    const coding = req.headers['transfer-encoding'];
    if (coding !== undefined && coding.trim().toLowerCase() !== 'chunked') return sendJson(res, 400, { message: FRAMING });
    const handler = MODEL_HOSTS.includes(host) ? model : forge;
    return handler(job, host, req, res).catch((e) => {
      if (e.message !== 'the client went away') sparing(`job ${job.info.runId} failed`, 'broker', job.info.runId, clip(`${req.method} ${host}: ${e.message}`));
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
      // The operator's own git configuration has no say in what a container is served:
      // git is given no home to read one from, and is told to leave the system's alone.
      const env = { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', ...(protocol ? { GIT_PROTOCOL: protocol } : {}) };
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
      req.on('error', () => child.kill('SIGKILL'));
      if (!/^(x-)?gzip$/i.test(req.headers['content-encoding'] || '')) return carry(req, child.stdin);
      const gunzip = zlib.createGunzip();
      gunzip.on('error', () => child.kill('SIGKILL'));
      carry(req, gunzip);
      gunzip.pipe(child.stdin);
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

  // What a job has had of the model. Its share is counted in the requests sent for it
  // and the bytes carried for them, either way and whatever came of them. `bytes` is
  // the part the provider took: the inference requests it answered with a 2xx, and
  // those answers.
  const spentBy = (job) => ({ requests: job.spent.requests, bytes: job.spent.bytes, carried: job.spent.carried });

  function heard(job) {
    const spent = spentBy(job);
    for (const fn of spendHeard) {
      try { fn(job.info.runId, spent); } catch (e) { sparing('spend listener', 'broker', `a spend listener failed: ${e?.message ?? e}`); }
    }
  }

  async function model(job, host, req, res) {
    // Read whole, because a refused credential is answered by sending it again.
    const lease = await enter(job, req, res, { out: true });
    const body = await collect(req);
    lease.resize(body.length);
    const base = { ...requestHeaders(req.headers, ['content-length', 'host']), host, 'content-length': String(body.length) };
    const inject = carriesPlaceholder(req.headers) && MODEL_PATHS.test(req.url.split('?')[0]);
    if (inject) {
      const { spent } = job;
      if (spent.requests >= JOB_MODEL_REQUESTS || spent.carried >= JOB_MODEL_BYTES) {
        if (!spent.said) log('broker', job.info.runId, `the model is closed to this job after ${spent.requests} requests and ${spent.carried} bytes`);
        spent.said = true;
        // The provider's shape for "slow down", marked as not worth another try.
        return sendJson(res, 429, { type: 'error', error: { type: 'rate_limit_error', message: `this job has used all of the model it gets on this executor (${JOB_MODEL_REQUESTS} requests, ${JOB_MODEL_BYTES} bytes): it made ${spent.requests} requests of ${spent.carried} bytes. No further request will be answered; finish with what you have.` } },
          { 'x-should-retry': 'false' });
      }
      spent.requests += 1;
      spent.carried += body.length;
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
    // The answer is passed on as it comes: the request's bytes are given back here, its
    // connection out when the answer is over.
    lease.resize(0);
    if (!Number.isInteger(upRes.statusCode) || upRes.statusCode < 200 || upRes.statusCode > 599) {
      upRes.destroy();
      throw new Refusal(502, `the model provider answered with the status ${upRes.statusCode}, which is no HTTP answer`);
    }
    res.writeHead(upRes.statusCode, answerPairs(upRes).filter(([name]) => MODEL_ANSWER_HEADERS.test(name.toLowerCase())).flat());
    res.flushHeaders();
    if (inject) {
      const taken = upRes.statusCode < 300 && req.url.split('?')[0] === '/v1/messages';
      if (taken) job.spent.bytes += body.length;
      upRes.on('data', (c) => {
        job.spent.carried += c.length;
        if (taken) job.spent.bytes += c.length;
      });
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
  /// model by then, as `spent` gave it: its share does not start again.
  async function addJob(info, { token = crypto.randomBytes(32).toString('hex'), generation = null, spent = null } = {}) {
    if (!listening) throw new Error('the broker is not listening');
    if (jobs.has(info.runId)) throw new Error(`job ${info.runId} is already admitted`);
    const hosts = [...forgeHosts(info.pool), ...MODEL_HOSTS].map(normalHost);
    if (!/^[0-9a-f]{64}$/.test(token) || tokens.has(token)) throw new Error(`job ${info.runId} cannot be admitted under that token`);
    // An authority that cannot be made is this machine's doing, and nothing of the job has run.
    const authority = generation === null ? await own(ca.authority(hosts)) : ca.kept(generation);
    if (!authority) throw new Error(`job ${info.runId} cannot be admitted: the certificate authority it was started under is gone`);
    if (jobs.has(info.runId)) throw new Error(`job ${info.runId} is already admitted`);
    const job = {
      info, token, authority, intercept: new Set(hosts), ssh: new Set(forgeSshHosts(info.pool).map(normalHost)),
      sockets: new Set(), clients: new Map(), forwards: new Map(),
      spent: { requests: count(spent?.requests), bytes: count(spent?.bytes), carried: count(spent?.carried), said: false },
      asked: 0, stopped: false,
      looking: 0, lookTurns: [],
      gate: { bytes: 0, slots: 0, outs: 0, queue: new Set() },
    };
    job.plain = agentFor(job, plainWrap, {});
    // The provider's are kept for the job's next request: each costs a TLS handshake.
    job.model = agentFor(job, tlsWrap, { keepAlive: true });
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
    for (const waiter of job.gate.queue) waiter.drop();
    outbound.drop(job);
    job.plain.destroy();
    job.model.destroy();
    for (const s of job.sockets) s.destroy();
    sparing.end(`job ${runId} `);
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

  /// What a job has had of the model on this machine's credential, or null for a job
  /// that is not admitted: `{ requests, bytes, carried }` - the requests sent for it, the
  /// bytes of the inference requests the provider accepted and of its answers to them,
  /// and every byte carried either way, whatever came of it. It is what `addJob` takes
  /// back as `spent`.
  function spent(runId) {
    const job = jobs.get(runId);
    return job ? spentBy(job) : null;
  }

  /// Calls `fn(runId, spent)`, `spent` as above, when a job's spend has grown: as a request is
  /// counted, and again when its answer has been passed on. Returns the function that
  /// ends the listening.
  function onSpend(fn) {
    spendHeard.add(fn);
    return () => spendHeard.delete(fn);
  }

  /// What a job holds of the broker now: `{ connections, requests, bytes, forgeRequests,
  /// upstreams, waiting, held }` - its container's connections, its requests that have no
  /// answer yet, the bodies read whole, the forge requests in flight, the requests being
  /// carried upstream, the requests waiting their turn for any of those three, and the
  /// bytes its connections have on the hop from its relay (hop.js). Null for a job that
  /// is not admitted.
  function load(runId) {
    const job = jobs.get(runId);
    if (!job) return null;
    const { gate } = job;
    return { connections: job.clients.size, requests: job.asked, bytes: gate.bytes, forgeRequests: gate.slots, upstreams: gate.outs, waiting: gate.queue.size, held: hop.held(job) };
  }

  /// Starts listening, on `port` when given: the port the jobs of an earlier daemon were
  /// told. Otherwise on the port the operator named, or one the next daemon can have
  /// again. Resolves to `{ host, port }`.
  async function start({ port = BROKER_PORT || quietPort() } = {}) {
    const host = await brokerBindAddress();
    await new Promise((resolve, reject) => {
      const failed = (err) => { front.off('listening', up); reject(err); };
      const up = () => { front.off('error', failed); resolve(); };
      front.once('error', failed);
      front.once('listening', up);
      front.listen(port, host);
    });
    listening = { host, port: front.address().port };
    log('broker', `listening on ${host}:${listening.port}`);
    return listening;
  }

  /// Ends every job and stops listening.
  async function stop() {
    for (const runId of [...jobs.keys()]) removeJob(runId);
    if (!listening) return;
    listening = null;
    for (const socket of strangers) socket.destroy();
    await new Promise((resolve) => front.close(resolve));
  }

  return { start, stop, address: () => listening, addJob, removeJob, addForward, spent, onSpend, load };
}
