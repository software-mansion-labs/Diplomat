"""The Linear login through the built ``diplomat-core`` CLI, never a reimplementation of
it: the runtime's calls and the Settings row against a fake Linear on loopback, whose
consent page ``curl`` fetches, following its redirect back as a browser would. The core
reads a copy of the assets whose ``linearOAuth`` names the fake.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import shutil
import signal
import socket
import stat
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qsl, urlencode, urlsplit

import pytest
from test_settings_view import _pipeline_view, app, make_view  # noqa: F401 — fixtures

from diplomat_app import settingsview
from diplomat_app.store import Store
from diplomat_runtime import core, pipeline, review
from diplomat_runtime.prref import LocalRepo

pytest.importorskip("PySide6")
from PySide6.QtGui import QGuiApplication  # noqa: E402
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
    #: How long the code's exchange takes, and an event set as it begins.
    exchange_secs = 0.0
    exchanging = threading.Event()

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
            _Linear.exchanging.set()
            time.sleep(_Linear.exchange_secs)
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


@pytest.fixture
def linear(tmp_path, monkeypatch):
    """The fake Linear and the core's assets naming it. Yields the ``linearOAuth`` the
    core reads."""
    _Linear.seen, _Linear.expires_in, _Linear.revoke_status = [], 86400, 200
    _Linear.exchange_secs, _Linear.exchanging = 0.0, threading.Event()
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
    yield model["linearOAuth"]
    server.shutdown()
    server.server_close()


@pytest.fixture
def visit():
    """Follows a consent page to the core's callback, as a browser would."""
    curls = []
    yield lambda url: curls.append(subprocess.Popen(["curl", "-sL", "-o", "/dev/null", url]))
    for proc in curls:
        proc.kill()
        proc.wait()


def _browser(monkeypatch, opens: bool = True, then=None) -> list[str]:
    """``QDesktopServices.openUrl`` as settingsview reaches it, answering ``opens`` and
    handing ``then`` the page. Returns the pages it was asked to open."""
    asked = []

    def open_url(url) -> bool:
        asked.append(bytes(url.toEncoded()).decode())
        if then is not None:
            then(asked[-1])
        return opens

    monkeypatch.setattr(settingsview.QDesktopServices, "openUrl", open_url)
    return asked


def _cores(monkeypatch) -> tuple[list, list, list]:
    """The core of each sign-in as it starts, the pages they hand over, and their answers."""
    procs, pages, answers = [], [], []
    real = pipeline.linear_login

    def login(started, page):
        answers.append(real(lambda proc: (procs.append(proc), started(proc)),
                            lambda url: (pages.append(url), page(url))))
        return answers[-1]

    monkeypatch.setattr(pipeline, "linear_login", login)
    return procs, pages, answers


def _soon(probe, secs: float = 20):
    deadline = time.monotonic() + secs
    while not (found := probe()) and time.monotonic() < deadline:
        time.sleep(0.05)
    return found


def _shown(probe, secs: float = 20):
    """``_soon``, with the signals the row is waiting on landing meanwhile."""
    return _soon(lambda: (QApplication.processEvents(), probe())[1], secs)


def _settle(view) -> None:
    assert _shown(lambda: view.store.wait_for_background(0.05) == [], 60)
    QApplication.processEvents()


def test_a_sign_in_saves_the_login_and_a_sign_out_forgets_and_revokes_it(linear, visit):
    assert pipeline.linear_whoami() is None
    pages = []
    assert pipeline.linear_login(page=lambda url: (pages.append(url), visit(url))) == (ME, "")
    assert pipeline.linear_whoami() == ME
    saved = pipeline.pipeline_dir() / "linear-login.json"
    assert stat.S_IMODE(saved.stat().st_mode) == 0o600
    assert [endpoint for endpoint, _ in _Linear.seen] == ["authorize", "token", "graphql"]
    page, exchange, viewer = (fields for _, fields in _Linear.seen)
    assert pages[0].startswith(f"{linear['authorize']}?")
    assert [dict(parse_qsl(urlsplit(url).query)) for url in pages] == [page]
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


def test_the_settings_row_signs_in_and_out_through_the_core(linear, make_view, monkeypatch,
                                                            visit):
    asked = _browser(monkeypatch, then=visit)
    _, pages, _ = _cores(monkeypatch)
    view, synced = _pipeline_view(make_view, monkeypatch, pipeline_enabled=True)
    row, button = view._pipeline_login_row, view._linear_button
    assert (row.summary(), button.text()) == ("Not signed in", "Sign in…")
    button.click()
    _settle(view)
    assert (row.summary(), button.text()) == ("Signed in as Ada Lovelace (Ours)", "Sign out")
    assert len(pages) == 1 and asked == pages
    # A switch turned on syncs at once; so does a sign-in.
    assert synced == [True]

    _Linear.revoke_status = 500
    button.click()
    _settle(view)
    assert (row.summary(), button.text()) == (
        "Signed out, but Linear answered HTTP 500 to the revocation", "Sign in…")
    assert pipeline.linear_whoami() is None
    assert synced == [True]


