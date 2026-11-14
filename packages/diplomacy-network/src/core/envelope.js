// The request and response envelopes (PROTOCOL.md sections 3 and 4): building a request
// with its proof of work, the checks a target runs on one, cheapest first, and the signed
// answer bound to the request it answers.

import { b64u, hash, unb64u } from './canon.js';
import { sign, validPk, verify } from './identity.js';
import { challenge, check, epochAcceptable, epochOf, solveAsync, validEffort } from './pow.js';
import { isBytes, isObject, isTime, shaped, validPool } from './records.js';
import { CLOCK_SKEW_SECS, MAX_ACT_BODY_BYTES, MAX_BODY_BYTES } from '../paths.js';

export const KINDS = ['hello', 'sync', 'pull', 'push', 'lock', 'unlock', 'ping', 'key', 'act', 'done'];
export const CODES = ['effort', 'stale', 'replay', 'unknown-pool', 'not-member', 'bad-request', 'denied', 'busy'];
const MAX_DETAIL = 200;

const REQUEST = {
  v: (v) => v === 1, pool: validPool, kind: (v) => KINDS.includes(v), from: validPk, to: validPk, ts: isTime,
  body: isObject,
  pow: (p) => shaped(p, { epoch: isTime, nonce: (v) => isBytes(v, 16), effort: validEffort, counter: (v) => isBytes(v, 8) }),
  sig: (v) => isBytes(v, 64),
};

// The challenge an envelope's proof of work answers, or null when its core has no
// canonical form.
function challengeOf({ v, pool, kind, from, to, ts, body }, { epoch, nonce, effort }) {
  try {
    const coreHash = hash({ v, pool, kind, from, to, ts, body });
    return challenge({ to: unb64u(to), from: unb64u(from), epoch, nonce, effort, coreHash });
  } catch {
    return null;
  }
}

/// `H(canon(request))` in base64url, which a response names its request by, or null when
/// the request has no canonical form.
export function requestDigest(request) {
  try {
    return b64u(hash(request));
  } catch {
    return null;
  }
}

/// A signed request envelope from `identity` to `to`, its proof of work solved at
/// `effort`. `nonce` is 16 fresh random bytes; `solver(challenge, effort)` returns the
/// 8-byte counter or a promise of it. Throws when a part is malformed.
export async function buildRequest(identity, { pool, kind, to, ts, body, nonce, effort }, solver = solveAsync) {
  const core = { v: 1, pool, kind, from: identity.pk, to, ts, body };
  const pow = { epoch: epochOf(ts), nonce: b64u(nonce ?? ''), effort, counter: b64u(Buffer.alloc(8)) };
  const c = shaped({ ...core, pow, sig: b64u(Buffer.alloc(64)) }, REQUEST) ? challengeOf(core, { ...pow, nonce }) : null;
  if (!c) throw new TypeError('not a well-formed request');
  const envelope = { ...core, pow: { ...pow, counter: b64u(await solver(c, effort)) } };
  return { ...envelope, sig: sign(identity, 'dn1/req', envelope) };
}

/// The `(from, nonce)` pairs a target accepted, kept for as long as their epoch stays
/// acceptable: three epochs at most. A request outlives its `ts` by the clock tolerance
/// only, so no pair is forgotten while its request could still be accepted.
export class ReplayMemory {
  #epochs = new Map(); // epoch -> Set of "from nonce"

