"""工作空间 API 测试."""
import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import Workspace


@pytest.mark.asyncio
async def test_list_workspaces_empty(client: AsyncClient, db_session: AsyncSession) -> None:
    """GET /api/workspaces 无工作空间时返回空列表."""
    resp = await client.get("/api/workspaces")
    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "success"
    assert data["data"] == []


@pytest.mark.asyncio
async def test_list_workspaces_returns_created(client: AsyncClient, db_session: AsyncSession) -> None:
    """GET /api/workspaces 返回已存在的工作空间."""
    ws = Workspace(workspace_id="ws-001", name="默认空间")
    db_session.add(ws)
    await db_session.commit()

    resp = await client.get("/api/workspaces")
    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "success"
    assert len(data["data"]) == 1
    assert data["data"][0]["workspace_id"] == "ws-001"
    assert data["data"][0]["name"] == "默认空间"
