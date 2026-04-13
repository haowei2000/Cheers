"""Message v1 路由."""
from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import AsyncGenerator, Awaitable, Callable

from fastapi import APIRouter, Depends, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.dependencies import get_current_user, try_get_current_user
from app.core.responses import APIResponse
from app.core.schemas import MessageCreate, MessageFileInResponse, MessageInResponse, MessageStreamCreate
from app.db.models import BotAccount, FileRecord, Message, User
from app.db.session import async_session_factory, get_session
from app.services.guide.constants import GUIDE_BOT_ID
from app.services.message_service import MessageService
from app.services.orchestrator.adapter_resolver import get_adapter_for_bot
from app.services.orchestrator.mention import resolve_user_mentions
from app.services.orchestrator.service import run_orchestrator
from app.services.ws_service import ws_manager
from app.utils.crypto import decrypt_value, encrypt_value

logger = logging.getLogger("app.api.v1.messages")

# 保持后台任务的强引用，防止被 GC 回收导致静默失败
_background_tasks: set[asyncio.Task] = set()


def _track_task(task: asyncio.Task) -> None:
    """注册后台任务并在完成时自动清理，记录未处理的异常。"""
    _background_tasks.add(task)

    def _on_done(t: asyncio.Task) -> None:
        _background_tasks.discard(t)
        if not t.cancelled() and t.exception():
            logger.error("background task %s failed: %s", t.get_name(), t.exception())

    task.add_done_callback(_on_done)

router = APIRouter(prefix="/channels/{channel_id}/messages", tags=["messages"])


def _serialize(msg: Message, file_map: dict, sender_names: dict[str, str] | None = None) -> dict:
    payload = MessageInResponse.model_validate(msg).model_dump()
    if msg.created_at:
        payload["created_at"] = msg.created_at.isoformat()
    if sender_names:
        payload["sender_name"] = sender_names.get(msg.sender_id, "")
    if msg.file_ids:
        payload["files"] = [
            file_map[fid].model_dump()
            for fid in msg.file_ids
            if fid in file_map
        ]
    else:
        payload["files"] = []
    return payload


async def _resolve_sender_names(session: AsyncSession, messages: list[Message]) -> dict[str, str]:
    """批量查出消息发送者的 display_name，返回 {sender_id: display_name}。"""
    user_ids = {m.sender_id for m in messages if m.sender_type == "user"}
    bot_ids = {m.sender_id for m in messages if m.sender_type == "bot"}
    names: dict[str, str] = {}
    if user_ids:
        rows = await session.execute(
            select(User.user_id, User.display_name, User.username).where(User.user_id.in_(user_ids))
        )
        for uid, display, uname in rows:
            names[uid] = display or uname or ""
    if bot_ids:
        rows = await session.execute(
            select(BotAccount.bot_id, BotAccount.display_name, BotAccount.username).where(BotAccount.bot_id.in_(bot_ids))
        )
        for bid, display, uname in rows:
            names[bid] = display or uname or ""
    return names


def _format_sse(event: str, payload: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(payload, ensure_ascii=False)}\n\n"


def _normalize_file_ids(file_ids: list[str] | None, file_id: str | None = None) -> list[str]:
    normalized: list[str] = []
    if file_id and file_id.strip():
        normalized.append(file_id.strip())
    for item in file_ids or []:
        value = (item or "").strip()
        if value and value not in normalized:
            normalized.append(value)
    return normalized


async def _broadcast_message(channel_id: str, payload: dict) -> None:
    await ws_manager.broadcast_to_channel(channel_id, {"type": "message", "data": payload})


def _schedule_recent_update(channel_id: str) -> None:
    from app.services.memory.recent_update import schedule_recent_update
    schedule_recent_update(channel_id)


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


async def _run_orchestrator_bg(channel_id: str, msg_id: str) -> None:
    """后台任务：在独立 session 中运行 Orchestrator。"""
    try:
        from sqlalchemy import select
        async with async_session_factory() as session:
            result = await session.execute(select(Message).where(Message.msg_id == msg_id))
            msg = result.scalar_one_or_none()
            if not msg:
                return
            bot_messages, already_broadcast_ids = await _run_orchestrator_once(channel_id, msg, session)
            pending_broadcast = [bm for bm in bot_messages if bm.msg_id not in already_broadcast_ids]
            bot_sender_names = await _resolve_sender_names(session, pending_broadcast) if pending_broadcast else {}
            for bm in pending_broadcast:
                await _broadcast_message(channel_id, _serialize(bm, {}, bot_sender_names))
            if bot_messages:
                _schedule_recent_update(channel_id)
            await session.commit()
    except Exception as e:
        logger.exception("orchestrator background task failed channel_id=%s: %s", channel_id, e)


def _should_run_orchestrator_inline(session: AsyncSession) -> bool:
    from app.config import settings
    try:
        bind = session.get_bind()
    except Exception:
        return settings.database_url.strip().endswith(":memory:")
    return str(bind.url).endswith(":memory:")


