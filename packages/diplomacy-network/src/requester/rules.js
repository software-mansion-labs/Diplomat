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
// - Reads are listed by what a kind's work needs, not by what is harmless. Every kind
//   reads the repository's code - files, refs, commits, a compare, the statuses and check
//   results recorded on a commit - and, as context, what every pull request and issue of
//   the repository says and what was said on it. A task reads the lists the forge keeps
//   of an item - a pull request's files and commits, an issue's events - for its own item
//   only: the PR or issue it is pinned to, or for a job a PR the forge says it covers. A
//   PR's diff is no such list: it is repository code, which every kind reads as a compare
//   and, on GitHub, as the PR itself in diff or patch form (`gh pr diff`). A CI run, its
//   jobs and logs are read when the forge says the run is of a branch the task made, of
//   the head branch of such a PR, or - audit and investigate, whose subject is the
//   repository as it stands - of the default branch. Nothing else is listed: no list of
//   runs, artifacts, releases, deployments, events, contributors, archives, labels,
//   milestones, and none of the repository's settings.
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
//   requester's access level, which `gh pr create` asks for. From the repository it goes
//   on to what every kind reads and to nothing else (`repo` there); below that it is
//   checked by field name, the same for every pull request and issue.
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
// - Text the task writes is `prose` (PROTOCOL.md): no "@" before a name, no "bors" and no
//   line starting with "/" and a word, which GitLab runs as a quick action in the author's
//   name and bots on either forge take for a command from the author (/merge, bors r+,
//   @dependabot merge). A comment, a review or a note is sent with a hidden first line
//   (`COMMENT_MARK`), so a bot that acts on a comment's first word (atlantis apply) does not,
//   and holds none of policy-bot's default approval words. On GitHub, text on a pull request
//   is also checked against the repository's policy-bot policy (`policy`).
// - `GET /user` answers with a handful of public members only (`pick`): agents ask it
//   who they are, and the full answer holds the requester's private profile.
// - A GitHub Enterprise Server gets github.com's rules on its one host, and one more:
//   `GET /meta`, cut to the server's version. gh 2.101.0 asks for it before `pr view`,
//   `issue view`, `pr create` and a search, and gives the search up without an answer.

import { knownMutations } from './graphql.js';

/// How many branches an `audit` task may create.
export const AUDIT_BRANCHES = 24;

const GITHUB_COM = 'github.com';

/// Where a GitHub host serves its API, as gh reaches it: github.com on a host of its own,
/// a GitHub Enterprise Server under /api/v3 and /api/graphql of the host it serves git
/// on. Null for a host whose API gh looks for on another name again: a subdomain of
/// github.com or of ghe.com, and github.localhost.
export function githubApi(host) {
  if (host === GITHUB_COM) return { host: 'api.github.com', rest: '', graphql: '/graphql' };
  if (/(^|\.)(github\.com|ghe\.com|github\.localhost)$/.test(host.replace(/:[0-9]*$/, ''))) return null;
  return { host, rest: '/api/v3', graphql: '/api/graphql' };
}

