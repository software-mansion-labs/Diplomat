// A log for the lines a job can cause as often as it likes: the daemon's log appends
// every line it is given, and a job that is refused a thousand times a second is a
// thousand lines a second.

/// The most of a job's own words one log line carries.
export const LOG_TEXT_CHARS = 300;

/// A line of one kind is written this often and no more.
export const LOG_EVERY_MS = 60 * 1000;

/// Text a job had a say in, for a log line: printable, and cut to LOG_TEXT_CHARS.
export function clip(text) {
  const printable = String(text).replace(/[^\x20-\x7e]/g, '?');
  return printable.length > LOG_TEXT_CHARS ? `${printable.slice(0, LOG_TEXT_CHARS)}... (${printable.length} characters)` : printable;
}

/// `say(kind, ...parts)` gives `parts` to `log` for the first line of its kind and then
/// for one every `everyMs`, which also says how many were left out since the last one
/// written. `say.end(prefix)` forgets every kind that starts with `prefix`, and writes
/// for each how many lines were left out and not yet told of.
export function createSparingLog(log, { everyMs = LOG_EVERY_MS, now = Date.now } = {}) {
  const kinds = new Map(); // kind -> { at, parts, left }
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
