"""Files API routes."""
from __future__ import annotations

import base64
import mimetypes
from pathlib import Path
from urllib.parse import quote, urlencode

import jwt
from fastapi import APIRouter, Depends, Query
from fastapi.responses import Response
from pydantic import BaseModel, model_validator
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.core.dependencies import get_current_user, get_session
from app.core.exceptions import AppError, NotFoundError, UnauthorizedError
from app.core.responses import APIResponse
from app.db.models import FileRecord, User
from app.services.auth.jwt_utils import create_service_token, decode_service_token
from app.services.channel_service import ChannelService
from app.services.file_processor.convert import (
    FileParseError,
    UnsupportedFileTypeError,
    is_image_type,
    parse_document_bytes,
)
from app.services.file_retention import active_file_filter

router = APIRouter(prefix="/files", tags=["files"])

KKFILEVIEW_SUFFIXES = {
    ".doc",
    ".docx",
    ".xls",
    ".xlsx",
    ".ppt",
    ".pptx",
    ".wps",
    ".et",
    ".dps",
    ".ofd",
    ".rtf",
    ".csv",
    ".zip",
    ".rar",
    ".7z",
    ".tar",
    ".gz",
    ".bz2",
    ".xz",
    ".dwg",
    ".dxf",
    ".epub",
}


def _content_disposition(filename: str, disposition: str = "attachment") -> str:
    encoded = quote(filename, safe="")
    return f"{disposition}; filename*=UTF-8''{encoded}"


def _inline_disposition(content_type: str) -> bool:
    ct = content_type.split(";", 1)[0].strip().lower()
    return is_image_type(ct) or "pdf" in ct or ct.startswith("text/") or "xhtml+xml" in ct


def _content_type_base(content_type: str) -> str:
    return content_type.split(";", 1)[0].strip().lower()


def _effective_content_type(rec: FileRecord, fallback: str = "application/octet-stream") -> str:
    content_type = (rec.content_type or "").strip()
    normalized_type = _content_type_base(content_type)
    if not normalized_type or normalized_type == "application/octet-stream":
        guessed = mimetypes.guess_type(rec.original_filename or "")[0]
        if guessed:
            return guessed
    return content_type or fallback


def _normalize_absolute_base_url(url: str, fallback: str = "https://agentnexus.example.com") -> str:
    base = (url or "").strip().rstrip("/")
    if not base:
        base = fallback
    if not base.startswith(("http://", "https://")):
        base = f"https://{base.lstrip('/')}"
    return base.rstrip("/")


def _is_kkfileview_candidate(filename: str, content_type: str) -> bool:
    suffix = Path(filename).suffix.lower()
    content_base = _content_type_base(content_type)
    return (
        suffix in KKFILEVIEW_SUFFIXES
        or "wordprocessingml" in content_base
        or "spreadsheetml" in content_base
        or "presentationml" in content_base
        or content_base in {
            "application/msword",
            "application/vnd.ms-excel",
            "application/vnd.ms-powerpoint",
            "application/ofd",
            "application/rtf",
            "text/csv",
        }
    )


def _build_kkfileview_source_url(file_id: str, filename: str, token: str) -> str:
    public_base = _normalize_absolute_base_url(settings.public_base_url)
    query = urlencode({"token": token, "fullfilename": filename})
    return f"{public_base}/api/v1/files/{quote(file_id, safe='')}/public-preview?{query}"


def _build_kkfileview_viewer_url(source_url: str) -> str:
    kk_base = _normalize_absolute_base_url(settings.kkfileview_base_url)
    encoded_source = base64.b64encode(source_url.encode("utf-8")).decode("ascii")
    return f"{kk_base}/onlinePreview?url={quote(encoded_source, safe='')}"


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
    from app.services.file_scope_service import FileScopeService

    await FileScopeService(session).require_user_access(rec, current_user)


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
        if rec.object_key:
            from app.services.storage.base import StorageObjectRef

            obj = await storage.get_object_ref(
                StorageObjectRef(
                    file_id=rec.file_id,
                    bucket=rec.storage_bucket or settings.storage_s3_bucket,
                    object_key=rec.object_key,
                    filename=rec.original_filename,
                )
            )
        else:
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


