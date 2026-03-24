"""Add avatar_url field to bot_accounts table.

Revision ID: 005
Revises: 004
Create Date: 2026-03-12

"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "005"
down_revision: str | None = "004"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("bot_accounts", sa.Column("avatar_url", sa.String(512), nullable=True))


def downgrade() -> None:
    op.drop_column("bot_accounts", "avatar_url")
