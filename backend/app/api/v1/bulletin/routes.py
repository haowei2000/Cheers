"""Bulletin v1 路由（公共留言板 CRUD）."""
from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.services.bulletin.schemas import IssueCreate, IssueInResponse, IssueUpdate
from app.core.dependencies import get_current_user, get_session
from app.core.responses import APIResponse
from app.db.models import User
from app.services.bulletin_service import BulletinService

router = APIRouter(prefix="/bulletin", tags=["bulletin"])


@router.get("/issues", response_model=APIResponse[list[IssueInResponse]])
async def list_issues(
    status: str | None = Query(default=None, pattern="^(open|closed)$"),
    priority: str | None = Query(default=None, pattern="^(low|medium|high)$"),
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    svc = BulletinService(session)
    issues = await svc.list_issues(status, priority, limit, offset)
    return APIResponse.ok([IssueInResponse.model_validate(i) for i in issues])


@router.post("/issues", response_model=APIResponse[IssueInResponse], status_code=201)
async def create_issue(
    body: IssueCreate,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    svc = BulletinService(session)
    issue = await svc.create_issue(body, current_user)
    return APIResponse.ok(IssueInResponse.model_validate(issue))


@router.get("/issues/{issue_id}", response_model=APIResponse[IssueInResponse])
async def get_issue(
    issue_id: str,
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    svc = BulletinService(session)
    issue = await svc.get_or_404(issue_id)
    return APIResponse.ok(IssueInResponse.model_validate(issue))


@router.patch("/issues/{issue_id}", response_model=APIResponse[IssueInResponse])
async def update_issue(
    issue_id: str,
    body: IssueUpdate,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    svc = BulletinService(session)
    issue = await svc.update_issue(issue_id, body, current_user)
    return APIResponse.ok(IssueInResponse.model_validate(issue))


@router.delete("/issues/{issue_id}", response_model=APIResponse[None])
async def delete_issue(
    issue_id: str,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    svc = BulletinService(session)
    await svc.delete_issue(issue_id, current_user)
    return APIResponse.ok(None)
