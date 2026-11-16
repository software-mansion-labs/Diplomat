// Membership and the spread of records: a host's own member record in every pool it
// linked, joining by invite, and keeping every member's state the same as its own - a
// push of each record it signs or lets in, and a periodic sync that repairs what a push
// missed.

import { LockTable } from '../core/claims.js';
import { createInvite, inviteToken, parseInvite, verifyInvite, voucherOf } from '../core/membership.js';
import { MAX_HELLO_CHAIN, MAX_PUSH_RECORDS, Pool } from '../core/pool.js';
import { LIMITS, checkShape, isObject, memberRecord, shaped } from '../core/records.js';
import {
  HOURS_CEILING, HOURS_FLOOR, INVITE_TTL_SECS, PEER_BACKOFF_MAX_MS, PRUNE_INTERVAL_MS, RESIGN_INTERVAL_MS,
  STRANGER_BODY_BYTES, SYNC_INTERVAL_MS,
} from '../paths.js';
import { poolFile } from './store.js';

// Keys per `pull`, and the bytes of records in one `push` or one answer to a `pull`:
// under the body any sender may send, so gossip never waits its turn at a large one.
const BATCH = 256;
const BATCH_BYTES = STRANGER_BODY_BYTES - 4096;
// The pages of one member's index this host asks for in a row: twice what the index of a
// pool at its caps comes to with the longest keys.
const MAX_INDEX_PAGES = 128;
// Why an invite that parses lets nobody in, by `verifyInvite`'s code.
const UNUSABLE = {
  'bad-invite': 'That invite is not signed by the machine it names: ask for a new one.',
  expired: 'That invite has run out: ask for a new one.',
};

// Member and offer records ahead of the claims that rest on them.
const inOrder = (keys) => [...keys].sort((a, b) => a.startsWith('claim/') - b.startsWith('claim/'));

/// The key a pool stores a host's member record under.
export const memberKey = (pk) => `member/${pk}`;
/// The key of a host's offer of a task.
export const offerKey = (taskId, pk) => `offer/${taskId}/${pk}`;
/// The key of a host's claim of a task.
export const claimKey = (taskId, pk) => `claim/${taskId}/${pk}`;

/// The hours a setting stands for: a whole number inside what a record may carry.
export function hoursOf(value) {
  const hours = Math.round(Number(value));
  return Number.isFinite(hours) ? Math.min(HOURS_CEILING, Math.max(HOURS_FLOOR, hours)) : HOURS_FLOOR;
}

// What a pool's document keeps of a membership this host left: the record that says so
// and the members it left behind, or null.
const gone = (doc) => (isObject(doc.left) && Array.isArray(doc.leftTo) ? { left: doc.left, leftTo: doc.leftTo } : null);

// What a handler answered, as the sender of a request sees it.
const asResult = (answer) => (answer.error ? { ok: false, code: answer.error, detail: answer.detail ?? '' } : { ok: true, body: answer.body });

