// The Diplomacy Network daemon: one per machine, started by Diplomat while the network
// is switched on. It is the node (src/node) over the real store and transport, with the
// requester side (src/requester) and the executor side (src/executor) plugged into it,
// behind a unix socket the applets talk to (README.md, "Local socket"):
//   GET  /health, GET /state
//   POST /pools, /admit, /offer, /withdraw, /invite, /join, /leave, /stop-run
//
// It reads Diplomat's config.json every CONFIG_POLL_MS: the two hour settings reach the
// node at once, and `networkEnabled` anything but true switches the node off - offers
// cancelled, runs stopped, pools told - and ends the process. SIGTERM and SIGINT end it
// with its runs left going: the next daemon takes them up from jobs.json.

import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import { execFile } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { atomicWrite, pidAlive, procIdentity, readJson, sweepDeadTmp } from '../../daemon-core/src/fsio.js';
import { createLog } from '../../daemon-core/src/log.js';
import { NO_ROUTE, jsonServer, listenSingleton, socketHealthy } from '../../daemon-core/src/serve.js';
import { b64u } from './core/canon.js';
import { identityFromSeed } from './core/identity.js';
import { createBroker } from './executor/broker.js';
import { createCA } from './executor/ca.js';
import { createContainers } from './executor/container.js';
import { attachJob, readOutcome, startJob, stopJob, watch } from './executor/job.js';
import { createLLM } from './executor/llm.js';
import { createMirrors } from './executor/mirror.js';
import { createNode } from './node/node.js';
import { createStore } from './node/store.js';
import { authorize } from './requester/authorize.js';
import { createForge } from './requester/forge.js';
import { rulesFor } from './requester/rules.js';
import { createTransport } from './transport/index.js';
import {
  ADB_SERVER, BASE_DIR, CONFIG_PATH, CONFIG_POLL_MS, CONFIG_UNREADABLE_POLLS, DISCOVERY_PATH, EXECUTOR_CHECK_MS,
  EXECUTOR_RETRY_MS, FORWARDS, GIT_BIN, HOURS_FLOOR, JOBS_PATH, LOG_PATH, RECONCILE_MS, SOCKET_PATH, STATE_PATH,
  STATE_WRITE_MS, SWEEP_MS, SWITCH_OFF_WAIT_MS,
} from './paths.js';

const log = createLog(LOG_PATH);
const startedAt = Math.floor(Date.now() / 1000);

let node = null;
let ending = false;
const timers = [];
const every = (ms, fn) => timers.push(setInterval(fn, ms));

// ---- Diplomat's settings

let hours = { requiredMinimumH: HOURS_FLOOR, maximumAcceptedH: HOURS_FLOOR };
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
  if (config.networkEnabled !== true) end({ off: true, why: 'the network was switched off in Diplomat\'s settings' });
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

const jobs = new Map(); // run id -> { container, pool, peer, token, generation, release, stopping }
// Until the jobs an earlier daemon left were looked at, a run this daemon holds no job
// for may still be running, and its container must not be touched for another.
let takenUp = false;
const lookedAt = Promise.withResolvers();
let report = () => {};

const saveJobs = () => {
  const kept = Object.fromEntries([...jobs].map(([runId, { container, pool, peer, token, generation }]) => [runId, { container, pool, peer, token, generation }]));
  try {
    atomicWrite(JOBS_PATH, { port: broker.address()?.port ?? 0, jobs: kept }, 0o600);
  } catch (err) {
    log(`jobs.json could not be written: ${err?.message ?? err}`);
  }
};

// The pool as the executor's parts name it.
function poolOf(link) {
  const parts = link.id.split('/');
  return { id: link.id, forge: link.forge, host: parts[0], owner: parts.slice(1, -1).join('/'), repo: parts.at(-1) };
}

