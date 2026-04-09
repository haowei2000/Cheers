"""RECENT 层异步更新：处理历史分页与摘要压缩，不阻塞主消息流。"""
import asyncio

from app.services.memory.history_pager import maybe_compact_channel, update_recent_pages_layer

async def update_recent_async(channel_id: str) -> None:
    """异步更新频道 RECENT 层。"""
    try:
        compacted = await maybe_compact_channel(channel_id)
        if not compacted:
            await update_recent_pages_layer(channel_id)
    except Exception:
        pass

def schedule_recent_update(channel_id: str) -> None:
    """在 Bot 响应后调度 RECENT 更新（后台任务，不等待）。"""
    asyncio.create_task(update_recent_async(channel_id))
