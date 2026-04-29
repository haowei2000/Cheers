"""IngestPipeline stages.

Five stages, run in order:

1. ValidateStage       — channel exists, file ids resolve
2. SecretEnvelopeStage — wrap content with placeholder + token if is_secret
3. PersistStage        — create Message row, ensure topic root, build file_map
4. EmitStage           — serialize, publish MessageCreated to bus
5. FanoutUnreadStage   — push channel_new_message to user-scoped WS for unread badges

Each stage reads/writes IngestContext. None depend on routes.py — call
sites build the context, then invoke ``make_ingest_pipeline().run(ctx)``.
"""
from __future__ import annotations

import logging
import secrets as _sec

from sqlalchemy import select

from app.core.exceptions import AppError, BadRequestError, NotFoundError
from app.core.schemas import MessageFileInResponse, MessageInResponse
from app.db.models import Channel, ChannelMembership, FileRecord, Message
from app.db.session import async_session_factory
from app.services.file_processor.service import FileFlowError, FilePipelineService
from app.services.orchestrator.topic_context import (
    MSG_TYPE_NORMAL,
    MSG_TYPE_REPLY,
    ensure_topic_root,
)
from app.services.pipeline.events import MessageCreated
from app.services.pipeline.ingest.context import IngestContext
from app.services.pipeline.runner import Pipeline
from app.services.pipeline.stage import Stage
from app.services.storage.base import StorageError
from app.services.ws_service import ws_manager
from app.utils.crypto import encrypt_value

logger = logging.getLogger("app.services.pipeline.ingest")

SECRET_PLACEHOLDER = "🔒 [加密消息]"


class ValidateStage(Stage[IngestContext]):
    async def run(self, ctx: IngestContext) -> None:
        result = await ctx.session.execute(
            select(Channel).where(Channel.channel_id == ctx.channel_id)
        )
        if not result.scalar_one_or_none():
            raise NotFoundError("channel not found")

        if ctx.file_ids:
            try:
                await FilePipelineService().validate_message_files(
                    ctx.session, channel_id=ctx.channel_id, file_ids=ctx.file_ids,
                )
            except FileFlowError as exc:
                raise BadRequestError(exc.detail)
            except StorageError as exc:
                raise AppError(f"storage unavailable: {exc}")


class SecretEnvelopeStage(Stage[IngestContext]):
    """Wrap a secret message: encrypt content, replace with placeholder, mint token.

    Skipped when ``ctx.skip_secret`` (builtin-bot post-back) or
    ``not ctx.is_secret``. The matching unwrap (decrypting on-demand for the
    LLM) lives in BotPipeline, not here — see ``services.orchestrator.service``.
    """

    async def run(self, ctx: IngestContext) -> None:
        if ctx.skip_secret or not ctx.is_secret:
            ctx.stored_content = ctx.content
            ctx.secret_encrypted = None
            ctx.secret_token = None
            return
        ctx.secret_encrypted = encrypt_value(ctx.content)
        ctx.stored_content = SECRET_PLACEHOLDER
        ctx.secret_token = _sec.token_urlsafe(32)


class PersistStage(Stage[IngestContext]):
    async def run(self, ctx: IngestContext) -> None:
        msg_type = ctx.msg_type or (
            MSG_TYPE_REPLY if ctx.in_reply_to_msg_id else MSG_TYPE_NORMAL
        )
        msg = Message(
            channel_id=ctx.channel_id,
            sender_id=ctx.sender_id,
            sender_type=ctx.sender_type,
            content=ctx.stored_content if ctx.stored_content is not None else ctx.content,
            file_ids=ctx.file_ids,
            mention_bot_ids=ctx.mention_bot_ids,
            in_reply_to_msg_id=ctx.in_reply_to_msg_id,
            msg_type=msg_type,
            content_data=ctx.content_data,
            is_secret=ctx.is_secret,
            secret_encrypted=ctx.secret_encrypted,
            secret_token=ctx.secret_token,
        )
        ctx.session.add(msg)
        await ctx.session.flush()

        # The after_insert listener already promoted the parent row in DB;
        # do an explicit in-memory promote on the loaded instance (if any)
        # so any later code in this request sees the updated msg_type
        # without a refresh.
        if ctx.in_reply_to_msg_id:
            await ensure_topic_root(ctx.session, ctx.in_reply_to_msg_id)
            await ctx.session.flush()

        ctx.msg = msg

        # Pre-load FileRecord rows for the response payload so EmitStage
        # doesn't need to re-query.
        fids = sorted({fid for fid in (msg.file_ids or []) if fid})
        if fids:
            fres = await ctx.session.execute(
                select(FileRecord).where(FileRecord.file_id.in_(fids))
            )
            for rec in fres.scalars().all():
                ctx.file_map[rec.file_id] = MessageFileInResponse(
                    file_id=rec.file_id,
                    original_filename=rec.original_filename,
                    content_type=rec.content_type,
                    size_bytes=rec.size_bytes,
                    status=rec.status,
                )


