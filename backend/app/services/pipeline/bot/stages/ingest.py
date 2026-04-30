"""IngestStage: load channel bots, wrap adapter_factory, unwrap secrets, look up names.

Replaces the inline preamble of run_orchestrator (service.py:175-249) with
explicit reads/writes against BotRunContext. Subsequent stages (RouteStage,
ContextLoadStage, …) consume the fields it populates.
"""
from __future__ import annotations

import logging

from sqlalchemy import select
from sqlalchemy.orm import selectinload

from app.db.models import BotAccount, Channel, ChannelMembership, PromptTemplate, User
from app.services.adapters.base import OpenClawAdapter
from app.services.orchestrator.secrets import extract_secret_refs, load_user_secrets
from app.services.pipeline.bot.context import BotRunContext
from app.services.pipeline.stage import Stage
from app.utils.crypto import decrypt_value

_PromptOverrides = dict[str, PromptTemplate]

logger = logging.getLogger("app.services.pipeline.bot.ingest")


def _get_trigger_content(msg) -> str:
    """Return the trigger message's plaintext (decrypts secrets best-effort)."""
    if msg.is_secret and msg.secret_encrypted:
        try:
            return decrypt_value(msg.secret_encrypted)
        except Exception:
            logger.warning(
                "orchestrator: failed to decrypt secret message msg_id=%s", msg.msg_id,
            )
    return msg.content


class IngestStage(Stage[BotRunContext]):
    async def run(self, ctx: BotRunContext) -> None:
        rows, overrides = await self._load_channel_bots(ctx)
        self._wrap_adapter_factory(ctx, overrides)
        self._build_bot_details(ctx, rows)
        await self._unwrap_secret_content(ctx)
        await self._lookup_sender_and_channel(ctx)

    @staticmethod
    async def _load_channel_bots(
        ctx: BotRunContext,
    ) -> tuple[list, _PromptOverrides]:
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
        rows = result.all()
        ctx.channel_bot_usernames = [row[1].username for row in rows]
        ctx.bot_id_by_username = {row[1].username: row[1].bot_id for row in rows}
        overrides = {
            bot.bot_id: membership.prompt_template
            for membership, bot in rows
            if membership.prompt_template
        }
        return rows, overrides

    @staticmethod
    def _wrap_adapter_factory(ctx: BotRunContext, overrides: _PromptOverrides) -> None:
        """Inject channel-level template overrides into adapter resolution."""
        orig = ctx.adapter_factory
        session = ctx.session

        async def wrapped(bot_id: str) -> OpenClawAdapter:
            override = overrides.get(bot_id)
            if override:
                from app.services.orchestrator.adapter_resolver import (
                    get_adapter_for_bot as _get_adapter,
                )
                return await _get_adapter(bot_id, session, template_override=override)
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
    async def _unwrap_secret_content(ctx: BotRunContext) -> None:
        """Expose decrypted trigger text inside the BotPipeline only.

        IngestPipeline has already persisted/broadcast the placeholder, so
        channel members only see the sealed envelope. BotPipeline needs the
        plaintext for both routing (``analysis_content``) and target-adapter
        payloads (``trigger_content``); otherwise RouteStage and DispatchStage
        disagree about what the trigger message actually says.
        """
        msg = ctx.trigger_msg
        ctx.analysis_content = _get_trigger_content(msg)
        is_encrypted = bool(msg.is_secret) and bool(msg.secret_encrypted)
        ctx.trigger_content = ctx.analysis_content

        secret_refs = extract_secret_refs(ctx.analysis_content)
        if secret_refs and msg.sender_type == "user":
            ctx.user_secrets = await load_user_secrets(ctx.session, msg.sender_id, secret_refs)
            logger.info(
                "orchestrator: loaded %d/%d secrets for user %s",
                len(ctx.user_secrets), len(secret_refs), msg.sender_id,
            )

        if is_encrypted and msg.sender_type == "user":
            ctx.user_secrets["_encrypted_msg"] = ctx.analysis_content
            logger.info(
                "orchestrator: encrypted message content injected as _encrypted_msg for user %s",
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
