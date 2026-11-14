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
    job.js         one run: prompt, start, watch, outcome
    forward.mjs    inside a container: a job's forwards as local addresses
    runner.sh      inside a container: one job's environment, clone and agent
    stop.sh        inside a container: ends one job's process group
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

`~/.diplomat/network` (`DN_BASE_DIR` relocates it; every test does):

| File | Holds |
| --- | --- |
| `daemon.sock`, `daemon.json`, `daemon.log` | as in the other daemons |
| `state.json` | the snapshot the applets read |
| `identity.json` (0600) | the host key |
| `links.json` (0600) | the linked repositories, as Diplomat last posted them |
| `pools/<pool hash>.json` (0600) | that pool's records |
| `locks.json` (0600) | the claim locks this host granted |
| `keys.json` (0600) | live capabilities this host issued or holds |
| `offers.json` (0600) | the tasks this host asked for: prompt, counters, outcome, and what each has used of its rules' allowances |
| `runs.json` (0600) | the tasks this host runs or ran, and the tasks it gave up on |
| `jobs.json` (0600) | the jobs going in this daemon's containers, for the daemon after it: the broker's port, each job's container, proxy token and CA generation |
| `tor/` | tor's data directory |
| `ca/` (0700) | the broker's certificate authority |
| `mirrors/<pool hash>.git` | bare mirrors |
| `runs/.containers/<container>/<run id>/` | one job: `prompt.txt`, `env.sh` (0600), `log.jsonl`, `done`. `runs/.containers/<container>/` is all of `runs/` that container is shown, and it can write there; `runs/<run id>` is a link to the job's directory |
| `runs/<run id>.outcome.json` (0600) | that job's outcome, written by the daemon when the job ends, where no container can write |
| `runs/.staging/` | a job's directory while it is put together, before its container can see it |

Settings come from Diplomat's `config.json` (`DIPLOMAT_CONFIG` relocates it), re-read
every second: `networkEnabled`, `networkRequiredMinimumH`, `networkMaximumAcceptedH`.
The two hours settings take effect at the next offer and the next claim, without a
restart, held to the 12 to 720 hours the network allows. The daemon switches off and
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
| 400 | the body is not what the route reads: not JSON, not an object, a member missing or of the wrong type or size. Members a route does not read are ignored |
| 409 | the body is well formed and the network refuses it; `error` is a sentence fit to show the operator |
| 404 | no such route |
| 503 | the daemon is on its way out |
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
| `--stop-daemon` | the same object: `ok` once no daemon is left, which with none running is at once |
| `--restart-daemon` | the same object: a stop, then a start |

The snapshot:

