"""Capabilities: what a dispatched bot is allowed to do during this run.

Replaces the three implicit ``process_config`` shapes the orchestrator was
hand-building (regular, coordinator-with-streaming-hooks, suggestee-leaf)
with a single, type-checked dataclass.

- ``regular()`` — full call_bot capability: ``_adapter_factory`` and the
  channel-bot lookup tables ride in process_config so the bot's tools can
  delegate. trigger_message carries ``msg_id`` so adapters can correlate
  the user's question.
- ``coordinator()`` — same as regular plus the streaming hooks
  (``_pre_create_bot_msg`` / ``_finalize_bot_msg`` /
  ``_make_stream_token_cb``) so the Coordinator's ``call_bot`` tool can
  pre-create a placeholder for sub-bot replies and stream tokens directly
  into them. trigger_message also carries ``msg_type`` for clarify-card
  rendering.
- ``leaf()`` — minimal config. No adapter_factory, no bot_id lookup, no
  streaming hooks. Auto-takeover suggestees use this so they cannot
  recursively ``call_bot`` other bots; matches the original implicit
  contract that auto_takeover phase-2 bots are leaves.
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Capabilities:
    can_call_bot: bool          # process_config has adapter_factory + bot lookup
    has_streaming_hooks: bool   # process_config has _pre_create_bot_msg / _finalize_bot_msg / _make_stream_token_cb

    @classmethod
    def regular(cls) -> "Capabilities":
        return cls(can_call_bot=True, has_streaming_hooks=False)

    @classmethod
    def coordinator(cls) -> "Capabilities":
        return cls(can_call_bot=True, has_streaming_hooks=True)

    @classmethod
    def leaf(cls) -> "Capabilities":
        return cls(can_call_bot=False, has_streaming_hooks=False)
