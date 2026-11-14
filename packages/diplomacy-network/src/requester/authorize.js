// Decides whether one forge request from an executor is inside its task's rules
// (PROTOCOL.md sections 9 and 10). The executor is not trusted: everything here assumes
// the request was written by someone trying to reach past the rules.
//
// A request is first brought to one spelling, and refused when it has more than one
// reading: the forge, a proxy in front of it and this file must all see the same path,
// the same query and the same body. Then the first rule whose host, method and path match
// decides, alone - its pins and deep checks are not retried against a later rule. What
// matches nothing is refused.

import { checkGraphql, itemMismatch, searchConfined } from './graphql.js';
import { checkAdvertise, checkPush } from './receivepack.js';

const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:[0-9]{1,5})?$/;
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;
// RFC 3986 path characters, less ";": some servers read it as the start of path
// parameters, and older Rack splits a query on it.
const PATH_CHARS = /^[A-Za-z0-9\-._~!$&'()*+,=:@%/]*$/;
const QUERY_CHARS = /^[A-Za-z0-9\-._~!$&'()*+,=:@%/?]*$/;
// Query parameters that change who a request acts as or what method it is, on any route.
const DENIED_QUERY = new Set(['sudo', 'private_token', 'access_token', 'job_token', '_method']);
const JSON_TYPE = /^application\/json\s*(;\s*charset=utf-8\s*)?$/i;
const RECEIVE_PACK_TYPE = 'application/x-git-receive-pack-request';
// A line GitLab would read as a quick action ("/merge", "/approve", "/assign @x"): text
// posted in the requester's name is otherwise a way to do anything a quick action can.
const COMMAND_LINE = /(^|[\r\n\v\f\u0085\u2028\u2029])[ \t]*\//;
const MAX_PATH = 8192;
const MAX_JSON_DEPTH = 64;

const approved = new WeakSet();

/// Whether `request` is an object `authorize` returned as allowed. `forge.perform` sends
/// nothing else.
export function authorized(request) {
  return approved.has(request);
}

class Refusal extends Error {}
const refuse = (reason) => { throw new Refusal(reason); };

// -------------------------------------------------------------------- strict JSON

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/// Parses JSON the way every parser agrees on, or throws: valid UTF-8 without a BOM, no
/// duplicate key in any object, no integer past the safe range, nothing after the value.
/// Objects come back without a prototype, so `__proto__` is a key like any other.
export function parseStrictJson(buffer) {
  let text;
  try { text = utf8.decode(buffer); } catch { throw new SyntaxError('not valid UTF-8'); }
  let i = 0;
  const fail = (what) => { throw new SyntaxError(`${what} at ${i}`); };
  const ws = () => { while (text[i] === ' ' || text[i] === '\t' || text[i] === '\n' || text[i] === '\r') i++; };
  function string() {
    let out = '';
    i++;
    for (;;) {
      const c = text[i];
      if (c === undefined) fail('unterminated string');
      if (c === '"') { i++; return out; }
      if (c < ' ') fail('control character in a string');
      if (c !== '\\') { out += c; i++; continue; }
      const e = text[i + 1];
      const simple = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' }[e];
      if (simple !== undefined) { out += simple; i += 2; continue; }
      const hex = text.slice(i + 2, i + 6);
      if (e !== 'u' || !/^[0-9A-Fa-f]{4}$/.test(hex)) fail('bad escape');
      out += String.fromCharCode(parseInt(hex, 16));
      i += 6;
    }
  }
  function value(depth) {
    if (depth > MAX_JSON_DEPTH) fail('nested too deeply');
    ws();
    const c = text[i];
    if (c === '{') {
      const out = Object.create(null);
      i++;
      ws();
      if (text[i] === '}') { i++; return out; }
      for (;;) {
        ws();
        if (text[i] !== '"') fail('expected a key');
        const key = string();
        if (Object.hasOwn(out, key)) fail(`duplicate key ${JSON.stringify(key)}`);
        ws();
        if (text[i] !== ':') fail('expected ":"');
        i++;
        out[key] = value(depth + 1);
        ws();
        if (text[i] === ',') { i++; continue; }
        if (text[i] === '}') { i++; return out; }
        fail('expected "," or "}"');
      }
    }
    if (c === '[') {
      const out = [];
      i++;
      ws();
      if (text[i] === ']') { i++; return out; }
      for (;;) {
        out.push(value(depth + 1));
        ws();
        if (text[i] === ',') { i++; continue; }
        if (text[i] === ']') { i++; return out; }
        fail('expected "," or "]"');
      }
    }
    if (c === '"') return string();
    for (const [word, v] of [['true', true], ['false', false], ['null', null]]) {
      if (text.startsWith(word, i)) { i += word.length; return v; }
    }
    const m = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?/.exec(text.slice(i, i + 400));
    if (!m) fail('unexpected character');
    const num = Number(m[0]);
    if (!Number.isFinite(num) || (!m[2] && !m[3] && !Number.isSafeInteger(num))) fail('number out of range');
    i += m[0].length;
    return num;
  }
  const out = value(0);
  ws();
  if (i !== text.length) fail('trailing data');
  return out;
}

// ------------------------------------------------------------------ normalisation

// Percent-decodes one path segment or query component, refusing an escape that is
// malformed or that hides a byte with a meaning of its own in a path.
function decode(raw, { plus, slash }) {
  const bytes = [];
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c === '+' && plus) { bytes.push(0x20); continue; }
    if (c !== '%') { bytes.push(c.charCodeAt(0)); continue; }
    const hex = raw.slice(i + 1, i + 3);
    if (!/^[0-9A-Fa-f]{2}$/.test(hex)) refuse('a malformed percent-escape');
    const byte = parseInt(hex, 16);
    if (byte < 0x20 || byte === 0x7f) refuse('an encoded control character');
    if (!plus) {
      if (byte === 0x2f && !slash) refuse('an encoded slash in the path');
      if (byte === 0x2e || byte === 0x5c || byte === 0x25) refuse('an encoded dot, backslash or percent sign in the path');
    }
    bytes.push(byte);
    i += 2;
  }
  try { return utf8.decode(Uint8Array.from(bytes)); } catch { return refuse('an escape that is not UTF-8'); }
}

