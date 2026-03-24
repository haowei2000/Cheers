"""Add prompt_template field to bot_accounts table.

Revision ID: 008
Revises: 007
Create Date: 2026-03-12
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "008"
down_revision: str | None = "007"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("bot_accounts", sa.Column("prompt_template", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("bot_accounts", "prompt_template")

