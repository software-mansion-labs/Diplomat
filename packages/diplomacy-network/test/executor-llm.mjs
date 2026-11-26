// The model credential: which source wins, what is written into a request, and how a
// login that is running out or was refused is renewed - against stand-ins for
// `security` and `claude`, a credentials file and a clock this test moves.
// Run: node test/executor-llm.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { scratchDir } from './lib/scratch.mjs';

const scratch = scratchDir('dn-llm-');
const STORE = path.join(scratch, 'keychain.json'); // "<service>|<account>" -> what `security -w` prints
const PLAN = path.join(scratch, 'claude-plan.json'); // "auth" | "print" -> keychain entries / a file to write
const CALLS = path.join(scratch, 'calls.log');

const script = (name, body) => {
  const p = path.join(scratch, name);
  fs.writeFileSync(p, `#!/usr/bin/env node\n${body}\n`, { mode: 0o755 });
  return p;
};
const HUNG = path.join(scratch, 'hung.pids');
process.env.DN_BASE_DIR = path.join(scratch, 'base');
// However long this machine takes to start a stand-in, it is waited for.
process.env.DN_KEYCHAIN_TIMEOUT_MS = String(3600 * 1000);
process.env.DN_MODEL_TOKEN_PATH = path.join(scratch, 'network-model-token');
process.env.DN_SECURITY = script('security', `
const fs = require('fs');
const a = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(CALLS)}, 'security ' + a.join(' ') + '\\n');
const at = (f) => (a.includes(f) ? a[a.indexOf(f) + 1] : '');
const store = JSON.parse(fs.readFileSync(${JSON.stringify(STORE)}, 'utf8'));
if (store.hangs) { fs.appendFileSync(${JSON.stringify(HUNG)}, process.pid + '\\n'); setInterval(() => {}, 1000); return; }
const hit = store[at('-s') + '|' + at('-a')];
if (a[0] !== 'find-generic-password' || !a.includes('-w') || hit === undefined) process.exit(44);
console.log(hit);`);
process.env.DN_CLAUDE = script('claude', `
const fs = require('fs');
const a = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(CALLS)}, 'claude ' + a.join(' ') + '\\n');
let plan = {};
try { plan = JSON.parse(fs.readFileSync(${JSON.stringify(PLAN)}, 'utf8')); } catch {}
const step = plan[a[0] === 'auth' ? 'auth' : a.includes('-p') ? 'print' : ''];
if (step && step.keychain) {
  const store = JSON.parse(fs.readFileSync(${JSON.stringify(STORE)}, 'utf8'));
  fs.writeFileSync(${JSON.stringify(STORE)}, JSON.stringify({ ...store, ...step.keychain }));
}
if (step && step.file) fs.writeFileSync(step.file.path, step.file.text);`);

const { createLLM, carriesPlaceholder, PLACEHOLDER } = await import('../src/executor/llm.js');
const { MODEL_TOKEN_KEYCHAIN, MODEL_TOKEN_PATH } = await import('../src/paths.js');

let checks = 0;
const check = async (name, fn) => { await fn(); checks++; console.log(`PASS ${name}`); };

const T0 = 1_800_000_000_000;
const MIN = 60 * 1000;
const LOGIN = 'Claude Code-credentials';
const login = (token, expiresAt) => JSON.stringify({ claudeAiOauth: { accessToken: token, refreshToken: 'sk-ant-ort01-never-read', expiresAt, scopes: ['user:inference'] }, mcpOAuth: {} });
const HUSK = login('', 0);
const calls = () => (fs.existsSync(CALLS) ? fs.readFileSync(CALLS, 'utf8').split('\n').filter(Boolean) : []);
const claudeCalls = () => calls().filter((c) => c.startsWith('claude '));

