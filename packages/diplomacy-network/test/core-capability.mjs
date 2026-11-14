// Acting as the requester: the capability, and the MAC and sequence number on each
// request made under it.
// Run: node test/core-capability.mjs

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { b64u, canon } from '../src/core/canon.js';
import {
  SeqTracker, actMac, buildCapability, capabilityExp, checkAct, checkDone, macOf, validForgeRequest, verifyCapability, wireOutcome,
} from '../src/core/capability.js';
import { sign } from '../src/core/identity.js';
import { endClaim } from '../src/core/lease.js';
import { POOL, T0, claimNow, club, ident, offer } from './lib/core-fixtures.mjs';

function check(name, fn) {
  fn();
  console.log(`PASS ${name}`);
}

const TASK = `${POOL}#review:pr-578@octocat`;
const [host, executor, other] = [ident(1), ident(2), ident(3)];
const REVIEWS = { host: 'api.github.com', method: 'POST', path: '/repos/acme/widgets/pulls/578/reviews' };
const body = (value) => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64');
const req = (over = {}) => ({
  host: 'api.github.com', method: 'POST', path: '/repos/acme/widgets/pulls/578/reviews',
  headers: { 'content-type': 'application/json', accept: 'application/vnd.github+json' }, body: body({ event: 'COMMENT', body: 'looks fine' }), ...over,
});
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

check('an act request is performed only for the capability\'s executor, in time, with a new seq and a matching MAC', () => {
  const secret = Buffer.alloc(32, 9);
  const cap = capability();
  const act = (over = {}) => {
    const fields = { taskId: TASK, keyId: cap.keyId, seq: 1, request: req(), ...over };
    return { ...fields, mac: over.mac ?? actMac(secret, fields) };
  };
  const world = () => ({ capability: cap, secret, seqs: new SeqTracker(), from: executor.pk, now: T0 });
  assert.deepEqual(checkAct(act(), world()), { ok: true });
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
});

check('an outcome is reported by the executor of the claim the offering host holds, and by nobody else', () => {
  const hosts = club(3);
  hosts.forEach((h) => h.pool.merge(offer(hosts[0].id), T0));
  const claim = claimNow(hosts, 1, TASK, T0);
  const [requester, runner, third] = hosts.map((h) => h.id.pk);
  const outcome = wireOutcome({ ok: true, summary: 'reviewed', usd: 0.4215, tokens: 91234.2, runner: 'claude', model: 'opus' });
  assert.deepEqual(outcome, { ok: true, summary: 'reviewed', microUsd: 421500, tokens: 91234, runner: 'claude', model: 'opus' });
  assert.doesNotThrow(() => canon(outcome));
  assert.deepEqual(wireOutcome({ summary: 'x'.repeat(5000), usd: NaN, tokens: -4, model: null }), {
    ok: false, summary: 'x'.repeat(4000), microUsd: 0, tokens: 0, runner: '', model: '',
  });
  const done = { taskId: TASK, round: claim.round, outcome };
  const lapse = claim.leaseUntil + 600;
  const verdict = (body_, over = {}) => {
    const result = checkDone(body_, { claim, from: runner, now: T0 + 5, ...over });
    return result.ok ? 'ok' : `${result.code}: ${result.detail}`;
  };
  assert.equal(verdict(done), 'ok');
  assert.equal(verdict(done, { now: lapse - 1 }), 'ok');
  assert.equal(verdict(done, { now: lapse }), 'denied: not the executor of this task', 'a claim that lapsed');
  assert.equal(verdict(done, { from: third }), 'denied: not the executor of this task', 'another member, though it knows the round');
  assert.equal(verdict(done, { from: requester }), 'denied: not the executor of this task');
  assert.equal(verdict(done, { claim: null }), 'denied: not the executor of this task');
  assert.equal(verdict({ ...done, round: b64u(Buffer.alloc(8, 3)) }), 'denied: not the executor of this task', 'an earlier round of the same executor');
  assert.equal(verdict({ ...done, taskId: `${POOL}#review:pr-579@octocat` }), 'denied: not the executor of this task');
  for (const state of ['completed', 'released']) {
    const ended = endClaim(hosts[1].id, claim, state, T0 + 50);
    assert.equal(verdict(done, { claim: ended, now: lapse + 9000 }), 'ok', `after the executor ${state} it`);
    assert.equal(verdict(done, { claim: ended, from: third }), 'denied: not the executor of this task');
  }
  for (const bad of [null, {}, { ...done, keyId: 'x' }, { ...done, round: 'short' }, { ...done, outcome: { ...outcome, usd: 0.5 } },
    { ...done, outcome: { ...outcome, microUsd: 1.5 } }, { ...done, outcome: { ...outcome, ok: 'yes' } },
    { ...done, outcome: { ...outcome, summary: 'x'.repeat(4001) } }, { ...done, outcome: (({ model: _, ...rest }) => rest)(outcome) }]) {
    assert.equal(verdict(bad), 'bad-request: not a done body');
  }
});

check('a forge request is a host, a method, a path, lowercase headers and a padded base64 body, and nothing else', () => {
  assert.equal(validForgeRequest(req()), true);
  assert.equal(validForgeRequest(req({ body: '' })), true);
  for (const bad of [null, { ...req(), extra: 1 }, req({ host: 'API.github.com' }), req({ method: 'post' }), req({ path: 'repos/acme' }),
    req({ path: '/repos/acme#frag' }), req({ path: '/repos/ac me' }), req({ headers: { 'Content-Type': 'x' } }), req({ headers: { accept: 'a\nb' } }),
    req({ body: 'e30' }), req({ body: 'e30-' }), req({ body: 7 }), (({ body: _, ...rest }) => rest)(req())]) {
    assert.equal(validForgeRequest(bad), false, JSON.stringify(bad));
  }
});

check('a capability carries rules it does not read: each names a host, a method and a path and has a canonical form', () => {
  const now = T0;
  const expect = { taskId: TASK, executor: executor.pk, host: host.pk };
  const rich = { ...REVIEWS, fold: [1, 2], body: { event: { oneOf: ['COMMENT'] } }, pull: { state: 'open' } };
  assert.deepEqual(verifyCapability(capability({ rules: [rich] }), expect, now), { ok: true });
  const resign = (rules) => {
    const cap = { ...capability(), rules };
    delete cap.sig;
    return { ...cap, sig: sign(host, 'dn1/cap', cap) };
  };
  for (const rules of [[{ host: 'api.github.com', method: 'GET' }], [{ ...REVIEWS, path: 7 }], ['x'], [[]],
    Array.from({ length: 129 }, () => REVIEWS), 'rules']) {
    assert.deepEqual(verifyCapability(resign(rules), expect, now), { ok: false, code: 'bad-capability' }, JSON.stringify(rules).slice(0, 80));
  }
});
