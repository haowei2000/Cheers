"""Admin service module."""
from __future__ import annotations

from typing import Literal, cast

from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import BadRequestError, ConflictError, ForbiddenError, NotFoundError
from app.core.prompt_templates import DEFAULT_USER_TEMPLATE
from app.db.models import AIModel, BotAccount, ChannelMembership, PromptTemplate, User
from app.repositories.bot_repo import AIModelRepository, PromptTemplateRepository
from app.utils.permissions import get_friend_ids, is_admin

TEMPLATE_SCOPES = {"private", "friend", "everyone"}
TemplateScope = Literal["private", "friend", "everyone"]


def normalize_template_scope(scope: str | None) -> TemplateScope:
    if scope in TEMPLATE_SCOPES:
        return cast(TemplateScope, scope)
    return "friend"


def template_scope(template: PromptTemplate) -> TemplateScope:
    return normalize_template_scope(getattr(template, "scope", None))


def can_manage_template(template: PromptTemplate, current_user: User) -> bool:
    if template.is_builtin:
        return False
    return template.created_by == current_user.user_id or is_admin(current_user)


def can_use_template_with_friends(
    template: PromptTemplate,
    current_user: User,
    friend_ids: set[str],
) -> bool:
    if template.is_builtin or template.created_by is None or can_manage_template(template, current_user):
        return True
    scope = template_scope(template)
    if scope == "everyone":
        return True
    if scope == "friend" and template.created_by:
        return template.created_by in friend_ids
    return False


class AIModelService:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session
        self.repo = AIModelRepository(session)

    async def get_or_404(self, model_id: str) -> AIModel:
        model = await self.repo.get_by_id(model_id)
        if not model:
            raise NotFoundError("model not found")
        return model

    async def list_all(self) -> list[AIModel]:
        return await self.repo.list_all()

    async def list_visible(self, user: User) -> list[AIModel]:
        return await self.repo.list_visible(user.user_id)

    def _can_view(self, model: AIModel, user: User) -> bool:
        return model.is_builtin or model.created_by is None or model.created_by == user.user_id

    def _check_can_manage(self, model: AIModel, user: User) -> None:
        if model.is_builtin:
            raise BadRequestError("内置模型不可修改")
        if model.created_by == user.user_id:
            return
        if model.created_by is None and is_admin(user):
            return
        raise ForbiddenError("只能修改自己创建的模型")

    async def get_visible_or_404(self, model_id: str, user: User) -> AIModel:
        model = await self.get_or_404(model_id)
        if not self._can_view(model, user):
            raise NotFoundError("model not found")
        return model

    async def create(
        self,
        name: str,
        provider: str,
        model_name: str,
        base_url: str,
        api_key: str | None = None,
        description: str | None = None,
        is_public: bool = False,
        config: dict | None = None,
        created_by: str | None = None,
    ) -> AIModel:
        return await self.repo.create(
            name=name,
            provider=provider,
            model_name=model_name,
            base_url=base_url,
            api_key=api_key,
            description=description,
            is_public=False if created_by else is_public,
            config=config or {},
            created_by=created_by,
        )

    async def update(self, model_id: str, user: User, **kwargs) -> AIModel:
        model = await self.get_or_404(model_id)
        self._check_can_manage(model, user)
        if model.created_by is not None and "is_public" in kwargs:
            kwargs["is_public"] = False
        return await self.repo.update(model, **kwargs)

    async def delete(self, model_id: str, user: User) -> None:
        model = await self.get_or_404(model_id)
        if model.is_builtin:
            raise BadRequestError("内置模型不可删除")
        self._check_can_manage(model, user)
        # Detach bots that reference this model before deleting
        await self.session.execute(
            update(BotAccount).where(BotAccount.model_id == model_id).values(model_id=None)
        )
        await self.repo.delete(model)


class PromptTemplateService:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session
        self.repo = PromptTemplateRepository(session)

    async def get_or_404(self, template_id: str) -> PromptTemplate:
        tmpl = await self.repo.get_by_id(template_id)
        if not tmpl:
            raise NotFoundError("template not found")
        return tmpl

    async def list_all(self) -> list[PromptTemplate]:
        return await self.repo.list_all()

    async def list_visible(self, user: User) -> list[PromptTemplate]:
        """List visible."""
        if is_admin(user):
            return await self.repo.list_all()
        friend_ids = await get_friend_ids(self.session, user.user_id)
        templates = await self.repo.list_all()
        return [
            t for t in templates
            if can_use_template_with_friends(t, user, friend_ids)
        ]

    async def can_use(self, template: PromptTemplate, user: User) -> bool:
        if template.is_builtin or template.created_by is None or can_manage_template(template, user):
            return True
        friend_ids = await get_friend_ids(self.session, user.user_id)
        return can_use_template_with_friends(template, user, friend_ids)

    async def assert_can_use(
        self,
        template: PromptTemplate,
        user: User,
        message: str = "无权使用该提示词模板",
    ) -> None:
        if not await self.can_use(template, user):
            raise ForbiddenError(message)

    async def get_visible_or_404(self, template_id: str, user: User) -> PromptTemplate:
        template = await self.get_or_404(template_id)
        if not await self.can_use(template, user):
            raise NotFoundError("template not found")
        return template

    async def create(
        self,
        name: str,
        system_prompt: str,
        user_template: str = DEFAULT_USER_TEMPLATE,
        description: str | None = None,
        variables: list | None = None,
        scope: str | None = None,
        created_by: str | None = None,
    ) -> PromptTemplate:
        existing = await self.repo.get_by_name(name)
        if existing:
            raise ConflictError(f"模板名称 '{name}' 已存在")
        return await self.repo.create(
            name=name,
            system_prompt=system_prompt,
            user_template=user_template,
            description=description,
            variables=variables or [],
            scope=normalize_template_scope(scope),
            created_by=created_by,
        )

    def _check_owner(self, tmpl: PromptTemplate, user: User) -> None:
        """Check owner."""
        if can_manage_template(tmpl, user):
            return
        raise ForbiddenError("只能修改自己创建的模板")

    async def update(self, template_id: str, user: User | None = None, **kwargs) -> PromptTemplate:
        tmpl = await self.get_or_404(template_id)
        if tmpl.is_builtin:
            raise BadRequestError("内置模板不可修改")
        if user is not None:
            self._check_owner(tmpl, user)
        if "scope" in kwargs:
            kwargs["scope"] = normalize_template_scope(kwargs["scope"])
        return await self.repo.update(tmpl, **kwargs)

    async def delete(self, template_id: str, user: User | None = None) -> None:
        tmpl = await self.get_or_404(template_id)
        if tmpl.is_builtin:
            raise BadRequestError("内置模板不可删除")
        if user is not None:
            self._check_owner(tmpl, user)
        # Detach bots that reference this template before deleting
        await self.session.execute(
            update(BotAccount).where(BotAccount.template_id == template_id).values(template_id=None)
        )
        await self.session.execute(
            update(ChannelMembership).where(ChannelMembership.template_id == template_id).values(template_id=None)
        )
        await self.repo.delete(tmpl)
