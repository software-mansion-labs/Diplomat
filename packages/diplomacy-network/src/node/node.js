// Invariant: whatever the host shows the outside (a request, an answer, a job started, a
// forge call) rests only on state the store already holds.

import { b64u } from '../core/canon.js';
import { identityFromSeed } from '../core/identity.js';
import { solverPool } from '../core/pow.js';
import { validPool } from '../core/records.js';
import { POW_WORKERS, SWITCH_OFF_WAIT_MS, TICK_MS, WAKE_GAP_MS } from '../paths.js';
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

// A timer callback that throws or rejects would end the process; log it instead.
function fenced(clock, log) {
  const failed = (err) => log(`what a timer started failed: ${err?.stack ?? err}`);
  return {
    now: () => clock.now(),
    clearTimeout: (timer) => clock.clearTimeout(timer),
    setTimeout: (fn, ms) => clock.setTimeout(() => {
      try {
        Promise.resolve(fn()).catch(failed);
      } catch (err) {
        failed(err);
      }
    }, ms),
  };
}

/// `clock.now()` is Unix seconds. `requester.conclude(request)` hears of every request it
/// allowed that got no answer from it. `executor.weigh(task)` may add milliseconds this
/// host waits before going for a task. An executor `start` that throws is a failed
/// attempt of the offer, except an error named `OwnFault` (a local fault, no job ran),
/// whose claim is given back at no attempt lost.
export function createNode({
  store, transport, clock: timers, random, log = () => {}, requester, executor, settings, solve = solverPool(POW_WORKERS),
}) {
  const clock = fenced(timers, log);
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
    pools: new Map(), // pool id -> { id, link, pool, locks, seq, joining, invites, farewell, returning, back, former, stale, epoch, catching, head }
    away: new Map(), // pool id -> link of a linked pool this host left
    // pool id -> locks of a pool this host is not in: stored but not linked yet, or left.
    heldLocks: store.read('locks') ?? {},
    saveKeys: () => store.write('keys', keys),
    saveLocks: () => store.write('locks', {
      toJSON: () => ({ ...host.heldLocks, ...Object.fromEntries([...host.pools.values()].map((P) => [P.id, P.locks.entries()])) }),
    }),
    /// False once `P` was left or relinked, so a late answer to it changes nothing.
    open: (P) => host.pools.get(P.id) === P,
    head: (P) => JSON.stringify([P.joining, P.joinFailed, P.invites, P.farewell, P.returning]),
    /// Writes only the changed records, as a log line, while nothing else in the document
    /// changed; otherwise the whole document.
    save: (P) => {
      if (!host.open(P)) return;
      const head = host.head(P);
      const { put, drop } = P.pool.delta();
      const same = head === P.head;
      if (same && put.length + drop.length === 0) return;
      P.head = head;
      store.write(poolFile(P.id), {
        toJSON: () => ({
          id: P.id, linked: true, seq: P.seq, joining: P.joining, joinFailed: P.joinFailed, invites: P.invites,
          returning: P.returning, ...P.farewell,
          records: P.pool.records(),
        }),
      }, { line: same ? { seq: P.seq, put, drop } : undefined });
    },
  };
  const watchers = [];
  let started = false;
  // Until setPools has run once (in any life of the host), a stored pool not listed is
  // not linked yet rather than closed: nothing is ended over it.
  const links = store.read('links');
  let linked = Array.isArray(links?.pools);
  let [poked, touched, ticking] = [null, null, null];
  let looked = clock.now();
  host.running = () => started;

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

  host.poke = () => {
    if (started) poked ??= clock.setTimeout(step, 0);
  };

  host.moved = (P) => {
    P.seq = Math.max(P.seq, P.pool.get(`member/${host.self}`)?.seq ?? -1);
    // A lock exists so a claim carries its grant; once the held claim does, release it.
    let released = false;
    for (const [taskId, lock] of P.locks.entries()) {
      const claim = P.pool.get(claimKey(taskId, lock.executor));
      if (claim?.round === lock.round && claim.grants.some((grant) => grant.by === host.self)) {
        released = P.locks.release(taskId, lock.executor, lock.round) || released;
      }
    }
    host.save(P);
    if (released) host.saveLocks();
    host.claiming.moved(P);
    host.poke();
    host.touch();
  };

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
    ...host.gossip.handlers, ...host.offers.handlers, ...host.runs.handlers, ...inbound.handlers,
    lock(P, from, body) {
      const answer = P.locks.answer({
        pool: P.pool, identity: id, from, body, now: host.now(), nextGen: () => host.offers.nextGen(body.taskId, from),
      });
      host.saveLocks();
      return answer;
    },
    unlock(P, from, body) {
      const answer = P.locks.unlock({ from, body });
      host.saveLocks();
      return answer;
    },
  };

  /// Detects a machine that slept (a clock jump between looks), after which its pool state
  /// is stale. Call it before anything that must not act on old state ahead of a step.
  host.look = () => {
    const now = host.now();
    if (now - looked > WAKE_GAP_MS / 1000) host.gossip.woke();
    looked = now;
  };

  /// Answers `{ body }` or `{ error, detail }`.
  host.handle = async (P, from, kind, body) => handlers[kind](P, from, body);

  function step() {
    poked = null;
    if (!started || !linked) return;
    host.look();
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
      // Unwritten documents stay dirty; the next step retries.
      log(`the store could not be written: ${err?.message ?? err}`);
    }
  }

  // Ends this host's runs, claims and offers in a pool and tells the members once; with
  // `stay` the pool stays linked, as away.
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
    const members = P.pool.members(now);
    const skewed = (pk) => host.peers.seen(pk).skew;
    // 'clock' when this host's clock is skewed from every host a claim needs: the
    // offerers, or every other member when this host offers it.
    const blocked = (t) => {
      const needed = t.offeredBy.includes(host.self) ? members.map((m) => m.pk).filter((pk) => pk !== host.self) : t.offeredBy;
      return t.state === 'available' && needed.length > 0 && needed.every(skewed) ? 'clock' : '';
    };
    return {
      id: P.id, path: P.link.path ?? '', identity: P.link.identity ?? '', hash: P.pool.stateHash(now), left: false,
      joining: P.joining !== null, joinFailed: P.joinFailed, unseated: host.gossip.unseated(P), returning: host.gossip.returning(P),
      members: members.map((m) => ({
        pk: m.pk, self: m.pk === host.self, maxAcceptedH: m.maxAcceptedH,
        ...(m.pk === host.self
          ? { lastSeen: now, reachable: transport.state().state === 'ready', skew: false } : host.peers.seen(m.pk)),
      })),
      tasks: P.pool.tasks(now).map((t) => {
        // Of several claims, show this host's own, else the one holding this host's offer,
        // else the one holding the most offers.
        const claim = t.offers.find((o) => o.claim?.executor === host.self)?.claim
          ?? t.offers.find((o) => o.host === host.self)?.claim ?? t.claim;
        return {
          taskId: t.taskId, kind: t.kind, item: t.item, title: t.title, identity: t.identity, hours: t.hours, state: t.state,
          blocked: blocked(t), offeredBy: t.offeredBy, offeredHere: t.offeredBy.includes(host.self),
          executor: claim?.executor ?? '', executorHere: claim?.executor === host.self, claimedAt: claim?.claimedAt ?? 0,
          leaseUntil: claim?.leaseUntil ?? 0, deadline: claim?.deadline ?? 0,
        };
      }),
    };
  }

  return {
    pk: id.pk,

    /// Not awaited: the transport starts in the background (over Tor it takes minutes).
    async start() {
      if (started) return;
      started = true;
      transport.onRequest(inbound.receive);
      transport.limitFor(inbound.limit);
      transport.onState(({ state }) => {
        try {
          host.touch();
          if (state === 'ready' && started) {
            host.gossip.woke();
            host.poke();
          }
        } catch (err) {
          log(`a change of the transport's state could not be taken up: ${err?.stack ?? err}`);
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

    /// Runs keep going; the host takes them up when it starts again.
    stop,

    /// Cancels open offers, stops every run and gives back its claim, tells the members,
    /// then stops once they heard and the jobs stopped, or after `waitMs`. Membership stays.
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

    /// `list` of `{ id, path, forge, identity }`, persisted. A pool dropped from it is
    /// closed; listed again it is this host's own. A left pool stays left while listed.
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
      const unlinked = Object.keys(host.heldLocks).filter((id) => !listed(id));
      for (const id of unlinked) delete host.heldLocks[id];
      if (unlinked.length > 0) host.saveLocks();
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

    /// The pool stays linked, but nothing of it reaches this host until it joins again.
    leave({ pool }) {
      if (host.away.has(pool)) return;
      const P = host.pools.get(pool);
      if (!P) throw host.gossip.noPool(pool);
      close(P, true);
      store.flush();
    },

    admit: host.claiming.admit,

    /// `{ invite }`: a join token valid for `ttlSecs`.
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

    /// Everything the applets show; times in Unix seconds.
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
            id: info.id, path: info.path ?? '', identity: info.identity ?? '', hash: '', left: true, joining: false, joinFailed: '', unseated: false, returning: false,
            members: [], tasks: [],
          })),
        ],
        runs: host.runs.rows(),
        offers: host.offers.rows(),
      };
    },

    /// Once per burst of snapshot changes.
    onChange(fn) {
      watchers.push(fn);
    },

    /// `{ requests, signatures }`: requests received and signatures checked.
    stats: () => ({ ...inbound.tally }),
  };
}
