"""add deletion lifecycle flags

Revision ID: 054
Revises: 053
Create Date: 2026-05-18
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "054"
down_revision = "053"
branch_labels = None
depends_on = None


def _column_names(table_name: str) -> set[str]:
    return {c["name"] for c in sa.inspect(op.get_bind()).get_columns(table_name)}


def upgrade() -> None:
    user_columns = _column_names("users")
    if "is_deleted" not in user_columns:
        op.add_column(
            "users",
            sa.Column("is_deleted", sa.Boolean(), nullable=False, server_default="0"),
        )
    if "deleted_at" not in user_columns:
        op.add_column("users", sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True))

    message_columns = _column_names("messages")
    if "is_deleted" not in message_columns:
        op.add_column(
            "messages",
            sa.Column("is_deleted", sa.Boolean(), nullable=False, server_default="0"),
        )
    if "deleted_at" not in message_columns:
        op.add_column("messages", sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True))
    if "deleted_by" not in message_columns:
        op.add_column("messages", sa.Column("deleted_by", sa.String(36), nullable=True))


def downgrade() -> None:
    message_columns = _column_names("messages")
    if "deleted_by" in message_columns:
        op.drop_column("messages", "deleted_by")
    if "deleted_at" in message_columns:
        op.drop_column("messages", "deleted_at")
    if "is_deleted" in message_columns:
        op.drop_column("messages", "is_deleted")

    user_columns = _column_names("users")
    if "deleted_at" in user_columns:
        op.drop_column("users", "deleted_at")
    if "is_deleted" in user_columns:
        op.drop_column("users", "is_deleted")
