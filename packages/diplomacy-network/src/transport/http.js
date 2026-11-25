// The framing both transports share (PROTOCOL.md section 1): one request is one HTTP/1.1
// `POST /dn1`. The server half is what a stranger reaches first, so everything before the
// request handler runs is bounded: header size, body size, time and connections.

import http from 'node:http';

const REQUEST_PATH = '/dn1';

export const DEFAULT_LIMIT = 1 << 20;

/// Each overridable through a transport's `tune` option.
export const HTTP_TUNING = {
  maxHeaderBytes: 8192,
  headersTimeoutMs: 20 * 1000,
  // A body has bodyBaseMs plus its declared length at bodyBytesPerSec to arrive.
  bodyBaseMs: 20 * 1000,
  bodyBytesPerSec: 32 * 1024,
  maxConnections: 256,
  // The client gives up first by a wide margin, so it does not write into a connection the
  // server is closing.
  serverIdleMs: 5 * 60 * 1000,
  clientIdleMs: 2 * 60 * 1000,
  // Requests with one peer at a time, each on its own connection; the rest wait their
  // turn, inside their own timeouts.
  maxSocketsPerPeer: 8,
  // A body above this is announced with `Expect: 100-continue` and sent only once the
  // server agrees to read it, so a refusal costs neither side the transfer.
  expectAboveBytes: 64 * 1024,
};

/// An Error whose `code` is one of the transport's failure codes: unreachable, timeout,
/// too-large, http-<status>, protocol, stopped.
export class TransportError extends Error {
  constructor(code, detail) {
    super(`${code}: ${detail}`);
    this.code = code;
  }
}

export function fail(code, detail) {
  return new TransportError(code, detail);
}

