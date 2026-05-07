"""End-to-end Bot message pipeline tests."""
from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.db.models import AIModel, BotAccount, Channel, ChannelMembership, PromptTemplate, Workspace
from app.features.bot_runtime.adapters.base import AgentPayload, BotAdapter
from app.features.bot_runtime.orchestrator.queue import stop_orchestrator_workers
from app.features.bot_runtime.pipeline.adapter_events import AdapterEvent, Delta, Final

TEST_USER_ID = "a0000000-0000-0000-0000-000000000099"


class RecordingBroker:
    def __init__(self) -> None:
        self.channel_frames: list[tuple[str, dict]] = []
        self.user_frames: list[tuple[str, dict]] = []

    async def start(self) -> None:
        return

    async def close(self) -> None:
        return

    async def publish_channel(self, channel_id: str, message: dict) -> None:
        self.channel_frames.append((channel_id, message))

    async def publish_user(self, user_id: str, message: dict) -> None:
        self.user_frames.append((user_id, message))


class StreamingAdapter(BotAdapter):
    async def execute(self, payload: AgentPayload) -> AsyncIterator[AdapterEvent]:
        yield Delta(text="stream ")
        yield Delta(text="ok")
        yield Final(content="stream ok", success=True)

    async def health_check(self) -> bool:
        return True


def _make_disabled_model(model_id: str) -> AIModel:
    return AIModel(
        model_id=model_id,
        name=f"pipeline-model-{model_id[-4:]}",
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
        name=f"pipeline-tpl-{template_id[-4:]}",
        system_prompt="test",
        user_template="{{message}}",
        variables=["message"],
        is_builtin=False,
    )


def _patch_background_session_factories(
    monkeypatch: pytest.MonkeyPatch,
    db_engine,
) -> None:
    factory = async_sessionmaker(
        db_engine,
        class_=AsyncSession,
        expire_on_commit=False,
        autocommit=False,
        autoflush=False,
    )
    monkeypatch.setattr("app.features.bot_runtime.orchestrator.jobs.async_session_factory", factory)
    monkeypatch.setattr("app.features.bot_runtime.pipeline.ingest.stages.async_session_factory", factory)


async def _wait_for_bot_messages(
    client: AsyncClient,
    channel_id: str,
    *,
    min_count: int,
    timeout: float = 2.0,
) -> list[dict]:
    deadline = asyncio.get_running_loop().time() + timeout
    last_messages: list[dict] = []
    while True:
        resp = await client.get(f"/api/v1/channels/{channel_id}/messages")
        assert resp.status_code == 200
        last_messages = resp.json()["data"]
        if sum(1 for msg in last_messages if msg["sender_type"] == "bot") >= min_count:
            return last_messages
        if asyncio.get_running_loop().time() >= deadline:
            return last_messages
        await asyncio.sleep(0.05)


@pytest.mark.asyncio
async def test_dm_message_to_bot_gets_reply_without_mention(
    monkeypatch: pytest.MonkeyPatch,
    client: AsyncClient,
    db_session: AsyncSession,
    db_engine,
) -> None:
    """DM to a Bot should traverse REST -> ingest -> queue worker -> Bot reply."""
    await stop_orchestrator_workers()
    _patch_background_session_factories(monkeypatch, db_engine)
    model = _make_disabled_model("pipeline-model-0001")
    tpl = _make_template("pipeline-tpl-0001")
    ws = Workspace(workspace_id="pipeline-ws-0001", name="Pipeline")
    ch = Channel(
        channel_id="pipeline-ch-0001",
        workspace_id=ws.workspace_id,
        name=f"dm:{TEST_USER_ID}:pipeline-bot-0001",
        type="dm",
    )
    bot = BotAccount(
        bot_id="pipeline-bot-0001",
        username="pipeline_dm_bot",
        display_name="PipelineDMBot",
        model_id=model.model_id,
        template_id=tpl.template_id,
        status="online",
    )
    db_session.add_all([model, tpl, ws, ch, bot])
    db_session.add(
        ChannelMembership(
            channel_id=ch.channel_id,
            member_id=TEST_USER_ID,
            member_type="user",
        )
    )
    db_session.add(
        ChannelMembership(
            channel_id=ch.channel_id,
            member_id=bot.bot_id,
            member_type="bot",
        )
    )
    await db_session.commit()

    try:
        resp = await client.post(
            f"/api/v1/channels/{ch.channel_id}/messages",
            json={
                "content": "hello bot, no explicit mention",
                "sender_id": "ignored",
                "sender_type": "user",
            },
        )
        assert resp.status_code == 200

        messages = await _wait_for_bot_messages(client, ch.channel_id, min_count=1)
        user_msg = next((m for m in messages if m["sender_type"] == "user"), None)
        bot_msg = next((m for m in messages if m["sender_type"] == "bot"), None)
        assert user_msg is not None and user_msg["content"] == "hello bot, no explicit mention"
        assert bot_msg is not None
        assert "PipelineDMBot" in bot_msg["content"] or "模型已禁用" in bot_msg["content"]
    finally:
        await stop_orchestrator_workers()


