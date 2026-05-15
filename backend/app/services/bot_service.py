"""Bot 业务逻辑层."""
from __future__ import annotations

import json
import re
from typing import Literal, cast

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import BadRequestError, ForbiddenError, NotFoundError
from app.db.models import BotAccount, User
from app.features.bot_runtime.builtin_ids import BUILTIN_BOT_IDS
from app.repositories.bot_repo import AIModelRepository, BotRepository, PromptTemplateRepository
from app.utils.permissions import can_access, get_friend_ids

_USERNAME_RE = re.compile(r"^[a-zA-Z0-9_\-'\u4e00-\u9fff]+$")
_BUILTIN_BOT_IDS = set(BUILTIN_BOT_IDS)
BOT_SCOPES = {"private", "friend", "everyone"}
BotScope = Literal["private", "friend", "everyone"]


def is_builtin_bot(bot: BotAccount) -> bool:
    return bot.bot_id in _BUILTIN_BOT_IDS


def normalize_bot_scope(scope: str | None) -> BotScope:
    """Return a valid bot scope; new Bot code treats scope as the source of truth."""
    if scope in BOT_SCOPES:
        return cast(BotScope, scope)
    return "friend"


def bot_scope(bot: BotAccount) -> BotScope:
    return normalize_bot_scope(getattr(bot, "scope", None))


def can_manage_bot(bot: BotAccount, current_user: User) -> bool:
    from app.utils.permissions import is_admin

    return bot.created_by == current_user.user_id or is_admin(current_user)