@router.delete("/{file_id}", response_model=APIResponse[dict])
async def delete_file(
    file_id: str,
    scope_type: str | None = Query(default=None),
    scope_id: str | None = Query(default=None),
    channel_id: str | None = Query(default=None),
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    from app.services.file_service import FileService

    result = await FileService(session).delete_or_unlink(
        file_id,
        current_user,
        scope_type=scope_type,
        scope_id=scope_id,
        channel_id=channel_id,
    )
    return APIResponse.ok(result)


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
    """List channel files."""
    await ChannelService(session).require_channel_member(channel_id, current_user)
    from app.services.file_scope_service import FileScopeService

    records = [
        record
        for record in await FileScopeService(session).list_for_channel(channel_id)
        if not (record.content_type or "").lower().startswith("image/")
    ]
    records.sort(key=lambda record: record.created_at)
    return APIResponse.ok([
        {
            "file_id": r.file_id,
            "channel_id": channel_id,
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


@router.get("/library", response_model=APIResponse[list])
async def list_file_library(
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    """Return files visible to the current user across their file library."""
    from app.services.file_scope_service import FileScopeService

    items = await FileScopeService(session).list_library_for_user(current_user)
    return APIResponse.ok([
        {
            "file_id": item.record.file_id,
            "channel_id": item.channel_id,
            "channel_label": item.channel_name,
            "scope_type": item.scope_type,
            "scope_id": item.scope_id,
            "original_filename": item.record.original_filename,
            "content_type": item.record.content_type,
            "size_bytes": item.record.size_bytes,
            "status": item.record.status,
            "summary_3lines": item.record.summary_3lines,
            "created_at": item.record.created_at.isoformat() if item.record.created_at else None,
            "expires_at": item.record.expires_at.isoformat() if item.record.expires_at else None,
        }
        for item in items
    ])


@router.get("/{file_id}/status", response_model=APIResponse[dict])
async def file_status(
    file_id: str,
    channel_id: str = Query(...),
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    channel = await ChannelService(session).require_channel_member_or_manager(channel_id, current_user)
    rec = await _load_active_file_or_404(session, file_id)
    from app.services.file_scope_service import FileScopeService

    if not await FileScopeService(session).file_linked_to_channel(file_id=file_id, channel=channel):
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

    content_type = _effective_content_type(rec)
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


@router.get("/{file_id}/kkfileview", response_model=APIResponse[dict])
async def file_kkfileview_url(
    file_id: str,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    """File kkfileview url."""
    rec = await _load_active_file_or_404(session, file_id)
    await _require_file_access(session, rec, current_user)

    filename = rec.original_filename or file_id
    content_type = _effective_content_type(rec)
    if not settings.kkfileview_enabled or not (settings.kkfileview_base_url or "").strip():
        return APIResponse.ok({
            "enabled": False,
            "reason": "kkfileview disabled",
        })
    if not _is_kkfileview_candidate(filename, content_type):
        return APIResponse.ok({
            "enabled": False,
            "reason": "file type uses builtin preview",
        })

    ttl = max(int(getattr(settings, "kkfileview_token_ttl_seconds", 600) or 600), 60)
    token = create_service_token(
        {"scope": "file_preview", "file_id": rec.file_id},
        expires_seconds=ttl,
    )
    source_url = _build_kkfileview_source_url(rec.file_id, filename, token)
    return APIResponse.ok({
        "enabled": True,
        "viewer_url": _build_kkfileview_viewer_url(source_url),
        "source_url": source_url,
        "expires_in": ttl,
    })


@router.get("/{file_id}/public-preview")
async def file_public_preview(
    file_id: str,
    token: str = Query(...),
    session: AsyncSession = Depends(get_session),
) -> Response:
    """File public preview."""
    try:
        payload = decode_service_token(token)
    except jwt.PyJWTError as exc:
        raise UnauthorizedError("invalid preview token") from exc
    if payload.get("scope") != "file_preview" or payload.get("file_id") != file_id:
        raise UnauthorizedError("invalid preview token")

    rec = await _load_active_file_or_404(session, file_id)
    filename = rec.original_filename or file_id
    body = await _load_file_body(rec)
    return Response(
        content=body,
        media_type=_effective_content_type(rec),
        headers={
            "Content-Disposition": _content_disposition(filename, "inline"),
            "Cache-Control": "private, max-age=60",
            "X-Content-Type-Options": "nosniff",
        },
    )


@router.get("/{file_id}/content", response_model=APIResponse[dict])
async def file_preview_content(
    file_id: str,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    """File preview content."""
    rec = await _load_active_file_or_404(session, file_id)
    await _require_file_access(session, rec, current_user)

    filename = rec.original_filename or file_id
    content_type = _effective_content_type(rec)
    if is_image_type(_content_type_base(content_type)):
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
            else "html"
            if filename.lower().endswith((".html", ".htm"))
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
        media_type=_effective_content_type(rec),
        headers={
            "Content-Disposition": _content_disposition(filename),
            "Cache-Control": "private, max-age=3600",
        },
    )
