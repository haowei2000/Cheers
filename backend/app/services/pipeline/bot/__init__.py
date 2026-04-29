"""BotPipeline: orchestrator-side stages.

Today only IngestStage is implemented; the rest of run_orchestrator is
migrated stage-by-stage in subsequent commits. The stages share
BotRunContext (data) and the same EventBus the IngestPipeline uses.
"""
from app.services.pipeline.bot.capabilities import Capabilities
from app.services.pipeline.bot.context import BotRunContext
from app.services.pipeline.bot.stages.auto_takeover import AutoTakeoverStage
from app.services.pipeline.bot.stages.context_load import ContextLoadStage
from app.services.pipeline.bot.stages.dispatch import (
    DispatchStage,
    trigger_sub_bots_from_mentions,
)
from app.services.pipeline.bot.stages.ingest import IngestStage
from app.services.pipeline.bot.stages.route import RouteStage
from app.services.pipeline.bot.subagent import (
    build_payload,
    dispatch_many,
    dispatch_one,
)
from app.services.pipeline.bot.writer import BotMessageWriter

__all__ = [
    "AutoTakeoverStage",
    "BotMessageWriter",
    "BotRunContext",
    "Capabilities",
    "ContextLoadStage",
    "DispatchStage",
    "IngestStage",
    "RouteStage",
    "build_payload",
    "dispatch_many",
    "dispatch_one",
    "trigger_sub_bots_from_mentions",
]
