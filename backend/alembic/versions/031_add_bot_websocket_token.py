"""add websocket bot token fields to bot_accounts

Revision ID: 031
Revises: 030
Create Date: 2026-04-21 14:00:00.000000

为 WebSocket Bot 存储每个 bot 的独立凭证（替代共享的 OPENCLAW_BRIDGE_TOKEN）：
  - bot_token_hash    存明文 token 的 pbkdf2_sha256 哈希
  - bot_token_prefix  明文 token 的前 8 字符（例如 "ocw_xxxx"），用于 O(1) 索引
                      查询目标 Bot，然后再 verify 全 token
  - bot_token_rotated_at  最近一次生成/轮换时间，便于审计与旧连接失效判定

明文 token 仅在创建/轮换时一次性返回给用户，此后不可再获取。
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "031"
down_revision: Union[str, Sequence[str], None] = "030"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("bot_accounts", sa.Column("bot_token_hash", sa.String(256), nullable=True))
    op.add_column("bot_accounts", sa.Column("bot_token_prefix", sa.String(16), nullable=True))
    op.add_column(
        "bot_accounts",
        sa.Column("bot_token_rotated_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index(
        "ix_bot_accounts_token_prefix",
        "bot_accounts",
        ["bot_token_prefix"],
    )


def downgrade() -> None:
    op.drop_index("ix_bot_accounts_token_prefix", table_name="bot_accounts")
    op.drop_column("bot_accounts", "bot_token_rotated_at")
    op.drop_column("bot_accounts", "bot_token_prefix")
    op.drop_column("bot_accounts", "bot_token_hash")
