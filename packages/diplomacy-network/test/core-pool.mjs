// Records, membership and the pool: what is taken in, what is refused and why, and that
// two hosts holding the same records agree on the hash, the members and every task
// whatever order the records arrived in.
// Run: node test/core-pool.mjs

import assert from 'node:assert/strict';
import { b64u, canon, hash } from '../src/core/canon.js';
import { buildClaim, buildGrant } from '../src/core/claims.js';
import { buildPing, endClaim, extendClaim } from '../src/core/lease.js';
import { sign } from '../src/core/identity.js';
import { createInvite, createVoucher, inviteToken, parseInvite, seating, verifyInvite, verifyVoucher } from '../src/core/membership.js';
import { INDEX_PAGE_BYTES, MAX_HELLO_CHAIN, MAX_PULL_KEYS, MAX_PUSH_RECORDS, Pool } from '../src/core/pool.js';
import {
  LIMITS, backers, backing, buildTaskId, checkShape, checkSignature, compareVersions, parseKey, parseTaskId, recordDigest, recordKey, signRecord, validPool,
} from '../src/core/records.js';
import { POOL, T0, claimNow, club, family, ident, invite, member, offer, prng, roundId, seat } from './lib/core-fixtures.mjs';

function check(name, fn) {
  fn();
  console.log(`PASS ${name}`);
}

const DAY = 24 * 3600;
const MONTH = 30 * DAY;
const [root, ann, ben, cat, eve] = [0, 1, 2, 3, 9].map(ident);
const TASK = `${POOL}#review:pr-578@octocat`;
const resign = (id, record, over) => {
  const { sig: _, ...fields } = { ...record, ...over };
  return { ...fields, sig: sign(id, 'dn1/rec', fields) };
};
const poolOf = (id, records = [], now = T0) => {
  const pool = new Pool({ id: POOL, self: id.pk });
  pool.merge(records, now);
  return pool;
};
const codes = (result) => result.refused.map((r) => r.code);
const pk = (id) => id.pk;
const sum = (list) => list.reduce((total, n) => total + n, 0);

check('a pool id is a lowercase forge slug of a host and at least two more segments', () => {
  for (const good of ['github.com/owner/repo', 'gitlab.com/group/sub/repo', 'git.example.org/a_b/c.d-e']) assert.ok(validPool(good), good);
  for (const bad of ['github.com/owner', 'GitHub.com/owner/repo', 'github.com/Owner/repo', 'github.com//repo', 'github.com/owner/repo/',
    'github.com/../repo', 'github.com/owner/..', 'github.com/owner/repo#x', '/owner/repo', 'github.com/owner/re po', `github.com/o/${'r'.repeat(200)}`, 5, null]) {
    assert.equal(validPool(bad), false, String(bad));
  }
});

check('a task id is the pool, the kind, the item and the login, and parses back into them', () => {
  const parts = { pool: 'gitlab.com/group/sub/repo', kind: 'fix-issue', item: 'issue-12', identity: 'octo.cat_1' };
  const id = buildTaskId(parts);
  assert.equal(id, 'gitlab.com/group/sub/repo#fix-issue:issue-12@octo.cat_1');
  assert.deepEqual(parseTaskId(id), parts);
  for (const bad of [{ kind: 'Review' }, { kind: '' }, { item: 'a@b' }, { item: 'a:b' }, { identity: 'Octocat' }, { identity: 'a#b' }, { pool: 'x' }]) {
    assert.equal(buildTaskId({ ...parts, ...bad }), null, JSON.stringify(bad));
  }
  for (const bad of ['', 'x', `${POOL}#review:pr-578`, `${POOL}#review:pr-578@`, `${POOL}#review:pr@578@octocat`, `${POOL}#:pr-578@octocat`,
    `${POOL}#review:pr-578@octocat `, `x#review:pr-578@octocat`, 5, null, `${POOL}#review:pr-578@${'o'.repeat(400)}`]) {
    assert.equal(parseTaskId(bad), null, String(bad));
  }
});

check('each record is stored under the key the protocol names', () => {
  assert.equal(recordKey(member(ann)), `member/${ann.pk}`);
  assert.equal(recordKey(offer(ann)), `offer/${TASK}/${ann.pk}`);
  assert.deepEqual(parseKey(`member/${ann.pk}`, POOL), { type: 'member', pk: ann.pk });
  assert.deepEqual(parseKey(`offer/${TASK}/${ann.pk}`, POOL), { type: 'offer', taskId: TASK, host: ann.pk });
  assert.deepEqual(parseKey(`claim/${TASK}/${ann.pk}`, POOL), { type: 'claim', taskId: TASK, executor: ann.pk });
  for (const bad of ['member/nope', `offer/${TASK}`, `offer/${TASK}/nope`, `claim/${TASK}`, `claim/${TASK}/nope`, `claim/${TASK}x y/${ann.pk}`,
    `claim/github.com/acme/other#review:pr-1@o/${ann.pk}`,
    `grant/${TASK}`, '', 'member', 5, null]) {
    assert.equal(parseKey(bad, POOL), null, String(bad));
  }
});

check('a record with a missing, unknown or malformed member is refused', () => {
  const samples = { member: member(ann, { voucher: seat(root) }), offer: offer(ann) };
  for (const [type, good] of Object.entries(samples)) {
    assert.deepEqual(checkShape(good, POOL), { ok: true, key: recordKey(good) });
    for (const k of Object.keys(good)) {
      if (k === 'voucher') continue;
      const { [k]: _, ...rest } = good;
      assert.deepEqual(checkShape(rest, POOL), { ok: false, code: 'bad-record' }, `${type} without ${k}`);
    }
    assert.equal(checkShape({ ...good, extra: 1 }, POOL).code, 'bad-record');
    assert.equal(checkShape({ ...good, seq: 1.5 }, POOL).code, 'bad-record');
    assert.equal(checkShape({ ...good, seq: -1 }, POOL).code, 'bad-record');
    assert.equal(checkShape({ ...good, seq: '0' }, POOL).code, 'bad-record');
    assert.equal(checkShape({ ...good, at: 2 ** 41 }, POOL).code, 'bad-record');
    assert.equal(checkShape({ ...good, sig: good.sig.slice(2) }, POOL).code, 'bad-record');
    for (const type of ['grant', 'constructor', 5, ['member'], { toString: 1 }]) assert.equal(checkShape({ ...good, type }, POOL).code, 'bad-record');
    assert.equal(checkShape(good, 'github.com/acme/other').code, 'wrong-pool');
  }
  for (const bad of [null, 5, 'member', [], [samples.member]]) assert.equal(checkShape(bad, POOL).code, 'bad-record');
  const m = samples.member;
  for (const over of [{ pk: m.pk.slice(1) }, { pk: `${m.pk}AAAA` }, { maxAcceptedH: 11 }, { maxAcceptedH: 721 }, { maxAcceptedH: 12.5 },
    { left: 0 }, { joinedAt: T0 }, { era: -1 }, { voucher: { ...m.voucher, era: '0' } }, { voucher: {} }, { voucher: { invite: 'x' } }, { voucher: { ...m.voucher, more: 1 } }, { voucher: { ...m.voucher, seat: 15 } },
    { voucher: { ...m.voucher, seat: -1 } }, { voucher: { ...m.voucher, seat: 0.5 } }, { voucher: { ...m.voucher, by: 'nope' } }, { voucher: { ...m.voucher, pk: 5 } },
    { voucher: { ...m.voucher, at: 2 ** 41 } }, { voucher: { ...m.voucher, pool: 'x' } }, { voucher: { ...m.voucher, sig: 'AAAA' } }, { voucher: 'AAAA' }]) {
    assert.equal(checkShape({ ...m, ...over }, POOL).code, 'bad-record', JSON.stringify(over));
  }
  const o = samples.offer;
  for (const over of [{ taskId: `${POOL}#review:pr-579@octocat` }, { item: 'pr-579' }, { kind: 'fix' }, { identity: 'hubot' }, { host: 'nope' },
    { title: 'x'.repeat(301) }, { title: 'bell\u0007' }, { title: '\ud800' }, { title: 5 }, { minRequiredH: 11 }, { state: 'closed' },
    { attempt: 0 }, { attempt: 256 }, { createdAt: T0 + 1 }]) {
    assert.equal(checkShape({ ...o, ...over }, POOL).code, 'bad-record', JSON.stringify(over));
  }
});

