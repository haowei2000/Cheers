"""消息线程相关工具。

职责拆分：
- promote_to_thread(msg)：在已加载到 session 里的 Message 上翻 msg_type
  字段，最轻量的形式。调用者必须持有 Message 对象且在同一 session。
- ensure_thread_root(session, msg_id)：仅有 id 时使用。自己 fetch 父消息并
  翻字段。幂等，找不到父消息时安静返回。
- install_auto_promote_listener(): 注册一次，之后任何新 Message 只要带着
  in_reply_to_msg_id 写入库，父消息就会被自动升级。这是防御性兜底，
  让未来新增的写消息路径不必再显式调用 promote_to_thread。

gather_thread_context() 继续只消费 msg_type，不关心谁翻的字段。
"""
from __future__ import annotations

import logging
from typing import Any

from sqlalchemy import event, select
from sqlalchemy.engine import Connection
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import BotAccount, Message, User

logger = logging.getLogger("app.services.orchestrator.thread_context")

MSG_TYPE_NORMAL = "normal"
MSG_TYPE_REPLY = "reply"
MSG_TYPE_THREAD = "thread"
MSG_TYPE_ANNOUNCEMENT = "announcement"
MSG_TYPE_ROUTING = "routing"
MSG_TYPE_PERMISSION = "permission"

# msg_type 值中可以成为 thread 根的集合——非这些的 kind（如 routing / permission /
# announcement）即便带了 in_reply_to_msg_id 也不应被提升为 thread。实际使用中
# 这些类型都不会设置 in_reply_to_msg_id，但显式列出作为文档。
_PROMOTABLE_PARENT_KINDS = {MSG_TYPE_NORMAL, MSG_TYPE_REPLY, MSG_TYPE_THREAD}

_MAX_DEPTH = 10
_MAX_CHILDREN = 20


def promote_to_thread(msg: Message) -> None:
    """In-memory flip: mark `msg` as the root of a thread.

    Idempotent. Callers who already hold the parent Message in their session
    should prefer this over ensure_thread_root because it avoids an extra
    round-trip to the database.
    """
    if msg.msg_type != MSG_TYPE_THREAD:
        msg.msg_type = MSG_TYPE_THREAD


async def ensure_thread_root(
    session: AsyncSession, parent_msg_id: str | None,
) -> Message | None:
    """Given a parent message id (typically from `child.in_reply_to_msg_id`),
    fetch the parent and flip its msg_type to THREAD.

    Returns the parent Message if it existed. Silent on missing parent so a
    stale reply doesn't explode. Caller is responsible for the subsequent
    flush/commit — this keeps the helper composable inside larger
    transactions.
    """
    if not parent_msg_id:
        return None
    parent = await session.get(Message, parent_msg_id)
    if parent is None:
        return None
    promote_to_thread(parent)
    return parent


def _auto_promote_parent(_mapper, connection: Connection, target: Message) -> None:
    """SQLAlchemy after_insert hook: when a Message lands with
    in_reply_to_msg_id, make sure the parent's row is flipped to THREAD.

    Runs as a raw UPDATE on the given connection so it participates in the
    same transaction. Bypasses any ORM-level object state, which means
    in-memory Message instances with the old msg_type won't see the change
    until they are refreshed — callers that care about the in-memory view
    should still call promote_to_thread on the loaded parent explicitly.
    """
    parent_id = target.in_reply_to_msg_id
    if not parent_id:
        return
    tbl = Message.__table__
    connection.execute(
        tbl.update()
        .where(tbl.c.msg_id == parent_id)
        .where(tbl.c.msg_type.in_(tuple(_PROMOTABLE_PARENT_KINDS)))
        .values(msg_type=MSG_TYPE_THREAD),
    )


_listener_installed = False


def install_auto_promote_listener() -> None:
    """Register the after_insert listener once. Idempotent; safe to call at
    module import or from app startup. Intentionally module-level (not
    attached to a specific engine) so it applies to any future session."""
    global _listener_installed
    if _listener_installed:
        return
    event.listen(Message, "after_insert", _auto_promote_parent)
    _listener_installed = True


# Install on import — the listener is a no-op for messages without
# in_reply_to_msg_id, so there's no cost to having it always on.
install_auto_promote_listener()


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
