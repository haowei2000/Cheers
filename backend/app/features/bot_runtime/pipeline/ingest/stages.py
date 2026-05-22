"""IngestPipeline stages.

Five stages, run in order:

1. ValidateStage       — channel exists, file ids resolve
2. SecretEnvelopeStage — wrap content with placeholder + token if is_secret
3. PersistStage        — create Message row, ensure topic root, build file_map
4. EmitStage           — serialize, publish MessageCreated to bus
5. FanoutUnreadStage   — push channel_new_message to user-scoped WS for unread badges

Each stage reads/writes IngestContext. None depend on routes.py; the
root workflow builder chooses and runs these stages.
"""
from __future__ import annotations

import asyncio
import logging
import secrets as _sec
from collections.abc import Sequence

from sqlalchemy import select

from app.application.chat.message_assembler import MessageAssembler
from app.config import settings
from app.contracts.messages import MessageFileDTO
from app.core.exceptions import AppError, BadRequestError, NotFoundError
from app.db.models import Channel, ChannelMembership, FileRecord, Message, User
from app.db.session import async_session_factory
from app.features.bot_runtime.pipeline.bot.topic_context import (
    MSG_TYPE_NORMAL,
    MSG_TYPE_REPLY,
    ensure_topic_root,
)
from app.features.bot_runtime.pipeline.events import MessageCreated
from app.features.bot_runtime.pipeline.ingest.context import IngestContext
from app.features.bot_runtime.pipeline.stage import Stage
from app.services.file_processor.service import FileFlowError, FilePipelineService
from app.services.file_retention import active_file_filter
from app.services.secret_messages import SECRET_PLACEHOLDER, secret_placeholder_for
from app.services.storage.base import StorageError
from app.utils.crypto import encrypt_value

logger = logging.getLogger("app.features.bot_runtime.pipeline.ingest")


async def _publish_unread_events(member_ids: Sequence[str], event: dict) -> None:
    """Publish unread notifications with bounded concurrency.

    Large channels should not make message posting wait for one user-scoped
    websocket/Redis publish at a time. Individual publish failures are logged
    and do not stop the rest of the fan-out.
    """
    unique_member_ids = list(dict.fromkeys(member_ids))
    if not unique_member_ids:
        return

    from app.services.realtime_broker import get_realtime_broker

    broker = get_realtime_broker()
    worker_count = min(
        len(unique_member_ids),
        max(1, int(getattr(settings, "unread_fanout_concurrency", 64) or 64)),
    )
    queue: asyncio.Queue[str] = asyncio.Queue()
    for member_id in unique_member_ids:
        queue.put_nowait(member_id)

    async def worker() -> None:
        while True:
            try:
                member_id = queue.get_nowait()
            except asyncio.QueueEmpty:
                return
            try:
                await broker.publish_user(member_id, event)
            except Exception:
                logger.warning(
                    "fanout_unread: failed to publish user notification user_id=%s",
                    member_id,
                    exc_info=True,
                )
            finally:
                queue.task_done()

    await asyncio.gather(*(worker() for _ in range(worker_count)))


class ValidateStage(Stage[IngestContext]):
    async def run(self, ctx: IngestContext) -> None:
        result = await ctx.session.execute(
            select(Channel).where(Channel.channel_id == ctx.channel_id)
        )
        channel = result.scalar_one_or_none()
        if not channel:
            raise NotFoundError("channel not found")
        ctx.channel = channel

        if ctx.file_ids:
            try:
                user = None
                if ctx.sender_type == "user" and ctx.sender_id:
                    user = await ctx.session.get(User, ctx.sender_id)
                await FilePipelineService().validate_message_files(
                    ctx.session, channel_id=ctx.channel_id, file_ids=ctx.file_ids, user=user,
                )
            except FileFlowError as exc:
                raise BadRequestError(exc.detail)
            except StorageError as exc:
                raise AppError(f"storage unavailable: {exc}")


