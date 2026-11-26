// The rule catalogue (PROTOCOL.md section 10): for one task, the exact forge requests its
// executor may have this machine make. A kind or forge without an entry gets no rules,
// so can be offered by nobody.
//
// Writes per kind; every kind also gets the reads below, confined to the pool's
// repository. "its PR" is the item `pr-<n>`, "its issue" `issue-<n>`.
//
//   kind        options          writes
//   ----------  ---------------  ---------------------------------------------------------
//   review      -                on its PR: open, fill, submit (COMMENT only) and delete
//                                its own pending review; reply inside review threads;
//                                delete its own still-pending review comments. No push.
//               verdict          also APPROVE or REQUEST_CHANGES (GitLab: approve,
//                                unapprove). A GitLab review is draft notes published
//                                together plus one summary note.
//   review-own  -                on its PR: reply in and resolve review threads; push
//                                fast-forward commits to its head branch.
//               markReady        also mark the PR ready for review.
//   conflicts   -                push fast-forward commits to its PR's head branch.
//   issues      -                on its issue: assign and unassign the task's account,
//                                comment; push ONE new branch and fast-forward it; open
//                                one draft PR from it.
//               assign: false    no assignment.        comment: false    no comment.
//               noPRs            the comment only.
//   audit       -                push up to AUDIT_BRANCHES new branches and fast-forward
//                                them; open one draft PR from each.
//               readOnly         nothing.
//   investigate -                nothing.
//
// A push goes to the pool's repository or the task account's own fork of it. "One new
// branch" counts across every key of the task and both places (`authorize` keeps the
// count). No push moves or creates the default branch, or a branch the forge reports as
// protected, whatever the rule covers.
//
// An item `job-<id>` is not tied to one number:
//   review      every open PR NOT opened by the task's account (or opened by
//               `options.author`, if named). The path's number becomes "*" and the forge
//               is asked who opened the PR before anything is sent.
//   review-own  every open PR opened by the task's account, checked the same way.
//   conflicts   every open PR opened by `options.author`, else by the task's account.
//   issues      no assignment or comment (Diplomat makes one job per issue, so a job has
//               no issue of its own); the branch and its draft PR stay.
//   audit, investigate   unchanged.
//
// Judgement calls:
// - Reads are listed by what a kind's work needs, not by what is harmless. An item's
//   lists (a PR's files and commits, an issue's events) are read for the task's own item
//   only; a PR's diff is repository code, which every kind reads. A CI run is read only
//   when the forge says it is of a branch the task made, of such a PR's head, or (audit,
//   investigate) of the default branch.
// - Reads stay in the pool's repository: routes under its paths whose answer is another
//   repository's are refused (`deny`), and a route with query parameters names them, as
//   one more could point it elsewhere. What GitHub serves by object id under the
//   repository's paths (its forks' commits) no rule can tell apart.
// - The repository's and a branch's answers are cut (`pick`): whole, they hold a clone or
//   runner registration token, the requester's permissions and protection settings.
//   GraphQL is cut the same way (`repoLeaves` in graphql.js).
// - A push is addressed by the PR: its head branch is whatever the forge says when the
//   push arrives.
// - The only other repository a push reaches is the fork the task's account holds itself
//   (`fork`): the forge is asked whose it is and what it forks. No fork is read through
//   the API.
// - A pushed commit may not change CI definitions (`denyPaths`) from what one of its
//   parents holds, so a merge can bring one in as any branch has it. What a definition
//   includes from elsewhere in the repository is a file like any other.
// - Reviews go through the lifecycle the review prompt prescribes; the one-call shortcuts
//   (GraphQL addPullRequestReview, a top-level PR comment) are not listed.
// - GitLab gets no GraphQL mutation: each write has a REST route pinning the project and
//   item, and a GitLab global id cannot be traced to its merge request in one confined
//   query.
// - Written text is `prose` (PROTOCOL.md) and goes out under a hidden first line
//   (`COMMENT_MARK`), so a bot acting on a comment's first word does not; on GitHub, PR
//   text is also checked against the repository's policy-bot policy (`policy`).
// - `GET /user` is cut (`pick`): agents ask who they are, and the full answer holds the
//   requester's private profile.
// - A GitHub Enterprise Server also gets `GET /meta`, cut to its version: gh 2.101.0 asks
//   for it before `pr view`, `issue view`, `pr create` and a search.

