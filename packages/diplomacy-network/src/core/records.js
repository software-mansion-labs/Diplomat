// The three records a pool's state is made of (PROTOCOL.md section 5): their exact
// shape, who signs each, the key each is stored under, and which of two versions of a
// member or an offer wins. Which of two versions of a claim wins is in claims.js.

import { b64u, hash, unb64u } from './canon.js';
import { sign, validPk, verify } from './identity.js';
import { HOURS_CEILING, HOURS_FLOOR } from '../paths.js';

// `members` is how many member records a pool holds; `offers`, `claims` and `bytes` are
// what one member may have live in a pool: the offers it signed, the claims it signed,
// and the canonical size of all its records together. `spare` is how much of `bytes` a
// host leaves free when it adds a record of its own, for the versions of its records
// that are longer than the ones they replace.
export const LIMITS = {
  pool: 200, taskId: 400, title: 300, invite: 1024, attempt: 255, list: 256, time: 2 ** 40,
  members: 256, offers: 64, claims: 64, bytes: 256 * 2 ** 10, spare: 32 * 2 ** 10,
};

const POOL = /^[a-z0-9][a-z0-9.-]*(\/[a-z0-9._-]+){2,}$/;
const KIND = /^[a-z][a-z0-9-]{0,31}$/;
const ITEM = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const IDENTITY = /^[a-z0-9][a-z0-9._-]{0,99}$/;
// C0 controls, DEL and the C1 controls: nothing a title needs, everything a terminal obeys.
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/// Is this a plain JSON object (not an array, not null, no foreign prototype)?
export function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
}

function isUint(v) {
  return Number.isSafeInteger(v) && v >= 0;
}

/// Is this a time or a sequence number: a non-negative integer small enough to add to?
export function isTime(v) {
  return isUint(v) && v <= LIMITS.time;
}

/// Is this the base64url of exactly `n` bytes?
export function isBytes(v, n) {
  return unb64u(v)?.length === n;
}

// A number of hours a task may take: a whole number from the floor to the ceiling.
const isHours = (v) => Number.isSafeInteger(v) && v >= HOURS_FLOOR && v <= HOURS_CEILING;

/// Is `value` a plain object holding every member of `required`, nothing outside
/// `required` and `optional`, and does each member pass its test?
export function shaped(value, required, optional = {}) {
  if (!isObject(value)) return false;
  for (const k of Object.keys(value)) {
    if (!Object.hasOwn(required, k) && !Object.hasOwn(optional, k)) return false;
  }
  for (const k of Object.keys(required)) {
    if (!Object.hasOwn(value, k) || !required[k](value[k])) return false;
  }
  for (const k of Object.keys(optional)) {
    if (Object.hasOwn(value, k) && !optional[k](value[k])) return false;
  }
  return true;
}

/// Is this a list of at most `max` distinct strings in ascending order, each passing `test`?
export function isAscending(v, test, max = LIMITS.list) {
  return Array.isArray(v) && v.length <= max && v.every((x, i) => test(x) && (i === 0 || v[i - 1] < x));
}

/// Is this a pool id: a lowercase forge slug, "host/owner/repo" or deeper?
export function validPool(id) {
  return typeof id === 'string' && id.length <= LIMITS.pool && POOL.test(id)
    && !id.split('/').some((segment) => /^\.+$/.test(segment));
}

/// The task id of an item worked on as a forge login, or null when a part is malformed.
export function buildTaskId({ pool, kind, item, identity }) {
  if (!validPool(pool) || !KIND.test(kind) || !ITEM.test(item) || !IDENTITY.test(identity)) return null;
  return `${pool}#${kind}:${item}@${identity}`;
}

