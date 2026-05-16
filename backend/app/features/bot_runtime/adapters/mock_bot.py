"""Mock bot module."""

from collections.abc import AsyncIterator

from app.features.bot_runtime.adapters.base import AgentPayload, BotAdapter
from app.features.bot_runtime.pipeline.adapter_events import AdapterEvent, Final


class MockBotAdapter(BotAdapter):
    """Mock Bot Adapter schema or model."""

    def __init__(self, reply: str = "Mock bot 已收到。", healthy: bool = True) -> None:
        self.reply = reply
        self.healthy = healthy

    async def execute(self, payload: AgentPayload) -> AsyncIterator[AdapterEvent]:
        yield Final(content=self.reply, success=True)

    async def health_check(self) -> bool:
        return self.healthy
