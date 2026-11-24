// Reading a policy-bot policy: the YAML it is written in and the Go patterns it holds. Each
// expected answer is what yaml.v2 v2.4.0 and Go's regexp give for the same input.

import assert from 'node:assert/strict';
import { approvalFault, readPolicy, textFault } from '../src/requester/policybot.js';

async function check(name, fn) {
  await fn();
  console.log(`PASS ${name}`);
}

const pattern = (source) => readPolicy(`comment_patterns: ['${source.replace(/'/g, "''")}']\n`).patterns[0];

await check('a pattern matches what Go\'s regexp matches', async () => {
  for (const [source, texts] of [
    // Go's \b counts ASCII word characters alone, while (?i) folds ſ to s and K (U+212A) to k.
    ['(?i)\\blgtm', { 'ſlgtm': true, xlgtm: false, LGTM: true }],
    ['(?i)\\x{17F}hip', { ship: true, SHIP: true, 'ſhip': true }],
    ['(?m)^lgtm$', { 'ok\nlgtm\nthanks': true, 'ok lgtm': false }],
    ['(?s)a.b', { 'a\nb': true }],
    ['a.b', { 'a\nb': false, axb: true }],
    ['\\Aok\\z', { ok: true, 'ok\n': false }],
    ['(?i:LGTM)|Ship', { lgtm: true, ship: false, Ship: true }],
    ['[[:upper:]]{3}\\d', { ABC1: true, abc1: false }],
    ['\\Q+1\\E', { 'a +1': true, 11: false }],
    ['\\pL\\p{Greek}', { 'aβ': true, ab: false }],
  ]) {
    const { re } = pattern(source);
    for (const [text, match] of Object.entries(texts)) assert.equal(re.test(text), match, `${source} on ${JSON.stringify(text)}`);
  }
  // What this cannot translate faithfully is refused, not guessed.
  for (const source of ['(?U)a+', '[[:^alpha:]]', '[\\S]', '\\1', 'a{1001}']) assert.throws(() => pattern(source), /pattern/, source);
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
