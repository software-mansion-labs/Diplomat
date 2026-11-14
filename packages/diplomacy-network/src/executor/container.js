// The image every job runs in and the containers made from it: exactly one per
// requesting peer and repository, named dn-<pool hash>-<peer hash>, running many of that
// peer's jobs on that repository and nobody else's, and nothing at all between jobs.
//
// A job container is attached to one network, an internal one of its own with the same
// name: no route leads out of it, to the internet, to this machine, or to another
// peer's container. The only other thing on that network is the container's relay,
// <name>-relay: the same image running image/relay.mjs, which carries TCP from that
// network to the broker's port and to nothing else. No job runs in a relay.
//
// Every container, volume, network and docker query carries dn.base=<BASE_DIR>, so two
// daemons on one machine (a test beside the real one) never see each other's.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  BASE_DIR, CONTAINER_CPUS, CONTAINER_HOST, CONTAINER_IDLE_MS, CONTAINER_MEMORY, CONTAINER_PIDS, DOCKER_BIN,
  IMAGE_BUILD_TIMEOUT_MS, IMAGE_REPO, RELAY_HOST, RUNS_DIR,
} from '../paths.js';

/// The directory the image is built from.
export const IMAGE_DIR = fileURLToPath(new URL('../../image/', import.meta.url));

// What root keeps inside a container: enough for apt-get and for owning files, and
// nothing that reaches outside it. Measured: without any one of these `apt-get install`
// fails.
const CAPABILITIES = ['CHOWN', 'DAC_OVERRIDE', 'FOWNER', 'FSETID', 'SETGID', 'SETUID'];

// A relay runs one small program that needs no privilege, no writable file and no user.
const RELAY_LIMITS = ['--cap-drop=ALL', '--security-opt', 'no-new-privileges', '--read-only', '--user', '65534:65534',
  '--pids-limit', '64', '--memory', '256m'];

// A job network has no route out, no IPv6, and no address of this machine on it:
// measured on Linux, a container on a plain internal network reaches everything the
// host serves through that network's gateway address, the docker API included. Its
// subnet is a /29 chosen here, because an engine has under thirty of its own to give
// and the machine's other projects need them.
const NETWORK_OPTIONS = ['--internal', '--ipv6=false', '-o', 'com.docker.network.bridge.gateway_mode_ipv4=isolated'];
function subnetFor(name, attempt) {
  const h = crypto.createHash('sha256').update(`${name}/${attempt}`).digest();
  return `10.213.${h[0]}.${h[1] & 0xf8}/29`;
}

const hex8 = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 8);

/// The image's tag: the hash of every file under `dir`, so an edited Dockerfile is a new
/// image and an untouched one is never built twice.
export function imageTag(dir = IMAGE_DIR) {
  const h = crypto.createHash('sha256');
  const walk = (rel) => {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = path.posix.join(rel, e.name);
      if (e.isDirectory()) walk(p);
      else h.update(`${p}\0`).update(fs.readFileSync(path.join(dir, p))).update('\0');
    }
  };
  walk('');
  return `${IMAGE_REPO}:${h.digest('hex').slice(0, 12)}`;
}

/// The container for one requesting peer on one pool.
export function containerName(poolId, peer) {
  return `dn-${hex8(poolId)}-${hex8(peer)}`;
}

/// Runs docker; resolves to `{ code, stdout, stderr }`, `code` null when it could not
/// be run at all or was cut off.
export function docker(args, { timeout = 60000, onLine = null } = {}) {
  return new Promise((resolve) => {
    if (!onLine) {
      return execFile(DOCKER_BIN, args, { timeout, encoding: 'utf8', maxBuffer: 16 * 2 ** 20 }, (err, stdout, stderr) => {
        resolve({ code: !err ? 0 : typeof err.code === 'number' ? err.code : null, stdout, stderr: err && err.code === 'ENOENT' ? 'ENOENT' : stderr });
      });
    }
    const child = spawn(DOCKER_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
    let stderr = '';
    let pending = '';
    const feed = (chunk) => {
      stderr = (stderr + chunk).slice(-4000);
      const lines = (pending + chunk).split(/[\r\n]+/);
      pending = lines.pop();
      for (const l of lines) if (l.trim()) onLine(l.trim());
    };
    child.stdout.on('data', feed);
    child.stderr.on('data', feed);
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: null, stdout: '', stderr: e.code === 'ENOENT' ? 'ENOENT' : e.message }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout: '', stderr }); });
  });
}

