"""Add bio to users and create channel_profiles table.

Revision ID: 013
Revises: 012
Create Date: 2026-03-19
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "013"
down_revision: str | None = "012"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

TS_DEFAULT = sa.text("NOW()")


def upgrade() -> None:
    conn = op.get_bind()

    # 1. Add the bio column to users.
    user_columns = [c["name"] for c in sa.inspect(conn).get_columns("users")]
    if "bio" not in user_columns:
        op.add_column(
            "users",
            sa.Column("bio", sa.Text(), nullable=True),
        )

    # 2. Create the channel_profiles table.
    existing_tables = sa.inspect(conn).get_table_names()
    if "channel_profiles" not in existing_tables:
        op.create_table(
            "channel_profiles",
            sa.Column("channel_id", sa.String(36), sa.ForeignKey("channels.channel_id"), nullable=False),
            sa.Column("user_id", sa.String(36), sa.ForeignKey("users.user_id"), nullable=False),
            sa.Column("nickname", sa.String(255), nullable=True),
            sa.Column("bio", sa.Text(), nullable=True),
            sa.Column("updated_at", sa.DateTime(timezone=True), server_default=TS_DEFAULT),
            sa.PrimaryKeyConstraint("channel_id", "user_id"),
        )
        op.create_index("ix_channel_profiles_user_id", "channel_profiles", ["user_id"])


def downgrade() -> None:
    op.drop_index("ix_channel_profiles_user_id", table_name="channel_profiles")
    op.drop_table("channel_profiles")
    op.drop_column("users", "bio")
