"""Add workspace_memberships table.

Revision ID: 015
Revises: 014
Create Date: 2026-03-21

"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "015"
down_revision: str | Sequence[str] | None = "014"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    conn = op.get_bind()
    existing = conn.execute(
        sa.text("SELECT name FROM sqlite_master WHERE type='table' AND name='workspace_memberships'")
    ).fetchone()
    if existing:
        return
    op.create_table(
        "workspace_memberships",
        sa.Column("workspace_id", sa.String(36), sa.ForeignKey("workspaces.workspace_id"), primary_key=True),
        sa.Column("user_id", sa.String(36), sa.ForeignKey("users.user_id"), primary_key=True),
        sa.Column("role", sa.String(20), nullable=False, server_default="member"),
        sa.Column("joined_at", sa.DateTime(), nullable=True),
    )


def downgrade() -> None:
    op.drop_table("workspace_memberships")