const lastLine = (s) => s.trim().split('\n').pop() || '';
const relayOf = (name) => `${name}-relay`;

// One container's run records, the only part of RUNS_DIR it is shown: a single shared
// mount would let one peer's jobs read another's prompts and logs. No run id can spell
// the directory these live under.
const runsDirOf = (name) => path.join(RUNS_DIR, '.containers', name);

/// The image and the containers. `dockerState()` is the snapshot's `docker` member.
/// `ensureImage()` resolves to the tag once the image exists, building it if it must.
/// `acquire({ pool, peer, runId })` resolves to that pair's container `{ name, image,
/// runsDir }` with the job counted as running in it, creating or replacing the
/// container when it has to; `release({ name, runId })` ends the job's hold and, when it
/// was the last one, restarts the container so nothing a job left running outlives it
/// (it resolves once that is done).
/// `adopt({ pool, peer, runId })` counts a job an earlier daemon started as running in
/// that pair's container and resolves to the container, or to null when it is not there
/// to be used; nothing in it is restarted.
/// `sweep()` removes every container that has run nothing for CONTAINER_IDLE_MS, with its
/// relay, network and volume. `broker()` is the broker's `address()`: where relays lead.
/// `imageDir` is the directory the image is built from.
export function createContainers({ log = () => {}, now = Date.now, imageDir = IMAGE_DIR, broker = () => null } = {}) {
  let state = { state: 'down', image: '', detail: 'not checked yet' };
  let building = null;
  const known = new Map(); // name -> { name, image, jobs: Set, lastUsed }
  const strays = new Map(); // a container no job of this daemon has used -> when it was first seen
  const queues = new Map(); // name -> the last operation on it

  const serial = (name, fn) => {
    const run = (queues.get(name) || Promise.resolve()).then(fn);
    queues.set(name, run.catch(() => {}));
    return run;
  };

  function fail(next, message) {
    state = { ...state, ...next };
    log('docker', state.state, state.detail);
    return new Error(message || state.detail);
  }

  async function build(tag) {
    const version = await docker(['version', '--format', '{{.Server.Version}}'], { timeout: 20000 });
    if (version.stderr === 'ENOENT') throw fail({ state: 'missing', image: '', detail: `${DOCKER_BIN} not found: every job runs in a container` });
    if (version.code !== 0) throw fail({ state: 'down', image: '', detail: `the docker engine is not answering (${lastLine(version.stderr) || 'no reply'})` });
    if ((await docker(['image', 'inspect', '--format', '{{.Id}}', tag])).code === 0) {
      state = { state: 'ready', image: tag, detail: '' };
      return tag;
    }
    state = { state: 'building', image: tag, detail: 'starting' };
    log('docker', `building ${tag}`);
    const built = await docker(['build', '--progress', 'plain', '-t', tag, imageDir], {
      timeout: IMAGE_BUILD_TIMEOUT_MS,
      onLine: (line) => { state = { state: 'building', image: tag, detail: line.slice(0, 200) }; },
    });
    if (built.code !== 0) throw fail({ state: 'failed', image: tag, detail: `the image did not build: ${lastLine(built.stderr) || 'cut off'}` });
    state = { state: 'ready', image: tag, detail: '' };
    log('docker', `built ${tag}`);
    return tag;
  }

  function ensureImage() {
    building ??= build(imageTag(imageDir)).finally(() => { building = null; });
    return building;
  }

  async function inspect(name) {
    const r = await docker(['container', 'inspect', '--format', '{{json .}}', name]);
    if (r.code !== 0) return null;
    try {
      const c = JSON.parse(r.stdout);
      return { running: c.State.Running === true, image: c.Config.Image, labels: c.Config.Labels || {}, network: c.HostConfig.NetworkMode };
    } catch { return null; }
  }

  async function network(name) {
    const r = await docker(['network', 'inspect', '--format', '{{json .}}', name]);
    if (r.code !== 0) return null;
    try {
      const n = JSON.parse(r.stdout);
      return { labels: n.Labels || {}, subnet: n.IPAM.Config[0].Subnet, gateway: n.IPAM.Config[0].Gateway || '' };
    } catch { return null; }
  }

  async function remove(name, { volume }) {
    await docker(['rm', '-f', name]);
    await docker(['rm', '-f', relayOf(name)]);
    await docker(['network', 'rm', name]);
    if (volume) await docker(['volume', 'rm', '-f', name.replace(/^dn-/, 'dn-work-')]);
    known.delete(name);
    strays.delete(name);
  }

  // The container's network and the relay on it, made if missing and made again if the
  // relay is not running, is of another image, or leads to where an earlier daemon's
  // broker listened.
  async function ensureWayOut(name, tag) {
    const at = broker();
    if (!at) throw new Error('the broker is not listening, and a container has no other way out');
    const target = `${CONTAINER_HOST}:${at.port}`;
    let net = await network(name);
    if (!net) {
      let made;
      for (let attempt = 0; attempt < 8; attempt++) {
        made = await docker(['network', 'create', ...NETWORK_OPTIONS, '--subnet', subnetFor(name, attempt), '--label', `dn.base=${BASE_DIR}`, name]);
        // That /29 is another network's; the next one serves as well.
        if (made.code === 0 || !/overlaps/i.test(made.stderr)) break;
      }
      if (made.code !== 0) throw new Error(`docker network create: ${lastLine(made.stderr)}`);
      net = await network(name);
    }
    const relay = await inspect(relayOf(name));
    for (const [what, labels] of [['network', net && net.labels], ['relay', relay && relay.labels]]) {
      if (labels && labels['dn.base'] !== BASE_DIR) throw new Error(`a ${what} named for ${name} belongs to another daemon on this machine (${labels['dn.base'] || 'unlabelled'})`);
    }
    if (!net) throw new Error(`docker network inspect ${name}: no such network right after it was made`);
    if (net.gateway) {
      throw new Error(`the network ${name} carries an address of this machine (${net.gateway}), so a job on it would reach whatever this machine serves: this docker engine does not make an isolated network`);
    }
    if (relay && relay.running && relay.image === tag && relay.labels['dn.broker'] === target) return;
    if (relay) await docker(['rm', '-f', relayOf(name)]);
    const steps = [
      ['create', '--name', relayOf(name), '--label', `dn.relay=${name}`, '--label', `dn.broker=${target}`, '--label', `dn.base=${BASE_DIR}`,
        ...RELAY_LIMITS,
        '--network', name, '--network-alias', RELAY_HOST,
        // The name the broker is reached by; an address needs no entry.
        ...(/^[\d.]+$/.test(CONTAINER_HOST) ? [] : ['--add-host', `${CONTAINER_HOST}:host-gateway`]),
        tag, 'node', '/opt/dn/relay.mjs', net.subnet, String(at.port), CONTAINER_HOST, String(at.port)],
      // The relay's second network is its way to this machine; the job container is never on it.
      ['network', 'connect', 'bridge', relayOf(name)],
      ['start', relayOf(name)],
    ];
    for (const step of steps) {
      const r = await docker(step);
      if (r.code !== 0) throw new Error(`docker ${step[0]} for the relay of ${name}: ${lastLine(r.stderr)}`);
    }
    log('docker', `relay of ${name} leads to ${target}`);
  }

  async function create(name, tag, pool, peer) {
    const volume = name.replace(/^dn-/, 'dn-work-');
    const runsDir = runsDirOf(name);
    fs.mkdirSync(runsDir, { recursive: true });
    const made = await docker(['volume', 'create', '--label', `dn.base=${BASE_DIR}`, volume]);
    if (made.code !== 0) throw new Error(`docker volume create: ${lastLine(made.stderr)}`);
    const run = await docker(['run', '-d', '--init', '--name', name,
      '--label', `dn.pool=${pool.id}`, '--label', `dn.peer=${peer}`, '--label', `dn.base=${BASE_DIR}`,
      '--cap-drop=ALL', ...CAPABILITIES.map((c) => `--cap-add=${c}`),
      '--security-opt', 'no-new-privileges',
      '--pids-limit', String(CONTAINER_PIDS), '--memory', CONTAINER_MEMORY, '--cpus', CONTAINER_CPUS,
      '--network', name,
      // The work tree lives in a volume (a bind mount is an order of magnitude slower
      // under Docker Desktop); only this container's own run records are bound.
      '-v', `${volume}:/work`, '-v', `${runsDir}:/dn/runs`,
      tag, 'sleep', 'infinity']);
    if (run.code !== 0) throw new Error(`docker run: ${lastLine(run.stderr)}`);
    log('docker', `created ${name} for ${peer} on ${pool.id}`);
  }

  function acquire({ pool, peer, runId }) {
    const name = containerName(pool.id, peer);
    return serial(name, async () => {
      const tag = await ensureImage();
      let entry = known.get(name);
      let found = await inspect(name);
      if (found && found.labels['dn.base'] !== BASE_DIR) {
        throw new Error(`a container named ${name} belongs to another daemon on this machine (${found.labels['dn.base'] || 'unlabelled'})`);
      }
      const busy = !!entry && entry.jobs.size > 0;
      // A container from another image is replaced, but never from under a job: that
      // job's successors join it in the old image until it is idle.
      if (found && !busy && (found.image !== tag || !found.running || found.network !== name)) {
        await remove(name, { volume: false });
        found = null;
        entry = null;
      }
      if (busy && !(found && found.running)) throw new Error(`container ${name} is gone with ${entry.jobs.size} job(s) in it`);
      await ensureWayOut(name, found ? found.image : tag);
      if (!found) {
        await create(name, tag, pool, peer);
        entry = { name, image: tag, jobs: new Set(), lastUsed: now() };
      } else if (!entry) {
        // Left by an earlier daemon: whatever still runs in it belongs to no job.
        await docker(['restart', '-t', '0', name]);
        entry = { name, image: found.image, jobs: new Set(), lastUsed: now() };
      }
      strays.delete(name);
      known.set(name, entry);
      entry.jobs.add(runId);
      entry.lastUsed = now();
      return { name, image: entry.image, runsDir: runsDirOf(name) };
    });
  }

  // A job an earlier daemon started and this one took up again: its container is used as
  // it stands, the job in it still running.
  function adopt({ pool, peer, runId }) {
    const name = containerName(pool.id, peer);
    return serial(name, async () => {
      const found = await inspect(name);
      if (!found || !found.running || found.labels['dn.base'] !== BASE_DIR || found.network !== name) return null;
      await ensureWayOut(name, found.image);
      const entry = known.get(name) ?? { name, image: found.image, jobs: new Set(), lastUsed: now() };
      strays.delete(name);
      known.set(name, entry);
      entry.jobs.add(runId);
      entry.lastUsed = now();
      return { name, image: entry.image, runsDir: runsDirOf(name) };
    });
  }

  function release({ name, runId }) {
    const entry = known.get(name);
    if (!entry) return Promise.resolve();
    entry.jobs.delete(runId);
    entry.lastUsed = now();
    // A job can start a process that sheds its group and its environment, which no
    // stop of that job finds. With no job left there is nothing to spare.
    return serial(name, async () => {
      if (known.get(name) === entry && entry.jobs.size === 0) await docker(['restart', '-t', '0', name]);
    });
  }

  async function sweep() {
    const listed = await docker(['ps', '-a', '--filter', `label=dn.base=${BASE_DIR}`, '--format', '{{.Names}}']);
    if (listed.code !== 0) return;
    const names = listed.stdout.split('\n').map((l) => l.trim()).filter((n) => n && !n.endsWith('-relay'));
    // A network whose container is gone carries nothing, and neither does the relay on
    // it. Asked again in the container's turn: one may be on its way to that network.
    const networks = await docker(['network', 'ls', '--filter', `label=dn.base=${BASE_DIR}`, '--format', '{{.Name}}']);
    await Promise.all(networks.stdout.split('\n').map((l) => l.trim()).filter((n) => n && !names.includes(n)).map((name) => serial(name, async () => {
      if (!(await inspect(name))) await remove(name, { volume: false });
    })));
    // One an earlier daemon left is idle from the moment it is first seen.
    for (const name of names) if (!known.has(name) && !strays.has(name)) strays.set(name, now());
    await Promise.all(names.map((name) => serial(name, async () => {
      const entry = known.get(name);
      const since = entry ? entry.lastUsed : strays.get(name);
      if ((entry && entry.jobs.size > 0) || since === undefined || now() - since < CONTAINER_IDLE_MS) return;
      log('docker', `removing ${name}: idle for ${Math.round((now() - since) / 60000)} min`);
      await remove(name, { volume: true });
    })));
  }

  return {
    dockerState: () => state,
    ensureImage,
    acquire,
    adopt,
    release,
    sweep,
    list: () => [...known.values()].map((e) => ({ name: e.name, image: e.image, jobs: [...e.jobs], lastUsed: e.lastUsed })),
  };
}
