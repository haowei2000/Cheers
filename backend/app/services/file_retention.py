"""文件保留期与过期清理。"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from pathlib import Path

from sqlalchemy import or_, select, true
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import resolve_data_dir, settings
from app.db.models import FileRecord

logger = logging.getLogger("app.services.file_retention")


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _as_utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def file_retention_days() -> int:
    try:
        return int(getattr(settings, "file_retention_days", 365) or 0)
    except (TypeError, ValueError):
        return 365


def file_expires_at(anchor: datetime | None = None) -> datetime | None:
    """返回文件过期时间；FILE_RETENTION_DAYS <= 0 时表示不过期。"""
    days = file_retention_days()
    if days <= 0:
        return None
    base = _as_utc(anchor or utcnow())
    return base + timedelta(days=days)


def is_file_expired(record: FileRecord, now: datetime | None = None) -> bool:
    if file_retention_days() <= 0:
        return False
    if record.expires_at is None:
        return False
    return _as_utc(record.expires_at) <= _as_utc(now or utcnow())


def active_file_filter(now: datetime | None = None):
    """SQLAlchemy 条件：仅返回未过期文件；NULL 兼容保留旧数据。"""
    if file_retention_days() <= 0:
        return true()
    cutoff = now or utcnow()
    return or_(FileRecord.expires_at.is_(None), FileRecord.expires_at > cutoff)


class FileRetentionService:
    """清理超过保留期的文件记录与物理文件。"""

    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def prune_expired_files(self, *, batch_size: int = 200) -> int:
        if file_retention_days() <= 0:
            return 0
        now = utcnow()
        result = await self.session.execute(
            select(FileRecord)
            .where(FileRecord.expires_at.is_not(None), FileRecord.expires_at <= now)
            .order_by(FileRecord.expires_at)
            .limit(max(1, batch_size))
        )
        records = list(result.scalars().all())
        deleted_count = 0
        for record in records:
            if await self._delete_physical_assets(record):
                await self.session.delete(record)
                deleted_count += 1
            else:
                record.last_error = "retention cleanup failed"
        await self.session.flush()
        return deleted_count

    async def _delete_physical_assets(self, record: FileRecord) -> bool:
        ok = True
        if record.object_key:
            ok = await self._delete_remote_object(record)

        for path in self._local_paths(record):
            try:
                if path.is_file() or path.is_symlink():
                    path.unlink(missing_ok=True)
            except OSError:
                logger.warning(
                    "file retention: failed to delete local file file_id=%s path=%s",
                    record.file_id,
                    path,
                    exc_info=True,
                )
                ok = False
        return ok

    async def _delete_remote_object(self, record: FileRecord) -> bool:
        from app.services.storage.bootstrap import get_storage_service, is_storage_enabled

        if not is_storage_enabled():
            return False
        try:
            storage = get_storage_service()
        except RuntimeError:
            return False
        delete_object = getattr(storage, "delete_object", None)
        if not callable(delete_object):
            return False
        scope = "generated" if (record.object_key or "").startswith("generated/") else "uploads"
        try:
            await delete_object(record.file_id, scope=scope)
        except Exception:
            logger.warning(
                "file retention: failed to delete object file_id=%s scope=%s",
                record.file_id,
                scope,
                exc_info=True,
            )
            return False
        return True

    def _local_paths(self, record: FileRecord) -> list[Path]:
        raw_paths = [record.original_path, record.md_path]
        paths: list[Path] = []
        seen: set[Path] = set()
        data_root = resolve_data_dir().resolve()
        for raw in raw_paths:
            if not raw:
                continue
            path = Path(raw)
            if not path.is_absolute():
                path = data_root / path
            try:
                resolved = path.resolve()
            except OSError:
                resolved = path
            if resolved in seen:
                continue
            seen.add(resolved)
            paths.append(resolved)
        return paths
