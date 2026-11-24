#!/usr/bin/env node
// What the applets run to start and stop the daemon. Each flag prints one JSON object:
//   node src/install.js --check          -> { installed, daemonRunning, pid }
//   node src/install.js --start-daemon   -> { ok, daemonRunning, pid, error? }; with the
//                                           network switched off in Diplomat's config
//                                           none is started, and `error` says so
//   node src/install.js --restart-daemon -> the same, after replacing a running daemon
//   node src/install.js --stop-daemon    -> the same, once the daemon is gone; with the
//                                           network switched off in Diplomat's config,
//                                           also `ended: { offers, runs }`, what was
//                                           left for this to end as a switch-off does,
//                                           and what the daemon made in docker is gone
//                                           too, and with it what OFF_REMOVES names
// Nothing is installed anywhere: `installed` is true wherever this file runs, and is in
// the answer because the applets read every installer's `--check` alike. Every flag is
// answered within INSTALLER_ANSWER_MS.

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

// docker is looked for where the daemon looks for it.
process.env.PATH = TOOL_PATH;

const answerBy = Date.now() + INSTALLER_ANSWER_MS;
const { startDaemon, stopDaemon } = daemonControl({ client, discoveryPath: DISCOVERY_PATH, restartExitMs: STOP_WAIT_MS });

const running = async () => (await client.daemonHealth())?.pid ?? null;

// An error message, or null once a daemon answers. With the network switched off none is
// started: a daemon that starts then switches itself off and goes, and would be waited
// for as one that is slow to answer.
async function start() {
  const config = readConfig();
  if (config && config.networkEnabled !== true) return 'the network is switched off in Diplomat\'s settings: no daemon was started';
  const { error } = await startDaemon();
  if (!error) return null;
  // Only a start that ran out of time is waited for, for the time there is left: a
  // daemon that was slow to answer is still the daemon that was started. One that
  // failed has said why.
  if (!error.endsWith('daemon failed to start')) return error;
  for (; Date.now() < answerBy; await delay(250)) {
    if (await running()) return null;
  }
  return error;
}

// An error message, or null once no daemon is left. The daemon ends by itself: a
// switched-off one tells its pools first, so it is given STOP_WAIT_MS.
async function stop() {
  const pid = await stopDaemon();
  for (const deadline = Date.now() + STOP_WAIT_MS; pid && pidAlive(pid) && Date.now() < deadline;) await delay(100);
  return pid && pidAlive(pid) ? `the daemon (pid ${pid}) did not exit within ${STOP_WAIT_MS / 1000} s` : null;
}

// What a switch-off found left to end with no daemon running: `{ offers, runs }`.
let ended = null;

// A daemon that was not running when the network was switched off cancelled nothing it
// offered and gave back nothing it ran: switched on again it would offer work Diplomat
// has since started elsewhere. That is ended here, in its store, which is this
// process's for as long as it holds the daemon's socket; while a daemon has the socket
// or is taking it, the ending is that daemon's. A run whose job ended with no daemon
// left to tell the node, under one that died or under none, ends as that job did. An
// error message, or null.
async function endStored() {
  // No daemon ever ran here: there is no store.
  if (!fs.existsSync(BASE_DIR)) return null;
  let release = null;
  try {
    release = await holdSocket(SOCKET_PATH);
    if (!release) return null;
    const log = openLog(LOG_PATH);
    const kept = readJson(JOBS_PATH)?.jobs ?? {};
    // A job that finished with no daemon watching has its outcome read from what it left,
    // its share of the model as jobs.json last had it, and the engine is asked nothing:
    // whatever the job left running goes with its container. One that cannot be read is
    // stopped and given back like the rest.
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

// A daemon that is switched off ends what it offered and ran, removes what it made in
// docker, and then what OFF_REMOVES names. One that was not there to be stopped, was
// killed past its end or found the engine down left some of that standing, so it is
// done here again, the engine asked again until the answer is due: an engine that is
// starting takes a while to answer. A store that could not be ended in keeps nothing in
// docker standing, and is the error once docker is clear. Like the daemon, this takes
// only a config it can read for the network being off.
async function stopForGood() {
  const error = await stop();
  const config = readConfig();
  if (error || config === null || config.networkEnabled === true) return error;
  const unended = await endStored();
  const containers = createContainers();
  const late = delay(Math.max(0, answerBy - Date.now()), 'the docker engine did not answer in time');
  // What the engine last said outlives an asking that the answer's time cut short.
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
// The answer ends the process: a docker that was asked and has not answered must not
// keep it past the time the applets wait.
process.stdout.write(`${JSON.stringify(out, null, 2)}\n`, () => process.exit(0));
