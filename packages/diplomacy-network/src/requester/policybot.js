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
// expressions, matched by an engine of their own that reads Go's syntax and takes time
// linear in the text, as Go's does. What either cannot read is a policy this cannot check
// text against, and text is refused on its repository; so is text too long to check in time.

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
  const patterns = kind === 'comment' ? policy.patterns : policy.bodies;
  if (text.length * patterns.reduce((sum, p) => sum + p.program.size, 0) > BUDGET) {
    return `is too long for this to check in time against the patterns of the pool repository's policy-bot policy (${policy.from.join(', ')}): shorten it and send the request again`;
  }
  const pattern = patterns.find((p) => matches(p.program, text));
  return pattern === undefined ? null : say(`matches the pattern ${JSON.stringify(pattern.source)}`);
}

const LISTS = { comments: 'comments', comment_patterns: 'patterns', github_review_comment_patterns: 'patterns', body_patterns: 'bodies' };

/// What a policy file holds: `{ remote: { repo, path, ref } }` for one that names a policy in
/// another repository (`path` and `ref` '' where it names none), else `{ comments, patterns,
/// bodies }` - every text-matching method of the file, wherever it stands, with each
/// pattern as `{ source, program }`. Throws, saying why, for a file this cannot read.
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
          else out[list].push({ source: item ?? '', program: goPattern(item ?? '') });
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
  // yaml.v2 also breaks lines at these, which this reader does not.
  const odd = /\r(?!\n)|[\x85\u2028\u2029]/.exec(source);
  if (odd) throw new Error(`its line ${source.slice(0, odd.index).split('\n').length} holds a line break this does not read (U+${odd[0].codePointAt(0).toString(16).toUpperCase().padStart(4, '0')})`);
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

// A pattern is read in Go's syntax and run as a Pike VM: like Go's regexp, its work grows
// with the text's length times the pattern's size and no more. A class is a JavaScript
// RegExp over one character, which holds nothing to backtrack over.

// The most one text may cost against a policy's patterns, its length times their steps,
// about 200 ms of matching; and the most steps one pattern may compile to.
const BUDGET = 3_000_000;
const MAX_PROGRAM = 100_000;

