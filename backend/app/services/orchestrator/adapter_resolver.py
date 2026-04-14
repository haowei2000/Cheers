"""解析 bot_id -> OpenClawAdapter.

路由规则：
- GUIDE_BOT_ID → UnifiedBuiltinBotAdapter（内置三合一：引导/助手/记忆管理）
- GUIDE_HELPER_BOT_ID → HelpBotAdapter（智枢协作操作指引助手：帮助文档问答）
- 其余 bot_id → LLMBotAdapter（Bot = AIModel + PromptTemplate）
"""
import logging

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import BotAccount
from app.services.adapters.base import OpenClawAdapter
from app.services.adapters.help_bot_adapter import HelpBotAdapter
from app.services.adapters.llm_bot import LLMBotAdapter
from app.services.adapters.mock import MockOpenClawAdapter
from app.services.adapters.unified_builtin import UnifiedBuiltinBotAdapter
from app.services.guide.constants import GUIDE_BOT_ID, GUIDE_HELPER_BOT_ID

logger = logging.getLogger("app.services.orchestrator.adapter_resolver")


async def get_adapter_for_bot(bot_id: str, session: AsyncSession) -> OpenClawAdapter:
    """获取 Bot 的适配器。

    内置统一 Bot（GUIDE_BOT_ID）直接返回 UnifiedBuiltinBotAdapter；
    其余 bot 走 LLMBotAdapter（需配置 AIModel + PromptTemplate）。
    """
    # 内置统一 Bot：不依赖 DB 中的 AIModel / PromptTemplate
    if bot_id == GUIDE_BOT_ID:
        logger.info("adapter_resolver: bot_id=%s -> UnifiedBuiltinBotAdapter", bot_id)
        return UnifiedBuiltinBotAdapter()

    # 智枢协作操作指引助手 Bot：加载 docs/ 文档回答使用问题
    if bot_id == GUIDE_HELPER_BOT_ID:
        logger.info("adapter_resolver: bot_id=%s -> HelpBotAdapter", bot_id)
        return HelpBotAdapter()

    result = await session.execute(
        select(BotAccount).where(BotAccount.bot_id == bot_id)
    )
    bot = result.scalar_one_or_none()

    if not bot:
        return MockOpenClawAdapter(reply="[未知 Bot] 已收到消息。")

    if not bot.ai_model:
        logger.warning("adapter_resolver: bot_id=%s has no model configured", bot_id)
        return MockOpenClawAdapter(reply=f"[{bot.display_name or bot.username}] 未配置模型")

    if not bot.prompt_template:
        logger.warning("adapter_resolver: bot_id=%s has no template configured", bot_id)
        return MockOpenClawAdapter(reply=f"[{bot.display_name or bot.username}] 未配置提示词模板")

    if bot.ai_model.is_enabled is False:
        logger.warning("adapter_resolver: bot_id=%s model is disabled", bot_id)
        return MockOpenClawAdapter(reply=f"[{bot.display_name or bot.username}] 模型已禁用")

    # 检查 Bot 状态
    if bot.status != "online":
        logger.warning(
            "adapter_resolver: bot_id=%s username=%s status=%s (not 'online'), returning mock",
            bot_id, bot.username, bot.status,
        )
        return MockOpenClawAdapter(
            reply=f"[{bot.display_name or bot.username}] 当前状态为「{bot.status}」，暂不接受消息"
        )

    logger.info(
        "adapter_resolver: bot_id=%s username=%s -> LLMBotAdapter model=%s template=%s",
        bot_id,
        bot.username,
        bot.ai_model.name,
        bot.prompt_template.name,
    )
    return LLMBotAdapter(bot)
