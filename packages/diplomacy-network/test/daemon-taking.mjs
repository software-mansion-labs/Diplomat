// What a machine does with a job it cannot start, and what it says of a job it does not
// take: a start that fails before the job ran costs the requester no attempt, the pool
// it failed in is left alone while the cause stands, and the snapshot says why - of the
// pool, and of a job of this machine's own that waits in it.
// Real daemon processes on scratch directories over the loop transport, with the
// stand-in docker, forge and agent.
// Run: node test/daemon-taking.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { POOL, check, createBench, heldGit, passed, until } from './lib/daemons.mjs';

const bench = await createBench();

const offerOf = async (m, taskId) => (await m.state()).offers.find((o) => o.taskId === taskId);
const taskOf = async (m, taskId) => (await m.state()).pools[0].tasks.find((t) => t.taskId === taskId) ?? null;
const runsOf = async (m, taskId) => (await m.state()).runs.filter((r) => r.taskId === taskId);
const review = (item, prompt, more = {}) => ({ pool: POOL, kind: 'review', item, title: item, prompt, ...more });
// What `m` logged of leaving a pool alone and of taking from it again: the line, when it
// was written, and the wait it names in seconds.
const turns = (m) => m.log().split('\n').filter((line) => /\] taking (no job|jobs) of /.test(line)).map((line) => ({
  text: line.replace(/^.*?\] /, ''), at: Date.parse(line.slice(1, line.indexOf(']'))), secs: Number(line.match(/ for (\d+) s: /)?.[1] ?? 0),
}));
const waits = (m) => turns(m).filter((turn) => turn.secs > 0).map((turn) => turn.text);

// Machines of one pool of their own: the first founds it, the rest join by its invite.
async function pool(names, options = {}) {
  const all = names.map((name) => (typeof name === 'string' ? bench.machine(name, options[name] ?? {}) : name));
  await Promise.all(all.map((m) => m.start()));
  await Promise.all(all.map((m) => m.linked()));
  const { invite } = await all[0].ok('/invite', { pool: POOL });
  await Promise.all(all.slice(1).map((m) => m.ok('/join', { invite })));
  await until(`${all.map((m) => m.name).join(', ')} members of one pool`, async () => (await Promise.all(all.map((m) => m.state()))).every((s) => s.pools[0].members.length === all.length));
  for (const m of all) m.pk = (await m.state()).identity.pk;
  return all;
}

// The task given back by `m`: its run there stopped, and its offer on `a` in the pool
// again.
async function givenBack(a, m, taskId) {
  const run = await until(`${m.name}'s run of the task to end`, async () => (await runsOf(m, taskId)).find((r) => r.endedAt > 0) ?? null);
  await until('the task back in the pool', async () => (await taskOf(a, taskId))?.state === 'available');
  return run;
}

