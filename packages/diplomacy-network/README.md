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
    membership.js  invites and the accepted-member set
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
    clear.js       removes everything this daemon made in docker
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
| `daemon.sock`, `daemon.json`, `daemon.log` | as in the other daemons |
| `state.json` | the snapshot the applets read |
| `identity.json` (0600) | the host key |
| `heard.json` (0600) | the time of the latest request this host served: after a start it serves nothing dated at or before it |
| `links.json` (0600) | the linked repositories, as Diplomat last posted them |
| `pools/<pool hash>.json` (0600) | that pool's records; of a pool this machine left, the record that says so and the members it left |
| `locks.json` (0600) | the claim locks this host granted |
| `keys.json` (0600) | live capabilities this host issued or holds |
| `offers.json` (0600) | the tasks this host asked for: prompt, counters, outcome, and what each has used of its rules' allowances |
| `runs.json` (0600) | the tasks this host runs or ran, and the tasks it gave up on |
| `jobs.json` (0600) | the jobs going in this daemon's containers, for the daemon after it: the broker's port, and each job's container, proxy token, CA generation, process group, forwards and what it has spent of the model, the last no more than 5 s behind |
| `tor/` | tor's data directory |
| `ca/<id>/` (`ca/` is 0700) | the broker's certificate authorities, one per set of hosts it reads: `ca.key`, `ca.crt`, `meta.json` and the `leaves/` issued under it |
| `mirrors/<pool hash>.git` | bare mirrors. One is removed a day after its pool was last linked and not left |
| `runs/.containers/<container>/<run id>/` | one job: `prompt.txt`, `env.sh`, `log.jsonl`, `done`. `runs/.containers/<container>/` is all of `runs/` that container is shown, and it can write there; `runs/<run id>` is a link to the job's directory. Both are removed a day after the job ended |
| `runs/<run id>.outcome.json` | that job's outcome, written by the daemon when the job ends, where no container can write, and removed with its directory |
| `runs/.staging/` | a job's directory while it is put together, before its container can see it |

The node's documents are written in one order - identity, `heard`, links, pools, locks,
keys, offers, runs - each whole, through a temporary file: a run is on disk only after
the key it was started with. They are read back as plain JSON; only what travels between
hosts has to be canonical. A pool's document holds at most 256 members with at most 256
KiB of records each (PROTOCOL.md section 5), and is rewritten when a record of it
changes.

A job's directory is kept for the day after its end because the snapshot's `log` names a
file in it, which is what the operator opens to see what the job did; nothing else reads
it once the outcome is reported. `DN_RUN_KEEP_MS` and `DN_MIRROR_KEEP_MS` set the two
days; both are looked at every 10 minutes, with the idle containers and the old
certificate authorities. A container reads its run directory through a bind mount as
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

The model credential a job's requests leave with is this machine's own, added by the
broker on the host and never present in a container. The first of these that exists is
used: `networkModelToken`, an API key or subscriber token kept for the network alone (on
macOS the Keychain item with service `Diplomat-networkModelToken` under the user's
account, elsewhere the file `~/.diplomat/network-model-token`); the Claude Code login;
`ANTHROPIC_API_KEY` in the daemon's environment.

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
| `POST /stop-run` | `{ runId }` | `{ ok: true }` - the run is stopped and its claim released; the task is in the pool again for another machine |

Every other answer is `{ error }` with a status that says whose fault it was:

| Status | Means |
| --- | --- |
| 400 | the body is not what the route reads: not JSON (`The request body is not JSON.`), not an object, a member missing or of the wrong type or size. Members a route does not read are ignored |
| 409 | the body is well formed and the network refuses it; `error` is a sentence fit to show the operator |
| 404 | no such route |
| 503 | the daemon is on its way out (`The Diplomacy Network daemon is stopping.`): nothing was done, and the daemon after it takes the same request. `GET /health` answers to the last |
| 500 | a fault of the daemon's own; the same line is in `daemon.log`, and the daemon goes on |

`offer` answers as soon as the offer is signed and stored on this machine. It does not
wait for any other member to hear of it: the pool is told in the background, and the
snapshot shows the offer `pooled` meanwhile. The commits a job makes are authored as
`user.name` and `user.email` of the offering machine's checkout say; an offer from a
checkout that has neither is refused.

