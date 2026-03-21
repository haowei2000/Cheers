"""Initial context_store table (四层记忆).

Revision ID: 001
Revises:
Create Date: 2026-03-21

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "001"
down_revision: Union[str, Sequence[str], None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "context_store",
        sa.Column("channel_id", sa.Text(), nullable=False),
        sa.Column("layer", sa.Text(), nullable=False),
        sa.Column("content", sa.Text(), nullable=False, server_default=""),
        sa.Column("updated_at", sa.Text(), nullable=True),
        sa.PrimaryKeyConstraint("channel_id", "layer"),
    )


def downgrade() -> None:
    op.drop_table("context_store")
