import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { readJson } from '../../daemon-core/src/fsio.js';
import { unended } from './executor/job.js';
import { readOwn } from './executor/result.js';
import { CONFIG_PATH, OFF_REMOVES, RUNS_DIR } from './paths.js';

/// Null while unreadable, which does not mean the network is off.
export function readConfig() {
  const config = readJson(CONFIG_PATH);
  return config !== null && typeof config === 'object' && !Array.isArray(config) ? config : null;
}

/// Call once docker holds nothing of this machine's. Run records this user may not
/// delete go through `containers.eraseAll()`, given `withinMs`. Resolves to '' once all
/// is gone, else to a sentence naming what is left.
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

/// A run whose job ended with no daemon watching (its runner writes the exit code to
/// `done` last), as `attachJob` takes it. Null if it wrote none, its outcome is on
/// record, or this process watches it.
export async function finishedLeft(runId) {
  const left = unended().find((run) => run.runId === runId);
  const done = left ? await readOwn(path.join(left.container.runsDir, runId), 'done', 32) : null;
  return /^\d+\s*$/.test(done ?? '') ? left : null;
}
