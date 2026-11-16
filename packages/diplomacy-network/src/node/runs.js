// The executor's side of a task: a run from the moment its claim is committed - the key
// asked of the requester, the job handed to the executor, every forge request it makes
// under the key, the lease extended while it lives - to the moment the claim is given
// back, whichever way the run ended.

import { unb64u } from '../core/canon.js';
import { UNSERVED } from '../core/envelope.js';
import { actMac, specDigest, validForgeRequest, verifyCapability, wireOutcome } from '../core/capability.js';
import { joinClaim, verifyGrant } from '../core/claims.js';
import { eligible, endClaim, extendClaim, heldUntil, isActive, verifyPing } from '../core/lease.js';
import { backing, isBytes, isObject, pingShaped, shaped } from '../core/records.js';
import {
  ACT_BYTES_PER_SEC, ACT_TIMEOUT_MS, CLOCK_SKEW_SECS, GIVE_UP_WAIT_MAX_MS, GIVE_UP_WAIT_MS, MAX_ACT_BODY_BYTES, PROBE_TIMEOUT_MS,
  RECORD_RETENTION_SECS, RETRY_MS,
} from '../paths.js';
import { claimKey } from './gossip.js';
import { forgeAnswer, plain } from './offers.js';

const ACT_ATTEMPTS = 3;
// How long a run waits before it asks for its key again, the first times it got none.
const KEY_RETRY_MS = [1000, 2000, 4000];
const SEEK_ATTEMPTS = 3;
const ANSWER = {
  status: Number.isSafeInteger,
  headers: (h) => isObject(h) && Object.values(h).every((v) => typeof v === 'string'),
  body: (v) => typeof v === 'string',
};

// A run's outcome as it is kept and told: an agent's last words, free of anything that
// moves a cursor.
const worded = (outcome) => wireOutcome({
  ...outcome, summary: plain(outcome?.summary), runner: plain(outcome?.runner), model: plain(outcome?.model),
});

