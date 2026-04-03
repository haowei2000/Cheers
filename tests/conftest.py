"""Pytest  fixtures：测试用 DB、客户端."""
import asyncio
import os
from collections.abc import AsyncGenerator, Generator

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.db.models import Base
from app.main import app


@pytest.fixture(scope="session")
def event_loop() -> Generator[asyncio.AbstractEventLoop, None, None]:
    loop = asyncio.new_event_loop()
    yield loop
    loop.close()


TEST_DATABASE_URL = os.getenv(
    "TEST_DATABASE_URL",
    "postgresql+asyncpg://postgres:postgres@localhost:5432/agentnexus_test",
)


@pytest_asyncio.fixture
async def db_engine():
    """PostgreSQL 测试引擎（每次测试重建表结构）."""
    engine = create_async_engine(TEST_DATABASE_URL, echo=False)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)
        await conn.run_sync(Base.metadata.create_all)
    yield engine
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)
    await engine.dispose()


@pytest_asyncio.fixture
async def db_session(db_engine) -> AsyncGenerator[AsyncSession, None]:
    """每个测试独立的异步会话."""
    factory = async_sessionmaker(
        db_engine, class_=AsyncSession, expire_on_commit=False, autocommit=False, autoflush=False
    )
    async with factory() as session:
        yield session
        await session.rollback()


@pytest_asyncio.fixture
async def client(db_session: AsyncSession, db_engine) -> AsyncGenerator[AsyncClient, None]:
    """覆盖依赖的 FastAPI 测试客户端。

    同时将 messages.py 中的 async_session_factory 替换为测试用工厂，
    确保 _run_orchestrator_bg 后台任务也写入同一块测试 DB。
    """
    from sqlalchemy.ext.asyncio import async_sessionmaker
    from app.db.session import get_session
    from app.services.auth.routes import get_current_user
    from app.db.models import User
    import app.api.v1.messages.routes as _messages_mod

    test_session_factory = async_sessionmaker(
        db_engine, class_=AsyncSession, expire_on_commit=False, autocommit=False, autoflush=False
    )

    async def override_get_session() -> AsyncGenerator[AsyncSession, None]:
        yield db_session

    # 测试用 system_admin 用户（跳过认证）
    test_user = User(
        user_id="test-user-0000-0000-0000-000000000001",
        username="test_admin",
        password_hash="x",
        display_name="Test Admin",
        role="system_admin",
    )

    async def override_get_current_user() -> User:
        return test_user

    original_factory = _messages_mod.async_session_factory
    _messages_mod.async_session_factory = test_session_factory
    app.dependency_overrides[get_session] = override_get_session
    app.dependency_overrides[get_current_user] = override_get_current_user

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac

    _messages_mod.async_session_factory = original_factory
    app.dependency_overrides.clear()
