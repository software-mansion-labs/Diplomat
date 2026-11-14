// The image every job runs in and the containers made from it: exactly one per
// requesting peer and repository, named dn-<pool part>-<peer part>, running many of that
// peer's jobs on that repository and nobody else's, and nothing at all between jobs.
//
// Each part of the name is 128 bits of a SHA-256, so no peer can make a key whose name
// is another peer's. And a name alone makes nothing a pair's own: the container, its
// relay, its network and its volume each carry dn.pool and dn.peer in full, and one
// found under a pair's name with other labels is refused and left as it is.
//
// A job container is attached to one network, an internal one of its own with the same
// name: no route leads out of it, to the internet, to this machine, or to another
// peer's container. The only other thing on that network is the container's relay,
// <name>-relay: the same image running image/relay.mjs, which carries TCP from that
// network to the broker's port and to nothing else. No job runs in a relay.
//
// Every container, volume, network and docker query carries dn.base=<BASE_DIR>, so two
// daemons on one machine (a test beside the real one) never see each other's, and
// nothing without that label is ever removed.
//
// What a container may take of this machine: processes, memory without swap, CPUs, and
// CONTAINER_DISK_BYTES of disk. The engine holds the writable layer to that size where
// its storage can; `usage` measures the layer, the volume and the run records wherever
// it cannot, and `overQuota` names the containers past it.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  BASE_DIR, CONTAINER_CPUS, CONTAINER_DISK_BYTES, CONTAINER_HOST, CONTAINER_IDLE_MS, CONTAINER_MEMORY, CONTAINER_PIDS,
  CONTAINER_USAGE_TIMEOUT_MS, DOCKER_BIN, IMAGE_BUILD_TIMEOUT_MS, IMAGE_REPO, RELAY_HOST, RUNS_DIR,
} from '../paths.js';

/// The directory the image is built from.
export const IMAGE_DIR = fileURLToPath(new URL('../../image/', import.meta.url));

// What root keeps inside a container: enough for apt-get and for owning files, and
// nothing that reaches outside it. Measured: without any one of these `apt-get install`
// fails.
const CAPABILITIES = ['CHOWN', 'DAC_OVERRIDE', 'FOWNER', 'FSETID', 'SETGID', 'SETUID'];

// A relay runs one small program that needs no privilege, no writable file and no user.
const RELAY_LIMITS = ['--cap-drop=ALL', '--security-opt', 'no-new-privileges', '--read-only', '--user', '65534:65534',
  '--pids-limit', '64', '--memory', '256m', '--memory-swap', '256m', '--cpus', '1'];

// What measures or clears a container's files: a throwaway container of the same image
// with no network and no way to write its own root, and as root with the one or two
// capabilities that let it pass a directory the job gave to another user. The job
// container's own tools are the job's to replace, and the daemon's user cannot enter a
// directory root made in a bind mount on Linux.
const PROBE_LIMITS = ['--network', 'none', '--read-only', '--cap-drop=ALL', '--security-opt', 'no-new-privileges',
  '--pids-limit', '64', '--memory', '256m', '--memory-swap', '256m', '--cpus', '1'];
const INODE_BYTES = 4096;

// The isolated gateway mode a job network is made with came in this release.
const ENGINE_FLOOR = [27, 1];
const ENGINE_NEEDED = `Docker ${ENGINE_FLOOR.join('.')} or later`;
function belowFloor(version) {
  const m = /^(\d+)\.(\d+)/.exec(version);
  return !!m && (Number(m[1]) < ENGINE_FLOOR[0] || (Number(m[1]) === ENGINE_FLOOR[0] && Number(m[2]) < ENGINE_FLOOR[1]));
}

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

// 128 bits of the hash in base 36: twenty-five characters, so a name with its longest
// suffix stays inside the 63 a DNS label may have.
const part = (s) => BigInt(`0x${crypto.createHash('sha256').update(s).digest('hex').slice(0, 32)}`).toString(36).padStart(25, '0');

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
  return `dn-${part(poolId)}-${part(peer)}`;
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

