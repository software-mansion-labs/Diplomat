// The feed between a connection and node's http parser: where a request head ends,
// that the parser is handed one head at a time whatever the bytes and however they
// arrive and no more than one in a turn of the event loop, that a stopped feed hands
// nothing on whoever resumes it, and that all feeds together use a bounded slice of each
// turn.
// Run: node test/executor-feed.mjs

import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { Duplex, PassThrough } from 'node:stream';
import { createFeeder, edgeAfter, headEnd, FEED_TURN_MS } from '../src/executor/feed.js';

let checks = 0;
const check = async (name, fn) => { await fn(); checks++; console.log(`PASS ${name}`); };
const until = async (met, what, ms = 30000) => {
  for (const end = Date.now() + ms; !met();) {
    if (Date.now() > end) throw new Error(`never: ${what}`);
    await new Promise((r) => setTimeout(r, 2));
  }
};
// `event` of `emitter`, waited for no longer than a check may hang.
const once = (emitter, event, what, ms = 30000) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`never: ${what}`)), ms);
  emitter.once(event, () => { clearTimeout(timer); resolve(); });
});
const turns = async (n) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
const bytes = (text) => Buffer.from(text, 'latin1');

// Where empty lines end in `stream`, found the plain way: every offset just past a line
// feed that follows a line feed, with or without a carriage return between the two.
function emptyLines(stream) {
  const ends = [];
  for (let i = 1; i < stream.length; i++) {
    if (stream[i] !== 10) continue;
    if (stream[i - 1] === 10 || (stream[i - 1] === 13 && i >= 2 && stream[i - 2] === 10)) ends.push(i + 1);
  }
  return ends;
}

// A connected pair of sockets: `far` is the side a feed reads.
function pair() {
  return new Promise((resolve) => {
    let near;
    const server = net.createServer({ allowHalfOpen: true }, (far) => {
      server.close();
      far.on('error', () => {});
      resolve({ near, far });
    });
    server.listen(0, '127.0.0.1', () => {
      near = net.connect(server.address().port, '127.0.0.1');
      near.on('error', () => {});
    });
  });
}

let seed = 20261117;
const random = (n) => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed % n;
};

await check('a head ends past the first empty line, however its lines end, and nowhere else', () => {
  assert.equal(FEED_TURN_MS, 4);
  const cases = [
    ['GET / HTTP/1.1\r\n\r\n', 18], ['GET / HTTP/1.1\r\nHost: x\r\n\r\nGET', 27], ['GET / HTTP/1.1\n\n', 16], ['a\n\r\nb', 4],
    ['\r\n\r\n', 4], ['\n\n', 2], ['GET / HTTP/1.1\r\nHost: x\r\n', -1], ['', -1], ['\n', -1], ['\r\n', -1], ['a\n\r', -1], ['a\r\r\n\r', -1], ['a\nb\nc\n\rd\n', -1],
    ['a\n\rb\n\n', 6],
  ];
  for (const [text, end] of cases) assert.equal(headEnd(bytes(text)), end, JSON.stringify(text));
  // An empty line that lies across two reads.
  for (const [edge, text, end] of [[1, '\nrest', 1], [1, '\r\nrest', 2], [2, '\nrest', 1], [0, '\nrest', -1], [0, '\r\nrest', -1], [2, '\r\nrest', -1], [1, '\r', -1], [1, 'x\n\n', 3], [2, 'x\r\n\r\n', 5]]) {
    assert.equal(headEnd(bytes(text), edge), end, `${edge} ${JSON.stringify(text)}`);
  }
  for (const [edge, text, after] of [[0, 'a\n', 1], [0, 'a\n\r', 2], [1, '\r', 2], [0, '\r', 0], [2, '\r', 0], [1, 'a', 0], [1, 'a\r', 0], [2, '\n', 1], [0, 'a\r\n', 1], [1, 'ab', 0], [0, '\n\ra', 0]]) {
    assert.equal(edgeAfter(bytes(text), edge), after, `${edge} ${JSON.stringify(text)}`);
  }
});

