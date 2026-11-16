// What goes wrong around a job, with whole daemons: an executor that dies, one that is
// restarted under its job, an offer withdrawn while it runs, a network cut and healed, a
// machine without docker, a requester whose forge credential fails, a job nobody's run
// stands behind, a word on free slots gone stale, and the network switched off.
// Real daemon processes on scratch directories over the loop transport, with the
// stand-in docker, forge and agent.
// Run: node test/daemon-failures.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { createCA } from '../src/executor/ca.js';
import { loopFaults } from '../src/transport/loop.js';
import { POOL, check, createBench, passed, until } from './lib/daemons.mjs';

const bench = await createBench();
const faults = loopFaults(bench.loopDir);

const offerOf = async (m, taskId) => (await m.state()).offers.find((o) => o.taskId === taskId);
const taskOf = async (m, taskId) => (await m.state()).pools[0].tasks.find((t) => t.taskId === taskId) ?? null;
const runOf = async (m, taskId) => (await m.state()).runs.filter((r) => r.taskId === taskId).at(-1) ?? null;
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const review = (prompt, more = {}) => ({ pool: POOL, kind: 'review', item: 'pr-1', title: 'Review', prompt, ...more });
const POST = 'api POST /repos/acme/widgets/pulls/1/reviews {"event":"COMMENT","body":"seen"}';

// Machines of one pool of their own: the first founds it, the rest join by its invite.
async function pool(names, options = {}) {
  const all = names.map((name) => bench.machine(name, options[name] ?? options.all ?? {}));
  await Promise.all(all.map((m) => m.start()));
  await Promise.all(all.map((m) => m.linked()));
  const { invite } = await all[0].ok('/invite', { pool: POOL });
  await Promise.all(all.slice(1).map((m) => m.ok('/join', { invite })));
  await until(`${names.join(', ')} members of one pool`, async () => (await Promise.all(all.map((m) => m.state()))).every((s) => s.pools[0].members.length === all.length));
  for (const m of all) m.pk = (await m.state()).identity.pk;
  return all;
}

// The run of a task on `m` once its agent waits for `file`.
const waiting = (m, taskId, file) => until(`${m.name}'s agent to wait for ${file}`, async () => {
  const run = await runOf(m, taskId);
  return run && m.agent(run.runId)?.waiting === file ? run : null;
});

