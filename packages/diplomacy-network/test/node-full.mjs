// A pool at its caps - as many members as it holds, each with as many offers and as many
// claims as one member may have live - is still a pool a host can join: it takes in every
// record, and no answer on the way is larger than a response may be.

import assert from 'node:assert/strict';
import { POOL, check, createWorld } from './lib/hosts.mjs';
import { canon } from '../src/core/canon.js';
import { buildClaim, buildGrant } from '../src/core/claims.js';
import { INDEX_PAGE_BYTES } from '../src/core/pool.js';
import { LIMITS, buildTaskId, memberRecord, offerRecord } from '../src/core/records.js';
import { DEFAULT_LIMIT } from '../src/transport/http.js';

const ROUND = 'AAAAAAAAAAA';

await check('a host joins a pool that is as full as a pool gets and holds what every member holds, and two hosts that hold it all find the one record they differ in: an index travels a page at a time', async () => {
  const w = createWorld({ seed: 111 });
  const a = w.add('a');
  await w.start(a);
  const now = w.net.now();
  const voucher = a.node.invite({ pool: POOL }).invite;
  // Every member but the two hosts: each offers all it may, and claims all it may of
  // what the next one offers.
  const others = Array.from({ length: LIMITS.members - 2 }, (_, i) => w.stranger(`m${i}`));
  const records = others.map((m) => memberRecord(m.id, { pool: POOL, seq: 0, at: now, joinedAt: now, maxAcceptedH: 12, voucher }));
  others.forEach((m, i) => {
    const taker = others[(i + 1) % others.length];
    for (let j = 0; j < LIMITS.offers; j += 1) {
      const item = `m${i}-t${j}`;
      const taskId = buildTaskId({ pool: POOL, kind: 'review', item, identity: 'octocat' });
      records.push(offerRecord(m.id, {
        pool: POOL, kind: 'review', item, identity: 'octocat', seq: 0, at: now, title: `Review ${item}`, minRequiredH: 12, createdAt: now, state: 'open',
      }));
      const grant = buildGrant(m.id, { pool: POOL, taskId, executor: taker.pk, round: ROUND, hash: 'A'.repeat(43), exp: now + 120, offer: { at: now, gen: 1, hours: 12 } });
      records.push(buildClaim(taker.id, { pool: POOL, taskId, round: ROUND, gen: 0, grants: [grant], absent: [], now }));
    }
  });
  // The first host has them on disk when it starts.
  w.net.kill('a');
  const file = [...a.disk.files.keys()].find((name) => name.startsWith('pools/'));
  const doc = JSON.parse(a.disk.read(file));
  a.disk.write(file, JSON.stringify({ ...doc, records: [...doc.records, ...records] }));
  await w.restart(a);
  const full = 1 + others.length * (1 + LIMITS.offers + LIMITS.claims);
  assert.deepEqual([w.records(a).length, w.members(a).length], [full, LIMITS.members - 1]);
  const whole = canon(Object.fromEntries(w.records(a).map((r) => [`${r.type}/${r.taskId ?? ''}/${r.host ?? r.executor ?? r.pk}`, [[r.seq], 'A'.repeat(43)]]))).length;
  assert.ok(whole > DEFAULT_LIMIT, `the whole index, some ${whole} bytes, is more than one answer may be`);

  const answers = { hello: [], sync: [], pull: [] };
  let [pages, pushed] = [0, 0];
  w.net.tap(({ to, kind, body }) => {
    if (kind === 'push') pushed += JSON.parse(body.toString('utf8')).body.records.length;
    if (to !== 'a' || !Object.hasOwn(answers, kind)) return undefined;
    pages += kind === 'sync' && JSON.parse(body.toString('utf8')).body.after ? 1 : 0;
    return (out) => answers[kind].push(typeof out === 'string' ? out : out.length);
  });
  const b = w.add('b');
  await w.start(b);
  await b.node.join(a.node.invite({ pool: POOL }));
  await w.agreed([a, b], 30 * 60 * 1000);
  assert.deepEqual([w.records(b).length, w.members(b).length], [full + 1, LIMITS.members]);
  const size = (kind) => answers[kind].map((bytes) => (typeof bytes === 'number' && bytes <= INDEX_PAGE_BYTES + 4096 ? 'a page' : bytes));
  assert.deepEqual([...new Set([...size('hello'), ...size('sync')])], ['a page']);
  assert.ok(pages >= Math.floor(whole / INDEX_PAGE_BYTES), `the index took ${pages + 1} pages`);

  // Each host signs a record the other does not hear of: what tells them so is an index
  // neither could send whole.
  w.net.cut('a', 'b');
  const one = await a.node.offer({ pool: POOL, kind: 'review', item: 'pr-1', title: 'Review pr-1', prompt: 'p' });
  const other = await b.node.offer({ pool: POOL, kind: 'review', item: 'pr-2', title: 'Review pr-2', prompt: 'p' });
  await w.run(120);
  assert.deepEqual([w.task(b, one.taskId), w.task(a, other.taskId)], [null, null]);
  w.net.heal();
  pushed = 0;
  await w.agreed([a, b], 30 * 60 * 1000);
  assert.deepEqual([w.task(b, one.taskId).offeredBy, w.task(a, other.taskId).offeredBy, w.records(a).length], [[a.pk], [b.pk], full + 3]);
  // A page says what its host lacks in the range it covers, and no more is sent for it.
  assert.ok(pushed <= 8, `${pushed} records were pushed for the two that differed`);
  assert.deepEqual([...new Set([...size('hello'), ...size('sync')])], ['a page']);
  assert.deepEqual([...a.log, ...b.log].filter((line) => /could not be served|step failed|failed:/.test(line)), []);
});
