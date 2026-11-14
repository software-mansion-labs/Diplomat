// Acting as the requester: the capability, the MAC and sequence number on each request
// made under it, and the rules - which must cover a request as a forge will read it, not
// merely as it is spelled.
// Run: node test/core-capability.mjs

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { b64u, canon } from '../src/core/canon.js';
import {
  SeqTracker, actMac, buildCapability, capabilityExp, checkAct, macOf, matchRules, validForgeRequest, validRule, verifyCapability,
} from '../src/core/capability.js';
import { sign } from '../src/core/identity.js';
import { POOL, T0, ident } from './lib/core-fixtures.mjs';

function check(name, fn) {
  fn();
  console.log(`PASS ${name}`);
}

const TASK = `${POOL}#review:pr-578@octocat`;
const [host, executor, other] = [ident(1), ident(2), ident(3)];
const REVIEWS = { host: 'api.github.com', method: 'POST', path: '/repos/acme/widgets/pulls/578/reviews' };
const body = (value) => b64u(Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)));
const req = (over = {}) => ({
  host: 'api.github.com', method: 'POST', path: '/repos/acme/widgets/pulls/578/reviews',
  headers: { 'content-type': 'application/json', accept: 'application/vnd.github+json' }, body: body({ event: 'COMMENT', body: 'looks fine' }), ...over,
});
const get = (path, over = {}) => req({ method: 'GET', path, headers: { accept: 'application/json' }, body: '', ...over });
const verdict = (rules, request) => matchRules(rules, request).verdict;
const capability = (over = {}) => buildCapability(host, {
  keyId: Buffer.alloc(16, 5), pool: POOL, taskId: TASK, executor: executor.pk, rules: [REVIEWS], exp: T0 + 7800, ...over,
});

check('a capability is signed by the host that issues it and expires with the lease and its grace', () => {
  const cap = capability();
  assert.deepEqual(Object.keys(cap).sort(), ['executor', 'exp', 'host', 'keyId', 'pool', 'rules', 'sig', 'taskId']);
  assert.equal(cap.host, host.pk);
  assert.deepEqual(verifyCapability(cap, { host: host.pk, executor: executor.pk, taskId: TASK }, T0), { ok: true });
  assert.deepEqual(verifyCapability(cap, {}, T0 + 7799), { ok: true });
  assert.deepEqual(verifyCapability(cap, {}, T0 + 7800), { ok: false, code: 'expired' });
  assert.equal(capabilityExp({ leaseUntil: T0 + 7200 }), T0 + 7800);
});

check('a capability that is changed, forged, malformed or for someone else is refused', () => {
  const cap = capability();
  const reseal = (signer, over) => {
    const { sig: _, ...fields } = { ...cap, ...over };
    return { ...fields, sig: sign(signer, 'dn1/cap', fields) };
  };
  const bad = [
    { ...cap, exp: cap.exp + 3600 }, { ...cap, rules: [{ ...REVIEWS, path: '/**' }] }, { ...cap, executor: other.pk },
    reseal(other, {}), reseal(executor, {}),
    reseal(host, { extra: 1 }), reseal(host, { keyId: 'short' }), reseal(host, { rules: 'all' }), reseal(host, { rules: [{ host: 'api.github.com' }] }),
    reseal(host, { rules: Array(129).fill(REVIEWS) }), reseal(host, { exp: -1 }), reseal(host, { taskId: 'x' }),
    reseal(host, { pool: 'github.com/acme/other' }), null, 'cap', [],
  ];
  for (const [i, c] of bad.entries()) assert.deepEqual(verifyCapability(c, {}, T0), { ok: false, code: 'bad-capability' }, `case ${i}`);
  assert.equal(verifyCapability(cap, { executor: other.pk }, T0).code, 'bad-capability');
  assert.equal(verifyCapability(cap, { host: other.pk }, T0).code, 'bad-capability');
  assert.equal(verifyCapability(cap, { taskId: `${POOL}#review:pr-579@octocat` }, T0).code, 'bad-capability');
  assert.equal(verifyCapability(cap, { keyId: cap.keyId }, T0).ok, true);
});

