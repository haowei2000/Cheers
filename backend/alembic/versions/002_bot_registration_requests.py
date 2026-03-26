"""Add bot_registration_requests for OpenClaw auto-register (pending admin approval).

Revision ID: 002
Revises: 001
Create Date: 2026-03-07

"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "002"
down_revision: str | None = "001"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

TS_DEFAULT = sa.text("NOW()")


def upgrade() -> None:
    op.create_table(
        "bot_registration_requests",
        sa.Column("request_id", sa.String(36), nullable=False),
        sa.Column("username", sa.String(64), nullable=False),
        sa.Column("display_name", sa.String(255), nullable=True),
        sa.Column("openclaw_endpoint", sa.String(512), nullable=False),
        sa.Column("status", sa.String(32), nullable=False, server_default="pending"),
        sa.Column("requested_at", sa.DateTime(timezone=True), server_default=TS_DEFAULT, nullable=True),
        sa.Column("decided_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_bot_id", sa.String(36), nullable=True),
        sa.PrimaryKeyConstraint("request_id"),
    )


def downgrade() -> None:
    op.drop_table("bot_registration_requests")
