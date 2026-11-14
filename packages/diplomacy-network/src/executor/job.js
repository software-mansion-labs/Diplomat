// One run: its directory, its prompt, the agent started headless inside the container,
// and the outcome read back when it ends.
//
// A run's directory is <container's runs dir>/<run id> on the host and
// /dn/runs/<run id> in the container (RUNS_DIR/<run id> is a link to it):
//   prompt.txt  the container preamble, then the requester's prompt
//   env.sh      the job's environment, its proxy token included (0600)
//   ca.crt      the broker's certificate authority
//   run.sh      runner.sh; stop.sh; forward.mjs
//   forwards.sh where forward.mjs listens for the job's forwards, when it has any
//   pid         the runner's process group
//   setup.log   everything before the agent started
//   log.jsonl   the agent's event stream; stderr.log
//   done        the agent's exit code, written last
// The container can write all of it. So the host fills it in before the container can
// see it, writes nothing into it afterwards, and reads back only what is a plain file
// in the place the host itself put the directory. The outcome it makes of that is kept
// beside the run directories, in RUNS_DIR/<run id>.outcome.json, where no container
// can write.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicWrite, readJson } from '../../../daemon-core/src/fsio.js';
import { JOB_LIVENESS_MS, JOB_POLL_MS, JOB_START_MS, JOB_STOP_GRACE_MS, RUNS_DIR } from '../paths.js';
import { docker, IMAGE_DIR } from './container.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
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
      : `Nothing of the kind runs inside this container; these are forwarded from the host and already in your environment: ${forwards.map((f) => f.name).join(', ')}.`,
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
/// `{ dir, log }` once the runner is alive.
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
  fs.mkdirSync(staging, { recursive: true });
  fs.writeFileSync(path.join(staging, 'prompt.txt'), renderPrompt({ pool, spec, forwards }));
  fs.copyFileSync(proxy.caCertPath, path.join(staging, 'ca.crt'));
  fs.copyFileSync(path.join(HERE, 'runner.sh'), path.join(staging, 'run.sh'));
  fs.copyFileSync(path.join(HERE, 'stop.sh'), path.join(staging, 'stop.sh'));
  fs.copyFileSync(path.join(HERE, 'forward.mjs'), path.join(staging, 'forward.mjs'));
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
  const job = { runId, container: container.name, dir, realDir, inside: `/dn/runs/${runId}`, pid: 0, stopping: false, stopped: false, watching: null };
  const started = await docker(['exec', '-d', container.name, 'setsid', 'sh', `${job.inside}/run.sh`]);
  if (started.code !== 0) throw new Error(`the job could not be started in ${container.name}: ${started.stderr.trim().split('\n').pop()}`);
  for (let waited = 0; !job.pid; waited += 100) {
    job.pid = Number((readOwn(job, 'pid', 32) || '').trim()) || 0;
    if (!job.pid && waited >= JOB_START_MS) throw new Error(`the job did not come up in ${container.name} within ${JOB_START_MS / 1000} s`);
    if (!job.pid) await sleep(100);
  }
  live.set(runId, job);
  return { dir, log: path.join(dir, 'log.jsonl') };
}

// Whether the job's process group still exists: true, false, or null when docker
// itself could not say. Spelt `-s 0 --`: the image's sh takes no `--` after `-0`.
async function alive(job) {
  const r = await docker(['exec', job.container, 'sh', '-c', `kill -s 0 -- -${job.pid}`], { timeout: 20000 });
  if (r.code === 0) return true;
  if (/No such container|is not running/i.test(r.stderr)) return false;
  return /daemon|connect|ENOENT/i.test(r.stderr) || r.code === null ? null : false;
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
    else if (job.stopping) await sleep(JOB_POLL_MS);
    else if (done !== null && /^\d+\s*$/.test(done)) { exit = Number(done); state = 'ended'; }
    else if (Date.now() - checked >= JOB_LIVENESS_MS) {
      checked = Date.now();
      const up = await alive(job);
      unknown = up === null ? unknown + 1 : 0;
      // A runner that is gone has either just written `done` (the next pass reads it)
      // or never will: its container was removed, or the engine restarted under it.
      if ((up === false && readOwn(job, 'done', 32) === null) || unknown >= 3) state = 'vanished';
    } else await sleep(JOB_POLL_MS);
  }
  // Whatever the agent left running goes with it, and so does its work tree.
  await docker(['exec', job.container, 'sh', `${job.inside}/stop.sh`, job.runId, '0'], { timeout: 30000 });
  const outcome = parseOutcome(job, exit);
  if (state === 'stopped') Object.assign(outcome, { ok: false, summary: 'stopped' });
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
/// its outcome.
export async function stopJob(run) {
  const job = live.get(run.runId);
  if (!job) return null;
  job.stopping = true;
  await docker(['exec', job.container, 'sh', `${job.inside}/stop.sh`, job.runId, String(Math.ceil(JOB_STOP_GRACE_MS / 1000))],
    { timeout: JOB_STOP_GRACE_MS + 30000 });
  job.stopped = true;
  return watch(run);
}