check('the MAC is HMAC-SHA256 over the canonical key id, seq and request', () => {
  const secret = Buffer.alloc(32, 9);
  const act = { keyId: b64u(Buffer.alloc(16, 5)), seq: 3, request: req() };
  const direct = crypto.createHmac('sha256', secret).update(canon({ keyId: act.keyId, seq: 3, request: act.request })).digest('base64url');
  assert.equal(actMac(secret, act), direct);
  assert.equal(actMac(secret, { ...act, taskId: TASK, mac: 'ignored' }), direct, 'only those three members');
  assert.notEqual(actMac(secret, { ...act, seq: 4 }), direct);
  assert.notEqual(actMac(secret, { ...act, keyId: b64u(Buffer.alloc(16, 6)) }), direct);
  assert.notEqual(actMac(secret, { ...act, request: req({ method: 'PUT' }) }), direct);
  assert.notEqual(actMac(Buffer.alloc(32, 8), act), direct);
  assert.equal(macOf(secret, { a: 1 }), crypto.createHmac('sha256', secret).update('{"a":1}').digest('base64url'));
});

check('a sequence number is new only when it is greater than every one used under its key', () => {
  const seqs = new SeqTracker();
  assert.equal(seqs.use('k1', 0), true);
  assert.equal(seqs.use('k1', 0), false, 'equal is not new');
  assert.equal(seqs.use('k1', 5), true);
  for (const old of [5, 4, 1, 0]) assert.equal(seqs.use('k1', old), false, `seq ${old} after 5`);
  assert.equal(seqs.isNew('k1', 6), true);
  assert.equal(seqs.isNew('k1', 5), false);
  assert.equal(seqs.use('k2', 0), true, 'each key counts for itself');
  assert.deepEqual(new SeqTracker(seqs.entries()).entries(), [['k1', 5], ['k2', 0]]);
  seqs.forget('k1');
  assert.equal(seqs.use('k1', 0), true);
});

check('an act request is performed only for the capability\'s executor, in time, with a new seq, a matching MAC and a covering rule', () => {
  const secret = Buffer.alloc(32, 9);
  const cap = capability();
  const act = (over = {}) => {
    const fields = { taskId: TASK, keyId: cap.keyId, seq: 1, request: req(), ...over };
    return { ...fields, mac: over.mac ?? actMac(secret, fields) };
  };
  const world = () => ({ capability: cap, secret, seqs: new SeqTracker(), from: executor.pk, now: T0 });
  assert.deepEqual(checkAct(act(), world()), { ok: true, verdict: 'allow', rule: REVIEWS });
  const denied = (body_, over = {}) => {
    const result = checkAct(body_, { ...world(), ...over });
    assert.equal(result.ok, false);
    return `${result.code}: ${result.detail}`;
  };
  assert.equal(denied(act(), { from: other.pk }), 'denied: not this key');
  assert.equal(denied(act({ keyId: b64u(Buffer.alloc(16, 6)) })), 'denied: not this key');
  assert.equal(denied(act({ taskId: `${POOL}#review:pr-579@octocat` })), 'denied: not this key');
  assert.equal(denied(act(), { now: T0 + 7800 }), 'denied: key expired');
  assert.equal(checkAct(act(), { ...world(), now: T0 + 7799 }).ok, true);
  assert.equal(denied(act({ mac: b64u(Buffer.alloc(32)) })), 'denied: bad mac');
  assert.equal(denied(act(), { secret: Buffer.alloc(32, 1) }), 'denied: bad mac');
  assert.equal(denied({ ...act(), seq: 2 }), 'denied: bad mac', 'a MAC made for another seq');
  assert.equal(denied(act({ request: req({ method: 'DELETE' }) })), 'denied: no rule covers the request');
  for (const bad of [null, {}, { ...act(), extra: 1 }, { ...act(), seq: -1 }, { ...act(), seq: 1.5 }, { ...act(), mac: 'x' }, { ...act(), request: { ...req(), path: 'nope' } },
    (({ mac: _, ...rest }) => rest)(act())]) {
    assert.equal(denied(bad), 'bad-request: not an act body');
  }

  const shared = world();
  assert.equal(checkAct(act({ seq: 4 }), shared).ok, true);
  assert.equal(denied(act({ seq: 4 }), shared), 'denied: seq is not new');
  assert.equal(denied(act({ seq: 3 }), shared), 'denied: seq is not new');
  assert.equal(denied(act({ seq: 5, mac: b64u(Buffer.alloc(32)) }), shared), 'denied: bad mac');
  assert.equal(checkAct(act({ seq: 5 }), shared).ok, true, 'a number is used only by a request whose MAC matched');
  assert.equal(denied(act({ seq: 6, request: req({ method: 'DELETE' }) }), shared), 'denied: no rule covers the request');
  assert.equal(denied(act({ seq: 6 }), shared), 'denied: seq is not new', 'and then it is used, covered or not');
});

