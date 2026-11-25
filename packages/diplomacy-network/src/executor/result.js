// Reading back a run's directory, all of which its job can write. The agent's log is the
// one large input and its shape is the job's to choose, so a worker thread parses its
// tail and hands back only five members it built and checked itself.

import { once } from 'node:events';
import fs from 'node:fs';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';

const TAIL_BYTES = 4 * 2 ** 20;
const SUMMARY_CAP = 4000;
// capability.js cuts a label at this length too.
const MODEL_CAP = 100;
// A line with this many values or more is not parsed: a parsed value takes many times its
// written bytes, and 4 MiB can hold two million. A real result line has some dozens.
const VALUES = 100000;
const { O_RDONLY, O_DIRECTORY, O_NOFOLLOW, O_NONBLOCK } = fs.constants;

export const figure = (v) => (Number.isFinite(v) && v > 0 ? v : 0);

/// The last `tail` bytes of `name` in `runDir`, or null. The file is opened through a
/// descriptor on the directory (/proc on Linux, /.vol on a Mac), so a link swapped in for
/// the directory leads nowhere; O_NONBLOCK keeps a FIFO from hanging the open, and the
/// positioned read fails on a pipe, device or directory.
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

// Counts commas and opening brackets outside strings: in JSON every value but the first
// follows one.
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

// Only lines with this are parsed: a failed parse costs far more than a good one, and
// 4 MiB holds four million lines but a quarter of a million of these.
const MARK = '"type":"result"';

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

/// The agent's last result event in the run's log, or null. On a worker, so the caller's
/// loop turns whatever the log holds.
export async function readResult(runDir) {
  const [result] = await once(new Worker(new URL(import.meta.url), { workerData: { dnResult: runDir } }), 'message');
  return result;
}

if (!isMainThread && workerData?.dnResult) {
  parentPort.postMessage(resultIn(await readOwn(workerData.dnResult, 'log.jsonl', TAIL_BYTES) ?? ''));
}
