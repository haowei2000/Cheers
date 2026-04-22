"""Bot 适配器抽象接口（ADR D-05）：Orchestrator 只依赖此接口，所有 adapter 实现它。

类名 ``OpenClawAdapter`` 保留历史命名；语义已泛化为所有 Bot 执行路径
（HTTP LLM、内置 @channel bot、WebSocket Bot 等）共用的协议。
"""
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any


@dataclass
class AgentPayload:
    """Orchestrator 派发给任一 adapter 的标准输入（详细设计 §7.2）。"""
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
    """adapter 回给 orchestrator 的标准输出。"""
    content: str
    task_id: str
    success: bool = True
    error_message: str | None = None
    file_ids: list[str] = field(default_factory=list)
    # True 表示 Bot 执行为异步派发（如 WebSocket Bot 交给 OpenClaw channel plugin），
    # content 不会被 orchestrator 写入占位消息，回复通过 bridge 回推后再落盘。
    dispatched_async: bool = False


class OpenClawAdapter(ABC):
    """所有 Bot 执行路径的共同协议。Orchestrator 只调这里的方法，adapter 可随意换实现。"""

    @abstractmethod
    async def execute(self, payload: AgentPayload) -> AgentResponse:
        """唯一执行入口：输入标准 Payload，输出标准 Response."""
        raise NotImplementedError

    @abstractmethod
    async def health_check(self) -> bool:
        """检查该 adapter 的依赖（远端 LLM / WS 链路 / …）是否可用."""
        raise NotImplementedError
