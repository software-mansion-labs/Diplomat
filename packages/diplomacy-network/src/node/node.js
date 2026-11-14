// A host on the network, as one object: the pools it linked, what it offers them, what
// it runs for them. Everything it touches outside itself is handed to it - the store,
// the transport, the clock, the randomness, the requester and the executor - so the same
// host runs over Tor against a forge and a docker engine, or in memory under a test.
//
// One rule holds throughout: whatever the host is about to show the outside - a request,
// an answer, a job started, a forge call - rests only on state the store already holds.

import { b64u } from '../core/canon.js';
import { identityFromSeed } from '../core/identity.js';
import { solveAsync } from '../core/pow.js';
import { validPool } from '../core/records.js';
import { SWITCH_OFF_WAIT_MS, TICK_MS } from '../paths.js';
import { createClaiming } from './claiming.js';
import { claimKey, createGossip } from './gossip.js';
import { createInbound } from './inbound.js';
import { createOffers } from './offers.js';
import { createPeers } from './peers.js';
import { createRuns } from './runs.js';
import { poolFile } from './store.js';

const CHANGE_DELAY_MS = 100;
const OFF = 'the network was switched off';
const CLOSED = 'the pool was closed';

/// The host. `store` is `createStore`'s; `transport` carries requests to and from other
/// hosts; `clock` is `{ now(), setTimeout, clearTimeout }` with `now` in Unix seconds;
/// `random(n)` answers n random bytes; `requester` knows the rules and the forge;
/// `executor` runs jobs; `settings()` answers `{ requiredMinimumH, maximumAcceptedH }`;
/// `solve(challenge, effort)` finds a proof of work, by default on a worker thread.
export function createNode({ store, transport, clock, random, log = () => {}, requester, executor, settings, solve = solveAsync }) {
  let id = identityFromSeed(store.read('identity')?.seed ?? '');
  if (!id) {
    id = identityFromSeed(b64u(random(32)));
    store.write('identity', { seed: id.seed });
    store.flush();
  }
  const keys = { issued: {}, held: {}, ...store.read('keys') };
  const host = {
    id, self: id.pk, store, transport, clock, random, log, requester, executor, settings, solve, keys,
    now: () => clock.now(),
    pools: new Map(), // pool id -> { id, link, pool, locks, seq, inviter, invites, farewell }
    away: new Map(), // pool id -> the link of a pool that is linked and that this host left
    heldLocks: store.read('locks') ?? {},
    saveKeys: () => store.write('keys', keys),
    saveLocks: () => store.write('locks', {
      toJSON: () => Object.fromEntries([...host.pools.values()].map((P) => [P.id, P.locks.entries()])),
    }),
    save: (P) => store.write(poolFile(P.id), {
      toJSON: () => ({
        id: P.id, linked: true, seq: P.seq, inviter: P.inviter, invites: P.invites, left: P.farewell, records: P.pool.records(),
      }),
    }),
  };
  const watchers = [];
  let started = false;
  // Until the pools were named once, in this life of the host or one before it, a pool
  // the store knows and this object does not is a pool not linked yet, not a pool that
  // was closed: nothing is ended over it.
  const links = store.read('links');
  let linked = Array.isArray(links?.pools);
  let [poked, touched, ticking] = [null, null, null];
  host.running = () => started;

  /// Tells the watchers, once for everything that changes in a short while.
  host.touch = () => {
    touched ??= clock.setTimeout(() => {
      touched = null;
      for (const fn of watchers) {
        try {
          fn();
        } catch (err) {
          log(`a change watcher failed: ${err?.stack ?? err}`);
        }
      }
    }, CHANGE_DELAY_MS);
  };

  /// Looks soon at everything the host holds for something that came due.
  host.poke = () => {
    if (started) poked ??= clock.setTimeout(step, 0);
  };

  /// A pool's records changed: the store, the locks and the rounds that rest on them follow.
  host.moved = (P) => {
    P.seq = Math.max(P.seq, P.pool.get(`member/${host.self}`)?.seq ?? -1);
    // A lock was granted for a claim to be made; once the claim is held it has done its work.
    for (const [taskId] of P.locks.entries()) {
      const claim = P.pool.get(claimKey(taskId));
      if (claim) P.locks.release(taskId, claim.executor, claim.round);
    }
    host.save(P);
    host.saveLocks();
    host.claiming.moved(P);
    host.poke();
    host.touch();
  };

  /// Takes records into a pool; answers as `Pool.merge` does.
  host.take = (P, records) => {
    const result = P.pool.merge(records, host.now());
    if (result.fresh.length > 0) host.moved(P);
    return result;
  };

  host.peers = createPeers(host);
  host.gossip = createGossip(host);
  host.offers = createOffers(host);
  host.runs = createRuns(host);
  host.claiming = createClaiming(host);
  const inbound = createInbound(host);
  if (linked) links.pools.forEach(host.gossip.link);

  const handlers = {
    ...host.gossip.handlers, ...host.offers.handlers, ...host.runs.handlers,
    lock(P, from, body) {
      const answer = P.locks.answer({ pool: P.pool, identity: id, from, body, now: host.now() });
      host.saveLocks();
      if (answer.body?.grant) host.offers.granted(body.taskId, body.round);
      return answer;
    },
    unlock(P, from, body) {
      const answer = P.locks.unlock({ from, body });
      host.saveLocks();
      return answer;
    },
  };

  /// What this host answers `from` for a request of `kind` in a pool: `{ body }` or `{ error, detail }`.
  host.handle = async (P, from, kind, body) => handlers[kind](P, from, body);

  function step() {
    poked = null;
    if (!started || !linked) return;
    for (const part of [host.gossip, host.offers, host.runs, host.claiming]) {
      try {
        part.step();
      } catch (err) {
        log(`a step failed: ${err?.stack ?? err}`);
      }
    }
    try {
      store.flush();
    } catch (err) {
      // What could not be written stays to be written: the next step tries again.
      log(`the store could not be written: ${err?.message ?? err}`);
    }
  }

  // Leaves a pool: its runs stop, its claims are given back, its offers are cancelled,
  // and the members are told all of it once. A pool that `stay`s linked is away.
  function close(P, stay) {
    host.claiming.closing(P);
    host.gossip.unlink(P, [...host.runs.closing(P, CLOSED), ...host.offers.closing(P, CLOSED)], stay);
    host.saveLocks();
    host.touch();
  }

  async function stop() {
    if (!started) return;
    started = false;
    for (const timer of [poked, touched, ticking]) clock.clearTimeout(timer);
    [poked, touched, ticking] = [null, null, null];
    host.gossip.stop();
    host.claiming.stop();
    store.flush();
    await transport.stop();
  }

  function poolRow(P, now) {
    return {
      id: P.id, path: P.link.path ?? '', identity: P.link.identity ?? '', hash: P.pool.stateHash(now), left: false,
      members: P.pool.members(now).map((m) => ({
        pk: m.pk, self: m.pk === host.self, maxAcceptedH: m.maxAcceptedH,
        ...(m.pk === host.self ? { lastSeen: now, reachable: transport.state().state === 'ready' } : host.peers.seen(m.pk)),
      })),
      tasks: P.pool.tasks(now).map((t) => ({
        taskId: t.taskId, kind: t.kind, item: t.item, title: t.title, identity: t.identity, hours: t.hours, state: t.state,
        offeredBy: t.offeredBy, offeredHere: t.offeredBy.includes(host.self), executor: t.claim?.executor ?? '',
        executorHere: t.claim?.executor === host.self, claimedAt: t.claim?.claimedAt ?? 0,
        leaseUntil: t.claim?.leaseUntil ?? 0, deadline: t.claim?.deadline ?? 0,
      })),
    };
  }

  return {
    /// This host's public key.
    pk: id.pk,

    /// Begins serving requests and looking after what the host holds. The transport is
    /// started in the background: over Tor that takes minutes, and nothing here waits.
    async start() {
      if (started) return;
      started = true;
      transport.onRequest(inbound.receive);
      transport.limitFor(inbound.limit);
      transport.onState(({ state }) => {
        host.touch();
        if (state === 'ready' && started) {
          host.gossip.syncAll();
          host.poke();
        }
      });
      host.runs.start();
      host.gossip.start();
      const tick = () => {
        ticking = clock.setTimeout(() => {
          step();
          tick();
        }, TICK_MS);
      };
      tick();
      host.poke();
      Promise.resolve().then(() => transport.start()).catch((err) => log(`the transport did not start: ${err?.message ?? err}`));
    },

    /// Stops serving. Runs are left going: the host takes them up when it starts again.
    stop,

    /// The network is switched off: every offer of this host that has not ended is
    /// cancelled, every run is stopped and its claim given back, the members are told,
    /// and the host stops - once they have heard and the jobs are stopped, or after
    /// `waitMs`. It stays a member of its pools.
    async switchOff({ waitMs = SWITCH_OFF_WAIT_MS } = {}) {
      if (!started) return;
      const told = [...host.pools.values()].map((P) => {
        host.claiming.closing(P);
        return host.gossip.tell(P, [...host.runs.closing(P, OFF), ...host.offers.closing(P, OFF)]);
      });
      store.flush();
      let timer = null;
      const waited = new Promise((resolve) => { timer = clock.setTimeout(resolve, waitMs); });
      await Promise.race([Promise.all([...told, host.runs.stopped()]), waited]);
      clock.clearTimeout(timer);
      await stop();
    },

    /// Every pool this machine is linked to, each `{ id, path, forge, identity }`; the
    /// list is kept across a restart. A pool no longer listed is closed: its runs stop,
    /// its offers are cancelled, the members are told, and listed again it is a pool of
    /// this host's own. A pool this host left stays left for as long as it is listed.
    setPools(list) {
      for (const info of list) {
        if (!validPool(info?.id)) throw new Error(`"${info?.id}" is not a pool id.`);
      }
      const listed = (id) => list.some((info) => info.id === id);
      for (const P of [...host.pools.values()]) {
        if (!listed(P.id)) close(P, false);
      }
      for (const id of [...host.away.keys()]) {
        if (!listed(id)) host.gossip.forget(id);
      }
      for (const info of list) {
        const P = host.pools.get(info.id);
        if (P) P.link = info;
        else host.gossip.link(info);
      }
      store.write('links', { pools: list });
      linked = true;
      store.flush();
      host.poke();
      host.touch();
    },

    /// Leaves a pool that stays linked: this host is no member of it, and nothing of the
    /// pool reaches it, until it joins again.
    leave({ pool }) {
      if (host.away.has(pool)) return;
      const P = host.pools.get(pool);
      if (!P) throw host.gossip.noPool(pool);
      close(P, true);
      store.flush();
    },

    admit: host.claiming.admit,

    /// `{ invite }`: a token another host joins the pool by, good for `ttlSecs`.
    invite(args) {
      const out = host.gossip.invite(args);
      store.flush();
      return out;
    },

    actFor: host.runs.actFor,
    ...Object.fromEntries(Object.entries({
      offer: host.offers.offer, withdraw: host.offers.withdraw, join: host.gossip.join, stopRun: host.runs.stopRun,
    }).map(([name, fn]) => [name, async (args) => {
      const result = await fn(args);
      store.flush();
      return result;
    }])),

    /// Everything the applets show, every time in Unix seconds.
    snapshot() {
      const now = host.now();
      return {
        updatedAt: now,
        identity: { pk: id.pk, onion: transport.address },
        transport: transport.state(),
        admit: host.claiming.admitted(),
        pools: [
          ...[...host.pools.values()].map((P) => poolRow(P, now)),
          ...[...host.away.values()].map((info) => ({
            id: info.id, path: info.path ?? '', identity: info.identity ?? '', hash: '', left: true, members: [], tasks: [],
          })),
        ],
        runs: host.runs.rows(),
        offers: host.offers.rows(),
      };
    },

    /// Calls `fn` after the snapshot changed, once for a burst of changes.
    onChange(fn) {
      watchers.push(fn);
    },

    /// `{ requests, signatures }`: the requests received and the signatures checked for them.
    stats: () => ({ ...inbound.tally }),
  };
}
