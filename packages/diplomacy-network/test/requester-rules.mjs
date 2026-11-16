// The rule catalogue against reality: for each kind, the requests the real tools make are
// allowed, and everything an executor could try past them is refused.

import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { canon } from '../src/core/canon.js';
import { authorize } from '../src/requester/authorize.js';
import { AUDIT_BRANCHES, rulesFor } from '../src/requester/rules.js';
import { GH, gh, ghql, gitPush, glab } from './lib/captured.mjs';
import { world } from './lib/world.mjs';

async function check(name, fn) {
  await fn();
  console.log(`PASS ${name}`);
}

const KINDS = ['review', 'review-own', 'conflicts', 'issues', 'audit', 'investigate'];
const ITEM = { review: 'pr-578', 'review-own': 'pr-579', conflicts: 'pr-579', issues: 'issue-421', audit: 'job-audit-1', investigate: 'job-q-1' };
const github = (kind, options = {}, item = ITEM[kind]) => rulesFor({ forge: 'github', kind, options, pool: 'github.com/o/r', item, identity: 'Me' });
const GITLAB_POOL = { id: 'gitlab.example.com/group/sub/proj', projectId: 99 };
const gitlab = (kind, options = {}, item = ITEM[kind].replace('578', '5').replace('579', '5')) => rulesFor({ forge: 'gitlab', kind, options, pool: GITLAB_POOL, item, identity: 'me' });

const label = (r) => `${r.method} ${r.host}${r.path.slice(0, 120)}`;
async function allowed(rules, request, ctx = world()) {
  const verdict = await authorize(rules, request, ctx);
  assert.equal(verdict.ok, true, `${verdict.reason}: ${label(request)}`);
  return verdict;
}
async function refused(rules, request, ctx = world(), pattern = /./) {
  const verdict = await authorize(rules, request, ctx);
  assert.equal(verdict.ok, false, `allowed: ${label(request)} ${Buffer.from(request.body, 'base64').toString().slice(0, 200)}`);
  assert.match(verdict.reason, pattern, label(request));
}

// What every kind reads: gh's own queries and the REST reads the prompts ask for.
const READS = [
  ...['prViewAuthor', 'prViewDefault', 'prProjectItems', 'prViewReviews', 'prViewMergeable', 'typeFields', 'prChecks', 'prList', 'prSearch', 'prStatus',
    'issueView', 'issueList', 'userCurrent', 'repositoryInfo', 'repoView'].map((name) => ghql(GH[name])),
  gh('GET', '/repos/o/r/readme'), // gh repo view
  { ...gh('GET', '/repos/o/r/pulls/578'), headers: { ...gh('GET', '/x').headers, accept: 'application/vnd.github.v3.diff' } }, // gh pr diff 578
  gh('GET', '/repos/o/r/pulls/578/comments'),
  gh('GET', '/repos/o/r/pulls/578/reviews'),
  gh('GET', '/repos/o/r/pulls/578/files?per_page=100'),
  gh('GET', '/repos/o/r/issues/421/comments'),
  gh('GET', '/repos/o/r/actions/runs?exclude_pull_requests=true&per_page=2'), // gh run list
  gh('GET', '/repos/o/r/actions/workflows?page=1&per_page=100'),
  gh('GET', '/repos/o/r/actions/jobs/7/logs'),
  gh('GET', '/search/issues?advanced_search=true&page=1&per_page=2&q=%28+fix+%29+repo%3Ao%2Fr+type%3Apr'), // gh search prs --repo o/r fix
  gh('GET', '/repos/o/r/contents/src/a.js?ref=main'),
  gh('GET', '/repos/o/r/commits/abc123/check-runs'),
  gh('GET', '/repos/o/r/compare/main...feature'),
  gh('GET', '/repos/o/r/branches?per_page=100'),
  gh('GET', '/repos/o/r/branches/feature'),
  gh('GET', '/repos/O/R'),
  gh('GET', '/user'),
];

// What no kind may do, whatever its options.
const NEVER = [
  // another repository, another host
  gh('GET', '/repos/o/other/pulls/578'), gh('GET', '/repos/victim/r/pulls/578'), gh('GET', '/repos/o/r-private'), gh('GET', '/repositories/1'),
  gh('POST', '/repos/o/other/pulls/578/reviews', { commit_id: 'abc' }), gh('POST', '/repos/o/other/issues/421/comments', { body: 'x' }),
  { ...gh('GET', '/repos/o/r/pulls/578'), host: 'api.github.com.evil.example' }, { ...gh('GET', '/repos/o/r/pulls/578'), host: 'api.github.com.' },
  { ...gh('GET', '/repos/o/r/pulls/578'), host: 'github.com' }, { ...gh('GET', '/repos/o/r/pulls/578'), host: 'uploads.github.com' },
  { ...gh('GET', '/gists'), host: 'gist.github.com' }, { ...gh('GET', '/o/r/main/.env'), host: 'raw.githubusercontent.com' },
  // reads of this repository whose answer is somebody else's: the other side of a compare, what refers to an issue, who can be assigned
  gh('GET', '/repos/o/r/compare/main...victim:main'), gh('GET', '/repos/o/r/compare/main...victim:secret:main'), gh('GET', '/repos/o/r/compare/victim%3Asecret%3Amain...main'),
  gh('GET', '/repos/o/r/issues/421/timeline'), gh('GET', '/repos/o/r/issues/421/sub_issues'), gh('GET', '/repos/o/r/issues/421/parent'), gh('GET', '/repos/o/r/issues/421/dependencies/blocked_by'),
  gh('GET', '/repos/o/r/assignees'), gh('GET', '/repos/o/r/assignees/mallory'), gh('GET', '/search/issues?q=repo:o/r+fix&repository_id=1'),
  // path tricks
  gh('GET', '/repos/o/r/../../user/repos'), gh('GET', '/repos/o/r/%2e%2e/%2e%2e/user/repos'), gh('GET', '/repos/o/r//pulls'), gh('GET', '/repos/o/r/pulls/..%2f..%2fhooks'),
  gh('GET', '/repos/o/r/contents/..%2F..%2F..%2Fuser'), gh('GET', '/repos/o/r/pulls/578#/../../../user'),
  // the pull request itself: merge, edit, close, other people's reviews and comments
  gh('PUT', '/repos/o/r/pulls/578/merge', {}), gh('PUT', '/repos/o/r/pulls/579/merge', { merge_method: 'squash' }), gh('PATCH', '/repos/o/r/pulls/578', { base: 'release' }),
  gh('PATCH', '/repos/o/r/pulls/579', { state: 'closed' }), gh('PATCH', '/repos/o/r/issues/421', { state: 'closed' }), gh('PUT', '/repos/o/r/pulls/578/reviews/5/dismissals', { message: 'x' }),
  gh('DELETE', '/repos/o/r/issues/comments/5'), gh('PATCH', '/repos/o/r/issues/comments/5', { body: 'x' }), gh('PATCH', '/repos/o/r/pulls/comments/12', { body: 'x' }),
  gh('PUT', '/repos/o/r/pulls/578/update-branch', {}), gh('POST', '/repos/o/r/pulls/578/requested_reviewers', { reviewers: ['x'] }), gh('POST', '/repos/o/r/issues/421/labels', { labels: ['x'] }),
  gh('PUT', '/repos/o/r/issues/421/lock', {}), gh('POST', '/repos/o/r/issues', { title: 'x' }), gh('POST', '/repos/o/r/merges', { base: 'main', head: 'x' }),
  // CI, secrets, settings
  gh('POST', '/repos/o/r/actions/workflows/ci.yml/dispatches', { ref: 'main' }), gh('POST', '/repos/o/r/dispatches', { event_type: 'x' }), gh('POST', '/repos/o/r/actions/runs/1/rerun', {}),
  gh('GET', '/repos/o/r/actions/secrets'), gh('GET', '/repos/o/r/actions/secrets/public-key'), gh('PUT', '/repos/o/r/actions/secrets/X', { encrypted_value: 'x' }),
  gh('GET', '/repos/o/r/actions/variables'), gh('POST', '/repos/o/r/actions/variables', { name: 'X', value: 'y' }), gh('GET', '/repos/o/r/actions/runners'),
  gh('POST', '/repos/o/r/actions/runners/registration-token', {}), gh('GET', '/repos/o/r/environments'), gh('GET', '/repos/o/r/dependabot/secrets'),
  gh('PATCH', '/repos/o/r', { private: false }), gh('DELETE', '/repos/o/r'), gh('POST', '/repos/o/r/transfer', { new_owner: 'x' }), gh('POST', '/repos/o/r/forks', {}),
  gh('GET', '/repos/o/r/hooks'), gh('POST', '/repos/o/r/hooks', { config: { url: 'https://evil.example' } }), gh('GET', '/repos/o/r/keys'), gh('POST', '/repos/o/r/keys', { key: 'ssh-ed25519 x' }),
  gh('GET', '/repos/o/r/collaborators'), gh('PUT', '/repos/o/r/collaborators/mallory', { permission: 'admin' }), gh('GET', '/repos/o/r/invitations'),
  gh('GET', '/repos/o/r/branches/main/protection'), gh('PUT', '/repos/o/r/branches/main/protection', {}), gh('GET', '/repos/o/r/secret-scanning/alerts'), gh('GET', '/repos/o/r/traffic/clones'),
  gh('POST', '/repos/o/r/releases', { tag_name: 'v9' }), gh('DELETE', '/repos/o/r/releases/1'), gh('POST', '/repos/o/r/statuses/abc', { state: 'success' }), gh('POST', '/repos/o/r/check-runs', { name: 'x' }),
  gh('POST', '/repos/o/r/deployments', { ref: 'main' }), gh('PUT', '/repos/o/r/topics', { names: [] }),
  // writing git data through the API instead of a push
  gh('POST', '/repos/o/r/git/refs', { ref: 'refs/heads/x', sha: 'abc' }), gh('PATCH', '/repos/o/r/git/refs/heads/main', { sha: 'abc', force: true }), gh('DELETE', '/repos/o/r/git/refs/heads/main'),
  gh('PUT', '/repos/o/r/contents/.github/workflows/x.yml', { message: 'x', content: 'eA==' }), gh('DELETE', '/repos/o/r/contents/README.md', { message: 'x', sha: 'abc' }),
  gh('POST', '/repos/o/r/git/commits', { message: 'x', tree: 'abc' }), gh('POST', '/repos/o/r/git/blobs', { content: 'x' }), gh('POST', '/repos/o/r/git/trees', { tree: [] }),
  // the requester's account, organisations and everything else on the forge
  gh('GET', '/user/repos'), gh('GET', '/user/emails'), gh('GET', '/user/keys'), gh('GET', '/user/orgs'), gh('GET', '/user/installations'), gh('PATCH', '/user', { bio: 'x' }),
  gh('POST', '/user/repos', { name: 'x' }), gh('POST', '/user/keys', { key: 'x' }), gh('GET', '/users/victim/repos'), gh('GET', '/orgs/o/repos'), gh('GET', '/orgs/o/members'),
  gh('GET', '/orgs/o/actions/secrets'), gh('GET', '/notifications'), gh('GET', '/repos/o/r/notifications'), gh('GET', '/gists'), gh('POST', '/gists', { files: {} }), gh('GET', '/issues'),
  gh('GET', '/search/code?q=repo:o/r+password'), gh('GET', '/search/repositories?q=user:me'), gh('GET', '/search/issues?q=is:private'), gh('GET', '/search/issues?q=repo:o/r+OR+org:victim'),
  gh('GET', '/app'), gh('GET', '/installation/repositories'), gh('GET', '/'), gh('GET', '/rate_limit'), gh('POST', '/markdown', { text: 'x' }), gh('GET', '/user?sudo=admin'),
  // GraphQL past the repository
  ghql({ query: '{ viewer { repositories(first: 100) { nodes { nameWithOwner isPrivate } } } }' }),
  ghql({ query: '{ repository(owner: "o", name: "other") { id } }' }),
  ghql({ query: '{ repository(owner: "o", name: "r") { id } user(login: "victim") { email } }' }),
  ghql({ query: 'mutation { mergePullRequest(input: {pullRequestId: "PR_578"}) { clientMutationId } }' }),
  ghql({ query: 'mutation { closePullRequest(input: {pullRequestId: "PR_579"}) { clientMutationId } }' }),
  ghql({ query: 'mutation { deleteRef(input: {refId: "REF_1"}) { clientMutationId } }' }),
  ghql(GH.prReviewShortcut), ghql(GH.prCommentShortcut),
  gh('GET', '/graphql'), { ...gh('POST', '/graphql'), body: Buffer.from('[{"query":"{viewer{login}}"},{"query":"{viewer{login}}"}]').toString('base64') },
  // pushes nobody is given: the default branch, tags, a pull request's ref, a wiki, another repository
  gitPush('github.com', '/o/other.git'), gitPush('github.com', '/victim/secret.git'), gitPush('github.com', '/o/r.wiki.git'),
  { host: 'github.com', method: 'GET', path: '/o/r.git/info/refs?service=git-upload-pack', headers: {}, body: '' },
  { host: 'github.com', method: 'POST', path: '/o/r.git/git-upload-pack', headers: { 'content-type': 'application/x-git-upload-pack-request' }, body: '' },
  { host: 'github.com', method: 'GET', path: '/o/r.git/info/refs', headers: {}, body: '' },
  { host: 'github.com', method: 'GET', path: '/o/r/settings', headers: {}, body: '' },
  { host: 'github.com', method: 'POST', path: '/login/oauth/access_token', headers: {}, body: '' },
];

