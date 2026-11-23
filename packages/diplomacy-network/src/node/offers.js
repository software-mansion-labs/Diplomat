// The requester's side of a task (PROTOCOL.md sections 8 and 9): the offers this host
// put in its pools, the one key it hands the executor of each, the forge requests it
// carries out under that key, the heartbeat that keeps a claim alive, and how an offer ends.
//
// An offer has a public half, the signed record every member holds, and a private half
// that never leaves this host: the prompt, the counters, the outcome.

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
/// What the outcome of an offer says when its job was done by a run this host's offer
/// was not given to: one for another offer of the same job.
export const ELSEWHERE = 'run for another machine\'s offer of the same job';
/// Why an offer its host could not sign again in time is cancelled.
export const OUTLIVED = 'this machine was away for longer than an offer lasts';

/// `value` as text with a space where each control character was: what a run says of
/// itself reaches logs, terminals and the applets.
export const plain = (value) => String(value ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ');

/// A forge answer made here rather than by the forge: `{ status, headers, body }` with a
/// JSON `{ message }` as its body, the way a forge words a refusal.
export function forgeAnswer(status, message) {
  return {
    status, headers: { 'content-type': 'application/json' },
    body: Buffer.from(JSON.stringify({ message: String(message) })).toString('base64'),
  };
}

// What a forge answered, cut to what a signed response can carry.
function tidy(result) {
  const headers = {};
  for (const [name, value] of Object.entries(isObject(result?.headers) ? result.headers : {})) {
    if (typeof value === 'string') headers[name.toLowerCase()] = value;
  }
  if (!Number.isSafeInteger(result?.status) || typeof result.body !== 'string') return forgeAnswer(502, 'the forge call returned no response');
  return { status: result.status, headers, body: result.body };
}

/// The offers of `host` and the keys it issued for them.
export function createOffers(host) {
  const offers = host.store.read('offers') ?? {}; // taskId -> the private half
  const issued = host.keys.issued; // taskId -> { round, secret, seq, capability }
  const turns = new Map(); // taskId -> the last request served under its key
  const jobs = new WeakMap(); // an offer -> what names its job

  const save = () => host.store.write('offers', offers);
  // Cut first: a cut may fall inside a surrogate pair, and a record carries none halved.
  const text = (value, max) => plain(value).slice(0, max).toWellFormed();

  // One thing at a time per task: a key is issued once, and requests under it are
  // carried out in the order their numbers were accepted.
  function inTurn(taskId, fn) {
    const turn = (turns.get(taskId) ?? Promise.resolve()).then(fn);
    const settled = turn.catch(() => {});
    turns.set(taskId, settled);
    settled.then(() => turns.get(taskId) === settled && turns.delete(taskId));
    return turn;
  }

  // What the executor is handed to run the task.
  function specOf(O) {
    const spec = {
      taskId: O.taskId, kind: O.kind, item: O.item, title: O.title, identity: O.identity, prompt: O.prompt,
      options: O.options, base: O.base, name: O.name, email: O.email,
    };
    return Object.fromEntries(Object.entries(spec).filter(([, value]) => value !== undefined));
  }

  // What names the job of an offer: the digest of the spec it hands out, which is the
  // same for as long as the offer is.
  function jobOf(O) {
    if (!jobs.has(O)) jobs.set(O, specDigest(specOf(O)));
    return jobs.get(O);
  }

  // The rules a task of this offer may act by, or null when there are none.
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

  // Signs the next version of an offer's record and tells the pool.
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

  // Ends an offer: `done`, `failed` or `cancelled` here, `done` or `cancelled` in the pool.
  // It keeps the executor that last held it: the one that ended it, or nobody.
  function end(P, O, state, reason = '') {
    Object.assign(O, { state, reason: text(reason, MAX_REASON), endedAt: host.now(), executor: O.ran ?? O.executor });
    revoke(O.taskId);
    if (P) publish(P, O, state === 'done' ? 'done' : 'cancelled');
    save();
    host.touch();
  }

  // An attempt failed: the run said so, or its claim lapsed. The task goes back to the
  // pool until it has failed too often.
  function fail(P, O, round, reason) {
    O.failed.push(round);
    O.reason = text(reason, MAX_REASON);
    // The key of a claim that holds the offer since is not this attempt's to take back.
    if (issued[O.taskId]?.round === round) revoke(O.taskId);
    if (O.failed.length >= OFFER_ATTEMPTS) return end(P, O, 'failed', reason);
    Object.assign(O, { state: 'pooled', executor: '' });
    return publish(P, O);
  }

  /// Puts a task in a pool. The same task offered again while its offer is open is that
  /// offer. Throws, with a sentence for the operator, when the task cannot be offered.
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
    // An offer is told from the one this host made of the task before by when it was
    // made: a claim of that one holds nothing of this one.
    const last = P.pool.get(offerKey(taskId, host.self));
    if (last) O.createdAt = Math.max(O.createdAt, last.createdAt + 1);
    // One more record than a member may have live would push another of this host's out.
    const record = signed(P, O, 'open');
    if (!P.pool.room(record)) {
      throw new Error(`This machine has as many offers and claims in the pool ${pool} as one member may: room is made as they end and age out.`);
    }
    offers[taskId] = O;
    publish(P, O, 'open', record);
    host.poke();
    host.touch();
    return { taskId };
  }

  /// Takes an offer back: cancelled for every member, its key dead.
  function withdraw({ taskId, reason = '' }) {
    const O = offers[taskId];
    if (!O || !OPEN.includes(O.state)) throw new Error('This machine has no open offer of that task.');
    end(host.pools.get(O.pool), O, 'cancelled', reason);
  }

  // The claim of a run that did this offer's very job and ended well, or null: only a
  // completed claim names a job. The run was claimed no earlier than this offer was made,
  // the clocks' tolerance aside - one that began before says nothing of an offer made
  // knowing of it, and a run this host gave an earlier offer of its own to is such a
  // one.
  function elsewhere(P, O) {
    return P.pool.claims(O.taskId, host.now()).find((claim) => claim.spec === jobOf(O)
      && claim.claimedAt + CLOCK_SKEW_SECS >= O.createdAt && [undefined, O.createdAt].includes(backing(claim, host.self)?.at)) ?? null;
  }

  // An offer no claim holds whose job was done elsewhere is done: nothing is booked for
  // it, and it says who ran the job and whose offers that run was given. True when so.
  function finished(P, O) {
    const ran = elsewhere(P, O);
    if (!ran) return false;
    O.ran = ran.executor;
    O.backedBy = backers(ran);
    O.outcome = { ok: true, summary: ELSEWHERE, usd: 0, tokens: 0, runner: '', model: '' };
    end(P, O, 'done');
    return true;
  }

  // A claim that let go of the offer before its hold ran out cost the offer nothing. Its
  // executor is given the offer again only after a while, so that the other members go
  // first: no member keeps an offer to itself by taking it up and giving it back.
  function rest(O, claim, now) {
    const watched = O.watch;
    if (!watched || watched.round === claim?.round || now >= watched.lapses) return;
    O.watch = null;
    O.rests = { ...O.rests, [watched.executor]: now + RETAKE_WAIT_MS / 1000 };
  }

  // A claim lapsed that held the offer for less than a lease - dated back, or joined by
  // this host's grant late in its lease - or that ended with its first lease and never
  // had this host's key: no run was given its time, and the offer lost no attempt. The wait is on
  // every key that sits where the executor does, and doubles each time: a member with
  // keys of its own in its seats takes no more turns than one key.
  function sat(P, O, executor, now) {
    const branch = P.pool.branch(executor, now);
    const times = (O.sat?.[branch]?.times ?? 0) + 1;
    O.sat = { ...O.sat, [branch]: { times, until: now + Math.min(KEYLESS_WAIT_MAX_MS, KEYLESS_WAIT_MS * 2 ** (times - 1)) / 1000 } };
  }

  /// This host gives its open offer of `taskId` to a claim of `executor`: how many times
  /// it has given that offer away with this one, the number that orders the claims it
  /// backs. Null when it has no such offer open, or will not give it: what it holds of
  /// the pool is not up to date, the job was done elsewhere, a claim of that executor let
  /// go of the offer a moment ago, or one from among its seats sat on the offer unkeyed. The count is on disk before anyone sees it.
  function nextGen(taskId, executor) {
    const O = offers[taskId];
    if (!O || !OPEN.includes(O.state)) return null;
    const P = host.pools.get(O.pool);
    host.look();
    if (P.stale !== null || finished(P, O)) return null;
    const now = host.now();
    // The claim may have let go since this host last looked at its offers.
    rest(O, holder(P, O), now);
    if (now < O.rests?.[executor] || now < O.sat?.[P.pool.branch(executor, now)]?.until) return null;
    O.gen += 1;
    save();
    return O.gen;
  }

  // Does this host back the claim with the offer it has open now, and not with one it
  // made of the task before? A claim this host does not back gets nothing from it - no
  // key, no heartbeat, no say in how the offer ends.
  const backs = (O, claim) => backing(claim, host.self)?.at === O.createdAt;

  // The claim that holds this host's offer right now, by this host's own state, or null.
  const holder = (P, O) => P.pool.task(O.taskId, host.now())?.offers.find((o) => o.host === host.self)?.claim ?? null;

  // The claim that holds this host's offer right now for `executor` in `round`, or null.
  // A round whose run has said how it ended is over for this host while its claim still
  // holds.
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
        // Judged by the rules the catalogue gives the task now, so that an update which
        // tightens them reaches a key issued before it.
        const rules = await rulesOf(P, O);
        if (!rules) {
          revoke(taskId);
          return { error: 'denied', detail: 'the task has no rules any more' };
        }
        O.requests += 1;
        save();
        // The number is used, on disk, before anything is done under it.
        host.store.flush();
        // What the task has used of its allowances is the offer's: a key issued for a
        // later attempt goes on from where the last one stopped.
        const context = await host.requester.context({ pool: P.link, task: specOf(O), state: (O.used ??= {}) });
        const verdict = await host.requester.authorize(rules, body.request, context);
        save();
        const request = verdict?.ok === true ? verdict.request ?? body.request : null;
        let answer;
        try {
          // The offer may have ended, or the claim, while the rules were asked.
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
          // The rules counted the request when they allowed it. One that got no answer
          // here is settled with them as not sent: the forge is asked what became of it
          // before the task's next one is judged.
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
      // The run did the job another host handed out: it says nothing of this host's.
      if (body.spec !== jobOf(O)) return { body: {} };
      // The offer may be another claim's by now: this host gave it on.
      const current = holder(P, O);
      if (current && current.executor !== from) return { body: {} };
      const { ok, summary, microUsd, tokens, runner, model, capped } = body.outcome;
      O.reported.push(body.round);
      O.ran = from;
      // The executor's own words: another machine wrote them.
      O.outcome = {
        ok, summary: plain(summary), usd: microUsd / 1e6, tokens, runner: plain(runner), model: plain(model), ...(capped === true ? { capped } : {}),
      };
      if (ok) end(P, O, 'done');
      else fail(P, O, body.round, summary);
      // The offer as the report leaves it: the executor holds it before it ends its claim.
      return { body: { offer: P.pool.get(offerKey(O.taskId, host.self)) } };
    },
  };

  // Asks the executor for its next lease and hands the answer to the pool.
  async function ping(P, O, claim) {
    // A lease hangs on the ping: it is sent whatever gossip makes of the executor.
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
    // An offer nobody could have signed again in time is in no pool any more: this host
    // was not running. Whether the work is still to do is for whoever offered it to say.
    if (now >= O.at + RECORD_RETENTION_SECS) return end(P, O, 'cancelled', OUTLIVED);
    const mine = P.pool.get(offerKey(taskId, host.self));
    if (!mine || now - mine.at >= RESIGN_INTERVAL_MS / 1000) publish(P, O);

    rest(O, claim, now);
    const watched = O.watch;
    if (watched && watched.round !== claim?.round) {
      O.watch = null;
      const held = P.pool.get(claimKey(taskId, watched.executor));
      const same = held?.round === watched.round;
      // The hold ran out with no word of how the run ended: the lease lapsed, or the run
      // outlived the hours this host gave it.
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
      // `since` is when this host first saw the claim hold its offer; a claim past its
      // first lease was `extended` for a host that backs it; `keyed` is whether it has
      // this host's key, noted here because a later claim's may replace the key before
      // this host looks again.
      O.watch = {
        round: claim.round, executor: claim.executor, since: watched?.round === claim.round ? watched.since : now,
        extended: claim.seq > 0, keyed: issued[taskId]?.round === claim.round, lapses: heldUntil(claim, backing(claim, host.self)),
      };
      O.ran = claim.executor;
    }
    // A claim whose run said how it ended holds the offer until its executor ends it,
    // and is nothing this host waits for.
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
    // This host asks for the next lease of a run that has its key, and of no other.
    if (claim && issued[taskId]?.round === claim.round && pingDue(claim, backing(claim, host.self), now) && O.pinged + RETRY_MS / 1000 <= now) {
      O.pinged = now;
      ping(P, O, claim).catch((err) => host.log(`a ping failed: ${err?.stack ?? err}`));
    }
    return undefined;
  }

  // An open offer record of this host with no open offer behind it is one that ended
  // while a member could not hear, handed back by that member: it is ended for the pool.
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

  /// What came due for every offer: a record to sign again, a claim that ended or lapsed
  /// to count, a key to revoke, a ping to send. An ended offer is forgotten a day
  /// after it ended, and a record that still says it is open is ended. The offers of a
  /// pool wait while what this host holds of it is not up to date.
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

  /// Cancels every open offer in a pool, for `reason`; the keys of the records signed.
  function closing(P, reason) {
    const keys = [];
    for (const O of Object.values(offers)) {
      if (O.pool !== P.id || !OPEN.includes(O.state)) continue;
      end(P, O, 'cancelled', reason);
      keys.push(offerKey(O.taskId, host.self));
    }
    return keys;
  }

  /// Does this host want to run that task of its own at once?
  const atOnce = (taskId) => offers[taskId]?.now === true && offers[taskId].state === 'pooled';

  /// Does `pk` hold an unexpired key of this host?
  function keyHeldBy(pk) {
    const now = host.now();
    return Object.values(issued).some((K) => K.capability.executor === pk && now < K.capability.exp);
  }

  /// The offers as the snapshot lists them. Of one that waits in the pool a row says what
  /// keeps this host from running it itself: `leftUntil`, until when the host leaves the
  /// task to the others, having failed at it or given it back, or 0; `leftForGood`, that
  /// its operator stopped a run of it here; `tooLong`, that it needs more hours than
  /// this host accepts.
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
