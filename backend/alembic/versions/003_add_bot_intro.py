"""Add intro field to bot_accounts and bot_registration_requests.

Revision ID: 003
Revises: 002
Create Date: 2026-03-09

"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "003"
down_revision: str | None = "002"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("bot_accounts", sa.Column("intro", sa.Text(), nullable=True))
    op.add_column("bot_registration_requests", sa.Column("intro", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("bot_registration_requests", "intro")
    op.drop_column("bot_accounts", "intro")
