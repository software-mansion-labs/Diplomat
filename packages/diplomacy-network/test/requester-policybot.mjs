// Reading a policy-bot policy: the YAML it is written in and the Go patterns it holds. Each
// expected answer is what yaml.v2 v2.4.0 and Go's regexp give for the same input.

import assert from 'node:assert/strict';
import { approvalFault, readPolicy, textFault } from '../src/requester/policybot.js';

async function check(name, fn) {
  await fn();
  console.log(`PASS ${name}`);
}

const policyOf = (yaml) => Object.assign(readPolicy(yaml), { from: ['o/r/.policy.yml'] });
const asked = (policy) => ({ policy: async () => policy });
const commentPatterns = (...sources) => `comment_patterns: [${sources.map((s) => `'${s.replace(/'/g, "''")}'`).join(', ')}]\n`;
// Whether policy-bot's Go regexp finds `source` in a comment `text`.
const finds = async (source, text) => (await textFault(asked(policyOf(commentPatterns(source))), 'main', text, 'comment')) !== null;

await check('a pattern matches what Go\'s regexp matches', async () => {
  for (const [source, texts] of [
    ['(?i)\\blgtm', [['\u017flgtm', true], ['xlgtm', false], ['LGTM', true]]],
    ['(?i)\\x{17F}hip', [['ship', true], ['SHIP', true], ['\u017fhip', true], ['hip', false]]],
    ['(?m)^lgtm$', [['ok\nlgtm\nthanks', true], ['ok lgtm', false], ['lgtm\n', true], ['lgtm', true]]],
    ['^lgtm$', [['lgtm', true], ['lgtm\n', false], ['\nlgtm', false]]],
    ['(?s)a.b', [['a\nb', true]]],
    ['a.b', [['a\nb', false], ['axb', true], ['a\u000db', true], ['a\u2028b', true], ['a\u2029b', true], ['a\u{1f44d}b', true]]],
    ['\\Aok\\z', [['ok', true], ['ok\n', false], ['ook', false]]],
    ['(?i:LGTM)|Ship', [['lgtm', true], ['ship', false], ['Ship', true]]],
    ['[[:upper:]]{3}\\d', [['ABC1', true], ['abc1', false], ['AB1', false]]],
    ['\\Q+1\\E', [['a +1', true], ['11', false]]],
    ['\\Q+1', [['+1', true]]],
    ['\\pL\\p{Greek}', [['a\u03b2', true], ['ab', false]]],
    ['a{02}', [['a{02}', true], ['aa', false]]],
    ['a{2,03}', [['a{2,03}', true], ['aa', false]]],
    ['a{02,}', [['a{02,}', true], ['aaa', false]]],
    ['^a{2}$', [['aa', true], ['a', false], ['aaa', false]]],
    ['^a{2,}$', [['aaa', true], ['a', false]]],
    ['^a{1,2}b', [['ab', true], ['aab', true], ['b', false], ['aaab', false]]],
    ['^a{0}b', [['b', true], ['ab', false]]],
    ['x{,2}', [['x{,2}', true], ['xx', false]]],
    ['x{1', [['x{1', true]]],
    ['^x{1$', [['x', false], ['x{1', true]]],
    ['^a+b', [['b', false], ['ab', true]]],
    ['^a?b$', [['aab', false], ['ab', true], ['b', true]]],
    ['(?i)[^\\P{Lu}]', [['A', true], ['a', true], ['1', false], ['\u01c5', true]]],
    ['[^\\P{Lu}]', [['A', true], ['a', false]]],
    ['(?i)\\P{Lu}', [['A', false], ['a', false], ['1', true]]],
    ['\\p{^Lu}', [['A', false], ['a', true]]],
    ['\\P{^Lu}', [['A', true], ['a', false]]],
    ['a\\sb', [['a\u000bb', false], ['a\u000cb', true], ['a b', true]]],
    ['a\\Sb', [['a\u000bb', true], ['a b', false]]],
    ['[\\S]', [['\u000b', true], [' ', false]]],
    ['[^\\s]', [['\u000b', true]]],
    ['[[:space:]]', [['\u000b', true]]],
    ['\\d\\D', [['1a', true], ['12', false]]],
    ['\\w\\W', [['a!', true], ['ab', false]]],
    ['[^\\d\\s]', [['a', true], ['1', false], [' ', false]]],
    ['\\101\\0', [['A\u0000', true]]],
    ['^\\12', [['\n', true]]],
    ['^\\0123', [['\n3', true]]],
    ['\\x41\\x{42}', [['AB', true]]],
    ['\\a\\f\\t\\n\\r\\v', [['\u0007\u000c\u0009\n\u000d\u000b', true]]],
    ['\\ \\_\\.', [[' _.', true], [' _x', false]]],
    ['[[:^alpha:]]', [['1', true], ['a', false]]],
    ['[^[:^alpha:]]', [['a', true], ['1', false]]],
    ['(?U)a+', [['a', true]]],
    ['a+?b', [['aab', true]]],
    ['a??b', [['b', true]]],
    ['\\p{greek}\\p{Letter}', [['\u03b2a', true], ['a', false]]],
    ['\\p{Cased-Letter}', [['a', true], ['1', false]]],
    ['\\p{Lc}', [['a', true]]],
    ['\\p{ascii}', [['a', true], ['\u00e9', false]]],
    ['\\p{Any}', [['\u00e9', true]]],
    ['\\p{Assigned}', [['a', true], ['\u0377', true], ['\u0378', false], ['\u0379', false], ['\u037a', true]]],
    ['\\p{Old_Italic}', [['\u{10300}', true], ['a', false]]],
    ['\\pN', [['1', true], ['a', false]]],
    ['(?i)\\W', [['\u017f', false], ['\u212a', false], ['!', true]]],
    ['(?i)\\w', [['\u017f', true]]],
    ['\\w', [['\u017f', false]]],
    ['(?i)k', [['\u212a', true], ['K', true]]],
    ['(?i)[k-l]', [['\u212a', true]]],
    ['(?i)[^k]', [['\u212a', false]]],
    ['(?i)\u03c3', [['\u03c2', true], ['\u03a3', true]]],
    ['(?i)[k]', [['s\u212a', true], ['S', false]]],
    ['(?i)[[:^alpha:]]', [['\u017f', false], ['1', true]]],
    ['(?i)[\\x{1c4}-\\x{1c6}]x', [['\u01c5x', true], ['x', false]]],
    ['[[:alpha:][:digit:]]+$', [['a1', true], ['-', false]]],
    ['(?i)\\Qlgtm\\E', [['LGTM', true]]],
    ['\\Qlgtm\\E', [['LGTM', false]]],
    // Go folds \p only for the names unicode.FoldCategory, unicode.FoldScript or its own ASCII
    // table hold: the Cased_Letter U+0345 folds to is not added.
    ['(?im)^\\P{LC}*lgtm\\P{LC}*$', [['lgtm\u0345', true], ['\u0345lgtm', true], ['lgtmx', false]]],
    ['(?i)\\p{Cased_Letter}', [['\u0345', false], ['a', true]]],
    ['\\p{LC}', [['\u02b0', false], ['\u01c5', true]]],
    ['(?i)\\p{Ll}', [['\u0345', true], ['\u212a', true]]],
    ['(?i)\\p{Greek}', [['\u00b5', true], ['k', false]]],
    ['(?i)\\p{ASCII}', [['\u212a', true], ['\u017f', true], ['\u00e9', false]]],
    ['(?i)\\pL', [['\u0345', true], ['1', false]]],
    ['\\pL', [['\u0345', false]]],
    ['(?i)\\p{Lt}', [['\u01c6', true], ['a', false]]],
    ['(?i)\\pM', [['\u03b9', true], ['a', false]]],
    ['(?i)\\p{Mn}', [['\u03b9', true]]],
    ['(?i)\\p{Mark}', [['\u03b9', true]]],
    ['(?i)\\p{Common}', [['\u03bc', true], ['a', false]]],
    ['(?i)\\p{Inherited}', [['\u0399', true]]],
    ['(?i)\\p{Lo}', [['\u0345', false]]],
    ['[a-zb-c]', [['x', true], ['B', false]]],
    ['\\b\u00e9', [['\u00e9', false], ['a\u00e9', true]]],
    ['x\\B', [['x', false], ['xy', true]]],
    ['^\\B$', [['', true]]],
    ['[]a]', [[']', true]]],
    ['[^]a]', [[']', false], ['b', true]]],
    ['[a-]', [['-', true]]],
    ['[-a]', [['-', true]]],
    ['[\\d-z]', [['-', true], ['5', true], ['y', false]]],
    ['[a\\-z]', [['-', true], ['b', false]]],
    ['[[]', [['[', true]]],
    ['[[:]', [[':', true]]],
    ['(?P<n>a)(?<m>b)\\z', [['ab', true]]],
    ['(?:a|b)c', [['bc', true], ['c', false]]],
    ['^(?:a|)$', [['', true], ['b', false]]],
    ['^(|a)b', [['b', true]]],
    ['^()$', [['', true], ['a', false]]],
    ['^a(?i)b|c', [['aB', true], ['C', true]]],
    ['(?i)a(?-i)b', [['Ab', true], ['AB', false]]],
    ['(?i:a)b', [['AB', false], ['Ab', true]]],
    ['(?s-i:.)A', [['\nA', true], ['\na', false]]],
    ['(?m)a$', [['a\nb', true]]],
    ['(?)a', [['a', true]]],
    ['^a(?i)*$', [['', true], ['aa', true]]],
    ['^(a*)*b', [['b', true], ['aab', true], ['c', false]]],
    ['^(?:a|aa)*$', [['aaa', true], ['aab', false]]],
    ['\\x{fffd}', [['\ud800', true]]],
    ['^.$', [['\ud800', true], ['\u{1f44d}', true]]],
    ['\u00e9+', [['\u00e9\u00e9', true]]],
    ['^a\\Q\\E*$', [['', true], ['aa', true]]],
    ['^((a{2}){0}){600}b', [['b', true]]],
    ['^(a(?i))b', [['aB', false], ['ab', true]]],
  ]) {
    for (const [text, match] of texts) assert.equal(await finds(source, text), match, `${source} on ${JSON.stringify(text)}`);
  }
  // A pattern Go does not compile is refused.
  for (const source of ['\\1', 'a{1001}', '\\8', '(a{100}){100}', '\\p{Latn}', 'x**', '(?i-)', '(?-)', '\\x{}', '\\x{110000}', '\\xG0', '[z-a]', '[a-\\d]', '[[:foo:]]', '\\p{}', '(?P<>a)', '(?<1->a)', '(a', 'a)', '*a', 'a|*', '\\C', '\\Z', '\\\u00e9', 'a\\', '[a', '\\p{Greek', '(?x)', 'x{2}{3}', 'x*{2}', '(?i)*', '\\Q\\E*', '[\\b]', 'a{2,1}', 'a**?', 'a{1,1001}', 'a{1001,}', '(?-i-m)', '\\x4', '\\x{41']) {
    assert.throws(() => readPolicy(commentPatterns(source)), /^Error: its pattern /, source);
  }
  // So is one too large for this to match, which Go compiles.
  assert.throws(() => readPolicy(commentPatterns('x{1000}'.repeat(101))), /compiles to 101001 steps, more than the 100000 this matches$/);
});

