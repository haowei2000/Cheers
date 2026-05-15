"""File v1 路由."""
from __future__ import annotations

from pathlib import Path
from urllib.parse import quote

from fastapi import APIRouter, Depends, Query
from fastapi.responses import Response
from pydantic import BaseModel, model_validator
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.core.dependencies import get_current_user, get_session
from app.core.exceptions import AppError, NotFoundError
from app.core.responses import APIResponse
from app.db.models import FileRecord, User
from app.services.channel_service import ChannelService
from app.services.file_processor.convert import (
    FileParseError,
    UnsupportedFileTypeError,
    is_image_type,
    parse_document_bytes,
)
from app.services.file_retention import active_file_filter

router = APIRouter(prefix="/files", tags=["files"])


def _content_disposition(filename: str, disposition: str = "attachment") -> str:
    encoded = quote(filename, safe="")
    return f"{disposition}; filename*=UTF-8''{encoded}"


def _inline_disposition(content_type: str) -> bool:
    ct = content_type.lower()
    return is_image_type(ct) or "pdf" in ct or ct.startswith("text/")


def _storage_scope(rec: FileRecord) -> str:
    return "generated" if (rec.object_key or "").startswith("generated/") else "uploads"


async def _load_active_file_or_404(session: AsyncSession, file_id: str) -> FileRecord:
    result = await session.execute(
        select(FileRecord).where(FileRecord.file_id == file_id, active_file_filter())
    )
    rec = result.scalar_one_or_none()
    if not rec:
        raise NotFoundError("file not found")
    return rec


async def _require_file_access(
    session: AsyncSession,
    rec: FileRecord,
    current_user: User,
) -> None:
    await ChannelService(session).require_channel_member(rec.channel_id, current_user)


async def _load_file_body(rec: FileRecord) -> bytes:
    if not rec.object_key and rec.original_path:
        local_path = Path(rec.original_path)
        if local_path.is_file():
            return local_path.read_bytes()

    from app.services.storage.base import StorageObjectNotFoundError
    from app.services.storage.bootstrap import get_storage_service, is_storage_enabled

    if not is_storage_enabled():
        raise AppError("storage not enabled")
    storage = get_storage_service()
    try:
        obj = await storage.get_object(rec.file_id, scope=_storage_scope(rec))
    except StorageObjectNotFoundError:
        raise NotFoundError("file not found in storage")
    except Exception as exc:
        raise AppError("failed to load file") from exc
    return obj.body


class PresignBody(BaseModel):
    channel_id: str
    filename: str
    content_type: str
    size_bytes: int = 0
    size: int | None = None  # frontend alias for size_bytes

    @model_validator(mode="after")
    def _coerce_size(self) -> "PresignBody":
        if self.size is not None and not self.size_bytes:
            self.size_bytes = self.size
        return self


