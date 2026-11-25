// Membership and the spread of records: a host's own member record in every pool it
// linked, joining by invite, and keeping every member's state the same as its own - a
// push of each record it signs or lets in, repeated for an offer of its own, and a
// periodic sync that repairs what a push missed.

import { LockTable } from '../core/claims.js';
import { createInvite, createVoucher, inviteToken, parseInvite, verifyInvite, verifyVoucher } from '../core/membership.js';
import { MAX_HELLO_CHAIN, MAX_PUSH_RECORDS, Pool } from '../core/pool.js';
import { LIMITS, checkShape, isObject, memberRecord, shaped } from '../core/records.js';
import {
  CATCH_UP_MS, HOURS_CEILING, HOURS_FLOOR, INVITE_TTL_SECS, MAX_FORMER, PEER_BACKOFF_MAX_MS, PEER_BACKOFF_MS, PRUNE_INTERVAL_MS,
  PUSH_REPEAT_MS, MEMBER_RETENTION_SECS, RESIGN_INTERVAL_MS, SEARCH_INTERVAL_MS, STRANGER_BODY_BYTES, SYNC_INTERVAL_MS, WAKE_GAP_MS,
} from '../paths.js';
import { asksFile, heardFile, poolFile, readPool } from './store.js';

// Keys per `pull`, and the bytes of records in one `push` or one answer to a `pull`:
// under the body any sender may send, so gossip never waits its turn at a large one.
const BATCH = 256;
const BATCH_BYTES = STRANGER_BODY_BYTES - 4096;
// The pages of one member's index this host asks for in a row: twice what the index of a
// pool at its caps comes to with the longest keys.
const MAX_INDEX_PAGES = 128;
// When another host of a pool was last heard is written no more often than this: a
// restart loses less of it than any silence it is judged by.
const HEARD_GRAIN_SECS = 10 * 60;
// The most hosts a host asks in a pool besides its members: one for every seat there.
const MAX_BACK = LIMITS.members;
// The search asks one key no sooner than this after another, and no key is due later
// than MOST_DUE_SECS on: the first `due` is half an interval on, the next up to one and
// a half.
const SEARCH_GAP_SECS = SEARCH_INTERVAL_MS / 1000 / MAX_FORMER;
const MOST_DUE_SECS = 1.5 * SEARCH_INTERVAL_MS / 1000;
// A key this host left a pool to is pushed the record saying so no sooner than this
// after the last time.
const FAREWELL_GAP_SECS = 24 * 3600;
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

// A seat refused to a key the invite's maker sits under, and what the refused host's
// operator reads of it: that host seated the maker, or one that did, before it began
// the pool again.
const SITS_UNDER = 'the maker of that invite sits under the key that brings it';
const SITS_UNDER_HERE = 'the machine that made that invite came into the pool under this one, before this one began the pool again, and no machine that came in under this one can let it back in: use an invite of one that did not, or - if this machine began that pool, so that every machine there came in under it - have them join this one\'s pool, each by an invite this machine makes';

// What a pool's document keeps of a membership this host left: the record that says so
// and the members it left behind, or null.
const gone = (doc) => (isObject(doc.left) && Array.isArray(doc.leftTo) ? { left: doc.left, leftTo: doc.leftTo } : null);

// Of the member records a pool dropped, `{ record, code }` each, the ones that ran out: a
// record whose seat went to another key is of no host that may have been cut off.
const ranOut = (dropped) => dropped.filter((d) => d.code === 'expired').map((d) => d.record);

// What a handler answered, as the sender of a request sees it.
const asResult = (answer) => (answer.error ? { ok: false, code: answer.error, detail: answer.detail ?? '' } : { ok: true, body: answer.body });

