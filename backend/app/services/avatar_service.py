"""Avatar upload and serving backed by object storage."""
from __future__ import annotations

import time
from urllib.parse import quote

from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.core.exceptions import BadRequestError, ForbiddenError, NotFoundError
from app.db.models import BotAccount, User, Workspace
from app.repositories.user_repo import UserRepository
from app.services.bot_service import BotService, can_manage_bot
from app.services.storage.base import StorageObject, StorageObjectNotFoundError, StorageProvider
from app.services.workspace_service import WorkspaceService

AVATAR_SCOPE = "avatars"
AVATAR_ROUTE_PREFIX = "/api/v1/avatars"


def _avatar_file_id(kind: str, entity_id: str) -> str:
    # Storage IDs allow alnum + hyphen. UUIDs and built-in bot IDs already fit.
    safe_id = "".join(ch if ch.isalnum() or ch == "-" else "-" for ch in entity_id.strip())
    return f"avatar-{kind}-{safe_id}"


def _avatar_url(kind_plural: str, entity_id: str) -> str:
    version = time.time_ns()
    return f"{AVATAR_ROUTE_PREFIX}/{kind_plural}/{quote(entity_id, safe='')}?v={version}"


def _route_path(kind_plural: str, entity_id: str) -> str:
    return f"{AVATAR_ROUTE_PREFIX}/{kind_plural}/{quote(entity_id, safe='')}"


def _allowed_types() -> set[str]:
    return {
        item.strip().lower()
        for item in (settings.avatar_upload_allowed_types or "").split(",")
        if item.strip()
    }


def _sniff_image_content_type(data: bytes) -> str | None:
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if data.startswith((b"GIF87a", b"GIF89a")):
        return "image/gif"
    if len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    return None


def validate_avatar_image(data: bytes, declared_content_type: str | None = None) -> str:
    if not data:
        raise BadRequestError("头像文件不能为空")
    if len(data) > settings.avatar_upload_max_bytes:
        limit_mb = settings.avatar_upload_max_bytes / 1024 / 1024
        raise BadRequestError(f"头像文件不能超过 {limit_mb:.1f} MB")

    sniffed = _sniff_image_content_type(data)
    declared = (declared_content_type or "").split(";", 1)[0].strip().lower()
    content_type = sniffed or declared
    if content_type not in _allowed_types() or not sniffed:
        raise BadRequestError("头像仅支持 PNG、JPEG、WebP 或 GIF 图片")
    return content_type