  /// Has this pair been accepted before? When not, it is remembered under `epoch`.
  seen(from, nonce, epoch, now) {
    for (const old of this.#epochs.keys()) {
      if (!epochAcceptable(old, now)) this.#epochs.delete(old);
    }
    const pair = `${from} ${nonce}`;
    for (const pairs of this.#epochs.values()) {
      if (pairs.has(pair)) return true;
    }
    if (!this.#epochs.has(epoch)) this.#epochs.set(epoch, new Set());
    this.#epochs.get(epoch).add(pair);
    return false;
  }

  /// How many pairs are remembered.
  get size() {
    let n = 0;
    for (const pairs of this.#epochs.values()) n += pairs.size;
    return n;
  }
}

/// Checks a request a target received, cheapest check first, stopping at the first that
/// fails: shape and size, `to`, `ts`, the epoch, the effort owed, the solution, the
/// signature, the replay memory. Answers `{ ok: true, request, member, re, effort }`, or
/// `{ ok: false, code, detail, re, effort }` with `bad-request`, `stale`, `effort`,
/// `denied` or `replay`. `effort` is what the sender's next request owes; `re` is null
/// when the request has no canonical form.
///
/// `self` is the target's key, `size` the request's length in bytes as received,
/// `isMember(pool, pk)` whether the target accepts that key in that pool. `meter` and
/// `replay` are the target's own and are updated: a request that passed its signature
/// counts toward its sender, any other toward the strangers. `tally`, when given, has its
/// `signatures` raised by one for a request that got as far as its signature check.
export function verifyRequest(request, { self, now, size, meter, replay, isMember, tally }) {
  const re = requestDigest(request);
  const shapely = re !== null && shaped(request, REQUEST)
    && size <= (request.kind === 'act' ? MAX_ACT_BODY_BYTES : MAX_BODY_BYTES);
  if (!shapely) {
    meter.countFailure(now);
    return { ok: false, code: 'bad-request', detail: 'not a request envelope', re, effort: meter.required(null, false, now) };
  }
  const { from, pool, pow } = request;
  const member = Boolean(isMember(pool, from));
  const refuse = (code, detail) => {
    meter.countFailure(now);
    return { ok: false, code, detail, re, effort: meter.required(from, member, now) };
  };
  if (request.to !== self) return refuse('bad-request', 'addressed to another host');
  if (Math.abs(request.ts - now) > CLOCK_SKEW_SECS) return refuse('stale', 'ts is too far from this clock');
  if (pow.epoch !== epochOf(request.ts)) return refuse('stale', 'epoch is not the one ts falls in');
  const owed = meter.required(from, member, now);
  if (pow.effort < owed) return refuse('effort', `this request owes ${owed}`);
  const c = challengeOf(request, { epoch: pow.epoch, nonce: unb64u(pow.nonce), effort: pow.effort });
  if (!check(c, pow.effort, unb64u(pow.counter))) return refuse('bad-request', 'the proof of work does not solve its challenge');
  if (tally) tally.signatures += 1;
  if (!verify(from, 'dn1/req', request)) return refuse('denied', 'bad signature');
  meter.count(from, member, now);
  const effort = meter.required(from, member, now);
  if (replay.seen(from, pow.nonce, pow.epoch, now)) return { ok: false, code: 'replay', detail: 'nonce already used', re, effort };
  return { ok: true, request, member, re, effort };
}

const RESPONSE = { v: (v) => v === 1, re: (v) => isBytes(v, 32), effort: validEffort, sig: (v) => isBytes(v, 64) };
const ERROR = {
  code: (v) => CODES.includes(v),
  detail: (v) => typeof v === 'string' && v.length <= MAX_DETAIL,
};

/// A signed response to the request named by `re`: `body` for an answer, or
/// `error: { code, detail }` for a refusal. `effort` is what the sender's next request owes.
export function buildResponse(identity, { re, body, error, effort }) {
  const response = error
    ? { v: 1, ok: false, re, error: { code: error.code, detail: String(error.detail ?? '').slice(0, MAX_DETAIL) }, effort }
    : { v: 1, ok: true, re, body, effort };
  return { ...response, sig: sign(identity, 'dn1/res', response) };
}

/// What `from` answered `request` with: `{ ok: true, body, effort }` or
/// `{ ok: false, code, detail, effort }`. Null when the response is malformed, not signed
/// by `from`, or answers another request.
export function verifyResponse(response, { request, from }) {
  const answer = shaped(response, { ...RESPONSE, ok: (v) => v === true, body: isObject });
  const refusal = shaped(response, { ...RESPONSE, ok: (v) => v === false, error: (e) => shaped(e, ERROR) });
  if (!answer && !refusal) return null;
  if (response.re !== requestDigest(request) || !verify(from, 'dn1/res', response)) return null;
  const { effort } = response;
  return answer ? { ok: true, body: response.body, effort } : { ok: false, ...response.error, effort };
}
