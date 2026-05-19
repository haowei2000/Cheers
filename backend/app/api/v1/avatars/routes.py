"""Avatar upload and public serving routes."""
from __future__ import annotations

from fastapi import APIRouter, Depends, Request
from fastapi.responses import Response
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.core.dependencies import get_current_user, get_session
from app.core.exceptions import BadRequestError
from app.core.responses import APIResponse
from app.db.models import User
from app.services.avatar_service import AvatarService
from app.services.storage.bootstrap import get_storage_service, is_storage_enabled

router = APIRouter(prefix="/avatars", tags=["avatars"])


def _get_avatar_storage():
    if not is_storage_enabled():
        raise BadRequestError("对象存储未启用，无法使用头像上传")
    return get_storage_service()


async def _read_avatar_body(request: Request) -> bytes:
    length_header = request.headers.get("content-length")
    if length_header:
        try:
            if int(length_header) > settings.avatar_upload_max_bytes:
                raise BadRequestError("头像文件过大")
        except ValueError:
            pass
    return await request.body()


@router.post("/users/me", response_model=APIResponse[dict])
async def upload_my_avatar(
    request: Request,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    svc = AvatarService(session, _get_avatar_storage())
    result = await svc.upload_user_avatar(
        current_user,
        await _read_avatar_body(request),
        request.headers.get("content-type"),
    )
    return APIResponse.ok(result)


@router.post("/bots/{bot_id}", response_model=APIResponse[dict])
async def upload_bot_avatar(
    bot_id: str,
    request: Request,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    svc = AvatarService(session, _get_avatar_storage())
    result = await svc.upload_bot_avatar(
        bot_id,
        current_user,
        await _read_avatar_body(request),
        request.headers.get("content-type"),
    )
    return APIResponse.ok(result)


@router.post("/workspaces/{workspace_id}", response_model=APIResponse[dict])
async def upload_workspace_avatar(
    workspace_id: str,
    request: Request,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    svc = AvatarService(session, _get_avatar_storage())
    result = await svc.upload_workspace_avatar(
        workspace_id,
        current_user,
        await _read_avatar_body(request),
        request.headers.get("content-type"),
    )
    return APIResponse.ok(result)


@router.delete("/users/me", response_model=APIResponse[dict])
async def delete_my_avatar(
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    svc = AvatarService(session, _get_avatar_storage())
    return APIResponse.ok(await svc.delete_user_avatar(current_user))


@router.delete("/bots/{bot_id}", response_model=APIResponse[dict])
async def delete_bot_avatar(
    bot_id: str,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    svc = AvatarService(session, _get_avatar_storage())
    return APIResponse.ok(await svc.delete_bot_avatar(bot_id, current_user))


@router.delete("/workspaces/{workspace_id}", response_model=APIResponse[dict])
async def delete_workspace_avatar(
    workspace_id: str,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    svc = AvatarService(session, _get_avatar_storage())
    return APIResponse.ok(await svc.delete_workspace_avatar(workspace_id, current_user))


@router.get("/users/{user_id}")
async def get_user_avatar(
    user_id: str,
    session: AsyncSession = Depends(get_session),
) -> Response:
    svc = AvatarService(session, _get_avatar_storage())
    obj = await svc.get_user_avatar(user_id)
    return Response(
        content=obj.body,
        media_type=obj.head.content_type or "application/octet-stream",
        headers={"Cache-Control": "public, max-age=86400"},
    )


@router.get("/workspaces/{workspace_id}")
async def get_workspace_avatar(
    workspace_id: str,
    session: AsyncSession = Depends(get_session),
) -> Response:
    svc = AvatarService(session, _get_avatar_storage())
    obj = await svc.get_workspace_avatar(workspace_id)
    return Response(
        content=obj.body,
        media_type=obj.head.content_type or "application/octet-stream",
        headers={"Cache-Control": "public, max-age=86400"},
    )


@router.get("/bots/{bot_id}")
async def get_bot_avatar(
    bot_id: str,
    session: AsyncSession = Depends(get_session),
) -> Response:
    svc = AvatarService(session, _get_avatar_storage())
    obj = await svc.get_bot_avatar(bot_id)
    return Response(
        content=obj.body,
        media_type=obj.head.content_type or "application/octet-stream",
        headers={"Cache-Control": "public, max-age=86400"},
    )
