// What a host keeps across restarts, as JSON documents under one directory:
//
//   identity.json           { seed }
//   pools/<pool hash>.json  one pool: its link, this host's own sequence numbers, its records
//   locks.json              the lock table of every pool
//   keys.json               the keys this host issued and the keys it holds, secrets included
//   offers.json             the private half of every offer: the prompt, the counters, the outcome
//   runs.json               the runs, and the tasks this host will not take again
//
// A document is written whole, to a temporary file renamed into place, readable by its
// owner only. Nothing reaches the disk before `flush`: the node changes documents as
// often as it likes and flushes once before anything it does can be seen from outside.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { writeAtomic } from '../../../daemon-core/src/fsio.js';

/// The file name of a pool's document: a pool id holds slashes, its hash does not.
export function poolFile(id) {
  return `pools/${crypto.createHash('sha256').update(id, 'utf8').digest('hex').slice(0, 32)}`;
}

/// The directory `dir` as a store's disk: `{ read(name), write(name, text), remove(name), aside(name) }`,
/// names without their `.json`. `read` answers null for a file that is not there.
export function fileDisk(dir) {
  const file = (name) => path.join(dir, `${name}.json`);
  return {
    read(name) {
      try {
        return fs.readFileSync(file(name), 'utf8');
      } catch (err) {
        if (err.code === 'ENOENT') return null;
        throw err;
      }
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
  return {
    files,
    read: (name) => files.get(name) ?? null,
    write: (name, text) => files.set(name, text),
    remove: (name) => files.delete(name),
    aside(name) {
      files.set(`${name}.corrupt`, files.get(name));
      files.delete(name);
      return `${name}.corrupt`;
    },
  };
}

/// The store over `dir` (or over `disk`): `{ read(name), write(name, value), remove(name), flush() }`.
/// `read` answers the stored value or null; a document that does not parse is moved
/// aside, logged, and read as null. `write` only remembers the value: `flush` writes
/// every value remembered since the last one, each file replaced atomically.
export function createStore({ dir, disk = fileDisk(dir), log = () => {} }) {
  const dirty = new Map(); // name -> the value to write, or undefined to remove the file

  return {
    read(name) {
      if (dirty.has(name)) return dirty.get(name) ?? null;
      const text = disk.read(name);
      if (text === null) return null;
      try {
        return JSON.parse(text);
      } catch (err) {
        log(`store: ${name}.json does not parse (${err.message}); kept as ${disk.aside(name)} and read as empty`);
        return null;
      }
    },
    write(name, value) {
      dirty.set(name, value);
    },
    remove(name) {
      dirty.set(name, undefined);
    },
    flush() {
      for (const [name, value] of dirty) {
        if (value === undefined) disk.remove(name);
        else disk.write(name, `${JSON.stringify(value)}\n`);
      }
      dirty.clear();
    },
  };
}
