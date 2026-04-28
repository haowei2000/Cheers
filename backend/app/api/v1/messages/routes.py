"""Message v1 路由."""
from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import AsyncGenerator

from fastapi import APIRouter, Depends, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.dependencies import get_current_user, try_get_current_user
from app.core.responses import APIResponse
from app.core.schemas import (
    MessageCreate,
    MessageFileInResponse,
    MessageInResponse,
    MessageStreamCreate,
    PermissionResolveRequest,
)
from app.db.models import FileRecord, Message, User
from app.db.session import async_session_factory, get_session
from app.services.guide.constants import GUIDE_BOT_ID
from app.services.message_service import MessageService
from app.services.orchestrator.adapter_resolver import get_adapter_for_bot
from app.services.orchestrator.service import run_orchestrator
from app.services.pipeline.bus import EventBus, make_event_bus
from app.services.pipeline.events import BotProcessing
from app.services.ws_service import ws_manager
from app.utils.crypto import decrypt_value, encrypt_value

logger = logging.getLogger("app.api.v1.messages")

router = APIRouter(prefix="/channels/{channel_id}/messages", tags=["messages"])


def _serialize(msg: Message, file_map: dict) -> dict:
    payload = MessageInResponse.model_validate(msg).model_dump()
    if msg.created_at:
        payload["created_at"] = msg.created_at.isoformat()
    if msg.file_ids:
        payload["files"] = [
            file_map[fid].model_dump()
            for fid in msg.file_ids
            if fid in file_map
        ]
    else:
        payload["files"] = []
    return payload


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
    # Fan out a lightweight notification on each human member's user-scoped WS
    # so rail unread badges can live-increment for channels that aren't the
    # user's currently-open one. Errors here must never break the channel
    # broadcast — swallow everything and log.
    try:
        await _fanout_unread(channel_id, payload)
    except Exception:
        logger.exception(
            "fanout_unread: failed to dispatch channel_new_message channel_id=%s",
            channel_id,
        )


async def _fanout_unread(channel_id: str, payload: dict) -> None:
    """Notify every human channel member (except the sender) that a new
    message has landed in this channel. Used to live-update rail unread
    badges on channels the user isn't currently viewing."""
    from sqlalchemy import select

    from app.db.models import ChannelMembership

    sender_id = payload.get("sender_id")
    sender_type = payload.get("sender_type")

    async with async_session_factory() as session:
        rows = (
            await session.execute(
                select(ChannelMembership.member_id).where(
                    ChannelMembership.channel_id == channel_id,
                    ChannelMembership.member_type == "user",
                )
            )
        ).all()

    event = {
        "type": "channel_new_message",
        "data": {
            "channel_id": channel_id,
            "sender_id": sender_id,
            "sender_type": sender_type,
            "msg_id": payload.get("msg_id"),
        },
    }
    for row in rows:
        member_id = row[0]
        # Don't re-notify the sender about their own message.
        if sender_type == "user" and member_id == sender_id:
            continue
        await ws_manager.broadcast_to_user(member_id, event)


def _schedule_recent_update(channel_id: str) -> None:
    from app.services.memory.recent_update import schedule_recent_update
    schedule_recent_update(channel_id)


async def _run_orchestrator_once(
    channel_id: str,
    trigger_msg: Message,
    session: AsyncSession,
    *,
    event_bus: EventBus,
) -> tuple[list[Message], set[str]]:
    async def broadcast_bot_processing(ch_id: str, bot_id: str, username: str) -> None:
        await event_bus.publish(BotProcessing(bot_id=bot_id, username=username))

    return await run_orchestrator(
        channel_id,
        trigger_msg,
        session,
        lambda bid: get_adapter_for_bot(bid, session),
        event_bus=event_bus,
        broadcast_processing=broadcast_bot_processing,
    )


