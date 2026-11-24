// The hop between a job's relay and the broker (hop.js): a busy pool's connections carry
// what they carry through the real relay, and what every job's connections together
// have on the hop is bounded however they are used, counted here frame by frame from a
// relay's side and measured in this machine's kernel.
// Run: node test/executor-hop.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import v8 from 'node:v8';
import vm from 'node:vm';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'dn-hop-'));
Object.assign(process.env, {
  DN_BASE_DIR: path.join(scratch, 'base'), DN_BROKER_BIND: '127.0.0.1', DN_RELAY_HOST: '127.0.0.1',
  DIPLOMAT_CONFIG: path.join(scratch, 'config.json'),
});
const { createBroker } = await import('../src/executor/broker.js');
const { createCA } = await import('../src/executor/ca.js');
const { ACK, ASK, CREDIT, DATA, END, HOP_JOB_BYTES, HOP_RECLAIM_MS, HOP_STRANGER_BYTES, HOP_STRANGER_WINDOW, HOP_WINDOW, PREFACE, createHop } = await import('../src/executor/hop.js');
assert.deepEqual([HOP_WINDOW, HOP_STRANGER_WINDOW, HOP_JOB_BYTES, HOP_STRANGER_BYTES, HOP_RECLAIM_MS], [128 * 1024, 2 * 1024, 14 * 2 ** 20, 2 * 2 ** 20, 2000], 'what the README states');
const RELAY = fileURLToPath(new URL('../image/relay.mjs', import.meta.url));

