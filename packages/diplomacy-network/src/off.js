// What the daemon and the installer both do: read the network's switch in Diplomat's
// config, remove what a machine that is switched off keeps nothing of, and find a job
// that finished while no daemon watched it.

import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { readJson } from '../../daemon-core/src/fsio.js';
import { unended } from './executor/job.js';
import { readOwn } from './executor/result.js';
import { CONFIG_PATH, OFF_REMOVES, RUNS_DIR } from './paths.js';

/// Diplomat's config as an object, or null while it cannot be read as one. Only a config
/// that can be read says that the network is off.
export function readConfig() {
  const config = readJson(CONFIG_PATH);
  return config !== null && typeof config === 'object' && !Array.isArray(config) ? config : null;
}

/// Removes what OFF_REMOVES names, each whatever becomes of the others, once nothing of
/// this machine's is left in docker. A job can leave among its run records what this
/// user may not delete: those go through `containers.eraseAll()`, container.js's, which
/// is given `withinMs`. Resolves to '' once all of it is gone, else to a sentence that
/// names what is left.
export async function clearAway(containers, withinMs) {
  const stays = (dir) => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return false;
    } catch {
      return true;
    }
  };
  let left = OFF_REMOVES.filter(stays);
  if (left.includes(RUNS_DIR)) {
    await Promise.race([containers.eraseAll(), delay(withinMs, null, { ref: false })]);
    left = left.filter(stays);
  }
  if (left.length === 0) return '';
  const records = left.includes(RUNS_DIR) ? ': a job left among its records what this user may not delete, and no docker engine deleted it' : '';
  return `${left.join(' and ')} could not be removed${records}. The next --stop-daemon tries again.`;
}

/// Of a run whose job ended by itself with no daemon watching it - its runner wrote its
/// exit code in `done`, which it does last - the run as `attachJob` takes it, `{ runId,
/// container }`, for `watch` or `readFinished` to read the outcome from what the job
/// left. Null for a job that wrote none, one whose outcome is on record and one this
/// process watches.
export async function finishedLeft(runId) {
  const left = unended().find((run) => run.runId === runId);
  const done = left ? await readOwn(path.join(left.container.runsDir, runId), 'done', 32) : null;
  return /^\d+\s*$/.test(done ?? '') ? left : null;
}
