// Hours, leases and the heartbeat (PROTOCOL.md section 8): how long a task may take, how
// long a claim is held at a time, and the ping that moves the lease on.

import { sign, verify } from './identity.js';
import { backing, signRecord } from './records.js';
import { CLOCK_SKEW_SECS, LEASE_GRACE_SECS, LEASE_SECS, PING_LEAD_SECS } from '../paths.js';

/// May a member that accepts tasks of up to `maxAcceptedH` hours claim one of `hours`?
export function eligible(maxAcceptedH, hours) {
  return maxAcceptedH >= hours;
}

/// `{ leaseUntil, deadline }` of a held claim at `seq`: one lease per version, never past
/// the deadline.
export function leaseAt(claimedAt, hours, seq) {
  const deadline = claimedAt + hours * 3600;
  return { leaseUntil: Math.min(claimedAt + (seq + 1) * LEASE_SECS, deadline), deadline };
}

/// Is the claim held and inside its lease and grace at `now`?
export function isActive(claim, now) {
  return claim.state === 'held' && now < claim.leaseUntil + LEASE_GRACE_SECS;
}

/// When a held claim stops holding the offer of the host that backs it with `backed`:
/// with its lease and grace, and no later than that offer's hours after it was made.
export function heldUntil(claim, backed) {
  return Math.min(claim.leaseUntil, claim.claimedAt + backed.hours * 3600) + LEASE_GRACE_SECS;
}

/// Does `from` speak for round `round` of a task, by the claim record a host holds for
/// it (or null)? It does as that claim's executor while the claim is active at `now`, and
/// after it ended the claim itself. A claim that lapsed speaks for nothing.
export function speaksFor(claim, { from, round, now }) {
  return Boolean(claim) && claim.executor === from && claim.round === round && (claim.state !== 'held' || isActive(claim, now));
}

/// `{ from, until }`, the times a ping for the claim's next lease is acceptable from the
/// host that backs it with `backed`, or null when the claim is not held or has reached
/// the hours of that host's offer.
export function pingWindow(claim, backed) {
  if (claim.state !== 'held' || claim.leaseUntil >= claim.claimedAt + backed.hours * 3600) return null;
  return { from: claim.leaseUntil - PING_LEAD_SECS, until: claim.leaseUntil + LEASE_GRACE_SECS };
}

/// Should the host that backs the claim with `backed` ping its executor at `now`?
export function pingDue(claim, backed, now) {
  const window = pingWindow(claim, backed);
  return window !== null && now >= window.from && now < window.until;
}

/// The ping asking the claim's executor for its next lease, signed by a host that backs it.
export function buildPing(identity, claim, now) {
  const ping = {
    pool: claim.pool, taskId: claim.taskId, executor: claim.executor, round: claim.round,
    n: claim.seq + 1, by: identity.pk, ts: now,
  };
  return { ...ping, sig: sign(identity, 'dn1/ping', ping) };
}

// Why a ping does not ask for the lease after `claim`'s, or null when it does.
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

/// `{ ok: true }` when a well-shaped `ping` asks for the lease after the executor's own
/// `claim` and comes from a host that backs it; otherwise `{ ok: false, code }` with
/// `bad-ping`, `old` (that lease is already taken), `not-offering`, `ended` (nothing left
/// to extend for that host's offer), `early` or `late`.
export function verifyPing(ping, claim) {
  const code = mismatch(ping, claim);
  return code ? { ok: false, code } : { ok: true };
}

/// The claim's next version: `seq + 1`, the lease moved on, the ping embedded. The ping
/// must have passed `verifyPing` against this claim.
export function extendClaim(identity, claim, ping, now) {
  const { sig: _, ping: __, ...fields } = claim;
  const seq = claim.seq + 1;
  return signRecord(identity, {
    ...fields, seq, at: now, leaseUntil: leaseAt(claim.claimedAt, claim.hours, seq).leaseUntil, ping,
  });
}

/// The claim's last version, with `state` `completed` or `released`. A completed claim
/// names the job its run did: `spec`, the digest of the spec it was handed with its key.
export function endClaim(identity, claim, state, now, spec) {
  const { sig: _, ping: __, ...fields } = claim;
  return signRecord(identity, { ...fields, seq: claim.seq + 1, at: now, state, ...(state === 'completed' ? { spec } : {}) });
}

/// Null when a well-shaped claim's times are the ones its `claimedAt`, `hours` and `seq`
/// dictate and, for an extension, it embeds the ping that asked for it, from a host that
/// backs the claim and inside the hours of that host's offer; otherwise `bad-lease` or
/// `bad-ping`.
///
/// A held version is dated by what it answers - the claim itself by `claimedAt`, an
/// extension within the clock tolerance of its ping - so its retention, counted from
/// `at`, cannot be made to run out while its lease still holds.
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
