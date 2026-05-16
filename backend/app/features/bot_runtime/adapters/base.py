"""Base module."""

from abc import ABC, abstractmethod
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from typing import Any

from app.features.bot_runtime.pipeline.adapter_events import (
    AdapterEvent,
    Delta,
    DispatchedAsync,
    Final,
)
from app.features.bot_runtime.pipeline.process_config import BotRuntime, ProcessConfig


@dataclass
class BotMessageInput:
    """User message details visible to adapters."""

    text: str = ""
    sender_id: str = ""
    sender_name: str = ""
    timestamp: str = ""
    msg_id: str | None = None
    msg_type: str | None = None
    in_reply_to_msg_id: str | None = None
    topic_chain: list[Any] = field(default_factory=list)
    child_replies: list[Any] = field(default_factory=list)
    extra: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_trigger_message(cls, data: dict[str, Any] | None) -> "BotMessageInput":
        raw = dict(data or {})
        known = {
            "text",
            "user",
            "sender_id",
            "sender_name",
            "timestamp",
            "msg_id",
            "msg_type",
            "in_reply_to_msg_id",
            "topic_chain",
            "child_replies",
        }
        return cls(
            text=str(raw.get("text") or ""),
            sender_id=str(raw.get("sender_id") or raw.get("user") or ""),
            sender_name=str(raw.get("sender_name") or ""),
            timestamp=str(raw.get("timestamp") or ""),
            msg_id=raw.get("msg_id"),
            msg_type=raw.get("msg_type"),
            in_reply_to_msg_id=raw.get("in_reply_to_msg_id"),
            topic_chain=list(raw.get("topic_chain") or []),
            child_replies=list(raw.get("child_replies") or []),
            extra={k: v for k, v in raw.items() if k not in known},
        )

    def to_trigger_message(self) -> dict[str, Any]:
        data: dict[str, Any] = {
            "user": self.sender_id,
            "sender_name": self.sender_name,
            "text": self.text,
            "timestamp": self.timestamp,
            "in_reply_to_msg_id": self.in_reply_to_msg_id,
            "topic_chain": self.topic_chain,
            "child_replies": self.child_replies,
        }
        if self.msg_id is not None:
            data["msg_id"] = self.msg_id
        if self.msg_type is not None:
            data["msg_type"] = self.msg_type
        data.update(self.extra)
        return data


@dataclass
class BotContext:
    """Context injected around the message, separate from runtime controls."""

    memory: dict[str, str] = field(default_factory=dict)
    attachments: list[dict[str, str]] = field(default_factory=list)
    # Clarification flow: original question text used by the guide bot to merge context before final response.
    original_question_text: str | None = None


@dataclass(init=False)
class AgentPayload:
    """Standard adapter input: message + context + runtime controls."""

    task_id: str
    channel_id: str
    message: BotMessageInput
    context: BotContext
    runtime: BotRuntime

    def __init__(
        self,
        task_id: str,
        channel_id: str,
        message: BotMessageInput | None = None,
        context: BotContext | None = None,
        runtime: BotRuntime | None = None,
        *,
        trigger_message: dict[str, Any] | None = None,
        memory_context: dict[str, str] | None = None,
        attachments: list[dict[str, str]] | None = None,
        process_config: ProcessConfig | None = None,
        original_question_text: str | None = None,
    ) -> None:
        self.task_id = task_id
        self.channel_id = channel_id
        self.message = message or BotMessageInput.from_trigger_message(trigger_message)
        self.context = context or BotContext(
            memory=dict(memory_context or {}),
            attachments=list(attachments or []),
            original_question_text=original_question_text,
        )
        self.runtime = runtime or process_config or BotRuntime()

    @property
    def trigger_message(self) -> dict[str, Any]:
        return self.message.to_trigger_message()

    @trigger_message.setter
    def trigger_message(self, value: dict[str, Any]) -> None:
        self.message = BotMessageInput.from_trigger_message(value)

    @property
    def memory_context(self) -> dict[str, str]:
        return self.context.memory

    @memory_context.setter
    def memory_context(self, value: dict[str, str]) -> None:
        self.context.memory = dict(value or {})

    @property
    def attachments(self) -> list[dict[str, str]]:
        return self.context.attachments

    @attachments.setter
    def attachments(self, value: list[dict[str, str]]) -> None:
        self.context.attachments = list(value or [])

    @property
    def process_config(self) -> BotRuntime:
        return self.runtime

    @process_config.setter
    def process_config(self, value: ProcessConfig) -> None:
        self.runtime = value

    @property
    def original_question_text(self) -> str | None:
        return self.context.original_question_text

    @original_question_text.setter
    def original_question_text(self, value: str | None) -> None:
        self.context.original_question_text = value


@dataclass
class AgentResponse:
    """Reduced single-result summary used after draining adapter events."""

    content: str
    task_id: str
    success: bool = True
    error_message: str | None = None
    file_ids: list[str] = field(default_factory=list)
    # True means bot execution was dispatched asynchronously, such as Agent Bridge bots handled by external providers.
    # The bot pipeline does not write content to the placeholder; replies are persisted after bridge callbacks.
    dispatched_async: bool = False
    # True means the user cancelled this bot reply; content keeps the partial text produced before cancellation.
    cancelled: bool = False


async def drain_events_to_response(
    events: AsyncIterator[AdapterEvent],
    *,
    task_id: str,
) -> AgentResponse:
    """Reduce an adapter event stream into the legacy summary shape.

    This helper is deliberately outside ``BotAdapter`` so adapter
    implementations only expose one execution method: ``execute``.
    """
    deltas: list[str] = []
    terminal: AdapterEvent | None = None
    async for event in events:
        if isinstance(event, Delta):
            deltas.append(event.text)
        else:
            terminal = event
            break

    if isinstance(terminal, DispatchedAsync):
        return AgentResponse(
            content="",
            task_id=task_id,
            success=True,
            dispatched_async=True,
        )
    if isinstance(terminal, Final):
        return AgentResponse(
            content=terminal.content,
            task_id=task_id,
            success=terminal.success,
            error_message=terminal.error_message,
            file_ids=list(terminal.file_ids),
        )
    return AgentResponse(
        content="".join(deltas),
        task_id=task_id,
        success=False,
        error_message="adapter yielded no terminal event",
    )


class BotAdapter(ABC):
    """Bot Adapter schema or model."""

    @abstractmethod
    def execute(self, payload: AgentPayload) -> AsyncIterator[AdapterEvent]:
        """Run the bot for one payload and stream adapter events."""
        raise NotImplementedError

    @abstractmethod
    async def health_check(self) -> bool:
        """Health check."""
        raise NotImplementedError
