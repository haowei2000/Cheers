"""Auto takeover module."""
from __future__ import annotations

import logging

from app.features.bot_runtime.pipeline.bot.capabilities import Capabilities
from app.features.bot_runtime.pipeline.bot.context import BotRunContext
from app.features.bot_runtime.pipeline.bot.coordinator_names import (
    first_coordinator_username,
    is_coordinator_username,
)
from app.features.bot_runtime.pipeline.bot.subagent import dispatch_many, dispatch_one
from app.features.bot_runtime.pipeline.bot.suggestions import extract_suggested_bots
from app.features.bot_runtime.pipeline.stage import Stage
from app.services.admin.settings_store import get_assist_settings

logger = logging.getLogger("app.features.bot_runtime.pipeline.bot.auto_takeover")

class AutoTakeoverStage(Stage[BotRunContext]):
    async def run(self, ctx: BotRunContext) -> None:
        coordinator_username = first_coordinator_username(ctx.target_usernames)
        if not (coordinator_username and ctx.direct_answer_mode):
            return

        bot_id = ctx.bot_id_by_username[coordinator_username]
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
            if sug in ctx.channel_bot_usernames and not is_coordinator_username(sug)
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