check('a rule covers exactly its host, its method and its path', () => {
  assert.deepEqual(matchRules([REVIEWS], req()), { verdict: 'allow', rule: REVIEWS });
  assert.equal(verdict([REVIEWS], req({ host: 'uploads.github.com' })), 'deny');
  assert.equal(verdict([REVIEWS], req({ host: 'api.github.com.evil.example' })), 'deny');
  assert.equal(verdict([REVIEWS], req({ method: 'PUT' })), 'deny');
  assert.equal(verdict([REVIEWS], req({ path: '/repos/acme/widgets/pulls/579/reviews' })), 'deny');
  assert.equal(verdict([REVIEWS], req({ path: '/repos/acme/widgets/pulls/578' })), 'deny');
  assert.equal(verdict([REVIEWS], req({ path: '/repos/acme/widgets/pulls/578/reviews/1' })), 'deny');
  assert.equal(verdict([REVIEWS], req({ path: '/repos/acme/widgets/pulls/578/reviews?per_page=5' })), 'allow', 'the query is not part of the path');
  assert.equal(verdict([], req()), 'deny');
  assert.equal(verdict([{ ...REVIEWS, method: 'GET' }, REVIEWS], req()), 'allow', 'any rule of the list');
  assert.equal(verdict([{ host: 'api.github.com', method: 'GET', path: '/' }], get('/')), 'allow');
  assert.equal(verdict([{ host: 'api.github.com', method: 'GET', path: '/' }], get('/user')), 'deny');
});

check('* stands for exactly one segment and a trailing ** for any remainder', () => {
  const one = [{ host: 'api.github.com', method: 'GET', path: '/repos/acme/widgets/pulls/*/files' }];
  assert.equal(verdict(one, get('/repos/acme/widgets/pulls/578/files')), 'allow');
  assert.equal(verdict(one, get('/repos/acme/widgets/pulls/files')), 'deny', 'not zero segments');
  assert.equal(verdict(one, get('/repos/acme/widgets/pulls/578/commits/files')), 'deny', 'not two segments');
  assert.equal(verdict(one, get('/repos/acme/widgets/pulls/578%2Fcommits/files')), 'deny', 'nor two behind an escape');
  const tail = [{ host: 'api.github.com', method: 'GET', path: '/repos/acme/widgets/*' }];
  assert.equal(verdict(tail, get('/repos/acme/widgets/pulls')), 'allow');
  assert.equal(verdict(tail, get('/repos/acme/widgets')), 'deny');
  assert.equal(verdict(tail, get('/repos/acme/widgets/pulls/578')), 'deny');
  const rest = [{ host: 'api.github.com', method: 'GET', path: '/repos/acme/widgets/**' }];
  for (const path of ['/repos/acme/widgets', '/repos/acme/widgets/pulls', '/repos/acme/widgets/pulls/578/files']) assert.equal(verdict(rest, get(path)), 'allow', path);
  for (const path of ['/repos/acme/widgetsx', '/repos/acme', '/repos/acme/other/pulls', '/user']) assert.equal(verdict(rest, get(path)), 'deny', path);
  assert.equal(validRule({ host: 'api.github.com', method: 'GET', path: '/repos/**/pulls' }), false, '** only at the end');
  assert.equal(verdict([{ host: 'api.github.com', method: 'GET', path: '/repos/**/pulls' }], get('/repos/acme/widgets/pulls')), 'deny');
});

