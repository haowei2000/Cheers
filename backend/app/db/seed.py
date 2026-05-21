"""Seed data for workspaces, prompt templates, Bots, and the administrator."""
import asyncio
import json

from sqlalchemy import delete, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.core.builtin_defaults import (
    RETIRED_BUILTIN_TEMPLATE_IDS,
    TEMPLATE_GENERAL_ID,
    builtin_prompt_templates,
    coordinator_bot_defaults,
    seed_workspace_defaults,
)
from app.core.localization import localized, normalize_locale
from app.db.models import (
    BotAccount,
    Channel,
    ChannelMembership,
    PromptTemplate,
    User,
    Workspace,
    WorkspaceMembership,
)
from app.db.session import async_session_factory
from app.features.agent_bridge.tokens import token_prefix_of
from app.features.bot_runtime.builtin_ids import (
    HELPER_BOT_ID,
    OPENCODE_BOT_ID,
    configured_builtin_bot_ids,
)
from app.services.auth.password_utils import hash_password, verify_password

# Stable IDs make documentation and scripts easier to reference.
WORKSPACE_ID = "ws-default-001"
CHANNEL_ID = "ch-seed-001"
ADMIN_USER_ID = "admin-0000-0000-0000-000000000001"

REMOVED_SEEDED_BOT_IDS = (
    "bot-guide-001",
    "bot-guide-helper-001",
    "bot-test-001",
    "bot-test-helper-001",
)
REMOVED_SEEDED_BOT_NAMES = (
    "testbot",
    "test-bot",
    "TestBot",
    "Test Bot",
    "测试Bot",
    "测试 Bot",
    "测试机器人",
    "测试助手",
)
INSECURE_ADMIN_PASSWORDS = {
    "",
    "admin",
    "password",
    "123456",
    "12345678",
    "change-me",
    "change-me-admin-password",
    "admin#Nexus2024",
}
BOT_TOKEN_PREFIX = "agb_"


def _validate_seed_admin_password() -> None:
    """Reject empty or sample administrator passwords before creating seed data."""
    candidate = (settings.admin_password or "").strip()
    if candidate in INSECURE_ADMIN_PASSWORDS:
        raise RuntimeError(
            "ADMIN_PASSWORD must be set to a real, non-default password when SEED_DATA=1. "
            "Update .env before starting AgentNexus in any shared or public environment."
        )


def _seed_locale() -> str:
    return normalize_locale(settings.app_default_locale)


def _assign_if_changed(obj, field: str, value) -> bool:
    if getattr(obj, field) == value:
        return False
    setattr(obj, field, value)
    return True


def _configured_admin_display_name(locale: str) -> str:
    if settings.admin_display_name in {"System Administrator", "系统管理员"}:
        return seed_workspace_defaults(locale)["admin_display_name"]
    return settings.admin_display_name


async def _template_name_available(session: AsyncSession, template_id: str, name: str) -> bool:
    existing = (
        await session.execute(
            select(PromptTemplate).where(
                PromptTemplate.name == name,
                PromptTemplate.template_id != template_id,
            )
        )
    ).scalar_one_or_none()
    return existing is None


async def _remove_retired_builtin_templates(session: AsyncSession) -> bool:
    """Remove built-in templates that are no longer part of the default set."""
    if not RETIRED_BUILTIN_TEMPLATE_IDS:
        return False

    did_write = False
    result = await session.execute(
        update(BotAccount)
        .where(BotAccount.template_id.in_(RETIRED_BUILTIN_TEMPLATE_IDS))
        .values(template_id=TEMPLATE_GENERAL_ID)
    )
    did_write = did_write or bool(getattr(result, "rowcount", 0))
    result = await session.execute(
        update(ChannelMembership)
        .where(ChannelMembership.template_id.in_(RETIRED_BUILTIN_TEMPLATE_IDS))
        .values(template_id=TEMPLATE_GENERAL_ID)
    )
    did_write = did_write or bool(getattr(result, "rowcount", 0))
    result = await session.execute(
        delete(PromptTemplate).where(
            PromptTemplate.template_id.in_(RETIRED_BUILTIN_TEMPLATE_IDS),
            PromptTemplate.is_builtin.is_(True),
        )
    )
    did_write = did_write or bool(getattr(result, "rowcount", 0))
    return did_write


