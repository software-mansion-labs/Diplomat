// A daemon launchd started has neither the SDK root nor the PATH the operator's shell
// rc files export: adb and the emulator are found through that shell, or every Android
// device is invisible. Run: node test/android-tools-from-login-shell.mjs

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'da-login-shell-'));
const SDK = path.join(BASE, 'sdk');
const HOME = path.join(BASE, 'home');
const PROBES = path.join(BASE, 'probes.log');
fs.mkdirSync(path.join(SDK, 'platform-tools'), { recursive: true });
fs.mkdirSync(path.join(SDK, 'emulator'), { recursive: true });
fs.mkdirSync(HOME);

const script = (file, body) => { fs.writeFileSync(file, `#!/bin/sh\n${body}`, { mode: 0o755 }); return file; };
const ADB = script(path.join(SDK, 'platform-tools', 'adb'), `case "$*" in
  devices) printf 'List of devices attached\\nemulator-5554\\tdevice\\n' ;;
  '-s emulator-5554 emu avd name') printf 'Pixel_7_API_34\\nOK\\n' ;;
esac
`);
const EMULATOR = script(path.join(SDK, 'emulator', 'emulator'), '[ "$1" = -list-avds ] && echo Pixel_7_API_34\n');

// The operator's shell: its rc runs for -l and -i alone, prints, and sets `rc`.
const shell = (name, rc) => script(path.join(BASE, name), `case "$1" in -l|-i)
  echo "$0 $1" >> '${PROBES}'; echo 'Welcome back!'; ${rc}; shift ;;
esac
exec /bin/sh "$@"
`);

// listAndroid() and the binaries it settled on, in a process with launchd's environment.
function launchd(extra) {
  fs.rmSync(PROBES, { force: true });
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', `
    const dev = await import(${JSON.stringify(path.join(SRC, 'devices.js'))});
    const p = await import(${JSON.stringify(path.join(SRC, 'paths.js'))});
    const started = Date.now();
    const devices = (await dev.listAndroid()).map(({ avd, serial, state }) => ({ avd, serial, state }));
    await dev.listAndroid();
    process.stdout.write(JSON.stringify({ devices, adb: p.ADB_BIN, emulator: p.EMULATOR_BIN, ms: Date.now() - started }));
  `], {
    env: { HOME, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', DA_BASE_DIR: path.join(BASE, 'state'), ...extra },
    encoding: 'utf8',
  });
  const probes = fs.existsSync(PROBES) ? fs.readFileSync(PROBES, 'utf8').trim().split('\n') : [];
  return { ...JSON.parse(out), probes };
}

const BOOTED = [{ avd: 'Pixel_7_API_34', serial: 'emulator-5554', state: 'booted' }];

try {
  const byHome = launchd({ SHELL: shell('rc-home', `export ANDROID_HOME='${SDK}'`) });
  assert.deepEqual(byHome.devices, BOOTED, 'the AVD under the ANDROID_HOME the rc exports is listed');
  assert.equal(byHome.adb, ADB);
  assert.equal(byHome.emulator, EMULATOR);
  assert.equal(byHome.probes.length, 2, `one login shell running one interactive shell, once: ${byHome.probes}`);
  console.log('ok   ANDROID_HOME from the login shell');

  const byRoot = launchd({ SHELL: shell('rc-root', `export ANDROID_SDK_ROOT='${SDK}'`) });
  assert.deepEqual(byRoot.devices, BOOTED, 'the AVD under the ANDROID_SDK_ROOT the rc exports is listed');
  console.log('ok   ANDROID_SDK_ROOT from the login shell');

  const byPath = launchd({ SHELL: shell('rc-path', `PATH="$PATH:${SDK}/platform-tools:${SDK}/emulator"`) });
  assert.deepEqual(byPath.devices, BOOTED, 'the SDK binaries on the PATH the rc sets are listed');
  assert.equal(byPath.adb, ADB);
  console.log('ok   PATH from the login shell');

  const onOwnPath = launchd({
    SHELL: shell('rc-unused', 'true'),
    PATH: `/usr/bin:/bin:${SDK}/platform-tools:${SDK}/emulator`,
  });
  assert.deepEqual(onOwnPath.devices, BOOTED);
  assert.equal(onOwnPath.adb, 'adb', 'a bare name its own PATH holds stays bare');
  assert.deepEqual(onOwnPath.probes, [], 'no shell is asked when the daemon\'s PATH has both');
  console.log('ok   own PATH: no shell probe');

  // A hung rc: the probe gives up, and its whole group goes with it.
  const PID = path.join(BASE, 'hung.pid');
  const hung = launchd({
    SHELL: shell('rc-hung', `[ "$1" = -i ] && { echo $$ > '${PID}'; sleep 600; }`),
    DA_LOGIN_SHELL_TIMEOUT_MS: '500',
  });
  assert.deepEqual(hung.devices, [], 'nothing found, nothing listed');
  assert.equal(hung.adb, 'adb');
  assert.ok(hung.ms < 5000, `listAndroid waited ${hung.ms}ms on a 500ms probe`);
  const pid = Number(fs.readFileSync(PID, 'utf8'));
  let alive = true;
  for (let i = 0; i < 40 && alive; i++) {
    try { process.kill(pid, 0); execFileSync('/bin/sleep', ['0.05']); } catch { alive = false; }
  }
  assert.equal(alive, false, `the hung interactive shell (pid ${pid}) outlived the probe`);
  console.log('ok   hung rc: probe times out, shell group killed');
} finally {
  fs.rmSync(BASE, { recursive: true, force: true });
}