`withdraw` is safe to repeat. A task this machine has no open offer of - one it never
offered, one that already ended, one already withdrawn - is answered `{ ok: true,
ended: true }` like one it just cancelled, so an applet can withdraw on merge, on forget
and on switch-off without keeping count. Only a malformed body is refused.

`join` by invite needs the invite's repository linked on this machine first; otherwise
it is refused with `The pool <id> is not linked on this machine.` An invite that is no
invite, has run out, is not signed by the machine it names, or was made on this machine
is refused with a sentence saying which.

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

`src/install.js` is what the applets run. Each flag prints one JSON object and exits 0:

| Flag | Prints |
| --- | --- |
| `--check` | `{ "installed": true, "daemonRunning": <bool>, "pid": <pid or null> }` - there is nothing to install, so `installed` is constant |
| `--start-daemon` | `{ "ok": <bool>, "daemonRunning": <bool>, "pid": <pid or null>, "error"?: "<why>" }` - the daemon that already runs, or one started for it once its socket answers |
| `--stop-daemon` | the same object: `ok` once no daemon is left, which with none running is at once. With the network switched off in the settings it then removes what is left in docker of this state directory's daemons, which a daemon that died before it could switch off never did |
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
  "pools": [ { "id": "", "path": "", "identity": "", "hash": "", "left": false,
      "members": [ { "pk": "", "self": false, "maxAcceptedH": 12, "lastSeen": 0, "reachable": true,
          "skew": false } ],
      "tasks": [ { "taskId": "", "kind": "", "item": "", "title": "", "identity": "", "hours": 12,
          "state": "available|claimed|done|cancelled", "blocked": "", "offeredBy": [""], "offeredHere": false,
          "executor": "", "executorHere": false, "claimedAt": 0, "leaseUntil": 0, "deadline": 0 } ] } ],
  "runs": [ { "runId": "", "taskId": "", "pool": "", "peer": "", "container": "",
      "state": "preparing|running|finished|failed|stopped", "startedAt": 0, "endedAt": 0,
      "exit": 0, "log": "" } ],
  "offers": [ { "taskId": "", "pool": "", "kind": "", "item": "", "title": "",
      "state": "pooled|claimed|done|failed|cancelled", "reason": "", "executor": "",
      "executorHere": false, "offeredAt": 0, "attempt": 1, "requests": 0, "refused": 0,
      "outcome": { "ok": true, "summary": "", "usd": 0, "tokens": 0, "runner": "", "model": "" },
      "endedAt": 0 } ] }