await check('every rule list is canonical JSON, so it can be signed into a capability', async () => {
  for (const kind of KINDS) {
    for (const rules of [github(kind), gitlab(kind), github(kind, { verdict: true, markReady: true }), gitlab(kind, { verdict: true, markReady: true })]) {
      assert.ok(Array.isArray(rules) && rules.length > 0 && rules.length <= 128, kind); // a capability carries at most 128 rules
      canon(rules);
      for (const rule of rules) assert.ok(['GET', 'POST', 'PUT', 'DELETE'].includes(rule.method) && rule.path.startsWith('/') && typeof rule.host === 'string');
    }
  }
});

await check('a forge, kind, item or identity without an entry gets no rules at all', async () => {
  const base = { forge: 'github', kind: 'review', pool: 'github.com/o/r', item: 'pr-578', identity: 'me' };
  assert.ok(rulesFor(base));
  for (const bad of [{ forge: 'gitea' }, { forge: undefined }, { kind: 'merge' }, { kind: 'Review' }, { kind: '__proto__' }, { kind: undefined }, { item: 'issue-421' }, { item: 'pr-0' }, { item: 'pr-5x' },
    { item: 'pr--1' }, { item: 'pr-1/../2' }, { item: 'job-' }, { item: 'job-a b' }, { item: undefined }, { item: 578 }, { identity: '' }, { identity: 'a/b' }, { identity: undefined }, { identity: '*' },
    { pool: 'github.com/o' }, { pool: 'github.com/o/r/x' }, { pool: 'github.com/O/r' }, { pool: 'gitlab.com/o/r' }, { pool: 'github.com/o/..' }, { pool: 'github.com/*/r' }, { pool: 'github.com/o/r?x' },
    { pool: 'github.example.com/o/r' }, { pool: undefined }, { options: null }, { kind: 'issues', item: 'pr-578' }, { kind: 'conflicts', item: 'issue-421' }, { kind: 'review-own', item: 'issue-421' },
    { item: 'job-x', options: { author: 'a b' } }]) {
    assert.equal(rulesFor({ ...base, ...bad }), null, JSON.stringify(bad));
  }
  // A number is one a forge can have: past 32 bits there is none, and past 53 it would
  // not even be the number the item names.
  for (const forge of [{}, { forge: 'gitlab', pool: 'gitlab.com/o/r' }]) {
    for (const [kind, type] of [['review', 'pr'], ['conflicts', 'pr'], ['issues', 'issue']]) {
      for (const n of ['2147483648', '4294967297', '9007199254740993', '9999999999999999']) assert.equal(rulesFor({ ...base, ...forge, kind, item: `${type}-${n}` }), null, `${kind} ${n}`);
      const last = rulesFor({ ...base, ...forge, kind, item: `${type}-2147483647` });
      assert.ok(kind === 'conflicts' ? last : last.some((rule) => /\/(pulls|issues|merge_requests)\/2147483647(\/|$)/.test(rule.path)), kind);
    }
  }
  assert.equal(rulesFor({ ...base, forge: 'gitlab', pool: 'gitlab.com/o' }), null);
  assert.ok(rulesFor({ ...base, forge: 'gitlab', pool: 'gitlab.com/o/r' }));
});

await check('every kind reads what the real tools read, in the pool\'s repository only', async () => {
  for (const kind of KINDS) {
    for (const rules of [github(kind), github(kind, { noPRs: true, readOnly: true })]) {
      for (const request of READS) await allowed(rules, request);
    }
  }
  const verdict = await allowed(github('investigate'), gh('GET', '/user'));
  assert.deepEqual(verdict.request.pick, ['login', 'id', 'node_id', 'type', 'name', 'html_url'], 'the answer is cut to public members');
  // The repository's own answer goes out without its clone token, the requester's rights on it or the repository it forks.
  const repo = (await allowed(github('investigate'), gh('GET', '/repos/o/r'))).request.pick;
  assert.ok(repo.includes('default_branch') && repo.includes('full_name'));
  for (const member of ['temp_clone_token', 'permissions', 'parent', 'source', 'security_and_analysis', 'organization']) assert.ok(!repo.includes(member), member);
  for (const path of ['/repos/o/r/branches', '/repos/o/r/branches/main']) {
    assert.deepEqual((await allowed(github('investigate'), gh('GET', path))).request.pick, ['name', 'commit', 'protected'], 'a branch goes out without its protection settings');
  }
  await refused(github('investigate'), gh('GET', '/repos/o/r/issues/421/timeline'), world(), /holds issues and pull requests of other repositories/);
  await refused(github('investigate'), gh('GET', '/repos/o/r/compare/main...victim:main'), world(), /names another repository/);
});

await check('no kind, with any option, reaches another repository, a setting, a secret or the account', async () => {
  const everything = { verdict: true, markReady: true };
  for (const kind of KINDS) {
    for (const rules of [github(kind), github(kind, everything), github(kind, everything, kind === 'issues' ? ITEM.issues : 'job-all')]) {
      for (const request of NEVER) await refused(rules, request, world({ branches: ['refs/heads/fix-421'] }));
    }
  }
});

