"""Unified message and Bot runtime pipelines."""
from __future__ import annotations

from importlib import import_module
from typing import Any

_EXPORTS = {
    "BotWorkflowPlan": "app.features.bot_runtime.pipeline.workflow",
    "MessageWorkflowPlan": "app.features.bot_runtime.pipeline.workflow",
    "build_bot_workflow": "app.features.bot_runtime.pipeline.workflow",
    "build_message_workflow": "app.features.bot_runtime.pipeline.workflow",
    "run_message_workflow": "app.features.bot_runtime.pipeline.workflow",
}

__all__ = sorted(_EXPORTS)


def __getattr__(name: str) -> Any:
    module_name = _EXPORTS.get(name)
    if module_name is None:
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
    value = getattr(import_module(module_name), name)
    globals()[name] = value
    return value
