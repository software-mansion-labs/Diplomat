#!/usr/bin/env node
// What the applets run to start and stop the daemon. Each flag prints one JSON object:
//   node src/install.js --check          -> { installed, daemonRunning, pid }
//   node src/install.js --start-daemon   -> { ok, daemonRunning, pid, error? }
//   node src/install.js --restart-daemon -> the same, after replacing a running daemon
//   node src/install.js --stop-daemon    -> the same, once the daemon is gone; with the
//                                           network switched off in Diplomat's config,
//                                           what the daemon made in docker is gone too,
//                                           and with it what OFF_REMOVES names
// Nothing is installed anywhere: `installed` is true wherever this file runs, and is in
// the answer because the applets read every installer's `--check` alike. Every flag is
// answered within INSTALLER_ANSWER_MS.

import fs from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { daemonControl } from '../../daemon-core/src/daemon-control.js';
import { pidAlive, readJson } from '../../daemon-core/src/fsio.js';
import { createContainers } from './executor/container.js';
import * as client from './ipc.js';
import { CONFIG_PATH, DISCOVERY_PATH, INSTALLER_ANSWER_MS, OFF_REMOVES, STOP_WAIT_MS, TOOL_PATH } from './paths.js';

// docker is looked for where the daemon looks for it.
process.env.PATH = TOOL_PATH;

const answerBy = Date.now() + INSTALLER_ANSWER_MS;
const { startDaemon, stopDaemon } = daemonControl({ client, discoveryPath: DISCOVERY_PATH, restartExitMs: STOP_WAIT_MS });

const running = async () => (await client.daemonHealth())?.pid ?? null;

// An error message, or null once a daemon answers.
async function start() {
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

// A daemon that is switched off removes what it made in docker as it ends, and then
// what OFF_REMOVES names. One that was not there to be stopped, was killed past its end
// or found the engine not answering left that standing, so it is done here again. Like
// the daemon, this takes only a config it can read for the network being off.
async function stopForGood() {
  const error = await stop();
  const config = readJson(CONFIG_PATH);
  if (error || config === null || typeof config !== 'object' || config.networkEnabled === true) return error;
  const late = delay(Math.max(0, answerBy - Date.now()), 'the docker engine did not answer in time');
  const left = await Promise.race([createContainers().removeAll().then(() => null), late]);
  if (left !== null) return `the daemon is gone, but what it made in docker is still there: ${left}`;
  for (const dir of OFF_REMOVES) fs.rmSync(dir, { recursive: true, force: true });
  return null;
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
// The answer ends the process: a docker that was asked and has not answered must not
// keep it past the time the applets wait.
process.stdout.write(`${JSON.stringify(out, null, 2)}\n`, () => process.exit(0));
