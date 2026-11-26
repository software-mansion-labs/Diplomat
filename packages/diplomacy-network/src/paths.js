import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = (p) => p.replace(/^~(?=$|\/)/, os.homedir());
const num = (name, fallback) => {
  const said = process.env[name] ?? '';
  const n = said.trim() === '' ? NaN : Number(said);
  return n >= 0 && Number.isFinite(n) ? n : fallback;
};

/// Settings of 0 that `bound` and `amount` ignored, as `NAME=value`; the daemon logs them at start.
export const NOT_BOUNDS = [];
// Node's timers and docker read 0 as no bound, so 0 keeps the default.
const bound = (name, fallback) => {
  const n = num(name, fallback);
  if (n === 0) NOT_BOUNDS.push(`${name}=${process.env[name]}`);
  return n || fallback;
};
// A docker amount, with or without a unit ("8g", "1.5"), passed on as written.
const amount = (name, fallback) => {
  const said = (process.env[name] ?? '').trim();
  const n = Number.parseFloat(said);
  if (n === 0) NOT_BOUNDS.push(`${name}=${process.env[name]}`);
  return n > 0 ? said : fallback;
};
/// Test-only settings in effect, as sorted `NAME=value`; the daemon logs them at start and
/// lists them in its snapshot.
export const TEST_KNOBS = [];
// A protocol figure pool members assume of one another: any non-default value is a test's.
const agreed = (name, fallback) => {
  const n = num(name, fallback);
  if (n !== fallback) TEST_KNOBS.push(`${name}=${process.env[name]}`);
  return n;
};

export const BASE_DIR = process.env.DN_BASE_DIR
  ? home(process.env.DN_BASE_DIR)
  : path.join(os.homedir(), '.diplomat', 'network');

export const SOCKET_PATH = path.join(BASE_DIR, 'daemon.sock');
export const DISCOVERY_PATH = path.join(BASE_DIR, 'daemon.json'); // {pid, identity, startedAt, socket}
export const STATE_PATH = path.join(BASE_DIR, 'state.json'); // for a person to read; the applets ask the socket
export const LOG_PATH = path.join(BASE_DIR, 'daemon.log');
export const IDENTITY_PATH = path.join(BASE_DIR, 'identity.json');
export const KEYS_PATH = path.join(BASE_DIR, 'keys.json');
export const POOLS_DIR = path.join(BASE_DIR, 'pools');
export const TOR_DIR = path.join(BASE_DIR, 'tor');
export const CA_DIR = path.join(BASE_DIR, 'ca');
export const MIRRORS_DIR = path.join(BASE_DIR, 'mirrors');
export const RUNS_DIR = path.join(BASE_DIR, 'runs');

// Diplomat's shared settings, the same file the applets read (networkEnabled,
// networkRequiredMinimumH, networkMaximumAcceptedH).
export const CONFIG_PATH = process.env.DIPLOMAT_CONFIG
  ? home(process.env.DIPLOMAT_CONFIG)
  : path.join(os.homedir(), '.diplomat', 'config.json');
export const CONFIG_POLL_MS = num('DN_CONFIG_POLL_MS', 1000);

// An app started by launchd or a desktop session gets only the system's directories on PATH.
const INSTALL_DIRS = [
  '/opt/homebrew/bin', '/usr/local/bin', '~/.local/bin', '~/bin', '~/.docker/bin', '/Applications/Docker.app/Contents/Resources/bin',
  '~/.nix-profile/bin', '/nix/var/nix/profiles/default/bin', '/run/current-system/sw/bin', '/home/linuxbrew/.linuxbrew/bin',
  '/opt/local/bin', '/snap/bin',
];
/// Also given to everything the daemon starts, so gh finds git and docker its credential
/// helper. node's own directory is for tools run under `env node`.
export const TOOL_PATH = [...new Set([
  ...(process.env.PATH || '').split(':'),
  ...(process.env.DN_TOOL_DIRS ? process.env.DN_TOOL_DIRS.split(':') : INSTALL_DIRS).map(home),
  path.dirname(process.execPath),
].filter(Boolean))].join(':');

export function locate(tool, searchPath = TOOL_PATH) {
  const runs = (file) => {
    try {
      fs.accessSync(file, fs.constants.X_OK);
      return fs.statSync(file).isFile();
    } catch { return false; }
  };
  return (tool.includes('/') ? [tool] : searchPath.split(':').map((dir) => path.join(dir, tool))).find(runs) ?? null;
}

