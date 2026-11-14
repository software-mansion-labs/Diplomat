// Performs an authorised request on the forge with this machine's own credential
// (PROTOCOL.md section 9), and answers the questions the deep checks ask the forge. The
// credential is read from gh or glab, added here and nowhere else, and never leaves this
// file: not in a log line, not in an error, not in what goes back to the executor.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { authorized } from './authorize.js';
import { FORGE_ORIGINS, FORGE_RESPONSE_MAX_BYTES, FORGE_TIMEOUT_MS, GH_BIN, GIT_BIN, GIT_TIMEOUT_MS, GLAB_BIN, TOKEN_TTL_MS } from '../paths.js';

// What an executor may say to the forge about its request. Everything else is dropped:
// its authorization and cookies, the host, hop-by-hop headers, and the override headers
// some servers take a different method from.
const REQUEST_HEADERS = new Set(['accept', 'content-type', 'content-encoding', 'git-protocol', 'x-github-api-version', 'if-none-match']);
const RESPONSE_HEADERS = new Set([
  'content-type', 'link', 'etag', 'location', 'retry-after', 'x-github-request-id',
  'x-total', 'x-total-pages', 'x-page', 'x-per-page', 'x-next-page', 'x-prev-page',
]);
const USER_AGENT = 'diplomacy-network';

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

function run(bin, args, env) {
  return new Promise((resolve) => {
    execFile(bin, args, { env, timeout: GIT_TIMEOUT_MS, maxBuffer: 2 ** 20, encoding: 'utf8' }, (err, stdout) => {
      resolve({ ok: !err, stdout: stdout || '' });
    });
  });
}

