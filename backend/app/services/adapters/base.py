"""Bot 适配器抽象接口（ADR D-05）：Orchestrator 只依赖此接口，所有 adapter 实现它。

类名 ``OpenClawAdapter`` 保留历史命名；语义已泛化为所有 Bot 执行路径
（HTTP LLM、内置 @Coordinator、WebSocket Bot 等）共用的协议。
"""
from abc import ABC, abstractmethod
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from typing import Any

from app.services.pipeline.adapter_events import (
    AdapterEvent,
    DispatchedAsync,
    Final,
)


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
    """Legacy single-result summary kept for back-compat.

    Phase 4 introduced :class:`AdapterEvent` streaming via ``execute_iter``;
    this dataclass is now mostly a reduction target for tests and a few
    callers that haven't migrated. ``dispatch_one`` returns ``Final | None``
    going forward — prefer that over constructing this directly.
    """
    content: str
    task_id: str
    success: bool = True
    error_message: str | None = None
    file_ids: list[str] = field(default_factory=list)
    # True 表示 Bot 执行为异步派发（如 WebSocket Bot 交给 OpenClaw channel plugin），
    # content 不会被 orchestrator 写入占位消息，回复通过 bridge 回推后再落盘。
    dispatched_async: bool = False


class OpenClawAdapter(ABC):
    """所有 Bot 执行路径的共同协议。Orchestrator 只调这里的方法，adapter 可随意换实现。

    Subclasses must implement ``execute`` (legacy single-result API).
    They may additionally override ``execute_iter`` to yield streaming
    Delta events natively; the default impl wraps ``execute`` into a
    single-yield iterator so non-streaming adapters keep working.
    """

    @abstractmethod
    async def execute(self, payload: AgentPayload) -> AgentResponse:
        """Single-result entry point. Returns an AgentResponse with the
        final content. Streaming token deltas, if any, are routed through
        the legacy ``payload.process_config['_stream_token']`` callback."""
        raise NotImplementedError

    async def execute_iter(self, payload: AgentPayload) -> AsyncIterator[AdapterEvent]:
        """Streaming entry point. Default impl wraps ``execute`` into a
        single-yield iterator (no Delta events, just one Final or
        DispatchedAsync). Adapters with native streaming override this
        and yield Delta(text) per token + a terminal Final."""
        resp = await self.execute(payload)
        if resp.dispatched_async:
            yield DispatchedAsync()
            return
        yield Final(
            content=resp.content,
            success=resp.success,
            error_message=resp.error_message,
            file_ids=list(resp.file_ids),
        )

    async def _drain_execute_iter(self, payload: AgentPayload) -> AgentResponse:
        """Helper for adapters that implement ``execute_iter`` natively and
        want a one-line ``execute`` override.

        Drains the iterator, joining Delta text into the fallback content
        and reducing the terminal event into an ``AgentResponse``. Calling
        this from a subclass that DOESN'T override ``execute_iter`` causes
        infinite recursion (default execute_iter wraps execute, which
        would call this, which calls execute_iter…)."""
        from app.services.pipeline.adapter_events import Delta

        deltas: list[str] = []
        terminal: AdapterEvent | None = None
        async for event in self.execute_iter(payload):
            if isinstance(event, Delta):
                deltas.append(event.text)
            else:
                terminal = event
                break
        if isinstance(terminal, DispatchedAsync):
            return AgentResponse(
                content="", task_id=payload.task_id, success=True,
                dispatched_async=True,
            )
        if isinstance(terminal, Final):
            return AgentResponse(
                content=terminal.content,
                task_id=payload.task_id,
                success=terminal.success,
                error_message=terminal.error_message,
                file_ids=list(terminal.file_ids),
            )
        return AgentResponse(
            content="".join(deltas),
            task_id=payload.task_id,
            success=False,
            error_message="adapter yielded no terminal event",
        )

    @abstractmethod
    async def health_check(self) -> bool:
        """检查该 adapter 的依赖（远端 LLM / WS 链路 / …）是否可用."""
        raise NotImplementedError
