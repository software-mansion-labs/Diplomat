// Acting as the requester (PROTOCOL.md sections 9 and 10): the capability a requester
// hands the executor of its task, the MAC and sequence number on every request made
// under it, and the rules that say which forge requests it covers.
//
// A forge reads a request more leniently than a rule is written: it resolves "..",
// decodes escapes, takes the last or the first of two equal members. So a request that
// could be read two ways matches no rule at all.

import crypto from 'node:crypto';
import { b64u, canon, unb64u } from './canon.js';
import { sign, validPk, verify } from './identity.js';
import { isBytes, isObject, isTime, parseTaskId, shaped, validPool } from './records.js';
import { LEASE_GRACE_SECS } from '../paths.js';

const MAX_RULES = 128;
const MAX_PINS = 32;
const MAX_PATH = 8192;
const MAX_HEADERS = 64;
const HOST = /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/;
const METHOD = /^[A-Z]{1,16}$/;
const HEADER_NAME = /^[a-z0-9-]{1,64}$/;
const PRINTABLE = /^[\x20-\x7e]*$/;
// A path and its query: visible ASCII, and no fragment, which never reaches a forge.
const URL_CHARS = /^[\x21\x22\x24-\x7e]+$/;
const SEGMENT = /^(?:[A-Za-z0-9._~!$&'()*+,;=:@-]|%[0-9A-Fa-f]{2})+$/;
// What no path segment may decode to: a separator, or a character a forge may strip.
const UNSAFE = /[/\\\u0000-\u001f\u007f]/;

const scalar = (v) => typeof v === 'string' || typeof v === 'boolean' || Number.isSafeInteger(v);
const canonical = (v) => {
  try {
    canon(v);
    return true;
  } catch {
    return false;
  }
};
const pin = (p) => shaped(p, {}, {
  equals: scalar, in: (v) => Array.isArray(v) && v.length <= MAX_PINS && v.every(scalar),
  contains: (v) => typeof v === 'string', required: (v) => typeof v === 'boolean',
});
const pins = (v) => isObject(v) && Object.keys(v).length <= MAX_PINS && Object.values(v).every(pin);
const pattern = (v) => {
  if (typeof v !== 'string' || v.length > MAX_PATH || !v.startsWith('/')) return false;
  if (v === '/') return true;
  const parts = v.slice(1).split('/');
  return parts.every((p, i) => p !== '' && p !== '.' && p !== '..' && (p !== '**' || i === parts.length - 1));
};

/// Is this a well-formed rule? The inner shape of its `graphql`, `git` and `refs`
/// members belongs to the checks that read them.
export function validRule(rule) {
  const text = (re) => (v) => typeof v === 'string' && re.test(v);
  return shaped(rule, { host: text(HOST), method: text(METHOD), path: pattern }, {
    query: pins, json: pins, graphql: canonical, git: canonical, refs: canonical,
  });
}

const FORGE_REQUEST = {
  host: (v) => typeof v === 'string' && HOST.test(v),
  method: (v) => typeof v === 'string' && METHOD.test(v),
  path: (v) => typeof v === 'string' && v.length <= MAX_PATH && v.startsWith('/') && URL_CHARS.test(v),
  headers: (h) => isObject(h) && Object.keys(h).length <= MAX_HEADERS
    && Object.entries(h).every(([k, v]) => HEADER_NAME.test(k) && typeof v === 'string' && v.length <= MAX_PATH && PRINTABLE.test(v)),
  body: (v) => unb64u(v) !== null,
};

/// Is this a well-formed forge request: `{ host, method, path, headers, body }`, the body
/// in base64url?
export function validForgeRequest(request) {
  return shaped(request, FORGE_REQUEST);
}

// The decoded segments and the raw query of a request path, or null when a forge could
// read the path as another one: an empty, "." or ".." segment, an escaped separator, a
// fragment, a character outside the URL alphabet.
function splitPath(path) {
  const mark = path.indexOf('?');
  const [raw, query] = mark === -1 ? [path, ''] : [path.slice(0, mark), path.slice(mark + 1)];
  if (raw === '/') return { segments: [], query };
  const segments = [];
  for (const part of raw.slice(1).split('/')) {
    if (!SEGMENT.test(part)) return null;
    let segment;
    try {
      segment = decodeURIComponent(part);
    } catch {
      return null;
    }
    if (segment === '.' || segment === '..' || UNSAFE.test(segment)) return null;
    segments.push(segment);
  }
  return { segments, query };
}

function pathMatches(rulePath, segments) {
  const parts = rulePath === '/' ? [] : rulePath.slice(1).split('/');
  for (const [i, part] of parts.entries()) {
    if (part === '**') return true;
    if (i >= segments.length) return false;
    if (part !== '*' && part !== segments[i]) return false;
  }
  return parts.length === segments.length;
}

function satisfies(p, value) {
  if (Object.hasOwn(p, 'equals') && value !== p.equals) return false;
  if (Object.hasOwn(p, 'in') && !p.in.includes(value)) return false;
  if (Object.hasOwn(p, 'contains') && !(typeof value === 'string' && value.includes(p.contains))) return false;
  return true;
}

// A pinned member that is present must satisfy its pin; an absent one passes unless the
// pin requires it. `values` maps each name to every value it was given.
function pinsHold(wanted, values) {
  return Object.entries(wanted).every(([name, p]) => {
    const given = values.get(name) ?? [];
    if (given.length === 0) return p.required !== true;
    return given.length === 1 && satisfies(p, given[0]);
  });
}

function queryValues(query) {
  const values = new Map();
  for (const pair of query.split('&')) {
    if (pair === '') continue;
    const eq = pair.indexOf('=');
    const [name, value] = (eq === -1 ? [pair, ''] : [pair.slice(0, eq), pair.slice(eq + 1)])
      .map((s) => decodeURIComponent(s.replaceAll('+', ' ')));
    values.set(name, [...(values.get(name) ?? []), value]);
  }
  return values;
}

// The names of the members of a JSON object, as often as each is written. `text` has
// already parsed as an object, so only strings and brackets need telling apart.
function memberNames(text) {
  const names = [];
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '{' || ch === '[') depth += 1;
    else if (ch === '}' || ch === ']') depth -= 1;
    else if (ch === '"') {
      let end = i + 1;
      while (text[end] !== '"') end += text[end] === '\\' ? 2 : 1;
      let next = end + 1;
      while (' \t\n\r'.includes(text[next])) next += 1;
      if (depth === 1 && text[next] === ':') names.push(JSON.parse(text.slice(i, end + 1)));
      i = end;
    }
  }
  return names;
}

