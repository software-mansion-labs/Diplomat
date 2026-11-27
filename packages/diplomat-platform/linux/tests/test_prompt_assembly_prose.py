"""Prompt assembly lives only in Swift (assets/README.md), so the prose beside each
prompt model and its Linux config class must point there, never at a Python module."""

from __future__ import annotations

import importlib
import re
from pathlib import Path

import pytest

from diplomat_runtime import core

CORE = Path(__file__).resolve().parents[3] / "diplomat-core" / "Sources" / "DiplomatCore"

# Prompt asset -> (the Swift file that assembles it, the Linux module wrapping it).
PROMPTS = {
    "issues": ("Issues.swift", "diplomat_app.issues"),
    "conflicts": ("Conflict.swift", "diplomat_app.conflicts"),
    "audit": ("Audit.swift", "diplomat_app.audit"),
    "review": ("Review.swift", "diplomat_runtime.review"),
}

_FILES = re.compile(r"\w+\.(?:swift|py)\b")


@pytest.mark.parametrize("asset", sorted(PROMPTS))
def test_the_prompt_asset_comment_places_assembly_in_its_swift_builder(asset: str):
    swift, _ = PROMPTS[asset]
    assert "func buildPrompt() -> String" in (CORE / swift).read_text(encoding="utf-8")
    comment = getattr(core, asset)()["_comment"]
    assert _FILES.findall(comment) == [swift]
    assert (f"assembly order/conditions live in {swift}, reached from Linux through the "
            "diplomat-core CLI.") in comment


@pytest.mark.parametrize("asset", sorted(PROMPTS))
def test_the_linux_config_module_places_assembly_in_its_swift_builder(asset: str):
    swift, module = PROMPTS[asset]
    doc = " ".join(importlib.import_module(module).__doc__.split())
    assert _FILES.findall(doc) == [swift]
    assert (f"the *assembly* order/conditions live in Swift (DiplomatCore/{swift}) and are "
            "reached by shelling out to the ``diplomat-core`` CLI") in doc
