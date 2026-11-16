// Canonical JSON, hashes and byte helpers (PROTOCOL.md section 2). Two hosts must turn
// the same value into the same bytes, so anything JSON would let them write differently
// is refused here.

import crypto from 'node:crypto';

/// The canonical bytes of a JSON value: keys sorted by code unit, no whitespace, integers
/// only. Throws on a float, an unsafe integer, null, undefined or any non-plain object.
export function canon(value) {
  return Buffer.from(write(value), 'utf8');
}

function write(v) {
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') {
    if (!Number.isSafeInteger(v)) throw new TypeError(`not a canonical number: ${v}`);
    return String(v);
  }
  if (Array.isArray(v)) return `[${v.map(write).join(',')}]`;
  if (v && Object.getPrototypeOf(v) === Object.prototype) {
    const keys = Object.keys(v).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${keys.map((k) => `${JSON.stringify(k)}:${write(v[k])}`).join(',')}}`;
  }
  throw new TypeError(`not a canonical value: ${v === null ? 'null' : typeof v}`);
}

/// The value `bytes` are the canonical form of, or null when they are the canonical form
/// of nothing: not JSON, or JSON written any other way - a key given twice, a float,
/// whitespace, keys out of order.
export function parseCanon(bytes) {
  try {
    const value = JSON.parse(bytes.toString('utf8'));
    return canon(value).equals(bytes) ? value : null;
  } catch {
    return null;
  }
}

/// SHA-256 of the concatenated parts; a part that is not a Buffer is canonicalised.
export function hash(...parts) {
  const h = crypto.createHash('sha256');
  for (const p of parts) h.update(Buffer.isBuffer(p) ? p : canon(p));
  return h.digest();
}

export function b64u(buf) {
  return Buffer.from(buf).toString('base64url');
}

/// The bytes of an unpadded base64url string, or null when it is not one: Buffer.from
/// would silently skip the characters it does not know.
export function unb64u(str) {
  if (typeof str !== 'string' || !/^[A-Za-z0-9_-]*$/.test(str)) return null;
  const buf = Buffer.from(str, 'base64url');
  return buf.toString('base64url') === str ? buf : null;
}

export function u32be(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
}

export function u64be(n) {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(BigInt(n));
  return b;
}

/// `tag || 0x00 || rest...`, the prefix every domain-separated hash and signature starts with.
export function tagged(tag, ...rest) {
  return Buffer.concat([Buffer.from(tag, 'ascii'), Buffer.from([0]), ...rest]);
}
