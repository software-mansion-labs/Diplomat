"""The Linear login through the built ``diplomat-core`` CLI, never a reimplementation of
it: the runtime's calls and the Settings row against a fake Linear on loopback, whose
consent page a ``$BROWSER`` stand-in fetches, following its redirect back as a browser
would. The core reads a copy of the assets whose ``linearOAuth`` names the fake.
"""

from __future__ import annotations

import base64
import contextlib
import hashlib
import json
import os
import shutil
import signal
import socket
import stat
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qsl, urlencode, urlsplit

import pytest
from test_settings_view import _pipeline_view, app, make_view  # noqa: F401 — fixtures

from diplomat_app.store import Store
from diplomat_runtime import core, pipeline, review
from diplomat_runtime.prref import LocalRepo

pytest.importorskip("PySide6")
from PySide6.QtWidgets import QApplication  # noqa: E402

CORE_BIN = os.environ.get("DIPLOMAT_CORE_BIN")
pytestmark = pytest.mark.skipif(
    not CORE_BIN,
    reason="DIPLOMAT_CORE_BIN not set (build it with "
           "packages/diplomat-platform/linux/install/build-core.sh)")

CODE, ACCESS, REFRESH = "the-code", "the-access-token", "the-refresh-token"
ME = {"user": "Ada Lovelace", "organization": "Ours"}


class _Linear(BaseHTTPRequestHandler):
    """Linear's OAuth endpoints, and GraphQL's ``Viewer``, as a sign-in reaches them."""

    #: ``(endpoint, fields)`` of each request.
    seen: list = []
    expires_in = 86400
    revoke_status = 200

    def do_GET(self):  # noqa: N802 - the http.server hook
        query = dict(parse_qsl(urlsplit(self.path).query))
        _Linear.seen.append(("authorize", query))
        self.send_response(302)
        self.send_header("Location", f"{query['redirect_uri']}?"
                         + urlencode({"code": CODE, "state": query["state"]}))
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_POST(self):  # noqa: N802
        body = self.rfile.read(int(self.headers.get("Content-Length") or 0)).decode()
        endpoint = urlsplit(self.path).path.rpartition("/")[2]
        if endpoint == "graphql":
            _Linear.seen.append((endpoint, {"operationName": json.loads(body)["operationName"],
                                            "Authorization": self.headers["Authorization"]}))
            return self._send(200, {"data": {"viewer": {"id": "u1", "name": ME["user"]},
                                             "organization": {"name": ME["organization"]}}})
        _Linear.seen.append((endpoint, dict(parse_qsl(body))))
        if endpoint == "token" and "refresh_token" in _Linear.seen[-1][1]:
            return self._send(400, {"error": "invalid_grant"})
        if endpoint == "token":
            return self._send(200, {"access_token": ACCESS, "refresh_token": REFRESH,
                                    "expires_in": _Linear.expires_in, "token_type": "Bearer"})
        self._send(_Linear.revoke_status, {})

    def _send(self, status: int, body: dict) -> None:
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *args):
        pass


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _listening(port: int) -> bool:
    with socket.socket() as s:
        return s.connect_ex(("127.0.0.1", port)) == 0


def _browser(tmp_path, monkeypatch, line: str) -> None:
    script = tmp_path / "browser"
    script.write_text(f"#!/bin/sh\n{line}\n")
    script.chmod(0o755)
    monkeypatch.setenv("BROWSER", str(script))


@pytest.fixture
def linear(tmp_path, monkeypatch):
    """The fake Linear, the core's assets naming it, and a ``$BROWSER`` that visits the
    consent page after it exits, as a browser outlives its launcher. Yields the
    ``linearOAuth`` the core reads."""
    _Linear.seen, _Linear.expires_in, _Linear.revoke_status = [], 86400, 200
    server = ThreadingHTTPServer(("127.0.0.1", 0), _Linear)
    # shutdown() waits out serve_forever's poll, half a second by default.
    threading.Thread(target=server.serve_forever, args=(0.01,), daemon=True).start()
    base = f"http://127.0.0.1:{server.server_address[1]}"
    assets = tmp_path / "assets"
    shutil.copytree(core.assets_dir(), assets)
    model = json.loads((assets / "pipeline.json").read_text())
    model["linearOAuth"].update(clientID="diplomat-test", authorize=f"{base}/oauth/authorize",
                                token=f"{base}/oauth/token", revoke=f"{base}/oauth/revoke",
                                ports=[_free_port()])
    (assets / "pipeline.json").write_text(json.dumps(model))
    monkeypatch.setenv("DIPLOMAT_CORE", str(assets))
    monkeypatch.setenv("DIPLOMAT_LINEAR_API", f"{base}/graphql")
    _browser(tmp_path, monkeypatch, 'curl -sL -o /dev/null "$1" &')
    yield model["linearOAuth"]
    server.shutdown()
    server.server_close()


