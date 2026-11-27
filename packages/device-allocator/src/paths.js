// Central filesystem layout + tool locations for the device allocator.
//
// Everything the daemon owns lives under one base dir so it is trivial to
// inspect and to clean up. The base dir defaults to ~/.diplomat/device-allocator
// but can be redirected with DA_BASE_DIR (used by the test harness so it never
// touches the real allocation state).

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const BASE_DIR =
  process.env.DA_BASE_DIR || path.join(os.homedir(), '.diplomat', 'device-allocator');

export const SOCKET_PATH = path.join(BASE_DIR, 'daemon.sock');
export const DISCOVERY_PATH = path.join(BASE_DIR, 'daemon.json'); // {pid, identity, startedAt, socket}
export const STATE_PATH = path.join(BASE_DIR, 'state.json'); // public snapshot the applet reads
export const LEASES_PATH = path.join(BASE_DIR, 'leases.json'); // full allocation records, for restart rehydration
export const REMOTE_RELEASES_PATH = path.join(BASE_DIR, 'remote-releases.json'); // leases given back but not confirmed
export const LOG_PATH = path.join(BASE_DIR, 'daemon.log');
export const REPAIRS_DIR = path.join(BASE_DIR, 'repairs');

// Diplomat's cross-process settings (appconfig.py / AppConfig.swift), relocated by
// the same DIPLOMAT_CONFIG they honour.
export const CONFIG_PATH = process.env.DIPLOMAT_CONFIG
  ? process.env.DIPLOMAT_CONFIG.replace(/^~(?=$|\/)/, os.homedir())
  : path.join(os.homedir(), '.diplomat', 'config.json');

// Prompt-injection ban list + captured evidence. Lives under the pr-monitor dir
// (a sibling of device-allocator) because the applet's PR-review monitor reads it
// to skip banned authors. Overridable with DA_BAN_DIR for tests.
export const BAN_DIR =
  process.env.DA_BAN_DIR || path.join(os.homedir(), '.diplomat', 'pr-monitor');
export const BANNED_PATH = path.join(BAN_DIR, 'banned.json'); // the applet reads this
export const INJECTIONS_DIR = path.join(BAN_DIR, 'injections'); // per-incident evidence
export const AUDIT_PATH = path.join(BAN_DIR, 'audit.jsonl'); // shared action log the applet shows

// Android SDK lives outside PATH on this machine, so resolve binaries by absolute
// path from the SDK root. adb too: the daemon may be launched from launchd or the
// applet, whose PATH lacks Homebrew/SDK dirs — a bare 'adb' would silently make
// every Android device invisible (run() maps ENOENT to {ok:false} -> empty list).
//
// The SDK default location is OS-specific: macOS puts it under ~/Library, Linux
// (the Android Studio default) under ~/Android/Sdk. Defaulting to the macOS path
// on Linux points EMULATOR_BIN at a nonexistent file, so `emulator -list-avds`
// fails and every Android device is invisible — the daemon then reports
// needs-create for emulators that are booted and adb-visible.
const DEFAULT_ANDROID_HOME =
  process.platform === 'darwin'
    ? path.join(os.homedir(), 'Library', 'Android', 'sdk')
    : path.join(os.homedir(), 'Android', 'Sdk');
export const ANDROID_HOME =
  process.env.ANDROID_HOME ||
  process.env.ANDROID_SDK_ROOT ||
  DEFAULT_ANDROID_HOME;
const SDK_EMULATOR = path.join(ANDROID_HOME, 'emulator', 'emulator');
// If the SDK isn't at the resolved root, a bare name: one on PATH still works, and
// locateAndroidTools() asks the operator's shell for one that isn't.
export let EMULATOR_BIN =
  process.env.EMULATOR_PATH || (fs.existsSync(SDK_EMULATOR) ? SDK_EMULATOR : 'emulator');
const SDK_ADB = path.join(ANDROID_HOME, 'platform-tools', 'adb');
export let ADB_BIN = process.env.ADB_PATH || (fs.existsSync(SDK_ADB) ? SDK_ADB : 'adb');

const onPath = (name, dirs = '') => dirs.split(path.delimiter).filter(Boolean)
  .map((d) => path.join(d, name)).find((p) => fs.existsSync(p));

// A bare name no PATH entry holds is looked up where the operator's terminal would
// find it: the SDK under the ANDROID_HOME / ANDROID_SDK_ROOT their shell's rc files
// export, else on that shell's PATH. A daemon launchd started inherits neither. Once
// per process; run before either binary.
let located;
export function locateAndroidTools() {
  located ??= (async () => {
    const missing = (bin, name) => bin === name && !onPath(name, process.env.PATH);
    if (!missing(ADB_BIN, 'adb') && !missing(EMULATOR_BIN, 'emulator')) return;
    const env = await loginShellEnv(['ANDROID_HOME', 'ANDROID_SDK_ROOT', 'PATH']);
    if (!env) return;
    const root = env.ANDROID_HOME || env.ANDROID_SDK_ROOT;
    const find = (dir, name) => {
      const sdk = root && path.join(root, dir, name);
      return sdk && fs.existsSync(sdk) ? sdk : onPath(name, env.PATH);
    };
    if (missing(ADB_BIN, 'adb')) ADB_BIN = find('platform-tools', 'adb') || ADB_BIN;
    if (missing(EMULATOR_BIN, 'emulator')) EMULATOR_BIN = find('emulator', 'emulator') || EMULATOR_BIN;
  })();
  return located;
}

