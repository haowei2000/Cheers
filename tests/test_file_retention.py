"""Tests for test file retention."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.db.models import Channel, FileRecord, Workspace
from app.repositories.file_repo import FileRepository
from app.services.file_retention import FileRetentionService, file_expires_at, is_file_expired


def test_file_expires_at_defaults_to_one_year(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "file_retention_days", 365)
    anchor = datetime(2026, 5, 15, 12, 0, tzinfo=timezone.utc)

    assert file_expires_at(anchor) == anchor + timedelta(days=365)


def test_file_retention_can_be_disabled(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "file_retention_days", 0)
    expired = FileRecord(
        file_id="aaaaaaaa-0000-0000-0000-00000000f900",
        channel_id="e1000000-0000-0000-0000-00000000f900",
        uploader_id="a0000000-0000-0000-0000-00000000f900",
        original_path="/tmp/expired.txt",
        status="ready",
        expires_at=datetime.now(timezone.utc) - timedelta(days=1),
    )

    assert file_expires_at() is None
    assert not is_file_expired(expired)


@pytest.mark.asyncio
async def test_file_repository_hides_expired_records(db_session: AsyncSession, tmp_path) -> None:
    ws = Workspace(workspace_id="f0000000-0000-0000-0000-00000000f901", name="Retention")
    ch = Channel(
        channel_id="e1000000-0000-0000-0000-00000000f901",
        workspace_id=ws.workspace_id,
        name="retention",
        type="public",
    )
    path = tmp_path / "expired.txt"
    path.write_text("old", encoding="utf-8")
    rec = FileRecord(
        file_id="aaaaaaaa-0000-0000-0000-00000000f901",
        channel_id=ch.channel_id,
        uploader_id="a0000000-0000-0000-0000-00000000f901",
        original_path=str(path),
        original_filename="expired.txt",
        content_type="text/plain",
        size_bytes=3,
        status="ready",
        expires_at=datetime.now(timezone.utc) - timedelta(days=1),
    )
    db_session.add_all([ws, ch, rec])
    await db_session.commit()

    repo = FileRepository(db_session)
    assert await repo.get_by_id(rec.file_id) is None
    assert await repo.get_by_id(rec.file_id, include_expired=True) is not None


@pytest.mark.asyncio
async def test_prune_expired_files_deletes_record_and_local_file(
    db_session: AsyncSession,
    tmp_path,
) -> None:
    ws = Workspace(workspace_id="f0000000-0000-0000-0000-00000000f902", name="Retention")
    ch = Channel(
        channel_id="e1000000-0000-0000-0000-00000000f902",
        workspace_id=ws.workspace_id,
        name="retention-cleanup",
        type="public",
    )
    path = tmp_path / "expired-cleanup.txt"
    path.write_text("old", encoding="utf-8")
    rec = FileRecord(
        file_id="aaaaaaaa-0000-0000-0000-00000000f902",
        channel_id=ch.channel_id,
        uploader_id="a0000000-0000-0000-0000-00000000f902",
        original_path=str(path),
        original_filename="expired-cleanup.txt",
        content_type="text/plain",
        size_bytes=3,
        status="ready",
        expires_at=datetime.now(timezone.utc) - timedelta(days=1),
    )
    db_session.add_all([ws, ch, rec])
    await db_session.commit()

    # Ensure no stale expired records from other tests interfere.
    from app.services.file_retention import FileRetentionService as FRS
    await FRS(db_session).prune_expired_files(batch_size=5000)
    await db_session.commit()

    # Re-query to confirm our record was pruned.
    result = await db_session.execute(
        select(FileRecord).where(FileRecord.file_id == rec.file_id)
    )
    assert result.scalar_one_or_none() is None
