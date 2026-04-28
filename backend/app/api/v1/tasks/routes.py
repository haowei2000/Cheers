"""Tasks v1 路由（Agent 任务日志 / 质量监控）."""
from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.dependencies import get_session
from app.core.responses import APIResponse
from app.services.task_service import TaskService

router = APIRouter(tags=["tasks"])


@router.get("/tasks", response_model=APIResponse[list[dict]])
async def list_tasks(
    channel_id: str | None = Query(None),
    limit: int = Query(50, ge=1, le=200),
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    svc = TaskService(session)
    items = await svc.list_tasks(channel_id=channel_id, limit=limit)
    return APIResponse.ok(items)


@router.get("/tasks/stats", response_model=APIResponse[dict])
async def get_task_stats(
    limit_days: int = Query(7, ge=1, le=90),
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    svc = TaskService(session)
    stats = await svc.get_stats(limit_days=limit_days)
    return APIResponse.ok(stats)