function normalise(request) {
  if (request === null || typeof request !== 'object' || Array.isArray(request)) refuse('the request is not an object');
  const { host, method, path, headers = {}, body = '' } = request;
  if (typeof method !== 'string' || !METHODS.has(method.toUpperCase())) refuse('the method is not one a task may use');
  if (typeof host !== 'string' || host.length > 253 || !HOST.test(host.toLowerCase())) refuse('the host is not a plain host name');
  if (typeof path !== 'string' || path.length > MAX_PATH || path[0] !== '/') refuse('the path is not absolute');

  const cut = path.indexOf('?');
  const rawPath = cut === -1 ? path : path.slice(0, cut);
  const rawQuery = cut === -1 ? null : path.slice(cut + 1);
  if (!PATH_CHARS.test(rawPath)) refuse('the path holds a character that must be encoded, a fragment or a ";"');
  const raw = rawPath.slice(1).split('/');
  // The one place a forge defines an encoded slash: GitLab names a project by its
  // URL-encoded path, as the single segment after /api/v4/projects/.
  const gitlabProject = raw[0] === 'api' && raw[1] === 'v4' && raw[2] === 'projects';
  raw.forEach((segment, i) => {
    if (segment === '') refuse('the path has an empty segment');
    if (segment === '.' || segment === '..') refuse('the path has a dot segment');
    decode(segment, { slash: gitlabProject && i === 3 });
  });

  const query = [];
  if (rawQuery !== null && rawQuery !== '') {
    if (!QUERY_CHARS.test(rawQuery)) refuse('the query holds a character that must be encoded, a fragment or a ";"');
    for (const piece of rawQuery.split('&')) {
      const eq = piece.indexOf('=');
      const name = decode(eq === -1 ? piece : piece.slice(0, eq), { plus: true });
      if (name === '') refuse('the query has an empty parameter');
      query.push([name, eq === -1 ? '' : decode(piece.slice(eq + 1), { plus: true })]);
    }
  }

  if (headers === null || typeof headers !== 'object' || Array.isArray(headers)) refuse('the headers are not an object');
  const lower = Object.create(null);
  for (const [name, value] of Object.entries(headers)) {
    if (!HEADER_NAME.test(name) || typeof value !== 'string' || /[\r\n\0]/.test(value)) refuse('a malformed header');
    const key = name.toLowerCase();
    if (Object.hasOwn(lower, key)) refuse(`the header "${key}" is given twice`);
    lower[key] = value;
  }

  if (typeof body !== 'string' || body.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(body)) refuse('the body is not base64');
  return {
    host: host.toLowerCase(), method: method.toUpperCase(), rawPath, rawQuery, segments: raw, query,
    headers: lower, body: Buffer.from(body, 'base64'),
  };
}

