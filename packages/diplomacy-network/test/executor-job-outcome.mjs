// What reading a run's end costs the daemon that reads it, when the job filled the last
// megabytes of its log with whatever is dearest to make out, or answers every question
// asked in its container with megabytes. Each case is a daemon of its own
// (test/lib/job-probe.mjs) with 768 MiB of heap: it has to live, to name the outcome,
// to stay near the memory it had, and to have handed its own thread no piece of the
// job's writing larger than 64 KiB to decode, to parse, to cut or to match.
// Run: node test/executor-job-outcome.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'dn-jobo-'));

let checks = 0;
const check = async (name, fn) => { await fn(); checks++; console.log(`PASS ${name}`); };

// As much as the read takes of a log, less the room for the rest of the line.
const N = 4 * 2 ** 20 - 4096;
const fill = (unit) => unit.repeat(Math.floor(N / unit.length));
const line = (members) => `{"type":"result","is_error":false,"result":"own","usage":{"input_tokens":3},${members}}\n`;
let keys = '';
for (let i = 0; keys.length < N; i++) keys += `"k${i}":{"inputTokens":1},`;

// What each leaves of the run: what it changes of the result beside it, or null for no
// result at all.
const CASES = [
  ['a string of 4 MiB where the models are named', line(`"modelUsage":${JSON.stringify('x'.repeat(N))}`), {}],
  ['a model named by a megabyte', line(`"modelUsage":{"${'m'.repeat(2 ** 20)}":{"outputTokens":5,"costUSD":1}}`), { tokens: 5, model: 'm'.repeat(100) }],
  ['four million empty lines after the result', `${line('"x":0')}${'\n'.repeat(N)}`, {}],
  ['two million numbers where the models are named', line(`"modelUsage":[${fill('7,')}7]`), null],
  ['a model for every few bytes', line(`"modelUsage":{${keys}"last":{}}`), null],
  ['a million objects in a member nobody reads', line(`"x":[${fill('{},')}0]`), null],
  ['two million lists inside one another', line(`"x":${'['.repeat(N / 2)}${']'.repeat(N / 2)}`), null],
  ['a line that looks like a result for every few bytes', fill('{"a":{"type":"result"}}\n'), null],
];

// A daemon whose engine is the script `docker`, over one run with `files` in its
// directory, to that run's end: what the probe printed.
let made = 0;
async function daemon(docker, files, what) {
  const world = path.join(scratch, `world-${made += 1}`);
  const runDir = path.join(world, 'base', 'runs', '.containers', 'probe', 'run');
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(world, 'docker'), `#!/bin/sh\n${docker}\n`, { mode: 0o755 });
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(runDir, name), text);
  const child = spawn(process.execPath, ['--max-old-space-size=768', path.join(HERE, 'lib', 'job-probe.mjs'), world, 'run'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const out = { stdout: '', stderr: '' };
  for (const name of ['stdout', 'stderr']) child[name].on('data', (c) => { out[name] = (out[name] + c).slice(-4000); });
  const [status, signal] = await new Promise((resolve) => { child.on('close', (...how) => resolve(how)); });
  fs.rmSync(world, { recursive: true, force: true });
  assert.equal(status, 0, `${what}: ${signal ?? ''} ${out.stderr.slice(-600)}`);
  const { outcome, gapMs, rssMiB: [from, to], large } = JSON.parse(out.stdout);
  console.log(`INFO ${what}: the loop stood still ${gapMs} ms at the longest, memory went from ${from} to ${to} MiB`);
  assert.equal(large, 0, `${what}: pieces over 64 KiB walked on the daemon's thread`);
  assert.ok(to - from < 150, `${what}: memory rose by ${to - from} MiB`);
  return outcome;
}

try {
  await check('whatever a job leaves where its result is read, the daemon lives, names the outcome, stays near its memory and makes out none of it on its own thread', async () => {
    for (const [what, log, expected] of CASES) {
      assert.ok(Buffer.byteLength(log) <= 4 * 2 ** 20, what);
      // The engine is asked one thing of a run that ended by itself: to stop what it left.
      const outcome = await daemon('exit 0', { done: '0\n', 'log.jsonl': log }, what);
      const base = { usd: 0, model: '', runner: 'claude', exit: 0 };
      assert.deepEqual(outcome, expected === null
        ? { ...base, ok: false, summary: 'the agent left no result', tokens: 0, state: 'failed' }
        : { ...base, ok: true, summary: 'own', tokens: 3, state: 'finished', ...expected }, what);
    }
  });

  await check('a container that answers every question with megabytes is heard out for 64 KiB of them, and has then said nothing', async () => {
    const blob = path.join(scratch, 'blob');
    fs.writeFileSync(blob, '\n'.repeat(15 * 2 ** 20));
    const outcome = await daemon(`cat ${blob}; cat ${blob} >&2; exit 1`, {}, '15 MiB of empty lines on both streams');
    assert.match(outcome.summary, /disappeared without finishing/);
  });

  console.log(`\nall ${checks} checks passed`);
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
