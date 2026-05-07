"""Bridge 服务：把 plugin 回推的 Bot 回复落盘并广播。

抽离出来的理由：orchestrator 内部的 `_finalize_bot_msg` 是闭包，无法从路由里调。
这里提供一个从 bridge 路由调的独立 finalize 实现，行为尽量与 orchestrator 版本一致：
  1. 更新占位 Message.content；
  2. 解析并写入 mention_user_ids；
  3. 合并 file_ids；
  4. 广播 WebSocket `message_done` 事件。

若找不到占位消息（task_id 不匹配或服务重启后 registry 丢失），则创建一条新的 Bot 消息写入频道。
"""
from __future__ import annotations

import asyncio
import logging
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.application.chat.message_assembler import MessageAssembler
from app.db.models import BotAccount, FileRecord, Message
from app.features.agent_bridge.pending import PendingReply, pending_replies
from app.features.agent_bridge.streams import StreamState, stream_registry
from app.features.bot_runtime.pipeline.bot.mention import resolve_user_mentions
from app.features.bot_runtime.pipeline.bus import WSEventBus
from app.features.bot_runtime.pipeline.events import BotTrace, MessageCreated, MessageDone, MessageStreamDelta

logger = logging.getLogger("app.features.agent_bridge.service")

AGENT_BRIDGE_TASK_KIND = "agent_bridge_background_task"


def agent_bridge_task_content_data(
    *,
    task_id: str | None,
    bot_id: str,
    timeout_s: int,
) -> dict[str, Any]:
    return {
        "kind": AGENT_BRIDGE_TASK_KIND,
        "status": "running",
        "title": "后台任务进行中",
        "message": "Agent Bridge 已接收任务，完成后会自动更新这条回复。",
        "task_id": task_id,
        "bot_id": bot_id,
        "timeout_seconds": timeout_s,
    }


def is_agent_bridge_task_content_data(value: Any) -> bool:
    return isinstance(value, dict) and value.get("kind") == AGENT_BRIDGE_TASK_KIND


def _preserve_memory_load(content_data: Any) -> dict[str, Any] | None:
    if not isinstance(content_data, dict):
        return None
    memory_load = content_data.get("memory_load")
    if not isinstance(memory_load, dict):
        return None
    return {"memory_load": memory_load}


async def _get_message_with_retry(
    session: AsyncSession,
    msg_id: str,
    *,
    attempts: int = 6,
    delay_s: float = 0.05,
) -> Message | None:
    """Read a placeholder created by the orchestrator from a separate session.

    WebSocket plugins can reply in the tiny window between pending registration
    and transaction visibility. The adapter now commits before dispatch, but
    this retry keeps older/faster paths from dropping a legitimate reply.
    """
    for attempt in range(max(1, attempts)):
        msg = await session.get(Message, msg_id)
        if msg is not None:
            return msg
        if attempt < attempts - 1:
            await asyncio.sleep(delay_s)
    return None


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
        msg = await _get_message_with_retry(session, pending.msg_id)
        if msg is None:
            logger.warning(
                "bridge.finalize: pending.msg_id=%s not found, will create new message",
                pending.msg_id,
            )
            pending = None

    if pending:
        assert msg is not None
        content_data = _preserve_memory_load(msg.content_data)
        msg.content = content
        msg.content_data = content_data
        msg.is_partial = False
        msg.mention_user_ids = await resolve_user_mentions(content, session, channel_id)
        if file_ids:
            msg.file_ids = list(dict.fromkeys([*(msg.file_ids or []), *file_ids]))
        await session.flush()
        await _broadcast_done(
            session,
            msg,
            file_ids=msg.file_ids or [],
            content_data=content_data,
            clear_content_data=content_data is None,
        )
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


async def mark_bot_reply_as_background_task(
    session: AsyncSession,
    *,
    bot_id: str,
    channel_id: str,
    task_id: str,
    msg_id: str,
    timeout_s: int,
) -> Message | None:
    """Convert a slow Agent Bridge placeholder into a visible background task.

    Unlike the old timeout path this deliberately keeps ``pending_replies`` in
    memory, so a late Agent Bridge reply can still finalize the same placeholder.
    """
    pending = await pending_replies.peek_by_msg(msg_id)
    if pending is None or pending.bot_id != bot_id or pending.task_id != task_id:
        return None

    msg = await session.get(Message, msg_id)
    if msg is None or msg.channel_id != channel_id or msg.sender_id != bot_id:
        return None

    # If a reply won the race and already wrote content, do not overwrite it
    # with a task card.
    if (msg.content or "").strip() and not is_agent_bridge_task_content_data(msg.content_data):
        return None

    content_data = agent_bridge_task_content_data(
        task_id=task_id,
        bot_id=bot_id,
        timeout_s=timeout_s,
    )
    memory_load_data = _preserve_memory_load(msg.content_data)
    if memory_load_data:
        content_data.update(memory_load_data)
    msg.content = "Agent Bridge 已转入后台任务，完成后会自动更新这条回复。"
    msg.content_data = content_data
    msg.is_partial = False
    await session.flush()
    await WSEventBus(channel_id).publish(
        MessageDone(
            msg_id=msg.msg_id,
            content=msg.content,
            content_data=content_data,
        )
    )
    return msg