await check('review: the review lifecycle on its pull request, COMMENT only, and no push', async () => {
  const rules = github('review');
  const lifecycle = [
    gh('POST', '/repos/o/r/pulls/578/reviews', { commit_id: 'abc123' }), // gh api -X POST repos/o/r/pulls/578/reviews -f commit_id=...
    ghql(GH.addThread), ghql(GH.addReply),
    gh('POST', '/repos/o/r/pulls/578/reviews/9/events', { body: 'x', event: 'COMMENT' }),
    gh('DELETE', '/repos/o/r/pulls/578/reviews/9'),
    gh('DELETE', '/repos/o/r/pulls/comments/11'),
  ];
  for (const request of lifecycle) await allowed(rules, request);
  const denied = [
    gh('POST', '/repos/o/r/pulls/579/reviews', { commit_id: 'abc123' }), gh('POST', '/repos/o/r/pulls/579/reviews/9/events', { event: 'COMMENT' }), gh('DELETE', '/repos/o/r/pulls/579/reviews/9'),
    gh('POST', '/repos/o/r/pulls/578/reviews', { event: 'APPROVE' }), gh('POST', '/repos/o/r/pulls/578/reviews', { event: 'REQUEST_CHANGES', body: 'x' }),
    gh('POST', '/repos/o/r/pulls/578/reviews/9/events', { event: 'APPROVE' }), gh('POST', '/repos/o/r/pulls/578/reviews/9/events', { event: 'REQUEST_CHANGES', body: 'x' }),
    gh('POST', '/repos/o/r/pulls/578/reviews/9/events', { body: 'x' }), gh('POST', '/repos/o/r/pulls/578/reviews/9/events?event=APPROVE', { event: 'COMMENT' }),
    { ...gh('POST', '/repos/o/r/pulls/578/reviews/9/events'), body: Buffer.from('{"event":"COMMENT","event":"APPROVE"}').toString('base64') },
    { ...gh('POST', '/repos/o/r/pulls/578/reviews/9/events'), headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: Buffer.from('event=APPROVE').toString('base64') },
    gh('PUT', '/repos/o/r/pulls/578/reviews/9', { body: 'edit' }), gh('DELETE', '/repos/o/r/pulls/comments/12'), gh('DELETE', '/repos/o/r/pulls/comments/13'),
    gh('POST', '/repos/o/r/pulls/578/comments', { body: 'x', commit_id: 'abc', path: 'a', line: 1 }), gh('POST', '/repos/o/r/issues/578/comments', { body: 'x' }),
    gh('POST', '/repos/o/r/pulls/578/comments/12/replies', { body: 'x' }),
    ghql({ ...GH.addReply, variables: { ...GH.addReply.variables, t: 'PRRT_579' } }), ghql({ ...GH.addThread, variables: { ...GH.addThread.variables, rid: 'PRR_theirs' } }),
    ghql(GH.resolveThread), ghql(GH.prReady), ghql(GH.issueComment), ghql(GH.prCreate), ghql(GH.assignSelf),
    gitPush('github.com', '/o/r.git'), gitPush('github.com', '/o/r.git', Buffer.from('x')), gh('POST', '/repos/o/r/pulls', { head: 'fix-421', draft: true, title: 't' }),
  ];
  for (const request of denied) await refused(rules, request);
  // A review comment is deleted only while it is this account's own, still pending, and in the pool's repository.
  await refused(rules, gh('DELETE', '/repos/o/r/pulls/comments/14'), world(), /comment 14 is not part of a pending review/);
  await refused(rules, gh('DELETE', '/repos/o/r/pulls/comments/15'), world(), /comment 15 was not written by this task's account/);
  await refused(rules, gh('DELETE', '/repos/o/r/pulls/comments/16'), world(), /comment 16 is not in the pool's repository/);
});

await check('review with verdict: APPROVE and REQUEST_CHANGES are allowed, on its pull request only', async () => {
  const rules = github('review', { verdict: true });
  await allowed(rules, gh('POST', '/repos/o/r/pulls/578/reviews/9/events', { event: 'APPROVE' }));
  await allowed(rules, gh('POST', '/repos/o/r/pulls/578/reviews', { event: 'REQUEST_CHANGES', body: 'x' }));
  await refused(rules, gh('POST', '/repos/o/r/pulls/578/reviews/9/events', { event: 'DISMISS' }));
  await refused(rules, gh('POST', '/repos/o/r/pulls/579/reviews/9/events', { event: 'APPROVE' }));
  for (const verdict of ['true', 1, 'yes', {}]) await refused(github('review', { verdict }), gh('POST', '/repos/o/r/pulls/578/reviews/9/events', { event: 'APPROVE' }));
});

await check('review-own: replies, resolving and a push to its own head branch; ready only with markReady', async () => {
  const rules = github('review-own');
  await allowed(rules, gh('POST', '/repos/o/r/pulls/579/comments/13/replies', { body: 'Fixed in abc123' }));
  await allowed(rules, ghql({ ...GH.addReply, variables: { t: 'PRRT_579', rid: null, body: 'Fixed in abc123' } }));
  await allowed(rules, ghql({ ...GH.resolveThread, variables: { t: 'PRRT_579' } }));
  await allowed(rules, gitPush('github.com', '/o/r.git'));
  await allowed(rules, gitPush('github.com', '/O/R'));
  const ready = ghql({ ...GH.prReady, variables: { input: { pullRequestId: 'PR_579' } } });
  await refused(rules, ready, world(), /"markPullRequestReadyForReview" is not allowed/);
  await allowed(github('review-own', { markReady: true }), ready);
  await allowed(github('review-own', { markReady: true }), ghql(GH.prForReady));
  const denied = [
    gh('POST', '/repos/o/r/pulls/578/comments/12/replies', { body: 'x' }), gh('POST', '/repos/o/r/pulls/579/comments/12/replies', { body: 'x' }),
    ghql(GH.resolveThread), ghql({ ...GH.prReady, variables: { input: { pullRequestId: 'PR_578' } } }),
    gh('POST', '/repos/o/r/pulls/579/reviews', { commit_id: 'abc' }), gh('POST', '/repos/o/r/pulls/579/reviews/1/events', { event: 'APPROVE' }), gh('DELETE', '/repos/o/r/pulls/comments/13'),
    gitPush('github.com', '/me/r.git'), gitPush('github.com', '/o/other.git'), gh('POST', '/repos/o/r/pulls', { head: 'mine', draft: true, title: 't' }), ghql(GH.prCreate), ghql(GH.issueComment),
  ];
  for (const request of denied) await refused(rules, request);
  await refused(github('review-own', { markReady: true }), ghql({ ...GH.prReady, variables: { input: { pullRequestId: 'PR_578' } } }), world(), /belongs to #578/);
});

await check('conflicts: a push to its pull request\'s head branch and not one write besides', async () => {
  const rules = github('conflicts');
  await allowed(rules, gitPush('github.com', '/o/r.git'));
  await allowed(rules, ghql(GH.prViewMergeable));
  for (const request of [ghql({ ...GH.resolveThread, variables: { t: 'PRRT_579' } }), gh('POST', '/repos/o/r/pulls/579/comments/13/replies', { body: 'x' }), gh('PUT', '/repos/o/r/pulls/579/update-branch', {}),
    ghql({ ...GH.prReady, variables: { input: { pullRequestId: 'PR_579' } } }), gh('POST', '/repos/o/r/issues/579/comments', { body: 'x' }), gitPush('github.com', '/me/r.git')]) await refused(rules, request);
  // The head branch of a pull request from the task account's own fork lives in that fork, and is pushed there alone.
  const forked = github('conflicts', {}, 'pr-581');
  await allowed(forked, gitPush('github.com', '/me/r.git'));
  await allowed(forked, gitPush('github.com', '/ME/r'));
  await refused(forked, gitPush('github.com', '/o/r.git'), world(), /does not hold the head branch of open pull request #581/);
  await refused(rules, gitPush('github.com', '/me/r.git'), world(), /does not hold the head branch of open pull request #579/);
  await refused(forked, gitPush('github.com', '/me/mine.git'), world(), /^me\/mine is not this account's own fork of the pool's repository$/);
  await refused(forked, gitPush('github.com', '/me/absent.git'), world(), /^me\/absent is not this account's own fork of the pool's repository$/);
  for (const path of ['/them/r.git', '/me/r/x.git', '/me.git']) await refused(forked, gitPush('github.com', path), world(), /no rule of this task allows the request/);
  await refused(github('conflicts', {}, 'pr-580'), gitPush('github.com', '/o/r.git'), world(), /open pull request #580/);
});

await check('issues: assign itself, comment on its issue, and a draft pull request from the branch it pushed', async () => {
  const rules = github('issues');
  const pushed = () => world({ branches: ['refs/heads/fix-421'] });
  const allowedOnes = [
    ghql(GH.issueForEdit), ghql(GH.userCurrent), ghql({ ...GH.assignSelf, variables: { input: { assignableId: 'I_421', actorLogins: ['bob', 'me'] } } }), ghql(GH.issueUpdateNothing), // gh issue edit 421 --add-assignee @me
    ghql({ ...GH.unassignSelf, variables: { input: { assignableId: 'I_421', actorLogins: ['bob'] } } }),
    gh('POST', '/repos/o/r/issues/421/assignees', { assignees: ['Me'] }), gh('DELETE', '/repos/o/r/issues/421/assignees', { assignees: ['me'] }),
    ghql(GH.issueComment), gh('POST', '/repos/o/r/issues/421/comments', { body: 'on it' }), // gh issue comment 421
    ghql(GH.repositoryInfo), ghql(GH.prForBranch), ghql(GH.prCreate), // gh pr create --draft
    gh('POST', '/repos/o/r/pulls', { title: 't', body: 'Fixes #421', head: 'fix-421', base: 'main', draft: true }),
    gitPush('github.com', '/o/r.git'), gitPush('github.com', '/o/r'), gitPush('github.com', '/me/r.git'),
  ];
  for (const request of allowedOnes) await allowed(rules, request, pushed());
  const denied = [
    ghql(GH.assignSelf), ghql(GH.unassignSelf), // the lists gh would send if bob were not assigned: they would unassign him
    ghql({ ...GH.assignSelf, variables: { input: { assignableId: 'I_422', actorLogins: ['bob', 'me'] } } }), ghql({ ...GH.issueComment, variables: { input: { subjectId: 'I_422', body: 'x' } } }),
    gh('POST', '/repos/o/r/issues/421/assignees', { assignees: ['mallory'] }), gh('POST', '/repos/o/r/issues/421/assignees', { assignees: ['me', 'mallory'] }), gh('POST', '/repos/o/r/issues/421/assignees', {}),
    gh('POST', '/repos/o/r/issues/422/assignees', { assignees: ['me'] }), gh('POST', '/repos/o/r/issues/422/comments', { body: 'x' }), gh('POST', '/repos/o/r/issues/578/comments', { body: 'x' }),
    gh('PATCH', '/repos/o/r/issues/421', { title: 'x' }), ghql({ ...GH.issueUpdateNothing, variables: { input: { id: 'I_421', state: 'CLOSED' } } }),
    gh('POST', '/repos/o/r/pulls', { title: 't', head: 'fix-421', base: 'main' }), gh('POST', '/repos/o/r/pulls', { title: 't', head: 'fix-421', base: 'main', draft: false }),
    gh('POST', '/repos/o/r/pulls', { title: 't', head: 'feature', base: 'main', draft: true }), gh('POST', '/repos/o/r/pulls', { title: 't', head: 'victim:fix-421', base: 'main', draft: true }),
    ghql({ ...GH.prCreate, variables: { input: { ...GH.prCreate.variables.input, draft: false } } }), ghql({ ...GH.prCreate, variables: { input: { ...GH.prCreate.variables.input, headRefName: 'main' } } }),
    ghql({ ...GH.prCreate, variables: { input: { ...GH.prCreate.variables.input, repositoryId: 'R_other' } } }),
    ghql({ ...GH.prReady, variables: { input: { pullRequestId: 'PR_579' } } }), ghql({ ...GH.resolveThread, variables: { t: 'PRRT_579' } }),
    gh('POST', '/repos/o/r/pulls/578/reviews', { commit_id: 'abc' }), gitPush('github.com', '/me/mine.git'), gitPush('github.com', '/them/r.git'),
  ];
  for (const request of denied) await refused(rules, request, pushed());
  // Before anything is pushed there is no branch to open a pull request from.
  await refused(rules, ghql(GH.prCreate), world(), /only be opened from a branch this task pushed/);
});

await check('issues options: noPRs leaves the comment alone; assign and comment can each be switched off', async () => {
  const pushed = () => world({ branches: ['refs/heads/fix-421'] });
  const assign = ghql({ ...GH.assignSelf, variables: { input: { assignableId: 'I_421', actorLogins: ['bob', 'me'] } } });
  const noPRs = github('issues', { noPRs: true });
  await allowed(noPRs, ghql(GH.issueComment));
  await allowed(noPRs, gh('POST', '/repos/o/r/issues/421/comments', { body: 'findings' }));
  for (const request of [assign, gh('POST', '/repos/o/r/issues/421/assignees', { assignees: ['me'] }), ghql(GH.issueUpdateNothing), ghql(GH.prCreate), gitPush('github.com', '/o/r.git'),
    gh('POST', '/repos/o/r/pulls', { title: 't', head: 'fix-421', draft: true })]) await refused(noPRs, request, pushed());
  assert.deepEqual(noPRs.filter((r) => r.method !== 'GET' && !r.graphql).map((r) => r.path), ['/repos/o/r/issues/421/comments'], 'one write rule beside GraphQL');
  assert.deepEqual(noPRs.find((r) => r.graphql).graphql.mutations, ['addComment']);
  await refused(github('issues', { assign: false }), assign, pushed());
  await allowed(github('issues', { assign: false }), ghql(GH.issueComment), pushed());
  await refused(github('issues', { comment: false }), ghql(GH.issueComment), pushed());
  await allowed(github('issues', { comment: false }), assign, pushed());
  // A job without a number has no issue of its own: the branch and its draft stay.
  const job = github('issues', {}, 'job-x');
  await refused(job, ghql(GH.issueComment), pushed());
  await refused(job, gh('POST', '/repos/o/r/issues/421/comments', { body: 'x' }), pushed());
  await allowed(job, ghql(GH.prCreate), pushed());
});

await check('audit: new branches and draft pull requests; readOnly and investigate write nothing', async () => {
  const pushed = () => world({ branches: ['refs/heads/fix-421'] });
  const rules = github('audit');
  await allowed(rules, gitPush('github.com', '/o/r.git'));
  await allowed(rules, ghql(GH.prCreate), pushed());
  await allowed(rules, gh('POST', '/repos/o/r/pulls', { title: 't', head: 'fix-421', base: 'main', draft: true }), pushed());
  assert.equal(rules.find((r) => r.git && r.method === 'POST').create, AUDIT_BRANCHES);
  assert.equal(github('issues').find((r) => r.git && r.method === 'POST').create, 1);
  for (const request of [ghql(GH.issueComment), gh('POST', '/repos/o/r/issues/421/comments', { body: 'x' }), ghql({ ...GH.prCreate, variables: { input: { ...GH.prCreate.variables.input, draft: false } } }),
    ghql({ ...GH.resolveThread, variables: { t: 'PRRT_579' } })]) await refused(rules, request, pushed());
  for (const rules of [github('audit', { readOnly: true }), github('investigate'), github('investigate', { verdict: true, markReady: true })]) {
    assert.deepEqual(rules.filter((r) => r.method !== 'GET').map((r) => r.path), ['/graphql'], 'the only non-GET rule is the GraphQL endpoint');
    assert.deepEqual(rules.find((r) => r.graphql).graphql.mutations, []);
    for (const request of [gitPush('github.com', '/o/r.git'), ghql(GH.prCreate), ghql(GH.issueComment), gh('POST', '/repos/o/r/pulls', { title: 't', head: 'fix-421', draft: true }),
      gh('POST', '/repos/o/r/issues/421/comments', { body: 'x' })]) await refused(rules, request, pushed());
  }
});

await check('every push rule keeps CI definitions out of reach, and no rule names a ref outside refs/heads', async () => {
  for (const kind of KINDS) {
    for (const [rules, guarded] of [[github(kind, { markReady: true, verdict: true }), ['.github/workflows/**']], [gitlab(kind, { markReady: true, verdict: true }), ['.gitlab-ci.yml', '.gitlab/ci/**']]]) {
      for (const rule of rules.filter((r) => r.git)) {
        assert.equal(rule.git, 'receive-pack');
        // A push is addressed by name: to the pool's repository in full, or to a repository of the
        // task's own account, which the check holds to that account's fork of the pool's.
        assert.ok(['o/r', 'group/sub/proj'].includes(rule.repo), rule.path);
        if (rule.fork === undefined) assert.ok(!rule.path.includes('*'), rule.path);
        else assert.ok(rule.fork === 'me' && ['/me/*/info/refs', '/me/*/git-receive-pack'].includes(rule.path), rule.path);
        if (rule.method === 'POST') assert.deepEqual(rule.denyPaths, guarded, kind);
        else assert.deepEqual(rule.query, { service: { equals: 'git-receive-pack' } });
        assert.ok(rule.head ? rule.refs === undefined && rule.create === undefined : rule.refs.every((r) => r.startsWith('refs/heads/')), kind);
      }
    }
  }
  assert.equal(github('review').some((r) => r.git), false);
  assert.equal(github('investigate').some((r) => r.git), false);
});

await check('a job-wide review covers every open pull request of somebody else, asked of the forge each time', async () => {
  const rules = github('review', {}, 'job-all');
  await allowed(rules, gh('POST', '/repos/o/r/pulls/578/reviews', { commit_id: 'abc' }));
  await allowed(rules, gh('POST', '/repos/o/r/pulls/578/reviews/1/events', { event: 'COMMENT' }));
  await allowed(rules, ghql(GH.addThread));
  await refused(rules, gh('POST', '/repos/o/r/pulls/579/reviews', { commit_id: 'abc' }), world(), /#579 was opened by me/);
  await refused(rules, gh('POST', '/repos/o/r/pulls/580/reviews', { commit_id: 'abc' }), world(), /#580 is not open/);
  await refused(rules, gh('POST', '/repos/o/r/pulls/999/reviews', { commit_id: 'abc' }), world(), /not a pull request/);
  await refused(rules, gh('POST', '/repos/o/r/pulls/578/reviews/1/events', { event: 'APPROVE' }));
  await refused(rules, ghql({ ...GH.addThread, variables: { ...GH.addThread.variables, rid: 'PRR_579' } }), world(), /#579 was opened by me/);
  const named = github('review', { author: 'Somebody' }, 'job-all');
  await refused(named, gh('POST', '/repos/o/r/pulls/578/reviews', { commit_id: 'abc' }), world(), /#578 was not opened by somebody/);

  const mine = github('review-own', {}, 'job-mine');
  await allowed(mine, ghql({ ...GH.resolveThread, variables: { t: 'PRRT_579' } }));
  await allowed(mine, gh('POST', '/repos/o/r/pulls/579/comments/13/replies', { body: 'Fixed in abc' }));
  await refused(mine, ghql(GH.resolveThread), world(), /#578 was not opened by me/);
  await refused(mine, ghql({ ...GH.resolveThread, variables: { t: 'PRRT_580' } }), world(), /#580 is not open/);
  await allowed(mine, gitPush('github.com', '/o/r.git'));
  await allowed(mine, gitPush('github.com', '/me/r.git'));
  await refused(mine, gitPush('github.com', '/me/mine.git'), world(), /not this account's own fork/);
  await refused(mine, gitPush('github.com', '/o/other.git'), world(), /no rule of this task allows the request/);
  const theirs = github('conflicts', { author: 'them' }, 'job-c');
  await allowed(theirs, gitPush('github.com', '/o/r.git'));
  await refused(theirs, gitPush('github.com', '/me/r.git'), world(), /no open pull request by them has its head branch here/);
  await refused(github('conflicts', { author: 'nobody' }, 'job-c'), gitPush('github.com', '/o/r.git'), world(), /no open pull request by nobody/);
});

// ------------------------------------------------------------------------- GitLab

const P = '/api/v4/projects/group%2Fsub%2Fproj';
const glWorld = (branches = []) => {
  const w = world({ branches });
  w.pulls = {
    5: { number: 5, open: true, author: 'me', headRepo: 'group/sub/proj', headRepoId: 99, headRef: 'feature' },
    6: { number: 6, open: true, author: 'them', headRepo: '', headRepoId: 16, headRef: 'forked' },
    8: { number: 8, open: true, author: 'me', headRepo: '', headRepoId: 13, headRef: 'mine' },
  };
  w.repos['me/proj'] = { id: 13, name: 'me/proj', owner: 'me', parent: 'group/sub/proj', defaultBranch: 'main', ciPaths: [] };
  w.pull = async (n) => w.pulls[n] ?? null;
  w.pullsByHead = async (ref) => Object.values(w.pulls).filter((p) => ref === undefined || p.headRef === ref);
  w.assigned = [3];
  return w;
};

await check('GitLab: every kind reads what glab reads, in the pool\'s project only', async () => {
  // Captured from glab 1.128.0: mr view --comments, mr diff, mr list, issue view --comments, issue list, api.
  const reads = [
    glab('GET', `${P}/merge_requests/5`), glab('GET', `${P}/merge_requests/5/discussions?page=1&per_page=20&sort=asc`), glab('GET', `${P}/merge_requests/5/versions`),
    glab('GET', `${P}/merge_requests?page=1&per_page=30&state=opened`), glab('GET', `${P}/issues/421`), glab('GET', `${P}/issues/421/notes?page=1&per_page=20&sort=asc`),
    glab('GET', `${P}/issues?in=title%2Cdescription&order_by=created_at&page=1&per_page=30&sort=desc&state=opened`), glab('GET', `${P}?license=true&with_custom_attributes=true`),
    glab('GET', '/api/v4/projects/99/merge_requests/5/draft_notes'), glab('GET', '/api/v4/projects/Group%2FSub%2Fproj/merge_requests/5'), glab('GET', `${P}/repository/commits/abc123`),
    glab('GET', `${P}/pipelines/7/jobs`), glab('GET', `${P}/jobs/7/trace`), glab('GET', '/api/v4/user'),
    glab('POST', '/api/graphql', { query: '{currentUser{username}}' }), // glab api graphql -f query=...
    glab('GET', `${P}/repository/compare?from=main&to=feature&straight=true`), glab('GET', `${P}/repository/branches/feature`),
    // repo view, repo view -b release/1.0: glab encodes a name's slashes and its dots.
    glab('GET', `${P}/repository/files/README%2Emd?ref=main`), glab('GET', `${P}/repository/files/README%2Emd?ref=release%2F1.0`),
    // api, with a file's path, a branch's and a tag's name spelled the one way GitLab takes them.
    glab('GET', `${P}/repository/files/src%2Fmain.js?ref=main`), glab('GET', `${P}/repository/files/src%2Fmain.js/raw?ref=feature%2Flogin`), glab('GET', `${P}/repository/files/src%2flib%2Fmain.js/blame?ref=main`),
    glab('GET', `${P}/repository/branches/feature%2Flogin`), glab('GET', `${P}/repository/branches/release%2F1%2E0`), glab('GET', `${P}/repository/commits/feature%2Flogin`),
    glab('GET', `${P}/repository/commits/feature%2Flogin/diff`), glab('GET', `${P}/repository/tags/release%2F1.0`), glab('GET', `${P}/repository/tree?path=src%2Flib&ref=feature%2Flogin`),
    glab('GET', '/api/v4/projects/99/repository/files/src%2Fmain.js/raw?ref=feature%2Flogin'), glab('GET', '/api/v4/projects/99/repository/branches/feature%2Flogin'),
    glab('GET', `${P}/merge_requests?source_branch=feature%2Flogin`),
    // No route of GitLab's: an encoded slash separates nothing there, and its router answers 404.
    glab('GET', `${P}/repository/compare%2Fx`),
  ];
  const never = [
    // reads of this project whose answer is another project's, a person's address, or a write
    glab('GET', `${P}/repository/compare?from=main&to=x&from_project_id=100`), glab('GET', '/api/v4/projects/99/repository/compare?from=main&to=x&from_project_id=100'),
    glab('GET', `${P}/merge_requests/5/closes_issues`), glab('GET', `${P}/merge_requests/5/related_issues`), glab('GET', '/api/v4/projects/99/merge_requests/5/blocks'),
    glab('GET', `${P}/merge_requests/5/blockees`), glab('GET', `${P}/issues/421/links`), glab('GET', `${P}/issues/421/related_merge_requests`), glab('GET', `${P}/issues/421/closed_by`),
    glab('GET', `${P}/issues/421/user_agent_detail`), glab('GET', `${P}/merge_requests/5/merge_ref`),
    // an encoded slash or dot aimed at one of those, at a route with pinned parameters or a cut answer, at a settings route, or sent in a write
    glab('GET', `${P}/repository/files/..%2F..%2Fcompare`), glab('GET', `${P}/repository/files/..%2F..%2Fcompare/raw?ref=main`), glab('GET', `${P}/repository/branches/x%2F..%2F..%2Fmerge_requests%2F5%2Fmerge`),
    glab('GET', `${P}/merge_requests/5%2Fmerge_ref`), glab('GET', `${P}/merge_requests/5%2fcloses_issues`), glab('GET', '/api/v4/projects/99/issues/421%2Flinks'), glab('GET', `${P}/merge_requests/5/merge_ref%2Ejson`),
    glab('GET', `${P}/repository/compare.json%2Fx?from=main&to=x&from_project_id=100`), glab('GET', `${P}/repository/compare%2Ejson?from=main&to=x&from_project_id=100`),
    glab('GET', `${P}/repository%2Fcompare?from=main&to=x&from_project_id=100`), glab('GET', `${P}/repository/branches%2Fmain`), glab('GET', `${P}/pipelines/7%2Fvariables`),
    glab('GET', `${P}/protected_branches/feature%2Flogin`), glab('GET', `${P}%2Fvariables`), glab('GET', '/api/v4/projects/99%2Fvariables'),
    glab('PUT', `${P}/merge_requests/5%2Fmerge`, {}), glab('DELETE', `${P}/repository/branches/feature%2Flogin`), glab('PUT', `${P}/repository/files/src%2Fmain.js`, { branch: 'fix-421', content: 'x', commit_message: 'x' }),
    glab('GET', '/api/v4/projects'), glab('GET', '/api/v4/projects?membership=true'), glab('GET', '/api/v4/projects/group%2Fsub%2Fother'), glab('GET', '/api/v4/projects/100/merge_requests/5'),
    glab('GET', '/api/v4/projects/group%2Fsub/merge_requests'), glab('GET', '/api/v4/projects/group%2Fsub%2Fproj%2F..%2Fother/issues'), glab('GET', '/api/v4/projects/99/../100'),
    glab('GET', `${P}/variables`), glab('POST', `${P}/variables`, { key: 'X', value: 'y' }), glab('GET', `${P}/hooks`), glab('GET', `${P}/deploy_keys`), glab('GET', `${P}/members/all`),
    glab('GET', `${P}/access_tokens`), glab('GET', `${P}/triggers`), glab('GET', `${P}/runners`), glab('GET', `${P}/protected_branches`), glab('GET', `${P}/environments`), glab('GET', `${P}/secure_files`),
    glab('PUT', P, { visibility: 'public' }), glab('DELETE', P), glab('POST', `${P}/fork`, {}), glab('POST', `${P}/share`, { group_id: 1 }),
    glab('PUT', `${P}/merge_requests/5/merge`, {}), glab('PUT', `${P}/merge_requests/5`, { state_event: 'close' }), glab('PUT', `${P}/merge_requests/5`, { target_branch: 'release' }),
    glab('DELETE', `${P}/merge_requests/5`), glab('POST', `${P}/merge_requests/5/rebase`, {}), glab('DELETE', `${P}/merge_requests/5/notes/1`), glab('PUT', `${P}/issues/421`, { state_event: 'close' }),
    glab('POST', `${P}/repository/commits`, { branch: 'main', commit_message: 'x', actions: [] }), glab('POST', `${P}/repository/branches?branch=x&ref=main`), glab('DELETE', `${P}/repository/branches/main`),
    glab('POST', `${P}/repository/files/a.txt`, { branch: 'main', content: 'x', commit_message: 'x' }), glab('PUT', `${P}/repository/files/.gitlab-ci.yml`, { branch: 'main', content: 'x', commit_message: 'x' }),
    glab('POST', `${P}/repository/tags?tag_name=v9&ref=main`), glab('POST', `${P}/pipeline?ref=main`), glab('POST', `${P}/trigger/pipeline`, { token: 'x', ref: 'main' }), glab('POST', `${P}/jobs/7/play`, {}),
    glab('POST', `${P}/pipelines/7/retry`, {}), glab('POST', `${P}/releases`, { tag_name: 'v9' }), glab('POST', `${P}/issues`, { title: 'x' }), glab('GET', `${P}/merge_requests?sudo=root`),
    glab('GET', `${P}/issues?private_token=glpat-x`), glab('GET', '/api/v4/user/keys'), glab('GET', '/api/v4/user/emails'), glab('GET', '/api/v4/users/7/projects'), glab('GET', '/api/v4/groups/group/projects'),
    glab('GET', '/api/v4/groups'), glab('GET', '/api/v4/personal_access_tokens'), glab('POST', '/api/v4/user/personal_access_tokens', { name: 'x', scopes: ['api'] }), glab('GET', '/api/v4/merge_requests'),
    glab('GET', '/api/v4/issues'), glab('GET', '/api/v4/todos'), glab('GET', '/api/v4/snippets'), glab('GET', '/api/v4/search?scope=projects&search=x'), glab('GET', '/api/v4/application/settings'),
    glab('POST', '/api/v4/usage_data/track_event', { event: 'gitlab_cli_command_used' }), // glab's own telemetry: not the task's business
    { ...glab('GET', `${P}/merge_requests/5`), host: 'gitlab.com' }, { ...glab('GET', `${P}/merge_requests/5`), host: 'gitlab.example.com.evil.example' },
    glab('POST', '/api/graphql', { query: '{ projects(membership: true) { nodes { fullPath } } }' }), glab('POST', '/api/graphql', { query: '{ project(fullPath: "group/sub/other") { name } }' }),
    glab('POST', '/api/graphql', { query: 'mutation { mergeRequestAccept(input: {projectPath: "group/sub/proj", iid: "5", sha: "x"}) { errors } }' }),
    gitPush('gitlab.example.com', '/group/sub/other.git'), gitPush('gitlab.example.com', '/group/sub.git'), gitPush('gitlab.example.com', '/group/sub/proj.wiki.git'),
    { host: 'gitlab.example.com', method: 'GET', path: '/group/sub/proj/-/settings/ci_cd', headers: {}, body: '' }, { host: 'gitlab.example.com', method: 'POST', path: '/oauth/token', headers: {}, body: '' },
  ];
  for (const kind of KINDS) {
    for (const options of [{}, { verdict: true, markReady: true }]) {
      for (const request of reads) await allowed(gitlab(kind, options), request, glWorld());
      for (const request of never) await refused(gitlab(kind, options), request, glWorld(['refs/heads/fix-421']));
    }
  }
  assert.deepEqual((await allowed(gitlab('investigate'), glab('GET', '/api/v4/user'))).request.pick, ['id', 'username', 'name', 'state', 'web_url']);
  // The project's own answer goes out without the token that registers a runner or an import URL's credential.
  for (const path of [P, '/api/v4/projects/99']) {
    const project = (await allowed(gitlab('investigate'), glab('GET', path))).request.pick;
    assert.ok(project.includes('default_branch') && project.includes('path_with_namespace'));
    for (const member of ['runners_token', 'import_url', 'service_desk_address', 'permissions', 'forked_from_project', 'shared_with_groups', 'ci_config_path']) assert.ok(!project.includes(member), member);
  }
  // A branch goes out as GitHub's does: without who may push to it or merge into it.
  for (const path of [`${P}/repository/branches`, `${P}/repository/branches?search=fix&per_page=100`, `${P}/repository/branches/feature`, '/api/v4/projects/99/repository/branches', '/api/v4/projects/99/repository/branches/v1.0']) {
    assert.deepEqual((await allowed(gitlab('investigate'), glab('GET', path), glWorld())).request.pick, ['name', 'commit', 'merged', 'protected', 'default', 'web_url']);
  }
  await refused(gitlab('investigate'), glab('GET', `${P}/repository/compare?from=main&to=x&from_project_id=100`), glWorld(), /"from_project_id"/);
  await refused(gitlab('investigate'), glab('GET', `${P}/merge_requests/5/merge_ref`), glWorld(), /writes a ref on the forge/);
});

await check('GitLab: each kind writes what its GitHub twin writes, through the routes glab uses', async () => {
  const review = gitlab('review');
  for (const request of [
    glab('POST', '/api/v4/projects/99/merge_requests/5/draft_notes', { note: 'hello' }), // glab api projects/:id/merge_requests/5/draft_notes -X POST -f note=hello
    glab('POST', '/api/v4/projects/99/merge_requests/5/draft_notes/bulk_publish', {}), glab('POST', `${P}/merge_requests/5/draft_notes`, { note: 'x', position: { new_line: 3 } }),
    glab('DELETE', `${P}/merge_requests/5/draft_notes/3`), glab('POST', `${P}/merge_requests/5/notes`, { body: 'hello' }), // glab mr note 5 -m hello
  ]) await allowed(review, request, glWorld());
  for (const request of [
    glab('POST', `${P}/merge_requests/5/approve`, {}), glab('POST', `${P}/merge_requests/5/unapprove`), glab('POST', `${P}/merge_requests/6/draft_notes`, { note: 'x' }),
    glab('POST', `${P}/merge_requests/5/draft_notes`, { note: 'lgtm\n/merge' }), glab('POST', `${P}/merge_requests/5/notes`, { body: '/approve' }),
    glab('POST', `${P}/merge_requests/5/draft_notes?note=%2Fmerge`, {}), glab('POST', `${P}/merge_requests/5/draft_notes`, { note: 'x', resolve_discussion: true }),
    glab('PUT', `${P}/merge_requests/5/discussions/abc`, { resolved: true }), glab('PUT', `${P}/merge_requests/5`, { title: 't' }), gitPush('gitlab.example.com', '/group/sub/proj.git'),
  ]) await refused(review, request, glWorld());
  await allowed(gitlab('review', { verdict: true }), glab('POST', `${P}/merge_requests/5/approve`, {}), glWorld()); // glab mr approve 5
  await refused(gitlab('review', { verdict: true }), glab('POST', `${P}/merge_requests/6/approve`, {}), glWorld());
  // A job-wide review has no number in its paths: the forge is asked who opened the merge request each one names.
  const all = gitlab('review', { verdict: true }, 'job-all');
  for (const base of [P, '/api/v4/projects/99']) {
    await allowed(all, glab('POST', `${base}/merge_requests/6/draft_notes`, { note: 'x' }), glWorld());
    await allowed(all, glab('POST', `${base}/merge_requests/6/approve`, {}), glWorld());
    await refused(all, glab('POST', `${base}/merge_requests/5/draft_notes`, { note: 'x' }), glWorld(), /#5 was opened by me/);
    await refused(all, glab('POST', `${base}/merge_requests/5/approve`, {}), glWorld(), /#5 was opened by me/);
    await refused(all, glab('DELETE', `${base}/merge_requests/5/draft_notes/3`), glWorld(), /#5 was opened by me/);
    await refused(all, glab('POST', `${base}/merge_requests/7/notes`, { body: 'x' }), glWorld(), /not a pull request/);
  }
  const allMine = gitlab('review-own', { markReady: true }, 'job-mine');
  await allowed(allMine, glab('PUT', `${P}/merge_requests/5/discussions/abc`, { resolved: true }), glWorld());
  await allowed(allMine, glab('PUT', `${P}/merge_requests/5`, { title: 't' }), glWorld());
  await refused(allMine, glab('PUT', `${P}/merge_requests/6/discussions/abc`, { resolved: true }), glWorld(), /#6 was not opened by me/);
  await refused(allMine, glab('POST', `${P}/merge_requests/6/discussions/abc/notes`, { body: 'x' }), glWorld(), /#6 was not opened by me/);
  await refused(allMine, glab('PUT', `${P}/merge_requests/6`, { title: 't' }), glWorld(), /#6 was not opened by me/);

  const own = gitlab('review-own');
  for (const request of [
    glab('POST', `${P}/merge_requests/5/discussions/abc/notes`, { body: 'Fixed' }), // glab api projects/:fullpath/merge_requests/5/discussions/abc/notes -X POST -f body=Fixed
    glab('PUT', '/api/v4/projects/99/merge_requests/5/discussions/abc', { resolved: 'true' }), // glab api ... -X PUT -f resolved=true
    glab('PUT', `${P}/merge_requests/5/discussions/abc?resolved=true`), gitPush('gitlab.example.com', '/group/sub/proj.git'), gitPush('gitlab.example.com', '/Group/Sub/Proj'),
  ]) await allowed(own, request, glWorld());
  for (const request of [
    glab('PUT', `${P}/merge_requests/5`, { title: 't' }), glab('PUT', `${P}/merge_requests/5/discussions/abc`, { resolved: false }), glab('PUT', `${P}/merge_requests/5/discussions/abc?resolved=false`),
    glab('POST', `${P}/merge_requests/6/discussions/abc/notes`, { body: 'x' }), glab('POST', `${P}/merge_requests/5/discussions/abc/notes`, { body: 'x\n/merge' }),
    glab('POST', `${P}/merge_requests/5/notes`, { body: 'x' }), glab('POST', `${P}/merge_requests/5/draft_notes`, { note: 'x' }), glab('POST', `${P}/merge_requests/5/approve`, {}),
  ]) await refused(own, request, glWorld());
  const ready = gitlab('review-own', { markReady: true });
  await allowed(ready, glab('PUT', `${P}/merge_requests/5`, { title: 't' }), glWorld()); // glab mr update 5 --ready
  for (const body of [{ title: 't', state_event: 'close' }, { title: 't', target_branch: 'x' }, { title: 't', description: '/merge' }, { title: 't', assignee_ids: [1] }]) {
    await refused(ready, glab('PUT', `${P}/merge_requests/5`, body), glWorld());
  }
  await refused(ready, glab('PUT', `${P}/merge_requests/5?state_event=close`, { title: 't' }), glWorld());
  // A merge request's branch is pushed in the project that holds it: the pool's, or the task account's own fork of it.
  const lab = (path) => gitPush('gitlab.example.com', path);
  for (const path of ['/group/sub/proj.git', '/me/proj.git']) await refused(gitlab('conflicts', {}, 'pr-6'), lab(path), glWorld(), /does not hold the head branch of open pull request #6/);
  await allowed(gitlab('conflicts', {}, 'pr-8'), lab('/me/proj.git'), glWorld());
  await allowed(gitlab('conflicts', {}, 'pr-8'), lab('/Me/proj'), glWorld());
  await refused(gitlab('conflicts', {}, 'pr-8'), lab('/group/sub/proj.git'), glWorld(), /does not hold the head branch of open pull request #8/);
  for (const path of ['/them/proj.git', '/me/sub/proj.git', '/group/proj.git']) await refused(gitlab('conflicts', {}, 'pr-8'), lab(path), glWorld(), /no rule of this task allows the request/);

  const issues = gitlab('issues');
  const pushed = () => glWorld(['refs/heads/fix-421']);
  const create = { title: 'Draft: t', description: 'd', source_branch: 'fix-421', target_branch: 'main', labels: '', target_project_id: 99 }; // glab mr create --draft
  for (const request of [
    glab('PUT', `${P}/issues/421`, { assignee_ids: [3, 7] }), glab('PUT', `${P}/issues/421`, { assignee_ids: [3] }), // account 3 holds the issue: this task joins and leaves
    glab('POST', `${P}/issues/421/notes`, { body: 'hello' }), glab('POST', `${P}/merge_requests`, create), gitPush('gitlab.example.com', '/group/sub/proj.git'),
  ]) await allowed(issues, request, pushed());
  // glab issue update 421 --assignee @me, --unassign: the whole list, right only where nobody else holds the issue.
  const free = () => Object.assign(pushed(), { assigned: [] });
  for (const assignee_ids of [[7], [0]]) await allowed(issues, glab('PUT', `${P}/issues/421`, { assignee_ids }), free());
  for (const assignee_ids of [[7], [0], [], [8], [3, 8], [3, 7, 8], [0, 3], '7']) {
    await refused(issues, glab('PUT', `${P}/issues/421`, { assignee_ids }), pushed(), /own account|not a list of account ids/);
  }
  await refused(issues, glab('PUT', `${P}/issues/421`, {}), pushed());
  // An id given twice is one account, here as in a GraphQL assignment.
  const held = () => Object.assign(pushed(), { assigned: [3, 4] });
  for (const assignee_ids of [[3, 3, 7], [4, 4], [3, 3, 4, 8]]) await refused(issues, glab('PUT', `${P}/issues/421`, { assignee_ids }), held(), /own account/);
  for (const assignee_ids of [[4, 3, 3, 7, 7], [3, 4, 4]]) await allowed(issues, glab('PUT', `${P}/issues/421`, { assignee_ids }), held());
  for (const request of [
    glab('PUT', `${P}/issues/422`, { assignee_ids: [3, 7] }), glab('PUT', `${P}/issues/421`, { assignee_ids: [3, 7], labels: 'x' }),
    glab('POST', `${P}/issues/422/notes`, { body: 'x' }), glab('POST', `${P}/issues/421/notes`, { body: '/close' }), glab('POST', `${P}/issues/421/notes?body=%2Fclose`, {}),
    glab('POST', `${P}/merge_requests`, { ...create, title: 't' }), glab('POST', `${P}/merge_requests`, { ...create, source_branch: 'main' }), glab('POST', `${P}/merge_requests`, { ...create, target_project_id: 100 }),
    glab('POST', `${P}/merge_requests`, { ...create, description: 'd\n/merge' }), glab('POST', `${P}/merge_requests`, { ...create, merge_when_pipeline_succeeds: true }),
    glab('POST', `${P}/merge_requests?title=x`, create), glab('POST', `${P}/merge_requests`, { ...create, source_project_id: 100 }),
  ]) await refused(issues, request, pushed());
  // A merge request is a draft by its title alone, so one sent without a title is not one.
  await refused(issues, glab('POST', `${P}/merge_requests`, { ...create, title: undefined }), pushed(), /the body member "title" is required/);
  await refused(issues, glab('POST', `${P}/merge_requests`, { ...create, source_branch: undefined }), pushed(), /the body member "source_branch" is required/);
  const noPRs = gitlab('issues', { noPRs: true });
  await allowed(noPRs, glab('POST', `${P}/issues/421/notes`, { body: 'findings' }), pushed());
  for (const request of [glab('PUT', `${P}/issues/421`, { assignee_ids: [3, 7] }), glab('POST', `${P}/merge_requests`, create), gitPush('gitlab.example.com', '/group/sub/proj.git')]) await refused(noPRs, request, pushed());

  await allowed(gitlab('audit'), glab('POST', `${P}/merge_requests`, create), pushed());
  for (const rules of [gitlab('audit', { readOnly: true }), gitlab('investigate')]) {
    assert.deepEqual(rules.filter((r) => r.method !== 'GET').map((r) => r.path), ['/api/graphql']);
    await refused(rules, glab('POST', `${P}/merge_requests`, create), pushed());
    await refused(rules, gitPush('gitlab.example.com', '/group/sub/proj.git'), pushed());
  }
  // Without the project's number a rule list knows one spelling, and glab's target_project_id cannot be pinned.
  const unnumbered = rulesFor({ forge: 'gitlab', kind: 'issues', pool: GITLAB_POOL.id, item: 'issue-421', identity: 'me' });
  await refused(unnumbered, glab('GET', '/api/v4/projects/99/issues/421'), pushed());
  await refused(unnumbered, glab('POST', `${P}/merge_requests`, create), pushed());
  await allowed(unnumbered, glab('POST', `${P}/merge_requests`, { ...create, target_project_id: undefined }), pushed());
});

// ------------------------------------------------------- one spelling per route

// The second spellings of one literal segment that a router could resolve to the first:
// a character escaped (once and twice over), a letter in the other case, an extension.
function respelled(segment) {
  const out = new Set([`${segment}.json`, `${segment}.JSON`, `${segment}.txt`, `${segment}.x`, `${segment}.json.json`, `${segment}%2Ejson`, `${segment}%2ejson.x`, segment.toUpperCase(), segment.toLowerCase()]);
  for (const at of [0, segment.length - 1]) {
    const c = segment[at];
    const put = (s) => segment.slice(0, at) + s + segment.slice(at + 1);
    const hex = c.charCodeAt(0).toString(16);
    for (const escape of [`%${hex}`, `%${hex.toUpperCase()}`, `%25${hex}`]) out.add(put(escape));
    out.add(put(c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()));
  }
  out.delete(segment);
  return [...out];
}

// Every rule list the catalogue can write for the two test pools.
function everyRuleList() {
  const lists = [];
  const options = [{}, { verdict: true, markReady: true }, { noPRs: true }, { readOnly: true }, { author: 'them' }];
  for (const kind of KINDS) {
    for (const item of [ITEM[kind], 'job-sweep']) {
      for (const o of options) {
        lists.push([github(kind, o, item), world], [gitlab(kind, o, item.replace('578', '5').replace('579', '5')), glWorld]);
        lists.push([rulesFor({ forge: 'gitlab', kind, options: o, pool: GITLAB_POOL.id, item: item.replace('578', '5').replace('579', '5'), identity: 'me' }), glWorld]);
      }
    }
  }
  return lists.filter(([rules]) => rules !== null);
}

await check('no second spelling of any rule\'s path is decided by another rule, on either forge', async () => {
  let asked = 0;
  for (const [rules, ctxFor] of everyRuleList()) {
    const ctx = ctxFor();
    for (const rule of rules) {
      // A path the rule matches: a number for every "*", nothing for a trailing "**".
      const segments = rule.path.slice(1).split('/').filter((s) => s !== '**');
      for (const [i, literal] of segments.entries()) {
        if (literal === '*') continue;
        for (const spelled of respelled(literal)) {
          const path = `/${segments.map((s, j) => (j === i ? spelled : s === '*' ? '5' : s)).join('/')}`;
          const verdict = await authorize(rules, { host: rule.host, method: rule.method, path, headers: {}, body: '' }, ctx);
          asked++;
          assert.ok(!verdict.ok || verdict.rule === rule, `${rule.method} ${path} is decided by the rule for ${verdict.rule?.path}, not by the one for ${rule.path}`);
          if (rule.deny !== undefined) assert.equal(verdict.ok, false, path);
        }
      }
    }
  }
  assert.ok(asked > 20000, `only ${asked} spellings were tried`);
});

await check('no rule that refuses, pins or cuts is reached by its own path with a "/" of it encoded', async () => {
  const plain = (rule) => Object.keys(rule).every((key) => ['host', 'method', 'path', 'fold'].includes(key));
  let [asked, passed] = [0, 0];
  for (const [rules, ctxFor] of everyRuleList()) {
    const ctx = ctxFor();
    for (const rule of rules) {
      const segments = rule.path.slice(1).split('/').filter((s) => s !== '**').map((s) => (s === '*' ? '5' : s));
      // One "/" encoded, in either case; then every one after a GitLab project's own segment.
      const joined = segments.slice(1).flatMap((_, j) => ['%2F', '%2f'].map((slash) => `/${segments.slice(0, j + 1).join('/')}${slash}${segments.slice(j + 1).join('/')}`));
      if (segments.length > 5) joined.push(`/${segments.slice(0, 4).join('/')}/${segments.slice(4).join('%2F')}`);
      for (const path of joined) {
        const verdict = await authorize(rules, { host: rule.host, method: rule.method, path, headers: {}, body: '' }, ctx);
        asked++;
        if (verdict.ok) passed++;
        assert.ok(!verdict.ok || (plain(rule) && plain(verdict.rule)), `${rule.method} ${path} is allowed by the rule for ${verdict.rule?.path}`);
      }
    }
  }
  assert.ok(asked > 5000 && passed > 0, `${asked} spellings were tried and ${passed} allowed`);
});

await check('the routes a task is refused or given with pinned parameters cannot be reached by another spelling', async () => {
  const escape = /an escape of a letter, a digit, "-", "_" or "~"/;
  const second = /could be read as a route another rule of this task decides/;
  // GitLab resolves an escape and a format extension in a route's name (run against a
  // Grape app declared like GitLab's API); a compare with `from_project_id` reads another project.
  const far = '?from=a&to=b&from_project_id=4242&straight=true';
  for (const project of [P, '/api/v4/projects/99', '/api/v4/projects/Group%2fSub%2FProj']) {
    for (const [tail, why] of [
      [`/repository/%63ompare${far}`, escape], [`/repository/compare.json${far}`, second], [`/repository/Compare${far}`, second], [`/repository/compar%65.json${far}`, escape],
      [`/%72epository/compare${far}`, escape], [`/repository.json/compare${far}`, /no rule of this task/], [`/repository/compare.txt${far}`, second], [`/repository/%2563ompare${far}`, /percent sign/],
      ['/merge_requests/5/merge%5Fref', escape], ['/merge_requests/5/merge_ref.json', second], ['/merge_requests/5/Merge_Ref', second], ['/merge_requests/5/closes_issues.json', second],
      ['/merge_requests/5/related_issues.json', second], ['/merge_requests/5/blocks.json', second], ['/merge_requests/5/blockees.json', second], ['/issues/421/links.json', second],
      ['/issues/421/related_merge_requests.json', second], ['/issues/421/closed_by.json', second], ['/issues/421/user_agent_detail.json', second], ['/issues/421/user%5Fagent%5Fdetail', escape],
      ['/Issues/421/links', /no rule of this task/], ['/issues.json/421/links', /no rule of this task/], ['/issues/421/links/', /empty segment/], ['/issues/421/links;x', /must be encoded/], ['/issues/421/links%3Bx', /semicolon/],
      ['/issues/421/./links', /dot segment/], ['/issues/421/x/../links', /dot segment/], ['/issues/421/x/%2e%2e/links', /dot segment/], ['/issues/421//links', /empty segment/],
      ['/issues/421/links%2ejson', second], ['/issues/421/links%2Ejson', second], ['/merge_requests/5/merge_ref%2F', /empty segment/],
    ]) await refused(gitlab('investigate'), glab('GET', `${project}${tail}`), glWorld(), why);
  }
  for (const [path, why] of [
    ['/repos/o/r/issues/421/%74imeline', escape], ['/repos/o/r/issues/421/sub%5Fissues', escape], ['/repos/o/r/issues/421/%70arent', escape], ['/repos/o/r/issues/421/dependencie%73/blocked_by', escape],
    ['/repos/o/r/issues/421/Timeline', second], ['/repos/o/r/issues/421/timeline.json', second], ['/repos/o/r/issues/421/SUB_ISSUES', second], ['/repos/o/r/issues/421/parent.json', second],
    ['/repos/o/r/issues/421/Dependencies/blocked_by', second], ['/repos/o/r/issues/421/dependencies.json/blocked_by', second], ['/repos/o/r/Issues/421/timeline', /no rule of this task/],
    ['/repos/o/r/%69ssues/421/timeline', escape], ['/repos/o/r/issues/421/timeline/', /empty segment/], ['/repos/o/r/issues/421/%2574imeline', /percent sign/],
    ['/repos/o/r/%63ompare/main...victim:main', escape], ['/repos/o/r/Compare/main...victim:main', /no rule of this task/], ['/repos/o/r/compare.json/main...victim:main', /no rule of this task/],
    ['/repos/o/r/Branches/main/protection', /no rule of this task/], ['/repos/o/r/branche%73/main/protection', escape],
  ]) await refused(github('investigate'), gh('GET', path), world(), why);
  // The whole answer about the repository or a branch is not to be had under another name.
  for (const path of ['/repos/o/r.json', '/repos/o/r/Branches', '/repos/o/r/branches.json', '/repos/o/r/Branches/main', '/repos/o/r/branches.json/main', '/User', '/user.json']) {
    await refused(github('investigate'), gh('GET', path), world(), /no rule of this task/);
  }
  for (const path of [`${P}.json`, '/api/v4/projects/99.json', '/api/v4/projects/099', '/api/v4/Projects/99', '/api/V4/projects/99', '/api/v4/User', '/api/v4/user.json']) {
    await refused(gitlab('investigate'), glab('GET', path), glWorld(), /no rule of this task/);
  }

  // A file, a branch or a tag whose own name ends like a format or holds a route's name is still read.
  for (const path of ['/repos/o/r/contents/package.json', '/repos/o/r/contents/docs/timeline.json?ref=main', '/repos/o/r/contents/a%20b.md', '/repos/o/r/git/ref/tags/v1.0.json', '/repos/o/r/branches/v1.0.json',
    '/repos/o/r/commits/v1.0.json', '/repos/o/r/compare/v1.0.json...main', '/repos/o/r/contents/issues/421/timeline', '/repos/o/r/issues/421/comments', '/repos/o/r/releases/tags/Compare']) {
    assert.equal((await allowed(github('investigate'), gh('GET', path))).request.path, path);
  }
  for (const tail of ['/repository/files/package.json?ref=main', '/repository/files/package.json/raw?ref=main', '/repository/files/compare.json?ref=main', '/repository/branches/v1.0.json',
    '/repository/branches/Compare', '/repository/tags/v1.0.json', '/repository/commits/v1.0.json', '/merge_requests/5.json', '/repository/tree?path=src%2Flib&ref=main']) {
    for (const project of [P, '/api/v4/projects/99']) assert.equal((await allowed(gitlab('investigate'), glab('GET', `${project}${tail}`), glWorld())).request.path, `${project}${tail}`);
  }
});

await check('a mutation the document check does not know never reaches a rule list', async () => {
  // The catalogue beside a document check that knows one mutation only.
  registerHooks({
    resolve(specifier, context, next) {
      if (specifier !== './graphql.js' || !context.parentURL?.endsWith('/rules.js?few')) return next(specifier, context);
      return { url: 'data:text/javascript,export const knownMutations = () => ["addComment"];', shortCircuit: true };
    },
  });
  const few = await import('../src/requester/rules.js?few');
  const task = { forge: 'github', pool: 'github.com/o/r', identity: 'me' };
  assert.equal(few.rulesFor({ ...task, kind: 'review', item: 'pr-578' }), null);
  assert.equal(few.rulesFor({ ...task, kind: 'issues', item: 'issue-421' }), null);
  assert.deepEqual(few.rulesFor({ ...task, kind: 'issues', item: 'issue-421', options: { noPRs: true } }).find((r) => r.graphql).graphql.mutations, ['addComment']);
  assert.ok(few.rulesFor({ ...task, kind: 'investigate', item: 'job-q' }));
  for (const kind of KINDS) {
    for (const rules of [github(kind, { verdict: true, markReady: true }), gitlab(kind, { verdict: true, markReady: true })]) assert.ok(rules, kind);
  }
});