check('a record is signed by its own subject, over every member', () => {
  const m = member(ann);
  assert.ok(checkSignature(m));
  assert.equal(checkSignature({ ...m, seq: 1 }), false);
  assert.equal(checkSignature(resign(ben, m, {})), false);
  assert.ok(checkSignature(offer(ann)));
  assert.equal(checkSignature(resign(ben, offer(ann), {})), false, 'an offer signed by another host');
  assert.throws(() => signRecord(ben, { ...m, sig: undefined }), TypeError);
  assert.throws(() => member(ann, { maxAcceptedH: 5 }), TypeError);
  assert.throws(() => offer(ann, { kind: 'Not A Kind' }), TypeError);
  assert.throws(() => signRecord(ann, { type: 'nope' }), TypeError);
});

check('the higher seq wins, and for one seq the lower hash, whichever comes first', () => {
  const v0 = member(ann, { voucher: seat(root) });
  const v1 = member(ann, { voucher: seat(root), seq: 1, at: T0 + 5 });
  const twin = member(ann, { voucher: seat(root), seq: 1, at: T0 + 6 });
  const [low, high] = [v1, twin].sort((a, b) => Buffer.compare(hash(a), hash(b)));
  assert.ok(compareVersions([1], recordDigest(low), [1], recordDigest(high)) < 0);
  assert.ok(compareVersions([0], recordDigest(low), [1], recordDigest(high)) > 0);
  assert.ok(compareVersions([2], recordDigest(high), [1], recordDigest(low)) < 0);
  assert.equal(compareVersions([1], recordDigest(low), [1], recordDigest(low)), 0);
  for (const order of [[v0, low, high], [high, low, v0], [low, v0, high], [high, v0, low]]) {
    const pool = poolOf(root, [member(root)]);
    for (const record of order) pool.merge(record, T0 + 10);
    assert.equal(pool.get(`member/${ann.pk}`), low, 'the lower hash of the higher seq is held');
  }
  const pool = poolOf(root, [member(root), low]);
  assert.deepEqual(codes(pool.merge([v0, high], T0 + 10)), ['older', 'older']);
  assert.deepEqual(pool.merge(low, T0 + 10), { accepted: [`member/${ann.pk}`], refused: [], fresh: [] });
});

check('an invite token is the canonical form of a signed invite and nothing looser', () => {
  const made = createInvite(root, { pool: POOL, exp: T0 + DAY, nonce: Buffer.alloc(16, 1) });
  const token = inviteToken(made);
  assert.deepEqual(parseInvite(token), made);
  assert.deepEqual(verifyInvite(made, { pool: POOL, now: T0 }), { ok: true });
  assert.deepEqual(verifyInvite(made, { pool: POOL, now: T0 + DAY - 1 }), { ok: true });
  assert.deepEqual(verifyInvite(made, { pool: POOL, now: T0 + DAY }), { ok: false, code: 'expired' });
  assert.deepEqual(verifyInvite(made, { pool: POOL }), { ok: true });
  assert.deepEqual(verifyInvite(made, { pool: 'github.com/acme/other', now: T0 }), { ok: false, code: 'wrong-pool' });
  assert.deepEqual(verifyInvite({ ...made, exp: T0 + 2 * DAY }, { pool: POOL, now: T0 }), { ok: false, code: 'bad-invite' });
  assert.deepEqual(verifyInvite({ ...made, by: ann.pk }, { pool: POOL, now: T0 }), { ok: false, code: 'bad-invite' });
  assert.deepEqual(verifyInvite({ ...made, extra: 1 }, { pool: POOL, now: T0 }), { ok: false, code: 'bad-invite' });
  const text = canon(made).toString();
  const loose = [
    b64u(Buffer.from(` ${text}`)), b64u(Buffer.from(text.replace('{', '{"pool":"x",'))), b64u(Buffer.from(text.replace(/}$/, ',"extra":1}'))),
    b64u(Buffer.from(JSON.stringify(Object.fromEntries(Object.entries(made).reverse())))), b64u(Buffer.from('not json')), b64u(Buffer.from('null')),
    `${token}=`, `${token} `, 'x'.repeat(2000), 5, null,
  ];
  for (const [i, bad] of loose.entries()) assert.equal(parseInvite(bad), null, `case ${i}`);
});

check('a voucher holds only for the pool and the key it names, from another key, dated no later than the record', () => {
  assert.ok(verifyVoucher(member(root)), 'the first of a pool has none');
  assert.ok(verifyVoucher(member(ann, { voucher: seat(root) })), 'given in the second the record was signed');
  assert.equal(verifyVoucher(member(ann, { voucher: seat(root, { at: T0 + 1 }) })), false, 'given after the record was signed');
  assert.equal(verifyVoucher(member(ann, { voucher: seat(ann) })), false, 'vouched for by itself');
  assert.equal(verifyVoucher(member(ann, { voucher: seat(root, { pool: 'github.com/acme/other' }) })), false);
  const forBen = member(ben, { voucher: seat(root) }).voucher;
  assert.equal(verifyVoucher(member(ann, { voucher: forBen })), false, 'signed for another key');
  const forged = { ...createVoucher(eve, { pool: POOL, era: 0, pk: ann.pk, seat: 0, at: T0 }), by: root.pk };
  assert.equal(verifyVoucher(member(ann, { voucher: forged })), false);
  const pool = poolOf(root, [member(root)]);
  const bad = [member(ann, { voucher: forged }), member(ann, { voucher: forBen }), member(ben, { voucher: seat(ben) }), member(cat, { voucher: seat(root, { at: T0 + 1 }) })];
  assert.deepEqual(codes(pool.merge(bad, T0)), ['bad-voucher', 'bad-voucher', 'bad-voucher', 'bad-voucher']);
});

check('a host accepts the keys seated under the member its own vouchers lead up to, two vouchers deep', () => {
  const records = [member(root), member(ann, { voucher: seat(root) }), member(ben, { voucher: seat(ann) }), member(cat, { voucher: seat(ben) })];
  const island = [member(eve), member(ident(10), { voucher: seat(eve) })];
  const all = new Map([[root.pk, 0], [ann.pk, 1], [ben.pk, 2]]);
  for (const self of [root, ann, ben]) assert.deepEqual(seating(self.pk, [...records, ...island]), all);
  assert.deepEqual(seating(cat.pk, [...records, ...island]), new Map([[cat.pk, 0]]), 'one three vouchers deep has no seat, and is alone where it looks');
  assert.deepEqual(seating(eve.pk, [...records, ...island]), new Map([[eve.pk, 0], [ident(10).pk, 1]]));
  assert.deepEqual(seating(ben.pk, [records[2]]), new Map([[ben.pk, 0]]), 'before it holds its inviter\'s record');
  assert.deepEqual(seating(root.pk, [records[0], records[2]]), new Map([[root.pk, 0]]), 'a link is missing');
  assert.deepEqual(seating(root.pk, []), new Map([[root.pk, 0]]));
  // A voucher is good for the membership of its signer it was signed in: one that began
  // again seats none of those it let in before, and those it lets in now it seats.
  const again = [member(root, { seq: 5, era: 5 }), records[1], records[2], member(cat, { voucher: seat(root, { n: 1, era: 5 }) })];
  assert.deepEqual(seating(root.pk, again), new Map([[root.pk, 0], [cat.pk, 1]]));
  assert.deepEqual(seating(ann.pk, again), new Map([[ann.pk, 0], [ben.pk, 1]]));
  assert.deepEqual(seating(ben.pk, [...again.slice(0, 3), member(ann, { voucher: seat(root), seq: 7, era: 7 })]), new Map([[ben.pk, 0]]));
  // Two keys that vouch for each other are a pool of their own, each seated once.
  const loop = [member(ann, { voucher: seat(ben) }), member(ben, { voucher: seat(ann) })];
  const [low, high] = [ann.pk, ben.pk].sort();
  for (const self of [ann, ben]) assert.deepEqual(seating(self.pk, loop), new Map([[high, 0], [low, 1]]), 'vouchers of one second: the higher key is the first member');
  assert.deepEqual(seating(root.pk, [member(root), ...loop]), new Map([[root.pk, 0]]));
});

