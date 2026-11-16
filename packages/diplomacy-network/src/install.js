#!/usr/bin/env node
// What the applets run to start and stop the daemon. Each flag prints one JSON object:
//   node src/install.js --check          -> { installed, daemonRunning, pid }
//   node src/install.js --start-daemon   -> { ok, daemonRunning, pid, error? }
//   node src/install.js --restart-daemon -> the same, after replacing a running daemon
//   node src/install.js --stop-daemon    -> the same, once the daemon is gone; with the
//                                           network switched off in Diplomat's config,
//                                           the daemon's containers are gone too
// Nothing is installed anywhere: `installed` is true wherever this file runs, and is in
// the answer because the applets read every installer's `--check` alike.

import { setTimeout as delay } from 'node:timers/promises';
import { daemonControl } from '../../daemon-core/src/daemon-control.js';
import { pidAlive, readJson } from '../../daemon-core/src/fsio.js';
import { createContainers } from './executor/container.js';
import * as client from './ipc.js';
import { CONFIG_PATH, DISCOVERY_PATH, STOP_WAIT_MS } from './paths.js';

const { startDaemon, stopDaemon } = daemonControl({ client, discoveryPath: DISCOVERY_PATH, restartExitMs: STOP_WAIT_MS });

// A daemon that was slow to answer is still the daemon that was started.
const START_WAIT_MS = 60 * 1000;

const running = async () => (await client.daemonHealth())?.pid ?? null;

// An error message, or null once a daemon answers.
async function start() {
  const { error } = await startDaemon();
  if (!error) return null;
  // Only a start that ran out of time is waited for; one that failed has said why.
  if (!error.endsWith('daemon failed to start')) return error;
  for (const deadline = Date.now() + START_WAIT_MS; Date.now() < deadline; await delay(250)) {
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

// A daemon that is switched off removes what it made in docker as it ends. One that was
// not there to be stopped, or was killed past its end, left that standing. Like the
// daemon, this takes only a config it can read for the network being off.
async function stopForGood() {
  const error = await stop();
  const config = readJson(CONFIG_PATH);
  if (!error && config !== null && typeof config === 'object' && config.networkEnabled !== true) await createContainers().removeAll();
  return error;
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
  out = { ok: !error, daemonRunning: pid !== null, pid, ...(error ? { error } : {}) };
} else {
  const pid = await running();
  out = { installed: true, daemonRunning: pid !== null, pid };
}
process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
