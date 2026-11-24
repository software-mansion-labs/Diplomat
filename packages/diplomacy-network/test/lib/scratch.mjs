// A test's scratch directories, gone however the test ends: at its end, through
// process.exit, by a throw nothing catches, or by a signal.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { onInterrupt } from '../../../daemon-core/src/test-interrupt.js';

const made = new Set();
const removeAll = () => {
  // Retried: a process killed just before can still be writing in one.
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 40, retryDelay: 100 });
};

/// A new directory under `under`, named from `prefix`, removed when the process exits.
export function scratchDir(prefix, under = os.tmpdir()) {
  if (made.size === 0) {
    process.on('exit', removeAll);
    // A signal ends the process through onInterrupt, so the exit event comes after every
    // handler a test registered there, which stop what writes in these directories.
    onInterrupt(() => {});
  }
  const dir = fs.mkdtempSync(path.join(under, prefix));
  made.add(dir);
  return dir;
}