try {
  await check('an executor that dies under a job loses its lease: the task goes to another machine, and after three failed attempts the offer has failed and says why', async () => {
    // Leases of seconds, not hours: the same for every member of this pool.
    const short = { env: { DN_LEASE_SECS: '10', DN_PING_LEAD_SECS: '6', DN_LEASE_GRACE_SECS: '3' } };
    const [a, b, c] = await pool(['ka', 'kb', 'kc'], { all: short });
    await b.admit(1);
    const { taskId } = await a.ok('/offer', review('wait go\nsay broke\nfail'));
    const first = await waiting(b, taskId, 'go');
    const agentPid = b.agent(first.runId).pid;
    assert.deepEqual([(await offerOf(a, taskId)).executor, (await offerOf(a, taskId)).attempt], [b.pk, 1]);

    // The whole machine goes: the daemon and the job with it.
    await b.kill();
    b.killJobs();
    await until('the job gone', () => !alive(agentPid));
    await until('the task back in the pool', async () => (await offerOf(a, taskId)).attempt === 2);
    const again = await offerOf(a, taskId);
    assert.deepEqual([again.state, again.reason, again.executor], ['pooled', 'the machine running it stopped answering', '']);

    // The next machine is the second the offer is given to, and its agent fails.
    await c.admit(1);
    const second = await waiting(c, taskId, 'go');
    assert.deepEqual([(await offerOf(a, taskId)).state, (await offerOf(a, taskId)).executor], ['claimed', c.pk]);
    const claims = JSON.parse(fs.readFileSync(path.join(c.base, 'pools', fs.readdirSync(path.join(c.base, 'pools'))[0]), 'utf8')).records.filter((r) => r.type === 'claim' && r.taskId === taskId);
    const given = claims.map((r) => [r.executor, r.grants.find((g) => g.by === a.pk).offer.gen]).sort((x, y) => x[1] - y[1]);
    assert.deepEqual(given, [[b.pk, 1], [c.pk, 2]], 'the offer is held by the claim its host gave it to last');
    c.release('go');
    await until('the second failure', async () => {
      const offer = await offerOf(a, taskId);
      return offer.attempt === 3 && offer.state === 'pooled';
    });
    assert.equal((await offerOf(a, taskId)).reason, 'broke');
    await until('C\'s run over', async () => (await runOf(c, taskId)).endedAt > 0);
    assert.deepEqual([(await runOf(c, taskId)).runId, (await runOf(c, taskId)).state, (await runOf(c, taskId)).exit], [second.runId, 'failed', 1]);

    // A machine that failed at a task leaves it to the others: C, still admitting, does
    // not take it again. The third attempt is the requester's own, and the last.
    const from = (await c.state()).updatedAt;
    await until('C to have had its chance', async () => {
      const state = await c.state();
      assert.equal(state.runs.length, 1, 'C must not take again what it failed at');
      return state.updatedAt >= from + 3;
    });
    await a.admit(1);
    await waiting(a, taskId, 'go');
    assert.equal((await offerOf(a, taskId)).executorHere, true);
    a.release('go');
    const failed = await until('the offer failed', async () => {
      const offer = await offerOf(a, taskId);
      return offer.state === 'failed' ? offer : null;
    });
    // The failed offer keeps the machine that held it last: this one, whose attempt was the third.
    assert.deepEqual([failed.attempt, failed.reason, failed.outcome, failed.endedAt > 0, failed.executor, failed.executorHere], [
      3, 'broke', { ok: false, summary: 'broke', usd: 0.42, tokens: 120, runner: 'claude', model: '' }, true, a.pk, true,
    ]);
    await until('the task cancelled for the pool', async () => (await taskOf(c, taskId)).state === 'cancelled');
    await Promise.all([a.kill(), c.kill()]);
  });

  await check('a daemon restarted under a job takes the job up again: it is not started twice, it still acts as its requester, and it finishes', async () => {
    const [a, b] = await pool(['ra', 'rb']);
    await b.admit(1);
    const { taskId } = await a.ok('/offer', review(`wait go\n${POST}\nsay finished after a restart`));
    const run = await waiting(b, taskId, 'go');
    const agentPid = b.agent(run.runId).pid;
    const [restarts, runs] = [b.docker('restart').length, b.docker('run').length];

    // Stopped the way an applet stops it: the run is left going.
    assert.deepEqual(await b.stop(), { code: 0, signal: null });
    assert.equal(alive(agentPid), true, 'the job outlives the daemon');
    // A newer authority for the same hosts, as one is made when the last nears its end:
    // the job trusts the one it was started under, and is answered from that one.
    const authorities = path.join(b.base, 'ca');
    const [started] = fs.readdirSync(authorities);
    const { hosts, createdAt } = JSON.parse(fs.readFileSync(path.join(authorities, started, 'meta.json'), 'utf8'));
    const aside = path.join(bench.root, 'aside-ca');
    const newer = await createCA({ dir: aside }).authority(hosts);
    fs.writeFileSync(path.join(aside, newer.id, 'meta.json'), JSON.stringify({ hosts, constrained: newer.constrained, createdAt: createdAt + 3600 }));
    fs.renameSync(path.join(aside, newer.id), path.join(authorities, newer.id));
    await b.start();
    await until('the job taken up', () => new RegExp(`${run.runId} taken up in ${run.container}`).test(b.log()));
    await b.admit(1);
    const taken = await runOf(b, taskId);
    assert.deepEqual([taken.runId, taken.state, taken.endedAt], [run.runId, 'running', 0]);
    assert.deepEqual([b.docker('run').length, b.docker('restart').slice(restarts), alive(agentPid)], [runs, [], true], 'the container was neither made again nor restarted under the job');
    assert.deepEqual([(await offerOf(a, taskId)).state, (await offerOf(a, taskId)).attempt], ['claimed', 1]);

    b.release('go');
    const done = await until('the offer done', async () => {
      const offer = await offerOf(a, taskId);
      return offer.state === 'done' ? offer : null;
    });
    assert.equal(done.outcome.summary, 'finished after a restart');
    const agent = b.agent(run.runId);
    assert.deepEqual([agent.pid, agent.steps.find((s) => s.verb === 'api').status], [agentPid, 201], 'the same process, reaching the forge through the same proxy address');
    assert.deepEqual(bench.sentWith(a.token).filter(([method]) => method === 'POST'), [['POST', 'api.github.com', '/repos/acme/widgets/pulls/1/reviews']]);
    await until('B\'s run finished', async () => (await runOf(b, taskId)).state === 'finished');

    // Killed outright this time, and the job ends while nobody watches: the next daemon
    // reports how it ended.
    const next = await a.ok('/offer', { ...review('wait away\nsay finished while the daemon was away'), item: 'pr-2' });
    const other = await waiting(b, next.taskId, 'away');
    await b.kill();
    b.release('away');
    await until('the agent ended', () => b.agent(other.runId)?.ended === true);
    assert.equal((await offerOf(a, next.taskId)).state, 'claimed');
    await b.start();
    await until('the outcome reported', async () => (await offerOf(a, next.taskId)).state === 'done');
    assert.equal((await offerOf(a, next.taskId)).outcome.summary, 'finished while the daemon was away');
    assert.equal((await runOf(b, next.taskId)).state, 'finished');

    // The port a job reaches its broker on is taken by something else when the daemon
    // comes back: the job can ask nothing of anybody any more, and is stopped.
    await b.admit(1);
    const third = await a.ok('/offer', { ...review('wait never\nsay never'), item: 'pr-3' });
    const cut = await waiting(b, third.taskId, 'never');
    const cutPid = b.agent(cut.runId).pid;
    await b.stop();
    const { port } = JSON.parse(fs.readFileSync(path.join(b.base, 'jobs.json'), 'utf8'));
    const squatter = net.createServer((socket) => socket.destroy());
    await new Promise((resolve, reject) => { squatter.once('error', reject); squatter.listen(port, '127.0.0.1', resolve); });
    await b.start();
    await until('the job stopped', () => !alive(cutPid));
    assert.match(b.log(), new RegExp(`giving ${cut.runId} back: the broker could not listen where this job reaches it`));
    await until('B\'s run stopped', async () => (await runOf(b, third.taskId)).state === 'stopped');
    // The run's record and the log say what stopped it: nothing the operator did.
    const record = JSON.parse(fs.readFileSync(path.join(b.base, 'runs.json'), 'utf8')).runs[cut.runId];
    assert.equal(record.outcome.summary, 'the broker could not listen where this job reaches it');
    assert.match(b.log(), new RegExp(`stopping ${cut.runId}: the broker could not listen where this job reaches it`));
    assert.doesNotMatch(b.log(), /stopped by the operator/);
    await until('the task back in the pool', async () => (await offerOf(a, third.taskId)).state === 'pooled');
    assert.equal((await offerOf(a, third.taskId)).attempt, 1, 'given back, not failed');
    await new Promise((resolve) => squatter.close(resolve));
    await Promise.all([a.kill(), b.kill()]);
  });

  await check('an offer withdrawn while its job runs stops that job, and a job no run stands behind is stopped too', async () => {
    const [a, b] = await pool(['wa', 'wb']);
    await b.admit(1);
    const { taskId } = await a.ok('/offer', review('wait never\nsay never'));
    const run = await waiting(b, taskId, 'never');
    const agentPid = b.agent(run.runId).pid;
    assert.deepEqual(await a.ok('/withdraw', { taskId, reason: 'merged meanwhile' }), { ok: true, ended: true });
    await until('B\'s job stopped', () => !alive(agentPid));
    await until('B\'s run stopped', async () => (await runOf(b, taskId)).state === 'stopped');
    assert.deepEqual([(await offerOf(a, taskId)).state, (await offerOf(a, taskId)).reason], ['cancelled', 'merged meanwhile']);
    assert.match(b.log(), new RegExp(`stopping ${run.runId}: the task was withdrawn`));

    // B loses its own record of a run while its job goes on: the job is found in the
    // container and stopped, because no run of B's stands behind it.
    const next = await a.ok('/offer', { ...review('wait never\nsay never'), item: 'pr-2' });
    const orphan = await waiting(b, next.taskId, 'never');
    const orphanPid = b.agent(orphan.runId).pid;
    await b.kill();
    fs.rmSync(path.join(b.base, 'runs.json'));
    await b.start();
    await until('the orphan stopped', () => !alive(orphanPid));
    assert.match(b.log(), new RegExp(`stopping ${orphan.runId}: no run of this host stands behind it`));
    assert.deepEqual((await b.state()).runs, []);
    await Promise.all([a.kill(), b.kill()]);
  });

  await check('a network cut between requester and executor heals: the claim, the job and its end all arrive', async () => {
    const [a, b] = await pool(['pa', 'pb']);
    const [onionA, onionB] = [(await a.state()).identity.onion, (await b.state()).identity.onion];
    await b.admit(1);
    faults.cut(onionA, onionB);
    const { taskId } = await a.ok('/offer', review(`wait go\n${POST}\nsay done across the cut`));
    assert.equal(await taskOf(b, taskId), null, 'B cannot hear of it');
    faults.cut(onionA, onionB, false);
    const run = await waiting(b, taskId, 'go');
    assert.equal((await offerOf(a, taskId)).executor, b.pk);

    // Cut again under the running job: its forge request has nobody to carry it out.
    faults.cut(onionA, onionB);
    b.release('go');
    await until('the job ended on B', async () => (await runOf(b, taskId)).endedAt > 0);
    const step = b.agent(run.runId).steps.find((s) => s.verb === 'api');
    assert.deepEqual([step.status, step.body], [504, { message: 'no answer from the requester: the request may have been carried out' }], 'the agent is told plainly that its requester did not answer');
    assert.equal((await offerOf(a, taskId)).state, 'claimed', 'A has not heard that it ended');
    faults.cut(onionA, onionB, false);
    await until('A hears the end', async () => (await offerOf(a, taskId)).state === 'done');
    assert.equal((await offerOf(a, taskId)).outcome.summary, 'done across the cut');
    await until('one state on both', async () => (await a.state()).pools[0].hash === (await b.state()).pools[0].hash);
    assert.equal((await taskOf(b, taskId)).state, 'done');
    await Promise.all([a.kill(), b.kill()]);
  });

  await check('a machine without docker takes nothing and says why; a requester whose forge credential fails tells the agent so', async () => {
    const [a, b, c] = await pool(['da', 'db', 'dc'], { da: { env: { DN_TOKEN_TTL_MS: '1' } }, db: { docker: 'none' } });
    await b.admit(1);
    const docker = (await until('B\'s word on docker', async () => { const s = await b.state(); return s.docker.detail === 'not checked yet' ? null : s; })).docker;
    assert.equal(docker.state, 'missing');
    assert.match(docker.detail, /no-docker not found: every job runs in a container/);
    assert.ok(b.log().includes(`] docker is not at ${b.env.DN_DOCKER}\n`), 'a tool named by its path is looked for there alone');

    const { taskId } = await a.ok('/offer', review('wait go\napi GET /repos/acme/widgets/pulls/1\napi DELETE /repos/acme/widgets\nsay told'));
    await until('B knows the task', async () => (await taskOf(b, taskId))?.state === 'available');
    // B could claim it many times over in the time it is watched here.
    const from = (await b.state()).updatedAt;
    await until('B to have had its chance', async () => {
      const s = await b.state();
      assert.deepEqual([s.pools[0].tasks[0].state, s.runs], ['available', []], 'a machine that could not run it must not hold it');
      return s.updatedAt >= from + 3;
    });
    await c.admit(1);
    const run = await waiting(c, taskId, 'go');
    assert.deepEqual([(await offerOf(a, taskId)).executor, (await offerOf(a, taskId)).attempt], [c.pk, 1]);

    // A's `gh` stops giving a token while the job runs.
    fs.writeFileSync(a.env.DN_GH, '#!/bin/sh\necho "gh: not logged in" >&2\nexit 1\n');
    c.release('go');
    await until('the offer done', async () => (await offerOf(a, taskId)).state === 'done');
    const [asked, refused] = c.agent(run.runId).steps.filter((s) => s.verb === 'api');
    assert.equal(asked.status, 502);
    assert.match(asked.body.message, /^the forge could not be asked: /);
    assert.deepEqual([refused.status, refused.body], [403, { message: 'no rule of this task allows the request' }]);
    assert.deepEqual([(await offerOf(a, taskId)).requests, (await offerOf(a, taskId)).refused], [2, 1]);
    assert.equal(bench.sentWith(a.token).length, 0, 'nothing reached the forge in A\'s name');
    await Promise.all([a.kill(), b.kill(), c.kill()]);
  });

  await check('a word on free slots goes stale: a daemon that has not heard from Diplomat takes nothing until it hears again', async () => {
    const [a, b] = await pool(['sa', 'sb'], { sb: { env: { DN_ADMIT_TTL_MS: '1500' } } });
    await b.ok('/admit', { slots: 1 });
    const said = (await b.state()).admit.at;
    await until('that word to be old', async () => (await b.state()).updatedAt > said + 3);
    const { taskId } = await a.ok('/offer', review('say taken'));
    await until('B knows the task', async () => (await taskOf(b, taskId))?.state === 'available');
    const from = (await b.state()).updatedAt;
    await until('B to have had its chance', async () => {
      const s = await b.state();
      assert.deepEqual([s.pools[0].tasks[0].state, s.runs], ['available', []], 'a stale word admits nothing');
      return s.updatedAt >= from + 3;
    });
    await b.ok('/admit', { slots: 1 });
    await until('the offer done', async () => (await offerOf(a, taskId)).state === 'done');
    await Promise.all([a.kill(), b.kill()]);
  });

  await check('the network switched off: the daemon cancels what it offered, stops what it runs and gives it back, tells the pool, and exits', async () => {
    const [a, b, c] = await pool(['oa', 'ob', 'oc', 'od']);
    await a.admit(1);
    const theirs = await b.ok('/offer', review('wait never\nsay never'));
    const run = await waiting(a, theirs.taskId, 'never');
    const agentPid = a.agent(run.runId).pid;
    // A's one slot is taken, and nobody else admits anything: A's own offer waits in the pool.
    const mine = await a.ok('/offer', { ...review('say never'), item: 'pr-2', kind: 'investigate' });
    await until('B knows A\'s task', async () => (await taskOf(b, mine.taskId))?.state === 'available');

    a.setConfig({ networkEnabled: false });
    assert.deepEqual(await a.exit, { code: 0, signal: null });
    assert.match(a.log(), /ending: the network was switched off in Diplomat's settings[\s\S]*ended/);
    assert.equal(alive(agentPid), false, 'its job is stopped before it goes');
    // The pool was told before the daemon went: no lease has to run out first.
    await until('B hears', async () => (await taskOf(b, mine.taskId)).state === 'cancelled' && (await offerOf(b, theirs.taskId)).state === 'pooled');
    assert.deepEqual([(await offerOf(b, theirs.taskId)).attempt, (await offerOf(b, theirs.taskId)).executor], [1, ''], 'given back, not failed');
    const left = JSON.parse(fs.readFileSync(path.join(a.base, 'state.json'), 'utf8'));
    assert.deepEqual([left.offers.map((o) => [o.state, o.reason]), left.runs.map((r) => r.state)], [[['cancelled', 'the network was switched off']], ['stopped']]);
    assert.equal(fs.existsSync(a.socket), false);

    // An applet turns the switch and then stops the daemon. Nothing B tells the pool
    // arrives now, so its switching off is still under way when the signal comes: the
    // signal does not cut it short.
    const again = await b.ok('/offer', { ...review('say never'), item: 'pr-3' });
    await c.ok('/offer', { ...review('say never'), item: 'pr-4' });
    faults.delay(600000);
    b.setConfig({ networkEnabled: false });
    await until('B to notice the switch', () => /ending: the network was switched off/.test(b.log()));
    assert.deepEqual(await b.stop(), { code: 0, signal: null });
    assert.match(b.log(), /ended\n$/);
    const last = JSON.parse(fs.readFileSync(path.join(b.base, 'state.json'), 'utf8'));
    assert.deepEqual(last.offers.filter((o) => [again.taskId, theirs.taskId].includes(o.taskId)).map((o) => [o.state, o.reason]).sort(), [
      ['cancelled', 'the network was switched off'], ['cancelled', 'the network was switched off'],
    ]);

    // A second signal is the operator saying "now": the daemon goes at once.
    c.setConfig({ networkEnabled: false });
    await until('C to notice the switch', () => /ending: the network was switched off/.test(c.log()));
    // Two different signals: the system delivers two of one kind as one.
    process.kill(c.pid, 'SIGTERM');
    process.kill(c.pid, 'SIGINT');
    assert.deepEqual(await c.exit, { code: 1, signal: null });
    assert.match(c.log(), /SIG(TERM|INT) again: exiting at once\n$/);
    faults.delay(0);
  });

  console.log(`\nall ${passed()} checks passed`);
} finally {
  await bench.close();
}
process.exit(0);
