"""add auth external identities

Revision ID: 057
Revises: 056
Create Date: 2026-05-21
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "057"
down_revision = "056"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "auth_external_identities",
        sa.Column("identity_id", sa.String(36), primary_key=True),
        sa.Column("provider", sa.String(32), nullable=False),
        sa.Column("subject", sa.String(255), nullable=False),
        sa.Column("user_id", sa.String(36), nullable=False),
        sa.Column("corp_id", sa.String(128), nullable=False),
        sa.Column("union_id", sa.String(128), nullable=True),
        sa.Column("open_id", sa.String(128), nullable=True),
        sa.Column("display_name", sa.String(255), nullable=True),
        sa.Column("avatar_url", sa.String(512), nullable=True),
        sa.Column("mobile", sa.String(64), nullable=True),
        sa.Column("email", sa.String(255), nullable=True),
        sa.Column("profile", sa.JSON(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
        sa.ForeignKeyConstraint(["user_id"], ["users.user_id"]),
        sa.UniqueConstraint(
            "provider",
            "subject",
            name="uq_auth_external_identities_provider_subject",
        ),
    )
    op.create_index(
        "ix_auth_external_identities_user",
        "auth_external_identities",
        ["user_id"],
    )
    op.create_index(
        "ix_auth_external_identities_provider_corp",
        "auth_external_identities",
        ["provider", "corp_id"],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_auth_external_identities_provider_corp",
        table_name="auth_external_identities",
    )
    op.drop_index("ix_auth_external_identities_user", table_name="auth_external_identities")
    op.drop_table("auth_external_identities")
