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
//                                draft pull requests from that branch.
//               assign: false    no assignment.        comment: false    no comment.
//               noPRs            the comment only: no assignment, no push, no pull request.
//   audit       -                push up to AUDIT_BRANCHES new branches and fast-forward
//                                them; open draft pull requests from them.
//               readOnly         nothing.
//   investigate -                nothing.
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
//               and its draft pull requests stay. Diplomat makes one job per issue, so a
//               job without a number has no issue of its own to write on.
//   audit, investigate   unchanged: neither is about one number.
//
// Judgement calls:
// - Reads are an allow-list of sub-trees, not "everything under the repository": Actions
//   secrets and variables, hooks, deploy keys, collaborators, environments, security
//   alerts and branch protection are settings a task has no use for and are not listed.
// - A push is addressed by the pull request, not by a branch name: the head branch is
//   whatever the forge says that PR's head is when the push arrives. On GitHub that may
//   be a branch of a fork, and then the fork is where the push goes; on GitLab only a
//   merge request whose source branch is in the pool's own project can be pushed to.
// - A push may not change CI definitions (`denyPaths`) except to what the forge already
//   holds, which is what merging the base branch does.
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
  'pulls/**', 'issues/**', 'commits/**', 'compare/**', 'contents/**', 'git/**', 'branches', 'branches/*', 'tags',
  'releases/**', 'labels/**', 'milestones/**', 'check-runs/**', 'check-suites/**', 'statuses/**', 'comments/**',
  'assignees/**', 'languages', 'topics', 'contributors', 'readme/**', 'license', 'events', 'tarball/**', 'zipball/**',
  'actions/runs/**', 'actions/jobs/**', 'actions/workflows/**', 'actions/artifacts/**',
];
const GITLAB_READS = [
  'merge_requests/**', 'issues/**', 'repository/**', 'jobs/**', 'pipelines', 'pipelines/*', 'pipelines/*/jobs',
  'labels/**', 'milestones/**', 'releases/**',
];
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

function parseItem(item) {
  const m = /^(pr|issue)-([1-9][0-9]{0,15})$/.exec(item || '');
  if (m) return { type: m[1], number: Number(m[2]) };
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

  // Smart HTTP addresses a repository with or without ".git".
  const push = (more, paths) => {
    for (const base of paths) {
      rules.push({ host: GITHUB_GIT, method: 'GET', path: `${base}/info/refs`, fold: [0, 1], query: { service: { equals: 'git-receive-pack' } }, git: 'receive-pack', repo: target.repo, ...more });
      rules.push({ host: GITHUB_GIT, method: 'POST', path: `${base}/git-receive-pack`, fold: [0, 1], git: 'receive-pack', repo: target.repo, denyPaths: ['.github/workflows/**'], ...more });
    }
  };
  const pushToPool = (more) => push(more, [`/${owner}/${name}.git`, `/${owner}/${name}`]);
  const draftPulls = () => {
    mutations.push('createPullRequest');
    rules.push(api('POST', `${repo}/pulls`, { body: {
      head: { created: true, required: true }, draft: { equals: true, required: true },
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
    if (kind !== 'review') push({ head: who }, ['/*/*']);
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
      pushToPool({ refs: ['refs/heads/**'], create: 1 });
      draftPulls();
    }
  } else if (kind === 'audit') {
    if (options.readOnly !== true) {
      pushToPool({ refs: ['refs/heads/**'], create: AUDIT_BRANCHES });
      draftPulls();
    }
  } else if (kind !== 'investigate') {
    return null;
  }

  rules.push(api('GET', repo));
  for (const tree of GITHUB_READS) rules.push(api('GET', `${repo}/${tree}`));
  rules.push({ host: GITHUB_API, method: 'GET', path: '/user', pick: ['login', 'id', 'node_id', 'type', 'name', 'html_url'] });
  rules.push({ host: GITHUB_API, method: 'GET', path: '/search/issues', query: { q: { search: target.repo } } });
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
  const push = (more) => {
    for (const base of [`/${target.repo}.git`, `/${target.repo}`]) {
      rules.push({ host: target.host, method: 'GET', path: `${base}/info/refs`, fold: gitFold, query: { service: { equals: 'git-receive-pack' } }, git: 'receive-pack', repo: target.repo, ...more });
      rules.push({ host: target.host, method: 'POST', path: `${base}/git-receive-pack`, fold: gitFold, git: 'receive-pack', repo: target.repo, denyPaths: ['.gitlab-ci.yml'], ...more });
    }
  };
  // GitLab runs a line starting with "/" in a note or description as a quick action
  // (/merge, /approve, /close), so text is `prose`: free, with no such line.
  const prose = { prose: true };
  // A merge request is a draft by its title, and nothing else in the body may point it
  // at another project or merge it.
  const draftMerges = () => each('POST', '/merge_requests', { body: {
    source_branch: { created: true, required: true }, title: { prefix: 'Draft:', required: true },
    target_branch: 'free', description: prose, labels: 'free', remove_source_branch: 'free', squash: 'free', allow_collaboration: 'free',
    // glab names the target project in every merge request it opens; it may only be the pool's own.
    ...(target.projectId === null ? {} : { target_project_id: { equals: target.projectId } }),
  } });

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
      each('PUT', `${mr}/discussions/*`, { ...asked, query: { resolved: { equals: 'true', optional: true } }, body: { resolved: { oneOf: [true, 'true'] } } });
      if (options.markReady === true) each('PUT', mr, { ...asked, body: { title: 'free' } });
    }
    if (kind !== 'review') push({ head: who });
  } else if (kind === 'issues') {
    if (item.type === 'pr') return null;
    if (item.type === 'issue') {
      const issue = `/issues/${item.number}`;
      if (options.noPRs !== true && options.assign !== false) each('PUT', issue, { body: { assignee_ids: { self: true, required: true } } });
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

  each('GET', '');
  for (const tree of GITLAB_READS) each('GET', `/${tree}`);
  rules.push({ host: target.host, method: 'GET', path: '/api/v4/user', pick: ['id', 'username', 'name', 'state', 'web_url'] });
  rules.push({ host: target.host, method: 'POST', path: '/api/graphql', graphql: { forge: 'gitlab', repo: target.repo, roots: GITLAB_ROOTS, mutations: [], identity: me } });
  return rules;
}

/// The exact rules of one task, or null for a forge, kind, item or identity the catalogue
/// has no entry for. `forge` is "github" or "gitlab"; `kind` one of review, review-own,
/// conflicts, issues, audit, investigate; `pool` the pool id (`github.com/owner/repo`), or
/// `{ id, projectId }` to also allow a GitLab project's numeric spelling; `item` is
/// `pr-<n>`, `issue-<n>` or `job-<id>`; `identity` the forge login the task acts as.
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
