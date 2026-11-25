// The proof of work: what a solution is bound to, what solving and checking cost, and
// how the effort a sender owes follows the requests it sends.
// Run: node test/core-pow.mjs

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { POW, POW_HOURLY } from '../src/paths.js';
import { EffortMeter, MAX_EFFORT, challenge, check as solves, epochAcceptable, epochOf, seed, solve, Spending, solveAsync, solverPool, validEffort } from '../src/core/pow.js';

async function check(name, fn) {
  await fn();
  console.log(`PASS ${name}`);
}

const bytes = (n, fill) => Buffer.alloc(n, fill);
const parts = { to: bytes(32, 1), from: bytes(32, 2), epoch: 498333, nonce: bytes(16, 3), effort: 64, coreHash: bytes(32, 4) };

await check('the seed is the hash the protocol writes down, for the target and the epoch', () => {
  const direct = crypto.createHash('sha256')
    .update(Buffer.concat([Buffer.from('dn1/seed\0'), parts.to, Buffer.from('000000000007 9a9d'.replace(' ', ''), 'hex')])).digest();
  assert.deepEqual(seed(parts.to, 498333), direct);
  assert.notDeepEqual(seed(parts.to, 498334), direct);
  assert.notDeepEqual(seed(parts.from, 498333), direct);
  assert.equal(epochOf(1794000000), 498333);
  assert.equal(epochOf(498334 * 3600 - 1), 498333);
});

await check('the challenge changes with the target, the sender, the epoch, the nonce, the effort and the core', () => {
  const direct = crypto.createHash('sha256').update(Buffer.concat([
    Buffer.from('dn1/pow\0'), seed(parts.to, parts.epoch), parts.to, parts.from, parts.nonce, Buffer.from('00000040', 'hex'), parts.coreHash,
  ])).digest();
  assert.deepEqual(challenge(parts), direct);
  const others = {
    to: bytes(32, 9), from: bytes(32, 9), epoch: 498334, nonce: bytes(16, 9), effort: 65, coreHash: bytes(32, 9),
  };
  for (const [k, v] of Object.entries(others)) assert.notDeepEqual(challenge({ ...parts, [k]: v }), direct, k);
});

await check('a solution is the first counter whose hash, times the effort, fits in 32 bits', () => {
  const c = challenge(parts);
  for (const effort of [1, 2, 64, 1000, 4096]) {
    const { counter, next } = solve(c, effort);
    assert.equal(counter.length, 8);
    assert.equal(counter.readBigUInt64BE(), BigInt(next - 1));
    for (let i = 0; i < next; i++) {
      const tried = Buffer.alloc(8);
      tried.writeBigUInt64BE(BigInt(i));
      const r = BigInt(crypto.createHash('blake2b512').update(Buffer.concat([c, tried])).digest().readUInt32BE(0));
      assert.equal(r * BigInt(effort) <= 0xffffffffn, i === next - 1, `effort ${effort} counter ${i}`);
      assert.equal(solves(c, effort, tried), i === next - 1);
    }
  }
});

await check('a solution for one challenge or effort is not one for another', () => {
  const c = challenge(parts);
  const { counter } = solve(c, 4096);
  assert.ok(solves(c, 4096, counter));
  assert.equal(solves(challenge({ ...parts, nonce: bytes(16, 7) }), 4096, counter), false);
  assert.equal(solves(c, 4096 * 4096, counter), false);
  assert.equal(solves(c, 4096, counter.subarray(1)), false);
  assert.equal(solves(c, 4096, counter.toString('base64url')), false);
  for (const bad of [0, -1, 1.5, MAX_EFFORT + 1, NaN, '64', null]) {
    assert.equal(validEffort(bad), false, String(bad));
    assert.equal(solves(c, bad, counter), false, String(bad));
  }
  assert.ok(validEffort(1) && validEffort(MAX_EFFORT));
});

await check('solving in chunks finds the same counter as solving at once', () => {
  const c = challenge({ ...parts, nonce: bytes(16, 5) });
  const whole = solve(c, 5000);
  let from = 0;
  let found = null;
  let chunks = 0;
  while (!found) {
    const step = solve(c, 5000, { from, budget: 100 });
    assert.ok(step.counter || step.next === from + 100);
    ({ counter: found, next: from } = step);
    chunks += 1;
  }
  assert.deepEqual(found, whole.counter);
  assert.equal(from, whole.next);
  assert.equal(chunks, Math.ceil(whole.next / 100));
});

