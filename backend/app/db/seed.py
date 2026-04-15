"""种子数据：默认工作空间、提示词模板、Bot、测试用户."""
import asyncio

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
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
from app.services.auth.password_utils import hash_password, verify_password
from app.services.guide.constants import GUIDE_BOT_ID, GUIDE_HELPER_BOT_ID

# 固定 ID，便于文档与脚本引用
WORKSPACE_ID = "ws-default-001"
CHANNEL_ID = "ch-seed-001"
ADMIN_USER_ID = "admin-0000-0000-0000-000000000001"

TEMPLATE_GENERAL_ID = "template-general-001"
TEMPLATE_CODE_REVIEW_ID = "template-codereview-001"
TEMPLATE_CREATIVE_ID = "template-creative-001"


async def _seed_unified_bot(session: AsyncSession) -> bool:
    """创建统一内置 Bot（@channel bot）：引导 + 助手 + 记忆管理三合一。"""
    r = await session.execute(select(BotAccount).where(BotAccount.bot_id == GUIDE_BOT_ID))
    existing = r.scalar_one_or_none()
    if existing is not None:
        # 迁移旧用户名
        if existing.username == "引导":
            existing.username = "channel bot"
            await session.flush()
        return False

    session.add(
        BotAccount(
            bot_id=GUIDE_BOT_ID,
            username="channel bot",
            display_name="内置助手",
            description=(
                "系统内置统一助手，集引导、项目助手、记忆管理三合一。"
                "可回答系统使用问题、结合项目记忆回答业务问题、"
                "读写四层项目记忆、并在需要时建议路由到专业 Bot。"
            ),
            model_id=None,
            template_id=None,
            status="online",
            intro=(
                '{"capabilities":["系统引导","项目问答","记忆读写","澄清弹窗","动态表单","Bot路由建议"],'
                '"description":"内置统一助手，@channel bot 即可使用"}'
            ),
        )
    )
    return True


async def _seed_guide_helper_bot(session: AsyncSession) -> bool:
    """创建智枢协作操作指引助手 Bot（@guide-helper）：加载 docs/ 下所有文档，回答 AgentNexus 使用问题."""
    r = await session.execute(select(BotAccount).where(BotAccount.bot_id == GUIDE_HELPER_BOT_ID))
    existing = r.scalar_one_or_none()
    if existing is not None:
        return False

    session.add(
        BotAccount(
            bot_id=GUIDE_HELPER_BOT_ID,
            username="guide-helper",
            display_name="智枢协作操作指引助手",
            description="智枢协作操作指引助手，加载所有帮助文档，回答平台使用问题。",
            model_id=None,
            template_id=None,
            status="online",
            is_public=True,
            intro='{"capabilities":["使用说明","功能问答","操作指南"],"description":"输入 @guide-helper 即可获得操作指引"}',
        )
    )
    await session.flush()

    # 将该 Bot 加入默认频道
    r2 = await session.execute(
        select(ChannelMembership).where(
            ChannelMembership.channel_id == CHANNEL_ID,
            ChannelMembership.member_id == GUIDE_HELPER_BOT_ID,
        )
    )
    if r2.scalar_one_or_none() is None:
        session.add(
            ChannelMembership(
                channel_id=CHANNEL_ID,
                member_id=GUIDE_HELPER_BOT_ID,
                member_type="bot",
            )
        )

    return True


async def _seed_templates(session: AsyncSession) -> bool:
    """创建示例提示词模板."""
    did_write = False

    r = await session.execute(select(PromptTemplate).where(PromptTemplate.template_id == TEMPLATE_GENERAL_ID))
    if r.scalar_one_or_none() is None:
        session.add(
            PromptTemplate(
                template_id=TEMPLATE_GENERAL_ID,
                name="通用助手",
                description="通用的 AI 助手，适合回答各种问题",
                system_prompt="你是一个有用的 AI 助手。请简洁、专业地回答用户问题。",
                user_template="{{message}}",
                variables=["message"],
                is_builtin=True,
            )
        )
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
    """创建工作区、频道、管理员用户."""
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
    """创建频道成员关系（内置 Bot + 管理员）."""
    did_write = False

    for member_id, member_type in ((GUIDE_BOT_ID, "bot"), (GUIDE_HELPER_BOT_ID, "bot"), (ADMIN_USER_ID, "user")):
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


async def seed(session: AsyncSession) -> bool:
    """写入种子数据（若已存在则跳过）。返回是否执行了写入。"""
    did_write = False

    did_write |= await _seed_templates(session)
    did_write |= await _seed_unified_bot(session)
    did_write |= await _seed_guide_helper_bot(session)
    did_write |= await _seed_workspace_and_users(session)
    did_write |= await _seed_memberships(session)

    return did_write


async def run_seed() -> None:
    """在独立会话中执行种子并提交。"""
    async with async_session_factory() as session:
        try:
            await seed(session)
            await session.commit()
        except Exception:
            await session.rollback()
            raise


async def _sync_admin_credentials(session: AsyncSession) -> None:
    """每次启动时将 admin 账号的用户名/显示名同步为 .env 中的配置；仅在密码变更时重新哈希。"""
    r = await session.execute(select(User).where(User.user_id == ADMIN_USER_ID))
    admin = r.scalar_one_or_none()
    if admin is None:
        return
    admin.username = settings.admin_username
    admin.display_name = settings.admin_display_name
    if not verify_password(settings.admin_password, admin.password_hash):
        admin.password_hash = hash_password(settings.admin_password)


async def ensure_builtin_bot() -> None:
    """每次启动时无条件确保内置 Bot 存在，并加入所有现有频道。

    不依赖 SEED_DATA 环境变量，保证升级后旧库也能自动补齐内置 Bot。
    """
    async with async_session_factory() as session:
        try:
            await _seed_unified_bot(session)
            await _seed_guide_helper_bot(session)
            await _sync_admin_credentials(session)

            # 确保内置 Bot 加入所有现有频道（补齐旧频道缺失的 membership）
            all_channels = (await session.execute(select(Channel))).scalars().all()
            builtin_bot_ids = (GUIDE_BOT_ID, GUIDE_HELPER_BOT_ID)
            for bot_id in builtin_bot_ids:
                existing = {
                    row
                    for row in (
                        await session.execute(
                            select(ChannelMembership.channel_id).where(
                                ChannelMembership.member_id == bot_id
                            )
                        )
                    ).scalars()
                }
                for ch in all_channels:
                    if ch.channel_id not in existing:
                        session.add(
                            ChannelMembership(
                                channel_id=ch.channel_id,
                                member_id=bot_id,
                                member_type="bot",
                            )
                        )

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
        f"  Bots: @channel bot（内置统一Bot）, @guide-helper（智枢协作操作指引助手）"
    )
