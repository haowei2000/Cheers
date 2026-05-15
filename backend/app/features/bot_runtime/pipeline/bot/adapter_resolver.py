"""解析 bot_id -> BotAdapter.

路由规则：
- 内置 Bot（见 ``builtin_registry.BUILTIN_BOT_ADAPTERS``）→ 专用 adapter
- 其余 bot：按 BotAccount.binding_type 分流
    · 'http'      → HttpBotAdapter（OpenAI 兼容 HTTP，Bot = AIModel + PromptTemplate）
    · 'agent_bridge' → AgentBridgeBotAdapter（经外部 provider 异步回推）
"""
import logging

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import BotAccount, PromptTemplate
from app.features.bot_runtime.adapters.agent_bridge_bot import AgentBridgeBotAdapter
from app.features.bot_runtime.adapters.base import BotAdapter
from app.features.bot_runtime.adapters.builtin_registry import get_builtin_adapter
from app.features.bot_runtime.adapters.http_bot import HttpBotAdapter
from app.features.bot_runtime.adapters.mock_bot import MockBotAdapter

logger = logging.getLogger("app.features.bot_runtime.pipeline.bot.adapter_resolver")


async def get_adapter_for_bot(
    bot_id: str,
    session: AsyncSession,
    *,
    template_override: PromptTemplate | None = None,
) -> BotAdapter:
    """获取 Bot 的适配器。

    内置 Bot 命中 ``builtin_registry`` 直接返回专用 adapter；
    其余 bot 按 ``BotAccount.binding_type`` 分流到 HttpBot / AgentBridgeBot。

    Args:
        template_override: 频道级提示词模板覆盖，优先于 BotAccount 上的默认模板。
    """
    # Built-in bots do not depend on AIModel/PromptTemplate rows in the DB.
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

    # Agent Bridge bots callback asynchronously through external providers and still use PromptTemplate rendering.
    binding_type = (getattr(bot, "binding_type", None) or "http").lower()
    if binding_type == "agent_bridge":
        if bot.status != "online":
            logger.warning(
                "adapter_resolver: bot_id=%s username=%s status=%s (not 'online'), returning mock",
                bot_id, bot.username, bot.status,
            )
            return MockBotAdapter(
                reply=f"[{bot.display_name or bot.username}] 当前状态为「{bot.status}」，暂不接受消息"
            )
        logger.info(
            "adapter_resolver: bot_id=%s username=%s -> AgentBridgeBotAdapter",
            bot_id, bot.username,
        )
        return AgentBridgeBotAdapter(bot, template_override=template_override or bot.prompt_template)

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

    # Check bot status.
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
