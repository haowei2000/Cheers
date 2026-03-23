"""Agent Orchestrator：解析 @ 提及、准备附件、调用 Bot，并通过 WebSocket 流式广播。"""
from __future__ import annotations

import logging
import uuid
from collections.abc import Awaitable, Callable

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.adapters.base import AgentPayload, AgentResponse, OpenClawAdapter
from app.admin.settings_store import get_assist_settings
from app.db.models import AgentTask, BotAccount, Channel, ChannelMembership, Message
from app.file_processor.service import FileFlowError, FilePipelineService
from app.orchestrator.mention import extract_mentions, filter_mentioned_bots
from app.orchestrator.orchestrator_adapter import extract_suggested_bots

logger = logging.getLogger("app.orchestrator.service")

COORDINATOR_USERNAME = "channel bot"


def _is_guide_clarify_reply(content: str) -> bool:
    """判断是否为引导 Bot 的澄清回答消息（兼容 @引导 与 @channel bot）."""
    t = (content or "").strip()
    return (
        t.startswith("@引导 澄清回答：")
        or t.startswith("@channel bot 澄清回答：")
        or "用户选择跳过澄清" in t
    )


async def _fetch_original_question_for_clarify(
    session: AsyncSession, channel_id: str, trigger_msg: Message
) -> str | None:
    """
    当 trigger_msg 为澄清回答时，查找并返回原问题文本。
    逻辑：澄清回答前一条应为 Bot 的 guide-clarify 消息，其 in_reply_to_msg_id 指向原问题。
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
            logger.info(
                "orchestrator: fetched original_question for clarify, len=%s",
                len(out),
            )
            return out
        break
    logger.warning("orchestrator: no original_question found for clarify reply")
    return None


def _apply_prompt_template(template: str | None, user_message: str) -> str:
    """应用 Bot 的 user_template。"""
    if not template:
        return user_message
    result = template.replace("{{}}", user_message)
    result = result.replace("{{message}}", user_message)
    return result


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

    result = await session.execute(
        select(ChannelMembership, BotAccount)
        .join(BotAccount, ChannelMembership.member_id == BotAccount.bot_id)
        .where(
            ChannelMembership.channel_id == channel_id,
            ChannelMembership.member_type == "bot",
        )
    )
    rows = result.all()
    channel_bot_usernames = [row[1].username for row in rows]
    bot_id_by_username = {row[1].username: row[1].bot_id for row in rows}
    bot_template_by_username = {
        row[1].username: (row[1].prompt_template.user_template if row[1].prompt_template else None)
        for row in rows
    }
    bot_details_by_username: dict[str, dict] = {
        row[1].username: {
            "display_name": row[1].display_name or row[1].username,
            "description": row[1].description or "",
            "intro": row[1].intro or "",
        }
        for row in rows
    }

    mentioned = extract_mentions(trigger_msg.content)
    target_usernames = filter_mentioned_bots(mentioned, channel_bot_usernames, text=trigger_msg.content)
    direct_answer_mode = False
    if not target_usernames:
        channel_result = await session.execute(select(Channel).where(Channel.channel_id == channel_id))
        channel_obj = channel_result.scalar_one_or_none()
        channel_auto_assist = bool(channel_obj.auto_assist) if channel_obj else False
        has_uploaded_files = bool(trigger_msg.file_ids)
        if (
            not mentioned
            and COORDINATOR_USERNAME in channel_bot_usernames
            and (has_uploaded_files or channel_auto_assist)
        ):
            target_usernames = [COORDINATOR_USERNAME]
            direct_answer_mode = True
            logger.info(
                "orchestrator route -> coordinator channel_id=%s has_files=%s",
                channel_id,
                has_uploaded_files,
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

    from app.memory.manager import load as memory_load

    memory_context = await memory_load(channel_id)
    attachments: list[dict[str, str]] = []
    attachment_error: str | None = None
    if trigger_msg.file_ids:
        try:
            attachments = await FilePipelineService().prepare_attachments(
                session,
                channel_id=channel_id,
                file_ids=trigger_msg.file_ids,
            )
        except FileFlowError as exc:
            attachment_error = exc.detail
        except Exception as exc:
            logger.exception("failed to prepare attachments channel_id=%s", channel_id)
            attachment_error = f"读取上传文件失败：{exc}"

    created: list[Message] = []
    already_broadcast: set[str] = set()
    root_task_id = str(uuid.uuid4())

    async def _create_msg_and_broadcast(sender_id: str, content: str) -> None:
        from app.chat_core.schemas import MessageInResponse
        from app.chat_core.ws_manager import ws_manager

        msg = Message(
            channel_id=channel_id,
            sender_id=sender_id,
            sender_type="bot",
            content=content,
            task_id=root_task_id,
            in_reply_to_msg_id=trigger_msg.msg_id,
        )
        session.add(msg)
        await session.flush()
        data = MessageInResponse.model_validate(msg).model_dump()
        if msg.created_at:
            data["created_at"] = msg.created_at.isoformat()
        await ws_manager.broadcast_to_channel(channel_id, {"type": "message", "data": data})
        if stream_event:
            await stream_event("message", data)
        already_broadcast.add(msg.msg_id)
        created.append(msg)

    async def _pre_create_bot_msg(bot_id: str, task_id: str) -> Message:
        from app.chat_core.schemas import MessageInResponse
        from app.chat_core.ws_manager import ws_manager

        msg = Message(
            channel_id=channel_id,
            sender_id=bot_id,
            sender_type="bot",
            content="",
            task_id=task_id,
            in_reply_to_msg_id=trigger_msg.msg_id,
        )
        session.add(msg)
        await session.flush()
        data = MessageInResponse.model_validate(msg).model_dump()
        if msg.created_at:
            data["created_at"] = msg.created_at.isoformat()
        await ws_manager.broadcast_to_channel(channel_id, {"type": "message", "data": data})
        if stream_event:
            await stream_event("bot_message", data)
        already_broadcast.add(msg.msg_id)
        return msg

    def _make_stream_token_cb(msg_id: str):
        from app.chat_core.ws_manager import ws_manager as _ws

        async def _cb(delta: str) -> None:
            if stream_to_ws:
                await _ws.broadcast_to_channel(
                    channel_id,
                    {"type": "message_stream", "data": {"msg_id": msg_id, "delta": delta}},
                )
            if stream_event:
                await stream_event("delta", {"msg_id": msg_id, "delta": delta})

        return _cb

    async def _finalize_bot_msg(msg: Message, content: str) -> None:
        from app.chat_core.ws_manager import ws_manager

        msg.content = content
        await session.flush()
        await ws_manager.broadcast_to_channel(
            channel_id,
            {"type": "message_done", "data": {"msg_id": msg.msg_id, "content": content}},
        )
        if stream_event:
            await stream_event("done", {"msg_id": msg.msg_id, "content": content})

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

    async def _finish_with_attachment_error(bot_id: str, task_id: str) -> Message:
        bot_msg = await _pre_create_bot_msg(bot_id, task_id)
        await _finalize_bot_msg(bot_msg, attachment_error or "读取上传文件失败")
        await _record_agent_task(bot_id, bot_msg.msg_id)
        created.append(bot_msg)
        return bot_msg

    for username in target_usernames:
        bot_id = bot_id_by_username[username]

        if username == COORDINATOR_USERNAME and direct_answer_mode:
            adapter = await adapter_factory(bot_id)
            task_id = root_task_id
            other_bots = [item for item in channel_bot_usernames if item != COORDINATOR_USERNAME]
            if attachment_error:
                await _finish_with_attachment_error(bot_id, task_id)
                continue

            orch_msg = await _pre_create_bot_msg(bot_id, task_id)
            payload = AgentPayload(
                task_id=task_id,
                channel_id=channel_id,
                trigger_message={
                    "user": trigger_msg.sender_id,
                    "text": trigger_msg.content,
                    "timestamp": trigger_msg.created_at.isoformat() if trigger_msg.created_at else "",
                },
                memory_context=memory_context,
                attachments=attachments,
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
                },
            )
            resp: AgentResponse = await adapter.execute(payload)
            content = resp.content if resp.success else (resp.error_message or "处理出错")
            await _finalize_bot_msg(orch_msg, content)
            await _record_agent_task(bot_id, orch_msg.msg_id)
            created.append(orch_msg)

            orch_settings = get_assist_settings()
            if orch_settings.get("auto_takeover"):
                suggested = extract_suggested_bots(content)
                for sug_username in suggested:
                    if sug_username not in channel_bot_usernames or sug_username == COORDINATOR_USERNAME:
                        continue
                    sug_bot_id = bot_id_by_username[sug_username]
                    sug_template = bot_template_by_username.get(sug_username)
                    if broadcast_processing:
                        await broadcast_processing(channel_id, sug_bot_id, sug_username)
                    sug_adapter = await adapter_factory(sug_bot_id)
                    sug_task_id = root_task_id
                    sug_templated_text = _apply_prompt_template(sug_template, trigger_msg.content)
                    sug_msg = await _pre_create_bot_msg(sug_bot_id, sug_task_id)
                    sug_payload = AgentPayload(
                        task_id=sug_task_id,
                        channel_id=channel_id,
                        trigger_message={
                            "user": trigger_msg.sender_id,
                            "text": sug_templated_text,
                            "timestamp": trigger_msg.created_at.isoformat() if trigger_msg.created_at else "",
                        },
                        memory_context=memory_context,
                        attachments=attachments,
                        process_config={"_stream_token": _make_stream_token_cb(sug_msg.msg_id)},
                    )
                    sug_resp: AgentResponse = await sug_adapter.execute(sug_payload)
                    sug_content = sug_resp.content if sug_resp.success else (sug_resp.error_message or "处理出错")
                    await _finalize_bot_msg(sug_msg, sug_content)
                    await _record_agent_task(sug_bot_id, sug_msg.msg_id)
                    created.append(sug_msg)
                    logger.info("orchestrator_auto_takeover: triggered @%s", sug_username)
            continue

        if broadcast_processing:
            await broadcast_processing(channel_id, bot_id, username)
        adapter = await adapter_factory(bot_id)
        task_id = root_task_id
        bot_template = bot_template_by_username.get(username)
        templated_text = _apply_prompt_template(bot_template, trigger_msg.content)
        other_bots = [item for item in channel_bot_usernames if item != username]
        if attachment_error:
            await _finish_with_attachment_error(bot_id, task_id)
            continue

        bot_msg = await _pre_create_bot_msg(bot_id, task_id)
        payload = AgentPayload(
            task_id=task_id,
            channel_id=channel_id,
            trigger_message={
                "user": trigger_msg.sender_id,
                "text": templated_text,
                "timestamp": trigger_msg.created_at.isoformat() if trigger_msg.created_at else "",
            },
            memory_context=memory_context,
            attachments=attachments,
            process_config={
                "channel_bot_usernames": other_bots,
                "channel_bot_details": {key: value for key, value in bot_details_by_username.items() if key != username},
                "bot_id_by_username": {key: value for key, value in bot_id_by_username.items() if key != username},
                "_adapter_factory": adapter_factory,
                "_create_and_broadcast": _create_msg_and_broadcast,
                "_stream_token": _make_stream_token_cb(bot_msg.msg_id),
                "_db_session": session,
            },
        )
        logger.info("orchestrator: calling bot bot_id=%s username=%s", bot_id, username)
        resp: AgentResponse = await adapter.execute(payload)
        if not resp.success:
            logger.warning("orchestrator: bot %s failed: %s", username, resp.error_message or "unknown")
        content = resp.content if resp.success else (resp.error_message or "处理出错")
        await _finalize_bot_msg(bot_msg, content)
        await _record_agent_task(bot_id, bot_msg.msg_id)
        created.append(bot_msg)

    return created, already_broadcast
