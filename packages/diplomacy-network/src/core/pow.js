// The proof of work every request carries (PROTOCOL.md section 3): the seed and the
// challenge a solution is bound to, solving and checking it, and the meter that decides
// how much work a sender owes.

import crypto from 'node:crypto';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { hash, tagged, u32be, u64be } from './canon.js';
import { POW } from '../paths.js';

export const MAX_EFFORT = 0xffffffff;

/// Is this an effort a request may state: an integer from 1 to 2^32 - 1?
export function validEffort(effort) {
  return Number.isInteger(effort) && effort >= 1 && effort <= MAX_EFFORT;
}

/// The epoch a time falls in.
export function epochOf(ts) {
  return Math.floor(ts / POW.epochSecs);
}

/// Does a target whose clock reads `now` accept this epoch: its own or one directly beside it?
export function epochAcceptable(epoch, now) {
  return Math.abs(epoch - epochOf(now)) <= 1;
}

/// `seed(to, epoch)`: 32 bytes anyone can compute. `to` is the target's raw key.
export function seed(to, epoch) {
  return hash(tagged('dn1/seed', to, u64be(epoch)));
}

/// The challenge a solution answers. `to` and `from` are raw keys, `nonce` the 16 random
/// bytes of the request, `coreHash` the hash of the envelope's core.
export function challenge({ to, from, epoch, nonce, effort, coreHash }) {
  return hash(tagged('dn1/pow', seed(to, epoch), to, from, nonce, u32be(effort), coreHash));
}

// R * effort <= 0xFFFFFFFF, without the 64-bit product.
const limit = (effort) => Math.floor(MAX_EFFORT / effort);

/// Tries the counters `from`, `from + 1`, ... for at most `budget` of them and returns
/// `{ counter, next }`: the 8-byte solution, or null when the budget ran out, and the
/// counter to go on from.
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

/// The 8-byte solution, found on a worker thread so the caller's event loop keeps
/// turning. Aborting `signal` stops the search and rejects with the signal's reason.
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

/// What a host paid its peers in the last hour, in hashes expected, and whether it pays
/// more: `peer` is the most for one peer, `all` the most for all of them together,
/// `floor` what a member known for `floorAfter` seconds is paid whatever the others took,
/// and `search` the most for the requests of a search together, out of `all`.
export class Spending {
  #limits;
  #all = { paid: [], spent: 0 };
  #search = { paid: [], spent: 0 };
  #peers = new Map();

  constructor(limits) {
    this.#limits = limits;
  }

  /// Takes `effort` for the peer `pk`, known since `since`, out of this hour at `now`;
  /// false, with nothing taken, when that much is not left. `member` says whether the
  /// peer is one the floor is for, `search` whether the request is a search's.
  pay(pk, since, effort, now, { member = true, search = false } = {}) {
    if (!this.#peers.has(pk)) this.#peers.set(pk, { paid: [], spent: 0 });
    const one = this.#peers.get(pk);
    const purses = search ? [one, this.#all, this.#search] : [one, this.#all];
    for (const purse of purses) {
      while (purse.paid.length > 0 && purse.paid[0][0] <= now - 3600) purse.spent -= purse.paid.shift()[1];
    }
    const { peer, all, floor, floorAfter } = this.#limits;
    if (one.spent + effort > peer) return false;
    if (search && this.#search.spent + effort > this.#limits.search) return false;
    const anyway = member && now - since >= floorAfter && one.spent + effort <= floor;
    if (!anyway && this.#all.spent + effort > all) return false;
    for (const purse of purses) {
      purse.paid.push([now, effort]);
      purse.spent += effort;
    }
    return true;
  }
}

/// A `solve(c, effort, { signal })` that works on at most `workers` proofs at a time,
/// each on a thread of its own, and takes the cheapest of those waiting first: a proof
/// at the highest price keeps no cheap one waiting longer than the ones already begun.
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

/// Does `counter` solve the challenge at `effort`?
export function check(c, effort, counter) {
  if (!validEffort(effort) || !Buffer.isBuffer(counter) || counter.length !== 8) return false;
  return crypto.hash('blake2b512', Buffer.concat([c, counter]), 'buffer').readUInt32BE(0) <= limit(effort);
}

/// How much work each sender owes one target. A member has a window of its own; every
/// stranger shares one.
export class EffortMeter {
  #tiers;
  #windowSecs;
  #members = new Map(); // pk -> the times of its requests inside the window, oldest first
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

  /// The least a request can owe: the lower of the two base prices.
  get least() {
    return Math.min(this.#tiers.member.base, this.#tiers.stranger.base);
  }

  /// The effort a request from `sender` owes at `now`, that request counted:
  /// `BASE << min(CAP, max(0, ceil(log2(n / ALLOW))))`. `member` says whether the sender
  /// is a member of the request's pool here.
  required(sender, member, now) {
    const { base, allow, cap } = this.#tiers[member ? 'member' : 'stranger'];
    const times = this.#times(sender, member);
    const n = this.#recent(times, now) + 1;
    if (member && times.length === 0) this.#members.delete(sender);
    let doublings = 0;
    while (doublings < cap && allow * 2 ** doublings < n) doublings += 1;
    return base * 2 ** doublings;
  }

  /// Counts a request toward its sender: a member's toward that member, any other toward
  /// the strangers.
  count(sender, member, now) {
    const { allow, cap } = this.#tiers[member ? 'member' : 'stranger'];
    const times = this.#times(sender, member);
    times.push(now);
    // Past the last doubling one more request changes nothing, so nothing older is kept.
    if (times.length > Math.max(1, allow * 2 ** (cap - 1))) times.shift();
  }
}
