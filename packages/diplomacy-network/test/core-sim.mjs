// 2 to 7 hosts built from src/core alone, on a transport that delays, reorders, duplicates
// and drops messages and partitions and crashes hosts. Each schedule comes from one seed
// and must keep five invariants:
//
// (a) hosts that reach each other agree, once quiet, on the claim that holds each offer;
// (b) after a partition heals and sync runs, every host holds the same state, and the
//     claim that holds each offer is the one the conflict rules name;
// (c) no claim is committed without a grant from every member heard in its round;
// (d) a lapsed claim frees its task for every host at the same second;
// (e) every round ends, and in a calm network none ends by timing out.
//
// DN_SIM_SCHEDULES=20000   more schedules than the default
// DN_SIM_SEED=1234         one schedule, the one a failure names

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import os from 'node:os';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { b64u } from '../src/core/canon.js';
import { ClaimRound, LockTable, buildClaim } from '../src/core/claims.js';
import { ReplayMemory, buildRequest, buildResponse, verifyRequest, verifyResponse } from '../src/core/envelope.js';
import { buildPing, endClaim, extendClaim, isActive, pingWindow, verifyPing } from '../src/core/lease.js';
import { createVoucher } from '../src/core/membership.js';
import { Pool } from '../src/core/pool.js';
import { EffortMeter, solve } from '../src/core/pow.js';
import { LIMITS, memberRecord, offerRecord, pingShaped, shaped } from '../src/core/records.js';
import { POOL, T0, ident, prng } from './lib/core-fixtures.mjs';

async function check(name, fn) {
  await fn();
  console.log(`PASS ${name}`);
}

const IDS = Array.from({ length: 7 }, (_, i) => ident(i));
const [LEASE, GRACE, DAY] = [7200, 600, 24 * 3600];
const REQUEST_TIMEOUT_MS = 8000;
const CALM = { name: 'calm', drop: 0, dup: 0, slow: 300, partition: 0, crash: 0 };
const PROFILES = [
  CALM,
  { name: 'jittery', drop: 0, dup: 0.15, slow: 6000, partition: 0.3, crash: 0.4 },
  { name: 'lossy', drop: 0.12, dup: 0.1, slow: 2500, partition: 0.5, crash: 0.5 },
  { name: 'stormy', drop: 0.3, dup: 0.2, slow: 20000, partition: 0.6, crash: 0.6 },
];
// A meter whose doublings a schedule reaches with a handful of requests.
const TINY = { memberBase: 1, memberAllow: 6, memberCap: 5, strangerBase: 4, strangerAllow: 2, strangerCap: 4, windowSecs: 60 };

const taskIdOf = (item) => `${POOL}#review:${item}@octocat`;
const claimKey = (taskId, executor) => `claim/${taskId}/${executor}`;

// The conflict rules of PROTOCOL.md section 7, written out apart from the code under test.
const rankOf = (taskId, pk) => crypto.createHash('sha256')
  .update(Buffer.concat([Buffer.from(`dn1/rank\0${taskId}\0`), Buffer.from(pk, 'base64url')])).digest('hex');
const backedBy = (claim, host) => (claim.executor === host ? claim.offer : claim.grants.find((g) => g.by === host)?.offer) ?? null;
const backersOf = (claim) => [claim.executor, ...claim.grants.map((g) => g.by)].filter((pk) => backedBy(claim, pk));
// Negative when claim `a` holds the offer of `host`, which backs both, over claim `b`.
function holdsOver(host, a, b) {
  const [x, y] = [backedBy(a, host).gen, backedBy(b, host).gen];
  if (x !== y) return y - x;
  return rankOf(a.taskId, a.executor) < rankOf(b.taskId, b.executor) ? -1 : 1;
}
// Negative when version `a` of one executor's claim of a task wins over version `b`.
function newer(a, b) {
  if (a.gen !== b.gen) return b.gen - a.gen;
  if (a.round !== b.round) return a.round < b.round ? -1 : 1;
  return b.seq - a.seq;
}
const heldTill = (claim, hours) => Math.min(claim.leaseUntil, claim.claimedAt + hours * 3600) + GRACE;

// Wired to the world's transport the way a daemon is wired to Tor.
class Host {
  constructor(world, index, accepts) {
    this.world = world;
    this.index = index;
    this.id = IDS[index];
    this.pk = this.id.pk;
    this.accepts = accepts;
    this.pool = new Pool({ id: POOL, self: this.pk });
    this.locks = new LockTable();
    this.up = true;
    this.life = 0;
    this.joined = false;
    this.record = null;
    this.inviter = null;
    this.seats = 0; // how many of its seats this host gave
    this.depth = 0; // how many vouchers it is from the first host
    this.runs = new Map(); // taskId -> the round in progress
    this.wants = new Map(); // taskId -> attempts left
    this.gave = new Map(); // taskId -> how many times it gave its offer of it away
    this.crashAt = 0; // crash on receiving this many grants
    this.dieAtCommit = false; // crash holding a claim nobody has heard of
    this.meter = new EffortMeter(TINY);
    this.replay = new ReplayMemory();
    this.owed = new Map(); // pk -> the effort that target last asked for
  }

  get now() {
    return this.world.now;
  }

  // Skipped if this host crashed in between.
  later(delay, fn) {
    const { life } = this;
    this.world.at(delay, () => {
      if (this.up && this.life === life) fn();
    });
  }

  others() {
    return this.pool.members(this.now).map((m) => m.pk).filter((pk) => pk !== this.pk);
  }

  known() {
    return this.pool.known(this.now).map((m) => m.pk).filter((pk) => pk !== this.pk);
  }

  // As a daemon does on a timer.
  resign() {
    if (!this.up || !this.joined) return;
    const { now } = this;
    const again = (record, build) => {
      const { sig: _, type: __, ...held } = record;
      return build(this.id, { ...held, seq: held.seq + 1, at: now });
    };
    this.record = again(this.record, memberRecord);
    const offers = this.pool.records().filter((r) => r.type === 'offer' && r.host === this.pk && r.state === 'open');
    const records = [this.record, ...offers.map((o) => again(o, offerRecord))];
    this.take(records);
    this.push(records);
  }

  executing(taskId) {
    return (this.pool.task(taskId, this.now)?.offers ?? []).some((o) => o.claim?.executor === this.pk);
  }

  // A daemon keeps this count on disk; null without an open offer of the task.
  nextGen(taskId) {
    const mine = this.pool.get(`offer/${taskId}/${this.pk}`);
    if (mine?.state !== 'open') return null;
    this.gave.set(taskId, (this.gave.get(taskId) ?? 0) + 1);
    return this.gave.get(taskId);
  }

  send(to, kind, body, reply = () => {}) {
    this.world.request(this, this.world.byPk.get(to), kind, body, reply);
  }

  push(records) {
    for (const pk of this.others()) this.send(pk, 'push', { records });
  }

  take(records) {
    const result = this.pool.merge(records, this.now);
    this.changed();
    return result;
  }

