"""Capabilities matrix + AdapterEvent contract tests.

Locks the three capability tiers (regular / coordinator / leaf) and the
adapter-event shapes they imply downstream of ``build_payload``. None of
these touch a DB.
"""
from __future__ import annotations

from app.services.pipeline.bot.capabilities import Capabilities


def test_regular_caps_can_call_bot_no_msg_type() -> None:
    caps = Capabilities.regular()
    assert caps.can_call_bot is True
    assert caps.include_msg_type is False


def test_coordinator_caps_full_including_msg_type() -> None:
    caps = Capabilities.coordinator()
    assert caps.can_call_bot is True
    assert caps.include_msg_type is True


def test_leaf_caps_no_call_bot_no_msg_type() -> None:
    caps = Capabilities.leaf()
    assert caps.can_call_bot is False
    assert caps.include_msg_type is False


def test_capabilities_are_frozen() -> None:
    """Capabilities are immutable so dispatch sites can pass them around
    without worrying about cross-call mutation."""
    import dataclasses
    caps = Capabilities.regular()
    try:
        caps.can_call_bot = False  # type: ignore[misc]
    except dataclasses.FrozenInstanceError:
        return
    raise AssertionError("Capabilities should be frozen")


def test_capabilities_equality_by_value() -> None:
    """Two Capabilities with the same flags are equal."""
    assert Capabilities.regular() == Capabilities.regular()
    assert Capabilities.coordinator() != Capabilities.regular()
    assert Capabilities.leaf() != Capabilities.regular()
