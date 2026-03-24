"""Add openclaw_session and openclaw_token to bot_accounts.

Revision ID: 006
Revises: 005
Create Date: 2026-03-12
"""
from alembic import op
import sqlalchemy as sa

revision = "006"
down_revision = "005"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("bot_accounts", sa.Column("openclaw_session", sa.String(255), nullable=True))
    op.add_column("bot_accounts", sa.Column("openclaw_token", sa.String(512), nullable=True))


def downgrade() -> None:
    op.drop_column("bot_accounts", "openclaw_token")
    op.drop_column("bot_accounts", "openclaw_session")
