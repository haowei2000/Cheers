"""Admin 业务逻辑层（AIModel / PromptTemplate / 系统设置 / 日志分析）."""
from __future__ import annotations

import logging

import httpx
from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import AppError, BadRequestError, ConflictError, ForbiddenError, NotFoundError
from app.db.models import AIModel, BotAccount, PromptTemplate, User
from app.repositories.bot_repo import AIModelRepository, PromptTemplateRepository
from app.services.admin import settings_store
from app.services.admin.log_buffer import get_formatted_log_excerpt

logger = logging.getLogger("app.services.admin")


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
        # Detach bots that reference this model before deleting
        await self.session.execute(
            update(BotAccount).where(BotAccount.model_id == model_id).values(model_id=None)
        )
        await self.repo.delete(model)


class SettingsService:
    """封装 admin.settings_store 的所有设置操作."""

    @staticmethod
    def get_llm_settings() -> dict:
        return {
            "providers": settings_store.get_llm_providers_list(),
            "bindings": settings_store.get_llm_bindings()
        }

    @staticmethod
    def create_llm_provider(**kwargs) -> str:
        return settings_store.create_llm_provider(**kwargs)

    @staticmethod
    def update_llm_provider(provider_id: str, **kwargs) -> bool:
        return settings_store.update_llm_provider(provider_id, **kwargs)

    @staticmethod
    def delete_llm_provider(provider_id: str) -> bool:
        return settings_store.delete_llm_provider(provider_id)

    @staticmethod
    def set_llm_bindings(**kwargs) -> None:
        settings_store.set_llm_bindings(**kwargs)

    @staticmethod
    def get_clarify_settings() -> dict:
        return settings_store.get_clarify_settings()

    @staticmethod
    def set_clarify_settings(**kwargs) -> dict:
        return settings_store.set_clarify_settings(**kwargs)

    @staticmethod
    def get_assist_settings() -> dict:
        return settings_store.get_assist_settings()

    @staticmethod
    def set_assist_settings(**kwargs) -> dict:
        return settings_store.set_assist_settings(**kwargs)

    @staticmethod
    def get_image_gen_settings() -> dict:
        return settings_store.get_image_gen_settings()

    @staticmethod
    def set_image_gen_settings(**kwargs) -> dict:
        return settings_store.set_image_gen_settings(**kwargs)


