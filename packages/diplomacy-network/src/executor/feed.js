// Node's http parser handles every request in what it is given before anything can stop
// it, building objects on this thread for each request and each body chunk (64 KiB holds
// 3640 minimal requests; a chunked-coding chunk can be one byte in six). So a feed hands
// it at most FEED_PIECE_BYTES, cut at a request head's end, and only when the reader asks;
// body bytes only while their request is read; one request head per connection per turn,
// so a response that closes the connection has had no second request read; and all
// feeds of a feeder share one time slice per turn.

import { Duplex } from 'node:stream';

export const FEED_TURN_MS = 4;

export const FEED_PIECE_BYTES = 4096;

const LF = 10;
const CR = 13;

/// 1: the bytes so far end in LF; 2: in LF CR; 0: otherwise.
export function edgeAfter(piece, edge) {
  const last = piece[piece.length - 1];
  if (last === LF) return 1;
  const before = piece.length > 1 ? piece[piece.length - 2] === LF : edge === 1;
  return last === CR && before ? 2 : 0;
}

/// The offset past the first empty line (LF or CRLF) in `buf`, or -1. `edge` is
/// edgeAfter of the bytes before: an empty line may straddle the two.
export function headEnd(buf, edge = 0) {
  if (edge !== 0 && buf[0] === LF) return 1;
  if (edge === 1 && buf[0] === CR && buf[1] === LF) return 2;
  for (let i = buf.indexOf(LF); i !== -1 && i + 1 < buf.length; i = buf.indexOf(LF, i + 1)) {
    if (buf[i + 1] === LF) return i + 2;
    if (buf[i + 1] === CR && buf[i + 2] === LF) return i + 3;
  }
  return -1;
}

/// `feed(source, first)` is a Duplex to emit as an http server 'connection', reading
/// `source` after the bytes `first` already read off it.
export function createFeeder({ turnMs = FEED_TURN_MS, now = () => performance.now() } = {}) {
  let began = null;
  let turn = 0;
  const waiting = new Set(); // pumps out of time this turn

  function nextTurn() {
    began = null;
    turn += 1;
    const due = [...waiting];
    waiting.clear();
    for (const pump of due) pump();
  }

  function usedUp() {
    if (began === null) {
      began = now();
      setImmediate(nextTurn);
      return false;
    }
    return now() - began >= turnMs;
  }

  return function feed(source, first = null) {
    let held = first?.length ? first : null;
    let edge = 0;
    let wanted = false; // the reader asked and has had no piece since
    let ended = false;
    let last = false;
    let headIn = -1; // turn of the last request head handed over
    let body = null;

    const unread = () => body !== null && !body.complete && body.readableFlowing !== true;

    function pump() {
      while (wanted && !last && !out.destroyed) {
        // Before unread(): one chunk is read ahead even of an unread body, so an end is seen.
        if (!held) {
          if (ended) {
            wanted = false;
            out.push(null);
          } else source.resume();
          return;
        }
        if (unread()) return;
        if (usedUp()) {
          waiting.add(pump);
          return;
        }
        const next = held.length > FEED_PIECE_BYTES ? held.subarray(0, FEED_PIECE_BYTES) : held;
        const end = headEnd(next, edge);
        if (end !== -1) {
          if (headIn === turn) {
            waiting.add(pump);
            return;
          }
          headIn = turn;
        }
        const piece = end === -1 ? next : next.subarray(0, end);
        held = piece.length < held.length ? held.subarray(piece.length) : null;
        edge = edgeAfter(piece, edge);
        wanted = false;
        out.push(piece);
      }
    }

    const out = new Duplex({
      // A paused feed holds one piece and no more.
      readableHighWaterMark: 0,
      read() {
        wanted = true;
        pump();
      },
      write(chunk, encoding, done) { source.write(chunk, encoding, done); },
      writev(chunks, done) {
        source.cork();
        chunks.forEach(({ chunk, encoding }, i) => source.write(chunk, encoding, i === chunks.length - 1 ? done : undefined));
        source.uncork();
      },
      final(done) { source.end(done); },
      destroy(err, done) {
        source.destroy();
        done(err);
      },
    });
    out.on('error', () => {});
    // http calls this on its sockets: close once what was written has gone out.
    out.destroySoon = () => {
      out.end();
      if (out.writableFinished) out.destroy();
      else out.once('finish', () => out.destroy());
    };
    // A resumed stream flows at once but reports it a tick later, handing on what it holds
    // in between, so while stopped a reader's resume is only recorded, for start().
    let stopped = false;
    let flows = false; // while stopped: whether the reader wants it flowing
    const { pause, resume } = out;
    out.pause = () => {
      flows = false;
      return pause.call(out);
    };
    out.resume = () => {
      if (!stopped) return resume.call(out);
      flows = true;
      return out;
    };
    /// Hands nothing on, whatever its reader does, until start().
    out.stop = () => {
      if (stopped) return;
      flows = !out.isPaused();
      stopped = true;
      pause.call(out);
    };
    /// A feed its reader paused, before the stop or during it, stays paused.
    out.start = () => {
      stopped = false;
      if (flows) resume.call(out);
    };
    /// The request handed on last is the connection's last.
    out.last = () => { last = true; };
    /// The next bytes are the body of `req` and wait while it is not read.
    out.bodyOf = (req) => {
      body = req;
      req.on('resume', pump);
    };
    // The carrying socket keeps the idle timeout.
    out.setTimeout = (ms, fn) => {
      if (fn) out.once('timeout', fn);
      source.setTimeout(ms);
      return out;
    };

    source.pause();
    source.on('data', (chunk) => {
      held = held ? Buffer.concat([held, chunk]) : chunk;
      source.pause();
      pump();
    });
    source.on('end', () => {
      ended = true;
      pump();
    });
    source.on('timeout', () => out.emit('timeout'));
    source.on('close', () => out.destroy());
    return out;
  };
}
