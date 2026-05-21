"""add prompt template tags and default bot

Revision ID: 058
Revises: 057
Create Date: 2026-05-21
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "058"
down_revision = "057"
branch_labels = None
depends_on = None


def _json_array_default() -> sa.TextClause:
    dialect_name = op.get_bind().dialect.name
    if dialect_name == "postgresql":
        return sa.text("'[]'::json")
    return sa.text("'[]'")


def upgrade() -> None:
    conn = op.get_bind()
    inspector = sa.inspect(conn)
    columns = {c["name"] for c in inspector.get_columns("prompt_templates")}

    if "tags" not in columns:
        op.add_column(
            "prompt_templates",
            sa.Column("tags", sa.JSON(), nullable=False, server_default=_json_array_default()),
        )
    if "default_bot_id" not in columns:
        op.add_column(
            "prompt_templates",
            sa.Column("default_bot_id", sa.String(36), nullable=True),
        )
        op.create_foreign_key(
            "fk_prompt_templates_default_bot_id",
            "prompt_templates",
            "bot_accounts",
            ["default_bot_id"],
            ["bot_id"],
            ondelete="SET NULL",
        )
        op.create_index(
            "ix_prompt_templates_default_bot_id",
            "prompt_templates",
            ["default_bot_id"],
        )


def downgrade() -> None:
    conn = op.get_bind()
    inspector = sa.inspect(conn)
    columns = {c["name"] for c in inspector.get_columns("prompt_templates")}
    indexes = {idx["name"] for idx in inspector.get_indexes("prompt_templates")}
    constraints = {fk["name"] for fk in inspector.get_foreign_keys("prompt_templates")}

    if "default_bot_id" in columns:
        if "ix_prompt_templates_default_bot_id" in indexes:
            op.drop_index("ix_prompt_templates_default_bot_id", table_name="prompt_templates")
        if "fk_prompt_templates_default_bot_id" in constraints:
            op.drop_constraint(
                "fk_prompt_templates_default_bot_id",
                "prompt_templates",
                type_="foreignkey",
            )
        op.drop_column("prompt_templates", "default_bot_id")
    if "tags" in columns:
        op.drop_column("prompt_templates", "tags")
