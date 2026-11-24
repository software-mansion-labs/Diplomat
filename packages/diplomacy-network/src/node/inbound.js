// The inbound half of a host: how large a body it agrees to read, the checks every
// request passes before anything is done for it, and the signed answer. Whatever arrives,
// the answer is a signed response: a handler that fails is a `busy` refusal, never a throw.

import { b64u, canon, hash, parseCanon } from '../core/canon.js';
import { KINDS, ReplayMemory, UNSERVED, buildResponse, requestDigest, verifyRequest } from '../core/envelope.js';
import { EffortMeter } from '../core/pow.js';
import { shaped } from '../core/records.js';
import {
  MAX_ACT_BODY_BYTES, MAX_BODY_BYTES, MAX_LARGE_BODIES, POW, STRANGER_BODY_BYTES, TICKET_REST_MAX_MS, TICKET_REST_MS,
  TICKET_WAIT_MS,
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
  // `floor`, the latest it served, is served again. A sender whose clock runs ahead
  // dates its requests past this host's clock, and no start waits for such a date.
  let latest = Math.min(Number(host.store.read('heard')?.ts) || 0, host.now());
  const floor = latest;
  // member -> its place for a body above the stranger's cap: `{ ticket, bytes, again,
  // last, branch }` from the `reserve` that gave it until the body's headers arrive -
  // `again` for a member that had a place a moment before, at `last` - and
  // `{ branch, whole }` while the body is read and served. The oldest ticket comes
  // first. A timer finds its ticket gone when the ticket was used, given up or taken.
  const places = new Map();
  const reading = new Map(); // ticket -> the place its body is read in
  const had = new Map(); // member -> when it last had a place
  // member -> `{ times, until }`: how many of its tickets running brought no whole body,
  // and until when it is given no other.
  const unused = new Map();

  // A ticket of `from` brought no body: the second running costs the member a wait.
  function wasted(from) {
    const times = (unused.get(from)?.times ?? 0) + 1;
    const rest = times < 2 ? 0 : Math.min(TICKET_REST_MAX_MS, TICKET_REST_MS * 2 ** (times - 2)) / 1000;
    unused.set(from, { times, until: host.now() + rest });
  }

  // The ticket `from` holds is void and its place free.
  function lapse(from) {
    wasted(from);
    places.delete(from);
  }

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
    /// A member asks for a place to send one request of `kind` of up to `bytes`: a member
    /// has one place at a time, there are MAX_LARGE_BODIES over all members, and only the
    /// holder of a key of this host gets the `act` cap. A member and the keys in its seats
    /// have one place between them: one of them that had it within TICKET_REST_MS
    /// yields its unused ticket to one that had it longer ago, or never. A ticket is
    /// void when the body's headers have not come TICKET_WAIT_MS later, and a member
    /// whose tickets bring no whole body above the stranger's cap gets none for a
    /// while. When no place is free, a member that had none for TICKET_REST_MS takes the
    /// oldest unused ticket of a member that had.
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
        // A body being read has no `again`.
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
    // Whoever this host does not take for a member gets one refusal, whatever the pool
    // and whatever it asked: it says nothing of the pools linked here.
    const outsider = () => reply({ effort, error: { code: 'not-member', detail: '' } });
    if (!P || (kind !== 'hello' && !checked.member)) {
      host.gossip.farewell(pool, from);
      return outsider();
    }
    // Only what this host serves is remembered as served: a member's request, and the
    // hello of a host a member invited.
    const served = checked.member || host.gossip.invited(P, body);
    if (ts > latest && served) {
      latest = ts;
      host.store.write('heard', { ts });
    }
    if (checked.member) {
      host.gossip.hears(P);
      host.peers.heard(from);
    }
    const out = await host.handle(P, from, kind, body);
    // A host that is no member is heard once its hello let it in.
    if (!checked.member && !out.error) host.gossip.hears(P);
    // What the answer admits to is on disk before the sender can act on it.
    host.store.flush();
    if (!out.error) return reply({ effort, body: out.body });
    if (!checked.member && !host.gossip.invited(P, body)) return outsider();
    return reply({ effort, error: { code: out.error, detail: out.detail ?? '' } });
  }

  /// The signed response to the bytes of one request. Only the canonical form of a
  /// request is one: any other spelling of the same JSON is refused as malformed. A
  /// body above the stranger's cap that came whole made use of the ticket in its
  /// `headers`, whatever it holds; a smaller one needed none.
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
