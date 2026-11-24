// The broker's connections out (outbound.js): the kernel's tables are read as they
// are, what the count finds is held to a share each job, kept back as it is written and
// reset when it comes in past the whole, and polls that fail stop nothing; through the
// broker, on this machine's kernel, connections out that nobody answers or reads hold no
// more than the whole, and each way of a tunnel ends on its own.
// Run: node test/executor-outbound.mjs

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const RELAY = fileURLToPath(new URL('../image/relay.mjs', import.meta.url));
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'dn-outbound-'));
Object.assign(process.env, {
  DN_BASE_DIR: path.join(scratch, 'base'), DN_BROKER_BIND: '127.0.0.1', DN_RELAY_HOST: '127.0.0.1',
  DIPLOMAT_CONFIG: path.join(scratch, 'config.json'),
});
const { createBroker } = await import('../src/executor/broker.js');
const { createCA } = await import('../src/executor/ca.js');
const { OUT_BYTES, OUT_FALLBACK, OUT_LINGER_MS, OUT_POLL_MS, OUT_SOONEST_MS, createOutbound, parseNetstat, parseProc, plainAddress, systemQueues } = await import('../src/executor/outbound.js');
assert.deepEqual([OUT_BYTES, OUT_POLL_MS, OUT_SOONEST_MS, OUT_FALLBACK, OUT_LINGER_MS], [32 * 2 ** 20, 500, 100, 32, 30000], 'what the README states');

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
const until = async (what, met, ms = 10000) => {
  for (const end = Date.now() + ms; !(await met());) {
    if (Date.now() > end) assert.fail(`never: ${what}`);
    await sleep(5);
  }
};
const within = (promise, what, ms = 5000) => {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`never: ${what}`)), ms); })]).finally(() => clearTimeout(timer));
};
const listening = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

// Connections on this machine, each with the far end the test holds, which reads all
// and ends nothing of its own.
const far = [];
const sink = net.createServer({ allowHalfOpen: true }, (s) => {
  s.on('error', () => {});
  far.push(s);
  s.resume();
});
const sinkPort = await listening(sink);
const connected = () => new Promise((resolve, reject) => {
  const s = net.connect(sinkPort, '127.0.0.1', () => resolve(s));
  s.once('error', reject);
});
// A connection's addresses are gone from its socket once it is closed, and not from the kernel.
const tuples = new WeakMap();
const row = (s, bytes, sending = bytes) => {
  if (!tuples.has(s)) tuples.set(s, { local: plainAddress(s.localAddress), localPort: s.localPort, remote: plainAddress(s.remoteAddress), remotePort: s.remotePort });
  return { ...tuples.get(s), bytes, sending };
};

await check('the kernel\'s tables are read as Linux and macOS write them: each connection by its addresses and ports with what is queued either way and what to be sent, listening sockets and those still connecting left out, and a table of anything else refused', async () => {
  const proc = [
    '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
    '   0: 0100007F:0050 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 1 1 0 100 0 0 10 0',
    '   1: 0100007F:D431 22D8B85D:01BB 01 00000010:00000020 00:00000000 00000000  1000        0 2 1 0 20 4 30 10 -1',
    // Connecting, read as its SYN was answered: 535975187 come in, as Linux 6.18 showed one.
    '   2: 0100007F:D432 22D8B85D:01BB 02 00000000:1FF25513 01:00000064 00000000  1000        0 5 1 0 20 4 30 10 -1',
  ].join('\n');
  assert.deepEqual(parseProc(proc), [{ local: '127.0.0.1', localPort: 54321, remote: '93.184.216.34', remotePort: 443, bytes: 48, sending: 16 }]);
  const proc6 = [
    '  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
    '   0: B80D0120000000000000000001000000:9C40 B80D0120000000000000000002000000:01BB 01 00100000:00000000 00:00000000 00000000  1000        0 3 1 0 20 4 30 10 -1',
    '   1: 0000000000000000FFFF00000100007F:9C41 0000000000000000FFFF0000020000C0:0050 01 00000000:00000001 00:00000000 00000000  1000        0 4 1 0 20 4 30 10 -1',
  ].join('\n');
  assert.deepEqual(parseProc(proc6), [
    { local: plainAddress('2001:db8::1'), localPort: 40000, remote: plainAddress('2001:db8::2'), remotePort: 443, bytes: 0x100000, sending: 0x100000 },
    { local: plainAddress('::ffff:127.0.0.1'), localPort: 40001, remote: plainAddress('::ffff:192.0.0.2'), remotePort: 80, bytes: 1, sending: 0 },
  ]);
  assert.equal(plainAddress('2001:db8::1'), '2001:db8:0:0:0:0:0:1');
  assert.equal(plainAddress('FE80::0435:995e:da13:fd9%en0'), 'fe80:0:0:0:435:995e:da13:fd9');
  assert.throws(() => parseProc('Inter-|   Receive\n face |bytes'), /not a table of TCP sockets/);
  const netstat = [
    'Active Internet connections (including servers)',
    'Proto Recv-Q Send-Q  Local Address                                 Foreign Address                               (state)    ',
    'tcp4       0  12345  192.168.1.20.51122                            93.184.216.34.443                             ESTABLISHED',
    'tcp6     700     20  2001:db8:85a3:8d3:1319:8a2e:370:7348.51123      2606:4700:4700::1111.443                      ESTABLISHED',
    'tcp6       0      0  fe80::435:995e:da13:fd9%en0.56474             fe80::4277:4e25:9163:65cf%en0.22              ESTABLISHED',
    'tcp6       0      0  ::1.51124                                     ::1.8080                                      ESTABLISHED',
    'tcp4       0      0  *.22                                          *.*                                           LISTEN     ',
    'tcp4       0      0  *.62926                                       *.*                                           CLOSED     ',
    'tcp4       0      0  *.*                                           *.*                                           CLOSED     ',
  ].join('\n');
  assert.deepEqual(parseNetstat(netstat), [
    { local: '192.168.1.20', localPort: 51122, remote: '93.184.216.34', remotePort: 443, bytes: 12345, sending: 12345 },
    { local: '2001:db8:85a3:8d3:1319:8a2e:370:7348', localPort: 51123, remote: '2606:4700:4700:0:0:0:0:1111', remotePort: 443, bytes: 720, sending: 20 },
    { local: 'fe80:0:0:0:435:995e:da13:fd9', localPort: 56474, remote: 'fe80:0:0:0:4277:4e25:9163:65cf', remotePort: 22, bytes: 0, sending: 0 },
    { local: plainAddress('::1'), localPort: 51124, remote: plainAddress('::1'), remotePort: 8080, bytes: 0, sending: 0 },
  ]);
  assert.throws(() => parseNetstat('netstat: sysctl: net.inet.tcp.pcblist_n: Operation not permitted'), /no table of connections/);
  assert.throws(() => parseNetstat(`${netstat}\ntcp4       0      0  192.168.1.20.x         93.184.216.34.443      ESTABLISHED`), /not a TCP connection/);
});

