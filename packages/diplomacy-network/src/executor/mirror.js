// A job's `git clone https://<forge>/<o>/<r>.git` never reaches the forge: the broker
// answers it from MIRRORS_DIR/<namePart(pool)>.git, kept current on the host with this
// machine's git credentials - the only place they are used. A mirror is of the pool's
// repository whatever the linked checkout's remotes are: the checkout only says how this
// machine reaches that forge, and lends its objects.

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { GIT_BIN, MIRRORS_DIR, MIRROR_TIMEOUT_MS } from '../paths.js';
import { forgeSshHosts } from './broker.js';
import { namePart } from './container.js';
import { own } from './own-fault.js';

// URL or scp-like spelling: [1] everything before the path, [2] the host, [3] the path.
const REMOTE = /^((?:[a-z+]+:\/\/)?(?:[^@/]+@)?([^:/]+)(?::\d+)?[:/])(.+?)(?:\.git)?\/?$/i;

/// null for http(s) on a non-default port: a pool's id names no port and the forge's API
/// is on 443. An ssh port is only how git reaches the forge.
export function remoteSlug(url) {
  const s = String(url).trim();
  const web = /^(https?):\/\/(?:[^@/]+@)?[^/:@]+:(\d+)\//i.exec(s);
  if (web && Number(web[2]) !== (web[1].toLowerCase() === 'https' ? 443 : 80)) return null;
  const m = REMOTE.exec(s);
  return m ? `${m[2]}/${m[3]}`.toLowerCase() : null;
}

/// `upstream`, then `origin`, then the rest: a remote that is the repository as spelled;
/// else the repository's path spelled as a remote on the same forge (a fork's checkout, or
/// a renamed repository); else, `guessed`, https. The same path on another host is another
/// repository.
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
    const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND || 'ssh -o BatchMode=yes' };
    execFile(GIT_BIN, args, { cwd, env, timeout, encoding: 'utf8', maxBuffer: 16 * 2 ** 20 }, (err, stdout, stderr) => {
      if (!err) return resolve(stdout);
      // git's last line is often advice; the reason is the fatal line.
      const said = stderr.trim().split('\n');
      const why = err.killed ? `no answer within ${timeout / 1000} s` : (said.filter((l) => l.startsWith('fatal:')).pop() || said.pop() || err.message);
      reject(new Error(`git ${args[0] === '-C' ? args[2] : args[0]}: ${why}`));
    });
  });
}

/// `ensureMirror` keeps a mirror as it was when a refresh fails, rejecting with an OwnFault
/// only when it cannot be created. `sweep(pools, keepMs)` removes every mirror not of
/// `pools` that has not been wanted for `keepMs` and that no job reads.
export function createMirrors({ log = () => {}, dir = MIRRORS_DIR } = {}) {
  const queues = new Map(); // mirror path -> its last operation
  const readers = new Map();

  const pathOf = (pool) => path.join(dir, `${namePart(pool.id)}.git`);
  const exists = (p) => fs.existsSync(path.join(p, 'HEAD'));

  // Not `remote get-url`: it applies insteadOf rewrites, and the pool is named by the
  // address before them.
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
        // Copied, not borrowed: a mirror pointing into the checkout would break the day the
        // operator pruned it.
        await git(['clone', '--quiet', '--mirror', '--reference', checkout, '--dissociate', url, tmp]);
        // Collection runs only below, never from a fetch.
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
    // Only while no job reads: an upload-pack in flight must not lose a pack from under it.
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
    // A mirror's mtime says when its pool was last wanted, across daemons.
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
      // Leftover clones are as stale as an unwanted mirror, as are 16-hex names, an older
      // naming nothing reads.
      if (!/^([0-9a-z]{25}|[0-9a-f]{16})\.git(\.tmp\.\d+)?$/.test(name) || now - last < keepMs) continue;
      // In the mirror's queue: never from under a refresh, nor a job that came since.
      const turn = (queues.get(target) || Promise.resolve()).then(async () => {
        if (readers.get(target)) return;
        // Async: a repository takes as long to delete as it has files.
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
