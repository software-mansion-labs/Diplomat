// Filesystem layout, tools and tunables. Everything the daemon owns lives under
// ~/.diplomat/network; DN_BASE_DIR redirects it, which is how the tests never touch the
// real one.

import os from 'node:os';
import path from 'node:path';

const home = (p) => p.replace(/^~(?=$|\/)/, os.homedir());
const num = (name, fallback) => Number(process.env[name]) || fallback;

export const BASE_DIR = process.env.DN_BASE_DIR
  ? home(process.env.DN_BASE_DIR)
  : path.join(os.homedir(), '.diplomat', 'network');

export const SOCKET_PATH = path.join(BASE_DIR, 'daemon.sock');
export const DISCOVERY_PATH = path.join(BASE_DIR, 'daemon.json'); // {pid, identity, startedAt, socket}
export const STATE_PATH = path.join(BASE_DIR, 'state.json'); // the snapshot the applets read
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
// How often a host looks at everything it holds for something that came due.
export const TICK_MS = num('DN_TICK_MS', 10 * 1000);
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
// One git command of the push check, the fetch into the quarantine included.
export const GIT_TIMEOUT_MS = num('DN_GIT_TIMEOUT_MS', 120 * 1000);

// Executor side.
export const SECURITY_BIN = process.env.DN_SECURITY || 'security';
export const CLAUDE_BIN = process.env.DN_CLAUDE || 'claude';
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
// Where the broker listens: empty picks the address a container's host.docker.internal
// leads to (loopback under Docker Desktop, the bridge gateway on Linux).
export const BROKER_BIND = process.env.DN_BROKER_BIND || '';
export const BROKER_PORT = num('DN_BROKER_PORT', 0);
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
// A job's runner is given this long to come up after it is started.
export const JOB_START_MS = num('DN_JOB_START_MS', 60 * 1000);

/// What the daemon keeps of its jobs for the daemon after it: the broker's port and, per
/// job, its container, its proxy token and the CA generation it trusts (0600).
export const JOBS_PATH = path.join(BASE_DIR, 'jobs.json');
/// How many polls in a row Diplomat's config must be unreadable before that reads as the
/// network switched off: a single read can fall in the middle of a rewrite.
export const CONFIG_UNREADABLE_POLLS = num('DN_CONFIG_UNREADABLE_POLLS', 5);
/// The snapshot file is rewritten at most this often.
export const STATE_WRITE_MS = 1000;
/// How often the docker engine and the model credential are looked at again.
export const EXECUTOR_CHECK_MS = num('DN_EXECUTOR_CHECK_MS', 30 * 1000);
/// How often the jobs in this daemon's containers are held against the node's runs.
export const RECONCILE_MS = num('DN_RECONCILE_MS', 15 * 1000);
/// How often idle containers are removed and old CA generations pruned.
export const SWEEP_MS = num('DN_SWEEP_MS', 10 * 60 * 1000);
/// The pause before something that failed for want of docker is tried again: a stop that
/// did not go through, the broker's listener.
export const EXECUTOR_RETRY_MS = num('DN_EXECUTOR_RETRY_MS', 5000);
/// How long the installer waits for a daemon it stopped to be gone. A daemon that is
/// switched off first tells its pools, which SWITCH_OFF_WAIT_MS bounds.
export const STOP_WAIT_MS = num('DN_STOP_WAIT_MS', SWITCH_OFF_WAIT_MS + 30 * 1000);

// `host:port` on this machine's loopback as `{ host, port }`, or null.
function loopback(value) {
  const m = /^(127\.0\.0\.1|localhost|\[::1\]):(\d{1,5})$/.exec(String(value ?? ''));
  return m && Number(m[2]) > 0 && Number(m[2]) < 65536 ? { host: m[1] === 'localhost' ? '127.0.0.1' : m[1].replace(/[[\]]/g, ''), port: Number(m[2]) } : null;
}
/// The host's adb server: forwarded to every job while it answers.
export const ADB_SERVER = loopback(process.env.DN_ADB_SERVER || '127.0.0.1:5037');
/// More forwards every job is given: DN_FORWARDS is a JSON object of name ->
/// "127.0.0.1:port". A name that is no forward's name or a target off this machine's
/// loopback is left out.
export const FORWARDS = (() => {
  try {
    const parsed = JSON.parse(process.env.DN_FORWARDS || '{}');
    return Object.fromEntries(Object.entries(parsed ?? {})
      .map(([name, target]) => [name, loopback(target)])
      .filter(([name, target]) => /^[a-z0-9-]{1,32}$/.test(name) && name !== 'adb' && target));
  } catch { return {}; }
})();
