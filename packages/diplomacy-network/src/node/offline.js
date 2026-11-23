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

/// Switches off the host whose state `store` holds, with no host running on it: every
/// offer of its own that has not ended is cancelled and every run is stopped and its
/// claim given back, each under a record the host signs, and all of it is on disk when
/// this resolves. A run whose job ended with no host there to hear of it -
/// `outcomeOf(runId)` is what that job left on record, or null - ends as its job did
/// instead: this host's own offer of the task has the outcome; another host's cannot be
/// told with no transport, and its claim is given back like the rest. Answers
/// `{ offers, runs, reported }`: the offers it cancelled, the runs it ended, and how many
/// of those runs ended as their jobs did. A store with no host's key in it is left as it
/// is.
export async function switchOffStored({ store, log = () => {}, outcomeOf = () => null }) {
  if (!identityFromSeed(store.read('identity')?.seed ?? '')) return { offers: 0, runs: 0, reported: 0 };
  // No timer of it fires: the host signs what a switch-off signs and nothing a step
  // would. The one step it takes is the one a job's outcome asks for at once.
  const due = [];
  const clock = { now: () => Math.floor(Date.now() / 1000), setTimeout: (fn, ms) => { if (ms === 0) due.push(fn); return due; }, clearTimeout() {} };
  let report = () => {};
  // A stopped run's job is ended by whoever removes its container; of one that still
  // runs nothing can be said from here.
  const executor = { onEnd(fn) { report = fn; }, async stop() {}, alive: () => null, wouldTake: () => false };
  const node = createNode({
    store, log, transport: noTransport, clock, executor, random: (n) => crypto.randomBytes(n),
    // What a daemon goes by until it has read its config.
    settings: () => ({ requiredMinimumH: HOURS_FLOOR, maximumAcceptedH: HOURS_FLOOR }),
  });
  const open = (rows) => rows.filter((row) => row.endedAt === 0);
  const before = node.snapshot();
  await node.start();
  let reported = 0;
  for (const { runId } of open(before.runs)) {
    const outcome = outcomeOf(runId);
    if (!outcome) continue;
    report(runId, outcome);
    reported += 1;
  }
  if (reported > 0) for (const step of due.splice(0)) step();
  await node.switchOff();
  const after = node.snapshot();
  const was = new Set(open(before.offers).map((offer) => offer.taskId));
  return {
    offers: after.offers.filter((offer) => was.has(offer.taskId) && offer.state === 'cancelled').length,
    runs: open(before.runs).length - open(after.runs).length,
    reported,
  };
}
