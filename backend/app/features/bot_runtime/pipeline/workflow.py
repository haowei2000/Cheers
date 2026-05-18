"""Build executable workflows for message writes and Bot dispatch."""
from __future__ import annotations

import logging
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import selectinload

from app.core.prompt_templates import DEFAULT_USER_TEMPLATE
from app.db.models import BotAccount, Channel, ChannelMembership, Message, PromptTemplate, User
from app.features.bot_runtime.adapters.base import BotAdapter
from app.features.bot_runtime.coordinator_profile import build_coordinator_profile
from app.features.bot_runtime.pipeline.bot.adapter_resolver import get_adapter_for_bot
from app.features.bot_runtime.pipeline.bot.context import BotRunContext
from app.features.bot_runtime.pipeline.bot.coordinator_names import first_coordinator_username, is_coordinator_username
from app.features.bot_runtime.pipeline.bot.mention import extract_mentions, filter_mentioned_bots
from app.features.bot_runtime.pipeline.bot.secrets import extract_secret_refs, load_user_secrets
from app.features.bot_runtime.pipeline.bot.stages.auto_takeover import AutoTakeoverStage
from app.features.bot_runtime.pipeline.bot.stages.context_load import (
    ContextLoadStage,
    select_memory_layers,
    should_build_memory,
)
from app.features.bot_runtime.pipeline.bot.stages.dispatch import DispatchStage
from app.features.bot_runtime.pipeline.ingest.context import IngestContext
from app.features.bot_runtime.pipeline.ingest.stages import (
    CommitStage,
    EmitStage,
    FanoutUnreadStage,
    PersistStage,
    SecretEnvelopeStage,
    SerializeStage,
    ValidateStage,
)
from app.features.bot_runtime.pipeline.stage import Stage
from app.utils.crypto import decrypt_value

logger = logging.getLogger("app.features.bot_runtime.pipeline.workflow")

_PromptOverrides = dict[str, PromptTemplate]
PROMPT_TEMPLATE_OVERRIDE_KEY = "prompt_template_override_id"


def _message_prompt_template_override_id(msg: Message) -> str | None:
    data = msg.content_data if isinstance(msg.content_data, dict) else {}
    value = data.get(PROMPT_TEMPLATE_OVERRIDE_KEY)
    if isinstance(value, str) and value.strip():
        return value.strip()
    return None


async def _load_message_prompt_template_override(ctx: BotRunContext) -> PromptTemplate | None:
    template_id = _message_prompt_template_override_id(ctx.trigger_msg)
    if not template_id:
        return None
    template = await ctx.session.get(PromptTemplate, template_id)
    if not template:
        logger.warning(
            "bot_pipeline.workflow: prompt template override missing msg_id=%s template_id=%s",
            ctx.trigger_msg.msg_id,
            template_id,
        )
        return None
    if template.is_builtin or template.created_by is None:
        return template
    sender = await ctx.session.get(User, ctx.trigger_msg.sender_id)
    if sender and sender.user_id == template.created_by:
        return template
    if sender:
        from app.utils.permissions import is_admin

        if is_admin(sender):
            return template
    logger.warning(
        "bot_pipeline.workflow: prompt template override denied msg_id=%s sender=%s template_id=%s",
        ctx.trigger_msg.msg_id,
        ctx.trigger_msg.sender_id,
        template_id,
    )
    return None


@dataclass(frozen=True)
class MessageWorkflowPlan:
    plan_id: str
    message_kind: str
    stages: tuple[Stage[IngestContext], ...]
    bot_trigger: str
    secret_mode: str
    commit: bool
    fanout: bool
    reason: str

    @property
    def stage_names(self) -> list[str]:
        return [stage.__class__.__name__ for stage in self.stages]

    def to_log_dict(self) -> dict[str, Any]:
        return {
            "plan_id": self.plan_id,
            "message_kind": self.message_kind,
            "stages": self.stage_names,
            "bot_trigger": self.bot_trigger,
            "secret_mode": self.secret_mode,
            "commit": self.commit,
            "fanout": self.fanout,
            "reason": self.reason,
        }


