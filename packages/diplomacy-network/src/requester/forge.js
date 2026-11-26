// Performs authorised requests with this machine's forge credential (PROTOCOL.md section
// 9) and answers the deep checks' questions. The credential, read from gh or glab, never
// leaves this file: not in a log line, an error, or what goes back to the executor.

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { authorized, conclude } from './authorize.js';
import { readPolicy } from './policybot.js';
import { githubApi } from './rules.js';
import { FORGE_ORIGINS, FORGE_RESPONSE_MAX_BYTES, FORGE_TIMEOUT_MS, GH_BIN, GIT_BIN, GIT_TIMEOUT_MS, GLAB_BIN, TOKEN_TTL_MS } from '../paths.js';

// Every other request header is dropped: authorization, cookies, the host, hop-by-hop
// headers, and the method-override headers some servers obey.
const REQUEST_HEADERS = new Set(['accept', 'content-type', 'content-encoding', 'git-protocol', 'x-github-api-version', 'if-none-match']);
const RESPONSE_HEADERS = new Set([
  'content-type', 'link', 'etag', 'location', 'retry-after', 'x-github-request-id',
  'x-total', 'x-total-pages', 'x-page', 'x-per-page', 'x-next-page', 'x-prev-page',
]);
const USER_AGENT = 'diplomacy-network';
// A host as GITLAB_HOST spells it, with or without a scheme.
const hostName = (value) => {
  try { return new URL(value.includes('://') ? value : `https://${value}`).host; } catch { return ''; }
};
// The host a GITLAB_REPO names, as glab reads one: in a URL (`https://` or `git@host:`), or
// first of three or more parts when it holds a "." or ":"; '' for a bare GROUP/REPO.
const repoHost = (value) => {
  const scp = /^[^@/:]+@([^/:]+):/.exec(value);
  if (scp) return hostName(scp[1]);
  if (value.includes('://')) return hostName(value);
  const [first, ...rest] = value.split('/');
  return rest.length >= 2 && /[.:]/.test(first) ? hostName(first) : '';
};
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const blanked = (value, names) => {
  if (Array.isArray(value)) return value.map((v) => blanked(v, names));
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, names.has(k) ? null : blanked(v, names)]));
};

const NODE_QUERY = `query($id: ID!) { node(id: $id) { __typename
  ... on Repository { nameWithOwner }
  ... on User { login }
  ... on Bot { login }
  ... on PullRequest { number state author { login } repository { nameWithOwner } }
  ... on Issue { number state author { login } repository { nameWithOwner } }
  ... on PullRequestReviewThread { pullRequest { number state author { login } repository { nameWithOwner } } }
  ... on PullRequestReview { reviewState: state author { login } pullRequest { number state author { login } repository { nameWithOwner } } }
  ... on PullRequestReviewComment { commentState: state author { login } pullRequest { number state author { login } repository { nameWithOwner } } }
  ... on IssueComment { author { login } issue { number state author { login } repository { nameWithOwner } } }
} }`;

const PROTECTION_QUERY = `query($owner: String!, $name: String!, $after: String) { repository(owner: $owner, name: $name) {
  viewerPermission branchProtectionRules(first: 100, after: $after) { nodes { pattern } pageInfo { hasNextPage endCursor } } } }`;
const PROTECTION_PAGES = 10;

// Whether a classic GitHub rule that covers the protected branch `held` would likely cover
// `name` too, for an account that cannot read the rule itself: a branch beside it under the
// same "/", or one that differs from it only in its digits (`v1.2`, `9-stable`).
function akin(held, name) {
  const [a, b] = [held.toLowerCase(), name.toLowerCase()];
  const dir = (n) => n.slice(0, n.lastIndexOf('/') + 1);
  return (dir(a) !== '' && dir(a) === dir(b)) || a.replace(/[0-9]+/g, '0') === b.replace(/[0-9]+/g, '0');
}

// Whether a protection rule's name or pattern could cover a branch name. It reads wider
// than either forge: case is not told apart, `*` and `{...}` match any run of characters,
// "/" among them (GitLab's `*` spans it, GitHub's does not), and `?` and `[...]` any one.
function mayCover(pattern, name) {
  const literal = (c) => c.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    const close = { '[': pattern.indexOf(']', i + 2), '{': pattern.indexOf('}', i + 1) }[c] ?? -1;
    if (c === '*') re += '.*';
    else if (c === '?') re += '.';
    else if (close !== -1) { re += c === '[' ? '.' : '.*'; i = close; }
    else if (c === '\\' && i + 1 < pattern.length) re += literal(pattern[++i]);
    else re += literal(c);
  }
  return new RegExp(`^${re}$`, 'is').test(name);
}