  changed() {
    for (const [taskId, lock] of this.locks.entries()) {
      const claim = this.pool.get(claimKey(taskId, lock.executor));
      if (claim) this.locks.release(taskId, claim.executor, claim.round);
    }
    // A round confirms the state it will be granted on: when that moved, it starts over.
    for (const run of [...this.runs.values()]) {
      if (!run.round.over && this.pool.stateHash(run.snapshot.asOf) !== run.snapshot.hash) this.rebase(run);
    }
  }

  handle(from, kind, body) {
    const { now } = this;
    if (kind === 'hello') {
      const answer = this.pool.answerHello(body, from, now);
      this.changed();
      return answer;
    }
    if (!this.pool.accepts(from, now)) return { error: 'not-member' };
    if (kind === 'sync') return this.pool.answerSync(body, now);
    if (kind === 'pull') return this.pool.answerPull(body);
    if (kind === 'lock') {
      return this.locks.answer({ pool: this.pool, identity: this.id, from, body, now, nextGen: () => this.nextGen(body.taskId) });
    }
    if (kind === 'unlock') return this.locks.unlock({ from, body });
    if (kind === 'ping') return this.answerPing(from, body, now);
    assert.equal(kind, 'push');
    const answer = this.pool.answerPush(body, now);
    this.changed();
    return answer;
  }

  found() {
    const { now } = this;
    this.record = memberRecord(this.id, { pool: POOL, seq: 0, at: now, era: 0, maxAcceptedH: this.accepts });
    this.pool.merge(this.record, now);
    this.joined = true;
  }

  // Joins under `inviter`, in the next of its seats unless this host was given one before.
  join(inviter, tries = 12) {
    if (this.inviter !== inviter) {
      this.seat = inviter.seats;
      inviter.seats += 1;
    }
    this.inviter = inviter;
    if (!this.up || this.joined) return;
    const { now } = this;
    if (!this.record) {
      const voucher = createVoucher(inviter.id, { pool: POOL, era: 0, pk: this.pk, seat: this.seat, at: now });
      this.record = memberRecord(this.id, { pool: POOL, seq: 0, at: now, era: 0, maxAcceptedH: this.accepts, voucher });
      this.pool.merge(this.record, now);
    }
    this.greet(inviter.pk, (ok) => {
      // It is in once it holds its inviter's record: until then it is alone where it looks.
      this.joined = ok && this.pool.accepts(inviter.pk, this.now);
      if (this.joined) this.push([this.record]);
      else if (tries > 1) this.later(2000 + this.world.rnd.int(6000), () => this.join(inviter, tries - 1));
    });
  }

  greet(pk, done) {
    this.send(pk, 'hello', { member: this.record }, (result) => {
      const index = result?.body?.index;
      if (!index) return done(false);
      const plan = this.pool.reconcile(index, this.now);
      assert.ok(plan, 'a hello was answered with a malformed index');
      if (plan.pull.length === 0) return done(true);
      return this.send(pk, 'pull', { keys: plan.pull }, (pulled) => {
        if (pulled?.body) this.take(pulled.body.records);
        done(true);
      });
    });
  }

  syncWith(pk, done = () => {}, greeted = false) {
    const asOf = this.now;
    this.send(pk, 'sync', { asOf, hash: this.pool.stateHash(asOf) }, (result) => {
      if (result?.error === 'not-member' && !greeted) {
        return this.greet(pk, (ok) => (ok ? this.syncWith(pk, done, true) : done()));
      }
      const index = result?.body?.index;
      if (!index) return done();
      const plan = this.pool.reconcile(index, asOf);
      assert.ok(plan, 'a sync was answered with a malformed index');
      const give = () => {
        const records = this.pool.records(plan.push);
        if (records.length === 0) return done();
        return this.send(pk, 'push', { records }, () => done());
      };
      if (plan.pull.length === 0) return give();
      return this.send(pk, 'pull', { keys: plan.pull }, (pulled) => {
        if (pulled?.body) this.take(pulled.body.records);
        give();
      });
    });
  }

  offer(task, hours, tries = 8) {
    if (!this.joined) {
      if (tries > 1) this.later(5000, () => this.offer(task, hours, tries - 1));
      return;
    }
    const { now } = this;
    const before = this.pool.get(`offer/${taskIdOf(task.item)}/${this.pk}`);
    const record = offerRecord(this.id, {
      pool: POOL, kind: 'review', item: task.item, identity: 'octocat', seq: before ? before.seq + 1 : 0, at: now,
      title: `Review ${task.item}`, minRequiredH: hours, createdAt: now,
    });
    this.take(record);
    this.push([record]);
  }

  close(taskId) {
    const { sig: _, ...held } = this.pool.get(`offer/${taskId}/${this.pk}`);
    const record = offerRecord(this.id, { ...held, seq: held.seq + 1, at: this.now, state: 'done' });
    this.take(record);
    this.push([record]);
  }

  want(taskId, tries) {
    if (!this.up) return;
    this.wants.set(taskId, tries);
    this.claim(taskId);
  }

  claim(taskId) {
    const left = this.wants.get(taskId) ?? 0;
    if (!this.joined || this.runs.has(taskId) || left <= 0) return;
    this.wants.set(taskId, left - 1);
    const { now } = this;
    const round = new ClaimRound({ taskId, self: this.pk, round: b64u(this.world.rnd.bytes(8)), now });
    // A host that granted a rival's lock waits for that round to end.
    if (!this.locks.hold(taskId, this.pk, round.round, round.deadline, now)) {
      this.retry(taskId);
      return;
    }
    const run = { host: this, round, taskId, heard: new Set(), snapshot: null, outcome: null, ended: null };
    this.runs.set(taskId, run);
    this.world.rounds.push(run);
    this.rebase(run);
    const tick = () => {
      if (run.round.over) return;
      this.act(run, run.round.tick(this.now));
      this.later(5000, tick);
    };
    this.later(5000, tick);
  }

  retry(taskId) {
    if (this.wants.get(taskId) > 0) this.later(5000 + this.world.rnd.int(35000), () => this.claim(taskId));
  }

  rebase(run) {
    if (run.round.over) return;
    const { now } = this;
    run.snapshot = this.pool.claimSnapshot(run.taskId, now);
    if (run.round.phase === 'new' && run.snapshot.available && run.snapshot.eligible) this.world.attempted.add(run.taskId);
    this.act(run, run.round.rebase(run.snapshot, now));
  }

  act(run, actions) {
    const { round, taskId } = run;
    const { rnd } = this.world;
    for (const action of actions) {
      if (action.do === 'sync' || action.do === 'lock') {
        const ask = () => {
          if (round.over) return;
          this.send(action.to, action.do, action.body, (result) => {
            if (round.over) return;
            if (!result) {
              this.act(run, round.noAnswer(action.to, action.wave, this.now));
              return;
            }
            run.heard.add(action.to);
            if (result.body?.grant && this.crashAt > 0 && --this.crashAt === 0) {
              this.world.crash(this);
              return;
            }
            const answer = action.do === 'sync' ? round.onSync : round.onLock;
            this.act(run, answer.call(round, action.to, action.wave, result.body ?? null, this.now));
          });
        };
        if (action.retry) this.later(1000 + rnd.int(2000), ask);
        else ask();
      } else if (action.do === 'resync') {
        const { wave } = round;
        const again = () => {
          if (round.wave === wave) this.rebase(run);
        };
        this.later(500 + rnd.int(1500), () => (action.with ? this.syncWith(action.with, again) : again()));
      } else if (action.do === 'unlock') {
        this.send(action.to, 'unlock', action.body);
      } else if (action.do === 'commit') {
        this.commit(run, action);
      } else {
        assert.equal(action.do, 'stand-down');
        this.locks.release(taskId, this.pk, round.round);
        this.runs.delete(taskId);
        run.outcome = action.reason;
        run.ended = this.now;
        this.retry(taskId);
      }
    }
  }

