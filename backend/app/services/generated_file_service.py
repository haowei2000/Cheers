"""Persistence helpers for files produced by bots and bridge connectors."""
from __future__ import annotations

import asyncio
import logging
import mimetypes
import re
import uuid
from datetime import datetime, timezone
from pathlib import Path

from sqlalchemy.ext.asyncio import AsyncSession

from app.config import resolve_data_dir
from app.db.models import Channel, FileRecord
from app.services.file_scope_service import FileScopeService
from app.services.storage import bootstrap as storage_bootstrap

logger = logging.getLogger("app.services.generated_file_service")


class GeneratedFileError(Exception):
    def __init__(self, detail: str, *, status_code: int = 500) -> None:
        super().__init__(detail)
        self.detail = detail
        self.status_code = status_code


def sanitize_generated_filename(raw: str, *, fallback: str = "media") -> str:
    name = Path((raw or "").strip()).name
    safe = re.sub(r"[^\w\-. ]", "_", name)
    if safe in {".", ".."}:
        return fallback
    return safe or fallback


def generated_file_access_payload(record: FileRecord) -> dict:
    return {
        "file_id": record.file_id,
        "filename": record.original_filename or record.file_id,
        "content_type": record.content_type or "application/octet-stream",
        "size_bytes": record.size_bytes or 0,
        "preview_url": f"/api/v1/files/{record.file_id}/preview",
        "download_url": f"/api/v1/files/{record.file_id}/download",
    }


def _content_type_for(filename: str, content_type: str | None) -> str:
    normalized = (content_type or "").split(";", 1)[0].strip()
    if normalized and normalized != "application/octet-stream":
        return normalized
    return mimetypes.guess_type(filename)[0] or normalized or "application/octet-stream"


def _safe_storage_segment(raw: str, *, label: str) -> str:
    segment = re.sub(r"[^A-Za-z0-9_.-]", "_", (raw or "").strip())
    if not segment or segment in {".", ".."}:
        raise GeneratedFileError(f"invalid {label} path", status_code=400)
    return segment


def _generated_local_path(channel_id: str, file_id: str, filename: str) -> Path:
    suffix = Path(filename).suffix.lower()
    gen_root = resolve_data_dir() / "generated"
    gen_dir = gen_root / _safe_storage_segment(channel_id, label="channel_id")
    if not gen_dir.resolve().is_relative_to(gen_root.resolve()):
        raise GeneratedFileError("invalid channel_id path", status_code=400)
    gen_dir.mkdir(parents=True, exist_ok=True)
    dst = gen_dir / f"{file_id}{suffix}"
    if not dst.resolve().is_relative_to(gen_dir.resolve()):
        raise GeneratedFileError("invalid channel_id path", status_code=400)
    return dst


async def _write_markdown_cache(
    *,
    channel_id: str,
    file_id: str,
    text: str,
) -> str | None:
    try:
        cache_root = resolve_data_dir() / "converted"
        cache_dir = cache_root / _safe_storage_segment(channel_id, label="channel_id")
        if not cache_dir.resolve().is_relative_to(cache_root.resolve()):
            return None
        cache_path = cache_dir / f"{file_id}.md"
        if not cache_path.resolve().is_relative_to(cache_dir.resolve()):
            return None
        await asyncio.to_thread(cache_dir.mkdir, parents=True, exist_ok=True)
        await asyncio.to_thread(cache_path.write_text, text, encoding="utf-8")
        return str(cache_path)
    except Exception:
        logger.warning("generated_file: markdown cache write failed file_id=%s", file_id, exc_info=True)
        return None


async def store_generated_file(
    session: AsyncSession,
    *,
    channel_id: str,
    uploader_id: str,
    filename: str,
    data: bytes,
    content_type: str | None = None,
    markdown_cache_text: str | None = None,
) -> FileRecord:
    """Persist a bot-generated file and link it to the target channel.

    When object storage is enabled, the source of truth is the S3-compatible
    object under the stable ``generated/`` scope. The local markdown cache is
    only a preview acceleration layer and can be rebuilt from storage.
    """
    if not data:
        raise GeneratedFileError("file is empty", status_code=400)

    safe_name = sanitize_generated_filename(filename)
    effective_type = _content_type_for(safe_name, content_type)
    file_id = str(uuid.uuid4())
    now = datetime.now(timezone.utc)
    channel = await session.get(Channel, channel_id)
    original_path = ""
    object_key: str | None = None
    storage_bucket: str | None = None

    if storage_bootstrap.is_storage_enabled():
        try:
            storage = storage_bootstrap.get_storage_service()
            ref = await storage.put_object(
                file_id,
                data,
                effective_type,
                scope="generated",
            )
            metadata = {
                "channel_id": channel_id,
                "workspace_id": channel.workspace_id if channel else "",
                "uploader_id": uploader_id,
                "filename": safe_name,
                "content_type": effective_type,
                "size_bytes": str(len(data)),
                "source": "agent_bridge_generated",
            }
            await storage.put_metadata_if_needed(file_id, metadata, scope="generated")
        except RuntimeError as exc:
            raise GeneratedFileError("object storage is enabled but not initialized", status_code=503) from exc
        except Exception as exc:
            raise GeneratedFileError("failed to persist generated file to object storage") from exc
        original_path = ref.object_key
        object_key = ref.object_key
        storage_bucket = ref.bucket
    else:
        dst = _generated_local_path(channel_id, file_id, safe_name)
        try:
            await asyncio.to_thread(dst.write_bytes, data)
        except OSError as exc:
            raise GeneratedFileError("write failed") from exc
        original_path = str(dst)

    md_path = None
    if markdown_cache_text is not None:
        md_path = await _write_markdown_cache(
            channel_id=channel_id,
            file_id=file_id,
            text=markdown_cache_text,
        )

    record = FileRecord(
        file_id=file_id,
        channel_id=channel_id,
        workspace_id=channel.workspace_id if channel else None,
        uploader_id=uploader_id,
        original_path=original_path,
        object_key=object_key,
        storage_bucket=storage_bucket,
        original_filename=safe_name,
        content_type=effective_type,
        size_bytes=len(data),
        md_path=md_path,
        status="ready",
        uploaded_at=now,
        converted_at=now if markdown_cache_text is not None else None,
        expires_at=None,
    )
    session.add(record)
    await session.flush()
    if channel:
        await FileScopeService(session).link_file_to_channel(record, channel, created_by=uploader_id)
    return record
