"""AutoTakeoverStage: coordinator direct-answer + auto-takeover phase 2.

Runs only when ``ctx.direct_answer_mode`` and the Coordinator bot is among
the target usernames — i.e. the channel has auto-assist enabled and the
user didn't @-mention anyone, so the orchestrator routed the message to
the Coordinator. The stage:

1. Dispatches Coordinator with full streaming hooks in its process_config
   (so its ``call_bot`` tool can stream sub-bot replies into freshly
   pre-created placeholders).
2. If the coordinator's reply contains "建议 @bot1, @bot2, ..." patterns
   AND ``orchestrator.auto_takeover`` is enabled, parses the suggestions
   and emits a routing card describing the picks + plan.
3. Dispatches the suggested bots in parallel with **minimal** process_config
   (no adapter_factory, no bot_id lookup) — by design they cannot
   recursively call other bots; this matches the "Capabilities.leaf()"
   contract in the Phase 3 plan.

Bot@Bot recursion only fires for the coordinator's own reply (sub-bots
suggested by takeover are leaves).
"""
from __future__ import annotations

import asyncio
import logging

from app.db.models import Message
from app.services.adapters.base import AgentPayload, AgentResponse, OpenClawAdapter
from app.services.admin.settings_store import get_assist_settings
from app.services.orchestrator.orchestrator_adapter import extract_suggested_bots
from app.services.pipeline.bot.context import BotRunContext
from app.services.pipeline.bot.stages.dispatch import trigger_sub_bots_from_mentions
from app.services.pipeline.stage import Stage

logger = logging.getLogger("app.services.pipeline.bot.auto_takeover")

COORDINATOR_USERNAME = "Coordinator"


def _build_coordinator_payload(
    ctx: BotRunContext, bot_id: str, orch_msg: Message,
) -> AgentPayload:
    """Coordinator's payload differs from the regular DispatchStage one:
    its ``trigger_message`` carries ``msg_type`` (used to render the
    coordinator's clarify cards), and its ``process_config`` includes
    ``_pre_create_bot_msg``/``_finalize_bot_msg``/``_make_stream_token_cb``
    so its ``call_bot`` tool can stream sub-bot replies."""
    other_bots = [u for u in ctx.channel_bot_usernames if u != COORDINATOR_USERNAME]
    return AgentPayload(
        task_id=ctx.root_task_id,
        channel_id=ctx.channel_id,
        trigger_message={
            "user": ctx.trigger_msg.sender_id,
            "sender_name": ctx.sender_name,
            "text": ctx.trigger_content,
            "timestamp": ctx.trigger_msg.created_at.isoformat() if ctx.trigger_msg.created_at else "",
            "msg_id": ctx.trigger_msg.msg_id,
            "in_reply_to_msg_id": ctx.trigger_msg.in_reply_to_msg_id,
            "msg_type": ctx.trigger_msg.msg_type,
            "topic_chain": ctx.topic_chain,
            "child_replies": ctx.child_replies,
        },
        memory_context=ctx.memory_context,
        attachments=ctx.attachments,
        original_question_text=ctx.original_question,
        process_config={
            "channel_bot_usernames": other_bots,
            "channel_bot_details": {
                k: v for k, v in ctx.bot_details_by_username.items() if k != COORDINATOR_USERNAME
            },
            "bot_id_by_username": {
                k: v for k, v in ctx.bot_id_by_username.items() if k != COORDINATOR_USERNAME
            },
            "_adapter_factory": ctx.adapter_factory,
            "_create_and_broadcast": ctx.writer.create_and_broadcast,
            "_stream_token": ctx.writer.make_stream_token_cb(orch_msg.msg_id),
            "_event_bus": ctx.bus,
            "_db_session": ctx.session,
            "_pre_create_bot_msg": ctx.writer.pre_create,
            "_finalize_bot_msg": ctx.writer.finalize,
            "_make_stream_token_cb": ctx.writer.make_stream_token_cb,
            "_bot_id": bot_id,
            "_placeholder_msg_id": orch_msg.msg_id,
            "_user_secrets": ctx.user_secrets,
            "_sender_name": ctx.sender_name,
            "_channel_name": ctx.channel_name,
        },
    )


def _build_suggested_payload(
    ctx: BotRunContext, sug_bot_id: str, sug_msg: Message,
) -> AgentPayload:
    """Suggested-bot payload is intentionally minimal: no adapter_factory,
    no bot_id lookup, no channel_bot_details. The takeover suggestees are
    leaves — they cannot ``call_bot`` further. Matches the
    Capabilities.leaf() contract in the Phase 3 plan."""
    return AgentPayload(
        task_id=ctx.root_task_id,
        channel_id=ctx.channel_id,
        trigger_message={
            "user": ctx.trigger_msg.sender_id,
            "sender_name": ctx.sender_name,
            "text": ctx.trigger_content,
            "timestamp": ctx.trigger_msg.created_at.isoformat() if ctx.trigger_msg.created_at else "",
            "in_reply_to_msg_id": ctx.trigger_msg.in_reply_to_msg_id,
            "topic_chain": ctx.topic_chain,
            "child_replies": ctx.child_replies,
        },
        memory_context=ctx.memory_context,
        attachments=ctx.attachments,
        original_question_text=ctx.original_question,
        process_config={
            "_stream_token": ctx.writer.make_stream_token_cb(sug_msg.msg_id),
            "_event_bus": ctx.bus,
            "_bot_id": sug_bot_id,
            "_placeholder_msg_id": sug_msg.msg_id,
            "_user_secrets": ctx.user_secrets,
            "_sender_name": ctx.sender_name,
            "_channel_name": ctx.channel_name,
        },
    )


