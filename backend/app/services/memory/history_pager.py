"""History Pager: Pagination and compacting of older messages."""
import re

from sqlalchemy import asc, desc, func, select

from app.db.models import HistoryPage, Message
from app.db.session import async_session_factory

PAGE_SIZE = 50
RECENT_MAX_CHARS = 1500

async def _compress_with_system_llm(messages_text: str) -> str | None:
    """调用系统 LLM 将近期消息压缩为 ≤RECENT_MAX_CHARS 的摘要；失败返回 None。"""
    from app.services.admin.settings_store import get_provider_for_scope
    c = get_provider_for_scope("system_llm")
    if not c:
        return None
    base = (c.get("base_url") or "").strip()
    api_key = (c.get("api_key") or "").strip()
    model = (c.get("model") or "gpt-4o-mini").strip()
    if not base:
        return None
    try:
        import httpx
        url = f"{base.rstrip('/')}/chat/completions"
        payload = {
            "model": model,
            "messages": [
                {
                    "role": "system",
                    "content": "将以下频道历史对话压缩为一段简洁的「近期动态」摘要，不超过"
                    f"{RECENT_MAX_CHARS}字，用于 AI 上下文背景。只输出摘要正文，不要标题。",
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
            if content and len(content) > RECENT_MAX_CHARS:
                content = content[:RECENT_MAX_CHARS] + "…"
            return content.strip() or None
    except Exception:
        return None


def _truncate_recent(messages_text: str, max_chars: int = RECENT_MAX_CHARS) -> str:
    """无系统 LLM 时用简单截断作为摘要内容."""
    if not messages_text.strip():
        return ""
    if len(messages_text) <= max_chars:
        return messages_text
    return messages_text[: max_chars - 1] + "…"


async def get_current_page_messages(session, channel_id: str, before_msg_id: str | None = None):
    """查找最新 HistoryPage 的 last_msg_id；取该时间之后、before_msg_id 之前的所有消息."""
    stmt = select(HistoryPage).where(HistoryPage.channel_id == channel_id).order_by(desc(HistoryPage.page_number)).limit(1)
    result = await session.execute(stmt)
    last_page = result.scalar_one_or_none()

    last_sealed_msg_id = last_page.last_msg_id if last_page else None

    q = select(Message).where(Message.channel_id == channel_id, Message.content != "")

    if last_page:
        q = q.where(Message.created_at > last_page.ended_at)

    if before_msg_id:
        sub = select(Message.created_at).where(Message.msg_id == before_msg_id).scalar_subquery()
        q = q.where(Message.created_at < sub)

    q = q.order_by(asc(Message.created_at))
    result = await session.execute(q)
    return list(result.scalars().all()), last_sealed_msg_id


async def get_pages_summary_xml(channel_id: str, session) -> str:
    """查所有 HistoryPage（按 page_number 升序），返回 XML 格式."""
    stmt = select(HistoryPage).where(HistoryPage.channel_id == channel_id).order_by(asc(HistoryPage.page_number))
    result = await session.execute(stmt)
    pages = result.scalars().all()
    if not pages:
        return ""

    lines = []
    for p in pages:
        start_str = p.started_at.strftime("%Y-%m-%dT%H:%M:%SZ") if p.started_at else ""
        end_str = p.ended_at.strftime("%Y-%m-%dT%H:%M:%SZ") if p.ended_at else ""
        lines.append(f'<page id="{p.page_id}" from="{start_str}" to="{end_str}">{p.summary}</page>')
    return "\n".join(lines)


async def get_full_text_for_msg(session, msg_id: str, channel_id: str) -> str | None:
    """若消息在某个 HistoryPage 中，从 raw_content 扫描锚点，返回完整 XML 元素文本."""
    msg_result = await session.execute(select(Message).where(Message.msg_id == msg_id))
    msg = msg_result.scalar_one_or_none()
    if not msg:
        return None

    page_result = await session.execute(
        select(HistoryPage).where(
            HistoryPage.channel_id == channel_id,
            HistoryPage.started_at <= msg.created_at,
            HistoryPage.ended_at >= msg.created_at
        ).limit(1)
    )
    page = page_result.scalar_one_or_none()
    if not page:
        return None

    marker = f"<!-- msg_id:{msg_id} -->"
    raw = page.raw_content
    idx = raw.find(marker)
    if idx == -1:
        return None

    start_idx = raw.find("<history-", idx)
    if start_idx == -1:
        return None

    # 找到对应的 </history-N> 结束标签
    # <history-N ...>
    end_tag_start = raw.find(">", start_idx)
    if end_tag_start == -1:
        return None
    tag_prefix = raw[start_idx:end_tag_start+1]
    m = re.match(r'<history-(\d+)', tag_prefix)
    if not m:
        return None
    tag_num = m.group(1)
    end_tag = f"</history-{tag_num}>"

    end_idx = raw.find(end_tag, end_tag_start)
    if end_idx == -1:
        return None

    return raw[start_idx:end_idx + len(end_tag)]


async def _compact_to_page(channel_id: str, session, msgs_to_compact: list[Message]) -> None:
    """内部：将指定的 msgs_to_compact 列表打成一页 HistoryPage."""
    if not msgs_to_compact:
        return

    stmt = select(func.max(HistoryPage.page_number)).where(HistoryPage.channel_id == channel_id)
    max_pn = await session.scalar(stmt)
    next_pn = (max_pn or 0) + 1

    # 按照正序构建 raw_content
    raw_lines = []
    text_lines = []

    from app.services.adapters.unified_builtin import _get_names_for_messages
    names = await _get_names_for_messages(session, msgs_to_compact)

    for idx, m in enumerate(msgs_to_compact, 1):
        who = "user" if m.sender_type == "user" else "assistant"
        name = names.get(m.sender_id, "Unknown")

        # 摘要用
        ts = m.created_at.strftime("%H:%M") if m.created_at else ""
        text_lines.append(f"[{ts}] {name}: {m.content[:200]}")

        # raw_content
        raw_lines.append(f"<!-- msg_id:{m.msg_id} -->")
        raw_lines.append(f'<history-{idx} sender="{name}" role="{who}">{m.content}</history-{idx}>')

    raw_content = "\n".join(raw_lines)
    raw_text_for_summary = "\n".join(text_lines)

    summary = await _compress_with_system_llm(raw_text_for_summary)
    if not summary:
        summary = _truncate_recent(raw_text_for_summary)

    new_page = HistoryPage(
        channel_id=channel_id,
        page_number=next_pn,
        started_at=msgs_to_compact[0].created_at,
        ended_at=msgs_to_compact[-1].created_at,
        first_msg_id=msgs_to_compact[0].msg_id,
        last_msg_id=msgs_to_compact[-1].msg_id,
        summary=summary,
        raw_content=raw_content,
        message_count=len(msgs_to_compact)
    )

    # 使用 PostgreSQL 支持的 INSERT ON CONFLICT DO NOTHING
    # SQLite 也支持 INSERT OR IGNORE
    # 为了兼容，如果 unique constraint conflict，通过捕获异常处理
    try:
        session.add(new_page)
        await session.commit()
    except Exception:
        await session.rollback()
        # logging.getLogger(__name__).warning("Conflict compacting page: %s", e)
        return

    # RECENT 层现在由 ChannelMemory 从 HistoryPage 实时渲染，无需写入 context_store


async def maybe_compact_channel(channel_id: str) -> bool:
    """统计当前页消息数；若 >= PAGE_SIZE，调用 _compact_to_page；返回 bool."""
    async with async_session_factory() as session:
        msgs, _ = await get_current_page_messages(session, channel_id)
        if len(msgs) >= PAGE_SIZE:
            msgs_to_compact = msgs[:PAGE_SIZE]
            await _compact_to_page(channel_id, session, msgs_to_compact)
            return True
    return False


async def update_recent_pages_layer(channel_id: str, session=None) -> None:
    """No-op：RECENT 层现在由 ChannelMemory 从 HistoryPage 实时渲染。保留接口兼容。"""
    pass
