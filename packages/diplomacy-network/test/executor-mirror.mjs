// The bare mirror: made of the pool's repository the way the linked checkout reaches its
// forge, refreshed before a job, served stale when a refresh fails, never collected under
// a job - with real git against scratch repositories, the forges' URLs rewritten to a
// directory.
// Run: node test/executor-mirror.mjs

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
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
fs.writeFileSync(path.join(scratch, 'gitconfig'), `[user]\n\tname = T\n\temail = t@example.com\n[init]\n\tdefaultBranch = main\n[url "${forge}/"]\n\tinsteadOf = https://github.com/\n\tinsteadOf = git@github.com:\n\tinsteadOf = ssh://git@ssh.github.com:443/\n\tinsteadOf = git@altssh.gitlab.com:\n`);
Object.assign(process.env, {
  DN_BASE_DIR: path.join(scratch, 'base'), DN_GIT: wrapper, DN_MIRROR_TIMEOUT_MS: '4000',
  GIT_CONFIG_GLOBAL: path.join(scratch, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1',
});
const { createMirrors, fetchUrl, remoteSlug } = await import('../src/executor/mirror.js');
const { OwnFault } = await import('../src/executor/own-fault.js');
const { containerName } = await import('../src/executor/container.js');
const { MIRRORS_DIR } = await import('../src/paths.js');

let checks = 0;
const check = async (name, fn) => { await fn(); checks++; console.log(`PASS ${name}`); };
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const gitCalls = () => fs.readFileSync(GIT_LOG, 'utf8').split('\n').filter(Boolean);
const refs = (repo) => git(repo, 'for-each-ref', '--format=%(refname) %(objectname)').split('\n').sort();
// Where a pool's mirror is: under the part of a container's name that stands for the pool.
const mirrorOf = (pool) => path.join(MIRRORS_DIR, `${containerName(pool.id, 'any peer').split('-')[1]}.git`);
const DAY = 24 * 3600 * 1000;
const age = (p, days) => fs.utimesSync(p, (Date.now() - days * DAY) / 1000, (Date.now() - days * DAY) / 1000);

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
const commit = (r, text, to = 'origin') => {
  fs.writeFileSync(path.join(r.checkout, 'README'), text);
  git(r.checkout, 'commit', '--quiet', '-am', text.trim());
  git(r.checkout, 'push', '--quiet', to, 'main');
  return git(r.checkout, 'rev-parse', 'HEAD');
};

try {
  const mirrors = createMirrors();
  const a = repo('dn-test', 'alpha');
  const mirrorPath = mirrorOf(a.pool);

  await check('every spelling of a remote names the same repository', () => {
    for (const url of ['https://github.com/Dn-Test/Alpha.git', 'https://github.com/dn-test/alpha', 'git@github.com:dn-test/alpha.git',
      'ssh://git@github.com/dn-test/alpha.git', 'ssh://git@github.com:22/dn-test/alpha', 'https://user:pw@github.com/dn-test/alpha.git/']) {
      assert.equal(remoteSlug(url), 'github.com/dn-test/alpha', url);
    }
    assert.equal(remoteSlug('https://gitlab.example.org/group/sub/repo.git'), 'gitlab.example.org/group/sub/repo');
    assert.equal(remoteSlug('/tmp/somewhere/alpha.git'), null);
  });

  await check('an https or http remote on another port than its own names no repository; an ssh port does not count', () => {
    for (const url of ['https://gitlab.acme.example:8443/p/api.git', 'https://u:pw@github.com:8443/dn-test/alpha', 'HTTP://github.com:8080/dn-test/alpha', 'http://github.com:443/dn-test/alpha']) {
      assert.equal(remoteSlug(url), null, url);
    }
    for (const url of ['https://github.com:443/dn-test/alpha', 'https://github.com:0443/dn-test/alpha', 'http://github.com:80/dn-test/alpha', 'ssh://git@github.com:2222/dn-test/alpha', 'git://github.com:9418/dn-test/alpha']) {
      assert.equal(remoteSlug(url), 'github.com/dn-test/alpha', url);
    }
  });

  await check('there is no mirror until one is asked for', () => {
    assert.equal(mirrors.path(a.pool), null);
  });

  await check('the mirror is a bare copy of the remote: branches, pull request heads, and objects of its own', async () => {
    const made = await mirrors.ensureMirror({ pool: a.pool, checkout: a.checkout });
    assert.deepEqual(made, { path: mirrorPath, refreshed: true, error: '' });
    assert.match(path.basename(mirrorPath), /^[0-9a-z]{25}\.git$/, '128 bits of the pool');
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
    assert.match(r.error, /^git remote: fatal: /);
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
    git(up.checkout, 'remote', 'add', 'upstream', 'https://github.com/dn-test/gamma');
    const made = await mirrors.ensureMirror({ pool: up.pool, checkout: up.checkout });
    assert.equal(git(made.path, 'config', '--get', 'remote.origin.url'), 'https://github.com/dn-test/gamma');
  });

  await check('the pool\'s repository is fetched by a remote that is it, as spelled; else by its own path in the spelling of a remote on its forge; else over https', () => {
    const pool = { id: 'github.com/Acme/Widgets', forge: 'github', host: 'github.com' };
    const by = (...remotes) => fetchUrl(pool, remotes);
    const fork = ['origin', 'git@github.com:me/widgets.git'];
    // A remote that is the repository, under whatever name: upstream, then origin, then the rest.
    assert.deepEqual(by(fork, ['acme', 'ssh://git@github.com:22/acme/widgets']), { url: 'ssh://git@github.com:22/acme/widgets', guessed: false });
    assert.deepEqual(by(['acme', 'https://github.com/acme/widgets'], ['origin', 'git@github.com:ACME/widgets.git'], ['upstream', 'https://github.com/acme/widgets.git/']).url, 'https://github.com/acme/widgets.git/');
    assert.equal(by(['acme', 'https://github.com/acme/widgets'], ['origin', 'git@github.com:ACME/widgets.git']).url, 'git@github.com:ACME/widgets.git');
    assert.equal(by(['one', 'https://github.com/acme/widgets'], ['two', 'git@github.com:acme/widgets.git']).url, 'https://github.com/acme/widgets', 'of two under other names, the first');
    // A fork's checkout, and one whose remote has the name the repository had: the way
    // that remote reaches the forge, with the pool's own path.
    assert.deepEqual(by(fork), { url: 'git@github.com:Acme/Widgets.git', guessed: false });
    assert.equal(by(['origin', 'https://github.com/acme/gadgets.git']).url, 'https://github.com/Acme/Widgets.git');
    assert.equal(by(['origin', 'ssh://deploy@GitHub.com:22/me/widgets']).url, 'ssh://deploy@GitHub.com:22/Acme/Widgets.git');
    assert.equal(by(['origin', 'https://me:secret@github.com/me/widgets.git']).url, 'https://me:secret@github.com/Acme/Widgets.git');
    assert.equal(by(['mine', 'https://github.com/me/widgets'], ['origin', 'git@github.com:me/widgets.git'], ['upstream', 'ssh://git@github.com/old/widgets']).url, 'ssh://git@github.com/Acme/Widgets.git', 'upstream\'s way before origin\'s before another\'s');
    assert.equal(by(['mine', 'https://github.com/me/widgets'], ['origin', 'git@github.com:me/widgets.git']).url, 'git@github.com:Acme/Widgets.git');
    assert.equal(by(['upstream', 'https://github.com/me/gadgets'], ['origin', 'git@github.com:acme/widgets.git']).url, 'git@github.com:acme/widgets.git', 'a remote that is the repository before the way of one that is not');
    // The forge's other ssh host is the forge.
    assert.equal(by(['origin', 'ssh://git@ssh.github.com:443/acme/widgets.git']).url, 'ssh://git@ssh.github.com:443/acme/widgets.git');
    assert.equal(by(['origin', 'ssh://git@ssh.github.com:443/me/widgets.git']).url, 'ssh://git@ssh.github.com:443/Acme/Widgets.git');
    const lab = { id: 'gitlab.com/group/sub/repo', forge: 'gitlab', host: 'gitlab.com' };
    assert.equal(fetchUrl(lab, [['origin', 'git@altssh.gitlab.com:group/sub/repo.git']]).url, 'git@altssh.gitlab.com:group/sub/repo.git');
    assert.equal(fetchUrl(lab, [['origin', 'git@ssh.github.com:group/sub/repo.git']]).guessed, true, 'another forge\'s is not');
    // No remote on the pool's forge: a repository of the same path elsewhere is another
    // repository, and so is one on a host that only begins or ends like the forge's.
    for (const elsewhere of [[], [['origin', 'https://gitlab.com/acme/widgets.git']], [['origin', 'git@github.com.example.org:acme/widgets.git'], ['upstream', 'https://notgithub.com/acme/widgets']], [['origin', '/srv/git/widgets.git']]]) {
      assert.deepEqual(fetchUrl(pool, elsewhere), { url: 'https://github.com/Acme/Widgets.git', guessed: true });
    }
  });

  await check('a checkout whose only remote is a fork is where the pool\'s repository is fetched from the forge, not the fork', async () => {
    const up = repo('dn-test', 'eta');
    const fork = path.join(forge, 'someone', 'eta.git');
    git(scratch, 'clone', '--quiet', '--bare', up.bare, fork);
    git(fork, 'update-ref', 'refs/heads/the-forks-own', 'refs/heads/main');
    git(up.checkout, 'remote', 'set-url', 'origin', 'git@github.com:someone/eta.git');
    const made = await mirrors.ensureMirror({ pool: up.pool, checkout: up.checkout });
    assert.equal(git(made.path, 'config', '--get', 'remote.origin.url'), 'git@github.com:dn-test/eta.git', 'the pool\'s repository, the way the fork is reached');
    assert.deepEqual(refs(made.path), refs(up.bare));
    // And refreshed from there, whatever the checkout's remotes are by then.
    git(up.checkout, 'remote', 'set-url', 'origin', 'ssh://git@ssh.github.com:443/someone/eta.git');
    const head = commit(up, 'two\n', 'ssh://git@ssh.github.com:443/dn-test/eta.git');
    assert.equal((await mirrors.ensureMirror({ pool: up.pool, checkout: up.checkout })).refreshed, true);
    assert.deepEqual([git(made.path, 'config', '--get', 'remote.origin.url'), git(made.path, 'rev-parse', 'refs/heads/main')], ['ssh://git@ssh.github.com:443/dn-test/eta.git', head]);
  });

  await check('a checkout that reaches GitLab by its other ssh host is one of that pool, and one whose remote has the repository\'s earlier name is fetched under the name the pool has', async () => {
    const lab = repo('group/sub', 'repo');
    git(lab.checkout, 'remote', 'set-url', 'origin', 'git@altssh.gitlab.com:group/sub/repo.git');
    const pool = { id: 'gitlab.com/group/sub/repo', forge: 'gitlab', host: 'gitlab.com', owner: 'group/sub', repo: 'repo' };
    const made = await mirrors.ensureMirror({ pool, checkout: lab.checkout });
    assert.deepEqual([git(made.path, 'config', '--get', 'remote.origin.url'), refs(made.path)], ['git@altssh.gitlab.com:group/sub/repo.git', refs(lab.bare)]);

    const moved = repo('dn-test', 'theta');
    git(moved.checkout, 'remote', 'set-url', 'origin', 'git@github.com:someone/theta.git');
    git(moved.checkout, 'remote', 'add', 'upstream', 'https://github.com/dn-test/theta-as-it-was.git');
    const renamed = await mirrors.ensureMirror({ pool: moved.pool, checkout: moved.checkout });
    assert.deepEqual([git(renamed.path, 'config', '--get', 'remote.origin.url'), refs(renamed.path)], ['https://github.com/dn-test/theta.git', refs(moved.bare)]);
  });

  await check('a checkout with no remote on the pool\'s forge is fetched over https, and a failure says that it was', async () => {
    const c = repo('dn-test', 'iota');
    git(c.checkout, 'remote', 'set-url', 'origin', 'git@altssh.gitlab.com:dn-test/iota.git');
    const made = await mirrors.ensureMirror({ pool: c.pool, checkout: c.checkout });
    assert.deepEqual([git(made.path, 'config', '--get', 'remote.origin.url'), refs(made.path)], ['https://github.com/dn-test/iota.git', refs(c.bare)]);
    const why = ` - ${c.checkout} has no remote on github.com, so github.com/dn-test/iota was asked for over https`;
    fs.renameSync(c.bare, `${c.bare}.away`);
    const stale = await mirrors.ensureMirror({ pool: c.pool, checkout: c.checkout });
    assert.equal(stale.refreshed, false);
    assert.match(stale.error, /^git remote: fatal: /);
    assert.ok(stale.error.endsWith(why), stale.error);
    fs.renameSync(`${c.bare}.away`, c.bare);
    const other = { ...c.pool, id: 'github.com/dn-test/elsewhere', repo: 'elsewhere' };
    const failed = await mirrors.ensureMirror({ pool: other, checkout: c.checkout }).catch((e) => e);
    assert.match(failed.message, /^git clone: fatal: /);
    assert.ok(failed.message.endsWith(why.replace('iota was', 'elsewhere was')), failed.message);
    // With a remote on the forge nothing was guessed, and nothing is said of it.
    git(c.checkout, 'remote', 'set-url', 'origin', 'https://github.com/someone/iota.git');
    assert.match((await mirrors.ensureMirror({ pool: other, checkout: c.checkout }).catch((e) => e)).message, /^git clone: fatal: [^\n]*$/);
    assert.doesNotMatch((await mirrors.ensureMirror({ pool: other, checkout: c.checkout }).catch((e) => e)).message, /asked for over https/);
  });

  await check('a mirror that cannot be made is this machine\'s own fault, and nothing half made is left; what is no checkout says so', async () => {
    const c = repo('dn-test', 'delta');
    fs.renameSync(c.bare, `${c.bare}.away`);
    const failed = await mirrors.ensureMirror({ pool: c.pool, checkout: c.checkout }).catch((e) => e);
    assert.ok(failed instanceof OwnFault, String(failed));
    assert.match(String(failed), /^OwnFault: git clone: fatal: /);
    assert.equal(mirrors.path(c.pool), null);
    assert.deepEqual(fs.readdirSync(MIRRORS_DIR).filter((n) => n.includes('.tmp.')), [], 'nothing half-made is left');
    fs.renameSync(`${c.bare}.away`, c.bare);
    assert.equal((await mirrors.ensureMirror({ pool: c.pool, checkout: c.checkout })).refreshed, true, 'and it is made the next time');
    const kappa = repo('dn-test', 'kappa');
    const none = await mirrors.ensureMirror({ pool: kappa.pool, checkout: path.join(scratch, 'no-checkout') }).catch((e) => e);
    assert.ok(none instanceof OwnFault && /^git clone: fatal: [^\n]*no-checkout/.test(none.message), String(none));
  });

  await check('a mirror nobody has wanted for as long as one is kept goes at the sweep, but not from under a job that reads it, whenever that job came', async () => {
    const z = repo('dn-test', 'zeta');
    const said = [];
    const kept = createMirrors({ log: (...l) => said.push(l.join(' ')) });
    const { path: mirror } = await kept.ensureMirror({ pool: z.pool, checkout: z.checkout });
    age(mirror, 2);
    await kept.sweep([z.pool], DAY);
    assert.ok(Date.now() - fs.statSync(mirror).mtimeMs < 3600000, 'a wanted pool\'s mirror is as young as the last sweep');

    age(mirror, 2);
    const reading = kept.retain(z.pool);
    await kept.sweep([], DAY);
    assert.equal(kept.path(z.pool), mirror, 'read by a job');
    reading();
    // A job on its way when the sweep found the mirror stale: refreshed, then read.
    const refreshed = kept.ensureMirror({ pool: z.pool, checkout: z.checkout });
    const swept = kept.sweep([], DAY);
    await refreshed;
    const since = kept.retain(z.pool);
    await swept;
    assert.deepEqual([kept.path(z.pool), said.filter((l) => l.includes('removed'))], [mirror, []], 'read by a job that came since');
    since();
    age(mirror, 2);
    fs.mkdirSync(path.join(MIRRORS_DIR, 'notes'));
    age(path.join(MIRRORS_DIR, 'notes'), 2);
    await kept.sweep([], DAY);
    assert.deepEqual([kept.path(z.pool), fs.existsSync(mirror), fs.existsSync(path.join(MIRRORS_DIR, 'notes'))], [null, false, true], 'and nothing that is no mirror');
    assert.deepEqual(said.filter((l) => l.includes('removed')), [`mirror removed ${mirror}: no linked pool's mirror for 24 h`]);
  });

  await check('a mirror under the sixteen hex digits of an earlier version is never read, and goes at the sweep with what a clone left half made, linked pool or not', async () => {
    const e = repo('dn-test', 'epsilon');
    const old = path.join(MIRRORS_DIR, `${crypto.createHash('sha256').update(e.pool.id).digest('hex').slice(0, 16)}.git`);
    git(scratch, 'clone', '--quiet', '--mirror', e.bare, old);
    const halves = [`${old}.tmp.4242`, `${mirrorOf(e.pool)}.tmp.4242`];
    for (const half of halves) fs.mkdirSync(half);
    assert.equal(mirrors.path(e.pool), null);
    const made = await mirrors.ensureMirror({ pool: e.pool, checkout: e.checkout });
    assert.deepEqual([made.path, gitCalls().filter((c) => c.startsWith('clone') && c.includes('epsilon')).length], [mirrorOf(e.pool), 1], 'cloned anew, under the name mirrors have');
    await mirrors.sweep([e.pool], DAY);
    assert.deepEqual([old, ...halves].map((p) => fs.existsSync(p)), [true, true, true], 'not before it is as old as any mirror nobody wants');
    for (const p of [old, ...halves]) age(p, 2);
    await mirrors.sweep([e.pool], DAY);
    assert.deepEqual([old, ...halves].map((p) => fs.existsSync(p)), [false, false, false]);
    assert.equal(mirrors.path(e.pool), made.path);
  });

  console.log(`\nall ${checks} checks passed`);
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
