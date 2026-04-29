"""Pipeline runner: composes Stages and runs them in order over a context."""
from __future__ import annotations

from collections.abc import Sequence
from typing import Generic, TypeVar

from app.services.pipeline.stage import Stage

C = TypeVar("C")


class Pipeline(Generic[C]):
    def __init__(self, stages: Sequence[Stage[C]]) -> None:
        self._stages: tuple[Stage[C], ...] = tuple(stages)

    @property
    def stages(self) -> tuple[Stage[C], ...]:
        return self._stages

    async def run(self, ctx: C) -> C:
        for stage in self._stages:
            await stage.run(ctx)
        return ctx
