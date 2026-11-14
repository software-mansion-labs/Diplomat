// The inbound half of a host: how large a body it agrees to read, the checks every
// request passes before anything is done for it, and the signed answer. Whatever arrives,
// the answer is a signed response: a handler that fails is a `busy` refusal, never a throw.

import { b64u, hash } from '../core/canon.js';
import { ReplayMemory, buildResponse, requestDigest, verifyRequest } from '../core/envelope.js';
import { validPk } from '../core/identity.js';
import { EffortMeter } from '../core/pow.js';
import {
  ACT_TIMEOUT_MS, MAX_ACT_BODY_BYTES, MAX_BODY_BYTES, MAX_LARGE_BODIES, POW, REQUEST_TIMEOUT_MS, STRANGER_BODY_BYTES,
} from '../paths.js';

/// The inbound half of `host`: `{ limit, receive, tally }`. `tally` counts the requests
/// received and the signatures checked for them.
export function createInbound(host) {
  const meter = new EffortMeter();
  const replay = new ReplayMemory();
  const tally = { requests: 0, signatures: 0 };
  const reading = new Map(); // claimed sender -> the timer that gives its turn back

  /// The most bytes of a request with these headers the transport may read. It runs
  /// before any signature is checked, on headers anybody can write, and the transport may
  /// hold that many bytes for each of its connections at once. So a claimed sender buys
  /// little: a member's name gets one body above the stranger's cap at a time, there are
  /// MAX_LARGE_BODIES such bodies over all senders, and only the name of a host holding a
  /// key of this host gets the `act` cap. A liar can at worst take a member's turn until
  /// the timer gives it back.
  function limit(headers) {
    const from = headers['dn-from'];
    const length = Number(headers['content-length']);
    const P = host.pools.get(headers['dn-pool']);
    if (!(length > STRANGER_BODY_BYTES) || !P || !validPk(from) || !P.pool.accepts(from, host.now())) return STRANGER_BODY_BYTES;
    const act = headers['dn-kind'] === 'act' && host.offers.keyHeldBy(from);
    const cap = act ? MAX_ACT_BODY_BYTES : MAX_BODY_BYTES;
    if (length > cap || reading.has(from) || reading.size >= MAX_LARGE_BODIES) return STRANGER_BODY_BYTES;
    reading.set(from, host.clock.setTimeout(() => reading.delete(from), act ? ACT_TIMEOUT_MS : REQUEST_TIMEOUT_MS));
    return cap;
  }

  function release(from) {
    if (!reading.has(from)) return;
    host.clock.clearTimeout(reading.get(from));
    reading.delete(from);
  }

  async function serve(request, size, reply) {
    const now = host.now();
    const isMember = (pool, pk) => host.pools.get(pool)?.pool.accepts(pk, now) ?? false;
    const checked = verifyRequest(request, { self: host.self, now, size, meter, replay, isMember, tally });
    const { effort } = checked;
    if (!checked.ok) return reply({ effort, error: { code: checked.code, detail: checked.detail } });
    const { pool, kind, from, body } = request;
    const P = host.pools.get(pool);
    if (!P) return reply({ effort, error: { code: 'unknown-pool', detail: 'this host has not linked that pool' } });
    if (kind !== 'hello' && !checked.member) return reply({ effort, error: { code: 'not-member', detail: 'say hello first' } });
    const out = await host.handle(P, from, kind, body);
    // What the answer admits to is on disk before the sender can act on it.
    host.store.flush();
    return reply(out.error ? { effort, error: { code: out.error, detail: out.detail ?? '' } } : { effort, body: out.body });
  }

  /// The signed response to the bytes of one request.
  async function receive(bytes, { headers }) {
    tally.requests += 1;
    let request = null;
    try {
      request = JSON.parse(bytes.toString('utf8'));
    } catch {
      // Not JSON: refused below as any other malformed envelope.
    }
    const re = requestDigest(request) ?? b64u(hash(bytes));
    const reply = (part) => Buffer.from(JSON.stringify(buildResponse(host.id, { re, ...part })));
    try {
      return await serve(request, bytes.length, reply);
    } catch (err) {
      host.log(`a request could not be served: ${err?.stack ?? err}`);
      return reply({ effort: POW.strangerBase, error: { code: 'busy', detail: 'the request could not be served' } });
    } finally {
      if (bytes.length > STRANGER_BODY_BYTES) release(headers['dn-from']);
    }
  }

  return { limit, receive, tally };
}