// ----------------------------------------------------------------------- matching

// A rule's path against a request's: literal segments, "*" for exactly one, a trailing
// "**" for any remainder. `fold` lists the segments compared without regard to case - the
// ones that name the repository, which both forges resolve that way. Any other literal
// must equal the segment as sent, so a segment spelled with an escape matches none.
function pathMatches(rule, segments) {
  const pattern = rule.path.slice(1).split('/');
  const fold = rule.fold || [];
  for (let i = 0; i < pattern.length; i++) {
    const want = pattern[i];
    if (want === '**' && i === pattern.length - 1) return true;
    const got = segments[i];
    if (got === undefined) return false;
    if (want === '*') continue;
    if (fold.includes(i) ? got.toLowerCase() !== want.toLowerCase() : got !== want) return false;
  }
  return segments.length === pattern.length;
}

const sameJson = (a, b, fold) => {
  const text = (v) => (fold ? JSON.stringify(v).toLowerCase() : JSON.stringify(v));
  return a !== undefined && text(a) === text(b);
};

function checkQuery(rule, req) {
  const pins = rule.query || {};
  const seen = new Set();
  for (const [name, value] of req.query) {
    const base = name.split('[')[0];
    if (DENIED_QUERY.has(base.toLowerCase())) refuse(`the query parameter "${base}" is never allowed`);
    const pin = Object.hasOwn(pins, base) ? pins[base] : undefined;
    if (pin === undefined) {
      // A forge may read a write's parameters from the query as readily as from the
      // body, so on a write an unnamed parameter would step around every body pin.
      if (req.method !== 'GET') refuse(`the query parameter "${base}" is not part of this rule`);
      continue;
    }
    if (name !== base || seen.has(base)) refuse(`the query parameter "${base}" must be given once, plainly`);
    seen.add(base);
    if (pin.equals !== undefined && value !== pin.equals) refuse(`the query parameter "${base}" must be "${pin.equals}"`);
    if (pin.oneOf && !pin.oneOf.includes(value)) refuse(`the query parameter "${base}" has a value this task may not use`);
    if (pin.search !== undefined) {
      const why = searchConfined(value, pin.search);
      if (why) refuse(why);
    }
  }
  for (const [name, pin] of Object.entries(pins)) {
    if (!pin.optional && !seen.has(name)) refuse(`the query parameter "${name}" is required`);
  }
}

function jsonBody(req) {
  if (!JSON_TYPE.test(req.headers['content-type'] || '')) refuse('the body must be sent as application/json');
  try { return parseStrictJson(req.body); } catch (err) { return refuse(`the body is not strict JSON: ${err.message}`); }
}

