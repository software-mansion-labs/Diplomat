// Whether a rule covers a request is decided in src/requester/.

import crypto from 'node:crypto';
import { b64u, canon, hash, unb64u } from './canon.js';
import { sign, validPk, verify } from './identity.js';
import { heldUntil, speaksFor } from './lease.js';
import { isBytes, isObject, isTime, parseTaskId, shaped, validPool } from './records.js';

const MAX_RULES = 128;
const MAX_PATH = 8192;
const MAX_HEADERS = 64;
const HOST = /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/;
const METHOD = /^[A-Z]{1,16}$/;
const HEADER_NAME = /^[a-z0-9-]{1,64}$/;
const PRINTABLE = /^[\x20-\x7e]*$/;
// Visible ASCII but `#`: a fragment never reaches a forge.
const URL_CHARS = /^[\x21\x22\x24-\x7e]+$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

// The rest of a rule's shape belongs to its reader.
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

export function validForgeRequest(request) {
  return shaped(request, FORGE_REQUEST);
}

const CAPABILITY = {
  keyId: (v) => isBytes(v, 16), pool: validPool, taskId: (v) => parseTaskId(v) !== null, executor: validPk,
  host: validPk, rules: (v) => Array.isArray(v) && v.length <= MAX_RULES && v.every(ruleShaped), exp: isTime,
  sig: (v) => isBytes(v, 64),
};

export function capabilityExp(claim, backed) {
  return heldUntil(claim, backed);
}

export function buildCapability(identity, { keyId, pool, taskId, executor, rules, exp }) {
  const capability = { keyId: b64u(keyId), pool, taskId, executor, host: identity.pk, rules, exp };
  return { ...capability, sig: sign(identity, 'dn1/cap', capability) };
}

export function verifyCapability(capability, expect, now) {
  const fine = shaped(capability, CAPABILITY) && parseTaskId(capability.taskId).pool === capability.pool
    && Object.keys(expect).every((k) => capability[k] === expect[k]) && verify(capability.host, 'dn1/cap', capability);
  if (!fine) return { ok: false, code: 'bad-capability' };
  return now < capability.exp ? { ok: true } : { ok: false, code: 'expired' };
}

/// `secret`: 32 raw bytes.
export function macOf(secret, value) {
  return b64u(crypto.createHmac('sha256', secret).update(canon(value)).digest());
}

export function actMac(secret, { keyId, seq, request }) {
  return macOf(secret, { keyId, seq, request });
}

export class SeqTracker {
  #last = new Map();

  constructor(entries = []) {
    this.#last = new Map(entries);
  }

  entries() {
    return [...this.#last];
  }

  isNew(keyId, seq) {
    return seq > (this.#last.get(keyId) ?? -1);
  }

  use(keyId, seq) {
    if (!this.isNew(keyId, seq)) return false;
    this.#last.set(keyId, seq);
    return true;
  }

  forget(keyId) {
    this.#last.delete(keyId);
  }
}

const ACT = {
  taskId: (v) => parseTaskId(v) !== null, keyId: (v) => isBytes(v, 16), seq: isTime, request: validForgeRequest,
  mac: (v) => isBytes(v, 32),
};

/// A matching MAC uses up `seq`, whatever the rules then say. Revocation, the claim being
/// active and rule coverage are the caller's to check.
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
  taskId: (v) => parseTaskId(v) !== null, round: (v) => isBytes(v, 8), spec: (v) => isBytes(v, 32),
  outcome: (v) => shaped(v, OUTCOME, { capped: (c) => typeof c === 'boolean' }),
};

export function specDigest(spec) {
  try {
    return b64u(hash(spec));
  } catch {
    return null;
  }
}

/// `capped`: the executor lowered the tokens or cost its job reported.
export function wireOutcome({ ok, summary, usd, tokens, runner, model, capped } = {}) {
  const whole = (v) => (Number.isFinite(v) && v > 0 ? Math.min(Math.round(v), Number.MAX_SAFE_INTEGER) : 0);
  const cut = (v, max) => String(v ?? '').toWellFormed().slice(0, max);
  return {
    ok: ok === true, summary: cut(summary, MAX_SUMMARY), microUsd: whole(usd * 1e6), tokens: whole(tokens),
    runner: cut(runner, MAX_LABEL), model: cut(model, MAX_LABEL), ...(capped === true ? { capped } : {}),
  };
}

/// No key or MAC: an offering host that issued no key must be able to check it too.
export function checkDone(body, { claim, from, now }) {
  if (!shaped(body, DONE)) return { ok: false, code: 'bad-request', detail: 'not a done body' };
  if (claim?.taskId !== body.taskId || !speaksFor(claim, { from, round: body.round, now })) {
    return { ok: false, code: 'denied', detail: 'not the executor of this task' };
  }
  return { ok: true };
}