export const TOR_BIN = process.env.DN_TOR || 'tor';
export const DOCKER_BIN = process.env.DN_DOCKER || 'docker';
export const GIT_BIN = process.env.DN_GIT || 'git';
export const GH_BIN = process.env.DN_GH || 'gh';
export const GLAB_BIN = process.env.DN_GLAB || 'glab';
export const OPENSSL_BIN = process.env.DN_OPENSSL || 'openssl';
// "tor", or "loop": loopback TCP through a directory of addresses, for tests.
export const TRANSPORT = process.env.DN_TRANSPORT || 'tor';
export const LOOP_DIR = process.env.DN_LOOP_DIR || path.join(BASE_DIR, 'loop');

// Protocol constants (PROTOCOL.md). Their env overrides are for tests only. This marker
// and "Acting as the requester" bound the section test/paths-bounds.mjs scans.
export const POW = {
  memberBase: agreed('DN_POW_MEMBER_BASE', 16384),
  memberAllow: agreed('DN_POW_MEMBER_ALLOW', 30),
  memberCap: 12,
  strangerBase: agreed('DN_POW_STRANGER_BASE', 262144),
  strangerAllow: agreed('DN_POW_STRANGER_ALLOW', 4),
  strangerCap: 8,
  windowSecs: 60,
  epochSecs: 3600,
};
// Proof of work a host does for its peers per hour, in expected hashes: per peer, for all
// together, and a floor for a peer known `floorAfter` seconds whatever the others took. A
// peer with no member record in a pool the host is in gets no floor, and all requests to
// such peers (the search of PROTOCOL.md section 5 among them) share `search`.
export const POW_HOURLY = {
  peer: POW.memberBase * 2 ** 14, all: POW.memberBase * 2 ** 16, floor: POW.memberBase * 2 ** 8, floorAfter: 3600, search: POW.memberBase * 2 ** 13,
};
export const CLOCK_SKEW_SECS = 300;
// A sender that is not a member of the request's pool gets STRANGER_BODY_BYTES.
export const MAX_BODY_BYTES = 2 ** 20;
export const MAX_ACT_BODY_BYTES = 48 * 2 ** 20;
export const STRANGER_BODY_BYTES = 64 * 2 ** 10;
export const HOURS_FLOOR = 12;
export const HOURS_CEILING = 720;
export const LEASE_SECS = agreed('DN_LEASE_SECS', 7200);
export const LEASE_GRACE_SECS = agreed('DN_LEASE_GRACE_SECS', 600);
export const PING_LEAD_SECS = agreed('DN_PING_LEAD_SECS', 600);
export const GRANT_TTL_SECS = agreed('DN_GRANT_TTL_SECS', 120);
// Life of every offer and claim version, and of a member's standing, from signing. Must
// stay far longer than a lease and its grace.
export const RECORD_RETENTION_SECS = agreed('DN_RECORD_RETENTION_SECS', 24 * 3600);
// A host away for less comes back with a re-signed record and needs no invite.
export const MEMBER_RETENTION_SECS = agreed('DN_MEMBER_RETENTION_SECS', 30 * 24 * 3600);
export const RESIGN_INTERVAL_MS = agreed('DN_RESIGN_INTERVAL_MS', (RECORD_RETENTION_SECS * 1000) / 4);
// Also the longest a redeeming host holds an invite good for, from when it is pasted.
export const INVITE_TTL_SECS = 24 * 3600;
export const OFFER_ATTEMPTS = 3;

