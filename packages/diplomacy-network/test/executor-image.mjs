// The images a daemon leaves behind, against the stand-in docker: one it built goes at a
// sweep once jobs are started in another and no container is of it; nothing else on the
// engine is touched.
// Run: node test/executor-image.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'dn-image-'));
const FAKE = fileURLToPath(new URL('./lib/fake-docker.mjs', import.meta.url));
const fakeDir = path.join(scratch, 'docker');
const imageDir = path.join(scratch, 'image');
for (const d of [fakeDir, imageDir]) fs.mkdirSync(d);
fs.writeFileSync(path.join(imageDir, 'Dockerfile'), 'FROM scratch\n');
const BASE = path.join(scratch, 'base');
Object.assign(process.env, { DN_BASE_DIR: BASE, DN_DOCKER: FAKE, FAKE_DOCKER_DIR: fakeDir, DN_IMAGE_REPO: 'dn-test-agent' });
const { createContainers, imageTag } = await import('../src/executor/container.js');

let checks = 0;
const check = async (name, fn) => { await fn(); checks++; console.log(`PASS ${name}`); };
const calls = (...first) => fs.readFileSync(path.join(fakeDir, 'calls.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  .filter((c) => first.every((word, i) => c[i] === word));
const images = () => fs.readdirSync(path.join(fakeDir, 'images')).map(decodeURIComponent).sort();
const stage = (name, text = '') => fs.writeFileSync(path.join(fakeDir, name), text);
const build = (tag, ...label) => execFileSync(FAKE, ['build', ...label, '-t', tag, imageDir], { stdio: 'ignore' });

const logged = [];
const containers = createContainers({ log: (...a) => logged.push(a.join(' ')), imageDir, broker: () => ({ port: 4321 }) });
const PEER = 'pkAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const pool = (n) => ({ id: `github.com/dn-test/image-${n}` });
const MINE = `dn.base=${BASE}`;
// The image changes, and the next job has the one that is built from it.
const edit = () => { fs.appendFileSync(path.join(imageDir, 'Dockerfile'), 'RUN true\n'); return imageTag(imageDir); };

try {
  await check('an image this daemon built goes at a sweep once jobs are started in another and no container is of it; nothing else does', async () => {
    const first = await containers.ensureImage();
    const held = await containers.acquire({ pool: pool(1), peer: PEER, runId: 'one' });
    assert.equal(held.image, first);
    const second = edit();
    const beside = await containers.acquire({ pool: pool(2), peer: PEER, runId: 'two' });
    assert.equal(beside.image, second);
    // Not this daemon's to remove: another daemon's image, one that carries no label,
    // and what the operator built on top of this daemon's, which carries its label.
    build('dn-test-agent:theirs', '--label', 'dn.base=/somewhere/else');
    build('dn-test-agent:unlabelled');
    for (const derived of ['operators/own:latest', 'dn-test-agent-mine:latest', 'registry.example/dn-test-agent:1']) build(derived, '--label', MINE);
    const others = ['dn-test-agent-mine:latest', 'dn-test-agent:theirs', 'dn-test-agent:unlabelled', 'operators/own:latest', 'registry.example/dn-test-agent:1'];
    assert.deepEqual(images(), [first, second, ...others].sort());

    const said = logged.length;
    await containers.sweep();
    assert.deepEqual(images(), [first, second, ...others].sort(), 'a container is of the first');
    assert.deepEqual(calls('image', 'rm'), [['image', 'rm', first]], 'asked for without force, and for nothing else');
    assert.deepEqual(logged.slice(said), []);

    await containers.release({ name: held.name, runId: 'one' });
    await containers.sweep();
    assert.deepEqual(images(), [second, ...others].sort());
    assert.deepEqual(logged.slice(said).filter((l) => l.includes('image')), [`docker removed the image ${first}: jobs are started in ${second}`]);
    const asked = calls('image', 'rm').length;
    await containers.sweep();
    assert.equal(calls('image', 'rm').length, asked, 'and the one jobs are started in is not asked for');
    await containers.release({ name: beside.name, runId: 'two' });
  });

  await check('no image goes while the one jobs are started in is not there: not built yet, or not building', async () => {
    const good = await containers.ensureImage();
    // A daemon that has not looked at its image yet.
    const early = createContainers({ imageDir, broker: () => ({ port: 4321 }) });
    await early.sweep();
    assert.ok(images().includes(good));
    // An image that will not build: the last one that did stays.
    const broken = edit();
    stage('fail-build', 'ERROR: failed to solve: process "/bin/sh -c false" did not complete successfully');
    await assert.rejects(containers.ensureImage(), /the image did not build/);
    assert.deepEqual([containers.dockerState().state, containers.dockerState().image], ['failed', broken]);
    await containers.sweep();
    assert.ok(images().includes(good), 'the last image that built is kept');
    assert.equal(await containers.ensureImage(), broken);
    await containers.sweep();
    assert.deepEqual([images().includes(good), images().includes(broken)], [false, true]);
  });

  console.log(`\nall ${checks} checks passed`);
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
