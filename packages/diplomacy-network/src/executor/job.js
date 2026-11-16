// One run: its directory, its prompt, the agent started headless inside the container,
// and the outcome read back when it ends.
//
// A run's directory is <container's runs dir>/<run id> on the host and
// /dn/runs/<run id> in the container (RUNS_DIR/<run id> is a link to it):
//   prompt.txt  the container preamble, then the requester's prompt
//   env.sh      the job's environment, its proxy token included (0600)
//   ca.crt      the broker's certificate authority
//   run.sh      runner.sh; forward.mjs
//   forwards.sh where forward.mjs listens for the job's forwards, when it has any
//   pid         the runner's process group, as the runner wrote it
//   setup.log   everything before the agent started
//   log.jsonl   the agent's event stream; stderr.log
//   done        the agent's exit code, written last
// The container can write all of it. So the host fills it in before the container can
// see it, writes nothing into it afterwards, runs nothing from it once the job is up,
// and reads back only what is a plain file in the place the host itself put the
// directory. The outcome it makes of that is kept beside the run directories, in
// RUNS_DIR/<run id>.outcome.json, where no container can write.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicWrite, readJson } from '../../../daemon-core/src/fsio.js';
import { JOB_LIVENESS_MS, JOB_POLL_MS, JOB_STOP_BOUND_MS, JOB_STOP_GRACE_MS, RUNS_DIR } from '../paths.js';
import { docker, IMAGE_DIR } from './container.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// What asks after a job's processes and ends them, as text for the container's sh.
const STOP = fs.readFileSync(path.join(HERE, 'stop.sh'), 'utf8');
// The runner in a session of its own, which says its process group from inside it, so
// the group is there by the time it is named, and then becomes the runner. The host has
// the group from its own command, before the job has run anything.
const START = 'echo "$(setsid sh -c \'echo "$$"; exec sh "$0" < /dev/null > /dev/null 2>&1\' "$1" &)"';
/// What a job that ended with its container says of it.
export const CUT = 'the container was restarted to stop another job';
// What a job that is given `adb` is told of it: executor/adb.js stands between.
const ADB_SAID = ' `adb devices` lists what is attached to the host, and a device is named by its serial (`adb -s <serial>` or `ANDROID_SERIAL`). `adb connect`, `forward`, `reverse`, `pair` and `kill-server` are refused by the host: do not retry them.';
const SUMMARY_CAP = 4000;
const TAIL_BYTES = 4 * 2 ** 20;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const quote = (v) => `'${String(v).replace(/'/g, "'\\''")}'`;

const live = new Map(); // run id -> job

const outcomePath = (runId) => path.join(RUNS_DIR, `${runId}.outcome.json`);

/// The outcome of a run that ended, as `watch` resolved it, or null: what a daemon that
/// was not there when the run ended still has to report.
export function readOutcome(runId) {
  return /^[A-Za-z0-9_-]{1,64}$/.test(runId) ? readJson(outcomePath(runId)) : null;
}

/// The runs that were given a directory, have no outcome on record and are not known
/// here: `[{ runId, container: { name, runsDir } }]`, each as `attachJob` takes it. A job
/// that still runs with nobody watching it is among them.
export function unended() {
  let names = new Set();
  try { names = new Set(fs.readdirSync(RUNS_DIR)); } catch {}
  const out = [];
  for (const runId of names) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(runId) || live.has(runId) || names.has(`${runId}.outcome.json`)) continue;
    let runsDir;
    // RUNS_DIR/<run id> is the link `startJob` made to <container's runs dir>/<run id>.
    try { runsDir = path.dirname(path.resolve(RUNS_DIR, fs.readlinkSync(path.join(RUNS_DIR, runId)))); } catch { continue; }
    out.push({ runId, container: { name: path.basename(runsDir), runsDir } });
  }
  return out;
}