@router.post("/presign", response_model=APIResponse[dict])
async def request_presign(
    body: PresignBody,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    from app.services.file_service import FileService
    svc = FileService(session)
    result = await svc.request_presign(
        channel_id=body.channel_id,
        filename=body.filename,
        content_type=body.content_type,
        size_bytes=body.size_bytes,
        uploader=current_user,
    )
    return APIResponse.ok(result)


@router.post("/{file_id}/confirm", response_model=APIResponse[dict])
async def confirm_upload(
    file_id: str,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    from app.core.schemas import MessageFileInResponse
    from app.services.file_service import FileService
    svc = FileService(session)
    rec = await svc.confirm_upload(file_id, current_user)
    return APIResponse.ok(MessageFileInResponse.model_validate(rec).model_dump())


@router.get("/{file_id}/url", response_model=APIResponse[dict])
async def get_download_url(
    file_id: str,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    rec = await _load_active_file_or_404(session, file_id)
    await _require_file_access(session, rec, current_user)
    url = f"/api/v1/files/{file_id}/download"
    return APIResponse.ok({"url": url})


@router.get("/by-channel/{channel_id}", response_model=APIResponse[list])
async def list_channel_files(
    channel_id: str,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    """列出频道下所有非图片文件（与资料索引一致）。"""
    from sqlalchemy import asc
    await ChannelService(session).require_channel_member(channel_id, current_user)
    result = await session.execute(
        select(FileRecord)
        .where(
            FileRecord.channel_id == channel_id,
            FileRecord.content_type.notlike("image/%"),
            active_file_filter(),
        )
        .order_by(asc(FileRecord.created_at))
    )
    records = result.scalars().all()
    return APIResponse.ok([
        {
            "file_id": r.file_id,
            "original_filename": r.original_filename,
            "content_type": r.content_type,
            "size_bytes": r.size_bytes,
            "status": r.status,
            "summary_3lines": r.summary_3lines,
            "created_at": r.created_at.isoformat() if r.created_at else None,
            "expires_at": r.expires_at.isoformat() if r.expires_at else None,
        }
        for r in records
    ])


@router.get("/{file_id}/status", response_model=APIResponse[dict])
async def file_status(
    file_id: str,
    channel_id: str = Query(...),
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    await ChannelService(session).require_channel_member(channel_id, current_user)
    result = await session.execute(
        select(FileRecord).where(
            FileRecord.file_id == file_id,
            FileRecord.channel_id == channel_id,
            active_file_filter(),
        )
    )
    rec = result.scalar_one_or_none()
    if not rec:
        raise NotFoundError("file not found")
    return APIResponse.ok({
        "file_id": rec.file_id,
        "channel_id": rec.channel_id,
        "original_filename": rec.original_filename,
        "content_type": rec.content_type,
        "size_bytes": rec.size_bytes,
        "status": rec.status,
        "uploaded_at": rec.uploaded_at.isoformat() if rec.uploaded_at else None,
        "expires_at": rec.expires_at.isoformat() if rec.expires_at else None,
        "last_error": rec.last_error,
    })


@router.get("/{file_id}/preview")
async def file_preview(
    file_id: str,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> Response:
    rec = await _load_active_file_or_404(session, file_id)
    await _require_file_access(session, rec, current_user)

    content_type = rec.content_type or "application/octet-stream"
    filename = rec.original_filename or file_id
    disposition = (
        _content_disposition(filename, "inline")
        if _inline_disposition(content_type)
        else _content_disposition(filename)
    )
    body = await _load_file_body(rec)
    return Response(
        content=body,
        media_type=content_type,
        headers={
            "Content-Disposition": disposition,
            "Cache-Control": "private, max-age=3600",
        },
    )


@router.get("/{file_id}/content", response_model=APIResponse[dict])
async def file_preview_content(
    file_id: str,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    """返回适合预览窗口展示的文本/Markdown 内容。"""
    rec = await _load_active_file_or_404(session, file_id)
    await _require_file_access(session, rec, current_user)

    filename = rec.original_filename or file_id
    content_type = rec.content_type or "application/octet-stream"
    if is_image_type(content_type):
        return APIResponse.ok({
            "file_id": rec.file_id,
            "filename": filename,
            "content_type": content_type,
            "preview_type": "image",
            "content": "",
            "truncated": False,
            "summary": rec.summary_3lines,
            "expires_at": rec.expires_at.isoformat() if rec.expires_at else None,
        })

    if rec.md_path:
        cache_path = Path(rec.md_path)
        if cache_path.is_file():
            return APIResponse.ok({
                "file_id": rec.file_id,
                "filename": filename,
                "content_type": content_type,
                "preview_type": "markdown",
                "content": cache_path.read_text(encoding="utf-8", errors="replace"),
                "truncated": False,
                "summary": rec.summary_3lines,
                "expires_at": rec.expires_at.isoformat() if rec.expires_at else None,
            })

    try:
        parsed = parse_document_bytes(
            await _load_file_body(rec),
            filename=filename,
            content_type=content_type,
            max_chars=settings.file_parse_max_chars,
        )
    except UnsupportedFileTypeError as exc:
        return APIResponse.ok({
            "file_id": rec.file_id,
            "filename": filename,
            "content_type": content_type,
            "preview_type": "unsupported",
            "content": "",
            "truncated": False,
            "summary": rec.summary_3lines,
            "expires_at": rec.expires_at.isoformat() if rec.expires_at else None,
            "error": str(exc),
        })
    except FileParseError as exc:
        raise AppError(f"file preview failed: {exc}") from exc

    return APIResponse.ok({
        "file_id": rec.file_id,
        "filename": filename,
        "content_type": content_type,
        "preview_type": (
            "markdown"
            if filename.lower().endswith((".md", ".markdown", ".xlsx"))
            else "text"
        ),
        "content": parsed.text,
        "truncated": parsed.truncated,
        "summary": parsed.summary,
        "expires_at": rec.expires_at.isoformat() if rec.expires_at else None,
    })


@router.get("/{file_id}/download")
async def file_download(
    file_id: str,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> Response:
    rec = await _load_active_file_or_404(session, file_id)
    await _require_file_access(session, rec, current_user)

    filename = rec.original_filename or file_id
    body = await _load_file_body(rec)
    return Response(
        content=body,
        media_type=rec.content_type or "application/octet-stream",
        headers={
            "Content-Disposition": _content_disposition(filename),
            "Cache-Control": "private, max-age=3600",
        },
    )