await check('this machine\'s kernel is asked as it is: a connection made here is found, with what its far end has not read', async () => {
  // Paused before it reads anything, node's buffer included.
  const deaf = net.createServer({ pauseOnConnect: true }, (s) => { s.on('error', () => {}); });
  const port = await listening(deaf);
  const s = await new Promise((resolve) => { const c = net.connect(port, '127.0.0.1', () => resolve(c)); });
  s.write(Buffer.alloc(1000, 1));
  try {
    let found;
    for (const end = Date.now() + 5000; Date.now() < end; await sleep(20)) {
      const rows = await systemQueues();
      found = rows.find((r) => r.localPort === port && r.remotePort === s.localPort && r.local === '127.0.0.1' && r.remote === '127.0.0.1');
      if (found?.bytes === 1000) break;
    }
    assert.equal(found?.bytes, 1000, `the far end of the connection: ${JSON.stringify(found)}`);
  } finally {
    s.destroy();
    deaf.close();
  }
});

// The count, asked of a stand-in for the kernel that says what each connection holds.
function counted({ bytes, held = () => [], fail = () => false }) {
  const told = [];
  let polls = 0;
  const outbound = createOutbound({ bytes, every: 20, soonest: 5, fallback: 3, say: (job, text) => told.push({ job, text }),
    queues: async () => { polls++; if (fail()) throw new Error('netstat went'); return held(); } });
  const after = async (n) => { const at = polls; await until(`${n} more polls`, () => polls >= at + n); };
  return { outbound, told, after };
}

await check('past the whole, the job that holds the most loses its connections out that hold the most until all are within it, and within the whole nothing is lost', async () => {
  const a = { name: 'a' };
  const b = { name: 'b' };
  const [a1, a2, a3, b1] = [await connected(), await connected(), await connected(), await connected()];
  for (const s of [a1, a2, a3, b1]) row(s, 0);
  const queued = new Map([[a1, 1500], [a2, 1000], [b1, 1800]]);
  // Another connection on a3's ports, to an address that only begins as a3's does.
  const other = { ...row(a3, 0), local: '127.0.0', remote: '127.0.0', bytes: 2 ** 30 };
  const held = () => [other, ...[...queued].filter(([s]) => !s.destroyed).map(([s, n]) => row(s, n))];
  const { outbound, told, after } = counted({ bytes: 3000, held });
  for (const [job, s] of [[a, a1], [a, a2], [a, a3], [b, b1]]) outbound.add(job, s);
  // 4300 held: a, with 2500, is reset its 1500, and 2800 are within the whole.
  await after(2);
  assert.deepEqual([a1, a2, a3, b1].map((s) => s.destroyed), [true, false, false, false]);
  assert.equal(told.length, 1);
  assert.equal(told[0].job, a);
  assert.match(told[0].text, new RegExp(`^a connection out of this job to 127\\.0\\.0\\.1:${sinkPort} is reset: the connections out of all jobs held more than the 0\\.0028\\d* MiB`));
  await after(3);
  assert.equal(told.length, 1, 'and nothing more within the whole');
  // With 1100 more of a3, a holds 2100 and b 1800: a3, the fullest of a's, is reset.
  queued.set(a3, 1100);
  await after(2);
  assert.deepEqual([a2.destroyed, a3.destroyed, b1.destroyed], [false, true, false]);
  assert.equal(told.length, 2);
  outbound.drop(b);
  assert.equal(b1.destroyed, true, 'a job dropped has its connections reset');
  outbound.drop(a);
});

// How the far end of a connection saw it close: 'end' for a FIN, the error's code for a reset.
const ending = (s) => new Promise((resolve) => {
  const side = far.find((f) => f.remotePort === s.localPort);
  side.once('error', (e) => resolve(e.code));
  side.once('end', () => resolve('end'));
});

