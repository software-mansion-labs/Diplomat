// A run's directory is <container's runs dir>/<run id> on the host and
// /dn/runs/<run id> in the container (RUNS_DIR/<run id> is a link to it):
//   prompt.txt  the container preamble, then the requester's prompt
//   env.sh      the job's environment, its proxy token included (0600)
//   ca.crt      the broker's certificate authority
//   run.sh      runner.sh; forward.mjs
//   forwards.sh where forward.mjs listens for the job's forwards, when it has any
//   setup.log   everything before the agent started
//   log.jsonl   the agent's event stream; stderr.log
//   done        the agent's exit code, written last
// The container can write or replace all of it, so the host fills it in before the
// container sees it, writes nothing into it afterwards, runs nothing from it once the job
// is up, and reads it back only through result.js. The outcome is kept where no container
// can write: RUNS_DIR/<run id>.outcome.json.

import fs from 'node:fs';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicWrite, readJson } from '../../../daemon-core/src/fsio.js';
import { JOB_LIVENESS_MS, JOB_POLL_MS, JOB_STOP_BOUND_MS, JOB_STOP_GRACE_MS, RUNS_DIR } from '../paths.js';
import { docker, IMAGE_DIR } from './container.js';
import { figure, readOwn, readResult } from './result.js';
import { clip } from './sparing.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STOP = fs.readFileSync(path.join(HERE, 'stop.sh'), 'utf8');
// The runner in its own session echoes its process group from inside it, so the host has
// the group before the job runs anything, then execs the runner. DN_RUN_ID is set from the
// first moment: stop.sh finds a job's processes by it. sh and setsid by absolute path, not
// the container's PATH (root there can still replace them; README, Stopping a job).
// DN_ROOT is unset in a container (runner.sh).
const START = 's="${DN_ROOT:-}/bin/sh"; echo "$(DN_RUN_ID="$2" "${DN_ROOT:-}/usr/bin/setsid" "$s" -c \'echo "$$"; exec "$0" "$1" < /dev/null > /dev/null 2>&1\' "$s" "$1" &)"';
export const CUT = 'the container was restarted to stop another job';
export const VANISHED = 'the job\'s process disappeared without finishing: its container was removed or the docker engine restarted';
const ADB_SAID = ' `adb devices` lists what is attached to the host, and a device is named by its serial (`adb -s <serial>` or `ANDROID_SERIAL`). `adb connect`, `forward`, `reverse`, `pair` and `kill-server` are refused by the host: do not retry them.';
// The dearest token price: USD 80 a million, the top model's fast-mode output as priced
// in November 2026.
const USD_PER_BYTE = 80 / 1e6;
// A process group or a word of stop.sh's is a line; output past this is the job's doing.
const HEARD = 64 * 1024;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const quote = (v) => `'${String(v).replace(/'/g, "'\\''")}'`;

const live = new Map();

// One operation at a time per run id: a run started while an older one of its id is being
// forgotten waits for that, and is not forgotten in its turn.
const turns = new Map();
function inTurn(runId, fn) {
  const run = (turns.get(runId) ?? Promise.resolve()).then(fn);
  const last = run.catch(() => {}).then(() => { if (turns.get(runId) === last) turns.delete(runId); });
  turns.set(runId, last);
  return run;
}

// rm(1) descends by descriptor, so a link planted in the container-written tree while it
// is walked is unlinked, never followed; and this thread does not wait on a large tree.
async function removed(dir) {
  await new Promise((resolve) => { execFile('/bin/rm', ['-rf', '--', dir], () => resolve()); });
  return fs.promises.lstat(dir).then(() => false, () => true);
}

const outcomePath = (runId) => path.join(RUNS_DIR, `${runId}.outcome.json`);

/// For a daemon that was not there when the run ended.
export function readOutcome(runId) {
  return /^[A-Za-z0-9_-]{1,64}$/.test(runId) ? readJson(outcomePath(runId)) : null;
}

/// Runs with a directory, no outcome on record and not known here (perhaps still running
/// unwatched), each as `attachJob` takes it.
export function unended() {
  let names = new Set();
  try { names = new Set(fs.readdirSync(RUNS_DIR)); } catch {}
  const out = [];
  for (const runId of names) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(runId) || live.has(runId) || names.has(`${runId}.outcome.json`)) continue;
    let runsDir;
    try { runsDir = path.dirname(path.resolve(RUNS_DIR, fs.readlinkSync(path.join(RUNS_DIR, runId)))); } catch { continue; }
    out.push({ runId, container: { name: path.basename(runsDir), runsDir } });
  }
  return out;
}