function run(bin, args, env) {
  return new Promise((resolve) => {
    execFile(bin, args, { env, timeout: GIT_TIMEOUT_MS, maxBuffer: 2 ** 20, encoding: 'utf8' }, (err, stdout) => {
      resolve({ ok: !err, stdout: stdout || '' });
    });
  });
}

// For a glab that will not print the token it keeps for a host.
function glabConfigToken(host) {
  const dirs = [
    process.env.GLAB_CONFIG_DIR,
    process.env.XDG_CONFIG_HOME && path.join(process.env.XDG_CONFIG_HOME, 'glab-cli'),
    path.join(os.homedir(), '.config', 'glab-cli'),
    path.join(os.homedir(), 'Library', 'Application Support', 'glab-cli'),
  ].filter(Boolean);
  for (const dir of dirs) {
    let text;
    try { text = fs.readFileSync(path.join(dir, 'config.yml'), 'utf8'); } catch { continue; }
    let hosts = false;
    let depth = 0; // how far the hosts' names are indented, once the first is read
    let current = '';
    for (const line of text.split('\n')) {
      const body = line.trim();
      if (body === '' || body[0] === '#') continue;
      const indent = line.length - line.trimStart().length;
      if (indent === 0) { hosts = body.split(':')[0] === 'hosts'; continue; }
      if (!hosts) continue;
      depth ||= indent;
      // A name is the whole line up to its last colon, so it may hold a port; in quotes
      // or not. Any other line this far out ends the entry before it and starts none.
      if (indent <= depth) { current = body.endsWith(':') ? body.slice(0, -1).replace(/^(["'])(.*)\1$/, '$2') : ''; continue; }
      // glab writes the token behind a "!!null" tag.
      const token = /^token:\s*(.+)$/.exec(body);
      if (current === host && token) return token[1].replace(/^!!null\s+/, '').replace(/^["']|["']$/g, '');
    }
  }
  return '';
}

/// Every function but `perform` and `context` takes `{ forge, host }` first, the host
/// naming the credential. A lookup throws when the forge's answer does not settle its
/// question.
export function createForge({ log = () => {} } = {}) {
  const tokens = new Map(); // "forge host" -> { token, at }
  // claim -> { bases: base branch -> `policy`'s answer, texts: hash of the files -> same }
  const policies = new WeakMap();
  const [MAX_POLICIES, MAX_BASES] = [8, 64];

  async function token(forge, host) {
    const key = `${forge} ${host}`;
    const hit = tokens.get(key);
    if (hit && Date.now() - hit.at < TOKEN_TTL_MS) return hit.token;
    let value = '';
    // A host's token is the one its tool keeps for that host (gh 2.101.0 and glab 1.128.0, tried).
    if (forge === 'github') {
      // gh hands these two to every host but github.com.
      const { GH_ENTERPRISE_TOKEN, GITHUB_ENTERPRISE_TOKEN, ...env } = process.env;
      value = (await run(GH_BIN, ['auth', 'token', '--hostname', host], env)).stdout.trim();
    } else if (forge === 'gitlab') {
      // glab hands these three to its default host, GITLAB_REPO's and every host its config
      // holds (glab 1.128.0, internal/config); they are taken as the default host's alone, the
      // one `glab config get host` names, and as nobody's when GITLAB_REPO or GITLAB_URL
      // (which glab's help says names a host, though its code does not read it) names another.
      const { GITLAB_TOKEN, GITLAB_ACCESS_TOKEN, OAUTH_TOKEN, ...bare } = process.env;
      const glab = async (args, vars) => (await run(GLAB_BIN, args, vars)).stdout.trim();
      const meant = hostName(await glab(['config', 'get', 'host'], process.env));
      const named = [hostName(process.env.GITLAB_URL ?? ''), repoHost(process.env.GITLAB_REPO ?? '')].filter(Boolean);
      const env = meant === host && named.every((other) => other === meant) ? process.env : bare;
      // glab gives a host it holds nothing for its config's top-level token: one it gives
      // a host that cannot exist too is not taken.
      const ask = (of, vars) => glab(['config', 'get', 'token', '--host', of], vars);
      const [own, anyHost] = await Promise.all([ask(host, env), ask('host.invalid', bare)]);
      value = (own !== anyHost ? own : '') || glabConfigToken(host);
    }
    if (!/^[\x21-\x7e]+$/.test(value)) throw new Error(`forge: no ${forge} credential for ${host} on this machine`);
    tokens.set(key, { token: value, at: Date.now() });
    return value;
  }

  const origin = (host) => (typeof FORGE_ORIGINS[host] === 'string' ? FORGE_ORIGINS[host].replace(/\/$/, '') : `https://${host}`);
  // Null for a GitHub this cannot ask.
  const apiOf = ({ forge, host }) => (forge === 'github' ? githubApi(host) : { host, rest: '/api' });
  // Smart HTTP takes a basic credential; both forges' APIs take a bearer one.
  const isApi = (at, host, request) => request.host === at.host && (at.host !== host || request.path.startsWith('/api/'));
  const basic = (forge, value) => `Basic ${Buffer.from(`${forge === 'github' ? 'x-access-token' : 'oauth2'}:${value}`).toString('base64')}`;

  async function send({ forge, host }, request) {
    const at = apiOf({ forge, host });
    if (!at || (request.host !== at.host && request.host !== host)) throw new Error(`forge: ${request.host} is not a host of ${forge} ${host}`);
    const secret = await token(forge, host);
    const headers = { 'user-agent': USER_AGENT };
    for (const [name, value] of Object.entries(request.headers || {})) {
      if (REQUEST_HEADERS.has(name.toLowerCase())) headers[name.toLowerCase()] = value;
    }
    headers.authorization = isApi(at, host, request) ? `Bearer ${secret}` : basic(forge, secret);
    const body = Buffer.isBuffer(request.body) ? request.body : Buffer.from(request.body || '', 'base64');
    const started = Date.now();
    let res;
    const chunks = [];
    try {
      // A redirect is handed back, never followed: its target was not authorised, and
      // following it would carry the credential there.
      res = await fetch(origin(request.host) + request.path, {
        method: request.method,
        headers,
        body: body.length > 0 && request.method !== 'GET' ? body : undefined,
        redirect: 'manual',
        signal: AbortSignal.timeout(FORGE_TIMEOUT_MS),
      });
      let size = 0;
      for await (const chunk of res.body || []) {
        size += chunk.length;
        if (size > FORGE_RESPONSE_MAX_BYTES) throw Object.assign(new Error('too large'), { name: 'TooLarge' });
        chunks.push(chunk);
      }
    } catch (err) {
      const why = err.name === 'TooLarge' ? 'the answer is larger than a task may receive'
        : err.name === 'TimeoutError' ? 'no answer in time' : `unreachable (${err.cause?.code || err.name})`;
      log(`forge ${request.method} ${request.host}${request.path.split('?')[0]} failed: ${why}`);
      throw new Error(`forge: ${request.method} ${request.host}: ${why}`);
    }
    log(`forge ${request.method} ${request.host}${request.path.split('?')[0]} -> ${res.status} in ${Date.now() - started} ms`);
    return { status: res.status, headers: res.headers, body: Buffer.concat(chunks) };
  }

  /// Sends a request `authorize` allowed; resolves to `{ status, headers, body }`, body
  /// base64 and headers cut to what an executor may see. Whatever the outcome, the task's
  /// state is told what became of the request.
  async function perform(request, { forge, host }) {
    if (!authorized(request)) throw new Error('forge: perform was given a request authorize did not allow');
    let res;
    try {
      res = await send({ forge, host }, request);
    } finally {
      conclude(request, res);
    }
    const headers = {};
    for (const [name, value] of res.headers) {
      if (RESPONSE_HEADERS.has(name) || name.startsWith('x-ratelimit-')) headers[name] = value;
    }
    let { status, body } = res;
    if ((request.pick || request.blank) && status >= 200 && status < 300) {
      // `pick` applies to the answer or each entry of a list; `blank` members become null
      // wherever they stand.
      let whole;
      try { whole = JSON.parse(body.toString('utf8')); } catch {}
      const cut = (object) => Object.fromEntries(request.pick.filter((k) => Object.hasOwn(object, k)).map((k) => [k, object[k]]));
      if (request.pick) whole = isObject(whole) ? cut(whole) : Array.isArray(whole) && whole.every(isObject) ? whole.map(cut) : undefined;
      if (request.blank && whole !== undefined) whole = blanked(whole, new Set(request.blank));
      if (whole === undefined) {
        status = 502;
        body = Buffer.from('{"message":"the forge\'s answer could not be reduced"}');
      } else {
        body = Buffer.from(JSON.stringify(whole));
      }
    }
    return { status, headers, body: body.toString('base64') };
  }

  // Outside any task's rules: every caller builds its path from values it has already
  // confined.
  async function api(target, method, apiPath, json) {
    const at = apiOf(target);
    if (!at) throw new Error(`forge: ${target.host} is not a GitHub host this can ask`);
    const res = await send(target, {
      host: at.host,
      method,
      path: apiPath === '/graphql' ? at.graphql : `${at.rest}${apiPath}`,
      headers: { accept: 'application/json', ...(json ? { 'content-type': 'application/json' } : {}) },
      body: json ? Buffer.from(JSON.stringify(json)) : Buffer.alloc(0),
    });
    let parsed = null;
    try { parsed = JSON.parse(res.body.toString('utf8')); } catch {}
    return { status: res.status, json: parsed };
  }
  const project = (repo) => `/v4/projects/${encodeURIComponent(repo)}`;
  const str = (v) => (typeof v === 'string' ? v : '');

  // A lookup answers what the forge holds, null when the forge itself says there is no
  // such thing, and throws on any other answer: a rate limit, an outage or a proxy's page
  // says nothing about what exists, and an executor can bring the first about.
  const unknown = (what, res) => { throw new Error(`forge: the forge did not say ${what} (it answered ${res.status})`); };
  const missing = (res, wording = /not found$/i) => res.status === 404 && typeof res.json?.message === 'string' && wording.test(res.json.message);

  /// `{ type, repo, item: "pr"|"issue", number, open, itemAuthor, author, pending }` for
  /// something in a repository, `{ type, login }` for an account, or null when the forge
  /// shows nothing for the id (always on GitLab, whose ids this cannot resolve).
  async function resolveNode(target, id) {
    if (target.forge !== 'github' || typeof id !== 'string') return null;
    const res = await api(target, 'POST', '/graphql', { query: NODE_QUERY, variables: { id } });
    const said = `what ${id.slice(0, 80)} is`;
    if (res.status !== 200 || !isObject(res.json?.data)) unknown(said, res);
    const node = res.json.data.node;
    if (node === null) {
      // GitHub answers an id it does not show with a NOT_FOUND error beside the null.
      const errors = res.json.errors ?? [];
      if (!Array.isArray(errors) || errors.some((e) => e?.type !== 'NOT_FOUND')) unknown(said, res);
      return null;
    }
    if (!isObject(node)) unknown(said, res);
    const type = str(node.__typename);
    if (type === 'Repository') return { type, repo: str(node.nameWithOwner) };
    if (type === 'User' || type === 'Bot') return { type, login: str(node.login) };
    const pr = type === 'PullRequest' ? node : node.pullRequest;
    const issue = type === 'Issue' ? node : node.issue;
    const holder = pr || issue;
    if (!holder || !Number.isInteger(holder.number)) return null;
    return {
      type,
      repo: str(holder.repository?.nameWithOwner),
      item: pr ? 'pr' : 'issue',
      number: holder.number,
      open: holder.state === 'OPEN',
      itemAuthor: str(holder.author?.login),
      author: str(node.author?.login),
      pending: (node.reviewState || node.commentState) === 'PENDING',
    };
  }

  const id = (v) => (Number.isSafeInteger(v) ? v : null);
  const githubPull = (p) => ({ number: p.number, open: p.state === 'open', author: str(p.user?.login), headRepo: str(p.head?.repo?.full_name), headRepoId: id(p.head?.repo?.id), headRef: str(p.head?.ref), baseRef: str(p.base?.ref), draft: p.draft === true });
  // A merge request names the project its source branch is in by id alone: a fork's has no name here.
  const gitlabPull = (repo, m) => ({ number: m.iid, open: m.state === 'opened', author: str(m.author?.username), headRepo: m.source_project_id === m.target_project_id ? repo : '', headRepoId: id(m.source_project_id), headRef: str(m.source_branch), baseRef: str(m.target_branch), draft: m.draft === true });

  /// `{ number, open, author, headRepo, headRepoId, headRef, baseRef, draft }`, or null
  /// when the forge has none of that number. `headRepoId` is null when the head's
  /// repository is gone.
  async function pull(target, repo, number) {
    const github = target.forge === 'github';
    const res = await api(target, 'GET', github ? `/repos/${repo}/pulls/${number}` : `${project(repo)}/merge_requests/${number}`);
    if (missing(res)) return null;
    if (res.status !== 200 || !isObject(res.json) || (github ? res.json.number : res.json.iid) !== number) unknown(`what #${number} is`, res);
    return github ? githubPull(res.json) : gitlabPull(repo, res.json);
  }

  /// Open requests whose head branch is `ref` (with no `ref`, the first 100 open ones),
  /// shaped as `pull`; `ever` adds closed and merged ones. GitHub lists only heads in a
  /// repository of `owner`; GitLab lists them whichever project the branch is in.
  async function pullsByHead(target, repo, ref, owner = repo.split('/')[0], ever = false) {
    const github = target.forge === 'github';
    const filter = ref === undefined ? '' : github ? `&head=${encodeURIComponent(`${owner}:${ref}`)}` : `&source_branch=${encodeURIComponent(ref)}`;
    const state = ever ? 'all' : github ? 'open' : 'opened';
    const res = await api(target, 'GET', github ? `/repos/${repo}/pulls?state=${state}&per_page=100${filter}` : `${project(repo)}/merge_requests?state=${state}&per_page=100${filter}`);
    if (res.status !== 200 || !Array.isArray(res.json) || !res.json.every(isObject)) unknown('which pull requests there are', res);
    return res.json.map((p) => (github ? githubPull(p) : gitlabPull(repo, p)));
  }

  /// The branch a CI run (`what` "run") or job ran for: `{ repo, ref }`, or null when the
  /// forge has no such run or it ran for a tag. A merge request pipeline ran for its source
  /// branch and also names the merge request as `pull`. GitHub names a tag's run by the tag
  /// alone, so it reads as a run of a branch so named.
  async function ciRun(target, repo, what, id) {
    const github = target.forge === 'github';
    const said = `what CI ${what} ${id} ran for`;
    const base = github ? `/repos/${repo}/actions` : project(repo);
    const one = async (path, of) => {
      const res = await api(target, 'GET', `${base}/${path}/${of}`);
      if (missing(res)) return null;
      if (res.status !== 200 || !isObject(res.json) || res.json.id !== of) unknown(said, res);
      return res.json;
    };
    let found = await one(what === 'job' ? 'jobs' : github ? 'runs' : 'pipelines', id);
    if (github && found && what === 'job') {
      if (!Number.isSafeInteger(found.run_id)) unknown(said, { status: 200 });
      found = await one('runs', found.run_id);
    }
    if (!found) return null;
    const branch = github ? found.head_branch : found.ref;
    const holder = github ? found.head_repository?.full_name : repo;
    if (typeof branch !== 'string' || branch === '' || typeof holder !== 'string' || holder === '') unknown(said, { status: 200 });
    // GitLab says when a pipeline is a tag's.
    if (found.tag === true) return null;
    const request = github ? null : /^refs\/merge-requests\/([1-9][0-9]{0,9})\/[a-z]+$/.exec(branch);
    if (!request) return { repo: holder, ref: `refs/heads/${branch}` };
    const from = await pull(target, repo, Number(request[1]));
    return from && { repo: from.headRepo, ref: `refs/heads/${from.headRef}`, pull: from.number };
  }

  /// A GitHub review comment of `repo` by its REST id, resolved like a node, or null.
  async function comment(target, repo, id) {
    if (target.forge !== 'github') return null;
    const res = await api(target, 'GET', `/repos/${repo}/pulls/comments/${id}`);
    if (missing(res)) return null;
    if (res.status !== 200 || typeof res.json?.node_id !== 'string') unknown(`what comment ${id} is`, res);
    return resolveNode(target, res.json.node_id);
  }

  /// Who is assigned to an issue of `repo`: logins on GitHub, account ids on GitLab; null
  /// when the forge has no issue of that number.
  async function assignees(target, repo, number) {
    const github = target.forge === 'github';
    const res = await api(target, 'GET', github ? `/repos/${repo}/issues/${number}` : `${project(repo)}/issues/${number}`);
    if (missing(res)) return null;
    const list = res.status === 200 && Array.isArray(res.json?.assignees) ? res.json.assignees.map((a) => (github ? a?.login : a?.id)) : null;
    if (!list || !list.every((who) => (github ? typeof who === 'string' && who !== '' : Number.isSafeInteger(who) && who > 0))) unknown(`who is assigned to #${number}`, res);
    return list;
  }

  /// The account the credential belongs to: `{ id, login }`.
  async function self(target) {
    const github = target.forge === 'github';
    const res = github ? await api(target, 'POST', '/graphql', { query: '{ viewer { id login } }' }) : await api(target, 'GET', '/v4/user');
    const me = github ? res.json?.data?.viewer : res.json;
    const login = github ? me?.login : me?.username;
    if (res.status !== 200 || typeof login !== 'string' || login === '' || !(github ? typeof me.id === 'string' : Number.isSafeInteger(me.id))) unknown('which account this is', res);
    return { id: me.id, login };
  }

  /// `{ id, name, owner, parent, defaultBranch, ciPaths }`, or null when the forge shows no
  /// such repository (on GitLab `repo` may be a numeric id). `name` is the forge's
  /// spelling of its full path; `parent` is "" for no fork. `ciPaths` is where a GitLab
  /// project reads its CI configuration, when that is a file of its own repository.
  async function repository(target, repo) {
    const github = target.forge === 'github';
    const res = await api(target, 'GET', github ? `/repos/${repo}` : project(repo));
    if (missing(res)) return null;
    const branch = res.status === 200 && isObject(res.json) ? res.json.default_branch : undefined;
    if (typeof branch !== 'string' || branch === '') unknown('which branch is the default', res);
    const name = str(github ? res.json.full_name : res.json.path_with_namespace);
    const ciPaths = [];
    const configured = github ? null : res.json.ci_config_path;
    if (configured !== null && typeof configured !== 'string') unknown('where the project reads its CI configuration from', res);
    const add = (file) => {
      const relative = file.replace(/^\/+/, '');
      if (relative !== '') ciPaths.push(relative);
    };
    if (configured) {
      // GitLab reads a file of the repository with exactly the configured name before it
      // reads the value as "file@project" or as a URL.
      add(configured);
      const at = configured.indexOf('@');
      if (at !== -1 && configured.slice(at + 1).split(':')[0].toLowerCase() === name.toLowerCase()) add(configured.slice(0, at));
    }
    const owner = github ? res.json.owner?.login : res.json.namespace?.full_path;
    // Each forge leaves the parent out of its answer about a repository that is no fork.
    const origin = github ? res.json.parent : res.json.forked_from_project;
    const parent = origin === undefined ? '' : github ? origin?.full_name : origin?.path_with_namespace;
    // The answer is about what was asked for: a project's number on GitLab, a name anywhere.
    const asked = /^[0-9]+$/.test(repo) ? String(res.json.id) === repo : name.toLowerCase() === repo.toLowerCase();
    if (!asked || !Number.isSafeInteger(res.json.id) || typeof owner !== 'string' || owner === '' || typeof parent !== 'string' || (origin !== undefined && parent === '')) unknown(`which repository ${repo} is`, res);
    return { id: res.json.id, name, owner, parent, defaultBranch: branch, ciPaths };
  }

  /// A branch (`refs/heads/...`) of `repo` as the forge holds it: `{ sha, protected }`, or
  /// null when the forge says there is no such branch.
  async function branch(target, repo, ref) {
    const said = `where ${ref} is`;
    if (!ref.startsWith('refs/heads/')) throw new Error(`forge: ${ref} is not a branch`);
    const name = ref.slice('refs/heads/'.length);
    const github = target.forge === 'github';
    const res = await api(target, 'GET', github ? `/repos/${repo}/branches/${name.split('/').map(encodeURIComponent).join('/')}` : `${project(repo)}/repository/branches/${encodeURIComponent(name)}`);
    // The forge's wording for the branch alone: "Not Found" is the repository's.
    if (missing(res, github ? /^Branch not found$/ : /^404 Branch Not Found$/)) return null;
    const sha = res.status === 200 ? (github ? res.json?.commit?.sha : res.json?.commit?.id) : undefined;
    if (typeof sha !== 'string' || !/^[0-9a-f]{40,64}$/.test(sha) || typeof res.json.protected !== 'boolean' || res.json.name !== name) unknown(said, res);
    return { sha, protected: res.json.protected };
  }

  /// Whether a protection rule of `repo` would cover a branch `ref` that nothing holds yet:
  /// on GitHub an active ruleset's rule or a classic rule's pattern, on GitLab a protected
  /// branch's name or wildcard. Only what the account may read of them is known.
  async function protects(target, repo, ref) {
    if (!ref.startsWith('refs/heads/')) throw new Error(`forge: ${ref} is not a branch`);
    const name = ref.slice('refs/heads/'.length);
    const said = `which protection rules cover ${ref}`;
    const patterns = [];
    if (target.forge === 'github') {
      // GitHub answers this for a name no branch has yet.
      const rules = await api(target, 'GET', `/repos/${repo}/rules/branches/${name.split('/').map(encodeURIComponent).join('/')}`);
      if (rules.status !== 200 || !Array.isArray(rules.json)) unknown(said, rules);
      if (rules.json.length > 0) return true;
      const [owner, short] = repo.split('/');
      let after = null;
      let admin;
      for (let page = 0; ; page++) {
        if (page === PROTECTION_PAGES) throw new Error(`forge: the forge did not say ${said} (it has more than ${PROTECTION_PAGES} pages of them)`);
        const res = await api(target, 'POST', '/graphql', { query: PROTECTION_QUERY, variables: { owner, name: short, after } });
        const found = res.json?.data?.repository?.branchProtectionRules;
        if (res.status !== 200 || res.json?.errors !== undefined || !Array.isArray(found?.nodes) || typeof found.pageInfo?.hasNextPage !== 'boolean') unknown(said, res);
        admin ??= res.json.data.repository.viewerPermission === 'ADMIN';
        patterns.push(...found.nodes.map((n) => n?.pattern));
        if (!found.pageInfo.hasNextPage) break;
        after = found.pageInfo.endCursor;
      }
      // To an account that is no admin of the repository GitHub answers its classic rules
      // as none, with no error (asked of cli/cli). Which branches are protected, by a rule
      // or a ruleset, it lists to whoever reads the repository.
      if (!admin) {
        for (let page = 1; ; page++) {
          if (page > PROTECTION_PAGES) throw new Error(`forge: the forge did not say ${said} (it has more than ${PROTECTION_PAGES} pages of protected branches)`);
          const res = await api(target, 'GET', `/repos/${repo}/branches?protected=true&per_page=100&page=${page}`);
          if (res.status !== 200 || !Array.isArray(res.json) || !res.json.every((b) => typeof b?.name === 'string')) unknown(said, res);
          if (res.json.some((b) => akin(b.name, name))) return true;
          if (res.json.length < 100) break;
        }
      }
    } else {
      for (let page = 1; ; page++) {
        if (page > PROTECTION_PAGES) throw new Error(`forge: the forge did not say ${said} (it has more than ${PROTECTION_PAGES} pages of them)`);
        const res = await api(target, 'GET', `${project(repo)}/protected_branches?per_page=100&page=${page}`);
        if (res.status !== 200 || !Array.isArray(res.json)) unknown(said, res);
        patterns.push(...res.json.map((b) => b?.name));
        if (res.json.length < 100) break;
      }
    }
    if (!patterns.every((p) => typeof p === 'string')) throw new Error(`forge: the forge did not say ${said} (a rule without a name)`);
    return patterns.some((p) => mayCover(p, name));
  }

  // A file of a GitHub repository as text, at `ref` or on its default branch; null when the
  // forge has no such file there.
  async function contents(target, repo, file, ref) {
    const res = await api(target, 'GET', `/repos/${repo}/contents/${file.split('/').map(encodeURIComponent).join('/')}${ref ? `?ref=${encodeURIComponent(ref)}` : ''}`);
    if (missing(res)) return null;
    if (res.status !== 200 || res.json?.type !== 'file' || res.json.encoding !== 'base64' || typeof res.json.content !== 'string') unknown(`what ${repo}/${file} holds`, res);
    return Buffer.from(res.json.content, 'base64').toString('utf8');
  }

  /// What policy-bot would count as an approval in text on a pull request into `base`,
  /// from `.policy.yml` on `base` and the owner's `.github` `policy.yml` (read when the
  /// first is missing, or always if its server says so), each followed to a policy it
  /// names elsewhere. Resolves to `{ comments, patterns, bodies, from }` (`readPolicy`),
  /// `{ fault }` when a file cannot be read, or null when there is none. A claim keeps an
  /// answer per distinct text of the files, at most 8: a base with a ninth gets a fault.
  async function policy(target, repo, base, claim) {
    const branch = base.startsWith('refs/heads/') ? base.slice('refs/heads/'.length) : base;
    let kept = claim && policies.get(claim);
    if (claim && !kept) policies.set(claim, (kept = { bases: new Map(), texts: new Map() }));
    if (kept?.bases.has(branch)) return kept.bases.get(branch);
    const read = (from, text) => {
      try { return readPolicy(text); } catch (err) { throw new Error(`${from} cannot be read here: ${err.message}`); }
    };
    const keep = (found) => {
      if (kept && kept.bases.size < MAX_BASES) kept.bases.set(branch, found);
      return found;
    };
    const files = [[repo, '.policy.yml', branch], [`${repo.split('/')[0]}/.github`, 'policy.yml', '']];
    const texts = [];
    for (const [of, file, ref] of files) texts.push(await contents(target, of, file, ref));
    const key = createHash('sha256').update(JSON.stringify(texts)).digest('hex');
    if (kept?.texts.has(key)) return keep(kept.texts.get(key));
    if (kept && kept.texts.size >= MAX_POLICIES) return { fault: `this claim of the task has had ${MAX_POLICIES} different policies read already, the most one claim may` };
    const out = { comments: [], patterns: [], bodies: [], from: [] };
    let found = null;
    try {
      for (const [k, [of, file]] of files.entries()) {
        const text = texts[k];
        if (text === null) continue;
        let from = `${of}/${file}`;
        let held = read(from, text);
        if (held.remote) {
          const { repo: there, path: named, ref: at } = held.remote;
          const where = named || '.policy.yml';
          if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(there) || where.split('/').some((part) => ['', '.', '..'].includes(part))) throw new Error(`${from} names a remote policy in a form policy-bot does not read`);
          const far = await contents(target, there, where, at);
          if (far === null) throw new Error(`${from} names ${there}/${where}, which this machine's account cannot read`);
          from = `${there}/${where}`;
          held = read(from, far);
          // policy-bot follows one reference, and reads a second as a policy it cannot parse.
          if (held.remote) continue;
        }
        for (const list of ['comments', 'patterns', 'bodies']) out[list] = out[list].concat(held[list]);
        out.from.push(from);
        found = out;
      }
    } catch (err) {
      if (err.message.startsWith('forge: ')) throw err;
      found = { fault: err.message };
    }
    kept?.texts.set(key, found);
    return keep(found);
  }

  /// Null on GitHub or when the project is not shown.
  async function projectId(target, repo) {
    if (target.forge !== 'gitlab') return null;
    const res = await api(target, 'GET', project(repo));
    return res.status === 200 && Number.isInteger(res.json?.id) ? res.json.id : null;
  }

  /// Fetches into the repository `env` points git at (the push check's quarantine): the
  /// commits in `wants`, or with `into` every branch, as refs under that name.
  async function fetchInto(target, { repo, env, wants = [], into }) {
    if (!into && (wants.length === 0 || wants.some((oid) => !/^[0-9a-f]{40,64}$/.test(oid)))) return false;
    if (!apiOf(target) || !/^[A-Za-z0-9._/-]+$/.test(repo)) return false;
    const secret = await token(target.forge, target.host);
    // The credential rides in the environment, not in argv where `ps` would show it, and
    // is not carried along a redirect.
    const gitEnv = {
      ...env,
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'http.extraHeader',
      GIT_CONFIG_VALUE_0: `Authorization: ${basic(target.forge, secret)}`,
      GIT_CONFIG_KEY_1: 'http.followRedirects',
      GIT_CONFIG_VALUE_1: 'false',
    };
    const what = into ? [`+refs/heads/*:${into}/*`] : wants;
    const r = await run(GIT_BIN, ['fetch', '--quiet', '--no-tags', '--no-write-fetch-head', `${origin(target.host)}/${repo}.git`, ...what], gitEnv);
    log(`forge fetch ${target.host}/${repo} ${into ? 'all branches' : `${wants.length} commit(s)`} -> ${r.ok ? 'ok' : 'failed'}`);
    return r.ok;
  }

  /// `authorize`'s `ctx` for one task: lookups bound to the pool's repository, the linked
  /// `checkout` the push check may read, and the task's mutable `state`. `claim`, any
  /// object, keys what `policy` keeps. The lookups about a repository itself take another
  /// one's name where the forge said it is the task account's fork of the pool's.
  function context({ forge, host, repo, checkout, state, claim }) {
    const target = { forge, host };
    return {
      checkout,
      state,
      resolveNode: (id) => resolveNode(target, id),
      pull: (number) => pull(target, repo, number),
      pullsByHead: (ref, owner, ever) => pullsByHead(target, repo, ref, owner, ever),
      comment: (id) => comment(target, repo, id),
      run: (what, id) => ciRun(target, repo, what, id),
      assignees: (number) => assignees(target, repo, number),
      self: () => self(target),
      repository: (of = repo) => repository(target, of),
      branch: (ref, of = repo) => branch(target, of, ref),
      protects: (ref, of = repo) => protects(target, of, ref),
      policy: (base) => policy(target, repo, base, claim),
      fetch: (what) => fetchInto(target, { ...what, repo: what.repo ?? repo }),
    };
  }

  return { perform, context, resolveNode, pull, pullsByHead, comment, ciRun, assignees, self, repository, branch, protects, projectId, fetchInto };
}
