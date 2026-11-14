# Diplomacy Network

A peer-to-peer network of Diplomat machines, over Tor, that share the work on the repositories
they have in common. It is off by default. **Settings → Offer every job to the Diplomacy
Network** switches it on, and from then on it gates every job on this machine:

- Diplomat starts no agent in a terminal. Every job - a monitor's, the queue's, a wizard's - is
  **offered** to the pool of its repository.
- Some machine in that pool with a free slot **takes** it. That may be this one.
- Whoever takes it runs it in a **docker container**. Your own jobs on your own machine too.
- Everything the agent does on GitHub or GitLab is done by the machine that offered the job,
  **in its operator's name**, and only what that job needs.

The daemon behind it is [`diplomacy-network`](../packages/diplomacy-network/README.md); the
contract between two machines is its [PROTOCOL.md](../packages/diplomacy-network/PROTOCOL.md).

It needs `tor` and `docker` on the machine. Without docker a machine still offers its jobs and
acts for them, and takes none.

## Pools

One pool per repository, named by where the repository lives (`github.com/owner/repo`). A machine
is in the pools of the repositories linked in Settings (**Repo roots** and **Other repos**) and in
no other.

A pool's state - who is in it, which jobs are open, who is working on what - is a set of signed
records that every member keeps. Members compare a hash of that state and exchange whatever
differs, so no machine is in charge of a pool and none owns a job.

- **Joining.** The first machine to link a repository has a pool of one. Another machine joins by
  an **invite**: **Copy invite** on the pool's card, sent to the other operator by any means,
  pasted into **Join...** there. An invite is good for a day.
- **Leaving.** **Leave** stops this machine taking the pool's jobs and offering to it. It stays
  left until **Rejoin**.
- **Reaching each other.** A machine is reachable only as a Tor onion service whose address is
  its own public key, so there are no ports to open and no addresses to exchange. A first
  connection between two machines can take minutes; later ones take about a second.

Every request one machine sends another carries its own proof of work, bound to the sender, the
receiver and that one request. The work a sender owes doubles as its requests pile up, and a
stranger owes far more than a member.

## Taking a job

A machine takes work while it has room: the task cap in Settings, less what it already runs, and
nothing while the disk is low, the budget gate holds, or automatic work is paused. A job started
by hand in the panel is taken by this machine at once.

To take a job a machine confirms the pool's state with every member, asks every member for a
lock on the job, and commits only when all that answered agreed. A member that does not answer
is recorded as absent. Two machines reaching for one job are told apart by a rank computed from
the job and the machine's key, the same on every machine.

What a machine has - simulators, attached devices, toolchains - is never announced. It only
weighs it when deciding whether to take a job.

## Where a job runs

In a container built from one local image: Debian with git, node, python, curl, `gh`, `glab`,
`adb` and the agent itself. The agent is root in it and is told it may install whatever else it
needs.

- **One container per requesting machine and repository.** It runs every job that machine asks
  for on that repository, and never another machine's or another repository's.
- **No credential is inside it.** Not the forge's, not the model's.
- **It reaches nothing but the broker.** The container sits alone on an internal network; its
  only way out is a relay to a proxy on the host. Through it: the forge's API and `git push` go
  to the machine that offered the job; `git clone` and `fetch` of the repository are answered from
  the host's own mirror; the model's API is forwarded with the host's credential added; anything
  else is tunnelled, so installing software works. Addresses of the host, its network and other
  containers are refused.
- **Devices stay on the host.** A job reaches the host's adb server and tools only through
  forwards opened for that job.
- **A fuse.** One job gets 5000 model requests or 8 GiB of model traffic, then is refused.

## Acting in your name

The machine that offered a job performs every forge request the agent makes, with its own `gh` or
`glab` login, after checking the request against the rules of that job's kind. The key that lets
an executor ask is handed over once the job is taken, works for that executor and that job only,
and ends with the job.

| Job | May write |
|---|---|
| Review of someone else's PR | a review with line comments and thread replies on that PR; approve or request changes only where the review policy lets it |
| Answering reviews on your PR | thread replies, resolving threads, fast-forward pushes to that PR's branch; marking it ready only where the setting allows |
| Conflicts | fast-forward pushes to that PR's branch |
| Issue | assign itself, comment on that issue, push one new branch, open draft PRs from it |
| Audit | push new branches and open draft PRs from them; nothing when read-only |
| Investigate | nothing |

Every job may read the repository it belongs to and nothing else of the account. No job may
merge, close, force-push, delete a branch, push to the default branch, change CI workflow files,
or touch settings, secrets, releases or another repository. A refused request comes back to the
agent with the reason.

## Hours

A job is leased two hours at a time. Before each lease ends the machine that offered it asks the
executor whether it is still working; an answer extends the lease, silence returns the job to
the pool ten minutes later. A job gets three attempts.

- **Hours a job of yours may take** - the limit from start to finish, 12 or more. Sent with every
  job.
- **Longest job this machine takes** - jobs allowed longer are left to other machines. Announced
  when joining a pool.

## The Network screen

Opened with the network button in the panel header. The daemon and whether Tor, docker and the model credential are ready; this machine's key and
onion address; how much work it is taking and why not; the two hours settings; the network's
lines of the activity feed; and a card per pool with its members (last seen, unreachable) and
jobs (kind, state, where it runs, lease end). A job row offers **Stop** for a run on this
machine - the job goes back to the pool - or **Withdraw** for one this machine offered.

A job offered to the network shows in the task list like any other: *in the pool*, *running on
this machine* or on another member's key, then finished or failed. Telemetry prices it from what
the executor reports; work another machine ran counts against no limit of this one.

Switching the network off withdraws this machine's open offers, stops the jobs it runs for the
pool and frees their PRs and issues for agents in terminals again.

## What it does not protect against

- **An executor sees what its job may see.** A machine that takes your job can read your
  repository through it, and can write what the job's kind allows - comments in your name, commits
  on the job's branch. Pushed code runs in whatever CI the repository already has. Invite
  machines you would give that to.
- **Your model quota runs your pool's jobs.** A job this machine takes spends this machine's
  model credential, up to the fuse.
- **Jobs of one requester on one repository share a container** and can see each other.
- **A sleeping member counts as absent**, so a job can be taken without it. The machine that
  offered the job hands out one key per job, which is what keeps two executors from acting on it.
- **macOS and Xcode toolchains** are not in a Linux container. A job that must build for Apple
  platforms needs a machine whose operator has arranged that; the network does not provide it.
