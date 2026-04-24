"""Global ⌘K search.

Cross-entity substring search over the caller's visible channels + all
users/bots. Returns grouped hits with a per-group cap.

First cut: name/username only (no message-content search). Fine for tens
of thousands of rows; if the product grows past that, swap the ILIKE
scan for a trigram GIN index (pg_trgm) or an external index.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.dependencies import get_current_user, get_session
from app.core.responses import APIResponse
from app.core.schemas import (
    SearchBotHit,
    SearchChannelHit,
    SearchMessageHit,
    SearchResults,
    SearchUserHit,
)
from app.db.models import BotAccount, Channel, ChannelMembership, Message, User

router = APIRouter(prefix="/search", tags=["search"])


@router.get("", response_model=APIResponse[SearchResults])
async def global_search(
    q: str = Query("", description="query, 1+ chars; empty → no hits"),
    limit: int = Query(5, ge=1, le=20),
    workspace_id: str | None = Query(
        None,
        description="restrict channel + message hits to this workspace; users and bots stay global",
    ),
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    q = (q or "").strip()
    if not q:
        return APIResponse.ok(
            SearchResults(q="", channels=[], users=[], bots=[], messages=[])
        )

    pattern = f"%{q}%"
    ws_scope: str | None = (workspace_id or "").strip() or None

    # — Channels — only those the caller is a member of, excluding DMs
    # (DMs surface through user/bot hits instead).
    ch_query = (
        select(Channel)
        .join(ChannelMembership, ChannelMembership.channel_id == Channel.channel_id)
        .where(
            ChannelMembership.member_id == current_user.user_id,
            ChannelMembership.member_type == "user",
            Channel.type != "dm",
            Channel.name.ilike(pattern),
        )
    )
    if ws_scope:
        ch_query = ch_query.where(Channel.workspace_id == ws_scope)
    ch_rows = (
        await session.execute(ch_query.order_by(Channel.created_at.desc()).limit(limit))
    ).scalars().all()

    # — Users — exclude the caller themselves.
    user_rows = (
        await session.execute(
            select(User)
            .where(
                User.user_id != current_user.user_id,
                or_(
                    User.username.ilike(pattern),
                    User.display_name.ilike(pattern),
                ),
            )
            .order_by(User.display_name)
            .limit(limit)
        )
    ).scalars().all()

    # — Bots — no scoping, any bot the user can DM.
    bot_rows = (
        await session.execute(
            select(BotAccount)
            .where(
                or_(
                    BotAccount.username.ilike(pattern),
                    BotAccount.display_name.ilike(pattern),
                )
            )
            .order_by(BotAccount.display_name)
            .limit(limit)
        )
    ).scalars().all()

    # — Messages — content ILIKE %q%, restricted to channels the caller is a
    # member of. Skip secret / placeholder-encrypted messages so the search
    # result doesn't leak "this secret mentions …" noise.
    msg_query = (
        select(Message)
        .join(
            ChannelMembership,
            ChannelMembership.channel_id == Message.channel_id,
        )
        .where(
            ChannelMembership.member_id == current_user.user_id,
            ChannelMembership.member_type == "user",
            Message.content.ilike(pattern),
            Message.is_secret == False,  # noqa: E712 — SQLAlchemy comparison
        )
    )
    if ws_scope:
        msg_query = msg_query.join(
            Channel, Channel.channel_id == Message.channel_id
        ).where(Channel.workspace_id == ws_scope)
    msg_rows = (
        await session.execute(msg_query.order_by(Message.created_at.desc()).limit(limit))
    ).scalars().all()

    # Resolve channel names + sender labels for the hit cards.
    channel_ids = list({m.channel_id for m in msg_rows})
    channel_name_by_id: dict[str, str] = {}
    if channel_ids:
        for c in (
            await session.execute(
                select(Channel).where(Channel.channel_id.in_(channel_ids))
            )
        ).scalars():
            channel_name_by_id[c.channel_id] = c.name

    sender_user_ids = {m.sender_id for m in msg_rows if m.sender_type == "user"}
    sender_bot_ids = {m.sender_id for m in msg_rows if m.sender_type == "bot"}
    user_label: dict[str, str] = {}
    bot_label: dict[str, str] = {}
    if sender_user_ids:
        for u in (
            await session.execute(
                select(User).where(User.user_id.in_(sender_user_ids))
            )
        ).scalars():
            user_label[u.user_id] = u.display_name or u.username or "user"
    if sender_bot_ids:
        for b in (
            await session.execute(
                select(BotAccount).where(BotAccount.bot_id.in_(sender_bot_ids))
            )
        ).scalars():
            bot_label[b.bot_id] = b.display_name or b.username or "Bot"

    def _snippet(text: str | None, needle: str, width: int = 80) -> str:
        if not text:
            return ""
        t = text.replace("\n", " ").strip()
        idx = t.lower().find(needle.lower())
        if idx < 0:
            return t[:width] + ("…" if len(t) > width else "")
        start = max(0, idx - width // 3)
        end = min(len(t), start + width)
        out = t[start:end]
        if start > 0:
            out = "…" + out
        if end < len(t):
            out = out + "…"
        return out

    message_hits = [
        SearchMessageHit(
            msg_id=m.msg_id,
            channel_id=m.channel_id,
            channel_name=channel_name_by_id.get(m.channel_id, ""),
            sender_label=(
                "me"
                if m.sender_id == current_user.user_id
                else bot_label.get(m.sender_id)
                or user_label.get(m.sender_id)
                or "user"
            ),
            snippet=_snippet(m.content, q),
            created_at=m.created_at,
        )
        for m in msg_rows
    ]

    return APIResponse.ok(
        SearchResults(
            q=q,
            channels=[
                SearchChannelHit(
                    channel_id=c.channel_id,
                    name=c.name,
                    workspace_id=c.workspace_id,
                    type=c.type,
                )
                for c in ch_rows
            ],
            users=[
                SearchUserHit(
                    user_id=u.user_id,
                    username=u.username,
                    display_name=u.display_name,
                    avatar_url=u.avatar_url,
                )
                for u in user_rows
            ],
            bots=[
                SearchBotHit(
                    bot_id=b.bot_id,
                    username=b.username,
                    display_name=b.display_name,
                    avatar_url=b.avatar_url,
                )
                for b in bot_rows
            ],
            messages=message_hits,
        )
    )
