// The broker's connections out (outbound.js): the kernel's tables are read as they
// are, what the count finds is held to a share each job, kept back as it is written and
// reset when it comes in past the whole, and polls that fail stop nothing; through the
// broker, on this machine's kernel, connections out that nobody answers or reads hold no
// more than the whole.
// Run: node test/executor-outbound.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'dn-outbound-'));
Object.assign(process.env, {
  DN_BASE_DIR: path.join(scratch, 'base'), DN_BROKER_BIND: '127.0.0.1', DN_RELAY_HOST: '127.0.0.1',
  DIPLOMAT_CONFIG: path.join(scratch, 'config.json'),
});
const { createBroker } = await import('../src/executor/broker.js');
const { createCA } = await import('../src/executor/ca.js');
const { OUT_BYTES, OUT_FALLBACK, OUT_POLL_MS, OUT_SOONEST_MS, createOutbound, parseNetstat, parseProc, plainAddress, systemQueues } = await import('../src/executor/outbound.js');
assert.deepEqual([OUT_BYTES, OUT_POLL_MS, OUT_SOONEST_MS, OUT_FALLBACK], [32 * 2 ** 20, 500, 100, 32], 'what the README states');

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
  for (const end = Date.now() + ms; !met();) {
    if (Date.now() > end) assert.fail(`never: ${what}`);
    await sleep(5);
  }
};
const listening = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

