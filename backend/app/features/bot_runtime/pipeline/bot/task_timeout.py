"""Agent Bridge Bot timeout pipeline.

When an async Agent Bridge Bot has not replied within the short UX timeout we
do not fail the reply. Instead this small pipeline turns the placeholder into
a visible background task and leaves the pending registry intact, so a late
Agent Bridge reply can still finalize the same message.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass

from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import Channel, Message
from app.features.agent_bridge.pending import pending_replies
from app.features.agent_bridge.service import mark_bot_reply_as_background_task
from app.features.bot_runtime.pipeline.runner import Pipeline
from app.features.bot_runtime.pipeline.stage import Stage

logger = logging.getLogger("app.features.bot_runtime.pipeline.bot.task_timeout")


@dataclass
class AgentBridgeTaskTimeoutContext:
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


class ValidatePendingStage(Stage[AgentBridgeTaskTimeoutContext]):
    async def run(self, ctx: AgentBridgeTaskTimeoutContext) -> None:
        pending = await pending_replies.peek_by_msg(ctx.msg_id)
        ctx.pending_exists = bool(
            pending
            and pending.bot_id == ctx.bot_id
            and pending.channel_id == ctx.channel_id
            and pending.task_id == ctx.task_id
        )
        if not ctx.pending_exists:
            logger.info(
                "agent_bridge_task_timeout: skip; pending already resolved bot_id=%s task_id=%s msg_id=%s",
                ctx.bot_id,
                ctx.task_id,
                ctx.msg_id,
            )


class ConvertToTaskStage(Stage[AgentBridgeTaskTimeoutContext]):
    async def run(self, ctx: AgentBridgeTaskTimeoutContext) -> None:
        if not ctx.pending_exists:
            return
        channel = await ctx.session.get(Channel, ctx.channel_id)
        if channel is not None and channel.type == "dm":
            logger.info(
                "agent_bridge_task_timeout: skip dm scope bot_id=%s task_id=%s msg_id=%s",
                ctx.bot_id,
                ctx.task_id,
                ctx.msg_id,
            )
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
            from app.features.agent_bridge.session_map import adopt_session_for_task
            from app.features.bot_runtime.bot_events.runs import mark_bot_run_status

            await adopt_session_for_task(
                ctx.session,
                bot_id=ctx.bot_id,
                channel_id=ctx.channel_id,
                task_id=ctx.task_id,
                source_msg_id=ctx.msg_id,
                reason="agent_bridge_timeout",
            )
            await mark_bot_run_status(
                ctx.session,
                placeholder_msg_id=ctx.msg_id,
                status="background_task",
                last_event_type="agent_bridge.timeout",
            )
            logger.info(
                "agent_bridge_task_timeout: converted placeholder to background task bot_id=%s task_id=%s msg_id=%s",
                ctx.bot_id,
                ctx.task_id,
                ctx.msg_id,
            )


class CommitStage(Stage[AgentBridgeTaskTimeoutContext]):
    async def run(self, ctx: AgentBridgeTaskTimeoutContext) -> None:
        if ctx.converted:
            await ctx.session.commit()


def make_agent_bridge_task_timeout_pipeline() -> Pipeline[AgentBridgeTaskTimeoutContext]:
    return Pipeline(
        [
            ValidatePendingStage(),
            ConvertToTaskStage(),
            CommitStage(),
        ],
        name="agent-bridge-task-timeout",
    )
