// The bare mirror a container clones from. A job's `git clone https://<forge>/<o>/<r>.git`
// never reaches the forge: the broker answers it from MIRRORS_DIR/<pool part>.git, which
// this machine keeps current with its own git credentials. That is the only place those
// credentials are used, and it is on the host. The pool part is the 128 bits a
// container's name carries for the pool: no two repositories share a mirror.
//
// A mirror is of the pool's repository, whatever the linked checkout's remotes are: the
// checkout says how this machine reaches that forge, and lends its objects.

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { GIT_BIN, MIRRORS_DIR, MIRROR_TIMEOUT_MS } from '../paths.js';
import { forgeSshHosts } from './broker.js';
import { namePart } from './container.js';
import { own } from './own-fault.js';

// A remote URL in either spelling: all of it up to the repository's path, the host in
// that, and the path.
const REMOTE = /^((?:[a-z+]+:\/\/)?(?:[^@/]+@)?([^:/]+)(?::\d+)?[:/])(.+?)(?:\.git)?\/?$/i;

/// `host/owner/repo` in lowercase for any spelling of a remote URL, or null. Null too
/// for an https remote on a port but 443 and an http one on a port but 80: a pool's id
/// names a host and no port, and the forge's API is on 443. An ssh port is only how git
/// reaches the forge.
export function remoteSlug(url) {
  const s = String(url).trim();
  const web = /^(https?):\/\/(?:[^@/]+@)?[^/:@]+:(\d+)\//i.exec(s);
  if (web && Number(web[2]) !== (web[1].toLowerCase() === 'https' ? 443 : 80)) return null;
  const m = REMOTE.exec(s);
  return m ? `${m[2]}/${m[3]}`.toLowerCase() : null;
}

/// The URL the pool's repository is fetched by, `remotes` being a checkout's as `[[name,
/// url]]`, `upstream` counting before `origin` and that before the rest: a remote that
/// is the repository, as it is spelled; else the repository's path in the spelling of a
/// remote on the same forge, which is how this machine reaches that forge - from a
/// fork's checkout, or one whose remote has a name the repository had; else, `guessed`,
/// https. A forge's other ssh host is that forge; the same path on any other host is
/// another repository.
export function fetchUrl(pool, remotes) {
  const hosts = [pool.host, ...forgeSshHosts(pool)];
  const repo = pool.id.slice(pool.id.indexOf('/') + 1);
  const rank = (name) => ['upstream', 'origin', name].indexOf(name);
  const there = remotes.map(([name, url]) => [name, url, REMOTE.exec(url)])
    .filter(([, , m]) => m && hosts.includes(m[2].toLowerCase()))
    .sort(([a], [b]) => rank(a) - rank(b));
  const same = there.find(([, , m]) => m[3].toLowerCase() === repo.toLowerCase());
  if (same) return { url: same[1], guessed: false };
  if (there.length > 0) return { url: `${there[0][2][1]}${repo}.git`, guessed: false };
  return { url: `https://${pool.id}.git`, guessed: true };
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
/// pool's mirror by `fetchUrl` of the linked checkout's remotes and resolves to `{ path,
/// refreshed, error }`: a refresh that fails leaves the mirror as it was and says why; a
/// mirror that cannot be created rejects with an OwnFault. `path(pool)` is the mirror if
/// there is one.
/// `retain(pool)` marks a job as reading the mirror and returns the function that ends it.
/// `sweep(pools, keepMs)` is told the pools whose mirrors are wanted now, and removes
/// every other mirror that has not been wanted for `keepMs` and that no job reads; it
/// resolves once they are gone.
export function createMirrors({ log = () => {}, dir = MIRRORS_DIR } = {}) {
  const queues = new Map(); // mirror path -> the last operation on it
  const readers = new Map(); // mirror path -> jobs reading it

  const pathOf = (pool) => path.join(dir, `${namePart(pool.id)}.git`);
  const exists = (p) => fs.existsSync(path.join(p, 'HEAD'));

  // The checkout's remotes as configured: `remote get-url` would answer with any
  // insteadOf rewrite applied, and the pool is named by the address before it.
  async function remotesOf(checkout) {
    const said = await git(['-C', checkout, 'config', '--get-regexp', '^remote\\..*\\.url$'], { timeout: 10000 }).catch(() => '');
    return said.split('\n').filter(Boolean).map((line) => [line.slice('remote.'.length, line.indexOf(' ') - '.url'.length), line.slice(line.indexOf(' ') + 1).trim()]);
  }

  async function sync(pool, checkout) {
    const target = pathOf(pool);
    const { url, guessed } = fetchUrl(pool, await remotesOf(checkout));
    const told = (e) => (guessed ? `${e.message} - ${checkout} has no remote on ${pool.host}, so ${pool.id} was asked for over https` : e.message);
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
        throw new Error(told(e));
      }
      log('mirror', `created ${target} from ${remoteSlug(url)}`);
      return { path: target, refreshed: true, error: '' };
    }
    try {
      await git(['-C', target, 'remote', 'set-url', 'origin', url], { timeout: 10000 });
      await git(['-C', target, 'remote', 'update', '--prune']);
    } catch (e) {
      log('mirror', `refresh of ${pool.id} failed, serving it as it was: ${told(e)}`);
      return { path: target, refreshed: false, error: told(e) };
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
    const run = (queues.get(target) || Promise.resolve()).then(() => own(sync(pool, checkout)));
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
      const turn = (queues.get(target) || Promise.resolve()).then(async () => {
        if (readers.get(target)) return;
        // Off the daemon's thread: a repository takes as long to delete as it has files.
        await fs.promises.rm(target, { recursive: true, force: true });
        log('mirror', `removed ${target}: no linked pool's mirror for ${Math.round(keepMs / 3600000)} h`);
      });
      queues.set(target, turn.catch(() => {}));
      turns.push(queues.get(target));
    }
    return Promise.all(turns);
  }

  return { ensureMirror, retain, sweep, path: (pool) => (exists(pathOf(pool)) ? pathOf(pool) : null) };
}
