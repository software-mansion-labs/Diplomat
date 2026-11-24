// The broker before a request is any job's work: a connection's first request head, read
// off the socket; the one answer a connection without a live token gets; the connections
// that are no job's; and the names a job asks for - the ones refused unasked, how many
// are asked at a time and for how long, and the resolver that asks them. Against an
// internet that is a table in this file and a name server on a local UDP port.
// Run: node test/executor-front.mjs

import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { scratchDir } from './lib/scratch.mjs';

const scratch = scratchDir('dn-front-');
Object.assign(process.env, { DN_BASE_DIR: path.join(scratch, 'base'), DN_BROKER_BIND: '127.0.0.1', DN_RELAY_HOST: '127.0.0.1' });
const { createBroker, dnsLookup, localName, JOB_LOOKUPS, LOOKUP_MS, STRANGERS } = await import('../src/executor/broker.js');
const { createCA } = await import('../src/executor/ca.js');

let checks = 0;
const check = async (name, fn) => { await fn(); checks++; console.log(`PASS ${name}`); };
const faults = [];
process.on('uncaughtException', (e) => faults.push(e));
process.on('unhandledRejection', (e) => faults.push(e));
process.on('warning', (e) => faults.push(e));
const until = async (met, what, ms = 30000) => {
  for (const end = Date.now() + ms; !met();) {
    if (Date.now() > end) throw new Error(`never: ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
};
const within = (promise, what, ms = 30000) => {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`never: ${what}`)), ms); })]).finally(() => clearTimeout(timer));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- the internet: names, the addresses they resolve to, and what answers there

const names = new Map(); // name -> [{ address, family }] or a function returning them
const routes = new Map(); // "address:port" -> local port
const lookups = [];
const dials = [];
const lookup = async (host) => {
  lookups.push(host);
  const hit = names.get(host);
  if (!hit) throw Object.assign(new Error('not found'), { code: 'ENOTFOUND' });
  return typeof hit === 'function' ? hit() : hit;
};
const connect = ({ host, port }) => new Promise((resolve, reject) => {
  dials.push(`${host}:${port}`);
  const local = routes.get(`${host}:${port}`);
  if (!local) return reject(Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }));
  const s = net.connect(local, '127.0.0.1', () => resolve(s));
  s.once('error', reject);
});
const servers = [];
const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => { servers.push(server); resolve(server.address().port); }));
const PUBLIC = '93.184.216.34';
const echo = net.createServer((s) => { s.on('error', () => {}); s.write('hello from the internet\n'); s.pipe(s); });
names.set('tunnel.test', [{ address: PUBLIC, family: 4 }]);
routes.set(`${PUBLIC}:443`, await listen(echo));
const plainSeen = [];
const plain = http.createServer((req, res) => {
  let size = 0;
  req.on('data', (c) => { size += c.length; });
  req.on('end', () => {
    plainSeen.push({ url: req.url, size });
    res.end(`plain says ${req.url}`);
  });
});
names.set('plain.test', [{ address: '93.184.216.40', family: 4 }]);
routes.set('93.184.216.40:80', await listen(plain));

const pool = { id: 'github.com/dn-test/alpha', forge: 'github', host: 'github.com', owner: 'dn-test', repo: 'alpha' };
let port = 0;
const logged = [];
// A broker of its own for each check: `fn(broker, traced)`, `traced` being what it traced.
const withBroker = async (more, fn) => {
  const traced = [];
  const b = createBroker({ log: (...a) => logged.push(a.join(' ')), ca: createCA(), llm: { authorize: async (h) => h, refused: async () => null }, mirrors: { path: () => null },
    onForge: async () => ({ status: 200, headers: {}, body: '' }), lookup, connect, trace: (line) => traced.push(line), ...more });
  port = (await b.start({ port: 0 })).port;
  try { await fn(b, traced); } finally { await within(b.stop(), 'the broker to stop'); }
};

const basic = (user, pass) => `Proxy-Authorization: Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}\r\n`;
const DENY = 'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="dn"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n';
const get = (auth, p) => `GET http://plain.test/${p} HTTP/1.1\r\nHost: plain.test\r\n${auth}\r\n`;
const statuses = (text) => [...text.matchAll(/HTTP\/1\.1 (\d{3}) /g)].map((m) => Number(m[1]));

// A connection to the broker that stays open when the broker has said its last:
// `{ socket, said(), ended(), gone() }`, gone being ended or closed by the broker.
const opened = [];
async function open() {
  const socket = net.connect({ port, host: '127.0.0.1', allowHalfOpen: true });
  let text = '';
  let ended = false;
  let closed = false;
  socket.on('data', (d) => { text += d.toString('latin1'); });
  socket.on('end', () => { ended = true; });
  socket.on('close', () => { closed = true; });
  socket.on('error', () => {});
  await new Promise((resolve) => { socket.once('connect', resolve); });
  opened.push(socket);
  return { socket, said: () => text, ended: () => ended, gone: () => ended || closed };
}
// Bytes written whole, and everything the broker said until it ended the connection.
async function raw(bytes) {
  const c = await open();
  c.socket.write(bytes);
  await until(() => c.gone(), 'the broker to end the connection');
  c.socket.destroy();
  return c.said();
}
// One CONNECT under `auth`: `{ status, body, socket }`, body being what followed the head
// by the time the broker ended the connection, or for a tunnel by now.
async function tunnel(target, auth) {
  const c = await open();
  c.socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${auth}\r\n`);
  await until(() => c.said().includes('\r\n\r\n') || c.gone(), `an answer to CONNECT ${target}`);
  const status = statuses(c.said())[0] ?? 0;
  if (status !== 200) {
    await until(() => c.gone(), 'the broker to end a refused connection');
    c.socket.destroy();
  }
  return { status, body: c.said().slice(c.said().indexOf('\r\n\r\n') + 4), socket: c.socket, said: c.said };
}

try {
  await check('a connection that names no admitted job is answered 407 once and nothing more of it is read as requests: what follows is dropped, and past 64 KiB the connection is reset', async () => {
    await withBroker({}, async (b, traced) => {
      const gone = await b.addJob({ runId: 'gone', pool });
      b.removeJob('gone');
      // The shortest request there is, 3640 to a block of 64 KiB.
      const block = Buffer.from('GET / HTTP/1.1\r\n\r\n'.repeat(3640));
      const cases = { 'no token': '', 'a token nobody has': basic('dn', 'f'.repeat(64)), 'the wrong user': basic('root', gone.token), 'the token of a job that ended': basic('dn', gone.token) };
      for (const [what, auth] of Object.entries(cases)) {
        traced.length = 0;
        const c = await open();
        const reset = new Promise((resolve) => c.socket.once('error', (e) => resolve(e.code)));
        c.socket.write(get(auth, 'first'));
        for (let i = 0; i < 64; i++) c.socket.write(block);
        assert.match(await within(reset, `${what}: the connection to be reset`, 5000), /^(ECONNRESET|EPIPE)$/, what);
        // The reset can overtake the answer: one that sends on unasked is not waited for.
        assert.ok(['', DENY].includes(c.said()), what);
        assert.deepEqual(traced, ['407 GET http://plain.test/first'], what);
        c.socket.destroy();
      }
      // One that sends a little more and then waits is answered, and not reset.
      const polite = await open();
      let failed = null;
      polite.socket.once('error', (e) => { failed = e.code; });
      polite.socket.write(get('', 'quiet') + 'x'.repeat(60000));
      await until(() => polite.ended(), 'the refusal');
      await sleep(300);
      assert.deepEqual([polite.said(), failed, polite.socket.destroyed], [DENY, null, false]);
      polite.socket.destroy();
      // A CONNECT is named by its target.
      traced.length = 0;
      assert.equal(await raw(`CONNECT tunnel.test:443 HTTP/1.1\r\nHost: tunnel.test:443\r\n\r\n${'x'.repeat(100000)}`), DENY);
      assert.deepEqual(traced, ['407 CONNECT tunnel.test:443']);
      assert.deepEqual([lookups.length, dials.length, plainSeen.length], [0, 0, 0]);
    });
  });

  await check('a connection is the job\'s whose token its first request carried: a request on it without that token is answered 407 in its turn, and is its last', async () => {
    await withBroker({}, async (b, traced) => {
      const mine = await b.addJob({ runId: 'mine', pool });
      const theirs = await b.addJob({ runId: 'theirs', pool });
      const cases = { 'no token': '', 'a token nobody has': basic('dn', 'e'.repeat(64)), 'another job\'s token': basic('dn', theirs.token) };
      for (const [what, auth] of Object.entries(cases)) {
        traced.length = 0;
        plainSeen.length = 0;
        const said = await raw(get(basic('dn', mine.token), 'one') + get(auth, 'two').repeat(2000) + get(basic('dn', mine.token), 'three'));
        assert.deepEqual(statuses(said), [200, 407], what);
        assert.match(said, /\r\n\r\nplain says \/oneHTTP\/1\.1 407 Proxy Authentication Required\r\n/, what);
        assert.match(said.slice(said.indexOf('HTTP/1.1 407')), /^HTTP\/1\.1 407 [^\r]+\r\n(?:[^\r]+\r\n)*\r\n$/, `${what}: the 407 has no body and nothing after it`);
        assert.match(said, /\r\nproxy-authenticate: Basic realm="dn"\r\n/i);
        assert.match(said.slice(said.indexOf('HTTP/1.1 407')), /\r\nconnection: close\r\n/i);
        assert.deepEqual(plainSeen.map((r) => r.url), ['/one'], what);
        assert.deepEqual(traced.filter((line) => line.startsWith('407')), ['407 GET http://plain.test/two'], what);
      }
      await until(() => b.load('mine').connections === 0 && b.load('mine').requests === 0, 'the job\'s connections to be gone');
      assert.deepEqual([b.load('theirs').connections, b.load('theirs').requests], [0, 0], 'a token on another job\'s connection is nothing of its own job\'s');
    });
  });

  await check('a first head that is no request, or longer than a head may be, closes its connection unanswered; one that comes a byte at a time or with its body is read', async () => {
    // None of them is closed for the time its head took: that is ten minutes here.
    await withBroker({ limits: { headerMs: 600000 } }, async (b, traced) => {
      const job = await b.addJob({ runId: 'heads', pool });
      const auth = basic('dn', job.token);
      const none = {
        'no request line': 'garbage\r\n\r\n',
        'an empty line': '\r\n\r\n',
        'a method in small letters': `get http://plain.test/x HTTP/1.1\r\nHost: plain.test\r\n${auth}\r\n`,
        'another version': `GET http://plain.test/x HTTP/2.0\r\nHost: plain.test\r\n${auth}\r\n`,
        'the preface of HTTP/2': 'PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n',
        'two spaces': `GET  http://plain.test/x HTTP/1.1\r\nHost: plain.test\r\n${auth}\r\n`,
        'no target': `GET HTTP/1.1\r\n${auth}\r\n`,
        'a head with no end, past what a head may be': `GET http://plain.test/x HTTP/1.1\r\n${auth}X-Pad: ${'a'.repeat(http.maxHeaderSize)}`,
        'a head that ends past what a head may be': `GET http://plain.test/x HTTP/1.1\r\nHost: plain.test\r\n${auth}X-Pad: ${'a'.repeat(http.maxHeaderSize)}\r\n\r\n`,
      };
      plainSeen.length = 0;
      for (const [what, bytes] of Object.entries(none)) assert.equal(await raw(bytes), '', what);
      assert.deepEqual(traced, []);
      assert.deepEqual(plainSeen.map((r) => r.url), []);

      // A byte at a time: a tunnel, and a request for node to read.
      const slowly = async (c, text) => {
        for (const byte of Buffer.from(text, 'latin1')) {
          c.socket.write(Buffer.from([byte]));
          await new Promise((r) => setImmediate(r));
        }
      };
      const t = await open();
      await slowly(t, `CONNECT tunnel.test:443 HTTP/1.1\r\nHost: tunnel.test:443\r\n${auth}\r\n`);
      await until(() => t.said().endsWith('hello from the internet\n'), 'the tunnel to open');
      assert.equal(t.said(), 'HTTP/1.1 200 Connection Established\r\n\r\nhello from the internet\n');
      t.socket.destroy();
      const g = await open();
      await slowly(g, get(auth, 'slowly'));
      await until(() => g.said().endsWith('plain says /slowly'), 'the request to be answered');
      g.socket.destroy();
      // A head and the body behind it in one write, the body longer than a head may be.
      const body = Buffer.alloc(300000, 'b');
      const posted = await open();
      posted.socket.write(Buffer.concat([Buffer.from(`POST http://plain.test/posted HTTP/1.1\r\nHost: plain.test\r\n${auth}Content-Length: ${body.length}\r\n\r\n`), body]));
      await until(() => posted.said().endsWith('plain says /posted'), 'the request with a body to be answered');
      posted.socket.destroy();
      assert.deepEqual(plainSeen.splice(0), [{ url: '/slowly', size: 0 }, { url: '/posted', size: body.length }]);
    });
  });

  await check('a tunnel is asked for by a connection\'s first request, and takes with it what came behind that request', async () => {
    await withBroker({}, async (b) => {
      const job = await b.addJob({ runId: 'tunnels', pool });
      const auth = basic('dn', job.token);
      const early = await open();
      early.socket.write(`CONNECT tunnel.test:443 HTTP/1.1\r\nHost: tunnel.test:443\r\n${auth}\r\nsent with the request`);
      await until(() => early.said().endsWith('sent with the request'), 'the bytes behind the request to come back');
      assert.equal(early.said(), 'HTTP/1.1 200 Connection Established\r\n\r\nhello from the internet\nsent with the request');
      early.socket.destroy();
      // On a connection that began with another request, a CONNECT is the end of it.
      const dialsBefore = dials.length;
      const c = await open();
      c.socket.write(get(auth, 'before'));
      await until(() => c.said().endsWith('plain says /before'), 'the first request\'s answer');
      c.socket.write(`CONNECT tunnel.test:443 HTTP/1.1\r\nHost: tunnel.test:443\r\n${auth}\r\n`);
      await until(() => c.gone(), 'the connection to be closed');
      assert.deepEqual(statuses(c.said()), [200]);
      assert.ok(c.said().endsWith('plain says /before'), 'and nothing is said to it');
      assert.equal(dials.length, dialsBefore + 1, 'the plain request\'s connection out, and none for a tunnel');
      plainSeen.length = 0;
    });
  });

  await check('the broker keeps so many connections that are no job\'s, and closes the one that has waited longest for the next', async () => {
    assert.equal(STRANGERS, 1024);
    // None of them is closed for the time its head took: that is ten minutes here.
    await withBroker({ limits: { strangers: 3, headerMs: 600000 } }, async (b) => {
      const job = await b.addJob({ runId: 'seated', pool });
      // Each is the broker's before the next is opened.
      const silent = async () => { const c = await open(); await sleep(30); return c; };
      const [first, second, third] = [await silent(), await silent(), await silent()];
      await sleep(100);
      assert.deepEqual([first, second, third].map((c) => c.gone()), [false, false, false]);
      const fourth = await silent();
      await until(() => first.gone(), 'the one that waited longest to be closed');
      assert.equal(first.said(), '');
      // One that was refused and stays is no job's either.
      const refused = await silent();
      await until(() => second.gone(), 'the next longest');
      refused.socket.write(get('', 'x'));
      await until(() => refused.ended(), 'the refusal');
      assert.equal(refused.said(), DENY);
      // A job's connection is not one of them: the three after it close none of its own.
      const t = await tunnel('tunnel.test:443', basic('dn', job.token));
      assert.equal(t.status, 200);
      await until(() => third.gone(), 'the third to make room for the connection that became the job\'s');
      const later = [await silent(), await silent(), await silent(), await silent()];
      await until(() => fourth.gone() && refused.gone() && later[0].gone(), 'each in its turn');
      assert.deepEqual(later.slice(1).map((c) => c.gone()), [false, false, false]);
      t.socket.write('still here');
      await until(() => t.said().endsWith('still here'), 'the job\'s tunnel to carry on');
      t.socket.destroy();
      // Stopping the broker closes the ones it kept.
      await within(b.stop(), 'the broker to stop over connections that said nothing');
      await until(() => later.every((c) => c.gone()), 'them to be closed');
    });
  });

  await check('a name that cannot be the public internet\'s is told from one that can without asking anybody', () => {
    for (const host of ['localhost', 'a.localhost', 'printer.local', 'db.internal', 'metadata.google.internal', 'intranet', 'wiki.intranet', 'nas.lan', 'router.home', 'x.home.arpa', 'home.arpa',
      'build.corp', 'vault.private', 'registry', 'local', 'internal']) {
      assert.equal(localName(host), true, host);
    }
    for (const host of ['example.com', 'api.anthropic.com', 'github.com', 'local.example.com', 'localhost.example.com', 'internal.io', 'xlocal.com', 'my.locals', 'home.arpa.net', 'a.xhome',
      'corp.example', 'x.arpa', 'lan.party', 'tunnel.test']) {
      assert.equal(localName(host), false, host);
    }
  });

  await check('a job that names a machine\'s own network is refused before any name is asked, by CONNECT and over plain http', async () => {
    await withBroker({}, async (b) => {
      const job = await b.addJob({ runId: 'local', pool });
      const auth = basic('dn', job.token);
      // Even one that some resolver here would answer with a public address.
      names.set('printer.local', [{ address: PUBLIC, family: 4 }]);
      lookups.length = 0;
      dials.length = 0;
      const why = (host) => `the broker does not connect to ${host}: that is a name of a machine's own network, not of the public internet. A job reaches the internet and nothing on its executor's machine or network.\n`;
      for (const [asked, host] of [['printer.local', 'printer.local'], ['db.internal', 'db.internal'], ['registry', 'registry'], ['LOCALHOST', 'localhost'], ['Wiki.Intranet.', 'wiki.intranet'], ['a.b.localhost', 'a.b.localhost']]) {
        const t = await tunnel(`${asked}:443`, auth);
        assert.deepEqual([t.status, t.body], [403, why(host)], asked);
        const said = await raw(`GET http://${asked}/x HTTP/1.1\r\nHost: ${asked}\r\nConnection: close\r\n${auth}\r\n`);
        assert.deepEqual([statuses(said), said.slice(said.indexOf('\r\n\r\n') + 4)], [[403], why(host)], asked);
      }
      // A second trailing dot does not make a name of the public internet of one: it is no name.
      for (const asked of ['printer.local..', 'registry..', '_gateway..', 'printer.local...']) {
        const t = await tunnel(`${asked}:443`, auth);
        assert.deepEqual([t.status, t.body], [400, `not a host and port: ${asked}:443\n`], asked);
        const said = await raw(`GET http://${asked}/x HTTP/1.1\r\nHost: ${asked}\r\nConnection: close\r\n${auth}\r\n`);
        assert.deepEqual([statuses(said), JSON.parse(said.slice(said.indexOf('\r\n\r\n') + 4))], [[400], { message: `not a host: ${asked}` }], asked);
      }
      assert.deepEqual([lookups, dials], [[], []]);
      names.delete('printer.local');
      // An address needs no name asked, and a public name is asked once.
      assert.equal((await tunnel(`${PUBLIC}:443`, auth)).status, 200);
      assert.equal((await tunnel('tunnel.test:443', auth)).status, 200);
      assert.deepEqual(lookups, ['tunnel.test']);
    });
  });

  await check('so many of a job\'s names are asked at a time, the rest in the order they came, and another job waits for none of them', async () => {
    assert.equal(JOB_LOOKUPS, 8);
    await withBroker({ limits: { lookups: 2, connections: 6 } }, async (b) => {
      const hostile = await b.addJob({ runId: 'hostile', pool });
      const victim = await b.addJob({ runId: 'victim', pool });
      const auth = basic('dn', hostile.token);
      const pending = new Map(); // name -> { resolve, reject }
      for (let i = 0; i < 8; i++) names.set(`slow${i}.example`, () => new Promise((resolve, reject) => { pending.set(`slow${i}.example`, { resolve: () => resolve([{ address: PUBLIC, family: 4 }]), reject }); }));
      lookups.length = 0;
      const asks = [];
      for (let i = 0; i < 6; i++) {
        asks.push(tunnel(`slow${i}.example:443`, auth));
        await until(() => b.load('hostile').connections === i + 1, 'the connection to be the job\'s');
      }
      await sleep(100);
      assert.deepEqual(lookups, ['slow0.example', 'slow1.example'], 'two are asked and four wait');
      // Another job's name is asked at once, and so is nothing at all for an address.
      const calm = Date.now();
      assert.equal((await within(tunnel('tunnel.test:443', basic('dn', victim.token)), 'another job\'s tunnel', 2000)).status, 200);
      assert.ok(Date.now() - calm < 1000);
      assert.deepEqual(lookups.splice(2), ['tunnel.test']);
      // A place goes on when a name is answered, and when one fails.
      pending.get('slow1.example').resolve();
      assert.equal((await asks[1]).status, 200);
      await until(() => lookups.length === 3, 'the next in line to be asked');
      pending.get('slow0.example').reject(Object.assign(new Error('nothing'), { code: 'ESERVFAIL' }));
      assert.deepEqual([(await asks[0]).status, (await asks[0]).body], [502, 'slow0.example does not resolve (ESERVFAIL)\n']);
      await until(() => lookups.length === 4, 'the one after it');
      assert.deepEqual(lookups, ['slow0.example', 'slow1.example', 'slow2.example', 'slow3.example']);
      // A job that ends takes its names with it: the two that are asked are waited for
      // by nobody, and the two in line are never asked.
      const rest = asks.slice(2);
      b.removeJob('hostile');
      assert.deepEqual((await Promise.all(rest)).map((t) => t.status), [0, 0, 0, 0]);
      pending.get('slow2.example').resolve();
      pending.get('slow3.example').resolve();
      await sleep(100);
      assert.equal(lookups.length, 4);
    });
  });

  await check('a name is waited for so long and no longer, and the line of a job\'s names is as long as the job may have connections', async () => {
    assert.equal(LOOKUP_MS, 5000);
    const never = () => new Promise(() => {});
    await withBroker({ limits: { lookups: 1, lookupMs: 300 } }, async (b) => {
      const job = await b.addJob({ runId: 'waits', pool });
      const auth = basic('dn', job.token);
      names.set('never.example', never);
      const started = Date.now();
      const first = tunnel('never.example:443', auth);
      await until(() => b.load('waits').connections === 1, 'the first to be the job\'s');
      const behind = tunnel('tunnel.test:443', auth);
      await until(() => b.load('waits').connections === 2, 'the second');
      await sleep(100);
      assert.deepEqual(lookups.slice(-1), ['never.example'], 'the second name waits for the first');
      const t = await first;
      assert.deepEqual([t.status, t.body], [502, 'never.example does not resolve (no answer within 0.3 s)\n']);
      assert.ok(Date.now() - started >= 280 && Date.now() - started < 3000, `answered after ${Date.now() - started} ms`);
      assert.equal((await within(behind, 'the one behind it to have its place')).status, 200);
    });
    await withBroker({ limits: { lookups: 1, connections: 2 } }, async (b) => {
      const job = await b.addJob({ runId: 'line', pool });
      const auth = basic('dn', job.token);
      const pending = new Map();
      names.set('a.example', () => new Promise((resolve) => { pending.set('a', () => resolve([{ address: PUBLIC, family: 4 }])); }));
      for (const name of ['b', 'c', 'd']) names.set(`${name}.example`, () => new Promise((resolve) => { pending.set(name, () => resolve([{ address: '93.184.216.40', family: 4 }])); }));
      const ask = (name) => `GET http://${name}.example/${name} HTTP/1.1\r\nHost: ${name}.example\r\nConnection: close\r\n${auth}\r\n`;
      lookups.length = 0;
      const asked = tunnel('a.example:443', auth);
      await until(() => lookups.length === 1, 'the first name to be asked');
      // A request whose sender leaves while its name waits leaves the name in the line.
      for (const name of ['b', 'c']) {
        const c = await open();
        c.socket.write(ask(name));
        await until(() => b.load('line').upstreams === 1, `${name}'s request to be on its way out`);
        c.socket.destroy();
        await until(() => b.load('line').connections === 1 && b.load('line').upstreams === 0, `${name} to leave`);
      }
      const full = await raw(ask('d'));
      assert.deepEqual([statuses(full), full.slice(full.indexOf('\r\n\r\n') + 4)], [[502], 'd.example does not resolve (2 names of this job wait to be resolved already)\n']);
      assert.deepEqual(lookups, ['a.example']);
      // The line empties in its order, and the job's next name is asked again.
      pending.get('a')();
      assert.equal((await asked).status, 200);
      await until(() => lookups.length === 2, 'the second name');
      pending.get('b')();
      await until(() => lookups.length === 3, 'the third');
      pending.get('c')();
      const last = raw(ask('d'));
      await until(() => lookups.length === 4, 'the name that had no place before');
      pending.get('d')();
      assert.ok((await last).endsWith('plain says /d'));
      assert.deepEqual(lookups, ['a.example', 'b.example', 'c.example', 'd.example']);
      plainSeen.length = 0;
    });
  });

  await check('the resolver asks DNS and nothing else of this machine, both families of a name with IPv4 first, and a name server\'s silence over one job\'s names holds up no other job', async () => {
    // A name server: a table of names, and the names it says nothing about until told to.
    const V6 = '2606:2800:220:1:248:1893:25c8:1946';
    const zone = new Map([['both.example', { a: [PUBLIC, '93.184.216.35'], aaaa: [V6] }], ['six.example', { aaaa: [V6] }], ['empty.example', {}],
      ['calm.example', { a: [PUBLIC] }], ['calmer.example', { a: [PUBLIC] }]]);
    const asked = [];
    const held = [];
    const stub = dgram.createSocket('udp4');
    stub.on('message', (msg, from) => {
      const labels = [];
      let at = 12;
      while (msg[at] !== 0) { labels.push(msg.latin1Slice(at + 1, at + 1 + msg[at])); at += msg[at] + 1; }
      const name = labels.join('.').toLowerCase();
      const type = msg.readUInt16BE(at + 1);
      asked.push(`${name} ${{ 1: 'A', 28: 'AAAA' }[type] ?? type}`);
      const entry = zone.get(name);
      const records = (type === 1 ? entry?.a : entry?.aaaa) ?? [];
      const head = Buffer.alloc(12);
      msg.copy(head, 0, 0, 2);
      head.writeUInt16BE(entry ? 0x8180 : 0x8183, 2); // an answer; or: no such name
      head.writeUInt16BE(1, 4);
      head.writeUInt16BE(records.length, 6);
      const answers = records.map((address) => {
        const data = type === 1 ? Buffer.from(address.split('.').map(Number)) : Buffer.from(address.split(':').map((group) => group.padStart(4, '0')).join(''), 'hex');
        const record = Buffer.alloc(12);
        record.writeUInt16BE(0xc00c, 0); // the name of the question
        record.writeUInt16BE(type, 2);
        record.writeUInt16BE(1, 4);
        record.writeUInt32BE(60, 6);
        record.writeUInt16BE(data.length, 10);
        return Buffer.concat([record, data]);
      });
      const reply = () => stub.send(Buffer.concat([head, msg.subarray(12, at + 5), ...answers]), from.port, from.address);
      if (name.startsWith('slow')) held.push(reply); else reply();
    });
    await new Promise((resolve) => { stub.bind(0, '127.0.0.1', resolve); });
    try {
      const viaDns = dnsLookup({ servers: [`127.0.0.1:${stub.address().port}`] });
      assert.deepEqual(await viaDns('both.example'), [{ address: PUBLIC, family: 4 }, { address: '93.184.216.35', family: 4 }, { address: V6, family: 6 }]);
      assert.deepEqual(await viaDns('six.example'), [{ address: V6, family: 6 }]);
      await assert.rejects(viaDns('none.example'), { code: 'ENOTFOUND' });
      await assert.rejects(viaDns('empty.example'), { code: 'ENODATA' });
      // This machine's hosts file knows localhost, and is not asked.
      await assert.rejects(viaDns('localhost'), { code: 'ENOTFOUND' });
      assert.deepEqual([...asked].sort(), ['both.example A', 'both.example AAAA', 'empty.example A', 'empty.example AAAA', 'localhost A', 'localhost AAAA',
        'none.example A', 'none.example AAAA', 'six.example A', 'six.example AAAA']);
      // A name the server says nothing about is asked twice and given up.
      asked.length = 0;
      await assert.rejects(viaDns('slow-alone.example'), { code: 'ETIMEOUT' });
      assert.deepEqual([...asked].sort(), ['slow-alone.example A', 'slow-alone.example A', 'slow-alone.example AAAA', 'slow-alone.example AAAA']);

      await withBroker({ lookup: viaDns, limits: { lookupMs: 400 } }, async (b) => {
        const hostile = await b.addJob({ runId: 'hostile', pool });
        const victim = await b.addJob({ runId: 'victim', pool });
        assert.equal((await tunnel('calm.example:443', basic('dn', victim.token))).status, 200);
        asked.length = 0;
        const started = Date.now();
        const asks = Array.from({ length: 16 }, (_, i) => tunnel(`slow${i}.example:443`, basic('dn', hostile.token)));
        await until(() => b.load('hostile').connections === 16, 'sixteen connections that wait for a name');
        await sleep(100);
        assert.equal(asked.length, 2 * JOB_LOOKUPS, 'eight names are asked, each of both families, and eight wait');
        const calm = Date.now();
        assert.equal((await tunnel('calmer.example:443', basic('dn', victim.token))).status, 200);
        assert.ok(Date.now() - calm < 300, `another job's name took ${Date.now() - calm} ms beside them`);
        const refused = await within(Promise.all(asks), 'every one of them to be given up');
        assert.deepEqual(refused.map((t) => [t.status, t.body]), Array.from({ length: 16 }, (_, i) => [502, `slow${i}.example does not resolve (no answer within 0.4 s)\n`]));
        assert.ok(Date.now() - started >= 780 && Date.now() - started < 5000, `sixteen names, eight at a time, were given up after ${Date.now() - started} ms`);
        assert.equal(asked.filter((q) => q.startsWith('slow')).length, 32);
      });
    } finally {
      // The resolver gives a name up later than the broker does: it is answered now.
      for (const reply of held) reply();
      await sleep(50);
      stub.close();
    }
  });

  console.log(`\nall ${checks} checks passed`);
  assert.deepEqual(faults.map((e) => String(e?.stack ?? e)), []);
} catch (e) {
  console.error(e);
  process.exitCode = 1;
} finally {
  for (const socket of opened) socket.destroy();
  for (const s of servers) { s.closeAllConnections?.(); s.close(); }
}