await check('a connection closed while the kernel may have bytes of it to send is reset, by the last poll or what was written since, and one with none to send is not; one the job closes is closed once a poll finds what it was sent taken, its far end told nothing before, and reset if it is not taken in time', async () => {
  const job = {};
  const [polled, written, idle, ended, slow] = [await connected(), await connected(), await connected(), await connected(), await connected()];
  await until('the far ends to be there', () => [polled, written, idle, ended, slow].every((s) => far.some((f) => f.remotePort === s.localPort)));
  for (const s of [polled, written, idle, ended, slow]) row(s, 0);
  const sending = new Map([[polled, 500], [ended, 700], [slow, 900]]);
  const { outbound, told, after } = counted({ bytes: 2 ** 20, held: () => [polled, written, idle, ended, slow].map((s) => row(s, sending.get(s) ?? 0)) });
  const quick = createOutbound({ bytes: 2 ** 20, every: 20, linger: 300, queues: async () => [row(slow, sending.get(slow))], say: (j, text) => told.push({ job: j, text }) });
  for (const s of [polled, written, idle, ended]) outbound.add(job, s);
  quick.add(job, slow);
  await after(2);
  written.write('x');
  const how = [polled, written, idle, ended].map(ending);
  let heard = false;
  how[3].then(() => { heard = true; });
  for (const s of [polled, written, idle]) s.destroy();
  outbound.close(ended);
  const since = Date.now();
  quick.close(slow);
  assert.deepEqual(await Promise.all(how.slice(0, 3)), ['ECONNRESET', 'ECONNRESET', 'end']);
  await after(3);
  assert.deepEqual([ended.destroyed, heard], [false, false], 'kept while the kernel has what it was sent');
  sending.delete(ended);
  await until('it to be closed once that is taken', () => ended.destroyed);
  assert.equal(await how[3], 'end');
  assert.equal(told.length, 0, 'and nothing is reset');
  await until('the one not taken to be reset', () => slow.destroyed);
  assert.ok(Date.now() - since >= 300, `after ${Date.now() - since} ms`);
  assert.equal(told.length, 1);
  assert.match(told[0].text, /is reset: the far host had not taken what it was sent 0\.3 s after the job ended it$/);
  outbound.drop(job);
  quick.drop(job);
});

// A socket as the count sees one, of the addresses given.
const standIn = (localAddress, remoteAddress) => Object.assign(new EventEmitter(), {
  localAddress, localPort: 51123, remoteAddress, remotePort: 443, bytesWritten: 0, writableLength: 0, destroyed: false,
  write() { return true; }, _destroy() {}, cork() {}, uncork() {},
  resetAndDestroy() { this.destroyed = true; },
});

await check('the connections a job ended are its own while the kernel has what they were sent: past the whole, they are what is reset of the job past its share, before the fuller connection of a job within its own, and a job dropped has them reset too', async () => {
  const [h, v] = [{}, {}];
  const [h1, h2, v1, v2] = [await connected(), await connected(), await connected(), await connected()];
  for (const s of [h1, h2, v1, v2]) row(s, 0);
  const queued = new Map();
  const { outbound, told, after } = counted({ bytes: 3000, held: () => [h1, h2, v1, v2].map((s) => row(s, queued.get(s) ?? 0)) });
  // v first: the job reset is the one past its share, not the first that holds any.
  for (const [job, s] of [[v, v1], [v, v2], [h, h1], [h, h2]]) outbound.add(job, s);
  await after(2);
  for (const s of [h1, h2]) {
    s.write('x');
    outbound.close(s);
  }
  // 3500 held: h, with 2100 of the 1500 a job may, has its fullest reset; v is within it,
  // though its one connection is the fullest of all.
  for (const [s, n] of [[h1, 1200], [h2, 900], [v1, 1400]]) queued.set(s, n);
  await after(2);
  assert.deepEqual([h1, h2, v1, v2].map((s) => s.destroyed), [true, false, false, false]);
  assert.equal(told.length, 1);
  assert.equal(told[0].job, h);
  assert.match(told[0].text, /is reset: the connections out of all jobs held more than/);
  outbound.drop(h);
  assert.equal(h2.destroyed, true, 'the one ended and still held goes with its job');
  outbound.drop(v);
});

// How a socket ended here goes: 'close', or the error a reset of it was refused with,
// which leaves it open for good and keeps the process from ever exiting.
const gone = (s) => new Promise((resolve) => {
  s.on('error', (e) => { if (e.syscall === 'reset') resolve(`reset refused: ${e.code}`); });
  s.once('close', () => resolve('close'));
});

await check('a connection out the job ends and at once closes while the kernel may have bytes of it to send is reset, and one a dropped job ended with nothing to send is closed: none is reset while its shutdown is under way, which would leave its socket open for good', async () => {
  const [job, other] = [{}, {}];
  const [busy, idle] = [await connected(), await connected()];
  for (const s of [busy, idle]) row(s, 0);
  const { outbound, after } = counted({ bytes: 2 ** 20, held: () => [busy, idle].map((s) => row(s, 0)) });
  outbound.add(job, busy);
  outbound.add(other, idle);
  await after(2);
  const how = [busy, idle].map(gone);
  const far = ending(busy);
  // As an http request does that is torn down as it is sent.
  busy.write('x');
  busy.end();
  busy.destroy();
  idle.end();
  outbound.drop(other);
  assert.deepEqual(await within(Promise.all(how), 'both to go'), ['close', 'close']);
  assert.equal(await far, 'ECONNRESET');
  outbound.drop(job);
});

