"""Unified sub-agent dispatch helpers.

Today the orchestrator dispatches bots in four places — DispatchStage's
regular @mention loop, AutoTakeoverStage's coordinator call,
AutoTakeoverStage's parallel suggestees, and ``trigger_sub_bots_from_mentions``'s
Bot@Bot recursion — plus channel_bot.py's ``call_bot`` tool. Each had its
own copy of the pre-create + build-payload + execute + finalize flow, and
each carried a slightly different ``process_config`` shape.

This module collapses them into one. The shape differences are now expressed
through ``Capabilities`` rather than duplicated dict literals:

  - ``build_payload(ctx, bot_id, msg, capabilities, ...)``: build the
    AgentPayload for one dispatch.
  - ``dispatch_one(ctx, bot_id, *, capabilities, recurse=False, depth=0)``:
    serial single-bot path. Used by call_bot, Bot@Bot recursion,
    coordinator dispatch.
  - ``dispatch_many(ctx, usernames, *, capabilities, recurse=False)``:
    parallel multi-bot path with the legacy 3-phase pattern (serial
    pre-create → parallel execute → serial finalize). Used by
    DispatchStage's regular @mention loop and AutoTakeoverStage's
    suggested-bots phase.

Recursion (Bot@Bot) is a per-call-site choice, not a capability of the
target bot — pass ``recurse=True`` when the call site wants a successful
reply's @-mentions to fire further sub-bots.
"""
from __future__ import annotations

import asyncio
import logging
import time

from app.db.models import Message
from app.services.adapters.base import AgentPayload, AgentResponse, OpenClawAdapter
from app.services.pipeline.bot.capabilities import Capabilities
from app.services.pipeline.bot.context import BotRunContext

logger = logging.getLogger("app.services.pipeline.bot.subagent")


def build_payload(
    ctx: BotRunContext,
    *,
    bot_id: str,
    bot_msg: Message,
    capabilities: Capabilities,
    in_reply_to_msg_id: str | None = None,
    trigger_text_override: str | None = None,
    skip_system_prompt: bool = False,
) -> AgentPayload:
    """Compose AgentPayload according to the bot's capabilities.

    ``in_reply_to_msg_id`` defaults to the trigger's own; Bot@Bot recursion
    overrides it to point at the parent bot's reply so the sub-reply chains
    correctly.

    ``trigger_text_override`` replaces ``ctx.trigger_content`` in the
    sub-trigger — used by call_bot when an LLM dispatches a synthetic
    sub-task with its own message text.

    ``skip_system_prompt`` adds a ``_skip_system_prompt`` flag to
    process_config so the sub-adapter knows to suppress its full system
    prompt for short delegated tasks.
    """
    sub_username = next(
        (u for u, bid in ctx.bot_id_by_username.items() if bid == bot_id), "",
    )
    other_bots = [u for u in ctx.channel_bot_usernames if u != sub_username]

    if trigger_text_override is not None:
        from datetime import datetime, timezone
        text = trigger_text_override
        timestamp = datetime.now(timezone.utc).isoformat()
    else:
        text = ctx.trigger_content
        timestamp = (
            ctx.trigger_msg.created_at.isoformat()
            if ctx.trigger_msg.created_at else ""
        )

    trigger_message: dict = {
        "user": ctx.trigger_msg.sender_id,
        "sender_name": ctx.sender_name,
        "text": text,
        "timestamp": timestamp,
        "in_reply_to_msg_id": in_reply_to_msg_id or ctx.trigger_msg.in_reply_to_msg_id,
        "topic_chain": ctx.topic_chain,
        "child_replies": ctx.child_replies,
    }
    if capabilities.can_call_bot:
        trigger_message["msg_id"] = ctx.trigger_msg.msg_id
    if capabilities.include_msg_type:
        trigger_message["msg_type"] = ctx.trigger_msg.msg_type

    # Token streaming flows through execute_iter's Delta events directly;
    # _stream_token in process_config is no longer consumed by any adapter.
    from app.services.pipeline.process_config import ProcessConfig

    process_config = ProcessConfig(
        bot_id=bot_id,
        placeholder_msg_id=bot_msg.msg_id,
        user_secrets=dict(ctx.user_secrets),
        sender_name=ctx.sender_name,
        channel_name=ctx.channel_name,
        event_bus=ctx.bus,
        db_session=ctx.session,
        skip_system_prompt=skip_system_prompt,
    )
    if capabilities.can_call_bot:
        # channel_bot_usernames + details still feed the system-prompt
        # building in ChannelBotAdapter; everything else moved to
        # ``run_ctx`` (sub-adapter tools hop into dispatch_one rather
        # than carrying loose closures around).
        process_config.channel_bot_usernames = other_bots
        process_config.channel_bot_details = {
            k: v for k, v in ctx.bot_details_by_username.items() if k != sub_username
        }
        process_config.run_ctx = ctx

    return AgentPayload(
        task_id=ctx.root_task_id,
        channel_id=ctx.channel_id,
        trigger_message=trigger_message,
        memory_context=ctx.memory_context,
        attachments=ctx.attachments,
        original_question_text=ctx.original_question,
        process_config=process_config,
    )


