"""add channel membership role

Revision ID: 038
Revises: 037
Create Date: 2026-04-30 00:00:00.000000

Channel settings are managed by channel-level admins. Existing channel
memberships default to member; workspace owners/admins are backfilled as
channel admins for channels in their workspace.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "038"
down_revision: Union[str, Sequence[str], None] = "037"
branch_labels = None
depends_on = None


def upgrade() -> None:
    conn = op.get_bind()
    columns = [c["name"] for c in sa.inspect(conn).get_columns("channel_memberships")]
    if "role" not in columns:
        op.add_column(
            "channel_memberships",
            sa.Column(
                "role",
                sa.String(20),
                nullable=False,
                server_default="member",
            ),
        )
    op.execute(
        """
        UPDATE channel_memberships
        SET role = 'admin'
        WHERE member_type = 'user'
          AND EXISTS (
            SELECT 1
            FROM channels
            JOIN workspace_memberships
              ON workspace_memberships.workspace_id = channels.workspace_id
             AND workspace_memberships.user_id = channel_memberships.member_id
            WHERE channels.channel_id = channel_memberships.channel_id
              AND workspace_memberships.role IN ('owner', 'admin')
          )
        """
    )


def downgrade() -> None:
    op.drop_column("channel_memberships", "role")