/// Removes what is left of every run that ended, or was last heard of, more than
/// `olderThanMs` ago: its directory, the link to it and its outcome. A run that is
/// watched here stays. Resolves to the run ids removed.
export function forgetRuns({ olderThanMs }) {
  let names = [];
  try { names = fs.readdirSync(RUNS_DIR); } catch {}
  const gone = [];
  for (const runId of new Set(names.map((name) => name.replace(/\.outcome\.json$/, '')))) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(runId) || live.has(runId)) continue;
    const link = path.join(RUNS_DIR, runId);
    let last = 0;
    for (const file of [outcomePath(runId), link]) {
      try { last = Math.max(last, fs.lstatSync(file).mtimeMs); } catch {}
    }
    if (Date.now() - last < olderThanMs) continue;
    // The link first: a run with a directory and no outcome reads as one that never ended.
    try {
      const dir = path.resolve(RUNS_DIR, fs.readlinkSync(link));
      fs.rmSync(link, { force: true });
      // Only where `startJob` puts a run: <RUNS_DIR>/.containers/<container>/<run id>.
      if (path.dirname(path.dirname(dir)) === path.join(RUNS_DIR, '.containers') && path.basename(dir) === runId) fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
    fs.rmSync(outcomePath(runId), { force: true });
    gone.push(runId);
  }
  return gone;
}

/// The job's prompt: image/preamble.md filled in for this pool and task, a rule, and the
/// requester's prompt.
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

// A file the container wrote, read only if it is a plain file inside the run's own
// directory: a link planted there, or in place of the directory, must not make the host
// read something else.
function readOwn(job, name, tail = TAIL_BYTES) {
  try {
    if (fs.realpathSync(job.dir) !== job.realDir) return null;
    const fd = fs.openSync(path.join(job.realDir, name), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const st = fs.fstatSync(fd);
      if (!st.isFile()) return null;
      const length = Math.min(st.size, tail);
      const buf = Buffer.alloc(length);
      fs.readSync(fd, buf, 0, length, st.size - length);
      return buf.toString('utf8');
    } finally { fs.closeSync(fd); }
  } catch { return null; }
}

function parseOutcome(job, exit) {
  const lines = (readOwn(job, 'log.jsonl') || '').split('\n');
  let result = null;
  for (let i = lines.length - 1; i >= 0 && !result; i--) {
    if (!lines[i].includes('"type":"result"')) continue;
    try {
      const event = JSON.parse(lines[i]);
      if (event.type === 'result') result = event;
    } catch {}
  }
  const outcome = { ok: false, summary: '', usd: 0, tokens: 0, model: '', runner: 'claude', exit };
  if (!result) {
    const said = (readOwn(job, 'stderr.log', 2000) || '').trim() || (readOwn(job, 'setup.log', 2000) || '').trim();
    outcome.summary = `the agent left no result${said ? `: ${said.slice(-1000)}` : ''}`;
    return outcome;
  }
  const models = Object.entries(result.modelUsage || {});
  const n = (v) => (Number.isFinite(v) ? v : 0);
  outcome.ok = exit === 0 && result.is_error !== true;
  outcome.summary = String(result.result ?? '').slice(0, SUMMARY_CAP);
  outcome.usd = n(result.total_cost_usd);
  outcome.tokens = models.length > 0
    ? models.reduce((sum, [, u]) => sum + n(u.inputTokens) + n(u.outputTokens) + n(u.cacheReadInputTokens) + n(u.cacheCreationInputTokens), 0)
    : ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'].reduce((sum, k) => sum + n(result.usage?.[k]), 0);
  outcome.model = models.sort((a, b) => n(b[1].costUSD) - n(a[1].costUSD))[0]?.[0] || '';
  return outcome;
}

