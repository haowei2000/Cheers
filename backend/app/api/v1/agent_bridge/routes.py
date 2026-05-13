"""Agent Bridge 路由。

- POST /api/v1/agent-bridge/messages — plugin 回推 Bot 回复
- WS   /ws/agent-bridge/dispatch       — plugin 订阅派发事件（需 subscribe 握手）
- GET  /api/v1/agent-bridge/status     — 在线 plugin 数 + pending 数
- GET  /api/v1/agent-bridge/channels/{channel_id}/bots — 该频道下的 Agent Bridge Bot 清单（精简字段）

鉴权：共享密钥 `AGENT_BRIDGE_TOKEN`（.env 配置）
  - POST/GET：Header `X-Agent-Bridge-Token`
  - WS：连接 URL 查询参数 `?token=...`

写入校验（第一阶段最小安全补丁）：
  - POST /messages：目标 Bot 必须是频道成员、状态 online；file_ids 必须在同频道；
    in_reply_to_msg_id 必须指向同频道内消息。
  - GET /channels/{id}/bots：不回 binding_config，只暴露公共字段。
  - WS 订阅必须在握手时声明 bot_ids，dispatcher 定向推送，未声明前不收事件。
"""
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

logger = logging.getLogger("app.api.v1.agent_bridge")

router = APIRouter(prefix="/agent-bridge", tags=["agent-bridge"])


# ============================================================================
# 鉴权
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
# HTTP 路由
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
    await ChannelService(session).require_channel_member(body.channel_id, current_user)

    bot_id = body.bot_id
    if not bot_id:
        bot_member = (await session.execute(
            select(ChannelMembership).where(
                ChannelMembership.channel_id == body.channel_id,
                ChannelMembership.member_type == "bot",
            )
        )).scalar_one_or_none()
        bot_id = bot_member.member_id if bot_member else None
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
    # 把 validators 的错误码映射成 HTTP 状态
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
    # 1) Bot 存在 + 类型 agent_bridge + 在线
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

    # 2) Bot 必须是目标频道成员
    await _assert_bot_in_channel(session, bot_id=body.bot_id, channel_id=body.channel_id)

    # 3) 附件必须在目标频道
    if body.file_ids:
        await _assert_files_in_channel(session, file_ids=body.file_ids, channel_id=body.channel_id)

    # 4) in_reply_to_msg_id 必须指向同频道消息（仅新建消息路径相关，
    #    finalize 占位消息时 in_reply_to 已在 pre_create 时设好，此字段被忽略）
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
    """列出该频道下绑定为 Agent Bridge 的 Bot。

    精简字段：仅暴露 bot_id / username / display_name / status。
    敏感 binding_config 不回显（留待 per-plugin 凭证上线后按配额回拉）。
    """
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
# per-bot-token 文件读取（agent 侧 read_file 支持）
# ============================================================================

