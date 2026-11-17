// The switch-off of a host that is not running, done on its store: what it signs stays
// in the pools' documents, and the members hear of it once the host starts again.

import crypto from 'node:crypto';
import { identityFromSeed } from '../core/identity.js';
import { HOURS_FLOOR } from '../paths.js';
import { createNode } from './node.js';

// Never ready: a request to a member is lost as `offline` before it is built.
const noTransport = {
  address: '', state: () => ({ state: 'off', detail: '' }), onRequest() {}, limitFor() {}, onState() {}, async start() {}, async stop() {},
};
// No timer of it fires: the host signs what a switch-off signs and nothing a step would.
const stopped = { now: () => Math.floor(Date.now() / 1000), setTimeout: () => null, clearTimeout() {} };
// A stopped run's job is ended by whoever removes its container.
const noExecutor = { onEnd() {}, async stop() {} };

/// Switches off the host whose state `store` holds, with no host running on it: every
/// offer of its own that has not ended is cancelled and every run is stopped and its
/// claim given back, each under a record the host signs, and all of it is on disk when
/// this resolves. Answers `{ offers, runs }`, how many of each it ended. A store with no
/// host's key in it is left as it is.
export async function switchOffStored({ store, log = () => {} }) {
  if (!identityFromSeed(store.read('identity')?.seed ?? '')) return { offers: 0, runs: 0 };
  const node = createNode({
    store, log, transport: noTransport, clock: stopped, executor: noExecutor, random: (n) => crypto.randomBytes(n),
    // What a daemon goes by until it has read its config.
    settings: () => ({ requiredMinimumH: HOURS_FLOOR, maximumAcceptedH: HOURS_FLOOR }),
  });
  const open = () => {
    const { offers, runs } = node.snapshot();
    return { offers: offers.filter((o) => o.endedAt === 0).length, runs: runs.filter((r) => r.endedAt === 0).length };
  };
  const before = open();
  await node.start();
  await node.switchOff();
  const after = open();
  return { offers: before.offers - after.offers, runs: before.runs - after.runs };
}