async def _remove_removed_seeded_bots(session: AsyncSession) -> bool:
    """Remove stale seeded guide/test bots."""
    did_write = False
    legacy_bot_ids = set(REMOVED_SEEDED_BOT_IDS)
    result = await session.execute(
        select(BotAccount.bot_id).where(
            BotAccount.created_by.is_(None),
            ~BotAccount.bot_id.in_(configured_builtin_bot_ids()),
            or_(
                BotAccount.username.in_(REMOVED_SEEDED_BOT_NAMES),
                BotAccount.display_name.in_(REMOVED_SEEDED_BOT_NAMES),
            ),
        )
    )
    legacy_bot_ids.update(result.scalars().all())
    if not legacy_bot_ids:
        return False
    result = await session.execute(
        delete(ChannelMembership).where(ChannelMembership.member_id.in_(legacy_bot_ids))
    )
    did_write = did_write or bool(getattr(result, "rowcount", 0))
    result = await session.execute(
        delete(BotAccount).where(BotAccount.bot_id.in_(legacy_bot_ids))
    )
    did_write = did_write or bool(getattr(result, "rowcount", 0))
    return did_write


async def _seed_helper_bot(session: AsyncSession) -> bool:
    """Seed helper bot."""
    defaults = coordinator_bot_defaults(_seed_locale())
    r = await session.execute(select(BotAccount).where(BotAccount.bot_id == HELPER_BOT_ID))
    existing = r.scalar_one_or_none()
    if existing is not None:
        did_write = False
        if existing.username in ("引导", "channel bot", "guide-helper", "Helper", "coordinator"):
            existing.username = "Coordinator"
            did_write = True
        did_write |= _assign_if_changed(existing, "display_name", defaults["display_name"])
        did_write |= _assign_if_changed(existing, "description", defaults["description"])
        did_write |= _assign_if_changed(existing, "intro", defaults["intro"])
        did_write |= _assign_if_changed(existing, "scope", "everyone")
        await session.flush()
        return did_write

    session.add(
        BotAccount(
            bot_id=HELPER_BOT_ID,
            username="Coordinator",
            display_name=defaults["display_name"],
            description=defaults["description"],
            model_id=None,
            template_id=None,
            status="online",
            scope="everyone",
            intro=defaults["intro"],
        )
    )
    return True


def _opencode_bot_token() -> str:
    token = (settings.opencode_bot_token or "").strip()
    if not token:
        raise RuntimeError("OPENCODE_BOT_TOKEN must be set when OPENCODE_BOT_ENABLED=true.")
    if not token.startswith(BOT_TOKEN_PREFIX):
        raise RuntimeError("OPENCODE_BOT_TOKEN must start with agb_.")
    return token


def _opencode_bot_intro() -> str:
    return json.dumps(
        {
            "description": settings.opencode_bot_description or "OpenCode ACP coding assistant",
            "capabilities": [
                "OpenCode ACP",
                "AgentNexus Agent Bridge",
                "OpenAI-compatible API",
            ],
        },
        ensure_ascii=False,
    )


def _sync_agent_bridge_token(bot: BotAccount, token: str) -> bool:
    did_write = False
    if not bot.bot_token_hash or not verify_password(token, bot.bot_token_hash):
        bot.bot_token_hash = hash_password(token)
        did_write = True
    prefix = token_prefix_of(token)
    did_write |= _assign_if_changed(bot, "bot_token_prefix", prefix)
    if bot.bot_token_rotated_at is None:
        from datetime import datetime, timezone

        bot.bot_token_rotated_at = datetime.now(timezone.utc)
        did_write = True
    return did_write


