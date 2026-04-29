"""Coordinator reply parsing — extracts ``建议 @bot`` suggestions for auto-takeover.

Historically this module also held an ``OrchestratorAdapter`` class
(LLM-driven business-answer bot) and its ``_call_llm`` helper. Both
were replaced by ``ChannelBotAdapter`` and the regular pipeline
dispatch flow; only the suggestion-parser regex survives because
``AutoTakeoverStage`` still uses it to decide which sub-bots to fan out
to after the coordinator's reply.
"""
import re

# 匹配 "建议 @xxx" 或 "建议@xxx"
SUGGEST_PATTERN = re.compile(r"建议\s*@([a-zA-Z0-9_一-鿿]+)")


def extract_suggested_bots(content: str) -> list[str]:
    """从 Coordinator 回复中解析「建议 @xxx」的 Bot 名列表。"""
    return list(dict.fromkeys(SUGGEST_PATTERN.findall(content)))
