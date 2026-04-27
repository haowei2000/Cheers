"""Bridge 服务：把 plugin 回推的 Bot 回复落盘并广播。

抽离出来的理由：orchestrator 内部的 `_finalize_bot_msg` 是闭包，无法从路由里调。
这里提供一个从 bridge 路由调的独立 finalize 实现，行为尽量与 orchestrator 版本一致：
  1. 更新占位 Message.content；
  2. 解析并写入 mention_user_ids；
  3. 合并 file_ids；
  4. 广播 WebSocket `message_done` 事件。

若找不到占位消息（超时被回收或 task_id 不匹配），则创建一条新的 Bot 消息写入频道。
"""
from __future__ import annotations

import logging
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import BotAccount, FileRecord, Message
from app.services.openclaw_bridge.pending import PendingReply, pending_replies
from app.services.openclaw_bridge.streams import StreamState, stream_registry
from app.services.orchestrator.mention import resolve_user_mentions
from app.services.ws_service import ws_manager

logger = logging.getLogger("app.services.openclaw_bridge.service")


async def finalize_bot_reply(
    session: AsyncSession,
    *,
    bot_id: str,
    channel_id: str,
    content: str,
    task_id: str | None = None,
    in_reply_to_msg_id: str | None = None,
    reply_to_msg_id: str | None = None,
    file_ids: list[str] | None = None,
) -> tuple[Message, bool]:
    """把 plugin 回推的回复写入频道；优先 finalize 占位消息，找不到则新建一条。

    Args:
        reply_to_msg_id: 若 plugin 明确知道要 finalize 的占位 msg_id，这里传入；
            否则按 (task_id, bot_id) 兜底匹配 pending registry。
        in_reply_to_msg_id: 该回复的 in_reply_to 字段（指向用户的触发消息）；
            finalize 占位时不修改此字段（占位消息创建时已设好），仅新建时使用。

    Returns:
        (msg, finalized_placeholder)
    """
    pending: PendingReply | None = await pending_replies.resolve(
        task_id=task_id, bot_id=bot_id, msg_id=reply_to_msg_id,
    )
    # If the same msg_id has a streaming buffer (legacy plugin chose `reply`
    # instead of `delta`/`done`), drop it — the full text in `content` wins.
    if pending:
        await stream_registry.pop(pending.msg_id)
    file_ids = list(dict.fromkeys(file_ids or []))

    if pending:
        msg = await session.get(Message, pending.msg_id)
        if msg is None:
            logger.warning(
                "bridge.finalize: pending.msg_id=%s not found, will create new message",
                pending.msg_id,
            )
            pending = None

    if pending:
        msg.content = content
        msg.mention_user_ids = await resolve_user_mentions(content, session, channel_id)
        if file_ids:
            msg.file_ids = list(dict.fromkeys([*(msg.file_ids or []), *file_ids]))
        await session.flush()
        await _broadcast_done(session, msg, file_ids=msg.file_ids or [])
        logger.info(
            "bridge.finalize: finalized placeholder msg_id=%s bot_id=%s task_id=%s",
            msg.msg_id, bot_id, task_id,
        )
        return msg, True

    # 没有占位（超时兜底、或 plugin 主动发起的频道消息）：新建一条
    msg = Message(
        channel_id=channel_id,
        sender_id=bot_id,
        sender_type="bot",
        content=content,
        task_id=task_id,
        in_reply_to_msg_id=in_reply_to_msg_id,
    )
    if file_ids:
        msg.file_ids = file_ids
    session.add(msg)
    await session.flush()
    msg.mention_user_ids = await resolve_user_mentions(content, session, channel_id)
    await session.flush()
    await _broadcast_new(session, msg)
    logger.info(
        "bridge.finalize: created new bot message msg_id=%s bot_id=%s task_id=%s",
        msg.msg_id, bot_id, task_id,
    )
    return msg, False


async def _broadcast_new(session: AsyncSession, msg: Message) -> None:
    from app.core.schemas import MessageInResponse

    data: dict[str, Any] = MessageInResponse.model_validate(msg).model_dump()
    if msg.created_at:
        data["created_at"] = msg.created_at.isoformat()

    bot_row = (await session.execute(
        select(BotAccount.display_name, BotAccount.username).where(BotAccount.bot_id == msg.sender_id)
    )).first()
    if bot_row:
        data["sender_name"] = bot_row[0] or bot_row[1] or ""

    await ws_manager.broadcast_to_channel(msg.channel_id, {"type": "message", "data": data})


async def _broadcast_done(session: AsyncSession, msg: Message, *, file_ids: list[str]) -> None:
    done: dict[str, Any] = {"msg_id": msg.msg_id, "content": msg.content}
    if file_ids:
        from app.core.schemas import MessageFileInResponse

        rows = (await session.execute(
            select(FileRecord).where(FileRecord.file_id.in_(file_ids))
        )).scalars().all()
        file_map = {r.file_id: r for r in rows}
        done["file_ids"] = file_ids
        done["files"] = [
            MessageFileInResponse(
                file_id=r.file_id,
                original_filename=r.original_filename,
                content_type=r.content_type,
                size_bytes=r.size_bytes,
                status=r.status or "ready",
            ).model_dump()
            for fid in file_ids
            if (r := file_map.get(fid)) is not None
        ]
    await ws_manager.broadcast_to_channel(msg.channel_id, {"type": "message_done", "data": done})


