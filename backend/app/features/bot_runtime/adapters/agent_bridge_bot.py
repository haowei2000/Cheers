"""AgentBridgeBotAdapter：异步 Agent Bridge Bot 适配器。

Slack / Discord 风格的异步流程（Phase C：per-bot data WS）：
  1. 用户 @mention 本 Bot 时，Bot pipeline 创建占位 bot 消息后消费 execute() 事件流；
  2. execute() 向 bot_session_registry 查找目标 bot 的 data WS，推送 message 帧；
     - 若找到：yield DispatchedAsync()
     - 若未连：返回 success=False，Bot pipeline 按原 finalize 路径写兜底文案
  3. Bot pipeline 看到 dispatched_async=True 后，把占位消息登记到 pending_replies，
     调度超时兜底；
  4. 远端 provider agent 产出回复后，plugin 通过 data WS 的 reply 帧回推；
     bridge 的 /ws/agent-bridge/data 路由从 pending_replies 里 finalize 占位消息。
"""
from __future__ import annotations

import logging
from collections.abc import AsyncIterator

from app.db.models import BotAccount, PromptTemplate
from app.features.bot_runtime.adapters.base import AgentPayload, BotAdapter
from app.features.bot_runtime.adapters.prompt_template import (
    DEFAULT_USER_TEMPLATE,
    build_template_context,
    render_user_template,
)
from app.features.bot_runtime.pipeline.adapter_events import AdapterEvent, DispatchedAsync, Final

logger = logging.getLogger("app.features.bot_runtime.adapters.agent_bridge_bot")


def _sanitize_attachment(a: dict) -> dict:
    """只对外暴露摘要/文件名/类型/file_id；content 全文留 plugin 按需回拉（Phase D+）。"""
    return {
        "file_id": a.get("file_id"),
        "filename": a.get("filename") or a.get("original_filename"),
        "content_type": a.get("content_type"),
        "size_bytes": a.get("size_bytes"),
        "summary": a.get("summary"),
    }


class AgentBridgeBotAdapter(BotAdapter):
    """Agent Bridge Bot：通过 per-bot data WS 派发消息，plugin 异步回推回复."""

    def __init__(
        self,
        bot: BotAccount,
        *,
        template_override: PromptTemplate | None = None,
    ) -> None:
        self.bot = bot
        self.template: PromptTemplate | None = template_override or bot.prompt_template
        self.binding_config: dict = dict(bot.binding_config or {})

    def _get_system_prompt(self) -> str:
        base = ""
        if self.template:
            base = getattr(self.bot, "custom_system_prompt", None) or self.template.system_prompt
        bot_name = self.bot.display_name or self.bot.username
        if not base:
            return f"你在当前频道中的名称是「{bot_name}」。"
        return f"你在当前频道中的名称是「{bot_name}」。\n\n{base}"

    def _render_trigger_message(self, payload: AgentPayload) -> dict:
        trigger_meta = dict(payload.trigger_message or {})
        pconfig = payload.runtime
        if pconfig.delegated_task_xml:
            trigger_meta["text"] = str(trigger_meta.get("text") or "").strip()
            return trigger_meta
        context_vars = build_template_context(
            bot_name=self.bot.display_name or self.bot.username,
            channel_id=payload.channel_id,
            channel_name=pconfig.channel_name,
            sender_name=trigger_meta.get("sender_name") or pconfig.sender_name,
            timestamp=trigger_meta.get("timestamp", ""),
            memory_context=payload.context.memory,
        )
        template = self.template.user_template if self.template else DEFAULT_USER_TEMPLATE
        trigger_meta["text"] = render_user_template(
            template,
            message=trigger_meta.get("text", ""),
            context=context_vars,
        )
        return trigger_meta

    async def execute(self, payload: AgentPayload) -> AsyncIterator[AdapterEvent]:
        # 延迟导入以避免 import 时拉起 bridge 依赖
        from app.features.agent_bridge.pending import PendingReply, pending_replies
        from app.features.agent_bridge.registry import bot_session_registry
        from app.features.agent_bridge.service import register_stream
        from app.features.agent_bridge.streams import stream_registry

        # Bot pipeline 将占位 bot_msg.msg_id 放在 runtime 里传下来
        placeholder_msg_id = payload.runtime.placeholder_msg_id

        sess = bot_session_registry.get(self.bot.bot_id)
        if sess is None or sess.data_ws is None:
            yield Final(
                content=f"[{self.bot.display_name or self.bot.username}] 没有在线的 Agent Bridge provider",
                success=False,
                error_message="no_plugin_subscribers",
            )
            return

        session_payload = None
        db_session = payload.runtime.db_session
        if db_session is not None:
            from app.features.agent_bridge.session_map import resolve_dispatch_session

            session_resolution = await resolve_dispatch_session(
                db_session,
                bot=self.bot,
                channel_id=payload.channel_id,
                trigger_message=payload.trigger_message,
                task_id=payload.task_id,
            )
            session_payload = session_resolution.to_event_payload()

        # 先把 pending 登记到内存（不附 timeout），确保 plugin 秒回时
        # `/ws/agent-bridge/data` 的 reply handler 能从 pending 里 peek 到 channel_id /
        # finalize 正确的占位消息。timeout 由 Bot pipeline 在确认 dispatched_async
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

        # The plugin may stream or finalize immediately after dispatch. It uses
        # a separate DB session, so the placeholder must be committed before the
        # outbound message leaves this process; otherwise a fast reply can see
        # the in-memory pending entry but not the Message row.
        if placeholder_msg_id and db_session is not None:
            await db_session.flush()
            await db_session.commit()

        rendered_trigger_message = self._render_trigger_message(payload)
        event = {
            "type": "message",
            "bot_id": self.bot.bot_id,
            "bot_username": self.bot.username,
            "bot_display_name": self.bot.display_name,
            "channel_id": payload.channel_id,
            "task_id": payload.task_id,
            "placeholder_msg_id": placeholder_msg_id,
            "trigger_message": rendered_trigger_message,
            "raw_trigger_message": payload.trigger_message,
            "prompt": {
                "system": self._get_system_prompt(),
                "user": rendered_trigger_message.get("text", ""),
            },
            "memory_context": payload.context.memory,
            "attachments": [_sanitize_attachment(a) for a in (payload.context.attachments or [])],
            "binding_config": self.binding_config,
        }
        if session_payload is not None:
            event["session"] = session_payload
            event["provider_session_key"] = session_payload["provider_session_key"]

        delivered = await bot_session_registry.dispatch_data(self.bot.bot_id, event)
        logger.info(
            "agent_bridge_bot: dispatch bot_id=%s task_id=%s delivered=%s",
            self.bot.bot_id, payload.task_id, delivered,
        )

        if not delivered:
            # 没 plugin 在线：回滚预登记，让 Bot pipeline 走原同步 finalize 路径
            if preregistered and placeholder_msg_id:
                await pending_replies.pop_by_msg(placeholder_msg_id)
                await stream_registry.pop(placeholder_msg_id)
            yield Final(
                content=f"[{self.bot.display_name or self.bot.username}] 没有在线的 Agent Bridge provider",
                success=False,
                error_message="no_plugin_subscribers",
            )
            return

        yield DispatchedAsync()

    async def health_check(self) -> bool:
        from app.features.agent_bridge.registry import bot_session_registry

        sess = bot_session_registry.get(self.bot.bot_id)
        return sess is not None and sess.data_ws is not None
