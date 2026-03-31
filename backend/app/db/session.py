"""异步数据库引擎与会话."""
from collections.abc import AsyncGenerator

from sqlalchemy.ext.asyncio import (
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from app.config import settings
from app.db.models import Base

# 默认使用 SQLAlchemy 默认连接池配置，适合 PostgreSQL
async_engine = create_async_engine(
    settings.database_url,
    echo=settings.debug,
    future=True,
)


async_session_factory = async_sessionmaker(
    async_engine,
    class_=AsyncSession,
    expire_on_commit=False,
    autocommit=False,
    autoflush=False,
)


async def get_session() -> AsyncGenerator[AsyncSession, None]:
    """依赖注入用：获取异步会话."""
    async with async_session_factory() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise
        finally:
            await session.close()


async def init_db() -> None:
    """仅测试用：在内存 SQLite 中直接建表。生产环境请用 alembic upgrade head。"""
    async with async_engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
