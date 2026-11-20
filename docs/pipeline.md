# Pipeline

Every open issue and PR of the GitHub repo roots and the tracked Linear teams, rated for risk and
complexity and routed: a low-risk, low-complexity one goes down the **fast track**, from issue to fix
PR to merge with no person reading the change; everything else is left to a person. It ships
**off**, every switch of it too, and its state is the trackers' own labels.

## What it does

Every five minutes while it is on, a **sync**:

1. **Reads** each GitHub root's open issues and PRs (one `gh api graphql` call per root) and the
   tracked Linear teams' open issues, and links them: an issue to the PR that fixes it, a parent to
   its children, a PR to the PR stacked on it.
2. **Rates** up to four items, by the [definitions below](#ratings), and writes each rating as
   labels where Diplomat [may write](#who-diplomat-may-write-to).
3. **Routes** the low/low ones down the [fast track](#the-fast-track): a fix PR for an issue, a
   review until clean for a PR of yours, a second rating at the clean head, and the merge.
4. **Splits** one medium- or high-complexity issue into low-complexity
   [sub-issues](#fracturing).

Labels, child issues and the merge are done by the sync itself, in code. The fix and review runs are
agents, queued like a sweep's asks: behind the ban list (a fix for an issue by a banned author is
not queued), the [task cap](automation.md#autonomous-monitors), the
[spending budget](automation.md#the-spending-budget) and the disk floor, each asked for once (a review
once per head) and retried on the monitors' backoff when a run dies.

What it does not do:

- write to anything that is not [yours to write to](#who-diplomat-may-write-to) - that is shown, read only;
- rate someone else's PR: it shows the labels a person put on it;
- lower a rating: a label already on an item is its rating, and Diplomat writes only the higher of
  that, the model's answer and a PR's [diff floor](#the-diff-floor);
- approve a PR: GitHub does not let you approve your own, so the clean review is a COMMENT and the
  merge uses your [admin rights](#the-merge);
- put `diplomat:fast-track` back on a PR a person took it off;
- comment on, assign or close a Linear issue, or hand its key to anything it starts;
- read GitLab roots.

## Stages

An issue, the first row that holds from the bottom up:

| Stage | When | Lane |
|---|---|---|
| `unrated` | no rating yet | Unrated |
| `candidate` | rated low/low, and Diplomat may write to it | Fast |
| `human` | rated anything else, or low/low but assigned to someone else | Human |
| `fractured` | labelled `diplomat:fractured`, or it has sub-issues (Linear: children) | Fractured |
| `fixing` | an open PR fixes it | the PR's: Fast while it is on the fast track, else Human |

A PR:

| Stage | When | Lane |
|---|---|---|
| `unrated` | no rating yet | Unrated |
| `human` | rated, and not on the fast track; every PR that is not yours, once a person labelled it | Human |
| `fast-track` | yours, labelled `diplomat:fast-track`, no clean marker at its head | Fast |
| `clean` | the same, with a clean marker at its head | Fast |
| `cleared` | labelled `diplomat:cleared`, with the clean marker at its head | Fast |
| `merged`, `closed` | one of the repo's 20 PRs merged or closed last that carries a pipeline label | Done |

### The fast track

1. A `candidate` issue gets a [Fix-issues](actions.md#fix-issues) run (**Open fix PRs**), told it
   is on the fast track: the smallest fix, a regression test that fails on the base branch, and the
   closing reference kept so the PR links to the issue. A Linear issue's run works in the root its
   team names and puts `Fixes ENG-12` in its PR's description.
2. The PR is rated on its own (**Rate issues and PRs**), from its text and diff, never below its
   [diff floor](#the-diff-floor). Every open PR of yours is rated, not only the ones Diplomat opened.
3. Low/low, it is labelled `diplomat:fast-track` (**Fast-track my PRs**) and a review run is queued
   for its head. It reviews the PR and fixes what it finds on the branch until a full pass at the
   head finds nothing, LOW findings included, then posts one COMMENT review whose body begins
   `Clean at <head sha>`: the **clean marker**. A marker counts only on your own review, submitted
   at the commit it names.
4. At the clean head the PR is rated again. Still low/low, it is labelled `diplomat:cleared`;
   anything else takes `diplomat:fast-track` off and leaves it to a person.
5. A cleared PR is [merged](#the-merge) (**Merge cleared PRs**) once nothing holds it.

A commit pushed past the clean marker takes `diplomat:cleared` off, and the PR goes back to
`fast-track` for a review of the new head.

## Ratings

Two dimensions, each `low`, `medium` or `high`, by these definitions (`pipeline.json` `levels`). The
rater gets them word for word and is told to pick the higher level when unsure between two:

| | low | medium | high |
|---|---|---|---|
| **Complexity** - the surface of the change | one feature; at most 2 source files and 30 source lines; no new abstraction; no interface change | one feature, any size; or one internal interface changed | more than one feature, a public interface, a data format, persistence, or internals other features rely on |
| **Risk** - the cost of that change being wrong | a mistake reaches only the bug's own inputs, shows at once and reverts cleanly; nothing sensitive | a mistake can reach other inputs or ship unnoticed | sensitive ground (security, auth, secrets, data, money, concurrency, build, release, CI) or untested paths |

A rating is one `claude -p` call: `sonnet` for an issue, `opus` for a PR, whose rating decides a
merge (`rater.model`, `rater.prModel`). It runs in the root's checkout (for a Linear issue, its
team's root) with read-only tools (`Read`, `Grep`, `Glob`), no MCP servers, no slash commands and no
settings, and answers only through a JSON schema: `risk`, `complexity` and one sentence of `why`.
The title and body (up to 6000 characters), and a PR's `gh pr diff` (up to 20,000), are on its
stdin, fenced as untrusted data.

A sync rates up to four items past the ones you asked for with **Rate now**, in this order, newest
first within each: your PRs clean at their head and awaiting the second rating, your unrated open
PRs, unrated issues Diplomat may write to, other unrated issues. An issue already split or being
fixed is not rated, nor is a Linear issue whose team has no repo root. A failed call is a notice,
tried again next sync.

Labels for both dimensions are the item's rating (two of one dimension: the higher), and it is not
rated again but for the fast track's second rating or when you ask. A rating Diplomat writes is the
higher of the labels already there, the model's answer and the diff floor, a dimension at a time.

### The diff floor

An open PR's files, as GitHub lists them, put a floor under its rating in code (`pipeline.json`
`floor`):

| The diff | Floor |
|---|---|
| a denied path: a directory such as `.github`, `.claude`, `vendor` or `node_modules` anywhere in it, or a file such as `package.json`, a lockfile, `Dockerfile*`, `Makefile`, `.env*`, `*.pem`, `CODEOWNERS` or `CLAUDE.md` | risk high |
| no test file changed | risk medium |
| a file added outside tests, deleted, renamed or copied (anything but modified) | risk medium |
| a file with no changed lines (binary, or a mode change) | risk medium |
| more than 6 files | complexity medium |
| more than 2 files, or more than 30 lines (added + deleted), outside tests | complexity medium |
| more than 300 test lines | complexity medium |

A test file is one under a `test`, `tests`, `__tests__`, `spec`, `specs` or `testdata` directory, or
named like `test_*`, `*_test.*`, `*.test.*`, `*_spec.*`, `*.spec.*`, `*Test.*`, `*Tests.*` or
`*Spec.*`. The model can rate above the floor, never below it, and Diplomat neither puts a PR whose
floor is not low/low on the fast track nor merges it, whatever its labels say.

## Who Diplomat may write to

Diplomat labels, splits, fixes and merges only:

- a GitHub issue with no assignee, or assigned to you alone;
- a Linear issue with no assignee, or assigned to the Linear key's user;
- your own PR, from a branch of the repository itself (not a fork), into its default branch.

"You" is the [GitHub username](settings.md#settings) Diplomat works as in that root. Everything else
is read, shown with a lock, and left alone: a rating Diplomat made of it stays on this machine, and
someone else's PR is rated only by the labels a person put on it. A PR of yours into another branch
(stacked on another PR) is never fast-tracked.

## Labels

| Label | Meaning |
|---|---|
| `risk:low`, `risk:medium`, `risk:high` | the risk rating |
| `complexity:low`, `complexity:medium`, `complexity:high` | the complexity rating |
| `diplomat:fast-track` | your low/low PR, reviewed until clean |
| `diplomat:cleared` | rated low/low again at its clean head: only the [holds](#the-merge) stand before the merge |
| `diplomat:fractured` | an issue split into sub-issues |

They are the pipeline's state: a person can set or remove any of them, and a sync reads them as they
are, case-insensitively. A missing GitHub label is created in its repo on first use; on Linear the
team's label of that name is used, else the workspace's, made if there is neither.

## Fracturing

With **Split big issues** on, a sync splits at most one issue Diplomat may write to that is medium or
high complexity and not high risk, with no sub-issues, no open PR fixing it, and a repo root to read
its code in. **Fracture** on the screen splits one at once, whatever its rating. One
`claude -p` call (`sonnet`, sandboxed as a rating is) reads the code and answers up to six parts, each
low complexity by itself, together exactly what the issue asks, each able to merge on its own - or no
parts, and why.

Each part becomes a real child, so the trackers themselves keep the graph: on GitHub an issue made a
**sub-issue** of the parent, on Linear an issue created with the parent as its **parent**. Each
child's body ends with `Part of <the parent's URL>`. The parent is labelled `diplomat:fractured` and
stays on the graph in the Fractured lane, its children joined to it; they enter `unrated`, and each
one's fix PR joins under it. An issue that would not split is not tried again unless you press
Fracture, and a split that fails part-way stops there; either way, why is its hold.

## The merge

**Merge cleared PRs merges with your admin rights, past the review requirement.** GitHub does not let
you approve your own PR, so a fast-track PR never has an approval. The merge is `gh pr merge <n>
--admin --squash --match-head-commit <head>` (`--merge` or `--rebase` where the repo allows no
squash), after `gh pr ready` for a draft. `--admin` merges a PR that does not meet the branch's
requirements, a person's approving review included, so leave this off wherever a second person's
review is required.

Only a `cleared` PR whose clean marker is at its head is merged, and only while nothing holds it. The
holds, the first that applies winning:

- not open; not yours; from a fork; not into the default branch;
- anyone but you or a bot reviewed or commented, or it has more reviews or comments than one read lists;
- changes requested; an unresolved review thread;
- its rating, or its diff floor, is not low/low;
- it conflicts with its base, or GitHub has not computed whether it can merge;
- CI was read for an older commit, has no checks (so a repo without CI never merges), is still
  running, or failed;
- its repo was read only in part this sync, or allows none of squash, merge or rebase.

A hold shows on the card and is logged each time it changes. A merge `gh` refuses (no admin rights, a
head that moved) is a notice, and the next sync tries again.

## The Pipeline screen

The header's **Pipeline** button opens it, in both apps.

- **Status line** - when the last sync ran (on macOS also what it reads, how often, and which
  switches are off), and **Sync now** to run one at once. Under it, the last sync's notices: a
  source that could not be read, a rating that failed, no Linear key.
- **Lanes** - **All**, **Fast**, **Human**, **Unrated**, **Fractured** and **Done**, with their
  counts. A lane shows every group with a card in it, whole.
- **The graph** - each connected group on a band of its own, left to right along its edges: a parent
  to its children (dashed), an issue to the PR fixing it (solid), a PR to the PR stacked on it, whose
  base is its head branch (dotted), the arrowhead at the second. Groups with an unrated or fast card
  come first and those with only merged or closed PRs last, newest first otherwise; at most 300 items,
  whole groups.
- **A card** - `#12` (the first root), `owner/repo#12` (another) or `ENG-12` (Linear), the title,
  risk and complexity (green low, orange medium, red high, `?` unrated) and the stage. A mark flags
  a hold, a lock an item Diplomat may not write to, **agent** or **queued** the queue's work on it;
  merged and closed cards are dimmed.
- **The selected card** - its link; its rating, whether it came from labels or was rated here and not
  labelled, the rater's sentence and the diff floor; its hold; who may act on it, and for a PR its
  head and whether a clean marker names it; its **traversal**, newest first: each step the sync took
  or saw (`rated`, `labelled`, `fast-track`, `clean`, `rerated`, `cleared`, `merged`, `held`,
  `fractured`, `child`, `asked`, `error`). And its actions:
  - **Open** - the issue or PR in the browser.
  - **Rate now** - rated by a sync started at once, ahead of every limit, even with **Rate issues
    and PRs** off. Someone else's PR, and a Linear issue whose team has no repo root, are refused
    with a notice.
  - **Fracture** (an issue Diplomat may write to) - split the same way, whatever its rating.
  - **Start fix** (a `candidate` issue) - its fix, past its attempt record: queued at once on macOS,
    started at once outside the task cap on Linux. A Linear issue's only while **Open fix PRs** is
    on, since its text reaches the fix run through the sync.

**Rate now** and **Fracture** need a sync, so they are disabled while the pipeline is off.

## Settings

All of them are on the **Pipeline** card, all **default off**; the rows under the master switch show
only while it is on. A switch turned on syncs at once.

- **Run the pipeline** - the sync itself, every five minutes. With every switch below off it only
  reads: no label, no `claude` call, but for **Rate now** and **Fracture**. Off, it reads nothing,
  and the work it queued waits.
- **Rate issues and PRs** - the ratings and their labels. **Each rating is one `claude -p` call**,
  up to four a sync past the ones you force - 48 an hour while unrated items remain - each allowed
  five minutes. They run in Diplomat, not in the queue, so the task cap and the spending budget do
  not hold them.
- **Open fix PRs** - a Fix-issues run for each `candidate` issue no open PR fixes.
- **Fast-track my PRs** - `diplomat:fast-track` on each low/low PR of yours, a review run per head
  until clean, and `diplomat:cleared` taken off a PR whose head moved past its marker.
- **Merge cleared PRs** - [the merge](#the-merge), with your admin rights.
- **Split big issues** - [fracturing](#fracturing): one issue and one `claude -p` call a sync.
- **Linear teams** - `ENG=owner/repo, OPS=owner/other`, commas or new lines between them: each
  Linear team key and the GitHub repo root its issues are fixed in. Blank = GitHub only.
- **Linear API key** (macOS) - where the key is read from; see [Linear](#linear).

Linux names three of them **Open fix PRs for low/low issues**, **Fast-track my low/low PRs** and
**Merge past required reviews (admin)**, and says where the Linear key is read from under **Linear
teams**. The whole fast track, issue to merge, takes **Rate issues and PRs**, **Open fix PRs**,
**Fast-track my PRs** and **Merge cleared PRs**. The switches are in UserDefaults (macOS) and
QSettings (Linux) under the same keys: `pipelineEnabled`, `pipelineRate`, `pipelineFix`,
`pipelineFastTrack`, `pipelineMerge`, `pipelineFracture` and `pipelineLinearTeams`.

## Linear

Linear is read with a personal API key of yours, through `curl` with the key on its stdin, never in
an argv. The key is read on each sync and kept in memory only: never written, never in the
environment of anything Diplomat starts (each spawned agent's shell unsets `DIPLOMAT_LINEAR_TOKEN`).
A fix run for a Linear issue gets the issue's text as Diplomat read it, and no access to Linear.

1. **Mint** a personal API key in Linear's
   [Security & access](https://linear.app/settings/account/security) settings. Diplomat reads the
   tracked teams' issues and writes labels and child issues there, so the key needs read and write
   access to those teams. Its user is "you" on Linear: an issue assigned to them is one Diplomat may
   write to.
2. **Store** it where only you can read it. On macOS, in the login Keychain (`-w` last makes
   `security` prompt for it, so it stays out of your shell history):
   ```bash
   security add-generic-password -a "$USER" -s diplomat-linear -w
   ```
   On Linux, in a file only you can read:
   ```bash
   (umask 077; read -rs t; printf '%s\n' "$t" > ~/.diplomat/linear-token)
   ```
3. **Name** it in `~/.diplomat/config.json` - the name, never the key, since that file is
   world-readable. `"linearKeychainItem": "diplomat-linear"` on macOS (`plutil -replace
   linearKeychainItem -string diplomat-linear ~/.diplomat/config.json`), `"linearTokenFile":
   "~/.diplomat/linear-token"` on Linux.
4. **Map** each team under **Linear teams**: `ENG=owner/repo`, the key as Linear spells it and a
   GitHub repo root. A team whose repo is no root here is read and shown, but its issues are neither
   rated, split nor fixed.

`DIPLOMAT_LINEAR_TOKEN` wins over both. The Keychain item is looked up under your account first,
then under any; whitespace around the key is dropped. With teams set and no key, Linear is skipped
with a notice and GitHub still syncs.

A sync reads the tracked teams' issues in any state but completed or canceled. A PR fixes a Linear
issue when one of the issue's attachments links it, or when its title or body names the issue's
identifier as a word of its own.

## Where it keeps things

`~/.diplomat/pipeline/` (`DIPLOMAT_PIPELINE_DIR` moves it), readable by you alone. The trackers'
labels are the state; this is what a sync needs besides:

- `log.jsonl` - every step a sync took or saw, which the traversals are drawn from; trimmed to its
  newest half past 2 MB.
- `last.json` - the last sync's result, which the screen shows until the next one.
- `ratings.json` - the ratings of items Diplomat may not label, kept while the item is unchanged,
  and the rater's sentence for the rest.
- `state.json` - what is done once: the labels made per repo, the PRs whose fast track was decided,
  the issues that would not split and why, and what was last logged.

The fix and review asks' attempt records are the app's own (`pipelineAttempts`). On Linux a sync is
`diplomat-core pipeline-tick`, the same core.

`DIPLOMAT_PIPELINE_SECS` overrides the five-minute sync on macOS (60 seconds to a day),
`DIPLOMAT_LINEAR_API` Linear's endpoint, and `DIPLOMAT_CLAUDE` and `DIPLOMAT_GH` the binaries.

## Limits

- One read per root: the 100 open issues and the 100 open PRs updated last, each PR's first 20
  files, last 40 reviews, last 40 comments and first 50 review threads (more of any of the three
  holds its merge), and the 20 PRs merged or closed last. Closed issues are not read.
- Linear: the 300 open issues of the tracked teams updated last; past that, a notice says so.
- A source that cannot be read is a notice, and the sync goes on without it; a root read only in part
  merges nothing that sync.
- One sync at a time: another started meanwhile reads nothing and says so.
- Ratings and splits need Claude Code's `claude` on the machine, whichever agent runner you use.
