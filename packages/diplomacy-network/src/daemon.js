// The Diplomacy Network daemon: one per machine, started by Diplomat while the network
// is switched on. It is the node (src/node) over the real store and transport, with the
// requester side (src/requester) and the executor side (src/executor) plugged into it,
// behind a unix socket the applets talk to (README.md, "Local socket"):
//   GET  /health, GET /state
//   POST /pools, /admit, /offer, /withdraw, /invite, /join, /leave, /stop-run
//
// It reads Diplomat's config.json every CONFIG_POLL_MS: the two hour settings reach the
// node at once, `networkDevices` decides what the jobs started from then on are given
// of this machine's devices, and `networkEnabled` anything but true switches the node
// off - offers cancelled, runs stopped, pools told, its containers removed - and ends
// the process. SIGTERM, SIGINT and SIGHUP end it with its runs left going: the next
// daemon takes them up from jobs.json.

import crypto from 'node:crypto';
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { atomicWrite, procIdentity, readJson, sweepDeadTmp } from '../../daemon-core/src/fsio.js';
import { createLog } from '../../daemon-core/src/log.js';
import { NO_ROUTE, jsonServer, listenSingleton, socketHealthy, startFailed } from '../../daemon-core/src/serve.js';
import { b64u } from './core/canon.js';
import { identityFromSeed } from './core/identity.js';
import { adbDevices, createAdbFilter } from './executor/adb.js';
import { createBroker } from './executor/broker.js';
import { createCA } from './executor/ca.js';
import { createContainers } from './executor/container.js';
import { attachJob, forgetRuns, readOutcome, startJob, stopJob, unended, watch } from './executor/job.js';
import { createLLM } from './executor/llm.js';
import { createMirrors } from './executor/mirror.js';
import { OwnFault } from './executor/own-fault.js';
import { createWeighing } from './executor/weigh.js';
import { createNode } from './node/node.js';
import { createStore } from './node/store.js';
import { authorize } from './requester/authorize.js';
import { createForge } from './requester/forge.js';
import { rulesFor } from './requester/rules.js';
import { createTransport } from './transport/index.js';
import {
  ADB_SERVER, BASE_DIR, CLAUDE_BIN, CONFIG_PATH, CONFIG_POLL_MS, CONFIG_UNREADABLE_POLLS, CONTAINER_DISK_BYTES, DISCOVERY_PATH,
  DOCKER_BIN, EXECUTOR_CHECK_MS, EXECUTOR_RETRY_MS, FAULT_REPEATS, FAULT_WINDOW_MS, FORWARDS, GH_BIN, GIT_BIN, GLAB_BIN, HOURS_FLOOR,
  JOBS_PATH, JOBS_WRITE_MS, LOG_PATH, MIRROR_KEEP_MS, NOT_BOUNDS, OPENSSL_BIN, POOL_RETRY_MAX_MS, POOL_RETRY_MS, RECONCILE_MS, RUN_KEEP_MS,
  SOCKET_BODY_CHARS, SOCKET_PATH, STATE_PATH, OFF_REMOVES, STATE_WRITE_MS, SWEEP_MS, SWITCH_OFF_WAIT_MS, TEST_FAULTS_PATH, TEST_KNOBS,
  TOOL_PATH, TOR_BIN, TRANSPORT_RETRY_MAX_MS, TRANSPORT_RETRY_MS, locate,
} from './paths.js';

// Prompts of private repositories, tokens and keys lie under the state directory, and
// some of it is written by git, tor and openssl: whatever this process or a tool it
// runs creates is the operator's alone, and so is a directory an earlier daemon made
// before that held.
process.umask(0o077);
fs.mkdirSync(BASE_DIR, { recursive: true });
fs.chmodSync(BASE_DIR, 0o700);
try { fs.chmodSync(LOG_PATH, 0o600); } catch {}

const log = createLog(LOG_PATH);
const startedAt = Math.floor(Date.now() / 1000);
// Every tool is run by its name on this PATH, and inherits it for its own helpers.
process.env.PATH = TOOL_PATH;

let store = null;
let node = null;
let ending = false;
const timers = [];

// A fault by its message and the place it was thrown from.
const faultOf = (err) => String(err?.stack ?? err).split('\n').slice(0, 2).join('\n');

