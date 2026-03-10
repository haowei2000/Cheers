"""解析 bot_id -> OpenClawAdapter：按 Bot 的 openclaw_endpoint 选择引导 / HTTP 真实 / Mock 兜底。
架构弹性：仅 guide://、http(s):// 为真实能力；mock:// 或其它值为占位兜底（演示或未配置），生产 Bot 应配置 http(s)。"""
import logging

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.adapters.base import OpenClawAdapter

logger = logging.getLogger("app.orchestrator.adapter_resolver")
from app.adapters.http_openclaw import HttpOpenClawAdapter
from app.adapters.mock import MockOpenClawAdapter
from app.db.models import BotAccount
from app.guide.adapter import GuideBotAdapter
from app.orchestrator.orchestrator_adapter import OrchestratorAdapter


async def get_adapter_for_bot(bot_id: str, session: AsyncSession) -> OpenClawAdapter:
    """按 bot 的 openclaw_endpoint 返回对应适配器：guide:// -> 引导；coordinator:// -> Orchestrator；http(s):// -> 真实 HTTP；否则 Mock。"""
    result = await session.execute(select(BotAccount).where(BotAccount.bot_id == bot_id))
    bot = result.scalar_one_or_none()
    if not bot:
        return MockOpenClawAdapter(reply="[未知 Bot] 已收到消息。")
    ep = (bot.openclaw_endpoint or "").strip()
    if ep.lower().startswith("guide://"):
        return GuideBotAdapter()
    if ep.lower().startswith("coordinator://"):
        return OrchestratorAdapter()
    if ep.lower().startswith("http://") or ep.lower().startswith("https://"):
        logger.info("adapter_resolver: bot_id=%s username=%s -> HttpOpenClawAdapter %s", bot_id, bot.username, ep)
        return HttpOpenClawAdapter(ep)
    display = bot.display_name or bot.username
    return MockOpenClawAdapter(reply=f"[{display}] 已收到消息。（请将 openclaw_endpoint 设为 http 地址以真实调用）")
