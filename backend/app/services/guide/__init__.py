"""引导 Bot 相关工具：内置 Bot 常量、帮助文档索引、引导 LLM 客户端。

注意：
- 引导用 adapter 已合并进 ``services/adapters/channel_bot.ChannelBotAdapter``；
  本包不再对外导出 adapter 类。
- 仅保留被其他模块消费的工具：``constants`` / ``help_index`` / ``llm_client``。
"""
from app.services.guide.help_index import find_help

__all__ = ["find_help"]