def build_message_workflow(ctx: IngestContext, *, bot_trigger: str = "none") -> MessageWorkflowPlan:
    message_kind = ctx.msg_type or ("reply" if ctx.in_reply_to_msg_id else "normal")
    stages: list[Stage[IngestContext]] = [
        ValidateStage(),
        SecretEnvelopeStage(),
        PersistStage(),
        SerializeStage(),
    ]
    if not ctx.skip_commit:
        stages.append(CommitStage())
    stages.append(EmitStage())
    if not ctx.skip_fanout:
        stages.append(FanoutUnreadStage())

    secret_mode = "skip" if ctx.skip_secret else ("sealed" if ctx.is_secret else "plain")
    reason_parts = [message_kind]
    if ctx.file_ids:
        reason_parts.append("files")
    if ctx.mention_bot_ids:
        reason_parts.append("mention_bot_ids")
    if ctx.in_reply_to_msg_id:
        reason_parts.append("reply")

    plan = MessageWorkflowPlan(
        plan_id=str(uuid.uuid4()),
        message_kind=message_kind,
        stages=tuple(stages),
        bot_trigger=bot_trigger,
        secret_mode=secret_mode,
        commit=not ctx.skip_commit,
        fanout=not ctx.skip_fanout,
        reason=",".join(reason_parts),
    )
    ctx.workflow = plan
    return plan


async def run_message_workflow(ctx: IngestContext, *, bot_trigger: str = "none") -> IngestContext:
    from app.features.bot_runtime.pipeline.runner import Pipeline

    plan = build_message_workflow(ctx, bot_trigger=bot_trigger)
    logger.info("message_workflow.built plan=%s", plan.to_log_dict())
    await Pipeline(plan.stages, name="message").run(ctx)
    return ctx


@dataclass(frozen=True)
class BotWorkflowPlan:
    plan_id: str
    route_mode: str
    target_usernames: list[str]
    stages: tuple[Stage[BotRunContext], ...]
    memory_layers: frozenset[str]
    memory_requested: bool
    load_attachments: bool
    load_topic_context: bool
    reason: str

    @property
    def stage_names(self) -> list[str]:
        return [stage.__class__.__name__ for stage in self.stages]

    def to_log_dict(self) -> dict[str, Any]:
        return {
            "plan_id": self.plan_id,
            "route_mode": self.route_mode,
            "target_usernames": list(self.target_usernames),
            "stages": self.stage_names,
            "memory_layers": sorted(self.memory_layers),
            "memory_requested": self.memory_requested,
            "load_attachments": self.load_attachments,
            "load_topic_context": self.load_topic_context,
            "reason": self.reason,
        }


@dataclass(frozen=True)
class BotEnqueueDecision:
    should_enqueue: bool
    target_usernames: list[str]
    reason: str


def _get_trigger_content(msg: Message) -> str:
    """Return the trigger message plaintext, decrypting sealed messages best-effort."""
    if msg.is_secret and msg.secret_encrypted:
        try:
            return decrypt_value(msg.secret_encrypted)
        except Exception:
            logger.warning(
                "bot_pipeline.workflow: failed to decrypt secret message msg_id=%s",
                msg.msg_id,
            )
    return msg.content or ""


