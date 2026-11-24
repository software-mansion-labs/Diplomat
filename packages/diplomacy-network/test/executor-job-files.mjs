// What a job can make of its run directory, and what the host then does with it: a
// pipe, a socket, a directory or a link where a file is expected, a file of any size or
// one that grows, a result line of any shape, a figure of any size - and the remains of
// a run that will not go - and what the host puts there, and takes for a start, a run
// or an end. The docker here answers `exec` and nothing else: a start with a process
// group, a question after a job with what the test wrote for that run, and either with
// what a script the test wrote for it does (<run id>.start, <run id>.sh); and `version`.
// With a file `down` it answers nothing at all.
// Run: node test/executor-job-files.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { scratchDir } from './lib/scratch.mjs';

const scratch = scratchDir('dn-jobf-');
const R = `jf-${process.pid}`;
const stateDir = path.join(scratch, 'state');
const dockerBin = path.join(scratch, 'docker');
fs.mkdirSync(stateDir);
// `exec <container> <shell> -c <script> <name> <arguments>`: stop.sh's arguments begin
// with a verb and a run id; anything else is the start of a job.
fs.writeFileSync(dockerBin, `#!/bin/sh
if [ -e "$JOBF_STATE/down" ]; then echo "down $1" >> "$JOBF_STATE/calls"; echo 'Cannot connect to the Docker daemon' >&2; exit 1; fi
if [ "$1" = version ]; then echo version >> "$JOBF_STATE/calls"; echo 27.0.0; exit 0; fi
verb=''; run=''; prev=''
for a in "$@"; do
  case "$prev" in up|left|stop) if [ -z "$verb" ] && [ -e "$JOBF_STATE/$a" ]; then verb="$prev"; run="$a"; fi ;; esac
  prev="$a"
done
if [ -z "$verb" ]; then
  echo "start $prev" >> "$JOBF_STATE/calls"
  if [ -e "$JOBF_STATE/$prev.start" ]; then . "$JOBF_STATE/$prev.start"; fi
  echo 4242; exit 0
fi
echo "$verb $run" >> "$JOBF_STATE/calls"
[ "$verb" = stop ] && exit 0
if [ -e "$JOBF_STATE/$run.sh" ]; then . "$JOBF_STATE/$run.sh"; fi
cat "$JOBF_STATE/$run"
`, { mode: 0o755 });

const BASE = path.join(scratch, 'base');
Object.assign(process.env, {
  DN_BASE_DIR: BASE, DN_DOCKER: dockerBin, JOBF_STATE: stateDir,
  DN_JOB_POLL_MS: '20', DN_JOB_LIVENESS_MS: '60', DN_JOB_STOP_GRACE_MS: '1000',
});
const { attachJob, forgetRuns, readOutcome, startJob, stopJob, unended, watch } = await import('../src/executor/job.js');
// The same module as a daemon started later holds it: it knows of no job.
const later = await import('../src/executor/job.js?later');
const { RUNS_DIR } = await import('../src/paths.js');

