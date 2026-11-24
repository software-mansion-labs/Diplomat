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
    ['\\p{Assigned}', [['a', true], ['\u0378', false]]],
    ['\\p{Old_Italic}', [['\u{10300}', true], ['a', false]]],
    ['\\pN', [['1', true], ['a', false]]],
    ['(?i)\\W', [['\u017f', false], ['\u212a', false], ['!', true]]],
    ['(?i)\\w', [['\u017f', true]]],
    ['\\w', [['\u017f', false]]],
    ['(?i)k', [['\u212a', true], ['K', true]]],
    ['(?i)[k-l]', [['\u212a', true]]],
    ['(?i)[^k]', [['\u212a', false]]],
    ['(?i)\u03c3', [['\u03c2', true], ['\u03a3', true]]],
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

await check('a check takes time linear in the text, and text too long to check in time is refused', async () => {
  const policy = policyOf(commentPatterns('(?i).*lgtm', '(?i)(\\w+\\s?)+:\\s*approved'));
  const started = performance.now();
  const late = new Promise((resolve) => setTimeout(() => resolve(performance.now() - started - 100), 100));
  // A mebibyte against either pattern is more than a check may cost.
  for (const text of ['a'.repeat(2 ** 20), 'ab '.repeat(2 ** 18)]) {
    assert.match(await textFault(asked(policy), 'main', text, 'comment'), /^is too long for this to check in time against the patterns of the pool repository's policy-bot policy \(o\/r\/\.policy\.yml\): shorten it and send the request again$/);
  }
  // The longest text GitHub takes is checked, with a match only where Go finds one.
  const longest = 'word '.repeat(13107);
  assert.equal(await textFault(asked(policy), 'main', longest, 'comment'), null);
  assert.match(await textFault(asked(policy), 'main', `${longest.slice(10)}x: approved`, 'comment'), /^matches the pattern "\(\?i\)\(\\\\w\+\\\\s\?\)\+:\\\\s\*approved"/);
  // None of it kept a timer from firing on time.
  assert.ok((await late) < 100, 'a 100 ms timer fires within 100 ms of its time');
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
  // What this does not read is refused: a tag, a scalar where a list goes, a mapping inside a flow list.
  for (const [text, said] of [['comments: !!str x\n', /line 1/], ['comments: |\n  lgtm\n', /"comments" is not a list/], ['comments: [a: b]\n', /flow collection/]]) {
    assert.throws(() => readPolicy(text), said, text);
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