  commit(run, { gen, grants, absent, own }) {
    const { now } = this;
    const { taskId, round } = run;
    const granted = grants.map((g) => g.by);
    const mine = own ? this.nextGen(taskId) : null;
    assert.ok(mine !== null || grants.some((g) => g.offer), `host ${this.index} committed a claim nobody backs`);
    assert.deepEqual([...granted, ...absent].sort(), [...run.snapshot.members].sort(), `(c) host ${this.index} committed without every member granting or absent`);
    for (const pk of run.heard) {
      if (run.snapshot.members.includes(pk)) assert.ok(granted.includes(pk), `(c) host ${this.index} committed without a grant from host ${this.world.byPk.get(pk).index}, which answered in the round`);
    }
    assert.ok(now < round.deadline, `(e) host ${this.index} committed past its round's deadline`);
    const claim = buildClaim(this.id, {
      pool: POOL, taskId, round: round.round, gen, grants, absent, now, ...(mine === null ? {} : { offer: { ...own, gen: mine } }),
    });
    assert.deepEqual(this.pool.merge(claim, now).refused, [], `host ${this.index} cannot hold the claim it committed`);
    this.locks.release(taskId, this.pk, round.round);
    this.runs.delete(taskId);
    run.outcome = 'commit';
    run.ended = now;
    this.world.commits.push({ claim, members: run.snapshot.members });
    this.changed();
    if (this.dieAtCommit) {
      this.dieAtCommit = false;
      this.world.crash(this);
      return;
    }
    this.push([claim]);
  }

  // Asks the executor of the claim holding this host's offer for its next lease.
  ping(taskId) {
    const claim = this.pool.task(taskId, this.now)?.offers.find((o) => o.host === this.pk)?.claim;
    if (!claim) return;
    this.send(claim.executor, 'ping', { ping: buildPing(this.id, claim, this.now) }, (result) => {
      const next = result?.body?.claim;
      if (!next) return;
      this.take(next);
      this.push([next]);
    });
  }

  answerPing(from, body, now) {
    if (!shaped(body, { ping: pingShaped })) return { error: 'bad-request' };
    const claim = this.pool.get(claimKey(body.ping.taskId, this.pk));
    if (!claim || body.ping.by !== from) return { error: 'denied' };
    const verdict = verifyPing(body.ping, claim);
    if (!verdict.ok) return verdict.code === 'old' ? { body: { claim } } : { error: 'denied', detail: verdict.code };
    if (!isActive(claim, now)) return { error: 'denied', detail: 'lapsed' };
    const next = extendClaim(this.id, claim, body.ping, now);
    assert.deepEqual(this.take(next).refused, [], `host ${this.index} cannot hold its own extension`);
    return { body: { claim: next } };
  }

  finish(taskId, state) {
    const ended = endClaim(this.id, this.pool.get(claimKey(taskId, this.pk)), state, this.now, b64u(Buffer.alloc(32, 7)));
    assert.deepEqual(this.take(ended).refused, []);
    this.push([ended]);
  }
}

class World {
  constructor(seed, sealed = false) {
    this.rnd = prng(seed);
    this.sealed = sealed;
    this.ms = 0;
    this.queue = [];
    this.steps = 0;
    this.hosts = [];
    this.byPk = new Map();
    this.side = new Map();
    this.net = CALM;
    this.busy = false;
    this.era = 0;
    this.rounds = [];
    this.commits = [];
    this.attempted = new Set();
    this.seen = { replays: 0, efforts: 0, midRound: 0, splits: 0 };
  }

  get now() {
    return T0 + Math.floor(this.ms / 1000);
  }

  add(accepts) {
    const host = new Host(this, this.hosts.length, accepts);
    this.hosts.push(host);
    this.byPk.set(host.pk, host);
    this.side.set(host, 0);
    return host;
  }

  at(delay, fn) {
    const event = { t: this.ms + delay, fn };
    let i = this.queue.length;
    while (i > 0 && this.queue[i - 1].t > event.t) i -= 1;
    this.queue.splice(i, 0, event);
  }

  // `until` is in ms.
  async run(until = Infinity) {
    while (this.queue.length > 0 && this.queue[0].t <= until) {
      const event = this.queue.shift();
      this.ms = event.t;
      assert.ok(++this.steps < 2000000, 'the schedule never comes to rest');
      const pending = event.fn();
      if (pending) await pending;
    }
    if (until !== Infinity) this.ms = until;
  }

  jump(now) {
    assert.equal(this.queue.length, 0);
    assert.ok(now >= this.now);
    this.ms = (now - T0) * 1000;
  }

  linked(a, b) {
    return a.up && b.up && this.side.get(a) === this.side.get(b);
  }

  split(sides) {
    this.hosts.forEach((h, i) => this.side.set(h, sides[i]));
    this.seen.splits += 1;
  }

  heal() {
    for (const h of this.hosts) this.side.set(h, 0);
  }

  crash(host) {
    if (!host.up) return;
    host.up = false;
    host.life += 1;
    host.crashAt = 0;
    if (host.runs.size > 0) this.seen.midRound += 1;
    for (const run of host.runs.values()) run.outcome = 'crashed';
    host.runs.clear();
  }

  // Keeps what a daemon keeps on disk: its records and its locks.
  restart(host) {
    if (host.up) return;
    host.up = true;
    host.locks = new LockTable(host.locks.entries());
    if (host.inviter) host.join(host.inviter);
  }

  hop(fn) {
    if (this.rnd.chance(this.net.drop)) return;
    this.at(5 + this.rnd.int(this.net.slow), fn);
  }

  // `reply` is called once: `{ body }`, `{ error }`, or null on timeout. A crashed sender
  // hears nothing.
  request(src, dst, kind, body, reply) {
    const { life } = src;
    let open = true;
    const settle = (result) => {
      if (!open || !src.up || src.life !== life) return;
      open = false;
      reply(result);
    };
    this.at(REQUEST_TIMEOUT_MS, () => settle(null));
    if (this.sealed) {
      this.seal(src, dst, kind, body, settle, 0);
      return;
    }
    const arrive = () => {
      if (!this.linked(src, dst)) return;
      const answer = dst.handle(src.pk, kind, body);
      this.hop(() => {
        if (this.linked(src, dst)) settle(answer);
      });
    };
    this.hop(arrive);
    if (this.rnd.chance(this.net.dup)) this.hop(arrive);
  }