await check('a connection out the job ends while the kernel has what it was sent is ended once that is taken, and reset if it is not in time; a TLS socket over it ends as it does', async () => {
  const job = {};
  const [taken, untaken, wrapped] = [await connected(), await connected(), await connected()];
  for (const s of [taken, untaken, wrapped]) row(s, 0);
  const sending = new Map([[taken, 700], [untaken, 900], [wrapped, 300]]);
  const { outbound, told, after } = counted({ bytes: 2 ** 20, held: () => [taken, wrapped].map((s) => row(s, sending.get(s) ?? 0)) });
  const quick = createOutbound({ bytes: 2 ** 20, every: 20, linger: 300, queues: async () => [row(untaken, sending.get(untaken))], say: (j, text) => told.push({ job: j, text }) });
  outbound.add(job, taken);
  outbound.add(job, wrapped);
  quick.add(job, untaken);
  // The shutdown of TLS over a connection is all that is looked at of it here.
  const secure = { destroyed: false, ended: 0, _final(cb) { this.ended++; cb(); } };
  outbound.over(wrapped, secure);
  await after(2);
  const how = [taken, untaken].map(ending);
  const [finished, untakenGone] = [new Promise((r) => taken.once('finish', () => r('finish'))), gone(untaken)];
  taken.end();
  untaken.end();
  secure._final(() => {});
  await after(3);
  assert.deepEqual([taken.writableFinished, secure.ended], [false, 0], 'no end while the kernel has what they were sent');
  sending.delete(taken);
  sending.delete(wrapped);
  assert.equal(await within(finished, 'the end once that is taken'), 'finish');
  assert.equal(await how[0], 'end');
  await until('the TLS socket\'s end', () => secure.ended === 1);
  assert.equal(await within(untakenGone, 'the one not taken to go'), 'close');
  assert.equal(await how[1], 'ECONNRESET');
  assert.match(told.at(-1).text, /is reset: the far host had not taken what it was sent 0\.3 s after the job ended it$/);
  outbound.drop(job);
  quick.drop(job);
});

await check('a connection out the job ends or closes while the kernel is being asked is judged by the last answer and what was written since, not by the answer still to come: its end waits for a poll that finds what it was sent taken', async () => {
  const job = {};
  const [ended, closed] = [await connected(), await connected()];
  await until('the far ends to be there', () => [ended, closed].every((s) => far.some((f) => f.remotePort === s.localPort)));
  const answers = [];
  const outbound = createOutbound({ bytes: 2 ** 20, every: 20, queues: () => new Promise((resolve) => answers.push(resolve)) });
  outbound.add(job, ended);
  outbound.add(job, closed);
  // The nth poll's answer, once it has asked.
  const answer = async (n, sending) => {
    await until(`poll ${n}`, () => answers.length >= n);
    return () => answers[n - 1]([ended, closed].map((s) => row(s, sending, sending)));
  };
  (await answer(1, 0))();
  await new Promise(setImmediate);
  // Written after the last answer, and ended while the next poll waits for its own.
  ended.write('x');
  closed.write('x');
  const reply = await answer(2, 1);
  const how = [ended, closed].map(ending);
  let heard = 0;
  for (const h of how) h.then(() => { heard++; });
  ended.end();
  outbound.close(closed);
  await sleep(50);
  assert.equal(heard, 0, 'no end while that poll has not answered');
  reply();
  (await answer(3, 1))();
  await sleep(50);
  assert.equal(heard, 0, 'nor while the kernel has what they were sent');
  (await answer(4, 0))();
  assert.deepEqual(await within(Promise.all(how), 'both to end'), ['end', 'end']);
  outbound.drop(job);
});

await check('a connection out over IPv6 is found as netstat prints it, its addresses written otherwise', async () => {
  const text = [
    'Proto Recv-Q Send-Q  Local Address                                 Foreign Address                               (state)    ',
    'tcp6       0   5000  2001:db8:85a3:8d3:1319:8a2e:370:7348.51123      2606:4700:4700::1111.443                      ESTABLISHED',
  ].join('\n');
  const raw = standIn('2001:0db8:85a3:08d3:1319:8a2e:0370:7348', '2606:4700:4700:0:0:0:0:1111');
  const { outbound, after } = counted({ bytes: 1000, held: () => parseNetstat(text) });
  outbound.add({}, raw);
  await after(2);
  assert.equal(raw.destroyed, true, 'its 5000 bytes are past the whole');
});

// A long address of this machine's, which netstat cuts unless it is asked for whole ones.
const linkLocal = Object.entries(os.networkInterfaces())
  .flatMap(([name, list]) => list.filter((a) => a.family === 'IPv6' && !a.internal && a.address.startsWith('fe80:')).map((a) => `${a.address}%${name}`))
  .find((a) => a.length > 24);
await check('a connection out to a long IPv6 address of this machine is found in what the kernel says', async () => {
  if (!linkLocal) {
    console.log('INFO this machine has no long link-local address to connect to');
    return;
  }
  const server = net.createServer({ pauseOnConnect: true });
  await new Promise((resolve) => server.listen(0, '::', resolve));
  const s = await new Promise((resolve, reject) => {
    const c = net.connect({ port: server.address().port, host: linkLocal }, () => resolve(c));
    c.once('error', reject);
  });
  try {
    const mine = (r) => r.localPort === s.localPort && r.remotePort === s.remotePort && r.local === plainAddress(s.localAddress) && r.remote === plainAddress(s.remoteAddress);
    await until(`${linkLocal} in the kernel's queues`, async () => (await systemQueues()).some(mine), 3000);
  } finally {
    s.destroy();
    server.close();
  }
});

await check('what a job writes past its share is kept back in node until a poll finds the kernel has room for it, counting what was kept back as it goes', async () => {
  const job = {};
  let queued = 0;
  const s = await connected();
  const { outbound, after } = counted({ bytes: 64 * 1024, held: () => [row(s, queued)] });
  // A job whose one connection is closed, and of which the kernel holds nothing, has no share.
  const gone = await connected();
  outbound.add({}, gone);
  gone.destroy();
  outbound.add(job, s);
  await after(2);
  const side = () => far.find((f) => f.remotePort === s.localPort);
  await until('the far end to be there', side);
  let got = 0;
  side().on('data', (d) => { got += d.length; });
  // The fourth 16 KiB reach the share, and from it on all is kept back.
  for (let i = 0; i < 8; i++) s.write(Buffer.alloc(16 * 1024, i));
  // A far end that takes nothing: the kernel holds the share.
  queued = 64 * 1024;
  await after(3);
  assert.equal(got, 48 * 1024, 'what reached the far end before the share was reached');
  assert.equal(s.writableLength, 80 * 1024);
  assert.ok(s.writableCorked > 0);
  // Taken: what was kept back goes.
  queued = 0;
  await until('the rest at the far end', () => got === 128 * 1024);
  assert.equal(s.writableCorked, 0);
  outbound.drop(job);
});

