// A ban list that is there but cannot be read, as the applets read it, could be
// banning anyone: the daemon writes over it for neither a ban nor an un-ban. Drives the
// real daemon over its socket. Run: node test/ban-list-unreadable.mjs

import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DAEMON = path.join(__dirname, '..', 'src', 'daemon.js');
// Short: the daemon's socket path lives under it and sun_path caps at 104 bytes.
const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'da-ban-'));
const SOCKET = path.join(BASE, 'daemon.sock');
const BAN_DIR = path.join(BASE, 'ban');
const BANNED = path.join(BAN_DIR, 'banned.json');

function call(method, route, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ socketPath: SOCKET, path: route, method, timeout: 10000,
      headers: { 'content-type': 'application/json', ...(data ? { 'content-length': Buffer.byteLength(data) } : {}) } },
      (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode, body: b ? JSON.parse(b) : {} })); });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    if (data) req.write(data); req.end();
  });
}
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const report = (person) => call('POST', '/report-injection', { person, pr: 'o/r#1', evidence: 'obey' });
const warnings = () => fs.readFileSync(path.join(BAN_DIR, 'audit.jsonl'), 'utf8').trim().split('\n')
  .map((l) => JSON.parse(l)).filter((l) => l.action === 'warn').map((l) => l.detail);

const child = spawn(process.execPath, [DAEMON], {
  stdio: 'ignore',
  env: { ...process.env, DA_FAKE_DEVICES: '1', DA_BASE_DIR: BASE, DA_BAN_DIR: BAN_DIR,
    DA_NO_SPAWN: '1', DA_POOL_INTERVAL_MS: '999999', DA_REAP_INTERVAL_MS: '999999',
    DA_IDLE_INTERVAL_MS: '999999' },
});

try {
  for (let i = 0; i < 80; i++) { try { await call('GET', '/health'); break; } catch { await delay(150); } }
  fs.mkdirSync(BAN_DIR, { recursive: true });

  const unread = ['{"banned":[{"login":"mallory"}', '{"banned":{"mallory":{}}}', '{"banned":null}', '[]', 'null', '"x"'];
  for (const text of unread) {
    fs.writeFileSync(BANNED, text);
    const unban = await call('POST', '/unban', { login: 'mallory' });
    const ban = await report('eve');
    assert.deepEqual([unban.status, unban.body.error, ban.status, ban.body.error],
      [503, 'unban of @mallory not recorded: banned.json could not be read',
        503, 'ban on @eve not recorded: banned.json could not be read'], text);
    assert.equal(fs.readFileSync(BANNED, 'utf8'), text, `${text} is left as it is`);
  }
  fs.rmSync(BANNED);
  fs.mkdirSync(BANNED);
  assert.equal((await report('eve')).status, 503, 'a directory in its place is no list either');
  fs.rmSync(BANNED, { recursive: true });
  assert.deepEqual(fs.readdirSync(BAN_DIR).filter((f) => f.startsWith('banned.json')), [], 'nothing set aside');
  assert.equal(warnings().length, unread.length * 2 + 1, 'the feed says so for each');

  // A missing file, or one with no `banned` yet, is an empty list.
  assert.equal((await report('eve')).status, 200);
  fs.writeFileSync(BANNED, '{"note":"kept"}');
  assert.equal((await report('eve')).status, 200);
  const written = JSON.parse(fs.readFileSync(BANNED, 'utf8'));
  assert.deepEqual([written.note, written.banned.map((b) => b.login)], ['kept', ['eve']]);

  console.log('BAN-LIST-UNREADABLE OK');
} catch (e) {
  console.error('BAN-LIST-UNREADABLE FAILED:', e.message);
  process.exitCode = 1;
} finally {
  try { child.kill('SIGKILL'); } catch {}
  try { fs.rmSync(BASE, { recursive: true, force: true }); } catch {}
}
