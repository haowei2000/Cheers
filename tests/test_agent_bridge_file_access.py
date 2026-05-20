"""Agent Bridge file access regression tests."""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.db.models import BotAccount, Channel, ChannelMembership, FileRecord, Workspace
from app.features.agent_bridge.tokens import apply_token_to_bot
from app.features.agent_bridge.validators import check_files_in_channel
from app.services.file_scope_service import FileScopeService


async def _seed_file_in_source_channel(
    db_session: AsyncSession,
    tmp_path,
) -> tuple[BotAccount, str, Channel, Channel, FileRecord]:
    suffix = uuid.uuid4().hex[:8]
    ws = Workspace(workspace_id=f"ws-{suffix}", name="Bridge File Access")
    source = Channel(
        channel_id=f"ch-src-{suffix}",
        workspace_id=ws.workspace_id,
        name="source",
        type="public",
    )
    target = Channel(
        channel_id=f"ch-dst-{suffix}",
        workspace_id=ws.workspace_id,
        name="target",
        type="public",
    )
    bot = BotAccount(
        bot_id=f"bot-{suffix}",
        username=f"bridge_file_{suffix}",
        display_name="Bridge File Bot",
        status="online",
        binding_type="agent_bridge",
        binding_config={},
    )
    token = apply_token_to_bot(bot)
    path = tmp_path / f"{suffix}.txt"
    path.write_text("source channel content", encoding="utf-8")
    record = FileRecord(
        file_id=str(uuid.uuid4()),
        channel_id=source.channel_id,
        workspace_id=ws.workspace_id,
        uploader_id="source-user",
        original_path=str(path),
        md_path=str(path),
        original_filename="source.txt",
        content_type="text/plain",
        size_bytes=path.stat().st_size,
        status="ready",
        uploaded_at=datetime.now(timezone.utc),
    )
    db_session.add_all([ws, source, target, bot])
    await db_session.flush()
    db_session.add(
        ChannelMembership(
            channel_id=target.channel_id,
            member_id=bot.bot_id,
            member_type="bot",
        )
    )
    db_session.add(record)
    await db_session.flush()
    await FileScopeService(db_session).link_file_to_channel(
        record,
        source,
        created_by="source-user",
    )
    await db_session.commit()
    return bot, token, source, target, record


@pytest.mark.asyncio
async def test_check_files_in_channel_rejects_source_channel_file_in_target(
    db_session: AsyncSession,
    tmp_path,
) -> None:
    _, _, _, target, record = await _seed_file_in_source_channel(db_session, tmp_path)

    err = await check_files_in_channel(
        db_session,
        file_ids=[record.file_id],
        channel_id=target.channel_id,
    )

    assert err is not None
    assert err[0] == "file_not_in_channel"


@pytest.mark.asyncio
async def test_bridge_messages_reject_cross_channel_file_ids(
    client: AsyncClient,
    db_session: AsyncSession,
    tmp_path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(settings, "agent_bridge_enabled", True)
    monkeypatch.setattr(settings, "agent_bridge_token", "bridge-test-token")
    bot, _, _, target, record = await _seed_file_in_source_channel(db_session, tmp_path)

    resp = await client.post(
        "/api/v1/agent-bridge/messages",
        headers={"X-Agent-Bridge-Token": "bridge-test-token"},
        json={
            "bot_id": bot.bot_id,
            "channel_id": target.channel_id,
            "content": "cross-channel attach",
            "file_ids": [record.file_id],
        },
    )

    assert resp.status_code == 403
    assert "不属于频道" in resp.text


@pytest.mark.asyncio
async def test_bridge_read_file_content_allows_linked_target_channel(
    client: AsyncClient,
    db_session: AsyncSession,
    tmp_path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(settings, "agent_bridge_enabled", True)
    bot, token, _, target, record = await _seed_file_in_source_channel(db_session, tmp_path)
    await FileScopeService(db_session).link_file_to_channel(
        record,
        target,
        created_by=bot.bot_id,
    )
    await db_session.commit()

    resp = await client.get(
        f"/api/v1/agent-bridge/files/{record.file_id}/content",
        headers={"Authorization": f"Bearer {token}"},
    )

    assert resp.status_code == 200, resp.text
    data = resp.json()["data"]
    assert data["file_id"] == record.file_id
    assert "source channel content" in data["content"]
