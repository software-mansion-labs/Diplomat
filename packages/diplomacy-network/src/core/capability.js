// Acting as the requester (PROTOCOL.md section 9): the capability a requester hands the
// executor of its task, and the MAC and sequence number on every request made under it.
// Whether a rule covers a request is decided where the rules are written and read:
// src/requester/.

import crypto from 'node:crypto';
import { b64u, canon, unb64u } from './canon.js';
import { sign, validPk, verify } from './identity.js';
import { speaksFor } from './lease.js';
import { isBytes, isObject, isTime, parseTaskId, shaped, validPool } from './records.js';
import { LEASE_GRACE_SECS } from '../paths.js';

const MAX_RULES = 128;
const MAX_PATH = 8192;
const MAX_HEADERS = 64;
const HOST = /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/;
const METHOD = /^[A-Z]{1,16}$/;
const HEADER_NAME = /^[a-z0-9-]{1,64}$/;
const PRINTABLE = /^[\x20-\x7e]*$/;
// A path and its query: visible ASCII, and no fragment, which never reaches a forge.
const URL_CHARS = /^[\x21\x22\x24-\x7e]+$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

// A rule as a capability carries it: something with a canonical form that names the
// host, method and path it is about. The rest of its shape belongs to its reader.
function ruleShaped(rule) {
  if (!isObject(rule) || ![rule.host, rule.method, rule.path].every((v) => typeof v === 'string')) return false;
  try {
    canon(rule);
    return true;
  } catch {
    return false;
  }
}

const FORGE_REQUEST = {
  host: (v) => typeof v === 'string' && HOST.test(v),
  method: (v) => typeof v === 'string' && METHOD.test(v),
  path: (v) => typeof v === 'string' && v.length <= MAX_PATH && v.startsWith('/') && URL_CHARS.test(v),
  headers: (h) => isObject(h) && Object.keys(h).length <= MAX_HEADERS
    && Object.entries(h).every(([k, v]) => HEADER_NAME.test(k) && typeof v === 'string' && v.length <= MAX_PATH && PRINTABLE.test(v)),
  body: (v) => typeof v === 'string' && BASE64.test(v),
};

/// Is this a well-formed forge request: `{ host, method, path, headers, body }`, the body
/// in padded base64?
export function validForgeRequest(request) {
  return shaped(request, FORGE_REQUEST);
}

const CAPABILITY = {
  keyId: (v) => isBytes(v, 16), pool: validPool, taskId: (v) => parseTaskId(v) !== null, executor: validPk,
  host: validPk, rules: (v) => Array.isArray(v) && v.length <= MAX_RULES && v.every(ruleShaped), exp: isTime,
  sig: (v) => isBytes(v, 64),
};

/// When a capability for this claim expires: with the claim's lease and grace.
export function capabilityExp(claim) {
  return claim.leaseUntil + LEASE_GRACE_SECS;
}

/// A capability signed by the issuing host: `executor` may make the requests `rules`
/// cover for `taskId` until `exp`. `keyId` is 16 random bytes.
export function buildCapability(identity, { keyId, pool, taskId, executor, rules, exp }) {
  const capability = { keyId: b64u(keyId), pool, taskId, executor, host: identity.pk, rules, exp };
  return { ...capability, sig: sign(identity, 'dn1/cap', capability) };
}

/// `{ ok: true }` for a well-formed capability signed by its host, carrying every member
/// of `expect` as given and unexpired at `now`; otherwise `{ ok: false, code }` with
/// `bad-capability` or `expired`.
export function verifyCapability(capability, expect, now) {
  const fine = shaped(capability, CAPABILITY) && parseTaskId(capability.taskId).pool === capability.pool
    && Object.keys(expect).every((k) => capability[k] === expect[k]) && verify(capability.host, 'dn1/cap', capability);
  if (!fine) return { ok: false, code: 'bad-capability' };
  return now < capability.exp ? { ok: true } : { ok: false, code: 'expired' };
}

/// `HMAC-SHA256(secret, canon(value))` in base64url. `secret` is the 32 raw bytes.
export function macOf(secret, value) {
  return b64u(crypto.createHmac('sha256', secret).update(canon(value)).digest());
}

/// The MAC of an `act` request: over `{ keyId, seq, request }`.
export function actMac(secret, { keyId, seq, request }) {
  return macOf(secret, { keyId, seq, request });
}

