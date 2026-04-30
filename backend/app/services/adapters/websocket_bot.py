"""WebsocketBotAdapter：异步 WS Bot 适配器（接入 OpenClaw channel plugin）.

Slack / Discord 风格的异步流程（Phase C：per-bot data WS）：
  1. 用户 @mention 本 Bot 时，Orchestrator 创建占位 bot 消息后调 execute()；
  2. execute() 向 bot_session_registry 查找目标 bot 的 data WS，推送 message 帧；
     - 若找到：返回 AgentResponse(content="", dispatched_async=True)
     - 若未连：返回 success=False，orchestrator 按原 finalize 路径写兜底文案
  3. Orchestrator 看到 dispatched_async=True 后，把占位消息登记到 pending_replies，
     调度超时兜底；
  4. 远端 OpenClaw agent 产出回复后，plugin 通过 data WS 的 reply 帧回推；
     bridge 的 /ws/openclaw/data 路由从 pending_replies 里 finalize 占位消息。
"""
from __future__ import annotations

import logging
from collections.abc import AsyncIterator

from app.db.models import BotAccount
from app.services.adapters.base import AgentPayload, AgentResponse, OpenClawAdapter
from app.services.pipeline.adapter_events import AdapterEvent, DispatchedAsync, Final

logger = logging.getLogger("app.services.adapters.websocket_bot")


def _sanitize_attachment(a: dict) -> dict:
    """只对外暴露摘要/文件名/类型/file_id；content 全文留 plugin 按需回拉（Phase D+）。"""
    return {
        "file_id": a.get("file_id"),
        "filename": a.get("filename") or a.get("original_filename"),
        "content_type": a.get("content_type"),
        "size_bytes": a.get("size_bytes"),
        "summary": a.get("summary"),
    }


class WebsocketBotAdapter(OpenClawAdapter):
    """WebSocket Bot：通过 per-bot data WS 派发消息，plugin 异步回推回复."""

    def __init__(self, bot: BotAccount) -> None:
        self.bot = bot
        self.binding_config: dict = dict(bot.binding_config or {})

    async def execute(self, payload: AgentPayload) -> AgentResponse:
        return await self._drain_execute_iter(payload)

    async def execute_iter(self, payload: AgentPayload) -> AsyncIterator[AdapterEvent]:
        # 延迟导入以避免 import 时拉起 bridge 依赖
        from app.services.openclaw_bridge.pending import PendingReply, pending_replies
        from app.services.openclaw_bridge.registry import bot_session_registry
        from app.services.openclaw_bridge.service import register_stream
        from app.services.openclaw_bridge.streams import stream_registry

        # orchestrator 将占位 bot_msg.msg_id 放在 process_config 里传下来
        placeholder_msg_id = payload.process_config.placeholder_msg_id

        sess = bot_session_registry.get(self.bot.bot_id)
        if sess is None or sess.data_ws is None:
            yield Final(
                content=f"[{self.bot.display_name or self.bot.username}] 没有在线的 OpenClaw channel plugin",
                success=False,
                error_message="no_plugin_subscribers",
            )
            return

        session_payload = None
        db_session = payload.process_config.db_session
        if db_session is not None:
            from app.services.openclaw_bridge.session_map import resolve_dispatch_session

            session_resolution = await resolve_dispatch_session(
                db_session,
                bot=self.bot,
                channel_id=payload.channel_id,
                trigger_message=payload.trigger_message,
                task_id=payload.task_id,
            )
            session_payload = session_resolution.to_event_payload()

        # 先把 pending 登记到内存（不附 timeout），确保 plugin 秒回时
        # `/ws/openclaw/data` 的 reply handler 能从 pending 里 peek 到 channel_id /
        # finalize 正确的占位消息。timeout 由 orchestrator 在确认 dispatched_async
        # 之后补登记（避免同步路径也被 arm）。
        preregistered = False
        if placeholder_msg_id:
            await pending_replies.register(PendingReply(
                task_id=payload.task_id,
                bot_id=self.bot.bot_id,
                channel_id=payload.channel_id,
                msg_id=placeholder_msg_id,
            ))
            preregistered = True
            # Also open a streaming buffer keyed on the same msg_id; if the
            # plugin chooses to stream `delta` frames the data WS handler
            # routes them here. If it instead sends a single `reply` (legacy
            # path) the stream stays empty and is later cleaned up alongside
            # the pending entry by `finalize_bot_reply`.
            await register_stream(
                msg_id=placeholder_msg_id,
                bot_id=self.bot.bot_id,
                channel_id=payload.channel_id,
                task_id=payload.task_id,
            )

        event = {
            "type": "message",
            "bot_id": self.bot.bot_id,
            "bot_username": self.bot.username,
            "bot_display_name": self.bot.display_name,
            "channel_id": payload.channel_id,
            "task_id": payload.task_id,
            "placeholder_msg_id": placeholder_msg_id,
            "trigger_message": payload.trigger_message,
            "memory_context": payload.memory_context,
            "attachments": [_sanitize_attachment(a) for a in (payload.attachments or [])],
            "binding_config": self.binding_config,
        }
        if session_payload is not None:
            event["session"] = session_payload
            event["openclaw_session_key"] = session_payload["openclaw_session_key"]

        delivered = await bot_session_registry.dispatch_data(self.bot.bot_id, event)
        logger.info(
            "websocket_bot: dispatch bot_id=%s task_id=%s delivered=%s",
            self.bot.bot_id, payload.task_id, delivered,
        )

        if not delivered:
            # 没 plugin 在线：回滚预登记，让 orchestrator 走原同步 finalize 路径
            if preregistered and placeholder_msg_id:
                await pending_replies.pop_by_msg(placeholder_msg_id)
                await stream_registry.pop(placeholder_msg_id)
            yield Final(
                content=f"[{self.bot.display_name or self.bot.username}] 没有在线的 OpenClaw channel plugin",
                success=False,
                error_message="no_plugin_subscribers",
            )
            return

        yield DispatchedAsync()

    async def health_check(self) -> bool:
        from app.services.openclaw_bridge.registry import bot_session_registry

        sess = bot_session_registry.get(self.bot.bot_id)
        return sess is not None and sess.data_ws is not None
