// Whole hosts for the node's tests: a node per name on the in-memory network, each with
// a disk, a requester and an executor that outlive the node, so a host can be killed and
// started again the way a daemon is.

import './fast-env.mjs';
import assert from 'node:assert/strict';
import { b64u, canon } from '../../src/core/canon.js';
import { buildRequest, verifyResponse } from '../../src/core/envelope.js';
import { identityFromSeed } from '../../src/core/identity.js';
import { solve } from '../../src/core/pow.js';
import { memberRecord } from '../../src/core/records.js';
import { createNode } from '../../src/node/node.js';
import { createStore, memoryDisk } from '../../src/node/store.js';
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

/// A world of hosts. `seed` draws every delay, every key and every random byte.
export function createWorld({ seed = 1 } = {}) {
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
    };
    h.node = createNode({
      store: createStore({ disk, log: (line) => h.log.push(line) }),
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
      if (!h.transport.host.dead) say(h);
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
    /// A member with a key and a transport and no node behind it: it joined by
    /// `inviter`'s invite, answers nothing, and does only what a test makes it do.
    async intruder(name, inviter) {
      const s = world.stranger(name);
      const now = net.now();
      const member = memberRecord(s.id, {
        pool: POOL, seq: 0, at: now, joinedAt: now, maxAcceptedH: 12, voucher: inviter.node.invite({ pool: POOL }).invite,
      });
      const answer = await world.request(s, inviter, 'hello', { member }, { effort: 128 });
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
    /// Kills a host's process and starts it again on what its disk holds.
    async restart(h, options) {
      net.kill(h.name);
      boot(h);
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
    /// The records a host's store holds for the pool.
    records: (h) => JSON.parse(h.disk.read([...h.disk.files.keys()].find((name) => name.startsWith('pools/')))).records,
    /// The claim record a host's store holds for a task, or undefined.
    claim: (h, taskId) => world.records(h).find((r) => r.type === 'claim' && r.taskId === taskId),
    /// What a host's store holds under `name`, parsed.
    stored: (h, name) => JSON.parse(h.disk.read(name) ?? 'null'),
  };
  return world;
}
