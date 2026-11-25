// The model credential the broker writes into a job's requests to the provider; the
// container holds only a placeholder. Never logged, stored, or sent to another host.
//
// Sources, first found wins: the operator's `networkModelToken` (a macOS Keychain item,
// elsewhere a file: an API key or a `claude setup-token` token), this machine's Claude
// Code login, ANTHROPIC_API_KEY.
//
// The broker drops `authorization` and `x-api-key` and sets the one the credential calls
// for - `authorization: Bearer` for a login or setup-token (the job has
// CLAUDE_CODE_OAUTH_TOKEN=dn-placeholder), `x-api-key` for an API key (the job has
// ANTHROPIC_API_KEY=dn-placeholder) - and touches nothing else. Measured with Claude Code
// 2.1.325: a headless run needs the credential only on POST /v1/messages, and the provider
// takes a subscriber's token without the `oauth-2025-04-20` beta.
//
// A login's access token lasts a few hours and only a host `claude` renews it. Within
// five minutes of its end, or on a 401, the store is reread; if nothing is newer, the
// host's claude is made to renew: first `claude auth status` (measured: free, and renews a
// login under five minutes from its end), then a one-word prompt to the smallest model.
// At most one renewal per ten minutes, never two at once.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { CLAUDE_BIN, KEYCHAIN_TIMEOUT_MS, MODEL_TOKEN_KEYCHAIN, MODEL_TOKEN_PATH, SECURITY_BIN } from '../paths.js';

export const PLACEHOLDER = 'dn-placeholder';

const LOGIN_SERVICE = 'Claude Code-credentials';
const LOGIN = 'the Claude Code login';
const FRESH_MARGIN_MS = 5 * 60 * 1000;
const RENEW_EVERY_MS = 10 * 60 * 1000;
const REREAD_EVERY_MS = 5000;
// One 401 is not proof for ever.
const REFUSED_FOR_MS = 10 * 60 * 1000;

export function carriesPlaceholder(headers) {
  return String(headers.authorization || '').includes(PLACEHOLDER) || headers['x-api-key'] === PLACEHOLDER;
}

function exec(bin, args, { timeout, cwd } = {}) {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout, cwd, encoding: 'utf8', maxBuffer: 2 ** 20 }, (err, stdout) => resolve(err ? null : stdout));
  });
}

const kindOf = (token) => (token.startsWith('sk-ant-oat') ? 'oauth' : 'apikey');

function loginIn(raw, where) {
  try {
    const o = JSON.parse(raw).claudeAiOauth;
    // No token or no expiry: a husk an old login left behind.
    if (typeof o.accessToken === 'string' && o.accessToken && Number(o.expiresAt) > 0) {
      return { source: LOGIN, where, kind: 'oauth', token: o.accessToken, expiresAt: Number(o.expiresAt) };
    }
  } catch {}
  return null;
}