async function checkBodyPins(spec, req, ctx, effects) {
  const body = req.body.length === 0 ? Object.create(null) : jsonBody(req);
  if (body === null || typeof body !== 'object' || Array.isArray(body)) refuse('the body is not a JSON object');
  for (const [key, value] of Object.entries(body)) {
    const pin = Object.hasOwn(spec, key) ? spec[key] : undefined;
    if (pin === undefined) refuse(`the body member "${key}" is not part of this rule`);
    if (pin === 'free') continue;
    if (pin.equals !== undefined && !sameJson(value, pin.equals, pin.fold)) refuse(`the body member "${key}" has a value this task may not use`);
    if (pin.oneOf && !pin.oneOf.some((allowed) => sameJson(value, allowed, pin.fold))) refuse(`the body member "${key}" has a value this task may not use`);
    if (pin.prefix !== undefined && !(typeof value === 'string' && value.startsWith(pin.prefix))) refuse(`the body member "${key}" must start with "${pin.prefix}"`);
    if (pin.prose && !(typeof value === 'string' && !COMMAND_LINE.test(value))) refuse(`the body member "${key}" has a line starting with "/", which the forge would run as a command`);
    if (pin.created) effects.push({ pull: value });
    if (pin.self) {
      if (typeof ctx.self !== 'function') refuse('nothing here can tell which account this task acts as');
      const me = await ctx.self();
      const ids = Array.isArray(value) ? value : [value];
      // 0 is how glab spells "nobody".
      if (!me || ids.some((id) => id !== me.id && id !== 0)) refuse(`the body member "${key}" may only name this task's own account`);
    }
  }
  for (const [key, pin] of Object.entries(spec)) {
    if (pin !== 'free' && pin.required && !Object.hasOwn(body, key)) refuse(`the body member "${key}" is required`);
  }
  return req.body.length === 0 ? req.body : Buffer.from(JSON.stringify(body));
}

const NUMBER = /^[1-9][0-9]{0,15}$/;
function numberAt(req, index) {
  const segment = req.segments[index];
  if (!segment || !NUMBER.test(segment)) refuse('the path does not name an object by number');
  return Number(segment);
}

const lower = (s) => String(s ?? '').toLowerCase();

// A pull request named by number in the path, for a task that covers every open one by
// (or not by) some author instead of one number.
async function checkPull(spec, req, ctx) {
  if (typeof ctx.pull !== 'function') refuse('nothing here can look a pull request up');
  const number = numberAt(req, spec.segment);
  const pull = await ctx.pull(number);
  if (!pull) refuse(`#${number} is not a pull request the forge would show`);
  if (pull.open !== true) refuse(`#${number} is not open`);
  if (spec.author !== undefined && lower(pull.author) !== spec.author) refuse(`#${number} was not opened by ${spec.author}`);
  if (spec.notAuthor !== undefined && lower(pull.author) === spec.notAuthor) refuse(`#${number} was opened by ${spec.notAuthor}`);
}

// A review comment named by id in the path: the forge is asked which pull request it is
// on, who wrote it and whether its review is still pending.
async function checkComment(spec, req, ctx) {
  if (typeof ctx.comment !== 'function') refuse('nothing here can look a comment up');
  const id = numberAt(req, spec.segment);
  const comment = await ctx.comment(id);
  if (!comment) refuse(`comment ${id} is not one the forge would show`);
  if (lower(comment.repo) !== lower(spec.repo)) refuse(`comment ${id} is not in the pool's repository`);
  if (spec.pullSegment !== undefined && comment.number !== numberAt(req, spec.pullSegment)) refuse(`comment ${id} is not on the pull request the path names`);
  const why = itemMismatch(spec.item, comment);
  if (why) refuse(`comment ${id}: ${why}`);
  if (spec.own && lower(comment.author) !== lower(spec.identity)) refuse(`comment ${id} was not written by this task's account`);
  if (spec.pending && comment.pending !== true) refuse(`comment ${id} is not part of a pending review`);
}

