"""Channel 与 ChannelMembership 数据访问层."""
from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import BotAccount, Channel, ChannelMembership, User


class ChannelRepository:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def get_by_id(self, channel_id: str) -> Channel | None:
        result = await self.session.execute(
            select(Channel).where(Channel.channel_id == channel_id)
        )
        return result.scalar_one_or_none()

    async def list_for_user(
        self, user_id: str, include_dms: bool = True
    ) -> list[Channel]:
        q = (
            select(Channel)
            .join(ChannelMembership, Channel.channel_id == ChannelMembership.channel_id)
            .where(
                ChannelMembership.member_id == user_id,
                ChannelMembership.member_type == "user",
            )
        )
        if not include_dms:
            q = q.where(Channel.type != "dm")
        q = q.order_by(Channel.created_at)
        return list((await self.session.execute(q)).scalars().all())

    async def list_for_user_in_workspace(
        self, workspace_id: str, user_id: str, include_dms: bool = True
    ) -> list[Channel]:
        q = (
            select(Channel)
            .join(ChannelMembership, Channel.channel_id == ChannelMembership.channel_id)
            .where(
                Channel.workspace_id == workspace_id,
                ChannelMembership.member_id == user_id,
                ChannelMembership.member_type == "user",
            )
        )
        if not include_dms:
            q = q.where(Channel.type != "dm")
        q = q.order_by(Channel.created_at)
        return list((await self.session.execute(q)).scalars().all())

    async def list_dms_for_user(self, user_id: str) -> list[Channel]:
        q = (
            select(Channel)
            .join(ChannelMembership, Channel.channel_id == ChannelMembership.channel_id)
            .where(
                ChannelMembership.member_id == user_id,
                ChannelMembership.member_type == "user",
                Channel.type == "dm",
            )
            .order_by(Channel.created_at)
        )
        return list((await self.session.execute(q)).scalars().all())

    async def list_by_workspace(self, workspace_id: str) -> list[Channel]:
        result = await self.session.execute(
            select(Channel)
            .where(Channel.workspace_id == workspace_id)
            .order_by(Channel.created_at)
        )
        return list(result.scalars().all())

    async def create(
        self,
        workspace_id: str,
        name: str,
        type: str = "public",
        purpose: str | None = None,
    ) -> Channel:
        ch = Channel(workspace_id=workspace_id, name=name, type=type, purpose=purpose)
        self.session.add(ch)
        await self.session.flush()
        return ch

    async def update(self, channel: Channel, **kwargs) -> Channel:
        for key, value in kwargs.items():
            setattr(channel, key, value)
        self.session.add(channel)
        await self.session.flush()
        return channel

    async def delete(self, channel: Channel) -> None:
        await self.session.delete(channel)
        await self.session.flush()

    # --- Membership ---

    async def get_membership(self, channel_id: str, member_id: str) -> ChannelMembership | None:
        result = await self.session.execute(
            select(ChannelMembership).where(
                ChannelMembership.channel_id == channel_id,
                ChannelMembership.member_id == member_id,
            )
        )
        return result.scalar_one_or_none()

    async def list_memberships(self, channel_id: str) -> list[ChannelMembership]:
        result = await self.session.execute(
            select(ChannelMembership).where(ChannelMembership.channel_id == channel_id)
        )
        return list(result.scalars().all())

    async def list_bot_members(self, channel_id: str) -> list[BotAccount]:
        """返回频道内所有 Bot 成员的 BotAccount 对象."""
        result = await self.session.execute(
            select(BotAccount)
            .join(ChannelMembership, BotAccount.bot_id == ChannelMembership.member_id)
            .where(
                ChannelMembership.channel_id == channel_id,
                ChannelMembership.member_type == "bot",
            )
        )
        return list(result.scalars().all())

    async def list_user_members(self, channel_id: str) -> list[User]:
        """返回频道内所有用户成员的 User 对象."""
        result = await self.session.execute(
            select(User)
            .join(ChannelMembership, User.user_id == ChannelMembership.member_id)
            .where(
                ChannelMembership.channel_id == channel_id,
                ChannelMembership.member_type == "user",
            )
        )
        return list(result.scalars().all())

    async def add_member(
        self,
        channel_id: str,
        member_id: str,
        member_type: str,
        added_by: str | None = None,
    ) -> ChannelMembership:
        membership = ChannelMembership(
            channel_id=channel_id,
            member_id=member_id,
            member_type=member_type,
            added_by=added_by,
        )
        self.session.add(membership)
        await self.session.flush()
        return membership

    async def remove_member(self, membership: ChannelMembership) -> None:
        await self.session.delete(membership)
        await self.session.flush()
