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
    SearchResults,
    SearchUserHit,
)
from app.db.models import BotAccount, Channel, ChannelMembership, User

router = APIRouter(prefix="/search", tags=["search"])


@router.get("", response_model=APIResponse[SearchResults])
async def global_search(
    q: str = Query("", description="query, 1+ chars; empty → no hits"),
    limit: int = Query(5, ge=1, le=20),
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    q = (q or "").strip()
    if not q:
        return APIResponse.ok(SearchResults(q="", channels=[], users=[], bots=[]))

    pattern = f"%{q}%"

    # — Channels — only those the caller is a member of, excluding DMs
    # (DMs surface through user/bot hits instead).
    ch_rows = (
        await session.execute(
            select(Channel)
            .join(ChannelMembership, ChannelMembership.channel_id == Channel.channel_id)
            .where(
                ChannelMembership.member_id == current_user.user_id,
                ChannelMembership.member_type == "user",
                Channel.type != "dm",
                Channel.name.ilike(pattern),
            )
            .order_by(Channel.created_at.desc())
            .limit(limit)
        )
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
        )
    )