async def _broadcast_new(session: AsyncSession, msg: Message) -> None:
    dto = MessageAssembler.assemble(msg)
    bot_row = (await session.execute(
        select(BotAccount.display_name, BotAccount.username).where(BotAccount.bot_id == msg.sender_id)
    )).first()
    if bot_row:
        dto.sender_name = bot_row[0] or bot_row[1] or ""

    await WSEventBus(msg.channel_id).publish(MessageCreated(data=dto))


async def _broadcast_done(
    session: AsyncSession,
    msg: Message,
    *,
    file_ids: list[str],
    content_data: dict[str, Any] | None = None,
    clear_content_data: bool = False,
) -> None:
    file_map = {}
    if file_ids:
        rows = (await session.execute(
            select(FileRecord).where(FileRecord.file_id.in_(file_ids))
        )).scalars().all()
        file_map = {r.file_id: r for r in rows}
    await WSEventBus(msg.channel_id).publish(
        MessageDone(
            msg_id=msg.msg_id,
            content=msg.content,
            update=MessageAssembler.update(
                msg,
                file_map=file_map,
                content_data=content_data,
                clear_content_data=clear_content_data,
            ),
            content_data=content_data,
            clear_content_data=clear_content_data,
        )
    )


# ============================================================================
# Streaming reply path: plugin → delta frames → frontend message_stream events
# ============================================================================


async def register_stream(
    *,
    msg_id: str,
    bot_id: str,
    channel_id: str,
    task_id: str | None = None,
    source: str = "agent_bridge",
) -> StreamState:
    """Mark a placeholder message as eligible for streaming deltas.

    Agent Bridge bots use this for plugin `delta` frames; in-process bots use
    the same registry for cancellation.
    """
    return await stream_registry.register(
        msg_id=msg_id,
        bot_id=bot_id,
        channel_id=channel_id,
        task_id=task_id,
        source=source,
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
        if state.finalized or state.cancel_requested:
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
    await WSEventBus(state.channel_id).publish(
        MessageStreamDelta(msg_id=msg_id, delta=delta)
    )
    return True


async def apply_trace(
    *,
    msg_id: str,
    bot_id: str,
    payload: dict,
) -> bool:
    """Validate and broadcast a transient Agent Bridge runtime trace event."""
    state = await stream_registry.get(msg_id)
    if state is None or state.bot_id != bot_id:
        return False
    task_id = payload.get("task_id")
    if isinstance(task_id, str) and state.task_id and task_id != state.task_id:
        return False

    allowed = {
        "run_id",
        "session_key",
        "stream",
        "seq",
        "ts",
        "phase",
        "status",
        "title",
        "message",
        "data",
    }
    out = {k: payload[k] for k in allowed if k in payload}
    out.update({
        "msg_id": state.msg_id,
        "task_id": state.task_id,
        "channel_id": state.channel_id,
        "bot_id": state.bot_id,
    })
    await WSEventBus(state.channel_id).publish(BotTrace(data=out))
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
        msg = await _get_message_with_retry(session, pending.msg_id)

    if msg is None:
        logger.warning(
            "bridge.stream.finalize: placeholder missing msg_id=%s; dropping stream", msg_id,
        )
        return None

    msg.content = content
    content_data = _preserve_memory_load(msg.content_data)
    msg.content_data = content_data
    msg.is_partial = bool(partial)
    msg.mention_user_ids = await resolve_user_mentions(content, session, state.channel_id)
    if file_ids:
        msg.file_ids = list(dict.fromkeys([*(msg.file_ids or []), *file_ids]))
    await session.flush()

    file_map = {}
    if msg.file_ids:
        rows = (await session.execute(
            select(FileRecord).where(FileRecord.file_id.in_(msg.file_ids))
        )).scalars().all()
        file_map = {r.file_id: r for r in rows}
    await WSEventBus(state.channel_id).publish(
        MessageDone(
            msg_id=msg.msg_id,
            content=msg.content,
            update=MessageAssembler.update(
                msg,
                file_map=file_map,
                is_partial=msg.is_partial,
                error=error,
                content_data=content_data,
                clear_content_data=content_data is None,
            ),
        )
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
    if state.finalized:
        return None
    await stream_registry.request_cancel(msg_id, reason=reason)
    bot_id = state.bot_id
    return await finalize_stream(
        session, msg_id=msg_id, bot_id=bot_id, partial=True, error=reason,
    )
