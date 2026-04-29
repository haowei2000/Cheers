"""ContextLoadStage: parallel load of channel memory, attachments, topic chain.

Three I/O paths run via asyncio.gather:

- ``memory.manager.load_layers`` — picks the layer set per
  ``trigger_msg.msg_type`` via ``_LAYERS_BY_MSG_TYPE`` so routing and
  permission cards skip the heavy renders they don't need.
- ``FilePipelineService.prepare_metadata_only`` — ingests trigger_msg's
  files (or, in clarify scenarios, falls back to the original question's
  files captured by RouteStage).
- ``topic_context.gather_topic_context`` — chain + child replies for
  prompt construction.

All outputs land on BotRunContext. Errors loading attachments are recorded
on ``ctx.attachment_error`` and DispatchStage decides how to surface them.
"""
from __future__ import annotations

import asyncio
import logging

from app.services.file_processor.service import FileFlowError, FilePipelineService
from app.services.memory.channel_memory import ChannelMemory
from app.services.memory.manager import load_layers as memory_load_layers
from app.services.orchestrator.topic_context import gather_topic_context
from app.services.pipeline.bot.context import BotRunContext
from app.services.pipeline.stage import Stage

logger = logging.getLogger("app.services.pipeline.bot.context_load")


# msg_type → layers needed. Routing cards and permission approvals don't
# benefit from the full memory load; everything else falls through to the
# all-layers default to stay safe.
_LAYERS_BY_MSG_TYPE: dict[str, frozenset[str]] = {
    "routing": frozenset({"anchor", "decisions"}),
    "permission": frozenset({"anchor"}),
}


def select_memory_layers(msg_type: str | None) -> frozenset[str]:
    """Return the memory layer set to load for this trigger msg_type.

    Conservative fallback: unknown / normal / reply / topic load every
    layer. The known-narrow types (routing, permission) get a subset.
    """
    if not msg_type:
        return ChannelMemory.ALL_LAYERS
    return _LAYERS_BY_MSG_TYPE.get(msg_type, ChannelMemory.ALL_LAYERS)


class ContextLoadStage(Stage[BotRunContext]):
    async def run(self, ctx: BotRunContext) -> None:
        layers = select_memory_layers(ctx.trigger_msg.msg_type)
        memory_context, _, topic_result = await asyncio.gather(
            memory_load_layers(ctx.channel_id, ctx.session, layers),
            self._load_attachments(ctx),
            gather_topic_context(ctx.trigger_msg, ctx.session),
        )
        ctx.memory_context = memory_context
        ctx.topic_chain, ctx.child_replies = topic_result

    @staticmethod
    async def _load_attachments(ctx: BotRunContext) -> None:
        # Trigger message's files have priority; clarify replies fall back to
        # the original question's files captured by RouteStage.
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
                    "orchestrator: restored %d attachment(s) from original clarify question channel=%s",
                    len(ctx.attachments), ctx.channel_id,
                )
        except FileFlowError as exc:
            ctx.attachment_error = exc.detail
        except Exception as exc:
            logger.exception("failed to prepare attachments channel_id=%s", ctx.channel_id)
            ctx.attachment_error = f"读取上传文件失败：{exc}"
