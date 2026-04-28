"""Base pipeline context shared by IngestPipeline and BotPipeline.

Concrete pipelines extend this with their own data fields (trigger message,
mentioned bots, suggested takeovers, etc.). The base only carries what every
stage needs: the channel id, the EventBus, and the DB session.
"""
from __future__ import annotations

from dataclasses import dataclass

from sqlalchemy.ext.asyncio import AsyncSession

from app.services.pipeline.bus import EventBus


@dataclass
class PipelineContext:
    channel_id: str
    bus: EventBus
    session: AsyncSession
