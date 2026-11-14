// Who is in a pool (PROTOCOL.md section 5): invites, the voucher a member record carries,
// and the set of members a host accepts - everyone connected to itself through vouchers.

import { b64u, canon, unb64u } from './canon.js';
import { sign, validPk, verify } from './identity.js';
import { LIMITS, isBytes, isTime, shaped, validPool } from './records.js';

const INVITE = {
  pool: validPool, by: validPk, exp: isTime, nonce: (v) => isBytes(v, 16), sig: (v) => isBytes(v, 64),
};

/// An invite to `pool` signed by `identity`, good until `exp`. `nonce` is 16 random bytes.
export function createInvite(identity, { pool, exp, nonce }) {
  const invite = { pool, by: identity.pk, exp, nonce: b64u(nonce) };
  return { ...invite, sig: sign(identity, 'dn1/invite', invite) };
}

/// The token an invite travels as: the base64url of its canonical form.
export function inviteToken(invite) {
  return b64u(canon(invite));
}

/// The invite a token holds, or null when the token is not the canonical form of one.
export function parseInvite(token) {
  if (typeof token !== 'string' || token.length > LIMITS.invite) return null;
  const bytes = unb64u(token);
  if (!bytes) return null;
  try {
    const invite = JSON.parse(bytes.toString('utf8'));
    return shaped(invite, INVITE) && canon(invite).equals(bytes) ? invite : null;
  } catch {
    return null;
  }
}

/// `{ ok: true }` for an invite to `pool` signed by the key it names and, when `now` is
/// given, not yet expired; otherwise `{ ok: false, code }` with `bad-invite`, `wrong-pool`
/// or `expired`.
export function verifyInvite(invite, { pool, now }) {
  if (!shaped(invite, INVITE) || !verify(invite.by, 'dn1/invite', invite)) return { ok: false, code: 'bad-invite' };
  if (invite.pool !== pool) return { ok: false, code: 'wrong-pool' };
  if (now !== undefined && invite.exp <= now) return { ok: false, code: 'expired' };
  return { ok: true };
}

// Parsing a token is a JSON parse and a re-encode, and a pool asks for the same record's
// voucher on every state hash.
const vouchers = new WeakMap();

/// The invite a member record carries as its voucher, or null when it has none or the
/// token is malformed.
export function voucherOf(record) {
  if (!record.voucher) return null;
  if (!vouchers.has(record)) vouchers.set(record, parseInvite(record.voucher.invite));
  return vouchers.get(record);
}

/// Does a member record's voucher hold for every host alike? True for a record without
/// one (a pool's root); otherwise the invite must be for the record's pool, signed by
/// another key, and not expired when the member says it joined.
export function verifyVoucher(record) {
  if (!record.voucher) return true;
  const invite = voucherOf(record);
  return invite !== null && invite.by !== record.pk && record.joinedAt <= invite.exp
    && verifyInvite(invite, { pool: record.pool }).ok;
}

/// May a host that has never seen this member let it in at `now`? `{ ok: true }` while
/// its invite is unexpired; otherwise `{ ok: false, code }` with `no-voucher` or
/// `expired`. A member a host learns of from another member needs no such check: that
/// member already let it in.
export function checkJoin(record, now) {
  const invite = voucherOf(record);
  if (!invite) return { ok: false, code: 'no-voucher' };
  return invite.exp <= now ? { ok: false, code: 'expired' } : { ok: true };
}

/// The public keys `self` accepts, given member records whose vouchers already verified:
/// every key connected to `self` by vouchers, whichever way each voucher points. The
/// result does not depend on the order of `records`.
export function acceptedSet(self, records) {
  const links = new Map();
  const link = (a, b) => {
    if (!links.has(a)) links.set(a, []);
    links.get(a).push(b);
  };
  for (const record of records) {
    const by = voucherOf(record)?.by;
    if (by) {
      link(record.pk, by);
      link(by, record.pk);
    }
  }
  const accepted = new Set([self]);
  const queue = [self];
  while (queue.length > 0) {
    for (const next of links.get(queue.pop()) ?? []) {
      if (!accepted.has(next)) {
        accepted.add(next);
        queue.push(next);
      }
    }
  }
  return accepted;
}
