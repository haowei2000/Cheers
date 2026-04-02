"""Add bulletin_issues table for public bulletin board.

Revision ID: 022
Revises: 201e9aac5eee
Create Date: 2026-04-02

"""
from collections.abc import Sequence
from typing import Union

import sqlalchemy as sa
from alembic import op

revision: str = "022"
down_revision: Union[str, Sequence[str], None] = "201e9aac5eee"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "bulletin_issues",
        sa.Column("issue_id", sa.String(36), primary_key=True),
        sa.Column("title", sa.String(255), nullable=False),
        sa.Column("content", sa.Text(), nullable=True),
        sa.Column("status", sa.String(32), nullable=False, server_default="open"),
        sa.Column("priority", sa.String(32), nullable=False, server_default="medium"),
        sa.Column("tags", sa.JSON(), nullable=True, server_default="[]"),
        sa.Column("creator_id", sa.String(36), nullable=True),
        sa.Column("creator_name", sa.String(128), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_table("bulletin_issues")
