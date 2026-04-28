"""DispatchStage: regular @mention dispatch + Bot@Bot recursion entrypoints.

The actual per-bot pre-create / execute / finalize lifecycle is shared with
AutoTakeoverStage and call_bot via ``pipeline.bot.subagent``. This stage is
just the entry point that picks the right capabilities and delegates.
"""
from __future__ import annotations

import logging

from app.db.models import Message
from app.services.orchestrator.mention import extract_mentions, filter_mentioned_bots
from app.services.pipeline.bot.capabilities import Capabilities
from app.services.pipeline.bot.context import BotRunContext
from app.services.pipeline.stage import Stage

logger = logging.getLogger("app.services.pipeline.bot.dispatch")

COORDINATOR_USERNAME = "Coordinator"
MAX_BOT_MENTION_DEPTH = 3


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
    # Local import to break the circular dep — subagent.py imports this
    # function for its recurse=True branch.
    from app.services.pipeline.bot.subagent import dispatch_one

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
        await dispatch_one(
            ctx,
            sub_bot_id,
            capabilities=Capabilities.regular(),
            recurse=True,
            depth=depth + 1,
            in_reply_to_msg_id=parent_msg.msg_id,
        )


class DispatchStage(Stage[BotRunContext]):
    async def run(self, ctx: BotRunContext) -> None:
        from app.services.pipeline.bot.subagent import dispatch_many

        # Coordinator's direct-answer path runs in AutoTakeoverStage; skip
        # it here so it isn't dispatched twice.
        regular_targets = [
            u for u in ctx.target_usernames
            if not (u == COORDINATOR_USERNAME and ctx.direct_answer_mode)
        ]
        if not regular_targets:
            return
        await dispatch_many(
            ctx,
            regular_targets,
            capabilities=Capabilities.regular(),
            recurse=True,
        )
