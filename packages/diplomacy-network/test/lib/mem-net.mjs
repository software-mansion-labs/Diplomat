// An in-memory network on one seeded virtual clock: nothing waits on real time, `run`
// carries out what is due, in order.

import { onionAddress } from '../../src/core/identity.js';

export const T0 = 1794000000;

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

function kindOf(body) {
  try {
    return JSON.parse(body.toString('utf8')).kind ?? null;
  } catch {
    return null;
  }
}

export function createNet({ seed = 1 } = {}) {
  const rnd = prng(seed);
  const queue = []; // min-heap on (t, n)
  const hosts = new Map();
  const byPk = new Map();
  const cuts = new Set();
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
  const linked = (a, b) => b && b.up && !b.dead && !b.asleep && b.ready && !a.dead && !a.asleep && !cuts.has(pair(a.name, b.name));
  // Resolves once every timer-free promise continuation has run.
  const settled = () => new Promise((resolve) => { setImmediate(resolve); });

  async function run(forMs) {
    const until = ms + forMs;
    while (queue.length > 0 && queue[0].t <= until) {
      const event = pop();
      if (event.cancelled || event.owner?.dead) continue;
      // The timers of a machine that sleeps fire when it wakes.
      if (event.owner?.asleep) {
        event.owner.late.push(event);
        continue;
      }
      ms = event.t;
      event.fn();
      await settled();
    }
    ms = until;
    await settled();
  }

  async function until(test, { maxMs = 10 * 60 * 1000, stepMs = 250, what = 'the awaited state' } = {}) {
    const end = ms + maxMs;
    await settled();
    while (!test()) {
      if (ms >= end) throw new Error(`${what} was not reached in ${maxMs / 1000} s of virtual time`);
      await run(stepMs);
    }
  }

  /// A host's clock; its timers die with it.
  function clock(name) {
    return {
      now,
      setTimeout: (fn, delayMs) => at(delayMs, fn, hosts.get(name)),
      clearTimeout: (handle) => {
        if (handle) handle.cancelled = true;
      },
    };
  }

  /// Replaces any transport `name` had.
  function transport(name, pk) {
    const host = {
      name, pk, up: true, dead: false, asleep: false, late: [], ready: false, stopped: false, startDelayMs: 0,
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
          // A sleeping machine's connections are gone, so its answers are lost.
          if (!open || host.dead || host.asleep) return false;
          open = false;
          fn(value);
          return true;
        };
        const fail = (code, after) => at(after, () => settle(reject, failure(code)), host);
        const target = byPk.get(to);
        const kind = kindOf(body);
        sent.push({ at: now(), from: name, to: target?.name ?? null, kind, bytes: body.length });
        const heard = taps.map((tap) => tap({ from: name, to: target?.name ?? null, headers, kind, body }))
          .map((fn) => (typeof fn === 'function' ? { answered: fn } : fn)).filter(Boolean);
        if (host.stopped) return fail('stopped', 0);
        if (!host.ready || !host.up) return fail('unreachable', 0);
        fail('timeout', timeoutMs);
        // A host that is down refuses quickly; one behind a cut, or a lost request, is silence.
        if (target && !cuts.has(pair(name, target.name)) && !(target.up && !target.dead && target.ready)) return fail('unreachable', Math.min(3000, timeoutMs));
        if (!linked(host, target) || rnd.chance(faults.drop)) return undefined;
        // As the real transport resends on a dead kept connection: only the second copy's answer returns.
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
            for (const tap of heard) tap.answered?.(out);
            if (copy < copies - 1 || rnd.chance(faults.drop)) return;
            at(delay(), () => {
              if (!linked(host, target)) return;
              if (typeof out === 'string') settle(reject, failure(out));
              else if (out.length > maxResponseBytes) settle(reject, failure('too-large'));
              else if (settle(resolve, out)) for (const tap of heard) tap.reached?.(out);
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
    timers: (name) => queue.filter((event) => !event.cancelled && event.owner === hosts.get(name)).length,
    /// `fn({ from, to, headers, kind, body })` sees every request. It may return a function
    /// called with each delivered copy's answer (bytes, or a transport code), or
    /// `{ answered, reached }` where `reached` gets the answer the asker received.
    tap: (fn) => taps.push(fn),
    /// Virtual ms since the network began.
    ms: () => ms,
    cut(a, b, on = true) {
      if (on) cuts.add(pair(a, b));
      else cuts.delete(pair(a, b));
    },
    /// Only hosts in one group reach each other; clears any other cut.
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
    /// Off the network, but still running.
    down(name, off = true) {
      hosts.get(name).up = !off;
    },
    /// Asleep, nothing reaches it, no answer comes to it and its timers wait while its
    /// clock goes on; timers due meanwhile fire `timersInMs` after it wakes.
    sleep(name, on = true, { timersInMs = 0 } = {}) {
      const host = hosts.get(name);
      host.asleep = on;
      if (on) return;
      for (const event of host.late.splice(0)) at(timersInMs, () => event.cancelled || event.fn(), host);
    },
    /// Its timers never fire and nothing it awaits arrives.
    kill(name) {
      hosts.get(name).dead = true;
    },
    /// `since` is in virtual seconds.
    count: ({ from, to, kind, since = 0 }) => sent.filter((s) => s.at >= since && (!from || s.from === from)
      && (!to || s.to === to) && (!kind || s.kind === kind)).length,
  };
}
