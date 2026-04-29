"""Stage / Pipeline composition smoke tests.

Locks the contract: stages run in declared order, mutate the context they
receive, and Pipeline.run returns the same context object so callers can
read final state. No DB / bus dependency — these are the fast unit tests
the plan calls out as Phase 2's testability dividend.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import pytest

from app.services.pipeline.runner import Pipeline
from app.services.pipeline.stage import Stage


@dataclass
class _Ctx:
    trail: list[str] = field(default_factory=list)


class _AppendStage(Stage[_Ctx]):
    def __init__(self, label: str) -> None:
        self._label = label

    async def run(self, ctx: _Ctx) -> None:
        ctx.trail.append(self._label)


async def test_pipeline_runs_stages_in_declared_order() -> None:
    ctx = _Ctx()
    out = await Pipeline([_AppendStage("a"), _AppendStage("b"), _AppendStage("c")]).run(ctx)
    assert out is ctx
    assert ctx.trail == ["a", "b", "c"]


async def test_pipeline_with_no_stages_is_a_noop() -> None:
    ctx = _Ctx()
    await Pipeline[_Ctx]([]).run(ctx)
    assert ctx.trail == []


class _FailingStage(Stage[_Ctx]):
    async def run(self, ctx: _Ctx) -> None:
        ctx.trail.append("failing-entered")
        raise RuntimeError("boom")


async def test_pipeline_propagates_stage_exception_and_halts() -> None:
    ctx = _Ctx()
    pipe = Pipeline([_AppendStage("before"), _FailingStage(), _AppendStage("after")])
    with pytest.raises(RuntimeError, match="boom"):
        await pipe.run(ctx)
    assert ctx.trail == ["before", "failing-entered"]


def test_pipeline_stages_property_is_immutable_view() -> None:
    s1, s2 = _AppendStage("x"), _AppendStage("y")
    pipe = Pipeline([s1, s2])
    assert pipe.stages == (s1, s2)
    assert isinstance(pipe.stages, tuple)
