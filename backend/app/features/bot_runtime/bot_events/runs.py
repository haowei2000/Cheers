"""Durable BotRun lifecycle helpers."""
from __future__ import annotations

from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import BotAccount, BotRun


async def ensure_bot_run(
    session: AsyncSession,
    *,
    task_id: str,
    channel_id: str,
    trigger_msg_id: str,
    bot_id: str,
    placeholder_msg_id: str,
    status: str = "placeholder_created",
    last_event_type: str | None = None,
) -> BotRun:
    """Create or refresh the durable run row for a bot placeholder."""
    run = await get_bot_run_by_placeholder(session, placeholder_msg_id)
    binding_type = await _resolve_binding_type(session, bot_id)
    now = datetime.now(UTC)
    if run is None:
        run = BotRun(
            task_id=task_id,
            channel_id=channel_id,
            trigger_msg_id=trigger_msg_id,
            bot_id=bot_id,
            placeholder_msg_id=placeholder_msg_id,
            binding_type=binding_type,
            status=status,
            last_event_type=last_event_type,
            updated_at=now,
        )
        session.add(run)
    else:
        run.task_id = task_id
        run.channel_id = channel_id
        run.trigger_msg_id = trigger_msg_id
        run.bot_id = bot_id
        run.binding_type = binding_type
        run.status = status
        run.last_event_type = last_event_type or run.last_event_type
        run.error_message = None
        run.updated_at = now
    await session.flush()
    return run


async def mark_bot_run_status(
    session: AsyncSession,
    *,
    placeholder_msg_id: str | None = None,
    task_id: str | None = None,
    bot_id: str | None = None,
    status: str,
    last_event_type: str | None = None,
    error_message: str | None = None,
) -> BotRun | None:
    """Mark a BotRun status. Missing rows are a no-op for compatibility."""
    run = None
    if placeholder_msg_id:
        run = await get_bot_run_by_placeholder(session, placeholder_msg_id)
    if run is None and task_id and bot_id:
        run = (
            await session.execute(
                select(BotRun)
                .where(BotRun.task_id == task_id, BotRun.bot_id == bot_id)
                .order_by(BotRun.created_at.desc())
                .limit(1)
            )
        ).scalar_one_or_none()
    if run is None:
        return None
    run.status = status
    if last_event_type is not None:
        run.last_event_type = last_event_type
    run.error_message = error_message
    run.updated_at = datetime.now(UTC)
    await session.flush()
    return run


async def get_bot_run_by_placeholder(
    session: AsyncSession, placeholder_msg_id: str,
) -> BotRun | None:
    return (
        await session.execute(
            select(BotRun).where(BotRun.placeholder_msg_id == placeholder_msg_id)
        )
    ).scalar_one_or_none()


async def _resolve_binding_type(session: AsyncSession, bot_id: str) -> str:
    value = (
        await session.execute(
            select(BotAccount.binding_type).where(BotAccount.bot_id == bot_id)
        )
    ).scalar_one_or_none()
    return (value or "http").lower()
