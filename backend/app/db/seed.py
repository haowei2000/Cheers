"""种子数据：默认工作空间、AI 模型、提示词模板、Bot、测试用户."""
import asyncio
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.auth.routes import hash_password
from app.db.models import (
    AIModel,
    BotAccount,
    Channel,
    ChannelMembership,
    PromptTemplate,
    User,
    Workspace,
)
from app.db.session import async_session_factory
from app.guide.constants import (
    GUIDE_BOT_ID,
    SYSTEM_MODEL_ID,
    SYSTEM_TEMPLATE_ID,
)

# 固定 ID，便于文档与脚本引用
WORKSPACE_ID = "ws-default-001"
CHANNEL_ID = "ch-seed-001"
DEV_USER_ID = "a0000000-0000-0000-0000-000000000001"
ADMIN_USER_ID = "admin-0000-0000-0000-000000000001"

# 普通示例 Bot
MODEL_OLLAMA_ID = "model-ollama-001"
MODEL_OPENAI_ID = "model-openai-001"
TEMPLATE_GENERAL_ID = "template-general-001"
TEMPLATE_CODE_REVIEW_ID = "template-codereview-001"
TEMPLATE_CREATIVE_ID = "template-creative-001"
BOT_CODE_REVIEWER_ID = "bot-codereviewer-001"


async def _seed_system_model_and_template(session: AsyncSession) -> bool:
    """创建系统内置占位 AIModel 和 PromptTemplate（供统一内置 Bot 满足 FK 约束）。

    运行时 adapter_resolver 识别 GUIDE_BOT_ID 后直接返回 UnifiedBuiltinBotAdapter，
    不会实际调用这里的 model / template。
    """
    did_write = False

    r = await session.execute(select(AIModel).where(AIModel.model_id == SYSTEM_MODEL_ID))
    if r.scalar_one_or_none() is None:
        session.add(
            AIModel(
                model_id=SYSTEM_MODEL_ID,
                name="系统内置（占位）",
                provider="system",
                model_name="builtin",
                base_url="http://localhost",
                api_key=None,
                description="供内置统一 Bot 满足数据库 FK 约束，运行时不实际调用",
                is_enabled=True,
                is_builtin=True,
                config={},
            )
        )
        did_write = True

    r = await session.execute(select(PromptTemplate).where(PromptTemplate.template_id == SYSTEM_TEMPLATE_ID))
    if r.scalar_one_or_none() is None:
        session.add(
            PromptTemplate(
                template_id=SYSTEM_TEMPLATE_ID,
                name="系统内置（占位）",
                description="供内置统一 Bot 满足数据库 FK 约束，运行时不实际调用",
                system_prompt="（系统占位，不会被实际使用）",
                user_template="{{message}}",
                variables=["message"],
                is_builtin=True,
            )
        )
        did_write = True

    return did_write


async def _seed_unified_bot(session: AsyncSession) -> bool:
    """创建统一内置 Bot（@引导）：引导 + 助手 + 记忆管理三合一。"""
    r = await session.execute(select(BotAccount).where(BotAccount.bot_id == GUIDE_BOT_ID))
    if r.scalar_one_or_none() is not None:
        return False

    session.add(
        BotAccount(
            bot_id=GUIDE_BOT_ID,
            username="引导",
            display_name="内置助手",
            description=(
                "系统内置统一助手，集引导、项目助手、记忆管理三合一。"
                "可回答系统使用问题、结合项目记忆回答业务问题、"
                "读写四层项目记忆、并在需要时建议路由到专业 Bot。"
            ),
            model_id=SYSTEM_MODEL_ID,
            template_id=SYSTEM_TEMPLATE_ID,
            status="online",
            intro=(
                '{"capabilities":["系统引导","项目问答","记忆读写","澄清弹窗","动态表单","Bot路由建议"],'
                '"description":"内置统一助手，@引导 即可使用"}'
            ),
        )
    )
    return True


async def _seed_models(session: AsyncSession) -> bool:
    """创建普通示例 AI 模型."""
    did_write = False

    r = await session.execute(select(AIModel).where(AIModel.model_id == MODEL_OLLAMA_ID))
    if r.scalar_one_or_none() is None:
        session.add(
            AIModel(
                model_id=MODEL_OLLAMA_ID,
                name="Ollama (Llama 3.2)",
                provider="ollama",
                model_name="llama3.2",
                base_url="http://localhost:11434/v1",
                api_key=None,
                description="本地 Ollama 运行的 Llama 3.2 模型，无需联网，适合代码和一般问答",
                is_enabled=True,
                is_builtin=True,
                config={"temperature": 0.7, "max_tokens": 2000},
            )
        )
        did_write = True

    r = await session.execute(select(AIModel).where(AIModel.model_id == MODEL_OPENAI_ID))
    if r.scalar_one_or_none() is None:
        session.add(
            AIModel(
                model_id=MODEL_OPENAI_ID,
                name="OpenAI GPT-4o",
                provider="openai",
                model_name="gpt-4o",
                base_url="https://api.openai.com/v1",
                api_key=None,
                description="OpenAI GPT-4o，强大的通用能力，需要配置 API Key",
                is_enabled=False,
                is_builtin=True,
                config={"temperature": 0.7, "max_tokens": 4000},
            )
        )
        did_write = True

    return did_write


async def _seed_templates(session: AsyncSession) -> bool:
    """创建普通示例提示词模板."""
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