// The token glab keeps for a host in its config file, for a glab that will not print it.
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
    let section = '';
    let current = '';
    for (const line of text.split('\n')) {
      const m = /^(\s*)([^\s#][^:]*):\s*(.*)$/.exec(line);
      if (!m) continue;
      const [, indent, key, value] = m;
      if (indent === '') { section = key; current = ''; continue; }
      if (section !== 'hosts') continue;
      if (value === '') { current = key.replace(/^["']|["']$/g, ''); continue; }
      // glab writes the token behind a "!!null" tag.
      if (current === host && key === 'token') return value.replace(/^!!null\s+/, '').replace(/^["']|["']$/g, '');
    }
  }
  return '';
}

/// The requester's side of the forge. `log` receives one line per request made, never a
/// credential. Returns `{ perform, context, resolveNode, pull, pullsByHead, comment, assignees,
/// self, currentRef, projectId, fetchInto }`; every function but `perform` and `context` takes
/// `{ forge, host }` first - "github" or "gitlab", and the host the credential is for.
export function createForge({ log = () => {} } = {}) {
  const tokens = new Map(); // "forge host" -> { token, at }

  async function token(forge, host) {
    const key = `${forge} ${host}`;
    const hit = tokens.get(key);
    if (hit && Date.now() - hit.at < TOKEN_TTL_MS) return hit.token;
    let value = '';
    if (forge === 'github') {
      value = (await run(GH_BIN, ['auth', 'token', '--hostname', host], process.env)).stdout.trim();
    } else if (forge === 'gitlab') {
      value = (await run(GLAB_BIN, ['config', 'get', 'token', '--host', host], process.env)).stdout.trim() || glabConfigToken(host);
    }
    if (!/^[\x21-\x7e]+$/.test(value)) throw new Error(`forge: no ${forge} credential for ${host} on this machine`);
    tokens.set(key, { token: value, at: Date.now() });
    return value;
  }

  const origin = (host) => (typeof FORGE_ORIGINS[host] === 'string' ? FORGE_ORIGINS[host].replace(/\/$/, '') : `https://${host}`);
  // Smart HTTP takes a basic credential; both forges' APIs take a bearer one.
  const isApi = (forge, request) => (forge === 'github' ? request.host === 'api.github.com' : request.path.startsWith('/api/'));
  const basic = (forge, value) => `Basic ${Buffer.from(`${forge === 'github' ? 'x-access-token' : 'oauth2'}:${value}`).toString('base64')}`;
  const hostsOf = (forge, host) => (forge === 'github' ? (host === 'github.com' ? ['api.github.com', 'github.com'] : []) : [host]);

  async function send({ forge, host }, request) {
    if (!hostsOf(forge, host).includes(request.host)) throw new Error(`forge: ${request.host} is not a host of ${forge} ${host}`);
    const secret = await token(forge, host);
    const headers = { 'user-agent': USER_AGENT };
    for (const [name, value] of Object.entries(request.headers || {})) {
      if (REQUEST_HEADERS.has(name.toLowerCase())) headers[name.toLowerCase()] = value;
    }
    headers.authorization = isApi(forge, request) ? `Bearer ${secret}` : basic(forge, secret);
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

  /// Sends a request `authorize` allowed and resolves to `{ status, headers, body }`, the
  /// body base64 and the headers cut to what an executor may see. `host` names the
  /// credential ("github.com", or the GitLab host). Throws for a request `authorize` did
  /// not return, a host that is not the forge's, and a forge that cannot be reached.
  async function perform(request, { forge, host }) {
    if (!authorized(request)) throw new Error('forge: perform was given a request authorize did not allow');
    const res = await send({ forge, host }, request);
    const headers = {};
    for (const [name, value] of res.headers) {
      if (RESPONSE_HEADERS.has(name) || name.startsWith('x-ratelimit-')) headers[name] = value;
    }
    let { status, body } = res;
    if (request.pick && status >= 200 && status < 300) {
      // The rule lets only some members of this answer out.
      let whole = null;
      try { whole = JSON.parse(body.toString('utf8')); } catch {}
      if (whole && typeof whole === 'object' && !Array.isArray(whole)) {
        body = Buffer.from(JSON.stringify(Object.fromEntries(request.pick.filter((k) => Object.hasOwn(whole, k)).map((k) => [k, whole[k]]))));
      } else {
        status = 502;
        body = Buffer.from('{"message":"the forge\'s answer could not be reduced"}');
      }
    }
    return { status, headers, body: body.toString('base64') };
  }

  // One request of this file's own, outside any task's rules: every caller builds its
  // path from values it has already confined.
  async function api(target, method, apiPath, json) {
    const github = target.forge === 'github';
    const res = await send(target, {
      host: github ? 'api.github.com' : target.host,
      method,
      path: github ? apiPath : `/api${apiPath}`,
      headers: { accept: 'application/json', ...(json ? { 'content-type': 'application/json' } : {}) },
      body: json ? Buffer.from(JSON.stringify(json)) : Buffer.alloc(0),
    });
    let parsed = null;
    try { parsed = JSON.parse(res.body.toString('utf8')); } catch {}
    return { status: res.status, json: parsed };
  }
  const project = (repo) => `/v4/projects/${encodeURIComponent(repo)}`;
  const str = (v) => (typeof v === 'string' ? v : '');

  /// What a GitHub node id stands for: `{ type, repo, item: "pr"|"issue", number, open,
  /// itemAuthor, author, pending }` for something in a repository, `{ type, login }` for an
  /// account, or null when the forge shows nothing for the id (and on GitLab, whose ids
  /// this cannot resolve).
  async function resolveNode(target, id) {
    if (target.forge !== 'github' || typeof id !== 'string') return null;
    const res = await api(target, 'POST', '/graphql', { query: NODE_QUERY, variables: { id } });
    const node = res.json?.data?.node;
    if (res.status !== 200 || !node || typeof node !== 'object') return null;
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

  /// A pull or merge request of `repo` by number: `{ number, open, author, headRepo,
  /// headRef, baseRef, draft }`, or null.
  async function pull(target, repo, number) {
    if (target.forge === 'github') {
      const res = await api(target, 'GET', `/repos/${repo}/pulls/${number}`);
      const p = res.json;
      if (res.status !== 200 || !p || p.number !== number) return null;
      return { number, open: p.state === 'open', author: str(p.user?.login), headRepo: str(p.head?.repo?.full_name), headRef: str(p.head?.ref), baseRef: str(p.base?.ref), draft: p.draft === true };
    }
    const res = await api(target, 'GET', `${project(repo)}/merge_requests/${number}`);
    const m = res.json;
    if (res.status !== 200 || !m || m.iid !== number) return null;
    // A merge request from a fork has its source branch in another project, which no
    // rule of the pool's project reaches.
    return { number, open: m.state === 'opened', author: str(m.author?.username), headRepo: m.source_project_id === m.target_project_id ? repo : '', headRef: str(m.source_branch), baseRef: str(m.target_branch), draft: m.draft === true };
  }

  /// The open pull or merge requests of `repo` whose head branch is `ref` in `headRepo`
  /// (every open one, up to a page of 100, when `ref` is not given), shaped as `pull`.
  async function pullsByHead(target, repo, { repo: headRepo, ref }) {
    if (target.forge === 'github') {
      const filter = ref === undefined ? '' : `&head=${encodeURIComponent(`${headRepo.split('/')[0]}:${ref}`)}`;
      const res = await api(target, 'GET', `/repos/${repo}/pulls?state=open&per_page=100${filter}`);
      if (res.status !== 200 || !Array.isArray(res.json)) return [];
      return res.json.map((p) => ({ number: p.number, open: p.state === 'open', author: str(p.user?.login), headRepo: str(p.head?.repo?.full_name), headRef: str(p.head?.ref), baseRef: str(p.base?.ref), draft: p.draft === true }));
    }
    const filter = ref === undefined ? '' : `&source_branch=${encodeURIComponent(ref)}`;
    const res = await api(target, 'GET', `${project(repo)}/merge_requests?state=opened&per_page=100${filter}`);
    if (res.status !== 200 || !Array.isArray(res.json)) return [];
    return res.json.map((m) => ({ number: m.iid, open: m.state === 'opened', author: str(m.author?.username), headRepo: m.source_project_id === m.target_project_id ? repo : '', headRef: str(m.source_branch), baseRef: str(m.target_branch), draft: m.draft === true }));
  }

  /// A GitHub review comment of `repo` by its REST id, resolved like a node, or null.
  async function comment(target, repo, id) {
    if (target.forge !== 'github') return null;
    const res = await api(target, 'GET', `/repos/${repo}/pulls/comments/${id}`);
    if (res.status !== 200 || typeof res.json?.node_id !== 'string') return null;
    return resolveNode(target, res.json.node_id);
  }

  /// The logins assigned to a GitHub issue of `repo`, or null when it is not shown.
  async function assignees(target, repo, number) {
    if (target.forge !== 'github') return null;
    const res = await api(target, 'GET', `/repos/${repo}/issues/${number}`);
    return res.status === 200 && Array.isArray(res.json?.assignees) ? res.json.assignees.map((a) => str(a?.login)) : null;
  }

  /// The account the credential belongs to: `{ id, login }`, or null.
  async function self(target) {
    if (target.forge === 'github') {
      const res = await api(target, 'POST', '/graphql', { query: '{ viewer { id login } }' });
      const v = res.json?.data?.viewer;
      return res.status === 200 && v ? { id: v.id, login: str(v.login) } : null;
    }
    const res = await api(target, 'GET', '/v4/user');
    return res.status === 200 && res.json ? { id: res.json.id, login: str(res.json.username) } : null;
  }

  /// The commit a branch (`refs/heads/...`) of `repo` points at on the forge, or null when
  /// there is no such branch.
  async function currentRef(target, repo, ref) {
    const branch = ref.replace(/^refs\/heads\//, '');
    if (target.forge === 'github') {
      const res = await api(target, 'GET', `/repos/${repo}/git/ref/heads/${branch.split('/').map(encodeURIComponent).join('/')}`);
      return res.status === 200 && typeof res.json?.object?.sha === 'string' ? res.json.object.sha : null;
    }
    const res = await api(target, 'GET', `${project(repo)}/repository/branches/${encodeURIComponent(branch)}`);
    return res.status === 200 && typeof res.json?.commit?.id === 'string' ? res.json.commit.id : null;
  }

  /// A GitLab project's numeric id, which `rulesFor` needs to allow the numeric spelling
  /// of its paths; null on GitHub or when the project is not shown.
  async function projectId(target, repo) {
    if (target.forge !== 'gitlab') return null;
    const res = await api(target, 'GET', project(repo));
    return res.status === 200 && Number.isInteger(res.json?.id) ? res.json.id : null;
  }

  /// Fetches from `repo` on the forge into the repository `env` points git at (the push
  /// check's quarantine): the commits in `wants` by id, or every branch with `all`.
  /// Resolves to whether git succeeded.
  async function fetchInto(target, { repo, env, wants = [], all = false }) {
    if (!all && (wants.length === 0 || wants.some((oid) => !/^[0-9a-f]{40,64}$/.test(oid)))) return false;
    const gitHost = target.forge === 'github' ? 'github.com' : target.host;
    if (!hostsOf(target.forge, target.host).includes(gitHost) || !/^[A-Za-z0-9._/-]+$/.test(repo)) return false;
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
    const what = all ? ['+refs/heads/*:refs/dn/*'] : wants;
    const r = await run(GIT_BIN, ['fetch', '--quiet', '--no-tags', '--no-write-fetch-head', `${origin(gitHost)}/${repo}.git`, ...what], gitEnv);
    log(`forge fetch ${gitHost}/${repo} ${all ? 'all branches' : `${wants.length} commit(s)`} -> ${r.ok ? 'ok' : 'failed'}`);
    return r.ok;
  }

  /// What `authorize` needs as its `ctx` for one key: the forge lookups bound to the
  /// pool's repository, the linked `checkout` the push check may read, and the key's
  /// mutable `state`. `repo` is "owner/name" on GitHub and the project's full path on GitLab.
  function context({ forge, host, repo, checkout, state }) {
    const target = { forge, host };
    return {
      checkout,
      state,
      resolveNode: (id) => resolveNode(target, id),
      pull: (number) => pull(target, repo, number),
      pullsByHead: (head) => pullsByHead(target, repo, head),
      comment: (id) => comment(target, repo, id),
      assignees: (number) => assignees(target, repo, number),
      self: () => self(target),
      currentRef: (headRepo, ref) => currentRef(target, headRepo, ref),
      fetch: (what) => fetchInto(target, what),
    };
  }

  return { perform, context, resolveNode, pull, pullsByHead, comment, assignees, self, currentRef, projectId, fetchInto };
}
