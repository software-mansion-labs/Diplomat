// The store on a real directory: what reaches the disk and when, who may read it, and
// what a host does with a file it cannot parse.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { POOL, check, createWorld } from './lib/hosts.mjs';
import { identityFromSeed } from '../src/core/identity.js';
import { memberRecord } from '../src/core/records.js';
import { createStore, fileDisk, memoryDisk, poolFile, readPool } from '../src/node/store.js';

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

await check('what changed in a document is written as a line after it, and the document whole again once the lines are as long as it was', async () => {
  const dir = scratch();
  try {
    const disk = fileDisk(dir);
    const did = [];
    const counted = {
      ...disk,
      write: (name, text) => { did.push(`write ${name}`); disk.write(name, text); },
      append: (name, text) => { did.push(`append ${name}`); disk.append(name, text); },
      cut: (name) => { did.push(`cut ${name}`); disk.cut(name); },
    };
    const store = createStore({ disk: counted });
    const [name, log] = [poolFile(POOL), path.join(dir, `${poolFile(POOL)}.log`)];
    const written = () => createStore({ dir }).lines(name);
    const doc = { id: POOL, pad: 'x'.repeat(100000) };
    store.write(name, doc, { line: { n: 0 } });
    store.flush();
    assert.deepEqual(did.splice(0), [`write ${name}`, `cut ${name}`], 'a line follows a document this store wrote: the first write is the document');
    store.write(name, doc, { line: { n: 1 } });
    store.write(name, doc, { line: { n: 2 } });
    store.write('keys', {});
    store.flush();
    assert.deepEqual(did.splice(0), [`append ${name}`, 'write keys', 'cut keys'], 'two lines in one append, before the document that rests on this one');
    assert.equal(mode(log), 0o600);
    assert.deepEqual([written(), store.lines(name)], [[{ n: 1 }, { n: 2 }], [{ n: 1 }, { n: 2 }]]);
    store.write(name, doc, { line: { n: 3 } });
    assert.deepEqual(store.lines(name), [], 'and of a document it was told since, nothing: what it was told is the whole of it');
    store.flush();
    did.splice(0);
    store.write('keys', {});
    store.flush();
    assert.deepEqual(did.splice(0), ['write keys'], 'a document that has no log has none removed');

    // A write with no line is the document, whatever lines the same flush was given.
    store.write(name, doc, { line: { n: 3 } });
    store.write(name, doc);
    store.write(name, doc, { line: { n: 4 } });
    store.flush();
    assert.deepEqual(did.splice(0), [`write ${name}`, `cut ${name}`]);
    assert.deepEqual([fs.existsSync(log), written()], [false, []]);

    // The log grows as long as the document was - a short document's to 64 KiB.
    const line = { pad: 'y'.repeat(30000) };
    for (const [value, fit] of [[doc, 3], [{ id: POOL }, 2]]) {
      store.write(name, value);
      store.flush();
      for (let n = 0; n < fit; n += 1) {
        store.write(name, value, { line });
        store.flush();
      }
      did.splice(0);
      assert.equal(written().length, fit);
      store.write(name, value, { line });
      store.flush();
      assert.deepEqual(did.splice(0), [`write ${name}`, `cut ${name}`], `${fit} lines of 30 KiB after this document, and no more`);
      assert.deepEqual(written(), []);
    }

    // What a reader makes of a log some host left behind.
    store.write(name, doc);
    store.write(name, doc, { line: { n: 5 } });
    store.flush();
    store.write(name, doc, { line: { n: 5 } });
    store.flush();
    const whole = fs.readFileSync(log, 'utf8');
    fs.writeFileSync(log, `${whole}{"n":6}\n{"n":`);
    assert.deepEqual(written(), [{ n: 5 }, { n: 6 }], 'a line cut short is one its host died writing');
    disk.write(name, JSON.stringify({ ...doc, id: 'another' }));
    assert.deepEqual(written(), [], 'a log that follows another document says nothing of this one');
    disk.write(name, `${JSON.stringify(doc)}\n`);
    fs.writeFileSync(log, `${whole}{"n":\n{"n":7}\n`);
    const said = [];
    assert.deepEqual(createStore({ dir, log: (text) => said.push(text) }).lines(name), []);
    assert.match(said.join('\n'), /\.log does not parse .* read as empty/);
    assert.deepEqual(createStore({ dir }).read(name), doc, 'and the document is read as it is');
    const next = createStore({ disk: counted });
    did.splice(0);
    next.write(name, doc, { line: { n: 8 } });
    next.flush();
    assert.deepEqual([did.splice(0), fs.existsSync(log)], [[`write ${name}`, `cut ${name}`], false], 'the log of a life before this one goes with the first write');

    // An append that failed may have left half a line.
    const failing = createStore({
      disk: { ...counted, append(given, text) { disk.append(given, text.slice(0, 70)); throw new Error('the disk is full'); } },
    });
    failing.write(name, doc);
    failing.flush();
    failing.write(name, doc, { line: { n: 9 } });
    assert.throws(() => failing.flush(), /the disk is full/);
    did.splice(0);
    failing.flush();
    assert.deepEqual([did.splice(0), fs.existsSync(log)], [[`write ${name}`, `cut ${name}`], false], 'the document is written whole at the next flush');

    store.write(name, doc);
    store.flush();
    store.write(name, doc, { line: { n: 10 } });
    store.flush();
    store.remove(name);
    store.flush();
    assert.deepEqual(tree(dir), ['keys.json', 'pools'], 'a document removed leaves no log');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

await check("a pool's document is read with the lines of its log taken in: the records put, the keys dropped, the last sequence number", async () => {
  const store = createStore({ disk: memoryDisk() });
  assert.equal(readPool(store, POOL), null);
  const [a, b] = ['a', 'b'].map((name) => identityFromSeed(Buffer.alloc(32, name).toString('base64url')));
  const member = (id, seq) => memberRecord(id, { pool: POOL, seq, at: 1794000000 + seq, era: 0, maxAcceptedH: 12 });
  const doc = { id: POOL, linked: true, seq: 3, invites: [], records: [member(a, 0), member(b, 0)] };
  store.write(poolFile(POOL), doc);
  store.flush();
  assert.deepEqual(readPool(store, POOL), doc);
  for (const line of [{ seq: 4, put: [member(a, 1)], drop: [] }, { seq: 5, put: [], drop: [`member/${b.pk}`] }, { seq: 6, put: [member(b, 2), member(a, 3)], drop: [] }, { seq: 7, put: [], drop: [`member/${a.pk}`] }]) {
    store.write(poolFile(POOL), doc, { line });
    store.flush();
  }
  assert.deepEqual(readPool(store, POOL), { ...doc, seq: 7, records: [member(b, 2)] });
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
    assert.deepEqual(tree(dir), ['heard.json', 'identity.json', 'keys.json', 'links.json', 'locks.json', 'offers.json', 'pools', `${poolFile(POOL)}.json`, `${poolFile(POOL)}.log`]);
    for (const name of tree(dir).filter((n) => n !== 'pools')) assert.equal(mode(path.join(dir, name)), 0o600, name);
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