const PERL = { d: '0-9', w: '0-9A-Za-z_', s: '\\t\\n\\f\\r ' };
const POSIX = {
  alnum: '0-9A-Za-z', alpha: 'A-Za-z', ascii: '\\x00-\\x7f', blank: '\\t ', cntrl: '\\x00-\\x1f\\x7f', digit: '0-9', graph: '!-~',
  lower: 'a-z', print: ' -~', punct: '!-\\/:-@\\[-`\\{-~', space: '\\t\\n\\v\\f\\r ', upper: 'A-Z', word: '0-9A-Za-z_', xdigit: '0-9A-Fa-f',
};
const CONTROL = { a: 7, f: 12, t: 9, n: 10, r: 13, v: 11 };
// Go's names for \p{...} (unicode.Categories, unicode.CategoryAliases, unicode.Scripts).
const CATEGORIES = [
  'C Cc Cf Cn Co Cs L Ll Lm Lo Lt Lu M Mc Me Mn N Nd Nl No P Pc Pd Pe Pf Pi Po Ps S Sc Sk',
  'Sm So Z Zl Zp Zs',
].join(' ').split(' ');
const LONG_CATEGORIES = [
  'Cased_Letter=LC Close_Punctuation=Pe Combining_Mark=M Connector_Punctuation=Pc',
  'Control=Cc Currency_Symbol=Sc Dash_Punctuation=Pd Decimal_Number=Nd Enclosing_Mark=Me',
  'Final_Punctuation=Pf Format=Cf Initial_Punctuation=Pi Letter=L Letter_Number=Nl',
  'Line_Separator=Zl Lowercase_Letter=Ll Mark=M Math_Symbol=Sm Modifier_Letter=Lm',
  'Modifier_Symbol=Sk Nonspacing_Mark=Mn Number=N Open_Punctuation=Ps Other=C',
  'Other_Letter=Lo Other_Number=No Other_Punctuation=Po Other_Symbol=So',
  'Paragraph_Separator=Zp Private_Use=Co Punctuation=P Separator=Z Space_Separator=Zs',
  'Spacing_Mark=Mc Surrogate=Cs Symbol=S Titlecase_Letter=Lt Unassigned=Cn',
  'Uppercase_Letter=Lu cntrl=Cc digit=Nd punct=P',
].join(' ').split(' ');
const SCRIPTS = [
  'Adlam Ahom Anatolian_Hieroglyphs Arabic Armenian Avestan Balinese Bamum Bassa_Vah',
  'Batak Bengali Beria_Erfe Bhaiksuki Bopomofo Brahmi Braille Buginese Buhid',
  'Canadian_Aboriginal Carian Caucasian_Albanian Chakma Cham Cherokee Chorasmian Common',
  'Coptic Cuneiform Cypriot Cypro_Minoan Cyrillic Deseret Devanagari Dives_Akuru Dogra',
  'Duployan Egyptian_Hieroglyphs Elbasan Elymaic Ethiopic Garay Georgian Glagolitic',
  'Gothic Grantha Greek Gujarati Gunjala_Gondi Gurmukhi Gurung_Khema Han Hangul',
  'Hanifi_Rohingya Hanunoo Hatran Hebrew Hiragana Imperial_Aramaic Inherited',
  'Inscriptional_Pahlavi Inscriptional_Parthian Javanese Kaithi Kannada Katakana Kawi',
  'Kayah_Li Kharoshthi Khitan_Small_Script Khmer Khojki Khudawadi Kirat_Rai Lao Latin',
  'Lepcha Limbu Linear_A Linear_B Lisu Lycian Lydian Mahajani Makasar Malayalam Mandaic',
  'Manichaean Marchen Masaram_Gondi Medefaidrin Meetei_Mayek Mende_Kikakui',
  'Meroitic_Cursive Meroitic_Hieroglyphs Miao Modi Mongolian Mro Multani Myanmar',
  'Nabataean Nag_Mundari Nandinagari New_Tai_Lue Newa Nko Nushu Nyiakeng_Puachue_Hmong',
  'Ogham Ol_Chiki Ol_Onal Old_Hungarian Old_Italic Old_North_Arabian Old_Permic',
  'Old_Persian Old_Sogdian Old_South_Arabian Old_Turkic Old_Uyghur Oriya Osage Osmanya',
  'Pahawh_Hmong Palmyrene Pau_Cin_Hau Phags_Pa Phoenician Psalter_Pahlavi Rejang Runic',
  'Samaritan Saurashtra Sharada Shavian Siddham Sidetic SignWriting Sinhala Sogdian',
  'Sora_Sompeng Soyombo Sundanese Sunuwar Syloti_Nagri Syriac Tagalog Tagbanwa Tai_Le',
  'Tai_Tham Tai_Viet Tai_Yo Takri Tamil Tangsa Tangut Telugu Thaana Thai Tibetan Tifinagh',
  'Tirhuta Todhri Tolong_Siki Toto Tulu_Tigalari Ugaritic Vai Vithkuqi Wancho Warang_Citi',
  'Yezidi Yi Zanabazar_Square',
].join(' ').split(' ');
// Each name as the JavaScript class it stands for, keyed as Go looks a name up: "_", "-"
// and " " dropped, the first letter upper case and the others lower.
const canonical = (name) => name.replace(/[-_ ]/g, '').replace(/^[a-z]/, (c) => c.toUpperCase()).replace(/(?<!^)[A-Z]/g, (c) => c.toLowerCase());
const PROPERTIES = new Map();
for (const [name, body] of [
  ['Any', '\\u{0}-\\u{10ffff}'], ['Assigned', '\\p{Assigned}'], ['ASCII', '\\u{0}-\\u{7f}'], ['LC', '\\p{LC}'],
  ...CATEGORIES.map((c) => [c, `\\p{General_Category=${c}}`]),
  ...SCRIPTS.map((s) => [s, `\\p{Script=${s}}`]),
]) PROPERTIES.set(canonical(name), body);
for (const [name, c] of LONG_CATEGORIES.map((pair) => pair.split('='))) PROPERTIES.set(canonical(name), PROPERTIES.get(canonical(c)));

