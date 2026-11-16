// The rule catalogue (PROTOCOL.md section 10): for one task, the exact list of forge
// requests its executor may have this machine make. A task gets what its kind needs on
// its own item and nothing else; a kind or forge without an entry gets no rules at all and
// can be offered by nobody.
//
// What each kind may write. Every kind also gets the reads below, confined to the pool's
// repository. "its PR" is the task's item `pr-<n>`; "its issue" is `issue-<n>`.
//
//   kind        options          writes
//   ----------  ---------------  ---------------------------------------------------------
//   review      -                on its PR: open, fill, submit (COMMENT only) and delete
//                                its own pending review; reply inside review threads;
//                                delete its own still-pending review comments. No push.
//               verdict          the same, and the review may be submitted as APPROVE or
//                                REQUEST_CHANGES (GitLab: approve, unapprove).
//                                GitLab spells a review as draft notes published together
//                                and one summary note on the merge request.
//   review-own  -                on its PR: reply in review threads, resolve them, push
//                                fast-forward commits to the PR's head branch.
//               markReady        the same, and the PR may be marked ready for review.
//   conflicts   -                push fast-forward commits to its PR's head branch.
//   issues      -                on its issue: assign and unassign the task's own account,
//                                comment; push ONE new branch and fast-forward it; open
//                                one draft pull request from that branch.
//               assign: false    no assignment.        comment: false    no comment.
//               noPRs            the comment only: no assignment, no push, no pull request.
//   audit       -                push up to AUDIT_BRANCHES new branches and fast-forward
//                                them; open one draft pull request from each.
//               readOnly         nothing.
//   investigate -                nothing.
//
// A push goes to the pool's repository or to the task account's own fork of it - the
// fork holds the head branch of a pull request opened from it, and a new branch may be
// made in either. "One new branch" is counted for the task, across every key issued for
// it and across both places (`authorize` keeps the count in the task's state). No push
// moves or creates the default branch of the repository it goes to, or a branch the forge
// reports as protected there, whatever the rule covers.
//
// An item `job-<id>` is work not tied to one number. What that does to each kind:
//
//   review      every open PR NOT opened by the task's account (opened by
//               `options.author` when the job names one). The number in a path becomes "*"
//               and the forge is asked who opened that PR before anything is sent.
//   review-own  every open PR opened by the task's account, checked the same way; a push
//               must go to the head branch of such a PR.
//   conflicts   every open PR opened by `options.author`, or by the task's account when
//               the job names nobody: a push must go to the head branch of such a PR.
//   issues      the issue-pinned writes (assignment, comment) are omitted; the one branch
//               and its draft pull request stay. Diplomat makes one job per issue, so a
//               job without a number has no issue of its own to write on.
//   audit, investigate   unchanged: neither is about one number.
//
// Judgement calls:
// - Reads are an allow-list of sub-trees, not "everything under the repository": Actions
//   secrets and variables, hooks, deploy keys, collaborators, environments, security
//   alerts and branch protection are settings a task has no use for and are not listed.
// - A read stays in the pool's repository. Inside the listed sub-trees, the routes whose
//   answer is another repository's are refused by rules of their own (`deny`), a compare
//   takes two refs of this repository, and a route that takes query parameters names
//   them, since one more could point it elsewhere. What the forge serves under the
//   repository's own paths by object id - on GitHub, the commits of its forks - no rule
//   can tell apart.
// - The answer about the repository itself, and about a branch, goes out cut to what a
//   job needs (`pick`): the whole answer holds a clone token or a runner registration
//   token, the requester's permissions and the protection settings. A GraphQL document
//   reads the same of the repository (`repoLeaves` in graphql.js), and on GitHub the
//   requester's access level, which `gh pr create` asks for.
// - A push is addressed by the pull request, not by a branch name: the head branch is
//   whatever the forge says that PR's head is when the push arrives, in the repository
//   the forge says holds it.
// - The only other repository a push reaches is the fork of the pool's repository that
//   the task's account holds itself (`fork`): the path names that account as the owner,
//   and the forge is asked whose the repository is and what it is a fork of. A fork held
//   by anybody else, by an organisation or a group, a fork of a fork and the account's
//   other repositories are out of reach, and nothing of a fork is read through the API.
// - A draft opened from a branch in the fork is still a pull request of the pool's
//   repository: GitHub takes the head as "account:branch", GitLab opens the merge
//   request on the fork's project with the pool's project as its pinned target.
// - A pushed commit may not change CI definitions (`denyPaths`) from what one of its
//   parents holds. A merge can so bring a definition in as any branch of the repository
//   has it, which is what merging the base branch does. What a definition runs or
//   includes from elsewhere in the repository is a file like any other.
// - A review is written through the review lifecycle the review prompt prescribes; the
//   one-call shortcuts (GraphQL addPullRequestReview, a top-level PR comment) are not
//   listed, and a `review` task's replies are made inside review threads only.
// - GitLab gets no GraphQL mutation: every write its prompts ask for has a REST route
//   whose path pins the project and the merge request or issue, and a GitLab global id
//   cannot be traced back to its merge request in one confined query.
// - Text sent to GitLab may hold no line starting with "/": GitLab runs such a line as a
//   quick action in the author's name, and /merge is one.
// - `GET /user` answers with a handful of public members only (`pick`): agents ask it
//   who they are, and the full answer holds the requester's private profile.

