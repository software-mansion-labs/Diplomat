"""Settings screen — identity, what the monitors may do, and the environment
spawns land in.

The Linux analogue of SettingsView.swift, card for card and row for row. Persists
through the Store (QSettings, or the shared ``~/.diplomat/config.json`` for the
knobs another process also reads). Built once and updated in place so typing in
the handle field is never disrupted by a background data refresh.

A row is its title and its control. What a setting does is drawn only while the
header's *Explain* switch is on; the line under a row is reserved for live state -
a problem, a test result, an update in progress - so it is never boilerplate.
"""

from __future__ import annotations

import dataclasses
import os
import shutil
import time

from PySide6.QtCore import Qt, QUrl, Signal
from PySide6.QtGui import QColor, QDesktopServices, QGuiApplication
from PySide6.QtWidgets import (
    QColorDialog,
    QComboBox,
    QFileDialog,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QPushButton,
    QVBoxLayout,
    QWidget,
)

from diplomat_runtime import (
    agentstate,
    apiwatch,
    appconfig,
    autofix,
    comms,
    pipeline,
    review,
    runner,
    usagescan,
)
from diplomat_runtime.models import Fmt
from diplomat_runtime.prref import LocalRepo, root_label
from . import diplomacynetwork, glyphs
from .devicesview import AllocatorControls, allocator_pill, allocator_summary
from .store import Store, tools
from .widgets import (
    ChoiceChips,
    ElidedLabel,
    IconChip,
    Pill,
    SegmentedControl,
    SettingRow,
    SliderSetting,
    SwitchToggle,
    ToggleChip,
    muted,
    nested_settings,
    settings_card,
)

#: Card tints, mirroring the SF Symbol tints of the macOS twin.
_BLUE, _PURPLE, _TEAL = "#0A84FF", "#BF5AF2", "#40C8E0"
_ORANGE, _PINK, _INDIGO = "#FF9500", "#FF375F", "#5E5CE6"
_BROWN, _CYAN = "#AC8E68", "#32ADE6"
_GREEN, _RED, _GREY = "#34C759", "#FF3B30", "#8E8E93"


def _style_swatch(btn: QPushButton, hex_color: str) -> None:
    """The tool tint well: the colour itself, as a rounded block. A "●" glyph in the
    tint (what this was) is mostly the button's own background."""
    btn.setStyleSheet(
        f"QPushButton {{ background-color: {hex_color}; border-radius: 4px;"
        " border: 1px solid rgba(128,128,128,0.5); }"
    )


