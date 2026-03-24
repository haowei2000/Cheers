"""Mock OpenClaw Adapter，用于本地测试与 CI."""
from app.adapters.base import AgentPayload, AgentResponse, OpenClawAdapter


class MockOpenClawAdapter(OpenClawAdapter):
    """不调用真实 LLM，直接返回固定或基于 payload 的回复."""

    def __init__(self, reply: str = "Mock bot 已收到。", healthy: bool = True) -> None:
        self.reply = reply
        self.healthy = healthy

    async def execute(self, payload: AgentPayload) -> AgentResponse:
        return AgentResponse(
            content=self.reply,
            task_id=payload.task_id,
            success=True,
        )

    async def health_check(self) -> bool:
        return self.healthy
