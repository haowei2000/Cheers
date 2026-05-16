"""Tests for test channel members api."""
import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import Channel, ChannelMembership, User, Workspace, WorkspaceMembership


@pytest.mark.asyncio
async def test_list_members_empty(client: AsyncClient, db_session: AsyncSession) -> None:
    """Covers test list members empty behavior."""
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
    """Covers test add member and list behavior."""
    ws = Workspace(workspace_id="c0000000-0000-0000-0000-000000000002", name="W2")
    ch = Channel(
        channel_id="d0000000-0000-0000-0000-000000000002",
        workspace_id=ws.workspace_id,
        name="ch2",
        type="public",
    )
    target = User(
        user_id="e0000000-0000-0000-0000-000000000001",
        username="channel_member_target",
        password_hash="x",
    )
    db_session.add_all([
        ws,
        ch,
        target,
        WorkspaceMembership(workspace_id=ws.workspace_id, user_id=target.user_id),
    ])
    await db_session.commit()

    resp = await client.post(
        "/api/v1/channels/d0000000-0000-0000-0000-000000000002/members",
        json={"member_id": target.user_id, "member_type": "user"},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "success"

    resp2 = await client.get("/api/v1/channels/d0000000-0000-0000-0000-000000000002/members")
    assert resp2.status_code == 200
    members = resp2.json()["data"]
    assert len(members) == 1
    assert members[0]["member_id"] == target.user_id
    assert members[0]["member_type"] == "user"


@pytest.mark.asyncio
async def test_add_user_member_requires_workspace_membership(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """POST /api/channels/{id}/members rejects users outside the workspace."""
    ws = Workspace(workspace_id="c0000000-0000-0000-0000-000000000022", name="W22")
    ch = Channel(
        channel_id="d0000000-0000-0000-0000-000000000022",
        workspace_id=ws.workspace_id,
        name="ch22",
        type="private",
    )
    outsider = User(
        user_id="e0000000-0000-0000-0000-000000000022",
        username="channel_member_outsider",
        password_hash="x",
    )
    db_session.add_all([ws, ch, outsider])
    await db_session.commit()

    resp = await client.post(
        f"/api/v1/channels/{ch.channel_id}/members",
        json={"member_id": outsider.user_id, "member_type": "user"},
    )

    assert resp.status_code == 400
    assert "工作空间" in resp.json()["detail"]


@pytest.mark.asyncio
async def test_remove_member(client: AsyncClient, db_session: AsyncSession) -> None:
    """Covers test remove member behavior."""
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