// Connections on this machine, each with the far end the test holds.
const far = [];
const sink = net.createServer((s) => {
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
const row = (s, bytes) => {
  if (!tuples.has(s)) tuples.set(s, { local: plainAddress(s.localAddress), localPort: s.localPort, remote: plainAddress(s.remoteAddress), remotePort: s.remotePort });
  return { ...tuples.get(s), bytes };
};

await check('the kernel\'s tables are read as Linux and macOS write them: each connection by its addresses and ports with what is queued either way, listening sockets left out, and a table of anything else refused', async () => {
  const proc = [
    '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
    '   0: 0100007F:0050 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 1 1 0 100 0 0 10 0',
    '   1: 0100007F:D431 22D8B85D:01BB 01 00000010:00000020 00:00000000 00000000  1000        0 2 1 0 20 4 30 10 -1',
  ].join('\n');
  assert.deepEqual(parseProc(proc), [{ local: '127.0.0.1', localPort: 54321, remote: '93.184.216.34', remotePort: 443, bytes: 48 }]);
  const proc6 = [
    '  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
    '   0: B80D0120000000000000000001000000:9C40 B80D0120000000000000000002000000:01BB 01 00100000:00000000 00:00000000 00000000  1000        0 3 1 0 20 4 30 10 -1',
    '   1: 0000000000000000FFFF00000100007F:9C41 0000000000000000FFFF0000020000C0:0050 01 00000000:00000001 00:00000000 00000000  1000        0 4 1 0 20 4 30 10 -1',
  ].join('\n');
  assert.deepEqual(parseProc(proc6), [
    { local: plainAddress('2001:db8::1'), localPort: 40000, remote: plainAddress('2001:db8::2'), remotePort: 443, bytes: 0x100000 },
    { local: plainAddress('::ffff:127.0.0.1'), localPort: 40001, remote: plainAddress('::ffff:192.0.0.2'), remotePort: 80, bytes: 1 },
  ]);
  assert.equal(plainAddress('2001:db8::1'), '2001:db8:0:0:0:0:0:1');
  assert.throws(() => parseProc('Inter-|   Receive\n face |bytes'), /not a table of TCP sockets/);
  const netstat = [
    'Active Internet connections (including servers)',
    'Proto Recv-Q Send-Q  Local Address          Foreign Address        (state)    ',
    'tcp4       0  12345  192.168.1.20.51122     93.184.216.34.443      ESTABLISHED',
    'tcp6     700      0  2001:db8:85a3:8d3.51123 2606:4700:4700::.443  ESTABLISHED',
    'tcp6       0      0  ::1.51124              ::1.8080               ESTABLISHED',
    'tcp4       0      0  *.22                   *.*                    LISTEN     ',
    'tcp4       0      0  *.62926                *.*                    CLOSED     ',
    'tcp4       0      0  *.*                    *.*                    CLOSED     ',
  ].join('\n');
  assert.deepEqual(parseNetstat(netstat), [
    { local: '192.168.1.20', localPort: 51122, localCut: false, remote: '93.184.216.34', remotePort: 443, remoteCut: false, bytes: 12345 },
    { local: '2001:db8:85a3:8d3', localPort: 51123, localCut: true, remote: '2606:4700:4700::', remotePort: 443, remoteCut: true, bytes: 700 },
    { local: plainAddress('::1'), localPort: 51124, localCut: false, remote: plainAddress('::1'), remotePort: 8080, remoteCut: false, bytes: 0 },
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

await check('past the whole, the job that holds the most loses its connections out that hold the most until all are within it, a closed one still counted while the kernel holds its bytes, and within the whole nothing is lost', async () => {
  const a = { name: 'a' };
  const b = { name: 'b' };
  const [a1, a2, a3, b1] = [await connected(), await connected(), await connected(), await connected()];
  for (const s of [a1, a2, a3, b1]) row(s, 0);
  const queued = new Map([[a1, 1500], [a2, 1000], [b1, 1800]]);
  // A reset connection is let go of by the kernel at once, and one closed is not.
  const lingering = new Set();
  // Another connection on a3's ports, to an address that only begins as a3's does.
  const other = { ...row(a3, 0), local: '127.0.0', remote: '127.0.0', bytes: 2 ** 30 };
  const held = () => [other, ...[...queued].filter(([s]) => !s.destroyed || lingering.has(s)).map(([s, n]) => row(s, n))];
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
  // a2 closes with 1000 the kernel still holds: with 1100 more of a3 that is 3900, and a3,
  // the one of a's that can be reset, is; then 2800 are within it again.
  queued.set(a3, 1100);
  lingering.add(a2);
  a2.destroy();
  await after(2);
  assert.deepEqual([a3.destroyed, b1.destroyed], [true, false], 'what a closed connection holds is counted');
  // Once the kernel lets go of it, it is not.
  lingering.delete(a2);
  queued.set(b1, 2900);
  await after(3);
  assert.equal(b1.destroyed, false);
  assert.equal(told.length, 2);
  outbound.drop(b);
  assert.equal(b1.destroyed, true, 'a job dropped has its connections reset');
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

await check('a job whose writes are kept back is asked for at the soonest after, not at the next of the usual polls', async () => {
  const job = {};
  let polls = 0;
  const s = await connected();
  const outbound = createOutbound({ bytes: 1024, every: 1000, soonest: 20, queues: async () => { polls++; return [row(s, 0)]; } });
  outbound.add(job, s);
  const side = () => far.find((f) => f.remotePort === s.localPort);
  await until('the far end to be there', side);
  let got = 0;
  side().on('data', (d) => { got += d.length; });
  s.write(Buffer.alloc(4096));
  assert.ok(s.writableCorked > 0);
  const since = Date.now();
  await until('what was kept back at the far end', () => got === 4096);
  assert.ok(Date.now() - since < 300, `after ${Date.now() - since} ms`);
  assert.equal(polls, 1);
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
  const { outbound, told, after } = counted({ bytes: 1, held: () => [], fail: () => failing });
  outbound.add(job, sockets[0]);
  sockets[0].write('x');
  assert.ok(sockets[0].writableCorked > 0, 'past the share');
  failing = true;
  await after(4);
  assert.equal(sockets[0].writableCorked, 0, 'let go while polls fail');
  assert.deepEqual(told.map((t) => [t.job, t.text]), [[null, 'the kernel\'s queues of the connections out cannot be read (netstat went): until they can, a job may have 3 connections out open, and what they hold is not counted']]);
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
const ports = { '93.184.216.1': await listening(deaf), '93.184.216.2': await listening(source), '93.184.216.3': await listening(echo) };
const addresses = { 'deaf.test': '93.184.216.1', 'source.test': '93.184.216.2', 'echo.test': '93.184.216.3' };
const lookup = async (name) => [{ address: addresses[name], family: 4, name }];
const connect = ({ host }) => new Promise((resolve, reject) => {
  const s = net.connect(ports[host], '127.0.0.1', () => resolve(s));
  s.once('error', reject);
});
const logged = [];
const brokerWith = async (outbound) => {
  const broker = createBroker({ ca: createCA(), llm: { authorize: async (h) => h, refused: async () => null }, mirrors: { path: () => null },
    onForge: async () => ({ status: 200, headers: {}, body: '' }), lookup, connect, outbound, log: (...a) => logged.push(a.join(' ')) });
  const { port } = await broker.start({ port: 0 });
  let runs = 0;
  const addJob = async () => {
    const runId = `run${runs++}`;
    const { token } = await broker.addJob({ runId, pool: { id: 'github.com/a/b', forge: 'github', host: 'github.com', owner: 'a', repo: 'b' } });
    return { runId, auth: `Basic ${Buffer.from(`dn:${token}`).toString('base64')}` };
  };
  // A tunnel: resolves to the socket and the head of the answer.
  const tunnel = (job, host) => new Promise((resolve, reject) => {
    const s = net.connect(port, '127.0.0.1');
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
  return { broker, addJob, tunnel, upload };
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
