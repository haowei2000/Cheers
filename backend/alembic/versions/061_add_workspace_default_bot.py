"""add workspace default bot

Revision ID: 061
Revises: 059
Create Date: 2026-05-25
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "061"
down_revision = "059"
branch_labels = None
depends_on = None


def upgrade() -> None:
    conn = op.get_bind()
    inspector = sa.inspect(conn)
    columns = {c["name"] for c in inspector.get_columns("workspaces")}
    indexes = {idx["name"] for idx in inspector.get_indexes("workspaces")}
    constraints = {fk["name"] for fk in inspector.get_foreign_keys("workspaces")}

    if "default_bot_id" not in columns:
        op.add_column(
            "workspaces",
            sa.Column("default_bot_id", sa.String(36), nullable=True),
        )
    if "fk_workspaces_default_bot_id" not in constraints:
        op.create_foreign_key(
            "fk_workspaces_default_bot_id",
            "workspaces",
            "bot_accounts",
            ["default_bot_id"],
            ["bot_id"],
            ondelete="SET NULL",
        )
    if "ix_workspaces_default_bot_id" not in indexes:
        op.create_index(
            "ix_workspaces_default_bot_id",
            "workspaces",
            ["default_bot_id"],
        )


def downgrade() -> None:
    conn = op.get_bind()
    inspector = sa.inspect(conn)
    columns = {c["name"] for c in inspector.get_columns("workspaces")}
    indexes = {idx["name"] for idx in inspector.get_indexes("workspaces")}
    constraints = {fk["name"] for fk in inspector.get_foreign_keys("workspaces")}

    if "ix_workspaces_default_bot_id" in indexes:
        op.drop_index("ix_workspaces_default_bot_id", table_name="workspaces")
    if "fk_workspaces_default_bot_id" in constraints:
        op.drop_constraint("fk_workspaces_default_bot_id", "workspaces", type_="foreignkey")
    if "default_bot_id" in columns:
        op.drop_column("workspaces", "default_bot_id")
