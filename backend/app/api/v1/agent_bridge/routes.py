"""Agent Bridge API routes."""
from __future__ import annotations

import asyncio
import base64
import json
import logging
import re
import uuid
from datetime import datetime, timezone
from pathlib import Path

from fastapi import (
    APIRouter,
    Depends,
    Header,
    HTTPException,
    Query,
    Request,
    WebSocket,
    WebSocketDisconnect,
)
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.config import resolve_data_dir, settings
from app.core.dependencies import get_current_user, get_session
from app.core.responses import APIResponse
from app.db.models import (
    AgentNexusSession,
    BotAccount,
    Channel,
    ChannelMembership,
    FileRecord,
    Message,
    User,
)
from app.features.agent_bridge.dispatcher import bridge_dispatcher
from app.features.agent_bridge.membership import load_memberships
from app.features.agent_bridge.pending import pending_replies
from app.features.agent_bridge.registry import bot_session_registry
from app.features.agent_bridge.service import (
    apply_delta as bridge_apply_delta,
)
from app.features.agent_bridge.service import (
    apply_trace as bridge_apply_trace,
)
from app.features.agent_bridge.service import (
    finalize_bot_reply,
)
from app.features.agent_bridge.service import (
    flush_stream_deltas as bridge_flush_stream_deltas,
)
from app.features.agent_bridge.service import (
    is_agent_bridge_task_content_data as bridge_is_task_content_data,
)
from app.features.agent_bridge.service import (
    register_stream as bridge_register_stream,
)
from app.features.agent_bridge.session_map import (
    SCOPE_CHANNEL,
    SCOPE_DM,
    SCOPE_TASK,
    SCOPE_TOPIC,
    refresh_dm_session_scope,
)
from app.features.agent_bridge.session_queries import (
    list_active_sessions_for_scope,
    serialize_session,
)
from app.features.agent_bridge.state_repository import get_agent_bridge_state_repository
from app.features.agent_bridge.tokens import resolve_bot_by_token
from app.features.bot_runtime.bot_events.jobs import (
    AGENT_BRIDGE_REPLY,
    AGENT_BRIDGE_STREAM_DONE,
    AGENT_BRIDGE_STREAM_ERROR,
)
from app.features.bot_runtime.bot_events.queue import enqueue_bot_event_job
from app.services.channel_service import ChannelService
from app.services.file_processor.convert import is_image_type
from app.services.file_processor.service import FileFlowError, FilePipelineService
from app.services.file_retention import active_file_filter, file_expires_at

logger = logging.getLogger("app.api.v1.agent_bridge")

router = APIRouter(prefix="/agent-bridge", tags=["agent-bridge"])


# ============================================================================
# Authentication.
# ============================================================================

def _require_bridge_enabled_and_token(token: str | None) -> None:
    if not settings.agent_bridge_enabled:
        raise HTTPException(status_code=503, detail="Agent Bridge 已禁用")
    expected = settings.agent_bridge_token.strip()
    if not expected:
        raise HTTPException(status_code=503, detail="Agent Bridge token 未配置")
    if not token or token.strip() != expected:
        raise HTTPException(status_code=401, detail="Agent Bridge token 无效")


async def verify_bridge_token(
    x_agent_bridge_token: str | None = Header(default=None, alias="X-Agent-Bridge-Token"),
) -> None:
    _require_bridge_enabled_and_token(x_agent_bridge_token)


# ============================================================================
# Schemas
# ============================================================================

class BridgeReplyIn(BaseModel):
    bot_id: str = Field(..., description="回复的 Bot id")
    channel_id: str = Field(..., description="目标频道 id")
    content: str = Field(..., description="Bot 回复的文本内容")
    task_id: str | None = Field(default=None, description="派发事件里的 task_id，用于匹配占位消息")
    reply_to_msg_id: str | None = Field(default=None, description="明确指定要 finalize 的占位消息 id")
    in_reply_to_msg_id: str | None = Field(default=None, description="仅新建消息时使用：指向触发消息 id")
    file_ids: list[str] | None = Field(default=None, description="附件 file_ids（必须在目标频道内）")


class DMSessionRefreshIn(BaseModel):
    channel_id: str = Field(..., description="DM backing channel id")
    bot_id: str | None = Field(
        default=None,
        description="Bot counterparty id; omitted means infer from DM members",
    )


# ============================================================================
# HTTP routes.
# ============================================================================

@router.get("/status", response_model=APIResponse[dict])
async def bridge_status(_: None = Depends(verify_bridge_token)) -> APIResponse:
    snapshot = get_agent_bridge_state_repository().snapshot()
    return APIResponse.ok({
        "enabled": settings.agent_bridge_enabled,
        "subscribers": bridge_dispatcher.subscriber_count(),
        "bot_sessions": snapshot.bot_sessions,
        "pending": snapshot.pending,
        "streams": snapshot.streams,
    })