// Does `fn` every `ms`. Work that fails is a fault like any other, and one that fails
// the same way FAULT_REPEATS times in a row ends the daemon however seldom its timer
// fires: within FAULT_WINDOW_MS a slow timer never comes round that often.
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

const TOOLS = { tor: TOR_BIN, docker: DOCKER_BIN, git: GIT_BIN, gh: GH_BIN, glab: GLAB_BIN, openssl: OPENSSL_BIN, claude: CLAUDE_BIN };
const located = new Map(); // a tool -> where it was last found, or null

// Says where each tool is, and again when that changes: one installed while the daemon
// runs is found by whatever runs it next.
function lookForTools() {
  for (const [tool, bin] of Object.entries(TOOLS)) {
    const at = locate(bin);
    if (located.get(tool) === at) continue;
    located.set(tool, at);
    // One named by hand is said to be: a stand-in has whatever the daemon gives the tool.
    const named = bin === tool ? '' : `, which DN_${tool.toUpperCase()} names`;
    log(at ? `${tool} is ${at}${named}` : `${tool} is ${bin.includes('/') ? `not at ${bin}` : `in none of ${TOOL_PATH}`}`);
  }
}

// ---- Diplomat's settings

let hours = { requiredMinimumH: HOURS_FLOOR, maximumAcceptedH: HOURS_FLOOR };
// `networkDevices`: whether a job is given anything of this machine's devices.
let devicesOn = false;
let unreadable = 0;

// Diplomat's config as an object, or null while it cannot be read as one.
function readConfig() {
  const config = readJson(CONFIG_PATH);
  return config !== null && typeof config === 'object' && !Array.isArray(config) ? config : null;
}

function pollConfig() {
  const config = readConfig();
  if (!config) {
    unreadable += 1;
    // One read can fall in the middle of a rewrite; only a file that stays unreadable
    // says anything.
    log(`${CONFIG_PATH} could not be read (${unreadable} of ${CONFIG_UNREADABLE_POLLS})`);
    if (unreadable >= CONFIG_UNREADABLE_POLLS) end({ off: true, why: `${CONFIG_PATH} could not be read ${unreadable} times in a row: the network counts as switched off` });
    return;
  }
  unreadable = 0;
  // The node holds each to the range the protocol allows.
  hours = { requiredMinimumH: config.networkRequiredMinimumH, maximumAcceptedH: config.networkMaximumAcceptedH };
  if ((config.networkDevices === true) !== devicesOn) {
    devicesOn = !devicesOn;
    log(devicesOn ? 'the jobs started from now on are given this machine\'s devices' : 'the jobs started from now on are given no device of this machine');
    lookForAdb();
  }
  if (config.networkEnabled !== true) end({ off: true, why: 'the network was switched off in Diplomat\'s settings' });
}

// ---- the transport

// A transport starts once, and one whose start failed is over: tor is not installed yet,
// or its data directory is held. The node is given this instead, the transport of the
// moment behind one face: a start that failed is followed by a new transport, the waits
// between them doubling up to TRANSPORT_RETRY_MAX_MS, and the state the node shows is
// `failed` with the reason during a wait and what the new transport says from its start.
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

// What `rulesFor` is told of a pool: on GitLab its numeric id too, asked of the forge
// once, since the forge's own clients spell a project either way.
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
  context: ({ pool: link, state }) => forge.context({
    forge: link.forge, host: hostOf(link.id), repo: repoOf(link.id), checkout: link.path, state,
  }),
  authorize,
  perform: forge.perform,
};

// Who a task's commits are authored as: the operator, as the linked checkout's git has it.
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
// A job's forge request goes out through its own run's key, and through no other's.
const broker = createBroker({ log, ca, llm, mirrors, onForge: (job, request) => node.actFor(job.runId)(request) });
const containers = createContainers({ log, broker: () => broker.address() });

const jobs = new Map(); // run id -> { container, pool, peer, token, generation, pid, forwards, spent, release, stopping, ended, verdict, gone }
// Until the jobs an earlier daemon left were looked at, a run this daemon holds no job
// for may still be running: nothing can be said of it, and no job is started, since
// what stands under a container's name is removed for the first job this daemon counts
// in it.
let takenUp = false;
const lookedAt = Promise.withResolvers();
let report = () => {};

