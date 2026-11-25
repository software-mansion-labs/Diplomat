// The Diplomacy Network daemon, one per machine while the network is on: the node
// (src/node) with the requester and executor sides, behind the applets' unix socket
// (README.md, "Local socket"). `networkEnabled` anything but true in Diplomat's config
// switches the node off and ends the process; SIGTERM, SIGINT and SIGHUP end it with
// its runs left going, for the next daemon to take up from jobs.json.

import crypto from 'node:crypto';
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { atomicWrite, procIdentity, readJson, sweepDeadTmp } from '../../daemon-core/src/fsio.js';
import { NO_ROUTE, jsonServer, listenSingleton, socketHealthy, startFailed } from '../../daemon-core/src/serve.js';
import { b64u } from './core/canon.js';
import { identityFromSeed } from './core/identity.js';
import { adbDevices, createAdbFilter } from './executor/adb.js';
import { createBroker } from './executor/broker.js';
import { createCA } from './executor/ca.js';
import { containerName, createContainers, docker } from './executor/container.js';
import { VANISHED, attachJob, forgetRuns, readOutcome, startJob, stopJob, unended, watch } from './executor/job.js';
import { createLLM } from './executor/llm.js';
import { createMirrors } from './executor/mirror.js';
import { OwnFault } from './executor/own-fault.js';
import { clip } from './executor/sparing.js';
import { createWeighing } from './executor/weigh.js';
import { openLog } from './log.js';
import { clearAway, finishedLeft, readConfig } from './off.js';
import { createNode } from './node/node.js';
import { createStore } from './node/store.js';
import { authorize, conclude } from './requester/authorize.js';
import { createForge } from './requester/forge.js';
import { rulesFor } from './requester/rules.js';
import { createTransport } from './transport/index.js';
import {
  ADB_SERVER, BASE_DIR, CLAUDE_BIN, CONFIG_PATH, CONFIG_POLL_MS, CONFIG_UNREADABLE_POLLS, CONTAINER_DISK_BYTES, DISCOVERY_PATH,
  DOCKER_BIN, ENGINE_WAIT_MS, EXECUTOR_CHECK_MS, EXECUTOR_RETRY_MS, FAULT_REPEATS, FAULT_WINDOW_MS, FORWARDS, GH_BIN, GIT_BIN, GLAB_BIN, HOURS_FLOOR,
  JOBS_PATH, JOBS_WRITE_MS, LOG_PATH, MIRROR_KEEP_MS, NOT_BOUNDS, OPENSSL_BIN, POOL_RETRY_MAX_MS, POOL_RETRY_MS, RECONCILE_MS, RUN_KEEP_MS,
  SECURITY_BIN, SOCKET_BODY_CHARS, SOCKET_PATH, STATE_PATH, STATE_WRITE_MS, SWEEP_MS, SWITCH_OFF_WAIT_MS, TEST_FAULTS_PATH, TEST_KNOBS,
  TOOL_PATH, TOR_BIN, TRANSPORT_RETRY_MAX_MS, TRANSPORT_RETRY_MS, locate,
} from './paths.js';

// The state dir holds private prompts, tokens and keys, some written by git, tor and
// openssl: whatever this process or its tools create is the operator's alone, and so is
// a dir an older daemon made.
process.umask(0o077);
fs.mkdirSync(BASE_DIR, { recursive: true });
fs.chmodSync(BASE_DIR, 0o700);
try { fs.chmodSync(LOG_PATH, 0o600); } catch {}

const log = openLog(LOG_PATH);
const startedAt = Math.floor(Date.now() / 1000);
// Tools run by name on this PATH, and pass it to their own helpers.
process.env.PATH = TOOL_PATH;

let store = null;
let node = null;
let ending = false;
const timers = [];

// A fault is its message and where it was thrown.
const faultOf = (err) => String(err?.stack ?? err).split('\n').slice(0, 2).join('\n');

// A failure is a fault (onFault). `row` lets a slow timer that fails the same way
// FAULT_REPEATS times running end the daemon: it never repeats within FAULT_WINDOW_MS.
function every(ms, fn) {
  let last = '';
  let row = 0;
  timers.push(setInterval(async () => {
    try {
      await fn();
      row = 0;
    } catch (err) {
      row = faultOf(err) === last ? row + 1 : 1;
      last = faultOf(err);
      onFault(err, row);
    }
  }, ms));
}

// ---- the tools

const TOOLS = {
  tor: TOR_BIN, docker: DOCKER_BIN, git: GIT_BIN, gh: GH_BIN, glab: GLAB_BIN, openssl: OPENSSL_BIN, claude: CLAUDE_BIN,
  // The Keychain, for the model credential.
  ...(process.platform === 'darwin' ? { security: SECURITY_BIN } : {}),
};
const located = new Map(); // a tool -> where it was last found, or null
const nowhere = (bin) => (bin.includes('/') ? `not at ${bin}` : `in none of ${TOOL_PATH}`);

function lookForTools() {
  for (const [tool, bin] of Object.entries(TOOLS)) {
    const at = locate(bin);
    if (located.get(tool) === at) continue;
    located.set(tool, at);
    // Said, since a stand-in gets whatever the daemon gives the tool.
    const named = bin === tool ? '' : `, which DN_${tool.toUpperCase()} names`;
    log(at ? `${tool} is ${at}${named}` : `${tool} is ${nowhere(bin)}`);
  }
}

// ---- Diplomat's settings

let hours = { requiredMinimumH: HOURS_FLOOR, maximumAcceptedH: HOURS_FLOOR };
let devicesOn = false;
let unreadable = 0;

