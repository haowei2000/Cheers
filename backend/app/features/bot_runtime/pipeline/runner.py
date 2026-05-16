"""Pipeline runner: composes Stages and runs them in order over a context."""
from __future__ import annotations

import logging
import time
from collections.abc import Sequence
from typing import Any, Generic, TypeVar

from app.features.bot_runtime.pipeline.stage import Stage

C = TypeVar("C")

logger = logging.getLogger("app.features.bot_runtime.pipeline.runner")


def _stage_name(stage: Stage[Any]) -> str:
    return stage.__class__.__name__.lstrip("_")


def _ctx_field(ctx: Any, name: str) -> str | None:
    value = getattr(ctx, name, None)
    if value in (None, ""):
        return None
    return str(value)


def _ctx_trace_fields(ctx: Any) -> dict[str, str]:
    fields: dict[str, str] = {}
    for attr in ("channel_id", "root_task_id", "sender_id", "sender_type"):
        value = _ctx_field(ctx, attr)
        if value:
            fields[attr] = value

    trigger_msg = getattr(ctx, "trigger_msg", None)
    if trigger_msg is not None:
        msg_id = getattr(trigger_msg, "msg_id", None)
        if msg_id:
            fields["trigger_msg_id"] = str(msg_id)
        msg_type = getattr(trigger_msg, "msg_type", None)
        if msg_type:
            fields["trigger_msg_type"] = str(msg_type)

    msg = getattr(ctx, "msg", None)
    if msg is not None:
        msg_id = getattr(msg, "msg_id", None)
        if msg_id:
            fields["msg_id"] = str(msg_id)

    targets = getattr(ctx, "target_usernames", None)
    if targets:
        fields["targets"] = ",".join(str(t) for t in targets)

    return fields


def _fmt_trace(fields: dict[str, str]) -> str:
    return " ".join(f"{key}={value}" for key, value in fields.items())


async def run_stage(
    stage: Stage[C],
    ctx: C,
    *,
    pipeline_name: str,
    index: int | None = None,
    total: int | None = None,
) -> None:
    """Run one stage with INFO-level flow logs."""
    name = _stage_name(stage)
    position = f"{index}/{total}" if index is not None and total is not None else "-"
    trace = _fmt_trace(_ctx_trace_fields(ctx))
    logger.info(
        "pipeline.stage.start pipeline=%s stage=%s position=%s %s",
        pipeline_name,
        name,
        position,
        trace,
    )
    t0 = time.perf_counter()
    try:
        await stage.run(ctx)
    except Exception:
        duration_ms = (time.perf_counter() - t0) * 1000
        trace = _fmt_trace(_ctx_trace_fields(ctx))
        logger.info(
            "pipeline.stage.failed pipeline=%s stage=%s position=%s duration_ms=%.0f %s",
            pipeline_name,
            name,
            position,
            duration_ms,
            trace,
            exc_info=True,
        )
        raise

    duration_ms = (time.perf_counter() - t0) * 1000
    trace = _fmt_trace(_ctx_trace_fields(ctx))
    logger.info(
        "pipeline.stage.done pipeline=%s stage=%s position=%s duration_ms=%.0f %s",
        pipeline_name,
        name,
        position,
        duration_ms,
        trace,
    )


class Pipeline(Generic[C]):
    def __init__(self, stages: Sequence[Stage[C]], *, name: str = "pipeline") -> None:
        self._stages: tuple[Stage[C], ...] = tuple(stages)
        self._name = name

    @property
    def stages(self) -> tuple[Stage[C], ...]:
        return self._stages

    @property
    def name(self) -> str:
        return self._name

    async def run(self, ctx: C) -> C:
        total = len(self._stages)
        for index, stage in enumerate(self._stages, start=1):
            await run_stage(stage, ctx, pipeline_name=self._name, index=index, total=total)
        return ctx