check('a path a forge could read as another one matches no rule', () => {
  const rules = [{ host: 'api.github.com', method: 'GET', path: '/repos/acme/widgets/**' }];
  const hostile = [
    '/repos/acme/widgets/../other', '/repos/acme/widgets/../../../user', '/repos/acme/widgets/./pulls', '/repos/acme/widgets/%2e%2e/other',
    '/repos/acme/widgets/%2E%2E/other', '/repos/acme/widgets/.%2e/other', '/repos/acme/widgets/a%2f..%2f..%2fother', '/repos/acme/widgets/a%5c..%5cb',
    '/repos/acme/widgets//pulls', '/repos/acme/widgets/pulls/', '//repos/acme/widgets', '/repos/acme/widgets/a\\..\\b', '/repos/acme/widgets/a%00b',
    '/repos/acme/widgets/a%0ab', '/repos/acme/widgets/a%zzb', '/repos/acme/widgets/a%', '/repos/acme/widgets/a b', '/repos/acme/widgets/a#b',
    '/repos/acme/widgets/pulls?x=1#/../../user', '/repos/acme/widgets/café', '/repos/acme/widgets/a\nb', '/repos/acme/widgets/%ff',
  ];
  for (const path of hostile) assert.equal(verdict(rules, get(path)), 'deny', JSON.stringify(path));
  assert.equal(verdict(rules, get('/repos/acme/widgets/contents/docs/read%20me.md')), 'allow', 'a harmless escape is read as the forge reads it');
  assert.equal(verdict([{ host: 'api.github.com', method: 'GET', path: '/repos/acme/widgets/pulls/578' }], get('/repos/acme/widgets/pulls/%35%37%38')), 'allow');
});

check('a pinned query parameter must satisfy its pin when present, and be present when required', () => {
  const search = (query) => [{ host: 'api.github.com', method: 'GET', path: '/search/issues', query }];
  const pinned = search({ q: { contains: 'repo:acme/widgets' } });
  assert.equal(verdict(pinned, get('/search/issues?q=is%3Aopen+repo%3Aacme%2Fwidgets&per_page=5')), 'allow');
  assert.equal(verdict(pinned, get('/search/issues?q=is:open%20repo:acme/widgets')), 'allow');
  assert.equal(verdict(pinned, get('/search/issues?q=repo%3Aacme%2Fother')), 'deny');
  assert.equal(verdict(pinned, get('/search/issues?per_page=5')), 'allow', 'absent and not required');
  assert.equal(verdict(pinned, get('/search/issues')), 'allow');
  assert.equal(verdict(pinned, get('/search/issues?q=repo:acme/widgets&q=repo:acme/other')), 'deny', 'given twice: which one would the forge take?');
  assert.equal(verdict(pinned, get('/search/issues?q=repo:acme/widgets&%71=x')), 'deny', 'given twice, once behind an escape');
  assert.equal(verdict(pinned, get('/search/issues?q=%zz')), 'deny');
  const required = search({ q: { contains: 'repo:acme/widgets', required: true } });
  assert.equal(verdict(required, get('/search/issues?per_page=5')), 'deny');
  assert.equal(verdict(required, get('/search/issues?q=repo:acme/widgets')), 'allow');
  const exact = search({ state: { equals: 'open' }, sort: { in: ['created', 'updated'] } });
  assert.equal(verdict(exact, get('/search/issues?state=open&sort=updated')), 'allow');
  assert.equal(verdict(exact, get('/search/issues?state=closed&sort=updated')), 'deny');
  assert.equal(verdict(exact, get('/search/issues?state=open&sort=comments')), 'deny');
  assert.equal(verdict(exact, get('/search/issues?state=open')), 'allow');
  assert.equal(verdict(search({ q: { required: true } }), get('/search/issues?q')), 'allow', 'present, with an empty value');
});

