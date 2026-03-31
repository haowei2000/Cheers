"""FILES_INDEX 层维护：文档上传后自动注册元信息，Agent 通过 read_file 工具按需读取正文。"""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone

logger = logging.getLogger("app.memory.files_index")


def _build_file_entry(attachment: dict) -> str:
    """将 prepare_attachments 返回的 attachment dict 格式化为索引条目。"""
    file_id = attachment.get("file_id") or "unknown"
    filename = attachment.get("filename") or file_id
    content_type = attachment.get("content_type") or ""
    summary = (attachment.get("summary") or "").strip()
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")

    lines = [f"### {filename}"]
    lines.append(f"- file_id: `{file_id}`")
    if content_type:
        lines.append(f"- 类型: {content_type}")
    if summary:
        lines.append(f"- 摘要: {summary}")
    lines.append(f"- 登记时间: {ts}")
    return "\n".join(lines)


def _file_in_index(file_id: str, index_content: str) -> bool:
    return f"`{file_id}`" in index_content


async def update_files_index(channel_id: str, attachments: list[dict]) -> None:
    """
    将本次消息的文档附件注册进 FILES_INDEX 层。
    图片附件和已登记的条目均跳过；失败时静默。
    """
    doc_attachments = [a for a in attachments if a.get("is_image") != "true"]
    if not doc_attachments:
        return

    from app.memory.context_store import get_layer, init_context_db
    from app.memory.manager import save_layer, sync_channel_to_md

    try:
        await init_context_db()
        existing = (await get_layer(channel_id, "FILES_INDEX")) or ""

        new_entries: list[str] = []
        for att in doc_attachments:
            fid = att.get("file_id") or ""
            if not fid or _file_in_index(fid, existing):
                continue
            new_entries.append(_build_file_entry(att))

        if not new_entries:
            return

        sep = "\n\n---\n\n"
        updated = (existing.rstrip() + sep + sep.join(new_entries)) if existing.strip() else sep.join(new_entries)
        await save_layer(channel_id, "FILES_INDEX", updated)
        await sync_channel_to_md(channel_id)
        logger.info("files_index: registered %d new file(s) channel=%s", len(new_entries), channel_id)
    except Exception:
        logger.exception("files_index: update failed channel=%s", channel_id)


def schedule_files_index_update(channel_id: str, attachments: list[dict]) -> None:
    """非阻塞调度文件索引更新（后台任务）。"""
    asyncio.create_task(update_files_index(channel_id, attachments))
