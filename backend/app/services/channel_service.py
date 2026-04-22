"""Channel 业务逻辑层."""
from __future__ import annotations

from sqlalchemy import and_, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import BadRequestError, ForbiddenError, NotFoundError
from app.db.models import (
    BotAccount,
    Channel,
    ChannelMembership,
    ChannelProfile,
    FileRecord,
    Friendship,
    Message,
    PromptTemplate,
    User,
)
from app.repositories.bot_repo import BotRepository
from app.repositories.channel_repo import ChannelRepository
from app.repositories.user_repo import UserRepository
from app.repositories.workspace_repo import WorkspaceRepository
from app.utils.permissions import is_admin


class ChannelService:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session
        self.repo = ChannelRepository(session)
        self.ws_repo = WorkspaceRepository(session)
        self.user_repo = UserRepository(session)
        self.bot_repo = BotRepository(session)

    async def get_or_404(self, channel_id: str) -> Channel:
        ch = await self.repo.get_by_id(channel_id)
        if not ch:
            raise NotFoundError("channel not found")
        return ch

    async def list_for_user(self, user: User) -> list[Channel]:
        return await self.repo.list_for_user(user.user_id)

    async def list_for_user_in_workspace(self, workspace_id: str, user: User) -> list[Channel]:
        return await self.repo.list_for_user_in_workspace(workspace_id, user.user_id)

    async def create(
        self,
        workspace_id: str,
        name: str,
        type: str = "public",
        purpose: str | None = None,
        creator: User | None = None,
    ) -> Channel:
        ws = await self.ws_repo.get_by_id(workspace_id)
        if not ws:
            raise NotFoundError("workspace not found")

        ch = await self.repo.create(workspace_id=workspace_id, name=name, type=type, purpose=purpose)

        # 内置 Bot 自动加入
        from app.services.guide.constants import GUIDE_BOT_ID, GUIDE_HELPER_BOT_ID
        for bot_id in (GUIDE_BOT_ID, GUIDE_HELPER_BOT_ID):
            if not await self.repo.get_membership(ch.channel_id, bot_id):
                await self.repo.add_member(ch.channel_id, bot_id, "bot")

        # 工作空间所有成员自动加入
        ws_members = await self.ws_repo.list_members(workspace_id)
        added_user_ids = set()
        for wm in ws_members:
            if not await self.repo.get_membership(ch.channel_id, wm.user_id):
                await self.repo.add_member(ch.channel_id, wm.user_id, "user")
            added_user_ids.add(wm.user_id)

        # 若创建者不在工作空间成员中
        if creator and creator.user_id not in added_user_ids:
            if not await self.repo.get_membership(ch.channel_id, creator.user_id):
                await self.repo.add_member(ch.channel_id, creator.user_id, "user")

        return ch

    async def update(self, channel_id: str, **kwargs) -> Channel:
        ch = await self.get_or_404(channel_id)
        return await self.repo.update(ch, **kwargs)

    async def delete(self, channel_id: str, current_user: User) -> None:
        ch = await self.get_or_404(channel_id)
        # 仅工作空间 owner/admin 可删除频道
        wm = await self.ws_repo.get_membership(ch.workspace_id, current_user.user_id)
        if not is_admin(current_user) and (not wm or wm.role not in ("owner", "admin")):
            raise ForbiddenError("只有工作空间管理员可以删除频道")

        # 级联删除成员、消息、文件记录
        for membership in await self.repo.list_memberships(channel_id):
            await self.session.delete(membership)
        msgs = await self.session.execute(select(Message).where(Message.channel_id == channel_id))
        for msg in msgs.scalars().all():
            await self.session.delete(msg)
        files = await self.session.execute(select(FileRecord).where(FileRecord.channel_id == channel_id))
        for f in files.scalars().all():
            await self.session.delete(f)
        await self.repo.delete(ch)

    # ---- Membership ----

    async def _require_channel_member(self, channel_id: str, user: User) -> None:
        if is_admin(user):
            return
        m = await self.repo.get_membership(channel_id, user.user_id)
        if not m or m.member_type != "user":
            raise ForbiddenError("您不是该频道的成员")

    async def list_members_with_details(self, channel_id: str) -> list[dict]:
        memberships = await self.repo.list_memberships(channel_id)
        bot_ids = {m.member_id for m in memberships if m.member_type == "bot"}
        user_ids = {m.member_id for m in memberships if m.member_type == "user"}

        bots_by_id: dict = {}
        users_by_id: dict = {}
        if bot_ids:
            rows = (await self.session.execute(
                select(BotAccount).where(BotAccount.bot_id.in_(bot_ids))
            )).scalars()
            bots_by_id = {b.bot_id: b for b in rows}
        if user_ids:
            rows = (await self.session.execute(
                select(User).where(User.user_id.in_(user_ids))
            )).scalars()
            users_by_id = {u.user_id: u for u in rows}

        result = []
        for m in memberships:
            if m.member_type == "bot":
                entity = bots_by_id.get(m.member_id)
            else:
                entity = users_by_id.get(m.member_id)
            if not entity:
                continue
            item: dict = {
                "channel_id": m.channel_id,
                "member_id": m.member_id,
                "member_type": m.member_type,
                "username": entity.username,
                "display_name": entity.display_name,
                "avatar_url": entity.avatar_url,
            }
            if m.member_type == "bot":
                item["template_id"] = m.template_id
                if m.prompt_template:
                    item["template_name"] = m.prompt_template.name
                else:
                    bot_entity: BotAccount = entity
                    item["template_name"] = (
                        bot_entity.prompt_template.name if bot_entity.prompt_template else None
                    )
            result.append(item)
        return result

    async def add_member(
        self,
        channel_id: str,
        member_id: str,
        member_type: str,
        current_user: User,
    ) -> ChannelMembership:
        await self.get_or_404(channel_id)
        await self._require_channel_member(channel_id, current_user)

        if member_type == "bot" and not is_admin(current_user):
            from app.services.guide.constants import GUIDE_BOT_ID
            bot = await self.bot_repo.get_by_id(member_id)
            if not bot:
                raise NotFoundError("Bot 不存在")
            if bot.bot_id != GUIDE_BOT_ID and bot.created_by != current_user.user_id:
                raise ForbiddenError("只能将内置助手或自己创建的 Bot 添加到频道")

        existing = await self.repo.get_membership(channel_id, member_id)
        if existing:
            return existing
        m = await self.repo.add_member(channel_id, member_id, member_type, added_by=current_user.user_id)
        if member_type == "bot":
            from app.services.openclaw_bridge.membership import emit_channel_joined
            await emit_channel_joined(
                self.session, bot_id=member_id, channel_id=channel_id,
                invited_by=current_user.user_id,
            )
        return m

    async def invite_by_identifier(
        self,
        channel_id: str,
        identifier: str,
        current_user: User,
    ) -> dict:
        await self.get_or_404(channel_id)
        await self._require_channel_member(channel_id, current_user)

        user = await self.user_repo.get_by_id(identifier)
        if not user:
            user = await self.user_repo.get_by_username(identifier)
        if not user:
            raise NotFoundError("用户不存在")

        if await self.repo.get_membership(channel_id, user.user_id):
            raise BadRequestError("用户已在频道中")

        await self.repo.add_member(channel_id, user.user_id, "user", added_by=current_user.user_id)
        return {
            "user_id": user.user_id,
            "username": user.username,
            "display_name": user.display_name,
            "avatar_url": user.avatar_url,
        }

    async def remove_member(self, channel_id: str, member_id: str, current_user: User) -> None:
        await self.get_or_404(channel_id)
        m = await self.repo.get_membership(channel_id, member_id)
        if not m:
            raise NotFoundError("membership not found")

        if not is_admin(current_user):
            from app.services.guide.constants import GUIDE_BOT_ID
            if member_id == GUIDE_BOT_ID:
                raise ForbiddenError("内置助手只能由管理员移除")
            if m.member_type == "user" and member_id != current_user.user_id:
                raise ForbiddenError("只能移除自己")
            if m.member_type == "bot":
                bot = await self.bot_repo.get_by_id(member_id)
                if not bot or bot.created_by != current_user.user_id:
                    raise ForbiddenError("只能移除自己创建的 Bot")

        await self.repo.remove_member(m)
        if m.member_type == "bot":
            from app.services.openclaw_bridge.membership import emit_channel_left
            reason = "kicked" if current_user.user_id != member_id else "left"
            await emit_channel_left(
                self.session, bot_id=member_id, channel_id=channel_id, reason=reason,
            )

    async def update_member_template(
        self,
        channel_id: str,
        member_id: str,
        template_id: str | None,
        current_user: User,
    ) -> dict:
        """设置频道内某个 Bot 成员的提示词模板覆盖。仅 Bot 创建者或管理员可操作。"""
        await self.get_or_404(channel_id)
        await self._require_channel_member(channel_id, current_user)

        m = await self.repo.get_membership(channel_id, member_id)
        if not m:
            raise NotFoundError("membership not found")
        if m.member_type != "bot":
            raise BadRequestError("只能为 Bot 成员设置提示词模板")

        if not is_admin(current_user):
            bot = await self.bot_repo.get_by_id(member_id)
            if not bot or bot.created_by != current_user.user_id:
                raise ForbiddenError("只有 Bot 的创建者才能修改其提示词模板")

        if template_id:
            tmpl = (await self.session.execute(
                select(PromptTemplate).where(PromptTemplate.template_id == template_id)
            )).scalar_one_or_none()
            if not tmpl:
                raise NotFoundError("提示词模板不存在")

        m.template_id = template_id
        await self.session.flush()
        # reload to get the relationship
        await self.session.refresh(m)
        return {
            "channel_id": m.channel_id,
            "member_id": m.member_id,
            "template_id": m.template_id,
            "template_name": m.prompt_template.name if m.prompt_template else None,
        }

    async def get_friends_to_invite(self, channel_id: str, current_user: User) -> list[dict]:
        """返回当前用户的好友中尚未加入频道的列表."""
        user_id = current_user.user_id
        existing = await self.session.execute(
            select(ChannelMembership.member_id).where(ChannelMembership.channel_id == channel_id)
        )
        member_ids = {row[0] for row in existing.all()}

        result = await self.session.execute(
            select(Friendship, User)
            .join(
                User,
                or_(
                    and_(Friendship.friend_id == User.user_id, Friendship.user_id == user_id),
                    and_(Friendship.user_id == User.user_id, Friendship.friend_id == user_id),
                ),
            )
            .where(
                or_(
                    and_(Friendship.user_id == user_id, Friendship.status == "accepted"),
                    and_(Friendship.friend_id == user_id, Friendship.status == "accepted"),
                ),
                User.user_id.notin_(member_ids) if member_ids else True,
            )
        )
        return [
            {
                "user_id": u.user_id,
                "username": u.username,
                "display_name": u.display_name,
                "avatar_url": u.avatar_url,
            }
            for _, u in result.all()
        ]

    # ---- Channel Profile ----

    async def get_my_profile(self, channel_id: str, user_id: str) -> dict:
        result = await self.session.execute(
            select(ChannelProfile).where(
                ChannelProfile.channel_id == channel_id,
                ChannelProfile.user_id == user_id,
            )
        )
        profile = result.scalar_one_or_none()
        return {
            "channel_id": channel_id,
            "user_id": user_id,
            "nickname": profile.nickname if profile else None,
            "bio": profile.bio if profile else None,
        }

    async def update_my_profile(
        self,
        channel_id: str,
        user_id: str,
        nickname: str | None = None,
        bio: str | None = None,
    ) -> dict:
        result = await self.session.execute(
            select(ChannelProfile).where(
                ChannelProfile.channel_id == channel_id,
                ChannelProfile.user_id == user_id,
            )
        )
        profile = result.scalar_one_or_none()
        if not profile:
            profile = ChannelProfile(channel_id=channel_id, user_id=user_id)
            self.session.add(profile)
        if nickname is not None:
            profile.nickname = nickname or None
        if bio is not None:
            profile.bio = bio or None
        await self.session.flush()
        return {
            "channel_id": channel_id,
            "user_id": user_id,
            "nickname": profile.nickname,
            "bio": profile.bio,
        }