def _settle(view) -> None:
    assert view.store.wait_for_background(60) == []
    QApplication.processEvents()


def _soon(probe, secs: float = 20):
    deadline = time.monotonic() + secs
    while not (found := probe()) and time.monotonic() < deadline:
        time.sleep(0.05)
    return found


def test_a_sign_in_saves_the_login_and_a_sign_out_forgets_and_revokes_it(linear):
    assert pipeline.linear_whoami() is None
    assert pipeline.linear_login() == (ME, "")
    assert pipeline.linear_whoami() == ME
    saved = pipeline.pipeline_dir() / "linear-login.json"
    assert stat.S_IMODE(saved.stat().st_mode) == 0o600
    assert [endpoint for endpoint, _ in _Linear.seen] == ["authorize", "token", "graphql"]
    page, exchange, viewer = (fields for _, fields in _Linear.seen)
    assert page["redirect_uri"] == f"http://127.0.0.1:{linear['ports'][0]}/linear/callback"
    assert (exchange["code"], exchange["redirect_uri"]) == (CODE, page["redirect_uri"])
    verifier = hashlib.sha256(exchange["code_verifier"].encode()).digest()
    assert base64.urlsafe_b64encode(verifier).rstrip(b"=").decode() == page["code_challenge"]
    assert viewer == {"operationName": "Viewer", "Authorization": f"Bearer {ACCESS}"}

    _Linear.seen = []
    assert pipeline.linear_logout() == (True, "")
    assert _Linear.seen == [("revoke", {"token": REFRESH, "token_type_hint": "refresh_token"})]
    assert pipeline.linear_whoami() is None
    assert not saved.exists()


def test_a_sign_in_the_core_refuses_says_why(linear, monkeypatch):
    assets = os.environ["DIPLOMAT_CORE"]
    model = json.loads(open(f"{assets}/pipeline.json").read())
    model["linearOAuth"]["clientID"] = ""
    with open(f"{assets}/pipeline.json", "w") as fh:
        json.dump(model, fh)
    assert pipeline.linear_login() == (None, "Linear sign-in has no OAuth client: "
                                             "linearOAuth.clientID in pipeline.json is empty")
    assert _Linear.seen == []


def test_the_browser_is_the_first_of_browser_s_commands_that_starts(linear, tmp_path, monkeypatch):
    assets = os.environ["DIPLOMAT_CORE"]
    model = json.loads(open(f"{assets}/pipeline.json").read())
    model["linearOAuth"]["signInSecs"] = 5
    with open(f"{assets}/pipeline.json", "w") as fh:
        json.dump(model, fh)
    _browser(tmp_path, monkeypatch, '[ "$1" = --new-window ] || exit 1; curl -sL -o /dev/null "$2" &')
    monkeypatch.setenv("BROWSER", f"no-such-browser:{tmp_path / 'browser'} --new-window '%s'")
    assert pipeline.linear_login() == (ME, "")


def test_the_settings_row_signs_in_and_out_through_the_core(linear, make_view, monkeypatch):
    view, synced = _pipeline_view(make_view, monkeypatch, pipeline_enabled=True)
    row, button = view._pipeline_login_row, view._linear_button
    assert (row.summary(), button.text()) == ("Not signed in", "Sign in…")
    button.click()
    _settle(view)
    assert (row.summary(), button.text()) == ("Signed in as Ada Lovelace (Ours)", "Sign out")
    # A switch turned on syncs at once; so does a sign-in.
    assert synced == [True]

    _Linear.revoke_status = 500
    button.click()
    _settle(view)
    assert (row.summary(), button.text()) == (
        "Signed out, but Linear answered HTTP 500 to the revocation", "Sign in…")
    assert pipeline.linear_whoami() is None
    assert synced == [True]


