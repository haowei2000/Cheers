"""解析 bot_id -> OpenClawAdapter.

路由规则：
- 内置 Bot（见 ``builtin_registry.BUILTIN_BOT_ADAPTERS``）→ 专用 adapter
- 其余 bot：按 BotAccount.binding_type 分流
    · 'http'      → HttpBotAdapter（OpenAI 兼容 HTTP，Bot = AIModel + PromptTemplate）
    · 'websocket' → WebsocketBotAdapter（经 OpenClaw channel plugin 异步回推）
"""
import logging

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import BotAccount, PromptTemplate
from app.services.adapters.base import OpenClawAdapter
from app.services.adapters.builtin_registry import get_builtin_adapter
from app.services.adapters.http_bot import HttpBotAdapter
from app.services.adapters.mock_bot import MockBotAdapter
from app.services.adapters.websocket_bot import WebsocketBotAdapter

logger = logging.getLogger("app.services.orchestrator.adapter_resolver")


async def get_adapter_for_bot(
    bot_id: str,
    session: AsyncSession,
    *,
    template_override: PromptTemplate | None = None,
) -> OpenClawAdapter:
    """获取 Bot 的适配器。

    内置 Bot 命中 ``builtin_registry`` 直接返回专用 adapter；
    其余 bot 按 ``BotAccount.binding_type`` 分流到 HttpBot / WebsocketBot。

    Args:
        template_override: 频道级提示词模板覆盖，优先于 BotAccount 上的默认模板。
    """
    # 内置 Bot：不依赖 DB 中的 AIModel / PromptTemplate
    builtin = get_builtin_adapter(bot_id)
    if builtin is not None:
        logger.info("adapter_resolver: bot_id=%s -> %s (builtin)", bot_id, type(builtin).__name__)
        return builtin

    result = await session.execute(
        select(BotAccount).where(BotAccount.bot_id == bot_id)
    )
    bot = result.scalar_one_or_none()

    if not bot:
        return MockBotAdapter(reply="[未知 Bot] 已收到消息。")

    # WebSocket Bot：经 OpenClaw channel plugin 异步回推；同样使用 PromptTemplate 渲染入站消息
    binding_type = (getattr(bot, "binding_type", None) or "http").lower()
    if binding_type == "websocket":
        if bot.status != "online":
            logger.warning(
                "adapter_resolver: bot_id=%s username=%s status=%s (not 'online'), returning mock",
                bot_id, bot.username, bot.status,
            )
            return MockBotAdapter(
                reply=f"[{bot.display_name or bot.username}] 当前状态为「{bot.status}」，暂不接受消息"
            )
        logger.info(
            "adapter_resolver: bot_id=%s username=%s -> WebsocketBotAdapter",
            bot_id, bot.username,
        )
        return WebsocketBotAdapter(bot, template_override=template_override or bot.prompt_template)

    if not bot.ai_model:
        logger.warning("adapter_resolver: bot_id=%s has no model configured", bot_id)
        return MockBotAdapter(reply=f"[{bot.display_name or bot.username}] 未配置模型")

    effective_template = template_override or bot.prompt_template
    if not effective_template:
        logger.warning("adapter_resolver: bot_id=%s has no template configured", bot_id)
        return MockBotAdapter(reply=f"[{bot.display_name or bot.username}] 未配置提示词模板")

    if bot.ai_model.is_enabled is False:
        logger.warning("adapter_resolver: bot_id=%s model is disabled", bot_id)
        return MockBotAdapter(reply=f"[{bot.display_name or bot.username}] 模型已禁用")

    # 检查 Bot 状态
    if bot.status != "online":
        logger.warning(
            "adapter_resolver: bot_id=%s username=%s status=%s (not 'online'), returning mock",
            bot_id, bot.username, bot.status,
        )
        return MockBotAdapter(
            reply=f"[{bot.display_name or bot.username}] 当前状态为「{bot.status}」，暂不接受消息"
        )

    logger.info(
        "adapter_resolver: bot_id=%s username=%s -> HttpBotAdapter model=%s template=%s (override=%s)",
        bot_id,
        bot.username,
        bot.ai_model.name,
        effective_template.name,
        template_override is not None,
    )
    return HttpBotAdapter(bot, template_override=template_override)
