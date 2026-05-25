"""Messages API routes."""
from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import AsyncGenerator
from datetime import datetime, timezone

from fastapi import APIRouter, BackgroundTasks, Depends, Query, Request
from fastapi.responses import StreamingResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.application.chat.message_assembler import MessageAssembler
from app.contracts.messages import MessageDTO
from app.core.dependencies import get_current_user
from app.core.exceptions import BadRequestError, ForbiddenError, NotFoundError
from app.core.localization import locale_from_headers, with_content_locale
from app.core.responses import APIResponse
from app.core.schemas import (
    ForwardMessageRequest,
    ForwardMessageResponse,
    MessageCreate,
    MessageStreamCreate,
    PermissionApprovalRequest,
    PermissionResolveRequest,
)
from app.db.models import BotAccount, Channel, ChannelMembership, FileRecord, Message, PromptTemplate, User
from app.db.session import async_session_factory, get_session
from app.features.bot_runtime.pipeline.bot.adapter_resolver import get_adapter_for_bot
from app.features.bot_runtime.pipeline.bot.mention import extract_mentions, filter_mentioned_bots
from app.features.bot_runtime.pipeline.bot.queue import enqueue_bot_pipeline_job
from app.features.bot_runtime.pipeline.bot.service import run_bot_pipeline
from app.features.bot_runtime.pipeline.bus import EventBus, WSEventBus, make_event_bus
from app.features.bot_runtime.pipeline.events import BotProcessing, MessageDeleted
from app.features.bot_runtime.pipeline.ingest import IngestContext
from app.features.bot_runtime.pipeline.workflow import resolve_bot_enqueue_decision, run_message_workflow
from app.services.channel_service import ChannelService
from app.services.message_service import MessageService
from app.services.realtime_broker import get_realtime_broker
from app.utils.crypto import decrypt_value
from app.utils.permissions import is_admin

logger = logging.getLogger("app.api.v1.messages")

router = APIRouter(prefix="/channels/{channel_id}/messages", tags=["messages"])

PROMPT_TEMPLATE_OVERRIDE_KEY = "prompt_template_override_id"


def _serialize(msg: Message, file_map: dict) -> dict:
    return MessageAssembler.assemble(msg, file_map).to_wire()


def _wire_payload(payload) -> dict:
    if hasattr(payload, "to_wire"):
        return payload.to_wire()
    if hasattr(payload, "model_dump"):
        return payload.model_dump(mode="json")
    return dict(payload or {})


def _format_sse(event: str, payload) -> str:
    payload = _wire_payload(payload)
    return f"event: {event}\ndata: {json.dumps(payload, ensure_ascii=False)}\n\n"


def _normalize_file_ids(file_ids: list[str] | None, file_id: str | None = None) -> list[str]:
    normalized: list[str] = []
    if file_id and file_id.strip():
        normalized.append(file_id.strip())
    for item in file_ids or []:
        value = (item or "").strip()
        if value and value not in normalized:
            normalized.append(value)
    return normalized


def _schedule_history_update(channel_id: str) -> None:
    from app.features.memory.history_update import schedule_history_update
    schedule_history_update(channel_id)


def _schedule_bot_pipeline_enqueue(
    channel_id: str,
    msg_id: str,
    background_tasks: BackgroundTasks | None = None,
) -> None:
    logger.info(
        "bot_pipeline_enqueue: scheduled channel_id=%s msg_id=%s background_tasks=%s",
        channel_id,
        msg_id,
        background_tasks is not None,
    )
    if background_tasks is not None:
        background_tasks.add_task(_enqueue_bot_pipeline_bg, channel_id, msg_id)
        return
    asyncio.create_task(_enqueue_bot_pipeline_bg(channel_id, msg_id))


async def _enqueue_bot_pipeline_bg(channel_id: str, msg_id: str) -> None:
    try:
        logger.info(
            "bot_pipeline_enqueue: starting channel_id=%s msg_id=%s",
            channel_id,
            msg_id,
        )
        job_id = await enqueue_bot_pipeline_job(channel_id, msg_id)
        logger.info(
            "bot_pipeline_enqueue: enqueued channel_id=%s msg_id=%s job_id=%s",
            channel_id,
            msg_id,
            job_id,
        )
    except Exception as exc:
        logger.exception(
            "bot_pipeline_enqueue: failed channel_id=%s msg_id=%s",
            channel_id, msg_id,
        )
        try:
            await get_realtime_broker().publish_channel(channel_id, {
                "type": "bot_pipeline_error",
                "data": {
                    "channel_id": channel_id,
                    "msg_id": msg_id,
                    "error": f"Bot 处理调度失败: {exc}",
                },
            })
        except Exception:
            logger.debug("bot_pipeline_enqueue: failed to publish error frame", exc_info=True)


async def _channel_bot_rows(session: AsyncSession, channel_id: str) -> list[BotAccount]:
    result = await session.execute(
        select(BotAccount)
        .join(ChannelMembership, ChannelMembership.member_id == BotAccount.bot_id)
        .where(
            ChannelMembership.channel_id == channel_id,
            ChannelMembership.member_type == "bot",
        )
    )
    return list(result.scalars().all())


