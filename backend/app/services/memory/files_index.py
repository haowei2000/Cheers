"""FILES_INDEX 层：现在由 ChannelMemory 从 FileRecord 实时渲染，无需写入 context_store。

保留 schedule_files_index_update 接口以避免调用方报错，但实际为空操作。
"""
from __future__ import annotations

import logging

logger = logging.getLogger("app.services.memory.files_index")


def schedule_files_index_update(channel_id: str, attachments: list[dict]) -> None:
    """No-op：FILES_INDEX 现在由 ChannelMemory 从 FileRecord 实时渲染。"""
    pass