class SettingsView(QWidget):
    done = Signal()
    # The Comms "Test" answer: (identity dict or None, error text).
    _comms_tested = Signal(object, str)
    # A Linear sign-in's or sign-out's answer: (what failed, why Linear did not revoke
    # the login, linear-whoami's answer after).
    _linear_answered = Signal(str, str, object)
    # Linear's consent page, as the sign-in's core hands it over.
    _linear_page_arrived = Signal(str)

    def __init__(self, store: Store) -> None:
        super().__init__()
        self.store = store
        self._chips: dict[str, IconChip] = {}
        #: Every row that has a long-form paragraph, so the header switch can
        #: reveal them together rather than each row watching the store.
        self._rows: list[SettingRow] = []

        root = QVBoxLayout(self)
        root.setContentsMargins(0, 0, 0, 0)
        root.setSpacing(12)

        root.addLayout(self._header_row())

        # A write to the shared config the disk refused. Everything reads that file,
        # so the control has moved and the setting has not; this line says so.
        self._save_error = QLabel("")
        self._save_error.setWordWrap(True)
        self._save_error.setStyleSheet(f"color: {_RED}; font-size: 11px;")
        self._save_error.hide()
        root.addWidget(self._save_error)

        # Two columns, matching the macOS SettingsView and the main panel: who the
        # agents are and what they may do on the left; the panel, the watchers and the
        # environment on the right. Each column pushes its cards up with a bottom
        # stretch so the two stay top-aligned regardless of differing heights.
        body = QHBoxLayout()
        body.setSpacing(12)

        left = QVBoxLayout()
        left.setSpacing(10)
        left.addWidget(self._identity_card())
        left.addWidget(self._runner_card())
        left.addWidget(self._repo_card())
        left.addWidget(self._other_repos_card())
        left.addWidget(self._autofix_card())
        left.addWidget(self._limits_card())
        left.addStretch(1)

        right = QVBoxLayout()
        right.setSpacing(10)
        right.addWidget(self._tools_card())
        right.addWidget(self._terminal_card())
        right.addWidget(self._apiwatch_card())
        right.addWidget(self._comms_card())
        right.addWidget(self._pipeline_card())
        right.addWidget(self._allocator_card())
        right.addWidget(self._network_card())
        right.addWidget(self._update_card())
        right.addStretch(1)

        body.addLayout(left, 1)
        body.addLayout(right, 1)
        root.addLayout(body)
        root.addStretch(1)

        store.allocator_changed.connect(self._refresh_allocator_ui)
        store.update_changed.connect(self._refresh_update_ui)
        store.autofix_changed.connect(self._refresh_autofix_ui)
        store.apiwatch_changed.connect(self._refresh_apiwatch_ui)
        store.comms_changed.connect(self._refresh_comms_ui)
        store.network_changed.connect(self._refresh_network_ui)
        store.pipeline_changed.connect(self._refresh_pipeline_ui)
        store.pipeline_sync_applied.connect(self._on_pipeline_sync_applied)
        self._comms_tested.connect(self._on_comms_tested)
        self._linear_answered.connect(self._on_linear_answered)
        self._linear_page_arrived.connect(self._on_linear_page)
        self._refresh_allocator_ui()
        self._refresh_update_ui()
        self._refresh_autofix_ui()
        self._refresh_apiwatch_ui()
        self._apply_explain(store.settings_explain)
        store.refresh_allocator_install_async()
        store.refresh_update_status_async()

    def _save(self, write) -> bool:
        """Run one write to the shared config file and say whether it landed."""
        try:
            write()
        except OSError as exc:
            self._save_error.setText(f"⚠ Couldn't save that change "
                                     f"({exc.strerror or exc}), so it has no effect "
                                     f"— set it again once the disk has room.")
            self._save_error.show()
            return False
        self._save_error.hide()
        return True

    def _track(self, row: SettingRow) -> SettingRow:
        self._rows.append(row)
        return row

    # MARK: header

    def _header_row(self) -> QHBoxLayout:
        row = QHBoxLayout()
        title = QLabel("⚙  Settings")
        title.setStyleSheet("font-weight: 700; font-size: 13px;")
        row.addWidget(title)
        row.addStretch(1)

        # One switch for the screen, not a disclosure arrow per row: the paragraphs
        # are read together, on the visit where the automation is being set up, and
        # never again after it.
        explain_label = QLabel("Explain")
        explain_label.setStyleSheet(muted(11))
        row.addWidget(explain_label)
        self._explain = SwitchToggle()
        self._explain.setToolTip("Show what each setting does, in full")
        self._explain.setChecked(self.store.settings_explain)
        self._explain.toggled.connect(self._on_explain_toggled)
        row.addWidget(self._explain)

        done = QPushButton("Done")
        done.setStyleSheet("font-weight: 700;")
        done.clicked.connect(self.done.emit)
        row.addWidget(done)
        return row

    def _on_explain_toggled(self, on: bool) -> None:
        self.store.settings_explain = on
        self._apply_explain(on)

    def _apply_explain(self, on: bool) -> None:
        for row in self._rows:
            row.set_explain(on)

    # MARK: GitHub identity

    def _identity_card(self) -> QWidget:
        card, body, self._identity_pill = settings_card(
            glyphs.G_IDENTITY, "IDENTITY", _BLUE
        )

        field = QLineEdit(self.store.username_override)
        field.setPlaceholderText(self.store.me or "your github handle")
        field.setClearButtonEnabled(True)

        self._identity_row = self._track(SettingRow(
            "GitHub username", field, stacked=True,
            detail="Blank = whoever `gh` is authenticated as. Scopes the “My …” "
                   "tools and the Review wizard: which PRs count as mine, and whose "
                   "reviews the monitors owe. The Pipeline always goes by `gh`'s account. "
                   "In a GitLab repo root “me” is `glab`'s user on its host, which this "
                   "does not change.",
        ))
        body.addWidget(self._identity_row)

        def refresh() -> None:
            override = self.store.username_override.strip()
            effective = override or self.store.me
            self._identity_pill.set_state(
                f"@{effective}" if effective else "not signed in",
                _BLUE if override else _GREY,
            )

        def on_text(text: str) -> None:
            self.store.username_override = text
            refresh()
            self._refresh_override_me()
            self.store.changed.emit()

        field.textChanged.connect(on_text)
        refresh()
        return card

    # MARK: agent runner (which CLI the agents are)

    def _runner_card(self) -> QWidget:
        card, body, self._runner_pill = settings_card(
            glyphs.G_RUNNER, "AGENT RUNNER", _PURPLE
        )

        picker = SegmentedControl(
            [(runner.LABELS[key], key) for key in runner.RUNNERS], tint=_PURPLE
        )
        picker.set_value(self.store.agent_runner)
        picker.changed.connect(self._on_runner_changed)
        self._runner_row = self._track(SettingRow(
            "Which CLI a spawn runs", picker, stacked=True,
        ))
        body.addWidget(self._runner_row)

        # The model + provider controls, shown only for a runner that has them.
        self._runner_nest, nest = nested_settings(_PURPLE)
        model_row = QHBoxLayout()
        model_row.setSpacing(6)
        self._model_field = QLineEdit(self.store.agent_model)
        self._model_field.setClearButtonEnabled(True)
        self._model_field.textChanged.connect(
            lambda text: self._save(lambda: setattr(self.store, "agent_model", text))
        )
        model_row.addWidget(self._model_field, 1)
        providers = QPushButton("Connect a provider…")
        providers.setToolTip(
            "Open the runner's own login wizard: it knows every provider in its "
            "catalog and stores the credential itself. Diplomat never holds an API key."
        )
        providers.clicked.connect(self._open_provider_setup)
        model_row.addWidget(providers)
        holder = QWidget()
        holder.setLayout(model_row)
        nest.addWidget(holder)
        body.addWidget(self._runner_nest)

        self._refresh_runner_ui()
        return card

    def _on_runner_changed(self, key: object) -> None:
        self._save(lambda: setattr(self.store, "agent_runner", str(key)))
        self._refresh_runner_ui()

    def _refresh_runner_ui(self) -> None:
        """Show the model and provider controls only for a runner that has them, and
        warn when the CLI is not on PATH.

        A missing binary is otherwise near-silent: the window opens, the shell prints
        "command not found", the completion sentinel takes the 127 straight away, and
        the applet records a run that finished in a second without doing anything."""
        chosen = self.store.agent_runner
        label = runner.LABELS.get(chosen, chosen)
        foreign = chosen != runner.CLAUDE
        self._runner_pill.set_state(label, _PURPLE)
        self._runner_nest.setVisible(foreign)
        self._model_field.setPlaceholderText(f"model — blank lets {label} choose")
        # OpenCode's is resolved through the user's shell, as its spawns are, which may
        # name a different install than this app's PATH does.
        found = (usagescan.opencode_binary() if chosen == runner.OPENCODE
                 else shutil.which(chosen))
        if found:
            missing = ""
        elif chosen == runner.OPENCODE:
            missing = (f"Neither your login shell nor this app's PATH has an `{chosen}` "
                       f"executable — check it if spawned runs finish instantly without "
                       f"doing anything.")
        else:
            missing = (f"`{chosen}` is not on this app's PATH. Agents run under your "
                       f"login shell, so an rc-only install still works — but check it "
                       f"if spawned runs finish instantly without doing anything.")
        self._runner_row.set_summary(missing, color=_ORANGE)
        where = f"Spawns run `{chosen}` ({found}). " if found else ""
        self._runner_row.set_detail(where + (
            f"Diplomat never holds an API key: {label} stores its own credential, and "
            f"*Connect a provider* opens its login wizard, which knows every provider "
            f"in its catalog."
            if foreign else
            "SPAWN AGENT picks up whatever flags your shell alias for `claude` gives it."
        ))

    def _open_provider_setup(self) -> None:
        try:
            review.open_terminal(runner.setup_command(), self.store.terminal)
        except review.SpawnError as exc:
            self._runner_row.set_summary(f"Could not open a terminal: {exc}",
                                         color=_ORANGE)

    # MARK: repo roots (where the agents work)

    def _repo_card(self) -> QWidget:
        card, body, self._repo_pill = settings_card(glyphs.G_REPO, "REPO ROOTS", _TEAL)

        self._roots_host = QWidget()
        self._roots_list = QVBoxLayout(self._roots_host)
        self._roots_list.setContentsMargins(0, 0, 0, 0)
        self._roots_list.setSpacing(4)
        add = QPushButton("Add…")
        add.setToolTip("Pick another local checkout the monitors watch")
        add.clicked.connect(self._add_root)

        col = QWidget()
        col_layout = QVBoxLayout(col)
        col_layout.setContentsMargins(0, 0, 0, 0)
        col_layout.setSpacing(6)
        col_layout.addWidget(self._roots_host)
        col_layout.addWidget(add, 0, Qt.AlignmentFlag.AlignLeft)

        self._repo_row = self._track(SettingRow(
            "Checkouts the monitors watch and agents work in", col, stacked=True,
        ))
        body.addWidget(self._repo_row)
        self.store.local_repos_changed.connect(self._refresh_repo_ui)
        self._refresh_repo_ui()
        return card

    def _set_roots(self, paths: list[str]) -> None:
        self._save(lambda: setattr(self.store, "repo_root_paths", paths))
        self._refresh_repo_ui()

    def _add_root(self) -> None:
        chosen = QFileDialog.getExistingDirectory(
            self, "Add a repo root", os.path.dirname(review.repo_path())
        )
        # None listed stands for the default root, which the first pick joins.
        paths = self.store.repo_root_paths or [review.default_repo_path()]
        if chosen and chosen not in paths:
            self._set_roots([*paths, chosen])

    def _choose_root(self, index: int) -> None:
        paths = self.store.repo_root_paths
        chosen = QFileDialog.getExistingDirectory(
            self, "Choose the repo root", os.path.expanduser(paths[index])
        )
        if chosen:
            paths[index] = chosen
            self._set_roots(paths)

    def _remove_root(self, index: int) -> None:
        paths = self.store.repo_root_paths
        del paths[index]
        self._set_roots(paths)

    def _raise_root(self, index: int) -> None:
        paths = self.store.repo_root_paths
        paths[index - 1], paths[index] = paths[index], paths[index - 1]
        self._set_roots(paths)

    @staticmethod
    def _root_problem(path: str, root: LocalRepo | None) -> str:
        """Why a picked path is no usable root, or "" for none. A relative one gets its
        own: an "is it a checkout?" stat would be judged against THIS process's working
        directory while the spawn's ``cd`` runs in the terminal's. Mirrors
        ``RepoPaths.rootState`` in Swift."""
        where = os.path.expanduser(path)
        if not os.path.isabs(where):
            return "Not an absolute path"
        if not os.path.isdir(where):
            return "Folder not found"
        if not os.path.exists(os.path.join(where, ".git")):
            return "Not a git checkout"
        return "" if root else "No GitHub or GitLab remote, or a repo listed above"

    def _refresh_repo_ui(self) -> None:
        """One row per picked root, primary first, each named by the repo it resolved
        to or by what is wrong with it; then the pill, summary and detail from the
        primary, as the agents' `cd` sees it."""
        while self._roots_list.count():
            item = self._roots_list.takeAt(0)
            if item.widget():
                item.widget().deleteLater()
        paths = self.store.repo_root_paths
        shadowed = bool(os.environ.get("DIPLOMAT_REPO"))
        # A guessed root is a stand-in, not a resolved checkout.
        resolved = {} if review.roots_guessed() else {r.path: r for r in review.repo_roots()}
        problems = 0
        for i, path in enumerate(paths):
            root = None if shadowed else resolved.get(os.path.expanduser(path))
            problem = "" if shadowed else self._root_problem(path, root)
            problems += bool(problem)
            name = root_label(root, list(resolved.values())) if root else ""
            self._roots_list.addWidget(self._root_row(i, path, name, problem))
        self._roots_host.setVisible(bool(paths))

        primary = review.repo_path()
        owner, repo = review.repo_roots()[0].owner, review.repo_roots()[0].repo
        if shadowed:
            text = (
                "DIPLOMAT_REPO is set in this app's environment - agents run in "
                f"{primary} alone, whatever this list says. Unset it to use the list "
                "again."
            )
        elif problems:
            text = "A root above is not a checkout Diplomat can work in - fix or remove it."
        elif not os.path.exists(os.path.join(primary, ".git")):
            text = (
                f"No git checkout at {primary} - the spawn's `cd` is best-effort, so an "
                f"agent would start in your home directory instead. Add the clone of "
                f"{owner}/{repo}."
            )
        else:
            text = ""
        n = len(review.repo_roots())
        self._repo_pill.set_state("check this" if text else
                                  f"{n} root{'s' if n != 1 else ''}",
                                  _ORANGE if text else _GREEN)
        self._repo_row.set_summary(text, color=_ORANGE)
        self._repo_row.set_detail(None if text else (
            f"`cd {primary}` - the first root is the primary: where an agent starts "
            f"when its work names no repo. Every monitor watches every root; the "
            f"header's picker chooses the one the lists and wizards work on. None "
            f"picked = {review.default_repo_path()}. DIPLOMAT_REPO in this app's "
            f"environment outranks the list."
        ))

    def _root_row(self, index: int, path: str, label: str, problem: str) -> QWidget:
        row = QWidget()
        line = QHBoxLayout(row)
        line.setContentsMargins(0, 0, 0, 0)
        line.setSpacing(6)
        if problem:
            name = QLabel(f"⚠ {problem}")
            name.setStyleSheet(f"font-size: 11px; font-weight: 600; color: {_ORANGE};")
        else:
            name = QLabel(label)
            name.setStyleSheet("font-size: 11px; font-weight: 600;")
        name.setTextFormat(Qt.TextFormat.PlainText)
        line.addWidget(name)
        where = ElidedLabel(path, 10, _GREY)
        where.setToolTip(path)
        line.addWidget(where, 1)
        for glyph, tip, act, enabled in (
            ("Choose…", "Pick another checkout for this root", self._choose_root, True),
            ("↑", "Move up - the first root is the primary", self._raise_root, index > 0),
            ("✕", "Stop watching this root", self._remove_root, True),
        ):
            btn = QPushButton(glyph)
            btn.setToolTip(tip)
            btn.setAccessibleName(f"{tip.split(' - ')[0]}: {path}")
            if glyph != "Choose…":
                btn.setFixedWidth(26)
            btn.setEnabled(enabled)
            btn.clicked.connect(lambda _=False, i=index, f=act: f(i))
            line.addWidget(btn)
        return row

    # MARK: other repos

    def _other_repos_card(self) -> QWidget:
        card, body, self._other_repos_pill = settings_card(
            glyphs.G_REPO, "OTHER REPOS", _TEAL
        )

        self._other_repos_host = QWidget()
        self._other_repos_list = QVBoxLayout(self._other_repos_host)
        self._other_repos_list.setContentsMargins(0, 0, 0, 0)
        self._other_repos_list.setSpacing(4)
        add = QPushButton("Add…")
        add.setToolTip("Pick another local checkout a wizard may work in")
        add.clicked.connect(self._add_other_repo)

        col = QWidget()
        col_layout = QVBoxLayout(col)
        col_layout.setContentsMargins(0, 0, 0, 0)
        col_layout.setSpacing(6)
        col_layout.addWidget(self._other_repos_host)
        col_layout.addWidget(add, 0, Qt.AlignmentFlag.AlignLeft)

        body.addWidget(self._track(SettingRow(
            "Checkouts a pasted link may name", col, stacked=True,
            detail="The wizards accept a PR or issue link to any of these repos; "
                   "the agent works in that checkout. Each checkout answers for every "
                   "GitHub or GitLab remote it has, so a fork clone takes links to both its "
                   "upstream and its origin. A bare "
                   "#number still means the selected repo root.",
        )))
        self.store.local_repos_changed.connect(self._refresh_other_repos_ui)
        self._refresh_other_repos_ui()
        return card

    def _add_other_repo(self) -> None:
        chosen = QFileDialog.getExistingDirectory(
            self, "Choose another checkout", os.path.dirname(review.repo_path())
        )
        if chosen and chosen not in self.store.other_repo_paths:
            self.store.other_repo_paths = [*self.store.other_repo_paths, chosen]

    def _remove_other_repo(self, path: str) -> None:
        self.store.other_repo_paths = [p for p in self.store.other_repo_paths if p != path]

    def _refresh_other_repos_ui(self) -> None:
        """One row per listed checkout: the repo it is named by and its path, or a
        warning where it answers for no GitHub or GitLab repo at all."""
        while self._other_repos_list.count():
            item = self._other_repos_list.takeAt(0)
            if item.widget():
                item.widget().deleteLater()
        checkouts = self.store.local_checkouts
        unusable = 0
        for checkout in checkouts:
            row = QWidget()
            line = QHBoxLayout(row)
            line.setContentsMargins(0, 0, 0, 0)
            line.setSpacing(6)
            if checkout.slug:
                name = QLabel(checkout.slug)
                name.setStyleSheet("font-size: 11px; font-weight: 600;")
            else:
                unusable += 1
                missing = not os.path.isdir(os.path.expanduser(checkout.path))
                name = QLabel("⚠ Folder not found" if missing else "⚠ No GitHub or GitLab remote")
                name.setStyleSheet(f"font-size: 11px; font-weight: 600; color: {_ORANGE};")
            name.setTextFormat(Qt.TextFormat.PlainText)
            line.addWidget(name)
            path = ElidedLabel(checkout.path, 10, _GREY)
            path.setToolTip(checkout.path)
            line.addWidget(path, 1)
            remove = QPushButton("✕")
            remove.setToolTip("Stop accepting links to this checkout")
            remove.setAccessibleName(f"Remove {checkout.path}")
            remove.setFixedWidth(26)
            remove.clicked.connect(
                lambda _=False, p=checkout.path: self._remove_other_repo(p))
            line.addWidget(remove)
            self._other_repos_list.addWidget(row)
        self._other_repos_host.setVisible(bool(checkouts))
        if unusable:
            self._other_repos_pill.set_state("check this", _ORANGE)
        elif checkouts:
            n = len(checkouts)
            self._other_repos_pill.set_state(f"{n} repo{'s' if n != 1 else ''}", _GREEN)
        else:
            self._other_repos_pill.set_state("")

    # MARK: PR auto-fix monitor

    def _autofix_card(self) -> QWidget:
        card, body, self._autofix_pill = settings_card(
            glyphs.G_AUTO, "AUTOMATIC WORK", _ORANGE
        )

        self._sw_autofix = SwitchToggle(_ORANGE)
        self._sw_autofix.setChecked(self.store.pr_autofix_enabled)
        self._sw_autofix.toggled.connect(self._on_autofix_toggled)
        body.addWidget(self._track(SettingRow(
            "Auto-queue fixes for my PRs", self._sw_autofix,
            detail="Merge conflicts and new review threads. Off, the monitor still "
                   "lists what it finds under Agent tasks — queued, for “execute now” "
                   "only.",
        )))

        # The failing-poll line. The card's pill flags it; this names the error.
        self._autofix_poll_err = QLabel("")
        self._autofix_poll_err.setWordWrap(True)
        self._autofix_poll_err.setStyleSheet(f"color: {_RED}; font-size: 10px;")
        body.addWidget(self._autofix_poll_err)

        # Two counts that only exist once the monitor has run: how many reviews it
        # has delivered, and how many it currently owes.
        self._reviewed_pill = Pill("")
        self._sw_review_req = SwitchToggle(_ORANGE)
        self._sw_review_req.setChecked(self.store.review_requests_enabled)
        self._sw_review_req.toggled.connect(self._on_review_req_toggled)
        review_control = QWidget()
        review_row = QHBoxLayout(review_control)
        review_row.setContentsMargins(0, 0, 0, 0)
        review_row.setSpacing(6)
        review_row.addWidget(self._reviewed_pill)
        review_row.addWidget(self._sw_review_req)
        body.addWidget(self._track(SettingRow(
            "Auto-queue reviews that request me", review_control,
            detail="Inline comments — read-only, never their branch. "
                   "Re-reviews check new commits and open findings. "
                   "A review that never lands (agent died, window closed) is retried. "
                   "Off, the requests still list under Agent tasks, queued for "
                   "“execute now” only.",
        )))

        # Who an auto-review may run for, how deep it goes, and what it may submit.
        # Only the verdict rows follow the switch above, because nothing they govern
        # happens until a review runs. The author list outlives it: a switched-off monitor still polls
        # and still lists what it finds, and the list is what decides which requests
        # those are — hidden while it is off, it would be filtering rows the operator
        # has no way to reach.
        approve_nest, approve = nested_settings(_ORANGE)
        approve.addWidget(self._allowlist_row())
        approve.addWidget(self._auto_review_depth_row())
        approve.addWidget(self._auto_review_overrides_row())

        self._verdict_rows = QWidget()
        verdict_rows = QVBoxLayout(self._verdict_rows)
        verdict_rows.setContentsMargins(0, 0, 0, 0)
        verdict_rows.setSpacing(9)

        self._sw_auto_approve = SwitchToggle(_ORANGE)
        self._sw_auto_approve.setChecked(self.store.auto_approve_enabled)
        self._sw_auto_approve.toggled.connect(self._on_auto_approve_toggled)
        verdict_rows.addWidget(self._track(SettingRow(
            "May approve / request changes", self._sw_auto_approve,
            detail="Off ⇒ inline comments only; the verdict stays with you. On ⇒ a "
                   "clean review may submit a verdict, except on the classes withheld "
                   "below.",
        )))
        verdict_rows.addWidget(self._verdict_block())

        self._sw_soft_approve = SwitchToggle(_ORANGE)
        self._sw_soft_approve.setChecked(self.store.soft_approve_enabled)
        self._sw_soft_approve.toggled.connect(self._on_soft_approve_toggled)
        verdict_rows.addWidget(self._track(SettingRow(
            "Soft-approve clean PRs", self._sw_soft_approve,
            detail="One “ran the sweep, all clean” COMMENT review — never an APPROVE. "
                   "Off ⇒ a review that finds nothing says nothing. Independent of "
                   "the verdict switch above.",
        )))
        approve.addWidget(self._verdict_rows)
        body.addWidget(approve_nest)

        self._sw_community = SwitchToggle(_ORANGE)
        self._sw_community.setChecked(self.store.community_issues_enabled)
        self._sw_community.toggled.connect(self._on_community_toggled)
        body.addWidget(self._track(SettingRow(
            "Fix new community issues", self._sw_community,
            detail="Reproduce each issue filed from outside the org, and fix it if it "
                   "reproduces. Issues filed from the moment it is on; the backlog is a "
                   "Fix-issues sweep's. Each is a cancellable fix under Agent tasks. Off, "
                   "nothing is queued, and issues filed meanwhile are left for a sweep.",
        )))
        return card

    @staticmethod
    def _depth_detail(depth_id: str) -> str:
        depth = review.depth_by_id(depth_id)
        return f"{depth['title']} — {depth['blurb']}"

    @staticmethod
    def _depth_options() -> list[tuple[str, str]]:
        return [(d["id"].capitalize(), d["id"]) for d in review.depths()]

    def _auto_review_depth_row(self) -> SettingRow:
        picker = self._auto_review_depth = SegmentedControl(self._depth_options(), tint=_ORANGE)
        picker.set_value(self.store.auto_review_default_depth)
        row = self._depth_setting_row = self._track(SettingRow(
            "Review depth", picker, stacked=True,
            detail=self._depth_detail(self.store.auto_review_default_depth),
        ))

        def on_changed(depth_id: object) -> None:
            self.store.auto_review_default_depth = str(depth_id)
            row.set_detail(self._depth_detail(str(depth_id)))

        picker.changed.connect(on_changed)
        return row

    def _auto_review_overrides_row(self) -> SettingRow:
        holder = QWidget()
        col = QVBoxLayout(holder)
        col.setContentsMargins(0, 0, 0, 0)
        col.setSpacing(6)
        table = QWidget()
        self._overrides_layout = QVBoxLayout(table)
        self._overrides_layout.setContentsMargins(0, 0, 0, 0)
        self._overrides_layout.setSpacing(6)
        col.addWidget(table)
        buttons = QHBoxLayout()
        buttons.setSpacing(12)
        self._override_add = QPushButton("+  Add author")
        self._override_add.clicked.connect(lambda: self._add_override(""))
        self._override_add_me = QPushButton("+  Add me")
        self._override_add_me.clicked.connect(lambda: self._add_override(None))
        for button in (self._override_add, self._override_add_me):
            button.setFlat(True)
            buttons.addWidget(button)
        buttons.addStretch(1)
        col.addLayout(buttons)
        self._override_me_label: QLabel | None = None
        self._rebuild_override_rows()
        return self._track(SettingRow(
            "Per-author depth", holder, stacked=True,
            detail="Overrides the depth above for these authors' PRs; the first row "
                   "naming one wins.",
        ))

    def _set_override(self, i: int, **change: str) -> None:
        rows = self.store.auto_review_overrides
        rows[i] = dataclasses.replace(rows[i], **change)
        self.store.auto_review_overrides = rows

    def _add_override(self, login: str | None) -> None:
        self.store.auto_review_overrides = [*self.store.auto_review_overrides,
                                            autofix.AutoReviewOverride(login, "max")]
        self._rebuild_override_rows()

    def _remove_override(self, i: int) -> None:
        rows = self.store.auto_review_overrides
        del rows[i]
        self.store.auto_review_overrides = rows
        self._rebuild_override_rows()

    def _rebuild_override_rows(self) -> None:
        """One line per table row, all rebuilt on an add or a remove: rows are addressed
        by index, as nothing else tells two rows naming one login apart."""
        while (item := self._overrides_layout.takeAt(0)) is not None:
            if item.widget() is not None:
                item.widget().deleteLater()
        self._override_me_label = None
        rows = self.store.auto_review_overrides
        self._override_add_me.setVisible(all(row.login is not None for row in rows))
        for i, row in enumerate(rows):
            line = QWidget()
            h = QHBoxLayout(line)
            h.setContentsMargins(0, 0, 0, 0)
            h.setSpacing(6)
            if row.login is None:
                self._override_me_label = QLabel(self._me_label_text())
                h.addWidget(self._override_me_label, 1)
            else:
                field = QLineEdit(row.login)
                field.setPlaceholderText("login")
                field.textChanged.connect(lambda text, i=i: self._set_override(i, login=text))
                h.addWidget(field, 1)
            depth = QComboBox()
            depth.setAccessibleName("Depth for this author")
            for label, depth_id in self._depth_options():
                depth.addItem(label, depth_id)
            depth.setCurrentIndex(depth.findData(row.depth))
            depth.currentIndexChanged.connect(
                lambda _, i=i, box=depth: self._set_override(i, depth=box.currentData()))
            h.addWidget(depth)
            remove = QPushButton("✕")
            remove.setFlat(True)
            remove.setToolTip("Remove this row")
            remove.clicked.connect(lambda _=False, i=i: self._remove_override(i))
            h.addWidget(remove)
            self._overrides_layout.addWidget(line)

    def _me_label_text(self) -> str:
        me = self.store.effective_me
        return f"me (@{me})" if me else "me"

    def _refresh_override_me(self) -> None:
        if self._override_me_label is not None:
            self._override_me_label.setText(self._me_label_text())

    def _allowlist_row(self) -> QWidget:
        """Which authors the review monitor may act on at all.

        Free text rather than a chip per login: the list is edited far more rarely
        than it is read, and what is typed is what is stored
        (``Store.review_allowlist_raw``), so a half-finished handle is never
        reformatted mid-keystroke."""
        field = QLineEdit(self.store.review_allowlist_raw)
        field.setPlaceholderText("anyone")
        field.setClearButtonEnabled(True)

        self._allowlist_setting_row = self._track(SettingRow(
            "Only these authors", field, stacked=True,
            detail="Blank = anyone who requests my review. Commas or spaces between "
                   "logins; a leading @ is fine. Unlike the switch above, an excluded "
                   "request is dropped rather than queued — no agent and no row — and "
                   "the Review wizard still reviews anyone. The ban list wins over this.",
        ))

        def on_text(text: str) -> None:
            self.store.review_allowlist_raw = text
            self.store.changed.emit()

        field.textChanged.connect(on_text)
        return self._allowlist_setting_row

    def _verdict_block(self) -> QWidget:
        """The three suppressors for an auto-review's final verdict, as chips: a PR
        matching any lit chip gets comments only."""
        self._verdict_container = QWidget()
        col = QVBoxLayout(self._verdict_container)
        col.setContentsMargins(0, 0, 0, 0)
        col.setSpacing(5)
        caption = QLabel("WITHHOLD IT WHEN THE PR TOUCHES…")
        caption.setStyleSheet(
            "color: palette(mid); font-size: 9px; font-weight: 700;"
            " letter-spacing: 0.5px;"
        )
        col.addWidget(caption)

        chips = QHBoxLayout()
        chips.setSpacing(5)
        for label, which, tip in (
            ("a SKILL", "skill", "Comments only on a PR that edits a SKILL"),
            ("the installer", "installer", "Comments only on a PR that edits the installer"),
            ("community", "community",
             "Comments only on a PR whose author is outside the org"),
        ):
            chip = ToggleChip(label, tint=_ORANGE)
            chip.setToolTip(tip)
            chip.setChecked(getattr(self.store, f"verdict_withhold_{which}"))
            chip.toggled.connect(
                lambda on, w=which: self._set_verdict(w, on)
            )
            chips.addWidget(chip)
        chips.addStretch(1)
        col.addLayout(chips)
        return self._verdict_container

    # MARK: limits (the cap, and the budget it is spent against)

    def _limits_card(self) -> QWidget:
        """How much automatic work this machine may run, and whether it can afford
        it. Its own card, beside the monitors rather than under them: both rows
        bound *every* automatic agent, whichever monitor started it."""
        card, body, self._limits_pill = settings_card(glyphs.G_LIMITS, "LIMITS", _ORANGE)

        self._auto_limit = SliderSetting(
            label="Run at most",
            minimum=autofix.MIN_AUTO_TASK_LIMIT,
            maximum=autofix.MAX_AUTO_TASK_LIMIT,
            min_label=str(autofix.MIN_AUTO_TASK_LIMIT),
            max_label=str(autofix.MAX_AUTO_TASK_LIMIT),
            tint=_ORANGE,
        )
        self._auto_limit.set_badge_text(
            lambda n: f"{n} task" + ("" if n == 1 else "s")
        )
        self._auto_limit.set_value(self.store.auto_task_limit)
        self._auto_limit.changed.connect(self._on_auto_limit_changed)
        body.addWidget(self._track(SettingRow(
            "Run at most", self._auto_limit, stacked=True,
            detail="Across every monitor and a PR sweep's reviews. The agent a wizard "
                   "press opens on the spot is "
                   "outside the cap; a review it queues instead is inside. Work over "
                   "the cap waits in "
                   "Agent tasks, in the order you put it, and starts when a bay frees "
                   "— unless you switch off Auto-execute queue there.",
        )))

        self._sw_budget = SwitchToggle(_ORANGE)
        self._sw_budget.setChecked(appconfig.auto_budget_gate())
        self._sw_budget.toggled.connect(self._on_budget_gate_toggled)
        body.addWidget(self._track(SettingRow(
            "Hold work when the limit runs low", self._sw_budget,
            detail="Wait for a window to refill rather than start what won't fit. "
                   "Priced from Telemetry → limit per task: against the 7-day rate-limit "
                   "window under Claude Code, or — under a runner billed in money — "
                   "against what one task costs on the model it runs, and what your "
                   "OpenRouter key and credit balance have left. Higher confidence is "
                   "stricter. Held work waits in Agent tasks, and “execute now” "
                   "overrides it. Nothing is held while the probe can't read a limit.",
        )))

        self._budget_knobs, knobs = nested_settings(_ORANGE)
        self._budget_confidence = SegmentedControl(
            [(f"{level}%", level) for level in sorted(autofix.BUDGET_CONFIDENCE_Z)],
            tint=_ORANGE,
        )
        self._budget_confidence.set_value(appconfig.auto_budget_confidence())
        self._budget_confidence.changed.connect(self._on_budget_confidence_changed)
        knobs.addWidget(self._track(SettingRow(
            "Start one only when it fits", self._budget_confidence, stacked=True,
        )))

        self._budget_floor = SliderSetting(
            label="Keep in hand until it can be priced",
            minimum=0, maximum=100, step=5,
            min_label="spend it all", max_label="spend nothing", tint=_ORANGE,
        )
        self._budget_floor.set_badge_text(lambda pct: f"{pct:.1f}%")
        self._budget_floor.set_value(round(appconfig.auto_budget_floor_pct()))
        self._budget_floor.changed.connect(self._on_budget_floor_changed)
        knobs.addWidget(self._track(SettingRow(
            "Keep in hand until it can be priced", self._budget_floor, stacked=True,
            detail="Of the 7-day rate-limit window, under Claude Code.",
        )))

        # The same knob in the other currency. Both are shown whichever runner is
        # selected: the setting outlives the choice of runner, and a knob that
        # appeared and disappeared as that changed would look like it had been reset.
        self._budget_reserve = SliderSetting(
            label="Keep on the account until it can be priced",
            minimum=0, maximum=int(autofix.MAX_BUDGET_RESERVE_USD), step=5,
            min_label="spend it all", max_label="spend nothing", tint=_ORANGE,
        )
        self._budget_reserve.set_badge_text(lambda usd: f"${usd:.2f}")
        self._budget_reserve.set_value(round(appconfig.auto_budget_reserve_usd()))
        self._budget_reserve.changed.connect(self._on_budget_reserve_changed)
        knobs.addWidget(self._track(SettingRow(
            "Keep on the account until it can be priced", self._budget_reserve,
            stacked=True,
            detail="Of your OpenRouter balance, under a runner billed in money.",
        )))
        body.addWidget(self._budget_knobs)
        self._budget_knobs.setVisible(self._sw_budget.isChecked())
        self._refresh_limits_pill()
        return card

    def _refresh_limits_pill(self) -> None:
        self._limits_pill.set_state(f"≤ {self.store.auto_task_limit} at a time", _GREY)

    def _on_auto_limit_changed(self, value: int) -> None:
        self._save(lambda: setattr(self.store, "auto_task_limit", value))
        self._refresh_limits_pill()
        self.store.changed.emit()

    def _on_budget_gate_toggled(self, on: bool) -> None:
        self._save(lambda: appconfig.set_bool(appconfig.AUTO_BUDGET_GATE, on))
        self._budget_knobs.setVisible(on)
        self.store.changed.emit()

    def _on_budget_confidence_changed(self, level: object) -> None:
        self._save(lambda: appconfig.set_int(appconfig.AUTO_BUDGET_CONFIDENCE, int(level)))
        self.store.changed.emit()

    def _on_budget_floor_changed(self, value: int) -> None:
        self._save(lambda: appconfig.set_float(appconfig.AUTO_BUDGET_FLOOR_PCT, float(value)))
        self.store.changed.emit()

    def _on_budget_reserve_changed(self, value: int) -> None:
        self._save(lambda: appconfig.set_float(appconfig.AUTO_BUDGET_RESERVE_USD,
                                               float(value)))
        self.store.changed.emit()

    def _on_autofix_toggled(self, on: bool) -> None:
        self.store.pr_autofix_enabled = on
        self.store.changed.emit()
        # This monitor's queued rows say whether it is switched off, so they are
        # stale the moment it is; an immediate poll would only redraw them 3 minutes
        # later, and only if it succeeded.
        self.store.tasks_changed.emit()
        self._refresh_autofix_ui()
        if on:
            self.store.run_autofix_poll_async()

    def _on_review_req_toggled(self, on: bool) -> None:
        self.store.review_requests_enabled = on
        self.store.changed.emit()
        self.store.tasks_changed.emit()
        self._refresh_autofix_ui()
        if on:
            self.store.run_autofix_poll_async()

    def _on_community_toggled(self, on: bool) -> None:
        self.store.community_issues_enabled = on
        self.store.changed.emit()
        self._refresh_autofix_ui()
        if on:
            self.store.run_autofix_poll_async()

    def _on_auto_approve_toggled(self, on: bool) -> None:
        self.store.auto_approve_enabled = on
        self.store.changed.emit()
        self._refresh_autofix_ui()

    def _on_soft_approve_toggled(self, on: bool) -> None:
        self.store.soft_approve_enabled = on
        self.store.changed.emit()

    def _set_verdict(self, which: str, on: bool) -> None:
        setattr(self.store, f"verdict_withhold_{which}", on)
        self.store.changed.emit()

    def _refresh_autofix_ui(self) -> None:
        """The monitors' own health on the card's pill, so it is answered before any
        row is read. A failing poll used to be invisible: the switches said "on", the
        counts froze stale, and nothing dispatched. Also the depth table's me row, whose
        login a poll may be the first to resolve."""
        self._refresh_override_me()
        autofix_on = self.store.pr_autofix_enabled
        review_on = self.store.review_requests_enabled
        err = self.store.autofix_poll_error
        st = self.store.autofix_status
        live = bool(st) and (time.time() - st.get("updatedAt", 0)) < 15 * 60

        if not (autofix_on or review_on or self.store.community_issues_enabled):
            self._autofix_pill.set_state("manual", _GREY)
        elif err:
            self._autofix_pill.set_state("polls failing", _RED)
        elif live:
            n = st.get("watching", 0)
            self._autofix_pill.set_state(
                f"watching {n} PR" + ("" if n == 1 else "s"), _GREEN
            )
        else:
            self._autofix_pill.set_state("no monitor yet", _ORANGE)

        self._autofix_poll_err.setVisible(bool(err) and autofix_on)
        if err:
            self._autofix_poll_err.setText(f"⚠ Polls failing — {err}")

        owed = self.store.unaddressed_reviews
        handled = self.store.review_requests_handled
        if review_on and owed > 0:
            self._reviewed_pill.set_state(f"↻ {owed} owed", _ORANGE)
            self._reviewed_pill.setToolTip(
                f"{owed} unaddressed review" + ("" if owed == 1 else "s")
                + " — the reconciler is retrying"
            )
        elif handled:
            self._reviewed_pill.set_state(f"{handled} done", _GREY)
            self._reviewed_pill.setToolTip("Reviews delivered so far")
        else:
            self._reviewed_pill.set_state("")

        self._verdict_rows.setVisible(review_on)
        self._verdict_container.setVisible(review_on and self.store.auto_approve_enabled)

    # MARK: Claude API-error watcher

    def _apiwatch_card(self) -> QWidget:
        card, body, self._apiwatch_pill = settings_card(
            glyphs.G_STALLED, "STALLED AGENTS", _PINK
        )
        self._sw_apiwatch = SwitchToggle(_PINK)
        self._sw_apiwatch.setChecked(self.store.api_watch_enabled)
        self._sw_apiwatch.toggled.connect(self._on_apiwatch_toggled)
        self._apiwatch_row = self._track(SettingRow(
            "Auto-continue on API errors", self._sw_apiwatch,
            detail="A 529 stops an agent dead; this types it back into motion. "
                   "Watches the tmux panes an agent is running in and types “"
                   + apiwatch.CONTINUE_MESSAGE
                   + "” when a Claude API error shows up. A pane with nobody's agent in "
                   "it is left alone whatever it shows — the nudge is submitted as a "
                   "line of input, which in a plain shell would run as a command. "
                   "Out-of-quota stalls (“You've hit your weekly limit”) are left alone "
                   "too — nudging can't help until the limit resets. Run your agents "
                   "inside tmux for this to reach them. Claude Code runs only: the banners it matches are Claude "
                   "Code's. An OpenCode or Hermes agent that hits an error reads as "
                   "idle instead, frees its task-cap slot, and is dispatched again by "
                   "whichever monitor owed the work.",
        ))
        body.addWidget(self._apiwatch_row)

        # Beside the nudge because they are the two answers to one question. The nudge
        # gets a stalled agent moving again; this is what happens when nothing does.
        cutoff = apiwatch.human_interval(agentstate.RUN_DEADLINE)
        self._sw_deadline = SwitchToggle(_PINK)
        self._sw_deadline.setChecked(appconfig.run_deadline() is not None)
        self._sw_deadline.toggled.connect(self._on_run_deadline_toggled)
        body.addWidget(self._track(SettingRow(
            f"Give up on a task after {cutoff}", self._sw_deadline,
            detail="Close the window and hand the bay back, even if the agent still "
                   "looks busy. Agents report their turn boundaries through hooks "
                   "staged into each run, and a run whose report never comes — a "
                   "runner without hooks, "
                   "settings that would not stage, an agent wedged with its status bar "
                   "frozen — holds a task-cap bay until you close its window. This is "
                   "the backstop under all of them, and it reads a clock rather than "
                   f"the run: past {cutoff} an automatic task this device is still "
                   "showing as working is called done anyway. Its tmux "
                   "session is killed and its row leaves Agent tasks, and killing it is "
                   "what frees the bay — an agent left alive is found by the scan on "
                   "the next pass and takes it straight back. Only while a spending "
                   "limit both reads and has room left: agents parked waiting for a "
                   "window to refill age exactly like stuck ones, and a machine with no "
                   "limit it can read leaves the backstop off. A run already back at "
                   "its prompt has given its bay back and is left alone, and so are an "
                   "agent you started by hand and one the scan found rather than this "
                   "applet dispatching it.",
        )))
        return card

    def _on_run_deadline_toggled(self, on: bool) -> None:
        self._save(lambda: appconfig.set_bool(appconfig.RUN_DEADLINE, on))
        self.store.changed.emit()

    def _on_apiwatch_toggled(self, on: bool) -> None:
        self.store.api_watch_enabled = on
        self.store.changed.emit()
        self._refresh_apiwatch_ui()
        if on:
            self.store.run_apiwatch_poll_async()  # kick a scan immediately

    def _refresh_apiwatch_ui(self) -> None:
        count = self.store.api_watch_continues
        if not self.store.api_watch_enabled:
            # Two switches under one pill, so grey means neither is doing anything:
            # the deadline alone still retires runs and closes their windows.
            if appconfig.run_deadline() is not None:
                self._apiwatch_pill.set_state("deadline only", _GREEN)
            else:
                self._apiwatch_pill.set_state(
                    f"{count} continued" if count else "off", _GREY
                )
            return
        st = self.store.apiwatch_status
        live = bool(st) and (time.time() - st.get("updatedAt", 0)) < 15 * 60
        if st is not None and not st.get("tmux", True):
            self._apiwatch_pill.set_state("tmux not found", _ORANGE)
            self._apiwatch_row.set_summary(
                "This watcher drives tmux panes; install tmux and run agents inside it.",
                color=_ORANGE,
            )
            return
        self._apiwatch_row.set_summary("")
        if live:
            n = st.get("watching", 0)
            self._apiwatch_pill.set_state(
                f"watching {n} pane" + ("" if n == 1 else "s"), _GREEN
            )
        else:
            self._apiwatch_pill.set_state(
                f"{count} continued" if count else "no scan yet", _ORANGE
            )

    # MARK: Comms, the Slack watcher

    def _comms_card(self) -> QWidget:
        card, body, self._comms_pill = settings_card(glyphs.G_COMMS, "COMMS", _BLUE)
        st = self.store

        self._sw_comms = SwitchToggle(_BLUE)
        self._sw_comms.setChecked(st.comms_enabled)
        self._sw_comms.toggled.connect(self._on_comms_toggled)
        self._comms_row = self._track(SettingRow(
            "Watch Slack", self._sw_comms,
            detail="DMs, @-mentions and keywords become pings; asks become queued "
                   "work. Every minute, searches your Slack for new DMs to you, @-mentions of "
                   "you and your keywords. Each one is a ping (the ✉ screen, the "
                   "activity feed, a notification), and is triaged by one model call "
                   "with no tools and no MCP servers, which only answers what it asks "
                   "for. A review or issue fix in a repo root, a nudge to hurry one, or a "
                   "reported problem to investigate is then queued like any other ask: "
                   "the ban list, the task cap and the spending budget all still "
                   "apply. Your own messages, bots and people from other workspaces "
                   "are never pings.",
        ))
        body.addWidget(self._comms_row)

        # Like the verdict rows: nothing below acts until the watcher runs.
        self._comms_options = QWidget()
        options = QVBoxLayout(self._comms_options)
        options.setContentsMargins(0, 0, 0, 0)
        options.setSpacing(10)
        body.addWidget(self._comms_options)

        def text_row(title: str, value: str, placeholder: str, setter, detail: str):
            field = QLineEdit(value)
            field.setPlaceholderText(placeholder)
            field.setClearButtonEnabled(True)
            field.textChanged.connect(setter)
            options.addWidget(self._track(SettingRow(title, field, stacked=True,
                                                     detail=detail)))
            return field

        self._comms_keywords = text_row(
            "Keywords", st.comms_keywords_raw, "deploy, release train, argent*",
            lambda t: setattr(self.store, "comms_keywords_raw", t),
            "Commas or new lines between them, so one can be a phrase. Matched as a "
            "whole word, ignoring case; a * ending a word matches any letters after it "
            "(argent*), and Slack expands no * anywhere else. "
            "A DM or an @-mention needs none.")
        self._comms_allow = text_row(
            "Only these senders", st.comms_sender_allowlist_raw, "anyone in your workspace",
            lambda t: setattr(self.store, "comms_sender_allowlist_raw", t),
            "Slack user ids or handles, commas or spaces between them; a leading @ is "
            "fine. Blank = any member of your workspace.")

        nest, inner = nested_settings(_BLUE)
        self._sw_comms_requests = self._comms_switch(
            inner, "Queue asked-for reviews and fixes", st.comms_act_requests,
            "comms_act_requests",
            "“Can you review #12?” queues that review at the front of the requested "
            "reviews, as the Review wizard would run it; an issue fix likewise. Only an "
            "open PR or issue in a repo root.")
        self._sw_comms_bumps = self._comms_switch(
            inner, "Bump queued work", st.comms_act_bumps, "comms_act_bumps",
            "“Any news on #12?” moves whatever is already queued for #12 to the front "
            "of its band. Starts nothing new.")
        self._sw_comms_investigate = self._comms_switch(
            inner, "Investigate reported problems", st.comms_act_investigations,
            "comms_act_investigations",
            "A reported bug with no PR or issue number queues an agent that reproduces "
            "and researches it and writes a report, which the ✉ screen opens. It never "
            "pushes, opens PRs or issues, comments, or posts to Slack.")
        _, sizes, _, intervals = comms.batch_defaults()
        self._comms_batch = self._comms_stops(
            inner, "Batch size", sizes, st.comms_batch_size, "comms_batch_size", str,
            "How many pings one triage call reads. A full batch is triaged at once.")
        self._comms_interval = self._comms_stops(
            inner, "Batch interval", intervals, st.comms_flush_after_secs,
            "comms_flush_after_secs", Fmt.duration,
            "How old the newest ping of a shorter batch gets before it is triaged anyway.")
        self._sw_comms_notify = self._comms_switch(
            inner, "Notify on new pings", st.comms_notify, "comms_notify",
            "A tray notification per new ping.")
        options.addWidget(nest)

        self._comms_model = text_row(
            "Triage model", st.comms_model, "haiku",
            lambda t: setattr(self.store, "comms_model", t),
            "The model each ping is triaged with. Cheap is right: the answer is one "
            "word and a number.")

        self._comms_test = QPushButton("Test")
        self._comms_test.setToolTip("Ask Slack who Claude Code's Slack login is")
        self._comms_test.clicked.connect(self._test_comms_login)
        self._comms_login_row = self._track(SettingRow(
            "Slack login", self._comms_test,
            detail="Comms borrows the login Claude Code already holds for Slack's MCP "
                   "server, so there is no Slack app or token to set up here. To sign "
                   "in, run /mcp in Claude Code and authenticate the Slack server. "
                   "DIPLOMAT_SLACK_TOKEN in the environment wins over it.",
        ))
        options.addWidget(self._comms_login_row)
        # Its own line rather than the row's summary, which every poll rewrites.
        self._comms_test_status = QLabel("")
        self._comms_test_status.setTextFormat(Qt.TextFormat.PlainText)
        self._comms_test_status.setWordWrap(True)
        self._comms_test_status.hide()
        options.addWidget(self._comms_test_status)
        self._refresh_comms_ui()
        return card

    def _comms_switch(self, layout, title: str, on: bool, attr: str,
                      detail: str) -> SwitchToggle:
        sw = SwitchToggle(_BLUE)
        sw.setChecked(on)
        sw.toggled.connect(lambda v: setattr(self.store, attr, v))
        layout.addWidget(self._track(SettingRow(title, sw, detail=detail)))
        return sw

    def _comms_stops(self, layout, title: str, stops: list[int], value: int, attr: str,
                     fmt, detail: str) -> SliderSetting:
        """A slider whose position is an index into ``stops``."""
        slider = SliderSetting(
            label=title, minimum=0, maximum=len(stops) - 1, step=1,
            min_label=fmt(stops[0]), max_label=fmt(stops[-1]), tint=_BLUE,
        )
        slider.set_badge_text(lambda i: fmt(stops[i]))
        slider.set_value(comms.slider_stop(value, stops))
        slider.changed.connect(lambda i: setattr(self.store, attr, stops[i]))
        layout.addWidget(self._track(SettingRow(title, slider, stacked=True, detail=detail)))
        return slider

    def _on_comms_toggled(self, on: bool) -> None:
        self.store.comms_enabled = on
        self.store.comms_changed.emit()
        if on:
            self.store.run_comms_poll_async()

    def _test_comms_login(self) -> None:
        self._comms_test.setEnabled(False)
        self._set_comms_test_status("Asking Slack…", _GREY)

        def ask() -> None:
            # Always answer: the answer is what re-enables the button.
            try:
                answer = comms.auth()
            except Exception as exc:  # noqa: BLE001
                answer = (None, str(exc) or type(exc).__name__)
            self._comms_tested.emit(*answer)

        self.store.start_background(ask, name="comms-test")

    def _on_comms_tested(self, me: object, error: str) -> None:
        self._comms_test.setEnabled(True)
        if isinstance(me, dict):
            self._set_comms_test_status(
                f"✓ @{me.get('handle', '')} in {me.get('team') or me.get('teamID', '')}",
                _GREEN)
        else:
            self._set_comms_test_status(f"✗ {error}", _RED)

    def _set_comms_test_status(self, text: str, color: str) -> None:
        self._comms_test_status.setText(text)
        self._comms_test_status.setStyleSheet(f"color: {color}; font-size: 10px;")
        self._comms_test_status.show()

    def _refresh_comms_ui(self) -> None:
        st = self.store
        if not st.comms_enabled:
            self._comms_pill.set_state("off", _GREY)
        elif st.comms_error:
            self._comms_pill.set_state(st.comms_snippet(st.comms_error, 48), _RED)
        else:
            handle = (st.comms_identity or {}).get("handle")
            self._comms_pill.set_state(f"watching @{handle}" if handle else "watching",
                                       _GREEN)
        self._comms_row.set_summary(
            st.comms_error if st.comms_enabled and st.comms_error else "", color=_RED)
        self._comms_options.setVisible(st.comms_enabled)
        self._comms_login_row.set_summary(
            f"${comms.TOKEN_ENV}, which wins over Claude Code's login"
            if os.environ.get(comms.TOKEN_ENV) else "")

    # MARK: the Pipeline

    def _pipeline_card(self) -> QWidget:
        card, body, self._pipeline_pill = settings_card(glyphs.G_PIPELINE, "PIPELINE", _INDIGO)
        st = self.store

        self._sw_pipeline = SwitchToggle(_INDIGO)
        self._sw_pipeline.setChecked(st.pipeline_enabled)
        self._sw_pipeline.toggled.connect(self._on_pipeline_toggled)
        self._pipeline_row = self._track(SettingRow(
            "Run the pipeline", self._sw_pipeline,
            detail="Reads every open issue and PR and draws them on the Pipeline screen "
                   "by stage; what it may do about them is the switches under this one, "
                   "and with all of them off it only reads, but for Rate now, Fracture and "
                   "taking diplomat:fractured off an issue whose split filed nothing. Its "
                   "state is the trackers' labels: risk:, complexity: and diplomat:. "
                   "Diplomat writes labels, opens child issues or merges only on an issue "
                   "unassigned or assigned to you, or your own PR from the repo itself into "
                   "its default branch; everything else is read and shown. GitLab roots are "
                   "not read. The agent work it asks for waits in the queue like any other, "
                   "for the task cap, the ban list and the spending budget; while this is "
                   "off it reads nothing and that work waits.",
        ))
        body.addWidget(self._pipeline_row)

        self._pipeline_options = QWidget()
        options = QVBoxLayout(self._pipeline_options)
        options.setContentsMargins(0, 0, 0, 0)
        options.setSpacing(10)
        body.addWidget(self._pipeline_options)

        nest, inner = nested_settings(_INDIGO)
        self._sw_pipeline_rate = self._pipeline_switch(
            inner, "Rate issues and PRs", st.pipeline_rate, "pipeline_rate",
            "Risk and complexity, by claude, as labels where Diplomat may write",
            "A few unrated items a sync, each rated low, medium or high for risk and "
            "complexity by one claude call with read-only tools in its repo's checkout "
            "and the item's text as data. A rating is labelled where Diplomat may write; "
            "any other issue's rating is kept on this machine only, and someone else's "
            "PR is not rated. A rating already on the tracker is the rating, raised by a "
            "higher one kept here until its labels are written; a PR's diff can only raise "
            "one.")
        self._sw_pipeline_fix = self._pipeline_switch(
            inner, "Open fix PRs", st.pipeline_fix, "pipeline_fix",
            "Queues an agent that fixes each low-risk, low-complexity issue",
            "Only an issue unassigned or assigned to you that no open PR fixes, in its "
            "repo root; a Linear issue is fixed in the root its team names below.")
        self._sw_pipeline_fast = self._pipeline_switch(
            inner, "Fast-track my PRs", st.pipeline_fast_track, "pipeline_fast_track",
            "Labels diplomat:fast-track each low/low PR of yours that closes a candidate "
            "issue, and reviews it until clean",
            "Only your own PRs from the repo itself into its default branch that close only "
            "candidate issues: the fixes the pipeline asks for. Reviews of it are queued "
            "until one finds nothing at its head; at that clean head it is rated again: "
            "still low/low, it is labelled diplomat:cleared, else it leaves the fast track. "
            "A PR rated while this is off stays a person's.")
        self._sw_pipeline_merge = self._pipeline_switch(
            inner, "Merge cleared PRs", st.pipeline_merge, "pipeline_merge",
            "Merges past the review requirement with admin rights (gh pr merge --admin): "
            "no person approves the PR first",
            "A cleared PR is merged only when none of the holds in docs/pipeline.md "
            "applies to it, checked again right before the merge. Admin rights skip "
            "branch protection's approval requirement, so leave this off where a second "
            "pair of eyes is required.")
        self._sw_pipeline_fracture = self._pipeline_switch(
            inner, "Split big issues", st.pipeline_fracture, "pipeline_fracture",
            "One medium- or high-complexity issue a sync becomes low-complexity child issues",
            "Only an issue Diplomat may write to, not rated high risk, with no children "
            "and no open PR fixing it. Each child is a real sub-issue and comes back "
            "unrated; the parent is labelled diplomat:fractured. Fracture on the Pipeline "
            "screen splits one whatever its rating.")
        options.addWidget(nest)

        self._pipeline_teams = QLineEdit(st.pipeline_linear_teams_raw)
        self._pipeline_teams.setPlaceholderText("ENG=owner/repo, OPS=owner/other")
        self._pipeline_teams.setClearButtonEnabled(True)
        self._pipeline_teams.textChanged.connect(self._on_pipeline_teams_changed)
        self._pipeline_teams_row = self._track(SettingRow(
            "Linear teams", self._pipeline_teams, stacked=True,
            detail="Each Linear team key and the GitHub repo root its issues are fixed "
                   "in, commas, semicolons or new lines between them. A key is read in "
                   "capitals, as Linear spells it."))
        options.addWidget(self._pipeline_teams_row)
        self._linear_copy = QPushButton("Copy link")
        self._linear_copy.clicked.connect(
            lambda: QGuiApplication.clipboard().setText(self._linear_page[0]))
        self._linear_button = QPushButton()
        self._linear_button.clicked.connect(self._on_linear_button)
        login_control = QWidget()
        login_row = QHBoxLayout(login_control)
        login_row.setContentsMargins(0, 0, 0, 0)
        login_row.setSpacing(6)
        login_row.addWidget(self._linear_copy)
        login_row.addWidget(self._linear_button)
        self._pipeline_login_row = self._track(SettingRow(
            "Linear login", login_control,
            detail="Signs in through the browser to Diplomat's Linear app, which reads the "
                   "tracked teams' issues and writes labels and child issues as you. The "
                   "login is kept in ~/.diplomat/pipeline/linear-login.json, readable by "
                   "you alone, refreshed by the sync, and never handed to an agent: a fix "
                   "gets the issue's text as Diplomat read it. Sign out forgets it and asks "
                   f"Linear to revoke it. ${pipeline.TOKEN_ENV}, a personal API key, wins "
                   "over it. Without a login, the teams set here are skipped with a notice "
                   "and GitHub still syncs, but no PR is merged."))
        options.addWidget(self._pipeline_login_row)
        # linear-whoami's last answer; the last action's failure or warning (text, colour);
        # the sign-in's consent page and whether it opened.
        self._linear_me = pipeline.linear_whoami()
        self._linear_note: tuple[str, str] | None = None
        self._linear_page: tuple[str, bool] | None = None
        self._linear_signing_in = self._linear_cancelled = False
        self._refresh_pipeline_ui()
        return card

    def _pipeline_switch(self, layout, title: str, on: bool, attr: str, summary: str,
                         detail: str) -> SwitchToggle:
        sw = SwitchToggle(_INDIGO)
        sw.setChecked(on)
        sw.toggled.connect(lambda v: self._on_pipeline_option(attr, v))
        layout.addWidget(self._track(SettingRow(title, sw, summary=summary, detail=detail)))
        return sw

    def _on_pipeline_toggled(self, on: bool) -> None:
        self.store.pipeline_enabled = on
        self.store.pipeline_changed.emit()
        # Its queued rows show whether it is paused.
        self.store.tasks_changed.emit()
        if on:
            self.store.run_pipeline_sync_async()

    def _on_pipeline_option(self, attr: str, on: bool) -> None:
        """A switch turned on acts at once, not a sync period later."""
        setattr(self.store, attr, on)
        if on:
            self.store.run_pipeline_sync_async()

    def _on_pipeline_teams_changed(self, text: str) -> None:
        self.store.pipeline_linear_teams_raw = text
        self._refresh_pipeline_teams_summary()
        self._refresh_linear_login()

    def _refresh_pipeline_teams_summary(self) -> None:
        teams, bad = pipeline.parse_linear_teams(self.store.pipeline_linear_teams_raw)
        if bad:
            self._pipeline_teams_row.set_summary(
                f"Not KEY=owner/repo, so not tracked: {', '.join(bad)}", color=_RED)
        elif not teams:
            self._pipeline_teams_row.set_summary("None: GitHub only")
        else:
            self._pipeline_teams_row.set_summary(
                " · ".join(f"{t['key']} → {t['repo']}" for t in teams))

    def _on_linear_button(self) -> None:
        """Sign in…, Cancel or Sign out, as the button reads."""
        if self._linear_signing_in:
            self._linear_cancelled = True
            self._linear_button.setEnabled(False)
            self._refresh_linear_login()
            self.store.stop_linear_login()
            return
        signing_in = self._linear_me is None
        self._linear_signing_in = signing_in
        self._linear_note = None
        # Live as Cancel; a sign-out cannot be cancelled.
        self._linear_button.setEnabled(signing_in)
        self._refresh_linear_login()

        def ask() -> None:
            # Always answer: the answer is what re-enables the button.
            error = warning = ""
            try:
                if signing_in:
                    error = self.store.linear_login(lambda: self._linear_cancelled,
                                                    self._linear_page_arrived.emit)[1]
                else:
                    ok, text = pipeline.linear_logout()
                    error, warning = ("", text) if ok else (text, "")
            except Exception as exc:  # noqa: BLE001
                error = str(exc) or type(exc).__name__
            self._linear_answered.emit(error, warning, pipeline.linear_whoami())

        self.store.start_background(ask, name="linear-login" if signing_in else "linear-logout")

    def _on_linear_page(self, url: str) -> None:
        # A Cancel can land before the page does.
        if not self._linear_cancelled:
            self._linear_page = (url, QDesktopServices.openUrl(QUrl(url)))
            self._refresh_linear_login()

    def _on_linear_answered(self, error: str, warning: str, me: object) -> None:
        me = me if isinstance(me, dict) else None
        # Saved is what counts: a core killed after saving answers an error.
        signed_in = self._linear_signing_in and me is not None
        if self._linear_cancelled:
            error = ""
        self._linear_signing_in = self._linear_cancelled = False
        self._linear_page = None
        self._linear_me = me
        self._linear_note = ((error, _RED) if error
                             else (f"Signed out, but {warning}", _ORANGE) if warning
                             else None)
        self._linear_button.setEnabled(True)
        self._refresh_linear_login()
        if signed_in:
            self.store.run_pipeline_sync_async()

    def _on_pipeline_sync_applied(self) -> None:
        # A sync forgets a login it can no longer refresh. An action under way
        # reads it once answered.
        if not self._linear_signing_in and self._linear_button.isEnabled():
            self._linear_me = pipeline.linear_whoami()
            self._refresh_linear_login()

    def _refresh_linear_login(self) -> None:
        me, row, page = self._linear_me, self._pipeline_login_row, self._linear_page
        self._linear_button.setText("Cancel" if self._linear_signing_in
                                    else "Sign in…" if me is None else "Sign out")
        self._linear_copy.setVisible(self._linear_signing_in)
        self._linear_copy.setEnabled(page is not None and not self._linear_cancelled)
        if self._linear_signing_in:
            row.set_summary("Waiting for the browser…" if page is None or page[1]
                            else "No browser opened: Copy link and paste it into one")
        elif self._linear_note:
            row.set_summary(self._linear_note[0], color=self._linear_note[1])
        elif os.environ.get(pipeline.TOKEN_ENV):
            row.set_summary(f"${pipeline.TOKEN_ENV}, which wins over the login")
        elif me is not None:
            row.set_summary(f"Signed in as {me['user']} ({me['organization']})")
        else:
            # A problem only once a team needs it.
            teams, _ = pipeline.parse_linear_teams(self.store.pipeline_linear_teams_raw)
            row.set_summary("Not signed in", color=_RED if teams else None)

    def _refresh_pipeline_ui(self) -> None:
        st = self.store
        if not st.pipeline_enabled:
            self._pipeline_pill.set_state("off", _GREY)
        elif st.pipeline_error:
            self._pipeline_pill.set_state(st.comms_snippet(st.pipeline_error, 48), _RED)
        elif st.pipeline_syncing:
            self._pipeline_pill.set_state("syncing", _INDIGO)
        elif st.pipeline_result is None:
            self._pipeline_pill.set_state("no sync yet", _GREY)
        else:
            n = len(st.pipeline_result.get("items") or [])
            self._pipeline_pill.set_state(f"{n} item{'' if n == 1 else 's'}", _GREEN)
        if st.pipeline_enabled and st.pipeline_error:
            self._pipeline_row.set_summary(st.pipeline_error, color=_RED)
        else:
            self._pipeline_row.set_summary(
                f"Every {Fmt.duration(pipeline.sync_secs())}, the open issues and PRs of "
                "the GitHub repo roots and the Linear teams below")
        self._pipeline_options.setVisible(st.pipeline_enabled)
        self._refresh_pipeline_teams_summary()
        self._refresh_linear_login()

    # MARK: tool colour & visibility

    def _tools_card(self) -> QWidget:
        card, body, self._tools_pill = settings_card(glyphs.G_TOOLS, "TOOLS", _INDIGO)
        rows = QWidget()
        col = QVBoxLayout(rows)
        col.setContentsMargins(0, 0, 0, 0)
        col.setSpacing(5)
        self._tool_rows: dict[str, QWidget] = {}
        for tool in tools():
            col.addWidget(self._tool_row(tool.id, tool.title, tool.subtitle, tool.glyph))
        body.addWidget(self._track(SettingRow(
            "Cards in the panel grid", rows, stacked=True,
            detail="The tint colours the card and every result row under it. Hiding "
                   "the selected tool selects the first one still shown.",
        )))
        self._refresh_tools_pill()
        return card

    def _refresh_tools_pill(self) -> None:
        total = len(tools())
        shown = sum(1 for t in tools() if t.id not in self.store.hidden_tools)
        self._tools_pill.set_state(f"{shown} of {total} shown", _GREY)

    def _tool_row(self, tool_id: str, title: str, subtitle: str, glyph: str) -> QWidget:
        """One tool. The whole row dims while it is hidden, so which cards the grid
        will actually draw reads off the column without checking six switches."""
        host = QWidget()
        row = QHBoxLayout(host)
        row.setContentsMargins(6, 4, 6, 4)
        row.setSpacing(8)
        chip = IconChip(glyph, self.store.tint(tool_id), size=22)
        self._chips[tool_id] = chip
        row.addWidget(chip)

        text = QVBoxLayout()
        text.setSpacing(1)
        t = QLabel(title)
        t.setStyleSheet("font-weight: 600; font-size: 11px;")
        s = QLabel(subtitle)
        s.setStyleSheet(muted(9))
        text.addWidget(t)
        text.addWidget(s)
        row.addLayout(text, 1)

        color_btn = QPushButton()
        color_btn.setFixedSize(34, 16)
        color_btn.setCursor(Qt.CursorShape.PointingHandCursor)
        color_btn.setToolTip(f"Tint for {title}")
        _style_swatch(color_btn, self.store.tint(tool_id))
        color_btn.clicked.connect(lambda: self._pick_color(tool_id, color_btn))
        row.addWidget(color_btn)

        toggle = SwitchToggle(self.store.tint(tool_id))
        toggle.setChecked(tool_id not in self.store.hidden_tools)
        toggle.setToolTip(f"Show {title} in the grid")
        toggle.toggled.connect(lambda on, tid=tool_id: self._on_tool_toggled(tid, on))
        row.addWidget(toggle)

        self._tool_rows[tool_id] = host
        self._style_tool_row(tool_id)
        return host

    def _on_tool_toggled(self, tool_id: str, on: bool) -> None:
        self.store.set_tool(tool_id, on)
        self._style_tool_row(tool_id)
        self._refresh_tools_pill()

    def _style_tool_row(self, tool_id: str) -> None:
        visible = tool_id not in self.store.hidden_tools
        host = self._tool_rows[tool_id]
        host.setStyleSheet(
            "background-color: rgba(128,128,128,0.07); border-radius: 7px;"
            if visible else "background-color: transparent;"
        )
        # Qt has no view-wide opacity in a stylesheet; the chip carries the "off"
        # rendering it already has for the panel's hidden tools.
        self._chips[tool_id].set_active(visible)

    def _pick_color(self, tool_id: str, btn: QPushButton) -> None:
        initial = QColor(self.store.tint(tool_id))
        chosen = QColorDialog.getColor(initial, self, f"Tint for {tool_id}")
        if chosen.isValid():
            hex_color = chosen.name(QColor.NameFormat.HexRgb).upper()
            self.store.set_tint(hex_color, tool_id)
            _style_swatch(btn, hex_color)
            chip = self._chips.get(tool_id)
            if chip:
                chip.set_tint(hex_color)

    # MARK: terminal

    def _terminal_card(self) -> QWidget:
        card, body, pill = settings_card(glyphs.G_TERMINAL, "SPAWN TERMINAL", _BROWN)
        # Chips rather than a segmented row: Linux knows seven terminals, and which
        # of them are actually on this machine is the whole question — a dropdown
        # hides six of the answers behind a click.
        picker = ChoiceChips(
            [(term.title, term.key) for term in review.TERMINALS],
            columns=3, tint=_BROWN,
        )
        for term in review.TERMINALS:
            chip = picker.chip(term.key)
            if chip is not None and not term.is_installed:
                chip.setToolTip("Not installed — spawns fall back to the first that is")
                chip.setEnabled(False)
        picker.set_value(self.store.terminal_choice)
        picker.changed.connect(self._on_terminal_changed)
        self._terminal_pill = pill
        self._terminal_row = self._track(SettingRow(
            "Window SPAWN AGENT opens", picker, stacked=True,
        ))
        body.addWidget(self._terminal_row)
        self._refresh_terminal_ui()
        return card

    def _on_terminal_changed(self, key: object) -> None:
        self.store.terminal_choice = str(key)
        self._refresh_terminal_ui()

    def _refresh_terminal_ui(self) -> None:
        resolved = review.resolved(self.store.terminal)
        self._terminal_pill.set_state(resolved.title, _GREY)
        self._terminal_row.set_detail(
            f"Runs the agent runner with the review prompt in {resolved.title}. A "
            "greyed chip is a terminal this machine does not have. The spawn resolves "
            "to the first installed one, and to xterm if none of them is."
        )

    # MARK: device allocator (MCP server + skill + rule)

    def _allocator_card(self) -> QWidget:
        card, body, self._alloc_pill = settings_card(
            glyphs.G_DEVICES, "DEVICE ALLOCATOR", _CYAN
        )
        self._alloc_controls = AllocatorControls(self.store)
        self._alloc_row = self._track(SettingRow(
            "Reserve a simulator before using it", self._alloc_controls, stacked=True,
        ))
        # Untinted is the ready allocator's line, which is boilerplate.
        summary, tint = allocator_summary()
        if tint is None:
            self._alloc_row.set_detail(
                f"{summary} Installs an MCP server, a skill and an always-on rule. "
                "Reclaims a device when its agent dies or it sits idle past the limits "
                "on the Devices screen.")
        else:
            self._alloc_row.set_summary(summary, color=tint)
        body.addWidget(self._alloc_row)
        return card

    def _refresh_allocator_ui(self) -> None:
        s = self.store.allocator_install
        self._alloc_pill.set_state(*allocator_pill(s))
        self._alloc_controls.refresh(s)

    # MARK: the Diplomacy Network

    def _network_card(self) -> QWidget:
        card, body, self._network_pill = settings_card(
            glyphs.G_NETWORK, "DIPLOMACY NETWORK", _TEAL)
        self._sw_network = SwitchToggle(_TEAL)
        self._sw_network.toggled.connect(self._on_network_toggled)
        self._network_row = self._track(SettingRow(
            diplomacynetwork.SWITCH_TITLE, self._sw_network,
            detail=f"{diplomacynetwork.EXPLANATION} While it is on, no agent starts "
                   "in a terminal on this machine. The pools and the hours a job may "
                   "take are on the Network screen.",
        ))
        body.addWidget(self._network_row)
        self._refresh_network_ui()
        return card

    def _refresh_network_ui(self) -> None:
        on = self.store.network_enabled
        self._sw_network.setChecked(on)
        self._network_pill.set_state("on" if on else "off", _GREEN if on else _GREY)

    def _on_network_toggled(self, on: bool) -> None:
        # _refresh_network_ui's setChecked lands here too, as no change to make.
        if on != self.store.network_enabled:
            self._save(lambda: self.store.set_network_enabled(on))
        self._refresh_network_ui()

    # MARK: applet update

    def _update_card(self) -> QWidget:
        card, body, self._update_pill = settings_card(glyphs.G_UPDATE, "UPDATE", _BLUE)
        btn_row = QWidget()
        row = QHBoxLayout(btn_row)
        row.setContentsMargins(0, 0, 0, 0)
        row.setSpacing(8)
        self._update_btn = QPushButton("Update")
        self._update_btn.setStyleSheet("font-weight: 700;")
        self._update_btn.setEnabled(False)
        self._update_btn.clicked.connect(self.store.update_applet_async)
        row.addWidget(self._update_btn)
        recheck = QPushButton("⟲")
        recheck.setFixedWidth(34)
        recheck.setToolTip("Re-check for updates")
        recheck.clicked.connect(self.store.refresh_update_status_async)
        row.addWidget(recheck)
        row.addStretch(1)

        self._update_row = self._track(SettingRow(
            "This applet", btn_row, stacked=True,
            summary="comparing with origin…",
            detail="Pulls the latest applet from GitHub, rebuilds the diplomat-core "
                   "prompt engine, and relaunches the app in place.",
        ))
        body.addWidget(self._update_row)
        return card

    def _refresh_update_ui(self) -> None:
        s = self.store.update_state or {"phase": "checking"}
        phase = s.get("phase")

        if phase == "checking":
            self._update_pill.set_state("checking…", _GREY)
            self._update_row.set_summary("comparing with origin…")
            self._update_btn.setEnabled(False)
        elif phase == "updating":
            self._update_pill.set_state("updating…", _ORANGE)
            self._update_row.set_summary(s.get("step") or "")
            self._update_btn.setEnabled(False)
        elif phase == "restarting":
            self._update_pill.set_state("restarting…", _GREEN)
            self._update_row.set_summary(
                f"relaunched at {s.get('commit')} — this instance is handing over"
            )
            self._update_btn.setEnabled(False)
        elif phase == "error":
            self._update_pill.set_state("update failed", _RED)
            self._update_row.set_summary(s.get("error") or "unknown error", color=_RED)
            self._update_btn.setEnabled(True)
        elif s.get("error"):
            self._update_pill.set_state("check failed", _ORANGE)
            self._update_row.set_summary(s["error"], color=_ORANGE)
            self._update_btn.setEnabled(True)
        else:
            behind = s.get("behind") or 0
            ahead = s.get("ahead") or 0
            if behind:
                self._update_pill.set_state(f"{behind} behind", _BLUE)
            else:
                self._update_pill.set_state("up to date", _GREEN)
            # Nothing when the pill's "up to date" already says it all.
            detail = ""
            if ahead or behind:
                detail = (f"{s.get('commit')} on {s.get('branch')} · upstream "
                          f"{s.get('upstream')}")
            if ahead:
                # A diverged checkout still updates — via a merge, not a discard.
                detail += f" · {ahead} local ahead" + (" (will merge)" if behind else "")
            self._update_row.set_summary(detail)
            self._update_btn.setEnabled(True)
