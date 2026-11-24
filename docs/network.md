# Diplomacy Network

A peer-to-peer network of Diplomat machines, over Tor, that share the work on the repositories
they have in common. It is off by default. **Settings → Offer every job to the Diplomacy
Network** switches it on, and from then on it gates every job on this machine:

- Diplomat starts no job in a terminal. Every job - a monitor's, the queue's, a wizard's - is
  **offered** to the pool of its repository.
- Some machine in that pool with a free slot **takes** it. That may be this one.
- Whoever takes it runs it in a **docker container**. Your own jobs on your own machine too.
- Everything the agent does on GitHub or GitLab is done by the machine that offered the job,
  **in its operator's name**, and only what that job needs.

The switch gates jobs: agents that work on a repository. Outside it are:

- **Agents already running in terminals** when it is switched on. They run on.
- **The device allocator's repair agent.** A simulator or emulator reported broken gets `claude`
  in a terminal on this machine. It maintains the machine, works on no repository, and stays on
  the host.
- **Model calls that use no tools**: the Comms classifier and the daemon's renewal of the Claude
  Code login.
- **The terminals that sign a provider in.**

The daemon behind it is [`diplomacy-network`](../packages/diplomacy-network/README.md); the
contract between two machines is its [PROTOCOL.md](../packages/diplomacy-network/PROTOCOL.md).

A Diplomat with the network replaces the mesh of earlier versions. At launch it ends the mesh
node such a version left running - the process `~/.diplomat/mesh/state.json` names, while that is
a `python -m szpontnet` - and removes `~/.diplomat/mesh` with the keys in it. The feed says so.
A `~/.diplomat/mesh` that is a link to a directory loses the link alone: what it leads to is
left as it is, and the feed says that instead.

It needs `tor` and `docker` on the machine, and `gh` or `glab` signed in for the forge each
repository is on. The daemon looks for them on its `PATH` and in the usual install directories;
`DN_TOR`, `DN_DOCKER`, `DN_GH` and `DN_GLAB` in the environment the daemon starts with name a
binary anywhere else, and `DN_TOOL_DIRS` names other directories to look in. It also needs `openssl`: without one the
machine takes no job and the Network screen says so; `DN_OPENSSL`, `DN_GIT`, `DN_CLAUDE` and, on
macOS, `DN_SECURITY` name those binaries the same way. Without docker a machine still offers its jobs and acts for them, and
takes none. Without Tor it reaches no other machine. The Network screen shows what the daemon
says is missing, and while tor, docker or the model credential is missing or failed, or the
daemon does not answer, a red line above the task list says so and opens that screen. While the
daemon does not answer, automatic work waits in the queue without being offered; a job started
by hand, or a queued one executed now, still asks it.

<img alt="The Network screen" src="img/network.png" />

## Pools

One pool per repository, named by where the repository lives (`github.com/owner/repo`). A machine
is in the pools of the repositories linked in Settings (**Repo roots** and **Other repos**) and in
no other.

A pool's state - who is in it, which jobs are open, who is working on what - is a set of signed
records that every member keeps. Members compare a hash of that state and exchange whatever
differs, so no machine is in charge of a pool, and any member may take any job.

A job stays tied to the machine that offered it all the same. Only that machine confirms a
claim, hands out the prompt and the key, performs the forge requests and extends the lease. While
it is asleep or offline none of its unclaimed jobs can be taken, a job of its that is running
loses its forge access at once and is stopped ten minutes after its lease ends, and after a day
away its offers are cancelled. A machine with jobs out has to stay awake.

- **Joining.** The first machine to link a repository has a pool of one. Another machine joins by
  an **invite**: **Copy invite** on the pool's card, sent to the other operator by any means,
  pasted into **Join...** there. An invite is good for a day, and the machine that made it has
  to be reachable when it is used: it is the one that seats the newcomer. Until it has, the
  pool's card says *Joining* and shows this machine alone in it. An invite that let this
  machine in nowhere - its maker refused it, or it ran out before the maker answered - is said
  on the card with the reason, until another is pasted. A machine can seat 15 others, and so
  can each of those the first machine seated, which makes 241 machines the most a pool holds.
