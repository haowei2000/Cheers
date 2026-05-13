import asyncio
from datetime import datetime, timezone
from types import SimpleNamespace

import pytest

from app.config import settings
from app.db.models import Message
from app.features.bot_runtime.adapters.base import BotAdapter
from app.features.bot_runtime.pipeline.adapter_events import Delta, Final
from app.features.bot_runtime.pipeline.bot.capabilities import Capabilities
from app.features.bot_runtime.pipeline.bot.subagent import dispatch_many, dispatch_one
from app.features.bot_runtime.pipeline.bus import NullEventBus
from app.features.bot_runtime.pipeline.events import MessageStreamDelta


class _Writer:
    def __init__(self) -> None:
        self.finalized: list[tuple[Message, str, bool, str | None]] = []

    async def pre_create(self, bot_id: str, task_id: str) -> Message:
        return Message(
            msg_id=f"msg-{bot_id}",
            channel_id="ch-1",
            sender_id=bot_id,
            sender_type="bot",
            content="",
            task_id=task_id,
        )

    async def finalize(
        self,
        msg: Message,
        content: str,
        *,
        file_ids=None,
        is_partial: bool = False,
        error: str | None = None,
        **_,
    ) -> None:
        msg.content = content
        msg.is_partial = is_partial
        self.finalized.append((msg, content, is_partial, error))
        from app.features.agent_bridge.streams import stream_registry

        await stream_registry.pop(msg.msg_id)

    async def record_task(self, bot_id: str, response_msg_id: str) -> None:
        return


@pytest.mark.asyncio
async def test_dispatch_many_respects_per_message_bot_concurrency(monkeypatch) -> None:
    monkeypatch.setattr(settings, "orchestrator_bot_concurrency_per_message", 2)
    active = 0
    max_active = 0

    class Adapter(BotAdapter):
        async def execute(self, payload):
            nonlocal active, max_active
            active += 1
            max_active = max(max_active, active)
            await asyncio.sleep(0.02)
            active -= 1
            yield Final(content="ok", success=True)

        async def health_check(self) -> bool:
            return True

    async def adapter_factory(_bot_id: str):
        return Adapter()

    trigger = Message(
        msg_id="trigger-1",
        channel_id="ch-1",
        sender_id="user-1",
        sender_type="user",
        content="@a @b @c @d hi",
        created_at=datetime.now(timezone.utc),
    )
    ctx = SimpleNamespace(
        channel_id="ch-1",
        bus=NullEventBus(),
        session=None,
        trigger_msg=trigger,
        adapter_factory=adapter_factory,
        broadcast_processing=None,
        channel_bot_usernames=["a", "b", "c", "d"],
        bot_id_by_username={"a": "bot-a", "b": "bot-b", "c": "bot-c", "d": "bot-d"},
        bot_details_by_username={},
        trigger_content="hi",
        user_secrets={},
        sender_name="User",
        channel_name="General",
        memory_context={},
        attachments=[],
        attachment_error=None,
        topic_chain=[],
        child_replies=[],
        original_question=None,
        root_task_id="task-1",
        writer=_Writer(),
        triggered_bot_ids=set(),
        bot_messages=[],
        already_broadcast=set(),
    )

    await dispatch_many(ctx, ["a", "b", "c", "d"], capabilities=Capabilities.regular())

    assert max_active == 2
    assert len(ctx.bot_messages) == 4


@pytest.mark.asyncio
async def test_dispatch_one_cancel_event_stops_local_bot() -> None:
    from app.features.agent_bridge.streams import stream_registry

    class CancellingBus:
        def __init__(self) -> None:
            self.events = []

        async def publish(self, event) -> None:
            self.events.append(event)
            if isinstance(event, MessageStreamDelta):
                await stream_registry.request_cancel(event.msg_id, reason="user_cancelled")

    class Adapter(BotAdapter):
        async def execute(self, payload):
            assert payload.process_config.cancel_event is not None
            yield Delta(text="partial")
            await asyncio.sleep(10)
            yield Final(content="should not arrive", success=True)

        async def health_check(self) -> bool:
            return True

    async def adapter_factory(_bot_id: str):
        return Adapter()

    writer = _Writer()
    trigger = Message(
        msg_id="trigger-cancel",
        channel_id="ch-1",
        sender_id="user-1",
        sender_type="user",
        content="@a hi",
        created_at=datetime.now(timezone.utc),
    )
    ctx = SimpleNamespace(
        channel_id="ch-1",
        bus=CancellingBus(),
        session=None,
        trigger_msg=trigger,
        adapter_factory=adapter_factory,
        broadcast_processing=None,
        channel_bot_usernames=["a"],
        bot_id_by_username={"a": "bot-a"},
        bot_details_by_username={},
        trigger_content="hi",
        user_secrets={},
        sender_name="User",
        channel_name="General",
        memory_context={},
        attachments=[],
        attachment_error=None,
        topic_chain=[],
        child_replies=[],
        original_question=None,
        root_task_id="task-cancel",
        writer=writer,
        triggered_bot_ids=set(),
        bot_messages=[],
        already_broadcast=set(),
    )

    result = await dispatch_one(ctx, "bot-a", capabilities=Capabilities.regular())

    assert result is None
    assert writer.finalized
    msg, content, is_partial, error = writer.finalized[-1]
    assert msg.msg_id == "msg-bot-a"
    assert content == "partial"
    assert is_partial is True
    assert error == "user_cancelled"
    assert await stream_registry.get("msg-bot-a") is None
