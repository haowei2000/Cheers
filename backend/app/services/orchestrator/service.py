"""Agent Orchestrator：解析 @ 提及、准备附件、调用 Bot，并通过 WebSocket 流式广播。"""
from __future__ import annotations

import asyncio
import logging
import time
import uuid
from collections.abc import Awaitable, Callable

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.log_context import bind_context
from app.db.models import BotAccount, Message
from app.services.adapters.base import AgentPayload, AgentResponse, OpenClawAdapter
from app.services.admin.settings_store import get_assist_settings
from app.services.orchestrator.mention import extract_mentions, filter_mentioned_bots
from app.services.orchestrator.orchestrator_adapter import extract_suggested_bots
from app.services.pipeline.bot import (
    BotMessageWriter,
    BotRunContext,
    ContextLoadStage,
    IngestStage,
    RouteStage,
)
from app.services.pipeline.bus import EventBus
from app.services.pipeline.events import (
    MessageCreated,
)

logger = logging.getLogger("app.services.orchestrator.service")

COORDINATOR_USERNAME = "Coordinator"




async def _emit_routing_card(
    *,
    channel_id: str,
    coordinator_bot_id: str,
    trigger_content: str,
    coordinator_content: str,
    picked_usernames: list[str],
    session: AsyncSession,
    already_broadcast: set[str],
    created: list[Message],
    event_bus: EventBus,
) -> None:
    """Write a msg_type="routing" Message carrying the coordinator's decision
    (who was picked + a terse plan snippet) and broadcast it over the
    channel WS. Non-fatal: any exception is logged and swallowed so the
    takeover flow continues.
    """
    from app.core.schemas import MessageInResponse

    try:
        picks = [{"agent": u, "picked": True} for u in picked_usernames]
        q = (trigger_content or "").strip().replace("\n", " ")
        if len(q) > 160:
            q = q[:160] + "…"
        plan = (coordinator_content or "").strip().replace("\n", " ")
        if len(plan) > 200:
            plan = plan[:200] + "…"

        routing_msg = Message(
            channel_id=channel_id,
            sender_id=coordinator_bot_id,
            sender_type="bot",
            content="",
            msg_type="routing",
            content_data={"q": q or None, "picks": picks, "plan": plan or None},
        )
        session.add(routing_msg)
        await session.flush()

        data = MessageInResponse.model_validate(routing_msg).model_dump()
        if routing_msg.created_at:
            data["created_at"] = routing_msg.created_at.isoformat()
        coord_row = await session.execute(
            select(BotAccount.display_name, BotAccount.username).where(
                BotAccount.bot_id == coordinator_bot_id
            )
        )
        coord_info = coord_row.first()
        if coord_info:
            data["sender_name"] = coord_info[0] or coord_info[1] or ""

        await event_bus.publish(MessageCreated(data=data))
        already_broadcast.add(routing_msg.msg_id)
        created.append(routing_msg)
    except Exception:
        logger.exception(
            "orchestrator: failed to emit routing card channel_id=%s", channel_id,
        )


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

    # Pull stage outputs into local names so the (still-unmigrated) tail
    # of run_orchestrator below reads as before. Subsequent stage commits
    # will progressively eliminate these locals.
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

    # Aliased to ctx so writer-method appends are visible to the legacy
    # tail of run_orchestrator (and to the final return).
    created = ctx.bot_messages
    already_broadcast = ctx.already_broadcast
    root_task_id = ctx.root_task_id

    # Bot @ Bot 自动触发：追踪已触发的 bot 及其发送的消息（用于子回复和循环检测）
    triggered_bot_ids: set[str] = set()  # 已触发过的 bot_id 集合（避免重复触发）
    bot_msg_by_id: dict[str, Message] = {}  # bot_id -> 已创建的消息（用于子回复的 in_reply_to）

    # 最大递归深度：Bot @ Bot 最多触发 3 层
    MAX_BOT_MENTION_DEPTH = 3

    def _extract_bot_mentions_from_content(content: str) -> list[str]:
        """从消息内容中提取频道内 Bot 的 @ 提及。"""
        mentioned = extract_mentions(content or "", channel_bot_usernames)
        return filter_mentioned_bots(mentioned, channel_bot_usernames)

    async def _trigger_sub_bots_from_mentions(
        parent_msg: Message,
        parent_bot_id: str,
        trigger_content: str,
        depth: int,
    ) -> None:
        """递归触发 @ 提及的子 Bot（Bot @ Bot 自动触发）。"""
        if depth >= MAX_BOT_MENTION_DEPTH:
            return

        mentions = _extract_bot_mentions_from_content(parent_msg.content or "")
        for sub_username in mentions:
            sub_bot_id = bot_id_by_username.get(sub_username)
            if not sub_bot_id:
                continue
            # 循环检测：跳过已触发过的 bot
            if sub_bot_id in triggered_bot_ids:
                logger.info("bot_mention_trigger: skip %s (already triggered)", sub_username)
                continue
            # 避免自己调用自己
            if sub_bot_id == parent_bot_id:
                logger.info("bot_mention_trigger: skip %s (self-call)", sub_username)
                continue

            triggered_bot_ids.add(sub_bot_id)
            logger.info(
                "bot_mention_trigger: @%s triggered by bot_id=%s depth=%d",
                sub_username, parent_bot_id, depth,
            )

            sub_adapter = await adapter_factory(sub_bot_id)
            sub_msg = await _pre_create_bot_msg(sub_bot_id, root_task_id)
            # 子回复的 in_reply_to 指向父消息
            sub_msg.in_reply_to_msg_id = parent_msg.msg_id
            await session.flush()

            other_bots = [item for item in channel_bot_usernames if item != sub_username]
            sub_payload = AgentPayload(
                task_id=root_task_id,
                channel_id=channel_id,
                trigger_message={
                    "user": trigger_msg.sender_id,
                    "sender_name": sender_name,
                    "text": trigger_content,
                    "timestamp": trigger_msg.created_at.isoformat() if trigger_msg.created_at else "",
                    "msg_id": trigger_msg.msg_id,
                    "in_reply_to_msg_id": trigger_msg.in_reply_to_msg_id,
                    "topic_chain": topic_chain,
                    "child_replies": child_replies,
                },
                memory_context=memory_context,
                attachments=attachments,
                original_question_text=original_question,
                process_config={
                    "channel_bot_usernames": other_bots,
                    "channel_bot_details": {key: value for key, value in bot_details_by_username.items() if key != sub_username},
                    "bot_id_by_username": {key: value for key, value in bot_id_by_username.items() if key != sub_username},
                    "_adapter_factory": adapter_factory,
                    "_create_and_broadcast": _create_msg_and_broadcast,
                    "_stream_token": _make_stream_token_cb(sub_msg.msg_id),
                    "_event_bus": event_bus,
                    "_db_session": session,
                    "_bot_id": sub_bot_id,
                    "_placeholder_msg_id": sub_msg.msg_id,
                    "_user_secrets": user_secrets,
                    "_sender_name": sender_name,
                    "_channel_name": channel_name,
                },
            )

            try:
                sub_resp = await sub_adapter.execute(sub_payload)
                if sub_resp.dispatched_async:
                    await _register_async_pending(sub_msg, root_task_id, sub_bot_id)
                    await _record_agent_task(sub_bot_id, sub_msg.msg_id)
                    created.append(sub_msg)
                    bot_msg_by_id[sub_bot_id] = sub_msg
                    continue
                sub_content = sub_resp.content if sub_resp.success else (sub_resp.error_message or "处理出错")
                sub_file_ids = sub_resp.file_ids or []
            except Exception as exc:
                logger.warning("bot_mention_trigger: bot %s raised: %s", sub_username, exc)
                sub_content = f"处理出错: {exc}"
                sub_file_ids = []

            await _finalize_bot_msg(sub_msg, sub_content, file_ids=sub_file_ids)
            await _record_agent_task(sub_bot_id, sub_msg.msg_id)
            created.append(sub_msg)
            bot_msg_by_id[sub_bot_id] = sub_msg

            # 递归：检查子 Bot 的回复是否也有 @ 提及
            await _trigger_sub_bots_from_mentions(sub_msg, sub_bot_id, trigger_content, depth + 1)
    _ctx_token = bind_context(channel_id=channel_id, trace_id=root_task_id)
    _ctx_token.__enter__()
    logger.info(
        "orchestrator.start trigger_msg_id=%s targets=%s mention_count=%d",
        trigger_msg.msg_id, target_usernames, len(target_usernames),
    )

    # The bot reply lifecycle (pre-create placeholder → stream → finalize +
    # broadcast + record + arm websocket-bot timeout) is owned by
    # ``ctx.writer``. The aliases below preserve the legacy in-function
    # names so the still-unmigrated dispatch / auto-takeover blocks below
    # keep reading naturally; subsequent stage extractions will eliminate
    # them in favour of direct ``ctx.writer.X`` calls.
    _writer = ctx.writer
    assert _writer is not None
    _create_msg_and_broadcast = _writer.create_and_broadcast
    _pre_create_bot_msg = _writer.pre_create
    _make_stream_token_cb = _writer.make_stream_token_cb
    _finalize_bot_msg = _writer.finalize
    _record_agent_task = _writer.record_task
    _register_async_pending = _writer.register_async_pending

    async def _finish_with_attachment_error(bot_id: str, task_id: str) -> Message:
        bot_msg = await _pre_create_bot_msg(bot_id, task_id)
        await _finalize_bot_msg(bot_msg, attachment_error or "读取上传文件失败")
        await _record_agent_task(bot_id, bot_msg.msg_id)
        created.append(bot_msg)
        return bot_msg

    # ── Coordinator（direct_answer_mode）─────────────────────────────────────
    if COORDINATOR_USERNAME in target_usernames and direct_answer_mode:
        bot_id = bot_id_by_username[COORDINATOR_USERNAME]
        adapter = await adapter_factory(bot_id)
        task_id = root_task_id
        other_bots = [item for item in channel_bot_usernames if item != COORDINATOR_USERNAME]
        if attachment_error:
            await _finish_with_attachment_error(bot_id, task_id)
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
                await _trigger_sub_bots_from_mentions(orch_msg, bot_id, trigger_content, depth=0)

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
                    await _emit_routing_card(
                        channel_id=channel_id,
                        coordinator_bot_id=bot_id,
                        trigger_content=trigger_content,
                        coordinator_content=content,
                        picked_usernames=valid_suggested,
                        session=session,
                        already_broadcast=already_broadcast,
                        created=created,
                        event_bus=event_bus,
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

    # ── 普通 Bot（并发执行）────────────────────────────────────────────────
    regular_targets = [u for u in target_usernames if not (u == COORDINATOR_USERNAME and direct_answer_mode)]

    # 阶段1：串行 broadcast + 预建消息（需要 DB session）
    pending_bots: list[tuple[str, str, Message, AgentPayload, OpenClawAdapter]] = []
    for username in regular_targets:
        bot_id = bot_id_by_username[username]
        if broadcast_processing:
            await broadcast_processing(channel_id, bot_id, username)
        if attachment_error:
            await _finish_with_attachment_error(bot_id, root_task_id)
            continue
        adapter = await adapter_factory(bot_id)
        other_bots = [item for item in channel_bot_usernames if item != username]
        bot_msg = await _pre_create_bot_msg(bot_id, root_task_id)

        payload = AgentPayload(
            task_id=root_task_id,
            channel_id=channel_id,
            trigger_message={
                "user": trigger_msg.sender_id,
                "sender_name": sender_name,
                "text": trigger_content,
                "timestamp": trigger_msg.created_at.isoformat() if trigger_msg.created_at else "",
                "msg_id": trigger_msg.msg_id,
                "in_reply_to_msg_id": trigger_msg.in_reply_to_msg_id,
                "topic_chain": topic_chain,
                "child_replies": child_replies,
            },
            memory_context=memory_context,
            attachments=attachments,
            original_question_text=original_question,
            process_config={
                "channel_bot_usernames": other_bots,
                "channel_bot_details": {key: value for key, value in bot_details_by_username.items() if key != username},
                "bot_id_by_username": {key: value for key, value in bot_id_by_username.items() if key != username},
                "_adapter_factory": adapter_factory,
                "_create_and_broadcast": _create_msg_and_broadcast,
                "_stream_token": _make_stream_token_cb(bot_msg.msg_id),
                "_event_bus": event_bus,
                "_db_session": session,
                "_bot_id": bot_id,
                "_placeholder_msg_id": bot_msg.msg_id,
                "_user_secrets": user_secrets,
                "_sender_name": sender_name,
                "_channel_name": channel_name,
            },
        )
        logger.info(
            "orchestrator: queuing bot bot_id=%s username=%s memory_layers=%d attachments=%d",
            bot_id, username, len(memory_context), len(attachments),
        )
        pending_bots.append((username, bot_id, bot_msg, payload, adapter))

    # 阶段2：并发调用所有 Bot 的 LLM（无 DB 操作）
    if pending_bots:
        async def _timed_execute(adapter, payload):
            t0 = time.perf_counter()
            try:
                return await adapter.execute(payload), (time.perf_counter() - t0) * 1000
            except Exception as exc:
                return exc, (time.perf_counter() - t0) * 1000

        timed_results = await asyncio.gather(
            *[_timed_execute(_adapter, _payload) for _, _, _, _payload, _adapter in pending_bots],
        )
        # 阶段3：串行写库 + 广播（需要 DB session）
        for (username, bot_id, bot_msg, _, _), (resp, dur_ms) in zip(pending_bots, timed_results):
            if isinstance(resp, BaseException):
                logger.warning(
                    "orchestrator: bot %s raised exception: %s duration_ms=%.0f",
                    username, resp, dur_ms,
                )
                content = f"处理出错: {resp}"
                resp_file_ids: list[str] = []
            elif resp.dispatched_async:
                logger.info(
                    "orchestrator: bot %s async-dispatched via bridge duration_ms=%.0f",
                    username, dur_ms,
                )
                await _register_async_pending(bot_msg, root_task_id, bot_id)
                await _record_agent_task(bot_id, bot_msg.msg_id)
                created.append(bot_msg)
                triggered_bot_ids.add(bot_id)
                bot_msg_by_id[bot_id] = bot_msg
                # 异步派发：跳过本同步路径的 finalize 与 Bot@Bot 递归
                continue
            else:
                if not resp.success:
                    logger.warning(
                        "orchestrator: bot %s failed: %s duration_ms=%.0f",
                        username, resp.error_message or "unknown", dur_ms,
                    )
                else:
                    logger.info(
                        "orchestrator: bot %s completed duration_ms=%.0f",
                        username, dur_ms,
                    )
                content = resp.content if resp.success else (resp.error_message or "处理出错")
                resp_file_ids = resp.file_ids or []
            await _finalize_bot_msg(bot_msg, content, file_ids=resp_file_ids)
            await _record_agent_task(bot_id, bot_msg.msg_id)
            created.append(bot_msg)
            triggered_bot_ids.add(bot_id)
            bot_msg_by_id[bot_id] = bot_msg
            # Bot @ Bot 自动触发：递归处理 @ 提及
            await _trigger_sub_bots_from_mentions(bot_msg, bot_id, trigger_content, depth=0)

    total_ms = (time.perf_counter() - t_start) * 1000
    logger.info(
        "orchestrator.done trace_id=%s bot_count=%d duration_ms=%.0f",
        root_task_id, len(created), total_ms,
    )
    _ctx_token.__exit__(None, None, None)
    return created, already_broadcast
