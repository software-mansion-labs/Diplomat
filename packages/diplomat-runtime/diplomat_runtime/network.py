"""Diplomat's side of the Diplomacy Network daemon (``packages/diplomacy-network``):
what a job is offered as, what this machine admits, and what the daemon's snapshot
says.

Swift twin: ``DiplomatCore/Network.swift``, decision for decision.
"""

from __future__ import annotations

import hashlib
import math
import re
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

from . import jsoninput
from .agentstate import (NET_CLAIMED, NET_POOLED, SOURCE_PANEL, NetworkTask, Observation,
                         _flag, _integer, _number, _text)
from .prref import GITHUB, LocalRepo

# MARK: - Settings

#: The keys of ``~/.diplomat/config.json`` the daemon reads.
ENABLED_KEY = "networkEnabled"
REQUIRED_MINIMUM_H_KEY = "networkRequiredMinimumH"
MAXIMUM_ACCEPTED_H_KEY = "networkMaximumAcceptedH"
#: Whether a job running on this machine may reach its adb server. Off unless ``true``.
DEVICES_KEY = "networkDevices"

#: The fewest hours a task may ask for or a member may accept, and the default of both.
#: The daemon's ``HOURS_FLOOR``.
HOURS_FLOOR = 12
#: The most hours either may be. The daemon's ``HOURS_CEILING``.
HOURS_CEILING = 720


_JS_DECIMAL = re.compile(r"[+-]?([0-9]+\.?[0-9]*|\.[0-9]+)([eE][+-]?[0-9]+)?")
_JS_RADIX = re.compile(r"0[xX][0-9a-fA-F]+|0[oO][0-7]+|0[bB][01]+")
#: What JavaScript strips from the ends of a string it reads as a number.
_JS_SPACE = ("\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006"
             "\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff")


def _js_string(value: Any) -> str:
    """A member of an array as JavaScript joins it into the array's string."""
    if value is None:
        return ""
    if isinstance(value, list):
        return ",".join(_js_string(v) for v in value)
    if isinstance(value, str):
        return value
    if isinstance(value, bool):
        return "true" if value else "false"
    return repr(value) if isinstance(value, (int, float)) else "[object Object]"


def js_number(value: Any) -> float:
    """JavaScript's ``Number()`` of a JSON value: a number is itself, ``true`` is 1,
    ``false`` and ``null`` are 0, a string is the number it spells (a blank one is 0)
    and an array is its members joined by commas, read as that string. Anything else
    is NaN."""
    if isinstance(value, list):
        value = _js_string(value)
    if value is None:
        return 0.0
    if isinstance(value, (bool, int, float)):
        try:
            return float(value)
        except OverflowError:
            return math.inf
    if isinstance(value, str):
        text = value.strip(_JS_SPACE)
        if not text:
            return 0.0
        if _JS_DECIMAL.fullmatch(text):
            return float(text)
        if _JS_RADIX.fullmatch(text):
            return float(int(text, 0))
    return math.nan


def hours(stored: Any) -> int:
    """A stored hours value as the daemon reads it (its ``hoursOf``): the value's
    JavaScript number (:func:`js_number`) rounded to the nearest whole number, a half
    going up, and held to the floor and the ceiling. The floor when that is no finite
    number."""
    v = js_number(stored)
    if not math.isfinite(v):
        return HOURS_FLOOR
    return int(min(max(math.floor(v + 0.5), HOURS_FLOOR), HOURS_CEILING))


# MARK: - Routes

#: The daemon's local-socket routes, by the name a daemon client posts to.
ROUTE_HEALTH = "health"
ROUTE_STATE = "state"
ROUTE_POOLS = "pools"
ROUTE_ADMIT = "admit"
ROUTE_OFFER = "offer"
ROUTE_WITHDRAW = "withdraw"
ROUTE_INVITE = "invite"
ROUTE_JOIN = "join"
ROUTE_LEAVE = "leave"
ROUTE_STOP_RUN = "stop-run"