try {
  await check('a job this machine cannot start for want of the repository costs its requester no attempt; the machine takes no job of that pool while the cause stands, says why of the pool, and takes them again once it is gone', async () => {
    const all = [bench.machine('ta'), bench.machine('tb', { env: { DN_POOL_RETRY_MS: '1000', DN_POOL_RETRY_MAX_MS: '2000' } })];
    const git = heldGit(all[1]);
    const [a, b] = await pool(all);
    // B's own way to the repository leads nowhere: no mirror can be made.
    const config = fs.readFileSync(b.env.GIT_CONFIG_GLOBAL, 'utf8');
    fs.writeFileSync(b.env.GIT_CONFIG_GLOBAL, config.replaceAll(`127.0.0.1:${bench.forge.port}`, '127.0.0.1:1'));
    await b.admit(1);
    const first = (await a.ok('/offer', review('pr-1', 'say one'))).taskId;
    const run = await givenBack(a, b, first);
    assert.equal(run.state, 'stopped');
    const offer = await offerOf(a, first);
    assert.deepEqual([offer.state, offer.attempt, offer.reason, offer.executor], ['pooled', 1, '', '']);
    assert.match((await b.state()).pools[0].notTaking, /^this machine could not start a job of this pool: .+/);
    assert.match(waits(b)[0], new RegExp(`^taking no job of ${POOL} for 1 s: .+`));
    assert.deepEqual(b.docker('run'), [], 'and made no container for it');

    // The next job waits in the pool while B looks at the cause again and again: once
    // each time its wait is over, however long the look takes.
    git.watch();
    fs.writeFileSync(git.hold, '');
    const second = (await a.ok('/offer', review('pr-2', 'say two'))).taskId;
    await until('B knows the second task', async () => (await taskOf(b, second))?.state === 'available');
    await until('B to look at the cause', git.waiting);
    const from = (await b.state()).updatedAt;
    await until('B to have come round to it several times more', async () => (await b.state()).updatedAt >= from + 4);
    fs.rmSync(git.hold);
    await until('B to have looked at the cause three times', () => waits(b).length >= 4);
    assert.deepEqual(await runsOf(b, second), [], 'a machine that cannot start it must not hold it');
    assert.deepEqual([(await offerOf(a, second)).state, (await offerOf(a, second)).attempt], ['pooled', 1]);
    assert.deepEqual(turns(b).slice(0, 4).map((turn) => turn.secs), [1, 2, 2, 2], 'twice as long each time, and no longer than the longest');

    fs.writeFileSync(b.env.GIT_CONFIG_GLOBAL, config);
    await until('the second job done by B', async () => (await offerOf(a, second)).state === 'done');
    assert.deepEqual([(await offerOf(a, second)).executor, (await offerOf(a, second)).attempt], [b.pk, 1]);
    assert.equal((await b.state()).pools[0].notTaking, '');
    const said = turns(b);
    assert.equal(said.at(-1).text, `taking jobs of ${POOL} again`);
    for (const [i, turn] of said.slice(1).entries()) {
      assert.ok(turn.at - said[i].at >= said[i].secs * 1000, `the pool is looked at no sooner than its wait is over: ${said.map((t) => `${t.at - said[0].at} ms ${t.text}`).join(' | ')}`);
    }
    await Promise.all([a.kill(), b.kill()]);
  });

  await check('a job whose container cannot be made is given back the same way; the wait before the pool is tried again doubles with each failure in a row and starts over once a job was started', async () => {
    const [a, b, c] = await pool(['ca', 'cb', 'cc'], { cb: { env: { DN_POOL_RETRY_MS: '1000' } } });
    const failing = `${b.dockerDir}/fail-run`;
    fs.writeFileSync(failing, 'no space left on device\nno space left on device\n');
    await b.admit(1);
    const tasks = [];
    for (const item of ['pr-1', 'pr-2']) {
      tasks.push((await a.ok('/offer', review(item, 'say done'))).taskId);
      const run = await givenBack(a, b, tasks.at(-1));
      assert.equal(run.state, 'stopped');
      assert.deepEqual([(await offerOf(a, tasks.at(-1))).attempt, (await offerOf(a, tasks.at(-1))).reason], [1, '']);
    }
    assert.deepEqual(waits(b), [1, 2].map((secs) => `taking no job of ${POOL} for ${secs} s: docker run: no space left on device`));
    assert.equal((await b.state()).pools[0].notTaking, 'this machine could not start a job of this pool: docker run: no space left on device');

    // The engine makes containers again: the pool is tried when its wait is over.
    const third = (await a.ok('/offer', review('pr-3', 'say done'))).taskId;
    await until('the third job done by B', async () => (await offerOf(a, third)).state === 'done');
    assert.equal((await b.state()).pools[0].notTaking, '');

    // Another requester's job needs a container of its own.
    fs.writeFileSync(failing, 'no space left on device\n');
    const fourth = (await c.ok('/offer', review('pr-4', 'say done'))).taskId;
    await givenBack(c, b, fourth);
    assert.equal(waits(b).length, 3);
    assert.equal(waits(b).at(-1), `taking no job of ${POOL} for 1 s: docker run: no space left on device`);
    await Promise.all([a.kill(), b.kill(), c.kill()]);
  });

  await check('a job of this machine\'s own that it does not take says why in its row: the pool\'s jobs cannot be started here, docker is missing or down, there is no credential for the model, the transport is not up, or the job needs more hours than this machine accepts', async () => {
    const own = async (m, more = {}) => {
      await m.linked();
      const { taskId } = await m.ok('/offer', review('pr-1', 'say done', { now: true, ...more }));
      return taskId;
    };
    const said = (m, taskId, what) => until(`${m.name}'s row to say ${what}`, async () => {
      const state = await m.state();
      const row = state.offers.find((o) => o.taskId === taskId);
      return row.notTaking !== '' && what.test(row.notTaking) ? [row, state] : null;
    });

    const stuck = await bench.machine('ns', { env: { DN_POOL_RETRY_MS: '3600000', DN_POOL_RETRY_MAX_MS: '3600000' } }).start();
    fs.writeFileSync(`${stuck.dockerDir}/fail-run`, 'no space left on device\n');
    const [given, state] = await said(stuck, await own(stuck), /^this machine could not start/);
    assert.deepEqual([given.state, given.attempt, given.notTaking], ['pooled', 1, 'this machine could not start a job of this pool: docker run: no space left on device']);
    assert.equal(state.pools[0].notTaking, given.notTaking);
    assert.equal(waits(stuck)[0], `taking no job of ${POOL} for 3600 s: docker run: no space left on device`);
    // Linked to another checkout, the pool is one nothing was found out about yet.
    fs.cpSync(stuck.checkout, `${stuck.checkout}2`, { recursive: true });
    await stuck.ok('/pools', { pools: [{ ...stuck.link, path: `${stuck.checkout}2` }] });
    await until('nothing held against the pool', async () => (await stuck.state()).pools[0].notTaking === '');

    // state.json follows what is held against a pool, on a machine nothing else happens on.
    const quiet = bench.machine('nq', { env: { DN_POOL_RETRY_MS: '1000', DN_POOL_RETRY_MAX_MS: '1000' } });
    const config = fs.readFileSync(quiet.env.GIT_CONFIG_GLOBAL, 'utf8');
    fs.writeFileSync(quiet.env.GIT_CONFIG_GLOBAL, config.replaceAll(`127.0.0.1:${bench.forge.port}`, '127.0.0.1:1'));
    await quiet.start();
    const onDisk = () => JSON.parse(fs.readFileSync(`${quiet.base}/state.json`, 'utf8')).pools[0]?.notTaking;
    const [waiting] = await said(quiet, await own(quiet), /^this machine could not start/);
    await until('state.json to say why', () => onDisk() === waiting.notTaking);
    fs.writeFileSync(quiet.env.GIT_CONFIG_GLOBAL, config);
    await until('nothing held against the pool', async () => (await quiet.state()).pools[0].notTaking === '');
    await until('state.json to say so too', () => onDisk() === '');

    // Nor is anything held against a pool that is linked no longer, when its wait is over.
    const gone = await bench.machine('nu', { env: { DN_POOL_RETRY_MS: '3000' } }).start();
    fs.writeFileSync(`${gone.dockerDir}/fail-run`, 'no space left on device\n');
    await said(gone, await own(gone), /^this machine could not start/);
    await gone.ok('/pools', { pools: [] });
    const from = (await gone.state()).updatedAt;
    await until('the wait to be well over', async () => gone.exited || (await gone.state()).updatedAt >= from + 6);
    assert.deepEqual([gone.exited, /\] uncaught: /.test(gone.log()), turns(gone).length], [false, false, 1]);

    const bare = await bench.machine('nd', { docker: 'none' }).start();
    const [noDocker, bareState] = await said(bare, await own(bare), /^docker is missing/);
    assert.equal(noDocker.notTaking, `docker is missing: ${bareState.docker.detail}`);
    assert.match(bareState.docker.detail, /no-docker not found/);
    // A job that is in the pool no longer, and a pool this machine left, say nothing.
    await bare.ok('/withdraw', { taskId: noDocker.taskId });
    assert.deepEqual((await bare.state()).offers.map((o) => [o.state, o.notTaking]), [['cancelled', '']]);
    assert.match((await bare.state()).pools[0].notTaking, /^docker is missing/);
    await bare.ok('/leave', { pool: POOL });
    assert.deepEqual((await bare.state()).pools.map((p) => [p.left, p.notTaking]), [[true, '']]);

    const down = bench.machine('ne');
    fs.writeFileSync(`${down.dockerDir}/down`, '');
    await down.start();
    const [noEngine, downState] = await said(down, await own(down), /^docker is down: the docker engine/);
    assert.equal(noEngine.notTaking, `docker is down: ${downState.docker.detail}`);
    assert.deepEqual(downState.runs, [], 'and it is not gone for');

    const keyless = bench.machine('nm');
    delete keyless.env.ANTHROPIC_API_KEY;
    await keyless.start();
    const [noModel, keylessState] = await said(keyless, await own(keyless), /^no credential for the model: no /);
    assert.equal(noModel.notTaking, `no credential for the model: ${keylessState.model.detail}`);
    assert.match(keylessState.model.detail, /no ANTHROPIC_API_KEY/);

    const slow = await bench.machine('nt', { transport: 'tor', env: { FAKE_TOR_STAGE: 'stall:50' } }).start();
    const [noWay, slowState] = await said(slow, await own(slow), /^the transport is bootstrapping/);
    assert.equal(noWay.notTaking, `the transport is bootstrapping: ${slowState.transport.detail}`);
    assert.equal(slowState.pools[0].notTaking, noWay.notTaking);

    const short = bench.machine('nh');
    short.setConfig({ networkRequiredMinimumH: 24, networkMaximumAcceptedH: 12 });
    await short.start();
    const [long, shortState] = await said(short, await own(short), /^this machine takes jobs/);
    assert.equal(long.notTaking, 'this machine takes jobs of at most 12 h and this one needs 24');
    assert.equal(shortState.pools[0].notTaking, '', 'the pool\'s other jobs it takes');

    // One it does take says nothing, as it waits and once it is held.
    const fine = await bench.machine('nf').start();
    await until('the machine ready', async () => { const s = await fine.state(); return s.docker.state === 'ready' && s.model.state === 'ready'; });
    const taken = await own(fine, { prompt: 'wait go\nsay done' });
    await until('the job running', async () => {
      const row = await offerOf(fine, taken);
      assert.equal(row.notTaking, '');
      return row.state === 'claimed' && fine.agent((await runsOf(fine, taken)).at(-1)?.runId)?.waiting === 'go';
    });
    assert.equal((await fine.state()).pools[0].notTaking, '');
    await Promise.all([stuck, quiet, gone, bare, down, keyless, slow, short, fine].map((m) => m.kill()));
  });
} finally {
  await bench.close();
}
console.log(`\n${passed()} checks passed`);