check('a chain of vouchers that closes on itself ends at the record in it with the latest voucher, for every host that holds it', () => {
  // root seated ann and cat, ann seated ben - and root signed a record under a voucher of ann's.
  const rest = [member(ben, { voucher: seat(ann, { n: 1 }) }), member(cat, { voucher: seat(root, { n: 1 }) })];
  const closed = (rootAt, annAt) => [member(root, { seq: 1, at: T0 + 9, voucher: seat(ann, { at: rootAt }) }), member(ann, { at: T0 + 9, voucher: seat(root, { at: annAt }) }), ...rest];
  const under = (top, next, ...last) => new Map([[top.pk, 0], [next.pk, 1], ...last.map((id) => [id.pk, 2])]);
  for (const self of [root, ann, ben, cat]) {
    // The voucher root holds is the later: it counts for nothing, and root is the first member.
    assert.deepEqual(seating(self.pk, closed(T0 + 5, T0)), new Map([[root.pk, 0], [ann.pk, 1], [cat.pk, 1], [ben.pk, 2]]), 'the pool as it was');
  }
  for (const self of [root, ann, ben]) assert.deepEqual(seating(self.pk, closed(T0, T0 + 5)), new Map([[ann.pk, 0], [root.pk, 1], [ben.pk, 1], [cat.pk, 2]]));
  // Three keys in a ring, and one seated by a key of the ring: whichever of them looks.
  const ring = [member(root, { voucher: seat(ben, { at: T0 + 1 }) }), member(ann, { voucher: seat(root, { at: T0 + 3 }) }), member(ben, { voucher: seat(ann, { at: T0 + 2 }) }), member(cat, { voucher: seat(ben, { n: 1, at: T0 + 7 }) })];
  for (const self of [root, ann, ben]) assert.deepEqual(seating(self.pk, ring), under(ann, ben, root, cat));
  assert.deepEqual(seating(cat.pk, ring), under(ann, ben, root, cat));
  for (const self of [root, ann, ben, cat]) assert.deepEqual(seating(self.pk, [...ring].reverse()), under(ann, ben, root, cat), 'in whatever order the records are held');
});

check('the members a host ends with do not depend on the order their records arrive in', () => {
  const chain = [member(root), member(ann, { voucher: seat(root) }), member(ben, { voucher: seat(ann) }), member(cat, { voucher: seat(root, { n: 1 }) })];
  const rng = prng(7);
  const expected = [root.pk, ann.pk, ben.pk, cat.pk].sort();
  let hashes = new Set();
  for (let i = 0; i < 30; i++) {
    const pool = poolOf(root, [chain[0]]);
    // One at a time a record may be refused for want of its inviter, so keep offering
    // them, as a sync would, until nothing more gets in.
    for (let pass = 0; pass < 4; pass++) for (const record of rng.shuffle(chain)) pool.merge(record, T0);
    assert.deepEqual(pool.members(T0).map((m) => m.pk), expected);
    hashes.add(pool.stateHash(T0));
    const atOnce = poolOf(root, rng.shuffle(chain));
    assert.deepEqual(atOnce.members(T0).map((m) => m.pk), expected, 'one batch takes them in whatever their order');
    hashes.add(atOnce.stateHash(T0));
  }
  assert.equal(hashes.size, 1);
  hashes = new Set([root, ann, ben, cat].map((self) => poolOf(self, chain).stateHash(T0)));
  assert.equal(hashes.size, 1, 'every member computes the same hash');
});

check('a record signed by nobody the host accepts is refused, and taken once its signer is let in', () => {
  const pool = poolOf(root, [member(root)]);
  const stranger = member(eve);
  const unvouched = member(ben, { voucher: seat(ann) });
  assert.deepEqual(codes(pool.merge([stranger, unvouched, offer(ann)], T0)), ['not-member', 'not-member', 'not-member']);
  assert.equal(pool.records().length, 1);
  assert.equal(pool.accepts(eve.pk, T0), false);
  assert.equal(pool.accepts(ben.pk, T0), false);
  const result = pool.merge([offer(ben), unvouched, offer(ann), member(ann, { voucher: seat(root) })], T0);
  assert.deepEqual(result.refused, []);
  assert.equal(result.accepted.length, 4);
  assert.deepEqual(result.fresh.sort(), result.accepted.sort());
  assert.deepEqual(pool.task(TASK, T0).offeredBy, [ann.pk, ben.pk].sort());
});

check('a host that holds its voucher and not its inviter\'s record is alone until that record comes', () => {
  const joiner = poolOf(ann, [member(ann, { voucher: seat(root) })]);
  assert.equal(joiner.accepts(root.pk, T0), false);
  assert.deepEqual(joiner.members(T0).map(pk), [ann.pk]);
  assert.deepEqual(joiner.merge(member(root), T0).refused, []);
  assert.deepEqual([joiner.depth(root.pk, T0), joiner.depth(ann.pk, T0), joiner.depth(ben.pk, T0)], [0, 1, undefined]);
  assert.ok(joiner.accepts(root.pk, T0));
});

check('a member that left is no member, and its record stays only while someone it vouched for needs it', () => {
  const chain = [member(root), member(ann, { voucher: seat(root) }), member(ben, { voucher: seat(ann) })];
  const pool = poolOf(root, chain);
  const gone = member(ann, { voucher: seat(root), seq: 1, at: T0 + 100, left: true });
  assert.deepEqual(pool.merge(gone, T0 + 100).refused, []);
  assert.equal(pool.accepts(ann.pk, T0 + 100), false);
  assert.equal(pool.member(ann.pk, T0 + 100), null);
  assert.deepEqual(pool.members(T0 + 100).map((m) => m.pk), [root.pk, ben.pk].sort());
  // Two months on, with the root and ben still signing their records.
  const later = T0 + 100 + 2 * MONTH;
  pool.merge([member(root, { seq: 1, at: later }), member(ben, { voucher: seat(ann), seq: 1, at: later })], later);
  assert.ok(pool.get(`member/${ann.pk}`), 'ben is connected to the root only through it');
  assert.ok(pool.accepts(ben.pk, later));
  const benGone = member(ben, { voucher: seat(ann), seq: 2, at: later + 200, left: true });
  pool.merge([benGone, member(root, { seq: 2, at: later + 200 })], later + 200);
  pool.prune(later + 200 + MONTH + 299);
  assert.equal(pool.records().length, 3, 'kept through the retention and the clock tolerance');
  pool.merge(member(root, { seq: 3, at: later + 200 + MONTH }), later + 200 + MONTH + 300);
  assert.deepEqual(pool.records().map(recordKey), [`member/${root.pk}`], 'both dropped once nothing rests on them');
});

check('a member that stops signing its record is no member after a day, and keeps its place for thirty', () => {
  const pool = poolOf(root, [member(root), member(ann, { voucher: seat(root) })]);
  const signed = (seq, at) => member(root, { seq, at });
  assert.deepEqual(pool.members(T0 + DAY - 1).map((m) => m.pk), [root.pk, ann.pk].sort());
  pool.merge([signed(1, T0 + DAY), offer(ann, { at: T0 + DAY, createdAt: T0 + DAY })], T0 + DAY);
  assert.deepEqual(pool.members(T0 + DAY).map((m) => m.pk), [root.pk], 'nobody waits for its consent');
  assert.equal(pool.member(ann.pk, T0 + DAY), null);
  assert.equal(pool.task(TASK, T0 + DAY), null, 'and what it offers counts for nothing');
  assert.ok(pool.accepts(ann.pk, T0 + DAY), 'its key is still one of the pool');
  assert.ok(Object.hasOwn(pool.index(T0 + MONTH - 1), `member/${ann.pk}`), 'and its record is part of the state');
  const back = member(ann, { voucher: seat(root), seq: 1, at: T0 + 9 * DAY });
  pool.merge(signed(2, T0 + 9 * DAY), T0 + 9 * DAY);
  assert.deepEqual(pool.merge(back, T0 + 9 * DAY).refused, [], 'signed again it is a member again, with no new invite');
  assert.deepEqual(pool.members(T0 + 9 * DAY).map((m) => m.pk), [root.pk, ann.pk].sort());
  assert.ok(pool.answerHello({ member: back }, ann.pk, T0 + 9 * DAY).body);
  // Silent for thirty days it is forgotten. Its voucher holds still: a record it signs
  // now is taken, the one it signed then is not.
  const [gone, fresh] = [T0 + 9 * DAY + MONTH, member(ann, { voucher: seat(root), seq: 2, at: T0 + 9 * DAY + MONTH + 400 })];
  pool.merge(signed(3, gone + 300), gone + 300);
  assert.equal(pool.get(`member/${ann.pk}`), null);
  assert.equal(pool.accepts(ann.pk, gone + 300), false);
  assert.deepEqual(codes(pool.merge(back, gone + 400)), ['expired']);
  assert.ok(pool.answerHello({ member: fresh }, ann.pk, gone + 400).body);
});