#: Why an offer is withdrawn: its PR merged, the operator forgot the run or stopped a
#: task no run here carries, its run could not be booked, the switch went off, or the
#: goal that asked for it stopped acting.
WITHDRAW_MERGED = "merged"
WITHDRAW_FORGOTTEN = "forgotten"
WITHDRAW_STOPPED = "stopped"
WITHDRAW_NOT_BOOKED = "not booked"
WITHDRAW_SWITCHED_OFF = "switched off"
WITHDRAW_GOAL = "its goal stopped"


def withdraw_body(task: str, reason: str) -> dict:
    return {"taskId": task, "reason": reason}


def invite_body(pool: str, ttl_secs: int | None = None) -> dict:
    """``ttl_secs`` absent leaves the invite's life to the daemon."""
    return {"pool": pool} if ttl_secs is None else {"pool": pool, "ttlSecs": ttl_secs}


def join_body(invite: str = "", *, pool: str = "") -> dict:
    """By ``invite`` into someone's pool, or back into a ``pool`` this machine left."""
    return {"pool": pool} if pool else {"invite": invite}


def leave_body(pool: str) -> dict:
    return {"pool": pool}


def stop_run_body(run: str) -> dict:
    return {"runId": run}


#: The activity verbs of the ``network`` audit category.
AUDIT_OFFER = "network-offer"
AUDIT_CLAIMED = "network-claimed"
AUDIT_DONE = "network-done"
AUDIT_FAILED = "network-failed"
AUDIT_WITHDRAW = "network-withdraw"
AUDIT_UNAVAILABLE = "network-unavailable"
AUDIT_JOIN = "network-join"
AUDIT_INVITE = "network-invite"
AUDIT_LEAVE = "network-leave"
AUDIT_START = "network-start"
AUDIT_STOP = "network-stop"

# MARK: - What to offer

KIND_REVIEW = "review"
KIND_REVIEW_OWN = "review-own"
KIND_CONFLICTS = "conflicts"
KIND_ISSUES = "issues"
KIND_AUDIT = "audit"
KIND_INVESTIGATE = "investigate"

OPTION_VERDICT = "verdict"
OPTION_MARK_READY = "markReady"
OPTION_NO_PRS = "noPRs"
OPTION_READ_ONLY = "readOnly"


@dataclass(frozen=True)
class Offer:
    """The body of ``POST /offer``."""

    pool: str
    kind: str
    #: The kind's own option alone; empty for a kind that has none.
    options: dict[str, bool]
    item: str
    title: str
    prompt: str
    #: Whether this machine claims it at once, whatever it admits.
    now: bool

    @property
    def body(self) -> dict:
        body = {"pool": self.pool, "kind": self.kind, "item": self.item,
                "title": self.title, "prompt": self.prompt, "now": self.now}
        if self.options:
            body["options"] = dict(self.options)
        return body


def offer_for(verb: str, own_pr: bool, number: int | None, repo_key: str, label: str,
              prompt: str, source: str, forced: bool = False, *, verdict: bool = False,
              mark_ready: bool = False, no_prs: bool = False,
              read_only: bool = False) -> Offer | str:
    """The offer for one job, from the audit verb it is logged under; or, as a string,
    why the job cannot be offered.

    The four option inputs are what the job's own prompt was built to allow: whether a
    review may approve or request changes, whether work on the operator's own PR may
    mark it ready, whether an issue fix opens no PRs, and whether an audit only reads.
    Each reaches the offer under the one kind it belongs to.

    A job the operator started, or forced past a hold, is theirs to run at once
    (``now``).
    """
    kind = kind_for(verb, own_pr)
    if kind is None:
        return f"the network runs no {verb} jobs"
    pool = pool_for(repo_key)
    if pool is None:
        return "no repository to offer it into"
    host = pool.split("/", 1)[0]
    if not has_rules(host):
        return no_rules(host)
    options = {KIND_REVIEW: {OPTION_VERDICT: verdict},
               KIND_REVIEW_OWN: {OPTION_MARK_READY: mark_ready},
               KIND_ISSUES: {OPTION_NO_PRS: no_prs},
               KIND_AUDIT: {OPTION_READ_ONLY: read_only}}.get(kind, {})
    item = item_for(kind, number, prompt)
    return Offer(pool=pool, kind=kind, options=options, item=item,
                 title=label or f"{kind} {item}", prompt=prompt,
                 now=source == SOURCE_PANEL or forced)


