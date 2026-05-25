"""Document set grouping tests."""
from __future__ import annotations

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import Channel, FileRecord, FileScopeLink, Workspace
from app.services.document_set_service import document_title_similarity, normalize_document_title

TEST_USER_ID = "a0000000-0000-0000-0000-000000000099"


def test_document_title_similarity_removes_digits_before_comparing() -> None:
    assert normalize_document_title("需求文档2024版.pdf") == "需求文档版"
    assert document_title_similarity("需求文档2024版.pdf", "需求文档2025版.docx") == 1.0
    assert document_title_similarity("合同1.pdf", "合同附件.pdf") < 0.9


@pytest.mark.asyncio
async def test_document_sets_auto_group_and_respect_manual_move_out(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    ws = Workspace(workspace_id="doc-set-ws-001", name="Document Set WS")
    ch = Channel(
        channel_id="doc-set-ch-001",
        workspace_id=ws.workspace_id,
        name="document-sets",
        type="public",
    )
    first = FileRecord(
        file_id="doc-set-file-001",
        channel_id=ch.channel_id,
        workspace_id=ws.workspace_id,
        uploader_id=TEST_USER_ID,
        original_path="uploads/doc-set-file-001.pdf",
        original_filename="需求文档2024版.pdf",
        content_type="application/pdf",
        status="ready",
    )
    second = FileRecord(
        file_id="doc-set-file-002",
        channel_id=ch.channel_id,
        workspace_id=ws.workspace_id,
        uploader_id=TEST_USER_ID,
        original_path="uploads/doc-set-file-002.pdf",
        original_filename="需求文档2025版.pdf",
        content_type="application/pdf",
        status="ready",
    )
    other = FileRecord(
        file_id="doc-set-file-003",
        channel_id=ch.channel_id,
        workspace_id=ws.workspace_id,
        uploader_id=TEST_USER_ID,
        original_path="uploads/doc-set-file-003.xlsx",
        original_filename="预算表.xlsx",
        content_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        status="ready",
    )
    links = [
        FileScopeLink(
            file_id=record.file_id,
            scope_type="channel",
            scope_id=ch.channel_id,
            workspace_id=ws.workspace_id,
            created_by=TEST_USER_ID,
        )
        for record in (first, second, other)
    ]
    db_session.add_all([ws, ch, first, second, other, *links])
    await db_session.flush()

    resp = await client.get(f"/api/v1/files/by-channel/{ch.channel_id}/document-sets")
    assert resp.status_code == 200
    data = resp.json()["data"]
    assert data["similarity_threshold"] == 0.9
    assert len(data["sets"]) == 1
    document_set = data["sets"][0]
    assert {item["file_id"] for item in document_set["files"]} == {
        first.file_id,
        second.file_id,
    }
    assert {item["file_id"] for item in data["ungrouped_files"]} == {other.file_id}

    resp = await client.delete(
        f"/api/v1/files/by-channel/{ch.channel_id}/document-sets/{document_set['set_id']}/files/{second.file_id}"
    )
    assert resp.status_code == 200
    data = resp.json()["data"]
    assert {item["file_id"] for item in data["sets"][0]["files"]} == {first.file_id}
    assert second.file_id in {item["file_id"] for item in data["ungrouped_files"]}

    resp = await client.post(f"/api/v1/files/by-channel/{ch.channel_id}/document-sets/auto-classify")
    assert resp.status_code == 200
    data = resp.json()["data"]
    assert {item["file_id"] for item in data["sets"][0]["files"]} == {first.file_id}
    assert second.file_id in {item["file_id"] for item in data["ungrouped_files"]}

    resp = await client.post(
        f"/api/v1/files/by-channel/{ch.channel_id}/document-sets/{document_set['set_id']}/files/{second.file_id}"
    )
    assert resp.status_code == 200
    data = resp.json()["data"]
    assert {item["file_id"] for item in data["sets"][0]["files"]} == {
        first.file_id,
        second.file_id,
    }


@pytest.mark.asyncio
async def test_personal_library_document_sets_auto_group_and_respect_manual_move_out(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    ws = Workspace(
        workspace_id="doc-set-personal-ws-001",
        name="Document Set Personal WS",
        kind="personal",
    )
    ch = Channel(
        channel_id="doc-set-personal-ch-001",
        workspace_id=ws.workspace_id,
        name="personal-files",
        type="dm",
    )
    first = FileRecord(
        file_id="doc-set-personal-file-001",
        channel_id=ch.channel_id,
        workspace_id=ws.workspace_id,
        uploader_id=TEST_USER_ID,
        original_path="uploads/doc-set-personal-file-001.pdf",
        original_filename="合同2024版.pdf",
        content_type="application/pdf",
        status="ready",
    )
    second = FileRecord(
        file_id="doc-set-personal-file-002",
        channel_id=ch.channel_id,
        workspace_id=ws.workspace_id,
        uploader_id=TEST_USER_ID,
        original_path="uploads/doc-set-personal-file-002.pdf",
        original_filename="合同2025版.pdf",
        content_type="application/pdf",
        status="ready",
    )
    other = FileRecord(
        file_id="doc-set-personal-file-003",
        channel_id=ch.channel_id,
        workspace_id=ws.workspace_id,
        uploader_id=TEST_USER_ID,
        original_path="uploads/doc-set-personal-file-003.txt",
        original_filename="会议纪要.txt",
        content_type="text/plain",
        status="ready",
    )
    links = [
        FileScopeLink(
            file_id=record.file_id,
            scope_type="personal",
            scope_id=TEST_USER_ID,
            workspace_id=ws.workspace_id,
            created_by=TEST_USER_ID,
        )
        for record in (first, second, other)
    ]
    db_session.add_all([ws, ch, first, second, other, *links])
    await db_session.flush()

    resp = await client.get("/api/v1/files/library/document-sets")
    assert resp.status_code == 200
    data = resp.json()["data"]
    assert len(data["sets"]) == 1
    document_set = data["sets"][0]
    assert document_set["owner_id"] == TEST_USER_ID
    assert {item["file_id"] for item in document_set["files"]} == {
        first.file_id,
        second.file_id,
    }
    assert {item["file_id"] for item in data["ungrouped_files"]} == {other.file_id}

    resp = await client.delete(
        f"/api/v1/files/library/document-sets/{document_set['set_id']}/files/{second.file_id}"
    )
    assert resp.status_code == 200
    data = resp.json()["data"]
    assert {item["file_id"] for item in data["sets"][0]["files"]} == {first.file_id}
    assert second.file_id in {item["file_id"] for item in data["ungrouped_files"]}

    resp = await client.post("/api/v1/files/library/document-sets/auto-classify")
    assert resp.status_code == 200
    data = resp.json()["data"]
    assert {item["file_id"] for item in data["sets"][0]["files"]} == {first.file_id}
    assert second.file_id in {item["file_id"] for item in data["ungrouped_files"]}

    resp = await client.post(
        f"/api/v1/files/library/document-sets/{document_set['set_id']}/files/{second.file_id}"
    )
    assert resp.status_code == 200
    data = resp.json()["data"]
    assert {item["file_id"] for item in data["sets"][0]["files"]} == {
        first.file_id,
        second.file_id,
    }
