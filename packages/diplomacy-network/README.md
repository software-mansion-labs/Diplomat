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
    tor.js         runs tor, publishes the onion service, dials peers through SOCKS
    loop.js        the same interface on loopback TCP, for tests
    http.js        POST /dn1 framing over either
  node/
    node.js        one host: pools, sync, gossip, claim rounds, pings, keys
    store.js       what survives a restart: identity, records, locks, keys
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
    container.js   image, one container per peer and repository, jobs
    job.js         one run: prompt, start, watch, outcome
  daemon.js      the process: local socket, config, wiring
  ctl.js         start, stop and status from the applets, as JSON
  paths.js       files, tools and tunables
  ipc.js         the local-socket client
image/
  Dockerfile     the one image every job runs in
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
| `pools/<pool hash>.json` | that pool's records |
| `keys.json` (0600) | live capabilities this host issued or holds |
| `tor/` | tor's data directory |
| `ca/` (0700) | the broker's certificate authority |
| `mirrors/<pool hash>.git` | bare mirrors |
| `runs/<run id>/` | one job: `prompt.txt`, `log.jsonl`, `done`, `outcome.json` |

Settings come from Diplomat's `config.json` (`DIPLOMAT_CONFIG` relocates it), re-read
every second: `networkEnabled`, `networkRequiredMinimumH`, `networkMaximumAcceptedH`.
The daemon exits when `networkEnabled` is not `true`.

## Local socket

HTTP over `daemon.sock`, JSON in and out.

| Route | Body | Answer |
| --- | --- | --- |
| `GET /health` | | `{ ok, pid }` |
| `GET /state` | | the snapshot |
| `POST /pools` | `{ pools: [{ id, path, forge, identity }] }` | `{ ok }` - the linked repositories; a pool missing from the list is left |
| `POST /admit` | `{ slots, reason? }` | `{ ok }` - how many more tasks this machine takes now |
| `POST /offer` | `{ pool, kind, options?, item, title, prompt, base?, now? }` | `{ taskId }` |
| `POST /withdraw` | `{ taskId, reason }` | `{ ok }` |
| `POST /invite` | `{ pool, ttlSecs? }` | `{ invite }` |
| `POST /join` | `{ invite }` | `{ pool }` |
| `POST /leave` | `{ pool }` | `{ ok }` |
| `POST /stop-run` | `{ runId }` | `{ ok }` |

`admit` goes stale after 120 s: a daemon that has not heard from Diplomat takes nothing.
An offer with `now` is claimed by this machine at once, whatever `admit` says - that is a
job its own operator started by hand.

The snapshot:

```json
{ "updatedAt": 0, "daemon": { "pid": 0, "startedAt": 0 },
  "identity": { "pk": "...", "onion": "....onion" },
  "transport": { "state": "starting|bootstrapping|publishing|ready|failed", "detail": "" },
  "docker": { "state": "ready|missing|down|building|failed", "image": "", "detail": "" },
  "model": { "state": "ready|missing", "detail": "" },
  "admit": { "slots": 0, "at": 0, "reason": "" },
  "pools": [ { "id": "", "path": "", "identity": "", "hash": "",
      "members": [ { "pk": "", "self": false, "maxAcceptedH": 12, "lastSeen": 0, "reachable": true } ],
      "tasks": [ { "taskId": "", "kind": "", "item": "", "title": "", "identity": "", "hours": 12,
          "state": "available|claimed|done|cancelled", "offeredBy": [""], "offeredHere": false,
          "executor": "", "executorHere": false, "claimedAt": 0, "leaseUntil": 0, "deadline": 0 } ] } ],
  "runs": [ { "runId": "", "taskId": "", "pool": "", "peer": "", "container": "",
      "state": "preparing|running|finished|failed|stopped", "startedAt": 0, "endedAt": 0,
      "exit": 0, "log": "" } ],
  "offers": [ { "taskId": "", "state": "pooled|claimed|done|failed|cancelled", "executor": "",
      "attempt": 1, "requests": 0, "refused": 0, "outcome": { "ok": true, "summary": "",
      "usd": 0, "tokens": 0, "runner": "", "model": "" }, "endedAt": 0 } ] }
```

## What runs where

**Requester side.** `POST /offer` signs an offer record and pushes it to the pool. When a
committed claim's executor asks for the key, the daemon issues a capability whose rules
come from `requester/rules.js`, and from then on performs each allowed `act` request
with this machine's own `gh` or `glab` credentials (`requester/forge.js`). It pings the
executor before each lease runs out, and marks the offer done when the executor reports
the outcome.

**Executor side.** With `admit.slots` above zero and a task available that this machine
would take, the daemon runs the claim round. Having the key, it makes sure of three
things and starts the job:

- **The image.** One local image, built from `image/Dockerfile` and tagged by the hash of
  that directory. Debian, git, node, python, curl and the handful of tools agents reach
  for; nothing project-specific. `image/preamble.md` tells the agent it is root in a
  disposable container and may install whatever else it needs.
- **The container.** Exactly one per requesting peer and repository, named
  `dn-<pool hash>-<peer hash>`, kept running between that peer's jobs on that
  repository and removed after 6 idle hours. It never serves another repository or
  another peer. It holds no credential: not the forge's, not the model's.
- **The broker.** Every job gets a proxy address carrying its own token. All of the
  container's traffic leaves through it:
  - the forge's API and git push go to the requester as `act` requests;
  - git fetch and clone of the pool's repository are answered from this machine's bare
    mirror of it;
  - the model provider's API is forwarded with this machine's own credential added;
  - everything else is tunnelled untouched, so installing software works as usual.

  The broker terminates TLS for the hosts it must read, with a certificate authority that
  exists only on this machine and is trusted only inside its containers.

The job itself is the agent runner in headless mode. Its exit is the completion signal;
its log holds the cost. The daemon reports the outcome to the requester with `done`.

**Devices.** Simulators, emulators and attached devices stay on the host. A container
reaches them only through forwards the broker opens for a job: the host's adb server, the
device allocator, and the host's tool-server. What a machine has is never published; it
only weighs it when deciding whether to take a task.

## Tests

`npm test` runs every `test/*.mjs`. They use the loopback transport, a fake forge and a
fake docker unless they say otherwise; `DN_TEST_TOR=real` and `DN_TEST_DOCKER=real` run
the same end-to-end files against the real things.