async def _seed_opencode_bot(session: AsyncSession) -> bool:
    """Seed the optional Docker Compose managed OpenCode ACP Bot."""
    if not settings.opencode_bot_enabled:
        return False

    token = _opencode_bot_token()
    bot_id = (settings.opencode_bot_id or OPENCODE_BOT_ID).strip() or OPENCODE_BOT_ID
    username = (settings.opencode_bot_username or "opencode").strip() or "opencode"
    display_name = (settings.opencode_bot_display_name or "OpenCode").strip() or "OpenCode"
    description = (
        (settings.opencode_bot_description or "").strip()
        or "OpenCode ACP coding assistant"
    )
    scope = (
        settings.opencode_bot_scope
        if settings.opencode_bot_scope in {"private", "friend", "everyone"}
        else "everyone"
    )

    r = await session.execute(select(BotAccount).where(BotAccount.bot_id == bot_id))
    existing = r.scalar_one_or_none()
    if existing is None:
        r = await session.execute(select(BotAccount).where(BotAccount.username == username))
        username_owner = r.scalar_one_or_none()
        if username_owner is not None:
            raise RuntimeError(
                f"OPENCODE_BOT_USERNAME={username!r} is already used by Bot {username_owner.bot_id}; "
                "set OPENCODE_BOT_USERNAME to a unique value."
            )
        existing = BotAccount(
            bot_id=bot_id,
            username=username,
            display_name=display_name,
            description=description,
            model_id=None,
            template_id=None,
            status="online",
            scope=scope,
            intro=_opencode_bot_intro(),
            binding_type="agent_bridge",
            bridge_provider="acp",
            binding_config={
                "agent_id": username,
                "bridge_provider": "acp",
                "managed_by": "docker_compose_opencode_bot",
            },
        )
        _sync_agent_bridge_token(existing, token)
        session.add(existing)
        return True

    did_write = False
    if existing.username != username:
        r = await session.execute(select(BotAccount).where(BotAccount.username == username))
        username_owner = r.scalar_one_or_none()
        if username_owner is not None and username_owner.bot_id != existing.bot_id:
            raise RuntimeError(
                f"OPENCODE_BOT_USERNAME={username!r} is already used by Bot {username_owner.bot_id}; "
                "set OPENCODE_BOT_USERNAME to a unique value."
            )
    did_write |= _assign_if_changed(existing, "username", username)
    did_write |= _assign_if_changed(existing, "display_name", display_name)
    did_write |= _assign_if_changed(existing, "description", description)
    did_write |= _assign_if_changed(existing, "model_id", None)
    did_write |= _assign_if_changed(existing, "template_id", None)
    did_write |= _assign_if_changed(existing, "status", "online")
    did_write |= _assign_if_changed(existing, "scope", scope)
    did_write |= _assign_if_changed(existing, "intro", _opencode_bot_intro())
    did_write |= _assign_if_changed(existing, "binding_type", "agent_bridge")
    did_write |= _assign_if_changed(existing, "bridge_provider", "acp")
    binding_config = dict(existing.binding_config or {})
    binding_config.setdefault("agent_id", username)
    binding_config.setdefault("bridge_provider", "acp")
    binding_config["managed_by"] = "docker_compose_opencode_bot"
    did_write |= _assign_if_changed(existing, "binding_config", binding_config)
    did_write |= _sync_agent_bridge_token(existing, token)
    await session.flush()
    return did_write


async def _seed_templates(session: AsyncSession) -> bool:
    """Seed templates."""
    did_write = False

    for template_text in builtin_prompt_templates(_seed_locale()):
        r = await session.execute(select(PromptTemplate).where(PromptTemplate.template_id == template_text.template_id))
        template = r.scalar_one_or_none()
        if template is None:
            name = template_text.name
            if not await _template_name_available(session, template_text.template_id, name):
                name = f"{template_text.name} (built-in)"
            session.add(
                PromptTemplate(
                    template_id=template_text.template_id,
                    name=name,
                    description=template_text.description,
                    system_prompt=template_text.system_prompt,
                    user_template=template_text.user_template,
                    variables=template_text.variables,
                    is_builtin=True,
                    scope="everyone",
                )
            )
            did_write = True
            continue
        if template.is_builtin:
            did_write |= _assign_if_changed(template, "scope", "everyone")
            if await _template_name_available(session, template.template_id, template_text.name):
                did_write |= _assign_if_changed(template, "name", template_text.name)
            did_write |= _assign_if_changed(template, "description", template_text.description)
            did_write |= _assign_if_changed(template, "system_prompt", template_text.system_prompt)
            did_write |= _assign_if_changed(template, "user_template", template_text.user_template)
            did_write |= _assign_if_changed(template, "variables", template_text.variables)

    return did_write


