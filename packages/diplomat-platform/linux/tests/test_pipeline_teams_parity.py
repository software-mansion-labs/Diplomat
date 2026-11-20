"""Cross-platform parity for the Pipeline's Linear teams setting.

``PipelineSettings.LinearTeam.parse`` (diplomat-core/Sources/DiplomatCore/Pipeline.swift)
reads the Settings line on macOS, :func:`pipeline.parse_linear_teams` on Linux: which teams
a sync tracks, and which entries Settings reports it cannot read. Each fixture line goes
through both, the Swift one through ``diplomat-core pipeline-teams``.
"""

from __future__ import annotations

import json
import os
import subprocess

import pytest

from diplomat_runtime import pipeline

CORE_BIN = os.environ.get("DIPLOMAT_CORE_BIN")

pytestmark = pytest.mark.skipif(
    not CORE_BIN, reason="DIPLOMAT_CORE_BIN not set (build it with packages/diplomat-platform/linux/install/build-core.sh)"
)

LINES = [
    # The core smoke's line: case, spacing, every separator, a repeat, every bad shape.
    " eng=o/r ,\r\nOPS = o/other.js;ENG=o/elsewhere; nope ,= o/r, A=b,\tB-2=o/r,C=o/r/x, D=ö/r",
    "",
    " ,; \n",
    "eng = o/r",
    "ENG=o/r\r\nOPS=o/x\r\n",
    # Unicode spacing is not trimmed, and a non-ASCII letter is no key or repo letter.
    " ENG=o/r",
    "ENG=o/r ",
    "ENG=o/r　",
    "Ä=o/r",
    "x=o/ñ",
    "ENG=ｏ/r",
    "ENG١=o/r",
    # A tab or a vertical tab or form feed around the parts, none inside them.
    "\v\fENG\t=\to/r\f",
    "E NG=o/r",
    "ENG=o /r",
    "ENG=o/r/",
    "ENG=/r",
    "ENG=o/",
    "ENG==o/r",
    "=",
    "ENG",
    "Eng=Acme-Corp/my_repo.v2, eng=o/r",
]


def _core(raw: str) -> tuple[list[dict], list[str]]:
    proc = subprocess.run([CORE_BIN, "pipeline-teams"], input=json.dumps({"raw": raw}),
                          capture_output=True, text=True, timeout=30, check=True)
    out = json.loads(proc.stdout)
    return out["teams"], out["bad"]


@pytest.mark.parametrize("raw", LINES)
def test_both_platforms_read_the_linear_teams_line_alike(raw):
    assert pipeline.parse_linear_teams(raw) == _core(raw)


def test_the_fixture_reaches_every_outcome():
    """A fixture both sides read as nothing would pin nothing."""
    read = [pipeline.parse_linear_teams(raw) for raw in LINES]
    assert any(teams for teams, _ in read) and any(bad for _, bad in read)
    assert pipeline.parse_linear_teams(LINES[0]) == (
        [{"key": "ENG", "repo": "o/r"}, {"key": "OPS", "repo": "o/other.js"}],
        ["nope", "= o/r", "A=b", "B-2=o/r", "C=o/r/x", "D=ö/r"])