@router.get("", response_model=APIResponse[list[dict]])
async def list_messages(
    channel_id: str,
    limit: int = Query(default=50, ge=1, le=200),
    before_id: str | None = Query(default=None),
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    svc = MessageService(session)
    # 多取一条用于判断是否还有更多历史消息
    messages, file_map = await svc.list_messages(channel_id, limit=limit + 1, before_id=before_id)
    has_more = len(messages) > limit
    if has_more:
        messages = messages[1:]  # 去掉最早的那条（多取的）
    sender_names = await _resolve_sender_names(session, messages)
    return APIResponse.ok(
        [_serialize(m, file_map, sender_names) for m in messages],
        meta={"has_more": has_more},
    )


async def _handle_send_message(
    session: AsyncSession,
    *,
    channel_id: str,
    body: MessageCreate,
) -> tuple[dict, str | None]:
    """持久化消息、广播、调度 orchestrator。返回 (payload_dict, secret_token)。"""
    from sqlalchemy import select

    from app.db.models import Channel, FileRecord
    from app.services.file_processor.service import FileFlowError, FilePipelineService
    from app.services.storage.base import StorageError

    result = await session.execute(select(Channel).where(Channel.channel_id == channel_id))
    if not result.scalar_one_or_none():
        from app.core.exceptions import NotFoundError
        raise NotFoundError("channel not found")

    file_ids = _normalize_file_ids(body.file_ids)

    if file_ids:
        try:
            await FilePipelineService().validate_message_files(
                session, channel_id=channel_id, file_ids=file_ids
            )
        except FileFlowError as exc:
            from app.core.exceptions import BadRequestError
            raise BadRequestError(exc.detail)
        except StorageError as exc:
            from app.core.exceptions import AppError
            raise AppError(f"storage unavailable: {exc}")

    _SECRET_PLACEHOLDER = "🔒 [加密消息]"
    is_secret = bool(body.is_secret)
    if is_secret:
        import secrets as _sec
        encrypted = encrypt_value(body.content)
        stored_content = _SECRET_PLACEHOLDER
        token = _sec.token_urlsafe(32)
    else:
        encrypted = None
        stored_content = body.content
        token = None

    mention_user_ids = await resolve_user_mentions(body.content, session, channel_id)
    msg = Message(
        channel_id=channel_id,
        sender_id=body.sender_id,
        sender_type=body.sender_type,
        content=stored_content,
        file_ids=file_ids,
        mention_bot_ids=body.mention_bot_ids or [],
        mention_user_ids=mention_user_ids,
        in_reply_to_msg_id=body.in_reply_to_msg_id or None,
        is_secret=is_secret,
        secret_encrypted=encrypted,
        secret_token=token,
    )
    session.add(msg)
    await session.flush()

    # Build file_map for response
    fids = sorted({fid for fid in (msg.file_ids or []) if fid})
    file_map: dict = {}
    if fids:
        from sqlalchemy import select as _sel
        fres = await session.execute(_sel(FileRecord).where(FileRecord.file_id.in_(fids)))
        for rec in fres.scalars().all():
            file_map[rec.file_id] = MessageFileInResponse(
                file_id=rec.file_id,
                original_filename=rec.original_filename,
                content_type=rec.content_type,
                size_bytes=rec.size_bytes,
                status=rec.status,
            )

    sender_names = await _resolve_sender_names(session, [msg])
    payload = _serialize(msg, file_map, sender_names)
    await session.commit()
    await _broadcast_message(channel_id, payload)
    _schedule_recent_update(channel_id)

    if _should_run_orchestrator_inline(session):
        await _run_orchestrator_bg(channel_id, msg.msg_id)
    else:
        _track_task(asyncio.create_task(
            _run_orchestrator_bg(channel_id, msg.msg_id),
            name=f"orchestrator-{channel_id}-{msg.msg_id}",
        ))
        await asyncio.sleep(0)

    return payload, token


@router.post("", response_model=APIResponse[dict])
async def send_message(
    channel_id: str,
    body: MessageCreate,
    current_user: User | None = Depends(try_get_current_user),
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    d, secret_token = await _handle_send_message(session, channel_id=channel_id, body=body)
    response_data = dict(d)
    if secret_token:
        response_data["secret_token"] = secret_token
    return APIResponse.ok(response_data)


@router.post("/stream")
async def send_message_stream(
    channel_id: str,
    body: MessageStreamCreate,
) -> StreamingResponse:
    """发送消息，通过 SSE 返回 Bot 流式输出。"""
    from sqlalchemy import select

    from app.db.models import Channel
    from app.services.file_processor.service import FileFlowError, FilePipelineService
    from app.services.storage.base import StorageError

    normalized_file_ids = _normalize_file_ids(body.file_ids, body.file_id)

    async def event_generator() -> AsyncGenerator[str, None]:
        queue: asyncio.Queue[tuple[str, dict]] = asyncio.Queue()

        async def emit(event: str, payload: dict) -> None:
            await queue.put((event, payload))

        async with async_session_factory() as session:
            orchestrator_task = None
            try:
                result = await session.execute(select(Channel).where(Channel.channel_id == channel_id))
                if not result.scalar_one_or_none():
                    yield _format_sse("error", {"detail": "channel not found", "status_code": 404})
                    return

                if normalized_file_ids:
                    try:
                        await FilePipelineService().validate_message_files(
                            session, channel_id=channel_id, file_ids=normalized_file_ids
                        )
                    except (FileFlowError, StorageError) as exc:
                        yield _format_sse("error", {"detail": str(exc), "status_code": 400})
                        return

                _SECRET_PLACEHOLDER = "🔒 [加密消息]"
                stream_mention_user_ids = await resolve_user_mentions(body.content, session, channel_id)
                msg = Message(
                    channel_id=channel_id,
                    sender_id=body.sender_id,
                    sender_type=body.sender_type,
                    content=body.content,
                    file_ids=normalized_file_ids,
                    mention_bot_ids=body.mention_bot_ids or [],
                    mention_user_ids=stream_mention_user_ids,
                )
                session.add(msg)
                await session.flush()

                from sqlalchemy import select as _select
                file_ids = sorted({fid for fid in (msg.file_ids or []) if fid})
                file_map: dict = {}
                if file_ids:
                    fres = await session.execute(_select(FileRecord).where(FileRecord.file_id.in_(file_ids)))
                    for rec in fres.scalars().all():
                        file_map[rec.file_id] = MessageFileInResponse(
                            file_id=rec.file_id,
                            original_filename=rec.original_filename,
                            content_type=rec.content_type,
                            size_bytes=rec.size_bytes,
                            status=rec.status,
                        )
                sender_names = await _resolve_sender_names(session, [msg])
                payload = _serialize(msg, file_map, sender_names)
                await session.commit()
                await _broadcast_message(channel_id, payload)
                _schedule_recent_update(channel_id)
                yield _format_sse("user_message", payload)

                orchestrator_task = asyncio.create_task(
                    _run_orchestrator_once(
                        channel_id, msg, session, stream_event=emit, stream_to_ws=False
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
        headers={"Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no"},
    )


@router.get("/{msg_id}/secret", response_model=APIResponse[dict])
async def reveal_secret_message(
    channel_id: str,
    msg_id: str,
    token: str,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    """解密并返回加密消息原始内容（1 分钟内有效，查看后立即清除）。"""
    import hmac as _hmac
    from datetime import datetime as _dt
    from datetime import timedelta, timezone

    from sqlalchemy import select

    result = await session.execute(
        select(Message)
        .where(Message.channel_id == channel_id, Message.msg_id == msg_id)
        .with_for_update()
    )
    msg = result.scalar_one_or_none()
    if not msg:
        from app.core.exceptions import NotFoundError
        raise NotFoundError("message not found")
    if not msg.is_secret:
        from app.core.exceptions import BadRequestError
        raise BadRequestError("not a secret message")
    if not msg.secret_encrypted:
        from app.core.exceptions import BadRequestError
        raise BadRequestError("secret message already revealed or expired")
    if not msg.secret_token or not _hmac.compare_digest(token, msg.secret_token):
        from app.core.exceptions import ForbiddenError
        raise ForbiddenError("invalid token")
    sent_at = msg.created_at
    if sent_at.tzinfo is None:
        sent_at = sent_at.replace(tzinfo=timezone.utc)
    if _dt.now(timezone.utc) - sent_at > timedelta(minutes=1):
        from app.core.exceptions import BadRequestError
        raise BadRequestError("secret message expired")
    try:
        plaintext = decrypt_value(msg.secret_encrypted)
    except Exception:
        from app.core.exceptions import AppError
        raise AppError("decryption failed")
    msg.secret_encrypted = None
    return APIResponse.ok({"content": plaintext})


class GuideReplyBody(BaseModel):
    content: str


@router.post("/guide-reply", response_model=APIResponse[dict])
async def guide_reply(
    channel_id: str,
    body: GuideReplyBody,
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    """由引导 Bot 在频道内发送一条跟帖。"""
    from sqlalchemy import select

    from app.db.models import Channel
    result = await session.execute(select(Channel).where(Channel.channel_id == channel_id))
    if not result.scalar_one_or_none():
        from app.core.exceptions import NotFoundError
        raise NotFoundError("channel not found")
    msg = Message(
        channel_id=channel_id,
        sender_id=GUIDE_BOT_ID,
        sender_type="bot",
        content=body.content.strip(),
    )
    session.add(msg)
    await session.flush()
    guide_sender_names = await _resolve_sender_names(session, [msg])
    d = _serialize(msg, {}, guide_sender_names)
    await ws_manager.broadcast_to_channel(channel_id, {"type": "message", "data": d})
    return APIResponse.ok(d)
