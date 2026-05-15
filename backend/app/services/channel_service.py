"""Channel 业务逻辑层."""
from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import cast
from uuid import uuid4

from sqlalchemy import and_, delete, or_, select, true
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import BadRequestError, ForbiddenError, NotFoundError
from app.db.models import (
    AgentNexusSession,
    AgentNexusSessionBinding,
    AgentTask,
    BotAccount,
    BotRun,
    Channel,
    ChannelMembership,
    ChannelProfile,
    FileRecord,
    Friendship,
    HistoryPage,
    MemoryEntry,
    Message,
    PromptTemplate,
    TodoItem,
    User,
    WorkspaceMembership,
)
from app.repositories.bot_repo import BotRepository
from app.repositories.channel_repo import ChannelRepository
from app.repositories.user_repo import UserRepository
from app.repositories.workspace_repo import WorkspaceRepository
from app.services.bot_service import BotService, bot_scope
from app.services.unread_count_service import set_unread_count
from app.services.unread_count_service import unread_counts_for as cached_unread_counts_for
from app.utils.permissions import are_accepted_friends, is_admin, is_blocked_between

CHANNEL_ADMIN_ROLES = {"owner", "admin"}
CHANNEL_MEMBER_ROLES = CHANNEL_ADMIN_ROLES | {"member"}
WORKSPACE_CHANNEL_TYPES = {"public", "workspace"}
CHANNEL_TYPE_ALIASES = {
    "public": "public",
    "workspace": "public",
    "private": "private",
    "dm": "dm",
}
PERSONAL_PROJECT_PURPOSE_KIND = "personal_project_chat"


def _clean_short_text(value: str | None, fallback: str | None = None) -> str | None:
    cleaned = (value or "").strip()
    if not cleaned:
        return fallback
    return cleaned[:80]


def _personal_project_purpose(
    *,
    project_id: str,
    project_title: str,
    chat_title: str,
) -> str:
    return json.dumps(
        {
            "kind": PERSONAL_PROJECT_PURPOSE_KIND,
            "project_id": project_id,
            "project_title": project_title,
            "chat_title": chat_title,
        },
        ensure_ascii=False,
        separators=(",", ":"),
    )


def _parse_personal_project_purpose(value: str | None) -> dict[str, str | None]:
    if not value:
        return {"project_id": None, "project_title": None, "chat_title": None}
    try:
        payload = json.loads(value)
    except (TypeError, ValueError):
        return {
            "project_id": None,
            "project_title": None,
            "chat_title": _clean_short_text(value),
        }
    if not isinstance(payload, dict) or payload.get("kind") != PERSONAL_PROJECT_PURPOSE_KIND:
        return {
            "project_id": None,
            "project_title": None,
            "chat_title": _clean_short_text(value),
        }
    return {
        "project_id": _clean_short_text(payload.get("project_id")),
        "project_title": _clean_short_text(payload.get("project_title")),
        "chat_title": _clean_short_text(payload.get("chat_title")),
    }


