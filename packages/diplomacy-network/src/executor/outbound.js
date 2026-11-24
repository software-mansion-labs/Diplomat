// The connections the broker opens out to the internet for its jobs. Their socket
// buffers are this machine's kernel memory: what a far host has not acknowledged yet,
// and what came from it that the job has not read. Node can neither limit those buffers
// nor say how full they are, so the kernel is asked: on Linux /proc/self/net/tcp and
// tcp6, on macOS one netstat process, every OUT_POLL_MS while any such connection is
// open. Of what the poll finds, all jobs together may hold OUT_BYTES, shared out
// equally among the jobs that have connections out.
//
// What a job sends goes into the kernel as fast as this machine can copy it, so it is
// counted as it is written: a job whose connections out hold its share, by the last
// poll and what was written since, has its writes kept back in node until a poll finds
// room. What comes in comes at the speed of the host's link, and a poll that finds all
// jobs past OUT_BYTES resets connections until they are within it: of the job furthest
// past its share, as one is when another job comes, the connection that holds the
// most. A connection closed while the kernel still holds its bytes is counted until
// they are gone.

import fs from 'node:fs/promises';
import os from 'node:os';
import { execFile } from 'node:child_process';

/// What the connections out of all jobs may have queued in the kernel at once, either way.
export const OUT_BYTES = 32 * 1024 * 1024;
/// How often the kernel is asked while connections are open, and how soon after the
/// last time once a job's writes are kept back.
export const OUT_POLL_MS = 500;
export const OUT_SOONEST_MS = 100;
/// How many connections out a job may have open while the kernel cannot be asked.
export const OUT_FALLBACK = 32;

