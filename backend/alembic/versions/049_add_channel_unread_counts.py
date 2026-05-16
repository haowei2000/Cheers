"""add channel unread count cache

Revision ID: 049
Revises: 048
Create Date: 2026-05-14
"""
from __future__ import annotations

import sqlalchemy as sa

from alembic import op

revision = "049"
down_revision = "048"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "channel_unread_counts",
        sa.Column("channel_id", sa.String(length=36), nullable=False),
        sa.Column("user_id", sa.String(length=36), nullable=False),
        sa.Column("unread_count", sa.Integer(), server_default="0", nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(["channel_id"], ["channels.channel_id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("channel_id", "user_id"),
    )
    op.create_index(
        "ix_channel_unread_counts_user",
        "channel_unread_counts",
        ["user_id"],
    )


def downgrade() -> None:
    op.drop_index("ix_channel_unread_counts_user", table_name="channel_unread_counts")
    op.drop_table("channel_unread_counts")

