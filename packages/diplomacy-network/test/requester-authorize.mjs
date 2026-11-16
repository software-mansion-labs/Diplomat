// authorize: one spelling per request, the first matching rule decides, and what matches
// nothing is refused.

import assert from 'node:assert/strict';
import { authorize, authorized, conclude, parseStrictJson } from '../src/requester/authorize.js';
import { world } from './lib/world.mjs';

async function check(name, fn) {
  await fn();
  console.log(`PASS ${name}`);
}

const b64 = (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64');
const JSON_TYPE = { 'content-type': 'application/json' };
const req = (method, path, more = {}) => ({ host: 'api.github.com', method, path, headers: {}, body: '', ...more });
const post = (path, body, headers = JSON_TYPE) => req('POST', path, { headers, body: b64(body) });

const RULES = [
  { host: 'api.github.com', method: 'GET', path: '/repos/o/r/pulls/**', fold: [1, 2] },
  { host: 'api.github.com', method: 'GET', path: '/repos/o/r/branches/*', fold: [1, 2] },
  { host: 'api.github.com', method: 'GET', path: '/repos/o/r', fold: [1, 2] },
  { host: 'api.github.com', method: 'GET', path: '/search/issues', query: { q: { search: 'o/r' }, advanced_search: 'free', page: 'free', per_page: 'free' } },
  { host: 'api.github.com', method: 'GET', path: '/user', pick: ['login'] },
  { host: 'api.github.com', method: 'POST', path: '/repos/o/r/pulls/578/reviews', fold: [1, 2], body: { commit_id: 'free', body: 'free', event: { oneOf: ['COMMENT'] } } },
  { host: 'api.github.com', method: 'POST', path: '/repos/o/r/pulls/578/reviews/*/events', fold: [1, 2], body: { event: { oneOf: ['COMMENT'], required: true }, body: 'free' } },
  { host: 'api.github.com', method: 'DELETE', path: '/repos/o/r/pulls/578/reviews/*', fold: [1, 2] },
  { host: 'gitlab.example.com', method: 'GET', path: '/api/v4/projects/group%2Fsub%2Fproj/merge_requests/**', fold: [3] },
  { host: 'gitlab.example.com', method: 'PUT', path: '/api/v4/projects/group%2Fsub%2Fproj/merge_requests/5/discussions/*', fold: [3], query: { resolved: { equals: 'true', optional: true } }, body: { resolved: { oneOf: [true, 'true'], required: true } } },
  { host: 'gitlab.example.com', method: 'POST', path: '/api/v4/projects/group%2Fsub%2Fproj/issues/421/notes', fold: [3], body: { body: { prose: true } } },
];

const ask = (request, rules = RULES, ctx = world()) => authorize(rules, request, ctx);
async function allowed(request, rules, ctx) {
  const verdict = await ask(request, rules, ctx);
  assert.equal(verdict.ok, true, `${verdict.reason}: ${request.method} ${request.host}${request.path}`);
  return verdict;
}
async function refused(request, pattern = /./, rules, ctx) {
  const verdict = await ask(request, rules, ctx);
  assert.equal(verdict.ok, false, `allowed: ${request.method} ${request.host}${request.path}`);
  assert.match(verdict.reason, pattern, `${request.method} ${request.host}${request.path}`);
}

await check('a request no rule matches is refused, and an empty rule list allows nothing', async () => {
  await refused(req('GET', '/repos/o/r/hooks'), /no rule of this task/);
  await refused(req('GET', '/repos/o/r/pulls/1'), /no rule of this task/, []);
  await refused(req('GET', '/repos/o/r/pulls/1'), /no rule of this task/, null);
  await refused(req('PATCH', '/repos/o/r/pulls/578'), /no rule of this task/);
  await refused(req('GET', '/repos/o/r/pulls/578/reviews/1/events'), /./, [RULES[6]]);
  const verdict = await allowed(req('GET', '/repos/o/r/pulls/1'));
  assert.equal(verdict.rule, RULES[0]);
  assert.equal(authorized(verdict.request), true);
  assert.equal(authorized({ ...verdict.request }), false, 'only the object authorize returned is marked');
});

await check('"*" is one segment, a trailing "**" is any remainder, and a path has no other length', async () => {
  await allowed(req('GET', '/repos/o/r/branches/main'));
  await refused(req('GET', '/repos/o/r/branches/main/protection'), /no rule/);
  await refused(req('GET', '/repos/o/r/branches'), /no rule/);
  await allowed(req('DELETE', '/repos/o/r/pulls/578/reviews/7'));
  await refused(req('DELETE', '/repos/o/r/pulls/578/reviews/7/comments'), /no rule/);
  await refused(req('DELETE', '/repos/o/r/pulls/578/reviews'), /no rule/);
  await allowed(req('GET', '/repos/o/r/pulls'));
  await allowed(req('GET', '/repos/o/r/pulls/578/files'));
  await refused(req('GET', '/repos/o/r/pullsx'), /no rule/);
  await refused(req('GET', '/repos/o'), /no rule/);
});

await check('the repository is compared without case, every other segment exactly', async () => {
  await allowed(req('GET', '/repos/O/R/pulls/1'));
  await allowed(req('GET', '/repos/o/R'));
  await refused(req('GET', '/REPOS/o/r/pulls/1'), /no rule/);
  await refused(req('GET', '/repos/o/r/Pulls/1'), /no rule/);
  await refused(req('GET', '/repos/o/r2/pulls/1'), /no rule/);
  await refused(req('GET', '/repos/oo/r/pulls/1'), /no rule/);
  const gl = (path) => req('GET', path, { host: 'gitlab.example.com' });
  await allowed(gl('/api/v4/projects/group%2Fsub%2Fproj/merge_requests/5'));
  await allowed(gl('/api/v4/projects/Group%2fSub%2FProj/merge_requests/5'));
  await refused(gl('/api/v4/projects/group%2Fsub%2Fother/merge_requests/5'), /no rule/);
  await refused(gl('/api/v4/projects/group%2Fsub/merge_requests/5'), /no rule/);
  await refused(gl('/api/v4/Projects/group%2Fsub%2Fproj/merge_requests/5'), /encoded slash/);
  // A rule without `fold` is exact everywhere.
  await refused(req('GET', '/repos/O/r/pulls/1'), /no rule/, [{ ...RULES[0], fold: undefined }]);
});

await check('a host is lowercased and must be exactly a rule\'s host', async () => {
  await allowed(req('GET', '/repos/o/r', { host: 'API.GitHub.com' }));
  for (const host of ['github.com', 'api.github.com.', 'api.github.com.evil.example', 'evil-api.github.com', 'xapi.github.com', 'api.github.com:443', 'api.github.com:8080',
    'uploads.github.com', 'gist.github.com', 'api.github.com@evil.example', 'evil.example#api.github.com', 'api.github.com/x', 'api.github.com evil', ' api.github.com',
    'api.github.com\\.evil.example', 'api.github.com%2eevil', 'api。github。com', '', '.', 5, null, undefined, ['api.github.com']]) {
    await refused(req('GET', '/repos/o/r', { host }), /no rule|not a plain host name/);
  }
});

await check('a path with more than one reading is refused before any rule is tried', async () => {
  const tricks = [
    ['/repos/o/r/../../user/repos', /dot segment/],
    ['/repos/o/r/pulls/../../../user', /dot segment/],
    ['/repos/o/r/./pulls', /dot segment/],
    ['/repos/o/r/pulls/..', /dot segment/],
    ['/repos/o/r/%2e%2e/%2e%2e/user/repos', /encoded dot/],
    ['/repos/o/r/pulls/%2E%2E/x', /encoded dot/],
    ['/repos/o/r/pulls/.%2e/x', /encoded dot/],
    ['/repos/o/r//pulls', /empty segment/],
    ['//repos/o/r', /empty segment/],
    ['/repos/o/r/pulls/', /empty segment/],
    ['/repos/o/r/pulls%2f578', /encoded slash/],
    ['/repos/o%2Fr/pulls', /encoded slash/],
    ['/repos/o/r/pulls/%5c..%5c', /encoded dot|backslash/],
    ['/repos/o/r/pulls/a\\b', /must be encoded/],
    ['/repos/o/r/pulls/%252e%252e', /percent sign/],
    ['/repos/o/r/pulls/%00', /control character/],
    ['/repos/o/r/pulls/%0a', /control character/],
    ['/repos/o/r/pulls/%7f', /control character/],
    ['/repos/o/r/pulls/%zz', /malformed percent-escape/],
    ['/repos/o/r/pulls/%2', /malformed percent-escape/],
    ['/repos/o/r/pulls/%ff', /not UTF-8/],
    ['/repos/o/r/pulls/1#/../../user', /must be encoded/],
    ['/repos/o/r/pulls;x=1/1', /must be encoded/],
    ['/repos/o/r/pulls/1\n', /must be encoded/],
    ['/repos/o/r/pulls/é', /must be encoded/],
    ['/repos/o/r/pulls/1 ', /must be encoded/],
    ['repos/o/r', /not absolute/],
    ['https://evil.example/repos/o/r', /not absolute/],
    ['', /not absolute/],
    [`/repos/o/r/pulls/${'a'.repeat(9000)}`, /not absolute/],
    ['/repos/o/r/pulls?a=1#frag', /must be encoded/],
    ['/repos/o/r/pulls?a=%zz', /malformed percent-escape/],
    ['/repos/o/r/pulls?a=1;b=2', /must be encoded/],
    ['/repos/o/r/pulls?=1', /empty parameter/],
    ['/repos/o/r/pulls?a=1&&b=2', /empty parameter/],
  ];
  for (const [path, pattern] of tricks) await refused(req('GET', path), pattern);
  const gl = (path) => req('GET', path, { host: 'gitlab.example.com' });
  await refused(gl('/api/v4/projects/group%2Fsub%2Fproj/merge_requests/5%2F..%2F6'), /dot segment/);
  await refused(gl('/api/v4/projects/group%2F..%2F..%2Fother%2Fproj/merge_requests/5'), /dot segment/);
  await refused(gl('/api/v4/projects/group%2Fsub%2Fproj%2F%2e%2e/merge_requests/5'), /dot segment/);
  await refused(gl('/api/v4/projects/group%2F%2Fsub%2Fproj/merge_requests/5'), /empty segment/);
  await refused(gl('/api/v4/projects%2Fgroup/merge_requests/5'), /encoded slash/);
  for (const bad of [null, 'GET /x', [], 5]) assert.equal((await authorize(RULES, bad)).ok, false);
});

await check('a route\'s name has one spelling: what needs no escape may not be escaped, once or twice over', async () => {
  for (const path of ['/repos/o/r/%70ulls/1', '/repos/o/r/pull%73/1', '/repos/o/r/pulls/%31', '/%72epos/o/r/pulls', '/repos/%6f/r/pulls', '/repos/%6F/r/pulls', '/repos/o/r/pulls/a%2Db',
    '/repos/o/r/pulls/a%5Fb', '/repos/o/r/pulls/a%5fb', '/repos/o/r/pulls/%7Ea', '/repos/o/r/pulls/%4A', '/repos/o/r/pulls/%5a', '/repos/o/r/pulls/%30']) {
    await refused(req('GET', path), /an escape of a letter, a digit, "-", "_" or "~"/);
  }
  const twice = [
    ['/repos/o/r/%2570ulls/1', /percent sign/], // an escaped escape
    ['/repos/o/r/%C1%B0ulls/1', /not UTF-8/], ['/repos/o/r/%E0%81%B0ulls/1', /not UTF-8/], // "p" in more bytes than it has
    ['/repos/o/r/%u0070ulls/1', /malformed percent-escape/],
    ['/repos/o/r/pulls%3Bx=1/1', /semicolon/], ['/repos/o/r/pulls%3b/1', /semicolon/],
  ];
  for (const [path, pattern] of twice) await refused(req('GET', path), pattern);
  // What does need an escape keeps it, in either case of its digits, and is sent as it came;
  // "+" in a path is a plus sign.
  for (const path of ['/repos/o/r/pulls/a%20b', '/repos/o/r/pulls/a%3Ab', '/repos/o/r/pulls/a%3ab', '/repos/o/r/pulls/%C3%A9', '/repos/o/r/pulls/a+b', '/repos/o/r/pulls/a@b,c=d', '/repos/o/r/pulls/v1.0.json']) {
    assert.equal((await allowed(req('GET', path))).request.path, path);
  }
  const gl = (path) => req('GET', path, { host: 'gitlab.example.com' });
  await refused(gl('/api/v4/projects/group%2Fsub%2F%70roj/merge_requests/5'), /an escape of a letter/);
  await refused(gl('/api/v4/projects/group%2Fsub%2Fproj/merge%5Frequests/5'), /an escape of a letter/);
  await refused(gl('/api/v4/projects/group%252Fsub%252Fproj/merge_requests/5'), /percent sign/);
});

await check('a path a looser router would take to an earlier rule\'s route is refused, not handed to the wider rule after it', async () => {
  const rules = [
    { host: 'api.github.com', method: 'GET', path: '/repos/o/r/issues/*/timeline', fold: [1, 2], deny: 'elsewhere' },
    { host: 'api.github.com', method: 'GET', path: '/repos/o/r/compare', fold: [1, 2], query: { from: 'free' } },
    { host: 'api.github.com', method: 'GET', path: '/repos/o/r/**', fold: [1, 2] },
  ];
  const second = /could be read as a route another rule of this task decides/;
  await refused(req('GET', '/repos/o/r/issues/5/timeline'), /elsewhere/, rules);
  await refused(req('GET', '/repos/O/R/issues/5/timeline'), /elsewhere/, rules);
  for (const last of ['Timeline', 'TIMELINE', 'timelinE', 'timeline.json', 'timeline.JSON', 'timeline.txt', 'timeline.x', 'timeline.json.json', 'Timeline.Json', 'timeline.', 'timeline..', 'timeline.a+b']) {
    await refused(req('GET', `/repos/o/r/issues/5/${last}`), second, rules);
  }
  // An extension or a capital anywhere on the way, not only at the end.
  for (const path of ['/repos/o/r/Issues/5/timeline', '/repos/o/r/issues.json/5/timeline', '/repos/o/r/ISSUES.x/5/Timeline.y']) await refused(req('GET', path), second, rules);
  // A rule that pins its parameters is stepped around the same way.
  await refused(req('GET', '/repos/o/r/compare?from=a&to=b'), /"to" is not part of this rule/, rules);
  for (const path of ['/repos/o/r/compare.json?from=a&to=b', '/repos/o/r/Compare?to=b', '/repos/o/r/compare.json', '/repos/o/r/COMPARE.JSON?from=a']) await refused(req('GET', path), second, rules);
  // Where no rule matches as sent, that is the answer, whatever a looser reading finds.
  await refused(req('GET', '/Repos/o/r/issues/5/timeline'), /no rule of this task/, rules);
  await refused(req('GET', '/repos/o/r.json/issues/5/timeline'), /no rule of this task/, rules);
  // What only resembles the route is another path, decided by the wider rule and sent as it came.
  for (const path of ['/repos/o/r/issues/5/timelines', '/repos/o/r/issues/5/timeline-x', '/repos/o/r/issues/5/timeline_json', '/repos/o/r/issues/5/time+line', '/repos/o/r/issues/5/timeline+',
    '/repos/o/r/issues/5/x.timeline', '/repos/o/r/issues/5/timeline/x', '/repos/o/r/issues/timeline', '/repos/o/r/contents/issues/5/timeline.json', '/repos/o/r/comparex?to=b', '/repos/o/r/compare/a...b']) {
    const verdict = await allowed(req('GET', path), rules);
    assert.equal(verdict.rule, rules[2]);
    assert.equal(verdict.request.path, path);
  }
});

await check('a name GitLab takes as one segment may hold an encoded slash or dot: in a read, under a project, where the rule has a wildcard', async () => {
  const P = '/api/v4/projects/group%2Fsub%2Fproj';
  const rule = (method, path, more = {}) => ({ host: 'gitlab.example.com', method, path, fold: [3], ...more });
  const rules = [
    rule('GET', `${P}/merge_requests/*/merge_ref`, { deny: 'elsewhere' }),
    rule('GET', `${P}/repository/compare`, { query: { from: 'free' } }),
    rule('GET', `${P}/repository/branches/*`, { pick: ['name'] }),
    rule('GET', `${P}/merge_requests/**`),
    rule('GET', `${P}/repository/**`),
    rule('GET', `${P}/pipelines/*`),
    rule('GET', `${P}/issues/*`),
    rule('GET', `${P}/issues/*/links`, { deny: 'elsewhere' }),
    rule('PUT', `${P}/repository/**`),
    rule('GET', '/api/v4/projects/group%2Fmy.proj/issues/*'),
    rule('DELETE', '/api/v4/projects/group%2Fmy.proj/issues/*'),
    rule('GET', '/api/v4/groups/**', { fold: [] }),
  ];
  const gl = (path, method = 'GET') => req(method, path, { host: 'gitlab.example.com' });
  // Sent as it came, and decided by the rule the path names as GitLab's router reads it.
  for (const [path, index] of [['/repository/files/src%2Fmain.js', 4], ['/repository/files/src%2fmain%2Ejs/raw?ref=feature%2Flogin', 4], ['/repository/files/README%2Emd?ref=main', 4],
    ['/repository/files/%2Egithub%2Fworkflows%2Fci.yml/raw', 4], ['/repository/branches/feature%2Flogin', 2], ['/repository/branches/release%2F1%2e0', 2], ['/repository/branches/main.json', 2],
    ['/repository/commits/feature%2Flogin/diff', 4], ['/repository/tags/release%2F1.0', 4], ['/repository/compare%2Fx', 4], ['/issues/5', 6]]) {
    const verdict = await allowed(gl(`${P}${path}`), rules);
    assert.equal(verdict.rule, rules[index], path);
    assert.equal(verdict.request.path, `${P}${path}`);
  }
  await allowed(gl(`${P}/repository/branches/feature%2Flogin`, 'get'), rules);
  // The project's own segment takes both escapes whatever the method.
  for (const method of ['GET', 'DELETE']) for (const project of ['group%2Fmy.proj', 'group%2Fmy%2Eproj', 'Group%2fMy%2eProj']) await allowed(gl(`/api/v4/projects/${project}/issues/5`, method), rules);
  await refused(gl('/api/v4/projects/group%2Fmy%2Fproj/issues/5'), /no rule/, rules);

  // A name's parts are a path's: none is empty or a dot segment.
  for (const name of ['..%2F..%2Fcompare', 'a%2F..%2Fb', 'a%2F%2E%2E%2Fb', '%2E%2E', '.%2e%2Fx', 'a%2F.', 'x%2F..%2F..%2Fmerge_requests%2F5%2Fmerge']) {
    await refused(gl(`${P}/repository/files/${name}/raw`), /dot segment/, rules);
    await refused(gl(`${P}/repository/branches/${name}`), /dot segment/, rules);
  }
  for (const name of ['a%2F%2Fb', '%2Fa', 'a%2F', '%2f']) await refused(gl(`${P}/repository/files/${name}`), /empty segment/, rules);

  // An encoded slash is no separator to GitLab, and the request is refused where it would
  // be one to a proxy in front: the route that makes is an earlier rule's, a refused one's
  // or no rule's.
  const cut = /with its encoded slash read as a separator/;
  for (const tail of ['/merge_requests/5%2Fmerge_ref', '/merge_requests/5%2fmerge_ref', '/merge_requests/5%2FMerge_Ref.json', '/repository/branches%2Fmain', '/merge_requests/5%2E0%2Fmerge_ref%2Ejson',
    '/pipelines/7%2Fvariables', '/issues/5%2Flinks', '/issues/5%2Flinks%2Ejson']) await refused(gl(`${P}${tail}`), cut, rules);
  // It stands for no "/" of a rule's own path either.
  for (const tail of ['/repository%2Fcompare?from=a', '/merge_requests%2F5', '/repository%2Ffiles%2Fx']) await refused(gl(`${P}${tail}`), /no rule/, rules);
  await refused(gl('/api/v4/projects/group%2Fsub%2Fproj%2Fissues/5'), /no rule/, rules);

  // An encoded dot is a dot to GitLab's router, the one before a format included.
  const second = /could be read as a route another rule of this task decides/;
  for (const tail of ['/repository/compare%2Ejson?from=a&to=b', '/repository/compare%2ejson', '/merge_requests/5/merge_ref%2Ejson', '/repository/compare.json%2Fx', '/repository/Compare%2Ejson%2Fx']) await refused(gl(`${P}${tail}`), second, rules);

  // Neither escape stands in a write past the project, outside a project's path, or on GitHub.
  await allowed(gl(`${P}/repository/branches/main`, 'PUT'), rules);
  await refused(gl(`${P}/repository/branches/feature%2Flogin`, 'PUT'), /encoded slash/, rules);
  await refused(gl(`${P}/repository/files/README%2Emd`, 'PUT'), /encoded dot/, rules);
  await allowed(gl('/api/v4/groups/a/b.c'), rules);
  await refused(gl('/api/v4/groups/a%2Fb'), /encoded slash/, rules);
  await refused(gl('/api/v4/groups/a/b%2Ec'), /encoded dot/, rules);
  await refused(gl('/api/v4/groups/projects/x/y%2Fz'), /encoded slash/, rules);
  await refused(gl('/api/v3/projects/x/y%2Fz'), /encoded slash/, rules);
  await refused(gl('/x/v4/projects/x/y%2Fz'), /encoded slash/, rules);
  for (const path of ['/repos/o/r/branches/feature%2Flogin', '/repos/o/r/pulls/a%2Fb', '/repos/o/r/pulls/README%2Emd', '/repos/o/r/pulls%2F578']) await refused(req('GET', path), /encoded slash|encoded dot/);
});

await check('a method is one of five, uppercased, and no header changes it', async () => {
  await allowed(req('get', '/repos/o/r'));
  for (const method of ['HEAD', 'OPTIONS', 'TRACE', 'CONNECT', 'PROPFIND', 'GET ', 'GET\u0000', '', 5, null]) await refused(req(method, '/repos/o/r'), /method/);
  // An override header does not turn a matched GET into the write it names: the rule
  // matched is the GET rule, and forge.perform drops the header.
  const verdict = await allowed(req('GET', '/repos/o/r/pulls/578', { headers: { 'X-HTTP-Method-Override': 'DELETE' } }));
  assert.equal(verdict.rule.method, 'GET');
  assert.equal(verdict.request.method, 'GET');
  await refused(req('GET', '/repos/o/r/pulls/578?_method=DELETE'), /"_method" is never allowed/);
  await refused(req('POST', '/repos/o/r/pulls/578/merge', { headers: { 'X-HTTP-Method-Override': 'GET' } }), /no rule/);
});

await check('headers are read once: a name given twice or a value with a line break is refused', async () => {
  await refused(req('GET', '/repos/o/r', { headers: { Accept: 'a', accept: 'b' } }), /given twice/);
  await refused(post('/repos/o/r/pulls/578/reviews', { event: 'COMMENT' }, { 'Content-Type': 'application/json', 'content-type': 'text/plain' }), /given twice/);
  await refused(req('GET', '/repos/o/r', { headers: { accept: 'a\r\nauthorization: token x' } }), /malformed header/);
  await refused(req('GET', '/repos/o/r', { headers: { 'x y': 'a' } }), /malformed header/);
  await refused(req('GET', '/repos/o/r', { headers: { accept: 5 } }), /malformed header/);
  await refused(req('GET', '/repos/o/r', { headers: [] }), /not an object/);
  const verdict = await allowed(req('GET', '/repos/o/r', { headers: { Accept: 'application/json', Authorization: 'token x' } }));
  assert.deepEqual(Object.keys(verdict.request.headers), ['accept', 'authorization']);
});

await check('query parameters that change who acts are refused everywhere, and a write takes only pinned ones', async () => {
  await allowed(req('GET', '/repos/o/r/pulls?state=open&per_page=100&page=2'));
  for (const name of ['sudo', 'private_token', 'access_token', 'job_token', '_method', 'SUDO', 'sudo[]', 'access_token%5B%5D']) {
    await refused(req('GET', `/repos/o/r/pulls?${name}=x`), /never allowed|must be encoded/);
  }
  const put = (path, body = { resolved: true }) => ({ host: 'gitlab.example.com', method: 'PUT', path, headers: JSON_TYPE, body: b64(body) });
  const base = '/api/v4/projects/group%2Fsub%2Fproj/merge_requests/5/discussions/abc';
  await allowed(put(base));
  await allowed(put(`${base}?resolved=true`, {}));
  await refused(put(`${base}?resolved=false`), /must be "true"/);
  await refused(put(`${base}?resolved=true&resolved=false`), /given once/);
  await refused(put(`${base}?resolved%5B%5D=true`), /given once, plainly/);
  await refused(put(`${base}?state_event=close`), /"state_event" is not part of this rule/);
  await refused(put(`${base}?resolved=true&body=x`), /"body" is not part of this rule/);
  await refused(post('/repos/o/r/pulls/578/reviews?event=APPROVE', { event: 'COMMENT' }), /"event" is not part of this rule/);
  await refused(req('DELETE', '/repos/o/r/pulls/578/reviews/1?x=1'), /not part of this rule/);
});

await check('a search must carry the pool\'s repository once, as its own term', async () => {
  await allowed(req('GET', '/search/issues?advanced_search=true&page=1&per_page=2&q=%28+fix+%29+repo%3Ao%2Fr+type%3Apr'));
  await allowed(req('GET', '/search/issues?q=repo:O/R+is:open'));
  await refused(req('GET', '/search/issues'), /"q" is required/);
  await refused(req('GET', '/search/issues?q=is:open'), /not pinned/);
  await refused(req('GET', '/search/issues?q=repo:o/r+repo:o/secret'), /other than the pool/);
  await refused(req('GET', '/search/issues?q=repo:o/r&q=org:victim'), /given once/);
  await refused(req('GET', '/search/issues?q=org:victim&q=repo:o/r'), /other than the pool|given once/);
  await refused(req('GET', '/search/issues?q=repo%3Ao%2Fr%20OR%20user%3Avictim'), /top-level OR|other than the pool/);
  await refused(req('GET', '/search/code?q=repo:o/r'), /no rule/);
  await refused(req('GET', '/search/repositories?q=user:me'), /no rule/);
  // A quote that does not wrap a whole term is where two readers of the query part ways.
  await allowed(req('GET', '/search/issues?q=repo:o/r+%22fix+bug%22+label:%22good+first+issue%22'));
  await refused(req('GET', '/search/issues?q=repo:o/r+a%22+repo:evil/x+%22b'), /quote that is not a whole quoted term/);
  await refused(req('GET', '/search/issues?q=repo:o/r+a%5C%22+repo:evil/x+%5C%22b'), /quote that is not a whole quoted term/);
  await refused(req('GET', '/search/issues?q=repo:o/r+%22see+repo:evil/x%22'), /a quoted term that holds a qualifier/);
  // A read whose rule names its parameters takes no other.
  await refused(req('GET', '/search/issues?q=repo:o/r&repository_id=5'), /"repository_id" is not part of this rule/);
  await allowed(req('GET', '/search/issues?q=repo:o/r&page=2&page=3&per_page%5B%5D=4'));
  await allowed(req('GET', '/repos/o/r/pulls/1?anything=at-all'));
});

await check('a rule may refuse what it matches, and may refuse a character anywhere in the path', async () => {
  const rules = [
    { host: 'api.github.com', method: 'GET', path: '/repos/o/r/issues/*/timeline', fold: [1, 2], deny: 'this answer holds other repositories' },
    { host: 'api.github.com', method: 'GET', path: '/repos/o/r/issues/**', fold: [1, 2] },
    { host: 'api.github.com', method: 'GET', path: '/repos/o/r/compare/**', fold: [1, 2], without: { ':': 'a side that names another repository' } },
  ];
  await allowed(req('GET', '/repos/o/r/issues/5'), rules);
  await allowed(req('GET', '/repos/o/r/issues/5/timeline/x'), rules);
  await refused(req('GET', '/repos/o/r/issues/5/timeline'), /^this answer holds other repositories$/, rules);
  await refused(req('GET', '/repos/O/R/issues/5/timeline?per_page=1'), /other repositories/, rules);
  await refused(req('GET', '/repos/o/r/issues/5/Timeline'), /no rule/, rules.slice(0, 1));
  await allowed(req('GET', '/repos/o/r/compare/main...feature'), rules);
  for (const path of ['/repos/o/r/compare/main...them:feature', '/repos/o/r/compare/main...them%3Afeature', '/repos/o/r/compare/a/b:c...d', '/repos/o/r/compare/x/y/z:']) {
    await refused(req('GET', path), /^a side that names another repository$/, rules);
  }
});

await check('a pinned body is strict JSON with every member named by the rule', async () => {
  const reviews = '/repos/o/r/pulls/578/reviews';
  const verdict = await allowed(post(reviews, '{ "commit_id" : "abc",\n "body": "x" }'));
  assert.equal(Buffer.from(verdict.request.body, 'base64').toString(), '{"commit_id":"abc","body":"x"}', 'the forge is sent the reading that was checked');
  await allowed(post(reviews, { commit_id: 'abc' }, { 'content-type': 'application/json; charset=utf-8' }));
  await allowed(post(reviews, { event: 'COMMENT', body: 'done' }));
  await allowed(req('POST', reviews));
  await refused(post(reviews, { event: 'APPROVE' }), /"event" has a value this task may not use/);
  await refused(post(reviews, { event: 'REQUEST_CHANGES', body: 'x' }), /"event" has a value/);
  await refused(post(reviews, { event: 'comment' }), /"event" has a value/);
  await refused(post(reviews, { event: ['COMMENT'] }), /"event" has a value/);
  await refused(post(reviews, { comments: [] }), /"comments" is not part of this rule/);
  await refused(post(reviews, '{"body":"x","__proto__":{"event":"APPROVE"}}'), /"__proto__" is not part of this rule/);
  await refused(post(reviews, '{"event":"COMMENT","event":"APPROVE"}'), /duplicate key "event"/);
  await refused(post(reviews, '{"event":"APPROVE","event":"COMMENT"}'), /duplicate key "event"/);
  await refused(post(reviews, '{"event":"COMMENT","\\u0065vent":"APPROVE"}'), /duplicate key "event"/);
  await refused(post(reviews, '{"event":"COMMENT"} {"event":"APPROVE"}'), /trailing data/);
  await refused(post(reviews, '[{"event":"APPROVE"}]'), /not a JSON object/);
  await refused(post(reviews, '"event=APPROVE"'), /not a JSON object/);
  await refused(post(reviews, 'null'), /not a JSON object/);
  await refused(post(reviews, '﻿{"event":"COMMENT"}'), /not strict JSON/);
  await refused(req('POST', reviews, { headers: JSON_TYPE, body: Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d]).toString('base64') }), /not valid UTF-8/);
  const events = '/repos/o/r/pulls/578/reviews/9/events';
  await allowed(post(events, { event: 'COMMENT', body: 'summary' }));
  await refused(post(events, { event: 'APPROVE' }), /"event" has a value/);
  await refused(post(events, { body: 'no event: the forge would pick one' }), /"event" is required/);
  await refused(req('POST', events), /"event" is required/);
});

