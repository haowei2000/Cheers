"""Stage ABC for the message-push pipeline.

A Stage is a unit of work that reads/writes a pipeline-specific context
object and may publish events to ``ctx.bus``. Stages are stateless; all
mutable data lives on the context. Pipelines wire stages in order via
``Pipeline(stages=[...])``.
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Generic, TypeVar

C = TypeVar("C")


class Stage(ABC, Generic[C]):
    @abstractmethod
    async def run(self, ctx: C) -> None: ...
