"""@mention 解析：从消息文本提取 @BotName，与频道已激活 Bot 匹配."""
from __future__ import annotations

import re
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession


# 匹配 @username 或 @botname（字母、数字、下划线、连字符、单引号、中文等，不含空格）
MENTION_PATTERN = re.compile(r"@([a-zA-Z0-9_\-'\u4e00-\u9fff]+)")


def extract_mentions(text: str) -> list[str]:
    """从消息文本中提取所有 @ 后面的用户名/Bot 名（去重，保持顺序）。"""
    if not text or not text.strip():
        return []
    seen: set[str] = set()
    result: list[str] = []
    for m in MENTION_PATTERN.finditer(text):
        name = m.group(1)
        if name not in seen:
            seen.add(name)
            result.append(name)
    return result


async def resolve_user_mentions(
    content: str,
    session: "AsyncSession",
    channel_id: str,
) -> list[str]:
    """从 bot 回复文本中提取 @username，解析为频道内匹配用户的 user_id 列表。"""
    mentioned = extract_mentions(content)
    if not mentioned:
        return []

    from sqlalchemy import select
    from app.db.models import ChannelMembership, User

    result = await session.execute(
        select(User.user_id)
        .join(ChannelMembership, ChannelMembership.member_id == User.user_id)
        .where(
            ChannelMembership.channel_id == channel_id,
            ChannelMembership.member_type == "user",
            User.username.in_(mentioned),
        )
    )
    return [row[0] for row in result.all()]


def filter_mentioned_bots(
    mentioned_names: list[str],
    channel_bot_usernames: list[str],
    text: str = "",
) -> list[str]:
    """在 @ 提及的名字中，只保留属于本频道已激活 Bot 的用户名。

    对含空格的 Bot 用户名（如 'channel bot'），在原始文本中直接扫描 '@channel bot' 形式。
    """
    channel_set = set(channel_bot_usernames)
    seen: set[str] = set()
    result: list[str] = []

    for name in mentioned_names:
        if name in channel_set and name not in seen:
            result.append(name)
            seen.add(name)

    # 补充：对含空格的 Bot 名，直接在原文中查找 @name
    if text:
        for bot_name in channel_bot_usernames:
            if " " in bot_name and bot_name not in seen and f"@{bot_name}" in text:
                result.append(bot_name)
                seen.add(bot_name)

    return result
