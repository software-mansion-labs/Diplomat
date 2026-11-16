// The transport over Tor. One `tor` process belongs to the daemon: it is started here,
// told over its control port to serve this host's onion service (whose key is the host
// key), asked for a SOCKS connection per peer, started again when it dies, and ended with
// the transport.
//
// What the network makes slow is never treated as a failure here. Bootstrap takes as long
// as it takes. The first connection to a peer takes seconds when every circuit tor builds
// for it comes up and minutes when one hangs, since a tor that has yet to learn how long a
// circuit takes gives each a hundred seconds. A dial tor cannot complete is `unreachable`
// or `timeout`, an answer like any other, and tor carries on with the same circuits for
// the dial after it.

import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { torSecretKey } from '../core/identity.js';
import { TOR_BIN } from '../paths.js';
import { fail } from './http.js';

/// The tunables of the tor transport, each overridable through a transport's `tune` option.
export const TOR_TUNING = {
  // How long one SOCKS connection attempt may take; tor's own limit is two minutes.
  dialTimeoutMs: 60 * 1000,
  // Publishing counts as ready after this long with no upload confirmed: tor does not
  // always report one, and the service may be reachable all the same.
  publishGraceMs: 120 * 1000,
  // From SIGTERM to SIGKILL.
  stopGraceMs: 10 * 1000,
  // The wait before a tor that died is started again, doubling per failed start.
  restartMinMs: 2000,
  restartMaxMs: 60 * 1000,
  // How long a tor whose control connection closed is given to exit before the
  // connection is blamed: a tor that dies closes it too, and its exit says why.
  controlLossMs: 5000,
};

const CONTROL_LOST = 'tor closed its control connection';

const MAX_LOG_LINE = 4096;

// What tor answers a CONNECT with; 0xF0 and up are its own, sent because the SOCKS port
// is opened with ExtendedErrors.
const SOCKS_REPLY = {
  0x01: 'general failure',
  0x02: 'not allowed',
  0x03: 'network unreachable',
  0x04: 'host unreachable',
  0x05: 'connection refused',
  0x06: 'TTL expired',
  0x07: 'command not supported',
  0x08: 'address type not supported',
  0xf0: 'descriptor not found',
  0xf1: 'descriptor invalid',
  0xf2: 'introduction failed',
  0xf3: 'rendezvous failed',
  0xf4: 'client authorization missing',
  0xf5: 'client authorization wrong',
  0xf6: 'bad onion address',
  0xf7: 'introduction timed out',
};

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

// Feeds a stream to `onLine` forever. tor blocks on a full pipe, so nothing here may stop
// reading; a line longer than MAX_LOG_LINE is cut to its head.
function pump(stream, onLine) {
  let partial = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    const lines = (partial + chunk).split('\n');
    partial = lines.pop().slice(0, MAX_LOG_LINE);
    for (const line of lines) onLine(line.slice(0, MAX_LOG_LINE));
  });
}

// A control connection: `send(command)` resolves with the reply's lines or rejects with
// tor's refusal, every asynchronous event goes to `onEvent`, and `onClose` hears the
// connection end, whether or not anything was being asked on it.
function openControl(port, onEvent, onClose) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const waiting = [];
    let buffered = '';
    let reply = [];
    socket.setEncoding('utf8');
    socket.on('error', () => {}); // the close that follows reports it
    socket.on('close', () => {
      onClose();
      const lost = new Error(CONTROL_LOST);
      for (const w of waiting.splice(0)) w.reject(lost);
      reject(lost);
    });
    socket.on('data', (chunk) => {
      const lines = (buffered + chunk).split('\r\n');
      buffered = lines.pop();
      for (const line of lines) {
        reply.push(line);
        if (line[3] !== ' ') continue; // "250-..." has more lines coming
        const whole = reply;
        reply = [];
        if (line.startsWith('650')) {
          onEvent(whole.join('\n'));
        } else {
          const w = waiting.shift();
          // Named by its verb only: an ADD_ONION command holds the host's secret key.
          if (line[0] === '2') w?.resolve(whole);
          else w?.reject(new Error(`tor refused ${w.verb}: ${line}`));
        }
      }
    });
    const send = (command) => new Promise((res, rej) => {
      if (socket.destroyed) return rej(new Error(CONTROL_LOST));
      waiting.push({ resolve: res, reject: rej, verb: command.split(' ')[0] });
      socket.write(`${command}\r\n`);
    });
    socket.once('connect', () => resolve({ send, destroy: () => socket.destroy() }));
  });
}

