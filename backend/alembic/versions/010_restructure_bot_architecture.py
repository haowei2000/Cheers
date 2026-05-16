"""Restructure Bot architecture: Bot = AIModel + PromptTemplate.

Revision ID: 010
Revises: 009
Create Date: 2026-03-13
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "010"
down_revision: str | None = "009"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # 1. Create the ai_models table.
    op.create_table(
        "ai_models",
        sa.Column("model_id", sa.String(36), nullable=False),
        sa.Column("name", sa.String(64), nullable=False),
        sa.Column("provider", sa.String(32), nullable=False),
        sa.Column("model_name", sa.String(64), nullable=False),
        sa.Column("base_url", sa.String(512), nullable=False),
        sa.Column("api_key", sa.String(512), nullable=True),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("is_enabled", sa.Boolean(), nullable=False, default=True),
        sa.Column("is_builtin", sa.Boolean(), nullable=False, default=False),
        sa.Column("config", sa.JSON(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("NOW()")),
        sa.PrimaryKeyConstraint("model_id"),
        sa.UniqueConstraint("name"),
    )

    # 2. Create the prompt_templates table.
    op.create_table(
        "prompt_templates",
        sa.Column("template_id", sa.String(36), nullable=False),
        sa.Column("name", sa.String(64), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("system_prompt", sa.Text(), nullable=False),
        sa.Column("user_template", sa.Text(), nullable=False, default="{{message}}"),
        sa.Column("variables", sa.JSON(), nullable=True),
        sa.Column("is_builtin", sa.Boolean(), nullable=False, default=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("NOW()")),
        sa.PrimaryKeyConstraint("template_id"),
        sa.UniqueConstraint("name"),
    )

    # 3. Preserve existing bot_accounts data.
    # SQLite does not support ALTER TABLE DROP COLUMN, so the table is rebuilt.
    
    # Create the replacement bot_accounts table.
    op.create_table(
        "bot_accounts_new",
        sa.Column("bot_id", sa.String(36), nullable=False),
        sa.Column("username", sa.String(64), nullable=False),
        sa.Column("display_name", sa.String(255), nullable=True),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("avatar_url", sa.String(512), nullable=True),
        sa.Column("model_id", sa.String(36), sa.ForeignKey("ai_models.model_id"), nullable=False),
        sa.Column("template_id", sa.String(36), sa.ForeignKey("prompt_templates.template_id"), nullable=False),
        sa.Column("custom_system_prompt", sa.Text(), nullable=True),
        sa.Column("status", sa.String(32), nullable=False, server_default="online"),
        sa.Column("intro", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("NOW()")),
        sa.PrimaryKeyConstraint("bot_id"),
        sa.UniqueConstraint("username"),
    )

    # 4. Drop the old table.
    op.drop_table("bot_accounts")

    # 5. Rename the replacement table.
    op.rename_table("bot_accounts_new", "bot_accounts")


def downgrade() -> None:
    # Roll back to the previous bot_accounts schema.
    op.create_table(
        "bot_accounts_old",
        sa.Column("bot_id", sa.String(36), nullable=False),
        sa.Column("username", sa.String(64), nullable=False),
        sa.Column("display_name", sa.String(255), nullable=True),
        sa.Column("specialty_label", sa.String(255), nullable=True),
        sa.Column("soul_config_path", sa.String(512), nullable=True),
        sa.Column("openclaw_endpoint", sa.String(512), nullable=False),
        sa.Column("status", sa.String(32), nullable=False, server_default="offline"),
        sa.Column("avatar_url", sa.String(512), nullable=True),
        sa.Column("openclaw_session", sa.String(255), nullable=True),
        sa.Column("openclaw_token", sa.String(512), nullable=True),
        sa.Column("intro", sa.Text(), nullable=True),
        sa.Column("prompt_template", sa.Text(), nullable=True),
        sa.Column("system_prompt", sa.Text(), nullable=True),
        sa.Column("model_provider", sa.String(32), nullable=True),
        sa.Column("model_name", sa.String(64), nullable=True),
        sa.Column("model_api_key", sa.String(512), nullable=True),
        sa.Column("model_base_url", sa.String(512), nullable=True),
        sa.Column("model_temperature", sa.Float(), nullable=True),
        sa.Column("model_max_tokens", sa.Integer(), nullable=True),
        sa.Column("model_extra_config", sa.JSON(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("NOW()")),
        sa.PrimaryKeyConstraint("bot_id"),
        sa.UniqueConstraint("username"),
    )

    op.drop_table("bot_accounts")
    op.rename_table("bot_accounts_old", "bot_accounts")
    op.drop_table("prompt_templates")
    op.drop_table("ai_models")
