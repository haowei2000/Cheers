"""add binding_type and binding_config to bot_accounts

Revision ID: 030
Revises: 029
Create Date: 2026-04-21 12:00:00.000000

为 BotAccount 增加两列：
  - binding_type: 'http'（默认，OpenAI 兼容 HTTP，沿用 LLMBotAdapter）
                 / 'websocket'（新的 WebSocket Bot，经 OpenClaw bridge 异步回推回复）
  - binding_config: JSONB，绑定相关配置（例如 WebSocket Bot 的 agent_id / gateway 端点等）

既有 Bot 全部视为 HTTP Bot，通过 NOT NULL DEFAULT 'http' 自动回填。
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "030"
down_revision: Union[str, Sequence[str], None] = "029"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "bot_accounts",
        sa.Column("binding_type", sa.String(32), nullable=False, server_default="http"),
    )
    op.add_column(
        "bot_accounts",
        sa.Column("binding_config", sa.JSON, nullable=True),
    )


def downgrade() -> None:
    op.drop_column("bot_accounts", "binding_config")
    op.drop_column("bot_accounts", "binding_type")
