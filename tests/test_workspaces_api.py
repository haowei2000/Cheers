"""Tests for test workspaces api."""
import pytest
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import ForbiddenError
from app.db.models import BotAccount, Channel, ChannelMembership, Message, User, Workspace, WorkspaceMembership
from app.features.bot_runtime.builtin_ids import HELPER_BOT_ID
from app.services.channel_service import parse_personal_project_channel_purpose
from app.services.workspace_service import WorkspaceService


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
    assert "natural language" in messages[0].content
    assert "Docs" in messages[0].content


@pytest.mark.asyncio
async def test_create_workspace_invites_initial_members(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    invited = User(
        user_id="a0000000-0000-0000-0000-000000000221",
        username="workspace_initial_member",
        password_hash="x",
    )
    db_session.add(invited)
    await db_session.commit()

    resp = await client.post(
        "/api/v1/workspaces",
        json={
            "name": "Initial Members",
            "initial_member_ids": [invited.user_id],
        },
    )

    assert resp.status_code == 200
    workspace_id = resp.json()["data"]["workspace_id"]
    membership = await db_session.get(
        WorkspaceMembership,
        {"workspace_id": workspace_id, "user_id": invited.user_id},
    )
    assert membership is not None
    assert membership.role == "member"


@pytest.mark.asyncio
async def test_personal_workspace_default_bot_can_be_set_and_cleared(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    bot = BotAccount(
        bot_id="b1000000-0000-0000-0000-000000000041",
        username="default_personal_bot",
        display_name="Default Personal Bot",
        status="online",
        scope="everyone",
    )
    db_session.add(bot)
    await db_session.commit()

    workspace_resp = await client.get("/api/v1/workspaces")
    assert workspace_resp.status_code == 200
    personal_ws = next(w for w in workspace_resp.json()["data"] if w["kind"] == "personal")
    assert personal_ws["default_bot_id"] is None
    assert personal_ws["default_bot"] is None

    set_resp = await client.put(
        f"/api/v1/workspaces/{personal_ws['workspace_id']}",
        json={
            "name": personal_ws["name"],
            "default_bot_id": bot.bot_id,
        },
    )
    assert set_resp.status_code == 200
    set_data = set_resp.json()["data"]
    assert set_data["default_bot_id"] == bot.bot_id
    assert set_data["default_bot"] == {
        "bot_id": bot.bot_id,
        "username": "default_personal_bot",
        "display_name": "Default Personal Bot",
        "avatar_url": None,
    }

    list_resp = await client.get("/api/v1/workspaces")
    assert list_resp.status_code == 200
    listed_personal = next(w for w in list_resp.json()["data"] if w["kind"] == "personal")
    assert listed_personal["default_bot_id"] == bot.bot_id
    assert listed_personal["default_bot"]["username"] == "default_personal_bot"

    clear_resp = await client.put(
        f"/api/v1/workspaces/{personal_ws['workspace_id']}",
        json={
            "name": personal_ws["name"],
            "default_bot_id": None,
        },
    )
    assert clear_resp.status_code == 200
    clear_data = clear_resp.json()["data"]
    assert clear_data["default_bot_id"] is None
    assert clear_data["default_bot"] is None


@pytest.mark.asyncio
async def test_personal_workspace_default_bot_rejects_missing_bot(
    client: AsyncClient,
) -> None:
    workspace_resp = await client.get("/api/v1/workspaces")
    assert workspace_resp.status_code == 200
    personal_ws = next(w for w in workspace_resp.json()["data"] if w["kind"] == "personal")

    resp = await client.put(
        f"/api/v1/workspaces/{personal_ws['workspace_id']}",
        json={
            "name": personal_ws["name"],
            "default_bot_id": "missing-default-bot",
        },
    )

    assert resp.status_code == 404
    assert resp.json()["status"] == "error"


@pytest.mark.asyncio
async def test_personal_workspace_default_bot_rejects_inaccessible_bot(
    db_session: AsyncSession,
) -> None:
    user = User(
        user_id="a0000000-0000-0000-0000-000000000341",
        username="default_bot_owner_user",
        password_hash="x",
        role="user",
    )
    other = User(
        user_id="a0000000-0000-0000-0000-000000000342",
        username="default_bot_other_owner",
        password_hash="x",
        role="user",
    )
    workspace = Workspace(
        workspace_id="w1000000-0000-0000-0000-000000000341",
        name="Personal",
        kind="personal",
    )
    bot = BotAccount(
        bot_id="b1000000-0000-0000-0000-000000000342",
        username="private_other_bot",
        display_name="Private Other Bot",
        status="online",
        scope="private",
        created_by=other.user_id,
    )
    db_session.add_all([
        user,
        other,
        workspace,
        WorkspaceMembership(
            workspace_id=workspace.workspace_id,
            user_id=user.user_id,
            role="owner",
        ),
        bot,
    ])
    await db_session.flush()

    with pytest.raises(ForbiddenError):
        await WorkspaceService(db_session).update(
            workspace.workspace_id,
            user,
            default_bot_id=bot.bot_id,
            default_bot_id_provided=True,
        )


@pytest.mark.asyncio
async def test_workspace_default_bot_is_cleared_when_bot_is_deleted(
    db_session: AsyncSession,
) -> None:
    workspace = Workspace(
        workspace_id="w1000000-0000-0000-0000-000000000351",
        name="Personal",
        kind="personal",
    )
    bot = BotAccount(
        bot_id="b1000000-0000-0000-0000-000000000351",
        username="delete_default_bot",
        status="online",
        scope="everyone",
    )
    db_session.add_all([bot, workspace])
    await db_session.flush()
    workspace.default_bot_id = bot.bot_id
    await db_session.flush()

    await db_session.delete(bot)
    await db_session.flush()
    await db_session.refresh(workspace)

    assert workspace.default_bot_id is None


@pytest.mark.asyncio
async def test_personal_project_supports_channel_and_bot_dm_tasks(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Personal Project task groups can contain private channels and bot DMs."""
    bot = BotAccount(
        bot_id="b1000000-0000-0000-0000-000000000031",
        username="project_bot",
        display_name="Project Bot",
        status="online",
        scope="everyone",
    )
    db_session.add(bot)
    await db_session.commit()

    ws_resp = await client.get("/api/v1/workspaces")
    assert ws_resp.status_code == 200
    personal_ws = next(w for w in ws_resp.json()["data"] if w["kind"] == "personal")

    channel_resp = await client.post(
        "/api/v1/channels",
        json={
            "workspace_id": personal_ws["workspace_id"],
            "name": "Spec Review",
            "type": "private",
            "allow_member_invites": False,
            "allow_bot_adds": True,
            "project_id": "project-alpha",
            "project_title": "Alpha Project",
            "task_title": "Spec Review",
        },
    )
    assert channel_resp.status_code == 200
    channel_data = channel_resp.json()["data"]
    assert channel_data["type"] == "private"
    assert channel_data["project_id"] == "project-alpha"
    assert channel_data["project_title"] == "Alpha Project"
    assert channel_data["task_title"] == "Spec Review"
    assert channel_data["project_task_type"] == "channel"
    assert channel_data["allow_member_invites"] is False
    assert channel_data["allow_bot_adds"] is True

    channel_row = await db_session.get(Channel, channel_data["channel_id"])
    assert channel_row is not None
    assert parse_personal_project_channel_purpose(channel_row.purpose) == {
        "project_id": "project-alpha",
        "project_title": "Alpha Project",
        "task_title": "Spec Review",
        "project_task_type": "channel",
    }

    listed_channels = await client.get(f"/api/v1/channels/by-workspace/{personal_ws['workspace_id']}")
    assert listed_channels.status_code == 200
    listed_project = next(
        row for row in listed_channels.json()["data"] if row["channel_id"] == channel_data["channel_id"]
    )
    assert listed_project["project_task_type"] == "channel"
    assert listed_project["project_title"] == "Alpha Project"

    dm_resp = await client.post(
        "/api/v1/dms",
        json={
            "workspace_id": personal_ws["workspace_id"],
            "member_id": bot.bot_id,
            "member_type": "bot",
            "create_new": True,
            "title": "Bot Research",
            "project_id": "project-alpha",
            "project_title": "Alpha Project",
            "chat_title": "Bot Research",
        },
    )
    assert dm_resp.status_code == 200
    dm_data = dm_resp.json()["data"]
    assert dm_data["project_id"] == "project-alpha"
    assert dm_data["project_title"] == "Alpha Project"
    assert dm_data["chat_title"] == "Bot Research"

    dm_list = await client.get("/api/v1/dms")
    assert dm_list.status_code == 200
    listed_dm = next(row for row in dm_list.json()["data"] if row["channel_id"] == dm_data["channel_id"])
    assert listed_dm["project_id"] == "project-alpha"
    assert listed_dm["chat_title"] == "Bot Research"


@pytest.mark.asyncio
async def test_personal_workspace_helper_dm_uses_chinese_locale(
    db_session: AsyncSession,
) -> None:
    await db_session.merge(
        BotAccount(
            bot_id=HELPER_BOT_ID,
            username="Coordinator",
            display_name="协作助手",
            status="online",
            scope="everyone",
        )
    )
    user = User(
        user_id="a0000000-0000-0000-0000-000000000188",
        username="zh_locale_user",
        password_hash="x",
        display_name="中文用户",
        role="user",
    )
    await db_session.merge(user)
    await db_session.commit()

    workspace = await WorkspaceService(db_session).ensure_personal_workspace(user, locale="zh-CN")
    await db_session.commit()
    messages = (
        await db_session.execute(
            select(Message)
            .join(Channel, Channel.channel_id == Message.channel_id)
            .where(
                Channel.workspace_id == workspace.workspace_id,
                Message.sender_id == HELPER_BOT_ID,
            )
        )
    ).scalars().all()
    assert len(messages) == 1
    assert "自然语言" in messages[0].content


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
