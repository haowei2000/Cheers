"""BotMessageWriter: the single owner of the bot-reply lifecycle.

Encapsulates the helpers that used to live as closures inside
``run_bot_pipeline``: pre-create a placeholder, finalize content + files,
broadcast a fully-formed message, emit a routing card, render an error
fallback, log an AgentTask row, and arm the WebSocket-bot timeout. One
writer per Bot pipeline run; it holds no state of its own — every method
reads from the BotRunContext passed to ``__init__``.

Stages (DispatchStage, AutoTakeoverStage) and adapter sub-bot paths
(call_bot in channel_bot.py) compose this object instead of carrying
loose closures around inside ``process_config``.

Token streaming is no longer part of this class — adapters yield
``Delta`` events directly out of ``execute`` and ``subagent._consume_execute``
republishes them to the channel EventBus.
"""
from __future__ import annotations

import asyncio
import logging
import uuid
from typing import TYPE_CHECKING

from sqlalchemy import select

from app.application.chat.message_assembler import MessageAssembler
from app.db.models import AgentTask, BotAccount, FileRecord, Message
from app.features.bot_runtime.pipeline.bot.mention import resolve_user_mentions
from app.features.bot_runtime.pipeline.bot.topic_context import MSG_TYPE_REPLY, ensure_topic_root
from app.features.bot_runtime.pipeline.events import (
    BotMessagePlaceholder,
    MessageCreated,
    MessageDone,
)

if TYPE_CHECKING:
    from app.features.bot_runtime.pipeline.bot.context import BotRunContext

logger = logging.getLogger("app.features.bot_runtime.pipeline.bot.writer")