// jobs.json as it stands on disk. It is written when a job comes or goes, and every
// JOBS_WRITE_MS while what a job has spent of the model moves: the daemon after this one
// counts on from there, a few seconds short at most. A job leaves the file only after
// the node's word on how its run ended is on disk: the store is flushed first, and while
// that fails the file stays as it was, for the daemon after this one to ask after the job.
let savedJobs = '';
const saveJobs = () => {
  const kept = Object.fromEntries([...jobs].map(([runId, { container, pool, peer, token, generation, pid, forwards }]) => [
    runId, { container, pool, peer, token, generation, pid, forwards, spent: broker.spent(runId) },
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

// What the broker has carried to the model for a job, or null: as the broker counts it
// while the job is admitted there, and as it stood when the job was last seen there
// otherwise. A job's own word of its tokens and its cost is held to it (job.js).
function spentOf(runId) {
  const job = jobs.get(runId);
  if (job) job.spent = broker.spent(runId) ?? job.spent;
  return job?.spent ?? null;
}

// The pool as the executor's parts name it.
function poolOf(link) {
  const parts = link.id.split('/');
  return { id: link.id, forge: link.forge, host: parts[0], owner: parts.slice(1, -1).join('/'), repo: parts.at(-1) };
}

// The adb server as jobs reach it: through the filter, never at its own address.
const adb = createAdbFilter({ target: ADB_SERVER, log });
// The devices the adb server lists as ready while jobs are given this machine's
// devices; null while they are not, or no adb server answers.
let attached = null;

async function lookForAdb() {
  attached = devicesOn ? await adbDevices(ADB_SERVER) : null;
  return attached !== null;
}

// The snapshot's `devices`: `off` until the operator opts in, then `ready` while an adb
// server answers and `none` while none does.
function devicesState() {
  if (!devicesOn) return { state: 'off', detail: '' };
  if (attached !== null) return { state: 'ready', detail: '' };
  return { state: 'none', detail: ADB_SERVER ? `no adb server answers at ${ADB_SERVER.host}:${ADB_SERVER.port}` : 'DN_ADB_SERVER names no address on this machine' };
}

// The forwards one job is given while the operator offers this machine's devices: the
// adb server, filtered, while it answers, and whatever DN_FORWARDS names. `only` holds a
// job taken up after a restart to the forwards it was started with.
async function openForwards(runId, only = null) {
  if (!devicesOn) return [];
  const wanted = (name) => only === null || only.includes(name);
  const forwards = Object.entries(FORWARDS).filter(([name]) => wanted(name)).map(([name, target]) => broker.addForward(runId, { name, target }));
  if (wanted('adb') && await lookForAdb()) forwards.push(broker.addForward(runId, { name: 'adb', target: await adb.start() }));
  return forwards;
}

// The job is watched to its end; the node hears how it ended before anything of it is
// taken down, so it never sees a job that is neither alive nor reported.
function follow(runId) {
  jobs.get(runId).gone = watch({ runId })
    .catch((err) => ({ ok: false, summary: `the run could not be watched: ${err?.message ?? err}` }))
    .then((outcome) => settle(runId, outcome));
}

async function settle(runId, ended) {
  const job = jobs.get(runId);
  if (!job) return;
  // A job this machine ended for a fault of its own making is a failed attempt, in the
  // machine's words.
  const outcome = job.verdict ? { ...ended, ok: false, state: 'failed', summary: job.verdict } : ended;
  log(`${runId} ended: ${outcome.state ?? 'failed'}${outcome.ok ? '' : ` (${outcome.summary})`}`);
  job.ended = true;
  report(runId, outcome);
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

// How many jobs are being started: each may make a container yet.
let starting = 0;

// The pools a job could not be started in: pool id -> { why, until, row, path }. While
// `why` says something this machine takes no job of the pool; `row` counts the failures
// since a job of the pool was last started, and `path` is the checkout they were met with.
const stuck = new Map();

// Leaves a pool alone for a while: POOL_RETRY_MS after the first failure, twice as long
// after each one in a row, POOL_RETRY_MAX_MS at most.
function leaveAlone({ id, path: checkout }, why) {
  const row = (stuck.get(id)?.row ?? 0) + 1;
  const wait = Math.min(POOL_RETRY_MAX_MS, POOL_RETRY_MS * 2 ** (row - 1));
  log(`taking no job of ${id} for ${Math.round(wait / 1000)} s: ${why}`);
  // Counted from when it was said.
  stuck.set(id, { why, until: Date.now() + wait, row, path: checkout });
}

// A pool whose wait is over is taken from again once its mirror can be made, the one
// part of a start that needs no job; whatever else stood in the way shows at the next
// job, which is given back like the last. Nothing is held against a pool that is linked
// no longer, or to another checkout.
async function retryPools() {
  for (const [id, held] of stuck) {
    const link = links.get(id);
    if (link?.path !== held.path) {
      stuck.delete(id);
      continue;
    }
    if (held.until > Date.now()) continue;
    // Not looked at again by the next pass while this one is at it.
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
  // A daemon on its way out makes no container and starts no job: one that is switched
  // off has listed what it removes by then, or is about to.
  const unlessEnding = () => { if (ending) throw new OwnFault('this machine is stopping'); };
  // Not counted as being started while it waits: a daemon that ends first never gets to it.
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
    // The daemon after this one stops the job by this group, and by nothing the job can write.
    jobs.get(runId).pid = started.pid;
    saveJobs();
    log(`${runId} started in ${container.name} for ${peer}${forwards.length > 0 ? `, with ${forwards.map((f) => f.name).join(', ')} forwarded` : ''}`);
    stuck.delete(pool.id);
    follow(runId);
    // Where the job's stream is kept is not said: what stands there is the job's to write.
    return { container: container.name };
  } catch (err) {
    broker.removeJob(runId);
    release();
    if (container) await containers.release({ name: container.name, runId }).catch(() => {});
    jobs.delete(runId);
    saveJobs();
    // An OwnFault: no job ran, and why not is this machine's own affair. The node has
    // stopped the run and given it back by the time it hears of the failure, which it
    // would count as an attempt - as it does any other, which the requester's jobs may
    // have brought about.
    if (err instanceof OwnFault) {
      if (!ending) leaveAlone(link, err.message);
      giveBack(runId, `this machine could not start it: ${err.message}`);
    } else log(`${runId} could not be started: ${err?.message ?? err}`);
    throw err;
  } finally {
    starting -= 1;
  }
}

// Stops a job and does not give up: the node asks once, and a job that outlived its run
// would go on spending the requester's key and this machine's model. Its way out is
// closed before anything is asked of its container, so one that is slow to die, or
// will not, does neither from that moment.
function stopRun(runId, reason) {
  const job = jobs.get(runId);
  if (!job) return Promise.resolve();
  job.stopping ??= (async () => {
    log(`stopping ${runId}: ${reason}`);
    // What was carried to the model for it is kept: its outcome is read after this.
    spentOf(runId);
    broker.removeJob(runId);
    while (jobs.has(runId)) {
      try {
        // Null for a job that was never started or has ended: `settle` clears it away.
        if ((await stopJob({ runId }, containers)) === null) return;
      } catch (err) {
        log(`${runId} could not be stopped: ${err?.message ?? err}`);
        await delay(EXECUTOR_RETRY_MS);
      }
    }
  })().finally(() => { job.stopping = null; });
  return job.stopping;
}

// Why this machine can run no job of the pool `id` right now, '' when it can.
function unable(id) {
  const docker = containers.dockerState();
  if (docker.state !== 'ready') return `docker is ${docker.state}: ${docker.detail}`;
  const model = llm.state();
  if (model.state !== 'ready') return `no credential for the model: ${model.detail}`;
  const why = stuck.get(id)?.why ?? '';
  return why === '' ? '' : `this machine could not start a job of this pool: ${why}`;
}

const executor = {
  // Only what can run right now is claimed: a claim this machine cannot serve keeps the
  // task from every machine that could.
  wouldTake: (task) => !ending && unable(task.pool) === '',
  // A task on an Android project is left a while to a machine with a device to give.
  weigh: createWeighing({ checkoutOf: (pool) => links.get(pool)?.path ?? null, hasDevice: () => (attached?.length ?? 0) > 0 }),
  start: startRun,
  stop: stopRun,
  alive: (runId) => (jobs.has(runId) ? true : takenUp ? false : null),
  onEnd(fn) { report = fn; },
};

const OUTGREW = 'the container outgrew its disk allowance';
const UNMEASURED = 'the container could not be measured against its disk allowance';

// A job this daemon can no longer serve is given back: the node stops it for that
// reason and releases its claim, which costs its requester no attempt. One the node
// holds no run for is stopped here.
function giveBack(runId, why) {
  log(`giving ${runId} back: ${why}`);
  node.stopRun({ runId, reason: why }).catch(() => stopRun(runId, why));
}

// Takes up the jobs the daemon before this one left running: each is admitted to the
// broker under the token and CA it was started with and watched from here on. One that
// ended meanwhile is reported; one that cannot be found is, to the node, not alive. A
// run the node calls running whose job is on no list is asked after too: its outcome is
// on disk if it ended under a daemon that did not live to tell the node.
async function takeUp(kept) {
  const moved = broker.address().port !== kept.port;
  for (const [runId, was] of Object.entries(kept.jobs ?? {})) {
    try {
      const ended = readOutcome(runId);
      if (ended) {
        report(runId, ended);
        continue;
      }
      const container = await containers.adopt({ pool: was.pool, peer: was.peer, runId });
      if (!container) continue;
      if (!was.pid) {
        // Its process group was never heard: nothing to watch it by, so it is ended.
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
      if (moved) {
        // The job's proxy address leads to a port this daemon could not have again.
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
  lookedAt.resolve();
  saveJobs();
}

// A job the node holds no live run for is stopped: its run was stopped while a stop
// could not go through, or the node's own record of it was lost. So is a job this
// daemon holds no record of at all, which jobs.json lost leaves behind: it runs on in
// its container with a proxy token nobody takes.
function reconcile() {
  if (!takenUp) return;
  const going = new Set(node.snapshot().runs.filter((run) => run.endedAt === 0).map((run) => run.runId));
  for (const [runId, job] of jobs) {
    // One that ended is only being taken down.
    if (!going.has(runId) && !job.ended) stopRun(runId, 'no run of this host stands behind it');
  }
  for (const { runId, container } of unended()) {
    if (jobs.has(runId) || !attachJob({ runId, container })) continue;
    log(`stopping ${runId} in ${container.name}: this daemon holds no record of the job`);
    stopJob({ runId }, containers).catch((err) => log(`${runId} could not be stopped: ${err?.message ?? err}`));
  }
}

async function checkExecutor() {
  await Promise.all([containers.ensureImage().catch(() => {}), llm.load().catch(() => {}), lookForAdb()]);
}

// A container that holds more of this machine's disk than a container gets goes, and its
// jobs with it: each is a failed attempt, since whichever of them filled it would fill
// the next one too. So does one the engine has not measured for several looks running
// (`bytes` null): what cannot be measured is held to no allowance. One with a job still
// being started is looked at again next time.
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

// What is not kept for ever, looked at every SWEEP_MS, each on its own: a container
// over its disk allowance or not to be measured, what container.js's sweep takes - what
// is left under a container's name that no job is in, and the images no job is started
// in - every certificate authority but the one each set of hosts is given next (a job is answered from the one
// it was started under, so none goes while a job runs), a leaf certificate past its end,
// the directory and the outcome of a run RUN_KEEP_MS after it ended, and the mirror of a
// pool that has not been linked, or has been left, for MIRROR_KEEP_MS.
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

async function sweep() {
  for (const [what, look] of upkeep) {
    try {
      await look();
    } catch (err) {
      log(`upkeep of ${what} failed: ${err?.stack ?? err}`);
    }
  }
}

// The broker, the image and the model credential, then the jobs left from before. On
// Linux the broker listens on docker's bridge, so it waits for the engine like the rest.
async function startExecutor() {
  const kept = readJson(JOBS_PATH) ?? {};
  const leftJobs = Object.keys(kept.jobs ?? {}).length > 0;
  while (!broker.address() && !ending) {
    const told = leftJobs && kept.port > 0;
    try {
      await broker.start(told ? { port: kept.port } : {});
    } catch (err) {
      log(`the broker is not listening: ${err?.message ?? err}`);
      // Somebody else has the port the jobs were told: another serves the next ones.
      if (err?.code === 'EADDRINUSE' && told) kept.port = 0;
      else await delay(EXECUTOR_RETRY_MS);
    }
  }
  await checkExecutor();
  // An engine that does not answer says nothing about the jobs in it.
  while (leftJobs && containers.dockerState().state === 'down' && !ending) {
    await delay(EXECUTOR_RETRY_MS);
    await checkExecutor();
  }
  if (ending) return;
  await takeUp(kept);
  every(EXECUTOR_CHECK_MS, checkExecutor);
  every(EXECUTOR_CHECK_MS, retryPools);
  every(RECONCILE_MS, reconcile);
  every(JOBS_WRITE_MS, saveJobs);
  every(SWEEP_MS, sweep);
}

// ---- the snapshot

// The node's snapshot with the executor's side of it: the engine, the credential, the
// devices, and `notTaking` - of a pool, why this machine takes none of its jobs; of a job
// of this machine's own that waits in the pool, why this machine does not take it.
function snapshot() {
  const { updatedAt, identity, transport, admit, pools, runs, offers } = node.snapshot();
  const down = transport.state === 'ready' ? '' : `the transport is ${transport.state}: ${transport.detail}`;
  const rows = pools.map((pool) => ({ ...pool, notTaking: pool.left ? '' : down || unable(pool.id) }));
  const own = (offer) => {
    if (offer.state !== 'pooled') return '';
    const pool = rows.find((row) => row.id === offer.pool);
    const most = pool?.members.find((member) => member.self)?.maxAcceptedH;
    const needs = pool?.tasks.find((task) => task.taskId === offer.taskId)?.hours;
    return pool?.notTaking || (needs > most ? `this machine takes jobs of at most ${most} h and this one needs ${needs}` : '');
  };
  return {
    updatedAt, daemon: { pid: process.pid, startedAt }, identity, transport,
    docker: containers.dockerState(), model: llm.state(), devices: devicesState(), admit, pools: rows, runs,
    offers: offers.map((offer) => ({ ...offer, notTaking: own(offer) })),
  };
}

let writing = null;
let written = 0;
let shown = '';

// Replaced whole, and not forced to the disk: nothing but a person looking into a daemon
// that no longer answers reads the file.
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

// The snapshot file follows every change, a second behind at most.
function touch() {
  writing ??= setTimeout(writeState, Math.max(0, written + STATE_WRITE_MS - Date.now()));
}

// The engine, the credential, the devices and what is held against a pool change
// without the node's knowing.
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

// The members of `body` a route reads, each checked; any other member is ignored.
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
    // How long a prompt may be is the node's to say: it measures the task as it is sent.
    pool: POOL, kind: text(64), item: text(200), title: text(1000, 0), prompt: [(v) => typeof v === 'string', 'text'], options: optional(plainObject),
    base: optional(text(300)), now: optional(flag),
  },
  withdraw: { taskId: text(600), reason: optional(text(1000, 0)) },
  invite: { pool: POOL, ttlSecs: optional(whole(60, 366 * 24 * 3600)) },
  join: { invite: optional(text(4096)), pool: optional(POOL) },
  leave: { pool: POOL },
  stopRun: { runId: text(64) },
};

// What the node refuses, it refuses with a plain Error whose message is a sentence for
// the operator; anything else it throws is a fault, and is answered and logged as one.
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

  // Answered once the offer is signed and in this machine's store; the pool hears of it
  // in the background.
  'POST /offer': async (body) => {
    const offer = read(body, SHAPES.offer);
    const link = links.get(offer.pool);
    const author = link ? await authorOf(link.path) : {};
    return asked(() => node.offer({ ...offer, author }));
  },

  // The applets withdraw whenever a task of theirs ends, and may say it twice: a task
  // this machine has no open offer of is as withdrawn as it can be.
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

// Whether the socket and daemon.json are this daemon's still: not once daemon.json
// names a daemon that took them over.
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

// Removes everything this daemon made in docker. Null once it is gone, else why it may
// not be: the engine did not answer in SWITCH_OFF_WAIT_MS, or a job was still being
// started, whose container the engine may make after it listed what there was.
async function clearDocker() {
  const late = delay(SWITCH_OFF_WAIT_MS, `the docker engine did not answer within ${SWITCH_OFF_WAIT_MS / 1000} s`);
  const left = await Promise.race([containers.removeAll().then(() => null), late]);
  return left ?? (starting > 0 ? 'a job was still being started' : null);
}

// Ends the daemon. Switched `off`, the node first cancels what this machine offered,
// stops what it runs and tells its pools, everything this daemon made in docker is
// removed, and with that gone what the machine has no further use for (OFF_REMOVES);
// otherwise the runs are left going for the next daemon. Either way the transport
// stops, and with it tor. The exit is 1 for a switch-off that left something in docker.
async function end({ off, why }) {
  if (ending) return;
  ending = true;
  log(`ending: ${why}`);
  for (const timer of timers) clearInterval(timer);
  clearTimeout(writing);
  // Closing the server removes the socket's file, whoever listens there by now.
  if (owned()) server.close();
  try {
    await (off ? node?.switchOff() : node?.stop());
  } catch (err) {
    log(`the node did not stop cleanly: ${err?.stack ?? err}`);
  }
  let left = null;
  if (off) {
    // The jobs the node stopped, taken down before the broker goes, and the jobs being
    // started, which find the daemon ending and make nothing.
    const gone = (async () => { while (jobs.size > 0 || starting > 0) await delay(100); })();
    await Promise.race([gone, delay(SWITCH_OFF_WAIT_MS)]);
    // A job that outlived its stop goes with its container here.
    left = await clearDocker();
  }
  await broker.stop().catch((err) => log(`the broker did not stop: ${err?.message ?? err}`));
  await adb.stop();
  if (left !== null) log(`switched off with what this daemon made in docker still there: ${left}`);
  else if (off) clearAway();
  writeState();
  log('ended');
  bye(left === null ? 0 : 1);
}

// What a machine that left the network keeps nothing of.
function clearAway() {
  for (const dir of OFF_REMOVES) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (err) {
      log(`${dir} could not be removed: ${err?.message ?? err}`);
    }
  }
}

// An exception nobody caught, thrown by some event's handler or by a timer's work (`row`
// is how many times in a row that work has failed this way): logged with its stack, and
// the daemon goes on serving - the jobs it watches are worth more than the one event.
// The same fault FAULT_REPEATS times, within FAULT_WINDOW_MS or in a row, is one it does
// not get past: it exits, its jobs left going for the daemon after it. Diplomat, which
// asks for the snapshot while the network is on, starts that one when nothing answers.
const faults = new Map(); // a fault -> when it was thrown, of late
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
  // Only a second signal cuts an end short: the first may find the daemon already
  // switching off, and that must be let finish.
  if (signalled) {
    log(`${signal} again: exiting at once`);
    bye(1);
  }
  signalled = true;
  // An applet that switches the network off writes the setting and then stops the
  // daemon: the setting says which of the two ends this is.
  const config = readConfig();
  end({ off: config !== null && config.networkEnabled !== true, why: signal });
}

// Builds the daemon behind its socket.
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
  // As the node reads it: a file that holds no list is one Diplomat has yet to post.
  const kept = store.read('links')?.pools;
  links = new Map((Array.isArray(kept) ? kept : []).map((pool) => [pool.id, pool]));
  node = createNode({
    store, transport: lastingTransport(() => createTransport({ identity, log })), log, requester, executor,
    clock: { now: () => Math.floor(Date.now() / 1000), setTimeout, clearTimeout },
    random: (n) => crypto.randomBytes(n),
    settings: () => hours,
  });
  node.onChange(touch);
  // The transport comes up in the background: over Tor that takes minutes, and the
  // socket answers meanwhile.
  node.start().catch((err) => log(`the node did not start: ${err?.stack ?? err}`));
  startExecutor().catch((err) => log(`the executor side did not start: ${err?.stack ?? err}`));
  lookForTools();
  every(EXECUTOR_CHECK_MS, lookForTools);
  pollConfig();
  every(CONFIG_POLL_MS, pollConfig);
  every(STATE_WRITE_MS, watchExecutor);
  // A test's way to a fault: each line of this file is thrown once - one that begins
  // `timer ` by a timer's work, one that begins `promise ` in a promise nobody waits for,
  // any other by an event's handler.
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

// A daemon that could not be built is none: it leaves no socket to answer for it, and
// whoever started it hears why.
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
  // A promise nobody waited for must not take the daemon and its runs' watch down.
  process.on('unhandledRejection', (err) => log(`unhandled: ${err?.stack ?? err}`));
  process.on('uncaughtException', (err) => onFault(err));
}

start();
