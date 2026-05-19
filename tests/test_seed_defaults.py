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
from app.db.models import Base, BotAccount, PromptTemplate
from app.db.seed import seed


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
