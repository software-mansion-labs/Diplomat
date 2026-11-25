import fs from 'node:fs';
import path from 'node:path';

/// With its `.1` copy, a log takes at most twice this on disk.
export const LOG_MAX_BYTES = 16 * 1024 * 1024;

/// A line log any number of processes append to. At `maxBytes` it is copied to
/// `<log>.1` and truncated in place, so a descriptor open on it (a daemon's stderr) keeps
/// writing to the log, and its mode stays.
export function createLog(logPath, maxBytes = LOG_MAX_BYTES) {
  try { fs.mkdirSync(path.dirname(logPath), { recursive: true }); } catch {}
  return function log(...args) {
    const parts = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a)));
    const line = `[${new Date().toISOString()}] ${parts.join(' ')}\n`;
    try {
      if (fs.statSync(logPath).size >= maxBytes) {
        // Even when the copy failed: the bound comes first.
        try { fs.copyFileSync(logPath, `${logPath}.1`); } catch {}
        fs.truncateSync(logPath);
      }
    } catch {}
    try { fs.appendFileSync(logPath, line); } catch {}
  };
}
