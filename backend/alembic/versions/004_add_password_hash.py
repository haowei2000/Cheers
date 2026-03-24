"""Add password_hash field to users table.

Revision ID: 004
Revises: 003
Create Date: 2026-03-11

"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "004"
down_revision: str | None = "003"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("users", sa.Column("password_hash", sa.String(255), nullable=False, server_default=""))


def downgrade() -> None:
    op.drop_column("users", "password_hash")
