"""Unified system-DM notifications."""
from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from app.application.chat.message_assembler import MessageAssembler
from app.db.models import BotAccount, Channel, ChannelMembership, Message, User
from app.db.session import async_session_factory
from app.features.bot_runtime.pipeline.bot.mention import resolve_user_mentions_anywhere
from app.repositories.channel_repo import ChannelRepository
from app.services.realtime_broker import get_realtime_broker
from app.services.unread_count_service import increment_unread_counts
from app.services.workspace_service import WorkspaceService

logger = logging.getLogger("app.services.notification")

# Keep the legacy member id so existing personal "friend notice" DMs keep
# working and simply become the user's unified notification conversation.
NOTIFICATION_SYSTEM_ID = "system:friend_requests"
NOTIFICATION_USERNAME = "notifications"
NOTIFICATION_DISPLAY_NAME = "通知"
NOTIFICATION_CHANNEL_PURPOSE = "notifications"
NOTIFICATION_MSG_TYPE = "notification"
FRIEND_REQUEST_MSG_TYPE = "friend_request"

# Backward-compatible aliases for older imports/tests.
FRIEND_NOTICE_SYSTEM_ID = NOTIFICATION_SYSTEM_ID
FRIEND_NOTICE_USERNAME = NOTIFICATION_USERNAME
FRIEND_NOTICE_DISPLAY_NAME = NOTIFICATION_DISPLAY_NAME


@dataclass(frozen=True)
class NotificationDelivery:
    user_id: str
    channel_id: str
    msg_id: str
    sender_id: str
    sender_type: str
    payload: dict[str, Any]


def _clean_preview(value: str | None, limit: int = 180) -> str:
    text = " ".join((value or "").split())
    if len(text) <= limit:
        return text
    return f"{text[: limit - 1]}…"


def _entity_label(
    entity: User | BotAccount | None,
    *,
    fallback: str,
) -> str:
    if entity is None:
        return fallback
    return (
        getattr(entity, "display_name", None)
        or getattr(entity, "username", None)
        or fallback
    )


