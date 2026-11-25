import { LockTable } from '../core/claims.js';
import { createInvite, createVoucher, inviteToken, parseInvite, verifyInvite, verifyVoucher } from '../core/membership.js';
import { MAX_HELLO_CHAIN, MAX_PUSH_RECORDS, Pool } from '../core/pool.js';
import { LIMITS, checkShape, isObject, memberRecord, shaped } from '../core/records.js';
import {
  CATCH_UP_MS, CLOCK_SKEW_SECS, HOURS_CEILING, HOURS_FLOOR, INVITE_TTL_SECS, MAX_FORMER, PEER_BACKOFF_MAX_MS, PEER_BACKOFF_MS, PRUNE_INTERVAL_MS,
  PUSH_REPEAT_MS, MEMBER_RETENTION_SECS, RESIGN_INTERVAL_MS, SEARCH_INTERVAL_MS, STRANGER_BODY_BYTES, SYNC_INTERVAL_MS, WAKE_GAP_MS,
} from '../paths.js';
import { asksFile, heardFile, poolFile, readPool } from './store.js';

// Keys per `pull`, and record bytes per `push` or `pull` answer: under the body any
// sender may send, so gossip never queues behind a large one.
const BATCH = 256;
const BATCH_BYTES = STRANGER_BODY_BYTES - 4096;
// Index pages asked of one member in a row: twice a capped pool's index with the
// longest keys.
const MAX_INDEX_PAGES = 128;
// Last-heard is written at most this often: a restart loses less of it than any silence
// it is judged by.
const HEARD_GRAIN_SECS = 10 * 60;
// Hosts asked in a pool besides its members: one per seat.
const MAX_BACK = LIMITS.members;
// Searches ask keys at least SEARCH_GAP_SECS apart, and no `due` lies further than
// MOST_DUE_SECS on (the first is half an interval on, later ones up to one and a half).
const SEARCH_GAP_SECS = SEARCH_INTERVAL_MS / 1000 / MAX_FORMER;
const MOST_DUE_SECS = 1.5 * SEARCH_INTERVAL_MS / 1000;
// Least gap between farewell pushes to one key.
const FAREWELL_GAP_SECS = 24 * 3600;
const UNUSABLE = {
  'bad-invite': 'That invite is not signed by the machine it names: ask for a new one.',
  expired: 'That invite has run out: ask for a new one.',
};

// Member and offer records ahead of the claims that rest on them.
const inOrder = (keys) => [...keys].sort((a, b) => a.startsWith('claim/') - b.startsWith('claim/'));

export const memberKey = (pk) => `member/${pk}`;
export const offerKey = (taskId, pk) => `offer/${taskId}/${pk}`;
export const claimKey = (taskId, pk) => `claim/${taskId}/${pk}`;

export function hoursOf(value) {
  const hours = Math.round(Number(value));
  return Number.isFinite(hours) ? Math.min(HOURS_CEILING, Math.max(HOURS_FLOOR, hours)) : HOURS_FLOOR;
}

// A hello refused because the invite's maker sits under the key that brings it, and what
// the refused host's operator reads.
const SITS_UNDER = 'the maker of that invite sits under the key that brings it';
const SITS_UNDER_HERE = 'the machine that made that invite came into the pool under this one, before this one began the pool again, and no machine that came in under this one can let it back in: use an invite of one that did not, or - if this machine began that pool, so that every machine there came in under it - have them join this one\'s pool, each by an invite this machine makes';

// The farewell record of a membership this host left and the members it left, or null.
const gone = (doc) => (isObject(doc.left) && Array.isArray(doc.leftTo) ? { left: doc.left, leftTo: doc.leftTo } : null);

// Only expired ones: a record whose seat went to another key is of no host that may have
// been cut off.
const ranOut = (dropped) => dropped.filter((d) => d.code === 'expired').map((d) => d.record);

const asResult = (answer) => (answer.error ? { ok: false, code: answer.error, detail: answer.detail ?? '' } : { ok: true, body: answer.body });

