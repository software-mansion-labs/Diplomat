// The log every daemon writes (daemon-core's): however much is written to it, by
// whoever, it stays within its bound. And this daemon's own: whatever words it is given
// to write, an entry reads as one.
// Run: node test/daemon-log.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { check, passed } from './lib/daemons.mjs';
import { LOG_MAX_BYTES, createLog } from '../../daemon-core/src/log.js';
import { ENTRY_CHARS, openLog } from '../src/log.js';
import { scratchDir } from './lib/scratch.mjs';

const dir = scratchDir('dn-log-');
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

  await check('an entry of this daemon\'s log is one entry whatever words it carries: no further line of it begins as an entry does, a stack stays as it is, and what moves a cursor or reorders a line is shown', () => {
    const file = path.join(dir, 'g', 'daemon.log');
    const log = openLog(file);
    const text = () => fs.readFileSync(file, 'utf8').replace(/^\[\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z\] /gm, '> ');
    log('r1 ended: failed (done\n[2026-01-01T00:00:00.000Z] ended\n\n\r[2026-01-01T00:00:00.000Z] daemon listening)');
    log('uncaught: Error: lost\n    at one (file.js:1:1)\n    at two (file.js:2:2)');
    log('clear \u001b[2J bell \u0007 back \u0008 del \u007f csi \u009b ls \u2028 ps \u2029 rlo \u202e pdf \u202c rli \u2067 pdi \u2069 tab\t.', { with: 'a\nvalue' }, 7);
    log('a path /tmp/za\u017c\u00f3\u0142\u0107 and a dash \u2013');
    assert.equal(text(), [
      '> r1 ended: failed (done', '  [2026-01-01T00:00:00.000Z] ended', '', '  ?[2026-01-01T00:00:00.000Z] daemon listening)',
      '> uncaught: Error: lost', '    at one (file.js:1:1)', '    at two (file.js:2:2)',
      '> clear ?[2J bell ? back ? del ? csi ? ls ? ps ? rlo ? pdf ? rli ? pdi ? tab?. {"with":"a\\nvalue"} 7',
      '> a path /tmp/za\u017c\u00f3\u0142\u0107 and a dash \u2013', '',
    ].join('\n'));
    fs.rmSync(file);
    log('x'.repeat(ENTRY_CHARS), `${'y'.repeat(ENTRY_CHARS)}z`);
    assert.equal(text(), `> ${'x'.repeat(ENTRY_CHARS)} ${'y'.repeat(ENTRY_CHARS)}... (${ENTRY_CHARS + 1} characters)\n`);
  });

  console.log(`\nall ${passed()} checks passed`);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
