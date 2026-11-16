// The push check against real packs from a real git: what a push may move, proven in a
// quarantine that is always removed and never in the linked checkout.

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFile, execFileSync } from 'node:child_process';
import { git, packOf, pushBody } from './lib/fake-forge.mjs';

// The quarantine is made under the temp directory; a private one shows what is left behind.
const scratch = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'dn-rp-'));
process.env.TMPDIR = path.join(scratch, 'tmp');
fs.mkdirSync(process.env.TMPDIR);
process.env.DN_PUSH_MAX_BYTES = String(2 * 2 ** 20);
process.env.DN_PUSH_UNPACKED_MAX_BYTES = String(8 * 2 ** 20);
// The git the check runs, behind a switch: while the file `gitFails` exists, a command
// whose arguments start with its text exits the way a git that broke or was killed does.
const gitFails = path.join(scratch, 'git-fails');
process.env.DN_GIT = path.join(scratch, 'git-or-not');
fs.writeFileSync(process.env.DN_GIT, `#!/bin/sh\nif [ -e '${gitFails}' ]; then case "$*" in "$(cat '${gitFails}')"*) exit 128;; esac; fi\nexec git "$@"\n`, { mode: 0o755 });
const { checkAdvertise, checkPush, globMatch, parseReceivePack, pushReport } = await import('../src/requester/receivepack.js');
const { authorize, conclude } = await import('../src/requester/authorize.js');

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
// The task account's fork, behind the repository from here on. Pull request 581 is from its `feature`.
const forkGit = path.join(scratch, 'fork.git');
git(scratch, 'clone', '--quiet', '--bare', forge, 'fork.git');
git(forkGit, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
// The base branch moves on, workflow included, after the checkout was made.
at(A);
const M = commit('base moves on', { '.github/workflows/ci.yml': 'on: [push, pull_request]\n', 'src/base.js': 'm\n' });
git(work, 'push', '--quiet', forge, `${M}:refs/heads/main`);

const snapshot = (dir) => fs.readdirSync(dir, { recursive: true }).sort().map((f) => `${f} ${fs.statSync(path.join(dir, f)).size}`).join('\n');
const checkoutBefore = snapshot(checkout);

const POOL = { id: 1, name: 'o/r', owner: 'o', parent: '', defaultBranch: 'main', ciPaths: [] };
const FORK = { id: 12, name: 'me/r', owner: 'me', parent: 'o/r', defaultBranch: 'main', ciPaths: [] };
const PULLS = [
  { number: 578, open: true, author: 'me', headRepo: 'o/r', headRepoId: 1, headRef: 'feature' },
  { number: 581, open: true, author: 'me', headRepo: 'me/r', headRepoId: 12, headRef: 'feature' },
];

let fetches = [];
let asked = [];
const ctxFor = (more = {}) => ({
  checkout,
  state: { branches: [] },
  async pull(number) { return PULLS.find((p) => p.number === number) ?? null; },
  async pullsByHead(ref, owner) {
    asked.push(`pulls ${ref} ${owner}`);
    return PULLS.filter((p) => ref === undefined || ref === p.headRef);
  },
  async repository(of) {
    asked.push(`repository ${of}`);
    return { undefined: POOL, 'me/r': FORK }[of] ?? null;
  },
  async branch(ref, of) {
    asked.push(`branch ${ref} ${of}`);
    try { return { sha: git(of === undefined ? forge : forkGit, 'rev-parse', '--verify', '--quiet', ref), protected: false }; } catch { return null; }
  },
  // What forge.fetchInto does, from a directory instead of a URL.
  fetch({ env, repo, wants = [], into }) {
    fetches.push(`${repo ?? 'pool'} ${into ?? wants.length}`);
    return new Promise((resolve) => {
      execFile('git', ['fetch', '--quiet', '--no-tags', '--no-write-fetch-head', repo === undefined ? forge : forkGit, ...(into ? [`+refs/heads/*:${into}/*`] : wants)], { env }, (err) => resolve(!err));
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
// A task's state as `authorize` keeps it, with `more` in it.
const stateOf = (more) => ({ branches: [], reserved: [], sent: {}, pulls: [], asked: [], ...more });
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

await check('the command list is read exactly: capabilities, push options, both object formats', async () => {
  const one = `${ZERO} ${B} refs/heads/x`;
  const pack = packOf(work, [B], [A]);
  const parsed = parseReceivePack(Buffer.concat([pkt(`${one}\0 report-status-v2 side-band-64k object-format=sha1 agent=git/2.39.5\n`), pkt(`${A} ${B} refs/heads/y\n`), FLUSH, pack]));
  assert.deepEqual(parsed.commands, [{ old: ZERO, new: B, ref: 'refs/heads/x' }, { old: A, new: B, ref: 'refs/heads/y' }]);
  assert.deepEqual(parsed.caps, ['report-status-v2', 'side-band-64k', 'object-format=sha1', 'agent=git/2.39.5']);
  assert.equal(parsed.format, 'sha1');
  assert.deepEqual(parsed.pack, pack);
  const withOptions = parseReceivePack(Buffer.concat([pkt(`${one}\0push-options\n`), FLUSH, pkt('merge_request.create\n'), pkt('ci.skip'), FLUSH, pack]));
  assert.deepEqual(withOptions.options, ['merge_request.create', 'ci.skip']);
  assert.deepEqual(Object.keys(withOptions).sort(), ['caps', 'commands', 'format', 'options', 'pack']);
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

await check('a push carries no shallow line, and a ref name is the bytes the forge will read', async () => {
  const one = `${ZERO} ${B} refs/heads/x`;
  assert.throws(() => parseReceivePack(Buffer.concat([pkt(`shallow ${A}\n`), pkt(`${one}\0report-status\n`), FLUSH])), /a shallow line/);
  assert.throws(() => parseReceivePack(Buffer.concat([pkt(`${one}\0report-status\n`), pkt(`shallow ${A}\n`), FLUSH])), /a shallow line|malformed ref command/);
  // Two byte strings that are not UTF-8 would both decode to the same replacement character:
  // one name here, two different refs at the forge.
  const raw = (bytes) => Buffer.concat([Buffer.from(`${ZERO} ${B} refs/heads/a`), Buffer.from(bytes), Buffer.from('\0report-status\n')]);
  const line = (payload) => Buffer.concat([Buffer.from((payload.length + 4).toString(16).padStart(4, '0')), payload, FLUSH]);
  for (const bytes of [[0xff], [0xfe], [0xc3], [0xc3, 0x28], [0xed, 0xa0, 0x80], [0xc0, 0xaf]]) assert.throws(() => parseReceivePack(line(raw(bytes))), /not UTF-8/, bytes.join(' '));
  assert.equal(parseReceivePack(line(raw([0xc3, 0xa9]))).commands[0].ref, 'refs/heads/aé');
  // A capability that is not UTF-8 is no better.
  assert.throws(() => parseReceivePack(line(Buffer.concat([Buffer.from(`${one}\0report-status agent=`), Buffer.from([0xff]), Buffer.from('\n')]))), /not UTF-8/);
  await refused(push(NEW_RULE, [[ZERO, B, 'refs/heads/x']], ctxFor(), { pack: Buffer.alloc(0) }), /carries no pack/);
  const shallow = Buffer.concat([pkt(`shallow ${A}\n`), pushBody([[ZERO, B, 'refs/heads/x']], packOf(work, [B], [A]))]);
  await refused(checkPush(NEW_RULE, SEGMENTS, shallow, ctxFor()), /not a well-formed push: a shallow line/);
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

await check('a new branch is allowed where the rule creates, and only a branch the task created may then move', async () => {
  at(M);
  const fix = commit('fix 421', { 'src/fix.js': 'f\n' });
  assert.deepEqual((await allowed(push(NEW_RULE, [[ZERO, fix, 'refs/heads/fix-421']]))).created, [{ branch: 'refs/heads/fix-421', sha: fix }]);
  assert.deepEqual((await allowed(push(NEW_RULE, [[ZERO, M, 'refs/heads/from-main']], ctxFor(), { pack: packOf(work, [], []) }))).created, [{ branch: 'refs/heads/from-main', sha: M }], 'a branch at a commit the forge has');
  git(work, 'push', '--quiet', forge, `${fix}:refs/heads/fix-421`);
  const more = commit('fix 421 more', { 'src/fix.js': 'g\n' });
  await refused(push(NEW_RULE, [[fix, more, 'refs/heads/fix-421']]), /may not update that ref/);
  await allowed(push(NEW_RULE, [[fix, more, 'refs/heads/fix-421']], ctxFor({ state: { branches: ['refs/heads/fix-421'] } })));

  // Through authorize, creations are counted against the task, and the forge's report says which became its own.
  const rules = [{ host: 'github.com', method: 'POST', path: '/o/r.git/git-receive-pack', ...NEW_RULE, create: 2 }];
  const send = (commands, ctx) => authorize(rules, {
    host: 'github.com', method: 'POST', path: '/o/r.git/git-receive-pack', headers: { 'content-type': 'application/x-git-receive-pack-request' },
    body: pushBody(commands, packOf(work, [more], [M])).toString('base64'),
  }, ctx);
  const ctx = ctxFor();
  const report = (...lines) => Buffer.concat([...lines.map((l) => pkt(`${l}\n`)), FLUSH]);
  const band = (n, data) => Buffer.concat([Buffer.from((data.length + 5).toString(16).padStart(4, '0')), Buffer.from([n]), data]);
  const one = await send([[ZERO, more, 'refs/heads/one']], ctx);
  assert.equal(one.ok, true);
  assert.deepEqual(ctx.state, stateOf({ reserved: ['refs/heads/one'], sent: { 'refs/heads/one': more } }), 'counted, and not yet its own');
  const pair = await send([[ZERO, more, 'refs/heads/two'], [ZERO, more, 'refs/heads/three']], ctx);
  assert.match(pair.reason, /may create 2 branch\(es\); it has refs\/heads\/one/);
  assert.match((await send([[ZERO, more, 'refs/heads/a'], [ZERO, more, 'refs/heads/b'], [ZERO, more, 'refs/heads/c']], ctxFor())).reason, /may create 2 branch\(es\); it has none/);
  assert.deepEqual(ctx.state.reserved, ['refs/heads/one']);
  const two = await send([[ZERO, more, 'refs/heads/two']], ctx);
  assert.deepEqual(ctx.state.reserved, ['refs/heads/one', 'refs/heads/two']);
  // The forge took one and declined the other.
  conclude(one.request, { status: 200, body: Buffer.concat([band(2, Buffer.from('ok refs/heads/two\n')), band(1, report('unpack ok', 'ok refs/heads/one')), FLUSH]) });
  conclude(two.request, { status: 200, body: report('unpack ok', 'ng refs/heads/two pre-receive hook declined') });
  assert.deepEqual(ctx.state, stateOf({ branches: ['refs/heads/one'] }), 'what a hook prints beside the report is not the report');
  // Answers that do not say: the creation stays counted and is not owned.
  const unsure = [
    undefined, { status: 500, body: report('unpack ok', 'ok refs/heads/two') }, { status: 302, body: Buffer.alloc(0) }, { status: 200, body: Buffer.from('<html>ok refs/heads/two</html>') },
    { status: 200, body: report('unpack ok') }, { status: 200, body: report('ok refs/heads/two') }, { status: 200, body: report('unpack ok', 'ok refs/heads/two', 'ng refs/heads/two x') },
    { status: 200, body: report('unpack index-pack failed', 'ok refs/heads/two') }, { status: 200, body: report('unpack ok', 'ok refs/heads/two', 'what is this') },
    { status: 200, body: Buffer.concat([band(1, report('unpack ok', 'ok refs/heads/two').subarray(0, 20)), FLUSH]) }, { status: 200, body: report('unpack ok', 'ok refs/heads/twofold') },
  ];
  for (const answer of unsure) {
    conclude((await send([[ZERO, more, 'refs/heads/two']], ctx)).request, answer);
    assert.deepEqual(ctx.state, stateOf({ branches: ['refs/heads/one'], reserved: ['refs/heads/two'], sent: { 'refs/heads/two': more } }), JSON.stringify(answer?.body?.toString()));
  }
  // The same creation sent while the first is on its way is the one already counted, and
  // the forge declining it gives nothing back: the first may be why.
  const first = await send([[ZERO, more, 'refs/heads/two']], ctx);
  conclude((await send([[ZERO, more, 'refs/heads/two']], ctx)).request, { status: 200, body: report('unpack ok', 'ng refs/heads/two already exists') });
  conclude((await send([[ZERO, more, 'refs/heads/two']], ctx)).request, { status: 403, body: Buffer.alloc(0) });
  assert.deepEqual(ctx.state.reserved, ['refs/heads/two']);
  assert.match((await send([[ZERO, more, 'refs/heads/other']], ctx)).reason, /may create 2 branch\(es\); it has refs\/heads\/one, refs\/heads\/two/);
  // The forge's "ok", in the newer report too, makes it the task's own.
  conclude(first.request, { status: 200, body: band(1, report('unpack ok', 'ok refs/heads/two', 'option refname refs/heads/two', 'option new-oid abc')) });
  assert.deepEqual(ctx.state, stateOf({ branches: ['refs/heads/one', 'refs/heads/two'] }));
  // A forge that refuses the whole request gives a fresh creation back.
  const fresh = ctxFor();
  conclude((await send([[ZERO, more, 'refs/heads/x']], fresh)).request, { status: 403, body: Buffer.from('denied') });
  assert.deepEqual(fresh.state, stateOf());
  assert.equal(pushReport(report('unpack ok', 'ok refs/heads/a', 'ng refs/heads/b no')).ng[0], 'refs/heads/b');
  assert.equal(pushReport(Buffer.from('0005')), null);

  // A push that does not ask for the report could never be confirmed.
  const quiet = pushBody([[ZERO, more, 'refs/heads/quiet']], packOf(work, [more], [M]), 'side-band-64k agent=git/2');
  await refused(checkPush(NEW_RULE, SEGMENTS, quiet, ctxFor()), /does not ask the forge for its report/);
  await allowed(checkPush(NEW_RULE, SEGMENTS, pushBody([[ZERO, more, 'refs/heads/quiet']], packOf(work, [more], [M]), 'report-status-v2'), ctxFor()));
  assert.match((await authorize(rules, { host: 'github.com', method: 'POST', path: '/o/r.git/git-receive-pack', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: '' }, ctx)).reason, /must be sent as/);
  git(forge, 'update-ref', '-d', 'refs/heads/fix-421');
});

await check('the default branch and a protected branch are never pushed, as a head, as the task\'s own or as a new name', async () => {
  at(M);
  const onMain = commit('straight to main', { 'src/base.js': 'y\n' });
  const mainHead = ctxFor({ async pull(number) { return { number, open: true, author: 'me', headRepo: 'o/r', headRef: 'main' }; } });
  await refused(push(HEAD_RULE, [[M, onMain, 'refs/heads/main']], mainHead), /refs\/heads\/main: the default branch is never pushed by a task/);
  await refused(push(NEW_RULE, [[M, onMain, 'refs/heads/main']], ctxFor({ state: { branches: ['refs/heads/main'] } })), /the default branch is never pushed/);
  const named = (defaultBranch) => ctxFor({ async repository() { return { defaultBranch, ciPaths: [] }; } });
  await refused(push(NEW_RULE, [[ZERO, onMain, 'refs/heads/trunk']], named('trunk')), /refs\/heads\/trunk: the default branch is never pushed/);
  await refused(push(NEW_RULE, [[ZERO, onMain, 'refs/heads/Trunk']], named('trunk')), /the default branch is never pushed/);
  await refused(push(NEW_RULE, [[ZERO, onMain, 'refs/heads/a/b']], named('a/b')), /the default branch is never pushed/);
  await allowed(push(NEW_RULE, [[ZERO, onMain, 'refs/heads/trunk']], named('main')));
  await refused(push(NEW_RULE, [[ZERO, onMain, 'refs/heads/ok'], [ZERO, onMain, 'refs/heads/trunk']], named('trunk')), /the default branch is never pushed/);

  at(B);
  const C = commit('on a protected head', { 'src/a.js': 'p\n' });
  const guarded = ctxFor({ async branch(ref) { return { sha: git(forge, 'rev-parse', ref), protected: true }; } });
  await refused(push(HEAD_RULE, [[B, C, 'refs/heads/feature']], guarded), /refs\/heads\/feature: a protected branch is never pushed by a task/);
  await allowed(push(HEAD_RULE, [[B, C, 'refs/heads/feature']]));
  // A lookup that throws is the caller's refusal to make; nothing is left behind.
  await assert.rejects(push(HEAD_RULE, [[B, C, 'refs/heads/feature']], ctxFor({ async branch() { throw new Error('forge: the forge did not say'); } })), /did not say/);
  await assert.rejects(push(HEAD_RULE, [[B, C, 'refs/heads/feature']], ctxFor({ async repository() { throw new Error('forge: the forge did not say'); } })), /did not say/);
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

  // Deleting one is a change to CI like any other: a job that no longer runs.
  at(B);
  await refused(push(HEAD_RULE, [[B, commit('drop ci', { '.github/workflows/ci.yml': null }), 'refs/heads/feature']]), /changes \.github\/workflows\/ci\.yml/);
  at(B);
  git(work, 'rm', '--quiet', '-r', '.github/workflows');
  await refused(push(HEAD_RULE, [[B, commit('drop the directory'), 'refs/heads/feature']]), /changes \.github\/workflows\/ci\.yml/);
  // The forge's own path is one spelling; a runner or a checkout that folds case reads others as the same.
  for (const file of ['.GitHub/workflows/x.yml', '.github/WORKFLOWS/x.yml', '.GITHUB/Workflows/Deep/x.yml']) {
    at(B);
    git(work, 'update-index', '--add', '--cacheinfo', `100644,${git(work, 'hash-object', '-w', path.join(work, 'src/a.js'))},${file}`);
    git(work, 'commit', '--quiet', '-m', 'another case');
    await refused(push(HEAD_RULE, [[B, git(work, 'rev-parse', 'HEAD'), 'refs/heads/feature']]), new RegExp(`changes ${file.replaceAll('.', '\\.')}`));
    git(work, 'reset', '--quiet', '--hard');
  }
  // The file a GitLab project is set to read its CI from is added to the rule's own.
  const configured = (ciPaths) => ctxFor({ async repository() { return { defaultBranch: 'main', ciPaths }; } });
  at(B);
  const ciFile = commit('the configured file', { 'ci/Pipeline.yml': 'x\n' });
  await allowed(push(HEAD_RULE, [[B, ciFile, 'refs/heads/feature']]));
  await refused(push(HEAD_RULE, [[B, ciFile, 'refs/heads/feature']], configured(['ci/pipeline.yml'])), /changes ci\/Pipeline\.yml/);
  await refused(push(HEAD_RULE, [[B, ciFile, 'refs/heads/feature']], configured(['CI/PIPELINE.YML'])), /changes ci\/Pipeline\.yml/);
  await refused(push({ ...HEAD_RULE, denyPaths: undefined }, [[B, ciFile, 'refs/heads/feature']], configured(['ci/pipeline.yml'])), /changes ci\/Pipeline\.yml/);
  await allowed(push(HEAD_RULE, [[B, ciFile, 'refs/heads/feature']], configured(['ci/pipeline.yml.d', 'pipeline.yml'])));

  // What is not a workflow, and a merge that brings the base branch's along.
  at(B);
  await allowed(push(HEAD_RULE, [[B, commit('other .github file', { '.github/dependabot.yml': 'y\n', 'github/workflows/x.yml': 'x\n', '.github/workflowsx/y.yml': 'y\n' }), 'refs/heads/feature']]));
  at(B);
  git(work, 'merge', '--quiet', '--no-edit', M);
  await allowed(push(HEAD_RULE, [[B, git(work, 'rev-parse', 'HEAD'), 'refs/heads/feature']]));
  // A rule without denyPaths takes the workflow.
  await allowed(push({ ...HEAD_RULE, denyPaths: undefined }, [[B, evil, 'refs/heads/feature']]));
});

// A merge of `parents` in the executor's clone, with `files` written over what git made of it.
const mergeOf = (parents, files = {}) => {
  at(parents[0]);
  git(work, 'merge', '--quiet', '--no-commit', '--no-ff', ...parents.slice(1));
  return commit(`merge of ${parents.length}`, files);
};

await check('a merge may hold a CI definition as a parent the forge already has holds it; a parent pushed along answers for itself', async () => {
  const WORKFLOW = '.github/workflows/ci.yml';
  // Beside main, which changed its workflow in M, the forge has a branch with one of its own.
  at(A);
  const other = commit('a branch with its own workflow', { '.github/workflows/other.yml': 'on: push\n' });
  git(work, 'push', '--quiet', forge, `${other}:refs/heads/other`);
  at(B);
  const C = commit('clean work', { 'src/a.js': 'merge me\n' });
  const feature = (tip) => push(HEAD_RULE, [[B, tip, 'refs/heads/feature']]);
  const show = (rev, file) => git(work, 'show', `${rev}:${file}`);

  // Each definition exactly as one parent has it: the base branch's, the other branch's, or the task's own old one.
  const two = mergeOf([C, M]);
  assert.equal(show(two, WORKFLOW), show(M, WORKFLOW));
  await allowed(feature(two));
  const three = mergeOf([C, M, other]);
  assert.equal(git(work, 'rev-list', '--parents', '-1', three).split(' ').length, 4, 'an octopus merge');
  assert.equal(show(three, '.github/workflows/other.yml'), 'on: push');
  await allowed(feature(three));
  const ours = mergeOf([C, M], { [WORKFLOW]: 'on: push\n' });
  assert.equal(show(ours, WORKFLOW), show(C, WORKFLOW));
  await allowed(feature(ours));

  // As no parent has it: edited, or deleted, in a merge of two and in an octopus.
  await refused(feature(mergeOf([C, M], { [WORKFLOW]: 'on: push\njobs: { leak: {} }\n' })), /changes \.github\/workflows\/ci\.yml/);
  await refused(feature(mergeOf([C, M], { [WORKFLOW]: null })), /changes \.github\/workflows\/ci\.yml/);
  await refused(feature(mergeOf([C, M, other], { '.github/workflows/other.yml': 'on: [push, workflow_dispatch]\n' })), /changes \.github\/workflows\/other\.yml/);
  await refused(feature(mergeOf([C, M, other], { [WORKFLOW]: 'on: push\njobs: { leak: {} }\n' })), /changes \.github\/workflows\/ci\.yml/);
  await refused(feature(mergeOf([C, M, other], { '.github/workflows/new.yml': 'on: push\n' })), /changes \.github\/workflows\/new\.yml/);

  // A definition cannot be made a parent's by pushing that parent along: the commit that
  // wrote it is checked as its own, whichever side of the merge it is on.
  at(B);
  const writer = commit('writes a workflow', { '.github/workflows/steal.yml': 'on: push\n' });
  const laundered = mergeOf([C, writer]);
  assert.equal(git(work, 'diff-tree', '-c', '--name-only', '--no-commit-id', '-r', laundered), '', 'the merge itself differs from no parent');
  await refused(feature(laundered), /changes \.github\/workflows\/steal\.yml/);
  await refused(feature(mergeOf([writer, C])), /changes \.github\/workflows\/steal\.yml/);
  await refused(feature(mergeOf([C, M, writer])), /changes \.github\/workflows\/steal\.yml/);
  await refused(push(NEW_RULE, [[ZERO, laundered, 'refs/heads/x']]), /changes \.github\/workflows\/steal\.yml/);
  // In a pack that leaves the writer out, the merge builds on a commit the forge has on no branch.
  await refused(push(HEAD_RULE, [[B, laundered, 'refs/heads/feature']], ctxFor(), { pack: packOf(work, [laundered], [A, B, M, writer]) }), /builds on one that cannot be found/);
  git(work, 'push', '--quiet', forge, `${writer}:refs/pull/9/head`);
  await refused(push(HEAD_RULE, [[B, laundered, 'refs/heads/feature']], ctxFor(), { pack: packOf(work, [laundered], [A, B, M, writer]) }), /no branch of this repository holds/);
  git(forge, 'update-ref', '-d', 'refs/pull/9/head');
  git(forge, 'update-ref', '-d', 'refs/heads/other');
});

await check('a git command that fails proves nothing: the push is refused, whichever step it was', async () => {
  at(B);
  const C = commit('work', { 'src/a.js': 'proven\n' });
  const pushed = () => push(HEAD_RULE, [[B, C, 'refs/heads/feature']]);
  await allowed(pushed());
  for (const [command, why] of [
    ['init', /the quarantine could not be set up/],
    ['index-pack', /the pushed pack could not be indexed/],
    ['show-index', /the pushed pack could not be listed/],
    ['cat-file', /not a commit the push carries or the forge has/],
    ['rev-list --no-walk', /the pushed commits could not be read/],
    ['merge-base', /refs\/heads\/feature: a fast-forward cannot be proven/],
    ['rev-list --max-count', /no branch of this repository holds/],
    ['rev-list --stdin', /could not be told from the forge's own/],
    ['diff-tree', /could not be compared with their parents/],
  ]) {
    fs.writeFileSync(gitFails, command);
    try { await refused(pushed(), why); } finally { fs.rmSync(gitFails); }
  }
  await allowed(pushed());
});

await check('a head branch is the one the forge names for the ref pushed: a pull request answered for another branch opens no other ref', async () => {
  // A forge whose filter by head branch lets every open pull request through.
  const unfiltered = ctxFor({ async pullsByHead() { return PULLS; } });
  const mine = { ...HEAD_RULE, head: { author: 'me' } };
  git(forge, 'update-ref', 'refs/heads/elsewhere', B);
  at(B);
  const C = commit('work', { 'src/a.js': 'heads\n' });
  await refused(push(mine, [[B, C, 'refs/heads/elsewhere']], unfiltered), /refs\/heads\/elsewhere: this task may not update that ref/);
  await refused(push(mine, [[B, C, 'refs/heads/feature'], [B, C, 'refs/heads/elsewhere']], unfiltered), /refs\/heads\/elsewhere: this task may not update that ref/);
  await allowed(push(mine, [[B, C, 'refs/heads/feature']], unfiltered));
  git(forge, 'update-ref', '-d', 'refs/heads/elsewhere');
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
  git(forge, 'update-ref', 'refs/heads/own', M);
  const own = { state: { branches: ['refs/heads/own'] } };
  await refused(push({ ...NEW_RULE, denyPaths: undefined }, [[M, onBase, 'refs/heads/own']], offline(own)), /old value cannot be found/);
  await allowed(push({ ...NEW_RULE, denyPaths: undefined }, [[M, onBase, 'refs/heads/own']], ctxFor(own)));
  git(forge, 'update-ref', '-d', 'refs/heads/own');
  await refused(push({ ...HEAD_RULE, denyPaths: undefined }, [[B, C, 'refs/heads/feature']], offline({ checkout: undefined })), /cannot be found/);
  await refused(push({ ...HEAD_RULE, denyPaths: undefined }, [[B, C, 'refs/heads/feature']], offline({ checkout: path.join(scratch, 'nowhere') })), /cannot be found/);

  const good = packOf(work, [C], [B]);
  const flipped = (fromEnd) => {
    const broken = Buffer.from(good);
    broken[broken.length - fromEnd] ^= 0xff;
    return broken;
  };
  // A byte of the last object, a pack cut short, bytes between the last object and the checksum, and the checksum itself.
  await refused(push(HEAD_RULE, [[B, C, 'refs/heads/feature']], ctxFor(), { pack: flipped(30) }), /is not one git would read/);
  await refused(push(HEAD_RULE, [[B, C, 'refs/heads/feature']], ctxFor(), { pack: good.subarray(0, good.length - 25) }), /is not one git would read/);
  await refused(push(HEAD_RULE, [[B, C, 'refs/heads/feature']], ctxFor(), { pack: Buffer.concat([good.subarray(0, good.length - 20), Buffer.from('more'), good.subarray(good.length - 20)]) }), /is not one git would read/);
  await refused(push(HEAD_RULE, [[B, C, 'refs/heads/feature']], ctxFor(), { pack: flipped(1) }), /could not be indexed/);
  await refused(push(HEAD_RULE, [[B, 'ab'.repeat(20), 'refs/heads/feature']], ctxFor(), { pack: good }), /not a commit the push carries or the forge has/);
  const tree = git(work, 'rev-parse', `${C}^{tree}`);
  await refused(push(HEAD_RULE, [[B, tree, 'refs/heads/feature']], ctxFor(), { pack: good }), /not a commit/);
  await refused(push(HEAD_RULE, [[B, C, 'refs/heads/feature']], ctxFor(), { pack: Buffer.alloc(0) }), /carries no pack/);
  await refused(checkPush(HEAD_RULE, SEGMENTS, Buffer.from('0000'), ctxFor()), /not a well-formed push/);
  await refused(checkPush(HEAD_RULE, SEGMENTS, Buffer.concat([pushBody([[B, C, 'refs/heads/feature']], good), Buffer.alloc(2 * 2 ** 20)]), ctxFor()), /larger than a task may send/);
  await refused(push(HEAD_RULE, [[B, C, 'refs/heads/feature']], ctxFor({ pull: undefined })), /nothing here can look a pull request up/);
  await refused(push(NEW_RULE, [[ZERO, C, 'refs/heads/x']], ctxFor({ branch: undefined })), /nothing here can ask the forge about its branches/);
  await refused(push(NEW_RULE, [[ZERO, C, 'refs/heads/x']], ctxFor({ repository: undefined })), /nothing here can ask the forge about its branches/);
});

// A pack written by hand: each object is `{ type, data }` (3 is a blob), `{ base, delta }`
// for a delta against the object at that index, or `{ ref, delta }` for one against an
// object the forge has.
function handPack(objects) {
  const head = (type, size) => {
    const out = [];
    let byte = (type << 4) | (size & 15);
    for (size = Math.floor(size / 16); size > 0; size = Math.floor(size / 128)) { out.push(byte | 0x80); byte = size & 0x7f; }
    return Buffer.from([...out, byte]);
  };
  const back = (n) => {
    const out = [n & 127];
    while ((n = Math.floor(n / 128)) > 0) out.unshift(128 | (--n & 127));
    return Buffer.from(out);
  };
  const starts = [];
  const parts = [Buffer.concat([Buffer.from('PACK'), Buffer.from([0, 0, 0, 2, 0, 0, 0, objects.length])])];
  let at = 12;
  for (const o of objects) {
    starts.push(at);
    const piece = o.delta === undefined ? Buffer.concat([head(o.type, o.data.length), zlib.deflateSync(o.data)])
      : Buffer.concat([head(o.ref ? 7 : 6, o.delta.length), o.ref ? Buffer.from(o.ref, 'hex') : back(at - starts[o.base]), zlib.deflateSync(o.delta)]);
    parts.push(piece);
    at += piece.length;
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, crypto.createHash('sha1').update(body).digest()]);
}
const size = (n) => {
  const out = [];
  do { out.push((n % 128) | (n >= 128 ? 0x80 : 0)); n = Math.floor(n / 128); } while (n > 0);
  return Buffer.from(out);
};
const MIB = 2 ** 20;
// A delta that builds `says` bytes (by its own word) out of `times` copies of a base of `mib` MiB: two bytes a copy.
const copies = (mib, times, says = mib * MIB * times) => Buffer.concat([size(mib * MIB), size(says), ...Array.from({ length: times }, () => Buffer.from([0xc0, mib * 16]))]);

await check('a pack is measured before git reads it: what it unfolds to is bounded, however few bytes it is', async () => {
  const zeros = { type: 3, data: Buffer.alloc(MIB) };
  const attempt = (objects) => {
    const pack = handPack(objects);
    assert.ok(pack.length < 16 * 1024, 'a few kilobytes on the wire');
    return push(NEW_RULE, [[ZERO, M, 'refs/heads/roomy']], ctxFor(), { pack });
  };
  const over = /unfolds to more than a task may send/;
  // One mebibyte of zeros, and a delta of a few bytes that copies it: twice is within the 8 MiB this test allows, sixteen times is not.
  await allowed(attempt([zeros, { base: 0, delta: copies(1, 2) }]));
  await refused(attempt([zeros, { base: 0, delta: copies(1, 16) }]), over);
  // A delta on a delta counts for what each builds: 1 + 4 + 4 MiB.
  await allowed(attempt([zeros, { base: 0, delta: copies(1, 2) }, { base: 1, delta: copies(2, 2) }]));
  await refused(attempt([zeros, { base: 0, delta: copies(1, 4) }, { base: 1, delta: copies(4, 1) }]), over);
  // Many small ones add up, and one object of zeros is no different.
  await refused(attempt([zeros, ...Array.from({ length: 8 }, () => ({ base: 0, delta: copies(1, 1) }))]), over);
  await refused(attempt([{ type: 3, data: Buffer.alloc(9 * MIB) }]), over);
  // The size a delta states is the size git builds: one that states less than it copies is not indexed.
  await refused(attempt([zeros, { base: 0, delta: copies(1, 16, 1) }]), /could not be indexed/);
  // A delta against an object of the forge's, named by id.
  const blob = git(work, 'rev-parse', `${A}:src/a.js`);
  await allowed(attempt([{ ref: blob, delta: Buffer.concat([size(2), size(5), Buffer.from([5]), Buffer.from('hello')]) }]));
  // What does not read as a pack to its end: an object type git has none of, a size that is not the data's, one object fewer than stated.
  const unread = /is not one git would read/;
  await refused(attempt([{ type: 5, data: Buffer.from('x') }]), unread);
  const lying = handPack([{ type: 3, data: Buffer.from('four') }]);
  lying[12] = (3 << 4) | 5;
  await refused(push(NEW_RULE, [[ZERO, M, 'refs/heads/roomy']], ctxFor(), { pack: lying }), unread);
  const short = handPack([{ type: 3, data: Buffer.from('four') }]);
  short[11] = 2;
  await refused(push(NEW_RULE, [[ZERO, M, 'refs/heads/roomy']], ctxFor(), { pack: short }), unread);
});

await check('a pushed tree that git itself calls broken is refused: a lookup and a checkout would read it two ways', async () => {
  const mktree = (listing) => execFileSync('git', ['mktree'], { cwd: work, input: listing, encoding: 'utf8' }).trim();
  const blob = git(work, 'rev-parse', `${M}:src/a.js`);
  const base = `${git(work, 'ls-tree', M)}\n`;
  for (const [listing, why] of [[`100644 blob ${blob}\ttwice\n100644 blob ${blob}\ttwice\n`, 'a name twice'], [`100644 blob ${blob}\t.git\n`, 'an entry named .git']]) {
    const odd = git(work, 'commit-tree', mktree(base + listing), '-p', M, '-m', why);
    await refused(push(NEW_RULE, [[ZERO, odd, 'refs/heads/odd']], ctxFor(), { pack: packOf(work, [odd], [M]) }), /could not be indexed/);
  }
  const fine = git(work, 'commit-tree', mktree(`${base}100644 blob ${blob}\tonce\n`), '-p', M, '-m', 'fine');
  await allowed(push(NEW_RULE, [[ZERO, fine, 'refs/heads/odd']], ctxFor(), { pack: packOf(work, [fine], [M]) }));
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
  await allowed(checkAdvertise({ ...HEAD_RULE, head: { author: 'me' } }, ['o', 'r', 'info', 'refs'], ctxFor()));
  // A rule without `fork` reaches the pool's repository alone: not a fork that holds the pull request's head, nor a branch of that name here.
  const inFork = ctxFor({
    async pull(number) { return { number, open: true, author: 'me', headRepo: 'me/r', headRef: 'feature' }; },
    async pullsByHead() { return [{ number: 578, open: true, author: 'me', headRepo: 'me/r', headRef: 'feature' }]; },
  });
  for (const rule of [HEAD_RULE, { ...HEAD_RULE, head: { author: 'me' } }]) {
    await refused(checkAdvertise(rule, ['me', 'r.git', 'info', 'refs'], inFork), /not the pool's repository/);
    await refused(checkPush(rule, ['me', 'r.git', 'git-receive-pack'], pushBody([[B, C, 'refs/heads/feature']], pack), inFork), /not the pool's repository/);
    await refused(checkAdvertise(rule, ['o', 'r.git', 'info', 'refs'], inFork), /does not hold the head branch|no open pull request by me/);
    await refused(checkPush(rule, SEGMENTS, pushBody([[B, C, 'refs/heads/feature']], pack), inFork), /does not hold the head branch|no open pull request by me/);
  }
  await refused(checkAdvertise(HEAD_RULE, ['o', 'r.git', 'info', 'refs'], ctxFor({ async pull() { return null; } })), /does not hold the head branch/);
});

const FORK_SEGMENTS = ['me', 'r.git', 'git-receive-pack'];
const FORK_ADVERT = ['me', 'r.git', 'info', 'refs'];
const FORK_HEAD = { ...HEAD_RULE, head: { number: 581 }, fork: 'me' };
const FORK_MINE = { ...HEAD_RULE, head: { author: 'me' }, fork: 'me' };
const FORK_NEW = { ...NEW_RULE, fork: 'me' };
// A push to the fork, with the pack a client builds against what the fork advertises.
const pushFork = (rule, commands, ctx = ctxFor(), segments = FORK_SEGMENTS) => checkPush(rule, segments,
  pushBody(commands, packOf(work, commands.map((c) => c[1]).filter((oid) => oid !== ZERO), [A, B])), ctx);
const NOT_THE_FORK = /^me\/r is not this account's own fork of the pool's repository$/;

await check('a rule with `fork` reaches the fork of the pool\'s repository that the account holds itself, as the forge tells it', async () => {
  at(B);
  const C = commit('work in the fork', { 'src/a.js': 'f1\n' });
  const move = [[B, C, 'refs/heads/feature']];
  fetches = [];
  asked = [];
  assert.deepEqual(await pushFork(FORK_HEAD, move), { ok: true, created: [] });
  assert.deepEqual(asked, ['repository me/r', 'branch refs/heads/feature me/r', 'repository undefined']);
  assert.deepEqual(fetches, ['me/r refs/dn/0', 'pool refs/dn/1'], 'the fork\'s branches and the pool\'s, each under its own names');
  // The path is the client's spelling; the forge is asked in one.
  asked = [];
  await allowed(pushFork(FORK_HEAD, move, ctxFor(), ['ME', 'R.GIT', 'git-receive-pack']));
  assert.equal(asked[0], 'repository me/r');
  await allowed(checkAdvertise(FORK_HEAD, FORK_ADVERT, ctxFor()));
  await allowed(checkAdvertise(FORK_MINE, ['me', 'r', 'info', 'refs'], ctxFor()));
  await allowed(checkAdvertise(FORK_NEW, FORK_ADVERT, ctxFor()));
  await refused(checkAdvertise(FORK_NEW, FORK_ADVERT), /nothing here can ask the forge about its branches/);

  // Whose the repository is and what it is a fork of are the forge's word, in any letter case.
  const forkIs = (fork) => ctxFor({ async repository(of) { return of === undefined ? POOL : fork; } });
  for (const fork of [{ ...FORK, owner: 'Me' }, { ...FORK, parent: 'O/R' }]) await allowed(pushFork(FORK_HEAD, move, forkIs(fork)));
  for (const fork of [null, { ...FORK, owner: 'them' }, { ...FORK, owner: 'me2' }, { ...FORK, owner: '' }, { ...FORK, parent: '' }, { ...FORK, parent: 'o/other' }, { ...FORK, parent: 'them/r' }]) {
    for (const rule of [FORK_HEAD, FORK_MINE, FORK_NEW]) await refused(checkAdvertise(rule, FORK_ADVERT, forkIs(fork)), NOT_THE_FORK);
    await refused(pushFork(FORK_HEAD, move, forkIs(fork)), NOT_THE_FORK);
    await refused(pushFork(FORK_NEW, [[ZERO, C, 'refs/heads/x']], forkIs(fork)), NOT_THE_FORK);
  }
  await assert.rejects(pushFork(FORK_HEAD, move, ctxFor({ async repository() { throw new Error('forge: the forge did not say'); } })), /did not say/);
  // A path the forge would read through an escape names no repository to ask about.
  for (const name of ['%72.git', '%2e%2e', 'r%2Fx', 'r:x']) {
    asked = [];
    await refused(checkAdvertise(FORK_HEAD, ['me', name, 'info', 'refs'], ctxFor({ async repository(of) { asked.push(of); return FORK; } })), /is not this account's own fork of the pool's repository$/);
    assert.deepEqual(asked, [], name);
  }

  // The head branch is the pull request's when the forge places its head in this fork, which it names by id.
  const pullIs = (pull) => ctxFor({ async pull() { return pull; }, async pullsByHead() { return pull ? [pull] : []; } });
  const [inPool, inFork] = PULLS;
  for (const pull of [null, inPool, { ...inFork, headRepoId: 1 }, { ...inFork, headRepoId: null }, { ...inFork, headRepoId: '12' }, { ...inFork, open: false }]) {
    await refused(pushFork(FORK_HEAD, move, pullIs(pull)), /this repository does not hold the head branch of open pull request #581/);
    await refused(checkAdvertise(FORK_HEAD, FORK_ADVERT, pullIs(pull)), /this repository does not hold the head branch of open pull request #581/);
    await refused(pushFork(FORK_MINE, move, pullIs(pull)), /no open pull request by me has its head branch here/);
  }
  await refused(pushFork(FORK_MINE, move, pullIs({ ...inFork, author: 'them' })), /no open pull request by me has its head branch here/);
  // A rule over every pull request of an author asks for the ones from that account's branch of the name.
  asked = [];
  await allowed(pushFork(FORK_MINE, move));
  assert.ok(asked.includes('pulls feature me'), asked.join());
  asked = [];
  await allowed(push({ ...HEAD_RULE, head: { author: 'me' } }, move));
  assert.ok(asked.includes('pulls feature undefined'), asked.join());

  // The default branch, the protection and the branch's place asked about are the fork's.
  const defaults = (pool, fork) => ctxFor({ async repository(of) { return of === undefined ? { ...POOL, defaultBranch: pool } : { ...FORK, defaultBranch: fork }; } });
  await refused(pushFork(FORK_HEAD, move, defaults('main', 'feature')), /refs\/heads\/feature: the default branch is never pushed by a task/);
  await allowed(pushFork(FORK_HEAD, move, defaults('feature', 'main')));
  const branchIs = (answer) => ctxFor({ async branch(ref, of) { return answer(of); } });
  await refused(pushFork(FORK_HEAD, move, branchIs((of) => ({ sha: B, protected: of === 'me/r' }))), /a protected branch is never pushed by a task/);
  await allowed(pushFork(FORK_HEAD, move, branchIs((of) => ({ sha: B, protected: of === undefined }))));
  await refused(pushFork(FORK_HEAD, move, branchIs((of) => (of === undefined ? { sha: B, protected: false } : null))), /not where this push starts from/);
  await refused(pushFork(FORK_HEAD, [[A, C, 'refs/heads/feature']]), /not where this push starts from/);

  // What a push to the pool's repository is held to holds here.
  await refused(pushFork(FORK_HEAD, [...move, [ZERO, C, 'refs/heads/second']]), /refs\/heads\/second: this task may not create that ref/);
  await refused(pushFork(FORK_HEAD, [...move, [A, C, 'refs/heads/main']]), /refs\/heads\/main: this task may not update that ref/);
  await refused(pushFork(FORK_HEAD, [[B, ZERO, 'refs/heads/feature']]), /may not delete a ref/);
  at(A);
  const rewritten = commit('rewritten in the fork', { 'src/a.js': 'r\n' });
  await refused(pushFork(FORK_HEAD, [[B, rewritten, 'refs/heads/feature']]), /not a fast-forward/);
  at(B);
  const evil = commit('a workflow in the fork', { '.github/workflows/steal.yml': 'on: push\n' });
  await refused(pushFork(FORK_HEAD, [[B, evil, 'refs/heads/feature']]), /changes \.github\/workflows\/steal\.yml/);
  // The file a project is set to read its CI from: the fork's, and the pool's, where a
  // fork's merge request can have its pipeline run.
  at(B);
  const ciFile = commit('a configured file', { 'ci/pipeline.yml': 'x\n' });
  const configured = (pool, fork) => ctxFor({ async repository(of) { return of === undefined ? { ...POOL, ciPaths: pool } : { ...FORK, ciPaths: fork }; } });
  await allowed(pushFork(FORK_HEAD, [[B, ciFile, 'refs/heads/feature']], configured([], [])));
  await refused(pushFork(FORK_HEAD, [[B, ciFile, 'refs/heads/feature']], configured(['ci/pipeline.yml'], [])), /changes ci\/pipeline\.yml/);
  await refused(pushFork(FORK_HEAD, [[B, ciFile, 'refs/heads/feature']], configured([], ['ci/pipeline.yml'])), /changes ci\/pipeline\.yml/);
  await refused(pushFork(FORK_HEAD, move, ctxFor({ async repository(of) { return of === undefined ? null : FORK; } })), /the forge shows no repository where the pool's should be/);
});

await check('the forge\'s own commits are told from the pushed ones: a fork that is behind takes the base branch, and nothing else rides along', async () => {
  at(B);
  const C = commit('more work in the fork', { 'src/a.js': 'f2\n' });
  git(work, 'merge', '--quiet', '--no-edit', M);
  const merged = git(work, 'rev-parse', 'HEAD');
  // The fork never saw M: the pack carries it, workflow change and all, and a branch of the pool's repository holds it.
  await allowed(pushFork(FORK_HEAD, [[B, merged, 'refs/heads/feature']]));
  // The same pack sent to the pool's repository, by a client that did not know its main.
  await allowed(checkPush(HEAD_RULE, SEGMENTS, pushBody([[B, merged, 'refs/heads/feature']], packOf(work, [merged], [A, B])), ctxFor()));
  // Both repositories must answer for their branches.
  for (const silent of ['me/r', undefined]) {
    const ctx = ctxFor();
    const fetch = ctx.fetch;
    ctx.fetch = (what) => (what.repo === silent ? Promise.resolve(false) : fetch(what));
    await refused(pushFork(FORK_HEAD, [[B, merged, 'refs/heads/feature']], ctx), /the forge's branches could not be fetched/);
  }
  // A merge settled to what neither side holds is the push's own.
  at(C);
  git(work, 'merge', '--quiet', '--no-commit', M);
  const resolved = commit('evil merge into the fork', { '.github/workflows/ci.yml': 'on: push\njobs: { leak: {} }\n' });
  await refused(pushFork(FORK_HEAD, [[B, resolved, 'refs/heads/feature']]), /changes \.github\/workflows\/ci\.yml/);
  // A workflow written by a commit pushed along is that commit's, whatever merge takes it over unchanged.
  at(B);
  const writer = commit('writes a workflow, for the fork', { '.github/workflows/steal.yml': 'on: push\n' });
  const laundered = mergeOf([C, writer]);
  await refused(pushFork(FORK_HEAD, [[B, laundered, 'refs/heads/feature']]), /changes \.github\/workflows\/steal\.yml/);
  // The same commit as somebody else's fork holds it: the forge hands it out by id through
  // this fork and through the pool's repository, and no branch of either holds it.
  const lean = pushBody([[B, laundered, 'refs/heads/feature']], packOf(work, [laundered], [A, B, M, writer]));
  await refused(checkPush(FORK_HEAD, FORK_SEGMENTS, lean, ctxFor()), /builds on one that cannot be found/);
  for (const holder of [forge, forkGit]) {
    git(work, 'push', '--quiet', holder, `${writer}:refs/pull/9/head`);
    fetches = [];
    await refused(checkPush(FORK_HEAD, FORK_SEGMENTS, lean, ctxFor()), /no branch of this repository holds/);
    assert.ok(fetches.includes(`${holder === forkGit ? 'me/r' : 'pool'} 1`), `the commit was fetched by id: ${fetches.join()}`);
    git(holder, 'update-ref', '-d', 'refs/pull/9/head');
  }

  // A branch of the fork is the forge's own for a push to the fork, under its own name
  // beside the pool's branch of that name, and is nothing to a push to the pool's repository.
  at(B);
  const side = commit('the account\'s own workflow, on a branch of its fork', { '.github/workflows/mine.yml': 'on: push\n' });
  git(work, 'push', '--quiet', forkGit, `${side}:refs/heads/side`);
  git(forge, 'update-ref', 'refs/heads/side', A);
  const onSide = commit('work on top of it', { 'src/a.js': 'f3\n' });
  const pack = packOf(work, [onSide], [side]);
  await allowed(checkPush(FORK_HEAD, FORK_SEGMENTS, pushBody([[B, onSide, 'refs/heads/feature']], pack), ctxFor()));
  await refused(checkPush(HEAD_RULE, SEGMENTS, pushBody([[B, onSide, 'refs/heads/feature']], pack), ctxFor()), /builds on one that cannot be found/);
  git(forge, 'update-ref', '-d', 'refs/heads/side');
  git(forkGit, 'update-ref', '-d', 'refs/heads/side');
});

await check('a branch made in the fork is the task\'s own there under the fork\'s name, and a branch of the pool\'s repository under its own', async () => {
  at(M);
  const fix = commit('a fix', { 'src/fix.js': 'f\n' });
  assert.deepEqual((await allowed(pushFork(FORK_NEW, [[ZERO, fix, 'refs/heads/fix']]))).created, [{ branch: 'me/r:refs/heads/fix', sha: fix }]);
  const spelled = ctxFor({ async repository(of) { return of === undefined ? POOL : { ...FORK, name: 'Me/R' }; } });
  assert.deepEqual((await allowed(pushFork(FORK_NEW, [[ZERO, fix, 'refs/heads/fix']], spelled))).created, [{ branch: 'me/r:refs/heads/fix', sha: fix }]);
  assert.deepEqual((await allowed(push(NEW_RULE, [[ZERO, fix, 'refs/heads/fix']]))).created, [{ branch: 'refs/heads/fix', sha: fix }]);
  await refused(pushFork({ ...FORK_NEW, create: 0 }, [[ZERO, fix, 'refs/heads/fix']]), /may not create that ref/);
  for (const repo of [forge, forkGit]) git(work, 'push', '--quiet', repo, `${fix}:refs/heads/fix`);
  const more = commit('more of the fix', { 'src/fix.js': 'g\n' });
  const owning = (...branches) => ctxFor({ state: { branches } });
  await allowed(pushFork(FORK_NEW, [[fix, more, 'refs/heads/fix']], owning('me/r:refs/heads/fix')));
  await allowed(pushFork(FORK_NEW, [[fix, more, 'refs/heads/fix']], Object.assign(spelled, { state: { branches: ['me/r:refs/heads/fix'] } })));
  await allowed(push(NEW_RULE, [[fix, more, 'refs/heads/fix']], owning('refs/heads/fix')));
  await refused(pushFork(FORK_NEW, [[fix, more, 'refs/heads/fix']], owning('refs/heads/fix')), /refs\/heads\/fix: this task may not update that ref/);
  await refused(pushFork(FORK_NEW, [[fix, more, 'refs/heads/fix']], owning('them/r:refs/heads/fix')), /may not update that ref/);
  await refused(push(NEW_RULE, [[fix, more, 'refs/heads/fix']], owning('me/r:refs/heads/fix')), /refs\/heads\/fix: this task may not update that ref/);
  for (const repo of [forge, forkGit]) git(repo, 'update-ref', '-d', 'refs/heads/fix');
});

await check('a creation whose answer never came is settled by what the forge shows, before the task\'s next push is judged', async () => {
  at(M);
  const tip = commit('lost and found', { 'src/lost.js': 'l\n' });
  const next = commit('and on', { 'src/lost.js': 'm\n' });
  const to = (repo, rule) => (commands, ctx) => authorize([{ host: 'github.com', method: 'POST', path: `/${repo}.git/git-receive-pack`, ...rule }], {
    host: 'github.com', method: 'POST', path: `/${repo}.git/git-receive-pack`, headers: { 'content-type': 'application/x-git-receive-pack-request' },
    body: pushBody(commands, packOf(work, commands.map((c) => c[1]), [M])).toString('base64'),
  }, ctx);
  const send = to('o/r', NEW_RULE);
  // A creation that was sent, and no answer came.
  const lost = async (ctx, ref, how = send) => conclude((await how([[ZERO, tip, ref]], ctx)).request, undefined);
  const held = (ref) => stateOf({ reserved: [ref], sent: { [ref]: tip } });

  // The forge has no such branch: the allowance is free again.
  let ctx = ctxFor();
  await lost(ctx, 'refs/heads/lost');
  assert.deepEqual(ctx.state, held('refs/heads/lost'));
  asked = [];
  const other = await send([[ZERO, tip, 'refs/heads/other']], ctx);
  assert.equal(other.ok, true, other.reason);
  assert.ok(asked.includes('branch refs/heads/lost undefined'), asked.join());
  assert.deepEqual(ctx.state, held('refs/heads/other'));

  // The forge has it at the commit that was sent: it is the task's own, to move and to count.
  ctx = ctxFor();
  await lost(ctx, 'refs/heads/lost');
  git(work, 'push', '--quiet', forge, `${tip}:refs/heads/lost`);
  await allowed(send([[tip, next, 'refs/heads/lost']], ctx));
  assert.deepEqual(ctx.state, stateOf({ branches: ['refs/heads/lost'] }));
  await refused(send([[ZERO, tip, 'refs/heads/other']], ctx), /may create 1 branch\(es\); it has refs\/heads\/lost/);
  // Two requests that find it out at once make it the task's own once.
  ctx = ctxFor({ state: held('refs/heads/lost') });
  const both =await Promise.all([send([[tip, next, 'refs/heads/lost']], ctx), send([[tip, next, 'refs/heads/lost']], ctx)]);
  assert.deepEqual(both.map((verdict) => verdict.ok), [true, true]);
  assert.deepEqual(ctx.state, stateOf({ branches: ['refs/heads/lost'] }));

  // The forge has it at another commit: somebody's branch, which stays counted and is not the task's.
  git(work, 'push', '--quiet', forge, `${M}:refs/heads/taken`);
  ctx = ctxFor({ state: held('refs/heads/taken') });
  await refused(send([[M, tip, 'refs/heads/taken']], ctx), /may not update that ref/);
  await refused(send([[ZERO, tip, 'refs/heads/other']], ctx), /may create 1 branch\(es\); it has refs\/heads\/taken/);
  assert.deepEqual(ctx.state, held('refs/heads/taken'));

  // A creation still on its way is not asked about, and stays counted. After a restart nothing is on its way.
  ctx = ctxFor();
  const flying = await send([[ZERO, tip, 'refs/heads/flying']], ctx);
  asked = [];
  await refused(send([[ZERO, tip, 'refs/heads/other']], ctx), /may create 1 branch\(es\); it has refs\/heads\/flying/);
  assert.ok(!asked.includes('branch refs/heads/flying undefined'), asked.join());
  await allowed(send([[ZERO, tip, 'refs/heads/other']], ctxFor({ state: JSON.parse(JSON.stringify(ctx.state)) })));
  conclude(flying.request, undefined);
  // The forge's word that came while the creation was being sent again is about the one before.
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const slow = { ...ctx, async branch(ref, of) { const now = await ctx.branch(ref, of); if (ref === 'refs/heads/flying') await gate; return now; } };
  const late = send([[ZERO, tip, 'refs/heads/other']], slow);
  await allowed(send([[ZERO, tip, 'refs/heads/flying']], ctx));
  release();
  await refused(late, /may create 1 branch\(es\); it has refs\/heads\/flying/);
  assert.deepEqual(ctx.state, held('refs/heads/flying'));

  // A forge that does not say has said nothing: the request is refused and the state is as it was.
  ctx = ctxFor();
  await lost(ctx, 'refs/heads/unsaid');
  const silent = { ...ctx, async branch(ref, of) { if (ref === 'refs/heads/unsaid') throw new Error('forge: the forge did not say where refs/heads/unsaid is (it answered 503)'); return ctx.branch(ref, of); } };
  await refused(send([[ZERO, tip, 'refs/heads/other']], silent), /^the forge did not say where refs\/heads\/unsaid is/);
  await refused(send([[ZERO, tip, 'refs/heads/other']], { ...ctx, branch: undefined }), /nothing here can ask the forge about its branches/);
  assert.deepEqual(ctx.state, held('refs/heads/unsaid'));

  // A branch of the fork is looked for in the fork, where the pool's repository has none of that name.
  git(forge, 'update-ref', '-d', 'refs/heads/lost');
  const sendFork = to('me/r', FORK_NEW);
  ctx = ctxFor();
  await lost(ctx, 'refs/heads/lost', sendFork);
  assert.deepEqual(ctx.state, held('me/r:refs/heads/lost'));
  git(work, 'push', '--quiet', forkGit, `${tip}:refs/heads/lost`);
  asked = [];
  await allowed(sendFork([[tip, next, 'refs/heads/lost']], ctx));
  assert.ok(asked.includes('branch refs/heads/lost me/r'), asked.join());
  assert.deepEqual(ctx.state, stateOf({ branches: ['me/r:refs/heads/lost'] }));

  // A push does not wait for what became of a pull request.
  ctx = ctxFor({ state: stateOf({ asked: ['fix-1'] }) });
  asked = [];
  await allowed(send([[ZERO, tip, 'refs/heads/other']], ctx));
  assert.deepEqual(asked.filter((line) => line.startsWith('pulls')), []);
  assert.deepEqual(ctx.state.asked, ['fix-1']);

  for (const [repo, ref] of [[forge, 'taken'], [forkGit, 'lost']]) git(repo, 'update-ref', '-d', `refs/heads/${ref}`);
});

await check('the linked checkout is read and never written', async () => {
  assert.equal(snapshot(checkout), checkoutBefore);
  assert.equal(git(checkout, 'status', '--porcelain'), '');
});

fs.rmSync(scratch, { recursive: true, force: true });
