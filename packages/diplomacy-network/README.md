# diplomacy-network

The Diplomacy Network daemon: one per machine, started by Diplomat while the network is
switched on. It joins the machine to a peer-to-peer network over Tor, keeps one shared
task pool per linked repository, claims tasks when this machine has a free slot, runs
every claimed task inside a docker container, and performs forge actions for the tasks
this machine asked for. The wire contract between two daemons is [PROTOCOL.md](PROTOCOL.md);
this file is how one daemon is built.

While the network is on it gates every job: Diplomat hands each job to this daemon as an
offer and never spawns an agent itself. A job this machine asked for and this machine
claimed still runs in a container, like anyone else's.

## Layout

```
src/
  core/        pure protocol logic: no I/O, no clock, no randomness of its own
    canon.js       canonical JSON, hashes, base64url, byte helpers
    identity.js    Ed25519 keys, signatures, onion address, Tor's key format
    pow.js         seed, challenge, solve, verify, the effort a sender owes
    envelope.js    request and response envelopes: build, verify
    records.js     member, offer and claim records: shape, signature, precedence
    membership.js  invites, vouchers and who is seated
    pool.js        one pool's record set: merge, index, state hash, task view
    claims.js      locks, grants, ranks, the claim round's decisions
    lease.js       hours, leases, pings, extensions, lapse
    capability.js  capabilities, MACs, sequence numbers
  transport/
    index.js       picks the transport by kind
    tor.js         runs tor, publishes the onion service, dials peers through SOCKS
    loop.js        the same interface on loopback TCP, for tests
    http.js        POST /dn1 framing over either
  node/
    node.js        one host as one object, over an injected store, transport, clock,
                   requester and executor
    gossip.js      membership, joining by invite, pushing records, the periodic sync
    claiming.js    which task a free slot goes for, and the claim round that gets it
    offers.js      the requester's side of a task: offers, keys, `act`, pings, the end
    runs.js        the executor's side of a task: the key, the job, the lease, the release
    inbound.js     what every request passes before anything is done for it
    peers.js       sending a request to a peer, and what is remembered about each
    store.js       what survives a restart, as JSON documents under one directory
    offline.js     the switch-off of a host that is not running, done on its store
  requester/
    rules.js       the rule catalogue per forge and kind
    authorize.js   decides one forge request against a task's rules
    graphql.js     the GraphQL document check
    receivepack.js the push check: ref commands, fast-forward proof
    forge.js       performs an allowed request with this machine's credentials
  executor/
    broker.js      the proxy every container talks through
    ca.js          the broker's certificate authority and leaf certificates
    llm.js         the model credential the broker adds
    mirror.js      the bare mirror a container clones from
    container.js   image, one container per peer and repository, its network and relay
    job.js         one run: prompt, start, watch, stop, outcome, and what is kept of it
    adb.js         the filter between a job and this machine's adb server
    weigh.js       how long this machine holds back from a task, by what it has
    sparing.js     the log for what a job can cause as often as it likes
    forward.mjs    inside a container: a job's forwards as local addresses
    runner.sh      inside a container: one job's environment, clone and agent
    stop.sh        handed to a container's sh: asks after one job's processes, ends them
  daemon.js      the process: local socket, config, the node joined to its transport,
                 requester and executor
  install.js     what the applets run: --check, --start-daemon, --restart-daemon, --stop-daemon
  paths.js       files, tools and tunables
  ipc.js         the local-socket client
image/
  Dockerfile     the one image every job runs in
  relay.mjs      what the relay beside each job container runs
  preamble.md    what an agent is told about the container it is in
test/            one self-contained *.mjs per subject, run by test/run-all.mjs
```

## State directory

`~/.diplomat/network` (`DN_BASE_DIR` relocates it; every test does). It holds prompts
of private repositories, tokens and keys, so all of it is the operator's alone: the
directory is 0700, every directory under it 0700 and every file 0600, whatever the umask
of the process that started the daemon - the daemon runs under a umask of 077, tor, git
and openssl with it - and a directory or a log an earlier daemon left more open is
closed at every start.

| File | Holds |
| --- | --- |
| `daemon.sock`, `daemon.json`, `daemon.log` | as in the other daemons. A log that has reached 16 MiB is copied to `daemon.log.1`, over the copy before it, and starts again |
| `state.json` | the snapshot as the daemon last had it, for a person looking into a daemon that no longer answers: the applets ask the socket |
| `identity.json` (0600) | the host key |
| `heard.json` (0600) | the time of the latest request this host served: after a start it serves nothing dated at or before it, or at or before the second of the start where that time is ahead of this machine's clock |
| `peers.json` (0600) | the machines this host has asked in vain for more than 3 minutes, and since when: after a start a claim round waits 15 s for each of them, not the 90 s and more it gives a machine it has yet to reach |
| `links.json` (0600) | the linked repositories, as Diplomat last posted them |
| `pools/<pool hash>.json` (0600) | that pool's records; of a pool this machine left, the record that says so and the members it left, which it keeps once it is back until it holds the record of one of them |
| `pools/<pool hash>.log` (0600) | what changed in that pool since its document was written: the hash of the document it follows, then a line for each change - the records taken in and the keys of the records dropped. Once it is as long as the document, and no shorter than 64 KiB, the document is written whole and the log removed |
| `locks.json` (0600) | the claim locks this host granted |
| `keys.json` (0600) | live capabilities this host issued or holds |
| `offers.json` (0600) | the tasks this host asked for: prompt, counters, outcome, what each has used of its rules' allowances, and which members gave it back a moment ago |
| `runs.json` (0600) | the tasks this host runs or ran, and the tasks it gave up on: how often, and until when it leaves each alone |
| `jobs.json` (0600) | the jobs going in this daemon's containers, for the daemon after it: the broker's port, and each job's container, proxy token, CA generation, process group, forwards and what it has spent of the model, the last no more than 5 s behind |
| `tor/` | tor's data directory |
| `ca/<id>/` (`ca/` is 0700) | the broker's certificate authorities, one per set of hosts it reads: `ca.key`, `ca.crt`, `meta.json` and the `leaves/` issued under it. A leaf is good for 90 days, is replaced from two weeks before its end, under a running job too, and is removed once past it |
| `mirrors/<pool part>.git` | bare mirrors, each named by the 128 bits its pool has in a container's name. One is removed a day after its pool was last linked and not left, never from under a job that reads it, and all of them when the network is switched off; one named by sixteen hex digits is an earlier version's, is not read, and goes a day after it was last touched |
| `runs/.containers/<container>/<run id>/` | one job: `prompt.txt`, `env.sh`, `log.jsonl`, `done`. `runs/.containers/<container>/` is all of `runs/` that container is shown, and it can write there; `runs/<run id>` is a link to the job's directory. Both are removed a day after the job ended - the directory first, and the link only once the directory is gone, so one that will not go is met again at the next look - and `runs/.containers/<container>/`, with whatever else a job left in it, once the container is gone and no run in it is kept |
| `runs/<run id>.outcome.json` | that job's outcome, written by the daemon when the job ends, where no container can write, and removed once its directory is gone |
| `runs/.staging/` | a job's directory while it is put together, before its container can see it |

The node's documents are written in one order - identity, `heard`, `peers`, links, pools, locks,
keys, offers, runs - each whole, through a temporary file: a run is on disk only after
the key it was started with. They are read back as plain JSON; only what travels between
hosts has to be canonical. A pool's document holds at most 241 members with at most 256
KiB of records each (PROTOCOL.md section 5), and is rewritten when a record of it
changes.

