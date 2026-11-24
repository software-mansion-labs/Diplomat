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
// A policy is a YAML file, read here by a reader of its own: block and flow collections,
// the three scalar styles, block scalars, anchors and aliases. Its patterns are Go regular
// expressions, translated to JavaScript ones that match the same texts. What either cannot
// read is a policy this cannot check text against, and text is refused on its repository.

const WORDS = [':+1:', '👍', ':-1:', '👎'];

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
  const say = (what) => `${what}, which the pool repository's policy-bot policy (${policy.from.join(', ')}) counts as an approval or a disapproval from whoever wrote it: reword it and send the request again`;
  if (kind === 'comment') {
    const word = policy.comments.find((w) => text.includes(w));
    if (word !== undefined) return say(`holds ${JSON.stringify(word)}`);
  }
  const pattern = (kind === 'comment' ? policy.patterns : policy.bodies).find((p) => p.re.test(text));
  return pattern === undefined ? null : say(`matches the pattern ${JSON.stringify(pattern.source)}`);
}

const LISTS = { comments: 'comments', comment_patterns: 'patterns', github_review_comment_patterns: 'patterns', body_patterns: 'bodies' };

/// What a policy file holds: `{ remote: { repo, path, ref } }` for one that names a policy in
/// another repository (`path` and `ref` '' where it names none), else `{ comments, patterns,
/// bodies }` - every text-matching method of the file, wherever it stands, with each
/// pattern as `{ source, re }`. Throws, saying why, for a file this cannot read.
export function readPolicy(text) {
  const doc = parseYaml(text);
  // go-githubapp reads a file of these members only, `remote` among them, as a reference.
  if (doc instanceof Map && doc.has('remote') && doc.get('remote') !== null && [...doc.keys()].every((k) => ['remote', 'path', 'ref'].includes(k))) {
    const [repo, path, ref] = ['remote', 'path', 'ref'].map((k) => doc.get(k) ?? '');
    if (![repo, path, ref].every((v) => typeof v === 'string') || repo === '') throw new Error('it names its remote policy in a form policy-bot does not read');
    return { remote: { repo, path, ref } };
  }
  const out = { comments: [], patterns: [], bodies: [] };
  const seen = new Set();
  const walk = (node) => {
    if (node === null || typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);
    for (const [key, value] of node instanceof Map ? node : node.entries()) {
      const list = node instanceof Map && Object.hasOwn(LISTS, key) ? LISTS[key] : undefined;
      if (list && value !== null) {
        if (!Array.isArray(value)) throw new Error(`its "${key}" is not a list`);
        for (const item of value) {
          // policy-bot reads a null entry as "", which every text holds.
          if (item !== null && typeof item !== 'string') throw new Error(`its "${key}" holds something other than text`);
          if (list === 'comments') out.comments.push(item ?? '');
          else out[list].push({ source: item ?? '', re: goRegExp(item ?? '') });
        }
      }
      walk(value);
    }
  };
  walk(doc);
  return out;
}

// ------------------------------------------------------------------------- YAML

const NULLS = new Set(['', '~', 'null', 'Null', 'NULL']);
const ESCAPES = { 0: '\0', a: '\x07', b: '\b', t: '\t', '\t': '\t', n: '\n', v: '\v', f: '\f', r: '\r', e: '\x1b', ' ': ' ', '"': '"', '/': '/', '\\': '\\', N: '\x85', _: '\xa0', L: ' ', P: ' ' };
const HEX_ESCAPES = { x: 2, u: 4, U: 8 };

