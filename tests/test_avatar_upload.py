"""Avatar upload routes backed by object storage."""
from __future__ import annotations

import base64

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import BotAccount, Workspace
from app.services.storage.base import (
    PresignedUpload,
    StorageObject,
    StorageObjectHead,
    StorageObjectNotFoundError,
    StorageObjectRef,
    StorageProvider,
)

TEST_USER_ID = "a0000000-0000-0000-0000-000000000099"
PNG_1X1 = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII="
)


class FakeStorage(StorageProvider):
    def __init__(self) -> None:
        self.objects: dict[tuple[str, str], tuple[bytes, str]] = {}

    def build_object_key(self, file_id: str, *, scope: str = "uploads") -> str:
        return f"{scope}/{file_id}/source"

    def resolve_file_id(self, file_id: str, *, scope: str = "uploads") -> StorageObjectRef:
        return StorageObjectRef(
            file_id=file_id,
            bucket="avatar-test",
            object_key=self.build_object_key(file_id, scope=scope),
        )

    async def ensure_bucket_exists(self) -> None:
        return None

    def create_presigned_put_url(
        self,
        file_id: str,
        *,
        content_type: str,
        filename: str | None = None,
        expires_in: int | None = None,
        scope: str = "uploads",
    ) -> PresignedUpload:
        ref = self.resolve_file_id(file_id, scope=scope)
        return PresignedUpload(
            file_id=ref.file_id,
            bucket=ref.bucket,
            object_key=ref.object_key,
            upload_url="http://storage.test/upload",
            headers={"Content-Type": content_type},
            expires_in=expires_in or 900,
        )

    async def head_object(self, file_id: str, *, scope: str = "uploads") -> StorageObjectHead:
        if (scope, file_id) not in self.objects:
            raise StorageObjectNotFoundError("missing")
        data, content_type = self.objects[(scope, file_id)]
        ref = self.resolve_file_id(file_id, scope=scope)
        return StorageObjectHead(
            file_id=file_id,
            bucket=ref.bucket,
            object_key=ref.object_key,
            content_length=len(data),
            content_type=content_type,
        )

    async def get_object(self, file_id: str, *, scope: str = "uploads") -> StorageObject:
        data, content_type = self.objects.get((scope, file_id), (None, None))
        if data is None or content_type is None:
            raise StorageObjectNotFoundError("missing")
        head = await self.head_object(file_id, scope=scope)
        return StorageObject(head=head, body=data)

    async def put_metadata_if_needed(
        self,
        file_id: str,
        metadata: dict[str, str],
        *,
        scope: str = "uploads",
    ) -> None:
        return None

    async def put_object(
        self,
        file_id: str,
        data: bytes,
        content_type: str,
        *,
        scope: str = "uploads",
    ) -> StorageObjectRef:
        self.objects[(scope, file_id)] = (data, content_type)
        return self.resolve_file_id(file_id, scope=scope)

    def create_presigned_get_url(
        self,
        file_id: str,
        *,
        expires_in: int | None = None,
        scope: str = "uploads",
    ) -> str:
        return f"http://storage.test/{scope}/{file_id}"


@pytest.fixture
def fake_avatar_storage(monkeypatch: pytest.MonkeyPatch) -> FakeStorage:
    from app.api.v1.avatars import routes as avatar_routes

    storage = FakeStorage()
    monkeypatch.setattr(avatar_routes, "is_storage_enabled", lambda: True)
    monkeypatch.setattr(avatar_routes, "get_storage_service", lambda: storage)
    return storage


@pytest.mark.asyncio
async def test_user_avatar_upload_stores_in_storage_and_serves_stable_url(
    client: AsyncClient,
    fake_avatar_storage: FakeStorage,
) -> None:
    resp = await client.post(
        "/api/v1/avatars/users/me",
        content=PNG_1X1,
        headers={"Content-Type": "image/png"},
    )

    assert resp.status_code == 200
    avatar_url = resp.json()["data"]["avatar_url"]
    assert avatar_url.startswith(f"/api/v1/avatars/users/{TEST_USER_ID}?v=")
    assert ("avatars", f"avatar-user-{TEST_USER_ID}") in fake_avatar_storage.objects

    image_resp = await client.get(avatar_url)
    assert image_resp.status_code == 200
    assert image_resp.headers["content-type"].startswith("image/png")
    assert image_resp.content == PNG_1X1


@pytest.mark.asyncio
async def test_bot_avatar_upload_requires_owner_and_serves_image(
    client: AsyncClient,
    db_session: AsyncSession,
    fake_avatar_storage: FakeStorage,
) -> None:
    bot = BotAccount(
        bot_id="avatar-bot-owned-001",
        username="avatar_bot_owned",
        display_name="Avatar Bot",
        created_by=TEST_USER_ID,
        status="online",
    )
    db_session.add(bot)
    await db_session.flush()

    resp = await client.post(
        f"/api/v1/avatars/bots/{bot.bot_id}",
        content=PNG_1X1,
        headers={"Content-Type": "image/png"},
    )

    assert resp.status_code == 200
    avatar_url = resp.json()["data"]["avatar_url"]
    assert avatar_url.startswith(f"/api/v1/avatars/bots/{bot.bot_id}?v=")
    assert ("avatars", f"avatar-bot-{bot.bot_id}") in fake_avatar_storage.objects

    image_resp = await client.get(avatar_url)
    assert image_resp.status_code == 200
    assert image_resp.content == PNG_1X1


@pytest.mark.asyncio
async def test_workspace_avatar_upload_requires_manager_and_serves_image(
    client: AsyncClient,
    db_session: AsyncSession,
    fake_avatar_storage: FakeStorage,
) -> None:
    workspace = Workspace(
        workspace_id="avatar-workspace-owned-001",
        name="Avatar Workspace",
    )
    db_session.add(workspace)
    await db_session.flush()

    resp = await client.post(
        f"/api/v1/avatars/workspaces/{workspace.workspace_id}",
        content=PNG_1X1,
        headers={"Content-Type": "image/png"},
    )

    assert resp.status_code == 200
    avatar_url = resp.json()["data"]["avatar_url"]
    assert avatar_url.startswith(f"/api/v1/avatars/workspaces/{workspace.workspace_id}?v=")
    assert ("avatars", f"avatar-workspace-{workspace.workspace_id}") in fake_avatar_storage.objects

    image_resp = await client.get(avatar_url)
    assert image_resp.status_code == 200
    assert image_resp.content == PNG_1X1


@pytest.mark.asyncio
async def test_avatar_upload_rejects_non_image(
    client: AsyncClient,
    fake_avatar_storage: FakeStorage,
) -> None:
    resp = await client.post(
        "/api/v1/avatars/users/me",
        content=b"not an image",
        headers={"Content-Type": "image/png"},
    )

    assert resp.status_code == 400