A job's directory is kept for the day after its end for the operator to see what the job
did: `runs/<run id>/log.jsonl` is the agent's stream. It is the job's own writing - a job
can put a link, a pipe or a file of any size in its place - so the snapshot names no file
of it; nothing else reads the directory once the outcome is reported. A machine that leaves the network has no further use
for any of it: when the network is switched off, `runs/`, `mirrors/` and `ca/` are
removed whole, once nothing is left in docker that could still write there. Its key, its
pools, its links and what it offered stay - switched on again it is the member it was -
and so does tor's directory, which holds nothing of anybody's work. `DN_RUN_KEEP_MS` and `DN_MIRROR_KEEP_MS` set the two
days; both are looked at every 10 minutes, with what is left under a container's name
that no job is in, the images no job is started in, the old
certificate authorities and the certificates past their end. A container reads its run directory through a bind mount as
its own root, which the engine maps to the operator (Docker Desktop, rootless docker) or
to the host's root (rootful docker on Linux): either reads 0700 and 0600. Under
`userns-remap` it is neither, and a job could not read its own prompt.

Settings come from Diplomat's `config.json` (`DIPLOMAT_CONFIG` relocates it), re-read
every second: `networkEnabled`, `networkRequiredMinimumH`, `networkMaximumAcceptedH`,
`networkDevices`. The two hours settings take effect at the next offer and the next
claim, without a restart, held to the 12 to 720 hours the network allows.
`networkDevices` is `true` or absent, and decides what the jobs started from then on are
given of this machine's devices ("Devices" below). The daemon switches off and
exits when `networkEnabled` is not `true`. A config that cannot be read says nothing
until it has been unreadable five polls in a row - one read can fall in the middle of a
rewrite - and then counts as switched off.

A `DN_...` variable that sets a number is taken when it says a number of zero or more;
unset, empty or anything else, the default stands. Zero is zero: a wait of 0 is no wait,
an allowance of 0 nothing (`DN_JOB_MODEL_REQUESTS=0` gives a job no request to the
model), an interval of 0 as often as the process can. Seven settings bound how long or
how much something of this machine's may take, and what holds them - node's timers,
docker - reads 0 as no bound at all: `DN_GIT_TIMEOUT_MS`, `DN_MIRROR_TIMEOUT_MS`,
`DN_IMAGE_BUILD_TIMEOUT_MS`, `DN_CONTAINER_USAGE_TIMEOUT_MS`, `DN_KEYCHAIN_TIMEOUT_MS`,
`DN_JOB_IDLE_MS` and `DN_CONTAINER_PIDS`. For these 0 is not taken: the default holds,
and `daemon.log` says so at the start (`DN_CONTAINER_PIDS=0 would leave no bound where
one always holds: the default is used`).

The model credential a job's requests leave with is this machine's own, added by the
broker on the host and never present in a container. The first of these that exists is
used: `networkModelToken`, an API key or subscriber token kept for the network alone (on
macOS the Keychain item with service `Diplomat-networkModelToken` under the user's
account, elsewhere the file `~/.diplomat/network-model-token`); the Claude Code login;
`ANTHROPIC_API_KEY` in the daemon's environment. A Keychain item `security` has not
answered for within 30 s (`DN_KEYCHAIN_TIMEOUT_MS`) counts as not there.

## Local socket

HTTP over `daemon.sock` (0600), JSON in and out. The socket answers as soon as the
daemon is up; the transport comes up behind it, and over Tor that takes minutes.

| Route | Body | Answer |
| --- | --- | --- |
| `GET /health` | | `{ ok: true, pid }` |
| `GET /state` | | the snapshot |
| `POST /pools` | `{ pools: [{ id, path, forge, identity }] }` | `{ ok: true }` - every linked repository; a pool missing from the list is left |
| `POST /admit` | `{ slots, reason? }` | `{ ok: true }` - how many more tasks this machine takes now |
| `POST /offer` | `{ pool, kind, options?, item, title, prompt, base?, now? }` | `{ taskId }` - the same id again for an offer still open |
| `POST /withdraw` | `{ taskId, reason? }` | `{ ok: true, ended: true }` - `reason` is free text, kept with the cancelled offer |
| `POST /invite` | `{ pool, ttlSecs? }` | `{ invite }` |
| `POST /join` | `{ invite }` or `{ pool }` | `{ pool }` - by invite into someone's pool, or back into a pool this machine left |
| `POST /leave` | `{ pool }` | `{ ok: true }` |
| `POST /stop-run` | `{ runId }` | `{ ok: true }` - the run is stopped and its claim released; the task is in the pool again for another machine, and this one does not take it again while that offer stands |

Every other answer is `{ error }` with a status that says whose fault it was:

| Status | Means |
| --- | --- |
| 400 | the body is not what the route reads: not JSON (`The request body is not JSON.`), not an object, a member missing or of the wrong type or size. Members a route does not read are ignored |
| 409 | the body is well formed and the network refuses it; `error` is a sentence fit to show the operator |
| 404 | no such route |
| 413 | the body is longer than 4 MiB of characters (`The request body is longer than 4194304 characters.`); it was read to its end and none of it kept |
| 503 | the daemon is on its way out (`The Diplomacy Network daemon is stopping.`): nothing was done, and the daemon after it takes the same request. Only a request already under way is answered so: from the moment it starts to end the daemon takes nobody new, and its socket is gone. Until the process is, `install.js --check` says `daemonRunning: false` and `--start-daemon` answers that the daemon is running but not answering |
| 500 | a fault of the daemon's own; the same line is in `daemon.log`, and the daemon goes on |

`offer` answers as soon as the offer is signed and stored on this machine. It does not
wait for any other member to hear of it: the pool is told in the background, and the
snapshot shows the offer `pooled` meanwhile. The commits a job makes are authored as
`user.name` and `user.email` of the offering machine's checkout say; an offer from a
checkout that has neither is refused. How long a task may be is one limit: its prompt
and options, as the task is sent to another machine, come to half a mebibyte at most,
and a longer one is a 409 (`... its prompt and options are too long.`). The socket reads
eight times that, so no task under the limit is cut short by how its JSON was written.

`withdraw` is safe to repeat. A task this machine has no open offer of - one it never
offered, one that already ended, one already withdrawn - is answered `{ ok: true,
ended: true }` like one it just cancelled, so an applet can withdraw on merge, on forget
and on switch-off without keeping count. Only a malformed body is refused.

`join` by invite needs the invite's repository linked on this machine first; otherwise
it is refused with `The pool <id> is not linked on this machine.` An invite that is no
invite, has run out, is not signed by the machine it names, or was made on this machine
is refused with a sentence saying which. `join` answers once the invite is kept: the
machine that made it is asked for a seat then, and again, less and less often, until it
answers or the invite runs out. When that machine gives none, the log says `the invite
to <pool> let this host in nowhere: <why>` and this machine stays the only member of
its own pool. An invite lets in every machine that brings it before it runs out.

`invite` is refused when this machine has no seat to give (PROTOCOL.md section 5):
`This machine is 2 invites away from the one that started the pool <id>, and invites
nobody: ask a machine nearer to that one.` or `Every one of the 15 machines this one may
invite into the pool <id> is a member of it: ask another machine of the pool.`

Member records signed by a build that knew no vouchers are not read. A machine that
finds none of its own that it can read is the only member of its pool, with the tasks
it offered, and the other machines join it by invite again.

