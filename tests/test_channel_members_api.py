"""ChatCore 频道成员 API 测试（TDD）."""
import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import Channel, ChannelMembership, Workspace


@pytest.mark.asyncio
async def test_list_members_empty(client: AsyncClient, db_session: AsyncSession) -> None:
    """GET /api/channels/{id}/members 无成员时返回空列表."""
    ws = Workspace(workspace_id="c0000000-0000-0000-0000-000000000001", name="W")
    ch = Channel(
        channel_id="d0000000-0000-0000-0000-000000000001",
        workspace_id=ws.workspace_id,
        name="test-ch",
        type="public",
    )
    db_session.add(ws)
    db_session.add(ch)
    await db_session.commit()

    resp = await client.get("/api/v1/channels/d0000000-0000-0000-0000-000000000001/members")
    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "success"
    assert data["data"] == []


@pytest.mark.asyncio
async def test_add_member_and_list(client: AsyncClient, db_session: AsyncSession) -> None:
    """POST /api/channels/{id}/members 添加成员，GET 返回该成员."""
    ws = Workspace(workspace_id="c0000000-0000-0000-0000-000000000002", name="W2")
    ch = Channel(
        channel_id="d0000000-0000-0000-0000-000000000002",
        workspace_id=ws.workspace_id,
        name="ch2",
        type="public",
    )
    db_session.add(ws)
    db_session.add(ch)
    await db_session.commit()

    resp = await client.post(
        "/api/v1/channels/d0000000-0000-0000-0000-000000000002/members",
        json={"member_id": "e0000000-0000-0000-0000-000000000001", "member_type": "user"},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "success"

    resp2 = await client.get("/api/v1/channels/d0000000-0000-0000-0000-000000000002/members")
    assert resp2.status_code == 200
    members = resp2.json()["data"]
    assert len(members) == 1
    assert members[0]["member_id"] == "e0000000-0000-0000-0000-000000000001"
    assert members[0]["member_type"] == "user"


@pytest.mark.asyncio
async def test_remove_member(client: AsyncClient, db_session: AsyncSession) -> None:
    """DELETE /api/channels/{id}/members 移除成员."""
    ws = Workspace(workspace_id="c0000000-0000-0000-0000-000000000003", name="W3")
    ch = Channel(
        channel_id="d0000000-0000-0000-0000-000000000003",
        workspace_id=ws.workspace_id,
        name="ch3",
        type="public",
    )
    db_session.add(ws)
    db_session.add(ch)
    db_session.add(
        ChannelMembership(
            channel_id=ch.channel_id,
            member_id="e0000000-0000-0000-0000-000000000002",
            member_type="bot",
        )
    )
    await db_session.commit()

    resp = await client.delete(
        "/api/v1/channels/d0000000-0000-0000-0000-000000000003/members/e0000000-0000-0000-0000-000000000002"
    )
    assert resp.status_code == 200
    resp2 = await client.get("/api/v1/channels/d0000000-0000-0000-0000-000000000003/members")
    assert len(resp2.json()["data"]) == 0
