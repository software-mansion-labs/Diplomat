// Whole hosts for the node's tests: a node per name on the in-memory network, each with
// a disk, a requester and an executor that outlive the node, so a host can be killed and
// started again the way a daemon is.

import './fast-env.mjs';
import assert from 'node:assert/strict';
import { b64u, canon } from '../../src/core/canon.js';
import { specDigest } from '../../src/core/capability.js';
import { buildRequest, verifyResponse } from '../../src/core/envelope.js';
import { identityFromSeed } from '../../src/core/identity.js';
import { createVoucher } from '../../src/core/membership.js';
import { solve } from '../../src/core/pow.js';
import { LIMITS, memberRecord } from '../../src/core/records.js';
import { createNode } from '../../src/node/node.js';
import { createStore, heardFile, memoryDisk, readPool } from '../../src/node/store.js';
import { fakeExecutor, fakeRequester } from './fakes.mjs';
import { createNet } from './mem-net.mjs';

export const POOL = 'github.com/acme/widgets';
const LINK = { id: POOL, path: '/repos/widgets', forge: 'github', identity: 'Octocat' };

/// Runs one named test and prints how it went, like every other test file here.
export async function check(name, fn) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (err) {
    console.log(`FAIL ${name}`);
    throw err;
  }
}

// A store that checks, after every flush that added a line to a pool's log, that the
// document and its log hold what the host holds.
function audited(store, h) {
  const lined = new Map(); // name -> the value a line was written for
  return {
    ...store,
    write(name, value, given) {
      if (given?.line) lined.set(name, value);
      else lined.delete(name);
      store.write(name, value, given);
    },
    flush() {
      store.flush();
      const sorted = (doc) => ({ ...doc, records: doc.records.map((record) => canon(record)).sort() });
      for (const value of h.transport.host.dead ? [] : lined.values()) {
        const held = JSON.parse(JSON.stringify(value));
        assert.deepEqual(sorted(readPool(createStore({ disk: h.disk }), held.id)), sorted(held), `the store of ${h.name} holds the pool as the host does`);
      }
      lined.clear();
    },
  };
}

