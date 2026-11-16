// How this machine weighs a task against what it has. What a machine has is never
// told to anyone: the one thing that comes of it is how long this machine holds back
// before it goes for a task, so that one better placed gets there first. It refuses
// nothing: with nobody better placed, the task is taken here after the wait.
//
// What is weighed: work on an Android project wants a device, so a machine with none to
// give lets one that has a device go first.

import fs from 'node:fs';
import path from 'node:path';
import { DEVICE_WAIT_MS } from '../paths.js';

const GRADLE = ['build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts'];
// A checkout is looked at again this long after the last look.
const REREAD_MS = 3600 * 1000;

/// Whether the checkout at `dir` looks like Android work: an `android` directory, an
/// app manifest where Android Studio puts it, or a Gradle build at its root.
export function looksLikeAndroid(dir) {
  const at = (...parts) => { try { return fs.statSync(path.join(dir, ...parts)); } catch { return null; } };
  return !!at('android')?.isDirectory() || !!at('app', 'src', 'main', 'AndroidManifest.xml')?.isFile() || GRADLE.some((name) => !!at(name)?.isFile());
}

/// The executor's `weigh(task)`: how many more milliseconds this machine waits before
/// it goes for `task` (`{ pool, ... }`). `checkoutOf(pool)` is the pool's linked
/// checkout, or null; `hasDevice()` is whether a job started now would be given a device.
export function createWeighing({ checkoutOf, hasDevice, now = Date.now, waitMs = DEVICE_WAIT_MS }) {
  const seen = new Map(); // pool id -> { dir, android, at }
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
