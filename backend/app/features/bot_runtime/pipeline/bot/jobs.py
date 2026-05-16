"""Queued Bot pipeline job execution."""
from __future__ import annotations

import logging

from sqlalchemy import select

from app.db.models import Message
from app.db.session import async_session_factory
from app.features.bot_runtime.pipeline.bot.adapter_resolver import get_adapter_for_bot
from app.features.bot_runtime.pipeline.bot.service import run_bot_pipeline
from app.features.bot_runtime.pipeline.bus import EventBus, make_event_bus
from app.features.bot_runtime.pipeline.events import BotProcessing
from app.services.realtime_broker import get_realtime_broker

logger = logging.getLogger("app.features.bot_runtime.pipeline.bot.jobs")


async def _run_bot_pipeline_once(
    channel_id: str,
    trigger_msg: Message,
    session,
    *,
    event_bus: EventBus,
) -> tuple[list[Message], set[str]]:
    async def broadcast_bot_processing(ch_id: str, bot_id: str, username: str) -> None:
        await event_bus.publish(BotProcessing(bot_id=bot_id, username=username))

    return await run_bot_pipeline(
        channel_id,
        trigger_msg,
        session,
        lambda bid: get_adapter_for_bot(bid, session),
        event_bus=event_bus,
        broadcast_processing=broadcast_bot_processing,
    )


async def run_bot_pipeline_job(channel_id: str, msg_id: str) -> None:
    """Run one persisted user-message trigger in an independent DB session."""
    try:
        async with async_session_factory() as read_session:
            result = await read_session.execute(select(Message).where(Message.msg_id == msg_id))
            msg = result.scalar_one_or_none()
            if not msg:
                logger.warning(
                    "bot_pipeline_job: message not found msg_id=%s channel_id=%s",
                    msg_id, channel_id,
                )
                return
            read_session.expunge(msg)

        async with async_session_factory() as session:
            logger.info(
                "bot_pipeline_job: starting channel_id=%s msg_id=%s sender=%s",
                channel_id, msg_id, msg.sender_id,
            )
            bus = make_event_bus(channel_id, stream_to_ws=True, stream_event=None)
            bot_messages, already_broadcast_ids = await _run_bot_pipeline_once(
                channel_id, msg, session, event_bus=bus
            )
            unbroadcast = [bm for bm in bot_messages if bm.msg_id not in already_broadcast_ids]
            if unbroadcast:
                logger.error(
                    "bot_pipeline_job: %d bot message(s) escaped writer broadcast path channel_id=%s ids=%s",
                    len(unbroadcast), channel_id, [bm.msg_id for bm in unbroadcast],
                )
            if bot_messages:
                from app.features.memory.recent_update import schedule_recent_update

                schedule_recent_update(channel_id)
                logger.info(
                    "bot_pipeline_job: completed channel_id=%s bot_messages=%d",
                    channel_id, len(bot_messages),
                )
            await session.commit()
    except Exception as exc:
        logger.exception(
            "bot_pipeline_job: FAILED channel_id=%s msg_id=%s error=%s",
            channel_id, msg_id, exc,
        )
        try:
            await get_realtime_broker().publish_channel(channel_id, {
                "type": "bot_pipeline_error",
                "data": {
                    "channel_id": channel_id,
                    "msg_id": msg_id,
                    "error": f"Bot 处理失败: {exc}",
                },
            })
        except Exception:
            logger.debug("bot_pipeline_job: failed to publish error frame", exc_info=True)
        raise
