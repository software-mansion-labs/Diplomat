// Hours, leases and the heartbeat (PROTOCOL.md section 8): how long a task may take, how
// long a claim is held at a time, and the ping that moves the lease on.

import { sign, verify } from './identity.js';
import { signRecord } from './records.js';
import { LEASE_GRACE_SECS, LEASE_SECS, PING_LEAD_SECS } from '../paths.js';

/// A task's hours: the largest `minRequiredH` among its open offers, or null when none is open.
export function taskHours(offers) {
  const open = offers.filter((o) => o.state === 'open');
  return open.length > 0 ? Math.max(...open.map((o) => o.minRequiredH)) : null;
}

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

/// When the claim stops holding its task: the moment a held claim lapses unless it is
/// extended, or the time an ended claim was signed.
export function endsAt(claim) {
  return claim.state === 'held' ? claim.leaseUntil + LEASE_GRACE_SECS : claim.at;
}

/// `{ from, until }`, the times a ping for the claim's next lease is acceptable, or null
/// when the claim is not held or has reached its deadline.
export function pingWindow(claim) {
  if (claim.state !== 'held' || claim.leaseUntil >= claim.deadline) return null;
  return { from: claim.leaseUntil - PING_LEAD_SECS, until: claim.leaseUntil + LEASE_GRACE_SECS };
}

/// Should a host offering the claim's task ping its executor at `now`?
export function pingDue(claim, now) {
  const window = pingWindow(claim);
  return window !== null && now >= window.from && now < window.until;
}

/// The ping asking the claim's executor for its next lease, signed by an offering host.
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
  const window = pingWindow(claim);
  if (!window) return 'ended';
  if (ping.ts < window.from) return 'early';
  if (ping.ts >= window.until) return 'late';
  return verify(ping.by, 'dn1/ping', ping) ? null : 'bad-ping';
}

/// `{ ok: true }` when a well-shaped `ping` asks for the lease after the executor's own
/// `claim` and comes from one of the hosts `offering` the task; otherwise
/// `{ ok: false, code }` with `bad-ping`, `old` (that lease is already taken), `ended`
/// (nothing left to extend), `early`, `late` or `not-offering`.
export function verifyPing(ping, claim, offering) {
  const code = mismatch(ping, claim) ?? (offering.includes(ping.by) ? null : 'not-offering');
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

/// The claim's last version, with `state` `completed` or `released`.
export function endClaim(identity, claim, state, now) {
  const { sig: _, ping: __, ...fields } = claim;
  return signRecord(identity, { ...fields, seq: claim.seq + 1, at: now, state });
}

/// Null when a well-shaped claim's times are the ones its `claimedAt`, `hours` and `seq`
/// dictate and, for an extension, it embeds the ping that asked for it; otherwise
/// `bad-lease` or `bad-ping`. Whether the ping's signer offers the task is the pool's to say.
export function verifyLease(claim) {
  const { leaseUntil, deadline } = leaseAt(claim.claimedAt, claim.hours, claim.seq);
  if (claim.deadline !== deadline) return 'bad-lease';
  if (claim.state !== 'held') {
    const fine = !claim.ping && claim.seq >= 1 && claim.leaseUntil > claim.claimedAt && claim.leaseUntil <= deadline;
    return fine ? null : 'bad-lease';
  }
  if (claim.leaseUntil !== leaseUntil) return 'bad-lease';
  if (claim.seq === 0) return claim.ping ? 'bad-ping' : null;
  if (!claim.ping) return 'bad-ping';
  const before = { ...claim, seq: claim.seq - 1, leaseUntil: leaseAt(claim.claimedAt, claim.hours, claim.seq - 1).leaseUntil };
  return mismatch(claim.ping, before) ? 'bad-ping' : null;
}