export function createGossip(host) {
  const outbox = new Map(); // "pool pk" -> { keys, busy }: still to push to that member
  // "pool pk" -> { records, tries, timer }: this host's own records, by key, that member
  // has not said it holds, how often re-pushed, and the next re-push
  const owed = new Map();
  const syncing = new Set(); // "pool pk" of every sync in flight
  const snubbed = new Map(); // "pool pk" -> when a member that refused a hello is greeted again
  const redeeming = new Map(); // pool -> when the inviter is next asked for its voucher; Infinity while asking
  const told = new Map(); // "pool pk" -> when that host is next told this one left
  let timer = null;
  let pruned = 0;

  const own = (P) => P.pool.get(memberKey(host.self));
  const open = (P) => host.open(P);
  const jitter = () => host.random(4).readUInt32BE(0) / 2 ** 32;

  // `change.voucher`, when named, replaces the held one (undefined: stand alone as a
  // pool's first). The voucher is dated by its signer's clock, and the record no earlier.
  function signMember(P, change = {}) {
    const held = own(P);
    const voucher = Object.hasOwn(change, 'voucher') ? change.voucher : held?.voucher;
    P.seq += 1;
    return memberRecord(host.id, {
      pool: P.id, seq: P.seq, at: Math.max(host.now(), voucher?.at ?? 0), era: held?.era ?? P.seq,
      maxAcceptedH: hoursOf(host.settings().maximumAcceptedH), voucher, left: change.left === true,
    });
  }

  function load(info, doc) {
    const P = {
      id: info.id, link: info, pool: new Pool({ id: info.id, self: host.self }),
      locks: new LockTable(host.heldLocks[info.id] ?? []),
      seq: Number.isSafeInteger(doc.seq) ? doc.seq : -1,
      // `joining`: `{ invite, by, exp }` until the inviter signs the voucher. `invites`:
      // those given since this host last became a member, each `{ nonce, exp, seats }`
      // (`seats`: key -> seat given). `farewell`: what is kept of the membership left
      // before. `joinFailed`: why the last invite let this host in nowhere. `heard`: when
      // another host last answered or was served; `waitedOut`: the last such time whose
      // silence this host waited out alone. `online`: seconds run here with the transport
      // up. `returning`: from rejoining, or hearing nobody for longer than a member record
      // is kept, until an asked host answers or all were asked that long. `back`: hosts
      // asked besides held members (those left to, those whose records ran out in a
      // silence, and on return every one held), each `{ pk, from }` with `from` the
      // `online` at first ask. `met`: members heard from directly while their records were
      // fresh; `metMoved`: one added since written. `former`: met members whose records ran
      // out, latest last, each `{ pk, due, by }` (`by`: its seater), searched once per
      // SEARCH_INTERVAL_MS from `due`, none sooner than `searchAt`. `asksKept`: the stored
      // `[back, former]`; `duesMoved`: a `due` moved since; `duesKept`: when last written.
      joining: null, joinFailed: '', invites: [], farewell: gone(doc), heard: host.now(), waitedOut: null, online: 0,
      onlineKept: 0, stepped: host.now(), returning: false, back: [], met: new Set(), metMoved: false, former: [],
      searchAt: host.now(), asksKept: null, duesMoved: false, duesKept: host.now(),
      // Members that refused this host's hello and answered nothing since.
      refusedBy: new Set(),
      // Until the heard file exists the first word heard is written at once: without it a
      // restart reads when this host last signed, which it does alone too.
      heardKept: false,
      // Since when pool state may be outdated (start, sleep, transport up), null once a
      // member has said what it holds; until then this host's offers are neither given
      // nor stepped. `epoch` counts outdatings; `catching` is the epoch being asked about.
      stale: host.now(), epoch: 0, catching: null,
    };
    P.asksKept = [P.back, P.former];
    // Startup locks are taken once: a relinked pool starts without them.
    delete host.heldLocks[info.id];
    if ((doc.linked || doc.away) && Array.isArray(doc.records)) {
      // Stored records were let in once: a clock that woke behind them must not make them
      // the future, and this host a stranger to its own pool.
      const { refused } = P.pool.merge(doc.records, doc.records.reduce((latest, r) => (Number.isSafeInteger(r?.at) ? Math.max(latest, r.at) : latest), host.now()));
      // Older stores kept the invite's own exp, however far ahead.
      if (isObject(doc.joining)) P.joining = { ...doc.joining, exp: Math.min(doc.joining.exp, host.now() + INVITE_TTL_SECS) };
      if (typeof doc.joinFailed === 'string') P.joinFailed = doc.joinFailed;
      if (Array.isArray(doc.invites)) P.invites = doc.invites;
      const kept = host.store.read(heardFile(P.id));
      if (Number.isSafeInteger(kept?.online)) [P.online, P.onlineKept] = [kept.online, kept.online];
      // Older stores kept these in the pool's document: `back` with a clock time (each is
      // asked as long again) and `former` as bare keys (each due now).
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
      // Older stores kept no `met`: every held member counts.
      P.met = new Set(Array.isArray(kept?.met) ? kept.met : doc.records.filter((r) => r?.type === 'member').map((r) => r.pk));
      if (asks) P.asksKept = [P.back, P.former];
      // Older stores kept `heard` in the document (moved out before it is rewritten);
      // older still kept none: fall back to this host's last signing, which a present host
      // does every RESIGN_INTERVAL_MS.
      const heard = [kept?.heard, doc.heard, own(P)?.at].find(Number.isSafeInteger);
      if (heard !== undefined) P.heard = heard;
      if (Number.isSafeInteger(kept?.waitedOut)) P.waitedOut = kept.waitedOut;
      P.heardKept = kept !== null;
      if (!kept && Number.isSafeInteger(doc.heard)) keepHeard(P);
      P.returning = doc.returning === true;
      // The store holds all this: nothing is written until something changes.
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

  // Members among `records` that no other host answered this one after they last signed:
  // such a host may have been cut off from this one rather than gone.
  const lapsed = (P, records) => records.filter((r) => r?.type === 'member' && !r.left && r.pk !== host.self
    && P.heard < r.at + 2 * RESIGN_INTERVAL_MS / 1000).map((r) => r.pk);

  // Silent for longer than a member record is kept, every known host may have forgotten
  // this one: come back. True when it did so now.
  function overdue(P, now) {
    if (P.returning || P.waitedOut === P.heard || now - P.heard <= MEMBER_RETENTION_SECS) return false;
    comeBack(P, []);
    return true;
  }

  // Asks `keys` and every held member, whatever their records' age: records a voucher
  // chain leads through are kept at any age and say nothing of whether their hosts are there.
  function comeBack(P, keys) {
    const held = P.pool.records().filter((r) => r.type === 'member' && !r.left).map((r) => r.pk);
    P.returning = true;
    P.back = backTo(P, [...keys, ...held]);
    keepAsks(P);
  }

  // `P.back` plus the `keys` it lacks, asked from now; keeps the MAX_BACK latest.
  function backTo(P, keys) {
    const added = [...new Set(keys)].filter((pk) => pk !== host.self && !P.back.some((e) => e.pk === pk)).map((pk) => ({ pk, from: P.online }));
    const back = [...P.back, ...added];
    return back.sort((x, y) => y.from - x.from).slice(0, MAX_BACK).sort((x, y) => (x.pk < y.pk ? -1 : x.pk > y.pk ? 1 : 0));
  }

  // `P.former` plus the met members among `records` that did not leave, first due half an
  // interval on.
  function formerWith(P, records) {
    const added = new Map(records.filter((r) => !r.left && P.met.has(r.pk)).map((r) => [r.pk, r.voucher?.by ?? r.pk]));
    if (added.size === 0) return P.former;
    const due = host.now() + SEARCH_INTERVAL_MS / 2000;
    return fit([...P.former.filter((e) => !added.has(e.pk)), ...[...added].map(([pk, by]) => ({ pk, due, by }))]);
  }

  // Keeps the latest LIMITS.invitees per seater (its seat count), then the latest
  // MAX_FORMER, dropping first from seaters over their share: no member's keys push out
  // another's.
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

  // By records, not the roster: a key leaves the roster before its record runs out into
  // `former`.
  function pruneMet(P) {
    const held = new Set(P.pool.records().filter((r) => r.type === 'member').map((r) => r.pk));
    for (const pk of P.met) if (!held.has(pk)) P.met.delete(pk);
  }

  // Asks the longest-due unheld key of `P.former` whether it is still in the pool, and the
  // next no sooner than SEARCH_GAP_SECS on, so many dues make no burst of proofs of work.
  // A `due` further on than any is set (a clock ran ahead) is clamped.
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

  // Writes `back` and `former` when they changed; when only a `due` moved, once the last
  // write is HEARD_GRAIN_SECS away either way, so a restart asks a key at most that much
  // sooner.
  function keepAsks(P) {
    const [back, former] = P.asksKept;
    if (back === P.back && former === P.former && !(P.duesMoved && Math.abs(host.now() - P.duesKept) >= HEARD_GRAIN_SECS)) return;
    host.store.write(asksFile(P.id), { back: P.back, former: P.former });
    [P.asksKept, P.duesMoved, P.duesKept] = [[P.back, P.former], false, host.now()];
  }

  /// With no member record yet, the host is the pool's sole member at once. A pool this
  /// host left stays left.
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

  /// Pushes `keys` now, whatever the backoff, to every host this one asks (to a non-member,
  /// only the member records); settles with `[pk, answer]` per push, or null.
  function tell(P, keys) {
    const records = P.pool.records(keys);
    const theirs = new Set(members(P));
    return Promise.all(others(P).map(async (pk) => {
      const pushed = theirs.has(pk) ? records : records.filter((r) => r.type === 'member');
      if (pushed.length === 0) return null;
      return [pk, await host.peers.ask(P.id, pk, 'push', { records: pushed }, { fresh: true }).catch(() => null)];
    }));
  }

  /// Pushes the farewell and `keys` (the other records signed on the way out) to every
  /// member once. An unlinked pool keeps only the farewell, its recipients, and the seq the
  /// next member record must exceed; with `stay` it is away and keeps the member records
  /// too, for rejoining.
  function unlink(P, keys, stay) {
    const leftTo = others(P);
    const left = signMember(P, { left: true });
    P.pool.merge(left, host.now());
    host.pools.delete(P.id);
    const doc = { id: P.id, linked: false, seq: P.seq, left, leftTo };
    if (stay) {
      host.away.set(P.id, P.link);
      // A granted lock binds for its time, member or not.
      host.heldLocks[P.id] = P.locks.entries();
      Object.assign(doc, { away: true, records: P.pool.records().filter((r) => r.type === 'member') });
    }
    host.store.write(poolFile(P.id), doc);
    host.store.remove(asksFile(P.id));
    if (!stay) host.store.remove(heardFile(P.id));
    // That push is the day's farewell to each key it reaches.
    for (const pk of leftTo) told.set(`${P.id} ${pk}`, host.now() + FAREWELL_GAP_SECS);
    tell(P, [...keys, memberKey(host.self)]).then((answers) => {
      for (const [pk, answer] of answers.filter(Boolean)) if (!answer || (answer.lost && answer.lost !== 'budget')) told.delete(`${P.id} ${pk}`);
    });
  }

  /// Unlinks a left pool: linked again, it is a pool of this host's own.
  function forget(id) {
    const doc = host.store.read(poolFile(id)) ?? {};
    host.away.delete(id);
    host.store.write(poolFile(id), { id, linked: false, seq: doc.seq, ...gone(doc) });
    host.store.remove(heardFile(id));
  }

  // Re-signs the member record over the held voucher, and asks the hosts it left to as
  // well as the members it holds.
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

  /// A non-member asked about a pool. If this host left it, with the asker a member,
  /// within a member record's life, the asker may not have heard: resend the farewell, at
  /// most daily. Nobody else is sent anything: a key never known as a member is neither
  /// dialled nor worked for.
  function farewell(pool, to) {
    const P = host.pools.get(pool);
    const was = P ? P.farewell : gone(host.store.read(poolFile(pool)) ?? {});
    const key = `${pool} ${to}`;
    const now = host.now();
    if (!was?.leftTo.includes(to) || now >= was.left.at + MEMBER_RETENTION_SECS || (told.get(key) ?? 0) > now) return;
    told.set(key, now + FAREWELL_GAP_SECS);
    host.peers.ask(pool, to, 'push', { records: [was.left] }, { fresh: true }).catch(() => {});
  }

  /// A `hello` brings an invite of this host's own, or a member record vouched by a key
  /// seated here.
  function invited(P, body) {
    const invite = parseInvite(body?.invite);
    if (invite) return invite.by === host.self && verifyInvite(invite, { pool: P.id }).ok;
    const record = body?.member;
    return checkShape(record, P.id).ok && record.type === 'member' && record.voucher !== undefined
      && P.pool.vouched(record.voucher.by, host.now()) && verifyVoucher(record);
  }

  // A held record of `pk` not marked left, whether it still signs or stopped.
  const member = (P, pk) => P.pool.known(host.now()).some((m) => m.pk === pk);

  /// Which budget a request to `to` about `pool` is paid from: `member` for a held member
  /// of a pool this host is in; the whole hour, sent once, for the inviter being redeemed
  /// or a key it is back to while returning; else a search's (every request about a left
  /// pool too). A key in `former` takes no more of the search share than the others of its
  /// seater: `share.key` that seater, `share.of` how many seat `former` keys in all pools.
  function standing(pool, to) {
    const P = host.pools.get(pool);
    if (!P) return { member: false, search: true };
    if (member(P, to)) return { member: true, search: false };
    if (P.joining?.by === to || (P.returning && P.back.some((e) => e.pk === to))) return { member: false, search: false };
    const seat = P.former.find((e) => e.pk === to);
    if (!seat) return { member: false, search: true };
    // Keys seated by themselves (a pool's first member, or any key from a store that kept
    // no seater) share one share, or each would bring its own.
    const seater = (Q, e) => (e.by === e.pk ? Q.id : `${Q.id} ${e.by}`);
    const seaters = new Set([...host.pools.values()].flatMap((Q) => Q.former.map((e) => seater(Q, e))));
    return { member: false, search: true, share: { key: seater(P, seat), of: seaters.size } };
  }

  // Where this host's records go.
  const members = (P) => P.pool.known(host.now()).map((m) => m.pk).filter((pk) => pk !== host.self);

  // Every host this one asks: members and those it is back to.
  function others(P) {
    return [...new Set([...members(P), ...P.back.map((e) => e.pk)])].filter((pk) => pk !== host.self).sort();
  }

  const returning = (P) => P.returning;

  // Silent longer than a member takes to re-sign: may have been cut off from them all.
  const quiet = (P, now) => now - P.heard > RESIGN_INTERVAL_MS / 1000;

  function outdate(P, now) {
    P.stale = now;
    P.epoch += 1;
  }

  /// Another host answered or was served; `from` is a member that asked or a host a hello
  /// let in. The first word after a possible cut outdates the pool: what came meanwhile
  /// may be missing.
  function hears(P, from) {
    const now = host.now();
    doubt(P);
    if (!open(P)) return;
    // A present host re-signs every RESIGN_INTERVAL_MS: one whose record is about to run
    // out as it speaks does not count as met.
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

  /// Call before acting on a pool: one silent for long is outdated, so the others are
  /// asked what was missed first.
  function doubt(P) {
    const now = host.now();
    if (P.stale === null && quiet(P, now)) outdate(P, now);
  }

  // This host is back, and `pk` leaves `back`. The others stay: one answering host may
  // hold no more of the pool than this one, having come back with it.
  function answered(P, pk) {
    const back = P.back.filter((e) => e.pk !== pk);
    if (!P.returning && back.length === P.back.length) return;
    [P.returning, P.back] = [false, back];
    keepAsks(P);
    host.save(P);
  }

  // The voucher chain above `pk`'s record, up to the pool's founder.
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

  // `upper` is somewhere in `lower`'s voucher chain.
  const under = (P, lower, upper) => chainOf(P, lower).some((record) => record.pk === upper);

  // The seat `pk` gets: the one it holds or a live invite gave it, else a free one, else
  // that of the oldest record whose holder is no longer a member. Null when none.
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

  // Answers an invite `hello` with a voucher for the sender and this host's chain to the
  // founder. Only the invite's maker takes it.
  function vouch(P, from, body, now) {
    if (!shaped(body, { invite: (v) => typeof v === 'string' })) return { error: 'bad-request' };
    const invite = parseInvite(body.invite);
    const verdict = invite ? verifyInvite(invite, { pool: P.id, now }) : { ok: false, code: 'bad-invite' };
    if (!verdict.ok) return { error: 'denied', detail: verdict.code };
    // An invite is good only for the membership it was given in: one signed before this
    // host left, or with no note of it here, lets nobody in.
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

  // Asks the inviter for its voucher, then signs under it, takes in its chain, and stays
  // stale until a member has said what it holds. A refused invite is given up; an
  // unanswered one is asked again.
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
      // Not a voucher.
    }
    if (record && verifyVoucher(record)) host.take(P, [...chain, record]);
    const failed = own(P) !== record;
    if (failed) P.joinFailed = answer.ok ? 'its voucher does not hold' : answer.detail === SITS_UNDER ? SITS_UNDER_HERE : answer.detail || answer.code;
    host.save(P);
    if (failed) {
      host.log(`the invite to ${P.id} let this host in nowhere: ${P.joinFailed}`);
      return;
    }
    // It holds nothing of the new pool yet. Show the voucher's signer the record first,
    // then ask every member: earlier refusals were of another record.
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

  // A record too large to share a body travels alone.
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

  // Pulls what this host lacks and queues a push of what the member lacks. A pull answers
  // as much as fits, from the front; the next asks from there.
  async function exchange(P, pk, plan) {
    let keys = inOrder(plan.pull);
    while (keys.length > 0) {
      const asked = keys.slice(0, BATCH);
      const pulled = await host.peers.ask(P.id, pk, 'pull', { keys: asked });
      if (!open(P)) return;
      const records = pulled.ok && Array.isArray(pulled.body.records) ? pulled.body.records.slice(0, asked.length) : [];
      host.take(P, records);
      // Move past the answer's last record only once this host holds it.
      const { key } = checkShape(records.at(-1), P.id);
      const reached = key && P.pool.get(key) ? asked.indexOf(key) : -1;
      if (reached === -1) break;
      keys = keys.slice(reached + 1);
    }
    // A key this host dropped may answer for no pool at all.
    if (member(P, pk)) post(P, pk, plan.push);
  }

  async function greet(P, pk, options) {
    const key = `${P.id} ${pk}`;
    if (!open(P) || (snubbed.get(key) ?? 0) > host.now()) return false;
    const chain = chainOf(P);
    const hello = await host.peers.ask(P.id, pk, 'hello', { member: own(P), ...(chain.length > 0 ? { chain } : {}) }, options);
    if (!hello.ok) {
      // Back off from a refusal, but not from `busy` (a one-off). Only `denied` or
      // `not-member` mean no seat; other codes refused this host's clock or its work.
      if (hello.code && hello.code !== 'busy') snubbed.set(key, host.now() + PEER_BACKOFF_MAX_MS / 1000);
      if (hello.code === 'denied' || hello.code === 'not-member') P.refusedBy.add(pk);
      return false;
    }
    snubbed.delete(key);
    await settle(P, pk, hello.body, host.now());
    // Only a member's answer counts as hearing the pool: a dropped key may answer for no
    // pool at all.
    if (!open(P) || !member(P, pk)) return false;
    hears(P);
    answered(P, pk);
    return true;
  }

  // Reconciles from `first`, the index page answered as of `asOf`, then asks for the next
  // pages one by one.
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

  /// Answers as `peers.ask`. A member that does not know this host yet is greeted and asked
  /// again; a request to this host itself is handled in place.
  async function send(P, to, kind, body, options) {
    if (to === host.self) return asResult(await host.handle(P, to, kind, body));
    const answer = await host.peers.ask(P.id, to, kind, body, options);
    if (answer.ok) hears(P);
    if (answer.code !== 'not-member' || !(await greet(P, to, options))) return answer;
    return host.peers.ask(P.id, to, kind, body, options);
  }

  // Syncs with one member; true when it answered. `options` apply to the first request.
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

  /// Every host this one asks refused its hello: it holds a seat only in its own state.
  const unseated = (P) => others(P).length > 0 && others(P).every((pk) => P.refusedBy.has(pk));

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

  function woke() {
    for (const P of host.pools.values()) outdate(P, host.now());
  }

  // No-op if outdated again since `epoch`: what a member said before says nothing of
  // what came after.
  function caughtUp(P, epoch) {
    if (P.stale === null || P.epoch !== epoch) return;
    host.log(`${P.id} is up to date ${host.now() - P.stale} s after this host came back to it`);
    P.stale = null;
  }

  // Asks every host what was missed, whatever the backoff and any sync under way (that
  // one may have asked before there was anything to miss). Up to date once any one has
  // answered and been synced (an asleep member keeps nobody waiting), or with nobody to ask.
  function catchUp(P) {
    const { epoch } = P;
    P.catching = epoch;
    const pks = others(P);
    // Nothing waited for, so nothing logged.
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
    // Batches whatever else this turn signs for the member into the same push.
    await null;
    try {
      while (box.keys.size > 0 && open(P)) {
        const keys = inOrder(box.keys);
        const { records, used } = batch(P, keys);
        for (const k of keys.slice(0, used)) box.keys.delete(k);
        // An unanswered push is left to the next sync, except what `deliver` repeats.
        if (records.length > 0 && (await send(P, pk, 'push', { records })).ok) holds(P, pk, records);
      }
    } finally {
      box.busy = false;
    }
  }

  function spread(P, keys, except = null) {
    for (const pk of members(P)) {
      if (pk !== except) post(P, pk, keys);
    }
  }

  /// `spread` for this host's own records, re-pushed after each of PUSH_REPEAT_MS to a
  /// member that has not said it holds them, so a lost push is not left to the next sync.
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

  // Goes out beside any unanswered push to that member, but not to one unheard for long
  // (`short` patience): that is left to the sync.
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

  // No `records`: the member holds everything this host does.
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

  function syncAll() {
    for (const P of host.pools.values()) {
      for (const pk of others(P)) syncWith(P, pk).catch((err) => host.log(`a sync failed: ${err?.stack ?? err}`));
    }
  }

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

  function step() {
    const now = host.now();
    for (const P of host.pools.values()) {
      // One catch-up per epoch, a new one at once when outdated again. A pool is stale no
      // longer than CATCH_UP_MS with the transport up, unless this host is returning:
      // then it waits for an answer while the periodic sync keeps asking.
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
      // Every key was asked in vain for as long: no answer to wait for.
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

  const noPool = (pool) => new Error(host.away.has(pool)
    ? `This machine left the pool ${pool}: join it again first.` : `The pool ${pool} is not linked on this machine.`);

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

  /// The inviter is asked for a voucher until it answers or the invite runs out. With
  /// `pool` and no invite, rejoins a left pool as the member it was.
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
    // Else its maker could keep this host joining, and paying for it, as long as it likes.
    if (parsed.exp > host.now() + INVITE_TTL_SECS + CLOCK_SKEW_SECS) throw new Error('That invite says it is good for longer than a day, and no machine makes one for longer: ask for a new one.');
    if (parsed.by === host.self) throw new Error('That invite was made on this machine: it lets another machine in, not this one.');
    const linked = host.pools.get(parsed.pool);
    if (linked && under(linked, parsed.by, host.self)) {
      throw new Error(`The machine that made that invite came into the pool ${parsed.pool} through this one, which is in it already: an invite takes a machine in under its maker. To move this machine, use an invite of a machine that did not come in through it.`);
    }
    const P = linked ?? rejoin(parsed.pool);
    P.joining = { invite: token, by: parsed.by, exp: Math.min(parsed.exp, host.now() + INVITE_TTL_SECS) };
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
      // A refused hello may still have brought a record that is kept.
      if (answer.body || changed) host.moved(P);
      // Members that have not met the newcomer hear of it from this one.
      if (answer.body && changed) spread(P, [memberKey(from)], from);
      return answer;
    },
    sync(P, from, body) {
      const answer = P.pool.answerSync(body, host.now());
      // No index: the member holds exactly what this host does, so nothing was missed and
      // nothing is owed.
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