async def _run_orchestrator_bg(channel_id: str, msg_id: str) -> None:
    """后台任务：在独立 session 中运行 Orchestrator。"""
    try:
        from sqlalchemy import select
        async with async_session_factory() as session:
            result = await session.execute(select(Message).where(Message.msg_id == msg_id))
            msg = result.scalar_one_or_none()
            if not msg:
                logger.warning(
                    "orchestrator_bg: message not found msg_id=%s channel_id=%s",
                    msg_id, channel_id,
                )
                return
            logger.info(
                "orchestrator_bg: starting channel_id=%s msg_id=%s sender=%s",
                channel_id, msg_id, msg.sender_id,
            )
            bus = make_event_bus(channel_id, stream_to_ws=True, stream_event=None)
            bot_messages, already_broadcast_ids = await _run_orchestrator_once(
                channel_id, msg, session, event_bus=bus
            )
            for bm in bot_messages:
                if bm.msg_id in already_broadcast_ids:
                    continue
                data = MessageInResponse.model_validate(bm).model_dump()
                if bm.created_at:
                    data["created_at"] = bm.created_at.isoformat()
                # _broadcast_message 会包装成 {"type": "message", "data": payload}
                await _broadcast_message(channel_id, data)
            if bot_messages:
                _schedule_recent_update(channel_id)
                logger.info(
                    "orchestrator_bg: completed channel_id=%s bot_messages=%d",
                    channel_id, len(bot_messages),
                )
            await session.commit()
    except Exception as e:
        # 确保错误被正确记录，不静默吞掉
        logger.exception(
            "orchestrator_bg: FAILED channel_id=%s msg_id=%s error=%s",
            channel_id, msg_id, str(e),
        )
        # 尝试发送错误通知到 WebSocket
        try:
            await ws_manager.broadcast_to_channel(channel_id, {
                "type": "orchestrator_error",
                "data": {
                    "channel_id": channel_id,
                    "msg_id": msg_id,
                    "error": f"Bot 处理失败: {e}",
                }
            })
        except Exception:
            pass


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
    messages, file_map = await svc.list_messages(channel_id, limit=limit, before_id=before_id)
    return APIResponse.ok([_serialize(m, file_map) for m in messages])


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

    from app.services.orchestrator.topic_context import (
        MSG_TYPE_NORMAL,
        MSG_TYPE_REPLY,
        ensure_topic_root,
    )

    in_reply_to = getattr(body, "in_reply_to_msg_id", None) or None
    msg_type = getattr(body, "msg_type", None) or (MSG_TYPE_REPLY if in_reply_to else MSG_TYPE_NORMAL)
    raw_content_data = getattr(body, "content_data", None)
    if hasattr(raw_content_data, "model_dump"):
        raw_content_data = raw_content_data.model_dump(exclude_none=True) or None

    msg = Message(
        channel_id=channel_id,
        sender_id=body.sender_id,
        sender_type=body.sender_type,
        content=stored_content,
        file_ids=file_ids,
        mention_bot_ids=body.mention_bot_ids or [],
        in_reply_to_msg_id=in_reply_to,
        msg_type=msg_type,
        content_data=raw_content_data,
        is_secret=is_secret,
        secret_encrypted=encrypted,
        secret_token=token,
    )
    session.add(msg)
    await session.flush()

    # The after_insert listener already flipped the parent row in DB; do an
    # explicit in-memory promote on the loaded instance (if any) so any
    # subsequent code in this request that reads parent.msg_type sees the
    # updated value without a refresh.
    if in_reply_to:
        await ensure_topic_root(session, in_reply_to)
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

    payload = _serialize(msg, file_map)
    await session.commit()
    await _broadcast_message(channel_id, payload)
    _schedule_recent_update(channel_id)

    if _should_run_orchestrator_inline(session):
        await _run_orchestrator_bg(channel_id, msg.msg_id)
    else:
        asyncio.create_task(_run_orchestrator_bg(channel_id, msg.msg_id))
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
                msg = Message(
                    channel_id=channel_id,
                    sender_id=body.sender_id,
                    sender_type=body.sender_type,
                    content=body.content,
                    file_ids=normalized_file_ids,
                    mention_bot_ids=body.mention_bot_ids or [],
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
                payload = _serialize(msg, file_map)
                await session.commit()
                await _broadcast_message(channel_id, payload)
                _schedule_recent_update(channel_id)
                yield _format_sse("user_message", payload)

                bus = make_event_bus(channel_id, stream_to_ws=False, stream_event=emit)
                orchestrator_task = asyncio.create_task(
                    _run_orchestrator_once(channel_id, msg, session, event_bus=bus)
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


@router.post("/{msg_id}/cancel", response_model=APIResponse[dict])
async def cancel_streaming_message(
    channel_id: str,
    msg_id: str,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    """Cancel an in-progress streaming bot reply.

    Marks the stream as cancelled, finalizes the placeholder message with
    `is_partial=True` (preserving whatever tokens have arrived so far), and
    notifies the plugin via control WS so it can stop generating.

    Idempotent: if the stream is already finalized, returns 200 with the
    current message state and no plugin notification is sent.
    """
    from sqlalchemy import select

    from app.core.exceptions import ForbiddenError, NotFoundError
    from app.db.models import ChannelMembership
    from app.services.openclaw_bridge.registry import bot_session_registry
    from app.services.openclaw_bridge.service import cancel_stream as bridge_cancel_stream
    from app.services.openclaw_bridge.streams import stream_registry

    membership = (
        await session.execute(
            select(ChannelMembership.member_id).where(
                ChannelMembership.channel_id == channel_id,
                ChannelMembership.member_id == current_user.user_id,
                ChannelMembership.member_type == "user",
            )
        )
    ).first()
    if not membership:
        raise ForbiddenError("not a member of this channel")

    msg = await session.get(Message, msg_id)
    if not msg or msg.channel_id != channel_id:
        raise NotFoundError("message not found")

    state = await stream_registry.get(msg_id)
    if state is None:
        # Already finalized or never streamed: idempotent success.
        return APIResponse.ok(_serialize(msg, {}))

    bot_id = state.bot_id
    finalized = await bridge_cancel_stream(
        session, msg_id=msg_id, reason="user_cancelled",
    )
    if finalized is not None:
        await session.commit()
        # Tell the plugin to stop generating. Best-effort: if plugin is
        # offline the cancel still succeeds locally.
        await bot_session_registry.dispatch_control(bot_id, {
            "type": "cancel",
            "msg_id": msg_id,
            "reason": "user_cancelled",
        })
        logger.info(
            "cancel_streaming_message: msg_id=%s bot_id=%s by_user=%s",
            msg_id, bot_id, current_user.user_id,
        )
        return APIResponse.ok(_serialize(finalized, {}))
    # Race: registry had it but cancel raced with done. Return current msg.
    await session.refresh(msg)
    return APIResponse.ok(_serialize(msg, {}))


@router.post("/{msg_id}/resolve", response_model=APIResponse[dict])
async def resolve_permission(
    channel_id: str,
    msg_id: str,
    body: PermissionResolveRequest,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    """对 permission 类型消息（工具调用审批卡）记录 allow/deny。

    - 仅 msg_type == "permission" 的消息可被 resolve；
    - 已 resolved 的消息不可再次 resolve（返回原值）；
    - 成功后在同频道广播更新后的消息。
    """
    from datetime import datetime, timezone

    from sqlalchemy import select

    from app.core.exceptions import AppError, NotFoundError

    result = await session.execute(
        select(Message)
        .where(Message.channel_id == channel_id, Message.msg_id == msg_id)
        .with_for_update()
    )
    msg = result.scalar_one_or_none()
    if not msg:
        raise NotFoundError("message not found")
    if msg.msg_type != "permission":
        raise AppError("message is not a permission card")

    cd = dict(msg.content_data or {})
    if cd.get("resolved"):
        # 已处理过的请求直接回传当前状态。
        payload = _serialize(msg, {})
        return APIResponse.ok(payload)

    cd["resolved"] = True
    cd["resolution"] = body.resolution
    cd["resolved_by"] = current_user.user_id
    cd["resolved_at"] = datetime.now(timezone.utc).isoformat()
    msg.content_data = cd

    await session.commit()
    await session.refresh(msg)

    payload = _serialize(msg, {})
    await _broadcast_message(channel_id, payload)
    return APIResponse.ok(payload)


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
    d = _serialize(msg, {})
    await ws_manager.broadcast_to_channel(channel_id, {"type": "message", "data": d})
    return APIResponse.ok(d)
