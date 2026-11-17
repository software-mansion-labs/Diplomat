import fs from 'node:fs';
import path from 'node:path';

/// What a log holds before it starts again: with the copy set aside, a log takes twice
/// this on disk at most.
export const LOG_MAX_BYTES = 16 * 1024 * 1024;

/// A line log, appended to by however many processes. One that has reached `maxBytes` is
/// copied to `<log>.1` over the copy before it and emptied in place, so a descriptor open
/// on it - a daemon's stderr - goes on writing to the log, and its mode stays.
export function createLog(logPath, maxBytes = LOG_MAX_BYTES) {
  try { fs.mkdirSync(path.dirname(logPath), { recursive: true }); } catch {}
  return function log(...args) {
    const parts = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a)));
    const line = `[${new Date().toISOString()}] ${parts.join(' ')}\n`;
    try {
      if (fs.statSync(logPath).size >= maxBytes) {
        // Emptied whether or not the copy could be made: the bound comes first.
        try { fs.copyFileSync(logPath, `${logPath}.1`); } catch {}
        fs.truncateSync(logPath);
      }
    } catch {}
    try { fs.appendFileSync(logPath, line); } catch {}
  };
}
