// What is held of the disk under a container's name against the stand-in docker, the run
// records above all, which outlive the container: counted with or without one, removed
// run by run and whole, and never reported gone while they are there.
// Run: node test/executor-container-records.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'dn-records-'));
const FAKE = fileURLToPath(new URL('./lib/fake-docker.mjs', import.meta.url));
const fakeDir = path.join(scratch, 'docker');
const imageDir = path.join(scratch, 'image');
const outside = path.join(scratch, 'outside');
for (const d of [fakeDir, imageDir, outside]) fs.mkdirSync(d);
fs.writeFileSync(path.join(imageDir, 'Dockerfile'), 'FROM scratch\n');
fs.writeFileSync(path.join(outside, 'kept.bin'), Buffer.alloc(2 ** 20, 1));
const BASE = path.join(scratch, 'base');
const MiB = 2 ** 20;
Object.assign(process.env, { DN_BASE_DIR: BASE, DN_DOCKER: FAKE, FAKE_DOCKER_DIR: fakeDir, DN_IMAGE_REPO: 'dn-test-agent', DN_CONTAINER_DISK_BYTES: String(4 * MiB) });
const { createContainers, containerName, docker, UNMEASURED_PASSES } = await import('../src/executor/container.js');
const { RUNS_DIR } = await import('../src/paths.js');