// Resolves to what `fn` resolves to, asserting that a 100 ms timer set before it fired less
// than a second late: a check is bounded to about 200 ms on the slowest machine measured,
// and what this guards against took seconds or minutes.
async function onTime(fn) {
  const started = performance.now();
  const late = new Promise((resolve) => setTimeout(() => resolve(performance.now() - started - 100), 100));
  const out = await fn();
  assert.ok((await late) < 1000, 'a 100 ms timer fires within a second of its time');
  return out;
}

await check('a check counts the work it does, and text that takes more than its budget is refused', async () => {
  const fault = (yaml, text) => onTime(() => textFault(asked(policyOf(yaml)), 'main', text, 'comment'));
  const tooLong = /^is too long for this to check in time against the patterns of the pool repository's policy-bot policy \(o\/r\/\.policy\.yml\): shorten it and send the request again$/;
  const [dotStar, words] = ['(?i).*lgtm', '(?i)(\\w+\\s?)+:\\s*approved'];
  // On 2^17 a's the first takes 1,048,579 of the budget's 3,000,000 steps and the second
  // 2,097,147: each is checked alone, and not both, the work of every pattern counting
  // against the one budget; a pattern named twice is matched once.
  const as = 'a'.repeat(2 ** 17);
  assert.equal(await fault(commentPatterns(dotStar), as), null);
  assert.equal(await fault(commentPatterns(words), as), null);
  assert.match(await fault(commentPatterns(dotStar, words), as), tooLong);
  assert.equal(await fault(commentPatterns(words, words), as), null);
  // A mebibyte is refused as soon as the budget is spent.
  assert.match(await fault(commentPatterns(dotStar, words), 'a'.repeat(2 ** 20)), tooLong);
  // Work is counted within a character too: at the first, a thousand threads each look for
  // it and what it folds to in a class of 80,000 parts, 1.6 billion steps uncounted.
  assert.match(await fault(commentPatterns(`(?i)(?:[${'\\pL'.repeat(80000)}]?){1000}x`), '\u2160'), tooLong);
  // So is each search for what a character folds to: "k" folds to two others, each looked
  // for in each of a thousand parts, 18,000 steps a character of which its own take 6,000.
  assert.match(await fault(commentPatterns(`(?i)[${'\\p{Greek}'.repeat(1000)}]`), 'k'.repeat(300)), tooLong);
  // The longest text GitHub takes is checked, with a match only where Go finds one.
  const longest = 'word '.repeat(13107);
  assert.equal(await fault(commentPatterns(dotStar, words), longest), null);
  assert.match(await fault(commentPatterns(dotStar, words), `${longest.slice(10)}x: approved`), /^matches the pattern "\(\?i\)\(\\\\w\+\\\\s\?\)\+:\\\\s\*approved"/);
  // So it is under a policy of 40 rules, each with the methods of policy-bot's README.
  const rules = Array.from({ length: 40 }, (_, k) => [
    `- name: team ${k}`,
    '  options:',
    '    methods:',
    "      comment_patterns: ['^Signed-off by \\s+$']",
    "      github_review_comment_patterns: ['\\b(?i)domain\\s*lgtm\\b']",
  ].join('\n'));
  assert.equal(await fault(`approval_rules:\n${rules.join('\n')}\n`, 'Looks reasonable to me, thanks. '.repeat(2048)), null);
});