await check('a job whose writes are kept back is asked for at the soonest after, and again while they are, not at the next of the usual polls', async () => {
  const job = {};
  let polls = 0;
  const s = await connected();
  // The first three polls find the share held: the writes wait for the fourth.
  const outbound = createOutbound({ bytes: 1024, every: 1000, soonest: 20, queues: async () => { polls++; return [row(s, polls <= 3 ? 1024 : 0)]; } });
  outbound.add(job, s);
  const side = () => far.find((f) => f.remotePort === s.localPort);
  await until('the far end to be there', side);
  let got = 0;
  side().on('data', (d) => { got += d.length; });
  s.write(Buffer.alloc(4096));
  assert.ok(s.writableCorked > 0);
  const since = Date.now();
  await until('what was kept back at the far end', () => got === 4096);
  assert.ok(Date.now() - since < 600, `after ${Date.now() - since} ms`);
  assert.equal(polls, 4);
  outbound.drop(job);
});

await check('what node has not handed the kernel yet when it is asked is counted as written', async () => {
  const job = {};
  let polls = 0;
  const outbound = createOutbound({ bytes: 4 * 2 ** 20, every: 20, soonest: 5, queues: async () => { polls++; return systemQueues(); } });
  const deaf = net.createServer({ pauseOnConnect: true }, (f) => f.on('error', () => {}));
  const port = await listening(deaf);
  const s = await new Promise((resolve) => { const c = net.connect(port, '127.0.0.1', () => resolve(c)); });
  try {
    outbound.add(job, s);
    // Within the share: the kernel takes what it has room for, a few hundred KiB, and the
    // rest waits in node.
    s.write(Buffer.alloc(3 * 2 ** 20));
    assert.ok(s.writableLength > 2 * 2 ** 20, `${s.writableLength} bytes wait in node`);
    const at = polls;
    await until('two polls', () => polls >= at + 2);
    s.write(Buffer.alloc(1.5 * 2 ** 20));
    assert.ok(s.writableCorked > 0, 'what waited in node and this write reach the share');
  } finally {
    outbound.drop(job);
    deaf.close();
  }
});

await check('polls that fail stop no job and are told of once: what was kept back goes, a job may have the fallback\'s connections out open and no more, and polls that work again are told of too', async () => {
  const job = {};
  let failing = false;
  const sockets = [await connected(), await connected(), await connected()];
  const ended = await connected();
  const { outbound, told, after } = counted({ bytes: 1, held: () => [], fail: () => failing });
  outbound.add(job, sockets[0]);
  sockets[0].write('x');
  assert.ok(sockets[0].writableCorked > 0, 'past the share');
  outbound.add({}, ended);
  ended.write('z');
  outbound.close(ended);
  assert.equal(ended.destroyed, false, 'an ended connection with bytes to send is kept');
  failing = true;
  await after(4);
  assert.equal(sockets[0].writableCorked, 0, 'let go while polls fail');
  assert.equal(ended.destroyed, true, 'and one ended is closed, nothing telling any longer when its bytes are taken');
  assert.deepEqual(told.map((t) => [t.job, t.text]), [[null, 'the kernel\'s queues of the connections out cannot be read (netstat went): until they can, a job may have 3 connections out open, and what they hold is not counted']]);
  // Nor is one ended and at once closed reset: its shutdown has begun.
  const shutting = await connected();
  outbound.add({}, shutting);
  const shuttingGone = gone(shutting);
  shutting.write('w');
  shutting.end();
  shutting.destroy();
  assert.equal(await within(shuttingGone, 'it to go'), 'close');
  outbound.add(job, sockets[1]);
  sockets[1].write('y');
  assert.equal(sockets[1].writableCorked, 0, 'and nothing is kept back');
  assert.equal(outbound.full(job), false);
  outbound.add(job, sockets[2]);
  assert.equal(outbound.full(job), true);
  assert.equal(outbound.full({}), false, 'another job is not');
  sockets[2].destroy();
  await new Promise((resolve) => sockets[2].once('close', resolve));
  assert.equal(outbound.full(job), false, 'a closed connection is not open');
  assert.ok(sockets.slice(0, 2).every((s) => !s.destroyed), 'nothing is reset');
  failing = false;
  await after(2);
  assert.deepEqual(told.slice(1).map((t) => [t.job, t.text]), [[null, 'the kernel\'s queues of the connections out can be read again']]);
  assert.equal(outbound.full(job), false);
  outbound.drop(job);
});

// ---- through the broker, on this machine's kernel