/// A directory this user cannot remove (root made it, on an engine that runs containers as
/// root) goes to `containers.erase`; one that still stands keeps its link and outcome for
/// the next call. Never rejects.
export async function forgetRuns({ olderThanMs, containers = null }) {
  const names = await fs.promises.readdir(RUNS_DIR).catch(() => []);
  const gone = [];
  for (const runId of new Set(names.map((name) => name.replace(/\.outcome\.json$/, '')))) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(runId)) continue;
    const forgotten = await inTurn(runId, async () => {
      if (live.has(runId)) return false;
      const link = path.join(RUNS_DIR, runId);
      const ages = await Promise.all([outcomePath(runId), link].map((file) => fs.promises.lstat(file).then((st) => st.mtimeMs, () => 0)));
      if (Date.now() - Math.max(...ages) < olderThanMs) return false;
      const dir = await fs.promises.readlink(link).then((to) => path.resolve(RUNS_DIR, to), () => null);
      // Only where `startJob` puts a run: <RUNS_DIR>/.containers/<container>/<run id>.
      if (dir && path.dirname(path.dirname(dir)) === path.join(RUNS_DIR, '.containers') && path.basename(dir) === runId) {
        if (!(await removed(dir) || await containers?.erase(path.basename(path.dirname(dir)), runId))) return false;
      }
      await fs.promises.rm(link, { force: true });
      await fs.promises.rm(outcomePath(runId), { force: true });
      return true;
    }).catch(() => false);
    if (forgotten) gone.push(runId);
  }
  return gone;
}

export function renderPrompt({ pool, spec, forwards = [] }) {
  const gitlab = pool.forge === 'gitlab';
  const values = {
    repo_url: repoUrl(pool),
    item: spec.item || 'the repository as a whole',
    forge_cli: gitlab ? 'glab' : 'gh',
    forge_host: pool.host,
    head_example: gitlab ? 'git fetch origin merge-requests/<n>/head' : 'git fetch origin pull/<n>/head',
    git_name: spec.name,
    git_email: spec.email,
    devices: forwards.length === 0
      ? 'No simulator, emulator or device is offered to this task, and none can run inside this container.'
      : `Nothing of the kind runs inside this container; these are forwarded from the host and already in your environment: ${forwards.map((f) => f.name).join(', ')}.${forwards.some((f) => f.name === 'adb') ? ADB_SAID : ''}`,
  };
  const preamble = fs.readFileSync(path.join(IMAGE_DIR, 'preamble.md'), 'utf8')
    .replace(/\{\{(\w+)\}\}/g, (whole, key) => (key in values ? values[key] : whole));
  return `${preamble.trimEnd()}\n\n---\n\n${spec.prompt}\n`;
}

const repoUrl = (pool) => `https://${pool.host}/${pool.owner}/${pool.repo}.git`;

async function parseOutcome(job, exit) {
  const result = await readResult(job.dir);
  const outcome = { ok: false, summary: '', usd: 0, tokens: 0, model: '', runner: 'claude', exit };
  if (!result) {
    const said = (await readOwn(job.dir, 'stderr.log', 2000) || '').trim() || (await readOwn(job.dir, 'setup.log', 2000) || '').trim();
    outcome.summary = `the agent left no result${said ? `: ${said.slice(-1000)}` : ''}`;
    return outcome;
  }
  const { failed, ...named } = result;
  return { ...outcome, ...named, ok: exit === 0 && !failed };
}

// A job's token and cost figures are its own word, and this machine's budget counts from
// them. Every token crossed the broker as at least a byte of the provider traffic the host
// measured, so both are capped by it; a lowered outcome says `capped`.
function capOutcome(outcome, taken) {
  const bytes = figure(taken?.bytes);
  const [tokens, usd] = [Math.min(outcome.tokens, bytes), Math.min(outcome.usd, bytes * USD_PER_BYTE)];
  return tokens < outcome.tokens || usd < outcome.usd ? { ...outcome, tokens, usd, capped: true } : outcome;
}

/// `spent()` is the host's `{ bytes }` of this run's provider traffic (null: none), which
/// caps the outcome; without it the job's own figures stand. Resolves once the runner is
/// alive, `pid` its process group.
export async function startJob(asked) {
  const { runId } = asked.run;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(runId)) throw new Error(`not a run id: ${runId}`);
  return inTurn(runId, () => begin(asked));
}