import { knownMutations } from './graphql.js';

export const AUDIT_BRANCHES = 24;

const GITHUB_COM = 'github.com';

/// Where gh reaches a GitHub host's API. Null for a host whose API gh looks for on yet
/// another name: a subdomain of github.com or ghe.com, and github.localhost.
export function githubApi(host) {
  if (host === GITHUB_COM) return { host: 'api.github.com', rest: '', graphql: '/graphql' };
  if (/(^|\.)(github\.com|ghe\.com|github\.localhost)$/.test(host.replace(/:[0-9]*$/, ''))) return null;
  return { host, rest: '/api/v3', graphql: '/api/graphql' };
}

const GITHUB_CODE = [
  'contents/**', 'git/**', 'commits/**', 'tags', 'readme/**', 'license',
  'check-runs/*', 'check-runs/*/annotations', 'check-suites/*', 'check-suites/*/check-runs',
];
const GITHUB_CONTEXT = [
  'pulls', 'pulls/comments', 'pulls/comments/*', 'pulls/*', 'pulls/*/comments', 'pulls/*/reviews', 'pulls/*/reviews/*',
  'pulls/*/reviews/*/comments', 'issues', 'issues/comments', 'issues/comments/*', 'issues/*', 'issues/*/comments',
];
// Read by the task whose item it is only. A pull request is an issue as well.
const GITHUB_PULL = ['files', 'commits', 'requested_reviewers', 'merge'];
const GITHUB_ISSUE = ['events', 'labels', 'reactions'];
// Each path with whether its id is a run's or a job's.
const GITHUB_RUNS = [
  ['actions/runs/*', 'run'], ['actions/runs/*/jobs', 'run'], ['actions/runs/*/logs', 'run'], ['actions/runs/*/attempts/*', 'run'],
  ['actions/runs/*/attempts/*/jobs', 'run'], ['actions/runs/*/attempts/*/logs', 'run'], ['actions/jobs/*', 'job'], ['actions/jobs/*/logs', 'job'],
];
const GITHUB_ELSEWHERE = ['issues/*/timeline', 'issues/*/sub_issues', 'issues/*/parent', 'issues/*/dependencies/**'];
const GITHUB_ELSEWHERE_WHY = 'this answer holds issues and pull requests of other repositories';
// Not the clone token, the requester's permissions, security settings or the parent.
const GITHUB_REPO_PICK = [
  'id', 'node_id', 'name', 'full_name', 'owner', 'private', 'visibility', 'fork', 'archived', 'disabled', 'is_template',
  'html_url', 'url', 'clone_url', 'ssh_url', 'git_url', 'description', 'homepage', 'default_branch', 'language', 'topics',
  'has_issues', 'has_projects', 'has_wiki', 'has_discussions', 'license', 'created_at', 'updated_at', 'pushed_at', 'size',
  'open_issues_count', 'allow_merge_commit', 'allow_squash_merge', 'allow_rebase_merge',
];
// A branch without its protection settings.
const GITHUB_BRANCH_PICK = ['name', 'commit', 'protected'];
// GitLab encodes a ref name's slashes into one segment; "**" after it also covers the
// path with them decoded.
const GITLAB_CODE = ['repository/files/**', 'repository/tree', 'repository/blobs/**', 'repository/commits/**', 'repository/tags/**'];
const GITLAB_CONTEXT = [
  'merge_requests', 'merge_requests/*', 'merge_requests/*/notes', 'merge_requests/*/notes/*', 'merge_requests/*/discussions',
  'merge_requests/*/discussions/*', 'issues', 'issues/*', 'issues/*/notes', 'issues/*/notes/*', 'issues/*/discussions', 'issues/*/discussions/*',
];
const GITLAB_PULL = ['versions', 'versions/*', 'changes', 'diffs', 'raw_diffs', 'commits', 'pipelines', 'approvals', 'draft_notes', 'draft_notes/*', 'award_emoji'];
const GITLAB_ISSUE = ['resource_label_events', 'resource_state_events', 'award_emoji'];
const GITLAB_RUNS = [['pipelines/*', 'run'], ['pipelines/*/jobs', 'run'], ['jobs/*', 'job'], ['jobs/*/trace', 'job']];
const GITLAB_DENIED = [
  [['merge_requests/*/closes_issues', 'merge_requests/*/related_issues', 'merge_requests/*/blocks', 'merge_requests/*/blockees',
    'issues/*/links', 'issues/*/related_merge_requests', 'issues/*/closed_by'], 'this answer holds issues and merge requests of other projects'],
  [['issues/*/user_agent_detail'], 'this answer holds the address a person posted from'],
  [['merge_requests/*/merge_ref'], 'this read writes a ref on the forge'],
];
// Not the runners' registration token, the import URL (it may carry a credential), the
// service desk address, the requester's permissions or the parent.
const GITLAB_PROJECT_PICK = [
  'id', 'name', 'name_with_namespace', 'path', 'path_with_namespace', 'description', 'default_branch', 'visibility', 'web_url',
  'ssh_url_to_repo', 'http_url_to_repo', 'readme_url', 'topics', 'namespace', 'archived', 'empty_repo', 'created_at',
  'last_activity_at', 'issues_enabled', 'merge_requests_enabled', 'jobs_enabled', 'merge_method', 'squash_option',
  'remove_source_branch_after_merge', 'only_allow_merge_if_pipeline_succeeds', 'only_allow_merge_if_all_discussions_are_resolved',
  'license', 'license_url',
];
// A GitLab issue, read or written, carries its Service Desk writer's address.
const ISSUE_BLANK = { blank: ['service_desk_reply_to'] };
const GITLAB_BLANK = { issues: ISSUE_BLANK, 'issues/*': ISSUE_BLANK };
// Without who may push to it or merge into it.
const GITLAB_BRANCH_PICK = ['name', 'commit', 'merged', 'protected', 'default', 'web_url'];
const GITHUB_ROOTS = ['repository', 'viewer', 'rateLimit', '__type', 'search', 'node'];
const GITLAB_ROOTS = ['project', 'currentUser'];

