import { b64u, canon, unb64u } from './canon.js';
import { sign, validPk, verify } from './identity.js';
import { LIMITS, isBytes, isTime, shaped, validPool } from './records.js';

const INVITE = {
  pool: validPool, by: validPk, exp: isTime, nonce: (v) => isBytes(v, 16), sig: (v) => isBytes(v, 64),
};

export function createInvite(identity, { pool, exp, nonce }) {
  const invite = { pool, by: identity.pk, exp, nonce: b64u(nonce) };
  return { ...invite, sig: sign(identity, 'dn1/invite', invite) };
}

export function inviteToken(invite) {
  return b64u(canon(invite));
}

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

export function verifyInvite(invite, { pool, now }) {
  if (!shaped(invite, INVITE) || !verify(invite.by, 'dn1/invite', invite)) return { ok: false, code: 'bad-invite' };
  if (invite.pool !== pool) return { ok: false, code: 'wrong-pool' };
  if (now !== undefined && invite.exp <= now) return { ok: false, code: 'expired' };
  return { ok: true };
}

/// `era` is the era of the signer's own member record.
export function createVoucher(identity, { pool, era, pk, seat, at }) {
  const voucher = { pool, by: identity.pk, era, pk, seat, at };
  return { ...voucher, sig: sign(identity, 'dn1/voucher', voucher) };
}

/// Only the member that started a pool has no voucher.
export function verifyVoucher(record) {
  const { voucher } = record;
  if (!voucher) return true;
  return voucher.pool === record.pool && voucher.pk === record.pk && voucher.by !== record.pk && voucher.at <= record.at
    && verify(voucher.by, 'dn1/voucher', voucher);
}

/// The keys `self` accepts, each mapped to its depth in vouchers below the top (PROTOCOL.md
/// section 5, Membership). `records` must have verified vouchers; their order does not matter.
export function seating(self, records) {
  const held = new Map(records.map((record) => [record.pk, record]));
  const inviter = ({ voucher }) => (voucher && held.get(voucher.by)?.era === voucher.era ? voucher.by : undefined);
  const under = new Map(); // inviter pk -> the records it vouched for
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
          // Seated once, at its highest - so a closed chain's top takes no seat.
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
  let by = inviter(held.get(self) ?? {});
  for (; by !== undefined && !chain.includes(by); by = inviter(held.get(by))) chain.push(by);
  // `by` is where the chain closed, if it did.
  const loop = by === undefined ? [] : chain.slice(chain.indexOf(by));
  const later = (a, b) => a.voucher.at > b.voucher.at || (a.voucher.at === b.voucher.at && a.pk > b.pk);
  const top = loop.reduce((last, pk) => (later(held.get(pk), held.get(last)) ? pk : last), chain.at(-1));
  const seated = below(top);
  return seated.has(self) ? seated : below(self);
}