let checks = 0;
const check = async (name, fn) => {
  try { await fn(); } catch (e) {
    console.error(`FAIL ${name}\n${e?.stack ?? e}`);
    process.exit(1);
  }
  checks++;
  console.log(`PASS ${name}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (what, met, ms = 60000) => {
  for (const end = Date.now() + ms; !met();) {
    if (Date.now() > end) assert.fail(`never: ${what}`);
    await sleep(5);
  }
};
const faults = [];
process.on('uncaughtException', (e) => faults.push(e));
process.on('unhandledRejection', (e) => faults.push(e));
const listening = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

// ---- the internet, by the address each name resolves to
const block = Buffer.alloc(64 * 1024, 'd');
const echo = net.createServer((s) => { s.on('error', () => {}); s.pipe(s); });
const source = net.createServer((s) => {
  s.on('error', () => {});
  const pump = () => { while (s.writable && s.write(block)); };
  s.on('drain', pump);
  pump();
});
const web = http.createServer((req, res) => {
  let n = 0;
  req.on('data', (c) => { n += c.length; });
  req.on('end', () => {
    if (req.url !== '/stream') return res.end(`got ${n}`);
    // An answer that comes a little at a time, as a model's does.
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    let i = 0;
    const timer = setInterval(() => {
      res.write(`data: ${i}\n\n`);
      if (++i === 40) { clearInterval(timer); res.end(); }
    }, 5);
  });
});
const ports = { '93.184.216.1': await listening(echo), '93.184.216.2': await listening(source), '93.184.216.4': await listening(web) };
const addresses = { 'echo.test': '93.184.216.1', 'source.test': '93.184.216.2', 'web.test': '93.184.216.4', 'hang.test': '93.184.216.5' };
const lookup = async (name) => [{ address: addresses[name], family: 4, name }];
// hang.test is reached by no connection that ever opens.
const connect = ({ host }) => (ports[host] ? new Promise((resolve, reject) => {
  const s = net.connect(ports[host], '127.0.0.1', () => resolve(s));
  s.once('error', reject);
}) : new Promise(() => {}));

const started = async (outbound) => {
  const made = createBroker({ ca: createCA(), llm: { authorize: async (h) => h, refused: async () => null }, mirrors: { path: () => null },
    onForge: async () => ({ status: 200, headers: {}, body: '' }), lookup, connect, outbound });
  return { broker: made, port: (await made.start({ port: 0 })).port };
};
let { broker, port } = await started();
const pool = { id: 'github.com/a/b', forge: 'github', host: 'github.com', owner: 'a', repo: 'b' };
let runs = 0;
const addJob = async () => {
  const runId = `run${runs++}`;
  const { token } = await broker.addJob({ runId, pool });
  return { runId, auth: `Basic ${Buffer.from(`dn:${token}`).toString('base64')}` };
};
const held = (jobs) => jobs.reduce((sum, j) => sum + broker.load(j.runId).held, 0);

async function startRelay() {
  const free = net.createServer();
  const at = await listening(free);
  await new Promise((r) => free.close(r));
  const relay = spawn(process.execPath, [RELAY, '127.0.0.0/8', String(at), '127.0.0.1', String(port)], { stdio: ['ignore', 'pipe', 'ignore'] });
  process.on('exit', () => relay.kill('SIGKILL'));
  await new Promise((resolve) => relay.stdout.once('data', resolve));
  return { port: at, end: () => relay.kill('SIGKILL') };
}

// A tunnel through the relay: resolves to the socket once it is open.
const tunnel = (relayPort, job, host) => new Promise((resolve, reject) => {
  const s = net.connect(relayPort, '127.0.0.1');
  s.on('error', reject);
  s.write(`CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\nProxy-Authorization: ${job.auth}\r\n\r\n`);
  let head = Buffer.alloc(0);
  const opened = (d) => {
    head = Buffer.concat([head, d]);
    const at = head.indexOf('\r\n\r\n');
    if (at === -1) return;
    s.pause();
    s.off('data', opened);
    if (!head.subarray(0, at).toString().startsWith('HTTP/1.1 200')) return reject(new Error(String(head)));
    if (head.length > at + 4) s.unshift(head.subarray(at + 4));
    return resolve(s);
  };
  s.on('data', opened);
});

// The broker's end of the hop as a relay sees it, driven by hand: what it sends, frame
// by frame, and what it is sent.
function byHand(onFrame) {
  const s = net.connect(port, '127.0.0.1');
  s.on('error', () => {});
  const send = (type, n, payload) => {
    const head = Buffer.alloc(5);
    head[0] = type;
    head.writeUInt32BE(n, 1);
    s.write(payload ? Buffer.concat([head, payload]) : head);
  };
  let buf = Buffer.alloc(0);
  s.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    while (buf.length >= 5) {
      const n = buf.readUInt32BE(1);
      const size = buf[0] === DATA ? 5 + n : 5;
      if (buf.length < size) return;
      onFrame(buf[0], n, buf.subarray(5, size));
      buf = buf.subarray(size);
    }
  });
  s.write(PREFACE);
  return { s, send };
}
// Well before a request's head runs out of time.
const closed = (s) => until('the broker to close the connection', () => s.destroyed, 3000);

await check('a busy pool through its relays: jobs at once, each with tunnels, request bodies and slow answers in flight together, all carried whole, and the hop holds nothing once they are done', async () => {
  const relay = await startRelay();
  const jobs = [await addJob(), await addJob(), await addJob()];
  let most = 0;
  const watch = setInterval(() => { most = Math.max(most, held(jobs)); }, 2);
  const started = Date.now();
  try {
    const work = [];
    for (const job of jobs) {
      // Downloads and uploads of 2 MiB, 24 at a time.
      for (let i = 0; i < 24; i++) {
        work.push((async () => {
          const s = await tunnel(relay.port, job, 'echo.test');
          const sent = Buffer.alloc(2 * 2 ** 20, i);
          s.write(sent);
          const back = [];
          let n = 0;
          for await (const c of s) {
            back.push(c);
            n += c.length;
            if (n >= sent.length) break;
          }
          s.destroy();
          assert.ok(Buffer.concat(back).equals(sent), 'what went through came back as it went');
        })());
      }
      // Plain requests with bodies, and answers that come a little at a time.
      for (let i = 0; i < 8; i++) {
        for (const what of ['/body', '/stream']) {
          work.push(new Promise((resolve, reject) => {
            const req = http.request({ host: '127.0.0.1', port: relay.port, method: 'POST', path: `http://web.test${what}`, agent: false,
              headers: { host: 'web.test', 'proxy-authorization': job.auth } }, (res) => {
              let text = '';
              res.on('data', (c) => { text += c; });
              res.on('end', () => {
                try {
                  if (what === '/body') assert.equal(text, `got ${2 ** 20}`);
                  else assert.equal(text, Array.from({ length: 40 }, (_, k) => `data: ${k}\n\n`).join(''));
                  resolve();
                } catch (e) { reject(e); }
              });
            });
            req.on('error', reject);
            req.end(Buffer.alloc(what === '/body' ? 2 ** 20 : 0, 1));
          }));
        }
      }
    }
    let done = false;
    const all = Promise.all(work).finally(() => { done = true; });
    await until('the pool\'s work to be done', () => done);
    await all;
    const took = Date.now() - started;
    assert.ok(took < 60000, `the pool's work took ${took} ms`);
    assert.ok(most > 0 && most <= HOP_JOB_BYTES, `the hop held ${most} bytes at most`);
    await until('every connection to close', () => jobs.every((j) => broker.load(j.runId).connections === 0));
    assert.equal(held(jobs), 0, 'and nothing once they are done');
  } finally {
    clearInterval(watch);
    relay.end();
    for (const j of jobs) broker.removeJob(j.runId);
  }
});

