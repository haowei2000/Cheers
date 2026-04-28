"""Agent Orchestrator：解析 @ 提及、准备附件、调用 Bot，并通过 WebSocket 流式广播。"""
from __future__ import annotations

import asyncio
import logging
import time
import uuid
from collections.abc import Awaitable, Callable

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.log_context import bind_context
from app.db.models import Message
from app.services.adapters.base import AgentPayload, AgentResponse, OpenClawAdapter
from app.services.admin.settings_store import get_assist_settings
from app.services.orchestrator.orchestrator_adapter import extract_suggested_bots
from app.services.pipeline.bot import (
    BotMessageWriter,
    BotRunContext,
    ContextLoadStage,
    DispatchStage,
    IngestStage,
    RouteStage,
    trigger_sub_bots_from_mentions,
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

    # Locals shim: read by the still-unmigrated dispatch / auto-takeover
    # blocks below. Goes away once they're stage-extracted.
    channel_bot_usernames = ctx.channel_bot_usernames
    bot_id_by_username = ctx.bot_id_by_username
    bot_details_by_username = ctx.bot_details_by_username
    adapter_factory = ctx.adapter_factory
    trigger_content = ctx.trigger_content
    user_secrets = ctx.user_secrets
    sender_name = ctx.sender_name
    channel_name = ctx.channel_name
    await RouteStage().run(ctx)
    if not ctx.target_usernames:
        return [], set()
    target_usernames = ctx.target_usernames
    direct_answer_mode = ctx.direct_answer_mode
    original_question = ctx.original_question

    await ContextLoadStage().run(ctx)
    memory_context = ctx.memory_context
    attachments = ctx.attachments
    attachment_error = ctx.attachment_error
    topic_chain = ctx.topic_chain
    child_replies = ctx.child_replies

    created = ctx.bot_messages
    already_broadcast = ctx.already_broadcast
    root_task_id = ctx.root_task_id
    triggered_bot_ids = ctx.triggered_bot_ids
    bot_msg_by_id = ctx.bot_msg_by_id

    _ctx_token = bind_context(channel_id=channel_id, trace_id=root_task_id)
    _ctx_token.__enter__()
    logger.info(
        "orchestrator.start trigger_msg_id=%s targets=%s mention_count=%d",
        trigger_msg.msg_id, target_usernames, len(target_usernames),
    )

    # Writer aliases: bound-method handles to ctx.writer for the legacy
    # in-function call sites.
    _writer = ctx.writer
    assert _writer is not None
    _create_msg_and_broadcast = _writer.create_and_broadcast
    _pre_create_bot_msg = _writer.pre_create
    _make_stream_token_cb = _writer.make_stream_token_cb
    _finalize_bot_msg = _writer.finalize
    _record_agent_task = _writer.record_task
    _register_async_pending = _writer.register_async_pending

    # ── Coordinator（direct_answer_mode）─────────────────────────────────────
    if COORDINATOR_USERNAME in target_usernames and direct_answer_mode:
        bot_id = bot_id_by_username[COORDINATOR_USERNAME]
        adapter = await adapter_factory(bot_id)
        task_id = root_task_id
        other_bots = [item for item in channel_bot_usernames if item != COORDINATOR_USERNAME]
        if attachment_error:
            await ctx.writer.finish_with_error(bot_id, task_id, attachment_error)
        else:
            orch_msg = await _pre_create_bot_msg(bot_id, task_id)
            payload = AgentPayload(
                task_id=task_id,
                channel_id=channel_id,
                trigger_message={
                    "user": trigger_msg.sender_id,
                    "sender_name": sender_name,
                    "text": trigger_content,
                    "timestamp": trigger_msg.created_at.isoformat() if trigger_msg.created_at else "",
                    "msg_id": trigger_msg.msg_id,
                    "in_reply_to_msg_id": trigger_msg.in_reply_to_msg_id,
                    "msg_type": trigger_msg.msg_type,
                    "topic_chain": topic_chain,
                    "child_replies": child_replies,
                },
                memory_context=memory_context,
                attachments=attachments,
                original_question_text=original_question,
                process_config={
                    "channel_bot_usernames": other_bots,
                    "channel_bot_details": {
                        key: value for key, value in bot_details_by_username.items() if key != COORDINATOR_USERNAME
                    },
                    "bot_id_by_username": {
                        key: value for key, value in bot_id_by_username.items() if key != COORDINATOR_USERNAME
                    },
                    "_adapter_factory": adapter_factory,
                    "_create_and_broadcast": _create_msg_and_broadcast,
                    "_stream_token": _make_stream_token_cb(orch_msg.msg_id),
                    "_event_bus": event_bus,
                    "_db_session": session,
                    "_pre_create_bot_msg": _pre_create_bot_msg,
                    "_finalize_bot_msg": _finalize_bot_msg,
                    "_make_stream_token_cb": _make_stream_token_cb,
                    "_bot_id": bot_id,
                    "_placeholder_msg_id": orch_msg.msg_id,
                    "_user_secrets": user_secrets,
                    "_sender_name": sender_name,
                    "_channel_name": channel_name,
                },
            )
            resp: AgentResponse = await adapter.execute(payload)
            content: str | None = None
            if resp.dispatched_async:
                await _register_async_pending(orch_msg, task_id, bot_id)
                await _record_agent_task(bot_id, orch_msg.msg_id)
                created.append(orch_msg)
                triggered_bot_ids.add(bot_id)
                bot_msg_by_id[bot_id] = orch_msg
                # 异步派发场景下跳过 auto_takeover 与 Bot@Bot 递归：真正的 Bot 回复还没产出
            else:
                content = resp.content if resp.success else (resp.error_message or "处理出错")
                await _finalize_bot_msg(orch_msg, content, file_ids=resp.file_ids)
                await _record_agent_task(bot_id, orch_msg.msg_id)
                created.append(orch_msg)
                triggered_bot_ids.add(bot_id)
                bot_msg_by_id[bot_id] = orch_msg
                # Bot @ Bot 自动触发：递归处理 @ 提及
                await trigger_sub_bots_from_mentions(
                    ctx, orch_msg, bot_id, trigger_content, depth=0,
                )

            orch_settings = get_assist_settings()
            if content is not None and orch_settings.get("auto_takeover"):
                suggested = extract_suggested_bots(content)
                valid_suggested = [
                    sug for sug in suggested
                    if sug in channel_bot_usernames and sug != COORDINATOR_USERNAME
                ]

                if valid_suggested:
                    # Emit a routing card right before firing the sub-bots, so
                    # the UI can render the design's .an-routing card (agent
                    # picks + plan) instead of only seeing the coordinator's
                    # prose.
                    await ctx.writer.emit_routing_card(
                        coordinator_bot_id=bot_id,
                        coordinator_content=content,
                        picked_usernames=valid_suggested,
                    )

                # 阶段 1：串行 broadcast + 预建消息（需要 DB session）
                pending_sug: list[tuple[str, str, Message, AgentPayload, OpenClawAdapter]] = []
                for sug_username in valid_suggested:
                    sug_bot_id = bot_id_by_username[sug_username]
                    if broadcast_processing:
                        await broadcast_processing(channel_id, sug_bot_id, sug_username)
                    sug_adapter = await adapter_factory(sug_bot_id)
                    sug_msg = await _pre_create_bot_msg(sug_bot_id, root_task_id)
                    sug_payload = AgentPayload(
                        task_id=root_task_id,
                        channel_id=channel_id,
                        trigger_message={
                            "user": trigger_msg.sender_id,
                            "sender_name": sender_name,
                            "text": trigger_content,
                            "timestamp": trigger_msg.created_at.isoformat() if trigger_msg.created_at else "",
                            "in_reply_to_msg_id": trigger_msg.in_reply_to_msg_id,
                            "topic_chain": topic_chain,
                            "child_replies": child_replies,
                        },
                        memory_context=memory_context,
                        attachments=attachments,
                        original_question_text=original_question,
                        process_config={
                            "_stream_token": _make_stream_token_cb(sug_msg.msg_id),
                            "_event_bus": event_bus,
                            "_bot_id": sug_bot_id,
                            "_placeholder_msg_id": sug_msg.msg_id,
                            "_user_secrets": user_secrets,
                            "_sender_name": sender_name,
                            "_channel_name": channel_name,
                        },
                    )
                    pending_sug.append((sug_username, sug_bot_id, sug_msg, sug_payload, sug_adapter))
                    logger.info(
                        "orchestrator_auto_takeover: triggered @%s memory_layers=%d",
                        sug_username, len(memory_context),
                    )

                # 阶段2：并发调用所有 auto_takeover Bot 的 LLM（无 DB 操作）
                if pending_sug:
                    sug_results = await asyncio.gather(
                        *[_sug_adapter.execute(_sug_payload) for _, _, _, _sug_payload, _sug_adapter in pending_sug],
                        return_exceptions=True,
                    )
                    # 阶段3：串行写库 + 广播（需要 DB session）
                    for (sug_username, sug_bot_id, sug_msg, _, _), sug_resp in zip(pending_sug, sug_results):
                        if isinstance(sug_resp, BaseException):
                            logger.warning("orchestrator_auto_takeover: bot %s raised: %s", sug_username, sug_resp)
                            sug_content = f"处理出错: {sug_resp}"
                        elif sug_resp.dispatched_async:
                            await _register_async_pending(sug_msg, root_task_id, sug_bot_id)
                            await _record_agent_task(sug_bot_id, sug_msg.msg_id)
                            created.append(sug_msg)
                            logger.info("orchestrator_auto_takeover: async-dispatched @%s", sug_username)
                            continue
                        else:
                            sug_content = sug_resp.content if sug_resp.success else (sug_resp.error_message or "处理出错")
                        await _finalize_bot_msg(sug_msg, sug_content)
                        await _record_agent_task(sug_bot_id, sug_msg.msg_id)
                        created.append(sug_msg)
                        logger.info("orchestrator_auto_takeover: triggered @%s", sug_username)

    await DispatchStage().run(ctx)

    total_ms = (time.perf_counter() - t_start) * 1000
    logger.info(
        "orchestrator.done trace_id=%s bot_count=%d duration_ms=%.0f",
        root_task_id, len(created), total_ms,
    )
    _ctx_token.__exit__(None, None, None)
    return created, already_broadcast