class AvatarService:
    def __init__(self, session: AsyncSession, storage: StorageProvider) -> None:
        self.session = session
        self.storage = storage
        self.user_repo = UserRepository(session)
        self.bot_service = BotService(session)
        self.workspace_service = WorkspaceService(session)

    async def upload_user_avatar(
        self,
        user: User,
        data: bytes,
        declared_content_type: str | None,
    ) -> dict:
        content_type = validate_avatar_image(data, declared_content_type)
        file_id = _avatar_file_id("user", user.user_id)
        ref = await self.storage.put_object(file_id, data, content_type, scope=AVATAR_SCOPE)
        avatar_url = _avatar_url("users", user.user_id)

        target = await self.user_repo.get_by_id(user.user_id) or user
        await self.user_repo.update(target, avatar_url=avatar_url)
        return {
            "avatar_url": avatar_url,
            "content_type": content_type,
            "size_bytes": len(data),
            "storage_bucket": ref.bucket,
            "object_key": ref.object_key,
        }

    async def upload_workspace_avatar(
        self,
        workspace_id: str,
        current_user: User,
        data: bytes,
        declared_content_type: str | None,
    ) -> dict:
        workspace = await self.workspace_service.get_or_404(workspace_id)
        await self.workspace_service.ensure_can_manage(workspace_id, current_user)

        content_type = validate_avatar_image(data, declared_content_type)
        file_id = _avatar_file_id("workspace", workspace.workspace_id)
        ref = await self.storage.put_object(file_id, data, content_type, scope=AVATAR_SCOPE)
        avatar_url = _avatar_url("workspaces", workspace.workspace_id)

        workspace.avatar_url = avatar_url
        self.session.add(workspace)
        await self.session.flush()
        return {
            "avatar_url": avatar_url,
            "content_type": content_type,
            "size_bytes": len(data),
            "storage_bucket": ref.bucket,
            "object_key": ref.object_key,
        }

    async def upload_bot_avatar(
        self,
        bot_id: str,
        current_user: User,
        data: bytes,
        declared_content_type: str | None,
    ) -> dict:
        bot = await self.bot_service.get_or_404(bot_id)
        if not can_manage_bot(bot, current_user):
            raise ForbiddenError("无权修改该 Bot 的头像")

        content_type = validate_avatar_image(data, declared_content_type)
        file_id = _avatar_file_id("bot", bot.bot_id)
        ref = await self.storage.put_object(file_id, data, content_type, scope=AVATAR_SCOPE)
        avatar_url = _avatar_url("bots", bot.bot_id)

        bot.avatar_url = avatar_url
        self.session.add(bot)
        await self.session.flush()
        return {
            "avatar_url": avatar_url,
            "content_type": content_type,
            "size_bytes": len(data),
            "storage_bucket": ref.bucket,
            "object_key": ref.object_key,
        }

    async def get_user_avatar(self, user_id: str) -> StorageObject:
        user = await self.user_repo.get_by_id(user_id)
        expected = _route_path("users", user_id)
        if not user or not (user.avatar_url or "").startswith(expected):
            raise NotFoundError("avatar not found")
        return await self._get_avatar("user", user_id)

    async def get_bot_avatar(self, bot_id: str) -> StorageObject:
        bot = await self.session.get(BotAccount, bot_id)
        expected = _route_path("bots", bot_id)
        if not bot or not (bot.avatar_url or "").startswith(expected):
            raise NotFoundError("avatar not found")
        return await self._get_avatar("bot", bot_id)

    async def get_workspace_avatar(self, workspace_id: str) -> StorageObject:
        workspace = await self.session.get(Workspace, workspace_id)
        expected = _route_path("workspaces", workspace_id)
        if not workspace or not (workspace.avatar_url or "").startswith(expected):
            raise NotFoundError("avatar not found")
        return await self._get_avatar("workspace", workspace_id)

    async def delete_user_avatar(self, user: User) -> dict:
        target = await self.user_repo.get_by_id(user.user_id) or user
        await self._delete_managed_avatar_if_current(
            kind="user",
            kind_plural="users",
            entity_id=target.user_id,
            avatar_url=target.avatar_url,
        )
        await self.user_repo.update(target, avatar_url=None)
        return {"avatar_url": None}

    async def delete_bot_avatar(self, bot_id: str, current_user: User) -> dict:
        bot = await self.bot_service.get_or_404(bot_id)
        if not can_manage_bot(bot, current_user):
            raise ForbiddenError("无权修改该 Bot 的头像")
        await self._delete_managed_avatar_if_current(
            kind="bot",
            kind_plural="bots",
            entity_id=bot.bot_id,
            avatar_url=bot.avatar_url,
        )
        bot.avatar_url = None
        self.session.add(bot)
        await self.session.flush()
        return {"avatar_url": None}

    async def delete_workspace_avatar(self, workspace_id: str, current_user: User) -> dict:
        workspace = await self.workspace_service.get_or_404(workspace_id)
        await self.workspace_service.ensure_can_manage(workspace_id, current_user)
        await self._delete_managed_avatar_if_current(
            kind="workspace",
            kind_plural="workspaces",
            entity_id=workspace.workspace_id,
            avatar_url=workspace.avatar_url,
        )
        workspace.avatar_url = None
        self.session.add(workspace)
        await self.session.flush()
        return {"avatar_url": None}

    async def _get_avatar(self, kind: str, entity_id: str) -> StorageObject:
        try:
            return await self.storage.get_object(
                _avatar_file_id(kind, entity_id),
                scope=AVATAR_SCOPE,
            )
        except StorageObjectNotFoundError:
            raise NotFoundError("avatar not found")

    async def _delete_managed_avatar_if_current(
        self,
        *,
        kind: str,
        kind_plural: str,
        entity_id: str,
        avatar_url: str | None,
    ) -> None:
        expected = _route_path(kind_plural, entity_id)
        if not (avatar_url or "").startswith(expected):
            return
        try:
            await self.storage.delete_object(_avatar_file_id(kind, entity_id), scope=AVATAR_SCOPE)
        except StorageObjectNotFoundError:
            return
