"""AgentOrchestrator：收到 @Bot 消息后构造 Payload、调 Adapter、回写 Bot 消息；支持 Coordinator 主控聚合与 Orchestrator 直接回答。"""
import logging
import uuid
from typing import Callable, Awaitable

from sqlalchemy import select

logger = logging.getLogger("app.orchestrator.service")
from sqlalchemy.ext.asyncio import AsyncSession

from app.adapters.base import AgentPayload, AgentResponse, OpenClawAdapter
from app.admin.settings_store import get_orchestrator_settings
from app.db.models import AgentTask, BotAccount, ChannelMembership, Message
from app.orchestrator.mention import extract_mentions, filter_mentioned_bots
from app.orchestrator.orchestrator_adapter import extract_suggested_bots

COORDINATOR_USERNAME = "channel bot"


def _apply_prompt_template(template: str | None, user_message: str) -> str:
    """应用提示词模板，将 {{}} 替换为用户消息.
    
    Args:
        template: 提示词模板，包含 {{}} 作为用户消息占位符
        user_message: 原始用户消息
        
    Returns:
        应用模板后的消息内容
    """
    if not template:
        return user_message
    # 支持 {{}} 或 {{message}} 作为占位符
    result = template.replace("{{}}", user_message)
    result = result.replace("{{message}}", user_message)
    return result


