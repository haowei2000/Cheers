"""BotRunContext: data carried through BotPipeline stages.

Replaces the implicit ``process_config`` dict + closure variables that
run_orchestrator was building locally. Fields populate progressively as
stages run; many start as defaults and are filled by the stage that owns
that piece of state.
"""
from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import Channel, Message
from app.services.adapters.base import OpenClawAdapter
from app.services.pipeline.bus import EventBus


@dataclass
class BotRunContext:
    # ── base / inputs ───────────────────────────────────────────────────
    channel_id: str
    bus: EventBus
    session: AsyncSession
    trigger_msg: Message
    adapter_factory: Callable[[str], Awaitable[OpenClawAdapter]]
    broadcast_processing: Callable[[str, str, str], Awaitable[None]] | None = None
    t_start: float = 0.0  # perf_counter() at orchestrator entry

    # ── filled by IngestStage ───────────────────────────────────────────
    rows: list[Any] = field(default_factory=list)  # list[(ChannelMembership, BotAccount)]
    channel_bot_usernames: list[str] = field(default_factory=list)
    bot_id_by_username: dict[str, str] = field(default_factory=dict)
    channel_template_override_by_bot_id: dict[str, Any] = field(default_factory=dict)
    bot_details_by_username: dict[str, dict] = field(default_factory=dict)
    analysis_content: str = ""
    trigger_content: str = ""
    is_encrypted_msg: bool = False
    user_secrets: dict[str, str] = field(default_factory=dict)
    sender_name: str = ""
    channel_name: str = ""
    channel: Channel | None = None

    # ── filled by RouteStage ────────────────────────────────────────────
    mentioned: list[str] = field(default_factory=list)  # raw @-mention usernames
    target_usernames: list[str] = field(default_factory=list)  # resolved valid bots to dispatch
    direct_answer_mode: bool = False  # auto-assist routed to coordinator
    mode: str = ""  # "explicit" | "direct_answer" | "noop"

    # ── filled by ContextLoadStage (future commit) ──────────────────────
    memory_context: dict[str, str] = field(default_factory=dict)
    attachments: list[dict[str, str]] = field(default_factory=list)
    attachment_error: str | None = None
    topic_chain: list[Any] = field(default_factory=list)
    child_replies: list[Any] = field(default_factory=list)
    original_question: str | None = None
    original_file_ids: list[str] = field(default_factory=list)

    # ── output ──────────────────────────────────────────────────────────
    bot_messages: list[Message] = field(default_factory=list)
    already_broadcast: set[str] = field(default_factory=set)
