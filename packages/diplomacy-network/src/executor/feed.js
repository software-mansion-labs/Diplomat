// What node's http parser is given of a connection. The parser reads every request of
// what it is handed before anything can stop it, and makes a request and a response
// object for each, on the thread it is called on: 64 KiB of the shortest requests is
// 3640 of them in one call. So a connection's bytes reach it through a feed, in pieces
// that end where a request head does. The next piece is handed over only when whoever
// reads the connection asks for it, so a connection that was paused or closed over one
// request has no other read. A connection is handed one request head in a turn of the
// event loop, so one whose answer closes it has had no second request read by then; and
// all the feeds together hand over no more in one turn than fits a slice of time, however
// many connections have bytes waiting.

import { Duplex } from 'node:stream';

/// The time the feeds of one feeder hand bytes over for in one turn of the event loop
/// before they leave the rest to the next turn.
export const FEED_TURN_MS = 4;

const LF = 10;
const CR = 13;

/// How bytes that end in `piece` end, given how the bytes before it ended: 1 for a line
/// feed, 2 for a line feed and a carriage return, 0 for anything else.
export function edgeAfter(piece, edge) {
  const last = piece[piece.length - 1];
  if (last === LF) return 1;
  const before = piece.length > 1 ? piece[piece.length - 2] === LF : edge === 1;
  return last === CR && before ? 2 : 0;
}

/// Where the first request head that ends in `buf` ends: the offset past the first empty
/// line, whether its lines end in a line feed alone or after a carriage return, or -1
/// when no head ends in it. `edge` is how the bytes before `buf` ended, as edgeAfter
/// states it: an empty line may lie across the two.
export function headEnd(buf, edge = 0) {
  if (edge !== 0 && buf[0] === LF) return 1;
  if (edge === 1 && buf[0] === CR && buf[1] === LF) return 2;
  for (let i = buf.indexOf(LF); i !== -1 && i + 1 < buf.length; i = buf.indexOf(LF, i + 1)) {
    if (buf[i + 1] === LF) return i + 2;
    if (buf[i + 1] === CR && buf[i + 2] === LF) return i + 3;
  }
  return -1;
}

/// Makes feeds that share one slice of each turn: `feed(source, first)` is a Duplex
/// that node's http server takes as a connection ('connection' may be emitted with any
/// Duplex). It reads `source` (a socket, or the terminated connection inside one), after
/// the bytes `first` that were read off `source` already, and writes to it. Closing
/// either closes the other. `turnMs` and `now` replace the slice and the clock.
export function createFeeder({ turnMs = FEED_TURN_MS, now = () => performance.now() } = {}) {
  let began = null; // when the feeds first handed bytes over in this turn
  let turn = 0;
  const waiting = new Set(); // the pumps of feeds that have bytes and no time left in this turn

  function nextTurn() {
    began = null;
    turn += 1;
    const due = [...waiting];
    waiting.clear();
    for (const pump of due) pump();
  }

  // Whether this turn's slice is used up. The first to ask in a turn starts its clock.
  function usedUp() {
    if (began === null) {
      began = now();
      setImmediate(nextTurn);
      return false;
    }
    return now() - began >= turnMs;
  }

  return function feed(source, first = null) {
    let held = first?.length ? first : null; // read off the source, not handed on yet
    let edge = 0;
    let wanted = false; // the reader asked for a piece and has had none since
    let ended = false;
    let last = false;
    let headIn = -1; // the turn it last handed the end of a request head over in

    function pump() {
      while (wanted && !last && !out.destroyed) {
        if (!held) {
          if (ended) {
            wanted = false;
            out.push(null);
          } else source.resume();
          return;
        }
        if (usedUp()) {
          waiting.add(pump);
          return;
        }
        const end = headEnd(held, edge);
        if (end !== -1) {
          if (headIn === turn) {
            waiting.add(pump);
            return;
          }
          headIn = turn;
        }
        const piece = end === -1 ? held : held.subarray(0, end);
        held = piece.length < held.length ? held.subarray(end) : null;
        edge = edgeAfter(piece, edge);
        wanted = false;
        out.push(piece);
      }
    }

    const out = new Duplex({
      // Nothing is read ahead: a paused feed holds one piece and no more.
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
    // As a socket has it: closed once what was written has gone out.
    out.destroySoon = () => {
      out.end();
      if (out.writableFinished) out.destroy();
      else out.once('finish', () => out.destroy());
    };
    // A stream that was resumed is flowing at once and says so a tick later, and what
    // it holds is handed on between the two. So a stopped feed takes a reader's resume
    // as a wish, to be met when the feed is started.
    let stopped = false;
    let flows = false; // while stopped: whether its reader would have it flow
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
    /// Hands nothing on from now, whatever its reader does, until it is started.
    out.stop = () => {
      if (stopped) return;
      flows = !out.isPaused();
      stopped = true;
      pause.call(out);
    };
    /// Ends a stop. A feed its reader paused, before the stop or during it, stays paused.
    out.start = () => {
      stopped = false;
      if (flows) resume.call(out);
    };
    /// Hands nothing more on, ever: the request it handed on last is its connection's last.
    out.last = () => { last = true; };
    // The time a connection may stay silent is kept by the socket that carries it.
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
