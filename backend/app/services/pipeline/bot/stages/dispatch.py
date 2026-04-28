"""DispatchStage: serial pre-create → parallel execute → serial finalize.

Drives the regular @mention path:

1. **Pre-create** — for each mentioned bot, ``writer.pre_create`` writes a
   placeholder Message and broadcasts ``BotMessagePlaceholder`` so the UI
   gets an empty bubble immediately.
2. **Execute** — ``asyncio.gather`` runs every adapter's ``execute`` in
   parallel. No DB writes happen in this phase, just LLM I/O.
3. **Finalize** — serially walk results, ``writer.finalize`` each placeholder
   with the response content (or an error string if the adapter raised),
   record an AgentTask, and recursively trigger any bots that the reply
   itself @-mentions (Bot@Bot, capped at MAX_BOT_MENTION_DEPTH=3).

Coordinator + auto-takeover handling lives in AutoTakeoverStage; this
stage skips coordinator when ``ctx.direct_answer_mode`` is set.
"""
from __future__ import annotations

import asyncio
import logging
import time

from app.db.models import Message
from app.services.adapters.base import AgentPayload, AgentResponse, OpenClawAdapter
from app.services.orchestrator.mention import extract_mentions, filter_mentioned_bots
from app.services.pipeline.bot.context import BotRunContext
from app.services.pipeline.stage import Stage

logger = logging.getLogger("app.services.pipeline.bot.dispatch")

COORDINATOR_USERNAME = "Coordinator"
MAX_BOT_MENTION_DEPTH = 3


def _build_payload(
    ctx: BotRunContext,
    *,
    bot_id: str,
    bot_msg: Message,
    other_bots: list[str],
    sub_username: str | None = None,
    in_reply_to_msg_id: str | None = None,
) -> AgentPayload:
    """Compose the AgentPayload that mirror's run_orchestrator's regular-bot
    construction. ``sub_username`` is set on Bot@Bot recursion so the sub-bot
    sees the channel's other bots minus itself; otherwise it equals the
    primary mentioned username."""
    if sub_username is None:
        sub_username = next((u for u, bid in ctx.bot_id_by_username.items() if bid == bot_id), "")
    return AgentPayload(
        task_id=ctx.root_task_id,
        channel_id=ctx.channel_id,
        trigger_message={
            "user": ctx.trigger_msg.sender_id,
            "sender_name": ctx.sender_name,
            "text": ctx.trigger_content,
            "timestamp": ctx.trigger_msg.created_at.isoformat() if ctx.trigger_msg.created_at else "",
            "msg_id": ctx.trigger_msg.msg_id,
            "in_reply_to_msg_id": in_reply_to_msg_id or ctx.trigger_msg.in_reply_to_msg_id,
            "topic_chain": ctx.topic_chain,
            "child_replies": ctx.child_replies,
        },
        memory_context=ctx.memory_context,
        attachments=ctx.attachments,
        original_question_text=ctx.original_question,
        process_config={
            "channel_bot_usernames": other_bots,
            "channel_bot_details": {
                key: value for key, value in ctx.bot_details_by_username.items() if key != sub_username
            },
            "bot_id_by_username": {
                key: value for key, value in ctx.bot_id_by_username.items() if key != sub_username
            },
            "_adapter_factory": ctx.adapter_factory,
            "_create_and_broadcast": ctx.writer.create_and_broadcast,
            "_stream_token": ctx.writer.make_stream_token_cb(bot_msg.msg_id),
            "_event_bus": ctx.bus,
            "_db_session": ctx.session,
            "_bot_id": bot_id,
            "_placeholder_msg_id": bot_msg.msg_id,
            "_user_secrets": ctx.user_secrets,
            "_sender_name": ctx.sender_name,
            "_channel_name": ctx.channel_name,
        },
    )