// One machine: a Keychain, a home, an environment and a clock.
function world({ keychain = {}, file = null, env = {}, platform = 'darwin', explicitFile = null, plan = {}, keychainMs } = {}) {
  fs.rmSync(CALLS, { force: true });
  fs.writeFileSync(STORE, JSON.stringify(keychain));
  fs.writeFileSync(PLAN, JSON.stringify(plan));
  const home = fs.mkdtempSync(path.join(scratch, 'home-'));
  if (file) {
    fs.mkdirSync(path.join(home, '.claude'));
    fs.writeFileSync(path.join(home, '.claude', '.credentials.json'), file);
  }
  fs.rmSync(MODEL_TOKEN_PATH, { force: true });
  if (explicitFile) fs.writeFileSync(MODEL_TOKEN_PATH, explicitFile);
  const clock = { now: T0 };
  const logged = [];
  const llm = createLLM({ log: (...a) => logged.push(a.join(' ')), env, platform, home, user: 'op', now: () => clock.now, keychainMs });
  return { llm, clock, logged, home };
}
const REQUEST = { authorization: `Bearer ${PLACEHOLDER}`, 'anthropic-version': '2023-06-01', 'anthropic-beta': 'claude-code-20250219', 'content-type': 'application/json' };

try {
  await check('the network\'s own token wins over the login, and the login over the API key', async () => {
    const all = { [`${MODEL_TOKEN_KEYCHAIN}|op`]: 'sk-ant-oat01-network', [`${LOGIN}|op`]: login('sk-ant-oat01-login', T0 + 200 * MIN) };
    let w = world({ keychain: all, env: { ANTHROPIC_API_KEY: 'sk-ant-api03-env' } });
    assert.deepEqual(await w.llm.load(), { state: 'ready', detail: 'networkModelToken' });
    assert.equal((await w.llm.authorize(REQUEST)).authorization, 'Bearer sk-ant-oat01-network');

    w = world({ keychain: { [`${LOGIN}|op`]: all[`${LOGIN}|op`] }, env: { ANTHROPIC_API_KEY: 'sk-ant-api03-env' } });
    assert.deepEqual(await w.llm.load(), { state: 'ready', detail: 'the Claude Code login (Keychain), good for 200 more minutes' });
    assert.equal((await w.llm.authorize(REQUEST)).authorization, 'Bearer sk-ant-oat01-login');

    w = world({ env: { ANTHROPIC_API_KEY: 'sk-ant-api03-env' } });
    assert.deepEqual(await w.llm.load(), { state: 'ready', detail: 'ANTHROPIC_API_KEY' });
    assert.equal((await w.llm.authorize(REQUEST))['x-api-key'], 'sk-ant-api03-env');
  });

  await check('a machine with none of them is missing a credential, says which, and refuses to authorize', async () => {
    const w = world();
    assert.deepEqual(w.llm.state(), { state: 'missing', detail: 'not read yet' });
    assert.deepEqual(await w.llm.load(), { state: 'missing', detail: 'no networkModelToken, no Claude Code login and no ANTHROPIC_API_KEY on this machine' });
    await assert.rejects(w.llm.authorize(REQUEST), /no networkModelToken/);
    assert.deepEqual(w.llm.env(), {});
    assert.deepEqual(claudeCalls(), [], 'there is no login to renew');
  });

  await check('the login is looked up under the user\'s account first, and the empty item a bare lookup finds is ignored', async () => {
    const w = world({ keychain: { [`${LOGIN}|`]: HUSK, [`${LOGIN}|op`]: login('sk-ant-oat01-live', T0 + 100 * MIN) } });
    assert.equal((await w.llm.load()).state, 'ready');
    assert.equal((await w.llm.authorize(REQUEST)).authorization, 'Bearer sk-ant-oat01-live');
    const lookups = calls().filter((c) => c.includes(LOGIN));
    assert.equal(lookups[0], `security find-generic-password -a op -s ${LOGIN} -w`);

    const husk = world({ keychain: { [`${LOGIN}|`]: HUSK, [`${LOGIN}|op`]: HUSK }, env: { ANTHROPIC_API_KEY: 'k' } });
    assert.deepEqual(await husk.llm.load(), { state: 'ready', detail: 'ANTHROPIC_API_KEY' }, 'an item with no token and no expiry is not a login');
    assert.deepEqual(claudeCalls(), []);
  });

  await check('elsewhere the token is a file and the login is Claude Code\'s credentials file; no Keychain is asked', async () => {
    let w = world({ platform: 'linux', file: login('sk-ant-oat01-file', T0 + 90 * MIN), explicitFile: 'sk-ant-api03-network\n' });
    assert.deepEqual(await w.llm.load(), { state: 'ready', detail: 'networkModelToken' });
    assert.equal((await w.llm.authorize(REQUEST))['x-api-key'], 'sk-ant-api03-network');
    w = world({ platform: 'linux', file: login('sk-ant-oat01-file', T0 + 90 * MIN) });
    assert.deepEqual(await w.llm.load(), { state: 'ready', detail: 'the Claude Code login (credentials file), good for 90 more minutes' });
    assert.deepEqual(calls().filter((c) => c.startsWith('security')), []);
    w = world({ platform: 'linux', file: '{"claudeAiOauth":' });
    assert.equal((await w.llm.load()).state, 'missing', 'a torn file is no login');
  });

  await check('a subscriber\'s token replaces Authorization, an API key replaces x-api-key, and nothing else changes', async () => {
    const sub = world({ keychain: { [`${LOGIN}|op`]: login('sk-ant-oat01-login', T0 + 200 * MIN) } });
    await sub.llm.load();
    assert.deepEqual(sub.llm.env(), { CLAUDE_CODE_OAUTH_TOKEN: PLACEHOLDER });
    const sent = { ...REQUEST, 'x-api-key': 'something the client made up' };
    const frozen = JSON.stringify(sent);
    assert.deepEqual(await sub.llm.authorize(sent), { ...REQUEST, authorization: 'Bearer sk-ant-oat01-login' });
    assert.equal(JSON.stringify(sent), frozen, 'the caller\'s headers are not written to');

    const key = world({ env: { ANTHROPIC_API_KEY: 'sk-ant-api03-env' } });
    await key.llm.load();
    assert.deepEqual(key.llm.env(), { ANTHROPIC_API_KEY: PLACEHOLDER });
    const { authorization, ...rest } = REQUEST;
    assert.deepEqual(await key.llm.authorize({ ...rest, 'x-api-key': PLACEHOLDER, authorization }), { ...rest, 'x-api-key': 'sk-ant-api03-env' });

    const setup = world({ keychain: { [`${MODEL_TOKEN_KEYCHAIN}|op`]: 'sk-ant-oat01-setup-token' } });
    await setup.llm.load();
    assert.deepEqual(setup.llm.env(), { CLAUDE_CODE_OAUTH_TOKEN: PLACEHOLDER }, 'a setup-token is a subscriber\'s token');
  });

  await check('only a request holding the placeholder asks for the credential', () => {
    assert.equal(carriesPlaceholder({ authorization: `Bearer ${PLACEHOLDER}` }), true);
    assert.equal(carriesPlaceholder({ 'x-api-key': PLACEHOLDER }), true);
    assert.equal(carriesPlaceholder({}), false);
    assert.equal(carriesPlaceholder({ authorization: 'Bearer sk-ant-something-else', 'x-api-key': 'k' }), false);
  });

  await check('a good login is read once, however many requests it serves', async () => {
    const w = world({ keychain: { [`${LOGIN}|op`]: login('sk-ant-oat01-login', T0 + 200 * MIN) } });
    await w.llm.load();
    const before = calls().length;
    for (let i = 0; i < 50; i++) { w.clock.now += 1000; await w.llm.authorize(REQUEST); }
    assert.equal(calls().length, before);
  });

  await check('a login with under five minutes left is read again, and what the host\'s claude renewed meanwhile is used', async () => {
    const w = world({ keychain: { [`${LOGIN}|op`]: login('sk-ant-oat01-old', T0 + 30 * MIN) } });
    await w.llm.load();
    w.clock.now = T0 + 26 * MIN;
    fs.writeFileSync(STORE, JSON.stringify({ [`${LOGIN}|op`]: login('sk-ant-oat01-renewed-by-a-session', T0 + 500 * MIN) }));
    assert.equal((await w.llm.authorize(REQUEST)).authorization, 'Bearer sk-ant-oat01-renewed-by-a-session');
    assert.deepEqual(claudeCalls(), [], 'the store had a newer one: nothing had to be run');
  });

  await check('when the store has nothing newer, `claude auth status` is run once to renew it - once for any number of waiting requests', async () => {
    const w = world({
      keychain: { [`${LOGIN}|op`]: login('sk-ant-oat01-old', T0 + 30 * MIN) },
      plan: { auth: { keychain: { [`${LOGIN}|op`]: login('sk-ant-oat01-new', T0 + 500 * MIN) } } },
    });
    await w.llm.load();
    w.clock.now = T0 + 27 * MIN;
    const all = await Promise.all(Array.from({ length: 8 }, () => w.llm.authorize(REQUEST)));
    for (const h of all) assert.equal(h.authorization, 'Bearer sk-ant-oat01-new');
    assert.deepEqual(claudeCalls(), ['claude auth status']);
    assert.match(w.llm.state().detail, /good for 473 more minutes/);
  });

  await check('if the status command renews nothing, a one-word prompt to the smallest model does', async () => {
    const w = world({
      keychain: { [`${LOGIN}|op`]: login('sk-ant-oat01-old', T0 + 30 * MIN) },
      plan: { print: { keychain: { [`${LOGIN}|op`]: login('sk-ant-oat01-new', T0 + 500 * MIN) } } },
    });
    await w.llm.load();
    w.clock.now = T0 + 28 * MIN;
    assert.equal((await w.llm.authorize(REQUEST)).authorization, 'Bearer sk-ant-oat01-new');
    assert.deepEqual(claudeCalls(), ['claude auth status', 'claude -p . --model haiku --safe-mode --no-session-persistence --strict-mcp-config']);
  });

  await check('a login nothing renews is used to its last minute, asked about at most every ten, then given one last go and reported missing', async () => {
    const w = world({ keychain: { [`${LOGIN}|op`]: login('sk-ant-oat01-old', T0 + 30 * MIN) } });
    await w.llm.load();
    w.clock.now = T0 + 26 * MIN;
    assert.equal((await w.llm.authorize(REQUEST)).authorization, 'Bearer sk-ant-oat01-old', 'four minutes left is still a credential');
    assert.equal(claudeCalls().length, 2);
    for (let i = 0; i < 20; i++) { w.clock.now += 6000; await w.llm.authorize(REQUEST); }
    assert.equal(claudeCalls().length, 2, 'not once per request');
    w.clock.now = T0 + 31 * MIN;
    await assert.rejects(w.llm.authorize(REQUEST), /the Claude Code login has expired/);
    assert.equal(claudeCalls().length, 4, 'expiry earns one more attempt inside the ten minutes');
    assert.deepEqual(w.llm.state(), { state: 'missing', detail: 'the Claude Code login has expired' });
    for (let i = 0; i < 20; i++) { w.clock.now += 6000; await assert.rejects(w.llm.authorize(REQUEST)); }
    assert.equal(claudeCalls().length, 4);
    w.clock.now += 10 * MIN;
    fs.writeFileSync(PLAN, JSON.stringify({ auth: { keychain: { [`${LOGIN}|op`]: login('sk-ant-oat01-back', w.clock.now + 400 * MIN) } } }));
    assert.equal((await w.llm.authorize(REQUEST)).authorization, 'Bearer sk-ant-oat01-back', 'ten minutes on it is asked again');
    assert.equal(w.llm.state().state, 'ready');
  });

  await check('an expired login gives way to the API key, after one attempt to renew it', async () => {
    const w = world({ keychain: { [`${LOGIN}|op`]: login('sk-ant-oat01-dead', T0 - MIN) }, env: { ANTHROPIC_API_KEY: 'sk-ant-api03-env' } });
    assert.deepEqual(await w.llm.load(), { state: 'ready', detail: 'ANTHROPIC_API_KEY' });
    assert.equal(claudeCalls()[0], 'claude auth status');
    assert.equal((await w.llm.authorize({ 'x-api-key': PLACEHOLDER }))['x-api-key'], 'sk-ant-api03-env');
  });

  await check('a 401 with a newer token already in the store is answered with that token', async () => {
    const w = world({ keychain: { [`${LOGIN}|op`]: login('sk-ant-oat01-revoked', T0 + 200 * MIN) } });
    const sent = await w.llm.authorize(REQUEST);
    fs.writeFileSync(STORE, JSON.stringify({ [`${LOGIN}|op`]: login('sk-ant-oat01-rotated', T0 + 400 * MIN) }));
    assert.equal(await w.llm.refused(sent), true);
    assert.equal((await w.llm.authorize(REQUEST)).authorization, 'Bearer sk-ant-oat01-rotated');
    assert.deepEqual(claudeCalls(), []);
  });

  await check('a 401 on the only token there is runs the renewal; if that changes nothing the credential is missing, for ten minutes', async () => {
    const w = world({ keychain: { [`${LOGIN}|op`]: login('sk-ant-oat01-revoked', T0 + 200 * MIN) } });
    const sent = await w.llm.authorize(REQUEST);
    assert.equal(await w.llm.refused(sent), false);
    assert.equal(claudeCalls().length, 2);
    assert.deepEqual(w.llm.state(), { state: 'missing', detail: 'the Claude Code login was refused by the provider' });
    await assert.rejects(w.llm.authorize(REQUEST), /was refused by the provider/);
    w.clock.now += 11 * MIN;
    assert.equal((await w.llm.authorize(REQUEST)).authorization, 'Bearer sk-ant-oat01-revoked', 'one 401 is not proof for ever');
  });

  await check('a 401 on the login renews it through the host\'s claude and reports the new token', async () => {
    const w = world({
      keychain: { [`${LOGIN}|op`]: login('sk-ant-oat01-revoked', T0 + 200 * MIN) },
      plan: { print: { keychain: { [`${LOGIN}|op`]: login('sk-ant-oat01-fresh', T0 + 480 * MIN) } } },
    });
    const sent = await w.llm.authorize(REQUEST);
    assert.equal(await w.llm.refused(sent), true);
    assert.equal((await w.llm.authorize(REQUEST)).authorization, 'Bearer sk-ant-oat01-fresh');
  });

  await check('a late 401 for a token no longer in use does not cost the one that replaced it', async () => {
    const w = world({ keychain: { [`${LOGIN}|op`]: login('sk-ant-oat01-a', T0 + 200 * MIN) } });
    const old = await w.llm.authorize(REQUEST);
    fs.writeFileSync(STORE, JSON.stringify({ [`${LOGIN}|op`]: login('sk-ant-oat01-b', T0 + 400 * MIN) }));
    await w.llm.load();
    assert.equal(await w.llm.refused(old), true);
    assert.equal((await w.llm.authorize(REQUEST)).authorization, 'Bearer sk-ant-oat01-b');
    assert.equal(await w.llm.refused({}), false, 'a request that carried no credential refuses nothing');
    assert.equal(w.llm.state().state, 'ready');
  });

  await check('a Keychain that does not answer is given up on after its time and its helper ended, and the sources that do answer count', async () => {
    const w = world({ keychain: { hangs: true }, env: { ANTHROPIC_API_KEY: 'sk-ant-api03-env' }, keychainMs: 200 });
    let late;
    const state = await Promise.race([w.llm.load(), new Promise((resolve) => { late = setTimeout(resolve, 120000, 'still waiting for the Keychain'); })]);
    clearTimeout(late);
    assert.deepEqual(state, { state: 'ready', detail: 'ANTHROPIC_API_KEY' });
    const helpers = fs.readFileSync(HUNG, 'utf8').split('\n').filter(Boolean).map(Number);
    assert.equal(helpers.length, 3, 'the network token and the login under both lookups were asked for');
    const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    for (const end = Date.now() + 120000; helpers.some(alive);) {
      assert.ok(Date.now() < end, 'a helper that was given up on still runs');
      await new Promise((resolve) => { setTimeout(resolve, 20); });
    }
  });

  await check('no token ever reaches the log, whatever happens to it', async () => {
    const w = world({
      keychain: { [`${MODEL_TOKEN_KEYCHAIN}|op`]: 'sk-ant-api03-network', [`${LOGIN}|op`]: login('sk-ant-oat01-login', T0 + 3 * MIN) },
      env: { ANTHROPIC_API_KEY: 'sk-ant-api03-env' },
    });
    for (let i = 0; i < 3; i++) {
      const sent = await w.llm.authorize(REQUEST).catch(() => null);
      if (sent) await w.llm.refused(sent);
      w.clock.now += MIN;
    }
    assert.ok(w.logged.length >= 3, w.logged.join('\n'));
    const said = [...w.logged, JSON.stringify(w.llm.state())].join('\n');
    assert.doesNotMatch(said, /sk-ant|never-read/);
    assert.match(said, /the provider refused networkModelToken/);
  });

  console.log(`\nall ${checks} checks passed`);
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
