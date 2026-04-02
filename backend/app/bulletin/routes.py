"""公共留言板 CRUD 路由."""
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select, desc
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.routes import get_current_user, try_get_current_user
from app.db.models import BulletinIssue, User
from app.db.session import get_session
from app.bulletin.schemas import IssueCreate, IssueUpdate, IssueInResponse

router = APIRouter(prefix="/api/bulletin", tags=["bulletin"])


@router.get("/issues")
async def list_issues(
    status: Optional[str] = Query(default=None, pattern="^(open|closed)$"),
    priority: Optional[str] = Query(default=None, pattern="^(low|medium|high)$"),
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    db: AsyncSession = Depends(get_session),
) -> dict:
    stmt = select(BulletinIssue).order_by(desc(BulletinIssue.created_at))
    if status:
        stmt = stmt.where(BulletinIssue.status == status)
    if priority:
        stmt = stmt.where(BulletinIssue.priority == priority)
    stmt = stmt.offset(offset).limit(limit)
    result = await db.execute(stmt)
    issues = result.scalars().all()
    return {
        "status": "success",
        "data": [IssueInResponse.model_validate(i) for i in issues],
    }


@router.post("/issues", status_code=201)
async def create_issue(
    body: IssueCreate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> dict:
    issue = BulletinIssue(
        title=body.title,
        content=body.content,
        priority=body.priority,
        tags=body.tags,
        creator_id=current_user.user_id,
        creator_name=current_user.display_name or current_user.username,
    )
    db.add(issue)
    await db.commit()
    await db.refresh(issue)
    return {"status": "success", "data": IssueInResponse.model_validate(issue)}


@router.get("/issues/{issue_id}")
async def get_issue(
    issue_id: str,
    db: AsyncSession = Depends(get_session),
) -> dict:
    issue = await db.get(BulletinIssue, issue_id)
    if not issue:
        raise HTTPException(status_code=404, detail="Issue 不存在")
    return {"status": "success", "data": IssueInResponse.model_validate(issue)}


@router.patch("/issues/{issue_id}")
async def update_issue(
    issue_id: str,
    body: IssueUpdate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> dict:
    issue = await db.get(BulletinIssue, issue_id)
    if not issue:
        raise HTTPException(status_code=404, detail="Issue 不存在")
    if issue.creator_id != current_user.user_id and current_user.role != "admin":
        raise HTTPException(status_code=403, detail="无权修改此 Issue")

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

    await db.commit()
    await db.refresh(issue)
    return {"status": "success", "data": IssueInResponse.model_validate(issue)}


@router.delete("/issues/{issue_id}", status_code=200)
async def delete_issue(
    issue_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> dict:
    issue = await db.get(BulletinIssue, issue_id)
    if not issue:
        raise HTTPException(status_code=404, detail="Issue 不存在")
    if issue.creator_id != current_user.user_id and current_user.role != "admin":
        raise HTTPException(status_code=403, detail="无权删除此 Issue")

    await db.delete(issue)
    await db.commit()
    return {"status": "success", "data": None}
