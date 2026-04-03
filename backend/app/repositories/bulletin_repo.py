"""BulletinIssue 数据访问层."""
from __future__ import annotations

from sqlalchemy import desc, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import BulletinIssue


class BulletinRepository:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def list_issues(
        self,
        status: str | None = None,
        priority: str | None = None,
        limit: int = 50,
        offset: int = 0,
    ) -> list[BulletinIssue]:
        stmt = select(BulletinIssue).order_by(desc(BulletinIssue.created_at))
        if status:
            stmt = stmt.where(BulletinIssue.status == status)
        if priority:
            stmt = stmt.where(BulletinIssue.priority == priority)
        stmt = stmt.offset(offset).limit(limit)
        result = await self.session.execute(stmt)
        return list(result.scalars().all())

    async def get_by_id(self, issue_id: str) -> BulletinIssue | None:
        return await self.session.get(BulletinIssue, issue_id)

    async def create(self, issue: BulletinIssue) -> BulletinIssue:
        self.session.add(issue)
        await self.session.flush()
        return issue

    async def delete(self, issue: BulletinIssue) -> None:
        await self.session.delete(issue)
        await self.session.flush()
