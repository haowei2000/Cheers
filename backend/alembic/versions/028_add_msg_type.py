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

    # 回填：有 in_reply_to_msg_id 的消息标记为 reply
    op.execute(
        "UPDATE messages SET msg_type = 'reply' WHERE in_reply_to_msg_id IS NOT NULL"
    )
    # 回填：被至少一条消息回复过的消息（不论自身是 normal 还是 reply）升级为 thread
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
