"""消息 REST、SSE 与 WebSocket 路由."""
import asyncio
import json
import logging
from collections.abc import AsyncGenerator, Awaitable, Callable

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.chat_core.schemas import MessageCreate, MessageFileInResponse, MessageInResponse, MessageStreamCreate
from app.chat_core.ws_manager import ws_manager
from app.db.models import Channel, FileRecord, Message
from app.db.session import async_session_factory, get_session
from app.file_processor.service import FileFlowError, FilePipelineService
from app.guide.constants import GUIDE_BOT_ID
from app.orchestrator.adapter_resolver import get_adapter_for_bot
from app.orchestrator.service import run_orchestrator
from app.storage.base import StorageError

logger = logging.getLogger("app.chat_core.messages")
router = APIRouter(prefix="/api/channels", tags=["messages"])


async def _build_file_map(session: AsyncSession, messages: list[Message]) -> dict[str, MessageFileInResponse]:
    file_ids = sorted(
        {
            file_id
            for message in messages
            for file_id in (message.file_ids or [])
            if file_id
        }
    )
    if not file_ids:
        return {}
    result = await session.execute(select(FileRecord).where(FileRecord.file_id.in_(file_ids)))
    file_map: dict[str, MessageFileInResponse] = {}
    for record in result.scalars().all():
        file_map[record.file_id] = MessageFileInResponse(
            file_id=record.file_id,
            original_filename=record.original_filename,
            content_type=record.content_type,
            size_bytes=record.size_bytes,
            status=record.status,
        )
    return file_map


def _serialize_message(message: Message, file_map: dict[str, MessageFileInResponse] | None = None) -> dict:
    payload = MessageInResponse.model_validate(message).model_dump()
    if message.created_at:
        payload["created_at"] = message.created_at.isoformat()
    if message.file_ids:
        payload["files"] = [
            file_map[file_id].model_dump()
            for file_id in message.file_ids
            if file_map and file_id in file_map
        ]
    else:
        payload["files"] = []
    return payload


class GuideReplyBody(BaseModel):
    """引导 Bot 跟帖回复（如表单提交后的结果提示）."""
    content: str


def _normalize_file_ids(file_ids: list[str] | None, file_id: str | None = None) -> list[str]:
    normalized: list[str] = []
    if file_id and file_id.strip():
        normalized.append(file_id.strip())
    for item in file_ids or []:
        value = (item or "").strip()
        if value and value not in normalized:
            normalized.append(value)
    return normalized


def _format_sse(event: str, payload: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(payload, ensure_ascii=False)}\n\n"


async def _ensure_channel_exists(session: AsyncSession, channel_id: str) -> None:
    result = await session.execute(select(Channel).where(Channel.channel_id == channel_id))
    if not result.scalar_one_or_none():
        raise HTTPException(status_code=404, detail="channel not found")


async def _validate_message_files(
    session: AsyncSession,
    *,
    channel_id: str,
    file_ids: list[str],
) -> None:
    if not file_ids:
        return
    try:
        await FilePipelineService().validate_message_files(
            session,
            channel_id=channel_id,
            file_ids=file_ids,
        )
    except FileFlowError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc
    except StorageError as exc:
        raise HTTPException(status_code=503, detail=f"storage unavailable: {exc}") from exc


async def _persist_message(
    session: AsyncSession,
    *,
    channel_id: str,
    content: str,
    sender_id: str,
    sender_type: str,
    file_ids: list[str],
    mention_bot_ids: list[str],
    in_reply_to_msg_id: str | None = None,
) -> tuple[Message, dict]:
    msg = Message(
        channel_id=channel_id,
        sender_id=sender_id,
        sender_type=sender_type,
        content=content,
        file_ids=file_ids,
        mention_bot_ids=mention_bot_ids,
        in_reply_to_msg_id=in_reply_to_msg_id,
    )
    session.add(msg)
    await session.flush()
    file_map = await _build_file_map(session, [msg])
    return msg, _serialize_message(msg, file_map)


async def _broadcast_message(channel_id: str, payload: dict) -> None:
    await ws_manager.broadcast_to_channel(channel_id, {"type": "message", "data": payload})


