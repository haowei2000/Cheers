"""AgentTask 数据访问层."""
from __future__ import annotations

from datetime import datetime

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import AgentTask, BotAccount


class TaskRepository:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def list_tasks(
        self,
        channel_id: str | None = None,
        limit: int = 50,
    ) -> list[tuple[AgentTask, str | None, str | None]]:
        stmt = (
            select(AgentTask, BotAccount.username, BotAccount.display_name)
            .outerjoin(BotAccount, AgentTask.bot_id == BotAccount.bot_id)
            .order_by(AgentTask.created_at.desc())
            .limit(limit)
        )
        if channel_id:
            stmt = stmt.where(AgentTask.channel_id == channel_id)

        result = await self.session.execute(stmt)
        return list(result.all())

    async def get_stats(self, since: datetime) -> list[tuple[str | None, str | None, int, float | None]]:
        stmt = (
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
        result = await self.session.execute(stmt)
        return list(result.all())
