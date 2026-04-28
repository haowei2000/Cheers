"""IngestContext: data carried through the IngestPipeline.

Inputs are populated by the caller (HTTP route, SSE endpoint, builtin-bot
post-back). Stages mutate the intermediate / output fields as the pipeline
runs.
"""
from __future__ import annotations

from dataclasses import dataclass, field

from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import Message
from app.services.pipeline.bus import EventBus


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

    # ── intermediates / output ──────────────────────────────────────────
    stored_content: str | None = None  # final content stored in DB
    secret_encrypted: str | None = None
    secret_token: str | None = None
    msg: Message | None = None
    file_map: dict = field(default_factory=dict)  # file_id -> MessageFileInResponse
    payload: dict | None = None  # serialized message dict, MessageCreated.data
