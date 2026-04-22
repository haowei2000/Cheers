"""FileService.confirm_upload 校验：必须 head_object 通过才能标记为 uploaded。

回归背景：修复前 confirm_upload 直接把 DB status 置为 uploaded，不校验对象存储。
前端 PUT 失败 / 网络抖动 / CORS 等情况下会产生"DB 有记录但 S3 无对象"的幽灵记录，
下载时返回 NoSuchKey 404。此测试固化修复。
"""
from __future__ import annotations

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import BadRequestError
from app.db.models import Channel, FileRecord, User, Workspace
from app.services.file_service import FileService
from app.services.storage.base import StorageObjectNotFoundError


class _FakeStorageNotFound:
    async def head_object(self, file_id: str, *, scope: str = "uploads"):
        raise StorageObjectNotFoundError(f"fake NoSuchKey for {file_id}")


class _FakeStorageOk:
    def __init__(self) -> None:
        self.head_calls: list[tuple[str, str]] = []

    async def head_object(self, file_id: str, *, scope: str = "uploads"):
        self.head_calls.append((file_id, scope))

        class _Head:
            content_length = 11
            content_type = "text/plain"

        return _Head()


async def _seed_fixture(
    db_session: AsyncSession,
    *,
    ws_id: str,
    ch_id: str,
    file_id: str,
    uploader_id: str,
    object_key: str | None = "uploads/12/34/dummy/source",
) -> tuple[FileRecord, User]:
    ws = Workspace(workspace_id=ws_id, name="WFix")
    ch = Channel(channel_id=ch_id, workspace_id=ws_id, name="chfix", type="public")
    user = User(
        user_id=uploader_id,
        username=f"u-{uploader_id[:8]}",
        password_hash="x",
        display_name="U",
        role="member",
    )
    rec = FileRecord(
        file_id=file_id,
        channel_id=ch_id,
        uploader_id=uploader_id,
        original_path="/dev/null",
        original_filename="f.txt",
        content_type="text/plain",
        size_bytes=11,
        object_key=object_key,
        status="pending",
    )
    db_session.add_all([ws, ch, user, rec])
    await db_session.commit()
    return rec, user


@pytest.mark.asyncio
async def test_confirm_upload_marks_uploaded_when_object_exists(
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    rec, user = await _seed_fixture(
        db_session,
        ws_id="f0000000-0000-0000-0000-0000000000c1",
        ch_id="e1000000-0000-0000-0000-0000000000c1",
        file_id="aaaaaaaa-0000-0000-0000-000000000001",
        uploader_id="a0000000-0000-0000-0000-0000000000c1",
    )

    fake = _FakeStorageOk()
    monkeypatch.setattr("app.services.storage.bootstrap.is_storage_enabled", lambda: True)
    monkeypatch.setattr("app.services.storage.bootstrap.get_storage_service", lambda: fake)

    svc = FileService(db_session)
    result = await svc.confirm_upload(rec.file_id, user)

    assert result.status == "uploaded"
    assert result.uploaded_at is not None
    assert result.last_error is None
    assert fake.head_calls == [(rec.file_id, "uploads")]


@pytest.mark.asyncio
async def test_confirm_upload_rejects_when_object_missing(
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    rec, user = await _seed_fixture(
        db_session,
        ws_id="f0000000-0000-0000-0000-0000000000c2",
        ch_id="e1000000-0000-0000-0000-0000000000c2",
        file_id="aaaaaaaa-0000-0000-0000-000000000002",
        uploader_id="a0000000-0000-0000-0000-0000000000c2",
    )

    monkeypatch.setattr("app.services.storage.bootstrap.is_storage_enabled", lambda: True)
    monkeypatch.setattr(
        "app.services.storage.bootstrap.get_storage_service", lambda: _FakeStorageNotFound()
    )

    svc = FileService(db_session)
    with pytest.raises(BadRequestError):
        await svc.confirm_upload(rec.file_id, user)

    await db_session.refresh(rec)
    assert rec.status == "failed"
    assert rec.last_error and "object not found" in rec.last_error
    assert rec.uploaded_at is None


@pytest.mark.asyncio
async def test_confirm_upload_skips_head_when_storage_disabled(
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """storage 未启用时走本地 path，不应调用 head_object（兼容现有本地模式）。"""
    rec, user = await _seed_fixture(
        db_session,
        ws_id="f0000000-0000-0000-0000-0000000000c3",
        ch_id="e1000000-0000-0000-0000-0000000000c3",
        file_id="aaaaaaaa-0000-0000-0000-000000000003",
        uploader_id="a0000000-0000-0000-0000-0000000000c3",
        object_key=None,
    )

    def _boom() -> None:
        raise AssertionError("get_storage_service should not be called when disabled")

    monkeypatch.setattr("app.services.storage.bootstrap.is_storage_enabled", lambda: False)
    monkeypatch.setattr("app.services.storage.bootstrap.get_storage_service", _boom)

    svc = FileService(db_session)
    result = await svc.confirm_upload(rec.file_id, user)
    assert result.status == "uploaded"


@pytest.mark.asyncio
async def test_confirm_upload_rejects_wrong_uploader(
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    rec, owner = await _seed_fixture(
        db_session,
        ws_id="f0000000-0000-0000-0000-0000000000c4",
        ch_id="e1000000-0000-0000-0000-0000000000c4",
        file_id="aaaaaaaa-0000-0000-0000-000000000004",
        uploader_id="a0000000-0000-0000-0000-0000000000c4",
    )
    intruder = User(
        user_id="a0000000-0000-0000-0000-0000000000c5",
        username="intruder",
        password_hash="x",
        display_name="X",
        role="member",
    )
    db_session.add(intruder)
    await db_session.commit()

    monkeypatch.setattr("app.services.storage.bootstrap.is_storage_enabled", lambda: True)
    monkeypatch.setattr(
        "app.services.storage.bootstrap.get_storage_service", lambda: _FakeStorageOk()
    )

    svc = FileService(db_session)
    with pytest.raises(BadRequestError):
        await svc.confirm_upload(rec.file_id, intruder)
