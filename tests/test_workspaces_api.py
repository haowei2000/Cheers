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
