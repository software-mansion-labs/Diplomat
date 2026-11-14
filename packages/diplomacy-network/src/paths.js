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
export const HOURS_FLOOR = 12;
export const LEASE_SECS = num('DN_LEASE_SECS', 7200);
export const LEASE_GRACE_SECS = num('DN_LEASE_GRACE_SECS', 600);
export const PING_LEAD_SECS = num('DN_PING_LEAD_SECS', 600);
export const GRANT_TTL_SECS = num('DN_GRANT_TTL_SECS', 120);
export const RECORD_RETENTION_SECS = num('DN_RECORD_RETENTION_SECS', 24 * 3600);
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
// Diplomat's last word on free slots is trusted this long.
export const ADMIT_TTL_MS = num('DN_ADMIT_TTL_MS', 120 * 1000);
// A container no job has used for this long is removed.
export const CONTAINER_IDLE_MS = num('DN_CONTAINER_IDLE_MS', 6 * 3600 * 1000);
