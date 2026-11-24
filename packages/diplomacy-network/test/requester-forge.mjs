// Performing: an authorised request reaches the forge with this machine's credential and
// nothing of the executor's, a refused one never leaves, and a real git client pushes
// through authorize + perform. The forge is a local stand-in and the tokens are fakes;
// with DN_TEST_GITHUB=1 one read-only check also runs against the real api.github.com.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GH, gh, ghql, glab } from './lib/captured.mjs';
import { GHES_HOST, GHES_TOKEN, GITHUB_TOKEN, GITLAB_HOST, GITLAB_TOKEN, git, startFakeForge } from './lib/fake-forge.mjs';

async function check(name, fn) {
  await fn();
  console.log(`PASS ${name}`);
}

// The live check runs in a process of its own: this one has its forge origins redirected.
if (process.argv[2] === 'live') {
  const { createForge } = await import('../src/requester/forge.js');
  const { authorize } = await import('../src/requester/authorize.js');
  const { rulesFor } = await import('../src/requester/rules.js');
  const rules = rulesFor({ forge: 'github', kind: 'investigate', pool: 'github.com/cli/cli', item: 'job-live', identity: 'live-check' });
  const client = createForge();
  const ctx = client.context({ forge: 'github', host: 'github.com', repo: 'cli/cli', state: {} });
  const send = async (request) => {
    const verdict = await authorize(rules, request, ctx);
    assert.equal(verdict.ok, true, verdict.reason);
    const res = await client.perform(verdict.request, { forge: 'github', host: 'github.com' });
    return { status: res.status, json: JSON.parse(Buffer.from(res.body, 'base64').toString('utf8')) };
  };
  await check('live: a confined read and a confined GraphQL query reach the real api.github.com', async () => {
    const rest = await send(gh('GET', '/repos/cli/cli'));
    assert.equal(rest.status, 200);
    assert.equal(rest.json.full_name, 'cli/cli');
    const graph = await send(ghql({ query: 'query($o: String!, $n: String!) { repository(owner: $o, name: $n) { nameWithOwner } viewer { login } }', variables: { o: 'cli', n: 'cli' } }));
    assert.equal(graph.status, 200);
    assert.equal(graph.json.data.repository.nameWithOwner, 'cli/cli');
    assert.equal(typeof graph.json.data.viewer.login, 'string');
    assert.equal((await authorize(rules, gh('GET', '/user/repos'), ctx)).ok, false);
  });
  process.exit(0);
}

const scratch = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'dn-forge-test-'));
process.env.TMPDIR = path.join(scratch, 'tmp');
fs.mkdirSync(process.env.TMPDIR);
const forge = await startFakeForge();

// A second server that must never hear from the requester (a redirect's target), and
// that plays a GitLab host whose token glab keeps only in its config file.
const strangers = [];
const stranger = http.createServer((req, res) => {
  strangers.push({ url: req.url, headers: req.headers });
  res.writeHead(200, { 'content-type': 'application/json' }).end('{"id":1}');
});
await new Promise((resolve) => stranger.listen(0, '127.0.0.1', resolve));
const strangerOrigin = `http://127.0.0.1:${stranger.address().port}`;

// gh is counted, so a test can tell a cached token from one read again. As gh 2.101.0
// does, it hands GH_ENTERPRISE_TOKEN or GITHUB_ENTERPRISE_TOKEN, set here, to every host but github.com.
const ghCalls = path.join(scratch, 'gh-calls');
const countingGh = path.join(scratch, 'gh');
fs.writeFileSync(countingGh, `#!/bin/sh\necho call >> "${ghCalls}"\nfor t in "$GH_ENTERPRISE_TOKEN" "$GITHUB_ENTERPRISE_TOKEN"; do [ -n "$t" ] && [ "$4" != github.com ] && echo "$t" && exit 0; done\nexec "${forge.env.DN_GH}" "$@"\n`, { mode: 0o755 });
// glab as glab 1.128.0 answers: a host's own token, and for a host it holds nothing for, the
// config file's top-level one. A keyring holds the token of one more host. A token in
// GITLAB_TOKEN, GITLAB_ACCESS_TOKEN or OAUTH_TOKEN, set here, it hands every real host. Its
// default host is the first of GITLAB_HOST, GITLAB_URI and GL_HOST, else gitlab.com.
const realGlab = path.join(scratch, 'glab-cli');
fs.writeFileSync(realGlab, `#!/bin/sh\nif [ "$3" = host ]; then for h in "$GITLAB_HOST" "$GITLAB_URI" "$GL_HOST" gitlab.com; do [ -n "$h" ] && echo "$h" && exit 0; done; fi\nfor t in "$GITLAB_TOKEN" "$GITLAB_ACCESS_TOKEN" "$OAUTH_TOKEN"; do [ -n "$t" ] && [ "$5" != host.invalid ] && echo "$t" && exit 0; done\n[ "$5" = gitlab.keyring.example ] && echo glpat-from-the-keyring && exit 0\n"${forge.env.DN_GLAB}" "$@" && exit 0\necho glpat-top-level-decoy\n`, { mode: 0o755 });
const CONFIG_TOKEN = 'glpat-kept-in-the-config-file';
fs.mkdirSync(path.join(scratch, 'glab'));
fs.writeFileSync(path.join(scratch, 'glab', 'config.yml'), `git_protocol: ssh\ntoken: glpat-top-level-decoy\nhosts:\n    other.example:\n        token: glpat-another-hosts\n    gitlab.file.example:\n        api_protocol: https\n        token: !!null ${CONFIG_TOKEN}\n        user: me\nlast: x\n`);
Object.assign(process.env, forge.env, {
  DN_GH: countingGh,
  GH_ENTERPRISE_TOKEN: 'ghp_any_enterprise_host',
  GITHUB_ENTERPRISE_TOKEN: 'ghp_any_enterprise_host_too',
  DN_GLAB: realGlab,
  GITLAB_TOKEN: 'glpat-from-the-shell',
  GITLAB_ACCESS_TOKEN: 'glpat-from-the-shell-too',
  OAUTH_TOKEN: 'glpat-from-the-shell-as-well',
  GITLAB_HOST: 'https://GitLab.Shell.example/',
  GLAB_CONFIG_DIR: path.join(scratch, 'glab'),
  DN_FORGE_ORIGINS: JSON.stringify({ ...JSON.parse(forge.env.DN_FORGE_ORIGINS), 'gitlab.file.example': strangerOrigin, 'gitlab.dead.example': 'http://127.0.0.1:9',
    'gitlab.other.example': strangerOrigin, 'gitlab.keyring.example': strangerOrigin, 'gitlab.shell.example': strangerOrigin, 'ghes.other.example': strangerOrigin,
    ...Object.fromEntries(['bare', 'uri', 'gl', 'second', 'url-a', 'url-c', ...[0, 1, 2, 3, 4, 5, 6, 7, 8].map((i) => `repo${i}`)].map((n) => [`gitlab.${n}.example`, strangerOrigin])),
    'gitlab.port.example:8443': strangerOrigin, 'gitlab.quoted.example:8443': strangerOrigin }),
  DN_FORGE_RESPONSE_MAX_BYTES: String(11 * 2 ** 20),
  DN_FORGE_TIMEOUT_MS: '1500',
});
const { createForge } = await import('../src/requester/forge.js');
const { authorize } = await import('../src/requester/authorize.js');
const { rulesFor } = await import('../src/requester/rules.js');

const logLines = [];
const errors = [];
const client = createForge({ log: (line) => logLines.push(line) });
const GITHUB = { forge: 'github', host: 'github.com' };
const GITLAB = { forge: 'gitlab', host: GITLAB_HOST };
const rules = (kind, item, options = {}) => rulesFor({ forge: 'github', kind, options, pool: 'github.com/o/r', item, identity: 'me' });
const failing = async (promise, pattern) => {
  const err = await promise.then(() => null, (e) => e);
  assert.ok(err, 'nothing was thrown');
  assert.match(err.message, pattern);
  errors.push(err.message, String(err.stack), String(err.cause));
};

// The forge's world: o/r with main and feature, pull request 579 opened by me from
// feature, 578 opened by them, 581 by me from feature in my fork of it, issue 421; and
// the same project on the GitLab host, with its fork.
const bare = forge.bare('o/r');
const labBare = forge.bare('group/sub/proj', { id: 'R_2', projectId: 99 });
const forkBare = forge.bare('me/r', { id: 'R_3', projectId: 12, parent: 'o/r', spelled: 'Me/R' });
forge.bare('me/proj', { id: 'R_4', projectId: 13, parent: 'group/sub/proj' });
const work = path.join(scratch, 'work');
git(scratch, 'clone', '--quiet', bare, 'work');
const commit = (message, files) => {
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(work, file)), { recursive: true });
    fs.writeFileSync(path.join(work, file), text);
  }
  git(work, 'add', '-A');
  git(work, 'commit', '--quiet', '-m', message);
  return git(work, 'rev-parse', 'HEAD');
};
const A = commit('root', { 'src/a.js': 'a\n', '.github/workflows/ci.yml': 'on: push\n' });
git(work, 'push', '--quiet', bare, `${A}:refs/heads/main`);
const B = commit('feature', { 'src/a.js': 'b\n' });
git(work, 'push', '--quiet', bare, `${B}:refs/heads/feature`);
git(work, 'push', '--quiet', forkBare, `${B}:refs/heads/feature`);
git(scratch, 'clone', '--quiet', bare, 'checkout');
const checkout = path.join(scratch, 'checkout');
const pr578 = forge.pull('o/r', { number: 578, author: 'them', head: 'theirs' });
const pr579 = forge.pull('o/r', { number: 579, author: 'me', head: 'feature', draft: true });
forge.pull('o/r', { number: 580, author: 'me', head: 'old', state: 'closed' });
forge.pull('o/r', { number: 581, author: 'me', head: 'feature', headRepo: 'me/r' });
forge.pull('o/r', { number: 582, author: 'them', head: 'gone', headRepo: null, state: 'closed' });
forge.pull('group/sub/proj', { number: 5, author: 'me', head: 'feature' });
forge.pull('group/sub/proj', { number: 6, author: 'them', head: 'forked', fork: true });
forge.pull('group/sub/proj', { number: 8, author: 'me', head: 'feature', headRepo: 'me/proj' });
forge.issue('o/r', { number: 421, author: 'reporter', assignees: ['bob'] });
forge.node('PRRT_579', { __typename: 'PullRequestReviewThread', pullRequest: pr579 });
forge.node('PRR_mine', { __typename: 'PullRequestReview', state: 'PENDING', author: { login: 'me' }, pullRequest: pr578 });
forge.node('PRRC_1', { __typename: 'PullRequestReviewComment', state: 'SUBMITTED', author: { login: 'them' }, pullRequest: pr579 });
forge.data.comments[13] = 'PRRC_1';

const ctxFor = (state = {}) => client.context({ ...GITHUB, repo: 'o/r', checkout, state });
const seen = (from = 0) => forge.log.slice(from);
async function perform(ruleList, request, ctx = ctxFor(), target = GITHUB) {
  const verdict = await authorize(ruleList, request, ctx);
  assert.equal(verdict.ok, true, verdict.reason);
  const res = await client.perform(verdict.request, target);
  return { ...res, bytes: Buffer.from(res.body, 'base64') };
}

await check('the forge is sent this machine\'s credential and nothing the executor said about itself', async () => {
  const before = forge.log.length;
  const request = gh('GET', '/repos/o/r/commits/abc?per_page=1');
  Object.assign(request.headers, {
    authorization: 'token gho_the_executors_own', Cookie: 'user_session=stolen', 'X-HTTP-Method-Override': 'DELETE', 'X-Forwarded-For': '10.0.0.1', 'Proxy-Authorization': 'Basic eA==',
    'X-GitHub-OTP': '123456', 'Private-Token': 'glpat-x', Host: 'evil.example', Connection: 'upgrade', Upgrade: 'h2c', TE: 'trailers', 'If-None-Match': '"etag"',
  });
  const res = await perform(rules('investigate', 'job-x'), request);
  assert.equal(res.status, 200);
  const [arrived] = seen(before);
  assert.equal(arrived.method, 'GET');
  assert.equal(arrived.path, '/repos/o/r/commits/abc?per_page=1');
  assert.equal(arrived.headers.authorization, `Bearer ${GITHUB_TOKEN}`);
  assert.equal(arrived.headers['user-agent'], 'diplomacy-network');
  assert.equal(arrived.headers.accept, '*/*');
  assert.equal(arrived.headers['if-none-match'], '"etag"');
  assert.equal(arrived.headers['x-github-api-version'], '2022-11-28');
  for (const name of ['cookie', 'x-http-method-override', 'x-forwarded-for', 'proxy-authorization', 'x-github-otp', 'private-token', 'upgrade', 'te', 'time-zone']) {
    assert.equal(arrived.headers[name], undefined, name);
  }
  assert.ok(!JSON.stringify(arrived.headers).includes('gho_the_executors_own') && !JSON.stringify(arrived.headers).includes('evil.example'));
});

