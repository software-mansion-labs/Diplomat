// The image every job runs in and the containers made from it: exactly one per
// requesting peer and repository, named dn-<pool part>-<peer part>, running that peer's
// jobs on that repository and nobody else's. It lasts as long as a job is in it: when
// its last job leaves it is removed with its relay, its network and its /work volume,
// and the pair's next job gets a new one from the image. Jobs that are in it at the
// same time share all of it; nothing a job wrote is there for a job that came after
// every job before it had left.
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
// Every container, volume and network carries dn.base=<BASE_DIR>, every listing asks
// for that label, and nothing without it is used or removed. It does not give two
// daemons on one engine (a test beside the real one) names of their own: a pair's names
// are the same under every base. A daemon that finds another's container, relay,
// network or volume under a pair's name leaves it as it is and starts no job of that
// pair - an OwnFault that says whose it is - until it is removed by hand.
//
// What a container may take of this machine: processes, memory without swap, CPUs, and
// CONTAINER_DISK_BYTES of disk. The engine holds the writable layer to that size where
// its storage can; `usage` measures the layer, the volume and the run records wherever
// it cannot, with the files its processes hold open under no name, and `overQuota`
// names the containers past it. The run records outlive the container, so they are
// measured under its name while any are kept.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  BASE_DIR, CONTAINER_CPUS, CONTAINER_DISK_BYTES, CONTAINER_HOST, CONTAINER_IDLE_MS, CONTAINER_MEMORY, CONTAINER_PIDS,
  CONTAINER_USAGE_TIMEOUT_MS, DOCKER_BIN, IMAGE_BUILD_TIMEOUT_MS, IMAGE_REPO, RELAY_HOST, RUNS_DIR,
} from '../paths.js';
import { OwnFault, own } from './own-fault.js';

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
// held.cjs, which counts what a container's processes hold in files with no name left.
const HELD = fs.readFileSync(new URL('./held.cjs', import.meta.url), 'utf8');
// A name the engine could not size this many passes of `overQuota` running counts as
// past its allowance: making a container unmeasurable does not make it unbounded. One
// miss is a busy engine; three is what a job is given before it is called gone.
export const UNMEASURED_PASSES = 3;
const RUN_ID = /^[A-Za-z0-9_-]{1,64}$/;

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

/// 128 bits of the hash in base 36: twenty-five characters, so a name with its longest
/// suffix stays inside the 63 a DNS label may have.
export const namePart = (s) => BigInt(`0x${crypto.createHash('sha256').update(s).digest('hex').slice(0, 32)}`).toString(36).padStart(25, '0');

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
  return `dn-${namePart(poolId)}-${namePart(peer)}`;
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
const OWN_LABEL = ['--label', `dn.base=${BASE_DIR}`];
const labelsFor = (pool, peer) => ['--label', `dn.pool=${pool.id}`, '--label', `dn.peer=${peer}`, ...OWN_LABEL];
const mine = (labels) => !!labels && labels['dn.base'] === BASE_DIR;

// One container's run records, the only part of RUNS_DIR it is shown: a single shared
// mount would let one peer's jobs read another's prompts and logs. No run id can spell
// the directory these live under. The records an earlier container of the name left are
// in directories beside it, <name>.<n>, which no container is shown.
const runsDirOf = (dir) => path.join(RUNS_DIR, '.containers', dir);
const ASIDE = /^(dn-[0-9a-z-]+)\.\d+$/;
// The container name a records directory is of.
const pairOf = (dir) => ASIDE.exec(dir)?.[1] ?? dir;