def test_a_login_the_sync_forgets_is_signed_out_on_the_row(linear, make_view, monkeypatch):
    """Linear refusing its refresh for good."""
    _Linear.expires_in = 60
    assert pipeline.linear_login() == (ME, "")
    # A GitLab root, which the sync skips: Linear alone is read.
    monkeypatch.setattr(review, "repo_roots",
                        lambda: [LocalRepo("g", "r", "/src/r", host="gitlab.example.com")])
    monkeypatch.setattr(review, "roots_guessed", lambda: False)
    monkeypatch.setattr(review, "roots_complete", lambda: True)
    view = make_view(pipeline_enabled=True, pipeline_linear_teams_raw="ENG=o/r")
    row = view._pipeline_login_row
    assert row.summary() == "Signed in as Ada Lovelace (Ours)"
    view.store.run_pipeline_sync_async()
    _settle(view)
    assert ("Linear was not read: Linear no longer accepts the login: sign in again "
            "(Settings → Pipeline → Linear login)") in view.store.pipeline_result["notices"]
    assert (row.summary(), view._linear_button.text()) == ("Not signed in", "Sign in…")
    assert "#FF3B30" in row._summary.styleSheet()


def test_cancel_kills_the_waiting_core_alone(linear, make_view, monkeypatch, tmp_path):
    """The sign-in is abandoned, its port free; a browser it started is left open."""
    opened = tmp_path / "browser.pid"
    _browser(tmp_path, monkeypatch, f"sleep 60 & echo $! > {opened}")
    view, synced = _pipeline_view(make_view, monkeypatch, pipeline_enabled=True)
    row, button = view._pipeline_login_row, view._linear_button
    port = linear["ports"][0]
    button.click()
    assert (row.summary(), button.text()) == ("Waiting for the browser…", "Cancel")
    assert _soon(lambda: opened.exists() and opened.read_text().strip())
    browser = int(opened.read_text())
    try:
        assert _soon(lambda: _listening(port))
        proc = view.store._linear_login_proc
        button.click()
        _settle(view)
        assert proc.returncode == -signal.SIGKILL
        assert (row.summary(), button.text()) == ("Not signed in", "Sign in…")
        assert synced == []
        assert not _listening(port)
        os.kill(browser, 0)
    finally:
        with contextlib.suppress(OSError):
            os.kill(browser, signal.SIGKILL)
    assert not (pipeline.pipeline_dir() / "linear-login.json").exists()


def _cores(monkeypatch) -> list:
    """The core of each sign-in, as it starts."""
    procs = []
    real = pipeline.linear_login
    monkeypatch.setattr(pipeline, "linear_login", lambda started: real(
        lambda proc: (procs.append(proc), started(proc))))
    return procs


def test_a_cancel_before_the_core_starts_kills_it_as_it_does(linear, make_view, monkeypatch,
                                                              tmp_path):
    """A double click on Sign in… lands its second on Cancel."""
    _browser(tmp_path, monkeypatch, "")
    procs = _cores(monkeypatch)
    go = threading.Event()
    real = pipeline.linear_login
    monkeypatch.setattr(pipeline, "linear_login", lambda started: go.wait(10) and real(started))
    view, synced = _pipeline_view(make_view, monkeypatch, pipeline_enabled=True)
    row, button = view._pipeline_login_row, view._linear_button
    try:
        button.click()
        button.click()
        go.set()
        _settle(view)
        assert [proc.returncode for proc in procs] == [-signal.SIGKILL]
        assert (row.summary(), button.text(), button.isEnabled()) == ("Not signed in",
                                                                      "Sign in…", True)
    finally:
        for proc in procs:
            proc.kill()


def test_quitting_kills_a_waiting_sign_in_and_any_begun_after(linear, monkeypatch, tmp_path):
    _browser(tmp_path, monkeypatch, "")
    procs = _cores(monkeypatch)
    store = Store()
    done = []

    def sign_in() -> threading.Thread:
        worker = threading.Thread(target=lambda: done.append(store.linear_login(lambda: False)),
                                  daemon=True)
        worker.start()
        return worker

    try:
        first = sign_in()
        assert _soon(lambda: _listening(linear["ports"][0]))
        store.stop_pipeline_sync()
        first.join(10)
        sign_in().join(10)
        assert [answer for answer, _ in done] == [None, None]
        assert [proc.returncode for proc in procs] == [-signal.SIGKILL] * 2
    finally:
        for proc in procs:
            proc.kill()