`pools` is the whole list every time, so Diplomat posts it only when it knows every
linked repository and whose account each is: a list cut short makes this machine leave
the pools it omits. `admit` goes stale after 120 s: a daemon that has not heard from
Diplomat takes nothing. An offer with `now` is claimed by this machine at once, whatever
`admit` says - that is a job its own operator started by hand. `base` is the branch or
revision the job starts from; without it a job on a pull request starts from that pull
request's head and any other from the default branch.

A pool this machine left stays left, whatever `pools` says, until a `join` or until the
repository is unlinked and linked again; its row carries `"left": true` meanwhile. The
linked repositories are kept across a restart of the daemon; `admit` is not.

`src/install.js` is what the applets run. Each flag prints one JSON object and exits 0,
within 75 s whatever it finds (`DN_INSTALLER_ANSWER_MS`): the applets wait 90 s for an
installer, then kill it and have no answer.

| Flag | Prints |
| --- | --- |
| `--check` | `{ "installed": true, "daemonRunning": <bool>, "pid": <pid or null> }` - there is nothing to install, so `installed` is constant |
| `--start-daemon` | `{ "ok": <bool>, "daemonRunning": <bool>, "pid": <pid or null>, "error"?: "<why>" }` - the daemon that already runs, or one started for it once its socket answers. A daemon that could not finish its start has exited by then, and `error` carries its reason |
| `--stop-daemon` | the same object: `ok` once no daemon is left, which with none running is at once. With the network switched off in the settings it then does what a daemon that was not running, died before it could switch off, or found the engine down never did. In the store it cancels every offer of this machine's own that has not ended, stops its runs and gives their claims back, under the records a switch-off signs: nobody is told then, and the pools hear when the daemon next starts. `ended` says how many, `{ "offers": <n>, "runs": <n> }` - both 0 after a daemon that switched itself off. The daemon's socket is held meanwhile and answers 503, so a daemon started in that moment exits and none runs; while a daemon has the socket or is taking it, the ending is that daemon's and the answer has no `ended`. It then removes what is left in docker of this state directory's daemons, and `runs/`, `mirrors/` and `ca/` with it. An engine that refuses is asked again every 5 s (`DN_EXECUTOR_RETRY_MS`) for as long as the answer may wait; with it still down or silent by then, `ok` is false and `error` says what is still there, and the next `--stop-daemon` does it again |
| `--restart-daemon` | the same object: a stop, then a start |

The snapshot:

```json
{ "updatedAt": 0, "daemon": { "pid": 0, "startedAt": 0 },
  "identity": { "pk": "...", "onion": "....onion" },
  "transport": { "state": "starting|bootstrapping|publishing|ready|failed", "detail": "" },
  "docker": { "state": "ready|missing|down|building|failed", "image": "", "detail": "" },
  "model": { "state": "ready|missing", "detail": "" },
  "devices": { "state": "off|ready|none", "detail": "" },
  "admit": { "slots": 0, "at": 0, "reason": "" },
  "pools": [ { "id": "", "path": "", "identity": "", "hash": "", "left": false, "joining": false,
      "joinFailed": "", "unseated": false, "returning": false, "notTaking": "",
      "members": [ { "pk": "", "self": false, "maxAcceptedH": 12, "lastSeen": 0, "reachable": true,
          "skew": false } ],
      "tasks": [ { "taskId": "", "kind": "", "item": "", "title": "", "identity": "", "hours": 12,
          "state": "available|claimed|done|cancelled", "blocked": "", "offeredBy": [""], "offeredHere": false,
          "executor": "", "executorHere": false, "claimedAt": 0, "leaseUntil": 0, "deadline": 0 } ] } ],
  "runs": [ { "runId": "", "taskId": "", "pool": "", "peer": "", "container": "",
      "state": "preparing|running|finished|failed|stopped", "startedAt": 0, "endedAt": 0,
      "exit": 0 } ],
  "offers": [ { "taskId": "", "pool": "", "kind": "", "item": "", "title": "",
      "state": "pooled|claimed|done|failed|cancelled", "reason": "", "executor": "",
      "executorHere": false, "backedBy": [""], "offeredAt": 0, "attempt": 1, "requests": 0,
      "refused": 0,
      "outcome": { "ok": true, "summary": "", "usd": 0, "tokens": 0, "runner": "", "model": "" },
      "endedAt": 0, "leftUntil": 0, "leftForGood": false, "tooLong": false, "notTaking": "" } ] }
```

Every time is Unix seconds. `offers` are the tasks this machine asked for: `pooled` while
nobody holds it, `claimed` while an executor does, `done` when an executor finished it
well, `failed` when its attempts ran out (`reason` says how the last one ended), and
`cancelled` once withdrawn, or once this machine was away for longer than an offer
lasts (`reason` says which). `outcome` is null until an attempt has reported one, and
carries `"capped": true` beside the rest when the machine that ran the job lowered the
tokens or the cost the job named to what it measured. An offer gets three attempts. A machine that failed at one leaves the task to the other
machines for two minutes, then four, and goes for it again when none took it - so a
machine alone in its pool makes all three itself. A claim given back with no job run -
the run was stopped, or could not start for a fault of the machine that took it - uses
up no attempt. An ended offer stays in the list for a day, and keeps the `executor` and
`executorHere` of the machine that last held it - the one that reported it done, or the last to hold it
before it failed or was cancelled; `executor` is empty only when nobody ever held it.

An offer may also be `done` with no report: its job was run for another machine's offer
while this machine was away. Its `outcome` then has the `summary`
`run for another machine's offer of the same job` and no cost, `executor` is the machine
that ran the job, and `backedBy` lists the machines whose offers the run was given -
the one that ran it among them when it ran its own offer. `backedBy` is empty for every
other offer.

`docker` and `model` say why this machine takes no work when it takes none: their `detail`
carries the reason. `devices` is `off` until the operator sets `networkDevices`, then
`ready` while an adb server answers on this machine and `none` while none does.
`transport` is `failed`, with the reason, between a start that failed and the next one.

A pool's `joining` is true from the moment an invite is pasted until the machine that made
it has answered or the invite has run out: this machine is a pool of one meanwhile. Its
`joinFailed` is why the last invite let this machine in nowhere - what the other machine
said, or that the invite ran out unanswered - and is empty once another invite is pasted.
Its `returning` is true while this machine, back in a pool it left, holds the record of no
other machine there and asks the machines it left: it is a pool of one until one of them
answers, and needs no invite. That is the machine that started the pool, back after more
than 30 days; any other asks the machine that invited it, whose record it kept.
Its `unseated` is true while every other machine this one knows of in the pool - or, while
it is `returning`, every machine it left - has refused it and answered it nothing since:
the seat it had there is no longer its own - the machine that gave it began the pool again
or gave the seat away, or the pool moved and left it too far from the machine that started
it - and it gets into the pool again by an invite.

A pool's `notTaking` is why this machine takes none of that pool's jobs, in a sentence,
and empty while it takes them: the transport is not up, docker is not ready, there is no
credential for the model, or the last job of the pool could not be started here
("Executor side" below). An offer's `notTaking` is why this machine does not take that
job of its own while it is `pooled`: its pool's `notTaking`;
`this machine takes jobs of at most 12 h and this one needs 24` when
`networkRequiredMinimumH` is above `networkMaximumAcceptedH`;
`its run was stopped on this machine, which does not take it again` once the operator
stopped a run of it here; or
`this machine failed at it or gave it back, and leaves it to the others until <time>`.
It is empty for a job this machine is free to take, and for one that is not `pooled`.
The last three are in the row as it comes from the node too, for a `pooled` offer:
`tooLong`, `leftForGood`, and `leftUntil` - the Unix second until which the machine
leaves the job alone, 0 when it does not. A machine alone in its pool takes the job
itself when that time has come. `admit` is Diplomat's
word and is said nowhere else: with no slot free a job waits unless its operator
started it with `now`.