/// `refused(headers)` records a 401 for those headers and resolves to whether a different
/// credential is on hand.
export function createLLM({ log = () => {}, env = process.env, platform = process.platform, home = os.homedir(),
  user = env.USER || os.userInfo().username, now = Date.now, keychainMs = KEYCHAIN_TIMEOUT_MS } = {}) {
  let current = null;
  let state = { state: 'missing', detail: 'not read yet' };
  let lastRead = 0;
  let lastRenew = 0;
  let renewedExpired = false;
  let reading = null;
  const refusedAt = new Map();

  const keychain = (scope, service) => exec(SECURITY_BIN, ['find-generic-password', ...scope, '-s', service, '-w'], { timeout: keychainMs });

  async function read() {
    const found = [];
    const explicit = platform === 'darwin'
      ? await keychain(['-a', user], MODEL_TOKEN_KEYCHAIN)
      : await fs.promises.readFile(MODEL_TOKEN_PATH, 'utf8').catch(() => null);
    if (explicit && explicit.trim()) {
      found.push({ source: 'networkModelToken', kind: kindOf(explicit.trim()), token: explicit.trim(), expiresAt: 0 });
    }
    if (platform === 'darwin') {
      // Own account first: a lookup by service alone answers with whichever same-named item
      // it meets, and a husk under another account is common.
      for (const scope of [['-a', user], []]) {
        const item = loginIn(await keychain(scope, LOGIN_SERVICE), 'Keychain');
        if (item && !found.some((c) => c.token === item.token)) found.push(item);
      }
    }
    const file = loginIn(await fs.promises.readFile(path.join(home, '.claude', '.credentials.json'), 'utf8').catch(() => null), 'credentials file');
    if (file && !found.some((c) => c.token === file.token)) found.push(file);
    if (env.ANTHROPIC_API_KEY) found.push({ source: 'ANTHROPIC_API_KEY', kind: 'apikey', token: env.ANTHROPIC_API_KEY, expiresAt: 0 });
    lastRead = now();
    return found;
  }

  const refusedNow = (c) => now() - (refusedAt.get(c.token) ?? -Infinity) < REFUSED_FOR_MS;
  const usable = (c) => !(c.expiresAt && c.expiresAt <= now()) && !refusedNow(c);
  const fading = (c) => c.expiresAt > 0 && c.expiresAt - now() < FRESH_MARGIN_MS;

  async function renew(before, expired) {
    // A renewal asked while minutes were left gets one more go once none are, whatever
    // RENEW_EVERY_MS says: the first may have come too early to count.
    if (now() - lastRenew < RENEW_EVERY_MS && !(expired && !renewedExpired)) return;
    lastRenew = now();
    renewedExpired = expired;
    log('llm', 'asking the host\'s claude to renew its login');
    const cwd = os.tmpdir();
    await exec(CLAUDE_BIN, ['auth', 'status'], { timeout: 30000, cwd });
    const after = (await read()).find((c) => c.source === LOGIN && usable(c) && !fading(c));
    if (after && after.token !== before) return;
    await exec(CLAUDE_BIN, ['-p', '.', '--model', 'haiku', '--safe-mode', '--no-session-persistence', '--strict-mcp-config'],
      { timeout: 120000, cwd });
  }

  async function settle() {
    let found = await read();
    let pick = found.find(usable);
    const login = found.find((c) => c.source === LOGIN);
    // When the login is in use and fading, or nothing ranked above it is usable.
    if (login && (!pick || pick.source === 'ANTHROPIC_API_KEY' || (pick.source === LOGIN && fading(pick)))) {
      await renew(login.token, login.expiresAt <= now());
      found = await read();
      pick = found.find(usable);
    }
    current = pick || null;
    if (current) {
      const left = current.expiresAt ? `, good for ${Math.max(0, Math.round((current.expiresAt - now()) / 60000))} more minutes` : '';
      state = { state: 'ready', detail: `${current.source}${current.where ? ` (${current.where})` : ''}${left}` };
    } else {
      const why = found.length === 0
        ? 'no networkModelToken, no Claude Code login and no ANTHROPIC_API_KEY on this machine'
        : found.map((c) => `${c.source} ${refusedNow(c) ? 'was refused by the provider' : 'has expired'}`).join('; ');
      state = { state: 'missing', detail: why };
    }
    return current;
  }

  function ensure(force) {
    if (!force) {
      // Between rereads the answer stands, absence included: a client retrying against no
      // credential must not start a lookup per request.
      const justRead = now() - lastRead < REREAD_EVERY_MS;
      const good = current && usable(current);
      if (good ? !fading(current) || justRead : !current && justRead) return Promise.resolve(current);
    }
    reading ??= settle().finally(() => { reading = null; });
    return reading;
  }

  async function authorize(headers) {
    const c = await ensure(false);
    if (!c) throw new Error(state.detail);
    const out = { ...headers };
    delete out.authorization;
    delete out['x-api-key'];
    if (c.kind === 'apikey') {
      out['x-api-key'] = c.token;
      return out;
    }
    out.authorization = `Bearer ${c.token}`;
    return out;
  }

  async function refused(headers) {
    const sent = headers['x-api-key'] || String(headers.authorization || '').replace(/^Bearer /, '');
    if (!sent) return false;
    refusedAt.set(sent, now());
    for (const [token, at] of refusedAt) if (now() - at >= REFUSED_FOR_MS) refusedAt.delete(token);
    log('llm', `the provider refused ${current && current.token === sent ? current.source : 'a credential that is not the current one'}`);
    const next = await ensure(true);
    return !!next && next.token !== sent;
  }

  return {
    state: () => state,
    load: async () => { await ensure(true); return state; },
    env: () => (!current ? {} : current.kind === 'oauth' ? { CLAUDE_CODE_OAUTH_TOKEN: PLACEHOLDER } : { ANTHROPIC_API_KEY: PLACEHOLDER }),
    authorize,
    refused,
  };
}
