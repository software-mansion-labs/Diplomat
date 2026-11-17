// Decides whether one forge request from an executor is inside its task's rules
// (PROTOCOL.md sections 9 and 10). The executor is not trusted: everything here assumes
// the request was written by someone trying to reach past the rules.
//
// A request is first brought to one spelling, and refused when it has more than one
// reading: the forge, a proxy in front of it and this file must all see the same path,
// the same query and the same body. Then the first rule whose host, method and path match
// decides, alone - its pins and deep checks are not retried against a later rule. What
// matches nothing is refused.

import { checkGraphql, itemMismatch, sameButSelf, searchConfined } from './graphql.js';
import { branchLabel, checkAdvertise, checkFork, checkPush, pushReport } from './receivepack.js';

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
// The members of a rule that decides by its path and nothing else.
const BY_PATH_ALONE = new Set(['host', 'method', 'path', 'fold']);
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
// malformed or that hides a byte with a meaning of its own in a path. A path may not
// escape what needs no escape either: a forge's router reads "%63ompare" as "compare", so
// with such escapes refused a route's name has the one spelling the rules are written in.
// `name` is set for a segment in which GitLab defines an encoded slash and dot.
const NEEDS_NO_ESCAPE = /[A-Za-z0-9_~-]/;
function decode(raw, { plus, name }) {
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
      if (byte === 0x2f && !name) refuse('an encoded slash in the path');
      if ((byte === 0x2e && !name) || byte === 0x5c || byte === 0x25 || byte === 0x3b) refuse('an encoded dot, backslash, percent sign or semicolon in the path');
      if (NEEDS_NO_ESCAPE.test(String.fromCharCode(byte))) refuse('an escape of a letter, a digit, "-", "_" or "~" in the path');
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
  // GitLab takes a name as one segment, its slashes encoded, and glab encodes the name's
  // dots as well: the project's path after /api/v4/projects/, and in a read under it a
  // file's path, a branch's or a tag's name. GitLab's router matches the route before it
  // decodes a slash, so that one separates nothing; an encoded dot it reads as a dot.
  const gitlabProject = raw[0] === 'api' && raw[1] === 'v4' && raw[2] === 'projects';
  const read = (i) => gitlabProject && i > 3 && method.toUpperCase() === 'GET';
  const decoded = raw.map((segment, i) => {
    const parts = decode(segment, { name: (gitlabProject && i === 3) || read(i) }).split('/');
    if (parts.includes('')) refuse('the path has an empty segment');
    if (parts.includes('.') || parts.includes('..')) refuse('the path has a dot segment');
    return parts.join('/');
  });
  const segments = raw.map((segment) => segment.replace(/%2e/gi, '.'));
  // The path as whatever decodes a slash before routing it would cut it up.
  const apart = segments.flatMap((segment, i) => (read(i) ? segment.split(/%2f/i) : [segment]));

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
    host: host.toLowerCase(), method: method.toUpperCase(), rawPath, rawQuery, segments, apart, decoded, query,
    headers: lower, body: Buffer.from(body, 'base64'),
  };
}

// ----------------------------------------------------------------------- matching

// A rule's path against a request's: literal segments, "*" for exactly one, a trailing
// "**" for any remainder. `fold` lists the segments compared without regard to case - the
// ones that name the repository, which both forges resolve that way; any other literal
// must equal the segment as sent, an encoded dot read as a dot. `loose` is the widest
// reading a forge's router could give the path: no literal's case counts, and a segment
// may carry an extension ("compare.json"), which GitLab's router takes off as the
// answer's format.
function pathMatches(rule, segments, loose) {
  const pattern = rule.path.slice(1).split('/');
  const fold = rule.fold || [];
  for (let i = 0; i < pattern.length; i++) {
    const want = pattern[i];
    if (want === '**' && i === pattern.length - 1) return true;
    const got = segments[i];
    if (got === undefined) return false;
    if (want === '*') continue;
    const [g, w] = loose || fold.includes(i) ? [got.toLowerCase(), want.toLowerCase()] : [got, want];
    if (g !== w && !(loose && g.startsWith(`${w}.`))) return false;
  }
  return segments.length === pattern.length;
}

const sameJson = (a, b, fold) => {
  const text = (v) => (fold ? JSON.stringify(v).toLowerCase() : JSON.stringify(v));
  return a !== undefined && text(a) === text(b);
};