def _is_helper_clarify_reply(content: str) -> bool:
    text = (content or "").strip()
    return (
        text.startswith("@Coordinator 澄清回答：")
        or text.startswith("@Helper 澄清回答：")
        or text.startswith("@引导 澄清回答：")
        or text.startswith("@channel bot 澄清回答：")
        or text.startswith("@Coordinator clarification answer:")
        or text.startswith("@Helper clarification answer:")
        or text.startswith("@channel bot clarification answer:")
        or "用户选择跳过澄清" in text
        or "User skipped clarification" in text
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


async def resolve_bot_enqueue_decision(
    session,
    *,
    channel_id: str,
    content: str,
    mention_bot_ids: list[str] | None = None,
    channel: Channel | None = None,
) -> BotEnqueueDecision:
    """Cheaply decide whether a persisted user message can trigger any Bot.

    This mirrors BotWorkflowBuilder routing without loading memory, files, or
    adapters so message sends with no Bot target do not enter the worker queue.
    The full workflow still short-circuits as a second guard.
    """
    if channel is None:
        channel = await session.get(Channel, channel_id)

    result = await session.execute(
        select(ChannelMembership, BotAccount)
        .join(BotAccount, ChannelMembership.member_id == BotAccount.bot_id)
        .where(
            ChannelMembership.channel_id == channel_id,
            ChannelMembership.member_type == "bot",
        )
    )
    rows = [(membership, bot) for membership, bot in result.all()]
    channel_bot_usernames = [row[1].username for row in rows]
    bot_id_by_username = {row[1].username: row[1].bot_id for row in rows}
    username_by_bot_id = {bot_id: username for username, bot_id in bot_id_by_username.items()}

    explicit_targets = _dedupe_usernames(
        [
            username_by_bot_id[bot_id]
            for bot_id in (mention_bot_ids or [])
            if bot_id in username_by_bot_id
        ]
    )
    mentioned = extract_mentions(content or "", channel_bot_usernames)
    text_targets = filter_mentioned_bots(mentioned, channel_bot_usernames)

    targets = _dedupe_usernames(explicit_targets + text_targets)
    if targets:
        if explicit_targets and text_targets:
            return BotEnqueueDecision(True, targets, "explicit_and_text_mentions")
        if explicit_targets:
            return BotEnqueueDecision(True, targets, "explicit_mention_bot_ids")
        return BotEnqueueDecision(True, targets, "text_mentions")

    if channel and channel.type == "dm" and len(channel_bot_usernames) == 1:
        return BotEnqueueDecision(True, [channel_bot_usernames[0]], "dm_counterparty_bot")

    coordinator_username = first_coordinator_username(channel_bot_usernames)
    if not mentioned and channel and channel.auto_assist and coordinator_username:
        return BotEnqueueDecision(True, [coordinator_username], "channel_auto_assist")

    if mentioned:
        return BotEnqueueDecision(False, [], "mentioned_bots_not_in_channel")
    return BotEnqueueDecision(False, [], "no_targets")


class BotWorkflowBuilder:
    async def build(self, ctx: BotRunContext) -> BotWorkflowPlan:
        rows, overrides = await self._load_channel_bots(ctx)
        self._wrap_adapter_factory(ctx, overrides)
        self._build_bot_details(ctx, rows)
        self._build_bot_templates(ctx, rows, overrides)
        await self._unwrap_secret_content(ctx)
        await self._lookup_sender_and_channel(ctx)
        route_mode, reason = await self._route(ctx)
        self._build_coordinator_profile(ctx)

        if not ctx.target_usernames:
            plan = BotWorkflowPlan(
                plan_id=str(uuid.uuid4()),
                route_mode=route_mode,
                target_usernames=[],
                stages=(),
                memory_layers=frozenset(),
                memory_requested=False,
                load_attachments=False,
                load_topic_context=False,
                reason=reason,
            )
            ctx.workflow = plan
            return plan

        only_coordinator = all(is_coordinator_username(username) for username in ctx.target_usernames)
        if ctx.coordinator_profile is not None and only_coordinator:
            layers = ctx.coordinator_profile.memory_layers
            memory_requested = bool(layers)
        else:
            layers = select_memory_layers(ctx.trigger_msg.msg_type)
            memory_requested = should_build_memory(ctx)
        stages: tuple[Stage[BotRunContext], ...]
        if route_mode == "auto_assist":
            stages = (ContextLoadStage(), AutoTakeoverStage())
        else:
            stages = (ContextLoadStage(), DispatchStage())

        plan = BotWorkflowPlan(
            plan_id=str(uuid.uuid4()),
            route_mode=route_mode,
            target_usernames=list(ctx.target_usernames),
            stages=stages,
            memory_layers=layers,
            memory_requested=memory_requested,
            load_attachments=bool(ctx.trigger_msg.file_ids or ctx.original_file_ids),
            load_topic_context=True,
            reason=reason,
        )
        ctx.workflow = plan
        return plan

    @staticmethod
    async def _load_channel_bots(ctx: BotRunContext) -> tuple[list, _PromptOverrides]:
        result = await ctx.session.execute(
            select(ChannelMembership, BotAccount)
            .join(BotAccount, ChannelMembership.member_id == BotAccount.bot_id)
            .where(
                ChannelMembership.channel_id == ctx.channel_id,
                ChannelMembership.member_type == "bot",
            )
            .options(
                selectinload(BotAccount.prompt_template),
                selectinload(ChannelMembership.prompt_template),
            )
        )
        rows = [(membership, bot) for membership, bot in result.all()]
        ctx.channel_bot_usernames = [row[1].username for row in rows]
        ctx.bot_id_by_username = {row[1].username: row[1].bot_id for row in rows}
        message_override = await _load_message_prompt_template_override(ctx)
        if message_override:
            logger.info(
                "bot_pipeline.workflow: forcing prompt template override msg_id=%s template_id=%s",
                ctx.trigger_msg.msg_id,
                message_override.template_id,
            )
            return rows, {bot.bot_id: message_override for _, bot in rows}
        overrides = {
            bot.bot_id: membership.prompt_template
            for membership, bot in rows
            if membership.prompt_template
        }
        return rows, overrides

    @staticmethod
    def _wrap_adapter_factory(ctx: BotRunContext, overrides: _PromptOverrides) -> None:
        orig: Callable[[str], Awaitable[BotAdapter]] = ctx.adapter_factory
        session = ctx.session

        async def wrapped(bot_id: str) -> BotAdapter:
            override = overrides.get(bot_id)
            if override:
                return await get_adapter_for_bot(bot_id, session, template_override=override)
            return await orig(bot_id)

        ctx.adapter_factory = wrapped

    @staticmethod
    def _build_bot_details(ctx: BotRunContext, rows: list) -> None:
        ctx.bot_details_by_username = {
            row[1].username: {
                "display_name": row[1].display_name or row[1].username,
                "description": row[1].description or "",
                "intro": row[1].intro or "",
            }
            for row in rows
        }

    @staticmethod
    def _build_bot_templates(ctx: BotRunContext, rows: list, overrides: _PromptOverrides) -> None:
        ctx.bot_user_templates_by_username = {}
        for membership, bot in rows:
            effective_template = overrides.get(bot.bot_id) or membership.prompt_template or bot.prompt_template
            ctx.bot_user_templates_by_username[bot.username] = (
                effective_template.user_template
                if effective_template
                else DEFAULT_USER_TEMPLATE
            )

    @staticmethod
    def _build_coordinator_profile(ctx: BotRunContext) -> None:
        if not any(is_coordinator_username(username) for username in ctx.target_usernames):
            ctx.coordinator_profile = None
            return
        has_peer_bots = any(
            not is_coordinator_username(username)
            for username in ctx.channel_bot_usernames
        )
        ctx.coordinator_profile = build_coordinator_profile(
            ctx.analysis_content,
            has_attachments=bool(ctx.trigger_msg.file_ids or ctx.original_file_ids),
            has_peer_bots=has_peer_bots,
            is_clarify_reply=_is_helper_clarify_reply(ctx.analysis_content),
        )

    @staticmethod
    async def _unwrap_secret_content(ctx: BotRunContext) -> None:
        msg = ctx.trigger_msg
        ctx.analysis_content = _get_trigger_content(msg)
        is_encrypted = bool(msg.is_secret) and bool(msg.secret_encrypted)
        ctx.trigger_content = ctx.analysis_content

        secret_refs = extract_secret_refs(ctx.analysis_content)
        if secret_refs and msg.sender_type == "user":
            ctx.user_secrets = await load_user_secrets(ctx.session, msg.sender_id, secret_refs)
            logger.info(
                "bot_pipeline.workflow: loaded %d/%d secrets for user %s",
                len(ctx.user_secrets),
                len(secret_refs),
                msg.sender_id,
            )

        if is_encrypted and msg.sender_type == "user":
            ctx.user_secrets["_encrypted_msg"] = ctx.analysis_content
            logger.info(
                "bot_pipeline.workflow: encrypted message injected as _encrypted_msg for user %s",
                msg.sender_id,
            )

    @staticmethod
    async def _lookup_sender_and_channel(ctx: BotRunContext) -> None:
        msg = ctx.trigger_msg
        if msg.sender_type == "user":
            sender = await ctx.session.get(User, msg.sender_id)
            ctx.sender_name = (sender.display_name or sender.username) if sender else ""
        else:
            sender_bot = (
                await ctx.session.execute(
                    select(BotAccount).where(BotAccount.bot_id == msg.sender_id)
                )
            ).scalar_one_or_none()
            ctx.sender_name = (sender_bot.display_name or sender_bot.username) if sender_bot else ""
        ctx.channel = await ctx.session.get(Channel, ctx.channel_id)
        ctx.channel_name = ctx.channel.name if ctx.channel else ""

    async def _route(self, ctx: BotRunContext) -> tuple[str, str]:
        if _is_helper_clarify_reply(ctx.analysis_content):
            ctx.original_question, ctx.original_file_ids = await self._fetch_original_question_for_clarify(ctx)

        explicit_targets = _targets_from_mention_bot_ids(ctx)
        mentioned = extract_mentions(ctx.analysis_content, ctx.channel_bot_usernames)
        text_targets = filter_mentioned_bots(mentioned, ctx.channel_bot_usernames)

        ctx.target_usernames = _dedupe_usernames(explicit_targets + text_targets)
        if ctx.target_usernames:
            if explicit_targets and text_targets:
                return "regular", "explicit_and_text_mentions"
            if explicit_targets:
                return "regular", "explicit_mention_bot_ids"
            return "regular", "text_mentions"

        dm_target = _dm_counterparty_bot_target(ctx)
        if dm_target:
            ctx.target_usernames = [dm_target]
            logger.info(
                "bot_pipeline.workflow: route -> dm bot channel_id=%s bot=%s",
                ctx.channel_id,
                dm_target,
            )
            return "dm", "dm_counterparty_bot"

        channel_auto_assist = bool(ctx.channel.auto_assist) if ctx.channel else False
        coordinator_username = first_coordinator_username(ctx.channel_bot_usernames)
        if (
            not mentioned
            and coordinator_username
            and channel_auto_assist
        ):
            ctx.target_usernames = [coordinator_username]
            ctx.direct_answer_mode = True
            logger.info(
                "bot_pipeline.workflow: route -> coordinator channel_id=%s auto_assist=%s",
                ctx.channel_id,
                channel_auto_assist,
            )
            return "auto_assist", "channel_auto_assist"

        if mentioned:
            logger.warning(
                "bot_pipeline.workflow: no mentioned bots in channel channel_id=%s mentioned=%s channel_bots=%s",
                ctx.channel_id,
                mentioned,
                ctx.channel_bot_usernames,
            )
            return "none", "mentioned_bots_not_in_channel"
        return "none", "no_targets"

    @staticmethod
    async def _fetch_original_question_for_clarify(ctx: BotRunContext) -> tuple[str | None, list[str]]:
        result = await ctx.session.execute(
            select(Message)
            .where(
                Message.channel_id == ctx.channel_id,
                Message.created_at < ctx.trigger_msg.created_at,
            )
            .order_by(Message.created_at.desc())
            .limit(5)
        )
        for message in result.scalars().all():
            if message.sender_type != "bot" or "helper-clarify" not in (message.content or ""):
                continue
            original_id = message.in_reply_to_msg_id
            if not original_id:
                continue
            original = (
                await ctx.session.execute(select(Message).where(Message.msg_id == original_id))
            ).scalar_one_or_none()
            if original and original.sender_type == "user":
                text = (original.content or "").strip()
                file_ids: list[str] = original.file_ids or []
                logger.info(
                    "bot_pipeline.workflow: fetched original_question for clarify len=%s file_ids=%s",
                    len(text),
                    file_ids,
                )
                return text, file_ids
            break
        logger.warning("bot_pipeline.workflow: no original_question found for clarify reply")
        return None, []


async def build_bot_workflow(ctx: BotRunContext) -> BotWorkflowPlan:
    return await BotWorkflowBuilder().build(ctx)
