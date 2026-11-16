// The broker's certificate authority. The broker reads a container's traffic to a few
// hosts (the forge, the model provider) by terminating TLS for them, so it needs a
// certificate each client accepts: a CA that exists only on this machine, is trusted
// only inside its containers, and whose name constraints make it worthless for any host
// outside the list it was minted for.
//
// A CA's certificate is handed to the jobs that trust it, and it names every host it is
// good for. So there is one CA per set of hosts, made for exactly that set: a job's CA
// names its own pool's forge and the model provider, and tells it nothing of the forges
// other pools on this machine use. A job keeps the CA it started with, which is why
// they are kept as generations: <dir>/<id>/{ca.key,ca.crt,meta.json,leaves/<host>.{key,crt}}.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { readJson } from '../../../daemon-core/src/fsio.js';
import { CA_DIR, OPENSSL_BIN } from '../paths.js';

const DAY_MS = 24 * 3600 * 1000;
const CA_DAYS = 3650;
const LEAF_DAYS = 90;
// A certificate this close to its end is replaced before it is handed out again.
const CA_RENEW_MS = 120 * DAY_MS;
const LEAF_RENEW_MS = 14 * DAY_MS;
const HOSTNAME = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

/// The host in the form certificates carry it, or null when it is not a DNS name (an IP
/// address, a bare label, anything that could not sit in a config file verbatim).
export function certHost(host) {
  const h = String(host || '').toLowerCase().replace(/\.$/, '');
  return HOSTNAME.test(h) && !/^[\d.]+$/.test(h) ? h : null;
}

function run(bin, args) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: 30000, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (!err) return resolve(stdout);
      const e = new Error(err.code === 'ENOENT' ? `${bin} not found` : (stderr.trim().split('\n').pop() || err.message));
      e.code = err.code;
      reject(e);
    });
  });
}

function ecKey() {
  return crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    .privateKey.export({ type: 'sec1', format: 'pem' });
}

const endOf = (pem) => Date.parse(new crypto.X509Certificate(pem).validTo);

function caConfig(name, hosts, constrained) {
  // A DNS constraint also covers the name's subdomains. The two IP exclusions cover
  // every address: without them a certificate naming an IP would escape the DNS list.
  const nc = [...hosts.map((h) => `permitted;DNS:${h}`),
    'excluded;IP:0.0.0.0/0.0.0.0', 'excluded;IP:0:0:0:0:0:0:0:0/0:0:0:0:0:0:0:0'].join(',');
  return [
    '[req]', 'distinguished_name=dn', 'prompt=no', 'x509_extensions=v3_ca',
    '[dn]', `CN=${name}`,
    '[v3_ca]', 'basicConstraints=critical,CA:TRUE,pathlen:0', 'keyUsage=critical,keyCertSign',
    'subjectKeyIdentifier=hash',
    ...(constrained ? [`nameConstraints=critical,${nc}`] : []),
    '',
  ].join('\n');
}

function leafConfig(host) {
  return [
    '[req]', 'distinguished_name=dn', 'prompt=no',
    '[dn]', `CN=${host}`,
    '[v3_leaf]', 'basicConstraints=critical,CA:FALSE', 'keyUsage=critical,digitalSignature',
    'extendedKeyUsage=serverAuth', `subjectAltName=DNS:${host}`, 'authorityKeyIdentifier=keyid',
    '',
  ].join('\n');
}