def _schedule_recent_update(channel_id: str) -> None:
    from app.memory.recent_update import schedule_recent_update

    schedule_recent_update(channel_id)


def _should_run_orchestrator_inline(session: AsyncSession) -> bool:
    try:
        bind = session.get_bind()
    except Exception:
        return settings.database_url.strip().endswith(":memory:")
    return str(bind.url).endswith(":memory:")


async def _run_orchestrator_once(
    channel_id: str,
    trigger_msg: Message,
    session: AsyncSession,
    *,
    stream_event: Callable[[str, dict], Awaitable[None]] | None = None,
    stream_to_ws: bool = True,
) -> tuple[list[Message], set[str]]:
    async def broadcast_bot_processing(ch_id: str, bot_id: str, username: str) -> None:
        payload = {"bot_id": bot_id, "username": username}
        await ws_manager.broadcast_to_channel(ch_id, {"type": "bot_processing", "data": payload})
        if stream_event:
            await stream_event("bot_processing", payload)

    return await run_orchestrator(
        channel_id,
        trigger_msg,
        session,
        lambda bid: get_adapter_for_bot(bid, session),
        broadcast_processing=broadcast_bot_processing,
        stream_event=stream_event,
        stream_to_ws=stream_to_ws,
    )


@router.get("/{channel_id}/messages")
async def list_messages(
    channel_id: str,
    limit: int = 50,
    before_msg_id: str | None = None,
    session: AsyncSession = Depends(get_session),
) -> dict:
    """获取频道消息历史（分页：before_msg_id 之前的 limit 条）."""
    result = await session.execute(select(Channel).where(Channel.channel_id == channel_id))
    if not result.scalar_one_or_none():
        raise HTTPException(status_code=404, detail="channel not found")
    q = select(Message).where(Message.channel_id == channel_id).order_by(Message.created_at.desc())
    if before_msg_id:
        q = q.where(Message.msg_id < before_msg_id)
    q = q.limit(limit)
    result = await session.execute(q)
    messages = list(result.scalars().all())
    messages.reverse()
    file_map = await _build_file_map(session, messages)
    items = []
    for m in messages:
        items.append(_serialize_message(m, file_map))
    return {"status": "success", "data": items}


async def _run_orchestrator_bg(channel_id: str, msg_id: str) -> None:
    """后台任务：在独立 session 中运行 Orchestrator，Bot 回复通过 WebSocket 广播。"""
    bg_session: AsyncSession | None = None
    try:
        async with async_session_factory() as session:
            bg_session = session
            result = await bg_session.execute(select(Message).where(Message.msg_id == msg_id))
            msg = result.scalar_one_or_none()
            if not msg:
                return
            bot_messages, already_broadcast_ids = await _run_orchestrator_once(channel_id, msg, bg_session)
            for bm in bot_messages:
                if bm.msg_id in already_broadcast_ids:
                    continue  # Agent Loop 内部已广播，跳过避免重复
                bd = MessageInResponse.model_validate(bm).model_dump()
                if bm.created_at:
                    bd["created_at"] = bm.created_at.isoformat()
                await _broadcast_message(channel_id, bd)
            if bot_messages:
                _schedule_recent_update(channel_id)
            await bg_session.commit()
    except Exception as e:
        logger.exception("orchestrator background task failed channel_id=%s: %s", channel_id, e)
        if bg_session is not None:
            try:
                await bg_session.rollback()
            except Exception:
                logger.debug("background session rollback skipped", exc_info=True)