/// The membership and gossip of `host`.
export function createGossip(host) {
  const outbox = new Map(); // "pool pk" -> { keys, busy }: what is still to be pushed to that member
  const syncing = new Set(); // "pool pk" of every sync in flight
  const snubbed = new Map(); // "pool pk" -> when a member that refused a hello is greeted again
  const told = new Map(); // "pool pk" -> when a host is next told that this one left the pool
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

  // A pool over what the store holds of it.
  function load(info, doc) {
    const P = {
      id: info.id, link: info, pool: new Pool({ id: info.id, self: host.self }),
      locks: new LockTable(host.heldLocks[info.id] ?? []),
      seq: Number.isSafeInteger(doc.seq) ? doc.seq : -1, inviter: null,
      // The invites this host gave since it last became a member, each `{ nonce, exp }`,
      // and what is kept of the membership it left before this one.
      invites: [], farewell: gone(doc),
    };
    // The locks read at startup are taken up once: a pool linked again starts without them.
    delete host.heldLocks[info.id];
    if ((doc.linked || doc.away) && Array.isArray(doc.records)) {
      // What the store holds was let in once. A clock that woke up behind those records
      // must not make them the future, and this host a stranger to its own pool.
      P.pool.merge(doc.records, doc.records.reduce((latest, r) => (Number.isSafeInteger(r?.at) ? Math.max(latest, r.at) : latest), host.now()));
      P.inviter = typeof doc.inviter === 'string' ? doc.inviter : null;
      if (Array.isArray(doc.invites)) P.invites = doc.invites;
    }
    return P;
  }

  /// Links a pool: what the store holds of it is taken up again, and the host is a member
  /// of it at once, alone until it joins or invites someone. A pool this host left stays
  /// left.
  function link(info) {
    const doc = host.store.read(poolFile(info.id)) ?? {};
    if (doc.away === true) {
      host.away.set(info.id, info);
      return;
    }
    const P = load(info, doc);
    if (!own(P)) {
      P.inviter = null;
      P.invites = [];
      P.pool.merge(signMember(P, { voucher: undefined }), host.now());
    }
    host.pools.set(P.id, P);
    host.save(P);
  }

  /// Pushes the records under `keys` to every member now, whatever the backoff; settles
  /// once each of them has answered or failed to.
  function tell(P, keys) {
    const records = P.pool.records(keys);
    if (records.length === 0) return Promise.resolve();
    return Promise.all(others(P).map((pk) => host.peers.ask(P.id, pk, 'push', { records }, { fresh: true }).catch(() => {})));
  }

  /// Leaves a pool: the record saying so and `keys`, the other records this host signed
  /// on its way out, are pushed to every member once. Of a pool that is no longer linked
  /// nothing is kept but that record, the members it is for, and the sequence number the
  /// next member record must exceed. A pool that `stay`s linked is away: the member
  /// records and the inviter are kept too, for the day the host joins it again.
  function unlink(P, keys, stay) {
    const leftTo = others(P);
    const left = signMember(P, { left: true });
    P.pool.merge(left, host.now());
    host.pools.delete(P.id);
    const doc = { id: P.id, linked: false, seq: P.seq, left, leftTo };
    if (stay) {
      host.away.set(P.id, P.link);
      // A lock granted binds for its time, whether or not the host is a member meanwhile.
      host.heldLocks[P.id] = P.locks.entries();
      Object.assign(doc, { away: true, inviter: P.inviter, records: P.pool.records().filter((r) => r.type === 'member') });
    }
    host.store.write(poolFile(P.id), doc);
    tell(P, [...keys, memberKey(host.self)]);
  }

  /// A pool this host left is no longer linked either: linked again it is a pool of its own.
  function forget(id) {
    const doc = host.store.read(poolFile(id)) ?? {};
    host.away.delete(id);
    host.store.write(poolFile(id), { id, linked: false, seq: doc.seq, ...gone(doc) });
  }

  // Back into a pool this host left: its member record is signed again over the voucher
  // it held, and every member it knew is told.
  function rejoin(id) {
    const P = load(host.away.get(id), host.store.read(poolFile(id)) ?? {});
    P.farewell = null;
    P.pool.merge(signMember(P), host.now());
    host.away.delete(id);
    host.pools.set(id, P);
    host.moved(P);
    for (const pk of others(P)) syncWith(P, pk).catch((err) => host.log(`a hello failed: ${err?.stack ?? err}`));
    return P;
  }

  /// A host this one does not take for a member asked about a pool. When this host left
  /// that pool while the asker was a member of it, the asker may not have heard, and is
  /// sent the record that says so. Nobody else is sent anything: a key this host never
  /// knew as a member is neither dialled nor worked for.
  function farewell(pool, to) {
    const P = host.pools.get(pool);
    const was = P ? P.farewell : gone(host.store.read(poolFile(pool)) ?? {});
    const key = `${pool} ${to}`;
    const now = host.now();
    if (!was?.leftTo.includes(to) || (told.get(key) ?? 0) > now) return;
    told.set(key, now + PEER_BACKOFF_MAX_MS / 1000);
    host.peers.ask(pool, to, 'push', { records: [was.left] }, { fresh: true }).catch(() => {});
  }

  /// Does a `hello` carry an invite to the pool signed by a key this host accepts? Its
  /// sender was asked in, and is told why when it is not let in.
  function invited(P, body) {
    const invite = parseInvite(body?.member?.voucher?.invite);
    return invite !== null && verifyInvite(invite, { pool: P.id }).ok && P.pool.vouched(invite.by, host.now());
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

  // The records under the first of `keys` that fit one body, and how many keys that
  // took. A record too large to share a body travels alone.
  function batch(P, keys) {
    const records = [];
    let [bytes, used] = [0, 0];
    for (const key of keys.slice(0, BATCH)) {
      const record = P.pool.get(key);
      const size = record ? Buffer.byteLength(JSON.stringify(record)) : 0;
      if (records.length > 0 && bytes + size > BATCH_BYTES) break;
      if (record) records.push(record);
      bytes += size;
      used += 1;
    }
    return { records, used };
  }

  // Pulls what a member holds and this host lacks, and queues what it lacks for a push.
  // A pull is answered with as much as fits, from the front: the next asks from there.
  async function exchange(P, pk, plan) {
    let keys = inOrder(plan.pull);
    while (keys.length > 0) {
      const asked = keys.slice(0, BATCH);
      const pulled = await host.peers.ask(P.id, pk, 'pull', { keys: asked });
      if (!open(P)) return;
      const records = pulled.ok && Array.isArray(pulled.body.records) ? pulled.body.records.slice(0, asked.length) : [];
      host.take(P, records);
      // Whatever the member answered with, the next pull starts past the last record of
      // the answer only when this host holds that record.
      const { key } = checkShape(records.at(-1), P.id);
      const reached = key && P.pool.get(key) ? asked.indexOf(key) : -1;
      if (reached === -1) break;
      keys = keys.slice(reached + 1);
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
      // A member that will not have this host is not asked again every minute. One that
      // could not serve the request this once said nothing of the kind.
      if (hello.code && hello.code !== 'busy') snubbed.set(key, host.now() + PEER_BACKOFF_MAX_MS / 1000);
      return false;
    }
    snubbed.delete(key);
    await settle(P, pk, hello.body, host.now());
    return true;
  }

  // Reconciles with a member from the first page of its index, `first`, which it
  // answered with at `asOf`, and asks for the pages after it one by one.
  async function settle(P, pk, first, asOf) {
    let [page, at, after] = [first, asOf, ''];
    for (let n = 0; n < MAX_INDEX_PAGES && open(P) && isObject(page?.index); n += 1) {
      const more = page.more === true;
      const plan = P.pool.reconcile(page.index, at, { after, more });
      if (!plan) return;
      await exchange(P, pk, plan);
      if (!more) return;
      [at, after] = [host.now(), Object.keys(page.index).sort().at(-1)];
      const answer = await host.peers.ask(P.id, pk, 'sync', { asOf: at, hash: P.pool.stateHash(at), after });
      page = answer.ok ? answer.body : null;
    }
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
      if (answer.ok) await settle(P, pk, answer.body, asOf);
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
        const keys = inOrder(box.keys);
        const { records, used } = batch(P, keys);
        for (const k of keys.slice(0, used)) box.keys.delete(k);
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
  /// their retention and locks past their grant are dropped.
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
      if (P.locks.prune(now)) host.saveLocks();
    }
  }

  // What the operator is told about a pool this host cannot act in.
  const noPool = (pool) => new Error(host.away.has(pool)
    ? `This machine left the pool ${pool}: join it again first.` : `The pool ${pool} is not linked on this machine.`);

  /// An invite to a pool this host is a member of, as a token.
  function invite({ pool, ttlSecs = INVITE_TTL_SECS }) {
    const P = host.pools.get(pool);
    if (!P) throw noPool(pool);
    const now = host.now();
    if (P.pool.records().filter((record) => record.type === 'member').length >= LIMITS.members) {
      throw new Error(`The pool ${pool} has the ${LIMITS.members} members a pool holds: nobody can join it.`);
    }
    const made = createInvite(host.id, { pool, exp: now + ttlSecs, nonce: host.random(16) });
    P.invites = [...P.invites.filter((given) => given.exp > now), { nonce: made.nonce, exp: made.exp }];
    host.save(P);
    return { invite: inviteToken(made) };
  }

  /// Joins the pool an invite is for: this host's member record carries the invite from
  /// here on, and the inviter is greeted until it answers. With `pool` and no invite, the
  /// host goes back into a pool it left, as the member it was.
  function join({ invite: token, pool }) {
    if (token === undefined) {
      if (host.away.has(pool)) rejoin(pool);
      else if (!host.pools.has(pool)) throw noPool(pool);
      return { pool };
    }
    const parsed = parseInvite(token);
    if (!parsed) throw new Error('That is not an invite: paste the whole token the other machine made.');
    if (!host.pools.has(parsed.pool) && !host.away.has(parsed.pool)) throw noPool(parsed.pool);
    const verdict = verifyInvite(parsed, { pool: parsed.pool, now: host.now() });
    if (!verdict.ok) throw new Error(UNUSABLE[verdict.code]);
    if (parsed.by === host.self) throw new Error('That invite was made on this machine: it lets another machine in, not this one.');
    const P = host.pools.get(parsed.pool) ?? rejoin(parsed.pool);
    P.inviter = parsed.by;
    P.farewell = null;
    host.take(P, signMember(P, { voucher: token }));
    syncWith(P, parsed.by).catch((err) => host.log(`a hello failed: ${err?.stack ?? err}`));
    return { pool: P.id };
  }

  const handlers = {
    hello(P, from, body) {
      const now = host.now();
      // An invite is good for the membership it was given in: one this host signed before
      // it left the pool, or holds no note of, lets nobody in.
      const spent = (record) => {
        const invite = isObject(record) ? voucherOf(record) : null;
        return invite?.by === host.self && now < invite.exp && !P.pool.accepts(record.pk, now)
          && !P.invites.some((given) => given.nonce === invite.nonce);
      };
      if (isObject(body) && [body.member, ...(Array.isArray(body.chain) ? body.chain : [])].some(spent)) {
        return { error: 'denied', detail: 'that invite is no longer good' };
      }
      const before = P.pool.get(memberKey(from));
      const answer = P.pool.answerHello(body, from, now);
      const changed = P.pool.get(memberKey(from)) !== before;
      // A hello that is refused may still have brought a record that is kept.
      if (answer.body || changed) host.moved(P);
      // The members that have not met the newcomer hear of it from the one that has.
      if (answer.body && changed) spread(P, [memberKey(from)], from);
      return answer;
    },
    sync: (P, from, body) => P.pool.answerSync(body, host.now()),
    pull(P, from, body) {
      const answer = P.pool.answerPull(body);
      return answer.error ? answer : { body: { records: batch(P, body.keys).records } };
    },
    push(P, from, body) {
      if (!shaped(body, { records: (v) => Array.isArray(v) && v.length <= MAX_PUSH_RECORDS })) return { error: 'bad-request' };
      const { accepted, refused } = host.take(P, body.records);
      return { body: { accepted, refused } };
    },
  };

  return {
    link, unlink, forget, tell, noPool, farewell, invited, send, syncWith, syncAll, spread, start, stop, step, invite, join,
    handlers,
  };
}
