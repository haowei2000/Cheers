"""Add system_settings table to replace admin_settings.json.

Revision ID: 018
Revises: 017
Create Date: 2026-03-26

"""
from collections.abc import Sequence
from typing import Union

import sqlalchemy as sa
from alembic import op

revision: str = "018"
down_revision: Union[str, Sequence[str], None] = "017"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "system_settings",
        sa.Column("key", sa.String(128), primary_key=True),
        sa.Column("value", sa.JSON(), nullable=False, server_default="{}"),
    )


def downgrade() -> None:
    op.drop_table("system_settings")
