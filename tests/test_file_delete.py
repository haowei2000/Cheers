"""File deletion and scope unlink tests."""
from __future__ import annotations

import pytest
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import Channel, FileRecord, FileScopeLink, Message, Workspace

TEST_USER_ID = "a0000000-0000-0000-0000-000000000099"


@pytest.mark.asyncio
async def test_delete_personal_file_removes_record_when_unreferenced(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    rec = FileRecord(
        file_id="delete-file-personal-001",
        uploader_id=TEST_USER_ID,
        original_path="uploads/delete-file-personal-001.txt",
        original_filename="personal.txt",
        content_type="text/plain",
        status="ready",
    )
    link = FileScopeLink(
        file_id=rec.file_id,
        scope_type="personal",
        scope_id=TEST_USER_ID,
        created_by=TEST_USER_ID,
    )
    db_session.add_all([rec, link])
    await db_session.flush()

    resp = await client.delete(f"/api/v1/files/{rec.file_id}")

    assert resp.status_code == 200
    assert resp.json()["data"] == {"deleted": True, "unlinked": True}
    assert await db_session.get(FileRecord, rec.file_id) is None
    remaining_link = await db_session.scalar(
        select(FileScopeLink).where(FileScopeLink.file_id == rec.file_id)
    )
    assert remaining_link is None


@pytest.mark.asyncio
async def test_delete_channel_file_conflicts_when_message_still_references_it(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    ws = Workspace(workspace_id="delete-file-ws-001", name="Delete File WS")
    ch = Channel(
        channel_id="delete-file-ch-001",
        workspace_id=ws.workspace_id,
        name="delete-files",
        type="public",
    )
    rec = FileRecord(
        file_id="delete-file-channel-001",
        channel_id=ch.channel_id,
        workspace_id=ws.workspace_id,
        uploader_id=TEST_USER_ID,
        original_path="uploads/delete-file-channel-001.txt",
        original_filename="channel.txt",
        content_type="text/plain",
        status="ready",
    )
    link = FileScopeLink(
        file_id=rec.file_id,
        scope_type="channel",
        scope_id=ch.channel_id,
        workspace_id=ws.workspace_id,
        created_by=TEST_USER_ID,
    )
    msg = Message(
        msg_id="delete-file-message-001",
        channel_id=ch.channel_id,
        sender_id=TEST_USER_ID,
        sender_type="user",
        content="has attachment",
        file_ids=[rec.file_id],
    )
    db_session.add_all([ws, ch, rec, link, msg])
    await db_session.flush()

    resp = await client.delete(
        f"/api/v1/files/{rec.file_id}",
        params={"channel_id": ch.channel_id},
    )

    assert resp.status_code == 409
    assert await db_session.get(FileRecord, rec.file_id) is not None
    assert await db_session.scalar(
        select(FileScopeLink).where(FileScopeLink.file_id == rec.file_id)
    ) is not None
