// What holds these bounds reads zero as none, so zero is not taken and is named instead.

import assert from 'node:assert/strict';
import fs from 'node:fs';
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
// In docker's units.
const AMOUNTS = { CONTAINER_MEMORY: '8g', CONTAINER_CPUS: '4' };

// `[bounds, NOT_BOUNDS]` as a process with each `DN_<name>` set to `value` reads them.
function read(value, names = Object.keys(BOUNDS)) {
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

check('an amount docker reads is given to it as it was said, unit and all; one that says zero is its default, and the setting is named; what is no amount is its default with nothing named', () => {
  const amounts = Object.keys(AMOUNTS);
  assert.deepEqual(read(undefined, amounts), [Object.values(AMOUNTS), []]);
  for (const said of ['2g', '1.5', '512m']) assert.deepEqual(read(said, amounts), [[said, said], []], said);
  assert.deepEqual(read(' 2g ', amounts), [['2g', '2g'], []]);
  for (const zero of ['0', '0g', '0.0', ' 0 ']) {
    assert.deepEqual(read(zero, amounts), [Object.values(AMOUNTS), amounts.map((name) => `DN_${name}=${zero}`).sort()], JSON.stringify(zero));
  }
  for (const value of ['', 'lots', '-1', '-2g']) assert.deepEqual(read(value, amounts), [Object.values(AMOUNTS), []], JSON.stringify(value));
});

function knobs(env) {
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', `const p = await import(${JSON.stringify(paths)}); console.log(JSON.stringify(p.TEST_KNOBS));`],
    { env: { PATH: process.env.PATH, DN_BASE_DIR: path.join(os.tmpdir(), 'dn-paths-bounds'), ...env }, encoding: 'utf8' });
  return JSON.parse(out);
}

check('a figure of the protocol set off its default is named as a test\'s setting, every one of them; at its default, set to no number, or a setting of this machine\'s own, it is not', () => {
  assert.deepEqual(knobs({}), []);
  const given = {
    DN_LEASE_SECS: '60', DN_LEASE_GRACE_SECS: '0', DN_GRANT_TTL_SECS: '1', DN_ADMIT_TTL_MS: '99999999999', DN_RECORD_RETENTION_SECS: '120', DN_RANK_DELAY_MS: '0',
    DN_POW_MEMBER_BASE: '1', DN_TRANSPORT: 'loop', DN_FORGE_ORIGINS: '{}', DN_TEST_FAULTS: '/nowhere',
  };
  const not = {
    DN_PING_LEAD_SECS: '600', DN_TICK_MS: 'fast', DN_RETRY_MS: '', DN_POW_STRANGER_ALLOW: '-1', DN_POW_NO_SUCH: '1',
    DN_SWEEP_MS: '5', DN_CONTAINER_DISK_BYTES: '1', DN_CONTAINER_PIDS: '7', DN_CONTAINER_MEMORY: '1g', DN_JOB_MODEL_REQUESTS: '0', DN_CONFIG_POLL_MS: '150',
  };
  assert.deepEqual(knobs({ ...given, ...not }), Object.entries(given).map(([name, value]) => `${name}=${value}`).sort());
  assert.deepEqual(knobs({ DN_TRANSPORT: 'tor' }), []);
  // The protocol's part of the file reads every figure the same way, so each is named.
  const source = fs.readFileSync(paths, 'utf8');
  const [from, to] = [source.indexOf('// Protocol constants (PROTOCOL.md)'), source.indexOf('// Acting as the requester')];
  assert.ok(from > 0 && to > from);
  const protocol = source.slice(from, to);
  const figures = [...protocol.matchAll(/\bagreed\('(DN_[A-Z_]+)'/g)].map((found) => found[1]);
  assert.deepEqual([figures.length >= 38, /\b(num|bound|amount)\(|process\.env/.test(protocol)], [true, false]);
  assert.deepEqual(knobs(Object.fromEntries(figures.map((name) => [name, '7']))), figures.map((name) => `${name}=7`).sort());
});

console.log(`\nall ${checks} checks passed`);