function pollConfig() {
  const config = readConfig();
  if (!config) {
    unreadable += 1;
    // A read can land mid-rewrite; only a file that stays unreadable counts.
    log(`${CONFIG_PATH} could not be read (${unreadable} of ${CONFIG_UNREADABLE_POLLS})`);
    if (unreadable >= CONFIG_UNREADABLE_POLLS) end({ off: true, why: `${CONFIG_PATH} could not be read ${unreadable} times in a row: the network counts as switched off` });
    return;
  }
  unreadable = 0;
  // The node clamps both to the protocol's range.
  hours = { requiredMinimumH: config.networkRequiredMinimumH, maximumAcceptedH: config.networkMaximumAcceptedH };
  if ((config.networkDevices === true) !== devicesOn) {
    devicesOn = !devicesOn;
    log(devicesOn ? 'the jobs started from now on are given this machine\'s devices' : 'the jobs started from now on are given no device of this machine');
    lookForAdb();
  }
  if (config.networkEnabled !== true) end({ off: true, why: 'the network was switched off in Diplomat\'s settings' });
}

// ---- the transport

// A transport whose start failed (tor missing, its data dir held) cannot start again, so
// the node gets this one face over a fresh transport per try, the waits doubling up to
// TRANSPORT_RETRY_MAX_MS.
function lastingTransport(make) {
  const watchers = [];
  const halted = new AbortController();
  let inner = make();
  let state = inner.state();
  let onRequest = null;
  let limitFor = null;
  const say = (now) => {
    state = now;
    for (const fn of watchers) fn({ ...now });
  };
  return {
    address: inner.address,
    state: () => ({ ...state }),
    onState(fn) { watchers.push(fn); },
    onRequest(fn) { onRequest = fn; },
    limitFor(fn) { limitFor = fn; },
    async start() {
      for (let wait = TRANSPORT_RETRY_MS; ; wait = Math.min(wait * 2, TRANSPORT_RETRY_MAX_MS)) {
        const mine = inner;
        mine.onRequest(onRequest);
        mine.limitFor(limitFor);
        mine.onState(say);
        try {
          await mine.start();
          return;
        } catch (err) {
          if (halted.signal.aborted) return;
          log(`the transport did not start (${err?.message ?? err}): the next try is in ${wait / 1000} s`);
        }
        await delay(wait, null, { signal: halted.signal }).catch(() => {});
        if (halted.signal.aborted) return;
        inner = make();
      }
    },
    request: (...args) => inner.request(...args),
    async stop() {
      halted.abort();
      await inner.stop();
    },
  };
}

// ---- the requester side

const forge = createForge({ log });
const projectIds = new Map(); // a GitLab pool's id -> its project's numeric id
let links = new Map(); // pool id -> { id, path, forge, identity }, as Diplomat last listed them

const hostOf = (id) => id.split('/')[0];
const repoOf = (id) => id.split('/').slice(1).join('/');

// On GitLab `rulesFor` also gets the numeric project id, asked once: the forge's own
// clients name a project either way.
async function ruleTarget(link) {
  if (link.forge !== 'gitlab') return link.id;
  if (!projectIds.has(link.id)) {
    let id = null;
    try {
      id = await forge.projectId({ forge: 'gitlab', host: hostOf(link.id) }, repoOf(link.id));
    } catch (err) {
      log(`the project id of ${link.id} could not be asked: ${err?.message ?? err}`);
    }
    if (id === null) return link.id;
    projectIds.set(link.id, id);
  }
  return { id: link.id, projectId: projectIds.get(link.id) };
}

const requester = {
  rulesFor: async ({ pool: link, ...task }) => rulesFor({ ...task, pool: await ruleTarget(link) }),
  context: ({ pool: link, ...rest }) => forge.context({
    ...rest, forge: link.forge, host: hostOf(link.id), repo: repoOf(link.id), checkout: link.path,
  }),
  authorize,
  conclude,
  perform: forge.perform,
};

async function authorOf(checkout) {
  const ask = (key) => new Promise((resolve) => {
    execFile(GIT_BIN, ['-C', checkout, 'config', '--get', key], { encoding: 'utf8', timeout: 10000 }, (err, stdout) => resolve(err ? '' : stdout.trim()));
  });
  const [name, email] = await Promise.all([ask('user.name'), ask('user.email')]);
  if (!name || !email) throw new Refusal(409, `The checkout at ${checkout} has no git user.name and user.email, and a task's commits are made in that name.`);
  return { name, email };
}

// ---- the executor side

const ca = createCA({ log });
const llm = createLLM({ log });
const mirrors = createMirrors({ log });
const broker = createBroker({ log, ca, llm, mirrors, onForge: (job, request) => node.actFor(job.runId)(request) });
const containers = createContainers({ log, broker: () => broker.address() });

const jobs = new Map(); // run id -> { container, pool, peer, token, generation, pid, forwards, spent, release, stopping, ended, verdict, gone }
// Until an earlier daemon's jobs are taken up, a run with no job here may still be
// running, and no job may start: the first job counted in a container removes what
// stands under its name. A start also waits for the first image and credential check.
let takenUp = false;
const lookedAt = Promise.withResolvers();
let report = () => {};

// jobs.json as last written, on every job change and every JOBS_WRITE_MS while model
// spend moves: the next daemon counts on from it. The store is flushed first, so a job
// leaves the file only once its run's end is on disk; while that fails the file stays,
// for the next daemon to ask after the job.
let savedJobs = '';
const saveJobs = () => {
  const kept = Object.fromEntries([...jobs].map(([runId, { container, pool, peer, token, generation, pid, forwards }]) => [
    runId, { container, pool, peer, token, generation, pid, forwards, spent: spentOf(runId) },
  ]));
  const next = { port: broker.address()?.port ?? 0, jobs: kept };
  if (JSON.stringify(next) === savedJobs) return;
  try {
    store.flush();
    atomicWrite(JOBS_PATH, next, 0o600);
    savedJobs = JSON.stringify(next);
  } catch (err) {
    log(`jobs.json is as it was: ${err?.message ?? err}`);
  }
};

