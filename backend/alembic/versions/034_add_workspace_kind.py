"""add kind column to workspaces

Revision ID: 034
Revises: 033
Create Date: 2026-04-24 17:00:00.000000

Workspace.kind distinguishes the auto-provisioned "personal" workspace
(one per user, home to their DMs) from regular "team" workspaces with
shared channels.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "034"
down_revision: Union[str, Sequence[str], None] = "033"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "workspaces",
        sa.Column(
            "kind",
            sa.String(16),
            nullable=False,
            server_default="team",
        ),
    )


def downgrade() -> None:
    op.drop_column("workspaces", "kind")