  // A duplicated request on the wire is a replay and must never reach a handler twice.
  seal(src, dst, kind, body, settle, tries) {
    this.at(0, async () => {
      if (!src.up) return;
      const request = await buildRequest(src.id, {
        pool: POOL, kind, to: dst.pk, ts: this.now, body, nonce: this.rnd.bytes(16), effort: src.owed.get(dst.pk) ?? 1,
      }, (c, effort) => solve(c, effort).counter);
      const size = Buffer.byteLength(JSON.stringify(request));
      let taken = false;
      const arrive = () => {
        if (!this.linked(src, dst)) return;
        const { now } = this;
        const verdict = verifyRequest(request, {
          self: dst.pk, now, size, meter: dst.meter, replay: dst.replay, isMember: (pool, pk) => pool === POOL && dst.pool.accepts(pk, now),
        });
        if (taken) {
          assert.equal(verdict.ok, false, 'a replayed request reached a handler');
          this.seen.replays += 1;
          return;
        }
        taken = verdict.ok;
        const answer = verdict.ok ? dst.handle(src.pk, kind, body) : { error: verdict.code, detail: verdict.detail };
        const response = buildResponse(dst.id, {
          re: verdict.re, effort: verdict.effort,
          ...(answer.error ? { error: { code: answer.error, detail: answer.detail } } : { body: answer.body }),
        });
        this.hop(() => {
          if (!this.linked(src, dst)) return;
          const result = verifyResponse(response, { request, from: dst.pk });
          assert.ok(result, 'a response its asker cannot verify');
          src.owed.set(dst.pk, result.effort);
          if (!result.ok && result.code === 'effort' && tries < 3) {
            this.seen.efforts += 1;
            this.seal(src, dst, kind, body, settle, tries + 1);
          } else {
            settle(result.ok ? { body: result.body } : { error: result.code, detail: result.detail });
          }
        });
      };
      this.hop(arrive);
      if (this.rnd.chance(this.net.dup)) this.hop(arrive);
    });
  }

  gossip() {
    this.busy = true;
    const era = ++this.era;
    for (const host of this.hosts) {
      const loop = () => {
        if (!this.busy || this.era !== era) return;
        const others = host.up && host.joined ? host.known() : [];
        if (others.length > 0) host.syncWith(this.rnd.pick(others));
        this.at(10000 + this.rnd.int(30000), loop);
      };
      this.at(this.rnd.int(20000), loop);
    }
  }

  live() {
    return this.hosts.filter((h) => h.up && h.joined);
  }

  // Live hosts grouped by who can reach and accept each other.
  clusters() {
    const { now } = this;
    const left = new Set(this.live());
    const out = [];
    for (const first of left) {
      const cluster = [];
      const queue = [first];
      left.delete(first);
      while (queue.length > 0) {
        const a = queue.pop();
        cluster.push(a);
        for (const b of left) {
          if (this.linked(a, b) && a.pool.accepts(b.pk, now) && b.pool.accepts(a.pk, now)) {
            left.delete(b);
            queue.push(b);
          }
        }
      }
      out.push(cluster);
    }
    return out;
  }

  agreed() {
    return this.clusters().every((cluster) => new Set(cluster.map((h) => h.pool.stateHash(this.now))).size === 1);
  }

  // Faults stop and hosts sync until those that reach each other agree. Partitions and
  // crashed hosts stay as they are.
  async settle() {
    const { net } = this;
    this.net = CALM;
    this.busy = false;
    for (const host of this.hosts) {
      if (host.inviter) host.join(host.inviter);
    }
    await this.run();
    for (let sweep = 0; !this.agreed(); sweep++) {
      assert.ok(sweep < 10, '(a) hosts that reach each other still differ after ten rounds of sync');
      for (const host of this.live()) {
        for (const pk of host.known()) {
          if (this.linked(host, this.byPk.get(pk))) host.syncWith(pk);
        }
      }
      await this.run();
    }
    this.net = net;
  }

  // The invariants that hold at rest.
  inspect(tasks, tally) {
    const { now } = this;
    for (const run of this.rounds) {
      assert.ok(run.outcome, `(e) a round of host ${run.host.index} never ended`);
      if (run.outcome === 'crashed') continue;
      assert.ok(run.ended <= run.round.deadline + 5, `(e) a round of host ${run.host.index} outlived its deadline`);
    }
    for (const cluster of this.clusters()) {
      assert.equal(new Set(cluster.map((h) => h.pool.stateHash(now))).size, 1, '(a) hosts that reach each other hold different states');
      for (const { taskId } of tasks) {
        const holders = (h) => (h.pool.task(taskId, now)?.offers ?? []).map((o) => [o.host, o.claim?.executor ?? null, o.claim?.round ?? null]);
        const named = new Set(cluster.map((h) => JSON.stringify(holders(h))));
        assert.equal(named.size, 1, `(a) hosts that reach each other name different claims for the offers of ${taskId}`);
        const held = holders(cluster[0]).filter(([, executor]) => executor);
        const running = cluster.filter((h) => h.executing(taskId)).map((h) => h.pk);
        assert.ok(running.every((pk) => held.some(([, executor]) => executor === pk)) && running.length <= held.length,
          `(a) a host runs ${taskId} without a claim that holds an offer of it`);
        if (cluster.length > 1 && held.length > 0) tally.a += 1;
      }
    }
    for (const host of this.live()) {
      for (const task of host.pool.tasks(now)) {
        for (const offer of task.offers) {
          if (!offer.claim) continue;
          const lapse = heldTill(offer.claim, offer.hours);
          const at = (when) => host.pool.task(task.taskId, when)?.offers.find((o) => o.host === offer.host)?.claim ?? null;
          assert.deepEqual([at(lapse - 1), at(lapse) === offer.claim], [offer.claim, false],
            `(d) host ${host.index} does not free an offer of ${task.taskId} when the lease and grace of its claim run out`);
        }
      }
    }
  }
}

const heldClaims = (world) => world.hosts.flatMap((h) => h.pool.records().filter((r) => r.type === 'claim'));

