// Claiming (PROTOCOL.md section 7). ClaimRound decides when a claim holds; this file only
// sends what it says and feeds the answers back.
//
// Whatever goes wrong inside a round ends that round and nothing else: its locks are given
// back and the task is tried again later.

import { b64u } from '../core/canon.js';
import { ClaimRound, buildClaim, rankDelay } from '../core/claims.js';
import { eligible } from '../core/lease.js';
import { backers } from '../core/records.js';
import {
  ADMIT_LAG_SECS, ADMIT_TTL_MS, JOIN_WAIT_MS, MAX_ROUNDS, PROBE_TIMEOUT_MS, RANK_DELAY_MS, REQUEST_TIMEOUT_MS, RETRY_MS, ROUND_PATIENCE_MS,
} from '../paths.js';
import { claimKey } from './gossip.js';

const ROUND_TICK_MS = 5000;
const MAX_WEIGH_MS = 60 * 1000;
const FAILED_RETRY_MS = 10 * RETRY_MS;

export function createClaiming(host) {
  const rounds = new Map(); // taskId -> { P, taskId, round, snapshot, started, offered, waited, own, timer }
  const waiting = new Map(); // taskId -> the timer of the wait before a round
  const later = new Map(); // taskId -> the time before which a task is left alone
  let admitted = { slots: 0, at: 0, reason: '' };

  const jitter = (ms) => Math.floor((host.random(4).readUInt32BE(0) / 2 ** 32) * ms);
  const sleep = (ms) => new Promise((resolve) => { host.clock.setTimeout(resolve, ms); });
  const live = (run) => rounds.get(run.taskId) === run;

  /// Diplomat's count of how many more tasks this machine takes.
  function admit({ slots, reason = '' }) {
    admitted = { slots: Math.max(0, Math.floor(Number(slots)) || 0), at: host.now(), reason: String(reason) };
    host.poke();
    host.touch();
  }

  function slots() {
    return host.now() - admitted.at <= ADMIT_TTL_MS / 1000 ? admitted.slots : 0;
  }

  // Runs begun before Diplomat's count are in it.
  const took = () => host.runs.since(admitted.at - ADMIT_LAG_SECS);
  const taken = () => took() + rounds.size + waiting.size;

  /// Oldest offer first, while a slot is free. A task this host offered to be done at once
  /// needs no slot.
  function step() {
    if (host.transport.state().state !== 'ready') return;
    const now = host.now();
    for (const [taskId, until] of later) {
      if (until <= now) later.delete(taskId);
    }
    const open = [];
    for (const P of host.pools.values()) {
      const me = P.pool.member(host.self, now);
      // Not even the smallest claim fits beside what this host has in the pool.
      if (!me || !P.pool.room({ type: 'claim', taskId: '', executor: host.self })) continue;
      for (const task of P.pool.tasks(now)) {
        // A task's hours are those of the offers this host may take.
        const mine = task.offers.filter((o) => !o.claim && eligible(me.maxAcceptedH, o.hours));
        if (mine.length > 0) open.push({ P, task: { ...task, hours: Math.max(...mine.map((o) => o.hours)) } });
      }
    }
    open.sort((a, b) => a.task.createdAt - b.task.createdAt || (a.task.taskId < b.task.taskId ? -1 : 1));
    for (const { P, task } of open) {
      const { taskId } = task;
      if (rounds.size + waiting.size >= MAX_ROUNDS) break;
      if (rounds.has(taskId) || waiting.has(taskId) || host.runs.has(taskId) || later.has(taskId)) continue;
      if (host.runs.left(taskId, task.createdAt) !== 0) continue;
      const own = host.offers.atOnce(taskId);
      if (!own && taken() >= slots()) continue;
      const verdict = weighed(P, task);
      if (verdict === null) continue;
      // A run that holds another offer of the task takes this one in too: give it time to.
      const delay = (task.state === 'claimed' ? JOIN_WAIT_MS : 0) + (own ? 0 : rankDelay(taskId, host.self, RANK_DELAY_MS) + verdict);
      waiting.set(taskId, host.clock.setTimeout(() => begin(P, taskId, own, delay), delay));
    }
  }

  // null when the executor does not take the task, else how many more ms to wait before
  // going for it. Neither is sent, but a member watching when this host claims can still
  // tell that it waited.
  function weighed(P, task) {
    try {
      const { taskId, kind, item, title, identity, hours, offeredBy } = task;
      const asked = { pool: P.id, taskId, kind, item, title, identity, hours, offeredBy };
      if (host.executor.wouldTake(asked) !== true) return null;
      const wait = Math.floor(Number(host.executor.weigh?.(asked) ?? 0));
      return wait > 0 ? Math.min(MAX_WEIGH_MS, wait) : 0;
    } catch (err) {
      host.log(`the executor could not say whether it takes ${task.taskId}: ${err?.stack ?? err}`);
      return null;
    }
  }

  function begin(P, taskId, own, waited) {
    waiting.delete(taskId);
    const now = host.now();
    if (host.pools.get(P.id) !== P || (!own && taken() >= slots())) return;
    // Another host may have taken the task while this one waited.
    if (!P.pool.claimSnapshot(taskId, now).eligible) return;
    const round = new ClaimRound({ taskId, self: host.self, round: b64u(host.random(8)), now });
    // The lock this host granted a rival stands: its round is waited out.
    if (!P.locks.hold(taskId, host.self, round.round, round.deadline, now)) {
      later.set(taskId, now + RETRY_MS / 1000);
      return;
    }
    host.saveLocks();
    const offered = P.pool.task(taskId, now)?.createdAt ?? now;
    const run = { P, taskId, round, own, snapshot: null, started: now, offered, waited, timer: null };
    rounds.set(taskId, run);
    drive(run, () => rebased(run));
    const tick = () => {
      if (!live(run)) return;
      run.timer = host.clock.setTimeout(() => {
        drive(run, () => round.tick(host.now()));
        tick();
      }, ROUND_TICK_MS);
    };
    tick();
  }

  function rebased(run) {
    const now = host.now();
    run.snapshot = run.P.pool.claimSnapshot(run.taskId, now);
    return run.round.rebase(run.snapshot, now);
  }

  function drive(run, next) {
    try {
      carry(run, next());
    } catch (err) {
      giveUp(run, err);
    }
  }

  // Whatever state the round was left in, every member it may hold a lock of is told to
  // drop it.
  function giveUp(run, err) {
    host.log(`a claim round failed: ${err?.stack ?? err}`);
    if (!live(run)) return;
    end(run);
    later.set(run.taskId, host.now() + FAILED_RETRY_MS / 1000);
    for (const pk of run.snapshot?.members ?? []) unlock(run.P, pk, { taskId: run.taskId, round: run.round.round });
    host.poke();
  }

  async function put(run, action) {
    const { P, round } = run;
    for (;;) {
      if (!live(run)) return;
      const wait = host.peers.patience(action.to);
      const answer = await host.gossip.send(P, action.to, action.do, action.body, {
        fresh: true, timeoutMs: wait === 'short' ? PROBE_TIMEOUT_MS : REQUEST_TIMEOUT_MS,
      });
      if (!live(run)) return;
      const now = host.now();
      const silent = answer.lost !== undefined;
      if (silent && host.transport.state().state !== 'ready') {
        // This host's transport is down: the silence is its own, not the member's.
        carry(run, round.abort('offline'));
        return;
      }
      // Any answer, even a refusal, is a member that is there. One whose clock is too far
      // off can agree to nothing the other would take: it is as good as silent.
      if (!silent && answer.code !== 'stale') {
        const heard = action.do === 'sync' ? round.onSync : round.onLock;
        carry(run, heard.call(round, action.to, action.wave, answer.ok ? answer.body : null, now));
        return;
      }
      // A member never reached may only be slow to dial: ask again for a while.
      const patient = silent && wait === 'patient' && round.wave === action.wave
        && now * 1000 < run.started * 1000 + ROUND_PATIENCE_MS;
      if (!patient) {
        carry(run, round.noAnswer(action.to, action.wave, now));
        return;
      }
      await sleep(1000 + jitter(2000));
    }
  }

  function carry(run, actions) {
    const { P, round } = run;
    for (const action of actions) {
      if (action.do === 'sync' || action.do === 'lock') {
        const go = () => put(run, action).catch((err) => giveUp(run, err));
        if (action.retry) host.clock.setTimeout(go, 1000 + jitter(2000));
        else go();
      } else if (action.do === 'resync') {
        const { wave } = round;
        host.clock.setTimeout(async () => {
          if (action.with) await host.gossip.syncWith(P, action.with).catch(() => {});
          if (live(run) && round.wave === wave) drive(run, () => rebased(run));
        }, 500 + jitter(1500));
      } else if (action.do === 'unlock') {
        unlock(P, action.to, action.body);
      } else if (action.do === 'commit') {
        commit(run, action);
      } else {
        standDown(run, action.reason);
      }
    }
  }

  function unlock(P, to, body) {
    host.gossip.send(P, to, 'unlock', body, { fresh: true, timeoutMs: PROBE_TIMEOUT_MS }).catch(() => {});
  }

  // For the log: seconds and counts, nothing of what any member said.
  function spent(run) {
    const { round, snapshot, started, offered, waited } = run;
    return `begun ${started - offered} s after the offer, after a wait of ${waited} ms, over in ${host.now() - started} s: `
      + `${snapshot?.members.length ?? 0} members asked, ${round.present.length} answered, ${round.absent.length} absent`;
  }

  function standDown(run, reason) {
    end(run);
    later.set(run.taskId, host.now() + (RETRY_MS + jitter(RETRY_MS)) / 1000);
    host.log(`claim of ${run.taskId} stood down: ${reason} - ${spent(run)}`);
    host.poke();
  }

  function end(run) {
    host.clock.clearTimeout(run.timer);
    rounds.delete(run.taskId);
    run.P.locks.release(run.taskId, host.self, run.round.round);
    host.saveLocks();
  }

  function commit(run, { gen, grants, absent, own }) {
    const { P, taskId, round } = run;
    const drop = (reason) => {
      for (const grant of grants) unlock(P, grant.by, { taskId, round: round.round });
      standDown(run, reason);
    };
    // The slot count may have changed, or gone stale, while the round ran.
    if (!run.own && took() >= slots()) return drop('no slot left');
    // This host's own offer, if any, joins the claim on its own word.
    const mine = own ? host.offers.nextGen(taskId, host.self) : null;
    if (mine === null && !grants.some((grant) => grant.offer)) return drop('no host gives it its offer');
    const claim = buildClaim(host.id, {
      pool: P.id, taskId, round: round.round, gen, grants, absent, now: host.now(),
      ...(mine === null ? {} : { offer: { ...own, gen: mine } }),
    });
    if (!P.pool.room(claim)) return drop('this host has as many claims in the pool as a member may');
    end(run);
    if (host.take(P, claim).refused.length > 0) return drop('the claim does not hold in the state of this host');
    host.log(`claim of ${taskId} made - ${spent(run)}, ${backers(claim).length} gave an offer`);
    // The run is on record together with the claim it rests on, before anyone hears of either.
    host.runs.adopt(P, claim);
    host.gossip.spread(P, [claimKey(taskId, host.self)]);
    return undefined;
  }

  /// A pool's state moved: a round that confirmed another state starts over on this one.
  function moved(P) {
    for (const run of [...rounds.values()]) {
      if (run.P === P && run.snapshot && P.pool.stateHash(run.snapshot.asOf) !== run.snapshot.hash) drive(run, () => rebased(run));
    }
  }

  /// Gives up every round in a pool, signing nothing.
  function closing(P) {
    for (const run of [...rounds.values()]) {
      if (run.P === P) drive(run, () => run.round.abort('closed'));
    }
  }

  /// Drops every round silently: the host is stopping.
  function stop() {
    for (const timer of waiting.values()) host.clock.clearTimeout(timer);
    for (const run of rounds.values()) host.clock.clearTimeout(run.timer);
    waiting.clear();
    rounds.clear();
  }

  return { admit, admitted: () => ({ ...admitted }), step, moved, closing, stop };
}
