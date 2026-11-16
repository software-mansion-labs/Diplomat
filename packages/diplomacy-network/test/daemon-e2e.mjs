// Whole daemons, one job, end to end: a machine offers a task, another claims it, gets
// the key, and runs the agent in a container; the agent clones from the executor's
// mirror and everything it asks of the forge is carried out by the requester, with the
// requester's credential, under the task's rules. Real daemon processes on scratch
// directories over the loop transport, with the stand-in docker, forge, adb server and
// agent.
// Run: node test/daemon-e2e.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { containerName } from '../src/executor/container.js';
import { GITLAB_POOL, POOL, REPO, check, createBench, fakeAdb, passed, until } from './lib/daemons.mjs';
import { GITLAB_HOST } from './lib/fake-forge.mjs';

const bench = await createBench();
const adb = await fakeAdb();
// Something else on the host a job is given by name.
const allocator = net.createServer((socket) => socket.end('allocator\n'));
await new Promise((resolve) => allocator.listen(0, '127.0.0.1', resolve));

const containerOf = (peer, pool = POOL) => containerName(pool, peer);
const offerOf = async (m, taskId) => (await m.state()).offers.find((o) => o.taskId === taskId);
const runOf = async (m, taskId) => (await m.state()).runs.filter((r) => r.taskId === taskId).at(-1) ?? null;
const ended = (m, taskId) => until(`${taskId} to end`, async () => {
  const offer = await offerOf(m, taskId);
  return ['done', 'failed', 'cancelled'].includes(offer.state) ? offer : null;
});
// How a step of the stand-in agent went: an API status, or whether a push was taken.
const went = (steps) => steps.map((s) => [s.verb, s.verb === 'push' ? (s.code === 0 ? 'pushed' : 'refused') : s.status ?? null]);
// Whose credential a request to the forge carried.
const sender = (machines) => (r) => machines.find((m) => [
  `Bearer ${m.token}`, `Basic ${Buffer.from(`x-access-token:${m.token}`).toString('base64')}`,
  `Bearer ${m.gitlabToken}`, `Basic ${Buffer.from(`oauth2:${m.gitlabToken}`).toString('base64')}`,
].includes(r.headers.authorization))?.name ?? null;

