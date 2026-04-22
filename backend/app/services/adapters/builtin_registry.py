"""内置 Bot 注册表：bot_id → adapter 工厂。

内置 Bot（@channel bot、@guide-helper 等）不走 ``BotAccount.binding_type``
的 http/websocket 分流，而是按固定 ``bot_id`` 直接返回专用 adapter。
这里把所有内置 Bot 聚拢到一张表里，``adapter_resolver`` 只需一次 lookup，
新增内置 Bot 只需在这里加一行。
"""
from __future__ import annotations

from collections.abc import Callable

from app.services.adapters.base import OpenClawAdapter
from app.services.adapters.channel_bot import ChannelBotAdapter
from app.services.adapters.help_bot import HelpBotAdapter
from app.services.guide.constants import GUIDE_BOT_ID, GUIDE_HELPER_BOT_ID

# 工厂必须零参：内置 Bot 运行时不读取 DB 中的 AIModel / PromptTemplate。
BUILTIN_BOT_ADAPTERS: dict[str, Callable[[], OpenClawAdapter]] = {
    # @channel bot —— 引导 / 助手 / 记忆管理三合一
    GUIDE_BOT_ID: ChannelBotAdapter,
    # @guide-helper —— 加载 docs/help/ 回答使用问题
    GUIDE_HELPER_BOT_ID: HelpBotAdapter,
}


def get_builtin_adapter(bot_id: str) -> OpenClawAdapter | None:
    """若 ``bot_id`` 是内置 Bot，返回其 adapter；否则返回 None。"""
    factory = BUILTIN_BOT_ADAPTERS.get(bot_id)
    return factory() if factory else None
