// The outbound half of a host: one function that sends a request to a peer and says what
// came of it, and what the host remembers about each peer between requests - the effort
// it last demanded, when it last answered, and how long gossip leaves it alone.
//
// "No answer" is never evidence that a peer is gone: a first circuit to an onion service
// routinely takes minutes, and an answer can be lost after the request was carried out.

import { buildRequest, verifyResponse } from '../core/envelope.js';
import {
  PEER_BACKOFF_MAX_MS, PEER_BACKOFF_MS, PEER_QUIET_MS, POW, REQUEST_TIMEOUT_MS, STRANGER_BODY_BYTES,
} from '../paths.js';

// Past the last doubling no honest target asks for more, so nobody is paid more.
const MOST_OWED = Math.max(POW.memberBase * 2 ** POW.memberCap, POW.strangerBase * 2 ** POW.strangerCap);
const ATTEMPTS = 4;

/// The peers of `host`: `{ ask, patience, heard, seen }`.
export function createPeers(host) {
  const peers = new Map(); // pk -> { since, seen, heard, failures, until }
  const owed = new Map(); // "pk pool" -> the effort that peer last asked of this host there
  const lanes = new Map(); // pk -> the last large request sent to it

  const peer = (pk) => {
    if (!peers.has(pk)) peers.set(pk, { since: host.now(), seen: 0, heard: 0, failures: 0, until: 0 });
    return peers.get(pk);
  };
  const quiet = (p) => host.now() - Math.max(p.seen, p.since) > PEER_QUIET_MS / 1000;

  function lost(p, code) {
    // A transport that is stopping or has no tor says nothing about the peer.
    if (code !== 'stopped' && host.transport.state().state === 'ready') {
      p.failures += 1;
      p.until = host.now() + Math.ceil(Math.min(PEER_BACKOFF_MAX_MS, PEER_BACKOFF_MS * 2 ** (p.failures - 1)) / 1000);
      host.touch();
    }
    return { ok: false, lost: code };
  }

  async function exchange(p, pool, to, kind, body, { timeoutMs, maxResponseBytes }) {
    const key = `${to} ${pool}`;
    let effort = owed.get(key) ?? (kind === 'hello' ? POW.strangerBase : POW.memberBase);
    for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
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
        const raw = await host.transport.request(to, Buffer.from(JSON.stringify(request)), {
          timeoutMs, maxResponseBytes, headers: { 'dn-from': host.self, 'dn-pool': pool, 'dn-kind': kind },
        });
        // Only an answer signed by the peer and naming this very request is one.
        answer = verifyResponse(JSON.parse(raw.toString('utf8')), { request, from: to });
      } catch (err) {
        return lost(p, typeof err?.code === 'string' ? err.code : 'protocol');
      }
      if (!answer) return lost(p, 'protocol');
      if (p.failures > 0 || p.seen === 0) host.touch();
      Object.assign(p, { seen: host.now(), failures: 0, until: 0 });
      owed.set(key, Math.min(answer.effort, MOST_OWED));
      if (answer.ok) return { ok: true, body: answer.body };
      if (answer.code === 'effort' && answer.effort <= MOST_OWED) {
        effort = answer.effort;
      } else if (answer.code === 'replay') {
        // The transport sent these bytes twice and the first copy was carried out. Every
        // kind but `act` is asked again and answers the same; an `act` was performed.
        if (kind === 'act') return { ok: false, lost: 'replay' };
      } else {
        return { ok: false, code: answer.code, detail: answer.detail };
      }
    }
    return { ok: false, code: 'effort', detail: 'the peer keeps asking for more work' };
  }

  /// Sends one request and answers `{ ok: true, body }`, `{ ok: false, code, detail }` for
  /// a refusal the peer signed, or `{ ok: false, lost }` when no answer came: `lost` is
  /// the transport's code, `offline` while the transport is not ready, `backoff` while
  /// gossip leaves the peer alone, or `replay` for an `act` whose answer was lost.
  /// `fresh` asks regardless of the backoff.
  async function ask(pool, to, kind, body, { fresh = false, timeoutMs = REQUEST_TIMEOUT_MS, maxResponseBytes } = {}) {
    const p = peer(to);
    if (host.transport.state().state !== 'ready') return { ok: false, lost: 'offline' };
    if (!fresh && host.now() < p.until) return { ok: false, lost: 'backoff' };
    const options = { timeoutMs, maxResponseBytes };
    if (kind !== 'act' && JSON.stringify(body).length < STRANGER_BODY_BYTES - 1024) return exchange(p, pool, to, kind, body, options);
    // A target reads one large body per sender at a time, so an `act`, which may carry a
    // pack, and anything else that large are sent one at a time.
    const turn = (lanes.get(to) ?? Promise.resolve()).then(() => exchange(p, pool, to, kind, body, options));
    const settled = turn.catch(() => {});
    lanes.set(to, settled);
    settled.then(() => lanes.get(to) === settled && lanes.delete(to));
    return turn;
  }

  /// How long a claim round waits for a member: `normal` for one that answered lately,
  /// `patient` for one never reached and known only for a short while, else `short`.
  function patience(pk) {
    const p = peer(pk);
    if (!quiet(p)) return p.seen > 0 ? 'normal' : 'patient';
    return 'short';
  }

  /// A request this host accepted came from that peer.
  function heard(pk) {
    peer(pk).heard = host.now();
  }

  /// `{ lastSeen, reachable }` of a peer: when it last answered or asked (0 for never),
  /// and whether the last request to it was answered.
  function seen(pk) {
    const p = peers.get(pk);
    return { lastSeen: Math.max(p?.seen ?? 0, p?.heard ?? 0), reachable: Boolean(p && p.seen > 0 && p.failures === 0) };
  }

  return { ask, patience, heard, seen };
}