await check('a policy of at most 256 KiB is read, and its patterns compiled, in time linear in it', async () => {
  const cap = 256 * 1024;
  // Bytes are counted, not characters.
  assert.equal(readPolicy(`comments: [${'x'.repeat(cap - 13)}]\n`).comments[0].length, cap - 13);
  assert.throws(() => readPolicy(`comments: [${'x'.repeat(cap - 12)}]\n`), /^Error: it is 262145 bytes long, more than the 262144 this reads$/);
  assert.throws(() => readPolicy(`comments: [${'一'.repeat(87378)}]\n`), /^Error: it is 262147 bytes long/);
  // Policies near the cap, each of a shape that took seconds or minutes to read.
  const fill = (head, unit, tail) => head + unit.repeat(Math.floor((cap - 64 - head.length - tail.length) / unit.length)) + tail;
  const read = (yaml) => onTime(async () => readPolicy(yaml));
  assert.deepEqual((await read(`approval_rules:\n- name: x${' '.repeat(100000)}y\n`)).comments, []);
  assert.deepEqual((await read(fill('comments:\n- b', ' ', '#c\n'))).comments, ['b']);
  assert.equal((await read(fill('comments:\n- x', ' ', 'y\n'))).comments[0].length, cap - 77);
  assert.equal((await read(fill('comments: [', "'a', ", "'a']\n"))).comments.length, 52413);
  assert.equal((await read(fill('', '- comments: [a]\n', ''))).comments.length, 16380);
  assert.equal((await read(fill("comment_patterns: ['[", '[:a', "]']\n"))).patterns.length, 1);
  // A class refers to the tables it names, without copying them: 15,400 such classes under
  // (?i) check a body of 10 characters each class folds, and refuse one of 30 at the budget.
  const classes = `body_patterns: ['(?i)(?:${Array(15400).fill('[\\p{L}\\p{N}一]').join('|')})Q']\n`;
  const body = (n) => Array.from({ length: n }, (_, k) => String.fromCodePoint(0x4e01 + k)).join('');
  assert.equal(await onTime(() => textFault(asked(policyOf(classes)), 'main', body(10), 'body')), null);
  assert.match(await onTime(() => textFault(asked(policyOf(classes)), 'main', body(30), 'body')), /^is too long for this to check in time/);
  // A policy of 30,000 of them is over the cap.
  assert.throws(() => readPolicy(classes.replace('(?:', `(?:${'[\\p{L}\\p{N}一]|'.repeat(14600)}`)), /^Error: it is 480028 bytes long/);
});