// What every kind reads of a GitHub repository's code: files, refs and commits, with what
// is recorded on a commit - its comments, statuses and check results.
const GITHUB_CODE = [
  'contents/**', 'git/**', 'commits/**', 'tags', 'readme/**', 'license',
  'check-runs/*', 'check-runs/*/annotations', 'check-suites/*', 'check-suites/*/check-runs',
];
// And of every pull request and issue in it, as context: what it says and what was said
// on it.
const GITHUB_CONTEXT = [
  'pulls', 'pulls/comments', 'pulls/comments/*', 'pulls/*', 'pulls/*/comments', 'pulls/*/reviews', 'pulls/*/reviews/*',
  'pulls/*/reviews/*/comments', 'issues', 'issues/comments', 'issues/comments/*', 'issues/*', 'issues/*/comments',
];
// The rest of a pull request and of an issue, read by the task whose item it is. A pull
// request is an issue as well.
const GITHUB_PULL = ['files', 'commits', 'requested_reviewers', 'merge'];
const GITHUB_ISSUE = ['events', 'labels', 'reactions'];
// A CI run, its jobs and their logs, named by the id of the run or of a job: read when
// the forge says the run is of a branch the task works on (`run`).
const GITHUB_RUNS = [
  ['actions/runs/*', 'run'], ['actions/runs/*/jobs', 'run'], ['actions/runs/*/logs', 'run'], ['actions/runs/*/attempts/*', 'run'],
  ['actions/runs/*/attempts/*/jobs', 'run'], ['actions/runs/*/attempts/*/logs', 'run'], ['actions/jobs/*', 'job'], ['actions/jobs/*/logs', 'job'],
];
// Reads no kind is given, refused with the reason: an issue's timeline, sub-issues, parent
// and dependencies carry the issues and pull requests of other repositories that refer
// to it.
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
// The same lists for GitLab. A branch's or a tag's name is one segment there, its slashes
// encoded; "**" after it gives the path that name would be with them decoded a rule too.
const GITLAB_CODE = ['repository/files/**', 'repository/tree', 'repository/blobs/**', 'repository/commits/**', 'repository/tags/**'];
const GITLAB_CONTEXT = [
  'merge_requests', 'merge_requests/*', 'merge_requests/*/notes', 'merge_requests/*/notes/*', 'merge_requests/*/discussions',
  'merge_requests/*/discussions/*', 'issues', 'issues/*', 'issues/*/notes', 'issues/*/notes/*', 'issues/*/discussions', 'issues/*/discussions/*',
];
const GITLAB_PULL = ['versions', 'versions/*', 'changes', 'diffs', 'raw_diffs', 'commits', 'pipelines', 'approvals', 'draft_notes', 'draft_notes/*', 'award_emoji'];
const GITLAB_ISSUE = ['resource_label_events', 'resource_state_events', 'award_emoji'];
const GITLAB_RUNS = [['pipelines/*', 'run'], ['pipelines/*/jobs', 'run'], ['jobs/*', 'job'], ['jobs/*/trace', 'job']];
// Reads no kind is given, refused with the reason: answers that hold other projects'
// issues and merge requests, the address a person posted from, and a GET that writes a ref.
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
// An issue as GitLab answers it, to a read or to a write, carries the address of whoever
// wrote it in through the Service Desk: that member is let out as null.
const ISSUE_BLANK = { blank: ['service_desk_reply_to'] };
const GITLAB_BLANK = { issues: ISSUE_BLANK, 'issues/*': ISSUE_BLANK };
// A GitLab branch without who may push to it or merge into it, the requester included.
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

const PULL_KINDS = ['review', 'review-own', 'conflicts'];
const PROSE = { prose: true };
const COMMENT = { prose: true, comment: true };

// Whose CI runs a kind reads beside those of the branches the task itself made: the ones
// of the head branch of a pull request it covers (`head`), or of the default branch
// (`base`). Null for a task that has no branch to watch.
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
  // Text policy-bot reads: a review's body and a comment on the pull request or issue the
  // path's number names.
  const READ = { ...COMMENT, policy: { segment: under + 4 } };
  const rules = [];
  const mutations = [];
  let graphqlItem;

  // Smart HTTP addresses a repository with or without ".git". After the pool's own come
  // the task account's repositories, whatever their names: the push check lets through
  // the one the forge calls that account's fork of the pool's (`fork`).
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
  // A search takes its query and how the answer is paged and ordered.
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
  // A merge request is a draft by its title, and nothing else in the body may point it
  // at another project or merge it. A label is made by naming it, replaces another of its
  // scope and can start a pipeline: glab sends the empty list, as gh sends none.
  const draft = {
    source_branch: { created: true, required: true }, title: { prefix: 'Draft:', prose: true, required: true },
    target_branch: 'free', description: PROSE, labels: { equals: '' }, remove_source_branch: 'free', squash: 'free', allow_collaboration: 'free',
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

/// The exact rules of one task, or null for a forge, kind, item or identity the catalogue
/// has no entry for. `forge` is "github" or "gitlab"; `kind` one of review, review-own,
/// conflicts, issues, audit, investigate; `pool` the pool id (`github.com/owner/repo`, or
/// the same under the host of a GitHub Enterprise Server or a GitLab), or
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
