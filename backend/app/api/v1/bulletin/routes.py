"""Bulletin v1 路由（公共留言板 CRUD）."""
from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from sqlalchemy import desc, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.bulletin.schemas import IssueCreate, IssueInResponse, IssueUpdate
from app.core.dependencies import get_current_user, get_session
from app.core.exceptions import ForbiddenError, NotFoundError
from app.core.responses import APIResponse
from app.db.models import BulletinIssue, User

router = APIRouter(prefix="/bulletin", tags=["bulletin"])


@router.get("/issues", response_model=APIResponse[list[IssueInResponse]])
async def list_issues(
    status: str | None = Query(default=None, pattern="^(open|closed)$"),
    priority: str | None = Query(default=None, pattern="^(low|medium|high)$"),
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    stmt = select(BulletinIssue).order_by(desc(BulletinIssue.created_at))
    if status:
        stmt = stmt.where(BulletinIssue.status == status)
    if priority:
        stmt = stmt.where(BulletinIssue.priority == priority)
    stmt = stmt.offset(offset).limit(limit)
    result = await session.execute(stmt)
    issues = result.scalars().all()
    return APIResponse.ok([IssueInResponse.model_validate(i) for i in issues])


@router.post("/issues", response_model=APIResponse[IssueInResponse], status_code=201)
async def create_issue(
    body: IssueCreate,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    issue = BulletinIssue(
        title=body.title,
        content=body.content,
        priority=body.priority,
        tags=body.tags,
        creator_id=current_user.user_id,
        creator_name=current_user.display_name or current_user.username,
    )
    session.add(issue)
    await session.flush()
    await session.refresh(issue)
    return APIResponse.ok(IssueInResponse.model_validate(issue))


@router.get("/issues/{issue_id}", response_model=APIResponse[IssueInResponse])
async def get_issue(
    issue_id: str,
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    issue = await session.get(BulletinIssue, issue_id)
    if not issue:
        raise NotFoundError("Issue 不存在")
    return APIResponse.ok(IssueInResponse.model_validate(issue))


@router.patch("/issues/{issue_id}", response_model=APIResponse[IssueInResponse])
async def update_issue(
    issue_id: str,
    body: IssueUpdate,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    issue = await session.get(BulletinIssue, issue_id)
    if not issue:
        raise NotFoundError("Issue 不存在")
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
    await session.flush()
    await session.refresh(issue)
    return APIResponse.ok(IssueInResponse.model_validate(issue))


@router.delete("/issues/{issue_id}", response_model=APIResponse[None])
async def delete_issue(
    issue_id: str,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    issue = await session.get(BulletinIssue, issue_id)
    if not issue:
        raise NotFoundError("Issue 不存在")
    if issue.creator_id != current_user.user_id and current_user.role != "admin":
        raise ForbiddenError("无权删除此 Issue")
    await session.delete(issue)
    await session.flush()
    return APIResponse.ok(None)