await check('whatever the bytes and wherever they are split, no piece reaches past the end of the first head that ends in it', async () => {
  const feed = createFeeder();
  const parts = ['GET / HTTP/1.1\r\n\r\n', 'GET /a HTTP/1.1\r\nHost: x\r\n\r\n', 'POST /b HTTP/1.1\r\nContent-Length: 12\r\n\r\nab\r\n\r\ncd\n\nef', '\n\n', '\r\n\r\n', '\n\r\n', 'x\n\ry\n', '\r', '\n', 'plain bytes with no line at all'];
  for (let round = 0; round < 60; round++) {
    const stream = bytes(Array.from({ length: 40 }, () => parts[random(parts.length)]).join(''));
    const ends = new Set(emptyLines(stream));
    const source = new PassThrough();
    const got = [];
    const out = feed(source);
    out.on('data', (piece) => got.push(piece));
    for (let at = 0; at < stream.length;) {
      const size = 1 + random(round % 3 === 0 ? 3 : 90);
      source.write(stream.subarray(at, at + size));
      at += size;
      if (random(4) === 0) await turns(1);
    }
    await until(() => Buffer.concat(got).length === stream.length, 'every byte to be handed on');
    assert.deepEqual(Buffer.concat(got), stream, 'the bytes, in their order');
    let at = 0;
    for (const piece of got) {
      const inside = [...ends].filter((end) => end > at && end <= at + piece.length);
      assert.ok(inside.length === 0 || (inside.length === 1 && inside[0] === at + piece.length), `a piece of ${piece.length} bytes at ${at} holds the head ends ${inside}`);
      at += piece.length;
    }
    out.destroy();
  }
});

await check('a stopped feed hands nothing on, whoever resumes it, and a started one is as its reader last asked', async () => {
  const feed = createFeeder();
  const source = new PassThrough();
  const out = feed(source);
  const got = [];
  let onPiece = () => { if (got.length === 2) out.pause(); };
  out.on('data', (piece) => { got.push(String(piece)); onPiece(); });
  const settle = async () => { await new Promise((r) => setTimeout(r, 30)); await turns(5); };
  source.write('a\n\nb\n\nc\n\nd\n\ne\n\nf\n\n');
  await until(() => got.length === 2, 'two pieces to be handed on');
  await settle();
  assert.deepEqual(got, ['a\n\n', 'b\n\n'], 'a paused feed hands nothing on');
  // A stop and its end leave a feed its reader paused as it was.
  out.stop();
  out.start();
  await settle();
  assert.equal(got.length, 2, 'starting a feed does not undo its reader\'s pause');
  // A stream that is resumed flows at once and says so a tick later: a stopped feed
  // does not flow at all, and takes the resume as a wish.
  out.stop();
  out.resume();
  out.stop();
  await settle();
  assert.equal(got.length, 2, 'resumed while stopped, it hands nothing on');
  onPiece = () => { if (got.length === 4) out.stop(); };
  out.start();
  await until(() => got.length === 4, 'the feed to flow, as its reader asked, once it is started');
  await settle();
  assert.equal(got.length, 4, 'stopped over the fourth piece, it has handed on no fifth');
  // A reader that pauses it while it is stopped has withdrawn the wish.
  out.resume();
  out.pause();
  out.start();
  await settle();
  assert.equal(got.length, 4);
  onPiece = () => {};
  out.resume();
  await until(() => got.length === 6, 'the rest to be handed on');
  assert.deepEqual(got, ['a\n\n', 'b\n\n', 'c\n\n', 'd\n\n', 'e\n\n', 'f\n\n']);
  out.destroy();
});