- **Leaving.** **Leave** stops this machine taking the pool's jobs and offering to it. It stays
  left until **Rejoin**. After more than a month away - left, or switched off - the machine
  comes back the same way, as long as its seat was not given to another machine meanwhile: it
  asks every machine it knew in the pool and is in again once one of them answers. Until then
  the pool's card says it is waiting to be let back in, and it takes and offers none of the
  pool's jobs; if every one of them refuses it as no member, the card says it has no seat there,
  and it needs an invite again. A machine whose clock is off, or that is asked for more work
  than it can do, is still waiting, not without a seat. It goes on asking the others it knew for
  up to a month after, so two machines that come back together and reach each other first are
  one pool with the rest once one of those is up; until then a job offered on both sides can run
  twice. A machine away for less than a month - asleep overnight, restarted - is not coming
  back, whatever became of the others, and waits for nobody. If all the others are gone for
  good, removing the repository and adding it again starts a pool of one. Removing a repository
  and adding it again starts another pool of one on this machine. The pool it was in goes on
  without it and takes it back by no invite of a machine that came in under it; if this machine
  started that pool, that is every machine there, and they join the new pool instead, each by an
  invite from this one.
- **Reaching each other.** A machine is reachable only as a Tor onion service whose address is
  its own public key, so there are no ports to open and no addresses to exchange. A first
  connection between two machines can take minutes; later ones take about a second.

Every request one machine sends another carries its own proof of work, bound to the sender, the
receiver and that one request. The work a sender owes doubles as its requests pile up, and a
stranger owes far more than a member.

## Taking a job

A machine takes work while it has room: the task cap in Settings, less what it already runs, and
nothing while the disk is low, the budget gate holds, or automatic work is paused. A job started
by hand in the panel is not held to that room: this machine takes it at once when it can take
jobs at all - Tor and docker ready, a Claude credential on the machine - and the job's hours are
within the longest job it takes. Otherwise the job waits in the pool for another machine, and
the Network screen shows what this machine lacks.

To take a job a machine confirms the pool's state with every member, asks every member for a
lock on the job, and commits only when all that answered agreed. A member that does not answer
is recorded as absent. Two machines reaching for one job are told apart by a rank computed from
the job and the machine's key, the same on every machine.

What a machine has - simulators, attached devices, toolchains - is never announced. A machine
weighs it by itself, in one case: a job on an Android project is left for half a minute by a
machine that has no device to give, so that one with a device takes it first. If none does,
the job runs on a machine without. The wait is visible to the pool all the same: a member that
watches when a machine takes such jobs can tell whether it waited.

## Where a job runs

In a container built from one local image: Debian with git, node, python, curl, `gh`, `glab`,
`adb` and the agent itself. The agent is root in it and is told it may install whatever else it
needs. The machine needs Docker 27.1 or newer: a job's network is made in a mode that release
brought, and an older engine takes no job.

- **The agent is Claude Code**, whatever runner Settings selects for terminals. A machine takes
  jobs only with a credential for it: `networkModelToken`, a Claude Code login, or
  `ANTHROPIC_API_KEY` in the daemon's environment. Without one it takes nothing, and the screen
  reads *model missing*.
- **One container per requesting machine and repository.** It runs the jobs that machine asks
  for on that repository while any of them runs, and never another machine's or another
  repository's. When the last of them ends it is removed with everything in it, and the next
  job starts in a new one.
