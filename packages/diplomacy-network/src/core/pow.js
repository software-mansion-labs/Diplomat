import crypto from 'node:crypto';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { hash, tagged, u32be, u64be } from './canon.js';
import { POW } from '../paths.js';

export const MAX_EFFORT = 0xffffffff;

export function validEffort(effort) {
  return Number.isInteger(effort) && effort >= 1 && effort <= MAX_EFFORT;
}

export function epochOf(ts) {
  return Math.floor(ts / POW.epochSecs);
}

export function epochAcceptable(epoch, now) {
  return Math.abs(epoch - epochOf(now)) <= 1;
}

/// `to` is a raw key.
export function seed(to, epoch) {
  return hash(tagged('dn1/seed', to, u64be(epoch)));
}

/// `to` and `from` are raw keys.
export function challenge({ to, from, epoch, nonce, effort, coreHash }) {
  return hash(tagged('dn1/pow', seed(to, epoch), to, from, nonce, u32be(effort), coreHash));
}

// R * effort <= 0xFFFFFFFF, without the 64-bit product.
const limit = (effort) => Math.floor(MAX_EFFORT / effort);

/// `counter` is null when `budget` ran out; `next` is the counter to go on from.
export function solve(c, effort, { from = 0, budget = Infinity } = {}) {
  const max = limit(effort);
  const input = Buffer.concat([c, Buffer.alloc(8)]);
  const end = from + budget;
  for (let i = from; i < end; i++) {
    input.writeUInt32BE(Math.floor(i / 2 ** 32), c.length);
    input.writeUInt32BE(i >>> 0, c.length + 4);
    if (crypto.hash('blake2b512', input, 'buffer').readUInt32BE(0) <= max) {
      return { counter: Buffer.from(input.subarray(c.length)), next: i + 1 };
    }
  }
  return { counter: null, next: end };
}

/// On a worker thread, so the caller's event loop keeps turning.
export function solveAsync(c, effort, { signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const worker = new Worker(new URL(import.meta.url), { workerData: { dn1pow: { challenge: c, effort } } });
    const abort = () => {
      worker.terminate();
      reject(signal.reason);
    };
    signal?.addEventListener('abort', abort, { once: true });
    worker.once('message', (counter) => {
      signal?.removeEventListener('abort', abort);
      resolve(Buffer.from(counter));
    });
    worker.once('error', reject);
  });
}

/// Hourly spend on peers' proofs, in expected hashes. Limits: `peer` per peer, `all` in
/// total, `search` for search requests (within `all`), and `floor` per member known for
/// `floorAfter` seconds whatever `all` says. `top` is the most one request may cost.
export class Spending {
  #limits;
  #top;
  #all = { paid: [], spent: 0 };
  #search = { paid: [], spent: 0 };
  #peers = new Map();
  #shares = new Map();

  constructor(limits, top = 0) {
    this.#limits = limits;
    this.#top = top;
  }

  /// False, taking nothing, when `effort` does not fit. `share: { key, of }` caps a search's
  /// requests per `key` at `search / of`, or `top` if more, and pays one request up to `top`
  /// per key even when `search` is spent, so each key can be asked at least once an hour.
  pay(pk, since, effort, now, { member = true, search = false, share = null } = {}) {
    if (!this.#peers.has(pk)) this.#peers.set(pk, { paid: [], spent: 0 });
    const one = this.#peers.get(pk);
    if (search && share && !this.#shares.has(share.key)) this.#shares.set(share.key, { paid: [], spent: 0 });
    const part = search && share ? this.#shares.get(share.key) : null;
    const purses = [one, this.#all, ...(search ? [this.#search] : []), ...(part ? [part] : [])];
    for (const purse of purses) {
      while (purse.paid.length > 0 && purse.paid[0][0] <= now - 3600) purse.spent -= purse.paid.shift()[1];
    }
    const { peer, all, floor, floorAfter } = this.#limits;
    if (one.spent + effort > peer) return false;
    const over = search && this.#search.spent + effort > this.#limits.search;
    if (part ? part.spent + effort > Math.max(this.#limits.search / share.of, this.#top) || (over && part.spent + effort > this.#top) : over) return false;
    const anyway = member && now - since >= floorAfter && one.spent + effort <= floor;
    if (!anyway && this.#all.spent + effort > all) return false;
    for (const purse of purses) {
      purse.paid.push([now, effort]);
      purse.spent += effort;
    }
    return true;
  }
}

/// At most `workers` proofs at a time, cheapest waiting first: a costly proof keeps no
/// cheap one waiting longer than the ones already begun.
export function solverPool(workers, run = solveAsync) {
  const waiting = [];
  let running = 0;
  const next = () => {
    while (running < workers && waiting.length > 0) {
      const job = waiting.shift();
      running += 1;
      run(job.c, job.effort, job.options).then(job.resolve, job.reject).finally(() => {
        running -= 1;
        next();
      });
    }
  };
  return (c, effort, options) => new Promise((resolve, reject) => {
    const at = waiting.findIndex((other) => other.effort > effort);
    waiting.splice(at < 0 ? waiting.length : at, 0, { c, effort, options, resolve, reject });
    next();
  });
}

if (!isMainThread && workerData?.dn1pow) {
  const { challenge: c, effort } = workerData.dn1pow;
  parentPort.postMessage(solve(Buffer.from(c), effort).counter);
}

export function check(c, effort, counter) {
  if (!validEffort(effort) || !Buffer.isBuffer(counter) || counter.length !== 8) return false;
  return crypto.hash('blake2b512', Buffer.concat([c, counter]), 'buffer').readUInt32BE(0) <= limit(effort);
}

/// Each member has a window of its own; all strangers share one.
export class EffortMeter {
  #tiers;
  #windowSecs;
  #members = new Map(); // pk -> request times, oldest first
  #strangers = [];

  constructor({ memberBase, memberAllow, memberCap, strangerBase, strangerAllow, strangerCap, windowSecs } = POW) {
    this.#tiers = {
      member: { base: memberBase, allow: memberAllow, cap: memberCap },
      stranger: { base: strangerBase, allow: strangerAllow, cap: strangerCap },
    };
    this.#windowSecs = windowSecs;
  }

  #recent(times, now) {
    while (times.length > 0 && times[0] <= now - this.#windowSecs) times.shift();
    return times.length;
  }

  #times(sender, member) {
    if (!member) return this.#strangers;
    if (!this.#members.has(sender)) this.#members.set(sender, []);
    return this.#members.get(sender);
  }

  get least() {
    return Math.min(this.#tiers.member.base, this.#tiers.stranger.base);
  }

  required(sender, member, now) {
    const { base, allow, cap } = this.#tiers[member ? 'member' : 'stranger'];
    const times = this.#times(sender, member);
    const n = this.#recent(times, now) + 1;
    if (member && times.length === 0) this.#members.delete(sender);
    let doublings = 0;
    while (doublings < cap && allow * 2 ** doublings < n) doublings += 1;
    return base * 2 ** doublings;
  }

  count(sender, member, now) {
    const { allow, cap } = this.#tiers[member ? 'member' : 'stranger'];
    const times = this.#times(sender, member);
    times.push(now);
    // Past the last doubling more requests change nothing, so no more are kept.
    if (times.length > Math.max(1, allow * 2 ** (cap - 1))) times.shift();
  }
}
