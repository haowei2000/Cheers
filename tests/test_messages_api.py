"""Tests for test messages api."""
from __future__ import annotations

import base64
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import pytest
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.db.models import (
    AIModel,
    BotAccount,
    Channel,
    ChannelMembership,
    FileRecord,
    FileScopeLink,
    Message,
    PromptTemplate,
    User,
    Workspace,
)
from app.services.file_processor.service import FilePipelineService
from app.services.storage.base import (
    PresignedUpload,
    StorageObject,
    StorageObjectHead,
    StorageObjectRef,
    StorageProvider,
)


def _make_disabled_model(model_id: str) -> AIModel:
    return AIModel(
        model_id=model_id,
        name=f"stream-model-{model_id[-4:]}",
        provider="test",
        model_name="test",
        base_url="http://localhost",
        is_enabled=False,
        is_builtin=False,
        config={},
    )


def _make_template(template_id: str) -> PromptTemplate:
    return PromptTemplate(
        template_id=template_id,
        name=f"stream-tpl-{template_id[-4:]}",
        system_prompt="test",
        user_template="{{message}}",
        variables=["message"],
        is_builtin=False,
    )


@dataclass
class FakeStorageProvider(StorageProvider):
    bucket: str = "agentnexus-files"
    objects: dict[str, tuple[bytes, str, dict[str, str]]] = field(default_factory=dict)
    metadata_sidecars: dict[str, dict[str, str]] = field(default_factory=dict)

    def build_object_key(self, file_id: str, *, scope: str = "uploads") -> str:
        return f"{scope}/{file_id[:2]}/{file_id[2:4]}/{file_id}/source"

    def resolve_file_id(self, file_id: str, *, scope: str = "uploads") -> StorageObjectRef:
        return StorageObjectRef(file_id=file_id, bucket=self.bucket, object_key=self.build_object_key(file_id, scope=scope))

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
            file_id=file_id,
            bucket=self.bucket,
            object_key=ref.object_key,
            upload_url=f"http://storage.test/{ref.object_key}",
            headers={
                "Content-Type": content_type,
                "x-amz-meta-file-id": file_id,
                "x-amz-meta-original-filename": filename or "",
            },
            expires_in=expires_in or 900,
        )

    async def head_object(self, file_id: str, *, scope: str = "uploads") -> StorageObjectHead:
        ref = self.resolve_file_id(file_id, scope=scope)
        body, content_type, metadata = self.objects[file_id]
        return StorageObjectHead(
            file_id=file_id,
            bucket=self.bucket,
            object_key=ref.object_key,
            content_length=len(body),
            content_type=content_type,
            metadata=metadata,
        )

    async def get_object(self, file_id: str, *, scope: str = "uploads") -> StorageObject:
        head = await self.head_object(file_id, scope=scope)
        body, _, _ = self.objects[file_id]
        return StorageObject(head=head, body=body)

    async def put_object(
        self,
        file_id: str,
        data: bytes,
        content_type: str,
        *,
        scope: str = "uploads",
    ) -> StorageObjectRef:
        self.objects[file_id] = (data, content_type, {})
        return self.resolve_file_id(file_id, scope=scope)

    def create_presigned_get_url(
        self,
        file_id: str,
        *,
        expires_in: int | None = None,
        scope: str = "uploads",
    ) -> str:
        ref = self.resolve_file_id(file_id, scope=scope)
        return f"http://storage.test/{ref.object_key}"

    async def put_metadata_if_needed(
        self,
        file_id: str,
        metadata: dict[str, str],
        *,
        scope: str = "uploads",
    ) -> None:
        self.metadata_sidecars[file_id] = metadata


@pytest.mark.asyncio
async def test_list_messages_empty(client: AsyncClient, db_session: AsyncSession) -> None:
    """Covers test list messages empty behavior."""
    ws = Workspace(workspace_id="f0000000-0000-0000-0000-000000000001", name="W")
    ch = Channel(
        channel_id="e1000000-0000-0000-0000-000000000001",
        workspace_id=ws.workspace_id,
        name="ch",
        type="public",
    )
    db_session.add(ws)
    db_session.add(ch)
    await db_session.commit()

    resp = await client.get("/api/v1/channels/e1000000-0000-0000-0000-000000000001/messages")
    assert resp.status_code == 200
    assert resp.json()["status"] == "success"
    assert resp.json()["data"] == []


@pytest.mark.asyncio
async def test_create_message_and_list(client: AsyncClient, db_session: AsyncSession) -> None:
    """Covers test create message and list behavior."""
    ws = Workspace(workspace_id="f0000000-0000-0000-0000-000000000002", name="W2")
    ch = Channel(
        channel_id="e1000000-0000-0000-0000-000000000002",
        workspace_id=ws.workspace_id,
        name="ch2",
        type="public",
    )
    db_session.add(ws)
    db_session.add(ch)
    await db_session.commit()

    resp = await client.post(
        "/api/v1/channels/e1000000-0000-0000-0000-000000000002/messages",
        json={
            "content": "hello",
            "sender_id": "a0000000-0000-0000-0000-000000000001",
            "sender_type": "user",
        },
    )
    assert resp.status_code == 200
    data = resp.json()["data"]
    assert data["content"] == "hello"
    assert "msg_id" in data
    assert "created_at" in data

    resp2 = await client.get("/api/v1/channels/e1000000-0000-0000-0000-000000000002/messages")
    assert resp2.status_code == 200
    assert len(resp2.json()["data"]) == 1
    assert resp2.json()["data"][0]["content"] == "hello"


