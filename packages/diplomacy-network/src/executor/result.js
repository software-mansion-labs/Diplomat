// What is read back of a run's directory, all of which its job can write. A file is
// read by a bounded piece from its end. The agent's log is the one piece of any size,
// and every shape its last megabytes can have is the job's to choose: a thread of its
// own reads and parses it, and hands back five members it made itself, each of a kind
// and a size that is checked there. The daemon's thread sees nothing else of the log.

import { once } from 'node:events';
import fs from 'node:fs';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';

const TAIL_BYTES = 4 * 2 ** 20;
const SUMMARY_CAP = 4000;
// The most a model's name is carried in (capability.js cuts a label there too).
const MODEL_CAP = 100;
// A line is parsed with fewer commas and opening brackets outside its strings than
// this, so with no more values. The agent's own result line has some dozens, and a few
// more for each model and each refused tool call. Parsed, a value takes many times the
// bytes it was written in, and 4 MiB can be written as two million of them.
const VALUES = 100000;
const { O_RDONLY, O_DIRECTORY, O_NOFOLLOW, O_NONBLOCK } = fs.constants;

/// A count or a sum: anything but a positive number is none.
export const figure = (v) => (Number.isFinite(v) && v > 0 ? v : 0);

/// The last `tail` bytes of the file `name` in the run directory `runDir`, as text, or
/// null. The directory is opened where the host put it, and only as a directory; the
/// file is named through that descriptor (by /proc on Linux, by the directory's own
/// number on a Mac), so a link put in the directory's place between the two leads
/// nowhere. The open does not wait for the writer a pipe in the file's place never has,
/// and the read is at a place and by a length, which a pipe, a device or a directory
/// has not to give.
export async function readOwn(runDir, name, tail) {
  let dir = null;
  let file = null;
  try {
    dir = await fs.promises.open(runDir, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
    const held = await dir.stat();
    const at = process.platform === 'linux' ? `/proc/self/fd/${dir.fd}` : `/.vol/${held.dev}/${held.ino}`;
    file = await fs.promises.open(`${at}/${name}`, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
    const { size } = await file.stat();
    const length = Math.min(size, tail);
    const { buffer } = await file.read(Buffer.alloc(length), 0, length, size - length);
    return buffer.toString('utf8');
  } catch { return null; } finally {
    await file?.close();
    await dir?.close();
  }
}

// Whether `line` has `most` or more commas and opening brackets outside its strings.
// In JSON every value but the first comes after one of them.
function crowded(line, most) {
  let seen = 0;
  let quoted = false;
  for (let i = 0; i < line.length && seen < most; i++) {
    const c = line.charCodeAt(i);
    if (quoted) {
      if (c === 92) i += 1;
      else if (c === 34) quoted = false;
    } else if (c === 34) quoted = true;
    else if (c === 44 || c === 91 || c === 123) seen += 1;
  }
  return seen >= most;
}

const plain = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

// How the agent writes that an event is its result. Only a line with these words is
// parsed: a line that fails to parse costs far more than one that parses, and 4 MiB
// hold four million lines but a quarter of a million of these.
const MARK = '"type":"result"';

// The last line of `log` that is a result event, as `readResult` resolves it, or null.
// Every member is the job's to shape: `modelUsage` counts when it is an object, and a
// member of it that is none counts for nothing.
function resultIn(log) {
  let event = null;
  for (let end = log.length; end > 0 && !event;) {
    const start = log.lastIndexOf('\n', end - 1) + 1;
    const line = log.slice(start, end);
    end = start - 1;
    if (!line.includes(MARK) || crowded(line, VALUES)) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed.type === 'result') event = parsed;
    } catch {}
  }
  if (!event) return null;
  const models = plain(event.modelUsage) ? Object.entries(event.modelUsage) : [];
  return {
    failed: event.is_error === true,
    summary: typeof event.result === 'string' ? event.result.slice(0, SUMMARY_CAP) : '',
    usd: figure(event.total_cost_usd),
    tokens: models.length > 0
      ? models.reduce((sum, [, u]) => sum + figure(u?.inputTokens) + figure(u?.outputTokens) + figure(u?.cacheReadInputTokens) + figure(u?.cacheCreationInputTokens), 0)
      : ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'].reduce((sum, k) => sum + figure(event.usage?.[k]), 0),
    model: (models.sort((a, b) => figure(b[1]?.costUSD) - figure(a[1]?.costUSD))[0]?.[0] || '').slice(0, MODEL_CAP),
  };
}

/// The result the agent left in the log of the run directory `runDir`, or null when the
/// last 4 MiB of the log hold none; a line with 100000 commas and opening brackets
/// outside its strings, or more, is none. Resolves to `{ failed, summary, usd, tokens,
/// model }`: whether the agent called it an error, its closing words cut at 4000
/// characters, the cost and the tokens it named (0 for a figure that is no positive
/// number), and the model most of the cost was named for, cut at 100 characters. Read
/// and made out on a thread of its own, so the caller's loop turns meanwhile whatever
/// the log holds; rejects when that thread fails.
export async function readResult(runDir) {
  const [result] = await once(new Worker(new URL(import.meta.url), { workerData: { dnResult: runDir } }), 'message');
  return result;
}

if (!isMainThread && workerData?.dnResult) {
  parentPort.postMessage(resultIn(await readOwn(workerData.dnResult, 'log.jsonl', TAIL_BYTES) ?? ''));
}
