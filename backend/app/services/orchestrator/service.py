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
        t_start=t_start,
        root_task_id=str(uuid.uuid4()),
    )
    ctx.writer = BotMessageWriter(ctx)

    await IngestStage().run(ctx)
    await RouteStage().run(ctx)
    if not ctx.target_usernames:
        return [], set()
    await ContextLoadStage().run(ctx)

    with bind_context(channel_id=channel_id, trace_id=ctx.root_task_id):
        logger.info(
            "orchestrator.start trigger_msg_id=%s targets=%s mention_count=%d",
            trigger_msg.msg_id, ctx.target_usernames, len(ctx.target_usernames),
        )
        await AutoTakeoverStage().run(ctx)
        await DispatchStage().run(ctx)
        total_ms = (time.perf_counter() - t_start) * 1000
        logger.info(
            "orchestrator.done trace_id=%s bot_count=%d duration_ms=%.0f",
            ctx.root_task_id, len(ctx.bot_messages), total_ms,
        )
    return ctx.bot_messages, ctx.already_broadcast
