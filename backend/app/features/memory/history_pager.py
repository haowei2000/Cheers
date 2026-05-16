"""History Pager: backend-only memory pagination and recent rendering.

HistoryPage is intentionally independent from the frontend message list
pagination. The UI keeps using ``before_id + limit`` over ``messages``;
this module seals older channel messages into memory pages when their
rendered text reaches the configured character threshold.
"""
from __future__ import annotations

import asyncio
import logging
import re
from collections.abc import Sequence
from dataclasses import dataclass

from sqlalchemy import and_, asc, desc, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.db.models import BotAccount, HistoryPage, Message, User
from app.db.session import async_session_factory

logger = logging.getLogger("app.features.memory.history_pager")


@dataclass(frozen=True)
class CurrentPage:
    """Unsealed tail page that has not crossed the HistoryPage threshold yet."""

    page_number: int
    messages: list[Message]
    last_sealed_msg_id: str | None


def _history_page_max_chars() -> int:
    return max(1, int(settings.memory_history_page_max_chars or 50000))


def _recent_direct_message_count() -> int:
    return max(0, int(settings.memory_recent_direct_message_count))


def _summary_max_chars() -> int:
    return max(1, int(settings.memory_recent_summary_max_chars or 1500))


async def _compress_with_system_llm(messages_text: str) -> str | None:
    """Compress text with the configured system LLM; return None on failure."""
    from app.services.admin.settings_store import get_provider_for_scope

    c = get_provider_for_scope("system_llm")
    if not c:
        return None
    base = (c.get("base_url") or "").strip()
    api_key = (c.get("api_key") or "").strip()
    model = (c.get("model") or "gpt-4o-mini").strip()
    if not base:
        return None
    max_chars = _summary_max_chars()
    try:
        import httpx

        url = f"{base.rstrip('/')}/chat/completions"
        payload = {
            "model": model,
            "messages": [
                {
                    "role": "system",
                    "content": "将以下频道历史对话压缩为一段简洁的「近期动态」摘要，不超过"
                    f"{max_chars}字，用于 AI 上下文背景。只输出摘要正文，不要标题。",
                },
                {"role": "user", "content": messages_text[:12000]},
            ],
            "max_tokens": 600,
        }
        headers = {"Content-Type": "application/json"}
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"
        async with httpx.AsyncClient(timeout=30.0) as client:
            r = await client.post(url, json=payload, headers=headers)
            r.raise_for_status()
            data = r.json()
            content = (data.get("choices") or [{}])[0].get("message", {}).get("content", "")
            if content and len(content) > max_chars:
                content = content[:max_chars] + "..."
            return content.strip() or None
    except Exception:
        return None


def _truncate_recent(messages_text: str, max_chars: int | None = None) -> str:
    """Simple truncation fallback for page summaries."""
    if not messages_text.strip():
        return ""
    max_chars = max_chars or _summary_max_chars()
    if len(messages_text) <= max_chars:
        return messages_text
    if max_chars <= 3:
        return messages_text[:max_chars]
    return messages_text[: max_chars - 3] + "..."


async def _latest_page(session: AsyncSession, channel_id: str) -> HistoryPage | None:
    result = await session.execute(
        select(HistoryPage)
        .where(HistoryPage.channel_id == channel_id)
        .order_by(desc(HistoryPage.page_number))
        .limit(1)
    )
    return result.scalar_one_or_none()


def _after_page_filter(last_page: HistoryPage):
    """Return a stable cursor predicate for messages after ``last_page``."""
    return or_(
        Message.created_at > last_page.ended_at,
        and_(
            Message.created_at == last_page.ended_at,
            Message.msg_id > last_page.last_msg_id,
        ),
    )


async def _load_current_page(
    session: AsyncSession,
    channel_id: str,
    before_msg_id: str | None = None,
) -> CurrentPage:
    """Load the unsealed current page in chronological order."""
    last_page = await _latest_page(session, channel_id)
    last_sealed_msg_id = last_page.last_msg_id if last_page else None
    page_number = (last_page.page_number if last_page else 0) + 1

    q = select(Message).where(
        Message.channel_id == channel_id,
        Message.content != "",
    )
    if last_page:
        q = q.where(_after_page_filter(last_page))
    if before_msg_id:
        sub = select(Message.created_at).where(Message.msg_id == before_msg_id).scalar_subquery()
        q = q.where(Message.created_at < sub)

    q = q.order_by(asc(Message.created_at), asc(Message.msg_id))
    result = await session.execute(q)
    return CurrentPage(
        page_number=page_number,
        messages=list(result.scalars().all()),
        last_sealed_msg_id=last_sealed_msg_id,
    )


