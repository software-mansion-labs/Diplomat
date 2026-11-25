import crypto from 'node:crypto';
import { identityFromSeed } from '../core/identity.js';
import { HOURS_FLOOR } from '../paths.js';
import { createNode } from './node.js';

// Never ready: every request to a member fails as `offline`.
const noTransport = {
  address: '', state: () => ({ state: 'off', detail: '' }), onRequest() {}, limitFor() {}, onState() {}, async start() {}, async stop() {},
};

/// Switches off a host that is not running, on its store alone; members hear of it when
/// the host starts again. `outcomeOf(runId)` resolves to how a job ended unseen, or null:
/// a run on this host's own offer then ends as its job did, any other run's claim is
/// given back like the rest. `reported` counts the runs that ended as their jobs did. A
/// store with no identity is left as it is.
export async function switchOffStored({ store, log = () => {}, outcomeOf = () => null }) {
  if (!identityFromSeed(store.read('identity')?.seed ?? '')) return { offers: 0, runs: 0, reported: 0 };
  // No timer fires, so nothing a step would sign gets signed; only the zero-delay steps a
  // reported outcome asks for are run.
  const due = [];
  const clock = { now: () => Math.floor(Date.now() / 1000), setTimeout: (fn, ms) => { if (ms === 0) due.push(fn); return due; }, clearTimeout() {} };
  let report = () => {};
  // A stopped run's container is removed by someone else; liveness is unknown here.
  const executor = { onEnd(fn) { report = fn; }, async stop() {}, alive: () => null, wouldTake: () => false };
  const node = createNode({
    store, log, transport: noTransport, clock, executor, random: (n) => crypto.randomBytes(n),
    // A daemon's defaults before it reads its config.
    settings: () => ({ requiredMinimumH: HOURS_FLOOR, maximumAcceptedH: HOURS_FLOOR }),
  });
  const open = (rows) => rows.filter((row) => row.endedAt === 0);
  const before = node.snapshot();
  await node.start();
  let reported = 0;
  for (const { runId } of open(before.runs)) {
    const outcome = await outcomeOf(runId);
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
