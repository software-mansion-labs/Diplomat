// A daemon launchd started has neither the SDK root nor the PATH the operator's shell
// rc files export: adb and the emulator are found through that shell.
// Run: node test/android-tools-from-login-shell.mjs

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { onInterrupt } from './lib/interrupt.mjs';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'da-login-shell-'));
const SDK = path.join(BASE, 'sdk');
const HOME = path.join(BASE, 'home');
const PROBES = path.join(BASE, 'probes.log');
const CALLS = path.join(BASE, 'adb.log');
const PID = path.join(BASE, 'hung.pid');
// What the rc's leave running sits in the probe's own process group, out of reach of a
// signal to this test's; each names BASE on its command line.
const cleanup = () => {
  try { execFileSync('pkill', ['-f', BASE]); } catch {}
  fs.rmSync(BASE, { recursive: true, force: true });
};
onInterrupt(cleanup);
// launchd's PATH, minus any adb the host has installed.
const BIN = path.join(BASE, 'bin');
fs.mkdirSync(BIN);
for (const tool of ['sleep', 'printenv']) {
  fs.symlinkSync(execFileSync('/bin/sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).trim(), path.join(BIN, tool));
}
fs.mkdirSync(path.join(SDK, 'platform-tools'), { recursive: true });
fs.mkdirSync(path.join(SDK, 'emulator'), { recursive: true });
fs.mkdirSync(HOME);

const script = (file, body) => { fs.writeFileSync(file, `#!/bin/sh\n${body}`, { mode: 0o755 }); return file; };
const ADB = script(path.join(SDK, 'platform-tools', 'adb'), `echo "$*" >> '${CALLS}'
case "$*" in
  devices) printf 'List of devices attached\\nemulator-5554\\tdevice\\n' ;;
  '-s emulator-5554 emu avd name') printf 'Pixel_7_API_34\\nOK\\n' ;;
  '-s emulator-5554 shell getprop sys.boot_completed') echo 1 ;;
esac
`);
const EMULATOR = script(path.join(SDK, 'emulator', 'emulator'), '[ "$1" = -list-avds ] && echo Pixel_7_API_34\n');

// The operator's shell: its rc runs for -l and -i alone, prints without a newline, and
// runs `rc`.
const shell = (name, rc) => script(path.join(BASE, name), `case "$1" in -l|-i)
  echo "$0 $1" >> '${PROBES}'; printf 'Welcome back!'
  ${rc}
  shift ;;
esac
exec /bin/sh "$@"
`);
const HOME_RC = `export ANDROID_HOME='${SDK}'`;

const LIST = 'return { devices: (await dev.listAndroid()).map(({ avd, serial, state }) => ({ avd, serial, state })) };';

// `body`'s result and the binaries it left, from a process with launchd's environment.
function launchd(extra, body = LIST, { fdLimit } = {}) {
  fs.rmSync(PROBES, { force: true });
  fs.rmSync(CALLS, { force: true });
  const started = Date.now();
  const node = [process.execPath, '--input-type=module', '-e', `
    const fs = await import('node:fs');
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const pidIn = async (f) => {
      for (;;) {
        const pid = fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim() : '';
        if (pid) return pid;
        await sleep(20);
      }
    };
    const dev = await import(${JSON.stringify(path.join(SRC, 'devices.js'))});
    const p = await import(${JSON.stringify(path.join(SRC, 'paths.js'))});
    const t0 = Date.now();
    const r = await (async () => { ${body} })();
    process.stdout.write(JSON.stringify({ ...r, adb: p.ADB_BIN, emulator: p.EMULATOR_BIN, ms: Date.now() - t0 }));
  `];
  const [file, args] = fdLimit
    ? ['/bin/sh', ['-c', `ulimit -n ${fdLimit} && exec "$@"`, 'sh', ...node]]
    : [node[0], node.slice(1)];
  const out = execFileSync(file, args, {
    env: { HOME, PATH: BIN, DA_BASE_DIR: path.join(BASE, 'state'), ...extra },
    encoding: 'utf8', timeout: 20000,
  });
  const lines = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n') : []);
  return { ...JSON.parse(out || '{}'), probes: lines(PROBES), calls: lines(CALLS), wallMs: Date.now() - started };
}

const gone = (pid) => {
  for (let i = 0; i < 40; i++) {
    try { process.kill(pid, 0); } catch { return true; }
    execFileSync('/bin/sleep', ['0.05']);
  }
  return false;
};

const BOOTED = [{ avd: 'Pixel_7_API_34', serial: 'emulator-5554', state: 'booted' }];

try {
  const home = shell('rc-home', HOME_RC);
  const byHome = launchd({ SHELL: home });
  assert.deepEqual(byHome.devices, BOOTED, 'the AVD under the ANDROID_HOME the rc exports is listed');
  assert.equal(byHome.adb, ADB);
  assert.equal(byHome.emulator, EMULATOR);
  assert.deepEqual(byHome.probes, [`${home} -l`, `${home} -i`], 'a login shell running an interactive one');
  console.log('ok   ANDROID_HOME from the login shell');

  const byRoot = launchd({ SHELL: shell('rc-root', `export ANDROID_SDK_ROOT='${SDK}'`) });
  assert.deepEqual(byRoot.devices, BOOTED, 'the AVD under the ANDROID_SDK_ROOT the rc exports is listed');
  const both = launchd({ SHELL: shell('rc-both', `${HOME_RC}; export ANDROID_SDK_ROOT='${BASE}/no-sdk'`) });
  assert.equal(both.adb, ADB, 'ANDROID_HOME wins over ANDROID_SDK_ROOT');
  console.log('ok   ANDROID_SDK_ROOT from the login shell, after ANDROID_HOME');

  // A stale ANDROID_HOME, and the SDK root on PATH too: its emulator/ directory is no binary.
  const byPath = launchd({
    SHELL: shell('rc-path', `export ANDROID_HOME='${BASE}/no-sdk'; PATH="$PATH:${SDK}:${SDK}/platform-tools:${SDK}/emulator"`),
  });
  assert.deepEqual(byPath.devices, BOOTED, 'the SDK binaries on the PATH the rc sets are listed');
  assert.equal(byPath.adb, ADB);
  assert.equal(byPath.emulator, EMULATOR);
  console.log('ok   PATH from the login shell');

  const onOwnPath = launchd({ SHELL: shell('rc-unused', HOME_RC), PATH: `${BIN}:${SDK}/platform-tools:${SDK}/emulator` });
  assert.deepEqual(onOwnPath.devices, BOOTED);
  assert.equal(onOwnPath.adb, 'adb', 'a bare name its own PATH holds stays bare');
  assert.deepEqual(onOwnPath.probes, [], 'no shell is asked when the daemon\'s PATH has both');
  const adbOnOwnPath = launchd({ SHELL: shell('rc-mixed', HOME_RC), PATH: `${BIN}:${SDK}/platform-tools` });
  assert.deepEqual(adbOnOwnPath.devices, BOOTED);
  assert.deepEqual([adbOnOwnPath.adb, adbOnOwnPath.emulator], ['adb', EMULATOR], 'only the missing one is looked up');
  console.log('ok   own PATH first');

  // An rc that reads stdin, and a job it leaves running on the probe's stdout, neither
  // delay the answer nor keep the process alive.
  const job = launchd({
    SHELL: shell('rc-job', `${HOME_RC}; read answer; [ "$1" = -i ] && '${BIN}/sleep' 8 &`),
    DA_LOGIN_SHELL_TIMEOUT_MS: '5000',
  });
  assert.deepEqual(job.devices, BOOTED);
  assert.ok(job.wallMs < 4000, `took ${job.wallMs}ms beside an 8s rc job`);
  console.log('ok   rc reading stdin, rc job holding stdout');

  const sameAnswer = launchd({ SHELL: shell('rc-no-sdk', 'true'), DA_LOGIN_SHELL_RETRY_MS: '1' },
    'for (let i = 0; i < 3; i++) await dev.listAndroid(); return {};');
  assert.equal(sameAnswer.probes.length, 2, `a shell that answered is asked once: ${sameAnswer.probes}`);
  console.log('ok   an answered probe is kept');

  const quits = shell('rc-quits', 'exit 0');
  const unanswered = launchd({ SHELL: quits },
    "for (let i = 0; i < 3; i++) await dev.listAndroid(); return { exitListeners: process.listenerCount('exit') };");
  assert.deepEqual(unanswered.probes, [`${quits} -l`], 'a shell that did not answer is not asked again at once');
  assert.ok(unanswered.wallMs < 5000, `took ${unanswered.wallMs}ms on a shell that quit`);
  assert.equal(unanswered.exitListeners, 0);
  console.log('ok   an unanswered probe waits before it is asked again');

  // A hung rc: the probe gives up and its whole group goes with it. The retry hangs too,
  // without holding up its caller, and the one after it answers.
  const HANG = path.join(BASE, 'hang');
  const hungShell = shell('rc-hung', `${HOME_RC}; [ "$1" = -i ] && [ -f '${HANG}' ] && { '${BIN}/sleep' 600 & echo $! > '${PID}'; wait; }`);
  fs.writeFileSync(HANG, '');
  const hung = launchd({ SHELL: hungShell, DA_LOGIN_SHELL_TIMEOUT_MS: '3000', DA_LOGIN_SHELL_RETRY_MS: '1' },
    `const pidFile = ${JSON.stringify(PID)};
    const first = (await dev.listAndroid()).length;
    const pids = [await pidIn(pidFile)];
    fs.rmSync(pidFile);
    await sleep(5);
    const t = Date.now();
    await dev.listAndroid();
    const retryMs = Date.now() - t;
    pids.push(await pidIn(pidFile));
    fs.rmSync(${JSON.stringify(HANG)});
    let then = 0;
    for (let i = 0; i < 300 && !then; i++) { await sleep(50); then = (await dev.listAndroid()).length; }
    return { first, retryMs, then, pids };`);
  assert.deepEqual([hung.first, hung.then], [0, 1], 'nothing on the hung probe; the AVD once asked again');
  assert.ok(hung.retryMs < 1000, `a retry held its caller for ${hung.retryMs}ms`);
  assert.equal(hung.probes.length, 6, `one probe, then one retry at a time: ${hung.probes}`);
  assert.ok(hung.ms >= 6000 && hung.wallMs < 15000, `listed after ${hung.ms}ms on two hung 3s probes, one at a time`);
  for (const pid of hung.pids) assert.ok(gone(Number(pid)), 'a hung rc outlived its probe');
  fs.writeFileSync(HANG, '');
  fs.rmSync(PID);
  const exited = launchd({ SHELL: hungShell },
    `dev.listAndroid();
    await pidIn(${JSON.stringify(PID)});
    process.exit(0);`);
  assert.ok(exited.wallMs < 5000);
  assert.ok(gone(Number(fs.readFileSync(PID, 'utf8'))), 'the hung rc outlived the process that started it');
  console.log('ok   hung rc: probe times out, shell group killed, asked again');

  for (const SHELL of [path.join(BASE, 'no-such-shell'), path.join(ADB, 'sh')]) {
    assert.deepEqual(launchd({ SHELL }).devices, [], `SHELL=${SHELL}`);
  }
  const noFds = launchd({ SHELL: home }, `const fds = [];
    try { for (;;) fds.push(fs.openSync('/dev/null', 'r')); } catch {}
    const devices = await dev.listAndroid();
    for (const fd of fds) fs.closeSync(fd);
    return { devices };`, { fdLimit: 64 });
  assert.deepEqual(noFds.devices, [], 'out of descriptors: nothing listed, nothing thrown');
  console.log('ok   a shell that cannot start');

  // Each other way in looks the tools up before its first adb call.
  for (const [name, body, call] of [
    ['bootAndroid', "return { r: await dev.bootAndroid('Pixel_7_API_34') };", '-s emulator-5554 shell getprop sys.boot_completed'],
    ['shutdownAndroid', "await dev.shutdownAndroid('emulator-5554'); return {};", '-s emulator-5554 emu kill'],
    ['motionHash', "await dev.motionHash({ platform: 'android', key: 'android:x', serial: 'emulator-5554' }); return {};", '-s emulator-5554 exec-out screencap'],
  ]) {
    const r = launchd({ SHELL: home }, body);
    assert.ok(r.calls.includes(call), `${name} ran ${JSON.stringify(r.calls)}`);
  }
  const PROVIDER = path.join(BASE, 'provider.mjs');
  fs.writeFileSync(PROVIDER, `export default (ctx) => { process.env.PROVIDER_ADB = ctx.adb; return {}; };`);
  const remote = launchd({ SHELL: home, DA_REMOTE_PROVIDER: PROVIDER },
    `const remote = await import(${JSON.stringify(path.join(SRC, 'remote.js'))});
    await remote.load();
    return { providerAdb: process.env.PROVIDER_ADB };`);
  assert.equal(remote.providerAdb, ADB, 'a remote provider is handed the located adb');
  console.log('ok   boot, shutdown, motion and the remote provider');
} finally {
  cleanup();
}