check('a pinned JSON field must satisfy its pin when present, and be present when required', () => {
  const rules = [{ ...REVIEWS, json: { event: { in: ['COMMENT'] } } }];
  assert.equal(verdict(rules, req()), 'allow');
  assert.equal(verdict(rules, req({ body: body({ event: 'APPROVE', body: 'ship it' }) })), 'deny');
  assert.equal(verdict(rules, req({ body: body({ body: 'no event' }) })), 'allow', 'absent and not required');
  assert.equal(verdict(rules, req({ body: body({ event: ['COMMENT'] }) })), 'deny');
  assert.equal(verdict(rules, req({ body: body({ event: null }) })), 'deny', 'present, as null');
  assert.equal(verdict(rules, req({ body: body({ nested: { event: 'APPROVE' }, event: 'COMMENT' }) })), 'allow', 'only the top level is pinned');
  const required = [{ ...REVIEWS, json: { event: { in: ['COMMENT'], required: true } } }];
  assert.equal(verdict(required, req({ body: body({ body: 'no event' }) })), 'deny');
  assert.equal(verdict(required, req()), 'allow');
  const typed = [{ ...REVIEWS, json: { draft: { equals: true }, line: { equals: 7 }, side: { contains: 'RIGHT' } } }];
  assert.equal(verdict(typed, req({ body: body({ draft: true, line: 7, side: 'RIGHT' }) })), 'allow');
  for (const wrong of [{ draft: 'true' }, { draft: 1 }, { line: '7' }, { line: 7.5 }, { side: 7 }, { side: 'LEFT' }]) {
    assert.equal(verdict(typed, req({ body: body(wrong) })), 'deny', JSON.stringify(wrong));
  }
});

check('a body a forge could read as another one matches no rule that pins it', () => {
  const rules = [{ ...REVIEWS, json: { event: { in: ['COMMENT'] } } }];
  const twice = [
    '{"event":"COMMENT","event":"APPROVE"}', '{"event":"APPROVE","event":"COMMENT"}', '{"event":"COMMENT","\\u0065vent":"APPROVE"}',
    '{"event":"COMMENT", "body":"x", "event" : "APPROVE"}', '{"event":"COMMENT","event":"COMMENT"}',
  ];
  for (const text of twice) assert.equal(verdict(rules, req({ body: body(text) })), 'deny', text);
  assert.equal(verdict(rules, req({ body: body('{"body":"\\"event\\":\\"APPROVE\\"","event":"COMMENT","n":{"event":"APPROVE"},"l":["event",{"event":1}]}') })), 'allow', 'a name inside a string or a nested value is not a member');
  assert.equal(verdict(rules, req({ body: body('{"\\u0065vent":"APPROVE"}') })), 'deny', 'an escaped name is that name');
  for (const text of ['[{"event":"COMMENT"}]', '"COMMENT"', 'null', '{"event":"COMMENT"', 'event=COMMENT', '']) {
    assert.equal(verdict(rules, req({ body: body(text) })), 'deny', text);
  }
  assert.equal(verdict(rules, req({ body: b64u(Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d])) })), 'deny', 'not UTF-8');
  for (const type of ['application/x-www-form-urlencoded', 'text/plain', 'application/jsonp', undefined]) {
    const headers = type ? { 'content-type': type } : {};
    assert.equal(verdict(rules, req({ headers })), 'deny', String(type));
  }
  assert.equal(verdict(rules, req({ headers: { 'content-type': 'application/json; charset=utf-8' } })), 'allow');
  assert.equal(verdict([REVIEWS], req({ headers: {}, body: body('anything at all') })), 'allow', 'a rule that pins no field reads no body');
});