/// The last sequence number used under each key. A number is new only when it is
/// greater than every one before it.
export class SeqTracker {
  #last = new Map(); // keyId -> seq

  /// A tracker holding `entries`, as `entries()` returned them.
  constructor(entries = []) {
    this.#last = new Map(entries);
  }

  /// `[keyId, seq]` for every key, to store or restore.
  entries() {
    return [...this.#last];
  }

  /// Is `seq` greater than every number used under `keyId`?
  isNew(keyId, seq) {
    return seq > (this.#last.get(keyId) ?? -1);
  }

  /// Uses `seq` under `keyId`. False, with nothing changed, when it is not new.
  use(keyId, seq) {
    if (!this.isNew(keyId, seq)) return false;
    this.#last.set(keyId, seq);
    return true;
  }

  /// Forgets a key: it is revoked or expired.
  forget(keyId) {
    this.#last.delete(keyId);
  }
}

const ACT = {
  taskId: (v) => parseTaskId(v) !== null, keyId: (v) => isBytes(v, 16), seq: isTime, request: validForgeRequest,
  mac: (v) => isBytes(v, 32),
};

/// The issuing host's checks on the body of an `act` request from `from`, in order: the
/// sender is the capability's executor and names its key and task; the key is unexpired
/// at `now`; `seq` is new; the MAC matches. Answers `{ ok: true }`, or
/// `{ ok: false, code, detail }` with `bad-request` or `denied`. `seqs` is the host's
/// SeqTracker: a request whose MAC matched has used its number, whatever the rules then
/// say of it. Whether the key is revoked, the claim still active and the request covered
/// by a rule is the caller's to check.
export function checkAct(body, { capability, secret, seqs, from, now }) {
  if (!shaped(body, ACT)) return { ok: false, code: 'bad-request', detail: 'not an act body' };
  const deny = (detail) => ({ ok: false, code: 'denied', detail });
  if (from !== capability.executor || body.keyId !== capability.keyId || body.taskId !== capability.taskId) return deny('not this key');
  if (now >= capability.exp) return deny('key expired');
  if (!seqs.isNew(body.keyId, body.seq)) return deny('seq is not new');
  const mac = unb64u(actMac(secret, body));
  if (!crypto.timingSafeEqual(mac, unb64u(body.mac))) return deny('bad mac');
  seqs.use(body.keyId, body.seq);
  return { ok: true };
}

const MAX_SUMMARY = 4000;
const MAX_LABEL = 100;
const count = (v) => Number.isSafeInteger(v) && v >= 0;
const text = (max) => (v) => typeof v === 'string' && v.length <= max && v.isWellFormed();
const OUTCOME = {
  ok: (v) => typeof v === 'boolean', summary: text(MAX_SUMMARY), microUsd: count, tokens: count,
  runner: text(MAX_LABEL), model: text(MAX_LABEL),
};
const DONE = {
  taskId: (v) => parseTaskId(v) !== null, round: (v) => isBytes(v, 8), outcome: (v) => shaped(v, OUTCOME),
};

/// The outcome of a run as a `done` request carries it: whole numbers only, the cost in
/// millionths of a dollar, every text cut to what the request allows.
export function wireOutcome({ ok, summary, usd, tokens, runner, model } = {}) {
  const whole = (v) => (Number.isFinite(v) && v > 0 ? Math.min(Math.round(v), Number.MAX_SAFE_INTEGER) : 0);
  const cut = (v, max) => String(v ?? '').toWellFormed().slice(0, max);
  return {
    ok: ok === true, summary: cut(summary, MAX_SUMMARY), microUsd: whole(usd * 1e6), tokens: whole(tokens),
    runner: cut(runner, MAX_LABEL), model: cut(model, MAX_LABEL),
  };
}

/// An offering host's checks on the body of a `done` request from `from`, the verified
/// sender of its envelope: the body is well-formed, and `from` speaks for the round it
/// names by `claim`, the claim record this host holds for the task (or null). No key and
/// no MAC is involved: an offering host that issued no key must be able to check it too.
/// Answers `{ ok: true }`, or `{ ok: false, code, detail }` with `bad-request` or `denied`.
export function checkDone(body, { claim, from, now }) {
  if (!shaped(body, DONE)) return { ok: false, code: 'bad-request', detail: 'not a done body' };
  if (claim?.taskId !== body.taskId || !speaksFor(claim, { from, round: body.round, now })) {
    return { ok: false, code: 'denied', detail: 'not the executor of this task' };
  }
  return { ok: true };
}