async def trigger_sub_bots_from_mentions(
    ctx: BotRunContext,
    parent_msg: Message,
    parent_bot_id: str,
    trigger_content: str,
    depth: int,
) -> None:
    """Recursively dispatch bots @-mentioned in a bot's reply (Bot@Bot).

    Cycles are broken via ``ctx.triggered_bot_ids``; depth is capped to
    ``MAX_BOT_MENTION_DEPTH``. Each sub-bot's reply re-enters this function
    until either no further @-mentions appear or the cap is hit.
    """
    if depth >= MAX_BOT_MENTION_DEPTH:
        return

    mentions = filter_mentioned_bots(
        extract_mentions(parent_msg.content or "", ctx.channel_bot_usernames),
        ctx.channel_bot_usernames,
    )
    for sub_username in mentions:
        sub_bot_id = ctx.bot_id_by_username.get(sub_username)
        if not sub_bot_id:
            continue
        if sub_bot_id in ctx.triggered_bot_ids:
            logger.info("bot_mention_trigger: skip %s (already triggered)", sub_username)
            continue
        if sub_bot_id == parent_bot_id:
            logger.info("bot_mention_trigger: skip %s (self-call)", sub_username)
            continue

        ctx.triggered_bot_ids.add(sub_bot_id)
        logger.info(
            "bot_mention_trigger: @%s triggered by bot_id=%s depth=%d",
            sub_username, parent_bot_id, depth,
        )

        sub_adapter = await ctx.adapter_factory(sub_bot_id)
        sub_msg = await ctx.writer.pre_create(sub_bot_id, ctx.root_task_id)
        # Sub-reply's in_reply_to points at the parent bot's message.
        sub_msg.in_reply_to_msg_id = parent_msg.msg_id
        await ctx.session.flush()

        other_bots = [item for item in ctx.channel_bot_usernames if item != sub_username]
        sub_payload = _build_payload(
            ctx,
            bot_id=sub_bot_id,
            bot_msg=sub_msg,
            other_bots=other_bots,
            sub_username=sub_username,
            in_reply_to_msg_id=ctx.trigger_msg.in_reply_to_msg_id,
        )

        try:
            sub_resp = await sub_adapter.execute(sub_payload)
            if sub_resp.dispatched_async:
                await ctx.writer.register_async_pending(sub_msg, ctx.root_task_id, sub_bot_id)
                await ctx.writer.record_task(sub_bot_id, sub_msg.msg_id)
                ctx.bot_messages.append(sub_msg)
                ctx.bot_msg_by_id[sub_bot_id] = sub_msg
                continue
            sub_content = (
                sub_resp.content if sub_resp.success else (sub_resp.error_message or "处理出错")
            )
            sub_file_ids = sub_resp.file_ids or []
        except Exception as exc:
            logger.warning("bot_mention_trigger: bot %s raised: %s", sub_username, exc)
            sub_content = f"处理出错: {exc}"
            sub_file_ids = []

        await ctx.writer.finalize(sub_msg, sub_content, file_ids=sub_file_ids)
        await ctx.writer.record_task(sub_bot_id, sub_msg.msg_id)
        ctx.bot_messages.append(sub_msg)
        ctx.bot_msg_by_id[sub_bot_id] = sub_msg

        # Recurse into the sub-bot's reply for further @-mentions.
        await trigger_sub_bots_from_mentions(
            ctx, sub_msg, sub_bot_id, trigger_content, depth + 1,
        )


async def _timed_execute(adapter, payload):
    t0 = time.perf_counter()
    try:
        return await adapter.execute(payload), (time.perf_counter() - t0) * 1000
    except Exception as exc:
        return exc, (time.perf_counter() - t0) * 1000


