// The image every job runs in and the containers made from it: exactly one per
// requesting peer and repository, named dn-<pool hash>-<peer hash>, running many of that
// peer's jobs on that repository and nobody else's, and nothing at all between jobs.
// Every container, volume and docker query carries dn.base=<BASE_DIR>, so two daemons on
// one machine (a test beside the real one) never see each other's.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  BASE_DIR, CONTAINER_CPUS, CONTAINER_HOST, CONTAINER_IDLE_MS, CONTAINER_MEMORY, CONTAINER_PIDS, DOCKER_BIN,
  IMAGE_BUILD_TIMEOUT_MS, IMAGE_REPO, RUNS_DIR,
} from '../paths.js';

/// The directory the image is built from.
export const IMAGE_DIR = fileURLToPath(new URL('../../image/', import.meta.url));

// What root keeps inside a container: enough for apt-get and for owning files, and
// nothing that reaches outside it. Measured: without any one of these `apt-get install`
// fails.
const CAPABILITIES = ['CHOWN', 'DAC_OVERRIDE', 'FOWNER', 'FSETID', 'SETGID', 'SETUID'];

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
/// `sweep()` removes every container that has run nothing for CONTAINER_IDLE_MS.
/// `imageDir` is the directory the image is built from.
export function createContainers({ log = () => {}, now = Date.now, imageDir = IMAGE_DIR } = {}) {
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
      return { running: c.State.Running === true, image: c.Config.Image, labels: c.Config.Labels || {} };
    } catch { return null; }
  }

  async function remove(name, { volume }) {
    await docker(['rm', '-f', name]);
    if (volume) await docker(['volume', 'rm', '-f', name.replace(/^dn-/, 'dn-work-')]);
    known.delete(name);
    strays.delete(name);
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
      // The name the broker is reached by; an address needs no entry.
      ...(/^[\d.]+$/.test(CONTAINER_HOST) ? [] : ['--add-host', `${CONTAINER_HOST}:host-gateway`]),
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
      if (found && !busy && (found.image !== tag || !found.running)) {
        await remove(name, { volume: false });
        found = null;
        entry = null;
      }
      if (busy && !(found && found.running)) throw new Error(`container ${name} is gone with ${entry.jobs.size} job(s) in it`);
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
    const names = listed.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
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
    release,
    sweep,
    list: () => [...known.values()].map((e) => ({ name: e.name, image: e.image, jobs: [...e.jobs], lastUsed: e.lastUsed })),
  };
}