def kind_for(verb: str, own_pr: bool) -> str | None:
    """The daemon's kind for an audit verb, or ``None`` for a verb it has none for. A
    review of the operator's own PR is its own kind, and a reply to reviews is always
    one."""
    if verb in ("review-req", "review", "comms-review"):
        return KIND_REVIEW_OWN if own_pr else KIND_REVIEW
    return {"review-reply": KIND_REVIEW_OWN, "conflicts": KIND_CONFLICTS,
            "issues": KIND_ISSUES, "comms-fix": KIND_ISSUES, "audit": KIND_AUDIT,
            "investigate": KIND_INVESTIGATE,
            "comms-investigate": KIND_INVESTIGATE}.get(verb)


def pool_for(repo_key: str) -> str | None:
    """The pool a repository key (:attr:`prref.LocalRepo.key`) names: the forge's host
    and the project path, lowercase. ``None`` for a key that names no repository."""
    key = repo_key.lower()
    parts = key.split("/")
    if len(parts) < 2 or not all(parts):
        return None
    return f"{GITHUB}/{key}" if len(parts) == 2 else key


#: GitHub's own names. On each but github.com itself, and on every name under one,
#: ``gh`` looks for the API on another name again.
_GITHUB_NAMES = (GITHUB, "ghe.com", "github.localhost")


def has_rules(host: str) -> bool:
    """Whether the daemon's requester has rules for a repository on ``host`` (its
    ``githubApi``): for github.com and for every host that is none of GitHub's own
    names - not for a subdomain of github.com, nor for ghe.com, github.localhost or
    anything under them. A port after the name is not part of it."""
    if host == GITHUB:
        return True
    name, colon, port = host.rpartition(":")
    if not colon or any(c not in "0123456789" for c in port):
        name = host
    return not any(name == own or name.endswith("." + own) for own in _GITHUB_NAMES)


def no_rules(host: str) -> str:
    return f"the network has no rules for a repository on {host}"


def item_for(kind: str, number: int | None, prompt: str) -> str:
    """What the task is pinned to: the pull request or issue the kind works on, else a
    name for this prompt alone."""
    if number is not None:
        if kind == KIND_ISSUES:
            return f"issue-{number}"
        if kind in (KIND_REVIEW, KIND_REVIEW_OWN, KIND_CONFLICTS):
            return f"pr-{number}"
    return "job-" + hashlib.sha256(prompt.encode("utf-8")).hexdigest()[:16]


def linked_pools(roots: Iterable[LocalRepo], identities: Mapping[str, str]) -> list[dict]:
    """The repositories this machine links to pools, one per root, the first root
    winning an id. ``identities`` maps a forge host to the login work is done as there;
    a root on a host with none is left out, a task id being built on that login, and
    so is one on a host the network has no rules for (:func:`has_rules`)."""
    out: dict[str, dict] = {}
    for root in roots:
        identity = identities.get(root.host, "").strip().lower()
        pool = pool_for(root.key)
        if not identity or pool is None or pool in out or not has_rules(root.host):
            continue
        out[pool] = {"id": pool, "path": root.path,
                     "forge": "gitlab" if root.is_gitlab else "github",
                     "identity": identity}
    return list(out.values())


def unconfirmed_unread(path: str) -> str:
    return (f"{path} cannot be read: its pool stays as the daemon last had it until the "
            "path can be read or is taken out of Settings")


def unconfirmed_account(repo: str, host: str) -> str:
    return (f"The login for {repo} on {host} is not known yet: its pool stays as the "
            "daemon last had it until it is")


def unsupported(repo: str, host: str) -> str:
    return (f"{repo} is on {host}, which the Diplomacy Network has no rules for: it has "
            "no pool and none of its jobs is offered")