check('a version that says a member left outlives every version it replaced', () => {
  const pool = poolOf(root, [member(root), member(ann, { voucher: seat(root) })]);
  const resigned = member(ann, { voucher: seat(root), seq: 1, at: T0 + 20 * DAY });
  const left = member(ann, { voucher: seat(root), seq: 2, at: T0 + 20 * DAY + 5, left: true });
  pool.merge([member(root, { seq: 1, at: T0 + 20 * DAY }), resigned, left], T0 + 20 * DAY + 5);
  const dropped = T0 + 20 * DAY + 5 + MONTH + 300;
  for (const now of [T0 + 21 * DAY, dropped - 1, dropped, dropped + DAY]) {
    pool.merge(member(root, { seq: now, at: now }), now);
    assert.deepEqual(codes(pool.merge(resigned, now)), [now < dropped ? 'older' : 'expired'], `the version before it left, pushed again at ${now - T0}`);
    assert.equal(pool.accepts(ann.pk, now), false);
  }
});

check('a record dated past the clock tolerance is refused until its time comes', () => {
  const pool = poolOf(root, [member(root)]);
  const early = member(ann, { voucher: seat(root), at: T0 + 301 });
  assert.deepEqual(codes(pool.merge(early, T0)), ['future']);
  assert.deepEqual(pool.merge(early, T0 + 1).refused, []);
});

check('two hosts with the same records hold the same hash, and a different record changes it', () => {
  const [a, b] = club(2);
  assert.equal(a.pool.stateHash(T0), b.pool.stateHash(T0));
  const first = offer(a.id);
  a.pool.merge(first, T0);
  assert.notEqual(a.pool.stateHash(T0), b.pool.stateHash(T0));
  b.pool.merge(first, T0);
  assert.equal(a.pool.stateHash(T0), b.pool.stateHash(T0));
  const keys = [`member/${a.id.pk}`, `member/${b.id.pk}`, `offer/${TASK}/${a.id.pk}`].sort();
  const direct = b64u(hash(keys.map((key) => [key, b64u(hash(a.pool.get(key)))])));
  assert.equal(a.pool.stateHash(T0), direct, 'H(canon([[key, H(canon(record))], ...] sorted by key))');
  assert.deepEqual(Object.keys(a.pool.index(T0)), keys);
  assert.deepEqual(a.pool.index(T0)[keys[2]], [[0], b64u(hash(first))]);
});

check('every version of an offer is dropped a day after it was signed, for every host at the same instant', () => {
  const [a, b] = club(2);
  const open = offer(a.id);
  const done = offer(a.id, { seq: 1, at: T0 + 50, state: 'done' });
  const other = offer(b.id, { item: 'pr-9', seq: 1, at: T0 + 60, state: 'cancelled' });
  const waiting = offer(b.id, { item: 'pr-7', at: T0 + 70, createdAt: T0 + 70 });
  a.pool.merge([open, done, other, waiting], T0 + 70);
  b.pool.merge([other, waiting, done], T0 + 70);
  for (const asOf of [T0 + 70, T0 + 50 + DAY - 1, T0 + 50 + DAY, T0 + 60 + DAY - 1, T0 + 60 + DAY, T0 + 70 + DAY - 1, T0 + 70 + DAY]) {
    assert.equal(a.pool.stateHash(asOf), b.pool.stateHash(asOf), `asOf ${asOf}`);
  }
  // Both member records were signed at T0: they stay in the state, their hosts are
  // members for a day.
  assert.equal(Object.keys(a.pool.index(T0 + 50 + DAY - 1)).length, 5);
  assert.equal(Object.keys(a.pool.index(T0 + 50 + DAY)).length, 4);
  assert.equal(Object.keys(a.pool.index(T0 + 60 + DAY)).length, 3);
  assert.equal(Object.keys(a.pool.index(T0 + 70 + DAY)).length, 2, 'an open offer nobody signed again goes the same way');
  assert.deepEqual(codes(a.pool.merge(done, T0 + 50 + 2 * DAY)), ['expired']);
  assert.deepEqual(codes(a.pool.merge(waiting, T0 + 70 + DAY + 300)), ['expired']);
});

check('an offer signed again inside its retention stays, and keeps the day it was created', () => {
  const [a, b] = club(2);
  let now = T0;
  let seq = 0;
  a.pool.merge(offer(a.id), now);
  for (let i = 0; i < 12; i++) {
    now += DAY / 4;
    seq += 1;
    const again = [member(a.id, { seq, at: now }), member(b.id, { voucher: seat(a.id, { n: 1 }), seq, at: now }), offer(a.id, { seq, at: now })];
    assert.deepEqual(a.pool.merge(again, now).refused, []);
    const task = a.pool.task(TASK, now);
    assert.deepEqual([task.state, task.createdAt, task.offeredBy], ['available', T0, [a.id.pk]], `after ${i + 1} quarter days`);
  }
  assert.ok(now > T0 + 2 * DAY);
});

check('a finished task does not come back: the version that ended it outlives every version before it', () => {
  const hosts = club(3);
  const [a, b, late] = hosts;
  // The offer is signed again every six hours for two days, then done; one host saw
  // nothing after the first day.
  const versions = Array.from({ length: 9 }, (_, i) => offer(a.id, { seq: i, at: T0 + i * (DAY / 4) }));
  const done = offer(a.id, { seq: 9, at: T0 + 2 * DAY + 50, state: 'done' });
  const stamp = (h, seq, at) => h.pool.merge(hosts.map((x, i) => member(x.id, { ...(i ? { voucher: seat(a.id, { n: i }) } : {}), seq, at })), at);
  for (const [i, version] of versions.entries()) {
    for (const h of i < 5 ? hosts : [a, b]) {
      stamp(h, i + 1, version.at);
      assert.deepEqual(h.pool.merge(version, version.at).refused, []);
    }
  }
  for (const h of [a, b]) assert.deepEqual(h.pool.merge(done, done.at).refused, []);
  const stale = late.pool.get(recordKey(done));
  assert.deepEqual([stale.seq, stale.state], [4, 'open']);
  // Whenever the straggler pushes what it holds, the task stays finished: the done
  // version wins while it is held, and once it is dropped every open version is too old.
  const dropped = done.at + DAY + 300;
  for (const now of [done.at + 1, dropped - 1, dropped, dropped + 1, dropped + 5 * DAY]) {
    stamp(b, now, now);
    for (const version of versions) {
      const [verdict] = codes(b.pool.merge(version, now));
      assert.equal(verdict, now < dropped ? 'older' : 'expired', `seq ${version.seq} pushed ${now - done.at} s after the end`);
    }
    assert.notEqual(b.pool.task(TASK, now)?.state, 'available');
  }
  assert.equal(b.pool.task(TASK, dropped), null, 'forgotten, not reopened');
});

check('an offer is ended by its own host alone: done or cancelled by one of two hosts offering a task, the other\'s offer stands, and so does the claim that holds it', () => {
  for (const state of ['done', 'cancelled']) {
    const hosts = club(3);
    const [a, b, c] = hosts;
    const give = (records, now) => hosts.forEach((h) => h.pool.merge(records, now));
    give([offer(a.id), offer(b.id)], T0);
    const claim = claimNow(hosts, 2, TASK, T0 + 1);
    assert.deepEqual(backers(claim), [a.id.pk, b.id.pk].sort(), 'one claim takes the offer of every host that gave it');
    give(offer(a.id, { seq: 1, at: T0 + 500, state }), T0 + 500);
    const left = c.pool.task(TASK, T0 + 500);
    assert.deepEqual([left.state, left.offeredBy, left.free, left.claim], ['claimed', [b.id.pk], [], claim], state);
    assert.deepEqual(left.offers, [{ host: b.id.pk, hours: 12, createdAt: T0, claim }]);
    assert.equal(c.pool.get(recordKey(claim)), claim);
    // The claim ends: the offer still open is free for the next one.
    give(endClaim(c.id, claim, 'completed', T0 + 600, b64u(Buffer.alloc(32, 7))), T0 + 600);
    const free = c.pool.task(TASK, T0 + 600);
    assert.deepEqual([free.state, free.free, free.claim], ['available', [b.id.pk], null]);
    assert.equal(c.pool.claimSnapshot(TASK, T0 + 600).available, true);
    // The task is done, or cancelled, once no offer of it is open; done when any says so.
    give(offer(b.id, { seq: 1, at: T0 + 700, state: 'cancelled' }), T0 + 700);
    assert.deepEqual([c.pool.task(TASK, T0 + 700).state, c.pool.task(TASK, T0 + 700).offers], [state, []]);
  }
});

