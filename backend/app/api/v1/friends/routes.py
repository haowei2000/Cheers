"""Friends v1 路由（好友管理）."""
from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.dependencies import get_current_user, get_session
from app.core.exceptions import ForbiddenError
from app.core.responses import APIResponse
from app.db.models import User
from app.services.friendship_service import FriendshipService

router = APIRouter(prefix="/friends", tags=["friends"])


class FriendAddBody(BaseModel):
    user_id: str | None = None
    friend_identifier: str


class FriendRequestBody(BaseModel):
    friend_identifier: str


class FriendRemoveBody(BaseModel):
    user_id: str | None = None
    friend_id: str


class FriendBlockBody(BaseModel):
    friend_identifier: str


@router.get("/search", response_model=APIResponse[list[dict]])
async def search_users(
    query: str = Query(..., min_length=1),
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    svc = FriendshipService(session)
    return APIResponse.ok(await svc.search_users(query, current_user))


@router.get("", response_model=APIResponse[list[dict]])
async def get_my_friends(
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    svc = FriendshipService(session)
    return APIResponse.ok(await svc.list_friends(current_user.user_id))


@router.get("/requests", response_model=APIResponse[list[dict]])
async def get_friend_requests(
    box: str = Query("incoming", pattern="^(incoming|outgoing)$"),
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    svc = FriendshipService(session)
    return APIResponse.ok(await svc.list_requests(current_user, box))


@router.post("/requests", response_model=APIResponse[dict])
async def create_friend_request(
    body: FriendRequestBody,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    svc = FriendshipService(session)
    result = await svc.request_friend(current_user, body.friend_identifier)
    result.pop("action", None)
    return APIResponse.ok(result, message="好友申请已发送")


@router.post("/requests/{friendship_id}/accept", response_model=APIResponse[dict])
async def accept_friend_request(
    friendship_id: str,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    svc = FriendshipService(session)
    return APIResponse.ok(await svc.accept_request(current_user, friendship_id), message="已同意好友申请")


@router.post("/requests/{friendship_id}/reject", response_model=APIResponse[dict])
async def reject_friend_request(
    friendship_id: str,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    svc = FriendshipService(session)
    return APIResponse.ok(await svc.reject_request(current_user, friendship_id), message="已拒绝好友申请")


@router.delete("/requests/{friendship_id}", response_model=APIResponse[None])
async def cancel_friend_request(
    friendship_id: str,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    svc = FriendshipService(session)
    await svc.cancel_request(current_user, friendship_id)
    return APIResponse.ok(None, message="已撤回好友申请")


@router.delete("/{friend_id}", response_model=APIResponse[None])
async def delete_friend(
    friend_id: str,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    svc = FriendshipService(session)
    await svc.remove_friend(current_user, friend_id)
    return APIResponse.ok(None, message="已删除好友")


@router.get("/blocked/list", response_model=APIResponse[list[dict]])
async def list_blocked(
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    svc = FriendshipService(session)
    return APIResponse.ok(await svc.list_blocked(current_user))


@router.post("/blocked", response_model=APIResponse[dict])
async def block_user(
    body: FriendBlockBody,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    svc = FriendshipService(session)
    return APIResponse.ok(await svc.block_user(current_user, body.friend_identifier), message="已拉黑用户")


@router.delete("/blocked/{friend_id}", response_model=APIResponse[None])
async def unblock_user(
    friend_id: str,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    svc = FriendshipService(session)
    await svc.unblock_user(current_user, friend_id)
    return APIResponse.ok(None, message="已解除拉黑")


# ---- Legacy compatibility -----------------------------------------------

@router.get("/{user_id}", response_model=APIResponse[list[dict]])
async def get_friends_legacy(
    user_id: str,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    if user_id != current_user.user_id:
        raise ForbiddenError("只能读取自己的好友列表")
    svc = FriendshipService(session)
    return APIResponse.ok(await svc.list_friends(current_user.user_id))


@router.post("", response_model=APIResponse[dict])
async def add_friend_legacy(
    body: FriendAddBody,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    if body.user_id and body.user_id != current_user.user_id:
        raise ForbiddenError("只能以当前登录用户发起好友申请")
    svc = FriendshipService(session)
    result = await svc.request_friend(current_user, body.friend_identifier)
    result.pop("action", None)
    return APIResponse.ok(result, message="好友申请已发送")


@router.delete("", response_model=APIResponse[None])
async def remove_friend_legacy(
    body: FriendRemoveBody,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    if body.user_id and body.user_id != current_user.user_id:
        raise ForbiddenError("只能删除自己的好友关系")
    svc = FriendshipService(session)
    await svc.remove_friend(current_user, body.friend_id)
    return APIResponse.ok(None, message="已删除好友")