def pools_listing(roots: Iterable[LocalRepo], others: Iterable[LocalRepo],
                  unread: Iterable[str], identities: Mapping[str, str],
                  known: Iterable["Pool"]) -> tuple[list[dict], list[str]]:
    """What ``POST /pools`` is to say, and a sentence for each repository that has no
    pool of its own making: one that could not be confirmed, and one on a host the
    network has no rules for.

    Every linked repository is a pool: the roots, then what the Other repos checkouts
    name that no root does (``others``). A root or a checkout that was read and names no
    forge is no pool, and is in neither list; a repository on a host without rules
    (:func:`has_rules`) is no pool either, and is named. What could not be confirmed is
    said as the daemon last had it (``known``, its snapshot's pools): the pool at a path that could
    not be read (``unread``), and the pool of a repository whose forge login is unknown.
    The daemon leaves a pool the list omits, so the list is never cut short by what is
    unknown, and a repository taken out of Settings leaves its pool whatever else
    cannot be read."""
    repos = [*roots, *others]
    pools = linked_pools(repos, identities)
    listed = {pool["id"] for pool in pools}
    nameless: dict[str, LocalRepo] = {}
    unruled: dict[str, LocalRepo] = {}
    for repo in repos:
        pool = pool_for(repo.key)
        if pool is not None and pool not in listed:
            (nameless if has_rules(repo.host) else unruled).setdefault(pool, repo)
    unread = list(unread)
    for pool in known:
        if pool.id not in listed and (pool.path in unread or pool.id in nameless):
            listed.add(pool.id)
            pools.append({"id": pool.id, "path": pool.path,
                          "forge": "github" if pool.id.startswith(f"{GITHUB}/") else "gitlab",
                          "identity": pool.identity})
    return pools, [*map(unconfirmed_unread, unread),
                   *(unconfirmed_account(r.slug, r.host) for r in nameless.values()),
                   *(unsupported(r.slug, r.host) for r in unruled.values())]


def pools_body(pools: list[dict]) -> dict:
    """The body of ``POST /pools``."""
    return {"pools": pools}


# MARK: - Admit

ADMIT_DISK = "disk"
ADMIT_BUDGET = "budget"
ADMIT_PAUSED = "paused"

#: The states of a snapshot run that hold a bay.
LIVE_RUN_STATES = frozenset({"preparing", "running"})


@dataclass(frozen=True)
class Admit:
    """How many more tasks this machine takes now: the body of ``POST /admit``."""

    slots: int
    #: Why it is zero when something other than a full cap makes it so; else "".
    reason: str = ""

    @property
    def body(self) -> dict:
        return ({"slots": self.slots, "reason": self.reason} if self.reason
                else {"slots": self.slots})


def admit(limit: int, running: int, low_disk: bool, affordable: bool,
          auto_run: bool) -> Admit:
    """The free bays of the cap, or none while the disk is low, the budget is spent or
    the operator has automatic work off - the first of those that holds is the reason
    given."""
    if low_disk:
        return Admit(0, ADMIT_DISK)
    if not affordable:
        return Admit(0, ADMIT_BUDGET)
    if not auto_run:
        return Admit(0, ADMIT_PAUSED)
    return Admit(max(0, limit - running))


def running(snapshot: "Snapshot | None") -> int:
    """The runs this machine is executing for the network."""
    return sum(r.state in LIVE_RUN_STATES for r in snapshot.runs) if snapshot else 0


# MARK: - The snapshot


@dataclass(frozen=True)
class Service:
    state: str = ""
    detail: str = ""


@dataclass(frozen=True)
class Docker:
    state: str = ""
    image: str = ""
    detail: str = ""


@dataclass(frozen=True)
class AdmitState:
    slots: int = 0
    at: float | None = None
    reason: str = ""


@dataclass(frozen=True)
class Member:
    pk: str
    is_self: bool = False
    max_accepted_h: int | None = None
    last_seen: float | None = None
    reachable: bool = False


@dataclass(frozen=True)
class PoolTask:
    task_id: str
    kind: str = ""
    item: str = ""
    title: str = ""
    identity: str = ""
    hours: int | None = None
    #: ``available``, ``claimed``, ``done`` or ``cancelled``.
    state: str = ""
    offered_by: tuple[str, ...] = ()
    offered_here: bool = False
    executor: str = ""
    executor_here: bool = False
    claimed_at: float | None = None
    lease_until: float | None = None
    deadline: float | None = None


