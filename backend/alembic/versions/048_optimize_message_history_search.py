"""optimize message history pagination and search

Revision ID: 048
Revises: 047
Create Date: 2026-05-14
"""
from __future__ import annotations

import sqlalchemy as sa

from alembic import op

revision = "048"
down_revision = "047"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name == "postgresql":
        with op.get_context().autocommit_block():
            op.create_index(
                "ix_messages_channel_created_msg_id",
                "messages",
                ["channel_id", "created_at", "msg_id"],
                postgresql_concurrently=True,
            )
            op.execute("CREATE EXTENSION IF NOT EXISTS pg_trgm")
            op.create_index(
                "ix_messages_content_trgm",
                "messages",
                ["content"],
                postgresql_using="gin",
                postgresql_ops={"content": "gin_trgm_ops"},
                postgresql_where=sa.text("is_secret = false"),
                postgresql_concurrently=True,
            )
    else:
        op.create_index(
            "ix_messages_channel_created_msg_id",
            "messages",
            ["channel_id", "created_at", "msg_id"],
        )


def downgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name == "postgresql":
        with op.get_context().autocommit_block():
            op.drop_index(
                "ix_messages_content_trgm",
                table_name="messages",
                postgresql_concurrently=True,
            )
            op.drop_index(
                "ix_messages_channel_created_msg_id",
                table_name="messages",
                postgresql_concurrently=True,
            )
    else:
        op.drop_index("ix_messages_channel_created_msg_id", table_name="messages")
