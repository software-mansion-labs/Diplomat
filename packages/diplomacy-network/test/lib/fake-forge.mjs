// A stand-in for GitHub and GitLab on loopback: their REST and GraphQL APIs from a small
// data set, and real git smart HTTP for scratch bare repositories (git's own http-backend
// run as CGI), so a test pushes with a real git client. Every request is recorded with
// the credential it carried. A request without this forge's token is answered 401, so a
// test that passes proves the requester added its own.
//
// One port serves every host: DN_FORGE_ORIGINS maps a host to http://127.0.0.1:<port>/h/<host>.

import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { parseDocument } from '../../src/requester/graphql.js';

/// The only credentials this forge accepts; the fake gh and glab print them.
export const GITHUB_TOKEN = 'ghs_fakeforgetoken0123456789';
export const GITLAB_TOKEN = 'glpat-fakeforgetoken0123';
/// The host the GitLab side answers as.
export const GITLAB_HOST = 'gitlab.example.com';
const HOSTS = ['api.github.com', 'github.com', GITLAB_HOST];

const GIT_ENV = {
  PATH: process.env.PATH,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
  GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com',
};

/// Runs git with no configuration of the machine's own; returns its trimmed stdout.
export function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, env: { ...GIT_ENV, HOME: cwd }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

const pkt = (text) => Buffer.concat([Buffer.from((Buffer.byteLength(text) + 4).toString(16).padStart(4, '0')), Buffer.from(text)]);

/// A git-receive-pack request body: `commands` as `[old, new, ref]`, the capabilities on
/// the first, a flush, then `pack`.
export function pushBody(commands, pack = Buffer.alloc(0), caps = 'report-status side-band-64k agent=git/test') {
  const lines = commands.map(([from, to, ref], i) => pkt(`${from} ${to} ${ref}${i === 0 ? `\0 ${caps}` : ''}\n`));
  return Buffer.concat([...lines, Buffer.from('0000'), pack]);
}

/// The pack a client would send to move a ref: everything reachable from `include` and
/// not from `exclude`, as `git pack-objects` writes it.
export function packOf(repoDir, include, exclude = [], { thin = false } = {}) {
  const revs = [...include, ...exclude.map((x) => `^${x}`)].join('\n');
  return execFileSync('git', ['pack-objects', '--stdout', '--revs', ...(thin ? ['--thin'] : [])], { cwd: repoDir, env: { ...GIT_ENV, HOME: repoDir }, input: `${revs}\n`, stdio: ['pipe', 'pipe', 'ignore'], maxBuffer: 2 ** 28 });
}

/// Writes fake `gh` and `glab` into `dir` that print this forge's tokens, and returns the
/// environment that points the daemon at them: a test never reads a real credential.
export function fakeTools(dir) {
  const script = (name, body) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    return file;
  };
  return {
    DN_GH: script('gh', `[ "$1 $2 $3" = "auth token --hostname" ] && [ "$4" = "github.com" ] && echo "${GITHUB_TOKEN}" && exit 0\nexit 1`),
    DN_GLAB: script('glab', `[ "$1 $2 $3 $4" = "config get token --host" ] && [ "$5" = "${GITLAB_HOST}" ] && echo "${GITLAB_TOKEN}" && exit 0\nexit 1`),
  };
}

