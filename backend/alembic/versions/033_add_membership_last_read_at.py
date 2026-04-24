"""add last_read_at to channel_memberships

Revision ID: 033
Revises: 032
Create Date: 2026-04-24 16:00:00.000000

Per-user-per-channel read cursor for computing unread counts. NULL means
"never read"; in that case every message counts as unread.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "033"
down_revision: Union[str, Sequence[str], None] = "032"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "channel_memberships",
        sa.Column("last_read_at", sa.DateTime(timezone=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("channel_memberships", "last_read_at")
