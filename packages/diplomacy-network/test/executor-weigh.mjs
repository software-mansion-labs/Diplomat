// How a machine weighs a task against what it has: work on an Android project waits
// half a minute on a machine with no device to give, and nothing else waits. On
// checkouts made here, with a clock this test moves.
// Run: node test/executor-weigh.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'dn-weigh-'));
process.env.DN_BASE_DIR = path.join(scratch, 'base');
const { createWeighing, looksLikeAndroid } = await import('../src/executor/weigh.js');

let checks = 0;
const check = (name, fn) => { fn(); checks++; console.log(`PASS ${name}`); };

// A checkout holding `files`; a name that ends in a slash is a directory.
let made = 0;
function checkout(files) {
  const dir = path.join(scratch, `checkout-${made++}`);
  fs.mkdirSync(dir);
  for (const file of files) {
    if (file.endsWith('/')) fs.mkdirSync(path.join(dir, file), { recursive: true });
    else {
      fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      fs.writeFileSync(path.join(dir, file), '');
    }
  }
  return dir;
}
const task = (pool) => ({ pool, taskId: 't1', kind: 'issues', item: 'issue-1', title: 'Fix the crash on start', hours: 12 });

try {
  check('a checkout looks like Android work by an android directory, an app manifest or a Gradle build at its root, and by nothing else', () => {
    for (const mark of ['android/', 'android/app/build.gradle', 'app/src/main/AndroidManifest.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts']) {
      assert.equal(looksLikeAndroid(checkout(['README.md', mark])), true, mark);
    }
    for (const none of [[], ['README.md', 'package.json', 'src/index.js'], ['android'], ['docs/android/'], ['lib/build.gradle'], ['build.gradle/'], ['src/main/AndroidManifest.xml'], ['ios/', 'Podfile']]) {
      assert.equal(looksLikeAndroid(checkout(none)), false, JSON.stringify(none));
    }
    assert.equal(looksLikeAndroid(path.join(scratch, 'no-such-checkout')), false);
  });

  check('Android work waits half a minute on a machine with no device to give, and not at all on one with a device; other work waits nowhere', () => {
    const checkouts = { 'github.com/acme/app': checkout(['android/', 'package.json']), 'github.com/acme/site': checkout(['package.json']) };
    let device = false;
    const weigh = createWeighing({ checkoutOf: (pool) => checkouts[pool] ?? null, hasDevice: () => device });
    // Devices switched off, or switched on with nothing attached: none to give.
    assert.deepEqual([weigh(task('github.com/acme/app')), weigh(task('github.com/acme/site'))], [30000, 0]);
    device = true;
    assert.deepEqual([weigh(task('github.com/acme/app')), weigh(task('github.com/acme/site'))], [0, 0]);
    device = false;
    assert.equal(weigh(task('github.com/acme/app')), 30000, 'a device that went is one to wait for again');
    assert.equal(weigh(task('github.com/acme/gone')), 0, 'a pool with no checkout here is weighed as nothing');
    assert.equal(createWeighing({ checkoutOf: () => checkouts['github.com/acme/app'], hasDevice: () => false, waitMs: 7 })(task('x')), 7);
  });

  check('a checkout is read once and again an hour later, and at once when the pool is linked to another one', () => {
    const dir = checkout(['package.json']);
    const clock = { now: 1_800_000_000_000 };
    let linked = dir;
    const weigh = createWeighing({ checkoutOf: () => linked, hasDevice: () => false, now: () => clock.now });
    const pool = task('github.com/acme/app');
    assert.equal(weigh(pool), 0);
    fs.mkdirSync(path.join(dir, 'android'));
    clock.now += 3600 * 1000 - 1;
    assert.equal(weigh(pool), 0, 'within the hour it is as it was read');
    clock.now += 1;
    assert.equal(weigh(pool), 30000);
    linked = checkout(['package.json']);
    assert.equal(weigh(pool), 0, 'another checkout is another answer');
    linked = null;
    assert.equal(weigh(pool), 0, 'and no checkout is nothing to wait for');
  });

  console.log(`\nall ${checks} checks passed`);
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