const block = Buffer.alloc(64 * 1024, 'd');
const deaf = net.createServer({ pauseOnConnect: true }, (s) => { s.on('error', () => {}); });
const source = net.createServer((s) => {
  s.on('error', () => {});
  const pump = () => { while (s.writable && s.write(block)); };
  s.on('drain', pump);
  pump();
});
const echo = net.createServer((s) => { s.on('error', () => {}); s.pipe(s); });
// Reads to the job's end, then answers 2 MiB and closes.
const burst = net.createServer({ allowHalfOpen: true }, (s) => {
  s.on('error', () => {});
  s.on('end', () => s.end(Buffer.alloc(2 ** 21, 5))).resume();
});
// Ends its side at once, and counts what it is sent until the job ends its own.
const heardHalfway = [];
const halfway = net.createServer({ allowHalfOpen: true }, (s) => {
  s.on('error', () => {});
  let n = 0;
  s.on('data', (d) => { n += d.length; }).on('end', () => heardHalfway.push(n));
  s.end('ready');
});
const ports = { '93.184.216.1': await listening(deaf), '93.184.216.2': await listening(source), '93.184.216.3': await listening(echo), '93.184.216.4': await listening(burst), '93.184.216.5': await listening(halfway) };
const addresses = { 'deaf.test': '93.184.216.1', 'source.test': '93.184.216.2', 'echo.test': '93.184.216.3', 'burst.test': '93.184.216.4', 'halfway.test': '93.184.216.5' };
const lookup = async (name) => [{ address: addresses[name], family: 4, name }];
const connect = ({ host }) => new Promise((resolve, reject) => {
  const s = net.connect(ports[host], '127.0.0.1', () => resolve(s));
  s.once('error', reject);
});
const logged = [];
const brokerWith = async (outbound, limits) => {
  const broker = createBroker({ ca: createCA(), llm: { authorize: async (h) => h, refused: async () => null }, mirrors: { path: () => null },
    onForge: async () => ({ status: 200, headers: {}, body: '' }), lookup, connect, outbound, limits, log: (...a) => logged.push(a.join(' ')) });
  const { port } = await broker.start({ port: 0 });
  let runs = 0;
  const addJob = async () => {
    const runId = `run${runs++}`;
    const { token } = await broker.addJob({ runId, pool: { id: 'github.com/a/b', forge: 'github', host: 'github.com', owner: 'a', repo: 'b' } });
    return { runId, auth: `Basic ${Buffer.from(`dn:${token}`).toString('base64')}` };
  };
  // A relay in front of this broker, as a job's container has: `{ port, end() }`, where
  // end() kills it.
  const relay = async () => {
    const free = net.createServer();
    const at = await listening(free);
    await new Promise((r) => free.close(r));
    const child = spawn(process.execPath, [RELAY, '127.0.0.0/8', String(at), '127.0.0.1', String(port)], { stdio: ['ignore', 'pipe', 'ignore'] });
    const end = () => child.kill('SIGKILL');
    process.on('exit', end);
    await new Promise((resolve) => child.stdout.once('data', resolve));
    return { port: at, end };
  };
  // A tunnel, straight to the broker or through a relay at `via`: resolves to the socket,
  // paused, and the head of the answer.
  const tunnel = (job, host, via = port, allowHalfOpen = false) => new Promise((resolve, reject) => {
    const s = net.connect({ port: via, host: '127.0.0.1', allowHalfOpen });
    s.on('error', () => {});
    s.write(`CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\nProxy-Authorization: ${job.auth}\r\n\r\n`);
    let head = Buffer.alloc(0);
    const opened = (d) => {
      head = Buffer.concat([head, d]);
      const at = head.indexOf('\r\n\r\n');
      if (at === -1) return;
      s.pause();
      s.off('data', opened);
      if (head.length > at + 4) s.unshift(head.subarray(at + 4));
      resolve({ s, head: head.subarray(0, at).toString() });
    };
    s.on('data', opened);
    s.once('close', () => reject(new Error(`closed: ${head}`)));
  });
  // A plain request with a body that never ends.
  const upload = (job, host) => {
    const s = net.connect(port, '127.0.0.1');
    s.on('error', () => {});
    s.write(`POST http://${host}/ HTTP/1.1\r\nHost: ${host}\r\nProxy-Authorization: ${job.auth}\r\nContent-Length: ${2 ** 40}\r\n\r\n`);
    return s;
  };
  return { broker, addJob, tunnel, upload, relay };
};
// What the broker's own connections to `host` hold in the kernel, either way.
const outOf = async (host) => {
  const to = ports[addresses[host]];
  return (await systemQueues()).filter((r) => r.remotePort === to).reduce((sum, r) => sum + r.bytes, 0);
};

await check('jobs that upload to a host that reads nothing, down many tunnels or as plain requests, hold no more of the kernel than their shares and lose no connection for it; once they are removed the kernel holds nothing of them', async () => {
  const bytes = 2 * 2 ** 20;
  const { broker, addJob, tunnel, upload } = await brokerWith({ bytes });
  const [tunnels, plain] = [await addJob(), await addJob()];
  const sending = [];
  try {
    for (let i = 0; i < 32; i++) sending.push((await tunnel(tunnels, 'deaf.test')).s);
    for (let i = 0; i < 32; i++) sending.push(upload(plain, 'deaf.test'));
    // Both jobs' connections out are there before either sends: neither has had the whole.
    await until('the plain requests\' connections out', () => broker.load(plain.runId).upstreams === 32);
    for (const s of sending) {
      const pump = () => { while (!s.destroyed && s.write(block)); };
      s.on('drain', pump);
      pump();
    }
    let most = 0;
    for (const end = Date.now() + 3000; Date.now() < end; await sleep(20)) most = Math.max(most, await outOf('deaf.test'));
    assert.ok(most > bytes / 2 && most <= bytes, `the connections out held ${most} bytes at most`);
    assert.deepEqual([broker.load(tunnels.runId).connections, broker.load(plain.runId).upstreams], [32, 32], 'and none was lost');
    broker.removeJob(tunnels.runId);
    broker.removeJob(plain.runId);
    let left = -1;
    for (const end = Date.now() + 2000; Date.now() < end && left !== 0; await sleep(20)) left = await outOf('deaf.test');
    assert.equal(left, 0, 'what the kernel holds of a removed job\'s connections out');
  } finally {
    for (const s of sending) s.destroy();
    await broker.stop();
  }
});

