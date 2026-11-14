// The GraphQL document check: what the real tools send goes through, and nothing reaches
// past the pool's repository or the task's own item.

import assert from 'node:assert/strict';
import { checkGraphql, itemMismatch, knownMutations, parseDocument, searchConfined } from '../src/requester/graphql.js';
import { GH } from './lib/captured.mjs';
import { world } from './lib/world.mjs';

async function check(name, fn) {
  await fn();
  console.log(`PASS ${name}`);
}

const ROOTS = ['repository', 'viewer', 'rateLimit', '__type', 'search', 'node'];
const spec = (more = {}) => ({ forge: 'github', repo: 'o/r', roots: ROOTS, mutations: [], identity: 'me', ...more });
const review = spec({ item: { type: 'pr', number: 578 }, mutations: ['addPullRequestReviewThread', 'addPullRequestReviewThreadReply', 'deletePullRequestReviewComment'] });
const own = spec({ item: { type: 'pr', number: 579 }, mutations: ['addPullRequestReviewThreadReply', 'resolveReviewThread', 'markPullRequestReadyForReview'] });
const issues = spec({ item: { type: 'issue', number: 421 }, mutations: ['addComment', 'replaceActorsForAssignable', 'updateIssue', 'createPullRequest'] });
const gitlab = { forge: 'gitlab', repo: 'group/sub/proj', roots: ['project', 'currentUser'], mutations: [], identity: 'me' };

const ask = (s, query, variables, ctx = world()) => checkGraphql(s, variables === undefined ? { query } : { query, variables }, ctx);
async function allowed(s, query, variables, ctx) {
  const verdict = await ask(s, query, variables, ctx);
  assert.equal(verdict.ok, true, `${verdict.reason}\n${query.slice(0, 300)}`);
  return verdict;
}
async function refused(s, query, variables, pattern, ctx) {
  const verdict = await ask(s, query, variables, ctx);
  assert.equal(verdict.ok, false, `allowed: ${query.slice(0, 300)}`);
  assert.match(verdict.reason, pattern, query.slice(0, 300));
}
const IN = (inner, vars = '') => `query${vars} { repository(owner: "o", name: "r") { ${inner} } }`;

await check('every query the gh CLI sends for a task on o/r is allowed', async () => {
  const reads = ['prViewAuthor', 'prViewDefault', 'prProjectItems', 'prViewReviews', 'prViewMergeable', 'typeFields', 'prChecks', 'prList',
    'prSearch', 'prStatus', 'issueView', 'issueList', 'issueForEdit', 'userCurrent', 'repositoryInfo', 'prForBranch', 'prForReady'];
  for (const name of reads) {
    const verdict = await ask(spec(), GH[name].query, GH[name].variables);
    assert.equal(verdict.ok, true, `${name}: ${verdict.reason}`);
  }
});

await check('the reader takes the whole executable syntax: aliases, fragments, directives, strings, comments', async () => {
  const doc = parseDocument(`# a comment, with "quotes" and { braces
    query Q($n: Int = 3, $list: [String!]! = ["a"], $o: In = {k: [1, 2.5e3, -0, true, null, ENUM, "s"]}) @live {
      a: repository(owner: "\\u006f", name: "\\u{72}") @skip(if: false) { ...F ... on Repository @include(if: true) { id } ... { name } }
      viewer { text: bio(format: """ block "with" quotes \\""" inside """) }
    }
    fragment F on Repository @x(a: 1) { issues(first: $n) { nodes { title } } }`);
  assert.equal(doc.operations.length, 1);
  assert.deepEqual([...doc.operations[0].variables.keys()], ['n', 'list', 'o']);
  const [repository] = doc.operations[0].selections;
  assert.deepEqual([repository.alias, repository.name], ['a', 'repository']);
  assert.deepEqual(repository.args.map((a) => a.value.v), ['o', 'r'], 'unicode escapes are decoded before anything is compared');
  assert.deepEqual(repository.selections.map((s) => s.kind), ['spread', 'inline', 'inline']);
  assert.equal(doc.fragments.get('F').on, 'Repository');
  assert.equal(parseDocument('{ viewer { login } }').operations[0].type, 'query');
});