- **No credential is inside it.** Not the forge's, not the model's.
- **It reaches nothing but the broker.** The container sits on an internal network with one
  other: its relay, a second small container that runs no job and carries connections to a proxy
  on the host and nowhere else; it carries 256 new connections at once and 64 a second after
  that, so a container cannot use up the host's ports. Through it: the forge's API and `git push` go
  to the machine that offered the job, on every host the forge takes a login or serves
  repositories on, over https on port 443 and no other way; `git clone` and `fetch` of the
  repository are answered from the host's own mirror, which the machine running the job fills
  with its own git access to the repository - one that cannot clone the repository cannot run
  its jobs; the model's API is forwarded with the
  host's credential added, and its answer comes back without the headers that describe the
  host's account; anything else is tunnelled to the public internet, so installing software
  works. Names are resolved by DNS alone; a name that is not a plain DNS name, one of one label,
  or one under `.local`, `.internal`, `.lan` and the like, is refused, and a refusal names no
  address a name resolved to. Addresses of the host, of every network one of the host's
  interfaces is on, of every private or otherwise not publicly routed range, IPv4 or IPv6, and of other containers are
  refused. A publicly addressed network the host reaches only by a route - behind a VPN, or
  another subnet of its site - is not known to the broker and is reached like the rest of the
  internet.
- **It gets a bounded share of the host.** 8 GiB of memory, 4 CPUs, 4096 processes and 20 GiB of
  disk per container; per job, 256 connections through the broker, 256 requests on them at a
  time, 32 connections out for the requests the broker carries itself, 48 MiB of request
  bodies held at a time, and 8 names being resolved at a time; a connection that names no
  running job is answered once, and what it sends after that is dropped, the connection reset
  past 64 KiB. On their way to the broker, all jobs' connections together have at most 16 MiB
  in flight (128 KiB each way a connection), under 64 MiB of the host's kernel memory however
  they are used, shared equally among the jobs: a job that keeps more than
  its share for 2 s while another waits loses its fullest connections. What all jobs'
  connections out to the internet hold in the host's kernel is polled every 500 ms and held
  to 32 MiB, shared equally: a job at its share has its writes kept back until there is room,
  and when what jobs leave unread takes them past 32 MiB, the job holding the most loses its
  fullest connections out until they are within it - past it between polls by what the
  host's link brings in 500 ms, 60 MiB at 1 Gbit/s, or for 100 ms by the share of a job that
  has just come. A connection out a job has ended is its own until the kernel has sent what
  it holds, and is reset if that takes 30 s. While the kernel cannot be asked, a job may have 32 connections out open.
  A container found
  holding more disk than that is removed - the count includes files its processes keep open
  after deleting them, where
  the engine lets them be counted - and the jobs in it
  end as failed attempts; so is one the engine could not measure three looks running.