await check('a job that leaves downloads unread loses its connections out that hold the most until all jobs are within the whole, and a job whose downloads are read loses nothing', async () => {
  // Little enough that 16 downloads left unread are past it on Linux too, where the
  // bytes wait mostly on the job's side of the broker.
  const bytes = 256 * 1024;
  const { broker, addJob, tunnel } = await brokerWith({ bytes });
  const [greedy, fair] = [await addJob(), await addJob()];
  // A tunnel the broker closes is not seen closed by a job that reads nothing of it.
  const open = (job) => broker.load(job.runId).connections;
  const opened = [];
  try {
    for (let i = 0; i < 16; i++) opened.push(await tunnel(greedy, 'source.test'));
    await until('one of the unread ones to be reset', () => open(greedy) < 16);
    // The fair job reads what it is sent as it comes: 64 KiB there and back, again and again.
    const echoing = (await tunnel(fair, 'echo.test')).s;
    echoing.resume();
    for (let i = 0; i < 64; i++) {
      const back = new Promise((resolve) => {
        let n = 0;
        const take = (d) => { n += d.length; if (n >= block.length) { echoing.off('data', take); resolve(); } };
        echoing.on('data', take);
      });
      echoing.write(block);
      await back;
    }
    assert.equal(open(fair), 1, 'the job whose downloads are read lost nothing');
    // Once within the whole, the rest stay.
    await sleep(3 * OUT_POLL_MS);
    const left = open(greedy);
    await sleep(3 * OUT_POLL_MS);
    assert.equal(open(greedy), left);
    assert.ok(await outOf('source.test') <= bytes, 'and what is left is within the whole');
    assert.ok(logged.some((l) => l.includes(greedy.runId) && l.includes(`a connection out of this job to 127.0.0.1:${ports[addresses['source.test']]} is reset`)));
  } finally {
    for (const { s } of opened) s.destroy();
    await broker.stop();
  }
});

await check('a job that comes while another\'s uploads hold the whole loses nothing for it: the jobs are past the whole by no more than its share, and within it again once a poll has come', async () => {
  const bytes = 2 * 2 ** 20;
  const { broker, addJob, tunnel } = await brokerWith({ bytes });
  const [first, late] = [await addJob(), await addJob()];
  const sending = [];
  const pump = (s) => {
    const more = () => { while (!s.destroyed && s.write(block)); };
    s.on('drain', more);
    more();
  };
  let most = 0;
  let watching = true;
  const watch = (async () => { while (watching) { most = Math.max(most, await outOf('deaf.test')); await sleep(10); } })();
  try {
    for (let i = 0; i < 32; i++) sending.push((await tunnel(first, 'deaf.test')).s);
    sending.forEach(pump);
    await until('the first job to hold most of the whole', () => most > bytes * 3 / 4);
    const lates = [];
    for (let i = 0; i < 8; i++) lates.push((await tunnel(late, 'deaf.test')).s);
    lates.forEach(pump);
    await sleep(6 * OUT_POLL_MS);
    assert.equal(broker.load(late.runId).connections, 8, 'the late job lost nothing');
    assert.ok(most <= bytes * 1.5, `the connections out held ${most} bytes at most`);
    let now = Infinity;
    for (const end = Date.now() + 2000; Date.now() < end && now > bytes; await sleep(10)) now = await outOf('deaf.test');
    assert.ok(now > bytes / 2 && now <= bytes, `and hold ${now} bytes`);
    sending.push(...lates);
  } finally {
    watching = false;
    await watch;
    for (const s of sending) s.destroy();
    await broker.stop();
  }
});

await check('a job\'s tunnels that it ends while the kernel has what they sent are kept until the linger and then reset, and reset as the job is removed: the kernel keeps nothing of them', async () => {
  const linger = 1500;
  const to = ports[addresses['deaf.test']];
  const echoing = ports[addresses['echo.test']];
  // The kernel, but with one more byte to send to deaf.test on every connection there,
  // so that its far host never takes all it was sent, and a gigabyte on every connection
  // to echo.test.
  const queues = async () => (await systemQueues()).map((r) => {
    if (r.remotePort === to) return { ...r, bytes: r.bytes + 1, sending: r.sending + 1 };
    return r.remotePort === echoing ? { ...r, bytes: 2 ** 30 } : r;
  });
  const { broker, addJob, tunnel, relay } = await brokerWith({ linger, queues });
  const h = await addJob();
  // What there is of the connections out to deaf.test, as the kernel has them.
  const rows = async () => (await systemQueues()).filter((r) => r.remotePort === to).length;
  try {
    // The job's tunnels through its relay, which then goes as its container would: the
    // broker reads no more of a tunnel whose far host takes nothing, so it learns of their
    // end from the hop alone.
    const ended = async () => {
      const theirs = await relay();
      const hs = [];
      for (let i = 0; i < 4; i++) hs.push((await tunnel(h, 'deaf.test', theirs.port)).s);
      for (const s of hs) s.write(Buffer.alloc(64 * 1024));
      await until('the connections out', async () => (await rows()) === 4);
      theirs.end();
      for (const s of hs) s.destroy();
      await until('the broker to see them go', () => broker.load(h.runId).connections === 0, 3000);
      return Date.now();
    };
    // Reset for the whole first, which is told of apart from what is reset after the linger.
    const before = logged.length;
    const since = () => logged.slice(before);
    const { s: big } = await tunnel(h, 'echo.test');
    await until('the gigabyte to be reset', () => since().some((l) => l.includes(h.runId) && l.includes('is reset: the connections out of all jobs held more than')), 3000);
    big.destroy();
    const at = await ended();
    await sleep(3 * OUT_POLL_MS);
    assert.equal(await rows(), 4, 'kept while the kernel has what they were sent');
    await until('them to be reset after the linger', async () => (await rows()) === 0, linger + 2000);
    assert.ok(Date.now() - at >= linger, `after ${Date.now() - at} ms`);
    assert.ok(since().some((l) => l.includes(h.runId) && l.includes(`had not taken what it was sent ${linger / 1000} s after the job ended it`)));
    await ended();
    broker.removeJob(h.runId);
    await until('them to be reset as the job is removed', async () => (await rows()) === 0, 1000);
  } finally {
    await broker.stop();
  }
});

