#!/usr/bin/env node
// What the applets run. Each flag prints one JSON object within INSTALLER_ANSWER_MS:
//   --check          -> { installed, daemonRunning, pid }
//   --start-daemon   -> { ok, daemonRunning, pid, error? }; none is started while the
//                       network is off in Diplomat's config
//   --restart-daemon -> the same, after replacing a running daemon
//   --stop-daemon    -> the same, once the daemon is gone; while the network is off, also
//                       `ended: { offers, runs }` (what this ended in the daemon's
//                       place), and docker and OFF_REMOVES are cleared
// `installed` is always true (nothing is installed): the applets read every
// installer's `--check` alike.

import fs from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { daemonControl } from '../../daemon-core/src/daemon-control.js';
import { pidAlive, readJson } from '../../daemon-core/src/fsio.js';
import { holdSocket } from '../../daemon-core/src/serve.js';
import { createContainers } from './executor/container.js';
import { readFinished, readOutcome } from './executor/job.js';
import * as client from './ipc.js';
import { openLog } from './log.js';
import { switchOffStored } from './node/offline.js';
import { clearAway, finishedLeft, readConfig } from './off.js';
import { createStore } from './node/store.js';
import {
  BASE_DIR, DISCOVERY_PATH, EXECUTOR_RETRY_MS, INSTALLER_ANSWER_MS, JOBS_PATH, LOG_PATH, SOCKET_PATH, STOP_WAIT_MS, TOOL_PATH,
} from './paths.js';

// Find docker where the daemon does.
process.env.PATH = TOOL_PATH;

const answerBy = Date.now() + INSTALLER_ANSWER_MS;
const { startDaemon, stopDaemon } = daemonControl({ client, discoveryPath: DISCOVERY_PATH, restartExitMs: STOP_WAIT_MS });

const running = async () => (await client.daemonHealth())?.pid ?? null;

// An error message, or null once a daemon answers. None is started while the network is
// off: it would switch itself off and exit, and be waited for as a slow start.
async function start() {
  const config = readConfig();
  if (config && config.networkEnabled !== true) return 'the network is switched off in Diplomat\'s settings: no daemon was started';
  const { error } = await startDaemon();
  if (!error) return null;
  // A start that timed out may only be slow: wait out the time left.
  if (!error.endsWith('daemon failed to start')) return error;
  for (; Date.now() < answerBy; await delay(250)) {
    if (await running()) return null;
  }
  return error;
}

// An error message, or null once no daemon is left. A switched-off daemon tells its
// pools before it exits, hence STOP_WAIT_MS.
async function stop() {
  const pid = await stopDaemon();
  for (const deadline = Date.now() + STOP_WAIT_MS; pid && pidAlive(pid) && Date.now() < deadline;) await delay(100);
  return pid && pidAlive(pid) ? `the daemon (pid ${pid}) did not exit within ${STOP_WAIT_MS / 1000} s` : null;
}

let ended = null;

// A daemon not running at switch-off ended none of its offers and runs: switched on
// again it would offer work Diplomat has since started elsewhere. So they are ended here,
// in its store, while this holds its socket; a daemon that has the socket ends them
// itself. An error message, or null.
async function endStored() {
  if (!fs.existsSync(BASE_DIR)) return null;
  let release = null;
  try {
    release = await holdSocket(SOCKET_PATH);
    if (!release) return null;
    const log = openLog(LOG_PATH);
    const kept = readJson(JOBS_PATH)?.jobs ?? {};
    // A job that finished unwatched ends with the outcome it left and the model spend
    // jobs.json last had; one that cannot be read is stopped and given back.
    const outcomeOf = async (runId) => {
      const ended = readOutcome(runId);
      if (ended) return ended;
      const left = await finishedLeft(runId);
      const was = Object.hasOwn(kept, runId) ? kept[runId] : null;
      return left ? readFinished({ runId, container: left.container, spent: () => was?.spent ?? null }).catch(() => null) : null;
    };
    const { offers, runs, reported } = await switchOffStored({ store: createStore({ dir: BASE_DIR, log }), log, outcomeOf });
    ended = { offers, runs };
    log(`the network is switched off and no daemon runs: ${offers} offer(s) cancelled, ${runs - reported} run(s) stopped and given back${reported > 0 ? `, ${reported} run(s) ended as the job that had finished left it` : ''}`);
    return null;
  } catch (err) {
    return `what this machine offered and ran could not be ended in its store: ${err?.message ?? err}`;
  } finally {
    await release?.();
  }
}

// Redoes a switched-off daemon's cleanup (its store, docker, then OFF_REMOVES), which a
// daemon that was absent, killed or engine-less left undone. The engine is retried until
// the answer is due, as a starting one is slow. A store that could not be ended does not
// stop docker being cleared; it is the error after.
async function stopForGood() {
  const error = await stop();
  const config = readConfig();
  if (error || config === null || config.networkEnabled === true) return error;
  const unended = await endStored();
  const containers = createContainers();
  const late = delay(Math.max(0, answerBy - Date.now()), 'the docker engine did not answer in time');
  // So an attempt the deadline cut short still reports the engine's last error.
  let said = null;
  for (;;) {
    const left = await Promise.race([containers.removeAll().then(() => null, (err) => { said = String(err?.message ?? err); return said; }), late]);
    if (left === null) {
      const kept = await clearAway(containers, Math.max(0, answerBy - Date.now()));
      return unended ?? (kept || null);
    }
    if (Date.now() + EXECUTOR_RETRY_MS >= answerBy) return `the daemon is gone, but what it made in docker is still there: ${said ?? left}`;
    await delay(EXECUTOR_RETRY_MS);
  }
}

const actions = {
  '--start-daemon': start,
  '--stop-daemon': stopForGood,
  '--restart-daemon': async () => (await stop()) ?? start(),
};

const flag = process.argv[2] || '--check';
let out;
if (Object.hasOwn(actions, flag)) {
  let error;
  try {
    error = await actions[flag]();
  } catch (err) {
    error = err?.message || String(err);
  }
  const pid = await running();
  out = { ok: !error, daemonRunning: pid !== null, pid, ...(error ? { error } : {}), ...(ended ? { ended } : {}) };
} else {
  const pid = await running();
  out = { installed: true, daemonRunning: pid !== null, pid };
}
// Exit: a docker call still pending must not outlive the applets' wait.
process.stdout.write(`${JSON.stringify(out, null, 2)}\n`, () => process.exit(0));
