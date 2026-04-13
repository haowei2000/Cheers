"""Context 业务逻辑层."""
from __future__ import annotations

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import NotFoundError
from app.repositories.channel_repo import ChannelRepository
from app.services.memory.manager import load


class ContextService:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session
        self.channel_repo = ChannelRepository(session)

    async def get_context(self, channel_id: str) -> dict[str, str]:
        """加载频道的所有记忆层。"""
        channel = await self.channel_repo.get_by_id(channel_id)
        if not channel:
            raise NotFoundError("channel not found")
        return await load(channel_id, self.session)