async def _seed_workspace_and_users(session: AsyncSession) -> bool:
    """Seed workspace and users."""
    _validate_seed_admin_password()
    did_write = False
    locale = _seed_locale()
    defaults = seed_workspace_defaults(locale)

    r = await session.execute(select(Workspace).where(Workspace.workspace_id == WORKSPACE_ID))
    workspace = r.scalar_one_or_none()
    if workspace is None:
        session.add(Workspace(workspace_id=WORKSPACE_ID, name=defaults["workspace_name"]))
        did_write = True
    elif workspace.name in {"默认空间", "Default", "Default Workspace"}:
        did_write |= _assign_if_changed(workspace, "name", defaults["workspace_name"])

    r = await session.execute(select(Channel).where(Channel.channel_id == CHANNEL_ID))
    channel = r.scalar_one_or_none()
    if channel is None:
        session.add(
            Channel(
                channel_id=CHANNEL_ID,
                workspace_id=WORKSPACE_ID,
                name=defaults["channel_name"],
                type="public",
                purpose=defaults["channel_purpose"],
            )
        )
        did_write = True
    else:
        if channel.name in {"通用", "General"}:
            did_write |= _assign_if_changed(channel, "name", defaults["channel_name"])
        if channel.purpose in {"默认频道", "Default channel"}:
            did_write |= _assign_if_changed(channel, "purpose", defaults["channel_purpose"])

    r = await session.execute(select(User).where(User.user_id == ADMIN_USER_ID))
    existing_admin = r.scalar_one_or_none()
    admin_display_name = _configured_admin_display_name(locale)
    if existing_admin is None:
        session.add(
            User(
                user_id=ADMIN_USER_ID,
                username=settings.admin_username,
                password_hash=hash_password(settings.admin_password),
                display_name=admin_display_name,
                role="system_admin",
            )
        )
        did_write = True
    else:
        did_write |= _assign_if_changed(existing_admin, "username", settings.admin_username)
        did_write |= _assign_if_changed(existing_admin, "display_name", admin_display_name)
        if not verify_password(settings.admin_password, existing_admin.password_hash):
            existing_admin.password_hash = hash_password(settings.admin_password)
            did_write = True

    r = await session.execute(
        select(WorkspaceMembership).where(
            WorkspaceMembership.workspace_id == WORKSPACE_ID,
            WorkspaceMembership.user_id == ADMIN_USER_ID,
        )
    )
    if r.scalar_one_or_none() is None:
        session.add(WorkspaceMembership(
            workspace_id=WORKSPACE_ID,
            user_id=ADMIN_USER_ID,
            role="owner",
        ))
        did_write = True

    return did_write


async def _seed_memberships(session: AsyncSession) -> bool:
    """Create channel memberships for built-in bots and the administrator."""
    did_write = False

    # The session uses autoflush=False, so flush once manually.
    # This makes previously added memberships visible to later SELECT statements.
    # Otherwise duplicate inserts in the same transaction can trigger UniqueViolation and roll back the seed.
    await session.flush()

    default_members = [(bot_id, "bot") for bot_id in configured_builtin_bot_ids()] + [(ADMIN_USER_ID, "user")]
    for member_id, member_type in default_members:
        r = await session.execute(
            select(ChannelMembership).where(
                ChannelMembership.channel_id == CHANNEL_ID,
                ChannelMembership.member_id == member_id,
            )
        )
        if r.scalar_one_or_none() is None:
            session.add(
                ChannelMembership(
                    channel_id=CHANNEL_ID,
                    member_id=member_id,
                    member_type=member_type,
                )
            )
            did_write = True

    return did_write