await check('a document that is not one well-formed operation is refused', async () => {
  const bad = [
    ['', /no operation/],
    ['query { viewer { login }', /expected a name/],
    ['{ viewer { login } } { viewer { login } }', /more than one operation/],
    ['query A { viewer { login } } query B { repository(owner: "x", name: "y") { id } }', /more than one operation/],
    ['subscription { viewer { login } }', /subscriptions/],
    ['type Query { a: Int }', /not an operation/],
    ['{ viewer { login } } fragment F on User { login } fragment F on User { id }', /defined twice/],
    ['query($a: Int, $a: Int) { viewer { login } }', /defined twice/],
    ['{ repository(owner: "o", owner: "x", name: "r") { id } }', /given twice/],
    ['{ viewer { ...Missing } }', /not defined/],
    ['{ viewer { ...A } } fragment A on User { ...B } fragment B on User { ...A }', /spreads itself/],
    ['{ viewer { login } } \u0000', /unexpected character/],
    ['{ viewer { login(a: "unterminated) } }', /unterminated|line break/],
    ['{ viewer { login(a: 1.) } }', /malformed number|stray/],
    ['{ viewer { login(a: 01) } }', /malformed number/],
    ['{ viewer { login(a: "\\x41") } }', /unknown escape/],
    ['{ viewer { login(a: "\\u{110000}") } }', /unicode escape/],
    ['query($a: Int = $b) { viewer { login } }', /constant is required/],
  ];
  for (const [query, pattern] of bad) await refused(spec(), query, undefined, pattern);
  for (const payload of [null, [], 'x', [{ query: '{ viewer { login } }' }, { query: '{ viewer { login } }' }]]) {
    assert.equal((await checkGraphql(spec(), payload, world())).ok, false, 'a batch or a non-object');
  }
  assert.match((await checkGraphql(spec(), { query: '{ viewer { login } }', extensions: { persistedQuery: {} } }, world())).reason, /unknown member/);
  assert.match((await checkGraphql(spec(), { query: 5 }, world())).reason, /not a string/);
  assert.match((await checkGraphql(spec(), { query: '{ viewer { login } }', variables: [] }, world())).reason, /variables/);
});

await check('an enormous or deeply nested document is refused before it is walked', async () => {
  const deep = `${'{ a '.repeat(40)}${'}'.repeat(40)}`;
  await refused(spec(), `query ${deep}`, undefined, /nested too deeply/);
  await refused(spec(), IN(`issues { nodes { title(a: ${'['.repeat(40)}1${']'.repeat(40)}) } }`), undefined, /nested too deeply/);
  await refused(spec(), IN('id '.repeat(30000)), undefined, /too large/);
  await refused(spec(), IN('a '.repeat(25000)), undefined, /too many tokens/);
  await refused(spec(), IN('a '.repeat(6000)), undefined, /too many fields/);
  // Thirteen fragments, each spreading the next twice, would be 2^13 fields if a fragment
  // were walked once per spread; it is walked once per context.
  const fragments = Array.from({ length: 13 }, (_, i) => `fragment F${i} on Repository { ...F${i + 1} x${i}: id ...F${i + 1} }`).join(' ');
  await allowed(spec(), `${IN('...F0')} ${fragments} fragment F13 on Repository { id }`);
});

await check('a query may select only the listed roots, and every root is checked, not the first', async () => {
  await refused(spec(), '{ repository(owner: "o", name: "r") { id } user(login: "victim") { repositories(first: 100) { nodes { name } } } }', undefined, /root field "user"/);
  await refused(spec(), '{ viewer { login } organization(login: "o") { id } }', undefined, /root field "organization"/);
  await refused(spec(), '{ repository(owner: "o", name: "r") { id } nodes(ids: ["R_other"]) { id } }', undefined, /root field "nodes"/);
  await refused(spec(), '{ ...on Query { viewer { login } enterprise(slug: "x") { id } } }', undefined, /root field "enterprise"/);
  await refused(spec(), '{ ...R } fragment R on Query { securityAdvisories(first: 1) { nodes { summary } } }', undefined, /root field "securityAdvisories"/);
  await refused(spec({ roots: ['repository'] }), '{ viewer { login } }', undefined, /root field "viewer"/);
  await refused(spec(), '{ repository }', undefined, /selects nothing/);
  await refused(spec({ roots: [...ROOTS, 'user'] }), '{ user(login: "x") { login } }', undefined, /cannot be confined/);
  await allowed(spec(), '{ __typename viewer { login } rateLimit { remaining resetAt } }');
});

