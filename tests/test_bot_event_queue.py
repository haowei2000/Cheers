import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.db.models import Base, Channel, Message, Workspace
from app.features.agent_bridge.pending import PendingReply, pending_replies
from app.features.agent_bridge.service import apply_delta, register_stream
from app.features.bot_runtime.bot_events.jobs import (
    AGENT_BRIDGE_REPLY,
    AGENT_BRIDGE_STREAM_DONE,
    handle_bot_event_job,
)
from app.features.bot_runtime.bot_events import queue as bot_event_queue
from app.features.bot_runtime.bot_events.queue import BotEventJob, MemoryBotEventQueue
from app.features.bot_runtime.bot_events.runs import ensure_bot_run, get_bot_run_by_placeholder


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


@pytest.mark.asyncio
async def test_memory_bot_event_queue_enqueue_ack_retry() -> None:
    queue = MemoryBotEventQueue()
    await queue.start()

    job_id = await queue.enqueue(
        BotEventJob(event_type=AGENT_BRIDGE_REPLY, payload={"bot_id": "b1"})
    )
    first = await queue.receive()

    assert first.job.job_id == job_id
    assert first.job.event_type == AGENT_BRIDGE_REPLY
    assert first.job.payload == {"bot_id": "b1"}
    assert first.job.attempts == 0

    await queue.retry(first, RuntimeError("boom"))
    second = await queue.receive()

    assert second.job.job_id == job_id
    assert second.job.attempts == 1

    await queue.ack(second)


def test_redis_bot_event_queue_socket_timeout_exceeds_block_wait() -> None:
    assert bot_event_queue._REDIS_SOCKET_TIMEOUT_SECONDS > bot_event_queue._XREAD_BLOCK_MS / 1000


