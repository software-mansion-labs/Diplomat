// Whole hosts for the node's tests: a node per name on the in-memory network, each with
// a disk, a requester and an executor that outlive the node, so a host can be killed and
// started again the way a daemon is.

import './fast-env.mjs';
import assert from 'node:assert/strict';
import { b64u } from '../../src/core/canon.js';
import { identityFromSeed } from '../../src/core/identity.js';
import { solve } from '../../src/core/pow.js';
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
    h.clock = net.clock(h.name);
    h.transport = net.transport(h.name, h.pk);
    h.node = createNode({
      store: createStore({ disk: h.disk, log: (line) => h.log.push(line) }),
      transport: h.transport, clock: h.clock, random: (n) => net.rnd.bytes(n), log: (line) => h.log.push(line),
      requester: h.requester, executor: h.executor, settings: () => h.settings,
      solve: (challenge, effort) => solve(challenge, effort).counter,
    });
    assert.equal(h.node.pk, h.pk);
    return h;
  }

  /// A host, not yet started. `slots` is what it keeps telling its node it may run.
  function add(name, { slots = 0, pools = [LINK] } = {}) {
    const id = identityFromSeed(b64u(net.rnd.bytes(32)));
    const disk = memoryDisk();
    disk.write('identity', JSON.stringify({ seed: id.seed }));
    const h = {
      name, pk: id.pk, id, disk, slots, pools, log: [], requester: fakeRequester(), executor: fakeExecutor(),
      settings: { requiredMinimumH: 12, maximumAcceptedH: 12 },
    };
    hosts.set(name, h);
    return boot(h);
  }

  async function start(h) {
    await h.node.start();
    h.node.setPools(h.pools);
    if (h.slots > 0) h.node.admit({ slots: h.slots, reason: 'test' });
  }

  // Diplomat states its free slots again and again; a node trusts each statement briefly.
  const admitting = net.clock('world');
  const admit = () => {
    for (const h of hosts.values()) {
      if (h.slots > 0 && !h.transport.host.dead) h.node.admit({ slots: h.slots, reason: 'test' });
    }
    admitting.setTimeout(admit, 60000);
  };
  admit();

  const world = {
    net, hosts, POOL,
    add,
    start,
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
    async restart(h) {
      net.kill(h.name);
      boot(h);
      await start(h);
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
    /// What a host's store holds under `name`, parsed.
    stored: (h, name) => JSON.parse(h.disk.read(name) ?? 'null'),
  };
  return world;
}
