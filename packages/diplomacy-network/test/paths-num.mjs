import assert from 'node:assert/strict';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const paths = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'paths.js');

function tunables(env) {
  const out = execFileSync(process.execPath, ['--input-type=module', '-e',
    `const p = await import(${JSON.stringify(paths)}); console.log(JSON.stringify([p.DEVICE_WAIT_MS, p.JOB_MODEL_REQUESTS, p.JOB_FORGE_REQUESTS]));`],
  { env: { PATH: process.env.PATH, ...env }, encoding: 'utf8' });
  return JSON.parse(out);
}
const said = (value) => tunables({ DN_DEVICE_WAIT_MS: value, DN_JOB_MODEL_REQUESTS: value, DN_JOB_FORGE_REQUESTS: value });

let checks = 0;
const check = (name, fn) => { fn(); checks++; console.log(`PASS ${name}`); };

check('a tunable set to zero is zero', () => {
  assert.deepEqual(tunables({}), [30000, 5000, 4], 'the defaults');
  assert.deepEqual(said('0'), [0, 0, 0]);
  assert.deepEqual(said('0.0'), [0, 0, 0]);
  assert.deepEqual(said(' 0 '), [0, 0, 0]);
});

check('a tunable set to a number of zero or more is that number', () => {
  assert.deepEqual(said('7'), [7, 7, 7]);
  assert.deepEqual(said('1500.5'), [1500.5, 1500.5, 1500.5]);
  assert.deepEqual(said('1e3'), [1000, 1000, 1000]);
});

check('a tunable set to anything else is its default', () => {
  for (const value of ['', ' ', '\t', 'ten', '5 s', '-1', '-0.5', 'NaN', 'Infinity', '-Infinity']) {
    assert.deepEqual(said(value), [30000, 5000, 4], JSON.stringify(value));
  }
});

console.log(`\nall ${checks} checks passed`);