// The broker's model spend for a job (the last seen once it left the broker), or null.
// job.js caps the job's own figures at it.
function spentOf(runId) {
  const job = jobs.get(runId);
  if (job) job.spent = broker.spent(runId) ?? job.spent;
  return job?.spent ?? null;
}

function poolOf(link) {
  const parts = link.id.split('/');
  return { id: link.id, forge: link.forge, host: parts[0], owner: parts.slice(1, -1).join('/'), repo: parts.at(-1) };
}

// Jobs reach the adb server only through this filter.
const adb = createAdbFilter({ target: ADB_SERVER, log });
// Null while devices are off or no adb server answers.
let attached = null;

async function lookForAdb() {
  attached = devicesOn ? await adbDevices(ADB_SERVER) : null;
  return attached !== null;
}

function devicesState() {
  if (!devicesOn) return { state: 'off', detail: '' };
  if (attached !== null) return { state: 'ready', detail: '' };
  return { state: 'none', detail: ADB_SERVER ? `no adb server answers at ${ADB_SERVER.host}:${ADB_SERVER.port}` : 'DN_ADB_SERVER names no address on this machine' };
}

// `only`: the forwards a job taken up after a restart was started with.
async function openForwards(runId, only = null) {
  if (!devicesOn) return [];
  const wanted = (name) => only === null || only.includes(name);
  const forwards = Object.entries(FORWARDS).filter(([name]) => wanted(name)).map(([name, target]) => broker.addForward(runId, { name, target }));
  if (wanted('adb') && await lookForAdb()) forwards.push(broker.addForward(runId, { name: 'adb', target: await adb.start() }));
  return forwards;
}

// The node hears of the end before anything is taken down, so it never sees a job that
// is neither alive nor reported.
function follow(runId) {
  jobs.get(runId).gone = watch({ runId })
    .catch((err) => ({ ok: false, summary: `the run could not be watched: ${err?.message ?? err}` }))
    .then((outcome) => settle(runId, outcome));
}

async function settle(runId, ended) {
  const job = jobs.get(runId);
  if (!job) return;
  // Ended by this machine for the job's own doing: a failed attempt, in its words.
  let outcome = job.verdict ? { ...ended, ok: false, state: 'failed', summary: job.verdict } : ended;
  const by = !job.verdict && ended.summary === VANISHED ? await containers.endedBy(job.container).catch(() => null) : undefined;
  if (by === 'job' || by === '') outcome = { ...ended, summary: INSIDE[by] };
  // The summary is the job's own words.
  log(`${runId} ended: ${outcome.state ?? 'failed'}${outcome.ok ? '' : ` (${clip(outcome.summary)})`}`);
  job.ended = true;
  if (by === 'engine' || by === null) giveBack(runId, by === null ? MUTE : ENGINE_ENDED);
  else report(runId, outcome);
  broker.removeJob(runId);
  job.release();
  try {
    await containers.release({ name: job.container, runId });
  } catch (err) {
    log(`${job.container} could not be released: ${err?.message ?? err}`);
  }
  jobs.delete(runId);
  saveJobs();
}

// Starts in flight: each may yet make a container.
let starting = 0;

// Pools a job could not start in: id -> { why, until, row, path }. No job is taken while
// `why` is set; `row` counts failures since the last start, `path` the checkout they met.
const stuck = new Map();

function leaveAlone({ id, path: checkout }, why) {
  const row = (stuck.get(id)?.row ?? 0) + 1;
  const wait = Math.min(POOL_RETRY_MAX_MS, POOL_RETRY_MS * 2 ** (row - 1));
  log(`taking no job of ${id} for ${Math.round(wait / 1000)} s: ${why}`);
  stuck.set(id, { why, until: Date.now() + wait, row, path: checkout });
}

// A pool whose wait is over is taken from again once its mirror can be made, the one
// part of a start that needs no job. Nothing is held against a pool unlinked or linked
// to another checkout.
async function retryPools() {
  for (const [id, held] of stuck) {
    const link = links.get(id);
    if (link?.path !== held.path) {
      stuck.delete(id);
      continue;
    }
    if (held.until > Date.now()) continue;
    // Skipped by an overlapping pass.
    held.until = Infinity;
    try {
      await mirrors.ensureMirror({ pool: poolOf(link), checkout: link.path });
      held.why = '';
      log(`taking jobs of ${id} again`);
    } catch (err) {
      leaveAlone(link, err.message);
    }
  }
}

async function startRun({ runId, pool: link, peer, spec }) {
  if (typeof spec?.prompt !== 'string' || typeof spec.name !== 'string' || typeof spec.email !== 'string') {
    throw new Error('the task names no prompt or no author for its commits');
  }
  // An ending daemon makes no container: a switched-off one has listed, or is about to
  // list, what it removes.
  const unlessEnding = () => { if (ending) throw new OwnFault('this machine is stopping'); };
  // Uncounted while it waits: if the daemon ends first, this never resolves.
  await lookedAt.promise;
  starting += 1;
  const pool = poolOf(link);
  let release = () => {};
  let container = null;
  try {
    const mirror = await mirrors.ensureMirror({ pool, checkout: link.path });
    if (mirror.error) log(`the mirror of ${pool.id} was not refreshed: ${mirror.error}`);
    unlessEnding();
    release = mirrors.retain(pool);
    container = await containers.acquire({ pool, peer, runId });
    unlessEnding();
    const proxy = await broker.addJob({ runId, pool, peer });
    const forwards = await openForwards(runId);
    jobs.set(runId, {
      container: container.name, pool, peer, token: proxy.token, generation: proxy.generation, pid: 0, forwards: forwards.map((f) => f.name),
      release, stopping: null, ended: false,
    });
    saveJobs();
    const started = await startJob({ run: { runId, pool }, container, spec, proxy, env: llm.env(), forwards, spent: () => spentOf(runId) });
    // The next daemon stops the job by this group, which the job cannot rewrite.
    jobs.get(runId).pid = started.pid;
    saveJobs();
    log(`${runId} started in ${container.name} for ${peer}${forwards.length > 0 ? `, with ${forwards.map((f) => f.name).join(', ')} forwarded` : ''}`);
    stuck.delete(pool.id);
    follow(runId);
    // The stream's path is not returned: what stands there is the job's to write.
    return { container: container.name };
  } catch (err) {
    broker.removeJob(runId);
    release();
    if (container) await containers.release({ name: container.name, runId }).catch(() => {});
    jobs.delete(runId);
    saveJobs();
    // The node gives an OwnFault's run back at no attempt; any other failure counts as
    // one, since the requester's jobs may have caused it.
    if (err instanceof OwnFault && !ending) leaveAlone(link, err.message);
    log(`${runId} could not be started: ${err?.message ?? err}`);
    throw err;
  } finally {
    starting -= 1;
  }
}

