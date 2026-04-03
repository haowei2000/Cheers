"""Admin 业务逻辑层（AIModel / PromptTemplate / 系统设置）."""
from __future__ import annotations

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import BadRequestError, ConflictError, NotFoundError
from app.db.models import AIModel, PromptTemplate
from app.repositories.bot_repo import AIModelRepository, PromptTemplateRepository


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

    async def create(
        self,
        name: str,
        provider: str,
        model_name: str,
        base_url: str,
        api_key: str | None = None,
        description: str | None = None,
        is_public: bool = True,
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
            is_public=is_public,
            config=config or {},
            created_by=created_by,
        )

    async def update(self, model_id: str, **kwargs) -> AIModel:
        model = await self.get_or_404(model_id)
        if model.is_builtin:
            raise BadRequestError("内置模型不可修改")
        return await self.repo.update(model, **kwargs)

    async def delete(self, model_id: str) -> None:
        model = await self.get_or_404(model_id)
        if model.is_builtin:
            raise BadRequestError("内置模型不可删除")
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

    async def create(
        self,
        name: str,
        system_prompt: str,
        user_template: str = "{{message}}",
        description: str | None = None,
        variables: list | None = None,
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
        )

    async def update(self, template_id: str, **kwargs) -> PromptTemplate:
        tmpl = await self.get_or_404(template_id)
        if tmpl.is_builtin:
            raise BadRequestError("内置模板不可修改")
        return await self.repo.update(tmpl, **kwargs)

    async def delete(self, template_id: str) -> None:
        tmpl = await self.get_or_404(template_id)
        if tmpl.is_builtin:
            raise BadRequestError("内置模板不可删除")
        await self.repo.delete(tmpl)
