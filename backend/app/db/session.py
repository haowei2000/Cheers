"""Asynchronous database engine and session helpers."""
from collections.abc import AsyncGenerator

from sqlalchemy.ext.asyncio import (
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from app.config import settings
from app.db.models import Base

# Use SQLAlchemy's default pool settings, which are suitable for PostgreSQL.
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
    """Get session."""
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
    """Init db."""
    async with async_engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