const [CHAR, SET, ANY, ANY_BUT_NL, SPLIT, JMP, ASSERT, MATCH] = [0, 1, 2, 3, 4, 5, 6, 7];
const [TEXT_START, TEXT_END, LINE_START, LINE_END, BOUNDARY, INSIDE] = [0, 1, 2, 3, 4, 5];
const WORD = new Uint8Array(128).map((_, c) => /\w/.test(String.fromCharCode(c)));
const hex = (cp) => `\\u{${cp.toString(16)}}`;

// The characters a class matches: those in `pos` and those outside each of `negs` (bodies
// of JavaScript classes), each part closed under case folding first when `fold` holds, as
// Go folds a class before it negates any part of it; all of it negated when `negate` does.
function charSet(pos, negs, fold, negate) {
  const parts = negs.map((body) => `[^${body}]`);
  if (pos !== '') parts.unshift(`[${pos}]`);
  const re = new RegExp(`^(?:${parts.join('|')})$`, fold ? 'iu' : 'u');
  const ascii = new Uint8Array(128);
  const other = new Map();
  return (cp) => {
    if (cp < 128) {
      if (ascii[cp] === 0) ascii[cp] = re.test(String.fromCharCode(cp)) !== negate ? 1 : 2;
      return ascii[cp] === 1;
    }
    let has = other.get(cp);
    if (has === undefined) other.set(cp, (has = re.test(String.fromCodePoint(cp)) !== negate));
    return has;
  };
}

