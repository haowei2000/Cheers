"""ChatCore 消息 API 测试."""
from __future__ import annotations

from dataclasses import dataclass, field

import pytest
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import (
    AIModel,
    BotAccount,
    Channel,
    ChannelMembership,
    FileRecord,
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
    """GET /api/channels/{id}/messages 无消息时返回空列表."""
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
    """POST /api/channels/{id}/messages 发送消息，GET 可拉取到."""
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
async def test_create_message_survives_orchestrator_enqueue_failure(
    monkeypatch,
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Bot 调度失败不能让已发送用户消息回滚或让 REST 失败。"""
    import app.api.v1.messages.routes as message_routes

    ws = Workspace(workspace_id="f0000000-0000-0000-0000-000000000032", name="W32")
    ch = Channel(
        channel_id="e1000000-0000-0000-0000-000000000032",
        workspace_id=ws.workspace_id,
        name="enqueue-failure-ch",
        type="public",
    )
    db_session.add_all([ws, ch])
    await db_session.commit()

    async def fail_enqueue(channel_id: str, msg_id: str) -> str:
        raise RuntimeError("queue down")

    class FailingBroker:
        async def publish_channel(self, channel_id: str, message: dict) -> None:
            raise RuntimeError("broker down")

    monkeypatch.setattr(message_routes, "enqueue_orchestrator_job", fail_enqueue)
    monkeypatch.setattr(message_routes, "get_realtime_broker", lambda: FailingBroker())

    resp = await client.post(
        f"/api/v1/channels/{ch.channel_id}/messages",
        json={
            "content": "still saved",
            "sender_id": "ignored",
            "sender_type": "user",
        },
    )

    assert resp.status_code == 200
    data = resp.json()["data"]
    assert data["content"] == "still saved"

    rows = (await db_session.execute(select(message_routes.Message))).scalars().all()
    assert any(row.msg_id == data["msg_id"] for row in rows)


@pytest.mark.asyncio
async def test_create_message_returns_before_orchestrator_enqueue_completes(
    monkeypatch,
    db_session: AsyncSession,
) -> None:
    """REST 发送消息不等待 Bot 调度完成，避免队列初始化拖住前端。"""
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
    db_session.add_all([ws, user, ch])
    await db_session.commit()

    class RecordingBackgroundTasks:
        def __init__(self) -> None:
            self.tasks: list[tuple[object, tuple, dict]] = []

        def add_task(self, func, *args, **kwargs) -> None:
            self.tasks.append((func, args, kwargs))

    async def slow_enqueue(channel_id: str, msg_id: str) -> str:
        raise AssertionError("enqueue must be deferred to the background task")
        return "job-slow"

    monkeypatch.setattr(message_routes, "enqueue_orchestrator_job", slow_enqueue)
    background_tasks = RecordingBackgroundTasks()

    data, secret_token = await message_routes._handle_send_message(
        db_session,
        channel_id=ch.channel_id,
        body=message_routes.MessageCreate(
            content="returns immediately",
            sender_id="ignored",
            sender_type="user",
        ),
        current_user=user,
        background_tasks=background_tasks,
    )

    assert secret_token is None
    assert data["content"] == "returns immediately"
    assert len(background_tasks.tasks) == 1
    func, args, kwargs = background_tasks.tasks[0]
    assert func is message_routes._enqueue_orchestrator_bg
    assert args == (ch.channel_id, data["msg_id"])
    assert kwargs == {}


@pytest.mark.asyncio
async def test_secret_message_content_stores_msg_id_reference(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """加密消息正文入库为带 msg_id 的引用，便于后续定位解密对象。"""
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

    resp2 = await client.get(f"/api/v1/channels/{ch.channel_id}/messages")
    assert resp2.status_code == 200
    listed = resp2.json()["data"][0]
    assert listed["msg_id"] == data["msg_id"]
    assert listed["content"] == expected


@pytest.mark.asyncio
async def test_create_message_uses_authenticated_user_identity(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """客户端传入的 sender_id/sender_type 不能伪造消息发送者。"""
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
