// The push check against real packs from a real git: what a push may move, proven in a
// quarantine that is always removed and never in the linked checkout.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { git, packOf, pushBody } from './lib/fake-forge.mjs';

// The quarantine is made under the temp directory; a private one shows what is left behind.
const scratch = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'dn-rp-'));
process.env.TMPDIR = path.join(scratch, 'tmp');
fs.mkdirSync(process.env.TMPDIR);
process.env.DN_PUSH_MAX_BYTES = String(2 * 2 ** 20);
const { checkAdvertise, checkPush, globMatch, parseReceivePack } = await import('../src/requester/receivepack.js');
const { authorize } = await import('../src/requester/authorize.js');

async function check(name, fn) {
  await fn();
  assert.deepEqual(fs.readdirSync(process.env.TMPDIR), [], `${name}: a quarantine was left behind`);
  console.log(`PASS ${name}`);
}

const ZERO = '0'.repeat(40);
const pkt = (text) => Buffer.concat([Buffer.from((Buffer.byteLength(text) + 4).toString(16).padStart(4, '0')), Buffer.from(text)]);
const FLUSH = Buffer.from('0000');

// The forge's repository, the requester's linked checkout (a clone that then falls
// behind) and the executor's clone, where the pushed commits are made.
const forge = path.join(scratch, 'forge.git');
const checkout = path.join(scratch, 'checkout');
const work = path.join(scratch, 'work');
fs.mkdirSync(forge);
git(forge, 'init', '--bare', '--quiet', '--initial-branch=main', '.');
git(forge, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
git(scratch, 'clone', '--quiet', forge, 'work');
const write = (file, text) => {
  fs.mkdirSync(path.dirname(path.join(work, file)), { recursive: true });
  fs.writeFileSync(path.join(work, file), text);
};
const commit = (message, files = {}) => {
  for (const [file, text] of Object.entries(files)) {
    if (text === null) fs.rmSync(path.join(work, file)); else write(file, text);
  }
  git(work, 'add', '-A');
  git(work, 'commit', '--quiet', '--allow-empty', '-m', message);
  return git(work, 'rev-parse', 'HEAD');
};
const at = (rev) => git(work, 'checkout', '--quiet', '--detach', rev);

const A = commit('root', { 'src/a.js': 'a\n', '.github/workflows/ci.yml': 'on: push\n', '.github/dependabot.yml': 'x\n' });
git(work, 'push', '--quiet', forge, `${A}:refs/heads/main`);
const B = commit('feature work', { 'src/a.js': 'b\n' });
git(work, 'push', '--quiet', forge, `${B}:refs/heads/feature`);
git(scratch, 'clone', '--quiet', forge, 'checkout');
// The base branch moves on, workflow included, after the checkout was made.
at(A);
const M = commit('base moves on', { '.github/workflows/ci.yml': 'on: [push, pull_request]\n', 'src/base.js': 'm\n' });
git(work, 'push', '--quiet', forge, `${M}:refs/heads/main`);

const snapshot = (dir) => fs.readdirSync(dir, { recursive: true }).sort().map((f) => `${f} ${fs.statSync(path.join(dir, f)).size}`).join('\n');
const checkoutBefore = snapshot(checkout);

let fetches = [];
const ctxFor = (more = {}) => ({
  checkout,
  state: { branches: [] },
  async pull(number) { return number === 578 ? { number, open: true, author: 'me', headRepo: 'o/r', headRef: 'feature' } : null; },
  async pullsByHead({ repo, ref }) { return repo === 'o/r' && (ref === undefined || ref === 'feature') ? [{ number: 578, open: true, author: 'me', headRepo: 'o/r', headRef: 'feature' }] : []; },
  async currentRef(repo, ref) {
    try { return git(forge, 'rev-parse', '--verify', '--quiet', ref); } catch { return null; }
  },
  // What forge.fetchInto does, from a directory instead of a URL.
  fetch({ repo, env, wants = [], all = false }) {
    fetches.push(all ? 'all' : wants.length);
    assert.equal(repo, 'o/r');
    return new Promise((resolve) => {
      execFile('git', ['fetch', '--quiet', '--no-tags', '--no-write-fetch-head', forge, ...(all ? ['+refs/heads/*:refs/dn/*'] : wants)], { env }, (err) => resolve(!err));
    });
  },
  ...more,
});

const HEAD_RULE = { git: 'receive-pack', repo: 'o/r', head: { number: 578 }, denyPaths: ['.github/workflows/**'] };
const NEW_RULE = { git: 'receive-pack', repo: 'o/r', refs: ['refs/heads/**'], create: 1, denyPaths: ['.github/workflows/**'] };
const SEGMENTS = ['o', 'r.git', 'git-receive-pack'];
// A push of `commands` ([old, new, ref]) with the pack a client would build for them.
const push = (rule, commands, ctx = ctxFor(), { pack, caps, thin } = {}) => {
  const body = pushBody(commands, pack ?? packOf(work, commands.map((c) => c[1]).filter((oid) => oid !== ZERO), [A, B, M], { thin }), caps);
  return checkPush(rule, SEGMENTS, body, ctx);
};
async function refused(promise, pattern) {
  const verdict = await promise;
  assert.equal(verdict.ok, false, 'the push was allowed');
  assert.match(verdict.reason, pattern);
}
async function allowed(promise) {
  const verdict = await promise;
  assert.equal(verdict.ok, true, verdict.reason);
  return verdict;
}

await check('the command list is read exactly: capabilities, push options, shallow lines, both object formats', async () => {
  const one = `${ZERO} ${B} refs/heads/x`;
  const pack = packOf(work, [B], [A]);
  const parsed = parseReceivePack(Buffer.concat([pkt(`${one}\0 report-status-v2 side-band-64k object-format=sha1 agent=git/2.39.5\n`), pkt(`${A} ${B} refs/heads/y\n`), FLUSH, pack]));
  assert.deepEqual(parsed.commands, [{ old: ZERO, new: B, ref: 'refs/heads/x' }, { old: A, new: B, ref: 'refs/heads/y' }]);
  assert.deepEqual(parsed.caps, ['report-status-v2', 'side-band-64k', 'object-format=sha1', 'agent=git/2.39.5']);
  assert.equal(parsed.format, 'sha1');
  assert.deepEqual(parsed.pack, pack);
  const withOptions = parseReceivePack(Buffer.concat([pkt(`shallow ${A}\n`), pkt(`${one}\0push-options\n`), FLUSH, pkt('merge_request.create\n'), pkt('ci.skip'), FLUSH, pack]));
  assert.deepEqual(withOptions.options, ['merge_request.create', 'ci.skip']);
  assert.deepEqual(withOptions.shallow, [A]);
  const z = '0'.repeat(64);
  const n = 'ab'.repeat(32);
  assert.equal(parseReceivePack(Buffer.concat([pkt(`${z} ${n} refs/heads/x\0object-format=sha256`), FLUSH])).format, 'sha256');

  const bad = [
    [Buffer.from(''), /pkt-line length/],
    [FLUSH, /no ref command/],
    [Buffer.from('zzzz'), /pkt-line length/],
    [Buffer.from('00FF'), /pkt-line length/],
    [Buffer.from('0001'), /impossible length/],
    [Buffer.from('0004'), /impossible length/],
    [Buffer.from(`0100${one}`), /impossible length/],
    [Buffer.concat([pkt(one)]), /pkt-line length/],
    [Buffer.concat([pkt(`${one}\n`), pkt(`${A} ${B} refs/heads/y\0report-status\n`), FLUSH]), /capabilities on a later command/],
    [Buffer.concat([pkt(one), pkt(`${A} ${B} refs/heads/x`), FLUSH]), /named twice/],
    [Buffer.concat([pkt(`${ZERO} ${B}  refs/heads/x`), FLUSH]), /would not accept/],
    [Buffer.concat([pkt(`${ZERO} ${B.toUpperCase()} refs/heads/x`), FLUSH]), /malformed ref command/],
    [Buffer.concat([pkt(`${ZERO} ${B.slice(1)} refs/heads/x`), FLUSH]), /malformed ref command/],
    [Buffer.concat([pkt(`${ZERO} ${B}`), FLUSH]), /malformed ref command/],
    [Buffer.concat([pkt(`${z} ${n} refs/heads/x`), FLUSH]), /declared object format/],
    [Buffer.concat([pkt(`${one}\0object-format=sha256`), FLUSH]), /declared object format/],
    [Buffer.concat([pkt(one), pkt(`${z} ${n} refs/heads/y`), FLUSH]), /two lengths/],
    [Buffer.concat([pkt(one), FLUSH, Buffer.from('garbage after the flush')]), /not a pack/],
    [Buffer.concat([pkt(one), FLUSH, Buffer.from('PACK\0\0\0\x04\0\0\0\0')]), /not a pack/],
    [Buffer.concat([pkt(one), FLUSH, Buffer.from('PACK')]), /not a pack/],
    [Buffer.concat([...Array.from({ length: 65 }, (_, i) => pkt(`${ZERO} ${B} refs/heads/b${i}`)), FLUSH]), /too many/],
  ];
  for (const [body, pattern] of bad) assert.throws(() => parseReceivePack(body), pattern, body.toString('latin1').slice(0, 80));
  for (const ref of ['HEAD', 'refs/heads/a..b', 'refs/heads/x.lock', 'refs/heads/a b', 'refs/heads/', 'refs/heads/.hidden', 'refs/heads/a//b', 'refs/heads/a~1', 'refs/heads/a^', 'refs/heads/a:b',
    'refs/heads/a?', 'refs/heads/a*', 'refs/heads/a[', 'refs/heads/a\\b', 'refs/heads/a@{1}', 'refs/heads/a.', 'heads/x', 'refs/heads/a\tb', 'refs/heads/a\u007f']) {
    assert.throws(() => parseReceivePack(Buffer.concat([pkt(`${ZERO} ${B} ${ref}`), FLUSH])), /would not accept|malformed ref command/, ref);
  }
});

await check('a glob\'s "*" stays inside one part and "**" spans any number', async () => {
  const table = [
    ['refs/heads/**', 'refs/heads/a', true], ['refs/heads/**', 'refs/heads/a/b/c', true], ['refs/heads/**', 'refs/heads', true], ['refs/heads/**', 'refs/tags/a', false],
    ['refs/heads/**', 'refs/headsx/a', false], ['refs/heads/*', 'refs/heads/a', true], ['refs/heads/*', 'refs/heads/a/b', false], ['refs/heads/fix-*', 'refs/heads/fix-1', true],
    ['refs/heads/fix-*', 'refs/heads/fix-1/x', false], ['refs/heads/fix-*', 'refs/heads/prefix-1', false], ['.github/workflows/**', '.github/workflows/ci.yml', true],
    ['.github/workflows/**', '.github/workflows/sub/ci.yml', true], ['.github/workflows/**', 'xgithub/workflows/ci.yml', false], ['.github/workflows/**', '.github/dependabot.yml', false],
    ['.gitlab-ci.yml', '.gitlab-ci.yml', true], ['.gitlab-ci.yml', 'xgitlab-ci.yml', false], ['.gitlab-ci.yml', 'sub/.gitlab-ci.yml', false], ['**/*.yml', 'a/b/c.yml', true], ['a/**/z', 'a/z', true],
    ['a/**/z', 'a/b/c/z', true], ['a/**/z', 'a/b/c', false], ['a+b', 'aab', false], ['a(b)', 'a(b)', true],
  ];
  for (const [pattern, text, want] of table) assert.equal(globMatch(pattern, text), want, `${pattern} ~ ${text}`);
});

await check('a fast-forward of the pull request\'s head branch is allowed, from a stale checkout too', async () => {
  at(B);
  const C = commit('more work', { 'src/a.js': 'c\n' });
  fetches = [];
  assert.deepEqual(await allowed(push(HEAD_RULE, [[B, C, 'refs/heads/feature']])), { ok: true, created: [] });
  await allowed(push(HEAD_RULE, [[B, C, 'refs/heads/feature']], ctxFor(), { thin: true }));
  // The checkout has never seen the base branch's newest commit; a merge of it is still provable.
  at(C);
  git(work, 'merge', '--quiet', '--no-edit', M);
  const merged = git(work, 'rev-parse', 'HEAD');
  fetches = [];
  await allowed(push(HEAD_RULE, [[B, merged, 'refs/heads/feature']]));
  assert.ok(fetches.length > 0, 'the base commit was fetched into the quarantine');
  // The same rule, covering every open pull request of an author.
  await allowed(push({ ...HEAD_RULE, head: { author: 'me' } }, [[B, C, 'refs/heads/feature']]));
  await refused(push({ ...HEAD_RULE, head: { author: 'them' } }, [[B, C, 'refs/heads/feature']]), /no open pull request by them/);
});

await check('a push that would discard commits, delete a ref or move a ref outside the rule is refused', async () => {
  at(A);
  const rewritten = commit('rewritten history', { 'src/a.js': 'other\n' });
  await refused(push(HEAD_RULE, [[B, rewritten, 'refs/heads/feature']]), /not a fast-forward/);
  await refused(push(HEAD_RULE, [[B, A, 'refs/heads/feature']], ctxFor(), { pack: packOf(work, [], []) }), /not a fast-forward/);
  await refused(push(HEAD_RULE, [[B, ZERO, 'refs/heads/feature']], ctxFor(), { pack: Buffer.alloc(0) }), /may not delete a ref/);
  await refused(push(HEAD_RULE, [[B, ZERO, 'refs/heads/feature']], ctxFor(), { pack: packOf(work, [], []) }), /may not delete a ref/);
  await refused(push(NEW_RULE, [[M, ZERO, 'refs/heads/main']], ctxFor(), { pack: packOf(work, [], []) }), /may not delete a ref/);
  at(M);
  const onMain = commit('straight to main', { 'src/base.js': 'x\n' });
  at(B);
  const C = commit('again', { 'src/a.js': 'c2\n' });
  await refused(push(HEAD_RULE, [[M, onMain, 'refs/heads/main']]), /refs\/heads\/main: this task may not update that ref/);
  await refused(push(NEW_RULE, [[M, onMain, 'refs/heads/main']]), /may not update that ref/);
  await refused(push(NEW_RULE, [[B, C, 'refs/heads/feature']]), /may not update that ref/);
  // One allowed command does not carry a second one through.
  await refused(push(HEAD_RULE, [[B, C, 'refs/heads/feature'], [M, onMain, 'refs/heads/main']]), /refs\/heads\/main: this task may not update/);
  await refused(push(HEAD_RULE, [[B, C, 'refs/heads/feature'], [M, ZERO, 'refs/heads/main']]), /may not delete a ref/);
  await refused(push(HEAD_RULE, [[B, C, 'refs/heads/feature'], [ZERO, C, 'refs/tags/v1']]), /may not create that ref/);
  for (const ref of ['refs/tags/v1', 'refs/pull/578/head', 'refs/pull/578/merge', 'refs/notes/commits', 'refs/remotes/origin/main', 'refs/meta/config', 'refs/headsx/a']) {
    await refused(push(NEW_RULE, [[ZERO, C, ref]]), /may not create that ref/);
    await refused(push(HEAD_RULE, [[B, C, ref]]), /may not update that ref/);
  }
  // A creation where the rule allows only updates.
  await refused(push(HEAD_RULE, [[ZERO, C, 'refs/heads/brand-new']]), /may not create that ref/);
  await refused(push({ ...NEW_RULE, create: 0 }, [[ZERO, C, 'refs/heads/brand-new']]), /may not create that ref/);
  // Claiming a branch is new when the forge has it, or old when it moved.
  await refused(push(NEW_RULE, [[ZERO, C, 'refs/heads/feature']]), /not where this push starts from/);
  await refused(push(HEAD_RULE, [[A, C, 'refs/heads/feature']]), /not where this push starts from/);
});

await check('a new branch is allowed where the rule creates, and only a branch the key created may then move', async () => {
  at(M);
  const fix = commit('fix 421', { 'src/fix.js': 'f\n' });
  assert.deepEqual((await allowed(push(NEW_RULE, [[ZERO, fix, 'refs/heads/fix-421']]))).created, ['refs/heads/fix-421']);
  assert.deepEqual((await allowed(push(NEW_RULE, [[ZERO, M, 'refs/heads/from-main']], ctxFor(), { pack: packOf(work, [], []) }))).created, ['refs/heads/from-main'], 'a branch at a commit the forge has');
  git(work, 'push', '--quiet', forge, `${fix}:refs/heads/fix-421`);
  const more = commit('fix 421 more', { 'src/fix.js': 'g\n' });
  await refused(push(NEW_RULE, [[fix, more, 'refs/heads/fix-421']]), /may not update that ref/);
  await allowed(push(NEW_RULE, [[fix, more, 'refs/heads/fix-421']], ctxFor({ state: { branches: ['refs/heads/fix-421'] } })));

  // Through authorize, creations are counted against the key.
  const rules = [{ host: 'github.com', method: 'POST', path: '/o/r.git/git-receive-pack', ...NEW_RULE }];
  const send = (commands, ctx) => authorize(rules, {
    host: 'github.com', method: 'POST', path: '/o/r.git/git-receive-pack', headers: { 'content-type': 'application/x-git-receive-pack-request' },
    body: pushBody(commands, packOf(work, [more], [M])).toString('base64'),
  }, ctx);
  const ctx = ctxFor();
  assert.equal((await send([[ZERO, more, 'refs/heads/one']], ctx)).ok, true);
  assert.deepEqual(ctx.state.branches, ['refs/heads/one']);
  assert.match((await send([[ZERO, more, 'refs/heads/two']], ctx)).reason, /may create 1 branch\(es\) and no more/);
  assert.match((await send([[ZERO, more, 'refs/heads/a'], [ZERO, more, 'refs/heads/b']], ctxFor())).reason, /may create 1 branch/);
  assert.deepEqual(ctx.state.branches, ['refs/heads/one']);
  assert.match((await authorize(rules, { host: 'github.com', method: 'POST', path: '/o/r.git/git-receive-pack', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: '' }, ctx)).reason, /must be sent as/);
  git(forge, 'update-ref', '-d', 'refs/heads/fix-421');
});

await check('a push may not write a workflow file, in its tip or in any commit on the way', async () => {
  at(B);
  const evil = commit('add a workflow', { '.github/workflows/steal.yml': 'on: push\njobs: {}\n' });
  await refused(push(HEAD_RULE, [[B, evil, 'refs/heads/feature']]), /changes \.github\/workflows\/steal\.yml/);
  await refused(push(NEW_RULE, [[ZERO, evil, 'refs/heads/x']]), /changes \.github\/workflows\/steal\.yml/);
  // Written, then taken back: the tip is clean and the commit before it is not.
  const reverted = commit('take it back', { '.github/workflows/steal.yml': null });
  await refused(push(HEAD_RULE, [[B, reverted, 'refs/heads/feature']]), /changes \.github\/workflows\/steal\.yml/);
  at(B);
  const edited = commit('edit ci', { '.github/workflows/ci.yml': 'on: push\njobs: { leak: {} }\n' });
  await refused(push(HEAD_RULE, [[B, edited, 'refs/heads/feature']]), /changes \.github\/workflows\/ci\.yml/);
  at(B);
  await refused(push(HEAD_RULE, [[B, commit('nested', { '.github/workflows/sub/dir/x.yaml': 'x\n' }), 'refs/heads/feature']]), /changes \.github\/workflows\/sub\/dir\/x\.yaml/);
  at(B);
  await refused(push(HEAD_RULE, [[B, commit('odd name', { '.github/workflows/é "q".yml': 'x\n' }), 'refs/heads/feature']]), /changes \.github\/workflows\/é "q"\.yml/);
  // A merge that resolves a workflow file to something neither side holds.
  at(B);
  git(work, 'merge', '--quiet', '--no-commit', M);
  const resolved = commit('evil merge', { '.github/workflows/ci.yml': 'on: push\njobs: { leak: {} }\n' });
  await refused(push(HEAD_RULE, [[B, resolved, 'refs/heads/feature']]), /changes \.github\/workflows\/ci\.yml/);
  // A history with no parent on the forge brings its own workflow files.
  git(work, 'checkout', '--quiet', '--orphan', 'unrelated');
  const root = commit('unrelated root');
  await refused(push(NEW_RULE, [[ZERO, root, 'refs/heads/unrelated']], ctxFor(), { pack: packOf(work, [root], []) }), /changes \.github\/workflows\/ci\.yml/);

  // What is not a workflow, deleting one, and a merge that brings the base branch's along.
  at(B);
  await allowed(push(HEAD_RULE, [[B, commit('other .github file', { '.github/dependabot.yml': 'y\n', 'github/workflows/x.yml': 'x\n' }), 'refs/heads/feature']]));
  at(B);
  await allowed(push(HEAD_RULE, [[B, commit('drop ci', { '.github/workflows/ci.yml': null }), 'refs/heads/feature']]));
  at(B);
  git(work, 'merge', '--quiet', '--no-edit', M);
  await allowed(push(HEAD_RULE, [[B, git(work, 'rev-parse', 'HEAD'), 'refs/heads/feature']]));
  // A rule without denyPaths takes the workflow.
  await allowed(push({ ...HEAD_RULE, denyPaths: undefined }, [[B, evil, 'refs/heads/feature']]));
});

await check('a commit the forge hands out by id but holds on no branch is not a base to build on', async () => {
  // A forge that shares objects between forks serves a fork's commits by id from here too.
  at(B);
  const foreign = commit('pushed to a fork', { '.github/workflows/steal.yml': 'on: push\n' });
  git(work, 'push', '--quiet', forge, `${foreign}:refs/pull/9/head`);
  const empty = packOf(work, [], []);
  await refused(push(NEW_RULE, [[ZERO, foreign, 'refs/heads/x']], ctxFor(), { pack: empty }), /no branch of this repository holds/);
  await refused(push(HEAD_RULE, [[B, foreign, 'refs/heads/feature']], ctxFor(), { pack: empty }), /no branch of this repository holds/);
  const onTop = commit('innocent child', { 'src/a.js': 'z\n' });
  await refused(push(HEAD_RULE, [[B, onTop, 'refs/heads/feature']], ctxFor(), { pack: packOf(work, [onTop], [foreign]) }), /no branch of this repository holds/);
  git(forge, 'update-ref', '-d', 'refs/pull/9/head');
});

await check('what cannot be proven is refused: a missing old value, a broken pack, objects that are nowhere', async () => {
  at(B);
  const C = commit('work', { 'src/a.js': 'c3\n' });
  const offline = (more = {}) => ctxFor({ fetch: undefined, ...more });
  // The checkout knows B, so no forge is needed for this proof - but the workflow check wants its branches.
  await refused(push(HEAD_RULE, [[B, C, 'refs/heads/feature']], offline()), /branches could not be fetched/);
  await allowed(push({ ...HEAD_RULE, denyPaths: undefined }, [[B, C, 'refs/heads/feature']], offline()));
  at(M);
  const onBase = commit('on the new base', { 'src/a.js': 'd\n' });
  // The checkout has never seen the forge's main, and nothing can fetch it.
  const mainIsOwn = { state: { branches: ['refs/heads/main'] } };
  await refused(push({ ...NEW_RULE, denyPaths: undefined }, [[M, onBase, 'refs/heads/main']], offline(mainIsOwn)), /old value cannot be found/);
  await allowed(push({ ...NEW_RULE, denyPaths: undefined }, [[M, onBase, 'refs/heads/main']], ctxFor(mainIsOwn)));
  await refused(push({ ...HEAD_RULE, denyPaths: undefined }, [[B, C, 'refs/heads/feature']], offline({ checkout: undefined })), /cannot be found/);
  await refused(push({ ...HEAD_RULE, denyPaths: undefined }, [[B, C, 'refs/heads/feature']], offline({ checkout: path.join(scratch, 'nowhere') })), /cannot be found/);

  const good = packOf(work, [C], [B]);
  const broken = Buffer.from(good);
  broken[broken.length - 30] ^= 0xff;
  await refused(push(HEAD_RULE, [[B, C, 'refs/heads/feature']], ctxFor(), { pack: broken }), /could not be indexed/);
  await refused(push(HEAD_RULE, [[B, C, 'refs/heads/feature']], ctxFor(), { pack: good.subarray(0, good.length - 25) }), /could not be indexed/);
  await refused(push(HEAD_RULE, [[B, 'ab'.repeat(20), 'refs/heads/feature']], ctxFor(), { pack: good }), /not a commit the push carries or the forge has/);
  const tree = git(work, 'rev-parse', `${C}^{tree}`);
  await refused(push(HEAD_RULE, [[B, tree, 'refs/heads/feature']], ctxFor(), { pack: good }), /not a commit/);
  await refused(push(HEAD_RULE, [[B, C, 'refs/heads/feature']], ctxFor(), { pack: Buffer.alloc(0) }), /carries no pack/);
  await refused(checkPush(HEAD_RULE, SEGMENTS, Buffer.from('0000'), ctxFor()), /not a well-formed push/);
  await refused(checkPush(HEAD_RULE, SEGMENTS, Buffer.concat([pushBody([[B, C, 'refs/heads/feature']], good), Buffer.alloc(2 * 2 ** 20)]), ctxFor()), /larger than a task may send/);
  await refused(push(HEAD_RULE, [[B, C, 'refs/heads/feature']], ctxFor({ pull: undefined })), /nothing here can look a pull request up/);
  await refused(push(NEW_RULE, [[ZERO, C, 'refs/heads/x']], ctxFor({ currentRef: undefined })), /nothing here can ask the forge where a branch is/);
});

await check('push options are refused, and a push is confined to the repository its rule names', async () => {
  at(B);
  const C = commit('work', { 'src/a.js': 'c4\n' });
  const pack = packOf(work, [C], [B]);
  const withOptions = Buffer.concat([pkt(`${B} ${C} refs/heads/feature\0report-status push-options\n`), FLUSH, pkt('merge_request.merge_when_pipeline_succeeds'), FLUSH, pack]);
  await refused(checkPush(HEAD_RULE, SEGMENTS, withOptions, ctxFor()), /push options are not allowed/);
  const body = pushBody([[ZERO, C, 'refs/heads/x']], pack);
  await refused(checkPush(NEW_RULE, ['o', 'other.git', 'git-receive-pack'], body, ctxFor()), /not the pool's repository/);
  await refused(checkPush(NEW_RULE, ['victim', 'r', 'git-receive-pack'], body, ctxFor()), /not the pool's repository/);
  await allowed(checkPush(NEW_RULE, ['O', 'R', 'git-receive-pack'], body, ctxFor()));
  assert.deepEqual(await checkAdvertise(NEW_RULE, ['o', 'r.git', 'info', 'refs']), { ok: true });
  await refused(checkAdvertise(NEW_RULE, ['o', 'other.git', 'info', 'refs']), /not the pool's repository/);
  await allowed(checkAdvertise(HEAD_RULE, ['o', 'r.git', 'info', 'refs'], ctxFor()));
  await refused(checkAdvertise(HEAD_RULE, ['me', 'r.git', 'info', 'refs'], ctxFor()), /does not hold the head branch/);
  await refused(checkAdvertise({ ...HEAD_RULE, head: { author: 'me' } }, ['me', 'r', 'info', 'refs'], ctxFor()), /no open pull request by me/);
});

await check('the linked checkout is read and never written', async () => {
  assert.equal(snapshot(checkout), checkoutBefore);
  assert.equal(git(checkout, 'status', '--porcelain'), '');
});

fs.rmSync(scratch, { recursive: true, force: true });
