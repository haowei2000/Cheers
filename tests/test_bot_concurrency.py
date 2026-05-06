import asyncio
from datetime import datetime, timezone
from types import SimpleNamespace

import pytest

from app.config import settings
from app.db.models import Message
from app.services.adapters.base import AgentResponse, OpenClawAdapter
from app.services.pipeline.adapter_events import Final
from app.services.pipeline.bot.capabilities import Capabilities
from app.services.pipeline.bot.subagent import dispatch_many
from app.services.pipeline.bus import NullEventBus


class _Writer:
    async def pre_create(self, bot_id: str, task_id: str) -> Message:
        return Message(
            msg_id=f"msg-{bot_id}",
            channel_id="ch-1",
            sender_id=bot_id,
            sender_type="bot",
            content="",
            task_id=task_id,
        )

    async def finalize(self, msg: Message, content: str, *, file_ids=None) -> None:
        msg.content = content

    async def record_task(self, bot_id: str, response_msg_id: str) -> None:
        return


@pytest.mark.asyncio
async def test_dispatch_many_respects_per_message_bot_concurrency(monkeypatch) -> None:
    monkeypatch.setattr(settings, "orchestrator_bot_concurrency_per_message", 2)
    active = 0
    max_active = 0

    class Adapter(OpenClawAdapter):
        async def execute(self, payload):
            return AgentResponse(content="ok", task_id=payload.task_id, success=True)

        async def health_check(self) -> bool:
            return True

        async def execute_iter(self, payload):
            nonlocal active, max_active
            active += 1
            max_active = max(max_active, active)
            await asyncio.sleep(0.02)
            active -= 1
            yield Final(content="ok", success=True)

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
