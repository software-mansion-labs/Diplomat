// The model credential the broker adds to a job's requests. The container holds a
// placeholder; the real value is read here, on the host, and written into the request
// on its way to the provider. It is never logged, never written anywhere, and never
// sent to any host but the provider's.
//
// Where it comes from, first found wins:
//   1. the token the operator set aside for the network (`networkModelToken`): a macOS
//      Keychain item, elsewhere a file - an API key, or a `claude setup-token` token;
//   2. the Claude Code login this machine already has;
//   3. ANTHROPIC_API_KEY in the daemon's environment.
//
// What the broker rewrites on a request to the provider, and all it rewrites:
//   - `authorization` and `x-api-key` are removed, and the one the credential calls for
//     is set: `authorization: Bearer <token>` for a login or setup-token (the client was
//     given CLAUDE_CODE_OAUTH_TOKEN=dn-placeholder, so it already speaks as a
//     subscriber), `x-api-key: <key>` for an API key (the client was given
//     ANTHROPIC_API_KEY=dn-placeholder).
// Nothing else is touched. Measured with Claude Code 2.1.325: a headless run needs the
// credential on POST /v1/messages only (its other calls to the provider fail quietly on
// the placeholder), and the provider takes a subscriber's token with or without the
// `oauth-2025-04-20` beta, so no header has to be added.
//
// A login's access token lasts a few hours and only a `claude` on the host renews it.
// Within five minutes of its end, or when the provider answers 401, the store is read
// again; if that brings nothing newer, the host's `claude` is run so that it renews and
// stores its token, and the store is read a last time. Measured: `claude auth status`
// renews a login that has under five minutes left (and leaves one with thirty alone),
// so it comes first and costs nothing. The fallback is a one-word prompt to the smallest
// model, which makes the client use its token; whether that renews one the provider
// revoked early is not measured. At most one renewal every ten minutes, never two at
// once.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { CLAUDE_BIN, KEYCHAIN_TIMEOUT_MS, MODEL_TOKEN_KEYCHAIN, MODEL_TOKEN_PATH, SECURITY_BIN } from '../paths.js';

/// What a container holds in place of every credential.
export const PLACEHOLDER = 'dn-placeholder';

const LOGIN_SERVICE = 'Claude Code-credentials';
const LOGIN = 'the Claude Code login';
const FRESH_MARGIN_MS = 5 * 60 * 1000;
const RENEW_EVERY_MS = 10 * 60 * 1000;
const REREAD_EVERY_MS = 5000;
// A token the provider refused is left alone this long, then tried again: one 401 is
// not proof for ever.
const REFUSED_FOR_MS = 10 * 60 * 1000;

/// Whether a request's own credential is the placeholder, which is what marks it as one
/// to add the real credential to.
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
    // An item with no token or no expiry is a husk an old login left behind.
    if (typeof o.accessToken === 'string' && o.accessToken && Number(o.expiresAt) > 0) {
      return { source: LOGIN, where, kind: 'oauth', token: o.accessToken, expiresAt: Number(o.expiresAt) };
    }
  } catch {}
  return null;
}

/// The credential. `state()` is `{ state: 'ready' | 'missing', detail }` as of the last
/// read; `load()` reads the sources and resolves to it. `env()` is what a job's
/// environment carries so its client sends the placeholder the right way. `authorize(headers)`
/// resolves to the headers with the real credential in place of the placeholder and
/// rejects when there is none. `refused(headers)` tells it the provider answered those
/// headers with 401, and resolves to whether a different credential is on hand. A
/// Keychain item that is not answered for within `keychainMs` counts as not there.
export function createLLM({ log = () => {}, env = process.env, platform = process.platform, home = os.homedir(),
  user = env.USER || os.userInfo().username, now = Date.now, keychainMs = KEYCHAIN_TIMEOUT_MS } = {}) {
  let current = null;
  let state = { state: 'missing', detail: 'not read yet' };
  let lastRead = 0;
  let lastRenew = 0;
  let renewedExpired = false;
  let reading = null;
  const refusedAt = new Map(); // token -> when

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
      // Under Claude Code's own account first: a lookup by service alone answers with
      // whichever same-named item it meets, and a husk under another account is common.
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

  // The host's own claude renews its login when it is asked anything that needs one. The
  // status command is free; the one-word prompt to the smallest model is the fallback
  // that always goes through the renewing path.
  async function renew(before, expired) {
    // A login asked to renew while it still had minutes left gets one more go the moment
    // it has none, whatever the clock says: the first may have come too early to count.
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
    // The login is renewed when it is what would be used and is running out, or when
    // it cannot be used and nothing ranked above it can either.
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
      // Between two reads of the store the answer stands, the absence of one included:
      // a client retrying against no credential must not start a lookup per request.
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