await check('a tunnel a job closed keeps its place among the job\'s connections while its connection out is held for what it was sent: past them, a tunnel is refused until those go', async () => {
  const linger = 1500;
  const to = ports[addresses['deaf.test']];
  // The kernel, but with one more byte to send on every connection to deaf.test, which so
  // never takes all it was sent.
  const queues = async () => (await systemQueues()).map((r) => (r.remotePort === to ? { ...r, bytes: r.bytes + 1, sending: r.sending + 1 } : r));
  const { broker, addJob, tunnel } = await brokerWith({ linger, queues }, { connections: 4 });
  const t = await addJob();
  try {
    const four = [];
    for (let i = 0; i < 4; i++) four.push((await tunnel(t, 'deaf.test')).s);
    // Polled, and so found to have what they were sent still to send.
    await sleep(2 * OUT_POLL_MS);
    for (const s of four) s.resetAndDestroy();
    await until('the broker to see them go', () => broker.load(t.runId).connections === 0, 3000);
    const closed = Date.now();
    const refused = await tunnel(t, 'deaf.test');
    assert.match(refused.head, /^HTTP\/1\.1 503 /);
    const said = await within(new Promise((resolve) => {
      let body = '';
      refused.s.on('data', (d) => { body += d; }).on('end', () => resolve(body)).resume();
    }), 'the refusal');
    assert.equal(said, 'this job has 4 connections open through the broker, 4 of them tunnels it closed whose far hosts have not yet taken what they were sent, the most a job gets at a time: close some\n');
    refused.s.destroy();
    let again;
    for (;;) {
      again = await tunnel(t, 'deaf.test');
      if (again.head.startsWith('HTTP/1.1 200 ')) break;
      again.s.destroy();
      await sleep(50);
    }
    again.s.destroy();
    assert.ok(Date.now() - closed >= linger, `a tunnel had its place ${Date.now() - closed} ms after the others closed`);
  } finally {
    await broker.stop();
  }
});

await check('each way of a tunnel ends on its own, straight to the broker and through a relay: all a far host answers after the job ended its side reaches the job, read late, though the far host closed at once, and all a job writes after its far host ended its side reaches that host, and then the job\'s end', async () => {
  const { broker, addJob, tunnel, relay } = await brokerWith({});
  const h = await addJob();
  const theirs = await relay();
  try {
    for (const via of [undefined, theirs.port]) {
      for (let i = 0; i < 3; i++) {
        const { s } = await tunnel(h, 'burst.test', via, true);
        s.end('the question');
        let got = 0;
        s.on('data', (d) => { got += d.length; });
        const ended = new Promise((resolve) => s.once('end', resolve));
        await sleep(300);
        s.resume();
        await within(ended, 'the burst\'s end');
        assert.equal(got, 2 ** 21, via ? 'through the relay' : 'straight');
        s.destroy();
      }
      const before = heardHalfway.length;
      const { s } = await tunnel(h, 'halfway.test', via, true);
      let said = '';
      s.on('data', (d) => { said += d; });
      s.resume();
      await until('the far host\'s end', () => said === 'ready' && s.readableEnded, 3000);
      s.end(Buffer.alloc(64 * 1024, 1));
      await until('the far host to hear the job\'s end', () => heardHalfway.length > before, 3000);
      assert.equal(heardHalfway.at(-1), 64 * 1024, via ? 'through the relay' : 'straight');
      s.destroy();
    }
  } finally {
    theirs.end();
    await broker.stop();
  }
});

await check('while the kernel cannot be asked, a job\'s tunnel past the fallback\'s connections out is refused and the rest carry on', async () => {
  const { broker, addJob, tunnel } = await brokerWith({ queues: async () => { throw new Error('no table'); }, fallback: 2 });
  const job = await addJob();
  const opened = [];
  try {
    opened.push(await tunnel(job, 'echo.test'));
    await until('a poll to have failed', () => logged.some((l) => l.includes('cannot be read (no table)')));
    opened.push(await tunnel(job, 'echo.test'));
    const refused = await tunnel(job, 'echo.test');
    assert.match(refused.head, /^HTTP\/1\.1 503 /);
    opened.push(refused);
    const said = await new Promise((resolve) => {
      let t = '';
      refused.s.on('data', (d) => { t += d; }).on('close', () => resolve(t)).resume();
    });
    assert.match(said, /this job has 2 connections out open, the most a job gets while this machine cannot tell what they hold: close some/);
    const { s } = opened[0];
    s.resume();
    const back = new Promise((resolve) => s.once('data', resolve));
    s.write('still here');
    assert.equal(String(await back), 'still here');
    assert.equal(logged.filter((l) => l.includes('cannot be read')).length, 1, 'told of once');
  } finally {
    for (const { s } of opened) s.destroy();
    await broker.stop();
  }
});

for (const s of far) s.destroy();
for (const server of [sink, deaf, source, echo]) server.close();
console.log(`\nall ${checks} checks passed`);
process.exit(0);
