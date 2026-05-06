"""add concurrency hot path indexes

Revision ID: 044
Revises: 043
Create Date: 2026-05-06
"""
from alembic import op


revision = "044"
down_revision = "043"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_index("ix_messages_channel_created_at", "messages", ["channel_id", "created_at"])
    op.create_index("ix_messages_in_reply_created_at", "messages", ["in_reply_to_msg_id", "created_at"])
    op.create_index("ix_file_records_channel_created_at", "file_records", ["channel_id", "created_at"])
    op.create_index("ix_channel_memberships_member_type", "channel_memberships", ["member_id", "member_type"])


def downgrade() -> None:
    op.drop_index("ix_channel_memberships_member_type", table_name="channel_memberships")
    op.drop_index("ix_file_records_channel_created_at", table_name="file_records")
    op.drop_index("ix_messages_in_reply_created_at", table_name="messages")
    op.drop_index("ix_messages_channel_created_at", table_name="messages")
