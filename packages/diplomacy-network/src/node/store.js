// What a host keeps across restarts, as JSON documents under one directory:
//
//   identity.json           { seed }
//   heard.json              { ts }: the latest request this host served
//   heard/<pool hash>.json  { heard, waitedOut, online, met }: when another host of the pool was last heard, the last such time whose silence it waited out, how long it ran there with its transport up, the members it heard from themselves
//   asks/<pool hash>.json   { back, former }: the hosts it asks besides the members it holds, and met members whose records ran out, each with its next ask and the member that seated it
//   peers.json              { silent }: peers long asked in vain, and since when
//   pools/<pool hash>.json  one pool: its link, this host's own sequence numbers, its records
//   pools/<pool hash>.log   changes since that document was written
//   locks.json              every pool's lock table
//   keys.json               keys issued and held, secrets included
//   offers.json             each offer's private half: prompt, counters, outcome
//   runs.json               runs, and tasks this host will not take again
//
// Nothing reaches disk before `flush`, which the node calls before anything it did can be
// seen from outside. A pool's log starts with the hash of the document it follows, then
// one change per line; the document is rewritten whole and the log removed once the log
// is as long as the document, and no shorter than LOG_FLOOR_BYTES.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { writeAtomic } from '../../../daemon-core/src/fsio.js';
import { recordKey } from '../core/records.js';

const LOG_FLOOR_BYTES = 64 * 2 ** 10;

// A pool id holds slashes, its hash does not.
const poolHash = (id) => crypto.createHash('sha256').update(id, 'utf8').digest('hex').slice(0, 32);

export const poolFile = (id) => `pools/${poolHash(id)}`;

/// Apart from the pool's document, so a word heard does not rewrite it whole.
export const heardFile = (id) => `heard/${poolHash(id)}`;

/// Apart from the pool's document, so it is written only when the asks change.
export const asksFile = (id) => `asks/${poolHash(id)}`;

/// Names omit `.json`; `read` answers null for a missing file. `append`, `appended` and
/// `cut` are a document's log: add to its end, all of it or null, remove it.
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
        // writeSync may write short.
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

/// For tests that restart a host thousands of times.
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

// A document rests on the ones before it (a run on its key, a key and a lock on a pool's
// records) and is flushed after them, so a crash mid-flush leaves nothing resting on what
// never reached disk.
const ORDER = ['identity', 'heard', 'asks', 'peers', 'links', 'pools', 'locks', 'keys', 'offers', 'runs'];
const rank = (name) => ORDER.indexOf(name.split('/')[0]);

/// A document that does not parse is moved aside, logged and read as null. `write` only
/// remembers: `flush` writes it, atomically, in ORDER. A write's `line` is all the value
/// differs by from the one before: if nothing else of the document was written since,
/// flush appends it to the log instead. `lines` answers the log lines after the document
/// on disk.
export function createStore({ dir, disk = fileDisk(dir), log = () => {} }) {
  // name -> { value, lines }: undefined value removes the file; null lines: write it whole.
  const dirty = new Map();
  // name -> { tag, room, begun }: a document this store wrote whole, what its log may
  // still grow by, whether the log has its first line.
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
      // A log following another document is from a host that died between writing this one
      // and removing the log. Text after the last line feed is a line it died writing. Each
      // line rests on those before, so reading stops at the first that does not parse.
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
        // Any failure from here on leaves the document to be written whole next time: an
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
          // A log may be left from an earlier life of the host.
          if (kept?.begun !== false) disk.cut(name);
          logs.set(name, { tag: tagOf(text), room: Math.max(text.length, LOG_FLOOR_BYTES), begun: false });
        }
        dirty.delete(name);
      }
    },
  };
}

/// The document with its log applied. A line is `{ seq, put, drop }`: the host's sequence
/// number, records put, keys of records dropped.
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