@pytest.mark.asyncio
async def test_openclaw_reply_event_finalizes_placeholder_idempotently(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    broker = RecordingBroker()
    monkeypatch.setattr("app.services.realtime_broker._broker", broker)

    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    try:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        factory = async_sessionmaker(engine, expire_on_commit=False)

        async with factory() as session:
            workspace = Workspace(workspace_id="ws-bot-event-reply", name="Workspace")
            channel = Channel(
                channel_id="ch-bot-event-reply",
                workspace_id=workspace.workspace_id,
                name="queued-reply",
            )
            msg = Message(
                msg_id="msg-bot-event-reply",
                channel_id=channel.channel_id,
                sender_id="bot-event-001",
                sender_type="bot",
                content="",
                task_id="task-bot-event-reply",
                in_reply_to_msg_id="trigger-reply",
                msg_type="reply",
            )
            session.add_all([workspace, channel, msg])
            await session.flush()
            await ensure_bot_run(
                session,
                task_id="task-bot-event-reply",
                channel_id=channel.channel_id,
                trigger_msg_id="trigger-reply",
                bot_id="bot-event-001",
                placeholder_msg_id=msg.msg_id,
                status="dispatched_async",
            )

            await pending_replies.register(
                PendingReply(
                    task_id="task-bot-event-reply",
                    bot_id="bot-event-001",
                    channel_id=channel.channel_id,
                    msg_id=msg.msg_id,
                )
            )

            job = BotEventJob(
                event_type=AGENT_BRIDGE_REPLY,
                payload={
                    "bot_id": "bot-event-001",
                    "channel_id": channel.channel_id,
                    "content": "queued reply",
                    "task_id": "task-bot-event-reply",
                    "reply_to_msg_id": msg.msg_id,
                },
            )
            await handle_bot_event_job(session, job)
            await session.flush()
            await session.refresh(msg)

            assert msg.content == "queued reply"
            assert await pending_replies.peek_by_msg(msg.msg_id) is None
            run = await get_bot_run_by_placeholder(session, msg.msg_id)
            assert run is not None
            assert run.status == "done"
            assert run.last_event_type == AGENT_BRIDGE_REPLY
            assert broker.channel_frames[-1][1]["type"] == "message_done"
            assert broker.channel_frames[-1][1]["data"]["content"] == "queued reply"

            await handle_bot_event_job(session, job)
            rows = (
                await session.execute(
                    select(Message).where(Message.channel_id == channel.channel_id)
                )
            ).scalars().all()
            assert [row.msg_id for row in rows] == [msg.msg_id]
    finally:
        await pending_replies.pop_by_msg("msg-bot-event-reply")
        await engine.dispose()


@pytest.mark.asyncio
async def test_openclaw_stream_done_event_flushes_buffer(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    broker = RecordingBroker()
    monkeypatch.setattr("app.services.realtime_broker._broker", broker)

    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    try:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        factory = async_sessionmaker(engine, expire_on_commit=False)

        async with factory() as session:
            workspace = Workspace(workspace_id="ws-bot-event-stream", name="Workspace")
            channel = Channel(
                channel_id="ch-bot-event-stream",
                workspace_id=workspace.workspace_id,
                name="queued-stream",
            )
            msg = Message(
                msg_id="msg-bot-event-stream",
                channel_id=channel.channel_id,
                sender_id="bot-event-002",
                sender_type="bot",
                content="",
                task_id="task-bot-event-stream",
                in_reply_to_msg_id="trigger-stream",
                msg_type="reply",
            )
            session.add_all([workspace, channel, msg])
            await session.flush()
            await ensure_bot_run(
                session,
                task_id="task-bot-event-stream",
                channel_id=channel.channel_id,
                trigger_msg_id="trigger-stream",
                bot_id="bot-event-002",
                placeholder_msg_id=msg.msg_id,
                status="dispatched_async",
            )

            await pending_replies.register(
                PendingReply(
                    task_id="task-bot-event-stream",
                    bot_id="bot-event-002",
                    channel_id=channel.channel_id,
                    msg_id=msg.msg_id,
                )
            )
            await register_stream(
                msg_id=msg.msg_id,
                bot_id="bot-event-002",
                channel_id=channel.channel_id,
                task_id="task-bot-event-stream",
            )
            assert await apply_delta(
                msg_id=msg.msg_id,
                bot_id="bot-event-002",
                seq=0,
                delta="stream ",
            )
            assert await apply_delta(
                msg_id=msg.msg_id,
                bot_id="bot-event-002",
                seq=1,
                delta="done",
            )

            await handle_bot_event_job(
                session,
                BotEventJob(
                    event_type=AGENT_BRIDGE_STREAM_DONE,
                    payload={"msg_id": msg.msg_id, "bot_id": "bot-event-002"},
                ),
            )
            await session.flush()
            await session.refresh(msg)

            assert msg.content == "stream done"
            run = await get_bot_run_by_placeholder(session, msg.msg_id)
            assert run is not None
            assert run.status == "done"
            assert run.last_event_type == AGENT_BRIDGE_STREAM_DONE
            assert broker.channel_frames[-1][1]["type"] == "message_done"
            assert broker.channel_frames[-1][1]["data"]["content"] == "stream done"
    finally:
        await pending_replies.pop_by_msg("msg-bot-event-stream")
        await engine.dispose()


@pytest.mark.asyncio
async def test_openclaw_stream_done_event_with_snapshot_preserves_event_type(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    broker = RecordingBroker()
    monkeypatch.setattr("app.services.realtime_broker._broker", broker)

    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    try:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        factory = async_sessionmaker(engine, expire_on_commit=False)

        async with factory() as session:
            workspace = Workspace(workspace_id="ws-bot-event-snapshot", name="Workspace")
            channel = Channel(
                channel_id="ch-bot-event-snapshot",
                workspace_id=workspace.workspace_id,
                name="queued-snapshot",
            )
            msg = Message(
                msg_id="msg-bot-event-snapshot",
                channel_id=channel.channel_id,
                sender_id="bot-event-003",
                sender_type="bot",
                content="",
                task_id="task-bot-event-snapshot",
                in_reply_to_msg_id="trigger-snapshot",
                msg_type="reply",
            )
            session.add_all([workspace, channel, msg])
            await session.flush()
            await ensure_bot_run(
                session,
                task_id="task-bot-event-snapshot",
                channel_id=channel.channel_id,
                trigger_msg_id="trigger-snapshot",
                bot_id="bot-event-003",
                placeholder_msg_id=msg.msg_id,
                status="dispatched_async",
            )
            await pending_replies.register(
                PendingReply(
                    task_id="task-bot-event-snapshot",
                    bot_id="bot-event-003",
                    channel_id=channel.channel_id,
                    msg_id=msg.msg_id,
                )
            )

            await handle_bot_event_job(
                session,
                BotEventJob(
                    event_type=AGENT_BRIDGE_STREAM_DONE,
                    payload={
                        "msg_id": msg.msg_id,
                        "bot_id": "bot-event-003",
                        "channel_id": channel.channel_id,
                        "task_id": "task-bot-event-snapshot",
                        "content": "snapshot stream done",
                    },
                ),
            )
            await session.flush()
            await session.refresh(msg)

            assert msg.content == "snapshot stream done"
            run = await get_bot_run_by_placeholder(session, msg.msg_id)
            assert run is not None
            assert run.status == "done"
            assert run.last_event_type == AGENT_BRIDGE_STREAM_DONE
            assert broker.channel_frames[-1][1]["type"] == "message_done"
            assert broker.channel_frames[-1][1]["data"]["content"] == "snapshot stream done"
    finally:
        await pending_replies.pop_by_msg("msg-bot-event-snapshot")
        await engine.dispose()