await check('a body that is not JSON, or says it is something else, cannot step around the pins', async () => {
  const reviews = '/repos/o/r/pulls/578/reviews';
  await refused(post(reviews, 'event=APPROVE', { 'content-type': 'application/x-www-form-urlencoded' }), /must be sent as application\/json/);
  await refused(post(reviews, { event: 'COMMENT' }, { 'content-type': 'application/x-www-form-urlencoded' }), /must be sent as application\/json/);
  await refused(post(reviews, { event: 'COMMENT' }, { 'content-type': 'multipart/form-data; boundary=x' }), /must be sent as application\/json/);
  await refused(post(reviews, { event: 'COMMENT' }, { 'content-type': 'text/plain' }), /must be sent as application\/json/);
  await refused(post(reviews, { event: 'COMMENT' }, {}), /must be sent as application\/json/);
  await refused(post(reviews, { event: 'COMMENT' }, { 'content-type': 'application/json; charset=utf-16' }), /must be sent as application\/json/);
  await refused(post(reviews, { event: 'COMMENT' }, { 'content-type': 'application/json, application/x-www-form-urlencoded' }), /must be sent as application\/json/);
  await refused(post(reviews, { event: 'COMMENT' }, { ...JSON_TYPE, 'content-encoding': 'gzip' }), /encoded body cannot be checked/);
  await refused(req('POST', reviews, { headers: JSON_TYPE, body: 'not base64!' }), /not base64/);
  await refused(req('POST', reviews, { headers: JSON_TYPE, body: 'abc' }), /not base64/);
  await refused(req('POST', reviews, { headers: JSON_TYPE, body: { event: 'COMMENT' } }), /not base64/);
  await refused(req('GET', '/repos/o/r', { body: b64('x') }), /allows no body/);
  await refused(req('DELETE', '/repos/o/r/pulls/578/reviews/1', { headers: JSON_TYPE, body: b64({ x: 1 }) }), /allows no body/);
});