/// The membership and gossip of `host`.
export function createGossip(host) {
  const outbox = new Map(); // "pool pk" -> { keys, busy }: what is still to be pushed to that member
  // "pool pk" -> { records, tries, timer }: the records of this host's own, by key, that
  // member has not said it holds, how often they were pushed again, and the next time
  const owed = new Map();
  const syncing = new Set(); // "pool pk" of every sync in flight
  const snubbed = new Map(); // "pool pk" -> when a member that refused a hello is greeted again
  const redeeming = new Map(); // pool -> when the member that invited this host is asked for its voucher again, Infinity while it is being asked
  const told = new Map(); // "pool pk" -> when a host is next told that this one left the pool
  let timer = null;
  let pruned = 0;

  const own = (P) => P.pool.get(memberKey(host.self));
  const open = (P) => host.open(P);
  const jitter = () => host.random(4).readUInt32BE(0) / 2 ** 32;

  // This host's next member record in a pool. `voucher`, when named, replaces the one it
  // holds: the one a member signed for it, undefined to stand alone as the first of a
  // pool. The voucher is dated by its signer's clock, and the record no earlier.
  function signMember(P, change = {}) {
    const held = own(P);
    const voucher = Object.hasOwn(change, 'voucher') ? change.voucher : held?.voucher;
    P.seq += 1;
    return memberRecord(host.id, {
      pool: P.id, seq: P.seq, at: Math.max(host.now(), voucher?.at ?? 0), era: held?.era ?? P.seq,
      maxAcceptedH: hoursOf(host.settings().maximumAcceptedH), voucher, left: change.left === true,
    });
  }

  // A pool over what the store holds of it.
  function load(info, doc) {
    const P = {
      id: info.id, link: info, pool: new Pool({ id: info.id, self: host.self }),
      locks: new LockTable(host.heldLocks[info.id] ?? []),
      seq: Number.isSafeInteger(doc.seq) ? doc.seq : -1,
      // The invite this host is joining by, `{ invite, by, exp }`, until the member that
      // made it has signed the voucher; the invites this host gave since it last became a
      // member, each `{ nonce, exp }` and, for the keys that came with it, `seats` - the
      // seat each was given, by key; and what is kept of the membership it left before
      // this one. `joinFailed` says why the last invite let this host in nowhere, until
      // the next one is pasted. `heard` is when another host of the pool last answered
      // this one or was served by it, and `waitedOut` the last such time whose silence
      // this host waited out alone. `online` counts the seconds this host ran in the pool
      // with its transport up: the time it can have asked anyone. `returning` is true from
      // when this host goes back into the pool, or has heard nobody there for longer than
      // a member record is kept, until a host it asks answers or every one it asks has
      // been asked for as long. `back` are the hosts it asks besides the members it holds
      // - the ones it left the pool to, the ones whose records ran out while it heard
      // nobody, and, from when it comes back, every one it holds a record of - each
      // `{ pk, from }`, `from` the `online` it was first asked at: asked until it answers,
      // its record is held while this host is not returning, or it has been asked for as
      // long as a member record is kept. `met` are the members this host heard from
      // themselves - a request of theirs, or a hello it let in - while their records were
      // fresh, and `metMoved` whether one was added since they were written. `former` are
      // those of them whose records ran out here, the latest last, each `{ pk, due, by }`,
      // `by` the member that seated it: asked about once in SEARCH_INTERVAL_MS, from `due`
      // on, whether it is still in the pool, and no two of them sooner than `searchAt`
      // after each other. `asksKept` is the `[back, former]` the store holds, `duesMoved`
      // whether a `due` moved since, and `duesKept` when one was last written.
      joining: null, joinFailed: '', invites: [], farewell: gone(doc), heard: host.now(), waitedOut: null, online: 0,
      onlineKept: 0, stepped: host.now(), returning: false, back: [], met: new Set(), metMoved: false, former: [],
      searchAt: host.now(), asksKept: null, duesMoved: false, duesKept: host.now(),
      // The members that refused this host's hello and have answered it nothing since.
      refusedBy: new Set(),
      // Until the heard file exists the first word heard is written at once: a restart
      // without it reads when this host last signed, which it does alone too.
      heardKept: false,
      // Since when what this host holds of the pool may be out of date - it started, it
      // slept, its transport came up - or null once a member has said what it holds:
      // until then this host gives none of its offers away and looks after none. `epoch`
      // counts the times it went out of date, and `catching` is the epoch the members
      // are being asked about.
      stale: host.now(), epoch: 0, catching: null,
    };
    P.asksKept = [P.back, P.former];
    // The locks read at startup are taken up once: a pool linked again starts without them.
    delete host.heldLocks[info.id];
    if ((doc.linked || doc.away) && Array.isArray(doc.records)) {
      // What the store holds was let in once. A clock that woke up behind those records
      // must not make them the future, and this host a stranger to its own pool.
      const { refused } = P.pool.merge(doc.records, doc.records.reduce((latest, r) => (Number.isSafeInteger(r?.at) ? Math.max(latest, r.at) : latest), host.now()));
      if (isObject(doc.joining)) P.joining = doc.joining;
      if (typeof doc.joinFailed === 'string') P.joinFailed = doc.joinFailed;
      if (Array.isArray(doc.invites)) P.invites = doc.invites;
      const kept = host.store.read(heardFile(P.id));
      if (Number.isSafeInteger(kept?.online)) [P.online, P.onlineKept] = [kept.online, kept.online];
      // A store before this one kept them in the pool's document: the hosts it is back to
      // each with when it was asked until, by the clock - each is asked for as long again -
      // and the keys it searches for with no time each is due - each is due now.
      const asks = host.store.read(asksFile(P.id));
      const was = asks ?? doc;
      if (Array.isArray(was.back)) {
        P.back = was.back.filter((e) => typeof e?.pk === 'string').map((e) => ({ pk: e.pk, from: Number.isSafeInteger(e.from) ? e.from : P.online })).slice(0, MAX_BACK);
      }
      if (Array.isArray(was.former)) {
        P.former = fit(was.former.map((e) => (typeof e === 'string' ? { pk: e, due: host.now() } : e))
          .filter((e) => typeof e?.pk === 'string' && Number.isSafeInteger(e.due))
          .map((e) => ({ pk: e.pk, due: e.due, by: typeof e.by === 'string' ? e.by : e.pk })));
      }
      // A store before this one kept no `met`: every member it held counts.
      P.met = new Set(Array.isArray(kept?.met) ? kept.met : doc.records.filter((r) => r?.type === 'member').map((r) => r.pk));
      if (asks) P.asksKept = [P.back, P.former];
      // Kept in the document by a store before this one, and moved out of it before the
      // document is written without it; in none before that, it is about when this host
      // last signed, as a host that was there signs every 6 hours.
      const heard = [kept?.heard, doc.heard, own(P)?.at].find(Number.isSafeInteger);
      if (heard !== undefined) P.heard = heard;
      if (Number.isSafeInteger(kept?.waitedOut)) P.waitedOut = kept.waitedOut;
      P.heardKept = kept !== null;
      if (!kept && Number.isSafeInteger(doc.heard)) keepHeard(P);
      P.returning = doc.returning === true;
      // The store holds all of this: nothing is written until something changes.
      P.pool.delta();
      P.head = host.head(P);
      const code = new Map(refused.map((r) => [r.key, r.code]));
      const dropped = ranOut(doc.records.filter((r) => r?.type === 'member').map((record) => ({ record, code: code.get(memberKey(record.pk)) })));
      P.former = formerWith(P, dropped);
      P.back = backTo(P, lapsed(P, dropped));
      overdue(P, host.now());
      keepAsks(P);
    }
    return P;
  }

  // The keys of the members among `records` that no other host answered this one after
  // they last signed: one whose record runs out may have been cut off from this host
  // rather than gone. One that ran out after another answered is of a host that stopped
  // signing.
  const lapsed = (P, records) => records.filter((r) => r?.type === 'member' && !r.left && r.pk !== host.self
    && P.heard < r.at + 2 * RESIGN_INTERVAL_MS / 1000).map((r) => r.pk);

  // Silent for longer than a member record is kept, every host this one knows in the
  // pool may have forgotten it: it comes back. True when it did so now.
  function overdue(P, now) {
    if (P.returning || P.waitedOut === P.heard || now - P.heard <= MEMBER_RETENTION_SECS) return false;
    comeBack(P, []);
    return true;
  }

  // This host comes back to a pool: it asks `keys` and every host it holds a record of
  // there for as long as a member record is kept, whatever it holds of them - the records
  // its voucher leads up through are kept at any age, and say nothing of whether their
  // hosts are there.
  function comeBack(P, keys) {
    const held = P.pool.records().filter((r) => r.type === 'member' && !r.left).map((r) => r.pk);
    P.returning = true;
    P.back = backTo(P, [...keys, ...held]);
    keepAsks(P);
  }

  // `P.back` with each of `keys` it does not name, asked from now for as long as a member
  // record is kept: the MAX_BACK asked from the latest.
  function backTo(P, keys) {
    const added = [...new Set(keys)].filter((pk) => pk !== host.self && !P.back.some((e) => e.pk === pk)).map((pk) => ({ pk, from: P.online }));
    const back = [...P.back, ...added];
    return back.sort((x, y) => y.from - x.from).slice(0, MAX_BACK).sort((x, y) => (x.pk < y.pk ? -1 : x.pk > y.pk ? 1 : 0));
  }

  // `P.former` with the members among `records` this host met that left nothing to say
  // they left, each first asked half an interval on.
  function formerWith(P, records) {
    const added = new Map(records.filter((r) => !r.left && P.met.has(r.pk)).map((r) => [r.pk, r.voucher?.by ?? r.pk]));
    if (added.size === 0) return P.former;
    const due = host.now() + SEARCH_INTERVAL_MS / 2000;
    return fit([...P.former.filter((e) => !added.has(e.pk)), ...[...added].map(([pk, by]) => ({ pk, due, by }))]);
  }

  // `former` with the latest LIMITS.invitees of each member that seated them - as many as
  // it has seats - and of those the latest MAX_FORMER, the earliest going first of the
  // members that seated more than their share: no member's keys push out another's.
  function fit(former) {
    const count = new Map();
    const kept = former.toReversed().filter((e) => count.set(e.by, (count.get(e.by) ?? 0) + 1).get(e.by) <= LIMITS.invitees).reverse();
    count.clear();
    for (const e of kept) count.set(e.by, (count.get(e.by) ?? 0) + 1);
    while (kept.length > MAX_FORMER) {
      const [e] = kept.splice(kept.findIndex((x) => count.get(x.by) > MAX_FORMER / count.size), 1);
      if (count.get(e.by) === 1) count.delete(e.by);
      else count.set(e.by, count.get(e.by) - 1);
    }
    return kept;
  }

  // `P.met` without the keys this host holds no member record of - by the records, not
  // the roster: a key leaves the roster before its record runs out into `former`.
  function pruneMet(P) {
    const held = new Set(P.pool.records().filter((r) => r.type === 'member').map((r) => r.pk));
    for (const pk of P.met) if (!held.has(pk)) P.met.delete(pk);
  }

  // Asks the host of `P.former` due the longest that this one holds no record of again
  // whether it is still in the pool, and the next no sooner than SEARCH_GAP_SECS on:
  // however many are due, there is no burst of proofs of work. A `due` further on than
  // any is set - put there by a clock that ran ahead - is the furthest.
  function search(P, now) {
    for (const e of P.former) {
      if (e.due > now + MOST_DUE_SECS) [e.due, P.duesMoved] = [now + MOST_DUE_SECS, true];
    }
    const due = P.former.filter((e) => e.due <= now && !P.pool.get(memberKey(e.pk)));
    if (due.length === 0) return;
    const next = due.reduce((x, y) => (y.due < x.due ? y : x));
    next.due = now + Math.round((SEARCH_INTERVAL_MS / 1000) * (0.5 + jitter()));
    P.duesMoved = true;
    P.searchAt = now + SEARCH_GAP_SECS;
    meet(P, next.pk, { fresh: true }).catch((err) => host.log(`a search failed: ${err?.stack ?? err}`));
  }

  // Writes what this host asks in a pool when it changed - or, when only a `due` moved,
  // once the last write is HEARD_GRAIN_SECS away by the clock, either way: a restart asks
  // a key again that much sooner at most.
  function keepAsks(P) {
    const [back, former] = P.asksKept;
    if (back === P.back && former === P.former && !(P.duesMoved && Math.abs(host.now() - P.duesKept) >= HEARD_GRAIN_SECS)) return;
    host.store.write(asksFile(P.id), { back: P.back, former: P.former });
    [P.asksKept, P.duesMoved, P.duesKept] = [[P.back, P.former], false, host.now()];
  }

  /// Links a pool: what the store holds of it is taken up again, and the host is a member
  /// of it at once, alone until it joins or invites someone. A pool this host left stays
  /// left.
  function link(info) {
    const doc = readPool(host.store, info.id) ?? {};
    if (doc.away === true) {
      host.away.set(info.id, info);
      return;
    }
    const P = load(info, doc);
    if (!own(P)) {
      P.joining = null;
      P.invites = [];
      P.pool.merge(signMember(P, { voucher: undefined }), host.now());
    }
    host.pools.set(P.id, P);
    host.save(P);
  }

  /// Pushes the records under `keys` now, whatever the backoff, to every host this one
  /// asks - to one it holds no member record of, the member records among them alone;
  /// settles, with `[pk, answer]` of each it pushed to, once each has answered or failed to.
  function tell(P, keys) {
    const records = P.pool.records(keys);
    const theirs = new Set(members(P));
    return Promise.all(others(P).map(async (pk) => {
      const pushed = theirs.has(pk) ? records : records.filter((r) => r.type === 'member');
      if (pushed.length === 0) return null;
      return [pk, await host.peers.ask(P.id, pk, 'push', { records: pushed }, { fresh: true }).catch(() => null)];
    }));
  }

  /// Leaves a pool: the record saying so and `keys`, the other records this host signed
  /// on its way out, are pushed to every member once. Of a pool that is no longer linked
  /// nothing is kept but that record, the members it is for, and the sequence number the
  /// next member record must exceed. A pool that `stay`s linked is away: the member
  /// records are kept too, for the day the host joins it again.
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
      Object.assign(doc, { away: true, records: P.pool.records().filter((r) => r.type === 'member') });
    }
    host.store.write(poolFile(P.id), doc);
    host.store.remove(asksFile(P.id));
    if (!stay) host.store.remove(heardFile(P.id));
    // That push is the day's farewell of each key it reached.
    for (const pk of leftTo) told.set(`${P.id} ${pk}`, host.now() + FAREWELL_GAP_SECS);
    tell(P, [...keys, memberKey(host.self)]).then((answers) => {
      for (const [pk, answer] of answers.filter(Boolean)) if (!answer || (answer.lost && answer.lost !== 'budget')) told.delete(`${P.id} ${pk}`);
    });
  }

  /// A pool this host left is no longer linked either: linked again it is a pool of its own.
  function forget(id) {
    const doc = host.store.read(poolFile(id)) ?? {};
    host.away.delete(id);
    host.store.write(poolFile(id), { id, linked: false, seq: doc.seq, ...gone(doc) });
    host.store.remove(heardFile(id));
  }

  // Back into a pool this host left: its member record is signed again over the voucher
  // it held, and the hosts it left the pool to are asked with the members it holds.
  function rejoin(id) {
    const P = load(host.away.get(id), host.store.read(poolFile(id)) ?? {});
    comeBack(P, P.farewell?.leftTo ?? []);
    P.farewell = null;
    P.pool.merge(signMember(P), host.now());
    host.away.delete(id);
    host.pools.set(id, P);
    host.moved(P);
    return P;
  }

  /// A host this one does not take for a member asked about a pool. When this host left
  /// that pool while the asker was a member of it, no longer ago than a member record is
  /// kept, the asker may not have heard, and is sent the record that says so - once a day
  /// at most. Nobody else is sent anything: a key this host never knew as a member is
  /// neither dialled nor worked for.
  function farewell(pool, to) {
    const P = host.pools.get(pool);
    const was = P ? P.farewell : gone(host.store.read(poolFile(pool)) ?? {});
    const key = `${pool} ${to}`;
    const now = host.now();
    if (!was?.leftTo.includes(to) || now >= was.left.at + MEMBER_RETENTION_SECS || (told.get(key) ?? 0) > now) return;
    told.set(key, now + FAREWELL_GAP_SECS);
    host.peers.ask(pool, to, 'push', { records: [was.left] }, { fresh: true }).catch(() => {});
  }

  /// Was the sender of a `hello` asked in: does it come with an invite of this host's
  /// own, or with a member record whose voucher a key with a seat here signed? It is
  /// told why when it is not let in.
  function invited(P, body) {
    const invite = parseInvite(body?.invite);
    if (invite) return invite.by === host.self && verifyInvite(invite, { pool: P.id }).ok;
    const record = body?.member;
    return checkShape(record, P.id).ok && record.type === 'member' && record.voucher !== undefined
      && P.pool.vouched(record.voucher.by, host.now()) && verifyVoucher(record);
  }

  // Does this host hold a member record of `pk` in a pool, of a member that has not left:
  // one that signs its record, or one that stopped?
  const member = (P, pk) => P.pool.known(host.now()).some((m) => m.pk === pk);

  /// What a request to `to` about `pool` is paid out of: `member` for a key this host holds
  /// a member record of in a pool it is in. Otherwise it is paid out of the whole hour and
  /// sent once when it goes to the member whose invite this host redeems, or to a key it is
  /// back to while returning; anything else - every request about a pool it left among
  /// them - is a search's, and one to a key in `former` takes no more of the search's share
  /// than the others of the member that seated it: `share` that member, `of` how many
  /// members seated the keys of `former`, in every pool.
  function standing(pool, to) {
    const P = host.pools.get(pool);
    if (!P) return { member: false, search: true };
    if (member(P, to)) return { member: true, search: false };
    if (P.joining?.by === to || (P.returning && P.back.some((e) => e.pk === to))) return { member: false, search: false };
    const seat = P.former.find((e) => e.pk === to);
    if (!seat) return { member: false, search: true };
    // Keys with no seater but themselves - a pool's first member, and every key of a store
    // that kept no seater - take one share between them, or each would bring its own.
    const seater = (Q, e) => (e.by === e.pk ? Q.id : `${Q.id} ${e.by}`);
    const seaters = new Set([...host.pools.values()].flatMap((Q) => Q.former.map((e) => seater(Q, e))));
    return { member: false, search: true, share: { key: seater(P, seat), of: seaters.size } };
  }

  // The other hosts this one holds such a record of in a pool: the ones its records go to.
  const members = (P) => P.pool.known(host.now()).map((m) => m.pk).filter((pk) => pk !== host.self);

  // Every host this one asks in a pool: those, and the ones it is back to.
  function others(P) {
    return [...new Set([...members(P), ...P.back.map((e) => e.pk)])].filter((pk) => pk !== host.self).sort();
  }

  /// Is this host back in a pool after it left or heard nobody there for longer than a
  /// member record is kept, with no answer yet from any host it asked?
  const returning = (P) => P.returning;

  // Has this host heard no other host of a pool for longer than a member takes to sign
  // its record again? Then it may have been cut off from all of them.
  const quiet = (P, now) => now - P.heard > RESIGN_INTERVAL_MS / 1000;

  // What this host holds of a pool may be out of date from now.
  function outdate(P, now) {
    P.stale = now;
    P.epoch += 1;
  }

  /// Another host of a pool answered this one or was served by it: `from`, a member that
  /// asked or a host its hello let in. The first word after a silence that may have been a
  /// cut makes the pool out of date: this host may hold none of what came meanwhile.
  function hears(P, from) {
    const now = host.now();
    doubt(P);
    if (!open(P)) return;
    // A host that is there signs every RESIGN_INTERVAL_MS: one whose record was signed to
    // run out as it speaks is no host this host met.
    const record = !P.met.has(from) && P.pool.known(now).find((m) => m.pk === from);
    if (record && now - record.at < 2 * RESIGN_INTERVAL_MS / 1000) {
      P.met.add(from);
      P.metMoved = true;
    }
    if (P.heardKept && now - P.heard < HEARD_GRAIN_SECS) return;
    P.heard = now;
    keepHeard(P);
  }

  function keepHeard(P) {
    host.store.write(heardFile(P.id), { heard: P.heard, waitedOut: P.waitedOut, online: P.online, met: [...P.met] });
    [P.heardKept, P.onlineKept, P.metMoved] = [true, P.online, false];
  }

  /// This host acts on what it holds of a pool: in one it heard nobody of for long, it
  /// asks the others what it missed first.
  function doubt(P) {
    const now = host.now();
    if (P.stale === null && quiet(P, now)) outdate(P, now);
  }

  // `pk` answered: this host is back in the pool, and `pk` need not be asked as one
  // whose record may be gone. The others it is back to still are: one host that
  // answers may hold no more of the pool than this one, come back with it.
  function answered(P, pk) {
    const back = P.back.filter((e) => e.pk !== pk);
    if (!P.returning && back.length === P.back.length) return;
    [P.returning, P.back] = [false, back];
    keepAsks(P);
    host.save(P);
  }

  // The member records that lead from `pk`, this host unless named, to the member that
  // started the pool.
  function chainOf(P, pk = host.self) {
    const chain = [];
    let record = P.pool.get(memberKey(pk));
    while (record && chain.length < MAX_HELLO_CHAIN) {
      const next = P.pool.get(memberKey(record.voucher?.by));
      if (!next || chain.includes(next)) break;
      chain.push(next);
      record = next;
    }
    return chain;
  }

  // Does `lower` sit in a seat `upper` gave, or in one a key so seated gave?
  const under = (P, lower, upper) => chainOf(P, lower).some((record) => record.pk === upper);

  // The seat of this host's that `pk` gets at `now`: the one it holds or was given by an
  // invite still good, else one that no member holds and no such invite gave away, else
  // that of the key that left or has signed no record for a day whose record is the
  // oldest. Null when this host has none to give.
  function seatFor(P, pk, now) {
    if (P.pool.depth(host.self, now) >= LIMITS.depth) return null;
    const holders = new Map(P.pool.records().filter((r) => r.type === 'member' && r.voucher?.by === host.self).map((r) => [r.voucher.seat, r]));
    // seat -> the key an invite still good gave it to, until that key holds it
    const given = new Map(P.invites.filter((made) => made.exp > now).flatMap((made) => Object.entries(made.seats ?? {}))
      .filter(([key, seat]) => holders.get(seat)?.pk !== key).map(([key, seat]) => [seat, key]));
    const rank = (seat) => {
      const holder = holders.get(seat);
      if (holder?.pk === pk || given.get(seat) === pk) return -1;
      if (given.has(seat)) return Infinity;
      if (!holder) return 0;
      return P.pool.member(holder.pk, now) ? Infinity : 1 + holder.at;
    };
    const [seat] = Array.from({ length: LIMITS.invitees }, (_, n) => n).sort((a, b) => rank(a) - rank(b));
    return rank(seat) < Infinity ? seat : null;
  }

  // The answer to a `hello` that brings an invite: the voucher for the sender's key, and
  // beside it the member records that lead from this host to the member that started
  // the pool. Only the host that made an invite takes it.
  function vouch(P, from, body, now) {
    if (!shaped(body, { invite: (v) => typeof v === 'string' })) return { error: 'bad-request' };
    const invite = parseInvite(body.invite);
    const verdict = invite ? verifyInvite(invite, { pool: P.id, now }) : { ok: false, code: 'bad-invite' };
    if (!verdict.ok) return { error: 'denied', detail: verdict.code };
    // An invite is good for the membership it was given in: one this host signed before
    // it left the pool, or holds no note of, lets nobody in.
    const given = invite.by === host.self ? P.invites.find((made) => made.nonce === invite.nonce) : null;
    if (!given) return { error: 'denied', detail: 'that invite is no longer good' };
    // A seat under this host for a key this host sits under would close the chain.
    if (under(P, host.self, from)) return { error: 'denied', detail: SITS_UNDER };
    const seat = seatFor(P, from, now);
    if (seat === null) return { error: 'denied', detail: 'no-seat' };
    given.seats = { ...given.seats, [from]: seat };
    host.save(P);
    return { body: { voucher: createVoucher(host.id, { pool: P.id, era: own(P).era, pk: from, seat, at: now }), chain: [own(P), ...chainOf(P)] } };
  }

  // Asks the member that invited this host for its voucher. With it this host signs its
  // member record under that member, takes in the records that lead from there to the
  // member that started the pool, and is out of date in that pool until a member has
  // said what it holds. An invite that is refused is given up; one that went unanswered
  // is asked about again.
  async function redeem(P, options) {
    const { joining } = P;
    if (!joining || host.now() < (redeeming.get(P.id) ?? 0)) return;
    redeeming.set(P.id, Infinity);
    let answer;
    try {
      answer = await host.peers.ask(P.id, joining.by, 'hello', { invite: joining.invite }, options);
    } finally {
      redeeming.set(P.id, host.now() + PEER_BACKOFF_MS / 1000);
    }
    if (!open(P) || P.joining !== joining || answer.lost || answer.code === 'busy') return;
    P.joining = null;
    const chain = answer.ok && Array.isArray(answer.body.chain) ? answer.body.chain.slice(0, MAX_HELLO_CHAIN + 1) : [];
    const voucher = answer.ok && isObject(answer.body.voucher) ? answer.body.voucher : null;
    let record = null;
    try {
      record = voucher && signMember(P, { voucher });
    } catch {
      // What the member answered with is no voucher.
    }
    if (record && verifyVoucher(record)) host.take(P, [...chain, record]);
    const failed = own(P) !== record;
    if (failed) P.joinFailed = answer.ok ? 'its voucher does not hold' : answer.detail === SITS_UNDER ? SITS_UNDER_HERE : answer.detail || answer.code;
    host.save(P);
    if (failed) {
      host.log(`the invite to ${P.id} let this host in nowhere: ${P.joinFailed}`);
      return;
    }
    // It holds nothing of the pool it is in from here on. The member that signed the
    // voucher is shown the record that carries it, and then every member is asked: what
    // any of them refused it before, it refused another record.
    for (const pk of P.refusedBy) snubbed.delete(`${P.id} ${pk}`);
    P.stale = host.now();
    P.epoch += 1;
    P.catching = P.epoch;
    try {
      await greet(P, joining.by, { fresh: true });
    } finally {
      if (open(P)) catchUp(P);
    }
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
    // A key this host dropped may answer for no pool at all.
    if (member(P, pk)) post(P, pk, plan.push);
  }

  // Introduces this host to a member, with the records that connect it to the pool.
  async function greet(P, pk, options) {
    const key = `${P.id} ${pk}`;
    if (!open(P) || (snubbed.get(key) ?? 0) > host.now()) return false;
    const chain = chainOf(P);
    const hello = await host.peers.ask(P.id, pk, 'hello', { member: own(P), ...(chain.length > 0 ? { chain } : {}) }, options);
    if (!hello.ok) {
      // A host that refused is not asked again every minute. One that could not serve the
      // request this once said nothing of the kind, and only one that holds this host for
      // no member said it has no seat: the others refused this host's clock or its work.
      if (hello.code && hello.code !== 'busy') snubbed.set(key, host.now() + PEER_BACKOFF_MAX_MS / 1000);
      if (hello.code === 'denied' || hello.code === 'not-member') P.refusedBy.add(pk);
      return false;
    }
    snubbed.delete(key);
    await settle(P, pk, hello.body, host.now());
    // Only a member's answer is the pool heard: a key this host dropped may answer for no
    // pool at all.
    if (!open(P) || !member(P, pk)) return false;
    hears(P);
    answered(P, pk);
    return true;
  }

  // Reconciles with a member from the first page of its index, `first`, which it
  // answered with at `asOf`, and asks for the pages after it one by one.
  async function settle(P, pk, first, asOf) {
    let [page, at, after] = [first, asOf, ''];
    for (let n = 1; open(P) && isObject(page?.index); n += 1) {
      const more = page.more === true;
      const plan = P.pool.reconcile(page.index, at, { after, more });
      if (!plan) return;
      await exchange(P, pk, plan);
      if (!more || n === MAX_INDEX_PAGES) return;
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
    if (answer.ok) hears(P);
    if (answer.code !== 'not-member' || !(await greet(P, to, options))) return answer;
    return host.peers.ask(P.id, to, kind, body, options);
  }

  // Brings this host and one member to the same state; true when the member answered.
  // `options` are those of `peers.ask` for the first request.
  async function meet(P, pk, options) {
    if (!member(P, pk)) {
      const greeted = await greet(P, pk, options);
      if (greeted) post(P, pk, [memberKey(host.self)]);
      return greeted;
    }
    const asOf = host.now();
    const answer = await send(P, pk, 'sync', { asOf, hash: P.pool.stateHash(asOf) }, options);
    if (answer.ok) {
      P.refusedBy.delete(pk);
      answered(P, pk);
      await settle(P, pk, answer.body, asOf);
    }
    return answer.ok;
  }

  /// Has every other host this one keeps in touch with in a pool refused its hello: does
  /// it hold a seat nowhere but in its own state?
  const unseated = (P) => others(P).length > 0 && others(P).every((pk) => P.refusedBy.has(pk));

  /// Brings this host and one member to the same state, unless that is under way.
  async function syncWith(P, pk) {
    const key = `${P.id} ${pk}`;
    if (syncing.has(key) || !open(P)) return;
    syncing.add(key);
    try {
      await meet(P, pk);
    } finally {
      syncing.delete(key);
    }
  }

  /// What this host holds of its pools is as old as the moment it last looked: every
  /// pool is out of date from now.
  function woke() {
    for (const P of host.pools.values()) outdate(P, host.now());
  }

  // A pool that went out of date in `epoch` is up to date - unless it went out of date
  // again since: what a member said before that says nothing of what came after.
  function caughtUp(P, epoch) {
    if (P.stale === null || P.epoch !== epoch) return;
    host.log(`${P.id} is up to date ${host.now() - P.stale} s after this host came back to it`);
    P.stale = null;
  }

  // Asks every member of a pool that is out of date what this host missed, whatever the
  // backoff and whatever sync with them is under way: that one may have asked before
  // there was anything to miss. The pool is up to date once one of them has answered and
  // this host holds what that one held - a member that is asleep keeps nobody waiting -
  // or there is nobody to ask.
  function catchUp(P) {
    const { epoch } = P;
    P.catching = epoch;
    const pks = others(P);
    // With nobody to ask there was nothing to wait for, and nothing to say of it.
    if (pks.length === 0) {
      P.stale = null;
      return undefined;
    }
    const asked = pks.map((pk) => meet(P, pk, { fresh: true }).then((heard) => heard && caughtUp(P, epoch))
      .catch((err) => host.log(`a pool could not be caught up: ${err?.stack ?? err}`)));
    // Where nobody answered, the next step asks again.
    return Promise.all(asked).then(() => {
      if (P.catching === epoch) P.catching = null;
    });
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
        // A push that goes unanswered is left to the next sync, but for what `deliver` repeats.
        if (records.length > 0 && (await send(P, pk, 'push', { records })).ok) holds(P, pk, records);
      }
    } finally {
      box.busy = false;
    }
  }

  /// Pushes the records under `keys` to every member of the pool but `except`.
  function spread(P, keys, except = null) {
    for (const pk of members(P)) {
      if (pk !== except) post(P, pk, keys);
    }
  }

  /// Pushes records of this host's own, under `keys`, to every member, and again after
  /// each of PUSH_REPEAT_MS to a member that has not said it holds them: a push lost on
  /// the way is not left to the next sync.
  function deliver(P, keys) {
    spread(P, keys);
    for (const pk of members(P)) {
      const key = `${P.id} ${pk}`;
      if (!owed.has(key)) owed.set(key, { records: new Map(), tries: 0, timer: null });
      const due = owed.get(key);
      for (const k of keys) due.records.set(k, P.pool.get(k));
      due.tries = 0;
      repeat(P, pk, due);
    }
  }

  // The next push of what a member is owed. It goes out beside whatever push to that
  // member is still unanswered, and like every push only to a member gossip does not
  // leave alone; one this host has not heard for long is left to the sync.
  function repeat(P, pk, due) {
    host.clock.clearTimeout(due.timer);
    due.timer = host.clock.setTimeout(() => {
      due.tries += 1;
      if (due.tries < PUSH_REPEAT_MS.length) repeat(P, pk, due);
      else owed.delete(`${P.id} ${pk}`);
      if (!open(P) || host.peers.patience(pk) === 'short') return;
      const { records } = batch(P, [...due.records.keys()]);
      send(P, pk, 'push', { records }).then((answer) => answer.ok && holds(P, pk, records))
        .catch((err) => host.log(`a push failed: ${err?.stack ?? err}`));
    }, PUSH_REPEAT_MS[due.tries]);
  }

  // A member holds `records`, or with none named all this host holds: it is owed them
  // no more.
  function holds(P, pk, records) {
    const key = `${P.id} ${pk}`;
    const due = owed.get(key);
    if (!due) return;
    for (const [k, record] of due.records) {
      if (!records || records.includes(record)) due.records.delete(k);
    }
    if (due.records.size > 0) return;
    host.clock.clearTimeout(due.timer);
    owed.delete(key);
  }

  // Syncs every pool with every member now.
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

  /// What came due: a pool that is out of date is caught up; a member record older than
  /// the re-signing interval, or one that states another `maxAcceptedH` than the
  /// settings, is signed again; records past their retention and locks past their grant
  /// are dropped.
  function step() {
    const now = host.now();
    for (const P of host.pools.values()) {
      // One asking at a time, and a new one at once for a pool that went out of date
      // again: the answers to the asking before are not waited for. Whatever an asking
      // is at, a pool is out of date for no longer than CATCH_UP_MS with the transport up
      // - unless this host is returning to it: then it waits for an answer, and the
      // periodic sync goes on asking.
      const waited = host.transport.state().state === 'ready' && now - P.stale >= CATCH_UP_MS / 1000;
      if (P.stale !== null && P.catching !== P.epoch && !(waited && returning(P))) catchUp(P);
      if (P.stale !== null && waited && !returning(P)) caughtUp(P, P.epoch);
      if (P.joining && now >= P.joining.exp) {
        P.joining = null;
        P.joinFailed = 'the invite ran out before the machine that made it answered';
        host.save(P);
      }
      redeem(P).catch((err) => host.log(`an invite could not be redeemed: ${err?.stack ?? err}`));
      const up = host.transport.state().state === 'ready';
      // A longer gap is time the host was not running.
      if (up) P.online += Math.max(0, Math.min(now - P.stepped, WAKE_GAP_MS / 1000));
      P.stepped = now;
      P.searchAt = Math.min(P.searchAt, now + SEARCH_GAP_SECS);
      if (up && now >= P.searchAt) search(P, now);
      const dropped = ranOut(P.pool.gone().filter((d) => d.record.type === 'member'));
      const cut = lapsed(P, dropped);
      const former = formerWith(P, dropped);
      const held = new Set(members(P));
      pruneMet(P);
      const kept = P.back.filter((e) => P.online - e.from < MEMBER_RETENTION_SECS && (P.returning || !held.has(e.pk)));
      const back = backTo({ ...P, back: kept }, cut);
      const moved = JSON.stringify(back) !== JSON.stringify(P.back) || former !== P.former;
      if (moved) [P.back, P.former] = [back, former];
      if (P.metMoved || (P.back.length > 0 && P.online - P.onlineKept >= HEARD_GRAIN_SECS)) keepHeard(P);
      const came = overdue(P, now);
      // With every key asked in vain for as long, there is no answer to wait for.
      const alone = P.returning && P.back.length === 0;
      if (alone) {
        [P.returning, P.waitedOut] = [false, P.heard];
        keepHeard(P);
      }
      keepAsks(P);
      if (moved || came || alone) host.save(P);
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
    if (seatFor(P, null, now) === null) {
      throw new Error(P.pool.depth(host.self, now) >= LIMITS.depth
        ? `This machine is ${LIMITS.depth} invites away from the one that started the pool ${pool}, and invites nobody: ask a machine nearer to that one.`
        : `Every one of the ${LIMITS.invitees} machines this one may invite into the pool ${pool} is a member of it: ask another machine of the pool.`);
    }
    const made = createInvite(host.id, { pool, exp: now + ttlSecs, nonce: host.random(16) });
    P.invites = [...P.invites.filter((given) => given.exp > now), { nonce: made.nonce, exp: made.exp }];
    host.save(P);
    return { invite: inviteToken(made) };
  }

  /// Joins the pool an invite is for: the member that made the invite is asked for a
  /// voucher until it answers or the invite runs out, and this host's member record
  /// carries that voucher from then on. With `pool` and no invite, the host goes back
  /// into a pool it left, as the member it was.
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
    const linked = host.pools.get(parsed.pool);
    if (linked && under(linked, parsed.by, host.self)) {
      throw new Error(`The machine that made that invite came into the pool ${parsed.pool} through this one, which is in it already: an invite takes a machine in under its maker. To move this machine, use an invite of a machine that did not come in through it.`);
    }
    const P = linked ?? rejoin(parsed.pool);
    P.joining = { invite: token, by: parsed.by, exp: parsed.exp };
    P.joinFailed = '';
    P.farewell = null;
    host.save(P);
    redeeming.delete(P.id);
    redeem(P, { fresh: true }).catch((err) => host.log(`an invite could not be redeemed: ${err?.stack ?? err}`));
    return { pool: P.id };
  }

  const handlers = {
    hello(P, from, body) {
      const now = host.now();
      if (isObject(body) && Object.hasOwn(body, 'invite')) return vouch(P, from, body, now);
      const before = P.pool.get(memberKey(from));
      const answer = P.pool.answerHello(body, from, now);
      const changed = P.pool.get(memberKey(from)) !== before;
      // A hello that is refused may still have brought a record that is kept.
      if (answer.body || changed) host.moved(P);
      // The members that have not met the newcomer hear of it from the one that has.
      if (answer.body && changed) spread(P, [memberKey(from)], from);
      return answer;
    },
    sync(P, from, body) {
      const answer = P.pool.answerSync(body, host.now());
      // A member that holds exactly what this host holds has told it what it missed:
      // nothing. And it is owed nothing.
      if (answer.body && !answer.body.index) {
        caughtUp(P, P.epoch);
        holds(P, from);
      }
      return answer;
    },
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
    link, unlink, forget, tell, noPool, farewell, invited, send, syncWith, woke, hears, doubt, spread, deliver, start, stop, step,
    invite, join, unseated, returning, standing,
    handlers,
  };
}
