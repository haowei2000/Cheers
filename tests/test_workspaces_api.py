"""工作空间 API 测试."""
import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import Workspace, WorkspaceMembership


@pytest.mark.asyncio
async def test_list_workspaces_empty(client: AsyncClient, db_session: AsyncSession) -> None:
    """GET /api/workspaces 无手动创建工作空间时，只返回自动创建的 Personal 空间."""
    resp = await client.get("/api/v1/workspaces")
    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "success"
    # list_for_user lazily creates a Personal workspace on first call
    assert len(data["data"]) == 1
    assert data["data"][0]["kind"] == "personal"


@pytest.mark.asyncio
async def test_list_workspaces_returns_created(client: AsyncClient, db_session: AsyncSession) -> None:
    """GET /api/workspaces 返回已存在的工作空间."""
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
    """POST /api/v1/workspaces 支持创建时设置工作空间头像 URL."""
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
    """PUT /api/v1/workspaces/{id} 支持设置和清空工作空间头像 URL."""
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
