// What this machine has goes in no message: it only sets how long this machine holds back
// before going for a task, so a better-placed peer gets there first. The wait is fixed, so
// a peer watching timing can still tell what this machine lacks. Android work wants a
// device.

import fs from 'node:fs';
import path from 'node:path';
import { DEVICE_WAIT_MS } from '../paths.js';

const GRADLE = ['build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts'];
const REREAD_MS = 3600 * 1000;

export function looksLikeAndroid(dir) {
  const at = (...parts) => { try { return fs.statSync(path.join(dir, ...parts)); } catch { return null; } };
  return !!at('android')?.isDirectory() || !!at('app', 'src', 'main', 'AndroidManifest.xml')?.isFile() || GRADLE.some((name) => !!at(name)?.isFile());
}

export function createWeighing({ checkoutOf, hasDevice, now = Date.now, waitMs = DEVICE_WAIT_MS }) {
  const seen = new Map();
  return function weigh(task) {
    const dir = checkoutOf(task.pool);
    if (!dir) return 0;
    let known = seen.get(task.pool);
    if (!known || known.dir !== dir || now() - known.at >= REREAD_MS) {
      known = { dir, android: looksLikeAndroid(dir), at: now() };
      seen.set(task.pool, known);
    }
    return known.android && !hasDevice() ? waitMs : 0;
  };
}