A `tasks` row is one task, however many machines offer it: `claimed` while a claim holds
any open offer of it, `available` while offers are open and none is held, `done` when
none is open and one was done, else `cancelled`. `offeredBy` lists the machines whose
offer is open and `hours` is the longest of those offers. `executor`, `claimedAt`,
`leaseUntil` and `deadline` are those of one claim: this machine's own, else the one
that holds this machine's offer, else the one that holds the most offers. What became of
this machine's own offer is in `offers` and nowhere else: each machine's offer of a task
ends by itself.

A member's `skew` is true when its last answer said its clock and this machine's are
more than 300 s apart: neither takes the other's requests, and a claim round goes on
without that member. A task's `blocked` is `clock` while it is available and that is so
for every host a claim of it needs - the hosts offering it, or every other member when
this machine offers it: nobody can take it until the clocks agree. Otherwise it is empty.

The same snapshot is written to `state.json` (0600), replaced whole and at most once a
second (`DN_STATE_WRITE_MS`), and once more as the daemon ends. Nothing reads the file
but a person - it is what a daemon that no longer answers last had to say - and it is
not forced to the disk.

## What runs where

**The process.** `daemon.js` is one process per state directory: a second one started on
the same directory finds the first answering and exits 0, naming it in the log. It
listens on the socket, then builds the node over its store, its transport, and the two
adapters below; the node itself knows no file, no socket and no docker. A daemon that
cannot be built - `daemon.json` or a document of the store that cannot be written or
read, a `DN_TRANSPORT` that names no transport - exits 1 with the reason in `daemon.log`
and in the installer's answer, and leaves no socket and no `daemon.json`: nothing
answers `/health` for a daemon that has no node.

A transport that does not start - a machine that came up offline, a tor that is not
installed yet - is started again by the same daemon: after 5 s, then after twice as long
each time, up to 5 minutes (`DN_TRANSPORT_RETRY_MS`, `DN_TRANSPORT_RETRY_MAX_MS`). Each
try is a new transport behind the one the node holds.

It runs `tor`, `docker`, `git`, `gh`, `glab`, `openssl` and `claude` by name. Diplomat,
started by launchd or by a desktop session, is given the system's directories alone and
so is the daemon it starts, so the daemon looks further: on the PATH it was given, then
in the directories a user's installs put a tool in - Homebrew's (`/opt/homebrew/bin`,
`/usr/local/bin`, `/home/linuxbrew/.linuxbrew/bin`), `~/.local/bin`, `~/bin`, Docker
Desktop's (`~/.docker/bin` and the app's own), the nix profiles, MacPorts' and snap's
(`DN_TOOL_DIRS`, colon-separated, in place of that list) - then beside `node` itself.
Everything it starts is given that PATH, so `gh` finds `git` there and `docker` its
credential helper. `DN_TOR`, `DN_DOCKER`, `DN_GIT`, `DN_GH`, `DN_GLAB`, `DN_OPENSSL` and
`DN_CLAUDE` each name one tool by its path instead. Where each tool is, or that it is in
none of those directories, is in `daemon.log` from the start and again whenever it
changes: one installed while the daemon runs is found by the next try, with no restart.
A `tor` that is nowhere is the snapshot's `transport.detail`, a `docker` that is nowhere
its `docker.detail`.

It ends in one of two ways. Stopped (`SIGTERM`, `SIGINT`, `SIGHUP`,
`install.js --stop-daemon`) with the network still on, it stops the node and the
transport - and with it tor - and leaves its runs going in their containers for the
daemon after it. Switched off
(`networkEnabled` not `true`, whether the daemon reads that itself or is stopped just
after the setting was written), it first cancels every offer of its own that has not
ended, stops its runs and releases their claims, tells its pools, removes every
container, relay, network and volume that carries this state directory in its `dn.base`
label (the image stays), then `runs/`, `mirrors/` and `ca/`, and then exits. A job that
was being started when the switch came is not started, and the switch-off waits for its
start to find that out. Both ends exit 0, with one exception: a switch-off that could
not take everything out of docker - the engine refused or did not answer, or a start
outlasted the wait - says in `daemon.log` what may still be there, keeps `runs/`,
`mirrors/` and `ca/`, and exits 1; `install.js --stop-daemon` removes it once the engine
answers. A second signal ends the daemon at once, with exit 1. A daemon that was not
running when the network was switched off ended nothing: `install.js --stop-daemon`,
which the applets run at the switch, does it in its place.

A daemon that ends after another took its socket over - it had answered nothing for
longer than a start waits - leaves the socket and `daemon.json` to that one.

A job leaves `jobs.json` only after the node's word on how its run ended is in
`runs.json`: a daemon killed at any moment of a job's end leaves either the job still
listed or its run ended, and the daemon after it reads the outcome of a listed job, and
of any run the node still calls running, from `runs/<run id>.outcome.json`. A job that
finished while its daemon was going is done once, not run again.

An exception nobody caught, in whatever event's handler or timer, is written to
`daemon.log` once with its stack (`uncaught: ...`) and the daemon goes on: the jobs it
watches are worth more than the one event. The same exception - same message, same
place - five times within a minute (`DN_FAULT_WINDOW_MS`), or five times in a row from
one timer's work however seldom that timer comes round, is one it does not get past, and
it exits 1 with its runs left going. Nothing reads that status. Diplomat, while it runs
and the network is on, asks the daemon for its snapshot, and starts the daemon when
nothing answers: at once, then no sooner than 15 s after that try, then after twice as
long each time, up to 10 minutes. A promise nobody waited for is logged the same way
(`unhandled: ...`) and never ends it.

A tool named by hand is said so in `daemon.log` beside where it is
(`docker is /x/docker, which DN_DOCKER names`): whatever stands in a tool's place has
what the daemon gives that tool, and a docker that is none runs a job on this machine
itself. What only a test sets is honoured by any daemon that is given it, so each is
said in `daemon.log` at the start, by name and value, and none belongs in a daemon on
the network: `DN_TRANSPORT=loop` (loopback TCP in place of Tor; the snapshot's
`transport.detail` then begins `loop (test transport)`), `DN_FORGE_ORIGINS` (where each
forge host is reached), `DN_POW_*` (how much work a request costs) and `DN_TEST_FAULTS`
(a file of faults for the daemon to throw).

**Requester side.** `POST /offer` signs an offer record and pushes it to the pool. A
machine that takes the task asks this one for its offer, and this one gives it to one
claim at a time. When the executor of the claim that holds the offer asks for the key,
the daemon issues a capability whose rules come from `requester/rules.js`, and from then
on performs each allowed `act` request with this machine's own `gh` or `glab`
credentials (`requester/forge.js`). It pings that executor before each lease runs out,
and marks the offer done when that executor reports the outcome of the job this machine
hands out for it.

