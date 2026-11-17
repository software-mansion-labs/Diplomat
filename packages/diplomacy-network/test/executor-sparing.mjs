// The log for what a job can cause as often as it likes: how often a line is written,
// what is said of the ones left out, and how much of a job's own words a line carries.
// Run: node test/executor-sparing.mjs

import assert from 'node:assert/strict';
import { clip, createSparingLog, LOG_EVERY_MS, LOG_TEXT_CHARS } from '../src/executor/sparing.js';

let checks = 0;
const check = (name, fn) => { fn(); checks++; console.log(`PASS ${name}`); };

check('a job\'s words are made printable and cut to 300 characters, with their length said', () => {
  assert.equal(LOG_TEXT_CHARS, 300);
  assert.equal(clip('plain words'), 'plain words');
  assert.equal(clip('a\nb\tc\x1b[2Jé\u{1f600}'), 'a?b?c?[2J???');
  assert.equal(clip('x'.repeat(300)), 'x'.repeat(300));
  assert.equal(clip('x'.repeat(301)), `${'x'.repeat(300)}... (301 characters)`);
  assert.equal(clip(`${'x'.repeat(299)}\n${'y'.repeat(100000)}`), `${'x'.repeat(299)}?... (100300 characters)`);
  assert.equal(clip(undefined), 'undefined');
  assert.equal(clip(12), '12');
});

check('the first line of a kind is written at once, the next a minute after it, and that one says how many came between', () => {
  assert.equal(LOG_EVERY_MS, 60000);
  const lines = [];
  let clock = 1000;
  const say = createSparingLog((...parts) => lines.push(parts.join(' ')), { now: () => clock });
  say('a', 'broker', 'run-1', 'refused one');
  assert.deepEqual(lines, ['broker run-1 refused one']);
  for (let i = 0; i < 1000; i++) say('a', 'broker', 'run-1', `refused ${i}`);
  clock += LOG_EVERY_MS - 1;
  say('a', 'broker', 'run-1', 'refused a moment early');
  assert.deepEqual(lines, ['broker run-1 refused one'], 'nothing more within the minute');
  // Another kind is not kept back by this one.
  say('b', 'broker', 'run-2', 'refused');
  assert.deepEqual(lines.slice(1), ['broker run-2 refused']);
  clock += 1;
  say('a', 'broker', 'run-1', 'refused a minute on');
  assert.deepEqual(lines.slice(2), ['broker run-1 refused a minute on (1001 more of the kind were not written)']);
  // The minute is counted from the line that was written, and its count starts again.
  clock += LOG_EVERY_MS - 1;
  say('a', 'broker', 'run-1', 'left out');
  clock += 1;
  say('a', 'broker', 'run-1', 'written');
  clock += LOG_EVERY_MS;
  say('a', 'broker', 'run-1', 'with nothing between');
  assert.deepEqual(lines.slice(3), ['broker run-1 written (1 more of the kind were not written)', 'broker run-1 with nothing between']);
});

check('the kinds that are ended tell of what they left out and are forgotten, and no other kind is', () => {
  const lines = [];
  const clock = 0;
  const say = createSparingLog((...parts) => lines.push(parts.join(' ')), { now: () => clock });
  for (const kind of ['job one refused', 'job one failed', 'job one-more refused', 'job two refused']) {
    say(kind, kind, 'first');
    say(kind, kind, 'second');
  }
  say('job one failed', 'job one failed', 'third');
  say('job one quiet', 'job one quiet', 'only');
  lines.length = 0;
  say.end('job one ');
  assert.deepEqual(lines, ['job one refused first (1 more of the kind were not written)', 'job one failed first (2 more of the kind were not written)']);
  lines.length = 0;
  say.end('job one ');
  assert.deepEqual(lines, [], 'once');
  // A forgotten kind starts anew; one that was not ended is where it was.
  say('job one refused', 'job one refused', 'again');
  say('job one-more refused', 'job one-more refused', 'third');
  say('job two refused', 'job two refused', 'third');
  assert.deepEqual(lines, ['job one refused again']);
  lines.length = 0;
  say.end('job ');
  assert.deepEqual(lines, ['job one-more refused first (2 more of the kind were not written)', 'job two refused first (2 more of the kind were not written)']);
});

console.log(`\nall ${checks} checks passed`);
