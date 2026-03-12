"""种子数据：默认工作空间、项目、引导 Bot、测试用户，便于开箱测试."""
import asyncio
import os
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.auth.routes import hash_password
from app.db.models import (
    BotAccount,
    Channel,
    ChannelMembership,
    User,
    Workspace,
)
from app.db.session import async_session_factory
from app.guide.constants import GUIDE_BOT_ID, ORCHESTRATOR_BOT_ID

# 固定 ID，便于文档与脚本引用
WORKSPACE_ID = "ws-default-001"
CHANNEL_ID = "ch-seed-001"
DEV_USER_ID = "a0000000-0000-0000-0000-000000000001"
ADMIN_USER_ID = "admin-0000-0000-0000-000000000001"


async def seed(session: AsyncSession) -> bool:
    """写入种子数据（若已存在则跳过）。返回是否执行了写入。"""
    did_write = False

    # 工作空间
    r = await session.execute(select(Workspace).where(Workspace.workspace_id == WORKSPACE_ID))
    if r.scalar_one_or_none() is None:
        session.add(Workspace(workspace_id=WORKSPACE_ID, name="默认空间"))
        did_write = True

    # 项目（频道）
    r = await session.execute(select(Channel).where(Channel.channel_id == CHANNEL_ID))
    if r.scalar_one_or_none() is None:
        session.add(
            Channel(
                channel_id=CHANNEL_ID,
                workspace_id=WORKSPACE_ID,
                name="测试项目",
                type="public",
                purpose="开箱测试与引导 Bot 演示",
            )
        )
        did_write = True

    # 引导 Bot（guide:// 表示使用 GuideBotAdapter）
    r = await session.execute(select(BotAccount).where(BotAccount.bot_id == GUIDE_BOT_ID))
    if r.scalar_one_or_none() is None:
        session.add(
            BotAccount(
                bot_id=GUIDE_BOT_ID,
                username="引导",
                display_name="使用引导 Bot",
                openclaw_endpoint="guide://internal",
                status="online",
                intro='{"capabilities":["使用说明","创建项目","接入指南"],"description":"根据说明书回答使用问题"}',
            )
        )
        did_write = True

    # 开发/测试用户（与前端 DEV_USER_ID 一致）
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

    # 系统管理员（admin/admin）
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

    # 引导 Bot 加入测试项目
    r = await session.execute(
        select(ChannelMembership).where(
            ChannelMembership.channel_id == CHANNEL_ID,
            ChannelMembership.member_id == GUIDE_BOT_ID,
        )
    )
    if r.scalar_one_or_none() is None:
        session.add(
            ChannelMembership(channel_id=CHANNEL_ID, member_id=GUIDE_BOT_ID, member_type="bot")
        )
        did_write = True

    # Orchestrator/Coordinator 主控 Bot（门户阶段一：直接回答 + 建议 @部门bot；@coordinator 时聚合）
    r = await session.execute(select(BotAccount).where(BotAccount.bot_id == ORCHESTRATOR_BOT_ID))
    if r.scalar_one_or_none() is None:
        session.add(
            BotAccount(
                bot_id=ORCHESTRATOR_BOT_ID,
                username="coordinator",
                display_name="Orchestrator/主控",
                openclaw_endpoint="coordinator://internal",
                status="online",
                intro='{"capabilities":["聚合 Bot 回复"],"description":"主控 Bot"}',
            )
        )
        did_write = True
    r = await session.execute(
        select(ChannelMembership).where(
            ChannelMembership.channel_id == CHANNEL_ID,
            ChannelMembership.member_id == ORCHESTRATOR_BOT_ID,
        )
    )
    if r.scalar_one_or_none() is None:
        session.add(
            ChannelMembership(channel_id=CHANNEL_ID, member_id=ORCHESTRATOR_BOT_ID, member_type="bot")
        )
        did_write = True

    # 测试用户加入测试项目
    r = await session.execute(
        select(ChannelMembership).where(
            ChannelMembership.channel_id == CHANNEL_ID,
            ChannelMembership.member_id == DEV_USER_ID,
        )
    )
    if r.scalar_one_or_none() is None:
        session.add(
            ChannelMembership(channel_id=CHANNEL_ID, member_id=DEV_USER_ID, member_type="user")
        )
        did_write = True

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


def _ensure_data_dir() -> None:
    """确保主库所在目录存在（SQLite 文件路径）。"""
    url = settings.database_url
    if not url.startswith("sqlite"):
        return
    # sqlite+aiosqlite:///data/main.db -> data/main.db
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
    print("Seed done. Workspace:", WORKSPACE_ID, "Channel:", CHANNEL_ID, "Guide bot: @引导", "Orchestrator: @coordinator")
