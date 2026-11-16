// The outbound half of a host: one function that sends a request to a peer and says what
// came of it, and what the host remembers about each peer between requests - the effort
// it last demanded, what was paid it this hour, when it last answered, and how long
// gossip leaves it alone. Which peers it had asked in vain for long is all of that a
// restart keeps.
//
// "No answer" is never evidence that a peer is gone: a first circuit to an onion service
// routinely takes minutes, and an answer can be lost after the request was carried out.

import { canon, parseCanon } from '../core/canon.js';
import { UNSERVED, buildRequest, verifyResponse } from '../core/envelope.js';
import { isBytes } from '../core/records.js';
import {
  MAX_ACT_BODY_BYTES, MAX_BODY_BYTES, PEER_BACKOFF_MAX_MS, PEER_BACKOFF_MS, PEER_QUIET_MS, POW, RECORD_RETENTION_SECS,
  REQUEST_TIMEOUT_MS, STRANGER_BODY_BYTES,
} from '../paths.js';

// Past the last doubling no honest target asks for more, so nobody is paid more.
const MOST_OWED = Math.max(POW.memberBase * 2 ** POW.memberCap, POW.strangerBase * 2 ** POW.strangerCap);
// The work this host does for one peer in an hour, in hashes expected: 16384 requests at
// a member's base price, or four at the most any target may ask. A peer that prices
// itself past that is not sent to until the hour has moved on.
const HOURLY_EFFORT = POW.memberBase * 2 ** 14;
const ATTEMPTS = 4;
const BUSY_RETRY_MS = 1500;
// What one sending of a request comes to when the peer wants it sent once more.
const AGAIN = Symbol('again');
const INSATIABLE = { ok: false, code: 'effort', detail: 'the peer keeps asking for more work' };