class SecretEnvelopeStage(Stage[IngestContext]):
    """Wrap a secret message: encrypt content, replace with placeholder, mint token.

    Skipped when ``ctx.skip_secret`` (builtin-bot post-back) or
    ``not ctx.is_secret``. The matching unwrap (decrypting on-demand for the
    LLM) lives in the Bot pipeline workflow, not here.
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
        if ctx.channel is not None and ctx.channel.type == "dm":
            keep_dm_topic = (
                ctx.msg_type == "topic"
                and isinstance(ctx.content_data, dict)
                and ctx.content_data.get("kind") == "forward_bundle"
            )
            if ctx.msg_type == "topic" and not keep_dm_topic:
                ctx.msg_type = MSG_TYPE_NORMAL
                ctx.in_reply_to_msg_id = None
                ctx.content_data = None
            if ctx.msg_type == "announcement":
                ctx.msg_type = MSG_TYPE_NORMAL
                ctx.in_reply_to_msg_id = None
                ctx.content_data = None
            if ctx.msg_type == MSG_TYPE_REPLY and not ctx.in_reply_to_msg_id:
                ctx.msg_type = MSG_TYPE_NORMAL
        msg_type = ctx.msg_type or (
            MSG_TYPE_REPLY if ctx.in_reply_to_msg_id else MSG_TYPE_NORMAL
        )
        linked_files_before_persist = False
        if ctx.file_ids and ctx.sender_type == "user" and ctx.sender_id:
            user = await ctx.session.get(User, ctx.sender_id)
            if user is not None:
                from app.services.file_service import FileService

                ctx.file_ids = await FileService(ctx.session).attach_file_ids_to_channel(
                    file_ids=ctx.file_ids,
                    target_channel_id=ctx.channel_id,
                    current_user=user,
                    created_by=ctx.sender_id,
                )
                linked_files_before_persist = True
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
        needs_ref_flush = False
        if ctx.is_secret:
            msg.content = secret_placeholder_for(msg.msg_id)
            ctx.stored_content = msg.content
            needs_ref_flush = True

        # The after_insert listener already promoted the parent row in DB;
        # do an explicit in-memory promote on the loaded instance (if any)
        # so any later code in this request sees the updated msg_type
        # without a refresh.
        if ctx.in_reply_to_msg_id:
            await ensure_topic_root(ctx.session, ctx.in_reply_to_msg_id)
            needs_ref_flush = True
        if needs_ref_flush:
            await ctx.session.flush()

        ctx.msg = msg

        if ctx.file_ids and not linked_files_before_persist:
            from app.services.file_scope_service import FileScopeService

            await FileScopeService(ctx.session).link_files_to_channel(
                file_ids=ctx.file_ids,
                channel_id=ctx.channel_id,
                created_by=ctx.sender_id if ctx.sender_type == "user" else None,
            )

        # Pre-load FileRecord rows for the response payload so EmitStage
        # doesn't need to re-query.
        fids = sorted({fid for fid in (msg.file_ids or []) if fid})
        if fids:
            fres = await ctx.session.execute(
                select(FileRecord).where(FileRecord.file_id.in_(fids), active_file_filter())
            )
            for rec in fres.scalars().all():
                ctx.file_map[rec.file_id] = MessageFileDTO(
                    file_id=rec.file_id,
                    original_filename=rec.original_filename,
                    content_type=rec.content_type,
                    size_bytes=rec.size_bytes,
                    status=rec.status,
                    expires_at=rec.expires_at,
                )


class SerializeStage(Stage[IngestContext]):
    """Capture the response payload before commit so msg attributes can't
    be expired by SQLAlchemy's expire_on_commit semantics. Intermediate
    stage only; not exported."""

    async def run(self, ctx: IngestContext) -> None:
        if ctx.msg is None:
            raise RuntimeError("SerializeStage: PersistStage must run first")
        ctx.payload = MessageAssembler.assemble(ctx.msg, ctx.file_map)


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
        sender_id = ctx.payload.sender_id if ctx.payload else None
        sender_type = ctx.payload.sender_type if ctx.payload else None
        msg_id = ctx.payload.msg_id if ctx.payload else None

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
        member_ids = [
            row[0]
            for row in rows
            if not (sender_type == "user" and row[0] == sender_id)
        ]
        if member_ids:
            try:
                async with async_session_factory() as session:
                    from app.services.unread_count_service import increment_unread_counts

                    await increment_unread_counts(
                        session,
                        channel_id=ctx.channel_id,
                        user_ids=member_ids,
                    )
                    await session.commit()
            except Exception:
                logger.warning(
                    "fanout_unread: failed to update unread cache channel_id=%s",
                    ctx.channel_id,
                    exc_info=True,
                )
        await _publish_unread_events(member_ids, event)
