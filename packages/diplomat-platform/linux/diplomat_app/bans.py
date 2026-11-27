"""Prompt-injection ban list - the Linux port of BanList.swift.

The device-allocator daemon (and the macOS monitor) write banned authors to
``~/.diplomat/pr-monitor/banned.json`` as ``{"banned": [BannedAuthor, ...]}``. The
panel reads it, surfacing who is blocked from automated work. One list holds two
namespaces: a GitHub login, and a Slack sender as ``slack:<user id>`` (core's
``CommsBan``), which no GitHub login can collide with since none holds a colon.

The writes here, Comms banning a Slack sender (:func:`report_comms_ban`) and the panel
lifting a ban (:func:`unban`), go through the daemon like every other ban-list write, and
straight to the file only when no daemon is reachable.
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import NamedTuple

from diplomat_runtime import activity, atomicjson
from diplomat_runtime.models import Fmt

#: ``CommsBan.loginPrefix``.
SLACK_PREFIX = "slack:"
#: The daemon's ``SLACK_USER_ID``: it refuses a ban on anything else.
_SLACK_USER_ID = re.compile(r"^[UW][A-Z0-9]{2,}$")
#: The ``reportedBy`` of a ban Comms reported.
COMMS_REPORTER = "Comms triage"


def ban_dir() -> Path:
    """Relocated by ``DA_BAN_DIR``, as in the daemon's ``src/paths.js``."""
    env = os.environ.get("DA_BAN_DIR")
    if env:
        return Path(env).expanduser()
    return Path.home() / ".diplomat" / "pr-monitor"


def banned_path() -> Path:
    return ban_dir() / "banned.json"


def slack_login(user_id: str) -> str:
    return SLACK_PREFIX + user_id


def _parse(s: str | None) -> datetime | None:
    if not s:
        return None
    try:
        d = datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        return None
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)


@dataclass(frozen=True)
class BannedAuthor:
    login: str
    reason: str | None = None
    #: A PR reference for a GitHub ban, the message's permalink for a Slack one.
    pr: str | None = None
    #: ``"slack"`` for a Slack sender; absent for a GitHub author.
    source: str | None = None
    #: A Slack sender's display name.
    handle: str | None = None
    #: A Slack sender's ``#channel`` or ``DM``.
    place: str | None = None
    evidence: str | None = None
    evidence_dir: str | None = None
    reported_by: str | None = None
    #: The latest ban; ``first_at`` is the first, kept across re-bans.
    at: str | None = None
    first_at: str | None = None

    @property
    def is_slack(self) -> bool:
        return self.login.startswith(SLACK_PREFIX)

    @property
    def slack_id(self) -> str | None:
        return self.login[len(SLACK_PREFIX):] if self.is_slack else None

    @property
    def name(self) -> str:
        """``@login``; a Slack sender by handle, or by id when none was recorded."""
        if self.is_slack:
            return f"@{self.handle}" if self.handle else str(self.slack_id)
        return f"@{self.login}"

    @property
    def banned_at(self) -> datetime | None:
        return _parse(self.at)

    @property
    def first_banned_at(self) -> datetime | None:
        """Only when it differs from :attr:`banned_at`: the author was banned again."""
        first = _parse(self.first_at)
        return first if first is not None and first != self.banned_at else None


def read() -> list[BannedAuthor]:
    """The current banned authors; empty when the file is absent or malformed, which a
    gate tells apart (:func:`unreadable`): a malformed list could be banning anyone."""
    out: list[BannedAuthor] = []
    for b in (_listed() or {}).get("banned", []):
        if not isinstance(b, dict) or not b.get("login"):
            continue

        def s(key: str) -> str | None:
            v = b.get(key)
            return str(v) if v not in (None, "") else None

        out.append(BannedAuthor(
            login=str(b["login"]), reason=s("reason"), pr=s("pr"), source=s("source"),
            handle=s("handle"), place=s("place"), evidence=s("evidence"), evidence_dir=s("evidenceDir"),
            reported_by=s("reportedBy"), at=s("at"), first_at=s("firstAt")))
    return out


def unreadable() -> bool:
    """Whether the file is not known absent but is no JSON object whose ``banned`` is a
    list or absent. Twin of ``BanList.readFile``'s ``unreadable``."""
    return _listed() is None


def _listed() -> dict | None:
    """The file's object (``{}`` when absent), or None when it is :func:`unreadable`."""
    path = banned_path()
    data = atomicjson.read_object(path)
    if data is None:
        try:
            os.stat(path)
        except (FileNotFoundError, NotADirectoryError):
            return {}
        except OSError:  # e.g. a directory it cannot search, which may hold one
            pass
        return None
    return data if isinstance(data.get("banned", []), list) else None