// Retries until the job is stopped: the node asks once, and a job outliving its run
// would go on spending the requester's key and this machine's model. Its broker access
// goes first, so one slow to die spends nothing meanwhile.
function stopRun(runId, reason) {
  const job = jobs.get(runId);
  if (!job) return Promise.resolve();
  job.stopping ??= (async () => {
    log(`stopping ${runId}: ${reason}`);
    // Kept for the outcome, read after this.
    spentOf(runId);
    broker.removeJob(runId);
    while (jobs.has(runId)) {
      try {
        // Null: never started, or ended; `settle` clears it away.
        if ((await stopJob({ runId }, containers)) === null) return;
      } catch (err) {
        log(`${runId} could not be stopped: ${err?.message ?? err}`);
        await delay(EXECUTOR_RETRY_MS);
      }
    }
  })().finally(() => { job.stopping = null; });
  return job.stopping;
}

function unable(id) {
  const docker = containers.dockerState();
  if (docker.state !== 'ready') return `docker is ${docker.state}: ${docker.detail}`;
  const model = llm.state();
  if (model.state !== 'ready') return `no credential for the model: ${model.detail}`;
  // A job reaches the model and its forge through certificates made with it.
  if (!located.get('openssl')) return `openssl is ${nowhere(OPENSSL_BIN)}: no certificate authority can be made for a job`;
  const why = stuck.get(id)?.why ?? '';
  return why === '' ? '' : `this machine could not start a job of this pool: ${why}`;
}

const executor = {
  // A claim this machine cannot serve keeps the task from every machine that could.
  wouldTake: (task) => !ending && unable(task.pool) === '',
  // Android tasks are left a while to machines with a device.
  weigh: createWeighing({ checkoutOf: (pool) => links.get(pool)?.path ?? null, hasDevice: () => (attached?.length ?? 0) > 0 }),
  start: startRun,
  stop: stopRun,
  alive: (runId) => (jobs.has(runId) ? true : takenUp ? false : null),
  onEnd(fn) { report = fn; },
};

const OUTGREW = 'the container outgrew its disk allowance';
const UNMEASURED = 'the container could not be measured against its disk allowance';

const NO_RUN = 'no run of this host stands behind it';
// A job that went without writing `done` was ended by the machine only when
// `containers.endedBy` says the engine did: a job is root in its container and can stop
// it, but not its relay, which only an engine or machine restart stops too. The
// machine's doing is given back; the job's is a failed attempt.
const GONE = 'its container and the container\'s relay were gone or stopped when this daemon started, as a restart of the machine or of its docker engine leaves them, and the job had not finished';
const ENGINE_ENDED = 'the docker engine stopped its container and the container\'s relay under the job, as a restart of the engine or of the machine does';
const UNTAKEN = 'its container runs but could not be taken up by this daemon';
const INSIDE = {
  job: 'the job\'s container stopped before the job finished, its relay running on: it was stopped from inside',
  '': 'the job\'s processes went before it finished, in a container that runs on',
};
const MUTE = 'the docker engine did not answer when its container was looked at, and nothing can be said of the job in it';
const silent = (when) => `the docker engine did not answer for ${Math.round(ENGINE_WAIT_MS / 1000)} s ${when}, and nothing can be said of the job in it`;

// Costs the requester no attempt. A job the node holds no run for is stopped here.
function giveBack(runId, why) {
  log(`giving ${runId} back: ${why}`);
  node.stopRun({ runId, reason: why }).catch(() => stopRun(runId, why));
}

const engineAnswers = async () => (await docker(['version', '--format', '{{.Server.Version}}'], { timeout: 20000 })).code === 0;

const stands = (runId) => node.snapshot().runs.some((run) => run.runId === runId && run.endedAt === 0);

