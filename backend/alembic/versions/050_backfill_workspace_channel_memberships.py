"""backfill workspace channel memberships

Revision ID: 050
Revises: 049
Create Date: 2026-05-14
"""
from __future__ import annotations

from alembic import op

revision = "050"
down_revision = "049"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    dialect = bind.dialect.name
    role_expr = "CASE WHEN wm.role IN ('owner', 'admin') THEN 'admin' ELSE 'member' END"

    if dialect == "postgresql":
        op.execute(
            f"""
            INSERT INTO channel_memberships
                (channel_id, member_id, member_type, role, joined_at, added_by)
            SELECT
                c.channel_id,
                wm.user_id,
                'user',
                {role_expr},
                NOW(),
                NULL
            FROM channels c
            JOIN workspace_memberships wm ON wm.workspace_id = c.workspace_id
            WHERE c.type IN ('public', 'workspace')
            ON CONFLICT (channel_id, member_id) DO NOTHING
            """
        )
        return

    if dialect == "sqlite":
        op.execute(
            f"""
            INSERT OR IGNORE INTO channel_memberships
                (channel_id, member_id, member_type, role, joined_at, added_by)
            SELECT
                c.channel_id,
                wm.user_id,
                'user',
                {role_expr},
                CURRENT_TIMESTAMP,
                NULL
            FROM channels c
            JOIN workspace_memberships wm ON wm.workspace_id = c.workspace_id
            WHERE c.type IN ('public', 'workspace')
            """
        )
        return

    op.execute(
        f"""
        INSERT INTO channel_memberships
            (channel_id, member_id, member_type, role, joined_at, added_by)
        SELECT
            c.channel_id,
            wm.user_id,
            'user',
            {role_expr},
            CURRENT_TIMESTAMP,
            NULL
        FROM channels c
        JOIN workspace_memberships wm ON wm.workspace_id = c.workspace_id
        WHERE c.type IN ('public', 'workspace')
          AND NOT EXISTS (
              SELECT 1
              FROM channel_memberships cm
              WHERE cm.channel_id = c.channel_id
                AND cm.member_id = wm.user_id
          )
        """
    )


def downgrade() -> None:
    # Data backfill only; do not remove channel memberships on downgrade.
    pass
