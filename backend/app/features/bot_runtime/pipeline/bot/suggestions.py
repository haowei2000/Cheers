"""Coordinator reply parsing — extracts ``建议 @bot`` suggestions for auto-takeover.

Only the suggestion-parser regex lives here; ``AutoTakeoverStage`` uses
it to decide which sub-bots to fan out to after the coordinator's reply.
"""
import re

# Match "suggest @xxx" patterns, including the legacy Chinese variants.
SUGGEST_PATTERN = re.compile(r"建议\s*@([a-zA-Z0-9_一-鿿]+)")


def extract_suggested_bots(content: str) -> list[str]:
    """从 Coordinator 回复中解析「建议 @xxx」的 Bot 名列表。"""
    return list(dict.fromkeys(SUGGEST_PATTERN.findall(content)))