function parsePool(forge, pool) {
  const id = typeof pool === 'string' ? pool : pool?.id;
  if (typeof id !== 'string' || id !== id.toLowerCase() || !/^[a-z0-9._:-]+(\/[a-z0-9._-]+){2,}$/.test(id)) return null;
  const [host, ...parts] = id.split('/');
  if (parts.some((p) => p === '.' || p === '..')) return null;
  if (forge === 'github' && (!githubApi(host) || parts.length !== 2)) return null;
  const projectId = Number.isSafeInteger(pool?.projectId) && pool.projectId > 0 ? pool.projectId : null;
  return { host, repo: parts.join('/'), parts, projectId };
}

// GitHub's GraphQL takes the number as a 32-bit `Int`.
const MAX_ITEM_NUMBER = 2 ** 31 - 1;

function parseItem(item) {
  const m = /^(pr|issue)-([1-9][0-9]{0,15})$/.exec(item || '');
  if (m) return Number(m[2]) <= MAX_ITEM_NUMBER ? { type: m[1], number: Number(m[2]) } : null;
  return /^job-[A-Za-z0-9._-]{1,128}$/.test(item || '') ? { type: 'job' } : null;
}

const without = (object, key) => Object.fromEntries(Object.entries(object).filter(([k]) => k !== key));
const login = (v) => (typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/.test(v) ? v.toLowerCase() : null);

