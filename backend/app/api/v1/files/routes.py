"""File v1 路由."""
from __future__ import annotations

from pathlib import Path
from urllib.parse import quote

from fastapi import APIRouter, Depends, Query
from fastapi.responses import Response
from pydantic import BaseModel, model_validator
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.dependencies import get_current_user, get_session
from app.core.exceptions import NotFoundError
from app.core.responses import APIResponse
from app.db.models import FileRecord, User

router = APIRouter(prefix="/files", tags=["files"])


def _content_disposition(filename: str) -> str:
    encoded = quote(filename, safe="")
    return f"attachment; filename*=UTF-8''{encoded}"


def _inline_disposition(content_type: str) -> bool:
    from app.services.file_processor.convert import is_image_type
    ct = content_type.lower()
    return is_image_type(ct) or "pdf" in ct or ct.startswith("text/")


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
    from app.services.file_service import FileService
    from app.core.schemas import MessageFileInResponse
    svc = FileService(session)
    rec = await svc.confirm_upload(file_id, current_user)
    return APIResponse.ok(MessageFileInResponse.model_validate(rec).model_dump())


@router.get("/{file_id}/url", response_model=APIResponse[dict])
async def get_download_url(
    file_id: str,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    from app.services.file_service import FileService
    svc = FileService(session)
    url = await svc.get_download_url(file_id)
    return APIResponse.ok({"url": url})


@router.get("/{file_id}/status", response_model=APIResponse[dict])
async def file_status(
    file_id: str,
    channel_id: str = Query(...),
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    result = await session.execute(
        select(FileRecord).where(FileRecord.file_id == file_id, FileRecord.channel_id == channel_id)
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
        "last_error": rec.last_error,
    })


@router.get("/{file_id}/preview")
async def file_preview(
    file_id: str,
    session: AsyncSession = Depends(get_session),
) -> Response:
    result = await session.execute(select(FileRecord).where(FileRecord.file_id == file_id))
    rec = result.scalar_one_or_none()
    if not rec:
        raise NotFoundError("file not found")

    content_type = rec.content_type or "application/octet-stream"
    filename = rec.original_filename or file_id
    disposition = "inline" if _inline_disposition(content_type) else _content_disposition(filename)

    if not rec.object_key and rec.original_path:
        local_path = Path(rec.original_path)
        if local_path.exists():
            return Response(
                content=local_path.read_bytes(),
                media_type=content_type,
                headers={"Content-Disposition": disposition, "Cache-Control": "public, max-age=3600"},
            )

    from app.services.storage.bootstrap import get_storage_service, is_storage_enabled
    from app.services.storage.base import StorageObjectNotFoundError
    if not is_storage_enabled():
        from app.core.exceptions import AppError
        raise AppError("storage not enabled")
    storage = get_storage_service()
    scope = "generated" if (rec.object_key or "").startswith("generated/") else "uploads"
    try:
        obj = await storage.get_object(rec.file_id, scope=scope)
    except StorageObjectNotFoundError:
        raise NotFoundError("file not found in storage")
    except Exception as exc:
        from app.core.exceptions import AppError
        raise AppError("failed to load file") from exc
    return Response(
        content=obj.body,
        media_type=content_type,
        headers={"Content-Disposition": disposition, "Cache-Control": "public, max-age=3600"},
    )


@router.get("/{file_id}/download")
async def file_download(
    file_id: str,
    session: AsyncSession = Depends(get_session),
) -> Response:
    result = await session.execute(select(FileRecord).where(FileRecord.file_id == file_id))
    rec = result.scalar_one_or_none()
    if not rec:
        raise NotFoundError("file not found")

    if not rec.object_key and rec.original_path:
        local_path = Path(rec.original_path)
        if local_path.exists():
            filename = rec.original_filename or file_id
            return Response(
                content=local_path.read_bytes(),
                media_type=rec.content_type or "application/octet-stream",
                headers={"Content-Disposition": _content_disposition(filename), "Cache-Control": "public, max-age=3600"},
            )

    from app.services.storage.bootstrap import get_storage_service, is_storage_enabled
    from app.services.storage.base import StorageObjectNotFoundError
    if not is_storage_enabled():
        from app.core.exceptions import AppError
        raise AppError("storage not enabled")
    storage = get_storage_service()
    scope = "generated" if (rec.object_key or "").startswith("generated/") else "uploads"
    try:
        obj = await storage.get_object(rec.file_id, scope=scope)
    except StorageObjectNotFoundError:
        raise NotFoundError("file not found in storage")
    except Exception as exc:
        from app.core.exceptions import AppError
        raise AppError("failed to load file") from exc
    filename = rec.original_filename or file_id
    return Response(
        content=obj.body,
        media_type=rec.content_type or "application/octet-stream",
        headers={"Content-Disposition": _content_disposition(filename), "Cache-Control": "public, max-age=3600"},
    )