async def get_current_page(
    session: AsyncSession,
    channel_id: str,
    before_msg_id: str | None = None,
) -> CurrentPage:
    """Return the unsealed current page."""
    return await _load_current_page(session, channel_id, before_msg_id)


async def get_pages_summary_xml(channel_id: str, session: AsyncSession) -> str:
    """Return all sealed HistoryPage summaries as structured text."""
    return await render_message_page_summaries(channel_id, session)


async def _resolve_display_names(session: AsyncSession, msgs: Sequence[Message]) -> dict[str, str]:
    user_ids = {m.sender_id for m in msgs if m.sender_type == "user"}
    bot_ids = {m.sender_id for m in msgs if m.sender_type != "user"}
    names: dict[str, str] = {}
    if user_ids:
        rows = await session.execute(
            select(User.user_id, User.display_name, User.username).where(User.user_id.in_(user_ids))
        )
        for user_id, display_name, username in rows:
            names[user_id] = display_name or username or "Unknown"
    if bot_ids:
        rows = await session.execute(
            select(BotAccount.bot_id, BotAccount.display_name, BotAccount.username).where(
                BotAccount.bot_id.in_(bot_ids)
            )
        )
        for bot_id, display_name, username in rows:
            names[bot_id] = display_name or username or "Unknown"
    return names


def _message_role(msg: Message) -> str:
    return "user" if msg.sender_type == "user" else "assistant"


def _render_history_fragment(index: int, msg: Message, sender_name: str) -> str:
    return "\n".join([
        f"<!-- msg_id:{msg.msg_id} -->",
        f'<history-{index} sender="{sender_name}" role="{_message_role(msg)}">{msg.content}</history-{index}>',
    ])


def _render_summary_line(msg: Message, sender_name: str) -> str:
    ts = msg.created_at.strftime("%Y-%m-%d %H:%M") if msg.created_at else ""
    return f"[{ts}] {sender_name}: {(msg.content or '')[:200]}"


async def _create_history_page(
    session: AsyncSession,
    *,
    channel_id: str,
    page_number: int,
    page_msgs: list[Message],
    raw_parts: list[str],
    summary_lines: list[str],
) -> HistoryPage:
    raw_content = "\n".join(raw_parts)
    raw_text_for_summary = "\n".join(summary_lines)
    summary = await _compress_with_system_llm(raw_text_for_summary)
    if not summary:
        summary = _truncate_recent(raw_text_for_summary)

    page = HistoryPage(
        channel_id=channel_id,
        page_number=page_number,
        started_at=page_msgs[0].created_at,
        ended_at=page_msgs[-1].created_at,
        first_msg_id=page_msgs[0].msg_id,
        last_msg_id=page_msgs[-1].msg_id,
        summary=summary,
        raw_content=raw_content,
        message_count=len(page_msgs),
    )
    session.add(page)
    await session.flush()
    return page


async def _compact_channel_history_in_session(
    session: AsyncSession,
    channel_id: str,
) -> int:
    current_page = await _load_current_page(session, channel_id)
    messages = current_page.messages
    if not messages:
        return 0

    names = await _resolve_display_names(session, messages)
    next_page_number = current_page.page_number
    max_chars = _history_page_max_chars()

    created = 0
    page_msgs: list[Message] = []
    raw_parts: list[str] = []
    summary_lines: list[str] = []
    raw_len = 0

    async def flush_current_page() -> None:
        nonlocal created, next_page_number, page_msgs, raw_parts, summary_lines, raw_len
        if not page_msgs:
            return
        await _create_history_page(
            session,
            channel_id=channel_id,
            page_number=next_page_number,
            page_msgs=page_msgs,
            raw_parts=raw_parts,
            summary_lines=summary_lines,
        )
        created += 1
        next_page_number += 1
        page_msgs = []
        raw_parts = []
        summary_lines = []
        raw_len = 0

    for msg in messages:
        sender_name = names.get(msg.sender_id, "Unknown")
        fragment = _render_history_fragment(len(page_msgs) + 1, msg, sender_name)
        separator_len = 1 if raw_parts else 0
        page_msgs.append(msg)
        raw_parts.append(fragment)
        summary_lines.append(_render_summary_line(msg, sender_name))
        raw_len += separator_len + len(fragment)

        if raw_len >= max_chars:
            await flush_current_page()

    # Keep the tail as current_page until it crosses the threshold.
    return created