def _dm_name_members(channel_name: str | None) -> set[str]:
    """Dm name members."""
    if not channel_name:
        return set()
    if channel_name.startswith("dmchat:"):
        return {part for part in channel_name.split(":")[1:3] if part}
    if not channel_name.startswith("dm:"):
        return set()
    return {part for part in channel_name.split(":")[1:] if part}


async def _ensure_builtin_bot_memberships(session: AsyncSession) -> None:
    """Ensure builtin bot memberships."""
    await session.flush()

    dm_builtin_rows = (
        await session.execute(
            select(ChannelMembership, Channel)
            .join(Channel, Channel.channel_id == ChannelMembership.channel_id)
            .where(
                Channel.type == "dm",
                ChannelMembership.member_type == "bot",
                ChannelMembership.member_id.in_(configured_builtin_bot_ids()),
            )
        )
    ).all()
    for membership, channel in dm_builtin_rows:
        # Keep one-to-one bot DMs explicitly created by users, such as user <-> Coordinator.
        # Only remove built-in bots that were automatically injected into other DMs.
        if membership.member_id not in _dm_name_members(channel.name):
            await session.delete(membership)

    workspace_channel_ids = (
        await session.execute(
            select(Channel.channel_id).where(Channel.type.in_(("public", "workspace")))
        )
    ).scalars().all()
    for channel_id in workspace_channel_ids:
        for bot_id in configured_builtin_bot_ids():
            existing = (
                await session.execute(
                    select(ChannelMembership).where(
                        ChannelMembership.channel_id == channel_id,
                        ChannelMembership.member_id == bot_id,
                    )
                )
            ).scalar_one_or_none()
            if existing is None:
                session.add(
                    ChannelMembership(
                        channel_id=channel_id,
                        member_id=bot_id,
                        member_type="bot",
                    )
                )


async def seed(session: AsyncSession) -> bool:
    """Seed."""
    did_write = False

    did_write |= await _seed_templates(session)
    did_write |= await _remove_retired_builtin_templates(session)
    did_write |= await _remove_removed_seeded_bots(session)
    did_write |= await _seed_helper_bot(session)
    did_write |= await _seed_opencode_bot(session)
    did_write |= await _seed_workspace_and_users(session)
    did_write |= await _seed_memberships(session)

    return did_write


async def run_seed() -> None:
    """Run seed."""
    async with async_session_factory() as session:
        try:
            await seed(session)
            await session.commit()
        except Exception:
            await session.rollback()
            raise


async def _sync_admin_credentials(session: AsyncSession) -> None:
    """Sync admin credentials."""
    r = await session.execute(select(User).where(User.user_id == ADMIN_USER_ID))
    admin = r.scalar_one_or_none()
    if admin is None:
        return
    locale = _seed_locale()
    if not (settings.admin_password or "").strip():
        admin.username = settings.admin_username
        admin.display_name = _configured_admin_display_name(locale)
        return
    _validate_seed_admin_password()
    admin.username = settings.admin_username
    admin.display_name = _configured_admin_display_name(locale)
    if not verify_password(settings.admin_password, admin.password_hash):
        admin.password_hash = hash_password(settings.admin_password)


async def ensure_builtin_bot() -> None:
    """Ensure builtin bot."""
    async with async_session_factory() as session:
        try:
            await _seed_templates(session)
            await _remove_retired_builtin_templates(session)
            await _remove_removed_seeded_bots(session)
            await _seed_helper_bot(session)
            await _seed_opencode_bot(session)
            await _sync_admin_credentials(session)

            # Only backfill built-in bots into regular channels; DMs do not automatically receive Coordinator.
            await _ensure_builtin_bot_memberships(session)

            await session.commit()
        except Exception:
            await session.rollback()
            raise


if __name__ == "__main__":
    asyncio.run(run_seed())
    print(
        "Seed done.\n"
        f"  Workspace: {WORKSPACE_ID}\n"
        f"  Channel: {CHANNEL_ID}\n"
        f"  Templates: {', '.join(t.name for t in builtin_prompt_templates(_seed_locale()))}\n"
        f"  Bots: @Coordinator ({localized(_seed_locale(), en='built-in collaboration assistant', zh='内置协作助手')})"
    )