check('a rule that confines a GraphQL document or a push needs its deep check and never allows by itself', () => {
  const graphql = { host: 'api.github.com', method: 'POST', path: '/graphql', graphql: { roots: ['repository'], mutations: [] } };
  const push = { host: 'github.com', method: 'POST', path: '/acme/widgets.git/git-receive-pack', git: 'receive-pack', refs: ['refs/heads/fix-*'] };
  assert.ok(validRule(graphql) && validRule(push));
  const query = req({ path: '/graphql', body: body({ query: '{ viewer { login } }' }) });
  assert.deepEqual(matchRules([graphql, push], query), { verdict: 'deep', rules: [graphql] });
  assert.deepEqual(matchRules([push], req({ host: 'github.com', path: '/acme/widgets.git/git-receive-pack', body: '' })), { verdict: 'deep', rules: [push] });
  assert.equal(verdict([graphql], req({ path: '/graphql', method: 'GET' })), 'deny', 'still only its own host, method and path');
  const plain = { host: 'api.github.com', method: 'POST', path: '/graphql' };
  assert.deepEqual(matchRules([graphql, plain], query), { verdict: 'allow', rule: plain }, 'a plain rule that covers it allows it');
  const secret = Buffer.alloc(32, 9);
  const cap = capability({ rules: [graphql] });
  const fields = { taskId: TASK, keyId: cap.keyId, seq: 0, request: query };
  const result = checkAct({ ...fields, mac: actMac(secret, fields) }, { capability: cap, secret, seqs: new SeqTracker(), from: executor.pk, now: T0 });
  assert.deepEqual(result, { ok: true, verdict: 'deep', rules: [graphql] });
});

check('a malformed rule covers nothing, and a malformed request is covered by nothing', () => {
  const badRules = [
    null, 'all', {}, { host: 'api.github.com', method: 'POST' }, { ...REVIEWS, extra: 1 }, { ...REVIEWS, host: 'API.github.com' }, { ...REVIEWS, host: '*' },
    { ...REVIEWS, method: 'post' }, { ...REVIEWS, method: '*' }, { ...REVIEWS, path: 'repos' }, { ...REVIEWS, path: '/repos//pulls' }, { ...REVIEWS, path: '/repos/../x' },
    { ...REVIEWS, path: '/a/' }, { ...REVIEWS, query: [] }, { ...REVIEWS, query: { q: 'x' } }, { ...REVIEWS, query: { q: { matches: '.*' } } },
    { ...REVIEWS, json: { event: { in: 'COMMENT' } } }, { ...REVIEWS, json: { event: { in: [{}] } } }, { ...REVIEWS, json: { event: { required: 'yes' } } },
    { ...REVIEWS, json: { event: { equals: 1.5 } } }, { ...REVIEWS, graphql: { depth: 1.5 } },
  ];
  for (const rule of badRules) {
    assert.equal(validRule(rule), false, JSON.stringify(rule));
    assert.equal(verdict([rule], req()), 'deny', JSON.stringify(rule));
  }
  assert.equal(verdict([null, REVIEWS], req()), 'allow', 'the rest of the list still counts');
  assert.equal(verdict('all', req()), 'deny');
  const all = [{ host: 'api.github.com', method: 'POST', path: '/**' }];
  const badRequests = [
    null, 'GET /', {}, { ...req(), extra: 1 }, (({ headers: _, ...rest }) => rest)(req()), (({ body: _, ...rest }) => rest)(req()),
    req({ host: 'API.GITHUB.COM' }), req({ host: 'api.github.com:8443' }), req({ host: 'evil.example/api.github.com' }), req({ host: '' }),
    req({ method: 'post' }), req({ method: 'POST /x' }), req({ path: 'repos' }), req({ path: '' }), req({ path: `/${'a'.repeat(9000)}` }),
    req({ headers: [] }), req({ headers: { 'Content-Type': 'application/json' } }), req({ headers: { 'x-a': 'b\r\nhost: evil.example' } }),
    req({ headers: { 'x-a': 5 } }), req({ headers: { 'x a': 'b' } }), req({ body: 'not base64url!' }), req({ body: 5 }), req({ body: 'ab==' }),
  ];
  for (const request of badRequests) {
    assert.equal(validForgeRequest(request), false, JSON.stringify(request)?.slice(0, 80));
    assert.equal(verdict(all, request), 'deny', JSON.stringify(request)?.slice(0, 80));
  }
  assert.ok(validForgeRequest(req()) && validForgeRequest(get('/user')));
});
