// Filesystem layout, tools and tunables. Everything the daemon owns lives under
// ~/.diplomat/network; DN_BASE_DIR redirects it, which is how the tests never touch the
// real one.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = (p) => p.replace(/^~(?=$|\/)/, os.homedir());
const num = (name, fallback) => Number(process.env[name]) || fallback;

export const BASE_DIR = process.env.DN_BASE_DIR
  ? home(process.env.DN_BASE_DIR)
  : path.join(os.homedir(), '.diplomat', 'network');

export const SOCKET_PATH = path.join(BASE_DIR, 'daemon.sock');
export const DISCOVERY_PATH = path.join(BASE_DIR, 'daemon.json'); // {pid, identity, startedAt, socket}
export const STATE_PATH = path.join(BASE_DIR, 'state.json'); // the snapshot as the daemon last had it, for a person: the applets ask the socket
export const LOG_PATH = path.join(BASE_DIR, 'daemon.log');
export const IDENTITY_PATH = path.join(BASE_DIR, 'identity.json');
export const KEYS_PATH = path.join(BASE_DIR, 'keys.json');
export const POOLS_DIR = path.join(BASE_DIR, 'pools');
export const TOR_DIR = path.join(BASE_DIR, 'tor');
export const CA_DIR = path.join(BASE_DIR, 'ca');
export const MIRRORS_DIR = path.join(BASE_DIR, 'mirrors');
export const RUNS_DIR = path.join(BASE_DIR, 'runs');

// Diplomat's cross-process settings, relocated by the same DIPLOMAT_CONFIG the applets
// honour: networkEnabled, networkRequiredMinimumH and networkMaximumAcceptedH.
export const CONFIG_PATH = process.env.DIPLOMAT_CONFIG
  ? home(process.env.DIPLOMAT_CONFIG)
  : path.join(os.homedir(), '.diplomat', 'config.json');
export const CONFIG_POLL_MS = num('DN_CONFIG_POLL_MS', 1000);

// Where a user's installs put a tool. An app started by launchd or by a desktop session
// is given the system's directories alone, and so is everything it starts.
const INSTALL_DIRS = [
  '/opt/homebrew/bin', '/usr/local/bin', '~/.local/bin', '~/bin', '~/.docker/bin', '/Applications/Docker.app/Contents/Resources/bin',
  '~/.nix-profile/bin', '/nix/var/nix/profiles/default/bin', '/run/current-system/sw/bin', '/home/linuxbrew/.linuxbrew/bin',
  '/opt/local/bin', '/snap/bin',
];
/// The PATH the daemon looks for its tools on and gives to everything it starts, so
/// that gh finds git and docker its credential helper: the one it was given, then the
/// directories of a user's installs (DN_TOOL_DIRS, colon-separated, in their place),
/// then node's own, for a tool that runs under `env node`.
export const TOOL_PATH = [...new Set([
  ...(process.env.PATH || '').split(':'),
  ...(process.env.DN_TOOL_DIRS ? process.env.DN_TOOL_DIRS.split(':') : INSTALL_DIRS).map(home),
  path.dirname(process.execPath),
].filter(Boolean))].join(':');

/// Where `tool` is: itself when it names a path, else the first file of that name on
/// `searchPath` that can be run. Null when there is none.
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
// "tor" or "loop": loop is plain loopback TCP through a directory of addresses, for tests.
export const TRANSPORT = process.env.DN_TRANSPORT || 'tor';
export const LOOP_DIR = process.env.DN_LOOP_DIR || path.join(BASE_DIR, 'loop');

