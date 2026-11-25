import { sign, verify } from './identity.js';
import { backing, signRecord } from './records.js';
import { CLOCK_SKEW_SECS, LEASE_GRACE_SECS, LEASE_SECS, PING_LEAD_SECS } from '../paths.js';

export function eligible(maxAcceptedH, hours) {
  return maxAcceptedH >= hours;
}

export function leaseAt(claimedAt, hours, seq) {
  const deadline = claimedAt + hours * 3600;
  return { leaseUntil: Math.min(claimedAt + (seq + 1) * LEASE_SECS, deadline), deadline };
}

export function isActive(claim, now) {
  return claim.state === 'held' && now < claim.leaseUntil + LEASE_GRACE_SECS;
}

/// `backed`: the offer of the host that backs the claim.
export function heldUntil(claim, backed) {
  return Math.min(claim.leaseUntil, claim.claimedAt + backed.hours * 3600) + LEASE_GRACE_SECS;
}

export function speaksFor(claim, { from, round, now }) {
  return Boolean(claim) && claim.executor === from && claim.round === round && (claim.state !== 'held' || isActive(claim, now));
}

export function pingWindow(claim, backed) {
  if (claim.state !== 'held' || claim.leaseUntil >= claim.claimedAt + backed.hours * 3600) return null;
  return { from: claim.leaseUntil - PING_LEAD_SECS, until: claim.leaseUntil + LEASE_GRACE_SECS };
}

export function pingDue(claim, backed, now) {
  const window = pingWindow(claim, backed);
  return window !== null && now >= window.from && now < window.until;
}

export function buildPing(identity, claim, now) {
  const ping = {
    pool: claim.pool, taskId: claim.taskId, executor: claim.executor, round: claim.round,
    n: claim.seq + 1, by: identity.pk, ts: now,
  };
  return { ...ping, sig: sign(identity, 'dn1/ping', ping) };
}

// The refusal code, or null when the ping holds.
function mismatch(ping, claim) {
  if (ping.pool !== claim.pool || ping.taskId !== claim.taskId || ping.executor !== claim.executor
    || ping.round !== claim.round) return 'bad-ping';
  if (ping.n <= claim.seq) return 'old';
  if (ping.n !== claim.seq + 1) return 'bad-ping';
  const backed = backing(claim, ping.by);
  if (!backed) return 'not-offering';
  const window = pingWindow(claim, backed);
  if (!window) return 'ended';
  if (ping.ts < window.from) return 'early';
  if (ping.ts >= window.until) return 'late';
  return verify(ping.by, 'dn1/ping', ping) ? null : 'bad-ping';
}

export function verifyPing(ping, claim) {
  const code = mismatch(ping, claim);
  return code ? { ok: false, code } : { ok: true };
}

/// `ping` must have passed `verifyPing` against `claim`.
export function extendClaim(identity, claim, ping, now) {
  const { sig: _, ping: __, ...fields } = claim;
  const seq = claim.seq + 1;
  return signRecord(identity, {
    ...fields, seq, at: now, leaseUntil: leaseAt(claim.claimedAt, claim.hours, seq).leaseUntil, ping,
  });
}

/// `spec`, kept on a completed claim only, is the digest of the spec its run was handed.
export function endClaim(identity, claim, state, now, spec) {
  const { sig: _, ping: __, ...fields } = claim;
  const at = Math.max(now, claim.claimedAt);
  return signRecord(identity, { ...fields, seq: claim.seq + 1, at, state, ...(state === 'completed' ? { spec } : {}) });
}

/// A held version's `at` is pinned (to `claimedAt`, or to its ping's `ts` within clock
/// skew) so its retention, counted from `at`, cannot run out while its lease holds.
export function verifyLease(claim) {
  const { leaseUntil, deadline } = leaseAt(claim.claimedAt, claim.hours, claim.seq);
  if (claim.deadline !== deadline) return 'bad-lease';
  if (claim.state !== 'held') {
    const fine = !claim.ping && claim.seq >= 1 && claim.leaseUntil > claim.claimedAt && claim.leaseUntil <= deadline;
    return fine ? null : 'bad-lease';
  }
  if (claim.leaseUntil !== leaseUntil) return 'bad-lease';
  if (claim.seq === 0) return claim.ping ? 'bad-ping' : claim.at === claim.claimedAt ? null : 'bad-lease';
  if (!claim.ping) return 'bad-ping';
  const before = { ...claim, seq: claim.seq - 1, leaseUntil: leaseAt(claim.claimedAt, claim.hours, claim.seq - 1).leaseUntil };
  if (mismatch(claim.ping, before)) return 'bad-ping';
  return Math.abs(claim.at - claim.ping.ts) <= CLOCK_SKEW_SECS ? null : 'bad-lease';
}
