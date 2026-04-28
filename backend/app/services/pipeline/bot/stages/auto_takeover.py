"""AutoTakeoverStage: coordinator direct-answer + auto-takeover phase 2.

Runs only when ``ctx.direct_answer_mode`` and the Coordinator bot is among
the target usernames — i.e. the channel has auto-assist enabled and the
user didn't @-mention anyone, so the orchestrator routed the message to
the Coordinator.

Per-bot dispatch (pre-create, execute, finalize, record_task, recurse) is
shared with DispatchStage / call_bot via ``pipeline.bot.subagent``. This
stage's job is the policy: which capabilities to give the coordinator
(``Capabilities.coordinator()`` — full call_bot + streaming hooks),
parsing the coordinator's reply for ``建议 @bot1, @bot2`` mentions, and
dispatching the suggestees with ``Capabilities.leaf()`` so they can't
recursively call_bot further.
"""
from __future__ import annotations

import logging

from app.services.admin.settings_store import get_assist_settings
from app.services.orchestrator.orchestrator_adapter import extract_suggested_bots
from app.services.pipeline.bot.capabilities import Capabilities
from app.services.pipeline.bot.context import BotRunContext
from app.services.pipeline.bot.subagent import dispatch_many, dispatch_one
from app.services.pipeline.stage import Stage

logger = logging.getLogger("app.services.pipeline.bot.auto_takeover")

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