// One number, or every open PR by (or not by) an author; null when the item gives none.
function pullScope(kind, item, me, options) {
  if (item.type === 'pr') return { type: 'pr', number: item.number };
  if (item.type !== 'job') return null;
  const named = options.author === undefined ? undefined : login(options.author);
  if (named === null) return null;
  if (kind === 'review') return { type: 'pr', notAuthor: me, ...(named ? { author: named } : {}) };
  if (kind === 'review-own') return { type: 'pr', author: me };
  return { type: 'pr', author: named || me };
}

const PULL_KINDS = ['review', 'review-own', 'conflicts'];
const PROSE = { prose: true };
const COMMENT = { prose: true, comment: true };

// CI runs read beside the task's own branches': a covered PR's head (`head`) or the
// default branch (`base`). Null for a task with no branch to watch.
function runScope(kind, options, who) {
  if (who) return { head: who };
  if (kind === 'issues') return options.noPRs === true ? null : {};
  return { base: true };
}

// ------------------------------------------------------------------------ GitHub

function github({ kind, options, target, item, me }) {
  const [owner, name] = target.parts;
  const at = githubApi(target.host);
  const repo = `${at.rest}/repos/${owner}/${name}`;
  // How many segments of a path stand before "repos".
  const under = at.rest.split('/').length - 1;
  const api = (method, path, more = {}) => ({ host: at.host, method, path, fold: [under + 1, under + 2], ...more });
  // Text policy-bot reads, on the PR or issue the path's number names.
  const READ = { ...COMMENT, policy: { segment: under + 4 } };
  const rules = [];
  const mutations = [];
  let graphqlItem;

  // Smart HTTP takes a repository with or without ".git". `/${me}/*` is any repository of
  // the account; the push check lets through only its fork of the pool's (`fork`).
  const push = (more) => {
    for (const [base, fold, where] of [[`/${owner}/${name}.git`, [0, 1], {}], [`/${owner}/${name}`, [0, 1], {}], [`/${me}/*`, [0], { fork: me }]]) {
      rules.push({ host: target.host, method: 'GET', path: `${base}/info/refs`, fold, query: { service: { equals: 'git-receive-pack' } }, git: 'receive-pack', repo: target.repo, ...where, ...more });
      rules.push({ host: target.host, method: 'POST', path: `${base}/git-receive-pack`, fold, git: 'receive-pack', repo: target.repo, denyPaths: ['.github/workflows/**'], ...where, ...more });
    }
  };
  // `head` is "branch", or "account:branch" for a branch of that account's fork.
  const draftPulls = () => {
    mutations.push('createPullRequest');
    rules.push(api('POST', `${repo}/pulls`, { body: {
      head: { created: 'label', required: true }, draft: { equals: true, required: true },
      title: PROSE, body: { prose: true, policy: { base: 'base' } }, base: 'free', maintainer_can_modify: 'free',
    } }));
  };

  const scope = PULL_KINDS.includes(kind) ? pullScope(kind, item, me, options) : null;
  const who = scope && without(scope, 'type');
  const n = scope?.number ?? '*';
  // Without a number in the path, the forge is asked whose pull request it names.
  const asked = scope && scope.number === undefined ? { pull: { segment: under + 4, ...who } } : {};
  if (PULL_KINDS.includes(kind)) {
    if (!scope) return null;
    graphqlItem = scope;
    if (kind === 'review') {
      const events = options.verdict === true ? ['COMMENT', 'APPROVE', 'REQUEST_CHANGES'] : ['COMMENT'];
      rules.push(api('POST', `${repo}/pulls/${n}/reviews`, { ...asked, body: { commit_id: 'free', body: READ, comments: { proseIn: 'body', comment: true }, event: { oneOf: events } } }));
      rules.push(api('POST', `${repo}/pulls/${n}/reviews/*/events`, { ...asked, body: { event: { oneOf: events, required: true }, body: READ } }));
      rules.push(api('DELETE', `${repo}/pulls/${n}/reviews/*`, asked));
      rules.push(api('DELETE', `${repo}/pulls/comments/*`, { comment: { segment: under + 5, repo: target.repo, item: scope, own: true, pending: true, identity: me } }));
      mutations.push('addPullRequestReviewThread', 'addPullRequestReviewThreadReply', 'deletePullRequestReviewComment');
    } else if (kind === 'review-own') {
      rules.push(api('POST', `${repo}/pulls/${n}/comments/*/replies`, { comment: { segment: under + 6, pullSegment: under + 4, repo: target.repo, item: scope }, body: { body: COMMENT } }));
      mutations.push('addPullRequestReviewThreadReply', 'resolveReviewThread');
      if (options.markReady === true) mutations.push('markPullRequestReadyForReview');
    }
    if (kind !== 'review') push({ head: who });
  } else if (kind === 'issues') {
    if (item.type === 'pr') return null;
    if (item.type === 'issue') {
      graphqlItem = { type: 'issue', number: item.number };
      const issue = `${repo}/issues/${item.number}`;
      if (options.noPRs !== true && options.assign !== false) {
        const mine = { assignees: { equals: [me], fold: true, required: true } };
        rules.push(api('POST', `${issue}/assignees`, { body: mine }), api('DELETE', `${issue}/assignees`, { body: mine }));
        mutations.push('replaceActorsForAssignable', 'updateIssue');
      }
      if (options.comment !== false) {
        rules.push(api('POST', `${issue}/comments`, { body: { body: READ } }));
        mutations.push('addComment');
      }
    }
    if (options.noPRs !== true) {
      push({ refs: ['refs/heads/**'], create: 1 });
      draftPulls();
    }
  } else if (kind === 'audit') {
    if (options.readOnly !== true) {
      push({ refs: ['refs/heads/**'], create: AUDIT_BRANCHES });
      draftPulls();
    }
  } else if (kind !== 'investigate') {
    return null;
  }

  rules.push(api('GET', repo, { pick: GITHUB_REPO_PICK }));
  for (const tree of GITHUB_ELSEWHERE) rules.push(api('GET', `${repo}/${tree}`, { deny: GITHUB_ELSEWHERE_WHY }));
  // Where an issue's number stands, GitHub also takes "events".
  rules.push(api('GET', `${repo}/issues/events`, { deny: 'no task reads the log of what was done to every issue' }));
  // "base...head" names a fork's branch as "owner:branch" or "owner:repo:branch"; a ref
  // of this repository holds no colon.
  rules.push(api('GET', `${repo}/compare/**`, { without: { ':': 'a compare whose side holds ":" names another repository' } }));
  rules.push(api('GET', `${repo}/branches`, { pick: GITHUB_BRANCH_PICK }), api('GET', `${repo}/branches/*`, { pick: GITHUB_BRANCH_PICK }));
  for (const tree of [...GITHUB_CONTEXT, ...GITHUB_CODE]) rules.push(api('GET', `${repo}/${tree}`));
  if (scope) for (const part of GITHUB_PULL) rules.push(api('GET', `${repo}/pulls/${n}/${part}`, asked));
  const own = scope ? n : item.type === 'issue' ? item.number : undefined;
  if (own !== undefined) for (const part of GITHUB_ISSUE) rules.push(api('GET', `${repo}/issues/${own}/${part}`, asked));
  const runs = runScope(kind, options, who);
  if (runs) for (const [tree, what] of GITHUB_RUNS) rules.push(api('GET', `${repo}/${tree}`, { run: { segment: under + 5, what, repo: target.repo, ...runs } }));
  rules.push({ host: at.host, method: 'GET', path: `${at.rest}/user`, pick: ['login', 'id', 'node_id', 'type', 'name', 'html_url'] });
  if (target.host !== GITHUB_COM) rules.push({ host: at.host, method: 'GET', path: `${at.rest}/meta`, pick: ['installed_version'] });
  rules.push({ host: at.host, method: 'GET', path: `${at.rest}/search/issues`, query: {
    q: { search: target.repo }, advanced_search: 'free', page: 'free', per_page: 'free', sort: 'free', order: 'free',
  } });
  rules.push({ host: at.host, method: 'POST', path: at.graphql, graphql: {
    forge: 'github', repo: target.repo, roots: GITHUB_ROOTS, mutations, identity: me, ...(graphqlItem ? { item: graphqlItem } : {}),
  } });
  return rules;
}

