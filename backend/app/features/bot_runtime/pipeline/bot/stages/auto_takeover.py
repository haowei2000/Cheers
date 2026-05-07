"""AutoTakeoverStage: coordinator direct-answer + auto-takeover phase 2.

Runs only when ``ctx.direct_answer_mode`` and the Coordinator bot is among
the target usernames — i.e. the channel has auto-assist enabled and the
user didn't @-mention anyone, so the workflow builder routed the message
to the Coordinator.

Per-bot dispatch (pre-create, execute, finalize, record_task, recurse) is
shared with DispatchStage / call_bot via ``pipeline.bot.subagent``. This
stage's job is the policy: give the coordinator
``Capabilities.coordinator()`` (full call_bot + msg_type for clarify
rendering), parse the coordinator's reply for ``建议 @bot1, @bot2``
mentions, and dispatch the suggestees with ``Capabilities.leaf()`` so
they can't recursively call_bot further.
"""
from __future__ import annotations

import logging

from app.features.bot_runtime.pipeline.bot.suggestions import extract_suggested_bots
from app.features.bot_runtime.pipeline.bot.capabilities import Capabilities
from app.features.bot_runtime.pipeline.bot.context import BotRunContext
from app.features.bot_runtime.pipeline.bot.subagent import dispatch_many, dispatch_one
from app.features.bot_runtime.pipeline.stage import Stage
from app.services.admin.settings_store import get_assist_settings

logger = logging.getLogger("app.features.bot_runtime.pipeline.bot.auto_takeover")

COORDINATOR_USERNAME = "Coordinator"


class AutoTakeoverStage(Stage[BotRunContext]):
    async def run(self, ctx: BotRunContext) -> None:
        if not (COORDINATOR_USERNAME in ctx.target_usernames and ctx.direct_answer_mode):
            return

        bot_id = ctx.bot_id_by_username[COORDINATOR_USERNAME]
        resp = await dispatch_one(
            ctx,
            bot_id,
            capabilities=Capabilities.coordinator(),
            recurse=True,
        )
        if resp is None:
            # async-dispatched, errored, or attachment-error fallback —
            # no in-band reply to inspect for takeover suggestions.
            return

        if not get_assist_settings().get("auto_takeover"):
            return

        suggested = extract_suggested_bots(resp.content or "")
        valid_suggested = [
            sug for sug in suggested
            if sug in ctx.channel_bot_usernames and sug != COORDINATOR_USERNAME
        ]
        if not valid_suggested:
            return

        if ctx.writer is None:
            raise RuntimeError("BotMessageWriter is not initialized")
        await ctx.writer.emit_routing_card(
            coordinator_bot_id=bot_id,
            coordinator_content=resp.content or "",
            picked_usernames=valid_suggested,
        )
        await dispatch_many(
            ctx,
            valid_suggested,
            capabilities=Capabilities.leaf(),
            recurse=False,
        )
