"""add msg_type and thread_title to messages

Revision ID: 028
Revises: 027
Create Date: 2026-04-20 00:00:00.000000
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "028"
down_revision: Union[str, Sequence[str], None] = "027"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("messages", sa.Column("msg_type", sa.String(16), nullable=False, server_default="normal"))
    op.add_column("messages", sa.Column("thread_title", sa.String(255), nullable=True))

    # Backfill messages with in_reply_to_msg_id as replies.
    op.execute(
        "UPDATE messages SET msg_type = 'reply' WHERE in_reply_to_msg_id IS NOT NULL"
    )
    # Backfill messages that have at least one reply as thread roots.
    op.execute(
        """
        UPDATE messages SET msg_type = 'thread'
        WHERE msg_id IN (
            SELECT DISTINCT in_reply_to_msg_id FROM messages
            WHERE in_reply_to_msg_id IS NOT NULL
        )
        """
    )


def downgrade() -> None:
    op.drop_column("messages", "thread_title")
    op.drop_column("messages", "msg_type")
