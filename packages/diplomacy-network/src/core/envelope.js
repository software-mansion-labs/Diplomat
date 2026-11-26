import { b64u, hash, unb64u } from './canon.js';
import { sign, validPk, verify } from './identity.js';
import { challenge, check, epochAcceptable, epochOf, solveAsync, validEffort } from './pow.js';
import { isBytes, isObject, isTime, shaped, validPool } from './records.js';
import { CLOCK_SKEW_SECS, MAX_ACT_BODY_BYTES, MAX_BODY_BYTES } from '../paths.js';

export const KINDS = ['hello', 'sync', 'pull', 'push', 'lock', 'unlock', 'ping', 'key', 'act', 'done', 'reserve'];
export const CODES = ['effort', 'stale', 'replay', 'not-member', 'bad-request', 'denied', 'busy'];
/// The `busy` detail promising nothing was done, so the sender may resend even an `act`.
export const UNSERVED = 'dated before this host last started: send it again';
const MAX_DETAIL = 200;

const REQUEST = {
  v: (v) => v === 1, pool: validPool, kind: (v) => KINDS.includes(v), from: validPk, to: validPk, ts: isTime,
  body: isObject,
  pow: (p) => shaped(p, { epoch: isTime, nonce: (v) => isBytes(v, 16), effort: validEffort, counter: (v) => isBytes(v, 8) }),
  sig: (v) => isBytes(v, 64),
};

function challengeOf({ v, pool, kind, from, to, ts, body }, { epoch, nonce, effort }) {
  try {
    const coreHash = hash({ v, pool, kind, from, to, ts, body });
    return challenge({ to: unb64u(to), from: unb64u(from), epoch, nonce, effort, coreHash });
  } catch {
    return null;
  }
}

/// The `re` a response names its request by.
export function requestDigest(request) {
  try {
    return b64u(hash(request));
  } catch {
    return null;
  }
}

const UNPAID = 'the work or the signature of this request does not hold';

/// `solver(challenge, effort)` returns the 8-byte counter, or a promise of it.
export async function buildRequest(identity, { pool, kind, to, ts, body, nonce, effort }, solver = solveAsync) {
  const core = { v: 1, pool, kind, from: identity.pk, to, ts, body };
  const pow = { epoch: epochOf(ts), nonce: b64u(nonce ?? ''), effort, counter: b64u(Buffer.alloc(8)) };
  const c = shaped({ ...core, pow, sig: b64u(Buffer.alloc(64)) }, REQUEST) ? challengeOf(core, { ...pow, nonce }) : null;
  if (!c) throw new TypeError('not a well-formed request');
  const envelope = { ...core, pow: { ...pow, counter: b64u(await solver(c, effort)) } };
  return { ...envelope, sig: sign(identity, 'dn1/req', envelope) };
}

/// Accepted `(from, nonce)` pairs, forgotten with their epoch: a request is accepted only
/// within clock skew of its `ts`, so no pair is forgotten while it could still replay.
export class ReplayMemory {
  #epochs = new Map();

  /// Also remembers the pair when it is new.
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

  get size() {
    let n = 0;
    for (const pairs of this.#epochs.values()) n += pairs.size;
    return n;
  }
}

/// Checks run cheapest first (PROTOCOL.md section 3, Verification order). Until work and
/// signature hold, neither the refusal nor what the target does depends on the key named:
/// bad work and a bad signature are refused alike at a stranger's price, the signature is checked
/// for any work at `meter.least`, and membership is asked only once the signature holds.
///
/// `size` is the length in bytes as received. `meter` and `replay` are updated: an
/// authenticated request counts toward its sender, any other whose work holds at a
/// stranger's price toward the strangers. `tally.signatures` counts signature checks.
export function verifyRequest(request, { self, now, size, meter, replay, isMember, tally }) {
  const re = requestDigest(request);
  const refuse = (code, detail) => ({ ok: false, code, detail, re, effort: meter.required(null, false, now) });
  const shapely = re !== null && shaped(request, REQUEST)
    && size <= (request.kind === 'act' ? MAX_ACT_BODY_BYTES : MAX_BODY_BYTES);
  if (!shapely) return refuse('bad-request', 'not a request envelope');
  const { from, pool, pow } = request;
  if (request.to !== self) return refuse('bad-request', 'addressed to another host');
  if (Math.abs(request.ts - now) > CLOCK_SKEW_SECS) return refuse('stale', 'ts is too far from this clock');
  if (pow.epoch !== epochOf(request.ts)) return refuse('stale', 'epoch is not the one ts falls in');
  const c = challengeOf(request, { epoch: pow.epoch, nonce: unb64u(pow.nonce), effort: pow.effort });
  const worked = pow.effort >= meter.least && check(c, pow.effort, unb64u(pow.counter));
  if (worked && tally) tally.signatures += 1;
  const sender = worked && verify(from, 'dn1/req', request);
  const member = sender && Boolean(isMember(pool, from));
  const signed = sender && pow.effort >= meter.required(from, member, now);
  if (signed) meter.count(from, member, now);
  else if (worked && pow.effort >= meter.required(null, false, now)) meter.count(null, false, now);
  if (!signed) return refuse('effort', UNPAID);
  const effort = meter.required(from, member, now);
  if (replay.seen(from, pow.nonce, pow.epoch, now)) return { ok: false, code: 'replay', detail: 'nonce already used', re, effort };
  return { ok: true, request, member, re, effort };
}

const RESPONSE = { v: (v) => v === 1, re: (v) => isBytes(v, 32), effort: validEffort, sig: (v) => isBytes(v, 64) };
const ERROR = {
  code: (v) => CODES.includes(v),
  detail: (v) => typeof v === 'string' && v.length <= MAX_DETAIL,
};

/// `effort`: what the sender's next request owes.
export function buildResponse(identity, { re, body, error, effort }) {
  const response = error
    ? { v: 1, ok: false, re, error: { code: error.code, detail: String(error.detail ?? '').slice(0, MAX_DETAIL) }, effort }
    : { v: 1, ok: true, re, body, effort };
  return { ...response, sig: sign(identity, 'dn1/res', response) };
}

export function verifyResponse(response, { request, from }) {
  const answer = shaped(response, { ...RESPONSE, ok: (v) => v === true, body: isObject });
  const refusal = shaped(response, { ...RESPONSE, ok: (v) => v === false, error: (e) => shaped(e, ERROR) });
  if (!answer && !refusal) return null;
  if (response.re !== requestDigest(request) || !verify(from, 'dn1/res', response)) return null;
  const { effort } = response;
  return answer ? { ok: true, body: response.body, effort } : { ok: false, ...response.error, effort };
}