await check('every approval method that reads text is collected, wherever the policy holds it', async () => {
  const policy = readPolicy([
    'approval_defaults:',
    '  options:',
    '    methods: { comments: [":shipit:"] }',
    'approval_rules:',
    '- name: x',
    '  options:',
    '    methods:',
    '      comments: &words',
    '      - LGTM',
    '      - "ship it"',
    '      github_review_comment_patterns: ["^ok$"]',
    '      body_patterns:',
    "      - '(?i)approved'",
    'policy:',
    '  disapproval:',
    '    options:',
    '      methods:',
    '        disapprove: { comments: *words, comment_patterns: [nope] }',
    '',
  ].join('\n'));
  assert.deepEqual(policy.comments, [':shipit:', 'LGTM', 'ship it', 'LGTM', 'ship it']);
  assert.deepEqual(policy.patterns.map((p) => p.source), ['^ok$', 'nope']);
  assert.deepEqual(policy.bodies.map((p) => p.source), ['(?i)approved']);
  // An empty entry is the empty string to yaml.v2, which every text holds.
  assert.deepEqual(readPolicy('approval_rules:\n- options:\n    methods:\n      comments:\n      - ~\n').comments, ['']);
  assert.deepEqual(readPolicy('remote: o/policies\npath: p.yml\n'), { remote: { repo: 'o/policies', path: 'p.yml', ref: '' } });
  // A member besides remote, path and ref makes the file a policy of its own (go-githubapp appconfig/yaml.go).
  assert.deepEqual(readPolicy('remote: o/policies\ncomments: [x]\n'), { comments: ['x'], patterns: [], bodies: [] });
  assert.deepEqual(readPolicy('remote: ~\npath: p.yml\n'), { comments: [], patterns: [], bodies: [] });
  // What this does not read is refused: a tag, a scalar where a list goes, a mapping inside a
  // flow list, a value after a flow list, text quoted over lines.
  for (const [text, said] of [
    ['comments: !!str x\n', /line 1/], ['comments: |\n  lgtm\n', /"comments" is not a list/], ['comments: [a: b]\n', /flow collection/],
    ['comments: [a] b\n', /^Error: its line 1 holds more than one value$/], ['comments: ["a\nb"]\n', /^Error: its line 1 holds quoted text that goes on past the line$/],
    ['comments: [a,\n!b]\n', /^Error: its line 2 holds a kind of YAML this does not read$/],
  ]) {
    assert.throws(() => readPolicy(text), said, text);
  }
  // A space or a tab ends a key at its ":" and starts a comment at its "#"; a key holds every
  // other ":" (as yaml.v2 reads each of these).
  for (const [text, comments] of [
    ['comments:\t[a]\n', ['a']], ['comments\t: [a]\n', ['a']], ['comments  : [a]\n', ['a']], ['comments:x: [a]\n', []],
    ['comments:\n- a#b\n', ['a#b']], ['comments:\n- a\t#b\n', ['a']], ['comments:\n- a\t\n', ['a']],
  ]) {
    assert.deepEqual(readPolicy(text).comments, comments, text);
  }
  // A block scalar of blank lines alone is empty, its lines' spaces dropped, unless it says how far it is indented.
  assert.deepEqual(readPolicy('comments:\n- |\n   \n\n- ship it\n').comments, ['', 'ship it']);
  assert.deepEqual(readPolicy('comments:\n- |+\n   \n').comments, ['\n']);
  assert.deepEqual(readPolicy('comments:\n- |2\n   \n').comments, [' \n']);
  // yaml.v2 also breaks a line at a lone CR, U+0085, U+2028 and U+2029 (in quotes, as a space), which this does not read.
  assert.deepEqual(readPolicy('comments:\r\n- LGTM\r\n').comments, ['LGTM']);
  for (const code of [0x0d, 0x85, 0x2028, 0x2029]) {
    const hex = code.toString(16).toUpperCase().padStart(4, '0');
    assert.throws(() => readPolicy(`comments: ["LGTM${String.fromCharCode(code)}x"]\n`), new RegExp(`^Error: its line 1 holds a line break this does not read \\(U\\+${hex}\\)$`), hex);
  }
});

