// The broker's certificate authority: made once, constrained to the hosts it was made
// for, its leaves reused from disk, a new generation when a host outside it is needed,
// and a clear state instead of a crash without openssl.
// Run: node test/executor-ca.mjs

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { execFileSync } from 'node:child_process';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'dn-ca-'));
process.env.DN_BASE_DIR = path.join(scratch, 'base');
const { createCA, certHost } = await import('../src/executor/ca.js');
const { OPENSSL_BIN } = await import('../src/paths.js');

let checks = 0;
const check = async (name, fn) => { await fn(); checks++; console.log(`PASS ${name}`); };
const x509 = (pem) => new crypto.X509Certificate(pem);

// A TLS handshake against `leaf`, by a client that trusts only `caPem`.
function handshake(leaf, caPem, servername) {
  return new Promise((resolve) => {
    const server = tls.createServer({ key: leaf.key, cert: leaf.cert }, (s) => s.end());
    server.on('tlsClientError', () => {});
    server.listen(0, '127.0.0.1', () => {
      const client = tls.connect({ host: '127.0.0.1', port: server.address().port, servername, ca: caPem }, () => {
        client.end();
        server.close();
        resolve('ok');
      });
      client.on('error', (e) => { server.close(); resolve(`${e.code}: ${e.message}`); });
    });
  });
}