check('a claim holds the offer of each host that backs it for that offer\'s hours, and an offer made anew is no claim\'s', () => {
  const hosts = club(3, T0, () => ({ maxAcceptedH: 48 }));
  const [a, b, c] = hosts;
  const give = (records, now) => hosts.forEach((h) => h.pool.merge(records, now));
  give([offer(a.id), offer(b.id, { minRequiredH: 24 })], T0);
  let claim = claimNow(hosts, 2, TASK, T0 + 1);
  assert.deepEqual([claim.hours, backing(claim, a.id.pk).hours, backing(claim, b.id.pk).hours], [24, 12, 24]);
  const held = (now) => Object.fromEntries(a.pool.task(TASK, now).offers.map((o) => [o.host, o.claim?.round ?? null]));
  // Extended by the host that gives it the longer hours, past the hours of the other.
  for (let n = 1; n <= 6; n++) {
    const at = claim.leaseUntil - 60;
    claim = extendClaim(c.id, claim, buildPing(b.id, claim, at), at);
    give(claim, at);
  }
  const end = claim.claimedAt + 12 * 3600 + 600;
  assert.deepEqual(held(end - 1), { [a.id.pk]: claim.round, [b.id.pk]: claim.round });
  assert.deepEqual(held(end), { [a.id.pk]: null, [b.id.pk]: claim.round }, 'the twelve hours of one host are over; the claim goes on for the other');
  assert.deepEqual([a.pool.task(TASK, end).state, a.pool.task(TASK, end).free], ['claimed', [a.id.pk]]);
  // The other host makes its offer anew: what backed the claim was the offer before.
  give(offer(b.id, { seq: 1, at: end, createdAt: end, minRequiredH: 24 }), end);
  assert.deepEqual(held(end), { [a.id.pk]: null, [b.id.pk]: null });
  assert.equal(a.pool.task(TASK, end).state, 'available');
  assert.equal(a.pool.get(recordKey(claim)), claim, 'the claim is held as a record, and holds nothing');
});

check('reconciling two indexes sends each key the one way it is needed', () => {
  const [a, b] = club(2);
  const mine = offer(a.id, { item: 'pr-1' });
  const theirs = offer(b.id, { item: 'pr-2' });
  const old = offer(a.id, { item: 'pr-3' });
  const newer = offer(a.id, { item: 'pr-3', seq: 1, at: T0 + 1, title: 'retitled' });
  const older = offer(b.id, { item: 'pr-4' });
  const newest = offer(b.id, { item: 'pr-4', seq: 2, at: T0 + 2, state: 'cancelled' });
  a.pool.merge([mine, newer, older], T0 + 5);
  b.pool.merge([theirs, old, newest], T0 + 5);
  const { pull, push } = a.pool.reconcile(b.pool.index(T0 + 5), T0 + 5);
  assert.deepEqual(pull.sort(), [recordKey(theirs), recordKey(newest)].sort());
  assert.deepEqual(push.sort(), [recordKey(mine), recordKey(newer)].sort());
  b.pool.merge(a.pool.records(push), T0 + 5);
  a.pool.merge(b.pool.records(pull), T0 + 5);
  assert.equal(a.pool.stateHash(T0 + 5), b.pool.stateHash(T0 + 5));
  assert.deepEqual(a.pool.reconcile(b.pool.index(T0 + 5), T0 + 5), { pull: [], push: [] });
});

check('a malformed index reconciles to nothing', () => {
  const [a] = club(2);
  const key = `member/${a.id.pk}`;
  const good = a.pool.index(T0);
  assert.ok(a.pool.reconcile(good, T0));
  for (const bad of [null, [], 'x', { nope: [[0], good[key][1]] }, { [key]: [0, good[key][1]] }, { [key]: [[0, 1], good[key][1]] },
    { [key]: [[0]] }, { [key]: [[0], 'short'] }, { [key]: [[1.5], good[key][1]] }, { [key]: 'x' },
    { [`claim/${TASK}`]: [[0], good[key][1]] }, { [`claim/${TASK}`]: [[0, a.id.pk, 'AAAAAAAAAAA', -1], good[key][1]] },
    { 'claim/github.com/acme/other#review:pr-1@o': [[0, a.id.pk, 'AAAAAAAAAAA', 0], good[key][1]] }]) {
    assert.equal(a.pool.reconcile(bad, T0), null, JSON.stringify(bad));
  }
});

check('sync answers the hash, and the index only when the hashes differ', () => {
  const [a, b] = club(2);
  a.pool.merge(offer(a.id), T0);
  const same = a.pool.answerSync({ asOf: T0, hash: a.pool.stateHash(T0) }, T0);
  assert.deepEqual(same, { body: { hash: a.pool.stateHash(T0) } });
  const differs = a.pool.answerSync({ asOf: T0, hash: b.pool.stateHash(T0) }, T0);
  assert.deepEqual(differs, { body: { hash: a.pool.stateHash(T0), index: a.pool.index(T0) } });
  assert.deepEqual(a.pool.answerSync({ asOf: T0 + 301, hash: b.pool.stateHash(T0) }, T0), { error: 'stale' });
  assert.deepEqual(a.pool.answerSync({ asOf: T0 - 301, hash: b.pool.stateHash(T0) }, T0), { error: 'stale' });
  assert.ok(a.pool.answerSync({ asOf: T0 + 300, hash: b.pool.stateHash(T0) }, T0).body);
  for (const bad of [null, {}, { asOf: T0 }, { asOf: T0, hash: 'x' }, { asOf: '1', hash: same.body.hash }, { asOf: T0, hash: same.body.hash, more: 1 },
    { asOf: T0, hash: same.body.hash, after: '' }, { asOf: T0, hash: same.body.hash, after: 'member/nobody' }]) {
    assert.deepEqual(a.pool.answerSync(bad, T0), { error: 'bad-request' }, JSON.stringify(bad));
  }
});

check('an index too long for one answer travels a page at a time: each page says whether keys remain past it, and a key is sent to the other side only by the page that would have held it', () => {
  const hosts = club(60);
  const [a, b] = hosts;
  const offers = hosts.slice(1).flatMap((h, i) => Array.from({ length: LIMITS.offers }, (_, j) => offer(h.id, { item: `m${i}-pr-${j}` })));
  a.pool.merge(offers, T0);
  // The other host holds half of it, and two records of its own: one that sorts among
  // the first keys and one that sorts after every other.
  const [early, late] = [offer(a.id, { item: 'a-first' }), offer(a.id, { item: 'zz-last' })];
  b.pool.merge([...offers.slice(0, offers.length / 2), early, late], T0);
  const whole = a.pool.index(T0);
  assert.ok(canon(whole).length > 2 * INDEX_PAGE_BYTES);
  const pages = [];
  for (let after = null; pages.length === 0 || pages.at(-1).more; after = Object.keys(pages.at(-1).index).at(-1)) {
    const answer = a.pool.answerSync({ asOf: T0, hash: b.pool.stateHash(T0), ...(after ? { after } : {}) }, T0);
    assert.equal(answer.body.hash, a.pool.stateHash(T0));
    assert.ok(canon(answer.body.index).length <= INDEX_PAGE_BYTES);
    pages.push(answer.body);
    assert.ok(pages.length < 10);
  }
  assert.ok(pages.length > 2);
  assert.deepEqual(pages.map((page) => page.more), [...Array(pages.length - 1).fill(true), undefined]);
  assert.deepEqual(pages.flatMap((page) => Object.keys(page.index)), Object.keys(whole), 'every key once, in order');
  assert.deepEqual(Object.assign({}, ...pages.map((page) => page.index)), whole);
  assert.deepEqual(a.pool.indexPage(T0), { index: pages[0].index, more: true });

  let after = '';
  const plans = pages.map((page) => {
    const plan = b.pool.reconcile(page.index, T0, { after, more: page.more === true });
    after = Object.keys(page.index).at(-1);
    return plan;
  });
  assert.deepEqual(plans.map((plan) => plan.push), [[recordKey(early)], ...Array(pages.length - 2).fill([]), [recordKey(late)]]);
  assert.deepEqual(plans.flatMap((plan) => plan.pull).sort(), offers.slice(offers.length / 2).map(recordKey).sort());
  // Taken for the whole index, a page would have every key past it sent back.
  assert.ok(b.pool.reconcile(pages[0].index, T0).push.length > 100);
  // A page said to be followed by more holds a key past the one it was asked from.
  assert.equal(b.pool.reconcile({}, T0, { more: true }), null);
  assert.equal(b.pool.reconcile(pages[0].index, T0, { after: Object.keys(pages[0].index).at(-1), more: true }), null);

  // A newcomer is answered the first page.
  const newcomer = ident(40);
  const answer = a.pool.answerHello({ member: member(newcomer, { voucher: seat(hosts[5].id) }) }, newcomer.pk, T0);
  assert.deepEqual([answer.body, answer.body.more], [a.pool.indexPage(T0), true]);
});

