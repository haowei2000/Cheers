"""文件上传与状态查询 API。"""
from __future__ import annotations

import logging
import uuid
from pathlib import Path
from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import Response
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.db.models import Channel, FileRecord
from app.db.session import get_session
from app.file_processor.convert import to_markdown
from app.file_processor.convert import is_image_type
from app.file_processor.service import FileFlowError, FilePipelineService
from app.storage.base import StorageError, StorageObjectNotFoundError
from app.storage.bootstrap import get_storage_service, is_storage_enabled

logger = logging.getLogger("app.file_processor.routes")


def _content_disposition(filename: str) -> str:
    """生成兼容非 ASCII 文件名的 Content-Disposition header 值（RFC 5987）。"""
    encoded = quote(filename, safe="")
    return f"attachment; filename*=UTF-8''{encoded}"

router = APIRouter(prefix="/api/files", tags=["files"])


class FilePresignRequest(BaseModel):
    """生成前端直传 RustFS 的 presigned URL。"""

    channel_id: str = Field(..., min_length=1)
    uploader_id: str = Field(..., min_length=1)
    filename: str = Field(..., min_length=1, max_length=255)
    content_type: str = Field(..., min_length=1, max_length=255)
    size: int = Field(..., gt=0)


def _data_dir() -> Path:
    base = Path(settings.data_dir)
    if not base.is_absolute():
        base = Path(__file__).resolve().parent.parent.parent / base
    return base


@router.post("/upload")
async def upload_file_legacy(
    request: Request,
    channel_id: str = Query(...),
    uploader_id: str = Query(...),
    filename: str = Query(..., description="原始文件名，如 doc.pdf"),
    session: AsyncSession = Depends(get_session),
) -> dict:
    """旧版后端转传上传接口已停用，强制走 presign + 直传。"""

    result = await session.execute(select(Channel).where(Channel.channel_id == channel_id))
    if not result.scalar_one_or_none():
        raise HTTPException(status_code=404, detail="channel not found")
    ext = Path(filename).suffix.lower()
    allowed = (".txt", ".md", ".docx", ".pdf", ".xlsx", ".png", ".jpg", ".jpeg", ".webp")
    if ext not in allowed:
        raise HTTPException(status_code=400, detail=f"supported formats: {', '.join(allowed)}")
    file_id = str(uuid.uuid4())
    data_dir = _data_dir()
    upload_dir = data_dir / "uploads" / channel_id
    upload_dir.mkdir(parents=True, exist_ok=True)
    raw_path = upload_dir / f"{file_id}{ext}"
    raw_path.write_bytes(await request.body())
    conv_dir = data_dir / "converted" / channel_id
    conv_dir.mkdir(parents=True, exist_ok=True)
    md_path = conv_dir / f"{file_id}.md"
    status = "converting"
    last_error: str | None = None
    try:
        content = to_markdown(raw_path)
        md_path.write_text(content, encoding="utf-8")
        status = "ready"
    except Exception as exc:
        status = "failed"
        last_error = str(exc)
    record = FileRecord(
        file_id=file_id,
        channel_id=channel_id,
        uploader_id=uploader_id,
        original_path=str(raw_path),
        original_filename=filename,
        md_path=str(md_path) if status == "ready" else None,
        status=status,
        last_error=last_error,
    )
    session.add(record)
    await session.flush()
    return {"status": "success", "data": {"file_id": file_id, "status": record.status}}


@router.post("/presign")
async def create_presigned_upload(
    body: FilePresignRequest,
    session: AsyncSession = Depends(get_session),
) -> dict:
    """生成 file_id 与 RustFS presigned PUT URL。"""

    result = await session.execute(select(Channel).where(Channel.channel_id == body.channel_id))
    if result.scalar_one_or_none() is None:
        raise HTTPException(status_code=404, detail="channel not found")

    try:
        service = FilePipelineService()
        record, upload, metadata = service.create_presigned_upload(
            channel_id=body.channel_id,
            uploader_id=body.uploader_id,
            filename=body.filename,
            content_type=body.content_type,
            size_bytes=body.size,
        )
    except FileFlowError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc
    except StorageError as exc:
        logger.exception("failed to create presigned upload")
        raise HTTPException(status_code=503, detail=f"storage unavailable: {exc}") from exc

    session.add(record)
    await session.flush()
    try:
        await service.write_upload_metadata(upload.file_id, metadata)
    except StorageError:
        logger.warning("failed to write file metadata sidecar file_id=%s", upload.file_id, exc_info=True)

    return {
        "status": "success",
        "data": {
            "file_id": upload.file_id,
            "object_key": upload.object_key,
            "upload_url": upload.upload_url,
            "headers": upload.headers,
            "expires_in": upload.expires_in,
        },
    }


