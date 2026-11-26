// Canonical JSON (PROTOCOL.md section 2): two hosts must turn one value into the same bytes.

import crypto from 'node:crypto';

/// Throws on a float, an unsafe integer, null, undefined or any non-plain object.
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

/// Null unless `bytes` are exactly canonical: a duplicate key, whitespace or key order fails.
export function parseCanon(bytes) {
  try {
    const value = JSON.parse(bytes.toString('utf8'));
    return canon(value).equals(bytes) ? value : null;
  } catch {
    return null;
  }
}

export function hash(...parts) {
  const h = crypto.createHash('sha256');
  for (const p of parts) h.update(Buffer.isBuffer(p) ? p : canon(p));
  return h.digest();
}

export function b64u(buf) {
  return Buffer.from(buf).toString('base64url');
}

/// Strict unpadded base64url, else null: Buffer.from silently skips unknown characters.
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

export function tagged(tag, ...rest) {
  return Buffer.concat([Buffer.from(tag, 'ascii'), Buffer.from([0]), ...rest]);
}
