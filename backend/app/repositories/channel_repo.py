"""Channel repo module."""
from __future__ import annotations

from typing import Any

from sqlalchemy import or_, select
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
        else:
            q = q.where(or_(Channel.type != "dm", ChannelMembership.hidden_at.is_(None)))
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
        else:
            q = q.where(or_(Channel.type != "dm", ChannelMembership.hidden_at.is_(None)))
        q = q.order_by(Channel.created_at)
        return list((await self.session.execute(q)).scalars().all())

    async def list_dms_for_user(self, user_id: str) -> list[Channel]:
        q = (
            select(Channel)
            .join(ChannelMembership, Channel.channel_id == ChannelMembership.channel_id)
            .where(
                ChannelMembership.member_id == user_id,
                ChannelMembership.member_type == "user",
                ChannelMembership.hidden_at.is_(None),
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
        allow_member_invites: bool | None = None,
        allow_bot_adds: bool | None = None,
    ) -> Channel:
        kwargs: dict[str, Any] = {
            "workspace_id": workspace_id,
            "name": name,
            "type": type,
            "purpose": purpose,
        }
        if allow_member_invites is not None:
            kwargs["allow_member_invites"] = allow_member_invites
        if allow_bot_adds is not None:
            kwargs["allow_bot_adds"] = allow_bot_adds
        ch = Channel(**kwargs)
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
        """List bot members."""
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
        """List user members."""
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
        role: str = "member",
    ) -> ChannelMembership:
        membership = ChannelMembership(
            channel_id=channel_id,
            member_id=member_id,
            member_type=member_type,
            added_by=added_by,
            role=role,
        )
        self.session.add(membership)
        await self.session.flush()
        return membership

    async def remove_member(self, membership: ChannelMembership) -> None:
        await self.session.delete(membership)
        await self.session.flush()
