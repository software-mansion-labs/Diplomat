// Which of two versions of a claim wins is in claims.js.

import { b64u, hash, unb64u } from './canon.js';
import { sign, validPk, verify } from './identity.js';
import { HOURS_CEILING, HOURS_FLOOR } from '../paths.js';

// `invitees`: seats a member gives; `depth`: vouchers from the pool's first member.
// `offers`, `claims`, `bytes` (canonical size): what one member may have live in a pool.
// `spare`: the part of `bytes` a host leaves free when adding a record, for longer versions.
export const LIMITS = {
  pool: 200, taskId: 400, title: 300, invite: 1024, attempt: 255, list: 256, time: 2 ** 40,
  invitees: 15, depth: 2, members: 1 + 15 + 15 * 15, offers: 64, claims: 64, bytes: 256 * 2 ** 10, spare: 32 * 2 ** 10,
};

const POOL = /^[a-z0-9][a-z0-9.-]*(\/[a-z0-9._-]+){2,}$/;
const KIND = /^[a-z][a-z0-9-]{0,31}$/;
const ITEM = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const IDENTITY = /^[a-z0-9][a-z0-9._-]{0,99}$/;
// C0, DEL and C1: nothing a title needs, everything a terminal obeys.
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

export function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
}

function isUint(v) {
  return Number.isSafeInteger(v) && v >= 0;
}

/// Also a sequence number; bounded so sums stay safe integers.
export function isTime(v) {
  return isUint(v) && v <= LIMITS.time;
}

export function isBytes(v, n) {
  return unb64u(v)?.length === n;
}

const isHours = (v) => Number.isSafeInteger(v) && v >= HOURS_FLOOR && v <= HOURS_CEILING;

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

export function isAscending(v, test, max = LIMITS.list) {
  return Array.isArray(v) && v.length <= max && v.every((x, i) => test(x) && (i === 0 || v[i - 1] < x));
}

/// A lowercase forge slug, "host/owner/repo" or deeper.
export function validPool(id) {
  return typeof id === 'string' && id.length <= LIMITS.pool && POOL.test(id)
    && !id.split('/').some((segment) => /^\.+$/.test(segment));
}

/// `identity` is the forge login the item is worked on as.
export function buildTaskId({ pool, kind, item, identity }) {
  if (!validPool(pool) || !KIND.test(kind) || !ITEM.test(item) || !IDENTITY.test(identity)) return null;
  return `${pool}#${kind}:${item}@${identity}`;
}

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

// A backer's word on its own offer: the version made at `at`, given to its `gen`th claim, for `hours`.
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

/// Shape only: the signature and what it binds are not checked.
export function grantShaped(v) {
  return shaped(v, GRANT, { offer: backingShaped });
}

export function backing(claim, pk) {
  return (pk === claim.executor ? claim.offer : claim.grants.find((grant) => grant.by === pk)?.offer) ?? null;
}

export function backers(claim) {
  return [...(claim.offer ? [claim.executor] : []), ...claim.grants.filter((grant) => grant.offer).map((grant) => grant.by)];
}

/// Shape only: the signature and what it binds are not checked.
export function pingShaped(v) {
  return shaped(v, PING);
}

const TYPES = {
  member: {
    signer: 'pk',
    key: (r) => `member/${r.pk}`,
    shape: (r) => shaped(r, {
      type: is('member'), pool: validPool, pk: validPk, seq: isTime, at: isTime, era: isTime,
      maxAcceptedH: isHours, left: bool, sig: bytes(64),
    }, {
      voucher: (v) => shaped(v, {
        pool: validPool, by: validPk, era: isTime, pk: validPk, seat: (n) => isUint(n) && n < LIMITS.invitees, at: isTime,
        sig: bytes(64),
      }),
    }),
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

/// `record` must have passed `checkShape`.
export function recordKey(record) {
  return TYPES[record.type].key(record);
}

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

/// No signature is checked.
export function checkShape(record, pool) {
  const type = typeOf(record);
  if (!type || !type.shape(record)) return { ok: false, code: 'bad-record' };
  if (record.pool !== pool) return { ok: false, code: 'wrong-pool' };
  return { ok: true, key: type.key(record) };
}

export function checkSignature(record) {
  return verify(record[TYPES[record.type].signer], 'dn1/rec', record);
}

export function signRecord(identity, fields) {
  const type = typeOf(fields);
  if (!type || fields[type.signer] !== identity.pk) throw new TypeError('not a record this identity signs');
  const record = { ...fields, sig: sign(identity, 'dn1/rec', fields) };
  if (!type.shape(record)) throw new TypeError(`not a well-formed ${fields.type} record`);
  return record;
}

/// `era`: the `seq` of the first record of this membership.
export function memberRecord(identity, { pool, seq, at, era, maxAcceptedH, voucher, left = false }) {
  return signRecord(identity, {
    type: 'member', pool, pk: identity.pk, seq, at, era, maxAcceptedH, left, ...(voucher ? { voucher } : {}),
  });
}

export function offerRecord(identity, fields) {
  const { pool, kind, item, identity: login, seq, at, title, minRequiredH, createdAt, state = 'open', attempt = 1 } = fields;
  return signRecord(identity, {
    type: 'offer', pool, taskId: buildTaskId({ pool, kind, item, identity: login }) ?? '', host: identity.pk, seq, at,
    kind, item, identity: login, title, minRequiredH, createdAt, state, attempt,
  });
}

export function versionPrecedence(record) {
  return [record.seq];
}

/// Negative when the first wins: the higher `seq`, then the lower hash.
export function compareVersions([seqA], hashA, [seqB], hashB) {
  if (seqA !== seqB) return seqB - seqA;
  return Buffer.compare(unb64u(hashA), unb64u(hashB));
}

export function recordDigest(record) {
  return b64u(hash(record));
}
