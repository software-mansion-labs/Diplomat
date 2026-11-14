// A task's reach, end to end: the rule catalogue, the checks and the forge client against
// a stand-in forge that can refuse, fail and be changed behind the task's back. Every check
// is an executor trying to get more than its task needs.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gh, ghql, GH, glab } from './lib/captured.mjs';
import { GITLAB_HOST, git, packOf, pushBody, startFakeForge } from './lib/fake-forge.mjs';

async function check(name, fn) {
  await fn();
  console.log(`PASS ${name}`);
}

const scratch = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'dn-task-'));
process.env.TMPDIR = path.join(scratch, 'tmp');
fs.mkdirSync(process.env.TMPDIR);
const forge = await startFakeForge();
Object.assign(process.env, forge.env);
const { createForge } = await import('../src/requester/forge.js');
const { authorize } = await import('../src/requester/authorize.js');
const { rulesFor } = await import('../src/requester/rules.js');

const client = createForge();
const ZERO = '0'.repeat(40);
const GITHUB = { forge: 'github', host: 'github.com' };
const GITLAB = { forge: 'gitlab', host: GITLAB_HOST };
const PROJECT = '/api/v4/projects/group%2Fsub%2Fproj';

// One repository per forge, each with a clone the pushed commits are made in and a
// checkout the requester links.
function repository(name, more) {
  const bare = forge.bare(name, more);
  const work = path.join(scratch, name.replaceAll('/', '-'));
  git(scratch, 'clone', '--quiet', bare, work);
  // Commits are made in the index alone, so a path is exactly what the test says whatever
  // the case rules of this machine's file system.
  const commit = (message, files = {}) => {
    for (const [file, text] of Object.entries(files)) {
      if (text === null) { git(work, 'update-index', '--force-remove', '--', file); continue; }
      fs.writeFileSync(path.join(scratch, 'blob'), text);
      git(work, 'update-index', '--add', '--cacheinfo', `100644,${git(work, 'hash-object', '-w', path.join(scratch, 'blob'))},${file}`);
    }
    git(work, 'commit', '--quiet', '--allow-empty', '-m', message);
    return git(work, 'rev-parse', 'HEAD');
  };
  const root = commit('root', { 'src/a.js': 'a\n', '.github/workflows/ci.yml': 'on: push\n', '.gitlab-ci.yml': 'test: { script: [make] }\n', '.gitlab/ci/build.yml': 'build: {}\n', 'ci/custom.yml': 'x: {}\n' });
  git(work, 'push', '--quiet', bare, `${root}:refs/heads/main`);
  const checkout = `${work}-checkout`;
  git(scratch, 'clone', '--quiet', bare, checkout);
  return {
    bare, work, checkout, root, commit,
    at: (rev) => git(work, 'checkout', '--quiet', '--force', '--detach', rev),
    /// Moves a branch on the forge behind the task's back.
    set: (branch, oid) => git(work, 'push', '--quiet', '--force', bare, `${oid}:refs/heads/${branch}`),
    tip: (branch) => { try { return git(bare, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`); } catch { return null; } },
    /// The body of a push of `commands` ([old, new, ref]) with the pack a client would send.
    body: (commands, caps) => pushBody(commands, packOf(work, commands.map((c) => c[1]).filter((oid) => oid !== ZERO), [root]), caps),
  };
}

const hub = repository('o/r', { projectId: 11 });
const lab = repository('group/sub/proj', { id: 'R_2', projectId: 99 });
// A hook that declines some names, the way a forge's own rules decline a push.
fs.writeFileSync(path.join(hub.bare, 'hooks', 'update'), '#!/bin/sh\ncase "$1" in refs/heads/declined*) echo "declined by the forge" >&2; exit 1;; esac\n', { mode: 0o755 });

const hubRules = (kind, item, options = {}) => rulesFor({ forge: 'github', kind, options, pool: 'github.com/o/r', item, identity: 'me' });
const labRules = (kind, item, options = {}) => rulesFor({ forge: 'gitlab', kind, options, pool: { id: `${GITLAB_HOST}/group/sub/proj`, projectId: 99 }, item, identity: 'me' });
const hubCtx = (state = {}) => client.context({ ...GITHUB, repo: 'o/r', checkout: hub.checkout, state });
const labCtx = (state = {}) => client.context({ ...GITLAB, repo: 'group/sub/proj', checkout: lab.checkout, state });

const pushRequest = (host, repoPath, body) => ({
  host, method: 'POST', path: `${repoPath}/git-receive-pack`,
  headers: { 'content-type': 'application/x-git-receive-pack-request', accept: 'application/x-git-receive-pack-result' }, body: body.toString('base64'),
});
const hubPush = (commands, caps) => pushRequest('github.com', '/o/r.git', hub.body(commands, caps));
const labPush = (commands) => pushRequest(GITLAB_HOST, '/group/sub/proj.git', lab.body(commands));

async function refused(rules, request, ctx, pattern) {
  const verdict = await authorize(rules, request, ctx);
  assert.equal(verdict.ok, false, `allowed: ${request.method} ${request.host}${request.path.slice(0, 160)} ${Buffer.from(request.body, 'base64').toString('latin1').slice(0, 120)}`);
  assert.match(verdict.reason, pattern);
}
// Authorises and performs; resolves to the forge's answer.
async function sent(rules, request, ctx, target = GITHUB) {
  const verdict = await authorize(rules, request, ctx);
  assert.equal(verdict.ok, true, `${verdict.reason}: ${request.method} ${request.host}${request.path.slice(0, 160)}`);
  const answer = await client.perform(verdict.request, target);
  return { ...answer, bytes: Buffer.from(answer.body, 'base64') };
}
const json = (answer) => JSON.parse(answer.bytes.toString('utf8'));
// Answers `status` (and `body`) to the requests `pattern` matches until the returned function is called.
const failing = (host, pattern, status, body = '{"message":"no"}') => forge.route(host, 'GET', pattern, (req, res) => res.writeHead(status, { 'content-type': 'application/json' }).end(body));

await check('a forge that does not say where a branch is has not said the name is free', async () => {
  hub.at(hub.root);
  const mine = hub.commit('mine', { 'src/x.js': 'x\n' });
  hub.set('existing', hub.root);
  const create = hubPush([[ZERO, mine, 'refs/heads/existing']]);
  const state = {};
  // The executor spent the requester's rate limit, or the forge is having a bad minute.
  for (const [status, body] of [[429, '{"message":"API rate limit exceeded"}'], [403, '{"message":"You have exceeded a secondary rate limit"}'], [500, 'oops'], [502, ''], [200, '{}'], [200, 'not json'], [404, '<html>Not Found</html>'], [301, '']]) {
    const off = failing('api.github.com', /^\/repos\/o\/r\/(git\/ref\/heads|branches)\/existing$/, status, body);
    await refused(hubRules('issues', 'issue-421'), create, hubCtx(state), /the forge did not say where refs\/heads\/existing is/);
    off();
  }
  assert.deepEqual(state.branches ?? [], [], 'nothing became the task\'s own');
  await refused(hubRules('issues', 'issue-421'), create, hubCtx(state), /not where this push starts from/);

  // GitLab words "no such branch" its own way, and only that is taken for it.
  lab.at(lab.root);
  const theirs = lab.commit('mine', { 'src/x.js': 'x\n' });
  lab.set('existing', lab.root);
  for (const [status, body] of [[429, '{"message":"Retry later"}'], [404, '{"message":"404 Project Not Found"}'], [500, '{}'], [200, '{"name":"existing"}']]) {
    const off = failing(GITLAB_HOST, /^\/api\/v4\/projects\/[^/]+\/repository\/branches\/existing$/, status, body);
    await refused(labRules('issues', 'issue-421'), labPush([[ZERO, theirs, 'refs/heads/existing']]), labCtx(), /the forge did not say where refs\/heads\/existing is/);
    off();
  }
});

await check('a lookup the forge does not answer is never read as permission: assignees, pull requests, comments, the account', async () => {
  const issue = hubRules('issues', 'issue-421');
  forge.issue('o/r', { number: 421, author: 'reporter', assignees: ['bob'] });
  // With bob assigned, a list of just the task's account would unassign him.
  const takeOver = ghql({ ...GH.assignSelf, variables: { input: { assignableId: 'I_421', actorLogins: ['me'] } } });
  await refused(issue, takeOver, hubCtx(), /only add or remove this task's own account/);
  for (const status of [429, 403, 500]) {
    const off = failing('api.github.com', /^\/repos\/o\/r\/issues\/421$/, status);
    await refused(issue, takeOver, hubCtx(), /the forge did not say who is assigned to #421/);
    off();
  }
  const pr = forge.pull('o/r', { number: 578, author: 'them', head: 'theirs' });
  forge.node('PRR_mine', { __typename: 'PullRequestReview', state: 'PENDING', author: { login: 'me' }, pullRequest: pr });
  const everyPull = hubRules('review', 'job-all');
  const open = gh('POST', '/repos/o/r/pulls/578/reviews', { commit_id: 'abc' });
  assert.equal((await authorize(everyPull, open, hubCtx())).ok, true);
  for (const status of [429, 500]) {
    let off = failing('api.github.com', /^\/repos\/o\/r\/pulls\/578$/, status);
    await refused(everyPull, open, hubCtx(), /the forge did not say what #578 is/);
    off();
    off = forge.route('api.github.com', 'POST', /^\/graphql$/, (req, res) => res.writeHead(status, { 'content-type': 'application/json' }).end('{"message":"no"}'));
    await refused(hubRules('review', 'pr-578'), ghql(GH.addThread), hubCtx(), /the forge did not say what PRR_mine is/);
    off();
  }
  const off = forge.route('api.github.com', 'POST', /^\/graphql$/, (req, res) => res.writeHead(200, { 'content-type': 'application/json' }).end('{"errors":[{"type":"RATE_LIMITED"}]}'));
  await refused(hubRules('review', 'pr-578'), ghql(GH.addThread), hubCtx(), /the forge did not say what PRR_mine is/);
  off();
  // A forge that cannot be reached at all is a refusal too, with its reason.
  const dead = createForge().context({ forge: 'github', host: 'github.example.com', repo: 'o/r', state: {} });
  await refused(everyPull, open, dead, /is not a host of github/);
});

await check('a branch is the task\'s own once the forge accepted its creation, and not before', async () => {
  const rules = hubRules('issues', 'issue-421');
  const state = {};
  hub.at(hub.root);
  const fix = hub.commit('fix', { 'src/fix.js': 'f\n' });
  const answer = await sent(rules, hubPush([[ZERO, fix, 'refs/heads/declined-1']]), hubCtx(state));
  assert.match(answer.bytes.toString('latin1'), /ng refs\/heads\/declined-1/, 'the forge declined the push');
  assert.equal(hub.tip('declined-1'), null);
  assert.deepEqual([state.branches, state.reserved], [[], []], 'a declined creation is nobody\'s branch and uses nothing up');

  // Somebody else then creates that very name: it is theirs.
  fs.renameSync(path.join(hub.bare, 'hooks', 'update'), path.join(hub.bare, 'hooks', 'update.off'));
  hub.set('declined-1', hub.root);
  await refused(rules, hubPush([[hub.root, fix, 'refs/heads/declined-1']]), hubCtx(state), /may not update that ref/);
  await refused(rules, gh('POST', '/repos/o/r/pulls', { title: 't', head: 'declined-1', base: 'main', draft: true }), hubCtx(state), /only be opened from a branch this task pushed/);
  await refused(rules, ghql({ ...GH.prCreate, variables: { input: { ...GH.prCreate.variables.input, headRefName: 'declined-1' } } }), hubCtx(state), /only be opened from a branch this task pushed/);

  // The allowance was not spent: the one branch can still be created, and then moved.
  assert.match((await sent(rules, hubPush([[ZERO, fix, 'refs/heads/fix-421']]), hubCtx(state))).bytes.toString('latin1'), /ok refs\/heads\/fix-421/);
  assert.deepEqual([state.branches, state.reserved], [['refs/heads/fix-421'], []]);
  const more = hub.commit('more', { 'src/fix.js': 'g\n' });
  await sent(rules, hubPush([[fix, more, 'refs/heads/fix-421']]), hubCtx(state));
  assert.equal(hub.tip('fix-421'), more);
  await refused(rules, hubPush([[ZERO, more, 'refs/heads/second']]), hubCtx(state), /may create 1 branch\(es\); it has refs\/heads\/fix-421/);
  fs.renameSync(path.join(hub.bare, 'hooks', 'update.off'), path.join(hub.bare, 'hooks', 'update'));
});

await check('a creation is counted while its answer is out, and one whose answer never comes stays counted and is not owned', async () => {
  const rules = hubRules('issues', 'issue-421');
  hub.at(hub.root);
  const fix = hub.commit('racing', { 'src/race.js': 'r\n' });
  // Two requests racing for the one allowance: one is allowed.
  const state = {};
  const both = await Promise.all(['one', 'two'].map((name) => authorize(rules, hubPush([[ZERO, fix, `refs/heads/race-${name}`]]), hubCtx(state))));
  assert.deepEqual(both.map((v) => v.ok).sort(), [false, true]);
  assert.match(both.find((v) => !v.ok).reason, /may create 1 branch/);
  assert.equal(state.reserved.length, 1);
  assert.deepEqual(state.branches, []);

  // The forge's answer is lost on the way: the branch may exist, so it stays counted; it was not confirmed, so it is not owned.
  const lost = {};
  const off = forge.route('github.com', 'POST', /git-receive-pack$/, (req, res) => res.destroy());
  const verdict = await authorize(rules, hubPush([[ZERO, fix, 'refs/heads/lost']]), hubCtx(lost));
  await assert.rejects(client.perform(verdict.request, GITHUB), /unreachable/);
  off();
  assert.deepEqual([lost.branches, lost.reserved], [[], ['refs/heads/lost']]);
  await refused(rules, hubPush([[ZERO, fix, 'refs/heads/other']]), hubCtx(lost), /may create 1 branch/);
  await refused(rules, gh('POST', '/repos/o/r/pulls', { title: 't', head: 'lost', base: 'main', draft: true }), hubCtx(lost), /only be opened from a branch this task pushed/);
  // Sent again, the same creation is the same one, and the forge's "ok" makes it the task's.
  assert.match((await sent(rules, hubPush([[ZERO, fix, 'refs/heads/lost']]), hubCtx(lost))).bytes.toString('latin1'), /ok refs\/heads\/lost/);
  assert.deepEqual([lost.branches, lost.reserved], [['refs/heads/lost'], []]);

  // A push that does not ask the forge for its report could never be confirmed.
  await refused(rules, hubPush([[ZERO, fix, 'refs/heads/quiet']], 'side-band-64k agent=git/test'), hubCtx({}), /report-status/);
  // The report is read in both framings a client may ask for.
  const plain = {};
  assert.match((await sent(rules, hubPush([[ZERO, fix, 'refs/heads/plain']], 'report-status agent=git/test'), hubCtx(plain))).bytes.toString('latin1'), /ok refs\/heads\/plain/);
  assert.deepEqual(plain.branches, ['refs/heads/plain']);
});

await check('one draft pull request per branch the task created, counted when the forge opened it', async () => {
  const rules = hubRules('issues', 'issue-421');
  const state = { branches: ['refs/heads/fix-421'] };
  const open = (base) => gh('POST', '/repos/o/r/pulls', { title: 't', head: 'fix-421', base, draft: true });
  // The forge refuses the first try (no such base): nothing is used up.
  let off = forge.route('api.github.com', 'POST', /^\/repos\/o\/r\/pulls$/, (req, res) => res.writeHead(422, { 'content-type': 'application/json' }).end('{"message":"Validation Failed"}'));
  assert.equal((await sent(rules, open('nowhere'), hubCtx(state))).status, 422);
  off();
  assert.deepEqual(state.pulls, []);
  assert.equal((await sent(rules, open('main'), hubCtx(state))).status, 201);
  assert.deepEqual(state.pulls, ['fix-421']);
  await refused(rules, open('release'), hubCtx(state), /has opened its pull request from fix-421/);
  await refused(rules, ghql(GH.prCreate), hubCtx(state), /has opened its pull request from fix-421/);

  // GraphQL says a refusal with status 200 and an error list.
  const viaGraphql = { branches: ['refs/heads/fix-421'] };
  off = forge.route('api.github.com', 'POST', /^\/graphql$/, (req, res, body) => {
    const failed = body.toString().includes('createPullRequest');
    res.writeHead(200, { 'content-type': 'application/json' }).end(failed ? '{"data":{"createPullRequest":null},"errors":[{"message":"No commits between main and fix-421"}]}' : '{"data":{"node":{"__typename":"Repository","nameWithOwner":"o/r"}}}');
  });
  await sent(rules, ghql(GH.prCreate), hubCtx(viaGraphql));
  off();
  assert.deepEqual(viaGraphql.pulls, []);
  await sent(rules, ghql(GH.prCreate), hubCtx(viaGraphql));
  assert.deepEqual(viaGraphql.pulls, ['fix-421']);
  await refused(rules, open('main'), hubCtx(viaGraphql), /has opened its pull request from fix-421/);

  // GitLab: the same, through its own route.
  const merge = { title: 'Draft: t', source_branch: 'fix-421', target_branch: 'main', target_project_id: 99 };
  const onLab = { branches: ['refs/heads/fix-421'] };
  assert.equal((await sent(labRules('issues', 'issue-421'), glab('POST', `${PROJECT}/merge_requests`, merge), labCtx(onLab), GITLAB)).status, 201);
  await refused(labRules('issues', 'issue-421'), glab('POST', `${PROJECT}/merge_requests`, { ...merge, target_branch: 'release' }), labCtx(onLab), /has opened its pull request from fix-421/);
});

await check('no task moves or creates the default branch or a protected one, whatever its pull request says', async () => {
  // A pull request whose head is the default branch: main -> release.
  forge.pull('o/r', { number: 590, author: 'me', head: 'main', base: 'release' });
  hub.at(hub.root);
  const onMain = hub.commit('straight to main', { 'src/a.js': 'main\n' });
  for (const kind of ['review-own', 'conflicts']) {
    await refused(hubRules(kind, 'pr-590'), hubPush([[hub.root, onMain, 'refs/heads/main']]), hubCtx(), /refs\/heads\/main: the default branch is never pushed by a task/);
    await refused(hubRules(kind, 'job-mine'), hubPush([[hub.root, onMain, 'refs/heads/main']]), hubCtx(), /the default branch is never pushed by a task/);
  }
  assert.equal(hub.tip('main'), hub.root);
  // The forge says which branch that is, each time: here it is "trunk", which does not exist yet.
  forge.data.repos['o/r'].defaultBranch = 'trunk';
  await refused(hubRules('issues', 'issue-421'), hubPush([[ZERO, onMain, 'refs/heads/trunk']]), hubCtx({}), /the default branch is never pushed by a task/);
  await refused(hubRules('audit', 'job-a'), hubPush([[ZERO, onMain, 'refs/heads/Trunk']]), hubCtx({}), /the default branch is never pushed by a task/);
  // And when it does not say, nothing is pushed.
  let off = failing('api.github.com', /^\/repos\/o\/r$/, 429);
  await refused(hubRules('issues', 'issue-421'), hubPush([[ZERO, onMain, 'refs/heads/anything']]), hubCtx({}), /the forge did not say which branch is the default/);
  off();
  off = failing('api.github.com', /^\/repos\/o\/r$/, 200, '{"full_name":"o/r"}');
  await refused(hubRules('issues', 'issue-421'), hubPush([[ZERO, onMain, 'refs/heads/anything']]), hubCtx({}), /the forge did not say which branch is the default/);
  off();
  forge.data.repos['o/r'].defaultBranch = 'main';

  // A protected branch that is the head of the task's pull request.
  hub.set('stable', hub.root);
  forge.pull('o/r', { number: 591, author: 'me', head: 'stable' });
  forge.data.repos['o/r'].protected = ['stable'];
  await refused(hubRules('review-own', 'pr-591'), hubPush([[hub.root, onMain, 'refs/heads/stable']]), hubCtx(), /refs\/heads\/stable: a protected branch is never pushed by a task/);
  // One the task created, protected since.
  await refused(hubRules('issues', 'issue-421'), hubPush([[hub.root, onMain, 'refs/heads/stable']]), hubCtx({ branches: ['refs/heads/stable'] }), /a protected branch is never pushed by a task/);
  forge.data.repos['o/r'].protected = [];
  assert.equal((await authorize(hubRules('review-own', 'pr-591'), hubPush([[hub.root, onMain, 'refs/heads/stable']]), hubCtx())).ok, true);

  // GitLab, where a merge request's source branch may be the default one just the same.
  forge.pull('group/sub/proj', { number: 7, author: 'me', head: 'main', base: 'release' });
  lab.at(lab.root);
  const labMain = lab.commit('straight to main', { 'src/a.js': 'main\n' });
  await refused(labRules('conflicts', 'pr-7'), labPush([[lab.root, labMain, 'refs/heads/main']]), labCtx(), /the default branch is never pushed by a task/);
  lab.set('stable', lab.root);
  forge.pull('group/sub/proj', { number: 8, author: 'me', head: 'stable' });
  forge.data.repos['group/sub/proj'].protected = ['stable'];
  await refused(labRules('review-own', 'pr-8'), labPush([[lab.root, labMain, 'refs/heads/stable']]), labCtx(), /a protected branch is never pushed by a task/);
  forge.data.repos['group/sub/proj'].protected = [];
  assert.equal((await authorize(labRules('review-own', 'pr-8'), labPush([[lab.root, labMain, 'refs/heads/stable']]), labCtx())).ok, true);
});

await check('a push goes to the pool\'s repository and to no other, a fork holding the pull request\'s branch included', async () => {
  const fork = repository('me/r', { id: 'R_fork', projectId: 12 });
  fork.at(fork.root);
  const forked = fork.commit('in the fork', { 'src/a.js': 'fork\n' });
  fork.set('forked', fork.root);
  forge.pull('o/r', { number: 581, author: 'me', head: 'forked', headRepo: 'me/r' });
  const toFork = pushRequest('github.com', '/me/r.git', fork.body([[fork.root, forked, 'refs/heads/forked']]));
  const advertise = { host: 'github.com', method: 'GET', path: '/me/r.git/info/refs?service=git-receive-pack', headers: {}, body: '' };
  for (const rules of [hubRules('conflicts', 'pr-581'), hubRules('review-own', 'pr-581'), hubRules('review-own', 'job-mine'), hubRules('conflicts', 'job-c')]) {
    await refused(rules, toFork, hubCtx(), /no rule of this task allows the request/);
    await refused(rules, advertise, hubCtx(), /no rule of this task allows the request/);
  }
  // A branch of that name in the pool's repository is not the pull request's head either.
  hub.at(hub.root);
  hub.set('forked', hub.root);
  await refused(hubRules('conflicts', 'pr-581'), hubPush([[hub.root, hub.commit('same name, here', { 'src/a.js': 'here\n' }), 'refs/heads/forked']]), hubCtx(), /does not hold the head branch of open pull request #581/);
  await refused(hubRules('conflicts', 'job-c'), hubPush([[hub.root, hub.commit('same name, here', { 'src/a.js': 'there\n' }), 'refs/heads/forked']]), hubCtx(), /no open pull request by me has its head branch here/);
  assert.equal(fork.tip('forked'), fork.root);
});

await check('a read stays inside the pool\'s repository: no other repository, project or cross-reference', async () => {
  const rules = hubRules('investigate', 'job-q');
  const ctx = hubCtx();
  for (const ok of ['/repos/o/r/compare/main...feature', '/repos/o/r/compare/main...feature/x', '/repos/o/r/compare/v1.0..main', '/repos/o/r/compare/abc123...def456?per_page=1',
    '/repos/o/r/issues/421', '/repos/o/r/issues/421/comments', '/repos/o/r/issues/421/events', '/repos/o/r/issues?creator=me', '/repos/o/r/pulls?head=someone:branch']) {
    assert.equal((await authorize(rules, gh('GET', ok), ctx)).ok, true, ok);
  }
  for (const [path, pattern] of [
    ['/repos/o/r/compare/main...someone:fork:branch', /names another repository/],
    ['/repos/o/r/compare/main...someone:branch', /names another repository/],
    ['/repos/o/r/compare/someone:main...feature', /names another repository/],
    ['/repos/o/r/compare/main...someone%3Abranch', /names another repository/],
    ['/repos/o/r/compare/main...feature/x:y', /names another repository/],
    ['/repos/o/r/issues/421/timeline', /other repositories/],
    ['/repos/o/r/issues/421/sub_issues', /other repositories/],
    ['/repos/o/r/issues/421/parent', /other repositories/],
    ['/repos/o/r/issues/421/dependencies/blocked_by', /other repositories/],
    ['/repos/o/r/assignees', /no rule/], ['/repos/o/r/assignees/bob', /no rule/], ['/repos/o/r/forks', /no rule/], ['/repos/o/r/collaborators', /no rule/],
  ]) await refused(rules, gh('GET', path), ctx, pattern);

  const onLab = labRules('investigate', 'job-q');
  for (const ok of [`${PROJECT}/repository/compare?from=main&to=feature`, `${PROJECT}/repository/compare?from=main&to=feature&straight=true&unidiff=true`, '/api/v4/projects/99/repository/compare?from=a&to=b',
    `${PROJECT}/repository/tree?path=src&ref=main`, `${PROJECT}/merge_requests/5/changes`, `${PROJECT}/issues/421/notes`]) {
    assert.equal((await authorize(onLab, glab('GET', ok), labCtx())).ok, true, ok);
  }
  for (const [path, pattern] of [
    [`${PROJECT}/repository/compare?from=main&to=feature&from_project_id=999`, /"from_project_id" is not part of this rule/],
    [`/api/v4/projects/99/repository/compare?from_project_id=999&from=main&to=x`, /"from_project_id" is not part of this rule/],
    [`${PROJECT}/repository/compare?from=main&to=feature&from_project_id%5B%5D=999`, /"from_project_id" is not part of this rule/],
    [`${PROJECT}/merge_requests/5/closes_issues`, /other projects/], [`${PROJECT}/merge_requests/5/related_issues`, /other projects/],
    [`${PROJECT}/issues/421/links`, /other projects/], [`${PROJECT}/issues/421/related_merge_requests`, /other projects/], [`${PROJECT}/issues/421/closed_by`, /other projects/],
    [`/api/v4/projects/99/issues/421/links`, /other projects/],
    [`${PROJECT}/issues/421/user_agent_detail`, /address/], [`${PROJECT}/merge_requests/5/merge_ref`, /writes/],
    [`${PROJECT}/forks`, /no rule/], [`${PROJECT}/members`, /no rule/],
  ]) await refused(onLab, glab('GET', path), labCtx(), pattern);
});

await check('the forge\'s answer about the repository itself comes back cut to what a job needs', async () => {
  for (const spelling of [PROJECT, '/api/v4/projects/99', `${PROJECT}?license=true`]) {
    const project = json(await sent(labRules('investigate', 'job-q'), glab('GET', spelling), labCtx(), GITLAB));
    assert.deepEqual(project, { id: 99, path_with_namespace: 'group/sub/proj', default_branch: 'main', web_url: `https://${GITLAB_HOST}/group/sub/proj`, merge_requests_enabled: true }, spelling);
  }
  const repo = json(await sent(hubRules('investigate', 'job-q'), gh('GET', '/repos/o/r'), hubCtx()));
  assert.deepEqual(Object.keys(repo).sort(), ['clone_url', 'default_branch', 'fork', 'full_name', 'html_url', 'id', 'name', 'node_id', 'owner', 'private', 'visibility']);
  for (const answer of [JSON.stringify(repo), JSON.stringify(json(await sent(labRules('review', 'pr-5'), glab('GET', PROJECT), labCtx(), GITLAB)))]) {
    for (const secret of ['TEMPCLONETOKEN', 'GR1348941runnerstoken', 'desk@example.com', 'user:pass', 'private-parent', 'permissions']) assert.ok(!answer.includes(secret), secret);
  }
});

await check('a GitLab issue task changes the assignees by its own account and nobody else', async () => {
  const rules = labRules('issues', 'issue-421');
  const put = (ids) => glab('PUT', `${PROJECT}/issues/421`, { assignee_ids: ids });
  forge.issue('group/sub/proj', { number: 421, author: 'reporter', assigneeIds: [8, 9] });
  for (const ids of [[], [0], [7], [8], [8, 7], [9, 7], [8, 9, 7, 10], 7, 0, ['7'], [8, 9, 7.5], [8, 9, -1], null, '8,9,7']) await refused(rules, put(ids), labCtx(), /only add or remove this task's own account|is not a list of account ids/);
  for (const ids of [[8, 9, 7], [7, 9, 8], [8, 9], [9, 8, 7, 7]]) assert.equal((await authorize(rules, put(ids), labCtx())).ok, true, JSON.stringify(ids));
  // Only itself assigned: it may step down, which is how glab spells "nobody".
  forge.issue('group/sub/proj', { number: 421, author: 'reporter', assigneeIds: [7] });
  for (const ids of [[0], [], [7]]) assert.equal((await authorize(rules, put(ids), labCtx())).ok, true, JSON.stringify(ids));
  await refused(rules, put([8]), labCtx(), /only add or remove this task's own account/);
  // Who is assigned must be known.
  for (const [status, body] of [[429, '{}'], [500, '{}'], [200, '{"iid":421}'], [200, '{"assignees":[{"username":"x"}]}']]) {
    const off = failing(GITLAB_HOST, /^\/api\/v4\/projects\/[^/]+\/issues\/421$/, status, body);
    await refused(rules, put([7]), labCtx(), /the forge did not say who is assigned to #421/);
    off();
  }
  const off = failing(GITLAB_HOST, /^\/api\/v4\/user$/, 429);
  await refused(rules, put([7]), labCtx(), /the forge did not say which account this is/);
  off();
});

await check('resolving a discussion must say so: a request with neither the query nor the body is not one', async () => {
  const rules = labRules('review-own', 'pr-5');
  forge.pull('group/sub/proj', { number: 5, author: 'me', head: 'feature' });
  const at = `${PROJECT}/merge_requests/5/discussions/abc`;
  await refused(rules, glab('PUT', at), labCtx(), /"resolved" is required/);
  await refused(rules, glab('PUT', at, {}), labCtx(), /"resolved" is required/);
  for (const request of [glab('PUT', `${at}?resolved=true`), glab('PUT', `${at}?resolved=true`, {}), glab('PUT', at, { resolved: true }), glab('PUT', at, { resolved: 'true' }), glab('PUT', `${at}?resolved=true`, { resolved: true })]) {
    assert.equal((await authorize(rules, request, labCtx())).ok, true, request.path);
  }
});

await check('CI definitions are out of a push\'s reach: every file of them, under any case, added, changed or deleted', async () => {
  const hubHead = () => { hub.at(hub.root); hub.set('feature', hub.root); forge.pull('o/r', { number: 579, author: 'me', head: 'feature' }); };
  hubHead();
  const own = hubRules('review-own', 'pr-579');
  const tryHub = async (message, files, pattern) => {
    hub.at(hub.root);
    await refused(own, hubPush([[hub.root, hub.commit(message, files), 'refs/heads/feature']]), hubCtx(), pattern);
  };
  await tryHub('add', { '.github/workflows/steal.yml': 'on: push\n' }, /changes \.github\/workflows\/steal\.yml/);
  await tryHub('another case', { '.GitHub/Workflows/steal.yml': 'on: push\n' }, /changes \.GitHub\/Workflows\/steal\.yml/);
  await tryHub('another case still', { '.GITHUB/workflows/steal.yml': 'on: push\n' }, /changes \.GITHUB\/workflows\/steal\.yml/);
  await tryHub('delete', { '.github/workflows/ci.yml': null }, /changes \.github\/workflows\/ci\.yml/);
  hub.at(hub.root);
  assert.equal((await authorize(own, hubPush([[hub.root, hub.commit('code', { 'src/a.js': 'b\n', '.github/dependabot.yml': 'x\n', '.gitlab-ci.yml': 'not CI here\n' }), 'refs/heads/feature']]), hubCtx())).ok, true);

  lab.set('feature', lab.root);
  forge.pull('group/sub/proj', { number: 5, author: 'me', head: 'feature' });
  const labOwn = labRules('review-own', 'pr-5');
  const tryLab = async (message, files, pattern) => {
    lab.at(lab.root);
    const request = labPush([[lab.root, lab.commit(message, files), 'refs/heads/feature']]);
    if (pattern) await refused(labOwn, request, labCtx(), pattern);
    else assert.equal((await authorize(labOwn, request, labCtx())).ok, true, message);
  };
  await tryLab('root file', { '.gitlab-ci.yml': 'evil: {}\n' }, /changes \.gitlab-ci\.yml/);
  await tryLab('root file, another case', { '.GitLab-CI.yml': 'evil: {}\n' }, /changes \.GitLab-CI\.yml/);
  await tryLab('included file', { '.gitlab/ci/build.yml': 'evil: {}\n' }, /changes \.gitlab\/ci\/build\.yml/);
  await tryLab('new included file', { '.gitlab/ci/deep/new.yml': 'evil: {}\n' }, /changes \.gitlab\/ci\/deep\/new\.yml/);
  await tryLab('delete the root file', { '.gitlab-ci.yml': null }, /changes \.gitlab-ci\.yml/);
  await tryLab('code', { 'src/a.js': 'b\n', 'ci/custom.yml': 'y: {}\n', '.gitlab/issue_templates/bug.md': 'x\n' });

  // The project reads its CI from a path of its own choosing.
  const repo = forge.data.repos['group/sub/proj'];
  repo.ciConfigPath = 'ci/custom.yml';
  await tryLab('the configured file', { 'ci/custom.yml': 'evil: {}\n' }, /changes ci\/custom\.yml/);
  await tryLab('the configured file, another case', { 'CI/Custom.yml': 'evil: {}\n' }, /changes CI\/Custom\.yml/);
  await tryLab('code', { 'src/a.js': 'c\n', 'ci/other.yml': 'y: {}\n' });
  // A file in this project named the way another project's is: ".gitlab-ci.yml@group/sub/proj" names ci/custom.yml here too.
  repo.ciConfigPath = 'ci/custom.yml@Group/Sub/Proj:main';
  await tryLab('the configured file, named with its project', { 'ci/custom.yml': 'evil: {}\n' }, /changes ci\/custom\.yml/);
  // Another project's file, or a URL: the forge reads a file of that literal name first when the repository has one.
  repo.ciConfigPath = 'ci/custom.yml@other/project';
  await tryLab('a file with the literal configured name', { 'ci/custom.yml@other/project': 'evil: {}\n' }, /changes ci\/custom\.yml@other\/project/);
  await tryLab('code', { 'ci/custom.yml': 'now only a file\n' });
  // The forge must say what the path is.
  for (const [status, body] of [[429, '{}'], [200, '{"id":99,"default_branch":"main"}'], [200, '{"id":99,"default_branch":"main","ci_config_path":7}']]) {
    const off = failing(GITLAB_HOST, /^\/api\/v4\/projects\/[^/]+$/, status, body);
    lab.at(lab.root);
    await refused(labOwn, labPush([[lab.root, lab.commit('code', { 'src/a.js': 'd\n' }), 'refs/heads/feature']]), labCtx(), /the forge did not say/);
    off();
  }
  repo.ciConfigPath = null;
});

await forge.close();
fs.rmSync(scratch, { recursive: true, force: true });
