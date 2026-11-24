// What policy-bot (palantir/policy-bot, read at v1.42.1), a GitHub App that gates merging,
// takes from text for an approval. Its rules count whoever wrote a matching pull request
// comment or COMMENT review as approving (or disapproving, or taking a disapproval back),
// and a pull request's author by its body: a `comments` string anywhere in the text, a
// `comment_patterns` or `github_review_comment_patterns` match, a `body_patterns` match of
// the body (policy/common/methods.go). Unless a policy says otherwise the strings are
// ":+1:" and "👍" for an approval and ":-1:" and "👎" for a disapproval (approval/options.go,
// disapproval/disapprove.go). Text in the requester's name is checked against both. A
// server's own settings and other bots that read comments are not seen.
//
// A policy is a YAML file of at most 256 KiB, read here by a reader of its own: block and
// flow collections, the three scalar styles, block scalars, anchors and aliases. Its
// patterns are Go regular expressions, matched by an engine of their own that reads Go's
// syntax and takes time linear in the text, as Go's does; a policy's strings and patterns
// are matched as one program, in one pass. Reading and compiling take time linear in the
// file, within bounds on what its aliases and its patterns come to. What either cannot read
// is a policy this cannot check text against, and text is refused on its repository; so is
// text that takes too long to check.

import { foldsOf, holds, tableFrom, unicodeClass } from './unicode.js';

const WORDS = [':+1:', '👍', ':-1:', '👎'];
const MAX_POLICY = 256 * 1024;

/// Why `text`, posted as a comment or a review in the requester's name, would count as its
/// approval or disapproval under policy-bot's defaults, or null when it would not.
export function approvalFault(text) {
  const word = WORDS.find((w) => text.includes(w));
  return word === undefined ? null : `holds ${JSON.stringify(word)}, which policy-bot, a bot that gates merging, counts as an approval or a disapproval from whoever wrote it: text in the requester's name holds no ":+1:", "👍", ":-1:" or "👎" (say it in words); reword it and send the request again`;
}

/// Why `text` may not go on a pull request into the branch `base` under the pool
/// repository's policy, which `ctx.policy(base)` reads (`forge.context()`), or null when it
/// may. `kind` is "comment" for a comment or a review, "body" for the body it opens with.
export async function textFault(ctx, base, text, kind) {
  if (typeof ctx.policy !== 'function') return 'cannot be checked: nothing here reads the pool repository\'s policy-bot policy';
  if (typeof base !== 'string' || base === '') return 'cannot be checked against policy-bot: the pull request names no base branch';
  const policy = await ctx.policy(base);
  if (policy === null) return null;
  if (policy.fault) return `cannot be checked against the pool repository's policy-bot policy, so no text is sent on its pull requests: ${policy.fault}`;
  return policyFault(text, kind, policy);
}

function policyFault(text, kind, policy) {
  const union = unionOf(policy, kind);
  // Each character costs one: more than the budget leaves past setup are refused unread.
  const cps = codePoints(text, BUDGET - union.size);
  const found = cps && search(union, cps, BUDGET);
  if (found === null) return `is too long for this to check in time against the patterns of the pool repository's policy-bot policy (${policy.from.join(', ')}): shorten it and send the request again`;
  return found < 0 ? null : `${union.said[found]}, which the pool repository's policy-bot policy (${policy.from.join(', ')}) counts as an approval or a disapproval from whoever wrote it: reword it and send the request again`;
}

const LISTS = { comments: 'comments', comment_patterns: 'patterns', github_review_comment_patterns: 'patterns', body_patterns: 'bodies' };
// The most a policy file may hold once its aliases are read in, each alias as a copy of what
// it names: nodes, a key among them, and characters of its scalars. No file without aliases
// comes near either.
const MAX_NODES = 250_000;
const MAX_TEXT = 16 * MAX_POLICY;
// The most its distinct patterns may compile to in all (`goPattern`'s `cost`). Its distinct
// strings hold no more characters in all than it has bytes.
const MAX_STEPS = 100_000;

/// What a policy file holds: `{ remote: { repo, path, ref } }` for one that names a policy in
/// another repository (`path` and `ref` '' where it names none), else `{ comments, patterns,
/// bodies }` - every text-matching method of the file, wherever it stands, with each
/// pattern as `{ source, program }`, each text and pattern once. Throws, saying why, for a
/// file this cannot read, among them one larger than the bounds above.
export function readPolicy(text) {
  const bytes = Buffer.byteLength(text);
  if (bytes > MAX_POLICY) throw new Error(`it is ${bytes} bytes long, more than the ${MAX_POLICY} this reads`);
  const doc = parseYaml(text);
  // go-githubapp reads a file of these members only, `remote` among them, as a reference.
  if (doc instanceof Map && doc.has('remote') && doc.get('remote') !== null && [...doc.keys()].every((k) => ['remote', 'path', 'ref'].includes(k))) {
    const [repo, path, ref] = ['remote', 'path', 'ref'].map((k) => doc.get(k) ?? '');
    if (![repo, path, ref].every((v) => typeof v === 'string') || repo === '') throw new Error('it names its remote policy in a form policy-bot does not read');
    return { remote: { repo, path, ref } };
  }
  const out = { comments: new Set(), patterns: new Map(), bodies: new Map() };
  const compiled = new Map();
  let [nodes, chars, steps] = [0, 0, 0];
  const compile = (source) => {
    if (!compiled.has(source)) {
      const program = goPattern(source);
      steps += program.cost;
      if (steps > MAX_STEPS) throw new Error(`its patterns compile to more than the ${MAX_STEPS} steps in all this matches`);
      compiled.set(source, { source, program });
    }
    return compiled.get(source);
  };
  // Every node as often as aliases name it, which the bounds above stop.
  const walk = (node) => {
    if (++nodes > MAX_NODES) throw new Error(`it holds more than ${MAX_NODES} nodes with its aliases read in`);
    if (typeof node === 'string') {
      chars += node.length;
      if (chars > MAX_TEXT) throw new Error(`it holds more than ${MAX_TEXT} characters with its aliases read in`);
    }
    if (node === null || typeof node !== 'object') return;
    for (const [key, value] of node instanceof Map ? node : node.entries()) {
      const list = node instanceof Map && Object.hasOwn(LISTS, key) ? LISTS[key] : undefined;
      if (node instanceof Map) walk(key);
      if (list && value !== null) {
        if (!Array.isArray(value)) throw new Error(`its "${key}" is not a list`);
        for (const item of value) {
          // policy-bot reads a null entry as "", which every text holds.
          if (item !== null && typeof item !== 'string') throw new Error(`its "${key}" holds something other than text`);
          const text = item ?? '';
          if (list === 'comments') out.comments.add(text);
          else out[list].set(text, compile(text));
        }
      }
      walk(value);
    }
  };
  walk(doc);
  return { comments: [...out.comments], patterns: [...out.patterns.values()], bodies: [...out.bodies.values()] };
}

