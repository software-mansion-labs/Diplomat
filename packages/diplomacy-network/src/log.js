// daemon.log as the daemon and the installer write it. Much of what they log carries
// words somebody else chose - a job's summary, another machine's reason, what a forge or
// the engine answered - and the log is read line by line, by people and in terminals.

import { createLog } from '../../daemon-core/src/log.js';

/// The most characters one part of an entry carries: more than any stack.
export const ENTRY_CHARS = 8000;

// Control characters but the newline, and the characters that break or reorder a line
// where it is shown.
const UNSEEN = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;

/// Text as part of one entry: a line that begins with a time is the writer's own, so
/// every further line is indented - a stack's already are - what would move a terminal's
/// cursor or hide what stands there is shown as `?`, and it is cut at ENTRY_CHARS.
export function entry(text) {
  const cut = text.length > ENTRY_CHARS ? `${text.slice(0, ENTRY_CHARS)}... (${text.length} characters)` : text;
  return cut.replace(UNSEEN, '?').replace(/\n(?=[^ \n])/g, '\n  ');
}

/// The log at `file`: `log(...parts)` appends one entry, the parts joined by spaces.
export function openLog(file) {
  const write = createLog(file);
  return (...parts) => write(...parts.map((part) => (typeof part === 'string' ? entry(part) : part)));
}