// The value of a GraphQL selection over plain data: only what was selected, the way a
// real server answers. A function is called with the field's arguments; AUTO stands for
// "an object of whatever was asked", for mutation payloads nobody modelled.
const AUTO = Symbol('auto');
function project(doc, vars, selections, data) {
  if (data === null || data === undefined) return null;
  if (Array.isArray(data)) return data.map((item) => project(doc, vars, selections, item));
  const out = {};
  const value = (v) => {
    if (v.k === 'var') return vars[v.name];
    if (v.k === 'list') return v.items.map(value);
    if (v.k === 'obj') return Object.fromEntries(v.fields.map((f) => [f.name, value(f.value)]));
    return v.k === 'int' || v.k === 'float' ? Number(v.v) : v.k === 'null' ? null : v.v;
  };
  for (const sel of selections) {
    if (sel.kind === 'spread' || sel.kind === 'inline') {
      const frag = sel.kind === 'spread' ? doc.fragments.get(sel.name) : sel;
      if (data !== AUTO && frag.on && data.__typename && data.__typename !== frag.on) continue;
      Object.assign(out, project(doc, vars, frag.selections, data));
      continue;
    }
    const key = sel.alias || sel.name;
    if (data === AUTO) { out[key] = sel.selections ? project(doc, vars, sel.selections, AUTO) : null; continue; }
    let v = data[sel.name];
    if (typeof v === 'function') v = v(Object.fromEntries(sel.args.map((a) => [a.name, value(a.value)])));
    out[key] = sel.selections ? project(doc, vars, sel.selections, v) : v ?? null;
  }
  return out;
}

