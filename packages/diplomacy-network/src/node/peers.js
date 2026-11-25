// Of what a host remembers per peer, only which peers were long silent survives a restart.
//
// "No answer" is never evidence that a peer is gone: a first onion circuit can take
// minutes, and an answer can be lost after the request was carried out.

import { canon, parseCanon } from '../core/canon.js';
import { UNSERVED, buildRequest, verifyResponse } from '../core/envelope.js';
import { Spending } from '../core/pow.js';
import { isBytes } from '../core/records.js';
import {
  MAX_ACT_BODY_BYTES, MAX_BODY_BYTES, PEER_BACKOFF_MAX_MS, PEER_BACKOFF_MS, PEER_QUIET_MS, POW, POW_HOURLY, RECORD_RETENTION_SECS,
  REQUEST_TIMEOUT_MS, SEARCH_INTERVAL_MS, STRANGER_BODY_BYTES,
} from '../paths.js';

// Past the last doubling no honest target asks for more, so nobody is paid more.
const MOST_OWED = Math.max(POW.memberBase * 2 ** POW.memberCap, POW.strangerBase * 2 ** POW.strangerCap);
const ATTEMPTS = 4;
const BUSY_RETRY_MS = 1500;
const AGAIN = Symbol('again');
const INSATIABLE = { ok: false, code: 'effort', detail: 'the peer keeps asking for more work' };