// The last thing docker said, its pointer to its own help apart.
const lastLine = (s) => s.split('\n').map((l) => l.trim()).filter((l) => l && !/^Run 'docker .*--help' for more information/.test(l)).pop() || '';
const relayOf = (name) => `${name}-relay`;
const probeOf = (name) => `${name}-probe`;
const volumeOf = (name) => name.replace(/^dn-/, 'dn-work-');
const lines = (stdout) => stdout.split('\n').map((l) => l.trim()).filter(Boolean);
// A job container's name, by its shape: no relay, no probe, nothing docker reads as an option.
const isJobName = (name) => /^dn-[0-9a-z-]+$/.test(name) && !/-(relay|probe)$/.test(name);
const labelsFor = (pool, peer) => ['--label', `dn.pool=${pool.id}`, '--label', `dn.peer=${peer}`, '--label', `dn.base=${BASE_DIR}`];
const mine = (labels) => !!labels && labels['dn.base'] === BASE_DIR;

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
/// relay, network and volume, and any network or volume whose container is gone.
/// `broker()` is the broker's `address()`: where relays lead.
/// `usage`, `overQuota`, `discard` and `removeAll` are described where they are defined.
/// `imageDir` is the directory the image is built from.
export function createContainers({ log = () => {}, now = Date.now, imageDir = IMAGE_DIR, broker = () => null } = {}) {
  let state = { state: 'down', image: '', detail: 'not checked yet' };
  let building = null;
  let engine = ''; // the engine's version, as it last said it
  let unfit = null; // { version, detail }: an engine seen to make a job network that is not isolated
  let layerSized = true; // whether the engine is asked to hold a writable layer to a size
  const known = new Map(); // name -> { name, image, jobs: Set, lastUsed }
  const strays = new Map(); // a container no job of this daemon has used -> when it was first seen
  const queues = new Map(); // name -> the last operation on it
  const measuring = new Map(); // name -> the measurement of it under way

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

  // An engine that put an address of this machine on a job's network, or would not take
  // the option that keeps it off, is not used again until it is another engine.
  function notIsolating(why, message) {
    unfit = { version: engine, detail: `this docker engine${engine ? ` (${engine})` : ''} does not make a network without an address of this machine on it, and a job on such a network would reach whatever this machine serves: it takes ${ENGINE_NEEDED} (${why})` };
    return fail({ state: 'failed', image: '', detail: unfit.detail }, message);
  }

  async function build(tag) {
    const version = await docker(['version', '--format', '{{.Server.Version}}'], { timeout: 20000 });
    if (version.stderr === 'ENOENT') throw fail({ state: 'missing', image: '', detail: `${DOCKER_BIN} not found: every job runs in a container` });
    if (version.code !== 0) throw fail({ state: 'down', image: '', detail: `the docker engine is not answering (${lastLine(version.stderr) || 'no reply'})` });
    engine = version.stdout.trim();
    if (unfit && unfit.version !== engine) unfit = null;
    if (belowFloor(engine)) throw fail({ state: 'failed', image: '', detail: `this docker engine is ${engine}: a job's network must carry no address of this machine, which takes ${ENGINE_NEEDED}` });
    if (unfit) throw fail({ state: 'failed', image: '', detail: unfit.detail });
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

  async function inspect(name, { size = false } = {}) {
    const r = await docker(['container', 'inspect', ...(size ? ['--size'] : []), '--format', '{{json .}}', name]);
    if (r.code !== 0) return null;
    try {
      const c = JSON.parse(r.stdout);
      return { running: c.State.Running === true, image: c.Config.Image, labels: c.Config.Labels || {}, network: c.HostConfig.NetworkMode, layerBytes: size ? c.SizeRw : undefined };
    } catch { return null; }
  }

  async function network(name) {
    const r = await docker(['network', 'inspect', '--format', '{{json .}}', name]);
    if (r.code !== 0) return null;
    try {
      const n = JSON.parse(r.stdout);
      return { labels: n.Labels || {}, internal: n.Internal === true, subnet: n.IPAM.Config[0].Subnet, gateway: n.IPAM.Config[0].Gateway || '' };
    } catch { return null; }
  }

  // A volume's labels, or null when there is no such volume.
  async function volumeLabels(name) {
    const r = await docker(['volume', 'inspect', '--format', '{{json .Labels}}', name]);
    if (r.code !== 0) return null;
    try { return JSON.parse(r.stdout) || {}; } catch { return {}; }
  }

  // Something found under one of a pair's names is that pair's only by its labels. What
  // is not is left exactly as it is: it is another daemon's, or nobody this daemon knows.
  function claim(what, name, labels, pool, peer) {
    let why = '';
    if (!mine(labels)) why = `the ${what} ${name} belongs to another daemon on this machine (${labels['dn.base'] || 'unlabelled'})`;
    else if (labels['dn.pool'] !== pool.id || labels['dn.peer'] !== peer) {
      why = `the ${what} ${name} is labelled for ${labels['dn.peer'] || 'no peer'} on ${labels['dn.pool'] || 'no repository'}, not for ${peer} on ${pool.id}: it is left as it is and not used`;
    }
    if (!why) return;
    log('docker', why);
    throw new Error(why);
  }

  // Everything under a container's name that is this daemon's; another daemon's object
  // of the same name stays.
  async function remove(name, { volume }) {
    for (const c of [name, relayOf(name), probeOf(name)]) {
      if (mine((await inspect(c))?.labels)) await docker(['rm', '-f', c]);
    }
    if (mine((await network(name))?.labels)) await docker(['network', 'rm', name]);
    if (volume && mine(await volumeLabels(volumeOf(name)))) await docker(['volume', 'rm', '-f', volumeOf(name)]);
    known.delete(name);
    strays.delete(name);
  }

  // The container's network and the relay on it, made if missing and made again if the
  // relay is not running, is of another image, or leads to where an earlier daemon's
  // broker listened.
  async function ensureWayOut(name, tag, pool, peer) {
    const at = broker();
    if (!at) throw new Error('the broker is not listening, and a container has no other way out');
    const target = `${CONTAINER_HOST}:${at.port}`;
    let net = await network(name);
    const fresh = !net;
    if (!net) {
      let made;
      for (let attempt = 0; attempt < 8; attempt++) {
        made = await docker(['network', 'create', ...NETWORK_OPTIONS, '--subnet', subnetFor(name, attempt), ...labelsFor(pool, peer), name]);
        // That /29 is another network's; the next one serves as well.
        if (made.code === 0 || !/overlaps/i.test(made.stderr)) break;
      }
      if (made.code !== 0 && /gateway[_ ]mode/i.test(made.stderr)) {
        throw notIsolating(lastLine(made.stderr), `docker network create: ${lastLine(made.stderr)}`);
      }
      if (made.code !== 0) throw new Error(`docker network create: ${lastLine(made.stderr)}`);
      net = await network(name);
      if (!net) throw new Error(`docker network inspect ${name}: no such network right after it was made`);
    }
    claim('network', name, net.labels, pool, peer);
    const relay = await inspect(relayOf(name));
    if (relay) claim('relay', relayOf(name), relay.labels, pool, peer);
    if (!net.internal) throw new Error(`the network ${name} is not an internal one: a job on it would have a route out`);
    if (net.gateway) {
      const said = `the network ${name} carries an address of this machine (${net.gateway})`;
      // One found that way says nothing of the engine that runs today.
      if (!fresh) throw new Error(`${said}, so a job on it would reach whatever this machine serves`);
      await docker(['network', 'rm', name]);
      throw notIsolating(said, `${said}, so a job on it would reach whatever this machine serves: this docker engine does not make an isolated network`);
    }
    if (relay && relay.running && relay.image === tag && relay.labels['dn.relay'] === name && relay.labels['dn.broker'] === target) return;
    if (relay) await docker(['rm', '-f', relayOf(name)]);
    const steps = [
      ['create', '--name', relayOf(name), '--label', `dn.relay=${name}`, '--label', `dn.broker=${target}`, ...labelsFor(pool, peer),
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
    const volume = volumeOf(name);
    const runsDir = runsDirOf(name);
    fs.mkdirSync(runsDir, { recursive: true });
    // `docker volume create` answers with a volume that is already there, whoever made it.
    const held = await volumeLabels(volume);
    if (held) claim('volume', volume, held, pool, peer);
    else {
      const made = await docker(['volume', 'create', ...labelsFor(pool, peer), volume]);
      if (made.code !== 0) throw new Error(`docker volume create: ${lastLine(made.stderr)}`);
    }
    const args = (sized) => ['run', '-d', '--init', '--name', name, ...labelsFor(pool, peer),
      '--cap-drop=ALL', ...CAPABILITIES.map((c) => `--cap-add=${c}`),
      '--security-opt', 'no-new-privileges',
      // Swap set to the memory itself is no swap: the memory limit is all it gets.
      '--pids-limit', String(CONTAINER_PIDS), '--memory', CONTAINER_MEMORY, '--memory-swap', CONTAINER_MEMORY, '--cpus', CONTAINER_CPUS,
      ...(sized ? ['--storage-opt', `size=${CONTAINER_DISK_BYTES}`] : []),
      '--network', name,
      // The work tree lives in a volume (a bind mount is an order of magnitude slower
      // under Docker Desktop); only this container's own run records are bound.
      '-v', `${volume}:/work`, '-v', `${runsDir}:/dn/runs`,
      tag, 'sleep', 'infinity'];
    let run = await docker(args(layerSized));
    // Only some storage (overlay on xfs with project quotas, btrfs, zfs) can hold a
    // layer to a size. Where it cannot, `usage` is the bound.
    if (run.code !== 0 && layerSized && /storage[- ]opt|pquota/i.test(run.stderr)) {
      layerSized = false;
      log('docker', `this engine sets no size on a container's writable layer (${lastLine(run.stderr)}): disk use is measured instead`);
      run = await docker(args(false));
    }
    if (run.code !== 0) throw new Error(`docker run: ${lastLine(run.stderr)}`);
    log('docker', `created ${name} for ${peer} on ${pool.id}`);
  }

  function acquire({ pool, peer, runId }) {
    const name = containerName(pool.id, peer);
    return serial(name, async () => {
      const tag = await ensureImage();
      let entry = known.get(name);
      let found = await inspect(name);
      if (found) claim('container', name, found.labels, pool, peer);
      const busy = !!entry && entry.jobs.size > 0;
      // A container from another image is replaced, but never from under a job: that
      // job's successors join it in the old image until it is idle.
      if (found && !busy && (found.image !== tag || !found.running || found.network !== name)) {
        await remove(name, { volume: false });
        found = null;
        entry = null;
      }
      if (busy && !(found && found.running)) throw new Error(`container ${name} is gone with ${entry.jobs.size} job(s) in it`);
      await ensureWayOut(name, found ? found.image : tag, pool, peer);
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
      if (!found || !found.running || found.network !== name) return null;
      try { claim('container', name, found.labels, pool, peer); } catch { return null; }
      await ensureWayOut(name, found.image, pool, peer);
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

  const OWN = ['--filter', `label=dn.base=${BASE_DIR}`];
  const jobContainers = (names) => names.filter(isJobName);

  async function sweep() {
    const listed = await docker(['ps', '-a', ...OWN, '--format', '{{.Names}}']);
    if (listed.code !== 0) return;
    const names = jobContainers(lines(listed.stdout));
    // A network whose container is gone carries nothing, and neither does the relay on
    // it; a volume whose container is gone holds a cache nobody reads. Asked again in
    // the container's turn: one may be on its way to them.
    const networks = await docker(['network', 'ls', ...OWN, '--format', '{{.Name}}']);
    await Promise.all(lines(networks.stdout).filter((n) => !names.includes(n)).map((name) => serial(name, async () => {
      if (!(await inspect(name))) await remove(name, { volume: false });
    })));
    const volumes = await docker(['volume', 'ls', ...OWN, '--format', '{{.Name}}']);
    const orphans = lines(volumes.stdout).filter((v) => v.startsWith('dn-work-')).map((v) => v.replace(/^dn-work-/, 'dn-')).filter((n) => !names.includes(n));
    await Promise.all(orphans.map((name) => serial(name, async () => {
      if (!known.get(name)?.jobs.size && !(await inspect(name))) await remove(name, { volume: true });
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

  // One run of the probe container beside `name`, on `image`: resolves to docker's answer.
  async function probe(name, image, extra, command) {
    const args = ['run', '--rm', '--name', probeOf(name), '--label', `dn.probe=${name}`, '--label', `dn.base=${BASE_DIR}`,
      ...PROBE_LIMITS, ...extra, image, ...command];
    let r = await docker(args, { timeout: CONTAINER_USAGE_TIMEOUT_MS });
    const left = async () => mine((await inspect(probeOf(name)))?.labels) && (await docker(['rm', '-f', probeOf(name)])).code === 0;
    // A probe cut off by an earlier timeout still holds the name.
    if (r.code !== 0 && /already in use/i.test(r.stderr) && await left()) r = await docker(args, { timeout: CONTAINER_USAGE_TIMEOUT_MS });
    if (r.code === null) await left();
    return r;
  }

  async function measure(name) {
    const found = await inspect(name, { size: true });
    if (!found || !mine(found.labels) || !Number.isFinite(found.layerBytes)) return null;
    const mounts = [];
    if (mine(await volumeLabels(volumeOf(name)))) mounts.push([volumeOf(name), '/v']);
    if (fs.existsSync(runsDirOf(name))) mounts.push([runsDirOf(name), '/r']);
    if (mounts.length === 0) return found.layerBytes;
    const inside = mounts.map(([, at]) => at).join(' ');
    const r = await probe(name, found.image, ['--cap-add=DAC_READ_SEARCH', ...mounts.flatMap(([from, at]) => ['-v', `${from}:${at}:ro`])],
      // du's own exit status says only that a file went away while it counted, which
      // under a running job is the usual case: the two totals are what is read.
      ['sh', '-c', `du -sxB1 ${inside}; du -sx --inodes ${inside}`]);
    const counts = lines(r.stdout).map((l) => Number(l.split(/\s/)[0]));
    if (r.code === null || counts.length !== 2 * mounts.length || !counts.every(Number.isFinite)) {
      log('docker', `the disk use of ${name} could not be measured: ${lastLine(r.stderr) || 'no answer'}`);
      return null;
    }
    const blocks = counts.slice(0, mounts.length).reduce((a, b) => a + b, 0);
    const inodes = counts.slice(mounts.length).reduce((a, b) => a + b, 0);
    return found.layerBytes + blocks + inodes * INODE_BYTES;
  }

  /// What the container `name` holds of this machine's disk, in bytes: its writable
  /// layer, its /work volume and its run records, with 4096 bytes for every file and
  /// directory in the last two so that empty files are not free. Null when it is not a
  /// container of this daemon or the engine could not say.
  function usage(name) {
    if (!isJobName(name)) return Promise.resolve(null);
    if (!measuring.has(name)) measuring.set(name, measure(name).finally(() => measuring.delete(name)));
    return measuring.get(name);
  }

  /// Every container of this daemon that holds more than CONTAINER_DISK_BYTES, as
  /// `[{ name, bytes, jobs }]`: `jobs` are the run ids counted as running in it. Its
  /// jobs are to be stopped and the container given to `discard`.
  async function overQuota() {
    const listed = await docker(['ps', '-a', ...OWN, '--format', '{{.Names}}']);
    if (listed.code !== 0) return [];
    const over = [];
    for (const name of jobContainers(lines(listed.stdout))) {
      const bytes = await usage(name);
      if (bytes !== null && bytes > CONTAINER_DISK_BYTES) over.push({ name, bytes, jobs: [...(known.get(name)?.jobs ?? [])] });
    }
    return over;
  }

  /// Removes the container `name` with its relay, its network, its volume and its run
  /// records (the links to them in RUNS_DIR too). Rejects while a job is still counted
  /// as running in it: its jobs are stopped and released first.
  function discard(name) {
    if (!isJobName(name)) return Promise.reject(new Error(`not a container's name: ${name}`));
    return serial(name, async () => {
      const entry = known.get(name);
      if (entry && entry.jobs.size > 0) throw new Error(`container ${name} still has ${entry.jobs.size} job(s) in it`);
      const found = await inspect(name);
      if (found && !mine(found.labels)) throw new Error(`the container ${name} belongs to another daemon on this machine (${found.labels['dn.base'] || 'unlabelled'})`);
      const image = found ? found.image : state.image;
      await remove(name, { volume: true });
      const records = runsDirOf(name);
      const clear = () => fs.promises.rm(records, { recursive: true, force: true });
      await clear().catch(async () => {
        // What root made in a bind mount on Linux is not this user's to delete: the
        // engine empties the directory first.
        if (image) await probe(name, image, ['--cap-add=DAC_OVERRIDE', '--cap-add=FOWNER', '-v', `${records}:/r`], ['find', '/r', '-mindepth', '1', '-delete']);
        await clear();
      }).catch((e) => log('docker', `the run records of ${name} could not be removed: ${e.message}`));
      for (const entryName of await fs.promises.readdir(RUNS_DIR).catch(() => [])) {
        const link = path.join(RUNS_DIR, entryName);
        try {
          if (fs.readlinkSync(link).startsWith(`${path.join('.containers', name)}${path.sep}`)) fs.unlinkSync(link);
        } catch {}
      }
      log('docker', `discarded ${name}`);
    });
  }

  /// Removes every container (job, relay and probe), network and volume labelled with
  /// this daemon's dn.base, whatever runs in them, and nothing else on the engine.
  /// Resolves to what went: `{ containers, networks, volumes }`, each a list of names.
  /// For a daemon that is switched off, with no job being started.
  async function removeAll() {
    await Promise.all([...queues.values()]);
    const gone = { containers: [], networks: [], volumes: [] };
    const each = async (kind, list, rm) => {
      const listed = await docker(list);
      for (const name of lines(listed.stdout)) if ((await docker([...rm, name])).code === 0) gone[kind].push(name);
    };
    await each('containers', ['ps', '-a', ...OWN, '--format', '{{.Names}}'], ['rm', '-f']);
    await each('networks', ['network', 'ls', ...OWN, '--format', '{{.Name}}'], ['network', 'rm']);
    await each('volumes', ['volume', 'ls', ...OWN, '--format', '{{.Name}}'], ['volume', 'rm', '-f']);
    known.clear();
    strays.clear();
    log('docker', `removed ${gone.containers.length} container(s), ${gone.networks.length} network(s) and ${gone.volumes.length} volume(s)`);
    return gone;
  }

  return {
    dockerState: () => state,
    ensureImage,
    acquire,
    adopt,
    release,
    sweep,
    usage,
    overQuota,
    discard,
    removeAll,
    list: () => [...known.values()].map((e) => ({ name: e.name, image: e.image, jobs: [...e.jobs], lastUsed: e.lastUsed })),
  };
}
