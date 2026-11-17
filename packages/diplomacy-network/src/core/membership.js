// Who is in a pool (PROTOCOL.md section 5): the invite a host is asked in by, the voucher
// the inviter signs for that host's key, and the members a host accepts - the seats under
// the member that started the pool, as the member records it holds fill them.

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

/// A voucher: `identity`, in the membership it numbers `era`, gives its seat number
/// `seat` in `pool` to the key `pk`, at `at`.
export function createVoucher(identity, { pool, era, pk, seat, at }) {
  const voucher = { pool, by: identity.pk, era, pk, seat, at };
  return { ...voucher, sig: sign(identity, 'dn1/voucher', voucher) };
}

/// Does a member record's voucher hold for every host alike? True for a record without
/// one (the member that started a pool); otherwise the voucher must be for the record's
/// pool and key, signed by another key, and dated no later than the record.
export function verifyVoucher(record) {
  const { voucher } = record;
  if (!voucher) return true;
  return voucher.pool === record.pool && voucher.pk === record.pk && voucher.by !== record.pk && voucher.at <= record.at
    && verify(voucher.by, 'dn1/voucher', voucher);
}

/// The keys `self` accepts, given member records whose vouchers already verified, as a
/// map from each to how many vouchers it is from the top: the member `self`'s own chain
/// of vouchers leads up to, the members that hold a seat of it, and so on down to
/// `LIMITS.depth`. A voucher counts while its signer's record is of the membership the
/// voucher was signed in. Of the records that name one seat, the one with the latest
/// voucher holds it, then the one with the lowest key. Where that leaves `self` without a
/// seat the top is `self`: a host is a member of its own state. The result does not
/// depend on the order of `records`.
export function seating(self, records) {
  const held = new Map(records.map((record) => [record.pk, record]));
  // The key whose seat a record is for, when that key's record is held and of the
  // voucher's membership.
  const inviter = ({ voucher }) => (voucher && held.get(voucher.by)?.era === voucher.era ? voucher.by : undefined);
  const under = new Map(); // pk -> the records that are for a seat of that key
  for (const record of records) {
    const by = inviter(record);
    if (by === undefined) continue;
    if (!under.has(by)) under.set(by, []);
    under.get(by).push(record);
  }
  const below = (top) => {
    const depth = new Map([[top, 0]]);
    let level = [top];
    for (let d = 1; d <= LIMITS.depth; d += 1) {
      const next = [];
      for (const by of level) {
        const seats = new Map();
        for (const record of under.get(by) ?? []) {
          // A chain of vouchers may close on itself: a key is seated once, at its highest.
          if (depth.has(record.pk)) continue;
          const { seat, at } = record.voucher;
          const rival = seats.get(seat);
          if (!rival || at > rival.voucher.at || (at === rival.voucher.at && record.pk < rival.pk)) seats.set(seat, record);
        }
        for (const { pk } of seats.values()) {
          depth.set(pk, d);
          next.push(pk);
        }
      }
      level = next;
    }
    return depth;
  };
  const chain = [self];
  for (let by = inviter(held.get(self) ?? {}); by !== undefined && !chain.includes(by); by = inviter(held.get(by))) chain.push(by);
  const top = chain.at(-1);
  const seated = below(top);
  return seated.has(self) ? seated : below(self);
}