let checks = 0;
const check = async (name, fn) => { await fn(); checks++; console.log(`PASS ${name}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Long enough for a machine with every core taken many times over.
const until = async (what, fn, ms = 120000) => { for (const end = Date.now() + ms; Date.now() < end;) { if (await fn()) return; await sleep(25); } assert.fail(`never: ${what}`); };
const calls = (command) => fs.readFileSync(path.join(fakeDir, 'calls.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((c) => !command || c[0] === command);
const there = (...p) => fs.existsSync(path.join(fakeDir, ...p));
const volumeOf = (name) => name.replace('dn-', 'dn-work-');
const stage = (name, text = '') => fs.writeFileSync(path.join(fakeDir, name), text);
const unstage = (name) => fs.rmSync(path.join(fakeDir, name));
// Time for whatever waited for nothing to reach the engine.
const settle = async () => { for (let i = 0; i < 3; i++) await docker(['version']); };
// What a file system adds of its own to a file or a directory.
const slack = 2 ** 17;
const between = (n, least) => assert.ok(n >= least && n < least + slack, `${n} for ${least}`);

const logged = [];
const containers = createContainers({ log: (...a) => logged.push(a.join(' ')), imageDir, broker: () => ({ port: 4321 }) });
const PEER = 'pkAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const pool = (n) => ({ id: `github.com/dn-test/records-${n}` });
const records = (name) => path.join(RUNS_DIR, '.containers', name);
const probeOf = (name) => ['run', '--rm', '--name', `${name}-probe`, '--label', `dn.probe=${name}`, '--label', `dn.base=${BASE}`,
  '--network', 'none', '--read-only', '--cap-drop=ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '64', '--memory', '256m', '--memory-swap', '256m', '--cpus', '1'];
const clears = (name, image, ...what) => [...probeOf(name), '--cap-add=DAC_OVERRIDE', '--cap-add=FOWNER', '-v', `${records(name)}:/r`, image, 'find', ...what, '-delete'];
// A run's records as a job leaves them: its directory among its container's, a link to it among the runs.
function run(name, runId, bytes = 16) {
  fs.mkdirSync(path.join(records(name), runId));
  fs.writeFileSync(path.join(records(name), runId, 'log.jsonl'), Buffer.alloc(bytes, 1));
  fs.symlinkSync(path.join('.containers', name, runId), path.join(RUNS_DIR, runId));
}
// A pair's container made, a run's records left in it, and its last job gone: the records alone are left.
async function ended(n, runId, bytes) {
  const held = await containers.acquire({ pool: pool(n), peer: PEER, runId });
  run(held.name, runId, bytes);
  await containers.release({ name: held.name, runId });
  assert.deepEqual([there('containers', `${held.name}.json`), there('volumes', volumeOf(held.name)), fs.existsSync(path.join(records(held.name), runId))], [false, false, true]);
  return held;
}
// This user refused the removal of whatever is there under `dir`, as on what root made in
// a bind mount on Linux. Resolves to how many times it was.
async function denied(dir, fn) {
  const real = fs.promises.rm;
  let asked = 0;
  fs.promises.rm = (target, options) => (`${target}${path.sep}`.startsWith(`${dir}${path.sep}`) && fs.existsSync(target)
    ? (asked++, Promise.reject(Object.assign(new Error(`EACCES: permission denied, rmdir '${target}'`), { code: 'EACCES' })))
    : real(target, options));
  try { await fn(); } finally { fs.promises.rm = real; }
  return asked;
}
const nothingLeft = () => assert.deepEqual([fs.readdirSync(path.join(fakeDir, 'containers')), fs.readdirSync(path.join(RUNS_DIR, '.containers')), fs.readdirSync(RUNS_DIR)], [[], [], ['.containers']]);

try {
  await check('the run records a container left count under its name with no container there: measured, named once they are past the allowance, and discarded with the links to them', async () => {
    const { name, image } = await ended(1, 'run-1a', MiB);
    const other = await ended(11, 'run-1b');
    between(await containers.usage(name), MiB + 3 * 4096);
    assert.deepEqual(calls('run').at(-1), [...probeOf(name), '--cap-add=DAC_READ_SEARCH', '-v', `${records(name)}:/r:ro`, image, 'sh', '-c', 'du -sxB1 /r; du -sx --inodes /r']);
    assert.deepEqual(await containers.overQuota(), [], 'under its allowance nothing is named');
    fs.writeFileSync(path.join(records(name), 'run-1a', 'more.bin'), Buffer.alloc(4 * MiB, 1));
    const over = await containers.overQuota();
    assert.deepEqual(over.map((o) => [o.name, o.jobs]), [[name, []]]);
    between(over[0].bytes, 5 * MiB + 4 * 4096);
    await containers.discard(name);
    assert.deepEqual([fs.existsSync(records(name)), fs.readdirSync(RUNS_DIR).sort()], [false, ['.containers', 'run-1b']], 'its records and the links to them, and no other name\'s');
    assert.equal(logged.at(-1), `docker discarded ${name}`);
    assert.deepEqual(await containers.overQuota(), []);
    await containers.discard(other.name);
    nothingLeft();
  });

  await check('a volume the engine would not remove with its container counts under the name with the records', async () => {
    const p = pool(2);
    const held = await containers.acquire({ pool: p, peer: PEER, runId: 'run-2' });
    fs.writeFileSync(path.join(fakeDir, 'volumes', volumeOf(held.name), 'big.bin'), Buffer.alloc(5 * MiB, 1));
    stage('fail-volume-rm', 'Error response from daemon: remove: volume is in use\n');
    await containers.release({ name: held.name, runId: 'run-2' });
    assert.deepEqual([there('containers', `${held.name}.json`), there('volumes', volumeOf(held.name))], [false, true]);
    const over = await containers.overQuota();
    assert.deepEqual(over.map((o) => [o.name, o.jobs]), [[held.name, []]]);
    between(over[0].bytes, 5 * MiB + 3 * 4096);
    await containers.discard(held.name);
    assert.equal(there('volumes', volumeOf(held.name)), false);
    nothingLeft();
  });

  await check('one run\'s records are erased by this user when no container of the name is there, with nothing asked of the engine but that, and the other runs\' stay', async () => {
    const { name } = await ended(3, 'run-3a');
    run(name, 'run-3b');
    for (const [n, id] of [['../x', 'run-3a'], [`${name}-relay`, 'run-3a'], [`${name}-probe`, 'run-3a'], ['', 'run-3a'], [name, ''], [name, '..'], [name, '.'], [name, 'a/b'], [name, 'x'.repeat(65)]]) {
      const from = calls().length;
      assert.equal(await containers.erase(n, id), false, `${n} ${id}`);
      assert.equal(calls().length, from, 'nothing is asked for a name that is none');
    }
    assert.deepEqual(fs.readdirSync(records(name)).sort(), ['run-3a', 'run-3b']);
    const from = calls().length;
    assert.equal(await containers.erase(name, 'run-3a'), true);
    assert.deepEqual(calls().slice(from), [['container', 'inspect', '--format', '{{.Id}}', name]]);
    assert.deepEqual(fs.readdirSync(records(name)), ['run-3b']);
    assert.equal(await containers.erase(name, 'run-3a'), true, 'what is not there is gone');
    await containers.discard(name);
    nothingLeft();
  });

  await check('records this user may not delete are erased through the engine, which is given the container\'s records and told the run; what neither removed is said, still there, and erased the next time', async () => {
    const { name, image } = await ended(4, 'run-4a');
    run(name, 'run-4b');
    const target = path.join(records(name), 'run-4a');
    assert.equal(await denied(target, async () => assert.equal(await containers.erase(name, 'run-4a'), true)), 1);
    assert.deepEqual(calls('run').at(-1), clears(name, image, '/r/run-4a'));
    assert.deepEqual(fs.readdirSync(records(name)), ['run-4b']);

    stage('fail-run-find', 'docker: Error response from daemon: no space left on device\n');
    const said = logged.length;
    assert.equal(await denied(records(name), async () => assert.equal(await containers.erase(name, 'run-4b'), false)), 2);
    assert.deepEqual(logged.slice(said), [`docker the run records ${path.join(records(name), 'run-4b')} could not be removed: EACCES: permission denied, rmdir '${path.join(records(name), 'run-4b')}'`]);
    assert.equal(fs.existsSync(path.join(records(name), 'run-4b', 'log.jsonl')), true);
    assert.equal(await containers.erase(name, 'run-4b'), true);
    await containers.discard(name);
    nothingLeft();
  });

  await check('beside a container of the name a run\'s records are erased through the engine alone: this user walks nothing a job in it could move, and a link a job planted goes as a link', async () => {
    const { name, image } = await ended(5, 'run-5a');
    fs.symlinkSync(outside, path.join(records(name), 'run-5a', 'planted'));
    await containers.acquire({ pool: pool(5), peer: PEER, runId: 'run-5b' });
    const asked = await denied(records(name), async () => assert.equal(await containers.erase(name, 'run-5a'), true));
    assert.equal(asked, 0);
    assert.deepEqual(calls('run').at(-1), clears(name, image, '/r/run-5a'));
    assert.deepEqual([fs.existsSync(path.join(records(name), 'run-5a')), fs.readdirSync(outside)], [false, ['kept.bin']]);

    // An engine that does not answer has not said that no container is there.
    run(name, 'run-5c');
    stage('down');
    const unasked = await denied(records(name), async () => assert.equal(await containers.erase(name, 'run-5c'), false));
    unstage('down');
    assert.deepEqual([unasked, fs.existsSync(path.join(records(name), 'run-5c', 'log.jsonl'))], [0, true]);
    // Nor are records that cannot be looked at thereby gone: a job may close its records' directory.
    stage('fail-run-find', 'docker: Error response from daemon: no space left on device\n');
    fs.chmodSync(records(name), 0);
    try { assert.equal(await containers.erase(name, 'run-5c'), false); } finally { fs.chmodSync(records(name), 0o700); }
    await containers.release({ name, runId: 'run-5b' });
    await containers.discard(name);
    nothingLeft();
  });

  await check('a sweep that could not remove the records of a container that is gone says so, and they go on being counted', async () => {
    const { name } = await ended(6, 'run-6', 5 * MiB);
    fs.unlinkSync(path.join(RUNS_DIR, 'run-6'));
    stage('fail-run-find', 'docker: Error response from daemon: no space left on device\n');
    const said = logged.length;
    assert.equal(await denied(records(name), () => containers.sweep()), 2);
    assert.deepEqual(logged.slice(said).filter((l) => !l.includes('EACCES')), [`docker the run records of ${name} could not be removed: they are counted against its disk allowance until they are`]);
    assert.deepEqual((await containers.overQuota()).map((o) => [o.name, o.jobs]), [[name, []]]);
    const quiet = logged.length;
    await containers.sweep();
    assert.deepEqual([fs.existsSync(records(name)), logged.slice(quiet)], [false, []]);
    nothingLeft();
  });

  await check('the records of a container made while a sweep was looking are left to it', async () => {
    const p = pool(7);
    const name = containerName(p.id, PEER);
    // The sweep has listed the containers, without this one, and is held at the networks.
    stage('hold-network-ls');
    const listed = calls('network').filter((c) => c[1] === 'ls').length;
    const sweeping = containers.sweep();
    await until('the sweep is at the networks', () => calls('network').filter((c) => c[1] === 'ls').length > listed);
    const held = await containers.acquire({ pool: p, peer: PEER, runId: 'run-7' });
    const dir = fs.statSync(held.runsDir).ino;
    const from = calls('run').length;
    unstage('hold-network-ls');
    await sweeping;
    assert.deepEqual([fs.statSync(held.runsDir).ino, calls('run').length, there('containers', `${name}.json`)], [dir, from, true]);
    await containers.release({ name, runId: 'run-7' });
    await containers.discard(name);
    nothingLeft();
  });

  await check('the records under a container this daemon has put no job in are not this user\'s to walk: a sweep leaves them, kept run or none', async () => {
    const name = containerName(pool(13).id, PEER);
    execFileSync(FAKE, ['run', '-d', '--name', name, '--label', `dn.pool=${pool(13).id}`, '--label', `dn.peer=${PEER}`, '--label', `dn.base=${BASE}`, containers.dockerState().image, 'sleep', 'infinity']);
    fs.mkdirSync(path.join(records(name), 'left-by-a-job'), { recursive: true });
    const probes = calls('run').length;
    assert.equal(await denied(records(name), () => containers.sweep()), 0);
    assert.deepEqual([fs.readdirSync(records(name)), calls('run').length], [['left-by-a-job'], probes]);
    await containers.discard(name);
    nothingLeft();
  });

  await check(`a name the engine cannot size ${UNMEASURED_PASSES} passes running is named as past its allowance, with no number; a pass that sizes it, or finds it gone, starts the count again`, async () => {
    assert.equal(UNMEASURED_PASSES, 3);
    const p = pool(8);
    const { name } = await containers.acquire({ pool: p, peer: PEER, runId: 'run-8' });
    const why = 'docker: Error response from daemon: cannot start a stopped process';
    const unsized = (passes) => stage('fail-run-sh', `${why}\n`.repeat(passes));
    const pass = async () => {
      const said = logged.length;
      const over = await containers.overQuota();
      return [over, logged.slice(said)];
    };
    const missed = [[], [`docker the disk use of ${name} could not be measured: ${why}`]];
    unsized(2);
    assert.deepEqual([await pass(), await pass(), await pass()], [missed, missed, [[], []]], 'two misses and then a number');
    unsized(3);
    assert.deepEqual([await pass(), await pass()], [missed, missed], 'the misses before that number count for nothing');
    assert.deepEqual(await pass(), [[{ name, bytes: null, jobs: ['run-8'] }], missed[1]]);
    unsized(1);
    assert.deepEqual((await pass())[0], [{ name, bytes: null, jobs: ['run-8'] }], 'and it stays named while it stays unsized');

    // Gone from the engine and from the disk, and back: a name with no misses to it.
    await containers.release({ name, runId: 'run-8' });
    await containers.discard(name);
    assert.deepEqual(await pass(), [[], []]);
    await containers.acquire({ pool: p, peer: PEER, runId: 'run-8b' });
    unsized(2);
    assert.deepEqual([await pass(), await pass()], [missed, missed]);
    await containers.release({ name, runId: 'run-8b' });

    // Records alone, in a daemon that has no image to size them from, are no number either.
    run(name, 'run-8c');
    const said = [];
    const imageless = createContainers({ log: (...a) => said.push(a.join(' ')), imageDir });
    assert.deepEqual([await imageless.usage(name), said], [null, [`docker the disk use of ${name} could not be measured: docker: invalid reference format`]]);
    await containers.discard(name);
    nothingLeft();
  });

  await check('what a job planted among its files counts as the entries it is - a link to elsewhere, a pipe, a file of a terabyte of nothing - and is removed as those entries, with nothing it points at read or touched', async () => {
    const p = pool(9);
    const held = await containers.acquire({ pool: p, peer: PEER, runId: 'run-9' });
    run(held.name, 'run-9');
    const plant = (dir) => {
      fs.symlinkSync(outside, path.join(dir, 'link'));
      execFileSync('mkfifo', [path.join(dir, 'pipe')]);
      fs.writeFileSync(path.join(dir, 'sparse'), '');
      fs.truncateSync(path.join(dir, 'sparse'), 2 ** 40);
    };
    const before = await containers.usage(held.name);
    plant(path.join(fakeDir, 'volumes', volumeOf(held.name)));
    plant(path.join(records(held.name), 'run-9'));
    between(await containers.usage(held.name) - before, 6 * 4096);
    assert.deepEqual(await containers.overQuota(), []);
    await containers.release({ name: held.name, runId: 'run-9' });
    between(await containers.usage(held.name), 6 * 4096);
    await containers.discard(held.name);
    assert.deepEqual(fs.readdirSync(outside), ['kept.bin']);
    nothingLeft();
  });

  await check('the measuring and the clearing of one name take their turns: a clearing asked for while a measurement runs is started after it, not on top of it', async () => {
    const { name } = await ended(10, 'run-10a');
    await containers.acquire({ pool: pool(10), peer: PEER, runId: 'run-10b' });
    stage('hold-run-sh');
    const probes = calls('run').length;
    const measuring = containers.usage(name);
    await until('the measurement is with the engine', () => calls('run').length > probes);
    const erasing = containers.erase(name, 'run-10a');
    await until('the erasing has found the container there', () => calls('container').at(-1).join(' ') === `container inspect --format {{.Id}} ${name}`);
    await settle();
    assert.equal(calls('run').length, probes + 1, 'no second probe beside the first');
    unstage('hold-run-sh');
    assert.ok(await measuring > 0);
    assert.equal(await erasing, true);
    assert.deepEqual(calls('run').slice(probes).map((c) => c.at(-1)), ['du -sxB1 /v /r; du -sx --inodes /v /r', '-delete']);
    assert.deepEqual(calls('rm').filter((c) => c.includes(`${name}-probe`)), [], 'and no probe was taken for one left behind');
    await containers.release({ name, runId: 'run-10b' });
    await containers.discard(name);
    nothingLeft();
  });

  await check('a discard that left something says what and takes no link away: records it could not remove, a container the engine kept, an engine that does not answer', async () => {
    const { name } = await ended(12, 'run-12');
    const kept = () => [fs.existsSync(path.join(records(name), 'run-12', 'log.jsonl')), fs.readdirSync(RUNS_DIR).sort()];
    stage('fail-run-find', 'docker: Error response from daemon: no space left on device\n');
    await denied(records(name), () => assert.rejects(containers.discard(name), (e) => e.message === `the run records of ${name} could not be removed`));
    assert.deepEqual(kept(), [true, ['.containers', 'run-12']]);

    // One an earlier daemon left, which the engine will not remove.
    execFileSync(FAKE, ['run', '-d', '--name', name, '--label', `dn.pool=${pool(12).id}`, '--label', `dn.peer=${PEER}`, '--label', `dn.base=${BASE}`, containers.dockerState().image, 'sleep', 'infinity']);
    stage(`fail-rm-${name}`, 'Error response from daemon: removal of container is already in progress\n');
    await assert.rejects(containers.discard(name), (e) => e.message === `${name} could not be removed: the container ${name}`);
    assert.deepEqual(kept(), [true, ['.containers', 'run-12']]);
    execFileSync(FAKE, ['rm', '-f', name]);

    stage('down');
    await assert.rejects(containers.discard(name), (e) => e.message === `${name} could not be removed: the engine does not say that it is gone`);
    unstage('down');
    assert.deepEqual(kept(), [true, ['.containers', 'run-12']]);
    await containers.discard(name);
    nothingLeft();
  });

  console.log(`\nall ${checks} checks passed`);
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
process.exit(0);
