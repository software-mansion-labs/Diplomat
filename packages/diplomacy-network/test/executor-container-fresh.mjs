// A container against the stand-in docker, between its jobs: removed whole when its
// last job leaves and made anew for the next, in one turn after another under its name,
// so no job starts beside what a job that is over wrote or left running.
// Run: node test/executor-container-fresh.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { scratchDir } from './lib/scratch.mjs';

const scratch = scratchDir('dn-fresh-');
const FAKE = fileURLToPath(new URL('./lib/fake-docker.mjs', import.meta.url));
const fakeDir = path.join(scratch, 'docker');
const imageDir = path.join(scratch, 'image');
for (const d of [fakeDir, imageDir]) fs.mkdirSync(d);
fs.writeFileSync(path.join(imageDir, 'Dockerfile'), 'FROM scratch\n');
const BASE = path.join(scratch, 'base');
Object.assign(process.env, { DN_BASE_DIR: BASE, DN_DOCKER: FAKE, FAKE_DOCKER_DIR: fakeDir, DN_IMAGE_REPO: 'dn-test-agent', DN_CONTAINER_IDLE_MS: '3600000' });
const CONTAINER_JS = new URL('../src/executor/container.js', import.meta.url).href;
const { createContainers, containerName, docker } = await import(CONTAINER_JS);