// Includes the circuit and the proof of work.
export const REQUEST_TIMEOUT_MS = agreed('DN_REQUEST_TIMEOUT_MS', 60 * 1000);
export const ROUND_TIMEOUT_MS = agreed('DN_ROUND_TIMEOUT_MS', 3 * 60 * 1000);
export const SYNC_INTERVAL_MS = agreed('DN_SYNC_INTERVAL_MS', 60 * 1000);
// The longest claim delay, scaled by the host's rank on the task.
export const RANK_DELAY_MS = agreed('DN_RANK_DELAY_MS', 5000);
// A claim round asks every member afresh. One that answered within PEER_QUIET_MS gets a
// whole REQUEST_TIMEOUT_MS. One never reached and known for less than that is asked again
// until ROUND_PATIENCE_MS: a first onion circuit can take minutes. Any other gets
// PROBE_TIMEOUT_MS, so a sleeping machine costs a round seconds, also after a restart
// (silence is kept on disk).
export const PROBE_TIMEOUT_MS = agreed('DN_PROBE_TIMEOUT_MS', 15 * 1000);
export const PEER_QUIET_MS = agreed('DN_PEER_QUIET_MS', 3 * SYNC_INTERVAL_MS);
export const ROUND_PATIENCE_MS = agreed('DN_ROUND_PATIENCE_MS', ROUND_TIMEOUT_MS / 2);
// Waits before re-pushing an own offer to a member that has not said it holds it.
export const PUSH_REPEAT_MS = [2000, 5000, 15000];
// Gossip backoff for a peer after an unanswered request, doubling per failure to the max.
export const PEER_BACKOFF_MS = agreed('DN_PEER_BACKOFF_MS', 5000);
export const PEER_BACKOFF_MAX_MS = agreed('DN_PEER_BACKOFF_MAX_MS', 10 * 60 * 1000);
// Includes the forge call and the requester's push check; a body gets ACT_BYTES_PER_SEC on top.
export const ACT_TIMEOUT_MS = agreed('DN_ACT_TIMEOUT_MS', 5 * 60 * 1000);
export const ACT_BYTES_PER_SEC = 32 * 2 ** 10;
// Resend interval for an unanswered ping, key request or outcome report, and how long a
// task whose round stood down is left alone.
export const RETRY_MS = agreed('DN_RETRY_MS', 30 * 1000);
// How long an offer of a running task is left to that run, which asks for it itself every RETRY_MS.
export const JOIN_WAIT_MS = agreed('DN_JOIN_WAIT_MS', 2 * RETRY_MS);
// How long a task this host failed at or gave back is left to the others, doubling each
// time under the same offer, to the max.
export const GIVE_UP_WAIT_MS = agreed('DN_GIVE_UP_WAIT_MS', 2 * 60 * 1000);
export const GIVE_UP_WAIT_MAX_MS = agreed('DN_GIVE_UP_WAIT_MAX_MS', 60 * 60 * 1000);
// Before a member whose claim let go of an offer early is granted it again. Under
// GIVE_UP_WAIT_MS, so a host that goes for a task again by itself is not turned away.
export const RETAKE_WAIT_MS = agreed('DN_RETAKE_WAIT_MS', 60 * 1000);
// Before a member whose claim lapsed without having had the key and held it a whole lease
// is granted the offer again, doubling each time under the same offer, to the max.
export const KEYLESS_WAIT_MS = agreed('DN_KEYLESS_WAIT_MS', 2 * 3600 * 1000);
export const KEYLESS_WAIT_MAX_MS = agreed('DN_KEYLESS_WAIT_MAX_MS', 24 * 3600 * 1000);
export const POW_WORKERS = agreed('DN_POW_WORKERS', 2);
// How often to ask former members whether they are still in the pool, so two parts cut
// off for longer than MEMBER_RETENTION_SECS become one again.
export const SEARCH_INTERVAL_MS = agreed('DN_SEARCH_INTERVAL_MS', 24 * 3600 * 1000);
// Former members asked per pool, the latest to go kept.
export const MAX_FORMER = 1024;
export const TICK_MS = agreed('DN_TICK_MS', 10 * 1000);
// A clock jump this large between ticks means the machine slept.
export const WAKE_GAP_MS = agreed('DN_WAKE_GAP_MS', 6 * TICK_MS);
// After a start or wake, how long a host keeps asking a pool what it missed while no
// member answers, before going on with what it holds.
export const CATCH_UP_MS = agreed('DN_CATCH_UP_MS', 3 * 60 * 1000);
export const PRUNE_INTERVAL_MS = agreed('DN_PRUNE_INTERVAL_MS', 10 * 60 * 1000);
export const MAX_ROUNDS = 4;
// TICKET_WAIT: a large-body ticket's life before the body's headers arrive. TICKET_REST: a
// member whose tickets went unused twice running gets none for this long, doubling to the
// max; also how long a member counts as having just had a place.
export const TICKET_WAIT_MS = agreed('DN_TICKET_WAIT_MS', 10 * 1000);
export const TICKET_REST_MS = agreed('DN_TICKET_REST_MS', 60 * 1000);
export const TICKET_REST_MAX_MS = agreed('DN_TICKET_REST_MAX_MS', 60 * 60 * 1000);
// Bodies above STRANGER_BODY_BYTES read at once, over all senders.
export const MAX_LARGE_BODIES = 4;
// How long Diplomat's last free-slot count is trusted.
export const ADMIT_TTL_MS = agreed('DN_ADMIT_TTL_MS', 120 * 1000);
// Diplomat counts free slots from a slightly older snapshot: a run begun within this long
// before may be missing from the count.
export const ADMIT_LAG_SECS = 10;
// How long a switched-off host waits for the members to hear what it ended.
export const SWITCH_OFF_WAIT_MS = agreed('DN_SWITCH_OFF_WAIT_MS', 15 * 1000);