/// Starts a job in `container` (`{ name, runsDir }` from container.js). `run` is
/// `{ runId, pool: { id, forge, host, owner, repo } }`, `spec` the requester's
/// `{ prompt, item, base, name, email }`, `proxy` the broker's `{ proxyUrl, caCertPath }`,
/// `env` whatever else the job's environment carries (the model placeholder), and
/// `forwards` the broker forwards opened for it (`{ name }` each). Resolves to
/// `{ dir, log, pid }` once the runner is alive, `pid` its process group.
export async function startJob({ run, container, spec, proxy, env = {}, forwards = [] }) {
  const { runId, pool } = run;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(runId)) throw new Error(`not a run id: ${runId}`);
  if (live.has(runId)) throw new Error(`run ${runId} is already started`);
  const dir = path.join(container.runsDir, runId);
  // Filled in beside the mounted directories and moved in whole: a write into a
  // directory the container already sees could be led through a link it planted there
  // to any file of this machine.
  const staging = path.join(RUNS_DIR, '.staging', runId);
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(staging, 'prompt.txt'), renderPrompt({ pool, spec, forwards }), { mode: 0o600 });
  // A copy keeps the mode of what it copies, and each of these is handed to an
  // interpreter by root in the container: the operator's own 0600 serves.
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
    // Each forge client is pointed at the pool's own host.
    ...(pool.forge === 'gitlab' ? { GITLAB_HOST: pool.host } : pool.host !== 'github.com' ? { GH_HOST: pool.host } : {}),
    ...env,
    ...(forwards.length > 0 ? { DN_FORWARDS: forwards.map((f) => f.name).join(' ') } : {}),
  };
  // In a file and not on docker's command line, where any user of this machine could
  // read the token off the process list.
  fs.writeFileSync(path.join(staging, 'env.sh'), Object.entries(vars).map(([k, v]) => `export ${k}=${quote(v)}\n`).join(''), { mode: 0o600 });
  fs.rmSync(dir, { recursive: true, force: true });
  try { fs.renameSync(staging, dir); } catch (e) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw new Error(`the run directory could not be put in place: ${e.message}`);
  }
  const link = path.join(RUNS_DIR, runId);
  fs.rmSync(link, { recursive: true, force: true });
  fs.rmSync(outcomePath(runId), { force: true });
  fs.symlinkSync(path.relative(RUNS_DIR, dir), link);

  // Where the host put the directory, whatever stands at that name later.
  const realDir = path.join(fs.realpathSync(container.runsDir), runId);
  const job = { runId, container: container.name, dir, realDir, inside: `/dn/runs/${runId}`, pid: 0, stopping: false, stopped: false, cutting: false, cut: false, watching: null };
  const started = await docker(['exec', container.name, 'sh', '-c', START, 'sh', `${job.inside}/run.sh`]);
  job.pid = started.code === 0 ? groupOf(started.stdout) : 0;
  if (!job.pid) throw new Error(`the job could not be started in ${container.name}: ${started.stderr.trim().split('\n').pop() || 'its process group was not said'}`);
  live.set(runId, job);
  return { dir, log: path.join(dir, 'log.jsonl'), pid: job.pid };
}

/// Takes up a run that a daemon before this one started in `container` (`{ name,
/// runsDir }`): `watch` and `stopJob` know it from here on. `pid` is the process group
/// `startJob` resolved to; without it the one the run's directory names is believed,
/// which the job could have rewritten. False when there is no process group to follow.
export function attachJob({ runId, container, pid = null }) {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(runId)) return false;
  if (live.has(runId)) return true;
  let realDir;
  try { realDir = path.join(fs.realpathSync(container.runsDir), runId); } catch { return false; }
  const job = {
    runId, container: container.name, dir: path.join(container.runsDir, runId), realDir, inside: `/dn/runs/${runId}`,
    pid: 0, stopping: false, stopped: false, cutting: false, cut: false, watching: null,
  };
  job.pid = groupOf(pid ?? readOwn(job, 'pid', 32));
  if (!job.pid) return false;
  live.set(runId, job);
  return true;
}

// A process group as a number, or 0: 1 and below name every process of the container,
// or the asking shell's own group.
function groupOf(value) {
  const n = Number(String(value ?? '').trim());
  return Number.isSafeInteger(n) && n > 1 ? n : 0;
}

// stop.sh in the job's container, by one of its verbs.
const ask = (job, verb, more, timeout) => docker(['exec', job.container, 'sh', '-c', STOP, 'sh', verb, job.runId, String(job.pid), ...more], { timeout });