def test_a_page_no_browser_opened_is_copied_and_still_signs_in(linear, make_view,
                                                               monkeypatch, visit):
    asked = _browser(monkeypatch, opens=False)
    _, pages, _ = _cores(monkeypatch)
    view, synced = _pipeline_view(make_view, monkeypatch, pipeline_enabled=True)
    row, button, copy = view._pipeline_login_row, view._linear_button, view._linear_copy
    button.click()
    assert _shown(copy.isEnabled)
    assert len(pages) == 1 and asked == pages
    assert (row.summary(), button.text(), copy.isVisibleTo(view)) == (
        "No browser opened: Copy link and paste it into one", "Cancel", True)
    QGuiApplication.clipboard().clear()
    copy.click()
    assert QGuiApplication.clipboard().text() == pages[0]
    visit(QGuiApplication.clipboard().text())
    _settle(view)
    assert (row.summary(), button.text(), copy.isVisibleTo(view)) == (
        "Signed in as Ada Lovelace (Ours)", "Sign out", False)
    assert synced == [True]


def test_a_login_the_sync_forgets_is_signed_out_on_the_row(linear, make_view, monkeypatch,
                                                           visit):
    """Linear refusing its refresh for good."""
    _Linear.expires_in = 60
    assert pipeline.linear_login(page=visit) == (ME, "")
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


def test_cancel_ends_the_wait_for_the_browser(linear, make_view, monkeypatch):
    """The core answers that it was cancelled and exits, its port free."""
    _browser(monkeypatch)
    procs, _, answers = _cores(monkeypatch)
    view, synced = _pipeline_view(make_view, monkeypatch, pipeline_enabled=True)
    row, button, copy = view._pipeline_login_row, view._linear_button, view._linear_copy
    port = linear["ports"][0]
    button.click()
    assert (row.summary(), button.text()) == ("Waiting for the browser…", "Cancel")
    assert _shown(copy.isEnabled)
    assert _listening(port)
    button.click()
    assert not button.isEnabled() and not copy.isEnabled()
    began = time.monotonic()
    _settle(view)
    assert time.monotonic() - began < 5
    assert answers == [(None, "Linear sign-in was cancelled")]
    assert [proc.returncode for proc in procs] == [0]
    assert (row.summary(), button.text(), button.isEnabled(), copy.isVisibleTo(view)) == (
        "Not signed in", "Sign in…", True, False)
    assert synced == []
    assert not _listening(port)
    assert not (pipeline.pipeline_dir() / "linear-login.json").exists()


def test_a_cancel_once_the_browser_is_back_still_signs_in(linear, make_view, monkeypatch,
                                                          visit):
    """The code's exchange is finished and its login saved, never a grant left on Linear
    that nothing saved; the sync follows."""
    _Linear.exchange_secs = 2
    _browser(monkeypatch, then=visit)
    procs, _, answers = _cores(monkeypatch)
    view, synced = _pipeline_view(make_view, monkeypatch, pipeline_enabled=True)
    row, button = view._pipeline_login_row, view._linear_button
    button.click()
    assert _shown(_Linear.exchanging.is_set)
    button.click()
    _settle(view)
    assert answers == [(ME, "")]
    assert [proc.returncode for proc in procs] == [0]
    assert (row.summary(), button.text()) == ("Signed in as Ada Lovelace (Ours)", "Sign out")
    assert synced == [True]
    assert pipeline.linear_whoami() == ME


def test_a_cancel_before_the_core_starts_cancels_it_as_it_does(linear, make_view,
                                                               monkeypatch):
    """A double click on Sign in… lands its second on Cancel."""
    asked = _browser(monkeypatch)
    procs, _, _ = _cores(monkeypatch)
    go = threading.Event()
    real = pipeline.linear_login
    monkeypatch.setattr(pipeline, "linear_login",
                        lambda started, page: go.wait(10) and real(started, page))
    view, synced = _pipeline_view(make_view, monkeypatch, pipeline_enabled=True)
    row, button = view._pipeline_login_row, view._linear_button
    try:
        button.click()
        button.click()
        go.set()
        _settle(view)
        # SIGTERM before the core handles it, or after.
        assert [proc.returncode for proc in procs] in ([-signal.SIGTERM], [0])
        assert asked == []
        assert (row.summary(), button.text(), button.isEnabled()) == ("Not signed in",
                                                                      "Sign in…", True)
    finally:
        for proc in procs:
            proc.kill()


def test_quitting_cancels_a_waiting_sign_in_and_any_begun_after(linear, monkeypatch):
    procs, _, _ = _cores(monkeypatch)
    store = Store()
    done = []

    def sign_in() -> threading.Thread:
        worker = threading.Thread(target=lambda: done.append(
            store.linear_login(lambda: False, lambda url: None)), daemon=True)
        worker.start()
        return worker

    try:
        first = sign_in()
        assert _soon(lambda: _listening(linear["ports"][0]))
        store.stop_pipeline_sync()
        first.join(10)
        sign_in().join(10)
        assert done[0] == (None, "Linear sign-in was cancelled")
        assert done[1][0] is None
        assert procs[0].returncode == 0
        assert procs[1].returncode in (-signal.SIGTERM, 0)
    finally:
        for proc in procs:
            proc.kill()
