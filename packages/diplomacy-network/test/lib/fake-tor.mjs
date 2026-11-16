#!/usr/bin/env node
// Stands in for `tor` (DN_TOR), so no default test touches the Tor network. It honours
// the process contract src/transport/tor.js relies on and nothing more:
//
//   - `tor -f <torrc>` with exactly the options tor.js writes; an unknown option, or a
//     DataDirectory that is not 0700, is refused the way tor refuses it;
//   - the DataDirectory `lock`: a second instance waits for the first, then gives up;
//   - `control_auth_cookie`, a control port written to ControlPortWriteToFile, and the
//     commands AUTHENTICATE, TAKEOWNERSHIP, SETEVENTS, GETINFO net/listeners/socks,
//     GETINFO status/bootstrap-phase and ADD_ONION (ED25519-V3 key, Flags=DiscardPK, one
//     Port), whose ServiceID is derived from the key as tor derives it;
//   - bootstrap progress on stdout and as STATUS_CLIENT events, HS_DESC UPLOAD and
//     UPLOADED events for the service;
//   - a SOCKS5 server that connects `<id>.onion:<port>` to wherever the fake that
//     published `<id>` in the directory FAKE_TOR_NET pointed that port, for as long as
//     that fake is alive (a connection made earlier outlives it, which tor's would
//     not); every CONNECT is appended to FAKE_TOR_NET/socks.log;
//   - exit on SIGTERM or SIGINT, when the connection that took ownership closes, and
//     when the __OwningControllerProcess is gone.
//
// FAKE_TOR_STAGE is a comma-separated list of staged failures:
//   stall:<pct>           bootstrap stops at the first step at or past <pct>, with the
//                         warning tor gives when it cannot get further
//   die:<pct>             tor exits with an error there instead
//   die-slowly            asked for its bootstrap phase, tor closes its control
//                         connections instead of answering and exits with an error half
//                         a second later
//   drop-control:<pct>    tor closes its control connections there, once it has one, and
//                         lives on
//   reject-add-onion      ADD_ONION is refused
//   wrong-service-id      ADD_ONION answers with another service's id
//   no-descriptor         the descriptor is never uploaded
//   upload-at-once        the upload is reported in the same write as ADD_ONION's reply
//   socks-04:<n>          the first <n> CONNECTs are answered 0x04 (host unreachable)
//   socks-eof:<n>         the first <n> CONNECTs succeed, then close before any byte
//   socks-stall           no CONNECT is ever answered
//   ignore-term           SIGTERM is ignored
//   ignore-owning-pid     __OwningControllerProcess is not watched
//   ignore-takeownership  the owning connection closing changes nothing
//   long-line             a log line far over any sane length follows bootstrap
// FAKE_TOR_STEP_MS is the pause between bootstrap steps (15).

import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { onionAddress } from '../../src/core/identity.js';

const stages = new Map((process.env.FAKE_TOR_STAGE ?? '').split(',').filter(Boolean).map((s) => {
  const [name, arg] = s.split(':');
  return [name, Number(arg ?? 0)];
}));
const NET = process.env.FAKE_TOR_NET;
const STEP_MS = Number(process.env.FAKE_TOR_STEP_MS) || 15;

process.stdout.on('error', () => {}); // an owner that died took the pipe with it
const say = (level, text) => process.stdout.write(`Jan 01 00:00:00.000 [${level}] ${text}\n`);
const die = (text) => {
  say('err', text);
  process.exit(1);
};
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
};
const replace = (file, data) => {
  fs.writeFileSync(`${file}.tmp`, data);
  fs.renameSync(`${file}.tmp`, file);
};

// ---- torrc ----

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '-f') die('usage: tor -f <torrc>');
const options = new Map();
for (const line of fs.readFileSync(args[1], 'utf8').split('\n')) {
  const [key, ...value] = line.trim().split(/\s+/);
  if (key) options.set(key, value.join(' '));
}
const KNOWN = ['SocksPort', 'ControlPort', 'ControlPortWriteToFile', 'CookieAuthentication', 'DataDirectory',
  'ClientOnly', 'AvoidDiskWrites', 'Log', '__OwningControllerProcess'];