/// The runs of `host` and the keys it holds for them.
export function createRuns(host) {
  const doc = host.store.read('runs') ?? {};
  const runs = isObject(doc.runs) ? doc.runs : {}; // runId -> the run
  // taskId -> { offered, count, until }: the offer of it, by its createdAt, this host gave
  // up on, how many times, and until when it leaves the task alone - null for as long as
  // that offer stands
  const shun = isObject(doc.shun) ? doc.shun : {};
  const held = host.keys.held; // taskId -> { runId, capability, secret, spec, host, seq }
  const preparing = new Set(); // runIds whose key is being asked for
  const wrapping = new Set(); // runIds whose end is being reported
  const turns = new Map(); // runId -> the last forge request of that run

  const save = () => host.store.write('runs', { runs, shun });
  const stopping = new Set(); // the stops asked of the executor and not answered yet
  const sleep = (ms) => new Promise((resolve) => { host.clock.setTimeout(resolve, ms); });
  const live = (run) => run.endedAt === 0;

  // The claim a run rests on, while it is that round's.
  function claimOf(run) {
    const claim = host.pools.get(run.pool)?.pool.get(claimKey(run.taskId, host.self));
    return claim?.round === run.round ? claim : null;
  }

  // The hosts whose offer of its task a run's claim holds right now, by key.
  function holds(run) {
    const task = host.pools.get(run.pool)?.pool.task(run.taskId, host.now());
    return (task?.offers ?? []).filter((o) => o.claim?.executor === host.self && o.claim.round === run.round).map((o) => o.host);
  }

  // The order a run asks those hosts for its key in: this host first, when the task is
  // its own too, and the others from a place the run drew for itself - a host that offers
  // a task cannot arrange to be the one every executor takes its job from.
  function keyHosts(run) {
    const hosts = holds(run).filter((pk) => pk !== host.self);
    const from = hosts.length > 0 ? run.pick % hosts.length : 0;
    return [...(holds(run).includes(host.self) ? [host.self] : []), ...hosts.slice(from), ...hosts.slice(0, from)];
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
      launched: false, offered: P.pool.task(claim.taskId, host.now())?.createdAt ?? 0, sought: 0,
      pick: host.random(4).readUInt32BE(0), spec: '', heard: [],
    };
    save();
    host.touch();
    prepare(runs[runId]).catch((err) => host.log(`a run could not be prepared: ${err?.stack ?? err}`));
  }

  // Asks a host whose offer the claim holds for its key - the next one after each that
  // gives none - until one does or the lease is about to run out, then starts the job.
  async function prepare(run) {
    if (preparing.has(run.runId)) return;
    preparing.add(run.runId);
    try {
      for (let tries = 0; run.state === 'preparing' && live(run) && host.running(); tries += 1) {
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
        const hosts = keyHosts(run);
        // Nobody to ask: what becomes of the run is said at the next step.
        if (hosts.length === 0) return;
        const to = hosts[tries % hosts.length];
        // The claim goes ahead of the question: a host gives a key only for a claim it holds.
        if (to !== host.self) await host.gossip.send(P, to, 'push', { records: [claim] }, { fresh: true });
        const answer = await host.gossip.send(P, to, 'key', { taskId: run.taskId, round: run.round });
        if (run.state !== 'preparing' || !live(run)) return;
        const body = answer.ok ? answer.body : {};
        const expect = { pool: P.id, taskId: run.taskId, executor: host.self, host: to };
        const spec = isObject(body.spec) ? specDigest(body.spec) : null;
        if (verifyCapability(body.capability, expect, host.now()).ok && isBytes(body.secret, 32) && spec) {
          held[run.taskId] = { runId: run.runId, capability: body.capability, secret: body.secret, spec: body.spec, host: to, seq: -1 };
          run.spec = spec;
          host.saveKeys();
          save();
          host.log(`key of ${run.taskId} received ${host.now() - run.startedAt} s after its claim, at ask ${tries + 1}`);
        } else if (host.now() + RETRY_MS / 1000 >= claim.leaseUntil) {
          halt(run, 'the requester gave no key before the lease ran out', 'release');
          return;
        } else {
          await sleep(KEY_RETRY_MS[tries] ?? RETRY_MS);
        }
      }
    } finally {
      preparing.delete(run.runId);
    }
  }

  async function launch(run, P, task) {
    const { taskId, kind, item, title, identity, offeredBy } = task;
    // The run, its key, and the fact that its job is being started are on disk before a
    // job exists. The host a run acts through is the one its key says, whatever the run's
    // own record got to say before the host last went down.
    run.peer = held[run.taskId].host;
    // The hours of the job are those of the offer it was handed out for.
    const { hours } = backing(claimOf(run), run.peer);
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
      const reason = `the run could not be started: ${err?.message ?? err}`;
      // A fault of this machine's own, with no job run, is no attempt of the offer's.
      if (err?.local === true) halt(run, reason, 'release');
      else conclude(run, { ok: false, summary: reason });
      return;
    }
    if (!live(run)) {
      // Halted while the job was starting: the job is told so.
      stopJob(run, 'stopped while starting');
      return;
    }
    Object.assign(run, { state: 'running', container: String(handle?.container ?? ''), log: String(handle?.log ?? '') });
    host.log(`job of ${taskId} started ${host.now() - run.startedAt} s after its claim`);
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
      endedAt: host.now(), exit: Number.isSafeInteger(outcome?.exit) ? outcome.exit : 0, outcome: worded(outcome), end: 'report',
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
    Object.assign(run, { state: 'stopped', endedAt: host.now(), outcome: worded({ ok: false, summary: reason }), end });
    if (failed) giveUpOn(run);
    save();
    host.store.flush();
    if (started) stopJob(run, reason);
    host.touch();
    host.poke();
  }

  // A task this host failed at or gave back is left to the others for a while, twice as
  // long each time under the same offer: then, nobody having taken it, it is this host's
  // to take again - a machine alone in its pool is all the attempts its offer has. One
  // given up `forGood` is left alone for as long as that offer stands.
  function giveUpOn(run, forGood = false) {
    const before = shun[run.taskId];
    const count = before?.offered === run.offered ? before.count + 1 : 1;
    const wait = Math.min(GIVE_UP_WAIT_MAX_MS, GIVE_UP_WAIT_MS * 2 ** (count - 1));
    shun[run.taskId] = { offered: run.offered, count, until: forGood ? null : host.now() + wait / 1000 };
  }

  // Settles what an ended run owes: its outcome and the job it ran told to every host that
  // backs its claim and still offers the task, each for its own offer; its claim ended;
  // its key forgotten. A run that never had a job has nothing to tell.
  async function wrapUp(run) {
    if (wrapping.has(run.runId)) return;
    wrapping.add(run.runId);
    try {
      const P = host.pools.get(run.pool);
      let claim = claimOf(run);
      const mine = () => claim && claim.state === 'held' && isActive(claim, host.now());
      if (mine() && run.end === 'report' && run.spec) {
        const owed = (P.pool.task(run.taskId, host.now())?.offeredBy ?? []).filter((pk) => backing(claim, pk) && !run.heard.includes(pk));
        if (owed.length > 0) {
          if (run.told + RETRY_MS / 1000 > host.now()) return;
          run.told = host.now();
          const body = { taskId: run.taskId, round: run.round, spec: run.spec, outcome: run.outcome };
          // How an offer ends hangs on the report: it is sent whatever gossip makes of its host.
          const answers = await Promise.all(owed.map((pk) => host.gossip.send(P, pk, 'done', body, { fresh: true })));
          run.heard.push(...owed.filter((_, i) => answers[i].ok));
          save();
          // An offer its host ended for this report is ended here before the claim is:
          // this host does not go for it in between.
          const ended = answers.map((answer) => answer.ok && answer.body.offer).filter(isObject);
          if (ended.length > 0 && host.pools.get(P.id) === P) host.take(P, ended);
          claim = claimOf(run);
          // A host that did not hear is told again later, until the lease is about to run
          // out: an offer whose host never heard goes back to the pool when the claim ends.
          if (answers.some((answer) => !answer.ok) && mine() && host.now() + RETRY_MS / 1000 < claim.leaseUntil) return;
        }
      }
      if (mine() && run.end !== 'drop') {
        const state = run.end === 'report' && run.outcome.ok ? 'completed' : 'released';
        host.take(P, endClaim(host.id, claim, state, host.now(), run.spec));
        host.gossip.spread(P, [claimKey(run.taskId, host.self)]);
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

  // What a live run is worth right now: it goes on only while its claim holds an offer
  // of its task, and once it has a key, the offer of the host that gave it.
  function check(run) {
    const now = host.now();
    const P = host.pools.get(run.pool);
    const claim = claimOf(run);
    if (!claim) return halt(run, 'the claim it ran under is gone', 'drop');
    if (claim.state !== 'held' || !isActive(claim, now)) return halt(run, 'the lease ran out', 'drop', true);
    const K = held[run.taskId]?.runId === run.runId ? held[run.taskId] : null;
    // A job has the hours of the offer it was handed out for.
    const deadline = K ? claim.claimedAt + backing(claim, K.host).hours * 3600 : claim.deadline;
    if (now >= deadline) return halt(run, 'not finished by its deadline', 'report');
    const hosts = holds(run);
    if (hosts.length === 0 || (K && !hosts.includes(K.host))) {
      const open = P.pool.task(run.taskId, now)?.offeredBy ?? [];
      const withdrawn = K ? !open.includes(K.host) : open.length === 0;
      return halt(run, withdrawn ? 'the task was withdrawn' : 'the offer it ran for is no longer its claim\'s', 'release');
    }
    if (run.revoked) return halt(run, 'the requester took its key back', 'release');
    if (run.state === 'running' && alive(run) === false) return conclude(run, { ok: false, summary: 'the run ended without saying how' });
    if (run.state === 'preparing') prepare(run).catch((err) => host.log(`a run could not be prepared: ${err?.stack ?? err}`));
    seek(run, P).catch((err) => host.log(`an offer could not be asked for: ${err?.stack ?? err}`));
    return undefined;
  }

  // One run does for every offer of its task: a host whose offer no claim holds - it
  // offered the task after the claim was made, or could not be reached then - is asked to
  // back the claim as it stands, and this host's own such offer backs it at once. An
  // offer whose hours the claim has outlived is not asked for: backed, it would not be
  // held.
  async function seek(run, P) {
    const me = P.pool.member(host.self, host.now());
    const free = () => {
      const claim = claimOf(run);
      if (!claim || !me) return [];
      return P.pool.task(run.taskId, host.now()).offers
        .filter((o) => !o.claim && eligible(me.maxAcceptedH, o.hours) && host.now() < heldUntil(claim, o));
    };
    if (free().length === 0 || run.sought + RETRY_MS / 1000 > host.now()) return;
    run.sought = host.now();
    // The claim with what one more host backs it with, when both still hold.
    const join = (offer, by, grant) => {
      const claim = claimOf(run);
      if (!live(run) || !claim || !isActive(claim, host.now()) || host.pools.get(P.id) !== P) return;
      const next = joinClaim(host.id, claim, by === host.self ? { offer } : { grant });
      if (!P.pool.room(next) || host.take(P, next).refused.length > 0) return;
      host.gossip.spread(P, [claimKey(run.taskId, host.self)]);
    };
    await Promise.all(free().map(async (o) => {
      if (o.host === host.self) {
        const gen = host.offers.nextGen(run.taskId, host.self);
        if (gen !== null) join({ at: o.createdAt, gen, hours: o.hours }, host.self);
        return;
      }
      for (let attempt = 1; attempt <= SEEK_ATTEMPTS && live(run); attempt += 1) {
        const asOf = host.now();
        const body = { taskId: run.taskId, round: run.round, asOf, hash: P.pool.stateHash(asOf) };
        const answer = await host.gossip.send(P, o.host, 'lock', body, { fresh: true, timeoutMs: PROBE_TIMEOUT_MS });
        const grant = answer.ok ? answer.body.grant : null;
        const bound = { pool: P.id, taskId: run.taskId, executor: host.self, round: run.round, by: o.host };
        if (verifyGrant(grant, bound) && grant.offer?.at === o.createdAt && grant.offer.hours === o.hours) {
          join(grant.offer, o.host, grant);
          return;
        }
        // The two hosts hold different states: brought together, the host is asked again.
        if (!answer.ok || answer.body.stale !== true) return;
        await host.gossip.syncWith(P, o.host);
      }
    }));
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
      for (const claim of P.pool.records()) {
        const behind = (run) => run.taskId === claim.taskId && run.round === claim.round && run.end !== 'over';
        if (claim.type !== 'claim' || claim.executor !== host.self || !isActive(claim, now)) continue;
        if (Object.values(runs).some(behind)) continue;
        host.take(P, endClaim(host.id, claim, 'released', now));
        host.gossip.spread(P, [claimKey(claim.taskId, host.self)]);
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
      // Never sent, or refused before anything was done - for want of work, or as dated
      // before the requester started: it was not carried out, whatever it was. A body
      // refused unread is no such proof: it may be the second copy of one the transport
      // sent twice.
      const unsent = answer.lost === 'offline' || answer.lost === 'no-place' || answer.lost === 'budget' || answer.code === 'effort'
        || (answer.code === 'busy' && answer.detail === UNSERVED);
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

  /// Stops one run and gives its claim back. `reason` is what the run's record and its
  /// job are told; without one it is the operator who stopped it, and this host does not
  /// take the task again while the offer its claim took stands.
  function stopRun({ runId, reason }) {
    const run = Object.hasOwn(runs, runId) ? runs[runId] : null;
    if (!run || !live(run)) throw new Error('No such run is going on this machine.');
    giveUpOn(run, reason === undefined);
    halt(run, reason ?? 'stopped by the operator', 'release', false);
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
        keys.push(claimKey(run.taskId, host.self));
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
      const claim = P.pool.get(claimKey(ping.taskId, host.self));
      const deny = (detail) => ({ error: 'denied', detail });
      if (!claim || ping.by !== from) return deny('not a ping for a claim of this host');
      const verdict = verifyPing(ping, claim);
      if (!verdict.ok) return verdict.code === 'old' ? { body: { claim } } : deny(verdict.code);
      if (Math.abs(ping.ts - now) > CLOCK_SKEW_SECS) return deny('stale');
      if (!isActive(claim, now)) return deny('lapsed');
      // A lease is extended for a job that is going, never for a claim alone: a run still
      // waiting for its key gives its claim back when its first lease is about to end.
      const run = Object.values(runs).find((r) => r.taskId === claim.taskId && r.round === claim.round);
      if (!run || !live(run) || !run.launched || (run.state === 'running' && alive(run) === false)) return deny('no run');
      const next = extendClaim(host.id, claim, ping, now);
      if (host.take(P, next).refused.length > 0) return deny('the extension does not hold');
      host.gossip.spread(P, [claimKey(claim.taskId, host.self)], from);
      return { body: { claim: next } };
    },
  };

  /// Takes up the runs the store holds: the executor reports how a job ended from here on.
  function start() {
    host.executor.onEnd((runId, outcome) => {
      try {
        conclude(Object.hasOwn(runs, runId) ? runs[runId] : null, outcome);
      } catch (err) {
        host.log(`the end of ${runId} could not be taken up: ${err?.stack ?? err}`);
      }
    });
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
    /// Does this host leave that offer of the task alone, having given up on it?
    shuns(taskId, createdAt) {
      const given = shun[taskId];
      return given?.offered === createdAt && (given.until === null || host.now() < given.until);
    },
    /// The runs as the snapshot lists them.
    rows: () => Object.values(runs).map(({ runId, taskId, pool, peer, container, state, startedAt, endedAt, exit, log }) => (
      { runId, taskId, pool, peer, container, state, startedAt, endedAt, exit, log })),
  };
}
