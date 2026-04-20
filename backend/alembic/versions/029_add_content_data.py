"""replace thread_title with content_data JSON on messages

Revision ID: 029
Revises: 028
Create Date: 2026-04-20 00:01:00.000000
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "029"
down_revision: Union[str, Sequence[str], None] = "028"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("messages", sa.Column("content_data", sa.JSON, nullable=True))
    # 将已有 thread_title 迁移进 content_data
    op.execute(
        """
        UPDATE messages
        SET content_data = json_build_object('title', thread_title)
        WHERE thread_title IS NOT NULL AND msg_type = 'thread'
        """
    )
    op.drop_column("messages", "thread_title")


def downgrade() -> None:
    op.add_column("messages", sa.Column("thread_title", sa.String(255), nullable=True))
    op.execute(
        """
        UPDATE messages
        SET thread_title = content_data->>'title'
        WHERE content_data IS NOT NULL AND msg_type = 'thread'
        """
    )
    op.drop_column("messages", "content_data")
