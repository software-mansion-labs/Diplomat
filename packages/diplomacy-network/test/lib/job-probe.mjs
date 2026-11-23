// A daemon's hold on one run, in a process of its own: it takes up the run whose
// directory stands at <scratch>/base/runs/.containers/probe/<run id>, watches it to its
// end, and prints one line of JSON: the outcome, the longest this process's loop stood
// still meanwhile (`gapMs`), its memory before and at its highest (`rssMiB`), and how
// many pieces over 64 KiB its own thread decoded, parsed, cut or matched (`large`).
// The engine is <scratch>/docker.
// Run: node test/lib/job-probe.mjs <scratch> <run id>

import fs from 'node:fs';
import path from 'node:path';

const [scratch, runId] = process.argv.slice(2);
Object.assign(process.env, {
  DN_BASE_DIR: path.join(scratch, 'base'), DN_DOCKER: path.join(scratch, 'docker'),
  DN_JOB_POLL_MS: '20', DN_JOB_LIVENESS_MS: '60',
});

const PIECE = 64 * 1024;
let large = 0;
// `owner[name]`, counted whenever what it works on is a large piece.
const counting = (owner, name, pieceOf) => {
  const real = owner[name];
  owner[name] = function counted(...args) {
    if ((pieceOf(this, args)?.length ?? 0) > PIECE) large += 1;
    return real.apply(this, args);
  };
};
const text = (v) => (typeof v === 'string' ? v : null);
counting(JSON, 'parse', (self, [given]) => text(given));
counting(Buffer.prototype, 'toString', (self) => self);
for (const name of ['split', 'trim', 'includes', 'indexOf', 'lastIndexOf', 'match', 'replace']) counting(String.prototype, name, (self) => text(self));
for (const name of ['test', 'exec']) counting(RegExp.prototype, name, (self, [given]) => text(given));

const { attachJob, watch } = await import('../../src/executor/job.js');
const { RUNS_DIR } = await import('../../src/paths.js');

let gapMs = 0;
let last = performance.now();
const from = process.memoryUsage.rss();
let to = from;
const beat = setInterval(() => {
  const now = performance.now();
  gapMs = Math.max(gapMs, now - last);
  last = now;
  to = Math.max(to, process.memoryUsage.rss());
}, 5);
if (!attachJob({ runId, container: { name: 'probe', runsDir: path.join(RUNS_DIR, '.containers', 'probe') }, pid: 4242 })) throw new Error('not a run');
const outcome = await watch({ runId });
// One more turn, for whatever the read left this thread to do.
await new Promise((resolve) => { setTimeout(resolve, 50); });
clearInterval(beat);
const mib = (n) => Math.round(n / 2 ** 20);
fs.writeSync(1, `${JSON.stringify({ outcome, gapMs: Math.round(gapMs), rssMiB: [mib(from), mib(to)], large })}\n`);
