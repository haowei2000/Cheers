"""IngestContext: data carried through the unified message workflow.

Inputs are populated by the caller (HTTP route, SSE endpoint, builtin-bot
post-back). Stages mutate the intermediate / output fields as the pipeline
runs.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING

from sqlalchemy.ext.asyncio import AsyncSession

from app.contracts.messages import MessageDTO, MessageFileDTO
from app.db.models import Message
from app.features.bot_runtime.pipeline.bus import EventBus

if TYPE_CHECKING:
    from app.features.bot_runtime.pipeline.workflow import MessageWorkflowPlan


@dataclass
class IngestContext:
    # ── base (every pipeline run) ───────────────────────────────────────
    channel_id: str
    bus: EventBus
    session: AsyncSession

    # ── input ───────────────────────────────────────────────────────────
    sender_id: str = ""
    sender_type: str = "user"  # "user" | "bot"
    content: str = ""
    file_ids: list[str] = field(default_factory=list)
    mention_bot_ids: list[str] = field(default_factory=list)
    in_reply_to_msg_id: str | None = None
    msg_type: str | None = None  # None → derived from in_reply_to_msg_id
    content_data: dict | None = None
    is_secret: bool = False

    # ── flags ───────────────────────────────────────────────────────────
    skip_secret: bool = False  # builtin-bot post-back doesn't carry secrets
    skip_commit: bool = False  # caller manages the request transaction itself
    skip_fanout: bool = False  # tests / scenarios that suppress unread bumps

    # ── workflow plan ──────────────────────────────────────────────────
    workflow: "MessageWorkflowPlan | None" = None

    # ── intermediates / output ──────────────────────────────────────────
    stored_content: str | None = None  # final content stored in DB
    secret_encrypted: str | None = None
    secret_token: str | None = None
    msg: Message | None = None
    file_map: dict[str, MessageFileDTO] = field(default_factory=dict)
    payload: MessageDTO | None = None
