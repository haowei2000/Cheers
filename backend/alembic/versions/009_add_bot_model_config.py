"""Add model configuration fields to bot_accounts table for LLM Bot support.

Revision ID: 009
Revises: 008
Create Date: 2026-03-13
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "009"
down_revision: str | None = "008"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # 系统提示词
    op.add_column("bot_accounts", sa.Column("system_prompt", sa.Text(), nullable=True))
    # 模型配置字段
    op.add_column("bot_accounts", sa.Column("model_provider", sa.String(length=32), nullable=True))
    op.add_column("bot_accounts", sa.Column("model_name", sa.String(length=64), nullable=True))
    op.add_column("bot_accounts", sa.Column("model_api_key", sa.String(length=512), nullable=True))
    op.add_column("bot_accounts", sa.Column("model_base_url", sa.String(length=512), nullable=True))
    op.add_column("bot_accounts", sa.Column("model_temperature", sa.Float(), nullable=True))
    op.add_column("bot_accounts", sa.Column("model_max_tokens", sa.Integer(), nullable=True))
    op.add_column("bot_accounts", sa.Column("model_extra_config", sa.JSON(), nullable=True))


def downgrade() -> None:
    op.drop_column("bot_accounts", "system_prompt")
    op.drop_column("bot_accounts", "model_provider")
    op.drop_column("bot_accounts", "model_name")
    op.drop_column("bot_accounts", "model_api_key")
    op.drop_column("bot_accounts", "model_base_url")
    op.drop_column("bot_accounts", "model_temperature")
    op.drop_column("bot_accounts", "model_max_tokens")
    op.drop_column("bot_accounts", "model_extra_config")
