// The bare mirror a container clones from. A job's `git clone https://<forge>/<o>/<r>.git`
// never reaches the forge: the broker answers it from MIRRORS_DIR/<pool hash>.git, which
// this machine keeps current with its own git credentials. That is the only place those
// credentials are used, and it is on the host.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { GIT_BIN, MIRRORS_DIR, MIRROR_TIMEOUT_MS } from '../paths.js';

/// The sixteen hex digits a pool's mirror is named by.
export function poolHash(id) {
  return crypto.createHash('sha256').update(id).digest('hex').slice(0, 16);
}

/// `host/owner/repo` in lowercase for any spelling of a remote URL, or null.
export function remoteSlug(url) {
  const m = /^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?([^:/]+)(?::\d+)?[:/](.+?)(?:\.git)?\/?$/i.exec(String(url).trim());
  return m ? `${m[1]}/${m[2]}`.toLowerCase() : null;
}

function git(args, { cwd, timeout = MIRROR_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    // The operator's git as they use it, minus anything that would wait for a person.
    const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND || 'ssh -o BatchMode=yes' };
    execFile(GIT_BIN, args, { cwd, env, timeout, encoding: 'utf8', maxBuffer: 16 * 2 ** 20 }, (err, stdout, stderr) => {
      if (!err) return resolve(stdout);
      const why = err.killed ? `no answer within ${timeout / 1000} s` : (stderr.trim().split('\n').pop() || err.message);
      reject(new Error(`git ${args[0] === '-C' ? args[2] : args[0]}: ${why}`));
    });
  });
}

/// The mirrors under `dir`. `ensureMirror({ pool, checkout })` creates or refreshes the
/// pool's mirror from the linked checkout's remote and resolves to `{ path, refreshed,
/// error }`: a refresh that fails leaves the mirror as it was and says why; a mirror
/// that cannot be created rejects. `path(pool)` is the mirror if there is one.
/// `retain(pool)` marks a job as reading the mirror and returns the function that ends it.
export function createMirrors({ log = () => {}, dir = MIRRORS_DIR } = {}) {
  const queues = new Map(); // mirror path -> the last operation on it
  const readers = new Map(); // mirror path -> jobs reading it

  const pathOf = (pool) => path.join(dir, `${poolHash(pool.id)}.git`);
  const exists = (p) => fs.existsSync(path.join(p, 'HEAD'));

  // The checkout's remote for the pool's repository: `upstream` in a fork's checkout,
  // `origin` otherwise.
  async function remoteUrl(pool, checkout) {
    for (const name of ['upstream', 'origin']) {
      // The URL as configured: `remote get-url` would answer with any insteadOf rewrite
      // applied, and the pool is named by the address before it.
      const url = (await git(['-C', checkout, 'config', '--get', `remote.${name}.url`], { timeout: 10000 }).catch(() => '')).trim();
      if (url && remoteSlug(url) === pool.id.toLowerCase()) return url;
    }
    throw new Error(`${checkout} has no upstream or origin remote for ${pool.id}`);
  }

  async function sync(pool, checkout) {
    const target = pathOf(pool);
    const url = await remoteUrl(pool, checkout);
    if (!exists(target)) {
      const tmp = `${target}.tmp.${process.pid}`;
      fs.rmSync(tmp, { recursive: true, force: true });
      fs.mkdirSync(dir, { recursive: true });
      try {
        // The checkout's objects are copied in, not borrowed: a mirror that pointed
        // into the checkout would break the day the operator pruned it.
        await git(['clone', '--quiet', '--mirror', '--reference', checkout, '--dissociate', url, tmp]);
        // No collection the fetches start on their own: see the one below.
        await git(['-C', tmp, 'config', 'gc.auto', '0']);
        fs.renameSync(tmp, target);
      } catch (e) {
        fs.rmSync(tmp, { recursive: true, force: true });
        throw e;
      }
      log('mirror', `created ${target} from ${remoteSlug(url)}`);
      return { path: target, refreshed: true, error: '' };
    }
    try {
      await git(['-C', target, 'remote', 'set-url', 'origin', url], { timeout: 10000 });
      await git(['-C', target, 'remote', 'update', '--prune']);
    } catch (e) {
      log('mirror', `refresh of ${pool.id} failed, serving it as it was: ${e.message}`);
      return { path: target, refreshed: false, error: e.message };
    }
    // Objects are collected only while no job reads the mirror: an upload-pack in
    // flight must never have a pack removed from under it.
    if (!readers.get(target)) {
      await git(['-C', target, '-c', 'gc.auto=6700', '-c', 'gc.autoDetach=false', 'gc', '--auto', '--quiet']).catch((e) => log('mirror', e.message));
    }
    return { path: target, refreshed: true, error: '' };
  }

  function ensureMirror({ pool, checkout }) {
    const target = pathOf(pool);
    const run = (queues.get(target) || Promise.resolve()).then(() => sync(pool, checkout));
    queues.set(target, run.catch(() => {}));
    return run;
  }

  function retain(pool) {
    const target = pathOf(pool);
    readers.set(target, (readers.get(target) || 0) + 1);
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      readers.set(target, readers.get(target) - 1);
    };
  }

  return { ensureMirror, retain, path: (pool) => (exists(pathOf(pool)) ? pathOf(pool) : null) };
}
