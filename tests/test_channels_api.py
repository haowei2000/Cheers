"""ChatCore 频道 API 测试（TDD）."""
import pytest
from httpx import AsyncClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import Channel, ChannelMembership, User, Workspace
from app.db.seed import _ensure_builtin_bot_memberships
from app.services.channel_service import ChannelService
from app.services.guide.constants import GUIDE_BOT_ID, GUIDE_HELPER_BOT_ID


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
async def test_create_dm_channel_does_not_auto_add_builtin_bots(db_session: AsyncSession) -> None:
    """DM 私聊不自动添加 Coordinator / Helper。"""
    ws = Workspace(workspace_id="a0000000-0000-0000-0000-000000000010", name="DM Workspace")
    creator = User(
        user_id="a0000000-0000-0000-0000-000000000010",
        username="dm_admin",
        password_hash="x",
        role="system_admin",
    )
    db_session.add_all([ws, creator])
    await db_session.flush()

    svc = ChannelService(db_session)
    ch = await svc.create(
        workspace_id=ws.workspace_id,
        name="dm:user-a:user-b",
        type="dm",
        creator=creator,
    )

    rows = (await db_session.execute(
        text("select member_id from channel_memberships where channel_id = :channel_id"),
        {"channel_id": ch.channel_id},
    )).all()
    member_ids = {row[0] for row in rows}
    assert GUIDE_BOT_ID not in member_ids
    assert GUIDE_HELPER_BOT_ID not in member_ids


@pytest.mark.asyncio
async def test_builtin_membership_sync_skips_dm_channels(db_session: AsyncSession) -> None:
    """启动补齐只处理普通频道，并清理误注入 DM 的内置 Bot。"""
    ws = Workspace(workspace_id="a0000000-0000-0000-0000-000000000011", name="Sync Workspace")
    public = Channel(
        channel_id="b0000000-0000-0000-0000-000000000011",
        workspace_id=ws.workspace_id,
        name="general",
        type="public",
    )
    user_dm = Channel(
        channel_id="b0000000-0000-0000-0000-000000000012",
        workspace_id=ws.workspace_id,
        name="dm:user-a:user-b",
        type="dm",
    )
    helper_dm = Channel(
        channel_id="b0000000-0000-0000-0000-000000000013",
        workspace_id=ws.workspace_id,
        name=f"dm:{':'.join(sorted(['user-a', GUIDE_HELPER_BOT_ID]))}",
        type="dm",
    )
    db_session.add_all([ws, public, user_dm, helper_dm])
    for channel_id, member_id in (
        (user_dm.channel_id, GUIDE_BOT_ID),
        (user_dm.channel_id, GUIDE_HELPER_BOT_ID),
        (helper_dm.channel_id, GUIDE_BOT_ID),
        (helper_dm.channel_id, GUIDE_HELPER_BOT_ID),
    ):
        db_session.add(
            ChannelMembership(
                channel_id=channel_id,
                member_id=member_id,
                member_type="bot",
            )
        )

    await _ensure_builtin_bot_memberships(db_session)
    await db_session.flush()

    rows = (await db_session.execute(
        text("select channel_id, member_id from channel_memberships")
    )).all()
    members_by_channel: dict[str, set[str]] = {}
    for channel_id, member_id in rows:
        members_by_channel.setdefault(channel_id, set()).add(member_id)

    assert {GUIDE_BOT_ID, GUIDE_HELPER_BOT_ID}.issubset(
        members_by_channel[public.channel_id]
    )
    assert GUIDE_BOT_ID not in members_by_channel.get(user_dm.channel_id, set())
    assert GUIDE_HELPER_BOT_ID not in members_by_channel.get(user_dm.channel_id, set())
    assert GUIDE_BOT_ID not in members_by_channel.get(helper_dm.channel_id, set())
    assert GUIDE_HELPER_BOT_ID in members_by_channel[helper_dm.channel_id]


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
