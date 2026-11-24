// The broker's certificate authority: made once per set of hosts and constrained to
// that set, its leaves reused from disk, another pool's hosts under a CA of their own,
// and a clear state instead of a crash without openssl.
// Run: node test/executor-ca.mjs

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import tls from 'node:tls';
import { execFileSync } from 'node:child_process';
import { scratchDir } from './lib/scratch.mjs';

// What is private here is made so by name, whatever mask the daemon was started under.
process.umask(0o022);
const scratch = scratchDir('dn-ca-');
process.env.DN_BASE_DIR = path.join(scratch, 'base');
const { createCA, certHost } = await import('../src/executor/ca.js');
const { OPENSSL_BIN } = await import('../src/paths.js');

let checks = 0;
const check = async (name, fn) => { await fn(); checks++; console.log(`PASS ${name}`); };
const x509 = (pem) => new crypto.X509Certificate(pem);
const mode = (...parts) => fs.statSync(path.join(...parts)).mode & 0o777;
async function until(fn, what) {
  const end = Date.now() + 60000;
  while (!fn()) {
    if (Date.now() > end) throw new Error(`never: ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

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
    assert.deepEqual([mode(dir), mode(dir, first.id), mode(dir, first.id, 'ca.key')], [0o700, 0o700, 0o600]);
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

  await check('a directory that was there before, open to this machine\'s other users, is closed to them when a CA is made in it', async () => {
    const wide = path.join(scratch, 'ca-wide');
    fs.mkdirSync(wide, { mode: 0o755 });
    assert.equal(mode(wide), 0o755);
    await createCA({ dir: wide }).authority(['github.com']);
    assert.equal(mode(wide), 0o700);
  });

  await check('asking again for the same hosts, in any order or spelling, returns the same CA, across a restart too', async () => {
    assert.equal((await ca.authority([...HOSTS].reverse())).id, first.id);
    assert.equal((await ca.authority(['API.GitHub.com.', 'github.com', 'api.anthropic.com', 'github.com'])).id, first.id);
    assert.equal((await createCA({ dir }).authority(HOSTS)).id, first.id);
    assert.deepEqual(fs.readdirSync(dir), [first.id]);
  });

  await check('a leaf names its one host, is accepted under the CA for that host and refused for another', async () => {
    const leaf = await first.leaf('api.github.com');
    const cert = x509(leaf.cert);
    assert.equal(cert.subjectAltName, 'DNS:api.github.com');
    assert.equal(cert.ca, false);
    assert.deepEqual(cert.keyUsage, ['1.3.6.1.5.5.7.3.1'], 'good for a server and nothing else');
    assert.equal(cert.checkIssued(x509(fs.readFileSync(first.certPath))), true);
    assert.deepEqual([mode(dir, first.id, 'leaves'), mode(dir, first.id, 'leaves', 'api.github.com.key')], [0o700, 0o600], 'its key is this user\'s alone');
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

  await check('a leaf is handed out until two weeks before its end and made anew from then on, and one past its end is removed from disk with its key', async () => {
    const DAY = 24 * 3600 * 1000;
    const home = path.join(scratch, 'ca-aging');
    let ahead = 0;
    const aging = createCA({ dir: home, now: () => Date.now() + ahead });
    const authority = await aging.authority(['github.com']);
    const leaves = path.join(home, authority.id, 'leaves');
    const one = await authority.leaf('github.com');
    await authority.leaf('api.github.com');
    // Issued for 90 days.
    ahead = 75 * DAY;
    assert.equal(await authority.leaf('github.com'), one, 'fifteen days before its end');
    ahead = 77 * DAY;
    const two = await authority.leaf('github.com');
    assert.notEqual(x509(two.cert).serialNumber, x509(one.cert).serialNumber, 'thirteen days before its end');
    assert.equal(two.key.equals(fs.readFileSync(path.join(leaves, 'github.com.key'))), true, 'and the one on disk is the new one');

    ahead = 89 * DAY;
    assert.equal(aging.dropExpired(), 0, 'near its end is not past it');
    assert.deepEqual(fs.readdirSync(leaves).sort(), ['api.github.com.crt', 'api.github.com.key', 'github.com.crt', 'github.com.key']);
    // What an issue that was cut short leaves is not a certificate to judge.
    fs.writeFileSync(path.join(leaves, 'github.com.tmp.4242.crt'), fs.readFileSync(path.join(leaves, 'github.com.crt')));
    fs.writeFileSync(path.join(leaves, 'notes.crt'), 'not a certificate\n');
    ahead = 91 * DAY;
    assert.equal(aging.dropExpired(), 2);
    assert.deepEqual(fs.readdirSync(leaves).sort(), ['github.com.tmp.4242.crt', 'notes.crt']);
    assert.deepEqual(fs.readdirSync(path.join(home, authority.id)).sort(), ['ca.crt', 'ca.key', 'leaves', 'meta.json'], 'the authority itself has ten years');
    // Asked for again, it is issued again.
    const three = await authority.leaf('api.github.com');
    assert.ok(Date.parse(x509(three.cert).validTo) - Date.now() > 89 * DAY);
    assert.equal(fs.existsSync(path.join(leaves, 'api.github.com.crt')), true);
  });

  await check('the CA is worthless for a host it was not made for', async () => {
    assert.equal(first.constrained, true, 'this openssl writes name constraints');
    await assert.rejects(first.leaf('evil.example'), /no certificate for evil\.example/);
    // Even a leaf forged with the CA's own key: every verifier refuses the chain.
    const key = path.join(scratch, 'evil.key');
    const cnf = path.join(scratch, 'evil.cnf');
    fs.writeFileSync(key, crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ type: 'sec1', format: 'pem' }));
    // The two with an address are named for a host the CA is good for: nothing but the
    // address is at fault in them.
    for (const [cn, san, why] of [
      ['evil.example', 'DNS:evil.example', /permitted subtree violation/],
      ['github.com', 'IP:93.184.216.34', /excluded subtree violation/],
      ['github.com', 'IP:2606:2800:220:1:248:1893:25c8:1946', /excluded subtree violation/],
    ]) {
      fs.writeFileSync(cnf, `[req]\ndistinguished_name=dn\nprompt=no\n[dn]\nCN=${cn}\n[ext]\nsubjectAltName=${san}\n`);
      execFileSync(OPENSSL_BIN, ['req', '-new', '-key', key, '-config', cnf, '-out', path.join(scratch, 'evil.csr')]);
      execFileSync(OPENSSL_BIN, ['x509', '-req', '-in', path.join(scratch, 'evil.csr'), '-CA', first.certPath, '-CAkey', path.join(dir, first.id, 'ca.key'),
        '-set_serial', '0x66', '-days', '30', '-sha256', '-extfile', cnf, '-extensions', 'ext', '-out', path.join(scratch, 'evil.crt')], { stdio: 'ignore' });
      const forged = { key: fs.readFileSync(key), cert: fs.readFileSync(path.join(scratch, 'evil.crt')) };
      const outcome = await handshake(forged, fs.readFileSync(first.certPath), san.startsWith('IP') ? '' : 'evil.example');
      assert.match(outcome, why, `${san}: ${outcome}`);
    }
  });

  await check('another pool\'s hosts get a CA of their own: the certificate a job is handed names its own pool\'s hosts and no other pool\'s', async () => {
    const permitted = (authority) => execFileSync(OPENSSL_BIN, ['x509', '-in', authority.certPath, '-noout', '-text'], { encoding: 'utf8' })
      .split('\n').filter((l) => /DNS:/.test(l)).map((l) => l.trim().replace(/^DNS:/, '')).sort();
    const second = await ca.authority(['gitlab.corp-internal.example', 'api.anthropic.com']);
    assert.notEqual(second.id, first.id);
    assert.deepEqual(second.hosts, ['api.anthropic.com', 'gitlab.corp-internal.example']);
    assert.deepEqual(permitted(second), ['api.anthropic.com', 'gitlab.corp-internal.example']);
    // The pool that came first is not named to the one that came later, nor the later one to a job admitted after it.
    assert.deepEqual(permitted(first), [...HOSTS].sort());
    const again = await ca.authority(HOSTS);
    assert.equal(again.id, first.id, 'the first pool\'s next job gets the first pool\'s CA');
    assert.doesNotMatch(fs.readFileSync(again.certPath, 'latin1'), /gitlab\.corp-internal\.example/);
    assert.doesNotMatch(fs.readFileSync(second.certPath, 'latin1'), /github\.com/);
    // Each signs for its own hosts and refuses the other's.
    assert.equal(await handshake(await second.leaf('gitlab.corp-internal.example'), fs.readFileSync(second.certPath), 'gitlab.corp-internal.example'), 'ok');
    assert.equal(await handshake(await first.leaf('uploads.api.github.com'), fs.readFileSync(first.certPath), 'uploads.api.github.com'), 'ok');
    await assert.rejects(second.leaf('github.com'), /no certificate for github\.com/);
    await assert.rejects(first.leaf('gitlab.corp-internal.example'), /no certificate for gitlab\.corp-internal\.example/);
    assert.notEqual(await handshake(await second.leaf('api.anthropic.com'), fs.readFileSync(first.certPath), 'api.anthropic.com'), 'ok', 'and neither is the other\'s trust root');
    // A subset or a superset of a pool's hosts is another set: no CA serves it by naming more.
    assert.notEqual((await ca.authority(['github.com'])).id, first.id);
  });

  await check('two jobs asking for the same hosts at once share one CA', async () => {
    const fresh = createCA({ dir: path.join(scratch, 'ca2') });
    const [a, b, c] = await Promise.all([fresh.authority(['github.com']), fresh.authority(['github.com']), fresh.authority(['GitHub.com.'])]);
    assert.equal(b.id, a.id);
    assert.equal(c.id, a.id);
    assert.deepEqual(fs.readdirSync(path.join(scratch, 'ca2')), [a.id]);
  });

  await check('a CA near its end is replaced for the next job, and pruning keeps the newest generation of each set of hosts', async () => {
    const sets = () => fs.readdirSync(dir).filter((n) => n !== 'current').map((n) => JSON.parse(fs.readFileSync(path.join(dir, n, 'meta.json'), 'utf8')).hosts.join(' ')).sort();
    assert.deepEqual(sets(), ['api.anthropic.com api.github.com github.com', 'api.anthropic.com gitlab.corp-internal.example', 'github.com']);
    // The first pool's CA with three months left, as the next job finds it: a certificate
    // of the same key and name, signed again to end sooner.
    const home = path.join(dir, first.id);
    const cnf = path.join(scratch, 'aging.cnf');
    fs.writeFileSync(cnf, `[req]\ndistinguished_name=dn\nprompt=no\nx509_extensions=v3\n[dn]\nCN=Diplomacy Network broker ${first.id}\n[v3]\nbasicConstraints=critical,CA:TRUE,pathlen:0\nkeyUsage=critical,keyCertSign\n`);
    execFileSync(OPENSSL_BIN, ['req', '-new', '-x509', '-key', path.join(home, 'ca.key'), '-config', cnf, '-days', '90', '-sha256', '-out', path.join(home, 'ca.crt')]);
    // Its stamp an hour ahead, as a clock set back since leaves it: by age alone it
    // would pass for the newest.
    const meta = path.join(home, 'meta.json');
    fs.writeFileSync(meta, `${JSON.stringify({ ...JSON.parse(fs.readFileSync(meta, 'utf8')), createdAt: Math.floor(Date.now() / 1000) + 3600 })}\n`);
    const renewed = await createCA({ dir }).authority(HOSTS);
    assert.notEqual(renewed.id, first.id);
    assert.deepEqual(renewed.hosts, [...HOSTS].sort());
    assert.ok(createCA({ dir }).kept(first.id), 'the old generation is still there for the jobs started under it');
    // What an earlier version left beside the generations goes too.
    fs.writeFileSync(path.join(dir, 'current'), `${first.id}\n`);
    const fresh = createCA({ dir });
    fresh.prune();
    assert.equal(fs.existsSync(home), false, 'the older generation of a set is removed');
    assert.equal(fs.existsSync(path.join(dir, 'current')), false);
    assert.deepEqual(sets(), ['api.anthropic.com api.github.com github.com', 'api.anthropic.com gitlab.corp-internal.example', 'github.com'], 'and every set keeps one');
    assert.equal(fresh.kept(first.id), null);
    assert.equal((await fresh.authority(HOSTS)).id, renewed.id);
  });

  await check('pruning leaves alone the generation that is being made at that moment, and removes what a process that is gone left half made', async () => {
    const home = path.join(scratch, 'ca-minting');
    const go = path.join(scratch, 'go');
    // An openssl that waits to be let go, for as long as this test's files are there.
    const slow = path.join(scratch, 'slow-openssl');
    fs.writeFileSync(slow, `#!/bin/sh\nwhile [ ! -e '${go}' ] && [ -e "$0" ]; do sleep 0.05; done\nexec '${OPENSSL_BIN}' "$@"\n`, { mode: 0o755 });
    const minting = createCA({ dir: home, openssl: slow });
    const made = minting.authority(['github.com']);
    await until(() => fs.existsSync(home) && fs.readdirSync(home).length === 1, 'the generation to be begun');
    const [half] = fs.readdirSync(home);
    assert.match(half, new RegExp(`^\\.[0-9a-f]{12}\\.tmp\\.${process.pid}$`));
    fs.mkdirSync(path.join(home, '.0123456789ab.tmp.1'));
    minting.prune();
    assert.deepEqual(fs.readdirSync(home), [half]);
    fs.writeFileSync(go, '');
    const authority = await made;
    assert.deepEqual(fs.readdirSync(home), [authority.id]);
    assert.equal(await handshake(await authority.leaf('github.com'), fs.readFileSync(authority.certPath), 'github.com'), 'ok');
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