// One whole schedule: hosts join, offer and race for tasks while the network misbehaves;
// the network heals; leases are extended, given up, cut off and left to lapse.
async function schedule(seed, tally) {
  const world = new World(seed, seed % 16 === 5);
  const r = world.rnd;
  const profile = r.pick(PROFILES);
  const n = 2 + r.int(6);
  const calm = profile === CALM;
  world.about = `${profile.name}, ${n} hosts${world.sealed ? ', sealed' : ''}`;
  for (let i = 0; i < n; i++) world.add(r.pick([12, 24, 24, 48]));
  const { hosts } = world;
  const tasks = Array.from({ length: 1 + r.int(3) }, (_, j) => {
    const item = `pr-${seed}.${j}`;
    const offerers = r.shuffle(hosts.slice(0, 3)).slice(0, r.chance(0.4) ? 2 : 1);
    return { item, taskId: taskIdOf(item), offers: offerers.map((host) => ({ host, hours: r.pick([12, 12, 24]) })) };
  });
  // Several hosts go for each task, most of them within seconds of each other.
  const storm = (from, tries) => tasks.flatMap(({ taskId }) => {
    const burst = from + r.int(30000);
    const claimants = r.shuffle(hosts).slice(0, 1 + r.int(Math.min(n, 4)));
    for (const host of claimants) world.at(burst + r.int(r.chance(0.6) ? 3000 : 40000), () => host.want(taskId, tries));
    return claimants;
  });

  // Joining, offering and the first race, all at once - except in a calm world, where
  // the race starts from hosts that know each other, so that it must be won.
  world.net = profile;
  world.gossip();
  hosts[0].found();
  for (let i = 1; i < n; i++) {
    // A host two vouchers from the first gives no seat.
    const near = hosts.slice(0, i).filter((h) => h.depth < LIMITS.depth);
    const inviter = near[r.int(near.length)];
    hosts[i].depth = inviter.depth + 1;
    world.at(!calm && r.chance(0.2) ? 150000 + r.int(60000) : r.int(40000), () => hosts[i].join(inviter));
  }
  for (const task of tasks) {
    for (const { host, hours } of task.offers) world.at(3000 + r.int(50000), () => host.offer(task, hours));
  }
  if (calm) {
    await world.run(60000);
    await world.settle();
    world.gossip();
  }
  const claimants = storm(calm ? 0 : 60000, 3);
  if (r.chance(profile.partition)) {
    const sides = hosts.map(() => r.int(n > 2 && r.chance(0.3) ? 3 : 2));
    // Half the time two hosts that offer the same task end up apart, so that each side
    // can claim it; otherwise any two hosts do.
    const shared = tasks.find((task) => task.offers.length > 1);
    const [one, other] = shared && r.chance(0.5) ? shared.offers.map((o) => o.host.index) : [0, 1 + r.int(n - 1)];
    sides[one] = 0;
    sides[other] = 1;
    const from = r.chance(0.5) ? 40000 + r.int(20000) : r.int(120000);
    world.at(from, () => world.split(sides));
    if (shared && sides[shared.offers[0].host.index] !== sides[shared.offers[1].host.index]) {
      for (const { host } of shared.offers) world.at(from + 5000 + r.int(20000), () => host.want(shared.taskId, 3));
    }
    if (r.chance(0.5)) world.at(from + 10000 + r.int(150000), () => world.heal());
  }
  if (r.chance(profile.crash)) {
    const victim = r.chance(0.7) ? r.pick(claimants) : r.pick(hosts);
    const how = r.next();
    if (how < 0.4) victim.crashAt = 1;
    else if (how < 0.7) {
      // It goes down holding a claim nobody heard of, and once the locks it was granted
      // ran out another host goes for each task.
      victim.dieAtCommit = true;
      for (const { taskId } of tasks) world.at(260000 + r.int(60000), () => r.pick(hosts).want(taskId, 2));
    }
    else world.at(50000 + r.int(70000), () => world.crash(victim));
    if (r.chance(0.5)) world.at(150000 + r.int(200000), () => world.restart(victim));
  }
  await world.run(world.ms + 420000);
  await world.settle();
  world.inspect(tasks, tally);
  if (calm) {
    assert.ok(world.rounds.every((run) => run.outcome !== 'timeout'), '(e) a round timed out in a calm network');
    for (const taskId of world.attempted) {
      for (const host of hosts) assert.equal(host.pool.task(taskId, world.now).state, 'claimed', `(e) nobody won the race for ${taskId}`);
      tally.won += 1;
    }
  }

  // The network heals and every host comes back; a second race runs under the same faults.
  const before = heldClaims(world);
  world.heal();
  for (const host of hosts) {
    host.crashAt = 0;
    host.dieAtCommit = false;
    if (!host.up) world.restart(host);
    else if (host.inviter) host.join(host.inviter);
  }
  world.gossip();
  storm(0, 2);
  await world.run(world.ms + 300000);
  await world.settle();
  world.inspect(tasks, tally);
  assert.deepEqual(world.clusters().map((c) => c.length), [n], '(b) a host stays apart after the network healed');
  for (const claim of [...before, ...world.commits.map((c) => c.claim)]) {
    const kept = hosts[0].pool.get(claimKey(claim.taskId, claim.executor));
    assert.ok(kept && newer(kept, claim) <= 0, `(b) the hosts hold a claim of ${claim.taskId} older than one of them saw`);
  }
  for (const { taskId } of tasks) {
    const all = hosts[0].pool.records().filter((c) => c.type === 'claim' && c.taskId === taskId);
    const task = hosts[0].pool.task(taskId, world.now);
    if (new Set((task?.offers ?? []).filter((o) => o.claim).map((o) => o.claim.executor)).size > 1) tally.twice += 1;
    for (const offer of task?.offers ?? []) {
      // The claim its host gave the offer to last holds it, while it is held; none other does.
      const rivals = all.filter((c) => backedBy(c, offer.host)?.at === offer.createdAt);
      const last = rivals.length > 0 ? rivals.reduce((a, b) => (holdsOver(offer.host, a, b) <= 0 ? a : b)) : null;
      const holds = last && last.state === 'held' && world.now < heldTill(last, offer.hours) && hosts[0].pool.member(last.executor, world.now);
      assert.equal(offer.claim, holds ? last : null, `(b) the claim that holds an offer of ${taskId} is not the one the rules name`);
      if (rivals.filter((c) => c.state === 'held' && world.now < heldTill(c, offer.hours)).length > 1) tally.b += 1;
    }
  }

  // Leases, one claimed task after another in the order their leases run out: the tasks
  // one claim holds every taken offer of.
  world.net = CALM;
  const everywhere = (taskId, what) => hosts.map((h) => what(h.pool.task(taskId, world.now), h));
  const claimed = hosts[0].pool.tasks(world.now).filter((t) => t.state === 'claimed' && t.offers.every((o) => !o.claim || o.claim === t.claim))
    .sort((x, y) => x.claim.leaseUntil - y.claim.leaseUntil);
  const lapsing = [];
  // Walks the clock over the second a claim lapses, whichever side of it the clock is on.
  const lapse = (claim) => {
    const { taskId } = claim;
    const at = claim.leaseUntil + GRACE;
    if (world.now < at) {
      world.jump(at - 1);
      assert.deepEqual(everywhere(taskId, (t) => t.claim), hosts.map(() => claim), `(d) ${taskId} was freed before its lease and grace ran out`);
      world.jump(at);
      tally.d += 1;
    }
    assert.deepEqual(everywhere(taskId, (t, h) => [t.state, t.claim, h.executing(taskId)]), hosts.map(() => ['available', null, false]), `(d) ${taskId} is not free for every host at the second its claim lapses`);
  };
  for (const { taskId, claim, offeredBy } of claimed) {
    const executor = world.byPk.get(claim.executor);
    const requesters = backersOf(claim).map((pk) => world.byPk.get(pk)).filter((h) => h !== executor);
    const window = pingWindow(claim, claim);
    const fate = world.now >= window.until || requesters.length === 0 ? r.pick(['release', 'complete', 'lapse']) : r.pick(['extend', 'extend', 'cut', 'release', 'complete', 'lapse']);
    if (fate === 'release' || fate === 'complete') {
      if (!isActive(claim, world.now)) continue;
      executor.finish(taskId, fate === 'release' ? 'released' : 'completed');
      await world.settle();
      assert.deepEqual(everywhere(taskId, (t) => [t.state, t.claim]), hosts.map(() => ['available', null]), `an ended claim still holds ${taskId} somewhere`);
      if (fate === 'complete') {
        // Each offering host hears of the outcome and ends its own offer.
        for (const pk of offeredBy) world.byPk.get(pk).close(taskId);
        await world.settle();
        assert.deepEqual(everywhere(taskId, (t) => t.state), hosts.map(() => 'done'));
        for (const pk of offeredBy) assert.equal(hosts[0].pool.get(`offer/${taskId}/${pk}`).state, 'done', `an offer of ${taskId} stayed open after the task was done`);
        if (offeredBy.length > 1) tally.siblings += 1;
      }
      tally.ended += 1;
    } else if (fate === 'extend') {
      world.jump(Math.max(world.now, window.from + r.int(2 * GRACE)));
      r.pick(requesters).ping(taskId);
      await world.settle();
      const lease = claim.leaseUntil + LEASE;
      assert.deepEqual(everywhere(taskId, (t) => [t.claim?.seq, t.claim?.leaseUntil]), hosts.map(() => [1, lease]), `the extension of ${taskId} did not reach every host`);
      world.inspect(tasks, tally);
      tally.extended += 1;
    } else if (fate === 'cut') {
      // The executor is cut off from its requesters for the whole window: no ping
      // reaches it, and its claim lapses on both sides at once.
      world.split(hosts.map((h) => (h === executor ? 1 : 0)));
      world.jump(Math.max(world.now, window.from));
      for (const requester of requesters) requester.ping(taskId);
      await world.run();
      lapse(claim);
      world.heal();
      lapsing.push(claim);
    } else {
      lapsing.push(claim);
    }
  }
  for (const claim of lapsing) {
    const { taskId } = claim;
    lapse(claim);
    const hours = hosts[0].pool.task(taskId, world.now).hours;
    const next = r.pick(hosts.filter((h) => h.accepts >= hours));
    if (!next) continue;
    const prior = hosts[0].pool.get(claimKey(taskId, next.pk));
    next.want(taskId, 2);
    await world.settle();
    const kept = everywhere(taskId, (t) => t.claim);
    assert.deepEqual(kept.map((c) => [c?.executor, c?.gen, c?.state]), hosts.map(() => [next.pk, prior ? prior.gen + 1 : 0, 'held']), `the claim after a lapsed one is not its executor's next of ${taskId}`);
    for (const pk of backersOf(kept[0])) {
      if (backedBy(claim, pk)?.at === backedBy(kept[0], pk).at) assert.ok(backedBy(kept[0], pk).gen > backedBy(claim, pk).gen, 'an offer given again does not count one more');
    }
    // The lapsed claim, handed in again, takes nothing back.
    r.pick(hosts).pool.merge(claim, world.now);
    assert.deepEqual(everywhere(taskId, (t) => t.claim), kept);
    world.inspect(tasks, tally);
    tally.regen += 1;
  }

  // Two claims by different executors that one host backed with the same offer, the
  // second made while the first still held: one of the two claimants did not have the
  // other among the members it could ask.
  for (const [i, x] of world.commits.entries()) {
    for (const y of world.commits.slice(i + 1)) {
      const [a, b] = [x.claim, y.claim];
      if (a.taskId !== b.taskId || a.executor === b.executor) continue;
      if (!backersOf(a).some((pk) => backedBy(b, pk)?.at === backedBy(a, pk).at)) continue;
      // The first claim as its executor last signed it.
      const last = hosts[0].pool.get(claimKey(a.taskId, a.executor));
      if (last?.round !== a.round || b.claimedAt >= (last.state === 'held' ? last.leaseUntil + GRACE : last.at)) continue;
      const blind = a.absent.includes(b.executor) || b.absent.includes(a.executor) || !x.members.includes(b.executor) || !y.members.includes(a.executor);
      assert.ok(blind, `(c) two executors that granted each other both claimed ${a.taskId}`);
      tally.blind += 1;
    }
  }

  // Long after, with no word exchanged: the same records make the same state at any time.
  for (const later of [DAY - 1, DAY, 3 * DAY]) {
    world.jump(world.now + later);
    assert.equal(new Set(hosts.map((h) => h.pool.stateHash(world.now))).size, 1, 'the same records make different states as time passes');
  }
  const hashed = hosts[0].pool.stateHash(world.now);
  for (const host of hosts) host.pool.prune(world.now);
  assert.deepEqual(hosts.map((h) => h.pool.stateHash(world.now)), hosts.map(() => hashed));

  tally.schedules += 1;
  tally.sealed += world.sealed ? 1 : 0;
  tally.c += world.commits.length;
  tally.absent += world.commits.filter((c) => c.claim.absent.length > 0).length;
  tally.e += world.rounds.length;
  tally.timeouts += world.rounds.filter((run) => run.outcome === 'timeout').length;
  for (const [key, count] of Object.entries(world.seen)) tally[key] += count;
  return world;
}