// Acting as the requester (PROTOCOL.md section 9). Maps a forge host to a stand-in for tests, e.g.
// {"api.github.com":"http://127.0.0.1:1234"}; an unlisted host is https://<host>.
export const FORGE_ORIGINS = (() => {
  try {
    const parsed = JSON.parse(process.env.DN_FORGE_ORIGINS || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch { return {}; }
})();
export const FORGE_TIMEOUT_MS = num('DN_FORGE_TIMEOUT_MS', 60 * 1000);
export const FORGE_RESPONSE_MAX_BYTES = num('DN_FORGE_RESPONSE_MAX_BYTES', 32 * 2 ** 20);
// How long a token read from gh or glab is reused.
export const TOKEN_TTL_MS = num('DN_TOKEN_TTL_MS', 60 * 1000);
// Ref commands and pack. An `act` request's 48 MiB of JSON is 36 MiB once its base64 is undone.
export const PUSH_MAX_BYTES = num('DN_PUSH_MAX_BYTES', 32 * 2 ** 20);
// A pack's object sizes added up, a delta counted as itself and as the object it builds:
// about what git holds in memory to index it.
export const PUSH_UNPACKED_MAX_BYTES = num('DN_PUSH_UNPACKED_MAX_BYTES', 512 * 2 ** 20);
// Per git command of the push check, the fetch into the quarantine included.
export const GIT_TIMEOUT_MS = bound('DN_GIT_TIMEOUT_MS', 120 * 1000);

// Executor side.
export const SECURITY_BIN = process.env.DN_SECURITY || 'security';
export const CLAUDE_BIN = process.env.DN_CLAUDE || 'claude';
// Per Keychain item. With every core taken, `security` is slow to start at all.
export const KEYCHAIN_TIMEOUT_MS = bound('DN_KEYCHAIN_TIMEOUT_MS', 30 * 1000);
// `networkModelToken`: a generic-password item under this service in the macOS login
// Keychain, a file elsewhere.
export const MODEL_TOKEN_KEYCHAIN = process.env.DN_MODEL_TOKEN_KEYCHAIN || 'Diplomat-networkModelToken';
export const MODEL_TOKEN_PATH = process.env.DN_MODEL_TOKEN_PATH
  ? home(process.env.DN_MODEL_TOKEN_PATH)
  : path.join(os.homedir(), '.diplomat', 'network-model-token');
// The tag is the hash of image/.
export const IMAGE_REPO = process.env.DN_IMAGE_REPO || 'diplomat-agent';
export const IMAGE_BUILD_TIMEOUT_MS = bound('DN_IMAGE_BUILD_TIMEOUT_MS', 30 * 60 * 1000);
export const CONTAINER_PIDS = bound('DN_CONTAINER_PIDS', 4096);
export const CONTAINER_MEMORY = amount('DN_CONTAINER_MEMORY', '8g');
export const CONTAINER_CPUS = amount('DN_CONTAINER_CPUS', '4');
// A container no job of this daemon was ever in is removed once it has been seen for this long.
export const CONTAINER_IDLE_MS = num('DN_CONTAINER_IDLE_MS', 6 * 3600 * 1000);
// Its writable layer, its /work volume and its run records together.
export const CONTAINER_DISK_BYTES = num('DN_CONTAINER_DISK_BYTES', 20 * 2 ** 30);
export const CONTAINER_USAGE_TIMEOUT_MS = bound('DN_CONTAINER_USAGE_TIMEOUT_MS', 5 * 60 * 1000);
// Counting what a running container's processes hold open: it reads files of each process,
// in a pid namespace the job can stop it in.
export const CONTAINER_HELD_TIMEOUT_MS = bound('DN_CONTAINER_HELD_TIMEOUT_MS', 30 * 1000);
// Empty: the address host.docker.internal leads to (loopback under Docker Desktop, the
// bridge gateway on Linux).
export const BROKER_BIND = process.env.DN_BROKER_BIND || '';
export const BROKER_PORT = num('DN_BROKER_PORT', 0);
export const LOCAL_PORTS_PATH = process.env.DN_LOCAL_PORTS_PATH || '/proc/sys/net/ipv4/ip_local_port_range';
// A forge request's body travels as one `act` request's.
export const FORGE_BODY_CAP = 48 * 2 ** 20;
export const FORGE_ANSWER_TIMEOUT_MS = num('DN_FORGE_ANSWER_TIMEOUT_MS', 5 * 60 * 1000);
export const MIRROR_TIMEOUT_MS = bound('DN_MIRROR_TIMEOUT_MS', 10 * 60 * 1000);
// For a job's `done` file; its process is checked every JOB_LIVENESS_MS.
export const JOB_POLL_MS = num('DN_JOB_POLL_MS', 500);
export const JOB_LIVENESS_MS = num('DN_JOB_LIVENESS_MS', 10 * 1000);
// Between SIGTERM and SIGKILL.
export const JOB_STOP_GRACE_MS = num('DN_JOB_STOP_GRACE_MS', 5000);
/// A job still there this long after it was first told to stop ends with its container.
export const JOB_STOP_BOUND_MS = num('DN_JOB_STOP_BOUND_MS', 60 * 1000);
export const CONTAINER_HOST = process.env.DN_CONTAINER_HOST || 'host.docker.internal';
// A job container reaches the broker through its relay by this name; the relay uses CONTAINER_HOST.
export const RELAY_HOST = process.env.DN_RELAY_HOST || 'dn-broker';
// A per-job fuse on this machine's model credential (requests; bytes both ways), far above
// what a task spends.
export const JOB_MODEL_REQUESTS = num('DN_JOB_MODEL_REQUESTS', 5000);
export const JOB_MODEL_BYTES = num('DN_JOB_MODEL_BYTES', 8 * 2 ** 30);

/// Kept for the next daemon: the broker's port and, per job, its container, proxy token and
/// trusted CA generation (0600).
export const JOBS_PATH = path.join(BASE_DIR, 'jobs.json');
/// Polls in a row before an unreadable config reads as switched off: one read can fall
/// in the middle of a rewrite.
export const CONFIG_UNREADABLE_POLLS = num('DN_CONFIG_UNREADABLE_POLLS', 5);
export const STATE_WRITE_MS = num('DN_STATE_WRITE_MS', 1000);
/// In characters: the node holds an offer's prompt and options to half a mebibyte, and
/// JSON may write a character as six.
export const SOCKET_BODY_CHARS = 4 * 2 ** 20;
/// Rechecks the docker engine and the model credential.
export const EXECUTOR_CHECK_MS = num('DN_EXECUTOR_CHECK_MS', 30 * 1000);
/// Holds the jobs in this daemon's containers against the node's runs.
export const RECONCILE_MS = num('DN_RECONCILE_MS', 15 * 1000);
/// Sweeps containers over their disk allowance, leftovers under a container's name no job
/// is in, unused images, old CA generations, ended runs' directories and unlinked pools' mirrors.
export const SWEEP_MS = num('DN_SWEEP_MS', 10 * 60 * 1000);
/// Before retrying what failed for want of docker: a stop, the broker's listener.
export const EXECUTOR_RETRY_MS = num('DN_EXECUTOR_RETRY_MS', 5000);
/// How long a starting daemon waits on an unresponsive engine for the previous daemon's
/// jobs before giving them back.
export const ENGINE_WAIT_MS = num('DN_ENGINE_WAIT_MS', 60 * 1000);
/// A pool is left alone this long after a job of it failed to start here, doubling per
/// failure in a row, to the max.
export const POOL_RETRY_MS = num('DN_POOL_RETRY_MS', 60 * 1000);
export const POOL_RETRY_MAX_MS = num('DN_POOL_RETRY_MAX_MS', 10 * 60 * 1000);
export const JOBS_WRITE_MS = num('DN_JOBS_WRITE_MS', 5000);
export const RUN_KEEP_MS = num('DN_RUN_KEEP_MS', 24 * 3600 * 1000);
/// From when the pool was last linked.
export const MIRROR_KEEP_MS = num('DN_MIRROR_KEEP_MS', 24 * 3600 * 1000);
/// An uncaught exception recurring this many times within FAULT_WINDOW_MS, or a timer's
/// work failing the same way this many times in a row, ends the daemon.
export const FAULT_REPEATS = 5;
export const FAULT_WINDOW_MS = num('DN_FAULT_WINDOW_MS', 60 * 1000);
/// Tests only: a file whose lines the daemon throws, one per config poll.
export const TEST_FAULTS_PATH = process.env.DN_TEST_FAULTS || '';
TEST_KNOBS.push(...Object.entries(process.env)
  .filter(([name, value]) => /^DN_TEST_/.test(name) || name === 'DN_FORGE_ORIGINS' || (name === 'DN_TRANSPORT' && value === 'loop'))
  .map(([name, value]) => `${name}=${value}`));
TEST_KNOBS.sort();
/// Removed after leaving the network, once what it made in docker is gone. Its key, pools
/// and offers stay: switched on again, it is the member it was.
export const OFF_REMOVES = [CA_DIR, MIRRORS_DIR, RUNS_DIR];
/// The applets kill an installer after 90 s and read no answer from it (`installerTimeout`
/// in NodePackage.swift, `INSTALLER_TIMEOUT_SECS` in deviceallocator.py): stay under that,
/// and STOP_WAIT_MS under this.
export const INSTALLER_ANSWER_MS = num('DN_INSTALLER_ANSWER_MS', 75 * 1000);
/// Before a transport whose start failed is made again, doubling per failure to the max.
export const TRANSPORT_RETRY_MS = num('DN_TRANSPORT_RETRY_MS', 5000);
export const TRANSPORT_RETRY_MAX_MS = num('DN_TRANSPORT_RETRY_MAX_MS', 5 * 60 * 1000);
/// A switched-off daemon waits SWITCH_OFF_WAIT_MS at most three times (pools hearing, jobs
/// taken down, engine cleanup), then tor's stop grace.
export const STOP_WAIT_MS = num('DN_STOP_WAIT_MS', 3 * SWITCH_OFF_WAIT_MS + 15 * 1000);

// How long a machine with no device holds back from an Android task, so one with a device gets it first.
export const DEVICE_WAIT_MS = num('DN_DEVICE_WAIT_MS', 30 * 1000);

function loopback(value) {
  const m = /^(127\.0\.0\.1|localhost|\[::1\]):(\d{1,5})$/.exec(String(value ?? ''));
  return m && Number(m[2]) > 0 && Number(m[2]) < 65536 ? { host: m[1] === 'localhost' ? '127.0.0.1' : m[1].replace(/[[\]]/g, ''), port: Number(m[2]) } : null;
}
/// While `networkDevices` is on and this answers, every job gets a filtered way to it.
export const ADB_SERVER = loopback(process.env.DN_ADB_SERVER || '127.0.0.1:5037');
/// More forwards every job gets while `networkDevices` is on, as JSON name -> "127.0.0.1:port".
export const FORWARDS = (() => {
  try {
    const parsed = JSON.parse(process.env.DN_FORWARDS || '{}');
    return Object.fromEntries(Object.entries(parsed ?? {})
      .map(([name, target]) => [name, loopback(target)])
      .filter(([name, target]) => /^[a-z0-9-]{1,32}$/.test(name) && name !== 'adb' && target));
  } catch { return {}; }
})();

/// Per-job broker limits. Connections:
export const JOB_CONNECTIONS = num('DN_JOB_CONNECTIONS', 256);
/// Bytes of request bodies read whole (forge, model) over all of the job's requests; one
/// that would pass it waits unread. One request alone always fits.
export const JOB_BUFFER_BYTES = num('DN_JOB_BUFFER_BYTES', FORGE_BODY_CAP);
/// Forge requests and mirror fetches in flight: each holds up to FORGE_RESPONSE_MAX_BYTES,
/// or a git process here.
export const JOB_FORGE_REQUESTS = num('DN_JOB_FORGE_REQUESTS', 4);
/// For a request's head (or the TLS handshake), for a body read whole, and for a connection
/// carrying nothing before the broker closes it.
export const JOB_HEADER_MS = num('DN_JOB_HEADER_MS', 30 * 1000);
export const JOB_BODY_MS = num('DN_JOB_BODY_MS', 5 * 60 * 1000);
export const JOB_IDLE_MS = bound('DN_JOB_IDLE_MS', 30 * 60 * 1000);