def _left_unread() -> str:
    """Why a ban or un-ban left an :func:`unreadable` file alone, without asking the
    daemon: an older one writes over it."""
    return f"{banned_path()} is unreadable, so it was left as it is"


#: Why a gate refused work while the list is :func:`unreadable`.
UNREADABLE = "the prompt-injection ban list could not be read"
#: The dispatch verdict for that refusal: the job waits as a deferral does, a find
#: queued again and an ask kept (macOS ``DispatchOutcome.banListUnreadable``).
VERDICT_UNREADABLE = "ban-list-unreadable"


def unreadable_note() -> str:
    """The feed's line for a spell of :func:`unreadable` (macOS ``unreadNote``)."""
    return (f"{banned_path()} could not be read: it could be banning anyone, so work "
            "naming an author waits until it reads")


def is_banned(login: str, banned: list[BannedAuthor]) -> bool:
    """Whether ``login`` is on the ban list (case-insensitive, as GitHub logins are).
    Mirrors BanList.isBanned — the monitor must never dispatch an agent for a PR by a
    banned (prompt-injection) author."""
    low = (login or "").lower()
    return any(b.login.lower() == low for b in banned)


def slack_ids(banned: list[BannedAuthor]) -> list[str]:
    """The Slack user ids on the list: ``CommsSettings.bannedSenders``."""
    return [b.slack_id for b in banned if b.slack_id]


def _stamp(d: datetime) -> str:
    return d.astimezone().strftime("%b %d %H:%M")


def when_text(b: BannedAuthor, now: datetime | None = None) -> str:
    """``banned 3h ago (Oct 28 14:02)``, and when first banned if this is a re-ban."""
    at = b.banned_at
    if at is None:
        return "banned at an unrecorded time"
    text = f"banned {Fmt.age(at, now)} ago ({_stamp(at)})"
    first = b.first_banned_at
    return text + (f", first {_stamp(first)}" if first else "")


def place_text(b: BannedAuthor) -> str:
    """Where the injection was, short: ``PR #N``, the PR reference as recorded, or the
    Slack message and its channel (its permalink is :func:`place_url`)."""
    if b.is_slack:
        noun = "Slack message" if b.pr else "Slack"
        return f"{noun}, {b.place}" if b.place else noun
    if not b.pr:
        return "GitHub"
    m = re.search(r"/pull/(\d+)", b.pr)
    return f"PR #{m.group(1)}" if m else b.pr


def place_url(b: BannedAuthor) -> str | None:
    return b.pr if b.pr and b.pr.startswith(("https://", "http://")) else None


# MARK: - Comms reporting a Slack sender


class Reported(NamedTuple):
    """A ban or an un-ban, as it went."""

    #: A daemon answered; it logs the feed line of every change it makes.
    by_daemon: bool
    #: Why the change was not made; None once it was.
    error: str | None = None


#: A daemon that took the request and never answered may still act on it, so nothing is
#: written here as well: this write and the daemon's late one would make two.
_NO_REPLY = "the allocator daemon did not answer in time; it may still {}"


def _refused(reply) -> str:
    return f"the device-allocator refused it ({reply.get('error') or reply.status})"


def ban_line(entry: dict) -> str:
    """The daemon's ``banLine`` for a ban Comms flagged, word for word."""
    user_id = entry["login"][len(SLACK_PREFIX):]
    handle = entry.get("handle")
    who = f"Slack user {'@' + handle + ' ' if handle else ''}({user_id})"
    where = f" ({entry['pr']})" if entry.get("pr") else ""
    evidence = " ".join(str(entry.get("evidence") or "").split())[:160]
    quote = f': "{evidence}"' if evidence else ""
    return f"Banned {who} for prompt injection{where}{quote} - flagged by Comms triage"


