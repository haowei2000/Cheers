"""消息线程上下文收集器：根据 in_reply_to_msg_id 构建回复链。"""
from __future__ import annotations

import logging
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import BotAccount, Message, User

logger = logging.getLogger("app.services.orchestrator.thread_context")

MSG_TYPE_NORMAL = "normal"
MSG_TYPE_REPLY = "reply"
MSG_TYPE_THREAD = "thread"
MSG_TYPE_ANNOUNCEMENT = "announcement"

_MAX_DEPTH = 10
_MAX_CHILDREN = 20


def promote_to_thread(msg: Message) -> None:
    if msg.msg_type != MSG_TYPE_THREAD:
        msg.msg_type = MSG_TYPE_THREAD


async def _batch_sender_names(msgs: list[Message], session: AsyncSession) -> dict[str, str]:
    if not msgs:
        return {}
    user_ids = [m.sender_id for m in msgs if m.sender_type == "user"]
    bot_ids = [m.sender_id for m in msgs if m.sender_type != "user"]
    name_map: dict[str, str] = {}
    if user_ids:
        rows = await session.execute(
            select(User.user_id, User.display_name, User.username).where(User.user_id.in_(user_ids))
        )
        for uid, dname, uname in rows:
            name_map[uid] = dname or uname or ""
    if bot_ids:
        rows = await session.execute(
            select(BotAccount.bot_id, BotAccount.display_name, BotAccount.username).where(
                BotAccount.bot_id.in_(bot_ids)
            )
        )
        for bid, dname, uname in rows:
            name_map[bid] = dname or uname or ""
    return name_map


def _to_dict(msg: Message, name: str) -> dict[str, Any]:
    text = "[加密消息]" if msg.is_secret else (msg.content or "")
    return {
        "msg_id": msg.msg_id,
        "sender_name": name,
        "sender_type": msg.sender_type,
        "text": text,
        "timestamp": msg.created_at.isoformat() if msg.created_at else "",
        "in_reply_to_msg_id": msg.in_reply_to_msg_id,
    }


async def gather_thread_context(
    trigger_msg: Message,
    session: AsyncSession,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """
    收集触发消息的线程上下文，基于 msg_type 判断规则：

    - 规则1: normal，无子回复          → ([], [])
    - 规则2: reply，链深度=1           → ([parent], [])
    - 规则3: reply，链深度>1           → ([ancestor...], [])
    - 规则4: thread，已有子回复         → ([], [child...])

    Returns:
        (thread_chain, child_replies)
    """
    if trigger_msg.msg_type == MSG_TYPE_REPLY and trigger_msg.in_reply_to_msg_id:
        # 规则2/3：沿 in_reply_to_msg_id 链向上收集祖先消息
        msgs_in_chain: list[Message] = []
        current_id: str | None = trigger_msg.in_reply_to_msg_id
        visited: set[str] = set()
        while current_id and len(msgs_in_chain) < _MAX_DEPTH:
            if current_id in visited:
                break
            visited.add(current_id)
            r = await session.execute(select(Message).where(Message.msg_id == current_id))
            msg = r.scalar_one_or_none()
            if not msg:
                break
            msgs_in_chain.append(msg)
            current_id = msg.in_reply_to_msg_id
        msgs_in_chain.reverse()  # oldest first
        name_map = await _batch_sender_names(msgs_in_chain, session)
        return [_to_dict(m, name_map.get(m.sender_id, "")) for m in msgs_in_chain], []

    if trigger_msg.msg_type == MSG_TYPE_THREAD:
        # 规则4：当前消息是线程串根，拉取已有子回复作为上下文
        r = await session.execute(
            select(Message)
            .where(Message.in_reply_to_msg_id == trigger_msg.msg_id)
            .order_by(Message.created_at.asc())
            .limit(_MAX_CHILDREN)
        )
        children = list(r.scalars().all())
        name_map = await _batch_sender_names(children, session)
        return [], [_to_dict(c, name_map.get(c.sender_id, "")) for c in children]

    return [], []
