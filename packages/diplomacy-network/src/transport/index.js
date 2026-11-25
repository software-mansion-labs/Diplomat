// The tor and loop drivers supply only how a host becomes reachable and how a peer is
// dialled; framing, limits and failure codes are shared.

import { onionAddress } from '../core/identity.js';
import { LOOP_DIR, REQUEST_TIMEOUT_MS, TOR_DIR, TRANSPORT } from '../paths.js';
import { DEFAULT_LIMIT, createClient, createServer } from './http.js';
import { loopDriver } from './loop.js';
import { torDriver } from './tor.js';

/// `dir` is tor's data directory or the loop directory; `tune` overrides HTTP_TUNING and
/// TOR_TUNING. A transport starts once: after `stop()` a new one is created.
export function createTransport({ kind = TRANSPORT, identity, dir, log = () => {}, tune = {} }) {
  const address = onionAddress(identity.pk);
  // Loopback TCP stands in for Tor in tests alone: whoever reads the state is told so.
  const told = (detail) => (kind === 'loop' ? `loop (test transport): ${detail}` : detail);
  let current = { state: 'starting', detail: told('not started') };
  const watchers = [];
  let phase = 'new'; // new -> started -> stopped

  function setState(state, said = '') {
    const detail = told(said);
    if (phase === 'stopped' || (state === current.state && detail === current.detail)) return;
    current = { state, detail };
    log(`transport: ${state}${detail ? ` (${detail})` : ''}`);
    for (const fn of watchers) {
      try { fn({ ...current }); } catch (err) { log(`transport: state watcher failed: ${err?.stack ?? err}`); }
    }
  }

  let driver;
  if (kind === 'tor') driver = torDriver({ identity, address, dir: dir ?? TOR_DIR, log, tune, setState });
  else if (kind === 'loop') driver = loopDriver({ address, dir: dir ?? LOOP_DIR, setState });
  else throw new TypeError(`unknown transport kind: ${kind}`);

  const server = createServer({ log, tune });
  const client = createClient({ dial: driver.dial, tune });

  let ending = null;
  function shutdown(detail) {
    ending ??= (async () => {
      setState('failed', detail);
      phase = 'stopped';
      client.close();
      await Promise.all([server.close(), driver.stop()]);
    })();
    return ending;
  }

  return {
    address,
    state: () => ({ ...current }),
    onState(fn) { watchers.push(fn); },
    onRequest: server.onRequest,
    limitFor: server.limitFor,

    /// With tor, resolves after bootstrap however long that takes, before the onion service
    /// is known to be reachable. Rejects, with everything torn down, when that cannot happen.
    async start() {
      if (phase !== 'new') throw new Error('a transport starts once');
      phase = 'started';
      try {
        await driver.start(await server.listen());
      } catch (err) {
        await shutdown(err.message);
        throw err;
      }
    },

    /// Rejects with a TransportError code. Sent once, except on a kept connection found
    /// dead before any byte of an answer.
    async request(pk, body, { timeoutMs = REQUEST_TIMEOUT_MS, maxResponseBytes = DEFAULT_LIMIT, headers } = {}) {
      if (!Buffer.isBuffer(body)) throw new TypeError('a request body is a Buffer');
      const onion = onionAddress(pk);
      const deadline = Date.now() + timeoutMs;
      if (driver.hold) await driver.hold(onion, deadline);
      const answer = await client.request(onion, body, { deadline, maxResponseBytes, headers });
      if (driver.check) driver.check(onion);
      return answer;
    },

    /// Requests in flight reject with `stopped`, every connection closes, tor exits.
    async stop() {
      await shutdown('stopped');
    },
  };
}