// Takes up the previous daemon's jobs. With `answers` false (the engine silent for
// ENGINE_WAIT_MS) an unfinished one is given back, and `reconcile` stops what is left
// once the engine answers. A running run on no list is asked after too: it may have
// ended under a daemon that died before telling the node.
async function takeUp(kept, answers) {
  const moved = broker.address().port !== kept.port;
  for (const [runId, was] of Object.entries(kept.jobs ?? {})) {
    try {
      const ended = readOutcome(runId);
      if (ended) {
        report(runId, ended);
        continue;
      }
      const container = answers ? await containers.adopt({ pool: was.pool, peer: was.peer, runId }) : null;
      if (!container) {
        const left = await finishedLeft(runId);
        if (left && attachJob({ runId, container: left.container, pid: was.pid ?? null, spent: () => spentOf(runId) })) {
          log(`${runId} finished while no daemon watched it: its outcome is read from what it left`);
          jobs.set(runId, { ...was, container: left.container.name, release: mirrors.retain(was.pool), stopping: null, ended: false });
          follow(runId);
          continue;
        }
        const by = answers ? await containers.endedBy(containerName(was.pool.id, was.peer)) : null;
        if (by === 'job') {
          log(`${runId} ended while no daemon watched it: ${INSIDE.job}`);
          report(runId, { ok: false, summary: INSIDE.job, usd: 0, tokens: 0, model: '', runner: 'claude', exit: null, state: 'failed' });
        } else giveBack(runId, !answers ? silent('after this daemon started') : by === 'engine' ? GONE : by === '' ? UNTAKEN : MUTE);
        continue;
      }
      if (!was.pid) {
        // No process group recorded: nothing to watch it by.
        log(`${runId} was being started when the daemon before this one went: stopping what there is of it in ${container.name}`);
        if (attachJob({ runId, container })) await stopJob({ runId }, containers);
        await containers.release({ name: container.name, runId });
        continue;
      }
      if (!attachJob({ runId, container, pid: was.pid, spent: () => spentOf(runId) })) {
        await containers.release({ name: container.name, runId });
        continue;
      }
      jobs.set(runId, { ...was, container: container.name, release: mirrors.retain(was.pool), stopping: null, ended: false });
      follow(runId);
      if (!stands(runId)) {
        stopRun(runId, NO_RUN);
        continue;
      }
      if (moved) {
        // Its proxy address names a port this daemon could not get again.
        giveBack(runId, 'the broker could not listen where this job reaches it');
        continue;
      }
      await broker.addJob({ runId, pool: was.pool, peer: was.peer }, { token: was.token, generation: was.generation, spent: was.spent ?? undefined });
      await openForwards(runId, was.forwards ?? []);
      log(`${runId} taken up in ${container.name}`);
    } catch (err) {
      log(`${runId} could not be taken up: ${err?.stack ?? err}`);
      if (jobs.has(runId)) giveBack(runId, 'it could not be taken up after a restart');
    }
  }
  for (const { runId } of node.snapshot().runs.filter((run) => run.endedAt === 0 && !Object.hasOwn(kept.jobs ?? {}, run.runId))) {
    const ended = readOutcome(runId);
    if (ended) report(runId, ended);
  }
  takenUp = true;
  saveJobs();
}

// Stops jobs the node holds no live run for (a stop that failed, a lost record) and
// strays no record holds (a lost jobs.json). A stray's stop retries until the engine
// answers, so it begins only once it has. An engine silent for ENGINE_WAIT_MS while
// there are jobs gets them all given back, as at startup.
let reconciling = false;
let silentSince = 0;
async function reconcile() {
  if (!takenUp || reconciling) return;
  const going = new Set(node.snapshot().runs.filter((run) => run.endedAt === 0).map((run) => run.runId));
  for (const [runId, job] of jobs) {
    // Ended: only being taken down.
    if (!going.has(runId) && !job.ended) stopRun(runId, NO_RUN);
  }
  const strays = unended().filter(({ runId }) => !jobs.has(runId));
  if (strays.length === 0 && jobs.size === 0) {
    silentSince = 0;
    return;
  }
  reconciling = true;
  const asked = Date.now();
  let answers = false;
  try {
    answers = await engineAnswers();
  } finally {
    reconciling = false;
  }
  if (!answers) {
    silentSince ||= asked;
    if (Date.now() - silentSince < ENGINE_WAIT_MS) return;
    for (const [runId, job] of jobs) if (!job.ended && !job.stopping) giveBack(runId, silent('while the job ran'));
    return;
  }
  silentSince = 0;
  for (const { runId, container } of strays) {
    if (jobs.has(runId) || !attachJob({ runId, container })) continue;
    log(`stopping ${runId} in ${container.name}: this daemon holds no record of the job`);
    stopJob({ runId }, containers).catch((err) => log(`${runId} could not be stopped: ${err?.message ?? err}`));
  }
}

async function checkExecutor() {
  await Promise.all([containers.ensureImage().catch(() => {}), llm.load().catch(() => {}), lookForAdb()]);
}

// Each job of an evicted container is a failed attempt: whichever filled it would fill
// the next one too. An unmeasurable one (`bytes` null) goes too, or it would be held to
// no allowance. One with a job still starting waits for the next look.
async function evict({ name, bytes, jobs: counted }) {
  const held = counted.map((runId) => jobs.get(runId));
  if (held.some((job) => !job?.gone)) return;
  const [said, verdict] = bytes === null
    ? [`${name} could not be measured against the ${CONTAINER_DISK_BYTES} bytes of this machine's disk a container gets`, UNMEASURED]
    : [`${name} holds ${bytes} bytes of this machine's disk, over the ${CONTAINER_DISK_BYTES} a container gets`, OUTGREW];
  log(`${said}: stopping its ${counted.length} job(s) and removing it`);
  counted.forEach((runId, i) => {
    held[i].verdict = verdict;
    stopRun(runId, verdict);
  });
  await Promise.all(held.map((job) => job.gone));
  await containers.discard(name);
}

// Every SWEEP_MS. CAs are pruned only with no job running: a job is answered from the
// one it was started under.
const upkeep = [
  ['containers over their disk allowance', async () => { for (const over of await containers.overQuota()) await evict(over); }],
  ['what containers left behind', () => containers.sweep()],
  ['old certificate authorities', () => { if (jobs.size === 0) ca.prune(); }],
  ['certificates past their end', () => { ca.dropExpired(); }],
  ['ended runs', async () => {
    const gone = await forgetRuns({ olderThanMs: RUN_KEEP_MS, containers });
    if (gone.length > 0) log(`forgot ${gone.length} run(s) that ended over ${Math.round(RUN_KEEP_MS / 3600000)} h ago`);
  }],
  ['mirrors', () => {
    const standing = new Set(node.snapshot().pools.filter((pool) => !pool.left).map((pool) => pool.id));
    return mirrors.sweep([...links.values()].filter((link) => standing.has(link.id)).map(poolOf), MIRROR_KEEP_MS);
  }],
];