for (const key of options.keys()) {
  if (KNOWN.includes(key)) continue;
  say('warn', `Failed to parse/validate config: Unknown option '${key}'.  Failing.`);
  die('Reading config failed--see warnings above.');
}
const socksOption = (options.get('SocksPort') ?? '').split(' ');
if (socksOption[0] !== 'auto' || options.get('ControlPort') !== 'auto' || options.get('CookieAuthentication') !== '1') {
  die('the stand-in only runs with SocksPort auto, ControlPort auto and CookieAuthentication 1');
}
const extendedErrors = socksOption.includes('ExtendedErrors');
const dataDir = options.get('DataDirectory');
if ((fs.statSync(dataDir).mode & 0o777) !== 0o700) {
  say('warn', `Permissions on directory ${dataDir} are too permissive.`);
  die('Failed to parse/validate config: Couldn\'t create private data directory');
}

// ---- the data directory lock ----

const lock = path.join(dataDir, 'lock');
const held = () => {
  try {
    const pid = Number(fs.readFileSync(lock, 'utf8'));
    return pid !== process.pid && alive(pid);
  } catch {
    return false;
  }
};
if (held()) {
  say('warn', 'It looks like another Tor process is running with the same data directory.  Waiting 5 seconds to see if it goes away.');
  await sleep(1000);
  if (held()) die('No, it\'s still there.  Exiting.');
}
fs.writeFileSync(lock, String(process.pid));

// ---- ending ----

const published = []; // descriptor files this instance wrote
function quit(code) {
  for (const file of published) fs.rmSync(file, { force: true });
  process.exit(code);
}
process.on('SIGTERM', () => {
  if (stages.has('ignore-term')) return;
  say('notice', 'Catching signal TERM, exiting cleanly.');
  quit(0);
});
process.on('SIGINT', () => quit(0));
const owner = Number(options.get('__OwningControllerProcess'));
if (owner && !stages.has('ignore-owning-pid')) {
  setInterval(() => {
    if (alive(owner)) return;
    say('notice', 'Owning controller process has vanished -- exiting now.');
    quit(0);
  }, 200);
}

// ---- Ed25519: the public key of an expanded secret key ----

const P = 2n ** 255n - 19n;
const mod = (a) => ((a % P) + P) % P;
const pow = (base, exp) => {
  let result = 1n;
  for (let b = mod(base), e = exp; e > 0n; e >>= 1n, b = mod(b * b)) if (e & 1n) result = mod(result * b);
  return result;
};
const inv = (a) => pow(a, P - 2n);
const D = mod(-121665n * inv(121666n));
const BASE_X = 15112221349535400772501151409588531511454012693041857206046113283949847762202n;
const BASE_Y = mod(4n * inv(5n));
// Extended coordinates [X, Y, Z, T]; the one formula adds and doubles.
const add = ([x1, y1, z1, t1], [x2, y2, z2, t2]) => {
  const a = mod((y1 - x1) * (y2 - x2));
  const b = mod((y1 + x1) * (y2 + x2));
  const c = mod(2n * D * t1 * t2);
  const d = mod(2n * z1 * z2);
  return [mod((b - a) * (d - c)), mod((d + c) * (b + a)), mod((d - c) * (d + c)), mod((b - a) * (b + a))];
};
function publicKey(scalar) {
  let sum = [0n, 1n, 1n, 0n];
  let point = [BASE_X, BASE_Y, 1n, mod(BASE_X * BASE_Y)];
  for (let k = BigInt(`0x${Buffer.from(scalar).reverse().toString('hex')}`); k > 0n; k >>= 1n, point = add(point, point)) {
    if (k & 1n) sum = add(sum, point);
  }
  const zInv = inv(sum[2]);
  const out = Buffer.from(mod(sum[1] * zInv).toString(16).padStart(64, '0'), 'hex').reverse();
  out[31] |= Number(mod(sum[0] * zInv) & 1n) << 7;
  return out;
}
const serviceIdOf = (scalar) => onionAddress(publicKey(scalar).toString('base64url')).slice(0, 56);

// ---- the control port ----

const STEPS = [
  [0, 'starting', 'Starting'],
  [10, 'conn_done', 'Connected to a relay'],
  [25, 'loading_status', 'Loading networkstatus consensus'],
  [45, 'requesting_descriptors', 'Asking for relay descriptors'],
  [75, 'enough_dirinfo', 'Loaded enough directory info to build circuits'],
  [100, 'done', 'Done'],
];
const progress = (step) => `NOTICE BOOTSTRAP PROGRESS=${step[0]} TAG=${step[1]} SUMMARY="${step[2]}"`;
// The bootstrap status last reported: sent as an event to whoever listens at that moment,
// and what GETINFO status/bootstrap-phase answers to a controller that came later.
let status = progress(STEPS[0]);

