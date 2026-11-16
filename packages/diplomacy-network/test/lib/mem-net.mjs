// A network in memory for the node's tests: transports that carry bytes between hosts
// of one process, and the one virtual clock they all live by. Delay, loss and duplication
// are drawn from a seed; pairs of hosts can be cut apart and a host taken down or killed.
// Nothing here waits on real time: `run` carries out what is due, in order.

import { onionAddress } from '../../src/core/identity.js';

export const T0 = 1794000000;

/// A seeded generator: `next()` in [0, 1), `int(n)`, `chance(p)`, `bytes(n)`.
export function prng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
  return {
    next,
    int: (n) => Math.floor(next() * n),
    chance: (p) => p > 0 && next() < p,
    bytes: (n) => Buffer.from(Array.from({ length: n }, () => Math.floor(next() * 256))),
  };
}

const failure = (code) => Object.assign(new Error(code), { code });

// The kind an envelope names, or null for bytes that are no envelope.
function kindOf(body) {
  try {
    return JSON.parse(body.toString('utf8')).kind ?? null;
  } catch {
    return null;
  }
}

/// The network. `sent` lists every request a host made, as `{ at, from, to, kind, bytes }`.
export function createNet({ seed = 1 } = {}) {
  const rnd = prng(seed);
  const queue = []; // a heap of { t, n, fn, owner, cancelled }
  const hosts = new Map(); // name -> host
  const byPk = new Map();
  const cuts = new Set(); // "a|b" for every pair that cannot reach each other
  const faults = { minMs: 5, maxMs: 40, drop: 0, duplicate: 0 };
  const sent = [];
  const taps = [];
  let ms = 0;
  let count = 0;

  const before = (x, y) => x.t < y.t || (x.t === y.t && x.n < y.n);
  function at(delay, fn, owner = null) {
    const event = { t: ms + Math.max(0, delay), n: count += 1, fn, owner, cancelled: false };
    let i = queue.push(event) - 1;
    while (i > 0 && before(event, queue[(i - 1) >> 1])) {
      queue[i] = queue[(i - 1) >> 1];
      i = (i - 1) >> 1;
    }
    queue[i] = event;
    return event;
  }
  function pop() {
    const top = queue[0];
    const last = queue.pop();
    if (queue.length === 0) return top;
    let i = 0;
    for (;;) {
      let child = 2 * i + 1;
      if (child >= queue.length) break;
      if (child + 1 < queue.length && before(queue[child + 1], queue[child])) child += 1;
      if (!before(queue[child], last)) break;
      queue[i] = queue[child];
      i = child;
    }
    queue[i] = last;
    return top;
  }

  const now = () => T0 + Math.floor(ms / 1000);
  const pair = (a, b) => [a, b].sort().join('|');
  const delay = () => faults.minMs + rnd.int(faults.maxMs - faults.minMs + 1);
  const linked = (a, b) => b && b.up && !b.dead && b.ready && !a.dead && !cuts.has(pair(a.name, b.name));
  // Everything a promise chain can do without a timer has happened once this resolves.
  const settled = () => new Promise((resolve) => { setImmediate(resolve); });

  /// Carries out everything due in the next `forMs` of virtual time.
  async function run(forMs) {
    const until = ms + forMs;
    while (queue.length > 0 && queue[0].t <= until) {
      const event = pop();
      if (event.cancelled || event.owner?.dead) continue;
      ms = event.t;
      event.fn();
      await settled();
    }
    ms = until;
    await settled();
  }

  /// Runs until `test()` holds, looking every `stepMs`; throws when `maxMs` pass first.
  async function until(test, { maxMs = 10 * 60 * 1000, stepMs = 250, what = 'the awaited state' } = {}) {
    const end = ms + maxMs;
    await settled();
    while (!test()) {
      if (ms >= end) throw new Error(`${what} was not reached in ${maxMs / 1000} s of virtual time`);
      await run(stepMs);
    }
  }

  /// The clock of one host: its timers die with it.
  function clock(name) {
    return {
      now,
      setTimeout: (fn, delayMs) => at(delayMs, fn, hosts.get(name)),
      clearTimeout: (handle) => {
        if (handle) handle.cancelled = true;
      },
    };
  }

  /// A transport for the host `name` whose key is `pk`, replacing any that name had.
  function transport(name, pk) {
    const host = {
      name, pk, up: true, dead: false, ready: false, stopped: false, startDelayMs: 0,
      handler: async () => { throw new Error('no handler'); }, limit: () => 1 << 20, watchers: [],
    };
    hosts.set(name, host);
    byPk.set(pk, host);
    const state = () => ({ state: host.stopped ? 'failed' : host.ready ? 'ready' : 'starting', detail: '' });
    const announce = () => host.watchers.forEach((fn) => fn(state()));

    function request(to, body, { timeoutMs = 60000, maxResponseBytes = 1 << 20, headers = {} } = {}) {
      return new Promise((resolve, reject) => {
        let open = true;
        const settle = (fn, value) => {
          if (!open || host.dead) return;
          open = false;
          fn(value);
        };
        const fail = (code, after) => at(after, () => settle(reject, failure(code)), host);
        const target = byPk.get(to);
        const kind = kindOf(body);
        sent.push({ at: now(), from: name, to: target?.name ?? null, kind, bytes: body.length });
        for (const tap of taps) tap({ from: name, to: target?.name ?? null, headers, kind, body });
        if (host.stopped) return fail('stopped', 0);
        if (!host.ready || !host.up) return fail('unreachable', 0);
        fail('timeout', timeoutMs);
        // A host that is down refuses quickly; one behind a cut, or a lost request, is silence.
        if (target && !cuts.has(pair(name, target.name)) && !(target.up && !target.dead && target.ready)) return fail('unreachable', Math.min(3000, timeoutMs));
        if (!linked(host, target) || rnd.chance(faults.drop)) return undefined;
        // A duplicate is what the real transport does when a kept connection turns out
        // dead: the same bytes go out again, and only the second copy's answer comes back.
        const copies = rnd.chance(faults.duplicate) ? 2 : 1;
        let sentAt = 0;
        for (let copy = 0; copy < copies; copy += 1) {
          sentAt += delay();
          at(sentAt, async () => {
            if (!linked(host, target)) return;
            const all = { ...headers, 'content-length': String(body.length) };
            const says = target.limit(all);
            const { bytes, release = () => {} } = typeof says === 'number' ? { bytes: says } : says;
            let out;
            if (body.length > bytes) out = 'http-413';
            else out = await target.handler(Buffer.from(body), { headers: all }).catch(() => 'http-500');
            release();
            if (copy < copies - 1 || rnd.chance(faults.drop)) return;
            at(delay(), () => {
              if (!linked(host, target)) return;
              if (typeof out === 'string') settle(reject, failure(out));
              else if (out.length > maxResponseBytes) settle(reject, failure('too-large'));
              else settle(resolve, out);
            });
          });
        }
        return undefined;
      });
    }

    return {
      address: onionAddress(pk),
      state,
      onState: (fn) => host.watchers.push(fn),
      onRequest: (fn) => { host.handler = fn; },
      limitFor: (fn) => { host.limit = fn; },
      request,
      start() {
        return new Promise((resolve) => {
          at(host.startDelayMs, () => {
            host.ready = true;
            announce();
            resolve();
          }, host);
        });
      },
      async stop() {
        host.stopped = true;
        host.ready = false;
      },
      host,
    };
  }

  return {
    rnd, sent, faults, now, run, until, clock, transport, settled,
    /// How many timers of a host are waiting to fire.
    timers: (name) => queue.filter((event) => !event.cancelled && event.owner === hosts.get(name)).length,
    /// Calls `fn({ from, to, headers, kind, body })` for every request a host makes.
    tap: (fn) => taps.push(fn),
    /// Milliseconds of virtual time since the network began.
    ms: () => ms,
    /// Cuts two hosts apart, or joins them again.
    cut(a, b, on = true) {
      if (on) cuts.add(pair(a, b));
      else cuts.delete(pair(a, b));
    },
    /// Splits the hosts into the given groups of names: only hosts of one group reach each other.
    split(...groups) {
      cuts.clear();
      const all = groups.flat();
      for (const a of all) {
        for (const b of all) {
          if (a < b && groups.findIndex((g) => g.includes(a)) !== groups.findIndex((g) => g.includes(b))) cuts.add(pair(a, b));
        }
      }
    },
    heal: () => cuts.clear(),
    /// Takes a host off the network or puts it back; it keeps running either way.
    down(name, off = true) {
      hosts.get(name).up = !off;
    },
    /// Ends a host's process: its timers never fire and nothing it awaits ever arrives.
    kill(name) {
      hosts.get(name).dead = true;
    },
    /// How many requests of `kind` the host `from` made to `to` since virtual second `since`.
    count: ({ from, to, kind, since = 0 }) => sent.filter((s) => s.at >= since && (!from || s.from === from)
      && (!to || s.to === to) && (!kind || s.kind === kind)).length,
  };
}