/// A world of hosts. `seed` draws every delay, every key and every random byte. With
/// `audit`, every line a host adds to a pool's log is checked against what it holds.
export function createWorld({ seed = 1, audit = false } = {}) {
  const net = createNet({ seed });
  const hosts = new Map();

  function boot(h) {
    // A host's clock runs `h.skew` seconds off the world's.
    const clock = net.clock(h.name);
    h.clock = { ...clock, now: () => clock.now() + h.skew };
    h.transport = net.transport(h.name, h.pk);
    // A process that was killed writes nothing more, whatever it was in the middle of.
    const life = h.transport.host;
    const disk = {
      ...h.disk,
      write(name, text) {
        if (life.dead) return;
        h.disk.write(name, text);
        // `crashAfter` names the document whose write is the last thing the process does.
        if (h.crashAfter === name) {
          h.crashAfter = null;
          net.kill(h.name);
        }
      },
      remove: (name) => life.dead || h.disk.remove(name),
      append: (name, added) => life.dead || h.disk.append(name, added),
      cut: (name) => life.dead || h.disk.cut(name),
    };
    const store = createStore({ disk, log: (line) => h.log.push(line) });
    h.node = createNode({
      store: audit ? audited(store, h) : store,
      transport: h.transport, clock: h.clock, random: (n) => net.rnd.bytes(n), log: (line) => h.log.push(line),
      requester: h.requester, executor: h.executor, settings: () => h.settings,
      // `solved` lists the effort of every proof of work the host paid; a price no test
      // means it to pay is a failure, not minutes of hashing.
      solve(challenge, effort) {
        h.solved.push(effort);
        assert.ok(effort <= 2 ** 18, `${h.name} was made to pay ${effort}`);
        return solve(challenge, effort).counter;
      },
    });
    assert.equal(h.node.pk, h.pk);
    return h;
  }

  /// A host, not yet started. `slots` is what it keeps telling its node it may run;
  /// `disk` is where it keeps its store, in memory unless given.
  function add(name, { slots = 0, pools = [LINK], disk = memoryDisk() } = {}) {
    const id = identityFromSeed(b64u(net.rnd.bytes(32)));
    disk.write('identity', JSON.stringify({ seed: id.seed }));
    const h = {
      name, pk: id.pk, id, disk, slots, pools, skew: 0, log: [], solved: [], crashAfter: null,
      requester: fakeRequester(), executor: fakeExecutor(),
      settings: { requiredMinimumH: 12, maximumAcceptedH: 12 },
    };
    hosts.set(name, h);
    return boot(h);
  }

  // A daemon starts its node first and names the pools once Diplomat has told it which
  // they are, `gapSecs` later - or, with `named` false, not at all.
  async function start(h, { gapSecs = 0, named = true } = {}) {
    await h.node.start();
    if (gapSecs > 0) await net.run(gapSecs * 1000);
    if (named) h.node.setPools(h.pools);
    say(h);
  }

  // Diplomat's part: `h.slots` is how many tasks the machine runs at a time, and what it
  // tells the node is how many more it takes, counted from the node's own snapshot. It
  // says so again and again; a node trusts each statement briefly.
  function say(h) {
    if (h.slots <= 0) return;
    const going = h.node.snapshot().runs.filter((run) => run.endedAt === 0).length;
    h.node.admit({ slots: Math.max(0, h.slots - going), reason: 'test' });
  }
  const admitting = net.clock('world');
  const admit = () => {
    for (const h of hosts.values()) {
      if (!h.transport.host.dead && !h.transport.host.asleep) say(h);
    }
    admitting.setTimeout(admit, 60000);
  };
  admit();

  const solver = (challenge, effort) => solve(challenge, effort).counter;

  const world = {
    net, hosts, POOL,
    add,
    start,
    /// Somebody with a key and a transport and no node behind them.
    stranger(name) {
      const id = identityFromSeed(b64u(net.rnd.bytes(32)));
      const transport = net.transport(name, id.pk);
      transport.host.ready = true;
      return { name, pk: id.pk, id, transport };
    },
    /// `n` members with no node behind them, as `{ all, records }`: they hold the seats
    /// `founder` has after its first `taken`, and then the seats of those, in order.
    crowd(founder, n, taken = 0) {
      const now = net.now();
      const all = Array.from({ length: n }, (_, i) => world.stranger(`crowd${i}`));
      const direct = LIMITS.invitees - taken;
      const records = all.map((m, i) => {
        const by = i < direct ? founder.id : all[Math.floor((i - direct) / LIMITS.invitees)].id;
        const seat = i < direct ? taken + i : (i - direct) % LIMITS.invitees;
        const voucher = createVoucher(by, { pool: POOL, era: 0, pk: m.pk, seat, at: now });
        return memberRecord(m.id, { pool: POOL, seq: 0, at: now, era: 0, maxAcceptedH: 12, voucher });
      });
      return { all, records };
    },
    /// A member with a key and a transport and no node behind it: it joined by
    /// `inviter`'s invite, answers nothing, and does only what a test makes it do.
    async intruder(name, inviter) {
      const s = world.stranger(name);
      // Strangers share one price, which rises with every one of them that says hello.
      const hello = async (body) => {
        const first = await world.request(s, inviter, 'hello', body, { effort: 128 });
        return first.code === 'effort' ? world.request(s, inviter, 'hello', body, { effort: first.effort }) : first;
      };
      const vouched = await hello(inviter.node.invite({ pool: POOL }));
      assert.equal(vouched.ok, true, `the intruder was given a voucher: ${vouched.code} ${vouched.detail}`);
      const { voucher } = vouched.body;
      s.member = memberRecord(s.id, { pool: POOL, seq: 0, at: Math.max(net.now(), voucher.at), era: 0, maxAcceptedH: 12, voucher });
      const answer = await hello({ member: s.member });
      assert.equal(answer.ok, true, `the intruder was let in: ${answer.code} ${answer.detail}`);
      return s;
    },
    /// One request made by hand, as `from`, with every part open to tampering: answers
    /// what `to` said - `{ ok, body }` or `{ ok, code, detail }`, with `effort`, the raw
    /// `response` and the `request` sent - or `{ invalid: true }` for an answer that is
    /// not a signed response to that request. `mangle` rewrites the envelope after it
    /// was signed; `bytes` replaces the body sent altogether, or as a function respells
    /// the bytes that would be sent; `headers` go with it. What is sent is the envelope's
    /// canonical form, or plain JSON when it has none. With `drive` false the network is
    /// left to the caller to run, so several requests can be on their way at once.
    async request(from, to, kind, body, { effort = 8, pool = POOL, ts = net.now(), mangle, bytes, nonce = net.rnd.bytes(16), headers = {}, drive = true } = {}) {
      const request = await buildRequest(from.id, { pool, kind, to: to.pk, ts, body, nonce, effort }, solver);
      const envelope = mangle ? mangle(structuredClone(request)) : request;
      let sent = typeof bytes === 'function' ? undefined : bytes;
      try {
        sent ??= canon(envelope);
      } catch {
        sent = Buffer.from(JSON.stringify(envelope));
      }
      if (typeof bytes === 'function') sent = bytes(sent);
      const going = from.transport.request(to.pk, sent, { headers });
      const raw = await (drive ? world.wait(going) : going);
      const response = JSON.parse(raw.toString('utf8'));
      const answer = verifyResponse(response, { request, from: to.pk });
      return { ...(answer ?? { invalid: true }), response, request, sent };
    },
    /// `names` as started hosts of one pool: the first founds it, the rest join by its invite.
    async pool(names, options = {}) {
      const all = names.map((name) => add(name, options[name] ?? options));
      for (const h of all) await start(h);
      const { invite } = all[0].node.invite({ pool: POOL });
      for (const h of all.slice(1)) await h.node.join({ invite });
      await net.until(() => all.every((h) => world.members(h).length === all.length), { what: 'every host a member' });
      await world.agreed(all);
      return all;
    },
    /// Kills a host's process and starts it again on what its disk holds; its transport
    /// takes `transportMs` to come up.
    async restart(h, { transportMs = 0, ...options } = {}) {
      net.kill(h.name);
      boot(h);
      h.transport.host.startDelayMs = transportMs;
      await start(h, options);
      await net.until(() => h.transport.host.ready, { stepMs: 1, what: 'its transport' });
      return h;
    },
    run: (secs) => net.run(secs * 1000),
    /// Runs the network until a promise that needs it settles, and answers as the promise does.
    async wait(promise) {
      let outcome = null;
      promise.then((value) => { outcome = { value }; }, (error) => { outcome = { error }; });
      await net.until(() => outcome !== null, { what: 'an answer' });
      if (outcome.error) throw outcome.error;
      return outcome.value;
    },
    /// Runs until the hosts hold one state.
    agreed: (all, maxMs = 5 * 60 * 1000) => net.until(() => new Set(all.map((h) => world.view(h).hash)).size === 1, { maxMs, what: 'one state on every host' }),
    view: (h) => h.node.snapshot().pools.find((p) => p.id === POOL),
    members: (h) => world.view(h).members.map((m) => m.pk).sort(),
    task: (h, taskId) => world.view(h).tasks.find((t) => t.taskId === taskId) ?? null,
    offerRow: (h, taskId) => h.node.snapshot().offers.find((o) => o.taskId === taskId) ?? null,
    runOf: (h, taskId) => h.node.snapshot().runs.filter((r) => r.taskId === taskId).at(-1) ?? null,
    name: (pk) => [...hosts.values()].find((h) => h.pk === pk)?.name ?? pk,
    /// The pool's document as a host's store holds it, and the records in it.
    doc: (h) => readPool(createStore({ disk: h.disk }), POOL),
    records: (h) => world.doc(h).records,
    /// What a host's store holds of when it was last heard in the pool: `{ heard, waitedOut }`.
    heard: (h) => createStore({ disk: h.disk }).read(heardFile(POOL)),
    /// The claim record a host's store holds for a task - the one `by` made, when a host
    /// is named - or undefined.
    claim: (h, taskId, by) => world.records(h).find((r) => r.type === 'claim' && r.taskId === taskId && (!by || r.executor === by.pk)),
    /// What names the job an executor was handed for a task, as its `done` request carries it.
    spec: (h, taskId) => specDigest(world.stored(h, 'keys').held[taskId].spec),
    /// What a host's store holds under `name`, parsed.
    stored: (h, name) => JSON.parse(h.disk.read(name) ?? 'null'),
  };
  return world;
}
