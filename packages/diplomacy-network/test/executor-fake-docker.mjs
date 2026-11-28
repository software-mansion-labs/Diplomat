// The stand-in docker's staged failures and its record of calls, which every executor and
// daemon test leans on: a fail- file is taken a line a call, and one a test removes stays
// removed, even when a call was reading it at that moment; a call still writing its line
// of the record is no call yet.
// Run: node test/executor-fake-docker.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dockerCalls } from './lib/docker-calls.mjs';
import { scratchDir } from './lib/scratch.mjs';

const scratch = scratchDir('dn-fake-docker-');
const FAKE = fileURLToPath(new URL('./lib/fake-docker.mjs', import.meta.url));
const fakeDir = path.join(scratch, 'docker');
fs.mkdirSync(fakeDir);
const fault = path.join(fakeDir, 'fail-version');
const LINE = 'Error response from daemon: not now';

let checks = 0;
const check = async (name, fn) => { await fn(); checks++; console.log(`PASS ${name}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (what, fn, ms = 120000) => { for (const end = Date.now() + ms; Date.now() < end; await sleep(20)) if (fn()) return; assert.fail(`never: ${what}`); };
const docker = (args, { env = {}, node = [] } = {}) => new Promise((resolve) => {
  const child = spawn(process.execPath, [...node, FAKE, ...args], { env: { ...process.env, FAKE_DOCKER_DIR: fakeDir, ...env } });
  let stderr = '';
  child.stderr.on('data', (b) => { stderr += b; });
  child.on('close', (code) => resolve({ code, stderr }));
});

// Loaded into a call before the stand-in: once the call has read what holds `PAUSE_ON`,
// it says so in PAUSE_DIR/read and goes on only once PAUSE_DIR/gate is gone.
const pauser = path.join(scratch, 'pause.mjs');
fs.writeFileSync(pauser, `import fs from 'node:fs';
const read = fs.readFileSync;
fs.readFileSync = function (...args) {
  const out = read.apply(this, args);
  if (String(out).includes(process.env.PAUSE_ON)) {
    fs.writeFileSync(process.env.PAUSE_DIR + '/read', '');
    while (fs.existsSync(process.env.PAUSE_DIR + '/gate')) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
  return out;
};
`);

try {
  await check('a staged failure is taken a line a call, and the call that takes the last removes it', async () => {
    fs.writeFileSync(fault, `${LINE} 1\n${LINE} 2\n${LINE} 3\n`);
    const said = [];
    for (let i = 0; i < 3; i++) {
      said.push((await docker(['version'])).stderr);
      if (i < 2) assert.equal(fs.readFileSync(fault, 'utf8'), [2, 3].slice(i).map((n) => `${LINE} ${n}\n`).join(''));
    }
    assert.deepEqual(said, [1, 2, 3].map((n) => `${LINE} ${n}\n`));
    assert.equal(fs.existsSync(fault), false);
    assert.deepEqual(await docker(['version']), { code: 0, stderr: '' });
  });

  await check('a staged failure the test removes while a call is taking a line of it stays removed: that call fails, the next do not', async () => {
    fs.writeFileSync(fault, `${LINE}\n`.repeat(1000));
    const pause = fs.mkdtempSync(path.join(scratch, 'pause-'));
    fs.writeFileSync(path.join(pause, 'gate'), '');
    const call = docker(['version'], { node: ['--import', pathToFileURL(pauser).href], env: { PAUSE_ON: LINE, PAUSE_DIR: pause } });
    await until('the call to have read the fault', () => fs.existsSync(path.join(pause, 'read')));
    fs.rmSync(fault);
    fs.rmSync(path.join(pause, 'gate'));
    assert.deepEqual(await call, { code: 1, stderr: `${LINE}\n` });
    assert.equal(fs.existsSync(fault), false);
    assert.deepEqual(await docker(['version']), { code: 0, stderr: '' });
  });

  await check('a call still writing its line of calls.jsonl is no call yet: the calls before it are read whole', async () => {
    const calls = path.join(fakeDir, 'calls.jsonl');
    const script = 'echo up\n'.repeat(100);
    fs.rmSync(calls, { force: true });
    await docker(['version']);
    await docker(['exec', 'dn-x', '/bin/sh', '-c', script]);
    assert.deepEqual(dockerCalls(fakeDir), [['version'], ['exec', 'dn-x', '/bin/sh', '-c', script]]);
    // What a read sees while the second call's write is under way.
    fs.truncateSync(calls, fs.statSync(calls).size - 100);
    assert.deepEqual(dockerCalls(fakeDir), [['version']]);
  });

  console.log(`\nall ${checks} checks passed`);
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
