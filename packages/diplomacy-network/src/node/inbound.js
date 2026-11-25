// Whatever arrives, the answer is a signed response: a failing handler is a `busy`
// refusal, never a throw.

import { b64u, canon, hash, parseCanon } from '../core/canon.js';
import { KINDS, ReplayMemory, UNSERVED, buildResponse, requestDigest, verifyRequest } from '../core/envelope.js';
import { EffortMeter } from '../core/pow.js';
import { shaped } from '../core/records.js';
import {
  MAX_ACT_BODY_BYTES, MAX_BODY_BYTES, MAX_LARGE_BODIES, POW, STRANGER_BODY_BYTES, TICKET_REST_MAX_MS, TICKET_REST_MS,
  TICKET_WAIT_MS,
} from '../paths.js';

export function createInbound(host) {
  const meter = new EffortMeter();
  const replay = new ReplayMemory();
  const tally = { requests: 0, signatures: 0 };
  // The latest `ts` served, across restarts. The replay memory is per process, so nothing
  // dated up to `floor`, the latest an earlier process served, is served again. Clamped to
  // now, so a sender whose clock runs ahead cannot make a start wait for its date.
  let latest = Math.min(Number(host.store.read('heard')?.ts) || 0, host.now());
  const floor = latest;
  // member -> its large-body place: `{ ticket, bytes, again, last, branch }` from `reserve`
  // until the headers arrive (`again`: it had a place just before, at `last`), then
  // `{ branch, whole }` while the body is read and served. Oldest ticket first. A timer
  // finds its ticket gone when it was used, given up or taken.
  const places = new Map();
  const reading = new Map(); // ticket -> the place its body is read in
  const had = new Map(); // member -> when it last had a place
  // member -> `{ times, until }`: its tickets in a row that brought no whole body, and
  // until when it gets no other.
  const unused = new Map();

  // From the second unused ticket in a row, the member waits.
  function wasted(from) {
    const times = (unused.get(from)?.times ?? 0) + 1;
    const rest = times < 2 ? 0 : Math.min(TICKET_REST_MAX_MS, TICKET_REST_MS * 2 ** (times - 2)) / 1000;
    unused.set(from, { times, until: host.now() + rest });
  }

  function lapse(from) {
    wasted(from);
    places.delete(from);
  }

  /// Runs before any signature check, on headers anybody can write, so every sender gets
  /// the stranger's cap; more only for a ticket from a signed, paid `reserve`. Then the
  /// answer is `{ bytes, release }`, and the place stays taken until `release`.
  function limit(headers) {
    const ticket = headers['dn-ticket'];
    const length = Number(headers['content-length']);
    for (const [from, place] of places) {
      if (typeof ticket !== 'string' || place.ticket !== ticket || !(length <= place.bytes)) continue;
      const read = { branch: place.branch, whole: false };
      places.set(from, read);
      reading.set(ticket, read);
      const release = () => {
        if (!reading.delete(ticket)) return;
        places.delete(from);
        had.set(from, host.now());
        if (read.whole) unused.delete(from);
        else wasted(from);
      };
      return { bytes: place.bytes, release };
    }
    return STRANGER_BODY_BYTES;
  }

  const handlers = {
    /// One place per member, MAX_LARGE_BODIES over all; the `act` cap only for a holder of
    /// this host's key. A member and the keys in its seats share one place: one that had it
    /// within TICKET_REST_MS yields its unused ticket to one that had it longer ago, or
    /// never. When none is free, a member that had none for TICKET_REST_MS takes the
    /// oldest unused ticket of one that had.
    reserve(P, from, body) {
      const cap = body.kind === 'act' && host.offers.keyHeldBy(from) ? MAX_ACT_BODY_BYTES : MAX_BODY_BYTES;
      const fine = shaped(body, {
        kind: (v) => KINDS.includes(v), bytes: (v) => Number.isSafeInteger(v) && v > STRANGER_BODY_BYTES && v <= cap,
      });
      if (!fine) return { error: 'bad-request' };
      const now = host.now();
      const full = { error: 'busy', detail: 'no place for a large body is free' };
      if (places.has(from) && !places.get(from).ticket) return full;
      // Asking again leaves the ticket before unused.
      if (places.has(from)) lapse(from);
      if (now < unused.get(from)?.until) return { error: 'busy', detail: 'the tickets this member took went unused' };
      const branch = P.pool.branch(from, now);
      const last = had.get(from) ?? -Infinity;
      const again = now - last < TICKET_REST_MS / 1000;
      const [mate, taken] = [...places].find(([, held]) => held.branch === branch) ?? [];
      if (taken) {
        // A body being read has no `again`, so it is never taken.
        if (!taken.again || last >= taken.last) return full;
        places.delete(mate);
      }
      if (places.size >= MAX_LARGE_BODIES) {
        const [other] = [...places].find(([, held]) => held.ticket && held.again) ?? [];
        if (again || other === undefined) return full;
        places.delete(other);
      }
      const place = { ticket: b64u(host.random(16)), bytes: body.bytes, again, last, branch };
      host.clock.setTimeout(() => places.get(from) === place && lapse(from), TICKET_WAIT_MS);
      places.set(from, place);
      had.set(from, now);
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
    const P = host.pools.get(pool);
    // One refusal for every non-member, whatever it asked: it says nothing of the pools
    // linked here.
    const outsider = () => reply({ effort, error: { code: 'not-member', detail: '' } });
    if (!P || (kind !== 'hello' && !checked.member)) {
      host.gossip.farewell(pool, from);
      return outsider();
    }
    // Served: a member's request, or the hello of a host a member invited.
    const served = checked.member || host.gossip.invited(P, body);
    if (ts > latest && served) {
      latest = ts;
      host.store.write('heard', { ts });
    }
    if (checked.member) {
      host.gossip.hears(P, from);
      host.peers.heard(from);
    }
    const out = await host.handle(P, from, kind, body);
    // A host that is no member is heard once its hello let it in.
    if (!checked.member && !out.error) host.gossip.hears(P, from);
    // What the answer admits to is on disk before the sender can act on it.
    host.store.flush();
    if (!out.error) return reply({ effort, body: out.body });
    if (!checked.member && !host.gossip.invited(P, body)) return outsider();
    return reply({ effort, error: { code: out.error, detail: out.detail ?? '' } });
  }

  /// Any non-canonical spelling of the JSON is refused as malformed. A body above the
  /// stranger's cap that came whole used its ticket, whatever it holds.
  async function receive(bytes, { headers } = {}) {
    const read = reading.get(headers?.['dn-ticket']);
    if (read && bytes.length > STRANGER_BODY_BYTES) read.whole = true;
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
