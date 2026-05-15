"""内置 Bot 注册表：bot_id → adapter 工厂。

内置 Bot（@Coordinator、@Helper 等）不走 ``BotAccount.binding_type``
的 http/websocket 分流，而是按固定 ``bot_id`` 直接返回专用 adapter。
这里把所有内置 Bot 聚拢到一张表里，``adapter_resolver`` 只需一次 lookup，
新增内置 Bot 只需在这里加一行。
"""

from __future__ import annotations

from collections.abc import Callable

from app.features.bot_runtime.adapters.base import BotAdapter
from app.features.bot_runtime.adapters.coordinator import ChannelBotAdapter
from app.features.bot_runtime.builtin_ids import HELPER_BOT_ID

# Factories must be zero-argument; built-in bots do not read AIModel/PromptTemplate from the DB at runtime.
BUILTIN_BOT_ADAPTERS: dict[str, Callable[[], BotAdapter]] = {
    # @Helper combines help, collaboration, and memory management; the adapter class keeps its legacy name.
    HELPER_BOT_ID: ChannelBotAdapter,
}


def get_builtin_adapter(bot_id: str) -> BotAdapter | None:
    """若 ``bot_id`` 是内置 Bot，返回其 adapter；否则返回 None。"""
    factory = BUILTIN_BOT_ADAPTERS.get(bot_id)
    return factory() if factory else None