await check('node is handed one request at a time: a connection stopped or closed over one request, or one whose request was its last, has no other read', async () => {
  const feed = createFeeder();
  const seen = [];
  let onRequest = () => {};
  const engine = http.createServer((req, res) => { seen.push(req.url); onRequest(req, res); });
  const flood = bytes(Array.from({ length: 3000 }, (_, i) => `GET /${i} HTTP/1.1\r\nHost: x\r\n\r\n`).join(''));
  const open = async () => {
    const { near, far } = await pair();
    const out = feed(far);
    engine.emit('connection', out);
    return { near, far, out };
  };
  const settle = async () => { await new Promise((r) => setTimeout(r, 100)); await turns(5); };

  // Stopped: node resumes a connection by itself, for the body of a request and after
  // one, and so does this reader.
  let c = await open();
  const stopped = c.out;
  onRequest = (req) => {
    if (req.url === '/3') stopped.stop();
    req.resume();
    req.socket.resume();
  };
  c.near.write(flood);
  await until(() => seen.includes('/3'), 'the fourth request to be read');
  await settle();
  assert.deepEqual(seen, ['/0', '/1', '/2', '/3'], 'not one request past the stop, whoever resumes');
  onRequest = (req) => { if (req.url === '/6') stopped.stop(); };
  stopped.start();
  await until(() => seen.includes('/6'), 'the feed to go on once it is started');
  await settle();
  assert.deepEqual(seen, ['/0', '/1', '/2', '/3', '/4', '/5', '/6']);
  // A connection that is not read is not seen to close either.
  c.out.destroy();
  c.near.destroy();

  // The last: a connection that is to have no request after this one.
  seen.length = 0;
  c = await open();
  let answered = '';
  c.near.on('data', (d) => { answered += d; });
  onRequest = (req, res) => {
    if (req.url === '/1') {
      req.socket.last();
      res.writeHead(407, { 'content-length': 0, connection: 'close' });
    }
    res.end();
  };
  const closedAfter = new Promise((r) => { c.near.on('close', r); });
  c.near.write(flood);
  await closedAfter;
  await settle();
  assert.deepEqual(seen, ['/0', '/1'], 'nothing is read after the request that was called the last');
  assert.deepEqual([...answered.matchAll(/HTTP\/1\.1 (\d{3})/g)].map((m) => m[1]), ['200', '407'], 'and its answer goes out behind the one before it');

  // Closed.
  seen.length = 0;
  c = await open();
  const closed = new Promise((r) => { c.near.on('close', r); });
  onRequest = (req) => { if (req.url === '/2') req.socket.destroy(); };
  c.near.write(flood);
  await closed;
  await settle();
  assert.deepEqual(seen, ['/0', '/1', '/2']);
  assert.equal(c.far.destroyed, true, 'closing the feed closes the connection it reads');
});