import { knownMutations } from './graphql.js';

/// How many branches an `audit` task may create.
export const AUDIT_BRANCHES = 24;

const GITHUB_API = 'api.github.com';
const GITHUB_GIT = 'github.com';

// The sub-trees of a GitHub repository a task may read.
const GITHUB_READS = [
  'pulls/**', 'issues/**', 'commits/**', 'contents/**', 'git/**', 'tags',
  'releases/**', 'labels/**', 'milestones/**', 'check-runs/**', 'check-suites/**', 'statuses/**', 'comments/**',
  'languages', 'topics', 'contributors', 'readme/**', 'license', 'events', 'tarball/**', 'zipball/**',
  'actions/runs/**', 'actions/jobs/**', 'actions/workflows/**', 'actions/artifacts/**',
];
// Reads inside those sub-trees whose answer is not the repository's own: an issue's
// timeline, sub-issues, parent and dependencies carry the issues and pull requests of
// other repositories that refer to it.
const GITHUB_ELSEWHERE = ['issues/*/timeline', 'issues/*/sub_issues', 'issues/*/parent', 'issues/*/dependencies/**'];
const GITHUB_ELSEWHERE_WHY = 'this answer holds issues and pull requests of other repositories';
// What a task is told of the repository itself: not the clone token, the requester's
// permissions on it, its security settings or the repository it was forked from.
const GITHUB_REPO_PICK = [
  'id', 'node_id', 'name', 'full_name', 'owner', 'private', 'visibility', 'fork', 'archived', 'disabled', 'is_template',
  'html_url', 'url', 'clone_url', 'ssh_url', 'git_url', 'description', 'homepage', 'default_branch', 'language', 'topics',
  'has_issues', 'has_projects', 'has_wiki', 'has_discussions', 'license', 'created_at', 'updated_at', 'pushed_at', 'size',
  'open_issues_count', 'allow_merge_commit', 'allow_squash_merge', 'allow_rebase_merge',
];
// A branch without its protection settings.
const GITHUB_BRANCH_PICK = ['name', 'commit', 'protected'];
const GITLAB_READS = [
  'merge_requests/**', 'issues/**', 'repository/**', 'jobs/**', 'pipelines', 'pipelines/*', 'pipelines/*/jobs',
  'labels/**', 'milestones/**', 'releases/**',
];
// The same on GitLab, by reason: answers that hold other projects' issues and merge
// requests, the address a person posted from, and a GET that writes a ref.
const GITLAB_DENIED = [
  [['merge_requests/*/closes_issues', 'merge_requests/*/related_issues', 'merge_requests/*/blocks', 'merge_requests/*/blockees',
    'issues/*/links', 'issues/*/related_merge_requests', 'issues/*/closed_by'], 'this answer holds issues and merge requests of other projects'],
  [['issues/*/user_agent_detail'], 'this answer holds the address a person posted from'],
  [['merge_requests/*/merge_ref'], 'this read writes a ref on the forge'],
];
// What a task is told of the project itself: not its runners' registration token, its
// import URL (which may carry a credential), its service desk address, the requester's
// permissions on it or the project it was forked from.
const GITLAB_PROJECT_PICK = [
  'id', 'name', 'name_with_namespace', 'path', 'path_with_namespace', 'description', 'default_branch', 'visibility', 'web_url',
  'ssh_url_to_repo', 'http_url_to_repo', 'readme_url', 'topics', 'namespace', 'archived', 'empty_repo', 'created_at',
  'last_activity_at', 'issues_enabled', 'merge_requests_enabled', 'jobs_enabled', 'merge_method', 'squash_option',
  'remove_source_branch_after_merge', 'only_allow_merge_if_pipeline_succeeds', 'only_allow_merge_if_all_discussions_are_resolved',
  'license', 'license_url',
];
// A GitLab branch without who may push to it or merge into it, the requester included.
const GITLAB_BRANCH_PICK = ['name', 'commit', 'merged', 'protected', 'default', 'web_url'];
const GITHUB_ROOTS = ['repository', 'viewer', 'rateLimit', '__type', 'search', 'node'];
const GITLAB_ROOTS = ['project', 'currentUser'];

