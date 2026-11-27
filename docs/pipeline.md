# Pipeline

Every open issue of the GitHub repo roots and the tracked Linear teams, and every open PR of yours,
rated for risk and complexity and routed: a low-risk, low-complexity issue goes down the **fast
track**, from issue to fix PR to merge with no person reading the change; everything else is left
to a person, unless you [hand it to Diplomat](#takeover). It ships **off**, every switch of it too,
and its state is the trackers' own labels.

## What it does

Every five minutes while it is on, a **sync**:

1. **Reads** each GitHub root's open issues and PRs (`gh api graphql`, a page at a time) and the
   tracked Linear teams' open issues, and links them: an issue to the PR that fixes it, a parent to
   its children, a PR to the PR stacked on it.
2. **Rates** items, by the [definitions below](#ratings): each rating is a queued job, whose answer
   the next sync writes as labels where Diplomat [may write](#who-diplomat-may-write-to).
3. **Routes** a low/low issue down the [fast track](#the-fast-track): its fix PR, that PR reviewed
   until clean, rated again at the clean head, and merged.
4. **Splits** one medium- or high-complexity issue into low-complexity
   [sub-issues](#fracturing).

Labels, child issues and the merge are done by the sync itself, in code. The fix and review runs are
agents and each rating a headless `claude -p` job, all queued like a sweep's asks: behind the [task cap](automation.md#autonomous-monitors), the
[spending budget](automation.md#the-spending-budget) and the disk floor, and held while the ban list cannot be
read and, after a launch or the pipeline going on, until a sync since has judged their item. A run is asked for once (a review
once per head, a new head's no sooner than an hour after the last one was queued or, if it ran, began),
retried on the monitors' backoff when a run dies, and taken off the queue when a later
sync no longer owes it - one you started with Start fix only once a sync that read its repo in full
finds its issue held or no candidate; any other by a sync that could not read its repo in full only
if it read that item, never by one that only read and showed the repo. One a sweep, Slack or the
new-community-issue monitor asks for too is theirs, which nothing of the pipeline's holds or withdraws.
An item whose author is on the
prompt-injection ban list, as read right before each step, and every issue Diplomat split from one, is
not rated, labelled, split or fixed, nor a PR closing it reviewed or merged; a Linear issue's author is
its creator's display name. Nor is a part whose parent's author is unknown, nor, with a notice, any
item once the ban list (`~/.diplomat/pr-monitor/banned.json`) could not be read in a sync; a missing
one bans no one. The activity feed gets a line for each ask
queued or withdrawn, each merge and split, each new notice, and the sync failing or recovering.

What it does not do:

- write to anything that is not [yours to write to](#who-diplomat-may-write-to) - that is shown, read only;
- rate someone else's PR: it shows the labels a person put on it;
- lower a rating: a label already on an item is its rating, and Diplomat writes only the higher of
  that, the model's answer and a PR's [diff floor](#the-diff-floor);
- approve a PR: GitHub does not let you approve your own, so the clean review is a COMMENT and the
  merge uses your [admin rights](#the-merge);
- fast-track a PR of yours that closes no issue or one that is not a `candidate`, that was rated while
  **Fast-track my PRs** was off, or that a person took a fast-track label off, unless you take it over;
- comment on, assign or close a Linear issue, or hand its login to an agent;
- read GitLab roots.

## Stages

An issue, the first row that holds from the bottom up:

| Stage | When | Lane |
|---|---|---|
| `unrated` | no rating yet | Unrated |
| `candidate` | rated low/low and not triaged, or [taken over](#takeover), and Diplomat may write to it | Fast |
| `human` | rated anything else or triaged, either unless taken over, or low/low but assigned to someone else, tracked on GitHub, or held by a Linear issue tracking it | Human |
| `fractured` | labelled `diplomat:fractured`, or it has sub-issues (Linear: children) | Fractured |
| `fixing` | an open PR fixes it | the PR's: Fast while it is on the fast track, else Human |
| `closed` | closed, and linked from a merged or closed PR on the graph or read for an ask waiting on it | Done |

A PR:

| Stage | When | Lane |
|---|---|---|
| `unrated` | no rating yet | Unrated |
| `human` | rated, and not on the fast track; every PR that is not yours, once a person labelled it | Human |
| `fast-track` | yours, labelled `diplomat:fast-track`, closing only `candidate` issues, at least one unless taken over, no clean marker at its head | Fast |
| `clean` | the same, with a clean marker at its head | Fast |
| `cleared` | labelled `diplomat:cleared`, clean at its head, and rated low/low again there by this Diplomat (its state or log says so), or, taken over, labelled so there by this Diplomat | Fast |
| `merged`, `closed` | one of the repo's 20 merged or closed PRs updated last, carrying a pipeline label, or read for an ask waiting on it | Done |

An issue labelled `wontfix`, `wont fix`, `won't fix`, `duplicate`, `invalid`, `question`,
`enhancement`, `feature`, `feature request`, `improvement`, `discussion`, `proposal` or `rfc` in any
case and by its letters and digits alone, before or after a `prefix:` or `prefix/` (`type: Feature`,
`kind/feature`, `enhancement: pending triage`, `feature-request`; `pipeline.json` `triageLabels`, on
Linear too), of a GitHub issue type other than Bug, or in a Linear triage or duplicate state, is
**triaged**: never a `candidate` unless taken over, nor split, and its hold is `triaged as <that label, type or state>`.
Nothing carrying a [stop label](#the-merge), matched the same way (`[WIP]`, `🚧 wip`), is rated, split,
fixed, reviewed or merged, nor a PR closing it merged; an item carrying one is held
`carries the label <label>`. A Linear issue an attachment links to a GitHub issue is that issue's work:
never a `candidate` nor split, and held `it is tracked on GitHub as <owner/repo#N>`. The GitHub issue
carries that Linear issue's other holds, held `it is tracked on Linear as <ID>: <its hold>`; and while
a Linear team was not read whole, no issue in the repo it maps to is fixed, split or closed by a merge.

### The fast track

1. A `candidate` issue gets a [Fix-issues](actions.md#fix-issues) run (**Open fix PRs**), told it
   is on the fast track: the smallest fix, a regression test that fails on the base branch, and the
   closing reference kept so the PR links to the issue. The run first reads the issue again and
   stops if it is closed, assigned to someone else, or an open PR already fixes it. A Linear
   issue's run is not given the Linear login, so the sync reads the issue again right before asking, and holds
   it if it is no longer a candidate or its links changed; the run gets its text as that read found
   it, checks only for an open PR naming it, works in the root its team names and puts
   `Fixes ENG-12` in its PR's description.
2. The PR is rated on its own (**Rate issues and PRs**), from its text and diff, never below its
   [diff floor](#the-diff-floor). Every open PR of yours is rated, not only the ones Diplomat opened.
3. Low/low at its first rating (its timeline showed no rating or fast-track label before it) and
   closing only `candidate` issues (the fast track is for the fixes the pipeline asks for), it is
   labelled `diplomat:fast-track` (**Fast-track my PRs**); a PR rated while that is off, rated
   anything else, or that the label could not be put on stays a person's, the last with a hold
   saying so. A max-depth review run is queued for its head. It reviews the
   PR and fixes what it finds on the branch until a full pass at the head finds nothing, LOW
   findings included, then posts one COMMENT review whose body begins
   `Clean at <head sha>`: the **clean marker**. A marker counts only on your own review, submitted
   at the commit it names.
4. At the clean head the PR is rated again, once per head: the answer is recorded as it arrives,
   so a sync stopped before its labels never asks again for that head. Still low/low, it is labelled
   `diplomat:cleared`; anything else, its labels written or not, takes both labels off and leaves it
   to a person until you [take it over](#takeover).
5. A cleared PR is [merged](#the-merge) (**Merge cleared PRs**) once nothing holds it.

A head no clean marker names, as after a push, takes `diplomat:cleared` off, and the PR goes back
to `fast-track` for a review of that head. A person who takes `diplomat:cleared` off a PR before
Diplomat does takes it off the fast track until you [take it over](#takeover): Diplomat neither
labels, reviews nor merges it again, and takes `diplomat:fast-track` off too, so the labels say so. One who
takes `diplomat:fast-track` off leaves it to a person: Diplomat puts that label back only for a takeover.

An issue's rating covers its title and body when rated, though its fix run also reads later edits
and comments: what merges is judged on the PR itself, by its rating, its diff floor, the review and
the rating at the clean head.

### Takeover

**Authorize takeover** on the screen hands Diplomat an item it leaves to a person, **whatever its
rating, triage or diff floor**:

- An issue becomes a `candidate`: its fix is asked for as any candidate's (**Open fix PRs**, else
  **Start fix**), and it is split only if you press **Fracture**. The PR that fix opens is rated on
  its own, and goes down the fast track only if low/low or taken over itself.
- A PR of yours, with **Fast-track my PRs** on, is labelled `diplomat:fast-track` and reviewed until
  clean. It may close no issue, and each it closes counts as taken over, but must be one Diplomat may
  fix. It is cleared at its clean head with no second rating, and so merges (**Merge cleared PRs**)
  **at any rating or [diff floor](#the-diff-floor)**: a change to CI, a lockfile or a secret included,
  with no person reading it. Every other [hold](#the-merge) still stands.

What took a PR off the fast track before, a re-rating or a label a person took off, no longer
counts. A takeover is refused for an item Diplomat may not write to, one carrying a stop label or of
a banned author, one in a root read in part or whose Linear team has no root, while the ban list
cannot be read, an issue split already, fixed by an open PR, tracked on GitHub or held by a Linear
issue tracking it, and a PR closing an issue Diplomat may not fix. **Revoke takeover** takes it back,
a PR off the fast track until taken over again. Pressed while a sync runs, it reaches that sync
too, through `control.json`: no merge or ask after it acts on the takeover. A takeover also ends once a sync that reads every source whole finds its item
closed, and a PR's when a person takes a fast-track label off it.

## Ratings

Two dimensions, each `low`, `medium` or `high`, by these definitions (`pipeline.json` `levels`). The
rater gets them word for word and is told to pick the higher level when unsure between two:

| | low | medium | high |
|---|---|---|---|
| **Complexity** - the surface of the change | a fix restoring clearly intended behaviour; at most 2 source files and 30 source lines; no new abstraction; no interface change | any feature or refactor, or a change a maintainer could reasonably disagree with; or one internal interface changed | more than one feature, a public interface, a data format, persistence, or internals other features rely on |
| **Risk** - the cost of that change being wrong | a mistake reaches only the bug's own inputs, shows at once and reverts cleanly; nothing sensitive | a mistake can reach other inputs or ship unnoticed | sensitive ground (security, auth, secrets, data, money, concurrency, build, release, CI) or untested paths |

A rating is one `claude -p` call: `sonnet` for an issue, `opus` for a PR, whose rating decides a
merge (`rater.model`, `rater.prModel`). It runs in the root's checkout (for a Linear issue, its
team's root) with the read-only tools `Read`, `Grep` and `Glob`, none of them pre-approved, so
`claude -p` lets them read nothing outside the checkout; no MCP servers, no slash commands and no
settings. It answers only through a JSON schema: `risk`, `complexity` and one sentence of `why`.
The title and body (up to 6000 characters), and a PR's diff at the head its rating is saved under (up
to 20,000), are on its stdin, fenced as untrusted data.

A sync asks for ratings until four wait past the ones you asked for with **Rate now**, in this
order, newest first within each: your fast-track PRs clean at their head and awaiting the second
rating, your unrated open PRs, unrated issues Diplomat may write to, other unrated issues. An issue
already split or being fixed is not rated, nor is a Linear issue whose team has no repo root. Until
its answer is applied, an item is neither fixed nor merged. An ask its item has moved past (a PR
pushed to, an item labelled or closed meanwhile) is dropped, its answer unread, and a PR asked about
again at its new head; one you cancel in the queue is not made again until **Rate now**. A failed
call is a notice, and the item is tried again 1, 2, 4 ... syncs later (a day at most), taking none
of the four slots meanwhile.

Labels for both dimensions are the item's rating (two of one dimension: the higher), and it is not
rated again but for the fast track's second rating or when you ask. A rating Diplomat writes is the
higher of the labels already there, the model's answer, a rating kept for it and the diff floor, a
dimension at a time. Each answer is kept on this machine as it arrives, until its labels are written,
so it is not paid for again; one whose labels could not be written comes with a notice. A kept rating
counts over lower labels, holding the item, moves nothing down the fast track, and its labels are
written at a later sync, tried again 1, 2, 4 ... syncs later, unless a PR's diff at its head allows
less: then it is dropped, and the PR is rated by its labels again, or rated anew without them.

### The diff floor

An open PR's files, as GitHub lists them, put a floor under its rating in code (`pipeline.json`
`floor`):

| The diff | Floor |
|---|---|
| a denied path: a directory such as `.github`, `.claude`, `fastlane`, `vendor` or `node_modules` anywhere in it, or a file such as `package.json`, a lockfile, `Dockerfile*`, `Makefile`, a CI or release config, a toolchain pin, `AndroidManifest.xml`, `*.plist`, `.env*`, `*.pem`, `CODEOWNERS` or `CLAUDE.md` | risk high |
| no test file changed | risk medium |
| a file added outside a test directory, deleted, renamed or copied (anything but modified) | risk medium |
| a file with no changed lines (binary, or a mode change) | risk medium |
| more than 6 files | complexity medium |
| more than 2 files, or more than 30 lines (added + deleted), outside tests | complexity medium |
| more than 300 test lines | complexity medium |

A test file is one under a `test`, `tests`, `__tests__` or `testdata` directory, or named like
`test_*`, `*_test.*`, `*.test.*`, `*_spec.*` or `*.spec.*`. Rating a PR also floors it by its diff:
a moved submodule makes risk high, and a diff longer than the 20,000 characters the rater reads
makes complexity medium. The model can rate above the floor, never below it, and Diplomat neither
puts a PR whose floor is not low/low on the fast track nor merges it, whatever its labels say, unless
you [take it over](#takeover).

## Who Diplomat may write to

Diplomat labels, splits, fixes and merges only:

- a GitHub issue with no assignee, or assigned to you alone;
- a Linear issue with no assignee, or assigned to the Linear login's user;
- your own PR, from a branch of the repository itself (not a fork), into its default branch, with no
  assignee or assigned to you alone.

Each label, part and merge waits on a read of its item made right before it, and is not made if
that read fails or the item is no longer one of these.

"You" is the account `gh` acts as in that root, and a notice says so when the
[GitHub username](settings.md#settings) names another. Everything else
is read, shown with a lock, and left alone: a rating Diplomat made of it stays on this machine, and
someone else's PR is rated only by the labels a person put on it. A PR of yours into another branch
(stacked on another PR) is never fast-tracked.

## Labels

| Label | Meaning |
|---|---|
| `risk:low`, `risk:medium`, `risk:high` | the risk rating |
| `complexity:low`, `complexity:medium`, `complexity:high` | the complexity rating |
| `diplomat:fast-track` | your PR rated low/low at its first rating, closing only `candidate` issues, or taken over; reviewed until clean |
| `diplomat:cleared` | rated low/low again at its clean head by this Diplomat, or put on there for a takeover: only the [holds](#the-merge) stand before the merge |
| `diplomat:fractured` | an issue split into sub-issues, labelled before the first is filed |

They are the pipeline's state, read case-insensitively, and a person can set or remove any of them,
but a `diplomat:cleared` this Diplomat did not give counts for nothing, and taking either fast-track
label off a PR takes it off the [fast track](#the-fast-track). A missing GitHub label is
created in its repo on first use; on Linear the team's label of that name in any case is used, else
the workspace's, made if there is neither.

## Fracturing

With **Split big issues** on, a sync splits at most one issue Diplomat may write to that is medium or
high complexity and not high risk, not triaged or taken over, with no stop label, no sub-issues, no open PR fixing it (nor, on
Linear, attachments past what one read lists), and a repo root to read its code in that this sync
read whole. **Fracture** on the screen splits one at once, whatever its
rating. One `claude -p` call (`sonnet`, sandboxed as a rating is) reads the code and answers two to
six parts, each low complexity by itself, together exactly what the issue asks, each one fix or a
group of fixes that only work together, independent of the others, as none is fixed waiting for
another to merge - or no parts, and why, as for an issue asking for anything new. One part is no split.

The parent is labelled `diplomat:fractured` first, the split recorded in `state.json` before that,
then each part becomes a real child, so the trackers themselves keep the graph: on GitHub an issue
made a **sub-issue** of the parent, on Linear an issue created with the parent as its **parent**.
Each child's title and body are the model's, stripped of HTML comments and clean markers, cut to 200
and 4000 characters, its mentions, issue references and GitHub links made inert so it notifies and
links no one, and the body ends with
`Part of <the parent's URL>`, then a hidden `<!-- Diplomat: part <n> of <the parent's URL> by
<author> at <when the model answered> -->`: the parent's author (a part's, its own marker's), whom the ban list checks the part by,
read only in an issue you opened, which is a part when it carries one or a `Part of` line linking
the issue it is a sub-issue (Linear: child) of. A part that a failed call made all the same is taken, not filed again: on GitHub the one
carrying its marker among your 50 newest issues in the repo, looked for before each part is filed
and after a create fails; on Linear the parent's one new child. The parent stays on the graph in
the Fractured lane, its children joined to it; they enter `unrated`, and each one's fix PR joins
under it. An issue that would not split is not tried again unless you press Fracture; a
split that stops after filing a part, linked as a sub-issue or not, keeps the label and is never
tried again.
Either way, why is its hold, unless it is a `candidate`, whose fix is asked for instead. A call that fails, a label the tracker refuses, or a split that files
nothing takes the label off again, even if a switch went off meanwhile, once a read right before
shows Diplomat may still write to the issue, and is tried again 1, 2, 4 ... syncs later, a day at
most. The model's answer is saved before the first part is filed: a sync stopped mid-split (the app
quit, the sync timed out) after it, or a split whose first part's create failed with no read showing
it unmade, leaves the next sync that reads its code in full filing the rest of those parts, with
**Split big issues** on or the split forced, each only if the issue may be split now;
one stopped before it, the next sync taking the label off.

## The merge

**Merge cleared PRs merges with your admin rights, past the review requirement.** GitHub does not let
you approve your own PR, so a fast-track PR never has an approval. The merge is `gh pr merge <n>
--admin --squash --match-head-commit <head>` (`--merge`, else `--rebase`, where the repo or a pull
request rule on its base branch allows no squash). `--admin` merges a PR that does not meet the branch's requirements, a person's approving
review included, so leave this off wherever a second person's review is required.

Only a `cleared` PR is merged. Right before that the sync reads Linear's issues it would close and
those attached to each GitHub issue it would close, then the PR again, last, with its commits, its head's checks, the checks its base branch requires
and each issue it would close, and merges it only if its head is the one the sync read, it is still
cleared there, and nothing holds it. A draft never ready for review before is marked ready (`gh pr
ready`) instead when nothing holds it but missing, skipped or required checks, as CI may skip drafts,
and merged at a later sync once nothing holds it. The issues it would close are
GitHub's closing references, each one a closing word names in its title or a commit message, and
each Linear issue its title, body or a commit message closes or that links it. The holds (those on
its commits, its base branch and the checks it requires read only for a PR nothing else holds):

- its repo's read returned errors this sync, on any page, or Linear was not read for a team mapped
  to it;
- not open; not yours; from a fork; not into the default branch, or into one with a merge queue;
- anyone but you or a bot reviewed or commented, or it has more reviews or comments than one read lists;
- you commented (in a review thread too) or reviewed yourself, not through Diplomat;
- a review is requested;
- it was turned back into a draft after it was ready for review;
- a commit authored or committed by anyone but you (GitHub's own committer of a web commit aside), or
  more commits than one read lists, by the accounts GitHub maps their emails to (whoever wrote them,
  the head merged is the one the review run found clean and, unless taken over, Diplomat rated low/low again);
- changes requested; an unresolved review thread;
- a stop label: `do not merge`, `do-not-merge`, `don't merge`, `blocked`, `on hold`, `wip` or
  `work in progress`, matched as triage labels are (`pipeline.json` `stopLabels`);
- it lacks either fast-track label, or is off the fast track until you take it over;
- it closes no open issue (unless taken over), or one that is not a `candidate`, carries a stop
  label, or is held by a Linear issue tracking it, as read right before the merge, or one a merge
  this sync asked for may have closed;
- it would close an issue no read judged: one this sync did not read, more than the closing
  references one read lists, one a closing word names that GitHub does not list among them, or a
  Linear issue of a team not tracked or that could not be read; with Linear teams set, also when
  Linear cannot say which issues link it or an open GitHub issue it would close, or one that does is
  of a team not tracked or could not be read;
- its rating, or its diff floor, is not low/low, unless it is taken over;
- it conflicts with its base, is behind it or could not be compared with it, or GitHub has not computed
  whether it can merge;
- CI was read for an older commit, is still running, or failed; it has no checks (so a repo without
  CI never merges), or every check was skipped;
- a status check its base branch requires (branch protection or a ruleset) has not succeeded on its
  head, a skipped or never reported one included, or those checks could not be read;
- its base branch is locked, restricts pushes or requires deployments; requires linear history and the
  PR merges with a merge commit; requires signatures and the PR rebases or a commit is not signed and
  verified; has any other ruleset rule but pull request reviews, required status checks,
  non-fast-forward, deletion and creation; or its rules could not be read (branch protection reads in
  full only for a repo admin);
- it is assigned to anyone but you;
- its repo allows none of squash, merge or rebase, or the pull request rules on its base branch allow
  none of those it allows.

A hold shows on the card and is logged each time it changes. A merge `gh` refuses (no admin rights, a
head that moved) is a notice, and the next sync tries again. The PR is read again after every merge,
as `gh` exits 0 on one merged already: it counts as Diplomat's merge only if GitHub then shows it
merged at that head by you, and merged by anyone else or at another head, it is a notice.

## The Pipeline screen

The header's **Pipeline** button opens it, in both apps. It shows the repo the header's
[picker](panel.md#layout) chose: each group with a card in it, a Linear issue counting as its
team's repo, and each group with no card in any root, whole.

- **Status line** - when the last sync ran (on macOS also what it reads, how often, and which
  switches are off), and **Sync now** to run one at once. Under it, why no sync can run, if none
  can (no repo root resolves, the GitHub login is unknown), and the last sync's notices: a source
  that could not be read, a rating that failed, no Linear login.
- **Lanes** - **All**, **Fast**, **Human**, **Unrated**, **Fractured** and **Done**, with their
  counts. A lane shows every group with a card in it, whole.
- **The graph** - each connected group below the one before (on macOS on a band of its own, with a
  gap between bands), left to right along its edges: a parent
  to its children (dashed), an issue to the PR fixing it (solid), a PR to the PR stacked on it, whose
  base is its head branch (dotted), the arrowhead at the second. Groups with an unrated or fast card
  come first and those with only merged or closed items last, newest first otherwise; at most 300
  items, whole groups.
- **A card** - `#12` (the first GitHub root), `owner/repo#12` (another) or `ENG-12` (Linear), the title,
  risk and complexity (green low, orange medium, red high, `?` unrated) and the stage. A mark flags
  a hold, a lock an item Diplomat may not write to, **agent** or **queued** the queue's work on it;
  merged and closed cards are dimmed.
- **The selected card** - a click picks it, an arrow key the nearest card that way; its link; its
  rating, whether it came from labels or was rated here and not
  labelled, the rater's sentence and the diff floor; its hold; who may act on it, who opened it and
  who it is assigned to, and for a PR its head and whether a clean marker names it; its
  **traversal**, newest first: each step the sync took or saw (`rated`, `labelled`, `fast-track`,
  `clean`, `rerated`, `cleared`, `merged`, `held`, `fractured`, `child`, `asked`, `takeover`); a
  sync's errors are its notices, under the status line. And its actions:
  - **Open** - the issue or PR in the browser.
  - **Rate now** (your open PR, or an open issue whose code a sync can read) - its rating asked for
    by a sync started at once, past the four, even with **Rate issues and PRs** off, and applied
    by a sync started as its job returns.
  - **Fracture** (an issue Diplomat may write to, not split or being fixed, whose code a sync can read) -
    split the same way, whatever its rating.
  - **Start fix** (a `candidate` issue no hold stops) - its fix queued at once, past its attempt record, to wait
    for a bay like every ask. A Linear issue's only while **Open fix PRs** is on, since its text
    reaches the fix run through the sync.
  - **Authorize takeover** (an open item Diplomat may write to, unrated or a person's) - a
    [takeover](#takeover) by a sync started at once; **Revoke takeover** once it is taken over.

Every action but **Open** is disabled while the pipeline is off, and **Rate now**, **Fracture** and
**Authorize takeover**, with the reason, where the last sync found it would refuse them.

## Settings

All of them are on the **Pipeline** card, all **default off**; the rows under the master switch show
only while it is on. A switch turned on syncs at once. One turned off also stops a sync already
running, which reads the switches again (`control.json`) before every step it takes and every
`claude` call.

- **Run the pipeline** - the sync itself, every five minutes. With every switch below off it only
  reads: no label, no `claude` call, but for **Rate now**, **Fracture** and taking back a split's
  label when the split filed nothing. Off, it reads nothing,
  and the work it queued waits.
- **Rate issues and PRs** - the ratings and their labels. **Each rating is one `claude -p` call**,
  allowed five minutes, run from the queue like the fix and review runs, at most four waiting past
  the ones you force. Off, a sync drops the ones waiting that you did not force.
- **Open fix PRs** - a Fix-issues run for each `candidate` issue no open PR fixes.
- **Fast-track my PRs** - `diplomat:fast-track` on each PR of yours rated low/low at its first rating
  that closes only `candidate` issues, or taken over, a review run per head until clean, and `diplomat:cleared` taken
  off a PR whose head no marker names. A PR rated while it is off stays a person's.
- **Merge cleared PRs** - [the merge](#the-merge), with your admin rights.
- **Split big issues** - [fracturing](#fracturing): one issue and one `claude -p` call a sync.
- **Linear teams** - `ENG=owner/repo, OPS=owner/other`, commas, semicolons or new lines between
  them: each Linear team key (ASCII letters and digits, read in capitals as Linear spells it) and the
  GitHub repo root its issues are fixed in. An entry that is not `KEY=owner/repo` is listed in red
  and not tracked; a team named twice keeps its first repo. Blank = GitHub only.
- **Linear login** - who Diplomat is signed in to Linear as, with **Sign in…** and **Sign out**; see
  [Linear](#linear).

The whole fast track, issue to merge, takes **Rate issues and PRs**, **Open fix PRs**,
**Fast-track my PRs** and **Merge cleared PRs**. The switches are in UserDefaults (macOS) and
QSettings (Linux) under the same keys: `pipelineEnabled`, `pipelineRate`, `pipelineFix`,
`pipelineFastTrack`, `pipelineMerge`, `pipelineFracture` and `pipelineLinearTeams`.

## Linear

Linear is read and written as you, through Diplomat's Linear app. **Sign in…** opens Linear's
consent page in the browser, which hands the login back on `127.0.0.1` (the first free of ports
29170 to 29172). While it waits, up to 5 minutes, **Copy link** copies the page for any browser and
**Cancel** gives up. The login is kept in `~/.diplomat/pipeline/linear-login.json` and refreshed by the
sync; it reaches only `curl`, in a config on its stdin (staged in an owner-only temp file, removed
before curl starts), never in an argv. No agent shell, nor `gh` or `claude` a sync starts, has it or
`DIPLOMAT_LINEAR_TOKEN` in its environment, though the Linux app's own `gh` calls inherit one you
export. A fix run for a Linear issue gets the issue's text as Diplomat read it, not the login,
though it runs as you and so could read the login where Diplomat does. **Sign out** forgets it and
asks Linear to revoke it.

1. **Sign in** under **Linear login**, to the workspace of the teams you track. Its user is "you" on
   Linear: an issue assigned to them is one Diplomat may write to.
2. **Map** each team under **Linear teams**: `ENG=owner/repo`, the key as Linear spells it and a
   GitHub repo root. A team whose repo is no root here is read and shown, but its issues are neither
   rated, split nor fixed.

The app is an OAuth application a Linear workspace admin registers once, with the callback URLs
`http://127.0.0.1:29170/linear/callback`, `…:29171/…` and `…:29172/…`; its client ID is
`linearOAuth.clientID` in `assets/pipeline.json`, and only its own workspace can sign in to it
unless it is made public. `DIPLOMAT_LINEAR_TOKEN`, a personal API key, wins over the login. With
teams set and no login, or one Linear no longer accepts (its refresh unused for 30 days, or
revoked), Linear is skipped with a notice and GitHub still syncs, but a root a team maps to is only
read and shown, and no PR is merged.

A sync reads the tracked teams' issues in any state but completed or canceled. A PR closes a Linear
issue when one of the issue's attachments links it, or when its title or body names the issue right
after one of Linear's closing words (any form of close, fix, resolve, complete or implement, or
`Linear issue`), by identifier or link, alone or in a list: `Fixes ENG-12, ENG-13 and #4`. A bare
mention closes nothing, and only a PR in the root its team maps to fixes it as a `candidate`. An issue is known by its link without the title's slug, so a
retitle keeps what Diplomat recorded of it.

## Where it keeps things

`~/.diplomat/pipeline/` (`DIPLOMAT_PIPELINE_DIR` moves it), readable by you alone. The trackers'
labels are the state; this is what a sync needs besides:

- `log.jsonl` - every step a sync took or saw, which the traversals are drawn from and whose
  re-rates and clears back `state.json`'s; trimmed to its newest half past 2 MB.
- `last.json` - the last sync's result, which the screen shows until the next one.
- `ratings.json` - the ratings of items Diplomat may not label, kept while the item is unchanged, and
  of those whose labels could not be written, until they are; the rater's sentence for the rest.
- `state.json` - the labels made per repo, the items taken over, and the guards against repeating a step: each PR's
  re-rates by head, which prove a `cleared` label this Diplomat's own, and the head it was cleared
  at, which alone does for a PR taken over; the PRs Diplomat took off the fast track, or could not put on it; the items whose rating, its
  labels or split failed, and when to
  try again; the issues that would not split and why, and those being split with the parts the
  model answered and those filed so far; and the issues Diplomat filed as parts, with the ban each
  carries; the ratings asked for and not yet applied, and the items whose rating was cancelled in
  the queue. An item missing from a read keeps these until it is read merged or closed, or goes 90 days unseen. Also what was last
  logged, so the log does not repeat itself. A `state.json` or `ratings.json` that is there but
  cannot be read leaves every sync reading and showing only, with a notice.
- `rate/` - each rating asked for: the call its job makes, and the answer it leaves for the next
  sync, until the sync no longer asks for it.
- `control.json` - the switches as the app has them, and the revokes asked that no sync has
  answered, rewritten whenever one changes, a takeover or revoke is asked, and before each sync.
- `linear-login.json` - the [Linear login](#linear): its tokens, and who it is.

The fix and review asks' attempt records are the app's own (`pipelineAttempts`): a run that reported
back (a PR, a clean marker or nothing) concludes its ask, which is not made again while syncs owe it,
nor for 30 days after. On Linux a sync is `diplomat-core pipeline-tick`, the same core, stopped when
the app quits.

`DIPLOMAT_PIPELINE_SECS` overrides the five-minute sync (60 seconds to a day),
`DIPLOMAT_LINEAR_API` Linear's endpoint, and `DIPLOMAT_CLAUDE` and `DIPLOMAT_GH` the binaries.

## Limits

- Per root: the 300 open issues and the 300 open PRs created last, read 100 issues and 12 PRs a
  page; a page GitHub times out on is read again at half its size, down to 3, and the root's later
  pages keep that size. A root renamed or moved on GitHub is first read by its configured name,
  which GitHub follows; its later reads, writes and links use the name GitHub answers. Each PR's
  first 20 files, last 40 reviews, last 40 comments, first 50 review threads and first 10 closing
  references (more of any of the last four holds its merge), and when it is read again to merge,
  its first 100 commits and each review thread's first 50 comments (more holds it); and the 20
  merged or closed PRs updated last, with the closed issues of the repo they link to.
- Linear: the 300 open issues of the tracked teams updated last, and each one's first 10 attachments
  (more holds it).
- Past either cap a notice says so. An item an ask or attempt record names that these reads miss (closed, archived
  on Linear, or past a cap) is read by itself. A source that cannot be read, or is read only in part, is a
  notice, and the sync goes on without what it missed: a root read past its cap fixes and splits
  none of its issues, one read with errors, or whose Linear team was not read, is only read and
  shown, and an item missing from a read keeps its guards.
- One sync at a time: another started meanwhile reads nothing, with a notice in the activity feed,
  shown with the last sync's result if there is one. One pipeline per repo is
  assumed: two Diplomats syncing the same repo can race each other's writes.
- Ratings and splits need Claude Code's `claude` on the machine, whichever agent runner you use.
