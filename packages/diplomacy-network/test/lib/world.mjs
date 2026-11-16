// A forge that exists only in memory, for the checks that ask it questions: what the
// lookups of `forge.context()` answer, as plain data a test can read and change.

const on = (number, author, more = {}) => ({ repo: 'o/r', item: 'pr', number, open: true, itemAuthor: author, ...more });

/// The `ctx` of `authorize` over a small fixed forge: `o/r` with pull request 578 (opened
/// by "them", head `feature`), 579 (opened by "me", head `mine`), 580 (closed), 581 (opened
/// by "me" from `forked` in `me/r`, that account's fork of `o/r`) and issue 421. `me` is
/// the account the credential belongs to. `ctx.asked` lists the node ids looked up and
/// `ctx.listed` what `pullsByHead` was asked, as [ref, owner, ever].
export function world({ branches = [] } = {}) {
  const repos = {
    'o/r': { id: 1, name: 'o/r', owner: 'o', parent: '', defaultBranch: 'main', ciPaths: [] },
    'me/r': { id: 12, name: 'me/r', owner: 'me', parent: 'o/r', defaultBranch: 'main', ciPaths: [] },
    'me/mine': { id: 13, name: 'me/mine', owner: 'me', parent: '', defaultBranch: 'main', ciPaths: [] },
  };
  const nodes = {
    R_1: { type: 'Repository', repo: 'o/r' },
    R_other: { type: 'Repository', repo: 'o/other' },
    U_me: { type: 'User', login: 'me' },
    PR_578: { type: 'PullRequest', ...on(578, 'them'), author: 'them' },
    PR_579: { type: 'PullRequest', ...on(579, 'me'), author: 'me' },
    PR_elsewhere: { type: 'PullRequest', ...on(578, 'them'), repo: 'o/other', author: 'them' },
    PRR_mine: { type: 'PullRequestReview', ...on(578, 'them'), author: 'me', pending: true },
    PRR_sent: { type: 'PullRequestReview', ...on(578, 'them'), author: 'me', pending: false },
    PRR_theirs: { type: 'PullRequestReview', ...on(578, 'them'), author: 'someone', pending: true },
    PRR_579: { type: 'PullRequestReview', ...on(579, 'me'), author: 'me', pending: true },
    PRRT_578: { type: 'PullRequestReviewThread', ...on(578, 'them'), author: '' },
    PRRT_579: { type: 'PullRequestReviewThread', ...on(579, 'me'), author: '' },
    PRRT_580: { type: 'PullRequestReviewThread', ...on(580, 'me', { open: false }), author: '' },
    PRRC_mine: { type: 'PullRequestReviewComment', ...on(578, 'them'), author: 'me', pending: true },
    PRRC_theirs: { type: 'PullRequestReviewComment', ...on(578, 'them'), author: 'them', pending: false },
    PRRC_579: { type: 'PullRequestReviewComment', ...on(579, 'me'), author: 'them', pending: false },
    I_421: { type: 'Issue', repo: 'o/r', item: 'issue', number: 421, open: true, itemAuthor: 'reporter', author: 'reporter' },
    I_422: { type: 'Issue', repo: 'o/r', item: 'issue', number: 422, open: true, itemAuthor: 'reporter', author: 'reporter' },
  };
  const pulls = {
    578: { number: 578, open: true, author: 'them', headRepo: 'o/r', headRepoId: 1, headRef: 'feature' },
    579: { number: 579, open: true, author: 'Me', headRepo: 'o/r', headRepoId: 1, headRef: 'mine' },
    580: { number: 580, open: false, author: 'me', headRepo: 'o/r', headRepoId: 1, headRef: 'old' },
    581: { number: 581, open: true, author: 'me', headRepo: 'me/r', headRepoId: 12, headRef: 'forked' },
  };
  // 14 is this account's and already sent, 15 somebody's and still pending, 16 this account's pending one in another repository.
  const comments = {
    11: nodes.PRRC_mine, 12: nodes.PRRC_theirs, 13: nodes.PRRC_579,
    14: { ...nodes.PRRC_mine, pending: false }, 15: { ...nodes.PRRC_mine, author: 'someone' }, 16: { ...nodes.PRRC_mine, repo: 'o/other' },
  };
  const asked = [];
  const listed = [];
  return {
    asked, listed, nodes, pulls, repos,
    assigned: ['bob'],
    state: { branches: [...branches] },
    async resolveNode(id) { asked.push(id); return nodes[id] ?? null; },
    async pull(number) { return pulls[number] ?? null; },
    async pullsByHead(ref, owner, ever) {
      listed.push([ref, owner, ever]);
      return Object.values(pulls).filter((p) => (ever || p.open) && (ref === undefined || p.headRef === ref));
    },
    async comment(id) { return comments[id] ?? null; },
    async assignees() { return this.assigned; },
    async self() { return { id: 7, login: 'me' }; },
    async repository(of = 'o/r') { return repos[of] ?? null; },
  };
}
