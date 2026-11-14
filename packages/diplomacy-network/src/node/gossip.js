// Membership and the spread of records: a host's own member record in every pool it
// linked, joining by invite, and keeping every member's state the same as its own - a
// push of each record it signs or lets in, and a periodic sync that repairs what a push
// missed.

import { LockTable } from '../core/claims.js';
import { createInvite, inviteToken, parseInvite, verifyInvite, voucherOf } from '../core/membership.js';
import { MAX_HELLO_CHAIN, MAX_PUSH_RECORDS, Pool } from '../core/pool.js';
import { isObject, memberRecord, shaped } from '../core/records.js';
import {
  HOURS_CEILING, HOURS_FLOOR, INVITE_TTL_SECS, PEER_BACKOFF_MAX_MS, PRUNE_INTERVAL_MS, RESIGN_INTERVAL_MS,
  SYNC_INTERVAL_MS,
} from '../paths.js';
import { poolFile } from './store.js';

// Records per `pull` and per `push`: what fits a request body with room to spare.
const BATCH = 256;

/// The key a pool stores a host's member record under.
export const memberKey = (pk) => `member/${pk}`;
/// The key of a host's offer of a task.
export const offerKey = (taskId, pk) => `offer/${taskId}/${pk}`;
/// The key of the claim of a task.
export const claimKey = (taskId) => `claim/${taskId}`;

/// The hours a setting stands for: a whole number inside what a record may carry.
export function hoursOf(value) {
  const hours = Math.round(Number(value));
  return Number.isFinite(hours) ? Math.min(HOURS_CEILING, Math.max(HOURS_FLOOR, hours)) : HOURS_FLOOR;
}

/// What a handler answered, as the sender of a request sees it.
export function asResult(answer) {
  return answer.error ? { ok: false, code: answer.error, detail: answer.detail ?? '' } : { ok: true, body: answer.body };
}

