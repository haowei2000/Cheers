"""Context Store：四层 key 读写（ADR D-02）."""
from datetime import datetime, timezone

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.config import settings

LAYERS = ("ANCHOR", "DECISIONS", "FILES_INDEX", "RECENT", "PROGRESS")

_engine = create_async_engine(settings.context_db_url, echo=False, future=True)
_session_factory = async_sessionmaker(_engine, class_=AsyncSession, expire_on_commit=False)

_context_db_initialized = False


async def init_context_db() -> None:
    """创建 context_store 表（如果不存在）；只在进程内首次调用时执行 DDL。"""
    global _context_db_initialized
    if _context_db_initialized:
        return
    async with _engine.begin() as conn:
        await conn.execute(text("""
            CREATE TABLE IF NOT EXISTS context_store (
                channel_id VARCHAR(255) NOT NULL,
                layer VARCHAR(50) NOT NULL,
                content TEXT NOT NULL DEFAULT '',
                updated_at TEXT,
                PRIMARY KEY (channel_id, layer)
            )
        """))
    _context_db_initialized = True


async def get_layer(channel_id: str, layer: str) -> str:
    """读取一层内容，不存在则返回空字符串."""
    async with _session_factory() as session:
        result = await session.execute(
            text("SELECT content FROM context_store WHERE channel_id = :cid AND layer = :layer"),
            {"cid": channel_id, "layer": layer},
        )
        row = result.fetchone()
        return (row[0] or "") if row else ""


async def set_layer(channel_id: str, layer: str, content: str) -> None:
    """写入一层（UPSERT）."""
    now = datetime.now(timezone.utc).isoformat()
    async with _session_factory() as session:
        await session.execute(
            text("""
                INSERT INTO context_store (channel_id, layer, content, updated_at)
                VALUES (:cid, :layer, :content, :now)
                ON CONFLICT (channel_id, layer) DO UPDATE SET content = :content, updated_at = :now
            """),
            {"cid": channel_id, "layer": layer, "content": content, "now": now},
        )
        await session.commit()


async def get_all_layers(channel_id: str) -> dict[str, str]:
    """读取频道四层记忆，供 Orchestrator 注入（单次查询）."""
    async with _session_factory() as session:
        rows = await session.execute(
            text("SELECT layer, content FROM context_store WHERE channel_id = :cid"),
            {"cid": channel_id},
        )
        db_data = {row[0].lower(): (row[1] or "") for row in rows.fetchall()}
    return {layer.lower(): db_data.get(layer.lower(), "") for layer in LAYERS}