// Checks the query against the rule's pins and returns the names of the pinned
// parameters the request gave.
function checkQuery(rule, req) {
  const pins = rule.query || {};
  const seen = new Set();
  for (const [name, value] of req.query) {
    const base = name.split('[')[0];
    if (DENIED_QUERY.has(base.toLowerCase())) refuse(`the query parameter "${base}" is never allowed`);
    const pin = Object.hasOwn(pins, base) ? pins[base] : undefined;
    if (pin === undefined) {
      // A forge may read a write's parameters from the query as readily as from the
      // body, so on a write an unnamed parameter would step around every body pin. A read
      // whose rule names its parameters takes those alone: one more can point it at
      // another repository.
      if (req.method !== 'GET' || rule.query) refuse(`the query parameter "${base}" is not part of this rule`);
      continue;
    }
    if (pin === 'free') continue;
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
    if (pin !== 'free' && !pin.optional && !seen.has(name)) refuse(`the query parameter "${name}" is required`);
  }
  return seen;
}

function jsonBody(req) {
  if (!JSON_TYPE.test(req.headers['content-type'] || '')) refuse('the body must be sent as application/json');
  try { return parseStrictJson(req.body); } catch (err) { return refuse(`the body is not strict JSON: ${err.message}`); }
}

// `given` names the pinned query parameters the request carries: a forge reads a member
// from either place, so a required one may come as the parameter of the same name.
// `fork` is the fork the request's path names, when its rule has one checked.
async function checkBodyPins(spec, req, ctx, effects, given, fork) {
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
    if (pin.created) effects.push(pin.created === 'label' ? { head: value } : { pull: value, fork });
    if (pin.assignees !== undefined) {
      if (typeof ctx.self !== 'function' || typeof ctx.assignees !== 'function') refuse('nothing here can tell who is assigned, or which account this task acts as');
      // The whole new list, as account ids. A lone 0 is how glab spells "nobody"; beside
      // other ids the forge's reading of it is not written down.
      const nobody = Array.isArray(value) && value.length === 1 && value[0] === 0;
      if (!Array.isArray(value) || (!nobody && value.some((id) => !Number.isSafeInteger(id) || id <= 0))) refuse(`the body member "${key}" is not a list of account ids`);
      const me = await ctx.self();
      const held = await ctx.assignees(pin.assignees);
      if (!held) refuse(`#${pin.assignees} is not an issue the forge would show`);
      if (!sameButSelf(held, nobody ? [] : value, me.id)) refuse(`the body member "${key}" may only add or remove this task's own account`);
    }
  }
  for (const [key, pin] of Object.entries(spec)) {
    if (pin !== 'free' && pin.required && !Object.hasOwn(body, key) && !given.has(key)) refuse(`the body member "${key}" is required`);
  }
  return req.body.length === 0 ? req.body : Buffer.from(JSON.stringify(body));
}

