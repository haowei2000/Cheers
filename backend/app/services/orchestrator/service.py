"""Agent Orchestrator：解析 @ 提及、准备附件、调用 Bot，并通过 WebSocket 流式广播。"""
from __future__ import annotations

import asyncio
import logging
import time
import uuid
from collections.abc import Awaitable, Callable

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.log_context import bind_context
from app.db.models import AgentTask, BotAccount, Channel, ChannelMembership, FileRecord, Message, PromptTemplate, User
from app.services.adapters.base import AgentPayload, AgentResponse, OpenClawAdapter
from app.services.admin.settings_store import get_assist_settings
from app.services.file_processor.service import FileFlowError, FilePipelineService
from app.services.orchestrator.mention import extract_mentions, filter_mentioned_bots, resolve_user_mentions
from app.services.orchestrator.orchestrator_adapter import extract_suggested_bots
from app.services.orchestrator.secrets import extract_secret_refs, load_user_secrets
from app.utils.crypto import decrypt_value

logger = logging.getLogger("app.services.orchestrator.service")

COORDINATOR_USERNAME = "Coordinator"


def _is_guide_clarify_reply(content: str) -> bool:
    """判断是否为协调者 Bot 的澄清回答消息（兼容历史名 @引导 / @channel bot 与
    现行名 @Coordinator）."""
    t = (content or "").strip()
    return (
        t.startswith("@Coordinator 澄清回答：")
        or t.startswith("@引导 澄清回答：")
        or t.startswith("@channel bot 澄清回答：")
        or "用户选择跳过澄清" in t
    )


async def _fetch_original_question_for_clarify(
    session: AsyncSession, channel_id: str, trigger_msg: Message
) -> tuple[str | None, list[str]]:
    """
    当 trigger_msg 为澄清回答时，查找并返回原问题文本及其附件 file_ids。
    逻辑：澄清回答前一条应为 Bot 的 guide-clarify 消息，其 in_reply_to_msg_id 指向原问题。
    返回：(原问题文本 | None, 原问题 file_ids 列表)
    """
    r = await session.execute(
        select(Message)
        .where(
            Message.channel_id == channel_id,
            Message.created_at < trigger_msg.created_at,
        )
        .order_by(Message.created_at.desc())
        .limit(5)
    )
    prev_msgs = list(r.scalars().all())
    for m in prev_msgs:
        if m.sender_type != "bot":
            continue
        if "guide-clarify" not in (m.content or ""):
            continue
        orig_id = m.in_reply_to_msg_id
        if not orig_id:
            continue
        orig_r = await session.execute(select(Message).where(Message.msg_id == orig_id))
        orig = orig_r.scalar_one_or_none()
        if orig and orig.sender_type == "user":
            out = (orig.content or "").strip()
            orig_file_ids: list[str] = orig.file_ids or []
            logger.info(
                "orchestrator: fetched original_question for clarify, len=%s file_ids=%s",
                len(out),
                orig_file_ids,
            )
            return out, orig_file_ids
        break
    logger.warning("orchestrator: no original_question found for clarify reply")
    return None, []






