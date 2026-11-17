// A stand-in for the model provider: api.anthropic.com over TLS on a port of this
// machine, under a certificate made for the test. It answers every request 200 and keeps
// what it was sent. A daemon started with `env` reaches it in place of the provider:
// to-fake-model.mjs, loaded before the daemon, leads the provider's name here, and the
// certificate is among the roots the daemon's node trusts.

import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROUTE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'to-fake-model.mjs');

/// Starts it, its key and certificate kept in `dir`: `{ port, seen, env, close() }`.
/// `seen` is every request so far as `{ method, url, key, bytes }`, `key` being the
/// credential it carried and `bytes` the length of its body.
export async function startFakeModel(dir) {
  const [key, cert] = [path.join(dir, 'model.key'), path.join(dir, 'model.crt')];
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '2',
    '-subj', '/CN=api.anthropic.com', '-addext', 'subjectAltName=DNS:api.anthropic.com', '-keyout', key, '-out', cert,
  ], { stdio: 'ignore' });
  const seen = [];
  const server = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, (req, res) => {
    let bytes = 0;
    req.on('data', (chunk) => { bytes += chunk.length; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, key: req.headers['x-api-key'] ?? '', bytes });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"type":"message","content":[]}');
    });
  });
  server.on('tlsClientError', () => {});
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    port, seen,
    env: { NODE_OPTIONS: `--import=${pathToFileURL(ROUTE).href}`, NODE_EXTRA_CA_CERTS: cert, FAKE_MODEL_PORT: String(port) },
    close: () => new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections();
    }),
  };
}
