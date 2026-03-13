"""@mention 解析：从消息文本提取 @BotName，与频道已激活 Bot 匹配."""
import re


# 匹配 @username 或 @botname（字母、数字、下划线、连字符、中文等，不含空格）
MENTION_PATTERN = re.compile(r"@([a-zA-Z0-9_\-\u4e00-\u9fff]+)")


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


def filter_mentioned_bots(mentioned_names: list[str], channel_bot_usernames: list[str]) -> list[str]:
    """在 @ 提及的名字中，只保留属于本频道已激活 Bot 的用户名（返回 Bot 的 username 列表）。"""
    channel_set = set(channel_bot_usernames)
    return [name for name in mentioned_names if name in channel_set]
