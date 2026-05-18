"""Bot pipeline service: build a workflow plan, then execute its stages."""
from __future__ import annotations

import logging
import time
import uuid
from collections.abc import Awaitable, Callable

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.localization import locale_from_content_data
from app.core.log_context import bind_context
from app.db.models import Message
from app.features.bot_runtime.adapters.base import BotAdapter
from app.features.bot_runtime.pipeline.bot.context import BotRunContext
from app.features.bot_runtime.pipeline.bot.writer import BotMessageWriter
from app.features.bot_runtime.pipeline.bus import EventBus
from app.features.bot_runtime.pipeline.runner import Pipeline
from app.features.bot_runtime.pipeline.workflow import build_bot_workflow

logger = logging.getLogger("app.features.bot_runtime.pipeline.bot.service")


async def run_bot_pipeline(
    channel_id: str,
    trigger_msg: Message,
    session: AsyncSession,
    adapter_factory: Callable[[str], Awaitable[BotAdapter]],
    *,
    event_bus: EventBus,
    broadcast_processing: Callable[[str, str, str], Awaitable[None]] | None = None,
) -> tuple[list[Message], set[str]]:
    """Build and run the Bot workflow for one trigger message."""
    t_start = time.perf_counter()

    ctx = BotRunContext(
        channel_id=channel_id,
        bus=event_bus,
        session=session,
        trigger_msg=trigger_msg,
        adapter_factory=adapter_factory,
        broadcast_processing=broadcast_processing,
        root_task_id=str(uuid.uuid4()),
        locale=locale_from_content_data(trigger_msg.content_data),
    )
    ctx.writer = BotMessageWriter(ctx)

    plan = await build_bot_workflow(ctx)
    logger.info("bot_pipeline.workflow.built plan=%s", plan.to_log_dict())
    if not plan.stages:
        logger.info(
            "bot_pipeline.short_circuit reason=%s channel_id=%s trigger_msg_id=%s",
            plan.reason,
            channel_id,
            trigger_msg.msg_id,
        )
        return [], set()

    with bind_context(channel_id=channel_id, trace_id=ctx.root_task_id):
        logger.info(
            "bot_pipeline.start trigger_msg_id=%s route_mode=%s targets=%s stage_count=%d",
            trigger_msg.msg_id,
            plan.route_mode,
            plan.target_usernames,
            len(plan.stages),
        )
        await Pipeline(plan.stages, name="bot").run(ctx)
        total_ms = (time.perf_counter() - t_start) * 1000
        logger.info(
            "bot_pipeline.done trace_id=%s bot_count=%d duration_ms=%.0f",
            ctx.root_task_id, len(ctx.bot_messages), total_ms,
        )
    return ctx.bot_messages, ctx.already_broadcast
