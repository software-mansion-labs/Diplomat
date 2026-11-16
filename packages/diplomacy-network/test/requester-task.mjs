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
const { authorize, conclude } = await import('../src/requester/authorize.js');
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

// A fork of `origin` as an account holds it: the same history and branches of its own.
// What is pushed to it is committed in the origin's clone.
function forkOf(origin, name, more) {
  const bare = forge.bare(name, more);
  git(origin.work, 'push', '--quiet', bare, `${origin.root}:refs/heads/main`);
  const branches = () => git(bare, 'for-each-ref', '--format=%(objectname)', 'refs/heads').split('\n').filter(Boolean);
  return {
    bare,
    set: (branch, oid) => git(origin.work, 'push', '--quiet', '--force', bare, `${oid}:refs/heads/${branch}`),
    tip: (branch) => { try { return git(bare, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`); } catch { return null; } },
    /// The body of a push of `commands` with the pack a client would send: whatever no branch of the fork holds.
    body: (commands) => pushBody(commands, packOf(origin.work, commands.map((c) => c[1]).filter((oid) => oid !== ZERO), branches())),
  };
}

const hub = repository('o/r', { projectId: 11 });
const lab = repository('group/sub/proj', { id: 'R_2', projectId: 99 });
// The task account's own fork of each, another account's fork, and a repository of the
// task's account that is a fork of something else.
const hubFork = forkOf(hub, 'me/r', { id: 'R_fork', projectId: 12, parent: 'o/r' });
const hubTheirs = forkOf(hub, 'them/r', { id: 'R_theirs', projectId: 14, parent: 'o/r' });
forkOf(hub, 'me/elsewhere', { id: 'R_else', projectId: 15, parent: 'someone/else' });
const labFork = forkOf(lab, 'me/proj', { id: 'R_labfork', projectId: 13, parent: 'group/sub/proj' });
forkOf(lab, 'them/proj', { id: 'R_labtheirs', projectId: 16, parent: 'group/sub/proj' });
forkOf(lab, 'me/other', { id: 'R_labelse', projectId: 17, parent: 'someone/else' });
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

await check('a creation is counted while its answer is out, and one whose answer never comes is settled by what the forge shows', async () => {
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
  const unanswered = async (ref) => {
    const state = {};
    const off = forge.route('github.com', 'POST', /git-receive-pack$/, (req, res) => res.destroy());
    const verdict = await authorize(rules, hubPush([[ZERO, fix, ref]]), hubCtx(state));
    await assert.rejects(client.perform(verdict.request, GITHUB), /unreachable/);
    off();
    assert.deepEqual([state.branches, state.reserved, state.sent], [[], [ref], { [ref]: fix }]);
    return state;
  };
  const used = (state) => [state.branches, state.reserved, state.sent];
  const draft = (head) => gh('POST', '/repos/o/r/pulls', { title: 't', head, base: 'main', draft: true });
  const more = hub.commit('racing on', { 'src/race.js': 's\n' });
  // The forge is asked before the task's next push or pull request is judged. It has no
  // such branch: nothing to open a pull request from, and the allowance is free again.
  const lost = await unanswered('refs/heads/lost');
  await refused(rules, draft('lost'), hubCtx(lost), /only be opened from a branch this task pushed/);
  assert.deepEqual(used(lost), [[], [], {}]);
  assert.match((await sent(rules, hubPush([[ZERO, fix, 'refs/heads/lost']]), hubCtx(await unanswered('refs/heads/lost')))).bytes.toString('latin1'), /ok refs\/heads\/lost/);
  // The push had reached the forge after all: the branch is where it was sent, and the task's own.
  for (const next of [hubPush([[fix, more, 'refs/heads/landed']]), draft('landed')]) {
    const landed = await unanswered('refs/heads/landed');
    hub.set('landed', fix);
    assert.ok((await sent(rules, next, hubCtx(landed))).status < 300);
    assert.deepEqual(used(landed), [['refs/heads/landed'], [], {}]);
    await refused(rules, hubPush([[ZERO, fix, 'refs/heads/other']]), hubCtx(landed), /may create 1 branch\(es\); it has refs\/heads\/landed/);
    git(hub.bare, 'update-ref', '-d', 'refs/heads/landed');
  }
  // Somebody's branch of that name, at another commit, is not the task's; it stays counted.
  const taken = await unanswered('refs/heads/taken');
  hub.set('taken', hub.root);
  await refused(rules, hubPush([[hub.root, fix, 'refs/heads/taken']]), hubCtx(taken), /may not update that ref/);
  await refused(rules, draft('taken'), hubCtx(taken), /only be opened from a branch this task pushed/);
  await refused(rules, hubPush([[ZERO, fix, 'refs/heads/other']]), hubCtx(taken), /may create 1 branch\(es\); it has refs\/heads\/taken/);
  // A forge that does not say where the branch is has not said it is gone.
  const off = failing('api.github.com', /^\/repos\/o\/r\/branches\/taken$/, 503);
  await refused(rules, hubPush([[ZERO, fix, 'refs/heads/other']]), hubCtx(taken), /the forge did not say where refs\/heads\/taken is/);
  await refused(rules, draft('taken'), hubCtx(taken), /the forge did not say where refs\/heads\/taken is/);
  off();
  assert.deepEqual(used(taken), [[], ['refs/heads/taken'], { 'refs/heads/taken': fix }]);

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
  assert.deepEqual([viaGraphql.pulls, viaGraphql.asked], [[], []], 'given back by the answer itself');
  await sent(rules, ghql(GH.prCreate), hubCtx(viaGraphql));
  assert.deepEqual(viaGraphql.pulls, ['fix-421']);
  await refused(rules, open('main'), hubCtx(viaGraphql), /has opened its pull request from fix-421/);

  // GitLab: the same, through its own route.
  const merge = { title: 'Draft: t', source_branch: 'fix-421', target_branch: 'main', target_project_id: 99 };
  const onLab = { branches: ['refs/heads/fix-421'] };
  assert.equal((await sent(labRules('issues', 'issue-421'), glab('POST', `${PROJECT}/merge_requests`, merge), labCtx(onLab), GITLAB)).status, 201);
  await refused(labRules('issues', 'issue-421'), glab('POST', `${PROJECT}/merge_requests`, { ...merge, target_branch: 'release' }), labCtx(onLab), /has opened its pull request from fix-421/);

  // An answer that never came, or that does not say: the forge is asked at the next try
  // whether it shows a pull request from the branch.
  const used = (state) => [state.pulls, state.asked];
  const from = (branch) => gh('POST', '/repos/o/r/pulls', { title: 't', head: branch, base: 'main', draft: true });
  const cut = (host, pattern) => forge.route(host, 'POST', pattern, (req, res) => res.destroy());
  const unsure = { branches: ['refs/heads/fix-900', 'refs/heads/fix-901'] };
  off = cut('api.github.com', /^\/repos\/o\/r\/pulls$/);
  await assert.rejects(client.perform((await authorize(rules, from('fix-900'), hubCtx(unsure))).request, GITHUB), /unreachable/);
  off();
  assert.deepEqual(used(unsure), [[], ['fix-900']]);
  // It shows none: the pull request is still the task's to open.
  off = forge.route('api.github.com', 'POST', /^\/repos\/o\/r\/pulls$/, (req, res) => res.writeHead(502).end('bad gateway'));
  assert.equal((await sent(rules, from('fix-900'), hubCtx(unsure))).status, 502);
  off();
  assert.deepEqual(used(unsure), [[], ['fix-900']]);
  // It shows one, closed since: that is the task's one. One from another branch says nothing of this branch.
  forge.pull('o/r', { number: 701, author: 'me', head: 'fix-901', state: 'closed' });
  const silent = failing('api.github.com', /^\/repos\/o\/r\/pulls\?/, 503);
  await refused(rules, from('fix-900'), hubCtx(unsure), /the forge did not say which pull requests there are/);
  silent();
  assert.deepEqual(used(unsure), [[], ['fix-900']]);
  conclude((await authorize(rules, from('fix-901'), hubCtx(unsure))).request, undefined);
  assert.equal((await sent(rules, from('fix-900'), hubCtx(unsure))).status, 201);
  await refused(rules, from('fix-901'), hubCtx(unsure), /has opened its pull request from fix-901/);
  assert.deepEqual(used(unsure), [['fix-901', 'fix-900'], []]);

  // A GraphQL answer that says neither "opened" nor "refused" is no answer.
  const vague = { branches: ['refs/heads/fix-421'] };
  for (const said of ['{"data":{"createPullRequest":null}}', '{"data":{}}', 'not json', '{"data":{"a":{"pullRequest":{"number":1}},"b":null},"errors":[{"message":"x"}]}']) {
    off = forge.route('api.github.com', 'POST', /^\/graphql$/, (req, res, body) => {
      res.writeHead(200, { 'content-type': 'application/json' }).end(body.toString().includes('createPullRequest') ? said : '{"data":{"node":{"__typename":"Repository","nameWithOwner":"o/r"}}}');
    });
    await sent(rules, ghql(GH.prCreate), hubCtx(vague));
    off();
    assert.deepEqual(used(vague), [[], ['fix-421']], said);
  }
  await sent(rules, ghql(GH.prCreate), hubCtx(vague));
  assert.deepEqual(used(vague), [['fix-421'], []]);

  // GitLab: a merge request the forge shows from the branch, merged since, is the task's one.
  const labUnsure = { branches: ['refs/heads/fix-900', 'refs/heads/fix-901'] };
  const labFrom = (branch) => glab('POST', `${PROJECT}/merge_requests`, { ...merge, source_branch: branch });
  for (const branch of ['fix-900', 'fix-901']) {
    off = cut(GITLAB_HOST, /merge_requests$/);
    await assert.rejects(client.perform((await authorize(labRules('issues', 'issue-421'), labFrom(branch), labCtx(labUnsure))).request, GITLAB), /unreachable/);
    off();
  }
  forge.pull('group/sub/proj', { number: 702, author: 'me', head: 'fix-901', state: 'merged' });
  assert.equal((await sent(labRules('issues', 'issue-421'), labFrom('fix-900'), labCtx(labUnsure), GITLAB)).status, 201);
  await refused(labRules('issues', 'issue-421'), labFrom('fix-901'), labCtx(labUnsure), /has opened its pull request from fix-901/);
  assert.deepEqual(used(labUnsure), [['fix-901', 'fix-900'], []]);
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

const advertiseAt = (host, repoPath) => ({ host, method: 'GET', path: `${repoPath}/info/refs?service=git-receive-pack`, headers: {}, body: '' });
const NOT_THE_FORK = /is not this account's own fork of the pool's repository/;

await check('a pull request\'s head branch is pushed where it lives: in the pool\'s repository, or in the task account\'s own fork of it and in no other', async () => {
  const toFork = (commands, at = '/me/r.git') => pushRequest('github.com', at, hubFork.body(commands));
  hub.at(hub.root);
  const base = hub.commit('the pull request', { 'src/pr.js': '1\n' });
  hubFork.set('forked', base);
  forge.pull('o/r', { number: 581, author: 'me', head: 'forked', headRepo: 'me/r' });
  const more = hub.commit('more work', { 'src/pr.js': '2\n' });
  const move = toFork([[base, more, 'refs/heads/forked']]);
  const pushing = [hubRules('conflicts', 'pr-581'), hubRules('review-own', 'pr-581'), hubRules('review-own', 'job-mine'), hubRules('conflicts', 'job-c')];
  for (const rules of pushing) {
    for (const request of [advertiseAt('github.com', '/me/r.git'), advertiseAt('github.com', '/me/r'), move]) assert.equal((await authorize(rules, request, hubCtx())).ok, true, request.path.slice(0, 60));
  }
  for (const rules of [hubRules('review', 'pr-581'), hubRules('investigate', 'job-q'), hubRules('issues', 'issue-421', { noPRs: true }), hubRules('audit', 'job-a', { readOnly: true })]) {
    await refused(rules, move, hubCtx(), /no rule of this task allows the request/);
    await refused(rules, advertiseAt('github.com', '/me/r.git'), hubCtx(), /no rule of this task allows the request/);
  }
  // The proof is fetched from the fork and from the pool's repository, and from nowhere else.
  const heard = forge.log.length;
  assert.match((await sent(pushing[0], move, hubCtx())).bytes.toString('latin1'), /ok refs\/heads\/forked/);
  assert.equal(hubFork.tip('forked'), more);
  assert.equal(hub.tip('forked'), null);
  assert.deepEqual([...new Set(forge.log.slice(heard).filter((r) => r.host === 'github.com' && r.path.includes('upload-pack')).map((r) => r.path.split('.git/')[0]))].sort(), ['/me/r', '/o/r']);

  // The forge spells an account its own way; the task's account is that account in any letter case.
  const next = hub.commit('still more', { 'src/pr.js': '3\n' });
  const forward = toFork([[more, next, 'refs/heads/forked']]);
  forge.data.repos['me/r'].spelled = 'Me/R';
  assert.equal((await authorize(pushing[1], toFork([[more, next, 'refs/heads/forked']], '/ME/r.git'), hubCtx())).ok, true);
  assert.equal((await authorize(pushing[2], advertiseAt('github.com', '/Me/R'), hubCtx())).ok, true);
  delete forge.data.repos['me/r'].spelled;

  // Another account's fork: no rule reaches it, and its branch is not the task account's.
  hubTheirs.set('theirs', base);
  hubFork.set('theirs', base);
  forge.pull('o/r', { number: 582, author: 'them', head: 'theirs', headRepo: 'them/r' });
  for (const rules of [hubRules('conflicts', 'pr-582'), hubRules('conflicts', 'job-c', { author: 'them' })]) {
    await refused(rules, pushRequest('github.com', '/them/r.git', hubTheirs.body([[base, more, 'refs/heads/theirs']])), hubCtx(), /no rule of this task allows the request/);
    await refused(rules, advertiseAt('github.com', '/them/r.git'), hubCtx(), /no rule of this task allows the request/);
    await refused(rules, toFork([[base, more, 'refs/heads/theirs']]), hubCtx(), /does not hold the head branch of open pull request #582|no open pull request by them has its head branch here/);
  }
  // A repository of the account that is a fork of something else, one that is no fork, and no repository at all: one answer.
  forge.pull('o/r', { number: 583, author: 'me', head: 'forked', headRepo: 'me/elsewhere' });
  const elsewhere = pushRequest('github.com', '/me/elsewhere.git', hubFork.body([[more, next, 'refs/heads/forked']]));
  await refused(hubRules('conflicts', 'pr-583'), elsewhere, hubCtx(), NOT_THE_FORK);
  await refused(hubRules('conflicts', 'pr-583'), advertiseAt('github.com', '/me/elsewhere.git'), hubCtx(), NOT_THE_FORK);
  forge.data.repos['me/elsewhere'].parent = null;
  await refused(hubRules('conflicts', 'pr-583'), elsewhere, hubCtx(), NOT_THE_FORK);
  forge.data.repos['me/elsewhere'].parent = 'someone/else';
  await refused(hubRules('conflicts', 'pr-583'), pushRequest('github.com', '/me/nothing.git', hubFork.body([[more, next, 'refs/heads/forked']])), hubCtx(), NOT_THE_FORK);
  await refused(hubRules('conflicts', 'pr-583'), advertiseAt('github.com', '/me/nothing'), hubCtx(), NOT_THE_FORK);

  // The pull request is the task's, open, and its head is in that fork still.
  await refused(hubRules('conflicts', 'pr-578'), forward, hubCtx(), /does not hold the head branch of open pull request #578/);
  await refused(hubRules('conflicts', 'pr-583'), forward, hubCtx(), /does not hold the head branch of open pull request #583/);
  forge.pull('o/r', { number: 581, author: 'me', head: 'forked', headRepo: 'me/r', state: 'closed' });
  await refused(pushing[0], forward, hubCtx(), /does not hold the head branch of open pull request #581/);
  await refused(pushing[2], forward, hubCtx(), /no open pull request by me has its head branch here/);
  forge.pull('o/r', { number: 581, author: 'me', head: 'forked', headRepo: null });
  await refused(pushing[0], forward, hubCtx(), /does not hold the head branch of open pull request #581/);
  forge.pull('o/r', { number: 581, author: 'me', head: 'forked', headRepo: 'me/r' });

  // Exactly the head branch, moved forward: no other branch of the fork, no new one, no deletion, no way back.
  await refused(pushing[0], toFork([[more, next, 'refs/heads/forked'], [base, next, 'refs/heads/theirs']]), hubCtx(), /refs\/heads\/theirs: this task may not update that ref/);
  await refused(pushing[0], toFork([[more, next, 'refs/heads/forked'], [ZERO, next, 'refs/heads/new']]), hubCtx(), /refs\/heads\/new: this task may not create that ref/);
  await refused(pushing[0], toFork([[more, ZERO, 'refs/heads/forked']]), hubCtx(), /may not delete a ref/);
  await refused(pushing[0], toFork([[base, next, 'refs/heads/forked']]), hubCtx(), /not where this push starts from/);
  hub.at(base);
  await refused(pushing[0], toFork([[more, hub.commit('rewritten', { 'src/pr.js': 'other\n' }), 'refs/heads/forked']]), hubCtx(), /not a fast-forward/);
  hub.at(more);
  await refused(pushing[0], toFork([[more, hub.commit('a workflow', { '.github/workflows/steal.yml': 'on: push\n' }), 'refs/heads/forked']]), hubCtx(), /changes \.github\/workflows\/steal\.yml/);

  // Never the fork's default branch or a protected one of the fork's.
  forge.data.repos['me/r'].defaultBranch = 'forked';
  await refused(pushing[0], forward, hubCtx(), /refs\/heads\/forked: the default branch is never pushed by a task/);
  delete forge.data.repos['me/r'].defaultBranch;
  forge.pull('o/r', { number: 584, author: 'me', head: 'main', headRepo: 'me/r' });
  hub.at(hub.root);
  await refused(hubRules('conflicts', 'pr-584'), toFork([[hub.root, hub.commit('to the fork\'s main', { 'src/a.js': 'fork\n' }), 'refs/heads/main']]), hubCtx(), /refs\/heads\/main: the default branch is never pushed by a task/);
  forge.data.repos['me/r'].protected = ['forked'];
  await refused(pushing[0], forward, hubCtx(), /refs\/heads\/forked: a protected branch is never pushed by a task/);
  forge.data.repos['me/r'].protected = [];

  // Each of these is the forge's word: when it does not say, nothing is pushed.
  for (const [rules, pattern] of [[pushing[0], /^\/repos\/me\/r$/], [pushing[0], /^\/repos\/o\/r\/pulls\/581$/], [pushing[2], /^\/repos\/o\/r\/pulls\?/], [pushing[0], /^\/repos\/me\/r\/branches\/forked$/], [pushing[0], /^\/repos\/o\/r$/]]) {
    for (const status of [429, 500]) {
      const off = failing('api.github.com', pattern, status);
      await refused(rules, forward, hubCtx(), /the forge did not say/);
      off();
    }
  }
  const off = forge.route('github.com', 'GET', /^\/me\/r\.git\/info\/refs/, (req, res) => res.writeHead(500).end());
  await refused(pushing[0], forward, hubCtx(), /old value cannot be found/);
  off();

  // The repository's base branch moved on, its workflow with it, and the fork's copy of it did not: a merge of it brings
  // those commits along in the pack, and they are the repository's own.
  hub.at(hub.root);
  const upstream = hub.commit('base moves on', { '.github/workflows/ci.yml': 'on: [push, pull_request]\n', 'src/base.js': 'm\n' });
  hub.set('main', upstream);
  hub.at(more);
  git(hub.work, 'merge', '--quiet', '--no-edit', upstream);
  assert.equal((await authorize(pushing[0], toFork([[more, git(hub.work, 'rev-parse', 'HEAD'), 'refs/heads/forked']]), hubCtx())).ok, true);
  // Settled to what neither side holds, the workflow is the task's own change.
  hub.at(more);
  git(hub.work, 'merge', '--quiet', '--no-commit', '--no-ff', upstream);
  await refused(pushing[0], toFork([[more, hub.commit('settled badly', { '.github/workflows/ci.yml': 'on: push\njobs: { leak: {} }\n' }), 'refs/heads/forked']]), hubCtx(), /changes \.github\/workflows\/ci\.yml/);
  hub.set('main', hub.root);

  // A branch of the head's name in the pool's repository is not the pull request's head.
  hub.at(hub.root);
  hub.set('forked', hub.root);
  await refused(pushing[0], hubPush([[hub.root, hub.commit('same name, here', { 'src/a.js': 'here\n' }), 'refs/heads/forked']]), hubCtx(), /does not hold the head branch of open pull request #581/);
  await refused(pushing[3], hubPush([[hub.root, hub.commit('same name, here', { 'src/a.js': 'there\n' }), 'refs/heads/forked']]), hubCtx(), /no open pull request by me has its head branch here/);
  assert.equal(hubFork.tip('forked'), more);
});

await check('GitLab: a merge request from the task account\'s own fork is pushed in the fork, under the same checks', async () => {
  const toFork = (commands, at = '/me/proj.git') => pushRequest(GITLAB_HOST, at, labFork.body(commands));
  lab.at(lab.root);
  const base = lab.commit('the merge request', { 'src/mr.js': '1\n' });
  labFork.set('forked', base);
  forge.pull('group/sub/proj', { number: 9, author: 'me', head: 'forked', headRepo: 'me/proj' });
  const more = lab.commit('more work', { 'src/mr.js': '2\n' });
  const move = toFork([[base, more, 'refs/heads/forked']]);
  const pushing = [labRules('conflicts', 'pr-9'), labRules('review-own', 'pr-9'), labRules('review-own', 'job-mine')];
  for (const rules of pushing) {
    for (const request of [advertiseAt(GITLAB_HOST, '/me/proj.git'), advertiseAt(GITLAB_HOST, '/Me/proj'), move]) assert.equal((await authorize(rules, request, labCtx())).ok, true, request.path.slice(0, 60));
  }
  assert.match((await sent(pushing[0], move, labCtx(), GITLAB)).bytes.toString('latin1'), /ok refs\/heads\/forked/);
  assert.equal(labFork.tip('forked'), more);
  assert.equal(lab.tip('forked'), null);
  const next = lab.commit('still more', { 'src/mr.js': '3\n' });
  const forward = toFork([[more, next, 'refs/heads/forked']]);

  // Another account's fork and a group's: no rule. A project of the account that is no fork of the pool's: not the fork.
  for (const elsewhere of ['/them/proj.git', '/group/me/proj.git', '/me/sub/proj.git']) {
    await refused(pushing[0], toFork([[more, next, 'refs/heads/forked']], elsewhere), labCtx(), /no rule of this task allows the request/);
    await refused(pushing[0], advertiseAt(GITLAB_HOST, elsewhere), labCtx(), /no rule of this task allows the request/);
  }
  forge.pull('group/sub/proj', { number: 10, author: 'me', head: 'forked', headRepo: 'me/other' });
  await refused(labRules('conflicts', 'pr-10'), toFork([[more, next, 'refs/heads/forked']], '/me/other.git'), labCtx(), NOT_THE_FORK);
  await refused(labRules('conflicts', 'pr-10'), toFork([[more, next, 'refs/heads/forked']], '/me/nothing.git'), labCtx(), NOT_THE_FORK);
  await refused(labRules('conflicts', 'pr-10'), forward, labCtx(), /does not hold the head branch of open pull request #10/);
  // A merge request whose source branch is in the pool's project is not pushed in the fork.
  forge.pull('group/sub/proj', { number: 11, author: 'me', head: 'forked' });
  await refused(labRules('conflicts', 'pr-11'), forward, labCtx(), /does not hold the head branch of open pull request #11/);

  lab.at(base);
  await refused(pushing[0], toFork([[more, lab.commit('rewritten', { 'src/mr.js': 'other\n' }), 'refs/heads/forked']]), labCtx(), /not a fast-forward/);
  await refused(pushing[0], toFork([[more, next, 'refs/heads/forked'], [ZERO, next, 'refs/heads/new']]), labCtx(), /refs\/heads\/new: this task may not create that ref/);
  for (const [files, pattern] of [[{ '.gitlab-ci.yml': 'evil: {}\n' }, /changes \.gitlab-ci\.yml/], [{ '.gitlab/ci/build.yml': 'evil: {}\n' }, /changes \.gitlab\/ci\/build\.yml/]]) {
    lab.at(more);
    await refused(pushing[0], toFork([[more, lab.commit('ci', files), 'refs/heads/forked']]), labCtx(), pattern);
  }
  // The file either project is set to read its CI from: a pipeline for the merge request can run in the pool's project
  // as well as in the fork.
  lab.at(more);
  const custom = toFork([[more, lab.commit('the configured file', { 'ci/custom.yml': 'evil: {}\n' }), 'refs/heads/forked']]);
  assert.equal((await authorize(pushing[0], custom, labCtx())).ok, true);
  for (const project of ['group/sub/proj', 'me/proj']) {
    forge.data.repos[project].ciConfigPath = 'ci/custom.yml';
    await refused(pushing[0], custom, labCtx(), /changes ci\/custom\.yml/);
    forge.data.repos[project].ciConfigPath = null;
  }
  forge.data.repos['me/proj'].defaultBranch = 'forked';
  await refused(pushing[0], forward, labCtx(), /refs\/heads\/forked: the default branch is never pushed by a task/);
  delete forge.data.repos['me/proj'].defaultBranch;
  forge.data.repos['me/proj'].protected = ['forked'];
  await refused(pushing[0], forward, labCtx(), /refs\/heads\/forked: a protected branch is never pushed by a task/);
  forge.data.repos['me/proj'].protected = [];
  for (const [rules, pattern] of [[pushing[0], /^\/api\/v4\/projects\/me%2Fproj$/], [pushing[0], /\/merge_requests\/9$/], [pushing[2], /\/merge_requests\?/], [pushing[0], /^\/api\/v4\/projects\/me%2Fproj\/repository\/branches\/forked$/], [pushing[0], /^\/api\/v4\/projects\/group%2Fsub%2Fproj$/]]) {
    const off = failing(GITLAB_HOST, pattern, 429);
    await refused(rules, forward, labCtx(), /the forge did not say/);
    off();
  }
  assert.equal((await authorize(pushing[2], forward, labCtx())).ok, true);
});

await check('the one new branch of a task may be made in the task account\'s own fork, and its draft pull request opened from there', async () => {
  const toFork = (commands, at = '/me/r.git') => pushRequest('github.com', at, hubFork.body(commands));
  const rules = hubRules('issues', 'issue-421');
  const state = {};
  hub.at(hub.root);
  const fix = hub.commit('fix, in the fork', { 'src/forkfix.js': '1\n' });
  for (const request of [advertiseAt('github.com', '/me/r.git'), toFork([[ZERO, fix, 'refs/heads/fork-fix']])]) assert.equal((await authorize(rules, request, hubCtx({}))).ok, true);
  assert.match((await sent(rules, toFork([[ZERO, fix, 'refs/heads/fork-fix']]), hubCtx(state))).bytes.toString('latin1'), /ok refs\/heads\/fork-fix/);
  assert.equal(hubFork.tip('fork-fix'), fix);
  assert.equal(hub.tip('fork-fix'), null);
  assert.deepEqual([state.branches, state.reserved], [['me/r:refs/heads/fork-fix'], []]);
  // It was the one branch, wherever the next would be.
  await refused(rules, hubPush([[ZERO, fix, 'refs/heads/second']]), hubCtx(state), /may create 1 branch\(es\); it has me\/r:refs\/heads\/fork-fix/);
  await refused(rules, toFork([[ZERO, fix, 'refs/heads/second']]), hubCtx(state), /may create 1 branch\(es\)/);
  // It moves forward in the fork. A branch of its name in the pool's repository is somebody's, and so is one in the
  // fork to a task whose own branch is in the pool's repository.
  const more = hub.commit('more', { 'src/forkfix.js': '2\n' });
  await sent(rules, toFork([[fix, more, 'refs/heads/fork-fix']]), hubCtx(state));
  assert.equal(hubFork.tip('fork-fix'), more);
  hub.set('fork-fix', fix);
  await refused(rules, hubPush([[fix, more, 'refs/heads/fork-fix']]), hubCtx(state), /refs\/heads\/fork-fix: this task may not update that ref/);
  const further = hub.commit('further', { 'src/forkfix.js': '3\n' });
  await refused(rules, toFork([[more, further, 'refs/heads/fork-fix']]), hubCtx({ branches: ['refs/heads/fork-fix'] }), /refs\/heads\/fork-fix: this task may not update that ref/);
  await refused(rules, toFork([[more, further, 'refs/heads/fork-fix']]), hubCtx({ branches: ['them/r:refs/heads/fork-fix'] }), /refs\/heads\/fork-fix: this task may not update that ref/);

  // Its pull request is opened in the pool's repository from "account:branch", once.
  const open = (head) => gh('POST', '/repos/o/r/pulls', { title: 't', head, base: 'main', draft: true });
  const mine = /a pull request may only be opened from a branch this task pushed/;
  for (const head of ['fork-fix', 'them:fork-fix', 'me:second', 'x:me:fork-fix', 'me:r:fork-fix', 'me:fork-fix:x', ':fork-fix', 'me:', 'me/r:fork-fix']) await refused(rules, open(head), hubCtx(state), mine);
  await refused(rules, gh('POST', '/repos/o/r/pulls', { title: 't', head: 'me:fork-fix', head_repo: 'r', base: 'main', draft: true }), hubCtx(state), /"head_repo" is not part of this rule/);
  await refused(rules, open('me:fork-fix'), hubCtx({ branches: ['refs/heads/fork-fix'] }), mine);
  assert.equal((await sent(rules, open('Me:fork-fix'), hubCtx(state))).status, 201);
  assert.deepEqual(state.pulls, ['me/r:fork-fix']);
  await refused(rules, open('me:fork-fix'), hubCtx(state), /has opened its pull request from me\/r:fork-fix/);
  const viaGraphql = (head) => ghql({ ...GH.prCreate, variables: { input: { ...GH.prCreate.variables.input, headRefName: head } } });
  await refused(rules, viaGraphql('me:fork-fix'), hubCtx(state), /has opened its pull request from me\/r:fork-fix/);
  const fresh = { branches: ['me/r:refs/heads/fork-fix'] };
  for (const head of ['fork-fix', 'them:fork-fix', 'a:me:fork-fix']) await refused(rules, viaGraphql(head), hubCtx(fresh), mine);
  const asked = await authorize(rules, viaGraphql('me:fork-fix'), hubCtx(fresh));
  assert.equal(asked.ok, true);
  assert.deepEqual(fresh.asked, ['me/r:fork-fix']);
  // No answer came: a pull request the forge shows from the fork's branch is the task's
  // one, and one from the pool's own branch of that name is not.
  conclude(asked.request, undefined);
  forge.pull('o/r', { number: 704, author: 'them', head: 'fork-fix', state: 'closed' });
  assert.equal((await sent(rules, open('me:fork-fix'), hubCtx(fresh))).status, 201);
  fresh.pulls = [];
  fresh.asked = ['me/r:fork-fix'];
  forge.pull('o/r', { number: 703, author: 'me', head: 'fork-fix', headRepo: 'me/r', state: 'closed' });
  await refused(rules, open('me:fork-fix'), hubCtx(fresh), /has opened its pull request from me\/r:fork-fix/);
  assert.deepEqual([fresh.pulls, fresh.asked], [['me/r:fork-fix'], []]);

  // The fork is the forge's word, and only the account's own fork of this repository is one.
  hub.at(hub.root);
  const other = hub.commit('another', { 'src/another.js': '1\n' });
  const create = (at) => toFork([[ZERO, other, 'refs/heads/another']], at);
  await refused(rules, create('/them/r.git'), hubCtx({}), /no rule of this task allows the request/);
  for (const at of ['/me/elsewhere.git', '/me/nothing.git']) {
    await refused(rules, create(at), hubCtx({}), NOT_THE_FORK);
    await refused(rules, advertiseAt('github.com', at), hubCtx({}), NOT_THE_FORK);
  }
  for (const pattern of [/^\/repos\/me\/r$/, /^\/repos\/me\/r\/branches\/another$/, /^\/repos\/o\/r$/]) {
    const silent = {};
    const off = failing('api.github.com', pattern, 429);
    await refused(rules, create(), hubCtx(silent), /the forge did not say/);
    off();
    assert.deepEqual(silent.reserved ?? [], [], 'nothing was counted');
  }
  // What a new branch may not be in the pool's repository, it may not be in the fork.
  forge.data.repos['me/r'].defaultBranch = 'another';
  await refused(rules, create(), hubCtx({}), /refs\/heads\/another: the default branch is never pushed by a task/);
  delete forge.data.repos['me/r'].defaultBranch;
  hubFork.set('another', hub.root);
  await refused(rules, create(), hubCtx({}), /not where this push starts from/);
  hub.at(hub.root);
  await refused(rules, toFork([[ZERO, hub.commit('a workflow', { '.github/workflows/steal.yml': 'on: push\n' }), 'refs/heads/workflow']]), hubCtx({}), /changes \.github\/workflows\/steal\.yml/);
  // An audit's branches are counted together, wherever each is.
  const audit = { branches: Array.from({ length: 24 }, (_, i) => (i < 12 ? `refs/heads/a${i}` : `me/r:refs/heads/b${i}`)) };
  await refused(hubRules('audit', 'job-a'), toFork([[ZERO, other, 'refs/heads/one-more']]), hubCtx(audit), /may create 24 branch\(es\)/);
  audit.branches.pop();
  assert.equal((await authorize(hubRules('audit', 'job-a'), toFork([[ZERO, other, 'refs/heads/one-more']]), hubCtx(audit))).ok, true);

  // GitLab: the branch in the fork's project, the merge request opened on that project with the pool's as its target.
  const labIssue = labRules('issues', 'issue-421');
  const onLab = {};
  lab.at(lab.root);
  const labFix = lab.commit('fix, in the fork', { 'src/forkfix.js': '1\n' });
  const toLabFork = (commands, at = '/me/proj.git') => pushRequest(GITLAB_HOST, at, labFork.body(commands));
  assert.match((await sent(labIssue, toLabFork([[ZERO, labFix, 'refs/heads/fork-fix']]), labCtx(onLab), GITLAB)).bytes.toString('latin1'), /ok refs\/heads\/fork-fix/);
  assert.deepEqual(onLab.branches, ['me/proj:refs/heads/fork-fix']);
  assert.equal(lab.tip('fork-fix'), null);
  await refused(labIssue, toLabFork([[ZERO, labFix, 'refs/heads/another']], '/me/other.git'), labCtx({}), NOT_THE_FORK);
  await refused(labIssue, toLabFork([[ZERO, labFix, 'refs/heads/another']], '/them/proj.git'), labCtx({}), /no rule of this task allows the request/);
  const merge = { title: 'Draft: t', source_branch: 'fork-fix', target_branch: 'main', target_project_id: 99 };
  const FORK_PROJECT = '/api/v4/projects/me%2Fproj';
  const request = (project, body) => glab('POST', `${project}/merge_requests`, body);
  // On the pool's project the source branch is one of the pool's project, and the task made none there.
  await refused(labIssue, request(PROJECT, merge), labCtx(onLab), mine);
  // On any other project than the account's fork of the pool's: nothing, in one answer.
  for (const project of ['/api/v4/projects/them%2Fproj', '/api/v4/projects/me%2Fother', '/api/v4/projects/me%2Fnothing', '/api/v4/projects/16', '/api/v4/projects/17', '/api/v4/projects/4242']) {
    await refused(labIssue, request(project, merge), labCtx({ branches: ['them/proj:refs/heads/fork-fix', 'me/other:refs/heads/fork-fix'] }), NOT_THE_FORK);
  }
  // Its target is the pool's project, it is a draft, and its source is the branch the task made in that fork.
  await refused(labIssue, request(FORK_PROJECT, { ...merge, target_project_id: undefined }), labCtx(onLab), /"target_project_id" is required/);
  await refused(labIssue, request(FORK_PROJECT, { ...merge, target_project_id: 13 }), labCtx(onLab), /"target_project_id" has a value this task may not use/);
  await refused(labIssue, request(FORK_PROJECT, { ...merge, title: 't' }), labCtx(onLab), /must start with "Draft:"/);
  await refused(labIssue, request(FORK_PROJECT, { ...merge, source_branch: 'main' }), labCtx(onLab), mine);
  await refused(labIssue, request(FORK_PROJECT, merge), labCtx({ branches: ['refs/heads/fork-fix'] }), mine);
  const off = failing(GITLAB_HOST, /^\/api\/v4\/projects\/me%2Fproj$/, 429);
  await refused(labIssue, request(FORK_PROJECT, merge), labCtx(onLab), /the forge did not say/);
  off();
  assert.equal((await sent(labIssue, request(FORK_PROJECT, merge), labCtx(onLab), GITLAB)).status, 201);
  assert.deepEqual(onLab.pulls, ['me/proj:fork-fix']);
  await refused(labIssue, request(FORK_PROJECT, { ...merge, target_branch: 'release' }), labCtx(onLab), /has opened its pull request from me\/proj:fork-fix/);
  await refused(labIssue, request('/api/v4/projects/13', merge), labCtx(onLab), /has opened its pull request from me\/proj:fork-fix/);
  assert.equal((await authorize(labIssue, request('/api/v4/projects/13', merge), labCtx({ branches: ['me/proj:refs/heads/fork-fix'] }))).ok, true);
  // A pool whose numeric id is not known cannot pin the target, so there is no such route.
  const unnumbered = rulesFor({ forge: 'gitlab', kind: 'issues', options: {}, pool: `${GITLAB_HOST}/group/sub/proj`, item: 'issue-421', identity: 'me' });
  await refused(unnumbered, request(FORK_PROJECT, merge), labCtx({ branches: ['me/proj:refs/heads/fork-fix'] }), /no rule of this task allows the request/);
  // Kinds that open nothing get none of it.
  for (const quiet of [labRules('review-own', 'pr-9'), labRules('issues', 'issue-421', { noPRs: true }), labRules('investigate', 'job-q')]) {
    await refused(quiet, request(FORK_PROJECT, merge), labCtx({ branches: ['me/proj:refs/heads/fork-fix'] }), /no rule of this task allows the request/);
  }
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

await check('a branch with a slash in its name is pushed, then read back by its name as each forge takes it', async () => {
  const text = (answer) => Buffer.from(json(answer).content, 'base64').toString('utf8');
  lab.at(lab.root);
  const onLab = lab.commit('fix', { 'src/fix.js': 'fixed', 'README.md': 'read me' });
  const labState = {};
  const rules = labRules('issues', 'issue-421');
  assert.match((await sent(rules, labPush([[ZERO, onLab, 'refs/heads/topic/x']]), labCtx(labState), GITLAB)).bytes.toString('latin1'), /ok refs\/heads\/topic\/x/);
  assert.deepEqual(labState.branches, ['refs/heads/topic/x']);
  // GitLab: one segment with the slash encoded, by the project's path or its number. The
  // answer is cut like any branch's.
  for (const project of [PROJECT, '/api/v4/projects/99']) {
    assert.deepEqual(json(await sent(rules, glab('GET', `${project}/repository/branches/topic%2Fx`), labCtx(labState), GITLAB)),
      { name: 'topic/x', commit: { id: onLab }, merged: false, protected: false, default: false, web_url: `https://${GITLAB_HOST}/group/sub/proj/-/tree/topic/x` });
    assert.equal(text(await sent(rules, glab('GET', `${project}/repository/files/src%2Ffix.js?ref=topic%2Fx`), labCtx(labState), GITLAB)), 'fixed');
    // As glab's own commands spell a file's name.
    assert.equal(text(await sent(rules, glab('GET', `${project}/repository/files/README%2Emd?ref=topic%2Fx`), labCtx(labState), GITLAB)), 'read me');
  }
  // With the slash as it is, the path is a route GitLab does not have.
  assert.equal((await sent(rules, glab('GET', `${PROJECT}/repository/branches/topic/x`), labCtx(labState), GITLAB)).status, 404);
  assert.equal((await sent(rules, glab('POST', `${PROJECT}/merge_requests`, { title: 'Draft: t', source_branch: 'topic/x', target_branch: 'main', target_project_id: 99 }), labCtx(labState), GITLAB)).status, 201);
  for (const games of ['topic%2F..%2Fmain', 'topic%2Fx%2F..%2F..%2F..%2Fmerge_requests%2F5%2Fmerge']) {
    await refused(rules, glab('GET', `${PROJECT}/repository/branches/${games}`), labCtx(labState), /dot segment/);
  }

  // GitHub: the slash as it is. A ref is read by its full name.
  hub.at(hub.root);
  const onHub = hub.commit('fix', { 'src/fix.js': 'fixed' });
  const hubState = {};
  const issue = hubRules('issues', 'issue-422');
  assert.match((await sent(issue, hubPush([[ZERO, onHub, 'refs/heads/topic/y']]), hubCtx(hubState))).bytes.toString('latin1'), /ok refs\/heads\/topic\/y/);
  assert.deepEqual(json(await sent(issue, gh('GET', '/repos/o/r/git/ref/heads/topic/y'), hubCtx(hubState))), { ref: 'refs/heads/topic/y', object: { type: 'commit', sha: onHub } });
  await refused(issue, gh('GET', '/repos/o/r/git/ref/heads/topic%2Fy'), hubCtx(hubState), /encoded slash/);
});

await check('the forge\'s answer about the repository itself comes back cut to what a job needs', async () => {
  for (const spelling of [PROJECT, '/api/v4/projects/99', `${PROJECT}?license=true`]) {
    const project = json(await sent(labRules('investigate', 'job-q'), glab('GET', spelling), labCtx(), GITLAB));
    assert.deepEqual(project, { id: 99, path_with_namespace: 'group/sub/proj', default_branch: 'main', web_url: `https://${GITLAB_HOST}/group/sub/proj`, namespace: { full_path: 'group/sub' }, merge_requests_enabled: true }, spelling);
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
