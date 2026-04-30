"""Permission guard tests for channel/workspace scoped reads."""
from __future__ import annotations

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import ForbiddenError
from app.db.models import Channel, User, Workspace
from app.services.channel_service import ChannelService
from app.services.workspace_service import WorkspaceService


@pytest.mark.asyncio
async def test_channel_member_guard_rejects_non_member(db_session: AsyncSession) -> None:
    user = User(
        user_id="u-perm-001",
        username="perm_user_001",
        password_hash="x",
        role="member",
    )
    ws = Workspace(workspace_id="w-perm-001", name="Perm WS")
    ch = Channel(
        channel_id="c-perm-001",
        workspace_id=ws.workspace_id,
        name="private-channel",
        type="private",
    )
    db_session.add_all([user, ws, ch])
    await db_session.commit()

    with pytest.raises(ForbiddenError):
        await ChannelService(db_session).require_channel_member(ch.channel_id, user)


@pytest.mark.asyncio
async def test_workspace_member_guard_rejects_non_member(db_session: AsyncSession) -> None:
    user = User(
        user_id="u-perm-002",
        username="perm_user_002",
        password_hash="x",
        role="member",
    )
    ws = Workspace(workspace_id="w-perm-002", name="Perm WS 2")
    db_session.add_all([user, ws])
    await db_session.commit()

    with pytest.raises(ForbiddenError):
        await WorkspaceService(db_session).list_members_with_details(ws.workspace_id, user)
