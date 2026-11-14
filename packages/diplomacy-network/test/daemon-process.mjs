// The daemon as a process: one per state directory, a socket that answers before the
// transport is up, the installer the applets drive it with, Diplomat's config followed
// while it runs, every route's refusals, and the snapshot as the applets decode it.
// Real daemon processes on scratch directories; loop transport, stand-in tor, docker
// and forge.
// Run: node test/daemon-process.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pidAlive } from '../../daemon-core/src/fsio.js';
import { DAEMON, POOL, check, createBench, passed, until } from './lib/daemons.mjs';
import { git } from './lib/fake-forge.mjs';

const bench = await createBench();
const offerBody = (item, more = {}) => ({ pool: POOL, kind: 'review', item, title: `Review ${item}`, prompt: 'say reviewed', ...more });
const SENTENCE = /^[A-Z"].*\.$/;

try {
  await check('a second daemon on the same state directory exits cleanly, naming the first, and changes nothing', async () => {
    const a = await bench.machine('one').start();
    const discovery = fs.readFileSync(path.join(a.base, 'daemon.json'), 'utf8');
    const second = spawn(process.execPath, [DAEMON], { env: a.env, stdio: 'ignore' });
    const exit = await new Promise((resolve) => { second.on('exit', (code, signal) => resolve({ code, signal })); });
    assert.deepEqual(exit, { code: 0, signal: null });
    assert.match(a.log(), new RegExp(`another daemon \\(pid ${a.pid}\\) is already live; exiting`));
    assert.equal(fs.readFileSync(path.join(a.base, 'daemon.json'), 'utf8'), discovery);
    assert.deepEqual((await a.call('GET', '/health')).body, { ok: true, pid: a.pid });
    assert.equal(fs.statSync(a.socket).mode & 0o777, 0o600);
    assert.deepEqual(await a.stop(), { code: 0, signal: null });
    assert.equal(fs.existsSync(a.socket) || fs.existsSync(path.join(a.base, 'daemon.json')), false, 'a stopped daemon leaves no socket and no daemon.json');
  });

  await check('a daemon killed outright leaves its socket behind: the next one takes the socket over and comes up once', async () => {
    const a = await bench.machine('stale').start();
    const first = a.pid;
    await a.kill();
    assert.equal(fs.existsSync(a.socket), true);
    await a.start();
    await until('its transport', async () => (await a.state()).transport.state === 'ready');
    await until('its broker', () => (a.log().match(/broker listening/g) ?? []).length >= 2);
    assert.notEqual(a.pid, first);
    const count = (what) => a.log().split(what).length - 1;
    assert.deepEqual([count(`daemon listening ${a.socket} pid ${a.pid}`), count('transport: ready'), count('broker listening')], [1, 2, 2], 'one node, one transport and one broker for each of the two daemons');
    await a.kill();
  });

  await check('the socket answers, and every route works, while the transport is still coming up', async () => {
    const a = await bench.machine('slow', { transport: 'tor', env: { FAKE_TOR_STAGE: 'stall:50' } }).start();
    await until('tor stalls', async () => (await a.state()).transport.state === 'bootstrapping');
    await a.linked();
    const { invite } = await a.ok('/invite', { pool: POOL });
    assert.match(invite, /^[A-Za-z0-9_-]{100,}$/);
    const { taskId } = await a.ok('/offer', offerBody('pr-1'));
    const state = await a.state();
    assert.equal(state.transport.state, 'bootstrapping');
    assert.deepEqual(state.offers.map((o) => [o.taskId, o.state]), [[taskId, 'pooled']]);
    assert.deepEqual(state.pools[0].members.map((m) => [m.self, m.reachable]), [[true, false]], 'and says of itself that nobody can reach it yet');
    await a.kill();
  });

  await check('the installer checks, starts, restarts and stops the daemon, one JSON object each, and a stop leaves no tor behind', async () => {
    // A tor that outlives its owner unless it is told to go: only the daemon's own stop ends it.
    const a = bench.machine('inst', { transport: 'tor', env: { FAKE_TOR_STAGE: 'ignore-owning-pid,ignore-takeownership' } });
    assert.deepEqual(await a.install('--check'), { installed: true, daemonRunning: false, pid: null });
    assert.deepEqual(await a.install('--stop-daemon'), { ok: true, daemonRunning: false, pid: null }, 'stopping nothing is no error');

    const started = await a.install('--start-daemon');
    assert.deepEqual(Object.keys(started), ['ok', 'daemonRunning', 'pid']);
    assert.deepEqual([started.ok, started.daemonRunning, Number.isInteger(started.pid) && pidAlive(started.pid)], [true, true, true]);
    assert.deepEqual(await a.install('--check'), { installed: true, daemonRunning: true, pid: started.pid });
    assert.deepEqual(await a.install('--start-daemon'), started, 'a second start is the same daemon');

    const torPid = () => Number(fs.readFileSync(path.join(a.base, 'tor', 'tor.pid'), 'utf8'));
    await until('its transport', async () => (await a.state()).transport.state === 'ready');
    const firstTor = torPid();
    const restarted = await a.install('--restart-daemon');
    assert.deepEqual([restarted.ok, restarted.daemonRunning], [true, true]);
    assert.notEqual(restarted.pid, started.pid);
    assert.equal(pidAlive(started.pid), false);
    assert.equal(pidAlive(firstTor), false, 'the replaced daemon took its tor with it');

    await until('its transport again', async () => (await a.state()).transport.state === 'ready');
    const secondTor = torPid();
    assert.equal(pidAlive(secondTor), true);
    assert.deepEqual(await a.install('--stop-daemon'), { ok: true, daemonRunning: false, pid: null });
    assert.equal(pidAlive(restarted.pid), false, 'the daemon is gone when the installer says so');
    assert.equal(pidAlive(secondTor), false, 'and so is its tor');
    assert.deepEqual(await a.install('--check'), { installed: true, daemonRunning: false, pid: null });
    assert.match(a.log(), /ending: SIGTERM[\s\S]*ended/);
  });

  await check('a config read that fails once switches nothing off; one that keeps failing does', async () => {
    const a = await bench.machine('torn', { env: { DN_CONFIG_UNREADABLE_POLLS: '6' } }).start();
    await a.linked();
    const good = fs.readFileSync(a.configPath, 'utf8');
    // Half a file, as a reader finds it in the middle of a rewrite.
    fs.writeFileSync(a.configPath, good.slice(0, 20));
    await until('a failed read', () => /config\.json could not be read \(1 of 6\)/.test(a.log()));
    fs.writeFileSync(a.configPath, good);
    // Still there, and still following the file: a later change arrives.
    a.setConfig({ networkRequiredMinimumH: 30 });
    let n = 0;
    await until('the changed hours', async () => {
      const { taskId } = await a.ok('/offer', offerBody(`pr-${n += 1}`));
      return (await a.state()).pools[0].tasks.find((t) => t.taskId === taskId).hours === 30;
    });
    assert.equal(a.exited, false);
    assert.doesNotMatch(a.log(), /ending/);

    fs.rmSync(a.configPath);
    assert.deepEqual(await a.exit, { code: 0, signal: null });
    assert.match(a.log(), /ending: .*config\.json could not be read 6 times in a row: the network counts as switched off/);
    const left = JSON.parse(fs.readFileSync(path.join(a.base, 'state.json'), 'utf8'));
    assert.ok(left.offers.length >= 1 && left.offers.every((o) => o.state === 'cancelled' && o.reason === 'the network was switched off'), 'what it offered is cancelled, on disk for the applets');
  });

  await check('the hours an offer asks for follow the config without a restart, held to the range the network allows', async () => {
    const a = await bench.machine('hours').start();
    await a.linked();
    let n = 0;
    const hoursOfNext = async () => {
      const { taskId } = await a.ok('/offer', offerBody(`pr-${n += 1}`));
      return (await a.state()).pools[0].tasks.find((t) => t.taskId === taskId).hours;
    };
    assert.equal(await hoursOfNext(), 12);
    for (const [set, want] of [[48, 48], [100000, 720], [1, 12], ['many', 12]]) {
      a.setConfig({ networkRequiredMinimumH: set });
      await until(`${want} hours for ${set}`, async () => (await hoursOfNext()) === want);
    }
    a.setConfig({ networkMaximumAcceptedH: 72 });
    await until('what this machine accepts', async () => (await a.state()).pools[0].members[0].maxAcceptedH === 72);
    await a.kill();
  });

  await check('every route refuses a body that is not what it reads with a 4xx and a sentence, and the daemon goes on', async () => {
    const a = await bench.machine('strict').start();
    await a.linked();
    const long = 'x'.repeat(5000);
    const cases = [
      ['/pools', [], 400, /^The request body must be a JSON object\.$/],
      ['/pools', {}, 400, /^"pools" must be a list of at most 1000 pools\.$/],
      ['/pools', { pools: 'all' }, 400, /^"pools" must be a list/],
      ['/pools', { pools: [null] }, 400, /^Every pool must be a JSON object\.$/],
      ['/pools', { pools: [{ id: POOL, path: '/x', forge: 'gitea', identity: 'me' }] }, 400, /^"forge" must be "github" or "gitlab"\.$/],
      ['/pools', { pools: [{ id: POOL, path: 7, forge: 'github', identity: 'me' }] }, 400, /^"path" must be text of 1 to 4096 characters\.$/],
      ['/pools', { pools: [a.link, a.link] }, 400, /^A pool is listed twice\.$/],
      ['/pools', { pools: [{ ...a.link, id: 'not a pool' }] }, 409, /^"not a pool" is not a pool id\.$/],
      ['/admit', { slots: '2' }, 400, /^"slots" must be a whole number from 0 to 1000\.$/],
      ['/admit', { slots: -1 }, 400, /^"slots" must be/],
      ['/admit', { slots: 1.5 }, 400, /^"slots" must be/],
      ['/admit', { slots: 1, reason: 5 }, 400, /^"reason" must be text of at most 200 characters\.$/],
      ['/offer', {}, 400, /^"pool" must be text of 1 to 300 characters\.$/],
      ['/offer', offerBody('pr-1', { prompt: undefined }), 400, /^"prompt" must be text/],
      ['/offer', offerBody('pr-1', { now: 'yes' }), 400, /^"now" must be true or false\.$/],
      ['/offer', offerBody('pr-1', { options: [] }), 400, /^"options" must be an object\.$/],
      ['/offer', offerBody('pr-1', { item: long }), 400, /^"item" must be text of 1 to 200 characters\.$/],
      ['/offer', offerBody('pr-1', { pool: 'github.com/acme/other' }), 409, /^The pool github\.com\/acme\/other is not linked on this machine\.$/],
      ['/offer', offerBody('pr-1', { kind: 'deploy' }), 409, /^No rules exist for a "deploy" task on github, so it cannot be offered\.$/],
      ['/offer', offerBody('PR 1'), 409, /is not a task this network can name\.$/],
      ['/withdraw', {}, 400, /^"taskId" must be text of 1 to 600 characters\.$/],
      ['/withdraw', { taskId: 'x', reason: 7 }, 400, /^"reason" must be text/],
      ['/invite', { pool: 5 }, 400, /^"pool" must be text/],
      ['/invite', { pool: POOL, ttlSecs: 5 }, 400, /^"ttlSecs" must be a whole number from 60 to \d+\.$/],
      ['/invite', { pool: 'github.com/acme/other' }, 409, /is not linked on this machine\.$/],
      ['/join', {}, 400, /^Give either "invite", to join a pool by it, or "pool", to go back into one this machine left\.$/],
      ['/join', { invite: 'abc', pool: POOL }, 400, /^Give either/],
      ['/join', { invite: 7 }, 400, /^"invite" must be text/],
      ['/join', { invite: 'nonsense' }, 409, /^That is not an invite: paste the whole token the other machine made\.$/],
      ['/join', { pool: 'github.com/acme/other' }, 409, /is not linked on this machine\.$/],
      ['/leave', {}, 400, /^"pool" must be text/],
      ['/leave', { pool: 'github.com/acme/other' }, 409, /is not linked on this machine\.$/],
      ['/stop-run', { runId: 12 }, 400, /^"runId" must be text of 1 to 64 characters\.$/],
      ['/stop-run', { runId: 'run-none' }, 409, /^No such run is going on this machine\.$/],
    ];
    for (const [route, body, status, sentence] of cases) {
      const answer = await a.call('POST', route, body);
      assert.deepEqual([route, answer.status, Object.keys(answer.body ?? {})], [route, status, ['error']], JSON.stringify([body, answer.body]));
      assert.match(answer.body.error, sentence, route);
      assert.match(answer.body.error, SENTENCE, route);
    }
    for (const route of ['/pools', '/admit', '/offer', '/withdraw', '/invite', '/join', '/leave', '/stop-run']) {
      for (const raw of ['{"pool":', '"text"', '7', 'null', '[1]']) {
        const answer = await a.call('POST', route, undefined, { raw });
        assert.equal(answer.status, 400, `${route} ${raw}`);
        assert.equal(typeof answer.body.error, 'string');
      }
    }
    assert.equal((await a.call('POST', '/nothing', {})).status, 404);
    assert.equal((await a.call('GET', '/offer')).status, 404);
    // A job's commits are made in the name the offering checkout's git gives: without
    // one there is nothing to offer.
    git(a.checkout, 'config', 'user.name', '');
    const nameless = await a.call('POST', '/offer', offerBody('pr-1'));
    git(a.checkout, 'config', '--unset', 'user.name');
    assert.deepEqual([nameless.status, nameless.body], [409, { error: `The checkout at ${a.checkout} has no git user.name and user.email, and a task's commits are made in that name.` }]);
    // Members a route does not read are ignored.
    assert.deepEqual(await a.ok('/admit', { slots: 0, colour: 'green', pools: [7] }), { ok: true });
    assert.deepEqual((await a.state()).offers, [], 'nothing refused left a trace');
    assert.deepEqual((await a.call('GET', '/health')).body, { ok: true, pid: a.pid });
    assert.doesNotMatch(a.log(), /failed:/, 'a refusal is no fault, and is not logged as one');

    // A fault of the daemon's own is a 500 with the reason, a line in the log, and no crash.
    fs.chmodSync(path.join(a.base, 'pools'), 0o500);
    const fault = await a.call('POST', '/invite', { pool: POOL });
    fs.chmodSync(path.join(a.base, 'pools'), 0o700);
    assert.equal(fault.status, 500);
    assert.match(fault.body.error, /EACCES/);
    assert.match(a.log(), /POST \/invite failed: Error: EACCES/);
    assert.equal(typeof (await a.ok('/invite', { pool: POOL })).invite, 'string');
    await a.kill();
  });

  await check('withdrawing is safe to repeat, joining needs the invite\'s repository linked, and an offer is answered from this machine alone', async () => {
    const a = await bench.machine('wa').start();
    const b = await bench.machine('wb').start();
    await a.linked();
    const { invite } = await a.ok('/invite', { pool: POOL });

    // B has not linked the repository the invite is for.
    const early = await b.call('POST', '/join', { invite });
    assert.deepEqual([early.status, early.body], [409, { error: `The pool ${POOL} is not linked on this machine.` }]);
    await b.linked();
    assert.deepEqual(await b.ok('/join', { invite }), { pool: POOL });
    await until('two members', async () => (await a.state()).pools[0].members.length === 2 && (await b.state()).pools[0].members.length === 2);

    // Every request between machines now takes ten minutes: an offer that waited for B
    // to hear of it would not come back.
    fs.writeFileSync(path.join(bench.loopDir, 'delay'), '600000');
    const { taskId } = await a.ok('/offer', offerBody('pr-1'));
    assert.equal(taskId, `${POOL}#review:pr-1@wa`);
    assert.deepEqual((await a.state()).offers.map((o) => [o.taskId, o.state]), [[taskId, 'pooled']]);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(a.base, 'offers.json'), 'utf8'))[taskId].state, 'pooled', 'signed and on this machine\'s disk');
    assert.equal((await b.state()).pools[0].tasks.length, 0, 'B has not heard of it');
    assert.deepEqual(await a.ok('/offer', offerBody('pr-1')), { taskId }, 'offered again, it is the same offer');

    assert.deepEqual(await a.ok('/withdraw', { taskId, reason: 'merged' }), { ok: true, ended: true });
    assert.deepEqual((await a.state()).offers.map((o) => [o.state, o.reason]), [['cancelled', 'merged']]);
    for (const again of [{ taskId, reason: 'merged' }, { taskId }, { taskId: `${POOL}#review:pr-99@wa`, reason: 'forgotten' }, { taskId: 'never a task' }]) {
      assert.deepEqual(await a.ok('/withdraw', again), { ok: true, ended: true });
    }
    assert.deepEqual((await a.state()).offers.map((o) => [o.state, o.reason]), [['cancelled', 'merged']], 'and nothing more was changed by it');
    await Promise.all([a.kill(), b.kill()]);
    fs.rmSync(path.join(bench.loopDir, 'delay'));
  });

  await check('the snapshot carries every field the applets decode, each of the type they decode it as, and state.json follows it', async () => {
    const a = await bench.machine('snap').start();
    await a.linked();
    await a.ok('/admit', { slots: 0, reason: 'busy' });
    const now = await a.ok('/offer', offerBody('pr-1', { now: true }));
    const later = await a.ok('/offer', offerBody('pr-2'));
    const state = await until('the first task done', async () => {
      const s = await a.state();
      return s.offers.find((o) => o.taskId === now.taskId).state === 'done' && s.runs[0].endedAt > 0 ? s : null;
    });

    const type = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'int' : typeof v);
    const shaped = (value, spec, where) => {
      assert.deepEqual(Object.keys(value).sort(), Object.keys(spec).sort(), `${where}: its members`);
      for (const [key, want] of Object.entries(spec)) {
        if (typeof want === 'string') assert.ok(want.split('|').includes(type(value[key])), `${where}.${key} is ${type(value[key])}, not ${want}`);
        else if (Array.isArray(want)) {
          assert.equal(type(value[key]), 'array', `${where}.${key}`);
          if (typeof want[0] !== 'string') assert.ok(value[key].length > 0, `${where}.${key} has a row to check`);
          value[key].forEach((row, i) => (typeof want[0] === 'string' ? assert.equal(type(row), want[0]) : shaped(row, want[0], `${where}.${key}[${i}]`)));
        } else shaped(value[key], want, `${where}.${key}`);
      }
    };
    const said = { state: 'string', detail: 'string' };
    const outcome = { ok: 'boolean', summary: 'string', usd: 'number|int', tokens: 'int', runner: 'string', model: 'string' };
    const offer = {
      taskId: 'string', pool: 'string', kind: 'string', item: 'string', title: 'string', state: 'string', reason: 'string',
      executor: 'string', executorHere: 'boolean', offeredAt: 'int', attempt: 'int', requests: 'int', refused: 'int', endedAt: 'int',
    };
    shaped({ ...state, offers: [] }, {
      updatedAt: 'int', daemon: { pid: 'int', startedAt: 'int' }, identity: { pk: 'string', onion: 'string' },
      transport: said, docker: { state: 'string', image: 'string', detail: 'string' }, model: said,
      admit: { slots: 'int', at: 'int', reason: 'string' },
      pools: [{
        id: 'string', path: 'string', identity: 'string', hash: 'string', left: 'boolean',
        members: [{ pk: 'string', self: 'boolean', maxAcceptedH: 'int', lastSeen: 'int', reachable: 'boolean' }],
        tasks: [{
          taskId: 'string', kind: 'string', item: 'string', title: 'string', identity: 'string', hours: 'int', state: 'string',
          offeredBy: ['string'], offeredHere: 'boolean', executor: 'string', executorHere: 'boolean', claimedAt: 'int',
          leaseUntil: 'int', deadline: 'int',
        }],
      }],
      runs: [{
        runId: 'string', taskId: 'string', pool: 'string', peer: 'string', container: 'string', state: 'string', startedAt: 'int',
        endedAt: 'int', exit: 'int', log: 'string',
      }],
      offers: 'array',
    }, 'snapshot');
    const [done, open] = [state.offers.find((o) => o.taskId === now.taskId), state.offers.find((o) => o.taskId === later.taskId)];
    shaped(done, { ...offer, outcome }, 'a finished offer');
    shaped(open, { ...offer, outcome: 'null' }, 'an open offer');

    const secs = Math.floor(Date.now() / 1000);
    assert.deepEqual([state.daemon.pid, state.daemon.startedAt <= secs && state.daemon.startedAt > secs - 3600], [a.pid, true], 'startedAt is Unix seconds');
    assert.match(state.identity.onion, /^[a-z2-7]{56}\.onion$/);
    assert.deepEqual([state.transport.state, state.docker.state, state.model], ['ready', 'ready', { state: 'ready', detail: 'ANTHROPIC_API_KEY' }]);
    assert.match(state.docker.image, /^dn-test-agent:[0-9a-f]{12}$/);
    assert.deepEqual(state.admit, { slots: 0, at: state.admit.at, reason: 'busy' });
    assert.deepEqual([state.pools[0].id, state.pools[0].path, state.pools[0].identity, state.pools[0].left], [POOL, a.checkout, 'snap', false]);
    assert.deepEqual(state.pools[0].tasks.find((t) => t.taskId === later.taskId).offeredBy, [state.identity.pk]);
    assert.deepEqual([done.outcome, done.executorHere, state.runs[0].state, state.runs[0].exit], [
      { ok: true, summary: 'reviewed', usd: 0.42, tokens: 120, runner: 'claude', model: '' }, false, 'finished', 0,
    ]);
    assert.equal(fs.existsSync(state.runs[0].log), true, 'a run\'s log is a file on this machine');

    const file = path.join(a.base, 'state.json');
    const onDisk = await until('state.json to follow', () => {
      try {
        const s = JSON.parse(fs.readFileSync(file, 'utf8'));
        return s.offers.some((o) => o.state === 'done') && s.runs[0]?.endedAt > 0 ? s : null;
      } catch { return null; }
    });
    assert.deepEqual(Object.keys(onDisk), Object.keys(state));
    assert.deepEqual([onDisk.daemon, onDisk.identity, onDisk.runs, onDisk.docker], [state.daemon, state.identity, state.runs, state.docker]);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(fs.readdirSync(a.base).filter((f) => f.includes('.tmp')), [], 'and is replaced whole, never written in place');
    await a.kill();
  });

  console.log(`\nall ${passed()} checks passed`);
} finally {
  await bench.close();
}
process.exit(0);