// A look an earlier sweep is still at is skipped: two would only slow each other.
const looking = new Set();
async function sweep() {
  for (const [what, look] of upkeep) {
    if (looking.has(what)) continue;
    looking.add(what);
    try {
      await look();
    } catch (err) {
      log(`upkeep of ${what} failed: ${err?.stack ?? err}`);
    } finally {
      looking.delete(what);
    }
  }
}

// Leftover jobs are taken up without waiting for the image or credential: a build takes
// minutes, and a running job needs the broker meanwhile. On Linux the broker listens on
// docker's bridge, so it waits for the engine.
async function startExecutor() {
  const kept = readJson(JOBS_PATH) ?? {};
  const leftJobs = Object.keys(kept.jobs ?? {}).length > 0;
  while (!broker.address() && !ending) {
    const told = leftJobs && kept.port > 0;
    try {
      await broker.start(told ? { port: kept.port } : {});
    } catch (err) {
      log(`the broker is not listening: ${err?.message ?? err}`);
      // Their port is taken: any serves new jobs, and takeUp gives the old ones back.
      if (err?.code === 'EADDRINUSE' && told) kept.port = 0;
      else await delay(EXECUTOR_RETRY_MS);
    }
  }
  // A silent engine says nothing of its jobs: ask again for up to ENGINE_WAIT_MS.
  let checked = null;
  let answers = true;
  for (const from = Date.now(); !ending; await delay(EXECUTOR_RETRY_MS)) {
    checked = checkExecutor();
    answers = !leftJobs || await engineAnswers();
    if (answers || Date.now() - from >= ENGINE_WAIT_MS) break;
  }
  if (ending) return;
  await takeUp(kept, answers);
  every(EXECUTOR_CHECK_MS, checkExecutor);
  every(EXECUTOR_CHECK_MS, retryPools);
  every(RECONCILE_MS, reconcile);
  every(JOBS_WRITE_MS, saveJobs);
  every(SWEEP_MS, sweep);
  await checked;
  lookedAt.resolve();
}

// ---- the snapshot

// `notTaking`: of a pool, why this machine takes none of its jobs; of an own offer
// still pooled, why this machine does not take it.
function snapshot() {
  const { updatedAt, identity, transport, admit, pools, runs, offers } = node.snapshot();
  const down = transport.state === 'ready' ? '' : `the transport is ${transport.state}: ${transport.detail}`;
  const rows = pools.map((pool) => ({ ...pool, notTaking: pool.left ? '' : down || unable(pool.id) }));
  const own = (offer) => {
    if (offer.state !== 'pooled') return '';
    const pool = rows.find((row) => row.id === offer.pool);
    const most = pool?.members.find((member) => member.self)?.maxAcceptedH;
    const needs = pool?.tasks.find((task) => task.taskId === offer.taskId)?.hours;
    if (pool?.notTaking) return pool.notTaking;
    if (needs > most) return `this machine takes jobs of at most ${most} h and this one needs ${needs}`;
    if (offer.leftForGood) return 'its run was stopped on this machine, which does not take it again';
    return offer.leftUntil > 0 ? `this machine failed at it or gave it back, and leaves it to the others until ${new Date(offer.leftUntil * 1000).toISOString()}` : '';
  };
  return {
    updatedAt, daemon: { pid: process.pid, startedAt, testSettings: TEST_KNOBS }, identity, transport,
    docker: containers.dockerState(), model: llm.state(), devices: devicesState(), admit, pools: rows, runs,
    offers: offers.map((offer) => ({ ...offer, notTaking: own(offer) })),
  };
}

let writing = null;
let written = 0;
let shown = '';