```

Every time is Unix seconds. `offers` are the tasks this machine asked for: `pooled` while
nobody holds it, `claimed` while an executor does, `done` when an executor finished it
well, `failed` when its attempts ran out (`reason` says how the last one ended), and
`cancelled` once withdrawn. `outcome` is null until an attempt has reported one. An ended
offer stays in the list for a day, and keeps the `executor` and `executorHere` of the
machine that last held it - the one that reported it done, or the last to hold it before
it failed or was cancelled; `executor` is empty only when nobody ever held it. `docker`
and `model` say why this machine takes no work when it takes none: their `detail`
carries the reason. `devices` is `off` until the operator sets `networkDevices`, then
`ready` while an adb server answers on this machine and `none` while none does.
`transport` is `failed`, with the reason, between a start that failed and the next one.

A member's `skew` is true when its last answer said its clock and this machine's are
more than 300 s apart: neither takes the other's requests, and a claim round goes on
without that member. A task's `blocked` is `clock` while it is available and that is so
for every host a claim of it needs - the hosts offering it, or every other member when
this machine offers it: nobody can take it until the clocks agree. Otherwise it is empty.

The same snapshot is written to `state.json` (0600), replaced whole and at most once a
second, and once more as the daemon ends.

## What runs where

**The process.** `daemon.js` is one process per state directory: a second one started on
the same directory finds the first answering and exits 0, naming it in the log. It
listens on the socket, then builds the node over its store, its transport, and the two
adapters below; the node itself knows no file, no socket and no docker.

A transport that does not start - a machine that came up offline, a tor that is not
installed yet - is started again by the same daemon: after 5 s, then after twice as long
each time, up to 5 minutes (`DN_TRANSPORT_RETRY_MS`, `DN_TRANSPORT_RETRY_MAX_MS`). Each
try is a new transport behind the one the node holds.

It ends in one of two ways. Stopped (`SIGTERM`, `SIGINT`, `install.js --stop-daemon`)
with the network still on, it stops the node and the transport - and with it tor - and
leaves its runs going in their containers for the daemon after it. Switched off
(`networkEnabled` not `true`, whether the daemon reads that itself or is stopped just
after the setting was written), it first cancels every offer of its own that has not
ended, stops its runs and releases their claims, tells its pools, removes every
container, relay, network and volume that carries this state directory in its `dn.base`
label (the image stays), and then exits. Both exit 0. A second signal ends it at once,
with exit 1.

An exception nobody caught, in whatever event's handler, is written to `daemon.log` once
with its stack (`uncaught: ...`) and the daemon goes on: the jobs it watches are worth
more than the one event. The same exception - same message, same place - five times
within a minute is one it does not get past, and it exits 1 with its runs left going, so
that Diplomat starts it again. A promise nobody waited for is logged the same way
(`unhandled: ...`) and never ends it.

**Requester side.** `POST /offer` signs an offer record and pushes it to the pool. When a
committed claim's executor asks for the key, the daemon issues a capability whose rules
come from `requester/rules.js`, and from then on performs each allowed `act` request
with this machine's own `gh` or `glab` credentials (`requester/forge.js`). It pings the
executor before each lease runs out, and marks the offer done when the executor reports
the outcome.

A request is checked before it is sent (`requester/authorize.js`). Where the check
depends on the forge - where a branch is, which branch is the default, whether it is
protected, who opened a pull request, who is assigned, whose a repository is and what it
is a fork of - the forge is asked, and an answer
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
task's own once the forge's answer to the push says so.

**Executor side.** With `admit.slots` above zero and a task available that this machine
would take, the daemon runs the claim round. The node asks its executor adapter:
`wouldTake(task)` says whether, and `weigh(task)`, when the adapter has one, how many
more milliseconds this machine waits before it goes for that task - at most a minute,
none for a task its own operator started with `now`. What that rests on stays on this
machine. Having the key, the daemon makes sure of four things and starts the job:

- **The image.** One local image, built from `image/Dockerfile` and tagged by the hash of
  that directory. Debian, git, node, python, curl and the handful of tools agents reach
  for; nothing project-specific. `image/preamble.md` tells the agent it is root in a
  disposable container and may install whatever else it needs.
- **The container.** Exactly one per requesting peer and repository, named
  `dn-<pool part>-<peer part>`, kept running between that peer's jobs on that
  repository and removed after 6 idle hours. It never serves another repository or
  another peer. Each part of the name is 128 bits of a SHA-256, and the name alone
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
    `github.com`, `api.github.com`, `uploads.github.com` and `gist.github.com`, for a
    GitLab its one host. They are read on port 443 and refused on every other port and
    over plain http, as are the hosts the forge serves git over ssh on
    (`ssh.github.com`, `altssh.gitlab.com`). A name in capitals or with a trailing dot
    is the same name;
  - git fetch and clone of the pool's repository are answered from this machine's bare
    mirror of it;
  - the model provider's API is forwarded with this machine's own credential added,
    until the job has had its share: past `DN_JOB_MODEL_REQUESTS` requests or
    `DN_JOB_MODEL_BYTES` bytes it is answered 429. Of the provider's answer the job
    gets the body and the headers a client needs (`content-type`, `content-encoding`,
    `content-length`, `cache-control`, `request-id`, `retry-after`, `x-should-retry`);
    the ones that tell of the account behind the credential stay here;
  - everything else is tunnelled untouched, to the public internet only, so installing
    software works as usual. An address inside a network any interface of this machine
    is on, IPv4 or IPv6, is refused, and so is every range that is not publicly routed;
    the interfaces are read at each connection. The hosts github.com hands downloads
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
  apart from every other job's.

  One job holds so much of the broker and no more, each with its tunable:
  `DN_JOB_CONNECTIONS` (256) connections; `DN_JOB_BUFFER_BYTES` (48 MiB) of request
  bodies read whole at a time, which is what goes to the requester, to the mirror or
  through a credential swap; `DN_JOB_FORGE_REQUESTS` (4) forge requests in flight, each
  holding an answer of at most `DN_FORGE_RESPONSE_MAX_BYTES`. A request past these waits
  its turn and is answered 503 when none comes. A request's head has
  `DN_JOB_HEADER_MS` (30 s) to arrive, a body read whole `DN_JOB_BODY_MS` (5 min), and
  a connection nothing moves on is closed after `DN_JOB_IDLE_MS` (30 min). Everything
  else is streamed.

The job itself is the agent runner in headless mode. Its exit is the completion signal;
its log holds the cost. The daemon reports the outcome to the requester with `done`.

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
with `now` in the daemon's first moment, waits for it - so a container holding a job is
never restarted under it. A job that cannot be taken up - its container is gone, or the
broker's port could not be had again - is stopped for that reason, and the node gives
the task back. Every 15 s the jobs in this daemon's containers are held against the
node's runs, and a job no run stands behind is stopped: one whose run was stopped
while the engine did not answer, and one `jobs.json` no longer names, which is found by
its run directory.

**Stopping a job.** A job is root in its container and can write wherever the container
can, its own run directory included. So nothing the host runs to ask after a job or to
end it comes from there: `stop.sh` is handed to the container's `sh` as text, and the
job's process group is the one the shell that started the job named to the daemon, kept
in `jobs.json`, not the one the job's own `pid` file says. The order is always the same.
The job's proxy token is taken out of the broker first, so from that moment it reaches
nothing - no forge, no model, no forward - however long the rest takes. Then its
process group gets TERM, 5 s, and KILL, and so does every process outside the group
that still carries the job's run id in its environment. The job counts as stopped only
when the container itself says nothing of it is left. One that is still there 60 s
(`DN_JOB_STOP_BOUND_MS`) after the first try - or a container in which nothing can be
run any more - ends with its container, which is restarted; the other jobs in it, all
the same requester's on the same repository, end as failed attempts with the reason
`the container was restarted to stop another job`. A process that left the group and
cleared its environment is known to nobody: it has no token either, and goes when the
container's last job ends, which restarts the container.

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
rather than replacing the server.

Anything else on the host - the device allocator, a tool-server - is forwarded only
when the daemon's environment names it and `networkDevices` is on: `DN_FORWARDS` is a
JSON object of name to `127.0.0.1:<port>`, and each becomes `DN_FORWARD_<NAME>` in
every job. A target that is not on this machine's loopback is left out. Such a forward
is a plain TCP connection, unfiltered: the job can say to that service whatever any
local process can.

A forward is a name that only its own job's proxy token opens; `executor/forward.mjs`,
started with the job inside the container, turns it into the local address a tool
expects, and it ends with the job. What a machine has is never published; it only
weighs it when deciding whether to take a task.

## Tests

`npm test` runs every `test/*.mjs`, with no network: the loopback transport, a stand-in
tor, a fake forge and a fake docker. The `node-*.mjs` files run whole hosts on a network
in memory with a clock of its own (`test/lib/mem-net.mjs`, `test/lib/hosts.mjs`):
`node-standing.mjs` is what a member that means harm cannot do with a claim, and
`node-limits.mjs` what a host does for whom and how much of it. The `daemon-*.mjs` files
start real daemon processes on scratch state directories (`test/lib/daemons.mjs`), with
`test/lib/agent.mjs` standing in for the agent.

Three files reach for the real things, and print `SKIP` and pass without them:

| Run | Uses |
| --- | --- |
| `DN_TEST_TOR=real node test/transport-tor.mjs` | a real tor and real onion services |
| `DN_TEST_DOCKER=real node test/executor-real.mjs` | the real docker engine, the real image and, unless `DN_TEST_SKIP_CLAUDE=1`, one real agent run |
| `DN_TEST_TOR=real DN_TEST_DOCKER=real node test/e2e-real.mjs` | two whole daemons, each with a tor of its own, and one job from one run by the other in a real container by the real agent; either variable alone runs that half against the stand-in for the other |

The forge is a stand-in in all of them. `.github/workflows/diplomacy-network-e2e.yml`
runs the docker ones on every change to this package, without a model credential, and
the tor ones on request.