// Applies what an allowed request uses up to the key's state. Runs after the last await,
// so two requests racing for the last free branch cannot both take it.
function settle(rule, effects, ctx) {
  if (effects.length === 0) return;
  const state = ctx.state;
  if (!state || typeof state !== 'object') refuse('this rule needs the key\'s state, and none was given');
  state.branches ||= [];
  const fresh = [];
  for (const effect of effects) {
    if (effect.branch !== undefined && !state.branches.includes(effect.branch) && !fresh.includes(effect.branch)) fresh.push(effect.branch);
    if (effect.pull !== undefined && !(typeof effect.pull === 'string' && state.branches.includes(`refs/heads/${effect.pull}`))) {
      refuse('a pull request may only be opened from a branch this task pushed');
    }
  }
  if (fresh.length > 0 && state.branches.length + fresh.length > rule.create) refuse(`this task may create ${rule.create} branch(es) and no more`);
  state.branches.push(...fresh);
}

/// Decides one request against a task's rules. `request` is `{ host, method, path,
/// headers, body }` as the executor sent it (path with its query, body base64). `ctx`
/// carries what the deep checks ask the forge and the machine: `resolveNode(id)`,
/// `pull(number)`, `pullsByHead({ repo, ref })`, `comment(id)`, `assignees(number)`,
/// `self()`, `currentRef`, `fetch`, `checkout` and the key's mutable `state`
/// (`forge.context()` builds one).
/// Resolves to `{ ok: true, rule, request }` - `request` is the one to perform, in the
/// single spelling that was checked - or `{ ok: false, reason }`.
export async function authorize(rules, request, ctx = {}) {
  try {
    const req = normalise(request);
    const rule = (Array.isArray(rules) ? rules : []).find((r) => r.host === req.host && r.method === req.method && pathMatches(r, req.segments));
    if (!rule) refuse('no rule of this task allows the request');
    checkQuery(rule, req);
    const encoding = lower(req.headers['content-encoding']);
    if (req.body.length > 0 && encoding !== '' && encoding !== 'identity') refuse('an encoded body cannot be checked');

    const effects = [];
    let body = req.body;
    if (rule.pull) await checkPull(rule.pull, req, ctx);
    if (rule.comment) await checkComment(rule.comment, req, ctx);
    if (rule.git && req.method === 'GET') {
      if (body.length > 0) refuse('a read carries no body');
      const verdict = await checkAdvertise(rule, req.segments, ctx);
      if (!verdict.ok) refuse(verdict.reason);
    } else if (rule.git) {
      if (req.headers['content-type'] !== RECEIVE_PACK_TYPE) refuse(`a push must be sent as ${RECEIVE_PACK_TYPE}`);
      const verdict = await checkPush(rule, req.segments, body, ctx);
      if (!verdict.ok) refuse(verdict.reason);
      for (const branch of verdict.created) effects.push({ branch });
    } else if (rule.graphql) {
      if (req.method !== 'POST') refuse('a GraphQL request is a POST');
      const payload = jsonBody(req);
      const verdict = await checkGraphql(rule.graphql, payload, ctx);
      if (!verdict.ok) refuse(verdict.reason);
      effects.push(...verdict.effects);
      body = Buffer.from(JSON.stringify(payload));
    } else if (rule.body) {
      body = await checkBodyPins(rule.body, req, ctx, effects);
    } else if (body.length > 0) {
      refuse('this rule allows no body');
    }
    settle(rule, effects, ctx);

    const out = {
      host: req.host,
      method: req.method,
      path: req.rawQuery === null ? req.rawPath : `${req.rawPath}?${req.rawQuery}`,
      headers: { ...req.headers },
      body: body.toString('base64'),
    };
    if (rule.pick) out.pick = rule.pick;
    approved.add(out);
    return { ok: true, rule, request: out };
  } catch (err) {
    if (err instanceof Refusal) return { ok: false, reason: err.message };
    throw err;
  }
}