async function calmWorld(n, item, offerers = [0]) {
  const world = new World(1);
  for (let i = 0; i < n; i++) world.add(24);
  const { hosts } = world;
  hosts[0].found();
  for (const host of hosts.slice(1)) host.join(hosts[0]);
  await world.settle();
  const task = { item, taskId: taskIdOf(item) };
  for (const i of offerers) hosts[i].offer(task, 12);
  await world.settle();
  return { world, hosts, ...task };
}
const ITEMS = Array.from({ length: 10 }, (_, i) => `pr-${i}`);
const tally = {
  schedules: 0, sealed: 0, a: 0, b: 0, c: 0, d: 0, e: 0, absent: 0, blind: 0, won: 0, timeouts: 0, ended: 0, extended: 0, regen: 0,
  replays: 0, efforts: 0, midRound: 0, splits: 0, siblings: 0, twice: 0,
};

if (!isMainThread) {
  let seed;
  try {
    for (seed of workerData.seeds) await schedule(seed, tally);
    parentPort.postMessage({ tally });
  } catch (error) {
    parentPort.postMessage({ seed, stack: error.stack });
  }
}

if (isMainThread) {

  await check('two claimants racing in a calm network: the better-ranked one commits, the other stands down, long before a round times out', async () => {
    const winners = new Set();
    for (const item of ITEMS) {
      const { world, hosts, taskId } = await calmWorld(3, item);
      const started = world.ms;
      hosts[1].want(taskId, 1);
      hosts[2].want(taskId, 1);
      await world.settle();
      const [best, worst] = rankOf(taskId, hosts[1].pk) < rankOf(taskId, hosts[2].pk) ? [hosts[1], hosts[2]] : [hosts[2], hosts[1]];
      assert.deepEqual(world.rounds.map((run) => [run.host.index, run.outcome]).sort(), [[best.index, 'commit'], [worst.index, 'outranked']].sort());
      for (const host of hosts) assert.equal(host.pool.task(taskId, world.now).claim.executor, best.pk);
      assert.ok(world.ms - started < 30000, 'the race took as long as a round that times out');
      world.inspect([{ taskId }], tally);
      winners.add(best.index);
    }
    assert.equal(winners.size, 2, 'both rank orders were raced');
  });

  await check('two sides of a partition, each with a host that offers the task, each claim it; once healed every host holds both claims, each holding the offer of its own side', async () => {
    for (const item of ITEMS.slice(0, 4)) {
      const { world, hosts, taskId } = await calmWorld(4, item, [0, 2]);
      world.split([0, 0, 1, 1]);
      hosts[1].want(taskId, 1);
      hosts[3].want(taskId, 1);
      await world.settle();
      world.inspect([{ taskId }], tally);
      const [left, right] = [hosts[0].pool.get(claimKey(taskId, hosts[1].pk)), hosts[2].pool.get(claimKey(taskId, hosts[3].pk))];
      assert.deepEqual([left.gen, left.absent, backersOf(left)], [0, [hosts[2].pk, hosts[3].pk].sort(), [hosts[0].pk]]);
      assert.deepEqual([right.gen, right.absent, backersOf(right)], [0, [hosts[0].pk, hosts[1].pk].sort(), [hosts[2].pk]]);
      world.heal();
      await world.settle();
      world.inspect([{ taskId }], tally);
      assert.equal(new Set(hosts.map((h) => h.pool.stateHash(world.now))).size, 1);
      for (const host of hosts) {
        const held = Object.fromEntries(host.pool.task(taskId, world.now).offers.map((o) => [o.host, o.claim]));
        assert.deepEqual(held, { [hosts[0].pk]: left, [hosts[2].pk]: right }, 'neither claim takes the offer the other side gave');
      }
      assert.deepEqual([hosts[1].executing(taskId), hosts[3].executing(taskId)], [true, true], 'the task is run twice');
    }
  });

  await check('a side of a partition without a host that offers the task cannot claim it', async () => {
    const { world, hosts, taskId } = await calmWorld(4, 'pr-1');
    world.split([0, 0, 1, 1]);
    hosts[3].want(taskId, 1);
    hosts[1].want(taskId, 1);
    await world.settle();
    assert.deepEqual(world.rounds.map((run) => [run.host.index, run.outcome]).sort(), [[1, 'commit'], [3, 'no-requester']]);
    world.heal();
    await world.settle();
    for (const host of hosts) assert.equal(host.pool.task(taskId, world.now).claim.executor, hosts[1].pk);
  });

  await check('a claimant that crashes holding grants blocks the task until they expire, and no longer', async () => {
    const { world, hosts, taskId } = await calmWorld(3, 'pr-1');
    hosts[1].crashAt = 1;
    hosts[1].want(taskId, 1);
    world.at(2000, () => hosts[2].want(taskId, 12));
    await world.settle();
    const [crashed] = world.rounds;
    assert.deepEqual([crashed.host.index, crashed.outcome, hosts[1].up], [1, 'crashed', false]);
    const exp = crashed.snapshot.asOf + 120;
    const claim = hosts[0].pool.get(claimKey(taskId, hosts[2].pk));
    assert.deepEqual([claim.absent, claim.grants.map((g) => g.by), backersOf(claim)], [[hosts[1].pk], [hosts[0].pk], [hosts[0].pk]]);
    assert.ok(claim.claimedAt > exp, 'claimed while the crashed claimant\'s grants could still be committed');
    assert.ok(claim.claimedAt < exp + 60, 'the task stayed blocked long after the grants expired');
    assert.ok(world.rounds.slice(1).every((run) => run.outcome === 'commit' || run.outcome === 'outranked'), 'nothing times out waiting for the dead claimant');
  });

  await check('a lease is extended across the network; cut off from its requester the claim lapses for every host at once, and the next claim is the one the requester gives its offer to after it', async () => {
    const { world, hosts, taskId } = await calmWorld(3, 'pr-1');
    const [requester, executor, third] = hosts;
    executor.want(taskId, 1);
    await world.settle();
    const first = requester.pool.get(claimKey(taskId, executor.pk));
    world.jump(first.leaseUntil - 30);
    requester.ping(taskId);
    await world.settle();
    const second = third.pool.get(claimKey(taskId, executor.pk));
    assert.deepEqual([second.seq, second.leaseUntil, second.ping.by], [1, first.leaseUntil + LEASE, requester.pk]);
    world.split([0, 1, 0]);
    world.jump(second.leaseUntil - GRACE);
    requester.ping(taskId);
    await world.run();
    const lapse = second.leaseUntil + GRACE;
    world.jump(lapse - 1);
    assert.deepEqual(hosts.map((h) => h.pool.task(taskId, world.now).state), ['claimed', 'claimed', 'claimed']);
    world.jump(lapse);
    assert.deepEqual(hosts.map((h) => h.pool.task(taskId, world.now).state), ['available', 'available', 'available']);
    assert.equal(executor.executing(taskId), false);
    world.heal();
    third.want(taskId, 1);
    await world.settle();
    const next = hosts.map((h) => h.pool.task(taskId, world.now).claim);
    assert.deepEqual(next.map((c) => [c.executor, c.gen, backedBy(c, requester.pk).gen]), hosts.map(() => [third.pk, 0, 2]));
    assert.equal(backedBy(second, requester.pk).gen, 1);
    assert.deepEqual(hosts.map((h) => h.pool.get(claimKey(taskId, executor.pk))), [second, second, second], 'the lapsed claim is a record still, and holds nothing');
  });

  await check('a claim nobody heard of loses its offer to the claim the offering host gave it to next: its executor stops, and the other goes on', async () => {
    const { world, hosts, taskId } = await calmWorld(3, 'pr-1');
    const [requester, first, second] = hosts;
    first.dieAtCommit = true;
    first.want(taskId, 1);
    await world.settle();
    const lost = first.pool.get(claimKey(taskId, first.pk));
    assert.deepEqual([first.up, backedBy(lost, requester.pk).gen, requester.pool.task(taskId, world.now).state], [false, 1, 'available']);
    world.jump(world.now + 121);
    second.want(taskId, 1);
    await world.settle();
    const kept = requester.pool.task(taskId, world.now).claim;
    assert.deepEqual([kept.executor, kept.absent, backedBy(kept, requester.pk).gen], [second.pk, [first.pk], 2]);
    world.restart(first);
    await world.settle();
    world.inspect([{ taskId }], tally);
    for (const host of hosts) {
      assert.deepEqual([host.pool.get(claimKey(taskId, first.pk)), host.pool.task(taskId, world.now).claim], [lost, kept], 'both are records; the offer is the later one\'s');
    }
    assert.deepEqual([first.executing(taskId), second.executing(taskId)], [false, true]);
  });

  await check('a host cut off for longer than the retention cannot bring a finished task back', async () => {
    const { world, hosts, taskId } = await calmWorld(4, 'pr-1');
    const [requester, executor, third, straggler] = hosts;
    const offerKey = `offer/${taskId}/${requester.pk}`;
    executor.want(taskId, 1);
    await world.settle();
    const [open, held] = [straggler.pool.get(offerKey), straggler.pool.get(claimKey(taskId, executor.pk))];
    assert.deepEqual([open.state, held.executor], ['open', executor.pk]);
    // The straggler loses the network; the task is finished without it.
    world.split([0, 0, 0, 1]);
    world.jump(world.now + 600);
    executor.finish(taskId, 'completed');
    requester.close(taskId);
    await world.settle();
    const ended = requester.pool.get(offerKey).at;
    assert.equal(straggler.pool.task(taskId, world.now).state, 'claimed', 'what the straggler still believes');
    // Three days pass, every host signing its records again four times a day.
    for (let i = 0; i < 12; i++) {
      world.jump(world.now + DAY / 4);
      for (const host of hosts) host.resign();
      await world.settle();
      for (const host of hosts) host.pool.prune(world.now);
      for (const host of [requester, executor, third]) assert.notEqual(host.pool.task(taskId, world.now)?.state, 'available');
    }
    assert.ok(world.now > ended + DAY + 300);
    for (const host of hosts) assert.equal(host.pool.get(offerKey), null, 'the end itself is forgotten by now');
    assert.deepEqual(hosts.map((h) => h.pool.members(world.now).length), [3, 3, 3, 1], 'each side stopped waiting for the other');
    // Back on the network, it pushes everything it ever held for the task.
    world.heal();
    await world.settle();
    assert.equal(new Set(hosts.map((h) => h.pool.stateHash(world.now))).size, 1);
    assert.deepEqual(hosts.map((h) => h.pool.members(world.now).length), [4, 4, 4, 4], 'signed again, it is a member again without an invite');
    for (const host of [requester, executor, third]) {
      assert.deepEqual(host.handle(straggler.pk, 'push', { records: [open, held] }).body.refused, [{ key: offerKey, code: 'expired' }, { key: claimKey(taskId, executor.pk), code: 'expired' }]);
      assert.equal(host.pool.task(taskId, world.now), null);
    }
    third.want(taskId, 1);
    straggler.want(taskId, 1);
    await world.settle();
    assert.deepEqual(world.rounds.slice(1).map((run) => run.outcome), ['unavailable', 'unavailable'], 'nobody can claim it again');
  });

  await check('two hosts offer one task and one claim takes both offers: each host ends its own, and the one that has not heard still offers it', async () => {
    const { world, hosts, taskId } = await calmWorld(4, 'pr-2', [0, 2]);
    const [first, executor, second, bystander] = hosts;
    executor.want(taskId, 1);
    await world.settle();
    const claim = bystander.pool.task(taskId, world.now).claim;
    assert.deepEqual([world.rounds.length, backersOf(claim).sort(), bystander.pool.task(taskId, world.now).free], [1, [first.pk, second.pk].sort(), []]);
    // The two offering hosts are apart when the first learns the outcome.
    world.split([0, 0, 1, 0]);
    first.close(taskId);
    await world.settle();
    for (const host of [first, executor, bystander]) {
      const task = host.pool.task(taskId, world.now);
      assert.deepEqual([task.state, task.offeredBy, task.claim], ['claimed', [second.pk], claim], 'the offer of the other host is its own to end');
    }
    world.heal();
    second.close(taskId);
    await world.settle();
    for (const host of hosts) {
      assert.equal(host.pool.task(taskId, world.now).state, 'done');
      assert.deepEqual([first.pk, second.pk].map((pk) => host.pool.get(`offer/${taskId}/${pk}`).state), ['done', 'done']);
    }
    bystander.want(taskId, 1);
    await world.settle();
    assert.equal(world.rounds.at(-1).outcome, 'unavailable');
    // Offered again later, it is a task again.
    world.jump(world.now + 3600);
    second.offer({ item: 'pr-2' }, 12);
    await world.settle();
    for (const host of hosts) assert.deepEqual([host.pool.task(taskId, world.now).state, host.pool.task(taskId, world.now).offeredBy], ['available', [second.pk]]);
  });

  const only = process.env.DN_SIM_SEED;
  const count = Number(process.env.DN_SIM_SCHEDULES) || 2000;
  const rerun = (seed) => `FAILED schedule seed ${seed} - run it alone with DN_SIM_SEED=${seed} node test/core-sim.mjs`;
  if (only) {
    const world = await schedule(Number(only), tally).catch((error) => {
      console.error(rerun(only));
      throw error;
    });
    console.log(`seed ${only} (${world.about}) holds: ${world.rounds.map((run) => run.outcome).join(' ') || 'no rounds'}`);
  } else {
    const started = Date.now();
    const jobs = Math.min(4, os.availableParallelism(), count);
    const reports = await Promise.all(Array.from({ length: jobs }, (_, job) => new Promise((resolve, reject) => {
      const seeds = Array.from({ length: count }, (__, i) => i + 1).filter((seed) => seed % jobs === job);
      const worker = new Worker(new URL(import.meta.url), { workerData: { seeds } });
      worker.once('message', resolve);
      worker.once('error', reject);
    })));
    const failed = reports.filter((report) => report.stack).sort((x, y) => x.seed - y.seed);
    for (const { seed, stack } of failed) console.error(`${rerun(seed)}\n${stack}`);
    if (failed.length > 0) process.exit(1);
    for (const report of reports) {
      for (const [key, n] of Object.entries(report.tally)) tally[key] += n;
    }
    console.log(`${tally.schedules} schedules in ${((Date.now() - started) / 1000).toFixed(1)} s: ${tally.e} rounds, ${tally.timeouts} of them timed out, ${tally.splits} partitions`);

    // Every schedule held every invariant, or the run stopped above; show that the
    // schedules reached each of them.
    const shown = (name, counts) => check(`${name} [${Object.entries(counts).map(([what, k]) => `${k} ${what}`).join(', ')}]`, () => {
      for (const [what, k] of Object.entries(counts)) assert.ok(k > 0 || count < 500, `no schedule reached: ${what}`);
    });
    await shown('(a) hosts that reach each other agree on the claim that holds each offer', { agreements: tally.a });
    await shown('(b) healed and synced, every host holds the same state and for each offer the claim the conflict rules name', { 'offers two held claims were backed with': tally.b, 'pairs of rival claims': tally.blind, 'tasks two executors hold at once': tally.twice });
    await shown('(c) no claim is committed without a grant from every member heard in its round', { claims: tally.c, 'with a member absent': tally.absent, 'claimants crashed mid-round': tally.midRound });
    await shown('(d) a lapsed claim frees its task for every host at the same second', { lapses: tally.d, 'claimed again, each offer given once more': tally.regen });
    await shown('(e) every round ends by its deadline, and a calm network never needs the deadline', { rounds: tally.e, 'calm races won': tally.won });
    await shown('leases are extended, given up and completed for every host alike', { extended: tally.extended, ended: tally.ended });
    await shown('a task two hosts offer is done once each of them says so', { 'tasks two hosts ended their offers of': tally.siblings });
    await shown('behind signed envelopes and proof of work no replay reaches a handler', { schedules: tally.sealed, 'replays refused': tally.replays, 'requests redone at a higher effort': tally.efforts });
  }
}