def can_use_bot_with_friends(
    bot: BotAccount,
    current_user: User,
    friend_ids: set[str],
) -> bool:
    if is_builtin_bot(bot) or can_manage_bot(bot, current_user):
        return True
    scope = bot_scope(bot)
    if scope == "everyone":
        return True
    if scope == "friend" and bot.created_by:
        return bot.created_by in friend_ids
    return False


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
        """返回当前用户可发起 DM/邀请的 bot。"""
        all_bots = await self.repo.list_all()
        if current_user.role == "system_admin":
            return all_bots
        friend_ids = await get_friend_ids(self.session, current_user.user_id)
        return [
            b for b in all_bots
            if can_use_bot_with_friends(b, current_user, friend_ids)
        ]

    async def list_all(self) -> list[BotAccount]:
        return await self.repo.list_all()

    async def can_use(self, bot: BotAccount, current_user: User) -> bool:
        if can_manage_bot(bot, current_user) or is_builtin_bot(bot):
            return True
        friend_ids = await get_friend_ids(self.session, current_user.user_id)
        return can_use_bot_with_friends(bot, current_user, friend_ids)

    async def assert_can_use(
        self,
        bot: BotAccount,
        current_user: User,
        message: str = "无权使用该 Bot",
    ) -> None:
        if not await self.can_use(bot, current_user):
            raise ForbiddenError(message)

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

    async def _validate_template(self, template_id: str) -> None:
        template = await self.template_repo.get_by_id(template_id)
        if not template:
            raise BadRequestError("指定的提示词模板不存在")

    async def create(
        self,
        username: str,
        display_name: str | None,
        description: str | None,
        model_id: str | None,
        template_id: str | None,
        *,
        custom_system_prompt: str | None = None,
        intro: str | None = None,
        avatar_url: str | None = None,
        scope: str | None = None,
        bot_id: str | None = None,
        binding_type: str = "http",
        bridge_provider: str | None = None,
        binding_config: dict | None = None,
        current_user: User,
    ) -> tuple[BotAccount, str | None]:
        """创建 Bot。

        Returns:
            (bot, plaintext_token)
            - HTTP Bot：token 为 None
            - Agent Bridge Bot：生成一次性明文 token，返回给调用者转发给用户；
              此后只保留哈希
        """
        username = _validate_username(username)
        intro = _validate_intro(intro)
        scope = normalize_bot_scope(scope)

        existing = await self.repo.get_by_username(username)
        if existing:
            raise BadRequestError(f"用户名 '{username}' 已被占用")

        plaintext_token: str | None = None

        if binding_type == "http":
            if not model_id or not template_id:
                raise BadRequestError("HTTP Bot 必须指定 model_id 与 template_id")
            await self._validate_model_and_template(model_id, template_id, current_user)
        elif binding_type == "agent_bridge":
            # Agent Bridge bots are powered by external providers and do not depend on an AIModel.
            # They can still use PromptTemplate to render task text sent to the plugin.
            model_id = None
            if template_id:
                await self._validate_template(template_id)
        else:
            raise BadRequestError(f"未知的 binding_type: {binding_type}")

        bot = BotAccount(
            username=username,
            display_name=display_name,
            description=description,
            model_id=model_id,
            template_id=template_id,
            custom_system_prompt=custom_system_prompt,
            intro=intro,
            avatar_url=avatar_url,
            scope=scope,
            binding_type=binding_type,
            bridge_provider=(bridge_provider or "generic").strip() or "generic",
            binding_config=binding_config,
            created_by=current_user.user_id,
        )
        if bot_id and bot_id.strip():
            bot.bot_id = bot_id.strip()

        if binding_type == "agent_bridge":
            from app.features.agent_bridge.tokens import apply_token_to_bot
            plaintext_token = apply_token_to_bot(bot)

        self.session.add(bot)
        await self.session.flush()
        return bot, plaintext_token

    async def rotate_agent_bridge_token(
        self,
        bot_id: str,
        current_user: User,
    ) -> tuple[BotAccount, str]:
        """为 Agent Bridge Bot 轮换 token。旧 token 立即失效（哈希被覆盖）。

        返回 (bot, plaintext_token)。权限：仅创建者或管理员。
        """
        from app.features.agent_bridge.tokens import apply_token_to_bot

        bot = await self.get_or_404(bot_id)
        if not can_manage_bot(bot, current_user):
            raise ForbiddenError("无权轮换该 Bot 的 token")
        if (bot.binding_type or "http") != "agent_bridge":
            raise BadRequestError("只有 Agent Bridge Bot 才有 token 可轮换")

        plaintext_token = apply_token_to_bot(bot)
        await self.session.flush()
        return bot, plaintext_token

    async def update(
        self,
        bot_id: str,
        current_user: User,
        **kwargs,
    ) -> BotAccount:
        bot = await self.get_or_404(bot_id)
        if not can_manage_bot(bot, current_user):
            raise ForbiddenError("无权修改该 Bot")

        if "scope" in kwargs:
            kwargs["scope"] = normalize_bot_scope(kwargs["scope"])

        if "username" in kwargs and kwargs["username"]:
            kwargs["username"] = _validate_username(kwargs["username"])
            existing = await self.repo.get_by_username(kwargs["username"])
            if existing and existing.bot_id != bot_id:
                raise BadRequestError(f"用户名 '{kwargs['username']}' 已被占用")

        if "intro" in kwargs:
            kwargs["intro"] = _validate_intro(kwargs["intro"])

        model_binding_changed = bool({"model_id", "template_id", "binding_type"} & kwargs.keys())
        next_binding_type = kwargs.get("binding_type", getattr(bot, "binding_type", None) or "http")
        if next_binding_type == "http" and model_binding_changed:
            next_model_id = kwargs.get("model_id", bot.model_id)
            next_template_id = kwargs.get("template_id", bot.template_id)
            if not next_model_id or not next_template_id:
                raise BadRequestError("HTTP Bot 必须指定 model_id 与 template_id")
            await self._validate_model_and_template(
                next_model_id, next_template_id, current_user
            )
        elif next_binding_type == "agent_bridge" and "template_id" in kwargs and kwargs["template_id"]:
            await self._validate_template(kwargs["template_id"])

        return await self.repo.update(bot, **kwargs)

    async def delete(self, bot_id: str, current_user: User) -> None:
        bot = await self.get_or_404(bot_id)
        if is_builtin_bot(bot):
            raise BadRequestError("内置 Bot 不可删除")
        if not can_manage_bot(bot, current_user):
            raise ForbiddenError("无权删除该 Bot")
        await self.repo.delete(bot)