@pytest.mark.asyncio
async def test_delete_message_soft_deletes_and_clears_payload(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Deleting a message keeps a tombstone and removes sensitive payload."""
    user_id = "a0000000-0000-0000-0000-000000000099"
    ws = Workspace(workspace_id="f1000000-0000-0000-0000-000000000203", name="W203")
    ch = Channel(
        channel_id="e1000000-0000-0000-0000-000000000203",
        workspace_id=ws.workspace_id,
        name="delete-message",
        type="public",
    )
    msg = Message(
        msg_id="delete-message-soft-203",
        channel_id=ch.channel_id,
        sender_id=user_id,
        sender_type="user",
        content="sensitive text",
        file_ids=["file-delete-message-203"],
        mention_bot_ids=["bot-delete-message-203"],
        mention_user_ids=["user-delete-message-203"],
        is_secret=True,
        secret_encrypted="ciphertext",
        secret_token="secret-token",
        content_data={"title": "secret"},
    )
    db_session.add_all([ws, ch, msg])
    await db_session.flush()

    resp = await client.delete(f"/api/v1/channels/{ch.channel_id}/messages/{msg.msg_id}")

    assert resp.status_code == 200
    data = resp.json()["data"]
    assert data["msg_id"] == msg.msg_id
    assert data["is_deleted"] is True
    assert data["deleted_by"] == user_id
    assert data["content"] == ""
    assert data["file_ids"] == []
    assert data["mention_bot_ids"] == []
    assert data["mention_user_ids"] == []

    row = await db_session.get(Message, msg.msg_id)
    assert row is not None
    assert row.is_deleted is True
    assert row.deleted_at is not None
    assert row.content == ""
    assert row.file_ids == []
    assert row.secret_encrypted is None
    assert row.secret_token is None


@pytest.mark.asyncio
async def test_list_messages_around_cursor(client: AsyncClient, db_session: AsyncSession) -> None:
    """Initial channel loads can request a small window around the saved cursor."""
    ws = Workspace(workspace_id="f2000000-0000-0000-0000-000000000172", name="W172")
    ch = Channel(
        channel_id="e2000000-0000-0000-0000-000000000172",
        workspace_id=ws.workspace_id,
        name="cursor-window",
        type="public",
    )
    base_time = datetime(2026, 1, 1, tzinfo=timezone.utc)
    messages = [
        Message(
            msg_id=f"cursor-message-{i:02d}",
            channel_id=ch.channel_id,
            sender_id="a0000000-0000-0000-0000-000000000099",
            sender_type="user",
            content=f"message {i}",
            created_at=base_time + timedelta(seconds=i),
        )
        for i in range(10)
    ]
    db_session.add_all([ws, ch, *messages])
    await db_session.commit()

    resp = await client.get(
        f"/api/v1/channels/{ch.channel_id}/messages",
        params={"around_id": "cursor-message-05", "limit": 5},
    )

    assert resp.status_code == 200
    payload = resp.json()
    assert [item["msg_id"] for item in payload["data"]] == [
        "cursor-message-03",
        "cursor-message-04",
        "cursor-message-05",
        "cursor-message-06",
        "cursor-message-07",
    ]
    assert payload["meta"]["anchor_found"] is True
    assert payload["meta"]["has_more_before"] is True
    assert payload["meta"]["has_more_after"] is True


@pytest.mark.asyncio
async def test_list_messages_after_cursor(client: AsyncClient, db_session: AsyncSession) -> None:
    """Anchored windows can page newer messages without loading the whole tail."""
    ws = Workspace(workspace_id="f2000000-0000-0000-0000-000000000173", name="W173")
    ch = Channel(
        channel_id="e2000000-0000-0000-0000-000000000173",
        workspace_id=ws.workspace_id,
        name="cursor-after",
        type="public",
    )
    base_time = datetime(2026, 1, 1, tzinfo=timezone.utc)
    messages = [
        Message(
            msg_id=f"after-message-{i:02d}",
            channel_id=ch.channel_id,
            sender_id="a0000000-0000-0000-0000-000000000099",
            sender_type="user",
            content=f"message {i}",
            created_at=base_time + timedelta(seconds=i),
        )
        for i in range(8)
    ]
    db_session.add_all([ws, ch, *messages])
    await db_session.commit()

    resp = await client.get(
        f"/api/v1/channels/{ch.channel_id}/messages",
        params={"after_id": "after-message-03", "limit": 3},
    )

    assert resp.status_code == 200
    payload = resp.json()
    assert [item["msg_id"] for item in payload["data"]] == [
        "after-message-04",
        "after-message-05",
        "after-message-06",
    ]
    assert payload["meta"]["has_more_after"] is True


@pytest.mark.asyncio
async def test_list_topic_messages_includes_nested_replies(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Covers test list topic messages includes nested replies behavior."""
    ws = Workspace(workspace_id="f0000000-0000-0000-0000-000000000062", name="W62")
    ch = Channel(
        channel_id="e1000000-0000-0000-0000-000000000062",
        workspace_id=ws.workspace_id,
        name="topic-page-ch",
        type="public",
    )
    other = Channel(
        channel_id="e1000000-0000-0000-0000-000000000063",
        workspace_id=ws.workspace_id,
        name="other-ch",
        type="public",
    )
    base_time = datetime(2026, 1, 1, tzinfo=timezone.utc)
    root = Message(
        msg_id="m1000000-0000-0000-0000-000000000062",
        channel_id=ch.channel_id,
        sender_id="a0000000-0000-0000-0000-000000000099",
        sender_type="user",
        content="topic root",
        msg_type="topic",
        created_at=base_time,
    )
    direct_reply = Message(
        msg_id="m1000000-0000-0000-0000-000000000063",
        channel_id=ch.channel_id,
        sender_id="a0000000-0000-0000-0000-000000000099",
        sender_type="user",
        content="direct reply",
        msg_type="reply",
        in_reply_to_msg_id=root.msg_id,
        created_at=base_time + timedelta(seconds=1),
    )
    nested_reply = Message(
        msg_id="m1000000-0000-0000-0000-000000000064",
        channel_id=ch.channel_id,
        sender_id="b1000000-0000-0000-0000-000000000062",
        sender_type="bot",
        content="nested bot reply",
        msg_type="reply",
        in_reply_to_msg_id=direct_reply.msg_id,
        created_at=base_time + timedelta(seconds=2),
    )
    unrelated = Message(
        msg_id="m1000000-0000-0000-0000-000000000065",
        channel_id=ch.channel_id,
        sender_id="a0000000-0000-0000-0000-000000000099",
        sender_type="user",
        content="unrelated",
        msg_type="normal",
        created_at=base_time + timedelta(seconds=3),
    )
    other_channel_reply = Message(
        msg_id="m1000000-0000-0000-0000-000000000066",
        channel_id=other.channel_id,
        sender_id="a0000000-0000-0000-0000-000000000099",
        sender_type="user",
        content="other channel reply",
        msg_type="reply",
        in_reply_to_msg_id=root.msg_id,
        created_at=base_time + timedelta(seconds=4),
    )
    db_session.add_all([
        ws,
        ch,
        other,
        root,
        direct_reply,
        nested_reply,
        unrelated,
        other_channel_reply,
    ])
    await db_session.commit()

    resp = await client.get(
        f"/api/v1/channels/{ch.channel_id}/messages/topics/{root.msg_id}"
    )

    assert resp.status_code == 200
    assert [item["msg_id"] for item in resp.json()["data"]] == [
        root.msg_id,
        direct_reply.msg_id,
        nested_reply.msg_id,
    ]


@pytest.mark.asyncio
async def test_dm_message_normalizes_topics_but_preserves_replies(
    monkeypatch,
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Covers test dm message normalizes topics but preserves replies behavior."""
    import app.api.v1.messages.routes as message_routes

    monkeypatch.setattr(
        message_routes,
        "_schedule_bot_pipeline_enqueue",
        lambda *args, **kwargs: None,
    )
    current_user_id = "a0000000-0000-0000-0000-000000000099"
    ws = Workspace(workspace_id="f0000000-0000-0000-0000-000000000052", name="W52")
    dm = Channel(
        channel_id="e1000000-0000-0000-0000-000000000052",
        workspace_id=ws.workspace_id,
        name="dm:test:bot",
        type="dm",
    )
    bot = BotAccount(
        bot_id="b1000000-0000-0000-0000-000000000052",
        username="dm_shape_bot",
        display_name="DM Shape Bot",
        status="online",
        binding_type="agent_bridge",
    )
    parent = Message(
        msg_id="m1000000-0000-0000-0000-000000000052",
        channel_id=dm.channel_id,
        sender_id=current_user_id,
        sender_type="user",
        content="parent",
        msg_type="normal",
    )
    db_session.add_all([
        ws,
        dm,
        bot,
        ChannelMembership(
            channel_id=dm.channel_id,
            member_id=current_user_id,
            member_type="user",
            role="member",
        ),
        ChannelMembership(
            channel_id=dm.channel_id,
            member_id=bot.bot_id,
            member_type="bot",
            role="member",
        ),
        parent,
    ])
    await db_session.commit()

    resp = await client.post(
        f"/api/v1/channels/{dm.channel_id}/messages",
        json={
            "content": "topic should be normalized",
            "sender_id": current_user_id,
            "sender_type": "user",
            "msg_type": "topic",
            "in_reply_to_msg_id": parent.msg_id,
            "content_data": {"title": "Not a Topic"},
        },
    )

    assert resp.status_code == 200
    msg_id = resp.json()["data"]["msg_id"]
    saved = await db_session.get(Message, msg_id)
    assert saved is not None
    assert saved.msg_type == "normal"
    assert saved.in_reply_to_msg_id is None
    assert saved.content_data is None
    await db_session.refresh(parent)
    assert parent.msg_type == "normal"

    reply_resp = await client.post(
        f"/api/v1/channels/{dm.channel_id}/messages",
        json={
            "content": "reply should stay linked",
            "sender_id": current_user_id,
            "sender_type": "user",
            "msg_type": "reply",
            "in_reply_to_msg_id": parent.msg_id,
        },
    )

    assert reply_resp.status_code == 200
    reply_id = reply_resp.json()["data"]["msg_id"]
    reply = await db_session.get(Message, reply_id)
    assert reply is not None
    assert reply.msg_type == "reply"
    assert reply.in_reply_to_msg_id == parent.msg_id
    assert reply.content_data == {"locale": "en"}


@pytest.mark.asyncio
async def test_create_message_survives_bot_pipeline_enqueue_failure(
    monkeypatch,
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Covers test create message survives bot pipeline enqueue failure behavior."""
    import app.api.v1.messages.routes as message_routes

    ws = Workspace(workspace_id="f0000000-0000-0000-0000-000000000035", name="W35")
    ch = Channel(
        channel_id="e1000000-0000-0000-0000-000000000035",
        workspace_id=ws.workspace_id,
        name="enqueue-failure-ch",
        type="public",
    )
    bot = BotAccount(
        bot_id="b1000000-0000-0000-0000-000000000032",
        username="enqueue_fail_bot",
        display_name="Enqueue Fail Bot",
        status="online",
    )
    db_session.add_all([
        ws,
        ch,
        bot,
        ChannelMembership(
            channel_id=ch.channel_id,
            member_id=bot.bot_id,
            member_type="bot",
            role="member",
        ),
    ])
    await db_session.commit()

    async def fail_enqueue(channel_id: str, msg_id: str) -> str:
        raise RuntimeError("queue down")

    class FailingBroker:
        async def publish_channel(self, channel_id: str, message: dict) -> None:
            raise RuntimeError("broker down")

    monkeypatch.setattr(message_routes, "enqueue_bot_pipeline_job", fail_enqueue)
    monkeypatch.setattr(message_routes, "get_realtime_broker", lambda: FailingBroker())

    resp = await client.post(
        f"/api/v1/channels/{ch.channel_id}/messages",
        json={
            "content": "@enqueue_fail_bot still saved",
            "sender_id": "ignored",
            "sender_type": "user",
        },
    )

    assert resp.status_code == 200
    data = resp.json()["data"]
    assert data["content"] == "@enqueue_fail_bot still saved"

    rows = (await db_session.execute(select(message_routes.Message))).scalars().all()
    assert any(row.msg_id == data["msg_id"] for row in rows)


@pytest.mark.asyncio
async def test_create_message_returns_before_bot_pipeline_enqueue_completes(
    monkeypatch,
    db_session: AsyncSession,
) -> None:
    """Covers test create message returns before bot pipeline enqueue completes behavior."""
    import app.api.v1.messages.routes as message_routes

    ws = Workspace(workspace_id="f0000000-0000-0000-0000-000000000033", name="W33")
    user = User(
        user_id="f0000000-0000-0000-0000-000000000133",
        username="enqueue_slow_admin",
        password_hash="x",
        role="system_admin",
    )
    ch = Channel(
        channel_id="e1000000-0000-0000-0000-000000000033",
        workspace_id=ws.workspace_id,
        name="enqueue-slow-ch",
        type="public",
    )
    bot = BotAccount(
        bot_id="b1000000-0000-0000-0000-000000000033",
        username="enqueue_slow_bot",
        display_name="Enqueue Slow Bot",
        status="online",
    )
    db_session.add_all([
        ws,
        user,
        ch,
        bot,
        ChannelMembership(
            channel_id=ch.channel_id,
            member_id=bot.bot_id,
            member_type="bot",
            role="member",
        ),
    ])
    await db_session.commit()

    class RecordingBackgroundTasks:
        def __init__(self) -> None:
            self.tasks: list[tuple[object, tuple, dict]] = []

        def add_task(self, func, *args, **kwargs) -> None:
            self.tasks.append((func, args, kwargs))

    async def slow_enqueue(channel_id: str, msg_id: str) -> str:
        raise AssertionError("enqueue must be deferred to the background task")
        return "job-slow"

    monkeypatch.setattr(message_routes, "enqueue_bot_pipeline_job", slow_enqueue)
    background_tasks = RecordingBackgroundTasks()

    data, secret_token = await message_routes._handle_send_message(
        db_session,
        channel_id=ch.channel_id,
        body=message_routes.MessageCreate(
            content="@enqueue_slow_bot returns immediately",
            sender_id="ignored",
            sender_type="user",
        ),
        current_user=user,
        background_tasks=background_tasks,
    )

    assert secret_token is None
    assert data.content == "@enqueue_slow_bot returns immediately"
    assert len(background_tasks.tasks) == 1
    func, args, kwargs = background_tasks.tasks[0]
    assert func is message_routes._enqueue_bot_pipeline_bg
    assert args == (ch.channel_id, data.msg_id)
    assert kwargs == {}


@pytest.mark.asyncio
async def test_create_message_without_bot_target_skips_bot_pipeline_enqueue(
    monkeypatch,
    db_session: AsyncSession,
) -> None:
    """Covers test create message without bot target skips bot pipeline enqueue behavior."""
    import app.api.v1.messages.routes as message_routes

    ws = Workspace(workspace_id="f0000000-0000-0000-0000-000000000034", name="W34")
    user = User(
        user_id="f0000000-0000-0000-0000-000000000134",
        username="enqueue_skip_admin",
        password_hash="x",
        role="system_admin",
    )
    ch = Channel(
        channel_id="e1000000-0000-0000-0000-000000000034",
        workspace_id=ws.workspace_id,
        name="enqueue-skip-ch",
        type="public",
    )
    db_session.add_all([ws, user, ch])
    await db_session.commit()

    scheduled: list[tuple] = []
    monkeypatch.setattr(
        message_routes,
        "_schedule_bot_pipeline_enqueue",
        lambda *args, **kwargs: scheduled.append((args, kwargs)),
    )

    data, secret_token = await message_routes._handle_send_message(
        db_session,
        channel_id=ch.channel_id,
        body=message_routes.MessageCreate(
            content="plain message without bot",
            sender_id="ignored",
            sender_type="user",
        ),
        current_user=user,
        background_tasks=None,
    )

    assert secret_token is None
    assert data.content == "plain message without bot"
    assert scheduled == []


@pytest.mark.asyncio
async def test_secret_message_content_stores_msg_id_reference(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Covers test secret message content stores msg id reference behavior."""
    ws = Workspace(workspace_id="f0000000-0000-0000-0000-000000000022", name="W22")
    ch = Channel(
        channel_id="e1000000-0000-0000-0000-000000000022",
        workspace_id=ws.workspace_id,
        name="secret-ref-ch",
        type="public",
    )
    db_session.add_all([ws, ch])
    await db_session.commit()

    resp = await client.post(
        f"/api/v1/channels/{ch.channel_id}/messages",
        json={
            "content": "@bot 这是一条加密消息",
            "sender_id": "ignored",
            "sender_type": "user",
            "is_secret": True,
        },
    )

    assert resp.status_code == 200
    data = resp.json()["data"]
    expected = f"🔒 [加密消息:{data['msg_id']}]"
    assert data["content"] == expected
    assert data["secret_token"]
    assert data["created_at"].endswith("+00:00")

    resp2 = await client.get(f"/api/v1/channels/{ch.channel_id}/messages")
    assert resp2.status_code == 200
    listed = resp2.json()["data"][0]
    assert listed["msg_id"] == data["msg_id"]
    assert listed["content"] == expected


@pytest.mark.asyncio
async def test_create_message_uses_authenticated_user_identity(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """Covers test create message uses authenticated user identity behavior."""
    ws = Workspace(workspace_id="f0000000-0000-0000-0000-000000000021", name="W21")
    ch = Channel(
        channel_id="e1000000-0000-0000-0000-000000000021",
        workspace_id=ws.workspace_id,
        name="identity-ch",
        type="public",
    )
    db_session.add_all([ws, ch])
    await db_session.commit()

    resp = await client.post(
        f"/api/v1/channels/{ch.channel_id}/messages",
        json={
            "content": "spoof attempt",
            "sender_id": "b3000000-0000-0000-0000-000000000021",
            "sender_type": "bot",
        },
    )

    assert resp.status_code == 200
    data = resp.json()["data"]
    assert data["sender_id"] == "a0000000-0000-0000-0000-000000000099"
    assert data["sender_type"] == "user"


@pytest.mark.asyncio
async def test_create_message_with_file_metadata(client: AsyncClient, db_session: AsyncSession, tmp_path, monkeypatch) -> None:
    ws = Workspace(workspace_id="f0000000-0000-0000-0000-000000000003", name="W3")
    ch = Channel(
        channel_id="e1000000-0000-0000-0000-000000000003",
        workspace_id=ws.workspace_id,
        name="ch3",
        type="public",
    )
    file_path = tmp_path / "note.txt"
    file_path.write_text("hello from local file", encoding="utf-8")
    record = FileRecord(
        file_id="file-local-0001",
        channel_id=ch.channel_id,
        uploader_id="a0000000-0000-0000-0000-000000000001",
        original_path=str(file_path),
        original_filename="note.txt",
        content_type="text/plain",
        size_bytes=file_path.stat().st_size,
        status="ready",
    )
    db_session.add_all([ws, ch, record])
    await db_session.commit()

    monkeypatch.setattr("app.services.storage.bootstrap.is_storage_enabled", lambda: False)
    monkeypatch.setattr("app.services.file_processor.service.is_storage_enabled", lambda: False)

    resp = await client.post(
        f"/api/v1/channels/{ch.channel_id}/messages",
        json={
            "content": "hello file",
            "sender_id": "a0000000-0000-0000-0000-000000000001",
            "sender_type": "user",
            "file_ids": [record.file_id],
        },
    )
    assert resp.status_code == 200
    data = resp.json()["data"]
    assert data["file_ids"] == [record.file_id]
    assert data["files"][0]["original_filename"] == "note.txt"


@pytest.mark.asyncio
async def test_forward_single_message_to_channel_links_attachments(
    client: AsyncClient,
    db_session: AsyncSession,
    tmp_path,
) -> None:
    ws = Workspace(workspace_id="f0000000-0000-0000-0000-000000000071", name="W71")
    source_ch = Channel(
        channel_id="e1000000-0000-0000-0000-000000000071",
        workspace_id=ws.workspace_id,
        name="source-forward",
        type="public",
    )
    target_ch = Channel(
        channel_id="e1000000-0000-0000-0000-000000000072",
        workspace_id=ws.workspace_id,
        name="target-forward",
        type="public",
    )
    file_path = tmp_path / "forward-note.txt"
    file_path.write_text("forward attachment", encoding="utf-8")
    record = FileRecord(
        file_id="f1000000-0000-0000-0000-000000000071",
        channel_id=source_ch.channel_id,
        uploader_id="a0000000-0000-0000-0000-000000000071",
        original_path=str(file_path),
        original_filename="forward-note.txt",
        content_type="text/plain",
        size_bytes=file_path.stat().st_size,
        status="ready",
    )
    source_msg = Message(
        msg_id="m1000000-0000-0000-0000-000000000071",
        channel_id=source_ch.channel_id,
        sender_id="a0000000-0000-0000-0000-000000000071",
        sender_type="user",
        content="source text",
        file_ids=[record.file_id],
    )
    db_session.add_all([ws, source_ch, target_ch, record, source_msg])
    await db_session.commit()

    resp = await client.post(
        f"/api/v1/channels/{target_ch.channel_id}/messages/forward",
        json={
            "source_message_ids": [source_msg.msg_id],
            "mode": "single",
        },
    )

    assert resp.status_code == 200
    created = resp.json()["data"]["messages"]
    assert len(created) == 1
    forwarded = created[0]
    assert forwarded["channel_id"] == target_ch.channel_id
    assert forwarded["sender_id"] == "a0000000-0000-0000-0000-000000000099"
    assert forwarded["msg_type"] == "normal"
    assert "转发自" in forwarded["content"]
    assert "source text" in forwarded["content"]
    assert len(forwarded["file_ids"]) == 1
    assert forwarded["file_ids"][0] == record.file_id

    linked_record = await db_session.get(FileRecord, forwarded["file_ids"][0])
    assert linked_record is not None
    assert linked_record.channel_id == source_ch.channel_id
    assert linked_record.uploader_id == record.uploader_id
    assert linked_record.original_path == record.original_path
    assert linked_record.original_filename == record.original_filename
    target_link = (
        await db_session.execute(
            select(FileScopeLink).where(
                FileScopeLink.file_id == record.file_id,
                FileScopeLink.scope_type == "channel",
                FileScopeLink.scope_id == target_ch.channel_id,
            )
        )
    ).scalar_one_or_none()
    assert target_link is not None


@pytest.mark.asyncio
async def test_forward_single_message_to_dm(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    current_user_id = "a0000000-0000-0000-0000-000000000099"
    ws = Workspace(workspace_id="f0000000-0000-0000-0000-000000000073", name="W73")
    source_ch = Channel(
        channel_id="e1000000-0000-0000-0000-000000000073",
        workspace_id=ws.workspace_id,
        name="source-to-dm",
        type="public",
    )
    dm = Channel(
        channel_id="e1000000-0000-0000-0000-000000000074",
        workspace_id=ws.workspace_id,
        name="dm:test:forward",
        type="dm",
    )
    bot = BotAccount(
        bot_id="b1000000-0000-0000-0000-000000000073",
        username="forward_dm_bot",
        display_name="Forward DM Bot",
        status="online",
    )
    source_msg = Message(
        msg_id="m1000000-0000-0000-0000-000000000073",
        channel_id=source_ch.channel_id,
        sender_id=current_user_id,
        sender_type="user",
        content="forward into dm",
    )
    db_session.add_all([
        ws,
        source_ch,
        dm,
        bot,
        ChannelMembership(channel_id=dm.channel_id, member_id=current_user_id, member_type="user"),
        ChannelMembership(channel_id=dm.channel_id, member_id=bot.bot_id, member_type="bot"),
        source_msg,
    ])
    await db_session.commit()

    resp = await client.post(
        f"/api/v1/channels/{dm.channel_id}/messages/forward",
        json={
            "source_message_ids": [source_msg.msg_id],
            "mode": "single",
        },
    )

    assert resp.status_code == 200
    forwarded = resp.json()["data"]["messages"][0]
    assert forwarded["channel_id"] == dm.channel_id
    assert forwarded["sender_id"] == current_user_id
    assert "forward into dm" in forwarded["content"]


@pytest.mark.asyncio
async def test_forward_topic_preserves_selected_order(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    ws = Workspace(workspace_id="f0000000-0000-0000-0000-000000000075", name="W75")
    source_ch = Channel(
        channel_id="e1000000-0000-0000-0000-000000000075",
        workspace_id=ws.workspace_id,
        name="topic-source",
        type="public",
    )
    target_ch = Channel(
        channel_id="e1000000-0000-0000-0000-000000000076",
        workspace_id=ws.workspace_id,
        name="topic-target",
        type="public",
    )
    first = Message(
        msg_id="m1000000-0000-0000-0000-000000000075",
        channel_id=source_ch.channel_id,
        sender_id="a0000000-0000-0000-0000-000000000075",
        sender_type="user",
        content="first selected second",
    )
    second = Message(
        msg_id="m1000000-0000-0000-0000-000000000076",
        channel_id=source_ch.channel_id,
        sender_id="a0000000-0000-0000-0000-000000000075",
        sender_type="user",
        content="second selected first",
    )
    db_session.add_all([ws, source_ch, target_ch, first, second])
    await db_session.commit()

    resp = await client.post(
        f"/api/v1/channels/{target_ch.channel_id}/messages/forward",
        json={
            "source_message_ids": [second.msg_id, first.msg_id],
            "mode": "topic",
        },
    )

    assert resp.status_code == 200
    created = resp.json()["data"]["messages"]
    assert len(created) == 3
    root, reply_one, reply_two = created
    assert root["msg_type"] == "topic"
    assert root["content_data"]["kind"] == "forward_bundle"
    assert reply_one["msg_type"] == "reply"
    assert reply_one["in_reply_to_msg_id"] == root["msg_id"]
    assert "second selected first" in reply_one["content"]
    assert reply_two["in_reply_to_msg_id"] == root["msg_id"]
    assert "first selected second" in reply_two["content"]


@pytest.mark.asyncio
async def test_forward_single_file_without_message(
    client: AsyncClient,
    db_session: AsyncSession,
    tmp_path,
) -> None:
    ws = Workspace(workspace_id="f0000000-0000-0000-0000-000000000077", name="W77")
    source_ch = Channel(
        channel_id="e1000000-0000-0000-0000-000000000077",
        workspace_id=ws.workspace_id,
        name="file-source",
        type="public",
    )
    target_ch = Channel(
        channel_id="e1000000-0000-0000-0000-000000000078",
        workspace_id=ws.workspace_id,
        name="file-target",
        type="public",
    )
    file_path = tmp_path / "only-file.txt"
    file_path.write_text("file only", encoding="utf-8")
    record = FileRecord(
        file_id="f1000000-0000-0000-0000-000000000077",
        channel_id=source_ch.channel_id,
        uploader_id="a0000000-0000-0000-0000-000000000077",
        original_path=str(file_path),
        original_filename="only-file.txt",
        content_type="text/plain",
        size_bytes=file_path.stat().st_size,
        status="ready",
    )
    db_session.add_all([ws, source_ch, target_ch, record])
    await db_session.commit()

    resp = await client.post(
        f"/api/v1/channels/{target_ch.channel_id}/messages/forward",
        json={
            "source_file_ids": [record.file_id],
            "mode": "single",
        },
    )

    assert resp.status_code == 200
    forwarded = resp.json()["data"]["messages"][0]
    assert forwarded["content"] == "转发文件：only-file.txt"
    assert len(forwarded["file_ids"]) == 1
    assert forwarded["file_ids"][0] == record.file_id
    linked_record = await db_session.get(FileRecord, forwarded["file_ids"][0])
    assert linked_record is not None
    assert linked_record.channel_id == source_ch.channel_id
    assert linked_record.original_path == record.original_path
    target_link = (
        await db_session.execute(
            select(FileScopeLink).where(
                FileScopeLink.file_id == record.file_id,
                FileScopeLink.scope_type == "channel",
                FileScopeLink.scope_id == target_ch.channel_id,
            )
        )
    ).scalar_one_or_none()
    assert target_link is not None


@pytest.mark.asyncio
async def test_forward_file_to_personal_space_deep_copies_attachment(
    client: AsyncClient,
    db_session: AsyncSession,
    tmp_path,
) -> None:
    current_user_id = "a0000000-0000-0000-0000-000000000099"
    team_ws = Workspace(workspace_id="f0000000-0000-0000-0000-000000000280", name="W280")
    personal_ws = Workspace(
        workspace_id="f0000000-0000-0000-0000-000000000281",
        name="Personal",
        kind="personal",
    )
    source_ch = Channel(
        channel_id="e1000000-0000-0000-0000-000000000280",
        workspace_id=team_ws.workspace_id,
        name="file-source-team",
        type="public",
    )
    target_dm = Channel(
        channel_id="e1000000-0000-0000-0000-000000000281",
        workspace_id=personal_ws.workspace_id,
        name="dm:test:personal-file-copy",
        type="dm",
    )
    bot = BotAccount(
        bot_id="b1000000-0000-0000-0000-000000000281",
        username="personal_file_bot",
        display_name="Personal File Bot",
        status="online",
    )
    file_path = tmp_path / "source-copy.txt"
    file_path.write_text("deep copy body", encoding="utf-8")
    record = FileRecord(
        file_id="f1000000-0000-0000-0000-000000000280",
        channel_id=source_ch.channel_id,
        workspace_id=team_ws.workspace_id,
        uploader_id="a0000000-0000-0000-0000-000000000280",
        original_path=str(file_path),
        original_filename="source-copy.txt",
        content_type="text/plain",
        size_bytes=file_path.stat().st_size,
        status="ready",
    )
    db_session.add_all([team_ws, personal_ws, bot])
    await db_session.flush()
    db_session.add_all([source_ch, target_dm])
    await db_session.flush()
    db_session.add_all([
        ChannelMembership(channel_id=target_dm.channel_id, member_id=current_user_id, member_type="user"),
        ChannelMembership(channel_id=target_dm.channel_id, member_id=bot.bot_id, member_type="bot"),
    ])
    await db_session.flush()
    db_session.add(record)
    await db_session.flush()
    db_session.add(
        FileScopeLink(
            file_id=record.file_id,
            scope_type="channel",
            scope_id=source_ch.channel_id,
            workspace_id=team_ws.workspace_id,
            created_by=record.uploader_id,
        ),
    )
    await db_session.commit()

    resp = await client.post(
        f"/api/v1/channels/{target_dm.channel_id}/messages/forward",
        json={
            "source_file_ids": [record.file_id],
            "mode": "single",
        },
    )

    assert resp.status_code == 200
    forwarded = resp.json()["data"]["messages"][0]
    assert forwarded["file_ids"] != [record.file_id]
    copied_file_id = forwarded["file_ids"][0]
    copied = await db_session.get(FileRecord, copied_file_id)
    assert copied is not None
    assert copied.workspace_id == personal_ws.workspace_id
    assert copied.channel_id == target_dm.channel_id
    assert copied.uploader_id == current_user_id
    assert copied.original_filename == record.original_filename
    assert copied.original_path != record.original_path
    assert Path(copied.original_path).read_text(encoding="utf-8") == "deep copy body"

    links = (
        await db_session.execute(
            select(FileScopeLink).where(FileScopeLink.file_id == copied_file_id)
        )
    ).scalars().all()
    assert {(link.scope_type, link.scope_id) for link in links} == {
        ("personal", current_user_id),
        ("dm", target_dm.channel_id),
    }

    library_resp = await client.get("/api/v1/files/library")
    assert library_resp.status_code == 200
    library_ids = {item["file_id"] for item in library_resp.json()["data"]}
    assert copied_file_id in library_ids
    assert record.file_id not in library_ids


@pytest.mark.asyncio
async def test_forward_secret_message_is_rejected(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    ws = Workspace(workspace_id="f0000000-0000-0000-0000-000000000079", name="W79")
    source_ch = Channel(
        channel_id="e1000000-0000-0000-0000-000000000079",
        workspace_id=ws.workspace_id,
        name="secret-source",
        type="public",
    )
    target_ch = Channel(
        channel_id="e1000000-0000-0000-0000-000000000080",
        workspace_id=ws.workspace_id,
        name="secret-target",
        type="public",
    )
    secret_msg = Message(
        msg_id="m1000000-0000-0000-0000-000000000079",
        channel_id=source_ch.channel_id,
        sender_id="a0000000-0000-0000-0000-000000000079",
        sender_type="user",
        content="secret",
        is_secret=True,
    )
    db_session.add_all([ws, source_ch, target_ch, secret_msg])
    await db_session.commit()

    resp = await client.post(
        f"/api/v1/channels/{target_ch.channel_id}/messages/forward",
        json={
            "source_message_ids": [secret_msg.msg_id],
            "mode": "single",
        },
    )

    assert resp.status_code == 400


@pytest.mark.asyncio
async def test_file_library_returns_only_personal_space_personal_links(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    current_user_id = "a0000000-0000-0000-0000-000000000099"
    personal_ws = Workspace(
        workspace_id="f0000000-0000-0000-0000-000000000290",
        name="Personal",
        kind="personal",
    )
    team_ws = Workspace(workspace_id="f0000000-0000-0000-0000-000000000291", name="W291")
    ch = Channel(
        channel_id="e1000000-0000-0000-0000-000000000290",
        workspace_id=team_ws.workspace_id,
        name="library-channel",
        type="public",
    )
    personal_file = FileRecord(
        file_id="f1000000-0000-0000-0000-000000000290",
        channel_id=None,
        workspace_id=personal_ws.workspace_id,
        uploader_id=current_user_id,
        original_path="/tmp/personal-library.txt",
        original_filename="personal-library.txt",
        content_type="text/plain",
        size_bytes=10,
        status="ready",
    )
    channel_file = FileRecord(
        file_id="f1000000-0000-0000-0000-000000000291",
        channel_id=ch.channel_id,
        workspace_id=team_ws.workspace_id,
        uploader_id="a0000000-0000-0000-0000-000000000291",
        original_path="/tmp/channel-library.txt",
        original_filename="channel-library.txt",
        content_type="text/plain",
        size_bytes=20,
        status="ready",
    )
    team_personal_link_file = FileRecord(
        file_id="f1000000-0000-0000-0000-000000000292",
        channel_id=ch.channel_id,
        workspace_id=team_ws.workspace_id,
        uploader_id=current_user_id,
        original_path="/tmp/team-upload.txt",
        original_filename="team-upload.txt",
        content_type="text/plain",
        size_bytes=30,
        status="ready",
    )
    db_session.add_all([personal_ws, team_ws])
    await db_session.flush()
    db_session.add(ch)
    await db_session.flush()
    db_session.add(
        ChannelMembership(
            channel_id=ch.channel_id,
            member_id=current_user_id,
            member_type="user",
        ),
    )
    await db_session.flush()
    db_session.add_all([
        personal_file,
        channel_file,
        team_personal_link_file,
    ])
    await db_session.flush()
    db_session.add_all([
        FileScopeLink(
            file_id=personal_file.file_id,
            scope_type="personal",
            scope_id=current_user_id,
            workspace_id=personal_ws.workspace_id,
            created_by=current_user_id,
        ),
        FileScopeLink(
            file_id=channel_file.file_id,
            scope_type="channel",
            scope_id=ch.channel_id,
            workspace_id=team_ws.workspace_id,
            created_by=current_user_id,
        ),
        FileScopeLink(
            file_id=team_personal_link_file.file_id,
            scope_type="personal",
            scope_id=current_user_id,
            workspace_id=team_ws.workspace_id,
            created_by=current_user_id,
        ),
    ])
    await db_session.commit()

    resp = await client.get("/api/v1/files/library")

    assert resp.status_code == 200
    by_id = {item["file_id"]: item for item in resp.json()["data"]}
    assert by_id[personal_file.file_id]["scope_type"] == "personal"
    assert by_id[personal_file.file_id]["channel_id"] is None
    assert channel_file.file_id not in by_id
    assert team_personal_link_file.file_id not in by_id


@pytest.mark.asyncio
async def test_delete_personal_file_removes_unreferenced_record(
    client: AsyncClient,
    db_session: AsyncSession,
    tmp_path,
) -> None:
    current_user_id = "a0000000-0000-0000-0000-000000000099"
    ws = Workspace(
        workspace_id="f0000000-0000-0000-0000-000000000294",
        name="Personal",
        kind="personal",
    )
    file_path = tmp_path / "private-delete.txt"
    file_path.write_text("private", encoding="utf-8")
    record = FileRecord(
        file_id="f1000000-0000-0000-0000-000000000294",
        channel_id=None,
        workspace_id=ws.workspace_id,
        uploader_id=current_user_id,
        original_path=str(file_path),
        original_filename="private-delete.txt",
        content_type="text/plain",
        size_bytes=file_path.stat().st_size,
        status="ready",
    )
    db_session.add(ws)
    await db_session.flush()
    db_session.add(record)
    await db_session.flush()
    db_session.add(
        FileScopeLink(
            file_id=record.file_id,
            scope_type="personal",
            scope_id=current_user_id,
            workspace_id=ws.workspace_id,
            created_by=current_user_id,
        ),
    )
    await db_session.commit()

    resp = await client.delete(f"/api/v1/files/{record.file_id}")

    assert resp.status_code == 200
    data = resp.json()["data"]
    assert data["deleted"] is True
    assert data["unlinked"] is True
    assert not file_path.exists()
    result = await db_session.execute(
        select(FileRecord).where(FileRecord.file_id == record.file_id)
    )
    assert result.scalar_one_or_none() is None


@pytest.mark.asyncio
async def test_delete_personal_file_hides_channel_message_attachment(
    client: AsyncClient,
    db_session: AsyncSession,
    tmp_path,
) -> None:
    current_user_id = "a0000000-0000-0000-0000-000000000099"
    ws = Workspace(
        workspace_id="f0000000-0000-0000-0000-000000000295",
        name="Personal",
        kind="personal",
    )
    ch = Channel(
        channel_id="e1000000-0000-0000-0000-000000000295",
        workspace_id=ws.workspace_id,
        name="message-attachment-channel",
        type="public",
    )
    file_path = tmp_path / "channel-attachment.txt"
    file_path.write_text("channel attachment", encoding="utf-8")
    record = FileRecord(
        file_id="f1000000-0000-0000-0000-000000000295",
        channel_id=ch.channel_id,
        workspace_id=ws.workspace_id,
        uploader_id=current_user_id,
        original_path=str(file_path),
        original_filename="channel-attachment.txt",
        content_type="text/plain",
        size_bytes=file_path.stat().st_size,
        status="ready",
    )
    msg = Message(
        msg_id="m1000000-0000-0000-0000-000000000295",
        channel_id=ch.channel_id,
        sender_id=current_user_id,
        sender_type="user",
        content="with attachment",
        file_ids=[record.file_id],
    )
    db_session.add(ws)
    await db_session.flush()
    db_session.add(ch)
    await db_session.flush()
    db_session.add(
        ChannelMembership(
            channel_id=ch.channel_id,
            member_id=current_user_id,
            member_type="user",
        ),
    )
    await db_session.flush()
    db_session.add_all([
        record,
        msg,
    ])
    await db_session.flush()
    db_session.add_all([
        FileScopeLink(
            file_id=record.file_id,
            scope_type="personal",
            scope_id=current_user_id,
            workspace_id=ws.workspace_id,
            created_by=current_user_id,
        ),
        FileScopeLink(
            file_id=record.file_id,
            scope_type="channel",
            scope_id=ch.channel_id,
            workspace_id=ws.workspace_id,
            created_by=current_user_id,
        ),
    ])
    await db_session.commit()

    resp = await client.delete(f"/api/v1/files/{record.file_id}")

    assert resp.status_code == 200
    data = resp.json()["data"]
    assert data["deleted"] is False
    assert data["unlinked"] is True
    assert file_path.exists()
    assert await db_session.get(FileRecord, record.file_id) is not None

    links = (
        await db_session.execute(
            select(FileScopeLink).where(FileScopeLink.file_id == record.file_id)
        )
    ).scalars().all()
    assert {link.scope_type for link in links} == {"channel", "personal_hidden"}

    library_resp = await client.get("/api/v1/files/library")
    assert library_resp.status_code == 200
    assert record.file_id not in {item["file_id"] for item in library_resp.json()["data"]}

    channel_resp = await client.get(f"/api/v1/files/by-channel/{ch.channel_id}")
    assert channel_resp.status_code == 200
    assert record.file_id in {item["file_id"] for item in channel_resp.json()["data"]}


@pytest.mark.asyncio
async def test_file_preview_content_returns_local_markdown(
    client: AsyncClient,
    db_session: AsyncSession,
    tmp_path,
) -> None:
    ws = Workspace(workspace_id="f0000000-0000-0000-0000-000000000030", name="W30")
    ch = Channel(
        channel_id="e1000000-0000-0000-0000-000000000030",
        workspace_id=ws.workspace_id,
        name="preview-ch",
        type="public",
    )
    file_path = tmp_path / "preview.md"
    file_path.write_text("# Preview\n\nhello preview", encoding="utf-8")
    record = FileRecord(
        file_id="file-preview-md1",
        channel_id=ch.channel_id,
        uploader_id="a0000000-0000-0000-0000-000000000001",
        original_path=str(file_path),
        original_filename="preview.md",
        content_type="text/markdown",
        size_bytes=file_path.stat().st_size,
        status="ready",
    )
    db_session.add_all([ws, ch, record])
    await db_session.commit()

    resp = await client.get(f"/api/v1/files/{record.file_id}/content")

    assert resp.status_code == 200
    data = resp.json()["data"]
    assert data["preview_type"] == "markdown"
    assert "hello preview" in data["content"]


@pytest.mark.asyncio
async def test_file_preview_content_parses_local_html(
    client: AsyncClient,
    db_session: AsyncSession,
    tmp_path,
) -> None:
    ws = Workspace(workspace_id="f0000000-0000-0000-0000-000000000091", name="W91")
    ch = Channel(
        channel_id="e1000000-0000-0000-0000-000000000091",
        workspace_id=ws.workspace_id,
        name="preview-html-ch",
        type="public",
    )
    file_path = tmp_path / "preview.html"
    file_path.write_text(
        "<!doctype html><html><head><style>.x{color:red}</style></head>"
        "<body><h1>HTML 预览</h1><p>Hello html preview</p>"
        "<script>alert('skip me')</script></body></html>",
        encoding="utf-8",
    )
    record = FileRecord(
        file_id="file-preview-html",
        channel_id=ch.channel_id,
        uploader_id="a0000000-0000-0000-0000-000000000001",
        original_path=str(file_path),
        original_filename="preview.html",
        content_type="text/html",
        size_bytes=file_path.stat().st_size,
        status="ready",
    )
    db_session.add_all([ws, ch, record])
    await db_session.commit()

    resp = await client.get(f"/api/v1/files/{record.file_id}/content")

    assert resp.status_code == 200
    data = resp.json()["data"]
    assert data["preview_type"] == "html"
    assert "Hello html preview" in data["content"]
    assert "skip me" not in data["content"]


@pytest.mark.asyncio
async def test_file_preview_handles_html_with_generic_content_type(
    client: AsyncClient,
    db_session: AsyncSession,
    tmp_path,
) -> None:
    ws = Workspace(workspace_id="f0000000-0000-0000-0000-000000000092", name="W92")
    ch = Channel(
        channel_id="e1000000-0000-0000-0000-000000000092",
        workspace_id=ws.workspace_id,
        name="preview-html-generic-ch",
        type="public",
    )
    file_path = tmp_path / "report.html"
    file_path.write_text(
        "<!doctype html><html><body><h1>HTML report</h1></body></html>",
        encoding="utf-8",
    )
    record = FileRecord(
        file_id="file-preview-html-generic",
        channel_id=ch.channel_id,
        uploader_id="a0000000-0000-0000-0000-000000000001",
        original_path=str(file_path),
        original_filename="report.html",
        content_type="application/octet-stream",
        size_bytes=file_path.stat().st_size,
        status="ready",
    )
    db_session.add_all([ws, ch, record])
    await db_session.commit()

    preview_resp = await client.get(f"/api/v1/files/{record.file_id}/preview")
    assert preview_resp.status_code == 200
    assert preview_resp.headers["content-type"].startswith("text/html")
    assert preview_resp.headers["content-disposition"].startswith("inline;")
    assert "HTML report" in preview_resp.text

    content_resp = await client.get(f"/api/v1/files/{record.file_id}/content")
    assert content_resp.status_code == 200
    data = content_resp.json()["data"]
    assert data["content_type"] == "text/html"
    assert data["preview_type"] == "html"
    assert "HTML report" in data["content"]


@pytest.mark.asyncio
async def test_file_kkfileview_url_uses_signed_public_source(
    client: AsyncClient,
    db_session: AsyncSession,
    tmp_path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(settings, "public_base_url", "agentnexus.example.com")
    monkeypatch.setattr(settings, "kkfileview_enabled", True)
    monkeypatch.setattr(settings, "kkfileview_base_url", "https://agentnexus.example.com/preview/")
    monkeypatch.setattr(settings, "kkfileview_token_ttl_seconds", 600)
    monkeypatch.setattr(settings, "jwt_secret_key", "x" * 64)

    ws = Workspace(workspace_id="f0000000-0000-0000-0000-000000000093", name="W93")
    ch = Channel(
        channel_id="e1000000-0000-0000-0000-000000000093",
        workspace_id=ws.workspace_id,
        name="preview-kk-ch",
        type="public",
    )
    file_path = tmp_path / "deck.pptx"
    file_path.write_bytes(b"pptx bytes")
    record = FileRecord(
        file_id="file-preview-kk-pptx",
        channel_id=ch.channel_id,
        uploader_id="a0000000-0000-0000-0000-000000000001",
        original_path=str(file_path),
        original_filename="deck.pptx",
        content_type="application/octet-stream",
        size_bytes=file_path.stat().st_size,
        status="ready",
    )
    db_session.add_all([ws, ch, record])
    await db_session.commit()

    resp = await client.get(f"/api/v1/files/{record.file_id}/kkfileview")
    assert resp.status_code == 200
    data = resp.json()["data"]
    assert data["enabled"] is True

    viewer = urlparse(data["viewer_url"])
    assert viewer.scheme == "https"
    assert viewer.netloc == "agentnexus.example.com"
    assert viewer.path == "/preview/onlinePreview"

    encoded_source = parse_qs(viewer.query)["url"][0]
    source_url = base64.b64decode(encoded_source).decode("utf-8")
    source = urlparse(source_url)
    assert source.scheme == "https"
    assert source.netloc == "agentnexus.example.com"
    assert source.path == f"/api/v1/files/{record.file_id}/public-preview"
    assert parse_qs(source.query)["fullfilename"] == ["deck.pptx"]

    source_resp = await client.get(f"{source.path}?{source.query}")
    assert source_resp.status_code == 200
    assert source_resp.content == b"pptx bytes"
    assert source_resp.headers["content-disposition"].startswith("inline;")

    xlsx_path = tmp_path / "sheet.xlsx"
    xlsx_path.write_bytes(b"xlsx bytes")
    xlsx_record = FileRecord(
        file_id="file-preview-kk-xlsx",
        channel_id=ch.channel_id,
        uploader_id="a0000000-0000-0000-0000-000000000001",
        original_path=str(xlsx_path),
        original_filename="sheet.xlsx",
        content_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        size_bytes=xlsx_path.stat().st_size,
        status="ready",
    )
    db_session.add(xlsx_record)
    await db_session.commit()

    xlsx_resp = await client.get(f"/api/v1/files/{xlsx_record.file_id}/kkfileview")
    assert xlsx_resp.status_code == 200
    xlsx_data = xlsx_resp.json()["data"]
    assert xlsx_data["enabled"] is True
    xlsx_source = base64.b64decode(parse_qs(urlparse(xlsx_data["viewer_url"]).query)["url"][0]).decode("utf-8")
    assert "fullfilename=sheet.xlsx" in xlsx_source


@pytest.mark.asyncio
async def test_file_preview_content_parses_local_xlsx(
    client: AsyncClient,
    db_session: AsyncSession,
    tmp_path,
) -> None:
    from openpyxl import Workbook

    ws = Workspace(workspace_id="f0000000-0000-0000-0000-000000000031", name="W31")
    ch = Channel(
        channel_id="e1000000-0000-0000-0000-000000000031",
        workspace_id=ws.workspace_id,
        name="preview-xlsx-ch",
        type="public",
    )
    file_path = tmp_path / "report.xlsx"
    workbook = Workbook()
    sheet = workbook.active
    sheet.title = "Summary"
    sheet.append(["Name", "Count"])
    sheet.append(["Alpha", 3])
    workbook.save(file_path)
    workbook.close()
    record = FileRecord(
        file_id="file-preview-xlsx",
        channel_id=ch.channel_id,
        uploader_id="a0000000-0000-0000-0000-000000000001",
        original_path=str(file_path),
        original_filename="report.xlsx",
        content_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        size_bytes=file_path.stat().st_size,
        status="ready",
    )
    db_session.add_all([ws, ch, record])
    await db_session.commit()

    resp = await client.get(f"/api/v1/files/{record.file_id}/content")

    assert resp.status_code == 200
    data = resp.json()["data"]
    assert data["preview_type"] == "markdown"
    assert "## Summary" in data["content"]
    assert "| Alpha | 3 |" in data["content"]


@pytest.mark.asyncio
async def test_create_presigned_upload_returns_file_record(
    client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    ws = Workspace(workspace_id="f0000000-0000-0000-0000-000000000011", name="W11")
    ch = Channel(
        channel_id="e1000000-0000-0000-0000-000000000011",
        workspace_id=ws.workspace_id,
        name="presign-ch",
        type="public",
    )
    db_session.add_all([ws, ch])
    await db_session.commit()

    fake_storage = FakeStorageProvider()
    monkeypatch.setattr("app.services.storage.bootstrap.is_storage_enabled", lambda: True)
    monkeypatch.setattr("app.services.storage.bootstrap.get_storage_service", lambda: fake_storage)
    monkeypatch.setattr("app.services.file_processor.service.is_storage_enabled", lambda: True)
    monkeypatch.setattr("app.services.file_processor.service.get_storage_service", lambda: fake_storage)

    resp = await client.post(
        "/api/v1/files/presign",
        json={
            "channel_id": ch.channel_id,
            "uploader_id": "a0000000-0000-0000-0000-000000000011",
            "filename": "report.txt",
            "content_type": "text/plain",
            "size": 128,
        },
    )
    assert resp.status_code == 200

    data = resp.json()["data"]
    assert data["file_id"]
    assert data["upload_url"].startswith("http://storage.test/uploads/")
    assert data["headers"]["Content-Type"] == "text/plain"
    assert fake_storage.metadata_sidecars[data["file_id"]]["channel_id"] == ch.channel_id

    result = await db_session.execute(select(FileRecord).where(FileRecord.file_id == data["file_id"]))
    record = result.scalar_one()
    assert record.channel_id == ch.channel_id
    assert record.original_filename == "report.txt"
    assert record.status == "pending_upload"
    assert record.object_key == data["object_key"]

    html_resp = await client.post(
        "/api/v1/files/presign",
        json={
            "channel_id": ch.channel_id,
            "uploader_id": "a0000000-0000-0000-0000-000000000011",
            "filename": "preview.html",
            "content_type": "text/html",
            "size": 256,
        },
    )
    assert html_resp.status_code == 200
    html_data = html_resp.json()["data"]
    assert html_data["headers"]["Content-Type"] == "text/html"

    pptx_resp = await client.post(
        "/api/v1/files/presign",
        json={
            "channel_id": ch.channel_id,
            "uploader_id": "a0000000-0000-0000-0000-000000000011",
            "filename": "deck.pptx",
            "content_type": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
            "size": 512,
        },
    )
    assert pptx_resp.status_code == 200
    pptx_data = pptx_resp.json()["data"]
    assert (
        pptx_data["headers"]["Content-Type"]
        == "application/vnd.openxmlformats-officedocument.presentationml.presentation"
    )


@pytest.mark.asyncio
async def test_stream_message_with_local_file_returns_sse(
    client: AsyncClient,
    db_session: AsyncSession,
    tmp_path,
    monkeypatch,
) -> None:
    model = _make_disabled_model("stream-model-0001")
    tpl = _make_template("stream-tpl-0001")
    ws = Workspace(workspace_id="f0000000-0000-0000-0000-000000000004", name="W4")
    ch = Channel(
        channel_id="e1000000-0000-0000-0000-000000000004",
        workspace_id=ws.workspace_id,
        name="stream-ch",
        type="public",
    )
    bot = BotAccount(
        bot_id="b3000000-0000-0000-0000-000000000010",
        username="mockbot",
        display_name="MockBot",
        model_id=model.model_id,
        template_id=tpl.template_id,
        status="online",
    )
    file_path = tmp_path / "summary.txt"
    file_path.write_text("hello from local attachment", encoding="utf-8")
    record = FileRecord(
        file_id="file-local-0002",
        channel_id=ch.channel_id,
        uploader_id="a0000000-0000-0000-0000-000000000002",
        original_path=str(file_path),
        original_filename="summary.txt",
        content_type="text/plain",
        size_bytes=file_path.stat().st_size,
        status="ready",
    )
    db_session.add_all([model, tpl, ws, ch, bot, record])
    db_session.add(
        ChannelMembership(
            channel_id=ch.channel_id,
            member_id=bot.bot_id,
            member_type="bot",
        )
    )
    await db_session.commit()

    monkeypatch.setattr("app.services.storage.bootstrap.is_storage_enabled", lambda: False)
    monkeypatch.setattr("app.services.file_processor.service.is_storage_enabled", lambda: False)

    async with client.stream(
        "POST",
        f"/api/v1/channels/{ch.channel_id}/messages/stream",
        json={
            "content": "@mockbot 请结合文件回答",
            "sender_id": "a0000000-0000-0000-0000-000000000002",
            "sender_type": "user",
            "file_ids": [record.file_id],
        },
    ) as resp:
        assert resp.status_code == 200
        body = await resp.aread()

    text = body.decode("utf-8")
    assert "event: user_message" in text
    assert "event: bot_message" in text
    assert "event: done" in text
    assert "event: complete" in text


@pytest.mark.asyncio
async def test_prepare_attachments_from_remote_object_marks_file_ready(
    db_session: AsyncSession,
) -> None:
    ws = Workspace(workspace_id="f0000000-0000-0000-0000-000000000012", name="W12")
    ch = Channel(
        channel_id="e1000000-0000-0000-0000-000000000012",
        workspace_id=ws.workspace_id,
        name="remote-ch",
        type="public",
    )
    record = FileRecord(
        file_id="12345678-1234-1234-1234-123456789012",
        channel_id=ch.channel_id,
        uploader_id="a0000000-0000-0000-0000-000000000012",
        original_path="uploads/12/34/12345678-1234-1234-1234-123456789012/source",
        object_key="uploads/12/34/12345678-1234-1234-1234-123456789012/source",
        storage_bucket="agentnexus-files",
        original_filename="remote.txt",
        content_type="text/plain",
        size_bytes=32,
        status="pending_upload",
    )
    db_session.add_all([ws, ch, record])
    await db_session.commit()

    fake_storage = FakeStorageProvider(
        objects={
            record.file_id: (
                "remote object content for llm".encode("utf-8"),
                "text/plain",
                {"file-id": record.file_id},
            )
        }
    )
    service = FilePipelineService(storage=fake_storage)

    attachments = await service.prepare_attachments(
        db_session,
        channel_id=ch.channel_id,
        file_ids=[record.file_id],
    )
    await db_session.commit()

    assert attachments[0]["file_id"] == record.file_id
    assert "remote object content for llm" in attachments[0]["content"]
    assert record.status == "ready"
    assert record.summary_3lines
    assert record.md_path
