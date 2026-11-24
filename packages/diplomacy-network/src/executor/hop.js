// The hop between a job container's relay and the broker. It is the part of a job's
// connection whose socket buffers are this machine's: the broker's end and, through
// Docker Desktop, the end Docker opens for the relay on the Mac; on Linux the relay's
// end is this machine's kernel as well. Left to TCP, each end grows its buffers to
// megabytes, as much as the job keeps unread on either side, and node can set no limit
// on them. So the relay (image/relay.mjs) carries a connection in frames, and neither
// side sends more than the other has made room for: the broker grants the relay what
// it may send, and sends the relay only so much that is not yet passed on to the job.
// What is on the hop is then counted here, for every connection of every job at once,
// against a fixed total.
//
// A frame is a type byte, a length of four bytes (big-endian) and, for DATA, that many
// bytes of the connection. The relay opens with PREFACE, which no HTTP request begins
// with, and then sends DATA, END, ASK and ACK; the broker sends DATA, END and CREDIT.
//   DATA   bytes of the connection; from the relay, no more than the broker granted
//   END    the connection's bytes this way have ended
//   ASK    the relay has <length> bytes waiting and no room granted for them
//   CREDIT the relay may send <length> more bytes
//   ACK    the relay has passed <length> of the broker's bytes on to the job

import { Duplex } from 'node:stream';

export const PREFACE = Buffer.from([0, 0x64, 0x6e, 1]);
export const DATA = 0;
export const END = 1;
export const ASK = 2;
export const CREDIT = 3;
export const ACK = 5;
const HEADER_BYTES = 5;

/// The most bytes one DATA frame of the broker's carries, and the fewest that room is
/// made for at a time when more are waiting.
export const FRAME_BYTES = 64 * 1024;
const LEAST_BYTES = 2 * 1024;
// What a connection's bytes are kept in while nothing takes them: copied together, so that
// however small the frames they came in, they cost the daemon about what they count.
const STASH_BYTES = 16 * 1024;
/// How long an ended hop waits for the relay to end its side before it is closed.
export const HOP_LINGER_MS = 5000;

/// What one connection may have on its way each way: granted to the relay and read by
/// the broker but not yet passed on, and sent but not yet passed on to the job. A
/// connection whose first request has not named a job gets HOP_STRANGER_WINDOW.
export const HOP_WINDOW = 128 * 1024;
export const HOP_STRANGER_WINDOW = 2 * 1024;

/// What is on the hop at once - granted to relays and not yet come, and sent to them
/// and not yet passed on - for the connections of all jobs, shared out equally among
/// the jobs admitted, and for those that are no job's.
export const HOP_JOB_BYTES = 14 * 1024 * 1024;
export const HOP_STRANGER_BYTES = 2 * 1024 * 1024;

/// A job that has kept more than its share on the hop for this long, while another job
/// has been held back by it as long, loses the connections that hold the most of it
/// until it is within its share, and none that hold nothing, which would free nothing.
/// A job gets no room while it is past its share, so one whose connections are read is
/// within it as soon as what it was sent is.
export const HOP_RECLAIM_MS = 2000;