_Prepared = tuple[str, str, Message, AgentPayload, OpenClawAdapter]
"""(username, bot_id, placeholder_msg, payload, adapter)"""


async def _username_for(ctx: BotRunContext, bot_id: str) -> str:
    return next((u for u, bid in ctx.bot_id_by_username.items() if bid == bot_id), bot_id)


async def _prepare(
    ctx: BotRunContext,
    bot_id: str,
    *,
    capabilities: Capabilities,
    in_reply_to_msg_id: str | None = None,
    trigger_text_override: str | None = None,
    skip_system_prompt: bool = False,
) -> _Prepared:
    """Pre-create placeholder + build payload + load adapter for one bot."""
    username = await _username_for(ctx, bot_id)
    adapter = await ctx.adapter_factory(bot_id)
    bot_msg = await ctx.writer.pre_create(bot_id, ctx.root_task_id)
    payload = build_payload(
        ctx,
        bot_id=bot_id,
        bot_msg=bot_msg,
        capabilities=capabilities,
        in_reply_to_msg_id=in_reply_to_msg_id,
        trigger_text_override=trigger_text_override,
        skip_system_prompt=skip_system_prompt,
    )
    return username, bot_id, bot_msg, payload, adapter


async def _consume_execute(
    ctx: BotRunContext,
    adapter: OpenClawAdapter,
    payload: AgentPayload,
    bot_msg: Message,
) -> tuple[AgentResponse | BaseException, float]:
    """Drain ``adapter.execute_iter`` while republishing Delta events to the
    channel EventBus. Reduces the terminal Final / DispatchedAsync into the
    legacy AgentResponse shape so ``_finalize_response`` stays a single
    branch (existing callers don't see the AsyncIterator)."""
    from app.services.pipeline.adapter_events import (
        Delta,
        DispatchedAsync,
        Final,
    )
    from app.services.pipeline.events import MessageStreamDelta

    t0 = time.perf_counter()
    deltas: list[str] = []
    terminal: Final | DispatchedAsync | None = None
    try:
        async for event in adapter.execute_iter(payload):
            if isinstance(event, Delta):
                deltas.append(event.text)
                await ctx.bus.publish(
                    MessageStreamDelta(msg_id=bot_msg.msg_id, delta=event.text),
                )
            else:
                terminal = event
                break
    except Exception as exc:
        return exc, (time.perf_counter() - t0) * 1000

    dur_ms = (time.perf_counter() - t0) * 1000
    if isinstance(terminal, DispatchedAsync):
        return AgentResponse(
            content="", task_id=payload.task_id, success=True,
            dispatched_async=True,
        ), dur_ms
    if isinstance(terminal, Final):
        return AgentResponse(
            content=terminal.content,
            task_id=payload.task_id,
            success=terminal.success,
            error_message=terminal.error_message,
            file_ids=list(terminal.file_ids),
        ), dur_ms
    # No terminal event — fall back to whatever streamed deltas accumulated.
    return AgentResponse(
        content="".join(deltas),
        task_id=payload.task_id,
        success=False,
        error_message="adapter yielded no terminal event",
    ), dur_ms