await check('text sent to GitLab may hold no line a quick action could start on', async () => {
  const note = (body) => ({ host: 'gitlab.example.com', method: 'POST', path: '/api/v4/projects/group%2Fsub%2Fproj/issues/421/notes', headers: JSON_TYPE, body: b64({ body }) });
  await allowed(note('Fixed in abc123. See src/a.js and https://example.com/x - 1/2 done.'));
  for (const text of ['/merge', 'done\n/merge', 'done\r\n/approve', 'done\r/close', '  /assign @mallory', '\t/label ~x', 'a /merge', 'a\u000b/merge', 'a\u000c/merge', 'a\u0085/merge', '```\n/merge\n```']) {
    await refused(note(text), /starting with "\/"/);
  }
  await refused(note(['/merge']), /starting with "\/"/);
  await refused(note(5), /starting with "\/"/);
});

await check('strict JSON refuses everything two parsers could read two ways', async () => {
  const parse = (text) => parseStrictJson(Buffer.from(text));
  assert.equal(JSON.stringify(parse(' {"a":[1,-2.5e3,true,false,null,"\\u00e9\\n"],\n"b":{}} ')), '{"a":[1,-2500,true,false,null,"é\\n"],"b":{}}');
  assert.equal(Object.getPrototypeOf(parse('{}')), null);
  assert.equal(parse('{"__proto__":1}').__proto__, 1);
  for (const bad of ['', '{', '{"a":1,}', '[1,]', "{'a':1}", '{a:1}', '{"a":1,"a":1}', '{"a":{"b":1,"b":2}}', '[{"a":1,"a":2}]', '01', '1.', '.5', '+1', 'NaN', 'Infinity', '1e999',
    '9007199254740993', '"\\x41"', '"a\tb"', '"\\ud83d"x', 'true false', '{"a":1}//c', '/*c*/{}', '﻿{}', 'nul', `${'['.repeat(100)}${']'.repeat(100)}`]) {
    assert.throws(() => parse(bad), SyntaxError, bad);
  }
  assert.throws(() => parseStrictJson(Buffer.from([0x22, 0xc3, 0x28, 0x22])), /UTF-8/);
});