/// The peers of `host`: `{ ask, patience, heard, seen }`.
export function createPeers(host) {
  const peers = new Map(); // pk -> { since, seen, heard, failures, until, skew, paid, spent }
  const owed = new Map(); // "pk pool" -> the effort that peer last asked of this host there
  const lanes = new Map(); // pk -> the last large request sent to it
  // pk -> when a peer that had not answered for long was first found so, and has not
  // answered since: on disk, so a host that starts again does not wait for it as for one
  // it has yet to reach. A peer silent for longer than a record lives is no member.
  const silent = new Map(Object.entries(host.store.read('peers')?.silent ?? {})
    .filter(([, at]) => at > host.now() - RECORD_RETENTION_SECS));
  const keep = () => host.store.write('peers', { silent: Object.fromEntries(silent) });

  const peer = (pk) => {
    if (!peers.has(pk)) {
      peers.set(pk, { since: host.now(), seen: 0, heard: 0, failures: 0, until: 0, skew: false, paid: [], spent: 0 });
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

  // Takes `effort` out of what this host pays `p` this hour; false when that much is not left.
  function afford(p, effort) {
    const now = host.now();
    while (p.paid.length > 0 && p.paid[0][0] <= now - 3600) p.spent -= p.paid.shift()[1];
    if (p.spent + effort > HOURLY_EFFORT) return false;
    p.paid.push([now, effort]);
    p.spent += effort;
    return true;
  }

  // Sends a request once, at the effort the peer last asked for. AGAIN when the peer
  // wants it sent once more: for more work, or because it could not serve it this time.
  async function once(p, pool, to, kind, body, { timeoutMs, maxResponseBytes, ticket }, first) {
    const key = `${to} ${pool}`;
    const effort = owed.get(key) ?? (kind === 'hello' ? POW.strangerBase : POW.memberBase);
    if (!afford(p, effort)) return { ok: false, lost: 'budget' };
    // Whatever this request tells the peer is on disk before the peer hears it.
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
      // Only an answer signed by the peer, in its canonical form and naming this very
      // request, is one.
      answer = verifyResponse(parseCanon(raw), { request, from: to });
    } catch (err) {
      return lost(to, typeof err?.code === 'string' ? err.code : 'protocol');
    }
    if (!answer) return lost(to, 'protocol');
    if (silent.delete(to)) keep();
    const skew = answer.code === 'stale';
    if (p.failures > 0 || p.seen === 0 || p.skew !== skew) host.touch();
    Object.assign(p, { seen: host.now(), failures: 0, until: 0, skew });
    owed.set(key, Math.min(answer.effort, MOST_OWED));
    if (answer.ok) return { ok: true, body: answer.body };
    if (answer.code === 'effort' && answer.effort <= MOST_OWED) return AGAIN;
    // The transport sent these bytes twice and the first copy was carried out. Every
    // kind but `act` is asked again and answers the same; an `act` was performed.
    if (answer.code === 'replay') return kind === 'act' ? { ok: false, lost: 'replay' } : AGAIN;
    if (answer.code === 'busy' && first && (kind !== 'act' || answer.detail === UNSERVED)) {
      // The peer could not serve it this once: it has only just started, or it has no
      // place free. An `act` is asked again only where the peer did nothing for it: one
      // it failed at may have been performed.
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

  // A body above what anyone may send unasked needs a place at the target, asked for
  // first and good for one sending: every time the request goes out it has a ticket of
  // its own.
  async function exchangeLarge(p, pool, to, kind, body, size, options) {
    const bytes = Math.min(size + 1024, kind === 'act' ? MAX_ACT_BODY_BYTES : MAX_BODY_BYTES);
    for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
      const place = await exchange(p, pool, to, 'reserve', { kind, bytes }, { timeoutMs: options.timeoutMs });
      if (!place.ok) return place.code === 'busy' ? { ok: false, lost: 'no-place' } : place;
      if (!isBytes(place.body.ticket, 16)) return lost(to, 'protocol');
      const answer = await once(p, pool, to, kind, body, { ...options, ticket: place.body.ticket }, attempt === 0);
      if (answer !== AGAIN) return answer;
    }
    return INSATIABLE;
  }

  /// Sends one request and answers `{ ok: true, body }`, `{ ok: false, code, detail }` for
  /// a refusal the peer signed, or `{ ok: false, lost }` when no answer came: `lost` is
  /// the transport's code, `offline` while the transport is not ready, `backoff` while
  /// gossip leaves the peer alone, `budget` when the peer asks for more work than this
  /// host does for one peer in an hour, `no-place` when it has no place for a large
  /// body, or `replay` for an `act` whose answer was lost. `fresh` asks regardless of
  /// the backoff.
  async function ask(pool, to, kind, body, { fresh = false, timeoutMs = REQUEST_TIMEOUT_MS, maxResponseBytes } = {}) {
    const p = peer(to);
    if (host.transport.state().state !== 'ready') return { ok: false, lost: 'offline' };
    if (!fresh && host.now() < p.until) return { ok: false, lost: 'backoff' };
    const options = { timeoutMs, maxResponseBytes };
    const size = Buffer.byteLength(JSON.stringify(body));
    if (size < STRANGER_BODY_BYTES - 1024) return exchange(p, pool, to, kind, body, options);
    // A target gives a member one place for a large body at a time: such requests go out
    // one after another.
    const turn = (lanes.get(to) ?? Promise.resolve()).then(() => exchangeLarge(p, pool, to, kind, body, size, options));
    const settled = turn.catch(() => {});
    lanes.set(to, settled);
    settled.then(() => lanes.get(to) === settled && lanes.delete(to));
    return turn;
  }

  /// How long a claim round waits for a member: `normal` for one that answered lately,
  /// `patient` for one never reached and known only for a short while, else `short` -
  /// one that has not answered for long, in this life of the host or by the end of the
  /// last.
  function patience(pk) {
    const p = peer(pk);
    if (quiet(p) || silent.has(pk)) return 'short';
    return p.seen > 0 ? 'normal' : 'patient';
  }

  /// A request this host accepted came from that peer.
  function heard(pk) {
    peer(pk).heard = host.now();
  }

  /// `{ lastSeen, reachable, skew }` of a peer: when it last answered or asked (0 for
  /// never), whether the last request to it was answered, and whether that answer said
  /// its clock and this host's are too far apart for either to take the other's requests.
  function seen(pk) {
    const p = peers.get(pk);
    return {
      lastSeen: Math.max(p?.seen ?? 0, p?.heard ?? 0), reachable: Boolean(p && p.seen > 0 && p.failures === 0),
      skew: p?.skew === true,
    };
  }

  return { ask, patience, heard, seen };
}