check('pull answers the records held under well-formed keys, and push reports each record', () => {
  const [a, b] = club(2);
  const o = offer(a.id);
  a.pool.merge(o, T0);
  const keys = [recordKey(o), `member/${a.id.pk}`, `member/${ident(40).pk}`, recordKey(o)];
  assert.deepEqual(a.pool.answerPull({ keys }), { body: { records: [a.pool.get(keys[1]), o] } });
  for (const bad of [null, {}, { keys: 'x' }, { keys: ['nope'] }, { keys: [5] }, { keys: Array(MAX_PULL_KEYS + 1).fill(keys[0]) }, { keys, more: 1 }]) {
    assert.deepEqual(a.pool.answerPull(bad), { error: 'bad-request' });
  }
  const pushed = b.pool.answerPush({ records: [o, { junk: true }, resign(b.id, o, { seq: 5 }), offer(eve)] }, T0);
  assert.deepEqual(pushed, { body: { accepted: [recordKey(o)], refused: [
    { key: '', code: 'bad-record' }, { key: recordKey(o), code: 'bad-signature' }, { key: `offer/${TASK}/${eve.pk}`, code: 'not-member' },
  ] } });
  for (const bad of [null, {}, { records: {} }, { records: Array(MAX_PUSH_RECORDS + 1).fill(o) }, { records: [], more: 1 }]) {
    assert.deepEqual(b.pool.answerPush(bad, T0), { error: 'bad-request' });
  }
});

check('hello lets in a newcomer with the voucher of a member and answers the index', () => {
  const host = poolOf(root, [member(root)]);
  const hi = member(ann, { voucher: seat(root) });
  assert.deepEqual(host.answerHello({ member: hi }, ben.pk, T0), { error: 'bad-request' }, 'a record of another key');
  assert.deepEqual(host.answerHello({ member: hi, more: 1 }, ann.pk, T0), { error: 'bad-request' });
  assert.deepEqual(host.answerHello({ member: { pk: ann.pk } }, ann.pk, T0), { error: 'bad-request' });
  assert.deepEqual(host.answerHello({ member: member(eve) }, eve.pk, T0), { error: 'denied', detail: 'not-member' });
  assert.deepEqual(host.answerHello({ member: member(eve, { voucher: seat(ident(11)) }) }, eve.pk, T0), { error: 'denied', detail: 'not-member' });
  assert.deepEqual(host.answerHello({ member: member(eve, { voucher: member(ann, { voucher: seat(root) }).voucher }) }, eve.pk, T0), { error: 'denied', detail: 'bad-voucher' });
  assert.equal(host.records().length, 1);
  const answer = host.answerHello({ member: hi }, ann.pk, T0 + 599);
  assert.deepEqual(answer, { body: { index: host.index(T0 + 599) } });
  assert.ok(host.member(ann.pk, T0 + 599));
  assert.ok(host.answerHello({ member: hi }, ann.pk, T0 + 5000).body);
  const gone = member(ann, { voucher: seat(root), seq: 1, at: T0 + 20, left: true });
  assert.deepEqual(host.answerHello({ member: gone }, ann.pk, T0 + 20), { error: 'denied', detail: 'left' });
  // Nobody put it out: a newer record of its own brings it back, by the voucher it had.
  assert.equal(host.accepts(ann.pk, T0 + 5000), false);
  const back = member(ann, { voucher: seat(root), seq: 2, at: T0 + 5000 });
  assert.ok(host.answerHello({ member: back }, ann.pk, T0 + 5000).body);
  assert.ok(host.member(ann.pk, T0 + 5000));
  // Its inviter gave the seat to another key since: it has none.
  assert.deepEqual(host.merge(member(ben, { voucher: seat(root, { at: T0 + 6000 }), at: T0 + 6000 }), T0 + 6000).refused, []);
  const late = member(ann, { voucher: seat(root), seq: 3, at: T0 + 7000 });
  assert.deepEqual(host.answerHello({ member: late }, ann.pk, T0 + 7000), { error: 'denied', detail: 'no-seat' });
  assert.deepEqual(host.members(T0 + 7000).map(pk), [root.pk, ben.pk].sort());
});

check('hello carries the records that lead from a newcomer to the first member of the pool', () => {
  // The root invited ann, and ann invited ben; the host knows the root only.
  const host = poolOf(root, [member(root)]);
  const [annM, benM, catM] = [member(ann, { voucher: seat(root) }), member(ben, { voucher: seat(ann) }), member(cat, { voucher: seat(ben) })];
  assert.deepEqual(host.answerHello({ member: benM }, ben.pk, T0), { error: 'denied', detail: 'not-member' }, 'alone it reaches nobody the host accepts');
  assert.deepEqual(host.answerHello({ member: benM, chain: [catM] }, ben.pk, T0), { error: 'denied', detail: 'not-member' }, 'nor with a record that is no link');
  assert.equal(host.records().length, 1, 'and nothing of a refused hello is kept');
  for (const bad of [{ member: benM, chain: 'x' }, { member: benM, chain: Array(MAX_HELLO_CHAIN + 1).fill(annM) }, { member: benM, chain: [offer(ann)] },
    { member: benM, chain: [{ junk: 1 }] }, { member: benM, chain: [member(ann, { pool: 'github.com/acme/other' })] }]) {
    assert.deepEqual(host.answerHello(bad, ben.pk, T0), { error: 'bad-request' }, JSON.stringify(bad).slice(0, 60));
  }
  const answer = host.answerHello({ member: benM, chain: [annM] }, ben.pk, T0);
  assert.deepEqual(answer, { body: { index: host.index(T0) } });
  assert.deepEqual(host.members(T0).map(pk), [root.pk, ann.pk, ben.pk].sort());
  // One three vouchers from the first has no seat, whatever it brings.
  assert.deepEqual(host.answerHello({ member: catM, chain: [benM, annM] }, cat.pk, T0), { error: 'denied', detail: 'no-seat' });
});

check('a task is available while a member offers it open and nobody holds it', () => {
  const hosts = club(3);
  const [a, b, c] = hosts;
  const give = (records, now = T0) => hosts.forEach((h) => h.pool.merge(records, now));
  assert.deepEqual(a.pool.tasks(T0), []);
  assert.equal(a.pool.task(TASK, T0), null);
  give([offer(a.id), offer(b.id, { minRequiredH: 24, title: 'Review it' })]);
  const lowest = [a.id.pk, b.id.pk].sort()[0];
  assert.deepEqual(a.pool.task(TASK, T0), {
    taskId: TASK, kind: 'review', item: 'pr-578', identity: 'octocat', title: lowest === a.id.pk ? 'Review #578' : 'Review it',
    hours: 24, createdAt: T0, state: 'available', offeredBy: [a.id.pk, b.id.pk].sort(), free: [a.id.pk, b.id.pk].sort(),
    offers: [{ host: a.id.pk, hours: 12, createdAt: T0, claim: null }, { host: b.id.pk, hours: 24, createdAt: T0, claim: null }]
      .sort((x, y) => (x.host < y.host ? -1 : 1)),
    claim: null,
  });
  give(offer(b.id, { seq: 1, at: T0 + 1, state: 'cancelled', minRequiredH: 24 }), T0 + 1);
  assert.equal(a.pool.task(TASK, T0 + 1).hours, 12, 'the largest among the open offers');
  assert.deepEqual(a.pool.task(TASK, T0 + 1).offeredBy, [a.id.pk]);
  const claim = claimNow(hosts, 2, TASK, T0 + 2);
  assert.equal(typeof claim, 'object');
  for (const h of hosts) {
    const task = h.pool.task(TASK, T0 + 2);
    assert.deepEqual([task.state, task.claim, task.free, task.offers], ['claimed', claim, [], [{ host: a.id.pk, hours: 12, createdAt: T0, claim }]]);
  }
  give(offer(a.id, { seq: 1, at: T0 + 3, state: 'done' }), T0 + 3);
  assert.deepEqual([c.pool.task(TASK, T0 + 3).state, c.pool.task(TASK, T0 + 3).claim, c.pool.task(TASK, T0 + 3).offers], ['done', null, []]);
  give(offer(a.id, { seq: 2, at: T0 + 4, state: 'cancelled' }), T0 + 4);
  assert.equal(c.pool.task(TASK, T0 + 4).state, 'cancelled');
  assert.deepEqual(c.pool.tasks(T0 + 4).map((t) => t.taskId), [TASK]);
});

