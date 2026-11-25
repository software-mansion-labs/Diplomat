// The requester's side of a task (PROTOCOL.md sections 8 and 9). Every member holds an
// offer's signed record; its prompt goes only to the keyed executor, and its counters and
// outcome stay here.

import { b64u, canon, unb64u } from '../core/canon.js';
import { SeqTracker, buildCapability, capabilityExp, checkAct, checkDone, specDigest } from '../core/capability.js';
import { buildPing, eligible, heldUntil, isActive, pingDue } from '../core/lease.js';
import { LIMITS, backers, backing, buildTaskId, isBytes, isObject, offerRecord, parseTaskId, shaped } from '../core/records.js';
import {
  CLOCK_SKEW_SECS, KEYLESS_WAIT_MAX_MS, KEYLESS_WAIT_MS, LEASE_SECS, OFFER_ATTEMPTS, RECORD_RETENTION_SECS, RESIGN_INTERVAL_MS, RETAKE_WAIT_MS,
  RETRY_MS,
} from '../paths.js';
import { claimKey, hoursOf, offerKey } from './gossip.js';

const OPEN = ['pooled', 'claimed'];
const MAX_REASON = 200;
const MAX_SPEC_BYTES = 512 * 2 ** 10;
export const ELSEWHERE = 'run for another machine\'s offer of the same job';
export const OUTLIVED = 'this machine was away for longer than an offer lasts';

