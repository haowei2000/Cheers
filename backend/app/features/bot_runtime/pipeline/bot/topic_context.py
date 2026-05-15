"""消息主题（topic）相关工具。

职责拆分：
- promote_to_topic(msg)：在已加载到 session 里的 Message 上翻 msg_type
  字段，最轻量的形式。调用者必须持有 Message 对象且在同一 session。
- ensure_topic_root(session, msg_id)：仅有 id 时使用。自己 fetch 父消息并
  翻字段。幂等，找不到父消息时安静返回。
- install_auto_promote_listener(): 注册一次，之后任何新 Message 只要带着
  in_reply_to_msg_id 写入库，父消息就会被自动升级为 topic 根。

gather_topic_context() 继续只消费 msg_type，不关心谁翻的字段。
"""
from __future__ import annotations

import logging
from typing import Any, cast

from sqlalchemy import event, func, select
from sqlalchemy.engine import Connection
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.sql.schema import Table

from app.db.models import BotAccount, Channel, Message, User
from app.services.secret_messages import secret_placeholder_for

logger = logging.getLogger("app.features.bot_runtime.pipeline.bot.topic_context")

MSG_TYPE_NORMAL = "normal"
MSG_TYPE_REPLY = "reply"
MSG_TYPE_TOPIC = "topic"
MSG_TYPE_ANNOUNCEMENT = "announcement"
MSG_TYPE_ROUTING = "routing"
MSG_TYPE_PERMISSION = "permission"

# msg_type values that may become topic roots. Other kinds such as routing,
# permission, or announcement should not be promoted to topics even if they carry
# in_reply_to_msg_id. They do not set in_reply_to_msg_id in practice, but the
# explicit list documents the contract.
_PROMOTABLE_PARENT_KINDS = {MSG_TYPE_NORMAL, MSG_TYPE_REPLY, MSG_TYPE_TOPIC}

# Minimum number of replies required to promote a normal message to a topic root.
# Below this threshold, the UI displays a parent message with a few inline replies
# instead of wrapping it as a topic. Keep frontend/src/lib/message.ts in sync.
TOPIC_PROMOTE_THRESHOLD = 4

_MAX_DEPTH = 10
_MAX_CHILDREN = 20


def promote_to_topic(msg: Message) -> None:
    """In-memory flip: mark `msg` as the root of a topic.

    Idempotent. Note: this bypasses the TOPIC_PROMOTE_THRESHOLD check —
    callers that want the gated behaviour must use ensure_topic_root
    instead. Kept as a low-level primitive so tests and advanced callers
    can force a promotion when needed.
    """
    if msg.msg_type != MSG_TYPE_TOPIC:
        msg.msg_type = MSG_TYPE_TOPIC


async def _count_replies(
    session: AsyncSession, parent_msg_id: str
) -> int:
    """How many messages currently point at this parent via
    in_reply_to_msg_id? Used to gate topic promotion on a minimum
    reply count (see TOPIC_PROMOTE_THRESHOLD)."""
    r = await session.execute(
        select(func.count())
        .select_from(Message)
        .where(Message.in_reply_to_msg_id == parent_msg_id)
    )
    return int(r.scalar() or 0)


async def ensure_topic_root(
    session: AsyncSession, parent_msg_id: str | None,
) -> Message | None:
    """Given a parent message id (typically from
    `child.in_reply_to_msg_id`), promote it to TOPIC — but only if the
    reply count has reached TOPIC_PROMOTE_THRESHOLD.

    Returns the parent Message if it existed, otherwise None. Silent on
    missing parent (a stale reply pointing nowhere doesn't explode).
    Idempotent: calling repeatedly after promotion is a no-op. Caller is
    responsible for the subsequent flush/commit.
    """
    if not parent_msg_id:
        return None
    parent = await session.get(Message, parent_msg_id)
    if parent is None:
        return None
    if parent.msg_type == MSG_TYPE_TOPIC:
        return parent
    if parent.msg_type not in _PROMOTABLE_PARENT_KINDS:
        return parent
    count = await _count_replies(session, parent_msg_id)
    if count < TOPIC_PROMOTE_THRESHOLD:
        return parent
    promote_to_topic(parent)
    return parent


def _auto_promote_parent(_mapper, connection: Connection, target: Message) -> None:
    """SQLAlchemy after_insert hook: when a Message lands with
    in_reply_to_msg_id, check whether the parent has now accumulated
    TOPIC_PROMOTE_THRESHOLD replies and, if so, flip its msg_type to
    TOPIC in the same transaction.

    Uses raw UPDATE / SELECT on the given connection so it participates
    in the transaction that inserted the reply. The new row has already
    been inserted on this connection by the time after_insert fires, so
    the COUNT below sees it.

    Caveat: bypasses ORM object state, so an in-memory Message held by
    the caller won't auto-reflect the new msg_type. Callers that need
    in-memory consistency should call ensure_topic_root explicitly.
    """
    parent_id = target.in_reply_to_msg_id
    if not parent_id:
        return
    channel_tbl = cast(Table, Channel.__table__)
    channel_type_q = (
        select(channel_tbl.c.type)
        .where(channel_tbl.c.channel_id == target.channel_id)
        .limit(1)
    )
    if connection.execute(channel_type_q).scalar() == "dm":
        return
    tbl = cast(Table, Message.__table__)
    count_q = (
        select(func.count())
        .select_from(tbl)
        .where(tbl.c.in_reply_to_msg_id == parent_id)
    )
    count = int(connection.execute(count_q).scalar() or 0)
    if count < TOPIC_PROMOTE_THRESHOLD:
        return
    connection.execute(
        tbl.update()
        .where(tbl.c.msg_id == parent_id)
        .where(tbl.c.msg_type.in_(tuple(_PROMOTABLE_PARENT_KINDS)))
        .values(msg_type=MSG_TYPE_TOPIC),
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
    text = secret_placeholder_for(msg.msg_id) if msg.is_secret else (msg.content or "")
    return {
        "msg_id": msg.msg_id,
        "sender_name": name,
        "sender_type": msg.sender_type,
        "text": text,
        "timestamp": msg.created_at.isoformat() if msg.created_at else "",
        "in_reply_to_msg_id": msg.in_reply_to_msg_id,
        "msg_type": msg.msg_type,
    }


async def gather_topic_context(
    trigger_msg: Message,
    session: AsyncSession,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """
    收集触发消息的主题上下文，基于 msg_type 判断规则：

    - 规则1: normal，无子回复          → ([], [])
    - 规则2: reply，链深度=1           → ([parent], [])
    - 规则3: reply，链深度>1           → ([ancestor...], [])
    - 规则4: topic，已有子回复          → ([], [child...])

    Returns:
        (topic_chain, child_replies)
    """
    if trigger_msg.msg_type == MSG_TYPE_REPLY and trigger_msg.in_reply_to_msg_id:
        # Rules 2/3: collect ancestor messages along the in_reply_to_msg_id chain.
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

    if trigger_msg.msg_type == MSG_TYPE_TOPIC:
        # Rule 4: current message is a topic root, so fetch existing child replies as context.
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
