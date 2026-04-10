"""Bot 业务逻辑层."""
from __future__ import annotations

import json
import re

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import BadRequestError, ForbiddenError, NotFoundError
from app.db.models import BotAccount, User
from app.repositories.bot_repo import AIModelRepository, BotRepository, PromptTemplateRepository
from app.utils.permissions import can_access, get_friend_ids

_USERNAME_RE = re.compile(r"^[a-zA-Z0-9_\-'\u4e00-\u9fff]+$")


def _validate_username(username: str) -> str:
    username = (username or "").strip()
    if not username:
        raise BadRequestError("用户名不能为空")
    if not _USERNAME_RE.match(username):
        raise BadRequestError("用户名只能包含字母、数字、下划线、连字符、单引号和中文")
    return username


def _validate_intro(intro: str | None) -> str | None:
    if not intro or not intro.strip():
        return None
    s = intro.strip()
    try:
        obj = json.loads(s)
        if not isinstance(obj, dict):
            raise BadRequestError("intro 须为 JSON 对象")
        if "capabilities" not in obj and "description" not in obj:
            raise BadRequestError("intro 须包含 capabilities 或 description")
        return json.dumps(obj, ensure_ascii=False)
    except json.JSONDecodeError as e:
        raise BadRequestError(f"intro 须为合法 JSON: {e}")


class BotService:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session
        self.repo = BotRepository(session)
        self.model_repo = AIModelRepository(session)
        self.template_repo = PromptTemplateRepository(session)

    async def get_or_404(self, bot_id: str) -> BotAccount:
        bot = await self.repo.get_by_id(bot_id)
        if not bot:
            raise NotFoundError("bot not found")
        return bot

    async def list_visible(self, current_user: User) -> list[BotAccount]:
        """返回当前用户可见的 bot：自己创建 + 好友公开的."""
        all_bots = await self.repo.list_all()
        friend_ids = await get_friend_ids(self.session, current_user.user_id)
        return [
            b for b in all_bots
            if b.created_by == current_user.user_id
            or (b.is_public and b.created_by in friend_ids)
        ]

    async def list_all(self) -> list[BotAccount]:
        return await self.repo.list_all()

    async def _validate_model_and_template(
        self,
        model_id: str,
        template_id: str,
        current_user: User,
    ) -> tuple:
        model = await self.model_repo.get_by_id(model_id)
        if not model or not model.is_enabled:
            raise BadRequestError("指定的模型不存在或已禁用")
        if not await can_access(self.session, current_user, model.created_by, model.is_public):
            raise ForbiddenError("无权使用该模型")
        template = await self.template_repo.get_by_id(template_id)
        if not template:
            raise BadRequestError("指定的提示词模板不存在")
        return model, template

    async def create(
        self,
        username: str,
        display_name: str | None,
        description: str | None,
        model_id: str,
        template_id: str,
        *,
        custom_system_prompt: str | None = None,
        intro: str | None = None,
        is_public: bool = True,
        bot_id: str | None = None,
        current_user: User,
    ) -> BotAccount:
        username = _validate_username(username)
        intro = _validate_intro(intro)

        existing = await self.repo.get_by_username(username)
        if existing:
            raise BadRequestError(f"用户名 '{username}' 已被占用")

        await self._validate_model_and_template(model_id, template_id, current_user)

        # api_key 由 model 管理，这里不再重复存储

        bot = BotAccount(
            username=username,
            display_name=display_name,
            description=description,
            model_id=model_id,
            template_id=template_id,
            custom_system_prompt=custom_system_prompt,
            intro=intro,
            is_public=is_public,
            created_by=current_user.user_id,
        )
        if bot_id and bot_id.strip():
            bot.bot_id = bot_id.strip()
        self.session.add(bot)
        await self.session.flush()
        return bot

    async def update(
        self,
        bot_id: str,
        current_user: User,
        **kwargs,
    ) -> BotAccount:
        bot = await self.get_or_404(bot_id)
        from app.utils.permissions import is_admin
        if bot.created_by != current_user.user_id and not is_admin(current_user):
            raise ForbiddenError("无权修改该 Bot")

        if "username" in kwargs and kwargs["username"]:
            kwargs["username"] = _validate_username(kwargs["username"])
            existing = await self.repo.get_by_username(kwargs["username"])
            if existing and existing.bot_id != bot_id:
                raise BadRequestError(f"用户名 '{kwargs['username']}' 已被占用")

        if "intro" in kwargs:
            kwargs["intro"] = _validate_intro(kwargs["intro"])

        if "model_id" in kwargs and "template_id" in kwargs:
            await self._validate_model_and_template(
                kwargs["model_id"], kwargs["template_id"], current_user
            )

        return await self.repo.update(bot, **kwargs)

    async def delete(self, bot_id: str, current_user: User) -> None:
        bot = await self.get_or_404(bot_id)
        from app.utils.permissions import is_admin
        if bot.created_by != current_user.user_id and not is_admin(current_user):
            raise ForbiddenError("无权删除该 Bot")
        await self.repo.delete(bot)