const cookie = crypto.randomBytes(32);
replace(path.join(dataDir, 'control_auth_cookie'), cookie);
const controls = new Set();
const emit = (event, text) => {
  for (const c of controls) if (c.events.has(event)) c.socket.write(`650 ${event} ${text}\r\n`);
};
let socksPort = 0;

// Every control connection closed and no new one taken, with tor going on.
function dropControl() {
  control.close();
  for (const conn of controls) {
    conn.owner = false;
    conn.socket.destroy();
  }
}

function command(conn, line) {
  const [verb, ...rest] = line.split(' ');
  const reply = (...lines) => conn.socket.write(lines.map((l) => `${l}\r\n`).join(''));
  if (verb === 'AUTHENTICATE') {
    conn.authed = rest[0]?.toLowerCase() === cookie.toString('hex');
    if (conn.authed) return reply('250 OK');
    reply('515 Authentication failed: Authentication cookie did not match expected value.');
    return conn.socket.end();
  }
  if (!conn.authed) {
    reply('514 Authentication required.');
    return conn.socket.end();
  }
  if (verb === 'TAKEOWNERSHIP') {
    conn.owner = true;
    return reply('250 OK');
  }
  if (verb === 'SETEVENTS') {
    const unknown = rest.find((e) => e !== 'HS_DESC' && e !== 'STATUS_CLIENT');
    if (unknown) return reply(`552 Unrecognized event "${unknown}"`);
    conn.events = new Set(rest);
    return reply('250 OK');
  }
  if (verb === 'GETINFO' && rest[0] === 'net/listeners/socks') {
    return reply(`250-net/listeners/socks="127.0.0.1:${socksPort}"`, '250 OK');
  }
  if (verb === 'GETINFO' && rest[0] === 'status/bootstrap-phase' && stages.has('die-slowly')) {
    dropControl();
    return setTimeout(() => die('The stand-in was told to die here.'), 500);
  }
  if (verb === 'GETINFO' && rest[0] === 'status/bootstrap-phase') {
    return reply(`250-status/bootstrap-phase=${status}`, '250 OK');
  }
  if (verb === 'ADD_ONION') return addOnion(rest, reply);
  return reply(`510 Unrecognized command "${verb}"`);
}

function addOnion([key, flags, port, ...more], reply) {
  const secret = Buffer.from(/^ED25519-V3:(.+)$/.exec(key ?? '')?.[1] ?? '', 'base64');
  const target = /^Port=(\d+),(127\.0\.0\.1):(\d+)$/.exec(port ?? '');
  if (secret.length !== 64 || flags !== 'Flags=DiscardPK' || !target || more.length) {
    return reply('512 Bad arguments to ADD_ONION: the stand-in takes an ED25519-V3 key, Flags=DiscardPK and one Port');
  }
  if (stages.has('reject-add-onion')) return reply('550 Onion address collision');
  const id = serviceIdOf(secret.subarray(0, 32));
  const hsdir = `$${'A'.repeat(40)}~fake`;
  const publish = () => {
    const file = path.join(NET, id);
    replace(file, JSON.stringify({ pid: process.pid, ports: { [target[1]]: Number(target[3]) } }));
    published.push(file);
  };
  if (stages.has('upload-at-once')) {
    publish();
    return reply(`250-ServiceID=${id}`, '250 OK', `650 HS_DESC UPLOADED ${id} UNKNOWN ${hsdir}`);
  }
  reply(`250-ServiceID=${stages.has('wrong-service-id') ? serviceIdOf(crypto.randomBytes(32)) : id}`, '250 OK');
  emit('HS_DESC', `UPLOAD ${id} UNKNOWN ${hsdir} ${'b'.repeat(43)} HSDIR_INDEX=${'c'.repeat(64)}`);
  if (stages.has('no-descriptor')) return;
  setTimeout(() => {
    publish();
    emit('HS_DESC', `UPLOADED ${id} UNKNOWN ${hsdir}`);
  }, STEP_MS * 4);
}

const control = net.createServer((socket) => {
  const conn = { socket, authed: false, owner: false, events: new Set() };
  controls.add(conn);
  let buffered = '';
  socket.setEncoding('utf8');
  socket.on('error', () => {});
  socket.on('data', (chunk) => {
    const lines = (buffered + chunk).split('\r\n');
    buffered = lines.pop();
    for (const line of lines) command(conn, line);
  });
  socket.on('close', () => {
    controls.delete(conn);
    if (!conn.owner || stages.has('ignore-takeownership')) return;
    say('notice', 'Owning controller connection has closed -- exiting now.');
    quit(0);
  });
});

// ---- the SOCKS port ----

