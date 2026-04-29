"""RouteStage: classify the trigger message and pick which bots to dispatch.

Responsibilities:

1. If the trigger is a coordinator-clarify reply, fetch the original question
   and its file_ids so DispatchStage / ContextLoadStage can fall back to them.
2. Resolve explicit mention_bot_ids and leading @-mentions against channel
   members.
3. In 1:1 Bot DM channels, route user messages to the counterparty Bot even
   without an @mention.
4. If no valid mention exists but the channel has auto-assist enabled and
   the Coordinator bot is a member, route to the Coordinator in
   ``direct_answer_mode``.
5. Otherwise short-circuit: ``ctx.target_usernames == []`` tells the
   orchestrator there's nothing to dispatch.

Pure logic except for the clarify-reply DB lookup; no side effects on the
event bus, no message writes.
"""
from __future__ import annotations

import logging

from sqlalchemy import select

from app.db.models import Message
from app.services.orchestrator.mention import extract_mentions, filter_mentioned_bots
from app.services.pipeline.bot.context import BotRunContext
from app.services.pipeline.stage import Stage

logger = logging.getLogger("app.services.pipeline.bot.route")

COORDINATOR_USERNAME = "Coordinator"


def _is_guide_clarify_reply(content: str) -> bool:
    """Tell whether the message is the user's reply to a coordinator clarify
    prompt (recognises the historical names @引导 / @channel bot too)."""
    t = (content or "").strip()
    return (
        t.startswith("@Coordinator 澄清回答：")
        or t.startswith("@引导 澄清回答：")
        or t.startswith("@channel bot 澄清回答：")
        or "用户选择跳过澄清" in t
    )


def _dedupe_usernames(usernames: list[str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for username in usernames:
        if username in seen:
            continue
        seen.add(username)
        out.append(username)
    return out


def _targets_from_mention_bot_ids(ctx: BotRunContext) -> list[str]:
    mention_bot_ids = ctx.trigger_msg.mention_bot_ids or []
    if not mention_bot_ids:
        return []
    username_by_bot_id = {
        bot_id: username
        for username, bot_id in ctx.bot_id_by_username.items()
    }
    return _dedupe_usernames(
        [
            username_by_bot_id[bot_id]
            for bot_id in mention_bot_ids
            if bot_id in username_by_bot_id
        ]
    )


def _dm_counterparty_bot_target(ctx: BotRunContext) -> str | None:
    if ctx.trigger_msg.sender_type != "user":
        return None
    if not ctx.channel or ctx.channel.type != "dm":
        return None
    if len(ctx.channel_bot_usernames) != 1:
        return None
    return ctx.channel_bot_usernames[0]


async def _fetch_original_question_for_clarify(
    ctx: BotRunContext,
) -> tuple[str | None, list[str]]:
    """Walk back ≤5 messages to locate the bot's clarify card and the user's
    original question it was attached to. Returns (text, file_ids)."""
    r = await ctx.session.execute(
        select(Message)
        .where(
            Message.channel_id == ctx.channel_id,
            Message.created_at < ctx.trigger_msg.created_at,
        )
        .order_by(Message.created_at.desc())
        .limit(5)
    )
    for m in r.scalars().all():
        if m.sender_type != "bot" or "guide-clarify" not in (m.content or ""):
            continue
        orig_id = m.in_reply_to_msg_id
        if not orig_id:
            continue
        orig = (
            await ctx.session.execute(select(Message).where(Message.msg_id == orig_id))
        ).scalar_one_or_none()
        if orig and orig.sender_type == "user":
            text = (orig.content or "").strip()
            file_ids: list[str] = orig.file_ids or []
            logger.info(
                "orchestrator: fetched original_question for clarify, len=%s file_ids=%s",
                len(text), file_ids,
            )
            return text, file_ids
        break
    logger.warning("orchestrator: no original_question found for clarify reply")
    return None, []


class RouteStage(Stage[BotRunContext]):
    async def run(self, ctx: BotRunContext) -> None:
        if _is_guide_clarify_reply(ctx.analysis_content):
            ctx.original_question, ctx.original_file_ids = (
                await _fetch_original_question_for_clarify(ctx)
            )

        explicit_targets = _targets_from_mention_bot_ids(ctx)
        mentioned = extract_mentions(ctx.analysis_content, ctx.channel_bot_usernames)
        text_targets = filter_mentioned_bots(
            mentioned, ctx.channel_bot_usernames
        )

        ctx.target_usernames = _dedupe_usernames(explicit_targets + text_targets)
        if ctx.target_usernames:
            return

        dm_target = _dm_counterparty_bot_target(ctx)
        if dm_target:
            ctx.target_usernames = [dm_target]
            logger.info(
                "orchestrator route -> dm bot channel_id=%s bot=%s",
                ctx.channel_id, dm_target,
            )
            return

        channel_auto_assist = bool(ctx.channel.auto_assist) if ctx.channel else False
        if (
            not mentioned
            and COORDINATOR_USERNAME in ctx.channel_bot_usernames
            and channel_auto_assist
        ):
            ctx.target_usernames = [COORDINATOR_USERNAME]
            ctx.direct_answer_mode = True
            logger.info(
                "orchestrator route -> coordinator channel_id=%s auto_assist=%s",
                ctx.channel_id, channel_auto_assist,
            )
            return

        if mentioned:
            logger.warning(
                "no mentioned bots in channel: channel_id=%s mentioned=%s channel_bots=%s",
                ctx.channel_id, mentioned, ctx.channel_bot_usernames,
            )