@router.get("/{file_id}/status")
async def file_status(
    file_id: str,
    channel_id: str = Query(..., description="用于限制只能查询当前频道下的文件"),
    session: AsyncSession = Depends(get_session),
) -> dict:
    """查询文件状态，不暴露内部文件系统路径。"""

    result = await session.execute(
        select(FileRecord).where(
            FileRecord.file_id == file_id,
            FileRecord.channel_id == channel_id,
        )
    )
    rec = result.scalar_one_or_none()
    if not rec:
        raise HTTPException(status_code=404, detail="file not found")
    return {
        "status": "success",
        "data": {
            "file_id": rec.file_id,
            "channel_id": rec.channel_id,
            "original_filename": rec.original_filename,
            "content_type": rec.content_type,
            "size_bytes": rec.size_bytes,
            "status": rec.status,
            "uploaded_at": rec.uploaded_at.isoformat() if rec.uploaded_at else None,
            "last_error": rec.last_error,
        },
    }


@router.get("/{file_id}/preview")
async def file_preview(
    file_id: str,
    session: AsyncSession = Depends(get_session),
) -> Response:
    """返回图片文件的原始字节（用于 <img src> 预览）。"""
    result = await session.execute(
        select(FileRecord).where(FileRecord.file_id == file_id)
    )
    rec = result.scalar_one_or_none()
    if not rec:
        raise HTTPException(status_code=404, detail="file not found")
    if not is_image_type(rec.content_type or ""):
        raise HTTPException(status_code=400, detail="not an image file")

    if not is_storage_enabled():
        raise HTTPException(status_code=503, detail="storage not enabled")
    storage = get_storage_service()
    scope = "generated" if (rec.object_key or "").startswith("generated/") else "uploads"
    try:
        obj = await storage.get_object(rec.file_id, scope=scope)
    except StorageObjectNotFoundError:
        raise HTTPException(status_code=404, detail="image not found in storage")
    except Exception as exc:
        logger.exception("failed to load image file_id=%s", file_id)
        raise HTTPException(status_code=500, detail="failed to load image") from exc

    return Response(
        content=obj.body,
        media_type=rec.content_type or "image/png",
        headers={"Cache-Control": "public, max-age=3600"},
    )


@router.get("/{file_id}/download")
async def file_download(
    file_id: str,
    session: AsyncSession = Depends(get_session),
) -> Response:
    """下载文件（任意类型）。优先从本地路径读取，其次走对象存储。"""
    result = await session.execute(
        select(FileRecord).where(FileRecord.file_id == file_id)
    )
    rec = result.scalar_one_or_none()
    if not rec:
        raise HTTPException(status_code=404, detail="file not found")

    # 本地文件优先（generate_file 工具生成的文件无 object_key）
    if not rec.object_key and rec.original_path:
        local_path = Path(rec.original_path)
        if local_path.exists():
            filename = rec.original_filename or f"{file_id}"
            return Response(
                content=local_path.read_bytes(),
                media_type=rec.content_type or "application/octet-stream",
                headers={
                    "Content-Disposition": _content_disposition(filename),
                    "Cache-Control": "public, max-age=3600",
                },
            )

    if not is_storage_enabled():
        raise HTTPException(status_code=503, detail="storage not enabled")
    storage = get_storage_service()
    scope = "generated" if (rec.object_key or "").startswith("generated/") else "uploads"
    try:
        obj = await storage.get_object(rec.file_id, scope=scope)
    except StorageObjectNotFoundError:
        raise HTTPException(status_code=404, detail="file not found in storage")
    except Exception as exc:
        logger.exception("failed to load file file_id=%s", file_id)
        raise HTTPException(status_code=500, detail="failed to load file") from exc

    filename = rec.original_filename or f"{file_id}"
    return Response(
        content=obj.body,
        media_type=rec.content_type or "application/octet-stream",
        headers={
            "Content-Disposition": _content_disposition(filename),
            "Cache-Control": "public, max-age=3600",
        },
    )
