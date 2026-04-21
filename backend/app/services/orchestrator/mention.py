"""@mention 解析：仅识别消息【开头】连续的 @BotName / @用户名，匹配频道已激活 Bot."""
from __future__ import annotations

import re
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession


# 匹配 @username 或 @botname（字母、数字、下划线、连字符、单引号、中文等，不含空格）
MENTION_PATTERN = re.compile(r"@([a-zA-Z0-9_\-'一-鿿]+)")
_NAME_CHAR = re.compile(r"[a-zA-Z0-9_\-'一-鿿]")
_WS_CHARS = " \t"


def extract_mentions(text: str, known_space_names: list[str] | None = None) -> list[str]:
    """从消息文本【开头】提取连续的 @mention（去重，保持顺序）。

    语义：
      - 允许前导空白；随后是一个或多个 `@name`（彼此可由空格分隔）。
      - 一旦扫描到非 @mention 的文本即停止，后续文本里的 @ 不再识别。
      - 例： "@a @b 你好"        → ["a", "b"]
             "你好 @a"           → []
             "@a 你好 @b"        → ["a"]
             "@a@b 你好"         → ["a", "b"]

    known_space_names 用于处理含空格的 Bot 名（如 "channel bot"）：
    在每个位置会优先长匹配，确保 "@channel bot ..." 识别为 "channel bot" 而非 "channel"。
    """
    if not text or not text.strip():
        return []

    space_names = sorted(
        [n for n in (known_space_names or []) if " " in n],
        key=len,
        reverse=True,
    )

    seen: set[str] = set()
    result: list[str] = []
    n = len(text)
    pos = 0
    # 跳过前导空白
    while pos < n and text[pos] in _WS_CHARS:
        pos += 1

    while pos < n and text[pos] == "@":
        matched_name: str | None = None

        # 优先匹配含空格的 Bot 名（长名优先）
        for sp in space_names:
            target = f"@{sp}"
            if text.startswith(target, pos):
                end = pos + len(target)
                # 确认右边界：串尾，或后续不再是名字字符
                if end == n or not _NAME_CHAR.match(text[end]):
                    matched_name = sp
                    pos = end
                    break

        if matched_name is None:
            m = MENTION_PATTERN.match(text, pos)
            if not m:
                break
            matched_name = m.group(1)
            pos = m.end()

        if matched_name not in seen:
            seen.add(matched_name)
            result.append(matched_name)

        # 消耗 mention 之后的空白，继续尝试下一个 @
        while pos < n and text[pos] in _WS_CHARS:
            pos += 1

    return result


async def resolve_user_mentions(
    content: str,
    session: "AsyncSession",
    channel_id: str,
) -> list[str]:
    """从 bot 回复文本开头的 @mention 中提取 @username，解析为频道内匹配用户的 user_id 列表。"""
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
) -> list[str]:
    """在已提取的 mention 名字中，只保留属于本频道已激活 Bot 的用户名。

    注：含空格 Bot 名的识别已移到 extract_mentions（通过 known_space_names），
    所以此函数不再需要原文参与扫描，只做集合过滤即可。
    """
    channel_set = set(channel_bot_usernames)
    seen: set[str] = set()
    result: list[str] = []
    for name in mentioned_names:
        if name in channel_set and name not in seen:
            result.append(name)
            seen.add(name)
    return result
