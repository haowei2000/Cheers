"""WebsocketBotAdapter：异步 WS Bot 适配器（接入 OpenClaw channel plugin）.

设计要点（异步 / Slack 风格）：
  - 用户 @ 本 Bot 时，Orchestrator 调用 execute()，本 adapter **不等待** Bot 回复完成；
  - execute() 立即返回一个 "已派发，等待异步回推" 的占位 AgentResponse（不落盘成最终消息），
    真正的 Bot 回复由外部 OpenClaw channel plugin 通过 bridge 路由
    (POST /api/openclaw/bridge/messages) 反向推入频道，作为一条新消息单独到达；
  - 这样避免 Orchestrator 同步等待远端 agent，兼容 Slack/Discord 式的 UX。

此提交是 adapter 骨架：仅定义类型 + 返回占位 response。
具体「向 plugin 投递 payload」的实现（WS broadcast / queue）在后续提交中接入。
"""
from __future__ import annotations

import logging

from app.db.models import BotAccount
from app.services.adapters.base import AgentPayload, AgentResponse, OpenClawAdapter

logger = logging.getLogger("app.services.adapters.websocket_bot")


# 占位文本：当下 Orchestrator 会把 execute() 的返回当成一条 Bot 消息写入频道。
# 在 bridge 接入之前，先让 WS Bot 发出一条可见的占位，便于端到端 smoke test；
# bridge 接入后，execute() 会改为不写占位消息、只把 payload 派发给 plugin，
# 最终 Bot 回复以单独新消息形式由 plugin 异步回推。
_PLACEHOLDER_REPLY = "[WebSocket Bot] 请求已派发，等待 OpenClaw channel plugin 异步回推回复。"


class WebsocketBotAdapter(OpenClawAdapter):
    """WebSocket Bot：通过 OpenClaw channel plugin 桥接，异步回推回复."""

    def __init__(self, bot: BotAccount) -> None:
        self.bot = bot
        self.binding_config: dict = dict(bot.binding_config or {})

    async def execute(self, payload: AgentPayload) -> AgentResponse:
        logger.info(
            "websocket_bot: dispatch bot_id=%s username=%s task_id=%s (async via bridge, not yet wired)",
            self.bot.bot_id, self.bot.username, payload.task_id,
        )
        # TODO(openclaw-bridge): 在 bridge 接入后，这里要把 payload 投递给订阅的 plugin，
        # 并把 execute() 改为不写占位消息（或写一个短暂的 "thinking..." 状态消息，
        # 由 plugin 推回后替换），然后返回一个 "已派发，无同步内容" 的 AgentResponse。
        return AgentResponse(
            content=_PLACEHOLDER_REPLY,
            task_id=payload.task_id,
            success=True,
        )

    async def health_check(self) -> bool:
        return True
