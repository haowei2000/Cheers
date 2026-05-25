"""Bot repo module."""
from __future__ import annotations

from sqlalchemy import delete, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.db.models import (
    AgentBridgeEvent,
    AgentNexusSession,
    AgentNexusSessionBinding,
    AIModel,
    BotAccount,
    ChannelMembership,
    PromptTemplate,
)

_BOT_OPTIONS = (selectinload(BotAccount.ai_model), selectinload(BotAccount.prompt_template))


class BotRepository:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def get_by_id(self, bot_id: str) -> BotAccount | None:
        result = await self.session.execute(
            select(BotAccount).where(BotAccount.bot_id == bot_id).options(*_BOT_OPTIONS)
        )
        return result.scalar_one_or_none()

    async def get_by_username(self, username: str) -> BotAccount | None:
        result = await self.session.execute(
            select(BotAccount).where(BotAccount.username == username).options(*_BOT_OPTIONS)
        )
        return result.scalar_one_or_none()

    async def list_all(self) -> list[BotAccount]:
        result = await self.session.execute(
            select(BotAccount).order_by(BotAccount.created_at).options(*_BOT_OPTIONS)
        )
        return list(result.scalars().all())

    async def create(
        self,
        username: str,
        display_name: str | None = None,
        description: str | None = None,
        model_id: str | None = None,
        template_id: str | None = None,
        custom_system_prompt: str | None = None,
        scope: str = "friend",
        created_by: str | None = None,
    ) -> BotAccount:
        bot = BotAccount(
            username=username,
            display_name=display_name,
            description=description,
            model_id=model_id,
            template_id=template_id,
            custom_system_prompt=custom_system_prompt,
            scope=scope,
            created_by=created_by,
        )
        self.session.add(bot)
        await self.session.flush()
        return bot

    async def update(self, bot: BotAccount, **kwargs) -> BotAccount:
        for key, value in kwargs.items():
            setattr(bot, key, value)
        self.session.add(bot)
        await self.session.flush()
        return bot

    async def delete(self, bot: BotAccount) -> None:
        await self.session.execute(
            update(PromptTemplate)
            .where(PromptTemplate.default_bot_id == bot.bot_id)
            .values(default_bot_id=None)
        )
        await self.session.execute(
            delete(AgentNexusSessionBinding).where(AgentNexusSessionBinding.bot_id == bot.bot_id)
        )
        await self.session.execute(
            delete(AgentNexusSession).where(AgentNexusSession.bot_id == bot.bot_id)
        )
        await self.session.execute(
            delete(AgentBridgeEvent).where(AgentBridgeEvent.bot_id == bot.bot_id)
        )
        await self.session.execute(
            delete(ChannelMembership).where(
                ChannelMembership.member_id == bot.bot_id,
                ChannelMembership.member_type == "bot",
            )
        )
        await self.session.delete(bot)
        await self.session.flush()


class AIModelRepository:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def get_by_id(self, model_id: str) -> AIModel | None:
        result = await self.session.execute(select(AIModel).where(AIModel.model_id == model_id))
        return result.scalar_one_or_none()

    async def list_all(self) -> list[AIModel]:
        result = await self.session.execute(select(AIModel).order_by(AIModel.created_at))
        return list(result.scalars().all())

    async def list_visible(self, user_id: str) -> list[AIModel]:
        result = await self.session.execute(
            select(AIModel)
            .where(
                or_(
                    AIModel.is_builtin.is_(True),
                    AIModel.created_by.is_(None),
                    AIModel.created_by == user_id,
                )
            )
            .order_by(AIModel.created_at)
        )
        return list(result.scalars().all())

    async def create(self, **kwargs) -> AIModel:
        model = AIModel(**kwargs)
        self.session.add(model)
        await self.session.flush()
        return model

    async def update(self, model: AIModel, **kwargs) -> AIModel:
        for key, value in kwargs.items():
            setattr(model, key, value)
        self.session.add(model)
        await self.session.flush()
        return model

    async def delete(self, model: AIModel) -> None:
        await self.session.delete(model)
        await self.session.flush()


class PromptTemplateRepository:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def get_by_id(self, template_id: str) -> PromptTemplate | None:
        result = await self.session.execute(
            select(PromptTemplate).where(PromptTemplate.template_id == template_id)
        )
        return result.scalar_one_or_none()

    async def get_by_name(self, name: str) -> PromptTemplate | None:
        result = await self.session.execute(
            select(PromptTemplate).where(PromptTemplate.name == name)
        )
        return result.scalar_one_or_none()

    async def list_all(self) -> list[PromptTemplate]:
        result = await self.session.execute(select(PromptTemplate).order_by(PromptTemplate.created_at))
        return list(result.scalars().all())

    async def create(self, **kwargs) -> PromptTemplate:
        tmpl = PromptTemplate(**kwargs)
        self.session.add(tmpl)
        await self.session.flush()
        return tmpl

    async def update(self, tmpl: PromptTemplate, **kwargs) -> PromptTemplate:
        for key, value in kwargs.items():
            setattr(tmpl, key, value)
        self.session.add(tmpl)
        await self.session.flush()
        return tmpl

    async def delete(self, tmpl: PromptTemplate) -> None:
        await self.session.delete(tmpl)
        await self.session.flush()
