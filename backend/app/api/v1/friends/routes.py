"""Friends v1 路由（好友管理）."""
from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.dependencies import get_session
from app.core.responses import APIResponse
from app.services.friendship_service import FriendshipService

router = APIRouter(prefix="/friends", tags=["friends"])


class FriendAddBody(BaseModel):
    user_id: str
    friend_identifier: str


class FriendRemoveBody(BaseModel):
    user_id: str
    friend_id: str


@router.get("/search", response_model=APIResponse[list[dict]])
async def search_users(
    query: str = Query(..., min_length=1),
    current_user_id: str = Query(...),
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    svc = FriendshipService(session)
    users = await svc.search_users(query, current_user_id)
    return APIResponse.ok([
        {"user_id": u.user_id, "username": u.username, "display_name": u.display_name, "avatar_url": u.avatar_url}
        for u in users
    ])


@router.get("/{user_id}", response_model=APIResponse[list[dict]])
async def get_friends(
    user_id: str,
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    svc = FriendshipService(session)
    friends = await svc.list_friends(user_id)
    return APIResponse.ok(friends)


@router.post("", response_model=APIResponse[dict])
async def add_friend(
    body: FriendAddBody,
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    svc = FriendshipService(session)
    result = await svc.add_friend(body.user_id, body.friend_identifier)
    msg = "已接受好友请求" if result["action"] == "accepted_existing" else "添加好友成功"
    # Remove action from response to match original schema
    result.pop("action")
    return APIResponse.ok(result, message=msg)


@router.delete("", response_model=APIResponse[None])
async def remove_friend(
    body: FriendRemoveBody,
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    svc = FriendshipService(session)
    await svc.remove_friend(body.user_id, body.friend_id)
    return APIResponse.ok(None, message="已删除好友")


@router.get("/check/{user_id}/{friend_id}", response_model=APIResponse[dict])
async def check_friendship(
    user_id: str,
    friend_id: str,
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    svc = FriendshipService(session)
    status = await svc.check_friendship(user_id, friend_id)
    return APIResponse.ok(status)
