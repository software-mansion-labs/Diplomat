// The loopback transport, and through it the POST /dn1 framing both transports share:
// what a request and its answer are, how each failure is named, what the fault files do
// to a link, and what the listener refuses before a request handler ever runs.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { onInterrupt } from '../../daemon-core/src/test-interrupt.js';
import { generateIdentity, onionAddress } from '../src/core/identity.js';
import { createTransport } from '../src/transport/index.js';
import { loopFaults } from '../src/transport/loop.js';
import { scratchDir } from './lib/scratch.mjs';

const tmp = scratchDir('dn-');
const dir = path.join(tmp, 'loop');
const faults = loopFaults(dir);
const MIB = 1 << 20;
const hosts = [];
const servers = [];
const children = new Set();

function cleanup() {
  for (const child of children) child.kill('SIGKILL');
}
onInterrupt(cleanup);

async function check(name, fn) {
  try {
    await fn();
  } catch (err) {
    console.error(`FAIL ${name}`);
    throw err;
  }
  console.log(`PASS ${name}`);
}

async function until(probe, ms, what) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) assert.fail(`${what} did not happen within ${ms} ms`);
    await sleep(5);
  }
}

// A mutated transport hangs where a correct one answers; a test must fail then, not wait.
function within(ms, promise, what) {
  let timer;
  const late = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} took over ${ms} ms`)), ms); });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

const code = (promise) => promise.then(() => 'resolved', (err) => err.code ?? `uncoded: ${err.message}`);

// A started host that echoes. `handled` counts the requests its handler saw.
async function host({ tune } = {}) {
  const identity = generateIdentity();
  const h = { identity, pk: identity.pk, logs: [], handled: 0 };
  h.t = createTransport({ kind: 'loop', identity, dir, log: (line) => h.logs.push(line), tune });
  h.serve = (fn) => h.t.onRequest((body, info) => {
    h.handled++;
    return fn(body, info);
  });
  h.serve(async (body) => body);
  await h.t.start();
  h.port = Number(fs.readFileSync(path.join(dir, `${h.t.address}.addr`), 'utf8').split(':')[1]);
  hosts.push(h);
  return h;
}

// Speaks to a host's listener in raw bytes and resolves with what came back: when the
// host closed the connection, or after `settleMs` with the connection still open.
function raw(h, bytes, settleMs = 3000) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port: h.port });
    const from = Date.now();
    let text = '';
    const done = (closed) => {
      clearTimeout(timer);
      socket.destroy();
      resolve({ text, closed, ms: Date.now() - from, status: Number(text.split(' ')[1]) });
    };
    const timer = setTimeout(() => done(false), settleMs);
    socket.on('connect', () => bytes && socket.write(bytes));
    socket.on('data', (chunk) => { text += chunk; });
    socket.on('error', () => {});
    socket.on('close', () => done(true));
  });
}

const post = (body, extra = '') => `POST /dn1 HTTP/1.1\r\nhost: x\r\ncontent-length: ${Buffer.byteLength(body)}\r\n${extra}\r\n${body}`;

// A connection that made one request and stays open, as a client keeping it alive does.
function keptOpen(h) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port: h.port });
    const kept = { socket, closed: false };
    socket.on('connect', () => socket.write(post('{}')));
    socket.on('data', () => resolve(kept));
    socket.on('error', () => {});
    socket.on('close', () => { kept.closed = true; });
  });
}

// Stands between the directory and a host: counts the connections made to the host and
// the bytes sent to it.
async function proxied(h) {
  const p = { connections: 0, open: 0, bytesIn: 0 };
  const server = net.createServer((client) => {
    p.connections++;
    p.open++;
    const upstream = net.connect({ host: '127.0.0.1', port: h.port });
    client.on('data', (chunk) => { p.bytesIn += chunk.length; });
    client.pipe(upstream).pipe(client);
    client.on('error', () => {});
    upstream.on('error', () => {});
    client.on('close', () => {
      p.open--;
      upstream.destroy();
    });
    upstream.on('close', () => client.destroy());
  });
  servers.push(server);
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  fs.writeFileSync(path.join(dir, `${h.t.address}.addr`), `127.0.0.1:${server.address().port}\n`);
  return p;
}

// A peer that is no transport at all: `script({ conn, nth, body, socket, answer })` is
// called for the nth request on the conn-th connection and decides what goes back.
async function scripted(script) {
  const pk = generateIdentity().pk;
  const peer = { pk, connections: 0, requests: [] };
  const server = net.createServer((socket) => {
    const conn = ++peer.connections;
    let nth = 0;
    let buffered = Buffer.alloc(0);
    socket.on('error', () => {});
    socket.on('data', (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      for (;;) {
        const end = buffered.indexOf('\r\n\r\n');
        if (end === -1) return;
        const length = Number(/content-length: (\d+)/i.exec(buffered.subarray(0, end).toString())[1]);
        if (buffered.length < end + 4 + length) return;
        const body = buffered.subarray(end + 4, end + 4 + length).toString();
        buffered = buffered.subarray(end + 4 + length);
        peer.requests.push(body);
        const answer = (text, head = `content-length: ${Buffer.byteLength(text)}\r\n`) => socket.write(`HTTP/1.1 200 OK\r\n${head}\r\n${text}`);
        script({ conn, nth: ++nth, body, socket, answer });
      }
    });
  });
  servers.push(server);
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  fs.writeFileSync(path.join(dir, `${onionAddress(pk)}.addr`), `127.0.0.1:${server.address().port}\n`);
  return peer;
}

const say = (text) => Buffer.from(text);

try {
  const a = await host();
  const b = await host();

  await check('a request reaches the peer\'s handler with its headers, and the answer comes back', async () => {
    assert.equal(a.t.address, onionAddress(a.pk));
    assert.deepEqual(a.t.state(), { state: 'ready', detail: `loop (test transport): 127.0.0.1:${a.port}` });
    b.serve(async (body, info) => {
      assert.deepEqual(Object.keys(info), ['headers']);
      return say(JSON.stringify({ got: body.toString(), kind: info.headers['dn-kind'], length: body.length }));
    });
    const answer = await a.t.request(b.pk, say('{"n":1}'), { headers: { 'dn-kind': 'sync' } });
    assert.ok(Buffer.isBuffer(answer));
    assert.deepEqual(JSON.parse(answer), { got: '{"n":1}', kind: 'sync', length: 7 });
    assert.deepEqual(JSON.parse(await a.t.request(b.pk, Buffer.alloc(0))), { got: '', length: 0 });
    b.serve(async (body) => body);
    assert.equal((await b.t.request(a.pk, say('back'))).toString(), 'back');
  });

  await check('requests to one peer share a kept-alive connection, and concurrent ones each get their own answer', async () => {
    const c = await host();
    const p = await proxied(c);
    for (let i = 0; i < 5; i++) assert.equal((await a.t.request(c.pk, say(`seq ${i}`))).toString(), `seq ${i}`);
    assert.equal(p.connections, 1);
    const answers = await within(5000, Promise.all(Array.from({ length: 40 }, (_, i) => a.t.request(c.pk, say(`par ${i}`)))), 'forty requests at once');
    answers.forEach((answer, i) => assert.equal(answer.toString(), `par ${i}`));
    await until(() => p.open === 1, 2000, 'all but one connection closing');
    const before = p.connections;
    assert.equal((await a.t.request(c.pk, say('after'))).toString(), 'after');
    assert.equal(p.connections, before);

    const many = await Promise.all(Array.from({ length: 5 }, () => host()));
    const crossed = await Promise.all(many.flatMap((from) => many.map((to) => from.t.request(to.pk, say(`${from.port}>${to.port}`)))));
    assert.deepEqual(crossed.map(String), many.flatMap((from) => many.map((to) => `${from.port}>${to.port}`)));
  });

  await check('no more than the cap of requests are with one peer at once, and the rest wait their turn', async () => {
    const few = await host({ tune: { maxSocketsPerPeer: 3 } });
    const c = await host();
    const p = await proxied(c);
    let inFlight = 0;
    let peak = 0;
    c.serve(async (body) => {
      peak = Math.max(peak, ++inFlight);
      await sleep(20);
      inFlight--;
      return body;
    });
    const answers = await within(5000, Promise.all(Array.from({ length: 12 }, (_, i) => few.t.request(c.pk, say(`q ${i}`)))), 'twelve requests');
    answers.forEach((answer, i) => assert.equal(answer.toString(), `q ${i}`));
    assert.equal(peak, 3);
    assert.equal(p.connections, 3);
    assert.equal((await few.t.request(a.pk, say('another peer'))).toString(), 'another peer');

    // A request whose time is up while it waits never reaches the peer; one that waits
    // long enough does.
    const releases = [];
    c.serve((body) => new Promise((resolve) => { releases.push(() => resolve(body)); }));
    const held = [0, 1, 2].map((i) => few.t.request(c.pk, say(`held ${i}`)));
    await until(() => releases.length === 3, 2000, 'three requests in progress');
    assert.equal(await within(3000, code(few.t.request(c.pk, say('late'), { timeoutMs: 100 })), 'the request'), 'timeout');
    const patient = few.t.request(c.pk, say('patient'));
    await sleep(50);
    assert.equal(releases.length, 3);
    releases[0]();
    await until(() => releases.length === 4, 2000, 'the waiting request getting its turn');
    releases[3]();
    assert.equal((await patient).toString(), 'patient');

    // Two are still with the peer; a third takes the last turn, a fourth waits, and a
    // fifth is made in the same breath as the stop.
    const third = code(few.t.request(c.pk, say('third')));
    await until(() => releases.length === 5, 2000, 'the last turn being taken');
    const waiting = code(few.t.request(c.pk, say('waiting')));
    await sleep(20);
    const connections = p.connections;
    const racing = code(few.t.request(c.pk, say('racing')));
    await few.t.stop();
    const ends = await within(3000, Promise.all([...held.slice(1).map(code), third, waiting, racing]), 'the requests');
    assert.deepEqual(ends, ['stopped', 'stopped', 'stopped', 'stopped', 'stopped']);
    await sleep(50);
    assert.equal(releases.length, 5);
    assert.equal(p.connections, connections, 'a request that was waiting dialled after the stop');
  });

  await check('a connection nobody used for the idle time is closed by either end, and the next request opens another', async () => {
    const quick = await host({ tune: { clientIdleMs: 150 } });
    const c = await host();
    const p = await proxied(c);
    await quick.t.request(c.pk, say('one'));
    assert.equal(p.open, 1);
    await until(() => p.open === 0, 2000, 'the idle connection closing');
    assert.equal((await quick.t.request(c.pk, say('two'))).toString(), 'two');
    assert.equal(p.connections, 2);

    // The listener's idle time is the tuned one plus the second node adds to it.
    const brief = await host({ tune: { serverIdleMs: 150 } });
    const kept = await keptOpen(brief);
    const from = Date.now();
    await until(() => kept.closed, 2500, 'the listener closing its idle connection');
    assert.ok(Date.now() - from >= 140, `${Date.now() - from} ms`);
  });

  await check('a kept connection that died unnoticed is replaced within the same request', async () => {
    // The first connection answers once and is then dropped on its next request without
    // a byte, as a circuit that went away does; any other connection answers.
    const peer = await scripted(({ conn, nth, body, socket, answer }) => {
      if (conn === 1 && nth === 2) socket.destroy();
      else answer(`${body} on connection ${conn}`);
    });
    assert.equal((await a.t.request(peer.pk, say('first'))).toString(), 'first on connection 1');
    assert.equal((await within(3000, a.t.request(peer.pk, say('second')), 'the request')).toString(), 'second on connection 2');
    assert.deepEqual(peer.requests, ['first', 'second', 'second']);
  });

  await check('a new connection that closes before answering is unreachable, and nothing is sent twice', async () => {
    const peer = await scripted(({ socket }) => socket.destroy());
    assert.equal(await within(3000, code(a.t.request(peer.pk, say('lost'))), 'the request'), 'unreachable');
    assert.equal(peer.connections, 1);
    assert.deepEqual(peer.requests, ['lost']);
  });

  await check('an answer cut off half way is unreachable, and one that is not HTTP is a protocol failure', async () => {
    const half = await scripted(({ socket, answer }) => {
      answer('only the beginn', 'content-length: 500\r\n');
      socket.end();
    });
    assert.equal(await within(3000, code(a.t.request(half.pk, say('x'))), 'the request'), 'unreachable');
    const garbage = await scripted(({ socket }) => socket.end('SSH-2.0-OpenSSH_9.9\r\n'));
    assert.equal(await within(3000, code(a.t.request(garbage.pk, say('x'))), 'the request'), 'protocol');
  });

  await check('a peer with no address, or with nothing listening at it, is unreachable', async () => {
    const nobody = generateIdentity().pk;
    assert.equal(await code(a.t.request(nobody, say('x'))), 'unreachable');
    const closed = net.createServer();
    await new Promise((resolve) => { closed.listen(0, '127.0.0.1', resolve); });
    fs.writeFileSync(path.join(dir, `${onionAddress(nobody)}.addr`), `127.0.0.1:${closed.address().port}\n`);
    await new Promise((resolve) => { closed.close(resolve); });
    assert.equal(await code(a.t.request(nobody, say('x'))), 'unreachable');
    await assert.rejects(a.t.request('not a key', say('x')), TypeError);
  });

  await check('a host marked down refuses every request until the mark is lifted', async () => {
    await a.t.request(b.pk, say('warm'));
    const handled = b.handled;
    faults.down(b.t.address);
    assert.equal(await code(a.t.request(b.pk, say('x'))), 'unreachable');
    assert.equal(b.handled, handled);
    assert.equal((await b.t.request(a.pk, say('out'))).toString(), 'out');
    faults.down(b.t.address, false);
    assert.equal((await a.t.request(b.pk, say('up'))).toString(), 'up');
  });

  await check('a cut link fails in both directions, leaves every other link alone, and heals', async () => {
    const c = await host();
    for (const [x, y] of [[a, b], [b, a]]) {
      faults.cut(x.t.address, y.t.address);
      assert.equal(await code(a.t.request(b.pk, say('x'))), 'unreachable');
      assert.equal(await code(b.t.request(a.pk, say('x'))), 'unreachable');
      assert.equal((await a.t.request(c.pk, say('ac'))).toString(), 'ac');
      assert.equal((await c.t.request(b.pk, say('cb'))).toString(), 'cb');
      faults.cut(a.t.address, b.t.address, false);
      assert.equal((await a.t.request(b.pk, say('healed'))).toString(), 'healed');
      assert.equal((await b.t.request(a.pk, say('healed'))).toString(), 'healed');
    }
  });

  await check('a link cut while the peer was working loses the answer, not the work', async () => {
    const handled = b.handled;
    b.serve(async (body) => {
      faults.cut(a.t.address, b.t.address);
      return body;
    });
    assert.equal(await code(a.t.request(b.pk, say('x'))), 'unreachable');
    assert.equal(b.handled, handled + 1);
    faults.cut(a.t.address, b.t.address, false);
    b.serve(async (body) => body);
  });

  await check('a delay holds a request back, and one longer than the timeout is a timeout that never reaches the peer', async () => {
    faults.delay(120);
    let began = Date.now();
    await a.t.request(b.pk, say('x'));
    assert.ok(Date.now() - began >= 115, `${Date.now() - began} ms`);
    faults.delay(0);
    faults.delay(120, b.t.address);
    began = Date.now();
    await b.t.request(a.pk, say('x'));
    assert.ok(Date.now() - began < 100, `${Date.now() - began} ms`);
    await a.t.request(b.pk, say('x'));
    assert.ok(Date.now() - began >= 115, `${Date.now() - began} ms`);

    faults.delay(60000, b.t.address);
    const handled = b.handled;
    began = Date.now();
    assert.equal(await within(3000, code(a.t.request(b.pk, say('x'), { timeoutMs: 150 })), 'the request'), 'timeout');
    assert.ok(Date.now() - began >= 145 && Date.now() - began < 600, `${Date.now() - began} ms`);
    assert.equal(b.handled, handled);
    faults.delay(0, b.t.address);
    began = Date.now();
    await a.t.request(b.pk, say('x'));
    assert.ok(Date.now() - began < 100, `${Date.now() - began} ms`);
  });

  await check('a peer that does not answer in time is a timeout, and the request after it gets through', async () => {
    let release;
    b.serve((body) => (body.toString() === 'slow' ? new Promise((resolve) => { release = () => resolve(body); }) : body));
    const began = Date.now();
    assert.equal(await within(3000, code(a.t.request(b.pk, say('slow'), { timeoutMs: 150 })), 'the request'), 'timeout');
    assert.ok(Date.now() - began >= 145 && Date.now() - began < 600, `${Date.now() - began} ms`);
    assert.equal((await a.t.request(b.pk, say('quick'))).toString(), 'quick');
    release();
    b.serve(async (body) => body);
  });

  await check('a handler or a limit callback that throws, or an answer that is no Buffer, is http-500 and a log line', async () => {
    b.serve(async () => { throw new Error('the handler broke'); });
    assert.equal(await code(a.t.request(b.pk, say('x'))), 'http-500');
    assert.ok(b.logs.some((line) => line.includes('the handler broke')));
    b.serve(async () => 'a string');
    assert.equal(await code(a.t.request(b.pk, say('x'))), 'http-500');
    b.serve(async (body) => body);
    b.t.limitFor(() => { throw new Error('the limit broke'); });
    assert.equal(await code(a.t.request(b.pk, say('x'))), 'http-500');
    assert.ok(b.logs.some((line) => line.includes('the limit broke')));
    b.t.limitFor(() => MIB);
    assert.equal((await a.t.request(b.pk, say('fine'))).toString(), 'fine');
    await assert.rejects(a.t.request(b.pk, 'a string'), TypeError);
  });

  await check('a body over the limit is refused with 413 before any of it is read, and is not even sent', async () => {
    const c = await host();
    const p = await proxied(c);
    const options = { maxResponseBytes: 4 * MIB };
    assert.equal((await a.t.request(c.pk, Buffer.alloc(MIB, 1), options)).length, MIB);
    assert.equal(await code(a.t.request(c.pk, Buffer.alloc(MIB + 1, 1), options)), 'http-413');
    const handled = c.handled;

    // The declared length alone is refused: no byte of a body follows these headers.
    const refused = await raw(c, `POST /dn1 HTTP/1.1\r\nhost: x\r\ncontent-length: ${MIB + 1}\r\n\r\n`);
    assert.equal(refused.status, 413);
    assert.ok(refused.closed && refused.ms < 1000, `${refused.ms} ms`);

    p.bytesIn = 0;
    assert.equal(await code(a.t.request(c.pk, Buffer.alloc(3 * MIB, 1), options)), 'http-413');
    assert.ok(p.bytesIn < 4096, `${p.bytesIn} bytes of a refused body were sent`);
    assert.equal(c.handled, handled);

    c.t.limitFor((headers) => (headers['dn-ticket'] === 'held' ? 3 * MIB : 1000));
    assert.equal((await a.t.request(c.pk, Buffer.alloc(3 * MIB, 1), { ...options, headers: { 'dn-ticket': 'held' } })).length, 3 * MIB);
    assert.equal(await code(a.t.request(c.pk, Buffer.alloc(3 * MIB + 1, 1), { ...options, headers: { 'dn-ticket': 'held' } })), 'http-413');
    assert.equal((await a.t.request(c.pk, Buffer.alloc(1000, 1))).length, 1000);
    assert.equal(await code(a.t.request(c.pk, Buffer.alloc(1001, 1))), 'http-413');
  });

  await check('what a limit set aside for a request is given back once: after the answer, on a refusal, and when the body never comes', async () => {
    const c = await host({ tune: { bodyBaseMs: 200 } });
    let [held, released] = [0, 0];
    c.t.limitFor(() => {
      held += 1;
      return { bytes: 1000, release: () => { released += 1; } };
    });
    const freed = (n, what) => until(() => released === n, 2000, `the release ${what}`);
    assert.equal((await a.t.request(c.pk, Buffer.alloc(1000, 1))).length, 1000);
    await freed(1, 'after an answer');
    assert.equal(await code(a.t.request(c.pk, Buffer.alloc(1001, 1))), 'http-413');
    await freed(2, 'after a body over the limit');

    // While the handler works on the body, what was set aside for it stays so.
    let finish = null;
    c.serve(() => new Promise((resolve) => { finish = () => resolve(Buffer.from('late')); }));
    const pending = a.t.request(c.pk, say('x'));
    await until(() => finish, 2000, 'the handler');
    await sleep(300);
    assert.deepEqual([held, released], [3, 2]);
    finish();
    assert.equal((await pending).toString(), 'late');
    await freed(3, 'after a slow answer');
    c.serve(async () => { throw new Error('the handler broke'); });
    assert.equal(await code(a.t.request(c.pk, say('x'))), 'http-500');
    await freed(4, 'after a handler that threw');

    // Headers that promise a body: one that stops halfway is refused on its deadline, one
    // whose sender hangs up is over at once.
    const stalled = await raw(c, `POST /dn1 HTTP/1.1\r\nhost: x\r\ncontent-length: 500\r\n\r\nhalf`);
    assert.equal(stalled.status, 408);
    await freed(5, 'after a body that timed out');
    await raw(c, `POST /dn1 HTTP/1.1\r\nhost: x\r\ncontent-length: 500\r\n\r\nhalf`, 20);
    await freed(6, 'after a sender that hung up');
    await sleep(300);
    assert.deepEqual([held, released], [6, 6], 'once each');
  });

  await check('an answer over maxResponseBytes is too-large, whether its length was declared or not', async () => {
    b.serve(async () => Buffer.alloc(2000, 1));
    assert.equal((await a.t.request(b.pk, say('x'), { maxResponseBytes: 2000 })).length, 2000);
    assert.equal(await code(a.t.request(b.pk, say('x'), { maxResponseBytes: 1999 })), 'too-large');
    b.serve(async (body) => body);
    const chunked = await scripted(({ answer }) => answer(`7d0\r\n${'y'.repeat(2000)}\r\n0\r\n\r\n`, 'transfer-encoding: chunked\r\n'));
    assert.equal((await a.t.request(chunked.pk, say('x'), { maxResponseBytes: 2000 })).length, 2000);
    assert.equal(await within(3000, code(a.t.request(chunked.pk, say('x'), { maxResponseBytes: 1999 })), 'the request'), 'too-large');
  });

  await check('anything but POST /dn1 with a declared length is refused without waiting for a body', async () => {
    const handled = b.handled;
    const cases = [
      ['GET /dn1 HTTP/1.1\r\nhost: x\r\n\r\n', 405],
      ['PUT /dn1 HTTP/1.1\r\nhost: x\r\ncontent-length: 100000\r\n\r\n', 405],
      ['POST / HTTP/1.1\r\nhost: x\r\ncontent-length: 100000\r\n\r\n', 404],
      ['POST /dn1?x=1 HTTP/1.1\r\nhost: x\r\ncontent-length: 100000\r\n\r\n', 404],
      ['POST /dn1/ HTTP/1.1\r\nhost: x\r\ncontent-length: 2\r\n\r\n{}', 404],
      ['POST /dn1 HTTP/1.1\r\nhost: x\r\n\r\n', 411],
      ['POST /dn1 HTTP/1.1\r\nhost: x\r\ntransfer-encoding: chunked\r\n\r\n2\r\n{}\r\n0\r\n\r\n', 411],
    ];
    for (const [bytes, status] of cases) {
      const got = await raw(b, bytes);
      assert.equal(got.status, status, bytes);
      assert.ok(got.closed && got.ms < 1000, `${bytes} took ${got.ms} ms`);
      if (status === 405) assert.match(got.text, /\r\nallow: POST\r\n/i);
    }
    assert.equal((await raw(b, post('{"ok":1}'), 200)).text.split('\r\n\r\n')[1], '{"ok":1}');
    assert.equal(b.handled, handled + 1);
  });

  await check('headers over the size limit are refused', async () => {
    const got = await raw(b, post('{}', `x-pad: ${'p'.repeat(9000)}\r\n`));
    assert.equal(got.status, 431);
    assert.ok(got.closed);
    assert.equal((await raw(b, post('{}', `x-pad: ${'p'.repeat(7000)}\r\n`), 200)).status, 200);
  });

  await check('a connection that sends nothing, or stalls in its headers or its body, is cut off', async () => {
    const c = await host({ tune: { headersTimeoutMs: 200, bodyBaseMs: 200 } });
    const [silent, headers, body] = await Promise.all([
      raw(c, ''),
      raw(c, 'POST /dn1 HTTP/1.1\r\nhost: x\r\ncontent-le'),
      raw(c, 'POST /dn1 HTTP/1.1\r\nhost: x\r\ncontent-length: 10\r\n\r\n{"a'),
    ]);
    for (const got of [silent, headers, body]) {
      assert.ok(got.closed, 'the connection was left open');
      assert.ok(got.ms >= 150 && got.ms < 1500, `${got.ms} ms`);
      assert.equal(got.status, 408);
    }
    assert.equal(c.handled, 0);
    // The deadline of a body grows with its declared length: this one has the time.
    c.t.limitFor(() => 64 * MIB);
    const slow = raw(c, `POST /dn1 HTTP/1.1\r\nhost: x\r\ncontent-length: ${32 * MIB}\r\n\r\n{"a`, 600);
    assert.equal((await slow).closed, false);
  });

  await check('connections over the cap are dropped unanswered, and idle ones give way to the next', async () => {
    const c = await host({ tune: { maxConnections: 3 } });
    const idle = await Promise.all([keptOpen(c), keptOpen(c), keptOpen(c)]);
    const dropped = await raw(c, post('{}'));
    assert.ok(dropped.closed);
    assert.equal(dropped.text, '');
    await until(() => idle.every((k) => k.closed), 2000, 'the idle connections giving way');
    assert.equal((await a.t.request(c.pk, say('room'))).toString(), 'room');

    // Connections with a request in progress are not idle: they stay, the newcomer goes.
    const releases = [];
    c.serve((body) => new Promise((resolve) => { releases.push(() => resolve(body)); }));
    const busy = [0, 1, 2].map((i) => a.t.request(c.pk, say(`busy ${i}`)));
    await until(() => releases.length === 3, 2000, 'three requests in progress');
    const refused = await raw(c, post('{}'));
    assert.ok(refused.closed);
    assert.equal(refused.text, '');
    for (const release of releases) release();
    assert.deepEqual((await Promise.all(busy)).map(String), ['busy 0', 'busy 1', 'busy 2']);
  });

  await check('a connection that opens and closes at once is not worth a log line', async () => {
    const lines = b.logs.length;
    await Promise.all(Array.from({ length: 20 }, () => new Promise((resolve) => {
      const socket = net.connect({ host: '127.0.0.1', port: b.port }, () => socket.destroy());
      socket.on('close', resolve);
    })));
    await raw(b, 'POST /dn1 HTT', 50);
    assert.equal((await a.t.request(b.pk, say('still here'))).toString(), 'still here');
    assert.deepEqual(b.logs.slice(lines), []);
  });

  await check('a host in another process is reached through the directory and cut off through it', async () => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', `
      import { createTransport } from ${JSON.stringify(new URL('../src/transport/index.js', import.meta.url).href)};
      import { generateIdentity } from ${JSON.stringify(new URL('../src/core/identity.js', import.meta.url).href)};
      const identity = generateIdentity();
      const t = createTransport({ kind: 'loop', identity, dir: ${JSON.stringify(dir)} });
      t.onRequest(async (body) => Buffer.from('pid ' + process.pid + ' got ' + body));
      await t.start();
      console.log(identity.pk);
    `], { stdio: ['ignore', 'pipe', 'inherit'] });
    children.add(child);
    let out = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    const pk = (await until(() => out.includes('\n') && out, 5000, 'the other process starting')).trim();
    assert.equal((await a.t.request(pk, say('hello'))).toString(), `pid ${child.pid} got hello`);
    faults.cut(onionAddress(pk), a.t.address);
    assert.equal(await code(a.t.request(pk, say('hello'))), 'unreachable');
    faults.cut(onionAddress(pk), a.t.address, false);
    assert.equal((await a.t.request(pk, say('again'))).toString(), `pid ${child.pid} got again`);
    child.kill('SIGKILL');
    await until(() => child.exitCode !== null || child.signalCode !== null, 2000, 'the other process ending');
    children.delete(child);
    // Its address outlives it; nothing listens there.
    assert.equal(await code(a.t.request(pk, say('hello'))), 'unreachable');
  });

  await check('a peer that stops while a request is with it is unreachable', async () => {
    const c = await host();
    c.serve(() => new Promise(() => {}));
    const lost = code(a.t.request(c.pk, say('x')));
    await until(() => c.handled === 1, 2000, 'the request arriving');
    await c.t.stop();
    assert.equal(await within(3000, lost, 'the request'), 'unreachable');
  });

  await check('stop fails what is in flight with stopped, withdraws the address and closes the listener', async () => {
    const c = await host();
    b.serve(() => new Promise(() => {}));
    const handled = b.handled;
    const inFlight = code(c.t.request(b.pk, say('x')));
    faults.delay(60000, a.t.address);
    const held = code(c.t.request(a.pk, say('x')));
    await until(() => b.handled === handled + 1, 2000, 'the request arriving');
    await c.t.stop();
    faults.delay(0, a.t.address);
    assert.equal(await within(3000, inFlight, 'the request in flight'), 'stopped');
    assert.equal(await within(3000, held, 'the delayed request'), 'stopped');
    assert.equal(await code(c.t.request(b.pk, say('x'))), 'stopped');
    assert.deepEqual(c.t.state(), { state: 'failed', detail: 'loop (test transport): stopped' });
    assert.equal(fs.existsSync(path.join(dir, `${c.t.address}.addr`)), false);
    assert.equal(await code(a.t.request(c.pk, say('x'))), 'unreachable');
    assert.equal((await raw(c, post('{}'))).text, '');
    await c.t.stop();
    await assert.rejects(c.t.start(), /starts once/);
    b.serve(async (body) => body);
  });

  await check('every state change reaches the watchers, and a kind nobody knows is refused', async () => {
    const identity = generateIdentity();
    const t = createTransport({ kind: 'loop', identity, dir });
    const seen = [];
    t.onState((s) => { throw new Error(`a watcher that throws: ${s.state}`); });
    t.onState((s) => seen.push(s));
    assert.deepEqual(t.state(), { state: 'starting', detail: 'loop (test transport): not started' });
    await t.start();
    await t.stop();
    assert.deepEqual(seen.map((s) => s.state), ['ready', 'failed']);
    assert.throws(() => createTransport({ kind: 'carrier-pigeon', identity, dir }), TypeError);
  });
} catch (err) {
  console.error(err);
  process.exitCode = 1;
} finally {
  await Promise.all(hosts.map((h) => h.t.stop()));
  for (const server of servers) {
    server.close();
    server.closeAllConnections?.();
  }
  cleanup();
}

// Every transport is stopped: a timer or socket any of them left would keep this process
// alive, and the watchdog below says so instead of letting the run hang.
setTimeout(() => {
  console.error('FAIL something a stopped transport left keeps the event loop alive:', process.getActiveResourcesInfo());
  process.exit(1);
}, 5000).unref();
process.once('beforeExit', () => {
  if (!process.exitCode) console.log('PASS nothing a stopped transport left keeps the event loop alive');
});