/// `createHop()` makes the count shared by every connection that comes in frames:
/// `framed(raw, first)` is the Duplex the connection's bytes come out of and go into,
/// counted as no job's, `raw` the socket the frames come on, `first` what was read of it
/// already. `admit(job)` gives a job its share until `leave(job)`, and `seat(link, job)`
/// counts a link as that job's from then on. `held(job)` is what a job's connections
/// have on the hop, and `held()` `{ jobs, strangers }`.
export function createHop({ jobBytes = HOP_JOB_BYTES, strangerBytes = HOP_STRANGER_BYTES, window = HOP_WINDOW, strangerWindow = HOP_STRANGER_WINDOW, reclaimMs = HOP_RECLAIM_MS, lingerMs = HOP_LINGER_MS } = {}) {
  const groups = {
    jobs: { held: 0, limit: jobBytes },
    strangers: { held: 0, limit: strangerBytes },
  };
  const strangers = { group: groups.strangers, held: 0, links: new Set(), window: strangerWindow };
  const jobs = new Map(); // job -> its bucket, while it is admitted
  // Links held back by what the others have on the hop, and not by their own window.
  const waiting = new Set();
  let waking = false;
  // A wake is handing out room: the links it woke are out of `waiting` until each has
  // gone, so the reclaim is reckoned once it is over.
  let going = false;
  let reclaim = null;

  const shareOf = (bucket) => (bucket === strangers ? strangerBytes : Math.floor(jobBytes / jobs.size));

  // Since when a job has been past its share as it is now.
  function judge(bucket, now = Date.now()) {
    if (bucket === strangers) return;
    if (bucket.held <= shareOf(bucket)) bucket.past = 0;
    else if (!bucket.past) {
      bucket.past = now;
      reclaimSoon();
    }
  }

  // What a link may be given now, of the `need` it has, `own` counting against its window.
  function room(link, bucket, own, need) {
    const n = Math.min(need, bucket.window - own, shareOf(bucket) - bucket.held, bucket.group.limit - bucket.group.held);
    if (n >= Math.min(need, LEAST_BYTES)) {
      // Given part of what it needs, it is held back still: what it takes and does not
      // pass on frees nothing for the others.
      if (n === need) link.since = 0;
      return n;
    }
    if (bucket.window - own >= Math.min(need, LEAST_BYTES)) {
      const back = !waiting.has(link);
      waiting.add(link);
      if (!link.behind()) link.since = 0;
      else {
        link.since ||= Date.now();
        if (back) reclaimSoon();
      }
    }
    return 0;
  }

  function wake() {
    if (waking || waiting.size === 0) return;
    waking = true;
    setImmediate(() => {
      waking = false;
      const due = [...waiting];
      waiting.clear();
      going = true;
      for (const link of due) link.go();
      going = false;
      reclaimSoon();
    });
  }

  // A job with room left in its share is held back by jobs past theirs: each of those is
  // due once it and the longest held back have been so for reclaimMs.
  function reclaimSoon() {
    if (going) return;
    clearTimeout(reclaim);
    reclaim = null;
    const held = [...waiting].filter((link) => link.since && link.behind()).map((link) => link.since);
    if (held.length === 0) return;
    const since = Math.min(...held);
    let soonest = Infinity;
    const now = Date.now();
    for (const bucket of jobs.values()) {
      if (!bucket.past) continue;
      const due = Math.max(bucket.past, since) + reclaimMs;
      if (due > now) {
        soonest = Math.min(soonest, due);
        continue;
      }
      const fullest = [...bucket.links].sort((a, b) => b.holding() - a.holding());
      for (const link of fullest) {
        if (bucket.held <= shareOf(bucket)) break;
        link.destroy(new Error('the job had more than its share of the hop for too long'));
      }
    }
    if (soonest === Infinity) return;
    reclaim = setTimeout(reclaimSoon, soonest - now);
    reclaim.unref();
  }

  function framed(raw, first) {
    let bucket = strangers;
    let held = 0; // what this link counts in its bucket
    let credit = 0; // granted to the relay and not yet sent
    let asked = 0; // what the relay asked room for and has not been granted
    let inFlight = 0; // sent to the relay and not yet passed on
    const queue = []; // { chunk, at, done } written and not yet sent
    let dead = false;
    let ended = false; // the relay sent END
    let preface = 0; // how much of PREFACE has come
    let kept = null; // a frame not all of which has come
    const stash = []; // { buf, used }: bytes come and not yet handed on, oldest first
    let stashed = 0;
    let wanted = false; // the link's reader asked for bytes and was handed none

    function sync() {
      const now = dead ? 0 : credit + inFlight;
      const by = now - held;
      held = now;
      bucket.held += by;
      bucket.group.held += by;
      judge(bucket);
      if (by < 0) wake();
    }

    function frame(type, n, payload) {
      const head = Buffer.allocUnsafe(HEADER_BYTES);
      head[0] = type;
      head.writeUInt32BE(n, 1);
      if (!payload) return raw.write(head);
      raw.cork();
      raw.write(head);
      raw.write(payload);
      return raw.uncork();
    }

    function grant() {
      if (asked === 0 || dead) return;
      const n = room(link, bucket, credit + stashed + link.readableLength, asked);
      if (n === 0) return;
      asked = 0;
      credit += n;
      frame(CREDIT, n);
      sync();
    }

    function send() {
      while (queue.length > 0 && !dead) {
        const next = queue[0];
        const left = next.chunk.length - next.at;
        if (left > 0) {
          const n = room(link, bucket, inFlight, Math.min(left, FRAME_BYTES));
          if (n === 0) return;
          frame(DATA, n, next.chunk.subarray(next.at, next.at + n));
          inFlight += n;
          next.at += n;
          sync();
        }
        if (next.at === next.chunk.length) {
          queue.shift();
          next.done();
        }
      }
    }

    function keep(payload) {
      if (wanted && stash.length === 0) {
        wanted = link.push(payload);
        return;
      }
      for (let at = 0; at < payload.length;) {
        let tail = stash[stash.length - 1];
        if (!tail || tail.used === STASH_BYTES) stash.push(tail = { buf: Buffer.allocUnsafe(STASH_BYTES), used: 0 });
        const n = payload.copy(tail.buf, tail.used, at);
        tail.used += n;
        at += n;
      }
      stashed += payload.length;
    }

    function hand() {
      while (wanted && stash.length > 0) {
        const { buf, used } = stash.shift();
        stashed -= used;
        wanted = link.push(buf.subarray(0, used));
      }
      if (ended && stash.length === 0 && !link.readableEnded) link.push(null);
    }

    // What the relay sends: a broken frame, or more than it was granted or was sent,
    // ends the connection.
    function take(chunk) {
      let buf = kept ? Buffer.concat([kept, chunk]) : chunk;
      kept = null;
      if (preface < PREFACE.length) {
        const n = Math.min(PREFACE.length - preface, buf.length);
        if (!buf.subarray(0, n).equals(PREFACE.subarray(preface, preface + n))) return link.destroy();
        preface += n;
        buf = buf.subarray(n);
      }
      let at = 0;
      while (buf.length - at >= HEADER_BYTES && !dead) {
        const type = buf[at];
        const n = buf.readUInt32BE(at + 1);
        if (type === DATA) {
          if (n > credit || ended) return link.destroy();
          if (buf.length - at < HEADER_BYTES + n) break;
          credit -= n;
          keep(buf.subarray(at + HEADER_BYTES, at + HEADER_BYTES + n));
          sync();
          at += HEADER_BYTES + n;
          continue;
        }
        at += HEADER_BYTES;
        if (type === END) {
          ended = true;
          hand();
        } else if (type === ASK) {
          if (n === 0 || ended) return link.destroy();
          asked = n;
          grant();
        } else if (type === ACK) {
          if (n > inFlight) return link.destroy();
          inFlight -= n;
          sync();
          send();
        } else return link.destroy();
      }
      if (at < buf.length) kept = buf.subarray(at);
      return undefined;
    }

    const link = new (class extends Duplex {
      // What is read of the connection's bytes makes room in its window for more.
      read(n) {
        const r = super.read(n);
        grant();
        return r;
      }

      setTimeout(ms, fn) {
        raw.setTimeout(ms);
        if (fn) this.once('timeout', fn);
        return this;
      }
    })({
      allowHalfOpen: true,
      // What is not taken is kept in the stash, and the link itself holds one chunk.
      readableHighWaterMark: 1,
      read() {
        wanted = true;
        hand();
      },
      write(chunk, encoding, done) {
        queue.push({ chunk, at: 0, done });
        send();
      },
      final(done) {
        frame(END, 0);
        done();
      },
      destroy(err, done) {
        dead = true;
        waiting.delete(link);
        sync();
        bucket.links.delete(link);
        // A socket closed while the relay still sends is reset, and the relay loses what
        // it had not read yet of the broker's: the hop is ended instead, and closed when
        // the relay ends its side too.
        if (err) raw.destroy();
        else {
          raw.end();
          setTimeout(() => raw.destroy(), lingerMs).unref();
        }
        done(err);
      },
    });
    strangers.links.add(link);
    link.go = () => { grant(); send(); };
    link.behind = () => bucket !== strangers && bucket.held < shareOf(bucket);
    link.holding = () => held;
    link.seat = (job) => {
      if (dead || bucket !== strangers) return;
      if (!jobs.has(job)) throw new Error('a link is seated for a job not admitted to the hop');
      bucket.held -= held;
      bucket.group.held -= held;
      bucket.links.delete(link);
      bucket = jobs.get(job);
      bucket.links.add(link);
      bucket.held += held;
      bucket.group.held += held;
      judge(bucket);
    };
    raw.on('timeout', () => link.emit('timeout'));
    raw.on('data', take);
    // The relay ends what it carries with END; a hop that ends without it is gone.
    raw.on('end', () => link.destroy());
    raw.on('close', () => link.destroy());
    raw.resume();
    if (first) take(first);
    return link;
  }

  // The shares change for every job: how long each is past its own counts from when it
  // was first past it as it is now.
  function reshare() {
    const now = Date.now();
    for (const bucket of jobs.values()) judge(bucket, now);
    wake();
  }

  function admit(job) {
    if (jobs.has(job)) return;
    jobs.set(job, { group: groups.jobs, held: 0, links: new Set(), window, past: 0 });
    reshare();
  }

  function leave(job) {
    if (jobs.delete(job)) reshare();
  }

  function held(job) {
    if (job === undefined) return { jobs: groups.jobs.held, strangers: groups.strangers.held };
    return jobs.get(job)?.held ?? 0;
  }

  return { framed, admit, leave, seat: (link, job) => link.seat?.(job), held };
}