// Not fsynced: only a person looking into a daemon that stopped answering reads it.
function writeState() {
  writing = null;
  written = Date.now();
  if (!node) return;
  try {
    const tmp = `${STATE_PATH}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, `${JSON.stringify(snapshot(), null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, STATE_PATH);
  } catch (err) {
    log(`state.json could not be written: ${err?.message ?? err}`);
  }
}

function touch() {
  writing ??= setTimeout(writeState, Math.max(0, written + STATE_WRITE_MS - Date.now()));
}

// These change without the node knowing.
function watchExecutor() {
  const now = JSON.stringify([containers.dockerState(), llm.state(), devicesState(), [...stuck].map(([id, held]) => [id, held.why])]);
  if (now !== shown) touch();
  shown = now;
}

// ---- the local socket

class Refusal extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

const text = (max, min = 1) => [(v) => typeof v === 'string' && v.length >= min && v.length <= max, min === 0 ? `text of at most ${max} characters` : `text of 1 to ${max} characters`];
const whole = (min, max) => [(v) => Number.isSafeInteger(v) && v >= min && v <= max, `a whole number from ${min} to ${max}`];
const flag = [(v) => typeof v === 'boolean', 'true or false'];
const plainObject = [(v) => v !== null && typeof v === 'object' && !Array.isArray(v), 'an object'];
const optional = ([check, what]) => [(v) => v === undefined || check(v), what];

// Members not in `shape` are ignored.
function read(body, shape, what = 'The request body') {
  if (!plainObject[0](body)) throw new Refusal(400, `${what} must be a JSON object.`);
  const out = {};
  for (const [name, [check, kind]] of Object.entries(shape)) {
    if (!check(body[name])) throw new Refusal(400, `"${name}" must be ${kind}.`);
    if (body[name] !== undefined) out[name] = body[name];
  }
  return out;
}

const POOL = text(300);
const SHAPES = {
  pool: { id: POOL, path: text(4096), forge: [(v) => v === 'github' || v === 'gitlab', '"github" or "gitlab"'], identity: text(255, 0) },
  admit: { slots: whole(0, 1000), reason: optional(text(200, 0)) },
  offer: {
    // The node bounds the prompt: it measures the task as sent.
    pool: POOL, kind: text(64), item: text(200), title: text(1000, 0), prompt: [(v) => typeof v === 'string', 'text'], options: optional(plainObject),
    base: optional(text(300)), now: optional(flag),
  },
  withdraw: { taskId: text(600), reason: optional(text(1000, 0)) },
  invite: { pool: POOL, ttlSecs: optional(whole(60, 366 * 24 * 3600)) },
  join: { invite: optional(text(4096)), pool: optional(POOL) },
  leave: { pool: POOL },
  stopRun: { runId: text(64) },
};

// The node refuses with a plain Error whose message is for the operator; anything else
// it throws is a fault.
async function asked(fn) {
  try {
    return await fn();
  } catch (err) {
    if (err?.constructor === Error && err.code === undefined) throw new Refusal(409, err.message);
    throw err;
  }
}

const routes = {
  'GET /health': () => ({ ok: true, pid: process.pid }),
  'GET /state': () => snapshot(),

  'POST /pools': async (body) => {
    const { pools } = read(body, { pools: [(v) => Array.isArray(v) && v.length <= 1000, 'a list of at most 1000 pools'] });
    const list = pools.map((pool) => read(pool, SHAPES.pool, 'Every pool'));
    if (new Set(list.map((pool) => pool.id)).size !== list.length) throw new Refusal(400, 'A pool is listed twice.');
    await asked(() => node.setPools(list));
    links = new Map(list.map((pool) => [pool.id, pool]));
    return { ok: true };
  },

  'POST /admit': async (body) => {
    await asked(() => node.admit(read(body, SHAPES.admit)));
    return { ok: true };
  },

  // Answered once the offer is signed and stored; the pool hears of it in the background.
  'POST /offer': async (body) => {
    const offer = read(body, SHAPES.offer);
    const link = links.get(offer.pool);
    const author = link ? await authorOf(link.path) : {};
    return asked(() => node.offer({ ...offer, author }));
  },

  // Idempotent: the applets withdraw whenever a task of theirs ends, maybe twice.
  'POST /withdraw': async (body) => {
    const { taskId, reason } = read(body, SHAPES.withdraw);
    const open = node.snapshot().offers.some((offer) => offer.taskId === taskId && ['pooled', 'claimed'].includes(offer.state));
    if (open) await asked(() => node.withdraw({ taskId, reason }));
    return { ok: true, ended: true };
  },

  'POST /invite': (body) => asked(() => node.invite(read(body, SHAPES.invite))),

  'POST /join': (body) => {
    const { invite, pool } = read(body, SHAPES.join);
    if ((invite === undefined) === (pool === undefined)) throw new Refusal(400, 'Give either "invite", to join a pool by it, or "pool", to go back into one this machine left.');
    return asked(() => node.join(invite === undefined ? { pool } : { invite }));
  },

  'POST /leave': async (body) => {
    await asked(() => node.leave(read(body, SHAPES.leave)));
    return { ok: true };
  },

  'POST /stop-run': async (body) => {
    await asked(() => node.stopRun(read(body, SHAPES.stopRun)));
    return { ok: true };
  },
};

const server = jsonServer(async (route, body) => {
  if (!Object.hasOwn(routes, route)) return NO_ROUTE;
  if (ending && route !== 'GET /health') throw new Refusal(503, 'The Diplomacy Network daemon is stopping.');
  try {
    return await routes[route](body);
  } catch (err) {
    if (!(err instanceof Refusal)) log(`${route} failed: ${err?.stack ?? err}`);
    throw err;
  }
}, { notJson: 'The request body is not JSON.', maxBody: SOCKET_BODY_CHARS, tooLarge: `The request body is longer than ${SOCKET_BODY_CHARS} characters.` });

// ---- the process

// False once daemon.json names a daemon that took the socket over.
function owned() {
  const owner = readJson(DISCOVERY_PATH)?.pid;
  return !owner || owner === process.pid;
}

function bye(code) {
  if (owned()) {
    try { fs.unlinkSync(SOCKET_PATH); } catch {}
    try { fs.unlinkSync(DISCOVERY_PATH); } catch {}
  }
  process.exit(code);
}

// Null once all this daemon made in docker is gone, else why it may not be. A job still
// being started may make its container after the engine listed what there was.
async function clearDocker() {
  const late = delay(SWITCH_OFF_WAIT_MS, `the docker engine did not answer within ${SWITCH_OFF_WAIT_MS / 1000} s`);
  const left = await Promise.race([containers.removeAll().then(() => null, (err) => String(err?.message ?? err)), late]);
  return left ?? (starting > 0 ? 'a job was still being started' : null);
}

// `off`: the node cancels offers, stops runs and tells pools, then docker and
// OFF_REMOVES are cleared, exiting 1 if any of it is left. Otherwise the runs are left
// going for the next daemon.
async function end({ off, why }) {
  if (ending) return;
  ending = true;
  log(`ending: ${why}`);
  for (const timer of timers) clearInterval(timer);
  clearTimeout(writing);
  // Closing removes the socket file even if another daemon listens there now.
  if (owned()) server.close();
  try {
    await (off ? node?.switchOff() : node?.stop());
  } catch (err) {
    log(`the node did not stop cleanly: ${err?.stack ?? err}`);
  }
  let left = null;
  let kept = '';
  // The engine's deadline, for its containers and then the run records.
  let by = 0;
  if (off) {
    // Stopped jobs come down before the broker goes; starts in flight see `ending`.
    const gone = (async () => { while (jobs.size > 0 || starting > 0) await delay(100); })();
    await Promise.race([gone, delay(SWITCH_OFF_WAIT_MS)]);
    // A job that outlived its stop goes with its container here.
    by = Date.now() + SWITCH_OFF_WAIT_MS;
    left = await clearDocker();
  }
  await broker.stop().catch((err) => log(`the broker did not stop: ${err?.message ?? err}`));
  await adb.stop();
  if (left !== null) log(`switched off with what this daemon made in docker still there: ${left}`);
  else if (off) kept = await clearAway(containers, Math.max(0, by - Date.now()));
  if (kept) log(kept);
  writeState();
  log('ended');
  bye(left === null && kept === '' ? 0 : 1);
}

// An uncaught fault is survived: the jobs watched are worth more than one event. The same
// fault FAULT_REPEATS times, within FAULT_WINDOW_MS or `row` in a row, exits with the
// jobs left going; Diplomat starts a new daemon when nothing answers.
const faults = new Map(); // a fault -> its recent throw times
function onFault(err, row = 0) {
  log(`uncaught: ${String(err?.stack ?? err)}`);
  const now = Date.now();
  for (const [fault, times] of faults) if (now - times.at(-1) >= FAULT_WINDOW_MS) faults.delete(fault);
  const times = [...(faults.get(faultOf(err)) ?? []).filter((at) => now - at < FAULT_WINDOW_MS), now];
  faults.set(faultOf(err), times);
  if (times.length < FAULT_REPEATS && row < FAULT_REPEATS) return;
  log(`the same fault ${FAULT_REPEATS} times ${times.length < FAULT_REPEATS ? 'in a row' : `within ${FAULT_WINDOW_MS / 1000} s`}: exiting, to be started again`);
  bye(1);
}

let signalled = false;
function onSignal(signal) {
  // Only a second signal cuts an end short: the first may land mid switch-off, which must
  // finish.
  if (signalled) {
    log(`${signal} again: exiting at once`);
    bye(1);
  }
  signalled = true;
  // An applet switching the network off writes the setting, then stops the daemon.
  const config = readConfig();
  end({ off: config !== null && config.networkEnabled !== true, why: signal });
}

function setUp() {
  try { fs.chmodSync(SOCKET_PATH, 0o600); } catch {}
  atomicWrite(DISCOVERY_PATH, {
    pid: process.pid, identity: procIdentity(process.pid), startedAt: new Date(startedAt * 1000).toISOString(), socket: SOCKET_PATH, version: 1,
  }, 0o600);
  log('daemon listening', SOCKET_PATH, 'pid', process.pid);
  for (const knob of TEST_KNOBS) log(`${knob} is set, which only a test does: this daemon is not one to run on the network`);
  for (const said of NOT_BOUNDS) log(`${said} would leave no bound where one always holds: the default is used`);

  store = createStore({ dir: BASE_DIR, log });
  // The transport is made for the host's key, which the node would otherwise make itself.
  let identity = identityFromSeed(store.read('identity')?.seed ?? '');
  if (!identity) {
    identity = identityFromSeed(b64u(crypto.randomBytes(32)));
    store.write('identity', { seed: identity.seed });
    store.flush();
  }
  // No list: Diplomat has yet to post one.
  const kept = store.read('links')?.pools;
  links = new Map((Array.isArray(kept) ? kept : []).map((pool) => [pool.id, pool]));
  node = createNode({
    store, transport: lastingTransport(() => createTransport({ identity, log })), log, requester, executor,
    clock: { now: () => Math.floor(Date.now() / 1000), setTimeout, clearTimeout },
    random: (n) => crypto.randomBytes(n),
    settings: () => hours,
  });
  node.onChange(touch);
  // In the background: over Tor that takes minutes, and the socket answers meanwhile.
  node.start().catch((err) => log(`the node did not start: ${err?.stack ?? err}`));
  startExecutor().catch((err) => log(`the executor side did not start: ${err?.stack ?? err}`));
  lookForTools();
  every(EXECUTOR_CHECK_MS, lookForTools);
  pollConfig();
  every(CONFIG_POLL_MS, pollConfig);
  every(STATE_WRITE_MS, watchExecutor);
  // Test faults: each line is thrown once, by a timer's work (`timer `), in an unawaited
  // promise (`promise `), or else by an event handler.
  if (TEST_FAULTS_PATH) {
    const next = (kind) => {
      let lines = [];
      try { lines = fs.readFileSync(TEST_FAULTS_PATH, 'utf8').split('\n').filter(Boolean); } catch {}
      if (lines.length === 0 || (['timer ', 'promise '].find((k) => lines[0].startsWith(k)) ?? '') !== kind) return;
      fs.writeFileSync(TEST_FAULTS_PATH, lines.slice(1).map((line) => `${line}\n`).join(''));
      throw new Error(lines[0]);
    };
    timers.push(setInterval(() => next(''), CONFIG_POLL_MS));
    timers.push(setInterval(() => { (async () => next('promise '))(); }, CONFIG_POLL_MS));
    every(CONFIG_POLL_MS, async () => next('timer '));
  }
  touch();
}

// A daemon that could not be built leaves no socket answering, and its starter hears why.
function onListening() {
  try {
    setUp();
  } catch (err) {
    server.close();
    try { fs.unlinkSync(DISCOVERY_PATH); } catch {}
    startFailed(log, `the daemon could not start: ${err?.stack ?? err}`);
  }
}

async function start() {
  if (await socketHealthy(SOCKET_PATH)) {
    const owner = readJson(DISCOVERY_PATH)?.pid;
    log(`another daemon${owner ? ` (pid ${owner})` : ''} is already live; exiting`);
    process.exit(0);
  }
  for (const file of [DISCOVERY_PATH, STATE_PATH, JOBS_PATH]) sweepDeadTmp(file);
  listenSingleton({ server, socketPath: SOCKET_PATH, log, onListening });
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => onSignal(signal));
  // An unhandled rejection must not take the daemon and its runs' watch down.
  process.on('unhandledRejection', (err) => log(`unhandled: ${err?.stack ?? err}`));
  process.on('uncaughtException', (err) => onFault(err));
}

start();
