"""Context 业务逻辑层."""
from __future__ import annotations

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import NotFoundError
from app.repositories.channel_repo import ChannelRepository
from app.services.memory.manager import load, save_layer


class ContextService:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session
        self.channel_repo = ChannelRepository(session)

    async def get_context(self, channel_id: str) -> dict[str, str]:
        """加载频道的所有四层记忆 (ANCHOR, DECISIONS, FILES_INDEX, RECENT)."""
        channel = await self.channel_repo.get_by_id(channel_id)
        if not channel:
            raise NotFoundError("channel not found")
        return await load(channel_id)

    async def update_layer(self, channel_id: str, layer: str, content: str) -> None:
        """更新频道指定层级的上下文内容."""
        channel = await self.channel_repo.get_by_id(channel_id)
        if not channel:
            raise NotFoundError("channel not found")
        await save_layer(channel_id, layer, content)
