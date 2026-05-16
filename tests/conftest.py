"""Tests for conftest."""
import asyncio
import os
from collections.abc import AsyncGenerator, Generator

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.db.models import Base
from app.main import app

TEST_DATABASE_URL = os.getenv(
    "TEST_DATABASE_URL",
    "postgresql+asyncpg://agentnexus:agentnexus@localhost:5433/agentnexus_test",
)


@pytest.fixture(scope="session")
def event_loop() -> Generator[asyncio.AbstractEventLoop, None, None]:
    """Covers event loop behavior."""
    loop = asyncio.new_event_loop()
    yield loop
    loop.close()


@pytest_asyncio.fixture(scope="session")
async def db_engine():
    """Covers db engine behavior."""
    engine = create_async_engine(TEST_DATABASE_URL, echo=False)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)
        await conn.run_sync(Base.metadata.create_all)

    import app.features.agent_bridge.event_log as _agent_bridge_event_log

    original_event_log_factory = _agent_bridge_event_log.async_session_factory
    _agent_bridge_event_log.async_session_factory = async_sessionmaker(
        engine, class_=AsyncSession, expire_on_commit=False, autocommit=False, autoflush=False
    )
    _agent_bridge_event_log.bot_event_seq.reset()
    yield engine
    _agent_bridge_event_log.async_session_factory = original_event_log_factory
    _agent_bridge_event_log.bot_event_seq.reset()
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)
    await engine.dispose()


@pytest_asyncio.fixture
async def db_session(db_engine) -> AsyncGenerator[AsyncSession, None]:
    """Covers db session behavior."""
    factory = async_sessionmaker(
        db_engine, class_=AsyncSession, expire_on_commit=False, autocommit=False, autoflush=False
    )
    async with factory() as session:
        yield session
        await session.rollback()


@pytest_asyncio.fixture
async def client(db_session: AsyncSession, db_engine) -> AsyncGenerator[AsyncClient, None]:
    """Covers client behavior."""
    import app.api.v1.messages.routes as _messages_mod
    import app.features.bot_runtime.pipeline.bot.jobs as _bot_pipeline_jobs_mod
    from app.core.dependencies import get_current_user
    from app.core.dependencies import get_session as get_session_core
    from app.db.models import User
    from app.db.session import get_session as get_session_db

    test_session_factory = async_sessionmaker(
        db_engine, class_=AsyncSession, expire_on_commit=False, autocommit=False, autoflush=False
    )

    async def override_get_session() -> AsyncGenerator[AsyncSession, None]:
        yield db_session

    # Test system_admin user; auth is bypassed and the row satisfies FK constraints.
    TEST_USER_ID = "a0000000-0000-0000-0000-000000000099"
    test_user = User(
        user_id=TEST_USER_ID,
        username="test_admin",
        password_hash="x",
        display_name="Test Admin",
        role="system_admin",
    )
    # Upsert test user into DB so FK constraints pass (merge handles duplicate across tests)
    await db_session.merge(test_user)
    await db_session.commit()

    async def override_get_current_user() -> User:
        return test_user

    original_factory = _messages_mod.async_session_factory
    original_jobs_factory = _bot_pipeline_jobs_mod.async_session_factory
    _messages_mod.async_session_factory = test_session_factory
    _bot_pipeline_jobs_mod.async_session_factory = test_session_factory
    app.dependency_overrides[get_session_core] = override_get_session
    app.dependency_overrides[get_session_db] = override_get_session
    app.dependency_overrides[get_current_user] = override_get_current_user

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac

    _messages_mod.async_session_factory = original_factory
    _bot_pipeline_jobs_mod.async_session_factory = original_jobs_factory
    app.dependency_overrides.clear()