// Does the host's adb server answer? Asked in adb's own words: some other listener on
// that port is nothing to hand a job.
function adbAnswers() {
  return new Promise((resolve) => {
    if (!ADB_SERVER) return resolve(false);
    const socket = net.connect(ADB_SERVER);
    let said = '';
    const done = (answer) => { socket.destroy(); resolve(answer); };
    socket.setTimeout(2000, () => done(false));
    socket.on('error', () => done(false));
    socket.on('connect', () => socket.write('000chost:version'));
    socket.on('data', (chunk) => {
      said += chunk.toString('latin1');
      if (said.length >= 4) done(said.startsWith('OKAY'));
    });
    socket.on('close', () => resolve(false));
  });
}

// The forwards one job is given: the adb server while it answers, and whatever
// DN_FORWARDS names.
async function openForwards(runId) {
  const forwards = Object.entries(FORWARDS).map(([name, target]) => broker.addForward(runId, { name, target }));
  if (await adbAnswers()) forwards.push(broker.addForward(runId, { name: 'adb', target: ADB_SERVER }));
  return forwards;
}

// The job is watched to its end; the node hears how it ended before anything of it is
// taken down, so it never sees a job that is neither alive nor reported.
function follow(runId) {
  watch({ runId })
    .catch((err) => ({ ok: false, summary: `the run could not be watched: ${err?.message ?? err}` }))
    .then((outcome) => settle(runId, outcome));
}

async function settle(runId, outcome) {
  const job = jobs.get(runId);
  if (!job) return;
  log(`${runId} ended: ${outcome.state ?? 'failed'}${outcome.ok ? '' : ` (${outcome.summary})`}`);
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

async function startRun({ runId, pool: link, peer, spec }) {
  if (ending) throw new Error('this machine is stopping');
  if (typeof spec?.prompt !== 'string' || typeof spec.name !== 'string' || typeof spec.email !== 'string') {
    throw new Error('the task names no prompt or no author for its commits');
  }
  await lookedAt.promise;
  const pool = poolOf(link);
  const mirror = await mirrors.ensureMirror({ pool, checkout: link.path });
  if (mirror.error) log(`the mirror of ${pool.id} was not refreshed: ${mirror.error}`);
  const release = mirrors.retain(pool);
  let container = null;
  try {
    container = await containers.acquire({ pool, peer, runId });
    const proxy = await broker.addJob({ runId, pool, peer });
    const forwards = await openForwards(runId);
    jobs.set(runId, { container: container.name, pool, peer, token: proxy.token, generation: proxy.generation, release, stopping: null });
    saveJobs();
    const started = await startJob({ run: { runId, pool }, container, spec, proxy, env: llm.env(), forwards });
    log(`${runId} started in ${container.name} for ${peer}${forwards.length > 0 ? `, with ${forwards.map((f) => f.name).join(', ')} forwarded` : ''}`);
    follow(runId);
    return { container: container.name, log: started.log };
  } catch (err) {
    broker.removeJob(runId);
    release();
    if (container) await containers.release({ name: container.name, runId }).catch(() => {});
    jobs.delete(runId);
    saveJobs();
    throw err;
  }
}

// Stops a job and does not give up: the node asks once, and a job that outlived its run
// would go on spending the requester's key and this machine's model.
function stopRun(runId, reason) {
  const job = jobs.get(runId);
  if (!job) return Promise.resolve();
  job.stopping ??= (async () => {
    log(`stopping ${runId}: ${reason}`);
    while (jobs.has(runId)) {
      try {
        // Null for a job that was never started or has ended: `settle` clears it away.
        if ((await stopJob({ runId })) === null) return;
      } catch (err) {
        log(`${runId} could not be stopped: ${err?.message ?? err}`);
        await delay(EXECUTOR_RETRY_MS);
      }
    }
  })().finally(() => { job.stopping = null; });
  return job.stopping;
}

const executor = {
  // Only what can run right now is claimed: a claim this machine cannot serve keeps the
  // task from every machine that could.
  wouldTake: () => !ending && takenUp && containers.dockerState().state === 'ready' && llm.state().state === 'ready',
  start: startRun,
  stop: stopRun,
  alive: (runId) => (jobs.has(runId) ? true : takenUp ? false : null),
  onEnd(fn) { report = fn; },
};

// A job this daemon can no longer serve is given back: the node stops it and releases
// its claim, which costs its requester no attempt. One the node holds no run for is
// stopped here.
function giveBack(runId, why) {
  log(`giving ${runId} back: ${why}`);
  node.stopRun({ runId }).catch(() => stopRun(runId, why));
}

// Takes up the jobs the daemon before this one left running: each is admitted to the
// broker under the token and CA it was started with and watched from here on. One that
// ended meanwhile is reported; one that cannot be found is, to the node, not alive.
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
      if (!attachJob({ runId, container })) {
        await containers.release({ name: container.name, runId });
        continue;
      }
      jobs.set(runId, { ...was, container: container.name, release: mirrors.retain(was.pool), stopping: null });
      follow(runId);
      if (moved) {
        // The job's proxy address leads to a port this daemon could not have again.
        giveBack(runId, 'the broker could not listen where this job reaches it');
        continue;
      }
      await broker.addJob({ runId, pool: was.pool, peer: was.peer }, { token: was.token, generation: was.generation });
      await openForwards(runId);
      log(`${runId} taken up in ${container.name}`);
    } catch (err) {
      log(`${runId} could not be taken up: ${err?.message ?? err}`);
      if (jobs.has(runId)) giveBack(runId, 'it could not be taken up after a restart');
    }
  }
  takenUp = true;
  lookedAt.resolve();
  saveJobs();
}