/// `limitFor(fn)`: `fn(headers)` answers the most body bytes to read, as a number or as
/// `{ bytes, release }`; `release` is then called exactly once, when the request it sized
/// is over - answered, refused, timed out or abandoned.
export function createServer({ log, tune }) {
  const t = { ...HTTP_TUNING, ...tune };
  let handler = async () => { throw new Error('no request handler is set'); };
  let limit = () => DEFAULT_LIMIT;

  const server = http.createServer({
    maxHeaderSize: t.maxHeaderBytes,
    headersTimeout: t.headersTimeoutMs,
    // Node's whole-request deadline is one number for every request; a body's deadline
    // here grows with its declared length instead.
    requestTimeout: 0,
    keepAliveTimeout: t.serverIdleMs,
    connectionsCheckingInterval: Math.max(20, Math.min(1000, t.headersTimeoutMs / 4)),
  });
  server.maxConnections = t.maxConnections;
  // At the cap a new connection is dropped unanswered. Idle kept-alive connections are
  // what an attacker fills the cap with most cheaply, so they make room for the next one.
  server.on('drop', () => server.closeIdleConnections());
  server.on('request', serve);
  server.on('checkContinue', serve);

  function serve(req, res) {
    // A refusal never reads the body, so the connection cannot be used again.
    const refuse = (status, headers) => {
      res.writeHead(status, { ...headers, connection: 'close', 'content-length': 0 });
      res.end();
    };
    if (req.url !== REQUEST_PATH) return refuse(404);
    if (req.method !== 'POST') return refuse(405, { allow: 'POST' });
    const declared = req.headers['content-length'];
    if (!/^\d+$/.test(declared ?? '')) return refuse(411);
    const length = Number(declared);
    let says;
    try {
      says = limit(req.headers);
    } catch (err) {
      log(`transport: the limit callback failed: ${err?.stack ?? err}`);
      return refuse(500);
    }
    const { bytes: allowed, release } = typeof says === 'number' ? { bytes: says } : says;
    let held = typeof release === 'function';
    const free = () => {
      if (!held) return;
      held = false;
      release();
    };
    let handled = false;
    res.on('close', () => !handled && free());
    if (length > allowed) return refuse(413);
    if (req.headers.expect) res.writeContinue();

    const chunks = [];
    const deadline = setTimeout(() => refuse(408), t.bodyBaseMs + (length / t.bodyBytesPerSec) * 1000);
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('close', () => clearTimeout(deadline));
    req.on('end', () => {
      clearTimeout(deadline);
      if (res.writableEnded || res.destroyed) return; // refused on its deadline, or gone
      handled = true;
      answer(Buffer.concat(chunks), req.headers, res).then(free);
    });
  }

  async function answer(body, headers, res) {
    let status = 200;
    let out;
    try {
      out = await handler(body, { headers });
      if (!Buffer.isBuffer(out)) throw new TypeError('the request handler did not return a Buffer');
    } catch (err) {
      log(`transport: request handler failed: ${err?.stack ?? err}`);
      status = 500;
      out = Buffer.alloc(0);
    }
    if (res.writableEnded || res.destroyed) return; // refused on its deadline, or gone
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': out.length });
    res.end(out);
  }

  return {
    listen() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
          server.off('error', reject);
          resolve(server.address().port);
        });
      });
    },
    onRequest(fn) { handler = fn; },
    limitFor(fn) { limit = fn; },
    close() {
      return new Promise((resolve) => {
        if (!server.listening) return resolve();
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}

// `dial` may take a minute over Tor; pooling, reuse and idle expiry are node's own.
class DialAgent extends http.Agent {
  constructor(dial, options) {
    super(options);
    this.dial = dial;
  }

  createConnection(options, callback) {
    this.dial(options.host).then((socket) => callback(null, socket), callback);
  }
}

// A reused connection found dead before a single byte of an answer.
const STALE = Symbol('stale connection');

/// `request(host, body, { deadline, maxResponseBytes, headers })`, one connection kept
/// alive per host.
export function createClient({ dial, tune }) {
  const t = { ...HTTP_TUNING, ...tune };
  const agent = new DialAgent(dial, { keepAlive: true, maxFreeSockets: 1, timeout: t.clientIdleMs });
  const pending = new Set(); // each in-flight attempt's settle function
  let closed = false;
  // Per host: how many requests have their turn, and those waiting for one. The agent's
  // own per-host cap counts a connection only once it is made, which is too late for
  // connections that take a dial to make.
  const lanes = new Map();

  function enter(host, turn) {
    const lane = lanes.get(host) ?? { busy: 0, waiting: [] };
    lanes.set(host, lane);
    if (lane.busy === t.maxSocketsPerPeer) return lane.waiting.push(turn);
    lane.busy++;
    turn.held = true;
    turn.go();
  }

  function leave(host, turn) {
    const lane = lanes.get(host);
    if (!turn.held) {
      lane.waiting = lane.waiting.filter((other) => other !== turn);
      return;
    }
    const next = lane.waiting.shift();
    if (!next) {
      if (--lane.busy === 0) lanes.delete(host);
      return;
    }
    next.held = true;
    // An answered request's connection goes back to the agent on the next tick. The next
    // request starts right behind that, and takes the connection before a second one
    // coming back makes the agent close it as one idle connection too many.
    process.nextTick(next.go);
  }

  function attempt(host, body, { deadline, maxResponseBytes, headers }) {
    if (closed) return Promise.reject(fail('stopped', 'the transport stopped'));
    return new Promise((resolve, reject) => {
      let req = null;
      let answered = false;
      let settled = false;
      const settle = (err, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        pending.delete(settle);
        // Every failure retires the connection: what state it is in is not worth knowing.
        if (err) req?.destroy();
        leave(host, turn);
        if (err) reject(err);
        else resolve(value);
      };
      pending.add(settle);
      const timer = setTimeout(
        () => settle(fail('timeout', `no answer from ${host} in time`)),
        Math.max(0, deadline - Date.now()),
      );

      const go = () => {
        if (settled) return;
        const expect = body.length > t.expectAboveBytes;
        req = http.request({
          agent,
          host,
          port: 80,
          method: 'POST',
          path: REQUEST_PATH,
          maxHeaderSize: t.maxHeaderBytes,
          headers: {
            ...headers,
            'content-type': 'application/json',
            'content-length': body.length,
            ...(expect && { expect: '100-continue' }),
          },
        });
        req.on('error', (err) => {
          if (err instanceof TransportError) return settle(err);
          if (String(err.code).startsWith('HPE_')) return settle(fail('protocol', `${host} answered with broken HTTP: ${err.code}`));
          settle(req.reusedSocket && !answered ? STALE : fail('unreachable', `connection to ${host} failed: ${err.message}`));
        });
        req.on('continue', () => {
          answered = true;
          req.end(body);
        });
        req.on('response', (res) => {
          answered = true;
          if (res.statusCode !== 200) return settle(fail(`http-${res.statusCode}`, `${host} answered ${res.statusCode}`));
          const chunks = [];
          let size = 0;
          res.on('data', (chunk) => {
            size += chunk.length;
            if (size > maxResponseBytes) return settle(fail('too-large', `the answer from ${host} is over ${maxResponseBytes} bytes`));
            chunks.push(chunk);
          });
          res.on('end', () => settle(null, Buffer.concat(chunks, size)));
          res.on('error', () => {}); // the close below reports it
          res.on('close', () => settle(fail('unreachable', `connection to ${host} closed in the middle of its answer`)));
        });
        if (expect) req.flushHeaders();
        else req.end(body);
      };
      const turn = { held: false, go };
      enter(host, turn);
    });
  }

  return {
    /// A kept-alive connection can be dead unnoticed (a circuit went away); the request is
    /// then sent once more on a new connection. Nothing else is ever retried here.
    async request(host, body, options) {
      try {
        return await attempt(host, body, options);
      } catch (err) {
        if (err !== STALE) throw err;
      }
      try {
        return await attempt(host, body, options);
      } catch (err) {
        throw err === STALE ? fail('unreachable', `connection to ${host} closed before an answer`) : err;
      }
    },
    /// Closes every connection; requests in flight, and any made later, fail with `stopped`.
    close() {
      closed = true;
      for (const settle of [...pending]) settle(fail('stopped', 'the transport stopped'));
      agent.destroy();
    },
  };
}
