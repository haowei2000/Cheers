"""Add email to users and email_codes table.

Revision ID: 021
Revises: 020
Create Date: 2026-03-31

"""
from collections.abc import Sequence
from typing import Union

import sqlalchemy as sa
from alembic import op

revision: str = "021"
down_revision: Union[str, Sequence[str], None] = "020"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column("email", sa.String(255), nullable=True, unique=True),
    )
    op.create_table(
        "email_codes",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("email", sa.String(255), nullable=False),
        sa.Column("code", sa.String(10), nullable=False),
        sa.Column("purpose", sa.String(32), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("used", sa.Boolean(), nullable=False, server_default="0"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )
    op.create_index("ix_email_codes_email", "email_codes", ["email"])


def downgrade() -> None:
    op.drop_index("ix_email_codes_email", table_name="email_codes")
    op.drop_table("email_codes")
    op.drop_column("users", "email")