await check('a feed is a connection to node\'s server: answers go out in order, bodies come in whole, and its silence is timed by the socket under it', async () => {
  const feed = createFeeder();
  const engine = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (d) => chunks.push(d));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      res.writeHead(200, { 'content-length': body.length + req.url.length });
      res.end(Buffer.concat([bytes(req.url), body]));
    });
  });
  const { near, far } = await pair();
  // Bytes read off the connection before the feed had it come first.
  const first = bytes('POST /first HTTP/1.1\r\nHost: x\r\nContent-Length: 5\r\n\r\nhe');
  const out = feed(far, first);
  engine.emit('connection', out);
  const big = Buffer.alloc(300000, 'b');
  near.write('llo');
  near.write(`POST /big HTTP/1.1\r\nHost: x\r\nContent-Length: ${big.length}\r\n\r\n`);
  near.write(big);
  near.write('GET /last HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n');
  const got = [];
  near.on('data', (d) => got.push(d));
  await once(near, 'end', 'the connection to be ended after its last answer');
  const text = Buffer.concat(got).toString('latin1');
  const bodies = text.split(/HTTP\/1\.1 200 OK\r\n(?:[^\r]+\r\n)*\r\n/).slice(1);
  assert.deepEqual(bodies.map((b) => (b.length > 40 ? `${b.slice(0, 4)}+${b.length - 4}` : b)), ['/firsthello', '/big+300000', '/last']);
  await until(() => far.destroyed && out.destroyed, 'the connection to be closed after its last answer, as a socket is');
  near.destroy();

  // A client that ends its side is seen to: node closes the connection, as it does a socket.
  const leaving = await pair();
  engine.emit('connection', feed(leaving.far));
  let heard = '';
  leaving.near.on('data', (d) => { heard += d; });
  leaving.near.write('GET /leaving HTTP/1.1\r\nHost: x\r\n\r\n');
  await until(() => heard.endsWith('/leaving'), 'its request to be answered');
  leaving.near.end();
  await once(leaving.near, 'close', 'the connection of a client that ended its side to be closed');
  assert.equal(leaving.far.destroyed, true);

  // Ending a feed ends its side of the connection, once what was written has gone.
  const half = await pair();
  const ending = feed(half.far);
  let last = '';
  let heardEnd = false;
  half.near.on('data', (d) => { last += d; }).on('end', () => { heardEnd = true; });
  ending.end('the last of it');
  await until(() => heardEnd, 'the other side to read the end');
  assert.equal(last, 'the last of it');
  ending.destroy();
  half.near.destroy();

  // A feed whose reader took one piece and asks for no other has read its connection
  // once: the rest stays with its sender.
  const full = await pair();
  const unread = feed(full.far);
  for (let i = 0; i < 128; i++) full.near.write(Buffer.alloc(65536, 'u'));
  unread.read(0);
  await until(() => unread.readableLength > 0, 'a piece to be handed on');
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(full.far.bytesRead <= 2 ** 20, `${full.far.bytesRead} bytes were read off a connection nobody reads`);
  unread.destroy();
  full.near.destroy();

  // What is written in one go reaches the connection in one go.
  const batches = [];
  const sink = new Duplex({ read() {}, write(chunk, encoding, done) { batches.push([String(chunk)]); done(); }, writev(chunks, done) { batches.push(chunks.map(({ chunk }) => String(chunk))); done(); } });
  const corked = feed(sink);
  corked.cork();
  corked.write('a head\r\n\r\n');
  corked.write('and its body');
  corked.uncork();
  await until(() => batches.flat().length === 2, 'both to be written');
  assert.deepEqual(batches, [['a head\r\n\r\n', 'and its body']]);
  corked.destroy();

  // The time a connection may stay silent.
  const quiet = await pair();
  const timed = feed(quiet.far);
  let fired = 0;
  timed.setTimeout(60, () => { fired += 1; });
  await until(() => fired === 1, 'the feed to be told of its connection\'s silence');
  timed.destroy();
  await until(() => quiet.far.destroyed, 'the connection to close with its feed');
  quiet.near.destroy();
});

