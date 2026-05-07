"""Capabilities: what a dispatched bot is allowed to do during this run.

Replaces the three implicit ``process_config`` shapes the Bot pipeline was
hand-building (regular, coordinator, suggestee-leaf) with a single,
type-checked dataclass.

- ``regular()`` — full call_bot capability: ``_run_ctx`` rides in
  process_config so the bot's tools can hop into ``dispatch_one`` to
  delegate. ``trigger_message`` carries ``msg_id`` so adapters can
  correlate the user's question.
- ``coordinator()`` — same as regular plus ``trigger_message["msg_type"]``,
  used by adapters that render clarify cards differently for the
  coordinator's special ``msg_type`` flow.
- ``leaf()`` — minimal config. No ``_run_ctx``, no bot lookup. Auto-takeover
  suggestees use this so they cannot recursively ``call_bot`` other bots;
  matches the original implicit contract that auto_takeover phase-2 bots
  are leaves.
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Capabilities:
    can_call_bot: bool       # process_config exposes _run_ctx for sub-dispatch
    include_msg_type: bool   # trigger_message carries trigger_msg.msg_type

    @classmethod
    def regular(cls) -> "Capabilities":
        return cls(can_call_bot=True, include_msg_type=False)

    @classmethod
    def coordinator(cls) -> "Capabilities":
        return cls(can_call_bot=True, include_msg_type=True)

    @classmethod
    def leaf(cls) -> "Capabilities":
        return cls(can_call_bot=False, include_msg_type=False)