const ENV_MARK = 'diplomat-env:';
const shq = (s) => `'${s.replace(/'/g, `'\\''`)}'`;

// `names` as a login shell running an interactive one sets them (LoginShell.swift's
// pair), or null when it gives no answer within LOGIN_SHELL_TIMEOUT_MS.
function loginShellEnv(names) {
  const shell = process.env.SHELL || '/bin/sh';
  const probe = `printf '\\n${ENV_MARK}%s\\n' ${names.map((n) => `"$${n}"`).join(' ')}`;
  return new Promise((resolve) => {
    let out = '';
    const child = spawn(shell, ['-l', '-c', `${shq(shell)} -i -c ${shq(probe)}`],
      { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
    // The whole group: a hung rc leaves the inner shell running.
    const timer = setTimeout(() => {
      try { process.kill(-child.pid, 'SIGKILL'); } catch {}
      resolve(null);
    }, LOGIN_SHELL_TIMEOUT_MS);
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', () => resolve(null));
    child.on('close', () => {
      clearTimeout(timer);
      const said = out.split('\n').filter((l) => l.startsWith(ENV_MARK)).slice(-names.length);
      resolve(said.length === names.length
        ? Object.fromEntries(names.map((n, i) => [n, said[i].slice(ENV_MARK.length)]))
        : null);
    });
  });
}

// Tunables (overridable for tests). The idle limits are Diplomat settings
// (deviceIdleLeasedMinutes / deviceIdleFreeMinutes in CONFIG_PATH, read each sweep);
// these are their defaults. The sweep runs every minute so reclamation lands close to
// the limit.
export const LEASED_IDLE_DEFAULT_MIN = 30;
export const FREE_IDLE_DEFAULT_MIN = 5;
export const REAP_INTERVAL_MS = Number(process.env.DA_REAP_INTERVAL_MS) || 10 * 1000;
export const IDLE_INTERVAL_MS = Number(process.env.DA_IDLE_INTERVAL_MS) || 60 * 1000;
export const POOL_INTERVAL_MS = Number(process.env.DA_POOL_INTERVAL_MS) || 8 * 1000;
export const ALLOC_GRACE_MS = Number(process.env.DA_ALLOC_GRACE_MS) || 20 * 1000;
// How long locateAndroidTools() waits on the operator's shell: rc files can be slow.
const LOGIN_SHELL_TIMEOUT_MS = Number(process.env.DA_LOGIN_SHELL_TIMEOUT_MS) || 10 * 1000;

// Max concurrent devices held across all agents. The device *pool* is unbounded
// (agents create devices on demand), so this caps concurrency, not inventory.
export const QUOTA = Number(process.env.DA_QUOTA) || 5;
export const AWAIT_TIMEOUT_MS = Number(process.env.DA_AWAIT_TIMEOUT_MS) || 15 * 60 * 1000;

// How long a quarantined ('repairing') device may sit before the reaper returns it
// to the pool anyway. The repair agent is told to notify /repaired when done, but
// it can die or forget — without a TTL a broken report shrinks the pool forever.
export const REPAIR_TTL_MS = Number(process.env.DA_REPAIR_TTL_MS) || 2 * 60 * 60 * 1000;

// How long a device the daemon just shut down is kept out of selection while it may
// still enumerate as booted: `emu kill` and `simctl shutdown` return before it is gone.
export const STOPPING_GRACE_MS = Number(process.env.DA_STOPPING_GRACE_MS) || 60 * 1000;

// The longest a request waits on the remote device pool (src/remote.js) before falling
// back to a local device. It covers a provider's browser sign-in, so it is generous.
export const REMOTE_ACQUIRE_BUDGET_MS = Number(process.env.DA_REMOTE_ACQUIRE_BUDGET_MS) || 11 * 60 * 1000;
// How often a remote lease whose release failed is tried again.
export const REMOTE_RELEASE_RETRY_MS = Number(process.env.DA_REMOTE_RELEASE_RETRY_MS) || 60 * 1000;
// The longest attaching a leased device may take before it is given back.
export const REMOTE_ATTACH_BUDGET_MS = Number(process.env.DA_REMOTE_ATTACH_BUDGET_MS) || 3 * 60 * 1000;
// How often the remote pool's free devices are listed for the snapshot.
export const REMOTE_POOL_INTERVAL_MS = Number(process.env.DA_REMOTE_POOL_INTERVAL_MS) || 30 * 1000;
