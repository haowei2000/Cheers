"""Bulletin 业务逻辑层."""
from __future__ import annotations

from sqlalchemy.ext.asyncio import AsyncSession

from app.services.bulletin.schemas import IssueCreate, IssueUpdate
from app.core.exceptions import ForbiddenError, NotFoundError
from app.db.models import BulletinIssue, User
from app.repositories.bulletin_repo import BulletinRepository


class BulletinService:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session
        self.repo = BulletinRepository(session)

    async def list_issues(
        self,
        status: str | None = None,
        priority: str | None = None,
        limit: int = 50,
        offset: int = 0,
    ) -> list[BulletinIssue]:
        return await self.repo.list_issues(status, priority, limit, offset)

    async def create_issue(self, body: IssueCreate, creator: User) -> BulletinIssue:
        issue = BulletinIssue(
            title=body.title,
            content=body.content,
            priority=body.priority,
            tags=body.tags,
            creator_id=creator.user_id,
            creator_name=creator.display_name or creator.username,
        )
        return await self.repo.create(issue)

    async def get_or_404(self, issue_id: str) -> BulletinIssue:
        issue = await self.repo.get_by_id(issue_id)
        if not issue:
            raise NotFoundError("Issue 不存在")
        return issue

    async def update_issue(self, issue_id: str, body: IssueUpdate, current_user: User) -> BulletinIssue:
        issue = await self.get_or_404(issue_id)
        if issue.creator_id != current_user.user_id and current_user.role != "admin":
            raise ForbiddenError("无权修改此 Issue")

        if body.title is not None:
            issue.title = body.title
        if body.content is not None:
            issue.content = body.content
        if body.status is not None:
            issue.status = body.status
        if body.priority is not None:
            issue.priority = body.priority
        if body.tags is not None:
            issue.tags = body.tags

        await self.session.flush()
        return issue

    async def delete_issue(self, issue_id: str, current_user: User) -> None:
        issue = await self.get_or_404(issue_id)
        if issue.creator_id != current_user.user_id and current_user.role != "admin":
            raise ForbiddenError("无权删除此 Issue")
        await self.repo.delete(issue)
