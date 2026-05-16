"""Bot event job execution."""
from __future__ import annotations

import logging

from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import Message
from app.db.session import async_session_factory
from app.features.agent_bridge.pending import PendingReply, pending_replies
from app.features.agent_bridge.service import (
    finalize_bot_reply,
    finalize_stream,
)
from app.features.bot_runtime.bot_events.queue import BotEventJob
from app.features.bot_runtime.bot_events.runs import mark_bot_run_status

logger = logging.getLogger("app.features.bot_runtime.bot_events.jobs")

AGENT_BRIDGE_REPLY = "agent_bridge.reply"
AGENT_BRIDGE_STREAM_DONE = "agent_bridge.stream_done"
AGENT_BRIDGE_STREAM_ERROR = "agent_bridge.stream_error"


def _is_agent_bridge_background_task_message(msg: Message) -> bool:
    data = msg.content_data
    return isinstance(data, dict) and data.get("kind") == "agent_bridge_background_task"


async def run_bot_event_job(job: BotEventJob) -> None:
    """Run one bot event in an independent DB session."""
    async with async_session_factory() as session:
        await handle_bot_event_job(session, job)
        await session.commit()


async def handle_bot_event_job(session: AsyncSession, job: BotEventJob) -> None:
    """Apply one bot event. Exposed for focused tests."""
    if job.event_type == AGENT_BRIDGE_REPLY:
        await _handle_agent_bridge_reply(session, job.payload)
        return
    if job.event_type == AGENT_BRIDGE_STREAM_DONE:
        await _handle_agent_bridge_stream_done(session, job.payload)
        return
    if job.event_type == AGENT_BRIDGE_STREAM_ERROR:
        await _handle_agent_bridge_stream_error(session, job.payload)
        return
    logger.warning("bot_event_job: unknown event_type=%s job_id=%s", job.event_type, job.job_id)


async def _handle_agent_bridge_reply(
    session: AsyncSession,
    payload: dict,
    *,
    event_type: str = AGENT_BRIDGE_REPLY,
) -> None:
    bot_id = str(payload.get("bot_id") or "")
    channel_id = str(payload.get("channel_id") or "")
    content = str(payload.get("content") or "")
    task_id = _optional_str(payload.get("task_id"))
    reply_to_msg_id = _optional_str(payload.get("reply_to_msg_id"))
    in_reply_to_msg_id = _optional_str(payload.get("in_reply_to_msg_id"))
    file_ids = _string_list(payload.get("file_ids"))

    if not bot_id or not channel_id:
        raise ValueError("agent_bridge.reply requires bot_id and channel_id")
    if not content and not file_ids:
        raise ValueError("agent_bridge.reply requires content or file_ids")

    if reply_to_msg_id:
        existing = await session.get(Message, reply_to_msg_id)
        if (
            existing is not None
            and existing.channel_id == channel_id
            and existing.sender_id == bot_id
            and not _is_agent_bridge_background_task_message(existing)
            and ((existing.content or "").strip() or existing.file_ids)
        ):
            logger.info(
                "bot_event_job: skip duplicate finalized reply msg_id=%s bot_id=%s",
                reply_to_msg_id, bot_id,
            )
            await mark_bot_run_status(
                session,
                placeholder_msg_id=reply_to_msg_id,
                status="done",
                last_event_type=event_type,
            )
            return
        if (
            existing is not None
            and existing.channel_id == channel_id
            and existing.sender_id == bot_id
            and await pending_replies.peek_by_msg(reply_to_msg_id) is None
        ):
            await pending_replies.register(
                PendingReply(
                    task_id=task_id or "",
                    bot_id=bot_id,
                    channel_id=channel_id,
                    msg_id=reply_to_msg_id,
                )
            )

    await mark_bot_run_status(
        session,
        placeholder_msg_id=reply_to_msg_id,
        task_id=task_id,
        bot_id=bot_id,
        status="event_processing",
        last_event_type=event_type,
    )
    msg, _ = await finalize_bot_reply(
        session,
        bot_id=bot_id,
        channel_id=channel_id,
        content=content,
        task_id=task_id,
        reply_to_msg_id=reply_to_msg_id,
        in_reply_to_msg_id=in_reply_to_msg_id,
        file_ids=file_ids or None,
    )
    await mark_bot_run_status(
        session,
        placeholder_msg_id=msg.msg_id,
        status="done",
        last_event_type=event_type,
    )


async def _handle_agent_bridge_stream_done(session: AsyncSession, payload: dict) -> None:
    msg_id = str(payload.get("msg_id") or "")
    bot_id = str(payload.get("bot_id") or "")
    file_ids = _string_list(payload.get("file_ids"))
    if not msg_id or not bot_id:
        raise ValueError("agent_bridge.stream_done requires msg_id and bot_id")
    content = payload.get("content")
    channel_id = _optional_str(payload.get("channel_id"))
    if isinstance(content, str) and channel_id:
        await _handle_agent_bridge_reply(
            session,
            {
                "bot_id": bot_id,
                "channel_id": channel_id,
                "content": content,
                "task_id": _optional_str(payload.get("task_id")),
                "reply_to_msg_id": msg_id,
                "file_ids": file_ids,
            },
            event_type=AGENT_BRIDGE_STREAM_DONE,
        )
        return
    msg = await finalize_stream(
        session,
        msg_id=msg_id,
        bot_id=bot_id,
        partial=False,
        file_ids=file_ids or None,
    )
    if msg is not None:
        await mark_bot_run_status(
            session,
            placeholder_msg_id=msg.msg_id,
            status="done",
            last_event_type=AGENT_BRIDGE_STREAM_DONE,
        )


async def _handle_agent_bridge_stream_error(session: AsyncSession, payload: dict) -> None:
    msg_id = str(payload.get("msg_id") or "")
    bot_id = str(payload.get("bot_id") or "")
    error = str(payload.get("error") or "plugin_error")
    if not msg_id or not bot_id:
        raise ValueError("agent_bridge.stream_error requires msg_id and bot_id")
    msg = await finalize_stream(
        session,
        msg_id=msg_id,
        bot_id=bot_id,
        partial=True,
        error=error,
    )
    if msg is not None:
        await mark_bot_run_status(
            session,
            placeholder_msg_id=msg.msg_id,
            status="failed",
            last_event_type=AGENT_BRIDGE_STREAM_ERROR,
            error_message=error,
        )


def _optional_str(value) -> str | None:
    return value if isinstance(value, str) and value else None


def _string_list(value) -> list[str]:
    if not isinstance(value, list):
        return []
    return [item for item in value if isinstance(item, str) and item]
