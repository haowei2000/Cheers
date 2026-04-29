"""Mock 适配器 —— 本地测试 + adapter_resolver 的兜底返回值."""
from collections.abc import AsyncIterator

from app.services.adapters.base import AgentPayload, AgentResponse, OpenClawAdapter
from app.services.pipeline.adapter_events import AdapterEvent, Final


class MockBotAdapter(OpenClawAdapter):
    """不调用真实后端，直接返回固定文案。

    使用场景：
    - 单元 / 集成测试替身
    - ``adapter_resolver`` 对未知 Bot、未配置模型/模板、离线 Bot 等错误状态
      的兜底返回（``reply`` 写入占位说明，避免消息流中断）。
    """

    def __init__(self, reply: str = "Mock bot 已收到。", healthy: bool = True) -> None:
        self.reply = reply
        self.healthy = healthy

    async def execute(self, payload: AgentPayload) -> AgentResponse:
        return await self._drain_execute_iter(payload)

    async def execute_iter(self, payload: AgentPayload) -> AsyncIterator[AdapterEvent]:
        yield Final(content=self.reply, success=True)

    async def health_check(self) -> bool:
        return self.healthy
