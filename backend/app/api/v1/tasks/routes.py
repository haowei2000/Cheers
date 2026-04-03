"""Tasks v1 路由（Agent 任务日志 / 质量监控）."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, Query
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.dependencies import get_session
from app.core.responses import APIResponse
from app.db.models import AgentTask, BotAccount

router = APIRouter(tags=["tasks"])


def _task_dict(task: AgentTask, username: str | None, display_name: str | None) -> dict:
    return {
        "task_id": task.task_id,
        "channel_id": task.channel_id,
        "bot_id": task.bot_id,
        "bot_username": username,
        "bot_display_name": display_name,
        "trigger_msg_id": task.trigger_msg_id,
        "response_msg_id": task.response_msg_id,
        "latency_ms": task.latency_ms,
        "token_count": task.token_count,
        "feedback": task.feedback,
        "created_at": task.created_at.isoformat() if task.created_at else None,
    }


@router.get("/channels/{channel_id}/tasks", response_model=APIResponse[list[dict]])
async def list_channel_tasks(
    channel_id: str,
    limit: int = Query(50, ge=1, le=200),
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    result = await session.execute(
        select(AgentTask, BotAccount.username, BotAccount.display_name)
        .outerjoin(BotAccount, AgentTask.bot_id == BotAccount.bot_id)
        .where(AgentTask.channel_id == channel_id)
        .order_by(AgentTask.created_at.desc())
        .limit(limit)
    )
    items = [_task_dict(row[0], row[1], row[2]) for row in result.all()]
    return APIResponse.ok(items)


@router.get("/tasks", response_model=APIResponse[list[dict]])
async def list_tasks(
    channel_id: str | None = Query(None),
    limit: int = Query(50, ge=1, le=200),
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    q = (
        select(AgentTask, BotAccount.username, BotAccount.display_name)
        .outerjoin(BotAccount, AgentTask.bot_id == BotAccount.bot_id)
        .order_by(AgentTask.created_at.desc())
        .limit(limit)
    )
    if channel_id:
        q = q.where(AgentTask.channel_id == channel_id)
    result = await session.execute(q)
    items = [_task_dict(row[0], row[1], row[2]) for row in result.all()]
    return APIResponse.ok(items)


@router.get("/tasks/stats", response_model=APIResponse[dict])
async def get_task_stats(
    limit_days: int = Query(7, ge=1, le=90),
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    since = datetime.now(timezone.utc) - timedelta(days=limit_days)
    result = await session.execute(
        select(
            BotAccount.username,
            BotAccount.display_name,
            func.count(AgentTask.task_id).label("count"),
            func.avg(AgentTask.latency_ms).label("avg_latency_ms"),
        )
        .outerjoin(BotAccount, AgentTask.bot_id == BotAccount.bot_id)
        .where(AgentTask.created_at >= since)
        .group_by(AgentTask.bot_id, BotAccount.username, BotAccount.display_name)
    )
    rows = result.all()
    per_bot = []
    total_count = 0
    for row in rows:
        username, display_name, cnt, avg_ms = row[0], row[1], row[2] or 0, row[3]
        total_count += cnt
        per_bot.append({
            "username": username or "未知",
            "display_name": display_name,
            "task_count": cnt,
            "avg_latency_ms": round(float(avg_ms), 0) if avg_ms is not None else None,
        })
    return APIResponse.ok({"total_tasks": total_count, "limit_days": limit_days, "per_bot": per_bot})