class LogAnalysisService:
    """封装基于 LLM 的日志分析与 QA 总结逻辑."""

    @staticmethod
    async def analyze_logs(log_excerpt: str | None = None, question: str | None = None) -> str:
        c = settings_store.get_provider_for_scope("log_analyze") or settings_store.get_provider_for_scope("system_llm")
        if not c:
            raise BadRequestError("请先在管理页「LLM 参数」中添加 LLM 设定，并在「功能绑定」中为「日志分析」或「系统 LLM」选择 LLM。")

        base_url = (c.get("base_url") or "").strip()
        api_key = (c.get("api_key") or "").strip()
        model = (c.get("model") or "gpt-4o-mini").strip()

        if not base_url:
            raise BadRequestError("所选 LLM 的 Base URL 为空")

        log_text = (log_excerpt or "").strip() or get_formatted_log_excerpt(level="ERROR", limit=50)
        if not log_text:
            return "暂无错误日志可分析。"

        user_content = f"以下是一段系统错误日志：\n\n{log_text}"
        if question and question.strip():
            user_content += f"\n\n用户问题：{question.strip()}"
        user_content += "\n\n请以运维助手身份分析：可能原因、建议排查步骤（简短分条）。"

        try:
            url = f"{base_url.rstrip('/')}/chat/completions"
            payload = {
                "model": model,
                "messages": [
                    {"role": "system", "content": "你是运维与故障排查助手。根据错误日志给出可能原因和可操作的排查步骤，回答简洁、分条。"},
                    {"role": "user", "content": user_content},
                ],
                "max_tokens": 1500,
            }
            headers = {"Content-Type": "application/json"}
            if api_key:
                headers["Authorization"] = f"Bearer {api_key}"

            async with httpx.AsyncClient(timeout=60.0) as client:
                r = await client.post(url, json=payload, headers=headers)
                r.raise_for_status()
                data = r.json()
                content = (data.get("choices") or [{}])[0].get("message", {}).get("content", "")
                return content.strip() or "无分析结果"
        except httpx.HTTPStatusError as e:
            code = e.response.status_code
            detail = "LLM 返回 503（服务繁忙或模型加载中），请稍后重试。" if code == 503 else f"LLM 请求失败: {code}"
            raise AppError(detail)
        except Exception as e:
            logger.exception("logs/analyze failed: %s", e)
            raise AppError(f"分析失败: {e!s}")

    @staticmethod
    async def summarize_qa(channel_name: str, pairs: list[dict]) -> str:
        if not pairs:
            raise BadRequestError("请至少提供一组问答")

        c = settings_store.get_provider_for_scope("qa_summarize") or settings_store.get_provider_for_scope("system_llm")
        if not c:
            raise BadRequestError("请先在管理页「LLM 参数」中添加 LLM 设定。")

        base_url = (c.get("base_url") or "").strip()
        api_key = (c.get("api_key") or "").strip()
        model = (c.get("model") or "gpt-4o-mini").strip()

        if not base_url:
            raise BadRequestError("所选 LLM 的 Base URL 为空")

        channel_name = channel_name.strip() or "频道"
        lines: list[str] = []
        for idx, item in enumerate(pairs, start=1):
            lines.extend([
                f"## 问答 {idx}",
                f"问题时间: {item.get('question_time') or '-'}",
                f"回答时间: {item.get('answer_time') or '-'}",
                "", "### 问题", (item.get('question') or "").strip() or "-",
                "", "### 回答", (item.get('answer') or "").strip() or "-", "",
            ])
        qa_text = "\n".join(lines)

        prompt = (
            f"频道：{channel_name}\n共有 {len(pairs)} 组问答。\n\n"
            "请根据以下问答整理一份详细且结构化的 Markdown 文档，需包含：\n"
            "1) 背景与目标\n2) 关键问题与结论\n3) 详细步骤/方法\n4) 注意事项与风险\n5) 后续建议\n\n"
            f"问答原文：\n\n{qa_text}"
        )

        try:
            url = f"{base_url.rstrip('/')}/chat/completions"
            payload = {
                "model": model,
                "messages": [
                    {"role": "system", "content": "你是资深技术文档整理助手，擅长将问答记录整理为清晰、完整、可执行的 Markdown 文档。"},
                    {"role": "user", "content": prompt},
                ],
                "max_tokens": 2000,
            }
            headers = {"Content-Type": "application/json"}
            if api_key:
                headers["Authorization"] = f"Bearer {api_key}"

            async with httpx.AsyncClient(timeout=90.0) as client:
                r = await client.post(url, json=payload, headers=headers)
                r.raise_for_status()
                data = r.json()
                content = (data.get("choices") or [{}])[0].get("message", {}).get("content", "")
                return content.strip() or "无总结结果"
        except httpx.HTTPStatusError as e:
            code = e.response.status_code
            raise AppError(f"LLM 请求失败: {code}")
        except Exception as e:
            logger.exception("qa/summarize failed: %s", e)
            raise AppError(f"总结失败: {e!s}")


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
        """返回用户可见的模板：内置 + 无主（管理员创建）+ 自己创建的。"""
        from sqlalchemy import or_
        from sqlalchemy import select as sa_select

        from app.utils.permissions import is_admin
        if is_admin(user):
            return await self.repo.list_all()
        result = await self.session.execute(
            sa_select(PromptTemplate)
            .where(
                or_(
                    PromptTemplate.is_builtin.is_(True),
                    PromptTemplate.created_by.is_(None),
                    PromptTemplate.created_by == user.user_id,
                )
            )
            .order_by(PromptTemplate.created_at)
        )
        return list(result.scalars().all())

    async def create(
        self,
        name: str,
        system_prompt: str,
        user_template: str = "{{message}}",
        description: str | None = None,
        variables: list | None = None,
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
            created_by=created_by,
        )

    def _check_owner(self, tmpl: PromptTemplate, user: User) -> None:
        """检查用户是否有权修改该模板。"""
        from app.utils.permissions import is_admin
        if is_admin(user):
            return
        if tmpl.created_by != user.user_id:
            raise ForbiddenError("只能修改自己创建的模板")

    async def update(self, template_id: str, user: User | None = None, **kwargs) -> PromptTemplate:
        tmpl = await self.get_or_404(template_id)
        if tmpl.is_builtin:
            raise BadRequestError("内置模板不可修改")
        if user is not None:
            self._check_owner(tmpl, user)
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
        await self.repo.delete(tmpl)
