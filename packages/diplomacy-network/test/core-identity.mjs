import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { b64u, canon, hash, parseCanon, tagged, u32be, u64be, unb64u } from '../src/core/canon.js';
import { generateIdentity, identityFromSeed, onionAddress, sign, torSecretKey, validPk, verify } from '../src/core/identity.js';

function check(name, fn) {
  fn();
  console.log(`PASS ${name}`);
}

check('keys are sorted by code unit and nothing is padded', () => {
  assert.equal(canon({ b: 1, a: [true, 'x', { z: 0, y: -2 }], 'A': 'é' }).toString(), '{"A":"é","a":[true,"x",{"y":-2,"z":0}],"b":1}');
  assert.equal(canon({ 'a\u0000': 1, a: 2 }).toString(), '{"a":2,"a\\u0000":1}');
});

check('a value two hosts could spell differently is refused', () => {
  for (const bad of [1.5, NaN, Infinity, 2 ** 53, null, undefined, new Date(0), new Map(), () => 0, { a: null }, [undefined]]) {
    assert.throws(() => canon(bad), TypeError, String(bad));
  }
});

check('only the canonical bytes of a value parse as that value', () => {
  const value = { b: 1, a: [true, 'x', { z: 0, y: -2 }], 'A': 'é' };
  assert.deepEqual(parseCanon(canon(value)), value);
  assert.deepEqual(parseCanon(Buffer.from('[]')), []);
  const others = [
    '{"a":1,"b":2} ', ' {"a":1,"b":2}', '{"a": 1,"b":2}', '{"b":2,"a":1}', '{"a":1,"a":1,"b":2}', '{"a":1.0,"b":2}', '{"a":1e0,"b":2}',
    '{"a":1.5}', '{"a":-0}', '{"\\u0061":1}', '{"a":"\\u0078"}', '{"a":1', '', 'undefined', '{"a":1,}', "{'a':1}",
  ];
  for (const text of others) assert.equal(parseCanon(Buffer.from(text)), null, text);
  assert.equal(parseCanon(Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d])), null, 'bytes that are no UTF-8');
});

check('a hash covers buffers as they are and values in canonical form', () => {
  const direct = crypto.createHash('sha256').update('ab{"k":1}').digest();
  assert.deepEqual(hash(Buffer.from('a'), Buffer.from('b'), { k: 1 }), direct);
  assert.deepEqual(tagged('dn1/x', Buffer.from('z')), Buffer.from('dn1/x\0z'));
  assert.deepEqual(u32be(0x01020304), Buffer.from([1, 2, 3, 4]));
  assert.deepEqual(u64be(498333), Buffer.from([0, 0, 0, 0, 0, 7, 0x9a, 0x9d]));
});

check('base64url round-trips and rejects what it does not know', () => {
  const bytes = crypto.randomBytes(33);
  assert.deepEqual(unb64u(b64u(bytes)), bytes);
  for (const bad of ['a+b', 'a/b', 'ab==', 'a b', 'a', 5, null]) assert.equal(unb64u(bad), null, String(bad));
});

check('an identity survives a round trip through its seed', () => {
  const id = generateIdentity();
  assert.ok(validPk(id.pk));
  assert.deepEqual(identityFromSeed(id.seed), id);
  assert.equal(identityFromSeed('short'), null);
  assert.equal(validPk(id.pk.slice(1)), false);
});

check('a signature binds the tag, the signer and every member but sig', () => {
  const id = generateIdentity();
  const other = generateIdentity();
  const record = { type: 'member', seq: 3, nested: { b: 1, a: 2 } };
  const signed = { ...record, sig: sign(id, 'dn1/rec', record) };
  assert.ok(verify(id.pk, 'dn1/rec', signed));
  assert.ok(verify(id.pk, 'dn1/rec', { nested: { a: 2, b: 1 }, seq: 3, type: 'member', sig: signed.sig }));
  assert.equal(verify(id.pk, 'dn1/req', signed), false);
  assert.equal(verify(other.pk, 'dn1/rec', signed), false);
  assert.equal(verify(id.pk, 'dn1/rec', { ...signed, seq: 4 }), false);
  assert.equal(verify(id.pk, 'dn1/rec', { ...signed, extra: 1 }), false);
  assert.equal(verify(id.pk, 'dn1/rec', { ...signed, sig: 'AAAA' }), false);
  assert.equal(verify('nope', 'dn1/rec', signed), false);
  assert.equal(verify(id.pk, 'dn1/rec', { ...signed, bad: 1.5 }), false);
});

check('a point of small order is no public key, with either sign bit, and a key one byte from such a point is', () => {
  const small = ['00'.repeat(32), `01${'00'.repeat(31)}`, '26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05',
    'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a', `ec${'ff'.repeat(30)}7f`, `ed${'ff'.repeat(30)}7f`, `ee${'ff'.repeat(30)}7f`];
  // Whether such a signature verifies differs between crypto library versions; the refusal does not.
  for (const hex of small) {
    for (const sign of [0, 0x80]) {
      const bytes = Buffer.from(hex, 'hex');
      bytes[31] |= sign;
      assert.equal(validPk(b64u(bytes)), false, bytes.toString('hex'));
    }
  }
  const honest = unb64u(generateIdentity().pk);
  assert.equal(validPk(b64u(honest)), true);
  honest[0] = 0xec;
  honest.fill(0xff, 1, 31);
  honest[31] = 0x3f;
  assert.equal(validPk(b64u(honest)), true, 'a key that differs from such a point in one byte');
});

check('the onion address and tor key match what tor derives', () => {
  // RFC 8032 test vector 1, and the address tor's own test suite gives that key.
  const seed = Buffer.from('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60', 'hex');
  const id = identityFromSeed(seed);
  assert.equal(unb64u(id.pk).toString('hex'), 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a');
  const onion = onionAddress(id.pk);
  assert.match(onion, /^[a-z2-7]{56}\.onion$/);
  assert.equal(onion, '25njqamcweflpvkl73j4szahhihoc4xt3ktcgjnpaingr5yhkenl5sid.onion');
  const expanded = Buffer.from(torSecretKey(id).replace('ED25519-V3:', ''), 'base64');
  assert.equal(expanded.length, 64);
  assert.equal(expanded[0] & 7, 0);
  assert.equal(expanded[31] & 0xc0, 0x40);
  assert.throws(() => onionAddress('nope'), TypeError);
});
