"""Add task_id and in_reply_to_msg_id columns on messages.

Revision ID: 007
Revises: 006
Create Date: 2026-03-12
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "007"
down_revision: str | None = "006"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("messages", sa.Column("task_id", sa.String(length=36), nullable=True))
    op.add_column("messages", sa.Column("in_reply_to_msg_id", sa.String(length=36), nullable=True))
    # 索引用于按任务线程和问答配对查询
    op.create_index("ix_messages_task_id", "messages", ["task_id"])
    op.create_index("ix_messages_in_reply_to_msg_id", "messages", ["in_reply_to_msg_id"])


def downgrade() -> None:
    op.drop_index("ix_messages_in_reply_to_msg_id", table_name="messages")
    op.drop_index("ix_messages_task_id", table_name="messages")
    op.drop_column("messages", "in_reply_to_msg_id")
    op.drop_column("messages", "task_id")

