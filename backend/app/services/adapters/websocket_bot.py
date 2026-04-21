"""WebsocketBotAdapter：异步 WS Bot 适配器（接入 OpenClaw channel plugin）.

Slack / Discord 风格的异步流程：
  1. 用户 @mention 本 Bot 时，Orchestrator 调用 execute()；
  2. execute() 把 payload 发布给 bridge_dispatcher，所有在线 plugin 收到事件；
     返回 AgentResponse(content="", success=True, dispatched_async=True)。
  3. Orchestrator 看到 dispatched_async=True 后，**不 finalize 占位消息**，
     只把 (task_id, bot_id, msg_id) 记到 pending_replies，并调度超时兜底任务。
  4. 远端 OpenClaw agent 产出回复后，plugin 回调
     POST /api/v1/openclaw/bridge/messages（body 里带 task_id / reply_to_msg_id 任一），
     bridge 路由 finalize 占位消息 → 广播到频道。
  5. 若超时仍没收到回推，由 orchestrator 调度的 timeout handler 把占位消息
     finalize 为超时提示。

如果当前没有任何 plugin 订阅 bridge，execute() 直接返回 success=False，
orchestrator 仍走原有路径把错误信息写成占位消息的最终内容。
"""
from __future__ import annotations

import logging

from app.db.models import BotAccount
from app.services.adapters.base import AgentPayload, AgentResponse, OpenClawAdapter

logger = logging.getLogger("app.services.adapters.websocket_bot")


class WebsocketBotAdapter(OpenClawAdapter):
    """WebSocket Bot：通过 OpenClaw channel plugin 桥接，异步回推回复."""

    def __init__(self, bot: BotAccount) -> None:
        self.bot = bot
        self.binding_config: dict = dict(bot.binding_config or {})

    async def execute(self, payload: AgentPayload) -> AgentResponse:
        # 延迟导入以避免在 import adapter 时就拉起 bridge 依赖
        from app.services.openclaw_bridge.dispatcher import bridge_dispatcher

        event = {
            "type": "dispatch",
            "bot_id": self.bot.bot_id,
            "bot_username": self.bot.username,
            "bot_display_name": self.bot.display_name,
            "channel_id": payload.channel_id,
            "task_id": payload.task_id,
            "trigger_message": payload.trigger_message,
            "memory_context": payload.memory_context,
            "attachments": payload.attachments,
            "binding_config": self.binding_config,
        }
        delivered = await bridge_dispatcher.publish(event)
        logger.info(
            "websocket_bot: dispatch bot_id=%s task_id=%s delivered_to=%d plugin(s)",
            self.bot.bot_id, payload.task_id, delivered,
        )

        if delivered == 0:
            return AgentResponse(
                content=f"[{self.bot.display_name or self.bot.username}] 没有在线的 OpenClaw channel plugin",
                task_id=payload.task_id,
                success=False,
                error_message="no_plugin_subscribers",
            )

        return AgentResponse(
            content="",
            task_id=payload.task_id,
            success=True,
            dispatched_async=True,
        )

    async def health_check(self) -> bool:
        from app.services.openclaw_bridge.dispatcher import bridge_dispatcher

        return bridge_dispatcher.subscriber_count() > 0