try {
  const a = bench.machine('a');
  const b = bench.machine('b', { env: { DN_ADB_SERVER: `127.0.0.1:${adb.port}`, DN_FORWARDS: JSON.stringify({ alloc: `127.0.0.1:${allocator.address().port}`, lan: '192.168.1.1:80' }) } });
  const c = bench.machine('c');
  // B's operator offers its devices to the jobs it runs.
  b.setConfig({ networkDevices: true });
  const by = sender([a, b, c]);
  await Promise.all([a.start(), b.start(), c.start()]);
  await Promise.all([a.linked(), b.linked(), c.linked()]);
  const { invite } = await a.ok('/invite', { pool: POOL });
  await Promise.all([b.ok('/join', { invite }), c.ok('/join', { invite })]);
  await until('three members everywhere', async () => (await Promise.all([a, b, c].map((m) => m.state()))).every((s) => s.pools[0].members.length === 3));
  const pk = Object.fromEntries(await Promise.all([a, b, c].map(async (m) => [m.name, (await m.state()).identity.pk])));
  // Only B takes work.
  await b.admit(1);

  let first;
  await check('a task offered on one machine is claimed by another, run there in a container, and done for both, with its cost', async () => {
    const before = bench.forge.log.length;
    const { taskId } = await a.ok('/offer', {
      pool: POOL, kind: 'review', item: 'pr-1', title: 'Review the pull request',
      prompt: [
        'wait go', 'api GET /repos/acme/widgets/pulls/1', 'api POST /repos/acme/widgets/pulls/1/reviews {"event":"COMMENT","body":"from a"}',
        'api DELETE /repos/acme/widgets', 'api POST /repos/acme/gadgets/pulls/1/reviews {"event":"COMMENT","body":"elsewhere"}',
        'push sneaky', 'adb', 'say reviewed the pull request',
      ].join('\n'),
    });
    assert.equal((await offerOf(a, taskId)).state, 'pooled');
    const run = await until('B\'s agent', async () => {
      const r = await runOf(b, taskId);
      return r && b.agent(r.runId)?.waiting === 'go' ? r : null;
    });
    first = run;

    // While it runs: claimed by B for A, on both machines.
    const offer = await offerOf(a, taskId);
    assert.deepEqual([offer.state, offer.executor, offer.executorHere, offer.attempt], ['claimed', pk.b, false, 1]);
    assert.deepEqual([run.state, run.peer, run.container, run.pool, run.endedAt], ['running', pk.a, containerOf(pk.a), POOL, 0]);
    for (const m of [a, b, c]) {
      const task = (await m.state()).pools[0].tasks.find((t) => t.taskId === taskId);
      assert.deepEqual([task.state, task.executor, task.executorHere, task.offeredHere], ['claimed', pk.b, m === b, m === a], m.name);
    }
    assert.deepEqual([(await a.state()).runs, (await c.state()).runs], [[], []], 'nobody else runs it');

    b.release('go');
    const done = await ended(a, taskId);
    assert.deepEqual([done.state, done.outcome, done.executor, done.executorHere], ['done', { ok: true, summary: 'reviewed the pull request', usd: 0.42, tokens: 120, runner: 'claude', model: '' }, pk.b, false], 'the ended offer keeps the machine that ran it');
    assert.deepEqual([done.requests, done.refused], [5, 3], 'four API requests and a push came under the key, and the rules refused three of them');
    await until('B\'s slot free', async () => (await runOf(b, taskId)).endedAt > 0);
    assert.deepEqual([(await runOf(b, taskId)).state, (await runOf(b, taskId)).exit], ['finished', 0]);
    for (const m of [a, b, c]) await until(`done on ${m.name}`, async () => (await m.state()).pools[0].tasks.find((t) => t.taskId === taskId).state === 'done');

    // What the agent got for each thing it asked.
    const steps = b.agent(run.runId).steps;
    assert.deepEqual(went(steps), [
      ['wait', null], ['api', 200], ['api', 201], ['api', 403], ['api', 403], ['push', 'refused'], ['adb', null], ['say', null],
    ]);
    assert.equal(steps[1].body.user.login, 'someone', 'the forge\'s own answer came back');
    assert.deepEqual(steps[3].body, { message: 'no rule of this task allows the request' });
    assert.deepEqual(steps[4].body, { message: 'no rule of this task allows the request' });
    assert.match(steps[5].out, /403/, 'a review task pushes nothing');

    // What reached the forge, and as whom: the requester's credential for everything the
    // task did, the executor's own for nothing but its mirror of the repository.
    const seen = bench.forge.log.slice(before).filter((r) => r.headers.authorization);
    assert.deepEqual(seen.filter((r) => r.host === 'api.github.com').map((r) => [by(r), r.method, r.path]), [
      ['a', 'GET', '/repos/acme/widgets/pulls/1'], ['a', 'POST', '/repos/acme/widgets/pulls/1/reviews'],
    ]);
    assert.deepEqual(JSON.parse(seen.find((r) => r.method === 'POST' && r.host === 'api.github.com').body), { event: 'COMMENT', body: 'from a' });
    assert.deepEqual([...new Set(seen.filter((r) => r.host === 'github.com').map((r) => `${by(r)} ${r.path.replace('/acme/widgets.git/', '')}`))].sort(),
      ['b git-upload-pack', 'b info/refs?service=git-upload-pack'], 'the clone is the executor\'s mirror, fetched as the executor');
    assert.equal(bench.branch('sneaky'), null);
    assert.match(b.log(), /mirror created .* from github\.com\/acme\/widgets/);
  });

  await check('the job holds no credential, reaches the host only through its forwards, and its container is locked away', async () => {
    const agent = b.agent(first.runId);
    const env = Object.entries(agent.env);
    for (const m of [a, b, c]) assert.ok(!JSON.stringify(agent.env).includes(m.token), `${m.name}'s forge token is not in the job`);
    assert.deepEqual([agent.env.GH_TOKEN, agent.env.ANTHROPIC_API_KEY], ['dn-placeholder', 'dn-placeholder'], 'placeholders the broker replaces');
    assert.ok(env.every(([, v]) => !v.includes('sk-ant-api03-stand-in')), 'nor is the model key');
    assert.match(agent.env.HTTPS_PROXY, /^http:\/\/dn:[0-9a-f]{64}@127\.0\.0\.1:\d+$/);
    assert.match(agent.prompt, /^[\s\S]+\n---\n\nwait go\n/, 'the container preamble, then the requester\'s words');

    // The adb server and what DN_FORWARDS names, each as the variable its tool reads; a
    // target off this machine's loopback is no forward. The server is asked after its
    // devices, and what would have it act on this machine never reaches it.
    const step = agent.steps.find((s) => s.verb === 'adb');
    assert.deepEqual([step.version, step.devices], ['OKAY00040029', 'OKAY0015emulator-5554\tdevice\n']);
    assert.equal(step.connect, 'FAIL003fnot offered to a task on this machine: host:connect:127.0.0.1:1');
    assert.deepEqual(adb.asked.filter((service) => !['host:version', 'host:devices'].includes(service)), []);
    assert.deepEqual([(await b.state()).devices, (await a.state()).devices], [{ state: 'ready', detail: '' }, { state: 'off', detail: '' }]);
    assert.match(agent.env.ADB_SERVER_SOCKET, /^tcp:127\.0\.0\.1:\d+$/);
    assert.notEqual(agent.env.ADB_SERVER_SOCKET, `tcp:127.0.0.1:${adb.port}`, 'a listener of the job\'s own, not the host\'s port');
    assert.match(agent.env.DN_FORWARD_ALLOC, /^127\.0\.0\.1:\d+$/);
    assert.deepEqual([agent.env.DN_FORWARDS, agent.env.DN_FORWARD_LAN], ['alloc adb', undefined]);
    assert.ok(adb.asked.includes('host:devices'));
    assert.match(agent.prompt, /forwarded from the host and already in your environment: alloc, adb\./);

    const name = containerOf(pk.a);
    const made = b.docker('network').find((call) => call[1] === 'create');
    assert.deepEqual(made.slice(0, 6), ['network', 'create', '--internal', '--ipv6=false', '-o', 'com.docker.network.bridge.gateway_mode_ipv4=isolated']);
    assert.deepEqual(made.slice(-3), ['--label', `dn.base=${b.base}`, name]);
    const [ran] = b.docker('run');
    const at = (flag) => ran[ran.indexOf(flag) + 1];
    assert.deepEqual([at('--name'), at('--network'), at('--security-opt')], [name, name, 'no-new-privileges']);
    assert.ok(ran.includes('--cap-drop=ALL') && ran.includes(`dn.base=${b.base}`) && ran.includes(`dn.peer=${pk.a}`) && ran.includes(`dn.pool=${POOL}`));
    for (const flag of ['--privileged', '-p', '--publish', '--network=host', '-e', '--env']) assert.ok(!ran.includes(flag), flag);
    assert.deepEqual(ran.filter((arg, i) => ran[i - 1] === '-v').map((v) => v.split(':')[1]), ['/work', '/dn/runs'], 'its volume and its own run records, nothing else of the host');
    assert.ok(b.docker().every((call) => !JSON.stringify(call).includes(b.token) && !JSON.stringify(call).includes('sk-ant')), 'no credential was ever on docker\'s command line');
  });

  let second;
  await check('a second task of the same requester runs in a container of the same name, made anew: one that may push, pushes one new branch as the requester and nothing else', async () => {
    const before = bench.forge.log.length;
    const main = bench.branch('main');
    const { taskId } = await a.ok('/offer', {
      pool: POOL, kind: 'issues', item: 'issue-2', title: 'Fix the issue',
      prompt: ['api POST /repos/acme/widgets/issues/2/comments {"body":"on it"}', 'push fix-issue-2', 'push main', 'say fixed the issue'].join('\n'),
    });
    const done = await ended(a, taskId);
    assert.equal(done.state, 'done', JSON.stringify(done));
    second = await runOf(b, taskId);
    const steps = b.agent(second.runId).steps;
    assert.deepEqual(went(steps), [['api', 201], ['push', 'pushed'], ['push', 'refused'], ['say', null]], JSON.stringify(steps));

    // The branch is on the forge, its commit authored as the requester's git says and
    // not as the executor's; main is where it was.
    assert.deepEqual(steps.map((s) => s.author).filter(Boolean), ['a Operator <a@example.com>', 'a Operator <a@example.com>']);
    assert.equal(bench.branch('fix-issue-2').author, 'a Operator <a@example.com>');
    assert.deepEqual(bench.branch('main'), main);
    const writes = bench.forge.log.slice(before).filter((r) => r.method !== 'GET' && !r.path.endsWith('git-upload-pack')).map((r) => [by(r), r.host, r.path]);
    assert.deepEqual(writes, [
      ['a', 'api.github.com', '/repos/acme/widgets/issues/2/comments'], ['a', 'github.com', '/acme/widgets.git/git-receive-pack'],
    ], 'exactly the writes the rules allow, each sent by the requester');

    assert.equal(second.container, first.container);
    assert.equal(b.docker('run').filter((c) => c.includes(containerOf(pk.a))).length, 2, 'made for each');
  });

  await check('another requester gets a container of its own, and two jobs at once each act through their own requester', async () => {
    // Said once: a word repeated after the first claim counts that claim's run twice
    // for ten seconds, and the second task would wait them out.
    await b.quiet();
    await b.ok('/admit', { slots: 2 });
    const before = bench.forge.log.length;
    const prompt = (who) => ['wait both', `api POST /repos/acme/widgets/pulls/1/reviews {"event":"COMMENT","body":"from ${who}"}`, 'adb', `say done for ${who}`].join('\n');
    const mine = await a.ok('/offer', { pool: POOL, kind: 'review', item: 'pr-1', title: 'Again', prompt: prompt('a') });
    const theirs = await c.ok('/offer', { pool: POOL, kind: 'review', item: 'pr-1', title: 'Mine', prompt: prompt('c') });
    assert.notEqual(mine.taskId, theirs.taskId, 'the same pull request as another account is another task');
    const runs = await until('both agents in B', async () => {
      const [x, y] = [await runOf(b, mine.taskId), await runOf(b, theirs.taskId)];
      return x && y && b.agent(x.runId)?.waiting && b.agent(y.runId)?.waiting ? [x, y] : null;
    });
    assert.deepEqual(runs.map((r) => [r.peer, r.container]), [[pk.a, containerOf(pk.a)], [pk.c, containerOf(pk.c)]]);
    assert.deepEqual(b.containers().filter((n) => !n.endsWith('-relay')), [containerOf(pk.a), containerOf(pk.c)].sort());

    b.release('both');
    assert.equal((await ended(a, mine.taskId)).outcome.summary, 'done for a');
    assert.equal((await ended(c, theirs.taskId)).outcome.summary, 'done for c');
    const posts = bench.forge.log.slice(before).filter((r) => r.method === 'POST' && r.host === 'api.github.com');
    assert.deepEqual(posts.map((r) => `${by(r)}: ${JSON.parse(r.body).body}`).sort(), ['a: from a', 'c: from c'], 'each request left with the credential of the machine that asked for the task');
    for (const run of runs) assert.equal(b.agent(run.runId).steps.find((s) => s.verb === 'adb').version, 'OKAY00040029', 'each job has the forward it was given');
    await b.admit(1);
  });

  await check('a GitLab pool: the project\'s number is asked of the forge once for every task, a review\'s note is posted as the requester, and what the rules leave out is refused', async () => {
    await Promise.all([a, b].map((m) => m.ok('/pools', { pools: [m.link, m.gitlabLink()] })));
    const { invite: toGitlab } = await a.ok('/invite', { pool: GITLAB_POOL });
    assert.deepEqual(await b.ok('/join', { invite: toGitlab }), { pool: GITLAB_POOL });
    const poolOn = async (m) => (await m.state()).pools.find((p) => p.id === GITLAB_POOL);
    await until('two members of the GitLab pool', async () => (await poolOn(a)).members.length === 2 && (await poolOn(b)).members.length === 2);

    const before = bench.forge.log.length;
    const project = '/api/v4/projects/acme%2Fwidgets';
    const first = await a.ok('/offer', {
      pool: GITLAB_POOL, kind: 'review', item: 'pr-1', title: 'Review the merge request',
      prompt: [
        `api GET ${project}/merge_requests/1`, `api POST ${project}/merge_requests/1/notes {"body":"from a"}`,
        `api POST ${project}/merge_requests/1/approve {}`, 'api DELETE /api/v4/projects/99', 'push sneaky', 'say reviewed the merge request',
      ].join('\n'),
    });
    assert.equal(first.taskId, `${GITLAB_POOL}#review:pr-1@a`);
    assert.equal((await ended(a, first.taskId)).outcome.summary, 'reviewed the merge request');
    const run = await runOf(b, first.taskId);
    const steps = b.agent(run.runId).steps;
    assert.deepEqual(went(steps), [['api', 200], ['api', 201], ['api', 403], ['api', 403], ['push', 'refused'], ['say', null]], JSON.stringify(steps));
    assert.equal(steps[0].body.author.username, 'someone', 'the forge\'s own answer came back');
    assert.deepEqual([steps[2].body, steps[3].body], [{ message: 'no rule of this task allows the request' }, { message: 'no rule of this task allows the request' }]);
    assert.deepEqual([b.agent(run.runId).env.GITLAB_HOST, b.agent(run.runId).env.GITLAB_TOKEN], [GITLAB_HOST, 'dn-placeholder']);
    assert.deepEqual([run.peer, run.container, run.pool], [pk.a, containerOf(pk.a, GITLAB_POOL), GITLAB_POOL], 'a container of that pool\'s own');

    // The same task again, spelling the project by its number, which only a requester
    // that learned the number allows.
    const second = await a.ok('/offer', {
      pool: GITLAB_POOL, kind: 'review', item: 'pr-1', title: 'Review it again',
      prompt: 'api POST /api/v4/projects/99/merge_requests/1/notes {"body":"again from a"}\nsay reviewed it again',
    });
    assert.equal((await ended(a, second.taskId)).outcome.summary, 'reviewed it again');
    const again = await until('the second run', async () => (await (await b.state()).runs.filter((r) => r.taskId === second.taskId)).at(-1));
    assert.notEqual(again.runId, run.runId);
    assert.deepEqual(went(b.agent(again.runId).steps), [['api', 201], ['say', null]]);

    const seen = bench.forge.log.slice(before).filter((r) => r.host === GITLAB_HOST && r.headers.authorization);
    const api = seen.filter((r) => r.path.startsWith('/api/'));
    assert.deepEqual(api.filter((r) => r.path === project).map((r) => [by(r), r.method]), [['a', 'GET']], 'asked once, by the requester, for both tasks');
    assert.deepEqual(api.filter((r) => r.method !== 'GET').map((r) => [by(r), r.method, r.path, JSON.parse(r.body).body]), [
      ['a', 'POST', `${project}/merge_requests/1/notes`, 'from a'], ['a', 'POST', '/api/v4/projects/99/merge_requests/1/notes', 'again from a'],
    ], 'the two notes, each sent with the requester\'s credential, and nothing the rules refused');
    assert.deepEqual([...new Set(seen.filter((r) => !r.path.startsWith('/api/')).map((r) => `${by(r)} ${r.path.replace('/acme/widgets.git/', '')}`))].sort(),
      ['b git-upload-pack', 'b info/refs?service=git-upload-pack'], 'the clone is the executor\'s mirror, fetched as the executor');
    assert.equal(bench.branch('sneaky'), null);
  });

  await check('a task offered with `now` is run by the machine that offered it, in a container, whatever it admits', async () => {
    const d = bench.machine('d');
    d.setConfig({ networkDevices: true });
    await d.start();
    await d.linked();
    await d.ok('/admit', { slots: 0 });
    const waits = await d.ok('/offer', { pool: POOL, kind: 'review', item: 'pr-1', title: 'Later', prompt: 'say never' });
    const { taskId } = await d.ok('/offer', { pool: POOL, kind: 'issues', item: 'issue-2', title: 'Now', prompt: 'api GET /repos/acme/widgets/issues/2\nsay ran here', now: true });
    const done = await ended(d, taskId);
    const self = (await d.state()).identity.pk;
    assert.deepEqual([done.state, done.outcome.summary], ['done', 'ran here']);
    const run = await runOf(d, taskId);
    assert.deepEqual([run.peer, run.container, run.state], [self, containerOf(self), 'finished']);
    assert.deepEqual(d.docker('run').map((call) => call[call.indexOf('--name') + 1]), [containerOf(self)], 'its own task still runs in a container');
    assert.equal(d.agent(run.runId).steps[0].status, 200);
    assert.equal(d.agent(run.runId).env.ADB_SERVER_SOCKET, undefined, 'no adb server answers on this machine, so none is forwarded');
    assert.deepEqual((await d.state()).devices, { state: 'none', detail: 'no adb server answers at 127.0.0.1:1' });
    assert.deepEqual([(await offerOf(d, waits.taskId)).state, await runOf(d, waits.taskId)], ['pooled', null], 'what it did not ask to run now waits for a slot');
    await d.kill();
  });

  await check('a machine gives its jobs nothing of its devices until its operator says so, and what the operator says holds for the jobs started after it', async () => {
    const own = await fakeAdb();
    const e = await bench.machine('e', { env: { DN_ADB_SERVER: `127.0.0.1:${own.port}`, DN_FORWARDS: JSON.stringify({ alloc: `127.0.0.1:${allocator.address().port}` }) } }).start();
    await e.linked();
    // The same two tasks are offered again and again here, and a task keeps its id: the
    // run of an offer is the one that was not there before it.
    const job = async (item, prompt) => {
      const before = new Set((await e.state()).runs.map((run) => run.runId));
      const { taskId } = await e.ok('/offer', { pool: POOL, kind: item === 'pr-1' ? 'review' : 'issues', item, title: item, prompt, now: true });
      const mine = (run) => run.taskId === taskId && !before.has(run.runId) && run.container !== '';
      return { taskId, run: await until(`the job of ${item}`, async () => (await e.state()).runs.find(mine) ?? null) };
    };
    const given = (run) => { const { env } = e.agent(run.runId); return [env.ADB_SERVER_SOCKET !== undefined, env.DN_FORWARD_ALLOC !== undefined]; };

    // An adb server answers and DN_FORWARDS names a forward, and neither is offered.
    assert.deepEqual((await e.state()).devices, { state: 'off', detail: '' });
    const off = await job('pr-1', 'adb\nsay nothing here');
    await ended(e, off.taskId);
    assert.deepEqual(given(off.run), [false, false]);
    assert.equal(e.agent(off.run.runId).steps[0].version, 'no ADB_SERVER_SOCKET');
    assert.match(e.agent(off.run.runId).prompt, /No simulator, emulator or device is offered to this task/);
    assert.deepEqual(own.asked, [], 'the adb server was not so much as asked whether it is there');

    e.setConfig({ networkDevices: true });
    await until('the devices offered', async () => (await e.state()).devices.state === 'ready');
    const on = await job('issue-2', 'wait held\nadb\nsay listed');
    await until('the job to wait', () => e.agent(on.run.runId)?.waiting === 'held');
    assert.deepEqual([...given(on.run), e.agent(on.run.runId).env.DN_FORWARDS], [true, true, 'alloc adb']);

    // Taken back while that job runs: it keeps what it was started with, the next has none.
    e.setConfig({ networkDevices: false });
    await until('the devices withdrawn', async () => (await e.state()).devices.state === 'off');
    const after = await job('pr-1', 'adb\nsay nothing again');
    await ended(e, after.taskId);
    assert.deepEqual(given(after.run), [false, false]);
    e.release('held');
    await ended(e, on.taskId);
    assert.equal(e.agent(on.run.runId).steps.find((s) => s.verb === 'adb').devices, 'OKAY0015emulator-5554\tdevice\n');

    // A job left going by the daemon before has what it was started with and no more,
    // whatever the setting says by then: the status of the broker's answer to a job's
    // token asking for its adb forward.
    const forward = (run) => new Promise((resolve) => {
      const { port, jobs } = JSON.parse(fs.readFileSync(path.join(e.base, 'jobs.json'), 'utf8'));
      const socket = net.connect(port, '127.0.0.1');
      let said = '';
      const answer = (status) => { socket.destroy(); resolve(status); };
      socket.on('connect', () => socket.write(`CONNECT adb.forward.dn:1 HTTP/1.1\r\nHost: adb.forward.dn:1\r\nProxy-Authorization: Basic ${Buffer.from(`dn:${jobs[run.runId].token}`).toString('base64')}\r\n\r\n`));
      socket.on('data', (chunk) => { said += chunk.toString('latin1'); if (said.includes('\r\n')) answer(Number(said.split(' ')[1])); });
      socket.on('error', () => answer(0));
      socket.on('close', () => answer(0));
    });
    const without = await job('pr-1', 'wait without\nsay without');
    await until('the job without devices to wait', () => e.agent(without.run.runId)?.waiting === 'without');
    e.setConfig({ networkDevices: true });
    await until('the devices offered again', async () => (await e.state()).devices.state === 'ready');
    const withAdb = await job('issue-2', 'wait with\nsay with');
    await until('the job with devices to wait', () => e.agent(withAdb.run.runId)?.waiting === 'with');
    assert.deepEqual([await forward(without.run), await forward(withAdb.run)], [404, 200]);
    assert.deepEqual(await e.stop(), { code: 0, signal: null });
    await e.start();
    await until('both taken up', () => [without, withAdb].every(({ run }) => e.log().includes(`${run.runId} taken up in ${run.container}`)));
    assert.deepEqual([await forward(without.run), await forward(withAdb.run)], [404, 200], 'the same after a restart');
    await e.kill();
    await own.close();
  });

  await check('a task on an Android project is taken by the machine that has a device to give while the ones with none hold back, and by one of those once it is alone', async () => {
    const bare = await fakeAdb({ devices: '' });
    const waits = { DN_DEVICE_WAIT_MS: '15000' };
    // Who asks; who gives jobs no device; who gives them an adb server with nothing attached; who has an emulator.
    const all = [bench.machine('w0'), bench.machine('w1', { env: waits }), bench.machine('w2', { env: { ...waits, DN_ADB_SERVER: `127.0.0.1:${bare.port}` } }),
      bench.machine('w3', { env: { ...waits, DN_ADB_SERVER: `127.0.0.1:${adb.port}` } })];
    const [asks, off, empty, has] = all;
    for (const m of all) fs.mkdirSync(path.join(m.checkout, 'android'));
    for (const m of [empty, has]) m.setConfig({ networkDevices: true });
    await Promise.all(all.map((m) => m.start()));
    await Promise.all(all.map((m) => m.linked()));
    const joined = await asks.ok('/invite', { pool: POOL });
    await Promise.all(all.slice(1).map((m) => m.ok('/join', { invite: joined.invite })));
    await until('four members everywhere', async () => (await Promise.all(all.map((m) => m.state()))).every((s) => s.pools[0].members.length === 4));
    await until('the adb servers found', async () => (await Promise.all([empty, has].map((m) => m.state()))).every((s) => s.devices.state === 'ready'));
    for (const m of [off, empty, has]) await m.admit(1);

    for (const item of ['issue-1', 'issue-2', 'issue-3', 'issue-4']) {
      const { taskId } = await asks.ok('/offer', { pool: POOL, kind: 'issues', item, title: 'Fix the crash on start', prompt: 'say fixed' });
      assert.equal((await ended(asks, taskId)).state, 'done');
      assert.deepEqual(await Promise.all([off, empty, has].map(async (m) => (await runOf(m, taskId))?.state ?? null)), [null, null, 'finished'], `${item} ran where the device is`);
      await until('the machine with the device free again', async () => (await has.state()).runs.every((r) => r.endedAt > 0));
    }
    // Nobody better placed: the task is taken after the wait, not refused.
    assert.deepEqual(await has.stop(), { code: 0, signal: null });
    const from = Date.now();
    const { taskId } = await asks.ok('/offer', { pool: POOL, kind: 'issues', item: 'issue-5', title: 'Fix the crash on start', prompt: 'say fixed' });
    assert.equal((await ended(asks, taskId)).state, 'done');
    assert.ok(Date.now() - from >= 15000, `taken ${Date.now() - from} ms after it was offered`);
    assert.equal((await Promise.all([off, empty].map((m) => runOf(m, taskId)))).filter((run) => run?.state === 'finished').length, 1);
    await Promise.all([asks, off, empty].map((m) => m.kill()));
    await bare.close();
  });

  console.log(`\nall ${passed()} checks passed (${REPO})`);
} finally {
  allocator.close();
  await adb.close();
  await bench.close();
}
process.exit(0);