// Whether the job still runs - its process group for `up`, anything of it for `left` -
// as the container says in so many words: true, false, or null when nothing was said,
// by an engine that did not answer or a container in which nothing could be run.
async function alive(job, verb = 'up') {
  const r = await ask(job, verb, [], 20000);
  const said = r.code === 0 ? r.stdout.trim() : '';
  if (said === 'up') return true;
  return said === 'gone' || /No such container|is not running/i.test(r.stderr) ? false : null;
}

// The job's container restarted, which ends every process in it: true once the engine
// has done it. The other jobs in it end with it, and are not judged while it is asked.
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

async function follow(job) {
  let checked = Date.now();
  let unknown = 0;
  let exit = null;
  let state = '';
  while (!state) {
    const done = readOwn(job, 'done', 32);
    if (job.stopped) state = 'stopped';
    // Between the signal and the end of its grace the job is neither done nor vanished.
    else if (job.stopping || job.cutting) await sleep(JOB_POLL_MS);
    else if (job.cut) state = 'cut';
    else if (done !== null && /^\d+\s*$/.test(done)) { exit = Number(done); state = 'ended'; }
    else if (Date.now() - checked >= JOB_LIVENESS_MS) {
      checked = Date.now();
      const up = await alive(job);
      // A stop or a restart that began while the container was asked is why it is gone.
      if (job.stopping || job.cutting || job.cut) continue;
      unknown = up === null ? unknown + 1 : 0;
      // A runner that is gone has either just written `done` (the next pass reads it)
      // or never will: its container was removed, or the engine restarted under it.
      if ((up === false && readOwn(job, 'done', 32) === null) || unknown >= 3) state = 'vanished';
    } else await sleep(JOB_POLL_MS);
  }
  // Whatever the agent left running goes with it, and so does its work tree.
  await ask(job, 'stop', ['0'], 30000);
  const outcome = parseOutcome(job, exit);
  if (state === 'stopped') Object.assign(outcome, { ok: false, summary: 'stopped' });
  if (state === 'cut') Object.assign(outcome, { ok: false, summary: CUT });
  if (state === 'vanished') Object.assign(outcome, { ok: false, summary: 'the job\'s process disappeared without finishing: its container was removed or the docker engine restarted' });
  outcome.state = state === 'ended' ? (outcome.ok ? 'finished' : 'failed') : state === 'stopped' ? 'stopped' : 'failed';
  // The copy on disk is for a later daemon; this one has the outcome either way.
  try { atomicWrite(outcomePath(job.runId), outcome, 0o600); } catch {}
  live.delete(job.runId);
  return outcome;
}

/// Resolves when the run ends, to `{ ok, summary, usd, tokens, model, runner, exit,
/// state }`: `state` is `finished`, `failed` or `stopped`; `exit` is null when the agent
/// never reported one. A run whose process is gone without a `done` file is a failure.
/// The same object is kept on disk for `readOutcome`.
export function watch(run) {
  const job = live.get(run.runId);
  if (!job) return Promise.reject(new Error(`run ${run.runId} is not running`));
  job.watching ??= follow(job);
  return job.watching;
}

/// Kills that run's processes, and only that run's, and marks it stopped; resolves to
/// its outcome once they are gone, however long the engine takes to say so. A job that
/// is not gone JOB_STOP_BOUND_MS after it was first asked ends with its container, which
/// is restarted by `containers.restart`, the container module's: every other job in it
/// then ends as failed, with `CUT` for its summary.
export async function stopJob(run, containers) {
  const job = live.get(run.runId);
  if (!job) return null;
  job.stopping = true;
  const grace = String(Math.ceil(JOB_STOP_GRACE_MS / 1000));
  // Stopped is what the container says is left of the job, not what was asked of it. One
  // that says nothing - no process left to give for the asking - or in which the job
  // outlives the kill has no other end than its own. An engine that does not answer
  // restarts nothing either, and is asked until it does.
  for (const from = Date.now(); ;) {
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