async def compact_channel_history(
    channel_id: str,
    session: AsyncSession | None = None,
) -> int:
    """Seal unsealed channel messages into length-based HistoryPage rows.

    Returns the number of pages created. When ``session`` is provided, the
    caller owns the transaction. Without a session, this function creates
    and commits its own session for background scheduling.
    """
    if session is not None:
        return await _compact_channel_history_in_session(session, channel_id)

    async with async_session_factory() as own_session:
        created = await _compact_channel_history_in_session(own_session, channel_id)
        await own_session.commit()
        return created


async def maybe_compact_channel(channel_id: str) -> bool:
    """Compatibility wrapper: return True when at least one page was sealed."""
    return (await compact_channel_history(channel_id)) > 0


async def get_full_text_for_msg(session: AsyncSession, msg_id: str, channel_id: str) -> str | None:
    """If a message is sealed in a HistoryPage, return its raw history element."""
    msg_result = await session.execute(select(Message).where(Message.msg_id == msg_id))
    msg = msg_result.scalar_one_or_none()
    if not msg:
        return None

    page_result = await session.execute(
        select(HistoryPage).where(
            HistoryPage.channel_id == channel_id,
            HistoryPage.started_at <= msg.created_at,
            HistoryPage.ended_at >= msg.created_at,
        ).order_by(asc(HistoryPage.page_number))
    )
    marker = f"<!-- msg_id:{msg_id} -->"
    for page in page_result.scalars().all():
        raw = page.raw_content
        idx = raw.find(marker)
        if idx == -1:
            continue

        start_idx = raw.find("<history-", idx)
        if start_idx == -1:
            return None

        end_tag_start = raw.find(">", start_idx)
        if end_tag_start == -1:
            return None
        tag_prefix = raw[start_idx:end_tag_start + 1]
        m = re.match(r"<history-(\d+)", tag_prefix)
        if not m:
            return None
        tag_num = m.group(1)
        end_tag = f"</history-{tag_num}>"

        end_idx = raw.find(end_tag, end_tag_start)
        if end_idx == -1:
            return None

        return raw[start_idx:end_idx + len(end_tag)]
    return None


async def render_message_page_summaries(channel_id: str, session: AsyncSession) -> str:
    """Render sealed HistoryPage summaries for ``message_page:summary``."""
    result = await session.execute(
        select(HistoryPage)
        .where(HistoryPage.channel_id == channel_id)
        .order_by(asc(HistoryPage.page_number))
    )
    pages = result.scalars().all()
    if not pages:
        return ""

    lines: list[str] = []
    for p in pages:
        start_str = p.started_at.strftime("%Y-%m-%dT%H:%M:%SZ") if p.started_at else ""
        end_str = p.ended_at.strftime("%Y-%m-%dT%H:%M:%SZ") if p.ended_at else ""
        lines.append("\n".join([
            f"page_id: {p.page_id}",
            f"page_number: {p.page_number}",
            f"from: {start_str}",
            f"to: {end_str}",
            f"summary: {p.summary}",
        ]))
    return "\n\n".join(lines)


async def render_current_page_summary(channel_id: str, session: AsyncSession) -> str:
    """Render ``current_page:summary`` from the unsealed tail page."""
    current_page = await _load_current_page(session, channel_id)
    messages = current_page.messages
    direct_count = _recent_direct_message_count()
    if direct_count <= 0:
        return ""
    messages = messages[-direct_count:]
    if not messages:
        return ""
    names = await _resolve_display_names(session, messages)
    raw = "\n".join(
        _render_summary_line(m, names.get(m.sender_id, "Unknown"))
        for m in messages
    )
    return _truncate_recent(raw)


async def render_recent_context(channel_id: str, session: AsyncSession) -> str:
    """Render ``memory_context['recent']`` from current_page + message_page."""
    current = await render_current_page_summary(channel_id, session)
    pages = await render_message_page_summaries(channel_id, session)
    sections: list[str] = []
    if current:
        sections.append(f"current_page:\n{current}")
    if pages:
        sections.append(f"history_summary_pages:\n{pages}")
    return "\n\n".join(sections)


async def _scheduled_history_compaction(channel_id: str) -> None:
    try:
        created = await compact_channel_history(channel_id)
        if created:
            logger.info(
                "history_compaction: sealed %d page(s) channel_id=%s",
                created,
                channel_id,
            )
    except Exception as exc:
        logger.warning(
            "history_compaction: failed channel_id=%s error=%s",
            channel_id,
            exc,
        )


def schedule_history_compaction(channel_id: str) -> None:
    """Schedule backend memory compaction without blocking message writes."""
    asyncio.create_task(_scheduled_history_compaction(channel_id))


async def update_recent_pages_layer(channel_id: str, session=None) -> None:
    """Compatibility no-op-ish hook: recent is now rendered at load time."""
    if session is not None:
        await compact_channel_history(channel_id, session)
