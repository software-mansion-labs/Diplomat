// The settings that bound how long or how much something of this machine's may take,
// where what holds the bound reads zero as none: zero is not taken, and is named for the
// daemon to say so.
// Run: node test/paths-bounds.mjs

import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const paths = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'paths.js');
const BOUNDS = {
  GIT_TIMEOUT_MS: 120000, MIRROR_TIMEOUT_MS: 600000, IMAGE_BUILD_TIMEOUT_MS: 1800000, CONTAINER_USAGE_TIMEOUT_MS: 300000,
  KEYCHAIN_TIMEOUT_MS: 30000, JOB_IDLE_MS: 1800000, CONTAINER_PIDS: 4096,
};
const names = Object.keys(BOUNDS);

// The bounds, and the settings named as asking for none, as a process started with every
// bound's variable set to `value` reads them.
function read(value) {
  const set = value === undefined ? {} : Object.fromEntries(names.map((name) => [`DN_${name}`, value]));
  const out = execFileSync(process.execPath, ['--input-type=module', '-e',
    `const p = await import(${JSON.stringify(paths)}); console.log(JSON.stringify([${JSON.stringify(names)}.map((name) => p[name]), [...p.NOT_BOUNDS].sort()]));`],
  { env: { PATH: process.env.PATH, DN_BASE_DIR: path.join(os.tmpdir(), 'dn-paths-bounds'), ...set }, encoding: 'utf8' });
  return JSON.parse(out);
}

let checks = 0;
const check = (name, fn) => { fn(); checks++; console.log(`PASS ${name}`); };

check('a bound set to zero is its default, and the setting is named', () => {
  assert.deepEqual(read(undefined), [Object.values(BOUNDS), []], 'the defaults, and nothing named');
  for (const zero of ['0', '0.0', ' 0 ']) {
    assert.deepEqual(read(zero), [Object.values(BOUNDS), names.map((name) => `DN_${name}=${zero}`).sort()], JSON.stringify(zero));
  }
});

check('a bound set to a number above zero is that number, and anything else is its default with nothing named', () => {
  assert.deepEqual(read('7'), [names.map(() => 7), []]);
  for (const value of ['', 'ten', '-1']) assert.deepEqual(read(value), [Object.values(BOUNDS), []], JSON.stringify(value));
});

console.log(`\nall ${checks} checks passed`);