await check('the answer comes back whole: status, body, and only the headers an executor may see', async () => {
  const res = await perform(rules('investigate', 'job-x'), gh('GET', '/repos/o/r/commits/abc'));
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.bytes), { path: '/repos/o/r/commits/abc', ok: true });
  assert.deepEqual(Object.keys(res.headers).sort(), ['content-type', 'etag', 'link', 'x-github-request-id', 'x-ratelimit-remaining']);
  assert.equal(res.headers.link, '<https://api.github.com/next>; rel="next"');
  assert.equal(res.headers['set-cookie'], undefined);
  assert.equal(res.headers['www-authenticate'], undefined);
  const missing = await perform(rules('investigate', 'job-x'), gh('GET', '/repos/o/r/pulls/999'));
  assert.equal(missing.status, 404);
  assert.deepEqual(JSON.parse(missing.bytes), { message: 'Not Found' });

  const big = crypto.randomBytes(10 * 2 ** 20);
  forge.route('api.github.com', 'GET', /^\/repos\/o\/r\/contents\/big\.bin$/, (req, res) => res.writeHead(200, { 'content-type': 'application/vnd.github.raw' }).end(big));
  forge.route('api.github.com', 'GET', /^\/repos\/o\/r\/contents\/huge\.bin$/, (req, res) => res.writeHead(200, { 'content-type': 'application/vnd.github.raw' }).end(Buffer.alloc(12 * 2 ** 20)));
  const binary = await perform(rules('investigate', 'job-x'), gh('GET', '/repos/o/r/contents/big.bin'));
  assert.equal(binary.headers['content-type'], 'application/vnd.github.raw');
  assert.ok(binary.bytes.equals(big), 'ten mebibytes of binary arrive byte for byte');
  await failing(perform(rules('investigate', 'job-x'), gh('GET', '/repos/o/r/contents/huge.bin')), /larger than a task may receive/);
});

