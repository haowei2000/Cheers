"""rename msg_type 'thread' to 'topic'

Revision ID: 035
Revises: 034
Create Date: 2026-04-25 03:00:00.000000

Product rename: 对话串 / thread → 主题 / topic. Existing rows with
msg_type='thread' are converted in place; new code emits 'topic'.
"""
from typing import Sequence, Union

from alembic import op

revision: str = "035"
down_revision: Union[str, Sequence[str], None] = "034"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        "UPDATE messages SET msg_type = 'topic' WHERE msg_type = 'thread'",
    )


def downgrade() -> None:
    op.execute(
        "UPDATE messages SET msg_type = 'thread' WHERE msg_type = 'topic'",
    )
