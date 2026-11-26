// Rate-limited logging for lines a job can trigger at will: the daemon's log keeps every
// line, so a job refused a thousand times a second would write a thousand lines a second.

export const LOG_TEXT_CHARS = 300;

export const LOG_EVERY_MS = 60 * 1000;

export function clip(text) {
  const printable = String(text).replace(/[^\x20-\x7e]/g, '?');
  return printable.length > LOG_TEXT_CHARS ? `${printable.slice(0, LOG_TEXT_CHARS)}... (${printable.length} characters)` : printable;
}

export function createSparingLog(log, { everyMs = LOG_EVERY_MS, now = Date.now } = {}) {
  const kinds = new Map();
  const untold = (left) => `(${left} more of the kind were not written)`;
  function say(kind, ...parts) {
    const last = kinds.get(kind);
    if (last && now() - last.at < everyMs) {
      last.left += 1;
      return;
    }
    kinds.set(kind, { at: now(), parts, left: 0 });
    log(...parts, ...(last?.left ? [untold(last.left)] : []));
  }
  say.end = (prefix) => {
    for (const [kind, last] of kinds) {
      if (!kind.startsWith(prefix)) continue;
      kinds.delete(kind);
      if (last.left) log(...last.parts, untold(last.left));
    }
  };
  return say;
}