try {
  const dir = path.join(scratch, 'ca');
  const ca = createCA({ dir });
  const HOSTS = ['github.com', 'api.github.com', 'api.anthropic.com'];

  await check('nothing exists and nothing is claimed before the first authority is asked for', () => {
    assert.equal(fs.existsSync(dir), false);
    assert.equal(ca.state().state, 'idle');
  });

  const first = await ca.authority(HOSTS);

  await check('the CA is made once, private to this user, and is a CA that can sign leaves only', () => {
    assert.equal(ca.state().state, 'ready');
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(dir, first.id, 'ca.key')).mode & 0o777, 0o600);
    const cert = x509(fs.readFileSync(first.certPath));
    assert.equal(cert.ca, true);
    assert.match(cert.subject, /CN=Diplomacy Network broker [0-9a-f]{12}/);
    assert.equal(cert.checkIssued(cert), true);
    assert.ok(Date.parse(cert.validTo) - Date.now() > 3000 * 24 * 3600 * 1000, cert.validTo);
    const text = execFileSync(OPENSSL_BIN, ['x509', '-in', first.certPath, '-noout', '-text'], { encoding: 'utf8' });
    assert.match(text, /CA:TRUE, pathlen:0/);
    assert.match(text, /Certificate Sign/);
    assert.doesNotMatch(text, /Digital Signature|Key Encipherment/);
  });

  await check('asking again for hosts it covers returns the same CA, across a restart too', async () => {
    assert.equal((await ca.authority(['api.github.com'])).id, first.id);
    assert.equal((await ca.authority(['raw.api.github.com'])).id, first.id, 'a subdomain of a permitted name is covered');
    assert.equal((await createCA({ dir }).authority(HOSTS)).id, first.id);
    assert.deepEqual(fs.readdirSync(dir).sort(), ['current', first.id].sort());
  });

  await check('a leaf names its one host, is accepted under the CA for that host and refused for another', async () => {
    const leaf = await first.leaf('api.github.com');
    const cert = x509(leaf.cert);
    assert.equal(cert.subjectAltName, 'DNS:api.github.com');
    assert.equal(cert.ca, false);
    assert.equal(cert.checkIssued(x509(fs.readFileSync(first.certPath))), true);
    const caPem = fs.readFileSync(first.certPath);
    assert.equal(await handshake(leaf, caPem, 'api.github.com'), 'ok');
    assert.match(await handshake(leaf, caPem, 'github.com'), /^ERR_TLS_CERT_ALTNAME_INVALID/);
    assert.notEqual(await handshake(leaf, fs.readFileSync(path.join(dir, first.id, 'leaves', 'api.github.com.crt')), 'api.github.com'), 'ok', 'a leaf is not its own trust root');
  });

  await check('a leaf is made once: the second request, and the next process, read it from disk', async () => {
    const a = await first.leaf('github.com');
    const [b, c] = await Promise.all([first.leaf('github.com'), first.leaf('GitHub.com.')]);
    assert.equal(b, a);
    assert.equal(c, a);
    const again = await (await createCA({ dir }).authority(HOSTS)).leaf('github.com');
    assert.equal(x509(again.cert).serialNumber, x509(a.cert).serialNumber);
    assert.deepEqual(again.key, a.key);
  });

  await check('a leaf about to expire is replaced, not served', async () => {
    const base = path.join(dir, first.id, 'leaves', 'api.anthropic.com');
    const fresh = await first.leaf('api.anthropic.com');
    // The same key under a certificate with a week left: inside the renewal margin.
    const cnf = path.join(scratch, 'short.cnf');
    fs.writeFileSync(cnf, '[req]\ndistinguished_name=dn\nprompt=no\n[dn]\nCN=api.anthropic.com\n[ext]\nsubjectAltName=DNS:api.anthropic.com\n');
    execFileSync(OPENSSL_BIN, ['req', '-new', '-key', `${base}.key`, '-config', cnf, '-out', path.join(scratch, 'short.csr')]);
    execFileSync(OPENSSL_BIN, ['x509', '-req', '-in', path.join(scratch, 'short.csr'), '-CA', first.certPath, '-CAkey', path.join(dir, first.id, 'ca.key'),
      '-set_serial', '0x77', '-days', '7', '-sha256', '-extfile', cnf, '-extensions', 'ext', '-out', `${base}.crt`], { stdio: 'ignore' });
    const replaced = await (await createCA({ dir }).authority(HOSTS)).leaf('api.anthropic.com');
    assert.notEqual(x509(replaced.cert).serialNumber, '77');
    assert.notEqual(x509(replaced.cert).serialNumber, x509(fresh.cert).serialNumber);
    assert.ok(Date.parse(x509(replaced.cert).validTo) - Date.now() > 60 * 24 * 3600 * 1000);
  });

  await check('the CA is worthless for a host it was not made for', async () => {
    assert.equal(first.constrained, true, 'this openssl writes name constraints');
    await assert.rejects(first.leaf('evil.example'), /no certificate for evil\.example/);
    // Even a leaf forged with the CA's own key: every verifier refuses the chain.
    const key = path.join(scratch, 'evil.key');
    const cnf = path.join(scratch, 'evil.cnf');
    fs.writeFileSync(key, crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ type: 'sec1', format: 'pem' }));
    for (const [name, san] of [['evil.example', 'DNS:evil.example'], ['an address', 'IP:93.184.216.34']]) {
      fs.writeFileSync(cnf, `[req]\ndistinguished_name=dn\nprompt=no\n[dn]\nCN=evil.example\n[ext]\nsubjectAltName=${san}\n`);
      execFileSync(OPENSSL_BIN, ['req', '-new', '-key', key, '-config', cnf, '-out', path.join(scratch, 'evil.csr')]);
      execFileSync(OPENSSL_BIN, ['x509', '-req', '-in', path.join(scratch, 'evil.csr'), '-CA', first.certPath, '-CAkey', path.join(dir, first.id, 'ca.key'),
        '-set_serial', '0x66', '-days', '30', '-sha256', '-extfile', cnf, '-extensions', 'ext', '-out', path.join(scratch, 'evil.crt')], { stdio: 'ignore' });
      const forged = { key: fs.readFileSync(key), cert: fs.readFileSync(path.join(scratch, 'evil.crt')) };
      const outcome = await handshake(forged, fs.readFileSync(first.certPath), san.startsWith('IP') ? '' : 'evil.example');
      assert.match(outcome, /permitted subtree violation|excluded subtree violation/, `${name}: ${outcome}`);
    }
  });

  await check('a host outside the CA mints a new generation that covers the old hosts too, and the old one keeps working', async () => {
    const second = await ca.authority(['gitlab.example.org', 'api.anthropic.com']);
    assert.notEqual(second.id, first.id);
    assert.deepEqual(second.hosts, [...HOSTS, 'gitlab.example.org'].sort());
    assert.equal(fs.readFileSync(path.join(dir, 'current'), 'utf8').trim(), second.id);
    assert.equal(await handshake(await second.leaf('gitlab.example.org'), fs.readFileSync(second.certPath), 'gitlab.example.org'), 'ok');
    // A job that started under the first generation is still answered from it.
    assert.equal(await handshake(await first.leaf('uploads.api.github.com'), fs.readFileSync(first.certPath), 'uploads.api.github.com'), 'ok');
    assert.equal((await ca.authority(HOSTS)).id, second.id);
    assert.notEqual(await handshake(await second.leaf('github.com'), fs.readFileSync(first.certPath), 'github.com'), 'ok');
  });

  await check('two jobs asking for the same hosts at once share one CA', async () => {
    const fresh = createCA({ dir: path.join(scratch, 'ca2') });
    const [a, b, c] = await Promise.all([fresh.authority(['github.com']), fresh.authority(['github.com']), fresh.authority(['api.github.com'])]);
    assert.equal(b.id, a.id);
    assert.equal(c.id, a.id);
    assert.deepEqual(fs.readdirSync(path.join(scratch, 'ca2')).sort(), ['current', a.id].sort());
  });

  await check('pruning keeps the newest generation only', async () => {
    assert.equal(fs.readdirSync(dir).length, 3);
    ca.prune();
    const now = fs.readFileSync(path.join(dir, 'current'), 'utf8').trim();
    assert.deepEqual(fs.readdirSync(dir).sort(), ['current', now].sort());
    assert.equal((await ca.authority(HOSTS)).id, now);
  });

  await check('what is not a DNS name gets no certificate', async () => {
    for (const bad of ['127.0.0.1', '10.1.2.3', 'localhost', '', 'a b.com', 'x.com\nsubjectAltName=DNS:y.com', '[::1]', '*.github.com', 'a..b']) {
      assert.equal(certHost(bad), null, JSON.stringify(bad));
      await assert.rejects(Promise.resolve().then(() => ca.authority([bad])), /not a host name/, JSON.stringify(bad));
    }
    assert.equal(certHost('API.GitHub.com.'), 'api.github.com');
  });

  await check('without openssl the state says so and nothing throws outside the promise', async () => {
    const none = createCA({ dir: path.join(scratch, 'ca3'), openssl: path.join(scratch, 'no-such-openssl') });
    await assert.rejects(none.authority(['github.com']), /certificate authority: .*not found/);
    assert.equal(none.state().state, 'missing');
    assert.match(none.state().detail, /no-such-openssl not found/);
    assert.deepEqual(fs.readdirSync(path.join(scratch, 'ca3')), [], 'no half-made generation is left');
  });

  await check('an openssl that fails is a failed state with its own last words', async () => {
    const bad = path.join(scratch, 'bad-openssl');
    fs.writeFileSync(bad, '#!/bin/sh\necho "unable to load config" >&2\nexit 1\n', { mode: 0o755 });
    const broken = createCA({ dir: path.join(scratch, 'ca4'), openssl: bad });
    await assert.rejects(broken.authority(['github.com']), /unable to load config/);
    assert.deepEqual(broken.state(), { state: 'failed', detail: 'unable to load config' });
  });

  console.log(`\nall ${checks} checks passed`);
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