@dataclass(frozen=True)
class Pool:
    id: str
    path: str = ""
    identity: str = ""
    hash: str = ""
    members: tuple[Member, ...] = ()
    tasks: tuple[PoolTask, ...] = ()
    #: Whether this machine left the pool: it takes and offers nothing there.
    left: bool = False
    #: Whether an invite pasted here waits for the machine that made it: this machine
    #: is the pool's only member meanwhile.
    joining: bool = False
    #: Why the last invite let this machine in nowhere, in the daemon's words; "" for
    #: none.
    join_failed: str = ""
    #: Why this machine takes none of the pool's jobs, in the daemon's sentence; ""
    #: while it takes them.
    not_taking: str = ""


@dataclass(frozen=True)
class Run:
    run_id: str
    task_id: str = ""
    pool: str = ""
    peer: str = ""
    container: str = ""
    #: ``preparing``, ``running``, ``finished``, ``failed`` or ``stopped``.
    state: str = ""
    started_at: float | None = None
    ended_at: float | None = None
    exit: int | None = None


@dataclass(frozen=True)
class Outcome:
    ok: bool = False
    summary: str = ""
    usd: float | None = None
    tokens: float | None = None
    runner: str = ""
    model: str = ""
    #: Whether the executor lowered the tokens or the cost the job named to what it
    #: measured itself.
    capped: bool = False


@dataclass(frozen=True)
class OfferState:
    task_id: str
    #: ``pooled``, ``claimed``, ``done``, ``failed`` or ``cancelled``.
    state: str = ""
    executor: str = ""
    attempt: int = 0
    requests: int = 0
    refused: int = 0
    outcome: Outcome | None = None
    ended_at: float | None = None
    pool: str = ""
    kind: str = ""
    item: str = ""
    title: str = ""
    #: How the last attempt of a ``failed`` offer ended, or why a ``cancelled`` one was
    #: withdrawn; "" when the daemon gave none.
    reason: str = ""
    #: The daemon's own word on whether the executor is this machine; ``None`` when the
    #: document gave none.
    executor_here: bool | None = None
    offered_at: float | None = None
    #: Why this machine does not take this job of its own while it is ``pooled``, in
    #: the daemon's sentence; "" for a job it is free to take.
    not_taking: str = ""


def _object(raw: Any) -> dict:
    return raw if isinstance(raw, dict) else {}


def _rows(raw: Any) -> list[dict]:
    return [r for r in raw if isinstance(r, dict)] if isinstance(raw, list) else []


def _service(raw: Any) -> Service:
    s = _object(raw)
    return Service(_text(s.get("state")), _text(s.get("detail")))