await check('a rule that asks the forge refuses when nothing can answer or the answer is no', async () => {
  const any = [{ host: 'api.github.com', method: 'DELETE', path: '/repos/o/r/pulls/*/reviews/*', pull: { segment: 4, notAuthor: 'me' } },
    { host: 'api.github.com', method: 'POST', path: '/repos/o/r/pulls/*/x', pull: { segment: 4, author: 'me' } },
    { host: 'api.github.com', method: 'DELETE', path: '/repos/o/r/pulls/comments/*', comment: { segment: 5, repo: 'o/r', item: { type: 'pr', number: 578 }, own: true, pending: true, identity: 'me' } },
    { host: 'api.github.com', method: 'POST', path: '/repos/o/r/pulls/*/comments/*/replies', comment: { segment: 6, pullSegment: 4, repo: 'o/r', item: { type: 'pr', author: 'me' } }, body: { body: 'free' } }];
  await allowed(req('DELETE', '/repos/o/r/pulls/578/reviews/1'), any);
  await refused(req('DELETE', '/repos/o/r/pulls/579/reviews/1'), /#579 was opened by me/, any);
  await refused(req('DELETE', '/repos/o/r/pulls/999/reviews/1'), /not a pull request the forge would show/, any);
  await refused(req('DELETE', '/repos/o/r/pulls/abc/reviews/1'), /does not name an object by number/, any);
  await refused(req('DELETE', '/repos/o/r/pulls/0578/reviews/1'), /does not name an object by number/, any);
  // A number past the safe range is not looked up as the nearest one that is.
  const far = world();
  far.pulls[9007199254740992] = { ...far.pulls[578], number: 9007199254740992 };
  await allowed(req('DELETE', '/repos/o/r/pulls/9007199254740991/reviews/1'), any, { ...far, pull: async (number) => far.pulls[number + 1] });
  await refused(req('DELETE', '/repos/o/r/pulls/9007199254740993/reviews/1'), /does not name an object by number/, any, far);
  await refused(req('DELETE', '/repos/o/r/pulls/578/reviews/1'), /nothing here can look a pull request up/, any, {});
  await allowed(req('POST', '/repos/o/r/pulls/579/x'), any);
  await refused(req('POST', '/repos/o/r/pulls/578/x'), /#578 was not opened by me/, any);
  await refused(req('POST', '/repos/o/r/pulls/580/x'), /#580 is not open/, any);
  await allowed(req('DELETE', '/repos/o/r/pulls/comments/11'), any);
  await refused(req('DELETE', '/repos/o/r/pulls/comments/12'), /not written by this task's account/, any);
  await refused(req('DELETE', '/repos/o/r/pulls/comments/13'), /belongs to #579/, any);
  await refused(req('DELETE', '/repos/o/r/pulls/comments/99'), /not one the forge would show/, any);
  await refused(req('DELETE', '/repos/o/r/pulls/comments/11'), /nothing here can look a comment up/, any, {});
  await allowed(post('/repos/o/r/pulls/579/comments/13/replies', { body: 'Fixed in abc' }), any);
  await refused(post('/repos/o/r/pulls/579/comments/12/replies', { body: 'x' }), /not on the pull request the path names/, any);
  await refused(post('/repos/o/r/pulls/578/comments/12/replies', { body: 'x' }), /#578 was not opened by me/, any);
});

await check('what a request uses up is counted against the task, and a refused request uses nothing', async () => {
  const rules = [
    { host: 'api.github.com', method: 'POST', path: '/repos/o/r/pulls', body: { head: { created: true, required: true }, draft: { equals: true, required: true }, title: 'free', base: 'free' } },
    { host: 'gitlab.example.com', method: 'PUT', path: '/api/v4/projects/9/issues/421', body: { assignee_ids: { assignees: 421, required: true } } },
    { host: 'gitlab.example.com', method: 'POST', path: '/api/v4/projects/9/merge_requests', body: { source_branch: { created: true, required: true }, title: { prefix: 'Draft:', required: true }, target_project_id: { equals: 9 } } },
  ];
  const ctx = world({ branches: ['refs/heads/fix-421', 'refs/heads/fix-422'] });
  const open = (body) => post('/repos/o/r/pulls', body);
  const draft = (head, base = 'main') => open({ head, base, title: 't', draft: true });
  const used = () => [ctx.state.pulls, ctx.state.asked];
  const opened = await allowed(draft('fix-421'), rules, ctx);
  assert.deepEqual(used(), [[], ['fix-421']], 'counted before it is sent');
  await refused(draft('fix-421', 'other'), /pull request from fix-421 is on its way to the forge/, rules, ctx);
  assert.deepEqual(ctx.listed, [], 'what is on its way is not asked about');
  // The forge's answer settles it: a refusal gives the one pull request back, "created" makes it the task's one.
  conclude(opened.request, { status: 422, body: Buffer.from('{}') });
  assert.deepEqual(used(), [[], []]);
  conclude((await allowed(draft('fix-422'), rules, ctx)).request, { status: 201, body: Buffer.from('{}') });
  assert.deepEqual(used(), [['fix-422'], []]);
  await refused(draft('fix-422', 'other'), /has opened its pull request from fix-422/, rules, ctx);
  assert.deepEqual(ctx.listed, [], 'what the forge answered is not asked about');

  // An answer that does not say, or none: it may have been opened, so it stays counted until the forge is asked.
  for (const answer of [{ status: 502, body: Buffer.from('bad gateway') }, { status: 302, body: Buffer.alloc(0) }, undefined]) {
    const unsure = await allowed(draft('fix-421'), rules, ctx);
    conclude(unsure.request, answer);
    assert.deepEqual(used(), [['fix-422'], ['fix-421']], `after ${answer?.status}`);
    conclude(unsure.request, { status: 422, body: Buffer.from('{}') });
    assert.deepEqual(used(), [['fix-422'], ['fix-421']], 'a request is concluded once');
    // The forge shows no pull request from that branch: the next try is allowed, and is the one counted.
    ctx.listed.length = 0;
    conclude((await allowed(draft('fix-421'), rules, ctx)).request, { status: 422, body: Buffer.from('{}') });
    assert.deepEqual(ctx.listed, [['fix-421', undefined, true]]);
    assert.deepEqual(used(), [['fix-422'], []]);
  }
  // The forge shows one, open or closed: it is the task's one.
  for (const shown of [true, false]) {
    conclude((await allowed(draft('fix-421'), rules, ctx)).request, undefined);
    ctx.pulls[590] = { number: 590, open: shown, author: 'me', headRepo: 'o/r', headRepoId: 1, headRef: 'fix-421' };
    await refused(draft('fix-421'), /has opened its pull request from fix-421/, rules, ctx);
    assert.deepEqual(used(), [['fix-422', 'fix-421'], []]);
    delete ctx.pulls[590];
    ctx.state.pulls = ['fix-422'];
  }
  // A forge that does not say has said nothing.
  conclude((await allowed(draft('fix-421'), rules, ctx)).request, undefined);
  await refused(draft('fix-421'), /^the forge did not say which pull requests there are/, rules, { ...ctx, async pullsByHead() { throw new Error('forge: the forge did not say which pull requests there are (it answered 503)'); } });
  await refused(draft('fix-421'), /nothing here can look a pull request up/, rules, { ...ctx, pullsByHead: undefined });
  assert.deepEqual(used(), [['fix-422'], ['fix-421']]);
  // A reading of an unanswered creation does not undo the one sent after it.
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const late = ask(draft('fix-421'), rules, { ...ctx, async pullsByHead() { await gate; return []; } });
  const second = await allowed(draft('fix-421'), rules, ctx);
  release();
  assert.match((await late).reason, /pull request from fix-421 is on its way to the forge/);
  assert.deepEqual(used(), [['fix-422'], ['fix-421']]);
  conclude(second.request, { status: 201, body: Buffer.from('{}') });
  // Two requests that both ask about the same unanswered one count it once.
  const both = world({ branches: ['refs/heads/fix-1', 'refs/heads/fix-2', 'refs/heads/fix-3'] });
  both.state.asked = ['fix-1'];
  both.pulls[591] = { number: 591, open: true, author: 'me', headRepo: 'o/r', headRepoId: 1, headRef: 'fix-1' };
  for (const verdict of await Promise.all([ask(draft('fix-2'), rules, both), ask(draft('fix-3'), rules, both)])) assert.equal(verdict.ok, true, verdict.reason);
  assert.deepEqual([both.state.pulls, both.state.asked], [['fix-1'], ['fix-2', 'fix-3']]);
  // A pull request from a branch of the fork is looked for under the fork's account.
  const forked = world({ branches: ['me/r:refs/heads/fix-9'] });
  Object.assign(forked.state, { asked: ['me/r:fix-9'] });
  await allowed(draft('me:fix-9'), [{ ...rules[0], body: { ...rules[0].body, head: { created: 'label', required: true } } }], forked);
  assert.deepEqual(forked.listed, [['fix-9', 'me', true]]);
  assert.deepEqual([forked.state.pulls, forked.state.asked], [[], ['me/r:fix-9']]);
  ctx.state.pulls = [];
  await refused(open({ head: 'main', base: 'release', title: 't', draft: true }), /only be opened from a branch this task pushed/, rules, ctx);
  await refused(open({ head: 'o:fix-421', title: 't', draft: true }), /only be opened from a branch/, rules, ctx);
  await refused(open({ head: ['fix-421'], title: 't', draft: true }), /only be opened from a branch/, rules, ctx);
  await refused(open({ head: 'fix-421', title: 't', draft: false }), /"draft" has a value/, rules, ctx);
  await refused(open({ head: 'fix-421', title: 't' }), /"draft" is required/, rules, ctx);
  await refused(open({ title: 't', draft: true }), /"head" is required/, rules, ctx);
  await refused(open({ head: 'fix-421', title: 't', draft: true, head_repo: 'victim/r' }), /"head_repo" is not part/, rules, ctx);
  await refused(open({ head: 'fix-421', title: 't', draft: true, issue: 3 }), /"issue" is not part/, rules, ctx);
  await refused(open({ head: 'fix-421', title: 't', draft: true }), /needs the task's state/, rules, {});
  assert.deepEqual(ctx.state, { branches: ['refs/heads/fix-421', 'refs/heads/fix-422'], reserved: [], sent: {}, pulls: [], asked: [] }, 'a refused request uses nothing');

  // The whole new assignee list of a GitLab issue: what the forge holds, give or take the task's own account.
  const gl = (method, path, body) => ({ host: 'gitlab.example.com', method, path, headers: JSON_TYPE, body: b64(body) });
  const assign = (ids) => gl('PUT', '/api/v4/projects/9/issues/421', { assignee_ids: ids });
  ctx.assigned = [8];
  await allowed(assign([8, 7]), rules, ctx);
  await allowed(assign([8]), rules, ctx);
  for (const ids of [[7], [0], [], [7, 9], [8, 9, 7], [0, 8], [8, 0, 7], ['8', 7], '8', 8, { 0: 8 }, [8.5, 7], [8, 7, -3]]) await refused(assign(ids), /only add or remove this task's own account|is not a list of account ids/, rules, ctx);
  // An id given twice is one account: it adds nobody and does not stand in for one left out.
  await allowed(assign([8, 8, 7]), rules, ctx);
  ctx.assigned = [8, 9];
  for (const ids of [[8, 8], [8, 8, 7], [9, 9, 7]]) await refused(assign(ids), /only add or remove this task's own account/, rules, ctx);
  ctx.assigned = [7];
  for (const ids of [[0], [], [7]]) await allowed(assign(ids), rules, ctx);
  ctx.assigned = null;
  await refused(assign([7]), /#421 is not an issue the forge would show/, rules, ctx);
  ctx.assigned = [];
  await refused(gl('PUT', '/api/v4/projects/9/issues/421', { assignee_ids: [7], state_event: 'close' }), /"state_event" is not part/, rules, ctx);
  await refused(assign([7]), /nothing here can tell/, rules, { state: {} });
  await refused(assign([7]), /nothing here can tell/, rules, { state: {}, async self() { return { id: 7, login: 'me' }; } });
  // A lookup that fails is the refusal, in its own words.
  const failing = { ...world(), async assignees() { throw new Error('forge: the forge did not say who is assigned to #421 (it answered 429)'); } };
  await refused(assign([7]), /^the forge did not say who is assigned to #421 \(it answered 429\)$/, rules, failing);
  await refused(assign([7]), /^boom$/, rules, { ...world(), async self() { throw new Error('boom'); } });
  await allowed(gl('POST', '/api/v4/projects/9/merge_requests', { source_branch: 'fix-421', title: 'Draft: t', target_project_id: 9 }), rules, ctx);
  await refused(gl('POST', '/api/v4/projects/9/merge_requests', { source_branch: 'fix-421', title: 't' }), /must start with "Draft:"/, rules, ctx);
  await refused(gl('POST', '/api/v4/projects/9/merge_requests', { source_branch: 'fix-421', title: ['Draft: t'] }), /must start with/, rules, ctx);
  await refused(gl('POST', '/api/v4/projects/9/merge_requests', { source_branch: 'fix-421', title: 'Draft: t', target_project_id: 10 }), /"target_project_id" has a value/, rules, ctx);
  await refused(gl('POST', '/api/v4/projects/9/merge_requests', { source_branch: 'fix-421', title: 'Draft: t', merge_when_pipeline_succeeds: true }), /not part of this rule/, rules, ctx);
});

await check('the first matching rule decides alone: a later, wider rule is not a second chance', async () => {
  const rules = [
    { host: 'api.github.com', method: 'POST', path: '/repos/o/r/pulls/578/reviews', body: { event: { oneOf: ['COMMENT'] } } },
    { host: 'api.github.com', method: 'POST', path: '/repos/o/r/pulls/*/reviews', body: { event: 'free' } },
  ];
  await refused(post('/repos/o/r/pulls/578/reviews', { event: 'APPROVE' }), /"event" has a value/, rules);
  assert.equal((await allowed(post('/repos/o/r/pulls/9/reviews', { event: 'APPROVE' }), rules)).rule, rules[1]);
  assert.equal((await allowed(req('GET', '/user'))).request.pick, RULES[4].pick, 'what the forge may answer travels with the request');
});
