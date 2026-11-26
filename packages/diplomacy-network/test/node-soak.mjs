// Seeded soak of 5-7 hosts and a hostile node-less member: `look()` checks what must always
// hold after every step, and once the network is mended every offer must end on every host.
//
//   DN_SOAK_SEEDS  how many seeds to run (default 4)     DN_SOAK_STEPS  steps per seed (default 120)
//   DN_SOAK_SEED   the first seed (default 1); a failure prints the seed to run again

import assert from 'node:assert/strict';
import { forgeRequest } from './lib/fakes.mjs';
import { POOL, createWorld } from './lib/hosts.mjs';
import { prng } from './lib/mem-net.mjs';
import { b64u } from '../src/core/canon.js';
import { specDigest } from '../src/core/capability.js';
import { buildClaim } from '../src/core/claims.js';
import { UNSERVED } from '../src/core/envelope.js';
import { sign } from '../src/core/identity.js';
import { createInvite, createVoucher, inviteToken } from '../src/core/membership.js';
import { endClaim, isActive } from '../src/core/lease.js';
import { LIMITS, backers, backing, memberRecord, offerRecord } from '../src/core/records.js';
import { ELSEWHERE } from '../src/node/offers.js';

const SEEDS = Number(process.env.DN_SOAK_SEEDS ?? 4);
const STEPS = Number(process.env.DN_SOAK_STEPS ?? 120);
const FIRST = Number(process.env.DN_SOAK_SEED ?? 1);
const ENDED = ['done', 'failed', 'cancelled'];