**Several machines, one task.** Machines linked to one repository under one forge login
that offer the same item offer one task, and it is run once: the claim of the machine
that takes it holds the offer of every one of them it could reach, a machine that
offers the task while the run is going is taken into that run, the job comes from one
of the offering machines, and each marks its own offer done on that run's report. That
takes the same job on each of them, to the byte - title, prompt, options, base revision,
and the `user.name` and `user.email` its commits are authored with. A machine whose job
differs has done nothing by that run: its offer is free again when the run ends and is
run next, by itself. Withdrawing or failing an offer on one machine changes nothing on
another.

No machine owns a task in the pool: any machine in it with a free slot may take it. But
a task cannot do without the machine that offered it. Only that machine gives the task
to the one that takes it, hands out the prompt and the key, makes every request to the
forge, and keeps the run's lease going. While it is asleep or off, a task of its that
nobody took is taken by nobody, a run of a task of its cannot reach the forge and is
stopped when its lease ends - two hours at most, and ten minutes - and after a day its
offers are gone from the pool. And a machine that does not answer when a task is taken
is not waited for: the task is taken without it, with its name on the claim as absent.

A machine that was asleep, off or without a network while its job was run for another
machine's offer finds the run on record when it is back, and marks its own offer done
without a second run. It asks the pool what it missed before it does anything for its
offers - a moment when any of the others answers, three minutes when none does - and an
offer it could not sign for a day it cancels: Diplomat
offers the work again when the forge still shows it undone. Of two machines, when one
runs its own offer while the other sleeps, the sleeper marks its offer done when it
wakes: the job is run once. Two machines that cannot reach each other each have it
run. And the record of a run is its machine's word: a machine in the pool that holds
the same job can say it ran it and have the others mark their offers done unrun, which
is no more than a machine that takes a job and reports it done can do. The exact rules,
and what a member that offers somebody else's task can and cannot do with it, are in
PROTOCOL.md, section 7: "A job that was run for another offer", "A host that was away"
and "What remains".

A request is checked before it is sent (`requester/authorize.js`). Where the check
depends on the forge - where a branch is, which branch is the default, whether it is
protected, who opened a pull request, who is assigned, whose a repository is and what it
is a fork of, which branch a CI run ran for - the forge is asked, and an answer
that does not settle the question refuses the request: a rate limit or an error is not
"no such branch". A push goes to the pool's repository or to the fork of it held by the
account the pool is linked with (its `identity`), where the head branch of a pull
request opened from that fork lives, and to no other repository: not somebody else's
fork, not an organisation's or a group's, not a fork of a fork. A push is read whole
(`requester/receivepack.js`): its pack is measured
before git sees it and refused when its objects add up to more than
`DN_PUSH_UNPACKED_MAX_BYTES` (512 MiB) once unpacked, then indexed in a quarantine with
git's own object check, where the fast-forward and the pushed files are proven.

What a task has used of its allowances - the branches it created, the pull request it
opened from each - is the task's, not the key's: it is kept with the offer in
`offers.json`, written before the request that uses it is sent, so every key issued for
the task goes on from the same count and a restart forgets none of it. A branch is the
task's own once the forge's answer to the push says so, a pull request its one once the
forge's answer says it was opened. A creation whose answer never came stays counted until
the forge is asked what became of it, before the task's next push or pull request is
checked (PROTOCOL.md, section 10).

What a task reads is listed by its kind as what it writes is (`requester/rules.js`).
Every kind reads the repository's code - files, refs, commits, a compare, and the
statuses and check results recorded on a commit - and, as context, every pull request and
issue with the comments and reviews on it. The lists the forge keeps of an item - a pull
request's files, commits, requested reviewers and merge state, an issue's events, labels
and reactions - are read by the task whose item it is: the three pull request kinds for
their pull request, `issues` for its issue. A pull request's diff is no such list: it is
repository code, which every kind reads as a compare and, on GitHub, as the pull request
itself in diff or patch form (`gh pr diff`). A CI run, its jobs and their logs are read by id, after
the forge has said which branch the run was for: a branch the task created, the head
branch of the pull request a pull request kind works on, or - `audit` and `investigate` -
the default branch. No kind has a rule for a list of runs, artifacts, releases,
deployments, environments, events, traffic, contributors, statistics, source archives,
the repository's labels and milestones, or the accounts that can be assigned or
mentioned; no query `gh` or `glab` makes by default needs one. A GraphQL document is held
to the same at the repository's root: it goes on from there to pull requests, issues and
code, and not to labels, milestones, releases, runs or people. Below the root it is
checked by field name, so what REST gives for one item it gives for every pull request
and issue of the repository.

A pool's rules stand on the hosts its forge serves the repository on. github.com has its
API on `api.github.com` and git on `github.com`. A GitHub Enterprise Server has both on
the pool's host, REST under `/api/v3` and GraphQL at `/api/graphql`: its tasks get
github.com's rules there, with the credential `gh` holds for that host, and one rule
more - `GET /api/v3/meta`, cut to the server's version, which `gh` asks for before
`pr view`, `issue view`, `pr create` and a search. A GitHub pool on a subdomain of
github.com or of ghe.com (GitHub Enterprise Cloud with data residency) gets no rules, so
no task of it is offered: `gh` reaches that API on `api.<host>`, a name nothing here
speaks to.

