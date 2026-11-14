// The executor's side of a task: a run from the moment its claim is committed - the key
// asked of the requester, the job handed to the executor, every forge request it makes
// under the key, the lease extended while it lives - to the moment the claim is given
// back, whichever way the run ended.

import { unb64u } from '../core/canon.js';
import { actMac, validForgeRequest, verifyCapability, wireOutcome } from '../core/capability.js';
import { keyHost } from '../core/claims.js';
import { endClaim, extendClaim, isActive, verifyPing } from '../core/lease.js';
import { isBytes, isObject, pingShaped, shaped } from '../core/records.js';
import {
  ACT_BYTES_PER_SEC, ACT_TIMEOUT_MS, CLOCK_SKEW_SECS, MAX_ACT_BODY_BYTES, RECORD_RETENTION_SECS, RETRY_MS,
} from '../paths.js';
import { claimKey } from './gossip.js';
import { forgeAnswer } from './offers.js';

const ACT_ATTEMPTS = 3;
const ANSWER = {
  status: Number.isSafeInteger,
  headers: (h) => isObject(h) && Object.values(h).every((v) => typeof v === 'string'),
  body: (v) => typeof v === 'string',
};

/// The runs of `host` and the keys it holds for them.
export function createRuns(host) {
  const doc = host.store.read('runs') ?? {};
  const runs = isObject(doc.runs) ? doc.runs : {}; // runId -> the run
  const shun = isObject(doc.shun) ? doc.shun : {}; // taskId -> the createdAt of the offer this host gave up on
  const held = host.keys.held; // taskId -> { runId, capability, secret, spec, host, seq }
  const preparing = new Set(); // runIds whose key is being asked for
  const wrapping = new Set(); // runIds whose end is being reported
  const turns = new Map(); // runId -> the last forge request of that run

  const save = () => host.store.write('runs', { runs, shun });
  const stopping = new Set(); // the stops asked of the executor and not answered yet
  const sleep = (ms) => new Promise((resolve) => { host.clock.setTimeout(resolve, ms); });
  const live = (run) => run.endedAt === 0;

  // The claim a run rests on, while it is this host's and that round's.
  function claimOf(run) {
    const claim = host.pools.get(run.pool)?.pool.get(claimKey(run.taskId));
    return claim && claim.executor === host.self && claim.round === run.round ? claim : null;
  }

  // The executor's word on a job: true, false, or null when it cannot say.
  function alive(run) {
    try {
      const says = host.executor.alive(run.runId);
      return typeof says === 'boolean' ? says : null;
    } catch (err) {
      host.log(`the executor could not say whether ${run.runId} is alive: ${err?.stack ?? err}`);
      return null;
    }
  }

  /// A claim of this host was committed: the run it is for, on record from this moment.
  function adopt(P, claim) {
    const runId = `run-${host.random(6).toString('hex')}`;
    runs[runId] = {
      runId, taskId: claim.taskId, pool: P.id, round: claim.round, peer: '', container: '', state: 'preparing',
      startedAt: host.now(), endedAt: 0, exit: 0, log: '', outcome: null, end: null, told: 0, revoked: false,
      launched: false, offered: P.pool.task(claim.taskId, host.now())?.createdAt ?? 0,
    };
    save();
    host.touch();
    prepare(runs[runId]).catch((err) => host.log(`a run could not be prepared: ${err?.stack ?? err}`));
  }

  // Asks the host that answers for the claim for its key, until it gives one or the
  // lease is about to run out, then starts the job.
  async function prepare(run) {
    if (preparing.has(run.runId)) return;
    preparing.add(run.runId);
    try {
      while (run.state === 'preparing' && live(run) && host.running()) {
        const P = host.pools.get(run.pool);
        const claim = claimOf(run);
        const task = P?.pool.task(run.taskId, host.now());
        if (!claim || !isActive(claim, host.now()) || !task) return;
        if (held[run.taskId]?.runId === run.runId) {
          if (!run.launched) {
            await launch(run, P, task);
            return;
          }
          // The host went down around the moment its job was started. A job is never
          // started twice: one that lives is taken up, one that is gone has failed, and
          // while the executor cannot say, the question is put again at the next step.
          const says = alive(run);
          if (says === true) Object.assign(run, { state: 'running' });
          if (says === false) conclude(run, { ok: false, summary: 'the run ended without saying how' });
          save();
          return;
        }
        const to = keyHost(claim, task.offeredBy);
        if (to === null) {
          halt(run, 'no machine that agreed to the claim offers the task', 'release');
          return;
        }
        const answer = await host.gossip.send(P, to, 'key', { taskId: run.taskId, round: run.round }, { fresh: true });
        if (run.state !== 'preparing' || !live(run)) return;
        const body = answer.ok ? answer.body : {};
        const expect = { pool: P.id, taskId: run.taskId, executor: host.self, host: to };
        if (verifyCapability(body.capability, expect, host.now()).ok && isBytes(body.secret, 32) && isObject(body.spec)) {
          held[run.taskId] = { runId: run.runId, capability: body.capability, secret: body.secret, spec: body.spec, host: to, seq: -1 };
          run.peer = to;
          host.saveKeys();
          save();
        } else if (host.now() + RETRY_MS / 1000 >= claim.leaseUntil) {
          halt(run, 'the requester gave no key before the lease ran out', 'release');
          return;
        } else {
          await sleep(RETRY_MS);
        }
      }
    } finally {
      preparing.delete(run.runId);
    }
  }

  async function launch(run, P, task) {
    const { taskId, kind, item, title, identity, hours, offeredBy } = task;
    // The run, its key, and the fact that its job is being started are on disk before a
    // job exists.
    run.launched = true;
    save();
    host.store.flush();
    let handle;
    try {
      handle = await host.executor.start({
        runId: run.runId, pool: P.link, peer: run.peer, spec: held[run.taskId].spec, act: actFor(run.runId),
        task: { taskId, kind, item, title, identity, hours, offeredBy },
      });
    } catch (err) {
      conclude(run, { ok: false, summary: `the run could not be started: ${err?.message ?? err}` });
      return;
    }
    if (!live(run)) {
      // Halted while the job was starting: the job is told so.
      stopJob(run, 'stopped while starting');
      return;
    }
    Object.assign(run, { state: 'running', container: String(handle?.container ?? ''), log: String(handle?.log ?? '') });
    save();
    host.store.flush();
    host.touch();
  }

  function stopJob(run, reason) {
    const stop = Promise.resolve().then(() => host.executor.stop(run.runId, reason))
      .catch((err) => host.log(`${run.runId} could not be stopped: ${err?.stack ?? err}`));
    stopping.add(stop);
    stop.then(() => stopping.delete(stop));
  }

  // The job ended by itself: `outcome` is the executor's word on how.
  function conclude(run, outcome) {
    if (!run || !live(run)) return;
    const ok = outcome?.ok === true;
    Object.assign(run, {
      state: ['finished', 'failed', 'stopped'].includes(outcome?.state) ? outcome.state : ok ? 'finished' : 'failed',
      endedAt: host.now(), exit: Number.isSafeInteger(outcome?.exit) ? outcome.exit : 0, outcome: wireOutcome(outcome), end: 'report',
    });
    if (!ok) giveUpOn(run);
    save();
    host.touch();
    host.poke();
  }

  // Ends a run from this side. `end` says what is owed for its claim: `report` (tell the
  // offering hosts, then give the claim back), `release` (give it back) or `drop` (the
  // claim is not this run's to end).
  function halt(run, reason, end, failed = end !== 'drop') {
    if (!live(run)) return;
    const started = run.state === 'running' || held[run.taskId]?.runId === run.runId;
    Object.assign(run, { state: 'stopped', endedAt: host.now(), outcome: wireOutcome({ ok: false, summary: reason }), end });
    if (failed) giveUpOn(run);
    save();
    host.store.flush();
    if (started) stopJob(run, reason);
    host.touch();
    host.poke();
  }

  // A task this host failed at or gave back is left to the others for as long as the
  // offer its claim took stands.
  function giveUpOn(run) {
    shun[run.taskId] = run.offered;
  }

  // Settles what an ended run owes: its outcome told to a host offering the task, its
  // claim ended, its key forgotten.
  async function wrapUp(run) {
    if (wrapping.has(run.runId)) return;
    wrapping.add(run.runId);
    try {
      const P = host.pools.get(run.pool);
      let claim = claimOf(run);
      const mine = () => claim && claim.state === 'held' && isActive(claim, host.now());
      if (mine() && run.end === 'report') {
        const offering = P.pool.task(run.taskId, host.now())?.offeredBy ?? [];
        if (offering.length > 0) {
          if (run.told + RETRY_MS / 1000 > host.now()) return;
          run.told = host.now();
          const body = { taskId: run.taskId, round: run.round, outcome: run.outcome };
          const answers = await Promise.all(offering.map((pk) => host.gossip.send(P, pk, 'done', body)));
          // Nobody heard: it is said again later, for as long as the claim lasts.
          if (!answers.some((answer) => answer.ok)) return;
          claim = claimOf(run);
        }
      }
      if (mine() && run.end !== 'drop') {
        const state = run.end === 'report' && run.outcome.ok ? 'completed' : 'released';
        host.take(P, endClaim(host.id, claim, state, host.now()));
        host.gossip.spread(P, [claimKey(run.taskId)]);
      }
      if (held[run.taskId]?.runId === run.runId) {
        delete held[run.taskId];
        host.saveKeys();
      }
      run.end = 'over';
      save();
      host.touch();
    } finally {
      wrapping.delete(run.runId);
    }
  }

  // What a live run is worth right now: it goes on only while its claim holds its task.
  function check(run) {
    const now = host.now();
    const P = host.pools.get(run.pool);
    const claim = P?.pool.get(claimKey(run.taskId));
    if (!claim || claim.executor !== host.self || claim.round !== run.round) return halt(run, 'another claim of the task stands', 'drop');
    if (claim.state !== 'held' || !isActive(claim, now)) return halt(run, 'the lease ran out', 'drop', true);
    if (now >= claim.deadline) return halt(run, 'not finished by its deadline', 'report');
    if (P.pool.task(run.taskId, now)?.state !== 'claimed') return halt(run, 'the task was withdrawn', 'release');
    if (run.revoked) return halt(run, 'the requester took its key back', 'release');
    if (run.state === 'running' && alive(run) === false) return conclude(run, { ok: false, summary: 'the run ended without saying how' });
    if (run.state === 'preparing') prepare(run).catch((err) => host.log(`a run could not be prepared: ${err?.stack ?? err}`));
    return undefined;
  }

  /// What came due for every run: one whose claim no longer holds is stopped, one that
  /// ended is reported and its claim ended, and a claim of this host with no run behind
  /// it is given back.
  function step() {
    const now = host.now();
    for (const run of Object.values(runs)) {
      if (live(run)) check(run);
      if (!live(run) && run.end !== 'over') wrapUp(run).catch((err) => host.log(`a run could not be wrapped up: ${err?.stack ?? err}`));
      if (run.end === 'over' && now >= run.endedAt + RECORD_RETENTION_SECS) {
        delete runs[run.runId];
        save();
      }
    }
    for (const P of host.pools.values()) {
      for (const task of P.pool.tasks(now)) {
        const { claim } = task;
        const behind = (run) => run.taskId === task.taskId && run.round === claim.round && run.end !== 'over';
        if (claim?.executor !== host.self || Object.values(runs).some(behind)) continue;
        host.take(P, endClaim(host.id, claim, 'released', now));
        host.gossip.spread(P, [claimKey(task.taskId)]);
      }
    }
    for (const taskId of Object.keys(shun)) {
      if (![...host.pools.values()].some((P) => P.pool.task(taskId, now))) {
        delete shun[taskId];
        save();
      }
    }
  }

  // One forge request of a run, carried out by the requester. Every attempt takes a
  // number that is on disk before it is sent, so no number is ever used twice.
  async function request(run, forgeRequest) {
    const K = held[run.taskId];
    const P = host.pools.get(run.pool);
    if (!live(run) || K?.runId !== run.runId || !P) return forgeAnswer(403, 'this run holds no key');
    if (!validForgeRequest(forgeRequest)) return forgeAnswer(400, 'not a forge request');
    const again = forgeRequest.method === 'GET' || forgeRequest.method === 'HEAD';
    const timeoutMs = ACT_TIMEOUT_MS + Math.ceil(forgeRequest.body.length / ACT_BYTES_PER_SEC) * 1000;
    for (let attempt = 1; ; attempt += 1) {
      K.seq += 1;
      host.saveKeys();
      const { keyId } = K.capability;
      const body = {
        taskId: run.taskId, keyId, seq: K.seq, request: forgeRequest,
        mac: actMac(unb64u(K.secret), { keyId, seq: K.seq, request: forgeRequest }),
      };
      const answer = await host.gossip.send(P, K.host, 'act', body, { fresh: true, timeoutMs, maxResponseBytes: MAX_ACT_BODY_BYTES });
      if (answer.ok) return shaped(answer.body, ANSWER) ? answer.body : forgeAnswer(502, 'the requester answered with something that is no response');
      if (answer.code === 'denied') {
        // Anything but a number that came too late means the key is dead.
        if (answer.detail !== 'seq is not new') {
          run.revoked = true;
          host.poke();
        }
        return forgeAnswer(403, answer.detail);
      }
      if (answer.code === 'bad-request') return forgeAnswer(400, answer.detail);
      // Never sent, or refused for want of work before anything was done: it was not
      // carried out, whatever it was. A body refused unread is no such proof: it may be
      // the second copy of one the transport sent twice.
      const unsent = answer.lost === 'offline' || answer.code === 'effort';
      if (attempt === ACT_ATTEMPTS || !live(run)) return forgeAnswer(unsent ? 503 : 504, 'no answer from the requester');
      // An answer that was lost may belong to a request that was carried out: only one
      // that changes nothing is asked again.
      if (!unsent && !again) return forgeAnswer(504, 'no answer from the requester: the request may have been carried out');
      await sleep(2000 * attempt);
    }
  }

  /// The function a run's job makes its forge requests through: `act(request)` resolves
  /// to `{ status, headers, body }`, whatever happens, one request at a time.
  function actFor(runId) {
    return (forgeRequest) => {
      const run = Object.hasOwn(runs, runId) ? runs[runId] : null;
      if (!run) return Promise.resolve(forgeAnswer(403, 'no such run'));
      const turn = (turns.get(runId) ?? Promise.resolve()).then(() => request(run, forgeRequest))
        .catch((err) => forgeAnswer(502, `the request could not be made: ${err?.message ?? err}`));
      turns.set(runId, turn);
      turn.then(() => turns.get(runId) === turn && turns.delete(runId));
      return turn;
    };
  }

  /// Stops one run and gives its claim back.
  function stopRun({ runId }) {
    const run = Object.hasOwn(runs, runId) ? runs[runId] : null;
    if (!run || !live(run)) throw new Error('No such run is going on this machine.');
    halt(run, 'stopped by the operator', 'release');
  }

  /// Stops every run in a pool, for `reason`, and gives its claims back at once; the keys
  /// of the records signed. The tasks are not held against this host: it may take them
  /// again.
  function closing(P, reason) {
    const keys = [];
    for (const run of Object.values(runs)) {
      if (run.pool !== P.id || run.end === 'over') continue;
      halt(run, reason, 'release', false);
      const claim = claimOf(run);
      if (claim?.state === 'held' && isActive(claim, host.now())) {
        host.take(P, endClaim(host.id, claim, 'released', host.now()));
        keys.push(claimKey(run.taskId));
      }
      delete held[run.taskId];
      run.end = 'over';
    }
    host.saveKeys();
    save();
    return keys;
  }

  const handlers = {
    ping(P, from, body) {
      if (!shaped(body, { ping: pingShaped })) return { error: 'bad-request' };
      const { ping } = body;
      const now = host.now();
      const claim = P.pool.get(claimKey(ping.taskId));
      const deny = (detail) => ({ error: 'denied', detail });
      if (!claim || claim.executor !== host.self || ping.by !== from) return deny('not a ping for a claim of this host');
      const verdict = verifyPing(ping, claim, P.pool.task(claim.taskId, now)?.offeredBy ?? []);
      if (!verdict.ok) return verdict.code === 'old' ? { body: { claim } } : deny(verdict.code);
      if (Math.abs(ping.ts - now) > CLOCK_SKEW_SECS) return deny('stale');
      if (!isActive(claim, now)) return deny('lapsed');
      // A lease is extended for a job that is going, never for a claim alone: a run still
      // waiting for its key gives its claim back when its first lease is about to end.
      const run = Object.values(runs).find((r) => r.taskId === claim.taskId && r.round === claim.round);
      if (!run || !live(run) || !run.launched || (run.state === 'running' && alive(run) === false)) return deny('no run');
      const next = extendClaim(host.id, claim, ping, now);
      if (host.take(P, next).refused.length > 0) return deny('the extension does not hold');
      host.gossip.spread(P, [claimKey(claim.taskId)], from);
      return { body: { claim: next } };
    },
  };

  /// Takes up the runs the store holds: the executor reports how a job ended from here on.
  function start() {
    host.executor.onEnd((runId, outcome) => conclude(runs[runId], outcome));
    for (const taskId of Object.keys(held)) {
      if (!Object.values(runs).some((run) => run.runId === held[taskId].runId && run.end !== 'over')) delete held[taskId];
    }
    host.saveKeys();
  }

  return {
    adopt, step, start, stopRun, closing, actFor, handlers,
    /// Settles once the executor has answered every stop asked of it.
    stopped: () => Promise.all([...stopping]),
    /// How many runs that began at `at` or later are still going.
    since: (at) => Object.values(runs).filter((run) => live(run) && run.startedAt >= at).length,
    /// Is a run of that task going or still owed its report?
    has: (taskId) => Object.values(runs).some((run) => run.taskId === taskId && run.end !== 'over'),
    /// Did this host give up on that offer of the task?
    shuns: (taskId, createdAt) => shun[taskId] === createdAt,
    /// The runs as the snapshot lists them.
    rows: () => Object.values(runs).map(({ runId, taskId, pool, peer, container, state, startedAt, endedAt, exit, log }) => (
      { runId, taskId, pool, peer, container, state, startedAt, endedAt, exit, log })),
  };
}
