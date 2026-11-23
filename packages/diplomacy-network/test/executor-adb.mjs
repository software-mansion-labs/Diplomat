// The filter between a job and the host's adb server: what asks after devices or talks
// to one goes through, and everything by which the server would act on this machine -
// connect, forward, pair, kill, a device's reverse - is answered FAIL and never reaches
// the server. Against a stand-in server that keeps every request it is sent, and, where
// this machine has one, with the real adb client.
// Run: node test/executor-adb.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { adbDevices, adbRequest, createAdbFilter } from '../src/executor/adb.js';
import { fakeAdb } from './lib/daemons.mjs';

let checks = 0;
const check = async (name, fn) => { await fn(); checks++; console.log(`PASS ${name}`); };
const frame = (text) => `${text.length.toString(16).padStart(4, '0')}${text}`;
const KILL_WHY = ' (adb asks for this when its version is not the server\'s: this machine\'s adb server is not replaced, so use an adb of the server\'s version)';

const server = await fakeAdb();
const logged = [];
// The filter writes a refusal to the log once a minute: its clock is this one.
let clock = 0;
const filter = createAdbFilter({ target: { host: '127.0.0.1', port: server.port }, log: (...a) => logged.push(a.join(' ')), now: () => clock });
const at = await filter.start();

// Everything the filter says to a client that writes `chunks` one after another, until
// the filter closes the connection.
const talk = (chunks, port = at.port) => new Promise((resolve, reject) => {
  const socket = net.connect(port, '127.0.0.1');
  let said = '';
  socket.on('data', (c) => { said += c.toString('latin1'); });
  socket.on('error', reject);
  socket.on('end', () => { socket.destroy(); resolve(said); });
  socket.on('connect', async () => {
    for (const chunk of chunks) {
      socket.write(chunk);
      await new Promise((r) => setTimeout(r, 5));
    }
  });
});
const ask = (...services) => talk(services.map(frame));
// The same of a client that writes `second` only once it has been told `reply` to `first`.
const converse = (port, first, reply, second) => new Promise((resolve, reject) => {
  const socket = net.connect(port, '127.0.0.1');
  let said = '';
  let sent = false;
  const late = setTimeout(() => { socket.destroy(); reject(new Error(`the filter left the connection open, having said ${JSON.stringify(said)}`)); }, 20000);
  socket.on('data', (c) => {
    said += c.toString('latin1');
    if (said === reply && !sent) { sent = true; socket.write(second); }
  });
  socket.on('error', reject);
  socket.on('end', () => { clearTimeout(late); socket.destroy(); resolve(said); });
  socket.on('connect', () => socket.write(first));
});

const REFUSED = [
  'host:connect:127.0.0.1:1', 'host:disconnect:127.0.0.1:1', 'host:forward:tcp:0;tcp:1', 'host:forward:norebind:tcp:0;tcp:1',
  'host:killforward:tcp:1', 'host:killforward-all', 'host:list-forward', 'host:kill', 'host:pair:123456:127.0.0.1:1',
  'host:mdns:check', 'host:mdns:services', 'host:track-devices', 'host:track-devices-l', 'host:transport-any',
  'host:transport-usb', 'host:transport-local', 'host:transport-id:1', 'host:tport:any', 'host:tport:usb', 'host:tport:local',
  'host:emulator:5554', 'host:reconnect-offline', 'host:server-status', 'host-serial:emulator-5554:forward:tcp:0;tcp:1',
  'host-serial:emulator-5554:killforward-all', 'host-serial:emulator-5554:wait-for-any-device', 'host-usb:get-state',
  'host-local:forward:tcp:0;tcp:1', 'host:transport:', 'host:transport:a b', 'host:version ', 'HOST:version', 'shell:id', 'reverse:forward:tcp:1;tcp:2', '',
];

