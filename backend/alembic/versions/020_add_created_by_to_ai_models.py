"""Add created_by to ai_models.

Revision ID: 020
Revises: 019
Create Date: 2026-03-30

"""
from collections.abc import Sequence
from typing import Union

import sqlalchemy as sa
from alembic import op

revision: str = "020"
down_revision: Union[str, Sequence[str], None] = "019"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "ai_models",
        sa.Column("created_by", sa.String(36), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("ai_models", "created_by")