// One YAML document as yaml.v2 decodes it into strings: a mapping is a Map, a sequence an
// array, every scalar its text and a plain null (`~`, `null`, nothing) null.
function parseYaml(source) {
  const lines = source.replace(/^﻿/, '').split(/\r?\n/);
  // Whether the last line ends in a line break, which a block scalar at the end keeps.
  const broken = lines.at(-1) === '';
  if (broken) lines.pop();
  const anchors = new Map();
  let i = 0;
  const fail = (why, at = i) => { throw new Error(`its line ${at + 1} ${why}`); };
  const spaces = (line) => /^ */.exec(line)[0].length;
  const blank = (line) => /^[ \t]*(#.*)?$/.test(line);
  const marker = (line) => /^(---|\.\.\.)([ \t]|$)/.test(line);
  const skip = () => { while (i < lines.length && blank(lines[i])) i++; };
  const seqAt = (line, col) => /^-([ \t]|$)/.test(line.slice(col));
  // After a value on its line, only a comment may follow.
  const end = (line, at) => {
    if (!/^([ \t]+#.*|[ \t]*)$/.test(line.slice(at))) fail('holds more than one value');
  };

  // A quoted scalar starting at `at`: [text, the column after it], on one line.
  function quoted(line, at) {
    const q = line[at];
    let out = '';
    for (let p = at + 1; p < line.length; p++) {
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
    const m = /^(.*?)[ \t]*:(?=[ \t]|$)/.exec(text);
    if (!m || /[ \t]#/.test(m[1])) return null;
    return [m[1], col + m[0].length];
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
    const out = [];
    for (skip(); i < lines.length && spaces(lines[i]) === ind && seqAt(lines[i], ind); skip()) out.push(after(ind, ind + 1, false));
    return out;
  }

  function mapping(ind) {
    const out = new Map();
    for (skip(); i < lines.length && spaces(lines[i]) === ind && !marker(lines[i]); skip()) {
      const found = keyAt(lines[i], ind);
      if (!found) break;
      const [key, col] = found;
      if (out.has(key)) fail(`holds "${key}" a second time`);
      out.set(key, after(ind, col, true));
    }
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
    const text = line.slice(at).replace(/[ \t]+#.*$/, '').replace(/[ \t]+$/, '');
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
    const body = [];
    for (; i < lines.length; i++) {
      const line = lines[i];
      if (/^ *$/.test(line)) { body.push(line); continue; }
      const ind = spaces(line);
      if (indent === 0) {
        if (ind <= parent) break;
        if (body.some((b) => b.length > ind)) fail('opens a block scalar with a line indented more than its text', start);
        indent = ind;
      }
      if (ind < indent) {
        if (ind > parent && !blank(line)) fail('is indented less than the block scalar it stands in');
        break;
      }
      body.push(line);
    }
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
    const src = lines.slice(i).join('\n');
    let p = at;
    const here = () => i + (src.slice(0, p).match(/\n/g)?.length ?? 0);
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
        const lineStart = src.lastIndexOf('\n', p - 1) + 1;
        const lineEnd = src.indexOf('\n', p) === -1 ? src.length : src.indexOf('\n', p);
        const [text, stop] = quoted(src.slice(lineStart, lineEnd), p - lineStart);
        p = lineStart + stop;
        return text;
      }
      if (/^[!%@`&|>?]/.test(src[p]) || /^[-:]([ \t\n]|$)/.test(src.slice(p, p + 2))) no('holds a kind of YAML this does not read');
      // yaml.v2 ends a plain scalar in a flow collection at ":" only before white space.
      const m = /^(?:[^,[\]{}\n:#]|:(?![ \t\n]|$)|(?<![ \t])#)+/.exec(src.slice(p));
      if (!m) no('holds a flow collection this does not read');
      p += m[0].length;
      const text = m[0].replace(/[ \t]+$/, '');
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
    const last = here();
    const lineStart = src.lastIndexOf('\n', p - 1) + 1;
    i = last;
    end(lines[i], p - lineStart);
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

const PERL = { d: '0-9', w: '0-9A-Za-z_', s: '\\t\\n\\f\\r ' };
const POSIX = {
  alnum: '0-9A-Za-z', alpha: 'A-Za-z', ascii: '\\x00-\\x7f', blank: '\\t ', cntrl: '\\x00-\\x1f\\x7f', digit: '0-9', graph: '!-~',
  lower: 'a-z', print: ' -~', punct: '!-\\/:-@\\[-`\\{-~', space: '\\t\\n\\v\\f\\r ', upper: 'A-Z', word: '0-9A-Za-z_', xdigit: '0-9A-Fa-f',
};
const CONTROL = { a: 7, f: 12, t: 9, n: 10, r: 13, v: 11 };
// Go's \b and \B look at ASCII word characters even under (?i), where JavaScript's count
// "ſ" and the Kelvin sign as word characters too.
const WORD = '[0-9A-Za-z_]';
const BOUNDARY = `(?-i:(?<=${WORD})(?!${WORD})|(?<!${WORD})(?=${WORD}))`;
const INSIDE = `(?-i:(?<=${WORD})(?=${WORD})|(?<!${WORD})(?!${WORD}))`;

// `source`, a pattern in Go's regexp syntax, as a JavaScript RegExp that finds a match in
// the same texts. `.`, `^`, `$`, `\A`, `\z` and the Perl classes are spelled out as Go reads
// them; a flag group's `i` becomes a modifier group, and its `s` and `m` are applied here.
// Throws for what it does not translate: backreferences and octal, `(?U)`, a negated POSIX
// class, `\S` inside a class, and anything either engine would not compile.
function goRegExp(source) {
  const s = Array.from(source);
  let p = 0;
  const no = (why) => { throw new Error(`its pattern ${JSON.stringify(source)} ${why}`); };
  const hex = (cp) => `\\u{${cp.toString(16)}}`;
  // A class of one: V8 does not case-fold an escaped literal inside a modifier group.
  const lit = (cp) => (/^[A-Za-z0-9 ]$/.test(String.fromCodePoint(cp)) ? String.fromCodePoint(cp) : `[${hex(cp)}]`);
  const cp = (k = p) => s[k].codePointAt(0);
  const property = () => {
    const negate = s[p] === 'P';
    p++;
    let name;
    if (s[p] === '{') {
      const close = s.indexOf('}', p);
      if (close === -1) no('has a class it does not close');
      name = s.slice(p + 1, close).join('');
      p = close + 1;
    } else {
      name = s[p++] ?? no('ends in the middle of an escape');
    }
    const not = name.startsWith('^') !== negate;
    name = name.replace(/^\^/, '');
    const js = name === 'Any' || /^[A-Z][a-z]?$/.test(name) ? name : `Script=${name}`;
    return `\\${not ? 'P' : 'p'}{${js}}`;
  };
  // One escape after "\\" at `p`: [JavaScript, whether it stands for one character,
  // whether a repetition may follow it].
  const escape = (inClass) => {
    const char = (code) => (inClass ? hex(code) : lit(code));
    const c = s[p] ?? no('ends in the middle of an escape');
    if (/[0-9]/.test(c)) no('holds a backreference or an octal escape, which this does not translate');
    if (c === 'p' || c === 'P') return [property(), false, true];
    p++;
    if (Object.hasOwn(PERL, c)) return [inClass ? PERL[c] : `[${PERL[c]}]`, false, true];
    if (Object.hasOwn(PERL, c.toLowerCase())) {
      if (!inClass) return [`[^${PERL[c.toLowerCase()]}]`, false, true];
      // JavaScript's \S leaves out more white space than Go's.
      if (c === 'S') no('negates white space inside a class, which this does not translate');
      return [`\\${c}`, false, true];
    }
    if (Object.hasOwn(CONTROL, c)) return [char(CONTROL[c]), true, true];
    if (c === 'x') {
      const m = s[p] === '{' ? /^\{([0-9a-fA-F]{1,6})\}/.exec(s.slice(p).join('')) : /^[0-9a-fA-F]{2}/.exec(s.slice(p).join(''));
      if (!m) no('holds an escape that is not one');
      p += m[0].length;
      return [char(parseInt(m[1] ?? m[0], 16)), true, true];
    }
    if (/^[!-/:-@[-`{-~]$/.test(c)) return [char(cp(p - 1)), true, true];
    if (inClass) no('holds an escape that is not one');
    if (c === 'A') return ['(?:^)', false, true];
    if (c === 'z') return ['(?:$)', false, true];
    if (c === 'b' || c === 'B') return [c === 'b' ? BOUNDARY : INSIDE, false, true];
    if (c === 'Q') {
      let close = p;
      while (close < s.length && !(s[close] === '\\' && s[close + 1] === 'E')) close++;
      const out = s.slice(p, close).map((ch) => lit(ch.codePointAt(0))).join('');
      p = Math.min(close + 2, s.length);
      return [out, false, out !== ''];
    }
    return no('holds an escape that is not one');
  };
  const charClass = () => {
    p++;
    let out = '[';
    if (s[p] === '^') { out += '^'; p++; }
    for (let first = true; ; first = false) {
      if (p >= s.length) no('has a class it does not close');
      if (s[p] === ']' && !first) { p++; return `${out}]`; }
      if (s[p] === '[' && s[p + 1] === ':') {
        const m = /^\[:(\^?)([a-z]+):\]/.exec(s.slice(p).join(''));
        if (!m || m[1] || !Object.hasOwn(POSIX, m[2])) no('holds a class name this does not translate');
        out += POSIX[m[2]];
        p += m[0].length;
        continue;
      }
      const one = () => {
        if (s[p] === '\\') { p++; return escape(true); }
        const c = cp();
        p++;
        return [hex(c), true, c];
      };
      const [lo, single] = one();
      if (single && s[p] === '-' && s[p + 1] !== undefined && s[p + 1] !== ']') {
        p++;
        const [hi, ok] = one();
        if (!ok) no('holds a range that ends in a class');
        out += `${lo}-${hi}`;
      } else {
        out += lo;
      }
    }
  };
  // The alternatives of a group from `p`, up to its ")" (or the end, at the top), under
  // the group's `flags`.
  const group = (flags, top) => {
    const outer = flags.i;
    const branches = [];
    let open = 0;
    let out = '';
    const reopen = () => {
      if (flags.i !== outer) { out += flags.i ? '(?i:' : '(?-i:'; open = 1; } else { open = 0; }
    };
    let quantifiable = false;
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
      if (c === '|') {
        p++;
        branches.push(out + ')'.repeat(open));
        out = '';
        reopen();
        quantifiable = false;
        continue;
      }
      const repeat = /^(?:[*+?]|\{([0-9]+)(,([0-9]*))?\})/.exec(s.slice(p, p + 16).join(''));
      if (repeat) {
        if (!quantifiable) no('repeats nothing, or repeats a repetition');
        if (Number(repeat[1] ?? 0) > 1000 || Number(repeat[3] || 0) > 1000) no('repeats more than 1000 times');
        p += repeat[0].length;
        out += repeat[0];
        if (s[p] === '?') { out += '?'; p++; }
        quantifiable = false;
        continue;
      }
      quantifiable = true;
      if (c === '(') {
        p++;
        if (s[p] !== '?') { out += `(?:${group({ ...flags }, false)})`; continue; }
        const named = /^\?P?<[A-Za-z0-9_]+>/.exec(s.slice(p, p + 300).join(''));
        if (named) { p += named[0].length; out += `(?:${group({ ...flags }, false)})`; continue; }
        const set = /^\?([imsU]*)(?:-([imsU]*))?([:)])/.exec(s.slice(p, p + 16).join(''));
        if (!set || (set[1] === '' && set[2] === undefined && set[3] === ')') || (set[2] === '')) no('holds a group this does not translate');
        if (`${set[1]}${set[2] ?? ''}`.includes('U')) no('makes repetition lazy, which this does not translate');
        p += set[0].length;
        const next = { ...flags };
        for (const f of set[1]) next[f] = true;
        for (const f of set[2] ?? '') next[f] = false;
        if (set[3] === ':') {
          out += `(?${next.i === flags.i ? '' : next.i ? 'i' : '-i'}:${group(next, false)})`;
        } else {
          const was = flags.i;
          Object.assign(flags, next);
          if (flags.i !== was) { out += flags.i ? '(?i:' : '(?-i:'; open++; }
          quantifiable = false;
        }
        continue;
      }
      if (c === '[') { out += charClass(); continue; }
      p++;
      if (c === '\\') {
        const [js, , repeatable] = escape(false);
        out += js;
        quantifiable = repeatable;
      } else if (c === '.') out += flags.s ? '[\\s\\S]' : '[^\\n]';
      else if (c === '^') out += flags.m ? '(?:(?<=^|\\n))' : '(?:^)';
      else if (c === '$') out += flags.m ? '(?:(?=\\n|$))' : '(?:$)';
      else out += lit(cp(p - 1));
    }
    branches.push(out + ')'.repeat(open));
    return branches.join('|');
  };
  const js = group({ i: false, m: false, s: false }, true);
  try {
    return new RegExp(js, 'u');
  } catch {
    return no('is one this does not translate');
  }
}