await check('a job with more requests at once than are carried at a time, each with a body, has every one answered', async () => {
  const relay = await startRelay();
  const job = await addJob();
  try {
    const work = [];
    for (let i = 0; i < 200; i++) {
      work.push(new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port: relay.port, method: 'POST', path: 'http://web.test/body', agent: false,
          headers: { host: 'web.test', 'proxy-authorization': job.auth } }, (res) => {
          let text = '';
          res.on('data', (c) => { text += c; });
          res.on('end', () => (text === `got ${256 * 1024}` ? resolve() : reject(new Error(text))));
        });
        req.on('error', reject);
        req.end(Buffer.alloc(256 * 1024, 2));
      }));
    }
    let done = false;
    const all = Promise.all(work).finally(() => { done = true; });
    await until('every request to be answered', () => done);
    await all;
    await until('every connection to close', () => broker.load(job.runId).connections === 0);
    assert.equal(broker.load(job.runId).held, 0);
  } finally {
    relay.end();
    broker.removeJob(job.runId);
  }
});

// The checks from here on leave hundreds of connections out unread or unanswered on
// purpose: what the kernel holds of those is outbound.js's to bound
// (executor-outbound.mjs), and here only the hop's count is looked at.
await broker.stop();
({ broker, port } = await started({ bytes: Infinity }));

// Each job keeps one connection open from the start, so the hop is shared out by all of them.
async function seated(jobs, host) {
  const links = [];
  for (const job of jobs) {
    const link = { job, got: 0, acked: 0, granted: 0, head: Buffer.from(`CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\nProxy-Authorization: ${job.auth}\r\n\r\n`) };
    link.hand = byHand((type, n, payload) => {
      if (type === DATA) link.got += payload.length;
      if (type === CREDIT) {
        link.granted += n;
        link.onCredit?.(n);
      }
    });
    link.hand.send(ASK, link.head.length);
    await until('room for the head', () => link.granted === link.head.length);
    link.hand.send(DATA, link.head.length, link.head);
    links.push(link);
  }
  return links;
}

// Until what `count` sums over the links has stopped moving.
async function settle(links, count) {
  let last = -1;
  for (let still = 0; still < 20;) {
    await sleep(25);
    const now = links.reduce((sum, l) => sum + count(l), 0);
    still = now === last ? still + 1 : 0;
    last = now;
  }
  return last;
}
const ofJob = (links, job, count) => links.filter((l) => l.job === job).reduce((sum, l) => sum + count(l), 0);