/// The tor half of a transport: `{ start(port), dial(onion), stop() }`.
export function torDriver({ identity, address, dir, log, tune, setState }) {
  const t = { ...TOR_TUNING, ...tune };
  const serviceId = address.slice(0, -'.onion'.length);
  const files = {
    torrc: path.join(dir, 'torrc'),
    port: path.join(dir, 'control.port'),
    cookie: path.join(dir, 'control_auth_cookie'),
    pid: path.join(dir, 'tor.pid'),
  };
  const dialing = new Set(); // sockets in their SOCKS handshake
  let localPort = 0;
  let run = null; // the tor process of the moment
  let abortLaunch = null;
  let stopping = false;
  let publishTimer = null;
  let restartTimer = null;
  let restartDelay = t.restartMinMs;

  // The tor a run of this daemon that died left behind, when it is still there. tor ends
  // with its owner, but only once it has been told who that is and has looked; until
  // then it holds the data directory's lock and a second tor refuses to start.
  function orphan() {
    let pid;
    try { pid = Number(fs.readFileSync(files.pid, 'utf8')); } catch { return 0; }
    if (!pid || !alive(pid)) return 0;
    try {
      // The pid may have gone to another program since; only a tor on this torrc is ours.
      const command = execFileSync('ps', ['-ww', '-o', 'command=', '-p', String(pid)], { encoding: 'utf8' });
      return command.includes(files.torrc) ? pid : 0;
    } catch {
      return 0;
    }
  }

  async function end(tor) {
    if (!tor.proc.pid || tor.proc.exitCode !== null || tor.proc.signalCode !== null) return tor.exited;
    tor.proc.kill('SIGTERM');
    const kill = setTimeout(() => tor.proc.kill('SIGKILL'), t.stopGraceMs);
    await tor.exited;
    clearTimeout(kill);
  }

  // Starts tor and brings it to the point where the onion service is added. Rejects when
  // tor exits on the way, refuses a command, or the transport stops; tor is gone by then.
  async function launch() {
    if (stopping) throw fail('stopped', 'the transport stopped');
    setState('starting', 'launching tor');
    let pollTimer = null;
    let lossTimer = null;
    let abort;
    const aborted = new Promise((_, reject) => { abort = reject; });
    aborted.catch(() => {});
    const cancel = (err) => {
      clearTimeout(pollTimer);
      abort(err);
    };
    abortLaunch = cancel;
    const step = (promise) => Promise.race([promise, aborted]);
    const poll = (probe) => step(new Promise((resolve) => {
      const tick = () => {
        const value = probe();
        if (value) resolve(value);
        else pollTimer = setTimeout(tick, 50);
      };
      tick();
    }));

    fs.mkdirSync(dir, { recursive: true });
    // mkdir's mode passes through the umask, and tor refuses a data directory that
    // anyone else can read.
    fs.chmodSync(dir, 0o700);
    const left = orphan();
    if (left) {
      log(`transport: ending the tor (pid ${left}) an earlier run left on ${dir}`);
      try { process.kill(left, 'SIGKILL'); } catch {} // gone since the look
      await poll(() => !alive(left));
    }
    // What a dead tor left would be read as this one's before this one has written its own.
    fs.rmSync(files.port, { force: true });
    fs.rmSync(files.cookie, { force: true });
    fs.writeFileSync(files.torrc, [
      'SocksPort auto ExtendedErrors',
      'ControlPort auto',
      `ControlPortWriteToFile ${files.port}`,
      'CookieAuthentication 1',
      `DataDirectory ${dir}`,
      'ClientOnly 1',
      'AvoidDiskWrites 1',
      'Log notice stdout',
      // tor checks on this pid and exits once it is gone, so a daemon that is killed
      // leaves no tor behind even before it has taken ownership over the control port.
      `__OwningControllerProcess ${process.pid}`,
      '',
    ].join('\n'));

    const proc = spawn(TOR_BIN, ['-f', files.torrc], { stdio: ['ignore', 'pipe', 'pipe'] });
    const tor = { proc, control: null, socksPort: 0, launched: false, problem: '' };
    run = tor;
    if (proc.pid) fs.writeFileSync(files.pid, String(proc.pid));
    const note = (line) => {
      if (!/\[(warn|err)\]/.test(line)) return;
      tor.problem = line.replace(/^.*?\[(warn|err)\] /, '');
      log(`tor: ${line}`);
    };
    pump(proc.stdout, note);
    pump(proc.stderr, note);
    tor.exited = new Promise((resolve) => {
      proc.once('error', (err) => { // it never ran
        tor.problem = err.code === 'ENOENT' ? 'it is not installed where this machine\'s tools are looked for (DN_TOR names it by hand)' : err.message;
        resolve();
      });
      proc.once('exit', resolve);
    }).then(() => {
      // A grandchild holding the pipes must not keep them, or this process, open.
      proc.stdout.destroy();
      proc.stderr.destroy();
      tor.control?.destroy();
      clearTimeout(lossTimer);
      clearTimeout(publishTimer);
      fs.rmSync(files.pid, { force: true });
      fs.rmSync(files.port, { force: true });
      if (run === tor) run = null;
      const why = proc.pid
        ? `tor exited (${proc.signalCode ?? `code ${proc.exitCode}`})${tor.problem && `: ${tor.problem}`}`
        : `cannot run ${TOR_BIN}: ${tor.problem}`;
      cancel(new Error(why));
      if (stopping || !tor.launched) return;
      setState('failed', why);
      restartLater();
    });

    try {
      setState('bootstrapping', 'waiting for the control port');
      const controlPort = await poll(() => {
        try { return Number(/^PORT=\S*:(\d+)$/m.exec(fs.readFileSync(files.port, 'utf8'))?.[1]); } catch { return 0; }
      });
      const cookie = await poll(() => {
        try {
          const bytes = fs.readFileSync(files.cookie);
          return bytes.length === 32 && bytes;
        } catch {
          return null;
        }
      });

      let booted = false;
      let onBooted;
      const bootstrapped = new Promise((resolve) => { onBooted = resolve; });
      let uploaded = false;
      const progressed = (text) => {
        const m = /BOOTSTRAP PROGRESS=(\d+).*?SUMMARY="([^"]*)"(?: WARNING="([^"]*)")?/.exec(text);
        if (!m || booted) return;
        // The warning is tor's reason for not getting further: no route, no network.
        setState('bootstrapping', `${m[1]}% ${m[2]}${m[3] ? `: ${m[3]}` : ''}`);
        booted = Number(m[1]) >= 100;
        if (booted) onBooted();
      };
      const confirmed = () => {
        clearTimeout(publishTimer);
        setState('ready', 'descriptor uploaded');
      };
      tor.control = await step(openControl(controlPort, (event) => {
        if (!event.startsWith('650 HS_DESC ')) return progressed(event);
        // The one service this tor has is this host's, and "UPLOAD" is only the attempt.
        if (event.split(' ')[2] !== 'UPLOADED') return;
        uploaded = true;
        if (tor.launched) confirmed();
      }, () => {
        // Only a launch waits on this connection, and a tor that is gone has said why.
        if (tor.launched || proc.exitCode !== null || proc.signalCode !== null) return;
        lossTimer = setTimeout(() => cancel(new Error(CONTROL_LOST)), t.controlLossMs);
      }));
      await step(tor.control.send(`AUTHENTICATE ${cookie.toString('hex')}`));
      // tor exits when this connection closes, which a killed daemon's does at once.
      await step(tor.control.send('TAKEOWNERSHIP'));
      await step(tor.control.send('SETEVENTS HS_DESC STATUS_CLIENT'));
      const socks = (await step(tor.control.send('GETINFO net/listeners/socks'))).join(' ');
      tor.socksPort = Number(/net\/listeners\/socks="127\.0\.0\.1:(\d+)"/.exec(socks)?.[1]);
      if (!tor.socksPort) throw new Error(`tor reported no SOCKS listener: ${socks}`);
      // Progress made before the events were asked for is in the phase; later progress
      // arrives as events.
      progressed((await step(tor.control.send('GETINFO status/bootstrap-phase'))).join(' '));
      await step(bootstrapped);

      const added = await step(tor.control.send(
        `ADD_ONION ${torSecretKey(identity)} Flags=DiscardPK Port=80,127.0.0.1:${localPort}`,
      ));
      const published = /ServiceID=(\S+)/.exec(added.join('\n'))?.[1];
      // The address is what peers derive from the public key; a service under any other
      // one would be a host nobody can reach while it believes it is up.
      if (published !== serviceId) throw new Error(`tor published ${published}.onion, which is not this host's ${address}`);
      tor.launched = true;
      setState('publishing', 'waiting for the descriptor upload');
      publishTimer = setTimeout(
        () => setState('ready', `no upload confirmed in ${t.publishGraceMs / 1000} s`),
        t.publishGraceMs,
      );
      // An upload reported in the same read as ADD_ONION's reply was seen before this
      // line ran.
      if (uploaded) confirmed();
    } catch (err) {
      // The close of a dying tor's connection can be seen before its exit, which says
      // why: the launch is cancelled for the one or the other, and that is the reason.
      const why = err.message === CONTROL_LOST ? await aborted.catch((seen) => seen) : err;
      await end(tor);
      throw why;
    }
  }

  function restartLater() {
    restartTimer = setTimeout(async () => {
      try {
        await launch();
        restartDelay = t.restartMinMs;
      } catch (err) {
        if (stopping) return;
        setState('failed', err.message);
        restartDelay = Math.min(restartDelay * 2, t.restartMaxMs);
        restartLater();
      }
    }, restartDelay);
  }

  return {
    /// Resolves with the onion service added to a bootstrapped tor. Rejects when tor
    /// cannot be brought there; once it has resolved, a tor that dies is started again.
    async start(port) {
      localPort = port;
      await launch();
    },

    /// A connection to `onion`'s port 80 through tor. A SOCKS username of its own gives
    /// every peer its own circuits. That tor reports the connection made says nothing
    /// yet: a circuit can die before a byte crosses it, so only an answer is a success.
    dial(onion) {
      return new Promise((resolve, reject) => {
        const tor = run;
        if (!tor?.launched) return reject(fail('unreachable', 'tor is not running'));
        const socket = net.connect({ host: '127.0.0.1', port: tor.socksPort });
        dialing.add(socket);
        // The onion address is both the host to connect to and the SOCKS username.
        const name = Buffer.from(onion);
        const password = Buffer.from('dn1');
        let buffered = Buffer.alloc(0);
        let stage = 'method';

        const finish = (err) => {
          clearTimeout(timer);
          dialing.delete(socket);
          socket.off('data', onData).off('close', onClose);
          if (!err) return resolve(socket);
          socket.destroy();
          reject(err);
        };
        const timer = setTimeout(
          () => finish(fail('timeout', `tor did not connect to ${onion} in ${t.dialTimeoutMs / 1000} s`)),
          t.dialTimeoutMs,
        );
        const onClose = () => finish(fail('unreachable', 'tor closed the SOCKS connection'));
        const onData = (chunk) => {
          buffered = Buffer.concat([buffered, chunk]);
          if (stage === 'method' && buffered.length >= 2) {
            if (buffered[0] !== 5 || buffered[1] !== 2) return finish(fail('protocol', 'tor did not accept SOCKS5 with a username'));
            buffered = buffered.subarray(2);
            stage = 'auth';
            socket.write(Buffer.concat([Buffer.from([1, name.length]), name, Buffer.from([password.length]), password]));
          }
          if (stage === 'auth' && buffered.length >= 2) {
            if (buffered[1] !== 0) return finish(fail('protocol', 'tor refused the SOCKS username'));
            buffered = buffered.subarray(2);
            stage = 'connect';
            socket.write(Buffer.concat([Buffer.from([5, 1, 0, 3, name.length]), name, Buffer.from([0, 80])]));
          }
          if (stage === 'connect' && buffered.length >= 2) {
            const code = buffered[1];
            if (code !== 0) {
              const name = SOCKS_REPLY[code] ?? 'unknown';
              return finish(fail('unreachable', `tor could not reach ${onion}: ${name} (SOCKS reply 0x${code.toString(16).padStart(2, '0')})`));
            }
            if (buffered.length < 5) return;
            // The reply ends with the bound address, whose length depends on its type.
            const size = buffered[3] === 1 ? 10 : buffered[3] === 4 ? 22 : 7 + buffered[4];
            if (buffered.length < size) return;
            if (buffered.length > size) return finish(fail('protocol', 'tor sent bytes nobody asked for'));
            finish();
          }
        };
        // Stays for the socket's life: between this handshake and the request that takes
        // the socket over, nobody else listens.
        socket.on('error', () => {});
        socket.on('close', onClose);
        socket.on('data', onData);
        socket.once('connect', () => socket.write(Buffer.from([5, 1, 2])));
      });
    },

    /// Ends tor: SIGTERM, then SIGKILL after the grace. Resolves once it has exited.
    async stop() {
      stopping = true;
      clearTimeout(restartTimer);
      clearTimeout(publishTimer);
      abortLaunch?.(fail('stopped', 'the transport stopped'));
      for (const socket of dialing) socket.destroy();
      if (run) await end(run);
    },
  };
}