/// The certificate authority kept under `dir`. `state()` is `{ state: 'idle' | 'ready' |
/// 'missing' | 'failed', detail }`; `authority(hosts)` resolves to the CA made for
/// exactly `hosts`, minting one when there is none or it is near its end: `{ id,
/// certPath, hosts, constrained, leaf(host) -> { key, cert } }`. A leaf is the same
/// object until its certificate is two weeks from its end, and one made anew from then
/// on. `kept(id)` is the generation of that id while it is on disk, or null: the one a
/// job still running was started under. `now` is the clock certificates are held to.
export function createCA({ dir = CA_DIR, log = () => {}, openssl = OPENSSL_BIN, now = Date.now } = {}) {
  let state = { state: 'idle', detail: '' };
  const expiresWithin = (pem, ms) => endOf(pem) - now() < ms;
  const authorities = new Map(); // id -> authority
  let minting = Promise.resolve();

  function fail(e) {
    state = e.code === 'ENOENT'
      ? { state: 'missing', detail: `${openssl} not found: the broker cannot issue certificates without it` }
      : { state: 'failed', detail: e.message };
    log('ca', state.state, state.detail);
    const err = new Error(`certificate authority: ${state.detail}`);
    err.code = e.code;
    return err;
  }

  function open(id) {
    if (authorities.has(id)) return authorities.get(id);
    const home = path.join(dir, id);
    const meta = readJson(path.join(home, 'meta.json'));
    const certPath = path.join(home, 'ca.crt');
    if (!meta || !Array.isArray(meta.hosts) || !fs.existsSync(certPath) || !fs.existsSync(path.join(home, 'ca.key'))) return null;
    const leaves = new Map(); // host -> { made: Promise<{ key, cert }>, renewAt }
    const authority = {
      id,
      certPath,
      hosts: meta.hosts,
      createdAt: Number(meta.createdAt) || 0,
      constrained: meta.constrained === true,
      expiring: () => expiresWithin(fs.readFileSync(certPath), CA_RENEW_MS),
      leaf(host) {
        const h = certHost(host);
        if (!h || !covers(meta.hosts, h)) return Promise.reject(new Error(`certificate authority: no certificate for ${host}`));
        const held = leaves.get(h);
        // One being made is waited for, whatever the clock says of the one before it.
        if (held && now() < held.renewAt) return held.made;
        const entry = { renewAt: Infinity };
        entry.made = issue(home, h).then((leaf) => {
          entry.renewAt = endOf(leaf.cert) - LEAF_RENEW_MS;
          return leaf;
        }, (e) => {
          if (leaves.get(h) === entry) leaves.delete(h);
          throw fail(e);
        });
        leaves.set(h, entry);
        return entry.made;
      },
    };
    authorities.set(id, authority);
    return authority;
  }

  async function issue(home, host) {
    const base = path.join(home, 'leaves', host);
    try {
      const cert = fs.readFileSync(`${base}.crt`);
      if (!expiresWithin(cert, LEAF_RENEW_MS)) return { key: fs.readFileSync(`${base}.key`), cert };
    } catch {}
    fs.mkdirSync(path.dirname(base), { recursive: true, mode: 0o700 });
    const tmp = `${base}.tmp.${process.pid}`;
    try {
      const key = ecKey();
      fs.writeFileSync(`${tmp}.key`, key, { mode: 0o600 });
      fs.writeFileSync(`${tmp}.cnf`, leafConfig(host));
      await run(openssl, ['req', '-new', '-key', `${tmp}.key`, '-config', `${tmp}.cnf`, '-out', `${tmp}.csr`]);
      // Positive and 127 bits: a serial with the top bit set is encoded a byte longer
      // than some verifiers accept.
      const serial = crypto.randomBytes(16);
      serial[0] &= 0x7f;
      await run(openssl, ['x509', '-req', '-in', `${tmp}.csr`, '-CA', path.join(home, 'ca.crt'),
        '-CAkey', path.join(home, 'ca.key'), '-set_serial', `0x${serial.toString('hex')}`,
        '-days', String(LEAF_DAYS), '-sha256', '-extfile', `${tmp}.cnf`, '-extensions', 'v3_leaf', '-out', `${tmp}.crt`]);
      const cert = fs.readFileSync(`${tmp}.crt`);
      // The key lands first: a reader that finds the certificate finds its key.
      fs.renameSync(`${tmp}.key`, `${base}.key`);
      fs.renameSync(`${tmp}.crt`, `${base}.crt`);
      return { key: Buffer.from(key), cert };
    } finally {
      for (const ext of ['key', 'cnf', 'csr', 'crt']) { try { fs.unlinkSync(`${tmp}.${ext}`); } catch {} }
    }
  }

  async function mint(hosts) {
    const id = crypto.randomBytes(6).toString('hex');
    const tmp = path.join(dir, `.${id}.tmp.${process.pid}`);
    fs.mkdirSync(tmp, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
    try {
      fs.writeFileSync(path.join(tmp, 'ca.key'), ecKey(), { mode: 0o600 });
      let constrained = true;
      const make = async () => {
        fs.writeFileSync(path.join(tmp, 'ca.cnf'), caConfig(`Diplomacy Network broker ${id}`, hosts, constrained));
        await run(openssl, ['req', '-new', '-x509', '-key', path.join(tmp, 'ca.key'), '-config', path.join(tmp, 'ca.cnf'),
          '-days', String(CA_DAYS), '-sha256', '-out', path.join(tmp, 'ca.crt')]);
      };
      try { await make(); } catch (e) {
        if (e.code === 'ENOENT') throw e;
        // An openssl that cannot write name constraints still gives a working CA; the
        // state says what it lacks.
        log('ca', 'name constraints refused, minting without:', e.message);
        constrained = false;
        await make();
      }
      fs.unlinkSync(path.join(tmp, 'ca.cnf'));
      fs.writeFileSync(path.join(tmp, 'meta.json'), `${JSON.stringify({ hosts, constrained, createdAt: Math.floor(now() / 1000) })}\n`);
      fs.renameSync(tmp, path.join(dir, id));
      log('ca', `minted ${id} for ${hosts.join(', ')}${constrained ? '' : ' (unconstrained)'}`);
      return id;
    } catch (e) {
      fs.rmSync(tmp, { recursive: true, force: true });
      throw e;
    }
  }

  // Every generation on disk, newest first.
  function generations() {
    let names = [];
    try { names = fs.readdirSync(dir); } catch {}
    return names.filter((n) => /^[0-9a-f]{12}$/.test(n)).map(open).filter(Boolean)
      .sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1));
  }
  const setOf = (hosts) => hosts.join(' ');

  function authority(hosts) {
    const wanted = [...new Set(hosts.map((h) => {
      const c = certHost(h);
      if (!c) throw new Error(`certificate authority: not a host name: ${h}`);
      return c;
    }))].sort();
    // One at a time: two jobs asking for the same hosts at once must share one CA.
    const next = minting.then(async () => {
      try {
        const have = generations().find((g) => setOf(g.hosts) === setOf(wanted) && !g.expiring());
        const made = have ?? open(await mint(wanted));
        state = { state: 'ready', detail: made.constrained ? '' : 'this openssl wrote no name constraints: the CA is valid for any host' };
        return made;
      } catch (e) {
        throw e.message.startsWith('certificate authority:') ? e : fail(e);
      }
    });
    minting = next.catch(() => {});
    return next;
  }

  /// Removes every generation but one of each set of hosts: the one `authority` hands
  /// out, or the newest when all of a set are near their end. Only for a daemon with no
  /// job running: a job's connections are answered from the generation it started with.
  function prune() {
    const keep = new Map(); // set of hosts -> id
    const all = generations();
    for (const g of [...all.filter((x) => !x.expiring()), ...all]) if (!keep.has(setOf(g.hosts))) keep.set(setOf(g.hosts), g.id);
    const kept = new Set(keep.values());
    let names = [];
    try { names = fs.readdirSync(dir); } catch {}
    for (const n of names) {
      // A generation this process is in the middle of minting is not yet one to judge.
      if (kept.has(n) || n.endsWith(`.tmp.${process.pid}`)) continue;
      authorities.delete(n);
      fs.rmSync(path.join(dir, n), { recursive: true, force: true });
    }
  }

  /// Removes every leaf certificate past its end, with its key, from every generation
  /// on disk: one that is asked for again is issued anew. Returns how many went.
  function dropExpired() {
    let gone = 0;
    for (const { id } of generations()) {
      const home = path.join(dir, id, 'leaves');
      let names = [];
      try { names = fs.readdirSync(home); } catch {}
      for (const name of names) {
        // `issue` makes a certificate beside the one it replaces, under a name of its own.
        if (!name.endsWith('.crt') || /\.tmp\.\d+\.crt$/.test(name)) continue;
        const base = path.join(home, name.slice(0, -'.crt'.length));
        // Read, judged and removed in one turn: `issue` replaces both files in one of its own.
        try {
          if (!(endOf(fs.readFileSync(`${base}.crt`)) <= now())) continue;
          fs.unlinkSync(`${base}.crt`);
          fs.rmSync(`${base}.key`, { force: true });
          gone += 1;
        } catch {}
      }
    }
    if (gone > 0) log('ca', `removed ${gone} leaf certificate(s) past their end`);
    return gone;
  }

  return { state: () => state, authority, kept: (id) => (/^[0-9a-f]{12}$/.test(id) ? open(id) : null), prune, dropExpired };
}

function covers(hosts, host) {
  return hosts.some((h) => host === h || host.endsWith(`.${h}`));
}