await check('the feeds of one feeder hand over what fits a slice of a turn, and the rest in the turns after, each in its order', async () => {
  // A clock that moves one millisecond for every look at it.
  let clock = 0;
  const feed = createFeeder({ turnMs: 10, now: () => { clock += 1; return clock; } });
  const perTurn = [];
  let turn = 0;
  const tick = () => { turn += 1; if (turn < 200) setImmediate(tick); };
  const sources = [new PassThrough(), new PassThrough(), new PassThrough()];
  const got = sources.map(() => []);
  const outs = sources.map((source, i) => {
    const out = feed(source);
    out.on('data', (piece) => { got[i].push(String(piece)); perTurn[turn] = (perTurn[turn] ?? 0) + 1; });
    return out;
  });
  await turns(3);
  const lines = (i) => Array.from({ length: 50 }, (_, k) => `${i}:${k}\n\n`);
  setImmediate(tick);
  await new Promise((r) => setImmediate(r));
  sources.forEach((source, i) => source.write(lines(i).join('')));
  await until(() => got.every((g) => g.length === 50), 'every piece to be handed on');
  got.forEach((g, i) => assert.deepEqual(g, lines(i)));
  const most = Math.max(...perTurn.filter((n) => n !== undefined));
  assert.ok(most <= 10, `${most} pieces were handed over in one turn of a feeder whose slice is ten looks at the clock`);
  assert.ok(perTurn.filter((n) => n !== undefined).length >= 15, 'so 150 pieces took fifteen turns or more');
  // A feed that is closed while it waits for its turn is not handed anything.
  const late = new PassThrough();
  const never = feed(late);
  const seenLate = [];
  never.on('data', (p) => seenLate.push(p));
  await turns(3);
  sources[0].write('x\n\n'.repeat(30));
  late.write('y\n\n'.repeat(5));
  never.destroy();
  await until(() => got[0].length === 80, 'the other feed to go on');
  assert.ok(seenLate.length <= 1, 'nothing after it was closed');
  for (const out of outs) out.destroy();
});

await check('a connection is handed one request head a turn, so one that node answers and closes has had no second request read', async () => {
  const feed = createFeeder();
  let turn = 0;
  let ticking = true;
  const tick = () => { turn += 1; if (ticking) setImmediate(tick); };
  setImmediate(tick);
  // Two connections, each with thirty heads waiting: each is handed one in a turn.
  const sources = [new PassThrough(), new PassThrough()];
  const headsIn = sources.map(() => new Map());
  const got = sources.map(() => []);
  const outs = sources.map((source, i) => {
    const out = feed(source);
    out.on('data', (piece) => {
      got[i].push(String(piece));
      if (String(piece).endsWith('\n\n')) headsIn[i].set(turn, (headsIn[i].get(turn) ?? 0) + 1);
    });
    return out;
  });
  // A head that comes in three parts is three pieces, and the first two wait for no turn.
  sources[0].write('a: 1\n');
  await until(() => got[0].length === 1, 'the first part');
  sources[0].write('b: 2\n');
  await until(() => got[0].length === 2, 'the second part');
  assert.deepEqual(got[0], ['a: 1\n', 'b: 2\n']);
  sources[0].write(`\n${'0\n\n'.repeat(30)}`);
  sources[1].write('1\n\n'.repeat(31));
  await until(() => got[0].join('').length === 101 && got[1].join('').length === 93, 'every head to be handed on');
  // This check's turns and the feeder's begin at different points of the loop's, so one
  // of these may see the head of two of those.
  for (const perTurn of headsIn) {
    assert.ok(Math.max(...perTurn.values()) <= 2, `${Math.max(...perTurn.values())} heads were handed to one connection between two turns of the loop`);
    assert.ok(perTurn.size >= 16, `thirty-one heads took ${perTurn.size} turns`);
  }
  for (const out of outs) out.destroy();

  // Node answers a request that names no host itself, and closes the connection: by
  // then it has been handed that request and no other, of the 3000 that had come.
  const engine = http.createServer(() => assert.fail('a request without a host is not the handler\'s'));
  const { near, far } = await pair();
  const out = feed(far);
  const handed = [];
  const { push } = out;
  out.push = (piece) => { if (piece) handed.push(String(piece)); return push.call(out, piece); };
  engine.emit('connection', out);
  let answered = '';
  near.on('data', (d) => { answered += d; });
  const closed = new Promise((r) => { near.on('close', r); });
  near.write('GET / HTTP/1.1\r\n\r\n'.repeat(3000));
  await closed;
  ticking = false;
  assert.deepEqual(handed, ['GET / HTTP/1.1\r\n\r\n']);
  assert.deepEqual([...answered.matchAll(/HTTP\/1\.1 (\d{3})/g)].map((m) => m[1]), ['400']);
});

console.log(`\nall ${checks} checks passed`);
