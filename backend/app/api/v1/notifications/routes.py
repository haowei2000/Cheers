from datetime import datetime
from typing import List, Optional

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import Text, and_, cast, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.dependencies import get_current_user, get_session
from app.db.models import Channel, ChannelMembership, Message, TodoItem, User

router = APIRouter(prefix="/notifications", tags=["notifications"])


class NotificationItem(BaseModel):
    notif_type: str          # "mention" | "todo" | "friend_request"
    id: str                  # msg_id or todo_id
    channel_id: str
    channel_name: str
    content: str
    created_at: datetime
    sender_id: Optional[str] = None
    sender_type: Optional[str] = None
    todo_status: Optional[str] = None  # for todo items
    friendship_id: Optional[str] = None
    friend_request_status: Optional[str] = None


@router.get("/", response_model=List[NotificationItem])
async def get_notifications(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> List[NotificationItem]:
    user_id = current_user.user_id

    # Messages that mention the user
    mention_rows = (
        await db.execute(
            select(Message, Channel)
            .join(Channel, Message.channel_id == Channel.channel_id)
            .where(cast(Message.mention_user_ids, Text).contains(user_id))
            .order_by(Message.created_at.desc())
            .limit(50)
        )
    ).all()

    # Todos assigned to the user
    todo_rows = (
        await db.execute(
            select(TodoItem, Channel)
            .join(Channel, TodoItem.channel_id == Channel.channel_id)
            .where(
                TodoItem.assignee_id == user_id,
                TodoItem.assignee_type == "user",
            )
            .order_by(TodoItem.created_at.desc())
            .limit(50)
        )
    ).all()

    friend_request_rows = (
        await db.execute(
            select(Message, Channel)
            .join(Channel, Message.channel_id == Channel.channel_id)
            .join(
                ChannelMembership,
                and_(
                    ChannelMembership.channel_id == Channel.channel_id,
                    ChannelMembership.member_id == user_id,
                    ChannelMembership.member_type == "user",
                ),
            )
            .where(Message.msg_type == "friend_request")
            .order_by(Message.created_at.desc())
            .limit(50)
        )
    ).all()

    items: List[NotificationItem] = []

    for msg, channel in mention_rows:
        items.append(NotificationItem(
            notif_type="mention",
            id=msg.msg_id,
            channel_id=msg.channel_id,
            channel_name=channel.name,
            content=msg.content[:200],
            created_at=msg.created_at,
            sender_id=msg.sender_id,
            sender_type=msg.sender_type,
        ))

    for todo, channel in todo_rows:
        items.append(NotificationItem(
            notif_type="todo",
            id=todo.todo_id,
            channel_id=todo.channel_id,
            channel_name=channel.name,
            content=todo.content[:200],
            created_at=todo.created_at,
            todo_status=todo.status,
        ))

    for msg, channel in friend_request_rows:
        content_data = msg.content_data if isinstance(msg.content_data, dict) else {}
        status = str(content_data.get("status") or "pending")
        if status != "pending":
            continue
        friendship_id = content_data.get("friendship_id")
        items.append(NotificationItem(
            notif_type="friend_request",
            id=msg.msg_id,
            channel_id=msg.channel_id,
            channel_name=channel.name,
            content=msg.content[:200],
            created_at=msg.created_at,
            sender_id=msg.sender_id,
            sender_type=msg.sender_type,
            friendship_id=friendship_id if isinstance(friendship_id, str) else None,
            friend_request_status=status,
        ))

    items.sort(key=lambda x: x.created_at, reverse=True)
    return items
