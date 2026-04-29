"""Agent Orchestrator：解析 @ 提及、准备附件、调用 Bot，并通过 WebSocket 流式广播。"""
from __future__ import annotations

import logging
import time
import uuid
from collections.abc import Awaitable, Callable

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.log_context import bind_context
from app.db.models import Message
from app.services.adapters.base import OpenClawAdapter
from app.services.pipeline.bot import (
    AutoTakeoverStage,
    BotMessageWriter,
    BotRunContext,
    ContextLoadStage,
    DispatchStage,
    IngestStage,
    RouteStage,
)
from app.services.pipeline.bus import EventBus
from app.services.pipeline.runner import run_stage

logger = logging.getLogger("app.services.orchestrator.service")

COORDINATOR_USERNAME = "Coordinator"




async def run_orchestrator(
    channel_id: str,
    trigger_msg: Message,
    session: AsyncSession,
    adapter_factory: Callable[[str], Awaitable[OpenClawAdapter]],
    *,
    event_bus: EventBus,
    broadcast_processing: Callable[[str, str, str], Awaitable[None]] | None = None,
) -> tuple[list[Message], set[str]]:
    """根据消息中的 @ 提及和上传文件，串行执行频道内 Bot。"""
    t_start = time.perf_counter()

    ctx = BotRunContext(
        channel_id=channel_id,
        bus=event_bus,
        session=session,
        trigger_msg=trigger_msg,
        adapter_factory=adapter_factory,
        broadcast_processing=broadcast_processing,
        root_task_id=str(uuid.uuid4()),
    )
    ctx.writer = BotMessageWriter(ctx)

    total_stages = 5
    await run_stage(IngestStage(), ctx, pipeline_name="bot", index=1, total=total_stages)
    await run_stage(RouteStage(), ctx, pipeline_name="bot", index=2, total=total_stages)
    if not ctx.target_usernames:
        logger.info(
            "pipeline.stage.short_circuit pipeline=bot after_stage=RouteStage reason=no_targets "
            "channel_id=%s trigger_msg_id=%s",
            channel_id,
            trigger_msg.msg_id,
        )
        return [], set()
    await run_stage(ContextLoadStage(), ctx, pipeline_name="bot", index=3, total=total_stages)

    with bind_context(channel_id=channel_id, trace_id=ctx.root_task_id):
        logger.info(
            "orchestrator.start trigger_msg_id=%s targets=%s mention_count=%d",
            trigger_msg.msg_id, ctx.target_usernames, len(ctx.target_usernames),
        )
        await run_stage(AutoTakeoverStage(), ctx, pipeline_name="bot", index=4, total=total_stages)
        await run_stage(DispatchStage(), ctx, pipeline_name="bot", index=5, total=total_stages)
        total_ms = (time.perf_counter() - t_start) * 1000
        logger.info(
            "orchestrator.done trace_id=%s bot_count=%d duration_ms=%.0f",
            ctx.root_task_id, len(ctx.bot_messages), total_ms,
        )
    return ctx.bot_messages, ctx.already_broadcast