@router.post("/{channel_id}/messages")
async def create_message(
    channel_id: str,
    body: MessageCreate,
    session: AsyncSession = Depends(get_session),
) -> dict:
    """发送消息并持久化，并广播到频道 WebSocket。Orchestrator 在后台异步运行，不阻塞响应。"""
    await _ensure_channel_exists(session, channel_id)
    file_ids = _normalize_file_ids(body.file_ids)
    await _validate_message_files(session, channel_id=channel_id, file_ids=file_ids)
    msg, d = await _persist_message(
        session,
        channel_id=channel_id,
        content=body.content,
        sender_id=body.sender_id,
        sender_type=body.sender_type,
        file_ids=file_ids,
        mention_bot_ids=body.mention_bot_ids or [],
        in_reply_to_msg_id=body.in_reply_to_msg_id or None,
    )
    # 先提交用户消息，确保后台任务可以读取到
    await session.commit()
    await _broadcast_message(channel_id, d)
    # 每条消息都立即更新 recent.md
    _schedule_recent_update(channel_id)
    # 生产与正常开发环境保持后台异步；内存 SQLite（测试）改为内联执行，避免临时连接回收造成时序抖动。
    if _should_run_orchestrator_inline(session):
        await _run_orchestrator_bg(channel_id, msg.msg_id)
    else:
        asyncio.create_task(_run_orchestrator_bg(channel_id, msg.msg_id))
        await asyncio.sleep(0)
    return {"status": "success", "data": d}


@router.post("/{channel_id}/messages/stream")
async def create_message_stream(
    channel_id: str,
    body: MessageStreamCreate,
) -> StreamingResponse:
    """发送消息，并通过 SSE 返回 Bot 流式输出。"""

    normalized_file_ids = _normalize_file_ids(body.file_ids, body.file_id)

    async def event_generator() -> AsyncGenerator[str, None]:
        queue: asyncio.Queue[tuple[str, dict]] = asyncio.Queue()

        async def emit(event: str, payload: dict) -> None:
            await queue.put((event, payload))

        async with async_session_factory() as session:
            orchestrator_task: asyncio.Task[tuple[list[Message], set[str]]] | None = None
            try:
                await _ensure_channel_exists(session, channel_id)
                await _validate_message_files(session, channel_id=channel_id, file_ids=normalized_file_ids)
                msg, payload = await _persist_message(
                    session,
                    channel_id=channel_id,
                    content=body.content,
                    sender_id=body.sender_id,
                    sender_type=body.sender_type,
                    file_ids=normalized_file_ids,
                    mention_bot_ids=body.mention_bot_ids or [],
                )
                await session.commit()
                await _broadcast_message(channel_id, payload)
                _schedule_recent_update(channel_id)
                yield _format_sse("user_message", payload)

                orchestrator_task = asyncio.create_task(
                    _run_orchestrator_once(
                        channel_id,
                        msg,
                        session,
                        stream_event=emit,
                        stream_to_ws=False,
                    )
                )

                while True:
                    if orchestrator_task.done() and queue.empty():
                        break
                    try:
                        event, data = await asyncio.wait_for(queue.get(), timeout=0.1)
                    except asyncio.TimeoutError:
                        continue
                    yield _format_sse(event, data)

                bot_messages, _ = await orchestrator_task
                if bot_messages:
                    _schedule_recent_update(channel_id)
                await session.commit()
                yield _format_sse("complete", {"ok": True})
            except HTTPException as exc:
                await session.rollback()
                yield _format_sse("error", {"detail": exc.detail, "status_code": exc.status_code})
            except Exception as exc:
                if orchestrator_task and not orchestrator_task.done():
                    orchestrator_task.cancel()
                    try:
                        await orchestrator_task
                    except Exception:
                        pass
                await session.rollback()
                logger.exception("stream message failed channel_id=%s", channel_id)
                yield _format_sse("error", {"detail": str(exc) or "stream failed", "status_code": 500})

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@router.post("/{channel_id}/guide-reply")
async def guide_reply(
    channel_id: str,
    body: GuideReplyBody,
    session: AsyncSession = Depends(get_session),
) -> dict:
    """由引导 Bot 在频道内发送一条跟帖（如表单完成后结果）；供前端在对话中展示."""
    result = await session.execute(select(Channel).where(Channel.channel_id == channel_id))
    if not result.scalar_one_or_none():
        raise HTTPException(status_code=404, detail="channel not found")
    msg = Message(
        channel_id=channel_id,
        sender_id=GUIDE_BOT_ID,
        sender_type="bot",
        content=body.content.strip(),
    )
    session.add(msg)
    await session.flush()
    d = MessageInResponse.model_validate(msg).model_dump()
    if msg.created_at:
        d["created_at"] = msg.created_at.isoformat()
    await ws_manager.broadcast_to_channel(channel_id, {"type": "message", "data": d})
    return {"status": "success", "data": d}
