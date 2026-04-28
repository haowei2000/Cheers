"""BotMessageWriter: the single owner of the bot-reply lifecycle.

Encapsulates the six helpers that used to live as closures inside
``run_orchestrator``: pre-create a placeholder, stream tokens into it,
finalize content + files, broadcast a fully-formed message, log an
AgentTask row, and arm the WebSocket-bot timeout. One writer per
orchestrator run; it holds no state of its own — every method reads
from the BotRunContext passed to ``__init__``.

Stages (DispatchStage, AutoTakeoverStage) and adapter sub-bot paths
(call_bot in channel_bot.py) compose this object instead of carrying
the four loose closures around inside ``process_config`` dicts.
"""
from __future__ import annotations

import asyncio
import logging
import uuid
from collections.abc import Awaitable, Callable
from typing import TYPE_CHECKING

from sqlalchemy import select

from app.db.models import AgentTask, BotAccount, FileRecord, Message
from app.services.orchestrator.mention import resolve_user_mentions
from app.services.orchestrator.topic_context import MSG_TYPE_REPLY, ensure_topic_root
from app.services.pipeline.events import (
    BotMessagePlaceholder,
    MessageCreated,
    MessageDone,
    MessageStreamDelta,
)

if TYPE_CHECKING:
    from app.services.pipeline.bot.context import BotRunContext

logger = logging.getLogger("app.services.pipeline.bot.writer")


