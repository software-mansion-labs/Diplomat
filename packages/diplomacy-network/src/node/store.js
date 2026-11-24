// What a host keeps across restarts, as JSON documents under one directory:
//
//   identity.json           { seed }
//   heard.json              { ts }: the latest date of a request this host served
//   heard/<pool hash>.json  { heard, waitedOut, online }: when another host of that pool was last heard, the last such time whose silence this host waited out, and how long it ran there with its transport up
//   peers.json              { silent }: the peers this host asks in vain, and has for long, and since when
//   pools/<pool hash>.json  one pool: its link, this host's own sequence numbers, its records, the keys it asks
//   pools/<pool hash>.log   what changed in that pool since its document was written
//   locks.json              the lock table of every pool
//   keys.json               the keys this host issued and the keys it holds, secrets included
//   offers.json             the private half of every offer: the prompt, the counters, the outcome
//   runs.json               the runs, and the tasks this host will not take again
//
// A document is written whole, to a temporary file renamed into place, readable by its
// owner only. Nothing reaches the disk before `flush`: the node changes documents as
// often as it likes and flushes once before anything it does can be seen from outside.
// A pool's document is as large as its pool, and a change of one record is written as a
// line after it: the first line of the log names the document it follows, by its hash,
// and each line after that is one change. The document is written whole again, and the
// log removed, once the lines have grown as long as the document was, and no shorter
// than LOG_FLOOR_BYTES.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { writeAtomic } from '../../../daemon-core/src/fsio.js';
import { recordKey } from '../core/records.js';

const LOG_FLOOR_BYTES = 64 * 2 ** 10;

// A pool id holds slashes, its hash does not.
const poolHash = (id) => crypto.createHash('sha256').update(id, 'utf8').digest('hex').slice(0, 32);

/// The file name of a pool's document.
export const poolFile = (id) => `pools/${poolHash(id)}`;

/// The file name of when this host was last heard in a pool: apart from the pool's
/// document, so that a word heard does not have the document written whole.
export const heardFile = (id) => `heard/${poolHash(id)}`;