// ------------------------------------------------------------------------ GitLab

function gitlab({ kind, options, target, item, me }) {
  // glab names a project by its encoded path; a script that read its id uses the number.
  const projects = [{ base: `/api/v4/projects/${encodeURIComponent(target.repo)}`, fold: [3] }];
  if (target.projectId !== null) projects.push({ base: `/api/v4/projects/${target.projectId}`, fold: [] });
  const rules = [];
  const each = (method, tail, more = {}) => {
    for (const { base, fold } of projects) rules.push({ host: target.host, method, path: `${base}${tail}`, fold, ...more });
  };
  const gitFold = target.parts.map((_, i) => i);
  // `/${me}/*` is any project of the account; the push check lets through only its fork
  // of the pool's (`fork`).
  const push = (more) => {
    for (const [base, fold, where] of [[`/${target.repo}.git`, gitFold, {}], [`/${target.repo}`, gitFold, {}], [`/${me}/*`, [0], { fork: me }]]) {
      rules.push({ host: target.host, method: 'GET', path: `${base}/info/refs`, fold, query: { service: { equals: 'git-receive-pack' } }, git: 'receive-pack', repo: target.repo, ...where, ...more });
      // The push check adds the file the project is set to read its CI configuration from.
      rules.push({ host: target.host, method: 'POST', path: `${base}/git-receive-pack`, fold, git: 'receive-pack', repo: target.repo, denyPaths: ['.gitlab-ci.yml', '.gitlab/ci/**'], ...where, ...more });
    }
  };
  // A merge request is a draft by its title; nothing else in the body may retarget or
  // merge it. No labels: naming one makes it, replaces another of its scope and can start
  // a pipeline. glab sends the empty list.
  const draft = {
    source_branch: { created: true, required: true }, title: { prefix: 'Draft:', prose: true, required: true },
    target_branch: 'free', description: PROSE, labels: { equals: '' }, remove_source_branch: 'free', squash: 'free', allow_collaboration: 'free',
  };
  const draftMerges = () => {
    // glab names the target project in every merge request; only the pool's may be named.
    each('POST', '/merge_requests', { body: { ...draft, ...(target.projectId === null ? {} : { target_project_id: { equals: target.projectId } }) } });
    // One from a fork is opened on the fork's project, targeting the pool's: `project`
    // asks the forge whether the path's project is the account's own fork of the pool's.
    if (target.projectId !== null) {
      rules.push({ host: target.host, method: 'POST', path: '/api/v4/projects/*/merge_requests', project: { segment: 3, owner: me, repo: target.repo },
        body: { ...draft, target_project_id: { equals: target.projectId, required: true } } });
    }
  };

  const scope = PULL_KINDS.includes(kind) ? pullScope(kind, item, me, options) : null;
  const who = scope && without(scope, 'type');
  const asked = scope && scope.number === undefined ? { pull: { segment: 5, ...who } } : {};
  const mr = `/merge_requests/${scope?.number ?? '*'}`;
  if (PULL_KINDS.includes(kind)) {
    if (!scope) return null;
    if (kind === 'review') {
      each('POST', `${mr}/draft_notes`, { ...asked, body: { note: COMMENT, position: 'free', commit_id: 'free', in_reply_to_discussion_id: 'free' } });
      each('PUT', `${mr}/draft_notes/*`, { ...asked, body: { note: COMMENT, position: 'free' } });
      each('DELETE', `${mr}/draft_notes/*`, asked);
      // glab sends "{}" where a route takes no parameters; `body: {}` allows that and no member.
      each('PUT', `${mr}/draft_notes/*/publish`, { ...asked, body: {} });
      each('POST', `${mr}/draft_notes/bulk_publish`, { ...asked, body: {} });
      // The summary a GitHub review carries in its own body is a note of its own here.
      each('POST', `${mr}/notes`, { ...asked, body: { body: COMMENT } });
      if (options.verdict === true) {
        each('POST', `${mr}/approve`, { ...asked, body: { sha: 'free' } });
        each('POST', `${mr}/unapprove`, { ...asked, body: {} });
      }
    } else if (kind === 'review-own') {
      each('POST', `${mr}/discussions/*/notes`, { ...asked, body: { body: COMMENT } });
      // GitLab reads `resolved` from the query or from the body; one of them must say it.
      each('PUT', `${mr}/discussions/*`, { ...asked, query: { resolved: { equals: 'true', optional: true } }, body: { resolved: { oneOf: [true, 'true'], required: true } } });
      if (options.markReady === true) each('PUT', mr, { ...asked, body: { title: PROSE } });
    }
    if (kind !== 'review') push({ head: who });
  } else if (kind === 'issues') {
    if (item.type === 'pr') return null;
    if (item.type === 'issue') {
      const issue = `/issues/${item.number}`;
      if (options.noPRs !== true && options.assign !== false) each('PUT', issue, { body: { assignee_ids: { assignees: item.number, required: true } }, ...ISSUE_BLANK });
      if (options.comment !== false) each('POST', `${issue}/notes`, { body: { body: COMMENT } });
    }
    if (options.noPRs !== true) {
      push({ refs: ['refs/heads/**'], create: 1 });
      draftMerges();
    }
  } else if (kind === 'audit') {
    if (options.readOnly !== true) {
      push({ refs: ['refs/heads/**'], create: AUDIT_BRANCHES });
      draftMerges();
    }
  } else if (kind !== 'investigate') {
    return null;
  }

  each('GET', '', { pick: GITLAB_PROJECT_PICK });
  for (const [trees, why] of GITLAB_DENIED) for (const tree of trees) each('GET', `/${tree}`, { deny: why });
  // A compare takes two refs of this project; `from_project_id` would make one another project's.
  each('GET', '/repository/compare', { query: { from: 'free', to: 'free', straight: 'free', unidiff: 'free' } });
  each('GET', '/repository/branches/**', { pick: GITLAB_BRANCH_PICK });
  for (const tree of [...GITLAB_CONTEXT, ...GITLAB_CODE]) each('GET', `/${tree}`, GITLAB_BLANK[tree] ?? {});
  if (scope) for (const part of GITLAB_PULL) each('GET', `${mr}/${part}`, asked);
  if (item.type === 'issue') for (const part of GITLAB_ISSUE) each('GET', `/issues/${item.number}/${part}`);
  const runs = runScope(kind, options, who);
  if (runs) for (const [tree, what] of GITLAB_RUNS) each('GET', `/${tree}`, { run: { segment: 5, what, repo: target.repo, ...runs } });
  rules.push({ host: target.host, method: 'GET', path: '/api/v4/user', pick: ['id', 'username', 'name', 'state', 'web_url'] });
  rules.push({ host: target.host, method: 'POST', path: '/api/graphql', graphql: { forge: 'gitlab', repo: target.repo, roots: GITLAB_ROOTS, mutations: [], identity: me } });
  return rules;
}

/// The exact rules of one task, or null when the catalogue has no entry for it. `pool`
/// is the pool id, or `{ id, projectId }` to also allow a GitLab project's numeric
/// spelling; `identity` is the forge login the task acts as.
export function rulesFor({ forge, kind, options = {}, pool, item, identity }) {
  const target = parsePool(forge, pool);
  const parsed = parseItem(item);
  const me = login(identity);
  if (!target || !parsed || !me || options === null || typeof options !== 'object') return null;
  const build = { github, gitlab }[forge];
  if (!build) return null;
  const rules = build({ kind, options, target, item: parsed, me });
  // A mutation the document check cannot confine must never reach a capability.
  const known = new Set(knownMutations(forge));
  if (rules && rules.some((r) => r.graphql && r.graphql.mutations.some((m) => !known.has(m)))) return null;
  return rules;
}