await check('a solution costs about as many hashes as the effort', () => {
  let tried = 0;
  for (let i = 0; i < 400; i++) tried += solve(challenge({ ...parts, epoch: i }), 256).next;
  const mean = tried / 400;
  assert.ok(mean > 256 * 0.8 && mean < 256 * 1.2, `mean ${mean}`);
});

await check('the worker finds a solution while the event loop keeps turning', async () => {
  const c = challenge({ ...parts, nonce: bytes(16, 6) });
  let turns = 0;
  const timer = setInterval(() => { turns += 1; }, 1);
  const counter = await solveAsync(c, 2 ** 19);
  clearInterval(timer);
  assert.ok(solves(c, 2 ** 19, counter));
  assert.deepEqual(counter, solve(c, 2 ** 19).counter);
  assert.ok(turns > 0, 'no timer ran while the worker solved');
});

await check('an aborted search rejects with the reason and leaves no worker behind', async () => {
  const c = challenge(parts);
  const abort = new AbortController();
  const pending = solveAsync(c, MAX_EFFORT, { signal: abort.signal });
  setTimeout(() => abort.abort(new Error('enough')), 20);
  await assert.rejects(pending, /enough/);
  await assert.rejects(solveAsync(c, 1, { signal: abort.signal }), /enough/);
});

await check('a host pays one peer so much in an hour and all of them together so much; past that it pays only a peer it has known for an hour, and that one a little', () => {
  const s = new Spending({ peer: 100, all: 250, floor: 10, floorAfter: 3600 });
  const T = 50000;
  const pay = (pk, effort, at, since = T) => s.pay(pk, since, effort, at);
  assert.deepEqual([pay('a', 60, T), pay('a', 41, T + 1), pay('a', 40, T + 2)], [true, false, true]);
  assert.deepEqual([pay('b', 100, T + 3), pay('c', 51, T + 4), pay('c', 50, T + 4), pay('d', 1, T + 5)], [true, false, true, false]);
  // All of it is spent: a peer known for an hour is paid 10 beyond it, a second less no peer.
  assert.deepEqual([pay('young', 1, T + 6, T - 3593), pay('old', 11, T + 6, T - 3594), pay('old', 10, T + 6, T - 3594), pay('old', 1, T + 7, T - 3594)],
    [false, false, true, false]);
  // What was paid counts for an hour to the second, for the peer as for all.
  assert.deepEqual([pay('a', 1, T + 3599), pay('d', 51, T + 3600), pay('d', 50, T + 3600), pay('a', 1, T + 3600)], [false, false, true, false]);
  assert.deepEqual([pay('a', 41, T + 3602), pay('a', 40, T + 3602)], [false, true]);
});

await check('the search is paid out of the purse of all peers, and of its own share of it; a peer that is no member is paid no floor', () => {
  const s = new Spending({ peer: 100, all: 250, floor: 10, floorAfter: 3600, search: 30 });
  const T = 50000;
  const pay = (pk, effort, at, options) => s.pay(pk, T - 3600, effort, at, options);
  const search = { member: false, search: true };
  assert.deepEqual([pay('k1', 20, T, search), pay('k2', 11, T, search), pay('k2', 10, T, search)], [true, false, true]);
  // The search's 30 count toward all of it: 220 are left.
  assert.deepEqual([pay('a', 100, T), pay('b', 100, T), pay('c', 21, T), pay('c', 20, T)], [true, true, false, true]);
  // All of it is spent: a member known for an hour is paid its floor, a key that is no member nothing.
  assert.deepEqual([pay('x', 5, T + 1, { member: false }), pay('y', 5, T + 1)], [false, true]);
  // The share counts for an hour to the second; with all of it free again, it is what the search may take.
  assert.deepEqual([pay('k3', 1, T + 3599, search), pay('k3', 31, T + 3600, search), pay('k3', 30, T + 3600, search)], [false, false, true]);
});

await check('proofs are worked on by so many threads at a time and no more, the cheapest waiting first; one that fails holds no thread', async () => {
  const going = new Map();
  const order = [];
  let most = 0;
  const run = (c, effort) => new Promise((resolve, reject) => {
    order.push(effort);
    going.set(effort, effort === 13 ? () => reject(new Error('no proof')) : () => resolve(effort));
    most = Math.max(most, going.size);
  });
  const finish = async (effort) => {
    going.get(effort)();
    going.delete(effort);
    await new Promise((resolve) => { setImmediate(resolve); });
  };
  const solve = solverPool(2, run);
  const asked = [50, 13, 40, 9, 30].map((effort) => solve(Buffer.alloc(0), effort).catch((err) => err.message));
  assert.deepEqual([order, most], [[50, 13], 2], 'two begin at once, the others wait');
  await finish(13);
  await finish(50);
  assert.deepEqual(order, [50, 13, 9, 30], 'then the cheapest of those waiting');
  await finish(9);
  await finish(30);
  await finish(40);
  assert.deepEqual([await Promise.all(asked), most], [[50, 'no proof', 40, 9, 30], 2]);
});