def normalize_channel_type(value: str | None) -> str:
    raw = (value or "public").strip().lower()
    normalized = CHANNEL_TYPE_ALIASES.get(raw)
    if not normalized:
        raise BadRequestError("频道类型必须是 workspace、private 或 dm")
    return normalized


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
        # Rail "Channels" section — only named channels, DMs live in their own
        # list via list_dms_for_user / GET /api/v1/dms.
        return await self.repo.list_for_user(user.user_id, include_dms=False)

    async def list_for_user_in_workspace(self, workspace_id: str, user: User) -> list[Channel]:
        return await self.repo.list_for_user_in_workspace(
            workspace_id, user.user_id, include_dms=False
        )

    async def list_dms_for_user(self, user: User) -> list[Channel]:
        return await self.repo.list_dms_for_user(user.user_id)

    async def get_or_create_dm(
        self,
        workspace_id: str,
        current_user: User,
        other_id: str,
        other_type: str,
        create_new: bool = False,
        title: str | None = None,
        project_id: str | None = None,
        project_title: str | None = None,
        chat_title: str | None = None,
    ) -> Channel:
        """Return an existing 1:1 DM channel between current_user and (other)
        in the given workspace, or create one on first request. Idempotent."""
        if other_type not in ("user", "bot"):
            raise BadRequestError("member_type must be 'user' or 'bot'")
        if create_new and other_type != "bot":
            raise BadRequestError("only bot chats support create_new")
        if other_type == "user" and other_id == current_user.user_id:
            raise BadRequestError("cannot DM yourself")

        # Workspace membership is the only access gate right now.
        wm = await self.ws_repo.get_membership(workspace_id, current_user.user_id)
        if not wm and not is_admin(current_user):
            raise ForbiddenError("not a member of this workspace")

        # Resolve the counterparty exists.
        if other_type == "user":
            other = await self.user_repo.get_by_id(other_id)
        else:
            other = await self.bot_repo.get_by_id(other_id)
        if not other:
            raise NotFoundError("DM counterparty not found")

        if other_type == "user":
            if await is_blocked_between(self.session, current_user.user_id, other_id):
                raise ForbiddenError("无法与该用户发起私信")
            if not is_admin(current_user) and not await are_accepted_friends(
                self.session, current_user.user_id, other_id
            ):
                raise ForbiddenError("只能与好友发起私信")

        if not create_new:
            # Look for an existing DM channel with exactly these two members.
            from sqlalchemy.orm import aliased

            m1 = aliased(ChannelMembership)
            m2 = aliased(ChannelMembership)
            existing = (await self.session.execute(
                select(Channel)
                .join(m1, m1.channel_id == Channel.channel_id)
                .join(m2, m2.channel_id == Channel.channel_id)
                .where(
                    Channel.workspace_id == workspace_id,
                    Channel.type == "dm",
                    m1.member_id == current_user.user_id,
                    m1.member_type == "user",
                    m2.member_id == other_id,
                    m2.member_type == other_type,
                    Channel.name.notlike("dmchat:%"),
                )
                .limit(1)
            )).scalar_one_or_none()
            if existing:
                return existing

        if other_type == "bot":
            await BotService(self.session).assert_can_use(
                cast(BotAccount, other),
                current_user,
                "无权与该 Bot 发起私信",
            )

        if create_new:
            name = f"dmchat:{current_user.user_id}:{other_id}:{uuid4()}"[:255]
            resolved_project_id = _clean_short_text(project_id) or f"project:{uuid4()}"
            resolved_project_title = (
                _clean_short_text(project_title)
                or "Project"
            )
            resolved_chat_title = (
                _clean_short_text(chat_title)
                or _clean_short_text(title)
                or "Chat 1"
            )
            purpose = _personal_project_purpose(
                project_id=resolved_project_id,
                project_title=resolved_project_title,
                chat_title=resolved_chat_title,
            )
        else:
            # Deterministic name for dedup debugging; display comes from counterparty.
            a, b = sorted([current_user.user_id, other_id])
            name = f"dm:{a}:{b}"[:255]
            purpose = None
        ch = await self.repo.create(
            workspace_id=workspace_id, name=name, type="dm", purpose=purpose,
        )
        await self.repo.add_member(
            ch.channel_id, current_user.user_id, "user", added_by=current_user.user_id,
        )
        await self.repo.add_member(
            ch.channel_id, other_id, other_type, added_by=current_user.user_id,
        )
        return ch

    async def list_dms_with_counterparty(self, user: User) -> list[dict]:
        """Returns each of the user's DM channels paired with the other
        member's profile — the shape used by the rail's Direct section."""
        dms = await self.repo.list_dms_for_user(user.user_id)
        out: list[dict] = []
        for ch in dms:
            members = await self.repo.list_memberships(ch.channel_id)
            other = next(
                (
                    m for m in members
                    if not (m.member_id == user.user_id and m.member_type == "user")
                ),
                None,
            )
            if not other:
                continue
            if other.member_type == "bot":
                bot = await self.bot_repo.get_by_id(other.member_id)
                if not bot:
                    continue
                project_meta = _parse_personal_project_purpose(ch.purpose)
                cp = {
                    "member_id": bot.bot_id,
                    "member_type": "bot",
                    "username": bot.username,
                    "display_name": bot.display_name,
                    "avatar_url": bot.avatar_url,
                }
                session_scope_id = (
                    ch.channel_id
                    if ch.name.startswith("dmchat:")
                    else f"user:{user.user_id}:bot:{bot.bot_id}"
                )
            elif other.member_type == "system":
                from app.services.friendship_service import (
                    FRIEND_NOTICE_DISPLAY_NAME,
                    FRIEND_NOTICE_SYSTEM_ID,
                    FRIEND_NOTICE_USERNAME,
                )
                if other.member_id != FRIEND_NOTICE_SYSTEM_ID:
                    continue
                cp = {
                    "member_id": FRIEND_NOTICE_SYSTEM_ID,
                    "member_type": "system",
                    "username": FRIEND_NOTICE_USERNAME,
                    "display_name": FRIEND_NOTICE_DISPLAY_NAME,
                    "avatar_url": None,
                }
                session_scope_id = None
                project_meta = {"project_id": None, "project_title": None, "chat_title": None}
            else:
                u = await self.user_repo.get_by_id(other.member_id)
                if not u:
                    continue
                cp = {
                    "member_id": u.user_id,
                    "member_type": "user",
                    "username": u.username,
                    "display_name": u.display_name,
                    "avatar_url": u.avatar_url,
                }
                session_scope_id = None
                project_meta = {"project_id": None, "project_title": None, "chat_title": None}
            out.append(
                {
                    "channel_id": ch.channel_id,
                    "workspace_id": ch.workspace_id,
                    "counterparty": cp,
                    "title": project_meta.get("chat_title"),
                    "project_id": project_meta.get("project_id"),
                    "project_title": project_meta.get("project_title"),
                    "chat_title": project_meta.get("chat_title"),
                    "session_scope_id": session_scope_id,
                    "created_at": ch.created_at,
                }
            )
        return out

    async def unread_counts_for(
        self, user_id: str, channel_ids: list[str]
    ) -> dict[str, int]:
        """Per-channel unread count for a user.

        Prefer the incremental cache; missing cache rows are computed from
        channel_memberships.last_read_at and backfilled for compatibility with
        pre-cache deployments.
        """
        return await cached_unread_counts_for(
            self.session,
            user_id=user_id,
            channel_ids=channel_ids,
        )

    async def mark_read(self, channel_id: str, user_id: str) -> datetime | None:
        """Move the user's read cursor to "now" for this channel. Returns the
        new timestamp, or None if the user isn't a member of the channel."""
        m = await self.repo.get_membership(channel_id, user_id)
        if not m or m.member_type != "user":
            return None
        now = datetime.now(timezone.utc)
        m.last_read_at = now
        await set_unread_count(
            self.session,
            channel_id=channel_id,
            user_id=user_id,
            unread_count=0,
        )
        await self.session.flush()
        return now

    async def create(
        self,
        workspace_id: str,
        name: str,
        type: str = "public",
        purpose: str | None = None,
        allow_member_invites: bool | None = None,
        allow_bot_adds: bool | None = None,
        creator: User | None = None,
    ) -> Channel:
        ws = await self.ws_repo.get_by_id(workspace_id)
        if not ws:
            raise NotFoundError("workspace not found")
        if creator is None:
            raise ForbiddenError("未登录")
        wm = await self.ws_repo.get_membership(workspace_id, creator.user_id)
        if not wm and not is_admin(creator):
            raise ForbiddenError("您不是该工作空间的成员")

        type = normalize_channel_type(type)
        ch = await self.repo.create(
            workspace_id=workspace_id,
            name=name,
            type=type,
            purpose=purpose,
            allow_member_invites=allow_member_invites,
            allow_bot_adds=allow_bot_adds,
        )

        added_user_ids = set()
        if type in WORKSPACE_CHANNEL_TYPES:
            # Built-in bots automatically join workspace channels; private channels and DMs do not receive Helper.
            from app.features.bot_runtime.builtin_ids import BUILTIN_BOT_IDS

            for bot_id in BUILTIN_BOT_IDS:
                if not await self.repo.get_membership(ch.channel_id, bot_id):
                    await self.repo.add_member(ch.channel_id, bot_id, "bot")

            # All workspace members automatically join workspace channels.
            ws_members = await self.ws_repo.list_members(workspace_id)
            for wm in ws_members:
                if not await self.repo.get_membership(ch.channel_id, wm.user_id):
                    role = (
                        "owner"
                        if wm.user_id == creator.user_id
                        else "admin"
                        if wm.role in ("owner", "admin")
                        else "member"
                    )
                    await self.repo.add_member(ch.channel_id, wm.user_id, "user", role=role)
                added_user_ids.add(wm.user_id)

        # If the creator is not currently a workspace member.
        if creator and creator.user_id not in added_user_ids:
            if not await self.repo.get_membership(ch.channel_id, creator.user_id):
                role = "owner" if type != "dm" else "member"
                await self.repo.add_member(ch.channel_id, creator.user_id, "user", role=role)
        elif creator and type != "dm":
            creator_membership = await self.repo.get_membership(ch.channel_id, creator.user_id)
            if creator_membership and creator_membership.member_type == "user":
                creator_membership.role = "owner"

        return ch

    async def update(self, channel_id: str, current_user: User, **kwargs) -> Channel:
        ch = await self.get_or_404(channel_id)
        await self._require_channel_admin(ch, current_user)
        if "type" in kwargs:
            kwargs["type"] = normalize_channel_type(kwargs["type"])
        return await self.repo.update(ch, **kwargs)

    async def delete(self, channel_id: str, current_user: User) -> None:
        ch = await self.get_or_404(channel_id)
        # Only workspace owners/admins may delete channels.
        wm = await self.ws_repo.get_membership(ch.workspace_id, current_user.user_id)
        if not is_admin(current_user) and (not wm or wm.role not in ("owner", "admin")):
            raise ForbiddenError("只有工作空间管理员可以删除频道")

        # Channel deletion first removes dependent rows that reference channels.
        # PostgreSQL strictly rejects deletes while session bindings, todos, profiles,
        # or similar rows still reference the channel, so this endpoint handles cleanup
        # instead of relying on every table to define database cascades.
        binding_condition = or_(
            AgentNexusSessionBinding.channel_id == channel_id,
            and_(
                AgentNexusSessionBinding.scope_type == "channel",
                AgentNexusSessionBinding.scope_id == channel_id,
            ),
            and_(
                AgentNexusSessionBinding.scope_type == "dm",
                AgentNexusSessionBinding.scope_id == channel_id,
            ),
        )
        session_rows = await self.session.execute(
            select(AgentNexusSessionBinding.session_id).where(binding_condition)
        )
        session_ids = set(session_rows.scalars().all())
        current_scope_rows = await self.session.execute(
            select(AgentNexusSession.session_id).where(
                AgentNexusSession.current_scope_type.in_(("channel", "dm")),
                AgentNexusSession.current_scope_id == channel_id,
            )
        )
        session_ids.update(current_scope_rows.scalars().all())
        if session_ids:
            session_id_list = list(session_ids)
            await self.session.execute(
                delete(AgentNexusSessionBinding).where(binding_condition)
            )
            await self.session.execute(
                delete(AgentNexusSession).where(
                    AgentNexusSession.session_id.in_(session_id_list)
                )
            )

        # Some of these tables do not have channel foreign keys, but they still belong
        # to channel runtime/memory state. Leaving them would leak deleted channels into
        # search, background tasks, and memory pages.
        await self.session.execute(
            delete(BotRun).where(BotRun.channel_id == channel_id)
        )
        await self.session.execute(
            delete(AgentTask).where(AgentTask.channel_id == channel_id)
        )
        await self.session.execute(
            delete(MemoryEntry).where(MemoryEntry.channel_id == channel_id)
        )
        await self.session.execute(
            delete(ChannelProfile).where(ChannelProfile.channel_id == channel_id)
        )
        await self.session.execute(
            delete(TodoItem).where(TodoItem.channel_id == channel_id)
        )
        await self.session.execute(
            delete(HistoryPage).where(HistoryPage.channel_id == channel_id)
        )
        from app.db.models import ChannelUnreadCount

        await self.session.execute(
            delete(ChannelUnreadCount).where(ChannelUnreadCount.channel_id == channel_id)
        )

        # Cascade-delete memberships, messages, and file records.
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

    async def require_channel_member(self, channel_id: str, user: User) -> None:
        """Public access guard for routes that expose channel-scoped data."""
        await self.get_or_404(channel_id)
        await self._require_channel_member(channel_id, user)

    async def require_channel_member_or_manager(self, channel_id: str, user: User) -> Channel:
        """Allow channel members and workspace/channel/global managers to read channel metadata."""
        channel = await self.get_or_404(channel_id)
        if is_admin(user):
            return channel
        membership = await self.repo.get_membership(channel_id, user.user_id)
        if membership and membership.member_type == "user":
            return channel
        if await self._is_workspace_admin(channel, user):
            return channel
        raise ForbiddenError("您不是该频道的成员")

    async def require_can_send_message(self, channel_id: str, user: User) -> None:
        """Guard message sends, adding DM-specific friendship/privacy rules."""
        channel = await self.get_or_404(channel_id)
        if channel.type != "dm":
            await self._require_channel_member(channel_id, user)
            return

        membership = await self.repo.get_membership(channel_id, user.user_id)
        if not membership or membership.member_type != "user":
            raise ForbiddenError("您不是该私信成员")

        members = await self.repo.list_memberships(channel_id)
        other = next(
            (
                m for m in members
                if not (m.member_id == user.user_id and m.member_type == "user")
            ),
            None,
        )
        if not other:
            raise ForbiddenError("私信成员异常")
        if other.member_type == "system":
            raise ForbiddenError("系统通知会话不能直接发送消息")
        if other.member_type == "user":
            if await is_blocked_between(self.session, user.user_id, other.member_id):
                raise ForbiddenError("无法向该用户发送私信")
            if not is_admin(user) and not await are_accepted_friends(self.session, user.user_id, other.member_id):
                raise ForbiddenError("只能与好友发送私信")

    async def _is_workspace_admin(self, channel: Channel, user: User) -> bool:
        wm = await self.ws_repo.get_membership(channel.workspace_id, user.user_id)
        return bool(wm and wm.role in ("owner", "admin"))

    async def _require_workspace_admin(self, channel: Channel, user: User) -> None:
        if is_admin(user):
            return
        if not await self._is_workspace_admin(channel, user):
            raise ForbiddenError("只有工作空间管理员可以执行此操作")

    async def _is_channel_admin(self, channel: Channel, user: User) -> bool:
        if is_admin(user):
            return True
        m = await self.repo.get_membership(channel.channel_id, user.user_id)
        if m and m.member_type == "user" and (m.role or "member") in CHANNEL_ADMIN_ROLES:
            return True
        return await self._is_workspace_admin(channel, user)

    async def _is_channel_member(self, channel: Channel, user: User) -> bool:
        if is_admin(user):
            return True
        m = await self.repo.get_membership(channel.channel_id, user.user_id)
        return bool(m and m.member_type == "user")

    async def _require_channel_admin(self, channel: Channel, user: User) -> None:
        if not await self._is_channel_admin(channel, user):
            raise ForbiddenError("只有频道管理员可以执行此操作")

    async def require_channel_admin(self, channel_id: str, user: User) -> Channel:
        channel = await self.get_or_404(channel_id)
        await self._require_channel_admin(channel, user)
        return channel

    def _ensure_not_dm_for_member_add(self, channel: Channel) -> None:
        if channel.type == "dm":
            raise BadRequestError("私信不支持邀请成员或添加 Bot")

    async def _can_invite_members(self, channel: Channel, user: User) -> bool:
        if channel.type == "dm":
            return False
        if await self._is_channel_admin(channel, user):
            return True
        return bool(channel.allow_member_invites and await self._is_channel_member(channel, user))

    async def _can_add_bots(self, channel: Channel, user: User) -> bool:
        if channel.type == "dm":
            return False
        if await self._is_channel_admin(channel, user):
            return True
        return bool(channel.allow_bot_adds and await self._is_channel_member(channel, user))

    async def _require_can_invite_members(self, channel: Channel, user: User) -> None:
        if not await self._can_invite_members(channel, user):
            raise ForbiddenError("当前频道仅管理员可以邀请成员")

    async def _require_can_add_bots(self, channel: Channel, user: User) -> None:
        if not await self._can_add_bots(channel, user):
            raise ForbiddenError("当前频道仅管理员可以添加 Bot")

    async def channel_permission_summary(self, channel: Channel, user: User) -> dict:
        """Return caller's channel role and channel-scoped capabilities."""
        if is_admin(user):
            if channel.type == "dm":
                return {
                    "my_role": "system_admin",
                    "can_manage": True,
                    "can_invite_members": False,
                    "can_add_bots": False,
                }
            return {
                "my_role": "system_admin",
                "can_manage": True,
                "can_invite_members": True,
                "can_add_bots": True,
            }
        membership = await self.repo.get_membership(channel.channel_id, user.user_id)
        role = None
        if membership and membership.member_type == "user":
            role = membership.role or "member"
        workspace_admin = await self._is_workspace_admin(channel, user)
        can_manage = bool(role in CHANNEL_ADMIN_ROLES or workspace_admin)
        is_member = bool(role)
        if channel.type == "dm":
            can_invite_members = False
            can_add_bots = False
        else:
            can_invite_members = can_manage or bool(channel.allow_member_invites and is_member)
            can_add_bots = can_manage or bool(channel.allow_bot_adds and is_member)
        if workspace_admin and role not in CHANNEL_ADMIN_ROLES:
            role = "workspace_admin"
        return {
            "my_role": role,
            "can_manage": can_manage,
            "can_invite_members": can_invite_members,
            "can_add_bots": can_add_bots,
        }

    async def _ensure_another_channel_admin(self, channel_id: str, member_id: str) -> None:
        memberships = await self.repo.list_memberships(channel_id)
        has_other_admin = any(
            m.member_type == "user"
            and m.member_id != member_id
            and (m.role or "member") in CHANNEL_ADMIN_ROLES
            for m in memberships
        )
        if not has_other_admin:
            raise ForbiddenError("频道至少需要保留一位管理员")

    async def list_members_with_details(
        self,
        channel_id: str,
        current_user: User | None = None,
    ) -> list[dict]:
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
        from app.services.ws_service import ws_manager

        online_user_ids = await ws_manager.connected_user_ids(user_ids)
        owner_ids = {b.created_by for b in bots_by_id.values() if b.created_by}
        inviter_ids = {m.added_by for m in memberships if m.added_by}
        missing_user_ids = (owner_ids | inviter_ids) - set(users_by_id)
        if missing_user_ids:
            rows = (await self.session.execute(
                select(User).where(User.user_id.in_(missing_user_ids))
            )).scalars()
            users_by_id.update({u.user_id: u for u in rows})

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
                "role": m.role or "member",
                "added_by": m.added_by,
                "username": entity.username,
                "display_name": entity.display_name,
                "avatar_url": entity.avatar_url,
            }
            inviter = users_by_id.get(m.added_by or "")
            item["inviter"] = (
                {
                    "user_id": inviter.user_id,
                    "username": inviter.username,
                    "display_name": inviter.display_name,
                }
                if inviter
                else None
            )
            if m.member_type == "bot":
                bot_entity: BotAccount = entity
                item["template_id"] = m.template_id
                item["can_manage_template"] = bool(
                    current_user
                    and (
                        is_admin(current_user)
                        or (m.added_by is not None and m.added_by == current_user.user_id)
                    )
                )
                if m.prompt_template:
                    item["template_name"] = m.prompt_template.name
                else:
                    item["template_name"] = (
                        bot_entity.prompt_template.name if bot_entity.prompt_template else None
                    )
                item["status"] = bot_entity.status
                item["scope"] = bot_scope(bot_entity)
                owner = users_by_id.get(bot_entity.created_by or "")
                item["owner"] = (
                    {
                        "user_id": owner.user_id,
                        "username": owner.username,
                        "display_name": owner.display_name,
                    }
                    if owner
                    else None
                )
                item["binding_type"] = getattr(bot_entity, "binding_type", None) or "http"
                if item["binding_type"] == "agent_bridge":
                    from app.features.agent_bridge.registry import bot_session_registry

                    live_state = bot_session_registry.connection_state(bot_entity.bot_id)
                    item.update(live_state)
                    item["is_online"] = bool(bot_entity.status != "offline" and live_state["is_online"])
                else:
                    item.update({
                        "connection_status": "not_required",
                        "is_online": bot_entity.status != "offline",
                        "control_connected": None,
                        "data_connected": None,
                    })
            else:
                is_online = m.member_id in online_user_ids
                item["status"] = "online" if is_online else "offline"
                item["is_online"] = is_online
            result.append(item)
        return result

    async def add_member(
        self,
        channel_id: str,
        member_id: str,
        member_type: str,
        current_user: User,
    ) -> ChannelMembership:
        channel = await self.get_or_404(channel_id)
        self._ensure_not_dm_for_member_add(channel)
        if member_type == "user":
            await self._require_can_invite_members(channel, current_user)
        elif member_type == "bot":
            await self._require_can_add_bots(channel, current_user)
        else:
            raise BadRequestError("member_type must be 'user' or 'bot'")

        existing = await self.repo.get_membership(channel_id, member_id)
        if existing:
            return existing

        if member_type == "bot":
            bot = await self.bot_repo.get_by_id(member_id)
            if not bot:
                raise NotFoundError("Bot 不存在")
            await BotService(self.session).assert_can_use(
                bot,
                current_user,
                "无权邀请该 Bot 进入频道",
            )
        else:
            user = await self.user_repo.get_by_id(member_id)
            if not user:
                raise NotFoundError("用户不存在")
            workspace_membership = await self.ws_repo.get_membership(channel.workspace_id, user.user_id)
            if not workspace_membership:
                raise BadRequestError("用户不是该工作空间成员，请先邀请进入工作空间")

        m = await self.repo.add_member(channel_id, member_id, member_type, added_by=current_user.user_id)
        if member_type == "bot":
            from app.features.agent_bridge.membership import emit_channel_joined
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
        channel = await self.get_or_404(channel_id)
        self._ensure_not_dm_for_member_add(channel)
        await self._require_can_invite_members(channel, current_user)

        user = await self.user_repo.get_by_id(identifier)
        if not user:
            user = await self.user_repo.get_by_username(identifier)
        if not user:
            raise NotFoundError("用户不存在")

        if await self.repo.get_membership(channel_id, user.user_id):
            raise BadRequestError("用户已在频道中")
        workspace_membership = await self.ws_repo.get_membership(channel.workspace_id, user.user_id)
        if not workspace_membership:
            raise BadRequestError("用户不是该工作空间成员，请先邀请进入工作空间")

        await self.repo.add_member(channel_id, user.user_id, "user", added_by=current_user.user_id)
        return {
            "user_id": user.user_id,
            "username": user.username,
            "display_name": user.display_name,
            "avatar_url": user.avatar_url,
        }

    async def remove_member(self, channel_id: str, member_id: str, current_user: User) -> None:
        channel = await self.get_or_404(channel_id)
        await self._require_channel_admin(channel, current_user)
        m = await self.repo.get_membership(channel_id, member_id)
        if not m:
            raise NotFoundError("membership not found")

        if not is_admin(current_user):
            from app.features.bot_runtime.builtin_ids import BUILTIN_BOT_IDS

            if member_id in BUILTIN_BOT_IDS:
                raise ForbiddenError("内置助手只能由管理员移除")

        if m.member_type == "user" and (m.role or "member") in CHANNEL_ADMIN_ROLES:
            await self._ensure_another_channel_admin(channel_id, member_id)

        await self.repo.remove_member(m)
        if m.member_type == "bot":
            from app.features.agent_bridge.membership import emit_channel_left
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
        """设置频道内某个 Bot 成员的提示词模板覆盖。权限归邀请该 Bot 入频道的人。"""
        await self.get_or_404(channel_id)

        m = await self.repo.get_membership(channel_id, member_id)
        if not m:
            raise NotFoundError("membership not found")
        if m.member_type != "bot":
            raise BadRequestError("只能为 Bot 成员设置提示词模板")

        bot = await self.bot_repo.get_by_id(member_id)
        if not bot:
            raise NotFoundError("Bot 不存在")
        if not is_admin(current_user) and m.added_by != current_user.user_id:
            raise ForbiddenError("只有邀请该 Bot 入频道的人可以修改其频道提示词模板")

        if template_id:
            tmpl = (await self.session.execute(
                select(PromptTemplate).where(PromptTemplate.template_id == template_id)
            )).scalar_one_or_none()
            if not tmpl:
                raise NotFoundError("提示词模板不存在")
            if (
                not is_admin(current_user)
                and not tmpl.is_builtin
                and tmpl.created_by is not None
                and tmpl.created_by != current_user.user_id
            ):
                raise ForbiddenError("只能使用自己可见的提示词模板")

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

    async def update_member_role(
        self,
        channel_id: str,
        member_id: str,
        role: str,
        current_user: User,
    ) -> dict:
        """更新频道内用户成员的频道角色。"""
        channel = await self.get_or_404(channel_id)
        await self._require_channel_admin(channel, current_user)
        if role not in CHANNEL_MEMBER_ROLES:
            raise BadRequestError("role must be one of: owner, admin, member")

        m = await self.repo.get_membership(channel_id, member_id)
        if not m:
            raise NotFoundError("membership not found")
        if m.member_type != "user":
            raise BadRequestError("只能调整用户成员的频道角色")

        old_role = m.role or "member"
        if old_role in CHANNEL_ADMIN_ROLES and role not in CHANNEL_ADMIN_ROLES:
            await self._ensure_another_channel_admin(channel_id, member_id)

        m.role = role
        await self.session.flush()
        return {
            "channel_id": m.channel_id,
            "member_id": m.member_id,
            "member_type": m.member_type,
            "role": m.role,
        }

    async def get_friends_to_invite(self, channel_id: str, current_user: User) -> list[dict]:
        """返回当前用户的好友中尚未加入频道的列表."""
        channel = await self.get_or_404(channel_id)
        self._ensure_not_dm_for_member_add(channel)
        await self._require_can_invite_members(channel, current_user)
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
            .join(WorkspaceMembership, WorkspaceMembership.user_id == User.user_id)
            .where(
                or_(
                    and_(Friendship.user_id == user_id, Friendship.status == "accepted"),
                    and_(Friendship.friend_id == user_id, Friendship.status == "accepted"),
                ),
                WorkspaceMembership.workspace_id == channel.workspace_id,
                User.user_id.notin_(member_ids) if member_ids else true(),
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
