"""解析 bot_id -> OpenClawAdapter：按 Bot 的 openclaw_endpoint 选择引导 / WS / HTTP 真实 / Mock 兜底。"""
import logging

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.adapters.base import OpenClawAdapter
from app.adapters.http_openclaw import HttpOpenClawAdapter
from app.adapters.mock import MockOpenClawAdapter
from app.adapters.ws_openclaw import WsOpenClawAdapter
from app.db.models import BotAccount
from app.guide.adapter import GuideBotAdapter
from app.orchestrator.orchestrator_adapter import OrchestratorAdapter

logger = logging.getLogger("app.orchestrator.adapter_resolver")


async def get_adapter_for_bot(bot_id: str, session: AsyncSession) -> OpenClawAdapter:
    """按 bot 的 openclaw_endpoint 返回对应适配器."""
    result = await session.execute(select(BotAccount).where(BotAccount.bot_id == bot_id))
    bot = result.scalar_one_or_none()
    if not bot:
        return MockOpenClawAdapter(reply="[未知 Bot] 已收到消息。")
    ep = (bot.openclaw_endpoint or "").strip().lower()
    if ep.startswith("guide://"):
        return GuideBotAdapter()
    if ep.startswith("coordinator://"):
        return OrchestratorAdapter()
    if ep.startswith("ws://") or ep.startswith("wss://"):
        session_key = (bot.openclaw_session or "").strip()
        if not session_key:
            display = bot.display_name or bot.username
            return MockOpenClawAdapter(reply=f"[{display}] 未配置 openclaw_session，无法发送。")
        logger.info("adapter_resolver: bot_id=%s username=%s -> WsOpenClawAdapter %s session=%s",
                    bot_id, bot.username, bot.openclaw_endpoint, session_key)
        return WsOpenClawAdapter(bot.openclaw_endpoint, session_key, bot.openclaw_token)
    if ep.startswith("http://") or ep.startswith("https://"):
        logger.info("adapter_resolver: bot_id=%s username=%s -> HttpOpenClawAdapter %s", bot_id, bot.username, bot.openclaw_endpoint)
        return HttpOpenClawAdapter(bot.openclaw_endpoint)
    display = bot.display_name or bot.username
    return MockOpenClawAdapter(reply=f"[{display}] 已收到消息。（endpoint 未配置或格式不支持）")
