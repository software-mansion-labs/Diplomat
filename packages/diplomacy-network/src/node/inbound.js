// The inbound half of a host: how large a body it agrees to read, the checks every
// request passes before anything is done for it, and the signed answer. Whatever arrives,
// the answer is a signed response: a handler that fails is a `busy` refusal, never a throw.

import { b64u, canon, hash, parseCanon } from '../core/canon.js';
import { KINDS, ReplayMemory, UNSERVED, buildResponse, requestDigest, verifyRequest } from '../core/envelope.js';
import { EffortMeter } from '../core/pow.js';
import { shaped } from '../core/records.js';
import {
  MAX_ACT_BODY_BYTES, MAX_BODY_BYTES, MAX_LARGE_BODIES, POW, REQUEST_TIMEOUT_MS, STRANGER_BODY_BYTES,
} from '../paths.js';

/// The inbound half of `host`: `{ limit, receive, handlers, tally }`. `tally` counts the
/// requests received and the signatures checked for them.
export function createInbound(host) {
  const meter = new EffortMeter();
  const replay = new ReplayMemory();
  const tally = { requests: 0, signatures: 0 };
  // The latest `ts` among the requests this host served, in this life and the ones
  // before it. The replay memory is this process's own, so what an earlier process
  // served is told from what it did not by its date alone: nothing dated up to
  // `floor`, the latest it served, is served again.
  let latest = Number(host.store.read('heard')?.ts) || 0;
  const floor = latest;
  // member -> its place for a body above the stranger's cap: `{ ticket, bytes, timer }`
  // from the `reserve` that gave it until the body's headers arrive, `{}` while the
  // body is read and served.
  const places = new Map();

  /// The most bytes of a request with these headers the transport may read. It runs
  /// before any signature is checked, on headers anybody can write, so the headers buy
  /// nothing by themselves: every sender gets the stranger's cap. More is read only for
  /// a ticket, which a member was handed in the answer to a `reserve` that paid its
  /// proof of work and was signed. The answer is then `{ bytes, release }`, and the
  /// place stays taken until the transport calls `release`.
  function limit(headers) {
    const ticket = headers['dn-ticket'];
    const length = Number(headers['content-length']);
    for (const [from, place] of places) {
      if (typeof ticket !== 'string' || place.ticket !== ticket || !(length <= place.bytes)) continue;
      host.clock.clearTimeout(place.timer);
      const reading = {};
      places.set(from, reading);
      return { bytes: place.bytes, release: () => places.get(from) === reading && places.delete(from) };
    }
    return STRANGER_BODY_BYTES;
  }

  const handlers = {
    /// A member asks for a place to send one request of `kind` of up to `bytes`: a member
    /// has one place at a time, there are MAX_LARGE_BODIES over all members, and only the
    /// holder of a key of this host gets the `act` cap. A ticket not used in time is void.
    reserve(P, from, body) {
      const cap = body.kind === 'act' && host.offers.keyHeldBy(from) ? MAX_ACT_BODY_BYTES : MAX_BODY_BYTES;
      const fine = shaped(body, {
        kind: (v) => KINDS.includes(v), bytes: (v) => Number.isSafeInteger(v) && v > STRANGER_BODY_BYTES && v <= cap,
      });
      if (!fine) return { error: 'bad-request' };
      const mine = places.get(from);
      const taken = mine ? !mine.ticket : places.size >= MAX_LARGE_BODIES;
      if (taken) return { error: 'busy', detail: 'no place for a large body is free' };
      host.clock.clearTimeout(mine?.timer);
      const place = { ticket: b64u(host.random(16)), bytes: body.bytes };
      place.timer = host.clock.setTimeout(() => places.get(from) === place && places.delete(from), REQUEST_TIMEOUT_MS);
      places.set(from, place);
      return { body: { ticket: place.ticket } };
    },
  };

  async function serve(request, size, reply) {
    const now = host.now();
    const isMember = (pool, pk) => host.pools.get(pool)?.pool.accepts(pk, now) ?? false;
    const checked = verifyRequest(request, { self: host.self, now, size, meter, replay, isMember, tally });
    const { effort } = checked;
    if (!checked.ok) return reply({ effort, error: { code: checked.code, detail: checked.detail } });
    const { pool, kind, from, body, ts } = request;
    if (ts <= floor) return reply({ effort, error: { code: 'busy', detail: UNSERVED } });
    if (ts > latest) {
      latest = ts;
      host.store.write('heard', { ts });
    }
    const P = host.pools.get(pool);
    // Whoever this host does not take for a member gets one refusal, whatever the pool
    // and whatever it asked: it says nothing of the pools linked here.
    const outsider = () => reply({ effort, error: { code: 'not-member', detail: '' } });
    if (!P || (kind !== 'hello' && !checked.member)) {
      host.gossip.farewell(pool, from);
      return outsider();
    }
    if (checked.member) host.peers.heard(from);
    const out = await host.handle(P, from, kind, body);
    // What the answer admits to is on disk before the sender can act on it.
    host.store.flush();
    if (!out.error) return reply({ effort, body: out.body });
    if (!checked.member && !host.gossip.invited(P, body)) return outsider();
    return reply({ effort, error: { code: out.error, detail: out.detail ?? '' } });
  }

  /// The signed response to the bytes of one request. Only the canonical form of a
  /// request is one: any other spelling of the same JSON is refused as malformed.
  async function receive(bytes) {
    tally.requests += 1;
    const request = parseCanon(bytes);
    const re = requestDigest(request) ?? b64u(hash(bytes));
    const reply = (part) => canon(buildResponse(host.id, { re, ...part }));
    try {
      return await serve(request, bytes.length, reply);
    } catch (err) {
      host.log(`a request could not be served: ${err?.stack ?? err}`);
      return reply({ effort: POW.strangerBase, error: { code: 'busy', detail: 'the request could not be served' } });
    }
  }

  return { limit, receive, handlers, tally };
}