/// `{ pool, kind, item, identity }` of a task id, or null when it is not one.
export function parseTaskId(taskId) {
  if (typeof taskId !== 'string' || taskId.length > LIMITS.taskId) return null;
  const m = /^([^#]+)#([^:]+):([^@]+)@(.+)$/.exec(taskId);
  if (!m) return null;
  const parts = { pool: m[1], kind: m[2], item: m[3], identity: m[4] };
  return buildTaskId(parts) === taskId ? parts : null;
}

const is = (literal) => (v) => v === literal;
const oneOf = (...values) => (v) => values.includes(v);
const bytes = (n) => (v) => isBytes(v, n);
const bool = (v) => typeof v === 'boolean';
const taskIn = (pool) => (v) => {
  const parts = parseTaskId(v);
  return parts !== null && parts.pool === pool;
};

// What a host that offers a task adds to its consent: the offer it made at `at` is the
// claim's, as the `gen`th the host gave that offer to, for `hours`.
const BACKING = { at: isTime, gen: isTime, hours: isHours };
const backingShaped = (v) => shaped(v, BACKING);
const GRANT = {
  pool: validPool, taskId: (v) => parseTaskId(v) !== null, executor: validPk, round: bytes(8),
  hash: bytes(32), by: validPk, exp: isTime, sig: bytes(64),
};
const PING = {
  pool: validPool, taskId: (v) => parseTaskId(v) !== null, executor: validPk, round: bytes(8), n: isTime,
  by: validPk, ts: isTime, sig: bytes(64),
};

/// Is this shaped like a grant (section 7)? Its signature and what it binds are not checked.
export function grantShaped(v) {
  return shaped(v, GRANT, { offer: backingShaped });
}

/// What `pk` backs a claim with - `{ at, gen, hours }`, its own word on its own offer of
/// the task - or null: the executor's is the claim's own `offer`, a member's the `offer`
/// of its grant.
export function backing(claim, pk) {
  return (pk === claim.executor ? claim.offer : claim.grants.find((grant) => grant.by === pk)?.offer) ?? null;
}

/// The hosts that back a claim, the executor first.
export function backers(claim) {
  return [...(claim.offer ? [claim.executor] : []), ...claim.grants.filter((grant) => grant.offer).map((grant) => grant.by)];
}

/// Is this shaped like a ping (section 8)? Its signature and what it binds are not checked.
export function pingShaped(v) {
  return shaped(v, PING);
}

const TYPES = {
  member: {
    signer: 'pk',
    key: (r) => `member/${r.pk}`,
    shape: (r) => shaped(r, {
      type: is('member'), pool: validPool, pk: validPk, seq: isTime, at: isTime, joinedAt: isTime,
      maxAcceptedH: isHours, left: bool, sig: bytes(64),
    }, {
      voucher: (v) => shaped(v, { invite: (t) => typeof t === 'string' && t.length <= LIMITS.invite }),
    }) && r.at >= r.joinedAt,
  },
  offer: {
    signer: 'host',
    key: (r) => `offer/${r.taskId}/${r.host}`,
    shape: (r) => shaped(r, {
      type: is('offer'), pool: validPool, taskId: (v) => typeof v === 'string', host: validPk, seq: isTime,
      at: isTime, kind: (v) => typeof v === 'string', item: (v) => typeof v === 'string',
      identity: (v) => typeof v === 'string',
      title: (v) => typeof v === 'string' && v.length <= LIMITS.title && v.isWellFormed() && !CONTROL.test(v),
      minRequiredH: isHours, createdAt: isTime, state: oneOf('open', 'cancelled', 'done'),
      attempt: (v) => Number.isSafeInteger(v) && v >= 1 && v <= LIMITS.attempt, sig: bytes(64),
    }) && r.taskId === buildTaskId(r) && r.at >= r.createdAt,
  },
  claim: {
    signer: 'executor',
    key: (r) => `claim/${r.taskId}/${r.executor}`,
    shape: (r) => shaped(r, {
      type: is('claim'), pool: validPool, taskId: taskIn(r.pool), executor: validPk, round: bytes(8),
      gen: isTime, seq: isTime, state: oneOf('held', 'released', 'completed'), at: isTime,
      claimedAt: isTime, leaseUntil: isTime, deadline: isTime, hours: isHours,
      grants: (v) => Array.isArray(v) && v.length <= LIMITS.list && v.every(grantShaped),
      absent: (v) => isAscending(v, validPk), sig: bytes(64),
    }, { ping: pingShaped, offer: backingShaped, spec: bytes(32) }) && r.at >= r.claimedAt,
  },
};

const typeOf = (record) => (
  isObject(record) && typeof record.type === 'string' && Object.hasOwn(TYPES, record.type) ? TYPES[record.type] : null
);

/// The key a record is stored under. The record must already have passed `checkShape`.
export function recordKey(record) {
  return TYPES[record.type].key(record);
}

/// What a key names in `pool` - `{ type: 'member', pk }`, `{ type: 'offer', taskId, host }`
/// or `{ type: 'claim', taskId, executor }` - or null when it is not a key of that pool.
export function parseKey(key, pool) {
  if (typeof key !== 'string' || key.length > LIMITS.taskId + 60) return null;
  const slash = key.indexOf('/');
  const [type, rest] = [key.slice(0, slash), key.slice(slash + 1)];
  if (type === 'member') return validPk(rest) ? { type, pk: rest } : null;
  if (type !== 'offer' && type !== 'claim') return null;
  const last = rest.lastIndexOf('/');
  const [taskId, pk] = [rest.slice(0, last), rest.slice(last + 1)];
  if (!taskIn(pool)(taskId) || !validPk(pk)) return null;
  return type === 'offer' ? { type, taskId, host: pk } : { type, taskId, executor: pk };
}

/// `{ ok: true, key }` when the record has exactly the members its type allows, each
/// well-formed, and belongs to `pool`; `{ ok: false, code }` with `bad-record` or
/// `wrong-pool` otherwise. No signature is checked.
export function checkShape(record, pool) {
  const type = typeOf(record);
  if (!type || !type.shape(record)) return { ok: false, code: 'bad-record' };
  if (record.pool !== pool) return { ok: false, code: 'wrong-pool' };
  return { ok: true, key: type.key(record) };
}

/// Did the record's own subject sign it?
export function checkSignature(record) {
  return verify(record[TYPES[record.type].signer], 'dn1/rec', record);
}

/// The record with its signature. Throws when `identity` is not the key the record names
/// or the result is not a well-formed record: both are mistakes of the caller.
export function signRecord(identity, fields) {
  const type = typeOf(fields);
  if (!type || fields[type.signer] !== identity.pk) throw new TypeError('not a record this identity signs');
  const record = { ...fields, sig: sign(identity, 'dn1/rec', fields) };
  if (!type.shape(record)) throw new TypeError(`not a well-formed ${fields.type} record`);
  return record;
}

/// A signed member record. `voucher` is the invite token, absent for a pool's own root.
export function memberRecord(identity, { pool, seq, at, joinedAt, maxAcceptedH, voucher, left = false }) {
  return signRecord(identity, {
    type: 'member', pool, pk: identity.pk, seq, at, joinedAt, maxAcceptedH, left,
    ...(voucher ? { voucher: { invite: voucher } } : {}),
  });
}

/// A signed offer record; its task id is derived from the pool, kind, item and identity.
export function offerRecord(identity, fields) {
  const { pool, kind, item, identity: login, seq, at, title, minRequiredH, createdAt, state = 'open', attempt = 1 } = fields;
  return signRecord(identity, {
    type: 'offer', pool, taskId: buildTaskId({ pool, kind, item, identity: login }) ?? '', host: identity.pk, seq, at,
    kind, item, identity: login, title, minRequiredH, createdAt, state, attempt,
  });
}

/// What orders a member or an offer among the versions of its key: `[seq]`.
export function versionPrecedence(record) {
  return [record.seq];
}

/// Which of two versions of a member or an offer wins, each given as its precedence and
/// its base64url record hash: negative when the first does, positive when the second
/// does, zero for the same record. The higher `seq` wins, then the lower hash.
export function compareVersions([seqA], hashA, [seqB], hashB) {
  if (seqA !== seqB) return seqB - seqA;
  return Buffer.compare(unb64u(hashA), unb64u(hashB));
}

/// The base64url hash a state hash and an index name a record by.
export function recordDigest(record) {
  return b64u(hash(record));
}