const left = { 'socks-04': stages.get('socks-04') ?? 0, 'socks-eof': stages.get('socks-eof') ?? 0 };
const take = (stage) => left[stage] > 0 && left[stage]--;

const socks = net.createServer((socket) => {
  let buffered = Buffer.alloc(0);
  let stage = 'method';
  let user = '';
  const answer = (code) => socket.write(Buffer.from([5, code, 0, 1, 0, 0, 0, 0, 0, 0]));
  socket.on('error', () => {});
  socket.on('data', function onData(chunk) {
    buffered = Buffer.concat([buffered, chunk]);
    if (stage === 'method') {
      if (buffered.length < 2 || buffered.length < 2 + buffered[1]) return;
      const methods = buffered.subarray(2, 2 + buffered[1]);
      buffered = buffered.subarray(2 + buffered[1]);
      const method = methods.includes(2) ? 2 : methods.includes(0) ? 0 : 0xff;
      socket.write(Buffer.from([5, method]));
      if (method === 0xff) return socket.end();
      stage = method === 2 ? 'auth' : 'connect';
    }
    if (stage === 'auth') {
      if (buffered.length < 2 || buffered.length < 3 + buffered[1]) return;
      const size = 3 + buffered[1] + buffered[2 + buffered[1]];
      if (buffered.length < size) return;
      user = buffered.subarray(2, 2 + buffered[1]).toString();
      buffered = buffered.subarray(size);
      socket.write(Buffer.from([1, 0]));
      stage = 'connect';
    }
    if (stage === 'connect') {
      if (buffered.length < 4) return;
      if (buffered[1] !== 1) return answer(7);
      if (buffered[3] !== 3) return answer(8);
      if (buffered.length < 5 || buffered.length < 7 + buffered[4]) return;
      const host = buffered.subarray(5, 5 + buffered[4]).toString();
      const port = buffered.readUInt16BE(5 + buffered[4]);
      stage = 'open';
      socket.off('data', onData);
      fs.appendFileSync(path.join(NET, 'socks.log'), `${JSON.stringify({ user, host, port })}\n`);
      if (!host.endsWith('.onion')) return answer(4);
      if (stages.has('socks-stall')) return;
      if (take('socks-04')) return answer(4);
      let descriptor = null;
      try { descriptor = JSON.parse(fs.readFileSync(path.join(NET, host.slice(0, -6)), 'utf8')); } catch {}
      if (!descriptor || !alive(descriptor.pid)) return answer(extendedErrors ? 0xf0 : 4);
      if (!descriptor.ports[port]) return answer(1);
      const upstream = net.connect({ host: '127.0.0.1', port: descriptor.ports[port] });
      upstream.on('error', () => {
        if (upstream.connecting) answer(5);
        socket.destroy();
      });
      upstream.once('connect', () => {
        answer(0);
        if (take('socks-eof')) {
          upstream.destroy();
          return socket.end();
        }
        socket.pipe(upstream).pipe(socket);
        socket.on('close', () => upstream.destroy());
        upstream.on('close', () => socket.destroy());
      });
    }
  });
});

// ---- start ----

const listen = (server) => new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => resolve(server.address().port));
});
socksPort = await listen(socks);
replace(options.get('ControlPortWriteToFile'), `PORT=127.0.0.1:${await listen(control)}\n`);

const report = (text) => {
  status = text;
  emit('STATUS_CLIENT', text);
};
for (const step of STEPS) {
  say('notice', `Bootstrapped ${step[0]}% (${step[1]}): ${step[2]}`);
  report(progress(step));
  if (stages.has('die') && step[0] >= stages.get('die')) die('The stand-in was told to die here.');
  if (stages.has('drop-control') && step[0] >= stages.get('drop-control')) {
    while (controls.size === 0) await sleep(10);
    dropControl();
    break;
  }
  if (stages.has('stall') && step[0] >= stages.get('stall')) {
    report(`WARN BOOTSTRAP PROGRESS=${step[0]} TAG=${step[1]} SUMMARY="${step[2]}" WARNING="Network is unreachable" REASON=NOROUTE COUNT=1 RECOMMENDATION=warn HOSTID="${'A'.repeat(40)}" HOSTADDR="192.0.2.1:9001"`);
    break;
  }
  await sleep(STEP_MS);
}
if (stages.has('long-line')) {
  process.stdout.write(`Jan 01 00:00:00.000 [warn] ${'x'.repeat(300 * 1024)}`);
  process.stdout.write('\n');
  say('warn', 'the line after the long one');
}