let checks = 0;
const check = async (name, fn) => { await fn(); checks++; console.log(`PASS ${name}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Long enough for a machine with every core taken many times over.
const until = async (what, fn, ms = 120000) => { for (const end = Date.now() + ms; Date.now() < end;) { if (await fn()) return; await sleep(25); } assert.fail(`never: ${what}`); };
const calls = () => fs.readFileSync(path.join(fakeDir, 'calls.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
// What was removed or made on the engine since call `from`, in order, each by its first words.
const acted = (from) => calls().slice(from).filter((c) => c.includes('rm') || c[0] === 'run' || c[0] === 'create' || c[1] === 'create').map((c) => c.slice(0, 2).join(' '));
const there = (...p) => fs.existsSync(path.join(fakeDir, ...p));
const volumeOf = (name) => name.replace('dn-', 'dn-work-');
const stage = (name, text = '') => fs.writeFileSync(path.join(fakeDir, name), text);
const unstage = (name) => fs.rmSync(path.join(fakeDir, name));
// Time for whatever waited for nothing to reach the engine.
const settle = async () => { for (let i = 0; i < 3; i++) await docker(['version']); };

const logged = [];
const clock = { now: Date.now() };
const containers = createContainers({ log: (...a) => logged.push(a.join(' ')), now: () => clock.now, imageDir, broker: () => ({ port: 4321 }) });
const PEER = 'pkAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const pool = (n) => ({ id: `github.com/dn-test/fresh-${n}` });
const labels = (p) => ['--label', `dn.pool=${p.id}`, '--label', `dn.peer=${PEER}`, '--label', `dn.base=${BASE}`];
const WHOLE = ['rm -f', 'rm -f', 'network rm', 'volume rm'];
const MADE = ['network create', 'create --name', 'volume create', 'run -d'];

try {
  await check('a job that comes while its pair\'s container is being removed waits for that and has one made after it: it does not join the one that is going', async () => {
    const p = pool(1);
    const name = containerName(p.id, PEER);
    const { image } = await containers.acquire({ pool: p, peer: PEER, runId: 'one' });
    fs.writeFileSync(path.join(fakeDir, 'volumes', volumeOf(name), 'left-by-a-job'), 'x');
    // A measurement cut off has left its probe beside the container, the volume mounted in it.
    execFileSync(FAKE, ['run', '-d', '--name', `${name}-probe`, '--label', `dn.probe=${name}`, '--label', `dn.base=${BASE}`, image, 'sleep', 'infinity']);
    // The engine holds its answer to whatever ends the container.
    for (const held of ['hold-rm', 'hold-restart']) stage(held);
    const from = calls().length;
    const leaving = containers.release({ name, runId: 'one' });
    await until('the engine is asked to end the container', () => calls().slice(from).some((c) => c[0] === 'rm' || c[0] === 'restart'));
    const coming = containers.acquire({ pool: p, peer: PEER, runId: 'two' });
    await settle();
    assert.deepEqual(acted(from), ['rm -f'], 'nothing is made, and nothing is joined, while the removal is under way');
    for (const held of ['hold-rm', 'hold-restart']) unstage(held);
    await leaving;
    assert.deepEqual((await coming).name, name);
    assert.deepEqual(acted(from), ['rm -f', ...WHOLE, ...MADE], 'the container, its relay and the probe, then the network and the volume');
    assert.deepEqual([there('volumes', volumeOf(name), 'left-by-a-job'), there('containers', `${name}-probe.json`)], [false, false]);
    assert.deepEqual(containers.list().map((c) => c.jobs), [['two']]);
    await containers.release({ name, runId: 'two' });
  });

  await check('a job on its way when the last one leaves has the container made anew, and the release that follows takes nothing from it', async () => {
    const p = pool(2);
    const name = containerName(p.id, PEER);
    await containers.acquire({ pool: p, peer: PEER, runId: 'one' });
    // The newcomer is held where it asks after the image, ahead of the release in the container's turns.
    stage('hold-version');
    const versions = calls().filter((c) => c[0] === 'version').length;
    const from = calls().length;
    const coming = containers.acquire({ pool: p, peer: PEER, runId: 'two' });
    await until('the newcomer is asking the engine', () => calls().filter((c) => c[0] === 'version').length > versions);
    const leaving = containers.release({ name, runId: 'one' });
    unstage('hold-version');
    await Promise.all([coming, leaving]);
    assert.deepEqual(acted(from), [...WHOLE, ...MADE], 'removed once, by the newcomer, and made once');
    assert.equal(there('containers', `${name}.json`), true);
    assert.deepEqual(containers.list().map((c) => c.jobs), [['two']]);
    await containers.release({ name, runId: 'two' });
    assert.equal(there('containers', `${name}.json`), false);
    assert.equal(logged.at(-1), `docker removed ${name} with its last job`);
  });

  await check('a volume left under a pair\'s name with no container is not handed to that pair\'s next job', async () => {
    const p = pool(3);
    const name = containerName(p.id, PEER);
    execFileSync(FAKE, ['volume', 'create', ...labels(p), volumeOf(name)]);
    fs.writeFileSync(path.join(fakeDir, 'volumes', volumeOf(name), 'left-by-a-job'), 'x');
    const from = calls().length;
    await containers.acquire({ pool: p, peer: PEER, runId: 'one' });
    assert.deepEqual(acted(from), ['volume rm', ...MADE]);
    assert.equal(there('volumes', volumeOf(name), 'left-by-a-job'), false);
    await containers.release({ name, runId: 'one' });
  });

  await check('what the engine would not remove when the last job left is said, removed at the next sweep, and until it is gone no job is started beside it', async () => {
    const p = pool(4);
    const name = containerName(p.id, PEER);
    await containers.acquire({ pool: p, peer: PEER, runId: 'one' });
    fs.writeFileSync(path.join(fakeDir, 'volumes', volumeOf(name), 'left-by-a-job'), 'x');
    stage('fail-volume-rm', 'Error response from daemon: remove: volume is in use\nError response from daemon: remove: volume is in use\n');
    const said = logged.length;
    await containers.release({ name, runId: 'one' });
    assert.deepEqual(logged.slice(said), [`docker ${name} has no job left in it and is still there: the engine would not remove the volume ${volumeOf(name)}`]);
    assert.deepEqual(containers.list(), [{ name, image: containers.dockerState().image, jobs: [] }]);
    const from = calls().length;
    await assert.rejects(containers.acquire({ pool: p, peer: PEER, runId: 'two' }),
      (e) => e.name === 'Error' && e.message === `what earlier jobs left under ${name} could not be removed (the volume ${volumeOf(name)}), and no job is started beside it`);
    assert.deepEqual(acted(from), ['volume rm'], 'nothing was made on it');
    assert.equal(there('volumes', volumeOf(name), 'left-by-a-job'), true);
    // The engine takes it now: the sweep does not wait for it to have been idle.
    await containers.sweep();
    assert.equal(there('volumes', volumeOf(name)), false);
    assert.deepEqual(containers.list(), []);
    await containers.acquire({ pool: p, peer: PEER, runId: 'three' });
    await containers.release({ name, runId: 'three' });
  });

  await check('a container the engine would not remove when its last job left goes at the first sweep that can remove it, with no idle time waited: it is not one an earlier daemon left', async () => {
    const p = pool(6);
    const name = containerName(p.id, PEER);
    await containers.acquire({ pool: p, peer: PEER, runId: 'one' });
    stage(`fail-rm-${name}`, 'Error response from daemon: removal of container is already in progress\n'.repeat(2));
    await containers.release({ name, runId: 'one' });
    assert.equal(logged.at(-1), `docker ${name} has no job left in it and is still there: the engine would not remove the container ${name}, the network ${name}`);
    await containers.sweep();
    assert.deepEqual([there('containers', `${name}.json`), containers.list().map((c) => c.name)], [true, [name]], 'refused again, and still this daemon\'s to remove');
    await containers.sweep();
    assert.deepEqual([there('containers', `${name}.json`), there('networks', `${name}.json`), containers.list()], [false, false, []]);
  });

  await check('a container lost from under its jobs is left to their release: a sweep takes nothing of it while one is counted, and the last to leave takes what is left', async () => {
    const p = pool(5);
    const name = containerName(p.id, PEER);
    await containers.acquire({ pool: p, peer: PEER, runId: 'one' });
    execFileSync(FAKE, ['rm', '-f', name]);
    const from = calls().length;
    clock.now += 10 * 3600 * 1000;
    await containers.sweep();
    assert.deepEqual(acted(from), []);
    await assert.rejects(containers.acquire({ pool: p, peer: PEER, runId: 'two' }), /^Error: container \S+ is gone with 1 job\(s\) in it$/);
    await containers.release({ name, runId: 'one' });
    assert.deepEqual(acted(from), ['rm -f', 'network rm', 'volume rm']);
    assert.deepEqual(['containers', 'networks', 'volumes'].map((kind) => fs.readdirSync(path.join(fakeDir, kind))), [[], [], []]);
  });

  await check('a volume is given as long to go as a container\'s files are given to be counted, and one the engine is still removing then is left to the sweep', async () => {
    const dir = fs.mkdtempSync(path.join(scratch, 'child-'));
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', `
      const { createContainers } = await import(${JSON.stringify(CONTAINER_JS)});
      const fs = await import('node:fs');
      const at = process.env.FAKE_DOCKER_DIR;
      const said = [];
      const c = createContainers({ log: (...a) => said.push(a.join(' ')), imageDir: ${JSON.stringify(imageDir)}, broker: () => ({ port: 1 }) });
      const held = await c.acquire({ pool: { id: 'github.com/o/r' }, peer: 'pk', runId: 'r' });
      fs.writeFileSync(at + '/hold-volume-rm', '');
      const asked = () => fs.readFileSync(at + '/calls.jsonl', 'utf8').includes('["volume","rm"');
      const leaving = c.release({ name: held.name, runId: 'r' });
      for (const end = Date.now() + 60000; !asked();) {
        if (Date.now() > end) throw new Error('never: the engine asked to remove the volume');
        await new Promise((r) => setTimeout(r, 20));
      }
      const from = Date.now();
      await leaving;
      console.log(JSON.stringify({ ms: Date.now() - from, said: said.at(-1), jobs: c.list().map((e) => e.jobs) }));`],
    { env: { ...process.env, DN_BASE_DIR: path.join(dir, 'base'), FAKE_DOCKER_DIR: path.join(dir, 'docker'), DN_CONTAINER_USAGE_TIMEOUT_MS: '300' }, encoding: 'utf8' });
    const { ms, said, jobs } = JSON.parse(out);
    // Cut off at the 300 ms a measurement gets here, not at the minute any other call gets.
    assert.ok(ms < 30000, `${ms} ms`);
    assert.match(said, /^docker dn-\S+ has no job left in it and is still there: the engine would not remove the volume dn-work-\S+$/);
    assert.deepEqual(jobs, [[]]);
  });

  console.log(`\nall ${checks} checks passed`);
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
process.exit(0);