@dataclass(frozen=True)
class Snapshot:
    """The daemon's ``GET /state``, read without ever failing: a member that is absent
    or of the wrong type is its default, a row without its identity is dropped, and
    anything else in the document is ignored."""

    updated_at: float | None = None
    pid: int | None = None
    started_at: float | None = None
    pk: str = ""
    onion: str = ""
    transport: Service = field(default_factory=Service)
    docker: Docker = field(default_factory=Docker)
    model: Service = field(default_factory=Service)
    #: Whether jobs running here reach this machine's adb server: ``off``, ``ready``
    #: or ``none``.
    devices: Service = field(default_factory=Service)
    admit: AdmitState = field(default_factory=AdmitState)
    pools: tuple[Pool, ...] = ()
    runs: tuple[Run, ...] = ()
    #: ``None`` when the document has no ``offers`` list, which says nothing about any
    #: offer; an empty tuple says there are none.
    offers: tuple[OfferState, ...] | None = None

    @staticmethod
    def parse(text: str | bytes | None) -> "Snapshot | None":
        """The daemon's answer, or ``None`` when there was none or it is not a JSON
        object."""
        if text is None:
            return None
        try:
            if isinstance(text, bytes):
                text = text.decode("utf-8")
            data = jsoninput.loads(text)
        except ValueError:
            return None
        return Snapshot.from_json(data) if isinstance(data, dict) else None

    @staticmethod
    def from_json(d: dict) -> "Snapshot":
        daemon, identity = _object(d.get("daemon")), _object(d.get("identity"))
        dock, adm = _object(d.get("docker")), _object(d.get("admit"))
        offers = d.get("offers")
        return Snapshot(
            updated_at=_number(d.get("updatedAt")),
            pid=_integer(daemon.get("pid")),
            started_at=_number(daemon.get("startedAt")),
            pk=_text(identity.get("pk")),
            onion=_text(identity.get("onion")),
            transport=_service(d.get("transport")),
            docker=Docker(_text(dock.get("state")), _text(dock.get("image")),
                          _text(dock.get("detail"))),
            model=_service(d.get("model")),
            devices=_service(d.get("devices")),
            admit=AdmitState(_integer(adm.get("slots")) or 0, _number(adm.get("at")),
                             _text(adm.get("reason"))),
            pools=tuple(_pool(p) for p in _rows(d.get("pools")) if _text(p.get("id"))),
            runs=tuple(
                Run(run_id=r["runId"], task_id=_text(r.get("taskId")),
                    pool=_text(r.get("pool")), peer=_text(r.get("peer")),
                    container=_text(r.get("container")), state=_text(r.get("state")),
                    started_at=_number(r.get("startedAt")),
                    ended_at=_number(r.get("endedAt")), exit=_integer(r.get("exit")))
                for r in _rows(d.get("runs")) if _text(r.get("runId"))),
            offers=(tuple(_offer(o) for o in _rows(offers) if _text(o.get("taskId")))
                    if isinstance(offers, list) else None),
        )


#: The states of a service that end what it is for until the operator acts. The
#: Network screen draws them red, and the panel says so (:func:`trouble`).
TROUBLE_STATES = frozenset({"failed", "missing", "down"})


def trouble(answered: bool | None, snapshot: Snapshot | None) -> str:
    """The panel's one line on what of the network does not work on this machine: a
    daemon that was asked and did not answer, else each of the transport, docker and
    the model credential that is in a :data:`TROUBLE_STATES` state, with the daemon's
    detail. "" while nothing is wrong, the daemon has not been asked, or a service is
    still coming up."""
    if answered is False:
        return "Diplomacy Network: the daemon is not answering"
    if snapshot is None:
        return ""
    wrong = [f"{name} {service.state}" + (f" ({service.detail})" if service.detail else "")
             for name, service in (("transport", snapshot.transport),
                                   ("docker", snapshot.docker), ("model", snapshot.model))
             if service.state in TROUBLE_STATES]
    return "Diplomacy Network: " + "; ".join(wrong) if wrong else ""


_UTC_TIME = re.compile(
    r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]+)?Z")


def local_times(sentence: str) -> str:
    """``sentence`` with each UTC time the daemon wrote in it, as in ``…until
    2026-11-17T10:30:56.000Z``, as this machine's clock reads it: ``…until 11:30``."""
    def clock(found: re.Match) -> str:
        try:
            at = datetime.strptime(found[0][:19] + "+0000", "%Y-%m-%dT%H:%M:%S%z")
        except ValueError:
            return found[0]
        return at.astimezone().strftime("%H:%M")
    return _UTC_TIME.sub(clock, sentence)


def _pool(p: dict) -> Pool:
    return Pool(
        id=p["id"], path=_text(p.get("path")), identity=_text(p.get("identity")),
        hash=_text(p.get("hash")), left=_flag(p.get("left")),
        joining=_flag(p.get("joining")), join_failed=_text(p.get("joinFailed")),
        not_taking=local_times(_text(p.get("notTaking"))),
        members=tuple(
            Member(pk=m["pk"], is_self=_flag(m.get("self")),
                   max_accepted_h=_integer(m.get("maxAcceptedH")),
                   last_seen=_number(m.get("lastSeen")),
                   reachable=_flag(m.get("reachable")))
            for m in _rows(p.get("members")) if _text(m.get("pk"))),
        tasks=tuple(
            PoolTask(task_id=t["taskId"], kind=_text(t.get("kind")),
                     item=_text(t.get("item")), title=_text(t.get("title")),
                     identity=_text(t.get("identity")), hours=_integer(t.get("hours")),
                     state=_text(t.get("state")),
                     offered_by=tuple(
                         h for h in (t.get("offeredBy")
                                     if isinstance(t.get("offeredBy"), list) else [])
                         if isinstance(h, str)),
                     offered_here=_flag(t.get("offeredHere")),
                     executor=_text(t.get("executor")),
                     executor_here=_flag(t.get("executorHere")),
                     claimed_at=_number(t.get("claimedAt")),
                     lease_until=_number(t.get("leaseUntil")),
                     deadline=_number(t.get("deadline")))
            for t in _rows(p.get("tasks")) if _text(t.get("taskId"))))