/// An address as it is compared: IPv4 dotted, IPv6 as its eight groups in hex, without
/// leading zeros and without "::".
export function plainAddress(address) {
  if (!address.includes(':')) return address;
  let text = address.toLowerCase();
  const v4 = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (v4) {
    const [a, b, c, d] = v4.slice(1).map(Number);
    text = `${text.slice(0, v4.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = text.split('::');
  const left = head ? head.split(':') : [];
  const right = tail === undefined ? [] : tail ? tail.split(':') : [];
  const groups = tail === undefined ? left : [...left, ...Array(8 - left.length - right.length).fill('0'), ...right];
  return groups.map((g) => (parseInt(g, 16) || 0).toString(16)).join(':');
}

// The kernel writes each 32-bit word of an address in /proc in its own byte order.
function procAddress(hex) {
  const bytes = Buffer.from(hex, 'hex');
  if (os.endianness() === 'LE') for (let i = 0; i < bytes.length; i += 4) bytes.subarray(i, i + 4).reverse();
  if (bytes.length === 4) return [...bytes].join('.');
  const groups = [];
  for (let i = 0; i < 16; i += 2) groups.push(bytes.readUInt16BE(i).toString(16));
  return groups.join(':');
}

/// The connections in the text of /proc/net/tcp or tcp6, but those listening:
/// `{ local, localPort, remote, remotePort, bytes }`, `bytes` what is queued either way.
/// Throws on text that is not such a table.
export function parseProc(text) {
  const lines = text.split('\n');
  if (!/^\s*sl\s+local_address\s+rem(?:ote)?_address\s+st\s+tx_queue\s+rx_queue/.test(lines[0])) throw new Error('not a table of TCP sockets');
  const rows = [];
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    const m = /^\s*\d+:\s+([0-9A-F]+):([0-9A-F]{4})\s+([0-9A-F]+):([0-9A-F]{4})\s+([0-9A-F]{2})\s+([0-9A-F]{8}):([0-9A-F]{8})\s/.exec(line);
    if (!m) throw new Error(`not a TCP socket: ${line.slice(0, 120)}`);
    if (m[5] === '0A') continue;
    rows.push({
      local: procAddress(m[1]), localPort: parseInt(m[2], 16), remote: procAddress(m[3]), remotePort: parseInt(m[4], 16),
      bytes: parseInt(m[6], 16) + parseInt(m[7], 16),
    });
  }
  return rows;
}

/// The connections in what `netstat -an -p tcp` prints on macOS, as parseProc has them:
/// a socket with no far end (`*.*`), one listening among them, is none. netstat cuts an IPv6 address to its first 16 characters, and such
/// an address has `cut` set. Throws on text that is not such a table.
export function parseNetstat(text) {
  const lines = text.split('\n');
  const header = lines.findIndex((l) => /^Proto\s+Recv-Q\s+Send-Q\s+Local Address\s+Foreign Address/.test(l));
  if (header < 0) throw new Error('netstat printed no table of connections');
  const rows = [];
  const split = (field) => {
    const at = field.lastIndexOf('.');
    const address = field.slice(0, at);
    const port = field.slice(at + 1);
    return { address, port: port === '*' ? null : Number(port), cut: address.includes(':') && address.length >= 16 };
  };
  for (const line of lines.slice(header + 1)) {
    if (!line.trim()) continue;
    const m = /^tcp[46]{1,2}\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s/.exec(line);
    if (!m) throw new Error(`not a TCP connection: ${line.slice(0, 120)}`);
    const local = split(m[3]);
    const remote = split(m[4]);
    if (remote.port === null) continue;
    if (!Number.isInteger(local.port) || !Number.isInteger(remote.port)) throw new Error(`not a TCP connection: ${line.slice(0, 120)}`);
    rows.push({
      local: local.cut ? local.address : plainAddress(local.address), localPort: local.port, localCut: local.cut,
      remote: remote.cut ? remote.address : plainAddress(remote.address), remotePort: remote.port, remoteCut: remote.cut,
      bytes: Number(m[1]) + Number(m[2]),
    });
  }
  return rows;
}

async function procTable(name) {
  try { return parseProc(await fs.readFile(`/proc/self/net/${name}`, 'utf8')); } catch (e) {
    // A kernel without IPv6 has no tcp6.
    if (e.code === 'ENOENT' && name === 'tcp6') return [];
    throw e;
  }
}

/// The connections of this machine as the kernel has them, by `parseProc`.
export async function systemQueues() {
  if (process.platform === 'linux') return [...await procTable('tcp'), ...await procTable('tcp6')];
  if (process.platform === 'darwin') {
    const text = await new Promise((resolve, reject) => execFile('/usr/sbin/netstat', ['-an', '-p', 'tcp'], { maxBuffer: 64 * 1024 * 1024, timeout: 5000 },
      (e, out) => (e ? reject(e) : resolve(out))));
    return parseNetstat(text);
  }
  throw new Error(`the kernel's socket queues cannot be read on ${process.platform}`);
}

/// `createOutbound()` makes the count of the connections out of all jobs. `add(job, raw)`
/// counts `raw`, a connected TCP socket, as the job's; what TLS over it writes is not seen
/// as it is written, only in the polls. `full(job)` is true while polls fail and the job
/// has `fallback` connections out open. `drop(job)` resets the job's connections and
/// forgets them. `say(job, text)` is told of each connection reset, and with `job` null
/// of polls that fail and work again. `queues` replaces `systemQueues`.
export function createOutbound({ bytes = OUT_BYTES, every = OUT_POLL_MS, soonest = OUT_SOONEST_MS, fallback = OUT_FALLBACK,
  queues = systemQueues, say = () => {} } = {}) {
  const jobs = new Map(); // job -> { job, entries, est, queued }
  let timer = null;
  let due = 0;
  let polling = false;
  let failing = false;
  let last = 0;

  const share = () => Math.floor(bytes / jobs.size);
  const live = (state) => [...state.entries].filter((e) => !e.gone);

  function schedule(delay) {
    const at = Date.now() + delay;
    if (polling || (timer && due <= at)) return;
    clearTimeout(timer);
    due = at;
    timer = setTimeout(poll, delay);
    timer.unref();
  }

  function hold(state) {
    for (const entry of live(state)) {
      if (entry.corked) continue;
      entry.corked = true;
      entry.raw.cork();
    }
    schedule(Math.max(0, last + soonest - Date.now()));
  }

  // Lets as many of the job's kept-back connections go as what each kept back fits in
  // its share, counted as written; one at the least once the job holds nothing.
  function release(state, limit) {
    for (const entry of live(state)) {
      if (!entry.corked) continue;
      const kept = entry.raw.writableLength;
      if (state.est + kept > limit && state.est > 0) continue;
      entry.corked = false;
      state.est += kept;
      entry.raw.uncork();
    }
  }

  async function poll() {
    timer = null;
    polling = true;
    // What is written from here on is not in what the kernel is about to say, and
    // neither is what node has not handed it yet; a kept-back connection's bytes are
    // counted as it is let go.
    for (const state of jobs.values()) {
      for (const entry of state.entries) entry.base = entry.wrote - (entry.corked || entry.gone ? 0 : entry.raw.writableLength);
    }
    let rows;
    try { rows = await queues(); } catch (e) { rows = e; }
    polling = false;
    last = Date.now();
    if (rows instanceof Error) {
      if (!failing) {
        failing = true;
        say(null, `the kernel's queues of the connections out cannot be read (${rows.message}): until they can, a job may have ${fallback} connections out open, and what they hold is not counted`);
        for (const state of jobs.values()) release(state, Infinity);
      }
      for (const [job, state] of jobs) {
        for (const entry of state.entries) if (entry.gone) state.entries.delete(entry);
        if (state.entries.size === 0) jobs.delete(job);
      }
      if (jobs.size) schedule(every);
      return;
    }
    if (failing) {
      failing = false;
      say(null, 'the kernel\'s queues of the connections out can be read again');
    }
    const byPorts = new Map();
    for (const row of rows) {
      const key = `${row.localPort} ${row.remotePort}`;
      if (!byPorts.has(key)) byPorts.set(key, []);
      byPorts.get(key).push(row);
    }
    const same = (text, cut, address) => (cut ? address.startsWith(text) : text === address);
    let total = 0;
    for (const [job, state] of jobs) {
      state.queued = 0;
      for (const entry of state.entries) {
        entry.wrote -= entry.base;
        entry.queued = 0;
        for (const row of byPorts.get(`${entry.localPort} ${entry.remotePort}`) ?? []) {
          if (same(row.local, row.localCut, row.localCut ? entry.localText : entry.local)
            && same(row.remote, row.remoteCut, row.remoteCut ? entry.remoteText : entry.remote)) entry.queued = Math.max(entry.queued, row.bytes);
        }
        // A closed connection is counted for as long as the kernel holds bytes of it.
        if (entry.gone && entry.queued === 0) state.entries.delete(entry);
        state.queued += entry.queued;
      }
      if (state.entries.size === 0) jobs.delete(job);
      total += state.queued;
    }
    // Every job's share is the same, so the job furthest past its share holds the most.
    while (total > bytes) {
      let worst = null;
      for (const state of jobs.values()) {
        if (live(state).some((e) => e.queued > 0) && (!worst || state.queued > worst.queued)) worst = state;
      }
      if (!worst) break;
      const entry = live(worst).reduce((a, b) => (b.queued > a.queued ? b : a));
      say(worst.job, `a connection out of this job to ${entry.remoteText}:${entry.remotePort} is reset: the connections out of all jobs held more than the ${bytes / 2 ** 20} MiB of this machine's memory they may, and this job's ${(worst.queued / 2 ** 20).toFixed(1)} MiB the most past its share`);
      entry.raw.resetAndDestroy();
      total -= entry.queued;
      worst.queued -= entry.queued;
      entry.queued = 0;
    }
    const limit = share();
    for (const state of jobs.values()) {
      state.est = [...state.entries].reduce((sum, e) => sum + e.queued + e.wrote, 0);
      release(state, limit);
    }
    if (jobs.size) schedule([...jobs.values()].some((state) => live(state).some((e) => e.corked)) ? soonest : every);
  }

  function add(job, raw) {
    if (!jobs.has(job)) jobs.set(job, { job, entries: new Set(), est: 0, queued: 0 });
    const state = jobs.get(job);
    const entry = {
      raw, wrote: 0, base: 0, queued: 0, corked: false, gone: false,
      local: plainAddress(raw.localAddress), localText: raw.localAddress, localPort: raw.localPort,
      remote: plainAddress(raw.remoteAddress), remoteText: raw.remoteAddress, remotePort: raw.remotePort,
    };
    state.entries.add(entry);
    const write = raw.write;
    raw.write = function counted(chunk, encoding, cb) {
      const n = typeof chunk === 'string' ? Buffer.byteLength(chunk, typeof encoding === 'string' ? encoding : 'utf8') : chunk.length;
      entry.wrote += n;
      state.est += n;
      if (!failing && !entry.corked && state.est >= share()) hold(state);
      return write.call(this, chunk, encoding, cb);
    };
    raw.once('close', () => { entry.gone = true; });
    schedule(every);
  }

  function full(job) {
    const state = jobs.get(job);
    return failing && !!state && live(state).length >= fallback;
  }

  function drop(job) {
    const state = jobs.get(job);
    if (!state) return;
    jobs.delete(job);
    for (const entry of live(state)) entry.raw.resetAndDestroy();
  }

  return { add, full, drop, fallback };
}