# ============================================================================
# Streaming reply path: plugin → delta frames → frontend message_stream events
# ============================================================================


async def register_stream(
    *,
    msg_id: str,
    bot_id: str,
    channel_id: str,
    task_id: str | None = None,
) -> StreamState:
    """Mark a placeholder message as eligible for streaming deltas.

    Called by WebsocketBotAdapter right before dispatching to the plugin; the
    matching plugin reply will arrive as `delta` frames keyed on this msg_id.
    """
    return await stream_registry.register(
        msg_id=msg_id, bot_id=bot_id, channel_id=channel_id, task_id=task_id,
    )


async def apply_delta(
    *,
    msg_id: str,
    bot_id: str,
    seq: int | None,
    delta: str,
) -> bool:
    """Append a streamed delta and broadcast it as a `message_stream` event.

    Returns False if the stream is unknown / wrong bot / already finalized
    (caller should ignore — frame is stale or spoofed). Out-of-order frames
    (`seq <= last_seq`) are dropped with a warning rather than reordered.
    """
    state = await stream_registry.get(msg_id)
    if state is None or state.bot_id != bot_id:
        return False
    async with state.lock:
        if state.finalized:
            return False
        if seq is not None:
            if seq <= state.last_seq:
                logger.warning(
                    "bridge.stream: dropping out-of-order delta msg_id=%s seq=%s last=%s",
                    msg_id, seq, state.last_seq,
                )
                return False
            state.last_seq = seq
        state.buffer += delta or ""
    await ws_manager.broadcast_to_channel(
        state.channel_id,
        {"type": "message_stream", "data": {"msg_id": msg_id, "delta": delta}},
    )
    return True


async def finalize_stream(
    session: AsyncSession,
    *,
    msg_id: str,
    bot_id: str,
    partial: bool = False,
    error: str | None = None,
    file_ids: list[str] | None = None,
) -> Message | None:
    """Flush buffered deltas to the placeholder Message, broadcast message_done.

    Idempotent: if the stream was already finalized (or never registered),
    returns None and does nothing.

    `file_ids` lets the plugin attach binary outputs uploaded during the
    stream (sendMedia path) to the same finalized message so the frontend
    renders text + files as a single bot reply.
    """
    state = await stream_registry.pop(msg_id)
    if state is None:
        return None
    async with state.lock:
        if state.finalized:
            return None
        state.finalized = True
        content = state.buffer

    pending = await pending_replies.resolve(
        task_id=state.task_id, bot_id=bot_id, msg_id=msg_id,
    )
    msg: Message | None = None
    if pending:
        msg = await session.get(Message, pending.msg_id)

    if msg is None:
        logger.warning(
            "bridge.stream.finalize: placeholder missing msg_id=%s; dropping stream", msg_id,
        )
        return None

    msg.content = content
    msg.is_partial = bool(partial)
    msg.mention_user_ids = await resolve_user_mentions(content, session, state.channel_id)
    if file_ids:
        msg.file_ids = list(dict.fromkeys([*(msg.file_ids or []), *file_ids]))
    await session.flush()

    done: dict[str, Any] = {
        "msg_id": msg.msg_id,
        "content": msg.content,
        "is_partial": msg.is_partial,
    }
    if error:
        done["error"] = error
    if msg.file_ids:
        from app.core.schemas import MessageFileInResponse

        rows = (await session.execute(
            select(FileRecord).where(FileRecord.file_id.in_(msg.file_ids))
        )).scalars().all()
        file_map = {r.file_id: r for r in rows}
        done["file_ids"] = msg.file_ids
        done["files"] = [
            MessageFileInResponse(
                file_id=r.file_id,
                original_filename=r.original_filename,
                content_type=r.content_type,
                size_bytes=r.size_bytes,
                status=r.status or "ready",
            ).model_dump()
            for fid in msg.file_ids
            if (r := file_map.get(fid)) is not None
        ]
    await ws_manager.broadcast_to_channel(
        state.channel_id, {"type": "message_done", "data": done},
    )
    logger.info(
        "bridge.stream.finalize: msg_id=%s bot_id=%s partial=%s len=%d files=%d",
        msg_id, bot_id, partial, len(content), len(msg.file_ids or []),
    )
    return msg


async def cancel_stream(
    session: AsyncSession,
    *,
    msg_id: str,
    reason: str = "user_cancelled",
) -> Message | None:
    """User-triggered cancel: flag the stream, notify plugin, finalize partial.

    The cancel frame to the plugin is sent by the route layer (which owns the
    control WS socket) — here we only mark the state and run finalize.
    """
    state = await stream_registry.get(msg_id)
    if state is None:
        return None
    async with state.lock:
        if state.finalized:
            return None
        state.cancel_requested = True
        bot_id = state.bot_id
    return await finalize_stream(
        session, msg_id=msg_id, bot_id=bot_id, partial=True, error=reason,
    )
