"""Unified sub-agent dispatch helpers.

The Bot pipeline dispatches bots in four places — DispatchStage's
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
from typing import TYPE_CHECKING

from app.config import settings
from app.db.models import Message
from app.features.bot_runtime.adapters.base import (
    AgentPayload,
    AgentResponse,
    BotAdapter,
    BotContext,
    BotMessageInput,
)
from app.features.bot_runtime.pipeline.bot.capabilities import Capabilities
from app.features.bot_runtime.pipeline.bot.context import BotRunContext

if TYPE_CHECKING:
    from app.features.bot_runtime.pipeline.bot.writer import BotMessageWriter

logger = logging.getLogger("app.features.bot_runtime.pipeline.bot.subagent")


def _writer(ctx: BotRunContext) -> "BotMessageWriter":
    if ctx.writer is None:
        raise RuntimeError("BotMessageWriter is not initialized")
    return ctx.writer


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
        (u for u, bid in ctx.bot_id_by_username.items() if bid == bot_id),
        "",
    )
    other_bots = [u for u in ctx.channel_bot_usernames if u != sub_username]

    if trigger_text_override is not None:
        from datetime import datetime, timezone

        text = trigger_text_override
        timestamp = datetime.now(timezone.utc).isoformat()
    else:
        text = ctx.trigger_content
        timestamp = ctx.trigger_msg.created_at.isoformat() if ctx.trigger_msg.created_at else ""

    message = BotMessageInput(
        text=text,
        sender_id=ctx.trigger_msg.sender_id,
        sender_name=ctx.sender_name,
        timestamp=timestamp,
        in_reply_to_msg_id=in_reply_to_msg_id or ctx.trigger_msg.in_reply_to_msg_id,
        topic_chain=list(ctx.topic_chain),
        child_replies=list(ctx.child_replies),
    )
    if capabilities.can_call_bot:
        message.msg_id = ctx.trigger_msg.msg_id
    if capabilities.include_msg_type:
        message.msg_type = ctx.trigger_msg.msg_type

    # Token streaming flows through execute's Delta events directly;
    # _stream_token in process_config is no longer consumed by any adapter.
    from app.features.bot_runtime.pipeline.process_config import BotRuntime

    runtime = BotRuntime(
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
        runtime.channel_bot_usernames = other_bots
        runtime.channel_bot_details = {k: v for k, v in ctx.bot_details_by_username.items() if k != sub_username}
        runtime.run_ctx = ctx

    return AgentPayload(
        task_id=ctx.root_task_id,
        channel_id=ctx.channel_id,
        message=message,
        context=BotContext(
            memory=dict(ctx.memory_context),
            attachments=list(ctx.attachments),
            original_question_text=ctx.original_question,
        ),
        runtime=runtime,
    )


_Prepared = tuple[str, str, Message, AgentPayload, BotAdapter]
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
    bot_msg = await _writer(ctx).pre_create(bot_id, ctx.root_task_id)
    from app.features.agent_bridge.service import register_stream

    stream_state = await register_stream(
        msg_id=bot_msg.msg_id,
        bot_id=bot_id,
        channel_id=ctx.channel_id,
        task_id=ctx.root_task_id,
        source="local",
    )
    payload = build_payload(
        ctx,
        bot_id=bot_id,
        bot_msg=bot_msg,
        capabilities=capabilities,
        in_reply_to_msg_id=in_reply_to_msg_id,
        trigger_text_override=trigger_text_override,
        skip_system_prompt=skip_system_prompt,
    )
    payload.runtime.cancel_event = stream_state.cancel_event
    return username, bot_id, bot_msg, payload, adapter


async def _consume_execute(
    ctx: BotRunContext,
    adapter: BotAdapter,
    payload: AgentPayload,
    bot_msg: Message,
) -> tuple[AgentResponse | BaseException, float]:
    """Drain ``adapter.execute`` while republishing Delta events to the
    channel EventBus. Reduces the terminal Final / DispatchedAsync into the
    AgentResponse shape so ``_finalize_response`` stays a single
    branch (existing callers don't see the AsyncIterator)."""
    from app.features.bot_runtime.pipeline.adapter_events import (
        Delta,
        DispatchedAsync,
        Final,
    )
    from app.features.bot_runtime.pipeline.events import MessageStreamDelta
    from app.features.agent_bridge.streams import stream_registry

    t0 = time.perf_counter()
    deltas: list[str] = []
    terminal: Final | DispatchedAsync | None = None
    state = await stream_registry.bind_task(bot_msg.msg_id, asyncio.current_task())

    def _cancel_response() -> AgentResponse:
        content = state.buffer if state is not None else "".join(deltas)
        reason = (
            state.cancel_reason
            if state is not None and state.cancel_reason
            else "user_cancelled"
        )
        return AgentResponse(
            content=content,
            task_id=payload.task_id,
            success=False,
            error_message=reason,
            cancelled=True,
        )

    try:
        if state is not None and state.cancel_requested:
            return _cancel_response(), (time.perf_counter() - t0) * 1000
        async for event in adapter.execute(payload):
            if state is not None and state.cancel_requested:
                return _cancel_response(), (time.perf_counter() - t0) * 1000
            if isinstance(event, Delta):
                deltas.append(event.text)
                if state is not None:
                    async with state.lock:
                        if state.cancel_requested:
                            return _cancel_response(), (time.perf_counter() - t0) * 1000
                        state.buffer += event.text
                await ctx.bus.publish(
                    MessageStreamDelta(msg_id=bot_msg.msg_id, delta=event.text),
                )
            else:
                terminal = event
                break
    except asyncio.CancelledError:
        return _cancel_response(), (time.perf_counter() - t0) * 1000
    except Exception as exc:
        return exc, (time.perf_counter() - t0) * 1000
    finally:
        task = asyncio.current_task()
        if task is not None:
            await stream_registry.unbind_task(bot_msg.msg_id, task)

    dur_ms = (time.perf_counter() - t0) * 1000
    if isinstance(terminal, DispatchedAsync):
        return AgentResponse(
            content="",
            task_id=payload.task_id,
            success=True,
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
    from app.features.bot_runtime.pipeline.bot.stages.dispatch import (
        trigger_sub_bots_from_mentions,
    )

    if isinstance(resp_or_exc, BaseException):
        logger.warning(
            "bot_pipeline: bot %s raised: %s duration_ms=%.0f",
            username,
            resp_or_exc,
            dur_ms,
        )
        await _writer(ctx).finalize(bot_msg, f"处理出错: {resp_or_exc}")
        from app.features.bot_runtime.bot_events.runs import mark_bot_run_status

        await mark_bot_run_status(
            ctx.session,
            placeholder_msg_id=bot_msg.msg_id,
            status="failed",
            last_event_type="adapter.exception",
            error_message=str(resp_or_exc),
        )
        await _writer(ctx).record_task(bot_id, bot_msg.msg_id)
        ctx.bot_messages.append(bot_msg)
        ctx.triggered_bot_ids.add(bot_id)
        return None

    resp = resp_or_exc
    if resp.cancelled:
        logger.info(
            "bot_pipeline: bot %s cancelled duration_ms=%.0f",
            username,
            dur_ms,
        )
        await _writer(ctx).finalize(
            bot_msg,
            resp.content,
            file_ids=resp.file_ids or [],
            is_partial=True,
            error=resp.error_message or "user_cancelled",
        )
        if ctx.session is not None:
            from app.features.bot_runtime.bot_events.runs import mark_bot_run_status

            await mark_bot_run_status(
                ctx.session,
                placeholder_msg_id=bot_msg.msg_id,
                status="cancelled",
                last_event_type="adapter.cancelled",
                error_message=resp.error_message or "user_cancelled",
            )
        await _writer(ctx).record_task(bot_id, bot_msg.msg_id)
        ctx.bot_messages.append(bot_msg)
        ctx.triggered_bot_ids.add(bot_id)
        return None

    if resp.dispatched_async:
        logger.info(
            "bot_pipeline: bot %s async-dispatched via bridge duration_ms=%.0f",
            username,
            dur_ms,
        )
        await _writer(ctx).register_async_pending(bot_msg, ctx.root_task_id, bot_id)
        await _writer(ctx).record_task(bot_id, bot_msg.msg_id)
        ctx.bot_messages.append(bot_msg)
        ctx.triggered_bot_ids.add(bot_id)
        return None

    if not resp.success:
        logger.warning(
            "bot_pipeline: bot %s failed: %s duration_ms=%.0f",
            username,
            resp.error_message or "unknown",
            dur_ms,
        )
    else:
        logger.info(
            "bot_pipeline: bot %s completed duration_ms=%.0f",
            username,
            dur_ms,
        )
    content = resp.content if resp.success else (resp.error_message or "处理出错")
    await _writer(ctx).finalize(bot_msg, content, file_ids=resp.file_ids or [])
    if not resp.success:
        from app.features.bot_runtime.bot_events.runs import mark_bot_run_status

        await mark_bot_run_status(
            ctx.session,
            placeholder_msg_id=bot_msg.msg_id,
            status="failed",
            last_event_type="adapter.final",
            error_message=resp.error_message or "处理出错",
        )
    await _writer(ctx).record_task(bot_id, bot_msg.msg_id)
    ctx.bot_messages.append(bot_msg)
    ctx.triggered_bot_ids.add(bot_id)

    if recurse:
        await trigger_sub_bots_from_mentions(
            ctx,
            bot_msg,
            bot_id,
            ctx.trigger_content,
            depth=depth,
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
        await _writer(ctx).finish_with_error(bot_id, ctx.root_task_id, ctx.attachment_error)
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
        ctx,
        username,
        bot_id,
        bot_msg,
        resp_or_exc,
        dur_ms,
        recurse=recurse,
        depth=depth,
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
            await _writer(ctx).finish_with_error(
                bot_id,
                ctx.root_task_id,
                ctx.attachment_error,
            )
            continue
        prepared = await _prepare(ctx, bot_id, capabilities=capabilities)
        pending.append(prepared)
        logger.info(
            "bot_pipeline: queuing bot bot_id=%s username=%s memory_layers=%d attachments=%d",
            bot_id,
            username,
            len(ctx.memory_context),
            len(ctx.attachments),
        )

    if not pending:
        return

    limit = max(1, int(settings.orchestrator_bot_concurrency_per_message or 1))
    semaphore = asyncio.Semaphore(limit)

    async def _consume_with_limit(adapter: BotAdapter, payload: AgentPayload, bot_msg: Message):
        async with semaphore:
            return await _consume_execute(ctx, adapter, payload, bot_msg)

    timed_results = await asyncio.gather(
        *[_consume_with_limit(adapter, payload, bot_msg) for _, _, bot_msg, payload, adapter in pending],
    )
    for (username, bot_id, bot_msg, _, _), (resp_or_exc, dur_ms) in zip(pending, timed_results):
        await _finalize_response(
            ctx,
            username,
            bot_id,
            bot_msg,
            resp_or_exc,
            dur_ms,
            recurse=recurse,
            depth=0,
        )