await check('repository must name the pool\'s repository, whatever spells its arguments', async () => {
  await allowed(spec(), '{ repository(owner: "O", name: "R") { id } }');
  await allowed(spec(), 'query($o: String!, $n: String = "r") { repository(owner: $o, name: $n) { id } }', { o: 'o' });
  const elsewhere = [
    ['{ repository(owner: "o", name: "other") { id } }'],
    ['{ repository(owner: "victim", name: "r") { id } }'],
    ['{ a: repository(owner: "o", name: "r") { id } b: repository(owner: "o", name: "secret") { id } }'],
    ['query($o: String!, $n: String!) { repository(owner: $o, name: $n) { id } }', { o: 'o', n: 'other' }],
    ['query($o: String!, $n: String!) { repository(owner: $o, name: $n) { id } }', { o: 'o' }],
    ['query($o: String!, $n: String = "other") { repository(owner: $o, name: $n) { id } }', { o: 'o' }],
    ['query($o: String!, $n: String = "r") { repository(owner: $o, name: $n) { id } }', { o: 'o', n: null }],
    ['query($n: String!) { repository(owner: "o", name: $undefined) { id } }', { n: 'r' }],
    ['{ repository(owner: "o", name: """r""") { id } }'],
    ['{ repository(owner: ["o"], name: "r") { id } }'],
    ['{ repository(name: "r") { id } }'],
    ['{ repository(followRenames: true, owner: "o", name: "r/../other") { id } }'],
  ];
  for (const [query, variables] of elsewhere) await refused(spec(), query, variables, /does not name the pool's repository|not defined/);
});

await check('a selection cannot walk out of the repository through its owner, a fork or a cross-reference', async () => {
  const walks = [
    'owner { repositories(first: 100) { nodes { name } } }',
    'owner { ... on User { email organizations(first: 9) { nodes { login } } } }',
    'owner { ... on Organization { membersWithRole(first: 9) { nodes { login } } } }',
    'forks(first: 5) { nodes { name } }',
    'parent { issues(first: 5) { nodes { title } } }',
    'parent { object(expression: "main:secret.txt") { ... on Blob { text } } }',
    'pullRequest(number: 578) { author { ... on User { repositories(first: 100) { nodes { name isPrivate } } } } }',
    'pullRequest(number: 578) { headRepository { refs(first: 9, refPrefix: "refs/heads/") { nodes { name } } } }',
    'pullRequest(number: 578) { headRepository { object(expression: "HEAD:.env") { ... on Blob { text } } } }',
    'issue(number: 421) { timelineItems(first: 9) { nodes { ... on CrossReferencedEvent { source { ... on Issue { body } } } } } }',
    'issue(number: 421) { timelineItems(first: 9) { nodes { ... on ReferencedEvent { commit { message } } } } }',
    'issue(number: 421) { subIssues(first: 9) { nodes { body } } }',
    'issue(number: 421) { projectItems(first: 9) { nodes { project { items(first: 9) { nodes { id } } } } } }',
    'issue(number: 421) { participants(first: 9) { nodes { gists(first: 9) { nodes { name } } } } }',
    'collaborators(first: 9) { nodes { login } }',
    'deployKeys(first: 9) { nodes { key } }',
    'vulnerabilityAlerts(first: 9) { nodes { id } }',
    'discussions(first: 9) { nodes { title } }',
    'ref(qualifiedName: "main") { compare(headRef: "victim:main") { commits(first: 1) { nodes { message } } } }',
    'viewerPermission secrets: environments(first: 9) { nodes { name } }',
  ];
  for (const inner of walks) await refused(spec(), IN(inner), undefined, /may not be read|not a field this task may select/);
  await allowed(spec(), IN('owner { login } parent { nameWithOwner owner { login } } pullRequest(number: 9) { headRepository { nameWithOwner isPrivate } }'));
  await allowed(spec(), IN('issue(number: 421) { timelineItems(first: 9) { nodes { ... on CrossReferencedEvent { actor { login } source { ... on Issue { number title url } } } } } }'));
});

await check('the viewer gives its name and nothing it owns', async () => {
  await allowed(spec(), '{ viewer { login id name databaseId url avatarUrl } }');
  for (const inner of ['repositories(first: 100) { nodes { nameWithOwner } }', 'organizations(first: 9) { nodes { login } }', 'gists(first: 9) { nodes { name } }',
    'bio', 'company', 'location', 'status { message }', 'sponsorshipsAsSponsor(first: 9) { totalCount }', 'repository(name: "secret") { id }', 'publicKeys(first: 9) { nodes { key } }']) {
    await refused(spec(), `{ viewer { ${inner} } }`, undefined, /may not be read|not a field this task may select/);
  }
});

await check('an alias is a label and hides nothing', async () => {
  await refused(spec(), '{ repository: viewer { login: repositories(first: 100) { nodes { name } } } }', undefined, /"repositories" is not a field/);
  await refused(spec(), '{ viewer: user(login: "victim") { login } }', undefined, /root field "user"/);
  await refused(spec(), '{ repository: repository(owner: "o", name: "other") { id } }', undefined, /does not name/);
  await refused(spec(), '{ viewer { login: email2 name: privateEmail } }', undefined, /may not be read/);
  await refused(spec(), IN('issues: owner { id: repositories { nodes { id } } }'), undefined, /"repositories" is not a field/);
});

await check('a fragment is read wherever it is spread, in the context it is spread in', async () => {
  const frag = 'fragment Leak on User { repositories(first: 100) { nodes { name } } }';
  await refused(spec(), `{ viewer { ...Leak } } ${frag}`, undefined, /"repositories" is not a field/);
  await refused(spec(), `{ viewer { ... on User { ... on User { ...Leak } } } } ${frag}`, undefined, /"repositories" is not a field/);
  await refused(spec(), `{ viewer { ...A } } fragment A on User { login ...B } fragment B on User { ...Leak } ${frag}`, undefined, /"repositories" is not a field/);
  // The same fragment is fine inside the repository and too wide on an account.
  const body = 'fragment Body on Node { body }';
  await allowed(spec(), `${IN('issue(number: 1) { ...Body }')} ${body}`);
  await refused(spec(), `${IN('issue(number: 1) { ...Body author { ...Body } }')} ${body}`, undefined, /"body" may not be read on a user/);
  await refused(spec(), `${IN('issue(number: 1) { author { ...Body } ...Body }')} ${body}`, undefined, /"body" may not be read on a user/);
});

await check('a directive never switches a check off', async () => {
  await refused(spec(), 'query($x: Boolean!) { viewer { login repositories(first: 9) @include(if: $x) { nodes { name } } } }', { x: false }, /"repositories" is not a field/);
  await refused(spec(), 'query($x: Boolean!) { viewer { login } user(login: "v") @skip(if: $x) { login } }', { x: true }, /root field "user"/);
  await refused(spec(), 'query($x: Boolean!) { viewer { ...L @include(if: $x) } } fragment L on User { email2 }', { x: false }, /may not be read/);
  await refused(spec(), 'query($x: Boolean!) { viewer { ... on User @skip(if: $x) { secret } } }', { x: true }, /may not be read/);
});

await check('a search is confined to the pool\'s repository and to issues and pull requests', async () => {
  const q = (query, type = 'ISSUE') => ask(spec(), 'query($q: String!, $t: SearchType!) { search(query: $q, type: $t, first: 5) { issueCount nodes { ... on Issue { title } } } }', { q: query, t: type });
  assert.equal((await q('repo:o/r is:open fix')).ok, true);
  assert.equal((await q('( fix ) repo:O/R type:pr', 'ISSUE_ADVANCED')).ok, true);
  for (const type of ['REPOSITORY', 'USER', 'DISCUSSION', 'issue', null]) assert.equal((await q('repo:o/r x', type)).ok, false, String(type));
  const table = [
    ['repo:o/r is:open', null],
    ['author:@me repo:o/r state:open type:pr', null],
    ['"fix it" repo:o/r', null],
    ['repo:o/r (label:bug OR label:crash)', null],
    ['is:open', /not pinned/],
    ['repo:o/other', /other than the pool/],
    ['repo:o/r repo:o/secret', /other than the pool/],
    ['repo:o/r org:o', /other than the pool/],
    ['repo:o/r user:victim', /other than the pool/],
    ['repo:o/r owner:victim', /other than the pool/],
    ['repo:o/r OR is:private', /top-level OR/],
    ['repo:o/r or is:private', /top-level OR/],
    ['(repo:o/r) is:private', /other than the pool/],
    ['NOT repo:o/r', /other than the pool/],
    ['-repo:o/r', /other than the pool/],
    ['repo:"o/r" x', /other than the pool/],
    ['repo:o/r "unclosed', /not a whole quoted term/],
    ['repo:o/r )x(', /parentheses/],
    ['repo:o/r (x', /unbalanced/],
    ['repo:o/r\u0000 org:x', /control character/],
    // A separator the forge may split on and this reader would not, and the other way round.
    ['repo:o/r x\u0085repo:evil/y', /control character/],
    ['repo:o/r x repo:evil/y', /space that is not the plain one/],
    ['repo:o/r x　repo:evil/y', /space that is not the plain one/],
    ['repo:o/r x repo:evil/y', /space that is not the plain one/],
    ['repo:o/r\tx', /control character/],
    ['repo:o/rr', /other than the pool/],
    ['Repo:O/R REPO:victim/x', /other than the pool/],
    [5, /not a string/],
  ];
  for (const [query, why] of table) {
    const got = searchConfined(query, 'o/r');
    if (why === null) assert.equal(got, null, String(query));
    else assert.match(String(got), why, String(query));
  }
});

await check('a quote in a search opens a phrase where both readers agree it does, and a phrase hides no qualifier', async () => {
  const fine = ['repo:o/r "fix bug"', '"fix bug" repo:o/r', 'repo:o/r label:"good first issue" -label:"wont fix"', 'repo:o/r ("a b" OR "c d")', 'repo:o/r NOT "a b"', 'repo:o/r -"a b"', 'repo:o/r ""'];
  for (const q of fine) assert.equal(searchConfined(q, 'o/r'), null, q);
  const split = [
    'repo:o/r a" repo:evil/x "b', 'repo:o/r a"b repo:evil/x c"d', 'repo:o/r x"y"', 'repo:o/r "a""b"', 'repo:o/r "a"b', 'repo:o/r label:x"y z"', 'repo:o/r "a b"c repo:evil/x',
    'repo:o/r"x" org:evil "y"', 'repo:o/r a\\" repo:evil/x \\"b', 'repo:o/r l:a:"b c"',
  ];
  for (const q of split) assert.match(String(searchConfined(q, 'o/r')), /quote that is not a whole quoted term|other than the pool/, q);
  for (const q of ['repo:o/r "see repo:evil/x"', '"repo:x/y" repo:o/r', 'repo:o/r "org:evil"', 'repo:o/r label:"user:victim x"']) assert.match(String(searchConfined(q, 'o/r')), /a quoted term that holds a qualifier/, q);
  // The pin is one term, once.
  assert.match(String(searchConfined('repo:o/r repo:o/r fix', 'o/r')), /not pinned/);
  assert.match(String(searchConfined('repo:o/r "repo:o/r"', 'o/r')), /holds a qualifier/);
  const viaGraphql = (q) => ask(spec(), 'query($q: String!) { search(query: $q, type: ISSUE, first: 5) { issueCount } }', { q });
  assert.match((await viaGraphql('repo:o/r a" repo:evil/x "b')).reason, /quote that is not a whole quoted term/);
  assert.match((await ask(spec(), '{ search(query: "repo:o/r a\\" repo:evil/x \\"b", type: ISSUE, first: 5) { issueCount } }')).reason, /quote that is not a whole quoted term/);
  assert.equal((await viaGraphql('repo:o/r "fix bug"')).ok, true);
});

await check('nothing is let out past what a kind needs: no organisation looked up through an account, no branch protection', async () => {
  await refused(spec(), '{ viewer { organization(login: "secret-org") { id login } } }', undefined, /"organization" takes arguments/);
  await refused(spec(), IN('pullRequest(number: 578) { author { ... on User { organization(login: "secret-org") { id } } } }'), undefined, /"organization" takes arguments/);
  await refused(spec(), IN('issue(number: 421) { assignees(first: 5) { nodes { organization(login: "secret-org") { viewerIsAMember: id } } } }'), undefined, /"organization" takes arguments/);
  await refused(spec(), 'query($o: String!) { viewer { o: organization(login: $o) { name } } }', { o: 'secret-org' }, /"organization" takes arguments/);
  await refused(spec(), IN('parent { project(number: 3) { name url } }'), undefined, /"project" takes arguments/);
  await refused(spec(), IN('pullRequest(number: 578) { headRepository { defaultBranchRef(x: 1) { name } } }'), undefined, /"defaultBranchRef" takes arguments/);
  await refused(spec(), IN('ref(qualifiedName: "refs/heads/main") { branchProtectionRule { pattern requiresApprovingReviews } }'), undefined, /"pattern" may not be read of a branch's protection/);
  await refused(spec(), IN('refs(refPrefix: "refs/heads/", first: 5) { nodes { name branchProtectionRule { requiresStrictStatusChecks requiredApprovingReviewCount } } }'), undefined, /"requiredApprovingReviewCount" may not be read of a branch's protection/);
  await refused(spec(), IN('ref(qualifiedName: "refs/heads/main") { branchProtectionRule { pushAllowances(first: 5) { nodes { actor { ... on User { login } } } } } }'), undefined, /"pushAllowances" is not a field/);
  await refused(spec(), IN('ref(qualifiedName: "refs/heads/main") { branchProtectionRule { creator { login } } }'), undefined, /"creator" is not a field/);
  // What gh asks of a requested reviewer's team, of a commit's author, of a project item and of a base branch stays.
  await allowed(spec(), IN('pullRequest(number: 578) { reviewRequests(first: 5) { nodes { requestedReviewer { ... on Team { organization { login } name slug } } } } commits(last: 1) { nodes { commit { author { user { login } avatarUrl(size: 64) } } } } }'));
  await allowed(spec(), IN('issue(number: 421) { projectItems(first: 5) { nodes { id project { id title } status: fieldValueByName(name: "Status") { ... on ProjectV2ItemFieldSingleSelectValue { optionId name } } } } }'));
  await allowed(spec(), IN('pullRequest(number: 578) { baseRef { branchProtectionRule { requiresStrictStatusChecks } } }'));
});

await check('node(id:) is resolved first and must be an object of the pool\'s repository', async () => {
  const q = 'query($id: ID!) { node(id: $id) { ... on PullRequest { title } } }';
  const ctx = world();
  await allowed(spec(), q, { id: 'PR_578' }, ctx);
  assert.deepEqual(ctx.asked, ['PR_578']);
  await refused(spec(), q, { id: 'PR_elsewhere' }, /not in the pool's repository/);
  await refused(spec(), q, { id: 'R_other' }, /not in the pool's repository/);
  await refused(spec(), q, { id: 'U_me' }, /not in the pool's repository/);
  await refused(spec(), q, { id: 'nothing' }, /not an object the forge would show/);
  await refused(spec(), q, {}, /literal id/);
  await refused(spec(), q, { id: 578 }, /literal id/);
  await refused(spec(), '{ node(id: "PR_578") { ... on PullRequest { author { ... on User { repositories { nodes { id } } } } } } }', undefined, /"repositories" is not a field/);
  await refused(spec(), `{ ${Array.from({ length: 9 }, (_, i) => `n${i}: node(id: "PR_578") { id }`).join(' ')} }`, undefined, /too many objects/);
  await refused(spec(), q, { id: 'PR_578' }, /nothing here can resolve/, {});
});

await check('a mutation is one listed field whose object belongs to the task\'s item', async () => {
  const ctx = world();
  await allowed(review, GH.addThread.query, GH.addThread.variables, ctx);
  assert.deepEqual(ctx.asked, ['PRR_mine'], 'the review was looked up before the answer');
  await allowed(review, GH.addReply.query, GH.addReply.variables);
  await allowed(own, GH.resolveThread.query, { t: 'PRRT_579' });
  await allowed(own, GH.prReady.query, { input: { pullRequestId: 'PR_579' } });
  await allowed(issues, GH.issueComment.query, GH.issueComment.variables);
  await allowed(issues, GH.issueUpdateNothing.query, GH.issueUpdateNothing.variables);

  // Not on the task's list, though the check knows the name.
  await refused(review, GH.resolveThread.query, GH.resolveThread.variables, /mutation "resolveReviewThread" is not allowed/);
  await refused(spec({ item: own.item, mutations: ['addPullRequestReviewThreadReply', 'resolveReviewThread'] }), GH.prReady.query, { input: { pullRequestId: 'PR_579' } }, /not allowed/);
  // On nobody's list.
  for (const name of ['mergePullRequest', 'closePullRequest', 'updatePullRequest', 'deleteRef', 'createRef', 'addPullRequestReview', 'submitPullRequestReview',
    'dismissPullRequestReview', 'deleteIssueComment', 'enablePullRequestAutoMerge', 'createCommitOnBranch', 'updateRepository', 'addStar']) {
    await refused(spec({ item: review.item, mutations: [name] }), `mutation($input: X!) { ${name}(input: $input) { clientMutationId } }`, { input: { pullRequestId: 'PR_578' } }, /is not allowed/);
    assert.ok(!knownMutations('github').includes(name), name);
  }
  await refused(review, GH.prReviewShortcut.query, GH.prReviewShortcut.variables, /"addPullRequestReview" is not allowed/);
});

await check('a mutation addressed at another pull request, issue or repository is refused before it is sent', async () => {
  await refused(review, GH.addReply.query, { ...GH.addReply.variables, t: 'PRRT_579' }, /belongs to #579, not #578/);
  await refused(own, GH.resolveThread.query, { t: 'PRRT_578' }, /belongs to #578, not #579/);
  await refused(own, GH.prReady.query, { input: { pullRequestId: 'PR_578' } }, /belongs to #578/);
  await refused(own, GH.prReady.query, { input: { pullRequestId: 'PR_elsewhere' } }, /not in the pool's repository/);
  await refused(issues, GH.issueComment.query, { input: { subjectId: 'I_422', body: 'x' } }, /belongs to #422, not #421/);
  await refused(issues, GH.prCommentShortcut.query, GH.prCommentShortcut.variables, /is a PullRequest/);
  await refused(own, GH.resolveThread.query, { t: 'PR_579' }, /is a PullRequest/);
  await refused(own, GH.resolveThread.query, { t: 'gone' }, /not an object the forge would show/);
  await refused(own, GH.resolveThread.query, { t: null }, /needs "threadId"/);
  await refused(own, GH.resolveThread.query, {}, /needs "threadId"/);
  await refused(own, 'mutation { resolveReviewThread(input: {threadId: """PRRT_579"""}) { thread { id } } }', undefined, /not a node id/);
  await refused(spec({ mutations: ['resolveReviewThread'] }), GH.resolveThread.query, { t: 'PRRT_579' }, /no pull request or issue of its own/);
});

await check('a review may only be written into the task\'s own pending review', async () => {
  const thread = (rid) => ask(review, GH.addThread.query, { ...GH.addThread.variables, rid });
  assert.match((await thread('PRR_theirs')).reason, /not written by this task's account/);
  assert.match((await thread('PRR_sent')).reason, /not part of a pending review/);
  assert.match((await thread('PRR_579')).reason, /belongs to #579/);
  assert.match((await thread('PRRT_578')).reason, /is a PullRequestReviewThread/);
  await refused(review, GH.addReply.query, { ...GH.addReply.variables, rid: 'PRR_theirs' }, /not written by this task's account/);
  const del = 'mutation($id: ID!) { deletePullRequestReviewComment(input: {id: $id}) { clientMutationId } }';
  await allowed(review, del, { id: 'PRRC_mine' });
  await refused(review, del, { id: 'PRRC_theirs' }, /not written by this task's account/);
});

await check('a mutation carries nothing the table does not name, and cannot be doubled', async () => {
  await refused(review, 'mutation($i: I!) { addPullRequestReviewThreadReply(input: $i) { comment { id } } }', { i: { pullRequestReviewThreadId: 'PRRT_578', body: 'x', event: 'APPROVE' } }, /"event" is not an input/);
  await refused(issues, GH.issueUpdateNothing.query, { input: { id: 'I_421', state: 'CLOSED' } }, /"state" is not an input/);
  await refused(issues, GH.issueUpdateNothing.query, { input: { id: 'I_421', title: 'renamed' } }, /"title" is not an input/);
  await refused(own, 'mutation($t: ID!) { a: resolveReviewThread(input: {threadId: $t}) { thread { id } } b: resolveReviewThread(input: {threadId: "PRRT_578"}) { thread { id } } }', { t: 'PRRT_579' }, /exactly one field/);
  await refused(own, 'mutation($t: ID!) { resolveReviewThread(input: {threadId: $t}) { thread { id } } ...M } fragment M on Mutation { mergePullRequest(input: {pullRequestId: "PR_579"}) { clientMutationId } }', { t: 'PRRT_579' }, /exactly one field/);
  await refused(own, 'mutation($t: ID!) { resolveReviewThread(input: {threadId: $t}, other: 1) { thread { id } } }', { t: 'PRRT_579' }, /one argument/);
  await refused(own, 'mutation($t: ID!) { resolveReviewThread(input: [{threadId: $t}]) { thread { id } } }', { t: 'PRRT_579' }, /not an object/);
  await refused(own, 'mutation($t: ID!) { resolveReviewThread(input: {threadId: $t}) { thread { pullRequest { author { ... on User { repositories { nodes { name } } } } } } } }', { t: 'PRRT_579' }, /"repositories" is not a field/);
  await refused(own, `query($t: ID!) { resolveReviewThread(input: {threadId: $t}) { thread { id } } }`, { t: 'PRRT_579' }, /root field "resolveReviewThread"/);
});

await check('assignment may add or remove only the task\'s own account', async () => {
  const assign = (logins, ctx = world()) => ask(issues, GH.assignSelf.query, { input: { assignableId: 'I_421', actorLogins: logins } }, ctx);
  assert.equal((await assign(['bob', 'Me'])).ok, true);
  assert.equal((await assign(['bob'])).ok, true, 'removing itself');
  assert.match((await assign(['me'])).reason, /only add or remove this task's own account/, 'bob would be dropped');
  assert.match((await assign(['bob', 'me', 'mallory'])).reason, /only add or remove/);
  assert.match((await assign([])).reason, /only add or remove/);
  assert.match((await assign('me')).reason, /not a list of logins/);
  await refused(issues, GH.assignSelf.query, { input: { assignableId: 'I_422', actorLogins: ['bob', 'me'] } }, /belongs to #422/);
  await refused(issues, GH.assignSelf.query, { input: { assignableId: 'I_421', actorLogins: ['bob'], actorIds: ['U_x'] } }, /"actorIds" is not an input/);
  await refused(spec({ mutations: ['replaceActorsForAssignable'], item: { type: 'pr', number: 578 } }), GH.assignSelf.query, { input: { assignableId: 'PR_578', actorLogins: ['me'] } }, /is a PullRequest|no issue to assign/);
});

await check('a pull request is opened as a draft, in the pool\'s repository, from a branch the task created', async () => {
  const pushed = world({ branches: ['refs/heads/fix-421'] });
  const verdict = await allowed(issues, GH.prCreate.query, GH.prCreate.variables, pushed);
  assert.deepEqual(verdict.effects, [{ pull: 'fix-421' }], 'the caller checks the branch against the key\'s state');
  const input = GH.prCreate.variables.input;
  await refused(issues, GH.prCreate.query, { input: { ...input, draft: false } }, /"draft" to be true/);
  const { draft: _draft, ...ready } = input;
  await refused(issues, GH.prCreate.query, { input: ready }, /needs "draft"/);
  await refused(issues, GH.prCreate.query, { input: { ...input, repositoryId: 'R_other' } }, /not in the pool's repository/);
  await refused(issues, GH.prCreate.query, { input: { ...input, repositoryId: 'PR_578' } }, /is not a repository/);
  await refused(issues, GH.prCreate.query, { input: { ...input, headRepositoryId: 'R_other' } }, /"headRepositoryId" is not an input/);
  await refused(issues, GH.prCreate.query, { input: { ...input, headRefName: ['fix-421'] } }, /not a branch name/);
});

await check('a job covering every open pull request by an author checks each object\'s pull request', async () => {
  const mine = spec({ item: { type: 'pr', author: 'me' }, mutations: ['resolveReviewThread'] });
  await allowed(mine, GH.resolveThread.query, { t: 'PRRT_579' });
  await refused(mine, GH.resolveThread.query, { t: 'PRRT_578' }, /#578 was not opened by me/);
  await refused(mine, GH.resolveThread.query, { t: 'PRRT_580' }, /#580 is not open/);
  const others = { type: 'pr', notAuthor: 'me' };
  assert.equal(itemMismatch(others, world().nodes.PRRT_578), null);
  assert.match(itemMismatch(others, world().nodes.PRRT_579), /was opened by me/);
  assert.match(itemMismatch({ type: 'issue', number: 421 }, world().nodes.PRRT_578), /not part of an issue/);
  assert.match(itemMismatch(undefined, world().nodes.PRRT_578), /no pull request or issue/);
});

await check('GitLab queries are confined to the pool\'s project, and GitLab gets no mutation', async () => {
  await allowed(gitlab, '{ currentUser { username name } }');
  await allowed(gitlab, 'query($p: ID!) { project(fullPath: $p) { mergeRequest(iid: "5") { title author { username } discussions { nodes { notes { nodes { body author { username } } } } } headPipeline { status jobs { nodes { name status } } } } } }', { p: 'Group/Sub/Proj' });
  await refused(gitlab, '{ project(fullPath: "group/sub/other") { name } }', undefined, /does not name the pool's project/);
  await refused(gitlab, '{ project(fullPath: "group/sub/proj") { group { projects { nodes { fullPath } } } } }', undefined, /"projects" is not a field/);
  await refused(gitlab, '{ project(fullPath: "group/sub/proj") { mergeRequest(iid: "5") { author { authoredMergeRequests { nodes { title } } } } } }', undefined, /not a field/);
  await refused(gitlab, '{ currentUser { username groups { nodes { fullPath } } } }', undefined, /"groups" is not a field/);
  await refused(gitlab, '{ currentUser { publicEmail } }', undefined, /may not be read/);
  for (const root of ['projects(membership: true) { nodes { fullPath } }', 'group(fullPath: "group") { name }', 'user(username: "x") { name }', 'repository(owner: "o", name: "r") { id }',
    'mergeRequest(id: "gid://gitlab/MergeRequest/1") { title }', 'namespace(fullPath: "group") { name }', 'search(query: "x") { nodes { id } }']) {
    await refused(gitlab, `{ ${root} }`, undefined, /is not allowed for this task/);
  }
  await refused(gitlab, 'mutation { mergeRequestAccept(input: {projectPath: "group/sub/proj", iid: "5", sha: "x"}) { errors } }', undefined, /is not allowed/);
  assert.deepEqual(knownMutations('gitlab'), []);
  assert.match((await checkGraphql({ ...gitlab, forge: 'gitea' }, { query: '{ viewer { login } }' })).reason, /unknown forge/);
});