class DispatchStage(Stage[BotRunContext]):
    async def run(self, ctx: BotRunContext) -> None:
        # Coordinator's direct-answer path runs in AutoTakeoverStage; skip
        # it here so it isn't dispatched twice.
        regular_targets = [
            u for u in ctx.target_usernames
            if not (u == COORDINATOR_USERNAME and ctx.direct_answer_mode)
        ]
        if not regular_targets:
            return

        pending_bots = await self._phase1_pre_create(ctx, regular_targets)
        if not pending_bots:
            return

        timed_results = await asyncio.gather(
            *[_timed_execute(adapter, payload) for _, _, _, payload, adapter in pending_bots],
        )
        await self._phase3_finalize(ctx, pending_bots, timed_results)

    @staticmethod
    async def _phase1_pre_create(
        ctx: BotRunContext, regular_targets: list[str],
    ) -> list[tuple[str, str, Message, AgentPayload, OpenClawAdapter]]:
        pending: list[tuple[str, str, Message, AgentPayload, OpenClawAdapter]] = []
        for username in regular_targets:
            bot_id = ctx.bot_id_by_username[username]
            if ctx.broadcast_processing:
                await ctx.broadcast_processing(ctx.channel_id, bot_id, username)
            if ctx.attachment_error:
                await ctx.writer.finish_with_error(
                    bot_id, ctx.root_task_id, ctx.attachment_error,
                )
                continue
            adapter = await ctx.adapter_factory(bot_id)
            other_bots = [item for item in ctx.channel_bot_usernames if item != username]
            bot_msg = await ctx.writer.pre_create(bot_id, ctx.root_task_id)
            payload = _build_payload(
                ctx,
                bot_id=bot_id,
                bot_msg=bot_msg,
                other_bots=other_bots,
                sub_username=username,
            )
            logger.info(
                "orchestrator: queuing bot bot_id=%s username=%s memory_layers=%d attachments=%d",
                bot_id, username, len(ctx.memory_context), len(ctx.attachments),
            )
            pending.append((username, bot_id, bot_msg, payload, adapter))
        return pending

    @staticmethod
    async def _phase3_finalize(
        ctx: BotRunContext,
        pending_bots: list[tuple[str, str, Message, AgentPayload, OpenClawAdapter]],
        timed_results: list[tuple[AgentResponse | BaseException, float]],
    ) -> None:
        for (username, bot_id, bot_msg, _, _), (resp, dur_ms) in zip(pending_bots, timed_results):
            if isinstance(resp, BaseException):
                logger.warning(
                    "orchestrator: bot %s raised exception: %s duration_ms=%.0f",
                    username, resp, dur_ms,
                )
                content = f"处理出错: {resp}"
                resp_file_ids: list[str] = []
            elif resp.dispatched_async:
                logger.info(
                    "orchestrator: bot %s async-dispatched via bridge duration_ms=%.0f",
                    username, dur_ms,
                )
                await ctx.writer.register_async_pending(bot_msg, ctx.root_task_id, bot_id)
                await ctx.writer.record_task(bot_id, bot_msg.msg_id)
                ctx.bot_messages.append(bot_msg)
                ctx.triggered_bot_ids.add(bot_id)
                ctx.bot_msg_by_id[bot_id] = bot_msg
                continue
            else:
                if not resp.success:
                    logger.warning(
                        "orchestrator: bot %s failed: %s duration_ms=%.0f",
                        username, resp.error_message or "unknown", dur_ms,
                    )
                else:
                    logger.info(
                        "orchestrator: bot %s completed duration_ms=%.0f",
                        username, dur_ms,
                    )
                content = resp.content if resp.success else (resp.error_message or "处理出错")
                resp_file_ids = resp.file_ids or []
            await ctx.writer.finalize(bot_msg, content, file_ids=resp_file_ids)
            await ctx.writer.record_task(bot_id, bot_msg.msg_id)
            ctx.bot_messages.append(bot_msg)
            ctx.triggered_bot_ids.add(bot_id)
            ctx.bot_msg_by_id[bot_id] = bot_msg
            await trigger_sub_bots_from_mentions(
                ctx, bot_msg, bot_id, ctx.trigger_content, depth=0,
            )
