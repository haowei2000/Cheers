"""Unified Bot pipeline runtime.

Exports are resolved lazily so small utility imports such as
``pipeline.bot.mention`` do not pull in the full Agent Bridge runtime.
"""
from __future__ import annotations

from importlib import import_module
from typing import Any

_EXPORTS = {
    "BotRunContext": "app.features.bot_runtime.pipeline.bot.context",
    "Capabilities": "app.features.bot_runtime.pipeline.bot.capabilities",
    "build_bot_workflow": "app.features.bot_runtime.pipeline.workflow",
    "dispatch_one": "app.features.bot_runtime.pipeline.bot.subagent",
    "enqueue_bot_pipeline_job": "app.features.bot_runtime.pipeline.bot.queue",
    "get_adapter_for_bot": "app.features.bot_runtime.pipeline.bot.adapter_resolver",
    "run_bot_pipeline": "app.features.bot_runtime.pipeline.bot.service",
    "start_bot_pipeline_workers": "app.features.bot_runtime.pipeline.bot.queue",
    "stop_bot_pipeline_workers": "app.features.bot_runtime.pipeline.bot.queue",
}

__all__ = sorted(_EXPORTS)


def __getattr__(name: str) -> Any:
    module_name = _EXPORTS.get(name)
    if module_name is None:
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
    value = getattr(import_module(module_name), name)
    globals()[name] = value
    return value
