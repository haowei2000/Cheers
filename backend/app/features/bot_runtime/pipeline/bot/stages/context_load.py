"""ContextLoadStage: load the context requested by the prebuilt workflow.

Three I/O paths run via asyncio.gather:

- ``memory.manager.load_layers`` — uses the layer set selected by
  ``BotWorkflowBuilder``.
- ``FilePipelineService.prepare_metadata_only`` — ingests trigger_msg's
  files (or, in clarify scenarios, falls back to the original question's
  files captured by BotWorkflowBuilder).
- ``topic_context.gather_topic_context`` — chain + child replies for
  prompt construction.

All outputs land on BotRunContext. Errors loading attachments are recorded
on ``ctx.attachment_error`` and dispatch decides how to surface them.
"""
from __future__ import annotations

import asyncio
import logging

from app.features.bot_runtime.adapters.prompt_template import template_uses_memory
from app.features.bot_runtime.pipeline.bot.context import BotRunContext
from app.features.bot_runtime.pipeline.bot.topic_context import gather_topic_context
from app.features.bot_runtime.pipeline.stage import Stage
from app.features.memory.channel_memory import ChannelMemory
from app.features.memory.manager import load_layers as memory_load_layers
from app.services.file_processor.service import FileFlowError, FilePipelineService

logger = logging.getLogger("app.features.bot_runtime.pipeline.bot.context_load")


# msg_type → layers needed. Routing cards and permission approvals don't
# benefit from the full memory load; everything else falls through to the
# all-layers default to stay safe.
_LAYERS_BY_MSG_TYPE: dict[str, frozenset[str]] = {
    "routing": frozenset({"anchor", "decisions"}),
    "permission": frozenset({"anchor"}),
}

_LAYER_ORDER = ("anchor", "progress", "decisions", "files_index", "recent", "todos")
_LAYER_LABELS = {
    "anchor": "项目锚点",
    "progress": "项目进度",
    "decisions": "决策记录",
    "files_index": "资料索引",
    "recent": "近期动态",
    "todos": "待办事项",
}
_LAYER_SOURCES = {
    "anchor": "MemoryEntry.ANCHOR",
    "progress": "MemoryEntry.PROGRESS",
    "decisions": "MemoryEntry.DECISIONS",
    "files_index": "FileRecord rendered index",
    "recent": "current_page + message_page summaries",
    "todos": "TodoItem open items",
}


def select_memory_layers(msg_type: str | None) -> frozenset[str]:
    """Return the memory layer set to load for this trigger msg_type.

    Conservative fallback: unknown / normal / reply / topic load every
    layer. The known-narrow types (routing, permission) get a subset.
    """
    if not msg_type:
        return ChannelMemory.ALL_LAYERS
    return _LAYERS_BY_MSG_TYPE.get(msg_type, ChannelMemory.ALL_LAYERS)


def should_build_memory(ctx: BotRunContext) -> bool:
    """Memory is loaded only for targets whose effective template asks for it."""
    for username in ctx.target_usernames:
        user_template = ctx.bot_user_templates_by_username.get(username)
        if user_template is None:
            return True
        if template_uses_memory(user_template):
            return True
    return False


def build_memory_load_detail(
    *,
    trigger_msg_id: str,
    trigger_msg_type: str | None,
    requested_layers: frozenset[str] | set[str],
    memory_context: dict[str, str],
    memory_requested: bool = True,
) -> dict:
    """Build the compact memory-load snapshot stored on bot replies."""
    requested = set(requested_layers)
    layers: list[dict] = []
    total_chars = 0
    for source in _LAYER_ORDER:
        content = memory_context.get(source) or ""
        chars = len(content)
        total_chars += chars
        preview = content.strip()
        if len(preview) > 1200:
            preview = preview[:1200] + "..."
        layers.append(
            {
                "source": source,
                "label": _LAYER_LABELS[source],
                "loader": _LAYER_SOURCES[source],
                "requested": source in requested,
                "present": bool(content.strip()),
                "chars": chars,
                "preview": preview,
            }
        )
    return {
        "kind": "bot_memory_load",
        "strategy": "ContextLoadStage.template_memory_gate",
        "memory_requested": memory_requested,
        "trigger_msg_id": trigger_msg_id,
        "trigger_msg_type": trigger_msg_type or "normal",
        "requested_layers": [layer for layer in _LAYER_ORDER if layer in requested],
        "total_chars": total_chars,
        "layers": layers,
    }


class ContextLoadStage(Stage[BotRunContext]):
    async def run(self, ctx: BotRunContext) -> None:
        plan = ctx.workflow
        layers = plan.memory_layers if plan is not None else select_memory_layers(ctx.trigger_msg.msg_type)
        memory_requested = plan.memory_requested if plan is not None else should_build_memory(ctx)
        load_attachments = plan.load_attachments if plan is not None else True
        load_topic_context = plan.load_topic_context if plan is not None else True
        memory_loader = (
            memory_load_layers(ctx.channel_id, ctx.session, layers)
            if memory_requested
            else self._skip_memory_load()
        )
        memory_context, _, topic_result = await asyncio.gather(
            memory_loader,
            self._load_attachments(ctx) if load_attachments else self._skip_attachments(),
            (
                gather_topic_context(ctx.trigger_msg, ctx.session)
                if load_topic_context
                else self._skip_topic_context()
            ),
        )
        ctx.memory_context = memory_context
        ctx.memory_load_detail = build_memory_load_detail(
            trigger_msg_id=ctx.trigger_msg.msg_id,
            trigger_msg_type=ctx.trigger_msg.msg_type,
            requested_layers=layers if memory_requested else frozenset(),
            memory_context=memory_context,
            memory_requested=memory_requested,
        )
        ctx.topic_chain, ctx.child_replies = topic_result

    @staticmethod
    async def _skip_memory_load() -> dict[str, str]:
        return {}

    @staticmethod
    async def _skip_attachments() -> None:
        return None

    @staticmethod
    async def _skip_topic_context() -> tuple[list, list]:
        return [], []

    @staticmethod
    async def _load_attachments(ctx: BotRunContext) -> None:
        # Trigger message's files have priority; clarify replies fall back to
        # the original question's files captured by BotWorkflowBuilder.
        file_ids = ctx.trigger_msg.file_ids or ctx.original_file_ids
        if not file_ids:
            return
        try:
            ctx.attachments = await FilePipelineService().prepare_metadata_only(
                ctx.session,
                channel_id=ctx.channel_id,
                file_ids=file_ids,
            )
            if ctx.original_file_ids and not ctx.trigger_msg.file_ids:
                logger.info(
                    "bot_pipeline: restored %d attachment(s) from original clarify question channel=%s",
                    len(ctx.attachments), ctx.channel_id,
                )
        except FileFlowError as exc:
            ctx.attachment_error = exc.detail
        except Exception as exc:
            logger.exception("failed to prepare attachments channel_id=%s", ctx.channel_id)
            ctx.attachment_error = f"读取上传文件失败：{exc}"
