"""Friendship service module."""
from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from app.core.exceptions import BadRequestError, ForbiddenError, NotFoundError
from app.db.models import Channel, ChannelMembership, Friendship, Message, User
from app.repositories.channel_repo import ChannelRepository
from app.repositories.friendship_repo import FriendshipRepository, friendship_pair_key
from app.repositories.user_repo import UserRepository
from app.services.workspace_service import WorkspaceService
from app.services.ws_service import ws_manager

FRIEND_NOTICE_SYSTEM_ID = "system:friend_requests"
FRIEND_NOTICE_USERNAME = "friend-notice"
FRIEND_NOTICE_DISPLAY_NAME = "好友通知"
FRIEND_REQUEST_MSG_TYPE = "friend_request"


class FriendshipService:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session
        self.repo = FriendshipRepository(session)
        self.user_repo = UserRepository(session)
        self.channel_repo = ChannelRepository(session)

    # ---- Query helpers -------------------------------------------------

    async def search_users(self, query: str, current_user: User, limit: int = 20) -> list[dict]:
        """Search users."""
        q = query.strip()
        if not q:
            return []

        exact = await self.user_repo.get_by_id(q)
        users: list[User]
        if exact and exact.user_id != current_user.user_id and not exact.is_deleted:
            users = [exact]
        else:
            pattern = f"%{q}%"
            result = await self.session.execute(
                select(User)
                .where(
                    User.user_id != current_user.user_id,
                    User.is_deleted == False,  # noqa: E712
                    or_(User.username.ilike(pattern), User.display_name.ilike(pattern)),
                )
                .order_by(User.display_name, User.username)
                .limit(limit)
            )
            users = list(result.scalars().all())

        out: list[dict] = []
        for user in users:
            summary = await self.relationship_summary(current_user.user_id, user.user_id)
            out.append(self._user_payload(user) | summary)
        return out

    async def relationship_summary(self, current_user_id: str, other_id: str) -> dict:
        friendship = await self.repo.get_by_pair(current_user_id, other_id)
        if not friendship:
            return {"relationship_status": "none", "direction": None, "friendship_id": None}
        direction: str | None = None
        if friendship.status == "pending":
            direction = "outgoing" if friendship.user_id == current_user_id else "incoming"
        elif friendship.status == "blocked":
            direction = "blocked_by_me" if friendship.user_id == current_user_id else "blocked_by_them"
        elif friendship.status in {"accepted", "rejected"}:
            direction = "outgoing" if friendship.user_id == current_user_id else "incoming"
        return {
            "relationship_status": friendship.status,
            "direction": direction,
            "friendship_id": friendship.friendship_id,
        }

    async def list_friends(self, user_id: str) -> list[dict]:
        friends_data = await self.repo.list_friends(user_id)
        return [
            self._friend_payload(user_id, fs, u)
            for fs, u in friends_data
        ]

    async def list_requests(self, current_user: User, box: str) -> list[dict]:
        if box not in {"incoming", "outgoing"}:
            raise BadRequestError("box must be incoming or outgoing")
        rows = await self.repo.list_requests(current_user.user_id, box)
        return [self._request_payload(current_user.user_id, fs, u) for fs, u in rows]

    async def list_blocked(self, current_user: User) -> list[dict]:
        rows = await self.repo.list_blocked(current_user.user_id)
        return [self._request_payload(current_user.user_id, fs, u) for fs, u in rows]

    # ---- State machine -------------------------------------------------

    async def request_friend(self, current_user: User, friend_identifier: str) -> dict:
        target = await self._resolve_target(friend_identifier)
        self._ensure_not_self(current_user.user_id, target.user_id)

        existing = await self.repo.get_by_pair(current_user.user_id, target.user_id)
        if existing:
            if existing.status == "blocked":
                if existing.user_id == current_user.user_id:
                    raise BadRequestError("你已拉黑该用户，请先解除拉黑")
                raise ForbiddenError("对方暂不可添加")
            if existing.status == "accepted":
                raise BadRequestError("已经是好友")
            if existing.status == "pending":
                if existing.user_id == current_user.user_id:
                    raise BadRequestError("好友申请已发送")
                raise BadRequestError("对方已发送好友申请，请在收到申请中同意或拒绝")

            # Rejected relationships can be reopened; the latest request defines the direction.
            await self.repo.update(
                existing,
                user_id=current_user.user_id,
                friend_id=target.user_id,
                pair_key=friendship_pair_key(current_user.user_id, target.user_id),
                status="pending",
                notice_msg_id=None,
                responded_at=None,
            )
            friendship = existing
        else:
            friendship = await self.repo.create(current_user.user_id, target.user_id, status="pending")

        _, notice_msg = await self._create_request_notice(friendship, current_user, target)
        await self.session.commit()
        await self._broadcast_notice_message(notice_msg)
        await self._notify_user(target.user_id, "friend_request_created", {
            "friendship_id": friendship.friendship_id,
            "channel_id": notice_msg.channel_id,
        })
        await self._notify_friendship_changed(friendship, "pending")
        return self._request_payload(current_user.user_id, friendship, target) | {"action": "requested"}

    async def accept_request(self, current_user: User, friendship_id: str) -> dict:
        friendship = await self._get_pending_for_receiver(friendship_id, current_user.user_id)
        friendship.status = "accepted"
        friendship.responded_at = datetime.now(timezone.utc)
        await self.session.flush()
        requester = await self.user_repo.get_by_id(friendship.user_id)
        if not requester:
            raise NotFoundError("申请人不存在")
        notice_msg = await self._update_notice_message(friendship, "accepted", resolved_by=current_user.user_id)
        await self.session.commit()
        if notice_msg:
            await self._broadcast_notice_message(notice_msg)
        await self._notify_friendship_changed(friendship, "accepted")
        return self._friend_payload(current_user.user_id, friendship, requester)

    async def reject_request(self, current_user: User, friendship_id: str) -> dict:
        friendship = await self._get_pending_for_receiver(friendship_id, current_user.user_id)
        friendship.status = "rejected"
        friendship.responded_at = datetime.now(timezone.utc)
        await self.session.flush()
        requester = await self.user_repo.get_by_id(friendship.user_id)
        if not requester:
            raise NotFoundError("申请人不存在")
        notice_msg = await self._update_notice_message(friendship, "rejected", resolved_by=current_user.user_id)
        await self.session.commit()
        if notice_msg:
            await self._broadcast_notice_message(notice_msg)
        await self._notify_friendship_changed(friendship, "rejected")
        return self._request_payload(current_user.user_id, friendship, requester)

    async def cancel_request(self, current_user: User, friendship_id: str) -> None:
        friendship = await self.repo.get_by_id(friendship_id)
        if not friendship or friendship.status != "pending" or friendship.user_id != current_user.user_id:
            raise NotFoundError("好友申请不存在")
        notice_msg = await self._update_notice_message(friendship, "cancelled", resolved_by=current_user.user_id)
        await self.repo.delete(friendship)
        await self.session.commit()
        if notice_msg:
            await self._broadcast_notice_message(notice_msg)
        await self._notify_friendship_changed(friendship, "cancelled")

    async def remove_friend(self, current_user: User, friend_id: str) -> None:
        friendship = await self.repo.get_by_pair(current_user.user_id, friend_id)
        if not friendship or friendship.status != "accepted":
            raise NotFoundError("好友关系不存在")
        await self.repo.delete(friendship)
        await self.session.commit()
        await self._notify_user(
            current_user.user_id,
            "friendship_changed",
            {"friend_id": friend_id, "status": "removed"},
        )
        await self._notify_user(
            friend_id,
            "friendship_changed",
            {"friend_id": current_user.user_id, "status": "removed"},
        )

    async def block_user(self, current_user: User, friend_identifier: str) -> dict:
        target = await self._resolve_target(friend_identifier)
        self._ensure_not_self(current_user.user_id, target.user_id)
        existing = await self.repo.get_by_pair(current_user.user_id, target.user_id)
        now = datetime.now(timezone.utc)
        notice_msg = None
        if existing:
            if existing.status == "pending":
                notice_msg = await self._update_notice_message(existing, "blocked", resolved_by=current_user.user_id)
            await self.repo.update(
                existing,
                user_id=current_user.user_id,
                friend_id=target.user_id,
                status="blocked",
                responded_at=now,
            )
            friendship = existing
        else:
            friendship = await self.repo.create(current_user.user_id, target.user_id, status="blocked")
            friendship.responded_at = now
            await self.session.flush()
        await self.session.commit()
        if notice_msg:
            await self._broadcast_notice_message(notice_msg)
        await self._notify_friendship_changed(friendship, "blocked")
        return self._request_payload(current_user.user_id, friendship, target)

    async def unblock_user(self, current_user: User, friend_id: str) -> None:
        friendship = await self.repo.get_by_pair(current_user.user_id, friend_id)
        if not friendship or friendship.status != "blocked" or friendship.user_id != current_user.user_id:
            raise NotFoundError("拉黑关系不存在")
        await self.repo.delete(friendship)
        await self.session.commit()
        await self._notify_user(
            current_user.user_id,
            "friendship_changed",
            {"friend_id": friend_id, "status": "unblocked"},
        )

    # ---- Personal friend-notice channel --------------------------------

    async def ensure_friend_notice_channel(self, user: User) -> Channel:
        personal = await WorkspaceService(self.session).ensure_personal_workspace(user)
        m_user = aliased(ChannelMembership)
        m_system = aliased(ChannelMembership)
        existing = (
            await self.session.execute(
                select(Channel)
                .join(m_user, m_user.channel_id == Channel.channel_id)
                .join(m_system, m_system.channel_id == Channel.channel_id)
                .where(
                    Channel.workspace_id == personal.workspace_id,
                    Channel.type == "dm",
                    m_user.member_id == user.user_id,
                    m_user.member_type == "user",
                    m_system.member_id == FRIEND_NOTICE_SYSTEM_ID,
                    m_system.member_type == "system",
                )
                .limit(1)
            )
        ).scalar_one_or_none()
        if existing:
            return existing

        ch = await self.channel_repo.create(
            workspace_id=personal.workspace_id,
            name=f"system:friend-notice:{user.user_id}"[:255],
            type="dm",
            purpose="friend_requests",
        )
        await self.channel_repo.add_member(ch.channel_id, user.user_id, "user", added_by=FRIEND_NOTICE_SYSTEM_ID)
        await self.channel_repo.add_member(ch.channel_id, FRIEND_NOTICE_SYSTEM_ID, "system")
        return ch

    async def _create_request_notice(
        self,
        friendship: Friendship,
        requester: User,
        receiver: User,
    ) -> tuple[Channel, Message]:
        ch = await self.ensure_friend_notice_channel(receiver)
        msg = Message(
            channel_id=ch.channel_id,
            sender_id=FRIEND_NOTICE_SYSTEM_ID,
            sender_type="system",
            content=f"{requester.display_name or requester.username} 请求添加你为好友",
            msg_type=FRIEND_REQUEST_MSG_TYPE,
            content_data=self._notice_content_data(friendship, requester, receiver, "pending"),
        )
        self.session.add(msg)
        await self.session.flush()
        friendship.notice_msg_id = msg.msg_id
        await self.session.flush()
        return ch, msg

    async def _update_notice_message(
        self,
        friendship: Friendship,
        status: str,
        *,
        resolved_by: str | None,
    ) -> Message | None:
        if not friendship.notice_msg_id:
            return None
        msg = await self.session.get(Message, friendship.notice_msg_id)
        if not msg:
            return None
        requester = await self.user_repo.get_by_id(friendship.user_id)
        receiver = await self.user_repo.get_by_id(friendship.friend_id)
        if not requester or not receiver:
            return None
        msg.content_data = self._notice_content_data(
            friendship, requester, receiver, status, resolved_by=resolved_by,
        )
        msg.content = self._notice_content(requester, status)
        await self.session.flush()
        return msg

    async def _broadcast_notice_message(self, msg: Message) -> None:
        await ws_manager.broadcast_to_channel(
            msg.channel_id,
            {"type": "message", "data": self._message_payload(msg)},
        )

    async def _notify_friendship_changed(self, friendship: Friendship, status: str) -> None:
        payload = {
            "friendship_id": friendship.friendship_id,
            "status": status,
            "user_id": friendship.user_id,
            "friend_id": friendship.friend_id,
        }
        await self._notify_user(friendship.user_id, "friendship_changed", payload)
        await self._notify_user(friendship.friend_id, "friendship_changed", payload)

    async def _notify_user(self, user_id: str, event_type: str, data: dict) -> None:
        await ws_manager.broadcast_to_user(user_id, {"type": event_type, "data": data})

    # ---- Internal helpers ----------------------------------------------

    async def _resolve_target(self, identifier: str) -> User:
        value = identifier.strip()
        if not value:
            raise BadRequestError("用户标识不能为空")
        target = await self.user_repo.get_by_id(value)
        if not target:
            target = await self.user_repo.get_by_username(value)
        if not target:
            raise NotFoundError("用户不存在")
        return target

    @staticmethod
    def _ensure_not_self(user_id: str, target_id: str) -> None:
        if user_id == target_id:
            raise BadRequestError("不能添加自己为好友")

    async def _get_pending_for_receiver(self, friendship_id: str, receiver_id: str) -> Friendship:
        friendship = await self.repo.get_by_id(friendship_id)
        if not friendship or friendship.status != "pending" or friendship.friend_id != receiver_id:
            raise NotFoundError("好友申请不存在")
        return friendship

    @staticmethod
    def _user_payload(user: User) -> dict:
        return {
            "user_id": user.user_id,
            "username": user.username,
            "display_name": user.display_name,
            "avatar_url": user.avatar_url,
        }

    def _friend_payload(self, current_user_id: str, friendship: Friendship, other: User) -> dict:
        return self._user_payload(other) | {
            "friendship_id": friendship.friendship_id,
            "status": friendship.status,
            "relationship_status": friendship.status,
            "direction": "outgoing" if friendship.user_id == current_user_id else "incoming",
            "created_at": friendship.created_at.isoformat() if friendship.created_at else None,
            "updated_at": friendship.updated_at.isoformat() if friendship.updated_at else None,
            "responded_at": friendship.responded_at.isoformat() if friendship.responded_at else None,
        }

    def _request_payload(self, current_user_id: str, friendship: Friendship, other: User) -> dict:
        return self._friend_payload(current_user_id, friendship, other)

    def _notice_content_data(
        self,
        friendship: Friendship,
        requester: User,
        receiver: User,
        status: str,
        *,
        resolved_by: str | None = None,
    ) -> dict:
        return {
            "friendship_id": friendship.friendship_id,
            "status": status,
            "requester": self._user_payload(requester),
            "receiver": self._user_payload(receiver),
            "resolved_by": resolved_by,
            "responded_at": datetime.now(timezone.utc).isoformat() if status != "pending" else None,
        }

    @staticmethod
    def _notice_content(requester: User, status: str) -> str:
        name = requester.display_name or requester.username
        if status == "accepted":
            return f"已同意 {name} 的好友申请"
        if status == "rejected":
            return f"已拒绝 {name} 的好友申请"
        if status == "cancelled":
            return f"{name} 已撤回好友申请"
        if status == "blocked":
            return f"已处理来自 {name} 的好友申请"
        return f"{name} 请求添加你为好友"

    @staticmethod
    def _message_payload(msg: Message) -> dict:
        return {
            "msg_id": msg.msg_id,
            "channel_id": msg.channel_id,
            "sender_id": msg.sender_id,
            "sender_type": msg.sender_type,
            "content": msg.content,
            "content_data": msg.content_data,
            "file_ids": msg.file_ids or [],
            "files": [],
            "mention_bot_ids": msg.mention_bot_ids or [],
            "mention_user_ids": msg.mention_user_ids or [],
            "task_id": msg.task_id,
            "in_reply_to_msg_id": msg.in_reply_to_msg_id,
            "created_at": msg.created_at.isoformat() if msg.created_at else None,
            "msg_type": msg.msg_type,
            "is_secret": msg.is_secret,
            "is_partial": msg.is_partial,
        }