function parsePool(forge, pool) {
  const id = typeof pool === 'string' ? pool : pool?.id;
  if (typeof id !== 'string' || id !== id.toLowerCase() || !/^[a-z0-9._:-]+(\/[a-z0-9._-]+){2,}$/.test(id)) return null;
  const [host, ...parts] = id.split('/');
  if (parts.some((p) => p === '.' || p === '..')) return null;
  if (forge === 'github' && (host !== GITHUB_GIT || parts.length !== 2)) return null;
  const projectId = Number.isSafeInteger(pool?.projectId) && pool.projectId > 0 ? pool.projectId : null;
  return { host, repo: parts.join('/'), parts, projectId };
}

// The largest number a pull request or an issue can have: GitHub's GraphQL takes the
// number as an `Int`, which is 32 bits wide.
const MAX_ITEM_NUMBER = 2 ** 31 - 1;

function parseItem(item) {
  const m = /^(pr|issue)-([1-9][0-9]{0,15})$/.exec(item || '');
  if (m) return Number(m[2]) <= MAX_ITEM_NUMBER ? { type: m[1], number: Number(m[2]) } : null;
  return /^job-[A-Za-z0-9._-]{1,128}$/.test(item || '') ? { type: 'job' } : null;
}

const without = (object, key) => Object.fromEntries(Object.entries(object).filter(([k]) => k !== key));
const login = (v) => (typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/.test(v) ? v.toLowerCase() : null);

// Which pull requests a PR-shaped kind covers: one number, or every open one by (or not
// by) an author. Null when the task's item gives it nothing to stand on.
function pullScope(kind, item, me, options) {
  if (item.type === 'pr') return { type: 'pr', number: item.number };
  if (item.type !== 'job') return null;
  const named = options.author === undefined ? undefined : login(options.author);
  if (named === null) return null;
  if (kind === 'review') return { type: 'pr', notAuthor: me, ...(named ? { author: named } : {}) };
  if (kind === 'review-own') return { type: 'pr', author: me };
  return { type: 'pr', author: named || me };
}

// ------------------------------------------------------------------------ GitHub