- **Devices stay on the host, and jobs see none of them** until **Let jobs use this machine's
  devices** is switched on (the Network screen's settings; off by default). With it on, a job
  running here can use the Android devices and emulators attached to this machine through adb -
  a phone on USB included - by a forward opened for that job, and an emulator can reach services
  on this machine. The switch is one for the whole machine, not one per pool: with it on, every
  job this machine takes, from any member of any pool it is in, can do with those devices
  whatever a shell on them can. Switch it on only when every machine in every one of those pools
  is trusted with that. What adb does on this machine itself -
  connecting to an address, pairing, forwarding or reversing a port, stopping its server - is
  refused. It applies to jobs started afterwards.
- **A fuse.** One job gets 5000 model requests or 8 GiB of model traffic on this machine's
  credential, then is refused. The count is the job's own, and a restart of the daemon does not
  start it again. What a job says it used of the model counts toward the budget gate no higher
  than the traffic this machine carried to the model for it.
- **What a job did** is in `~/.diplomat/network/runs/<run id>/log.jsonl` for a day after it
  ended, written by the job itself.

## Acting in your name

The machine that offered a job performs every forge request the agent makes, with its own `gh` or
`glab` login, after checking the request against the rules of that job's kind. The key that lets
an executor ask is handed over once the job is taken, works for that executor and that job only,
and ends with the job. Each request is checked against the rules the daemon has for the job's
kind when the request arrives, so an update that narrows them reaches jobs already running, and
a job whose kind has no rules any more loses its key. A repository on a GitLab of your own is
acted on at its own address, with the login `glab` holds for it. Each address gets the login
`gh` or `glab` keeps for that address: not `glab`'s top-level token, which it gives an address
it holds nothing for, and not `gh`'s `GH_ENTERPRISE_TOKEN` or `GITHUB_ENTERPRISE_TOKEN`, which
it gives every GitHub Enterprise Server. A `GITLAB_TOKEN`, `GITLAB_ACCESS_TOKEN` or
`OAUTH_TOKEN` in the daemon's environment, which `glab` gives every GitLab it holds, goes only
to the GitLab that `GITLAB_HOST` (or `GITLAB_URI`) names, or to gitlab.com when neither is set.
The daemon has github.com's rules for a GitHub Enterprise Server as well, at that server's
address, but Diplomat links only repositories on github.com and on a GitLab, so one on a GitHub
Enterprise Server has no pool. The network has no rules for an address under `ghe.com` (GitHub
Enterprise Cloud with data residency), for a subdomain of `github.com` or for
`github.localhost`: a repository linked there has no pool, no job is offered for it, and the
Network screen names it.

| Job | May write |
|---|---|
| Review of someone else's PR | a review with line comments and thread replies on that PR; approve or request changes only where the review policy lets it |
| Answering reviews on your PR | thread replies, resolving threads, fast-forward pushes to that PR's branch when the branch is in the repository itself or in your own fork of it; marking it ready only where the setting allows |
| Conflicts | fast-forward pushes to that PR's branch when the branch is in the repository itself or in your own fork of it |
| Issue | add or remove itself as an assignee, comment on that issue, push one new branch - in the repository itself or in your own fork of it - and fast-forward it, open one draft PR from it |
| Audit | push up to 24 new branches, in the repository itself or in your own fork of it, and fast-forward them, open one draft PR from each; nothing when read-only |
| Investigate | nothing |

**One new branch** is one for the job, not for each attempt and not for each place: what a job
has created, in the repository or in your fork, is kept with the offer, so a second machine
taking the job after the first failed, and the daemon after a restart, go on from the same
count. A branch is the job's own - to push to again, to open its PR from - once the forge has
said it accepted the push that created it. A push the forge declined uses nothing up. One whose
answer never came may have happened, and the forge knows: before the job's next push is judged
the machine asks it for the branch. No such branch, and the count is free again; the branch at
the commit that was sent, and it is the job's own; the branch at some other commit, and it stays
counted and is nobody's to push to. A draft PR is counted the same way. One whose answer never
came is settled before the job opens another, by asking the forge which PRs there are from that
branch, open or closed: none, and the job may open it; any, and that is the job's one. While the
forge does not answer the question, the request that waits on it is refused. The forge's answer
is taken as it stands - a request the forge was still working on when it answered can land
afterwards, and is then not counted. The count is kept by each machine that offered the job:
when two of your machines offer the same job, the one that takes it may use the allowance of
each, under each one's key.

**A draft PR** is opened with no labels, assignees, reviewers or milestone, on either forge. On
GitLab a label is made by naming it, replaces another of its scope and can start a pipeline.

**Your own fork** is the repository under the account the repository was linked with that the
forge itself calls a fork of this repository. The machine asks the forge whose it is and what it
is a fork of before every push there. A fork held by somebody else, by an organisation or a
group, a fork of a fork and any other repository of yours are out of reach. A PR's branch is
pushed in the fork only when the forge places that PR's branch there, and a push to the fork is
held to everything a push to the repository is, against the fork's own default and protected
branches.

What a job may read is set by its kind too - by what the work needs, in the one repository it
belongs to:

| Read | By |
|---|---|
| The repository's code: files, branches, tags, commits, a comparison of two of them - and so the diff of any PR, which on GitHub `gh pr diff` also reads from the PR itself - and what is recorded on a commit: its comments, its statuses, the results of its checks | every job |
| Every PR and issue of the repository, as context: what it says, its state, the comments, reviews and review threads on it | every job |
| What the forge lists of one PR: its changed files, its commits, who was asked to review it, whether it is merged, its labels, events and reactions; on GitLab its versions, changes, pipelines, approvals and draft notes as well | the review, answering-reviews and conflicts job of that PR |
| What the forge lists of one issue: its events, labels and reactions | the issue job of that issue |
| A CI run, its jobs and their logs | every job, for a branch it pushed itself; the three PR jobs, for their PR's branch; audit and investigate, for the default branch |

No job reads a list of CI runs, build artifacts, releases, deployments or environments, the
repository's feed of events, its traffic, contributors or statistics, an archive of the source
(the clone comes from the offering machine's mirror), the repository's lists of labels and
milestones, or the people who can be assigned or mentioned: nothing `gh` or `glab` asks on a
job's behalf needs them. Whether a commit's checks passed is recorded on the commit and is
readable for each one - `gh pr list` and `gh pr status` show it for every PR - while a run and
its log are tied to the run's branch as the table says; the machine asks the forge which branch
a run was for before it hands anything of it over. A GraphQL request is checked by the names
of the fields it asks for, so there what the forge lists of a PR or an issue is readable for
each one of the repository; what no job reads is refused there as well.

Of what lies outside the repository and the repository
points at - the fork a PR comes from, an issue elsewhere that mentions one here - a job is told
what the thing is (number, title, state, address; a fork's name and description) and nothing of
what is inside it, and of the account that offered the job its public name. Nothing else of the
account can be read: no other repository, no organisation, no setting, token or secret.

Of the repository itself a job is told a fixed list of facts - names and addresses, owner,
description, visibility, default branch, language, topics, licence, dates, size, which of its
features are switched on, which ways of merging it accepts - and nothing off the list: not its
tokens, not its other settings, not its branch protection rules. Of a branch it is told whether
the branch is protected and, on GitHub, whether a PR into it must be up to date before a merge.
The list holds whichever way the agent asks, through the forge's REST API or through GraphQL.

Of your account's standing in the repository a job can read exactly this: on GitHub, through
GraphQL, the level of access the account has (`viewerPermission`: read, triage, write, maintain
or admin), which `gh` reads before it opens a PR; on GitLab, in REST answers, whether the
account is subscribed to an MR, an issue or a label (`subscribed`), whether it may merge an MR
(`user.can_merge`), and whether it may approve one and has approved it (`user_can_approve`,
`user_has_approved`). The account's tokens, the detail of its access permission by permission
and the repository's protection settings are not readable.

A GraphQL request is refused whole when it asks for anything off that list, or for anything
else the forge would say about the account that offered the job rather than about the
repository: what that account may do to an issue, a PR or a comment, whether it is subscribed
to one or has read it - asked for outright, or by listing only the ones it is subscribed to or
reacted to - its e-mail addresses. The address of whoever turned on a PR's auto-merge on GitHub,
and of whoever wrote an issue in through GitLab's Service Desk, comes back empty. Which comments
the account wrote is told, because `gh` asks,
and so are the name and address a commit was written with, which are part of the commit.
(GitHub serves the commits of a repository's forks through the repository to whoever knows
their id; the rules do not narrow what the forge itself calls part of the repository.)

A request reaches a rule by its plain address only. One that spells the address another way the
forge might also understand - an escaped letter, an added extension, a doubled or trailing
slash, different capitals - is refused, so a rule cannot be walked around by respelling.
GitLab's own spelling of a name that holds a slash - `feature%2Flogin` for the branch
`feature/login`, `src%2Fmain.js` for a file - is taken where GitLab defines it, when a job reads.

No job may merge, close, force-push, delete a branch, push to the default branch or to a branch
the forge reports as protected, push to any repository but this one and your own fork of it, or
touch settings, secrets or releases. No pushed commit may add, change or delete a CI definition,
in any letter case: `.github/workflows/**` on GitHub; `.gitlab-ci.yml`, `.gitlab/ci/**` and the
file the project is set to read its CI configuration from on GitLab - for a push to your fork,
the file either project is set to read. Each commit is held to its parents: at such a path it
must hold exactly what one of them holds. A commit with one parent therefore changes nothing
there. A merge may take a definition, or the lack of one, from any of the commits it merges, and
every commit a push builds on without carrying it must already be on a branch of the repository
pushed to - so a job can bring a CI definition onto its branch exactly as another branch of the
repository has it, which is what merging the base branch does, and in no other form. What CI
runs from the rest of the repository - a script, a Makefile, a file a definition includes from
elsewhere - is a job's to change like any other file. No job creates a branch whose name a
protection rule would cover - a GitHub ruleset or branch protection rule, a GitLab protected
branch or wildcard - in the repository or in your fork: the machine reads every page of those
rules before the push, matching each pattern more widely than the forge does, without regard to
case and with `*` across `/`. GitHub's API answers an account that is no admin of the
repository as if it had no branch protection rules: for such an account the machine reads which
branches are protected instead, and refuses a new branch beside one of them under the same `/`
(`release/9.9` beside a protected `release/1.0`) or one that differs from it only in its digits
(`v2.0` beside `v1.4`). A rule no protected branch matches yet, or one that covers names of
other shapes, goes unseen then, and a new branch it covers can be made.

The text of a comment, a review, or a PR's or MR's description names no account with `@` and
says no `bors` anywhere in it, in whatever markdown, and holds no line starting with `/`: GitLab
runs such a line as a quick action in your name, and bots on either forge read the text as it
was sent and take a mention anywhere for a command from you (`@bors r+`, `@copilot ...`,
`@claude ...`, `/approve`).

Before it allows a push or a write, the machine asks the forge what the rule depends on: where
the branch is, which branch is the default, which protection rules there are, who opened the
PR, who is assigned, whose a fork is.
Only an answer
that settles the question counts; when the forge is rate-limited, failing or silent, the request
is refused. A refused request comes back to the agent with the reason.

## Hours

A job is leased two hours at a time. Before each lease ends the machine that offered it asks the
executor whether it is still working; an answer extends the lease, silence returns the job to
the pool ten minutes later. A job gets three attempts, on whichever machines take it - the same
one three times in a pool of one - and after the third the offer ends as failed. A machine
that failed at a job or gave it back leaves it to the others for two minutes, twice as long
each time, an hour at most. A start that
fails inside a container that was made is a failed attempt. A job a machine cannot start for a
reason of its own - it cannot fetch the repository, has no engine or image, or cannot make the
container - never ran: it goes back to the pool at no cost to its three attempts, and the
machine takes no job of that repository for a minute, twice as long after each such failure in
a row, ten minutes at most.

- **Hours a job of yours may take** - the limit from start to finish. Sent with every job.
- **Longest job this machine takes** - jobs allowed longer are left to other machines. Announced
  when joining a pool.

The two are independent. With the first above the second this machine takes none of its own
jobs, and the screen says so beside the fields.

Both are whole hours from 12 to 720 (30 days). A value written into `config.json` by hand is
read the same way by Diplomat and by the daemon: rounded to the nearest whole hour, below 12 as
12, above 720 as 720, and 12 when it is no number.

## The Network screen

Opened with the network button in the panel header. The daemon and whether Tor, docker, the
model credential and the devices are ready; this machine's key and onion address; how much work
it is taking and why not; the two hours settings and the devices switch; the network's lines of
the activity feed; and a card per pool with its members (last seen, unreachable) and jobs (kind,
state, where it runs, lease end). A job row offers **Stop** for a run on this machine - the job
goes back to the pool - or **Withdraw** for one this machine offered that runs elsewhere or
nowhere yet. **Stop** asks the daemon what runs here first: a run that ended since the screen
drew it is neither stopped nor withdrawn, and the card says so. **Restart daemon** leaves the
jobs in this machine's containers running; the daemon that starts takes them up at once, before
it has built its image or read the model credential, and a job whose run ended meanwhile is
stopped. If docker does not answer for a minute - when the daemon starts or while a job runs -
the jobs go back to the pool at no cost to their attempts. So does a job whose container a
reboot or a restart of Docker Desktop stopped before it finished, while the daemon ran or before
it started; one that had finished by then ends as it finished. A job whose container stopped
while the container's relay ran on stopped itself, and that costs its requester an attempt.

The daemon leaves a pool that is missing from the list Diplomat gives it, so what Diplomat
cannot confirm is never dropped from that list. A repo root or a checkout under Other repos
that cannot be read (a missing path, a volume not mounted, `git` failing on it) and a repository
whose login on its forge is not known yet keep the pool the daemon last had for them, and the
screen names each one and what ends it: */path cannot be read: its pool stays as the daemon
last had it until the path can be read or is taken out of Settings*, or *The login for
owner/repo on host is not known yet*. Every other pool follows Settings on the next cycle while
that lasts: a repository linked since gains its pool, one taken out leaves its own, and the
feed names each pool left and why. A root or a folder that was read and has no GitHub or GitLab
remote is no pool and holds nothing back; a self-hosted GitLab is recognised by a host name
starting with `gitlab.` or by `glab` being signed in to it. A repository whose remote is https on
a port other than 443 (or http on one other than 80) has no pool, since the network reaches a
forge on 443 only, and the screen says so; the rest of Diplomat works with it as with any other,
`glab` reaching it by the `--api-host` it was logged in with. A remote over ssh on another port
is the forge's own, and keeps its pool. A project cloned both on such a port and another way
keeps its pool by the other checkout, and the screen says the first is not counted. A list the
daemon refuses is shown with the daemon's own sentence and sent again once a minute, or as soon
as it changes.

A pool's card says why this machine takes none of that pool's jobs while it takes none - docker
or the model credential missing, Tor not ready, or a job of that pool it could not start - in
the daemon's words. A job of this machine's own that waits in the pool says on its row why this
machine does not take it itself, where the card does not say it for every job already: *this
machine takes jobs of at most 12 h and this one needs 24*, that its run was stopped here, or
that this machine failed at it or gave it back and until when it leaves it to the others. A
time in such a sentence is this machine's clock time.

A daemon that was given what only a test sets - a loopback transport in place of Tor, a figure
of the protocol changed - is no member to run on the network, and the screen says so in red
with each setting by name.

A job offered to the network shows in the task list like any other: *in the pool*, *running on
this machine* or on another member's key, then finished or failed. A job started by hand whose
offer the daemon has not answered yet reads *Offering to the pool…* until it has. That wait is
held in memory alone: quit Diplomat first and the job is forgotten here, while the daemon may
still hold its offer, which the Network screen then lists under its pool. Telemetry
prices a job from what the executor reports; work another machine ran counts against no limit of
this one. A job that took more than one attempt is priced from the last alone: what an earlier
attempt spent is in no figure. Where the executor lowered the tokens or the cost a job reported
to what it measured, the job's last line in the task list and in the feed ends *its reported
cost capped*. Only requests the provider accepted count towards what a job may report.

Work that was asked for - a sweep's PRs, a request from Slack - is
answered by a job that ran, not by its offer:

- A job that **finished** answers it. So does one the network gave up on with its three attempts
  used (*refused by the network*, or *failed on* a machine): it ran and came to nothing, as an
  agent in a terminal can, and is not offered again.
- Taking the offer back yourself ends it too: **Withdraw** on the Network screen, or the row's
  ✕ in the task list.
- An offer that ends any other way without having run - its pool left or closed, the network
  switched off, a daemon that no longer holds it - leaves what was asked for standing, and it is
  offered again on the next poll.

The daemon keeps an ended offer for a day. A job that ended while Diplomat was not running for
longer than that reads *the network holds no such offer* when Diplomat is back: it is not
priced, and what asked for it is offered again.

A `config.json` that is there and cannot be read as settings switches nothing, and nor does one
that was there and is gone: an editor that saves by renaming a new file into place, as vim and
nvim do on Linux, leaves none for a moment. Only a config that was never there - none read by
this Diplomat, and none named in `network-switch.json` - reads as the defaults. Diplomat keeps
the switch as it last read it, withdraws and starts nothing on that reading, saves no setting
over a file that is there, and says so in the feed; a setting saved while the file is gone
writes it anew. That reading outlives Diplomat, in
`~/.diplomat/network-switch.json`: a Diplomat that starts on such a file holds the network on
when the switch was last read as on, and on a machine where it never was the network is off.

While the network is held on like this every other setting in the file is unknown too - the
repo roots, the task cap, the budget. Diplomat tells the daemon neither this machine's pools nor
how many tasks it takes, and offers nothing, whoever asks, until the file reads again: the
pools stay as the daemon has them, and the panel's red line and the Network screen say
*…/config.json cannot be read as settings*. An offer made before that, which the daemon had
not answered, is still settled with it. The daemon takes five such reads, a second apart, and
then stops as it does when switched off. Diplomat does not start it again meanwhile - not on its
own and not at launch, and the Network screen's **Start daemon** and **Restart daemon** are
greyed out - and starts it on the first cycle after the file reads again. It still starts no
agent in a terminal.

Switching the network off withdraws this machine's open offers, stops the jobs it runs for the
pool and frees their PRs and issues for agents in terminals again. The daemon removes its
containers, mirrors and run records and exits; the machine's key, its pools and the image stay,
so switched on again it is the member it was. With no daemon running to do it, the stop
itself cancels the offers and ends the runs left in the daemon's store - a job that had
finished meanwhile ends as it finished and is not run again - and its line in the feed says
how many. A stop that could not remove one of those directories says which in the
same line, reads *ok: false* with no daemon left running, and the next switch-off tries
again. Work that was asked for and
had not run is started in a terminal from the queue on the next poll. A monitor's own find
counts its offer as an attempt, so it is started again on that monitor's retry schedule. A job
started by hand whose offer the daemon had not answered is withdrawn if the daemon turns out to
hold it; of any other the feed says that it was not offered, and it is started nowhere. Started with
the network off, the daemon does not start and says so.

## What it does not protect against

- **An executor sees what its job may see.** A machine that takes your job can read your
  repository through it, and can write what the job's kind allows - comments in your name, commits
  on the job's branch. Pushed code runs in whatever CI the repository already has. Invite
  machines you would give that to.
- **Your model quota runs your pool's jobs.** A job this machine takes spends this machine's
  model credential, up to the fuse.
- **Jobs of one requester on one repository that run at the same time share a container** and
  can see each other: each can read and change the other's files, and can read and use the
  other's key for that requester while both run. A job that starts while another still runs
  joins that container, with whatever the jobs before it left there. A process a job leaves
  behind lives until the last of them ends. Then the container is removed with its files, and a
  job that starts after that finds nothing of them, the run records it is shown included.
- **What is public on the forge is the internet.** The hosts a forge hands downloads out from,
  and any site by its bare address, are reached like any other site: a job can fetch another
  public repository's files there without the requester seeing it. Nothing private opens that
  way, since no container holds a credential.
- **A sleeping member counts as absent**, so a job can be taken without it. The machine that
  offered the job hands out one key per job, which is what keeps two executors from acting on it.
- **A job needs its offering machine awake.** Asleep, it hands out no key and performs no forge
  request, so its jobs stand still or stop (see Pools).
- **A split pool can run a job twice.** When two machines that both offered the same job lose
  sight of each other, each side can hand it to an executor of its own until they meet again.
- **Pools are small.** A pool's whole state travels in one message; it is built for the handful
  of machines and the tens of open jobs a team has, not for thousands.
- **macOS and Xcode toolchains** are not in a Linux container. A job that must build for Apple
  platforms needs a machine whose operator has arranged that; the network does not provide it.