```json
{ "updatedAt": 0, "daemon": { "pid": 0, "startedAt": 0 },
  "identity": { "pk": "...", "onion": "....onion" },
  "transport": { "state": "starting|bootstrapping|publishing|ready|failed", "detail": "" },
  "docker": { "state": "ready|missing|down|building|failed", "image": "", "detail": "" },
  "model": { "state": "ready|missing", "detail": "" },
  "admit": { "slots": 0, "at": 0, "reason": "" },
  "pools": [ { "id": "", "path": "", "identity": "", "hash": "", "left": false,
      "members": [ { "pk": "", "self": false, "maxAcceptedH": 12, "lastSeen": 0, "reachable": true } ],
      "tasks": [ { "taskId": "", "kind": "", "item": "", "title": "", "identity": "", "hours": 12,
          "state": "available|claimed|done|cancelled", "offeredBy": [""], "offeredHere": false,
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
offer stays in the list for a day. `docker` and `model` say why this machine takes no
work when it takes none: their `detail` carries the reason.

The same snapshot is written to `state.json` (0600), replaced whole and at most once a
second, and once more as the daemon ends.

## What runs where

**The process.** `daemon.js` is one process per state directory: a second one started on
the same directory finds the first answering and exits 0, naming it in the log. It
listens on the socket, then builds the node over its store, its transport, and the two
adapters below; the node itself knows no file, no socket and no docker.

It ends in one of two ways. Stopped (`SIGTERM`, `SIGINT`, `install.js --stop-daemon`)
with the network still on, it stops the node and the transport - and with it tor - and
leaves its runs going in their containers for the daemon after it. Switched off
(`networkEnabled` not `true`, whether the daemon reads that itself or is stopped just
after the setting was written), it first cancels every offer of its own that has not
ended, stops its runs and releases their claims, tells its pools, and then exits. Both
exit 0. A second signal ends it at once, with exit 1.

**Requester side.** `POST /offer` signs an offer record and pushes it to the pool. When a
committed claim's executor asks for the key, the daemon issues a capability whose rules
come from `requester/rules.js`, and from then on performs each allowed `act` request
with this machine's own `gh` or `glab` credentials (`requester/forge.js`). It pings the
executor before each lease runs out, and marks the offer done when the executor reports
the outcome.

A request is checked before it is sent (`requester/authorize.js`). Where the check
depends on the forge - where a branch is, which branch is the default, whether it is
protected, who opened a pull request, who is assigned - the forge is asked, and an answer
that does not settle the question refuses the request: a rate limit or an error is not
"no such branch". A push is read whole (`requester/receivepack.js`): its pack is measured
before git sees it and refused when its objects add up to more than
`DN_PUSH_UNPACKED_MAX_BYTES` (512 MiB) once unpacked, then indexed in a quarantine with
git's own object check, where the fast-forward and the pushed files are proven.

What a task has used of its allowances - the branches it created, the pull request it
opened from each - is the task's, not the key's: it is kept with the offer in
`offers.json`, written before the request that uses it is sent, so every key issued for
the task goes on from the same count and a restart forgets none of it. A branch is the
task's own once the forge's answer to the push says so.

**Executor side.** With `admit.slots` above zero and a task available that this machine
would take, the daemon runs the claim round. Having the key, it makes sure of four
things and starts the job:

- **The image.** One local image, built from `image/Dockerfile` and tagged by the hash of
  that directory. Debian, git, node, python, curl and the handful of tools agents reach
  for; nothing project-specific. `image/preamble.md` tells the agent it is root in a
  disposable container and may install whatever else it needs.
- **The container.** Exactly one per requesting peer and repository, named
  `dn-<pool hash>-<peer hash>`, kept running between that peer's jobs on that
  repository and removed after 6 idle hours. It never serves another repository or
  another peer. It holds no credential: not the forge's, not the model's. Its one
  network is an internal docker network of its own, with the same name: nothing is
  routed out of it, this machine has no address on it, and its resolver knows no name
  outside it. A job that ignores its proxy settings reaches nothing: not the internet,
  not this machine or its LAN, not another peer's container.
- **The relay.** On each container's network sits `dn-<pool hash>-<peer hash>-relay`:
  the same image running `image/relay.mjs`, which carries TCP from that network to the
  broker's port on this machine and to nothing else. It is the container's only way
  out. It is not a job container and not a second container for the peer: no job runs
  in it and nothing of a job is in it; it has no capability, no writable file system
  and no credential, and it is made and removed with the container it serves.
- **The broker.** Every job gets a proxy address carrying its own token. All of the
  container's traffic leaves through it:
  - the forge's API and git push go to the requester as `act` requests;
  - git fetch and clone of the pool's repository are answered from this machine's bare
    mirror of it;
  - the model provider's API is forwarded with this machine's own credential added,
    until the job has had its share: past `DN_JOB_MODEL_REQUESTS` requests or
    `DN_JOB_MODEL_BYTES` bytes it is answered 429;
  - everything else is tunnelled untouched, so installing software works as usual.

  The broker terminates TLS for the hosts it must read, with a certificate authority that
  exists only on this machine and is trusted only inside its containers.

The job itself is the agent runner in headless mode. Its exit is the completion signal;
its log holds the cost. The daemon reports the outcome to the requester with `done`.

A machine takes work only while its docker engine answers, the image is there and a
model credential is; both are looked at again every 30 s, and the snapshot says which is
missing.

**Across a restart.** A job outlives the daemon that started it. The daemon after it
reads `jobs.json`, listens where the broker listened, and takes each job up where it
stands: a job that ended meanwhile is reported with the outcome it left; one still
running is watched again, in its container as it is, under the proxy token and the
certificate authority it was started with. Until that is done no job is started, so a
container holding a job is never restarted under it. A job that cannot be taken up - its
container is gone, or the broker's port could not be had again - is stopped, and the
node gives the task back. Every 15 s the jobs in this daemon's containers are held
against the node's runs, and a job no run stands behind is stopped.

**Devices.** Simulators, emulators and attached devices stay on the host. A container
reaches them only through forwards the broker opens for a job. One is opened out of the
box: `adb`, to the host's adb server, for every job started while that server answers on
`127.0.0.1:5037` (`DN_ADB_SERVER` names another loopback address); the job finds it as
`ADB_SERVER_SOCKET`. Anything else on the host - the device allocator, a tool-server -
is forwarded only when the daemon's environment names it: `DN_FORWARDS` is a JSON object
of name to `127.0.0.1:<port>`, and each becomes `DN_FORWARD_<NAME>` in every job. A
target that is not on this machine's loopback is left out. A forward is a name that only
its own job's proxy token opens; `executor/forward.mjs`, started with the job inside the
container, turns it into the local address a tool expects, and it ends with the job. A
forward is a plain TCP connection: a job that is given `adb` can do with the host's
devices what `adb` can. What a machine has is never published; it only weighs it when
deciding whether to take a task.

## Tests

`npm test` runs every `test/*.mjs`, with no network: the loopback transport, a stand-in
tor, a fake forge and a fake docker. The `daemon-*.mjs` files start real daemon
processes on scratch state directories (`test/lib/daemons.mjs`), with `test/lib/agent.mjs`
standing in for the agent.

Three files reach for the real things, and print `SKIP` and pass without them:

| Run | Uses |
| --- | --- |
| `DN_TEST_TOR=real node test/transport-tor.mjs` | a real tor and real onion services |
| `DN_TEST_DOCKER=real node test/executor-real.mjs` | the real docker engine, the real image and, unless `DN_TEST_SKIP_CLAUDE=1`, one real agent run |
| `DN_TEST_TOR=real DN_TEST_DOCKER=real node test/e2e-real.mjs` | two whole daemons, each with a tor of its own, and one job from one run by the other in a real container by the real agent; either variable alone runs that half against the stand-in for the other |

The forge is a stand-in in all of them. `.github/workflows/diplomacy-network-e2e.yml`
runs the docker ones on every change to this package, without a model credential, and
the tor ones on request.