await check('what a job\'s connections are sent and have not passed on is no more than a window each, a share of the hop each job, and the hop\'s whole for all of them, however many read nothing; jobs past their shares that hold another job back for long lose their newest connections until within them, and lose nothing once no job is held back', async () => {
  const jobs = [await addJob(), await addJob(), await addJob()];
  try {
    const links = await seated(jobs, 'source.test');
    for (let i = 0; i < 3 * 127; i++) links.push(...await seated([jobs[i % 3]], 'source.test'));
    // Not one byte is passed on: nothing is told back.
    const got = (l) => l.got - l.acked;
    const total = await settle(links, got);
    for (const l of links) assert.ok(l.got <= HOP_WINDOW, `one connection was sent ${l.got} bytes`);
    for (const job of jobs) {
      const mine = ofJob(links, job, got);
      assert.ok(mine <= Math.floor(HOP_JOB_BYTES / 3), `one job's connections were sent ${mine} bytes`);
      assert.equal(broker.load(job.runId).held, mine, 'and the broker counts what they were sent');
    }
    assert.ok(total <= HOP_JOB_BYTES && total > HOP_JOB_BYTES / 2, `all of them were sent ${total} bytes`);
    // What one connection passes on makes room for that much more, and no more.
    const first = links[0];
    const had = first.got;
    first.hand.send(ACK, had);
    first.acked = had;
    await until('more for the connection that passed its bytes on', () => got(first) > 0);
    await sleep(200);
    assert.ok(got(first) <= HOP_WINDOW, `${got(first)} more after ${had} were passed on`);
    const mine = ofJob(links, jobs[0], got);
    assert.equal(broker.load(jobs[0].runId).held, mine);
    assert.ok(mine <= Math.floor(HOP_JOB_BYTES / 3), `the job's connections hold ${mine} bytes`);
    // A job that comes once the others have the hop's whole is sent nothing at first: the
    // others are past their shares once it has come, and are given no room until within them.
    const late = await addJob();
    jobs.push(late);
    const share = Math.floor(HOP_JOB_BYTES / 4);
    // Room is made 2 KiB at a time at the least.
    const full = (l) => got(l) > HOP_WINDOW - 2 * 1024;
    const lost = (job) => links.filter((l) => l.job === job && l.hand.s.destroyed).length;
    let most = 0;
    const watch = setInterval(() => { most = Math.max(most, held(jobs)); }, 2);
    const lates = [];
    try {
      for (let i = 0; i < 24; i++) lates.push(...await seated([late], 'source.test'));
      const since = Date.now();
      await sleep(HOP_RECLAIM_MS / 2);
      assert.equal(ofJob(lates, late, got), 0, 'the late job was sent nothing at first');
      // One of them gives room back: the late job is sent what it waits for, and the jobs
      // past their shares lose nothing, as no job is held back by them any longer.
      for (const l of links.filter((x) => x.job === jobs[1]).slice(1)) l.hand.s.destroy();
      await until('the late job to be sent what its connections wait for', () => lates.every(full));
      await sleep(since + HOP_RECLAIM_MS + 500 - Date.now());
      assert.deepEqual([lost(jobs[0]), lost(jobs[2])], [0, 0], 'no job lost a connection while none was held back');
      // That one comes back for its share, and the hop has too little room left for it:
      // after HOP_RECLAIM_MS the jobs past their shares lose their newest connections until
      // they are within them, and it is sent its share.
      const back = Date.now();
      for (let i = 0; i < 40; i++) links.push(...await seated([jobs[1]], 'source.test'));
      await until('the job held back to be sent its share', () => broker.load(jobs[1].runId).held > share - 2 * 1024);
      const took = Date.now() - back;
      assert.ok(took >= HOP_RECLAIM_MS && took < HOP_RECLAIM_MS + 3000, `the job held back waited ${took} ms`);
    } finally { clearInterval(watch); }
    assert.ok(most <= HOP_JOB_BYTES, `the hop held ${most} bytes at most`);
    for (const job of [jobs[0], jobs[2]]) {
      const mine = links.filter((l) => l.job === job);
      const gone = mine.findIndex((l) => l.hand.s.destroyed);
      assert.ok(gone > 0, 'a job past its share lost some of its connections, and not its first');
      assert.ok(mine.slice(gone).every((l) => l.hand.s.destroyed), 'the ones it lost are its newest');
      assert.ok(broker.load(job.runId).held <= share, 'and it is within its share');
    }
    for (const l of [...links, ...lates]) l.hand.s.destroy();
    await until('the hop to be given back', () => held(jobs) === 0);
  } finally {
    for (const j of jobs) broker.removeJob(j.runId);
  }
});