/// The directory `dir` as a store's disk:
/// `{ read(name), write(name, text), remove(name), aside(name), append(name, text), appended(name), cut(name) }`,
/// names without their `.json`. `read` answers null for a file that is not there. The
/// last three are the log of a document: text added to its end, all of it or null, and
/// its removal.
export function fileDisk(dir) {
  const file = (name) => path.join(dir, `${name}.json`);
  const logFile = (name) => path.join(dir, `${name}.log`);
  const text = (at) => {
    try {
      return fs.readFileSync(at, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
  };
  return {
    read: (name) => text(file(name)),
    appended: (name) => text(logFile(name)),
    append(name, added) {
      const bytes = Buffer.from(added, 'utf8');
      const fd = fs.openSync(logFile(name), 'a', 0o600);
      try {
        // A write may take less than it was given, and say so only by its count.
        for (let at = 0; at < bytes.length;) {
          const n = fs.writeSync(fd, bytes, at, bytes.length - at);
          if (n <= 0) throw new Error(`${name}.log took no more of a line`);
          at += n;
        }
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    },
    cut(name) {
      fs.rmSync(logFile(name), { force: true });
    },
    write(name, text) {
      fs.mkdirSync(path.dirname(file(name)), { recursive: true, mode: 0o700 });
      writeAtomic(file(name), text, 0o600);
    },
    remove(name) {
      fs.rmSync(file(name), { force: true });
    },
    aside(name) {
      const kept = `${file(name)}.corrupt-${crypto.randomBytes(4).toString('hex')}`;
      fs.renameSync(file(name), kept);
      return kept;
    },
  };
}

/// A disk held in memory, for tests that restart a host thousands of times.
export function memoryDisk() {
  const files = new Map();
  const logs = new Map();
  return {
    files,
    logs,
    read: (name) => files.get(name) ?? null,
    appended: (name) => logs.get(name) ?? null,
    append: (name, added) => logs.set(name, (logs.get(name) ?? '') + added),
    cut: (name) => logs.delete(name),
    write: (name, text) => files.set(name, text),
    remove: (name) => files.delete(name),
    aside(name) {
      files.set(`${name}.corrupt`, files.get(name));
      files.delete(name);
      return `${name}.corrupt`;
    },
  };
}

// A document rests on the ones before it here - a run on the key it holds, a key and a
// lock on a pool's records - and is written after them, so a host that dies between two
// writes of one flush finds nothing that rests on what never reached the disk.
const ORDER = ['identity', 'heard', 'peers', 'links', 'pools', 'locks', 'keys', 'offers', 'runs'];
const rank = (name) => ORDER.indexOf(name.split('/')[0]);

/// The store over `dir` (or over `disk`): `{ read(name), lines(name), write(name, value, { line }), remove(name), flush() }`.
/// `read` answers the stored value or null; a document that does not parse is moved
/// aside, logged, and read as null. `write` only remembers the value: `flush` writes
/// every value remembered since the last one, each file replaced atomically, in the
/// order the documents rest on one another. A write may give the `line` that says all
/// the value differs by from the one written before: where nothing else was written of
/// the document since, the flush adds the line to the document's log in place of
/// writing the document, and `lines` answers the lines that follow the document as it
/// is on disk.
export function createStore({ dir, disk = fileDisk(dir), log = () => {} }) {
  // name -> { value, lines }: the value to write, undefined to remove the file, and the
  // lines that say as much, or null when only the whole document does.
  const dirty = new Map();
  // name -> { tag, room, begun }: a document this store wrote whole, what its log may
  // still grow by, and whether the log has its first line.
  const logs = new Map();
  const tagOf = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');

  return {
    read(name) {
      if (dirty.has(name)) return dirty.get(name).value ?? null;
      const text = disk.read(name);
      if (text === null) return null;
      try {
        return JSON.parse(text);
      } catch (err) {
        log(`store: ${name}.json does not parse (${err.message}); kept as ${disk.aside(name)} and read as empty`);
        return null;
      }
    },
    lines(name) {
      const [text, added] = dirty.has(name) ? [null, null] : [disk.read(name), disk.appended(name)];
      if (text === null || added === null) return [];
      // A log that follows another document was left by a host that died between the
      // write of this one and the log's removal. What comes after the last line feed is
      // a line the host died writing. Each line rests on the ones before it: the lines
      // after one that does not parse are not taken in.
      const [tag, ...lines] = added.split('\n').slice(0, -1);
      if (tag !== tagOf(text)) return [];
      const read = [];
      for (const [n, line] of lines.entries()) {
        try {
          read.push(JSON.parse(line));
        } catch (err) {
          log(`store: line ${n + 1} of ${name}.log does not parse (${err.message}); read up to it`);
          break;
        }
      }
      return read;
    },
    write(name, value, { line } = {}) {
      const held = dirty.get(name);
      const whole = line === undefined || (held ? !held.lines : !logs.has(name));
      dirty.set(name, { value, lines: whole ? null : [...(held?.lines ?? []), line] });
    },
    remove(name) {
      dirty.set(name, { value: undefined, lines: null });
    },
    flush() {
      for (const [name, held] of [...dirty].sort(([a], [b]) => rank(a) - rank(b))) {
        const kept = logs.get(name);
        const added = held.lines?.map((line) => `${JSON.stringify(line)}\n`).join('');
        // Whatever fails from here on, the document is written whole the next time: an
        // append may have written half a line.
        logs.delete(name);
        held.lines = null;
        if (added !== undefined && added.length <= kept.room) {
          disk.append(name, kept.begun ? added : `${kept.tag}\n${added}`);
          logs.set(name, { tag: kept.tag, room: kept.room - added.length, begun: true });
        } else if (held.value === undefined) {
          disk.remove(name);
          disk.cut(name);
        } else {
          const text = `${JSON.stringify(held.value)}\n`;
          disk.write(name, text);
          // A log may be there from a life of the host before this one.
          if (kept?.begun !== false) disk.cut(name);
          logs.set(name, { tag: tagOf(text), room: Math.max(text.length, LOG_FLOOR_BYTES), begun: false });
        }
        dirty.delete(name);
      }
    },
  };
}

/// A pool's document as `store` holds it, the lines of its log taken in: each line is
/// `{ seq, put, drop }`, the host's sequence number, the records taken in and the keys
/// of the records dropped. Null when the store holds none.
export function readPool(store, id) {
  const doc = store.read(poolFile(id));
  const lines = store.lines(poolFile(id));
  if (lines.length === 0) return doc;
  const records = new Map(doc.records.map((record) => [recordKey(record), record]));
  for (const { put, drop } of lines) {
    for (const key of drop) records.delete(key);
    for (const record of put) records.set(recordKey(record), record);
  }
  return { ...doc, seq: lines.at(-1).seq, records: [...records.values()] };
}