async def _seed_example_bots(session: AsyncSession) -> bool:
    """创建普通示例 Bot（演示如何自定义 Bot）。"""
    r = await session.execute(select(BotAccount).where(BotAccount.bot_id == BOT_CODE_REVIEWER_ID))
    if r.scalar_one_or_none() is not None:
        return False

    session.add(
        BotAccount(
            bot_id=BOT_CODE_REVIEWER_ID,
            username="代码审查",
            display_name="Code Reviewer",
            description="专业的代码审查助手，帮助发现代码中的问题和优化点",
            model_id=MODEL_OLLAMA_ID,
            template_id=TEMPLATE_CODE_REVIEW_ID,
            status="online",
            intro='{"capabilities":["代码审查","Bug 发现","优化建议","安全检测"],"description":"专业代码审查助手"}',
        )
    )
    return True


async def _seed_workspace_and_users(session: AsyncSession) -> bool:
    """创建工作区、频道、用户."""
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
                name="测试项目",
                type="public",
                purpose="开箱测试与 Bot 演示",
            )
        )
        did_write = True

    r = await session.execute(select(User).where(User.user_id == DEV_USER_ID))
    if r.scalar_one_or_none() is None:
        session.add(
            User(
                user_id=DEV_USER_ID,
                username="dev",
                password_hash=hash_password("dev"),
                display_name="开发测试用户",
                role="member",
            )
        )
        did_write = True

    r = await session.execute(select(User).where(User.user_id == ADMIN_USER_ID))
    if r.scalar_one_or_none() is None:
        session.add(
            User(
                user_id=ADMIN_USER_ID,
                username="admin",
                password_hash=hash_password("admin"),
                display_name="系统管理员",
                role="system_admin",
            )
        )
        did_write = True

    return did_write


async def _seed_memberships(session: AsyncSession) -> bool:
    """创建频道成员关系（统一内置 Bot + 示例 Bot + 测试用户）."""
    did_write = False

    for bot_id in (GUIDE_BOT_ID, BOT_CODE_REVIEWER_ID):
        r = await session.execute(
            select(ChannelMembership).where(
                ChannelMembership.channel_id == CHANNEL_ID,
                ChannelMembership.member_id == bot_id,
            )
        )
        if r.scalar_one_or_none() is None:
            session.add(
                ChannelMembership(
                    channel_id=CHANNEL_ID,
                    member_id=bot_id,
                    member_type="bot",
                )
            )
            did_write = True

    r = await session.execute(
        select(ChannelMembership).where(
            ChannelMembership.channel_id == CHANNEL_ID,
            ChannelMembership.member_id == DEV_USER_ID,
        )
    )
    if r.scalar_one_or_none() is None:
        session.add(
            ChannelMembership(
                channel_id=CHANNEL_ID,
                member_id=DEV_USER_ID,
                member_type="user",
            )
        )
        did_write = True

    return did_write


async def seed(session: AsyncSession) -> bool:
    """写入种子数据（若已存在则跳过）。返回是否执行了写入。"""
    did_write = False

    # 顺序：系统占位 -> 普通示例模型/模板 -> 统一内置 Bot -> 示例 Bot -> 工作区/用户 -> 成员关系
    did_write |= await _seed_system_model_and_template(session)
    did_write |= await _seed_models(session)
    did_write |= await _seed_templates(session)
    did_write |= await _seed_unified_bot(session)
    did_write |= await _seed_example_bots(session)
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


async def ensure_builtin_bot() -> None:
    """每次启动时无条件确保内置统一 Bot 存在，并加入所有现有频道。

    不依赖 SEED_DATA 环境变量，保证升级后旧库也能自动补齐内置 Bot。
    """
    async with async_session_factory() as session:
        try:
            # 1. 确保系统占位 model / template 存在
            await _seed_system_model_and_template(session)

            # 2. 确保 @引导 BotAccount 存在
            await _seed_unified_bot(session)

            # 3. 确保 @引导 加入所有现有频道（补齐旧频道缺失的 membership）
            all_channels = (await session.execute(select(Channel))).scalars().all()
            for ch in all_channels:
                r = await session.execute(
                    select(ChannelMembership).where(
                        ChannelMembership.channel_id == ch.channel_id,
                        ChannelMembership.member_id == GUIDE_BOT_ID,
                    )
                )
                if r.scalar_one_or_none() is None:
                    session.add(
                        ChannelMembership(
                            channel_id=ch.channel_id,
                            member_id=GUIDE_BOT_ID,
                            member_type="bot",
                        )
                    )

            await session.commit()
        except Exception:
            await session.rollback()
            raise


def _ensure_data_dir() -> None:
    """确保主库所在目录存在（SQLite 文件路径）。"""
    url = settings.database_url
    if not url.startswith("sqlite"):
        return
    path = url.split("///")[-1].split("?")[0]
    if not path:
        return
    dir_path = Path(path).parent
    if not dir_path.is_absolute():
        base = Path(__file__).resolve().parent.parent.parent
        dir_path = base / dir_path
    dir_path.mkdir(parents=True, exist_ok=True)


if __name__ == "__main__":
    _ensure_data_dir()
    asyncio.run(run_seed())
    print(
        "Seed done.\n"
        f"  Workspace: {WORKSPACE_ID}\n"
        f"  Channel: {CHANNEL_ID}\n"
        f"  System: 系统内置占位 model/template\n"
        f"  Models: Ollama (Llama 3.2), OpenAI GPT-4o\n"
        f"  Templates: 通用助手, 代码审查, 创意写作\n"
        f"  Bots: @引导（内置统一Bot） @代码审查"
    )