await check('a target accepts its own epoch and the ones beside it, and none two away', () => {
  const now = 498333 * 3600 + 1800;
  assert.deepEqual([-2, -1, 0, 1, 2].map((d) => epochAcceptable(498333 + d, now)), [false, true, true, true, false]);
});

const small = { memberBase: 16, memberAllow: 3, memberCap: 4, strangerBase: 256, strangerAllow: 2, strangerCap: 3, windowSecs: 60 };
const formula = (base, allow, cap, n) => base * 2 ** Math.min(cap, Math.max(0, Math.ceil(Math.log2(n / allow))));

await check('a member owes BASE << min(CAP, ceil(log2(n / ALLOW))), its own request counted', () => {
  const meter = new EffortMeter(small);
  const owed = [];
  for (let n = 1; n <= 60; n++) {
    assert.equal(meter.required('alice', true, 100), formula(16, 3, 4, n), `request ${n}`);
    owed.push(meter.required('alice', true, 100));
    meter.count('alice', true, 100);
  }
  assert.deepEqual(owed.slice(0, 7), [16, 16, 16, 32, 32, 32, 64]);
  assert.equal(owed.at(-1), 16 * 2 ** 4);
});

await check('every member has a window of its own', () => {
  const meter = new EffortMeter(small);
  for (let i = 0; i < 20; i++) meter.count('alice', true, 100);
  assert.equal(meter.required('alice', true, 100), formula(16, 3, 4, 21));
  assert.equal(meter.required('bob', true, 100), 16);
});

await check('all strangers share one counter, with a base sixteen times higher', () => {
  const meter = new EffortMeter(small);
  assert.equal(meter.required('eve', false, 100), 256);
  meter.count('eve', false, 100);
  meter.count('mallory', false, 100);
  assert.equal(meter.required('trent', false, 100), formula(256, 2, 3, 3));
  assert.equal(meter.required('eve', false, 100), 512);
  for (let i = 0; i < 100; i++) meter.count(`s${i}`, false, 100);
  assert.equal(meter.required('trent', false, 100), 256 * 2 ** 3);
  assert.equal(meter.required('alice', true, 100), 16);
  assert.equal(POW.strangerBase, POW.memberBase * 16);
});

await check('a request counted toward the strangers counts toward no member', () => {
  const meter = new EffortMeter(small);
  meter.count('eve', false, 100);
  meter.count('mallory', false, 100);
  assert.equal(meter.required('eve', false, 100), 512);
  assert.equal(meter.required('alice', true, 100), 16);
});

await check('a request stops counting sixty seconds after it was accepted', () => {
  const meter = new EffortMeter(small);
  for (let i = 0; i < 6; i++) meter.count('alice', true, 100);
  meter.count('alice', true, 130);
  assert.equal(meter.required('alice', true, 159), formula(16, 3, 4, 8));
  assert.equal(meter.required('alice', true, 160), formula(16, 3, 4, 2));
  assert.equal(meter.required('alice', true, 189), 16);
  assert.equal(meter.required('alice', true, 190), 16);
});

await check('the meter never holds more times than change what a sender owes', () => {
  const meter = new EffortMeter(small);
  for (let i = 0; i < 10000; i++) meter.count('alice', true, 100 + Math.floor(i / 1000));
  // The cap is reached at 3 * 2^3 + 1 requests; the newest of them age out last.
  assert.equal(meter.required('alice', true, 109), 256);
  assert.equal(meter.required('alice', true, 168), 256);
  assert.equal(meter.required('alice', true, 169), 16);
});

await check('the defaults are the protocol table', () => {
  const meter = new EffortMeter();
  assert.equal(meter.required('alice', true, 0), 16384);
  assert.equal(meter.required('eve', false, 0), 262144);
  for (let i = 0; i < 30; i++) meter.count('alice', true, 0);
  assert.equal(meter.required('alice', true, 0), 32768);
  for (let i = 0; i < 100000; i++) meter.count('alice', true, 0);
  assert.equal(meter.required('alice', true, 0), 16384 * 2 ** 12);
  for (let i = 0; i < 2000; i++) meter.count('eve', false, 0);
  assert.equal(meter.required('eve', false, 0), 262144 * 2 ** 8);
  assert.deepEqual(POW_HOURLY, { peer: 268435456, all: 1073741824, floor: 4194304, floorAfter: 3600, search: 134217728 });
});
