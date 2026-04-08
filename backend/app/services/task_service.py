"""Tasks 业务逻辑层."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import AgentTask
from app.repositories.task_repo import TaskRepository


class TaskService:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session
        self.repo = TaskRepository(session)

    def _task_dict(self, task: AgentTask, username: str | None, display_name: str | None) -> dict:
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

    async def list_tasks(self, channel_id: str | None = None, limit: int = 50) -> list[dict]:
        """获取任务日志列表."""
        rows = await self.repo.list_tasks(channel_id, limit)
        return [self._task_dict(row[0], row[1], row[2]) for row in rows]

    async def get_stats(self, limit_days: int = 7) -> dict:
        """获取 Agent 任务聚合统计信息."""
        since = datetime.now(timezone.utc) - timedelta(days=limit_days)
        rows = await self.repo.get_stats(since)
        
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
        
        return {
            "total_tasks": total_count,
            "limit_days": limit_days,
            "per_bot": per_bot,
        }