/// The membership and gossip of `host`.
export function createGossip(host) {
  const outbox = new Map(); // "pool pk" -> { keys, busy }: what is still to be pushed to that member
  const syncing = new Set(); // "pool pk" of every sync in flight
  const snubbed = new Map(); // "pool pk" -> when a member that refused a hello is greeted again
  let timer = null;
  let pruned = 0;

  const own = (P) => P.pool.get(memberKey(host.self));
  const open = (P) => host.pools.get(P.id) === P;
  const jitter = () => host.random(4).readUInt32BE(0) / 2 ** 32;

  // This host's next member record in a pool. `voucher`, when named, replaces the one it
  // holds: an invite token to join by, undefined to stand alone as a pool's root.
  function signMember(P, change = {}) {
    const held = own(P);
    const rejoin = Object.hasOwn(change, 'voucher');
    const now = host.now();
    P.seq += 1;
    return memberRecord(host.id, {
      pool: P.id, seq: P.seq, at: now, joinedAt: held && !rejoin ? held.joinedAt : now,
      maxAcceptedH: hoursOf(host.settings().maximumAcceptedH),
      voucher: rejoin ? change.voucher : held?.voucher?.invite, left: change.left === true,
    });
  }

  /// Links a pool: what the store holds of it is taken up again, and the host is a member
  /// of it at once, alone until it joins or invites someone.
  function link(info) {
    const doc = host.store.read(poolFile(info.id)) ?? {};
    const P = {
      id: info.id, link: info, pool: new Pool({ id: info.id, self: host.self }),
      locks: new LockTable(host.heldLocks[info.id] ?? []),
      seq: Number.isSafeInteger(doc.seq) ? doc.seq : -1, inviter: null,
    };
    // The locks read at startup are taken up once: a pool linked again starts without them.
    delete host.heldLocks[info.id];
    const now = host.now();
    if (doc.linked && Array.isArray(doc.records)) {
      P.pool.merge(doc.records, now);
      P.inviter = typeof doc.inviter === 'string' ? doc.inviter : null;
    }
    if (!own(P) || own(P).left) {
      P.inviter = null;
      P.pool.merge(signMember(P, { voucher: undefined }), now);
    }
    host.pools.set(P.id, P);
    host.save(P);
    return P;
  }

  /// Leaves a pool: the record saying so and `keys`, the other records this host signed
  /// on its way out, are pushed to every member once, and the pool is forgotten but for
  /// the sequence number its next member record must exceed.
  function unlink(P, keys) {
    const left = signMember(P, { left: true });
    const members = others(P);
    P.pool.merge(left, host.now());
    const records = P.pool.records([...keys, memberKey(host.self)]);
    host.pools.delete(P.id);
    host.store.write(poolFile(P.id), { id: P.id, linked: false, seq: P.seq });
    for (const pk of members) host.peers.ask(P.id, pk, 'push', { records }).catch(() => {});
  }

  // Every host this one keeps in touch with in a pool: the members, the ones that stopped
  // signing their record, and the inviter it has yet to hear from.
  function others(P) {
    const now = host.now();
    const pks = P.pool.known(now).map((m) => m.pk).filter((pk) => pk !== host.self);
    if (P.inviter && !pks.includes(P.inviter) && P.pool.accepts(P.inviter, now)) pks.push(P.inviter);
    return pks;
  }

  // The member records that lead from this host toward the pool's root.
  function chainOf(P) {
    const chain = [];
    let record = own(P);
    while (chain.length < MAX_HELLO_CHAIN) {
      const by = voucherOf(record)?.by;
      const next = by ? P.pool.get(memberKey(by)) : null;
      if (!next || next.pk === host.self || chain.includes(next)) break;
      chain.push(next);
      record = next;
    }
    return chain;
  }

  // Pulls what a member holds and this host lacks, and queues what it lacks for a push.
  async function exchange(P, pk, plan) {
    for (let i = 0; i < plan.pull.length && open(P); i += BATCH) {
      const keys = plan.pull.slice(i, i + BATCH);
      const pulled = await host.peers.ask(P.id, pk, 'pull', { keys });
      if (!pulled.ok || !Array.isArray(pulled.body.records)) break;
      host.take(P, pulled.body.records.slice(0, keys.length));
    }
    post(P, pk, plan.push);
  }

  // Introduces this host to a member, with the records that connect it to the pool.
  async function greet(P, pk, options) {
    const key = `${P.id} ${pk}`;
    if (!open(P) || (snubbed.get(key) ?? 0) > host.now()) return false;
    const chain = chainOf(P);
    const hello = await host.peers.ask(P.id, pk, 'hello', { member: own(P), ...(chain.length > 0 ? { chain } : {}) }, options);
    if (!hello.ok) {
      // A member that will not have this host is not asked again every minute.
      if (hello.code) snubbed.set(key, host.now() + PEER_BACKOFF_MAX_MS / 1000);
      return false;
    }
    snubbed.delete(key);
    const plan = open(P) ? P.pool.reconcile(hello.body.index, host.now()) : null;
    if (plan) await exchange(P, pk, plan);
    return true;
  }

  /// Sends a request to a member of a pool and answers as `peers.ask` does. A member that
  /// does not know this host yet is told who it is, and asked again. A request to this
  /// host itself is handled in place.
  async function send(P, to, kind, body, options) {
    if (to === host.self) return asResult(await host.handle(P, to, kind, body));
    const answer = await host.peers.ask(P.id, to, kind, body, options);
    if (answer.code !== 'not-member' || !(await greet(P, to, options))) return answer;
    return host.peers.ask(P.id, to, kind, body, options);
  }

  /// Brings this host and one member to the same state.
  async function syncWith(P, pk) {
    const key = `${P.id} ${pk}`;
    if (syncing.has(key) || !open(P)) return;
    syncing.add(key);
    try {
      if (!P.pool.known(host.now()).some((m) => m.pk === pk)) {
        if (await greet(P, pk)) post(P, pk, [memberKey(host.self)]);
        return;
      }
      const asOf = host.now();
      const answer = await send(P, pk, 'sync', { asOf, hash: P.pool.stateHash(asOf) });
      const plan = answer.ok && open(P) && isObject(answer.body.index) ? P.pool.reconcile(answer.body.index, asOf) : null;
      if (plan) await exchange(P, pk, plan);
    } finally {
      syncing.delete(key);
    }
  }

  function post(P, pk, keys) {
    if (keys.length === 0) return;
    const key = `${P.id} ${pk}`;
    if (!outbox.has(key)) outbox.set(key, { keys: new Set(), busy: false });
    const box = outbox.get(key);
    for (const k of keys) box.keys.add(k);
    if (!box.busy) drain(P, pk, box).catch((err) => host.log(`a push failed: ${err?.stack ?? err}`));
  }

  async function drain(P, pk, box) {
    box.busy = true;
    // Whatever else this turn signs for the member goes out in the same push.
    await null;
    try {
      while (box.keys.size > 0 && open(P)) {
        const keys = [...box.keys].slice(0, BATCH);
        for (const k of keys) box.keys.delete(k);
        const records = P.pool.records(keys);
        // A push that goes unanswered is not repeated: the next sync carries it.
        if (records.length > 0) await send(P, pk, 'push', { records });
      }
    } finally {
      box.busy = false;
    }
  }

  /// Pushes the records under `keys` to every member of the pool but `except`.
  function spread(P, keys, except = null) {
    for (const pk of others(P)) {
      if (pk !== except) post(P, pk, keys);
    }
  }

  /// Syncs every pool with every member now.
  function syncAll() {
    for (const P of host.pools.values()) {
      for (const pk of others(P)) syncWith(P, pk).catch((err) => host.log(`a sync failed: ${err?.stack ?? err}`));
    }
  }

  /// Starts the periodic sync; `stop` ends it.
  function start() {
    const again = () => {
      timer = host.clock.setTimeout(() => {
        syncAll();
        again();
      }, SYNC_INTERVAL_MS * (0.75 + jitter() / 2));
    };
    again();
  }

  function stop() {
    host.clock.clearTimeout(timer);
  }

  /// What came due: a member record older than the re-signing interval, or one that
  /// states another `maxAcceptedH` than the settings, is signed again; records past
  /// their retention are dropped.
  function step() {
    const now = host.now();
    for (const P of host.pools.values()) {
      const mine = own(P);
      if (now - mine.at >= RESIGN_INTERVAL_MS / 1000 || mine.maxAcceptedH !== hoursOf(host.settings().maximumAcceptedH)) {
        host.take(P, signMember(P));
        spread(P, [memberKey(host.self)]);
      }
    }
    if (now - pruned < PRUNE_INTERVAL_MS / 1000) return;
    pruned = now;
    for (const P of host.pools.values()) {
      const before = P.pool.records().length;
      P.pool.prune(now);
      if (P.pool.records().length !== before) host.moved(P);
    }
  }

  /// An invite to a pool this host is a member of, as a token.
  function invite({ pool, ttlSecs = INVITE_TTL_SECS }) {
    const P = host.pools.get(pool);
    if (!P) throw new Error(`pool ${pool} is not linked here`);
    const exp = host.now() + ttlSecs;
    return { invite: inviteToken(createInvite(host.id, { pool, exp, nonce: host.random(16) })) };
  }

  /// Joins the pool an invite is for: this host's member record carries the invite from
  /// here on, and the inviter is greeted until it answers.
  function join({ invite: token }) {
    const parsed = parseInvite(token);
    if (!parsed) throw new Error('not an invite');
    const P = host.pools.get(parsed.pool);
    if (!P) throw new Error(`pool ${parsed.pool} is not linked here`);
    const verdict = verifyInvite(parsed, { pool: P.id, now: host.now() });
    if (!verdict.ok || parsed.by === host.self) throw new Error(`the invite cannot be used: ${verdict.code ?? 'it is this host\'s own'}`);
    P.inviter = parsed.by;
    host.take(P, signMember(P, { voucher: token }));
    syncWith(P, parsed.by).catch((err) => host.log(`a hello failed: ${err?.stack ?? err}`));
    return { pool: P.id };
  }

  const handlers = {
    hello(P, from, body) {
      const before = P.pool.get(memberKey(from));
      const answer = P.pool.answerHello(body, from, host.now());
      if (answer.body) {
        host.moved(P);
        // The members that have not met the newcomer hear of it from the one that has.
        if (P.pool.get(memberKey(from)) !== before) spread(P, [memberKey(from)], from);
      }
      return answer;
    },
    sync: (P, from, body) => P.pool.answerSync(body, host.now()),
    pull: (P, from, body) => P.pool.answerPull(body),
    push(P, from, body) {
      if (!shaped(body, { records: (v) => Array.isArray(v) && v.length <= MAX_PUSH_RECORDS })) return { error: 'bad-request' };
      const { accepted, refused } = host.take(P, body.records);
      return { body: { accepted, refused } };
    },
  };

  return { link, unlink, send, syncWith, syncAll, spread, start, stop, step, invite, join, handlers };
}
