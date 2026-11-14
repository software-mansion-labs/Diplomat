// The transport on plain loopback TCP, for tests and simulations. A directory stands in
// for the network: a host publishes `<onion>.addr` holding its `127.0.0.1:<port>`, and a
// dial resolves its target there. The same directory carries the faults, as files a test
// in any process writes and removes:
//
//   <onion>.down     that host refuses every request
//   <a>--<b>.cut     the two hosts cannot reach each other, in either direction
//   delay            milliseconds added to every request
//   <onion>.delay    milliseconds added to every request to that host
//
// Faults are read per request, not per connection, so a link cut after a connection was
// kept alive is cut all the same.

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fail } from './http.js';

/// Sets and clears the fault files of a loop directory: `down(onion, on)`,
/// `cut(a, b, on)`, `delay(ms, onion?)` with 0 clearing it.
export function loopFaults(dir) {
  const set = (name, text) => {
    fs.mkdirSync(dir, { recursive: true });
    if (text === null) fs.rmSync(path.join(dir, name), { force: true });
    else fs.writeFileSync(path.join(dir, name), text);
  };
  return {
    down: (onion, on = true) => set(`${onion}.down`, on ? '' : null),
    cut: (a, b, on = true) => {
      set(`${a}--${b}.cut`, on ? '' : null);
      if (!on) set(`${b}--${a}.cut`, null);
    },
    delay: (ms, onion) => set(onion ? `${onion}.delay` : 'delay', ms > 0 ? String(ms) : null),
  };
}

/// The loopback half of a transport: `{ start(port), dial(onion), hold(onion, deadline),
/// check(onion), stop() }`.
export function loopDriver({ address, dir, setState }) {
  const own = path.join(dir, `${address}.addr`);
  const holds = new Set(); // each pending delay's cancel function
  let published = '';

  const has = (name) => fs.existsSync(path.join(dir, name));
  const millis = (name) => {
    try { return Number(fs.readFileSync(path.join(dir, name), 'utf8')) || 0; } catch { return 0; }
  };

  function check(onion) {
    if (has(`${onion}.down`)) throw fail('unreachable', `${onion} is down`);
    if (has(`${address}--${onion}.cut`) || has(`${onion}--${address}.cut`)) {
      throw fail('unreachable', `the link to ${onion} is cut`);
    }
  }

  return {
    async start(port) {
      fs.mkdirSync(dir, { recursive: true });
      published = `127.0.0.1:${port}\n`;
      // Renamed into place: a dial never reads half an address.
      fs.writeFileSync(`${own}.${process.pid}.tmp`, published);
      fs.renameSync(`${own}.${process.pid}.tmp`, own);
      setState('ready', published.trim());
    },

    dial(onion) {
      return new Promise((resolve, reject) => {
        let target;
        try {
          target = fs.readFileSync(path.join(dir, `${onion}.addr`), 'utf8').trim();
        } catch {
          return reject(fail('unreachable', `${onion} has published no address`));
        }
        const socket = net.connect({ host: '127.0.0.1', port: Number(target.split(':')[1]) });
        socket.once('connect', () => {
          socket.off('error', refused);
          resolve(socket);
        });
        const refused = (err) => reject(fail('unreachable', `${onion} does not accept connections: ${err.code}`));
        socket.once('error', refused);
      });
    },

    /// Applies the faults a request to `onion` meets on its way out: refuses it, or keeps
    /// it for the delay, failing with `timeout` when that passes the deadline.
    hold(onion, deadline) {
      check(onion);
      const wait = millis('delay') + millis(`${onion}.delay`);
      if (wait === 0) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const late = Date.now() + wait > deadline;
        const timer = setTimeout(() => {
          holds.delete(cancel);
          if (late) reject(fail('timeout', `no answer from ${onion} in time`));
          else resolve();
        }, late ? Math.max(0, deadline - Date.now()) : wait);
        const cancel = () => {
          clearTimeout(timer);
          reject(fail('stopped', 'the transport stopped'));
        };
        holds.add(cancel);
      });
    },

    /// Throws `unreachable` when a fault stands between this host and `onion`. Asked again
    /// once the answer is in: a link cut while the peer was working loses the answer.
    check,

    async stop() {
      for (const cancel of [...holds]) cancel();
      holds.clear();
      // Left alone when a later host under the same identity has put its own there.
      try {
        if (published && fs.readFileSync(own, 'utf8') === published) fs.rmSync(own);
      } catch {}
    },
  };
}