await check('what a job\'s connections send that nobody reads is no more than a window each, and is off the hop once it has come: however many of them read nothing, another job\'s connections are given room at once', async () => {
  const jobs = [await addJob(), await addJob(), await addJob()];
  try {
    // Tunnels whose way out never opens: what comes after their heads is read by nobody.
    const asking = (l) => {
      l.onCredit = (n) => {
        l.hand.send(DATA, n, Buffer.alloc(n));
        l.hand.send(ASK, 2 ** 30);
      };
      l.hand.send(ASK, 2 ** 30);
    };
    const links = await seated(jobs, 'hang.test');
    for (let i = 0; i < 3 * 127; i++) links.push(...await seated([jobs[i % 3]], 'hang.test'));
    links.forEach(asking);
    const room = (l) => l.granted - l.head.length;
    // Room is made 2 KiB at a time at the least.
    const full = (l) => room(l) <= HOP_WINDOW && room(l) > HOP_WINDOW - 2 * 1024;
    await settle(links, room);
    for (const l of links) assert.ok(full(l), `a connection was given room for ${room(l)} bytes past its head`);
    for (const job of jobs) assert.equal(broker.load(job.runId).held, 0, 'and what came of it is not on the hop');
    const late = await addJob();
    jobs.push(late);
    const since = Date.now();
    const lates = [];
    for (let i = 0; i < 8; i++) lates.push(...await seated([late], 'hang.test'));
    lates.forEach(asking);
    await until('the late job to be given room', () => lates.every(full));
    assert.ok(Date.now() - since < HOP_RECLAIM_MS, 'at once');
    assert.ok(links.every((l) => !l.hand.s.destroyed), 'and no job lost a connection for it');
    links.push(...lates);
    for (const l of links) l.hand.s.destroy();
    await until('the hop to be given back', () => held(jobs) === 0);
  } finally {
    for (const j of jobs) broker.removeJob(j.runId);
  }
});

await check('what connections left unread were sent in the smallest frames costs the daemon about what it counts', async () => {
  v8.setFlagsFromString('--expose-gc');
  const gc = vm.runInNewContext('gc');
  const job = await addJob();
  try {
    const links = [];
    for (let i = 0; i < 16; i++) links.push(...await seated([job], 'hang.test'));
    gc();
    const before = process.memoryUsage();
    for (const l of links) {
      l.onCredit = (n) => {
        const frames = Buffer.alloc(n * 6);
        for (let k = 0; k < n; k++) frames.writeUInt32BE(1, k * 6 + 1);
        l.hand.s.write(frames);
      };
      l.hand.send(ASK, HOP_WINDOW);
    }
    await until('every frame to be sent', () => links.every((l) => l.granted === l.head.length + HOP_WINDOW && l.hand.s.writableLength === 0));
    await sleep(500);
    // Twice, so that what the first frees outside the heap is gone too.
    gc();
    await sleep(50);
    gc();
    const after = process.memoryUsage();
    const cost = after.heapUsed + after.arrayBuffers - before.heapUsed - before.arrayBuffers;
    assert.ok(cost < 4 * 16 * HOP_WINDOW, `${16 * HOP_WINDOW} bytes cost ${cost}`);
    for (const l of links) l.hand.s.destroy();
  } finally { broker.removeJob(job.runId); }
});