@router.get("/sessions/scope", response_model=APIResponse[list[dict]])
async def list_scope_sessions(
    scope_type: str = Query(..., pattern="^(channel|dm|topic|task)$"),
    scope_id: str = Query(..., min_length=1),
    channel_id: str = Query(..., min_length=1),
    bot_id: str | None = Query(default=None),
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    """Return active Agent Bridge sessions currently bound to a UI scope."""
    if scope_type == SCOPE_CHANNEL and scope_id != channel_id:
        raise HTTPException(status_code=400, detail="channel scope_id must equal channel_id")
    if scope_type not in {SCOPE_CHANNEL, SCOPE_DM, SCOPE_TOPIC, SCOPE_TASK}:
        raise HTTPException(status_code=400, detail="unsupported scope_type")
    await ChannelService(session).require_channel_member(channel_id, current_user)
    if scope_type == SCOPE_DM:
        channel = await session.get(Channel, channel_id)
        if channel is None or channel.type != "dm":
            raise HTTPException(status_code=400, detail="dm scope requires a DM channel")
        bot_rows = (await session.execute(
            select(ChannelMembership.member_id).where(
                ChannelMembership.channel_id == channel_id,
                ChannelMembership.member_type == "bot",
            )
        )).all()
        bot_ids = {row[0] for row in bot_rows}
        if bot_id and bot_id not in bot_ids:
            raise HTTPException(status_code=403, detail="bot is not a member of this DM")
        if channel.name.startswith("dmchat:"):
            allowed_scope_ids = {channel_id}
        else:
            allowed_scope_ids = {
                f"user:{current_user.user_id}:bot:{candidate_bot_id}"
                for candidate_bot_id in bot_ids
            }
            allowed_scope_ids.add(channel_id)
        if scope_id not in allowed_scope_ids:
            raise HTTPException(status_code=403, detail="dm scope_id does not belong to this DM")
    sessions = await list_active_sessions_for_scope(
        session,
        scope_type=scope_type,
        scope_id=scope_id,
        channel_id=channel_id,
        bot_id=bot_id,
    )
    return APIResponse.ok([serialize_session(row) for row in sessions])


@router.post("/sessions/dm/refresh", response_model=APIResponse[dict])
async def refresh_dm_session(
    body: DMSessionRefreshIn,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    """Rotate the first-class DM session scope for a user-bot DM."""
    channel = await session.get(Channel, body.channel_id)
    if channel is None:
        raise HTTPException(status_code=404, detail="DM channel not found")
    if channel.type != "dm":
        raise HTTPException(status_code=400, detail="channel is not a DM")
    channel_service = ChannelService(session)
    await channel_service.require_channel_member(body.channel_id, current_user)
    await channel_service.require_channel_admin(body.channel_id, current_user)

    bot_id = body.bot_id
    if not bot_id:
        bot_members = list((await session.execute(
            select(ChannelMembership.member_id).where(
                ChannelMembership.channel_id == body.channel_id,
                ChannelMembership.member_type == "bot",
            )
        )).scalars().all())
        if len(bot_members) > 1:
            raise HTTPException(status_code=400, detail="DM has multiple bot counterparties; bot_id is required")
        bot_id = bot_members[0] if bot_members else None
    if not bot_id:
        raise HTTPException(status_code=400, detail="DM has no bot counterparty")

    membership = (await session.execute(
        select(ChannelMembership).where(
            ChannelMembership.channel_id == body.channel_id,
            ChannelMembership.member_id == bot_id,
            ChannelMembership.member_type == "bot",
        )
    )).scalar_one_or_none()
    if membership is None:
        raise HTTPException(status_code=403, detail="bot is not a member of this DM")

    bot = await session.get(BotAccount, bot_id)
    if bot is None:
        raise HTTPException(status_code=404, detail="bot not found")
    if (bot.binding_type or "http") != "agent_bridge":
        raise HTTPException(status_code=400, detail="DM counterparty is not an Agent Bridge Bot")

    resolved = await refresh_dm_session_scope(
        session,
        bot=bot,
        channel_id=body.channel_id,
        user_id=current_user.user_id,
        channel=channel,
    )
    row = (await session.execute(
        select(AgentNexusSession)
        .where(AgentNexusSession.session_id == resolved.session_id)
        .options(
            selectinload(AgentNexusSession.bindings),
            selectinload(AgentNexusSession.bot),
        )
    )).scalar_one()
    await session.commit()
    return APIResponse.ok({
        "refreshed": True,
        "scope_type": SCOPE_DM,
        "scope_id": resolved.primary_scope_id,
        "session": serialize_session(row),
    })


def _validator_http_status(code: str) -> int:
    # Map validator error codes to HTTP statuses.
    if code in ("file_not_found", "reply_target_not_found"):
        return 404
    return 403


async def _assert_bot_in_channel(
    session: AsyncSession, *, bot_id: str, channel_id: str,
) -> None:
    from app.features.agent_bridge.validators import check_bot_in_channel
    err = await check_bot_in_channel(session, bot_id=bot_id, channel_id=channel_id)
    if err:
        raise HTTPException(status_code=_validator_http_status(err[0]), detail=err[1])


async def _assert_files_in_channel(
    session: AsyncSession, *, file_ids: list[str], channel_id: str,
) -> None:
    from app.features.agent_bridge.validators import check_files_in_channel
    err = await check_files_in_channel(session, file_ids=file_ids, channel_id=channel_id)
    if err:
        raise HTTPException(status_code=_validator_http_status(err[0]), detail=err[1])


async def _assert_in_reply_same_channel(
    session: AsyncSession, *, msg_id: str, channel_id: str,
) -> None:
    from app.features.agent_bridge.validators import check_in_reply_same_channel
    err = await check_in_reply_same_channel(session, msg_id=msg_id, channel_id=channel_id)
    if err:
        raise HTTPException(status_code=_validator_http_status(err[0]), detail=err[1])


@router.post("/messages", response_model=APIResponse[dict])
async def bridge_post_reply(
    body: BridgeReplyIn,
    session: AsyncSession = Depends(get_session),
    _: None = Depends(verify_bridge_token),
) -> APIResponse:
    # 1) Bot exists, is agent_bridge type, and is online.
    bot = (await session.execute(
        select(BotAccount).where(BotAccount.bot_id == body.bot_id)
    )).scalar_one_or_none()
    if not bot:
        raise HTTPException(status_code=404, detail=f"Bot {body.bot_id} 不存在")
    if (bot.binding_type or "http") != "agent_bridge":
        raise HTTPException(
            status_code=400,
            detail=f"Bot {body.bot_id} 不是 Agent Bridge Bot（binding_type={bot.binding_type}）",
        )
    if bot.status != "online":
        raise HTTPException(
            status_code=409,
            detail=f"Bot {body.bot_id} 状态为 {bot.status}，不接受消息",
        )

    # 2) Bot must be a member of the target channel.
    await _assert_bot_in_channel(session, bot_id=body.bot_id, channel_id=body.channel_id)

    # 3) Attachments must belong to the target channel.
    if body.file_ids:
        await _assert_files_in_channel(session, file_ids=body.file_ids, channel_id=body.channel_id)

    # 4) in_reply_to_msg_id must point to a same-channel message. This only matters
    #    for new-message paths; placeholder finalization already has in_reply_to set by pre_create.
    if body.in_reply_to_msg_id:
        await _assert_in_reply_same_channel(
            session, msg_id=body.in_reply_to_msg_id, channel_id=body.channel_id,
        )

    job_id = await enqueue_bot_event_job(
        AGENT_BRIDGE_REPLY,
        {
            "bot_id": body.bot_id,
            "channel_id": body.channel_id,
            "content": body.content,
            "task_id": body.task_id,
            "reply_to_msg_id": body.reply_to_msg_id,
            "in_reply_to_msg_id": body.in_reply_to_msg_id,
            "file_ids": body.file_ids or [],
        },
    )
    return APIResponse.ok({
        "queued": True,
        "job_id": job_id,
        "message_id": body.reply_to_msg_id,
        "finalized_placeholder": None,
    })


@router.get("/channels/{channel_id}/bots", response_model=APIResponse[list[dict]])
async def bridge_list_channel_bots(
    channel_id: str,
    session: AsyncSession = Depends(get_session),
    _: None = Depends(verify_bridge_token),
) -> APIResponse:
    """Bridge list channel bots."""
    rows = (await session.execute(
        select(BotAccount)
        .join(ChannelMembership, ChannelMembership.member_id == BotAccount.bot_id)
        .where(
            ChannelMembership.channel_id == channel_id,
            ChannelMembership.member_type == "bot",
            BotAccount.binding_type == "agent_bridge",
        )
    )).scalars().all()
    return APIResponse.ok([
        {
            "bot_id": b.bot_id,
            "username": b.username,
            "display_name": b.display_name,
            "status": b.status,
            **bot_session_registry.connection_state(b.bot_id),
        }
        for b in rows
    ])


# ============================================================================
# Per-bot-token file read support for agent-side read_file.
# ============================================================================

# Inline body-size limit for agent-side file reads; oversized content is truncated and marked truncated=true.
# This prevents large files such as 200MB PDFs from being injected into agent prompts.
_FILE_CONTENT_MAX_CHARS = 200_000
_FILE_BINARY_MAX_BYTES = int(settings.file_upload_max_bytes)


def _parse_bearer_header(authorization: str | None) -> str | None:
    """Extract `Bearer xxx` → `xxx` from an Authorization header value."""
    if not authorization:
        return None
    parts = authorization.split(None, 1)
    if len(parts) != 2 or parts[0].lower() != "bearer":
        return None
    token = parts[1].strip()
    return token or None


async def _resolve_bot_by_bearer(
    session: AsyncSession, authorization: str | None,
) -> BotAccount:
    """Resolve bot by bearer."""
    if not settings.agent_bridge_enabled:
        raise HTTPException(status_code=503, detail="Agent Bridge 已禁用")
    token = _parse_bearer_header(authorization)
    if not token:
        raise HTTPException(status_code=401, detail="missing bearer token")
    bot = await resolve_bot_by_token(session, token)
    if bot is None:
        raise HTTPException(status_code=401, detail="invalid or revoked token")
    return bot


async def _assert_bot_membership(
    session: AsyncSession, *, bot_id: str, channel_id: str,
) -> None:
    row = (await session.execute(
        select(ChannelMembership).where(
            ChannelMembership.channel_id == channel_id,
            ChannelMembership.member_id == bot_id,
            ChannelMembership.member_type == "bot",
        )
    )).scalar_one_or_none()
    if row is None:
        raise HTTPException(
            status_code=403,
            detail=f"bot {bot_id} 不在文件所在频道 {channel_id} 的成员中",
        )


def _file_storage_scope(record: FileRecord) -> str:
    return "generated" if (record.object_key or "").startswith("generated/") else "uploads"


async def _load_bridge_file_body(record: FileRecord) -> bytes:
    if not record.object_key and record.original_path:
        local_path = Path(record.original_path)
        if local_path.is_file():
            return local_path.read_bytes()

    from app.services.storage.base import StorageObjectNotFoundError
    from app.services.storage.bootstrap import get_storage_service, is_storage_enabled

    if not is_storage_enabled():
        raise HTTPException(status_code=503, detail="storage not enabled")
    storage = get_storage_service()
    try:
        obj = await storage.get_object(record.file_id, scope=_file_storage_scope(record))
    except StorageObjectNotFoundError as exc:
        raise HTTPException(status_code=404, detail="file not found in storage") from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail="failed to load file") from exc
    return obj.body


@router.get("/files/{file_id}/content", response_model=APIResponse[dict])
async def bridge_read_file_content(
    file_id: str,
    authorization: str | None = Header(default=None),
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    """Bridge read file content."""
    bot = await _resolve_bot_by_bearer(session, authorization)

    record = (await session.execute(
        select(FileRecord).where(FileRecord.file_id == file_id, active_file_filter())
    )).scalar_one_or_none()
    if record is None:
        raise HTTPException(status_code=404, detail=f"file {file_id} 不存在")

    await _assert_bot_membership(session, bot_id=bot.bot_id, channel_id=record.channel_id)

    if is_image_type(record.content_type or ""):
        raise HTTPException(
            status_code=415,
            detail="该文件是图片，文本接口不支持；请使用 Vision 能力处理图片附件",
        )

    # Trigger conversion once, hitting the md cache when available, then trim to the limit.
    try:
        attachments = await FilePipelineService().prepare_attachments(
            session,
            channel_id=record.channel_id,
            file_ids=[file_id],
        )
        await session.commit()
    except FileFlowError as exc:
        await session.rollback()
        raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc

    if not attachments:
        raise HTTPException(status_code=404, detail="file content 不可用")
    att = attachments[0]
    full_text: str = att.get("content") or ""
    text = full_text[:_FILE_CONTENT_MAX_CHARS]
    truncated = att.get("truncated") == "true" or len(full_text) > _FILE_CONTENT_MAX_CHARS

    return APIResponse.ok({
        "file_id": record.file_id,
        "filename": record.original_filename or record.file_id,
        "content_type": record.content_type or "",
        "size_bytes": record.size_bytes,
        "summary": record.summary_3lines or "",
        "content": text,
        "truncated": truncated,
    })


@router.get("/files/{file_id}/binary", response_model=APIResponse[dict])
async def bridge_read_file_binary(
    file_id: str,
    authorization: str | None = Header(default=None),
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    """Bridge read file binary."""
    bot = await _resolve_bot_by_bearer(session, authorization)

    record = (await session.execute(
        select(FileRecord).where(FileRecord.file_id == file_id, active_file_filter())
    )).scalar_one_or_none()
    if record is None:
        raise HTTPException(status_code=404, detail=f"file {file_id} 不存在")

    await _assert_bot_membership(session, bot_id=bot.bot_id, channel_id=record.channel_id)

    if record.size_bytes and record.size_bytes > _FILE_BINARY_MAX_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"file exceeds binary read limit {_FILE_BINARY_MAX_BYTES} bytes",
        )

    body = await _load_bridge_file_body(record)
    if len(body) > _FILE_BINARY_MAX_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"file exceeds binary read limit {_FILE_BINARY_MAX_BYTES} bytes",
        )

    return APIResponse.ok({
        "file_id": record.file_id,
        "filename": record.original_filename or record.file_id,
        "content_type": record.content_type or "application/octet-stream",
        "size_bytes": len(body),
        "data_b64": base64.b64encode(body).decode("ascii"),
    })


# ============================================================================
# Per-bot-token file upload support for agent-side attach-file.
# ============================================================================

# Per-upload markdown body-size limit to protect storage from runaway long replies.
_FILE_UPLOAD_MAX_BYTES = 2 * 1024 * 1024  # 2 MiB


class BridgeFileUploadIn(BaseModel):
    channel_id: str = Field(..., description="目标频道 id")
    filename: str = Field(..., description="文件名，未带扩展名时自动补 .md")
    content: str = Field(..., description="markdown 文本正文")


@router.post("/files/upload", response_model=APIResponse[dict])
async def bridge_upload_markdown_file(
    body: BridgeFileUploadIn,
    authorization: str | None = Header(default=None),
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    """Bridge upload markdown file."""
    bot = await _resolve_bot_by_bearer(session, authorization)
    await _assert_bot_membership(session, bot_id=bot.bot_id, channel_id=body.channel_id)

    text = body.content
    byte_size = len(text.encode("utf-8"))
    if byte_size == 0:
        raise HTTPException(status_code=400, detail="content 不能为空")
    if byte_size > _FILE_UPLOAD_MAX_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"content 超过上限 {_FILE_UPLOAD_MAX_BYTES} bytes",
        )

    safe_name = re.sub(r"[^\w\-. ]", "_", body.filename.strip()) or "reply"
    if not safe_name.lower().endswith(".md"):
        safe_name = f"{safe_name}.md"

    file_id = str(uuid.uuid4())
    gen_dir = resolve_data_dir() / "generated" / body.channel_id
    gen_dir.mkdir(parents=True, exist_ok=True)
    md_path = gen_dir / f"{file_id}.md"
    # Path traversal guard: body.channel_id is untrusted, so keep writes within gen_dir.
    if not md_path.resolve().is_relative_to(gen_dir.resolve()):
        raise HTTPException(status_code=400, detail="invalid channel_id path")
    md_path.write_text(text, encoding="utf-8")

    now = datetime.now(timezone.utc)
    record = FileRecord(
        file_id=file_id,
        channel_id=body.channel_id,
        uploader_id=bot.bot_id,
        original_path=str(md_path),
        original_filename=safe_name,
        content_type="text/markdown",
        size_bytes=byte_size,
        md_path=str(md_path),
        status="ready",
        uploaded_at=now,
        converted_at=now,
        expires_at=file_expires_at(now),
    )
    session.add(record)
    await session.commit()

    return APIResponse.ok({
        "file_id": file_id,
        "filename": safe_name,
        "size_bytes": byte_size,
    })


# ============================================================================
# Per-bot-token binary upload support for agent-side sendMedia.
# ============================================================================

# Per-binary-upload size limit aligned with settings.file_upload_max_bytes.
# MEDIA: the gateway passes local media files to the plugin, which uploads them here
# as FileRecord attachments.
def _sanitize_filename(raw: str) -> str:
    safe = re.sub(r"[^\w\-. ]", "_", raw.strip())
    return safe or "media"


@router.post("/files/upload-binary", response_model=APIResponse[dict])
async def bridge_upload_binary_file(
    request: Request,
    x_channel_id: str = Header(...),
    x_filename: str = Header(...),
    authorization: str | None = Header(default=None),
    content_type: str | None = Header(default=None),
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    """Bridge upload binary file."""
    bot = await _resolve_bot_by_bearer(session, authorization)
    await _assert_bot_membership(session, bot_id=bot.bot_id, channel_id=x_channel_id)

    max_bytes = int(settings.file_upload_max_bytes)

    raw_name = _sanitize_filename(x_filename)
    suffix = Path(raw_name).suffix.lower()

    file_id = str(uuid.uuid4())
    gen_dir = resolve_data_dir() / "generated" / x_channel_id
    gen_dir.mkdir(parents=True, exist_ok=True)
    dst = gen_dir / f"{file_id}{suffix}"
    # Path traversal guard: x_channel_id is untrusted input.
    if not dst.resolve().is_relative_to(gen_dir.resolve()):
        raise HTTPException(status_code=400, detail="invalid channel_id path")

    # Stream to disk and stop immediately on size limit to avoid loading the whole body into memory.
    total = 0
    try:
        with open(dst, "wb") as fh:
            async for chunk in request.stream():
                if not chunk:
                    continue
                total += len(chunk)
                if total > max_bytes:
                    fh.close()
                    dst.unlink(missing_ok=True)
                    raise HTTPException(
                        status_code=413,
                        detail=f"文件超过上限 {max_bytes} bytes",
                    )
                fh.write(chunk)
    except HTTPException:
        raise
    except OSError as exc:
        dst.unlink(missing_ok=True)
        logger.warning("upload-binary write failed: %s", exc)
        raise HTTPException(status_code=500, detail="write failed") from exc

    if total == 0:
        dst.unlink(missing_ok=True)
        raise HTTPException(status_code=400, detail="文件不能为空")

    import mimetypes as _mimetypes
    # Infer content type from extension when missing or application/octet-stream.
    header_ctype = (content_type or "").split(";")[0].strip()
    if not header_ctype or header_ctype == "application/octet-stream":
        header_ctype = _mimetypes.guess_type(raw_name)[0] or "application/octet-stream"

    now = datetime.now(timezone.utc)
    record = FileRecord(
        file_id=file_id,
        channel_id=x_channel_id,
        uploader_id=bot.bot_id,
        original_path=str(dst),
        original_filename=raw_name,
        content_type=header_ctype,
        size_bytes=total,
        status="ready",
        uploaded_at=now,
        expires_at=file_expires_at(now),
    )
    session.add(record)
    await session.commit()

    return APIResponse.ok({
        "file_id": file_id,
        "filename": raw_name,
        "content_type": header_ctype,
        "size_bytes": total,
    })


# ============================================================================
# WebSocket routes.
# ============================================================================

ws_router = APIRouter()

_SUBSCRIBE_TIMEOUT_SECONDS = 10


class _BridgeOutboundQueueFull(RuntimeError):
    pass


class _BridgeOutboundWriter:
    def __init__(self, websocket: WebSocket) -> None:
        self.websocket = websocket
        self.queue: asyncio.Queue[dict | None] = asyncio.Queue(
            maxsize=max(1, int(settings.ws_outbound_queue_size or 256)),
        )
        self.closed = False
        self._task: asyncio.Task | None = None

    def start(self) -> None:
        self._task = asyncio.create_task(self._run())

    async def send(self, frame: dict) -> None:
        if self.closed:
            raise _BridgeOutboundQueueFull("agent bridge outbound writer is closed")
        try:
            self.queue.put_nowait(frame)
        except asyncio.QueueFull as exc:
            self.closed = True
            logger.warning("agent bridge ws: outbound queue full; closing slow dispatch subscriber")
            await self.close(code=1011, reason="outbound queue full")
            raise _BridgeOutboundQueueFull("agent bridge outbound queue full") from exc

    async def close(self, *, code: int = 1000, reason: str = "") -> None:
        if self.closed and code == 1000:
            return
        self.closed = True
        current = asyncio.current_task()
        if self._task and self._task is not current:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        try:
            await self.websocket.close(code=code, reason=reason)
        except Exception:
            pass

    async def _run(self) -> None:
        timeout = max(0.1, float(settings.ws_send_timeout_seconds or 5.0))
        try:
            while True:
                frame = await self.queue.get()
                if frame is None:
                    return
                await asyncio.wait_for(self.websocket.send_json(frame), timeout=timeout)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001
            self.closed = True
            logger.warning("agent bridge ws: outbound writer failed: %s", exc)
            try:
                await self.websocket.close(code=1011, reason="send failed")
            except Exception:
                pass
        finally:
            self.closed = True


async def _resolve_subscribable_bot_ids(
    session: AsyncSession, requested: list[str],
) -> tuple[list[str], list[str]]:
    """Resolve subscribable bot ids."""
    if not requested:
        return [], []
    rows = (await session.execute(
        select(BotAccount.bot_id).where(
            BotAccount.bot_id.in_(requested),
            BotAccount.binding_type == "agent_bridge",
        )
    )).all()
    accepted = {r[0] for r in rows}
    rejected = [b for b in requested if b not in accepted]
    return sorted(accepted), rejected


@ws_router.websocket("/ws/agent-bridge/dispatch")
async def bridge_websocket(websocket: WebSocket) -> None:
    token = websocket.query_params.get("token")
    try:
        _require_bridge_enabled_and_token(token)
    except HTTPException as exc:
        await websocket.close(code=1008, reason=exc.detail)
        return

    await websocket.accept()
    outbox = _BridgeOutboundWriter(websocket)
    outbox.start()
    # Start with an empty subscription so plugins receive no events until they subscribe.
    sub = await bridge_dispatcher.subscribe(bot_ids=[])
    await outbox.send({
        "type": "hello",
        "subscribers": bridge_dispatcher.subscriber_count(),
        "subscribe_required": True,
        "subscribe_timeout_seconds": _SUBSCRIBE_TIMEOUT_SECONDS,
    })
    logger.info("agent bridge ws: connected; awaiting subscribe frame")

    consumer_task: asyncio.Task | None = None
    try:
        # Step 1: handshake; require the plugin to send a subscribe frame within N seconds.
        try:
            raw = await asyncio.wait_for(
                websocket.receive_text(), timeout=_SUBSCRIBE_TIMEOUT_SECONDS,
            )
        except TimeoutError:
            await websocket.close(code=1008, reason="subscribe frame timeout")
            return

        try:
            first = json.loads(raw)
        except json.JSONDecodeError:
            await websocket.close(code=1003, reason="invalid JSON in subscribe frame")
            return

        if not isinstance(first, dict) or first.get("type") != "subscribe":
            await websocket.close(code=1003, reason="first frame must be {type:'subscribe'}")
            return

        requested = first.get("bot_ids") or []
        if not isinstance(requested, list) or not all(isinstance(x, str) for x in requested):
            await websocket.close(code=1003, reason="subscribe.bot_ids must be string[]")
            return

        # Validate bot_ids existence and binding_type=agent_bridge.
        from app.db.session import async_session_factory
        async with async_session_factory() as session:
            accepted, rejected = await _resolve_subscribable_bot_ids(session, requested)
        await bridge_dispatcher.update_subscription(sub, bot_ids=accepted)

        await outbox.send({
            "type": "subscribed",
            "accepted_bot_ids": accepted,
            "rejected_bot_ids": rejected,
        })
        logger.info(
            "agent bridge ws: subscribed accepted=%d rejected=%d",
            len(accepted), len(rejected),
        )

        # Step 2: consume dispatched events in the background and read plugin messages in the main loop.
        async def _consume() -> None:
            while True:
                event = await sub.queue.get()
                await outbox.send(event)

        consumer_task = asyncio.create_task(_consume())

        while True:
            raw = await websocket.receive_text()
            try:
                frame = json.loads(raw)
            except json.JSONDecodeError:
                await outbox.send({"type": "error", "detail": "invalid JSON"})
                continue
            if not isinstance(frame, dict):
                continue
            ftype = frame.get("type")
            if ftype == "subscribe":
                new_requested = frame.get("bot_ids") or []
                if isinstance(new_requested, list) and all(isinstance(x, str) for x in new_requested):
                    async with async_session_factory() as s2:
                        new_accepted, new_rejected = await _resolve_subscribable_bot_ids(s2, new_requested)
                    await bridge_dispatcher.update_subscription(sub, bot_ids=new_accepted)
                    await outbox.send({
                        "type": "subscribed",
                        "accepted_bot_ids": new_accepted,
                        "rejected_bot_ids": new_rejected,
                    })
            elif ftype == "ping":
                await outbox.send({"type": "pong"})
            # Other frame types are ignored for now.
    except WebSocketDisconnect:
        logger.info("agent bridge ws: disconnected")
    except _BridgeOutboundQueueFull:
        logger.info("agent bridge ws: disconnected due to outbound backpressure")
    except Exception as exc:  # noqa: BLE001
        logger.warning("agent bridge ws: error: %s", exc)
    finally:
        if consumer_task and not consumer_task.done():
            consumer_task.cancel()
        await bridge_dispatcher.unsubscribe(sub)
        await outbox.close()


# ============================================================================
# New control WS, Phase B: per-bot-token auth, membership hello snapshot, and targeted events.
# ============================================================================

# Close codes per design doc:
_WS_CLOSE_AUTH_FAIL = 4401        # Token missing, mismatched, or revoked.
_WS_CLOSE_SUPERSEDED = 4402       # A newer connection for the same bot superseded this one.
_WS_CLOSE_BOT_UNAVAILABLE = 4403  # Invalid binding_type or status != online.


def _extract_bearer_token(websocket: WebSocket) -> str | None:
    """Extract bearer token."""
    auth = websocket.headers.get("authorization") or ""
    if auth.lower().startswith("bearer "):
        return auth[7:].strip() or None
    return websocket.query_params.get("token")


@ws_router.websocket("/ws/agent-bridge/control")
async def control_websocket(websocket: WebSocket) -> None:
    """Control websocket."""
    from app.db.session import async_session_factory

    token = _extract_bearer_token(websocket)
    if not token:
        await websocket.close(code=_WS_CLOSE_AUTH_FAIL, reason="missing bearer token")
        return

    # Resolve token to bot.
    async with async_session_factory() as s:
        bot = await resolve_bot_by_token(s, token)
        if bot is None:
            await websocket.close(code=_WS_CLOSE_AUTH_FAIL, reason="invalid or revoked token")
            return
        if bot.status != "online":
            await websocket.close(
                code=_WS_CLOSE_BOT_UNAVAILABLE, reason=f"bot status is {bot.status}",
            )
            return
        memberships = await load_memberships(s, bot.bot_id)

    await websocket.accept()
    sess, old_ws = await bot_session_registry.bind_control(bot.bot_id, websocket)

    # Supersede the old connection, if any.
    if old_ws is not None:
        try:
            await old_ws.close(code=_WS_CLOSE_SUPERSEDED, reason="superseded by a new connection")
        except Exception:  # noqa: BLE001
            pass

    # First hello frame sends the full membership snapshot.
    await websocket.send_json({
        "type": "hello",
        "bot_id": bot.bot_id,
        "bot_username": bot.username,
        "bot_display_name": bot.display_name,
        "connection_id": sess.connection_id,
        "session_id": sess.session_id,
        "memberships": memberships,
    })
    logger.info(
        "control_ws: connected bot_id=%s connection_id=%s memberships=%d",
        bot.bot_id, sess.connection_id, len(memberships),
    )

    try:
        while True:
            raw = await websocket.receive_text()
            try:
                frame = json.loads(raw)
            except json.JSONDecodeError:
                await websocket.send_json({"type": "error", "detail": "invalid JSON"})
                continue
            if not isinstance(frame, dict):
                continue
            ftype = frame.get("type")
            if ftype == "ping":
                await websocket.send_json({"type": "pong"})
            elif ftype == "ready":
                logger.info(
                    "control_ws: ready bot_id=%s plugin_version=%s",
                    bot.bot_id, frame.get("plugin_version"),
                )
            # Ignore other frame types.
    except WebSocketDisconnect:
        logger.info("control_ws: disconnected bot_id=%s", bot.bot_id)
    except Exception as exc:  # noqa: BLE001
        logger.warning("control_ws: error bot_id=%s: %s", bot.bot_id, exc)
    finally:
        await bot_session_registry.unbind_control(bot.bot_id, websocket)


# ============================================================================
# Data WS, Phase C: message stream, reply/send callbacks, and send_ack.
# ============================================================================

async def _send_send_ack_err(websocket: WebSocket, client_msg_id: str | None, code: str, detail: str) -> None:
    await websocket.send_json({
        "type": "send_ack",
        "client_msg_id": client_msg_id,
        "ok": False,
        "error": detail,
        "code": code,
    })


async def _handle_data_reply(
    websocket: WebSocket, bot: BotAccount, frame: dict,
) -> None:
    """Handle data reply."""
    from app.db.session import async_session_factory
    from app.features.agent_bridge.validators import (
        check_bot_in_channel,
        check_files_in_channel,
    )

    client_msg_id = frame.get("client_msg_id")
    text = frame.get("text")
    if not isinstance(text, str):
        await _send_send_ack_err(websocket, client_msg_id, "invalid_text", "text 必须是字符串")
        return

    task_id = frame.get("task_id")
    reply_to_msg_id = frame.get("reply_to_msg_id")
    file_ids = frame.get("file_ids") or []
    if not isinstance(file_ids, list) or not all(isinstance(f, str) for f in file_ids):
        await _send_send_ack_err(websocket, client_msg_id, "invalid_file_ids", "file_ids 必须是 string[]")
        return

    # Text may be empty, but file_ids must be present so pure-media sendMedia can still create a message.
    if not text and not file_ids:
        await _send_send_ack_err(websocket, client_msg_id, "invalid_text", "text 和 file_ids 不能同时为空")
        return

    # Resolve the target channel:
    #   1) plugin explicitly sends channel_id, preferably echoed from the message event.
    #   2) peek pending state by reply_to_msg_id/task_id for orchestrator commit race windows.
    #   3) fall back to DB placeholder lookup after process restarts.
    channel_id = frame.get("channel_id")
    if not channel_id and reply_to_msg_id:
        pending = await pending_replies.peek_by_msg(reply_to_msg_id)
        if pending and pending.bot_id == bot.bot_id:
            channel_id = pending.channel_id
    if not channel_id and task_id:
        pending = await pending_replies.peek_by_task(task_id, bot.bot_id)
        if pending:
            channel_id = pending.channel_id

    async with async_session_factory() as s:
        if not channel_id and reply_to_msg_id:
            placeholder = (await s.execute(
                select(Message).where(Message.msg_id == reply_to_msg_id)
            )).scalar_one_or_none()
            if placeholder is not None:
                channel_id = placeholder.channel_id
        if not channel_id:
            await _send_send_ack_err(websocket, client_msg_id, "missing_channel", "无法确定 channel_id")
            return

        err = await check_bot_in_channel(s, bot_id=bot.bot_id, channel_id=channel_id)
        if err:
            await _send_send_ack_err(websocket, client_msg_id, err[0], err[1])
            return
        err = await check_files_in_channel(s, file_ids=file_ids, channel_id=channel_id)
        if err:
            await _send_send_ack_err(websocket, client_msg_id, err[0], err[1])
            return

    queued_msg_id = reply_to_msg_id
    if not queued_msg_id and task_id:
        pending = await pending_replies.peek_by_task(task_id, bot.bot_id)
        if pending:
            queued_msg_id = pending.msg_id
    job_id = await enqueue_bot_event_job(
        AGENT_BRIDGE_REPLY,
        {
            "bot_id": bot.bot_id,
            "channel_id": channel_id,
            "content": text,
            "task_id": task_id,
            "reply_to_msg_id": reply_to_msg_id,
            "file_ids": file_ids or [],
        },
    )

    await websocket.send_json({
        "type": "send_ack",
        "client_msg_id": client_msg_id,
        "ok": True,
        "queued": True,
        "job_id": job_id,
        "message_id": queued_msg_id,
        "finalized_placeholder": None,
    })


async def _handle_data_delta(
    websocket: WebSocket, bot: BotAccount, frame: dict,
) -> None:
    """Plugin streamed token. Buffer + broadcast `message_stream`; no DB write."""
    msg_id = frame.get("msg_id") or frame.get("reply_to_msg_id")
    delta = frame.get("delta")
    seq = frame.get("seq")
    if not isinstance(msg_id, str) or not msg_id:
        await websocket.send_json({"type": "error", "detail": "delta missing msg_id"})
        return
    if not isinstance(delta, str):
        await websocket.send_json({"type": "error", "detail": "delta must be string"})
        return
    if seq is not None and not isinstance(seq, int):
        await websocket.send_json({"type": "error", "detail": "seq must be int"})
        return
    accepted = await bridge_apply_delta(
        msg_id=msg_id, bot_id=bot.bot_id, seq=seq, delta=delta,
    )
    if not accepted:
        from app.db.session import async_session_factory

        async with async_session_factory() as s:
            placeholder = await s.get(Message, msg_id)
            can_recover_stream = (
                placeholder is not None
                and placeholder.sender_id == bot.bot_id
                and (
                    placeholder.is_partial
                    or not (placeholder.content or "").strip()
                    or bridge_is_task_content_data(placeholder.content_data)
                )
            )
            if placeholder is not None and can_recover_stream:
                await bridge_register_stream(
                    msg_id=msg_id,
                    bot_id=bot.bot_id,
                    channel_id=placeholder.channel_id,
                    task_id=placeholder.task_id,
                )
                accepted = await bridge_apply_delta(
                    msg_id=msg_id, bot_id=bot.bot_id, seq=seq, delta=delta,
                )
    if not accepted:
        # Stream unknown / wrong bot / already finalized — log on the plugin side
        # via debug ack; do not 4xx since the plugin can't recover anyway.
        logger.debug(
            "data_ws.delta: dropped msg_id=%s bot_id=%s seq=%s",
            msg_id, bot.bot_id, seq,
        )


async def _handle_data_trace(
    websocket: WebSocket, bot: BotAccount, frame: dict,
) -> None:
    """Plugin reports provider runtime progress/trace for a placeholder."""
    msg_id = frame.get("msg_id") or frame.get("reply_to_msg_id")
    if not isinstance(msg_id, str) or not msg_id:
        await websocket.send_json({"type": "error", "detail": "trace missing msg_id"})
        return
    stream = frame.get("stream")
    if not isinstance(stream, str) or not stream:
        await websocket.send_json({"type": "error", "detail": "trace missing stream"})
        return
    seq = frame.get("seq")
    if seq is not None and not isinstance(seq, int):
        await websocket.send_json({"type": "error", "detail": "trace seq must be int"})
        return
    ts = frame.get("ts")
    if ts is not None and not isinstance(ts, (int, float)):
        await websocket.send_json({"type": "error", "detail": "trace ts must be number"})
        return
    data = frame.get("data")
    if data is not None and not isinstance(data, dict):
        await websocket.send_json({"type": "error", "detail": "trace data must be object"})
        return

    accepted = await bridge_apply_trace(msg_id=msg_id, bot_id=bot.bot_id, payload=frame)
    if not accepted:
        logger.debug("data_ws.trace: dropped msg_id=%s bot_id=%s stream=%s", msg_id, bot.bot_id, stream)


async def _handle_data_session_update(
    websocket: WebSocket, bot: BotAccount, frame: dict,
) -> None:
    """Provider reports an external session/run identifier for observability."""
    provider_session_key = frame.get("provider_session_key")
    provider_session_id = frame.get("provider_session_id")
    metadata = frame.get("metadata")
    if not isinstance(provider_session_key, str) or not provider_session_key.strip():
        await websocket.send_json({"type": "error", "detail": "session_update missing provider_session_key"})
        return
    if provider_session_id is not None and not isinstance(provider_session_id, str):
        await websocket.send_json({"type": "error", "detail": "session_update provider_session_id must be string"})
        return
    if metadata is not None and not isinstance(metadata, dict):
        await websocket.send_json({"type": "error", "detail": "session_update metadata must be object"})
        return
    from app.db.session import async_session_factory

    async with async_session_factory() as s:
        row = (
            await s.execute(
                select(AgentNexusSession).where(
                    AgentNexusSession.bot_id == bot.bot_id,
                    AgentNexusSession.provider_session_key == provider_session_key.strip(),
                )
            )
        ).scalar_one_or_none()
        if row is None:
            await websocket.send_json({"type": "error", "detail": "session_update target not found"})
            return
        if provider_session_id:
            row.provider_session_id = provider_session_id.strip()
        if metadata:
            existing = dict(row.session_metadata or {})
            previous_report = existing.get("provider_report")
            if not isinstance(previous_report, dict):
                previous_report = {}
            existing["provider_report"] = {
                **previous_report,
                **metadata,
                "reported_at": datetime.now(timezone.utc).isoformat(),
            }
            row.session_metadata = existing
        await s.commit()


async def _handle_data_done(
    websocket: WebSocket, bot: BotAccount, frame: dict,
) -> None:
    """Plugin signals end of stream. Flush buffer, broadcast `message_done`.

    Optionally carries `file_ids` so binary outputs uploaded during the
    stream (sendMedia path) get attached to the same finalized message.
    """
    from app.db.session import async_session_factory
    from app.features.agent_bridge.streams import stream_registry as _stream_registry
    from app.features.agent_bridge.validators import check_files_in_channel

    msg_id = frame.get("msg_id") or frame.get("reply_to_msg_id")
    if not isinstance(msg_id, str) or not msg_id:
        await websocket.send_json({"type": "error", "detail": "done missing msg_id"})
        return
    raw_file_ids = frame.get("file_ids") or []
    if not isinstance(raw_file_ids, list) or not all(isinstance(f, str) for f in raw_file_ids):
        await websocket.send_json({"type": "error", "detail": "file_ids must be string[]"})
        return
    file_ids: list[str] = list(raw_file_ids)
    stream_snapshot: dict | None = None

    async with async_session_factory() as s:
        # Validate file ownership before finalize — reject the whole done if any
        # file_id doesn't belong to the stream's channel. We peek the registry
        # here (without popping) so finalize_stream's idempotency still controls
        # the actual lifecycle transition.
        if file_ids:
            state = await _stream_registry.get(msg_id)
            if state is not None:
                err = await check_files_in_channel(
                    s, file_ids=file_ids, channel_id=state.channel_id,
                )
                if err:
                    await websocket.send_json({
                        "type": "error", "code": err[0], "detail": err[1],
                    })
                    return
        state = await _stream_registry.get(msg_id)
        if state is not None and state.bot_id == bot.bot_id:
            async with state.lock:
                stream_snapshot = {
                    "channel_id": state.channel_id,
                    "task_id": state.task_id,
                    "content": state.buffer,
                }
    await bridge_flush_stream_deltas(msg_id)
    payload = {
        "msg_id": msg_id,
        "bot_id": bot.bot_id,
        "file_ids": file_ids or [],
    }
    if stream_snapshot:
        payload.update(stream_snapshot)
    await enqueue_bot_event_job(
        AGENT_BRIDGE_STREAM_DONE,
        payload,
    )
    if stream_snapshot:
        await _stream_registry.pop(msg_id)


async def _handle_data_error(
    websocket: WebSocket, bot: BotAccount, frame: dict,
) -> None:
    """Plugin reports a mid-stream error. Finalize partial with error tag."""
    msg_id = frame.get("msg_id") or frame.get("reply_to_msg_id")
    err_msg = frame.get("message") or frame.get("detail") or "plugin_error"
    if not isinstance(msg_id, str) or not msg_id:
        await websocket.send_json({"type": "error", "detail": "error frame missing msg_id"})
        return
    await enqueue_bot_event_job(
        AGENT_BRIDGE_STREAM_ERROR,
        {
            "msg_id": msg_id,
            "bot_id": bot.bot_id,
            "error": str(err_msg),
        },
    )


async def _handle_data_send(
    websocket: WebSocket, bot: BotAccount, frame: dict,
) -> None:
    """Handle data send."""
    from app.db.session import async_session_factory
    from app.features.agent_bridge.validators import (
        check_bot_in_channel,
        check_files_in_channel,
        check_in_reply_same_channel,
    )

    client_msg_id = frame.get("client_msg_id")
    channel_id = frame.get("channel_id")
    text = frame.get("text")
    if not isinstance(channel_id, str) or not channel_id:
        await _send_send_ack_err(websocket, client_msg_id, "missing_channel", "channel_id 必填")
        return
    if not isinstance(text, str):
        await _send_send_ack_err(websocket, client_msg_id, "invalid_text", "text 必须是字符串")
        return

    in_reply_to_msg_id = frame.get("in_reply_to_msg_id")
    file_ids = frame.get("file_ids") or []
    if not isinstance(file_ids, list) or not all(isinstance(f, str) for f in file_ids):
        await _send_send_ack_err(websocket, client_msg_id, "invalid_file_ids", "file_ids 必须是 string[]")
        return

    # Text may be empty, but file_ids must be present.
    if not text and not file_ids:
        await _send_send_ack_err(websocket, client_msg_id, "invalid_text", "text 和 file_ids 不能同时为空")
        return

    async with async_session_factory() as s:
        err = await check_bot_in_channel(s, bot_id=bot.bot_id, channel_id=channel_id)
        if err:
            await _send_send_ack_err(websocket, client_msg_id, err[0], err[1])
            return
        err = await check_files_in_channel(s, file_ids=file_ids, channel_id=channel_id)
        if err:
            await _send_send_ack_err(websocket, client_msg_id, err[0], err[1])
            return
        if in_reply_to_msg_id:
            err = await check_in_reply_same_channel(s, msg_id=in_reply_to_msg_id, channel_id=channel_id)
            if err:
                await _send_send_ack_err(websocket, client_msg_id, err[0], err[1])
                return

        msg, _ = await finalize_bot_reply(
            s,
            bot_id=bot.bot_id,
            channel_id=channel_id,
            content=text,
            task_id=None,
            reply_to_msg_id=None,
            in_reply_to_msg_id=in_reply_to_msg_id,
            file_ids=file_ids or None,
        )
        await s.commit()

    await websocket.send_json({
        "type": "send_ack",
        "client_msg_id": client_msg_id,
        "ok": True,
        "message_id": msg.msg_id,
    })


async def _handle_data_file_upload(
    websocket: WebSocket, bot: BotAccount, frame: dict,
) -> None:
    """Handle data file upload."""
    import base64
    import mimetypes as _mimetypes

    from app.db.session import async_session_factory
    from app.features.agent_bridge.validators import check_bot_in_channel

    client_file_id = frame.get("client_file_id")

    async def _err(code: str, detail: str) -> None:
        await websocket.send_json({
            "type": "file_upload_ack",
            "client_file_id": client_file_id,
            "ok": False,
            "code": code,
            "error": detail,
        })

    channel_id = frame.get("channel_id")
    filename = frame.get("filename")
    content_type = frame.get("content_type")
    data_b64 = frame.get("data_b64")

    if not isinstance(channel_id, str) or not channel_id:
        await _err("missing_channel", "channel_id 必填")
        return
    if not isinstance(filename, str) or not filename.strip():
        await _err("missing_filename", "filename 必填")
        return
    if not isinstance(data_b64, str) or not data_b64:
        await _err("missing_data", "data_b64 必填")
        return

    try:
        raw = base64.b64decode(data_b64, validate=False)
    except Exception:  # noqa: BLE001
        await _err("invalid_data", "data_b64 无法解码")
        return

    max_bytes = int(settings.file_upload_max_bytes)
    if len(raw) == 0:
        await _err("empty_file", "文件不能为空")
        return
    if len(raw) > max_bytes:
        await _err("too_large", f"文件超过上限 {max_bytes} bytes")
        return

    safe_name = _sanitize_filename(filename)
    suffix = Path(safe_name).suffix.lower()

    file_id = str(uuid.uuid4())
    gen_dir = resolve_data_dir() / "generated" / channel_id
    gen_dir.mkdir(parents=True, exist_ok=True)
    dst = gen_dir / f"{file_id}{suffix}"
    if not dst.resolve().is_relative_to(gen_dir.resolve()):
        await _err("invalid_path", "invalid channel_id path")
        return

    async with async_session_factory() as s:
        err = await check_bot_in_channel(s, bot_id=bot.bot_id, channel_id=channel_id)
        if err:
            await _err(err[0], err[1])
            return

        try:
            with open(dst, "wb") as fh:
                fh.write(raw)
        except OSError as exc:
            dst.unlink(missing_ok=True)
            logger.warning(
                "data_ws.file_upload: write failed bot_id=%s channel=%s: %s",
                bot.bot_id, channel_id, exc,
            )
            await _err("write_failed", "write failed")
            return

        header_ctype = (
            content_type.split(";")[0].strip()
            if isinstance(content_type, str) else ""
        )
        if not header_ctype or header_ctype == "application/octet-stream":
            header_ctype = _mimetypes.guess_type(safe_name)[0] or "application/octet-stream"

        now = datetime.now(timezone.utc)
        record = FileRecord(
            file_id=file_id,
            channel_id=channel_id,
            uploader_id=bot.bot_id,
            original_path=str(dst),
            original_filename=safe_name,
            content_type=header_ctype,
            size_bytes=len(raw),
            status="ready",
            uploaded_at=now,
            expires_at=file_expires_at(now),
        )
        s.add(record)
        await s.commit()

    logger.info(
        "data_ws.file_upload: ok bot_id=%s channel=%s file_id=%s name=%s size=%d",
        bot.bot_id, channel_id, file_id, safe_name, len(raw),
    )

    await websocket.send_json({
        "type": "file_upload_ack",
        "client_file_id": client_file_id,
        "ok": True,
        "file_id": file_id,
        "filename": safe_name,
        "content_type": header_ctype,
        "size_bytes": len(raw),
    })


@ws_router.websocket("/ws/agent-bridge/data")
async def data_websocket(websocket: WebSocket) -> None:
    """Data websocket."""
    from app.db.session import async_session_factory

    token = _extract_bearer_token(websocket)
    if not token:
        await websocket.close(code=_WS_CLOSE_AUTH_FAIL, reason="missing bearer token")
        return

    async with async_session_factory() as s:
        bot = await resolve_bot_by_token(s, token)
        if bot is None:
            await websocket.close(code=_WS_CLOSE_AUTH_FAIL, reason="invalid or revoked token")
            return
        if bot.status != "online":
            await websocket.close(
                code=_WS_CLOSE_BOT_UNAVAILABLE, reason=f"bot status is {bot.status}",
            )
            return

    await websocket.accept()
    sess, old_ws = await bot_session_registry.bind_data(bot.bot_id, websocket)
    if old_ws is not None:
        try:
            await old_ws.close(code=_WS_CLOSE_SUPERSEDED, reason="superseded by a new connection")
        except Exception:  # noqa: BLE001
            pass

    from app.features.agent_bridge.event_log import current_seq

    last_seq = await current_seq(bot.bot_id, "data")
    await websocket.send_json({
        "type": "hello",
        "stream": "data",
        "bot_id": bot.bot_id,
        "connection_id": sess.connection_id,
        "session_id": sess.session_id,
        "last_event_seq": last_seq,
    })
    logger.info(
        "data_ws: connected bot_id=%s connection_id=%s last_event_seq=%d",
        bot.bot_id, sess.connection_id, last_seq,
    )

    try:
        while True:
            raw = await websocket.receive_text()
            try:
                frame = json.loads(raw)
            except json.JSONDecodeError:
                await websocket.send_json({"type": "error", "detail": "invalid JSON"})
                continue
            if not isinstance(frame, dict):
                continue
            ftype = frame.get("type")
            if ftype == "reply":
                await _handle_data_reply(websocket, bot, frame)
            elif ftype == "send":
                await _handle_data_send(websocket, bot, frame)
            elif ftype == "delta":
                await _handle_data_delta(websocket, bot, frame)
            elif ftype == "trace":
                await _handle_data_trace(websocket, bot, frame)
            elif ftype == "session_update":
                await _handle_data_session_update(websocket, bot, frame)
            elif ftype == "done":
                await _handle_data_done(websocket, bot, frame)
            elif ftype == "error":
                await _handle_data_error(websocket, bot, frame)
            elif ftype == "file_upload":
                await _handle_data_file_upload(websocket, bot, frame)
            elif ftype == "ping":
                await websocket.send_json({"type": "pong"})
            elif ftype == "typing":
                # Optional future typing broadcast; ignored for now.
                pass
            elif ftype == "resume":
                from app.features.agent_bridge.event_log import (
                    current_seq as _cur_seq,
                )
                from app.features.agent_bridge.event_log import (
                    events_since,
                )
                try:
                    last_seen = int(frame.get("last_event_seq") or 0)
                except (TypeError, ValueError):
                    last_seen = 0
                events = await events_since(bot.bot_id, "data", last_seen)
                for ev in events:
                    await websocket.send_json(ev)
                up_to = await _cur_seq(bot.bot_id, "data")
                await websocket.send_json({
                    "type": "resume_ack",
                    "replayed": len(events),
                    "up_to_seq": up_to,
                })
                logger.info(
                    "data_ws: resume bot_id=%s from_seq=%d replayed=%d up_to=%d",
                    bot.bot_id, last_seen, len(events), up_to,
                )
            # Ignore other frame types.
    except WebSocketDisconnect:
        logger.info("data_ws: disconnected bot_id=%s", bot.bot_id)
    except Exception as exc:  # noqa: BLE001
        logger.warning("data_ws: error bot_id=%s: %s", bot.bot_id, exc)
    finally:
        await bot_session_registry.unbind_data(bot.bot_id, websocket)
