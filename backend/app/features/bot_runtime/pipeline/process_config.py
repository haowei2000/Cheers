"""BotRuntime: typed runtime controls passed to bot adapters.

Typing the bag of values that flow from ``build_payload`` to adapters
catches typos at static-analysis time and documents (in one place) what
each adapter is allowed to expect. Optional fields default to safe empty
values so a caller that only sets a subset still produces a usable runtime.

``ProcessConfig`` remains as a compatibility alias for older call sites.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass
class BotRuntime:
    # ── always present (every dispatch) ─────────────────────────────────
    bot_id: str = ""
    placeholder_msg_id: str = ""
    user_secrets: dict[str, str] = field(default_factory=dict)
    sender_name: str = ""
    channel_name: str = ""
    event_bus: Any = None  # EventBus (typed Any to avoid circular import)
    cancel_event: Any = None  # asyncio.Event; set when the user cancels this bot reply

    # ── call_bot capability (set when Capabilities.can_call_bot) ────────
    db_session: Any = None  # AsyncSession
    channel_bot_usernames: list[str] = field(default_factory=list)
    channel_bot_details: dict[str, dict] = field(default_factory=dict)
    run_ctx: Any = None  # BotRunContext (typed Any to avoid circular import)

    # ── call_bot tool flag ──────────────────────────────────────────────
    skip_system_prompt: bool = False


ProcessConfig = BotRuntime
