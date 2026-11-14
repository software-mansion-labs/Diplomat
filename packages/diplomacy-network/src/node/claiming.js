// Claiming (PROTOCOL.md section 7): which task a host with a free slot goes for, and the
// round it drives to get it - the ClaimRound machine says what to send and when a claim
// holds; this file sends it, feeds the answers back and never decides a claim itself.

import { b64u } from '../core/canon.js';
import { ClaimRound, buildClaim, rankDelay } from '../core/claims.js';
import { eligible } from '../core/lease.js';
import {
  ADMIT_TTL_MS, MAX_ROUNDS, PROBE_TIMEOUT_MS, RANK_DELAY_MS, REQUEST_TIMEOUT_MS, RETRY_MS, ROUND_PATIENCE_MS,
} from '../paths.js';
import { claimKey } from './gossip.js';

const ROUND_TICK_MS = 5000;

/// The claiming of `host`.
export function createClaiming(host) {
  const rounds = new Map(); // taskId -> { P, taskId, round, snapshot, started, own, timer }
  const waiting = new Map(); // taskId -> the timer of a rank delay
  const later = new Map(); // taskId -> the time before which a task is left alone
  let admitted = { slots: 0, at: 0, reason: '' };

  const jitter = (ms) => Math.floor((host.random(4).readUInt32BE(0) / 2 ** 32) * ms);
  const sleep = (ms) => new Promise((resolve) => { host.clock.setTimeout(resolve, ms); });

  /// Diplomat's word on how many tasks this machine runs at a time.
  function admit({ slots, reason = '' }) {
    admitted = { slots: Math.max(0, Math.floor(Number(slots)) || 0), at: host.now(), reason: String(reason) };
    host.poke();
    host.touch();
  }

  // The slots Diplomat last stated, for as long as that statement is trusted.
  function slots() {
    return host.now() - admitted.at <= ADMIT_TTL_MS / 1000 ? admitted.slots : 0;
  }

  const taken = () => host.runs.active() + rounds.size + waiting.size;

  /// Starts toward the available tasks this host may take, oldest offer first, while a
  /// slot is free. A task this host offered to be done at once needs no slot.
  function step() {
    if (host.transport.state().state !== 'ready') return;
    const now = host.now();
    for (const [taskId, until] of later) {
      if (until <= now) later.delete(taskId);
    }
    const open = [];
    for (const P of host.pools.values()) {
      const me = P.pool.member(host.self, now);
      if (!me) continue;
      for (const task of P.pool.tasks(now)) {
        if (task.state === 'available') open.push({ P, task, me });
      }
    }
    open.sort((a, b) => a.task.createdAt - b.task.createdAt || (a.task.taskId < b.task.taskId ? -1 : 1));
    for (const { P, task, me } of open) {
      const { taskId } = task;
      if (rounds.size + waiting.size >= MAX_ROUNDS) break;
      if (rounds.has(taskId) || waiting.has(taskId) || host.runs.has(taskId) || later.has(taskId)) continue;
      if (!eligible(me.maxAcceptedH, task.hours) || host.runs.shuns(taskId, task.createdAt)) continue;
      const own = host.offers.atOnce(taskId);
      if (!own && taken() >= slots()) continue;
      if (!wouldTake(P, task)) continue;
      const delay = own ? 0 : rankDelay(taskId, host.self, RANK_DELAY_MS);
      waiting.set(taskId, host.clock.setTimeout(() => begin(P, taskId, own), delay));
    }
  }

  function wouldTake(P, task) {
    try {
      const { taskId, kind, item, title, identity, hours, offeredBy } = task;
      return host.executor.wouldTake({ pool: P.id, taskId, kind, item, title, identity, hours, offeredBy }) === true;
    } catch (err) {
      host.log(`the executor could not say whether it takes ${task.taskId}: ${err?.stack ?? err}`);
      return false;
    }
  }

  function begin(P, taskId, own) {
    waiting.delete(taskId);
    const now = host.now();
    if (host.pools.get(P.id) !== P || (!own && taken() >= slots())) return;
    const round = new ClaimRound({ taskId, self: host.self, round: b64u(host.random(8)), now });
    // The lock this host granted a rival stands: its round is waited out.
    if (!P.locks.hold(taskId, host.self, round.round, round.deadline, now)) {
      later.set(taskId, now + RETRY_MS / 1000);
      return;
    }
    host.saveLocks();
    const run = { P, taskId, round, snapshot: null, started: now, timer: null };
    rounds.set(taskId, run);
    rebase(run);
    const tick = () => {
      if (round.over) return;
      run.timer = host.clock.setTimeout(() => {
        carry(run, round.tick(host.now()));
        tick();
      }, ROUND_TICK_MS);
    };
    tick();
  }

  function rebase(run) {
    if (run.round.over) return;
    const now = host.now();
    run.snapshot = run.P.pool.claimSnapshot(run.taskId, now);
    carry(run, run.round.rebase(run.snapshot, now));
  }

  // One `sync` or `lock` of a round, and what its answer means to the round.
  async function put(run, action) {
    const { P, round } = run;
    for (;;) {
      if (round.over) return;
      const wait = host.peers.patience(action.to);
      const answer = await host.gossip.send(P, action.to, action.do, action.body, {
        fresh: true, timeoutMs: wait === 'short' ? PROBE_TIMEOUT_MS : REQUEST_TIMEOUT_MS,
      });
      if (round.over) return;
      const now = host.now();
      if (answer.lost === undefined) {
        // An answer, even a refusal, is a member that is there: it must agree and grant.
        const heard = action.do === 'sync' ? round.onSync : round.onLock;
        carry(run, heard.call(round, action.to, action.wave, answer.ok ? answer.body : null, now));
        return;
      }
      // A member this host has never reached may only be slow to dial: it is asked again
      // for a while before the round goes on without it.
      const patient = wait === 'patient' && round.wave === action.wave && now * 1000 < run.started * 1000 + ROUND_PATIENCE_MS;
      if (!patient) {
        carry(run, round.noAnswer(action.to, action.wave, now));
        return;
      }
      await sleep(1000 + jitter(2000));
    }
  }

  function carry(run, actions) {
    const { P, round, taskId } = run;
    for (const action of actions) {
      if (action.do === 'sync' || action.do === 'lock') {
        const go = () => put(run, action).catch((err) => host.log(`a claim round failed: ${err?.stack ?? err}`));
        if (action.retry) host.clock.setTimeout(go, 1000 + jitter(2000));
        else go();
      } else if (action.do === 'resync') {
        const { wave } = round;
        host.clock.setTimeout(async () => {
          if (action.with) await host.gossip.syncWith(P, action.with).catch(() => {});
          if (round.wave === wave) rebase(run);
        }, 500 + jitter(1500));
      } else if (action.do === 'unlock') {
        host.gossip.send(P, action.to, 'unlock', action.body, { fresh: true, timeoutMs: PROBE_TIMEOUT_MS }).catch(() => {});
      } else if (action.do === 'commit') {
        commit(run, action);
      } else {
        end(run);
        later.set(taskId, host.now() + (RETRY_MS + jitter(RETRY_MS)) / 1000);
        host.log(`claim of ${taskId} stood down: ${action.reason}`);
        host.poke();
      }
    }
  }

  function end(run) {
    host.clock.clearTimeout(run.timer);
    rounds.delete(run.taskId);
    run.P.locks.release(run.taskId, host.self, run.round.round);
    host.saveLocks();
  }

  function commit(run, { gen, hours, grants, absent }) {
    const { P, taskId, round } = run;
    const claim = buildClaim(host.id, { pool: P.id, taskId, round: round.round, gen, hours, grants, absent, now: host.now() });
    end(run);
    if (host.take(P, claim).refused.length > 0) {
      host.log(`the claim of ${taskId} this host committed does not hold in its own state`);
      return;
    }
    // The run is on record together with the claim it rests on, before anyone hears of either.
    host.runs.adopt(P, claim);
    host.gossip.spread(P, [claimKey(taskId)]);
  }

  /// A pool's state moved: a round that confirmed another state starts over on this one.
  function moved(P) {
    for (const run of [...rounds.values()]) {
      if (run.P === P && run.snapshot && !run.round.over && P.pool.stateHash(run.snapshot.asOf) !== run.snapshot.hash) rebase(run);
    }
  }

  /// Gives up every round in a pool that is being left. Nothing is signed for it.
  function closing(P) {
    for (const run of [...rounds.values()]) {
      if (run.P === P) carry(run, run.round.abort('closed'));
    }
  }

  function stop() {
    for (const timer of waiting.values()) host.clock.clearTimeout(timer);
    for (const run of rounds.values()) host.clock.clearTimeout(run.timer);
    waiting.clear();
  }

  return { admit, admitted: () => ({ ...admitted }), step, moved, closing, stop };
}