def _offer(o: dict) -> OfferState:
    out, here = o.get("outcome"), o.get("executorHere")
    return OfferState(
        task_id=o["taskId"], pool=_text(o.get("pool")), kind=_text(o.get("kind")),
        item=_text(o.get("item")), title=_text(o.get("title")),
        state=_text(o.get("state")), reason=_text(o.get("reason")),
        executor=_text(o.get("executor")),
        executor_here=here if isinstance(here, bool) else None,
        offered_at=_number(o.get("offeredAt")), attempt=_integer(o.get("attempt")) or 0,
        requests=_integer(o.get("requests")) or 0,
        refused=_integer(o.get("refused")) or 0,
        outcome=Outcome(ok=_flag(out.get("ok")), summary=_text(out.get("summary")),
                        usd=_number(out.get("usd")), tokens=_number(out.get("tokens")),
                        runner=_text(out.get("runner")), model=_text(out.get("model")),
                        capped=_flag(out.get("capped")))
        if isinstance(out, dict) else None,
        ended_at=_number(o.get("endedAt")),
        not_taking=local_times(_text(o.get("notTaking"))))


UNANSWERED = "the daemon did not answer"
NO_OFFERS = "the snapshot lists no offers"


def tasks(snapshot: Snapshot | None) -> Observation:
    """What a snapshot says of this machine's own offers, as the agent-state resolver
    reads it (:attr:`agentstate.Evidence.network`): task id → its offer.

    Whether a task runs here is the offer's own word where the daemon gives it. Where
    it gives none, a task runs here when one of this machine's live runs is for it,
    when its pool lists this machine as its executor, or when its executor is this
    machine's own key."""
    if snapshot is None:
        return Observation.unavailable(UNANSWERED)
    if snapshot.offers is None:
        return Observation.unavailable(NO_OFFERS)
    here = {r.task_id for r in snapshot.runs if r.state in LIVE_RUN_STATES}
    here |= {t.task_id for p in snapshot.pools for t in p.tasks if t.executor_here}
    return Observation.present({
        o.task_id: NetworkTask(
            state=o.state, executor=o.executor,
            executor_here=o.executor_here if o.executor_here is not None
            else (bool(o.executor) and o.executor == snapshot.pk) or o.task_id in here,
            ok=o.outcome.ok if o.outcome else False, reason=o.reason,
            not_taking=o.not_taking, capped=o.outcome.capped if o.outcome else False)
        for o in snapshot.offers})


def not_taking(task: str, pool: Pool, snapshot: Snapshot | None) -> str:
    """Why this machine does not take the job it offered as ``task`` while that waits
    in ``pool``, where the reason is the job's own: "" for a job it is free to take, and
    for one held back by what holds every job of the pool back (:attr:`Pool.not_taking`),
    which the pool says once."""
    offers = (snapshot.offers if snapshot else None) or ()
    said = next((o.not_taking for o in offers
                 if o.task_id == task and o.state == NET_POOLED), "")
    return "" if said == pool.not_taking else said


def open_task(pool: str, kind: str, item: str, snapshot: Snapshot | None) -> str | None:
    """The task the daemon holds for an offer of ``item`` as ``kind`` to ``pool``: its
    open offer of the three, which is what it names a task by. None when the snapshot
    lists none."""
    if snapshot is None or snapshot.offers is None:
        return None
    return next((o.task_id for o in snapshot.offers
                 if (o.pool, o.kind, o.item) == (pool, kind, item)
                 and o.state in (NET_POOLED, NET_CLAIMED)), None)