// A job the node holds no live run for is stopped: its run was stopped while a stop
// could not go through, or the node's own record of it was lost.
function reconcile() {
  if (!takenUp || jobs.size === 0) return;
  const going = new Set(node.snapshot().runs.filter((run) => run.endedAt === 0).map((run) => run.runId));
  for (const runId of jobs.keys()) {
    if (!going.has(runId)) stopRun(runId, 'no run of this host stands behind it');
  }
}

async function checkExecutor() {
  await Promise.all([containers.ensureImage().catch(() => {}), llm.load().catch(() => {})]);
}

// The broker, the image and the model credential, then the jobs left from before. On
// Linux the broker listens on docker's bridge, so it waits for the engine like the rest.
async function startExecutor() {
  const kept = readJson(JOBS_PATH) ?? {};
  const leftJobs = Object.keys(kept.jobs ?? {}).length > 0;
  while (!broker.address() && !ending) {
    try {
      await broker.start(leftJobs && kept.port > 0 ? { port: kept.port } : {});
    } catch (err) {
      log(`the broker is not listening: ${err?.message ?? err}`);
      // Somebody else has the port the jobs were told: any port serves the next ones.
      if (err?.code === 'EADDRINUSE') kept.port = 0;
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
  every(RECONCILE_MS, reconcile);
  every(SWEEP_MS, () => {
    containers.sweep().catch((err) => log(`the sweep failed: ${err?.message ?? err}`));
    // A job answers from the CA generation it was started under.
    if (jobs.size === 0) ca.prune();
  });
}

// ---- the snapshot

function snapshot() {
  const { updatedAt, identity, transport, admit, pools, runs, offers } = node.snapshot();
  return {
    updatedAt, daemon: { pid: process.pid, startedAt }, identity, transport,
    docker: containers.dockerState(), model: llm.state(), admit, pools, runs, offers,
  };
}

let writing = null;
let written = 0;
let shown = '';

function writeState() {
  writing = null;
  written = Date.now();
  if (!node) return;
  try {
    atomicWrite(STATE_PATH, snapshot(), 0o600);
  } catch (err) {
    log(`state.json could not be written: ${err?.message ?? err}`);
  }
}

// The snapshot file follows every change, a second behind at most.
function touch() {
  writing ??= setTimeout(writeState, Math.max(0, written + STATE_WRITE_MS - Date.now()));
}

// The engine and the credential change without the node's knowing.
function watchExecutor() {
  const now = JSON.stringify([containers.dockerState(), llm.state()]);
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
    pool: POOL, kind: text(64), item: text(200), title: text(1000, 0), prompt: text(2 ** 20, 0), options: optional(plainObject),
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
});

// ---- the process

function bye(code) {
  // Unless a daemon that took over owns them by now.
  const owner = readJson(DISCOVERY_PATH)?.pid;
  if (!owner || owner === process.pid || !pidAlive(owner)) {
    try { fs.unlinkSync(SOCKET_PATH); } catch {}
    try { fs.unlinkSync(DISCOVERY_PATH); } catch {}
  }
  process.exit(code);
}

// Ends the daemon. Switched `off`, the node first cancels what this machine offered,
// stops what it runs and tells its pools; otherwise the runs are left going for the
// next daemon. Either way the transport stops, and with it tor.
async function end({ off, why }) {
  if (ending) return;
  ending = true;
  log(`ending: ${why}`);
  for (const timer of timers) clearInterval(timer);
  clearTimeout(writing);
  server.close();
  try {
    if (off) {
      await node?.switchOff();
      // The jobs the node stopped, taken down before the broker goes.
      const gone = (async () => { while (jobs.size > 0) await delay(100); })();
      await Promise.race([gone, delay(SWITCH_OFF_WAIT_MS)]);
    } else {
      await node?.stop();
    }
  } catch (err) {
    log(`the node did not stop cleanly: ${err?.stack ?? err}`);
  }
  await broker.stop().catch((err) => log(`the broker did not stop: ${err?.message ?? err}`));
  writeState();
  log('ended');
  bye(0);
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

function onListening() {
  try { fs.chmodSync(SOCKET_PATH, 0o600); } catch {}
  atomicWrite(DISCOVERY_PATH, {
    pid: process.pid, identity: procIdentity(process.pid), startedAt: new Date(startedAt * 1000).toISOString(), socket: SOCKET_PATH, version: 1,
  }, 0o600);
  log('daemon listening', SOCKET_PATH, 'pid', process.pid);

  const store = createStore({ dir: BASE_DIR, log });
  // The transport is made for the host's key, which the node would otherwise make itself.
  let identity = identityFromSeed(store.read('identity')?.seed ?? '');
  if (!identity) {
    identity = identityFromSeed(b64u(crypto.randomBytes(32)));
    store.write('identity', { seed: identity.seed });
    store.flush();
  }
  links = new Map((store.read('links')?.pools ?? []).map((pool) => [pool.id, pool]));
  node = createNode({
    store, transport: createTransport({ identity, log }), log, requester, executor,
    clock: { now: () => Math.floor(Date.now() / 1000), setTimeout, clearTimeout },
    random: (n) => crypto.randomBytes(n),
    settings: () => hours,
  });
  node.onChange(touch);
  // The transport comes up in the background: over Tor that takes minutes, and the
  // socket answers meanwhile.
  node.start().catch((err) => log(`the node did not start: ${err?.stack ?? err}`));
  startExecutor().catch((err) => log(`the executor side did not start: ${err?.stack ?? err}`));
  pollConfig();
  every(CONFIG_POLL_MS, pollConfig);
  every(STATE_WRITE_MS, watchExecutor);
  touch();
}

async function start() {
  fs.mkdirSync(BASE_DIR, { recursive: true, mode: 0o700 });
  if (await socketHealthy(SOCKET_PATH)) {
    const owner = readJson(DISCOVERY_PATH)?.pid;
    log(`another daemon${owner ? ` (pid ${owner})` : ''} is already live; exiting`);
    process.exit(0);
  }
  for (const file of [DISCOVERY_PATH, STATE_PATH, JOBS_PATH]) sweepDeadTmp(file);
  listenSingleton({ server, socketPath: SOCKET_PATH, log, onListening });
  process.on('SIGINT', () => onSignal('SIGINT'));
  process.on('SIGTERM', () => onSignal('SIGTERM'));
  // A promise nobody waited for must not take the daemon and its runs' watch down.
  process.on('unhandledRejection', (err) => log(`unhandled: ${err?.stack ?? err}`));
}

start();