@pytest.mark.asyncio
async def test_worker_bot_pipeline_emits_realtime_status_and_stream_frames(
    monkeypatch: pytest.MonkeyPatch,
    client: AsyncClient,
    db_session: AsyncSession,
    db_engine,
) -> None:
    """Queued Bot execution should preserve the WS frames the frontend renders."""
    await stop_orchestrator_workers()
    _patch_background_session_factories(monkeypatch, db_engine)
    broker = RecordingBroker()
    monkeypatch.setattr("app.services.realtime_broker._broker", broker)

    import app.features.bot_runtime.orchestrator.jobs as jobs

    async def adapter_factory(bot_id: str, session: AsyncSession) -> BotAdapter:
        return StreamingAdapter()

    monkeypatch.setattr(jobs, "get_adapter_for_bot", adapter_factory)

    model = _make_disabled_model("pipeline-model-0002")
    tpl = _make_template("pipeline-tpl-0002")
    ws = Workspace(workspace_id="pipeline-ws-0002", name="Pipeline Events")
    ch = Channel(
        channel_id="pipeline-ch-0002",
        workspace_id=ws.workspace_id,
        name="pipeline-events",
        type="public",
    )
    bot = BotAccount(
        bot_id="pipeline-bot-0002",
        username="pipeline_stream_bot",
        display_name="PipelineStreamBot",
        model_id=model.model_id,
        template_id=tpl.template_id,
        status="online",
    )
    db_session.add_all([model, tpl, ws, ch, bot])
    db_session.add(
        ChannelMembership(
            channel_id=ch.channel_id,
            member_id=bot.bot_id,
            member_type="bot",
        )
    )
    await db_session.commit()

    try:
        resp = await client.post(
            f"/api/v1/channels/{ch.channel_id}/messages",
            json={
                "content": "@pipeline_stream_bot please stream",
                "sender_id": "ignored",
                "sender_type": "user",
            },
        )
        assert resp.status_code == 200

        deadline = asyncio.get_running_loop().time() + 2
        while not any(frame.get("type") == "message_done" for _, frame in broker.channel_frames):
            if asyncio.get_running_loop().time() >= deadline:
                break
            await asyncio.sleep(0.05)

        frames = [frame for _, frame in broker.channel_frames]
        assert [frame["type"] for frame in frames] == [
            "message",
            "bot_processing",
            "message",
            "message_stream",
            "message_stream",
            "message_done",
        ]
        assert frames[1]["data"] == {
            "bot_id": bot.bot_id,
            "username": bot.username,
        }
        placeholder_id = frames[2]["data"]["msg_id"]
        assert frames[2]["data"]["sender_type"] == "bot"
        assert frames[3]["data"] == {"msg_id": placeholder_id, "delta": "stream "}
        assert frames[4]["data"] == {"msg_id": placeholder_id, "delta": "ok"}
        assert frames[5]["data"]["msg_id"] == placeholder_id
        assert frames[5]["data"]["content"] == "stream ok"
    finally:
        await stop_orchestrator_workers()