let checks = 0;
const check = async (name, fn) => { await fn(); checks++; console.log(`PASS ${name}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (what, fn, ms = 60000) => { for (const end = Date.now() + ms; Date.now() < end;) { if (await fn()) return; await sleep(10); } assert.fail(`never: ${what}`); };
// A read that waits on what a job planted never comes back by itself.
function soon(promise, what, ms = 60000) {
  let timer;
  const late = new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error(`never: ${what}`)), ms); });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

// The loop this process shares with every read made here: it turns while they wait.
let beats = 0;
const beating = setInterval(() => { beats += 1; }, 2);

const container = { name: 'dn-job-files', runsDir: path.join(RUNS_DIR, '.containers', 'dn-job-files') };
fs.mkdirSync(container.runsDir, { recursive: true });
const dirOf = (runId) => path.join(container.runsDir, runId);
const says = (runId, what) => fs.writeFileSync(path.join(stateDir, runId), `${what}\n`);
const RESULT = (fields) => `${JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'own', ...fields })}\n`;

// A run directory as a job left it, linked from RUNS_DIR the way `startJob` links it.
let made = 0;
function runDir(files = {}) {
  const runId = `${R}-${made += 1}`;
  fs.mkdirSync(dirOf(runId));
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dirOf(runId), name), text);
  fs.symlinkSync(path.relative(RUNS_DIR, dirOf(runId)), path.join(RUNS_DIR, runId));
  says(runId, 'up');
  return runId;
}

// The run as a daemon holds it, watched to its end.
async function ended(runId, more = {}, mod = { attachJob, watch }) {
  assert.equal(mod.attachJob({ runId, container, pid: 4242, ...more }), true);
  const before = beats;
  const outcome = await soon(mod.watch({ runId }), `the end of ${runId}`);
  assert.ok(beats > before, 'the loop turned while the run was read');
  await assert.rejects(mod.watch({ runId }), /is not running/, 'a run that ended is no longer held');
  assert.deepEqual(readOutcome(runId), outcome, 'the outcome is on disk as it was resolved');
  return outcome;
}

const hostFile = path.join(scratch, 'host.txt');
fs.writeFileSync(hostFile, RESULT({ result: 'contents of a file on the host' }));
const hostDone = path.join(scratch, 'host-done');
fs.writeFileSync(hostDone, '0\n');
const mknod = spawnSync('mknod', [path.join(scratch, 'node'), 'c', '1', '3']).status === 0;
if (!mknod) console.log('INFO no device node is tried: mknod is root\'s here');
// Everything that can stand where a file is expected.
const PLANTS = {
  'a pipe': (at) => execFileSync('mkfifo', [at]),
  'a socket': (at) => assert.equal(spawnSync(process.execPath, ['-e', 'require("net").createServer().listen(process.argv[1], () => process.exit(0))', path.basename(at)], { cwd: path.dirname(at) }).status, 0),
  'a directory': (at) => { fs.mkdirSync(at); fs.writeFileSync(path.join(at, 'inside'), '0\n'); },
  'a link': (at) => fs.symlinkSync(path.basename(at) === 'done' ? hostDone : hostFile, at),
  ...(mknod ? { 'a device': (at) => execFileSync('mknod', [at, 'c', '1', '3']) } : {}),
};
const VANISHED = /disappeared without finishing/;

const pool = { id: 'github.com/dn-test/alpha', forge: 'github', host: 'github.com', owner: 'dn-test', repo: 'alpha' };
const SPEC = { prompt: 'Review.', item: '', base: '', name: 'Requester', email: 'requester@example.com' };
const proxy = { proxyUrl: 'http://dn:token@127.0.0.1:1', caCertPath: hostFile };
const start = (runId, more = {}) => startJob({ run: { runId, pool }, container, spec: SPEC, proxy, ...more });
// What this user cannot remove, as what root made in a run directory is to the daemon's
// user on an engine that runs containers as root.
const stuck = (runId) => {
  fs.mkdirSync(path.join(dirOf(runId), 'roots'));
  fs.writeFileSync(path.join(dirOf(runId), 'roots', 'file'), 'x');
  fs.chmodSync(path.join(dirOf(runId), 'roots'), 0o000);
};
const unstick = (runId) => { try { fs.chmodSync(path.join(dirOf(runId), 'roots'), 0o700); } catch {} };
// The run as one last heard of two hours ago.
const old = (runId) => {
  const then = new Date(Date.now() - 2 * 3600 * 1000);
  for (const file of [path.join(RUNS_DIR, runId), path.join(RUNS_DIR, `${runId}.outcome.json`)]) {
    try { fs.lutimesSync(file, then, then); } catch {}
  }
};
// Whether a run's directory, its link and its outcome are there.
const left = (runId) => [dirOf(runId), path.join(RUNS_DIR, runId), path.join(RUNS_DIR, `${runId}.outcome.json`)].map((file) => fs.lstatSync(file, { throwIfNoEntry: false }) !== undefined);
const HOUR = 3600 * 1000;
const root = process.getuid() === 0;
if (root) console.log('INFO nothing is beyond this user to remove: the checks of a run directory that will not go are left out');

try {
  await check('a pipe, a socket, a directory, a link or a device where `done` should be is no end of the run, and waiting on none of them stops the daemon', async () => {
    for (const [what, plant] of Object.entries(PLANTS)) {
      const runId = runDir({ 'log.jsonl': RESULT({}) });
      plant(path.join(dirOf(runId), 'done'));
      says(runId, 'gone');
      const outcome = await ended(runId);
      assert.deepEqual([outcome.ok, outcome.exit, outcome.state], [false, null, 'failed'], what);
      assert.match(outcome.summary, VANISHED, what);
    }
  });

  await check('the same where the log should be leaves a run with no result, and where either of the other two logs should be, with no word from it', async () => {
    for (const [what, plant] of Object.entries(PLANTS)) {
      const noLog = runDir({ done: '0\n', 'stderr.log': 'said on stderr\n' });
      plant(path.join(dirOf(noLog), 'log.jsonl'));
      assert.deepEqual(await ended(noLog), { ok: false, summary: 'the agent left no result: said on stderr', usd: 0, tokens: 0, model: '', runner: 'claude', exit: 0, state: 'failed' }, what);

      const noStderr = runDir({ done: '3\n', 'setup.log': 'said while setting up\n' });
      plant(path.join(dirOf(noStderr), 'stderr.log'));
      assert.equal((await ended(noStderr)).summary, 'the agent left no result: said while setting up', what);

      const noSetup = runDir({ done: '3\n' });
      plant(path.join(dirOf(noSetup), 'setup.log'));
      assert.equal((await ended(noSetup)).summary, 'the agent left no result', what);
    }
  });

  await check('a daemon started later takes up a run whose directory holds pipes, watches it to an end and stops another, and a pipe where the directory should be is no run', async () => {
    const [ends, stopped] = [runDir({ done: '0\n' }), runDir()];
    for (const runId of [ends, stopped]) for (const name of ['log.jsonl', 'stderr.log', 'setup.log']) execFileSync('mkfifo', [path.join(dirOf(runId), name)]);
    execFileSync('mkfifo', [path.join(dirOf(stopped), 'done')]);
    const found = later.unended().filter(({ runId }) => [ends, stopped].includes(runId));
    assert.deepEqual(found.map(({ runId }) => runId).sort(), [ends, stopped].sort());
    assert.deepEqual(found[0].container, container);
    assert.deepEqual([(await ended(ends, {}, later)).summary, readOutcome(ends).exit], ['the agent left no result', 0]);

    assert.equal(later.attachJob({ runId: stopped, container }), true);
    says(stopped, 'gone');
    const before = beats;
    assert.equal((await soon(later.stopJob({ runId: stopped }, { restart: () => assert.fail('nothing is restarted') }), 'the stop')).state, 'stopped');
    assert.ok(beats > before);
    assert.deepEqual(later.unended().filter(({ runId }) => [ends, stopped].includes(runId)), [], 'both have an outcome on record');

    const piped = `${R}-piped`;
    execFileSync('mkfifo', [dirOf(piped)]);
    assert.equal(later.attachJob({ runId: piped, container }), false, 'no directory, no group: no run');
    says(piped, 'gone');
    assert.match((await ended(piped, {}, later)).summary, VANISHED, 'with a group it is a run, and one that left nothing');
  });

  await check('a file of a terabyte is read by its end, and a log of which the result is not in the last 4 MiB has none', async () => {
    const sparse = runDir({ done: '0\n' });
    const log = fs.openSync(path.join(dirOf(sparse), 'log.jsonl'), 'w');
    fs.ftruncateSync(log, 2 ** 40);
    fs.writeSync(log, `\n${RESULT({ result: 'at the end of a terabyte' })}`, 2 ** 40);
    fs.closeSync(log);
    assert.equal((await ended(sparse)).summary, 'at the end of a terabyte');

    // A `done` that holds no exit code is none, whatever its size: the runner is gone.
    for (const size of [2, 2 ** 40]) {
      const hollow = runDir({ done: 'x\n', 'stderr.log': '' });
      for (const name of ['done', 'stderr.log']) fs.truncateSync(path.join(dirOf(hollow), name), size);
      says(hollow, 'gone');
      assert.match((await ended(hollow)).summary, VANISHED);
    }

    const early = runDir({ done: '0\n', 'log.jsonl': `${RESULT({ result: 'said too early' })}${'x'.repeat(4 * 2 ** 20)}\n` });
    assert.equal((await ended(early)).summary, 'the agent left no result');
    const late = runDir({ done: '0\n', 'log.jsonl': `${'x'.repeat(4 * 2 ** 20)}\n${RESULT({ result: 'said last' })}` });
    assert.equal((await ended(late)).summary, 'said last');
  });

  await check('a log that grows while it is read gives the result that stood at its end when it was opened', async () => {
    const runId = runDir({ 'log.jsonl': RESULT({ result: 'line 0' }) });
    const writer = spawn(process.execPath, ['-e', `
      const fs = require('fs');
      const fd = fs.openSync(process.argv[1], 'a');
      const wait = new Int32Array(new SharedArrayBuffer(4));
      for (let n = 1; ; n++) {
        fs.writeSync(fd, JSON.stringify({ type: 'result', result: 'line ' + n, pad: 'x'.repeat(512) }) + '\\n');
        if (n % 16 === 0) Atomics.wait(wait, 0, 0, 1);
      }
    `, path.join(dirOf(runId), 'log.jsonl')], { stdio: 'ignore' });
    try {
      await until('the log grows', () => fs.statSync(path.join(dirOf(runId), 'log.jsonl')).size > 2 ** 16);
      fs.writeFileSync(path.join(dirOf(runId), 'done'), '0\n');
      const outcome = await ended(runId);
      // A line cut short by the read is none; the one before it is whole.
      assert.match(outcome.summary, /^line \d+$/);
      assert.ok(Number(outcome.summary.slice(5)) > 0);
    } finally { writer.kill('SIGKILL'); }
  });

  await check('a link put where the run directory stands, at any moment of a read, is never read through', async () => {
    const foreign = path.join(scratch, 'foreign');
    fs.mkdirSync(foreign);
    fs.writeFileSync(path.join(foreign, 'done'), '0\n');
    fs.writeFileSync(path.join(foreign, 'log.jsonl'), RESULT({ result: 'another directory\'s result' }));
    const summaries = new Map();
    for (let n = 0; n < 60; n++) {
      const runId = runDir({ done: '0\n', 'log.jsonl': RESULT({}) });
      // The job, for as long as its run is read: its directory and the link in turns.
      const swapper = spawn(process.execPath, ['-e', `
        const fs = require('fs');
        const [dir, foreign] = process.argv.slice(1);
        for (;;) {
          try { fs.renameSync(dir, dir + '.real'); fs.symlinkSync(foreign, dir); fs.unlinkSync(dir); fs.renameSync(dir + '.real', dir); } catch {}
        }
      `, dirOf(runId), foreign], { stdio: 'ignore' });
      try {
        await until('the swapper swaps', () => fs.existsSync(`${dirOf(runId)}.real`) || fs.lstatSync(dirOf(runId), { throwIfNoEntry: false })?.isSymbolicLink(), 20000);
        const outcome = await ended(runId);
        summaries.set(outcome.summary, (summaries.get(outcome.summary) ?? 0) + 1);
      } finally { swapper.kill('SIGKILL'); }
    }
    assert.equal(summaries.get('another directory\'s result'), undefined, JSON.stringify([...summaries]));
    assert.ok(summaries.get('own') > 0, `the run's own result is read between swaps: ${JSON.stringify([...summaries])}`);
  });

  await check('an outcome a job writes among its container\'s run directories is nobody\'s: the host keeps its own beside them', async () => {
    const runId = runDir({ done: '1\n' });
    const planted = { ok: true, summary: 'planted', usd: 0, tokens: 0, model: '', runner: 'claude', exit: 0, state: 'finished' };
    for (const at of [`${dirOf(runId)}.outcome.json`, path.join(dirOf(runId), `${runId}.outcome.json`)]) fs.writeFileSync(at, JSON.stringify(planted));
    assert.equal(readOutcome(runId), null);
    assert.deepEqual(unended().filter((run) => run.runId === runId).map((run) => run.container), [container]);
    assert.equal((await ended(runId)).ok, false);
    assert.ok(path.relative(container.runsDir, path.join(RUNS_DIR, `${runId}.outcome.json`)).startsWith('..'));
  });

  await check('a result line of any shape gives an outcome: a member that is no object counts for nothing, a figure that is no positive number is none, words are cut at 4000 and a model\'s name at 100, and a line of 100000 values is no result', async () => {
    const big = { inputTokens: 10, outputTokens: 20, cacheReadInputTokens: 300, cacheCreationInputTokens: 4000, costUSD: 0.2 };
    const SHAPES = [
      [{ modelUsage: { m: null } }, { tokens: 0, model: 'm' }],
      [{ modelUsage: { a: 5, b: 'x', c: [1], d: true, big }, total_cost_usd: 0.25 }, { tokens: 4330, model: 'big', usd: 0.25 }],
      [{ modelUsage: [], usage: { input_tokens: 3, output_tokens: 4 } }, { tokens: 7 }],
      [{ modelUsage: null, usage: null }, {}],
      [{ modelUsage: 'abc', usage: { input_tokens: 3 } }, { tokens: 3 }],
      [{ modelUsage: [big], usage: { input_tokens: 3 } }, { tokens: 3 }],
      [{ modelUsage: { ['n'.repeat(101)]: big } }, { tokens: 4330, model: 'n'.repeat(100) }],
      [{ usage: 'abc' }, {}],
      [{ usage: { input_tokens: '7', output_tokens: -4, cache_read_input_tokens: null, cache_creation_input_tokens: 2 } }, { tokens: 2 }],
      [{ modelUsage: { m: { inputTokens: -1, outputTokens: '9', cacheReadInputTokens: {}, cacheCreationInputTokens: 6, costUSD: 'dear' } } }, { tokens: 6, model: 'm' }],
      [{ total_cost_usd: '1' }, {}],
      [{ total_cost_usd: -1 }, {}],
      [{ result: { toString: 1 } }, { summary: '' }],
      [{ result: 5 }, { summary: '' }],
      [{ result: null }, { summary: '' }],
      [{ result: 'w'.repeat(3 * 2 ** 20) }, { summary: 'w'.repeat(4000) }],
      [{ is_error: true }, { ok: false, state: 'failed' }],
      [{ is_error: 'no' }, {}],
    ];
    for (const [fields, expected] of SHAPES) {
      const runId = runDir({ done: '0\n', 'log.jsonl': RESULT(fields) });
      assert.deepEqual(await ended(runId), { ok: true, summary: 'own', usd: 0, tokens: 0, model: '', runner: 'claude', exit: 0, state: 'finished', ...expected }, JSON.stringify(fields).slice(0, 200));
    }
    const exited3 = runDir({ done: '3\n', 'log.jsonl': RESULT({}) });
    assert.deepEqual(await ended(exited3), { ok: false, summary: 'own', usd: 0, tokens: 0, model: '', runner: 'claude', exit: 3, state: 'failed' }, 'a result beside an exit code that is not 0');
    // What JSON itself reads as no number, a line that only looks like a result, and a
    // line by how many commas and opening brackets it has outside its strings: 99999 of
    // them is the most a result has.
    const zeros = (n) => Array(n).fill(0).join(',');
    const marks = ',[{"\\'.repeat(80000);
    const RAW = [
      [`{"type":"result","result":"own","x":[${zeros(99996)}]}`, {}],
      [`${RESULT({ result: 'the line before' }).trim()}\n{"type":"result","result":"own","x":[${zeros(99997)}]}`, { summary: 'the line before' }],
      [`{"type":"result","result":${JSON.stringify(marks)}}`, { summary: marks.slice(0, 4000) }],
      [`{"type":"result","result":"\\\\","pad":"${','.repeat(100000)}"}`, { summary: '\\' }],
      ['{"type":"result","result":"own","total_cost_usd":1e400,"usage":{"input_tokens":1e400,"output_tokens":5}}', { tokens: 5 }],
      ['{"type":"result","result":"own","modelUsage":{"m":{"inputTokens":-1e400,"outputTokens":1}}}', { tokens: 1, model: 'm' }],
      [`${RESULT({ result: 'the line before' }).trim()}\n{"nested":{"type":"result"},"result":"not a result"}\nnull "type":"result"`, { summary: 'the line before' }],
      [`${RESULT({ result: 'the line before' }).trim()}\n{ "type" : "result", "result" : "not written as the agent writes" }`, { summary: 'the line before' }],
    ];
    for (const [log, expected] of RAW) {
      const runId = runDir({ done: '0\n', 'log.jsonl': `${log}\n` });
      assert.deepEqual(await ended(runId), { ok: true, summary: 'own', usd: 0, tokens: 0, model: '', runner: 'claude', exit: 0, state: 'finished', ...expected }, log.slice(0, 200));
    }
  });

  await check('a job\'s tokens and cost stand no higher than the model traffic the host measured for it could hold: a byte a token, USD 80 a million bytes, and nothing for a job that sent the model nothing', async () => {
    const claims = (tokens, usd) => RESULT({ total_cost_usd: usd, usage: { input_tokens: tokens } });
    const figures = async (log, spent, mod) => {
      const { tokens, usd, capped, ok } = await ended(runDir({ done: '0\n', 'log.jsonl': log }), spent === undefined ? {} : { spent }, mod);
      assert.equal(ok, true, 'a figure that was lowered fails no run');
      return [tokens, usd, capped === true];
    };
    const absurd = claims(9007199254740991, 1e9);
    const [tokens, usd, capped] = await figures(absurd, () => ({ requests: 3, bytes: 1000000 }));
    assert.deepEqual([tokens, capped], [1000000, true]);
    assert.ok(Math.abs(usd - 80) < 1e-6, `${usd}`);
    assert.deepEqual(await figures(claims(120, 0.42), () => ({ requests: 0, bytes: 0 })), [0, 0, true], 'no model traffic');
    assert.deepEqual(await figures(claims(120, 0.42), () => null), [0, 0, true], 'a job the broker holds nothing of');
    assert.deepEqual(await figures(claims(120, 0.42), () => ({ requests: 1, bytes: NaN })), [0, 0, true]);
    assert.deepEqual(await figures(claims(0, 0), () => null), [0, 0, false], 'nothing claimed, nothing lowered');
    // The one real agent run on record named 17416 tokens; the bytes are four to a token,
    // less than its request bodies alone held.
    assert.deepEqual(await figures(claims(17416, 0.31), () => ({ requests: 6, bytes: 69664 })), [17416, 0.31, false], 'an honest job');
    assert.deepEqual(await figures(claims(69664, 0.31), () => ({ requests: 6, bytes: 69664 })), [69664, 0.31, false], 'a figure at the bound is not lowered');
    assert.deepEqual(await figures(claims(17416, 6), () => ({ requests: 6, bytes: 69664 })).then(([t, , c]) => [t, c]), [17416, true], 'the cost alone');
    assert.deepEqual(await figures(claims(120, 0), () => ({ requests: 1, bytes: 10 })), [10, 0, true], 'the tokens alone');
    assert.deepEqual(await figures(absurd, undefined), [9007199254740991, 1e9, false], 'with no measure given the figures are the job\'s');
    assert.deepEqual(await figures(absurd, () => ({ requests: 1, bytes: 10 }), later).then(([t, , c]) => [t, c]), [10, true], 'a run taken up after a restart');

    const started = runDir();
    await start(started, { spent: () => ({ requests: 1, bytes: 10 }) });
    for (const [name, text] of [['log.jsonl', absurd], ['done', '0\n']]) fs.writeFileSync(path.join(dirOf(started), name), text);
    assert.deepEqual([(await watch({ runId: started })).tokens, readOutcome(started).capped], [10, true], 'a run started here');

    const stopped = runDir({ 'log.jsonl': absurd });
    assert.equal(attachJob({ runId: stopped, container, spent: () => ({ requests: 1, bytes: 10 }) }), true);
    says(stopped, 'gone');
    const outcome = await soon(stopJob({ runId: stopped }, {}), 'the stop');
    assert.deepEqual([outcome.state, outcome.summary, outcome.tokens, outcome.capped], ['stopped', 'stopped', 10, true]);
    const honest = runDir({ done: '0\n', 'log.jsonl': claims(10, 0) });
    assert.equal('capped' in await ended(honest, { spent: () => ({ requests: 1, bytes: 10 }) }), false, 'an outcome nothing was lowered in says nothing of it');
  });

  await check('a run whose end cannot be made out still ends: as a failure that says why, on record, and held no longer', async () => {
    const runId = runDir({ done: '0\n', 'log.jsonl': RESULT({}) });
    const outcome = await ended(runId, { spent: () => { throw new Error('the broker is gone'); } });
    assert.deepEqual(outcome, { ok: false, summary: 'how the run ended could not be read: the broker is gone', usd: 0, tokens: 0, model: '', runner: 'claude', exit: null, state: 'failed' });
  });

  await check('a run is started once, its directory replaces what stood there, and one that cannot be replaced fails the start with nothing left of it', async () => {
    const runId = runDir({ leftover: 'x' });
    says(runId, 'up');
    const [first, second] = await Promise.allSettled([start(runId), start(runId)]);
    assert.equal(first.status, 'fulfilled');
    assert.match(second.reason.message, /is already started/);
    assert.deepEqual(first.value, { dir: dirOf(runId), log: path.join(dirOf(runId), 'log.jsonl'), pid: 4242 });
    assert.deepEqual(fs.readdirSync(dirOf(runId)).sort(), ['ca.crt', 'env.sh', 'forward.mjs', 'prompt.txt', 'run.sh']);
    assert.equal(fs.readFileSync(path.join(stateDir, 'calls'), 'utf8').split('\n').filter((line) => line === `start ${runId}`).length, 1);
    says(runId, 'gone');
    assert.equal((await stopJob({ runId }, {})).state, 'stopped');

    if (root) return;
    const kept = runDir();
    stuck(kept);
    await assert.rejects(start(kept), /the run directory could not be put in place/);
    assert.deepEqual(fs.readdirSync(path.join(RUNS_DIR, '.staging')), []);
    await assert.rejects(watch({ runId: kept }), /is not running/);
    unstick(kept);
  });

  await check('what the host puts in a run directory is its own user\'s alone to read - the environment holds the job\'s proxy token - and a start leaves no outcome of an earlier run of the id', async () => {
    const runId = runDir({ done: '0\n' });
    await ended(runId);
    assert.equal(readOutcome(runId).exit, 0);
    says(runId, 'up');
    await start(runId);
    assert.equal(readOutcome(runId), null, 'the run that is on has no outcome');
    const mode = (name) => fs.statSync(path.join(dirOf(runId), name)).mode & 0o777;
    assert.equal(mode('.'), 0o700);
    for (const name of ['prompt.txt', 'ca.crt', 'run.sh', 'forward.mjs', 'env.sh']) assert.equal(mode(name), 0o600, name);
    assert.match(fs.readFileSync(path.join(dirOf(runId), 'env.sh'), 'utf8'), /^export DN_PROXY='http:\/\/dn:token@127\.0\.0\.1:1'$/m);
    says(runId, 'gone');
    await stopJob({ runId }, {});
  });

  await check('a job is started under the process group its start names and no other: 1 and below, what is no whole number and what a failed start said are none, and a start that says more than 64 KiB is cut off there; no run is taken up by a name or a group that is none, or with neither a group nor a directory that can be found', async () => {
    const starts = async (said) => {
      const runId = runDir();
      fs.writeFileSync(path.join(stateDir, `${runId}.start`), said);
      const outcome = await start(runId).then(({ pid }) => pid, (e) => e.message);
      if (typeof outcome === 'number') {
        says(runId, 'gone');
        await stopJob({ runId }, {});
      } else await assert.rejects(watch({ runId }), /is not running/, 'a run that did not start is not held');
      return outcome;
    };
    const NONE = 'the job could not be started in dn-job-files: its process group was not said';
    assert.equal(await starts('echo 77; exit 0'), 77);
    assert.equal(await starts('echo " 2 "; exit 0'), 2);
    for (const said of ['echo 1', 'echo 0', 'echo -7', 'echo 1.5', 'echo 9007199254740993', 'echo group', 'echo 77 78', 'true']) assert.equal(await starts(`${said}; exit 0`), NONE, said);
    assert.equal(await starts('echo 77; exit 1'), NONE, 'a start that failed');
    assert.equal(await starts('echo "exec failed" >&2; echo "no such file" >&2; exit 126'), 'the job could not be started in dn-job-files: no such file');
    const long = path.join(scratch, 'long');
    fs.writeFileSync(long, `${'x'.repeat(100 * 1024)}\n`);
    assert.equal(await starts(`cat ${long} >&2; exit 1`), `the job could not be started in dn-job-files: ${'x'.repeat(300)}... (65536 characters)`);
    fs.writeFileSync(long, '\n'.repeat(100 * 1024));
    assert.equal(await starts(`cat ${long}; echo 77; exit 0`), NONE, 'a group is not looked for past what is heard');

    for (const runId of ['../x', 'a/b', '', 'a'.repeat(65)]) assert.equal(attachJob({ runId, container, pid: 4242 }), false, runId);
    for (const pid of [1, 0, -3, 1.5, 'group', '']) {
      const runId = runDir();
      assert.equal(attachJob({ runId, container, pid }), false, `${pid}`);
      await assert.rejects(watch({ runId }), /is not running/);
    }
    assert.equal(attachJob({ runId: `${R}-never-made`, container }), false, 'no directory, no group');
    if (root) return;
    // As root in a container can leave the directory that holds its runs.
    const closed = runDir();
    fs.chmodSync(container.runsDir, 0o000);
    try {
      assert.equal(attachJob({ runId: closed, container }), false, 'a run that cannot be looked for, and has no group');
    } finally { fs.chmodSync(container.runsDir, 0o755); }
  });

  await check('the engine\'s word that the container is gone ends a run at the first look, an engine that says nothing is asked three times running, and a runner that ended as it was asked after has ended', async () => {
    const asked = (runId) => fs.readFileSync(path.join(stateDir, 'calls'), 'utf8').split('\n').filter((line) => line === `up ${runId}`).length;
    const answers = (script, files = {}) => {
      const runId = runDir(files);
      fs.writeFileSync(path.join(stateDir, `${runId}.sh`), script);
      return runId;
    };
    for (const said of ['Error response from daemon: No such container: dn-job-files', 'Error response from daemon: container 0123abcd is not running', 'Error: no container with name or ID "dn-job-files" found: no such container']) {
      const runId = answers(`echo '${said}' >&2; exit 1`);
      assert.match((await ended(runId)).summary, VANISHED, said);
      assert.equal(asked(runId), 1, said);
    }
    const silent = answers('exit 1');
    assert.match((await ended(silent)).summary, VANISHED);
    assert.equal(asked(silent), 3);
    const spoke = answers('echo up; exit 1');
    assert.match((await ended(spoke)).summary, VANISHED);
    assert.equal(asked(spoke), 3, 'what a failed asking said is no answer');

    // Silent twice, up, silent twice, and at the sixth asking up again, with the run ended.
    const count = path.join(scratch, 'count');
    const patient = answers(`n=$(($(cat ${count} 2>/dev/null || echo 0) + 1)); echo "$n" > ${count}
      case "$n" in 3) echo up; exit 0 ;; 6) echo 0 > ${path.join(container.runsDir, '$run', 'done')}; echo up; exit 0 ;; esac; exit 1`, { 'log.jsonl': RESULT({}) });
    assert.deepEqual([(await ended(patient)).state, asked(patient)], ['finished', 6], 'an answer between two silences starts the count again');

    const justEnded = answers(`echo 3 > ${path.join(container.runsDir, '$run', 'done')}; echo gone; exit 0`, { 'log.jsonl': RESULT({}) });
    const outcome = await ended(justEnded);
    assert.deepEqual([outcome.exit, outcome.summary, asked(justEnded)], [3, 'own', 1]);
  });

  await check('a stop asks an engine that does not answer nothing but whether it answers, once every 10 polls for all the jobs being stopped, and goes through once it does', async () => {
    const calls = () => fs.readFileSync(path.join(stateDir, 'calls'), 'utf8').split('\n').filter(Boolean);
    const runs = [runDir(), runDir(), runDir(), runDir()];
    for (const runId of runs) assert.equal(attachJob({ runId, container, pid: 4242 }), true);
    fs.writeFileSync(path.join(stateDir, 'down'), '');
    const from = calls().length;
    const began = Date.now();
    const stops = runs.map((runId) => stopJob({ runId }, { restart: () => assert.fail('nothing is restarted') }));
    await sleep(1000);
    const meanwhile = calls().slice(from);
    const looks = (Date.now() - began) / (10 * 20);
    assert.ok(meanwhile.every((line) => line === 'down version'), meanwhile.join(', '));
    assert.ok(meanwhile.length >= 2 && meanwhile.length <= looks + 1, `${meanwhile.length} docker calls in ${Date.now() - began} ms`);
    for (const runId of runs) says(runId, 'gone');
    fs.unlinkSync(path.join(stateDir, 'down'));
    for (const outcome of await soon(Promise.all(stops), 'the stops, once the engine answers')) assert.equal(outcome.state, 'stopped');
  });

  await check('a run is forgotten when nothing is left of it: its directory first, and one that will not go keeps its link and its outcome, is not said to be gone, and is met again', async () => {
    const [plain, fresh, held, outcomeOnly] = [runDir({ done: '0\n' }), runDir({ done: '0\n' }), runDir(), `${R}-outcome-only`];
    for (const runId of [plain, fresh]) await ended(runId);
    fs.writeFileSync(path.join(RUNS_DIR, `${outcomeOnly}.outcome.json`), '{}');
    assert.equal(attachJob({ runId: held, container, pid: 4242 }), true);
    for (const runId of [plain, held, outcomeOnly]) old(runId);
    assert.deepEqual((await forgetRuns({ olderThanMs: HOUR })).sort(), [outcomeOnly, plain].sort());
    assert.deepEqual([left(plain), left(fresh), left(held), left(outcomeOnly)], [[false, false, false], [true, true, true], [true, true, false], [false, false, false]]);
    says(held, 'gone');
    await stopJob({ runId: held }, {});

    if (root) return;
    const runs = [runDir({ done: '0\n' }), runDir({ done: '0\n' }), runDir({ done: '0\n' }), runDir({ done: '0\n' })];
    for (const runId of runs) { await ended(runId); stuck(runId); old(runId); }
    const [stays, refused, breaks, goes] = runs;
    assert.deepEqual(await forgetRuns({ olderThanMs: HOUR }), [], 'with nothing to remove them by');
    for (const runId of runs) assert.deepEqual(left(runId), [true, true, true]);
    const asked = [];
    const containers = {
      async erase(name, runId) {
        asked.push([name, runId]);
        if (runId === breaks) throw new Error('the engine is down');
        if (runId !== goes) return false;
        unstick(runId);
        fs.rmSync(dirOf(runId), { recursive: true });
        return true;
      },
    };
    assert.deepEqual(await forgetRuns({ olderThanMs: HOUR, containers }), [goes], 'only what is gone');
    assert.deepEqual(asked.sort(), runs.map((runId) => [container.name, runId]).sort());
    assert.deepEqual([left(stays), left(refused), left(breaks), left(goes)], [[true, true, true], [true, true, true], [true, true, true], [false, false, false]]);
    asked.length = 0;
    assert.deepEqual(await forgetRuns({ olderThanMs: HOUR, containers }), []);
    assert.deepEqual(asked.map(([, runId]) => runId).sort(), [stays, refused, breaks].sort(), 'what was left is met again');
    for (const runId of [stays, refused, breaks]) { unstick(runId); }
    assert.deepEqual((await forgetRuns({ olderThanMs: HOUR })).sort(), [stays, refused, breaks].sort());
  });

  await check('forgetting removes a run\'s directory where the host put one and nothing else: not what a link in RUNS_DIR names elsewhere, not what a link in its place leads to', async () => {
    const elsewhere = path.join(scratch, 'elsewhere');
    const [outside, sibling, swapped] = [`${R}-outside`, `${R}-sibling`, runDir({ done: '0\n' })];
    const other = runDir({ keep: 'x' });
    fs.mkdirSync(path.join(elsewhere, outside), { recursive: true });
    fs.writeFileSync(path.join(elsewhere, outside, 'keep'), 'x');
    fs.symlinkSync(path.join(elsewhere, outside), path.join(RUNS_DIR, outside));
    fs.symlinkSync(path.relative(RUNS_DIR, dirOf(other)), path.join(RUNS_DIR, sibling));
    // The job moved its directory aside and left a link to this machine's files there.
    const victim = path.join(scratch, 'victim');
    fs.mkdirSync(victim);
    fs.writeFileSync(path.join(victim, 'keep'), 'x');
    fs.renameSync(dirOf(swapped), `${dirOf(swapped)}.aside`);
    fs.symlinkSync(victim, dirOf(swapped));
    for (const runId of [outside, sibling, swapped]) old(runId);
    assert.deepEqual((await forgetRuns({ olderThanMs: HOUR })).sort(), [outside, sibling, swapped].sort());
    for (const dir of [path.join(elsewhere, outside), dirOf(other), victim]) assert.deepEqual(fs.readdirSync(dir), ['keep'], dir);
    for (const runId of [outside, sibling, swapped]) assert.deepEqual(left(runId).slice(1), [false, false], runId);
    assert.equal(fs.lstatSync(dirOf(swapped), { throwIfNoEntry: false }), undefined, 'the link itself went');
    says(other, 'gone');
  });

  if (!root) {
    await check('a run started while an older one of its id is being forgotten waits until that is done, and is not forgotten with it', async () => {
      const runId = runDir({ done: '0\n' });
      await ended(runId);
      stuck(runId);
      old(runId);
      const asked = Promise.withResolvers();
      const go = Promise.withResolvers();
      const forgetting = forgetRuns({
        olderThanMs: HOUR,
        containers: {
          async erase() {
            asked.resolve();
            await go.promise;
            unstick(runId);
            fs.rmSync(dirOf(runId), { recursive: true });
            return true;
          },
        },
      });
      await asked.promise;
      const starting = start(runId);
      go.resolve();
      assert.deepEqual(await forgetting, [runId]);
      assert.equal((await starting).pid, 4242);
      assert.deepEqual(left(runId), [true, true, false]);
      assert.ok(fs.existsSync(path.join(dirOf(runId), 'prompt.txt')));
      assert.equal((await forgetRuns({ olderThanMs: 0 })).includes(runId), false, 'a run held here is not forgotten');
      assert.deepEqual(left(runId), [true, true, false]);
      says(runId, 'gone');
      await stopJob({ runId }, {});
    });
  }

  // stop.sh run as a container's sh runs it, on this host's /proc.
  if (!fs.existsSync('/proc/self/environ')) console.log('INFO stop.sh is not run here: no /proc on this machine');
  else {
    await check('stop.sh finds a job\'s processes by its run id whole: a run whose id begins another\'s is not the other', async () => {
      const STOP_SH = fileURLToPath(new URL('../src/executor/stop.sh', import.meta.url));
      const id = `${R}-stop-1`;
      const runs = [id, `${id}0`].map((runId) => spawn('sleep', ['60'], { env: { ...process.env, DN_RUN_ID: runId }, stdio: 'ignore' }));
      try {
        const stop = (verb, runId) => spawnSync('sh', [STOP_SH, verb, runId, '0', '0'], { env: { ...process.env, DN_ROOT: scratch }, encoding: 'utf8', timeout: 30000 }).stdout.trim();
        await until('both to run', () => runs.every((p) => fs.existsSync(`/proc/${p.pid}/environ`)));
        assert.equal(stop('left', id), 'up');
        stop('stop', id);
        await until('the run to be stopped', () => runs[0].exitCode !== null || runs[0].signalCode !== null);
        assert.equal(stop('left', id), 'gone');
        assert.deepEqual([runs[1].exitCode, runs[1].signalCode, stop('left', `${id}0`)], [null, null, 'up'], 'the run whose id begins with it runs on');
      } finally {
        for (const p of runs) p.kill('SIGKILL');
      }
    });
  }

  console.log(`\nall ${checks} checks passed`);
} finally {
  clearInterval(beating);
  for (const dir of fs.readdirSync(container.runsDir, { withFileTypes: true })) {
    if (dir.isDirectory()) unstick(dir.name);
  }
}