const NUMBER = /^[1-9][0-9]{0,15}$/;
function numberAt(req, index) {
  const segment = req.segments[index];
  // A number past the safe range would be looked up as another one than the path names.
  if (!segment || !NUMBER.test(segment) || !Number.isSafeInteger(Number(segment))) refuse('the path does not name an object by number');
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

// A CI run named in the path by its id or by the id of one of its jobs: the forge is
// asked which branch it ran for, and that must be a branch this task works on.
async function checkRun(spec, req, ctx) {
  if (typeof ctx.run !== 'function') refuse('nothing here can look a CI run up');
  const id = numberAt(req, spec.segment);
  const run = await ctx.run(spec.what, id);
  if (!run) refuse(`CI ${spec.what} ${id} is not one the forge would show for a branch`);
  const here = lower(run.repo) === lower(spec.repo);
  if ((ctx.state?.branches ?? []).includes(branchLabel(run.ref, here ? undefined : run.repo))) return;
  if (spec.base && here && run.ref === `refs/heads/${(await ctx.repository()).defaultBranch}`) return;
  if (spec.head) {
    const branch = run.ref.slice('refs/heads/'.length);
    const pulls = spec.head.number === undefined ? await ctx.pullsByHead(branch, run.repo.split('/')[0]) : [await ctx.pull(spec.head.number)];
    const { author, notAuthor } = spec.head;
    const covered = (pull) => pull && lower(pull.headRepo) === lower(run.repo) && pull.headRef === branch && (run.pull ?? pull.number) === pull.number
      && (author === undefined || lower(pull.author) === author) && lower(pull.author) !== notAuthor;
    if (pulls.some(covered)) return;
  }
  refuse(`CI ${spec.what} ${id} ran for a branch this task does not work on`);
}

// A project named in the path that must be the task account's own fork of the pool's;
// returns its name.
async function checkProject(spec, req, ctx) {
  const verdict = await checkFork(req.decoded[spec.segment], spec.owner, spec.repo, ctx);
  if (!verdict.ok) refuse(verdict.reason);
  return verdict.fork.name;
}

// What a task has used of its allowances, in `ctx.state`:
//   branches  the branches the forge accepted from it: its own, which it may move
//   reserved  branches whose creation was sent and whose answer is not known: counted
//             against `create`, and not its own
//   sent      the commit each of `reserved` was sent at
//   pulls     the branches the forge opened its pull request from
//   asked     the branches a pull request was sent for, its answer not known
// A branch is named by its ref, one in a fork as "<repository>:<ref>" (`branchLabel`);
// `pulls` and `asked` name it the same way without "refs/heads/".
const pending = new WeakMap(); // an approved request -> what it holds of the task's state
const flying = new WeakMap(); // a task's state -> what the requests not yet concluded hold of it

// The name in `branches` of the branch a pull request would be opened from. GitHub's
// `head` is "branch", or "account:branch" for a branch of that account's fork of the
// repository; elsewhere the branch comes plain, beside the fork it is in.
function headLabel(effect, branches) {
  if (effect.head === undefined) return typeof effect.pull === 'string' ? branchLabel(`refs/heads/${effect.pull}`, effect.fork) : undefined;
  const parts = typeof effect.head === 'string' ? effect.head.split(':') : [];
  if (parts.length === 1) return `refs/heads/${parts[0]}`;
  if (parts.length !== 2) return undefined;
  return branches.find((label) => label.endsWith(`:refs/heads/${parts[1]}`) && label.split('/')[0] === parts[0].toLowerCase());
}

const drop = (list, items) => { for (const item of items) if (list.includes(item)) list.splice(list.indexOf(item), 1); };

// The task's state with every member there, or null where the caller gave none.
function stateOf(ctx) {
  const { state } = ctx;
  if (!state || typeof state !== 'object') return null;
  for (const list of ['branches', 'reserved', 'pulls', 'asked']) state[list] ||= [];
  state.sent ||= {};
  return state;
}

// A creation whose answer never came may have happened, and the forge knows. It is asked
// once the request is over, before the task's next push or pull request is judged. A
// branch the forge does not have is given back to the allowance, one it has at the commit
// that was sent is the task's own, one it has at another commit stays counted. A pull
// request the forge shows from the branch, open or not, is the task's one (`pulls` set),
// and none shown gives it back.
async function recall(ctx, pulls) {
  const state = stateOf(ctx);
  if (!state) return;
  const over = (list) => (name) => ![...(flying.get(state) ?? [])].some((held) => held[list].includes(name));
  for (const label of state.reserved.filter(over('branches'))) {
    if (typeof ctx.branch !== 'function') refuse('nothing here can ask the forge about its branches');
    const cut = label.indexOf(':');
    const now = await ctx.branch(label.slice(cut + 1), cut < 0 ? undefined : label.slice(0, cut));
    // An answer that came back after another request sent the creation again is too old to use.
    if (!over('branches')(label) || (now !== null && now.sha !== state.sent[label])) continue;
    drop(state.reserved, [label]);
    delete state.sent[label];
    if (now !== null) state.branches.push(label);
  }
  for (const from of (pulls ? state.asked : []).filter(over('pulls'))) {
    if (typeof ctx.pullsByHead !== 'function') refuse('nothing here can look a pull request up');
    const cut = from.indexOf(':');
    const shown = await ctx.pullsByHead(from.slice(cut + 1), cut < 0 ? undefined : from.split('/')[0], true);
    if (!state.asked.includes(from) || !over('pulls')(from)) continue;
    drop(state.asked, [from]);
    if (shown.length > 0) state.pulls.push(from);
  }
}

// Counts what an allowed request would use up, before it is sent. Runs after the last
// await, so two requests racing for the last free branch cannot both take it.
function settle(rule, effects, ctx) {
  if (effects.length === 0) return null;
  const state = stateOf(ctx) ?? refuse('this rule needs the task\'s state, and none was given');
  const held = { state, branches: [], pulls: [], graphql: Boolean(rule.graphql) };
  const tips = {};
  for (const effect of effects) {
    if (effect.branch !== undefined) {
      if (!held.branches.includes(effect.branch)) held.branches.push(effect.branch);
      tips[effect.branch] = effect.sha;
    } else {
      const label = headLabel(effect, state.branches);
      if (!state.branches.includes(label)) refuse('a pull request may only be opened from a branch this task pushed');
      const from = label.replace('refs/heads/', '');
      if (state.pulls.includes(from) || held.pulls.includes(from)) refuse(`this task has opened its pull request from ${from}`);
      if (state.asked.includes(from)) refuse(`this task's pull request from ${from} is on its way to the forge`);
      held.pulls.push(from);
    }
  }
  // A creation sent again is the one already counted.
  held.fresh = held.branches.filter((ref) => !state.branches.includes(ref) && !state.reserved.includes(ref));
  const has = [...state.branches, ...state.reserved];
  if (held.fresh.length > 0 && has.length + held.fresh.length > rule.create) refuse(`this task may create ${rule.create} branch(es); it has ${has.join(', ') || 'none'}`);
  state.reserved.push(...held.fresh);
  for (const label of held.fresh) state.sent[label] = tips[label];
  state.asked.push(...held.pulls);
  if (!flying.has(state)) flying.set(state, new Set());
  flying.get(state).add(held);
  return held;
}

/// Tells the task's state what became of a request `authorize` allowed: `answer` is the
/// forge's `{ status, body }` (`body` a Buffer), or undefined when no answer came or the
/// request was never sent. A branch is the task's own once the forge's report says "ok"
/// for it, a pull request its one once the forge answers that it opened it; what the forge
/// refused is given back to the allowance. Anything else stays counted, and not owned,
/// until the forge is asked what became of it. Every allowed request is concluded: one
/// that is not counts as still on its way.
export function conclude(request, answer) {
  const held = pending.get(request);
  if (!held) return;
  pending.delete(request);
  const { state } = held;
  flying.get(state).delete(held);
  const refused = answer !== undefined && answer.status >= 400 && answer.status < 500;
  if (held.branches.length > 0) {
    const report = answer?.status === 200 ? pushReport(answer.body) : null;
    // The forge reports a ref by its name alone, in whichever repository the push went to.
    const ref = (label) => label.slice(label.indexOf(':') + 1);
    const accepted = held.branches.filter((label) => report?.ok.includes(ref(label)));
    // Only what this request counted is given back: a creation sent before, whose answer
    // never came, may be why the forge declines this one.
    const settled = [...accepted, ...held.fresh.filter((label) => refused || report?.ng.includes(ref(label)))];
    drop(state.reserved, settled);
    for (const label of settled) delete state.sent[label];
    for (const label of accepted) if (!state.branches.includes(label)) state.branches.push(label);
  }
  if (held.pulls.length > 0) {
    let opened = refused ? false : answer !== undefined && answer.status >= 200 && answer.status < 300 ? true : undefined;
    if (opened && held.graphql) {
      // GraphQL words a refusal as 200 with an error list and nothing where the pull request would be.
      let said = null;
      try { said = JSON.parse(answer.body.toString('utf8')); } catch {}
      const results = Object.values(said?.data ?? {});
      const errors = Array.isArray(said?.errors) && said.errors.length > 0;
      opened = errors ? (results.every((v) => v === null) ? false : undefined) : results.length > 0 && results.every((v) => v !== null) ? true : undefined;
    }
    if (opened !== undefined) drop(state.asked, held.pulls);
    if (opened) state.pulls.push(...held.pulls);
  }
}

// A lookup that fails has answered nothing, and nothing is never permission: its failure
// is the refusal, with the lookup's own words as the reason.
function asking(ctx) {
  const out = {};
  for (const [key, value] of Object.entries(ctx)) {
    out[key] = typeof value !== 'function' ? value : async (...args) => {
      try { return await value.apply(ctx, args); } catch (err) { return refuse(String(err?.message ?? err).replace(/^forge: /, '')); }
    };
  }
  return out;
}

/// Decides one request against a task's rules. `request` is `{ host, method, path,
/// headers, body }` as the executor sent it (path with its query, body base64). `given`
/// carries what the deep checks ask the forge and the machine: `resolveNode(id)`,
/// `pull(number)`, `pullsByHead(ref, owner, ever)`, `comment(id)`, `assignees(number)`, `self()`,
/// `repository(repo)`, `branch(ref, repo)`, `fetch`, `checkout` and the task's mutable
/// `state` (`forge.context()` builds one). A lookup that throws refuses the request.
/// Resolves to `{ ok: true, rule, request }` - `request` is the one to perform, in the
/// single spelling that was checked - or `{ ok: false, reason }`. What an allowed request
/// would use up is counted in `state` at once; `conclude` settles it with the forge's answer.
export async function authorize(rules, request, given = {}) {
  try {
    const ctx = asking(given);
    const req = normalise(request);
    const list = Array.isArray(rules) ? rules : [];
    const first = (segments, loose) => list.find((r) => r.host === req.host && r.method === req.method && pathMatches(r, segments, loose));
    const rule = first(req.segments, false);
    if (!rule) refuse('no rule of this task allows the request');
    // A rule that refuses a route or pins its parameters stands before the wider rule
    // around it. A spelling the forge could still resolve to that route must not slip
    // past it into the wider one.
    if (first(req.segments, true) !== rule) refuse('the path could be read as a route another rule of this task decides: only a letter\'s case or an extension sets it apart');
    if (rule.deny !== undefined) refuse(rule.deny);
    // Nor may the path become a route no rule knows, or one whose rule holds a check this
    // request is not put through, where a proxy decodes an encoded slash before the forge
    // routes the request.
    const cut = first(req.apart, true);
    if (cut !== rule && !(cut && Object.keys(cut).every((key) => BY_PATH_ALONE.has(key)))) refuse('the path, with its encoded slash read as a separator, is a route this task\'s rules decide otherwise');
    for (const [mark, why] of Object.entries(rule.without || {})) if (req.decoded.some((segment) => segment.includes(mark))) refuse(why);
    const named = checkQuery(rule, req);
    const encoding = lower(req.headers['content-encoding']);
    if (req.body.length > 0 && encoding !== '' && encoding !== 'identity') refuse('an encoded body cannot be checked');

    const effects = [];
    let body = req.body;
    if (rule.pull) await checkPull(rule.pull, req, ctx);
    if (rule.comment) await checkComment(rule.comment, req, ctx);
    if (rule.run) await checkRun(rule.run, req, ctx);
    const fork = rule.project ? await checkProject(rule.project, req, ctx) : undefined;
    if (rule.git && req.method === 'GET') {
      if (body.length > 0) refuse('a read carries no body');
      const verdict = await checkAdvertise(rule, req.segments, ctx);
      if (!verdict.ok) refuse(verdict.reason);
    } else if (rule.git) {
      if (req.headers['content-type'] !== RECEIVE_PACK_TYPE) refuse(`a push must be sent as ${RECEIVE_PACK_TYPE}`);
      await recall(ctx, false);
      const verdict = await checkPush(rule, req.segments, body, ctx);
      if (!verdict.ok) refuse(verdict.reason);
      effects.push(...verdict.created);
    } else if (rule.graphql) {
      if (req.method !== 'POST') refuse('a GraphQL request is a POST');
      const payload = jsonBody(req);
      const verdict = await checkGraphql(rule.graphql, payload, ctx);
      if (!verdict.ok) refuse(verdict.reason);
      effects.push(...verdict.effects);
      body = Buffer.from(JSON.stringify(payload));
    } else if (rule.body) {
      body = await checkBodyPins(rule.body, req, ctx, effects, named, fork);
    } else if (body.length > 0) {
      refuse('this rule allows no body');
    }
    if (effects.some((effect) => effect.branch === undefined)) await recall(ctx, true);
    const held = settle(rule, effects, ctx);

    const out = {
      host: req.host,
      method: req.method,
      path: req.rawQuery === null ? req.rawPath : `${req.rawPath}?${req.rawQuery}`,
      headers: { ...req.headers },
      body: body.toString('base64'),
    };
    if (rule.pick) out.pick = rule.pick;
    approved.add(out);
    if (held) pending.set(out, held);
    return { ok: true, rule, request: out };
  } catch (err) {
    if (err instanceof Refusal) return { ok: false, reason: err.message };
    throw err;
  }
}