// Protocol constants (PROTOCOL.md). The env overrides exist for tests, which cannot wait
// two hours for a lease or burn a quarter second per stranger request.
export const POW = {
  memberBase: num('DN_POW_MEMBER_BASE', 16384),
  memberAllow: num('DN_POW_MEMBER_ALLOW', 30),
  memberCap: 12,
  strangerBase: num('DN_POW_STRANGER_BASE', 262144),
  strangerAllow: num('DN_POW_STRANGER_ALLOW', 4),
  strangerCap: 8,
  windowSecs: 60,
  epochSecs: 3600,
};
export const CLOCK_SKEW_SECS = 300;
// The largest request body, and the larger one an `act` request may carry. A sender that
// is not a member of the request's pool gets the stranger's cap.
export const MAX_BODY_BYTES = 2 ** 20;
export const MAX_ACT_BODY_BYTES = 48 * 2 ** 20;
export const STRANGER_BODY_BYTES = 64 * 2 ** 10;
export const HOURS_FLOOR = 12;
export const HOURS_CEILING = 720;
export const LEASE_SECS = num('DN_LEASE_SECS', 7200);
export const LEASE_GRACE_SECS = num('DN_LEASE_GRACE_SECS', 600);
export const PING_LEAD_SECS = num('DN_PING_LEAD_SECS', 600);
export const GRANT_TTL_SECS = num('DN_GRANT_TTL_SECS', 120);
// Every offer and claim version, and a member's standing as a member, lasts this long
// after the version was signed. It must stay far longer than a lease and its grace.
export const RECORD_RETENTION_SECS = num('DN_RECORD_RETENTION_SECS', 24 * 3600);
// A member record is kept this long after it was signed: a host that was away for less
// comes back with a version signed again, and needs no invite for it.
export const MEMBER_RETENTION_SECS = num('DN_MEMBER_RETENTION_SECS', 30 * 24 * 3600);
// A host signs its member record and its open offers again this often, four times
// inside their retention.
export const RESIGN_INTERVAL_MS = num('DN_RESIGN_INTERVAL_MS', (RECORD_RETENTION_SECS * 1000) / 4);
export const INVITE_TTL_SECS = 24 * 3600;
export const OFFER_ATTEMPTS = 3;

// One request to a peer, the circuit and the proof of work included.
export const REQUEST_TIMEOUT_MS = num('DN_REQUEST_TIMEOUT_MS', 60 * 1000);
// How long a claim round waits for the members that have not answered.
export const ROUND_TIMEOUT_MS = num('DN_ROUND_TIMEOUT_MS', 3 * 60 * 1000);
// Every pool is reconciled with every member this often.
export const SYNC_INTERVAL_MS = num('DN_SYNC_INTERVAL_MS', 60 * 1000);
// The longest a host waits, by its rank on a task, before starting to claim it.
export const RANK_DELAY_MS = num('DN_RANK_DELAY_MS', 5000);
// A claim round asks every member afresh, whatever the gossip thinks of it. A member that
// answered within PEER_QUIET_MS is given a whole REQUEST_TIMEOUT_MS. One this host has
// never reached and has known for less than that is asked again until ROUND_PATIENCE_MS of
// the round have passed: a first circuit to an onion service can take minutes. Any other
// gets PROBE_TIMEOUT_MS, so a sleeping machine costs a round seconds.
export const PROBE_TIMEOUT_MS = num('DN_PROBE_TIMEOUT_MS', 15 * 1000);
export const PEER_QUIET_MS = num('DN_PEER_QUIET_MS', 3 * SYNC_INTERVAL_MS);
export const ROUND_PATIENCE_MS = num('DN_ROUND_PATIENCE_MS', ROUND_TIMEOUT_MS / 2);
// After a request to a peer goes unanswered, gossip leaves that peer alone for this long,
// doubling per failure up to the cap.
export const PEER_BACKOFF_MS = num('DN_PEER_BACKOFF_MS', 5000);
export const PEER_BACKOFF_MAX_MS = num('DN_PEER_BACKOFF_MAX_MS', 10 * 60 * 1000);
// One `act` request, the forge call and the push check on the requester's side included;
// a body is given ACT_BYTES_PER_SEC on top of it.
export const ACT_TIMEOUT_MS = num('DN_ACT_TIMEOUT_MS', 5 * 60 * 1000);
export const ACT_BYTES_PER_SEC = 32 * 2 ** 10;
// How often an unanswered ping, key request or outcome report is sent again, and how
// long a task whose round stood down is left alone.
export const RETRY_MS = num('DN_RETRY_MS', 30 * 1000);
// How long a host leaves an offer of a task that is running to that run before it goes
// for it: the run asks for such an offer itself, when it hears of it and every RETRY_MS.
export const JOIN_WAIT_MS = num('DN_JOIN_WAIT_MS', 2 * RETRY_MS);
// How often a host looks at everything it holds for something that came due.
export const TICK_MS = num('DN_TICK_MS', 10 * 1000);
// A host whose clock moved this far between two looks was not running meanwhile - the
// machine slept - and what it holds of its pools is as old as that.
export const WAKE_GAP_MS = num('DN_WAKE_GAP_MS', 6 * TICK_MS);
// How long a host that started or woke goes on asking the members of a pool what it
// missed while none of them answers, before it goes on with what it holds.
export const CATCH_UP_MS = num('DN_CATCH_UP_MS', 3 * 60 * 1000);
export const PRUNE_INTERVAL_MS = num('DN_PRUNE_INTERVAL_MS', 10 * 60 * 1000);
// How many claim rounds one host runs at a time.
export const MAX_ROUNDS = 4;
// How many bodies above the stranger's cap a host reads at once, over all senders.
export const MAX_LARGE_BODIES = 4;
// Diplomat's last word on free slots is trusted this long.
export const ADMIT_TTL_MS = num('DN_ADMIT_TTL_MS', 120 * 1000);
// Diplomat counts its free slots from a snapshot it read a moment before it states them:
// a run begun within this long before the statement may be missing from that count.
export const ADMIT_LAG_SECS = 10;
// How long a host that is switched off waits for the members to hear what it ended.
export const SWITCH_OFF_WAIT_MS = num('DN_SWITCH_OFF_WAIT_MS', 15 * 1000);
// A container no job has used for this long is removed.
export const CONTAINER_IDLE_MS = num('DN_CONTAINER_IDLE_MS', 6 * 3600 * 1000);

