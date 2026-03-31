"""Add is_public visibility field to bot_accounts and ai_models.

Revision ID: 019
Revises: 018
Create Date: 2026-03-30

"""
from collections.abc import Sequence
from typing import Union

import sqlalchemy as sa
from alembic import op

revision: str = "019"
down_revision: Union[str, Sequence[str], None] = "018"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "bot_accounts",
        sa.Column("is_public", sa.Boolean(), nullable=False, server_default="1"),
    )
    op.add_column(
        "ai_models",
        sa.Column("is_public", sa.Boolean(), nullable=False, server_default="1"),
    )


def downgrade() -> None:
    op.drop_column("bot_accounts", "is_public")
    op.drop_column("ai_models", "is_public")