/// Control characters become spaces: what a run says reaches logs, terminals and the applets.
export const plain = (value) => String(value ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ');

/// A forge-style refusal made here: `body` is base64 of JSON `{ message }`.
export function forgeAnswer(status, message) {
  return {
    status, headers: { 'content-type': 'application/json' },
    body: Buffer.from(JSON.stringify({ message: String(message) })).toString('base64'),
  };
}

// Cut to what a signed response can carry.
function tidy(result) {
  const headers = {};
  for (const [name, value] of Object.entries(isObject(result?.headers) ? result.headers : {})) {
    if (typeof value === 'string') headers[name.toLowerCase()] = value;
  }
  if (!Number.isSafeInteger(result?.status) || typeof result.body !== 'string') return forgeAnswer(502, 'the forge call returned no response');
  return { status: result.status, headers, body: result.body };
}

export function createOffers(host) {
  const offers = host.store.read('offers') ?? {}; // taskId -> the offer's private state
  const issued = host.keys.issued; // taskId -> { round, secret, seq, capability }
  const turns = new Map(); // taskId -> the last request served under its key
  const jobs = new WeakMap(); // offer -> its job digest

  const save = () => host.store.write('offers', offers);
  // The slice may halve a surrogate pair, which a record may not carry.
  const text = (value, max) => plain(value).slice(0, max).toWellFormed();

  // One at a time per task: a key is issued once, and acts run in the order their seqs
  // were accepted.
  function inTurn(taskId, fn) {
    const turn = (turns.get(taskId) ?? Promise.resolve()).then(fn);
    const settled = turn.catch(() => {});
    turns.set(taskId, settled);
    settled.then(() => turns.get(taskId) === settled && turns.delete(taskId));
    return turn;
  }

  // What the executor is handed.
  function specOf(O) {
    const spec = {
      taskId: O.taskId, kind: O.kind, item: O.item, title: O.title, identity: O.identity, prompt: O.prompt,
      options: O.options, base: O.base, name: O.name, email: O.email,
    };
    return Object.fromEntries(Object.entries(spec).filter(([, value]) => value !== undefined));
  }

  // The spec's digest, fixed for the offer's life.
  function jobOf(O) {
    if (!jobs.has(O)) jobs.set(O, specDigest(specOf(O)));
    return jobs.get(O);
  }

  async function rulesOf(P, O) {
    try {
      const rules = await host.requester.rulesFor({
        forge: P.link.forge, kind: O.kind, options: O.options, pool: P.link, item: O.item, identity: O.identity,
      });
      return Array.isArray(rules) ? rules : null;
    } catch (err) {
      host.log(`no rules for ${O.taskId}: ${err?.stack ?? err}`);
      return null;
    }
  }

  function signed(P, O, state) {
    O.seq = Math.max(O.seq, P.pool.get(offerKey(O.taskId, host.self))?.seq ?? -1) + 1;
    O.at = Math.max(host.now(), O.createdAt);
    return offerRecord(host.id, {
      pool: P.id, kind: O.kind, item: O.item, identity: O.identity, seq: O.seq, at: O.at,
      title: O.title, minRequiredH: O.hours, createdAt: O.createdAt, state,
      attempt: Math.min(LIMITS.attempt, O.failed.length + 1),
    });
  }

  function publish(P, O, state = 'open', record = signed(P, O, state)) {
    host.take(P, record);
    host.gossip.deliver(P, [offerKey(O.taskId, host.self)]);
    save();
  }

  function revoke(taskId) {
    if (!issued[taskId]) return;
    delete issued[taskId];
    host.saveKeys();
  }

  // `done`, `failed` or `cancelled` here, `done` or `cancelled` in the pool. Keeps the
  // executor that last held it.
  function end(P, O, state, reason = '') {
    Object.assign(O, { state, reason: text(reason, MAX_REASON), endedAt: host.now(), executor: O.ran ?? O.executor });
    revoke(O.taskId);
    if (P) publish(P, O, state === 'done' ? 'done' : 'cancelled');
    save();
    host.touch();
  }

  // An attempt failed: the run said so, or its claim lapsed.
  function fail(P, O, round, reason) {
    O.failed.push(round);
    O.reason = text(reason, MAX_REASON);
    // A claim holding the offer since owns the current key.
    if (issued[O.taskId]?.round === round) revoke(O.taskId);
    if (O.failed.length >= OFFER_ATTEMPTS) return end(P, O, 'failed', reason);
    Object.assign(O, { state: 'pooled', executor: '' });
    return publish(P, O);
  }

  /// Offering a task whose offer is open answers that offer. Throws a sentence for the
  /// operator.
  async function offer({ pool, kind, options = {}, item, title, prompt, base, now: atOnce = false, author = {} }) {
    const P = host.pools.get(pool);
    if (!P) throw host.gossip.noPool(pool);
    const identity = String(P.link.identity ?? '').toLowerCase();
    const taskId = buildTaskId({ pool, kind, item, identity });
    if (!taskId) throw new Error(`"${kind}" of "${item}" as "${identity}" is not a task this network can name.`);
    const before = offers[taskId];
    if (before && OPEN.includes(before.state)) return { taskId };
    const now = host.now();
    const O = {
      taskId, pool, kind, item, identity, options, title: text(title, LIMITS.title), prompt: String(prompt ?? ''),
      base: base === undefined ? undefined : String(base), name: author.name, email: author.email,
      now: atOnce === true, hours: hoursOf(host.settings().requiredMinimumH), offeredAt: now, createdAt: now,
      seq: before?.seq ?? -1, gen: 0,
      state: 'pooled', executor: '', ran: '', failed: [], reported: [], requests: 0, refused: 0, outcome: null,
      reason: '', endedAt: 0, watch: null, pinged: 0,
    };
    try {
      if (canon(specOf(O)).length > MAX_SPEC_BYTES) throw new RangeError('too long');
    } catch (err) {
      throw new Error(`The task cannot be sent to another machine: its prompt and options are ${err instanceof RangeError ? 'too long' : 'not plain text and whole numbers'}.`);
    }
    if (!(await rulesOf(P, O))) throw new Error(`No rules exist for a "${kind}" task on ${P.link.forge}, so it cannot be offered.`);
    if (host.pools.get(pool) !== P) throw host.gossip.noPool(pool);
    if (offers[taskId] && OPEN.includes(offers[taskId].state)) return { taskId };
    // `createdAt` tells this offer from the previous one of the task: a claim of that one
    // holds nothing of this one.
    const last = P.pool.get(offerKey(taskId, host.self));
    if (last) O.createdAt = Math.max(O.createdAt, last.createdAt + 1);
    // One more record than a member may have live would push another of this host's out.
    const record = signed(P, O, 'open');
    if (!P.pool.room(record)) {
      throw new Error(`This machine has as many offers and claims in the pool ${pool} as one member may: room is made as they end and age out.`);
    }
    offers[taskId] = O;
    publish(P, O, 'open', record);
    host.gossip.doubt(P);
    host.poke();
    host.touch();
    return { taskId };
  }

  function withdraw({ taskId, reason = '' }) {
    const O = offers[taskId];
    if (!O || !OPEN.includes(O.state)) throw new Error('This machine has no open offer of that task.');
    end(host.pools.get(O.pool), O, 'cancelled', reason);
  }

  // A completed claim of this offer's job (only completed claims name one), claimed no
  // earlier than this offer was made, skew aside, and not backed by an earlier offer of
  // this host's: a run that began before says nothing of an offer made knowing of it.
  function elsewhere(P, O) {
    return P.pool.claims(O.taskId, host.now()).find((claim) => claim.spec === jobOf(O)
      && claim.claimedAt + CLOCK_SKEW_SECS >= O.createdAt && [undefined, O.createdAt].includes(backing(claim, host.self)?.at)) ?? null;
  }

  // A job done elsewhere ends the offer as done, at no cost.
  function finished(P, O) {
    const ran = elsewhere(P, O);
    if (!ran) return false;
    O.ran = ran.executor;
    O.backedBy = backers(ran);
    O.outcome = { ok: true, summary: ELSEWHERE, usd: 0, tokens: 0, runner: '', model: '' };
    end(P, O, 'done');
    return true;
  }

  // A claim that let go before its hold ran out cost no attempt, but its executor waits
  // so the others go first: nobody keeps an offer by taking it and giving it back.
  function rest(O, claim, now) {
    const watched = O.watch;
    if (!watched || watched.round === claim?.round || now >= watched.lapses) return;
    O.watch = null;
    O.rests = { ...O.rests, [watched.executor]: now + RETAKE_WAIT_MS / 1000 };
  }

  // A claim lapsed after holding the offer for under a lease (dated back, or joined late),
  // or with its first lease and no key of this host's: no run got its time, so no attempt
  // is lost. The doubling wait is per branch, so a member with keys of its own in its
  // seats takes no more turns than one key.
  function sat(P, O, executor, now) {
    const branch = P.pool.branch(executor, now);
    const times = (O.sat?.[branch]?.times ?? 0) + 1;
    O.sat = { ...O.sat, [branch]: { times, until: now + Math.min(KEYLESS_WAIT_MAX_MS, KEYLESS_WAIT_MS * 2 ** (times - 1)) / 1000 } };
  }

  /// Gives this host's open offer to a claim of `executor`: answers the new gen, which
  /// orders the claims it backs, or null when the offer is not open, the pool is stale,
  /// the job was done elsewhere, or that executor or its branch is waiting.
  function nextGen(taskId, executor) {
    const O = offers[taskId];
    if (!O || !OPEN.includes(O.state)) return null;
    const P = host.pools.get(O.pool);
    host.look();
    if (P.stale !== null || finished(P, O)) return null;
    const now = host.now();
    // The claim may have let go since the last step.
    rest(O, holder(P, O), now);
    if (now < O.rests?.[executor] || now < O.sat?.[P.pool.branch(executor, now)]?.until) return null;
    O.gen += 1;
    save();
    return O.gen;
  }

  // Backed with the offer open now, not an earlier one. A claim this host does not back
  // gets no key, no heartbeat and no say in how the offer ends.
  const backs = (O, claim) => backing(claim, host.self)?.at === O.createdAt;

  const holder = (P, O) => P.pool.task(O.taskId, host.now())?.offers.find((o) => o.host === host.self)?.claim ?? null;

  // A round whose run reported is over here while its claim still holds.
  function standing(P, O, executor, round) {
    const claim = holder(P, O);
    return claim && claim.executor === executor && claim.round === round && !O.reported.includes(round) ? claim : null;
  }

  // A lease extension moves the key's expiry with it: same key, same secret.
  function refresh(K, claim) {
    const exp = capabilityExp(claim, backing(claim, host.self));
    if (K.capability.exp === exp) return;
    const { keyId, sig: _, host: __, ...rest } = K.capability;
    K.capability = buildCapability(host.id, { ...rest, keyId: unb64u(keyId), exp });
    host.saveKeys();
  }

  const handlers = {
    key(P, from, body) {
      const fine = shaped(body, { taskId: (v) => parseTaskId(v)?.pool === P.id, round: (v) => isBytes(v, 8) });
      if (!fine) return { error: 'bad-request' };
      const { taskId, round } = body;
      const deny = (detail) => ({ error: 'denied', detail });
      return inTurn(taskId, async () => {
        const O = offers[taskId];
        if (!O) return deny('not offered by this host');
        let claim = standing(P, O, from, round);
        if (!claim) return deny('no claim of that executor and round holds the offer of this host');
        if (issued[taskId] && (issued[taskId].round !== round || issued[taskId].capability.executor !== from)) revoke(taskId);
        if (!issued[taskId]) {
          const rules = await rulesOf(P, O);
          claim = standing(P, O, from, round);
          if (!rules || !claim) return deny('the task can no longer be acted on');
          issued[taskId] = {
            round, secret: b64u(host.random(32)), seq: -1,
            capability: buildCapability(host.id, {
              keyId: host.random(16), pool: P.id, taskId, executor: from, rules,
              exp: capabilityExp(claim, backing(claim, host.self)),
            }),
          };
          host.saveKeys();
        }
        const K = issued[taskId];
        refresh(K, claim);
        return { body: { capability: K.capability, secret: K.secret, spec: specOf(O) } };
      });
    },

    act(P, from, body) {
      if (!isObject(body) || parseTaskId(body.taskId)?.pool !== P.id) return { error: 'bad-request', detail: 'not an act body' };
      const { taskId } = body;
      return inTurn(taskId, async () => {
        const K = issued[taskId];
        const O = offers[taskId];
        if (!K || !O) return { error: 'denied', detail: 'no key' };
        const at = standing(P, O, from, K.round);
        if (at) refresh(K, at);
        const seqs = new SeqTracker([[K.capability.keyId, K.seq]]);
        const checked = checkAct(body, { capability: K.capability, secret: unb64u(K.secret), seqs, from, now: host.now() });
        if (!checked.ok) return { error: checked.code, detail: checked.detail };
        K.seq = body.seq;
        host.saveKeys();
        if (!at) {
          revoke(taskId);
          return { error: 'denied', detail: 'the claim this key was issued for is not active' };
        }
        // Judged by the current rules, so a tightening update reaches keys issued before it.
        const rules = await rulesOf(P, O);
        if (!rules) {
          revoke(taskId);
          return { error: 'denied', detail: 'the task has no rules any more' };
        }
        O.requests += 1;
        save();
        // The seq is spent, on disk, before anything is done under it.
        host.store.flush();
        // Allowance usage is the offer's, so a key for a later attempt continues where the
        // last one stopped; the key stands for the claim.
        const context = await host.requester.context({ pool: P.link, task: specOf(O), state: (O.used ??= {}), claim: K });
        const verdict = await host.requester.authorize(rules, body.request, context);
        save();
        const request = verdict?.ok === true ? verdict.request ?? body.request : null;
        let answer;
        try {
          // The offer or claim may have ended while the rules were asked.
          if (issued[taskId] !== K) return { error: 'denied', detail: 'the key was taken back' };
          if (!request) {
            O.refused += 1;
            return { body: forgeAnswer(403, verdict?.reason ?? 'no rule covers this request') };
          }
          host.store.flush();
          try {
            answer = await host.requester.perform(request, { forge: P.link.forge, host: P.id.split('/')[0] });
            return { body: tidy(answer) };
          } catch (err) {
            return { body: forgeAnswer(502, `the forge could not be asked: ${err?.message ?? err}`) };
          }
        } finally {
          // The rules counted the request when they allowed it; one with no answer is
          // concluded, so the forge is asked what became of it before the next is judged.
          if (request && !answer) host.requester.conclude(request);
          save();
          host.touch();
        }
      });
    },

    done(P, from, body) {
      const claim = typeof body?.taskId === 'string' ? P.pool.get(claimKey(body.taskId, from)) : null;
      const checked = checkDone(body, { claim, from, now: host.now() });
      if (!checked.ok) return { error: checked.code, detail: checked.detail };
      const O = offers[body.taskId];
      if (!O || !OPEN.includes(O.state) || O.reported.includes(body.round) || !backs(O, claim)) return { body: {} };
      // A report of another host's job says nothing of this one's.
      if (body.spec !== jobOf(O)) return { body: {} };
      // The offer may have been given on to another claim.
      const current = holder(P, O);
      if (current && current.executor !== from) return { body: {} };
      const { ok, summary, microUsd, tokens, runner, model, capped } = body.outcome;
      O.reported.push(body.round);
      O.ran = from;
      // Another machine wrote these.
      O.outcome = {
        ok, summary: plain(summary), usd: microUsd / 1e6, tokens, runner: plain(runner), model: plain(model), ...(capped === true ? { capped } : {}),
      };
      if (ok) end(P, O, 'done');
      else fail(P, O, body.round, summary);
      // The executor takes this in before it ends its claim.
      return { body: { offer: P.pool.get(offerKey(O.taskId, host.self)) } };
    },
  };

  async function ping(P, O, claim) {
    // A lease hangs on the ping: `fresh` sends it whatever the backoff.
    const answer = await host.gossip.send(P, claim.executor, 'ping', { ping: buildPing(host.id, claim, host.now()) }, { fresh: true });
    if (!answer.ok || !isObject(answer.body.claim) || host.pools.get(P.id) !== P) return;
    const key = claimKey(O.taskId, claim.executor);
    if (host.take(P, answer.body.claim).fresh.includes(key)) host.gossip.spread(P, [key], claim.executor);
  }

  function stepOffer(P, O) {
    const now = host.now();
    const { taskId } = O;
    const claim = holder(P, O);
    if (!claim && finished(P, O)) return undefined;
    // Not re-signed in time (this host was not running), so it is in no pool any more.
    // Whether the work is still to do is for whoever offered it to say.
    if (now >= O.at + RECORD_RETENTION_SECS) return end(P, O, 'cancelled', OUTLIVED);
    const mine = P.pool.get(offerKey(taskId, host.self));
    if (!mine || now - mine.at >= RESIGN_INTERVAL_MS / 1000) publish(P, O);

    rest(O, claim, now);
    const watched = O.watch;
    if (watched && watched.round !== claim?.round) {
      O.watch = null;
      const held = P.pool.get(claimKey(taskId, watched.executor));
      const same = held?.round === watched.round;
      if (O.reported.includes(watched.round)) {
        // The run said how it ended.
      } else if (watched.lapses - watched.since < LEASE_SECS || !(watched.extended || watched.keyed)) {
        sat(P, O, watched.executor, now);
      } else {
        const going = same && isActive(held, now);
        fail(P, O, watched.round, going ? 'not finished in the hours this machine gives it' : 'the machine running it stopped answering');
        if (!OPEN.includes(O.state)) return undefined;
      }
    }
    if (claim) {
      // `since`: when this host first saw the claim hold its offer. A claim past its first
      // lease was extended for a backing host. `keyed` is noted now because a later
      // claim's key may replace it before the next look.
      O.watch = {
        round: claim.round, executor: claim.executor, since: watched?.round === claim.round ? watched.since : now,
        extended: claim.seq > 0, keyed: issued[taskId]?.round === claim.round, lapses: heldUntil(claim, backing(claim, host.self)),
      };
      O.ran = claim.executor;
    }
    // A reported claim holds the offer until its executor ends it; nothing to wait for.
    const executor = claim && !O.reported.includes(claim.round) ? claim.executor : '';
    const state = executor ? 'claimed' : 'pooled';
    if (O.state !== state || O.executor !== executor) {
      Object.assign(O, { state, executor });
      host.touch();
    }
    save();

    const K = issued[taskId];
    if (K && claim?.round === K.round && claim.executor === K.capability.executor) refresh(K, claim);
    else revoke(taskId);
    // Ping only for a run that holds this host's key.
    if (claim && issued[taskId]?.round === claim.round && pingDue(claim, backing(claim, host.self), now) && O.pinged + RETRY_MS / 1000 <= now) {
      O.pinged = now;
      ping(P, O, claim).catch((err) => host.log(`a ping failed: ${err?.stack ?? err}`));
    }
    return undefined;
  }

  // An open record of this host's with no open offer behind it ended while some member
  // could not hear, and was handed back by it: end it again.
  function disown(P) {
    for (const record of P.pool.records()) {
      if (record.type !== 'offer' || record.host !== host.self || record.state !== 'open') continue;
      const O = offers[record.taskId];
      if (O && OPEN.includes(O.state)) continue;
      const { sig: _, ...fields } = record;
      const state = O?.state === 'done' ? 'done' : 'cancelled';
      host.take(P, offerRecord(host.id, { ...fields, seq: record.seq + 1, at: Math.max(host.now(), record.at), state }));
      host.gossip.deliver(P, [offerKey(record.taskId, host.self)]);
    }
  }

  /// A pool's offers wait while it is stale.
  function step() {
    const now = host.now();
    for (const O of Object.values(offers)) {
      const P = host.pools.get(O.pool);
      if (OPEN.includes(O.state)) {
        if (!P) end(null, O, 'cancelled', 'the pool was closed');
        else if (P.stale === null) stepOffer(P, O);
      } else if (now >= O.endedAt + RECORD_RETENTION_SECS) {
        delete offers[O.taskId];
        save();
      }
    }
    for (const P of host.pools.values()) disown(P);
  }

  /// Answers the keys of the records signed.
  function closing(P, reason) {
    const keys = [];
    for (const O of Object.values(offers)) {
      if (O.pool !== P.id || !OPEN.includes(O.state)) continue;
      end(P, O, 'cancelled', reason);
      keys.push(offerKey(O.taskId, host.self));
    }
    return keys;
  }

  const atOnce = (taskId) => offers[taskId]?.now === true && offers[taskId].state === 'pooled';

  function keyHeldBy(pk) {
    const now = host.now();
    return Object.values(issued).some((K) => K.capability.executor === pk && now < K.capability.exp);
  }

  /// For a pooled offer, what keeps this host from running it: `leftUntil` (left to the
  /// others after a give-up, or 0), `leftForGood` (its operator stopped a run of it here),
  /// `tooLong` (it needs more hours than this host accepts).
  function rows() {
    const now = host.now();
    return Object.values(offers).map((O) => {
      const P = O.state === 'pooled' ? host.pools.get(O.pool) : null;
      const left = P ? host.runs.left(O.taskId, P.pool.task(O.taskId, now)?.createdAt) : 0;
      const me = P?.pool.member(host.self, now);
      return {
        taskId: O.taskId, pool: O.pool, kind: O.kind, item: O.item, title: O.title, state: O.state,
        executor: O.executor, executorHere: O.executor === host.self, backedBy: O.backedBy ?? [],
        attempt: Math.min(OFFER_ATTEMPTS, O.failed.length + 1),
        requests: O.requests, refused: O.refused, outcome: O.outcome, reason: O.reason, offeredAt: O.offeredAt,
        endedAt: O.endedAt, leftUntil: Number.isFinite(left) ? left : 0, leftForGood: left === Infinity,
        tooLong: Boolean(me) && !eligible(me.maxAcceptedH, O.hours),
      };
    });
  }

  return { offer, withdraw, nextGen, step, closing, atOnce, keyHeldBy, rows, handlers };
}