await check('a connection whose frames are broken, or bring more than it was given room for, or tell of more than it was sent, is closed, as is one that holds a second hop; a stranger is given room for a little of its head at a time, a connection the broker or the relay is done with is ended both ways, and a write of no bytes is done at once', async () => {
  const job = await addJob();
  try {
    const head = Buffer.from(`CONNECT echo.test:443 HTTP/1.1\r\nHost: echo.test:443\r\nProxy-Authorization: ${job.auth}\r\n\r\n`);
    // Room for a stranger's head comes a little at a time.
    const grants = [];
    const stranger = byHand((type, n) => { if (type === CREDIT) grants.push(n); });
    stranger.send(ASK, 100000);
    await until('room for some of it', () => grants.length === 1);
    assert.deepEqual(grants, [HOP_STRANGER_WINDOW]);
    stranger.s.destroy();
    // More than it was given room for.
    let a = byHand(() => {});
    a.send(DATA, 10, Buffer.from('GET http:/'));
    await closed(a.s);
    // Room granted and not yet used is on the hop; told of more than it was sent, the
    // connection is closed.
    let opened = 0;
    const credits = [];
    a = byHand((type, n, payload) => {
      if (type === CREDIT && (credits.push(n) === 1)) a.send(DATA, head.length, head);
      if (type === DATA && String(payload).startsWith('HTTP/1.1 200')) opened = payload.length;
    });
    a.send(ASK, head.length);
    await until('the tunnel to open', () => opened > 0);
    a.send(ACK, opened);
    a.send(ASK, 5000);
    await until('room for more', () => credits.length === 2);
    await until('the broker to count it', () => broker.load(job.runId).held === 5000);
    a.send(ACK, 10 ** 6);
    await closed(a.s);
    // An ASK for nothing.
    a = byHand(() => {});
    a.send(ASK, 0);
    await closed(a.s);
    // A frame of no type the hop knows.
    a = byHand(() => {});
    a.send(9, 0);
    await closed(a.s);
    // An END and then more.
    a = byHand(() => {});
    a.send(END, 0);
    a.send(ASK, 5);
    await closed(a.s);
    // A first byte of zero and then no preface.
    const b = net.connect(port, '127.0.0.1');
    b.on('error', () => {});
    b.write(Buffer.from([0, 1, 2, 3, 4, 5]));
    await closed(b);
    // A connection whose first bytes inside the hop look like a hop's is no second hop.
    const types = [];
    a = byHand((type) => {
      types.push(type);
      if (type === CREDIT) a.send(DATA, inner.length, inner);
    });
    const inner = Buffer.concat([PREFACE, Buffer.from([ASK, 0, 0, 0, 5]), Buffer.from('\r\n\r\n')]);
    a.send(ASK, inner.length);
    await closed(a.s);
    assert.deepEqual(types, [CREDIT], 'and is answered nothing');
    // A connection the broker is done with is ended with END.
    const ask = Buffer.from(`POST http://web.test/body HTTP/1.1\r\nHost: web.test\r\nProxy-Authorization: ${job.auth}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    let answer = '';
    const after = [];
    a = byHand((type, n, payload) => {
      if (type === CREDIT) a.send(DATA, ask.length, ask);
      if (type === DATA) answer += payload;
      else if (answer) after.push(type);
    });
    a.send(ASK, ask.length);
    await until('the answer and its END', () => after.includes(END));
    assert.match(answer, /^HTTP\/1\.1 200[^]*got 0$/);
    a.s.destroy();
    // A tunnel the relay ends is ended on its way out, and so back.
    const seen = [];
    let ok = false;
    a = byHand((type, n, payload) => {
      seen.push(type);
      if (type === CREDIT && seen.filter((t) => t === CREDIT).length === 1) a.send(DATA, head.length, head);
      if (type === DATA && String(payload).startsWith('HTTP/1.1 200')) {
        ok = true;
        a.send(END, 0);
      }
    });
    a.send(ASK, head.length);
    await until('the tunnel to be ended back', () => ok && seen.includes(END));
    a.s.destroy();
    assert.equal(broker.load(job.runId).held, 0);
    await until('every connection to close', () => broker.load(job.runId).connections === 0);
  } finally { broker.removeJob(job.runId); }
  // A write of no bytes is done at once, though the window is full.
  const unit = createHop({ strangerWindow: 8 });
  const server = net.createServer();
  const at = await listening(server);
  const far = net.connect(at, '127.0.0.1');
  far.on('error', () => {});
  const [near] = await Promise.all([new Promise((r) => server.once('connection', r)), new Promise((r) => far.once('connect', r))]);
  far.write(PREFACE);
  const link = unit.framed(near);
  link.on('error', () => {});
  await new Promise((r) => link.write(Buffer.alloc(8), r));
  let done = false;
  link.write(Buffer.alloc(0), () => { done = true; });
  await until('the empty write to be done', () => done, 3000);
  link.destroy();
  far.destroy();
  server.close();
});

// The bytes in the kernel's queues of the sockets whose one end is the broker's port.
function queued() {
  let bytes = 0;
  if (process.platform === 'linux') {
    for (const line of execFileSync('ss', ['-tnH'], { encoding: 'utf8' }).split('\n')) {
      const m = /^\S+\s+(\d+)\s+(\d+)\s+\S+:(\d+)\s+\S+:(\d+)/.exec(line);
      if (m && (Number(m[3]) === port || Number(m[4]) === port)) bytes += Number(m[1]) + Number(m[2]);
    }
  } else {
    for (const line of execFileSync('netstat', ['-anp', 'tcp'], { encoding: 'utf8' }).split('\n')) {
      const m = /^tcp\S*\s+(\d+)\s+(\d+)\s+\S+\.(\d+)\s+\S+\.(\d+)/.exec(line);
      if (m && (Number(m[3]) === port || Number(m[4]) === port)) bytes += Number(m[1]) + Number(m[2]);
    }
  }
  return bytes;
}

await check('a job that floods its connections with requests or leaves them unread holds no more of this machine\'s kernel on the hop than the hop\'s whole', async () => {
  const relay = await startRelay();
  const job = await addJob();
  const flood = [];
  try {
    // 16 tunnels from a source that sends with no end, read no further than their first
    // bytes, and 16 connections that pipeline request heads with no end to a host whose
    // way out never opens, so that the job is soon at its share of requests.
    for (let i = 0; i < 16; i++) {
      const t = await tunnel(relay.port, job, 'source.test');
      t.pause();
      flood.push(t);
    }
    const heads = Buffer.from(`GET http://hang.test/ HTTP/1.1\r\nHost: hang.test\r\nProxy-Authorization: ${job.auth}\r\n\r\n`.repeat(400));
    for (let i = 0; i < 16; i++) {
      const s = net.connect(relay.port, '127.0.0.1');
      s.on('error', () => {});
      s.resume();
      const pump = () => { while (s.writable && s.write(heads)); };
      s.on('drain', pump);
      s.on('connect', pump);
      flood.push(s);
    }
    let most = 0;
    for (let i = 0; i < 40; i++) {
      await sleep(50);
      most = Math.max(most, queued());
    }
    assert.ok(most <= HOP_JOB_BYTES, `the kernel held ${most} bytes on the hop`);
    assert.ok(broker.load(job.runId).held > 0, 'what the job holds of the hop is held by the broker');
  } finally {
    for (const s of flood) s.destroy();
    relay.end();
    broker.removeJob(job.runId);
  }
});

assert.deepEqual(faults.map((e) => String(e?.stack ?? e)), []);
await broker.stop();
for (const s of [echo, source, web]) s.close();
fs.rmSync(scratch, { recursive: true, force: true });
console.log(`\nall ${checks} checks passed`);
process.exit(0);
