"""The shared config survives a corrupt file on disk.

``~/.diplomat/config.json`` is best-effort: a file that will not parse means "no
settings", and the guard that has to hold that up is easy to write *almost* right.
``(OSError, json.JSONDecodeError)`` looks exhaustive but does not cover the
``UnicodeDecodeError`` that ``Path.read_text`` raises on non-UTF-8 bytes, and under
that guard a single corrupt byte raises out of every spawn.
"""

from __future__ import annotations

import pytest

import json

from diplomat_runtime import appconfig

# The ways a state file goes bad in the field: a truncated write, a hand-edit
# that left the wrong shape, and bytes that aren't UTF-8 at all (a partially
# overwritten file, a bad disk block, a half-flushed rename).
CORRUPT_BODIES = [
    pytest.param(b'{"addr": "10.0.0.1\xff"}', id="non-utf8-bytes"),
    pytest.param(b'{"truncated": ', id="truncated-json"),
    pytest.param(b"[1, 2, 3]", id="json-array-not-object"),
    pytest.param(b'"just a string"', id="json-scalar-not-object"),
    pytest.param(b"", id="empty-file"),
    pytest.param(b"\x00\x00\x00\x00", id="nul-bytes"),
]


@pytest.mark.parametrize("body", CORRUPT_BODIES)
def test_app_config_falls_back_to_defaults(tmp_path, monkeypatch, body):
    cfg = tmp_path / "config.json"
    cfg.write_bytes(body)
    monkeypatch.setenv("DIPLOMAT_CONFIG", str(cfg))
    assert appconfig.read() == {}
    assert appconfig.get("repoRoot", "fallback") == "fallback"


@pytest.mark.parametrize("body", CORRUPT_BODIES)
@pytest.mark.parametrize("write", [
    lambda: appconfig.set_value("runner", "opencode"),
    lambda: appconfig.set_list("otherRepos", ["/w/b"]),
    lambda: appconfig.set_dict("machineExclusions", {"a": 1}),
    lambda: appconfig.set_repo_roots(["/w/other"]),
    lambda: appconfig.set_int("autoTaskLimit", 3),
    lambda: appconfig.set_bool("networkEnabled", False),
    lambda: appconfig.set_float("autoBudgetFloorPct", 12.5),
], ids=["value", "list", "dict", "roots", "int", "bool", "float"])
def test_no_setting_is_written_over_a_config_that_cannot_be_read(body, write):
    """A write would leave the one key it set: the repo roots and the network switch
    the file held are gone, and nothing says so."""
    appconfig.path().parent.mkdir(parents=True, exist_ok=True)
    appconfig.path().write_bytes(body)
    assert appconfig.read_known() is None
    with pytest.raises(OSError) as refused:
        write()
    assert refused.value.strerror == "the settings file cannot be read, and is not written over"
    assert appconfig.path().read_bytes() == body
    assert appconfig.unreadable_note() == (
        f"{appconfig.path()} cannot be read as settings: nothing is saved over it, and the "
        "Diplomacy Network switch stays as it was last read")


def test_a_config_that_was_there_and_is_gone_is_unknown_and_still_written():
    """An editor that saves by renaming a new file into place, as vim and nvim do on
    Linux, leaves none for a moment: neither the defaults nor the switch off."""
    appconfig.path().parent.mkdir(parents=True, exist_ok=True)
    appconfig.path().unlink(missing_ok=True)
    assert appconfig.read_known() == {}, "never there: the defaults"
    appconfig.path().write_text('{"networkEnabled": true}', encoding="utf-8")
    assert appconfig.read_known() == {"networkEnabled": True}
    counted = appconfig.unreadable_reads()
    appconfig.path().rename(appconfig.path().with_name("config.json~"))
    assert appconfig.read_known() is None and appconfig.unreadable_reads() == counted + 1
    assert appconfig.read() == {}
    appconfig.set_int("autoTaskLimit", 3)
    assert appconfig.read_known() == {"autoTaskLimit": 3}, "a setting saved writes it anew"


@pytest.mark.parametrize("named, known", [(True, None), (False, {})])
def test_a_config_the_switch_record_names_was_there(named, known):
    """A Diplomat started inside such a save has read no config yet: the switch record,
    written as the config was read, tells it one was there."""
    where = appconfig.path()
    where.parent.mkdir(parents=True, exist_ok=True)
    where.unlink(missing_ok=True)
    where.with_name(appconfig.SWITCH_RECORD).write_text(json.dumps(
        {"config": str(where) if named else "/elsewhere/config.json",
         "networkEnabled": True}), encoding="utf-8")
    assert appconfig.read_known() == known


def test_a_config_that_is_not_there_or_reads_is_written():
    appconfig.path().unlink(missing_ok=True)
    assert appconfig.read_known() == {}
    appconfig.set_int("autoTaskLimit", 3)
    appconfig.set_bool("networkEnabled", True)
    assert appconfig.read_known() == {"autoTaskLimit": 3, "networkEnabled": True}
    assert json.loads(appconfig.path().read_text(encoding="utf-8")) == appconfig.read()