// Acting as the requester (PROTOCOL.md section 9). Where each forge host is reached:
// {"api.github.com":"http://127.0.0.1:1234"} sends that host's requests to a stand-in,
// which is how the tests never touch a real forge. A host not listed is https://<host>.
export const FORGE_ORIGINS = (() => {
  try {
    const parsed = JSON.parse(process.env.DN_FORGE_ORIGINS || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch { return {}; }
})();
// One request to the forge, and the largest answer passed back to an executor.
export const FORGE_TIMEOUT_MS = num('DN_FORGE_TIMEOUT_MS', 60 * 1000);
export const FORGE_RESPONSE_MAX_BYTES = num('DN_FORGE_RESPONSE_MAX_BYTES', 32 * 2 ** 20);
// A forge token read from gh or glab is reused this long before it is read again.
export const TOKEN_TTL_MS = num('DN_TOKEN_TTL_MS', 60 * 1000);
// The largest push body (ref commands and pack) the push check reads. An `act` request
// is capped at 48 MiB of JSON, which is 36 MiB once its base64 is undone.
export const PUSH_MAX_BYTES = num('DN_PUSH_MAX_BYTES', 32 * 2 ** 20);
// What a pushed pack may unfold to: the sizes of its objects added up, a delta counted as
// its own bytes and as the object it builds. About what git holds in memory to index it.
export const PUSH_UNPACKED_MAX_BYTES = num('DN_PUSH_UNPACKED_MAX_BYTES', 512 * 2 ** 20);
// One git command of the push check, the fetch into the quarantine included.
export const GIT_TIMEOUT_MS = num('DN_GIT_TIMEOUT_MS', 120 * 1000);

// Executor side.
export const SECURITY_BIN = process.env.DN_SECURITY || 'security';
export const CLAUDE_BIN = process.env.DN_CLAUDE || 'claude';
// How long `security` is given to answer for one Keychain item. On a machine with every
// core taken it is slow to start at all.
export const KEYCHAIN_TIMEOUT_MS = num('DN_KEYCHAIN_TIMEOUT_MS', 30 * 1000);
// The model token the operator set aside for the network (`networkModelToken`): a
// generic-password item under this service in the macOS login Keychain, a file elsewhere.
export const MODEL_TOKEN_KEYCHAIN = process.env.DN_MODEL_TOKEN_KEYCHAIN || 'Diplomat-networkModelToken';
export const MODEL_TOKEN_PATH = process.env.DN_MODEL_TOKEN_PATH
  ? home(process.env.DN_MODEL_TOKEN_PATH)
  : path.join(os.homedir(), '.diplomat', 'network-model-token');
// The image's repository name; its tag is the hash of image/.
export const IMAGE_REPO = process.env.DN_IMAGE_REPO || 'diplomat-agent';
export const IMAGE_BUILD_TIMEOUT_MS = num('DN_IMAGE_BUILD_TIMEOUT_MS', 30 * 60 * 1000);
// What one container may use of this machine.
export const CONTAINER_PIDS = num('DN_CONTAINER_PIDS', 4096);
export const CONTAINER_MEMORY = process.env.DN_CONTAINER_MEMORY || '8g';
export const CONTAINER_CPUS = process.env.DN_CONTAINER_CPUS || '4';
// The most one container may hold of this machine's disk: its writable layer, its /work
// volume and its run records together.
export const CONTAINER_DISK_BYTES = num('DN_CONTAINER_DISK_BYTES', 20 * 2 ** 30);
// How long one measurement of a container's disk use may take.
export const CONTAINER_USAGE_TIMEOUT_MS = num('DN_CONTAINER_USAGE_TIMEOUT_MS', 5 * 60 * 1000);
// Where the broker listens: empty picks the address a container's host.docker.internal
// leads to (loopback under Docker Desktop, the bridge gateway on Linux).
export const BROKER_BIND = process.env.DN_BROKER_BIND || '';
export const BROKER_PORT = num('DN_BROKER_PORT', 0);
// Where Linux states the range of ports it deals outgoing connections from.
export const LOCAL_PORTS_PATH = process.env.DN_LOCAL_PORTS_PATH || '/proc/sys/net/ipv4/ip_local_port_range';
// One forge request's body, which is one `act` request's.
export const FORGE_BODY_CAP = 48 * 2 ** 20;
// How long a job's forge request waits for the requester's answer.
export const FORGE_ANSWER_TIMEOUT_MS = num('DN_FORGE_ANSWER_TIMEOUT_MS', 5 * 60 * 1000);
export const MIRROR_TIMEOUT_MS = num('DN_MIRROR_TIMEOUT_MS', 10 * 60 * 1000);
// A job's `done` file is looked for this often, its process far less often.
export const JOB_POLL_MS = num('DN_JOB_POLL_MS', 500);
export const JOB_LIVENESS_MS = num('DN_JOB_LIVENESS_MS', 10 * 1000);
// A stopped job gets this long between SIGTERM and SIGKILL.
export const JOB_STOP_GRACE_MS = num('DN_JOB_STOP_GRACE_MS', 5000);
/// A job still there this long after it was first told to stop ends with its container.
export const JOB_STOP_BOUND_MS = num('DN_JOB_STOP_BOUND_MS', 60 * 1000);
// The name a container reaches this machine's broker by.
export const CONTAINER_HOST = process.env.DN_CONTAINER_HOST || 'host.docker.internal';
// The name a job container reaches its relay by, and through it the broker. The relay
// reaches this machine by CONTAINER_HOST.
export const RELAY_HOST = process.env.DN_RELAY_HOST || 'dn-broker';
// The most one job gets of the model on this machine's credential: requests, and bytes
// sent and received together. A fuse against a job that runs away, set far above what a
// task spends.
export const JOB_MODEL_REQUESTS = num('DN_JOB_MODEL_REQUESTS', 5000);
export const JOB_MODEL_BYTES = num('DN_JOB_MODEL_BYTES', 8 * 2 ** 30);

/// What the daemon keeps of its jobs for the daemon after it: the broker's port and, per
/// job, its container, its proxy token and the CA generation it trusts (0600).
export const JOBS_PATH = path.join(BASE_DIR, 'jobs.json');
/// How many polls in a row Diplomat's config must be unreadable before that reads as the
/// network switched off: a single read can fall in the middle of a rewrite.
export const CONFIG_UNREADABLE_POLLS = num('DN_CONFIG_UNREADABLE_POLLS', 5);
/// The snapshot file is rewritten at most this often.
export const STATE_WRITE_MS = num('DN_STATE_WRITE_MS', 1000);
/// The longest body the local socket reads, in characters. An offer's prompt and options
/// are held to half a mebibyte by the node, and JSON may write a character as six.
export const SOCKET_BODY_CHARS = 4 * 2 ** 20;
/// How often the docker engine and the model credential are looked at again.
export const EXECUTOR_CHECK_MS = num('DN_EXECUTOR_CHECK_MS', 30 * 1000);
/// How often the jobs in this daemon's containers are held against the node's runs.
export const RECONCILE_MS = num('DN_RECONCILE_MS', 15 * 1000);
/// How often what is not kept for ever is looked at: idle containers, old CA
/// generations, the directories of ended runs, the mirrors of pools no longer linked.
export const SWEEP_MS = num('DN_SWEEP_MS', 10 * 60 * 1000);
/// The pause before something that failed for want of docker is tried again: a stop that
/// did not go through, the broker's listener.
export const EXECUTOR_RETRY_MS = num('DN_EXECUTOR_RETRY_MS', 5000);
/// How long a pool is left alone after a job of it could not be started on this machine:
/// this long after the first failure, twice as long after each one in a row, and no
/// longer than the second.
export const POOL_RETRY_MS = num('DN_POOL_RETRY_MS', 60 * 1000);
export const POOL_RETRY_MAX_MS = num('DN_POOL_RETRY_MAX_MS', 10 * 60 * 1000);
/// jobs.json follows what the jobs have spent of the model this often.
export const JOBS_WRITE_MS = num('DN_JOBS_WRITE_MS', 5000);
/// A run's directory and its outcome are kept this long after the run ended.
export const RUN_KEEP_MS = num('DN_RUN_KEEP_MS', 24 * 3600 * 1000);
/// A pool's mirror is kept this long after the pool was last linked and not left.
export const MIRROR_KEEP_MS = num('DN_MIRROR_KEEP_MS', 24 * 3600 * 1000);
/// An uncaught exception that comes back this many times within FAULT_WINDOW_MS, or a
/// timer's work that fails the same way this many times in a row, ends the daemon.
export const FAULT_REPEATS = 5;
/// The time within which a fault that comes back counts as the same trouble.
export const FAULT_WINDOW_MS = num('DN_FAULT_WINDOW_MS', 60 * 1000);
/// Only for tests: a file whose lines the daemon throws, one per config poll.
export const TEST_FAULTS_PATH = process.env.DN_TEST_FAULTS || '';
/// What only a test sets, as `NAME=value`, of what this process was given: each takes
/// from the daemon something the network rests on - Tor, the forge, the proof of work.
export const TEST_KNOBS = Object.entries(process.env)
  .filter(([name, value]) => /^DN_(TEST|POW)_/.test(name) || name === 'DN_FORGE_ORIGINS' || (name === 'DN_TRANSPORT' && value === 'loop'))
  .map(([name, value]) => `${name}=${value}`).sort();
/// What a machine that left the network has no further use for, removed once what it
/// made in docker is gone: the records of its jobs, prompts among them, its mirrors, and
/// the certificate authorities its containers trusted. Its key, its pools and what it
/// offered stay: switched on again, it is the member it was.
export const OFF_REMOVES = [RUNS_DIR, MIRRORS_DIR, CA_DIR];
/// The longest the installer takes to answer, whatever it was asked. The applets kill an
/// installer after 90 s and read no answer from one they killed (`installerTimeout` in
/// NodePackage.swift, `INSTALLER_TIMEOUT_SECS` in deviceallocator.py): this has to stay
/// under that, and STOP_WAIT_MS under this.
export const INSTALLER_ANSWER_MS = num('DN_INSTALLER_ANSWER_MS', 75 * 1000);
/// The wait before a transport whose start failed is made again and started.
export const TRANSPORT_RETRY_MS = num('DN_TRANSPORT_RETRY_MS', 5000);
/// That wait doubles after every start that fails, up to this.
export const TRANSPORT_RETRY_MAX_MS = num('DN_TRANSPORT_RETRY_MAX_MS', 5 * 60 * 1000);
/// How long the installer waits for a daemon it stopped to be gone. A daemon that is
/// switched off waits SWITCH_OFF_WAIT_MS at most three times - for its pools to hear, for
/// its jobs to be taken down, for the engine to remove what it made - and 10 s for tor.
export const STOP_WAIT_MS = num('DN_STOP_WAIT_MS', 3 * SWITCH_OFF_WAIT_MS + 15 * 1000);

// How long a machine with no device to give holds back from a task on an Android
// project, so that a machine with a device gets to it first.
export const DEVICE_WAIT_MS = num('DN_DEVICE_WAIT_MS', 30 * 1000);

// `host:port` on this machine's loopback as `{ host, port }`, or null.
function loopback(value) {
  const m = /^(127\.0\.0\.1|localhost|\[::1\]):(\d{1,5})$/.exec(String(value ?? ''));
  return m && Number(m[2]) > 0 && Number(m[2]) < 65536 ? { host: m[1] === 'localhost' ? '127.0.0.1' : m[1].replace(/[[\]]/g, ''), port: Number(m[2]) } : null;
}
/// The host's adb server: while `networkDevices` is on and it answers, every job is
/// given a filtered way to it.
export const ADB_SERVER = loopback(process.env.DN_ADB_SERVER || '127.0.0.1:5037');
/// More forwards every job is given while `networkDevices` is on: DN_FORWARDS is a JSON
/// object of name -> "127.0.0.1:port". A name that is no forward's name or a target off
/// this machine's loopback is left out.
export const FORWARDS = (() => {
  try {
    const parsed = JSON.parse(process.env.DN_FORWARDS || '{}');
    return Object.fromEntries(Object.entries(parsed ?? {})
      .map(([name, target]) => [name, loopback(target)])
      .filter(([name, target]) => /^[a-z0-9-]{1,32}$/.test(name) && name !== 'adb' && target));
  } catch { return {}; }
})();

/// What one job may hold of the broker at a time. Its container's connections through it:
export const JOB_CONNECTIONS = num('DN_JOB_CONNECTIONS', 256);
/// The request bodies the broker reads whole before it carries them on (a forge request,
/// a model request), in bytes over all of the job's requests; a request that would pass
/// it waits unread for the ones before it. One request alone always fits.
export const JOB_BUFFER_BYTES = num('DN_JOB_BUFFER_BYTES', FORGE_BODY_CAP);
/// Its forge requests and mirror fetches in flight: each holds an answer of up to
/// FORGE_RESPONSE_MAX_BYTES, or a git process on this machine.
export const JOB_FORGE_REQUESTS = num('DN_JOB_FORGE_REQUESTS', 4);
/// How long a job's connection may take to deliver a request's head (or the TLS
/// handshake before it), how long a body read whole may take to arrive, and how long a
/// connection may carry nothing at all before the broker closes it.
export const JOB_HEADER_MS = num('DN_JOB_HEADER_MS', 30 * 1000);
export const JOB_BODY_MS = num('DN_JOB_BODY_MS', 5 * 60 * 1000);
export const JOB_IDLE_MS = num('DN_JOB_IDLE_MS', 30 * 60 * 1000);
