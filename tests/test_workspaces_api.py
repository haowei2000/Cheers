"""Tests for test workspaces api."""
import pytest
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import BotAccount, Channel, ChannelMembership, Message, User, Workspace, WorkspaceMembership
from app.features.bot_runtime.builtin_ids import HELPER_BOT_ID


@pytest.mark.asyncio
async def test_list_workspaces_empty(client: AsyncClient, db_session: AsyncSession) -> None:
    """Covers test list workspaces empty behavior."""
    resp = await client.get("/api/v1/workspaces")
    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "success"
    # list_for_user lazily creates a Personal workspace on first call
    assert len(data["data"]) == 1
    assert data["data"][0]["kind"] == "personal"


@pytest.mark.asyncio
async def test_personal_workspace_bootstraps_helper_dm(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Personal workspace provisioning creates the built-in helper onboarding DM."""
    db_session.add(
        BotAccount(
            bot_id=HELPER_BOT_ID,
            username="Coordinator",
            display_name="协作助手",
            status="online",
            scope="everyone",
        )
    )
    await db_session.commit()

    resp = await client.get("/api/v1/dms")
    assert resp.status_code == 200
    payload = resp.json()
    assert payload["status"] == "success"
    helper_dms = [
        dm for dm in payload["data"]
        if dm["counterparty"]["member_id"] == HELPER_BOT_ID
    ]
    assert len(helper_dms) == 1
    helper_dm = helper_dms[0]
    assert helper_dm["counterparty"]["member_id"] == HELPER_BOT_ID
    assert helper_dm["counterparty"]["username"] == "Coordinator"

    second_resp = await client.get("/api/v1/workspaces")
    assert second_resp.status_code == 200

    second_dm_resp = await client.get("/api/v1/dms")
    assert second_dm_resp.status_code == 200
    second_helper_dms = [
        dm for dm in second_dm_resp.json()["data"]
        if dm["counterparty"]["member_id"] == HELPER_BOT_ID
    ]
    assert [dm["channel_id"] for dm in second_helper_dms] == [helper_dm["channel_id"]]

    dm_row = await db_session.get(Channel, helper_dm["channel_id"])
    assert dm_row is not None
    assert dm_row.type == "dm"
    assert not dm_row.name.startswith("dmchat:")

    messages = (
        await db_session.execute(
            select(Message).where(Message.channel_id == helper_dm["channel_id"])
        )
    ).scalars().all()
    assert len(messages) == 1
    assert messages[0].sender_id == HELPER_BOT_ID
    assert "自然语言" in messages[0].content
    assert "Docs" in messages[0].content


@pytest.mark.asyncio
async def test_list_workspaces_returns_created(client: AsyncClient, db_session: AsyncSession) -> None:
    """Covers test list workspaces returns created behavior."""
    ws = Workspace(workspace_id="b0000000-0000-0000-0000-000000000001", name="默认空间")
    db_session.add(ws)
    # Add test user as workspace member so list_for_user returns this workspace
    membership = WorkspaceMembership(
        workspace_id=ws.workspace_id,
        user_id="a0000000-0000-0000-0000-000000000099",
        role="owner",
    )
    db_session.add(membership)
    await db_session.commit()

    resp = await client.get("/api/v1/workspaces")
    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "success"
    # list_for_user also auto-creates Personal workspace, so expect 2 total
    workspace_ids = [w["workspace_id"] for w in data["data"]]
    assert "b0000000-0000-0000-0000-000000000001" in workspace_ids
    names = {w["workspace_id"]: w["name"] for w in data["data"]}
    assert names["b0000000-0000-0000-0000-000000000001"] == "默认空间"


@pytest.mark.asyncio
async def test_create_workspace_accepts_avatar_url(client: AsyncClient) -> None:
    """Covers test create workspace accepts avatar url behavior."""
    resp = await client.post(
        "/api/v1/workspaces",
        json={
            "name": "Avatar Workspace",
            "avatar_url": "https://cdn.example.test/workspace.png",
        },
    )

    assert resp.status_code == 200
    data = resp.json()["data"]
    assert data["name"] == "Avatar Workspace"
    assert data["avatar_url"] == "https://cdn.example.test/workspace.png"

    list_resp = await client.get("/api/v1/workspaces")
    listed = next(w for w in list_resp.json()["data"] if w["workspace_id"] == data["workspace_id"])
    assert listed["avatar_url"] == "https://cdn.example.test/workspace.png"


@pytest.mark.asyncio
async def test_update_workspace_sets_and_clears_avatar_url(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Covers test update workspace sets and clears avatar url behavior."""
    ws = Workspace(workspace_id="b0000000-0000-0000-0000-000000000011", name="旧名称")
    db_session.add(ws)
    membership = WorkspaceMembership(
        workspace_id=ws.workspace_id,
        user_id="a0000000-0000-0000-0000-000000000099",
        role="owner",
    )
    db_session.add(membership)
    await db_session.commit()

    set_resp = await client.put(
        f"/api/v1/workspaces/{ws.workspace_id}",
        json={
            "name": "新名称",
            "avatar_url": "https://cdn.example.test/workspace-updated.png",
        },
    )
    assert set_resp.status_code == 200
    updated = set_resp.json()["data"]
    assert updated["name"] == "新名称"
    assert updated["avatar_url"] == "https://cdn.example.test/workspace-updated.png"

    clear_resp = await client.put(
        f"/api/v1/workspaces/{ws.workspace_id}",
        json={"avatar_url": None},
    )
    assert clear_resp.status_code == 200
    assert clear_resp.json()["data"]["avatar_url"] is None


@pytest.mark.asyncio
async def test_invite_workspace_member_accepts_user_id_from_search(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """POST /api/v1/workspaces/{id}/invite accepts user_id returned by search."""
    ws = Workspace(workspace_id="b0000000-0000-0000-0000-000000000021", name="Search Invite WS")
    public_channel = Channel(
        channel_id="e9000000-0000-0000-0000-000000000021",
        workspace_id=ws.workspace_id,
        name="public-legacy",
        type="public",
    )
    workspace_channel = Channel(
        channel_id="e9000000-0000-0000-0000-000000000022",
        workspace_id=ws.workspace_id,
        name="workspace-alias",
        type="workspace",
    )
    private_channel = Channel(
        channel_id="e9000000-0000-0000-0000-000000000023",
        workspace_id=ws.workspace_id,
        name="private-channel",
        type="private",
    )
    dm_channel = Channel(
        channel_id="e9000000-0000-0000-0000-000000000024",
        workspace_id=ws.workspace_id,
        name="dm-channel",
        type="dm",
    )
    target = User(
        user_id="a0000000-0000-0000-0000-000000000021",
        username="search_invite_target",
        password_hash="x",
        role="member",
    )
    db_session.add_all([
        ws,
        public_channel,
        workspace_channel,
        private_channel,
        dm_channel,
        target,
        WorkspaceMembership(
            workspace_id=ws.workspace_id,
            user_id="a0000000-0000-0000-0000-000000000099",
            role="owner",
        ),
    ])
    await db_session.commit()

    resp = await client.post(
        f"/api/v1/workspaces/{ws.workspace_id}/invite",
        json={"identifier": target.user_id},
    )

    assert resp.status_code == 200
    membership = await db_session.get(
        WorkspaceMembership,
        (ws.workspace_id, target.user_id),
    )
    assert membership is not None
    assert membership.role == "member"
    assert await db_session.get(ChannelMembership, (public_channel.channel_id, target.user_id)) is not None
    assert await db_session.get(ChannelMembership, (workspace_channel.channel_id, target.user_id)) is not None
    assert await db_session.get(ChannelMembership, (private_channel.channel_id, target.user_id)) is None
    assert await db_session.get(ChannelMembership, (dm_channel.channel_id, target.user_id)) is None


@pytest.mark.asyncio
async def test_invite_workspace_member_rejects_invalid_role(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """POST /api/v1/workspaces/{id}/invite only accepts known workspace roles."""
    ws = Workspace(workspace_id="b0000000-0000-0000-0000-000000000031", name="Role Invite WS")
    target = User(
        user_id="a0000000-0000-0000-0000-000000000031",
        username="role_invite_target",
        password_hash="x",
        role="member",
    )
    db_session.add_all([
        ws,
        target,
        WorkspaceMembership(
            workspace_id=ws.workspace_id,
            user_id="a0000000-0000-0000-0000-000000000099",
            role="owner",
        ),
    ])
    await db_session.commit()

    resp = await client.post(
        f"/api/v1/workspaces/{ws.workspace_id}/invite",
        json={"identifier": target.user_id, "role": "superuser"},
    )

    assert resp.status_code == 422
