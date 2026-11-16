// The bare mirror a container clones from. A job's `git clone https://<forge>/<o>/<r>.git`
// never reaches the forge: the broker answers it from MIRRORS_DIR/<pool part>.git, which
// this machine keeps current with its own git credentials. That is the only place those
// credentials are used, and it is on the host. The pool part is the 128 bits a
// container's name carries for the pool: no two repositories share a mirror.

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { GIT_BIN, MIRRORS_DIR, MIRROR_TIMEOUT_MS } from '../paths.js';
import { namePart } from './container.js';

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
      // git's own last word is often the tail of a paragraph of advice; its reason is the fatal line.
      const said = stderr.trim().split('\n');
      const why = err.killed ? `no answer within ${timeout / 1000} s` : (said.filter((l) => l.startsWith('fatal:')).pop() || said.pop() || err.message);
      reject(new Error(`git ${args[0] === '-C' ? args[2] : args[0]}: ${why}`));
    });
  });
}

/// The mirrors under `dir`. `ensureMirror({ pool, checkout })` creates or refreshes the
/// pool's mirror from the linked checkout's remote and resolves to `{ path, refreshed,
/// error }`: a refresh that fails leaves the mirror as it was and says why; a mirror
/// that cannot be created rejects. `path(pool)` is the mirror if there is one.
/// `retain(pool)` marks a job as reading the mirror and returns the function that ends it.
/// `sweep(pools, keepMs)` is told the pools whose mirrors are wanted now, and removes
/// every other mirror that has not been wanted for `keepMs` and that no job reads; it
/// resolves once they are gone.
export function createMirrors({ log = () => {}, dir = MIRRORS_DIR } = {}) {
  const queues = new Map(); // mirror path -> the last operation on it
  const readers = new Map(); // mirror path -> jobs reading it

  const pathOf = (pool) => path.join(dir, `${namePart(pool.id)}.git`);
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

  function sweep(pools, keepMs) {
    const now = Date.now();
    // A mirror's own date says when its pool was last wanted, across daemons.
    for (const pool of pools) {
      try { fs.utimesSync(pathOf(pool), now / 1000, now / 1000); } catch {}
    }
    let names = [];
    try { names = fs.readdirSync(dir); } catch {}
    const turns = [];
    for (const name of names) {
      const target = path.join(dir, name);
      let last = now;
      try { last = fs.statSync(target).mtimeMs; } catch {}
      // What an interrupted clone left is as stale as a mirror nobody wants. So is a
      // mirror named by sixteen hex digits, which an earlier version made: nothing reads it.
      if (!/^([0-9a-z]{25}|[0-9a-f]{16})\.git(\.tmp\.\d+)?$/.test(name) || now - last < keepMs) continue;
      // In the mirror's own turn: never from under a refresh, nor a job that came since.
      const turn = (queues.get(target) || Promise.resolve()).then(() => {
        if (readers.get(target)) return;
        fs.rmSync(target, { recursive: true, force: true });
        log('mirror', `removed ${target}: no linked pool's mirror for ${Math.round(keepMs / 3600000)} h`);
      });
      queues.set(target, turn.catch(() => {}));
      turns.push(queues.get(target));
    }
    return Promise.all(turns);
  }

  return { ensureMirror, retain, sweep, path: (pool) => (exists(pathOf(pool)) ? pathOf(pool) : null) };
}