async def _finalize_response(
    ctx: BotRunContext,
    username: str,
    bot_id: str,
    bot_msg: Message,
    resp_or_exc: AgentResponse | BaseException,
    dur_ms: float,
    *,
    recurse: bool,
    depth: int,
) -> AgentResponse | None:
    """Handle async-dispatch / error / success branches; record AgentTask;
    optionally recurse via Bot@Bot. Returns the AgentResponse on success
    (None if the call was async-dispatched or raised)."""
    # Local import to break circular dep with stages/dispatch.py
    from app.services.pipeline.bot.stages.dispatch import (
        trigger_sub_bots_from_mentions,
    )

    if isinstance(resp_or_exc, BaseException):
        logger.warning(
            "orchestrator: bot %s raised: %s duration_ms=%.0f",
            username, resp_or_exc, dur_ms,
        )
        await ctx.writer.finalize(bot_msg, f"处理出错: {resp_or_exc}")
        await ctx.writer.record_task(bot_id, bot_msg.msg_id)
        ctx.bot_messages.append(bot_msg)
        ctx.triggered_bot_ids.add(bot_id)
        return None

    resp = resp_or_exc
    if resp.dispatched_async:
        logger.info(
            "orchestrator: bot %s async-dispatched via bridge duration_ms=%.0f",
            username, dur_ms,
        )
        await ctx.writer.register_async_pending(bot_msg, ctx.root_task_id, bot_id)
        await ctx.writer.record_task(bot_id, bot_msg.msg_id)
        ctx.bot_messages.append(bot_msg)
        ctx.triggered_bot_ids.add(bot_id)
        return None

    if not resp.success:
        logger.warning(
            "orchestrator: bot %s failed: %s duration_ms=%.0f",
            username, resp.error_message or "unknown", dur_ms,
        )
    else:
        logger.info(
            "orchestrator: bot %s completed duration_ms=%.0f", username, dur_ms,
        )
    content = resp.content if resp.success else (resp.error_message or "处理出错")
    await ctx.writer.finalize(bot_msg, content, file_ids=resp.file_ids or [])
    await ctx.writer.record_task(bot_id, bot_msg.msg_id)
    ctx.bot_messages.append(bot_msg)
    ctx.triggered_bot_ids.add(bot_id)

    if recurse:
        await trigger_sub_bots_from_mentions(
            ctx, bot_msg, bot_id, ctx.trigger_content, depth=depth,
        )
    return resp


async def dispatch_one(
    ctx: BotRunContext,
    bot_id: str,
    *,
    capabilities: Capabilities,
    recurse: bool = False,
    depth: int = 0,
    in_reply_to_msg_id: str | None = None,
    trigger_text_override: str | None = None,
    skip_system_prompt: bool = False,
    skip_attachment_error: bool = False,
) -> AgentResponse | None:
    """Pre-create + execute + finalize one bot, serially. Used by single-bot
    paths: coordinator dispatch, Bot@Bot recursion, channel_bot's call_bot.
    Returns the AgentResponse on success, ``None`` for async / errors.

    ``skip_attachment_error``: call_bot dispatches a synthetic sub-task
    that doesn't carry the original user's attachments, so an ingest-time
    attachment_error shouldn't short-circuit it."""
    username = await _username_for(ctx, bot_id)
    if ctx.attachment_error and not skip_attachment_error:
        await ctx.writer.finish_with_error(bot_id, ctx.root_task_id, ctx.attachment_error)
        return None
    if ctx.broadcast_processing:
        await ctx.broadcast_processing(ctx.channel_id, bot_id, username)
    _, _, bot_msg, payload, adapter = await _prepare(
        ctx,
        bot_id,
        capabilities=capabilities,
        in_reply_to_msg_id=in_reply_to_msg_id,
        trigger_text_override=trigger_text_override,
        skip_system_prompt=skip_system_prompt,
    )
    resp_or_exc, dur_ms = await _consume_execute(ctx, adapter, payload, bot_msg)
    return await _finalize_response(
        ctx, username, bot_id, bot_msg, resp_or_exc, dur_ms,
        recurse=recurse, depth=depth,
    )


async def dispatch_many(
    ctx: BotRunContext,
    usernames: list[str],
    *,
    capabilities: Capabilities,
    recurse: bool = False,
) -> None:
    """3-phase parallel dispatch: serial pre-create → parallel execute →
    serial finalize. Used by DispatchStage's regular @mention loop and
    AutoTakeoverStage's suggestees phase."""
    pending: list[_Prepared] = []
    for username in usernames:
        bot_id = ctx.bot_id_by_username[username]
        if ctx.broadcast_processing:
            await ctx.broadcast_processing(ctx.channel_id, bot_id, username)
        if ctx.attachment_error:
            await ctx.writer.finish_with_error(
                bot_id, ctx.root_task_id, ctx.attachment_error,
            )
            continue
        prepared = await _prepare(ctx, bot_id, capabilities=capabilities)
        pending.append(prepared)
        logger.info(
            "orchestrator: queuing bot bot_id=%s username=%s memory_layers=%d attachments=%d",
            bot_id, username, len(ctx.memory_context), len(ctx.attachments),
        )

    if not pending:
        return

    timed_results = await asyncio.gather(
        *[_consume_execute(ctx, adapter, payload, bot_msg)
          for _, _, bot_msg, payload, adapter in pending],
    )
    for (username, bot_id, bot_msg, _, _), (resp_or_exc, dur_ms) in zip(pending, timed_results):
        await _finalize_response(
            ctx, username, bot_id, bot_msg, resp_or_exc, dur_ms,
            recurse=recurse, depth=0,
        )