# agent 读取文件正文时的内联大小上限；超过则截断并标记 truncated=true。
# 做上限的目的是防一个 200MB 的 PDF 直接塞进 agent 的 system prompt。
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
    """Bearer agb_xxx → BotAccount。失败统一抛 401。"""
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
    """Bot 读取一个频道内文件的已转换 markdown 正文。

    鉴权：per-bot token `Authorization: Bearer agb_...`（即 plugin 的 botToken）。
    授权：bot 必须是文件所在频道的成员。
    返回：{file_id, filename, content_type, size_bytes, content, truncated, summary}。
    图片类文件不通过此接口取 base64；此接口仅为文档内容。
    """
    bot = await _resolve_bot_by_bearer(session, authorization)

    record = (await session.execute(
        select(FileRecord).where(FileRecord.file_id == file_id)
    )).scalar_one_or_none()
    if record is None:
        raise HTTPException(status_code=404, detail=f"file {file_id} 不存在")

    await _assert_bot_membership(session, bot_id=bot.bot_id, channel_id=record.channel_id)

    if is_image_type(record.content_type or ""):
        raise HTTPException(
            status_code=415,
            detail="该文件是图片，文本接口不支持；请使用 Vision 能力处理图片附件",
        )

    # 触发一次转换（若 md cache 已就绪会直接命中缓存），然后裁剪到上限
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
    """Bot 读取一个频道内文件的原始二进制内容，供 ACP image/resource 输入使用。

    鉴权：per-bot token `Authorization: Bearer agb_...`。
    授权：bot 必须是文件所在频道的成员。
    返回 base64，connector 可转换为 ACP `image` 或 blob `resource` content block。
    """
    bot = await _resolve_bot_by_bearer(session, authorization)

    record = (await session.execute(
        select(FileRecord).where(FileRecord.file_id == file_id)
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
# per-bot-token 文件上传（agent 侧 attach-file 支持）
# ============================================================================

# 单次上传 markdown 正文的大小上限，防一条失控的长回复灌爆对象存储。
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
    """Bot 上传一段 markdown 文本为频道附件，返回 file_id。

    鉴权：per-bot token `Authorization: Bearer agb_...`。
    授权：bot 必须是目标频道的成员。
    用途：agent 产出超长内容时，plugin 可把正文转存为 .md 文件作为消息附件。
    """
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
    # path traversal guard：body.channel_id 不是受信任输入，确保写入不越出 gen_dir
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
    )
    session.add(record)
    await session.commit()

    return APIResponse.ok({
        "file_id": file_id,
        "filename": safe_name,
        "size_bytes": byte_size,
    })


# ============================================================================
# per-bot-token 二进制文件上传（agent 侧 sendMedia 支持）
# ============================================================================

# 单次二进制上传的大小上限；对齐 settings.file_upload_max_bytes。
# MEDIA: 协议里 gateway 会把本地媒体文件直接交给 plugin；plugin 再把它传上来
# 落成 FileRecord，作为消息附件。
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
    """Bot 上传一个二进制文件为频道附件，返回 file_id。

    鉴权：per-bot token `Authorization: Bearer agb_...`。
    授权：bot 必须是目标频道的成员。
    用途：provider gateway 抽出 agent 输出的 MEDIA: 行后，bridge plugin 通过
    `sendMedia({ to, filePath })` 拿到本地媒体文件，调本接口上传并得到 file_id，
    再在后续 reply/send 帧里带上 file_ids。

    协议（走 raw body 而非 multipart，避免引入 python-multipart 依赖）：
      - Body：二进制文件原始字节；Content-Type: 文件 MIME（或 application/octet-stream）
      - Header X-Channel-Id：目标频道 id（必填）
      - Header X-Filename：原始文件名（必填，用于扩展名 + 展示）
    """
    bot = await _resolve_bot_by_bearer(session, authorization)
    await _assert_bot_membership(session, bot_id=bot.bot_id, channel_id=x_channel_id)

    max_bytes = int(settings.file_upload_max_bytes)

    raw_name = _sanitize_filename(x_filename)
    suffix = Path(raw_name).suffix.lower()

    file_id = str(uuid.uuid4())
    gen_dir = resolve_data_dir() / "generated" / x_channel_id
    gen_dir.mkdir(parents=True, exist_ok=True)
    dst = gen_dir / f"{file_id}{suffix}"
    # path traversal guard：x_channel_id 不是受信任输入
    if not dst.resolve().is_relative_to(gen_dir.resolve()):
        raise HTTPException(status_code=400, detail="invalid channel_id path")

    # 流式落盘，超限立即截断；避免把 25MB body 全部装进内存
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
    # Content-Type 没传或是 application/octet-stream 时，从扩展名猜
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
# WebSocket 路由
# ============================================================================

ws_router = APIRouter()

_SUBSCRIBE_TIMEOUT_SECONDS = 10


async def _resolve_subscribable_bot_ids(
    session: AsyncSession, requested: list[str],
) -> tuple[list[str], list[str]]:
    """过滤 plugin 声明的 bot_ids：只保留确实存在且 binding_type='agent_bridge' 的。

    Returns: (accepted, rejected)
    """
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
    # 初始订阅为空集合：plugin 在发出 subscribe 之前不会收到任何事件（默认拒绝）。
    sub = await bridge_dispatcher.subscribe(bot_ids=[])
    await websocket.send_json({
        "type": "hello",
        "subscribers": bridge_dispatcher.subscriber_count(),
        "subscribe_required": True,
        "subscribe_timeout_seconds": _SUBSCRIBE_TIMEOUT_SECONDS,
    })
    logger.info("agent bridge ws: connected; awaiting subscribe frame")

    consumer_task: asyncio.Task | None = None
    try:
        # 第一步：握手 —— 要求 plugin 在 N 秒内发 subscribe 帧
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

        # 校验 bot_ids 存在且 binding_type=agent_bridge
        from app.db.session import async_session_factory
        async with async_session_factory() as session:
            accepted, rejected = await _resolve_subscribable_bot_ids(session, requested)
        await bridge_dispatcher.update_subscription(sub, bot_ids=accepted)

        await websocket.send_json({
            "type": "subscribed",
            "accepted_bot_ids": accepted,
            "rejected_bot_ids": rejected,
        })
        logger.info(
            "agent bridge ws: subscribed accepted=%d rejected=%d",
            len(accepted), len(rejected),
        )

        # 第二步：后台消费派发事件 → 发给 WS；主循环消费 plugin 的后续消息（如 re-subscribe、ping）
        async def _consume() -> None:
            while True:
                event = await sub.queue.get()
                await websocket.send_json(event)

        consumer_task = asyncio.create_task(_consume())

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
            if ftype == "subscribe":
                new_requested = frame.get("bot_ids") or []
                if isinstance(new_requested, list) and all(isinstance(x, str) for x in new_requested):
                    async with async_session_factory() as s2:
                        new_accepted, new_rejected = await _resolve_subscribable_bot_ids(s2, new_requested)
                    await bridge_dispatcher.update_subscription(sub, bot_ids=new_accepted)
                    await websocket.send_json({
                        "type": "subscribed",
                        "accepted_bot_ids": new_accepted,
                        "rejected_bot_ids": new_rejected,
                    })
            elif ftype == "ping":
                await websocket.send_json({"type": "pong"})
            # 其他类型暂不处理
    except WebSocketDisconnect:
        logger.info("agent bridge ws: disconnected")
    except Exception as exc:  # noqa: BLE001
        logger.warning("agent bridge ws: error: %s", exc)
    finally:
        if consumer_task and not consumer_task.done():
            consumer_task.cancel()
        await bridge_dispatcher.unsubscribe(sub)


# ============================================================================
# 新 control WS（Phase B）：per-bot token 鉴权 + membership hello 快照 + 定向事件
# ============================================================================

# Close codes per design doc:
_WS_CLOSE_AUTH_FAIL = 4401        # token 缺失 / 不匹配 / 已撤销
_WS_CLOSE_SUPERSEDED = 4402       # 同一 bot 的新连接接管了旧连接
_WS_CLOSE_BOT_UNAVAILABLE = 4403  # binding_type 不对或 status != online


def _extract_bearer_token(websocket: WebSocket) -> str | None:
    """优先从 Authorization 头取 Bearer；缺失时退化到 ?token= 查询参数（便于 CLI 调试）。"""
    auth = websocket.headers.get("authorization") or ""
    if auth.lower().startswith("bearer "):
        return auth[7:].strip() or None
    return websocket.query_params.get("token")


@ws_router.websocket("/ws/agent-bridge/control")
async def control_websocket(websocket: WebSocket) -> None:
    """Agent Bridge control 流 —— membership 事件 + 心跳。

    认证：`Authorization: Bearer agb_...`（推荐）或 `?token=agb_...`（便于 CLI 调试）。
    同一 bot_id 的新连接会把旧连接以 4402 踢下线。
    """
    from app.db.session import async_session_factory

    token = _extract_bearer_token(websocket)
    if not token:
        await websocket.close(code=_WS_CLOSE_AUTH_FAIL, reason="missing bearer token")
        return

    # 解析 token → bot
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

    # 踢掉旧连接（如果有）
    if old_ws is not None:
        try:
            await old_ws.close(code=_WS_CLOSE_SUPERSEDED, reason="superseded by a new connection")
        except Exception:  # noqa: BLE001
            pass

    # 首帧 hello：下发完整 membership 快照
    await websocket.send_json({
        "type": "hello",
        "bot_id": bot.bot_id,
        "bot_username": bot.username,
        "bot_display_name": bot.display_name,
        "session_id": sess.session_id,
        "memberships": memberships,
    })
    logger.info(
        "control_ws: connected bot_id=%s session=%s memberships=%d",
        bot.bot_id, sess.session_id, len(memberships),
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
            # 其他类型忽略
    except WebSocketDisconnect:
        logger.info("control_ws: disconnected bot_id=%s", bot.bot_id)
    except Exception as exc:  # noqa: BLE001
        logger.warning("control_ws: error bot_id=%s: %s", bot.bot_id, exc)
    finally:
        await bot_session_registry.unbind_control(bot.bot_id, websocket)


# ============================================================================
# data WS（Phase C）：消息流 + reply/send 回推 + send_ack
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
    """plugin 回推 Bot 回复：finalize 占位消息或新建消息。"""
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

    # 允许 text 为空，但必须至少有 file_ids——这样 sendMedia（纯媒体）也能兜底发一条消息
    if not text and not file_ids:
        await _send_send_ack_err(websocket, client_msg_id, "invalid_text", "text 和 file_ids 不能同时为空")
        return

    # 定位目标频道：
    #   1) plugin 显式传 channel_id（最推荐，从 message 事件里直接带回来）
    #   2) 按 reply_to_msg_id / task_id 从 pending 内存里 peek（适用于 orchestrator
    #      会话尚未 commit、DB 里还看不到占位消息的竞态窗口）
    #   3) 最后回落到 DB 查占位消息（适用于进程重启后的兜底路径）
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
    """plugin 主动在某频道发一条 Bot 消息（非响应式）。"""
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

    # 允许 text 为空，但必须至少有 file_ids
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
    """Plugin 通过 data WS 直传二进制文件，避免依赖 HTTP /files/upload-binary。

    入帧:
      {
        "type": "file_upload",
        "client_file_id": "<plugin 自定关联 id，回 ack 时原样带回>",
        "channel_id": "<目标频道>",
        "filename": "report.pdf",
        "content_type": "application/pdf",   # optional
        "data_b64": "<base64 of raw bytes>",
      }

    回帧:
      成功 -> {type:"file_upload_ack", client_file_id, ok:true, file_id, filename, content_type, size_bytes}
      失败 -> {type:"file_upload_ack", client_file_id, ok:false, code, error}
    """
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
    """Agent Bridge data 流 —— 消息入站 + reply/send 回推 + 心跳。

    认证、接管、错误码与 control WS 一致（4401/4402/4403）。
    """
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
        "session_id": sess.session_id,
        "last_event_seq": last_seq,
    })
    logger.info(
        "data_ws: connected bot_id=%s session=%s last_event_seq=%d",
        bot.bot_id, sess.session_id, last_seq,
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
            elif ftype == "done":
                await _handle_data_done(websocket, bot, frame)
            elif ftype == "error":
                await _handle_data_error(websocket, bot, frame)
            elif ftype == "file_upload":
                await _handle_data_file_upload(websocket, bot, frame)
            elif ftype == "ping":
                await websocket.send_json({"type": "pong"})
            elif ftype == "typing":
                # 可选：未来广播 typing 状态；现在忽略
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
            # 其他类型忽略
    except WebSocketDisconnect:
        logger.info("data_ws: disconnected bot_id=%s", bot.bot_id)
    except Exception as exc:  # noqa: BLE001
        logger.warning("data_ws: error bot_id=%s: %s", bot.bot_id, exc)
    finally:
        await bot_session_registry.unbind_data(bot.bot_id, websocket)