// The members of a JSON request body, each name mapped to its values, or null when the
// body is not sent as JSON or is not one JSON object.
function jsonValues(request) {
  if (!/^application\/json\s*(;.*)?$/i.test(request.headers['content-type'] ?? '')) return null;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(unb64u(request.body));
    const parsed = JSON.parse(text);
    if (!isObject(parsed)) return null;
    const values = new Map();
    for (const name of memberNames(text)) values.set(name, [...(values.get(name) ?? []), parsed[name]]);
    return values;
  } catch {
    return null;
  }
}

function ruleCovers(rule, request, path) {
  if (rule.host !== request.host || rule.method !== request.method || !pathMatches(rule.path, path.segments)) return false;
  try {
    if (rule.query && !pinsHold(rule.query, queryValues(path.query))) return false;
  } catch {
    return false;
  }
  if (!rule.json) return true;
  const values = jsonValues(request);
  return values !== null && pinsHold(rule.json, values);
}

/// What `rules` say about a forge request: `{ verdict: 'allow', rule }` when a rule
/// covers it outright; `{ verdict: 'deep', rules }` when only rules carrying a `graphql`
/// or `git` member cover its host, method, path and pins, so their own check must decide;
/// `{ verdict: 'deny' }` otherwise, which is also the answer to a malformed request or
/// rule and to a path a forge could read as another one.
export function matchRules(rules, request) {
  const path = validForgeRequest(request) ? splitPath(request.path) : null;
  if (!path || !Array.isArray(rules)) return { verdict: 'deny' };
  const covering = rules.filter((rule) => validRule(rule) && ruleCovers(rule, request, path));
  const plain = covering.find((rule) => !Object.hasOwn(rule, 'graphql') && !Object.hasOwn(rule, 'git'));
  if (plain) return { verdict: 'allow', rule: plain };
  return covering.length > 0 ? { verdict: 'deep', rules: covering } : { verdict: 'deny' };
}

const CAPABILITY = {
  keyId: (v) => isBytes(v, 16), pool: validPool, taskId: (v) => parseTaskId(v) !== null, executor: validPk,
  host: validPk, rules: (v) => Array.isArray(v) && v.length <= MAX_RULES && v.every(validRule), exp: isTime,
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
/// at `now`; `seq` is new; the MAC matches; a rule covers the request. Answers
/// `{ ok: true, verdict, rule?, rules? }` as `matchRules` does, or
/// `{ ok: false, code, detail }` with `bad-request` or `denied`. `seqs` is the host's
/// SeqTracker: a request whose MAC matched has used its number, covered or not. Whether
/// the key is revoked and the claim still active is the caller's to check first.
export function checkAct(body, { capability, secret, seqs, from, now }) {
  if (!shaped(body, ACT)) return { ok: false, code: 'bad-request', detail: 'not an act body' };
  const deny = (detail) => ({ ok: false, code: 'denied', detail });
  if (from !== capability.executor || body.keyId !== capability.keyId || body.taskId !== capability.taskId) return deny('not this key');
  if (now >= capability.exp) return deny('key expired');
  if (!seqs.isNew(body.keyId, body.seq)) return deny('seq is not new');
  const mac = unb64u(actMac(secret, body));
  if (!crypto.timingSafeEqual(mac, unb64u(body.mac))) return deny('bad mac');
  seqs.use(body.keyId, body.seq);
  const match = matchRules(capability.rules, body.request);
  return match.verdict === 'deny' ? deny('no rule covers the request') : { ok: true, ...match };
}