class BotMessageWriter:
    def __init__(self, ctx: "BotRunContext") -> None:
        self.ctx = ctx

    # ── full-message broadcast (coordinator aggregate, etc.) ────────────

    async def create_and_broadcast(self, sender_id: str, content: str) -> None:
        from app.core.schemas import MessageInResponse

        ctx = self.ctx
        mention_user_ids = await resolve_user_mentions(content, ctx.session, ctx.channel_id)
        msg = Message(
            channel_id=ctx.channel_id,
            sender_id=sender_id,
            sender_type="bot",
            content=content,
            task_id=ctx.root_task_id,
            in_reply_to_msg_id=ctx.trigger_msg.msg_id,
            mention_user_ids=mention_user_ids,
            msg_type=MSG_TYPE_REPLY,
        )
        ctx.session.add(msg)
        await ctx.session.flush()
        # after_insert listener in topic_context.py promotes the trigger
        # row to "topic" once reply count crosses the threshold; we mirror
        # the flip into the loaded instance here so any later same-request
        # code reads the new msg_type without a refresh.
        await ensure_topic_root(ctx.session, ctx.trigger_msg.msg_id)
        data = MessageInResponse.model_validate(msg).model_dump()
        if msg.created_at:
            data["created_at"] = msg.created_at.isoformat()
        bot_row = await ctx.session.execute(
            select(BotAccount.display_name, BotAccount.username).where(
                BotAccount.bot_id == sender_id
            )
        )
        bot_info = bot_row.first()
        if bot_info:
            data["sender_name"] = bot_info[0] or bot_info[1] or ""
        await ctx.bus.publish(MessageCreated(data=data))
        ctx.already_broadcast.add(msg.msg_id)
        ctx.bot_messages.append(msg)

    # ── streaming lifecycle: placeholder → deltas → done ────────────────

    async def pre_create(self, bot_id: str, task_id: str) -> Message:
        from app.core.schemas import MessageInResponse

        ctx = self.ctx
        msg = Message(
            channel_id=ctx.channel_id,
            sender_id=bot_id,
            sender_type="bot",
            content="",
            task_id=task_id,
            in_reply_to_msg_id=ctx.trigger_msg.msg_id,
            msg_type=MSG_TYPE_REPLY,
        )
        ctx.session.add(msg)
        await ctx.session.flush()
        await ensure_topic_root(ctx.session, ctx.trigger_msg.msg_id)
        data = MessageInResponse.model_validate(msg).model_dump()
        if msg.created_at:
            data["created_at"] = msg.created_at.isoformat()
        await ctx.bus.publish(BotMessagePlaceholder(data=data))
        ctx.already_broadcast.add(msg.msg_id)
        return msg

    def make_stream_token_cb(self, msg_id: str) -> Callable[[str], Awaitable[None]]:
        bus = self.ctx.bus

        async def _cb(delta: str) -> None:
            await bus.publish(MessageStreamDelta(msg_id=msg_id, delta=delta))

        return _cb

    async def finalize(
        self,
        msg: Message,
        content: str,
        *,
        file_ids: list[str] | None = None,
    ) -> None:
        ctx = self.ctx
        msg.content = content
        msg.mention_user_ids = await resolve_user_mentions(
            content, ctx.session, ctx.channel_id,
        )
        if file_ids:
            msg.file_ids = list({*(msg.file_ids or []), *file_ids})
        await ctx.session.flush()

        out_file_ids: list[str] | None = None
        out_files: list[dict] | None = None
        if msg.file_ids:
            from app.core.schemas import MessageFileInResponse
            result = await ctx.session.execute(
                select(FileRecord).where(FileRecord.file_id.in_(msg.file_ids))
            )
            file_map = {r.file_id: r for r in result.scalars().all()}
            out_file_ids = msg.file_ids
            out_files = [
                MessageFileInResponse(
                    file_id=r.file_id,
                    original_filename=r.original_filename,
                    content_type=r.content_type,
                    size_bytes=r.size_bytes,
                    status=r.status or "ready",
                ).model_dump()
                for fid in msg.file_ids
                if (r := file_map.get(fid))
            ]
        await ctx.bus.publish(
            MessageDone(
                msg_id=msg.msg_id,
                content=content,
                file_ids=out_file_ids,
                files=out_files,
            )
        )

    # ── routing card (coordinator's pick + plan) ────────────────────────

    async def emit_routing_card(
        self,
        coordinator_bot_id: str,
        coordinator_content: str,
        picked_usernames: list[str],
    ) -> None:
        """Persist a msg_type='routing' Message carrying the coordinator's
        decision (which bots were picked + a terse plan snippet) and
        broadcast it. Non-fatal: any error is logged and swallowed so the
        takeover flow continues.
        """
        from app.core.schemas import MessageInResponse

        ctx = self.ctx
        try:
            picks = [{"agent": u, "picked": True} for u in picked_usernames]
            q = (ctx.trigger_content or "").strip().replace("\n", " ")
            if len(q) > 160:
                q = q[:160] + "…"
            plan = (coordinator_content or "").strip().replace("\n", " ")
            if len(plan) > 200:
                plan = plan[:200] + "…"

            routing_msg = Message(
                channel_id=ctx.channel_id,
                sender_id=coordinator_bot_id,
                sender_type="bot",
                content="",
                msg_type="routing",
                content_data={"q": q or None, "picks": picks, "plan": plan or None},
            )
            ctx.session.add(routing_msg)
            await ctx.session.flush()

            data = MessageInResponse.model_validate(routing_msg).model_dump()
            if routing_msg.created_at:
                data["created_at"] = routing_msg.created_at.isoformat()
            coord_row = await ctx.session.execute(
                select(BotAccount.display_name, BotAccount.username).where(
                    BotAccount.bot_id == coordinator_bot_id
                )
            )
            coord_info = coord_row.first()
            if coord_info:
                data["sender_name"] = coord_info[0] or coord_info[1] or ""

            await ctx.bus.publish(MessageCreated(data=data))
            ctx.already_broadcast.add(routing_msg.msg_id)
            ctx.bot_messages.append(routing_msg)
        except Exception:
            logger.exception(
                "orchestrator: failed to emit routing card channel_id=%s",
                ctx.channel_id,
            )

    # ── post-dispatch bookkeeping ───────────────────────────────────────

    async def record_task(self, bot_id: str, response_msg_id: str) -> None:
        ctx = self.ctx
        ctx.session.add(
            AgentTask(
                task_id=str(uuid.uuid4()),
                channel_id=ctx.channel_id,
                bot_id=bot_id,
                trigger_msg_id=ctx.trigger_msg.msg_id,
                response_msg_id=response_msg_id,
            )
        )
        await ctx.session.flush()

    async def register_async_pending(
        self, bot_msg: Message, task_id: str, bot_id: str,
    ) -> None:
        """WebSocket Bot 异步派发：占位消息不立即 finalize，为超时兜底武装 timer。

        PendingReply 已由 WebsocketBotAdapter.execute() 在 dispatch 之前预登记
        （避免 plugin 秒回时 pending 未登记的竞态）；这里只 arm timer。
        """
        from app.config import settings as _settings
        from app.db.session import async_session_factory
        from app.services.openclaw_bridge.pending import pending_replies
        from app.services.openclaw_bridge.service import finalize_bot_reply

        ctx = self.ctx
        timeout_s = max(5, int(_settings.openclaw_bridge_timeout_seconds or 60))

        async def _on_timeout() -> None:
            popped = await pending_replies.pop_by_msg(bot_msg.msg_id)
            if popped is None:
                return  # already finalized via plugin reply
            logger.warning(
                "websocket_bot_timeout: bot_id=%s task_id=%s msg_id=%s after %ds",
                bot_id, task_id, bot_msg.msg_id, timeout_s,
            )
            async with async_session_factory() as s2:
                try:
                    await finalize_bot_reply(
                        s2,
                        bot_id=bot_id,
                        channel_id=ctx.channel_id,
                        content=f"[WebSocket Bot] 等待 OpenClaw channel plugin 回推超时（>{timeout_s}s）",
                        task_id=task_id,
                        reply_to_msg_id=bot_msg.msg_id,
                    )
                    await s2.commit()
                except Exception:
                    await s2.rollback()
                    raise

        pending = await pending_replies.peek_by_msg(bot_msg.msg_id)
        if pending is None:
            logger.warning(
                "register_async_pending: pending not pre-registered for msg_id=%s; "
                "reply may race",
                bot_msg.msg_id,
            )
            return
        loop = asyncio.get_event_loop()

        def _fire() -> None:
            asyncio.create_task(_on_timeout())

        pending.timeout_handle = loop.call_later(timeout_s, _fire)
