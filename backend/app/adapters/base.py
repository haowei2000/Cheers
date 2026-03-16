"""OpenClawAdapter 抽象接口（ADR D-05）：Orchestrator 只依赖此接口."""
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any


@dataclass
class AgentPayload:
    """发给 OpenClaw 的标准 Payload（详细设计 §7.2）."""
    task_id: str
    channel_id: str
    trigger_message: dict[str, Any]
    memory_context: dict[str, str]
    attachments: list[dict[str, str]] = field(default_factory=list)
    process_config: dict[str, Any] = field(default_factory=lambda: {"mode": "sequential", "timeout_seconds": 120})
    # 澄清场景：原问题文本，供引导 Bot 合并上下文后生成最终回答
    original_question_text: str | None = None


@dataclass
class AgentResponse:
    """OpenClaw 返回的标准响应."""
    content: str
    task_id: str
    success: bool = True
    error_message: str | None = None


class OpenClawAdapter(ABC):
    """OpenClaw 隔离层：版本升级只改 Adapter 实现，不动 Orchestrator."""

    @abstractmethod
    async def execute(self, payload: AgentPayload) -> AgentResponse:
        """唯一对外接口：输入标准 Payload，输出标准 Response."""
        raise NotImplementedError

    @abstractmethod
    async def health_check(self) -> bool:
        """检查 OpenClaw 实例是否在线."""
        raise NotImplementedError