check('the offers and the claims of a member that left count for nothing', () => {
  const hosts = club(3);
  const [a, b] = hosts;
  hosts.forEach((h) => h.pool.merge(offer(b.id), T0));
  const claim = claimNow(hosts, 2, TASK, T0 + 1);
  assert.equal(a.pool.task(TASK, T0 + 1).state, 'claimed');
  const executorLeft = member(hosts[2].id, { voucher: seat(hosts[0].id, { n: 2 }), seq: 1, at: T0 + 2, left: true });
  a.pool.merge(executorLeft, T0 + 2);
  assert.deepEqual([a.pool.task(TASK, T0 + 2).state, a.pool.task(TASK, T0 + 2).claim], ['available', null]);
  assert.equal(a.pool.get(recordKey(claim)), claim, 'the record is still held');
  a.pool.merge(member(b.id, { voucher: seat(hosts[0].id, { n: 1 }), seq: 1, at: T0 + 3, left: true }), T0 + 3);
  assert.equal(a.pool.task(TASK, T0 + 3), null);
});

check('a claim snapshot is what a round by this host starts from', () => {
  const hosts = club(3, T0, (i) => (i === 2 ? { maxAcceptedH: 12 } : { maxAcceptedH: 48 }));
  const [a, b, c] = hosts;
  hosts.forEach((h) => h.pool.merge(offer(b.id, { minRequiredH: 24 }), T0));
  assert.deepEqual(a.pool.claimSnapshot(TASK, T0 + 7), {
    pool: POOL, asOf: T0 + 7, hash: a.pool.stateHash(T0 + 7), gen: 0,
    members: [b.id.pk, c.id.pk].sort(), backers: { [b.id.pk]: { at: T0, hours: 24 } }, own: null, available: true, eligible: true,
  });
  const narrow = c.pool.claimSnapshot(TASK, T0 + 7);
  assert.deepEqual([narrow.available, narrow.eligible, narrow.backers], [true, false, {}], 'it accepts 12 hours and the offer needs 24');
  const offering = b.pool.claimSnapshot(TASK, T0 + 7);
  assert.deepEqual([offering.own, offering.backers], [{ at: T0, hours: 24 }, {}], 'its own offer is not another member\'s to give');
  // A second host offers the task for hours the narrow one accepts: that offer is its to take.
  hosts.forEach((h) => h.pool.merge(offer(a.id, { at: T0 + 7, createdAt: T0 + 7 }), T0 + 7));
  assert.deepEqual([c.pool.claimSnapshot(TASK, T0 + 7).eligible, c.pool.claimSnapshot(TASK, T0 + 7).backers], [true, { [a.id.pk]: { at: T0 + 7, hours: 12 } }]);
  const none = a.pool.claimSnapshot(`${POOL}#review:pr-1@octocat`, T0);
  assert.deepEqual([none.available, none.eligible, none.backers, none.own], [false, false, {}, null]);
  const first = claimNow(hosts, 0, TASK, T0 + 8);
  assert.deepEqual(backers(first), [a.id.pk, b.id.pk], 'its own offer and the other host\'s');
  const after = b.pool.claimSnapshot(TASK, T0 + 8);
  assert.deepEqual([after.available, after.eligible, after.gen, after.own], [false, false, 0, null]);
  // The count of a host's own claims of the task is the next one's gen, whoever else claimed it.
  hosts.forEach((h) => h.pool.merge(endClaim(a.id, first, 'released', T0 + 9), T0 + 9));
  assert.deepEqual([a.pool.claimSnapshot(TASK, T0 + 9).gen, c.pool.claimSnapshot(TASK, T0 + 9).gen], [1, 0]);
  const second = claimNow(hosts, 0, TASK, T0 + 10, 1);
  assert.deepEqual([second.gen, a.pool.get(recordKey(first)), backing(second, b.id.pk).gen], [1, second, 2]);
});

check('a member has 15 seats to give: of the records that name one, the latest voucher holds it, then the lowest key, whatever order they came in', () => {
  const ids = Array.from({ length: 40 }, (_, i) => ident(100 + i));
  const now = T0 + 200;
  const first = ids.slice(0, 15).map((id, n) => member(id, { voucher: seat(root, { n }), at: now }));
  const second = ids.slice(15, 20).map((id, n) => member(id, { voucher: seat(root, { n, at: T0 + 100 }), at: now }));
  const records = [member(root), ...first, ...second];
  const pool = poolOf(root);
  const result = pool.merge(records, now);
  const seats = (p) => p.members(now).map(pk).sort();
  assert.deepEqual(seats(pool), [root, ...ids.slice(5, 20)].map(pk).sort());
  assert.deepEqual(result.refused, ids.slice(0, 5).map((id) => ({ key: `member/${id.pk}`, code: 'no-seat' })));
  assert.equal(poolOf(root, records.toReversed(), now).stateHash(now), pool.stateHash(now), 'whatever order they came in');
  assert.equal(poolOf(root, [...records.slice(0, 16), ...second.toReversed()], now).stateHash(now), pool.stateHash(now));
  // A voucher older than the one that holds the seat seats nobody, and one as old only the lower key.
  assert.deepEqual(codes(pool.merge(member(eve, { voucher: seat(root, { n: 3, at: T0 + 50 }), at: now }), now)), ['no-seat']);
  const [low, high] = [ids[20], ids[21]].sort((x, y) => (x.pk < y.pk ? -1 : 1));
  const twins = [high, low].map((id) => member(id, { voucher: seat(root, { n: 14, at: T0 + 150 }), at: now }));
  for (const order of [twins, twins.toReversed()]) {
    const tied = poolOf(root, records, now);
    for (const record of order) tied.merge(record, now);
    assert.deepEqual(seats(tied), [root, ...ids.slice(5, 14), ...ids.slice(15, 20), low].map(pk).sort());
  }
  // A member one voucher from the first gives seats, and one two vouchers from it none.
  assert.deepEqual(pool.merge(member(ids[30], { voucher: seat(ids[5]), at: now }), now).refused, []);
  assert.deepEqual([pool.depth(root.pk, now), pool.depth(ids[5].pk, now), pool.depth(ids[30].pk, now)], [0, 1, 2]);
  assert.deepEqual(codes(pool.merge(member(ids[31], { voucher: seat(ids[30]), at: now }), now)), ['no-seat']);
  // A host whose seat went to another key is the first of a pool of its own where it looks.
  const own = poolOf(ids[0], records, now);
  assert.deepEqual(seats(own), [ids[0].pk]);
  assert.notEqual(own.stateHash(now), pool.stateHash(now));
});

check('one member makes no members but in its own seats: a voucher lets in the one key it names, and an invite in a record nobody', () => {
  const honest = [root, ann, ben, cat];
  const records = family(honest);
  const pool = poolOf(root, records);
  const now = T0 + 100;
  const puppets = Array.from({ length: 256 }, (_, i) => ident(1000 + i));
  // A record in the form of the build before this one, carrying an invite of the root's that ran out.
  const token = invite(root, { exp: T0 + 50 });
  const old = puppets.map((id) => resign(id, {
    type: 'member', pool: POOL, pk: id.pk, seq: 0, at: now, joinedAt: 0, maxAcceptedH: 12, left: false, voucher: { invite: token },
  }, {}));
  assert.deepEqual([...new Set(codes(pool.merge(old, now)))], ['bad-record']);
  // The voucher the root signed for ann, under other keys.
  const reused = puppets.map((id) => resign(id, member(id, { at: now }), { voucher: records[1].voucher }));
  assert.deepEqual([...new Set(codes(pool.merge(reused, now)))], ['bad-voucher']);
  assert.deepEqual(pool.members(now).map(pk), honest.map(pk).sort());
  // What ann has is her own 15 seats, and none below them.
  const hers = puppets.slice(0, 16).map((id, n) => member(id, { voucher: seat(ann, { n: n % 15, at: T0 + n }), at: now }));
  const under = puppets.slice(16, 20).map((id) => member(id, { voucher: seat(puppets[1]), at: now }));
  assert.deepEqual(codes(pool.merge([...hers, ...under], now)), ['no-seat', 'no-seat', 'no-seat', 'no-seat', 'no-seat']);
  assert.deepEqual(pool.members(now).map(pk), [...honest, ...puppets.slice(1, 16)].map(pk).sort());
  assert.equal(pool.members(now).length, 4 + LIMITS.invitees);
});

