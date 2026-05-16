"""Seed data for workspaces, prompt templates, Bots, and test users."""
import asyncio

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.core.prompt_templates import DEFAULT_TEMPLATE_VARIABLES, DEFAULT_USER_TEMPLATE
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
from app.features.bot_runtime.builtin_ids import BUILTIN_BOT_IDS, HELPER_BOT_ID
from app.services.auth.password_utils import hash_password, verify_password

# Stable IDs make documentation and scripts easier to reference.
WORKSPACE_ID = "ws-default-001"
CHANNEL_ID = "ch-seed-001"
ADMIN_USER_ID = "admin-0000-0000-0000-000000000001"

TEMPLATE_GENERAL_ID = "template-general-001"
TEMPLATE_CODE_REVIEW_ID = "template-codereview-001"
TEMPLATE_CREATIVE_ID = "template-creative-001"
REMOVED_HELP_BOT_IDS = ("bot-guide-001", "bot-guide-helper-001")


async def _remove_removed_help_bots(session: AsyncSession) -> bool:
    """Remove removed help bots."""
    did_write = False
    result = await session.execute(
        delete(ChannelMembership).where(ChannelMembership.member_id.in_(REMOVED_HELP_BOT_IDS))
    )
    did_write = did_write or bool(getattr(result, "rowcount", 0))
    result = await session.execute(
        delete(BotAccount).where(BotAccount.bot_id.in_(REMOVED_HELP_BOT_IDS))
    )
    did_write = did_write or bool(getattr(result, "rowcount", 0))
    return did_write


async def _seed_helper_bot(session: AsyncSession) -> bool:
    """Seed helper bot."""
    r = await session.execute(select(BotAccount).where(BotAccount.bot_id == HELPER_BOT_ID))
    existing = r.scalar_one_or_none()
    if existing is not None:
        if existing.username in ("引导", "channel bot", "guide-helper", "Helper", "coordinator"):
            existing.username = "Coordinator"
        existing.display_name = "协作助手"
        existing.scope = "everyone"
        await session.flush()
        return False

    session.add(
        BotAccount(
            bot_id=HELPER_BOT_ID,
            username="Coordinator",
            display_name="协作助手",
            description=(
                "系统内置协作助手（Coordinator），集使用帮助、项目助手、记忆管理三合一。"
                "可回答系统使用问题、结合项目记忆回答业务问题、"
                "读写四层项目记忆、并在需要时建议路由到专业 Bot。"
            ),
            model_id=None,
            template_id=None,
            status="online",
            scope="everyone",
            intro=(
                '{"capabilities":["系统帮助","项目问答","记忆读写","澄清弹窗","Bot路由建议"],'
                '"description":"内置协作助手，@Coordinator 即可使用"}'
            ),
        )
    )
    return True


async def _seed_templates(session: AsyncSession) -> bool:
    """Seed templates."""
    did_write = False

    r = await session.execute(select(PromptTemplate).where(PromptTemplate.template_id == TEMPLATE_GENERAL_ID))
    general_template = r.scalar_one_or_none()
    if general_template is None:
        session.add(
            PromptTemplate(
                template_id=TEMPLATE_GENERAL_ID,
                name="通用助手",
                description="通用的 AI 助手，适合回答各种问题",
                system_prompt="你是一个有用的 AI 助手。请简洁、专业地回答用户问题。",
                user_template=DEFAULT_USER_TEMPLATE,
                variables=DEFAULT_TEMPLATE_VARIABLES,
                is_builtin=True,
            )
        )
        did_write = True
    elif general_template.is_builtin and general_template.user_template == "{{message}}":
        general_template.user_template = DEFAULT_USER_TEMPLATE
        general_template.variables = DEFAULT_TEMPLATE_VARIABLES
        did_write = True

    r = await session.execute(select(PromptTemplate).where(PromptTemplate.template_id == TEMPLATE_CODE_REVIEW_ID))
    if r.scalar_one_or_none() is None:
        session.add(
            PromptTemplate(
                template_id=TEMPLATE_CODE_REVIEW_ID,
                name="代码审查",
                description="专业的代码审查助手，发现潜在问题和优化点",
                system_prompt="""你是一个专业的代码审查助手。请审查用户提供的代码，关注以下方面：
1. 潜在的 Bug 和错误处理
2. 代码风格和可读性
3. 性能优化建议
4. 安全漏洞
5. 最佳实践

请用中文回复，使用 Markdown 格式，结构清晰。""",
                user_template="请审查以下代码：\n\n```\n{{message}}\n```\n\n请给出详细的审查意见，包括问题和改进建议。",
                variables=["message"],
                is_builtin=True,
            )
        )
        did_write = True

    r = await session.execute(select(PromptTemplate).where(PromptTemplate.template_id == TEMPLATE_CREATIVE_ID))
    if r.scalar_one_or_none() is None:
        session.add(
            PromptTemplate(
                template_id=TEMPLATE_CREATIVE_ID,
                name="创意写作",
                description="富有创意的写作助手，帮助撰写和润色文字",
                system_prompt="你是一个富有创意的写作助手。请用生动、有趣的语言帮助用户撰写和润色文字。",
                user_template="请帮我完善以下内容：\n\n{{message}}",
                variables=["message"],
                is_builtin=True,
            )
        )
        did_write = True

    return did_write


async def _seed_workspace_and_users(session: AsyncSession) -> bool:
    """Seed workspace and users."""
    did_write = False

    r = await session.execute(select(Workspace).where(Workspace.workspace_id == WORKSPACE_ID))
    if r.scalar_one_or_none() is None:
        session.add(Workspace(workspace_id=WORKSPACE_ID, name="默认空间"))
        did_write = True

    r = await session.execute(select(Channel).where(Channel.channel_id == CHANNEL_ID))
    if r.scalar_one_or_none() is None:
        session.add(
            Channel(
                channel_id=CHANNEL_ID,
                workspace_id=WORKSPACE_ID,
                name="通用",
                type="public",
                purpose="默认频道",
            )
        )
        did_write = True

    r = await session.execute(select(User).where(User.user_id == ADMIN_USER_ID))
    existing_admin = r.scalar_one_or_none()
    if existing_admin is None:
        session.add(
            User(
                user_id=ADMIN_USER_ID,
                username=settings.admin_username,
                password_hash=hash_password(settings.admin_password),
                display_name=settings.admin_display_name,
                role="system_admin",
            )
        )
        did_write = True
    else:
        existing_admin.username = settings.admin_username
        existing_admin.display_name = settings.admin_display_name
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

    default_members = [(bot_id, "bot") for bot_id in BUILTIN_BOT_IDS] + [(ADMIN_USER_ID, "user")]
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
                ChannelMembership.member_id.in_(BUILTIN_BOT_IDS),
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
        for bot_id in BUILTIN_BOT_IDS:
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
    did_write |= await _remove_removed_help_bots(session)
    did_write |= await _seed_helper_bot(session)
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
    admin.username = settings.admin_username
    admin.display_name = settings.admin_display_name
    if not verify_password(settings.admin_password, admin.password_hash):
        admin.password_hash = hash_password(settings.admin_password)


async def ensure_builtin_bot() -> None:
    """Ensure builtin bot."""
    async with async_session_factory() as session:
        try:
            await _remove_removed_help_bots(session)
            await _seed_helper_bot(session)
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
        f"  Templates: 通用助手, 代码审查, 创意写作\n"
        f"  Bots: @Coordinator（内置协作助手）"
    )
