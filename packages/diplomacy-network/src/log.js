import { createLog } from '../../daemon-core/src/log.js';

/// Per part of an entry; more than any stack.
export const ENTRY_CHARS = 8000;

// Control characters but \n, plus line separators and bidi controls.
const UNSEEN = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;

/// Logged text is often someone else's (a job's summary, a peer's reason, a forge's
/// answer): further lines are indented so only the writer's own start with a time,
/// what would move a terminal's cursor or hide text becomes `?`, and it is cut at
/// ENTRY_CHARS.
export function entry(text) {
  const cut = text.length > ENTRY_CHARS ? `${text.slice(0, ENTRY_CHARS)}... (${text.length} characters)` : text;
  return cut.replace(UNSEEN, '?').replace(/\n(?=[^ \n])/g, '\n  ');
}

export function openLog(file) {
  const write = createLog(file);
  return (...parts) => write(...parts.map((part) => (typeof part === 'string' ? entry(part) : part)));
}