async def _apply_template_default_bot_target(
    session: AsyncSession,
    *,
    channel_id: str,
    content: str,
    content_data: dict | None,
    mention_bot_ids: list[str],
    current_user: User,
) -> list[str]:
    if mention_bot_ids or not isinstance(content_data, dict):
        return mention_bot_ids
    template_id = content_data.get(PROMPT_TEMPLATE_OVERRIDE_KEY)
    if not isinstance(template_id, str) or not template_id.strip():
        return mention_bot_ids

    channel = await session.get(Channel, channel_id)
    if not channel or channel.type == "dm":
        return mention_bot_ids

    channel_bots = await _channel_bot_rows(session, channel_id)
    channel_bot_usernames = [bot.username for bot in channel_bots]
    text_targets = filter_mentioned_bots(
        extract_mentions(content or "", channel_bot_usernames),
        channel_bot_usernames,
    )
    if text_targets:
        return mention_bot_ids

    template = await session.get(PromptTemplate, template_id.strip())
    if not template:
        return mention_bot_ids

    from app.services.admin_service import PromptTemplateService
    from app.services.bot_service import BotService

    template_svc = PromptTemplateService(session)
    if not await template_svc.can_use(template, current_user):
        return mention_bot_ids
    default_bot_id = getattr(template, "default_bot_id", None)
    if not default_bot_id:
        return mention_bot_ids

    bot = await session.get(BotAccount, default_bot_id)
    if not bot or not await BotService(session).can_use(bot, current_user):
        return mention_bot_ids

    channel_bot_ids = {channel_bot.bot_id for channel_bot in channel_bots}
    if bot.bot_id not in channel_bot_ids:
        label = bot.display_name or bot.username
        raise BadRequestError(f"Add default Bot @{label} to this channel before using this template")
    return [bot.bot_id]


async def _run_bot_pipeline_once(
    channel_id: str,
    trigger_msg: Message,
    session: AsyncSession,
    *,
    event_bus: EventBus,
) -> tuple[list[Message], set[str]]:
    async def broadcast_bot_processing(ch_id: str, bot_id: str, username: str) -> None:
        await event_bus.publish(BotProcessing(bot_id=bot_id, username=username))

    return await run_bot_pipeline(
        channel_id,
        trigger_msg,
        session,
        lambda bid: get_adapter_for_bot(bid, session),
        event_bus=event_bus,
        broadcast_processing=broadcast_bot_processing,
    )