async function begin({ run, container, spec, proxy, env = {}, forwards = [], spent = null }) {
  const { runId, pool } = run;
  if (live.has(runId)) throw new Error(`run ${runId} is already started`);
  const dir = path.join(container.runsDir, runId);
  // Staged outside the mounts and moved in whole: a write into a directory the container
  // already sees could follow a link it planted to any file on this machine.
  const staging = path.join(RUNS_DIR, '.staging', runId);
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(staging, 'prompt.txt'), renderPrompt({ pool, spec, forwards }), { mode: 0o600 });
  // A copy keeps its source's mode; root in the container reads these, so 0600 serves.
  for (const [from, name] of [[proxy.caCertPath, 'ca.crt'], [path.join(HERE, 'runner.sh'), 'run.sh'], [path.join(HERE, 'forward.mjs'), 'forward.mjs']]) {
    fs.copyFileSync(from, path.join(staging, name));
    fs.chmodSync(path.join(staging, name), 0o600);
  }
  const vars = {
    DN_RUN_ID: runId,
    DN_PROXY: proxy.proxyUrl,
    DN_REPO_URL: repoUrl(pool),
    DN_BASE: spec.base || '',
    DN_GIT_NAME: spec.name,
    DN_GIT_EMAIL: spec.email,
    ...(pool.forge === 'gitlab' ? { GITLAB_HOST: pool.host } : pool.host !== 'github.com' ? { GH_HOST: pool.host } : {}),
    ...env,
    ...(forwards.length > 0 ? { DN_FORWARDS: forwards.map((f) => f.name).join(' ') } : {}),
  };
  // Not on docker's command line, where any user of this machine could read the token off
  // the process list.
  fs.writeFileSync(path.join(staging, 'env.sh'), Object.entries(vars).map(([k, v]) => `export ${k}=${quote(v)}\n`).join(''), { mode: 0o600 });
  await removed(dir);
  try { fs.renameSync(staging, dir); } catch (e) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw new Error(`the run directory could not be put in place: ${e.message}`);
  }
  const link = path.join(RUNS_DIR, runId);
  fs.rmSync(link, { recursive: true, force: true });
  fs.rmSync(outcomePath(runId), { force: true });
  fs.symlinkSync(path.relative(RUNS_DIR, dir), link);

  const started = await docker(['exec', container.name, '/bin/sh', '-c', START, 'sh', `/dn/runs/${runId}/run.sh`, runId], { maxBuffer: HEARD });
  const pid = started.code === 0 ? groupOf(started.stdout) : 0;
  if (!pid) throw new Error(`the job could not be started in ${container.name}: ${clip(started.stderr.trim().split('\n').pop()) || 'its process group was not said'}`);
  live.set(runId, { runId, container: container.name, dir, spent, pid, stopping: false, stopped: false, cutting: false, cut: false, watching: null });
  return { dir, log: path.join(dir, 'log.jsonl'), pid };
}

/// Takes up a run an earlier daemon started. A job whose group nobody kept is still found
/// by the run id its processes carry, which is enough to stop it. False for a bad run id
/// or group, or a run with neither a group nor a directory.
export function attachJob({ runId, container, pid = null, spent = null }) {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(runId) || (pid !== null && !groupOf(pid))) return false;
  if (live.has(runId)) return true;
  const dir = path.join(container.runsDir, runId);
  // Root in a container can close its runs directory to this user.
  try {
    if (pid === null && !fs.lstatSync(dir).isDirectory()) return false;
  } catch { return false; }
  live.set(runId, {
    runId, container: container.name, dir, spent,
    pid: pid === null ? 0 : groupOf(pid), stopping: false, stopped: false, cutting: false, cut: false, watching: null,
  });
  return true;
}

// 0 for 1 and below: those name every process of the container, or the asking shell's
// own group.
function groupOf(value) {
  const n = Number(String(value ?? '').trim());
  return Number.isSafeInteger(n) && n > 1 ? n : 0;
}

// One look shared by every job being stopped; a "no" comes DOWN_MS after the look.
const DOWN_MS = 10 * JOB_POLL_MS;
let looking = null;
function engineAnswers() {
  looking ??= docker(['version', '--format', '{{.Server.Version}}'], { timeout: 20000 })
    .then(async (r) => r.code === 0 || (await sleep(DOWN_MS), false))
    .finally(() => { looking = null; });
  return looking;
}

const ask = (job, verb, more, timeout) => docker(['exec', job.container, '/bin/sh', '-c', STOP, 'sh', verb, job.runId, String(job.pid), ...more], { timeout, maxBuffer: HEARD });

// null when nothing was said: no engine answer, nothing could run, or output past HEARD.
async function alive(job, verb = 'up') {
  const r = await ask(job, verb, [], 20000);
  const said = r.code === 0 ? r.stdout.trim() : '';
  if (said === 'up') return true;
  return said === 'gone' || /No such container|is not running/i.test(r.stderr) ? false : null;
}