try {
  await check('what asks after devices is answered by the server, one request to a connection', async () => {
    assert.equal(await ask('host:version'), 'OKAY00040029');
    assert.equal(await ask('host:devices'), `OKAY${frame('emulator-5554\tdevice\n')}`);
    assert.match(await ask('host:devices-l'), /^OKAY[0-9a-f]{4}emulator-5554 +device product:sdk/);
    assert.equal(await ask('host:features'), `OKAY${frame('shell_v2,cmd')}`);
    assert.equal(await ask('host:host-features'), `OKAY${frame('shell_v2,cmd')}`);
    assert.equal(await ask('host-serial:emulator-5554:get-state'), `OKAY${frame('device')}`);
    // The server does not know these of its one device; they reached it all the same.
    for (const service of ['host-serial:emulator-5554:get-serialno', 'host-serial:emulator-5554:get-devpath', 'host-serial:emulator-5554:features', 'host-serial:192.168.1.5:5555:get-state', 'host-serial:[::1]:5555:get-state']) {
      assert.equal(await ask(service), `FAIL${frame('unknown host service')}`, service);
      assert.equal(server.asked.at(-1), service);
    }

    // A request that arrives a byte at a time is the same request.
    assert.equal(await talk([...frame('host:devices')]), `OKAY${frame('emulator-5554\tdevice\n')}`);
  });

  await check('a query is its connection\'s last request: what follows it is refused, in the same write or after the answer, even of a server that would go on listening', async () => {
    const before = server.asked.length;
    for (const service of ['host:kill', 'shell:id']) {
      assert.equal(await talk([`${frame('host:version')}${frame(service)}`]), `FAIL${frame(`not offered to a task on this machine: ${service}`)}`);
    }
    assert.deepEqual(server.asked.slice(before).filter((service) => service !== 'host:version'), []);

    // A server that answers a query and keeps the connection, as the real one does not.
    const heard = [];
    const lingering = net.createServer((socket) => {
      socket.on('error', () => {});
      socket.on('data', (chunk) => {
        heard.push(chunk.toString('latin1'));
        if (heard.length === 1 || heard.at(-1) === frame('host:version')) socket.write('OKAY00040029');
      });
    });
    await new Promise((resolve) => lingering.listen(0, '127.0.0.1', resolve));
    const kept = createAdbFilter({ target: { host: '127.0.0.1', port: lingering.address().port } });
    const { port } = await kept.start();
    for (const service of ['shell:id', 'host:kill', 'host:devices']) {
      assert.equal(await converse(port, frame('host:version'), 'OKAY00040029', frame(service)), `OKAY00040029FAIL${frame(`not offered to a task on this machine: ${service}`)}`, service);
    }
    assert.deepEqual(heard, Array(3).fill(frame('host:version')));
    await kept.stop();
    await new Promise((resolve) => lingering.close(resolve));
  });

  await check('a switch to one named device is followed by that device\'s own service, and by nothing that reaches back to this machine', async () => {
    assert.equal(await ask('host:transport:emulator-5554', 'shell:echo hi'), 'OKAYOKAYran shell:echo hi');
    assert.equal(await ask('host:tport:serial:emulator-5554', 'shell,v2,raw:ls'), 'OKAY\x01\0\0\0\0\0\0\0OKAYran shell,v2,raw:ls');
    assert.equal(await talk([`${frame('host:transport:192.168.1.5:5555')}${frame('sync:')}`]), 'OKAYOKAYran sync:');
    for (const service of ['exec:id', 'tcp:8080', 'jdwp:123']) assert.equal(await ask('host:transport:emulator-5554', service), `OKAYOKAYran ${service}`);
    // A service is bytes, and goes on as the bytes it came as with the length it came
    // with: one counted in characters and sent in another encoding would end short of
    // its end at the server, and what was left of it would be the device's to read.
    const bytes = 'shell:echo \xe9\xe8\xfc \xff';
    const said = await talk([Buffer.from(`${frame('host:transport:emulator-5554')}${frame(bytes)}`, 'latin1')]);
    assert.ok(said.startsWith('OKAYOKAYran shell:echo '), said);
    assert.equal(server.asked.at(-1), bytes);

    // The server reads the request behind a switch as it read the first: one of its own
    // would be carried out there, and a device's reverse leads back to this machine.
    const before = server.asked.length;
    const behind = ['reverse:forward:tcp:1;tcp:2', 'reverse:killforward-all', 'reverse:list-forward', 'reverse:', 'host:kill', 'host:connect:127.0.0.1:1',
      'host:forward:tcp:0;tcp:1', 'host:version', 'host-serial:emulator-5554:forward:tcp:0;tcp:1', 'host-usb:kill', 'host-local:kill', 'host-transport-id:1:kill'];
    for (const service of behind) {
      for (const said of [await ask('host:transport:emulator-5554', service), await talk([`${frame('host:tport:serial:emulator-5554')}${frame(service)}`])]) {
        assert.ok(said.includes(`FAIL${frame(`not offered to a task on this machine: ${service}`)}`), `${service}: ${said}`);
      }
    }
    assert.deepEqual([...new Set(server.asked.slice(before))], ['host:transport:emulator-5554'], 'the server heard a switch at most, and nothing behind one');
  });

  await check('every request by which the server would act on this machine is answered FAIL with the reason, the connection closed, and the server never hears it', async () => {
    const before = server.asked.length;
    for (const service of REFUSED) {
      clock += 60000;
      const said = await ask(service);
      const shown = service.slice(0, 60);
      assert.equal(said, `FAIL${frame(`not offered to a task on this machine: ${shown}${service === 'host:kill' ? KILL_WHY : ''}`)}`, service);
      assert.equal(adbRequest(service), null, service);
    }
    assert.equal(await talk(['zzzzhost:version']), `FAIL${frame('not offered to a task on this machine: a request that is not in adb\'s framing')}`);
    assert.equal(await talk([`${frame('host:kill')}${frame('host:version')}`]), `FAIL${frame(`not offered to a task on this machine: host:kill${KILL_WHY}`)}`);
    // What a job named is cut short and made printable before it is logged or said.
    clock += 60000;
    const long = await ask(`host:connect:${'x'.repeat(200)}\n\x1b[2J`);
    assert.equal(long, `FAIL${frame(`not offered to a task on this machine: host:connect:${'x'.repeat(47)}`)}`);
    assert.deepEqual(server.asked.slice(before), [], 'nothing reached the server');
    assert.ok(logged.some((line) => line.startsWith('adb refused a job: host:connect:127.0.0.1:1')));
    assert.match(logged.at(-1), /^adb refused a job: host:connect:x{47} /);
    clock += 60000;
    assert.equal(await ask('host:\x1b[2Jkill'), `FAIL${frame('not offered to a task on this machine: host:?[2Jkill')}`);
    assert.equal(logged.at(-1), 'adb refused a job: host:?[2Jkill');
    assert.ok(logged.every((line) => /^[\x20-\x7e]+$/.test(line)));
    // Refused over and over, a job is one line a minute, and the next says how many were left out.
    const lines = logged.length;
    for (let i = 0; i < 25; i++) await ask('host:kill');
    assert.equal(logged.length, lines);
    clock += 60000;
    await ask('host:kill');
    assert.deepEqual(logged.slice(lines), ['adb refused a job: host:kill (25 more of the kind were not written)']);
    assert.deepEqual(['host:devices', 'host:transport:emulator-5554', 'host:tport:serial:emulator-5554'].map(adbRequest), ['query', 'device', 'device']);
  });

  await check('an adb server is one that answers in adb\'s words, and its devices are the ones it lists as ready', async () => {
    const said = async (answer) => {
      const listener = net.createServer((socket) => socket.end(answer));
      await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
      const heard = await adbDevices({ host: '127.0.0.1', port: listener.address().port });
      listener.close();
      return heard;
    };
    const silent = net.createServer(() => {});
    await new Promise((resolve) => silent.listen(0, '127.0.0.1', resolve));
    assert.deepEqual(await Promise.all([
      adbDevices({ host: '127.0.0.1', port: server.port }), adbDevices(at), said('HTTP/1.1 400 Bad Request\r\n\r\n'), said('OKAYzzzz'), said('OKAY00'), said(`FAIL${frame('no')}`),
      adbDevices({ host: '127.0.0.1', port: 1 }), adbDevices(null), adbDevices({ host: '127.0.0.1', port: silent.address().port }),
    ]), [['emulator-5554'], ['emulator-5554'], null, null, null, null, null, null, null]);
    assert.deepEqual(await said(`OKAY${frame('')}`), [], 'a server with nothing attached');
    assert.deepEqual(await said(`OKAY${frame('R58M\tunauthorized\nemulator-5556\toffline\n[fe80::1]:5555\tdevice\nemulator-5554\tdevice\n')}`), ['[fe80::1]:5555', 'emulator-5554'], 'one that is not ready is no device to use');
    silent.close();
  });

  // The real client, pointed at the filter by address so that it never starts or replaces
  // a server of its own; behind the filter is the stand-in, so no device is touched.
  let client = null;
  try { client = Number(/version \d+\.\d+\.(\d+)/.exec(execFileSync('adb', ['version'], { encoding: 'utf8' }))[1]); } catch {}
  if (client === null) console.log('SKIP the real adb client: no adb on this machine');
  else {
    await check('the real adb client lists devices through the filter, and its connect and forward are refused before they reach a server', async () => {
      const same = await fakeAdb({ version: client });
      const own = createAdbFilter({ target: { host: '127.0.0.1', port: same.port } });
      const { port } = await own.start();
      const adb = (...args) => new Promise((resolve) => {
        execFile('adb', ['-H', '127.0.0.1', '-P', String(port), ...args], { encoding: 'utf8', timeout: 60000 }, (err, stdout, stderr) => resolve({ code: err ? err.code ?? 1 : 0, said: `${stdout}${stderr}` }));
      });
      const devices = await adb('devices');
      assert.deepEqual([devices.code, devices.said.includes('emulator-5554\tdevice')], [0, true], devices.said);
      const connect = await adb('connect', '127.0.0.1:1');
      assert.match(connect.said, /not offered to a task on this machine: host:connect:127\.0\.0\.1:1/);
      const forward = await adb('forward', 'tcp:0', 'tcp:1');
      assert.notEqual(forward.code, 0);
      assert.match(forward.said, /not offered to a task on this machine/);
      const shell = await adb('-s', 'emulator-5554', 'reverse', 'tcp:1', 'tcp:2');
      assert.notEqual(shell.code, 0);
      assert.deepEqual(same.asked.filter((service) => /connect|forward|reverse|kill/.test(service)), [], `the server heard only ${JSON.stringify(same.asked)}`);
      assert.ok(same.asked.includes('host:devices'));
      await own.stop();
      await same.close();
    });

    await check('the real adb client of another version than the server is told why the server is not stopped for it, and nothing is stopped or left running', async () => {
      const other = await fakeAdb({ version: client + 1 });
      const own = createAdbFilter({ target: { host: '127.0.0.1', port: other.port } });
      const { port } = await own.start();
      // The client then tries to start a server of its own at the same address, which the
      // filter holds, and writes its log where TMPDIR says.
      const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'dn-adb-'));
      const r = await new Promise((resolve) => {
        execFile('adb', ['-H', '127.0.0.1', '-P', String(port), 'devices'], { encoding: 'utf8', timeout: 120000, env: { ...process.env, TMPDIR: scratch } },
          (err, stdout, stderr) => resolve({ code: err ? err.code ?? 1 : 0, said: `${stdout}${stderr}` }));
      });
      assert.notEqual(r.code, 0, r.said);
      assert.ok(r.said.includes(`not offered to a task on this machine: host:kill${KILL_WHY}`), r.said);
      assert.deepEqual([...new Set(other.asked)], ['host:version'], 'the server was asked its version and nothing else');
      const check = net.connect({ host: '127.0.0.1', port });
      await new Promise((resolve, reject) => { check.on('connect', resolve); check.on('error', reject); });
      check.destroy();
      await own.stop();
      await other.close();
      fs.rmSync(scratch, { recursive: true, force: true });
    });
  }

  console.log(`\nall ${checks} checks passed`);
} finally {
  await filter.stop();
  await server.close();
}
process.exit(0);
