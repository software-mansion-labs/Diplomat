// The log every daemon writes (daemon-core's): however much is written to it, by
// whoever, it stays within its bound.
// Run: node test/daemon-log.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { check, passed } from './lib/daemons.mjs';
import { LOG_MAX_BYTES, createLog } from '../../daemon-core/src/log.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dn-log-'));
const size = (file) => fs.statSync(file).size;
const lines = (file) => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => line.replace(/^\[[^\]]+\] /, ''));
const LINE = '[2026-01-01T00:00:00.000Z] line 0000\n'.length;

try {
  await check('a log that has reached its bound is set aside as one copy and starts again, with no line lost between the two', () => {
    const file = path.join(dir, 'a', 'daemon.log');
    const log = createLog(file, 10 * LINE);
    const said = [];
    const say = (n) => { for (let i = 0; i < n; i += 1) { said.push(`line ${String(said.length).padStart(4, '0')}`); log(said.at(-1)); } };
    say(10);
    assert.deepEqual([size(file), fs.existsSync(`${file}.1`)], [10 * LINE, false], 'at the bound, not over it: nothing set aside yet');
    say(1);
    assert.deepEqual([lines(`${file}.1`), lines(file)], [said.slice(0, 10), said.slice(10)]);
    say(995);
    assert.ok(size(file) <= 10 * LINE && size(`${file}.1`) <= 10 * LINE, 'a thousand lines later, both within the bound');
    assert.deepEqual([...lines(`${file}.1`), ...lines(file)], said.slice(-lines(file).length - 10), 'the newest lines, in order, and the copy before it replaced');
    assert.deepEqual(fs.readdirSync(path.dirname(file)).sort(), ['daemon.log', 'daemon.log.1']);
  });

  await check('a daemon that names no bound is given one of 16 MiB', () => {
    const file = path.join(dir, 'f', 'daemon.log');
    const log = createLog(file);
    log('line 0000');
    fs.truncateSync(file, 16 * 1024 * 1024 - 1);
    log('line 0001');
    assert.deepEqual([size(file), fs.existsSync(`${file}.1`)], [LOG_MAX_BYTES - 1 + LINE, false]);
    log('line 0002');
    assert.deepEqual([lines(file), size(`${file}.1`)], [['line 0002'], LOG_MAX_BYTES - 1 + LINE]);
  });

  await check('the log stays the file it was: its mode, and a descriptor open on it before it started again, as a daemon\'s stderr is', () => {
    const file = path.join(dir, 'b', 'daemon.log');
    fs.mkdirSync(path.dirname(file));
    fs.writeFileSync(file, '', { mode: 0o600 });
    const stderr = fs.openSync(file, 'a');
    try {
      const log = createLog(file, 3 * LINE);
      for (let i = 0; i < 4; i += 1) log(`line 000${i}`);
      fs.writeSync(stderr, 'a stack\n');
      log('line 0004');
      assert.equal(fs.readFileSync(file, 'utf8').replace(/\[[^\]]+\] /g, ''), 'line 0003\na stack\nline 0004\n');
      assert.deepEqual([fs.statSync(file).mode & 0o777, fs.statSync(`${file}.1`).mode & 0o777], [0o600, 0o600]);
    } finally {
      fs.closeSync(stderr);
    }
  });

  await check('the bound holds for a log written by something else as well, and where no copy can be set aside', () => {
    const file = path.join(dir, 'c', 'daemon.log');
    const log = createLog(file, 4 * LINE);
    log('line 0000');
    fs.appendFileSync(file, 'x'.repeat(1000));
    log('line 0001');
    assert.deepEqual([lines(file), size(`${file}.1`)], [['line 0001'], LINE + 1000], 'what another writer added counts');

    fs.rmSync(`${file}.1`);
    fs.mkdirSync(`${file}.1`);
    for (let i = 0; i < 50; i += 1) log(`line ${String(i).padStart(4, '0')}`);
    assert.ok(size(file) <= 4 * LINE, 'emptied all the same');
    assert.equal(lines(file).at(-1), 'line 0049');
  });

  await check('a log that cannot be written is no fault of the caller\'s', () => {
    const file = path.join(dir, 'd', 'daemon.log');
    fs.mkdirSync(file, { recursive: true });
    assert.equal(createLog(file, 10)('lost', { with: 'a value' }), undefined);
    const fresh = path.join(dir, 'e', 'deeper', 'daemon.log');
    createLog(fresh)('first', { with: 'a value' });
    assert.deepEqual(lines(fresh), ['first {"with":"a value"}']);
  });

  console.log(`\nall ${passed()} checks passed`);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
