"""RECENT 层异步更新：对超出直接历史窗口的消息做摘要，不阻塞主消息流。

策略：
  - 最近 DIRECT_HISTORY_COUNT 条消息已直接注入 LLM 上下文，无需摘要。
  - 再往前的 RECENT_WINDOW 条消息（更老的部分）才写入 RECENT 层供 LLM 参考。
  - 若没有超出窗口的消息，RECENT 写入占位提示，告知 LLM 近期消息均在对话历史中。
"""
import asyncio

from sqlalchemy import select

from app.db.models import Message
from app.db.session import async_session_factory
from app.services.memory.context_store import init_context_db, set_layer
from app.services.memory.manager import sync_channel_to_md

# 与 unified_builtin.HISTORY_MSG_COUNT 保持一致：直接注入 LLM 的最近消息条数
DIRECT_HISTORY_COUNT = 30
# RECENT 层额外向前摘要的消息条数
RECENT_WINDOW = 50

RECENT_MAX_CHARS = 1500

_RECENT_IN_HISTORY_NOTE = "（近期 {n} 条消息已在对话历史中直接提供，无需重复摘要）"


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
    """无系统 LLM 时用简单截断作为 RECENT 内容."""
    if not messages_text.strip():
        return ""
    if len(messages_text) <= max_chars:
        return messages_text
    return messages_text[: max_chars - 1] + "…"


async def update_recent_async(channel_id: str) -> None:
    """
    异步更新频道 RECENT 层。

    取最近 DIRECT_HISTORY_COUNT + RECENT_WINDOW 条消息，跳过前 DIRECT_HISTORY_COUNT 条
    （已直接注入 LLM），对更早的 RECENT_WINDOW 条做摘要写入 RECENT 层。
    若超出窗口的消息为空，写入占位提示。
    失败时保留旧 RECENT。
    """
    try:
        async with async_session_factory() as session:
            result = await session.execute(
                select(Message)
                .where(Message.channel_id == channel_id)
                .order_by(Message.created_at.desc())
                .limit(DIRECT_HISTORY_COUNT + RECENT_WINDOW)
            )
            all_msgs = list(result.scalars().all())

        # 前 DIRECT_HISTORY_COUNT 条（desc 顺序）是直接上下文，跳过
        direct_count = min(DIRECT_HISTORY_COUNT, len(all_msgs))
        older_msgs = all_msgs[direct_count:]  # 更旧的消息（仍为 desc 顺序）
        older_msgs.reverse()  # 转为时间正序

        if not older_msgs:
            # 所有消息都在直接历史窗口内
            content = _RECENT_IN_HISTORY_NOTE.format(n=direct_count)
        else:
            lines = []
            for m in older_msgs:
                who = "用户" if m.sender_type == "user" else "Bot"
                ts = m.created_at.strftime("%H:%M") if m.created_at else ""
                lines.append(f"[{ts}] {who}: {m.content[:200]}")
            raw = "\n".join(lines)

            compressed = await _compress_with_system_llm(raw)
            content = compressed if compressed else _truncate_recent(raw)

        await init_context_db()
        await set_layer(channel_id, "RECENT", content)
        await sync_channel_to_md(channel_id)
    except Exception:
        pass


def schedule_recent_update(channel_id: str) -> None:
    """在 Bot 响应后调度 RECENT 更新（后台任务，不等待）。"""
    asyncio.create_task(update_recent_async(channel_id))