class AutoTakeoverStage(Stage[BotRunContext]):
    async def run(self, ctx: BotRunContext) -> None:
        if not (COORDINATOR_USERNAME in ctx.target_usernames and ctx.direct_answer_mode):
            return

        bot_id = ctx.bot_id_by_username[COORDINATOR_USERNAME]
        adapter = await ctx.adapter_factory(bot_id)

        if ctx.attachment_error:
            await ctx.writer.finish_with_error(bot_id, ctx.root_task_id, ctx.attachment_error)
            return

        content = await self._dispatch_coordinator(ctx, bot_id, adapter)
        if content is None:
            # async-dispatched or coordinator errored — skip takeover follow-up
            return

        if not get_assist_settings().get("auto_takeover"):
            return

        suggested = extract_suggested_bots(content)
        valid_suggested = [
            sug for sug in suggested
            if sug in ctx.channel_bot_usernames and sug != COORDINATOR_USERNAME
        ]
        if not valid_suggested:
            return

        await ctx.writer.emit_routing_card(
            coordinator_bot_id=bot_id,
            coordinator_content=content,
            picked_usernames=valid_suggested,
        )
        await self._dispatch_suggested(ctx, valid_suggested)

    @staticmethod
    async def _dispatch_coordinator(
        ctx: BotRunContext, bot_id: str, adapter: OpenClawAdapter,
    ) -> str | None:
        """Pre-create a placeholder, run the coordinator, finalize. Returns
        the coordinator's reply text on success, or ``None`` if the call
        was async-dispatched (no in-band reply yet — takeover is skipped)."""
        orch_msg = await ctx.writer.pre_create(bot_id, ctx.root_task_id)
        payload = _build_coordinator_payload(ctx, bot_id, orch_msg)
        resp: AgentResponse = await adapter.execute(payload)

        if resp.dispatched_async:
            await ctx.writer.register_async_pending(orch_msg, ctx.root_task_id, bot_id)
            await ctx.writer.record_task(bot_id, orch_msg.msg_id)
            ctx.bot_messages.append(orch_msg)
            ctx.triggered_bot_ids.add(bot_id)
            ctx.bot_msg_by_id[bot_id] = orch_msg
            return None

        content = resp.content if resp.success else (resp.error_message or "处理出错")
        await ctx.writer.finalize(orch_msg, content, file_ids=resp.file_ids)
        await ctx.writer.record_task(bot_id, orch_msg.msg_id)
        ctx.bot_messages.append(orch_msg)
        ctx.triggered_bot_ids.add(bot_id)
        ctx.bot_msg_by_id[bot_id] = orch_msg

        # Bot@Bot recursion only for the coordinator's own reply.
        await trigger_sub_bots_from_mentions(
            ctx, orch_msg, bot_id, ctx.trigger_content, depth=0,
        )
        return content

    @staticmethod
    async def _dispatch_suggested(
        ctx: BotRunContext, valid_suggested: list[str],
    ) -> None:
        # Phase 1: serial pre-create
        pending: list[tuple[str, str, Message, AgentPayload, OpenClawAdapter]] = []
        for sug_username in valid_suggested:
            sug_bot_id = ctx.bot_id_by_username[sug_username]
            if ctx.broadcast_processing:
                await ctx.broadcast_processing(ctx.channel_id, sug_bot_id, sug_username)
            sug_adapter = await ctx.adapter_factory(sug_bot_id)
            sug_msg = await ctx.writer.pre_create(sug_bot_id, ctx.root_task_id)
            sug_payload = _build_suggested_payload(ctx, sug_bot_id, sug_msg)
            pending.append((sug_username, sug_bot_id, sug_msg, sug_payload, sug_adapter))
            logger.info(
                "orchestrator_auto_takeover: triggered @%s memory_layers=%d",
                sug_username, len(ctx.memory_context),
            )

        if not pending:
            return

        # Phase 2: parallel execute
        sug_results = await asyncio.gather(
            *[a.execute(p) for _, _, _, p, a in pending],
            return_exceptions=True,
        )

        # Phase 3: serial finalize
        for (sug_username, sug_bot_id, sug_msg, _, _), sug_resp in zip(pending, sug_results):
            if isinstance(sug_resp, BaseException):
                logger.warning(
                    "orchestrator_auto_takeover: bot %s raised: %s",
                    sug_username, sug_resp,
                )
                sug_content = f"处理出错: {sug_resp}"
            elif sug_resp.dispatched_async:
                await ctx.writer.register_async_pending(sug_msg, ctx.root_task_id, sug_bot_id)
                await ctx.writer.record_task(sug_bot_id, sug_msg.msg_id)
                ctx.bot_messages.append(sug_msg)
                logger.info("orchestrator_auto_takeover: async-dispatched @%s", sug_username)
                continue
            else:
                sug_content = (
                    sug_resp.content if sug_resp.success else (sug_resp.error_message or "处理出错")
                )
            await ctx.writer.finalize(sug_msg, sug_content)
            await ctx.writer.record_task(sug_bot_id, sug_msg.msg_id)
            ctx.bot_messages.append(sug_msg)
            logger.info("orchestrator_auto_takeover: triggered @%s", sug_username)