// ------------------------------------------------------------------------- YAML

const NULLS = new Set(['', '~', 'null', 'Null', 'NULL']);
const ESCAPES = { 0: '\0', a: '\x07', b: '\b', t: '\t', '\t': '\t', n: '\n', v: '\v', f: '\f', r: '\r', e: '\x1b', ' ': ' ', '"': '"', '/': '/', '\\': '\\', N: '\x85', _: '\xa0', L: ' ', P: ' ' };
const HEX_ESCAPES = { x: 2, u: 4, U: 8 };
// The deepest collections may nest (yaml.v2's is 10,000).
const MAX_DEPTH = 100;

// One YAML document as yaml.v2 decodes it into strings: a mapping is a Map, a sequence an
// array, every scalar its text and a plain null (`~`, `null`, nothing) null.
function parseYaml(source) {
  // yaml.v2 also breaks lines at these, which this reader does not.
  const odd = /\r(?!\n)|[\x85\u2028\u2029]/.exec(source);
  if (odd) throw new Error(`its line ${source.slice(0, odd.index).split('\n').length} holds a line break this does not read (U+${odd[0].codePointAt(0).toString(16).toUpperCase().padStart(4, '0')})`);
  const lines = source.replace(/^﻿/, '').split(/\r?\n/);
  // Whether the last line ends in a line break, which a block scalar at the end keeps.
  const broken = lines.at(-1) === '';
  if (broken) lines.pop();
  // The lines as one text, and where each starts in it, for a flow collection over lines.
  const whole = lines.join('\n');
  const starts = [];
  for (let k = 0, at = 0; k < lines.length; at += lines[k].length + 1, k++) starts.push(at);
  const anchors = new Map();
  let [i, depth] = [0, 0];
  const fail = (why, at = i) => { throw new Error(`its line ${at + 1} ${why}`); };
  const deeper = (by, at) => {
    depth += by;
    if (depth > MAX_DEPTH) fail(`nests collections more than ${MAX_DEPTH} deep`, at);
  };
  const spaces = (line) => /^ */.exec(line)[0].length;
  const blank = (line) => /^[ \t]*(#.*)?$/.test(line);
  const marker = (line) => /^(---|\.\.\.)([ \t]|$)/.test(line);
  const skip = () => { while (i < lines.length && blank(lines[i])) i++; };
  const seqAt = (line, col) => /^-([ \t]|$)/.test(line.slice(col));
  // Whether `text` holds a space or a tab at `at`, or ends there. The scanners below pass
  // over a line once, where a regular expression could pass over it once per column.
  const gapAt = (text, at) => at === text.length || text[at] === ' ' || text[at] === '\t';
  const trimEnd = (text) => {
    let stop = text.length;
    while (stop > 0 && (text[stop - 1] === ' ' || text[stop - 1] === '\t')) stop--;
    return text.slice(0, stop);
  };
  // After a value on its line, only a comment may follow.
  const end = (line, at) => {
    if (!/^([ \t]+#.*|[ \t]*)$/.test(line.slice(at))) fail('holds more than one value');
  };

  // A quoted scalar starting at `at`: [text, the column after it], on one line.
  function quoted(line, at) {
    const q = line[at];
    let out = '';
    for (let p = at + 1; p < line.length && line[p] !== '\n'; p++) {
      const c = line[p];
      if (q === "'" && c === "'") {
        if (line[p + 1] !== "'") return [out, p + 1];
        out += "'";
        p++;
      } else if (q === '"' && c === '"') {
        return [out, p + 1];
      } else if (q === '"' && c === '\\') {
        const e = line[++p];
        if (Object.hasOwn(HEX_ESCAPES, e)) {
          const digits = line.slice(p + 1, p + 1 + HEX_ESCAPES[e]);
          if (!/^[0-9a-fA-F]+$/.test(digits) || digits.length !== HEX_ESCAPES[e]) fail('holds an escape that is not one');
          out += String.fromCodePoint(parseInt(digits, 16));
          p += digits.length;
        } else if (Object.hasOwn(ESCAPES, e)) {
          out += ESCAPES[e];
        } else {
          fail('holds an escape that is not one');
        }
      } else {
        out += c;
      }
    }
    return fail('holds quoted text that goes on past the line');
  }

  // The key of a mapping entry the text starts with: [key, the column after its ":"], or
  // null when the text is no mapping entry.
  function keyAt(line, col) {
    const text = line.slice(col);
    if (text[0] === '"' || text[0] === "'") {
      let key;
      let after;
      try { [key, after] = quoted(text, 0); } catch { return null; }
      const colon = /^[ \t]*:(?=[ \t]|$)/.exec(text.slice(after));
      return colon ? [key, col + after + colon[0].length] : null;
    }
    if (/^[[\]{},#&*!|>%@`]/.test(text) || /^[-?:]([ \t]|$)/.test(text)) return null;
    let colon = text.indexOf(':');
    while (colon >= 0 && !gapAt(text, colon + 1)) colon = text.indexOf(':', colon + 1);
    if (colon < 0) return null;
    const key = trimEnd(text.slice(0, colon));
    return /[ \t]#/.test(key) ? null : [key, col + colon + 1];
  }

  // A node whose lines are indented at least `min`, starting on the next line that holds
  // something; null when there is none.
  function node(min) {
    skip();
    if (i >= lines.length || marker(lines[i])) return null;
    const line = lines[i];
    const ind = spaces(line);
    if (ind < min) return null;
    if (line[ind] === '\t') fail('is indented with a tab');
    if (seqAt(line, ind)) return sequence(ind);
    if (keyAt(line, ind)) return mapping(ind);
    return value(min - 1, ind);
  }

  function sequence(ind) {
    deeper(1);
    const out = [];
    for (skip(); i < lines.length && spaces(lines[i]) === ind && seqAt(lines[i], ind); skip()) out.push(after(ind, ind + 1, false));
    deeper(-1);
    return out;
  }

  function mapping(ind) {
    deeper(1);
    const out = new Map();
    for (skip(); i < lines.length && spaces(lines[i]) === ind && !marker(lines[i]); skip()) {
      const found = keyAt(lines[i], ind);
      if (!found) break;
      const [key, col] = found;
      if (out.has(key)) fail(`holds "${key}" a second time`);
      out.set(key, after(ind, col, true));
    }
    deeper(-1);
    return out;
  }

  // The value after a sequence's "-" or a key's ":" at column `col` of an entry indented
  // `ind`: on the same line, or the block below it. A key's sequence may stand at the key's
  // own indent.
  function after(ind, col, keyed) {
    const line = lines[i];
    let at = col + /^[ \t]*/.exec(line.slice(col))[0].length;
    let anchor = null;
    if (line[at] === '&') {
      anchor = /^&([^ \t[\]{},]+)/.exec(line.slice(at))?.[1] ?? fail('holds an anchor without a name');
      at += anchor.length + 1;
      at += /^[ \t]*/.exec(line.slice(at))[0].length;
    }
    let result;
    if (blank(line.slice(at))) {
      i++;
      skip();
      result = keyed && i < lines.length && spaces(lines[i]) === ind && seqAt(lines[i], ind) ? sequence(ind) : node(ind + 1);
    } else if (!keyed && (seqAt(line, at) || keyAt(line, at))) {
      // YAML gives an anchor written before a key to the key.
      if (anchor !== null) fail('anchors a key, which this does not read');
      // A collection that starts on the entry's own line ("- key: value") is indented as
      // far as it stands.
      lines[i] = ' '.repeat(at) + line.slice(at);
      result = node(at);
    } else {
      result = value(ind, at);
    }
    if (anchor !== null) anchors.set(anchor, result);
    return result;
  }

  // A value written from column `at` of the current line, in a node indented more than
  // `parent`: a scalar, an alias, a flow collection or a block scalar.
  function value(parent, at) {
    const line = lines[i];
    const c = line[at];
    if (c === '|' || c === '>') return block(parent, at);
    if (c === '[' || c === '{') return flow(at);
    if (c === '*') {
      const name = /^\*([^ \t[\]{},]+)/.exec(line.slice(at))?.[1];
      if (!name || !anchors.has(name)) fail('names an anchor that is not set before it');
      end(line, at + name.length + 1);
      i++;
      return anchors.get(name);
    }
    if (c === '"' || c === "'") {
      const [text, stop] = quoted(line, at);
      end(line, stop);
      i++;
      return text;
    }
    if (/^[!%@`&]/.test(c) || /^[-?:]([ \t]|$)/.test(line.slice(at))) fail('holds a kind of YAML this does not read');
    let text = line.slice(at);
    let hash = text.indexOf('#');
    while (hash >= 0 && !gapAt(text, hash - 1)) hash = text.indexOf('#', hash + 1);
    text = trimEnd(hash < 0 ? text : text.slice(0, hash));
    if (/:([ \t]|$)/.test(text)) fail('holds more than one value');
    i++;
    return NULLS.has(text) ? null : text;
  }

  // A literal ("|") or folded (">") block scalar whose header is at column `at`.
  function block(parent, at) {
    const header = /^([|>])(?:([1-9])?([+-])?|([+-])([1-9]))(?:[ \t]+#.*|[ \t]*)$/.exec(lines[i].slice(at)) ?? fail('starts a block scalar this does not read');
    const [, style] = header;
    const digit = header[2] ?? header[5];
    const chomp = header[3] ?? header[4] ?? '';
    i++;
    const start = i;
    let indent = digit ? Math.max(parent, 0) + Number(digit) : 0;
    let set = digit !== undefined;
    let body = [];
    for (; i < lines.length; i++) {
      const line = lines[i];
      if (/^ *$/.test(line)) { body.push(line); continue; }
      const ind = spaces(line);
      if (!set) {
        if (ind <= parent) break;
        if (body.some((b) => b.length > ind)) fail('opens a block scalar with a line indented more than its text', start);
        indent = ind;
        set = true;
      }
      if (ind < indent) {
        if (ind > parent && !blank(line)) fail('is indented less than the block scalar it stands in');
        break;
      }
      body.push(line);
    }
    // With no line of text, every line is an empty one, however many spaces it holds.
    if (!set) body = body.map(() => '');
    let content = body.map((line) => line.slice(indent));
    let trailing = 0;
    while (content.length > 0 && content.at(-1) === '') { content.pop(); trailing++; }
    if (style === '>') {
      if (content.some((l) => /^[ \t]/.test(l))) fail('starts a folded block scalar whose lines this does not fold', start);
      const lead = Math.max(content.findIndex((l) => l !== ''), 0);
      const rest = content.slice(lead);
      if (rest.length > 0) content = [`${'\n'.repeat(lead)}${rest.reduce((out, l, k) => (k === 0 ? l : l === '' ? `${out}\n` : rest[k - 1] === '' ? out + l : `${out} ${l}`), '')}`];
    }
    // The line breaks after the text: one per line from the last that holds any, less
    // the one the file's last line lacks.
    const breaks = (content.length > 0 ? 1 : 0) + trailing - (i === lines.length && !broken ? 1 : 0);
    const text = content.join('\n');
    if (chomp === '-') return text;
    return text + '\n'.repeat(chomp === '+' ? Math.max(breaks, 0) : Math.min(Math.max(breaks, 0), content.length > 0 ? 1 : 0));
  }

  // A flow collection from column `at`, over as many lines as it takes.
  function flow(at) {
    const src = whole;
    let p = starts[i] + at;
    // The line `p` stands on.
    const here = () => {
      let [lo, hi] = [i, lines.length - 1];
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (starts[mid] <= p) lo = mid;
        else hi = mid - 1;
      }
      return lo;
    };
    const no = (why) => fail(why, here());
    const gap = () => {
      for (;;) {
        if (/[ \t\n]/.test(src[p] ?? '')) p++;
        else if (src[p] === '#' && /[ \t\n]/.test(src[p - 1])) while (p < src.length && src[p] !== '\n') p++;
        else return;
      }
    };
    const scalar = () => {
      if (src[p] === '"' || src[p] === "'") {
        const [text, stop] = quoted(src, p);
        p = stop;
        return text;
      }
      if (/^[!%@`&|>?]/.test(src[p]) || /^[-:]([ \t\n]|$)/.test(src.slice(p, p + 2))) no('holds a kind of YAML this does not read');
      // yaml.v2 ends a plain scalar in a flow collection at ":" only before white space.
      const m = /^(?:[^,[\]{}\n:#]|:(?![ \t\n]|$)|(?<![ \t])#)+/.exec(src.slice(p));
      if (!m) no('holds a flow collection this does not read');
      p += m[0].length;
      const text = trimEnd(m[0]);
      return NULLS.has(text) ? null : text;
    };
    const item = () => {
      gap();
      let anchor = null;
      if (src[p] === '&') {
        anchor = /^&([^ \t\n[\]{},]+)/.exec(src.slice(p))?.[1] ?? no('holds an anchor without a name');
        p += anchor.length + 1;
        gap();
      }
      let v;
      if (src[p] === '[' || src[p] === '{') {
        const map = src[p] === '{';
        const close = map ? '}' : ']';
        v = map ? new Map() : [];
        deeper(1, here());
        p++;
        for (gap(); src[p] !== close; gap()) {
          if (p >= src.length) no('opens a flow collection it does not close');
          if (map) {
            const key = scalar();
            gap();
            let val = null;
            if (src[p] === ':') {
              p++;
              gap();
              if (src[p] !== ',' && src[p] !== '}') val = item();
            }
            if (v.has(key)) no(`holds "${key}" a second time`);
            v.set(key, val);
          } else {
            v.push(item());
          }
          gap();
          if (src[p] === ',') p++;
          else if (src[p] !== close) no('holds a flow collection this does not read');
        }
        deeper(-1);
        p++;
      } else if (src[p] === '*') {
        const name = /^\*([^ \t\n[\]{},]+)/.exec(src.slice(p))?.[1];
        if (!name || !anchors.has(name)) no('names an anchor that is not set before it');
        p += name.length + 1;
        v = anchors.get(name);
      } else {
        v = scalar();
      }
      if (anchor !== null) anchors.set(anchor, v);
      return v;
    };
    const v = item();
    i = here();
    end(lines[i], p - starts[i]);
    i++;
    return v;
  }

  skip();
  if (i < lines.length && /^%/.test(lines[i])) fail('holds a directive');
  if (i < lines.length && /^---([ \t]|$)/.test(lines[i])) {
    if (!blank(lines[i].slice(3))) fail('starts the document on its marker');
    i++;
  }
  const doc = node(0);
  skip();
  if (i < lines.length && /^\.\.\.([ \t]|$)/.test(lines[i])) {
    i++;
    skip();
  }
  if (i < lines.length) fail(/^---/.test(lines[i]) ? 'starts a second document' : 'is not read as part of the document');
  return doc;
}

// ------------------------------------------------------------- Go regular expressions

// A pattern is read in Go's syntax and run as a Pike VM: like Go's regexp, its work grows
// with the text's length times the pattern's size and no more. A class is a list of tables
// of code points (unicode.js), each searched by halves.

// The most work one text may cost against a policy, counted as `search` does it: a check that
// spends it, its program's setup included, takes at most about 40 ms on an M4 Pro, and 200 ms
// on a laptop i5 at a load of 25 to 35, the slowest measured. And the most steps one pattern
// may compile to.
const BUDGET = 3_000_000;
const MAX_PROGRAM = 100_000;

// Go's Perl and POSIX classes, each as the bounds of its ranges.
const ascii = (bounds) => Int32Array.from(bounds, (c) => c.charCodeAt(0));
const PERL = { d: ascii('09'), s: ascii('\t\n\f\r  '), w: ascii('09AZ__az') };
const POSIX = {
  alnum: ascii('09AZaz'), alpha: ascii('AZaz'), ascii: ascii('\x00\x7f'), blank: ascii('\t\t  '), cntrl: ascii('\x00\x1f\x7f\x7f'),
  digit: ascii('09'), graph: ascii('!~'), lower: ascii('az'), print: ascii(' ~'), punct: ascii('!/:@[`{~'), space: ascii('\t\r  '),
  upper: ascii('AZ'), word: ascii('09AZ__az'), xdigit: ascii('09AFaf'),
};
const CONTROL = { a: 7, f: 12, t: 9, n: 10, r: 13, v: 11 };

const [CHAR, SET, ANY, ANY_BUT_NL, SPLIT, JMP, ASSERT, MATCH] = [0, 1, 2, 3, 4, 5, 6, 7];
const [TEXT_START, TEXT_END, LINE_START, LINE_END, BOUNDARY, INSIDE] = [0, 1, 2, 3, 4, 5];
const WORD = new Uint8Array(128).map((_, c) => /\w/.test(String.fromCharCode(c)));

// `source`, a pattern in Go's regexp syntax, as a program: `{ size, op, arg, arg2, sets,
// cost }`, `cost` its steps with each part of its classes and each bound of a table one
// builds. Throws for a pattern Go would not compile, and for one of more than `MAX_PROGRAM`
// steps.
function goPattern(source) {
  const s = Array.from(source);
  let p = 0;
  const no = (why) => { throw new Error(`its pattern ${JSON.stringify(source)} ${why}`); };
  const cp = (k) => s[k].codePointAt(0);
  // A class is its parts, each `{ table, fold, out }`: the code points of `table`, with
  // what they fold to when `fold` holds (Go folds each part on its own), or all others
  // when `out` does; and all of it the other way round when `negate` does. A part's
  // `depth` is the halvings a search of its table takes.
  const sets = [];
  let held = 0;
  const own = (pairs) => {
    const table = tableFrom(pairs);
    held += table.length;
    return table;
  };
  const set = (parts, negate) => {
    held += parts.length;
    return { t: SET, k: sets.push({ parts: parts.map((part) => ({ ...part, depth: 32 - Math.clz32(part.table.length >> 1) })), negate }) - 1 };
  };
  // One class for each character a literal folds, however often it stands.
  const folded = new Map();
  const lit = (c, fold) => {
    const all = fold ? [c, ...foldsOf(c)] : [c];
    if (all.length === 1) return { t: CHAR, k: c };
    if (!folded.has(c)) folded.set(c, set([{ table: own(all.map((x) => [x, x])), fold: false, out: false }], false));
    return folded.get(c);
  };

  // The character escaped by the "\\" before `p`, as Go's parseEscape reads it.
  const escaped = () => {
    const c = s[p++] ?? no('ends in a backslash');
    const octal = (k) => /^[0-7]$/.test(s[k] ?? '');
    if (c === '0' || (/^[1-7]$/.test(c) && octal(p))) {
      let r = Number(c);
      for (let k = 1; k < 3 && octal(p); k++) r = r * 8 + Number(s[p++]);
      return r;
    }
    if (c === 'x') {
      const brace = s[p] === '{';
      const end = brace ? s.indexOf('}', p) : p + 2;
      const digits = s.slice(brace ? p + 1 : p, end).join('');
      if (end === -1 || !/^[0-9A-Fa-f]+$/.test(digits) || (!brace && digits.length !== 2) || parseInt(digits, 16) > 0x10ffff) no('holds an escape that is not one');
      p = brace ? end + 1 : end;
      return parseInt(digits, 16);
    }
    if (Object.hasOwn(CONTROL, c)) return CONTROL[c];
    if (/^[\x00-\x7f]$/.test(c) && !/^[0-9A-Za-z]$/.test(c)) return cp(p - 1);
    return no('holds an escape that is not one');
  };

  // A Perl class (\d, \s, \w, negated in upper case) or a Unicode one (\pL, \p{Name},
  // negated as \P or with "^" before the name) at `p`, as the part of a class it is under
  // the flag `fold`, or null for none.
  const named = (fold) => {
    const c = s[p + 1];
    if (s[p] !== '\\' || c === undefined) return null;
    if (/^[dswDSW]$/.test(c)) {
      p += 2;
      return { table: PERL[c.toLowerCase()], fold, out: c !== c.toLowerCase() };
    }
    if (c !== 'p' && c !== 'P') return null;
    p += 2;
    let name = s[p++] ?? '';
    if (name === '{') {
      const close = s.indexOf('}', p);
      if (close === -1) no('has a class it does not close');
      name = s.slice(p, close).join('');
      p = close + 1;
    }
    const negated = name.startsWith('^');
    const found = unicodeClass(name.slice(negated ? 1 : 0)) ?? no('names a class Go does not know');
    return { table: found.table, fold: fold && found.fold, out: (c === 'P') !== negated };
  };

  // Where the first ":]" at or after a class's "[:" starts, which Go reads as the end of a
  // POSIX class's name: -1 for none, -2 before it is first looked for.
  let posixEnd = -2;
  const charClass = (fold) => {
    p++;
    const negate = s[p] === '^';
    if (negate) p++;
    const ranges = [];
    const parts = [];
    const one = () => {
      if (p >= s.length) no('has a class it does not close');
      if (s[p] !== '\\') return cp(p++);
      p++;
      return escaped();
    };
    for (let first = true; first || s[p] !== ']'; first = false) {
      if (s[p] === '[' && s[p + 1] === ':' && p + 2 < s.length) {
        if (posixEnd !== -1 && posixEnd < p + 2) {
          posixEnd = p + 2;
          while (posixEnd < s.length && !(s[posixEnd] === ':' && s[posixEnd + 1] === ']')) posixEnd++;
          if (posixEnd === s.length) posixEnd = -1;
        }
        if (posixEnd !== -1) {
          const name = s.slice(p + 2, posixEnd).join('');
          const negated = name.startsWith('^');
          const table = Object.hasOwn(POSIX, name.slice(negated ? 1 : 0)) ? POSIX[name.slice(negated ? 1 : 0)] : no('holds a class name Go does not know');
          parts.push({ table, fold, out: negated });
          p = posixEnd + 2;
          continue;
        }
      }
      const part = named(fold);
      if (part) {
        parts.push(part);
        continue;
      }
      const lo = one();
      let hi = lo;
      if (s[p] === '-' && s[p + 1] !== undefined && s[p + 1] !== ']') {
        p++;
        hi = one();
        if (hi < lo) no('holds a range that runs backwards');
      }
      ranges.push([lo, hi]);
    }
    p++;
    parts.unshift({ table: own(ranges), fold, out: false });
    return set(parts, negate);
  };

  // "{n}", "{n,}" or "{n,m}" at `p` as [n, m (-1 for no bound), its length], or null when
  // it is none, and then a "{" that stands for itself. Go reads no number with a leading 0.
  const counted = () => {
    let k = p + 1;
    const int = () => {
      const start = k;
      while (/^[0-9]$/.test(s[k] ?? '')) k++;
      return k === start || (s[start] === '0' && k - start > 1) ? null : Number(s.slice(start, k).join(''));
    };
    const min = int();
    if (min === null) return null;
    let max = min;
    if (s[k] === ',') {
      k++;
      max = s[k] === '}' ? -1 : int();
      if (max === null) return null;
    }
    return s[k] === '}' ? [min, max, k + 1 - p] : null;
  };
  // Whether the counted repetitions nested in `node` repeat it at most `n` times
  // (repeatIsValid in Go's regexp/syntax).
  const fits = (node, n) => {
    if (node.t === 'rep' && node.counted) {
      const m = node.max < 0 ? node.min : node.max;
      if (node.max === 0) return true;
      if (m > n) return false;
      if (m > 0) n = Math.floor(n / m);
    }
    return (node.subs ?? []).every((sub) => fits(sub, n));
  };

  // The alternatives from `p` up to the ")" that closes the group (or the end, at the top),
  // under the group's `flags`, which a flag group changes for the rest of the group.
  const group = (flags, top) => {
    const branches = [];
    let items = [];
    let repeated = false;
    for (;;) {
      if (p >= s.length) {
        if (!top) no('opens a group it does not close');
        break;
      }
      const c = s[p];
      if (c === ')') {
        if (top) no('closes a group it does not open');
        p++;
        break;
      }
      const count = c === '{' ? counted() : null;
      if (c === '*' || c === '+' || c === '?' || count) {
        const [min, max, length] = count ?? (c === '*' ? [0, -1, 1] : c === '+' ? [1, -1, 1] : [0, 1, 1]);
        if (max >= 0 && min > max) no('repeats fewer times at most than at least');
        p += length;
        // A lazy repetition matches the same texts.
        if (s[p] === '?') p++;
        if (repeated) no('repeats a repetition');
        if (items.length === 0) no('repeats nothing');
        const node = { t: 'rep', subs: [items.pop()], min, max, counted: count !== null };
        if (count && (min >= 2 || max >= 2) && !fits(node, 1000)) no('repeats more than 1000 times');
        items.push(node);
        repeated = true;
        continue;
      }
      repeated = false;
      if (c === '|') {
        p++;
        branches.push(items);
        items = [];
      } else if (c === '(') {
        p++;
        if (s[p] !== '?') {
          items.push(group({ ...flags }, false));
        } else if (s[p + 1] === '<' || (s[p + 1] === 'P' && s[p + 2] === '<')) {
          const close = s.indexOf('>', p);
          if (close === -1 || !/^\?P?<[0-9A-Za-z_]+$/.test(s.slice(p, close).join(''))) no('names a group in a way Go does not read');
          p = close + 1;
          items.push(group({ ...flags }, false));
        } else {
          p++;
          const next = { ...flags };
          let on = true;
          let saw = false;
          for (;;) {
            const f = s[p++];
            if (f === 'i' || f === 'm' || f === 's' || f === 'U') {
              next[f] = on;
              saw = true;
            } else if (f === '-' && on) {
              on = false;
              saw = false;
            } else if ((f === ':' || f === ')') && (on || saw)) {
              if (f === ':') items.push(group(next, false));
              else Object.assign(flags, next);
              break;
            } else {
              no('holds a group Go does not read');
            }
          }
        }
      } else if (c === '[') {
        items.push(charClass(flags.i));
      } else if (c === '.') {
        p++;
        items.push({ t: flags.s ? ANY : ANY_BUT_NL });
      } else if (c === '^' || c === '$') {
        p++;
        items.push({ t: ASSERT, k: c === '^' ? (flags.m ? LINE_START : TEXT_START) : (flags.m ? LINE_END : TEXT_END) });
      } else if (c === '\\' && Object.hasOwn({ A: 0, z: 0, b: 0, B: 0 }, s[p + 1])) {
        items.push({ t: ASSERT, k: { A: TEXT_START, z: TEXT_END, b: BOUNDARY, B: INSIDE }[s[p + 1]] });
        p += 2;
      } else if (c === '\\' && s[p + 1] === 'Q') {
        p += 2;
        while (p < s.length && !(s[p] === '\\' && s[p + 1] === 'E')) items.push(lit(cp(p++), flags.i));
        p += 2;
      } else if (c === '\\') {
        const part = named(flags.i);
        if (part) {
          items.push(set([part], false));
        } else {
          p++;
          items.push(lit(escaped(), flags.i));
        }
      } else {
        p++;
        items.push(lit(cp(p - 1), flags.i));
      }
    }
    branches.push(items);
    const alts = branches.map((subs) => ({ t: 'cat', subs }));
    return alts.length === 1 ? alts[0] : { t: 'alt', subs: alts };
  };
  const root = group({ i: false, m: false, s: false, U: false }, true);

  // The steps `node` compiles to, as `emit` writes them.
  const size = (node) => {
    if (node.t === 'cat') return node.subs.reduce((sum, sub) => sum + size(sub), 0);
    if (node.t === 'alt') return node.subs.reduce((sum, sub) => sum + size(sub), 2 * (node.subs.length - 1));
    if (node.t !== 'rep') return 1;
    const one = size(node.subs[0]);
    if (node.max >= 0) return node.min * one + (node.max - node.min) * (one + 1);
    return node.min > 0 ? node.min * one + 1 : one + 2;
  };
  const steps = size(root) + 1;
  if (steps > MAX_PROGRAM) no(`compiles to ${steps} steps, more than the ${MAX_PROGRAM} this matches`);
  const op = new Uint8Array(steps);
  const arg = new Int32Array(steps);
  const arg2 = new Int32Array(steps);
  let at = 0;
  const push = (o, a = 0, b = 0) => {
    op[at] = o;
    arg[at] = a;
    arg2[at] = b;
    return at++;
  };
  const emit = (node) => {
    if (node.t === 'cat') {
      node.subs.forEach(emit);
    } else if (node.t === 'alt') {
      const jumps = node.subs.map((sub, k) => {
        if (k === node.subs.length - 1) return emit(sub);
        const split = push(SPLIT, at + 1);
        emit(sub);
        const jump = push(JMP);
        arg2[split] = at;
        return jump;
      });
      jumps.pop();
      for (const jump of jumps) arg[jump] = at;
    } else if (node.t === 'rep') {
      const [sub] = node.subs;
      const { min, max } = node;
      // `sub` is compiled once and copied: a repetition costs its steps, though what it
      // repeats may compile to none.
      let first = -1;
      let length = 0;
      const copy = () => {
        if (first < 0) {
          first = at;
          emit(sub);
          length = at - first;
          return;
        }
        const by = at - first;
        for (let pc = first; pc < first + length; pc++) {
          const o = op[pc];
          push(o, o === SPLIT || o === JMP ? arg[pc] + by : arg[pc], o === SPLIT ? arg2[pc] + by : 0);
        }
      };
      for (let k = 0; k < (max < 0 && min > 0 ? min - 1 : min); k++) copy();
      if (max < 0 && min > 0) {
        const start = at;
        copy();
        push(SPLIT, start, at + 1);
      } else if (max < 0) {
        const split = push(SPLIT, at + 1);
        copy();
        push(JMP, split);
        arg2[split] = at;
      } else {
        for (let k = min; k < max; k++) {
          const split = push(SPLIT, at + 1);
          copy();
          arg2[split] = at;
        }
      }
    } else {
      push(node.t, node.k);
    }
  };
  emit(root);
  push(MATCH);
  return { size: steps, op, arg, arg2, sets, cost: steps + held };
}

// `text` as its code points, a lone surrogate read as U+FFFD, as Go decodes one from JSON;
// null when it has more than `most`.
function codePoints(text, most = text.length) {
  const cps = new Int32Array(Math.min(text.length, most));
  let n = 0;
  for (let k = 0; k < text.length; k++) {
    if (n === most) return null;
    const c = text.codePointAt(k);
    if (c > 0xffff) k++;
    cps[n++] = c >= 0xd800 && c <= 0xdfff ? 0xfffd : c;
  }
  return cps.subarray(0, n);
}

// A policy's `comments` strings and patterns (`kind` "comment") or its body patterns
// ("body") as one program for `search`: `{ size, op, arg, arg2, sets, said, any, ascii,
// other, texts, lines }`. Each entry's program follows the last, its MATCH holding the
// entry's index, and `said[k]` says what a text entry k matches does; a string is the
// program of its characters. An entry is started only where its match can start: before any
// character when it is in `any`; before a character c in `ascii[c]` (c below 128) or one in
// `other`; at the text's start in `texts`, and at a line's in `lines`.
function unionOf(policy, kind) {
  // A text or a pattern the policy names twice is one entry.
  const entries = new Map();
  if (kind === 'comment') for (const w of policy.comments) entries.set(`holds ${JSON.stringify(w)}`, codePoints(w));
  for (const { source, program } of kind === 'comment' ? policy.patterns : policy.bodies) entries.set(`matches the pattern ${JSON.stringify(source)}`, program);
  const programs = [...entries.values()];
  const size = programs.reduce((sum, program) => sum + (program.size ?? program.length + 1), 0);
  const [op, arg, arg2] = [new Uint8Array(size), new Int32Array(size), new Int32Array(size)];
  const sets = [];
  const starts = [];
  let at = 0;
  programs.forEach((program, k) => {
    starts.push(at);
    if (program instanceof Int32Array) {
      op.fill(CHAR, at, at + program.length);
      arg.set(program, at);
      op[at + program.length] = MATCH;
      arg[at + program.length] = k;
      at += program.length + 1;
      return;
    }
    for (let pc = 0; pc < program.size; pc++) {
      const o = program.op[pc];
      op[at + pc] = o;
      arg[at + pc] = o === SPLIT || o === JMP ? program.arg[pc] + at : o === SET ? program.arg[pc] + sets.length : o === MATCH ? k : program.arg[pc];
      if (o === SPLIT) arg2[at + pc] = program.arg2[pc] + at;
    }
    for (const one of program.sets) sets.push(one);
    at += program.size;
  });
  const union = { size, op, arg, arg2, sets, said: [...entries.keys()], any: [], ascii: Array.from({ length: 128 }, () => []), other: [], texts: [], lines: [] };
  // Where each entry's match can start: before the characters its first consuming steps
  // take, an assertion passed over but one of a text's or a line's start, where it then
  // starts. A first step other than a character or a class of one table that neither folds
  // nor is negated, and it starts everywhere.
  const mark = new Int32Array(size);
  const stack = new Int32Array(size);
  const seen = new Int32Array(128);
  const chars = new Int32Array(128);
  starts.forEach((start, k) => {
    let [everywhere, wide, text, line, sp, n] = [false, false, false, false, 0, 0];
    const visit = (pc) => {
      if (mark[pc] !== k + 1) {
        mark[pc] = k + 1;
        stack[sp++] = pc;
      }
    };
    const add = (c) => {
      if (seen[c] !== k + 1) {
        seen[c] = k + 1;
        chars[n++] = c;
      }
    };
    visit(start);
    while (sp > 0 && !everywhere) {
      const pc = stack[--sp];
      const o = op[pc];
      if (o === JMP) visit(arg[pc]);
      else if (o === SPLIT) {
        visit(arg[pc]);
        visit(arg2[pc]);
      } else if (o === ASSERT && arg[pc] === TEXT_START) text = true;
      else if (o === ASSERT && arg[pc] === LINE_START) line = true;
      else if (o === ASSERT) visit(pc + 1);
      else if (o === CHAR && arg[pc] < 128) add(arg[pc]);
      else if (o === CHAR) wide = true;
      else if (o !== SET) everywhere = true;
      else {
        const { parts, negate } = sets[arg[pc]];
        const [{ table, fold, out }] = parts;
        if (parts.length > 1 || negate || fold || out) everywhere = true;
        for (let r = 0; r < table.length && table[r] < 128; r += 2) {
          for (let c = table[r]; c <= Math.min(table[r + 1], 127); c++) add(c);
        }
        if (table.length > 0 && table[table.length - 1] >= 128) wide = true;
      }
    }
    if (text) union.texts.push(start);
    if (line) union.lines.push(start);
    if (everywhere) union.any.push(start);
    else {
      for (let j = 0; j < n; j++) union.ascii[chars[j]].push(start);
      if (wide) union.other.push(start);
    }
  });
  return union;
}

// Which entry of `union` (`unionOf`) matches anywhere in the text of `cps` (`codePoints`),
// as Go's MatchString answers for each, or -1 for none; null when that takes more than
// `budget` work: one for each step of the program to set up, for each character of the
// text, for each step a thread takes and for each halving of a table a class's test makes.
function search(union, cps, budget) {
  const { size, op, arg, arg2, sets, any, ascii, other, texts, lines } = union;
  const n = cps.length;
  let left = budget - size;
  const word = (c) => WORD[c] === 1;
  const holdsAt = (k, prev, next) => {
    if (k === TEXT_START) return prev === -1;
    if (k === TEXT_END) return next === -1;
    if (k === LINE_START) return prev === -1 || prev === 10;
    if (k === LINE_END) return next === -1 || next === 10;
    return (word(prev) !== word(next)) === (k === BOUNDARY);
  };
  // What the character being matched folds to, once a class asks.
  let folds = null;
  const inSet = (set, c) => {
    for (const { table, fold, out, depth } of set.parts) {
      left -= depth;
      let found = holds(table, c);
      if (!found && fold) {
        folds ??= foldsOf(c);
        for (let k = 0; k < folds.length && !found; k++) {
          left -= depth;
          found = holds(table, folds[k]);
        }
      }
      if (found !== out) return !set.negate;
    }
    return set.negate;
  };
  const mark = new Int32Array(size);
  const stack = new Int32Array(size);
  let gen = 1;
  let hit = -1;
  // Adds to `list` (holding `len` threads) every consuming step reached from `start`
  // between the characters `prev` and `next` (-1 past either end); -1 when an entry
  // matches, which `hit` then names.
  const follow = (list, len, start, prev, next) => {
    let sp = 0;
    const visit = (pc) => {
      if (mark[pc] !== gen) {
        mark[pc] = gen;
        stack[sp++] = pc;
      }
    };
    visit(start);
    while (sp > 0) {
      const pc = stack[--sp];
      left--;
      const o = op[pc];
      if (o === MATCH) {
        hit = arg[pc];
        return -1;
      }
      if (o === JMP) visit(arg[pc]);
      else if (o === SPLIT) {
        visit(arg[pc]);
        visit(arg2[pc]);
      } else if (o === ASSERT) {
        if (holdsAt(arg[pc], prev, next)) visit(pc + 1);
      } else list[len++] = pc;
    }
    return len;
  };
  // Adds to `list` the threads of every entry whose match can start between `prev` and
  // `next`.
  const from = (starts, list, len, prev, next) => {
    for (let k = 0; k < starts.length && len >= 0; k++) len = follow(list, len, starts[k], prev, next);
    return len;
  };
  const enter = (list, len, prev, next) => {
    len = from(any, list, len, prev, next);
    if (prev === -1) len = from(texts, list, len, prev, next);
    if (prev === -1 || prev === 10) len = from(lines, list, len, prev, next);
    return next < 0 ? len : from(next < 128 ? ascii[next] : other, list, len, prev, next);
  };
  let now = new Int32Array(size);
  let then = new Int32Array(size);
  let count = enter(now, 0, -1, n > 0 ? cps[0] : -1);
  for (let i = 0; i < n && count >= 0; i++) {
    const c = cps[i];
    const next = i + 1 < n ? cps[i + 1] : -1;
    gen++;
    folds = null;
    left--;
    let added = 0;
    for (let k = 0; k < count && added >= 0 && left >= 0; k++) {
      const pc = now[k];
      const o = op[pc];
      left--;
      if (o === CHAR ? arg[pc] === c : o === SET ? inSet(sets[arg[pc]], c) : o === ANY || c !== 10) added = follow(then, added, pc + 1, c, next);
    }
    if (added >= 0) added = enter(then, added, c, next);
    if (left < 0 && added >= 0) return null;
    [now, then] = [then, now];
    count = added;
  }
  return count < 0 ? hit : -1;
}
