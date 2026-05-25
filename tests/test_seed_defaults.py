import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.config import settings
from app.core.builtin_defaults import (
    RETIRED_BUILTIN_TEMPLATE_IDS,
    TEMPLATE_GENERAL_ID,
    builtin_prompt_template,
    builtin_prompt_templates,
)
from app.db.models import Base, BotAccount, ChannelMembership, PromptTemplate
from app.db.seed import seed
from app.features.agent_bridge.tokens import resolve_bot_by_token
from app.services.auth.password_utils import verify_password


def test_builtin_prompt_templates_keep_only_general() -> None:
    templates = builtin_prompt_templates("en")

    assert [template.template_id for template in templates] == [TEMPLATE_GENERAL_ID]
    assert all(
        builtin_prompt_template(template_id, "en") is None
        for template_id in RETIRED_BUILTIN_TEMPLATE_IDS
    )


@pytest.mark.asyncio
async def test_seed_prunes_retired_templates_and_seeded_test_bots(monkeypatch, tmp_path) -> None:
    monkeypatch.setattr(settings, "admin_password", "valid-seed-password-123")
    db_path = tmp_path / "seed.db"
    engine = create_async_engine(f"sqlite+aiosqlite:///{db_path}")
    try:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)

        session_factory = async_sessionmaker(engine, expire_on_commit=False, autoflush=False)
        async with session_factory() as session:
            session.add_all(
                [
                    PromptTemplate(
                        template_id="template-codereview-001",
                        name="Code review",
                        description="Retired built-in template",
                        system_prompt="Review code.",
                        user_template="{{message}}",
                        variables=["message"],
                        is_builtin=True,
                    ),
                    PromptTemplate(
                        template_id="template-creative-001",
                        name="Creative writing",
                        description="Retired built-in template",
                        system_prompt="Write creatively.",
                        user_template="{{message}}",
                        variables=["message"],
                        is_builtin=True,
                    ),
                    BotAccount(
                        bot_id="bot-test-001",
                        username="testbot",
                        display_name="Test Bot",
                        template_id="template-codereview-001",
                        status="online",
                    ),
                ]
            )
            await session.commit()

        async with session_factory() as session:
            await seed(session)
            await session.commit()

        async with session_factory() as session:
            templates = (
                await session.execute(
                    select(PromptTemplate).where(PromptTemplate.is_builtin.is_(True))
                )
            ).scalars().all()
            assert [template.template_id for template in templates] == [TEMPLATE_GENERAL_ID]
            assert await session.get(BotAccount, "bot-test-001") is None
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_seed_creates_configured_opencode_bot(monkeypatch, tmp_path) -> None:
    monkeypatch.setattr(settings, "admin_password", "valid-seed-password-123")
    monkeypatch.setattr(settings, "opencode_bot_enabled", True)
    monkeypatch.setattr(settings, "opencode_bot_id", "bot-opencode-test-001")
    monkeypatch.setattr(settings, "opencode_bot_username", "opencode")
    monkeypatch.setattr(settings, "opencode_bot_display_name", "OpenCode")
    monkeypatch.setattr(settings, "opencode_bot_description", "OpenCode ACP coding assistant")
    monkeypatch.setattr(settings, "opencode_bot_scope", "everyone")
    token = "agb_test_opencode_seed_token_1234567890"
    monkeypatch.setattr(settings, "opencode_bot_token", token)

    db_path = tmp_path / "seed-opencode.db"
    engine = create_async_engine(f"sqlite+aiosqlite:///{db_path}")
    try:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)

        session_factory = async_sessionmaker(engine, expire_on_commit=False, autoflush=False)
        async with session_factory() as session:
            await seed(session)
            await session.commit()

        async with session_factory() as session:
            bot = await session.get(BotAccount, "bot-opencode-test-001")
            assert bot is not None
            assert bot.username == "opencode"
            assert bot.binding_type == "agent_bridge"
            assert bot.bridge_provider == "acp"
            assert bot.scope == "everyone"
            assert bot.created_by == "admin-0000-0000-0000-000000000001"
            assert bot.binding_config["managed_by"] == "docker_compose_opencode_bot"
            assert bot.bot_token_hash is not None
            assert token not in bot.bot_token_hash
            assert verify_password(token, bot.bot_token_hash)
            assert await resolve_bot_by_token(session, token) == bot

            membership = (
                await session.execute(
                    select(ChannelMembership).where(
                        ChannelMembership.channel_id == "ch-seed-001",
                        ChannelMembership.member_id == "bot-opencode-test-001",
                        ChannelMembership.member_type == "bot",
                    )
                )
            ).scalar_one_or_none()
            assert membership is not None
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_seed_backfills_configured_opencode_bot_owner(monkeypatch, tmp_path) -> None:
    monkeypatch.setattr(settings, "admin_password", "valid-seed-password-123")
    monkeypatch.setattr(settings, "opencode_bot_enabled", True)
    monkeypatch.setattr(settings, "opencode_bot_id", "bot-opencode-test-002")
    monkeypatch.setattr(settings, "opencode_bot_username", "opencode_backfill")
    monkeypatch.setattr(settings, "opencode_bot_display_name", "OpenCode")
    monkeypatch.setattr(settings, "opencode_bot_description", "OpenCode ACP coding assistant")
    monkeypatch.setattr(settings, "opencode_bot_scope", "everyone")
    monkeypatch.setattr(settings, "opencode_bot_token", "agb_test_opencode_seed_token_backfill_1234567890")

    db_path = tmp_path / "seed-opencode-backfill.db"
    engine = create_async_engine(f"sqlite+aiosqlite:///{db_path}")
    try:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)

        session_factory = async_sessionmaker(engine, expire_on_commit=False, autoflush=False)
        async with session_factory() as session:
            session.add(
                BotAccount(
                    bot_id="bot-opencode-test-002",
                    username="opencode_backfill",
                    display_name="OpenCode",
                    binding_type="agent_bridge",
                    created_by="",
                )
            )
            await session.commit()

        async with session_factory() as session:
            await seed(session)
            await session.commit()

        async with session_factory() as session:
            bot = await session.get(BotAccount, "bot-opencode-test-002")
            assert bot is not None
            assert bot.created_by == "admin-0000-0000-0000-000000000001"
    finally:
        await engine.dispose()
