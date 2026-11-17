// A host's identity: one Ed25519 key pair that is also its onion service key, so the
// onion address is a function of the public key (PROTOCOL.md section 1).

import crypto from 'node:crypto';
import { b64u, canon, tagged, unb64u } from './canon.js';

// The fixed DER prefixes Node wraps a raw Ed25519 key in.
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function privateKey(seed) {
  return crypto.createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, seed]), format: 'der', type: 'pkcs8' });
}

function publicKey(pkBytes) {
  return crypto.createPublicKey({ key: Buffer.concat([SPKI_PREFIX, pkBytes]), format: 'der', type: 'spki' });
}

// Parsing a key costs as much as signing with it, and a host signs every request and
// every answer with the one identity it holds.
const parsed = new WeakMap(); // identity -> its private key object

/// `{ pk, seed }`, both base64url: the public key and the 32-byte private seed.
export function generateIdentity() {
  const seed = crypto.randomBytes(32);
  return identityFromSeed(seed);
}

/// The identity a stored seed stands for, or null when the seed is not 32 bytes.
export function identityFromSeed(seed) {
  const bytes = Buffer.isBuffer(seed) ? seed : unb64u(seed);
  if (!bytes || bytes.length !== 32) return null;
  const pk = crypto.createPublicKey(privateKey(bytes)).export({ format: 'der', type: 'spki' }).subarray(-32);
  return { pk: b64u(pk), seed: b64u(bytes) };
}

// The points of small order, as bytes with the sign bit cleared. Where the crypto library
// takes one for a key, a signature with R the identity and S zero verifies under it for
// messages nobody signed.
const SMALL_ORDER = [
  '00'.repeat(32),
  `01${'00'.repeat(31)}`,
  '26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05',
  'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a',
  `ec${'ff'.repeat(30)}7f`,
  `ed${'ff'.repeat(30)}7f`,
  `ee${'ff'.repeat(30)}7f`,
];

/// Is this a well-formed public key: 32 bytes, base64url, and no point of small order?
export function validPk(pk) {
  const bytes = unb64u(pk);
  if (bytes?.length !== 32) return false;
  bytes[31] &= 0x7f;
  return !SMALL_ORDER.includes(bytes.toString('hex'));
}

/// The base64url signature of `tag || 0x00 || canon(object without "sig")`.
export function sign(identity, tag, object) {
  const { sig: _, ...rest } = object;
  if (!parsed.has(identity)) parsed.set(identity, privateKey(unb64u(identity.seed)));
  return b64u(crypto.sign(null, tagged(tag, canon(rest)), parsed.get(identity)));
}

/// Does `object.sig` (or `sig`, when given) sign the object under `tag` for `pk`? False
/// for any malformed input rather than a throw.
export function verify(pk, tag, object, sig = object?.sig) {
  try {
    const pkBytes = unb64u(pk);
    const sigBytes = unb64u(sig);
    if (pkBytes?.length !== 32 || sigBytes?.length !== 64) return false;
    const { sig: _, ...rest } = object;
    return crypto.verify(null, tagged(tag, canon(rest)), publicKey(pkBytes), sigBytes);
  } catch {
    return false;
  }
}

const B32 = 'abcdefghijklmnopqrstuvwxyz234567';

function base32(buf) {
  let bits = 0;
  let acc = 0;
  let out = '';
  for (const byte of buf) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(acc >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits) out += B32[(acc << (5 - bits)) & 31];
  return out;
}

/// The v3 onion address ("<56 chars>.onion") of a public key.
export function onionAddress(pk) {
  const key = unb64u(pk);
  if (key?.length !== 32) throw new TypeError('not a public key');
  const version = Buffer.from([3]);
  const checksum = crypto.createHash('sha3-256')
    .update(Buffer.concat([Buffer.from('.onion checksum'), key, version])).digest().subarray(0, 2);
  return `${base32(Buffer.concat([key, checksum, version]))}.onion`;
}

/// The key as tor's ADD_ONION takes it: "ED25519-V3:" plus the base64 of the 64-byte
/// expanded secret key (the clamped SHA-512 of the seed).
export function torSecretKey(identity) {
  const h = crypto.createHash('sha512').update(unb64u(identity.seed)).digest();
  h[0] &= 248;
  h[31] &= 127;
  h[31] |= 64;
  return `ED25519-V3:${h.toString('base64')}`;
}
