// The relay of a job container, run here as the process it is in its container: where
// it listens, that it carries every connection to the one address it was started with
// in the hop's frames, each way's end on its own, how many it carries at a time, and how
// many new ones in a second.
// Run: node test/executor-relay.mjs

import assert from 'node:assert/strict';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ACK, ASK, CREDIT, DATA, END, PREFACE, createHop } from '../src/executor/hop.js';

const RELAY = fileURLToPath(new URL('../image/relay.mjs', import.meta.url));
// What relay.mjs carries: so many at a time, so many at once, so many more a second.
const AT_A_TIME = 1024;
const BURST = 256;
const PER_SECOND = 64;

let checks = 0;
const check = async (name, fn) => { await fn(); checks++; console.log(`PASS ${name}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (what, met, ms = 120000) => {
  for (const end = Date.now() + ms; !met();) {
    if (Date.now() > end) assert.fail(`never: ${what}`);
    await sleep(5);
  }
};
const listening = (server) => new Promise((resolve) => { server.listen(0, '127.0.0.1', () => resolve(server.address().port)); });
const within = (promise, what, ms = 10000) => {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`never: ${what}`)), ms); })]).finally(() => clearTimeout(timer));
};
async function freePort() {
  const free = net.createServer();
  const port = await listening(free);
  await new Promise((r) => free.close(r));
  return port;
}

// A relay for 127.0.0.0/8, which this machine has an address in, to `target`:
// `{ port, relay, said, dial(), end() }`. `dial()` resolves to a connection once the
// relay's machine has taken it, which is before the relay carries it.
async function startRelay(target) {
  const port = await freePort();
  const relay = spawn(process.execPath, [RELAY, '127.0.0.0/8', String(port), '127.0.0.1', String(target.address().port)], { stdio: ['ignore', 'pipe', 'pipe'] });
  const said = await new Promise((resolve) => relay.stdout.once('data', (d) => resolve(String(d).trim())));
  const clients = [];
  const dial = () => new Promise((resolve, reject) => {
    const c = net.connect(port, '127.0.0.1', () => resolve(c));
    c.once('error', reject);
    c.on('error', () => {});
    clients.push(c);
  });
  const end = () => {
    for (const c of clients) c.destroy();
    relay.kill('SIGKILL');
    target.close();
  };
  return { port, relay, said, dial, clients, end };
}

// A broker's end of the hop: what the relay carries, as the bytes the frames hold.
const hop = createHop();
const framed = (fn) => (c) => { c.on('error', () => {}); fn(hop.framed(c), c); };

await check('a relay carries what it is sent to the one address it was started with, whatever a client asks of it', async () => {
  const seen = [];
  const target = net.createServer(framed((link) => link.on('data', (d) => { seen.push(String(d)); link.write('from the broker'); }).on('error', () => {})));
  await listening(target);
  const r = await startRelay(target);
  try {
    assert.equal(r.said, `relay: 127.0.0.1:${r.port} -> 127.0.0.1:${target.address().port}`, 'it listens on its address in the job network and on no other');
    const asked = 'CONNECT elsewhere.example:443 HTTP/1.1\r\nHost: elsewhere.example:443\r\n\r\n';
    const c = await r.dial();
    const answer = new Promise((resolve, reject) => {
      c.on('data', (d) => resolve(String(d)));
      c.on('close', () => reject(new Error('the relay closed the connection without an answer')));
      c.setTimeout(60000, () => c.destroy(new Error('the relay gave no answer')));
    });
    c.write(asked);
    assert.equal(await answer, 'from the broker');
    assert.deepEqual(seen, [asked], 'word for word, to the broker');
  } finally { r.end(); }
  // In a container with no address on the network it was told to serve, it serves nothing.
  const none = spawn(process.execPath, [RELAY, '203.0.113.0/24', String(r.port), '127.0.0.1', '1'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  none.stderr.on('data', (d) => { err += d; });
  assert.equal(await new Promise((resolve) => none.on('close', resolve)), 1);
  assert.match(err, /no address in 203\.0\.113\.0\/24/);
});

await check('a relay carries so many new connections at once and so many more a second, in the order they came, and what it kept back while it was idle is no more than that', async () => {
  // What reaches the broker: the number each connection wrote, in the order the
  // connections arrived, each a round trip of the hop before what it wrote.
  const reached = [];
  const target = net.createServer(framed((link) => {
    const at = reached.push(undefined) - 1;
    link.once('data', (d) => { reached[at] = Number(d); }).on('error', () => {});
  }));
  await listening(target);
  const r = await startRelay(target);
  // The most that can have been carried since `from`, when `had` could be carried at once.
  const most = (had, from) => had + Math.ceil((Date.now() - from) * PER_SECOND / 1000) + 1;
  try {
    const started = Date.now();
    for (let i = 0; i < 400; i++) (await r.dial()).write(String(i));
    const dialled = Date.now();
    await until('as many as are carried at once to reach the broker', () => reached.length >= BURST);
    assert.ok(Date.now() - dialled < 1000, `${BURST} had reached the broker ${Date.now() - dialled} ms after the last of 400 was opened`);
    assert.ok(reached.length <= most(BURST, started), `${reached.length} reached the broker within ${Date.now() - started} ms`);
    await sleep(500);
    assert.ok(reached.length <= most(BURST, started), `${reached.length} reached the broker within ${Date.now() - started} ms`);
    assert.ok(reached.length < 400, 'the rest wait');
    await until('every one of them to reach the broker', () => reached.length === 400 && !reached.includes(undefined));
    const took = Date.now() - started;
    assert.ok(took >= (400 - BURST - 1) * 1000 / PER_SECOND, `400 connections were carried in ${took} ms`);
    assert.ok(took - (dialled - started) <= (400 - BURST) * 1000 / PER_SECOND * 1.5 + 500, `the ones that waited were carried within ${took - (dialled - started)} ms of the last being opened`);
    assert.deepEqual([...reached.slice(0, BURST)].sort((a, b) => a - b), Array.from({ length: BURST }, (_, i) => i), 'the first of them at once');
    assert.deepEqual(reached.slice(BURST), Array.from({ length: 400 - BURST }, (_, i) => BURST + i), 'the ones that waited in the order they came');
    // Five idle seconds would be 320 connections' worth: 256 is what a relay keeps back.
    for (const c of r.clients.splice(0)) c.destroy();
    reached.length = 0;
    await sleep(5000);
    const again = Date.now();
    for (let i = 0; i < 330; i++) (await r.dial()).write(String(i));
    await until('as many as are carried at once to reach the broker again', () => reached.length >= BURST);
    assert.ok(reached.length <= most(BURST, again), `${reached.length} reached the broker within ${Date.now() - again} ms of five idle seconds`);
    await until('the rest to follow', () => reached.length === 330);
    assert.ok(Date.now() - again >= (330 - BURST - 1) * 1000 / PER_SECOND);
    assert.equal(r.relay.exitCode, null, 'the relay is still there');
  } finally { r.end(); }
});

await check('a relay reads nothing of a connection that waits its turn: one that was reset meanwhile leaves nothing open at the broker', async () => {
  const open = new Set();
  const target = net.createServer((c) => { open.add(c); c.on('close', () => open.delete(c)).on('error', () => {}).resume(); });
  await listening(target);
  const r = await startRelay(target);
  try {
    for (let i = 0; i < BURST; i++) await r.dial();
    await until('as many as are carried at once to reach the broker', () => open.size === BURST);
    for (let i = 0; i < 16; i++) {
      const c = await r.dial();
      c.write('sent before its turn');
      c.resetAndDestroy();
    }
    // Their turns come within a quarter of a second.
    await sleep(1500);
    assert.equal(open.size, BURST, 'the broker holds the connections that are still there, and none of those that went');
  } finally { r.end(); }
});

await check('a relay carries 1024 connections at a time and drops the next, and one that cannot listen says so and exits 1', async () => {
  const reached = new Set();
  // A broker that ends each connection as its client does.
  const target = net.createServer(framed((link, c) => {
    reached.add(c);
    c.on('close', () => reached.delete(c));
    link.on('end', () => link.end()).on('error', () => {}).resume();
  }));
  await listening(target);
  const r = await startRelay(target);
  try {
    for (let i = 0; i < AT_A_TIME; i++) await r.dial();
    await until('every one of them to reach the broker', () => reached.size === AT_A_TIME);
    const extra = await r.dial();
    let closed = false;
    extra.on('close', () => { closed = true; });
    await until('the connection past the bound to be dropped', () => closed);
    assert.equal(reached.size, AT_A_TIME, 'and it never reached the broker');
    r.clients[0].destroy();
    await until('a closed connection to be given back', () => reached.size === AT_A_TIME - 1);
    await r.dial();
    await until('the place it left to be had again', () => reached.size === AT_A_TIME);
    assert.equal(r.relay.exitCode, null, 'the relay is still there');
  } finally { r.end(); }
  // A port that is taken: said, and an exit a restart policy sees.
  const taken = net.createServer();
  const second = spawn(process.execPath, [RELAY, '127.0.0.0/8', String(await listening(taken)), '127.0.0.1', '1'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  second.stderr.on('data', (d) => { err += d; });
  assert.equal(await new Promise((resolve) => second.on('close', resolve)), 1);
  assert.match(err, /^relay: listen EADDRINUSE/);
  taken.close();
});

await check('a relay sends the broker no more of a connection than the broker made room for, asks for room for the rest, and tells the broker what of its bytes the client\'s socket took', async () => {
  // The frames that reach the broker, read here by hand: [type, length, bytes].
  const frames = [];
  let hopEnd = null;
  const target = net.createServer((c) => {
    hopEnd = c;
    c.on('error', () => {});
    let buf = Buffer.alloc(0);
    c.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (frames.length === 0) {
        if (buf.length < PREFACE.length) return;
        assert.deepEqual(buf.subarray(0, PREFACE.length), PREFACE, 'it opens with the preface');
        frames.push(['preface']);
        buf = buf.subarray(PREFACE.length);
      }
      while (buf.length >= 5) {
        const n = buf.readUInt32BE(1);
        const size = buf[0] === DATA ? 5 + n : 5;
        if (buf.length < size) return;
        frames.push([buf[0], n, buf[0] === DATA ? String(buf.subarray(5, size)) : '']);
        buf = buf.subarray(size);
      }
    });
  });
  await listening(target);
  const r = await startRelay(target);
  const frame = (type, n, payload = Buffer.alloc(0)) => {
    const head = Buffer.alloc(5);
    head[0] = type;
    head.writeUInt32BE(n, 1);
    hopEnd.write(Buffer.concat([head, payload]));
  };
  const sent = (type) => frames.filter((f) => f[0] === type);
  try {
    const c = await r.dial();
    let got = '';
    let ended = false;
    c.on('data', (d) => { got += d; });
    c.on('end', () => { ended = true; });
    c.write('x'.repeat(5000));
    await until('the relay to ask for room', () => sent(ASK).length === 1);
    assert.deepEqual(sent(ASK)[0].slice(0, 2), [ASK, 5000], 'for the 5000 bytes it holds');
    assert.equal(sent(DATA).length, 0, 'and sends none of them before it has it');
    frame(CREDIT, 1200);
    await until('as much as it was given room for', () => sent(DATA).length === 1 && sent(ASK).length === 2);
    assert.deepEqual(sent(DATA)[0].slice(0, 2), [DATA, 1200]);
    assert.deepEqual(sent(ASK)[1].slice(0, 2), [ASK, 3800], 'and asks for room for the rest');
    frame(CREDIT, 3800);
    await until('the rest', () => sent(DATA).length === 2);
    assert.equal(sent(DATA).map((f) => f[2]).join(''), 'x'.repeat(5000), 'word for word');
    frame(DATA, 5, Buffer.from('hello'));
    await until('the client to have the broker\'s bytes', () => got === 'hello');
    await until('the broker to be told of them', () => sent(ACK).length === 1);
    assert.deepEqual(sent(ACK)[0].slice(0, 2), [ACK, 5]);
    frame(END, 0);
    await until('the client to see the end of what the broker sends', () => ended);
    c.end();
    await until('the broker to be told the client ended', () => sent(END).length === 1);
    assert.deepEqual(frames.map((f) => f[0]), ['preface', ASK, DATA, ASK, DATA, ACK, END], 'and nothing else');
  } finally { r.end(); }
});

await check('a relay tells the broker of no more of its bytes than the client\'s socket took, and what the broker sent before it ended the hop reaches a client that reads it late, every byte of it and then its end', async () => {
  let hopEnd = null;
  let acked = 0;
  const target = net.createServer({ allowHalfOpen: true }, (c) => {
    hopEnd = c;
    c.on('error', () => {});
    let buf = Buffer.alloc(0);
    c.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (buf.length >= PREFACE.length && buf[0] === PREFACE[0] && buf.subarray(0, PREFACE.length).equals(PREFACE)) buf = buf.subarray(PREFACE.length);
      while (buf.length >= 5) {
        const n = buf.readUInt32BE(1);
        const size = buf[0] === DATA ? 5 + n : 5;
        if (buf.length < size) return;
        if (buf[0] === ACK) acked += n;
        buf = buf.subarray(size);
      }
    });
  });
  await listening(target);
  const r = await startRelay(target);
  try {
    const c = await r.dial();
    c.pause();
    await until('the hop', () => hopEnd);
    // Sent by hand and all at once, more than the sockets between can hold.
    const sent = 32 * 2 ** 20;
    const piece = Buffer.alloc(64 * 1024, 3);
    const head = Buffer.alloc(5);
    head[0] = DATA;
    head.writeUInt32BE(piece.length, 1);
    for (let n = 0; n < sent; n += piece.length) hopEnd.write(Buffer.concat([head, piece]));
    let last = -1;
    for (let still = 0; still < 20; await sleep(25)) {
      still = acked === last ? still + 1 : 0;
      last = acked;
    }
    assert.ok(acked < sent / 2, `the broker was told of ${acked} of ${sent} bytes the client has not read`);
    hopEnd.write(Buffer.from([END, 0, 0, 0, 0]));
    hopEnd.end();
    await sleep(300);
    let got = 0;
    let ended = false;
    c.on('data', (d) => { got += d.length; });
    c.on('end', () => { ended = true; });
    c.resume();
    await until('the client to have it all and its end', () => ended, 20000);
    assert.equal(got, sent);
  } finally { r.end(); }
});

await check('a client that does not end its side after the broker ended the connection has it closed 5 s on', async () => {
  let hopEnd = null;
  const target = net.createServer({ allowHalfOpen: true }, (c) => {
    hopEnd = c;
    c.on('error', () => {});
    c.resume();
  });
  await listening(target);
  const r = await startRelay(target);
  try {
    const c = await new Promise((resolve, reject) => {
      const s = net.connect({ port: r.port, host: '127.0.0.1', allowHalfOpen: true }, () => resolve(s));
      s.once('error', reject);
    });
    r.clients.push(c);
    await until('the hop', () => hopEnd);
    let ended = 0;
    let closed = 0;
    c.on('end', () => { ended = Date.now(); });
    c.on('error', () => {});
    c.on('close', () => { closed = Date.now(); });
    c.resume();
    hopEnd.end(Buffer.from([END, 0, 0, 0, 0]));
    await until('the end at the client', () => ended);
    // What the client writes shows when the relay has let go of the connection.
    const ticking = setInterval(() => { if (!c.destroyed) c.write('t'); }, 100);
    try {
      await until('the connection to be closed', () => closed, 9000);
    } finally { clearInterval(ticking); }
    assert.ok(closed - ended >= 4500, `after ${closed - ended} ms`);
  } finally { r.end(); }
});

await check('a relay carries a client\'s end to the broker after what it wrote, and the broker\'s answer back to the client after that: a client that writes and ends at once is answered once all it wrote has come, and one answered and ended before then still has all it wrote reach the broker, and then its end', async () => {
  // A stranger's window is 2 KiB: most of each upload waits in the relay for room.
  const each = 16384;
  const heard = [];
  const target = net.createServer(framed((link) => {
    let n = 0;
    let first = true;
    link.on('data', (d) => {
      n += d.length;
      if (first && String(d).startsWith('early')) link.end('answered early');
      first = false;
    });
    link.on('end', () => {
      heard.push(n);
      if (!link.writableEnded) link.end(`got ${n}`);
    }).on('error', () => {});
  }));
  await listening(target);
  const r = await startRelay(target);
  const upload = (head) => new Promise((resolve) => {
    const c = net.connect({ port: r.port, host: '127.0.0.1', allowHalfOpen: true }, () => c.end(Buffer.concat([Buffer.from(head), Buffer.alloc(each - head.length)])));
    r.clients.push(c);
    let answer = '';
    c.on('data', (d) => { answer += d; }).on('error', () => {});
    c.on('end', () => resolve(answer));
  });
  try {
    assert.deepEqual(await within(Promise.all(Array.from({ length: 10 }, () => upload('late'))), 'the answers'), Array(10).fill(`got ${each}`));
    assert.deepEqual(await within(Promise.all(Array.from({ length: 10 }, () => upload('early'))), 'the early answers'), Array(10).fill('answered early'));
    await until('every upload\'s end at the broker', () => heard.length === 20);
    assert.deepEqual(heard, Array(20).fill(each), 'each whole');
  } finally { r.end(); }
});

await check('a client that goes away with a way of its connection still open has the hop ended: at once while the relay reads it, and as the broker sends it more once it has ended its side', async () => {
  for (const clientFirst of [false, true]) {
    let hopEnd = null;
    const target = net.createServer({ allowHalfOpen: true }, (c) => {
      hopEnd = c;
      c.on('error', () => {});
      c.resume();
    });
    await listening(target);
    const r = await startRelay(target);
    try {
      const c = await new Promise((resolve, reject) => {
        const s = net.connect({ port: r.port, host: '127.0.0.1', allowHalfOpen: true }, () => resolve(s));
        s.once('error', reject);
      });
      r.clients.push(c);
      c.on('error', () => {});
      c.resume();
      await until('the hop', () => hopEnd);
      let ended = false;
      hopEnd.on('end', () => { ended = true; }).on('close', () => { ended = true; });
      if (clientFirst) c.end();
      else hopEnd.write(Buffer.from([END, 0, 0, 0, 0]));
      await sleep(300);
      assert.equal(ended, false, 'the hop is kept while the other way is open');
      c.resetAndDestroy();
      // Nothing is read of a client that ended its side: it is found gone as it is written to.
      for (let i = 0; clientFirst && i < 5 && !ended; i++) {
        await sleep(100);
        hopEnd.write(Buffer.concat([Buffer.from([DATA, 0, 0, 0, 5]), Buffer.from('hello')]));
      }
      await until(`the hop to be ended, the ${clientFirst ? 'client' : 'broker'} having ended first`, () => ended, 3000);
    } finally { r.end(); }
  }
});

console.log(`\nall ${checks} checks passed`);