/// The image and the containers. `dockerState()` is the snapshot's `docker` member.
/// `ensureImage()` resolves to the tag once the image exists, building it if it must.
/// `acquire({ pool, peer, runId })` resolves to that pair's container `{ name, image,
/// runsDir }` with the job counted as running in it: the one its jobs are running in,
/// or, when none is, a new one made from the image after everything found under its
/// name was removed. It rejects with an OwnFault when the engine, the image, another
/// daemon's object under the name or the making of the new container is why; what
/// earlier jobs left and a container that went from under its jobs reject plainly, being
/// possibly those jobs' doing. `release({ name, runId })` ends the job's hold and, when
/// it was the last one, removes the container with its relay, its network and its volume
/// (it resolves once that is done): nothing a job left running or wrote is there for the
/// next one.
/// `adopt({ pool, peer, runId })` counts a job an earlier daemon started as running in
/// that pair's container and resolves to the container, or to null when it is not there
/// to be used; nothing in it is restarted.
/// `sweep()` removes what is under a name no job is counted in: at once what a removal
/// left, a network or a volume without a container, and the run records of a container
/// that is gone once no run among them is kept; a container no job of this daemon was
/// ever in once it has been seen for CONTAINER_IDLE_MS. And every image this daemon
/// built but the one jobs are started in, once no container is of it.
/// `broker()` is the broker's `address()`: where relays lead.
/// `restart`, `usage`, `overQuota`, `erase`, `discard` and `removeAll` are described where
/// they are defined. `imageDir` is the directory the image is built from.
export function createContainers({ log = () => {}, now = Date.now, imageDir = IMAGE_DIR, broker = () => null } = {}) {
  let state = { state: 'down', image: '', detail: 'not checked yet' };
  let building = null;
  let engine = ''; // the engine's version, as it last said it
  let unfit = null; // { version, detail }: an engine seen to make a job network that is not isolated
  let layerSized = true; // whether the engine is asked to hold a writable layer to a size
  let sight = null; // whether a probe of this engine reads what a container's processes hold open; null until one has said
  let unmeasured = new Map(); // name -> the passes of `overQuota` running that could not size it
  const known = new Map(); // name -> { name, image, jobs: Set, cut }
  const strays = new Map(); // a container no job of this daemon has used -> when it was first seen
  const queues = new Map(); // name -> the last operation on it
  const probes = new Map(); // name -> the last probe beside it
  const measuring = new Map(); // name -> the measurement of it under way

  const turns = (last) => (name, fn) => {
    const run = (last.get(name) || Promise.resolve()).then(fn);
    last.set(name, run.catch(() => {}));
    return run;
  };
  const serial = turns(queues);
  const probeTurn = turns(probes);

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
    const built = await docker(['build', '--progress', 'plain', ...OWN_LABEL, '-t', tag, imageDir], {
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
    throw new OwnFault(why);
  }

  // What the engine holds under a container's name, in the order it can be removed in -
  // a network goes after what is on it - each as `{ what, id, labels, rm }`, `rm` being
  // what removes it.
  async function under(name) {
    const there = [];
    for (const [what, id] of [['container', name], ['relay', relayOf(name)], ['probe', probeOf(name)]]) {
      const found = await inspect(id);
      if (found) there.push({ what, id, labels: found.labels, rm: ['rm', '-f', id] });
    }
    const net = await network(name);
    if (net) there.push({ what: 'network', id: name, labels: net.labels, rm: ['network', 'rm', name] });
    const held = await volumeLabels(volumeOf(name));
    // A volume takes as long to remove as its files take to delete.
    if (held) there.push({ what: 'volume', id: volumeOf(name), labels: held, rm: ['volume', 'rm', '-f', volumeOf(name)], timeout: CONTAINER_USAGE_TIMEOUT_MS });
    return there;
  }

  // Removes what of `there` is this daemon's; another daemon's object of the same name
  // stays. Resolves to what the engine would not remove, in words.
  async function remove(name, there) {
    const left = [];
    for (const { what, id, labels, rm, timeout } of there ?? await under(name)) {
      if (mine(labels) && (await docker(rm, { timeout })).code !== 0) left.push(`the ${what} ${id}`);
    }
    return left;
  }

  // Whether the engine says in so many words that it has no container `name`: an engine
  // that does not answer says nothing of the kind.
  async function absent(name) {
    const r = await docker(['container', 'inspect', '--format', '{{.Id}}', name]);
    return /no such container/i.test(r.stderr);
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

  // The records directories of `name`: the one its container is shown, when it is
  // there, and after it those moved aside.
  async function recordsOf(name) {
    const all = await fs.promises.readdir(path.join(RUNS_DIR, '.containers')).catch(() => []);
    return all.filter((dir) => pairOf(dir) === name).sort();
  }

  // What a container left among its run records is not for the next one of its name to
  // read: the directory is moved aside whole, by a rename this user can always do,
  // whoever owns what is in it. The links to its runs are led there first, each keeping
  // its age, which is what a run's records are kept by: a daemon that ended between the
  // two finds the directory still to be moved, to the same place.
  async function shelve(name) {
    const empty = await fs.promises.readdir(runsDirOf(name)).then((entries) => entries.length === 0, (e) => e.code === 'ENOENT');
    if (empty) return;
    const aside = `${name}.${Math.max(0, ...(await recordsOf(name)).map((dir) => Number(dir.slice(name.length + 1)))) + 1}`;
    for (const link of (await linked()).get(name) ?? []) {
      const { atime, mtime } = await fs.promises.lstat(link);
      await fs.promises.rm(`${link}.aside`, { force: true });
      await fs.promises.symlink(path.join('.containers', aside, path.basename(link)), `${link}.aside`);
      await fs.promises.lutimes(`${link}.aside`, atime, mtime);
      await fs.promises.rename(`${link}.aside`, link);
    }
    await fs.promises.rename(runsDirOf(name), runsDirOf(aside));
  }

  async function create(name, tag, pool, peer) {
    const volume = volumeOf(name);
    const runsDir = runsDirOf(name);
    await shelve(name);
    await fs.promises.mkdir(runsDir, { recursive: true });
    const made = await docker(['volume', 'create', ...labelsFor(pool, peer), volume]);
    if (made.code !== 0) throw new Error(`docker volume create: ${lastLine(made.stderr)}`);
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
      tag, '/usr/bin/sleep', 'infinity'];
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
      const tag = await own(ensureImage());
      let entry = known.get(name);
      // A job joins the jobs running in its pair's container, in the image they were
      // started in. One whose jobs were ended by a restart holds only what they left.
      if (entry && entry.jobs.size > 0 && !entry.cut) {
        const found = await inspect(name);
        if (found) claim('container', name, found.labels, pool, peer);
        if (!found || !found.running) throw new Error(`container ${name} is gone with ${entry.jobs.size} job(s) in it`);
        await ensureWayOut(name, found.image, pool, peer);
      } else {
        // Whatever stands under the name is of jobs that are over, or of an earlier
        // daemon: a container, its writable layer and its volume are what such a job
        // could write, so none of it is there when a job starts with no other beside it.
        const there = await under(name);
        // A probe carries no pair: it is this daemon's or it stays.
        for (const what of ['container', 'network', 'relay', 'volume']) {
          const held = there.find((o) => o.what === what);
          if (held) claim(what, held.id, held.labels, pool, peer);
        }
        const left = await remove(name, there);
        if (left.length > 0) throw new Error(`what earlier jobs left under ${name} could not be removed (${left.join(', ')}), and no job is started beside it`);
        await own(ensureWayOut(name, tag, pool, peer));
        await own(create(name, tag, pool, peer));
        entry = { name, image: tag, jobs: new Set(), cut: false };
      }
      strays.delete(name);
      known.set(name, entry);
      entry.jobs.add(runId);
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
      const entry = known.get(name) ?? { name, image: found.image, jobs: new Set(), cut: false };
      strays.delete(name);
      known.set(name, entry);
      entry.jobs.add(runId);
      return { name, image: entry.image, runsDir: runsDirOf(name) };
    });
  }

  function release({ name, runId }) {
    const entry = known.get(name);
    if (!entry) return Promise.resolve();
    entry.jobs.delete(runId);
    return serial(name, async () => {
      // A job that came meanwhile has a container of its own making under the name.
      if (known.get(name) !== entry || entry.jobs.size > 0) return;
      const left = await remove(name);
      // Still known, with no job in it: the next sweep removes it, and so does the next job.
      if (left.length > 0) return log('docker', `${name} has no job left in it and is still there: the engine would not remove ${left.join(', ')}`);
      known.delete(name);
      log('docker', `removed ${name} with its last job`);
    });
  }

  /// Restarts the container `name`, which ends every process in it, in its turn among
  /// whatever else is being done to that container. Resolves to whether the engine did.
  /// The jobs counted in it are over with that, so no later job joins them: the next one
  /// has the container made anew.
  function restart(name) {
    return serial(name, async () => {
      const done = (await docker(['restart', '-t', '0', name])).code === 0;
      const entry = known.get(name);
      if (done && entry) entry.cut = true;
      return done;
    });
  }

  const OWN = ['--filter', `label=dn.base=${BASE_DIR}`];
  const jobContainers = (names) => names.filter(isJobName);

  // The links RUNS_DIR holds to runs, which `startJob` makes and no job can reach, by the
  // records directory each leads into: directory -> the links. What is no link is
  // under no directory.
  async function linked() {
    const links = new Map();
    for (const runId of await fs.promises.readdir(RUNS_DIR).catch(() => [])) {
      const link = path.join(RUNS_DIR, runId);
      const [, name] = (await fs.promises.readlink(link).catch(() => '')).split(path.sep);
      links.set(name, [...(links.get(name) ?? []), link]);
    }
    return links;
  }

  async function sweep() {
    const listed = await docker(['ps', '-a', ...OWN, '--format', '{{.Names}}']);
    if (listed.code !== 0) return;
    const names = jobContainers(lines(listed.stdout));
    const networks = await docker(['network', 'ls', ...OWN, '--format', '{{.Name}}']);
    const volumes = await docker(['volume', 'ls', ...OWN, '--format', '{{.Name}}']);
    const others = [...lines(networks.stdout), ...lines(volumes.stdout).filter((v) => v.startsWith('dn-work-')).map((v) => v.replace(/^dn-work-/, 'dn-'))];
    // One an earlier daemon left is idle from the moment it is first seen.
    for (const name of names) if (!known.has(name) && !strays.has(name)) strays.set(name, now());
    // Each in the container's turn: one may be on its way to the name. A name with a job
    // counted in it is left to that job's release.
    await Promise.all(jobContainers([...new Set([...names, ...others])]).map((name) => serial(name, async () => {
      const entry = known.get(name);
      if (entry && entry.jobs.size > 0) return;
      const there = await under(name);
      // A container this daemon never put a job in may hold one an earlier daemon
      // started, which is taken up or stopped by its run directory: it is given time.
      if (!entry && there.some((o) => o.what === 'container')) {
        const since = strays.get(name);
        if (since === undefined || now() - since < CONTAINER_IDLE_MS) return;
        log('docker', `removing ${name}: no job of this daemon in it for ${Math.round((now() - since) / 60000)} min`);
      }
      if ((await remove(name, there)).length > 0) return;
      known.delete(name);
      strays.delete(name);
    })));
    // The run records of a container that is gone are forgotten run by run, by whoever
    // keeps the runs; what else a job left among them goes with the directory once no
    // run in it is kept. In the container's turn: a new one of that name binds the
    // directory the moment it is made. A directory that was moved aside is no
    // container's.
    const records = (await fs.promises.readdir(path.join(RUNS_DIR, '.containers')).catch(() => [])).filter((dir) => isJobName(pairOf(dir)));
    const kept = await linked();
    const shown = (dir) => dir === pairOf(dir);
    await Promise.all(records.filter((dir) => !(shown(dir) && names.includes(dir)) && !kept.has(dir)).map((dir) => serial(pairOf(dir), async () => {
      if (!(shown(dir) && known.has(dir)) && !(await wipe(dir, '', true))) log('docker', `the run records of ${pairOf(dir)} could not be removed: they are counted against its disk allowance until they are`);
    })));
    // An image this daemon built, once jobs are started in another: by its label and its
    // name both, since an image built on top of one carries the label too. The engine
    // refuses one a container is of, and it is asked for again at the next sweep.
    if (state.state !== 'ready') return;
    const images = await docker(['image', 'ls', ...OWN, '--format', '{{.Repository}}:{{.Tag}}']);
    for (const image of lines(images.stdout).filter((i) => i.startsWith(`${IMAGE_REPO}:`) && i !== state.image)) {
      if ((await docker(['image', 'rm', image])).code === 0) log('docker', `removed the image ${image}: jobs are started in ${state.image}`);
    }
  }

  // One run of the probe container beside `name`, on `image`: resolves to docker's
  // answer. In its turn among the probes of that name, which is one container's name.
  function probe(name, image, extra, command) {
    return probeTurn(name, async () => {
      const args = ['run', '--rm', '--name', probeOf(name), '--label', `dn.probe=${name}`, '--label', `dn.base=${BASE_DIR}`,
        ...PROBE_LIMITS, ...extra, image, ...command];
      let r = await docker(args, { timeout: CONTAINER_USAGE_TIMEOUT_MS });
      const left = async () => mine((await inspect(probeOf(name)))?.labels) && (await docker(['rm', '-f', probeOf(name)])).code === 0;
      // A probe cut off by an earlier timeout still holds the name.
      if (r.code !== 0 && /already in use/i.test(r.stderr) && await left()) r = await docker(args, { timeout: CONTAINER_USAGE_TIMEOUT_MS });
      if (r.code === null) await left();
      return r;
    });
  }

  // What the processes of the running container `name` hold of the disk in files that
  // have no name left, in bytes, counted by held.cjs from a probe in the container's pid
  // namespace; null when it could not be counted. The job can end that probe, which
  // counts nothing: its container is unmeasured for that. An engine whose first answer
  // is that a probe may not read another container's processes (SELinux keeps one
  // container's from another's) is asked no more, and on it such a file is not counted;
  // one that has counted before is not believed blind.
  async function holds(name, image) {
    if (sight === false) return 0;
    const r = await probe(name, image, ['--pid', `container:${name}`, '--cap-add=DAC_READ_SEARCH', '--cap-add=SYS_PTRACE'], ['node', '-e', HELD]);
    const said = r.stdout.trim();
    const [, bytes] = /^held (\d+)$/.exec(said) ?? [];
    if (bytes) {
      sight = true;
      return Number(bytes);
    }
    if (sight === null && said === 'blind') {
      sight = false;
      log('docker', 'this engine does not show a probe what a container\'s processes hold open: a file with no name left is not counted against a container\'s disk allowance');
      return 0;
    }
    log('docker', `what the processes of ${name} hold open could not be counted: ${lastLine(r.stderr) || said || 'no answer'}`);
    return null;
  }

  async function measure(name) {
    const found = await inspect(name, { size: true });
    if (found && (!mine(found.labels) || !Number.isFinite(found.layerBytes))) return null;
    const held = found?.running ? await holds(name, found.image) : 0;
    if (held === null) return null;
    const mounts = [];
    if (mine(await volumeLabels(volumeOf(name)))) mounts.push([volumeOf(name), '/v']);
    (await recordsOf(name)).forEach((dir, i) => mounts.push([runsDirOf(dir), `/r${i || ''}`]));
    if (mounts.length === 0) return found ? found.layerBytes + held : null;
    // The records of a container that is gone are measured from the image jobs are started in.
    const image = found ? found.image : state.image;
    const inside = mounts.map(([, at]) => at).join(' ');
    // Read-only, with no link followed and no file opened: what a job planted among its
    // files is counted as the entry it is. A file with holes counts for what it holds.
    const r = await probe(name, image, ['--cap-add=DAC_READ_SEARCH', ...mounts.flatMap(([from, at]) => ['-v', `${from}:${at}:ro`])],
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
    return (found ? found.layerBytes : 0) + held + blocks + inodes * INODE_BYTES;
  }

  /// What is held of this machine's disk under the container name `name`, in bytes: the
  /// container's writable layer and its /work volume while there is one, and the run
  /// records kept under the name, those of its earlier containers too, with 4096 bytes
  /// for every file and directory in the last two so that empty files are not free; and
  /// while the container runs, the files its processes hold open that have no name left.
  /// Null when nothing of this daemon is under the name or the engine could not say.
  function usage(name) {
    if (!isJobName(name)) return Promise.resolve(null);
    if (!measuring.has(name)) measuring.set(name, measure(name).finally(() => measuring.delete(name)));
    return measuring.get(name);
  }

  /// Every name of this daemon - a container, or the run records one left - under which
  /// more than CONTAINER_DISK_BYTES is held, as `[{ name, bytes, jobs }]`: `jobs` are the
  /// run ids counted as running in it. A name the engine could not size
  /// UNMEASURED_PASSES calls running is among them, with `bytes` null. Its jobs are to
  /// be stopped and the name given to `discard`.
  async function overQuota() {
    const listed = await docker(['ps', '-a', ...OWN, '--format', '{{.Names}}']);
    if (listed.code !== 0) return [];
    const records = await fs.promises.readdir(path.join(RUNS_DIR, '.containers')).catch(() => []);
    const over = [];
    const missed = new Map();
    for (const name of new Set(jobContainers([...lines(listed.stdout), ...records.map(pairOf)]))) {
      const bytes = await usage(name);
      if (bytes === null) missed.set(name, (unmeasured.get(name) ?? 0) + 1);
      if (bytes > CONTAINER_DISK_BYTES || missed.get(name) >= UNMEASURED_PASSES) over.push({ name, bytes, jobs: [...(known.get(name)?.jobs ?? [])] });
    }
    // A name that was sized, or is not there any more, starts from nothing.
    unmeasured = missed;
    return over;
  }

  // Removes the run records in the directory `dir`, or the run `runId`'s among them;
  // resolves to whether they are gone. As this user only when no container is shown the
  // directory (`alone`): a job in one could move what is being walked and lead the walk
  // elsewhere. Otherwise, and where this user may not (root's files in a bind mount on
  // Linux), through the probe, where a link leads nowhere but into the probe's read-only
  // root. The probe mounts the records' directory, which no job can replace, never a
  // path in it.
  async function wipe(dir, runId, alone) {
    const target = path.join(runsDirOf(dir), runId);
    const own = () => fs.promises.rm(target, { recursive: true, force: true });
    const engine = () => probe(pairOf(dir), state.image, ['--cap-add=DAC_OVERRIDE', '--cap-add=FOWNER', '-v', `${runsDirOf(dir)}:/r`],
      ['find', path.posix.join('/r', runId), ...(runId ? [] : ['-mindepth', '1']), '-delete']);
    await (alone ? own().catch(async () => { await engine(); await own(); }) : engine())
      .catch((e) => log('docker', `the run records ${target} could not be removed: ${e.message}`));
    return fs.promises.lstat(target).then(() => false, (e) => e.code === 'ENOENT');
  }

  /// Removes the records of the run `runId` in the records directory `dir` - a
  /// container's name, or the name its link leads into once they were moved aside -
  /// with everything in them, in that container's turn. Resolves to whether they are
  /// gone: what could not be removed is still there to be counted, and to be tried again.
  function erase(dir, runId) {
    const name = pairOf(dir);
    if (!isJobName(name) || !RUN_ID.test(runId)) return Promise.resolve(false);
    return serial(name, async () => wipe(dir, runId, dir !== name || await absent(name)));
  }

  /// Removes the container `name` with its relay, its network, its volume and its run
  /// records, those of its earlier containers among them (the links to them in RUNS_DIR
  /// too); a name that has only run records left loses those. Rejects while a job is
  /// still counted as running in it - its jobs are stopped and released first - and when
  /// something of it could not be removed, with the links left in place.
  function discard(name) {
    if (!isJobName(name)) return Promise.reject(new Error(`not a container's name: ${name}`));
    return serial(name, async () => {
      const entry = known.get(name);
      if (entry && entry.jobs.size > 0) throw new Error(`container ${name} still has ${entry.jobs.size} job(s) in it`);
      const there = await under(name);
      const theirs = there.find((o) => o.what === 'container' && !mine(o.labels));
      if (theirs) throw new Error(`the container ${name} belongs to another daemon on this machine (${theirs.labels['dn.base'] || 'unlabelled'})`);
      const left = await remove(name, there);
      if (left.length > 0 || !(await absent(name))) throw new Error(`${name} could not be removed: ${left.join(', ') || 'the engine does not say that it is gone'}`);
      known.delete(name);
      strays.delete(name);
      const dirs = [...new Set([name, ...await recordsOf(name)])];
      for (const dir of dirs) if (!(await wipe(dir, '', true))) throw new Error(`the run records of ${name} could not be removed`);
      const links = await linked();
      for (const link of dirs.flatMap((dir) => links.get(dir) ?? [])) await fs.promises.unlink(link).catch(() => {});
      log('docker', `discarded ${name}`);
    });
  }

  /// Removes every container (job, relay and probe), network and volume labelled with
  /// this daemon's dn.base, whatever runs in them, and nothing else on the engine.
  /// Resolves to what went: `{ containers, networks, volumes }`, each a list of names,
  /// all empty on a machine with no docker. Rejects with what the engine said: at once
  /// when it would not list, and with the first it would not remove once the rest was
  /// tried.
  /// For a daemon that is switched off, with no job being started.
  async function removeAll() {
    await Promise.all([...queues.values()]);
    const gone = { containers: [], networks: [], volumes: [] };
    const failed = [];
    const each = async (kind, list, rm) => {
      const listed = await docker(list);
      if (listed.stderr === 'ENOENT') return;
      if (listed.code !== 0) throw new Error(`the ${kind} could not be listed: ${lastLine(listed.stderr) || 'no answer'}`);
      for (const name of lines(listed.stdout)) {
        const removed = await docker([...rm, name]);
        if (removed.code === 0) gone[kind].push(name);
        else failed.push(`${name} could not be removed: ${lastLine(removed.stderr) || 'no answer'}`);
      }
    };
    await each('containers', ['ps', '-a', ...OWN, '--format', '{{.Names}}'], ['rm', '-f']);
    await each('networks', ['network', 'ls', ...OWN, '--format', '{{.Name}}'], ['network', 'rm']);
    await each('volumes', ['volume', 'ls', ...OWN, '--format', '{{.Name}}'], ['volume', 'rm', '-f']);
    known.clear();
    strays.clear();
    log('docker', `removed ${gone.containers.length} container(s), ${gone.networks.length} network(s) and ${gone.volumes.length} volume(s)`);
    if (failed.length > 0) throw new Error(failed[0]);
    return gone;
  }

  return {
    dockerState: () => state,
    ensureImage,
    acquire,
    adopt,
    release,
    restart,
    sweep,
    usage,
    overQuota,
    erase,
    discard,
    removeAll,
    list: () => [...known.values()].map((e) => ({ name: e.name, image: e.image, jobs: [...e.jobs] })),
  };
}