class NotificationService:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session
        self.channel_repo = ChannelRepository(session)

    async def ensure_notification_channel(self, user: User) -> Channel:
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
                    m_system.member_id == NOTIFICATION_SYSTEM_ID,
                    m_system.member_type == "system",
                )
                .limit(1)
            )
        ).scalar_one_or_none()
        if existing:
            target_name = f"system:notifications:{user.user_id}"[:255]
            changed = False
            if existing.name != target_name:
                existing.name = target_name
                changed = True
            if existing.purpose != NOTIFICATION_CHANNEL_PURPOSE:
                existing.purpose = NOTIFICATION_CHANNEL_PURPOSE
                changed = True
            if changed:
                await self.session.flush()
            return existing

        ch = await self.channel_repo.create(
            workspace_id=personal.workspace_id,
            name=f"system:notifications:{user.user_id}"[:255],
            type="dm",
            purpose=NOTIFICATION_CHANNEL_PURPOSE,
        )
        await self.channel_repo.add_member(
            ch.channel_id,
            user.user_id,
            "user",
            added_by=NOTIFICATION_SYSTEM_ID,
        )
        await self.channel_repo.add_member(ch.channel_id, NOTIFICATION_SYSTEM_ID, "system")
        return ch

    async def create_notification_message(
        self,
        user: User,
        *,
        content: str,
        content_data: dict[str, Any],
        msg_type: str = NOTIFICATION_MSG_TYPE,
    ) -> Message:
        channel = await self.ensure_notification_channel(user)
        msg = Message(
            channel_id=channel.channel_id,
            sender_id=NOTIFICATION_SYSTEM_ID,
            sender_type="system",
            content=content,
            msg_type=msg_type,
            content_data=content_data,
        )
        self.session.add(msg)
        await self.session.flush()
        return msg

    async def delivery_for_message(
        self,
        user_id: str,
        msg: Message,
        *,
        bump_unread: bool = True,
    ) -> NotificationDelivery:
        if bump_unread:
            await increment_unread_counts(
                self.session,
                channel_id=msg.channel_id,
                user_ids=[user_id],
            )
        payload = MessageAssembler.assemble(msg, {}).to_wire()
        return NotificationDelivery(
            user_id=user_id,
            channel_id=msg.channel_id,
            msg_id=msg.msg_id,
            sender_id=msg.sender_id,
            sender_type=msg.sender_type,
            payload=payload,
        )

    async def create_permission_approval_delivery(
        self,
        owner: User,
        *,
        permission_msg: Message,
        bot: BotAccount,
        title: str,
    ) -> NotificationDelivery:
        bot_label = _entity_label(bot, fallback="Bot")
        source_preview = _clean_preview(permission_msg.content)
        msg = await self.create_notification_message(
            owner,
            content=f"{bot_label} 请求权限审批：{title}",
            content_data={
                "kind": "bot_permission_approval_notification",
                "source_channel_id": permission_msg.channel_id,
                "source_msg_id": permission_msg.msg_id,
                "permission_msg_id": permission_msg.msg_id,
                "bot_id": bot.bot_id,
                "bot_username": bot.username,
                "bot_display_name": bot.display_name,
                "title": title,
                "preview": source_preview,
                "resolved": False,
                "created_at": datetime.now(timezone.utc).isoformat(),
            },
        )
        return await self.delivery_for_message(owner.user_id, msg)

    @staticmethod
    async def publish_delivery(delivery: NotificationDelivery) -> None:
        await get_realtime_broker().publish_channel(
            delivery.channel_id,
            {"type": "message", "data": delivery.payload},
        )
        await get_realtime_broker().publish_user(
            delivery.user_id,
            {
                "type": "channel_new_message",
                "data": {
                    "channel_id": delivery.channel_id,
                    "sender_id": delivery.sender_id,
                    "sender_type": delivery.sender_type,
                    "msg_id": delivery.msg_id,
                },
            },
        )

    @staticmethod
    async def publish_deliveries(deliveries: list[NotificationDelivery]) -> None:
        for delivery in deliveries:
            await NotificationService.publish_delivery(delivery)

    @staticmethod
    async def fanout_mentions_for_message_id(msg_id: str) -> None:
        async with async_session_factory() as session:
            deliveries = await NotificationService(session)._create_mention_deliveries(msg_id)
            await session.commit()
        await NotificationService.publish_deliveries(deliveries)

    async def _create_mention_deliveries(self, msg_id: str) -> list[NotificationDelivery]:
        msg = await self.session.get(Message, msg_id)
        if msg is None or msg.is_deleted:
            return []

        channel = await self.session.get(Channel, msg.channel_id)
        if channel is None:
            return []
        if channel.purpose == NOTIFICATION_CHANNEL_PURPOSE:
            return []
        if msg.sender_type == "system" and msg.sender_id == NOTIFICATION_SYSTEM_ID:
            return []

        mention_user_ids = list(dict.fromkeys(
            user_id
            for user_id in await self._message_mention_user_ids(msg, channel.channel_id)
            if user_id and not (msg.sender_type == "user" and user_id == msg.sender_id)
        ))
        if not mention_user_ids:
            return []

        sender_label = await self._sender_label(msg)
        channel_label = "DM" if channel.type == "dm" else f"#{channel.name}"
        preview = _clean_preview(msg.content)
        deliveries: list[NotificationDelivery] = []
        for user_id in mention_user_ids:
            user = await self.session.get(User, user_id)
            if user is None or user.is_deleted:
                continue
            notice = await self.create_notification_message(
                user,
                content=f"{sender_label} 在 {channel_label} 提到了你",
                content_data={
                    "kind": "mention_notification",
                    "source_channel_id": msg.channel_id,
                    "source_msg_id": msg.msg_id,
                    "source_channel_name": channel.name,
                    "source_channel_type": channel.type,
                    "source_sender_id": msg.sender_id,
                    "source_sender_type": msg.sender_type,
                    "source_sender_name": sender_label,
                    "preview": preview,
                    "created_at": datetime.now(timezone.utc).isoformat(),
                },
            )
            deliveries.append(await self.delivery_for_message(user_id, notice))
        return deliveries

    async def _message_mention_user_ids(self, msg: Message, channel_id: str) -> list[str]:
        explicit = [
            item
            for item in (msg.mention_user_ids or [])
            if isinstance(item, str) and item
        ]
        resolved = await resolve_user_mentions_anywhere(msg.content, self.session, channel_id)
        return [*explicit, *resolved]

    async def _sender_label(self, msg: Message) -> str:
        if msg.sender_type == "user":
            return _entity_label(await self.session.get(User, msg.sender_id), fallback="User")
        if msg.sender_type == "bot":
            return _entity_label(await self.session.get(BotAccount, msg.sender_id), fallback="Bot")
        return NOTIFICATION_DISPLAY_NAME
