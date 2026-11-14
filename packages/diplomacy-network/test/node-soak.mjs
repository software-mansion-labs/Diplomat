// Five to seven hosts and a seeded run of everything that can happen to them at once:
// offers, runs that finish, fail or vanish, requests under keys, withdrawals, restarts,
// hosts off the network, cuts, lost and repeated requests, and hours passing. After every
// step what must always hold is checked; at the end the network is mended and everything
// offered must have ended, on every host alike.
//
//   DN_SOAK_SEEDS  how many seeds to run (default 2)     DN_SOAK_STEPS  steps per seed (default 120)
//   DN_SOAK_SEED   the first seed (default 1); a failure prints the seed to run again

import assert from 'node:assert/strict';
import { forgeRequest } from './lib/fakes.mjs';
import { POOL, createWorld } from './lib/hosts.mjs';
import { prng } from './lib/mem-net.mjs';

const SEEDS = Number(process.env.DN_SOAK_SEEDS ?? 2);
const STEPS = Number(process.env.DN_SOAK_STEPS ?? 120);
const FIRST = Number(process.env.DN_SOAK_SEED ?? 1);
const ENDED = ['done', 'failed', 'cancelled'];

async function soak(seed) {
  const w = createWorld({ seed });
  const dice = prng(seed * 7919 + 13);
  const pick = (list) => list[dice.int(list.length)];
  const names = Array.from({ length: 5 + dice.int(3) }, (_, i) => `h${i + 1}`);
  const all = await w.pool(names, Object.fromEntries(names.map((name, i) => [name, { slots: i < 2 ? 1 + dice.int(2) : dice.int(3) }])));
  const tally = { steps: 0, offers: 0, acts: {}, jobs: 0, restarts: 0 };
  const trail = [];
  const broken = [];
  const atOnce = new Set(); // tasks offered to run at once, which take no slot
  const claims = new Map(); // "task|gen" -> Map("executor|round" -> { claimedAt, exp, granters })
  const secrets = new Map(); // "requester|task|round" -> secret
  const holders = new Map(); // keyId -> the one host seen holding it
  const used = new Set(); // "keyId|seq" of every act request sent
  const last = new Map(); // "requester|keyId" -> the highest seq its store has held
  let items = 0;

  w.net.tap(({ from, headers, body }) => {
    if (headers['dn-kind'] !== 'act') return;
    const { keyId, seq } = JSON.parse(body.toString('utf8')).body;
    if (used.has(`${keyId}|${seq}`)) broken.push(`${from} sent request number ${seq} twice under one key`);
    used.add(`${keyId}|${seq}`);
  });

  const jobs = (h) => [...h.executor.jobs.values()].filter((job) => job.alive).map((job) => job.args);
  const everyJob = () => all.flatMap((h) => jobs(h).map((job) => ({ h, job })));
  const openOffers = () => all.flatMap((h) => h.node.snapshot().offers.filter((o) => !ENDED.includes(o.state)).map((o) => ({ h, o })));

  // What holds at every moment, whatever the network does.
  function look() {
    assert.deepEqual(broken, []);
    for (const h of all) {
      assert.deepEqual(h.log.filter((line) => /step failed|could not be served/.test(line)), [], `${h.name} threw`);
      const taking = jobs(h).filter((job) => !atOnce.has(job.task.taskId)).length;
      assert.ok(taking <= h.slots, `${h.name} runs ${taking} jobs on ${h.slots} slots`);
      for (const record of w.records(h)) {
        if (record.type !== 'claim') continue;
        const id = `${record.taskId}|${record.gen}`;
        const mine = { claimedAt: record.claimedAt, exp: record.grants[0]?.exp ?? 0, granters: record.grants.map((g) => g.by) };
        if (!claims.has(id)) claims.set(id, new Map());
        const same = claims.get(id);
        if (same.has(`${record.executor}|${record.round}`)) continue;
        // Two claims of one generation rest on one member's grant only if the first
        // grant had run out before the second claim was made.
        for (const [other, theirs] of same) {
          const [early, late] = theirs.claimedAt <= mine.claimedAt ? [theirs, mine] : [mine, theirs];
          const both = early.granters.filter((pk) => late.granters.includes(pk));
          assert.ok(both.length === 0 || late.claimedAt > early.exp, `${w.name(both[0])} granted ${id} to ${other} and to ${record.executor}|${record.round} at once`);
        }
        same.set(`${record.executor}|${record.round}`, mine);
      }
      const keys = w.stored(h, 'keys') ?? {};
      for (const [taskId, K] of Object.entries(keys.issued ?? {})) {
        const id = `${h.pk}|${taskId}|${K.round}`;
        assert.equal(secrets.get(id) ?? K.secret, K.secret, `${h.name} issued a second secret for one claim of ${taskId}`);
        secrets.set(id, K.secret);
        const seen = `${h.pk}|${K.capability.keyId}`;
        assert.ok(K.seq >= (last.get(seen) ?? -1), `${h.name} forgot a request number it had used`);
        last.set(seen, K.seq);
      }
      for (const K of Object.values(keys.held ?? {})) {
        const { keyId } = K.capability;
        assert.equal(holders.get(keyId) ?? h.name, h.name, `one key in the hands of ${holders.get(keyId)} and ${h.name}`);
        holders.set(keyId, h.name);
        assert.equal(K.capability.executor, h.pk);
      }
    }
  }

  function act({ h, job }) {
    const { item } = job.task;
    const request = dice.chance(0.7) ? forgeRequest('GET', `/repos/o/r/${item}/files`) : forgeRequest('POST', `/repos/o/r/${item}/comments`, { n: tally.steps });
    h.node.actFor(job.runId)(request).then((answer) => {
      tally.acts[answer.status] = (tally.acts[answer.status] ?? 0) + 1;
      if (![200, 403, 502, 503, 504].includes(answer.status)) broken.push(`an act answered ${answer.status}`);
      const known = [...(claims.get([...claims.keys()].find((id) => id.startsWith(`${job.task.taskId}|`)) ?? '')?.keys() ?? [])];
      if (answer.status === 200 && !all.some((x) => w.claim(x, job.task.taskId)?.executor === h.pk) && !known.some((k) => k.startsWith(h.pk))) {
        broken.push(`${h.name} was served for ${job.task.taskId} without a claim of it anywhere`);
      }
    }, (err) => broken.push(`an act rejected: ${err}`));
  }

  const events = [
    [20, 'offer', async () => {
      if (openOffers().length >= 6) return 'full';
      const twin = dice.chance(0.15) ? pick(openOffers()) : null;
      const h = pick(all.filter((x) => x !== twin?.h));
      const item = twin?.o.item ?? `pr-${items += 1}`;
      const now = dice.chance(0.1);
      const { taskId } = await h.node.offer({ pool: POOL, kind: 'review', item, title: `Review ${item}`, prompt: 'p', now });
      if (now) atOnce.add(taskId);
      tally.offers += 1;
      return `${h.name} ${item}${now ? ' now' : ''}${twin ? ' (a second offerer)' : ''}`;
    }],
    [16, 'act', () => {
      const one = pick(everyJob());
      if (one) act(one);
      return one ? `${one.h.name} ${one.job.task.item}` : 'no job';
    }],
    [12, 'finish', () => {
      const one = pick(everyJob());
      const ok = dice.chance(0.8);
      if (one) one.h.executor.end(one.job.runId, { ok });
      tally.jobs += one ? 1 : 0;
      return one ? `${one.h.name} ${one.job.task.item} ${ok ? 'ok' : 'failed'}` : 'no job';
    }],
    [3, 'vanish', () => {
      const one = pick(everyJob());
      if (one) one.h.executor.die(one.job.runId);
      return one ? `${one.h.name} ${one.job.task.item}` : 'no job';
    }],
    [2, 'stop', async () => {
      const one = pick(everyJob());
      if (one) await one.h.node.stopRun({ runId: one.job.runId }).catch(() => {});
      return one ? `${one.h.name} ${one.job.task.item}` : 'no job';
    }],
    [4, 'withdraw', async () => {
      const one = pick(openOffers());
      if (one) await one.h.node.withdraw({ taskId: one.o.taskId, reason: 'soak' });
      return one ? `${one.h.name} ${one.o.item}` : 'no offer';
    }],
    [6, 'restart', async () => {
      const h = pick(all);
      await w.restart(h);
      tally.restarts += 1;
      return h.name;
    }],
    [6, 'down', () => {
      const h = pick(all);
      const off = h.transport.host.up && all.filter((x) => !x.transport.host.up).length < 2;
      w.net.down(h.name, off);
      return `${h.name} ${off ? 'off' : 'on'}`;
    }],
    [5, 'cut', () => {
      const [a, b] = [pick(all), pick(all)];
      if (a !== b) w.net.cut(a.name, b.name);
      return `${a.name} ${b.name}`;
    }],
    [4, 'heal', () => w.net.heal()],
    [3, 'faults', () => {
      Object.assign(w.net.faults, { drop: pick([0, 0.02, 0.1]), duplicate: pick([0, 0, 0.05]) });
      return `drop ${w.net.faults.drop} duplicate ${w.net.faults.duplicate}`;
    }],
    [19, 'wait', async () => {
      const secs = pick([5, 30, 30, 120, 120, 600, 600, 1800, 3 * 3600]);
      for (let left = secs; left > 0; left -= 600) {
        await w.run(Math.min(left, 600));
        look();
      }
      return `${secs} s`;
    }],
  ];
  const weight = events.reduce((sum, [n]) => sum + n, 0);

  try {
    for (tally.steps = 1; tally.steps <= STEPS; tally.steps += 1) {
      let at = dice.int(weight);
      const [, name, run] = events.find(([n]) => (at -= n) < 0);
      trail.push(`${w.net.now()} ${name} ${(await run()) ?? ''}`);
      await w.run(1 + dice.int(4));
      look();
    }

    // The network is whole again and every host has room: everything offered comes to an end.
    w.net.heal();
    Object.assign(w.net.faults, { drop: 0, duplicate: 0 });
    for (const h of all) {
      w.net.down(h.name, false);
      h.slots = Math.max(h.slots, 2);
    }
    trail.push(`${w.net.now()} mended`);
    const settled = () => openOffers().length === 0 && everyJob().length === 0 && new Set(all.map((h) => w.view(h).hash)).size === 1;
    for (let minute = 0; !settled(); minute += 1) {
      assert.ok(minute < 16 * 60, `still unsettled 16 hours after the network was mended: ${JSON.stringify(openOffers().map(({ h, o }) => [h.name, o.item, o.state, o.attempt]))}`);
      for (const { h, job } of everyJob()) h.executor.end(job.runId);
      await w.run(60);
      look();
    }
    for (const h of all) {
      for (const task of w.view(h).tasks) assert.ok(['done', 'cancelled'].includes(task.state), `${h.name} sees ${task.taskId} as ${task.state}`);
      const keys = w.stored(h, 'keys') ?? {};
      assert.deepEqual([Object.keys(keys.issued ?? {}), Object.keys(keys.held ?? {})], [[], []], `${h.name} keeps no key of a task that ended`);
      for (const o of h.node.snapshot().offers) assert.ok(o.state !== 'done' || o.outcome?.ok === true || o.reason.includes('another machine'), `${o.item} is done without an outcome`);
    }
    return tally;
  } catch (err) {
    console.log(`FAIL soak seed ${seed} at step ${tally.steps}; run it again with DN_SOAK_SEED=${seed} DN_SOAK_SEEDS=1 DN_SOAK_STEPS=${STEPS}`);
    console.log(trail.slice(-25).join('\n'));
    throw err;
  }
}

for (let seed = FIRST; seed < FIRST + SEEDS; seed += 1) {
  const t = await soak(seed);
  console.log(`PASS soak seed ${seed}: ${STEPS} steps, ${t.offers} offers, ${t.jobs} jobs ended, ${t.restarts} restarts, acts ${JSON.stringify(t.acts)}`);
}
