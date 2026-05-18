"""BotRunContext: data carried through the Bot pipeline workflow."""
from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import Channel, Message
from app.features.bot_runtime.adapters.base import BotAdapter
from app.features.bot_runtime.pipeline.bus import EventBus

if TYPE_CHECKING:
    from app.features.bot_runtime.pipeline.bot.writer import BotMessageWriter
    from app.features.bot_runtime.pipeline.workflow import BotWorkflowPlan


@dataclass
class BotRunContext:
    # ── base / inputs ───────────────────────────────────────────────────
    channel_id: str
    bus: EventBus
    session: AsyncSession
    trigger_msg: Message
    adapter_factory: Callable[[str], Awaitable[BotAdapter]]
    broadcast_processing: Callable[[str, str, str], Awaitable[None]] | None = None

    # ── filled by BotWorkflowBuilder ────────────────────────────────────
    channel_bot_usernames: list[str] = field(default_factory=list)
    bot_id_by_username: dict[str, str] = field(default_factory=dict)
    bot_details_by_username: dict[str, dict] = field(default_factory=dict)
    bot_user_templates_by_username: dict[str, str] = field(default_factory=dict)
    analysis_content: str = ""
    trigger_content: str = ""
    user_secrets: dict[str, str] = field(default_factory=dict)
    sender_name: str = ""
    channel_name: str = ""
    locale: str = "en"
    channel: Channel | None = None

    # ── filled by BotWorkflowBuilder route planning ─────────────────────
    target_usernames: list[str] = field(default_factory=list)  # resolved valid bots to dispatch
    direct_answer_mode: bool = False  # auto-assist routed to coordinator
    coordinator_profile: Any = None  # Coordinator-specific context and tool budget

    # ── filled by ContextLoadStage ──────────────────────────────────────
    memory_context: dict[str, str] = field(default_factory=dict)
    memory_load_detail: dict[str, Any] = field(default_factory=dict)
    attachments: list[dict[str, str]] = field(default_factory=list)
    attachment_error: str | None = None
    topic_chain: list[Any] = field(default_factory=list)
    child_replies: list[Any] = field(default_factory=list)
    original_question: str | None = None
    original_file_ids: list[str] = field(default_factory=list)

    # ── pipeline-run identity ───────────────────────────────────────────
    root_task_id: str = ""
    writer: "BotMessageWriter | None" = None
    workflow: "BotWorkflowPlan | None" = None

    # ── shared state across dispatch / auto-takeover / Bot@Bot ──────────
    triggered_bot_ids: set[str] = field(default_factory=set)

    # ── output ──────────────────────────────────────────────────────────
    bot_messages: list[Message] = field(default_factory=list)
    already_broadcast: set[str] = field(default_factory=set)
