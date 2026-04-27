"""add is_partial flag to messages

Revision ID: 036
Revises: 035
Create Date: 2026-04-27 00:00:00.000000

When a streaming bot reply is cancelled (or errors mid-stream) we still
keep what was generated so far and mark the row is_partial=True so the
frontend can render a "已取消" badge.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "036"
down_revision: Union[str, Sequence[str], None] = "035"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "messages",
        sa.Column(
            "is_partial",
            sa.Boolean(),
            nullable=False,
            server_default=sa.false(),
        ),
    )


def downgrade() -> None:
    op.drop_column("messages", "is_partial")