class BotMessageWriter:
    def __init__(self, ctx: "BotRunContext") -> None:
        self.ctx = ctx

    # ── streaming lifecycle: placeholder → deltas → done ────────────────

    async def pre_create(self, bot_id: str, task_id: str) -> Message:
        ctx = self.ctx
        is_dm = ctx.channel is not None and ctx.channel.type == "dm"
        msg = Message(
            channel_id=ctx.channel_id,
            sender_id=bot_id,
            sender_type="bot",
            content="",
            content_data=(
                {"memory_load": ctx.memory_load_detail}
                if ctx.memory_load_detail
                else None
            ),
            task_id=task_id,
            in_reply_to_msg_id=None if is_dm else ctx.trigger_msg.msg_id,
            msg_type="normal" if is_dm else MSG_TYPE_REPLY,
        )
        ctx.session.add(msg)
        await ctx.session.flush()
        if not is_dm:
            await ensure_topic_root(ctx.session, ctx.trigger_msg.msg_id)
        from app.features.bot_runtime.bot_events.runs import ensure_bot_run

        await ensure_bot_run(
            ctx.session,
            task_id=task_id,
            channel_id=ctx.channel_id,
            trigger_msg_id=ctx.trigger_msg.msg_id,
            bot_id=bot_id,
            placeholder_msg_id=msg.msg_id,
            status="placeholder_created",
            last_event_type="placeholder_created",
        )
        await ctx.session.commit()
        await ctx.bus.publish(BotMessagePlaceholder(data=MessageAssembler.assemble(msg)))
        ctx.already_broadcast.add(msg.msg_id)
        return msg

    async def finalize(
        self,
        msg: Message,
        content: str,
        *,
        file_ids: list[str] | None = None,
        is_partial: bool = False,
        error: str | None = None,
        run_status: str = "done",
        last_event_type: str = "message_done",
        run_error_message: str | None = None,
    ) -> None:
        ctx = self.ctx
        msg.content = content
        msg.is_partial = bool(is_partial)
        msg.mention_user_ids = await resolve_user_mentions(
            content, ctx.session, ctx.channel_id,
        )
        if file_ids:
            msg.file_ids = list({*(msg.file_ids or []), *file_ids})
        await ctx.session.flush()
        from app.features.bot_runtime.bot_events.runs import mark_bot_run_status

        await mark_bot_run_status(
            ctx.session,
            placeholder_msg_id=msg.msg_id,
            status=run_status,
            last_event_type=last_event_type,
            error_message=run_error_message,
        )

        file_map = {}
        if msg.file_ids:
            result = await ctx.session.execute(
                select(FileRecord).where(FileRecord.file_id.in_(msg.file_ids))
            )
            file_map = {r.file_id: r for r in result.scalars().all()}
        await ctx.session.commit()
        await ctx.bus.publish(
            MessageDone(
                msg_id=msg.msg_id,
                content=content,
                update=MessageAssembler.update(
                    msg,
                    file_map=file_map,
                    is_partial=msg.is_partial,
                    error=error,
                    content_data=msg.content_data,
                ),
                content_data=msg.content_data,
            )
        )
        from app.features.agent_bridge.streams import stream_registry

        await stream_registry.pop(msg.msg_id)

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

            dto = MessageAssembler.assemble(routing_msg)
            coord_row = await ctx.session.execute(
                select(BotAccount.display_name, BotAccount.username).where(
                    BotAccount.bot_id == coordinator_bot_id
                )
            )
            coord_info = coord_row.first()
            if coord_info:
                dto.sender_name = coord_info[0] or coord_info[1] or ""

            await ctx.session.commit()
            await ctx.bus.publish(MessageCreated(data=dto))
            ctx.already_broadcast.add(routing_msg.msg_id)
            ctx.bot_messages.append(routing_msg)
        except Exception:
            logger.exception(
                "bot_pipeline: failed to emit routing card channel_id=%s",
                ctx.channel_id,
            )

    # ── error-path shortcut ─────────────────────────────────────────────

    async def finish_with_error(
        self, bot_id: str, task_id: str, error_msg: str,
    ) -> Message:
        """Pre-create a placeholder, finalize it with an error message, and
        record the AgentTask. Used when an attachment-prep failure means
        the bot can't even start — the user still gets a visible reply."""
        msg = await self.pre_create(bot_id, task_id)
        await self.finalize(msg, error_msg)
        await self.record_task(bot_id, msg.msg_id)
        self.ctx.bot_messages.append(msg)
        return msg

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
        await ctx.session.commit()

    async def register_async_pending(
        self, bot_msg: Message, task_id: str, bot_id: str,
    ) -> None:
        """Agent Bridge Bot 异步派发：占位消息不立即 finalize，为后台 task 武装前台等待 timer。

        PendingReply 已由 AgentBridgeBotAdapter.execute() 在 dispatch 之前预登记
        （避免 plugin 秒回时 pending 未登记的竞态）；这里只 arm "转后台 task"
        的 timer。timer 触发后 pending 会继续保留，provider 可继续长期运行，
        迟到的最终回复仍会更新同一条消息。
        """
        from app.config import settings as _settings
        from app.db.session import async_session_factory
        from app.features.agent_bridge.pending import pending_replies
        from app.features.bot_runtime.pipeline.bot.task_timeout import (
            AgentBridgeTaskTimeoutContext,
            make_agent_bridge_task_timeout_pipeline,
        )

        ctx = self.ctx
        if ctx.channel is not None and ctx.channel.type == "dm":
            from app.features.bot_runtime.bot_events.runs import mark_bot_run_status

            await mark_bot_run_status(
                ctx.session,
                placeholder_msg_id=bot_msg.msg_id,
                status="dispatched_async",
                last_event_type="agent_bridge.dispatch",
            )
            await ctx.session.commit()
            logger.info(
                "register_async_pending: dm scope skips background task timer bot_id=%s task_id=%s msg_id=%s",
                bot_id,
                task_id,
                bot_msg.msg_id,
            )
            return
        timeout_s = max(5, int(_settings.agent_bridge_timeout_seconds or 600))

        async def _on_timeout() -> None:
            logger.warning(
                "agent_bridge_bot_slow_reply: bot_id=%s task_id=%s msg_id=%s after %ds",
                bot_id, task_id, bot_msg.msg_id, timeout_s,
            )
            async with async_session_factory() as s2:
                try:
                    timeout_ctx = AgentBridgeTaskTimeoutContext(
                        session=s2,
                        bot_id=bot_id,
                        channel_id=ctx.channel_id,
                        task_id=task_id,
                        msg_id=bot_msg.msg_id,
                        timeout_s=timeout_s,
                    )
                    await make_agent_bridge_task_timeout_pipeline().run(timeout_ctx)
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
        from app.features.bot_runtime.bot_events.runs import mark_bot_run_status

        await mark_bot_run_status(
            ctx.session,
            placeholder_msg_id=bot_msg.msg_id,
            status="dispatched_async",
            last_event_type="agent_bridge.dispatch",
        )
        await ctx.session.commit()
        loop = asyncio.get_event_loop()

        def _fire() -> None:
            asyncio.create_task(_on_timeout())

        pending.timeout_handle = loop.call_later(timeout_s, _fire)
