"""RECENT 层异步更新：Bot 响应后压缩近期消息（系统 LLM 或简单截断），不阻塞主消息流。"""
import asyncio
import os
from pathlib import Path

from sqlalchemy import select
from app.config import settings
from app.db.models import Message
from app.db.session import async_session_factory
from app.memory.context_store import init_context_db, set_layer
from app.memory.manager import sync_channel_to_md


def _context_db_path() -> str:
    p = settings.sqlite_context_path
    if not os.path.isabs(p):
        base = Path(__file__).resolve().parent.parent.parent.parent
        p = str(base / p)
    return p

RECENT_MAX_CHARS = 1500
LAST_N_MESSAGES = 50


async def _compress_with_system_llm(messages_text: str) -> str | None:
    """调用系统 LLM 将近期消息压缩为 ≤RECENT_MAX_CHARS 的摘要；失败返回 None。"""
    from app.admin.settings_store import get_provider_for_scope
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
                    "content": "将以下频道近期对话压缩为一段简洁的「近期动态」摘要，不超过"
                    f"{RECENT_MAX_CHARS}字，用于 AI 上下文。只输出摘要正文，不要标题。",
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
    """无系统 LLM 时用简单截断作为 RECENT 内容."""
    if not messages_text.strip():
        return ""
    if len(messages_text) <= max_chars:
        return messages_text
    return messages_text[: max_chars - 1] + "…"


async def update_recent_async(channel_id: str) -> None:
    """
    异步更新频道 RECENT 层：取最近 LAST_N_MESSAGES 条消息，系统 LLM 压缩或截断后写入。
    不阻塞主消息流；失败时保留旧 RECENT。
    """
    try:
        async with async_session_factory() as session:
            result = await session.execute(
                select(Message)
                .where(Message.channel_id == channel_id)
                .order_by(Message.created_at.desc())
                .limit(LAST_N_MESSAGES)
            )
            messages = list(result.scalars().all())
        messages.reverse()
        lines = []
        for m in messages:
            who = "用户" if m.sender_type == "user" else "Bot"
            ts = m.created_at.strftime("%H:%M") if m.created_at else ""
            lines.append(f"[{ts}] {who}: {m.content[:200]}")
        raw = "\n".join(lines)

        content: str
        compressed = await _compress_with_system_llm(raw)
        if compressed:
            content = compressed
        else:
            content = _truncate_recent(raw)

        db_path = _context_db_path()
        await init_context_db(db_path)
        await set_layer(db_path, channel_id, "RECENT", content)
        await sync_channel_to_md(channel_id)
    except Exception:
        pass


def schedule_recent_update(channel_id: str) -> None:
    """在 Bot 响应后调度 RECENT 更新（后台任务，不等待）。"""
    asyncio.create_task(update_recent_async(channel_id))