/// Starts the forge. `forge.log` is every request it received (`{ host, method, path,
/// headers, body }`); `forge.data` is what its APIs answer from and may be edited;
/// `forge.route(host, method, pattern, fn)` adds an answer of the test's own and returns
/// the function that takes it away again;
/// `forge.bare(repo)` creates the bare repository smart HTTP serves at `/<repo>.git`;
/// `forge.tokens` and `forge.gitlabTokens` are the sets of GitHub and GitLab tokens it
/// takes, which a test may add to;
/// `forge.env` is the environment a test must set before it imports the daemon's sources.
export async function startFakeForge() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dn-forge-'));
  const gitRoot = path.join(root, 'git');
  fs.mkdirSync(gitRoot);
  const log = [];
  const routes = [];
  const viewer = { __typename: 'User', id: 'U_me', login: 'me', databaseId: 7, name: 'Me' };
  const data = {
    viewer,
    // GraphQL node ids -> the object `node(id:)` returns.
    nodes: { U_me: viewer },
    // "owner/name" -> { id, pulls: { number: {...} }, issues: { number: {...} } }, and what
    // a test sets of a repository's settings: defaultBranch, protected (branch names),
    // ciConfigPath (GitLab), parent (the repository it is a fork of; null for none) and
    // spelled (its name in the forge's own letter case).
    repos: {},
    // REST review comment id -> node id
    comments: {},
    mutations: [],
  };

  function repository({ owner, name }) {
    const repo = data.repos[`${owner}/${name}`.toLowerCase()];
    if (!repo) return null;
    const pulls = Object.values(repo.pulls || {}).map((p) => data.nodes[p.id]);
    const issues = Object.values(repo.issues || {}).map((i) => data.nodes[i.id]);
    return {
      __typename: 'Repository', id: repo.id, name, nameWithOwner: `${owner}/${name}`, owner: { login: owner, id: 'O_1' },
      hasIssuesEnabled: true, viewerPermission: 'WRITE', defaultBranchRef: { name: 'main' }, parent: null,
      pullRequest: ({ number }) => pulls.find((p) => p.number === number) || null,
      issue: ({ number }) => issues.find((i) => i.number === number) || null,
      issueOrPullRequest: ({ number }) => [...issues, ...pulls].find((x) => x.number === number) || null,
      pullRequests: ({ headRefName }) => ({ nodes: pulls.filter((p) => !headRefName || p.headRefName === headRefName), totalCount: pulls.length, pageInfo: { hasNextPage: false, endCursor: null } }),
      issues: () => ({ nodes: issues, totalCount: issues.length, pageInfo: { hasNextPage: false, endCursor: null } }),
    };
  }

  function graphql(body) {
    let payload;
    try { payload = JSON.parse(body.toString('utf8')); } catch { return { status: 400, json: { message: 'Problems parsing JSON' } }; }
    const doc = parseDocument(payload.query);
    const [op] = doc.operations;
    const vars = payload.variables || {};
    if (op.type === 'mutation') {
      data.mutations.push({ name: op.selections[0].name, variables: vars, query: payload.query });
      return { status: 200, json: { data: project(doc, vars, op.selections, AUTO) } };
    }
    const rootData = {
      viewer: data.viewer,
      repository,
      node: ({ id }) => data.nodes[id] || null,
      search: () => ({ issueCount: 0, nodes: [], edges: [], pageInfo: { hasNextPage: false, endCursor: null } }),
      rateLimit: { remaining: 4999, limit: 5000 },
      __type: () => ({ name: 'T', fields: [], inputFields: [], enumValues: [] }),
    };
    return { status: 200, json: { data: project(doc, vars, op.selections, rootData) } };
  }

  // A repository a test did not name a parent for is a fork of one the task must never see.
  const parentOf = (repo) => (repo.parent === undefined ? 'upstream/private-parent' : repo.parent);
  const restPull = (repoName, p) => {
    const head = p.headRepo === null ? null : (p.headRepo || repoName).toLowerCase();
    return {
      number: p.number, state: p.state || 'open', draft: p.draft === true, node_id: p.id, user: { login: p.author },
      // A fork that was deleted leaves a pull request without a head repository.
      head: { ref: p.head, repo: head === null ? null : { full_name: data.repos[head]?.spelled || head, id: data.repos[head]?.projectId } },
      base: { ref: p.base || 'main', repo: { full_name: repoName } },
    };
  };
  // A repository is kept under its name in lower case, however a request spells it.
  const revParse = (repoName, ref) => {
    try { return git(path.join(gitRoot, `${repoName.toLowerCase()}.git`),'rev-parse', '--verify', '--quiet', `${ref}^{commit}`); } catch { return null; }
  };

  function githubRest(method, url) {
    const { pathname, searchParams } = new URL(url, 'http://x');
    if (pathname === '/user') return { status: 200, json: { login: 'me', id: 7, node_id: 'U_me', type: 'User', name: 'Me', html_url: 'https://github.com/me', email: 'private@example.com', total_private_repos: 12, two_factor_authentication: true, plan: { name: 'pro' } } };
    const m = /^\/repos\/([^/]+\/[^/]+)(\/.*)?$/.exec(pathname);
    const repo = m && data.repos[m[1].toLowerCase()];
    if (!repo) return { status: 404, json: { message: 'Not Found' } };
    const rest = m[2] || '';
    let x;
    if (method === 'GET' && rest === '') {
      const full = repo.spelled || m[1];
      const [owner, name] = full.split('/');
      const parent = parentOf(repo);
      return { status: 200, json: {
        id: repo.projectId, node_id: repo.id, name, full_name: full, owner: { login: owner }, private: true, visibility: 'private', fork: parent !== null,
        html_url: `https://github.com/${full}`, clone_url: `https://github.com/${full}.git`, default_branch: repo.defaultBranch || 'main',
        permissions: { admin: true, push: true, pull: true }, temp_clone_token: 'TEMPCLONETOKEN', allow_auto_merge: true,
        security_and_analysis: { secret_scanning: { status: 'disabled' } }, ...(parent === null ? {} : { parent: { full_name: parent } }),
      } };
    }
    if (method === 'GET' && (x = /^\/branches\/(.+)$/.exec(rest))) {
      const branch = decodeURIComponent(x[1]);
      const sha = revParse(m[1], `refs/heads/${branch}`);
      return sha ? { status: 200, json: { name: branch, commit: { sha }, protected: (repo.protected || []).includes(branch) } } : { status: 404, json: { message: 'Branch not found' } };
    }
    if (method === 'GET' && (x = /^\/pulls\/(\d+)$/.exec(rest))) {
      const p = repo.pulls?.[x[1]];
      return p ? { status: 200, json: restPull(m[1], p) } : { status: 404, json: { message: 'Not Found' } };
    }
    if (method === 'GET' && rest === '/pulls') {
      const head = searchParams.get('head');
      const list = Object.values(repo.pulls || {}).filter((p) => (p.state || 'open') === 'open')
        .filter((p) => !head || `${(p.headRepo || m[1]).split('/')[0]}:${p.head}` === head);
      return { status: 200, json: list.map((p) => restPull(m[1], p)) };
    }
    if (method === 'GET' && (x = /^\/issues\/(\d+)$/.exec(rest)) && repo.issues?.[x[1]]) {
      return { status: 200, json: { number: Number(x[1]), assignees: (repo.issues[x[1]].assignees || []).map((login) => ({ login })) } };
    }
    if (method === 'GET' && (x = /^\/pulls\/comments\/(\d+)$/.exec(rest))) {
      return data.comments[x[1]] ? { status: 200, json: { id: Number(x[1]), node_id: data.comments[x[1]] } } : { status: 404, json: { message: 'Not Found' } };
    }
    if (method === 'GET') return { status: 200, json: { path: pathname, ok: true }, headers: { link: '<https://api.github.com/next>; rel="next"', etag: '"abc"', 'x-ratelimit-remaining': '4999', 'x-github-request-id': 'REQ1', 'set-cookie': 'session=forge', 'www-authenticate': 'Basic realm="x"' } };
    return { status: method === 'DELETE' ? 204 : 201, json: method === 'DELETE' ? null : { id: 1, node_id: 'PRR_1', state: 'PENDING', html_url: 'https://github.com/o/r/pull/9', number: 9 } };
  }

  function gitlabRest(method, url) {
    const { pathname, searchParams } = new URL(url, 'http://x');
    if (pathname === '/api/v4/user') return { status: 200, json: { id: 7, username: 'me', name: 'Me', state: 'active', web_url: `https://${GITLAB_HOST}/me`, email: 'private@example.com', is_admin: true, two_factor_enabled: true } };
    const m = /^\/api\/v4\/projects\/([^/]+)(\/.*)?$/.exec(pathname);
    const key = m && decodeURIComponent(m[1]).toLowerCase();
    const found = m && Object.entries(data.repos).find(([name, r]) => name === key || String(r.projectId) === key);
    if (!found) return { status: 404, json: { message: '404 Project Not Found' } };
    const [repoName, repo] = found;
    const rest = m[2] || '';
    const mr = (p) => ({ iid: p.number, state: (p.state || 'open') === 'open' ? 'opened' : p.state, draft: p.draft === true, author: { username: p.author }, source_branch: p.head, target_branch: p.base || 'main', source_project_id: p.headRepo ? data.repos[p.headRepo].projectId : p.fork ? 1234 : repo.projectId, target_project_id: repo.projectId });
    let x;
    if (method === 'GET' && rest === '') {
      const full = repo.spelled || repoName;
      const parent = parentOf(repo);
      return { status: 200, json: {
        id: repo.projectId, path_with_namespace: full, default_branch: repo.defaultBranch || 'main', merge_requests_enabled: true, web_url: `https://${GITLAB_HOST}/${repoName}`,
        namespace: { full_path: full.split('/').slice(0, -1).join('/') },
        ci_config_path: repo.ciConfigPath ?? null, runners_token: 'GR1348941runnerstoken', service_desk_address: 'desk@example.com', import_url: 'https://user:pass@elsewhere.example/x.git',
        ...(parent === null ? {} : { forked_from_project: { path_with_namespace: parent } }), permissions: { project_access: { access_level: 40 } },
      } };
    }
    if (method === 'GET' && (x = /^\/issues\/(\d+)$/.exec(rest)) && repo.issues?.[x[1]]) {
      return { status: 200, json: { iid: Number(x[1]), assignees: (repo.issues[x[1]].assigneeIds || []).map((id) => ({ id, username: `user${id}` })) } };
    }
    if (method === 'GET' && (x = /^\/merge_requests\/(\d+)$/.exec(rest))) {
      const p = repo.pulls?.[x[1]];
      return p ? { status: 200, json: mr(p) } : { status: 404, json: { message: '404 Not found' } };
    }
    if (method === 'GET' && rest === '/merge_requests') {
      const branch = searchParams.get('source_branch');
      return { status: 200, json: Object.values(repo.pulls || {}).filter((p) => (p.state || 'open') === 'open' && (!branch || p.head === branch)).map(mr), headers: { 'x-total': '1', 'x-next-page': '' } };
    }
    if (method === 'GET' && (x = /^\/repository\/branches\/(.+)$/.exec(rest))) {
      const sha = revParse(repoName, `refs/heads/${decodeURIComponent(x[1])}`);
      const branch = decodeURIComponent(x[1]);
      return sha ? { status: 200, json: { name: branch, commit: { id: sha }, protected: (repo.protected || []).includes(branch), default: branch === (repo.defaultBranch || 'main') } } : { status: 404, json: { message: '404 Branch Not Found' } };
    }
    return { status: method === 'POST' ? 201 : 200, json: { path: pathname, ok: true, id: 1, iid: 5 } };
  }

  // git http-backend as CGI: the request body on stdin, a header block and the answer on stdout.
  function smartHttp(req, res, url, body) {
    const [pathname, query = ''] = url.split('?');
    const m = /^\/(.+?)(?:\.git)?\/(info\/refs|git-receive-pack|git-upload-pack)$/.exec(pathname);
    if (!m || !fs.existsSync(path.join(gitRoot, `${m[1].toLowerCase()}.git`))) { res.writeHead(404).end('Not Found'); return; }
    const child = spawn('git', ['http-backend'], {
      env: {
        ...GIT_ENV, HOME: root, GIT_PROJECT_ROOT: gitRoot, GIT_HTTP_EXPORT_ALL: '1', REMOTE_USER: 'forge',
        PATH_INFO: `/${m[1].toLowerCase()}.git/${m[2]}`, REQUEST_METHOD: req.method, QUERY_STRING: query,
        CONTENT_TYPE: req.headers['content-type'] || '', CONTENT_LENGTH: String(body.length),
        ...(req.headers['content-encoding'] ? { HTTP_CONTENT_ENCODING: req.headers['content-encoding'] } : {}),
        ...(req.headers['git-protocol'] ? { GIT_PROTOCOL: req.headers['git-protocol'] } : {}),
      },
    });
    const out = [];
    child.stdout.on('data', (b) => out.push(b));
    child.stderr.on('data', () => {});
    child.on('close', () => {
      const all = Buffer.concat(out);
      const cut = all.indexOf('\r\n\r\n');
      const headers = {};
      let status = 200;
      for (const line of all.subarray(0, Math.max(cut, 0)).toString('latin1').split('\r\n')) {
        const i = line.indexOf(':');
        if (i === -1) continue;
        if (line.slice(0, i).toLowerCase() === 'status') status = parseInt(line.slice(i + 1), 10);
        else headers[line.slice(0, i)] = line.slice(i + 1).trim();
      }
      res.writeHead(status, headers).end(cut === -1 ? Buffer.alloc(0) : all.subarray(cut + 4));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(body);
  }

  // The tokens this forge takes, GitHub's and GitLab's: its own, and whichever a test adds
  // for a machine that is to be told apart by the credential it sends.
  const tokens = new Set([GITHUB_TOKEN]);
  const gitlabTokens = new Set([GITLAB_TOKEN]);
  const expected = (host, url) => {
    if (host === 'api.github.com') return [...tokens].map((t) => `Bearer ${t}`);
    if (host === 'github.com') return [...tokens].map((t) => `Basic ${Buffer.from(`x-access-token:${t}`).toString('base64')}`);
    return [...gitlabTokens].map((t) => (url.startsWith('/api/') ? `Bearer ${t}` : `Basic ${Buffer.from(`oauth2:${t}`).toString('base64')}`));
  };

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const body = Buffer.concat(chunks);
      const m = /^\/h\/([^/]+)(\/.*)$/.exec(req.url);
      if (!m || !HOSTS.includes(m[1])) { res.writeHead(404).end(); return; }
      const [, host, url] = m;
      log.push({ host, method: req.method, path: url, headers: { ...req.headers }, body });
      if (!expected(host, url).includes(req.headers.authorization)) {
        res.writeHead(401, { 'content-type': 'application/json', 'www-authenticate': 'Basic realm="forge"' }).end('{"message":"Bad credentials"}');
        return;
      }
      const custom = routes.find((r) => r.host === host && r.method === req.method && r.pattern.test(url));
      if (custom) { await custom.fn(req, res, body, url); return; }
      let answer;
      if (host === 'github.com' || (host === GITLAB_HOST && !url.startsWith('/api/'))) { smartHttp(req, res, url, body); return; }
      try {
        if (url === '/graphql' || url === '/api/graphql') answer = graphql(body);
        else answer = host === 'api.github.com' ? githubRest(req.method, url) : gitlabRest(req.method, url);
      } catch (err) {
        answer = { status: 500, json: { message: String(err.message) } };
      }
      res.writeHead(answer.status, { 'content-type': 'application/json; charset=utf-8', ...(answer.headers || {}) });
      res.end(answer.json === null ? '' : JSON.stringify(answer.json));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}/h`;

  return {
    port, log, data, root, gitRoot, tokens, gitlabTokens,
    env: {
      ...fakeTools(root),
      DN_FORGE_ORIGINS: JSON.stringify(Object.fromEntries(HOSTS.map((h) => [h, `${base}/${h}`]))),
    },
    route(host, method, pattern, fn) {
      const added = { host, method, pattern, fn };
      routes.push(added);
      return () => routes.splice(routes.indexOf(added), 1);
    },
    /// Adds a pull request (GitLab: merge request) and the nodes a review of it has.
    pull(repoName, p) {
      const repo = data.repos[repoName];
      const [owner, name] = repoName.split('/');
      repo.pulls ||= {};
      repo.pulls[p.number] = { id: `PR_${p.number}`, ...p };
      const stored = repo.pulls[p.number];
      const node = {
        __typename: 'PullRequest', id: stored.id, number: p.number, state: (p.state || 'open').toUpperCase(), isDraft: p.draft === true,
        title: `PR ${p.number}`, body: '', url: `https://github.com/${repoName}/pull/${p.number}`, headRefName: p.head, baseRefName: p.base || 'main',
        author: { __typename: 'User', login: p.author }, repository: { nameWithOwner: `${owner}/${name}` },
        isCrossRepository: false, headRepositoryOwner: { login: owner, id: 'O_1' }, commits: { nodes: [], totalCount: 0 },
      };
      data.nodes[stored.id] = node;
      return node;
    },
    issue(repoName, i) {
      const repo = data.repos[repoName];
      repo.issues ||= {};
      repo.issues[i.number] = { id: `I_${i.number}`, ...i };
      const node = {
        __typename: 'Issue', id: `I_${i.number}`, number: i.number, state: (i.state || 'open').toUpperCase(), title: `Issue ${i.number}`, body: '',
        url: `https://github.com/${repoName}/issues/${i.number}`, author: { __typename: 'User', login: i.author },
        repository: { nameWithOwner: repoName }, assignedActors: { nodes: [], totalCount: 0 }, assignees: { nodes: [], totalCount: 0 },
      };
      data.nodes[node.id] = node;
      return node;
    },
    /// Adds a node `node(id:)` answers with, e.g. a review thread: `{ __typename, ... }`.
    node(id, value) { data.nodes[id] = { id, ...value }; return data.nodes[id]; },
    /// Creates the bare repository behind `/<repo>.git`, accepting any push it is sent:
    /// force-pushes and deletions too, so only the requester's check stands in their way.
    bare(repoName, { id = 'R_1', projectId = 99, ...settings } = {}) {
      const dir = path.join(gitRoot, `${repoName}.git`);
      fs.mkdirSync(dir, { recursive: true });
      git(dir, 'init', '--bare', '--quiet', '--initial-branch=main', '.');
      for (const [k, v] of [['http.receivepack', 'true'], ['uploadpack.allowAnySHA1InWant', 'true'], ['receive.denyNonFastForwards', 'false'], ['receive.denyDeletes', 'false']]) git(dir, 'config', k, v);
      data.repos[repoName] ||= { id, projectId, pulls: {}, issues: {}, ...settings };
      data.nodes[id] = { __typename: 'Repository', id, nameWithOwner: repoName };
      return dir;
    },
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}
