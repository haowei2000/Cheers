"""add prompt template scope

Revision ID: 056
Revises: 055
Create Date: 2026-05-19
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "056"
down_revision = "055"
branch_labels = None
depends_on = None


def upgrade() -> None:
    conn = op.get_bind()
    inspector = sa.inspect(conn)
    columns = {c["name"] for c in inspector.get_columns("prompt_templates")}

    if "scope" not in columns:
        op.add_column(
            "prompt_templates",
            sa.Column("scope", sa.String(16), nullable=False, server_default="friend"),
        )

    conn.execute(
        sa.text(
            """
            UPDATE prompt_templates
            SET scope = 'everyone'
            WHERE is_builtin = true OR created_by IS NULL
            """
        )
    )


def downgrade() -> None:
    conn = op.get_bind()
    inspector = sa.inspect(conn)
    columns = {c["name"] for c in inspector.get_columns("prompt_templates")}

    if "scope" in columns:
        op.drop_column("prompt_templates", "scope")