def report_comms_ban(ban: dict, *, timeout_secs: float = 10) -> Reported:
    """Ban the sender of one ``CommsBan`` (``{userID, handle, place, permalink,
    evidence, reason}``). Blocking, so off the GUI thread.

    Through the daemon's ``/report-injection``, which serializes every ban-list write
    and logs the ``ban`` line itself. An unreachable daemon is not a reason to leave the
    sender free: the entry is then written here, in the daemon's shape, with the line it
    would have logged. A daemon that refuses, or takes the request and never answers,
    is final.

    A daemon older than Slack bans records the bare id, as a GitHub login: that entry is
    lifted again, unless that login was banned already, and the sender is not banned."""
    from . import deviceallocator

    user_id = str(ban.get("userID") or "")
    handle = str(ban.get("handle") or "").strip().lstrip("@")
    place = str(ban.get("place") or "").strip()
    permalink = str(ban.get("permalink") or "")
    evidence = str(ban.get("evidence") or "")
    if not _SLACK_USER_ID.match(user_id):
        return Reported(False, f"no Slack user id to ban ({user_id or 'none'})")
    if unreadable():
        return Reported(False, _left_unread())
    login = slack_login(user_id)
    before = {b.login.lower() for b in read()}
    reply = deviceallocator.exchange("report-injection", {
        "person": user_id, "source": "slack", "handle": handle, "place": place, "pr": permalink,
        "evidence": evidence, "agentName": COMMS_REPORTER, "via": "comms",
    }, timeout_secs=timeout_secs)
    if reply == deviceallocator.UNREACHABLE:
        return Reported(False, _write_directly(login, handle, place, permalink, evidence))
    if not isinstance(reply, deviceallocator.DaemonReply):
        return Reported(False, _NO_REPLY.format("record the ban"))
    if not reply.ok:
        return Reported(True, _refused(reply))
    recorded = str(reply.get("login") or "")
    if recorded.lower() == login.lower():
        return Reported(True)
    why = (f'the allocator daemon banned "{recorded}" instead of {login}; '
           "restart it to pick up Slack bans")
    if recorded.lower() in before:
        why += f'; "{recorded}" was banned already, so that ban stays'
    elif recorded:
        undo = deviceallocator.exchange("unban", {"login": recorded}, timeout_secs=timeout_secs)
        if not (isinstance(undo, deviceallocator.DaemonReply) and undo.ok):
            why += f'; un-ban "{recorded}" in the panel'
    return Reported(True, why)


def _write_directly(login: str, handle: str, place: str, permalink: str,
                    evidence: str) -> str | None:
    """The daemon's write, minus its evidence dir; returns why it failed, or None. A
    file that is :func:`unreadable` is left as it is: writing over it would lift every
    ban in it."""
    path = banned_path()
    data = _listed()
    if data is None:
        return _left_unread()
    data.setdefault("banned", [])
    at = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    entry = {"login": login, "reason": "prompt injection", "pr": permalink or None,
             "evidence": evidence[:800], "evidenceDir": None, "reportedBy": COMMS_REPORTER,
             "at": at, "screenshot": False, "ghCaptured": False,
             "source": "slack", "handle": handle or None, "place": place or None}
    existing = next((b for b in data["banned"] if isinstance(b, dict)
                     and str(b.get("login", "")).lower() == login.lower()), None)
    if existing is not None:
        first = existing.get("firstAt") or existing.get("at")
        existing.update(entry, firstAt=first)
    else:
        data["banned"].append({**entry, "firstAt": at})
    try:
        atomicjson.write_atomic(path, data)
    except OSError as exc:
        return f"ban on {login} not recorded: {exc.strerror or exc}"
    activity.log("auto", "ban", ban_line(entry))
    return None


# MARK: - the panel lifting a ban


def unban(login: str, *, timeout_secs: float = 5) -> Reported:
    """Take ``login`` off the list. Blocking, so off the GUI thread.

    Through the daemon's ``/unban``, which logs the ``unban`` line when it removed
    something; directly, with that line, only when no daemon is reachable."""
    from . import deviceallocator

    if unreadable():
        return Reported(False, _left_unread())
    reply = deviceallocator.exchange("unban", {"login": login}, timeout_secs=timeout_secs)
    if reply == deviceallocator.UNREACHABLE:
        return Reported(False, _unban_directly(login))
    if not isinstance(reply, deviceallocator.DaemonReply):
        return Reported(False, _NO_REPLY.format("lift the ban"))
    return Reported(True, None if reply.ok else _refused(reply))


def _unban_directly(login: str) -> str | None:
    """The daemon's ``handleUnban``; returns why it failed, or None. A list that does
    not hold ``login`` is left unwritten."""
    path = banned_path()
    data = _listed()
    if data is None:
        return _left_unread()
    listed = data.get("banned", [])
    low = login.lower()
    kept = [b for b in listed
            if not (isinstance(b, dict) and str(b.get("login", "")).lower() == low)]
    if len(kept) == len(listed):
        return None
    data["banned"] = kept
    try:
        atomicjson.write_atomic(path, data)
    except OSError as exc:
        return f"un-ban of {login} not recorded: {exc.strerror or exc}"
    activity.log("panel", "unban", f"Un-banned @{login}")
    return None
