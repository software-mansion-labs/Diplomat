// Disk held under a container's name, against the stand-in docker: run records above all,
// which outlive the container - counted with or without one, removed run by run and whole,
// never reported gone while there - and unlinked-but-open files, counted by the real
// held.cjs where this machine gives a pid namespace to run it in.
// Run: node test/executor-container-records.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { scratchDir } from './lib/scratch.mjs';

const scratch = scratchDir('dn-records-');
const FAKE = fileURLToPath(new URL('./lib/fake-docker.mjs', import.meta.url));
const fakeDir = path.join(scratch, 'docker');
const imageDir = path.join(scratch, 'image');
const outside = path.join(scratch, 'outside');
for (const d of [fakeDir, imageDir, outside]) fs.mkdirSync(d);
fs.writeFileSync(path.join(imageDir, 'Dockerfile'), 'FROM scratch\n');
fs.writeFileSync(path.join(outside, 'kept.bin'), Buffer.alloc(2 ** 20, 1));
const BASE = path.join(scratch, 'base');
const MiB = 2 ** 20;
Object.assign(process.env, { DN_BASE_DIR: BASE, DN_DOCKER: FAKE, FAKE_DOCKER_DIR: fakeDir, DN_IMAGE_REPO: 'dn-test-agent', DN_CONTAINER_DISK_BYTES: String(4 * MiB), DN_CONTAINER_HELD_TIMEOUT_MS: '1500' });
const { createContainers, containerName, docker, UNMEASURED_PASSES } = await import('../src/executor/container.js');
const { RUNS_DIR } = await import('../src/paths.js');
const HELD_CJS = fileURLToPath(new URL('../src/executor/held.cjs', import.meta.url));
const HELD = fs.readFileSync(HELD_CJS, 'utf8');

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
    assert.deepEqual(calls('run').at(-1), [...probeOf(name), '--cap-add=DAC_READ_SEARCH', '-v', `${records(name)}:/r:ro`, image, 'sh', '-c', 'du -sxB1 /r 2>/dev/null; du -sx --inodes /r 2>/dev/null']);
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
    // With no volume and no records it holds its writable layer, which the engine says
    // itself, and it is named past its allowance like any other: the one probe beside it
    // looks at its processes, and mounts nothing.
    fs.writeFileSync(path.join(fakeDir, 'roots', name, 'layer.bin'), Buffer.alloc(5 * MiB, 1));
    const mounting = () => calls('run').filter((c) => c.includes('-v')).length;
    const probes = mounting();
    between(await containers.usage(name), 5 * MiB);
    assert.deepEqual((await containers.overQuota()).map((o) => [o.name, o.jobs]), [[name, []]]);
    stage(`held-${name}`, `held ${MiB}\n`);
    between(await containers.usage(name), 6 * MiB);
    unstage(`held-${name}`);
    fs.mkdirSync(path.join(records(name), 'left-by-a-job'), { recursive: true });
    assert.equal(await denied(records(name), () => containers.sweep()), 0);
    assert.deepEqual([fs.readdirSync(records(name)), mounting()], [['left-by-a-job'], probes]);
    await containers.discard(name);
    nothingLeft();
  });

  await check('a container\'s records directory is this user\'s, made before the engine is asked for the container: one the engine has to make for a mount is root\'s on Linux', async () => {
    const name = containerName(pool(14).id, PEER);
    stage('fail-run', 'docker: Error response from daemon: no space left on device\n');
    await assert.rejects(containers.acquire({ pool: pool(14), peer: PEER, runId: 'run-14' }), /^OwnFault: docker run: docker: Error response from daemon: no space left on device$/);
    assert.equal(fs.statSync(records(name)).uid, process.getuid());
    await containers.sweep();
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

    // A daemon that has no image of its own sizes a container from the container's, and
    // records alone from nothing: no number.
    const said = [];
    const imageless = createContainers({ log: (...a) => said.push(a.join(' ')), imageDir });
    assert.deepEqual([await imageless.usage(name), said], [await containers.usage(name), []]);
    await containers.release({ name, runId: 'run-8b' });
    run(name, 'run-8c');
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
    const { name } = await containers.acquire({ pool: pool(10), peer: PEER, runId: 'run-10b' });
    run(name, 'run-10a');
    stage('hold-run-sh');
    // After the probe that looks at the container's processes.
    const probes = calls('run').length + 1;
    const measuring = containers.usage(name);
    await until('the measurement is with the engine', () => calls('run').length > probes);
    const erasing = containers.erase(name, 'run-10a');
    await until('the erasing has found the container there', () => calls('container').at(-1).join(' ') === `container inspect --format {{.Id}} ${name}`);
    await settle();
    assert.equal(calls('run').length, probes + 1, 'no second probe beside the first');
    unstage('hold-run-sh');
    assert.ok(await measuring > 0);
    assert.equal(await erasing, true);
    assert.deepEqual(calls('run').slice(probes).map((c) => c.at(-1)), ['du -sxB1 /v /r 2>/dev/null; du -sx --inodes /v /r 2>/dev/null', '-delete']);
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

    // A volume the engine keeps, the container gone.
    execFileSync(FAKE, ['volume', 'create', '--label', `dn.pool=${pool(12).id}`, '--label', `dn.peer=${PEER}`, '--label', `dn.base=${BASE}`, volumeOf(name)]);
    stage('fail-volume-rm', 'Error response from daemon: remove: volume is in use\n');
    await assert.rejects(containers.discard(name), (e) => e.message === `${name} could not be removed: the volume ${volumeOf(name)}`);
    assert.deepEqual(kept(), [true, ['.containers', 'run-12']]);

    stage('down');
    await assert.rejects(containers.discard(name), (e) => e.message === `${name} could not be removed: the engine does not say that it is gone`);
    unstage('down');
    assert.deepEqual(kept(), [true, ['.containers', 'run-12']]);
    await containers.discard(name);
    nothingLeft();
  });

  await check('a pair\'s next container is shown none of what its earlier one left among the run records: they are moved aside whole, where the run\'s link still leads, counted under the name, erased run by run, and gone with their last kept run', async () => {
    const { name, image } = await ended(15, 'run-15a', MiB);
    fs.writeFileSync(path.join(records(name), 'planted-by-job-1.sh'), '#!/bin/sh\n');
    await containers.sweep();
    // The run ended an hour ago, and a daemon that went while it led a link elsewhere left its start.
    const ended15a = new Date(Date.now() - 3600 * 1000);
    fs.lutimesSync(path.join(RUNS_DIR, 'run-15a'), ended15a, ended15a);
    fs.symlinkSync('nowhere', path.join(RUNS_DIR, 'run-15a.aside'));
    const next = await containers.acquire({ pool: pool(15), peer: PEER, runId: 'run-15b' });
    const made = calls('run').at(-1);
    assert.deepEqual([next.runsDir, made.includes(`${records(name)}:/dn/runs`)], [records(name), true], 'the directory its jobs are given is the one it is shown');
    assert.deepEqual(fs.readdirSync(records(name)), [], 'and nothing is in it');
    const aside = `${name}.1`;
    assert.deepEqual(fs.readdirSync(records(aside)).sort(), ['planted-by-job-1.sh', 'run-15a']);
    assert.deepEqual([fs.readlinkSync(path.join(RUNS_DIR, 'run-15a')), fs.readFileSync(path.join(RUNS_DIR, 'run-15a', 'log.jsonl')).length], [path.join('.containers', aside, 'run-15a'), MiB]);
    assert.deepEqual([Math.round(fs.lstatSync(path.join(RUNS_DIR, 'run-15a')).mtimeMs), fs.readdirSync(RUNS_DIR).sort()], [ended15a.getTime(), ['.containers', 'run-15a']], 'the link is as old as it was, which is what its run is kept by');
    assert.ok(calls().every((c) => !c.includes(aside) && !c.includes(`${aside}-probe`)), 'no container, network, volume or probe is of that name');
    run(name, 'run-15b', MiB);
    between(await containers.usage(name), 2 * MiB + 7 * 4096);
    assert.deepEqual(calls('run').at(-1), [...probeOf(name), '--cap-add=DAC_READ_SEARCH', '-v', `${volumeOf(name)}:/v:ro`, '-v', `${records(name)}:/r:ro`, '-v', `${records(aside)}:/r1:ro`,
      image, 'sh', '-c', 'du -sxB1 /v /r /r1 2>/dev/null; du -sx --inodes /v /r /r1 2>/dev/null']);
    // A second container after it, and a third: each earlier one's records in a directory of their own.
    await containers.release({ name, runId: 'run-15b' });
    // As a daemon left them that ended between leading the link and moving the directory.
    fs.unlinkSync(path.join(RUNS_DIR, 'run-15b'));
    fs.symlinkSync(path.join('.containers', `${name}.2`, 'run-15b'), path.join(RUNS_DIR, 'run-15b'));
    await containers.acquire({ pool: pool(15), peer: PEER, runId: 'run-15c' });
    assert.deepEqual(fs.readdirSync(path.join(RUNS_DIR, '.containers')).sort(), [name, aside, `${name}.2`]);
    assert.equal(fs.readFileSync(path.join(RUNS_DIR, 'run-15b', 'log.jsonl')).length, MiB, 'the directory went where the link led');
    assert.deepEqual([fs.readdirSync(records(name)), fs.readdirSync(records(`${name}.2`))], [[], ['run-15b']]);
    fs.writeFileSync(path.join(records(aside), 'run-15a', 'more.bin'), Buffer.alloc(3 * MiB, 1));
    const over = await containers.overQuota();
    assert.deepEqual(over.map((o) => [o.name, o.jobs]), [[name, ['run-15c']]], 'what was moved aside counts under the one name, with the container that stands');
    between(over[0].bytes, 5 * MiB + 9 * 4096);
    // As the keeper of the runs erases one: by the directory its link leads into.
    const from = calls().length;
    assert.equal(await containers.erase(aside, 'run-15a'), true);
    assert.deepEqual(calls().slice(from), [], 'no container shows that directory to a job: nothing is asked of the engine');
    fs.unlinkSync(path.join(RUNS_DIR, 'run-15a'));
    await containers.sweep();
    assert.deepEqual(fs.readdirSync(path.join(RUNS_DIR, '.containers')).sort(), [name, `${name}.2`], 'with no run kept in it the directory goes, with what else a job left there');
    // Records this user may not delete go through the engine, under the pair's own probe.
    fs.unlinkSync(path.join(RUNS_DIR, 'run-15b'));
    const probes = calls('run').length;
    await denied(records(`${name}.2`), () => containers.sweep());
    assert.deepEqual(calls('run').slice(probes), [[...probeOf(name), '--cap-add=DAC_OVERRIDE', '--cap-add=FOWNER', '-v', `${records(`${name}.2`)}:/r`, image, 'find', '/r', '-mindepth', '1', '-delete']]);
    // And all of a name's records go with the name.
    await containers.release({ name, runId: 'run-15c' });
    run(name, 'run-15d');
    await (await containers.acquire({ pool: pool(15), peer: PEER, runId: 'run-15e' }), containers.release({ name, runId: 'run-15e' }));
    assert.deepEqual(fs.readdirSync(RUNS_DIR).sort(), ['.containers', 'run-15d']);
    assert.equal(fs.readlinkSync(path.join(RUNS_DIR, 'run-15d')).split(path.sep)[1], `${name}.3`);
    // With no container and no directory of the name's own, what was moved aside is still its.
    await containers.sweep();
    assert.deepEqual(fs.readdirSync(path.join(RUNS_DIR, '.containers')), [`${name}.3`]);
    fs.writeFileSync(path.join(records(`${name}.3`), 'run-15d', 'more.bin'), Buffer.alloc(4 * MiB, 1));
    assert.deepEqual((await containers.overQuota()).map((o) => [o.name, o.jobs]), [[name, []]]);
    await containers.discard(name);
    nothingLeft();
  });

  await check('a file a process of the container keeps open under no name counts under the name for as long as the container runs: one past its allowance by that alone is named, and a count the job ended leaves it unmeasured', async () => {
    const { name, image } = await containers.acquire({ pool: pool(16), peer: PEER, runId: 'run-16' });
    run(name, 'run-16');
    const named = await containers.usage(name);
    // The stand-in's word for 5 MiB written, kept open and unlinked: no file is left to count.
    stage(`held-${name}`, `held ${5 * MiB}\n`);
    const from = calls('run').length;
    assert.equal(await containers.usage(name), named + 5 * MiB);
    assert.deepEqual(calls('run')[from], [...probeOf(name), '--pid', `container:${name}`, '--cap-add=DAC_READ_SEARCH', '--cap-add=SYS_PTRACE', image, 'node', '-e', HELD]);
    assert.deepEqual(await containers.overQuota(), [{ name, bytes: named + 5 * MiB, jobs: ['run-16'] }]);
    // Killed before it printed, and saying that it could not look: neither is a count.
    // So is one that writes on past what a probe has to say: it is heard no further.
    for (const [answer, why] of [['', 'no answer'], ['blind\n', 'blind'], ['held 1\n'.repeat(20000), 'no answer']]) {
      stage(`held-${name}`, answer);
      const said = logged.length;
      assert.equal(await containers.usage(name), null);
      assert.deepEqual(logged.slice(said), [`docker what the processes of ${name} hold open could not be counted: ${why}`]);
    }
    assert.deepEqual([await containers.overQuota(), await containers.overQuota(), await containers.overQuota()], [[], [], [{ name, bytes: null, jobs: ['run-16'] }]]);
    // One the job stopped is waited for CONTAINER_HELD_TIMEOUT_MS, not as long as a measurement of the disk.
    stage(`held-${name}`, `held ${MiB}\n`);
    stage('hold-run-node');
    const began = Date.now();
    const said = logged.length;
    assert.equal(await containers.usage(name), null);
    assert.ok(Date.now() - began < 10000, `${Date.now() - began} ms`);
    assert.deepEqual(logged.slice(said), [`docker what the processes of ${name} hold open could not be counted: no answer`]);
    unstage('hold-run-node');
    assert.equal(await containers.usage(name), named + MiB);
    // A container that stopped has no process to hold a file, and no pid namespace to look into.
    const record = path.join(fakeDir, 'containers', `${name}.json`);
    fs.writeFileSync(record, JSON.stringify({ ...JSON.parse(fs.readFileSync(record, 'utf8')), running: false }));
    const stopped = calls('run').length;
    assert.equal(await containers.usage(name), named);
    assert.deepEqual(calls('run').slice(stopped).map((c) => c.includes('--pid')), [false]);
    // With the container gone its processes are, and nothing is asked after them.
    await containers.release({ name, runId: 'run-16' });
    const asked = calls('run').length;
    between(await containers.usage(name), 16 + 3 * 4096);
    assert.deepEqual(calls('run').slice(asked).map((c) => c.includes('--pid')), [false]);
    unstage(`held-${name}`);
    await containers.discard(name);
    nothingLeft();
  });

  await check('an engine whose first word is that a probe may not read a container\'s processes is asked once, and its containers are measured by their files', async () => {
    const { name } = await containers.acquire({ pool: pool(17), peer: PEER, runId: 'run-17' });
    const beside = () => calls('run').filter((c) => c.includes('--pid')).length;
    const said = [];
    const fresh = createContainers({ log: (...a) => said.push(a.join(' ')), imageDir });
    stage(`held-${name}`, 'blind\n');
    const from = beside();
    const named = await fresh.usage(name);
    assert.ok(named > 0);
    assert.deepEqual(said, ['docker this engine does not show a probe what a container\'s processes hold open: a file with no name left is not counted against a container\'s disk allowance']);
    stage(`held-${name}`, `held ${MiB}\n`);
    assert.deepEqual([await fresh.usage(name), beside(), said.length], [named, from + 1, 1], 'and not again');
    unstage(`held-${name}`);
    await containers.release({ name, runId: 'run-17' });
    await containers.discard(name);
    nothingLeft();
  });

  await check('a daemon that is switched off erases the run records under every name, those of its earlier containers among them and nothing else: what this user may not delete goes through a probe, on the image jobs are started in or, in a daemon that has none, on one this daemon built', async () => {
    const one = await ended(40, 'run-40a');
    await containers.acquire({ pool: pool(40), peer: PEER, runId: 'run-40b' });
    run(one.name, 'run-40b');
    await containers.release({ name: one.name, runId: 'run-40b' });
    const other = await ended(41, 'run-41');
    const aside = `${one.name}.1`;
    fs.mkdirSync(records('somebody-elses'));
    assert.deepEqual(fs.readdirSync(path.join(RUNS_DIR, '.containers')).sort(), [one.name, aside, other.name, 'somebody-elses'].sort());
    // `from.eraseAll()` with `dir` refused this user once, as a directory with root's files
    // in it is, and with this user's first removal held until `go`. Resolves to what this
    // user was asked to remove, in order.
    const erasing = async (from, dir, go = Promise.resolve(), first = () => {}) => {
      const real = fs.promises.rm;
      const asked = [];
      fs.promises.rm = async (target, options) => {
        asked.push(target);
        if (asked.length === 1) await go;
        if (target === dir && asked.filter((t) => t === dir).length === 1) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
        return real(target, options);
      };
      try {
        const before = first(asked);
        await from.eraseAll();
        await before;
      } finally { fs.promises.rm = real; }
      return asked;
    };
    const emptied = (name, dir, image) => [...probeOf(name), '--cap-add=DAC_OVERRIDE', '--cap-add=FOWNER', '-v', `${records(dir)}:/r`, image, 'find', '/r', '-mindepth', '1', '-delete'];
    const [ran, listed] = [calls('run').length, calls('image').length];
    // One run under the name is being erased meanwhile: everything under that name waits its turn behind it.
    let go;
    const held = new Promise((resolve) => { go = resolve; });
    const asked = await erasing(containers, records(aside), held, (seen) => {
      const single = containers.erase(aside, 'run-40a');
      (async () => {
        await until('the records of the other name to be asked for', () => seen.includes(records(other.name)));
        await settle();
        assert.deepEqual(seen, [path.join(records(aside), 'run-40a'), records(other.name)], 'nothing under the name is touched while one of its runs is being erased');
        go();
      })();
      return single;
    });
    assert.deepEqual(asked.filter((t) => t === records(aside)).length, 2, 'refused once, and asked again after the engine');
    assert.deepEqual(calls('run').slice(ran), [emptied(one.name, aside, one.image)], 'under the name of the container whose records they were');
    assert.equal(calls('image').length, listed, 'the image jobs are started in is known');
    assert.deepEqual(fs.readdirSync(path.join(RUNS_DIR, '.containers')), ['somebody-elses']);
    fs.rmdirSync(records('somebody-elses'));
    for (const runId of ['run-40a', 'run-40b', 'run-41']) fs.unlinkSync(path.join(RUNS_DIR, runId));

    // A daemon that never had an image to start jobs in: its engine was down, or its image did not build.
    const left = await ended(42, 'run-42');
    const off = createContainers({ log: (...a) => logged.push(a.join(' ')), imageDir, broker: () => ({ port: 4321 }) });
    assert.equal(off.dockerState().image, '');
    // An image somebody built on top of this daemon's carries its label, and is not it.
    stage(path.join('images', encodeURIComponent('aaa-built-on-top:1')), JSON.stringify([`dn.base=${BASE}`]));
    const from = calls('run').length;
    assert.equal((await erasing(off, records(left.name))).length, 2);
    assert.deepEqual(calls('run').slice(from), [emptied(left.name, left.name, left.image)]);
    unstage(path.join('images', encodeURIComponent('aaa-built-on-top:1')));
    fs.unlinkSync(path.join(RUNS_DIR, 'run-42'));
    nothingLeft();
  });

  await check('held.cjs counts the blocks of every file a process holds open or runs that has no name left, once however many descriptors are on it, of a process whose first thread ended as well, and no file that has a name or is held in memory, nor the size of one past its blocks; where it may not read a process it says that it is blind', async () => {
    const MEMORY = [0x01021994, 0x858458f6, 0x958458f6];
    const disk = ['/var/tmp', os.tmpdir()].find((dir) => fs.existsSync(dir) && !MEMORY.includes(fs.statfsSync(dir).type));
    const inNamespace = (...command) => execFileSync('unshare', ['-U', '-r', '-p', '-f', '--mount-proc', ...command], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 60000 });
    const python = spawnSync('python3', ['-c', 'import ctypes; ctypes.CDLL(None).pthread_exit']).status === 0;
    let can = process.platform === 'linux' && !!disk && fs.existsSync('/dev/shm') && python;
    try { if (can) inNamespace('setpriv', '--bounding-set=-all', 'true'); } catch { can = false; }
    if (!can) return console.log('INFO held.cjs is not run here: it takes Linux, a pid namespace this user may make, a directory on a disk and python3');
    const dir = scratchDir('dn-held-', disk);
    try {
      // The shell is the first process of the namespace, holding: 3 MiB on disk with no
      // name, twice; 2 MiB with a name; 4 MiB in memory with no name; a file of 64 MiB
      // with no blocks and no name. Beside it run a program with no name, of 2 MiB and
      // more, and a process whose first thread ended, holding 5 MiB with no name.
      const said = inNamespace('sh', '-c', `
        dd if=/dev/zero of="$1/gone" bs=1M count=3 2>/dev/null
        dd if=/dev/zero of="$1/named" bs=1M count=2 2>/dev/null
        dd if=/dev/zero of="/dev/shm/$3" bs=1M count=4 2>/dev/null
        truncate -s 64M "$1/sparse"
        exec 3< "$1/gone" 4< "$1/named" 5< "$1/gone" 6< "/dev/shm/$3" 7< "$1/sparse"
        rm "$1/gone" "/dev/shm/$3" "$1/sparse"
        cat "$(command -v sleep)" > "$1/prog"
        dd if=/dev/zero bs=1M count=2 >> "$1/prog" 2>/dev/null
        chmod +x "$1/prog"
        echo "prog $(($(stat -c %b "$1/prog") * 512))"
        "$1/prog" 60 &
        while [ "$(readlink "/proc/$!/exe")" != "$1/prog" ]; do sleep 0.05; done
        rm "$1/prog"
        dd if=/dev/zero of="$1/leader" bs=1M count=5 2>/dev/null
        python3 -c 'import ctypes, os, sys, threading, time; f = open(sys.argv[1], "rb"); os.unlink(sys.argv[1]); threading.Thread(target=time.sleep, args=(60,)).start(); ctypes.CDLL(None).pthread_exit(None)' "$1/leader" &
        while ! grep -q "^State:.*Z" "/proc/$!/status" 2>/dev/null || [ -e "$1/leader" ]; do sleep 0.05; done
        node "$2"
        setpriv --bounding-set=-all node "$2"
        setpriv --bounding-set=-all,+dac_read_search node "$2"
        setpriv --bounding-set=-all,+sys_ptrace node "$2"`, 'sh', dir, HELD_CJS, path.basename(dir)).trim().split('\n');
      const [, prog] = /^prog (\d+)$/.exec(said[0]) ?? [];
      assert.ok(Number(prog) >= 2 * MiB, said[0]);
      const [, bytes] = /^held (\d+)$/.exec(said[1]) ?? [];
      between(Number(bytes), 3 * MiB + 5 * MiB + Number(prog));
      assert.deepEqual(said.slice(2), ['blind', 'blind', said[1]], 'with no capability, with the one that reads any file, with the one that reads any process');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  console.log(`\nall ${checks} checks passed`);
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
process.exit(0);
