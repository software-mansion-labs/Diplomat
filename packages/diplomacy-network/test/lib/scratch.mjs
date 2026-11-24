// A test's scratch directory, gone however the test ends: at its end, through
// process.exit, by a throw nothing catches, or by a signal.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { onInterrupt } from '../../../daemon-core/src/test-interrupt.js';

/// A new directory under `under`, named from `prefix`, removed when the process exits.
export function scratchDir(prefix, under = os.tmpdir()) {
  const dir = fs.mkdtempSync(path.join(under, prefix));
  const remove = () => fs.rmSync(dir, { recursive: true, force: true });
  // A signal skips the exit event unless something handles it.
  onInterrupt(remove);
  process.on('exit', remove);
  return dir;
}
