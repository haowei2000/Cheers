"""add channel invite permission switches

Revision ID: 041
Revises: 039
Create Date: 2026-04-30 00:00:00.000000
"""
from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "041"
down_revision: str | Sequence[str] | None = "039"
branch_labels = None
depends_on = None


def upgrade() -> None:
    conn = op.get_bind()
    columns = [c["name"] for c in sa.inspect(conn).get_columns("channels")]
    if "allow_member_invites" not in columns:
        op.add_column(
            "channels",
            sa.Column(
                "allow_member_invites",
                sa.Boolean(),
                nullable=False,
                server_default="1",
            ),
        )
    if "allow_bot_adds" not in columns:
        op.add_column(
            "channels",
            sa.Column(
                "allow_bot_adds",
                sa.Boolean(),
                nullable=False,
                server_default="1",
            ),
        )


def downgrade() -> None:
    conn = op.get_bind()
    columns = [c["name"] for c in sa.inspect(conn).get_columns("channels")]
    if "allow_bot_adds" in columns:
        op.drop_column("channels", "allow_bot_adds")
    if "allow_member_invites" in columns:
        op.drop_column("channels", "allow_member_invites")
