"""add channel membership hidden_at

Revision ID: 055
Revises: 054
Create Date: 2026-05-19
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "055"
down_revision = "054"
branch_labels = None
depends_on = None


def upgrade() -> None:
    conn = op.get_bind()
    inspector = sa.inspect(conn)
    columns = {c["name"] for c in inspector.get_columns("channel_memberships")}
    indexes = {idx["name"] for idx in inspector.get_indexes("channel_memberships")}

    if "hidden_at" not in columns:
        op.add_column(
            "channel_memberships",
            sa.Column("hidden_at", sa.DateTime(timezone=True), nullable=True),
        )
    if "ix_channel_memberships_hidden" not in indexes:
        op.create_index(
            "ix_channel_memberships_hidden",
            "channel_memberships",
            ["member_id", "member_type", "hidden_at"],
        )


def downgrade() -> None:
    conn = op.get_bind()
    inspector = sa.inspect(conn)
    indexes = {idx["name"] for idx in inspector.get_indexes("channel_memberships")}
    columns = {c["name"] for c in inspector.get_columns("channel_memberships")}

    if "ix_channel_memberships_hidden" in indexes:
        op.drop_index("ix_channel_memberships_hidden", table_name="channel_memberships")
    if "hidden_at" in columns:
        op.drop_column("channel_memberships", "hidden_at")