await check('text policy-bot would count as an approval is refused, by the policy it reads for the pull request\'s base', async () => {
  // A base branch whose .policy.yml approves on words of its own, and a pull request into it.
  git(work, 'checkout', '--quiet', '-b', 'release', A);
  const C = commit('policy', { '.policy.yml': [
    'approval_rules:',
    '  - name: one reviewer',
    '    options:',
    '      methods:',
    '        comments: ["LGTM"]',
    '        comment_patterns:',
    "          - '(?i)\\bship ?it\\b'",
    '    requires: { count: 1 }',
    'policy:',
    '  approval: [one reviewer]',
    '',
  ].join('\n') });
  git(work, 'push', '--quiet', bare, `${C}:refs/heads/release`);
  forge.pull('o/r', { number: 583, author: 'them', head: 'theirs', base: 'release' });
  const review = (body, state = {}) => authorize(rules('review', 'pr-583'), gh('POST', '/repos/o/r/pulls/583/reviews', { event: 'COMMENT', body }), ctxFor(state));
  const said = /^the body member "body" (holds "LGTM"|matches the pattern "\(\?i\)\\\\bship \?it\\\\b"), which the pool repository's policy-bot policy \(o\/r\/\.policy\.yml\) counts as an approval or a disapproval from whoever wrote it: reword it and send the request again$/;
  const state = {};
  const before = forge.log.length;
  // Go's (?i) folds "ſ" to "s", and its \b counts ASCII word characters alone: "xſhip it" holds a boundary
  // before "ſhip" there, and a text that starts with "ſ" has none (asked of Go 1.27's regexp).
  for (const text of ['LGTM, one nit', 'Ship it', 'xſhip it']) {
    const verdict = await review(text, state);
    assert.equal(verdict.ok, false, text);
    assert.match(verdict.reason, said);
  }
  for (const text of ['looks fine', 'shipits', 'lgtm', 'ſhip it, then']) assert.equal((await review(text, state)).ok, true, text);
  // The task read the policy once; another task reads it again.
  const reads = (from) => seen(from).filter((r) => r.path.includes('/contents/')).map((r) => r.path);
  assert.deepEqual(reads(before), ['/repos/o/r/contents/.policy.yml?ref=release', '/repos/o/.github/contents/policy.yml']);
  const again = forge.log.length;
  assert.equal((await review('Ship it')).ok, false);
  assert.equal(reads(again).length, 2);
  // A job-wide review asks about the pull request once for both its checks.
  const wide = forge.log.length;
  assert.equal((await authorize(rules('review', 'job-all'), gh('POST', '/repos/o/r/pulls/583/reviews', { event: 'COMMENT', body: 'fine' }), ctxFor(state))).ok, true);
  assert.deepEqual(seen(wide).map((r) => r.path), ['/repos/o/r/pulls/583']);
  // A policy's defaults are refused whatever the policy says; an issue's comment is not read for one.
  assert.match((await review('👍🏽 nice')).reason, /^the body member "body" holds "👍", which policy-bot, a bot that gates merging, counts as an approval/);
  const onIssue = forge.log.length;
  assert.equal((await authorize(rules('issues', 'issue-421'), gh('POST', '/repos/o/r/issues/421/comments', { body: 'Ship it' }), ctxFor())).ok, true);
  assert.deepEqual(reads(onIssue), []);
  // GitHub posts an issue comment on a pull request's number as a comment on the pull request.
  assert.match((await authorize(rules('issues', 'issue-583'), gh('POST', '/repos/o/r/issues/583/comments', { body: 'Ship it' }), ctxFor())).reason, said);

  // A policy in another repository, which the account cannot read, and then can.
  git(work, 'checkout', '--quiet', '-b', 'far', A);
  const D = commit('remote', { '.policy.yml': 'remote: o/policies\npath: shared/p.yml\n' });
  git(work, 'push', '--quiet', bare, `${D}:refs/heads/far`);
  forge.pull('o/r', { number: 584, author: 'them', head: 'theirs', base: 'far' });
  const far = (body) => authorize(rules('review', 'pr-584'), gh('POST', '/repos/o/r/pulls/584/reviews', { event: 'COMMENT', body }), ctxFor());
  assert.match((await far('fine')).reason, /^the body member "body" cannot be checked against the pool repository's policy-bot policy, so no text is sent on its pull requests: o\/r\/\.policy\.yml names o\/policies\/shared\/p\.yml, which this machine's account cannot read$/);
  const policies = forge.bare('o/policies', { id: 'R_9' });
  git(scratch, 'clone', '--quiet', policies, 'policies');
  const there = path.join(scratch, 'policies');
  fs.mkdirSync(path.join(there, 'shared'));
  fs.writeFileSync(path.join(there, 'shared/p.yml'), 'approval_defaults:\n  options:\n    methods:\n      comments: [":shipit:"]\n');
  git(there, 'add', '-A');
  git(there, 'commit', '--quiet', '-m', 'p');
  git(there, 'push', '--quiet', 'origin', 'HEAD:main');
  assert.match((await far('so :shipit:')).reason, /holds ":shipit:", which the pool repository's policy-bot policy \(o\/policies\/shared\/p\.yml\) counts/);
  assert.equal((await far('fine')).ok, true);

  // A policy this cannot read refuses text on the repository, saying why.
  git(work, 'checkout', '--quiet', '-b', 'odd', A);
  const E = commit('odd', { '.policy.yml': 'approval_rules:\n  - name: !!str tagged\n' });
  git(work, 'push', '--quiet', bare, `${E}:refs/heads/odd`);
  forge.pull('o/r', { number: 585, author: 'them', head: 'theirs', base: 'odd' });
  const odd = await authorize(rules('review', 'pr-585'), gh('POST', '/repos/o/r/pulls/585/reviews', { event: 'COMMENT', body: 'fine' }), ctxFor());
  assert.match(odd.reason, /cannot be checked against the pool repository's policy-bot policy, so no text is sent on its pull requests: o\/r\/\.policy\.yml cannot be read here: its line 2 holds a kind of YAML this does not read$/);

  // The owner's shared policy is read beside the repository's own.
  const shared = forge.bare('o/.github', { id: 'R_10' });
  git(scratch, 'clone', '--quiet', shared, 'shared');
  fs.writeFileSync(path.join(scratch, 'shared/policy.yml'), 'approval_rules:\n- name: org\n  options:\n    methods:\n      comments: ["+1 from the org"]\n');
  git(path.join(scratch, 'shared'), 'add', '-A');
  git(path.join(scratch, 'shared'), 'commit', '--quiet', '-m', 'org');
  git(path.join(scratch, 'shared'), 'push', '--quiet', 'origin', 'HEAD:main');
  assert.match((await review('+1 from the org')).reason, /\(o\/r\/\.policy\.yml, o\/\.github\/policy\.yml\) counts/);
  // The rest of the file's world is as it was.
  git(work, 'checkout', '--quiet', 'main');
  git(work, 'push', '--quiet', bare, ':refs/heads/release', ':refs/heads/far', ':refs/heads/odd');
  for (const n of [583, 584, 585]) {
    delete forge.data.repos['o/r'].pulls[n];
    delete forge.data.nodes[`PR_${n}`];
  }
});

await check('a write carries its checked body, and a pinned answer is cut to its public members', async () => {
  const before = forge.log.length;
  const res = await perform(rules('review', 'pr-578'), gh('POST', '/repos/o/r/pulls/578/reviews', { commit_id: 'abc123', body: 'héllo' }));
  assert.equal(res.status, 201);
  // Before it, what the review goes on and the policy files policy-bot would read for it.
  assert.deepEqual(seen(before).map((r) => `${r.method} ${r.path}`), [
    'GET /repos/o/r/pulls/578', 'GET /repos/o/r/contents/.policy.yml?ref=main', 'GET /repos/o/.github/contents/policy.yml', 'POST /repos/o/r/pulls/578/reviews',
  ]);
  const arrived = seen(before).at(-1);
  assert.equal(arrived.headers['content-type'], 'application/json; charset=utf-8');
  assert.deepEqual(JSON.parse(arrived.body), { commit_id: 'abc123', body: '<!-- sent through the Diplomacy Network -->\nhéllo' });
  const user = await perform(rules('review', 'pr-578'), gh('GET', '/user'));
  assert.deepEqual(JSON.parse(user.bytes), { login: 'me', id: 7, node_id: 'U_me', type: 'User', name: 'Me', html_url: 'https://github.com/me' });
  // A list is cut entry by entry, and an answer that is neither an object nor a list of them is not passed on.
  const glRules = rulesFor({ forge: 'gitlab', kind: 'investigate', pool: `${GITLAB_HOST}/group/sub/proj`, item: 'job-x', identity: 'me' });
  const answering = async (text) => {
    const remove = forge.route(GITLAB_HOST, 'GET', /^\/api\/v4\/user$/, (req, res) => res.writeHead(200, { 'content-type': 'application/json' }).end(text));
    const res = await perform(glRules, glab('GET', '/api/v4/user'), {}, GITLAB);
    remove();
    assert.ok(!res.bytes.toString().includes('private@example.com'));
    return res;
  };
  const list = await answering('[{"id":7,"email":"private@example.com"},{"username":"me","email":"private@example.com"}]');
  assert.equal(list.status, 200);
  assert.deepEqual(JSON.parse(list.bytes), [{ id: 7 }, { username: 'me' }]);
  for (const odd of ['[{"id":7},"private@example.com"]', '"private@example.com"', '[["private@example.com"]]', 'private@example.com']) assert.equal((await answering(odd)).status, 502, odd);
  // The repository's own answer: without the clone token, the requester's rights or the repository it forks.
  const repo = JSON.parse((await perform(rules('investigate', 'job-x'), gh('GET', '/repos/o/r'))).bytes);
  assert.equal(repo.default_branch, 'main');
  for (const member of ['temp_clone_token', 'permissions', 'parent', 'security_and_analysis']) assert.equal(repo[member], undefined, member);
  const glProject = JSON.parse((await perform(glRules, glab('GET', '/api/v4/projects/group%2Fsub%2Fproj'), {}, GITLAB)).bytes);
  assert.equal(glProject.default_branch, 'main');
  for (const member of ['runners_token', 'import_url', 'service_desk_address', 'permissions', 'forked_from_project']) assert.equal(glProject[member], undefined, member);
  // A branch, on both forges: without its protection settings and without what the requester may do to it.
  assert.deepEqual(JSON.parse((await perform(rules('investigate', 'job-x'), gh('GET', '/repos/o/r/branches/main'))).bytes), { name: 'main', commit: { sha: A }, protected: false });
  git(work, 'push', '--quiet', labBare, `${A}:refs/heads/shown`);
  const shown = { name: 'shown', commit: { id: A }, merged: false, protected: false, default: false, web_url: `https://${GITLAB_HOST}/group/sub/proj/-/tree/shown` };
  const project = '/api/v4/projects/group%2Fsub%2Fproj';
  assert.deepEqual(JSON.parse((await perform(glRules, glab('GET', `${project}/repository/branches/shown`), {}, GITLAB)).bytes), shown);
  assert.deepEqual(JSON.parse((await perform(glRules, glab('GET', `${project}/repository/branches?per_page=100`), {}, GITLAB)).bytes), [shown]);
  // What the forge itself answers holds them.
  const whole = async (host, token, url) => (await fetch(`http://127.0.0.1:${forge.port}/h/${host}${url}`, { headers: { authorization: `Bearer ${token}` } })).json();
  assert.deepEqual(Object.keys(await whole('api.github.com', GITHUB_TOKEN, '/repos/o/r/branches/main')), ['name', 'commit', 'protected', 'protection_url', 'protection']);
  const lab = await whole(GITLAB_HOST, GITLAB_TOKEN, `${project}/repository/branches/shown`);
  assert.deepEqual([lab.developers_can_push, lab.developers_can_merge, lab.can_push], [true, true, true]);
  git(labBare, 'update-ref', '-d', 'refs/heads/shown');
});

await check('an address of a person comes back as null wherever the answer holds it, and an answer that cannot be read is not passed on', async () => {
  const answering = async (host, method, pattern, text, ruleList, request, target) => {
    const remove = forge.route(host, method, pattern, (req, res) => res.writeHead(200, { 'content-type': 'application/json' }).end(text));
    try { return await perform(ruleList, request, {}, target); } finally { remove(); }
  };
  const glRules = rulesFor({ forge: 'gitlab', kind: 'investigate', pool: `${GITLAB_HOST}/group/sub/proj`, item: 'job-x', identity: 'me' });
  const issue = { iid: 421, title: 'help', service_desk_reply_to: 'reporter@example.com', author: { username: 'support-bot' } };
  const one = await answering(GITLAB_HOST, 'GET', /\/issues\/421$/, JSON.stringify(issue), glRules, glab('GET', '/api/v4/projects/group%2Fsub%2Fproj/issues/421'), GITLAB);
  assert.equal(one.status, 200);
  assert.deepEqual(JSON.parse(one.bytes), { ...issue, service_desk_reply_to: null });
  const list = await answering(GITLAB_HOST, 'GET', /\/issues$/, JSON.stringify([issue, { iid: 7, nested: { service_desk_reply_to: 'x@example.com' } }]), glRules, glab('GET', '/api/v4/projects/group%2Fsub%2Fproj/issues'), GITLAB);
  assert.deepEqual(JSON.parse(list.bytes), [{ ...issue, service_desk_reply_to: null }, { iid: 7, nested: { service_desk_reply_to: null } }]);
  for (const odd of ['reporter@example.com', '{"service_desk_reply_to":"reporter@example.com"']) {
    const res = await answering(GITLAB_HOST, 'GET', /\/issues\/421$/, odd, glRules, glab('GET', '/api/v4/projects/group%2Fsub%2Fproj/issues/421'), GITLAB);
    assert.equal(res.status, 502, odd);
    assert.ok(!res.bytes.toString().includes('reporter@example.com'), odd);
  }
  // GraphQL: by the name the query gave the member, wherever it stands.
  const graph = { data: { repository: { pullRequest: { title: 'authorEmail', autoMergeRequest: { authorEmail: 'private@example.com', mergeMethod: 'SQUASH' } } } } };
  const hub = await answering('api.github.com', 'POST', /^\/graphql$/, JSON.stringify(graph), rules('review', 'pr-578'), ghql(GH.prViewDefault), GITHUB);
  assert.deepEqual(JSON.parse(hub.bytes), { data: { repository: { pullRequest: { title: 'authorEmail', autoMergeRequest: { authorEmail: null, mergeMethod: 'SQUASH' } } } } });
  // An answer with nothing to blank comes back as the forge sent it, byte for byte.
  const plain = await answering(GITLAB_HOST, 'GET', /\/merge_requests\/5$/, '{"iid":5,  "title":"x"}', glRules, glab('GET', '/api/v4/projects/group%2Fsub%2Fproj/merge_requests/5'), GITLAB);
  assert.equal(plain.bytes.toString(), '{"iid":5,  "title":"x"}');
});

await check('a refused request never reaches the forge, and perform sends nothing authorize did not return', async () => {
  const before = forge.log.length;
  const ruleList = rules('review', 'pr-578');
  for (const request of [gh('PUT', '/repos/o/r/pulls/578/merge', {}), gh('GET', '/user/repos'), gh('POST', '/repos/o/r/pulls/578/reviews/1/events', { event: 'APPROVE' }),
    ghql({ query: '{ viewer { repositories(first: 9) { nodes { name } } } }' }), gh('GET', '/repos/o/r/../../user')]) {
    const verdict = await authorize(ruleList, request, ctxFor());
    assert.equal(verdict.ok, false);
    await failing(client.perform(request, GITHUB), /authorize did not allow/);
  }
  const ok = await authorize(ruleList, gh('GET', '/repos/o/r/pulls/578'), ctxFor());
  await failing(client.perform({ ...ok.request }, GITHUB), /authorize did not allow/);
  await failing(client.perform({ ...ok.request, path: '/user/repos' }, GITHUB), /authorize did not allow/);
  assert.deepEqual(seen(before), [], 'the forge heard nothing');
  // An allowed request is still bound to the forge its credential is for.
  await failing(client.perform(ok.request, GITLAB), /api\.github\.com is not a host of gitlab/);
  await failing(client.perform(ok.request, { forge: 'github', host: GHES_HOST }), /api\.github\.com is not a host of github ghes\.example\.com/);
  await failing(client.perform(ok.request, { forge: 'github', host: 'corp.ghe.com' }), /is not a host of github corp\.ghe\.com/);
  assert.deepEqual(seen(before), []);
});

await check('a redirect is handed back, not followed, so the credential goes nowhere else', async () => {
  // As GitHub answers for a job's log: with the place it is kept at.
  forge.data.repos['o/r'].runs = { 9: { branch: 'main', jobs: [91] } };
  forge.route('api.github.com', 'GET', /^\/repos\/o\/r\/actions\/jobs\/91\/logs$/, (req, res) => res.writeHead(302, { location: `${strangerOrigin}/steal` }).end());
  const heard = strangers.length;
  const res = await perform(rules('investigate', 'job-x'), gh('GET', '/repos/o/r/actions/jobs/91/logs'));
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, `${strangerOrigin}/steal`);
  assert.equal(strangers.length, heard, 'the redirect\'s target was never contacted');
});

await check('the token is read from gh once, kept briefly, and appears in no log line and no error', async () => {
  assert.equal(fs.readFileSync(ghCalls, 'utf8').trim().split('\n').length, 1, 'many requests, one call to gh');
  forge.route('api.github.com', 'GET', /^\/repos\/o\/r\/commits\/hang$/, () => {});
  await failing(perform(rules('investigate', 'job-x'), gh('GET', '/repos/o/r/commits/hang')), /no answer in time/);

  // GitLab: glab prints the token for a host it knows; for another, its config file is read.
  const before = forge.log.length;
  const glRules = (host) => rulesFor({ forge: 'gitlab', kind: 'investigate', pool: `${host}/group/sub/proj`, item: 'job-x', identity: 'me' });
  const request = (host) => ({ ...glab('GET', '/api/v4/projects/group%2Fsub%2Fproj/merge_requests/5'), host });
  assert.equal((await perform(glRules(GITLAB_HOST), request(GITLAB_HOST), {}, GITLAB)).status, 200);
  assert.equal(seen(before)[0].headers.authorization, `Bearer ${GITLAB_TOKEN}`);
  assert.equal(seen(before)[0].headers['private-token'], undefined);
  const heard = strangers.length;
  await perform(glRules('gitlab.file.example'), request('gitlab.file.example'), {}, { forge: 'gitlab', host: 'gitlab.file.example' });
  assert.equal(strangers[heard].headers.authorization, `Bearer ${CONFIG_TOKEN}`);
  await perform(glRules('gitlab.keyring.example'), request('gitlab.keyring.example'), {}, { forge: 'gitlab', host: 'gitlab.keyring.example' });
  assert.equal(strangers[heard + 1].headers.authorization, 'Bearer glpat-from-the-keyring');
  // A token in glab's environment is the host's that GITLAB_HOST names, and no other's.
  await perform(glRules('gitlab.shell.example'), request('gitlab.shell.example'), {}, { forge: 'gitlab', host: 'gitlab.shell.example' });
  assert.equal(strangers[heard + 2].headers.authorization, 'Bearer glpat-from-the-shell');
  // The top-level token glab gives a host it holds nothing for is no host's own, nor the one gh gives every enterprise host.
  await failing(perform(glRules('gitlab.other.example'), request('gitlab.other.example'), {}, { forge: 'gitlab', host: 'gitlab.other.example' }), /no gitlab credential for gitlab\.other\.example/);
  const elsewhere = rulesFor({ forge: 'github', kind: 'investigate', pool: 'ghes.other.example/o/r', item: 'job-x', identity: 'me' });
  await failing(perform(elsewhere, { ...gh('GET', '/api/v3/repos/o/r'), host: 'ghes.other.example' }, {}, { forge: 'github', host: 'ghes.other.example' }), /no github credential for ghes\.other\.example/);
  assert.equal(strangers.length, heard + 3);
  await failing(perform(glRules('gitlab.dead.example'), request('gitlab.dead.example'), {}, { forge: 'gitlab', host: 'gitlab.dead.example' }), /no gitlab credential for gitlab\.dead\.example/);
  fs.writeFileSync(path.join(scratch, 'glab', 'config.yml'), 'hosts:\n    gitlab.dead.example:\n        token: "glpat-for-a-dead-host"\n');
  await failing(perform(glRules('gitlab.dead.example'), request('gitlab.dead.example'), {}, { forge: 'gitlab', host: 'gitlab.dead.example' }), /unreachable/);

  // The token is the host's that glab calls its default, by whichever variable; a GITLAB_URL
  // or a GITLAB_REPO naming another host makes it nobody's.
  const shell = { GITLAB_HOST: process.env.GITLAB_HOST };
  const named = async (vars, host, token) => {
    for (const name of ['GITLAB_HOST', 'GITLAB_URI', 'GL_HOST', 'GITLAB_URL', 'GITLAB_REPO']) delete process.env[name];
    Object.assign(process.env, vars);
    const at = strangers.length;
    const sent = perform(glRules(host), request(host), {}, { forge: 'gitlab', host });
    if (token) {
      await sent;
      assert.equal(strangers[at].headers.authorization, `Bearer ${token}`, JSON.stringify(vars));
    } else {
      await failing(sent, new RegExp(`no gitlab credential for ${host.replaceAll('.', '\\.')}`));
    }
  };
  try {
    await named({ GITLAB_HOST: 'gitlab.bare.example' }, 'gitlab.bare.example', 'glpat-from-the-shell');
    await named({ GITLAB_URI: 'https://gitlab.uri.example' }, 'gitlab.uri.example', 'glpat-from-the-shell');
    await named({ GL_HOST: 'gitlab.gl.example' }, 'gitlab.gl.example', 'glpat-from-the-shell');
    await named({ GITLAB_HOST: 'gitlab.first.example', GL_HOST: 'gitlab.second.example' }, 'gitlab.second.example', null);
    await named({ GITLAB_HOST: 'gitlab.url-a.example', GITLAB_URL: 'https://gitlab.url-b.example' }, 'gitlab.url-a.example', null);
    await named({ GITLAB_HOST: 'gitlab.url-c.example', GITLAB_URL: 'https://gitlab.url-c.example/api' }, 'gitlab.url-c.example', 'glpat-from-the-shell');
    // A host whose token is read once is not asked again for a while, so each case has its own.
    const repos = [['corp.example/g/p', null], ['https://corp.example/g/p', null], ['git@corp.example:g/p.git', null], ['corp:8443/g/p', null],
      ['g/p', 'glpat-from-the-shell'], ['group/sub/p', 'glpat-from-the-shell'], ['GitLab.Repo6.example/g/p', 'glpat-from-the-shell'], ['https://gitlab.repo7.example/g/p', 'glpat-from-the-shell'],
      // OWNER/REPO names no host, a dot in OWNER or not.
      ['corp.example/p', 'glpat-from-the-shell']];
    for (const [i, [GITLAB_REPO, token]] of repos.entries()) await named({ GITLAB_HOST: `gitlab.repo${i}.example`, GITLAB_REPO }, `gitlab.repo${i}.example`, token);
  } finally {
    for (const name of ['GITLAB_URI', 'GL_HOST', 'GITLAB_URL', 'GITLAB_REPO']) delete process.env[name];
    Object.assign(process.env, shell);
  }

  const secrets = [GITHUB_TOKEN, GITLAB_TOKEN, CONFIG_TOKEN, 'glpat-for-a-dead-host', 'glpat-from-the-keyring', 'glpat-top-level-decoy', 'glpat-from-the-shell', 'ghp_any_enterprise_host', 'ghp_any_enterprise_host_too', Buffer.from(`x-access-token:${GITHUB_TOKEN}`).toString('base64'), Buffer.from(`oauth2:${GITLAB_TOKEN}`).toString('base64')];
  assert.ok(logLines.length > 10 && errors.length > 10);
  for (const text of [...logLines, ...errors]) for (const secret of secrets) assert.ok(!text.includes(secret), text);
  assert.ok(logLines.every((line) => !line.includes('?')), 'a log line carries no query string');
});

await check('a host\'s token in glab\'s config file comes from that host\'s own entry: a host named with a port, in quotes or not, is another entry', async () => {
  fs.writeFileSync(path.join(scratch, 'glab', 'config.yml'), [
    'hosts:',
    '    gitlab.file.example:', '        api_protocol: https', '        user: me',
    '',
    '    gitlab.port.example:8443:', '    # a note', '        oauth2_refresh_token: glrt-of-the-port', '        token: glpat-of-the-port',
    '    "gitlab.quoted.example:8443":', '        token: glpat-of-the-quoted',
    '    gitlab.empty.example:', '        user: me',
    '    gitlab.last.example: # a name this does not read', '        token: glpat-of-the-last',
    '    gitlab.bare.example?', '        token: glpat-of-the-bare',
    'other:',
    '    gitlab.file.example:', '        token: glpat-of-no-host',
    ''].join('\n'));
  const fresh = createForge();
  const heard = strangers.length;
  // An entry without a token has none, whatever the entries after it hold.
  for (const host of ['gitlab.file.example', 'gitlab.empty.example', 'gitlab.last.example', 'gitlab.bare.example', 'gitlab.port.example', 'gitlab.quoted.example']) {
    await failing(fresh.projectId({ forge: 'gitlab', host }, 'group/sub/proj'), new RegExp(`^forge: no gitlab credential for ${host.replaceAll('.', '\\.')} on this machine$`));
  }
  assert.equal(strangers.length, heard, 'nothing was sent');
  for (const [host, secret] of [['gitlab.port.example:8443', 'glpat-of-the-port'], ['gitlab.quoted.example:8443', 'glpat-of-the-quoted']]) {
    assert.equal(await fresh.projectId({ forge: 'gitlab', host }, 'group/sub/proj'), 1);
    assert.equal(strangers.at(-1).headers.authorization, `Bearer ${secret}`);
  }
});

await check('the forge answers what the deep checks ask: nodes, pull requests, comments, branches, the account', async () => {
  assert.deepEqual(await client.resolveNode(GITHUB, 'PRRT_579'), { type: 'PullRequestReviewThread', repo: 'o/r', item: 'pr', number: 579, open: true, itemAuthor: 'me', author: '', pending: false });
  assert.deepEqual(await client.resolveNode(GITHUB, 'PRR_mine'), { type: 'PullRequestReview', repo: 'o/r', item: 'pr', number: 578, open: true, itemAuthor: 'them', author: 'me', pending: true });
  assert.deepEqual(await client.resolveNode(GITHUB, 'PR_580'), { type: 'PullRequest', repo: 'o/r', item: 'pr', number: 580, open: false, itemAuthor: 'me', author: 'me', pending: false });
  assert.deepEqual(await client.resolveNode(GITHUB, 'I_421'), { type: 'Issue', repo: 'o/r', item: 'issue', number: 421, open: true, itemAuthor: 'reporter', author: 'reporter', pending: false });
  assert.deepEqual(await client.resolveNode(GITHUB, 'R_1'), { type: 'Repository', repo: 'o/r' });
  assert.deepEqual(await client.resolveNode(GITHUB, 'U_me'), { type: 'User', login: 'me' });
  assert.equal(await client.resolveNode(GITHUB, 'nothing'), null);
  assert.equal(await client.resolveNode(GITLAB, 'gid://gitlab/MergeRequest/1'), null);
  assert.deepEqual(await client.pull(GITHUB, 'o/r', 579), { number: 579, open: true, author: 'me', headRepo: 'o/r', headRepoId: 99, headRef: 'feature', baseRef: 'main', draft: true });
  assert.equal(await client.pull(GITHUB, 'o/r', 999), null);
  // A head branch in a fork is told by the fork's id; a fork that is gone has none.
  const head = (p) => [p.headRepo, p.headRepoId, p.headRef];
  assert.deepEqual(head(await client.pull(GITHUB, 'o/r', 581)), ['Me/R', 12, 'feature']);
  assert.deepEqual(head(await client.pull(GITHUB, 'o/r', 582)), ['', null, 'gone']);
  assert.deepEqual((await client.pullsByHead(GITHUB, 'o/r', 'feature')).map((p) => p.number), [579]);
  assert.deepEqual((await client.pullsByHead(GITHUB, 'o/r', 'feature', 'me')).map(head), [['Me/R', 12, 'feature']]);
  assert.deepEqual((await client.pullsByHead(GITHUB, 'o/r', 'feature', 'them')), []);
  assert.deepEqual((await client.pullsByHead(GITHUB, 'o/r')).map((p) => p.number), [578, 579, 581]);
  assert.deepEqual((await client.comment(GITHUB, 'o/r', 13)).number, 579);
  assert.equal(await client.comment(GITHUB, 'o/r', 14), null);
  assert.deepEqual(await client.assignees(GITHUB, 'o/r', 421), ['bob']);
  assert.deepEqual(await client.self(GITHUB), { id: 'U_me', login: 'me' });
  // A repository: whose it is and what it is a fork of, under the name the forge spells.
  assert.deepEqual(await client.repository(GITHUB, 'o/r'), { id: 99, name: 'o/r', owner: 'o', parent: 'upstream/private-parent', defaultBranch: 'main', ciPaths: [] });
  assert.deepEqual(await client.repository(GITHUB, 'me/r'), { id: 12, name: 'Me/R', owner: 'Me', parent: 'o/r', defaultBranch: 'main', ciPaths: [] });
  assert.equal(await client.repository(GITHUB, 'me/none'), null);
  assert.deepEqual(await client.branch(GITHUB, 'o/r', 'refs/heads/feature'), { sha: B, protected: false });
  assert.equal(await client.branch(GITHUB, 'o/r', 'refs/heads/none'), null);
  assert.deepEqual(await client.branch(GITHUB, 'me/r', 'refs/heads/feature'), { sha: B, protected: false });
  assert.equal(await client.branch(GITHUB, 'me/r', 'refs/heads/main'), null);
  // GitLab: a merge request names its source project by id alone, so one from a fork has no head repository by name.
  assert.deepEqual(await client.pull(GITLAB, 'group/sub/proj', 5), { number: 5, open: true, author: 'me', headRepo: 'group/sub/proj', headRepoId: 99, headRef: 'feature', baseRef: 'main', draft: false });
  assert.deepEqual(head(await client.pull(GITLAB, 'group/sub/proj', 6)), ['', 1234, 'forked']);
  assert.deepEqual(head(await client.pull(GITLAB, 'group/sub/proj', 8)), ['', 13, 'feature']);
  assert.deepEqual((await client.pullsByHead(GITLAB, 'group/sub/proj', 'feature', 'me')).map((p) => [p.number, p.headRepoId]), [[5, 99], [8, 13]]);
  assert.equal(await client.projectId(GITLAB, 'group/sub/proj'), 99);
  assert.equal(await client.projectId(GITHUB, 'o/r'), null);
  assert.deepEqual(await client.repository(GITLAB, 'group/sub/proj'), { id: 99, name: 'group/sub/proj', owner: 'group/sub', parent: 'upstream/private-parent', defaultBranch: 'main', ciPaths: [] });
  // A project is asked for by its path or by its number.
  const labFork = { id: 13, name: 'me/proj', owner: 'me', parent: 'group/sub/proj', defaultBranch: 'main', ciPaths: [] };
  assert.deepEqual(await client.repository(GITLAB, 'me/proj'), labFork);
  assert.deepEqual(await client.repository(GITLAB, '13'), labFork);
  assert.equal(await client.repository(GITLAB, 'me/none'), null);
  assert.equal(await client.repository(GITLAB, '4321'), null);
  assert.equal(await client.branch(GITLAB, 'group/sub/proj', 'refs/heads/none'), null);
  // A repository that is no fork has no parent.
  for (const [target, repo] of [[GITHUB, 'o/r'], [GITLAB, 'group/sub/proj']]) {
    forge.data.repos[repo].parent = null;
    try { assert.equal((await client.repository(target, repo)).parent, ''); } finally { delete forge.data.repos[repo].parent; }
  }

  // A task's lookups are about the pool's repository unless one names another.
  const ctx = ctxFor();
  assert.equal((await ctx.repository()).name, 'o/r');
  assert.equal((await ctx.repository('me/r')).id, 12);
  assert.equal(await ctx.branch('refs/heads/main', 'me/r'), null);
  assert.equal((await ctx.branch('refs/heads/main')).sha, A);
  assert.deepEqual((await ctx.pullsByHead('feature')).map((p) => p.number), [579]);
  assert.deepEqual((await ctx.pullsByHead('feature', 'me')).map((p) => p.number), [581]);

  // The same lookups behind authorize: a mutation's target is resolved on the forge before it is sent.
  const before = forge.data.mutations.length;
  const own = rules('review-own', 'pr-579', { markReady: true });
  assert.equal((await perform(own, ghql({ ...GH.resolveThread, variables: { t: 'PRRT_579' } }))).status, 200);
  assert.equal((await perform(own, ghql({ ...GH.prReady, variables: { input: { pullRequestId: 'PR_579' } } }))).status, 200);
  assert.deepEqual(forge.data.mutations.slice(before).map((m) => m.name), ['resolveReviewThread', 'markPullRequestReadyForReview']);
  assert.match((await authorize(own, ghql({ ...GH.prReady, variables: { input: { pullRequestId: 'PR_578' } } }), ctxFor())).reason, /belongs to #578, not #579/);
  assert.equal(forge.data.mutations.length, before + 2);
  const issue = rules('issues', 'issue-421');
  assert.equal((await perform(issue, ghql({ ...GH.assignSelf, variables: { input: { assignableId: 'I_421', actorLogins: ['bob', 'me'] } } }))).status, 200);
  assert.match((await authorize(issue, ghql(GH.assignSelf), ctxFor())).reason, /only add or remove this task's own account/);
});

// What `ask` resolves to while the forge answers `pattern` with `answer`.
const json = (status, body) => (req, res) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
const answered = async (host, method, pattern, answer, ask) => {
  const remove = forge.route(host, method, pattern, answer);
  try { return await ask(); } finally { remove(); }
};

await check('the forge says whether a protection rule would cover a branch nothing holds yet: a ruleset, a classic pattern, a GitLab wildcard', async () => {
  const lab = 'group/sub/proj';
  const set = (repo, more) => Object.assign(forge.data.repos[repo], more);
  const asks = async (target, repo, names) => Object.fromEntries(await Promise.all(names.map(async (name) => [name, await client.protects(target, repo, `refs/heads/${name}`)])));
  try {
    assert.deepEqual(await asks(GITHUB, 'o/r', ['release/9.9', 'x']), { 'release/9.9': false, x: false });
    set('o/r', { rulesets: ['release/*'] });
    assert.deepEqual(await asks(GITHUB, 'o/r', ['release/9.9', 'Release/9.9', 'x']), { 'release/9.9': true, 'Release/9.9': false, x: false });
    // An admin of the repository is shown its classic rules.
    set('o/r', { rulesets: [], viewerPermission: 'ADMIN', protected: ['v[0-9]*', 'hot?ix', 'ci/{a,b}', 'lit\\*', 'ci-[ab]', 'r1.0'] });
    // Read wider than GitHub matches: in any case, and "*" past a "/".
    assert.deepEqual(await asks(GITHUB, 'o/r', ['v1', 'V1/deep', 'hotfix', 'ci/a', 'ci/zzz', 'lit*', 'litx', 'w1', 'ci']),
      { v1: true, 'V1/deep': true, hotfix: true, 'ci/a': true, 'ci/zzz': true, 'lit*': true, litx: false, w1: false, ci: false });
    assert.deepEqual(await asks(GITHUB, 'o/r', ['hotfixes', 'ci-a', 'ci-ab', 'r1.0', 'r1x0']), { hotfixes: false, 'ci-a': true, 'ci-ab': false, 'r1.0': true, 'r1x0': false });
    // Every page of a repository's rules is read.
    set('o/r', { protected: [...Array.from({ length: 250 }, (_, i) => `rule-${i}`), 'last/*'] });
    assert.equal(await client.protects(GITHUB, 'o/r', 'refs/heads/last/one'), true);
    set('o/r', { protected: Array.from({ length: 1001 }, (_, i) => `rule-${i}`) });
    await failing(client.protects(GITHUB, 'o/r', 'refs/heads/x'), /did not say which protection rules cover refs\/heads\/x \(it has more than 10 pages of them\)/);
    // The fork's own rules decide a branch in the fork.
    set('o/r', { protected: [] });
    set('me/r', { viewerPermission: 'ADMIN', protected: ['release/*'] });
    assert.deepEqual([await client.protects(GITHUB, 'o/r', 'refs/heads/release/1'), await client.protects(GITHUB, 'me/r', 'refs/heads/release/1')], [false, true]);

    // Anyone else is shown none, and goes by the branches GitHub says are protected: a new one
    // beside one of them under the same "/", or differing from one only in its digits, may be
    // covered by the rule it is hidden behind.
    const head = git(bare, 'rev-parse', 'refs/heads/main');
    const held = ['release/1.0', 'v2.3', '10-stable', 'plain'];
    for (const name of held) git(bare, 'update-ref', `refs/heads/${name}`, head);
    try {
      set('o/r', { viewerPermission: 'WRITE', protected: ['release/*', 'v*', '*-stable', 'plain'] });
      assert.deepEqual(await asks(GITHUB, 'o/r', ['release/9.9', 'Release/x', 'release/1.0/deep', 'v9.10', 'V7.1', 'v9', '9-stable', 'x-stable', 'plain2', 'releasex', 'x']),
        { 'release/9.9': true, 'Release/x': true, 'release/1.0/deep': false, 'v9.10': true, 'V7.1': true, v9: false, '9-stable': true, 'x-stable': false, plain2: false, releasex: false, x: false });
      // A protected branch GitHub lists past the first page counts, and a list it does not finish does not answer.
      set('o/r', { protected: ['v*', 'z*'] });
      for (const name of [...Array.from({ length: 130 }, (_, i) => `v${i}x`), 'z9.1']) {
        git(bare, 'update-ref', `refs/heads/${name}`, head);
        held.push(name);
      }
      assert.equal(await client.protects(GITHUB, 'o/r', 'refs/heads/z1.1'), true);
      const endless = forge.route('api.github.com', 'GET', /^\/repos\/o\/r\/branches\?/, (req, res) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(Array.from({ length: 100 }, (_, i) => ({ name: `q${i}`, protected: true })))));
      try { await failing(client.protects(GITHUB, 'o/r', 'refs/heads/x'), /more than 10 pages of protected branches/); } finally { endless(); }
      for (const [status, text] of [[403, '{"message":"no"}'], [500, '[]'], [200, '{"branches":[]}'], [200, '[{"protected":true}]']]) {
        const remove = forge.route('api.github.com', 'GET', /^\/repos\/o\/r\/branches\?/, (req, res) => res.writeHead(status, { 'content-type': 'application/json' }).end(text));
        try { await failing(client.protects(GITHUB, 'o/r', 'refs/heads/x'), /the forge did not say which protection rules cover refs\/heads\/x/); } finally { remove(); }
      }
      // An admin goes by the rules alone.
      set('o/r', { viewerPermission: 'ADMIN', protected: ['v2.3'] });
      assert.equal(await client.protects(GITHUB, 'o/r', 'refs/heads/v9.9'), false);
    } finally {
      for (const name of held) git(bare, 'update-ref', '-d', `refs/heads/${name}`);
    }

    set(lab, { protected: ['*-stable', 'release/*'] });
    assert.deepEqual(await asks(GITLAB, lab, ['9-stable', 'a/b-stable', 'release/1/2', 'Release/1', 'stable']), { '9-stable': true, 'a/b-stable': true, 'release/1/2': true, 'Release/1': true, stable: false });
    set(lab, { protected: [...Array.from({ length: 100 }, (_, i) => `rule-${i}`), 'main-*'] });
    assert.equal(await client.protects(GITLAB, lab, 'refs/heads/main-x'), true);
    set(lab, { protected: Array.from({ length: 1000 }, (_, i) => `rule-${i}`) });
    await failing(client.protects(GITLAB, lab, 'refs/heads/x'), /more than 10 pages/);
    set(lab, { protected: [] });

    // An answer that does not say is no "no".
    for (const [host, method, pattern, status, text, target, repo] of [
      ['api.github.com', 'GET', /\/rules\/branches\//, 404, '{"message":"Not Found"}', GITHUB, 'o/r'],
      ['api.github.com', 'GET', /\/rules\/branches\//, 200, '{"rules":[]}', GITHUB, 'o/r'],
      ['api.github.com', 'GET', /\/rules\/branches\//, 500, '[]', GITHUB, 'o/r'],
      ['api.github.com', 'POST', /^\/graphql$/, 200, '{"data":{"repository":{"branchProtectionRules":{"nodes":[],"pageInfo":{"hasNextPage":false}}}},"errors":[{"message":"partly"}]}', GITHUB, 'o/r'],
      ['api.github.com', 'POST', /^\/graphql$/, 200, '{"data":{"repository":{"branchProtectionRules":null}},"errors":[{"message":"Must have admin rights"}]}', GITHUB, 'o/r'],
      ['api.github.com', 'POST', /^\/graphql$/, 200, '{"data":{"repository":null}}', GITHUB, 'o/r'],
      ['api.github.com', 'POST', /^\/graphql$/, 200, '{"data":{"repository":{"branchProtectionRules":{"nodes":[{"pattern":null}],"pageInfo":{"hasNextPage":false}}}}}', GITHUB, 'o/r'],
      ['api.github.com', 'POST', /^\/graphql$/, 200, 'not json', GITHUB, 'o/r'],
      [GITLAB_HOST, 'GET', /\/protected_branches/, 403, '{"message":"403 Forbidden"}', GITLAB, lab],
      [GITLAB_HOST, 'GET', /\/protected_branches/, 200, '[{"id":1}]', GITLAB, lab],
      [GITLAB_HOST, 'GET', /\/protected_branches/, 500, '[]', GITLAB, lab],
    ]) {
      const remove = forge.route(host, method, pattern, (req, res) => res.writeHead(status, { 'content-type': 'application/json' }).end(text));
      try { await failing(client.protects(target, repo, 'refs/heads/x'), /forge: the forge did not say which protection rules cover refs\/heads\/x/); } finally { remove(); }
    }
    await failing(client.protects(GITHUB, 'o/r', 'refs/tags/v1'), /refs\/tags\/v1 is not a branch/);
  } finally {
    for (const repo of ['o/r', 'me/r', lab]) for (const key of ['protected', 'rulesets', 'viewerPermission']) delete forge.data.repos[repo][key];
  }
});

await check('a lookup the forge did not settle throws: only the forge\'s own "no such thing" reads as absent', async () => {
  const feature = { name: 'feature', commit: { sha: B }, protected: false };
  const branchOf = /^\/repos\/o\/r\/branches\/feature$/;
  const ask = () => client.branch(GITHUB, 'o/r', 'refs/heads/feature');
  // A rate limit, an outage, a proxy's page and the repository's own 404 say nothing about the branch.
  for (const [status, body] of [[403, { message: 'API rate limit exceeded' }], [429, { message: 'slow down' }], [500, {}], [502, '<html>'], [404, { message: 'Not Found' }], [404, {}], [301, { message: 'Moved Permanently' }],
    [403, feature], [404, feature], [200, { ...feature, name: 'other' }], [200, { ...feature, protected: undefined }], [200, { ...feature, commit: { sha: 'main' } }], [200, [feature]], [200, 'null']]) {
    await failing(answered('api.github.com', 'GET', branchOf, json(status, body), ask), new RegExp(`the forge did not say where refs/heads/feature is \\(it answered ${status}\\)`));
  }
  assert.equal(await answered('api.github.com', 'GET', branchOf, json(404, { message: 'Branch not found' }), ask), null);
  assert.deepEqual(await answered('api.github.com', 'GET', branchOf, json(200, { ...feature, protected: true }), ask), { sha: B, protected: true });
  const glBranch = /^\/api\/v4\/projects\/group%2Fsub%2Fproj\/repository\/branches\/a%2Fb$/;
  const glAsk = () => client.branch(GITLAB, 'group/sub/proj', 'refs/heads/a/b');
  for (const [status, body] of [[404, { message: '404 Project Not Found' }], [404, { message: '404 Not Found' }], [429, { message: 'Retry later' }], [403, { name: 'a/b', commit: { id: B }, protected: false }]]) {
    await failing(answered(GITLAB_HOST, 'GET', glBranch, json(status, body), glAsk), /did not say where refs\/heads\/a\/b is/);
  }
  assert.equal(await answered(GITLAB_HOST, 'GET', glBranch, json(404, { message: '404 Branch Not Found' }), glAsk), null);
  assert.deepEqual(await answered(GITLAB_HOST, 'GET', glBranch, json(200, { name: 'a/b', commit: { id: B }, protected: true, default: false }), glAsk), { sha: B, protected: true });
  await failing(client.branch(GITHUB, 'o/r', 'refs/tags/v1'), /refs\/tags\/v1 is not a branch/);

  // An answer about another pull request is not an answer about this one.
  const other = { number: 578, state: 'open', user: { login: 'them' }, head: { ref: 'theirs', repo: { full_name: 'o/r' } }, base: { ref: 'main' } };
  await failing(answered('api.github.com', 'GET', /^\/repos\/o\/r\/pulls\/577$/, json(200, other), () => client.pull(GITHUB, 'o/r', 577)), /did not say what #577 is/);
  await failing(answered(GITLAB_HOST, 'GET', /\/merge_requests\/4$/, json(200, { iid: 5, state: 'opened' }), () => client.pull(GITLAB, 'group/sub/proj', 4)), /did not say what #4 is/);
  await failing(answered('api.github.com', 'GET', /^\/repos\/o\/r\/pulls\/579$/, json(403, { message: 'API rate limit exceeded' }), () => client.pull(GITHUB, 'o/r', 579)), /did not say what #579 is \(it answered 403\)/);
  await failing(answered('api.github.com', 'GET', /^\/repos\/o\/r\/pulls\?/, json(403, { message: 'API rate limit exceeded' }), () => client.pullsByHead(GITHUB, 'o/r', 'feature')), /did not say which pull requests there are/);
  await failing(answered('api.github.com', 'GET', /^\/repos\/o\/r\/pulls\?/, json(200, { message: 'x' }), () => client.pullsByHead(GITHUB, 'o/r')), /did not say which pull requests there are/);
  await failing(answered('api.github.com', 'GET', /^\/repos\/o\/r\/pulls\/comments\/13$/, json(500, {}), () => client.comment(GITHUB, 'o/r', 13)), /did not say what comment 13 is/);
  await failing(answered('api.github.com', 'GET', /^\/repos\/o\/r\/issues\/421$/, json(403, { message: 'API rate limit exceeded' }), () => client.assignees(GITHUB, 'o/r', 421)), /did not say who is assigned to #421/);
  await failing(answered('api.github.com', 'GET', /^\/repos\/o\/r\/issues\/421$/, json(200, { assignees: [{ login: 'bob' }, null] }), () => client.assignees(GITHUB, 'o/r', 421)), /did not say who is assigned to #421/);
  assert.equal(await answered('api.github.com', 'GET', /^\/repos\/o\/r\/issues\/999$/, json(404, { message: 'Not Found' }), () => client.assignees(GITHUB, 'o/r', 999)), null);
  await failing(answered('api.github.com', 'POST', /^\/graphql$/, json(502, {}), () => client.self(GITHUB)), /did not say which account this is/);
  await failing(answered('api.github.com', 'GET', /^\/repos\/o\/r$/, json(403, { message: 'API rate limit exceeded' }), () => client.repository(GITHUB, 'o/r')), /did not say which branch is the default \(it answered 403\)/);
  await failing(answered('api.github.com', 'GET', /^\/repos\/o\/r$/, json(200, { default_branch: '' }), () => client.repository(GITHUB, 'o/r')), /did not say which branch is the default/);
  // An answer that is not about the repository asked for, or leaves out whose it is or what it is a fork of, has not said.
  const repoOf = (answer, repo = 'o/r') => answered('api.github.com', 'GET', /^\/repos\/[^/]+\/[^/]+$/, json(200, answer), () => client.repository(GITHUB, repo));
  const said = { id: 99, full_name: 'O/R', owner: { login: 'O' }, default_branch: 'main' };
  assert.deepEqual(await repoOf(said), { id: 99, name: 'O/R', owner: 'O', parent: '', defaultBranch: 'main', ciPaths: [] });
  assert.equal((await repoOf({ ...said, parent: { full_name: 'Up/Stream' } })).parent, 'Up/Stream');
  for (const answer of [{ ...said, full_name: 'o/other' }, { ...said, full_name: undefined }, { ...said, id: '99' }, { ...said, id: undefined }, { ...said, owner: {} }, { ...said, owner: { login: '' } },
    { ...said, owner: { login: 7 } }, { ...said, parent: null }, { ...said, parent: {} }, { ...said, parent: { full_name: '' } }, { ...said, parent: { full_name: 7 } }]) {
    await failing(repoOf(answer), /did not say which repository o\/r is \(it answered 200\)/);
  }
  await failing(repoOf(said, 'me/r'), /did not say which repository me\/r is/);
  await failing(answered('api.github.com', 'GET', /^\/repos\/me\/r$/, json(301, { message: 'Moved Permanently' }), () => client.repository(GITHUB, 'me/r')), /did not say which branch is the default \(it answered 301\)/);
  await failing(answered('api.github.com', 'GET', /^\/repos\/me\/r$/, json(404, {}), () => client.repository(GITHUB, 'me/r')), /did not say which branch is the default \(it answered 404\)/);
  const projectOf = (answer, repo) => answered(GITLAB_HOST, 'GET', /^\/api\/v4\/projects\/[^/]+$/, json(200, answer), () => client.repository(GITLAB, repo));
  const project = { id: 13, path_with_namespace: 'Me/Proj', namespace: { full_path: 'Me' }, default_branch: 'main', ci_config_path: null, forked_from_project: { path_with_namespace: 'Group/Sub/Proj' } };
  const read = { id: 13, name: 'Me/Proj', owner: 'Me', parent: 'Group/Sub/Proj', defaultBranch: 'main', ciPaths: [] };
  assert.deepEqual(await projectOf(project, 'me/proj'), read);
  assert.deepEqual(await projectOf(project, '13'), read);
  await failing(projectOf(project, '14'), /did not say which repository 14 is/);
  await failing(projectOf(project, 'me/other'), /did not say which repository me\/other is/);
  await failing(projectOf({ ...project, path_with_namespace: '13' }, 'me/proj'), /did not say which repository me\/proj is/);
  for (const answer of [{ ...project, namespace: undefined }, { ...project, namespace: { full_path: '' } }, { ...project, forked_from_project: null }, { ...project, forked_from_project: {} }, { ...project, id: 13.5 }]) {
    await failing(projectOf(answer, 'me/proj'), /did not say which repository me\/proj is/);
  }

  // A node: null beside the forge's NOT_FOUND is absent; null beside anything else, or no answer, is unknown.
  const node = () => client.resolveNode(GITHUB, 'PR_579');
  assert.equal(await answered('api.github.com', 'POST', /^\/graphql$/, json(200, { data: { node: null }, errors: [{ type: 'NOT_FOUND', message: 'Could not resolve' }] }), node), null);
  for (const [status, body] of [[200, { data: { node: null }, errors: [{ type: 'RATE_LIMITED' }] }], [200, { data: null, errors: [{ type: 'NOT_FOUND' }] }], [200, { errors: [{ message: 'timeout' }] }], [403, { message: 'secondary rate limit' }], [502, {}]]) {
    await failing(answered('api.github.com', 'POST', /^\/graphql$/, json(status, body), node), /did not say what PR_579 is/);
  }

  // Where a GitLab project reads its CI configuration from, as paths of its own repository.
  const configured = async (value) => {
    forge.data.repos['group/sub/proj'].ciConfigPath = value;
    try { return (await client.repository(GITLAB, 'group/sub/proj')).ciPaths; } finally { delete forge.data.repos['group/sub/proj'].ciConfigPath; }
  };
  assert.deepEqual(await configured(''), []);
  assert.deepEqual(await configured('ci/build.yml'), ['ci/build.yml']);
  assert.deepEqual(await configured('/ci/build.yml'), ['ci/build.yml']);
  assert.deepEqual(await configured('ci/build.yml@Group/Sub/Proj'), ['ci/build.yml@Group/Sub/Proj', 'ci/build.yml']);
  assert.deepEqual(await configured('ci/build.yml@group/sub/proj:release'), ['ci/build.yml@group/sub/proj:release', 'ci/build.yml']);
  assert.deepEqual(await configured('ci/build.yml@group/other'), ['ci/build.yml@group/other']);
  assert.deepEqual(await configured('https://ci.example/build.yml'), ['https://ci.example/build.yml']);
  await failing(configured(7), /did not say where the project reads its CI configuration from/);
  await failing(answered(GITLAB_HOST, 'GET', /^\/api\/v4\/projects\/group%2Fsub%2Fproj$/, json(200, { default_branch: 'main' }), () => client.repository(GITLAB, 'group/sub/proj')), /did not say where the project reads its CI configuration from/);
});

await check('the forge says which branch a CI run ran for: asked by the run or by a job of it, a merge request\'s pipeline by its source branch, a tag\'s not at all', async () => {
  const lab = 'group/sub/proj';
  forge.data.repos['o/r'].runs = { 7: { branch: 'feature', jobs: [71, 72] }, 9: { branch: 'main', jobs: [91] }, 11: { branch: 'feature', repo: 'Me/R', jobs: [111] } };
  forge.data.repos[lab].runs = { 7: { branch: 'feature', jobs: [71] }, 16: { pull: 6, jobs: [161] }, 17: { pull: 77, jobs: [] }, 18: { branch: 'v1.0', tag: true, jobs: [181] } };
  const feature = { repo: 'o/r', ref: 'refs/heads/feature' };
  const before = forge.log.length;
  assert.deepEqual(await client.ciRun(GITHUB, 'o/r', 'run', 7), feature);
  assert.deepEqual(await client.ciRun(GITHUB, 'o/r', 'job', 72), feature);
  // A job does not say whose repository its branch is in: its run is asked for.
  assert.deepEqual(seen(before).map((r) => r.path), ['/repos/o/r/actions/runs/7', '/repos/o/r/actions/jobs/72', '/repos/o/r/actions/runs/7']);
  assert.deepEqual(await client.ciRun(GITHUB, 'o/r', 'job', 111), { repo: 'Me/R', ref: 'refs/heads/feature' });
  assert.deepEqual(await ctxFor().run('job', 91), { repo: 'o/r', ref: 'refs/heads/main' });
  for (const [what, id] of [['run', 71], ['job', 7], ['run', 99]]) assert.equal(await client.ciRun(GITHUB, 'o/r', what, id), null, `${what} ${id}`);
  assert.deepEqual(await client.ciRun(GITLAB, lab, 'run', 7), { repo: lab, ref: 'refs/heads/feature' });
  assert.deepEqual(await client.ciRun(GITLAB, lab, 'job', 71), { repo: lab, ref: 'refs/heads/feature' });
  // A merge request's pipeline: the merge request's source branch, in whichever project that is.
  assert.deepEqual(await client.ciRun(GITLAB, lab, 'run', 16), { repo: '', ref: 'refs/heads/forked', pull: 6 });
  assert.deepEqual(await client.ciRun(GITLAB, lab, 'job', 161), { repo: '', ref: 'refs/heads/forked', pull: 6 });
  // Of a merge request that is gone, of a tag, or no run at all.
  for (const [what, id] of [['run', 17], ['run', 18], ['job', 181], ['run', 71], ['job', 7], ['run', 99]]) assert.equal(await client.ciRun(GITLAB, lab, what, id), null, `${what} ${id}`);

  // An answer that is no run, is another run's, or leaves the branch or its repository out has not said.
  const run = { id: 7, head_branch: 'feature', head_repository: { full_name: 'o/r' } };
  const runAt = /^\/repos\/o\/r\/actions\/runs\/7$/;
  const askRun = () => client.ciRun(GITHUB, 'o/r', 'run', 7);
  assert.deepEqual(await answered('api.github.com', 'GET', runAt, json(200, run), askRun), feature);
  for (const [status, body] of [[403, { message: 'API rate limit exceeded' }], [500, {}], [404, {}], [403, run], [200, { ...run, id: 8 }], [200, { ...run, head_branch: null }], [200, { ...run, head_branch: '' }],
    [200, { ...run, head_repository: null }], [200, { ...run, head_repository: { full_name: '' } }], [200, [run]]]) {
    await failing(answered('api.github.com', 'GET', runAt, json(status, body), askRun), new RegExp(`the forge did not say what CI run 7 ran for \\(it answered ${status}\\)`));
  }
  const jobAt = /^\/repos\/o\/r\/actions\/jobs\/72$/;
  const askJob = () => client.ciRun(GITHUB, 'o/r', 'job', 72);
  const mark = forge.log.length;
  for (const body of [{ id: 72 }, { id: 72, run_id: '7' }, { id: 73, run_id: 7 }]) await failing(answered('api.github.com', 'GET', jobAt, json(200, body), askJob), /did not say what CI job 72 ran for/);
  assert.deepEqual(seen(mark).map((r) => r.path), Array(3).fill('/repos/o/r/actions/jobs/72'), 'no run is asked for by an id the forge did not give');
  // Only GitLab keeps a ref of that shape: on GitHub it is a branch's name.
  assert.deepEqual(await answered('api.github.com', 'GET', runAt, json(200, { ...run, head_branch: 'refs/merge-requests/579/head' }), askRun), { repo: 'o/r', ref: 'refs/heads/refs/merge-requests/579/head' });
  assert.equal(await answered('api.github.com', 'GET', jobAt, json(200, { id: 72, run_id: 99 }), askJob), null);
  const pipelineAt = /\/pipelines\/7$/;
  const askPipeline = () => client.ciRun(GITLAB, lab, 'run', 7);
  for (const [status, body] of [[429, { message: 'Retry later' }], [200, { id: 8, ref: 'feature' }], [200, { id: 7 }], [200, { id: 7, ref: '' }]]) {
    await failing(answered(GITLAB_HOST, 'GET', pipelineAt, json(status, body), askPipeline), /did not say what CI run 7 ran for/);
  }
  // The ref GitLab keeps of a merge request is told by its whole shape; anything else is a branch's name.
  assert.deepEqual(await answered(GITLAB_HOST, 'GET', pipelineAt, json(200, { id: 7, ref: 'refs/merge-requests/5/merge' }), askPipeline), { repo: lab, ref: 'refs/heads/feature', pull: 5 });
  for (const name of ['refs/merge-requests/5', 'x/refs/merge-requests/5/head', 'refs/merge-requests/5/head/x', 'refs/merge-requests/05/head']) {
    assert.deepEqual(await answered(GITLAB_HOST, 'GET', pipelineAt, json(200, { id: 7, ref: name, tag: false }), askPipeline), { repo: lab, ref: `refs/heads/${name}` }, name);
  }
  assert.equal(await answered(GITLAB_HOST, 'GET', pipelineAt, json(200, { id: 7, ref: 'feature', tag: true }), askPipeline), null);
});

await check('the quarantine\'s fetch asks one repository for commits by id or for its branches, and follows no redirect', async () => {
  const env = { PATH: process.env.PATH, HOME: scratch, GIT_DIR: path.join(scratch, 'fetch-target.git'), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
  git(scratch, 'init', '--quiet', '--bare', 'fetch-target.git');
  const before = forge.log.length;
  const lines = logLines.length;
  // Nothing but a commit id is asked for, and nothing but a plain repository path is asked of.
  for (const what of [{ wants: [] }, { wants: ['refs/heads/main'] }, { wants: [A, 'main'] }, { wants: [A, '--upload-pack=x'] }, { wants: [A.slice(0, 39)] },
    { repo: 'o/r x', wants: [A] }, { repo: 'o/r?x=', wants: [A] }, { repo: 'o/r#', wants: [A] }, { repo: '', into: 'refs/dn/0' }, { repo: 'o/r\n', into: 'refs/dn/0' }]) {
    assert.equal(await client.fetchInto(GITHUB, { repo: 'o/r', env, ...what }), false, JSON.stringify(what));
  }
  assert.equal(await client.fetchInto({ forge: 'github', host: 'corp.ghe.com' }, { repo: 'o/r', env, wants: [A] }), false);
  assert.deepEqual(seen(before), [], 'the forge heard nothing');
  assert.equal(logLines.length, lines, 'git was not started');
  assert.equal(await client.fetchInto(GITHUB, { repo: 'o/r', env, wants: [A] }), true);
  assert.equal(git(env.GIT_DIR, 'cat-file', '-t', A), 'commit');

  // A forge that answers the fetch with a redirect: git stops there, and the credential it carries reaches nobody else.
  const remove = forge.route('github.com', 'GET', /^\/o\/r\.git\/info\/refs/, (req, res) => res.writeHead(302, { location: `${strangerOrigin}/o/r.git/info/refs?service=git-upload-pack` }).end());
  const heard = strangers.length;
  assert.equal(await client.fetchInto(GITHUB, { repo: 'o/r', env, wants: [B] }), false);
  remove();
  assert.equal(strangers.length, heard, 'the redirect\'s target was never contacted');

  // Every branch of a repository, under the name given: the pool's when a task names none, another when it does.
  const ctx = ctxFor();
  const asked = forge.log.length;
  assert.equal(await ctx.fetch({ env, into: 'refs/dn/1' }), true);
  assert.equal(await ctx.fetch({ env, repo: 'me/r', into: 'refs/dn/0' }), true);
  assert.equal(git(env.GIT_DIR, 'for-each-ref', '--format=%(refname)'), 'refs/dn/0/feature\nrefs/dn/1/feature\nrefs/dn/1/main');
  assert.deepEqual([...new Set(seen(asked).map((r) => r.path.split('.git/')[0]))], ['/o/r', '/me/r']);
});

// A git client's side of the tunnel: every smart-HTTP request becomes `authorize`, then
// `perform`. A refusal is answered 403 with the reason.
function relay(ruleList, ctx, host = 'github.com', target = GITHUB) {
  const refusals = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const headers = Object.fromEntries(Object.entries(req.headers).filter(([name]) => !['host', 'content-length', 'transfer-encoding', 'connection', 'accept-encoding'].includes(name)));
      const verdict = await authorize(ruleList, { host, method: req.method, path: req.url, headers, body: Buffer.concat(chunks).toString('base64') }, ctx);
      if (!verdict.ok) {
        refusals.push(verdict.reason);
        res.writeHead(403, { 'content-type': 'text/plain' }).end(verdict.reason);
        return;
      }
      const answer = await client.perform(verdict.request, target);
      res.writeHead(answer.status, answer.headers).end(Buffer.from(answer.body, 'base64'));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${server.address().port}`, refusals, close: () => new Promise((done) => { server.closeAllConnections(); server.close(done); }),
  })));
}
// git must not block this process: the relay it talks to lives here.
const gitPush = (...args) => new Promise((resolve) => {
  const env = { PATH: process.env.PATH, HOME: work, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' };
  execFile('git', ['-C', work, 'push', ...args], { env }, (err, stdout, stderr) => resolve({ ok: !err, stderr }));
});
const remote = (ref) => {
  try { return git(bare, 'rev-parse', '--verify', '--quiet', ref); } catch { return null; }
};
const pushesReceived = (from) => seen(from).filter((r) => r.host === 'github.com' && r.method === 'POST' && r.path.endsWith('/git-receive-pack'));

await check('a real git push: a fast-forward of the pull request\'s head branch goes through', async () => {
  const tunnel = await relay(rules('review-own', 'pr-579'), ctxFor());
  const before = forge.log.length;
  git(work, 'checkout', '--quiet', '--detach', B);
  const C = commit('address review', { 'src/a.js': 'c\n' });
  const pushed = await gitPush(`${tunnel.url}/o/r.git`, `${C}:refs/heads/feature`);
  assert.equal(pushed.ok, true, pushed.stderr + tunnel.refusals.join('; '));
  assert.equal(remote('refs/heads/feature'), C);
  const [received] = pushesReceived(before);
  assert.equal(received.headers.authorization, `Basic ${Buffer.from(`x-access-token:${GITHUB_TOKEN}`).toString('base64')}`, 'smart HTTP is sent the basic credential');

  // The base branch moved after the checkout was cloned; merging it is still a provable fast-forward.
  git(work, 'checkout', '--quiet', '--detach', A);
  const M = commit('base moves on', { '.github/workflows/ci.yml': 'on: [push, pull_request]\n' });
  git(work, 'push', '--quiet', bare, `${M}:refs/heads/main`);
  git(work, 'checkout', '--quiet', '--detach', C);
  git(work, 'merge', '--quiet', '--no-edit', M);
  const merged = git(work, 'rev-parse', 'HEAD');
  const again = await gitPush(`${tunnel.url}/o/r`, `${merged}:refs/heads/feature`);
  assert.equal(again.ok, true, again.stderr + tunnel.refusals.join('; '));
  assert.equal(remote('refs/heads/feature'), merged);
  assert.ok(seen(before).some((r) => r.path.includes('git-upload-pack')), 'the quarantine fetched from the forge with the requester\'s credential');
  await tunnel.close();
});

await check('a real git push: a force-push, a deletion, another branch and a workflow change are refused, the remote untouched', async () => {
  const tunnel = await relay(rules('review-own', 'pr-579'), ctxFor());
  const tip = remote('refs/heads/feature');
  const main = remote('refs/heads/main');
  const before = forge.log.length;
  const attempt = async (pattern, ...args) => {
    const refusals = tunnel.refusals.length;
    const pushed = await gitPush(`${tunnel.url}/o/r.git`, ...args);
    assert.equal(pushed.ok, false, `git push ${args.join(' ')} succeeded`);
    assert.match(tunnel.refusals.slice(refusals).join('; '), pattern);
  };
  git(work, 'checkout', '--quiet', '--detach', B);
  const rewritten = commit('rewrite history', { 'src/a.js': 'rewritten\n' });
  await attempt(/not a fast-forward/, '--force', `${rewritten}:refs/heads/feature`);
  await attempt(/may not delete a ref/, ':refs/heads/feature');
  await attempt(/may not delete a ref/, '--delete', 'feature');
  git(work, 'checkout', '--quiet', '--detach', main);
  const onMain = commit('straight to main', { 'src/a.js': 'main\n' });
  await attempt(/refs\/heads\/main: this task may not update/, `${onMain}:refs/heads/main`);
  await attempt(/may not create that ref/, `${onMain}:refs/heads/brand-new`);
  await attempt(/may not create that ref/, `${onMain}:refs/tags/v9`);
  await attempt(/may not create that ref/, `${onMain}:refs/pull/579/head`);
  git(work, 'checkout', '--quiet', '--detach', tip);
  const workflow = commit('add a workflow', { '.github/workflows/steal.yml': 'on: push\n' });
  await attempt(/changes \.github\/workflows\/steal\.yml/, `${workflow}:refs/heads/feature`);
  // Two refs in one push, one of them allowed.
  git(work, 'checkout', '--quiet', '--detach', tip);
  const fine = commit('fine', { 'src/a.js': 'fine\n' });
  await attempt(/refs\/heads\/main: this task may not update/, '--atomic', `${fine}:refs/heads/feature`, `${onMain}:refs/heads/main`);

  assert.equal(remote('refs/heads/feature'), tip);
  assert.equal(remote('refs/heads/main'), main);
  assert.equal(remote('refs/heads/brand-new'), null);
  assert.equal(remote('refs/tags/v9'), null);
  assert.deepEqual(pushesReceived(before), [], 'no refused push reached the forge');
  assert.deepEqual(fs.readdirSync(process.env.TMPDIR).filter((name) => name.startsWith('dn-quarantine-')), [], 'every quarantine was removed');
  await tunnel.close();
});

await check('a real git push: the one new branch of an issue task, then a draft pull request from it', async () => {
  const state = {};
  const ruleList = rules('issues', 'issue-421');
  const ctx = ctxFor(state);
  const tunnel = await relay(ruleList, ctx);
  git(work, 'checkout', '--quiet', '--detach', remote('refs/heads/main'));
  const fix = commit('fix 421', { 'src/fix.js': 'f\n' });
  assert.match((await authorize(ruleList, ghql(GH.prCreate), ctx)).reason, /only be opened from a branch this task pushed/);
  const pushed = await gitPush(`${tunnel.url}/o/r.git`, `${fix}:refs/heads/fix-421`);
  assert.equal(pushed.ok, true, pushed.stderr + tunnel.refusals.join('; '));
  assert.equal(remote('refs/heads/fix-421'), fix);
  assert.deepEqual(state.branches, ['refs/heads/fix-421']);
  const more = commit('fix 421, part two', { 'src/fix.js': 'g\n' });
  assert.equal((await gitPush(`${tunnel.url}/o/r.git`, `${more}:refs/heads/fix-421`)).ok, true, tunnel.refusals.join('; '));
  assert.equal(remote('refs/heads/fix-421'), more);
  const second = await gitPush(`${tunnel.url}/o/r.git`, `${more}:refs/heads/another`);
  assert.equal(second.ok, false);
  assert.match(tunnel.refusals.at(-1), /this task may create 1 branch\(es\); it has refs\/heads\/fix-421/);
  assert.equal(remote('refs/heads/another'), null);
  const feature = remote('refs/heads/feature');
  assert.equal((await gitPush(`${tunnel.url}/o/r.git`, `${more}:refs/heads/feature`, '--force')).ok, false);
  assert.equal(remote('refs/heads/feature'), feature);
  // A name a protection rule would cover is not made, however much of the allowance is left.
  const guarded = await relay(ruleList, ctxFor({}));
  forge.data.repos['o/r'].rulesets = ['release/*'];
  try {
    assert.equal((await gitPush(`${guarded.url}/o/r.git`, `${more}:refs/heads/release/9.9`)).ok, false);
    assert.match(guarded.refusals.at(-1), /refs\/heads\/release\/9\.9: a protection rule of the forge covers that name/);
    assert.equal(remote('refs/heads/release/9.9'), null);
  } finally {
    delete forge.data.repos['o/r'].rulesets;
    await guarded.close();
  }

  const before = forge.data.mutations.length;
  assert.equal((await perform(ruleList, ghql(GH.prCreate), ctx)).status, 200);
  assert.equal(forge.data.mutations[before].name, 'createPullRequest');
  assert.deepEqual(state, { branches: ['refs/heads/fix-421'], reserved: [], sent: {}, pulls: ['fix-421'], asked: [] });
  // One draft pull request per branch, by either route.
  assert.match((await authorize(ruleList, gh('POST', '/repos/o/r/pulls', { title: 't', head: 'fix-421', base: 'main', draft: true }), ctx)).reason, /this task has opened its pull request from fix-421/);
  assert.match((await authorize(ruleList, ghql(GH.prCreate), ctx)).reason, /this task has opened its pull request from fix-421/);
  assert.match((await authorize(ruleList, gh('POST', '/repos/o/r/pulls', { title: 't', head: 'feature', base: 'main', draft: true }), ctx)).reason, /only be opened from a branch this task pushed/);
  assert.equal(git(checkout, 'rev-parse', 'refs/remotes/origin/feature'), B, 'the linked checkout was not fetched into');
  assert.equal(git(checkout, 'status', '--porcelain'), '');
  await tunnel.close();
});

await check('a real git push to the account\'s own fork: its pull request\'s head branch moves there, its one new branch is made there, and nothing else', async () => {
  const inFork = (ref) => {
    try { return git(forkBare, 'rev-parse', '--verify', '--quiet', ref); } catch { return null; }
  };
  const tunnel = await relay(rules('conflicts', 'pr-581'), ctxFor());
  const before = forge.log.length;
  // The fork never saw the base branch move: the merge carries the repository's own commits, its workflow change among them.
  git(work, 'checkout', '--quiet', '--detach', B);
  git(work, 'merge', '--quiet', '--no-edit', remote('refs/heads/main'));
  const merged = git(work, 'rev-parse', 'HEAD');
  const pushed = await gitPush(`${tunnel.url}/me/r.git`, `${merged}:refs/heads/feature`);
  assert.equal(pushed.ok, true, pushed.stderr + tunnel.refusals.join('; '));
  assert.equal(inFork('refs/heads/feature'), merged);
  assert.deepEqual(pushesReceived(before).map((r) => r.path), ['/me/r.git/git-receive-pack']);
  assert.deepEqual([...new Set(seen(before).filter((r) => r.path.includes('git-upload-pack')).map((r) => r.path.split('.git/')[0]))], ['/Me/R', '/o/r'], 'the quarantine fetched from the fork, by the name the forge gave it, and from the pool\'s repository');

  const pool = remote('refs/heads/feature');
  const attempt = async (pattern, repo, ...args) => {
    const refusals = tunnel.refusals.length;
    const sent = await gitPush(`${tunnel.url}${repo}`, ...args);
    assert.equal(sent.ok, false, `git push ${repo} ${args.join(' ')} succeeded`);
    assert.match(tunnel.refusals.slice(refusals).join('; '), pattern);
  };
  const more = commit('more in the fork', { 'src/a.js': 'more\n' });
  // The repository's branch of that name is not this pull request's head, and no other repository is the fork.
  await attempt(/does not hold the head branch of open pull request #581/, '/o/r.git', `${more}:refs/heads/feature`);
  await attempt(/^me\/proj is not this account's own fork of the pool's repository$/, '/me/proj.git', `${more}:refs/heads/feature`);
  await attempt(/^me\/absent is not this account's own fork of the pool's repository$/, '/me/absent.git', `${more}:refs/heads/feature`);
  await attempt(/no rule of this task allows the request/, '/them/r.git', `${more}:refs/heads/feature`);
  await attempt(/may not create that ref/, '/me/r.git', `${more}:refs/heads/second`);
  await attempt(/may not delete a ref/, '/me/r.git', ':refs/heads/feature');
  await attempt(/refs\/heads\/second: this task may not create/, '/me/r.git', '--atomic', `${more}:refs/heads/feature`, `${more}:refs/heads/second`);
  git(work, 'checkout', '--quiet', '--detach', B);
  await attempt(/not a fast-forward/, '/me/r.git', '--force', `${commit('rewrite the fork', { 'src/a.js': 'rewritten\n' })}:refs/heads/feature`);
  git(work, 'checkout', '--quiet', '--detach', merged);
  await attempt(/changes \.github\/workflows\/steal\.yml/, '/me/r.git', `${commit('a workflow in the fork', { '.github/workflows/steal.yml': 'on: push\n' })}:refs/heads/feature`);
  assert.equal(inFork('refs/heads/feature'), merged);
  assert.equal(inFork('refs/heads/second'), null);
  assert.equal(remote('refs/heads/feature'), pool);
  assert.equal(pushesReceived(before).length, 1, 'no refused push reached the forge');
  await tunnel.close();

  // An issue task's one new branch, made in the fork, and its draft pull request opened from there.
  const state = {};
  const ruleList = rules('issues', 'issue-421');
  const ctx = ctxFor(state);
  const issue = await relay(ruleList, ctx);
  git(work, 'checkout', '--quiet', '--detach', remote('refs/heads/main'));
  const fix = commit('fix 421 from the fork', { 'src/fix.js': 'fork\n' });
  // The fork's own protection rules decide a branch made there, not the pool repository's.
  Object.assign(forge.data.repos['me/r'], { rulesets: ['release/*'] });
  Object.assign(forge.data.repos['o/r'], { rulesets: ['fix-*'] });
  let made;
  try {
    assert.equal((await gitPush(`${issue.url}/me/r.git`, `${fix}:refs/heads/release/1`)).ok, false);
    assert.match(issue.refusals.at(-1), /refs\/heads\/release\/1: a protection rule of the forge covers that name/);
    made = await gitPush(`${issue.url}/me/r.git`, `${fix}:refs/heads/fix-9`);
  } finally {
    delete forge.data.repos['me/r'].rulesets;
    delete forge.data.repos['o/r'].rulesets;
  }
  assert.equal(made.ok, true, made.stderr + issue.refusals.join('; '));
  assert.equal(inFork('refs/heads/fix-9'), fix);
  assert.deepEqual(state.branches, ['me/r:refs/heads/fix-9']);
  assert.equal((await gitPush(`${issue.url}/me/r.git`, `${commit('part two', { 'src/fix.js': 'fork 2\n' })}:refs/heads/fix-9`)).ok, true, issue.refusals.join('; '));
  for (const repo of ['/o/r.git', '/me/r.git']) {
    assert.equal((await gitPush(`${issue.url}${repo}`, `${fix}:refs/heads/another`)).ok, false);
    assert.match(issue.refusals.at(-1), /this task may create 1 branch\(es\); it has me\/r:refs\/heads\/fix-9/);
  }
  const open = (head) => gh('POST', '/repos/o/r/pulls', { title: 't', head, base: 'main', draft: true });
  for (const head of ['fix-9', 'them:fix-9', 'me:other', 'me:r:fix-9', 'me:fix-9:x']) assert.match((await authorize(ruleList, open(head), ctx)).reason, /only be opened from a branch this task pushed/, head);
  assert.equal((await perform(ruleList, open('Me:fix-9'), ctx)).status, 201);
  assert.deepEqual(state, { branches: ['me/r:refs/heads/fix-9'], reserved: [], sent: {}, pulls: ['me/r:fix-9'], asked: [] });
  assert.match((await authorize(ruleList, open('me:fix-9'), ctx)).reason, /this task has opened its pull request from me\/r:fix-9/);
  await issue.close();
});

await check('a GitHub Enterprise Server is asked on its one host, with the credential gh holds for it: REST under /api/v3, GraphQL at /api/graphql, git beside them', async () => {
  const GHES = { forge: 'github', host: GHES_HOST };
  const ghesRules = (kind, item) => rulesFor({ forge: 'github', kind, pool: `${GHES_HOST}/o/r`, item, identity: 'me' });
  const ctx = client.context({ ...GHES, repo: 'o/r', checkout, state: {} });
  const there = (request) => ({ ...request, host: GHES_HOST, path: request.path === '/graphql' ? '/api/graphql' : `/api/v3${request.path}` });
  const heard = (from) => seen(from).map((r) => `${r.host} ${r.method} ${r.path.split('?')[0]} ${r.headers.authorization}`);
  const api = (method, path) => `${GHES_HOST} ${method} ${path} Bearer ${GHES_TOKEN}`;

  // What the deep checks ask is answered as github.com answers it, from the server's own API.
  let before = forge.log.length;
  assert.deepEqual(await client.self(GHES), await client.self(GITHUB));
  assert.deepEqual(await client.resolveNode(GHES, 'PRRT_579'), await client.resolveNode(GITHUB, 'PRRT_579'));
  assert.deepEqual(await client.pull(GHES, 'o/r', 579), await client.pull(GITHUB, 'o/r', 579));
  assert.deepEqual(await client.repository(GHES, 'o/r'), await client.repository(GITHUB, 'o/r'));
  assert.deepEqual(await client.ciRun(GHES, 'o/r', 'run', 7), await client.ciRun(GITHUB, 'o/r', 'run', 7));
  assert.deepEqual(await ctx.pull(578), await ctxFor().pull(578));
  assert.deepEqual(heard(before).filter((line) => line.startsWith(GHES_HOST)), [
    api('POST', '/api/graphql'), api('POST', '/api/graphql'), api('GET', '/api/v3/repos/o/r/pulls/579'), api('GET', '/api/v3/repos/o/r'),
    api('GET', '/api/v3/repos/o/r/actions/runs/7'), api('GET', '/api/v3/repos/o/r/pulls/578'),
  ]);
  assert.equal(heard(before).length, 12, 'and github.com was asked the same six on its own hosts');

  // A task's requests go to that API, the server's answer about itself cut to its version.
  before = forge.log.length;
  const ruleList = ghesRules('investigate', 'job-x');
  assert.equal(JSON.parse((await perform(ruleList, there(gh('GET', '/repos/o/r/pulls/578')), ctx, GHES)).bytes).number, 578);
  assert.deepEqual(JSON.parse((await perform(ruleList, there(gh('GET', '/meta')), ctx, GHES)).bytes), { installed_version: '3.15.2' });
  assert.equal(JSON.parse((await perform(ruleList, there(ghql(GH.prViewAuthor)), ctx, GHES)).bytes).data.repository.pullRequest.number, 578);
  assert.deepEqual(heard(before), [api('GET', '/api/v3/repos/o/r/pulls/578'), api('GET', '/api/v3/meta'), api('POST', '/api/graphql')]);
  // Its request is not one for github.com's credential.
  const verdict = await authorize(ruleList, there(gh('GET', '/repos/o/r/pulls/578')), ctx);
  await failing(client.perform(verdict.request, GITHUB), /ghes\.example\.com is not a host of github github\.com/);
  assert.deepEqual(heard(before).length, 3);

  // A push: checked against what the server's own git holds, and sent there with the basic credential.
  before = forge.log.length;
  const tunnel = await relay(ghesRules('review-own', 'pr-579'), ctx, GHES_HOST, GHES);
  git(work, 'checkout', '--quiet', '--detach', remote('refs/heads/feature'));
  const tip = commit('on the enterprise server', { 'src/a.js': 'enterprise\n' });
  const pushed = await gitPush(`${tunnel.url}/o/r.git`, `${tip}:refs/heads/feature`);
  assert.equal(pushed.ok, true, pushed.stderr + tunnel.refusals.join('; '));
  assert.equal(remote('refs/heads/feature'), tip);
  const refusedPush = await gitPush(`${tunnel.url}/o/r.git`, `${tip}:refs/heads/main`);
  assert.equal(refusedPush.ok, false);
  await tunnel.close();
  const basic = `Basic ${Buffer.from(`x-access-token:${GHES_TOKEN}`).toString('base64')}`;
  const overGit = seen(before).filter((r) => !r.path.startsWith('/api/'));
  assert.ok(overGit.some((r) => r.method === 'POST' && r.path === '/o/r.git/git-receive-pack') && overGit.some((r) => r.path.includes('git-upload-pack')), 'the push and the quarantine\'s fetch');
  assert.ok(overGit.every((r) => r.headers.authorization === basic));
  assert.ok(seen(before).every((r) => r.host === GHES_HOST && (r.path.startsWith('/o/r.git/') || r.path.startsWith('/api/v3/repos/o/r') || r.path === '/api/graphql')), heard(before).join('\n'));

  // A GitHub whose API stands on another name again is not asked anything.
  before = forge.log.length;
  await failing(client.self({ forge: 'github', host: 'corp.ghe.com' }), /^forge: corp\.ghe\.com is not a GitHub host this can ask$/);
  assert.deepEqual(seen(before), []);
});

if (process.env.DN_TEST_GITHUB === '1') {
  // The real gh and the real forge: none of this test's redirections may reach the child.
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('DN_') && name !== 'GLAB_CONFIG_DIR' && name !== 'TMPDIR'));
  const out = await new Promise((resolve, reject) => {
    execFile(process.execPath, [fileURLToPath(import.meta.url), 'live'], { env, timeout: 60000 }, (err, stdout, stderr) => (err ? reject(new Error(`live check failed: ${stderr}`)) : resolve(stdout)));
  });
  process.stdout.write(out);
} else {
  console.log('SKIP live: set DN_TEST_GITHUB=1 for the read-only check against the real api.github.com');
}

stranger.closeAllConnections();
stranger.close();
await forge.close();
fs.rmSync(scratch, { recursive: true, force: true });
