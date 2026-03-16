"""Context Store：SQLite（WAL）主存储 + 四层 key 读写（ADR D-02）."""
import os
from pathlib import Path

import aiosqlite

LAYERS = ("ANCHOR", "DECISIONS", "FILES_INDEX", "RECENT", "PROGRESS")


async def init_context_db(db_path: str) -> None:
    """创建 SQLite 数据库并开启 WAL，建表."""
    Path(db_path).parent.mkdir(parents=True, exist_ok=True)
    async with aiosqlite.connect(db_path) as conn:
        await conn.execute("PRAGMA journal_mode=WAL")
        await conn.execute(
            """
            CREATE TABLE IF NOT EXISTS context_store (
                channel_id TEXT NOT NULL,
                layer TEXT NOT NULL,
                content TEXT NOT NULL DEFAULT '',
                updated_at TEXT,
                PRIMARY KEY (channel_id, layer)
            )
            """
        )
        await conn.commit()


async def get_layer(db_path: str, channel_id: str, layer: str) -> str:
    """读取一层内容，不存在则返回空字符串."""
    async with aiosqlite.connect(db_path) as conn:
        cursor = await conn.execute(
            "SELECT content FROM context_store WHERE channel_id = ? AND layer = ?",
            (channel_id, layer),
        )
        row = await cursor.fetchone()
        return (row[0] or "") if row else ""


async def set_layer(db_path: str, channel_id: str, layer: str, content: str) -> None:
    """写入一层（先 SQLite），调用方负责异步同步到 MD."""
    from datetime import datetime, timezone
    now = datetime.now(timezone.utc).isoformat()
    async with aiosqlite.connect(db_path) as conn:
        await conn.execute(
            """
            INSERT INTO context_store (channel_id, layer, content, updated_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT (channel_id, layer) DO UPDATE SET content = ?, updated_at = ?
            """,
            (channel_id, layer, content, now, content, now),
        )
        await conn.commit()


async def get_all_layers(db_path: str, channel_id: str) -> dict[str, str]:
    """读取频道四层记忆，供 Orchestrator 注入."""
    result = {}
    for layer in LAYERS:
        result[layer.lower()] = await get_layer(db_path, channel_id, layer)
    return result