check('a member has 64 offers live, the lowest keys whatever order they came in; `room` says whether one more of its own fits', () => {
  const [a, b] = club(2);
  const offers = Array.from({ length: 70 }, (_, i) => offer(b.id, { item: `pr-${100 + i}`, title: 'x'.repeat(300) }));
  assert.deepEqual(codes(a.pool.merge(offers, T0)), Array(6).fill('quota'));
  b.pool.merge(offers.toReversed(), T0);
  const items = (pool) => pool.records().filter((r) => r.type === 'offer').map((r) => r.item).sort();
  assert.deepEqual(items(a.pool), offers.slice(0, LIMITS.offers).map((r) => r.item));
  assert.deepEqual([items(b.pool), b.pool.stateHash(T0)], [items(a.pool), a.pool.stateHash(T0)]);
  assert.deepEqual(codes(a.pool.merge(offer(a.id, { item: 'pr-999' }), T0)), [], 'another member has its own 64');
  // A lower key takes the place of the highest one held.
  assert.deepEqual(codes(a.pool.merge(offer(b.id, { item: 'pr-000' }), T0)), []);
  assert.deepEqual([items(a.pool).filter((item) => item !== 'pr-999').slice(0, 2), items(a.pool).includes('pr-163')], [['pr-000', 'pr-100'], false]);

  const [c, d] = club(2);
  c.pool.merge(offers.slice(0, 63), T0);
  assert.equal(c.pool.room(offers[63]), true, 'the 64th');
  c.pool.merge(offers[63], T0);
  assert.equal(c.pool.room(offers[64]), false, 'the 65th');
  assert.equal(c.pool.room(offer(d.id, { item: 'pr-100', title: 'x'.repeat(300), seq: 1, at: T0 + 1 })), true, 'a later version of one it has');
  assert.equal(c.pool.room(offer(c.id, { item: 'pr-1' })), true, 'what another member has takes nothing of this one\'s room');
});

check('the records of one member take 256 KiB at most: a claim past that is dead, and `room` keeps a host 32 KiB short of it', () => {
  const granters = [root, ...Array.from({ length: 150 }, (_, i) => ident(300 + i))];
  const records = family([root, ann, ...granters.slice(1)]);
  const tasks = Array.from({ length: 6 }, (_, i) => buildTaskId({ pool: POOL, kind: 'review', item: `pr-${i}`, identity: 'octocat' }));
  records.push(...tasks.map((_, i) => offer(root, { item: `pr-${i}` })));
  const claimOf = (taskId) => {
    const bound = { pool: POOL, taskId, executor: ann.pk, round: roundId(1), hash: b64u(Buffer.alloc(32, 7)), exp: T0 + 120 };
    const grants = granters.map((id) => buildGrant(id, { ...bound, ...(id === root ? { offer: { at: T0, gen: 1, hours: 12 } } : {}) }))
      .sort((x, y) => (x.by < y.by ? -1 : 1));
    return buildClaim(ann, { pool: POOL, taskId, round: roundId(1), gen: 0, grants, absent: [], now: T0 });
  };
  const claims = tasks.map(claimOf);
  const size = (record) => canon(record).length;
  const fit = Math.floor((LIMITS.bytes - size(records[1])) / size(claims[0]));
  assert.ok(fit >= 2 && fit < claims.length, `${fit} claims of ${size(claims[0])} bytes fit`);
  const pool = poolOf(root, records);
  assert.deepEqual(codes(pool.merge(claims, T0)), Array(claims.length - fit).fill('quota'));
  assert.deepEqual(tasks.map((taskId) => pool.task(taskId, T0).state), tasks.map((_, i) => (i < fit ? 'claimed' : 'available')), 'the lowest keys, the ones every host keeps');

  const one = poolOf(root, records);
  const mine = [size(records[1])];
  for (const claim of claims) {
    const fits = sum(mine) + size(claim) + LIMITS.spare <= LIMITS.bytes;
    assert.equal(one.room(claim), fits, `after ${mine.length - 1} claims`);
    if (fits) {
      one.merge(claim, T0);
      mine.push(size(claim));
    }
  }
  assert.ok(mine.length - 1 >= 1 && mine.length - 1 < fit, 'room runs out before the quota does');
});

check('a claim is a record only while a host that backs it offers the task, and holds the offers of the hosts that back it and no other', () => {
  const hosts = club(4);
  const [a, b, c, d] = hosts;
  hosts.forEach((h) => h.pool.merge(offer(a.id), T0));
  const now = T0 + 1;
  const body = { taskId: TASK, round: roundId(1), asOf: now, hash: a.pool.stateHash(now) };
  const grant = (h) => h.locks.answer({ pool: h.pool, identity: h.id, from: c.id.pk, body, now, nextGen: h.nextGen }).body.grant;
  const pks = (list) => list.map((h) => h.id.pk).sort();
  const held = buildClaim(c.id, {
    pool: POOL, taskId: TASK, round: roundId(1), gen: 0, absent: pks([d]), now, grants: [a, b].map(grant).sort((x, y) => (x.by < y.by ? -1 : 1)),
  });
  for (const h of hosts) assert.deepEqual(codes(h.pool.merge(held, now)), [], 'backed by the host that offers it');
  // A host that never held the offer has no claim to hold either.
  const bare = poolOf(d.id, b.pool.records().filter((r) => r.type === 'member'), now);
  assert.deepEqual(codes(bare.merge(held, now)), ['no-offer']);
  assert.deepEqual(codes(bare.merge([held, offer(a.id)], now)), [], 'the two together are taken in, whatever their order');
  // The record goes with the offer record of the host that backs it.
  const later = T0 + DAY + 301;
  const stamp = hosts.map((h, i) => member(h.id, { ...(i ? { voucher: seat(a.id, { n: i }) } : {}), seq: 1, at: later }));
  bare.merge(stamp, later);
  assert.equal(bare.get(recordKey(held)), null);

  // A member that offers a task backs a claim of its own with it, at whatever numbers it
  // likes, and needs nobody's grant: the claim holds its own offer and nothing of
  // another host's, whose offer stays with the claim that host gave it to.
  const others = club(3);
  const [x, y, z] = others;
  others.forEach((h) => h.pool.merge(offer(x.id), T0));
  const honest = claimNow(others, 2, TASK, T0);
  const forged = { pool: POOL, taskId: TASK, round: roundId(2), grants: [], absent: pks([x, z]), now };
  const unbacked = () => buildClaim(y.id, { ...forged, gen: 0 });
  assert.throws(unbacked, TypeError, 'a claim nobody backs cannot even be signed');
  const own = buildClaim(y.id, { ...forged, gen: 2 ** 40, offer: { at: now, gen: 2 ** 40, hours: 720 } });
  for (const h of others) {
    assert.deepEqual(codes(h.pool.merge(own, now)), ['no-offer'], 'not while it offers nothing');
    assert.deepEqual(codes(h.pool.merge([offer(y.id, { at: now, createdAt: now, minRequiredH: 720 }), own], now)), []);
    const task = h.pool.task(TASK, now);
    assert.deepEqual(task.offers, [
      { host: x.id.pk, hours: 12, createdAt: T0, claim: honest }, { host: y.id.pk, hours: 720, createdAt: now, claim: own },
    ].sort((p, q) => (p.host < q.host ? -1 : 1)));
    assert.deepEqual([task.state, task.free, h.pool.get(recordKey(honest))], ['claimed', [], honest]);
    // Its own offer ended, its claim is no record any more a day later; the other is untouched.
    assert.deepEqual(codes(h.pool.merge(offer(y.id, { seq: 1, at: now + 1, createdAt: now, minRequiredH: 720, state: 'done' }), now + 1)), []);
    const after = h.pool.task(TASK, now + 1);
    assert.deepEqual([after.state, after.claim, after.offers], ['claimed', honest, [{ host: x.id.pk, hours: 12, createdAt: T0, claim: honest }]]);
  }
});
