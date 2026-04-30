"""WebSocket Bot timeout pipeline.

When an async WebSocket Bot has not replied within the short UX timeout we
do not fail the reply. Instead this small pipeline turns the placeholder into
a visible background task and leaves the pending registry intact, so a late
OpenClaw reply can still finalize the same message.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass

from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import Message
from app.services.openclaw_bridge.pending import pending_replies
from app.services.openclaw_bridge.service import mark_bot_reply_as_background_task
from app.services.pipeline.runner import Pipeline
from app.services.pipeline.stage import Stage

logger = logging.getLogger("app.services.pipeline.bot.task_timeout")


@dataclass
class WebsocketTaskTimeoutContext:
    session: AsyncSession
    bot_id: str
    channel_id: str
    task_id: str
    msg_id: str
    timeout_s: int
    root_task_id: str = ""
    pending_exists: bool = False
    converted: bool = False
    message: Message | None = None

    def __post_init__(self) -> None:
        if not self.root_task_id:
            self.root_task_id = self.task_id


class ValidatePendingStage(Stage[WebsocketTaskTimeoutContext]):
    async def run(self, ctx: WebsocketTaskTimeoutContext) -> None:
        pending = await pending_replies.peek_by_msg(ctx.msg_id)
        ctx.pending_exists = bool(
            pending
            and pending.bot_id == ctx.bot_id
            and pending.channel_id == ctx.channel_id
            and pending.task_id == ctx.task_id
        )
        if not ctx.pending_exists:
            logger.info(
                "websocket_task_timeout: skip; pending already resolved bot_id=%s task_id=%s msg_id=%s",
                ctx.bot_id,
                ctx.task_id,
                ctx.msg_id,
            )


class ConvertToTaskStage(Stage[WebsocketTaskTimeoutContext]):
    async def run(self, ctx: WebsocketTaskTimeoutContext) -> None:
        if not ctx.pending_exists:
            return
        msg = await mark_bot_reply_as_background_task(
            ctx.session,
            bot_id=ctx.bot_id,
            channel_id=ctx.channel_id,
            task_id=ctx.task_id,
            msg_id=ctx.msg_id,
            timeout_s=ctx.timeout_s,
        )
        ctx.message = msg
        ctx.converted = msg is not None
        if ctx.converted:
            logger.info(
                "websocket_task_timeout: converted placeholder to background task bot_id=%s task_id=%s msg_id=%s",
                ctx.bot_id,
                ctx.task_id,
                ctx.msg_id,
            )


class CommitStage(Stage[WebsocketTaskTimeoutContext]):
    async def run(self, ctx: WebsocketTaskTimeoutContext) -> None:
        if ctx.converted:
            await ctx.session.commit()


def make_websocket_task_timeout_pipeline() -> Pipeline[WebsocketTaskTimeoutContext]:
    return Pipeline(
        [
            ValidatePendingStage(),
            ConvertToTaskStage(),
            CommitStage(),
        ],
        name="websocket-task-timeout",
    )
