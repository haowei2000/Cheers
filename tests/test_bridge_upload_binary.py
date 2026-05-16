"""Tests for test bridge upload binary."""
from __future__ import annotations

import uuid

import pytest
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.db.models import (
    BotAccount,
    Channel,
    ChannelMembership,
    FileRecord,
    Workspace,
)
from app.features.agent_bridge.tokens import apply_token_to_bot


async def _seed_bot_in_channel(
    db_session: AsyncSession,
) -> tuple[str, str, str]:
    """Covers seed bot in channel behavior."""
    ws_id = f"ws-{uuid.uuid4().hex[:8]}"
    ch_id = f"ch-{uuid.uuid4().hex[:8]}"
    bot_id = f"bot-{uuid.uuid4().hex[:8]}"

    db_session.add(Workspace(workspace_id=ws_id, name="WUp"))
    db_session.add(Channel(channel_id=ch_id, workspace_id=ws_id, name="chup", type="public"))
    bot = BotAccount(
        bot_id=bot_id,
        username=f"u-{bot_id[-8:]}",
        display_name="BU",
        status="online",
        binding_type="agent_bridge",
        binding_config={},
        bot_token_hash=None,
        bot_token_prefix=None,
        bot_token_rotated_at=None,
    )
    plaintext = apply_token_to_bot(bot)
    db_session.add(bot)
    db_session.add(ChannelMembership(
        channel_id=ch_id, member_id=bot_id, member_type="bot",
    ))
    await db_session.commit()
    return bot_id, ch_id, plaintext


@pytest.mark.asyncio
async def test_upload_binary_happy_path(
    client: AsyncClient,
    db_session: AsyncSession,
    tmp_path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(settings, "data_dir", str(tmp_path))
    monkeypatch.setattr(settings, "agent_bridge_enabled", True)
    monkeypatch.setattr(settings, "agent_bridge_token", "dummy")

    bot_id, ch_id, token = await _seed_bot_in_channel(db_session)

    body = b"\x89PNG\r\n\x1a\npayload-bytes"
    resp = await client.post(
        "/api/v1/agent-bridge/files/upload-binary",
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "image/png",
            "X-Channel-Id": ch_id,
            "X-Filename": "chart.png",
        },
        content=body,
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()["data"]
    assert data["filename"] == "chart.png"
    assert data["content_type"] == "image/png"
    assert data["size_bytes"] == len(body)

    rec = (await db_session.execute(
        select(FileRecord).where(FileRecord.file_id == data["file_id"])
    )).scalar_one()
    assert rec.channel_id == ch_id
    assert rec.uploader_id == bot_id
    assert rec.original_filename == "chart.png"
    assert rec.content_type == "image/png"
    assert rec.size_bytes == len(body)
    assert rec.status == "ready"

    # The file lands in data_dir/generated/{channel_id}/{file_id}.png.
    on_disk = tmp_path / "generated" / ch_id / f"{data['file_id']}.png"
    assert on_disk.exists()
    assert on_disk.read_bytes() == body


@pytest.mark.asyncio
async def test_upload_binary_rejects_missing_token(
    client: AsyncClient, db_session: AsyncSession,
    tmp_path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(settings, "data_dir", str(tmp_path))
    _, ch_id, _ = await _seed_bot_in_channel(db_session)

    resp = await client.post(
        "/api/v1/agent-bridge/files/upload-binary",
        headers={
            "Content-Type": "text/plain",
            "X-Channel-Id": ch_id,
            "X-Filename": "a.txt",
        },
        content=b"hello",
    )
    assert resp.status_code == 401


@pytest.mark.asyncio
async def test_upload_binary_rejects_bot_not_in_channel(
    client: AsyncClient, db_session: AsyncSession,
    tmp_path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(settings, "data_dir", str(tmp_path))
    monkeypatch.setattr(settings, "agent_bridge_enabled", True)

    _, _, token = await _seed_bot_in_channel(db_session)
    # Another channel where the bot is not a member.
    other_ws = f"ws-{uuid.uuid4().hex[:8]}"
    other_ch = f"ch-{uuid.uuid4().hex[:8]}"
    db_session.add(Workspace(workspace_id=other_ws, name="OW"))
    db_session.add(Channel(channel_id=other_ch, workspace_id=other_ws, name="other", type="public"))
    await db_session.commit()

    resp = await client.post(
        "/api/v1/agent-bridge/files/upload-binary",
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "text/plain",
            "X-Channel-Id": other_ch,
            "X-Filename": "a.txt",
        },
        content=b"hello",
    )
    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_upload_binary_rejects_empty_body(
    client: AsyncClient, db_session: AsyncSession,
    tmp_path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(settings, "data_dir", str(tmp_path))
    monkeypatch.setattr(settings, "agent_bridge_enabled", True)

    _, ch_id, token = await _seed_bot_in_channel(db_session)

    resp = await client.post(
        "/api/v1/agent-bridge/files/upload-binary",
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "text/plain",
            "X-Channel-Id": ch_id,
            "X-Filename": "empty.txt",
        },
        content=b"",
    )
    assert resp.status_code == 400


@pytest.mark.asyncio
async def test_upload_binary_rejects_oversize(
    client: AsyncClient, db_session: AsyncSession,
    tmp_path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(settings, "data_dir", str(tmp_path))
    monkeypatch.setattr(settings, "agent_bridge_enabled", True)
    monkeypatch.setattr(settings, "file_upload_max_bytes", 100)

    _, ch_id, token = await _seed_bot_in_channel(db_session)

    resp = await client.post(
        "/api/v1/agent-bridge/files/upload-binary",
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/octet-stream",
            "X-Channel-Id": ch_id,
            "X-Filename": "big.bin",
        },
        content=b"0" * 500,
    )
    assert resp.status_code == 413

    # FileRecord should not be created after mid-write rollback/unlink.
    rows = (await db_session.execute(
        select(FileRecord).where(FileRecord.channel_id == ch_id)
    )).scalars().all()
    assert rows == []


@pytest.mark.asyncio
async def test_upload_binary_infers_content_type_from_filename(
    client: AsyncClient, db_session: AsyncSession,
    tmp_path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Covers test upload binary infers content type from filename behavior."""
    monkeypatch.setattr(settings, "data_dir", str(tmp_path))
    monkeypatch.setattr(settings, "agent_bridge_enabled", True)

    _, ch_id, token = await _seed_bot_in_channel(db_session)

    resp = await client.post(
        "/api/v1/agent-bridge/files/upload-binary",
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/octet-stream",
            "X-Channel-Id": ch_id,
            "X-Filename": "report.pdf",
        },
        content=b"%PDF-1.4 fake",
    )
    assert resp.status_code == 200
    data = resp.json()["data"]
    assert data["content_type"] == "application/pdf"