async function soak(seed) {
  const w = createWorld({ seed, audit: true });
  const dice = prng(seed * 7919 + 13);
  const pick = (list) => list[dice.int(list.length)];
  const names = Array.from({ length: 5 + dice.int(3) }, (_, i) => `h${i + 1}`);
  const all = await w.pool(names, Object.fromEntries(names.map((name, i) => [name, { slots: i < 2 ? 1 + dice.int(2) : dice.int(3) }])));
  const tally = { steps: 0, offers: 0, acts: {}, jobs: 0, restarts: 0, left: 0, slept: 0, hostile: 0, rival: 0, resent: 0 };
  // No node behind it, so every round counts it absent.
  const evil = await w.intruder('evil', all[0]);
  const evilJoined = w.net.now();
  const { voucher } = evil.member;
  let evilSeq = 0;
  const evilRecord = (now) => memberRecord(evil.id, { pool: POOL, seq: evilSeq += 1, at: Math.max(now, voucher.at), era: 0, maxAcceptedH: 12, voucher });
  const puppets = [];
  const tickets = new WeakMap(); // node (not host: a restart is a new one) -> when it gave evil a large-body place
  const trail = [];
  const broken = [];
  const atOnce = new Set(); // tasks offered to run at once, which take no slot
  const given = new Map();
  const claimed = new Set();
  const rival = new Map();
  const handed = new Map();
  const elsewhere = new Set();
  const boasted = new Set(); // tasks evil said its own run did
  const performed = new Map();
  const sendings = [];
  const secrets = new Map();
  const holders = new Map();
  const used = new Map();
  const last = new Map();
  let items = 0;

  w.net.tap(({ from, kind, body }) => {
    if (kind !== 'act') return undefined;
    const { keyId, seq, mac } = JSON.parse(body.toString('utf8')).body;
    // A seq may go out again with the same mac, never with another request.
    if ((used.get(`${keyId}|${seq}`) ?? mac) !== mac) broken.push(`${from} sent two requests as number ${seq} under one key`);
    tally.resent += used.has(`${keyId}|${seq}`) ? 1 : 0;
    used.set(`${keyId}|${seq}`, mac);
    const sending = { keyId, met: 'nothing' };
    sendings.push(sending);
    return {
      reached: (out) => {
        const { error } = JSON.parse(out.toString('utf8'));
        sending.met = error?.code === 'busy' && error.detail === UNSERVED ? 'unserved' : 'something';
      },
    };
  });
  for (const h of all) {
    const perform = h.requester.perform.bind(h.requester);
    h.requester.perform = (request, where) => {
      const id = `${request.path} ${request.body}`;
      if (request.method === 'POST') performed.set(id, (performed.get(id) ?? 0) + 1);
      return perform(request, where);
    };
  }

  // An asleep machine stands still: nothing is asked of its node, and no job of its ends.
  const awake = (h) => !h.transport.host.asleep;
  const jobs = (h) => [...h.executor.jobs.values()].filter((job) => job.alive).map((job) => job.args);
  const everyJob = () => all.filter(awake).flatMap((h) => jobs(h).map((job) => ({ h, job })));
  const openOffers = () => all.flatMap((h) => h.node.snapshot().offers.filter((o) => !ENDED.includes(o.state)).map((o) => ({ h, o })));
  const away = () => all.filter((h) => awake(h) && w.view(h).left);
  const here = () => all.filter((h) => awake(h) && !w.view(h).left);
  // Every host offers an item in the same words, so twin offers are one job.
  const offerOf = (item, now = false) => ({ pool: POOL, kind: 'review', item, title: `Review ${item}`, prompt: 'p', now });

  function look() {
    assert.deepEqual(broken, []);
    for (const h of all) {
      assert.deepEqual(h.log.filter((line) => /step failed|could not be served/.test(line)), [], `${h.name} threw`);
      const taking = jobs(h).filter((job) => !atOnce.has(job.task.taskId)).length;
      assert.ok(taking <= h.slots, `${h.name} runs ${taking} jobs on ${h.slots} slots`);
      // No record of another member's making takes a seat away, and evil seats only the keys
      // it may.
      if (!w.view(h).left) {
        const seated = w.records(h).filter((r) => r.type === 'member');
        for (const g of [...all, evil]) assert.ok(seated.some((r) => r.pk === g.pk), `${h.name} holds no seat for ${g.name}`);
        const extra = seated.filter((r) => r.pk !== evil.pk && !all.some((g) => g.pk === r.pk));
        assert.ok(extra.length <= LIMITS.invitees && extra.every((r) => r.voucher.by === evil.pk && puppets.includes(r.pk)), `${h.name} seats ${extra.length} keys nobody but the member with no node let in`);
      }
      for (const job of jobs(h)) handed.set(job.task.taskId, specDigest(job.spec));
      for (const record of w.records(h)) {
        if (record.type !== 'claim') continue;
        claimed.add(`${record.taskId}|${record.executor}`);
        // A host gives an offer to one claim at a time, each time as the next gen.
        for (const pk of backers(record).filter((by) => by !== evil.pk)) {
          const { at, gen } = backing(record, pk);
          const [id, to] = [`${pk}|${record.taskId}|${at}|${gen}`, `${record.executor}|${record.round}`];
          assert.equal(given.get(id) ?? to, to, `${w.name(pk)} gave its offer of ${record.taskId} to ${given.get(id)} and to ${to} as number ${gen}`);
          given.set(id, to);
        }
      }
      // evil is given no other host's offer; it can only say its own run did the job, which ends
      // that offer unrun (ELSEWHERE), backed by evil alone.
      for (const o of h.node.snapshot().offers) {
        assert.ok(o.state !== 'done' || o.outcome?.ok === true, `${o.item} is done without an outcome`);
        const done = o.state === 'done' && o.outcome.summary === ELSEWHERE;
        if (done) elsewhere.add(`${h.name}|${o.taskId}|${o.offeredAt}`);
        if (o.executor === evil.pk) {
          assert.ok(done && boasted.has(o.taskId), `${h.name} gave ${o.item} to a machine that never asked for it`);
          assert.deepEqual(o.backedBy, [evil.pk], `${h.name} names other hosts behind a run only its machine speaks of`);
        } else if (done) {
          // Every host named behind the run gave it its offer.
          const gave = (pk) => [...given].some(([id, to]) => id.startsWith(`${pk}|${o.taskId}|`) && to.startsWith(`${o.executor}|`));
          assert.ok(o.backedBy.length > 0 && o.backedBy.every(gave), `${h.name} ended ${o.item} by a run of ${w.name(o.executor)} that ${o.backedBy.filter((pk) => !gave(pk)).map(w.name)} gave no offer to`);
        }
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
    const { item, taskId } = job.task;
    const write = !dice.chance(0.7);
    const request = write ? forgeRequest('POST', `/repos/o/r/${item}/comments`, { n: tally.steps }) : forgeRequest('GET', `/repos/o/r/${item}/files`);
    const keyId = w.stored(h, 'keys')?.held?.[taskId]?.capability.keyId;
    const from = sendings.length;
    h.node.actFor(job.runId)(request).then((answer) => {
      tally.acts[answer.status] = (tally.acts[answer.status] ?? 0) + 1;
      if (![200, 403, 502, 503, 504].includes(answer.status)) broken.push(`an act answered ${answer.status}`);
      if (answer.status === 200 && !claimed.has(`${taskId}|${h.pk}`)) broken.push(`${h.name} was served for ${taskId} without a claim of it anywhere`);
      // A write is carried out at most once: exactly once if told 200, never if told 503.
      const times = performed.get(`${request.path} ${request.body}`) ?? 0;
      if (write && (times > 1 || (answer.status === 200 && times !== 1) || (answer.status === 503 && times !== 0))) {
        broken.push(`${h.name} was told ${answer.status} of a write carried out ${times} times`);
      }
      // A request told 'unserved' on every send must not end in doubt (504).
      const mine = sendings.slice(from).filter((s) => s.keyId === keyId);
      if (answer.status === 504 && mine.length > 0 && mine.every((s) => s.met === 'unserved')) {
        broken.push(`${h.name} left in doubt a request its requester did nothing for`);
      }
    }, (err) => broken.push(`an act rejected: ${err}`));
  }

  const events = [
    [20, 'offer', async () => {
      if (openOffers().length >= 6) return 'full';
      const twin = dice.chance(0.15) ? pick(openOffers()) : null;
      const h = pick(here().filter((x) => x !== twin?.h));
      if (!h) return 'nobody is here';
      const item = twin?.o.item ?? `pr-${items += 1}`;
      const now = dice.chance(0.1);
      const { taskId } = await h.node.offer(offerOf(item, now));
      if (now) atOnce.add(taskId);
      tally.offers += 1;
      return `${h.name} ${item}${now ? ' now' : ''}${twin ? ' (a second offerer)' : ''}`;
    }],
    [16, 'act', () => {
      const one = pick(everyJob());
      if (one) act(one);
      return one ? `${one.h.name} ${one.job.task.item}` : 'no job';
    }],
    [4, 'act after a restart', async () => {
      // The job's key host restarts having served a request dated ahead, so the job's next act
      // is dated before that start.
      const one = pick(everyJob());
      const from = one && all.find((x) => x.pk === w.stored(one.h, 'keys')?.held?.[one.job.task.taskId]?.host);
      if (!from || from === one.h || !awake(from)) return 'no job with a key from another host that is awake';
      const body = { asOf: w.net.now(), hash: w.view(from).hash };
      await w.request(evil, from, 'sync', body, { effort: 128, ts: w.net.now() + pick([1, 2, 6]) }).catch(() => {});
      await w.restart(from);
      tally.restarts += 1;
      act(one);
      return `${one.h.name} ${one.job.task.item} from ${from.name}`;
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
      const one = pick(openOffers().filter(({ h }) => awake(h)));
      if (one) await one.h.node.withdraw({ taskId: one.o.taskId, reason: 'soak' });
      return one ? `${one.h.name} ${one.o.item}` : 'no offer';
    }],
    [6, 'restart', async () => {
      const h = pick(all.filter(awake));
      await w.restart(h);
      tally.restarts += 1;
      return h.name;
    }],
    [3, 'leave', () => {
      if (away().length >= 2) return 'two are away';
      const h = pick(here());
      if (!h) return 'nobody is here';
      h.node.leave({ pool: POOL });
      tally.left += 1;
      return h.name;
    }],
    [3, 'join', async () => {
      const h = pick(away());
      if (h) await h.node.join({ pool: POOL });
      return h?.name ?? 'nobody is away';
    }],
    [5, 'sleep', async () => {
      // Often another machine offers the sleeper's work too, as one operator's machines would.
      const up = all.filter(awake);
      if (up.length <= all.length - 2) return 'two are asleep';
      const h = pick(up);
      const mine = pick(h.node.snapshot().offers.filter((o) => !ENDED.includes(o.state)));
      const other = pick(here().filter((x) => x !== h));
      const twin = mine && other && dice.chance(0.6);
      if (twin) {
        await other.node.offer(offerOf(mine.item));
        tally.offers += 1;
      }
      w.net.sleep(h.name);
      tally.slept += 1;
      return `${h.name}${twin ? `, and ${other.name} offers ${mine.item} too` : ''}`;
    }],
    [5, 'wake', () => {
      const h = pick(all.filter((x) => !awake(x)));
      if (h) w.net.sleep(h.name, false);
      return h?.name ?? 'nobody is asleep';
    }],
    [2, 'switch off', async () => {
      const h = pick(all.filter(awake));
      await w.wait(h.node.switchOff({ waitMs: 5000 }));
      await w.restart(h);
      tally.restarts += 1;
      return h.name;
    }],
    [8, 'hostile', async () => {
      const h = pick(all);
      const now = w.net.now();
      const say = (kind, body, options) => w.request(evil, h, kind, body, { effort: 128, ...options }).catch(() => ({ ok: false, code: 'no answer' }));
      const member = evilRecord(now);
      await say('hello', { member });
      const resigned = (fields) => ({ ...fields, sig: sign(evil.id, 'dn1/rec', fields) });
      const { sig: _, ...mine } = member;
      const puppet = w.stranger('puppet');
      const made = (fields) => {
        const record = { type: 'member', pool: POOL, pk: puppet.pk, seq: 0, at: now, era: 0, maxAcceptedH: 12, left: false, ...fields };
        return { ...record, sig: sign(puppet.id, 'dn1/rec', record) };
      };
      const seatOf = (by, over = {}) => createVoucher(by, { pool: POOL, era: 0, pk: puppet.pk, seat: dice.int(LIMITS.invitees), at: now, ...over });
      const junk = [
        resigned({ ...mine, seq: 2 ** 41 }), resigned({ ...mine, maxAcceptedH: 100000 }), resigned({ ...mine, pool: 'github.com/acme/other' }),
        resigned({ ...mine, more: 1 }), resigned({ ...mine, at: now + 86400 }),
        made({ voucher }), made({ joinedAt: 0, voucher: { invite: inviteToken(createInvite(evil.id, { pool: POOL, exp: now - 1, nonce: w.net.rnd.bytes(16) })) } }),
        made({ voucher: { ...seatOf(evil.id), seat: LIMITS.invitees } }), made({ voucher: seatOf(evil.id, { era: 1 }) }),
        made({ voucher: seatOf(evil.id, { at: now + 1 }) }), made({ voucher: seatOf(w.stranger('nobody').id) }),
        made({ voucher: seatOf(puppet.id) }),
      ];
      const held = pick(w.records(h).filter((r) => r.type === 'claim' && r.executor !== evil.pk && !rival.has(r.taskId)));
      if (held) {
        const { sig: __, ...theirs } = held;
        const forged = (gen) => buildClaim(evil.id, {
          pool: POOL, taskId: held.taskId, round: 'AAAAAAAAAAA', gen, grants: [], absent: [], now, offer: { at: evilJoined - 1, gen: 1, hours: held.hours },
        });
        junk.push(
          forged(held.gen + 1), endClaim(evil.id, forged(held.gen + 1), 'released', now), endClaim(evil.id, forged(LIMITS.time), 'released', now),
          resigned({ ...theirs, seq: held.seq + 1, at: now, state: 'released' }),
        );
      }
      const record = pick(junk);
      const respelled = dice.chance(0.2);
      const answer = await say('push', { records: [record] }, respelled ? { bytes: (sent) => Buffer.concat([sent, Buffer.from(' ')]) } : {});
      if (answer.ok && answer.body.accepted.length > 0) broken.push(`${h.name} took a record no host may take: ${JSON.stringify(record).slice(0, 300)}`);
      if (respelled && answer.response && answer.response.error?.code !== 'bad-request') broken.push(`${h.name} served bytes that are no request`);
      tally.hostile += answer.ok ? 1 : 0;
      return `${h.name} ${answer.ok ? `refused it: ${answer.body.refused[0]?.code}` : answer.code ?? answer.response?.error?.code}`;
    }],
    [6, 'grasp', async () => {
      const h = pick(all);
      const now = w.net.now();
      const say = (from, kind, body, options) => w.request(from, h, kind, body, { effort: 128, ...options }).catch(() => ({ ok: false, code: 'no answer' }));
      await say(evil, 'hello', { member: evilRecord(now) });
      const said = [];
      const one = pick(openOffers());
      if (one && !w.view(h).left) {
        const [round, asOf] = [b64u(Buffer.from(Array.from({ length: 8 }, () => dice.int(256)))), now + dice.int(301)];
        const lock = await say(evil, 'lock', { taskId: one.o.taskId, round, asOf, hash: w.view(h).hash });
        const grant = lock.ok ? lock.body.grant : null;
        if (grant && grant.exp !== asOf + 120) broken.push(`${h.name} gave a grant good for ${grant.exp - asOf} s`);
        if (grant) await say(evil, 'unlock', { taskId: one.o.taskId, round });
        said.push(grant ? `a lock${grant.offer ? ' with the offer' : ''}` : `no lock: ${lock.code}`);
      }
      // A key that leaves its tickets unused gets fewer all the time, however often it asks.
      const { node } = h;
      if (!tickets.has(node)) tickets.set(node, []);
      for (let n = 0; n < 6 && h.node === node; n += 1) {
        if ((await say(evil, 'reserve', { kind: 'push', bytes: 100000 })).ok) tickets.get(node).push(w.net.now());
        await w.run(11);
      }
      const recent = tickets.get(node).filter((at) => at > w.net.now() - 3600).length;
      if (recent > 8) broken.push(`${h.name} gave the member with no node ${recent} places in an hour, none of them used`);
      said.push(`${recent} places this hour`);
      // An unauthenticated request's answer must not reveal which pools are linked.
      const nobody = w.stranger('nobody');
      const asked = { asOf: now, hash: w.view(all[0]).hash };
      const here = await say(nobody, 'sync', asked, { effort: 1 });
      const nowhere = await say(nobody, 'sync', asked, { effort: 1, pool: 'github.com/nobody/nothing' });
      const told = (answer) => JSON.stringify([answer.code, answer.detail, answer.effort]);
      if (here.response && nowhere.response && (here.code !== 'effort' || told(here) !== told(nowhere))) {
        broken.push(`${h.name} tells a key it does not know ${told(here)} of this pool and ${told(nowhere)} of one that is nobody's`);
      }
      return `${h.name}: ${said.join(', ')}`;
    }],
    [4, 'puppet', async () => {
      // evil may give a seat of its own to a key, whoever held it before; that key may seat nobody.
      const h = pick(all);
      const now = w.net.now();
      const say = (kind, body) => w.request(evil, h, kind, body, { effort: 128 }).catch(() => ({ ok: false, code: 'no answer' }));
      const [one, under] = [w.stranger('puppet'), w.stranger('puppet')];
      const record = (id, by) => memberRecord(id.id, {
        pool: POOL, seq: 0, at: now, era: 0, maxAcceptedH: 12, voucher: createVoucher(by, { pool: POOL, era: 0, pk: id.pk, seat: dice.int(LIMITS.invitees), at: now }),
      });
      puppets.push(one.pk);
      await say('hello', { member: evilRecord(now) });
      const answer = await say('push', { records: [record(one, evil.id), record(under, one.id)] });
      if (answer.ok && answer.body.accepted.some((key) => key.endsWith(under.pk))) broken.push(`${h.name} seated a key three vouchers from the first host`);
      return `${h.name} ${answer.ok ? `took ${answer.body.accepted.length}` : answer.code}`;
    }],
    [6, 'rival', async () => {
      const one = pick(openOffers());
      if (!one) return 'no offer';
      const now = w.net.now();
      const { taskId, item } = one.o;
      const mine = rival.get(taskId) ?? { createdAt: now, seq: -1, state: 'open', hours: pick([12, 720]) };
      if (mine.state !== 'open') return `${item} over`;
      rival.set(taskId, mine);
      mine.seq += 1;
      if (mine.seq > 0) mine.state = pick(['open', 'done', 'cancelled']);
      const offer = offerRecord(evil.id, {
        pool: POOL, kind: 'review', item, identity: taskId.slice(taskId.lastIndexOf('@') + 1), seq: mine.seq, at: now, title: 'Mine too',
        minRequiredH: mine.hours, createdAt: mine.createdAt, state: mine.state,
      });
      const gen = pick([1, 2, LIMITS.time]);
      const claim = buildClaim(evil.id, {
        pool: POOL, taskId, round: 'AAAAAAAAAAA', gen: pick([0, 1, LIMITS.time]), grants: [], absent: [], now, offer: { at: mine.createdAt, gen, hours: mine.hours },
      });
      const member = evilRecord(now);
      const job = specDigest({ taskId, kind: 'review', item, title: `Review ${item}`, identity: taskId.slice(taskId.lastIndexOf('@') + 1), prompt: 'p', options: {} });
      assert.equal(handed.get(taskId) ?? job, job, 'the job it names is the one the others hand out');
      const ran = dice.chance(0.5);
      if (ran) boasted.add(taskId);
      for (const h of all) {
        const say = (kind, body) => w.request(evil, h, kind, body, { effort: 128 }).catch(() => ({ ok: false }));
        await say('hello', { member });
        const answer = await say('push', { records: [offer, claim, ...(ran ? [endClaim(evil.id, claim, 'completed', now, job)] : [])] });
        tally.rival += answer.ok ? answer.body.accepted.length : 0;
      }
      return `${item} ${mine.state} for ${mine.hours} h, a claim as number ${gen}${ran ? ' that says the job is done' : ''}`;
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

    w.net.heal();
    Object.assign(w.net.faults, { drop: 0, duplicate: 0 });
    for (const h of all) {
      w.net.sleep(h.name, false);
      w.net.down(h.name, false);
      h.slots = Math.max(h.slots, 2);
      if (w.view(h).left) await h.node.join({ pool: POOL });
    }
    // evil cancels what it still offers and repeats how the rest ended: nobody may have heard.
    for (const [taskId, mine] of rival) {
      const now = w.net.now();
      const [, item] = /:(.*)@/.exec(taskId);
      const offer = offerRecord(evil.id, {
        pool: POOL, kind: 'review', item, identity: taskId.slice(taskId.lastIndexOf('@') + 1), seq: mine.seq + 1, at: now, title: 'Mine too',
        minRequiredH: mine.hours, createdAt: mine.createdAt, state: mine.state === 'open' ? 'cancelled' : mine.state,
      });
      const member = evilRecord(now);
      // Tell every host: one that has only just joined again may not take its word yet.
      for (const h of all) {
        const say = (kind, body) => w.request(evil, h, kind, body, { effort: 128 }).catch(() => ({ ok: false }));
        await say('hello', { member });
        await say('push', { records: [offer] });
      }
    }
    trail.push(`${w.net.now()} mended`);
    // A job that ended is not over while its machine holds the claim: it may still be reporting.
    const claiming = () => all.some((h) => w.records(h).some((r) => r.type === 'claim' && r.executor === h.pk && isActive(r, w.net.now())));
    const settled = () => openOffers().length === 0 && everyJob().length === 0 && !claiming()
      && new Set(all.map((h) => w.view(h).hash)).size === 1;
    for (let minute = 0; !settled(); minute += 1) {
      assert.ok(minute < 16 * 60, `still unsettled 16 hours after the network was mended: ${JSON.stringify(openOffers().map(({ h, o }) => [h.name, o.item, o.state, o.attempt]))}`);
      for (const { h, job } of everyJob()) h.executor.end(job.runId);
      await w.run(60);
      look();
    }
    assert.equal(new Set(all.map((h) => w.members(h).join())).size, 1, 'every host names the same members');
    for (const h of all) {
      for (const task of w.view(h).tasks) assert.ok(['done', 'cancelled'].includes(task.state), `${h.name} sees ${task.taskId} as ${task.state}, offered by ${task.offeredBy.map(w.name)}`);
      const keys = w.stored(h, 'keys') ?? {};
      assert.deepEqual([Object.keys(keys.issued ?? {}), Object.keys(keys.held ?? {})], [[], []], `${h.name} keeps no key of a task that ended`);
    }
    return { ...tally, elsewhere: elsewhere.size };
  } catch (err) {
    console.log(`FAIL soak seed ${seed} at step ${tally.steps}; run it again with DN_SOAK_SEED=${seed} DN_SOAK_SEEDS=1 DN_SOAK_STEPS=${STEPS}`);
    console.log(trail.slice(-25).join('\n'));
    throw err;
  }
}

for (let seed = FIRST; seed < FIRST + SEEDS; seed += 1) {
  const t = await soak(seed);
  console.log(`PASS soak seed ${seed}: ${STEPS} steps, ${t.offers} offers, ${t.jobs} jobs ended, ${t.restarts} restarts, ${t.left} left, ${t.slept} sleeps, ${t.elsewhere} offers ended by a run for another host's offer, ${t.hostile} hostile records refused, ${t.rival} records of a rival offer taken, ${t.resent} requests sent again, acts ${JSON.stringify(t.acts)}`);
}