// `source`, a pattern in Go's regexp syntax, as a program for `matches`: `{ size, op, arg,
// arg2, sets }`. Throws for a pattern Go would not compile, and for one of more than
// `MAX_PROGRAM` steps.
function goPattern(source) {
  const s = Array.from(source);
  let p = 0;
  const no = (why) => { throw new Error(`its pattern ${JSON.stringify(source)} ${why}`); };
  const cp = (k) => s[k].codePointAt(0);
  const sets = [];
  const set = (pos, negs, fold, negate) => ({ t: SET, k: sets.push(charSet(pos, negs, fold, negate)) - 1 });
  const lit = (c, fold) => (fold ? set(hex(c), [], true, false) : { t: CHAR, k: c });

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
  // negated as \P or with "^" before the name) at `p`, as [its JavaScript class, whether
  // it is negated], or null for none.
  const named = () => {
    const c = s[p + 1];
    if (s[p] !== '\\' || c === undefined) return null;
    if (/^[dswDSW]$/.test(c)) {
      p += 2;
      return [PERL[c.toLowerCase()], c !== c.toLowerCase()];
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
    return [PROPERTIES.get(canonical(name.slice(negated ? 1 : 0))) ?? no('names a class Go does not know'), (c === 'P') !== negated];
  };

  const charClass = (fold) => {
    p++;
    const negate = s[p] === '^';
    if (negate) p++;
    let pos = '';
    const negs = [];
    const add = ([body, negated]) => {
      if (negated) negs.push(body);
      else pos += body;
    };
    const one = () => {
      if (p >= s.length) no('has a class it does not close');
      if (s[p] !== '\\') return cp(p++);
      p++;
      return escaped();
    };
    for (let first = true; first || s[p] !== ']'; first = false) {
      if (s[p] === '[' && s[p + 1] === ':' && p + 2 < s.length) {
        let end = p + 2;
        while (end < s.length && !(s[end] === ':' && s[end + 1] === ']')) end++;
        if (end < s.length) {
          const m = /^\[:(\^?)([a-z]+):\]$/.exec(s.slice(p, end + 2).join(''));
          if (!m || !Object.hasOwn(POSIX, m[2])) no('holds a class name Go does not know');
          add([POSIX[m[2]], m[1] === '^']);
          p = end + 2;
          continue;
        }
      }
      const perl = named();
      if (perl) {
        add(perl);
        continue;
      }
      const lo = one();
      let hi = lo;
      if (s[p] === '-' && s[p + 1] !== undefined && s[p + 1] !== ']') {
        p++;
        hi = one();
        if (hi < lo) no('holds a range that runs backwards');
      }
      pos += lo === hi ? hex(lo) : `${hex(lo)}-${hex(hi)}`;
    }
    p++;
    return set(pos, negs, fold, negate);
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
        const perl = named();
        if (perl) {
          items.push(perl[1] ? set('', [perl[0]], flags.i, false) : set(perl[0], [], flags.i, false));
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
      for (let k = 0; k < (max < 0 && min > 0 ? min - 1 : min); k++) emit(sub);
      if (max < 0 && min > 0) {
        const start = at;
        emit(sub);
        push(SPLIT, start, at + 1);
      } else if (max < 0) {
        const split = push(SPLIT, at + 1);
        emit(sub);
        push(JMP, split);
        arg2[split] = at;
      } else {
        for (let k = min; k < max; k++) {
          const split = push(SPLIT, at + 1);
          emit(sub);
          arg2[split] = at;
        }
      }
    } else {
      push(node.t, node.k);
    }
  };
  emit(root);
  push(MATCH);
  return { size: steps, op, arg, arg2, sets };
}

// Whether `program` (`goPattern`) matches anywhere in `text`, as Go's MatchString answers.
// A lone surrogate reads as U+FFFD, as Go decodes one from JSON.
function matches(program, text) {
  const { size, op, arg, arg2, sets } = program;
  const cps = new Int32Array(text.length);
  let n = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0);
    cps[n++] = c >= 0xd800 && c <= 0xdfff ? 0xfffd : c;
  }
  const word = (c) => WORD[c] === 1;
  const holds = (k, prev, next) => {
    if (k === TEXT_START) return prev === -1;
    if (k === TEXT_END) return next === -1;
    if (k === LINE_START) return prev === -1 || prev === 10;
    if (k === LINE_END) return next === -1 || next === 10;
    return (word(prev) !== word(next)) === (k === BOUNDARY);
  };
  const mark = new Int32Array(size);
  const stack = new Int32Array(size);
  let gen = 1;
  // Adds to `list` (holding `len` threads) every consuming step reached from `start`
  // between the characters `prev` and `next` (-1 past either end); -1 when one matches.
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
      const o = op[pc];
      if (o === MATCH) return -1;
      if (o === JMP) visit(arg[pc]);
      else if (o === SPLIT) {
        visit(arg[pc]);
        visit(arg2[pc]);
      } else if (o === ASSERT) {
        if (holds(arg[pc], prev, next)) visit(pc + 1);
      } else list[len++] = pc;
    }
    return len;
  };
  let now = new Int32Array(size);
  let then = new Int32Array(size);
  let count = follow(now, 0, 0, -1, n > 0 ? cps[0] : -1);
  for (let i = 0; i < n && count >= 0; i++) {
    const c = cps[i];
    const next = i + 1 < n ? cps[i + 1] : -1;
    gen++;
    let added = 0;
    for (let k = 0; k < count && added >= 0; k++) {
      const pc = now[k];
      const o = op[pc];
      if (o === CHAR ? arg[pc] === c : o === SET ? sets[arg[pc]](c) : o === ANY || c !== 10) added = follow(then, added, pc + 1, c, next);
    }
    if (added >= 0) added = follow(then, added, 0, c, next);
    [now, then] = [then, now];
    count = added;
  }
  return count < 0;
}