A request reaches a rule in one spelling: a path that escapes a character needing no
escape is refused, and so is one that a forge's router could read as the route of a rule
standing earlier - by a letter's case or an added extension. A name GitLab takes as one
segment keeps its encoded slashes and dots: the project's path in any request, and in a
GET a file's path, a branch's or a tag's name (`repository/branches/feature%2Flogin`).
Such a path is refused when a proxy that decodes the slash would turn it into a route no
rule knows, or one decided by another rule that does more than match the path - refuses,
pins a parameter, cuts the answer, asks the forge. What the forge says about
the repository itself is cut to the same list on both surfaces, by `pick` on the REST
answer and by a list of readable fields in a GraphQL document (`requester/graphql.js`;
it adds GitHub's `viewerPermission`, which `gh` reads before it opens a pull request).
A document is refused whole when it asks for more, takes an argument that could name
another repository, or reads what tells of the linked account and not of the repository -
as a field, or as a filter over a list (the issues it is subscribed to).

**Where the time goes.** What happened between an offer and its job is in `daemon.log`,
in seconds and counts and nothing any machine said: one line a claim round -
`claim of <task> made - begun 3 s after the offer, after a wait of 3516 ms, over in 15 s: 2 members asked, 1 answered, 1 absent, 1 gave an offer`,
or `claim of <task> stood down: <why> - ...` with the same numbers - then
`key of <task> received 0 s after its claim, at ask 1` and
`job of <task> started 0 s after its claim`. The wait is the one of the machine's rank
and of what it weighed; a member counts as absent once the round stopped waiting for it;
and a round that stood down leaves its task alone for 30 to 60 s. A machine that came
back to a pool with other machines in it also says, once, when it could go on:
`<pool> is up to date 0 s after this host came back to it`.

**Executor side.** With `admit.slots` above zero and a task with a free offer that this
machine would take, the daemon runs the claim round. The node asks its executor adapter:
`wouldTake(task)` says whether, and `weigh(task)`, when the adapter has one, how many
more milliseconds this machine waits before it goes for that task - at most a minute,
none for a task its own operator started with `now`. What that rests on is sent to
nobody; the wait itself shows in when the machine goes for the task. The claim made,
the daemon asks for the key: itself, when this machine offers the task too, else one of
the machines whose offer the claim holds, and the next of them whenever one gives none.
The job is the one that machine hands out, and when it ends its outcome is told to
every machine whose offer the claim was given. Having the key, the daemon makes sure of
four things and starts the job:

- **The image.** One local image, built from `image/Dockerfile` and tagged by the hash of
  that directory. Debian, git, node, python, curl and the handful of tools agents reach
  for; nothing project-specific. `image/preamble.md` tells the agent it is root in a
  disposable container and may install whatever else it needs.

  The tag names the recipe, not the bytes. Held to a hash are the Debian base image (by
  digest) and the releases of node, gh and glab (by SHA-256, for each architecture).
  Held to a version only are corepack and Claude Code, with whatever they depend on as
  npm resolves it on the day. Held to nothing are the Debian packages: they are what
  bookworm serves on the day of the build. So two machines with one tag can hold
  different packages, and an image is as old as its build.

  An image the daemon builds carries this state directory in its `dn.base` label. One
  that carries it, is named `DN_IMAGE_REPO:<tag>` and is not the image jobs are started
  in is removed when the daemon looks every 10 minutes, unless a container is still of
  it: the engine refuses that one, and it is asked for again. An image without the
  label - another daemon's, one built by hand - is never removed, nor is one of another
  name that was built on top of the daemon's and carries its label.
- **The container.** Exactly one per requesting peer and repository, named
  `dn-<pool part>-<peer part>`. It lasts as long as a job is in it: when its last job
  leaves it is removed with its relay, its network and its `/work` volume, and that
  peer's next job on that repository gets a new one from the image, so nothing a job
  wrote, installed or left running is there for a job that starts after every earlier
  one has ended. Jobs of one peer on one repository that run at the same time run in
  that one container, each as root, and nothing in it keeps them apart: each can read
  the other's run directory, its proxy token included, and replace any program the
  other runs. What a job starts from is the host's and the image's all the same: its
  runner, prompt and environment are written by the host into a run directory of its
  own; its clone is whole and its own, fetched through the broker from this machine's
  mirror - the container keeps no copy of the repository for a later job to borrow
  from; and its git reads a settings file of its own and neither the container's
  system-wide settings nor its template directory (`GIT_CONFIG_GLOBAL`,
  `GIT_CONFIG_NOSYSTEM`, `GIT_TEMPLATE_DIR`). A job that comes while the
  removal runs waits for it and never joins the container that is going. What the
  engine would not remove stops that pair's next job at its start, and is asked for
  again when the daemon looks every 10 minutes. A container this daemon has no job in
  and did not make - an earlier daemon's, whose job may yet be taken up - is removed
  once it has been seen for 6 hours (`DN_CONTAINER_IDLE_MS`). The container never
  serves another repository or another peer. Each part of the name is 128 bits of a SHA-256, and the name alone
  makes nothing a pair's own: the container, its relay, its network and its volume
  each carry `dn.pool`, `dn.peer` and `dn.base` in full, and one found under a pair's
  name with other labels is refused and left as it is. It holds no credential: not the
  forge's, not the model's. Its one network is an internal docker network of its own,
  with the same name: nothing is routed out of it, this machine has no address on it,
  and its resolver knows no name outside it. A job that ignores its proxy settings
  reaches nothing: not the internet, not this machine or its LAN, not another peer's
  container.

  Of this machine it gets `DN_CONTAINER_MEMORY` (8g, and no swap past it),
  `DN_CONTAINER_CPUS` (4), `DN_CONTAINER_PIDS` (4096) processes and
  `DN_CONTAINER_DISK_BYTES` (20 GiB) of disk. The engine holds the writable layer to
  that size where its storage can (`--storage-opt size=`). Where it cannot - Docker
  Desktop's default storage refuses the option - `usage(name)` measures the layer, the
  `/work` volume and the run records, and `overQuota()` names the containers past it.
  In the volume and the records a file counts for the blocks it holds plus 4096 bytes,
  no link is followed and no file is opened; in the writable layer a file counts for
  its full length, holes included. The run records outlive the container by the day
  they are kept, so they are measured under its name for as long as any are there,
  container or not. The daemon asks every
  10 minutes (`DN_SWEEP_MS`). A name past its allowance is discarded: its jobs are
  stopped and end as failed attempts with the reason `the container outgrew its disk
  allowance` - whichever of them filled it would fill the next one too, and three
  attempts are all a task gets - and the container goes with its relay, its network,
  its volume and its run records. A name the engine could not measure on three looks
  running is discarded the same way, its jobs ending with the reason `the container could
  not be measured against its disk allowance`: one miss is a busy engine, and a container that
  can be made unmeasurable is not thereby made unbounded. A discard reports a name
  gone only when all of it is; what is left is measured and tried again.
- **The relay.** On each container's network sits `dn-<pool part>-<peer part>-relay`:
  the same image running `image/relay.mjs`, which carries TCP from that network to the
  broker's port on this machine and to nothing else, 1024 connections at a time. It is
  the container's only way out. It is not a job container and not a second container
  for the peer: no job runs in it and nothing of a job is in it; it has no capability,
  no writable file system and no credential, shares no namespace and no volume with the
  job container, and it is made and removed with the container it serves.
- **The broker.** Every job gets a proxy address carrying its own token. All of the
  container's traffic leaves through it:
  - the forge's API and git push go to the requester as `act` requests. The forge is
    every host it takes a login or serves repositories on: for github.com that is
    `github.com`, `api.github.com`, `uploads.github.com` and `gist.github.com`; for a
    GitHub Enterprise Server and for a GitLab it is the pool's one host, which the
    job's `gh` or `glab` is pointed at (`GH_HOST`, `GITLAB_HOST`). They are read on
    port 443 and refused on every other port and over plain http, as are the hosts the
    forge serves git over ssh on (`ssh.github.com`, `altssh.gitlab.com`). A name in
    capitals or with a trailing dot is the same name. A forge served over https on a
    port but 443 (or http on one but 80) has no pool, since a pool's id names a host and
    no port; a remote reached over ssh on another port is the forge's own, its API being
    on 443. A GitHub pool on a subdomain
    of github.com, on ghe.com or on a subdomain of it has no rules, so no task of it
    is offered and no job of it comes here;
  - git fetch and clone of the pool's repository are answered from this machine's bare
    mirror of it. The mirror is filled by this machine's own git with the operator's
    access to the repository, the one thing of the forge an executor needs of its own:
    a machine that cannot read a repository starts no job on it. It is a mirror of the
    repository the pool names, whatever the linked checkout's remotes are called. It is
    fetched by a remote of that checkout that is the repository, as the operator
    spelled it (`upstream` before `origin` before any other); else by the repository's
    path in the spelling of a remote the checkout has on the same forge - ssh or https,
    with the user and the port it has there, `ssh.github.com` and `altssh.gitlab.com`
    counting as their forge - which is how a fork's checkout is used, or one whose
    remote has a name the repository had; else over https, and a failure then says that
    the checkout has no remote on that forge. A GitLab of one's own that is reached
    over ssh under another host name than its API's is not known here to be the same
    forge. A mirror that cannot be made fails the start with git's reason;
  - the model provider's API is forwarded with this machine's own credential added,
    until the job has had its share: past `DN_JOB_MODEL_REQUESTS` requests or
    `DN_JOB_MODEL_BYTES` bytes it is answered 429. Of the provider's answer the job
    gets the body and the headers a client needs (`content-type`, `content-encoding`,
    `content-length`, `cache-control`, `request-id`, `retry-after`, `x-should-retry`);
    the ones that tell of the account behind the credential stay here;
  - everything else is tunnelled untouched, to the public internet only, so installing
    software works as usual. An address inside a network any interface of this machine
    is on, IPv4 or IPv6, is refused, and so is every range that is not publicly routed;
    the interfaces are read at each connection. What this machine reaches by a route
    alone the broker does not know of: a publicly addressed range behind a VPN, or on
    another subnet of the operator's site, is tunnelled to like the rest of the
    internet. The hosts github.com hands downloads
    out from (`codeload.github.com`, `raw.githubusercontent.com`,
    `objects.githubusercontent.com`) and bare addresses are among the tunnels: they
    serve what is public, or what a link in the requester's own answer opens for a
    short while.

  The broker terminates TLS for the hosts it must read, with a certificate authority that
  exists only on this machine and is trusted only inside its containers. There is one
  authority per set of hosts, so the certificate a job is handed names its own pool's
  forge and the model provider and no other pool's. Each request on a terminated
  connection is judged on its own: its `Host` must be the host the connection was opened
  to, and the job's token must still stand. The broker frames every body it passes on
  itself, refuses a request framed two ways, and keeps one job's upstream connections
  apart from every other job's: a plain http request goes down a connection of its own,
  closed with it, and the model provider's are kept for the same job's next request.

  One job holds so much of the broker and no more:
  - `DN_JOB_CONNECTIONS` (256) connections from its container;
  - 256 requests at a time, those being answered and those waiting their turn
    together, on however few connections it sends them. A job at that share is read
    no further until one of them ends, by its answer or by its time running out: what
    it sends meanwhile stays in its container, and a connection it closes meanwhile is
    not seen to close. A request that had arrived by then closes the connection it
    came on. What a tunnel carries is no request, and is read on;
  - 32 requests at a time that the broker carries upstream itself, plain http ones
    and the model's together, whatever number of hosts they name, each down one
    connection out. A connection to the model provider that is kept for the job's
    next request is beside those, and there are never more than 32 of them; a tunnel
    is one of the job's connections and has one connection out. So a job has at most
    320 connections out at a time;
  - `DN_JOB_BUFFER_BYTES` (48 MiB) of request bodies read whole at a time, which is
    what goes to the requester or through a credential swap;
  - `DN_JOB_FORGE_REQUESTS` (4) forge requests in flight, each holding an answer of at
    most `DN_FORGE_RESPONSE_MAX_BYTES` (32 MiB). A fetch answered from the mirror is
    one of them, so a job has at most 4 `git upload-pack` processes on this machine.

  A request past the last three waits its turn, unread, and is answered 503 when none
  comes within `DN_JOB_BODY_MS`. A request's head has `DN_JOB_HEADER_MS` (30 s) to
  arrive, a body read whole `DN_JOB_BODY_MS` (5 min), and a connection nothing moves on
  is closed after `DN_JOB_IDLE_MS` (30 min). Everything else is streamed.

  What a job brings about as often as it likes - a tunnel refused, a request that
  failed, an adb request refused - is written to the daemon's log once a minute for
  each kind, and for each job where the broker knows whose it is: the first at once,
  the next with the number left out since. Of a job's own words such a line carries
  300 characters at most, the unprintable ones replaced.

The job itself is Claude Code in headless mode, whatever runner Diplomat is set to use
for the agents it starts in terminals: a machine with no credential for it takes no job.
Its exit is the completion signal; its log holds the cost. The daemon reports the outcome
to the requester with `done`.

A job that cannot be started for a reason of this machine's own - the mirror cannot be
made, the engine or the image is not there, the container cannot be made, another
daemon's object stands under its name - never ran: its claim is given back, which costs
the requester none of the task's three attempts, and this machine does not go for that
task again. The executor's parts say which failures those are, as an `OwnFault`
(`src/executor/own-fault.js`). A start that fails any other way - what earlier jobs left
could not be removed, the container went from under its jobs, the runner did not come up
in it - may be the doing of the requester's own jobs, so it is a failed attempt like a
job that failed, `daemon.log` says why, and nothing is held against the pool. After an
`OwnFault` the machine takes no job of that pool for a minute
(`DN_POOL_RETRY_MS`), twice as long after each such failure in a row and ten minutes at
most (`DN_POOL_RETRY_MAX_MS`); the pool's `notTaking` says why meanwhile. When the wait
is over the mirror is tried, the one part of a start that needs no job: while it cannot
be made the wait begins again, and once it can the pool's jobs are taken as before.
Whatever else stood in the way shows at the next job, which is given back like the last.
A job that was started sets the wait back to a minute.

Everything in a job's directory is the job's to write, so the daemon reads `done` and
the three logs in the directory that stands where it put it, never through a link,
without waiting for a writer, off its own thread, and by their last bytes only: 32 of
`done`, 4 MiB of `log.jsonl`, 2000 of `stderr.log` and `setup.log`. A pipe, a socket, a
device or a directory in a file's place reads as nothing. Of the result line only
positive numbers count, and the summary is cut at 4000 characters.

The tokens and the cost are the job's own word, and this machine's budget is counted
from them. They stand no higher than what the broker carried to the model for the job:
one token for each byte of its model requests and their answers, and USD 80 for a
million of those bytes - the dearest a token is sold at, the output of the top model in
its fast mode as priced in November 2026. A job that sent the model nothing reports no
tokens and no cost. An outcome of which a figure was lowered carries `capped: true`.

A machine takes work only while its docker engine answers, the image is there and a
model credential is; both are looked at again every 30 s, and the snapshot says which is
missing. The engine must be Docker 27.1 or later, the first that makes a network with no
address of this machine on it: under an older one the snapshot says so, and no job is
started on a network of another kind.

**Across a restart.** A job outlives the daemon that started it. The daemon after it
reads `jobs.json`, listens where the broker listened, and takes each job up where it
stands: a job that ended meanwhile is reported with the outcome it left; one still
running is watched again, in its container as it is, under the proxy token and the
certificate authority it was started with, with the forwards it was started with and
its share of the model counted on from what `jobs.json` says it had spent. Until that
is done no job is started - a run that was still waiting for its key, or an offer made
with `now` in the daemon's first moment, waits for it - so a container holding a job
from before is never made anew under it. A job that cannot be taken up - its container is gone, or the
broker's port could not be had again - is stopped for that reason, and the node gives
the task back. So that the port can be had again, the broker listens below the range
Linux deals outgoing connections from, where that range leaves room below it: a port
of the range may be given to some connection while the daemon is away, and cannot be
listened on while that connection lasts, nor for a minute after. Every 15 s the jobs in this daemon's containers are held against the
node's runs, and a job no run stands behind is stopped: one whose run was stopped
while the engine did not answer, and one `jobs.json` no longer names, which is found by
its run directory.

**Stopping a job.** A job is root in its container and can write wherever the container
can, its own run directory included. So nothing the host runs to ask after a job or to
end it is read from the run directory or from `/work`, and nothing is found through the
container's `PATH`, which leads through `/usr/local/bin` first: the container's first
process is `/usr/bin/sleep`, a job's runner is started by `/bin/sh` and
`/usr/bin/setsid`, and `stop.sh` is handed to `/bin/sh` as text and looks for `tr`,
`grep`, `sleep` and `rm` in `/usr/sbin:/usr/bin:/sbin:/bin`. The job's process group is
the one the shell that started the job named to the daemon, kept in `jobs.json`;
nothing a job writes says which processes are its own. A job whose
group nobody kept - its daemon went between starting it and hearing the group, or
`jobs.json` is gone - is not taken up: it is ended by its run id alone, which its
runner and everything the runner starts carry in their environment from their first
moment. The order is always the same.
The job's proxy token is taken out of the broker first, so from that moment it reaches
nothing - no forge, no model, no forward - however long the rest takes. Then its
process group gets TERM, 5 s, and KILL, and so does every process outside the group
that still carries the job's run id in its environment. The job counts as stopped only
when the container itself says nothing of it is left. One that is still there 60 s
(`DN_JOB_STOP_BOUND_MS`) after the first try - or a container in which nothing can be
run any more - ends with its container, which is restarted in its turn among whatever
else is being done to that container; the other jobs in it, all
the same requester's on the same repository, end as failed attempts with the reason
`the container was restarted to stop another job`, and no later job joins a container
that was restarted: the next one has it made anew. A process that left the group and
cleared its environment is known to nobody: it has no token either, and goes when the
container's last job ends, which removes the container.

What a container says is believed no further than it costs the job that could have
forged it. Root in a container can replace `/bin/sh` and every tool named above, and
then answers the host's questions itself, for its own processes and for those of the
jobs beside it: that a job is up, that it is gone, that nothing of it is left after a
stop. The exit code in `done`, the logs and the result line are the job's own word as
well, and so is everything under `/work`. Three things do not pass through the
container. The job's token is taken out of the broker before the first question, so a
job the host counts as ended reaches no forge, no model and no forward, whatever of it
still runs. A restart is the engine's and ends every process of the container. And the
removal of the container with its `/work` volume when its last job leaves is the
engine's too: after it nothing a job started, replaced or wrote is left. Until then a
job that lied its way past a stop runs on inside the container's limits, with no token
of its own, beside jobs of the same requester on the same repository.

**Devices.** Simulators, emulators and attached devices stay on the host, and a job is
given nothing of them unless this machine's operator opts in: `networkDevices` in
Diplomat's settings, off by default. A change holds for the jobs started after it; a job
keeps what it was started with, across a restart of the daemon too, and loses it only
when the setting is off at that restart.

Opting in gives every job of every peer this: it can run what `adb` can on the devices
and emulators attached to this machine - install and start apps, read and write their
files, run a shell on them - and since an emulator reaches this machine's own loopback
services (as `10.0.2.2`), so can a job that has a shell on one. That is a stranger's
prompt driving a phone plugged in by USB; leave the setting off on a machine where that
is not acceptable.

With it on, each job started while an adb server answers on `127.0.0.1:5037`
(`DN_ADB_SERVER` names another loopback address) gets a forward named `adb`, which it
finds as `ADB_SERVER_SOCKET`. The forward does not lead to the adb server but to a
filter in the daemon (`executor/adb.js`) that reads adb's own requests and passes on
only these: `host:version`, `host:devices`, `host:devices-l`, `host:features`,
`host:host-features`, `host-serial:<serial>:get-state|get-serialno|get-devpath|features`,
and a switch to one named device (`host:transport:<serial>`, `host:tport:serial:<serial>`)
followed by that device's own service. Everything else is answered `FAIL` with the
reason, logged, and never reaches the server: `host:connect` and `disconnect` (the
server dialling out from this machine), `host:forward`, `killforward` and `list-forward`
(the server listening on this machine's ports), `host:kill`, `pair`, `mdns`,
`track-devices`, `transport-any`, `transport-usb`, `transport-local`, `emulator`, any
request not listed here, and behind a device switch `reverse:` (a device's way to this
machine's ports) and every `host` request. So a job names its device (`adb -s <serial>`
or `ANDROID_SERIAL`), and an adb client of another version than the server's fails
rather than replacing the server: it asks the server's version, says the two differ,
asks to stop the server (`host:kill`), and is told in the refusal that this machine's
server is not replaced and that an adb of the server's version is what works. The
image's adb is Debian bookworm's `adb` package, which speaks version 41 of adb's
protocol (`adb version` prints 1.0.41), as every adb released since 2019 does; keep the
host's adb at one of those.

**Which machine takes Android work.** No message says what devices a machine has, and
a task is not told either. Each machine weighs a task by itself before it goes for it
(`executor/weigh.js`): when the pool's linked checkout looks like Android work - an
`android/` directory, an `app/src/main/AndroidManifest.xml`, or a `build.gradle`,
`build.gradle.kts`, `settings.gradle` or `settings.gradle.kts` at its root - a machine
with no device to give a job (`networkDevices` off, or on with no device its adb server
lists as ready) waits 30 s (`DN_DEVICE_WAIT_MS`) longer before it goes for the task, so
a machine with a device gets there first. A checkout is looked at once and again an
hour later. Nothing is refused on this ground: a task no machine with a device took
runs on one without. The wait is announced to nobody and can be seen all the same: a
member that offers such a task and watches which machine takes it, and when, can infer
whether that machine has a device to give.

Anything else on the host - the device allocator, a tool-server - is forwarded only
when the daemon's environment names it and `networkDevices` is on: `DN_FORWARDS` is a
JSON object of name to `127.0.0.1:<port>`, and each becomes `DN_FORWARD_<NAME>` in
every job. A target that is not on this machine's loopback is left out. Such a forward
is a plain TCP connection, unfiltered: the job can say to that service whatever any
local process can.

A forward is a name that only its own job's proxy token opens; `executor/forward.mjs`,
started with the job inside the container, turns it into the local address a tool
expects, and it ends with the job. What a machine has is never published; the one use
it makes of it is that wait before going for a task, which is also the one trace of it.

## Tests

`npm test` runs every `test/*.mjs`, with no network: the loopback transport, a stand-in
tor, a fake forge and a fake docker. The `node-*.mjs` files run whole hosts on a network
in memory with a clock of its own (`test/lib/mem-net.mjs`, `test/lib/hosts.mjs`):
`node-standing.mjs` is what a member that means harm cannot do with a claim,
`node-cooffer.mjs` one task offered by several machines, `node-asleep.mjs` a machine
that was away while its job was run, `node-limits.mjs` what a host does for whom and
how much of it, `node-full.mjs` a pool at its caps, and `node-soak.mjs` seeded runs of
everything at once (`DN_SOAK_SEEDS`, `DN_SOAK_STEPS` and `DN_SOAK_SEED` say how many,
how long and from which seed). The `daemon-*.mjs` files start real daemon processes on
scratch state directories (`test/lib/daemons.mjs`), with `test/lib/agent.mjs` standing
in for the agent and `test/lib/fake-model.mjs` for the model provider: the agent sends it
the traffic its token and cost figures could have been in, and
`test/lib/to-fake-model.mjs`, loaded into each daemon ahead of it, leads the provider's
name there.

Three files reach for the real things, and print `SKIP` and pass without them:

| Run | Uses |
| --- | --- |
| `DN_TEST_TOR=real node test/transport-tor.mjs` | a real tor and real onion services |
| `DN_TEST_DOCKER=real node test/executor-real.mjs` | the real docker engine, the real image and, unless `DN_TEST_SKIP_CLAUDE=1`, one real agent run |
| `DN_TEST_TOR=real DN_TEST_DOCKER=real node test/e2e-real.mjs` | two whole daemons, each with a tor of its own, and one job from one run by the other in a real container by the real agent; either variable alone runs that half against the stand-in for the other |

The forge is a stand-in in all of them. `.github/workflows/diplomacy-network-e2e.yml`
runs the docker ones on every change to this package, without a model credential, and
the tor ones on request.