await check('text is refused for policy-bot\'s default words, and for what the policy it is checked against reads', async () => {
  assert.equal(approvalFault('+1, thumbs up'), null);
  assert.match(approvalFault('ok 👍🏽'), /^holds "👍", which policy-bot, a bot that gates merging, counts as an approval or a disapproval from whoever wrote it/);
  const ctx = (answer) => ({ policy: async (base) => (base === 'main' ? answer : null) });
  const policy = readPolicy('comments: [LGTM, ~]\nbody_patterns: [ready]\n');
  policy.from = ['o/r/.policy.yml'];
  assert.match(await textFault(ctx(policy), 'main', 'anything', 'comment'), /^holds "", which the pool repository's policy-bot policy \(o\/r\/\.policy\.yml\) counts/);
  assert.match(await textFault(ctx(policy), 'main', 'not yet ready', 'body'), /^matches the pattern "ready"/);
  assert.equal(await textFault(ctx(policy), 'main', 'LGTM', 'body'), null);
  assert.equal(await textFault(ctx(policy), 'dev', 'LGTM', 'comment'), null);
  assert.match(await textFault(ctx({ fault: 'odd' }), 'main', 'x', 'comment'), /: odd$/);
  assert.match(await textFault({}, 'main', 'x', 'comment'), /^cannot be checked/);
  assert.match(await textFault(ctx(null), undefined, 'x', 'body'), /names no base branch/);
});
