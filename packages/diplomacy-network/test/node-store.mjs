// The store on a real directory: what reaches the disk and when, who may read it, and
// what a host does with a file it cannot parse.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { POOL, check, createWorld } from './lib/hosts.mjs';
import { createStore, fileDisk, poolFile } from '../src/node/store.js';

const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dn-store-'));
const mode = (file) => fs.statSync(file).mode & 0o777;
const tree = (dir) => fs.readdirSync(dir, { recursive: true }).map(String).sort();

await check('nothing is on disk before a flush; a flush writes each changed document once, whole, for its owner only', async () => {
  const dir = scratch();
  try {
    const disk = fileDisk(dir);
    const writes = [];
    const counted = { ...disk, write: (name, text) => { writes.push(name); disk.write(name, text); } };
    const store = createStore({ disk: counted });
    assert.equal(store.read('keys'), null);
    const keys = { issued: {} };
    store.write('keys', keys);
    store.write(poolFile(POOL), { toJSON: () => ({ id: POOL, records: [] }) });
    for (let i = 0; i < 100; i += 1) {
      keys.issued[`k${i}`] = i;
      store.write('keys', keys);
    }
    assert.deepEqual(tree(dir), [], 'not before the flush');
    assert.equal(store.read('keys'), keys, 'yet the store answers with what it was told');
    store.flush();
    assert.deepEqual(writes, [poolFile(POOL), 'keys'], 'a hundred changes, one write');
    assert.deepEqual(tree(dir), ['keys.json', 'pools', `${poolFile(POOL)}.json`], 'and no temporary file left');
    assert.deepEqual([mode(path.join(dir, 'keys.json')), mode(path.join(dir, `${poolFile(POOL)}.json`)), mode(path.join(dir, 'pools'))], [0o600, 0o600, 0o700]);
    assert.equal(Object.keys(createStore({ dir }).read('keys').issued).length, 100);
    assert.deepEqual(createStore({ dir }).read(poolFile(POOL)), { id: POOL, records: [] }, 'a document is written as it stands at the flush');
    store.flush();
    assert.equal(writes.length, 2, 'a flush with nothing changed writes nothing');
    store.remove('keys');
    assert.equal(store.read('keys'), null);
    store.flush();
    assert.deepEqual(tree(dir), ['pools', `${poolFile(POOL)}.json`]);

    // A file that does not parse is kept beside its name and read as empty.
    fs.writeFileSync(path.join(dir, 'offers.json'), '{"offers":{"a":');
    const log = [];
    const again = createStore({ dir, log: (line) => log.push(line) });
    assert.equal(again.read('offers'), null);
    const kept = tree(dir).filter((name) => name.startsWith('offers.json.corrupt-'));
    assert.equal(kept.length, 1);
    assert.equal(fs.readFileSync(path.join(dir, kept[0]), 'utf8'), '{"offers":{"a":');
    assert.match(log.join('\n'), /offers\.json does not parse .* read as empty/);
    assert.equal(fs.existsSync(path.join(dir, 'offers.json')), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

await check('a host on a real directory comes back as itself; with a file it cannot read it starts without what the file held', async () => {
  const dir = scratch();
  try {
    const w = createWorld({ seed: 91 });
    const req = w.add('req', { disk: fileDisk(dir) });
    const exe = w.add('exe', { slots: 1 });
    for (const h of [req, exe]) await w.start(h);
    await w.wait(exe.node.join(req.node.invite({ pool: POOL })));
    const { taskId } = await req.node.offer({ pool: POOL, kind: 'review', item: 'pr-1', title: 't', prompt: 'p' });
    await w.net.until(() => exe.executor.jobOf(taskId), { what: 'a job' });
    assert.deepEqual(tree(dir), ['heard.json', 'identity.json', 'keys.json', 'links.json', 'locks.json', 'offers.json', 'pools', `${poolFile(POOL)}.json`]);
    for (const name of tree(dir).filter((n) => n.endsWith('.json'))) assert.equal(mode(path.join(dir, name)), 0o600, name);
    assert.ok(JSON.parse(fs.readFileSync(path.join(dir, 'keys.json'), 'utf8')).issued[taskId].secret);

    await w.restart(req);
    assert.equal(req.node.pk, req.pk);
    assert.deepEqual([w.offerRow(req, taskId).state, w.task(req, taskId).executor, w.members(req).length], ['claimed', exe.pk, 2]);

    // Its offers file is cut short, as a full disk leaves it.
    w.net.kill('req');
    fs.writeFileSync(path.join(dir, 'offers.json'), '{"offers":');
    await w.restart(req);
    assert.deepEqual(req.node.snapshot().offers, []);
    assert.match(req.log.join('\n'), /store: offers\.json does not parse/);
    assert.equal(w.members(req).length, 2, 'the pool, in a file of its own, is whole');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