def _get_trigger_content(msg: Message) -> str:
    """返回触发消息的真实文本（加密消息自动解密后返回）。"""
    if msg.is_secret and msg.secret_encrypted:
        try:
            return decrypt_value(msg.secret_encrypted)
        except Exception:
            logger.warning("orchestrator: failed to decrypt secret message msg_id=%s", msg.msg_id)
    return msg.content


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
    stream_event: Callable[[str, dict], Awaitable[None]] | None = None,
) -> None:
    """Write a msg_type="routing" Message carrying the coordinator's decision
    (who was picked + a terse plan snippet) and broadcast it over the
    channel WS. Non-fatal: any exception is logged and swallowed so the
    takeover flow continues.
    """
    from app.core.schemas import MessageInResponse
    from app.services.ws_service import ws_manager

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

        await ws_manager.broadcast_to_channel(
            channel_id, {"type": "message", "data": data}
        )
        if stream_event:
            await stream_event("message", data)
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
    broadcast_processing: Callable[[str, str, str], Awaitable[None]] | None = None,
    stream_event: Callable[[str, dict], Awaitable[None]] | None = None,
    *,
    stream_to_ws: bool = True,
) -> tuple[list[Message], set[str]]:
    """根据消息中的 @ 提及和上传文件，串行执行频道内 Bot。"""
    t_start = time.perf_counter()

    result = await session.execute(
        select(ChannelMembership, BotAccount)
        .join(BotAccount, ChannelMembership.member_id == BotAccount.bot_id)
        .where(
            ChannelMembership.channel_id == channel_id,
            ChannelMembership.member_type == "bot",
        )
        .options(
            selectinload(BotAccount.prompt_template),
            selectinload(ChannelMembership.prompt_template),
        )
    )
    rows = result.all()
    channel_bot_usernames = [row[1].username for row in rows]
    bot_id_by_username = {row[1].username: row[1].bot_id for row in rows}
    # 频道级 PromptTemplate 对象覆盖（用于 adapter 的 system_prompt）
    channel_template_override_by_bot_id: dict[str, PromptTemplate] = {}
    for membership, bot in rows:
        if membership.prompt_template:
            channel_template_override_by_bot_id[bot.bot_id] = membership.prompt_template

    # 包装 adapter_factory，注入频道级模板覆盖
    _orig_adapter_factory = adapter_factory
    async def adapter_factory(bot_id: str) -> OpenClawAdapter:
        override = channel_template_override_by_bot_id.get(bot_id)
        if override:
            from app.services.orchestrator.adapter_resolver import get_adapter_for_bot as _get_adapter
            return await _get_adapter(bot_id, session, template_override=override)
        return await _orig_adapter_factory(bot_id)

    bot_details_by_username: dict[str, dict] = {
        row[1].username: {
            "display_name": row[1].display_name or row[1].username,
            "description": row[1].description or "",
            "intro": row[1].intro or "",
        }
        for row in rows
    }

    # analysis_content: 真实文本（解密后），用于提取 @mentions / 密钥引用 / 澄清检测
    # trigger_content:  发送给 LLM 的文本（加密消息保持占位符，不暴露原文）
    analysis_content = _get_trigger_content(trigger_msg)
    is_encrypted_msg = trigger_msg.is_secret and bool(trigger_msg.secret_encrypted)
    trigger_content = trigger_msg.content if is_encrypted_msg else analysis_content

    # 提取并加载用户密钥引用（从真实文本中提取）
    secret_refs = extract_secret_refs(analysis_content)
    user_secrets = {}
    if secret_refs and trigger_msg.sender_type == "user":
        user_secrets = await load_user_secrets(session, trigger_msg.sender_id, secret_refs)
        logger.info(
            "orchestrator: loaded %d/%d secrets for user %s",
            len(user_secrets), len(secret_refs), trigger_msg.sender_id
        )

    # 加密消息：将解密后的原文作为命名密钥注入，LLM 只看到占位符
    if is_encrypted_msg and trigger_msg.sender_type == "user":
        user_secrets["_encrypted_msg"] = analysis_content
        logger.info("orchestrator: encrypted message content injected as _encrypted_msg for user %s", trigger_msg.sender_id)

    # 查询发送者名称和频道名称（供模板变量使用）
    sender_name = ""
    if trigger_msg.sender_type == "user":
        sender_user = await session.get(User, trigger_msg.sender_id)
        sender_name = (sender_user.display_name or sender_user.username) if sender_user else ""
    else:
        sender_bot_result = await session.execute(
            select(BotAccount).where(BotAccount.bot_id == trigger_msg.sender_id)
        )
        sender_bot = sender_bot_result.scalar_one_or_none()
        sender_name = (sender_bot.display_name or sender_bot.username) if sender_bot else ""

    channel_obj = await session.get(Channel, channel_id)
    channel_name = channel_obj.name if channel_obj else ""

    # 澄清场景：若为澄清回答，提取原问题及其附件
    original_question = None
    original_file_ids: list[str] = []
    if _is_guide_clarify_reply(analysis_content):
        original_question, original_file_ids = await _fetch_original_question_for_clarify(session, channel_id, trigger_msg)

    mentioned = extract_mentions(analysis_content, channel_bot_usernames)
    target_usernames = filter_mentioned_bots(mentioned, channel_bot_usernames)
    direct_answer_mode = False
    if not target_usernames:
        channel_auto_assist = bool(channel_obj.auto_assist) if channel_obj else False
        if (
            not mentioned
            and COORDINATOR_USERNAME in channel_bot_usernames
            and channel_auto_assist
        ):
            target_usernames = [COORDINATOR_USERNAME]
            direct_answer_mode = True
            logger.info(
                "orchestrator route -> coordinator channel_id=%s auto_assist=%s",
                channel_id,
                channel_auto_assist,
            )
        else:
            if mentioned:
                logger.warning(
                    "no mentioned bots in channel: channel_id=%s mentioned=%s channel_bots=%s",
                    channel_id,
                    mentioned,
                    channel_bot_usernames,
                )
            return [], set()

    from app.services.memory.manager import load as memory_load

    attachments: list[dict[str, str]] = []
    attachment_error: str | None = None

    async def _load_attachments() -> None:
        nonlocal attachments, attachment_error
        # 优先使用当前触发消息的附件；澄清回答场景下回退到原问题的附件
        file_ids = trigger_msg.file_ids or original_file_ids
        if not file_ids:
            return
        try:
            attachments = await FilePipelineService().prepare_metadata_only(
                session,
                channel_id=channel_id,
                file_ids=file_ids,
            )
            if original_file_ids and not trigger_msg.file_ids:
                logger.info(
                    "orchestrator: restored %d attachment(s) from original clarify question channel=%s",
                    len(attachments),
                    channel_id,
                )
        except FileFlowError as exc:
            attachment_error = exc.detail
        except Exception as exc:
            logger.exception("failed to prepare attachments channel_id=%s", channel_id)
            attachment_error = f"读取上传文件失败：{exc}"

    from app.services.orchestrator.topic_context import (
        MSG_TYPE_REPLY,
        ensure_topic_root,
        gather_topic_context,
    )

    memory_context, _, topic_result = await asyncio.gather(
        memory_load(channel_id, session),
        _load_attachments(),
        gather_topic_context(trigger_msg, session),
    )
    topic_chain, child_replies = topic_result

    # 查出发送者的昵称，注入到 trigger_message 供模板变量 {{sender_name}} 使用
    sender_name = ""
    if trigger_msg.sender_type == "user":
        user_row = await session.execute(
            select(User.display_name, User.username).where(User.user_id == trigger_msg.sender_id)
        )
        user_info = user_row.first()
        if user_info:
            sender_name = user_info[0] or user_info[1] or ""
    elif trigger_msg.sender_type == "bot":
        bot_row = await session.execute(
            select(BotAccount.display_name, BotAccount.username).where(BotAccount.bot_id == trigger_msg.sender_id)
        )
        bot_info = bot_row.first()
        if bot_info:
            sender_name = bot_info[0] or bot_info[1] or ""

    created: list[Message] = []
    already_broadcast: set[str] = set()
    root_task_id = str(uuid.uuid4())

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

    async def _create_msg_and_broadcast(sender_id: str, content: str) -> None:
        from app.core.schemas import MessageInResponse
        from app.services.ws_service import ws_manager

        mention_user_ids = await resolve_user_mentions(content, session, channel_id)
        msg = Message(
            channel_id=channel_id,
            sender_id=sender_id,
            sender_type="bot",
            content=content,
            task_id=root_task_id,
            in_reply_to_msg_id=trigger_msg.msg_id,
            mention_user_ids=mention_user_ids,
            msg_type=MSG_TYPE_REPLY,
        )
        session.add(msg)
        await session.flush()
        # after_insert listener in topic_context.py will flip trigger_msg's
        # row to "topic" once the reply count crosses
        # TOPIC_PROMOTE_THRESHOLD. Mirror the flip into the in-memory
        # Message object so any later code in this request sees the new
        # msg_type without a refresh.
        await ensure_topic_root(session, trigger_msg.msg_id)
        data = MessageInResponse.model_validate(msg).model_dump()
        if msg.created_at:
            data["created_at"] = msg.created_at.isoformat()
        # 查出 bot 的 display_name
        bot_row = await session.execute(
            select(BotAccount.display_name, BotAccount.username).where(BotAccount.bot_id == sender_id)
        )
        bot_info = bot_row.first()
        if bot_info:
            data["sender_name"] = bot_info[0] or bot_info[1] or ""
        await ws_manager.broadcast_to_channel(channel_id, {"type": "message", "data": data})
        if stream_event:
            await stream_event("message", data)
        already_broadcast.add(msg.msg_id)
        created.append(msg)

    async def _pre_create_bot_msg(bot_id: str, task_id: str) -> Message:
        from app.core.schemas import MessageInResponse
        from app.services.ws_service import ws_manager

        msg = Message(
            channel_id=channel_id,
            sender_id=bot_id,
            sender_type="bot",
            content="",
            task_id=task_id,
            in_reply_to_msg_id=trigger_msg.msg_id,
            msg_type=MSG_TYPE_REPLY,
        )
        session.add(msg)
        await session.flush()
        # Same threshold-aware promotion as _create_msg_and_broadcast.
        await ensure_topic_root(session, trigger_msg.msg_id)
        data = MessageInResponse.model_validate(msg).model_dump()
        if msg.created_at:
            data["created_at"] = msg.created_at.isoformat()
        await ws_manager.broadcast_to_channel(channel_id, {"type": "message", "data": data})
        if stream_event:
            await stream_event("bot_message", data)
        already_broadcast.add(msg.msg_id)
        return msg

    def _make_stream_token_cb(msg_id: str):
        from app.services.ws_service import ws_manager as _ws

        async def _cb(delta: str) -> None:
            if stream_to_ws:
                await _ws.broadcast_to_channel(
                    channel_id,
                    {"type": "message_stream", "data": {"msg_id": msg_id, "delta": delta}},
                )
            if stream_event:
                await stream_event("delta", {"msg_id": msg_id, "delta": delta})

        return _cb

    async def _finalize_bot_msg(
        msg: Message, content: str, *, file_ids: list[str] | None = None,
    ) -> None:
        from app.services.ws_service import ws_manager

        msg.content = content
        msg.mention_user_ids = await resolve_user_mentions(content, session, channel_id)
        if file_ids:
            msg.file_ids = list({*(msg.file_ids or []), *file_ids})
        await session.flush()

        done_data: dict = {"msg_id": msg.msg_id, "content": content}
        if msg.file_ids:
            from app.core.schemas import MessageFileInResponse
            result = await session.execute(
                select(FileRecord).where(FileRecord.file_id.in_(msg.file_ids))
            )
            file_map = {r.file_id: r for r in result.scalars().all()}
            done_data["file_ids"] = msg.file_ids
            done_data["files"] = [
                MessageFileInResponse(
                    file_id=r.file_id,
                    original_filename=r.original_filename,
                    content_type=r.content_type,
                    size_bytes=r.size_bytes,
                    status=r.status or "ready",
                ).model_dump()
                for fid in msg.file_ids
                if (r := file_map.get(fid))
            ]
        await ws_manager.broadcast_to_channel(
            channel_id,
            {"type": "message_done", "data": done_data},
        )
        if stream_event:
            await stream_event("done", done_data)

    async def _record_agent_task(bot_id: str, response_msg_id: str) -> None:
        session.add(
            AgentTask(
                task_id=str(uuid.uuid4()),
                channel_id=channel_id,
                bot_id=bot_id,
                trigger_msg_id=trigger_msg.msg_id,
                response_msg_id=response_msg_id,
            )
        )
        await session.flush()

    async def _register_async_pending(bot_msg: Message, task_id: str, bot_id: str) -> None:
        """WebSocket Bot 异步派发：占位消息不立即 finalize，为超时兜底武装 timer。

        PendingReply 已由 WebsocketBotAdapter.execute() 在 dispatch 之前预登记
        （避免 plugin 秒回时 pending 未登记的竞态）；这里只 arm timer。"""
        from app.config import settings as _settings
        from app.db.session import async_session_factory
        from app.services.openclaw_bridge.pending import pending_replies
        from app.services.openclaw_bridge.service import finalize_bot_reply

        timeout_s = max(5, int(_settings.openclaw_bridge_timeout_seconds or 60))

        async def _on_timeout() -> None:
            popped = await pending_replies.pop_by_msg(bot_msg.msg_id)
            if popped is None:
                return  # 已被回推 finalize
            logger.warning(
                "websocket_bot_timeout: bot_id=%s task_id=%s msg_id=%s after %ds",
                bot_id, task_id, bot_msg.msg_id, timeout_s,
            )
            async with async_session_factory() as s2:
                try:
                    await finalize_bot_reply(
                        s2,
                        bot_id=bot_id,
                        channel_id=channel_id,
                        content=f"[WebSocket Bot] 等待 OpenClaw channel plugin 回推超时（>{timeout_s}s）",
                        task_id=task_id,
                        reply_to_msg_id=bot_msg.msg_id,
                    )
                    await s2.commit()
                except Exception:
                    await s2.rollback()
                    raise

        pending = await pending_replies.peek_by_msg(bot_msg.msg_id)
        if pending is None:
            logger.warning(
                "register_async_pending: pending not pre-registered for msg_id=%s; "
                "reply may race",
                bot_msg.msg_id,
            )
            return
        loop = asyncio.get_event_loop()

        def _fire() -> None:
            asyncio.create_task(_on_timeout())

        pending.timeout_handle = loop.call_later(timeout_s, _fire)

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
                        stream_event=stream_event,
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