async def run_orchestrator(
    channel_id: str,
    trigger_msg: Message,
    session: AsyncSession,
    adapter_factory: Callable[[str], Awaitable[OpenClawAdapter]],
    broadcast_processing: Callable[[str, str, str], Awaitable[None]] | None = None,
) -> tuple[list[Message], set[str]]:
    """
    根据触发消息中的 @ 提及，解析出目标 Bot，串行调用 Adapter。

    返回 (created_messages, already_broadcast_ids)：
    - created_messages: 本次创建的所有 Bot 消息
    - already_broadcast_ids: 已经由 Agent Loop 内部广播过的消息 msg_id 集合，
      调用方广播时应跳过这些，避免重复推送。
    """
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
    # Bot 详情（供内置助手判断路由）
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
        orch_settings = get_orchestrator_settings()
        if orch_settings.get("orchestrator_direct_answer") and COORDINATOR_USERNAME in channel_bot_usernames:
            target_usernames = [COORDINATOR_USERNAME]
            direct_answer_mode = True
            logger.info("orchestrator_direct_answer: routing to coordinator, channel_id=%s", channel_id)
        else:
            if mentioned:
                logger.warning(
                    "no mentioned bots in channel: channel_id=%s mentioned=%s channel_bots=%s (Bot 可能未加入该频道，请在「添加成员」或聊天内 @ 邀请)",
                    channel_id, mentioned, channel_bot_usernames,
                )
            return []

    from app.memory.manager import load as memory_load
    memory_context = await memory_load(channel_id)

    created: list[Message] = []
    already_broadcast: set[str] = set()
    # 顶层任务线程 id：同一轮 run_orchestrator 调用内统一使用
    root_task_id = str(uuid.uuid4())

    # Agent Loop 回调：在频道内创建 Bot 消息并立即广播（用于 call_bot 工具结果可见性）
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
        bd = MessageInResponse.model_validate(msg).model_dump()
        if msg.created_at:
            bd["created_at"] = msg.created_at.isoformat()
        await ws_manager.broadcast_to_channel(channel_id, {"type": "message", "data": bd})
        already_broadcast.add(msg.msg_id)
        created.append(msg)

    for username in target_usernames:
        bot_id = bot_id_by_username[username]
        if username == COORDINATOR_USERNAME and direct_answer_mode:
            # 直接回答模式：用 OrchestratorAdapter 回答业务问题（不应用模板，因为是系统 Bot）
            adapter = await adapter_factory(bot_id)
            task_id = root_task_id
            other_bots = [u for u in channel_bot_usernames if u != COORDINATOR_USERNAME]
            payload = AgentPayload(
                task_id=task_id,
                channel_id=channel_id,
                trigger_message={
                    "user": trigger_msg.sender_id,
                    "text": trigger_msg.content,
                    "timestamp": trigger_msg.created_at.isoformat() if trigger_msg.created_at else "",
                },
                memory_context=memory_context,
                attachments=[],
                process_config={
                    "channel_bot_usernames": other_bots,
                    "channel_bot_details": {k: v for k, v in bot_details_by_username.items() if k != COORDINATOR_USERNAME},
                    "bot_id_by_username": {k: v for k, v in bot_id_by_username.items() if k != COORDINATOR_USERNAME},
                    "_adapter_factory": adapter_factory,
                    "_create_and_broadcast": _create_msg_and_broadcast,
                },
            )
            resp: AgentResponse = await adapter.execute(payload)
            content = resp.content if resp.success else (resp.error_message or "处理出错")
            orch_msg = Message(
                channel_id=channel_id,
                sender_id=bot_id,
                sender_type="bot",
                content=content,
                task_id=task_id,
                in_reply_to_msg_id=trigger_msg.msg_id,
            )
            session.add(orch_msg)
            await session.flush()
            task_record = AgentTask(
                task_id=str(uuid.uuid4()),
                channel_id=channel_id,
                bot_id=bot_id,
                trigger_msg_id=trigger_msg.msg_id,
                response_msg_id=orch_msg.msg_id,
            )
            session.add(task_record)
            await session.flush()
            created.append(orch_msg)
            # 自动接手：解析「建议 @xxx」，若开启则触发被建议的 Bot
            orch_settings = get_orchestrator_settings()
            if orch_settings.get("orchestrator_auto_takeover"):
                suggested = extract_suggested_bots(content)
                for sug_username in suggested:
                    if sug_username in channel_bot_usernames and sug_username != COORDINATOR_USERNAME:
                        sug_bot_id = bot_id_by_username[sug_username]
                        sug_template = bot_template_by_username.get(sug_username)
                        if broadcast_processing:
                            await broadcast_processing(channel_id, sug_bot_id, sug_username)
                        sug_adapter = await adapter_factory(sug_bot_id)
                        # 建议接力的 Bot 调用仍归属于同一顶层任务线程
                        sug_task_id = root_task_id
                        # 应用被建议 Bot 的提示词模板
                        sug_templated_text = _apply_prompt_template(sug_template, trigger_msg.content)
                        sug_payload = AgentPayload(
                            task_id=sug_task_id,
                            channel_id=channel_id,
                            trigger_message={
                                "user": trigger_msg.sender_id,
                                "text": sug_templated_text,
                                "timestamp": trigger_msg.created_at.isoformat() if trigger_msg.created_at else "",
                            },
                            memory_context=memory_context,
                            attachments=[],
                        )
                        sug_resp: AgentResponse = await sug_adapter.execute(sug_payload)
                        sug_content = sug_resp.content if sug_resp.success else (sug_resp.error_message or "处理出错")
                        sug_msg = Message(
                            channel_id=channel_id,
                            sender_id=sug_bot_id,
                            sender_type="bot",
                            content=sug_content,
                            task_id=sug_task_id,
                            in_reply_to_msg_id=trigger_msg.msg_id,
                        )
                        session.add(sug_msg)
                        await session.flush()
                        session.add(AgentTask(
                            task_id=str(uuid.uuid4()),
                            channel_id=channel_id,
                            bot_id=sug_bot_id,
                            trigger_msg_id=trigger_msg.msg_id,
                            response_msg_id=sug_msg.msg_id,
                        ))
                        await session.flush()
                        created.append(sug_msg)
                        logger.info("orchestrator_auto_takeover: triggered @%s", sug_username)
            continue  # already handled coordinator case above

        if broadcast_processing:
            await broadcast_processing(channel_id, bot_id, username)
        adapter = await adapter_factory(bot_id)
        # 普通显式 @Bot 串行场景：同一 run_orchestrator 内共用 root_task_id 作为线程 id
        task_id = root_task_id
        # 应用该 Bot 的提示词模板
        bot_template = bot_template_by_username.get(username)
        templated_text = _apply_prompt_template(bot_template, trigger_msg.content)
        other_bots = [u for u in channel_bot_usernames if u != username]
        payload = AgentPayload(
            task_id=task_id,
            channel_id=channel_id,
            trigger_message={
                "user": trigger_msg.sender_id,
                "text": templated_text,
                "timestamp": trigger_msg.created_at.isoformat() if trigger_msg.created_at else "",
            },
            memory_context=memory_context,
            attachments=[],
            process_config={
                "channel_bot_usernames": other_bots,
                "channel_bot_details": {k: v for k, v in bot_details_by_username.items() if k != username},
                "bot_id_by_username": {k: v for k, v in bot_id_by_username.items() if k != username},
                "_adapter_factory": adapter_factory,
                "_create_and_broadcast": _create_msg_and_broadcast,
            },
        )
        logger.info("orchestrator: calling bot bot_id=%s username=%s endpoint=...", bot_id, username)
        resp: AgentResponse = await adapter.execute(payload)
        if not resp.success:
            logger.warning("orchestrator: bot %s failed: %s", username, resp.error_message or "unknown")
        content = resp.content if resp.success else (resp.error_message or "处理出错")
        bot_msg = Message(
            channel_id=channel_id,
            sender_id=bot_id,
            sender_type="bot",
            content=content,
            task_id=task_id,
            in_reply_to_msg_id=trigger_msg.msg_id,
        )
        session.add(bot_msg)
        await session.flush()
        task_record = AgentTask(
            task_id=str(uuid.uuid4()),
            channel_id=channel_id,
            bot_id=bot_id,
            trigger_msg_id=trigger_msg.msg_id,
            response_msg_id=bot_msg.msg_id,
        )
        session.add(task_record)
        await session.flush()
        created.append(bot_msg)
    return created, already_broadcast
