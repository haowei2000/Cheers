"""BotPipeline: orchestrator-side stages.

Today only IngestStage is implemented; the rest of run_orchestrator is
migrated stage-by-stage in subsequent commits. The stages share
BotRunContext (data) and the same EventBus the IngestPipeline uses.
"""
from app.services.pipeline.bot.context import BotRunContext
from app.services.pipeline.bot.stages.ingest import IngestStage

__all__ = ["BotRunContext", "IngestStage"]