@router.get("", response_model=APIResponse[list[dict]])
async def list_messages(
    channel_id: str,
    limit: int = Query(default=50, ge=1, le=200),
    before_id: str | None = Query(default=None),
    after_id: str | None = Query(default=None),
    around_id: str | None = Query(default=None),
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    await ChannelService(session).require_channel_member(channel_id, current_user)
    svc = MessageService(session)
    if around_id:
        messages, file_map, has_more_before, has_more_after, anchor_found = await svc.list_messages_around(
            channel_id,
            around_id=around_id,
            limit=limit,
        )
        return APIResponse.ok(
            [_serialize(m, file_map) for m in messages],
            meta={
                "has_more": has_more_before,
                "has_more_before": has_more_before,
                "has_more_after": has_more_after,
                "limit": limit,
                "around_id": around_id,
                "anchor_found": anchor_found,
                "position": "around" if anchor_found else "bottom",
            },
        )

    if after_id:
        messages, file_map = await svc.list_messages_after(channel_id, after_id=after_id, limit=limit + 1)
        has_more = len(messages) > limit
        visible_messages = messages[:limit] if has_more else messages
        return APIResponse.ok(
            [_serialize(m, file_map) for m in visible_messages],
            meta={
                "has_more": has_more,
                "has_more_before": True,
                "has_more_after": has_more,
                "limit": limit,
                "after_id": after_id,
                "position": "after",
            },
        )

    messages, file_map = await svc.list_messages(channel_id, limit=limit + 1, before_id=before_id)
    has_more = len(messages) > limit
    visible_messages = messages[-limit:] if has_more else messages
    return APIResponse.ok(
        [_serialize(m, file_map) for m in visible_messages],
        meta={
            "has_more": has_more,
            "has_more_before": has_more,
            "has_more_after": False,
            "limit": limit,
            "position": "before" if before_id else "bottom",
        },
    )


@router.get("/topics/{root_msg_id}", response_model=APIResponse[list[dict]])
async def list_topic_messages(
    channel_id: str,
    root_msg_id: str,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    await ChannelService(session).require_channel_member(channel_id, current_user)
    svc = MessageService(session)
    messages, file_map = await svc.list_topic_messages(channel_id, root_msg_id)
    return APIResponse.ok([_serialize(m, file_map) for m in messages])


async def _handle_send_message(
    session: AsyncSession,
    *,
    channel_id: str,
    body: MessageCreate,
    current_user: User,
    locale: str | None = None,
    background_tasks: BackgroundTasks | None = None,
) -> tuple[MessageDTO, str | None]:
    """Handle send message."""
    await ChannelService(session).require_can_send_message(channel_id, current_user)
    raw_content_data = getattr(body, "content_data", None)
    if hasattr(raw_content_data, "model_dump"):
        raw_content_data = raw_content_data.model_dump(exclude_none=True) or None
    raw_content_data = with_content_locale(raw_content_data, locale)
    mention_bot_ids = await _apply_template_default_bot_target(
        session,
        channel_id=channel_id,
        content=body.content,
        content_data=raw_content_data,
        mention_bot_ids=list(body.mention_bot_ids or []),
        current_user=current_user,
    )

    ctx = IngestContext(
        channel_id=channel_id,
        bus=WSEventBus(channel_id),
        session=session,
        sender_id=current_user.user_id,
        sender_type="user",
        content=body.content,
        file_ids=_normalize_file_ids(body.file_ids),
        mention_bot_ids=mention_bot_ids,
        mention_user_ids=list(body.mention_user_ids or []),
        in_reply_to_msg_id=getattr(body, "in_reply_to_msg_id", None) or None,
        msg_type=getattr(body, "msg_type", None) or None,
        content_data=raw_content_data,
        is_secret=bool(body.is_secret),
    )
    await run_message_workflow(ctx, bot_trigger="enqueue")

    assert ctx.msg is not None and ctx.payload is not None
    await session.commit()
    _schedule_history_update(channel_id)
    try:
        enqueue_decision = await resolve_bot_enqueue_decision(
            session,
            channel_id=channel_id,
            content=body.content,
            mention_bot_ids=mention_bot_ids,
            channel=ctx.channel,
        )
    except Exception:
        logger.warning(
            "bot_pipeline_enqueue: target check failed; falling back to enqueue channel_id=%s msg_id=%s",
            channel_id,
            ctx.msg.msg_id,
            exc_info=True,
        )
        _schedule_bot_pipeline_enqueue(channel_id, ctx.msg.msg_id, background_tasks)
    else:
        if enqueue_decision.should_enqueue:
            logger.info(
                "bot_pipeline_enqueue: target_found channel_id=%s msg_id=%s reason=%s targets=%s",
                channel_id,
                ctx.msg.msg_id,
                enqueue_decision.reason,
                enqueue_decision.target_usernames,
            )
            _schedule_bot_pipeline_enqueue(channel_id, ctx.msg.msg_id, background_tasks)
        else:
            logger.info(
                "bot_pipeline_enqueue: skipped channel_id=%s msg_id=%s reason=%s",
                channel_id,
                ctx.msg.msg_id,
                enqueue_decision.reason,
            )

    return ctx.payload, ctx.secret_token


async def _load_forward_sources(
    session: AsyncSession,
    *,
    body: ForwardMessageRequest,
    current_user: User,
) -> tuple[list[Message], list[FileRecord]]:
    message_ids = list(dict.fromkeys(mid.strip() for mid in body.source_message_ids if mid and mid.strip()))
    file_ids = list(dict.fromkeys(fid.strip() for fid in body.source_file_ids if fid and fid.strip()))
    if not message_ids and not file_ids:
        raise BadRequestError("source_message_ids 和 source_file_ids 不能同时为空")
    if body.mode == "single" and len(message_ids) > 1:
        raise BadRequestError("single 模式只能转发一条消息")
    if body.mode == "topic" and not message_ids:
        raise BadRequestError("topic 模式至少需要一条源消息")

    messages: list[Message] = []
    if message_ids:
        rows = (
            await session.execute(select(Message).where(Message.msg_id.in_(message_ids)))
        ).scalars().all()
        by_id = {msg.msg_id: msg for msg in rows}
        missing = [msg_id for msg_id in message_ids if msg_id not in by_id]
        if missing:
            raise NotFoundError(f"message not found: {missing[0]}")
        messages = [by_id[msg_id] for msg_id in message_ids]
        for msg in messages:
            if msg.is_secret:
                raise BadRequestError("加密消息不能转发")
            await ChannelService(session).require_channel_member(msg.channel_id, current_user)

    files: list[FileRecord] = []
    if file_ids:
        rows = (
            await session.execute(select(FileRecord).where(FileRecord.file_id.in_(file_ids)))
        ).scalars().all()
        by_id = {rec.file_id: rec for rec in rows}
        missing = [file_id for file_id in file_ids if file_id not in by_id]
        if missing:
            raise NotFoundError(f"file not found: {missing[0]}")
        files = [by_id[file_id] for file_id in file_ids]
        from app.services.file_scope_service import FileScopeService

        scope_service = FileScopeService(session)
        for rec in files:
            await scope_service.require_user_access(rec, current_user)

    return messages, files


async def _load_file_records_by_ids(
    session: AsyncSession,
    file_ids: list[str],
) -> list[FileRecord]:
    normalized = list(dict.fromkeys(fid.strip() for fid in file_ids if fid and fid.strip()))
    if not normalized:
        return []
    rows = (
        await session.execute(select(FileRecord).where(FileRecord.file_id.in_(normalized)))
    ).scalars().all()
    by_id = {rec.file_id: rec for rec in rows}
    missing = [file_id for file_id in normalized if file_id not in by_id]
    if missing:
        raise NotFoundError(f"file not found: {missing[0]}")
    return [by_id[file_id] for file_id in normalized]


def _dedupe_file_records(records: list[FileRecord]) -> list[FileRecord]:
    out: list[FileRecord] = []
    seen: set[str] = set()
    for rec in records:
        if rec.file_id in seen:
            continue
        seen.add(rec.file_id)
        out.append(rec)
    return out


async def _link_files_to_channel(
    session: AsyncSession,
    *,
    records: list[FileRecord],
    target_channel_id: str,
    current_user: User,
) -> list[str]:
    from app.services.file_service import FileService

    file_service = FileService(session)
    return await file_service.attach_records_to_channel(
        records=records,
        target_channel_id=target_channel_id,
        current_user=current_user,
        created_by=current_user.user_id,
    )


async def _sender_labels(
    session: AsyncSession,
    messages: list[Message],
) -> dict[tuple[str, str], str]:
    user_ids = [m.sender_id for m in messages if m.sender_type == "user"]
    bot_ids = [m.sender_id for m in messages if m.sender_type == "bot"]
    labels: dict[tuple[str, str], str] = {}
    if user_ids:
        users = (
            await session.execute(select(User).where(User.user_id.in_(set(user_ids))))
        ).scalars().all()
        for user in users:
            labels[("user", user.user_id)] = user.display_name or user.username or "用户"
    if bot_ids:
        bots = (
            await session.execute(select(BotAccount).where(BotAccount.bot_id.in_(set(bot_ids))))
        ).scalars().all()
        for bot in bots:
            labels[("bot", bot.bot_id)] = bot.display_name or bot.username or "Bot"
    return labels


async def _channel_labels(
    session: AsyncSession,
    channel_ids: list[str],
) -> dict[str, str]:
    if not channel_ids:
        return {}
    rows = (
        await session.execute(select(Channel).where(Channel.channel_id.in_(set(channel_ids))))
    ).scalars().all()
    return {row.channel_id: row.name for row in rows}


def _format_forwarded_message(
    msg: Message,
    *,
    sender_label: str,
    channel_label: str,
) -> str:
    created = msg.created_at.isoformat(sep=" ", timespec="minutes") if msg.created_at else ""
    source = f"{channel_label} · {sender_label}"
    if created:
        source = f"{source} · {created}"
    body = (msg.content or "").strip() or "(无文本内容)"
    return f"转发自 {source}\n\n{body}"


async def _create_forward_message(
    session: AsyncSession,
    *,
    channel_id: str,
    current_user: User,
    content: str,
    file_ids: list[str] | None = None,
    msg_type: str = "normal",
    in_reply_to_msg_id: str | None = None,
    content_data: dict | None = None,
) -> MessageDTO:
    ctx = IngestContext(
        channel_id=channel_id,
        bus=WSEventBus(channel_id),
        session=session,
        sender_id=current_user.user_id,
        sender_type="user",
        content=content,
        file_ids=file_ids or [],
        mention_bot_ids=[],
        in_reply_to_msg_id=in_reply_to_msg_id,
        msg_type=msg_type,
        content_data=content_data,
    )
    await run_message_workflow(ctx, bot_trigger="none")
    assert ctx.msg is not None and ctx.payload is not None
    return ctx.payload


@router.post("/forward", response_model=APIResponse[dict])
async def forward_messages(
    channel_id: str,
    body: ForwardMessageRequest,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    """Forward messages."""
    channel_service = ChannelService(session)
    await channel_service.require_can_send_message(channel_id, current_user)
    source_messages, source_files = await _load_forward_sources(
        session,
        body=body,
        current_user=current_user,
    )
    sender_labels = await _sender_labels(session, source_messages)
    channel_labels = await _channel_labels(
        session,
        list(dict.fromkeys(msg.channel_id for msg in source_messages)),
    )
    created: list[dict] = []

    if body.mode == "single":
        if source_messages:
            source = source_messages[0]
            attached_records = await _load_file_records_by_ids(
                session,
                list(source.file_ids or []),
            )
            linked_file_ids = await _link_files_to_channel(
                session,
                records=_dedupe_file_records(attached_records + source_files),
                target_channel_id=channel_id,
                current_user=current_user,
            )
            payload = await _create_forward_message(
                session,
                channel_id=channel_id,
                current_user=current_user,
                content=_format_forwarded_message(
                    source,
                    sender_label=sender_labels.get((source.sender_type, source.sender_id), "未知发送者"),
                    channel_label=channel_labels.get(source.channel_id, "未知会话"),
                ),
                file_ids=linked_file_ids,
            )
        else:
            linked_file_ids = await _link_files_to_channel(
                session,
                records=source_files,
                target_channel_id=channel_id,
                current_user=current_user,
            )
            if len(source_files) == 1:
                filename = source_files[0].original_filename or source_files[0].file_id
                content = f"转发文件：{filename}"
            else:
                content = f"转发文件：{len(source_files)} 个文件"
            payload = await _create_forward_message(
                session,
                channel_id=channel_id,
                current_user=current_user,
                content=content,
                file_ids=linked_file_ids,
            )
        created.append(payload.to_wire())
    else:
        root_files = await _link_files_to_channel(
            session,
            records=source_files,
            target_channel_id=channel_id,
            current_user=current_user,
        )
        title = f"合并转发 {len(source_messages)} 条消息"
        if source_files:
            title = f"{title}及 {len(source_files)} 个文件"
        root_payload = await _create_forward_message(
            session,
            channel_id=channel_id,
            current_user=current_user,
            content=title,
            file_ids=root_files,
            msg_type="topic",
            content_data={
                "kind": "forward_bundle",
                "title": title,
                "source_count": len(source_messages),
                "source_file_count": len(source_files),
            },
        )
        created.append(root_payload.to_wire())
        for source in source_messages:
            attached_records = await _load_file_records_by_ids(
                session,
                list(source.file_ids or []),
            )
            linked_file_ids = await _link_files_to_channel(
                session,
                records=attached_records,
                target_channel_id=channel_id,
                current_user=current_user,
            )
            reply_payload = await _create_forward_message(
                session,
                channel_id=channel_id,
                current_user=current_user,
                content=_format_forwarded_message(
                    source,
                    sender_label=sender_labels.get((source.sender_type, source.sender_id), "未知发送者"),
                    channel_label=channel_labels.get(source.channel_id, "未知会话"),
                ),
                file_ids=linked_file_ids,
                msg_type="reply",
                in_reply_to_msg_id=root_payload.msg_id,
            )
            created.append(reply_payload.to_wire())

    _schedule_history_update(channel_id)
    return APIResponse.ok(ForwardMessageResponse(messages=created).model_dump())


@router.post("", response_model=APIResponse[dict])
async def send_message(
    channel_id: str,
    body: MessageCreate,
    background_tasks: BackgroundTasks,
    request: Request,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    d, secret_token = await _handle_send_message(
        session,
        channel_id=channel_id,
        body=body,
        current_user=current_user,
        locale=locale_from_headers(request.headers),
        background_tasks=background_tasks,
    )
    response_data = d.to_wire()
    if secret_token:
        response_data["secret_token"] = secret_token
    return APIResponse.ok(response_data)


@router.post("/stream")
async def send_message_stream(
    channel_id: str,
    body: MessageStreamCreate,
    request: Request,
    current_user: User = Depends(get_current_user),
) -> StreamingResponse:
    """Send message stream."""
    from app.core.exceptions import AppError, BadRequestError, NotFoundError

    normalized_file_ids = _normalize_file_ids(body.file_ids, body.file_id)

    async def event_generator() -> AsyncGenerator[str, None]:
        queue: asyncio.Queue[tuple[str, dict]] = asyncio.Queue()

        async def emit(event: str, payload) -> None:
            await queue.put((event, _wire_payload(payload)))

        async with async_session_factory() as session:
            bot_pipeline_task = None
            try:
                try:
                    await ChannelService(session).require_can_send_message(channel_id, current_user)
                except NotFoundError as exc:
                    yield _format_sse("error", {"detail": str(exc), "status_code": 404})
                    return
                except AppError as exc:
                    yield _format_sse("error", {"detail": str(exc), "status_code": exc.status_code})
                    return
                ctx = IngestContext(
                    channel_id=channel_id,
                    bus=WSEventBus(channel_id),
                    session=session,
                    sender_id=current_user.user_id,
                    sender_type="user",
                    content=body.content,
                    file_ids=normalized_file_ids,
                    mention_bot_ids=body.mention_bot_ids or [],
                    mention_user_ids=body.mention_user_ids or [],
                    content_data=with_content_locale(None, locale_from_headers(request.headers)),
                )
                try:
                    await run_message_workflow(ctx, bot_trigger="inline")
                except NotFoundError as exc:
                    yield _format_sse("error", {"detail": str(exc), "status_code": 404})
                    return
                except (BadRequestError, AppError) as exc:
                    yield _format_sse("error", {"detail": str(exc), "status_code": 400})
                    return
                assert ctx.msg is not None and ctx.payload is not None
                await session.commit()
                _schedule_history_update(channel_id)
                yield _format_sse("user_message", ctx.payload)

                bus = make_event_bus(channel_id, stream_to_ws=False, stream_event=emit)
                bot_pipeline_task = asyncio.create_task(
                    _run_bot_pipeline_once(channel_id, ctx.msg, session, event_bus=bus)
                )

                while True:
                    if bot_pipeline_task.done() and queue.empty():
                        break
                    try:
                        event, data = await asyncio.wait_for(queue.get(), timeout=0.1)
                    except asyncio.TimeoutError:
                        continue
                    yield _format_sse(event, data)

                bot_messages, _ = await bot_pipeline_task
                await session.commit()
                if bot_messages:
                    _schedule_history_update(channel_id)
                yield _format_sse("complete", {"ok": True})
            except Exception as exc:
                if bot_pipeline_task and not bot_pipeline_task.done():
                    bot_pipeline_task.cancel()
                    try:
                        await bot_pipeline_task
                    except Exception:
                        pass
                await session.rollback()
                logger.exception("stream message failed channel_id=%s", channel_id)
                yield _format_sse("error", {"detail": str(exc) or "stream failed", "status_code": 500})

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no"},
    )


@router.post("/{msg_id}/cancel", response_model=APIResponse[dict])
async def cancel_streaming_message(
    channel_id: str,
    msg_id: str,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    """Cancel an in-progress streaming bot reply.

    Marks the stream as cancelled, finalizes the placeholder message with
    `is_partial=True` (preserving whatever tokens have arrived so far), and
    notifies the plugin via control WS so it can stop generating.

    Idempotent: if the stream is already finalized, returns 200 with the
    current message state and no plugin notification is sent.
    """
    from sqlalchemy import select

    from app.core.exceptions import ForbiddenError, NotFoundError
    from app.db.models import ChannelMembership
    from app.features.agent_bridge.registry import bot_session_registry
    from app.features.agent_bridge.service import cancel_stream as bridge_cancel_stream
    from app.features.agent_bridge.streams import stream_registry

    membership = (
        await session.execute(
            select(ChannelMembership.member_id).where(
                ChannelMembership.channel_id == channel_id,
                ChannelMembership.member_id == current_user.user_id,
                ChannelMembership.member_type == "user",
            )
        )
    ).first()
    if not membership:
        raise ForbiddenError("not a member of this channel")

    msg = await session.get(Message, msg_id)
    if not msg or msg.channel_id != channel_id:
        raise NotFoundError("message not found")

    state = await stream_registry.get(msg_id)
    if state is None:
        # Already finalized or never streamed: idempotent success.
        return APIResponse.ok(_serialize(msg, {}))

    bot_id = state.bot_id
    if state.source == "agent_bridge":
        finalized = await bridge_cancel_stream(
            session, msg_id=msg_id, reason="user_cancelled",
        )
    else:
        await stream_registry.request_cancel(msg_id, reason="user_cancelled")
        finalized = None

    if finalized is not None:
        await session.commit()
        # Tell the plugin to stop generating. Best-effort: if plugin is
        # offline the cancel still succeeds locally.
        await bot_session_registry.dispatch_control(bot_id, {
            "type": "cancel",
            "msg_id": msg_id,
            "reason": "user_cancelled",
        })
        logger.info(
            "cancel_streaming_message: msg_id=%s bot_id=%s by_user=%s",
            msg_id, bot_id, current_user.user_id,
        )
        return APIResponse.ok(_serialize(finalized, {}))
    if state.source != "agent_bridge":
        logger.info(
            "cancel_streaming_message: requested local cancel msg_id=%s bot_id=%s by_user=%s",
            msg_id, bot_id, current_user.user_id,
        )
        await session.refresh(msg)
        return APIResponse.ok(_serialize(msg, {}))
    # Race: registry had it but cancel raced with done. Return current msg.
    await session.refresh(msg)
    return APIResponse.ok(_serialize(msg, {}))


@router.delete("/{msg_id}", response_model=APIResponse[dict])
async def delete_message(
    channel_id: str,
    msg_id: str,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    """Soft-delete a message and broadcast a tombstone update."""
    from app.core.exceptions import ForbiddenError

    channel_service = ChannelService(session)
    await channel_service.require_channel_member(channel_id, current_user)
    msg = (
        await session.execute(
            select(Message)
            .where(Message.channel_id == channel_id, Message.msg_id == msg_id)
            .with_for_update()
        )
    ).scalar_one_or_none()
    if not msg:
        raise NotFoundError("message not found")

    is_sender = msg.sender_type == "user" and msg.sender_id == current_user.user_id
    is_channel_admin = False
    try:
        await channel_service.require_channel_admin(channel_id, current_user)
        is_channel_admin = True
    except ForbiddenError:
        pass
    if msg.sender_type == "system" and not is_admin(current_user):
        raise ForbiddenError("系统消息不能删除")
    if not (is_sender or is_channel_admin or is_admin(current_user)):
        raise ForbiddenError("无权删除该消息")

    if not msg.is_deleted:
        now = datetime.now(timezone.utc)
        msg.is_deleted = True
        msg.deleted_at = now
        msg.deleted_by = current_user.user_id
        msg.content = ""
        msg.file_ids = []
        msg.mention_bot_ids = []
        msg.mention_user_ids = []
        msg.secret_encrypted = None
        msg.secret_token = None
        msg.content_data = {
            "deleted": True,
            "deleted_by": current_user.user_id,
            "deleted_at": now.isoformat(),
        }
        session.add(msg)
        await session.commit()
        await session.refresh(msg)

        payload = MessageAssembler.assemble(msg, {})
        await WSEventBus(channel_id).publish(MessageDeleted(data=payload))
        _schedule_history_update(channel_id)
        return APIResponse.ok(payload.to_wire())

    return APIResponse.ok(_serialize(msg, {}))


def _permission_card_bot_id(msg: Message, content_data: dict) -> str | None:
    bot_id = content_data.get("bot_id")
    if isinstance(bot_id, str) and bot_id.strip():
        return bot_id.strip()
    if msg.sender_type == "bot" and msg.sender_id:
        return msg.sender_id
    return None


async def _load_permission_card_owner(
    session: AsyncSession,
    *,
    msg: Message,
    content_data: dict,
) -> tuple[BotAccount, User]:
    bot_id = _permission_card_bot_id(msg, content_data)
    if not bot_id:
        raise BadRequestError("permission card is missing bot_id")
    bot = await session.get(BotAccount, bot_id)
    if bot is None:
        raise NotFoundError("bot not found")
    if not bot.created_by:
        raise BadRequestError("bot has no owner configured")
    owner = await session.get(User, bot.created_by)
    if owner is None:
        raise NotFoundError("bot owner not found")
    return bot, owner


def _permission_option_id(content_data: dict, resolution: str) -> str | None:
    raw_options = content_data.get("options")
    if not isinstance(raw_options, list):
        return None
    target_prefix = "allow" if resolution == "allow" else "reject"
    for raw in raw_options:
        if not isinstance(raw, dict):
            continue
        kind = str(raw.get("kind") or "")
        option_id = raw.get("option_id") or raw.get("optionId") or raw.get("id")
        if kind.startswith(target_prefix) and isinstance(option_id, str) and option_id:
            return option_id
    return None


def _permission_dispatch_failure(
    content_data: dict,
    *,
    resolution: str,
    current_user_id: str,
    attempted_at: str,
    reason: str,
) -> dict:
    next_data = dict(content_data)
    next_data["resolved"] = False
    next_data["last_resolution_attempt"] = resolution
    next_data["resolution_dispatch_status"] = "undelivered"
    next_data["resolution_dispatch_error"] = reason
    next_data["resolution_dispatch_attempted_by"] = current_user_id
    next_data["resolution_dispatch_attempted_at"] = attempted_at
    return next_data


@router.post("/{msg_id}/resolve", response_model=APIResponse[dict])
async def resolve_permission(
    channel_id: str,
    msg_id: str,
    body: PermissionResolveRequest,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    """Resolve permission."""
    from datetime import datetime, timezone

    from sqlalchemy import select

    from app.core.exceptions import AppError, NotFoundError

    result = await session.execute(
        select(Message)
        .where(Message.channel_id == channel_id, Message.msg_id == msg_id)
        .with_for_update()
    )
    msg = result.scalar_one_or_none()
    if not msg:
        raise NotFoundError("message not found")
    if msg.msg_type != "permission":
        raise AppError("message is not a permission card")

    cd = dict(msg.content_data or {})
    if cd.get("kind") == "agent_bridge_permission_request":
        bot, owner = await _load_permission_card_owner(session, msg=msg, content_data=cd)
        if owner.user_id != current_user.user_id:
            raise ForbiddenError("only the Bot owner can resolve this permission request")

    if cd.get("resolved"):
        # Previously processed requests return the current state directly.
        return APIResponse.ok(_serialize(msg, {}))

    resolved_at = datetime.now(timezone.utc).isoformat()

    if cd.get("kind") == "agent_bridge_permission_request":
        from app.features.agent_bridge.registry import bot_session_registry

        request_id = cd.get("request_id")
        option_id = _permission_option_id(cd, body.resolution)
        if not isinstance(request_id, str) or not request_id:
            cd = _permission_dispatch_failure(
                cd,
                resolution=body.resolution,
                current_user_id=current_user.user_id,
                attempted_at=resolved_at,
                reason="permission request_id is missing",
            )
        else:
            dispatched = await bot_session_registry.dispatch_control(
                bot.bot_id,
                {
                    "type": "permission_resolution",
                    "request_id": request_id,
                    "message_id": msg.msg_id,
                    "resolution": body.resolution,
                    "option_id": option_id,
                    "resolved_by": current_user.user_id,
                    "resolved_at": resolved_at,
                },
            )
            if dispatched:
                cd["resolved"] = True
                cd["resolution"] = body.resolution
                cd["resolved_by"] = current_user.user_id
                cd["resolved_at"] = resolved_at
                cd["resolution_dispatch_status"] = "delivered"
                cd["resolution_dispatched_at"] = resolved_at
                cd["selected_option_id"] = option_id
                cd.pop("resolution_dispatch_error", None)
                cd.pop("last_resolution_attempt", None)
                cd.pop("resolution_dispatch_attempted_by", None)
                cd.pop("resolution_dispatch_attempted_at", None)
            else:
                cd = _permission_dispatch_failure(
                    cd,
                    resolution=body.resolution,
                    current_user_id=current_user.user_id,
                    attempted_at=resolved_at,
                    reason="connector control channel is not connected",
                )
    else:
        cd["resolved"] = True
        cd["resolution"] = body.resolution
        cd["resolved_by"] = current_user.user_id
        cd["resolved_at"] = resolved_at

    msg.content_data = cd
    await session.commit()
    await session.refresh(msg)

    payload = MessageAssembler.assemble(msg, {})
    # Permission resolve is a "modify + re-broadcast" of an existing message;
    # it doesn't fit IngestPipeline (no new row, no envelope, no fanout).
    # Publish the updated row through the same EventBus the rest of the
    # pipeline uses so subscribers see one consistent wire format.
    from app.features.bot_runtime.pipeline.events import MessageCreated
    await WSEventBus(channel_id).publish(MessageCreated(data=payload))
    return APIResponse.ok(payload.to_wire())


@router.post("/{msg_id}/request-approval", response_model=APIResponse[dict])
async def request_permission_approval(
    channel_id: str,
    msg_id: str,
    body: PermissionApprovalRequest | None = None,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    """Post a user-authored request asking the Bot owner to review a permission card."""
    await ChannelService(session).require_can_send_message(channel_id, current_user)
    result = await session.execute(
        select(Message)
        .where(Message.channel_id == channel_id, Message.msg_id == msg_id)
        .with_for_update()
    )
    msg = result.scalar_one_or_none()
    if not msg:
        raise NotFoundError("message not found")
    if msg.msg_type != "permission":
        raise BadRequestError("message is not a permission card")
    cd = dict(msg.content_data or {})
    if cd.get("resolved"):
        raise BadRequestError("permission request is already resolved")
    bot, owner = await _load_permission_card_owner(session, msg=msg, content_data=cd)
    if owner.user_id == current_user.user_id:
        raise BadRequestError("bot owner can approve directly")

    owner_label = f"@{owner.username}" if owner.username else (owner.display_name or "Bot owner")
    bot_label = f"@{bot.username}" if bot.username else (bot.display_name or "Bot")
    title = cd.get("title") if isinstance(cd.get("title"), str) else "ACP permission request"
    note = (body.note or "").strip() if body else ""
    content = f"{owner_label} please review {bot_label}'s permission request: {title}"
    if note:
        content = f"{content}\n\n{note}"

    now = datetime.now(timezone.utc).isoformat()
    cd["approval_requested"] = True
    cd["approval_requested_by"] = current_user.user_id
    cd["approval_requested_at"] = now
    msg.content_data = cd
    request_msg = Message(
        channel_id=channel_id,
        sender_id=current_user.user_id,
        sender_type="user",
        content=content,
        msg_type="normal",
        mention_user_ids=[owner.user_id],
        content_data={
            "kind": "permission_approval_request",
            "permission_msg_id": msg.msg_id,
            "bot_id": bot.bot_id,
            "owner_id": owner.user_id,
        },
    )
    session.add(request_msg)
    await session.flush()
    from app.services.notification_service import NotificationService

    notification_delivery = await NotificationService(session).create_permission_approval_delivery(
        owner,
        permission_msg=msg,
        bot=bot,
        title=title,
    )
    permission_payload = MessageAssembler.assemble(msg, {})
    request_payload = MessageAssembler.assemble(request_msg, {})
    await session.commit()

    bus = WSEventBus(channel_id)
    from app.features.bot_runtime.pipeline.events import MessageCreated
    await bus.publish(MessageCreated(data=permission_payload))
    await bus.publish(MessageCreated(data=request_payload))
    await NotificationService.publish_delivery(notification_delivery)
    _schedule_history_update(channel_id)
    return APIResponse.ok({
        "permission": permission_payload.to_wire(),
        "request": request_payload.to_wire(),
    })


@router.get("/{msg_id}/secret", response_model=APIResponse[dict])
async def reveal_secret_message(
    channel_id: str,
    msg_id: str,
    token: str,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    """Reveal secret message."""
    import hmac as _hmac
    from datetime import datetime as _dt
    from datetime import timedelta, timezone

    from sqlalchemy import select

    result = await session.execute(
        select(Message)
        .where(Message.channel_id == channel_id, Message.msg_id == msg_id)
        .with_for_update()
    )
    msg = result.scalar_one_or_none()
    if not msg:
        from app.core.exceptions import NotFoundError
        raise NotFoundError("message not found")
    if not msg.is_secret:
        from app.core.exceptions import BadRequestError
        raise BadRequestError("not a secret message")
    if not msg.secret_encrypted:
        from app.core.exceptions import BadRequestError
        raise BadRequestError("secret message already revealed or expired")
    if not msg.secret_token or not _hmac.compare_digest(token, msg.secret_token):
        from app.core.exceptions import ForbiddenError
        raise ForbiddenError("invalid token")
    sent_at = msg.created_at
    if sent_at.tzinfo is None:
        sent_at = sent_at.replace(tzinfo=timezone.utc)
    if _dt.now(timezone.utc) - sent_at > timedelta(minutes=1):
        from app.core.exceptions import BadRequestError
        raise BadRequestError("secret message expired")
    try:
        plaintext = decrypt_value(msg.secret_encrypted)
    except Exception:
        from app.core.exceptions import AppError
        raise AppError("decryption failed")
    msg.secret_encrypted = None
    return APIResponse.ok({"content": plaintext})
