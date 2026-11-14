// The bare mirror: made from the linked checkout's remote, refreshed before a job, served
// stale when a refresh fails, never collected under a job - with real git against scratch
// repositories, the forge's URL rewritten to a directory.
// Run: node test/executor-mirror.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'dn-mirror-'));
const GIT_LOG = path.join(scratch, 'git.log');
const HANG = path.join(scratch, 'hang');
const forge = path.join(scratch, 'forge'); // forge/<owner>/<repo>.git stands in for https://github.com/<owner>/<repo>.git
fs.mkdirSync(forge);
// The real git, with every invocation recorded and one staged to hang.
const wrapper = path.join(scratch, 'git');
fs.writeFileSync(wrapper, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(GIT_LOG)}\ncase "$*" in *"remote update"*) [ -f ${JSON.stringify(HANG)} ] && exec sleep 30;; esac\nexec git "$@"\n`, { mode: 0o755 });
fs.writeFileSync(path.join(scratch, 'gitconfig'), `[user]\n\tname = T\n\temail = t@example.com\n[init]\n\tdefaultBranch = main\n[url "${forge}/"]\n\tinsteadOf = https://github.com/\n\tinsteadOf = git@github.com:\n`);
Object.assign(process.env, {
  DN_BASE_DIR: path.join(scratch, 'base'), DN_GIT: wrapper, DN_MIRROR_TIMEOUT_MS: '4000',
  GIT_CONFIG_GLOBAL: path.join(scratch, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1',
});
const { createMirrors, poolHash, remoteSlug } = await import('../src/executor/mirror.js');
const { MIRRORS_DIR } = await import('../src/paths.js');

let checks = 0;
const check = async (name, fn) => { await fn(); checks++; console.log(`PASS ${name}`); };
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const gitCalls = () => fs.readFileSync(GIT_LOG, 'utf8').split('\n').filter(Boolean);
const refs = (repo) => git(repo, 'for-each-ref', '--format=%(refname) %(objectname)').split('\n').sort();

// A repository on the stand-in forge with a branch, a pull request head and a checkout.
function repo(owner, name) {
  const bare = path.join(forge, owner, `${name}.git`);
  fs.mkdirSync(bare, { recursive: true });
  git(bare, 'init', '--quiet', '--bare');
  const checkout = path.join(scratch, `checkout-${owner}-${name}`);
  git(scratch, 'clone', '--quiet', `https://github.com/${owner}/${name}.git`, checkout);
  fs.writeFileSync(path.join(checkout, 'README'), 'one\n');
  git(checkout, 'add', '.');
  git(checkout, 'commit', '--quiet', '-m', 'one');
  git(checkout, 'push', '--quiet', 'origin', 'main', 'main:refs/pull/7/head', 'main:refs/heads/doomed');
  return { bare, checkout, pool: { id: `github.com/${owner}/${name}`, forge: 'github', host: 'github.com', owner, repo: name } };
}
const commit = (r, text) => {
  fs.writeFileSync(path.join(r.checkout, 'README'), text);
  git(r.checkout, 'commit', '--quiet', '-am', text.trim());
  git(r.checkout, 'push', '--quiet', 'origin', 'main');
  return git(r.checkout, 'rev-parse', 'HEAD');
};

try {
  const mirrors = createMirrors();
  const a = repo('dn-test', 'alpha');
  const mirrorPath = path.join(MIRRORS_DIR, `${poolHash(a.pool.id)}.git`);

  await check('every spelling of a remote names the same repository', () => {
    for (const url of ['https://github.com/Dn-Test/Alpha.git', 'https://github.com/dn-test/alpha', 'git@github.com:dn-test/alpha.git',
      'ssh://git@github.com/dn-test/alpha.git', 'ssh://git@github.com:22/dn-test/alpha', 'https://user:pw@github.com/dn-test/alpha.git/']) {
      assert.equal(remoteSlug(url), 'github.com/dn-test/alpha', url);
    }
    assert.equal(remoteSlug('https://gitlab.example.org/group/sub/repo.git'), 'gitlab.example.org/group/sub/repo');
    assert.equal(remoteSlug('/tmp/somewhere/alpha.git'), null);
    assert.match(poolHash(a.pool.id), /^[0-9a-f]{16}$/);
  });

  await check('there is no mirror until one is asked for', () => {
    assert.equal(mirrors.path(a.pool), null);
  });

  await check('the mirror is a bare copy of the remote: branches, pull request heads, and objects of its own', async () => {
    const made = await mirrors.ensureMirror({ pool: a.pool, checkout: a.checkout });
    assert.deepEqual(made, { path: mirrorPath, refreshed: true, error: '' });
    assert.equal(mirrors.path(a.pool), mirrorPath);
    assert.equal(git(mirrorPath, 'rev-parse', '--is-bare-repository'), 'true');
    assert.deepEqual(refs(mirrorPath), refs(a.bare));
    assert.ok(refs(mirrorPath).some((r) => r.startsWith('refs/pull/7/head ')), refs(mirrorPath).join());
    const clone = gitCalls().find((c) => c.startsWith('clone'));
    assert.match(clone, new RegExp(`--mirror --reference ${a.checkout} --dissociate https://github.com/dn-test/alpha.git`));
    // Deleting the checkout must not take the mirror's objects with it.
    assert.equal(fs.existsSync(path.join(mirrorPath, 'objects', 'info', 'alternates')), false);
    assert.equal(git(mirrorPath, 'config', 'gc.auto'), '0');
  });

  await check('a refresh brings new commits and drops refs the remote dropped', async () => {
    const head = commit(a, 'two\n');
    git(a.checkout, 'push', '--quiet', 'origin', ':doomed');
    assert.deepEqual(await mirrors.ensureMirror({ pool: a.pool, checkout: a.checkout }), { path: mirrorPath, refreshed: true, error: '' });
    assert.equal(git(mirrorPath, 'rev-parse', 'refs/heads/main'), head);
    assert.deepEqual(refs(mirrorPath), refs(a.bare));
    assert.ok(!refs(mirrorPath).some((r) => r.includes('doomed')));
  });

  await check('a refresh that fails serves the mirror as it was and says why', async () => {
    const before = refs(mirrorPath);
    fs.renameSync(a.bare, `${a.bare}.away`);
    const r = await mirrors.ensureMirror({ pool: a.pool, checkout: a.checkout });
    assert.equal(r.path, mirrorPath);
    assert.equal(r.refreshed, false);
    assert.match(r.error, /^git remote: /);
    assert.deepEqual(refs(mirrorPath), before);
    fs.renameSync(`${a.bare}.away`, a.bare);
    assert.equal((await mirrors.ensureMirror({ pool: a.pool, checkout: a.checkout })).refreshed, true);
  });

  await check('a refresh that hangs is cut off at its timeout, and the next one is not stuck behind it', async () => {
    fs.writeFileSync(HANG, '');
    const started = Date.now();
    const r = await mirrors.ensureMirror({ pool: a.pool, checkout: a.checkout });
    assert.equal(r.refreshed, false);
    assert.match(r.error, /no answer within 4 s/);
    assert.ok(Date.now() - started < 15000);
    fs.rmSync(HANG);
    assert.equal((await mirrors.ensureMirror({ pool: a.pool, checkout: a.checkout })).refreshed, true);
  });

  await check('objects are collected only while no job reads the mirror', async () => {
    const collections = () => gitCalls().filter((c) => /\bgc --auto\b/.test(c)).length;
    const idle = collections();
    assert.ok(idle > 0, 'an idle refresh collects');
    const release1 = mirrors.retain(a.pool);
    const release2 = mirrors.retain(a.pool);
    await mirrors.ensureMirror({ pool: a.pool, checkout: a.checkout });
    release1();
    release1(); // ending one job twice does not end the other
    await mirrors.ensureMirror({ pool: a.pool, checkout: a.checkout });
    assert.equal(collections(), idle, 'not with a job reading');
    release2();
    await mirrors.ensureMirror({ pool: a.pool, checkout: a.checkout });
    assert.equal(collections(), idle + 1);
  });

  await check('two jobs starting at once make one mirror, one after the other', async () => {
    const b = repo('dn-test', 'beta');
    const [x, y] = await Promise.all([mirrors.ensureMirror({ pool: b.pool, checkout: b.checkout }), mirrors.ensureMirror({ pool: b.pool, checkout: b.checkout })]);
    assert.equal(x.path, y.path);
    assert.notEqual(x.path, mirrorPath, 'each pool has its own');
    assert.equal(gitCalls().filter((c) => c.startsWith('clone') && c.includes('beta')).length, 1);
    assert.deepEqual(refs(x.path), refs(b.bare));
  });

  await check('a fork\'s checkout is mirrored from its upstream, the pool\'s repository', async () => {
    const up = repo('dn-test', 'gamma');
    const fork = path.join(forge, 'someone', 'gamma.git');
    fs.mkdirSync(path.dirname(fork));
    git(scratch, 'clone', '--quiet', '--bare', up.bare, fork);
    git(up.checkout, 'remote', 'set-url', 'origin', 'git@github.com:someone/gamma.git');
    git(up.checkout, 'remote', 'add', 'upstream', 'https://github.com/DN-Test/Gamma.git');
    const made = await mirrors.ensureMirror({ pool: up.pool, checkout: up.checkout });
    assert.equal(git(made.path, 'config', '--get', 'remote.origin.url'), 'https://github.com/DN-Test/Gamma.git');
  });

  await check('a checkout with no remote for the pool makes no mirror, and neither does a remote that cannot be read', async () => {
    const c = repo('dn-test', 'delta');
    const other = { ...c.pool, id: 'github.com/dn-test/elsewhere', repo: 'elsewhere' };
    await assert.rejects(mirrors.ensureMirror({ pool: other, checkout: c.checkout }), /has no upstream or origin remote for github\.com\/dn-test\/elsewhere/);
    assert.equal(mirrors.path(other), null);
    fs.renameSync(c.bare, `${c.bare}.away`);
    await assert.rejects(mirrors.ensureMirror({ pool: c.pool, checkout: c.checkout }), /^Error: git clone: /);
    assert.equal(mirrors.path(c.pool), null);
    assert.deepEqual(fs.readdirSync(MIRRORS_DIR).filter((n) => n.includes('.tmp.')), [], 'nothing half-made is left');
    fs.renameSync(`${c.bare}.away`, c.bare);
    assert.equal((await mirrors.ensureMirror({ pool: c.pool, checkout: c.checkout })).refreshed, true, 'and it is made the next time');
  });

  console.log(`\nall ${checks} checks passed`);
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