class _SerializeStage(Stage[IngestContext]):
    """Capture the response payload before commit so msg attributes can't
    be expired by SQLAlchemy's expire_on_commit semantics. Intermediate
    stage only; not exported."""

    async def run(self, ctx: IngestContext) -> None:
        if ctx.msg is None:
            raise RuntimeError("SerializeStage: PersistStage must run first")
        payload = MessageInResponse.model_validate(ctx.msg).model_dump()
        if ctx.msg.created_at:
            payload["created_at"] = ctx.msg.created_at.isoformat()
        if ctx.msg.file_ids:
            payload["files"] = [
                ctx.file_map[fid].model_dump()
                for fid in ctx.msg.file_ids
                if fid in ctx.file_map
            ]
        else:
            payload["files"] = []
        ctx.payload = payload


class CommitStage(Stage[IngestContext]):
    """Commit the request transaction so EmitStage broadcasts a durable row.

    Mirrors the legacy ``_handle_send_message`` order (commit-then-broadcast).
    Skipped when ``ctx.skip_commit`` — used by tests or callers that want to
    drive the transaction lifecycle themselves.
    """

    async def run(self, ctx: IngestContext) -> None:
        if ctx.skip_commit:
            return
        await ctx.session.commit()


class EmitStage(Stage[IngestContext]):
    async def run(self, ctx: IngestContext) -> None:
        if ctx.payload is None:
            raise RuntimeError("EmitStage: SerializeStage must run before EmitStage")
        await ctx.bus.publish(MessageCreated(data=ctx.payload))


class FanoutUnreadStage(Stage[IngestContext]):
    """Push channel_new_message to user-scoped WS for non-sender members.

    Uses a fresh DB session (via ``async_session_factory``) so the request's
    transaction can commit independently of this fan-out. Errors are
    swallowed and logged so the channel broadcast in EmitStage is never
    invalidated by an unread fan-out failure.
    """

    async def run(self, ctx: IngestContext) -> None:
        if ctx.skip_fanout or ctx.payload is None:
            return
        try:
            await self._fanout(ctx)
        except Exception:
            logger.exception(
                "fanout_unread: failed to dispatch channel_new_message channel_id=%s",
                ctx.channel_id,
            )

    @staticmethod
    async def _fanout(ctx: IngestContext) -> None:
        sender_id = ctx.payload.get("sender_id") if ctx.payload else None
        sender_type = ctx.payload.get("sender_type") if ctx.payload else None
        msg_id = ctx.payload.get("msg_id") if ctx.payload else None

        async with async_session_factory() as session:
            rows = (
                await session.execute(
                    select(ChannelMembership.member_id).where(
                        ChannelMembership.channel_id == ctx.channel_id,
                        ChannelMembership.member_type == "user",
                    )
                )
            ).all()

        event = {
            "type": "channel_new_message",
            "data": {
                "channel_id": ctx.channel_id,
                "sender_id": sender_id,
                "sender_type": sender_type,
                "msg_id": msg_id,
            },
        }
        for row in rows:
            member_id = row[0]
            if sender_type == "user" and member_id == sender_id:
                continue
            await ws_manager.broadcast_to_user(member_id, event)


def make_ingest_pipeline() -> Pipeline[IngestContext]:
    return Pipeline(
        [
            ValidateStage(),
            SecretEnvelopeStage(),
            PersistStage(),
            _SerializeStage(),
            CommitStage(),
            EmitStage(),
            FanoutUnreadStage(),
        ]
    )
