"""Agent Bridge Bot timeout pipeline.

When an async Agent Bridge Bot has not replied within the short UX timeout we
do not fail the reply. Instead this small pipeline turns the placeholder into
a visible background task and leaves the pending registry intact, so a late
Agent Bridge reply can still finalize the same message.
"""
from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.db.models import BotRun, Channel, Message
from app.features.agent_bridge.pending import pending_replies
from app.features.agent_bridge.service import mark_bot_reply_as_background_task
from app.features.bot_runtime.pipeline.runner import Pipeline
from app.features.bot_runtime.pipeline.stage import Stage

logger = logging.getLogger("app.features.bot_runtime.pipeline.bot.task_timeout")
_RECOVERED_TIMEOUT_HANDLES: dict[str, asyncio.TimerHandle] = {}


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
            msg = await ctx.session.get(Message, ctx.msg_id)
            if msg is not None:
                ctx.pending_exists = (
                    msg.channel_id == ctx.channel_id
                    and msg.sender_id == ctx.bot_id
                    and msg.task_id == ctx.task_id
                    and not (msg.content or "").strip()
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


def _as_utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=UTC)
    return value.astimezone(UTC)


def schedule_agent_bridge_task_timeout(
    *,
    bot_id: str,
    channel_id: str,
    task_id: str,
    msg_id: str,
    timeout_s: int,
    delay_s: float,
) -> bool:
    """Schedule the durable timeout conversion after process restart."""
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        logger.warning(
            "agent_bridge_task_timeout: no running loop; cannot re-arm timeout bot_id=%s task_id=%s msg_id=%s",
            bot_id,
            task_id,
            msg_id,
        )
        return False

    async def _on_timeout() -> None:
        from app.db.session import async_session_factory

        logger.warning(
            "agent_bridge_bot_slow_reply: bot_id=%s task_id=%s msg_id=%s after %ds",
            bot_id,
            task_id,
            msg_id,
            timeout_s,
        )
        try:
            async with async_session_factory() as s2:
                try:
                    timeout_ctx = AgentBridgeTaskTimeoutContext(
                        session=s2,
                        bot_id=bot_id,
                        channel_id=channel_id,
                        task_id=task_id,
                        msg_id=msg_id,
                        timeout_s=timeout_s,
                    )
                    await make_agent_bridge_task_timeout_pipeline().run(timeout_ctx)
                except Exception:
                    await s2.rollback()
                    raise
        except Exception:
            logger.exception(
                "agent_bridge_task_timeout: recovered timer failed bot_id=%s task_id=%s msg_id=%s",
                bot_id,
                task_id,
                msg_id,
            )
        finally:
            _RECOVERED_TIMEOUT_HANDLES.pop(msg_id, None)

    def _fire() -> None:
        asyncio.create_task(_on_timeout())

    existing = _RECOVERED_TIMEOUT_HANDLES.pop(msg_id, None)
    if existing is not None:
        existing.cancel()
    _RECOVERED_TIMEOUT_HANDLES[msg_id] = loop.call_later(max(0.0, delay_s), _fire)
    return True


async def recover_agent_bridge_task_timeouts_once(session: AsyncSession) -> int:
    """Convert stale dispatched Agent Bridge placeholders and re-arm live ones."""
    timeout_s = max(5, int(settings.agent_bridge_timeout_seconds or 600))
    now = datetime.now(UTC)
    cutoff = now - timedelta(seconds=timeout_s)
    rows = (
        await session.execute(
            select(BotRun).where(
                BotRun.binding_type == "agent_bridge",
                BotRun.status == "dispatched_async",
            )
        )
    ).scalars().all()
    converted = 0
    scheduled = 0
    pipeline = make_agent_bridge_task_timeout_pipeline()
    for run in rows:
        updated_at = _as_utc(run.updated_at) if run.updated_at else cutoff
        elapsed_s = (now - updated_at).total_seconds()
        if elapsed_s < timeout_s:
            channel = await session.get(Channel, run.channel_id)
            if channel is not None and channel.type == "dm":
                continue
            if schedule_agent_bridge_task_timeout(
                bot_id=run.bot_id,
                channel_id=run.channel_id,
                task_id=run.task_id,
                msg_id=run.placeholder_msg_id,
                timeout_s=timeout_s,
                delay_s=timeout_s - elapsed_s,
            ):
                scheduled += 1
            continue
        ctx = AgentBridgeTaskTimeoutContext(
            session=session,
            bot_id=run.bot_id,
            channel_id=run.channel_id,
            task_id=run.task_id,
            msg_id=run.placeholder_msg_id,
            timeout_s=timeout_s,
        )
        await pipeline.run(ctx)
        if ctx.converted:
            converted += 1
    if scheduled:
        logger.info("agent_bridge_task_timeout: re-armed %d pending task timeout(s)", scheduled)
    return converted