// Restarts the job's container: the other jobs in it end too, and are not judged while
// the restart is under way.
async function cut(job, restart) {
  const others = [...live.values()].filter((other) => other !== job && other.container === job.container);
  for (const other of others) other.cutting = true;
  const done = await restart(job.container);
  for (const other of others) {
    other.cutting = false;
    other.cut ||= done;
  }
  return done;
}

async function exited(job) {
  const done = await readOwn(job.dir, 'done', 32) ?? '';
  return /^\d+\s*$/.test(done) ? Number(done) : null;
}

async function ending(job) {
  let checked = Date.now();
  let unknown = 0;
  let exit = null;
  let state = '';
  while (!state) {
    const code = await exited(job);
    if (job.stopped) state = 'stopped';
    // Between the signal and the end of its grace the job is neither done nor vanished.
    else if (job.stopping || job.cutting) await sleep(JOB_POLL_MS);
    else if (job.cut) state = 'cut';
    else if (code !== null) { exit = code; state = 'ended'; }
    else if (Date.now() - checked >= JOB_LIVENESS_MS) {
      checked = Date.now();
      const up = await alive(job);
      // A stop or a restart that began while the container was asked is why it is gone.
      if (job.stopping || job.cutting || job.cut) continue;
      // Silence from an engine that does not answer `docker version` either says nothing
      // of the job.
      if (up === null && !(await engineAnswers())) continue;
      unknown = up === null ? unknown + 1 : 0;
      // A runner that is gone has either just written `done` (the next pass reads it)
      // or never will: its container was removed, or the engine restarted under it.
      if ((up === false && await exited(job) === null) || unknown >= 3) state = 'vanished';
    } else await sleep(JOB_POLL_MS);
  }
  // Whatever the agent left running goes, and its work tree.
  await ask(job, 'stop', ['0'], 30000);
  const read = await parseOutcome(job, exit);
  const outcome = job.spent ? capOutcome(read, job.spent()) : read;
  if (state === 'stopped') Object.assign(outcome, { ok: false, summary: 'stopped' });
  if (state === 'cut') Object.assign(outcome, { ok: false, summary: CUT });
  if (state === 'vanished') Object.assign(outcome, { ok: false, summary: VANISHED });
  outcome.state = state === 'ended' ? (outcome.ok ? 'finished' : 'failed') : state === 'stopped' ? 'stopped' : 'failed';
  return outcome;
}

async function follow(job) {
  const outcome = await ending(job).catch((e) => ({
    ok: false, summary: `how the run ended could not be read: ${e?.message ?? e}`, usd: 0, tokens: 0, model: '', runner: 'claude', exit: null, state: 'failed',
  }));
  // The copy on disk is for a later daemon; this one has the outcome either way.
  try { atomicWrite(outcomePath(job.runId), outcome, 0o600); } catch {}
  live.delete(job.runId);
  return outcome;
}

/// Resolves when the run ends; `exit` is null when the agent reported none.
export function watch(run) {
  const job = live.get(run.runId);
  if (!job) return Promise.reject(new Error(`run ${run.runId} is not running`));
  job.watching ??= follow(job);
  return job.watching;
}

/// The outcome of a job whose `done` holds an exit code, asking nothing of the engine.
export async function readFinished({ runId, container, spent = null }) {
  const job = { dir: path.join(container.runsDir, runId) };
  const exit = await exited(job);
  if (exit === null) return null;
  const read = await parseOutcome(job, exit);
  const outcome = spent ? capOutcome(read, spent()) : read;
  return { ...outcome, state: outcome.ok ? 'finished' : 'failed' };
}

/// Kills that run's processes and only those, resolving to its outcome once they are gone
/// however long the engine takes. A job not gone JOB_STOP_BOUND_MS after the engine first
/// answered ends with its container (`containers.restart`), and every other job in it
/// fails with `CUT`.
export async function stopJob(run, containers) {
  const job = live.get(run.runId);
  if (!job) return null;
  job.stopping = true;
  const grace = String(Math.ceil(JOB_STOP_GRACE_MS / 1000));
  // Stopped means the container says nothing of the job is left. One that says nothing,
  // or where the job outlives the kill, ends only by the restart; an engine that does not
  // answer restarts nothing either, and is looked at until it does.
  for (let from = null; ;) {
    if (!(await engineAnswers())) continue;
    from ??= Date.now();
    await ask(job, 'stop', [grace], JOB_STOP_GRACE_MS + 30000);
    if ((await alive(job, 'left')) === false) break;
    if (Date.now() - from >= JOB_STOP_BOUND_MS && await cut(job, containers.restart)) break;
    await sleep(JOB_POLL_MS);
  }
  job.stopped = true;
  // The run may have ended by itself while the engine was asked.
  job.watching ??= follow(job);
  return job.watching;
}
