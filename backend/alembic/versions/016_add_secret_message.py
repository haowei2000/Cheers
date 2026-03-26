"""Add is_secret, secret_encrypted, secret_token columns to messages.

Revision ID: 016
Revises: 015
Create Date: 2026-03-26

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "016"
down_revision: str | Sequence[str] | None = "015"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("messages", sa.Column("is_secret", sa.Boolean(), nullable=False, server_default="0"))
    op.add_column("messages", sa.Column("secret_encrypted", sa.Text(), nullable=True))
    op.add_column("messages", sa.Column("secret_token", sa.String(length=64), nullable=True))


def downgrade() -> None:
    op.drop_column("messages", "secret_token")
    op.drop_column("messages", "secret_encrypted")
    op.drop_column("messages", "is_secret")