export function createPeers(host) {
  const peers = new Map(); // pk -> { since, seen, heard, failures, until, skew }
  const spending = new Spending(POW_HOURLY, MOST_OWED);
  // "pk pool" -> `{ effort, at }`: what that peer last asked of this host there. After
  // SEARCH_INTERVAL_MS the base price applies again, so a price it cannot pay never keeps
  // a peer from being asked.
  const owed = new Map();
  const lanes = new Map(); // pk -> the last large request sent to it
  // pk -> when a peer was first found long silent. On disk, so a restarted host does not
  // wait for it as for one it has yet to reach. One silent longer than a record lives is
  // no member.
  const silent = new Map(Object.entries(host.store.read('peers')?.silent ?? {})
    .filter(([, at]) => at > host.now() - RECORD_RETENTION_SECS));
  const keep = () => host.store.write('peers', { silent: Object.fromEntries(silent) });

  const peer = (pk) => {
    if (!peers.has(pk)) {
      peers.set(pk, { since: host.now(), seen: 0, heard: 0, failures: 0, until: 0, skew: false });
    }
    return peers.get(pk);
  };
  const quiet = (p) => host.now() - Math.max(p.seen, p.since) > PEER_QUIET_MS / 1000;
  const sleep = (ms) => new Promise((resolve) => { host.clock.setTimeout(resolve, ms); });

  function lost(to, code) {
    const p = peer(to);
    // A transport that is stopping or has no tor says nothing about the peer.
    if (code !== 'stopped' && host.transport.state().state === 'ready') {
      p.failures += 1;
      p.until = host.now() + Math.ceil(Math.min(PEER_BACKOFF_MAX_MS, PEER_BACKOFF_MS * 2 ** (p.failures - 1)) / 1000);
      if (patience(to) === 'short' && !silent.has(to)) {
        silent.set(to, host.now());
        keep();
      }
      host.touch();
    }
    return { ok: false, lost: code };
  }

  // At the effort the peer last asked for. AGAIN when the peer wants it sent once more:
  // for more work, or because it could not serve it this time.
  async function once(p, pool, to, kind, body, { timeoutMs, maxResponseBytes, ticket, member, search, share }, first) {
    const key = `${to} ${pool}`;
    const last = owed.get(key);
    const effort = last && host.now() - last.at < SEARCH_INTERVAL_MS / 1000 ? last.effort : kind === 'hello' ? POW.strangerBase : POW.memberBase;
    if (!spending.pay(to, p.since, effort, host.now(), { member, search, share })) return { ok: false, lost: 'budget' };
    // What this request tells the peer is on disk before the peer hears it.
    host.store.flush();
    let request;
    try {
      request = await buildRequest(host.id, { pool, kind, to, ts: host.now(), body, nonce: host.random(16), effort }, host.solve);
    } catch (err) {
      return { ok: false, code: 'bad-request', detail: `not sent: ${err.message}` };
    }
    let answer = null;
    try {
      const raw = await host.transport.request(to, canon(request), {
        timeoutMs, maxResponseBytes, headers: ticket ? { 'dn-ticket': ticket } : {},
      });
      // Only a canonical answer signed by the peer and naming this request counts.
      answer = verifyResponse(parseCanon(raw), { request, from: to });
    } catch (err) {
      return lost(to, typeof err?.code === 'string' ? err.code : 'protocol');
    }
    if (!answer) return lost(to, 'protocol');
    if (silent.delete(to)) keep();
    const skew = answer.code === 'stale';
    if (p.failures > 0 || p.seen === 0 || p.skew !== skew) host.touch();
    Object.assign(p, { seen: host.now(), failures: 0, until: 0, skew });
    owed.set(key, { effort: Math.min(answer.effort, MOST_OWED), at: host.now() });
    if (answer.ok) return { ok: true, body: answer.body };
    if (answer.code === 'effort' && answer.effort <= MOST_OWED) return member ? AGAIN : { ok: false, lost: 'budget' };
    // The transport delivered it twice and the first copy was carried out: any kind but
    // `act` answers the same when asked again; an `act` was performed.
    if (answer.code === 'replay') return kind === 'act' ? { ok: false, lost: 'replay' } : AGAIN;
    if (answer.code === 'busy' && first && (kind !== 'act' || answer.detail === UNSERVED)) {
      // Just started, or no place free. An `act` is retried only if the peer did nothing
      // for it: one it failed at may have been performed.
      await sleep(BUSY_RETRY_MS);
      return AGAIN;
    }
    return { ok: false, code: answer.code, detail: answer.detail };
  }

  async function exchange(p, pool, to, kind, body, options) {
    for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
      const answer = await once(p, pool, to, kind, body, options, attempt === 0);
      if (answer !== AGAIN) return answer;
    }
    return INSATIABLE;
  }

  // A body above what anyone may send unasked needs a place reserved at the target first;
  // each ticket is good for one sending.
  async function exchangeLarge(p, pool, to, kind, body, size, options) {
    const bytes = Math.min(size + 1024, kind === 'act' ? MAX_ACT_BODY_BYTES : MAX_BODY_BYTES);
    for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
      const place = await exchange(p, pool, to, 'reserve', { kind, bytes }, { timeoutMs: options.timeoutMs, member: options.member, search: options.search, share: options.share });
      if (!place.ok) return place.code === 'busy' ? { ok: false, lost: 'no-place' } : place;
      if (!isBytes(place.body.ticket, 16)) return lost(to, 'protocol');
      const answer = await once(p, pool, to, kind, body, { ...options, ticket: place.body.ticket }, attempt === 0);
      if (answer !== AGAIN) return answer;
    }
    return INSATIABLE;
  }

  /// Answers `{ ok: true, body }`, `{ ok: false, code, detail }` for a refusal the peer
  /// signed, or `{ ok: false, lost }` when no answer came: the transport's code, `offline`,
  /// `backoff` (ignored when `fresh`), `budget` (the peer asks more work than this host has
  /// left this hour for it or for all, or than it does at once for a key with no member
  /// record), `no-place` for a large body, or `replay` for an `act` whose answer was lost.
  /// Paid per the gossip's `standing` of `to`; a request to a non-member is not resent for
  /// more work - the next request pays what it asked.
  async function ask(pool, to, kind, body, { fresh = false, timeoutMs = REQUEST_TIMEOUT_MS, maxResponseBytes } = {}) {
    const p = peer(to);
    if (host.transport.state().state !== 'ready') return { ok: false, lost: 'offline' };
    if (!fresh && host.now() < p.until) return { ok: false, lost: 'backoff' };
    const options = { timeoutMs, maxResponseBytes, ...host.gossip.standing(pool, to) };
    const size = Buffer.byteLength(JSON.stringify(body));
    if (size < STRANGER_BODY_BYTES - 1024) return exchange(p, pool, to, kind, body, options);
    // A target gives a member one large-body place at a time, so these go out in turn.
    const turn = (lanes.get(to) ?? Promise.resolve()).then(() => exchangeLarge(p, pool, to, kind, body, size, options));
    const settled = turn.catch(() => {});
    lanes.set(to, settled);
    settled.then(() => lanes.get(to) === settled && lanes.delete(to));
    return turn;
  }

  /// A claim round's wait for a member: `normal` if it answered lately, `patient` if never
  /// reached and known only briefly, else `short` (long silent, in this life of the host or
  /// by the end of the last).
  function patience(pk) {
    const p = peer(pk);
    if (quiet(p) || silent.has(pk)) return 'short';
    return p.seen > 0 ? 'normal' : 'patient';
  }

  function heard(pk) {
    peer(pk).heard = host.now();
  }

  /// `lastSeen`: when it last answered or asked (0 for never); `reachable`: the last request
  /// to it was answered; `skew`: that answer said the two clocks are too far apart.
  function seen(pk) {
    const p = peers.get(pk);
    return {
      lastSeen: Math.max(p?.seen ?? 0, p?.heard ?? 0), reachable: Boolean(p && p.seen > 0 && p.failures === 0),
      skew: p?.skew === true,
    };
  }

  return { ask, patience, heard, seen };
}