function github({ kind, options, target, item, me }) {
  const [owner, name] = target.parts;
  const repo = `/repos/${owner}/${name}`;
  const api = (method, path, more = {}) => ({ host: GITHUB_API, method, path, fold: [1, 2], ...more });
  const rules = [];
  const mutations = [];
  let graphqlItem;

  // Smart HTTP addresses a repository with or without ".git". After the pool's own come
  // the task account's repositories, whatever their names: the push check lets through
  // the one the forge calls that account's fork of the pool's (`fork`).
  const push = (more) => {
    for (const [base, fold, where] of [[`/${owner}/${name}.git`, [0, 1], {}], [`/${owner}/${name}`, [0, 1], {}], [`/${me}/*`, [0], { fork: me }]]) {
      rules.push({ host: GITHUB_GIT, method: 'GET', path: `${base}/info/refs`, fold, query: { service: { equals: 'git-receive-pack' } }, git: 'receive-pack', repo: target.repo, ...where, ...more });
      rules.push({ host: GITHUB_GIT, method: 'POST', path: `${base}/git-receive-pack`, fold, git: 'receive-pack', repo: target.repo, denyPaths: ['.github/workflows/**'], ...where, ...more });
    }
  };
  // `head` is "branch", or "account:branch" for a branch of that account's fork.
  const draftPulls = () => {
    mutations.push('createPullRequest');
    rules.push(api('POST', `${repo}/pulls`, { body: {
      head: { created: 'label', required: true }, draft: { equals: true, required: true },
      title: 'free', body: 'free', base: 'free', maintainer_can_modify: 'free',
    } }));
  };

  if (kind === 'review' || kind === 'review-own' || kind === 'conflicts') {
    const scope = pullScope(kind, item, me, options);
    if (!scope) return null;
    graphqlItem = scope;
    const who = without(scope, 'type');
    const n = scope.number ?? '*';
    // Without a number in the path, the forge is asked whose pull request it names.
    const asked = scope.number === undefined ? { pull: { segment: 4, ...who } } : {};
    if (kind === 'review') {
      const events = options.verdict === true ? ['COMMENT', 'APPROVE', 'REQUEST_CHANGES'] : ['COMMENT'];
      rules.push(api('POST', `${repo}/pulls/${n}/reviews`, { ...asked, body: { commit_id: 'free', body: 'free', comments: 'free', event: { oneOf: events } } }));
      rules.push(api('POST', `${repo}/pulls/${n}/reviews/*/events`, { ...asked, body: { event: { oneOf: events, required: true }, body: 'free' } }));
      rules.push(api('DELETE', `${repo}/pulls/${n}/reviews/*`, asked));
      rules.push(api('DELETE', `${repo}/pulls/comments/*`, { comment: { segment: 5, repo: target.repo, item: scope, own: true, pending: true, identity: me } }));
      mutations.push('addPullRequestReviewThread', 'addPullRequestReviewThreadReply', 'deletePullRequestReviewComment');
    } else if (kind === 'review-own') {
      rules.push(api('POST', `${repo}/pulls/${n}/comments/*/replies`, { comment: { segment: 6, pullSegment: 4, repo: target.repo, item: scope }, body: { body: 'free' } }));
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
        rules.push(api('POST', `${issue}/comments`, { body: { body: 'free' } }));
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
  // "base...head" names a fork's branch as "owner:branch" or "owner:repo:branch"; a ref
  // of this repository holds no colon.
  rules.push(api('GET', `${repo}/compare/**`, { without: { ':': 'a compare whose side holds ":" names another repository' } }));
  rules.push(api('GET', `${repo}/branches`, { pick: GITHUB_BRANCH_PICK }), api('GET', `${repo}/branches/*`, { pick: GITHUB_BRANCH_PICK }));
  for (const tree of GITHUB_READS) rules.push(api('GET', `${repo}/${tree}`));
  rules.push({ host: GITHUB_API, method: 'GET', path: '/user', pick: ['login', 'id', 'node_id', 'type', 'name', 'html_url'] });
  // A search takes its query and how the answer is paged and ordered.
  rules.push({ host: GITHUB_API, method: 'GET', path: '/search/issues', query: {
    q: { search: target.repo }, advanced_search: 'free', page: 'free', per_page: 'free', sort: 'free', order: 'free',
  } });
  rules.push({ host: GITHUB_API, method: 'POST', path: '/graphql', graphql: {
    forge: 'github', repo: target.repo, roots: GITHUB_ROOTS, mutations, identity: me, ...(graphqlItem ? { item: graphqlItem } : {}),
  } });
  return rules;
}

// ------------------------------------------------------------------------ GitLab

function gitlab({ kind, options, target, item, me }) {
  // glab names a project by its URL-encoded path; a script that read a project's id from
  // an answer uses the number. Both spell the same project.
  const projects = [{ base: `/api/v4/projects/${encodeURIComponent(target.repo)}`, fold: [3] }];
  if (target.projectId !== null) projects.push({ base: `/api/v4/projects/${target.projectId}`, fold: [] });
  const rules = [];
  const each = (method, tail, more = {}) => {
    for (const { base, fold } of projects) rules.push({ host: target.host, method, path: `${base}${tail}`, fold, ...more });
  };
  const gitFold = target.parts.map((_, i) => i);
  // After the pool's own project come the projects in the task account's own namespace:
  // the push check lets through the one the forge calls a fork of the pool's (`fork`).
  const push = (more) => {
    for (const [base, fold, where] of [[`/${target.repo}.git`, gitFold, {}], [`/${target.repo}`, gitFold, {}], [`/${me}/*`, [0], { fork: me }]]) {
      rules.push({ host: target.host, method: 'GET', path: `${base}/info/refs`, fold, query: { service: { equals: 'git-receive-pack' } }, git: 'receive-pack', repo: target.repo, ...where, ...more });
      // The push check adds the file the project is set to read its CI configuration from.
      rules.push({ host: target.host, method: 'POST', path: `${base}/git-receive-pack`, fold, git: 'receive-pack', repo: target.repo, denyPaths: ['.gitlab-ci.yml', '.gitlab/ci/**'], ...where, ...more });
    }
  };
  // GitLab runs a line starting with "/" in a note or description as a quick action
  // (/merge, /approve, /close), so text is `prose`: free, with no such line.
  const prose = { prose: true };
  // A merge request is a draft by its title, and nothing else in the body may point it
  // at another project or merge it.
  const draft = {
    source_branch: { created: true, required: true }, title: { prefix: 'Draft:', required: true },
    target_branch: 'free', description: prose, labels: 'free', remove_source_branch: 'free', squash: 'free', allow_collaboration: 'free',
  };
  const draftMerges = () => {
    // glab names the target project in every merge request it opens; it may only be the pool's own.
    each('POST', '/merge_requests', { body: { ...draft, ...(target.projectId === null ? {} : { target_project_id: { equals: target.projectId } }) } });
    // A merge request from a fork is opened on the fork's project and must name the
    // pool's as its target: `project` has the forge asked whether the project in the
    // path is the task account's own fork of the pool's.
    if (target.projectId !== null) {
      rules.push({ host: target.host, method: 'POST', path: '/api/v4/projects/*/merge_requests', project: { segment: 3, owner: me, repo: target.repo },
        body: { ...draft, target_project_id: { equals: target.projectId, required: true } } });
    }
  };

  if (kind === 'review' || kind === 'review-own' || kind === 'conflicts') {
    const scope = pullScope(kind, item, me, options);
    if (!scope) return null;
    const who = without(scope, 'type');
    const n = scope.number ?? '*';
    const asked = scope.number === undefined ? { pull: { segment: 5, ...who } } : {};
    const mr = `/merge_requests/${n}`;
    if (kind === 'review') {
      each('POST', `${mr}/draft_notes`, { ...asked, body: { note: prose, position: 'free', commit_id: 'free', in_reply_to_discussion_id: 'free' } });
      each('PUT', `${mr}/draft_notes/*`, { ...asked, body: { note: prose, position: 'free' } });
      each('DELETE', `${mr}/draft_notes/*`, asked);
      // glab sends "{}" where a route takes no parameters; `body: {}` allows that and no member.
      each('PUT', `${mr}/draft_notes/*/publish`, { ...asked, body: {} });
      each('POST', `${mr}/draft_notes/bulk_publish`, { ...asked, body: {} });
      // The summary a GitHub review carries in its own body is a note of its own here.
      each('POST', `${mr}/notes`, { ...asked, body: { body: prose } });
      if (options.verdict === true) {
        each('POST', `${mr}/approve`, { ...asked, body: { sha: 'free' } });
        each('POST', `${mr}/unapprove`, { ...asked, body: {} });
      }
    } else if (kind === 'review-own') {
      each('POST', `${mr}/discussions/*/notes`, { ...asked, body: { body: prose } });
      // GitLab reads `resolved` from the query or from the body; one of them must say it.
      each('PUT', `${mr}/discussions/*`, { ...asked, query: { resolved: { equals: 'true', optional: true } }, body: { resolved: { oneOf: [true, 'true'], required: true } } });
      if (options.markReady === true) each('PUT', mr, { ...asked, body: { title: 'free' } });
    }
    if (kind !== 'review') push({ head: who });
  } else if (kind === 'issues') {
    if (item.type === 'pr') return null;
    if (item.type === 'issue') {
      const issue = `/issues/${item.number}`;
      if (options.noPRs !== true && options.assign !== false) each('PUT', issue, { body: { assignee_ids: { assignees: item.number, required: true } } });
      if (options.comment !== false) each('POST', `${issue}/notes`, { body: { body: prose } });
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
  for (const tail of ['', '/*']) each('GET', `/repository/branches${tail}`, { pick: GITLAB_BRANCH_PICK });
  for (const tree of GITLAB_READS) each('GET', `/${tree}`);
  rules.push({ host: target.host, method: 'GET', path: '/api/v4/user', pick: ['id', 'username', 'name', 'state', 'web_url'] });
  rules.push({ host: target.host, method: 'POST', path: '/api/graphql', graphql: { forge: 'gitlab', repo: target.repo, roots: GITLAB_ROOTS, mutations: [], identity: me } });
  return rules;
}

/// The exact rules of one task, or null for a forge, kind, item or identity the catalogue
/// has no entry for. `forge` is "github" or "gitlab"; `kind` one of review, review-own,
/// conflicts, issues, audit, investigate; `pool` the pool id (`github.com/owner/repo`), or
/// `{ id, projectId }` to also allow a GitLab project's numeric spelling; `item` is
/// `pr-<n>` or `issue-<n>` with a number up to 2147483647, or `job-<id>`; `identity` the
/// forge login the task acts as.
/// `options`: verdict, markReady, noPRs, assign, comment, readOnly, author.
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
