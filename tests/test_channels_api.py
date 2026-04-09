"""ChatCore 频道 API 测试（TDD）."""
import pytest
from httpx import AsyncClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import Channel, ChannelMembership, Workspace


@pytest.mark.asyncio
async def test_list_channels_empty(client: AsyncClient, db_session: AsyncSession) -> None:
    """GET /api/channels 无频道时返回空列表."""
    resp = await client.get("/api/v1/channels")
    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "success"
    assert data["data"] == []


@pytest.mark.asyncio
async def test_create_channel(client: AsyncClient, db_session: AsyncSession) -> None:
    """POST /api/channels 创建频道，需 workspace_id、name."""
    # 先创建 workspace
    ws = Workspace(workspace_id="a0000000-0000-0000-0000-000000000001", name="Default")
    db_session.add(ws)
    await db_session.commit()

    resp = await client.post(
        "/api/v1/channels",
        json={"workspace_id": "a0000000-0000-0000-0000-000000000001", "name": "general", "type": "public"},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "success"
    ch = data["data"]
    assert "channel_id" in ch
    assert ch["name"] == "general"
    assert ch["type"] == "public"
    assert ch["workspace_id"] == "a0000000-0000-0000-0000-000000000001"


@pytest.mark.asyncio
async def test_list_channels_returns_created(client: AsyncClient, db_session: AsyncSession) -> None:
    """GET /api/channels 返回已创建频道."""
    ws = Workspace(workspace_id="a0000000-0000-0000-0000-000000000002", name="W2")
    db_session.add(ws)
    ch = Channel(
        channel_id="b0000000-0000-0000-0000-000000000001",
        workspace_id=ws.workspace_id,
        name="random",
        type="public",
    )
    db_session.add(ch)
    # Add test user as channel member so list_for_user returns the channel
    membership = ChannelMembership(
        channel_id="b0000000-0000-0000-0000-000000000001",
        member_id="a0000000-0000-0000-0000-000000000099",
        member_type="user",
    )
    db_session.add(membership)
    await db_session.commit()

    resp = await client.get("/api/v1/channels")
    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "success"
    items = data["data"]
    assert len(items) >= 1
    names = [c["name"] for c in items]
    assert "random" in names
